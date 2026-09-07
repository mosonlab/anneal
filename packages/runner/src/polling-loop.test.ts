import assert from "node:assert/strict";
import { setImmediate as scheduleImmediate } from "node:timers/promises";
import { test } from "node:test";

import { runPollingLoop, type ClaimOutcome, type PollingLoopConfig } from "./polling-loop.js";

const config: PollingLoopConfig = {
  pollIntervalMs: 100,
  workspaceReclaimIntervalMs: 2,
  claimMaxLoadAverage: 10,
};

test("overload skips claims, waits, reclaims on schedule, and recovers once", async () => {
  const loads = [11, 11, 11, 10, 10];
  let clock = 0;
  let stopping = false;
  let loadReads = 0;
  let reclaimCalls = 0;
  let claimCalls = 0;
  let firstClaimFinished = false;
  let finishFirstClaim: (() => void) | undefined;
  const waits: number[] = [];
  const logs: string[] = [];
  const events: string[] = [];

  const loop = runPollingLoop(config, {
    readLoadAverage: () => {
      loadReads += 1;
      const load = loads.shift() ?? 10;
      events.push(`load:${load}`);
      return load;
    },
    now: () => clock,
    wait: async (delayMs) => {
      events.push("wait");
      waits.push(delayMs);
      clock += 1;
    },
    reclaim: async () => {
      events.push("reclaim");
      reclaimCalls += 1;
    },
    claim: async () => {
      events.push("claim");
      claimCalls += 1;
      if (claimCalls === 1) {
        await new Promise<void>((resolve) => { finishFirstClaim = resolve; });
        firstClaimFinished = true;
        return "executed";
      }
      stopping = true;
      return "idle";
    },
    shouldStop: () => stopping,
    log: (line) => logs.push(line),
  });

  while (claimCalls === 0) await scheduleImmediate();
  assert.equal(loadReads, 4, "the first claim is reached only after three overload reads");
  assert.equal(reclaimCalls, 2, "reclaim runs on both due iterations while overloaded");
  assert.deepEqual(waits, [100, 100, 100]);
  assert.deepEqual(events, [
    "reclaim", "load:11", "wait",
    "load:11", "wait",
    "reclaim", "load:11", "wait",
    "load:10", "claim",
  ], "each due reclaim finishes before that iteration's admission decision");
  assert.deepEqual(logs, ["Runner claim overloaded: load=11 threshold=10", "Runner claim recovered: load=10 threshold=10"]);
  assert.equal(firstClaimFinished, false, "the claim's execution remains awaited");

  finishFirstClaim!();
  await loop;

  assert.equal(firstClaimFinished, true);
  assert.equal(claimCalls, 2, "an admitted iteration follows immediately after a successful claim");
  assert.equal(loadReads, 5, "execution does not perform another load read before it completes");
  assert.equal(reclaimCalls, 2);
  assert.deepEqual(waits, [100, 100, 100, 100]);
  assert.deepEqual(logs, ["Runner claim overloaded: load=11 threshold=10", "Runner claim recovered: load=10 threshold=10"]);
});

test("zero load admits a claim without transition logs", async () => {
  let stopping = false;
  let claimCalls = 0;
  const logs: string[] = [];

  await runPollingLoop({ ...config, workspaceReclaimIntervalMs: 60_000 }, {
    readLoadAverage: () => 0,
    reclaim: async () => undefined,
    claim: async () => {
      claimCalls += 1;
      return "idle";
    },
    shouldStop: () => stopping,
    wait: async (delayMs) => {
      assert.equal(delayMs, config.pollIntervalMs);
      stopping = true;
    },
    log: (line) => logs.push(line),
  });

  assert.equal(claimCalls, 1);
  assert.deepEqual(logs, []);
});

test("a reclaim failure is reported without stopping later polls", async () => {
  let clock = 0;
  let reclaimCalls = 0;
  let claimCalls = 0;
  let stopping = false;
  const waits: number[] = [];
  const errors: Array<[string, unknown]> = [];
  const failure = new Error("reclaim unavailable");

  await runPollingLoop({ ...config, workspaceReclaimIntervalMs: 1 }, {
    readLoadAverage: () => 0,
    now: () => clock,
    reclaim: async () => {
      reclaimCalls += 1;
      if (reclaimCalls === 1) throw failure;
    },
    claim: async () => {
      claimCalls += 1;
      return "idle";
    },
    shouldStop: () => stopping,
    wait: async (delayMs) => {
      waits.push(delayMs);
      clock += 1;
      if (waits.length === 2) stopping = true;
    },
    error: (line, error) => errors.push([line, error]),
  });

  assert.equal(reclaimCalls, 2);
  assert.equal(claimCalls, 2);
  assert.deepEqual(waits, [config.pollIntervalMs, config.pollIntervalMs]);
  assert.deepEqual(errors, [["Workspace reclaim sweep failed", failure]]);
});

test("a claim failure is reported without stopping later polls", async () => {
  let claimCalls = 0;
  let stopping = false;
  const waits: number[] = [];
  const errors: Array<[string, unknown]> = [];
  const failure = new Error("claim unavailable");

  await runPollingLoop({ ...config, workspaceReclaimIntervalMs: 60_000 }, {
    readLoadAverage: () => 0,
    reclaim: async () => undefined,
    claim: async () => {
      claimCalls += 1;
      if (claimCalls === 1) throw failure;
      return "idle";
    },
    shouldStop: () => stopping,
    wait: async (delayMs) => {
      waits.push(delayMs);
      if (waits.length === 2) stopping = true;
    },
    error: (line, error) => errors.push([line, error]),
  });

  assert.equal(claimCalls, 2);
  assert.deepEqual(waits, [config.pollIntervalMs, config.pollIntervalMs]);
  assert.deepEqual(errors, [["Runner poll failed", failure]]);
});

test("a dispatch drain logs one line on entry and one on exit while polling continues", async () => {
  const outcomes: ClaimOutcome[] = ["draining", "draining", "idle", "draining", "idle"];
  let stopping = false;
  let claimCalls = 0;
  const waits: number[] = [];
  const logs: string[] = [];

  await runPollingLoop({ ...config, workspaceReclaimIntervalMs: 60_000 }, {
    readLoadAverage: () => 0,
    reclaim: async () => undefined,
    claim: async () => {
      const outcome = outcomes[claimCalls]!;
      claimCalls += 1;
      if (claimCalls === outcomes.length) stopping = true;
      return outcome;
    },
    shouldStop: () => stopping,
    wait: async (delayMs) => { waits.push(delayMs); },
    log: (line) => logs.push(line),
  });

  assert.equal(claimCalls, outcomes.length, "the runner keeps polling — and heartbeating — through the drain");
  assert.deepEqual(waits, outcomes.map(() => config.pollIntervalMs));
  assert.deepEqual(logs, [
    "Runner claim draining: the control plane is refusing claims until a pending deploy lands",
    "Runner claim drain refusal ended",
    "Runner claim draining: the control plane is refusing claims until a pending deploy lands",
    "Runner claim drain refusal ended",
  ]);
});
