import {
  ACTIVE_RUN_STATUSES,
  asJsonObject,
  isIntegratorStep,
  isMergeReadinessStep,
  isRegressionVerificationOutputKind,
  lockChainRows,
  MAX_MERGE_TAIL_REPAIR_ATTEMPTS,
  MERGE_TAIL_SCHEMA_VERSION,
  MergeRecoveryStatus,
  Prisma,
  readMarkerHistory,
  recoveryContext,
  TaskStatus,
  transitionMergeRecovery,
} from "@anneal/db";

import {
  createMergeTailRepairTask,
  mergeTailRepairAssignee,
  regressionVerdictForRun,
} from "./merge-tail-actions.js";
import type { Refusal } from "./refusal.js";

type DbTx = Prisma.TransactionClient;
type RepairKind = "gate-fix" | "review-fix";

export const MERGE_TAIL_REPAIR_REQUEST_ACTION = "merge-tail-repair-request";

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

const refused = (code: string, message: string): Refusal => ({
  reason: "conflict",
  message,
  detail: { code },
});

const priorRequestResult = async (
  tx: DbTx,
  taskId: string,
  requestId: string,
  markers: Awaited<ReturnType<typeof readMarkerHistory>>,
): Promise<MergeTailRepairRequestResult | null> => {
  const rows = await tx.taskActivity.findMany({
    where: {
      taskId,
      actorType: "operator",
      AND: [
        { metadata: { path: ["action"], equals: MERGE_TAIL_REPAIR_REQUEST_ACTION } },
        { metadata: { path: ["requestId"], equals: requestId } },
      ],
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  for (const row of rows) {
    const metadata = asJsonObject(row.metadata);
    if (metadata?.operatorNote === true
      || metadata?.action !== MERGE_TAIL_REPAIR_REQUEST_ACTION
      || metadata.requestId !== requestId
      || (metadata.repairKind !== "gate-fix" && metadata.repairKind !== "review-fix")
      || typeof metadata.repairTaskId !== "string"
      || typeof metadata.sourceRunId !== "string"
      || typeof metadata.headSha !== "string"
      || typeof metadata.baseHeadSha !== "string") continue;
    const matchingAttempt = markers.some((marker) => marker.kind === "repairAttempt"
      && marker.repairTaskId === metadata.repairTaskId
      && marker.repairKind === metadata.repairKind
      && marker.headSha === metadata.headSha
      && marker.baseHeadSha === metadata.baseHeadSha
      && marker.raw.sourceRunId === metadata.sourceRunId);
    if (!matchingAttempt) continue;
    const repairTask = await tx.task.findUnique({
      where: { id: metadata.repairTaskId },
      select: { id: true },
    });
    if (!repairTask) continue;
    return {
      repairTaskId: metadata.repairTaskId,
      repairKind: metadata.repairKind,
      headSha: metadata.headSha,
      baseHeadSha: metadata.baseHeadSha,
    };
  }
  return null;
};

/**
 * Reopens one stopped recovery verdict into the ordinary merge-tail repair
 * machinery. The route owns the surrounding Serializable transaction; this
 * action owns the chain mutex and every state-dependent read and write.
 */
export const requestMergeTailRepair = async (
  tx: DbTx,
  input: MergeTailRepairRequest,
  dependencies: MergeTailRepairReentryDependencies = defaultDependencies,
): Promise<MergeTailRepairRequestResult | Refusal> => {
  const identity = await tx.task.findUnique({
    where: { id: input.taskId },
    select: { id: true, projectId: true, chainId: true },
  });
  if (!identity) return { reason: "not-found", message: "Task not found" };
  if (!identity.chainId) {
    return refused("merge_tail_repair_not_blocked", "Task is not a blocked merge-tail Regression task");
  }
  await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });

  const markers = await dependencies.readHistory(tx, input.taskId);
  const duplicate = await priorRequestResult(tx, input.taskId, input.requestId, markers);
  if (duplicate) return duplicate;

  const regressionTask = await tx.task.findUnique({
    where: { id: input.taskId },
    select: {
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
    },
  });
  if (!regressionTask || regressionTask.projectId !== identity.projectId
    || regressionTask.chainId !== identity.chainId
    || !isRegressionVerificationOutputKind(regressionTask.templateStep?.outputKind)) {
    return refused("merge_tail_repair_not_blocked", "Task is not a blocked merge-tail Regression task");
  }
  const aggregate = await tx.mergeRecoveryAttempt.findFirst({
    where: { regressionTaskId: input.taskId },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  if (!aggregate) {
    return refused("merge_tail_repair_not_blocked", "No merge-tail recovery is blocked for this Regression task");
  }
  if (aggregate.refusalCode !== null) {
    return refused("merge_tail_repair_refusal_pending", "The blocked recovery has a pending head-adoption refusal");
  }

  if (aggregate.recoveryRunId && markers.some((marker) => (
    marker.kind === "repairAttempt" && marker.raw.sourceRunId === aggregate.recoveryRunId
  ))) {
    return refused("merge_tail_repair_already_open", "A repair is already open for this recovery Run");
  }
  const recovery = recoveryContext(aggregate);
  if (!recovery
    || recovery.regressionTaskId !== input.taskId
    || aggregate.status !== MergeRecoveryStatus.BLOCKED_DOWNSTREAM
    || regressionTask.status !== TaskStatus.REVIEW
    || recovery.readinessTaskId !== aggregate.readinessTaskId
    || recovery.integratorTaskId !== aggregate.integratorTaskId) {
    return refused("merge_tail_repair_not_blocked", "The merge-tail recovery and its tasks are not parked for repair");
  }

  const relatedTasks = await tx.task.findMany({
    where: { id: { in: [input.taskId, recovery.readinessTaskId, recovery.integratorTaskId] } },
    select: {
      id: true,
      projectId: true,
      chainId: true,
      status: true,
      templateStep: {
        select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
      },
    },
  });
  const taskById = new Map(relatedTasks.map((task) => [task.id, task]));
  const readinessTask = taskById.get(recovery.readinessTaskId);
  const integratorTask = taskById.get(recovery.integratorTaskId);
  const relatedIdentityIsValid = relatedTasks.length === 3 && relatedTasks.every((task) => (
    task.projectId === identity.projectId && task.chainId === identity.chainId
  ));
  if (!relatedIdentityIsValid
    || readinessTask?.status !== TaskStatus.REVIEW
    || !isMergeReadinessStep(readinessTask?.templateStep)
    || integratorTask?.status !== TaskStatus.REVIEW
    || !isIntegratorStep(integratorTask?.templateStep)) {
    return refused("merge_tail_repair_not_blocked", "The recovery's Regression, readiness, and integrator tasks must all be in review");
  }
  const activeRuns = await tx.run.count({
    where: {
      taskId: { in: [input.taskId, recovery.readinessTaskId, recovery.integratorTaskId] },
      status: { in: ACTIVE_RUN_STATUSES },
    },
  });
  if (activeRuns > 0) {
    return refused("merge_tail_repair_active_run", "A merge-tail task still has an active Run");
  }
  const sourceRun = await tx.run.findUnique({
    where: { id: recovery.recoveryRunId },
    select: { id: true, taskId: true, branch: true, headSha: true },
  });
  if (!sourceRun || sourceRun.taskId !== input.taskId) {
    return refused("merge_tail_repair_verdict_missing", "The blocked recovery's Regression Run is missing");
  }
  const qualified = await dependencies.qualifyVerdict(tx, {
    task: regressionTask,
    runId: sourceRun.id,
    runHeadSha: sourceRun.headSha,
    allowPersistedHeadWhenUnreported: true,
  });
  if (qualified.status === "refused"
    || (qualified.verdict.outcome !== "review-fail" && qualified.verdict.outcome !== "gate-fail")) {
    return refused("merge_tail_repair_verdict_missing", "The recovery Run does not own a review-fail or gate-fail verdict");
  }
  const verdict = qualified.verdict;
  const repairKind: RepairKind = verdict.outcome === "review-fail" ? "review-fix" : "gate-fix";
  const priorAttempts = markers.filter((marker) => (
    marker.kind === "repairAttempt" && marker.repairKind === repairKind
  )).length;
  if (priorAttempts >= MAX_MERGE_TAIL_REPAIR_ATTEMPTS) {
    return refused("merge_tail_repair_budget_exhausted", `The ${repairKind} repair budget is exhausted`);
  }

  const assignee = await dependencies.resolveAssignee(tx, { ...regressionTask, repairKind });
  // The same rule the automatic tail follows: a chain that never staffed a
  // fixed-implementation step has no agent for this repair, and inventing one
  // would put the work on somebody nobody configured.
  if (assignee.kind === "unstaffed") {
    return refused("merge_tail_repair_unstaffed", `The repair cannot be staffed: ${assignee.reason}`);
  }
  const repair = await dependencies.createRepairTask(tx, {
    regressionTask,
    sourceRun,
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
    // route cannot provoke it — `sourceRun` is the aggregate's own
    // `recoveryRunId`, read under the same lock — so the arm is the invariant
    // assertion that keeps the shared creation path from ever answering an
    // unsettleable repair as merely "creation failed".
    return repair.bindingMismatch
      ? refused("merge_tail_repair_binding_mismatch", `The repair cannot bind: ${repair.refusal}`)
      : refused("merge_tail_repair_creation_failed", `The repair task could not be created: ${repair.refusal}`);
  }
  await transitionMergeRecovery(tx, aggregate.id, MergeRecoveryStatus.REPAIRING, {
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
    body: `Operator requested ${repairKind} reentry for recovery Run ${sourceRun.id}`,
    metadata: {
      schemaVersion: MERGE_TAIL_SCHEMA_VERSION,
      action: MERGE_TAIL_REPAIR_REQUEST_ACTION,
      requestId: input.requestId,
      reason: input.reason ?? null,
      sourceRunId: sourceRun.id,
      repairKind,
      headSha: verdict.headSha,
      baseHeadSha: verdict.baseHeadSha,
      repairTaskId: repair.taskId,
    } as Prisma.InputJsonObject,
  } });
  return result;
};
