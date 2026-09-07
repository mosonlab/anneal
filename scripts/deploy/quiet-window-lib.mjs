import { deployPhasesForRole, upgradeDeployPhasesForRole } from "./deploy-phases.mjs";
import { DEFAULT_DEPLOY_ROLE, DEPLOY_ROLES, resolveDeployRole } from "./deploy-role.mjs";

export { DEFAULT_DEPLOY_ROLE, DEPLOY_ROLES, resolveDeployRole };

export const BLOCKING_RUN_STATUSES = Object.freeze(["claimed", "provisioning", "running"]);

export class DeployFailure extends Error {
  constructor(reason, detail = "") {
    super(detail === "" ? reason : `${reason}: ${detail}`);
    this.name = "DeployFailure";
    this.reason = reason;
    this.detail = detail;
  }
}

/** A record-only ledger write failed. Keep this as a concrete DeployFailure so
 * unrelated errors with a coincidental `reason` property are not reclassified. */
export class DeploymentLedgerError extends DeployFailure {
  constructor(operation, cause) {
    const causeCode = typeof cause?.code === "string"
      ? cause.code
      : typeof cause?.name === "string"
        ? cause.name
        : "filesystem-write-failed";
    super("deployment-ledger-write-failed", `${operation}-${causeCode}`);
    this.name = "DeploymentLedgerError";
    this.cause = cause;
  }
}

export const quietWindowIsOpen = (runs) =>
  runs.every((run) => !BLOCKING_RUN_STATUSES.includes(String(run.status).toLowerCase()));

const DEPLOYED_API_PACKAGE_NAMES = new Set(["@anneal/api", "@agentos/api"]);

/** Accept the one live rename seam while still requiring a clean exact commit. */
export const deployedBuildStampRefusal = (stamp) => {
  if (typeof stamp?.commit !== "string" || !/^[0-9a-f]{40}$/u.test(stamp.commit)) return "invalid-commit";
  if (stamp.dirty !== false) return "dirty-build";
  if (!DEPLOYED_API_PACKAGE_NAMES.has(stamp.packageName)) return "unexpected-package-name";
  return null;
};

export const shouldPersistFailure = ({ dryRun, reason, upgradeStarted = true }) =>
  !dryRun && reason !== "usage" && (reason !== "deploy-interrupted" || upgradeStarted);

export const failureOf = (error) => error instanceof DeployFailure
  ? error
  : new DeployFailure("unexpected-error", error instanceof Error ? error.message : String(error));

const resourceReleaseFailureOf = (error) => {
  if (!(error instanceof AggregateError)) return failureOf(error);
  const deployFailure = [...error.errors].find((failure) => failure instanceof DeployFailure);
  return deployFailure ?? failureOf(error);
};

const DEPLOY_MODE_ARGUMENTS = Object.freeze(["--dry-run", "--clear-escalation", "--prune-history"]);

/** The requested mode, read from argv exactly once per process. */
export const parseDeployArguments = (args) => {
  const allowed = new Set(DEPLOY_MODE_ARGUMENTS);
  const unknown = args.find((argument) => !allowed.has(argument));
  if (unknown) throw new DeployFailure("usage", `unknown-argument-${unknown}`);
  const modes = DEPLOY_MODE_ARGUMENTS.filter((mode) => args.includes(mode));
  if (modes.length > 1) throw new DeployFailure("usage", "modes-are-mutually-exclusive");
  return modes.length === 0 ? "upgrade" : modes[0].slice("--".length);
};

/** A commit-scoped escalation latches its own commit, not the job. Read what
 * main points at now: a different commit is attempted, and the supersession is
 * recorded as an additive ledger fact on the attempt that follows. `null`
 * means the escalation still blocks this invocation.
 *
 * A target read that fails here refuses without persisting a new failure: it
 * proves nothing about main having moved, and persisting would replace the
 * latched marker this decision is reading. */
const supersedeLatchedCommit = async (startup, supersedable) => {
  let targetCommit;
  try {
    targetCommit = await startup.readRemoteMain();
  } catch (error) {
    startup.log(`STOP escalation-active target-unreadable reason=${failureOf(error).reason}`);
    return null;
  }
  if (targetCommit === supersedable.failedCommit) {
    startup.log(`STOP escalation-active commit-unchanged commit=${targetCommit}`);
    return null;
  }
  startup.log(`SUPERSEDE escalation reason=${supersedable.reason} failed-commit=${supersedable.failedCommit} target=${targetCommit}`);
  return {
    targetCommit,
    fact: supersedable,
  };
};

/** Decide the whole invocation before any deployment host exists: the mode,
 * the commit it targets, the retryable escalation the run may self-clear, and
 * the one process lock a locked mode holds until its resources are released.
 * The environment, the binaries, the escalation check and the lock are each
 * reached once per process. An invocation carrying `exitCode` is already
 * finished and opens no attempt; otherwise it carries the lock it acquired,
 * and its caller owns releasing it. */
export const decideInvocation = async (startup, mode) => {
  if (!Number.isSafeInteger(startup.pollIntervalMs) || startup.pollIntervalMs < 1_000) {
    throw new DeployFailure("environment-invalid", "QUIET_WINDOW_POLL_SECONDS-must-be-a-positive-integer");
  }
  if (mode === "clear-escalation") {
    // Clearing an absent marker stays exit 0: it is idempotent, not an error.
    startup.clearEscalation();
    return { mode, exitCode: 0 };
  }
  // Retention runs against the filesystem alone and must stay usable while the
  // operator configuration the other modes require is being repaired.
  if (mode !== "prune-history") await startup.loadEnvironment();
  startup.loadBinaries();
  if (mode === "dry-run") {
    return { mode, targetCommit: await startup.readRemoteMain(), lock: null, retryEscalation: null };
  }
  const lock = await startup.acquireLock();
  if (lock === null) {
    // A held lock is an observable skip, not a second failed attempt: the
    // owner is still responsible for the eventual outcome.
    startup.log("SKIP concurrent-run lock-held");
    return { mode, exitCode: 0 };
  }
  try {
    if (lock.recovered) {
      throw new DeployFailure("stale-deploy-owner-recovered", `pid-${lock.recovered.pid ?? "unknown"}`);
    }
    if (mode === "prune-history") return { mode, lock, retryEscalation: null };
    const admitTarget = async ({ targetCommit, retryEscalation, supersededEscalation }) => {
      if (typeof startup.evaluateCadence !== "function") {
        return {
          mode,
          targetCommit,
          lock,
          retryEscalation,
          supersededEscalation,
        };
      }
      let cadence;
      try {
        cadence = await startup.evaluateCadence(targetCommit);
      } catch (error) {
        await startup.persistFailure(failureOf(error));
        await lock.release();
        return { mode, exitCode: 1 };
      }
      if (cadence?.coalesced) {
        startup.log(`NOOP coalescing next-eligible=${cadence.nextEligibleAt}`);
        await lock.release();
        return { mode, exitCode: 0 };
      }
      return {
        mode,
        targetCommit,
        lock,
        retryEscalation,
        supersededEscalation,
        ...(cadence === undefined ? {} : { cadence }),
      };
    };
    const escalation = await startup.checkEscalation();
    if (escalation.active) {
      const superseded = escalation.supersedable
        ? await supersedeLatchedCommit(startup, escalation.supersedable)
        : null;
      if (superseded === null) {
        await lock.release();
        return { mode, exitCode: 2 };
      }
      // The marker stays on disk as history; the new commit is a new question.
      return await admitTarget({
        targetCommit: superseded.targetCommit,
        retryEscalation: null,
        supersededEscalation: superseded.fact,
      });
    }
    let targetCommit;
    try {
      targetCommit = await startup.readRemoteMain();
    } catch (error) {
      await startup.persistFailure(failureOf(error));
      await lock.release();
      return { mode, exitCode: 1 };
    }
    return await admitTarget({
      targetCommit,
      retryEscalation: escalation.retryEscalation ?? null,
      supersededEscalation: null,
    });
  } catch (error) {
    await lock.release();
    throw error;
  }
};

/** Execute the full deployment attempt through the host seam. Every phase
 * receives the attempt and establishes facts for the phases that follow. */
export const executeUpgrade = async (host, attempt, deployRole = DEFAULT_DEPLOY_ROLE) => {
  let schemaAdvanced = false;
  let activationAttempted = false;
  let activationOutcomeProven = false;
  let upgradeStarted = false;
  const ledgerError = (operation, error) => error instanceof DeploymentLedgerError
    ? error
    : new DeploymentLedgerError(operation, error);
  const recordLedger = async (state, metadata = {}) => {
    const ledger = attempt.fact("ledger");
    if (!ledger) throw new TypeError("deployment-attempt-fact-missing:ledger");
    try {
      const record = attempt.ledgerMetadata(metadata);
      if (state === "STARTED" && typeof ledger.start === "function") await ledger.start(record);
      else if (typeof ledger.record === "function") await ledger.record(state, record);
      else throw new TypeError("deployment-ledger-record-missing");
    } catch (error) {
      throw ledgerError("record", error);
    }
  };
  /** A retryable escalation is kept on disk until the whole attempt (or a
   * deliberate already-deployed no-op) succeeds. The production host owns the
   * concrete marker/notification implementation; keeping this hook optional
   * preserves the test host seam and other callers. */
  const completeSuccessfulAttempt = async () => {
    await host.selfClearEscalation?.(attempt);
  };
  const handleFailure = async (error) => {
    const failure = failureOf(error);
    let terminalLedgerFailure = null;
    const ledger = attempt.fact("ledger");
    if (ledger && failure.reason !== "deployment-ledger-write-failed") {
      const terminalState = schemaAdvanced && activationAttempted && !activationOutcomeProven
        ? "MANUAL_RECOVERY"
        : "FAILED";
      try {
        await recordLedger(terminalState, { reasonCode: failure.reason });
      } catch (ledgerFailure) {
        terminalLedgerFailure = failureOf(ledgerFailure);
        host.log?.(`STOP ${terminalLedgerFailure.reason}${terminalLedgerFailure.detail ? ` detail=${terminalLedgerFailure.detail}` : ""}; original=${failure.reason}`);
      }
    } else if (failure.reason === "deployment-ledger-write-failed") {
      host.log?.(`STOP ${failure.reason}${failure.detail ? ` detail=${failure.detail}` : ""}`);
    }
    const revisions = attempt.fact("revisions") ?? { from: "unknown", to: attempt.targetCommit };
    const record = {
      outcome: "failure", reason: failure.reason, detail: failure.detail, ...revisions,
      ...(activationAttempted && !activationOutcomeProven ? { activationOutcomeProven: false } : {}),
    };
    if (shouldPersistFailure({ dryRun: false, reason: failure.reason, upgradeStarted })) {
      await host.escalate(record);
      try {
        await host.notify(record);
        await host.markEscalationNotified?.();
      } catch (notificationError) {
        host.log?.(`STOP inbox-notification-pending reason=${failure.reason}`);
      }
    } else {
      host.log?.(`STOP ${failure.reason}${failure.detail ? ` detail=${failure.detail}` : ""}; no-upgrade-started`);
    }
    return {
      ok: false,
      failure,
      ...(terminalLedgerFailure ? { ledgerFailure: terminalLedgerFailure } : {}),
    };
  };
  try {
    let publicationReady = false;
    try {
      for (const phase of deployPhasesForRole(deployRole)) {
        if (phase.scope === "upgrade") upgradeStarted = true;
        if (phase.hostMethod === "publishBuild") activationAttempted = true;
        let facts;
        try {
          facts = await host[phase.hostMethod](attempt);
        } catch (error) {
          if (phase.hostMethod === "publishBuild"
            && error instanceof DeployFailure
            && ["build-swap-failed", "release-pointer-activation-failed"].includes(error.reason)) {
            activationOutcomeProven = true;
          }
          throw error;
        }
        attempt.establish(facts);
        if (phase.hostMethod === "guardedMigration") schemaAdvanced = true;
        if (phase.hostMethod === "publishBuild") {
          publicationReady = attempt.fact("publication") !== undefined;
          activationOutcomeProven = publicationReady;
        }
        if (phase.ledgerState !== null) await recordLedger(phase.ledgerState);
        if (attempt.fact("skip")) {
          const skip = attempt.fact("skip");
          if (skip === "already-deployed") await completeSuccessfulAttempt();
          return { ok: true, skipped: skip };
        }
      }
      await recordLedger("SUCCEEDED");
      await host.notify({ outcome: "success", reason: "deployed", ...attempt.requireFact("revisions") });
      await completeSuccessfulAttempt();
    } catch (error) {
      if (publicationReady) {
        try {
          const rollbackPointerOutcome = await attempt.requireFact("publication").rollback();
          if (rollbackPointerOutcome !== null && rollbackPointerOutcome !== undefined) {
            const durableOutcome = typeof rollbackPointerOutcome === "string"
              ? rollbackPointerOutcome
              : rollbackPointerOutcome.operation && rollbackPointerOutcome.oldTarget && rollbackPointerOutcome.newTarget
                ? `${rollbackPointerOutcome.operation}:${rollbackPointerOutcome.oldTarget}->${rollbackPointerOutcome.newTarget}`
                : String(rollbackPointerOutcome.outcome ?? rollbackPointerOutcome);
            attempt.establish({ rollbackPointerOutcome: durableOutcome });
          }
          await host.restorePreviousServices(attempt);
          activationOutcomeProven = true;
        } catch (recoveryError) {
          activationOutcomeProven = false;
          throw recoveryError;
        }
      }
      throw error;
    }
    return { ok: true };
  } catch (error) {
    return await handleFailure(error);
  } finally {
    try {
      await attempt.release();
    } catch (error) {
      return await handleFailure(resourceReleaseFailureOf(error));
    }
  }
};

/** Dry-run reads the deployment host every upgrade uses, calling only the
 * methods that establish no facts and mutate nothing. */
export const dryRunDecision = async (host, attempt, deployRole = DEFAULT_DEPLOY_ROLE) => {
  const backupPromise = deployRole === DEFAULT_DEPLOY_ROLE
    ? host.backupState()
    : Promise.resolve({ ok: true, mode: "skipped" });
  const [{ revisions }, runs, artifact, services, backup] = await Promise.all([
    host.readRevisions(attempt),
    host.blockingRuns(),
    host.artifactState(attempt),
    host.serviceState(),
    backupPromise,
  ]);
  const quiet = quietWindowIsOpen(runs);
  const lines = [
    `DRY-RUN revisions from=${revisions.from} target=${revisions.to}`,
    `DRY-RUN quiet-window=${quiet ? "open" : "holding"} blockers=${runs.length}`,
    `DRY-RUN artifact=${artifact.ok ? "ready" : "not-ready"}${artifact.releaseName ? ` release=${artifact.releaseName}` : ""}${artifact.reason ? ` reason=${artifact.reason}` : ""}`,
    `DRY-RUN services=${services.ok ? "ready" : "not-ready"}`,
    `DRY-RUN backup=${backup.ok ? "ready" : "not-ready"} mode=${backup.mode}${backup.reason ? ` reason=${backup.reason}` : ""}`,
  ];
  for (const phase of upgradeDeployPhasesForRole(deployRole)) lines.push(`DRY-RUN plan step=${phase.name} mutation=skipped`);
  return { quiet, revisions, runs, artifact, services, backup, lines };
};
