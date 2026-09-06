import {
  settleLeaseEvent,
  type PrismaClient,
} from "@anneal/db";
import { mergeLeaseHoldSeconds } from "../../../scripts/merge-lease-adapter.mjs";

/** What one `merge-lease.sh release` did. */
export type MergeLeaseRelease =
  | { outcome: "released"; ref: string; sha: string; acquiredAt: string }
  | { outcome: "not-held" }
  | { outcome: "skipped"; heldFor: string }
  | { outcome: "refused"; heldBy: string }
  | { outcome: "unreachable"; detail: string };

/** The project-scoped identity of a Chain's external merge lease. */
export type MergeLeaseTarget = {
  projectId: string;
  chainId: string;
};

export type MergeLeaseHold = {
  acquiredAt: Date;
  releasedAt: Date;
  heldForSeconds: number;
};

/**
 * Calculate a non-negative whole-second hold from the lease blob timestamp. The
 * seconds come from the lease adapter so that this hold and the merge train's
 * are the same measurement rather than two implementations of one rule.
 */
export const mergeLeaseHold = (acquiredAt: string, releasedAt: Date): MergeLeaseHold | null => {
  const acquiredAtMs = Date.parse(acquiredAt);
  const releasedAtMs = releasedAt.getTime();
  const heldForSeconds = mergeLeaseHoldSeconds(acquiredAt, releasedAt);
  if (heldForSeconds === null) return null;
  return {
    acquiredAt: new Date(acquiredAtMs),
    releasedAt: new Date(releasedAtMs),
    heldForSeconds,
  };
};

export type MergeLeaseHoldRecordResult = "recorded" | "already-recorded" | "ignored";

/**
 * Persist one confirmed release on the latest chain task in its project.
 *
 * A non-release is deliberately a no-op. Malformed confirmation and database
 * failures propagate so a control-plane path cannot silently lose evidence.
 */
export const recordMergeLeaseHold = async (
  db: PrismaClient,
  target: MergeLeaseTarget,
  release: MergeLeaseRelease,
  releasedAt: Date,
): Promise<MergeLeaseHoldRecordResult> => {
  if (release.outcome !== "released" || !release.ref || !release.sha) return "ignored";
  const hold = mergeLeaseHold(release.acquiredAt, releasedAt);
  if (!hold) {
    throw new Error("Cannot record confirmed merge lease release: invalid acquiredAt or releasedAt");
  }

  const result = await db.$transaction(async (tx) => {
    const task = await tx.task.findFirst({
      where: {
        projectId: target.projectId,
        chainId: target.chainId,
        chainIndex: { not: null },
      },
      orderBy: [{ chainIndex: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (!task) {
      throw new Error(`Cannot record merge lease hold: chain ${target.chainId} has no task in project ${target.projectId}`);
    }
    return settleLeaseEvent(tx, {
      target,
      taskId: task.id,
      state: "released",
      at: hold.releasedAt,
      evidence: {
        ref: release.ref,
        sha: release.sha,
        acquiredAt: hold.acquiredAt,
        heldForSeconds: hold.heldForSeconds,
      },
    });
  });
  return result.settled ? "recorded" : "already-recorded";
};
