import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { startDependencyCacheMaintenance } from "./dependency-cache-maintenance.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
};

test("background maintenance does not block its caller or overlap scheduled passes", async () => {
  const gate = deferred();
  let calls = 0;
  let scheduled!: () => Promise<void>;
  let cancelled = false;
  const errors: unknown[] = [];
  const monitor = startDependencyCacheMaintenance({ workspaceRoot: "/unused-injected-workspace" }, {
    sweep: async () => { calls += 1; await gate.promise; },
    schedule: (tick) => { scheduled = tick; return () => { cancelled = true; }; },
    onError: (error) => { errors.push(error); },
  });
  try {
    assert.equal(calls, 1, "startup starts a pass without awaiting its completion");
    await scheduled();
    assert.equal(calls, 1, "a slow delete cannot accumulate overlapping passes");
    gate.resolve();
    await setImmediate();
    await scheduled();
    assert.equal(calls, 2, "another pass runs after the previous one finishes");
    assert.deepEqual(errors, []);
  } finally {
    gate.resolve();
    monitor.stop();
  }
  assert.equal(cancelled, true);
  await scheduled();
  assert.equal(calls, 2, "a queued tick does nothing after shutdown");
});

test("maintenance failures are reported and retried by a later tick", async () => {
  let scheduled!: () => Promise<void>;
  let calls = 0;
  const errors: unknown[] = [];
  const failure = new Error("deletion failed");
  const monitor = startDependencyCacheMaintenance({ workspaceRoot: "/unused-injected-workspace" }, {
    sweep: async () => { calls += 1; if (calls === 1) throw failure; },
    schedule: (tick) => { scheduled = tick; return () => undefined; },
    onError: (error) => { errors.push(error); },
  });
  try {
    await setImmediate();
    assert.deepEqual(errors, [failure]);
    await scheduled();
    assert.equal(calls, 2);
  } finally {
    monitor.stop();
  }
});

test("shutdown aborts in-flight maintenance without waiting for a slow filesystem", async () => {
  const gate = deferred();
  let signal!: AbortSignal;
  const errors: unknown[] = [];
  const monitor = startDependencyCacheMaintenance({ workspaceRoot: "/unused-injected-workspace" }, {
    sweep: async (current) => { signal = current; await gate.promise; throw new Error("aborted"); },
    schedule: () => () => undefined,
    onError: (error) => { errors.push(error); },
  });
  monitor.stop();
  assert.equal(signal.aborted, true);
  gate.resolve();
  await setImmediate();
  assert.deepEqual(errors, [], "cancellation is not reported as a cleanup failure");
});
