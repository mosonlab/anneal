import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { DeploymentLedgerError, DeployFailure } from "./quiet-window-lib.mjs";

export const DEPLOYMENT_LEDGER_SCHEMA_VERSION = 1;
export const DEPLOYMENT_LEDGER_RETENTION_COUNT = 14;
export const DEPLOYMENT_LEDGER_STATES = Object.freeze([
  "STARTED",
  "ARTIFACT_PREPARED",
  "ARTIFACT_VERIFIED",
  "QUIET_WINDOW_WAIT_EXCEEDED",
  "BACKED_UP",
  "SCHEMA_ADVANCED",
  "ACTIVATED",
  "VERIFIED",
  "SUCCEEDED",
  "FAILED",
  "MANUAL_RECOVERY",
]);

const LEDGER_STATE_SET = new Set(DEPLOYMENT_LEDGER_STATES);
const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "MANUAL_RECOVERY"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_VERIFICATION_ENTRIES = 128;
const MAX_BLOCKING_RUNNER_ENTRIES = 128;
const SECRET_TEXT = /(DATABASE_URL|(?:API|AUTH|ACCESS|REFRESH|PRIVATE)[_-]?(?:KEY|TOKEN|SECRET)|PASSWORD|\.env|(?:gh[pousr]_\w+)|(?:xox[bap]-[A-Za-z0-9-]+)|(?:sk-[A-Za-z0-9_-]+)|(?:Bearer\s+\S+)|(?:postgres(?:ql)?:\/\/)|(?:https?:\/\/[^/\s]+:[^@\s]+@))/iu;

const invalid = (detail) => {
  throw new DeployFailure("deployment-ledger-invalid", detail);
};

const safeText = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  const text = [...String(value)]
    .filter((character) => {
      const code = character.codePointAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim();
  if (text.length === 0) return fallback;
  if (SECRET_TEXT.test(text)) return "[redacted]";
  return text.slice(0, 512);
};

const safeTargetCommit = (value, fallback = "unknown") => safeText(value, fallback);

const safeBackupIdentity = (value) => {
  if (value === null || value === undefined) return null;
  const text = safeText(value);
  if (!text) return null;
  const name = basename(text);
  return name === "." || name === ".." || name.includes("/") ? null : name;
};

/** Store the immutable release's directory identity, never a caller-owned
 * path. Release trees are named by their commit and content digest; retaining
 * that final component is enough to identify the tree while avoiding host
 * layout details in the durable ledger. */
const safeReleaseDirectoryIdentity = (value) => {
  if (value === null || value === undefined) return null;
  const text = safeText(value);
  if (!text) return null;
  const name = basename(text);
  return name === "." || name === ".." || name.includes("/") || name.includes("\\") ? null : name;
};

const safePointerTarget = (value) => safeText(value);

const safeRollbackPointerOutcome = (value) => safeText(value);

const safeMigrationTail = (value) => {
  if (value === null || value === undefined) return null;
  return safeText(value);
};

const safeBuildStamp = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const packageName = safeText(value.packageName);
  const commit = safeText(value.commit);
  const dirty = value.dirty === true ? true : value.dirty === false ? false : null;
  if (packageName === null && commit === null && dirty === null) return null;
  return { packageName, commit, dirty };
};

const safeIdentifierList = (value) => {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => safeText(entry)).filter((entry) => entry !== null).slice(0, MAX_VERIFICATION_ENTRIES);
};

const safeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Blocking Runs by runner id at the moment a quiet-window wait crossed its
 * budget. The control-plane query is database-wide, so the map names
 * runner-only hosts as well as the deploying host. Runner ids are arbitrary
 * strings, so the map is built through a Map and materialized as own data
 * properties: an id naming an Object prototype member is a key, not a
 * lookup that would drop or corrupt its count. */
const safeBlockingRunsByRunner = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const counts = new Map();
  for (const [runner, total] of Object.entries(value).slice(0, MAX_BLOCKING_RUNNER_ENTRIES)) {
    const id = safeText(runner);
    const count = safeNonNegativeInteger(total);
    if (id !== null && count !== null) counts.set(id, count);
  }
  return counts.size === 0 ? null : Object.fromEntries(counts);
};

/** What the post-restart verification actually proved: the units it sampled,
 * the local runners it saw re-registered, and how long everything stayed
 * green. Recorded so a green deploy is auditable after the fact. */
const safeServiceVerification = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const unitsChecked = safeIdentifierList(value.unitsChecked);
  const runnersRegistered = safeIdentifierList(value.runnersRegistered);
  const observationWindowMs = safeNonNegativeInteger(value.observationWindowMs);
  const observedForMs = safeNonNegativeInteger(value.observedForMs);
  if (unitsChecked === null && runnersRegistered === null
      && observationWindowMs === null && observedForMs === null) {
    return null;
  }
  return {
    units_checked: unitsChecked ?? [],
    runners_registered: runnersRegistered ?? [],
    observation_window_ms: observationWindowMs,
    observed_for_ms: observedForMs,
  };
};

const safeReasonCode = (value) => safeText(value, "unknown-failure");

/** The escalation this deploy superseded: the commit that latched, why it
 * latched, and when. Recorded, never acted on — the marker itself is retained
 * for the operator. */
const safeSupersededEscalation = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const failedCommit = safeText(value.failedCommit);
  const reason = safeText(value.reason);
  if (failedCommit === null || reason === null) return null;
  return { failed_commit: failedCommit, reason, escalated_at: safeText(value.escalatedAt) };
};

const DEFAULT_FILESYSTEM = Object.freeze({
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
});

const filesystemFrom = (overrides) => ({ ...DEFAULT_FILESYSTEM, ...(overrides ?? {}) });

const assertDirectory = (path, label) => {
  if (!existsSync(path)) return;
  let status;
  try { status = lstatSync(path); } catch (error) { throw new DeploymentLedgerError(`${label}-inspect`, error); }
  if (status.isSymbolicLink() || !status.isDirectory()) invalid(`${label}-not-a-directory`);
};

const assertSafeLedgerId = (deploymentId) => {
  if (typeof deploymentId !== "string" || !SAFE_ID.test(deploymentId)) invalid("deployment-id-invalid");
  return deploymentId;
};

const writeAll = (filesystem, descriptor, bytes) => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = filesystem.writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw Object.assign(new Error("write made no progress"), { code: "EIO" });
    }
    offset += written;
  }
};

const closeAfter = (filesystem, descriptor, work) => {
  let failure = null;
  try { work(); } catch (error) { failure = error; }
  try { filesystem.closeSync(descriptor); } catch (error) { failure ??= error; }
  if (failure) throw failure;
};

const syncDirectory = (filesystem, path) => {
  const descriptor = filesystem.openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  closeAfter(filesystem, descriptor, () => filesystem.fsyncSync(descriptor));
};

const atomicWriteJson = (filesystem, path, value) => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const descriptor = filesystem.openSync(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    closeAfter(filesystem, descriptor, () => {
      writeAll(filesystem, descriptor, bytes);
      filesystem.fsyncSync(descriptor);
    });
    filesystem.renameSync(temporary, path);
    syncDirectory(filesystem, dirname(path));
  } finally {
    filesystem.rmSync(temporary, { force: true });
  }
};

const appendJsonLine = (filesystem, path, value) => {
  const existed = filesystem.existsSync(path);
  const descriptor = filesystem.openSync(
    path,
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  closeAfter(filesystem, descriptor, () => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    writeAll(filesystem, descriptor, bytes);
    filesystem.fsyncSync(descriptor);
  });
  if (!existed) syncDirectory(filesystem, dirname(path));
};

const assertLedgerDirectory = (path, root) => {
  if (dirname(resolve(path)) !== resolve(root)) {
    throw new DeployFailure("deployment-ledger-retention-refused", "path-escaped-deployment");
  }
  const lexical = lstatSync(path);
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
    throw new DeployFailure("deployment-ledger-retention-refused", "unsafe-deployment-directory");
  }
  if (dirname(realpathSync(path)) !== realpathSync(root)) {
    throw new DeployFailure("deployment-ledger-retention-refused", "resolved-path-escaped-deployment");
  }
};

/** Remove old per-deployment directories while leaving every unrecognised state
 * entry alone. The newest bounded set is retained, including the current run. */
export const pruneDeploymentLedgers = ({
  stateDir,
  limit = DEPLOYMENT_LEDGER_RETENTION_COUNT,
} = {}) => {
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new DeployFailure("deployment-ledger-retention-refused", "state-directory-missing");
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new DeployFailure("deployment-ledger-retention-refused", "ledger-limit-invalid");
  }
  const root = join(resolve(stateDir), "deployments");
  if (!existsSync(root)) return Object.freeze({ kept: 0, removed: 0 });
  assertDirectory(root, "deployment-directory");
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!UUID.test(entry.name)) continue;
    const path = join(root, entry.name);
    assertLedgerDirectory(path, root);
    entries.push({ name: entry.name, path, modifiedMs: statSync(path).mtimeMs });
  }
  entries.sort((left, right) => right.modifiedMs - left.modifiedMs || right.name.localeCompare(left.name));
  const removed = entries.slice(limit);
  for (const entry of removed) rmSync(entry.path, { recursive: true, force: true });
  return Object.freeze({ kept: entries.length - removed.length, removed: removed.length });
};

/**
 * Construct the durable, record-only ledger for one deploy transaction. The
 * constructor allocates the identity and directory; callers explicitly record
 * STARTED so a failed allocation remains a loud deploy failure.
 */
export const createDeploymentLedger = ({
  stateDir,
  deploymentId = randomUUID(),
  targetCommit = "unknown",
  now = () => new Date(),
  filesystem: filesystemOverrides,
} = {}) => {
  if (typeof stateDir !== "string" || stateDir.length === 0) invalid("state-directory-missing");
  if (typeof now !== "function") invalid("clock-invalid");
  const id = assertSafeLedgerId(deploymentId);
  const root = resolve(stateDir);
  const deploymentsRoot = join(root, "deployments");
  const directory = join(deploymentsRoot, id);
  const filesystem = filesystemFrom(filesystemOverrides);
  try {
    const rootExisted = filesystem.existsSync(root);
    filesystem.mkdirSync(root, { recursive: true, mode: 0o700 });
    assertDirectory(root, "state-directory");
    if (!rootExisted) syncDirectory(filesystem, dirname(root));
    const deploymentsExisted = filesystem.existsSync(deploymentsRoot);
    filesystem.mkdirSync(deploymentsRoot, { recursive: true, mode: 0o700 });
    assertDirectory(deploymentsRoot, "deployment-directory");
    if (!deploymentsExisted) syncDirectory(filesystem, root);
    pruneDeploymentLedgers({ stateDir: root, limit: DEPLOYMENT_LEDGER_RETENTION_COUNT - 1 });
    filesystem.mkdirSync(directory, { recursive: false, mode: 0o700 });
    assertDirectory(directory, "ledger-directory");
    syncDirectory(filesystem, deploymentsRoot);
  } catch (error) {
    if (error instanceof DeployFailure || error instanceof DeploymentLedgerError) throw error;
    throw new DeploymentLedgerError("allocate", error);
  }

  const statePath = join(directory, "state.json");
  const eventsPath = join(directory, "events.jsonl");
  let currentState = null;
  let eventCount = 0;
  let startedAt = null;
  let updatedAt = null;
  let currentTargetCommit = safeTargetCommit(targetCommit);
  let context = {
    backupIdentity: null,
    migrationTailBefore: null,
    migrationTailAfter: null,
    activatedBuildStamp: null,
    serviceVerification: null,
    releaseDirectoryIdentity: null,
    pointerOldTarget: null,
    pointerNewTarget: null,
    rollbackPointerOutcome: null,
    supersededEscalation: null,
    quietWindowWaitSeconds: null,
    quietWindowWaitPolls: null,
    quietWindowWaitPeakBlockingRuns: null,
    quietWindowBlockingRunsByRunner: null,
    reasonCode: null,
  };

  const timestamp = () => {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new DeploymentLedgerError("timestamp", new Error("invalid-clock"));
    return date.toISOString();
  };

  const record = (state, metadata = {}) => {
    if (!LEDGER_STATE_SET.has(state)) invalid(`state-invalid-${String(state)}`);
    const recordedAt = timestamp();
    const nextStartedAt = startedAt ?? recordedAt;
    const nextTargetCommit = metadata.targetCommit === null || metadata.targetCommit === undefined
      ? currentTargetCommit
      : safeTargetCommit(metadata.targetCommit, currentTargetCommit);
    const nextContext = {
      backupIdentity: safeBackupIdentity(metadata.backupIdentity) ?? context.backupIdentity,
      migrationTailBefore: safeMigrationTail(metadata.migrationTailBefore) ?? context.migrationTailBefore,
      migrationTailAfter: safeMigrationTail(metadata.migrationTailAfter) ?? context.migrationTailAfter,
      activatedBuildStamp: safeBuildStamp(metadata.activatedBuildStamp) ?? context.activatedBuildStamp,
      serviceVerification: safeServiceVerification(metadata.serviceVerification) ?? context.serviceVerification,
      releaseDirectoryIdentity: safeReleaseDirectoryIdentity(metadata.releaseDirectoryIdentity) ?? context.releaseDirectoryIdentity,
      pointerOldTarget: safePointerTarget(metadata.pointerOldTarget) ?? context.pointerOldTarget,
      pointerNewTarget: safePointerTarget(metadata.pointerNewTarget) ?? context.pointerNewTarget,
      rollbackPointerOutcome: safeRollbackPointerOutcome(metadata.rollbackPointerOutcome) ?? context.rollbackPointerOutcome,
      supersededEscalation: safeSupersededEscalation(metadata.supersededEscalation) ?? context.supersededEscalation,
      quietWindowWaitSeconds: safeNonNegativeInteger(metadata.quietWindowWaitSeconds) ?? context.quietWindowWaitSeconds,
      quietWindowWaitPolls: safeNonNegativeInteger(metadata.quietWindowWaitPolls) ?? context.quietWindowWaitPolls,
      quietWindowWaitPeakBlockingRuns: safeNonNegativeInteger(metadata.quietWindowWaitPeakBlockingRuns)
        ?? context.quietWindowWaitPeakBlockingRuns,
      quietWindowBlockingRunsByRunner: safeBlockingRunsByRunner(metadata.quietWindowBlockingRunsByRunner)
        ?? context.quietWindowBlockingRunsByRunner,
      reasonCode: state === "FAILED" || state === "MANUAL_RECOVERY"
        ? safeReasonCode(metadata.reasonCode)
        : null,
    };
    const payload = {
      schemaVersion: DEPLOYMENT_LEDGER_SCHEMA_VERSION,
      deployment_id: id,
      target_commit: nextTargetCommit,
      backup_identity: nextContext.backupIdentity,
      migration_tail_before: nextContext.migrationTailBefore,
      migration_tail_after: nextContext.migrationTailAfter,
      activated_build_stamp: nextContext.activatedBuildStamp,
      service_verification: nextContext.serviceVerification,
      release_directory_identity: nextContext.releaseDirectoryIdentity,
      pointer_old_target: nextContext.pointerOldTarget,
      pointer_new_target: nextContext.pointerNewTarget,
      rollback_pointer_outcome: nextContext.rollbackPointerOutcome,
      superseded_escalation: nextContext.supersededEscalation,
      quiet_window_wait_seconds: nextContext.quietWindowWaitSeconds,
      quiet_window_wait_polls: nextContext.quietWindowWaitPolls,
      quiet_window_wait_peak_blocking_runs: nextContext.quietWindowWaitPeakBlockingRuns,
      quiet_window_blocking_runs_by_runner: nextContext.quietWindowBlockingRunsByRunner,
      reason_code: nextContext.reasonCode,
    };
    const event = { ...payload, phase: state, timestamp: recordedAt };
    const nextEventCount = eventCount + 1;
    const snapshot = {
      ...payload,
      state,
      terminal: TERMINAL_STATES.has(state),
      started_at: nextStartedAt,
      updated_at: recordedAt,
      event_count: nextEventCount,
    };
    try {
      appendJsonLine(filesystem, eventsPath, event);
      atomicWriteJson(filesystem, statePath, snapshot);
    } catch (error) {
      throw error instanceof DeploymentLedgerError ? error : new DeploymentLedgerError("record", error);
    }
    context = nextContext;
    currentTargetCommit = nextTargetCommit;
    currentState = state;
    startedAt = nextStartedAt;
    updatedAt = recordedAt;
    eventCount = nextEventCount;
    return Object.freeze(event);
  };

  const start = (metadata = {}) => {
    if (currentState !== null) return null;
    return record("STARTED", metadata);
  };

  const ledger = {
    deploymentId: id,
    directory,
    statePath,
    eventsPath,
    record,
    start,
    get state() { return currentState; },
    get started() { return currentState !== null; },
    get startedAt() { return startedAt; },
    get updatedAt() { return updatedAt; },
    get eventCount() { return eventCount; },
  };
  return Object.freeze(ledger);
};
