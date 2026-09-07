import assert from "node:assert/strict";

import type { PrismaClient } from "@anneal/db";

/** How many sessions are currently blocked on a database lock. Shared by the
 *  dbtests that prove a request is serialized behind FOR UPDATE. */
export const blockedLockCount = async (db: PrismaClient): Promise<number> => {
  const [row] = await db.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS "count"
    FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'
  `;
  return row?.count ?? 0;
};

/** Patience, not a timing assumption: the wait returns as soon as the locks
 *  appear, so this budget only bounds the failure case — a request that never
 *  blocks fails here rather than hanging the suite. It is sized for the loaded
 *  gate worker rather than an idle host, where the first request through the app
 *  pays for connection-pool warm-up before it reaches FOR UPDATE; see "Test
 *  timing on the gate worker" in CONTRIBUTING.md. */
export const BLOCKED_LOCK_BUDGET_MS = 30_000;

export const waitForBlockedLocks = async (db: PrismaClient, minimum: number): Promise<void> => {
  const deadline = Date.now() + BLOCKED_LOCK_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await blockedLockCount(db) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${minimum} blocked database lock(s)`);
};
