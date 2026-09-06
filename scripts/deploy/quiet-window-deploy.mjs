#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DeployFailure,
  decideInvocation,
  deployedBuildStampRefusal,
  dryRunDecision,
  executeUpgrade,
  failureOf,
  parseDeployArguments,
  shouldPersistFailure,
} from "./quiet-window-lib.mjs";
import { resolveServiceInventory, serviceWrapperPath } from "./service-inventory.mjs";
import {
  acquireProcessLock,
  blockingRunsStatement,
  pruneDeployHistory,
} from "./deploy-preflight.mjs";
import { createProductionHost } from "./quiet-window-host.mjs";
import { openDeploymentAttempt, parseReleaseArtifactReceipt } from "./deployment-attempt.mjs";
import { readRemoteMainRevision } from "./remote-main-read.mjs";
import {
  checkExistingEscalation,
  selfClearEscalation,
  writeEscalationWithAttempts,
} from "./quiet-window-escalation.mjs";
import {
  clearEscalationOnOperatorRequest,
  ESCALATION_RETRY_CAP,
  markEscalationNotified,
  readEscalationRecord,
} from "./quiet-window-escalation-record.mjs";
import { verifyBackupConfiguration } from "./install-launchd.mjs";
import { backupConfigurationFromEnvironment, writePgDumpBackup } from "./quiet-window-backup.mjs";
import { createDeployInterruption } from "./quiet-window-interrupt.mjs";
import { runDeployCommand } from "./quiet-window-command.mjs";
import {
  BARRIER_TIMEOUT_REASON,
  createBarrierWatchdog,
  DEPLOY_STEP_TIMEOUT_MS,
  deployBarrierTimeoutMsForRole,
  MIGRATION_DEPLOY_TIMEOUT_REASON,
  waitForEscalationClear,
  waitForQuietWithWatchdog,
} from "./quiet-window-deadlines.mjs";
import { createDeploymentLedger } from "./deployment-ledger.mjs";
import {
  pruneReleaseDirectories,
} from "./release-directory.mjs";
import { findReleaseArtifact, verifyReleaseArtifact } from "./release-artifact.mjs";
import { activateReleasePointer, rollbackReleasePointer } from "./release-pointer.mjs";
import { verifyServiceInventory } from "./launchd-service-wrapper.mjs";
import { createServiceControl, describesStableWrapper } from "./service-control.mjs";
import { resolveServicePlatform } from "./service-platform.mjs";
import {
  controlPlaneApiBaseUrl,
  readRunnerControlPlaneRevision,
  readRunnerTargetRevision,
  requireRunnerDeployPreflight,
  resolveDeployRoleOrFail,
} from "./runner-role-target.mjs";
import {
  localRegistrationSnapshot,
  readRunnerRegistry,
  runnerIdsFromInventory,
  runnerRegistrationRefusal,
} from "./runner-role-verification.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** The deploy root is the operator's appliance root, not the directory this
 * script was reached through: an invocation through the `current` symlink
 * resolves its state, marker and release paths from the configured root. */
export const deployRootFromEnvironment = (environment, scriptDir) =>
  resolve(environment.AGENTOS_REPOSITORY_ROOT ?? resolve(scriptDir, "../.."));

const REPOSITORY_ROOT = deployRootFromEnvironment(process.env, SCRIPT_DIR);
const STATE_DIR = join(REPOSITORY_ROOT, ".agentos-deploy");
const LOCK_PATH = join(STATE_DIR, "lock");
const ESCALATION_PATH = join(STATE_DIR, "escalated.json");
const CURRENT_PATH = join(REPOSITORY_ROOT, "current");
const CURRENT_API_BUILD_STAMP = join(CURRENT_PATH, "packages/api/dist/build-info.json");
const RELEASES_PATH = join(REPOSITORY_ROOT, "releases");
const SHARED_PATH = join(REPOSITORY_ROOT, "shared");
const POLL_SECONDS_TEXT = process.env.QUIET_WINDOW_POLL_SECONDS ?? "60";
const POLL_SECONDS = /^\d+$/u.test(POLL_SECONDS_TEXT) ? Number(POLL_SECONDS_TEXT) : Number.NaN;
const POLL_MS = POLL_SECONDS * 1_000;
const DEPLOY_BARRIER_CLASS = 0x41_47_44_50; // Must match @anneal/db deploy-barrier.ts ("AGDP").
const DEPLOY_BARRIER_KEY = 1;
const RETRYABLE_ESCALATION_REASONS = new Set([
  "remote-main-unreadable",
  "remote-main-read-timeout",
  "control-plane-version-unreachable",
  "control-plane-commit-unavailable",
  "source-remote-unreadable",
  "source-remote-read-timeout",
  "quiet-window-query-failed",
  "deploy-barrier-unavailable",
]);

const generatedPrismaClientIsComplete = (root) =>
  existsSync(join(root, "node_modules/.prisma/client/index.js"))
  && existsSync(join(root, "node_modules/.prisma/client/schema.prisma"));

const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };
const activeResources = new Set();
const interruption = createDeployInterruption();
const interruptController = { signal: interruption.signal };
const interruptFailure = interruption.failure;
const throwIfInterrupted = interruption.throwIfInterrupted;
let migrationBarrierRetentionActive = false;
const trackResource = (resource) => {
  const release = resource.release.bind(resource);
  resource.release = async () => {
    try { await release(); } finally { activeResources.delete(resource); }
  };
  activeResources.add(resource);
  return resource;
};

const command = (program, args, {
  cwd = REPOSITORY_ROOT,
  env = process.env,
  capture = false,
  timeoutMs,
  timeoutReason,
  allowAfterInterrupt = false,
  onTermination,
} = {}) => runDeployCommand(program, args, {
  cwd,
  env,
  capture,
  timeoutMs,
  timeoutReason,
  signal: interruptController.signal,
  abortFailure: interruptFailure,
  abortSignal: () => interruption.receivedSignal() === "SIGINT" ? "SIGINT" : "SIGTERM",
  allowAfterAbort: allowAfterInterrupt,
  onTermination,
});

const checkedResult = async (reason, run) => {
  log(`START ${reason}`);
  const result = await run().catch((error) => {
    if (error instanceof DeployFailure) throw error;
    return { code: 1, stderr: String(error), stdout: "" };
  });
  if (result.code !== 0) {
    const diagnosis = (result.stderr || result.stdout || "").trim().slice(-2_000).replaceAll(/\s+/gu, " ");
    fail(reason, `exit-${result.code}${diagnosis ? `: ${diagnosis}` : ""}`);
  }
  log(`PASS ${reason}`);
  return result;
};

const checked = (reason, program, args, options) => checkedResult(
  reason,
  () => command(program, args, options),
);

export const canonicalSyncRefusedLines = (stdout) => stdout
  .split(/\r?\n/u)
  .filter((line) => line.startsWith("REFUSED "));

export const canonicalSyncNoticeRecord = (record, refusedLines) => ({
  ...record,
  ...(record.outcome === "success" && refusedLines.length > 0
    ? { detail: refusedLines.join("\n") }
    : {}),
});

export const autoDeployNoticeBody = ({ outcome, reason, detail = "", from, to }) =>
  `[auto-deploy] ${outcome}: ${from} -> ${to}; reason=${reason}${detail ? `; detail=${detail}` : ""}`;

const parseJson = (contents, reason) => {
  try {
    const value = JSON.parse(contents);
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail(reason, "json-root-is-not-an-object");
    return value;
  } catch {
    fail(reason, "unreadable-or-invalid-json");
  }
};

const readJson = (path, reason) => {
  try {
    return parseJson(readFileSync(path, "utf8"), reason);
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    fail(reason, "unreadable-or-invalid-json");
  }
};

const readDeployedRevision = () => {
  let stampPath = CURRENT_API_BUILD_STAMP;
  try {
    const current = lstatSync(CURRENT_PATH);
    if (!current.isSymbolicLink()) fail("deployed-revision-unreadable", "current-is-not-a-symlink");
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    fail("deployed-revision-unreadable", `current-pointer-${error?.code ?? "unreadable"}`);
  }
  const stamp = readJson(stampPath, "deployed-revision-unreadable");
  const refusal = deployedBuildStampRefusal(stamp);
  if (refusal) {
    fail("deployed-revision-unreadable", `api-dist-stamp-${refusal}`);
  }
  return stamp.commit;
};

const environmentFilePath = () => join(SHARED_PATH, ".env");

const remoteMainRevision = async () => {
  const sourceRemote = process.env.DEPLOY_SOURCE_REMOTE;
  if (!sourceRemote) fail("environment-unreadable", "DEPLOY_SOURCE_REMOTE-missing");
  const revision = await readRemoteMainRevision({
    run: () => command(
      loadBinaries().git,
      ["ls-remote", "--exit-code", sourceRemote, "refs/heads/main"],
      {
        capture: true,
        timeoutMs: DEPLOY_STEP_TIMEOUT_MS.remoteMainRead,
        timeoutReason: "remote-main-read-timeout",
      },
    ).catch((error) => {
      if (error instanceof DeployFailure) throw error;
      return { code: 1, stderr: String(error), stdout: "" };
    }),
    onRetry: ({ reason, attempt, nextAttempt, waitMs }) => log(
      `RETRY ${reason} operation=ls-remote-main attempt=${attempt} next-attempt=${nextAttempt} wait-ms=${waitMs}`,
    ),
  });
  log(`PASS remote-main-read revision=${revision}`);
  return revision;
};

const sourceRemoteContainsCommit = async (revision) => {
  const sourceRemote = process.env.DEPLOY_SOURCE_REMOTE;
  if (!sourceRemote) fail("environment-unreadable", "DEPLOY_SOURCE_REMOTE-missing");
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const probe = mkdtempSync(join(STATE_DIR, "source-commit-probe-"));
  try {
    return await probeSourceRemoteCommit({
      revision,
      sourceRemote,
      gitBinary: loadBinaries().git,
      probeDirectory: probe,
      run: command,
    });
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
};

export const probeSourceRemoteCommit = async ({
  revision,
  sourceRemote,
  gitBinary,
  probeDirectory,
  run,
  timeoutMs = DEPLOY_STEP_TIMEOUT_MS.sourceCommitProbe,
}) => {
  const options = {
    capture: true,
    timeoutMs,
    timeoutReason: "source-remote-read-timeout",
  };
  const accessible = await run(gitBinary, ["ls-remote", sourceRemote], options);
  if (accessible.code !== 0) fail("source-remote-unreadable", `exit-${accessible.code}`);
  const initialized = await run(gitBinary, ["init", "--bare", probeDirectory], options);
  if (initialized.code !== 0) fail("source-commit-probe-failed", `init-exit-${initialized.code}`);
  const fetched = await run(gitBinary, [
    "-C", probeDirectory, "fetch", "--no-tags", "--depth=1", sourceRemote, revision,
  ], options);
  if (fetched.code !== 0) {
    const diagnosis = `${fetched.stderr ?? ""}\n${fetched.stdout ?? ""}`;
    if (/(?:not our ref|couldn't find remote ref|unadvertised object|not a valid object|does not allow request)/iu.test(diagnosis)) {
      fail("control-plane-commit-unavailable", revision);
    }
    fail("source-remote-unreadable", `fetch-exit-${fetched.code}`);
  }
  const resolved = await run(gitBinary, [
    "-C", probeDirectory, "cat-file", "-e", `${revision}^{commit}`,
  ], options);
  return resolved.code === 0;
};

const targetRevision = async () => {
  if (resolveDeployRoleOrFail() === "control-plane") return remoteMainRevision();
  const runnerConfig = requireRunnerDeployPreflight(process.env);
  const revision = await readRunnerTargetRevision({
    apiBaseUrl: runnerConfig.apiBaseUrl,
    sourceContainsCommit: sourceRemoteContainsCommit,
    deployedCommit: readDeployedRevision(),
  });
  log(`PASS control-plane-version-read revision=${revision}`);
  return revision;
};

const loadEnvironment = async (deployRole = resolveDeployRoleOrFail()) => {
  const envPath = environmentFilePath();
  if (!existsSync(envPath) || !statSync(envPath).isFile()) fail("environment-unreadable", ".env-missing-or-not-a-file");
  if ((statSync(envPath).mode & 0o777) !== 0o600) fail("environment-unreadable", ".env-mode-must-be-0600");
  const { config } = await import("dotenv").catch(() => fail("environment-unreadable", "dotenv-module-unavailable"));
  const loaded = config({ path: envPath, override: false, quiet: true });
  if (deployRole === "runner") {
    if (!loaded.parsed?.OPERATOR_TOKEN?.trim()) fail("environment-unreadable", "OPERATOR_TOKEN-missing");
    if (!loaded.parsed?.RUNNER_TOKEN?.trim()) fail("environment-unreadable", "RUNNER_TOKEN-missing");
    controlPlaneApiBaseUrl(process.env);
    if (loaded.error || !process.env.DATABASE_URL) fail("environment-unreadable", "DATABASE_URL-missing");
    if (!process.env.FEISHU_DEFAULT_CHAT_ID) fail("environment-unreadable", "FEISHU_DEFAULT_CHAT_ID-missing");
    return;
  }
  if (loaded.error || !process.env.DATABASE_URL) fail("environment-unreadable", "DATABASE_URL-missing");
  if (!process.env.FEISHU_DEFAULT_CHAT_ID) fail("environment-unreadable", "FEISHU_DEFAULT_CHAT_ID-missing");
  if (!loaded.parsed?.GITHUB_READ_TOKEN?.trim()) fail("environment-unreadable", "GITHUB_READ_TOKEN-missing");
};

const resolveExecutable = (variable, fallback) => {
  const configured = process.env[variable];
  let path = configured;
  if (!path) {
    try { path = execFileSync("/usr/bin/which", [fallback], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { path = ""; }
  }
  if (!path?.startsWith("/")) fail("environment-unreadable", `${variable}-missing`);
  try { accessSync(path, fsConstants.X_OK); } catch { fail("environment-unreadable", `${variable}-not-executable`); }
  return path;
};

let binaries = null;
export const loadDeployBinaries = ({
  deployRole,
  resolveExecutableImpl = resolveExecutable,
  backupConfigurationImpl = backupConfigurationFromEnvironment,
}) => {
  try {
    return Object.freeze({
      git: resolveExecutableImpl("DEPLOY_GIT_BINARY", "git"),
      node: resolveExecutableImpl("DEPLOY_NODE_BINARY", "node"),
      npm: resolveExecutableImpl("DEPLOY_NPM_BINARY", "npm"),
      backup: deployRole === "control-plane" ? backupConfigurationImpl() : null,
    });
  } catch (error) {
    fail("environment-unreadable", error instanceof Error ? error.message : String(error));
  }
};

const loadBinaries = () => {
  if (binaries === null) {
    const deployRole = resolveDeployRoleOrFail();
    binaries = loadDeployBinaries({ deployRole });
  }
  return binaries;
};

let prisma = null;
const database = async () => {
  if (prisma) return prisma;
  const module = await import("@prisma/client").catch(() => fail("database-client-unavailable", "prisma-client-import-failed"));
  prisma = new module.PrismaClient();
  return prisma;
};

// A migration tail is evidence only. An unreadable history must not invent a
// deploy refusal or change the existing migration command's control flow; the
// ledger records null when the read cannot be proved.
const migrationTail = async () => {
  try {
    const db = await database();
    const rows = await db.$queryRawUnsafe(
      'SELECT "migration_name" AS "name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL ORDER BY "finished_at" DESC, "migration_name" DESC LIMIT 1',
    );
    return typeof rows[0]?.name === "string" ? rows[0].name : null;
  } catch {
    return null;
  }
};

const blockingRuns = async (runnerIds = null) => {
  throwIfInterrupted();
  const db = await database();
  try {
    const statement = blockingRunsStatement(undefined, runnerIds);
    const runs = await db.$queryRawUnsafe(statement.sql, ...statement.parameters);
    throwIfInterrupted();
    return runs;
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    fail("quiet-window-query-failed", "platform-database-unreadable");
  }
};

const notify = async ({ outcome, reason, detail = "", from, to }) => {
  if (outcome === "success") throwIfInterrupted();
  const db = await database();
  const body = autoDeployNoticeBody({ outcome, reason, detail, from, to });
  const dedupeKey = `auto-deploy:${createHash("sha256").update(body).digest("hex")}`;
  try {
    const chatId = process.env.FEISHU_DEFAULT_CHAT_ID;
    if (!chatId) fail("environment-unreadable", "FEISHU_DEFAULT_CHAT_ID-missing");
    const thread = await db.inboxThread.findFirst({ where: { channel: "FEISHU", externalChatId: chatId, sessionId: null } })
      ?? await db.inboxThread.create({ data: { channel: "FEISHU", externalChatId: chatId } });
    // A successful deploy needs no operator action, so it lands already closed:
    // the delivery worker only picks up `open`, so the record is archived
    // without a Feishu push and without joining the awaiting-reply queue. The
    // Inbox reads the newest one to show when production last moved.
    const archived = outcome === "success";
    await db.inboxMessage.upsert({
      where: { dedupeKey },
      create: {
        from: "AGENT", kind: "TEXT", body, dedupeKey, threadId: thread.id,
        ...(archived ? { status: "CLOSED", answeredAt: new Date() } : {}),
      },
      update: {},
    });
    if (outcome === "success") throwIfInterrupted();
    log(`INBOX ${body}`);
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    fail("inbox-notification-failed", `${outcome}-${reason}`);
  }
};

const sleep = (milliseconds) => {
  throwIfInterrupted();
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => {
      interruptController.signal.removeEventListener("abort", onAbort);
      accept();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(interruptFailure());
    };
    interruptController.signal.addEventListener("abort", onAbort, { once: true });
  });
};

const acquireDeployBarrier = async () => {
  throwIfInterrupted();
  const module = await import("@prisma/client").catch(() => fail("database-client-unavailable", "prisma-client-import-failed"));
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("max_connection_lifetime", "0");
  url.searchParams.set("max_idle_connection_lifetime", "0");
  const session = new module.PrismaClient({ datasources: { db: { url: url.href } } });
  try {
    await session.$connect();
    throwIfInterrupted();
    const rows = await session.$queryRawUnsafe(
      "SELECT pg_try_advisory_lock($1::int4, $2::int4) AS granted, pg_backend_pid() AS pid",
      DEPLOY_BARRIER_CLASS,
      DEPLOY_BARRIER_KEY,
    );
    throwIfInterrupted();
    if (rows.length !== 1 || rows[0]?.granted !== true) { await session.$disconnect(); return null; }
    const pid = Number(rows[0].pid);
    let released = false;
    let retainUntilCleared = false;
    const verifyBarrier = async () => {
      if (released) return false;
      const checks = await session.$queryRawUnsafe(
        `SELECT pg_backend_pid() AS pid, EXISTS (
           SELECT 1 FROM pg_locks
           WHERE locktype = 'advisory' AND pid = pg_backend_pid()
             AND classid = $1::oid AND objid = $2::oid AND objsubid = 2
             AND granted AND mode = 'ExclusiveLock'
         ) AS held`,
        DEPLOY_BARRIER_CLASS,
        DEPLOY_BARRIER_KEY,
      ).catch(() => []);
      return checks.length === 1 && Number(checks[0]?.pid) === pid && checks[0]?.held === true;
    };
    return trackResource({
      retainUntilEscalationCleared: () => {
        retainUntilCleared = true;
        migrationBarrierRetentionActive = true;
      },
      // The backend identity and pg_locks row prove the pinned session still
      // owns the exact exclusive key; either becoming unreadable is loss.
      verify: verifyBarrier,
      release: async () => {
        if (released) return;
        if (retainUntilCleared) {
          await waitForEscalationClear({
            escalationExists: () => existsSync(ESCALATION_PATH),
            verifyBarrier,
            wait: () => new Promise((resolveWait) => setTimeout(resolveWait, 1_000)),
            onHold: () => log(`HOLD deploy-barrier migration-timeout escalation=${ESCALATION_PATH}; clear-escalation-required`),
            onPersistencePending: () => log(`STOP escalation-persistence-unobserved path=${ESCALATION_PATH}; deploy-barrier-retained`),
            onCleared: () => {
              migrationBarrierRetentionActive = false;
              log("PASS deploy-barrier operator-cleared-migration-timeout");
            },
          });
        }
        released = true;
        try { await session.$queryRawUnsafe("SELECT pg_advisory_unlock($1::int4, $2::int4)", DEPLOY_BARRIER_CLASS, DEPLOY_BARRIER_KEY); }
        finally { await session.$disconnect(); }
      },
    });
  } catch (error) {
    await session.$disconnect().catch(() => undefined);
    if (error instanceof DeployFailure) throw error;
    fail("deploy-barrier-unavailable", error instanceof Error ? error.name : "query-failed");
  }
};

const waitForQuiet = (startWatchdog, blockingRunsForHost = () => blockingRuns()) => waitForQuietWithWatchdog({
  blockingRuns: blockingRunsForHost,
  acquireBarrier: acquireDeployBarrier,
  startWatchdog,
  wait: () => sleep(POLL_MS),
  onBlockingRuns: (runs) => log(`HOLD quiet-window blockers=${runs.length} statuses=${[...new Set(runs.map((run) => run.status))].join(",")}`),
  onBarrierContended: () => log("HOLD quiet-window deploy-barrier-contended"),
  onRacedBlockingRuns: (runs) => log(`HOLD quiet-window raced-blockers=${runs.length}`),
});

const acquireLock = async () => {
  const lock = acquireProcessLock({ path: LOCK_PATH, stateDir: STATE_DIR });
  return lock === null ? null : trackResource(lock);
};

const writeEscalation = async (record) => {
  const persisted = writeEscalationWithAttempts({
    escalationPath: ESCALATION_PATH,
    record,
    retryableReasons: RETRYABLE_ESCALATION_REASONS,
  });
  log(`ESCALATED reason=${persisted.reason} from=${persisted.from} to=${persisted.to}`);
};

const retryEscalationNotification = async () => {
  const marker = readEscalationRecord({ path: ESCALATION_PATH });
  if (marker === null) fail("escalation-state-unreadable", "marker-absent");
  const { record } = marker;
  if (record.notificationDelivered === true) return;
  await notify({
    outcome: "failure",
    reason: String(record.reason ?? "unknown-failure"),
    detail: String(record.detail ?? ""),
    from: String(record.from ?? "unknown"),
    to: String(record.to ?? "unknown"),
  });
  markEscalationNotified({ path: ESCALATION_PATH });
};

const persistAndNotifyFailure = async (failure, from, to) => {
  await writeEscalation({
    outcome: "failure",
    reason: failure.reason,
    detail: failure.detail,
    from,
    to,
  });
  try {
    await retryEscalationNotification();
  } catch {
    log(`STOP inbox-notification-pending reason=${failure.reason}`);
  }
};

const createDeployStartup = () => ({
  pollIntervalMs: POLL_MS,
  log,
  clearEscalation: () => clearEscalationOnOperatorRequest({ path: ESCALATION_PATH, log }),
  loadEnvironment,
  loadBinaries,
  acquireLock,
  checkEscalation: () => checkExistingEscalation({
    escalationPath: ESCALATION_PATH,
    retryEscalationNotification,
    log,
    retryableReasons: RETRYABLE_ESCALATION_REASONS,
    retryCap: ESCALATION_RETRY_CAP,
  }),
  readRemoteMain: targetRevision,
  persistFailure: (failure) => persistAndNotifyFailure(failure, "unknown", "unknown"),
});

const pruneHistory = () => {
  const result = pruneDeployHistory({ stateDir: STATE_DIR });
  const releases = existsSync(RELEASES_PATH)
    ? pruneReleaseDirectories({ deployRoot: REPOSITORY_ROOT })
    : { kept: 0, removed: 0, protected: [] };
  log(`PRUNE deploy-history releases-kept=${releases.kept} releases-removed=${releases.removed} backups-kept=${result.keptBackups} backups-removed=${result.removedBackups}`);
  return { ...result, releases };
};

const createDefaultServiceControl = (inventory) => createServiceControl({
  platform: resolveServicePlatform(),
  inventory,
  run: command,
  checked,
  wrapperPath: serviceWrapperPath(REPOSITORY_ROOT),
  timeoutMs: {
    restart: DEPLOY_STEP_TIMEOUT_MS.serviceRestart,
    inspect: DEPLOY_STEP_TIMEOUT_MS.serviceInspection,
  },
});

const serviceState = async (serviceControl, labels) => {
  const unavailable = [];
  for (const label of labels) {
    if (!await serviceControl.isRunning(label)) unavailable.push(label);
  }
  return { ok: unavailable.length === 0, unavailable };
};

/** Prove the wrapper-first migration before any new pointer is activated. Each
 * loaded definition must name the stable shared wrapper, each label must still
 * be running from the old current target, and the API must report that exact
 * current release commit. */
export const verifyStableServicePaths = async (serviceControl, {
  repositoryRoot = REPOSITORY_ROOT,
  environment = process.env,
  fetchImpl = fetch,
  labels = resolveServiceInventory(environment, resolveDeployRoleOrFail(environment)).labels,
} = {}) => {
  const wrapper = serviceWrapperPath(repositoryRoot);
  try {
    return await verifyServiceInventory({
      repositoryRoot,
      labels,
      environment,
      start: async (invocation) => {
        let description;
        let running;
        if (serviceControl.platform === "darwin") {
          // launchctl print supplies both facts in one output. Keep the
          // existing one-command inspection on the frozen macOS path.
          description = await serviceControl.describe(invocation.label);
          running = /^\s*state = running\s*$/mu.test(description);
        } else {
          running = await serviceControl.isRunning(invocation.label);
          description = await serviceControl.describe(invocation.label);
        }
        const wrapped = describesStableWrapper({
          description,
          label: invocation.label,
          wrapperPath: wrapper,
        });
        return { ok: running && wrapped, targetReleaseId: invocation.releaseIdentity };
      },
      readiness: async ({ label, invocation }) => {
        if (label !== "com.agentos.api") return { ok: true, releaseIdentity: invocation.releaseIdentity };
        const port = process.env.API_PORT ?? "3000";
        const health = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
        const version = await fetchImpl(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(2_000) });
        const payload = version.ok ? await version.json() : {};
        return {
          ok: health.ok && version.ok && payload.commit === invocation.releaseCommit && payload.dirty === false,
          releaseIdentity: invocation.releaseIdentity,
        };
      },
    });
  } catch (error) {
    fail("service-wrapper-verification-failed", error instanceof Error ? error.message : String(error));
  }
};

const makeWritable = (root) => {
  const visit = (path) => {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return;
    chmodSync(path, status.mode & 0o777 | (status.isDirectory() ? 0o700 : 0o600));
    if (status.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(root);
};

export const createDeployHost = ({
  serviceControl: providedServiceControl,
  verifyRecoveredServices = verifyStableServicePaths,
  environment = process.env,
  deployRole = resolveDeployRoleOrFail(environment),
  fetchImpl = fetch,
  blockingRunsAdapter = null,
  serviceVerificationTimeoutMs = 30_000,
  serviceVerificationWait = sleep,
} = {}) => {
  const runnerConfig = deployRole === "runner" ? requireRunnerDeployPreflight(environment) : null;
  // The one inventory this invocation installs, controls and verifies. The
  // service control is built from it rather than resolving a second one, so a
  // caller naming an explicit role cannot give the two different inventories.
  const serviceInventory = resolveServiceInventory(environment, deployRole);
  const serviceControl = providedServiceControl ?? createDefaultServiceControl(serviceInventory);
  const serviceLabels = serviceInventory.labels;
  const localRunnerIds = runnerIdsFromInventory(serviceInventory.entries);
  const scopedBlockingRuns = blockingRunsAdapter
    ?? (() => blockingRuns(deployRole === "runner" ? localRunnerIds : null));
  const apiBaseUrl = runnerConfig?.apiBaseUrl ?? null;
  const operatorToken = runnerConfig?.operatorToken ?? null;
  let canonicalSyncRefusals = [];
  const notifyDeployOutcome = async (record) => notify(canonicalSyncNoticeRecord(record, canonicalSyncRefusals));
  return createProductionHost({
    selfClearEscalation: async (attempt) => {
      const pending = attempt.fact("retryEscalation");
      if (!pending) return false;
      return selfClearEscalation({
        escalationPath: ESCALATION_PATH,
        retryEscalation: pending,
        notify,
        log,
      });
    },
    blockingRuns: scopedBlockingRuns,
    artifactState: async (attempt) => {
      try {
        const artifact = findReleaseArtifact({
          deployRoot: attempt.deployRoot,
          revision: attempt.targetCommit,
        });
        return { ok: true, releaseName: artifact.releaseName };
      } catch (error) {
        const failure = failureOf(error);
        return { ok: false, reason: failure.reason };
      }
    },
    serviceState: () => serviceState(serviceControl, serviceLabels),
    backupState: async () => {
      const requested = loadBinaries().backup;
      try {
        const verified = verifyBackupConfiguration(requested);
        return { ok: true, mode: verified.mode };
      } catch (error) {
        return {
          ok: false,
          mode: requested.mode,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    readRevisions: async (attempt) => ({
      revisions: { from: readDeployedRevision(), to: attempt.targetCommit },
    }),
    checkAlreadyDeployed: async (attempt) => {
      const revisions = attempt.requireFact("revisions");
      if (revisions.from !== revisions.to) return;
      pruneHistory();
      log(`NOOP already-deployed revision=${revisions.from}`);
      return { skip: "already-deployed" };
    },
    startDeploymentLedger: async (attempt) => ({
      ledger: createDeploymentLedger({
        stateDir: STATE_DIR,
        deploymentId: attempt.transactionId,
        targetCommit: attempt.targetCommit,
      }),
    }),
    prepareReleaseArtifact: async (attempt) => {
      const built = await checked(
        "release-artifact-build-failed",
        loadBinaries().node,
        [join(SCRIPT_DIR, "build-release-artifact.mjs"), attempt.targetCommit],
        {
          capture: true,
          timeoutMs: DEPLOY_STEP_TIMEOUT_MS.releaseArtifactBuild,
          timeoutReason: "release-artifact-build-timeout",
        },
      );
      const hasReceipt = built.stdout.trim().split("\n").some((line) => line.startsWith("RELEASE-ARTIFACT "));
      const receipt = parseReleaseArtifactReceipt(built.stdout);
      if (!receipt) fail("release-artifact-build-failed", hasReceipt ? "builder-receipt-invalid" : "builder-receipt-missing");
      const preparedRelease = verifyReleaseArtifact({
        deployRoot: attempt.deployRoot,
        revision: attempt.targetCommit,
        releaseName: receipt.releaseName,
      });
      return { preparedRelease };
    },
    verifyArtifact: async (attempt) => {
      const preparedRelease = attempt.requireFact("preparedRelease");
      return {
        verifiedRelease: verifyReleaseArtifact({
          deployRoot: attempt.deployRoot,
          revision: attempt.targetCommit,
          releaseName: preparedRelease.releaseName,
        }),
      };
    },
    waitForQuiet: async (attempt) => {
      const revisions = attempt.requireFact("revisions");
      const barrierTimeoutMs = deployBarrierTimeoutMsForRole(deployRole, serviceLabels.length);
      const { barrier, watchdog } = await waitForQuiet(() => createBarrierWatchdog({
        timeoutMs: barrierTimeoutMs,
        escalationPath: ESCALATION_PATH,
        escalationRecord: {
          outcome: "failure",
          reason: BARRIER_TIMEOUT_REASON,
          detail: `budget-${barrierTimeoutMs}ms`,
          from: revisions.from,
          to: revisions.to,
        },
        onTimeout: async () => {
          const failure = new DeployFailure(
            BARRIER_TIMEOUT_REASON,
            `budget-${barrierTimeoutMs}ms`,
          );
          if (!interruption.interruptWithFailure(failure)) return;
          log(`STOP ${failure.reason} detail=${failure.detail}`);
        },
        onError: (error) => {
          const failure = error instanceof DeployFailure
            ? error
            : new DeployFailure("deploy-barrier-watchdog-alert-failed", error instanceof Error ? error.name : "unknown");
          log(`STOP ${failure.reason} detail=${failure.detail}`);
          interruption.interruptWithFailure(failure);
        },
      }), scopedBlockingRuns);
      log("PASS quiet-window deploy-barrier-held blockers=0");
      return { barrier, resources: [barrier, watchdog] };
    },
    prepareWorkspace: async (attempt) => {
      const release = attempt.requireFact("verifiedRelease");
      const operationWorkspace = join(STATE_DIR, `operation-${attempt.transactionId}`);
      try {
        cpSync(release.releaseDirectory, operationWorkspace, { recursive: true, errorOnExist: true });
        makeWritable(operationWorkspace);
      } catch (error) {
        if (existsSync(operationWorkspace)) {
          makeWritable(operationWorkspace);
          rmSync(operationWorkspace, { recursive: true, force: true });
        }
        fail("operation-workspace-preparation-failed", error?.code ?? "copy-failed");
      }
      return {
        operationWorkspace,
        resources: [{
          release: async () => {
            if (!existsSync(operationWorkspace)) return;
            makeWritable(operationWorkspace);
            rmSync(operationWorkspace, { recursive: true, force: true });
          },
        }],
      };
    },
    verifyStableServicePaths: async () => {
      await verifyStableServicePaths(serviceControl, { environment, fetchImpl, labels: serviceLabels });
    },
    backup: async (attempt) => {
      const revisions = attempt.requireFact("revisions");
      const backupDirectory = join(STATE_DIR, "backups");
      mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
      const output = join(backupDirectory, `${new Date().toISOString().replace(/[:.]/gu, "-")}-${revisions.from.slice(0, 12)}-${revisions.to.slice(0, 12)}.dump`);
      try {
        await writePgDumpBackup({
          configuration: loadBinaries().backup,
          databaseUrl: process.env.DATABASE_URL,
          output,
          signal: interruptController.signal,
          timeoutMs: DEPLOY_STEP_TIMEOUT_MS.databaseBackup,
        });
      } catch (error) {
        throwIfInterrupted();
        if (error instanceof Error && error.message === "pg_dump-timeout") {
          fail("database-backup-timeout", `budget-${DEPLOY_STEP_TIMEOUT_MS.databaseBackup}ms`);
        }
        fail("database-backup-failed", error instanceof Error ? error.message : String(error));
      }
      return { backup: { backupIdentity: basename(output) } };
    },
    guardedMigration: async (attempt) => {
      const operationWorkspace = attempt.requireFact("operationWorkspace");
      const migrationTailBefore = await migrationTail();
      await checked("guarded-migration-refused", loadBinaries().node, ["node_modules/tsx/dist/cli.mjs", "packages/db/prisma/preflight-goal-execution.ts"], {
        cwd: operationWorkspace,
        timeoutMs: DEPLOY_STEP_TIMEOUT_MS.migrationPreflight,
        timeoutReason: "migration-preflight-timeout",
      });
      const barrier = attempt.requireFact("barrier");
      await checked(
        "guarded-migration-refused",
        loadBinaries().node,
        [
          "node_modules/prisma/build/index.js",
          "migrate",
          "deploy",
          "--schema",
          "packages/db/prisma/schema.prisma",
        ],
        {
          cwd: operationWorkspace,
          timeoutMs: DEPLOY_STEP_TIMEOUT_MS.migrationDeploy,
          timeoutReason: MIGRATION_DEPLOY_TIMEOUT_REASON,
          onTermination: () => barrier.retainUntilEscalationCleared(),
        },
      );
      const migrationTailAfter = await migrationTail();
      return { migration: { migrationTailBefore, migrationTailAfter } };
    },
    generatePrismaClient: (attempt) => checked("prisma-client-generation-refused", loadBinaries().node, [
      "node_modules/prisma/build/index.js",
      "generate",
      "--schema",
      "packages/db/prisma/schema.prisma",
    ], {
      cwd: attempt.requireFact("operationWorkspace"),
      timeoutMs: DEPLOY_STEP_TIMEOUT_MS.prismaClientGeneration,
      timeoutReason: "prisma-client-generation-timeout",
    }),
    syncCanonicalPrompts: async (attempt) => {
      const result = await checked("canonical-prompt-sync-refused", loadBinaries().node, [
        "node_modules/tsx/dist/cli.mjs",
        "packages/db/prisma/sync-canonical-prompts.ts",
      ], {
        cwd: attempt.requireFact("operationWorkspace"),
        capture: true,
        timeoutMs: DEPLOY_STEP_TIMEOUT_MS.canonicalPromptSync,
        timeoutReason: "canonical-prompt-sync-timeout",
      });
      if (result.stdout) process.stdout.write(result.stdout);
      canonicalSyncRefusals = canonicalSyncRefusedLines(result.stdout);
      return undefined;
    },
    verifyRuntimePrismaClient: async (attempt) => {
      if (!generatedPrismaClientIsComplete(attempt.requireFact("operationWorkspace"))) {
        fail("runtime-prisma-client-missing", "operation-generated-client-is-absent");
      }
    },
    assertQuietBeforeRestart: async (attempt) => {
      if (!await attempt.requireFact("barrier").verify()) fail("deploy-barrier-lost", "exclusive-session-lock-not-held");
      const blockers = await scopedBlockingRuns();
      if (blockers.length > 0) fail("quiet-window-lost", `blockers-${blockers.length}`);
    },
    verifyControlPlaneTarget: async (attempt) => {
      const currentCommit = await readRunnerControlPlaneRevision({ apiBaseUrl, fetchImpl });
      if (currentCommit !== attempt.targetCommit) {
        fail("control-plane-version-changed", `${attempt.targetCommit}->${currentCommit}`);
      }
    },
    publishBuild: async (attempt) => {
      const release = attempt.requireFact("verifiedRelease");
      const verifiedRelease = verifyReleaseArtifact({
        deployRoot: attempt.deployRoot,
        revision: attempt.targetCommit,
        releaseName: release.releaseName,
      });
      const activated = activateReleasePointer({ root: attempt.deployRoot, release: verifiedRelease.releaseName });
      const relativeTarget = (target) => target === null ? null : `releases/${target}`;
      const pointerTransition = Object.freeze({
        oldTarget: relativeTarget(activated.oldTarget),
        newTarget: relativeTarget(activated.newTarget),
        previousTarget: relativeTarget(activated.previousTarget),
      });
      return {
        verifiedRelease,
        publication: {
          releaseDirectoryIdentity: verifiedRelease.releaseName,
          releaseIdentity: {
            name: verifiedRelease.releaseName,
            commit: verifiedRelease.revision,
            digest: verifiedRelease.digest,
          },
          pointerOldTarget: pointerTransition.oldTarget,
          pointerNewTarget: pointerTransition.newTarget,
          pointerTransition,
          rollback: async () => rollbackReleasePointer({ root: attempt.deployRoot }),
        },
      };
    },
    restartServices: async () => {
      const runnerRegistrationsBeforeRestart = deployRole === "runner"
        ? localRegistrationSnapshot(await readRunnerRegistry({
            apiBaseUrl,
            operatorToken,
            fetchImpl,
          }), localRunnerIds)
        : null;
      for (const label of serviceLabels) {
        await serviceControl.restart(label, { reason: "service-restart-failed" });
      }
      return runnerRegistrationsBeforeRestart === null ? undefined : { runnerRegistrationsBeforeRestart };
    },
    verifyServices: async (attempt) => {
      const revisions = attempt.requireFact("revisions");
      const deadline = Date.now() + serviceVerificationTimeoutMs;
      let lastReason = "not-ready";
      while (Date.now() < deadline) {
        const state = await serviceState(serviceControl, serviceLabels);
        if (!state.ok) {
          const manager = serviceControl.platform === "linux" ? "systemd" : "launchd";
          lastReason = `${manager}-unavailable-${state.unavailable.join(",")}`;
        }
        else if (deployRole === "runner") {
          try {
            const payload = await readRunnerRegistry({
              apiBaseUrl,
              operatorToken,
              fetchImpl,
            });
            const refusal = runnerRegistrationRefusal({
              payload,
              runnerIds: localRunnerIds,
              before: attempt.requireFact("runnerRegistrationsBeforeRestart"),
              targetCommit: revisions.to,
            });
            if (refusal === null) {
              throwIfInterrupted();
              return {
                serviceVerification: {
                  runnerIds: localRunnerIds,
                  activatedBuildCommit: revisions.to,
                },
              };
            }
            lastReason = refusal;
          } catch (error) {
            if (error instanceof DeployFailure && error.reason !== "runner-registration-verification-unavailable") throw error;
            lastReason = error instanceof DeployFailure
              ? `${error.reason}-${error.detail}`
              : error instanceof Error ? error.name : "probe-failed";
          }
        } else {
          try {
            const port = process.env.API_PORT ?? "3000";
            const health = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
            const version = await fetchImpl(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(2_000) });
            const payload = version.ok ? await version.json() : {};
            if (health.ok && version.ok && payload.commit === revisions.to && payload.dirty === false) {
              throwIfInterrupted();
              return {
                serviceVerification: {
                  activatedBuildStamp: {
                    packageName: payload.packageName,
                    commit: payload.commit,
                    dirty: payload.dirty,
                  },
                },
              };
            }
            lastReason = `health-${health.status}-version-${version.status}-commit-${String(payload.commit ?? "unknown")}`;
          } catch (error) {
            if (error instanceof DeployFailure) throw error;
            lastReason = error instanceof Error ? error.name : "probe-failed";
          }
        }
        await serviceVerificationWait(1_000);
      }
      fail("service-verification-failed", lastReason);
    },
    restorePreviousServices: async (attempt) => {
      let runnerRegistrationsBeforeRestore = null;
      let runnerRegistrationSnapshotFailure = null;
      if (deployRole === "runner") {
        try {
          runnerRegistrationsBeforeRestore = localRegistrationSnapshot(
            await readRunnerRegistry({ apiBaseUrl, operatorToken, fetchImpl }),
            localRunnerIds,
          );
        } catch (error) {
          runnerRegistrationSnapshotFailure = error;
        }
      }
      for (const label of serviceLabels) {
        await serviceControl.restart(label, {
          reason: "previous-service-restore-failed",
          allowAfterInterrupt: true,
          timeoutMs: DEPLOY_STEP_TIMEOUT_MS.previousServiceRestore,
          timeoutReason: "previous-service-restore-timeout",
        });
      }
      // The pointer has already been restored by the transaction coordinator.
      // Re-run the complete loaded-definition and readiness proof before the
      // rollback is allowed to become a proven recovery outcome.
      await verifyRecoveredServices(serviceControl, { environment, fetchImpl, labels: serviceLabels });
      if (runnerRegistrationSnapshotFailure !== null) {
        const failure = failureOf(runnerRegistrationSnapshotFailure);
        fail("previous-service-verification-failed", `${failure.reason}-${failure.detail}`);
      }
      if (runnerRegistrationsBeforeRestore !== null) {
        const deadline = Date.now() + serviceVerificationTimeoutMs;
        const previousCommit = attempt.requireFact("revisions").from;
        let lastReason = "not-ready";
        do {
          try {
            const payload = await readRunnerRegistry({ apiBaseUrl, operatorToken, fetchImpl });
            const refusal = runnerRegistrationRefusal({
              payload,
              runnerIds: localRunnerIds,
              before: runnerRegistrationsBeforeRestore,
              targetCommit: previousCommit,
            });
            if (refusal === null) return;
            lastReason = refusal;
          } catch (error) {
            if (error instanceof DeployFailure && error.reason !== "runner-registration-verification-unavailable") throw error;
            lastReason = error instanceof DeployFailure
              ? `${error.reason}-${error.detail}`
              : error instanceof Error ? error.name : "probe-failed";
          }
          await serviceVerificationWait(1_000);
        } while (Date.now() < deadline);
        fail("previous-service-verification-failed", lastReason);
      }
    },
    escalate: writeEscalation,
    markEscalationNotified: async () => markEscalationNotified({ path: ESCALATION_PATH }),
    notify: notifyDeployOutcome,
    log,
  }, deployRole);
};

// The failure path outside the deployment attempt has to know whether this
// process was a dry run, which must never leave an escalation behind.
let deployMode = null;

const main = async () => {
  deployMode = parseDeployArguments(process.argv.slice(2));
  const invocation = await decideInvocation(createDeployStartup(), deployMode);
  if (invocation.exitCode !== undefined) return invocation.exitCode;
  if (invocation.mode === "prune-history") {
    try {
      pruneHistory();
    } finally {
      await invocation.lock.release();
    }
    return 0;
  }
  const deployRole = resolveDeployRoleOrFail();
  const attempt = openDeploymentAttempt({
    deployRoot: REPOSITORY_ROOT,
    targetCommit: invocation.targetCommit,
    transactionId: randomUUID(),
  });
  attempt.establish({
    retryEscalation: invocation.retryEscalation,
    ...(invocation.lock === null ? {} : { resources: [invocation.lock] }),
  });
  const host = createDeployHost({ deployRole });
  if (invocation.mode === "dry-run") {
    const decision = await dryRunDecision(host, attempt, deployRole);
    for (const line of decision.lines) log(line);
    return !decision.artifact.ok || !decision.services.ok || !decision.backup.ok ? 1 : 0;
  }
  const result = await executeUpgrade(host, attempt, deployRole);
  if (result.ok && !result.skipped) pruneHistory();
  return result.ok ? 0 : 1;
};

const entrypoint = (() => {
  try {
    return process.argv[1] !== undefined
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (entrypoint) {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.on(signal, () => {
      if (migrationBarrierRetentionActive) {
        log(`HOLD deploy-barrier signal=${signal}-refused clear-escalation-required`);
        return;
      }
      if (!interruption.interrupt(signal)) return;
      log(`STOP deploy-interrupted detail=${signal}; rolling-back-before-exit-${code}`);
    });
  }

  let exitCode = 1;
  try {
    exitCode = await main();
  } catch (error) {
    const failure = failureOf(error);
    log(`STOP ${failure.reason}${failure.detail ? ` detail=${failure.detail}` : ""}`);
    const dryRunMode = deployMode === "dry-run";
    if (shouldPersistFailure({ dryRun: dryRunMode, reason: failure.reason })) {
      await writeEscalation({ outcome: "failure", reason: failure.reason, detail: failure.detail, from: "unknown", to: "unknown" })
        .catch((writeError) => log(`STOP escalation-write-failed detail=${writeError instanceof Error ? writeError.name : "unknown"}`));
    }
    if (shouldPersistFailure({ dryRun: dryRunMode, reason: failure.reason }) && existsSync(ESCALATION_PATH)) {
      await loadEnvironment()
        .then(retryEscalationNotification)
        .catch(() => log(`STOP inbox-notification-pending reason=${failure.reason}`));
    }
    exitCode = failure.reason === "usage" ? 64 : 1;
  } finally {
    await Promise.allSettled([...activeResources].map((resource) => resource.release()));
    if (prisma) await prisma.$disconnect().catch(() => undefined);
  }
  process.exitCode = interruption.receivedSignal() === "SIGINT" ? 130 : interruption.receivedSignal() === "SIGTERM" ? 143 : exitCode;
}
