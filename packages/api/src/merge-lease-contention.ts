import {
  readLatestMarker,
  recordLeaseContention,
  writeMarker,
  type Marker,
  type Prisma,
  type PrismaClient,
} from "@anneal/db";
import type { MergeLeaseHolder } from "../../../scripts/merge-lease-adapter.mjs";

import type { MergeLeaseTarget } from "./merge-lease-hold.js";
import { openOperatorAlert } from "./operator-alert.js";
import type { ReadinessClaimHandle } from "./readiness-claim.js";

/**
 * How long a chain may be shut out of the merge Lease before an operator is
 * told. Contention itself is ordinary -- another chain is merging, and this one
 * comes back on the next tick. Contention that does not end is not: the lease
 * has no heartbeat, so a holder whose process died leaves the ref standing and
 * every other chain waits behind it until somebody looks.
 */
export const DEFAULT_CONTENTION_ALERT_MINUTES = 30;

export const contentionAlertAfterMs = (environment: NodeJS.ProcessEnv = process.env): number => {
  const raw = Number(environment.MERGE_LEASE_CONTENTION_ALERT_MINUTES);
  return (Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTENTION_ALERT_MINUTES) * 60_000;
};

/** One alert per episode: the prefix names the chain, the key adds its start. */
export const contentionAlertDedupePrefix = (chainId: string): string => `merge-lease-contention:${chainId}:`;

/**
 * What one contended acquisition did to the chain's contention episode.
 * `not-owned` is a worker whose readiness claim has already passed to a
 * successor: it observed the contention, but it is no longer the Step's owner
 * and writes nothing.
 */
export type LeaseContentionOutcome = "opened" | "continuing" | "alerted" | "not-owned";

export type LeaseContentionInput = {
  target: MergeLeaseTarget;
  readinessTaskId: string;
  holder: MergeLeaseHolder | null;
  now: Date;
  /** The Handle that owns the readiness Step; every write below is fenced by it. */
  claim: ReadinessClaimHandle;
};

/**
 * The holder in the words an operator reads. A contended acquire names the
 * holder when `merge-lease.sh` could read the lease blob; when it could not,
 * saying so is better than implying there is nobody there.
 */
const describeHolder = (holder: MergeLeaseHolder | null): string => {
  if (!holder) return "a holder the lease script could not name";
  const details = [
    holder.task ? `task ${holder.task}` : null,
    holder.reason ? `reason "${holder.reason}"` : null,
    `acquired at ${holder.acquiredAt}`,
  ].filter((detail): detail is string => detail !== null);
  return `${holder.holder} (${details.join(", ")})`;
};

const holderMetadata = (holder: MergeLeaseHolder | null): Record<string, unknown> => (
  holder === null ? { holder: null } : {
    holder: holder.holder,
    holderTask: holder.task,
    holderReason: holder.reason,
    holderAcquiredAt: holder.acquiredAt,
    holderLeaseSha: holder.sha,
  }
);

const holderAcquiredAt = (holder: MergeLeaseHolder | null): Date | null => {
  if (!holder) return null;
  const acquiredAtMs = Date.parse(holder.acquiredAt);
  return Number.isFinite(acquiredAtMs) ? new Date(acquiredAtMs) : null;
};

/**
 * The episode this chain is in, read by kind so that a burst of unrelated
 * activity cannot hide it and restart the window it opened.
 */
const openEpisode = async (
  tx: Prisma.TransactionClient,
  readinessTaskId: string,
): Promise<Marker | null> => {
  const marker = await readLatestMarker(tx, readinessTaskId, "leaseContention");
  return marker && marker.state !== "resolved" ? marker : null;
};

const episodeStart = (raw: Record<string, unknown>, fallback: Date): Date => {
  const startedAtMs = typeof raw.firstContendedAt === "string" ? Date.parse(raw.firstContendedAt) : Number.NaN;
  return Number.isFinite(startedAtMs) ? new Date(startedAtMs) : fallback;
};

/**
 * Record one contended acquisition against the chain's contention episode.
 *
 * An episode is durable state rather than a counter in this process: it starts
 * at the first contention, stays open across ticks, and ends when the chain
 * finally gets an answer other than contention. A counter held in the worker
 * would restart the 30 minutes every time the API restarted, which is exactly
 * when a lease is most likely to have been stranded.
 *
 * Nothing here steals the lease. Breaking somebody else's lease inside 45
 * minutes is a decision an operator makes with `merge-lease.sh steal --human`.
 */
export const noteLeaseContention = async (
  db: PrismaClient,
  input: LeaseContentionInput,
  alertAfterMs: number = contentionAlertAfterMs(),
): Promise<LeaseContentionOutcome> => await db.$transaction(async (transaction) => {
  const settlement = await input.claim.settle<LeaseContentionOutcome>(transaction, {
    kind: "keep",
    apply: async (tx) => {
      const open = await openEpisode(tx, input.readinessTaskId);
      const description = describeHolder(input.holder);

      if (!open) {
        await writeMarker(tx, input.readinessTaskId, "leaseContention", {
          actorType: "control-plane",
          body: `Merge Lease for chain ${input.target.chainId} is held by ${description}`,
          metadata: {
            state: "contended",
            projectId: input.target.projectId,
            chainId: input.target.chainId,
            firstContendedAt: input.now.toISOString(),
            ...holderMetadata(input.holder),
          },
        });
        return "opened";
      }
      if (open.state === "alerted") return "continuing";

      const startedAt = episodeStart(open.raw, input.now);
      if (input.now.getTime() - startedAt.getTime() < alertAfterMs) return "continuing";

      const minutes = Math.floor((input.now.getTime() - startedAt.getTime()) / 60_000);
      const detail = `Chain ${input.target.chainId} has been unable to take the merge Lease for ${minutes} minutes; it is held by ${description}`;
      await writeMarker(tx, input.readinessTaskId, "leaseContention", {
        actorType: "control-plane",
        body: detail,
        metadata: {
          state: "alerted",
          projectId: input.target.projectId,
          chainId: input.target.chainId,
          firstContendedAt: startedAt.toISOString(),
          alertedAt: input.now.toISOString(),
          ...holderMetadata(input.holder),
        },
      });
      await recordLeaseContention(tx, {
        target: input.target,
        taskId: input.readinessTaskId,
        holderAcquiredAt: holderAcquiredAt(input.holder),
        detail,
        at: input.now,
      });
      // Every episode gets its alert. The episode marker already makes it one
      // per episode, and the dedupe key carries that episode's start, so a
      // still-unread alert from an earlier episode cannot silence this one.
      await openOperatorAlert(tx, {
        body: `${detail}. Nothing was stolen: inspect with \`scripts/merge-lease.sh status\` and, if the holder is gone, break it with \`scripts/merge-lease.sh steal --human --reason "..."\`.`,
        dedupeKey: `${contentionAlertDedupePrefix(input.target.chainId)}${startedAt.toISOString()}`,
      });
      return "alerted";
    },
  });
  return settlement.settled ? settlement.value : "not-owned";
});

/**
 * Close the chain's contention episode because the run of contended results
 * broke: this tick took the Lease, could not reach origin, or settled before it
 * ever reached for the Lease. The window measures continuous contention, so the
 * next contention is a new episode with its own 30 minutes.
 */
export const clearLeaseContention = async (
  db: PrismaClient,
  input: {
    target: MergeLeaseTarget;
    readinessTaskId: string;
    now: Date;
    claim: ReadinessClaimHandle;
  },
): Promise<boolean> => await db.$transaction(async (transaction) => {
  const settlement = await input.claim.settle<boolean>(transaction, {
    kind: "keep",
    apply: async (tx) => {
      const open = await openEpisode(tx, input.readinessTaskId);
      if (!open) return false;
      await writeMarker(tx, input.readinessTaskId, "leaseContention", {
        actorType: "control-plane",
        body: `Merge Lease contention for chain ${input.target.chainId} ended`,
        metadata: {
          state: "resolved",
          projectId: input.target.projectId,
          chainId: input.target.chainId,
          firstContendedAt: episodeStart(open.raw, input.now).toISOString(),
          resolvedAt: input.now.toISOString(),
        },
      });
      return true;
    },
  });
  return settlement.settled ? settlement.value : false;
});
