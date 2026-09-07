import { type Prisma, type PrismaClient } from "@anneal/db";
import type { DispatchDrainStatus } from "@anneal/db/console-contract";

/**
 * The dispatch drain in force at `now`, or null.
 *
 * Expiry is applied here rather than by whoever wrote the row: a drain is
 * opened by an auto-deploy that is still waiting for its quiet window, and the
 * deploy process can die mid-wait. Reading the deadline on every claim is what
 * makes a stale row harmless instead of a fleet-wide outage.
 */
export const activeDispatchDrain = async (
  db: PrismaClient | Prisma.TransactionClient,
  now: Date,
): Promise<{ reason: string; startedAt: Date; expiresAt: Date } | null> => db.dispatchDrain.findFirst({
  where: { expiresAt: { gt: now } },
  // The longest-lived drain answers for all of them: it is the one a claim
  // must outlast, and the one an operator has to explain.
  orderBy: { expiresAt: "desc" },
  select: { reason: true, startedAt: true, expiresAt: true },
});

export const dispatchDrainStatus = (
  drain: { reason: string; startedAt: Date; expiresAt: Date } | null,
): DispatchDrainStatus | null => drain === null ? null : {
  reason: drain.reason,
  startedAt: drain.startedAt.toISOString(),
  expiresAt: drain.expiresAt.toISOString(),
};
