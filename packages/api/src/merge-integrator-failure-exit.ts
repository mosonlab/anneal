import {
  MergeRecoveryStatus,
  Prisma,
  TaskStatus,
  isCanonicalIntegratorStep,
  loadIntegratorTask,
  openDeferredBaseDriftQuestion,
  stopStateFor,
  transitionMergeRecovery,
  writeMarker,
} from "@anneal/db";

export type IntegratorFailureExit =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "question-opened"; questionId: string | null };

/** Completion records the exit; the recovery worker owns fresh reads and Run birth.
 * Keeping birth out of this transaction lets the old Lease release finish first. */
export const settleFailedIntegratorRun = async (
  tx: Prisma.TransactionClient,
  input: { integratorTaskId: string; runId: string; external: boolean; failureReason: string; now: Date },
): Promise<IntegratorFailureExit> => {
  const task = await loadIntegratorTask(tx, input.integratorTaskId);
  if (!isCanonicalIntegratorStep(task?.templateStep)) return { kind: "none" };
  const stopped = await stopStateFor(tx, input.integratorTaskId);
  if (!stopped || stopped.stop.condition !== "base-drift") return { kind: "none" };
  const sourceStopId = stopped.stop.stopId;
  const aggregate = await tx.mergeRecoveryAttempt.findFirst({
    where: { integratorTaskId: input.integratorTaskId, sourceStopId },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  if (input.external && aggregate?.status === MergeRecoveryStatus.SUCCEEDED && aggregate.authorizationActivityId) {
    await transitionMergeRecovery(tx, aggregate.id, MergeRecoveryStatus.AWAITING_AUTHORIZATION, {
      pendingAuthorizationId: aggregate.authorizationActivityId,
      pendingFailureRunId: input.runId,
      endedAt: null,
    });
    await tx.task.update({ where: { id: input.integratorTaskId }, data: {
      status: TaskStatus.REVIEW, failureReason: input.failureReason,
    } });
    await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", "external-failure-pending", {
      actorType: "control-plane",
      body: "External integrator failure queued recovery validation of the pending authorization",
      metadata: { aggregateId: aggregate.id, sourceStopId,
        failedRunId: input.runId, authorizationActivityId: aggregate.authorizationActivityId },
    });
    return { kind: "pending" };
  }
  const question = await openDeferredBaseDriftQuestion(tx, input.integratorTaskId, sourceStopId, {
    revalidations: aggregate?.revalidations ?? 0, ceiling: false,
  });
  await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", "question-opened", {
    actorType: "control-plane",
    body: `Merge integrator Run failed (${input.failureReason}); the deferred base-drift question is now open`,
    metadata: { sourceStopId, failedRunId: input.runId,
      external: input.external, questionId: question?.id ?? null },
  });
  return { kind: "question-opened", questionId: question?.id ?? null };
};
