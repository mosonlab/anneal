import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { DeployFailure } from "./quiet-window-lib.mjs";

export const DEFAULT_AUTO_DEPLOY_MIN_INTERVAL_MINUTES = 240;
export const DEFAULT_AUTO_DEPLOY_MIN_INTERVAL_MS = DEFAULT_AUTO_DEPLOY_MIN_INTERVAL_MINUTES * 60_000;
export const AUTO_DEPLOY_STATE_FILE = "auto-deploy-state.json";

const OID = /^[0-9a-f]{40}$/u;

const invalidEnvironment = (value) => {
  throw new DeployFailure("environment-invalid", `AUTO_DEPLOY_MIN_INTERVAL_MINUTES-${value}`);
};

/** Read the one shared cadence setting used by both the control-plane and
 * runner hosts. The interval is a positive whole number of minutes; keeping
 * the parser here means a host cannot silently use a platform-specific
 * default. */
export const autoDeployMinIntervalMs = (environment = process.env) => {
  const configured = environment?.AUTO_DEPLOY_MIN_INTERVAL_MINUTES;
  if (configured === undefined || configured === "") return DEFAULT_AUTO_DEPLOY_MIN_INTERVAL_MS;
  const text = String(configured);
  if (!/^\d+$/u.test(text) || Number(text) < 1 || !Number.isSafeInteger(Number(text) * 60_000)) {
    invalidEnvironment(text);
  }
  return Number(text) * 60_000;
};

const parseState = (contents, path) => {
  let value;
  try { value = JSON.parse(contents); } catch { throw new DeployFailure("automatic-deploy-state-unreadable", path); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeployFailure("automatic-deploy-state-unreadable", path);
  }
  return value;
};

const parseTimestamp = (value) => {
  if (typeof value !== "string" || value === "") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
};

const stateTimestamp = (state, path) => {
  const timestamp = parseTimestamp(state.lastSuccessfulAutomaticDeployAt);
  if (state.lastSuccessfulAutomaticDeployAt !== undefined && timestamp === null) {
    throw new DeployFailure("automatic-deploy-state-unreadable", path);
  }
  return timestamp;
};

const readFileState = (path) => {
  try { return parseState(readFileSync(path, "utf8"), path); } catch (error) {
    if (error instanceof DeployFailure) throw error;
    throw new DeployFailure("automatic-deploy-state-unreadable", path);
  }
};

/** An absent marker admits the first automatic deployment. Only the complete
 * successful invocation writes this marker, never an intermediate ledger phase. */
export const readLastSuccessfulAutomaticDeploy = ({ stateDir } = {}) => {
  const path = join(stateDir, AUTO_DEPLOY_STATE_FILE);
  if (!existsSync(path)) return null;
  return stateTimestamp(readFileState(path), path);
};

const dateFrom = (value, label) => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label}-invalid`);
  return date;
};

/** Evaluate one automatic tick. A naturally open quiet window is allowed to
 * deploy early; otherwise the minimum interval is a hard floor. */
export const automaticCadenceDecision = ({
  deployedCommit,
  targetCommit,
  blockingRuns = [],
  lastSuccessfulAt = null,
  now = () => new Date(),
  minIntervalMs = DEFAULT_AUTO_DEPLOY_MIN_INTERVAL_MS,
} = {}) => {
  if (typeof deployedCommit !== "string" || typeof targetCommit !== "string") {
    throw new TypeError("automatic-cadence-commit-required");
  }
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs <= 0) {
    throw new TypeError("automatic-cadence-interval-invalid");
  }
  const current = dateFrom(now(), "automatic-cadence-now");
  const moved = targetCommit !== deployedCommit;
  const quietAtTick = blockingRuns.length === 0;
  if (!moved) return Object.freeze({ moved: false, quietAtTick, intervalElapsed: true, allowWait: true });

  const last = lastSuccessfulAt === null ? null : dateFrom(lastSuccessfulAt, "automatic-cadence-last-success");
  const nextEligibleAt = last === null ? current : new Date(last.getTime() + minIntervalMs);
  const intervalElapsed = last === null || current.getTime() >= nextEligibleAt.getTime();
  if (quietAtTick || intervalElapsed) {
    return Object.freeze({
      moved: true,
      quietAtTick,
      intervalElapsed,
      allowWait: intervalElapsed,
      nextEligibleAt: nextEligibleAt.toISOString(),
    });
  }
  return Object.freeze({
    moved: true,
    quietAtTick: false,
    intervalElapsed: false,
    allowWait: false,
    coalesced: true,
    nextEligibleAt: nextEligibleAt.toISOString(),
  });
};

/** Persist only after the whole deployment has returned success. The small
 * replace is intentionally separate from a ledger state: a later notification
 * or resource-release failure must never leave a successful cadence marker. */
export const recordSuccessfulAutomaticDeploy = ({
  stateDir,
  targetCommit,
  now = () => new Date(),
} = {}) => {
  if (typeof stateDir !== "string" || stateDir === "") throw new TypeError("automatic-cadence-state-directory-required");
  if (typeof targetCommit !== "string" || !OID.test(targetCommit)) throw new TypeError("automatic-cadence-target-invalid");
  const timestamp = dateFrom(now(), "automatic-cadence-now").toISOString();
  const root = resolve(stateDir);
  const destination = join(root, AUTO_DEPLOY_STATE_FILE);
  const temporary = `${destination}.${process.pid}.tmp`;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: 1,
      lastSuccessfulAutomaticDeployAt: timestamp,
      targetCommit,
    })}\n`, { mode: 0o600 });
    renameSync(temporary, destination);
  } catch (error) {
    throw new DeployFailure("automatic-deploy-state-write-failed", error.code ?? error.name);
  } finally {
    rmSync(temporary, { force: true });
  }
  return Object.freeze({ lastSuccessfulAutomaticDeployAt: timestamp, targetCommit });
};
