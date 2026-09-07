import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEPLOY_PHASES, UPGRADE_DEPLOY_PHASES } from "./deploy-phases.mjs";
import { openDeploymentAttempt } from "./deployment-attempt.mjs";
import { runDeployCommand } from "./quiet-window-command.mjs";
import { writeEscalationRecord } from "./quiet-window-escalation-record.mjs";
import { DeployFailure, executeUpgrade } from "./quiet-window-lib.mjs";
import {
  DEPLOY_BARRIER_BUDGETED_WORK_MS,
  DEPLOY_BARRIER_TARGET_REFRESH_TIMEOUT_MS,
  DEPLOY_BARRIER_PHASE_TIMEOUT_MS,
  DEPLOY_BARRIER_RECOVERY_BUDGET_MS,
  BARRIER_TIMEOUT_REASON,
  createBarrierWatchdog,
  DEPLOY_BARRIER_TIMEOUT_MS,
  DEPLOY_BARRIER_WATCHDOG_MARGIN_MS,
  DEPLOY_STEP_TIMEOUT_MS,
  deployBarrierTimeoutMsForRole,
  waitForQuietWithWatchdog,
  waitForEscalationClear,
  blockingRunCountsByRunner,
  DEFAULT_QUIET_WINDOW_WAIT_BUDGET_MS,
  QUIET_WINDOW_WAIT_ALERT_INTERVAL_MS,
  quietWindowWaitBudgetMs,
  DEFAULT_DISPATCH_DRAIN_DEADLINE_MS,
  dispatchDrainDeadlineMs,
} from "./quiet-window-deadlines.mjs";
import { createDeployInterruption } from "./quiet-window-interrupt.mjs";

const revisions = { from: "a".repeat(40), to: "b".repeat(40) };

const timeoutUpgrade = ({ phase, run, escalationFails = false, wait, barrierHeld = true }) => {
  const calls = [];
  const state = { escalationExists: false, retained: false, released: false };
  const barrier = {
    retainUntilEscalationCleared: () => { state.retained = true; calls.push("retain-barrier"); },
    release: async () => {
      if (state.retained) {
        await waitForEscalationClear({
          escalationExists: () => state.escalationExists,
          verifyBarrier: async () => barrierHeld,
          wait: wait ?? (async () => { state.escalationExists = false; calls.push("clear-escalation"); }),
          onHold: () => { calls.push("hold-barrier"); },
        });
      }
      state.released = true;
      calls.push("release-barrier");
    },
    verify: async () => barrierHeld,
  };
  const host = {};
  for (const { hostMethod } of DEPLOY_PHASES) host[hostMethod] = async () => undefined;
  host.readRevisions = async () => ({ revisions });
  host.startDeploymentLedger = async () => ({ ledger: { start: async () => undefined, record: async () => undefined } });
  host.waitForQuiet = async () => ({ barrier, resources: [barrier] });
  host[phase] = async () => run({ barrier, state, calls });
  host.escalate = async (record) => {
    calls.push(`escalate-${record.reason}`);
    if (escalationFails) throw new Error("escalation-write-failed");
    state.escalationExists = true;
  };
  host.notify = async (record) => { calls.push(`notify-${record.outcome}`); };
  host.markEscalationNotified = async () => { calls.push("mark-notified"); };
  host.log = () => undefined;
  const attempt = openDeploymentAttempt({ deployRoot: "/fixture", targetCommit: revisions.to, transactionId: "timeout-fixture" });
  return { barrier, calls, execute: () => executeUpgrade(host, attempt), state };
};

const hangingCommand = (options) => runDeployCommand(
  "/bin/sh",
  ["-c", "trap '' TERM; exec sleep 30"],
  { timeoutMs: 20, timeoutReason: "fixture-timeout", killGraceMs: 20, ...options },
);

test("deploy deadlines are step-specific and preserve the observed build margin", () => {
  assert.ok(DEPLOY_STEP_TIMEOUT_MS.releaseArtifactBuild >= 15 * 60_000);
  assert.ok(DEPLOY_STEP_TIMEOUT_MS.migrationPreflight < DEPLOY_STEP_TIMEOUT_MS.migrationDeploy);
  assert.ok(DEPLOY_STEP_TIMEOUT_MS.migrationDeploy < DEPLOY_STEP_TIMEOUT_MS.releaseArtifactBuild);
  const supervisedPhases = UPGRADE_DEPLOY_PHASES
    .slice(UPGRADE_DEPLOY_PHASES.findIndex(({ name }) => name === "acquire-quiet-window") + 1)
    .map(({ name }) => name);
  assert.deepEqual(Object.keys(DEPLOY_BARRIER_PHASE_TIMEOUT_MS), supervisedPhases);
  assert.equal(
    DEPLOY_BARRIER_BUDGETED_WORK_MS,
    Object.values(DEPLOY_BARRIER_PHASE_TIMEOUT_MS).reduce((total, timeoutMs) => total + timeoutMs, DEPLOY_BARRIER_TARGET_REFRESH_TIMEOUT_MS),
  );
  assert.equal(
    DEPLOY_BARRIER_TIMEOUT_MS,
    DEPLOY_BARRIER_BUDGETED_WORK_MS
      + DEPLOY_BARRIER_RECOVERY_BUDGET_MS
      + DEPLOY_BARRIER_WATCHDOG_MARGIN_MS,
  );
  assert.ok(DEPLOY_BARRIER_TIMEOUT_MS > DEPLOY_BARRIER_BUDGETED_WORK_MS);
  assert.equal(deployBarrierTimeoutMsForRole("control-plane"), DEPLOY_BARRIER_TIMEOUT_MS);
  assert.ok(deployBarrierTimeoutMsForRole("runner", 6) < DEPLOY_BARRIER_TIMEOUT_MS);
  assert.equal(new Set(Object.values(DEPLOY_STEP_TIMEOUT_MS)).size > 1, true);
});

test("a retained barrier waits until the escalation marker is cleared", async () => {
  let active = true;
  let holds = 0;
  let clears = 0;
  let waits = 0;
  await waitForEscalationClear({
    escalationExists: () => active,
    verifyBarrier: async () => true,
    wait: async () => {
      waits += 1;
      active = false;
    },
    onHold: () => { holds += 1; },
    onCleared: () => { clears += 1; },
  });
  assert.deepEqual({ holds, clears, waits }, { holds: 1, clears: 1, waits: 1 });
});

test("a retained barrier fails closed until persistence is observed and then explicitly cleared", async () => {
  let active = false;
  let waits = 0;
  let persistencePending = 0;
  const held = waitForEscalationClear({
    escalationExists: () => active,
    verifyBarrier: async () => true,
    wait: async () => {
      waits += 1;
      if (waits === 1) active = true;
      else active = false;
    },
    onPersistencePending: () => { persistencePending += 1; },
  });
  await held;
  assert.equal(waits, 2);
  assert.equal(persistencePending, 1);
});

test("a retained barrier surfaces loss of its advisory lock", async () => {
  await assert.rejects(
    waitForEscalationClear({
      escalationExists: () => true,
      verifyBarrier: async () => false,
      wait: async () => undefined,
    }),
    (error) => error instanceof DeployFailure && error.reason === "deploy-barrier-lost-during-hold",
  );
});

test("the barrier watchdog starts before the post-lock blocking-runs query", async () => {
  const calls = [];
  let queryCount = 0;
  const barrier = { release: async () => { calls.push("release-barrier"); } };
  const watchdog = { release: async () => { calls.push("release-watchdog"); } };
  const result = await waitForQuietWithWatchdog({
    blockingRuns: async () => {
      queryCount += 1;
      calls.push(queryCount === 1 ? "query-before-lock" : "query-after-lock");
      return [];
    },
    acquireBarrier: async () => {
      calls.push("acquire-barrier");
      return barrier;
    },
    startWatchdog: async () => {
      calls.push("start-watchdog");
      return watchdog;
    },
    wait: async () => undefined,
  });
  assert.deepEqual(calls, ["query-before-lock", "acquire-barrier", "start-watchdog", "query-after-lock"]);
  assert.equal(result.barrier, barrier);
  assert.equal(result.watchdog, watchdog);
});

/** One quiet-window wait driven by a fixed clock: every poll advances the
 * clock by `stepMs` and the wait ends once `blockedPolls` polls have passed. */
const drivenWait = async ({ blockedPolls, stepMs, waitBudgetMs, alertIntervalMs, runs, deliver }) => {
  let clock = 0;
  let polls = 0;
  const holds = [];
  const alerts = [];
  const barrier = { release: async () => undefined };
  const outcome = await waitForQuietWithWatchdog({
    blockingRuns: async () => (polls < blockedPolls ? runs : []),
    acquireBarrier: async () => barrier,
    startWatchdog: async () => ({ release: async () => undefined }),
    // Each poll ends on a macrotask, so an alert dispatched beside the loop
    // has settled before the next poll decides whether to alert again.
    wait: async () => {
      polls += 1;
      clock += stepMs;
      await new Promise((accept) => { setImmediate(accept); });
    },
    now: () => clock,
    ...(waitBudgetMs === undefined ? {} : { waitBudgetMs }),
    ...(alertIntervalMs === undefined ? {} : { alertIntervalMs }),
    onWaitBudgetExceeded: (event) => {
      alerts.push(event);
      return deliver?.(alerts.length);
    },
    onBlockingRuns: (blocking, progress) => holds.push({ blocking: blocking.length, ...progress }),
  });
  // The alert that a completed over-budget wait raises is dispatched as the
  // loop returns; let it land before the caller reads it.
  await new Promise((accept) => { setImmediate(accept); });
  return { outcome, holds, alerts };
};

const RUNS = [
  { id: "run-1", status: "running", runnerId: "mac-runner-1" },
  { id: "run-2", status: "claimed", runnerId: "mac-runner-1" },
  { id: "run-3", status: "running", runnerId: "vm-control-plane" },
];

test("blocking Runs are counted by the runner that owns them", () => {
  assert.deepEqual(blockingRunCountsByRunner(RUNS), { "mac-runner-1": 2, "vm-control-plane": 1 });
  assert.deepEqual(blockingRunCountsByRunner([{ id: "run-4", status: "running", runnerId: null }]), { unassigned: 1 });
  assert.deepEqual(blockingRunCountsByRunner([]), {});
});

test("runner ids that name Object prototype members are counted as data", () => {
  const counts = blockingRunCountsByRunner([
    { id: "run-1", runnerId: "toString" },
    { id: "run-2", runnerId: "toString" },
    { id: "run-3", runnerId: "constructor" },
    { id: "run-4", runnerId: "__proto__" },
  ]);
  assert.deepEqual(counts, Object.fromEntries([["toString", 2], ["constructor", 1], ["__proto__", 1]]));
  // The map survives the JSON boundary the ledger writes it through.
  assert.deepEqual(JSON.parse(JSON.stringify(counts)), counts);
});

test("the wait budget defaults to 45 minutes and is environment-overridable", () => {
  assert.equal(DEFAULT_QUIET_WINDOW_WAIT_BUDGET_MS, 45 * 60 * 1_000);
  assert.equal(quietWindowWaitBudgetMs({}), DEFAULT_QUIET_WINDOW_WAIT_BUDGET_MS);
  assert.equal(quietWindowWaitBudgetMs({ QUIET_WINDOW_WAIT_BUDGET_MINUTES: "" }), DEFAULT_QUIET_WINDOW_WAIT_BUDGET_MS);
  assert.equal(quietWindowWaitBudgetMs({ QUIET_WINDOW_WAIT_BUDGET_MINUTES: "90" }), 90 * 60 * 1_000);
  for (const invalid of ["0", "-5", "45.5", "abc", "10000"]) {
    assert.throws(
      () => quietWindowWaitBudgetMs({ QUIET_WINDOW_WAIT_BUDGET_MINUTES: invalid }),
      (error) => error instanceof DeployFailure && error.reason === "environment-invalid",
    );
  }
});

test("the dispatch drain deadline defaults to 120 minutes and is environment-overridable", () => {
  assert.equal(DEFAULT_DISPATCH_DRAIN_DEADLINE_MS, 120 * 60 * 1_000);
  assert.equal(dispatchDrainDeadlineMs({}), DEFAULT_DISPATCH_DRAIN_DEADLINE_MS);
  assert.equal(dispatchDrainDeadlineMs({ DISPATCH_DRAIN_DEADLINE_MINUTES: "" }), DEFAULT_DISPATCH_DRAIN_DEADLINE_MS);
  assert.equal(dispatchDrainDeadlineMs({ DISPATCH_DRAIN_DEADLINE_MINUTES: "30" }), 30 * 60 * 1_000);
  for (const invalid of ["0", "-5", "45.5", "abc", "10000"]) {
    assert.throws(
      () => dispatchDrainDeadlineMs({ DISPATCH_DRAIN_DEADLINE_MINUTES: invalid }),
      (error) => error instanceof DeployFailure && error.reason === "environment-invalid",
    );
  }
});

test("a wait crossing its budget alerts once with the blocking Runs by runner", async () => {
  const { outcome, alerts } = await drivenWait({
    blockedPolls: 50,
    stepMs: 60_000,
    runs: RUNS,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].elapsedSeconds, 45 * 60);
  assert.equal(alerts[0].budgetMs, DEFAULT_QUIET_WINDOW_WAIT_BUDGET_MS);
  assert.equal(alerts[0].blockingRuns, 3);
  assert.deepEqual(alerts[0].blockingRunsByRunner, { "mac-runner-1": 2, "vm-control-plane": 1 });
  // The alert never ends the wait: the barrier is still acquired afterwards.
  assert.ok(outcome.barrier);
  assert.equal(outcome.quietWindowWait.polls, 51);
  assert.equal(outcome.quietWindowWait.peakBlockingRuns, 3);
});

test("a second budget crossing within the alert interval does not re-notify", async () => {
  const withinTheHour = await drivenWait({
    blockedPolls: 80,
    stepMs: 60_000,
    runs: RUNS,
  });
  // 80 minutes of waiting crosses the budget 35 times but stays inside one hour
  // of the first alert.
  assert.equal(withinTheHour.alerts.length, 1);
  const pastTheHour = await drivenWait({
    blockedPolls: 120,
    stepMs: 60_000,
    runs: RUNS,
  });
  assert.equal(pastTheHour.alerts.length, 2);
  assert.equal(
    pastTheHour.alerts[1].elapsedMs - pastTheHour.alerts[0].elapsedMs,
    QUIET_WINDOW_WAIT_ALERT_INTERVAL_MS,
  );
});

test("a window that opens after the budget still alerts before the wait returns", async () => {
  // Every blocked poll lands under the budget; the first quiet poll is the one
  // that reaches it, so only the success path can report the crossing.
  const { outcome, alerts } = await drivenWait({
    blockedPolls: 45,
    stepMs: 60_000,
    runs: RUNS,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].elapsedSeconds, 45 * 60);
  assert.equal(alerts[0].blockingRuns, 0);
  assert.deepEqual(alerts[0].blockingRunsByRunner, {});
  assert.equal(outcome.quietWindowWait.waitSeconds, 45 * 60);
  assert.equal(outcome.quietWindowWait.polls, 46);
});

test("an undelivered alert does not consume the alert interval", async () => {
  const { alerts } = await drivenWait({
    blockedPolls: 50,
    stepMs: 60_000,
    runs: RUNS,
    // The first delivery fails; the wait retries it on the next poll rather
    // than staying silent for the rest of the hour.
    deliver: (attempt) => (attempt === 1 ? Promise.reject(new Error("inbox-unreachable")) : { delivered: true }),
  });
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].elapsedSeconds, 45 * 60);
  assert.equal(alerts[1].elapsedSeconds, 46 * 60);
});

test("an alert that never settles does not stop the wait", async () => {
  let clock = 0;
  let polls = 0;
  const barrier = { release: async () => undefined };
  let dispatched = 0;
  const outcome = await waitForQuietWithWatchdog({
    blockingRuns: async () => (polls < 50 ? RUNS : []),
    acquireBarrier: async () => barrier,
    startWatchdog: async () => ({ release: async () => undefined }),
    wait: async () => { polls += 1; clock += 60_000; },
    now: () => clock,
    onWaitBudgetExceeded: () => {
      dispatched += 1;
      return new Promise(() => undefined);
    },
  });
  assert.equal(dispatched, 1);
  assert.equal(outcome.barrier, barrier);
  assert.equal(outcome.quietWindowWait.waitSeconds, 50 * 60);
});

test("a wait under budget alerts nobody and still measures itself", async () => {
  const { outcome, alerts, holds } = await drivenWait({
    blockedPolls: 3,
    stepMs: 60_000,
    runs: RUNS,
  });
  assert.deepEqual(alerts, []);
  assert.deepEqual(outcome.quietWindowWait, { waitSeconds: 180, polls: 4, peakBlockingRuns: 3 });
  assert.deepEqual(holds.map(({ blocking, elapsedSeconds }) => ({ blocking, elapsedSeconds })), [
    { blocking: 3, elapsedSeconds: 0 },
    { blocking: 3, elapsedSeconds: 60 },
    { blocking: 3, elapsedSeconds: 120 },
  ]);
});

test("ordinary step timeout escalates, notifies, fails, and releases the barrier", async () => {
  const execution = timeoutUpgrade({
    phase: "prepareWorkspace",
    run: async () => hangingCommand(),
  });
  const result = await execution.execute();
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "fixture-timeout");
  assert.equal(execution.state.retained, false);
  assert.equal(execution.state.released, true);
  assert.ok(execution.calls.indexOf("notify-failure") < execution.calls.indexOf("release-barrier"));
});

test("migration timeout escalates and retains the barrier through explicit clear", async () => {
  const execution = timeoutUpgrade({
    phase: "guardedMigration",
    run: async ({ barrier }) => hangingCommand({
      timeoutReason: "migration-deploy-timeout",
      onTermination: () => barrier.retainUntilEscalationCleared(),
    }),
  });
  const result = await execution.execute();
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "migration-deploy-timeout");
  assert.equal(execution.state.retained, true);
  assert.equal(execution.state.released, true);
  assert.ok(execution.calls.indexOf("escalate-migration-deploy-timeout") < execution.calls.indexOf("hold-barrier"));
  assert.ok(execution.calls.indexOf("clear-escalation") < execution.calls.indexOf("release-barrier"));
});

test("lock loss during a retained migration hold becomes the terminal deploy failure", async () => {
  const execution = timeoutUpgrade({
    phase: "guardedMigration",
    barrierHeld: false,
    run: async ({ barrier }) => hangingCommand({
      timeoutReason: "migration-deploy-timeout",
      onTermination: () => barrier.retainUntilEscalationCleared(),
    }),
  });
  const result = await execution.execute();
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "deploy-barrier-lost-during-hold");
  assert.deepEqual(
    execution.calls.filter((call) => call.startsWith("escalate-")),
    ["escalate-migration-deploy-timeout", "escalate-deploy-barrier-lost-during-hold"],
  );
  assert.equal(execution.calls.at(-1), "mark-notified");
});

test("watchdog expiry during active migration retains the barrier", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anneal-migration-watchdog-"));
  const escalationPath = join(directory, "escalated.json");
  const execution = timeoutUpgrade({
    phase: "guardedMigration",
    run: async ({ barrier }) => {
      const controller = new AbortController();
      const failure = new DeployFailure(BARRIER_TIMEOUT_REASON, "fixture-watchdog");
      const watchdog = await createBarrierWatchdog({
        timeoutMs: 500,
        escalationPath,
        escalationRecord: { outcome: "failure", reason: failure.reason, detail: failure.detail, ...revisions },
        onTimeout: () => controller.abort(),
      });
      try {
        return await hangingCommand({
          // The watchdog above is what this case proves, at 500ms. This outer
          // ceiling only catches a watchdog that never fires, so it has to
          // strictly contain the watchdog plus its cleanup on a loaded worker
          // (CONTRIBUTING.md, "Test timing on the gate worker") — otherwise the
          // parent reports a timeout the watchdog was about to resolve.
          timeoutMs: 60_000,
          signal: controller.signal,
          abortFailure: () => failure,
          onTermination: () => barrier.retainUntilEscalationCleared(),
        });
      } finally {
        await watchdog.release();
      }
    },
  });
  try {
    const result = await execution.execute();
    assert.equal(result.ok, false);
    assert.equal(result.failure.reason, BARRIER_TIMEOUT_REASON);
    assert.equal(execution.state.retained, true);
    assert.ok(execution.calls.includes("hold-barrier"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration retention does not treat escalation-write failure as operator clear", async () => {
  let allowPersistence;
  let waitStarted;
  const persistenceAllowed = new Promise((resolve) => { allowPersistence = resolve; });
  const firstWait = new Promise((resolve) => { waitStarted = resolve; });
  let waits = 0;
  let execution;
  execution = timeoutUpgrade({
    phase: "guardedMigration",
    escalationFails: true,
    wait: async () => {
      waits += 1;
      if (waits === 1) {
        waitStarted();
        await persistenceAllowed;
        execution.state.escalationExists = true;
      } else {
        execution.state.escalationExists = false;
      }
    },
    run: async ({ barrier }) => hangingCommand({
      timeoutReason: "migration-deploy-timeout",
      onTermination: () => barrier.retainUntilEscalationCleared(),
    }),
  });
  const result = execution.execute();
  await firstWait;
  assert.equal(execution.state.released, false);
  allowPersistence();
  await assert.rejects(result, /escalation-write-failed/u);
  assert.equal(execution.state.released, true);
  assert.equal(waits, 2);
});

test("latest terminal escalation replaces a watchdog precursor", () => {
  const directory = mkdtempSync(join(tmpdir(), "anneal-escalation-replace-"));
  const path = join(directory, "escalated.json");
  try {
    writeEscalationRecord({ path, record: { reason: BARRIER_TIMEOUT_REASON, detail: "precursor" } });
    writeEscalationRecord({ path, record: { reason: "terminal-failure", detail: "terminal-detail" } });
    const record = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(record.reason, "terminal-failure");
    assert.equal(record.detail, "terminal-detail");
    assert.equal(record.notificationDelivered, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("barrier watchdog independently persists an alert during a synchronous parent stall", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anneal-barrier-watchdog-"));
  const escalationPath = join(directory, "escalated.json");
  const interruption = createDeployInterruption();
  const failure = new DeployFailure(BARRIER_TIMEOUT_REASON, "budget-5ms");
  const watchdog = await createBarrierWatchdog({
    timeoutMs: 20,
    escalationPath,
    escalationRecord: { outcome: "failure", reason: failure.reason, detail: failure.detail, from: "a", to: "b" },
    onTimeout: () => { interruption.interruptWithFailure(failure); },
  });
  // The parent's event loop must stay blocked for the whole wait — that is the
  // property — so this polls the observable condition with synchronous stalls
  // instead of guessing one duration the watchdog child will finish inside.
  // Bounded so a watchdog that never persists fails the assertion below rather
  // than hanging the suite, and sized for the loaded gate worker rather than an
  // idle host (CONTRIBUTING.md, "Test timing on the gate worker").
  const stallDeadline = Date.now() + 30_000;
  const blocker = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(escalationPath) && Date.now() < stallDeadline) {
    Atomics.wait(blocker, 0, 0, 100);
  }
  try {
    assert.equal(existsSync(escalationPath), true, "watchdog child did not persist while parent was stalled");
    const record = JSON.parse(readFileSync(escalationPath, "utf8"));
    assert.equal(record.reason, BARRIER_TIMEOUT_REASON);
  } finally {
    await watchdog.release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("barrier watchdog can be cancelled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anneal-barrier-watchdog-cancel-"));
  const escalationPath = join(directory, "escalated.json");
  let cancelledFired = false;
  const cancelled = await createBarrierWatchdog({
    timeoutMs: 10_000,
    escalationPath,
    escalationRecord: { outcome: "failure", reason: BARRIER_TIMEOUT_REASON, from: "a", to: "b" },
    onTimeout: () => { cancelledFired = true; },
  });
  await cancelled.release();
  assert.equal(cancelledFired, false);
  assert.equal(existsSync(escalationPath), false);
  rmSync(directory, { recursive: true, force: true });
});

test("control-plane watchdog budgets the post-barrier target rebuild without changing runner budgets", () => {
  const serviceCount = 6;
  const runnerBudget = deployBarrierTimeoutMsForRole("runner", serviceCount);
  const controlPlaneOnlyPhases = DEPLOY_STEP_TIMEOUT_MS.databaseBackup
    + DEPLOY_STEP_TIMEOUT_MS.migrationPreflight + DEPLOY_STEP_TIMEOUT_MS.migrationDeploy
    + DEPLOY_STEP_TIMEOUT_MS.prismaClientGeneration + DEPLOY_STEP_TIMEOUT_MS.canonicalPromptSync;
  assert.ok(deployBarrierTimeoutMsForRole("control-plane", serviceCount)
    >= runnerBudget + controlPlaneOnlyPhases + DEPLOY_STEP_TIMEOUT_MS.releaseArtifactBuild + 97_000);
});

test("watchdog target update preserves the deadline and persists the refreshed target", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "anneal-watchdog-retarget-"));
  const escalationPath = join(directory, "escalated.json");
  let timedOut;
  const expired = new Promise((resolve) => { timedOut = resolve; });
  const watchdog = await createBarrierWatchdog({
    timeoutMs: 500,
    escalationPath,
    escalationRecord: { outcome: "failure", reason: BARRIER_TIMEOUT_REASON, ...revisions },
    onTimeout: timedOut,
  });
  try {
    await watchdog.updateEscalationRecord({ outcome: "failure", reason: BARRIER_TIMEOUT_REASON,
      from: revisions.from, to: "c".repeat(40) });
    await expired;
    assert.equal(JSON.parse(readFileSync(escalationPath, "utf8")).to, "c".repeat(40));
  } finally {
    await watchdog.release();
    rmSync(directory, { recursive: true, force: true });
  }
});
