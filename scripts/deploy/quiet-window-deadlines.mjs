import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DeployFailure } from "./quiet-window-lib.mjs";
import { resolveServiceInventory } from "./service-inventory.mjs";
import { deployPhasesForRole } from "./deploy-phases.mjs";

const seconds = (value) => value * 1_000;
const minutes = (value) => seconds(value * 60);

/** Budgets follow the deploy step, not the executable. Artifact construction
 * normally takes 8-10 minutes; migration preflight is normally seconds and a
 * real migration plus backfill was observed at 75 seconds. */
export const DEPLOY_STEP_TIMEOUT_MS = Object.freeze({
  remoteMainRead: seconds(30),
  sourceCommitProbe: seconds(30),
  serviceInspection: seconds(15),
  releaseArtifactBuild: minutes(15),
  migrationPreflight: minutes(2),
  migrationDeploy: minutes(5),
  databaseBackup: minutes(5),
  prismaClientGeneration: minutes(3),
  canonicalPromptSync: minutes(3),
  serviceRestart: seconds(30),
  previousServiceRestore: seconds(30),
});

/** The budgets below size one deployment's service sweep. The caller that
 * knows its own inventory passes its service count to
 * deployBarrierTimeoutMsForRole; this default sizes the exported constants. */
const DEFAULT_SERVICE_COUNT = resolveServiceInventory().labels.length;
const serviceSweepBudget = DEFAULT_SERVICE_COUNT * DEPLOY_STEP_TIMEOUT_MS.serviceInspection;
const serviceRestartBudget = DEFAULT_SERVICE_COUNT * DEPLOY_STEP_TIMEOUT_MS.serviceRestart;

/** Successful work that can run while the barrier is held. Synchronous phases
 * are covered by the separate watchdog process and by the explicit margin. */
export const DEPLOY_BARRIER_PHASE_TIMEOUT_MS = Object.freeze({
  "prepare-operation-workspace": 0,
  "verify-stable-service-paths": serviceSweepBudget,
  backup: DEPLOY_STEP_TIMEOUT_MS.databaseBackup,
  "guarded-migration": DEPLOY_STEP_TIMEOUT_MS.migrationPreflight + DEPLOY_STEP_TIMEOUT_MS.migrationDeploy,
  "generate-prisma-client": DEPLOY_STEP_TIMEOUT_MS.prismaClientGeneration,
  "canonical-prompt-sync": DEPLOY_STEP_TIMEOUT_MS.canonicalPromptSync,
  "verify-runtime-prisma-client": 0,
  "assert-quiet-before-restart": 0,
  "verify-control-plane-target": 0,
  "publish-build": 0,
  "restart-services": serviceRestartBudget,
  "verify-services": serviceSweepBudget,
});
// Control-plane refresh adds a builder under the held barrier. Two minutes
// covers the three 30-second remote reads and their 2/5-second retry delays.
// Runner hosts retain their existing target check and watchdog budget.
export const DEPLOY_BARRIER_TARGET_REFRESH_TIMEOUT_MS = DEPLOY_STEP_TIMEOUT_MS.releaseArtifactBuild + minutes(2);
export const DEPLOY_BARRIER_BUDGETED_WORK_MS = Object.values(DEPLOY_BARRIER_PHASE_TIMEOUT_MS)
  .reduce((total, timeoutMs) => total + timeoutMs, DEPLOY_BARRIER_TARGET_REFRESH_TIMEOUT_MS);
export const DEPLOY_BARRIER_RECOVERY_BUDGET_MS = DEFAULT_SERVICE_COUNT
  * DEPLOY_STEP_TIMEOUT_MS.previousServiceRestore;
export const DEPLOY_BARRIER_WATCHDOG_MARGIN_MS = minutes(5);
export const DEPLOY_BARRIER_TIMEOUT_MS = DEPLOY_BARRIER_BUDGETED_WORK_MS
  + DEPLOY_BARRIER_RECOVERY_BUDGET_MS
  + DEPLOY_BARRIER_WATCHDOG_MARGIN_MS;

export const deployBarrierTimeoutMsForRole = (role, serviceCount = DEFAULT_SERVICE_COUNT) => {
  if (!Number.isSafeInteger(serviceCount) || serviceCount < 1) throw new TypeError("deploy-service-count-invalid");
  const phaseTimeouts = {
    ...DEPLOY_BARRIER_PHASE_TIMEOUT_MS,
    "verify-stable-service-paths": serviceCount * DEPLOY_STEP_TIMEOUT_MS.serviceInspection,
    "restart-services": serviceCount * DEPLOY_STEP_TIMEOUT_MS.serviceRestart,
    "verify-services": serviceCount * DEPLOY_STEP_TIMEOUT_MS.serviceInspection,
  };
  const budgetedWork = deployPhasesForRole(role)
    .filter(({ scope }) => scope === "upgrade")
    .reduce((total, { name }) => total + (phaseTimeouts[name] ?? 0), 0);
  return budgetedWork
    + (role === "control-plane" ? DEPLOY_BARRIER_TARGET_REFRESH_TIMEOUT_MS : 0)
    + serviceCount * DEPLOY_STEP_TIMEOUT_MS.previousServiceRestore
    + DEPLOY_BARRIER_WATCHDOG_MARGIN_MS;
};
export const MIGRATION_DEPLOY_TIMEOUT_REASON = "migration-deploy-timeout";

/** How long the deploy may wait for a quiet window before the operator is told.
 * The wait itself has no deadline: the alert is informational and the deploy
 * keeps waiting for the blocking Runs to finish. */
export const DEFAULT_QUIET_WINDOW_WAIT_BUDGET_MS = minutes(45);
export const QUIET_WINDOW_WAIT_ALERT_INTERVAL_MS = minutes(60);
export const QUIET_WINDOW_WAIT_EXCEEDED_REASON = "quiet-window-wait-exceeded";

export const quietWindowWaitBudgetMs = (environment = process.env) => {
  const configured = environment?.QUIET_WINDOW_WAIT_BUDGET_MINUTES;
  if (configured === undefined || configured === "") return DEFAULT_QUIET_WINDOW_WAIT_BUDGET_MS;
  const text = String(configured);
  if (!/^[0-9]+$/u.test(text) || Number(text) < 1 || Number(text) > 1440) {
    throw new DeployFailure("environment-invalid", `QUIET_WINDOW_WAIT_BUDGET_MINUTES-${text}`);
  }
  return minutes(Number(text));
};

/** How long a dispatch drain opened by an over-budget wait stays in force
 * without the deploy that opened it. The deploy deletes its own row on every
 * exit path; this deadline only bounds the row a killed deploy process leaves
 * behind, so it is generous compared with a deploy and short compared with a
 * working day. */
export const DEFAULT_DISPATCH_DRAIN_DEADLINE_MS = minutes(120);

export const dispatchDrainDeadlineMs = (environment = process.env) => {
  const configured = environment?.DISPATCH_DRAIN_DEADLINE_MINUTES;
  if (configured === undefined || configured === "") return DEFAULT_DISPATCH_DRAIN_DEADLINE_MS;
  const text = String(configured);
  if (!/^[0-9]+$/u.test(text) || Number(text) < 1 || Number(text) > 1440) {
    throw new DeployFailure("environment-invalid", `DISPATCH_DRAIN_DEADLINE_MINUTES-${text}`);
  }
  return minutes(Number(text));
};

/** Blocking Runs counted by the runner that owns them. The control-plane
 * quiet-window query is database-wide, so these counts name runner-only hosts
 * as well as the deploying host. */
export const blockingRunCountsByRunner = (runs) => {
  // A runner id is an arbitrary string, so the counts accumulate in a Map:
  // ids that name Object prototype members ("toString", "__proto__") are data
  // here, not inherited properties that would corrupt the tally.
  const counts = new Map();
  for (const run of runs ?? []) {
    const runner = typeof run?.runnerId === "string" && run.runnerId !== "" ? run.runnerId : "unassigned";
    counts.set(runner, (counts.get(runner) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
};

export const BARRIER_TIMEOUT_REASON = "deploy-barrier-timeout";

export const waitForEscalationClear = async ({
  escalationExists,
  verifyBarrier,
  wait,
  onHold = () => undefined,
  onPersistencePending = () => undefined,
  onCleared = () => undefined,
}) => {
  onHold();
  let persistenceObserved = false;
  let persistencePendingReported = false;
  while (true) {
    if (!await verifyBarrier()) {
      throw new DeployFailure("deploy-barrier-lost-during-hold", "exclusive-session-lock-not-held");
    }
    const exists = escalationExists();
    if (exists) persistenceObserved = true;
    else if (persistenceObserved) break;
    else if (!persistencePendingReported) {
      persistencePendingReported = true;
      onPersistencePending();
    }
    await wait();
  }
  onCleared();
};

/** Start barrier observation as soon as the lock is acquired, before the
 * second blocking-runs query closes the acquisition race. The wait is measured
 * so the completed attempt can record its distribution, and a wait that crosses
 * its budget alerts the operator at most once per alert interval while the loop
 * keeps waiting. */
export const waitForQuietWithWatchdog = async ({
  blockingRuns,
  acquireBarrier,
  startWatchdog,
  wait,
  now = () => Date.now(),
  waitBudgetMs = DEFAULT_QUIET_WINDOW_WAIT_BUDGET_MS,
  alertIntervalMs = QUIET_WINDOW_WAIT_ALERT_INTERVAL_MS,
  onWaitBudgetExceeded = () => undefined,
  onBlockingRuns = () => undefined,
  onBarrierContended = () => undefined,
  onRacedBlockingRuns = () => undefined,
  /** A naturally open window may be admitted before the cadence floor. If
   * blockers appear before its barrier is obtained, the tick must coalesce
   * instead of entering the wait budget and dispatch drain. */
  allowWaiting = () => true,
}) => {
  const startedAt = now();
  let polls = 0;
  let peakBlockingRuns = 0;
  let lastAlertElapsedMs = null;
  let alertInFlight = false;
  const elapsedMs = () => Math.max(0, now() - startedAt);
  const toSeconds = (milliseconds) => Math.round(milliseconds / 1_000);
  const observe = (runs) => {
    peakBlockingRuns = Math.max(peakBlockingRuns, runs.length);
    const elapsed = elapsedMs();
    return {
      elapsedMs: elapsed,
      elapsedSeconds: toSeconds(elapsed),
      polls,
      peakBlockingRuns,
      blockingRuns: runs.length,
    };
  };
  /** The alert is informational, so it is delivered beside the loop rather
   * than inside it: a notifier that never settles must not stop the polling
   * that acquires the quiet window. Only a delivered alert consumes the
   * interval; an undelivered one is retried on the next poll. */
  const alertIfOverBudget = (runs) => {
    const elapsed = elapsedMs();
    if (elapsed < waitBudgetMs) return;
    if (alertInFlight) return;
    if (lastAlertElapsedMs !== null && elapsed - lastAlertElapsedMs < alertIntervalMs) return;
    alertInFlight = true;
    const event = {
      ...observe(runs),
      budgetMs: waitBudgetMs,
      blockingRunsByRunner: blockingRunCountsByRunner(runs),
    };
    Promise.resolve()
      .then(() => onWaitBudgetExceeded(event))
      .then(
        (result) => { if (result?.delivered !== false) lastAlertElapsedMs = elapsed; },
        () => undefined,
      )
      .finally(() => { alertInFlight = false; });
  };
  const completedWait = () => Object.freeze({
    waitSeconds: toSeconds(elapsedMs()),
    polls,
    peakBlockingRuns,
  });
  while (true) {
    polls += 1;
    const before = await blockingRuns();
    if (before.length > 0) {
      const progress = observe(before);
      if (!await allowWaiting({ stage: "before-barrier", runs: before, progress })) {
        return { skip: "coalesced", quietWindowWait: completedWait() };
      }
      onBlockingRuns(before, progress);
      alertIfOverBudget(before);
      await wait();
      continue;
    }
    const barrier = await acquireBarrier();
    if (barrier === null) {
      const progress = observe([]);
      if (!await allowWaiting({ stage: "barrier-contended", runs: [], progress })) {
        return { skip: "coalesced", quietWindowWait: completedWait() };
      }
      onBarrierContended(progress);
      alertIfOverBudget([]);
      await wait();
      continue;
    }
    let watchdog;
    let raced = [];
    try {
      watchdog = await startWatchdog();
      const after = await blockingRuns();
      // The window can open after the budget has already passed, so the
      // crossing is reported here too: a completed over-budget wait is never
      // silent just because the last poll succeeded.
      if (after.length === 0) {
        if (await allowWaiting({ stage: "quiet", runs: [], progress: observe([]) })) alertIfOverBudget([]);
        return { barrier, watchdog, quietWindowWait: completedWait() };
      }
      raced = after;
      if (!await allowWaiting({ stage: "after-barrier", runs: raced, progress: observe(raced) })) {
        await watchdog.release();
        await barrier.release();
        return { skip: "coalesced", quietWindowWait: completedWait() };
      }
      await watchdog.release();
      await barrier.release();
      onRacedBlockingRuns(after, observe(after));
    } catch (error) {
      await watchdog?.release().catch(() => undefined);
      await barrier.release().catch(() => undefined);
      throw error;
    }
    alertIfOverBudget(raced);
    await wait();
  }
};

/** The barrier is the outage boundary, so a separately scheduled child owns
 * its deadline and persists the alert even if the deploy event loop blocks.
 * The callback aborts the current deployment through its existing path. */
export const createBarrierWatchdog = async ({
  timeoutMs = DEPLOY_BARRIER_TIMEOUT_MS,
  escalationPath,
  escalationRecord,
  onTimeout,
  onError = () => undefined,
  spawnImpl = spawn,
}) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("deploy-barrier-timeout-invalid");
  }
  if (typeof escalationPath !== "string" || escalationPath === "") {
    throw new TypeError("deploy-barrier-escalation-path-required");
  }
  if (typeof escalationRecord !== "object" || escalationRecord === null) {
    throw new TypeError("deploy-barrier-escalation-record-required");
  }
  let released = false;
  let exited = false;
  let timeoutReported = false;
  const child = spawnImpl(process.execPath, [
    fileURLToPath(new URL("./quiet-window-watchdog-worker.mjs", import.meta.url)),
    String(Date.now() + timeoutMs),
    escalationPath,
    JSON.stringify(escalationRecord),
  ], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  let acceptReady;
  let rejectReady;
  const ready = new Promise((accept, reject) => {
    acceptReady = accept;
    rejectReady = reject;
  });
  let acceptExit;
  const exit = new Promise((accept) => { acceptExit = accept; });
  child.once("error", (error) => {
    onError(error);
    rejectReady(new DeployFailure("deploy-barrier-watchdog-unavailable", error.name));
  });
  child.once("close", (code, signal) => {
    exited = true;
    acceptExit();
    if (released || timeoutReported) return;
    const error = new DeployFailure(
      "deploy-barrier-watchdog-unavailable",
      `exit-${code ?? "signal"}${signal ? `-${signal}` : ""}`,
    );
    onError(error);
    rejectReady(error);
  });
  child.on("message", (message) => {
    if (message?.type === "ready") acceptReady();
    if (message?.type === "error") onError(new Error(`barrier-watchdog-${message.detail}`));
    if (message?.type === "timeout" && !released) {
      timeoutReported = true;
      Promise.resolve(onTimeout()).catch(onError);
    }
  });
  await ready;
  return Object.freeze({
    // Acknowledge the new record before artifact construction can block this
    // process. The independent child's original deadline is never restarted.
    updateEscalationRecord: (record) => new Promise((resolve, reject) => {
      if (released || exited || timeoutReported) {
        reject(new DeployFailure("deploy-barrier-watchdog-unavailable", "target-update-after-exit"));
        return;
      }
      const cleanup = () => {
        child.off("message", updated);
        child.off("close", closed);
      };
      const updated = (message) => {
        if (message?.type !== "record-updated") return;
        cleanup();
        resolve();
      };
      const closed = () => {
        cleanup();
        reject(new DeployFailure("deploy-barrier-watchdog-unavailable", "target-update-unacknowledged"));
      };
      child.on("message", updated);
      child.once("close", closed);
      child.send({ type: "update-record", record }, (error) => {
        if (!error) return;
        cleanup();
        reject(new DeployFailure("deploy-barrier-watchdog-unavailable", "target-update-failed"));
      });
    }),
    release: async () => {
      if (released) return;
      released = true;
      if (!exited) child.kill("SIGTERM");
      await exit;
    },
  });
};
