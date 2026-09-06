import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import { startBaseDriftRecoveryWorker } from "./merge-base-drift-worker.js";

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Patience, not a timing assumption: the loop returns the moment the condition
 *  holds, so this budget only bounds the failure case — a worker that never
 *  ticks still fails rather than hanging the suite. The size comes from the
 *  loaded gate worker (load1 20-55 on 2026-09-06), where a real 250ms interval
 *  and the sleeps inside a tick queue behind the host, not from an idle one. */
const waitUntil = async (predicate: () => boolean, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
    await wait(25);
  }
};

test("the base-drift recovery worker never overlaps ticks in one process", async () => {
  const previousInterval = process.env.MERGE_BASE_DRIFT_RECOVERY_POLL_INTERVAL_MS;
  process.env.MERGE_BASE_DRIFT_RECOVERY_POLL_INTERVAL_MS = "250";
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const db = {
    task: {
      findMany: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await wait(350);
        active -= 1;
        return [];
      },
    },
  } as unknown as PrismaClient;
  const timer = startBaseDriftRecoveryWorker(db, {
    readPullRequest: async () => { throw new Error("unexpected GitHub read"); },
  });
  try {
    await waitUntil(() => calls >= 2);
  } finally {
    clearInterval(timer);
    if (previousInterval === undefined) delete process.env.MERGE_BASE_DRIFT_RECOVERY_POLL_INTERVAL_MS;
    else process.env.MERGE_BASE_DRIFT_RECOVERY_POLL_INTERVAL_MS = previousInterval;
  }
  await waitUntil(() => active === 0);
  assert.equal(maximumActive, 1);
});
