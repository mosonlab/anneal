import {
  MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES,
  MERGE_TAIL_KIND,
  Prisma,
  TaskStatus,
  openRun,
  openStopQuestion,
  stopStateFor,
  writeMarker,
} from "@anneal/db";

type DbTx = Prisma.TransactionClient;

/**
 * The state name this module writes onto `mergeTail.baseDriftRecovery`
 * markers. `requeued-external-failure` counts against the recovery ceiling;
 * `question-opened` is the terminal hand to an operator.
 */
export type IntegratorFailureExitState = "requeued-external-failure" | "question-opened";

export type IntegratorFailureExit =
  | { kind: "none" }
  | { kind: "requeued"; runId: string }
  | { kind: "question-opened"; questionId: string | null };

/**
 * How many times one deferred `base-drift` stop may be re-queued automatically
 * after an external integrator failure. It is the recovery attempt ceiling
 * rather than a second number: the re-queue is another automatic attempt at the
 * same merge, and a chain that keeps failing externally has to reach an
 * operator instead of looping.
 */
export const MAX_INTEGRATOR_EXTERNAL_FAILURE_REQUEUES = MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES;

const spentRequeues = async (tx: DbTx, integratorTaskId: string, sourceStopId: string): Promise<number> => (
  tx.taskActivity.count({
    where: {
      taskId: integratorTaskId,
      AND: [
        { metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.baseDriftRecovery } },
        { metadata: { path: ["state"], equals: "requeued-external-failure" } },
        { metadata: { path: ["sourceStopId"], equals: sourceStopId } },
      ],
    },
  })
);

/**
 * Open the question a canonical `base-drift` stop deferred to the recovery
 * worker. `openStopQuestion` is the one question surface for these stops, and
 * its dedupe key is generationed by the aggregate's `revalidations` exactly as
 * the recovery worker generations it, so this never adds a second card beside
 * one an operator is already looking at.
 */
const openDeferredStopQuestion = async (
  tx: DbTx,
  input: { integratorTaskId: string; stopId: string; evidence: string; sourceRunId: string | null },
): Promise<{ id: string } | null> => {
  const task = await tx.task.findUnique({
    where: { id: input.integratorTaskId },
    select: { assigneeAgentId: true },
  });
  if (!task?.assigneeAgentId) {
    throw new Error(`Merge integrator task ${input.integratorTaskId} has no assignee to address its stop question to`);
  }
  const [session, aggregate] = await Promise.all([
    input.sourceRunId
      ? tx.session.findUnique({ where: { runId: input.sourceRunId }, select: { id: true } })
      : null,
    tx.mergeRecoveryAttempt.findFirst({
      where: { integratorTaskId: input.integratorTaskId, sourceStopId: input.stopId },
      orderBy: [{ attempt: "desc" }, { id: "desc" }],
      select: { revalidations: true },
    }),
  ]);
  return openStopQuestion(tx, {
    integratorTaskId: input.integratorTaskId,
    stopId: input.stopId,
    condition: "base-drift",
    evidence: input.evidence,
    agentId: task.assigneeAgentId,
    sessionId: session?.id ?? null,
    generation: aggregate?.revalidations ?? 0,
  });
};

/**
 * The exit a failed merge-integrator Run leaves behind when its Task still
 * carries a `base-drift` stop whose operator question was deferred.
 *
 * That combination is what left three chains with no exit on 2026-09-07: the
 * stop refuses `POST /tasks/:id/retry` and `/start`, the `integrator-authorized`
 * intent that could bypass it was already spent opening this Run, and the
 * deferred question means there is nothing to answer either.
 *
 * So the failure decides which exit it is:
 *
 *  - An external failure — the environment failed, not the merge — re-queues
 *    the integrator on a fresh `integrator-authorized` intent bound to the same
 *    authorization, bounded by the recovery attempt ceiling. If the base has
 *    moved under it, that Run stops on `base-drift` again and the ordinary
 *    recovery worker opens the next recovery, which is the path this one is
 *    handing back to.
 *  - Anything else is a deterministic refusal and stops: the deferred question
 *    is opened so an operator has something to answer.
 *
 * Callers restrict this to a failed Run on a canonical integrator Step; a Task
 * with no unresolved stop, or a stop on another condition (which opened its own
 * question when it landed), is left alone.
 */
export const settleFailedIntegratorRun = async (
  tx: DbTx,
  input: {
    integratorTaskId: string;
    runId: string;
    external: boolean;
    failureReason: string;
    now: Date;
  },
): Promise<IntegratorFailureExit> => {
  const stopped = await stopStateFor(tx, input.integratorTaskId);
  if (!stopped || stopped.stop.condition !== "base-drift") return { kind: "none" };
  const sourceStopId = stopped.stop.stopId;

  // The re-queue, when the failure was external and the ceiling has room. A
  // refused birth must not roll the completion back — the Run's terminal state
  // and its failure evidence are the point of this transaction — so an operator
  // Hold or a spent budget simply makes the question below the exit instead,
  // and the refusal is recorded with it.
  const spent = input.external
    ? await spentRequeues(tx, input.integratorTaskId, sourceStopId)
    : MAX_INTEGRATOR_EXTERNAL_FAILURE_REQUEUES;
  const requeue = spent < MAX_INTEGRATOR_EXTERNAL_FAILURE_REQUEUES
    ? await openRun(tx, input.integratorTaskId, { kind: "integrator-authorized", readyAt: input.now })
    : null;
  if (requeue?.ok) {
    await tx.task.update({
      where: { id: input.integratorTaskId },
      data: { status: TaskStatus.TODO, failureReason: null },
    });
    await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", {
      actorType: "control-plane",
      body: `Merge integrator Run failed externally (${input.failureReason}); mechanical merge re-queued `
        + `${String(spent + 1)} of ${String(MAX_INTEGRATOR_EXTERNAL_FAILURE_REQUEUES)}`,
      metadata: {
        state: "requeued-external-failure",
        integratorTaskId: input.integratorTaskId,
        sourceStopId,
        failedRunId: input.runId,
        runId: requeue.run.id,
        requeue: spent + 1,
        limit: MAX_INTEGRATOR_EXTERNAL_FAILURE_REQUEUES,
        reason: input.failureReason,
      },
    });
    return { kind: "requeued", runId: requeue.run.id };
  }
  const requeueRefusal = requeue === null ? null : requeue.refusal.message;

  const question = await openDeferredStopQuestion(tx, {
    integratorTaskId: input.integratorTaskId,
    stopId: sourceStopId,
    evidence: stopped.stop.evidence,
    sourceRunId: stopped.stop.sourceRunId,
  });
  await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", {
    actorType: "control-plane",
    body: `Merge integrator Run failed (${input.failureReason}); the deferred base-drift question is now open`,
    metadata: {
      state: "question-opened",
      integratorTaskId: input.integratorTaskId,
      sourceStopId,
      failedRunId: input.runId,
      external: input.external,
      questionId: question?.id ?? null,
      reason: input.failureReason,
      ...(requeueRefusal === null ? {} : { requeueRefusal }),
    },
  });
  return { kind: "question-opened", questionId: question?.id ?? null };
};
