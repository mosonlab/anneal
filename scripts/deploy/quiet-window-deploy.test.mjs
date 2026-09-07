import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { RUNTIME_TOOL_FILES } from "../../packages/runner/scripts/build-runtime-tools.mjs";
import { deployPhasesForRole } from "./deploy-phases.mjs";
import { openDeploymentAttempt, parseReleaseArtifactReceipt } from "./deployment-attempt.mjs";
import {
  DeployFailure,
  decideInvocation,
  deployedBuildStampRefusal,
  dryRunDecision,
  executeUpgrade,
  parseDeployArguments,
  quietWindowIsOpen,
} from "./quiet-window-lib.mjs";
import { resolveServiceInventory } from "./service-inventory.mjs";
import {
  DEPLOY_REQUIRED_ARTIFACT_PATHS,
  deployReleaseArtifactPaths,
  workspaceDependencyPaths,
} from "./release-artifacts.mjs";
import { blockingRunsStatement, pruneDeployHistory } from "./deploy-preflight.mjs";
import { createDeploymentLedger, DEPLOYMENT_LEDGER_STATES } from "./deployment-ledger.mjs";
import { createProductionHost } from "./quiet-window-host.mjs";
import {
  checkExistingEscalation,
  selfClearEscalation,
  writeEscalationWithAttempts,
} from "./quiet-window-escalation.mjs";
import {
  clearEscalationOnOperatorRequest,
  ESCALATION_RETRY_CAP,
} from "./quiet-window-escalation-record.mjs";
import { renderLaunchdPlist } from "./install-launchd.mjs";
import { assembleReleaseDirectory } from "./release-directory.mjs";
import { resolveServiceInvocation } from "./launchd-service-wrapper.mjs";
import { buildReleaseArtifact, findReleaseArtifact, verifyReleaseArtifact } from "./release-artifact.mjs";
import {
  autoDeployNoticeBody,
  autoDeployNoticeDedupeKey,
  canonicalSyncNoticeRecord,
  canonicalSyncRefusedLines,
  createDeployHost,
  createDeployStartup,
  createQuietWindowWaitReporter,
  quietWindowHoldLine,
  DEFAULT_SERVICE_OBSERVATION_WINDOW_MS,
  deployRootFromEnvironment,
  HOST_SCOPED_ESCALATION_REASONS,
  loadDeployBinaries,
  loadEnvironment,
  observeReadiness,
  probeSourceRemoteCommit,
  resolveObservationWindowMs,
  verifyStableServicePaths,
} from "./quiet-window-deploy.mjs";
import {
  controlPlaneApiBaseUrl,
  readRunnerTargetRevision,
  requireRunnerDeployPreflight,
  resolveDeployRoleOrFail,
} from "./runner-role-target.mjs";
import { runnerRegistrationRefusal } from "./runner-role-verification.mjs";

const SERVICE_LABELS = resolveServiceInventory().labels;
const LOCAL_RUNNER_IDS = resolveServiceInventory().entries
  .map(({ runnerId }) => runnerId)
  .filter((runnerId) => typeof runnerId === "string");
const revisions = { from: "a".repeat(40), to: "b".repeat(40) };

/** A control-plane host verifies its own loopback API and its own local
 * runners, so its fixtures answer all three endpoints from one seam. */
const controlPlaneEnvironment = (overrides = {}) => ({
  ...process.env,
  OPERATOR_TOKEN: "operator-token",
  ...overrides,
});

const runnerRegistry = ({
  commit,
  lastSeenAt,
  runnerIds = LOCAL_RUNNER_IDS,
  overrides = {},
}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    daemons: runnerIds.map((runnerId) => ({
      runnerId,
      online: true,
      daemonVersion: commit,
      lastSeenAt,
      ...(overrides[runnerId] ?? {}),
    })),
  }),
});

const controlPlaneFetch = ({ commit, registry, onRequest = () => undefined }) => async (url, options) => {
  onRequest({ url, authorization: options?.headers?.authorization });
  if (url.endsWith("/health")) return { ok: true, status: 200 };
  if (url.endsWith("/version")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ packageName: "@anneal/api", commit, dirty: false }),
    };
  }
  if (url.endsWith("/runners")) return registry();
  throw new Error(`unexpected-request-${url}`);
};
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EXPECTED_RUNTIME_PATHS = RUNTIME_TOOL_FILES
  .map(({ destination }) => `packages/runner/dist/runtime-tools/${destination}`)
  .sort();
const RUNTIME_TOOL_MANIFEST_PATH = "packages/runner/scripts/build-runtime-tools.mjs";
// The verifier reads the inventory from scripts/deploy, the directory every
// builder copies whole, so a target-only tool is declared there.
const RUNTIME_TOOL_INVENTORY_PATH = "scripts/deploy/runtime-tool-inventory.mjs";
const COMPLETE_ARTIFACT_PATHS = Object.freeze([
  "packages/api/dist",
  "packages/runner/dist",
  RUNTIME_TOOL_MANIFEST_PATH,
  "packages/db/prisma",
  "packages/db/src",
  "scripts/deploy",
]);
const EXPECTED_PHASES = [
  "read-revisions",
  "check-already-deployed",
  "start-deployment-ledger",
  "prepare-release-artifact",
  "verify-release-artifact",
  "acquire-quiet-window",
  "prepare-operation-workspace",
  "verify-stable-service-paths",
  "backup",
  "guarded-migration",
  "generate-prisma-client",
  "canonical-prompt-sync",
  "verify-runtime-prisma-client",
  "assert-quiet-before-restart",
  "publish-build",
  "restart-services",
  "verify-services",
];
const RUNNER_PHASES = EXPECTED_PHASES.filter((name) => ![
  "backup",
  "guarded-migration",
  "generate-prisma-client",
  "canonical-prompt-sync",
  "verify-runtime-prisma-client",
].includes(name)).flatMap((name) => name === "publish-build"
  ? ["verify-control-plane-target", name]
  : [name]);

const RETRY_ESCALATION = Object.freeze({ reason: "remote-main-unreadable", attempts: 2 });

const fixture = ({ failure = null, builderOutput = null } = {}) => {
  const calls = [];
  const phaseCalls = [];
  const records = [];
  const state = { serving: "previous", escalated: null };
  const step = (name, work = async () => undefined) => async (...args) => {
    calls.push(name);
    phaseCalls.push(name);
    if (failure === name) throw new DeployFailure(`${name}-failed`, "fixture");
    return work(...args);
  };
  const support = (name, work = async () => undefined) => async (...args) => {
    calls.push(name);
    return work(...args);
  };
  const releaseName = `${revisions.to}-${"c".repeat(64)}`;
  const release = {
    releaseName,
    releaseDirectory: `/fixture/releases/${releaseName}`,
    revision: revisions.to,
    digest: "c".repeat(64),
    buildStamp: { packageName: "@anneal/api", commit: revisions.to, dirty: false },
  };
  const resource = (name, extra = {}) => ({
    ...extra,
    release: async () => { calls.push(name); },
  });
  const lock = resource("release-lock");
  const barrier = resource("release-barrier", { verify: async () => true });
  const ledger = {
    start: (metadata) => { records.push({ state: "STARTED", metadata }); },
    record: (name, metadata) => { records.push({ state: name, metadata }); },
  };
  const host = {
    blockingRuns: support("blocking-runs", async () => []),
    artifactState: support("artifact-state", async (attempt) => ({
      ok: true,
      releaseName: `${attempt.targetCommit}-${"c".repeat(64)}`,
    })),
    serviceState: support("service-state", async () => ({ ok: true })),
    backupState: support("backup-state", async () => ({ ok: true, mode: "container" })),
    readRevisions: step("read-revisions", async (attempt) => ({
      revisions: { from: revisions.from, to: attempt.targetCommit },
    })),
    checkAlreadyDeployed: step("check-already-deployed", async (attempt) => {
      assert.equal(attempt.requireFact("revisions").to, revisions.to);
    }),
    startDeploymentLedger: step("start-deployment-ledger", async () => ({ ledger })),
    prepareReleaseArtifact: step("prepare-release-artifact", async () => {
      if (builderOutput !== null && parseReleaseArtifactReceipt(builderOutput) === null) {
        throw new DeployFailure("release-artifact-build-failed", "builder-receipt-invalid");
      }
      return { preparedRelease: release };
    }),
    verifyArtifact: step("verify-release-artifact", async (attempt) => {
      assert.equal(attempt.requireFact("preparedRelease"), release);
      return { verifiedRelease: release };
    }),
    waitForQuiet: step("acquire-quiet-window", async () => ({ barrier, resources: [barrier] })),
    prepareWorkspace: step("prepare-operation-workspace", async (attempt) => {
      assert.equal(attempt.requireFact("verifiedRelease"), release);
      return {
        operationWorkspace: "/fixture/operation",
        resources: [resource("release-workspace")],
      };
    }),
    verifyStableServicePaths: step("verify-stable-service-paths"),
    backup: step("backup", async (attempt) => {
      assert.equal(attempt.requireFact("operationWorkspace"), "/fixture/operation");
      return { backup: { backupIdentity: "fixture.dump" } };
    }),
    guardedMigration: step("guarded-migration", async (attempt) => {
      assert.equal(attempt.requireFact("backup").backupIdentity, "fixture.dump");
      return { migration: { migrationTailBefore: "before", migrationTailAfter: "after" } };
    }),
    generatePrismaClient: step("generate-prisma-client", async (attempt) => {
      assert.equal(attempt.requireFact("operationWorkspace"), "/fixture/operation");
    }),
    syncCanonicalPrompts: step("canonical-prompt-sync", async (attempt) => {
      assert.equal(attempt.requireFact("operationWorkspace"), "/fixture/operation");
    }),
    verifyRuntimePrismaClient: step("verify-runtime-prisma-client", async (attempt) => {
      assert.equal(attempt.requireFact("operationWorkspace"), "/fixture/operation");
    }),
    assertQuietBeforeRestart: step("assert-quiet-before-restart", async (attempt) => {
      assert.equal(await attempt.requireFact("barrier").verify(), true);
    }),
    verifyControlPlaneTarget: step("verify-control-plane-target"),
    publishBuild: step("publish-build", async (attempt) => {
      assert.equal(attempt.requireFact("verifiedRelease"), release);
      state.serving = "candidate";
      return {
        publication: {
          releaseDirectoryIdentity: releaseName,
          releaseIdentity: { name: releaseName, commit: revisions.to, digest: "c".repeat(64) },
          rollback: async () => { calls.push("rollback-build"); state.serving = "previous"; },
        },
      };
    }),
    restartServices: step("restart-services", async (attempt) => {
      assert.equal(attempt.requireFact("publication").releaseDirectoryIdentity, releaseName);
    }),
    verifyServices: step("verify-services", async () => ({
      serviceVerification: { activatedBuildStamp: release.buildStamp },
    })),
    restorePreviousServices: support("restore-services"),
    escalate: async (record) => { calls.push("escalate"); state.escalated = record; },
    notify: async (record) => { calls.push(`notify-${record.outcome}`); },
  };
  const attempt = openDeploymentAttempt({
    deployRoot: "/fixture",
    targetCommit: revisions.to,
    transactionId: "fixture-transaction",
  });
  // Startup decides the invocation and hands the phases the lock it already
  // holds; no phase acquires one.
  attempt.establish({ retryEscalation: RETRY_ESCALATION, resources: [lock] });
  return { host, attempt, calls, phaseCalls, records, state, ledger };
};

const minimalBuildTree = (root, revision) => {
  const dist = join(root, "packages/api/dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.js"), "export {};\n");
  writeFileSync(join(dist, "build-info.json"), `${JSON.stringify({
    packageName: "@anneal/api",
    commit: revision,
    dirty: false,
  })}\n`);
  const prisma = join(root, "packages/db/prisma");
  const source = join(root, "packages/db/src");
  mkdirSync(prisma, { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(prisma, "preflight.ts"), 'import { census } from "../src/schema-census.js";\nvoid census;\n');
  writeFileSync(join(source, "schema-census.ts"), "export const census = true;\n");
  const runnerDist = join(root, "packages/runner/dist");
  mkdirSync(join(runnerDist, "runtime-tools/gate-worker"), { recursive: true });
  writeFileSync(join(runnerDist, "build-info.json"), `${JSON.stringify({
    packageName: "@anneal/runner",
    commit: revision,
    dirty: false,
  })}\n`);
  for (const { source: sourcePath, destination } of RUNTIME_TOOL_FILES) {
    cpSync(join(REPOSITORY_ROOT, sourcePath), join(runnerDist, "runtime-tools", destination));
  }
  mkdirSync(join(root, "packages/runner/scripts"), { recursive: true });
  cpSync(join(REPOSITORY_ROOT, RUNTIME_TOOL_MANIFEST_PATH), join(root, RUNTIME_TOOL_MANIFEST_PATH));
  cpSync(join(REPOSITORY_ROOT, "scripts/deploy"), join(root, "scripts/deploy"), { recursive: true });
};

const removeTree = (root) => {
  const makeWritable = (path) => {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return;
    chmodSync(path, status.mode & 0o777 | (status.isDirectory() ? 0o700 : 0o600));
    if (status.isDirectory()) for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  };
  makeWritable(root);
  rmSync(root, { recursive: true, force: true });
};

const startupFixture = (overrides = {}) => {
  const calls = [];
  const logs = [];
  const lock = { release: async () => { calls.push("release-lock"); } };
  return {
    calls,
    logs,
    lock,
    startup: {
      pollIntervalMs: 60_000,
      log: (line) => { logs.push(line); },
      clearEscalation: () => { calls.push("clear-escalation"); },
      loadEnvironment: async () => { calls.push("load-environment"); },
      loadBinaries: () => { calls.push("load-binaries"); },
      acquireLock: async () => { calls.push("acquire-lock"); return lock; },
      checkEscalation: async () => {
        calls.push("check-escalation");
        return { active: false, retryEscalation: RETRY_ESCALATION };
      },
      readRemoteMain: async () => { calls.push("read-remote-main"); return revisions.to; },
      persistFailure: async (failure) => { calls.push(`persist-failure-${failure.reason}`); },
      ...overrides,
    },
  };
};

test("argv names exactly one mode", () => {
  assert.equal(parseDeployArguments([]), "upgrade");
  assert.equal(parseDeployArguments(["--dry-run"]), "dry-run");
  assert.equal(parseDeployArguments(["--clear-escalation"]), "clear-escalation");
  assert.equal(parseDeployArguments(["--prune-history"]), "prune-history");
  assert.throws(
    () => parseDeployArguments(["--force"]),
    (error) => error instanceof DeployFailure
      && error.reason === "usage"
      && error.detail === "unknown-argument---force",
  );
  assert.throws(
    () => parseDeployArguments(["--dry-run", "--prune-history"]),
    (error) => error.reason === "usage" && error.detail === "modes-are-mutually-exclusive",
  );
});

test("deploy role defaults to control-plane and rejects unknown values", () => {
  assert.equal(resolveDeployRoleOrFail({}), "control-plane");
  assert.equal(resolveDeployRoleOrFail({ AGENTOS_DEPLOY_ROLE: "runner" }), "runner");
  assert.throws(
    () => resolveDeployRoleOrFail({ AGENTOS_DEPLOY_ROLE: "database" }),
    (error) => error instanceof DeployFailure && error.reason === "deploy-role-invalid",
  );
});

test("runner deploy accepts only the shared numeric-loopback API origin policy before fetch", async () => {
  const fixtures = JSON.parse(readFileSync(new URL("../fixtures/local-api-origin-cases.json", import.meta.url), "utf8"));
  let fetchCalls = 0;
  for (const fixtureCase of fixtures.accepted) {
    const environment = { RUNNER_API_URL: fixtureCase.value };
    assert.equal(controlPlaneApiBaseUrl(environment), fixtureCase.value.trim(), fixtureCase.description);
  }
  for (const fixtureCase of fixtures.rejected) {
    const environment = { RUNNER_API_URL: fixtureCase.value };
    assert.throws(
      () => controlPlaneApiBaseUrl(environment),
      (error) => error instanceof DeployFailure
        && error.reason === "control-plane-api-url-invalid"
        && error.detail === fixtureCase.reason,
      fixtureCase.description,
    );
  }
  for (const value of [
    "http://control-plane.example.test:3000",
    "http://user@127.0.0.1:3000",
    "http://127.0.0.1:3000/path",
    "http://127.0.0.1:3000?query=1",
    "http://127.0.0.1:3000#fragment",
  ]) {
    assert.throws(() => controlPlaneApiBaseUrl({ RUNNER_API_URL: value }), /control-plane-api-url-invalid/u);
  }
  await assert.rejects(async () => readRunnerTargetRevision({
    apiBaseUrl: controlPlaneApiBaseUrl({ RUNNER_API_URL: "http://attacker.example:3000" }),
    fetchImpl: async () => { fetchCalls += 1; },
    sourceContainsCommit: async () => true,
  }), /control-plane-api-url-invalid/u);
  assert.equal(fetchCalls, 0);
});

test("runner deploy preflight requires a host-specific prefix and operator credential", () => {
  const configured = {
    AGENTOS_DEPLOY_ROLE: "runner",
    AGENTOS_RUNNER_ID_PREFIX: "mac-",
    RUNNER_API_URL: "http://127.0.0.1:3000",
    OPERATOR_TOKEN: "operator-token",
  };
  assert.deepEqual(requireRunnerDeployPreflight(configured), {
    apiBaseUrl: "http://127.0.0.1:3000",
    operatorToken: "operator-token",
    runnerIdPrefix: "mac-",
  });
  assert.throws(
    () => requireRunnerDeployPreflight({ ...configured, AGENTOS_RUNNER_ID_PREFIX: "" }),
    (error) => error.reason === "runner-id-prefix-required",
  );
  assert.throws(
    () => requireRunnerDeployPreflight({ ...configured, OPERATOR_TOKEN: "" }),
    (error) => error.reason === "runner-registration-verification-unavailable"
      && error.detail === "OPERATOR_TOKEN-missing",
  );
});

test("runner target is the clean control-plane commit only when the source contains it", async () => {
  const commit = "c".repeat(40);
  const calls = [];
  const target = await readRunnerTargetRevision({
    apiBaseUrl: "http://127.0.0.1:3000",
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ service: "@anneal/api", stamped: true, commit, dirty: false }) };
    },
    sourceContainsCommit: async (candidate) => { calls.push(candidate); return true; },
  });
  assert.equal(target, commit);
  assert.deepEqual(calls, ["http://127.0.0.1:3000/version", commit]);
});

test("runner target uses the canonical build-info version parser and exact API package", async () => {
  const commit = "c".repeat(40);
  await assert.rejects(
    readRunnerTargetRevision({
      apiBaseUrl: "http://127.0.0.1:3000",
      fetchImpl: async () => ({ ok: true, json: async () => ({ service: "@agentos/api", stamped: true, commit, dirty: false }) }),
      sourceContainsCommit: async () => true,
    }),
    (error) => error.reason === "control-plane-version-invalid",
  );
});

test("runner target preflight names dirty, unreachable, and missing-source failures", async () => {
  const commit = "d".repeat(40);
  await assert.rejects(
    readRunnerTargetRevision({
      apiBaseUrl: "http://127.0.0.1:3000",
      fetchImpl: async () => ({ ok: true, json: async () => ({ service: "@anneal/api", stamped: true, commit, dirty: true }) }),
      sourceContainsCommit: async () => assert.fail("dirty target must stop before the source check"),
    }),
    (error) => error.reason === "control-plane-build-dirty",
  );
  await assert.rejects(
    readRunnerTargetRevision({
      apiBaseUrl: "http://127.0.0.1:3000",
      fetchImpl: async () => { throw new Error("offline"); },
      sourceContainsCommit: async () => assert.fail("unreachable target must stop before the source check"),
    }),
    (error) => error.reason === "control-plane-version-unreachable",
  );
  await assert.rejects(
    readRunnerTargetRevision({
      apiBaseUrl: "http://127.0.0.1:3000",
      fetchImpl: async () => ({ ok: true, json: async () => ({ service: "@anneal/api", stamped: true, commit, dirty: false }) }),
      sourceContainsCommit: async () => false,
    }),
    (error) => error.reason === "control-plane-commit-unavailable",
  );
});

test("runner source probe fetches only the target commit and distinguishes transport from absence", async () => {
  const commit = "d".repeat(40);
  const calls = [];
  assert.equal(await probeSourceRemoteCommit({
    revision: commit,
    sourceRemote: "origin",
    gitBinary: "/git",
    probeDirectory: "/probe",
    run: async (_program, args, options) => {
      calls.push({ args, timeoutMs: options.timeoutMs, timeoutReason: options.timeoutReason });
      return { code: 0, stdout: args.includes("cat-file") ? "" : `${commit}\trefs/heads/main\n`, stderr: "" };
    },
  }), true);
  assert.deepEqual(calls.map(({ args }) => args), [
    ["ls-remote", "origin"],
    ["init", "--bare", "/probe"],
    ["-C", "/probe", "fetch", "--no-tags", "--depth=1", "origin", commit],
    ["-C", "/probe", "cat-file", "-e", `${commit}^{commit}`],
  ]);
  assert.ok(calls.every(({ timeoutReason }) => timeoutReason === "source-remote-read-timeout"));

  await assert.rejects(probeSourceRemoteCommit({
    revision: commit,
    sourceRemote: "origin",
    gitBinary: "/git",
    probeDirectory: "/probe",
    run: async () => ({ code: 1, stdout: "", stderr: "network is unreachable" }),
  }), (error) => error.reason === "source-remote-unreadable");

  await assert.rejects(probeSourceRemoteCommit({
    revision: commit,
    sourceRemote: "origin",
    gitBinary: "/git",
    probeDirectory: "/probe",
    run: async (_program, args) => args[0] === "ls-remote" || args[0] === "init"
      ? { code: 0, stdout: `${commit}\trefs/heads/main\n`, stderr: "" }
      : { code: 128, stdout: "", stderr: "fatal: remote error: upload-pack: not our ref" },
  }), (error) => error.reason === "control-plane-commit-unavailable");
});

test("already deployed runner target skips the source-remote containment probe", async () => {
  const commit = "e".repeat(40);
  assert.equal(await readRunnerTargetRevision({
    apiBaseUrl: "http://127.0.0.1:3000",
    fetchImpl: async () => ({ ok: true, json: async () => ({ service: "@anneal/api", stamped: true, commit, dirty: false }) }),
    deployedCommit: commit,
    sourceContainsCommit: async () => assert.fail("already deployed target must not probe the source remote"),
  }), commit);
});

test("control-plane binary failures keep the pre-role environment-unreadable wrapping", () => {
  assert.throws(
    () => loadDeployBinaries({
      deployRole: "control-plane",
      resolveExecutableImpl: (variable) => { throw new DeployFailure(`${variable}-missing`); },
      backupConfigurationImpl: () => ({ mode: "host" }),
    }),
    (error) => error.reason === "environment-unreadable"
      && error.detail === "DEPLOY_GIT_BINARY-missing",
  );
});

test("an upgrade decides mode, target and escalation state under one lock acquisition", async () => {
  const state = startupFixture();

  const invocation = await decideInvocation(state.startup, parseDeployArguments([]));

  assert.deepEqual(invocation, {
    mode: "upgrade",
    targetCommit: revisions.to,
    lock: state.lock,
    retryEscalation: RETRY_ESCALATION,
    supersededEscalation: null,
  });
  // The failure this covers: the target read and the deployment each ran their
  // own escalation check, argv parse and lock acquisition. Every one of these
  // happens once, and the lock the phases run under is still held.
  assert.deepEqual(state.calls, [
    "load-environment",
    "load-binaries",
    "acquire-lock",
    "check-escalation",
    "read-remote-main",
  ]);
});

test("a held deploy lock ends the invocation without reading the target", async () => {
  const state = startupFixture({
    acquireLock: async () => null,
    readRemoteMain: async () => assert.fail("a held lock must not read the target"),
  });

  assert.deepEqual(await decideInvocation(state.startup, "upgrade"), { mode: "upgrade", exitCode: 0 });
  assert.deepEqual(state.logs, ["SKIP concurrent-run lock-held"]);
});

test("a recovered stale owner releases the lock and refuses the invocation", async () => {
  const state = startupFixture({
    checkEscalation: async () => assert.fail("a reclaimed owner must not admit a deployment"),
  });
  state.lock.recovered = { pid: 4242 };

  await assert.rejects(
    decideInvocation(state.startup, "upgrade"),
    (error) => error instanceof DeployFailure
      && error.reason === "stale-deploy-owner-recovered"
      && error.detail === "pid-4242",
  );
  assert.deepEqual(state.calls, ["load-environment", "load-binaries", "acquire-lock", "release-lock"]);
});

test("a host-scoped escalation releases the lock and stops before the target read", async () => {
  const state = startupFixture({
    checkEscalation: async () => ({ active: true }),
    readRemoteMain: async () => assert.fail("a host-scoped escalation must not read the target"),
  });

  assert.deepEqual(await decideInvocation(state.startup, "upgrade"), { mode: "upgrade", exitCode: 2 });
  assert.deepEqual(state.calls, ["load-environment", "load-binaries", "acquire-lock", "release-lock"]);
});

const SUPERSEDABLE = Object.freeze({
  failedCommit: revisions.from,
  reason: "release-artifact-build-failed",
  escalatedAt: "2026-09-05T02:00:00.000Z",
});

const commitScopedFixture = (overrides = {}) => {
  const state = startupFixture(overrides);
  state.startup.checkEscalation = async () => {
    state.calls.push("check-escalation");
    return { active: true, supersedable: SUPERSEDABLE };
  };
  return state;
};

test("a commit-scoped escalation admits a newer main commit and records the supersession", async () => {
  // The failure this covers: a build failure on one commit latched the whole
  // job, so the fix commit pushed to main could never deploy itself.
  const state = commitScopedFixture();

  const invocation = await decideInvocation(state.startup, "upgrade");

  assert.deepEqual(invocation, {
    mode: "upgrade",
    targetCommit: revisions.to,
    lock: state.lock,
    retryEscalation: null,
    supersededEscalation: SUPERSEDABLE,
  });
  assert.equal(invocation.supersededEscalation, SUPERSEDABLE);
  assert.deepEqual(state.calls, [
    "load-environment",
    "load-binaries",
    "acquire-lock",
    "check-escalation",
    "read-remote-main",
  ]);
  assert.deepEqual(state.logs, [
    `SUPERSEDE escalation reason=release-artifact-build-failed failed-commit=${revisions.from} target=${revisions.to}`,
  ]);
});

test("the commit a commit-scoped escalation latched is never retried", async () => {
  const state = commitScopedFixture({
    readRemoteMain: async () => { state.calls.push("read-remote-main"); return revisions.from; },
  });

  assert.deepEqual(await decideInvocation(state.startup, "upgrade"), { mode: "upgrade", exitCode: 2 });
  assert.deepEqual(state.logs, [`STOP escalation-active commit-unchanged commit=${revisions.from}`]);
  assert.equal(state.calls.includes("release-lock"), true);
});

test("an unreadable target under a commit-scoped escalation latches without replacing the marker", async () => {
  const state = commitScopedFixture({
    readRemoteMain: async () => { throw new DeployFailure("remote-main-unreadable", "exit-128"); },
  });

  assert.deepEqual(await decideInvocation(state.startup, "upgrade"), { mode: "upgrade", exitCode: 2 });
  assert.deepEqual(state.logs, ["STOP escalation-active target-unreadable reason=remote-main-unreadable"]);
  assert.equal(state.calls.some((call) => call.startsWith("persist-failure")), false);
});

test("a superseded escalation reaches the deployment ledger as an additive fact", (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "anneal-deploy-supersede-ledger-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const attempt = openDeploymentAttempt({
    deployRoot: stateDir,
    targetCommit: revisions.to,
    transactionId: randomUUID(),
  });
  attempt.establish({ revisions, supersededEscalation: SUPERSEDABLE });
  const ledger = createDeploymentLedger({
    stateDir,
    deploymentId: attempt.transactionId,
    targetCommit: attempt.targetCommit,
  });

  ledger.start(attempt.ledgerMetadata());

  const event = JSON.parse(readFileSync(ledger.eventsPath, "utf8").trim().split("\n").at(-1));
  assert.deepEqual(event.superseded_escalation, {
    failed_commit: revisions.from,
    reason: "release-artifact-build-failed",
    escalated_at: "2026-09-05T02:00:00.000Z",
  });
  assert.equal(JSON.parse(readFileSync(ledger.statePath, "utf8")).superseded_escalation.failed_commit, revisions.from);
});

test("the host-scoped reason set covers host state and excludes commit-determined failures", () => {
  for (const reason of [
    "database-backup-failed",
    "release-pointer-activation-failed",
    "release-pointer-rollback-failed",
    "stale-deploy-owner-recovered",
    "unexpected-error",
  ]) {
    assert.equal(HOST_SCOPED_ESCALATION_REASONS.has(reason), true, reason);
  }
  for (const reason of [
    "release-artifact-build-failed",
    "release-artifact-digest-mismatch",
    "guarded-migration-refused",
    "service-verification-failed",
  ]) {
    assert.equal(HOST_SCOPED_ESCALATION_REASONS.has(reason), false, reason);
  }
});

test("an unreadable target persists the failure and releases the lock", async () => {
  const state = startupFixture({
    readRemoteMain: async () => { throw new DeployFailure("remote-main-unreadable", "exit-128"); },
  });

  assert.deepEqual(await decideInvocation(state.startup, "upgrade"), { mode: "upgrade", exitCode: 1 });
  assert.deepEqual(state.calls, [
    "load-environment",
    "load-binaries",
    "acquire-lock",
    "check-escalation",
    "persist-failure-remote-main-unreadable",
    "release-lock",
  ]);
});

test("dry-run resolves the same target without taking the deploy lock", async () => {
  const state = startupFixture({
    acquireLock: async () => assert.fail("dry-run must not take the deploy lock"),
  });

  assert.deepEqual(await decideInvocation(state.startup, "dry-run"), {
    mode: "dry-run",
    targetCommit: revisions.to,
    lock: null,
    retryEscalation: null,
  });
  assert.deepEqual(state.calls, ["load-environment", "load-binaries", "read-remote-main"]);
});

test("clear-escalation finishes startup without the environment, binaries or the lock", async () => {
  const state = startupFixture({
    loadEnvironment: async () => assert.fail("clearing a marker must not require the environment"),
    loadBinaries: () => assert.fail("clearing a marker must not require the binaries"),
    acquireLock: async () => assert.fail("clearing a marker must not take the deploy lock"),
  });

  assert.deepEqual(await decideInvocation(state.startup, "clear-escalation"), {
    mode: "clear-escalation",
    exitCode: 0,
  });
  assert.deepEqual(state.calls, ["clear-escalation"]);
});

test("prune-history holds the lock without the environment or an escalation check", async () => {
  const state = startupFixture({
    loadEnvironment: async () => assert.fail("retention must stay usable while configuration is repaired"),
    checkEscalation: async () => assert.fail("retention consumes no escalation state"),
    readRemoteMain: async () => assert.fail("retention has no target commit"),
  });

  assert.deepEqual(await decideInvocation(state.startup, "prune-history"), {
    mode: "prune-history",
    lock: state.lock,
    retryEscalation: null,
  });
  assert.deepEqual(state.calls, ["load-binaries", "acquire-lock"]);
});

test("an unusable poll interval refuses before any mode work", async () => {
  const state = startupFixture({
    pollIntervalMs: Number.NaN,
    clearEscalation: () => assert.fail("an unusable poll interval must refuse first"),
  });

  await assert.rejects(
    decideInvocation(state.startup, "clear-escalation"),
    (error) => error instanceof DeployFailure
      && error.reason === "environment-invalid"
      && error.detail === "QUIET_WINDOW_POLL_SECONDS-must-be-a-positive-integer",
  );
  assert.deepEqual(state.calls, []);
});

const runDeployWithSharedEnvironment = ({ contents, environment: overrides = {}, prepare = () => {} }) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-deploy-environment-preflight-"));
  mkdirSync(join(root, "shared"), { recursive: true });
  writeFileSync(join(root, "shared/.env"), contents, { mode: 0o600 });
  prepare(root);
  const environment = {
    ...process.env,
    AGENTOS_REPOSITORY_ROOT: root,
  };
  for (const key of [
    "AGENTOS_DEPLOY_ROLE",
    "AGENTOS_RUNNER_ID_PREFIX",
    "RUNNER_API_URL",
    "OPERATOR_TOKEN",
    "RUNNER_TOKEN",
    "DATABASE_URL",
    "FEISHU_DEFAULT_CHAT_ID",
    "GITHUB_READ_TOKEN",
  ]) delete environment[key];
  Object.assign(environment, overrides);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./quiet-window-deploy.mjs", import.meta.url)), "--dry-run"],
    { cwd: REPOSITORY_ROOT, env: environment, encoding: "utf8" },
  );
  return { root, result };
};

test("runner deploy preflight requires OPERATOR_TOKEN", () => {
  const { root, result } = runDeployWithSharedEnvironment({
    contents: "RUNNER_TOKEN=runner-fixture\nRUNNER_API_URL=http://127.0.0.1:1\n",
    environment: {
      AGENTOS_DEPLOY_ROLE: "runner",
      AGENTOS_RUNNER_ID_PREFIX: "runner-host-",
    },
  });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /STOP environment-unreadable detail=OPERATOR_TOKEN-missing/u);
  } finally {
    removeTree(root);
  }
});

test("runner deploy preflight requires RUNNER_TOKEN", () => {
  const { root, result } = runDeployWithSharedEnvironment({
    contents: "OPERATOR_TOKEN=operator-fixture\nRUNNER_API_URL=http://127.0.0.1:1\n",
    environment: { AGENTOS_DEPLOY_ROLE: "runner" },
  });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /STOP environment-unreadable detail=RUNNER_TOKEN-missing/u);
  } finally {
    removeTree(root);
  }
});

test("runner deploy preflight rejects a non-HTTP RUNNER_API_URL", () => {
  const { root, result } = runDeployWithSharedEnvironment({
    contents: "OPERATOR_TOKEN=operator-fixture\nRUNNER_TOKEN=runner-fixture\nRUNNER_API_URL=https://example.com\n",
    environment: { AGENTOS_DEPLOY_ROLE: "runner" },
  });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /STOP control-plane-api-url-invalid detail=scheme-not-http/u);
  } finally {
    removeTree(root);
  }
});

for (const missingKey of ["DATABASE_URL", "FEISHU_DEFAULT_CHAT_ID"]) {
  test(`runner deploy preflight requires ${missingKey}`, () => {
    const contents = Object.entries({
      OPERATOR_TOKEN: "operator-fixture",
      RUNNER_TOKEN: "runner-fixture",
      RUNNER_API_URL: "http://127.0.0.1:1",
      DATABASE_URL: "postgresql://fixture",
      FEISHU_DEFAULT_CHAT_ID: "fixture",
    }).filter(([key]) => key !== missingKey).map(([key, value]) => `${key}=${value}`).join("\n");
    const { root, result } = runDeployWithSharedEnvironment({
      contents,
      environment: { AGENTOS_DEPLOY_ROLE: "runner" },
    });
    try {
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.ok(result.stdout.includes(`STOP environment-unreadable detail=${missingKey}-missing`));
    } finally {
      removeTree(root);
    }
  });
}

test("runner deploy preflight accepts a shared environment without GITHUB_READ_TOKEN", () => {
  const { root, result } = runDeployWithSharedEnvironment({
    contents: [
      "DATABASE_URL=postgresql://fixture",
      "FEISHU_DEFAULT_CHAT_ID=fixture",
      "OPERATOR_TOKEN=operator-fixture",
      "RUNNER_TOKEN=runner-fixture",
      "RUNNER_API_URL=http://127.0.0.1:1",
      "",
    ].join("\n"),
    environment: {
      AGENTOS_DEPLOY_ROLE: "runner",
      AGENTOS_RUNNER_ID_PREFIX: "runner-host-",
    },
    prepare: (root) => {
      const release = join(root, "releases", "fixture", "packages/api/dist");
      mkdirSync(release, { recursive: true });
      writeFileSync(join(release, "build-info.json"), `${JSON.stringify({
        packageName: "@anneal/api",
        commit: "a".repeat(40),
        dirty: false,
      })}\n`);
      symlinkSync("releases/fixture", join(root, "current"), "dir");
    },
  });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /STOP control-plane-version-unreachable/u);
    assert.doesNotMatch(result.stdout, /(?:GITHUB_READ_TOKEN|DATABASE_URL|FEISHU_DEFAULT_CHAT_ID)-missing/u);
  } finally {
    removeTree(root);
  }
});

test("control-plane deploy preflight refuses a shared environment without DATABASE_URL", () => {
  const { root, result } = runDeployWithSharedEnvironment({
    contents: "FEISHU_DEFAULT_CHAT_ID=fixture\nGITHUB_READ_TOKEN=fixture\n",
  });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /STOP environment-unreadable detail=DATABASE_URL-missing/u);
  } finally {
    removeTree(root);
  }
});

test("control-plane deploy preflight refuses a shared environment without FEISHU_DEFAULT_CHAT_ID", () => {
  const { root, result } = runDeployWithSharedEnvironment({
    contents: "DATABASE_URL=postgresql://fixture\nGITHUB_READ_TOKEN=fixture\n",
  });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /STOP environment-unreadable detail=FEISHU_DEFAULT_CHAT_ID-missing/u);
  } finally {
    removeTree(root);
  }
});

test("deploy preflight refuses a shared environment file without GITHUB_READ_TOKEN", () => {
  const { root, result } = runDeployWithSharedEnvironment({
    contents: "DATABASE_URL=postgresql://fixture\nFEISHU_DEFAULT_CHAT_ID=fixture\n",
    // An inherited value must not make a shared/.env missing the required key
    // look deployable.
    environment: { GITHUB_READ_TOKEN: "inherited-fixture-token" },
  });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /STOP environment-unreadable detail=GITHUB_READ_TOKEN-missing/u);
  } finally {
    removeTree(root);
  }
});

const RETRYABLE_ESCALATION_REASONS = new Set([
  "remote-main-unreadable",
  "remote-main-read-timeout",
  "quiet-window-query-failed",
  "deploy-barrier-unavailable",
]);

const escalationFixture = (t, record) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-deploy-escalation-self-heal-"));
  const escalationPath = join(root, "escalated.json");
  const snapshot = `${JSON.stringify(record)}\n`;
  writeFileSync(escalationPath, snapshot, { mode: 0o600 });
  const logs = [];
  const notifications = [];
  let retryNotifications = 0;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    escalationPath,
    snapshot,
    logs,
    notifications,
    options: {
      escalationPath,
      retryableReasons: RETRYABLE_ESCALATION_REASONS,
      hostScopedReasons: HOST_SCOPED_ESCALATION_REASONS,
      retryCap: ESCALATION_RETRY_CAP,
      readRemoteMain: async () => assert.fail("retry admission must not read remote main"),
      retryEscalationNotification: async () => { retryNotifications += 1; },
      log: (line) => logs.push(line),
    },
    retryNotifications: () => retryNotifications,
  };
};

test("retryable escalation self-clears after a successful deployment outcome", async (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "quiet-window-query-failed",
    detail: "platform-database-unreadable",
    attempts: 2,
    from: revisions.from,
    to: revisions.to,
  });
  const checked = await checkExistingEscalation(state.options);
  assert.equal(checked.active, false);
  assert.equal(checked.retryEscalation.attempts, 2);
  assert.equal(state.retryNotifications(), 1);
  const cleared = await selfClearEscalation({
    escalationPath: state.escalationPath,
    retryEscalation: checked.retryEscalation,
    notify: async (record) => { state.notifications.push(record); },
    log: (line) => state.logs.push(line),
  });
  assert.equal(cleared, true);
  assert.equal(existsSync(state.escalationPath), false);
  assert.deepEqual(state.notifications, [{
    outcome: "success",
    reason: "escalation-self-cleared",
    detail: "escalation reason=quiet-window-query-failed attempts=2",
    from: revisions.from,
    to: revisions.to,
  }]);
  assert.deepEqual(state.logs, ["SELF-CLEAR escalation reason=quiet-window-query-failed attempts=2"]);
});

test("repeated retryable failures persist attempts atomically through the cap and then block", async (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "remote-main-unreadable",
    to: "unknown",
    attempts: ESCALATION_RETRY_CAP - 2,
  });
  for (const expected of [ESCALATION_RETRY_CAP - 1, ESCALATION_RETRY_CAP]) {
    const persisted = writeEscalationWithAttempts({
      escalationPath: state.escalationPath,
      record: { outcome: "failure", reason: "remote-main-unreadable" },
      retryableReasons: RETRYABLE_ESCALATION_REASONS,
    });
    assert.equal(persisted.attempts, expected);
    assert.equal(JSON.parse(readFileSync(state.escalationPath, "utf8")).attempts, expected);
    assert.equal(lstatSync(state.escalationPath).mode & 0o777, 0o600);
  }
  const checked = await checkExistingEscalation(state.options);
  assert.deepEqual(checked, { active: true });
  assert.equal(state.retryNotifications(), 1);
  assert.equal(existsSync(state.escalationPath), true);
});

test("retry attempt persistence handles legacy, unreadable, and non-retryable markers", (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "remote-main-unreadable",
  });
  let persisted = writeEscalationWithAttempts({
    escalationPath: state.escalationPath,
    record: { outcome: "failure", reason: "remote-main-unreadable" },
    retryableReasons: RETRYABLE_ESCALATION_REASONS,
  });
  assert.equal(persisted.attempts, 2);

  writeFileSync(state.escalationPath, "not-json\n", { mode: 0o600 });
  persisted = writeEscalationWithAttempts({
    escalationPath: state.escalationPath,
    record: { outcome: "failure", reason: "remote-main-unreadable" },
    retryableReasons: RETRYABLE_ESCALATION_REASONS,
  });
  assert.equal(persisted.attempts, 1);

  persisted = writeEscalationWithAttempts({
    escalationPath: state.escalationPath,
    record: { outcome: "failure", reason: "environment-unreadable" },
    retryableReasons: RETRYABLE_ESCALATION_REASONS,
  });
  assert.equal(Object.hasOwn(persisted, "attempts"), false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(state.escalationPath, "utf8")), "attempts"), false);
});

test("malformed retry attempts fail closed", async (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "remote-main-unreadable",
    to: "unknown",
    attempts: "1",
  });
  const checked = await checkExistingEscalation(state.options);
  assert.deepEqual(checked, { active: true });
  assert.equal(existsSync(state.escalationPath), true);
});

test("non-retryable escalation remains blocked", async (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "environment-unreadable",
    attempts: 1,
  });
  const checked = await checkExistingEscalation(state.options);
  assert.deepEqual(checked, { active: true });
  assert.equal(existsSync(state.escalationPath), true);
});

test("a Prisma client import failure remains manually latched", async (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "database-client-unavailable",
    detail: "prisma-client-import-failed",
  });

  const checked = await checkExistingEscalation(state.options);

  assert.deepEqual(checked, { active: true });
  assert.equal(existsSync(state.escalationPath), true);
});

test("self-clear notification failure keeps the escalation marker", async (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "deploy-barrier-unavailable",
    to: revisions.to,
    attempts: 1,
  });
  const checked = await checkExistingEscalation(state.options);
  const cleared = await selfClearEscalation({
    escalationPath: state.escalationPath,
    retryEscalation: checked.retryEscalation,
    notify: async () => { throw new Error("inbox-unavailable"); },
    log: (line) => state.logs.push(line),
  });
  assert.equal(cleared, false);
  assert.equal(existsSync(state.escalationPath), true);
  assert.equal(readFileSync(state.escalationPath, "utf8"), state.snapshot);
  assert.equal(state.logs.length, 1);
  assert.match(state.logs[0], /^STOP escalation-self-clear-failed /u);
});

test("--clear-escalation removes a latched marker", (t) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-deploy-manual-clear-"));
  const stateDir = join(root, ".agentos-deploy");
  const escalationPath = join(stateDir, "escalated.json");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(escalationPath, JSON.stringify({
    reason: "remote-main-unreadable",
    attempts: ESCALATION_RETRY_CAP,
  }), { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logs = [];

  const cleared = clearEscalationOnOperatorRequest({
    path: escalationPath,
    log: (line) => { logs.push(line); },
  });

  assert.equal(cleared, true);
  assert.equal(existsSync(escalationPath), false);
  assert.deepEqual(logs, ["CLEARED escalation operator-action-required-before-this-command"]);
});

test("--clear-escalation reports the path it looked at when no marker exists", (t) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-deploy-manual-clear-absent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const escalationPath = join(root, ".agentos-deploy", "escalated.json");
  const logs = [];

  const cleared = clearEscalationOnOperatorRequest({
    path: escalationPath,
    log: (line) => { logs.push(line); },
  });

  // The failure this covers: an operator pointed at the wrong root reads
  // "CLEARED" while the real marker is still in place.
  assert.equal(cleared, false);
  assert.deepEqual(logs, [`NO-ESCALATION-TO-CLEAR path=${escalationPath}`]);
});

test("the deploy root is the configured appliance root, not the path reached through", () => {
  // The failure this covers: an invocation through `current` resolved its
  // state, marker and release paths inside the release directory the symlink
  // points into instead of the operator root that owns them.
  assert.equal(
    deployRootFromEnvironment(
      { AGENTOS_REPOSITORY_ROOT: "/srv/anneal" },
      "/srv/anneal/releases/reviewed/scripts/deploy",
    ),
    "/srv/anneal",
  );
  assert.equal(
    deployRootFromEnvironment({}, join(REPOSITORY_ROOT, "scripts", "deploy")),
    resolve(REPOSITORY_ROOT),
  );
});

test("service inventory covers the thirteen production labels", () => {
  assert.equal(SERVICE_LABELS.length, 13);
  assert.equal(SERVICE_LABELS[0], "com.agentos.api");
  assert.equal(SERVICE_LABELS.at(-1), "com.agentos.web");
});

test("runner quiet-window SQL admits only exact local runner ids", () => {
  const defaults = blockingRunsStatement();
  // The database-wide query reads every Run's owning runner without scoping to
  // one: the blocking counts name the runner-only hosts a control-plane deploy
  // waits for.
  assert.equal(defaults.sql.includes('AND "runnerId" IN'), false);
  assert.equal(defaults.sql.includes('"status"::text AS "status", "runnerId" FROM "Run"'), true);
  const scoped = blockingRunsStatement(undefined, ["mac-runner-1", "mac-runner-2"]);
  assert.equal(scoped.sql, 'SELECT "id", "status"::text AS "status", "runnerId" FROM "Run" WHERE "status"::text IN ($1,$2,$3) AND "runnerId" IN ($4,$5) ORDER BY "id"');
  assert.deepEqual(scoped.parameters, ["claimed", "provisioning", "running", "mac-runner-1", "mac-runner-2"]);
});

test("runner verification requires every local daemon to re-register on the target build", () => {
  const targetCommit = "e".repeat(40);
  const before = { "mac-runner-1": "2026-09-04T12:00:00.000Z", "mac-runner-2": "2026-09-04T12:00:01.000Z" };
  const payload = { daemons: [
    { runnerId: "mac-runner-1", online: true, daemonVersion: targetCommit, lastSeenAt: "2026-09-04T12:01:00.000Z" },
    { runnerId: "mac-runner-2", online: true, daemonVersion: targetCommit, lastSeenAt: "2026-09-04T12:01:01.000Z" },
    { runnerId: "vm-runner-1", online: true, daemonVersion: "old", lastSeenAt: "2026-09-04T12:01:02.000Z" },
  ] };
  const options = { payload, runnerIds: ["mac-runner-1", "mac-runner-2"], before, targetCommit };
  assert.equal(runnerRegistrationRefusal(options), null);
  assert.equal(runnerRegistrationRefusal({
    ...options,
    payload: { daemons: payload.daemons.slice(0, 1) },
  }), "runner-missing-mac-runner-2");
  assert.equal(runnerRegistrationRefusal({
    ...options,
    payload: { daemons: payload.daemons.map((daemon) => daemon.runnerId === "mac-runner-2"
      ? { ...daemon, lastSeenAt: before["mac-runner-2"] }
      : daemon) },
  }), "runner-registration-stale-mac-runner-2");
  assert.equal(runnerRegistrationRefusal({
    ...options,
    payload: { daemons: payload.daemons.map((daemon) => daemon.runnerId === "mac-runner-2"
      ? { ...daemon, daemonVersion: "f".repeat(40) }
      : daemon) },
  }), "runner-build-mismatch-mac-runner-2");
});

test("the deploy host restarts and restores every Linux unit in inventory order", async () => {
  const calls = [];
  const serviceControl = {
    platform: "linux",
    restart: async (label, options) => { calls.push({ label, options }); },
    isRunning: async () => true,
    describe: async () => "",
  };
  let recoveryVerified = false;
  let observations = 0;
  const host = createDeployHost({
    serviceControl,
    environment: controlPlaneEnvironment(),
    observationWindowMs: 0,
    fetchImpl: controlPlaneFetch({
      commit: revisions.to,
      registry: () => runnerRegistry({
        commit: revisions.from,
        lastSeenAt: new Date(1_800_000_000_000 + (observations += 1) * 1_000).toISOString(),
      }),
    }),
    verifyRecoveredServices: async (control) => {
      assert.equal(control, serviceControl);
      recoveryVerified = true;
    },
  });
  const attempt = openDeploymentAttempt({
    deployRoot: "/fixture",
    targetCommit: revisions.to,
    transactionId: "inventory-order",
  });
  attempt.establish({ revisions });

  await host.restartServices();
  assert.deepEqual(calls.map(({ label }) => label), SERVICE_LABELS);
  assert.deepEqual(calls.map(({ options }) => options.reason), SERVICE_LABELS.map(() => "service-restart-failed"));

  calls.length = 0;
  await host.restorePreviousServices(attempt);
  assert.deepEqual(calls.map(({ label }) => label), SERVICE_LABELS);
  assert.deepEqual(calls.map(({ options }) => options.reason), SERVICE_LABELS.map(() => "previous-service-restore-failed"));
  assert.equal(recoveryVerified, true);
});

test("runner deploy host restarts only local runners and verifies a newer target-build registration", async () => {
  const targetCommit = "b".repeat(40);
  const restarts = [];
  const requests = [];
  let snapshot = 0;
  const environment = {
    AGENTOS_DEPLOY_ROLE: "runner",
    AGENTOS_RUNNER_COUNT: "2",
    AGENTOS_RUNNER_ID_PREFIX: "mac-",
    RUNNER_API_URL: "http://127.0.0.1:3000",
    OPERATOR_TOKEN: "operator-test-token",
  };
  const response = (lastSeenAt) => ({
    ok: true,
    json: async () => ({ daemons: [
      { runnerId: "mac-runner-1", online: true, daemonVersion: targetCommit, lastSeenAt },
      { runnerId: "mac-runner-2", online: true, daemonVersion: targetCommit, lastSeenAt },
      { runnerId: "vm-runner-1", online: true, daemonVersion: "old", lastSeenAt },
    ] }),
  });
  const host = createDeployHost({
    environment,
    observationWindowMs: 0,
    serviceControl: {
      platform: "darwin",
      restart: async (label) => { restarts.push(label); },
      isRunning: async () => true,
      describe: async () => "state = running",
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.authorization });
      snapshot += 1;
      return response(snapshot === 1 ? "2026-09-04T12:00:00.000Z" : "2026-09-04T12:01:00.000Z");
    },
  });
  const attempt = openDeploymentAttempt({ deployRoot: "/fixture", targetCommit, transactionId: "runner-verification" });
  attempt.establish({ revisions: { from: "a".repeat(40), to: targetCommit } });
  attempt.establish(await host.restartServices(attempt));
  const verified = await host.verifyServices(attempt);
  assert.deepEqual(restarts, ["com.agentos.runner", "com.agentos.runner-2"]);
  const { observedForMs, ...verification } = verified.serviceVerification;
  assert.equal(observedForMs >= 0, true);
  assert.deepEqual(verification, {
    unitsChecked: ["com.agentos.runner", "com.agentos.runner-2"],
    runnerIds: ["mac-runner-1", "mac-runner-2"],
    activatedBuildCommit: targetCommit,
    observationWindowMs: 0,
  });
  assert.deepEqual(requests, [
    { url: "http://127.0.0.1:3000/runners", authorization: "Bearer operator-test-token" },
    { url: "http://127.0.0.1:3000/runners", authorization: "Bearer operator-test-token" },
  ]);
});

test("runner target is re-read after the barrier and a changed control plane stops before publish", async () => {
  const original = "b".repeat(40);
  const advanced = "c".repeat(40);
  const environment = {
    AGENTOS_DEPLOY_ROLE: "runner",
    AGENTOS_RUNNER_COUNT: "1",
    AGENTOS_RUNNER_ID_PREFIX: "mac-",
    RUNNER_API_URL: "http://127.0.0.1:3000",
    OPERATOR_TOKEN: "operator-token",
  };
  const host = createDeployHost({
    environment,
    serviceControl: {
      platform: "darwin",
      restart: async () => {},
      isRunning: async () => true,
      describe: async () => "state = running",
    },
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:3000/version");
      return { ok: true, json: async () => ({ service: "@anneal/api", stamped: true, commit: advanced, dirty: false }) };
    },
  });
  const attempt = openDeploymentAttempt({ deployRoot: "/fixture", targetCommit: original, transactionId: "target-recheck" });
  await assert.rejects(
    host.verifyControlPlaneTarget(attempt),
    (error) => error.reason === "control-plane-version-changed"
      && error.detail === `${original}->${advanced}`,
  );

  const state = fixture({ failure: "verify-control-plane-target" });
  const result = await executeUpgrade(state.host, state.attempt, "runner");
  assert.equal(result.failure.reason, "verify-control-plane-target-failed");
  assert.equal(state.calls.includes("publish-build"), false);
});

test("runner rollback proves every previous-build runner registered after its restart", async () => {
  const previous = "a".repeat(40);
  const candidate = "b".repeat(40);
  const environment = {
    AGENTOS_DEPLOY_ROLE: "runner",
    AGENTOS_RUNNER_COUNT: "2",
    AGENTOS_RUNNER_ID_PREFIX: "mac-",
    RUNNER_API_URL: "http://127.0.0.1:3000",
    OPERATOR_TOKEN: "operator-token",
  };
  const daemon = (runnerId, overrides = {}) => ({
    runnerId,
    online: true,
    daemonVersion: previous,
    lastSeenAt: "2026-09-04T12:01:00.000Z",
    ...overrides,
  });
  const beforePayload = { daemons: [
    daemon("mac-runner-1", { daemonVersion: candidate, lastSeenAt: "2026-09-04T12:00:00.000Z" }),
    daemon("mac-runner-2", { daemonVersion: candidate, lastSeenAt: "2026-09-04T12:00:00.000Z" }),
  ] };
  const attempt = openDeploymentAttempt({ deployRoot: "/fixture", targetCommit: candidate, transactionId: "runner-rollback" });
  attempt.establish({ revisions: { from: previous, to: candidate } });

  for (const [name, payload, refusal] of [
    ["missing", { daemons: [daemon("mac-runner-1")] }, "runner-missing-mac-runner-2"],
    ["stale", { daemons: [daemon("mac-runner-1", { lastSeenAt: "2026-09-04T12:00:00.000Z" }), daemon("mac-runner-2")] }, "runner-registration-stale-mac-runner-1"],
    ["offline", { daemons: [daemon("mac-runner-1", { online: false }), daemon("mac-runner-2")] }, "runner-offline-mac-runner-1"],
    ["wrong-build", { daemons: [daemon("mac-runner-1", { daemonVersion: candidate }), daemon("mac-runner-2")] }, "runner-build-mismatch-mac-runner-1"],
  ]) {
    let reads = 0;
    const host = createDeployHost({
      environment,
      serviceControl: { platform: "darwin", restart: async () => {}, isRunning: async () => true, describe: async () => "state = running" },
      verifyRecoveredServices: async () => {},
      fetchImpl: async () => ({ ok: true, json: async () => reads++ === 0 ? beforePayload : payload }),
      serviceVerificationTimeoutMs: 5,
      serviceVerificationWait: () => new Promise((resolveWait) => setTimeout(resolveWait, 1)),
    });
    await assert.rejects(
      host.restorePreviousServices(attempt),
      (error) => error.reason === "previous-service-verification-failed"
        && error.detail === refusal,
      name,
    );
  }

  const restarts = [];
  let reads = 0;
  const host = createDeployHost({
    environment,
    serviceControl: {
      platform: "darwin",
      restart: async (label) => { restarts.push(label); },
      isRunning: async () => true,
      describe: async () => "state = running",
    },
    verifyRecoveredServices: async () => {},
    fetchImpl: async () => ({
      ok: true,
      json: async () => reads++ === 0 ? beforePayload : { daemons: [daemon("mac-runner-1"), daemon("mac-runner-2")] },
    }),
  });
  await host.restorePreviousServices(attempt);
  assert.deepEqual(restarts, ["com.agentos.runner", "com.agentos.runner-2"]);
});

test("control-plane verification fails naming a local runner that never registers", async () => {
  const environment = controlPlaneEnvironment({ AGENTOS_RUNNER_COUNT: "2", AGENTOS_RUNNER_ID_PREFIX: "vm-" });
  const runnerIds = ["vm-runner-1", "vm-runner-2"];
  let observations = 0;
  const host = createDeployHost({
    environment,
    serviceControl: {
      platform: "linux",
      restart: async () => {},
      isRunning: async () => true,
      describe: async () => "",
    },
    fetchImpl: controlPlaneFetch({
      commit: revisions.to,
      registry: () => runnerRegistry({
        commit: revisions.to,
        lastSeenAt: new Date(1_800_000_000_000 + (observations += 1) * 1_000).toISOString(),
        // The second unit stays active but never reports to the API.
        runnerIds: runnerIds.slice(0, 1),
      }),
    }),
    serviceVerificationTimeoutMs: 5,
    serviceVerificationWait: async () => undefined,
  });
  const attempt = openDeploymentAttempt({
    deployRoot: "/fixture",
    targetCommit: revisions.to,
    transactionId: "control-plane-unregistered",
  });
  attempt.establish({ revisions });
  attempt.establish(await host.restartServices(attempt));
  await assert.rejects(
    host.verifyServices(attempt),
    (error) => error.reason === "service-verification-failed"
      && error.detail === "runner-missing-vm-runner-2",
  );
});

test("control-plane verification fails when a unit dies inside the observation window", async () => {
  const environment = controlPlaneEnvironment({ AGENTOS_RUNNER_COUNT: "2", AGENTOS_RUNNER_ID_PREFIX: "vm-" });
  let samples = 0;
  let observations = 0;
  const host = createDeployHost({
    environment,
    observationWindowMs: 5_000,
    serviceControl: {
      platform: "linux",
      restart: async () => {},
      // Green once, then com.agentos.runner-2 crashes.
      isRunning: async (label) => {
        if (label === "com.agentos.api") samples += 1;
        return !(samples > 1 && label === "com.agentos.runner-2");
      },
      describe: async () => "",
    },
    fetchImpl: controlPlaneFetch({
      commit: revisions.to,
      registry: () => runnerRegistry({
        commit: revisions.to,
        lastSeenAt: new Date(1_800_000_000_000 + (observations += 1) * 1_000).toISOString(),
        runnerIds: ["vm-runner-1", "vm-runner-2"],
      }),
    }),
    serviceVerificationWait: async () => undefined,
  });
  const attempt = openDeploymentAttempt({
    deployRoot: "/fixture",
    targetCommit: revisions.to,
    transactionId: "control-plane-window-regression",
  });
  attempt.establish({ revisions });
  attempt.establish(await host.restartServices(attempt));
  await assert.rejects(
    host.verifyServices(attempt),
    (error) => error.reason === "service-verification-failed"
      && error.detail === "observation-window-regressed-systemd-unavailable-com.agentos.runner-2",
  );
  assert.equal(samples > 1, true, "verification must keep sampling after the first green");
});

test("both roles pass only after the API, every runner and the whole window stay green", async () => {
  const windowMs = 30;
  for (const role of ["control-plane", "runner"]) {
    const runnerIds = role === "runner" ? ["mac-runner-1"] : ["vm-runner-1"];
    const environment = {
      ...controlPlaneEnvironment(),
      AGENTOS_DEPLOY_ROLE: role,
      AGENTOS_RUNNER_COUNT: "1",
      AGENTOS_RUNNER_ID_PREFIX: role === "runner" ? "mac-" : "vm-",
      ...(role === "runner" ? { RUNNER_API_URL: "http://127.0.0.1:3000" } : {}),
    };
    let observations = 0;
    const host = createDeployHost({
      environment,
      deployRole: role,
      observationWindowMs: windowMs,
      serviceControl: {
        platform: "linux",
        restart: async () => {},
        isRunning: async () => true,
        describe: async () => "",
      },
      fetchImpl: controlPlaneFetch({
        commit: revisions.to,
        registry: () => runnerRegistry({
          commit: revisions.to,
          lastSeenAt: new Date(1_800_000_000_000 + (observations += 1) * 1_000).toISOString(),
          runnerIds,
        }),
      }),
      serviceVerificationWait: async () => new Promise((done) => setTimeout(done, 5)),
    });
    const attempt = openDeploymentAttempt({
      deployRoot: "/fixture",
      targetCommit: revisions.to,
      transactionId: `steady-${role}`,
    });
    attempt.establish({ revisions });
    attempt.establish(await host.restartServices(attempt));
    const { serviceVerification } = await host.verifyServices(attempt);
    assert.deepEqual(serviceVerification.runnerIds, runnerIds);
    assert.deepEqual(
      serviceVerification.unitsChecked,
      resolveServiceInventory(environment, role).labels,
    );
    assert.equal(serviceVerification.observationWindowMs, windowMs);
    assert.equal(serviceVerification.observedForMs >= windowMs, true);
    assert.equal(serviceVerification.activatedBuildCommit, revisions.to);
    assert.equal(
      serviceVerification.activatedBuildStamp?.commit ?? null,
      role === "runner" ? null : revisions.to,
    );
  }
});

test("control-plane rollback fails when a local runner does not re-register", async () => {
  const environment = controlPlaneEnvironment({ AGENTOS_RUNNER_COUNT: "2", AGENTOS_RUNNER_ID_PREFIX: "vm-" });
  const runnerIds = ["vm-runner-1", "vm-runner-2"];
  let reads = 0;
  const host = createDeployHost({
    environment,
    verifyRecoveredServices: async () => {},
    serviceControl: {
      platform: "linux",
      restart: async () => {},
      isRunning: async () => true,
      describe: async () => "",
    },
    fetchImpl: controlPlaneFetch({
      commit: revisions.from,
      registry: () => {
        reads += 1;
        return runnerRegistry({
          commit: revisions.from,
          lastSeenAt: reads === 1 ? "2026-09-04T12:00:00.000Z" : "2026-09-04T12:01:00.000Z",
          runnerIds,
          // The second runner never comes back after the restore.
          overrides: reads === 1 ? {} : { "vm-runner-2": { online: false } },
        });
      },
    }),
    serviceVerificationTimeoutMs: 5,
    serviceVerificationWait: async () => undefined,
  });
  const attempt = openDeploymentAttempt({
    deployRoot: "/fixture",
    targetCommit: revisions.to,
    transactionId: "control-plane-rollback",
  });
  attempt.establish({ revisions });
  await assert.rejects(
    host.restorePreviousServices(attempt),
    (error) => error.reason === "previous-service-verification-failed"
      && error.detail === "runner-offline-vm-runner-2",
  );
});

test("the observation window defaults to twenty seconds and is environment-overridable", () => {
  assert.equal(DEFAULT_SERVICE_OBSERVATION_WINDOW_MS, 20_000);
  assert.equal(resolveObservationWindowMs({}), 20_000);
  assert.equal(resolveObservationWindowMs({ AGENTOS_DEPLOY_OBSERVATION_WINDOW_MS: "45000" }), 45_000);
  assert.throws(
    () => resolveObservationWindowMs({ AGENTOS_DEPLOY_OBSERVATION_WINDOW_MS: "20s" }),
    (error) => error.reason === "deploy-observation-window-invalid" && error.detail === "20s",
  );
});

test("rollback re-proves liveness, wrapper binding, and prior API identity on both platforms", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agentos-rollback-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = "a".repeat(40);
  const releaseRoot = join(root, "releases", release);
  for (const path of [
    "packages/api/dist/index.js",
    "packages/inbox/dist/index.js",
    "packages/runner/dist/index.js",
    "node_modules/vite/bin/vite.js",
  ]) {
    const file = join(releaseRoot, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture\n");
  }
  mkdirSync(join(releaseRoot, "apps/web"), { recursive: true });
  mkdirSync(join(root, "shared"), { recursive: true });
  writeFileSync(join(root, "shared/.env"), "DATABASE_URL=configured\n");
  symlinkSync(releaseRoot, join(root, "current"));
  const wrapper = join(root, "shared/bin/agentos-service-wrapper.mjs");
  const fetchImpl = async (url) => url.endsWith("/health")
    ? { ok: true }
    : { ok: true, json: async () => ({ commit: release, dirty: false }) };
  let observations = 0;
  const hostFetch = controlPlaneFetch({
    commit: release,
    registry: () => runnerRegistry({
      commit: release,
      lastSeenAt: new Date(1_800_000_000_000 + (observations += 1) * 1_000).toISOString(),
    }),
  });
  const rollbackAttempt = openDeploymentAttempt({
    deployRoot: "/fixture",
    targetCommit: "b".repeat(40),
    transactionId: "rollback-proof",
  });
  rollbackAttempt.establish({ revisions: { from: release, to: "b".repeat(40) } });
  assert.equal(resolveServiceInvocation({
    repositoryRoot: root,
    label: "com.agentos.api",
    environment: { DEPLOY_NODE_BINARY: "/usr/bin/node" },
  }).releaseCommit, release);

  for (const platform of ["linux", "darwin"]) {
    const calls = [];
    const control = {
      platform,
      restart: async (label) => { calls.push(["restart", label]); },
      isRunning: async (label) => { calls.push(["is-active", label]); return true; },
      describe: async (label) => {
        calls.push(["show", label]);
        return `${platform === "darwin" ? "state = running\n" : ""}/usr/bin/node ${wrapper} ${label}\n`;
      },
    };
    const host = createDeployHost({
      serviceControl: control,
      environment: controlPlaneEnvironment(),
      observationWindowMs: 0,
      fetchImpl: hostFetch,
      verifyRecoveredServices: (serviceControl) => {
        assert.equal(existsSync(join(root, "current")), true);
        return verifyStableServicePaths(serviceControl, {
          repositoryRoot: root,
          environment: { DEPLOY_NODE_BINARY: "/usr/bin/node" },
          fetchImpl,
        });
      },
    });
    await host.restorePreviousServices(rollbackAttempt);
    const expected = [
      ...SERVICE_LABELS.map((label) => ["restart", label]),
      ...SERVICE_LABELS.flatMap((label) => platform === "linux"
        ? [["is-active", label], ["show", label]]
        : [["show", label]]),
    ];
    assert.deepEqual(calls, expected);
  }
  for (const failure of ["inactive", "wrong-wrapper"]) {
    const control = {
      platform: "linux",
      restart: async () => {},
      isRunning: async () => failure !== "inactive",
      describe: async (label) => `/usr/bin/node ${failure === "wrong-wrapper" ? "/wrong/wrapper.mjs" : wrapper} ${label}\n`,
    };
    const host = createDeployHost({
      serviceControl: control,
      environment: controlPlaneEnvironment(),
      observationWindowMs: 0,
      fetchImpl: hostFetch,
      serviceVerificationTimeoutMs: 5,
      serviceVerificationWait: async () => {},
      verifyRecoveredServices: (serviceControl) => verifyStableServicePaths(serviceControl, {
        repositoryRoot: root,
        environment: { DEPLOY_NODE_BINARY: "/usr/bin/node" },
        fetchImpl,
      }),
    });
    await assert.rejects(
      host.restorePreviousServices(rollbackAttempt),
      /service-start-failed:com\.agentos\.api/u,
    );
  }
});

test("a Linux service-control denial aborts restart traversal", async () => {
  const calls = [];
  const serviceControl = {
    platform: "linux",
    restart: async (label) => {
      calls.push(label);
      throw new DeployFailure("service-control-denied", `${label}.service`);
    },
    isRunning: async () => true,
    describe: async () => "",
  };
  const host = createDeployHost({
    serviceControl,
    environment: controlPlaneEnvironment(),
    fetchImpl: controlPlaneFetch({
      commit: revisions.to,
      registry: () => runnerRegistry({ commit: revisions.from, lastSeenAt: "2026-09-04T12:00:00.000Z" }),
    }),
  });

  await assert.rejects(
    host.restartServices(),
    (error) => error instanceof DeployFailure
      && error.reason === "service-control-denied"
      && error.detail === "com.agentos.api.service",
  );
  assert.deepEqual(calls, ["com.agentos.api"]);
});

test("quiet-window predicate blocks only active run states", () => {
  for (const status of ["claimed", "provisioning", "running", "RUNNING"]) assert.equal(quietWindowIsOpen([{ status }]), false);
  for (const status of ["queued", "waiting-inbox", "succeeded", "failed"]) assert.equal(quietWindowIsOpen([{ status }]), true);
});

test("deployed build stamps require an exact clean commit", () => {
  assert.equal(deployedBuildStampRefusal({ packageName: "@anneal/api", commit: revisions.to, dirty: false }), null);
  assert.equal(deployedBuildStampRefusal({ packageName: "@anneal/api", commit: revisions.to, dirty: true }), "dirty-build");
  assert.equal(deployedBuildStampRefusal({ packageName: "@other/api", commit: revisions.to, dirty: false }), "unexpected-package-name");
});

test("canonical sync refusal output reaches the successful deploy Inbox notice", () => {
  const refusal = "REFUSED foreign-project: Agent prompt structure drift";
  const record = canonicalSyncNoticeRecord({
    outcome: "success",
    reason: "deployed",
    from: revisions.from,
    to: revisions.to,
  }, canonicalSyncRefusedLines(`SYNC foreign-project\n${refusal}\nSYNC healthy-project\n`));

  assert.equal(
    autoDeployNoticeBody(record),
    `[auto-deploy] success: ${revisions.from} -> ${revisions.to}; reason=deployed; detail=${refusal}`,
  );
});

test("production host requires every deploy phase and every read-only method", () => {
  assert.throws(() => createProductionHost({}), /production-host-adapter-missing:readRevisions/u);
  const required = [
    ...deployPhasesForRole("control-plane").map(({ hostMethod }) => hostMethod),
    "blockingRuns",
    "artifactState",
    "serviceState",
    "backupState",
    "restorePreviousServices",
    "escalate",
    "notify",
  ];
  for (const hostMethod of required) {
    const { host } = fixture();
    delete host[hostMethod];
    assert.throws(
      () => createProductionHost(host),
      new RegExp(`production-host-adapter-missing:${hostMethod}`, "u"),
    );
  }
  const { host: runnerHost } = fixture();
  delete runnerHost.verifyControlPlaneTarget;
  assert.throws(
    () => createProductionHost(runnerHost, "runner"),
    /production-host-adapter-missing:verifyControlPlaneTarget/u,
  );
});

test("release artifact inventory copies and verifies deploy runtime and workspace dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "anneal-artifact-inventory-"));
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-inventory-release-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
  for (const workspace of ["apps/web", "packages/api"]) {
    mkdirSync(join(root, workspace), { recursive: true });
    writeFileSync(join(root, workspace, "package.json"), "{}\n");
  }
  const adapterPath = "scripts/merge-lease-adapter.mjs";
  const adapterContents = "export const fixture = true;\n";
  minimalBuildTree(root, revisions.to);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, adapterPath), adapterContents);
  try {
    assert.deepEqual(workspaceDependencyPaths(root), ["apps/web/node_modules", "packages/api/node_modules"]);
    const paths = deployReleaseArtifactPaths(root);
    assert.ok(paths.includes("scripts/deploy"));
    assert.ok(paths.includes(RUNTIME_TOOL_MANIFEST_PATH));
    assert.ok(paths.includes(adapterPath));
    assert.ok(paths.includes("packages/db/src"));
    for (const path of DEPLOY_REQUIRED_ARTIFACT_PATHS) assert.ok(paths.includes(path), path);
    const assembled = assembleReleaseDirectory({
      stageRoot: root,
      deployRoot,
      revision: revisions.to,
      artifactPaths: paths.filter((path) => [
        ...COMPLETE_ARTIFACT_PATHS,
        adapterPath,
      ].includes(path)),
      optionalArtifactPaths: [],
    });
    const verified = verifyReleaseArtifact({
      deployRoot,
      revision: revisions.to,
      releaseName: assembled.releaseName,
    });
    assert.equal(readFileSync(join(verified.releaseDirectory, adapterPath), "utf8"), adapterContents);
    const adapterEvidence = verified.files.find(({ path }) => path === adapterPath);
    assert.equal(adapterEvidence?.type, "file");
    assert.equal(adapterEvidence?.size, Buffer.byteLength(adapterContents));
    assert.match(adapterEvidence?.sha256 ?? "", /^[0-9a-f]{64}$/u);
  } finally {
    removeTree(root);
    removeTree(deployRoot);
  }
});

test("fixture executes the whole deploy sequence with explicit attempt facts", async () => {
  const { host, attempt, calls, phaseCalls, records } = fixture();
  assert.deepEqual(await executeUpgrade(host, attempt), { ok: true });
  assert.deepEqual(phaseCalls, EXPECTED_PHASES);
  assert.deepEqual(calls, [
    ...EXPECTED_PHASES,
    "notify-success",
    "release-workspace",
    "release-barrier",
    "release-lock",
  ]);
  assert.deepEqual(records.map(({ state }) => state), [
    "STARTED", "ARTIFACT_PREPARED", "ARTIFACT_VERIFIED", "BACKED_UP", "SCHEMA_ADVANCED", "ACTIVATED", "VERIFIED", "SUCCEEDED",
  ]);
});

test("runner role selects its phase sequence from the role column and never calls database phases", async () => {
  assert.deepEqual(deployPhasesForRole("runner").map(({ name }) => name), RUNNER_PHASES);
  const { host, attempt, phaseCalls } = fixture();
  assert.deepEqual(await executeUpgrade(host, attempt, "runner"), { ok: true });
  assert.deepEqual(phaseCalls, RUNNER_PHASES);
});

test("a successful attempt invokes self-clear before releasing its resources", async () => {
  const { host, attempt, calls } = fixture();
  let clearCalls = 0;
  // Startup decided the retryable escalation; the phases read it off the
  // attempt rather than out of host state.
  host.selfClearEscalation = async (deployment) => {
    assert.equal(deployment.fact("retryEscalation"), RETRY_ESCALATION);
    clearCalls += 1;
    calls.push("self-clear");
  };
  assert.deepEqual(await executeUpgrade(host, attempt), { ok: true });
  assert.equal(clearCalls, 1);
  assert.ok(calls.indexOf("self-clear") < calls.indexOf("release-lock"));
});

test("an already-deployed no-op also invokes self-clear", async () => {
  const { host, attempt, calls } = fixture();
  let clearCalls = 0;
  host.checkAlreadyDeployed = async () => ({ skip: "already-deployed" });
  host.selfClearEscalation = async () => {
    clearCalls += 1;
    calls.push("self-clear");
  };
  const result = await executeUpgrade(host, attempt);
  assert.deepEqual(result, { ok: true, skipped: "already-deployed" });
  assert.equal(clearCalls, 1);
  assert.ok(calls.indexOf("self-clear") < calls.indexOf("release-lock"));
});

test("missing artifact records FAILED without quiet-window, build, or activation", async () => {
  const { host, attempt, calls, records } = fixture({ failure: "verify-release-artifact" });
  const result = await executeUpgrade(host, attempt);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "verify-release-artifact-failed");
  assert.equal(calls.includes("acquire-quiet-window"), false);
  assert.equal(calls.includes("publish-build"), false);
  assert.equal(calls.some((call) => /dependencies|install/u.test(call)), false);
  assert.equal(records.at(-1).state, "FAILED");
});

test("malformed builder receipt records FAILED before the quiet window opens", async () => {
  const { host, attempt, calls, records } = fixture({ builderOutput: "RELEASE-ARTIFACT {not-json}\n" });
  const result = await executeUpgrade(host, attempt);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "release-artifact-build-failed");
  assert.equal(result.failure.detail, "builder-receipt-invalid");
  assert.deepEqual(records.map(({ state }) => state), ["STARTED", "FAILED"]);
  assert.equal(calls.includes("acquire-quiet-window"), false);
});

test("each independently listed deploy phase stops execution at its first failure", async () => {
  for (const [index, name] of EXPECTED_PHASES.entries()) {
    const { host, attempt, phaseCalls } = fixture({ failure: name });
    const result = await executeUpgrade(host, attempt);
    assert.equal(result.ok, false, name);
    assert.deepEqual(phaseCalls, EXPECTED_PHASES.slice(0, index + 1), name);
  }
});

test("service verification failure rolls back before restoring services", async () => {
  const { host, attempt, calls, state } = fixture({ failure: "verify-services" });
  const result = await executeUpgrade(host, attempt);
  assert.equal(result.ok, false);
  assert.equal(state.serving, "previous");
  assert.ok(calls.indexOf("rollback-build") < calls.indexOf("restore-services"));
});

test("runner registration verification failure uses the same rollback and restart recovery", async () => {
  const { host, attempt, calls, phaseCalls, state } = fixture({ failure: "verify-services" });
  const result = await executeUpgrade(host, attempt, "runner");
  assert.equal(result.ok, false);
  assert.equal(state.serving, "previous");
  assert.deepEqual(phaseCalls, RUNNER_PHASES);
  assert.ok(calls.indexOf("rollback-build") < calls.indexOf("restore-services"));
});

test("runner phase table rechecks the control-plane target immediately before publication", () => {
  const names = deployPhasesForRole("runner").map(({ name }) => name);
  assert.equal(names.indexOf("verify-control-plane-target") + 1, names.indexOf("publish-build"));
  assert.equal(deployPhasesForRole("control-plane").some(({ name }) => name === "verify-control-plane-target"), false);
});

test("standalone builder creates a verified exact-commit release", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-builder-"));
  const { artifact, commands } = buildWithScriptedClone({ deployRoot, cloneOutcomes: [null] });
  assert.equal(artifact.revision, revisions.to);
  assert.deepEqual(artifact.dbMaintenanceSourceImports, ["schema-census"]);
  assert.match(artifact.releaseName, new RegExp(`^${revisions.to}-[0-9a-f]{64}$`, "u"));
  assert.equal(findReleaseArtifact({ deployRoot, revision: revisions.to }).releaseName, artifact.releaseName);
  for (const { source, destination } of RUNTIME_TOOL_FILES) {
    assert.deepEqual(
      readFileSync(join(artifact.releaseDirectory, "packages/runner/dist/runtime-tools", destination)),
      readFileSync(join(REPOSITORY_ROOT, source)),
    );
  }
  assert.deepEqual(
    artifact.files.filter(({ path }) => path.startsWith("packages/runner/dist/runtime-tools/"))
      .map(({ path }) => path),
    EXPECTED_RUNTIME_PATHS,
  );
  assert.equal(commands.length, 4);
  assert.deepEqual(commands.slice(1).map(({ args }) => args.slice(-2)), [
    ["--detach", revisions.to], ["/npm", "ci"], ["run", "build"],
  ]);
  removeTree(deployRoot);
});

const capturedFailure = (build) => {
  try {
    build();
  } catch (error) {
    return error;
  }
  return assert.fail("expected the build to fail");
};

/** What the builder's own runner raises after `git clone` exits 128. */
const cloneFailure = (stderr) => Object.assign(
  new DeployFailure("release-artifact-source-unavailable", "exit-128"),
  { status: 128, stderr },
);

/** Drive the standalone builder with a fake git whose clone outcomes are
 * scripted per attempt. `null` succeeds; an error is thrown as the real
 * runner would after a failed `git clone`. */
const buildWithScriptedClone = ({ deployRoot, cloneOutcomes, commands = [], waits = [] }) => {
  let attempt = 0;
  const artifact = buildReleaseArtifact({
    deployRoot,
    revision: revisions.to,
    sourceRemote: "https://example.invalid/anneal.git",
    gitBinary: "/git",
    nodeBinary: "/node",
    npmBinary: "/npm",
    requiredPaths: ["packages/api/dist", "packages/runner/dist"],
    artifactPaths: () => COMPLETE_ARTIFACT_PATHS,
    optionalArtifactPaths: () => [],
    sleep: (ms) => waits.push(ms),
    execute: (program, args, options = {}) => {
      commands.push({ program, args });
      if (args[0] === "clone") {
        const outcome = cloneOutcomes[attempt++];
        if (outcome) throw outcome;
        return undefined;
      }
      if (args.join(" ") === "/npm run build") minimalBuildTree(options.cwd, revisions.to);
      return undefined;
    },
  });
  return { artifact, commands, waits };
};

test("a transient clone failure is retried and the receipt records the attempts", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-clone-retry-"));
  const tlsFailure = () => cloneFailure(
    "fatal: unable to access 'https://example.invalid/anneal.git/': gnutls_handshake() failed: The TLS connection was non-properly terminated\n",
  );
  const { artifact, commands, waits } = buildWithScriptedClone({
    deployRoot,
    cloneOutcomes: [tlsFailure(), tlsFailure(), null],
  });
  assert.equal(artifact.cloneAttempts, 3);
  assert.equal(artifact.revision, revisions.to);
  assert.equal(commands.filter(({ args }) => args[0] === "clone").length, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits.every((ms) => ms > 0));
  removeTree(deployRoot);
});

test("builder CLI emits the retry receipt and preserves verbose successful clone stderr", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-cli-"));
  try {
    const source = join(deployRoot, "fixture");
    minimalBuildTree(source, revisions.to);
    writeFileSync(join(source, "package.json"), JSON.stringify({ workspaces: ["packages/*", "apps/*"] }));
    for (const path of DEPLOY_REQUIRED_ARTIFACT_PATHS) mkdirSync(join(source, path), { recursive: true });
    for (const path of deployReleaseArtifactPaths(source)) {
      if (existsSync(join(source, path))) continue;
      mkdirSync(dirname(join(source, path)), { recursive: true });
      writeFileSync(join(source, path), "");
    }
    const git = join(deployRoot, "fake-git.cjs");
    const count = join(deployRoot, "attempts");
    writeFileSync(git, `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "clone") {
  const countPath = ${JSON.stringify(count)};
  const attempt = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) + 1 : 1;
  fs.writeFileSync(countPath, String(attempt));
  if (attempt < 3) {
    fs.writeSync(2, "gnutls_handshake() failed: The TLS connection was non-properly terminated\\n");
    process.exit(128);
  }
  fs.writeSync(2, "x".repeat(2 * 1024 * 1024) + "successful clone warning\\n");
  fs.cpSync(${JSON.stringify(source)}, process.argv.at(-1), { recursive: true });
}
`);
    chmodSync(git, 0o755);
    const npm = join(deployRoot, "fake-npm.cjs");
    writeFileSync(npm, "");
    const result = spawnSync(process.execPath, [
      join(REPOSITORY_ROOT, "scripts/deploy/build-release-artifact.mjs"), revisions.to,
    ], {
      env: {
        ...process.env,
        AGENTOS_REPOSITORY_ROOT: deployRoot,
        DEPLOY_SOURCE_REMOTE: "https://example.invalid/anneal.git",
        DEPLOY_GIT_BINARY: git,
        DEPLOY_NODE_BINARY: process.execPath,
        DEPLOY_NPM_BINARY: npm,
      },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr?.slice(-4000));
    const line = result.stdout.split("\n").find((line) => line.startsWith("RELEASE-ARTIFACT "));
    assert.ok(line, result.stdout);
    const receipt = JSON.parse(line.slice("RELEASE-ARTIFACT ".length));
    assert.equal(receipt.cloneAttempts, 3);
    assert.equal(receipt.revision, revisions.to);
    assert.equal(readFileSync(count, "utf8"), "3");
    assert.equal(findReleaseArtifact({ deployRoot, revision: revisions.to }).releaseName, receipt.releaseName);
    assert.match(result.stderr, /successful clone warning/u);
    assert.equal(result.stderr.match(/gnutls_handshake/g)?.length, 2);
  } finally {
    removeTree(deployRoot);
  }
});

test("an exhausted clone retry keeps the source-unavailable failure shape", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-clone-exhausted-"));
  const commands = [];
  const waits = [];
  const failure = capturedFailure(() => buildWithScriptedClone({
    deployRoot,
    commands,
    waits,
    cloneOutcomes: [0, 1, 2].map(() => cloneFailure("fatal: unable to access: Connection reset by peer\n")),
  }));
  assert.equal(commands.filter(({ args }) => args[0] === "clone").length, 3);
  assert.deepEqual(waits, [2_000, 8_000]);
  assert.ok(failure instanceof DeployFailure);
  assert.equal(failure.reason, "release-artifact-source-unavailable");
  assert.equal(failure.detail, "exit-128");
  removeTree(deployRoot);
});

test("a clone failure that is not network-shaped is not retried", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-clone-fatal-"));
  const commands = [];
  const failure = capturedFailure(() => buildWithScriptedClone({
    deployRoot,
    commands,
    cloneOutcomes: [0, 1, 2].map(() => cloneFailure("fatal: not a git repository\n")),
  }));
  assert.ok(failure instanceof DeployFailure);
  assert.equal(failure.reason, "release-artifact-source-unavailable");
  assert.equal(failure.detail, "exit-128");
  assert.equal(commands.filter(({ args }) => args[0] === "clone").length, 1);
  removeTree(deployRoot);
});

test("artifact verification loads the verifier shipped by the target release", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-target-verifier-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  mkdirSync(join(source, "scripts/deploy"), { recursive: true });
  writeFileSync(join(source, "scripts/deploy/release-artifact.mjs"), [
    "export const verifyReleaseArtifact = ({ revision, releaseName }) => ({",
    '  verifier: "target",',
    "  revision,",
    "  releaseName,",
    "});",
    "",
  ].join("\n"));
  try {
    const assembled = assembleReleaseDirectory({
      stageRoot: source,
      deployRoot,
      revision: revisions.to,
      artifactPaths: ["packages/api/dist", "packages/runner/dist", "packages/db/prisma", "packages/db/src", "scripts/deploy"],
      optionalArtifactPaths: [],
    });
    assert.deepEqual(
      verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
      { verifier: "target", revision: revisions.to, releaseName: assembled.releaseName },
    );
  } finally {
    removeTree(deployRoot);
  }
});

test("artifact verification rejects a missing target verifier", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-missing-target-verifier-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  try {
    const assembled = assembleReleaseDirectory({
      stageRoot: source,
      deployRoot,
      revision: revisions.to,
      artifactPaths: COMPLETE_ARTIFACT_PATHS.filter((path) => path !== "scripts/deploy"),
      optionalArtifactPaths: [],
    });
    assert.throws(
      () => verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
      (error) => error instanceof DeployFailure
        && error.reason === "release-artifact-invalid"
        && error.detail === "target-verifier-missing",
    );
  } finally {
    removeTree(deployRoot);
  }
});

test("a target runtime-tool addition passes its target inventory verifier", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-target-runtime-tool-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  const targetManifestPath = join(source, RUNTIME_TOOL_INVENTORY_PATH);
  const targetManifest = readFileSync(targetManifestPath, "utf8").replace(
    "export const RUNTIME_TOOL_FILES = Object.freeze([",
    'export const RUNTIME_TOOL_FILES = Object.freeze([\n  Object.freeze({ source: "target-only.sh", destination: "new-tools/nested/new-target-tool.sh" }),',
  );
  writeFileSync(targetManifestPath, targetManifest);
  mkdirSync(join(source, "packages/runner/dist/runtime-tools/new-tools/nested"), { recursive: true });
  writeFileSync(join(source, "packages/runner/dist/runtime-tools/new-tools/nested/new-target-tool.sh"), "target tool\n");
  try {
    const assembled = assembleReleaseDirectory({
      stageRoot: source,
      deployRoot,
      revision: revisions.to,
      artifactPaths: COMPLETE_ARTIFACT_PATHS,
      optionalArtifactPaths: [],
    });
    const verified = verifyReleaseArtifact({
      deployRoot,
      revision: revisions.to,
      releaseName: assembled.releaseName,
    });
    assert.ok(verified.runtimeTools.files.includes("packages/runner/dist/runtime-tools/new-tools/nested/new-target-tool.sh"));
  } finally {
    removeTree(deployRoot);
  }
});

test("standalone builder verifies with the target tree before cleanup", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-target-build-verifier-"));
  const commands = [];
  const targetVerifier = [
    "export const verifyReleaseArtifact = ({ revision, releaseName }) => ({",
    '  verifier: "target-build",',
    "  revision,",
    "  releaseName,",
    "});",
    "",
  ].join("\n");
  try {
    const artifact = buildReleaseArtifact({
      deployRoot,
      revision: revisions.to,
      sourceRemote: "https://example.invalid/anneal.git",
      gitBinary: "/git",
      nodeBinary: "/node",
      npmBinary: "/npm",
      requiredPaths: ["packages/api/dist", "packages/runner/dist"],
      artifactPaths: () => ["packages/api/dist", "packages/runner/dist", "packages/db/prisma", "packages/db/src", "scripts/deploy"],
      optionalArtifactPaths: () => [],
      execute: (program, args, options = {}) => {
        commands.push({ program, args });
        if (args.join(" ") === "/npm run build") {
          minimalBuildTree(options.cwd, revisions.to);
          mkdirSync(join(options.cwd, "scripts/deploy"), { recursive: true });
          writeFileSync(join(options.cwd, "scripts/deploy/release-artifact.mjs"), targetVerifier);
        }
      },
    });
    assert.deepEqual(artifact.verifier, "target-build");
    assert.equal(commands.length, 4);
  } finally {
    removeTree(deployRoot);
  }
});

test("standalone builder passes the target tree to an injected verifier", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-injected-verifier-root-"));
  let verifierRoot;
  try {
    buildReleaseArtifact({
      deployRoot,
      revision: revisions.to,
      sourceRemote: "https://example.invalid/anneal.git",
      gitBinary: "/git",
      nodeBinary: "/node",
      npmBinary: "/npm",
      requiredPaths: ["packages/api/dist", "packages/runner/dist"],
      artifactPaths: () => COMPLETE_ARTIFACT_PATHS,
      optionalArtifactPaths: () => [],
      execute: (_program, args, options = {}) => {
        if (args.join(" ") === "/npm run build") minimalBuildTree(options.cwd, revisions.to);
      },
      verify: (options) => {
        verifierRoot = options.verifierRoot;
        assert.equal(existsSync(join(verifierRoot, "scripts/deploy/release-artifact.mjs")), true);
        return { verified: true };
      },
    });
    assert.equal(typeof verifierRoot, "string");
    assert.equal(existsSync(verifierRoot), false);
  } finally {
    removeTree(deployRoot);
  }
});

test("target verifier failures retain their deploy failure reason", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-target-verifier-failure-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  mkdirSync(join(source, "scripts/deploy"), { recursive: true });
  writeFileSync(join(source, "scripts/deploy/release-artifact.mjs"), [
    "export const verifyReleaseArtifact = () => {",
    '  const error = new Error("target inventory mismatch");',
    '  error.name = "DeployFailure";',
    '  error.reason = "release-artifact-runtime-incomplete";',
    '  error.detail = "target-inventory-mismatch";',
    "  throw error;",
    "};",
    "",
  ].join("\n"));
  try {
    const assembled = assembleReleaseDirectory({
      stageRoot: source,
      deployRoot,
      revision: revisions.to,
      artifactPaths: ["packages/api/dist", "packages/runner/dist", "packages/db/prisma", "packages/db/src", "scripts/deploy"],
      optionalArtifactPaths: [],
    });
    assert.throws(
      () => verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
      (error) => error instanceof DeployFailure
        && error.reason === "release-artifact-runtime-incomplete"
        && error.detail === "target-inventory-mismatch",
    );
  } finally {
    removeTree(deployRoot);
  }
});

test("target verifier errors with an unrelated reason property remain unexpected", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-target-unexpected-error-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  writeFileSync(join(source, "scripts/deploy/release-artifact.mjs"), [
    "export const verifyReleaseArtifact = () => {",
    '  const error = new Error("unrelated target error");',
    '  error.reason = "coincidental-reason";',
    "  throw error;",
    "};",
    "",
  ].join("\n"));
  try {
    const assembled = assembleReleaseDirectory({
      stageRoot: source,
      deployRoot,
      revision: revisions.to,
      artifactPaths: COMPLETE_ARTIFACT_PATHS,
      optionalArtifactPaths: [],
    });
    assert.throws(
      () => verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
      (error) => !(error instanceof DeployFailure)
        && error.name === "Error"
        && error.reason === "coincidental-reason",
    );
  } finally {
    removeTree(deployRoot);
  }
});

const assertRuntimeInventoryFailure = ({ artifactPaths, expectedDetail, mutate }) => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-runtime-tools-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  mutate?.(source);
  try {
    const assembled = assembleReleaseDirectory({
      stageRoot: source,
      deployRoot,
      revision: revisions.to,
      artifactPaths: [...new Set([...artifactPaths, "scripts/deploy"])],
      optionalArtifactPaths: [],
    });
    assert.throws(
      () => verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
      (error) => error instanceof DeployFailure
        && error.reason === "release-artifact-runtime-incomplete"
        && error.detail === expectedDetail,
    );
  } finally {
    removeTree(deployRoot);
  }
};

test("artifact verification rejects missing, extra, non-regular, and misplaced runtime tools", () => {
  const completePaths = COMPLETE_ARTIFACT_PATHS;
  assertRuntimeInventoryFailure({
    artifactPaths: completePaths.filter((path) => path !== "packages/runner/dist"),
    expectedDetail: "packages/runner/dist/runtime-tools-missing",
  });
  assertRuntimeInventoryFailure({
    artifactPaths: completePaths,
    expectedDetail: "packages/runner/dist/runtime-tools-inventory-mismatch",
    mutate: (source) => writeFileSync(
      join(source, "packages/runner/dist/runtime-tools/extra.sh"),
      "unexpected\n",
    ),
  });
  assertRuntimeInventoryFailure({
    artifactPaths: completePaths,
    expectedDetail: "packages/runner/dist/runtime-tools-inventory-mismatch",
    mutate: (source) => {
      rmSync(join(source, "packages/runner/dist/runtime-tools/regression-verification.sh"));
    },
  });
  assertRuntimeInventoryFailure({
    artifactPaths: completePaths,
    expectedDetail: "packages/runner/dist/runtime-tools/gate-worker-inventory-mismatch",
    mutate: (source) => writeFileSync(
      join(source, "packages/runner/dist/runtime-tools/gate-worker/extra.sh"),
      "unexpected\n",
    ),
  });
  assertRuntimeInventoryFailure({
    artifactPaths: completePaths,
    expectedDetail: "packages/runner/dist/runtime-tools/gate-worker-inventory-mismatch",
    mutate: (source) => rmSync(join(source, "packages/runner/dist/runtime-tools/gate-worker/lib.sh")),
  });
  assertRuntimeInventoryFailure({
    artifactPaths: completePaths,
    expectedDetail: "packages/runner/dist/runtime-tools/gate-worker-not-a-directory",
    mutate: (source) => {
      const path = join(source, "packages/runner/dist/runtime-tools/gate-worker");
      rmSync(path, { recursive: true });
      writeFileSync(path, "not a directory\n");
    },
  });
  assertRuntimeInventoryFailure({
    artifactPaths: completePaths,
    expectedDetail: "packages/runner/dist/runtime-tools/regression-verification.sh-not-a-regular-file",
    mutate: (source) => {
      const path = join(source, "packages/runner/dist/runtime-tools/regression-verification.sh");
      rmSync(path);
      symlinkSync("gate-worker/lib.sh", path);
    },
  });
  assertRuntimeInventoryFailure({
    artifactPaths: [...completePaths, "runtime-tools"],
    expectedDetail: "misplaced-runtime-tools",
    mutate: (source) => {
      mkdirSync(join(source, "runtime-tools"), { recursive: true });
      writeFileSync(join(source, "runtime-tools/unexpected.sh"), "unexpected\n");
    },
  });
  assertRuntimeInventoryFailure({
    artifactPaths: [...completePaths, "runtime-tool-alias"],
    expectedDetail: "misplaced-runtime-tool-alias",
    mutate: (source) => {
      symlinkSync("packages/runner/dist/runtime-tools", join(source, "runtime-tool-alias"));
    },
  });
});

test("artifact verification accepts an unrelated nested lib.sh", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-unrelated-lib-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  writeFileSync(join(source, "packages/db/src/lib.sh"), "unrelated fixture\n");
  try {
    const assembled = assembleReleaseDirectory({
      stageRoot: source,
      deployRoot,
      revision: revisions.to,
      artifactPaths: COMPLETE_ARTIFACT_PATHS,
      optionalArtifactPaths: [],
    });
    assert.doesNotThrow(
      () => verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
    );
  } finally {
    removeTree(deployRoot);
  }
});

test("artifact verification succeeds on an artifact built without packages/runner/scripts", () => {
  // The previously deployed builder's path list: `scripts/deploy` whole, but
  // not the runtime-tool manifest. Loading the target's verifier out of that
  // artifact is what failed with ERR_MODULE_NOT_FOUND, so the verifier's
  // module graph has to close over `scripts/deploy` alone.
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-old-builder-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  try {
    const assembled = assembleReleaseDirectory({
      stageRoot: source,
      deployRoot,
      revision: revisions.to,
      artifactPaths: COMPLETE_ARTIFACT_PATHS.filter((path) => path !== RUNTIME_TOOL_MANIFEST_PATH),
      optionalArtifactPaths: [],
    });
    assert.ok(!existsSync(join(assembled.releaseDirectory, RUNTIME_TOOL_MANIFEST_PATH)));
    assert.ok(existsSync(join(assembled.releaseDirectory, RUNTIME_TOOL_INVENTORY_PATH)));
    assert.doesNotThrow(
      () => verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
    );
  } finally {
    removeTree(deployRoot);
  }
});

test("artifact verification rejects an incomplete DB maintenance runtime before activation", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-runtime-closure-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  const assembled = assembleReleaseDirectory({
    stageRoot: source,
    deployRoot,
    revision: revisions.to,
    artifactPaths: ["packages/api/dist", "packages/db/prisma", "scripts/deploy", RUNTIME_TOOL_MANIFEST_PATH],
    optionalArtifactPaths: [],
  });
  assert.throws(
    () => verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
    (error) => error instanceof DeployFailure
      && error.reason === "release-artifact-runtime-incomplete"
      && error.detail === "packages/db/src-missing",
  );
  removeTree(deployRoot);
});

test("artifact verification authenticates the target verifier before executing it", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-digest-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  const assembled = assembleReleaseDirectory({
    stageRoot: source,
    deployRoot,
    revision: revisions.to,
    artifactPaths: COMPLETE_ARTIFACT_PATHS,
    optionalArtifactPaths: [],
  });
  const sentinel = join(deployRoot, "target-verifier-executed");
  const verifier = join(assembled.releaseDirectory, "scripts/deploy/release-artifact.mjs");
  chmodSync(verifier, 0o600);
  writeFileSync(verifier, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(sentinel)}, "executed\\n");`,
    "export const verifyReleaseArtifact = () => ({ tamperedVerificationAccepted: true });",
    "",
  ].join("\n"));
  chmodSync(verifier, 0o400);
  assert.throws(
    () => verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
    (error) => error instanceof DeployFailure && error.reason === "release-artifact-digest-mismatch",
  );
  assert.equal(existsSync(sentinel), false);
  removeTree(deployRoot);
});

test("dry-run reads the deployment host and drives no mutating phase", async () => {
  const { host, attempt, calls } = fixture();

  const result = await dryRunDecision(host, attempt);

  assert.equal(result.artifact.ok, true);
  assert.equal(result.artifact.releaseName, `${revisions.to}-${"c".repeat(64)}`);
  assert.deepEqual(result.revisions, { from: revisions.from, to: revisions.to });
  assert.equal(result.quiet, true);
  // The mutating phases are reported, never called: the whole dry-run drive is
  // the four read-only methods plus the shared revision read.
  assert.deepEqual(
    [...calls].sort(),
    ["artifact-state", "backup-state", "blocking-runs", "read-revisions", "service-state"],
  );
  const plannedPhases = result.lines
    .filter((line) => line.startsWith("DRY-RUN plan step="))
    .map((line) => line.match(/^DRY-RUN plan step=([^ ]+) mutation=skipped$/u)?.[1]);
  assert.deepEqual(plannedPhases, EXPECTED_PHASES.slice(4));
});

test("deploy history prunes recognized backups and leaves unrelated entries", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "anneal-deploy-retention-"));
  const backups = join(stateDir, "backups");
  mkdirSync(backups);
  for (let index = 0; index < 16; index += 1) {
    writeFileSync(join(backups, `2026-07-01T00-00-${String(index).padStart(2, "0")}-000Z-${"a".repeat(12)}-${"b".repeat(12)}.dump`), "dump\n");
  }
  writeFileSync(join(backups, "operator-note.txt"), "keep\n");
  mkdirSync(join(stateDir, "previous-operator-owned"));
  const result = pruneDeployHistory({ stateDir, now: Date.parse("2026-08-29T00:00:00Z"), dailyRetentionDays: 0 });
  assert.deepEqual(result, { keptBackups: 14, removedBackups: 2 });
  assert.equal(existsSync(join(backups, "operator-note.txt")), true);
  assert.equal(existsSync(join(stateDir, "previous-operator-owned")), true);
  rmSync(stateDir, { recursive: true, force: true });
});

test("the ledger entry records what the post-restart verification proved", () => {
  const attempt = openDeploymentAttempt({
    deployRoot: "/fixture",
    targetCommit: revisions.to,
    transactionId: "verification-ledger",
  });
  attempt.establish({
    revisions,
    serviceVerification: {
      unitsChecked: SERVICE_LABELS,
      runnerIds: LOCAL_RUNNER_IDS,
      activatedBuildCommit: revisions.to,
      observationWindowMs: 20_000,
      observedForMs: 20_134,
    },
  });
  const stateDir = mkdtempSync(join(tmpdir(), "anneal-deploy-verification-"));
  const ledger = createDeploymentLedger({ stateDir, targetCommit: revisions.to });
  ledger.start();
  ledger.record("VERIFIED", attempt.ledgerMetadata());
  const snapshot = JSON.parse(readFileSync(ledger.statePath, "utf8"));
  assert.deepEqual(snapshot.service_verification, {
    units_checked: SERVICE_LABELS,
    runners_registered: LOCAL_RUNNER_IDS,
    observation_window_ms: 20_000,
    observed_for_ms: 20_134,
  });
  rmSync(stateDir, { recursive: true, force: true });
});

test("quiet-window HOLD lines carry the elapsed wait and the blocking count", () => {
  assert.equal(
    quietWindowHoldLine({ blockingRuns: 4, elapsedSeconds: 2_700 }, "statuses=running,claimed"),
    "HOLD quiet-window blockers=4 elapsed=2700s statuses=running,claimed",
  );
  assert.equal(
    quietWindowHoldLine({ blockingRuns: 0, elapsedSeconds: 60 }, "deploy-barrier-contended"),
    "HOLD quiet-window blockers=0 elapsed=60s deploy-barrier-contended",
  );
});

test("a quiet-window wait over budget writes one ledger event and one notification", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "anneal-deploy-quiet-wait-"));
  const attempt = openDeploymentAttempt({
    deployRoot: "/srv/anneal",
    targetCommit: revisions.to,
    transactionId: "quiet-window-wait-ledger",
  });
  const ledger = createDeploymentLedger({ stateDir, targetCommit: revisions.to });
  ledger.start();
  attempt.establish({ revisions, ledger });
  const notices = [];
  const lines = [];
  const report = createQuietWindowWaitReporter({
    attempt,
    revisions,
    notify: async (record) => { notices.push(record); },
    log: (line) => lines.push(line),
  });
  await report({
    elapsedMs: 2_700_000,
    elapsedSeconds: 2_700,
    polls: 45,
    peakBlockingRuns: 7,
    blockingRuns: 5,
    budgetMs: 2_700_000,
    blockingRunsByRunner: { "mac-runner-1": 3, "vm-control-plane": 2 },
  });
  const events = readFileSync(ledger.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const exceeded = events.filter((event) => event.phase === "QUIET_WINDOW_WAIT_EXCEEDED");
  assert.equal(exceeded.length, 1);
  assert.equal(exceeded[0].target_commit, revisions.to);
  assert.equal(exceeded[0].quiet_window_wait_seconds, 2_700);
  assert.equal(exceeded[0].quiet_window_wait_polls, 45);
  assert.equal(exceeded[0].quiet_window_wait_peak_blocking_runs, 7);
  assert.deepEqual(exceeded[0].quiet_window_blocking_runs_by_runner, {
    "mac-runner-1": 3,
    "vm-control-plane": 2,
  });
  assert.deepEqual(notices, [{
    outcome: "failure",
    reason: "quiet-window-wait-exceeded",
    // The notice says in its own text that the deploy is still waiting.
    detail: "still-waiting-elapsed-2700s-budget-2700s",
    from: revisions.from,
    to: revisions.to,
    dedupeScope: "quiet-window-wait-ledger:2700",
  }]);
  // Informational only: no escalation marker is written next to the ledger.
  assert.equal(existsSync(join(stateDir, "escalated.json")), false);
  assert.ok(lines.some((line) => line.startsWith("HOLD quiet-window-wait-exceeded")));
  rmSync(stateDir, { recursive: true, force: true });
});

test("a completed quiet-window wait is recorded on the attempt's ledger entries", () => {
  const attempt = openDeploymentAttempt({
    deployRoot: "/srv/anneal",
    targetCommit: revisions.to,
    transactionId: "quiet-window-wait-completed",
  });
  attempt.establish({
    revisions,
    quietWindowWait: { waitSeconds: 312, polls: 6, peakBlockingRuns: 4 },
  });
  const stateDir = mkdtempSync(join(tmpdir(), "anneal-deploy-quiet-wait-done-"));
  const ledger = createDeploymentLedger({ stateDir, targetCommit: revisions.to });
  ledger.start();
  ledger.record("SUCCEEDED", attempt.ledgerMetadata());
  const snapshot = JSON.parse(readFileSync(ledger.statePath, "utf8"));
  assert.equal(snapshot.quiet_window_wait_seconds, 312);
  assert.equal(snapshot.quiet_window_wait_polls, 6);
  assert.equal(snapshot.quiet_window_wait_peak_blocking_runs, 4);
  assert.equal(snapshot.quiet_window_blocking_runs_by_runner, null);
  rmSync(stateDir, { recursive: true, force: true });
});

test("an over-budget alert dedupes within its attempt and not across attempts", async () => {
  const event = {
    elapsedMs: 2_700_000,
    elapsedSeconds: 2_700,
    polls: 45,
    peakBlockingRuns: 7,
    blockingRuns: 5,
    budgetMs: 2_700_000,
    blockingRunsByRunner: { "mac-runner-1": 5 },
  };
  const keys = [];
  const reporterFor = (transactionId) => {
    const attempt = openDeploymentAttempt({ deployRoot: "/fixture", targetCommit: revisions.to, transactionId });
    attempt.establish({ revisions });
    return createQuietWindowWaitReporter({
      attempt,
      revisions,
      notify: async ({ dedupeScope, ...record }) => {
        keys.push(autoDeployNoticeDedupeKey(autoDeployNoticeBody(record), dedupeScope));
      },
      log: () => undefined,
    });
  };
  const first = reporterFor("attempt-one");
  await first(event);
  await first(event);
  await reporterFor("attempt-two")(event);
  // The same crossing reported twice is one Inbox record; a later attempt with
  // identical revisions and identical timing raises its own.
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  // An unscoped notice keys on its text alone, as every deploy outcome does.
  assert.notEqual(keys[0], autoDeployNoticeDedupeKey("[auto-deploy] failure: a -> b; reason=x"));
});

test("an undelivered over-budget alert reports itself undelivered", async () => {
  const attempt = openDeploymentAttempt({
    deployRoot: "/fixture",
    targetCommit: revisions.to,
    transactionId: "quiet-window-wait-undelivered",
  });
  attempt.establish({ revisions });
  const lines = [];
  const outcome = await createQuietWindowWaitReporter({
    attempt,
    revisions,
    notify: async () => { throw new DeployFailure("inbox-notification-failed", "unreachable"); },
    log: (line) => lines.push(line),
  })({ elapsedSeconds: 2_700, polls: 45, peakBlockingRuns: 7, blockingRuns: 5, budgetMs: 2_700_000, blockingRunsByRunner: {} });
  // The wait reads this and retries on its next poll instead of staying silent
  // for the rest of the alert interval.
  assert.deepEqual(outcome, { delivered: false });
  assert.ok(lines.some((line) => line.endsWith("quiet-window-wait-alert-undelivered")));
});

test("the quiet-window wait, its alert and its recorded distribution are one path", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "anneal-deploy-quiet-wired-"));
  const attempt = openDeploymentAttempt({
    deployRoot: "/fixture",
    targetCommit: revisions.to,
    transactionId: "quiet-window-wired",
  });
  const ledger = createDeploymentLedger({ stateDir, targetCommit: revisions.to });
  ledger.start();
  attempt.establish({ revisions, ledger });
  const notices = [];
  const barrier = { release: async () => undefined };
  let polls = 0;
  const host = createDeployHost({
    serviceControl: { platform: "linux", restart: async () => undefined, isRunning: async () => true, describe: async () => "" },
    environment: controlPlaneEnvironment(),
    // Every poll is over budget, so only the alert interval can hold the
    // notification to one.
    waitBudgetMs: 0,
    blockingRunsAdapter: async () => (polls < 2
      ? [{ id: "run-1", status: "running", runnerId: "mac-runner-1" }, { id: "run-2", status: "claimed", runnerId: "vm-control-plane" }]
      : []),
    acquireBarrier: async () => barrier,
    createWatchdog: async () => ({ release: async () => undefined }),
    pollWait: async () => { polls += 1; await new Promise((accept) => { setImmediate(accept); }); },
    notify: async (record) => { notices.push(record); },
  });
  const facts = await host.waitForQuiet(attempt);
  attempt.establish(facts);
  assert.equal(facts.barrier, barrier);
  assert.equal(facts.quietWindowWait.polls, 3);
  assert.equal(facts.quietWindowWait.peakBlockingRuns, 2);
  assert.ok(Number.isSafeInteger(facts.quietWindowWait.waitSeconds) && facts.quietWindowWait.waitSeconds >= 0);
  const events = readFileSync(ledger.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const exceeded = events.filter((event) => event.phase === "QUIET_WINDOW_WAIT_EXCEEDED");
  assert.equal(exceeded.length, 1);
  assert.deepEqual(exceeded[0].quiet_window_blocking_runs_by_runner, { "mac-runner-1": 1, "vm-control-plane": 1 });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].reason, "quiet-window-wait-exceeded");
  ledger.record("SUCCEEDED", attempt.ledgerMetadata());
  const snapshot = JSON.parse(readFileSync(ledger.statePath, "utf8"));
  assert.equal(snapshot.quiet_window_wait_polls, 3);
  assert.equal(snapshot.quiet_window_wait_peak_blocking_runs, 2);
  rmSync(stateDir, { recursive: true, force: true });
});

test("a misconfigured wait budget refuses before the deploy builds anything", () => {
  assert.throws(
    () => createDeployHost({
      serviceControl: { platform: "linux", restart: async () => undefined, isRunning: async () => true, describe: async () => "" },
      environment: controlPlaneEnvironment({ QUIET_WINDOW_WAIT_BUDGET_MINUTES: "0" }),
    }),
    (error) => error instanceof DeployFailure
      && error.reason === "environment-invalid"
      && error.detail === "QUIET_WINDOW_WAIT_BUDGET_MINUTES-0",
  );
});

test("blocking-run counts survive runner ids that name Object prototype members", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "anneal-deploy-quiet-runners-"));
  const ledger = createDeploymentLedger({ stateDir, targetCommit: revisions.to });
  ledger.start();
  const counts = Object.fromEntries([["toString", 2], ["constructor", 3], ["__proto__", 1]]);
  ledger.record("QUIET_WINDOW_WAIT_EXCEEDED", {
    targetCommit: revisions.to,
    quietWindowWaitSeconds: 2_700,
    quietWindowBlockingRunsByRunner: counts,
  });
  const events = readFileSync(ledger.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const exceeded = events.filter((event) => event.phase === "QUIET_WINDOW_WAIT_EXCEEDED");
  assert.equal(exceeded.length, 1);
  assert.deepEqual(exceeded[0].quiet_window_blocking_runs_by_runner, counts);
  rmSync(stateDir, { recursive: true, force: true });
});

test("deployment ledger accepts the artifact verification seam", () => {
  assert.ok(DEPLOYMENT_LEDGER_STATES.includes("ARTIFACT_PREPARED"));
  assert.ok(DEPLOYMENT_LEDGER_STATES.includes("ARTIFACT_VERIFIED"));
  const stateDir = mkdtempSync(join(tmpdir(), "anneal-deploy-ledger-"));
  const ledger = createDeploymentLedger({ stateDir, targetCommit: revisions.to });
  ledger.start();
  ledger.record("ARTIFACT_VERIFIED", {
    releaseDirectoryIdentity: `${revisions.to}-${"c".repeat(64)}`,
    activatedBuildStamp: { packageName: "@anneal/api", commit: revisions.to, dirty: false },
  });
  const snapshot = JSON.parse(readFileSync(ledger.statePath, "utf8"));
  assert.equal(snapshot.state, "ARTIFACT_VERIFIED");
  assert.equal(snapshot.release_directory_identity, `${revisions.to}-${"c".repeat(64)}`);
  rmSync(stateDir, { recursive: true, force: true });
});

test("auto-deploy plist launches through current with an explicit source remote and deploy root", () => {
  const template = readFileSync(new URL("./com.agentos.auto-deploy.plist.in", import.meta.url), "utf8");
  const rendered = renderLaunchdPlist(template, {
    nodeBinary: "/opt/node",
    deployScript: "/srv/anneal/current/scripts/deploy/quiet-window-deploy.mjs",
    repositoryRoot: "/srv/anneal",
    sourceRemote: "https://example.invalid/anneal.git",
    stdoutPath: "/logs/out",
    stderrPath: "/logs/err",
    path: "/opt:/usr/bin:/bin",
    gitBinary: "/opt/git",
    npmBinary: "/opt/npm-cli.js",
    backup: {
      mode: "container",
      dockerBinary: "/opt/docker",
      container: "postgres",
      pgDumpBinary: "/usr/local/bin/pg_dump",
    },
  });
  assert.match(rendered, /current\/scripts\/deploy\/quiet-window-deploy\.mjs/u);
  assert.match(rendered, /AGENTOS_REPOSITORY_ROOT/u);
  assert.match(rendered, /DEPLOY_SOURCE_REMOTE/u);
  assert.match(rendered, /https:\/\/example\.invalid\/anneal\.git/u);
  assert.doesNotMatch(rendered, /__[A-Z_]+__/u);
});

/** The deploy resolves its binaries once, from the environment, before any
 * phase spawns anything; a control-plane role also verifies its backup
 * configuration. Neither is what these tests are about. */
const withDeployBinaries = (t) => {
  const previous = { ...process.env };
  process.env.DEPLOY_PG_DUMP_MODE = "host";
  process.env.DEPLOY_PG_DUMP_BINARY = process.execPath;
  t.after(() => { process.env = previous; });
};

const spawnRecordingHost = (t, { transactionId }) => {
  withDeployBinaries(t);
  const spawns = [];
  const migrationTails = [];
  const environment = { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "0", DEPLOY_TEST_SENTINEL: "preserved" };
  const host = createDeployHost({
    environment,
    serviceControl: { platform: "darwin", restart: async () => {}, isRunning: async () => true, describe: async () => "" },
    readMigrationTail: async () => {
      const tail = `tail-${migrationTails.length}`;
      migrationTails.push(tail);
      return tail;
    },
    runCommand: async (program, args, options) => {
      spawns.push({ args, env: options.env });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const attempt = openDeploymentAttempt({
    deployRoot: "/fixture",
    targetCommit: "d".repeat(40),
    transactionId,
  });
  attempt.establish({
    operationWorkspace: "/fixture/operation",
    barrier: { retainUntilEscalationCleared: () => undefined },
  });
  return { host, spawns, attempt, migrationTails };
};

test("the guarded migration spawns Prisma with its update banner hidden", async (t) => {
  const { host, spawns, attempt, migrationTails } = spawnRecordingHost(t, { transactionId: "prisma-banner-migration" });
  const result = await host.guardedMigration(attempt);
  assert.deepEqual(migrationTails, ["tail-0", "tail-1"]);
  assert.deepEqual(result.migration, { migrationTailBefore: "tail-0", migrationTailAfter: "tail-1" });
  assert.equal(spawns.length, 2);
  const migration = spawns.find(({ args }) => args.includes("migrate") && args.includes("deploy"));
  assert.ok(migration, "the guarded migration must spawn prisma migrate deploy");
  assert.equal(migration.env.PRISMA_HIDE_UPDATE_MESSAGE, "1");
  assert.equal(migration.env.DEPLOY_TEST_SENTINEL, "preserved");
  assert.equal(migration.env.PATH, process.env.PATH);
});

test("client generation spawns Prisma with its update banner hidden", async (t) => {
  const { host, spawns, attempt } = spawnRecordingHost(t, { transactionId: "prisma-banner-generate" });
  await host.generatePrismaClient(attempt);
  assert.equal(spawns.length, 1);
  assert.ok(spawns[0].args.includes("generate"));
  assert.equal(spawns[0].env.PRISMA_HIDE_UPDATE_MESSAGE, "1");
  assert.equal(spawns[0].env.DEPLOY_TEST_SENTINEL, "preserved");
  assert.equal(spawns[0].env.PATH, process.env.PATH);
});

test("release artifact build hides the Prisma banner in descendant commands", async (t) => {
  const { host, spawns, attempt } = spawnRecordingHost(t, { transactionId: "prisma-banner-artifact" });
  // The recording command returns no receipt, stopping before filesystem verification.
  await assert.rejects(host.prepareReleaseArtifact(attempt), /builder-receipt-missing/u);
  assert.equal(spawns.length, 1);
  assert.ok(spawns[0].args[0].endsWith("build-release-artifact.mjs"));
  assert.equal(spawns[0].env.PRISMA_HIDE_UPDATE_MESSAGE, "1");
  assert.equal(spawns[0].env.DEPLOY_TEST_SENTINEL, "preserved");
  assert.equal(spawns[0].env.PATH, process.env.PATH);
});

test("canonical prompt sync uses the host command seam", async (t) => {
  const { host, spawns, attempt } = spawnRecordingHost(t, { transactionId: "command-seam-sync" });
  await host.syncCanonicalPrompts(attempt);
  assert.equal(spawns.length, 1);
  assert.ok(spawns[0].args.includes("packages/db/prisma/sync-canonical-prompts.ts"));
});

for (const regression of ["unit", "api"]) {
  test(`rollback detects ${regression} regression during its observation window`, async () => {
    let samples = 0;
    let observations = 0;
    const host = createDeployHost({
      environment: controlPlaneEnvironment(),
      observationWindowMs: 10,
      serviceVerificationWait: async () => {},
      serviceControl: { platform: "linux", restart: async () => {} },
      verifyRecoveredServices: async () => {
        if (++samples > 1) throw new DeployFailure("service-wrapper-verification-failed",
          regression === "unit" ? "service-start-failed:com.agentos.runner" : "service-readiness-failed:com.agentos.api");
      },
      fetchImpl: controlPlaneFetch({ commit: revisions.from, registry: () => runnerRegistry({
        commit: revisions.from,
        lastSeenAt: new Date(1_800_000_000_000 + ++observations * 1_000).toISOString(),
      }) }),
    });
    const attempt = openDeploymentAttempt({ deployRoot: "/fixture", targetCommit: revisions.to, transactionId: "rollback-regression" });
    attempt.establish({ revisions });
    await assert.rejects(host.restorePreviousServices(attempt),
      (error) => error.reason === "previous-service-verification-failed"
        && error.detail.includes("observation-window-regressed")
        && error.detail.includes(regression === "unit" ? "com.agentos.runner" : "com.agentos.api"));
    assert.equal(samples, 2);
  });
}

test("observation overrides reject overflow and durations beyond five minutes", () => {
  for (const value of ["9".repeat(400), "9007199254740992", "300001", "20000000"]) {
    assert.throws(() => resolveObservationWindowMs({ AGENTOS_DEPLOY_OBSERVATION_WINDOW_MS: value }),
      (error) => error.reason === "deploy-observation-window-invalid");
  }
  assert.equal(resolveObservationWindowMs({ AGENTOS_DEPLOY_OBSERVATION_WINDOW_MS: "300000" }), 300000);
});

test("a refusal sampled across the deadline preserves the named rollback failure", async () => {
  let now = 0;
  await assert.rejects(observeReadiness({
    sample: async () => { now = 11; return "service-start-failed:com.agentos.api"; },
    observationWindowMs: 0, timeoutMs: 10, now: () => now,
    wait: async () => assert.fail("expired sample must not wait"),
    failureReason: "previous-service-verification-failed",
  }), (error) => error.reason === "previous-service-verification-failed"
    && error.detail === "service-start-failed:com.agentos.api");
});

test("a regression sampled across the deadline preserves the named rollback failure", async () => {
  let now = 0;
  await assert.rejects(observeReadiness({
    sample: async () => {
      if (now === 0) return null;
      now = 11;
      return "service-start-failed:com.agentos.api";
    },
    observationWindowMs: 5, timeoutMs: 10, now: () => now,
    wait: async () => { now = 1; },
    failureReason: "previous-service-verification-failed",
  }), (error) => error.reason === "previous-service-verification-failed"
    && error.detail === "observation-window-regressed-service-start-failed:com.agentos.api");
});

test("a first green sample near the deadline cannot complete the window after timeout", async () => {
  let now = 0;
  let samples = 0;
  await assert.rejects(observeReadiness({
    sample: async () => { samples++; now = 9; return null; },
    observationWindowMs: 2, timeoutMs: 10, now: () => now,
    wait: async (ms) => { assert.equal(ms, 1); now += ms; },
    failureReason: "service-verification-failed",
  }), (error) => error.detail === "observation-window-incomplete-2ms");
  assert.equal(samples, 1);
  now = 0;
  await assert.rejects(observeReadiness({
    sample: async () => { now = 11; return null; },
    observationWindowMs: 0, timeoutMs: 10, now: () => now,
    wait: async () => assert.fail("expired sample must not wait"),
    failureReason: "service-verification-failed",
  }), (error) => error.reason === "service-verification-failed");
});

test("control-plane registration sends the deployment file token over an inherited token", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "deploy-file-token-"));
  const envPath = join(root, ".env");
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  });
  Object.assign(process.env, controlPlaneEnvironment(), {
    OPERATOR_TOKEN: "inherited-token", DATABASE_URL: "fixture", FEISHU_DEFAULT_CHAT_ID: "fixture",
  });
  writeFileSync(envPath, "OPERATOR_TOKEN=file-token\nGITHUB_READ_TOKEN=fixture\n", { mode: 0o600 });
  await loadEnvironment("control-plane", envPath);
  const host = createDeployHost({
    deployRole: "control-plane",
    serviceControl: { restart: async () => {} },
    fetchImpl: async (url, options) => {
      assert.ok(url.endsWith("/runners"));
      assert.equal(options.headers.authorization, "Bearer file-token");
      return runnerRegistry({ commit: revisions.from });
    },
  });
  await host.restartServices();
});

for (const reason of ["deployment-ledger-write-failed", "operation-workspace-preparation-failed",
  "previous-service-restore-failed", "previous-service-restore-timeout",
  "service-wrapper-verification-failed", "service-control-denied", "service-control-failed:restart:api"]) {
  test(`host failure ${reason} blocks a moved main`, async (t) => {
    const marker = escalationFixture(t, { reason, detail: "ENOSPC", to: revisions.from });
    let targetReads = 0;
    assert.deepEqual(await checkExistingEscalation(marker.options), { active: true });
    const startup = startupFixture({
      checkEscalation: () => checkExistingEscalation(marker.options),
      readRemoteMain: async () => { targetReads += 1; return revisions.to; },
    });
    assert.deepEqual(await decideInvocation(startup.startup, "upgrade"), { mode: "upgrade", exitCode: 2 });
    assert.equal(targetReads, 0);
  });
}

test("a superseding build failure re-latches B and refuses the next B invocation", async (t) => {
  const marker = escalationFixture(t, { reason: "release-artifact-build-failed", to: revisions.from });
  const startup = startupFixture({ checkEscalation: () => checkExistingEscalation({
    ...marker.options, hostScopedReasons: HOST_SCOPED_ESCALATION_REASONS,
  }) });
  const invocation = await decideInvocation(startup.startup, "upgrade");
  assert.equal(invocation.targetCommit, revisions.to);
  const run = fixture({ builderOutput: "invalid receipt" });
  run.attempt.establish({ supersededEscalation: invocation.supersededEscalation });
  run.host.escalate = async (record) => {
    run.state.escalated = record;
    writeEscalationWithAttempts({ ...marker.options, record });
  };
  assert.equal((await executeUpgrade(run.host, run.attempt)).ok, false);
  assert.equal(run.state.escalated.reason, "release-artifact-build-failed");
  assert.equal(JSON.parse(readFileSync(marker.escalationPath, "utf8")).to, revisions.to);
  assert.deepEqual(await decideInvocation(startup.startup, "upgrade"), { mode: "upgrade", exitCode: 2 });
});

test("failed recovery persists unproven activation and blocks newer main", async (t) => {
  const run = fixture({ failure: "verify-services" });
  run.host.restorePreviousServices = async () => { throw new DeployFailure("service-control-failed:restart:api"); };
  await executeUpgrade(run.host, run.attempt);
  assert.equal(run.state.escalated.activationOutcomeProven, false);
  assert.equal(run.records.at(-1).state, "MANUAL_RECOVERY");
  const marker = escalationFixture(t, run.state.escalated);
  assert.deepEqual(await checkExistingEscalation({ ...marker.options, hostScopedReasons: HOST_SCOPED_ESCALATION_REASONS }), { active: true });
});

test("production startup wiring keeps backup failure host-scoped", async (t) => {
  const marker = escalationFixture(t, { reason: "database-backup-failed", to: revisions.from });
  const production = createDeployStartup({ escalationPath: marker.escalationPath, retryNotification: async () => {} });
  let targetReads = 0;
  const state = startupFixture({
    checkEscalation: production.checkEscalation,
    readRemoteMain: async () => { targetReads += 1; return revisions.to; },
  });
  assert.deepEqual(await decideInvocation(state.startup, "upgrade"), { mode: "upgrade", exitCode: 2 });
  assert.equal(targetReads, 0);
});
