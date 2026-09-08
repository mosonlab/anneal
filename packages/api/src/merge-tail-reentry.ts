import {
  ACTIVE_RUN_STATUSES,
  asJsonObject,
  isIntegratorStep,
  isMergeReadinessStep,
  isRegressionVerificationOutputKind,
  lockChainRows,
  MAX_MERGE_TAIL_OPERATOR_RERUNS,
  MAX_MERGE_TAIL_REPAIR_ATTEMPTS,
  MERGE_TAIL_SCHEMA_VERSION,
  type Marker,
  type MergeRecoveryAttempt,
  MergeRecoveryStatus,
  Prisma,
  readMarkerHistory,
  type RecoveryContext,
  recoveryContext,
  type RegressionVerdict,
  TaskStatus,
  transitionMergeRecovery,
} from "@anneal/db";

import {
  createMergeTailRepairTask,
  mergeTailRepairAssignee,
  regressionVerdictForRun,
} from "./merge-tail-actions.js";
import { enterRepair } from "./merge-tail-state.js";
import type { Refusal } from "./refusal.js";

type DbTx = Prisma.TransactionClient;
type RepairKind = "gate-fix" | "review-fix";

export const MERGE_TAIL_REPAIR_REQUEST_ACTION = "merge-tail-repair-request";
export const MERGE_TAIL_RERUN_REQUEST_ACTION = "merge-tail-rerun-request";

const refused = (code: string, message: string): Refusal => ({
  reason: "conflict",
  message,
  detail: { code },
});

/** The reentry verbs a stopped tail can be read for. */
export type ReentryVerb = "repair" | "rerun";

/**
 * Everything a verb needs beyond the read itself: the operator activity action
 * it settles under, and the refusal it names for each rung of the ladder. The
 * rungs are the same facts for every verb; only the operator vocabulary that
 * reports them differs, and this is where that vocabulary lives.
 */
type ReentryVocabulary = {
  action: string;
  notATail: Refusal;
  noRecovery: Refusal;
  refusalPending: Refusal;
  notParked: Refusal;
  tasksNotInReview: Refusal;
  activeRun: Refusal;
  runMissing: Refusal;
  verdictUnreadable: (reason: string) => Refusal;
};

const RERUN_NOT_BLOCKED = refused(
  "merge_tail_rerun_not_blocked",
  "No stopped merge-tail recovery is waiting on this Regression task",
);

const VOCABULARY: Record<ReentryVerb, ReentryVocabulary> = {
  repair: {
    action: MERGE_TAIL_REPAIR_REQUEST_ACTION,
    notATail: refused("merge_tail_repair_not_blocked", "Task is not a blocked merge-tail Regression task"),
    noRecovery: refused("merge_tail_repair_not_blocked", "No merge-tail recovery is blocked for this Regression task"),
    refusalPending: refused("merge_tail_repair_refusal_pending", "The blocked recovery has a pending head-adoption refusal"),
    notParked: refused("merge_tail_repair_not_blocked", "The merge-tail recovery and its tasks are not parked for repair"),
    tasksNotInReview: refused("merge_tail_repair_not_blocked", "The recovery's Regression, readiness, and integrator tasks must all be in review"),
    activeRun: refused("merge_tail_repair_active_run", "A merge-tail task still has an active Run"),
    runMissing: refused("merge_tail_repair_verdict_missing", "The blocked recovery's Regression Run is missing"),
    verdictUnreadable: () => refused(
      "merge_tail_repair_verdict_missing",
      "The recovery Run does not own a review-fail or gate-fail verdict",
    ),
  },
  rerun: {
    action: MERGE_TAIL_RERUN_REQUEST_ACTION,
    notATail: refused("merge_tail_rerun_not_blocked", "Task is not a stopped merge-tail Regression task"),
    noRecovery: RERUN_NOT_BLOCKED,
    refusalPending: RERUN_NOT_BLOCKED,
    notParked: RERUN_NOT_BLOCKED,
    tasksNotInReview: refused("merge_tail_rerun_not_blocked", "The recovery's Regression, readiness, and integrator tasks must all be in review"),
    activeRun: refused("merge_tail_rerun_active_run", "A merge-tail task still has an active Run"),
    runMissing: refused(
      "merge_tail_rerun_verdict_not_gate_fail",
      "The stopped recovery's Regression Run is missing, so it owns no gate-fail verdict",
    ),
    verdictUnreadable: (reason) => refused(
      "merge_tail_rerun_verdict_not_gate_fail",
      `The recovery Run owns no readable verdict: ${reason}`,
    ),
  },
};

const REGRESSION_TASK_SELECT = {
  id: true,
  projectId: true,
  repoId: true,
  templateId: true,
  chainId: true,
  chainIndex: true,
  targetBranch: true,
  status: true,
  templateStep: {
    select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
  },
} as const satisfies Prisma.TaskSelect;

const TAIL_TASK_SELECT = {
  id: true,
  projectId: true,
  chainId: true,
  status: true,
  templateStep: {
    select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
  },
} as const satisfies Prisma.TaskSelect;

export type RegressionTailTask = Prisma.TaskGetPayload<{ select: typeof REGRESSION_TASK_SELECT }>;

/** The Chain a reentry verb holds the mutex on while it reads and writes. */
export type TailChain = { taskId: string; projectId: string; chainId: string };

/**
 * A Regression Task whose base-drift recovery is parked and waiting for an
 * operator, with every fact a settlement writes through.
 */
export type StoppedTail = {
  aggregate: MergeRecoveryAttempt;
  recovery: RecoveryContext;
  regressionTask: RegressionTailTask;
  sourceRun: { id: string; taskId: string | null; branch: string | null; headSha: string | null };
  verdict: RegressionVerdict;
};

/**
 * Take the Chain mutex the rest of the reentry read and its settlement run
 * under. A Task with no Chain is refused here because there is nothing to lock.
 */
export const lockTailChain = async (
  tx: DbTx,
  input: { taskId: string; verb: ReentryVerb },
): Promise<TailChain | Refusal> => {
  const identity = await tx.task.findUnique({
    where: { id: input.taskId },
    select: { id: true, projectId: true, chainId: true },
  });
  if (!identity) return { reason: "not-found", message: "Task not found" };
  if (!identity.chainId) return VOCABULARY[input.verb].notATail;
  const chain = { taskId: identity.id, projectId: identity.projectId, chainId: identity.chainId };
  await lockChainRows(tx, { projectId: chain.projectId, chainId: chain.chainId });
  return chain;
};

/**
 * The one "this tail is stopped and waiting for an operator" read. Every rung
 * below is a fact about the recovery, not about a verb: the latest recovery
 * attempt is blocked with no pending head-adoption refusal, its recovery
 * context is complete, its Regression, readiness and integrator Tasks are the
 * canonical three Steps of this Chain and all in review, none of them has an
 * active Run, and the recovery's own Regression Run owns a readable verdict.
 * A settlement adds only the rungs its own verb owns, starting with which
 * verdict outcomes it accepts.
 */
export const readStoppedTail = async (
  tx: DbTx,
  input: { chain: TailChain; verb: ReentryVerb },
  qualifyVerdict: typeof regressionVerdictForRun = regressionVerdictForRun,
): Promise<StoppedTail | Refusal> => {
  const words = VOCABULARY[input.verb];
  const { taskId } = input.chain;
  const regressionTask = await tx.task.findUnique({ where: { id: taskId }, select: REGRESSION_TASK_SELECT });
  if (!regressionTask
    || regressionTask.projectId !== input.chain.projectId
    || regressionTask.chainId !== input.chain.chainId
    || !isRegressionVerificationOutputKind(regressionTask.templateStep?.outputKind)) return words.notATail;

  const aggregate = await tx.mergeRecoveryAttempt.findFirst({
    where: { regressionTaskId: taskId },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  if (!aggregate) return words.noRecovery;
  if (aggregate.refusalCode !== null) return words.refusalPending;

  const recovery = recoveryContext(aggregate);
  if (!recovery
    || aggregate.status !== MergeRecoveryStatus.BLOCKED_DOWNSTREAM
    || recovery.regressionTaskId !== taskId
    || regressionTask.status !== TaskStatus.REVIEW) return words.notParked;

  const boundTaskIds = [taskId, recovery.readinessTaskId, recovery.integratorTaskId];
  const relatedTasks = await tx.task.findMany({
    where: { id: { in: boundTaskIds } },
    select: TAIL_TASK_SELECT,
  });
  const taskById = new Map(relatedTasks.map((task) => [task.id, task]));
  const readinessTask = taskById.get(recovery.readinessTaskId);
  const integratorTask = taskById.get(recovery.integratorTaskId);
  const relatedIdentityIsValid = relatedTasks.length === 3 && relatedTasks.every((task) => (
    task.projectId === input.chain.projectId && task.chainId === input.chain.chainId
  ));
  if (!relatedIdentityIsValid
    || readinessTask?.status !== TaskStatus.REVIEW
    || !isMergeReadinessStep(readinessTask?.templateStep)
    || integratorTask?.status !== TaskStatus.REVIEW
    || !isIntegratorStep(integratorTask?.templateStep)) return words.tasksNotInReview;

  const activeRuns = await tx.run.count({
    where: { taskId: { in: boundTaskIds }, status: { in: ACTIVE_RUN_STATUSES } },
  });
  if (activeRuns > 0) return words.activeRun;

  const sourceRun = await tx.run.findUnique({
    where: { id: recovery.recoveryRunId },
    select: { id: true, taskId: true, branch: true, headSha: true },
  });
  if (!sourceRun || sourceRun.taskId !== taskId) return words.runMissing;

  const qualified = await qualifyVerdict(tx, {
    task: regressionTask,
    runId: sourceRun.id,
    runHeadSha: sourceRun.headSha,
    allowPersistedHeadWhenUnreported: true,
  });
  if (qualified.status === "refused") return words.verdictUnreadable(qualified.reason);
  return { aggregate, recovery, regressionTask, sourceRun, verdict: qualified.verdict };
};

/**
 * The metadata fields a replay must carry, and the shape each must have: a
 * `typeof` family, or the literal set a field is drawn from.
 */
type FieldSpec = "string" | "number" | readonly string[];

type FieldValue<S extends FieldSpec> = S extends "string" ? string
  : S extends "number" ? number
    : S extends readonly (infer Literal)[] ? Literal
      : never;

type IdentityFields<Spec extends Record<string, FieldSpec>> = { [Field in keyof Spec]: FieldValue<Spec[Field]> };

const matchesSpec = (value: unknown, spec: FieldSpec): boolean => {
  if (spec === "string") return typeof value === "string";
  if (spec === "number") return typeof value === "number";
  return typeof value === "string" && spec.includes(value);
};

/**
 * The prior settlement of this operator request, or `null` when there is none.
 *
 * The caller declares the identity fields its own verb records; only a row that
 * carries all of them in the declared shape can answer a replay, and `settle`
 * then confirms that the row still names a live platform fact and turns it back
 * into the verb's result. An operator note that happens to carry this shape is
 * skipped: it names nothing the platform wrote.
 */
export const priorOperatorRequest = async <Spec extends Record<string, FieldSpec>, Result>(
  tx: DbTx,
  query: {
    taskId: string;
    action: string;
    requestId: string;
    identity: Spec;
    settle: (fields: IdentityFields<Spec>) => Promise<Result | null>;
  },
): Promise<Result | null> => {
  const rows = await tx.taskActivity.findMany({
    where: {
      taskId: query.taskId,
      actorType: "operator",
      AND: [
        { metadata: { path: ["action"], equals: query.action } },
        { metadata: { path: ["requestId"], equals: query.requestId } },
      ],
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  for (const row of rows) {
    const metadata = asJsonObject(row.metadata);
    if (!metadata
      || metadata.operatorNote === true
      || metadata.action !== query.action
      || metadata.requestId !== query.requestId) continue;
    const shapeIsValid = Object.entries(query.identity)
      .every(([field, spec]) => matchesSpec(metadata[field], spec));
    if (!shapeIsValid) continue;
    const settled = await query.settle(metadata as unknown as IdentityFields<Spec>);
    if (settled) return settled;
  }
  return null;
};

const REPAIR_KINDS = ["gate-fix", "review-fix"] as const;

export type MergeTailRepairRequest = {
  taskId: string;
  requestId: string;
  reason?: string;
  now: Date;
};

export type MergeTailRepairRequestResult = {
  repairTaskId: string;
  repairKind: RepairKind;
  headSha: string;
  baseHeadSha: string;
};

export type MergeTailRepairReentryDependencies = {
  readHistory: typeof readMarkerHistory;
  qualifyVerdict: typeof regressionVerdictForRun;
  resolveAssignee: typeof mergeTailRepairAssignee;
  createRepairTask: typeof createMergeTailRepairTask;
};

const defaultDependencies: MergeTailRepairReentryDependencies = {
  readHistory: readMarkerHistory,
  qualifyVerdict: regressionVerdictForRun,
  resolveAssignee: mergeTailRepairAssignee,
  createRepairTask: createMergeTailRepairTask,
};

const priorRepairRequest = async (
  tx: DbTx,
  input: { taskId: string; requestId: string; markers: readonly Marker[] },
): Promise<MergeTailRepairRequestResult | null> => priorOperatorRequest(tx, {
  taskId: input.taskId,
  action: MERGE_TAIL_REPAIR_REQUEST_ACTION,
  requestId: input.requestId,
  identity: {
    repairTaskId: "string",
    sourceRunId: "string",
    headSha: "string",
    baseHeadSha: "string",
    repairKind: REPAIR_KINDS,
  },
  settle: async (fields) => {
    // The repair-attempt marker is what makes a replay answerable: it is the
    // platform's own record that this request opened that repair task.
    const matchingAttempt = input.markers.some((marker) => marker.kind === "repairAttempt"
      && marker.repairTaskId === fields.repairTaskId
      && marker.repairKind === fields.repairKind
      && marker.headSha === fields.headSha
      && marker.baseHeadSha === fields.baseHeadSha
      && marker.raw.sourceRunId === fields.sourceRunId);
    if (!matchingAttempt) return null;
    const repairTask = await tx.task.findUnique({
      where: { id: fields.repairTaskId },
      select: { id: true },
    });
    if (!repairTask) return null;
    return {
      repairTaskId: fields.repairTaskId,
      repairKind: fields.repairKind,
      headSha: fields.headSha,
      baseHeadSha: fields.baseHeadSha,
    };
  },
});

/**
 * Reopens one stopped recovery verdict into the ordinary merge-tail repair
 * machinery. The route owns the surrounding Serializable transaction; this
 * settlement owns the chain mutex and every state-dependent read and write.
 */
export const requestMergeTailRepair = async (
  tx: DbTx,
  input: MergeTailRepairRequest,
  dependencies: MergeTailRepairReentryDependencies = defaultDependencies,
): Promise<MergeTailRepairRequestResult | Refusal> => {
  const chain = await lockTailChain(tx, { taskId: input.taskId, verb: "repair" });
  if ("message" in chain) return chain;

  const markers = await dependencies.readHistory(tx, input.taskId);
  const duplicate = await priorRepairRequest(tx, { taskId: input.taskId, requestId: input.requestId, markers });
  if (duplicate) return duplicate;

  const tail = await readStoppedTail(tx, { chain, verb: "repair" }, dependencies.qualifyVerdict);
  if ("message" in tail) return tail;

  if (tail.aggregate.recoveryRunId && markers.some((marker) => (
    marker.kind === "repairAttempt" && marker.raw.sourceRunId === tail.aggregate.recoveryRunId
  ))) {
    return refused("merge_tail_repair_already_open", "A repair is already open for this recovery Run");
  }
  const verdict = tail.verdict;
  if (verdict.outcome !== "review-fail" && verdict.outcome !== "gate-fail") {
    return refused("merge_tail_repair_verdict_missing", "The recovery Run does not own a review-fail or gate-fail verdict");
  }
  const repairKind: RepairKind = verdict.outcome === "review-fail" ? "review-fix" : "gate-fix";
  const priorAttempts = markers.filter((marker) => (
    marker.kind === "repairAttempt" && marker.repairKind === repairKind
  )).length;
  if (priorAttempts >= MAX_MERGE_TAIL_REPAIR_ATTEMPTS) {
    return refused("merge_tail_repair_budget_exhausted", `The ${repairKind} repair budget is exhausted`);
  }

  const assignee = await dependencies.resolveAssignee(tx, { ...tail.regressionTask, repairKind });
  // The same rule the automatic tail follows: a chain that never staffed a
  // fixed-implementation step has no agent for this repair, and inventing one
  // would put the work on somebody nobody configured.
  if (assignee.kind === "unstaffed") {
    return refused("merge_tail_repair_unstaffed", `The repair cannot be staffed: ${assignee.reason}`);
  }
  const repair = await dependencies.createRepairTask(tx, {
    regressionTask: tail.regressionTask,
    sourceRun: tail.sourceRun,
    assignee,
    repairKind,
    headSha: verdict.headSha,
    baseHeadSha: verdict.baseHeadSha,
    summary: verdict.summary,
    ...(verdict.outcome === "gate-fail"
      && "gateFailureExcerpt" in verdict
      && typeof verdict.gateFailureExcerpt === "string"
      ? { gateFailureExcerpt: verdict.gateFailureExcerpt }
      : {}),
    now: input.now,
  });
  if ("refusal" in repair) {
    // The binding refusal is its own answer: nothing about the repair card is
    // unstaffed or unresolvable, the recovery simply names another Run. This
    // route cannot provoke it -- `sourceRun` is the aggregate's own
    // `recoveryRunId`, read under the same lock -- so the arm is the invariant
    // assertion that keeps the shared creation path from ever answering an
    // unsettleable repair as merely "creation failed".
    return repair.bindingMismatch
      ? refused("merge_tail_repair_binding_mismatch", `The repair cannot bind: ${repair.refusal}`)
      : refused("merge_tail_repair_creation_failed", `The repair task could not be created: ${repair.refusal}`);
  }
  await transitionMergeRecovery(tx, tail.aggregate.id, MergeRecoveryStatus.REPAIRING, {
    failureReason: null,
    endedAt: null,
  });
  const result: MergeTailRepairRequestResult = {
    repairTaskId: repair.taskId,
    repairKind,
    headSha: verdict.headSha,
    baseHeadSha: verdict.baseHeadSha,
  };
  await tx.taskActivity.create({ data: {
    taskId: input.taskId,
    actorType: "operator",
    body: `Operator requested ${repairKind} reentry for recovery Run ${tail.sourceRun.id}`,
    metadata: {
      schemaVersion: MERGE_TAIL_SCHEMA_VERSION,
      action: MERGE_TAIL_REPAIR_REQUEST_ACTION,
      requestId: input.requestId,
      reason: input.reason ?? null,
      sourceRunId: tail.sourceRun.id,
      repairKind,
      headSha: verdict.headSha,
      baseHeadSha: verdict.baseHeadSha,
      repairTaskId: repair.taskId,
    } as Prisma.InputJsonObject,
  } });
  return result;
};

export type MergeTailRerunRequest = {
  taskId: string;
  requestId: string;
  reason?: string;
  now: Date;
};

export type MergeTailRerunResult = {
  aggregateId: string;
  attempt: number;
  recoveryRunId: string;
  headSha: string;
  baseHeadSha: string;
};

const priorRerunRequest = async (
  tx: DbTx,
  input: { taskId: string; requestId: string },
): Promise<MergeTailRerunResult | null> => priorOperatorRequest(tx, {
  taskId: input.taskId,
  action: MERGE_TAIL_RERUN_REQUEST_ACTION,
  requestId: input.requestId,
  identity: {
    aggregateId: "string",
    attempt: "number",
    recoveryRunId: "string",
    headSha: "string",
    baseHeadSha: "string",
  },
  settle: async (fields) => {
    // The recovery attempt row is what makes a replay answerable, and only its
    // immutable identity may answer one. `recoveryRunId` is not immutable: a
    // readiness requeue and a completed repair both rewrite it on this same
    // row, and matching on it would let the original `requestId` open a second
    // rerun once the recovery has moved on. It is replayed, never matched.
    const aggregate = await tx.mergeRecoveryAttempt.findUnique({
      where: { id: fields.aggregateId },
      select: { id: true, attempt: true, regressionTaskId: true },
    });
    if (!aggregate
      || aggregate.regressionTaskId !== input.taskId
      || aggregate.attempt !== fields.attempt) return null;
    return {
      aggregateId: aggregate.id,
      attempt: aggregate.attempt,
      recoveryRunId: fields.recoveryRunId,
      headSha: fields.headSha,
      baseHeadSha: fields.baseHeadSha,
    };
  },
});

/**
 * Re-runs a base-drift recovery that stopped on a merge gate FAIL the branch
 * did not cause. It opens attempt N+1 of the same recovery against the same
 * authorized head and current base and queues the Regression Run through
 * `enterRepair`, so the lease, the readiness re-validation and merge execution
 * keep their single path. No repair task is created and no repair budget is
 * charged: nothing here claims the branch needs fixing. The route owns the
 * surrounding Serializable transaction; this settlement owns the chain mutex
 * and every state-dependent read and write.
 */
export const requestMergeTailRerun = async (
  tx: DbTx,
  input: MergeTailRerunRequest,
): Promise<MergeTailRerunResult | Refusal> => {
  const chain = await lockTailChain(tx, { taskId: input.taskId, verb: "rerun" });
  if ("message" in chain) return chain;

  const duplicate = await priorRerunRequest(tx, { taskId: input.taskId, requestId: input.requestId });
  if (duplicate) return duplicate;

  const tail = await readStoppedTail(tx, { chain, verb: "rerun" });
  if ("message" in tail) return tail;

  const { recovery, verdict } = tail;
  if (verdict.outcome !== "gate-fail") {
    // Only a gate FAIL can be a host failure rather than a branch failure. A
    // semantic FAIL and a refresh conflict are the branch's own results and
    // keep their existing exits.
    return refused(
      "merge_tail_rerun_verdict_not_gate_fail",
      `The recovery Run's verdict is ${verdict.outcome}, not gate-fail`,
    );
  }

  // Automatic validation opens exactly one attempt row per source stop, so
  // every further row for that stop is an operator rerun and the rows are the
  // budget. They survive the activity window, which a marker scan would not.
  const attemptsForStop = await tx.mergeRecoveryAttempt.count({
    where: { integratorTaskId: recovery.integratorTaskId, sourceStopId: recovery.sourceStopId },
  });
  if (attemptsForStop - 1 >= MAX_MERGE_TAIL_OPERATOR_RERUNS) {
    return refused(
      "merge_tail_rerun_budget_exhausted",
      `The operator rerun budget for stop ${recovery.sourceStopId} is exhausted`,
    );
  }

  const highestAttempt = await tx.mergeRecoveryAttempt.aggregate({
    where: { integratorTaskId: recovery.integratorTaskId },
    _max: { attempt: true },
  });
  const reran = await tx.mergeRecoveryAttempt.create({ data: {
    integratorTaskId: recovery.integratorTaskId,
    sourceStopId: recovery.sourceStopId,
    attempt: (highestAttempt._max.attempt ?? recovery.attempt) + 1,
    status: MergeRecoveryStatus.VALIDATING,
    boundSourceRunId: recovery.sourceRunId,
    authorizationActivityId: recovery.authorizationActivityId,
    readinessTaskId: recovery.readinessTaskId,
    regressionTaskId: recovery.regressionTaskId,
    repository: recovery.repository,
    prNumber: recovery.prNumber,
    targetBranch: recovery.targetBranch,
    authorizedHeadSha: recovery.authorizedHeadSha,
    authorizedBaseSha: recovery.authorizedBaseSha,
    observedBaseSha: recovery.observedBaseSha,
    currentBaseSha: recovery.currentBaseSha,
  } });
  const queued = await enterRepair(tx, {
    aggregateId: reran.id,
    currentBaseSha: recovery.currentBaseSha,
    now: input.now,
    // The gate FAIL this rerun answers is the host's, so the re-verification is
    // platform compensation rather than another agent attempt on the branch.
    budgetGrant: 1,
  });
  if (!queued) {
    // `enterRepair` only answers null on the readiness-requeue path, which this
    // route never takes. A null here means the recovery machinery changed shape
    // under a caller that has already created an attempt row.
    throw new Error(`Merge-tail rerun ${reran.id} queued no Regression Run`);
  }
  const result: MergeTailRerunResult = {
    aggregateId: reran.id,
    attempt: reran.attempt,
    recoveryRunId: queued.recoveryRunId,
    headSha: verdict.headSha,
    baseHeadSha: verdict.baseHeadSha,
  };
  await tx.taskActivity.create({ data: {
    taskId: input.taskId,
    actorType: "operator",
    body: `Operator re-ran recovery attempt ${String(reran.attempt)} after the gate FAIL of Run ${tail.sourceRun.id}`,
    metadata: {
      schemaVersion: MERGE_TAIL_SCHEMA_VERSION,
      action: MERGE_TAIL_RERUN_REQUEST_ACTION,
      requestId: input.requestId,
      reason: input.reason ?? null,
      sourceStopId: recovery.sourceStopId,
      priorAggregateId: recovery.aggregateId,
      priorRecoveryRunId: recovery.recoveryRunId,
      aggregateId: result.aggregateId,
      attempt: result.attempt,
      recoveryRunId: result.recoveryRunId,
      headSha: result.headSha,
      baseHeadSha: result.baseHeadSha,
    } as Prisma.InputJsonObject,
  } });
  return result;
};
