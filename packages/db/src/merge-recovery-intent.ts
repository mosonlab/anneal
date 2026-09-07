import { type MergeRecoveryAttempt, MergeRecoveryStatus, type Prisma, TaskStatus } from "@prisma/client";

import { transitionMergeRecovery } from "./merge-tail.js";
import { writeMarker } from "./merge-tail-markers.js";
import { openRun } from "./run-open.js";

type Tx = Prisma.TransactionClient;

export type ReplayedIntegratorAuthorization = {
  aggregateId: string;
  integratorTaskId: string;
  runId: string;
  authorizationActivityId: string;
};

/**
 * The recovery in one Chain whose authorization is pending after a Hold or an
 * external integrator failure, or null when there is none.
 *
 * Read separately from the replay so `chain/resume` can put its own Start
 * admission checklist between the two without that checklist moving out of the
 * mutation that owns the Chain mutex.
 */
export const pendingIntegratorAuthorization = async (
  tx: Tx,
  input: { projectId: string; chainId: string },
): Promise<MergeRecoveryAttempt | null> => tx.mergeRecoveryAttempt.findFirst({
  where: {
    status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
    pendingAuthorizationId: { not: null },
    integratorTask: { projectId: input.projectId, chainId: input.chainId },
  },
  orderBy: [{ attempt: "desc" }, { id: "desc" }],
});

/** Called only under the Chain mutex and a freshly acquired merge Lease.
 * Admission refusal preserves the aggregate intent; successful birth consumes
 * it and accounts an external replay in the same transaction as the handoff. */
export const replayPendingIntegratorAuthorization = async (
  tx: Tx,
  pending: MergeRecoveryAttempt,
  now: Date,
): Promise<ReplayedIntegratorAuthorization | null> => {
  const authorizationActivityId = pending.pendingAuthorizationId;
  if (!authorizationActivityId) return null;
  const opened = await openRun(tx, pending.integratorTaskId, { kind: "integrator-authorized", readyAt: now });
  if (!opened.ok) {
    await writeMarker(tx, pending.integratorTaskId, "baseDriftRecovery", {
      actorType: "control-plane",
      body: `Pending recovery authorization was not replayed: ${opened.refusal.message}`,
      metadata: { state: "authorization-replay-refused", aggregateId: pending.id,
        authorizationActivityId, reason: opened.refusal.code },
    });
    return null;
  }
  await tx.mergeRecoveryAttempt.update({ where: { id: pending.id }, data: {
    pendingAuthorizationId: null,
    pendingFailureRunId: null,
    ...(pending.pendingFailureRunId ? { externalReplayCount: { increment: 1 } } : {}),
  } });
  await tx.task.updateMany({
    where: {
      id: pending.integratorTaskId,
      status: { in: [TaskStatus.REVIEW, TaskStatus.TODO, TaskStatus.DOING] },
    },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  await transitionMergeRecovery(tx, pending.id, MergeRecoveryStatus.SUCCEEDED, {
    authorizationActivityId,
    failureReason: null,
    refusalCode: null,
    endedAt: now,
  });
  await writeMarker(tx, pending.integratorTaskId, "baseDriftRecovery", {
    actorType: "control-plane",
    body: "Recovery authorization replayed; mechanical merge Run queued under its Lease",
    metadata: {
      state: "authorization-replayed",
      aggregateId: pending.id,
      integratorTaskId: pending.integratorTaskId,
      sourceStopId: pending.sourceStopId,
      authorizationActivityId,
      recoveryRunId: pending.recoveryRunId,
      failedRunId: pending.pendingFailureRunId,
      runId: opened.run.id,
    },
  });
  return {
    aggregateId: pending.id,
    integratorTaskId: pending.integratorTaskId,
    runId: opened.run.id,
    authorizationActivityId,
  };
};
