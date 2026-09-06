import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";

import type { PrismaClient } from "@anneal/db";

import type { PullRequestReader } from "./github-read.js";
import { startEvidenceWorker } from "./merge-evidence-worker.js";

/**
 * A tick reads GitHub up to three times under an 8 s deadline, which is longer
 * than the 2 s poll interval. Before the in-flight guard the second interval
 * fired into the first tick's GitHub reads; this pins that it no longer does.
 */
test("a second evidence tick is skipped while the first is still in flight", async () => {
  const previousInterval = process.env.MERGE_EVIDENCE_POLL_INTERVAL_MS;
  process.env.MERGE_EVIDENCE_POLL_INTERVAL_MS = "250";
  after(() => {
    if (previousInterval === undefined) delete process.env.MERGE_EVIDENCE_POLL_INTERVAL_MS;
    else process.env.MERGE_EVIDENCE_POLL_INTERVAL_MS = previousInterval;
  });

  let ticks = 0;
  let releaseFirstTick = (): void => {};
  const firstTickHeld = new Promise<void>((resolve) => { releaseFirstTick = resolve; });
  const db = {
    inboxMessage: {
      findMany: async () => {
        ticks += 1;
        // Hold the first tick open across several interval firings; later ticks
        // return immediately so the guard is observably released, not stuck.
        if (ticks === 1) await firstTickHeld;
        return [];
      },
    },
  } as unknown as PrismaClient;
  const reader = {} as unknown as PullRequestReader;

  const timer = startEvidenceWorker(db, reader);
  try {
    await delay(900);
    assert.equal(ticks, 1, "the interval fired repeatedly but only one tick may run at a time");
    releaseFirstTick();
    await delay(600);
    assert.ok(ticks > 1, "the guard was never cleared, so no later tick ran");
  } finally {
    if (timer) clearInterval(timer);
  }
});
