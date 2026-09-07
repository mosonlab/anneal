import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { DEPLOYMENT_LEDGER_RETENTION_COUNT, pruneDeploymentLedgers } from "./deployment-ledger.mjs";
import { BLOCKING_RUN_STATUSES, DeployFailure } from "./quiet-window-lib.mjs";

export const DEPLOY_BACKUP_RETENTION_COUNT = 14;
export const DEPLOY_BACKUP_DAILY_RETENTION_DAYS = 30;
export { DEPLOYMENT_LEDGER_RETENTION_COUNT };

const BACKUP_FILE = /^(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{12}-[0-9a-f]{12}\.dump$/u;

const removableEntries = ({ root, pattern, kind }) => {
  if (!existsSync(root)) return [];
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!pattern.test(entry.name)) continue;
    const path = join(root, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (kind === "directory" ? !info.isDirectory() : !info.isFile())) {
      throw new DeployFailure("deploy-retention-refused", `unsafe-${kind}-${entry.name}`);
    }
    entries.push({ name: entry.name, path, modifiedMs: statSync(path).mtimeMs });
  }
  return entries;
};

/**
 * Retains bounded database backups and deployment ledgers without touching the
 * active release, lock, escalation marker, or any unrecognized state entry.
 */
export const pruneDeployHistory = ({
  stateDir,
  now = Date.now(),
  backupLimit = DEPLOY_BACKUP_RETENTION_COUNT,
  dailyRetentionDays = DEPLOY_BACKUP_DAILY_RETENTION_DAYS,
  ledgerLimit = DEPLOYMENT_LEDGER_RETENTION_COUNT,
} = {}) => {
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new DeployFailure("deploy-retention-refused", "state-directory-missing");
  }
  for (const [name, value] of [
    ["backup-limit", backupLimit],
    ["daily-retention-days", dailyRetentionDays],
    ["ledger-limit", ledgerLimit],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new DeployFailure("deploy-retention-refused", `${name}-invalid`);
  }

  const backupRoot = join(stateDir, "backups");
  const backups = removableEntries({ root: backupRoot, pattern: BACKUP_FILE, kind: "file" })
    .sort((left, right) => right.name.localeCompare(left.name));
  const keptBackupNames = new Set(backups.slice(0, backupLimit).map(({ name }) => name));
  const cutoff = now - dailyRetentionDays * 24 * 60 * 60 * 1_000;
  const daily = new Set();
  for (const backup of backups) {
    if (backup.modifiedMs < cutoff) continue;
    const day = BACKUP_FILE.exec(backup.name)?.[1];
    if (day && !daily.has(day)) {
      daily.add(day);
      keptBackupNames.add(backup.name);
    }
  }
  const removedBackups = backups.filter(({ name }) => !keptBackupNames.has(name));

  for (const entry of removedBackups) rmSync(entry.path, { force: true });
  pruneDeploymentLedgers({ stateDir, limit: ledgerLimit });

  return Object.freeze({
    keptBackups: backups.length - removedBackups.length,
    removedBackups: removedBackups.length,
  });
};

// Step output kinds are the persisted execution semantics (see step-role).
// Missing Task/Step rows remain blockers; only known mechanical work is
// excluded. The exclusive deploy barrier still serializes merge execution.
export const blockingRunsStatement = (statuses = BLOCKING_RUN_STATUSES, runnerIds = null) => {
  if (runnerIds !== null && (!Array.isArray(runnerIds) || runnerIds.length === 0)) {
    throw new DeployFailure("quiet-window-runner-inventory-invalid", "runner-ids-empty");
  }
  const placeholders = statuses.map((_, index) => `$${index + 1}`).join(",");
  const runnerPredicate = runnerIds === null
    ? ""
    : ` AND "runnerId" IN (${runnerIds.map((_, index) => `$${statuses.length + index + 1}`).join(",")})`;
  return {
    sql: `SELECT "id", "status"::text AS "status", "runnerId" FROM "Run" WHERE "status"::text IN (${placeholders})${runnerPredicate} AND NOT EXISTS (SELECT 1 FROM "Task" AS task JOIN "TaskTemplateStep" AS step ON step."id" = task."templateStepId" WHERE task."id" = "Run"."taskId" AND step."outputKind" IN ('merge-result','merge-authorization')) ORDER BY "id"`,
    parameters: [...statuses, ...(runnerIds ?? [])],
  };
};

export const processStartIdentity = (pid) => {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
};

const readLock = (path) => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Number.isSafeInteger(value.pid) && typeof value.startedAt === "string" ? value : null;
  } catch {
    return null;
  }
};

/** PID plus process-start identity prevents PID reuse from making a stale lock live. */
export const acquireProcessLock = ({ path, stateDir = dirname(path), pid = process.pid, startIdentity = processStartIdentity }) => {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const startedAt = startIdentity(pid);
  if (!startedAt) throw new DeployFailure("deploy-lock-unavailable", "owner-start-identity-unreadable");
  let recovered = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, `${JSON.stringify({ pid, startedAt })}\n`); } finally { closeSync(fd); }
      let released = false;
      return {
        recovered,
        release: async () => {
          if (released) return;
          const current = readLock(path);
          if (current?.pid === pid && current.startedAt === startedAt) unlinkSync(path);
          released = true;
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw new DeployFailure("deploy-lock-unavailable", error?.code ?? "unknown");
      const owner = readLock(path);
      if (owner && startIdentity(owner.pid) === owner.startedAt) return null;
      const stale = `${path}.stale-${randomUUID()}`;
      try {
        renameSync(path, stale);
        recovered = owner ?? { pid: null, startedAt: "unreadable" };
        rmSync(stale, { force: true });
      } catch (reclaimError) {
        if (reclaimError?.code !== "ENOENT") throw new DeployFailure("deploy-lock-unavailable", "stale-lock-reclaim-failed");
      }
    }
  }
  throw new DeployFailure("deploy-lock-unavailable", "lock-contention-did-not-settle");
};
