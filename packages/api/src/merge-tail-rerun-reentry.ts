import {
  ACTIVE_RUN_STATUSES,
  asJsonObject,
  isIntegratorStep,
  isMergeReadinessStep,
  isRegressionVerificationOutputKind,
  lockChainRows,
  MAX_MERGE_TAIL_OPERATOR_RERUNS,
  MERGE_TAIL_SCHEMA_VERSION,
  MergeRecoveryStatus,
  Prisma,
  recoveryContext,
  TaskStatus,
} from "@anneal/db";

import { regressionVerdictForRun } from "./merge-tail-actions.js";
import { enterRepair } from "./merge-tail-state.js";
import type { Refusal } from "./refusal.js";

type DbTx = Prisma.TransactionClient;

export const MERGE_TAIL_RERUN_REQUEST_ACTION = "merge-tail-rerun-request";

const NOT_BLOCKED = "merge_tail_rerun_not_blocked";
const VERDICT_NOT_GATE_FAIL = "merge_tail_rerun_verdict_not_gate_fail";
const ACTIVE_RUN = "merge_tail_rerun_active_run";
const BUDGET_EXHAUSTED = "merge_tail_rerun_budget_exhausted";

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

const refused = (code: string, message: string): Refusal => ({
  reason: "conflict",
  message,
  detail: { code },
});

const priorRequestResult = async (
  tx: DbTx,
  taskId: string,
  requestId: string,
): Promise<MergeTailRerunResult | null> => {
  const rows = await tx.taskActivity.findMany({
    where: {
      taskId,
      actorType: "operator",
      AND: [
        { metadata: { path: ["action"], equals: MERGE_TAIL_RERUN_REQUEST_ACTION } },
        { metadata: { path: ["requestId"], equals: requestId } },
      ],
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  for (const row of rows) {
    const metadata = asJsonObject(row.metadata);
    if (metadata?.operatorNote === true
      || metadata?.action !== MERGE_TAIL_RERUN_REQUEST_ACTION
      || metadata.requestId !== requestId
      || typeof metadata.aggregateId !== "string"
      || typeof metadata.attempt !== "number"
      || typeof metadata.recoveryRunId !== "string"
      || typeof metadata.headSha !== "string"
      || typeof metadata.baseHeadSha !== "string") continue;
    // The recovery attempt row is what makes a replay answerable: an operator
    // note that happens to carry this shape names no attempt bound to this
    // Regression task and its recovery Run, so it is skipped rather than
    // answered.
    const aggregate = await tx.mergeRecoveryAttempt.findUnique({
      where: { id: metadata.aggregateId },
      select: { id: true, attempt: true, recoveryRunId: true, regressionTaskId: true },
    });
    if (!aggregate
      || aggregate.regressionTaskId !== taskId
      || aggregate.attempt !== metadata.attempt
      || aggregate.recoveryRunId !== metadata.recoveryRunId) continue;
    return {
      aggregateId: aggregate.id,
      attempt: aggregate.attempt,
      recoveryRunId: metadata.recoveryRunId,
      headSha: metadata.headSha,
      baseHeadSha: metadata.baseHeadSha,
    };
  }
  return null;
};

/**
 * Re-runs a base-drift recovery that stopped on a merge gate FAIL the branch
 * did not cause. It opens attempt N+1 of the same recovery against the same
 * authorized head and current base and queues the Regression Run through
 * `enterRepair`, so the lease, the readiness re-validation and merge execution
 * keep their single path. No repair task is created and no repair budget is
 * charged: nothing here claims the branch needs fixing. The route owns the
 * surrounding Serializable transaction; this action owns the chain mutex and
 * every state-dependent read and write.
 */
export const requestMergeTailRerun = async (
  tx: DbTx,
  input: MergeTailRerunRequest,
): Promise<MergeTailRerunResult | Refusal> => {
  const identity = await tx.task.findUnique({
    where: { id: input.taskId },
    select: { id: true, projectId: true, chainId: true },
  });
  if (!identity) return { reason: "not-found", message: "Task not found" };
  if (!identity.chainId) {
    return refused(NOT_BLOCKED, "Task is not a stopped merge-tail Regression task");
  }
  await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });

  const duplicate = await priorRequestResult(tx, input.taskId, input.requestId);
  if (duplicate) return duplicate;

  const regressionTask = await tx.task.findUnique({
    where: { id: input.taskId },
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
  if (!regressionTask
    || regressionTask.projectId !== identity.projectId
    || regressionTask.chainId !== identity.chainId
    || !isRegressionVerificationOutputKind(regressionTask.templateStep?.outputKind)) {
    return refused(NOT_BLOCKED, "Task is not a stopped merge-tail Regression task");
  }
  const aggregate = await tx.mergeRecoveryAttempt.findFirst({
    where: { regressionTaskId: input.taskId },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  const recovery = aggregate ? recoveryContext(aggregate) : null;
  if (!aggregate || !recovery
    || aggregate.status !== MergeRecoveryStatus.BLOCKED_DOWNSTREAM
    || aggregate.refusalCode !== null
    || recovery.regressionTaskId !== input.taskId
    || regressionTask.status !== TaskStatus.REVIEW) {
    return refused(NOT_BLOCKED, "No stopped merge-tail recovery is waiting on this Regression task");
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
    return refused(NOT_BLOCKED, "The recovery's Regression, readiness, and integrator tasks must all be in review");
  }
  const activeRuns = await tx.run.count({
    where: {
      taskId: { in: [input.taskId, recovery.readinessTaskId, recovery.integratorTaskId] },
      status: { in: ACTIVE_RUN_STATUSES },
    },
  });
  if (activeRuns > 0) {
    return refused(ACTIVE_RUN, "A merge-tail task still has an active Run");
  }
  const sourceRun = await tx.run.findUnique({
    where: { id: recovery.recoveryRunId },
    select: { id: true, taskId: true, headSha: true },
  });
  if (!sourceRun || sourceRun.taskId !== input.taskId) {
    return refused(VERDICT_NOT_GATE_FAIL, "The stopped recovery's Regression Run is missing, so it owns no gate-fail verdict");
  }
  const qualified = await regressionVerdictForRun(tx, {
    task: regressionTask,
    runId: sourceRun.id,
    runHeadSha: sourceRun.headSha,
    allowPersistedHeadWhenUnreported: true,
  });
  if (qualified.status === "refused") {
    return refused(VERDICT_NOT_GATE_FAIL, `The recovery Run owns no readable verdict: ${qualified.reason}`);
  }
  if (qualified.verdict.outcome !== "gate-fail") {
    // Only a gate FAIL can be a host failure rather than a branch failure. A
    // semantic FAIL and a refresh conflict are the branch's own results and
    // keep their existing exits.
    return refused(
      VERDICT_NOT_GATE_FAIL,
      `The recovery Run's verdict is ${qualified.verdict.outcome}, not gate-fail`,
    );
  }
  const verdict = qualified.verdict;

  // Automatic validation opens exactly one attempt row per source stop, so
  // every further row for that stop is an operator rerun and the rows are the
  // budget. They survive the activity window, which a marker scan would not.
  const attemptsForStop = await tx.mergeRecoveryAttempt.count({
    where: { integratorTaskId: recovery.integratorTaskId, sourceStopId: recovery.sourceStopId },
  });
  if (attemptsForStop - 1 >= MAX_MERGE_TAIL_OPERATOR_RERUNS) {
    return refused(BUDGET_EXHAUSTED, `The operator rerun budget for stop ${recovery.sourceStopId} is exhausted`);
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
    body: `Operator re-ran recovery attempt ${String(reran.attempt)} after the gate FAIL of Run ${sourceRun.id}`,
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
