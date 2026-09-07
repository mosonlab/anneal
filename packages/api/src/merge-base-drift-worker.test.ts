import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import { startBaseDriftRecoveryWorker } from "./merge-base-drift-worker.js";
import { waitUntil } from "./worker-tick-wait.js";

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
