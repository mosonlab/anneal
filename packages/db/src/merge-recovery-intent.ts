import { type MergeRecoveryAttempt, MergeRecoveryStatus, type Prisma, TaskStatus } from "@prisma/client";

import { transitionMergeRecovery } from "./merge-tail.js";
import { writeMarker } from "./merge-tail-markers.js";
import { errorForOpenRunRefusal, openRun } from "./run-open.js";

type Tx = Prisma.TransactionClient;

export type ReplayedIntegratorAuthorization = {
  aggregateId: string;
  integratorTaskId: string;
  runId: string;
  authorizationActivityId: string;
};

/**
 * The recovery in one Chain whose readiness authorization landed while the
 * Chain was held at the integrator's layer, or null when there is none.
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

/**
 * The exit a base-drift recovery keeps when its readiness authorization landed
 * while the Chain was held at the integrator's layer.
 *
 * `integrator-authorized` is raised once, at authorization time, and a Hold
 * refuses the Run birth it pays for. Before this, that intent was simply spent:
 * `chain/resume` released the control, ordinary activation was refused by the
 * unresolved stop, and the chain had no exit left because a `base-drift` stop
 * on a canonical Step defers its operator question. The aggregate records the
 * pending authorization and owns replaying it — exactly once, because the
 * replay claims the column with a compare-and-set before opening anything.
 *
 * The aggregate is deliberately left short of SUCCEEDED until this runs: a
 * recovery is finished when the integrator Run it authorized exists, not when
 * the authorization was written.
 */
export const replayPendingIntegratorAuthorization = async (
  tx: Tx,
  pending: MergeRecoveryAttempt,
  now: Date,
): Promise<ReplayedIntegratorAuthorization | null> => {
  const authorizationActivityId = pending.pendingAuthorizationId;
  if (!authorizationActivityId) return null;
  // The claim is the whole of "exactly once": a second Resume that reaches here
  // concurrently loses the compare-and-set and opens nothing.
  const claimed = await tx.mergeRecoveryAttempt.updateMany({
    where: { id: pending.id, pendingAuthorizationId: authorizationActivityId },
    data: { pendingAuthorizationId: null },
  });
  if (claimed.count !== 1) return null;

  const opened = await openRun(tx, pending.integratorTaskId, { kind: "integrator-authorized", readyAt: now });
  if (!opened.ok) throw errorForOpenRunRefusal(opened.refusal);
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
    body: "Chain resumed; the held recovery authorization was replayed and the mechanical merge run queued",
    metadata: {
      state: "authorization-replayed",
      aggregateId: pending.id,
      integratorTaskId: pending.integratorTaskId,
      sourceStopId: pending.sourceStopId,
      authorizationActivityId,
      recoveryRunId: pending.recoveryRunId,
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
