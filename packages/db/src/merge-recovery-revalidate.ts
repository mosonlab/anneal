import {
  MergeRecoveryStatus,
  MergeRecoveryRetryClass,
  Prisma,
  TaskStatus,
  type MergeRecoveryAttempt,
} from "@prisma/client";

import {
  MERGE_RECOVERY_RETRY_CLASS_NAME,
  mergeRecoveryCeilingClass,
  mergeRecoveryClassReset,
  transitionMergeRecovery,
} from "./merge-tail.js";
import { writeMarker } from "./merge-tail-markers.js";

type Tx = Prisma.TransactionClient;

export type RecoveryRevalidation = {
  aggregateId: string;
  retryClass: MergeRecoveryRetryClass;
  revalidations: number;
};

/**
 * The newest recovery attempt for one stop, when a retry class crossed its own
 * ceiling and left counters an operator can reset. Every other state — an
 * ordinary ineligibility, a live validation, a recovery already running — has
 * nothing for `re-validate` to reopen, so it reads as absent here.
 */
export const revalidatableRecoveryAttempt = async (
  tx: Tx,
  integratorTaskId: string,
  sourceStopId: string,
): Promise<{ attempt: MergeRecoveryAttempt; retryClass: MergeRecoveryRetryClass } | null> => {
  const attempt = await tx.mergeRecoveryAttempt.findFirst({
    where: { integratorTaskId, sourceStopId },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  if (!attempt || attempt.status !== MergeRecoveryStatus.FAILED) return null;
  const retryClass = mergeRecoveryCeilingClass(attempt.refusalCode);
  return retryClass ? { attempt, retryClass } : null;
};

/**
 * The operator resume a class ceiling offers: reset that class's counters, and
 * only that class's, then hand the recovery back to the worker. The
 * revalidation counter generations the stop notice and question keys, so a
 * second ceiling still reaches the operator instead of deduplicating into
 * silence against the first one's card.
 */
export const revalidateAfterClassCeiling = async (
  tx: Tx,
  input: { integratorTaskId: string; sourceStopId: string },
): Promise<RecoveryRevalidation> => {
  const ceiling = await revalidatableRecoveryAttempt(tx, input.integratorTaskId, input.sourceStopId);
  if (!ceiling) {
    throw new Error(
      `Merge recovery for stop ${input.sourceStopId} has no retry-class ceiling to re-validate`,
    );
  }
  const { attempt, retryClass } = ceiling;
  // Every recovery activity spells the class in lowercase; the Prisma member
  // name never reaches operator text or marker metadata.
  const className = MERGE_RECOVERY_RETRY_CLASS_NAME[retryClass];
  const revalidations = attempt.revalidations + 1;
  await transitionMergeRecovery(tx, attempt.id, MergeRecoveryStatus.VALIDATING, {
    ...mergeRecoveryClassReset(retryClass),
    nextEligibleAt: null,
    failureReason: null,
    refusalCode: null,
    endedAt: null,
    revalidations,
  });
  await tx.task.update({
    where: { id: input.integratorTaskId },
    data: {
      status: TaskStatus.REVIEW,
      failureReason: `Automatic base-drift recovery re-validating after its ${className} ceiling was reset`,
    },
  });
  await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", {
    actorType: "operator",
    body: `Automatic pre-merge base-drift recovery re-validated: ${className} counters reset by operator`,
    metadata: {
      state: "class-revalidated",
      integratorTaskId: input.integratorTaskId,
      sourceStopId: input.sourceStopId,
      aggregateId: attempt.id,
      retryClass: className,
      revalidations,
    },
  });
  return { aggregateId: attempt.id, retryClass, revalidations };
};
