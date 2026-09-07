import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { type RunOutcome, type RunOutputEvidence, runOwnedHead } from "@anneal/db";
import {
  SESSION_EVENT_PAYLOAD_TOO_LARGE_CODE,
  SESSION_EVENTS_REQUEST_TOO_LARGE_CODE,
} from "@anneal/db/session-event-limits";

import {
  adapters, buildPrompt, RUNNER_KINDS, type AdapterEvent, type CliAdapter, type ExitEvidence, type RuntimeHandle,
} from "./adapters.js";
import { initialCodexState, type CodexProviderState } from "./adapters/codex.js";
import type { ClaimedTask, ControlPlane } from "./api.js";
import type { RunnerConfig } from "./config.js";
import {
  PROVIDER_RESUME_BACKOFF_CEILING_MS,
  PROVIDER_RESUME_MAX_ATTEMPTS,
} from "./provider-relaunch.js";
import {
  cliAvailabilityHeartbeatSchedule,
  executeClaim as executeClaimProduction,
  providerDisconnectResumeInput,
  reportCliAvailabilityHeartbeat as reportCliAvailabilityHeartbeatProduction,
  runStartupPreflight as runStartupPreflightProduction,
  startupPreflightLog,
} from "./runner.js";
import {
  createControlPlaneDouble, createRoutedControlPlaneDouble, envelopeOf, failureReasonOf,
  type ControlPlaneFetchHandler, type ControlPlaneOverrides,
} from "./test-control-plane.js";
import type { RunLeaseClock } from "./run-lease.js";
import { EVENT_REJECTED_EVENT_TYPE } from "./session-event-queue.js";
import {
  cleanupAgentScratch, materializeRuntimeTools, provisionSessionConfig, type AgentScratch,
} from "./workspace.js";

const config = (workspaceRoot: string): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-1",
  servedKinds: null,
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 5_000,
  claimMaxLoadAverage: 1.5,
  leaseSeconds: 60,
  heartbeatIntervalMs: 5_000,
  path: "/usr/bin:/bin",
  home: workspaceRoot,
  gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
  workspaceRoot,
  hostProofSlots: 3,
  failedWorkspaceRetention: 2,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
});

const testSession = (root: string): ClaimedTask["session"] => ({ id: `test-${basename(root)}` });
const cleanupTestSession = async (root: string): Promise<void> => {
  await rm(join(tmpdir(), "agentos-session-config", testSession(root).id), { recursive: true, force: true });
};

const mechanicalClaim: ClaimedTask = {
  executionMode: "mechanical",
  specificationMaterialization: null,
  task: {
    id: "task-10",
    chainId: null,
    chainIndex: null,
    chainLayer: null,
    name: "Merge execution",
    description: "Execute the authorized merge",
    repoId: "repo-1",
    targetBranch: "master",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxSessionsPerTask: 3,
    templateStep: { name: "Merge execution", outputKind: "result", provisionDependencies: true, taskTemplate: { name: "merge-workflow" } },
  },
  agent: {
    id: "agent-merge",
    name: "merge-integrator",
    model: "mechanical/merge-executor-v1",
    foundationalPrompt: "",
    rolePrompt: "",
    disabledTools: [],
  },
  repo: {
    id: "repo-1",
    remoteUrl: "git@github.com:owner/name.git",
    defaultBranch: "master",
    mountPath: "/does/not/exist",
    // Most runner scenarios use a minimal Git fixture without Node manifests;
    // dependency provisioning is exercised explicitly by the installation and
    // manifest-missing cases below.
    dependencyProvisioning: "NONE",
  },
  run: {
    id: "run-10",
    taskId: "task-10",
    runNumber: 1,
    opensPullRequest: false,
    requiresCommit: false,
    pullRequestBase: "master",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxRunsPerTask: 3,
    model: "mechanical/merge-executor-v1",
    codexServiceTier: "DEFAULT",
    subagentModel: null,
    subagentMaxConcurrent: null,
    targetBranch: "master",
    targetBranchPublished: false,
    pinnedBaseSha: null,
    implementationBaseSha: null,
    implementationHeadSha: null,
    promptHash: "hash",
    workspacePath: null,
    // The control plane declares the head at Run birth; provisioning refuses a
    // claim without one, so no fixture may leave it null.
    branch: runOwnedHead("task-10", 1),
    baseSha: null,
  },
  session: { id: "session-10" },
  resume: null,
  nextEventSeq: 0,
  runner: "CLAUDE",
  fencingToken: "fence-1",
  sessionToken: "session-token",
  secrets: {},
  priorOutputs: [],
  operatorNotes: [],
  previousRunHandoff: null,
  regressionRepairHandoff: null,
};

/** The output status of a step whose agent persisted what it declared. */
const persistedResultOutput: RunOutputEvidence = {
  satisfaction: { case: "delivered", output: { kind: "result", commitSha: null } },
  prHandoff: { case: "not-a-pr-delivery" },
};

/**
 * The same claim as an ordinary agent run of an ad-hoc task. A task with no
 * template step declares no task output, which is what most scenarios below
 * want: the ones that do declare one also answer the output status the runner
 * then reads.
 */
const agentClaim: ClaimedTask = {
  ...mechanicalClaim,
  executionMode: "agent",
  task: { ...mechanicalClaim.task, templateStep: null },
};

let injectedControlPlane: ControlPlane = createControlPlaneDouble().controlPlane;
const setControlPlane = (handler: ControlPlaneFetchHandler): void => {
  injectedControlPlane = createRoutedControlPlaneDouble(config(""), handler).controlPlane;
};
const executeClaim = (
  ...[runnerConfig, claim, dependencies = {}]: Parameters<typeof executeClaimProduction>
) => executeClaimProduction(runnerConfig, claim, {
  materializeRuntimeTools: (config, scratch) => materializeRuntimeTools(config, scratch, {
    sourceRoot: fileURLToPath(new URL("../runtime-tools/", import.meta.url)),
  }),
  ...dependencies,
  controlPlane: injectedControlPlane,
});
const runStartupPreflight = (
  runnerConfig: Parameters<typeof runStartupPreflightProduction>[0],
  options: Parameters<typeof runStartupPreflightProduction>[1] = {},
) => runStartupPreflightProduction(runnerConfig, { ...options, controlPlane: injectedControlPlane });
const reportCliAvailabilityHeartbeat = (
  runnerConfig: Parameters<typeof reportCliAvailabilityHeartbeatProduction>[0],
  options: Parameters<typeof reportCliAvailabilityHeartbeatProduction>[1] = {},
) => reportCliAvailabilityHeartbeatProduction(runnerConfig, { ...options, controlPlane: injectedControlPlane });

test("a mechanical claim is refused before any adapter, workspace or child environment exists", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "runner-mechanical-"));
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });

  // Any adapter entry point reached at all is the failure this test exists to
  // catch: a merge credential must never be in a process that spawns a CLI.
  const adapter: CliAdapter = {
    ...adapters.CLAUDE,
    start: () => { throw new Error("adapter.start must not be reached for a mechanical claim"); },
    preflight: () => { throw new Error("adapter.preflight must not be reached for a mechanical claim"); },
  };
  await executeClaim(config(workspaceRoot), mechanicalClaim, { adapter });

  assert.deepEqual(calls.map((call) => call.path), ["http://api.invalid/runner/runs/run-10/complete"]);
  assert.equal(calls[0]!.body.terminationReason, "mechanical run claimed by a model runner");
  assert.equal(outcomeOf(calls[0]!.body).case, "terminal-protocol-failure");
  assert.equal(calls[0]!.body.exitCode, null);
  // No workspace was provisioned: `provisionWorkspace` creates its run directory
  // under the workspace root, and nothing else in this path writes there.
  assert.deepEqual(await readdir(workspaceRoot), []);
});

// Which values are refused is a table in `dependency-provisioning.test.ts`.
// What this test owns is the order: a refusal reaches the control plane before
// the runner has provisioned, installed or launched anything.
const claimWithoutRepositoryPolicy = (): ClaimedTask => {
  const repo = { ...mechanicalClaim.repo } as Record<string, unknown>;
  delete repo.dependencyProvisioning;
  return { ...agentClaim, repo } as unknown as ClaimedTask;
};

test("a refused dependency-provisioning claim is rejected before provisioning or adapter launch", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "runner-dependency-protocol-"));
  const commandRoot = await mkdtemp(join(tmpdir(), "runner-dependency-command-"));
  const npmSentinel = join(commandRoot, "npm-called");
  const npm = join(commandRoot, "npm");
  await writeFile(npm, `#!/bin/sh\nprintf called > ${JSON.stringify(npmSentinel)}\n`);
  await chmod(npm, 0o755);
  const controlPlane = createControlPlaneDouble();
  let adapterCalls = 0;
  const adapter: CliAdapter = {
    ...adapters.CLAUDE,
    preflight: async () => {
      adapterCalls += 1;
      throw new Error("adapter preflight must not be reached for a malformed dependency claim");
    },
    start: async () => {
      adapterCalls += 1;
      throw new Error("adapter start must not be reached for a malformed dependency claim");
    },
  };

  try {
    await executeClaimProduction(
      { ...config(workspaceRoot), path: commandRoot },
      claimWithoutRepositoryPolicy(),
      { adapter, controlPlane: controlPlane.controlPlane },
    );
    const completion = controlPlane.completions.at(-1);
    assert.ok(completion, "malformed claims must complete the run");
    assert.equal(completion.outcome.case, "terminal-protocol-failure");
    assert.equal(failureReasonOf(completion.outcome), "dependency-provisioning-missing");
    assert.equal(completion.terminationReason, "dependency-provisioning-missing");
    assert.equal(completion.cleanupStatus, "SUCCEEDED");
    assert.equal(completion.workspaceRetained, false);
    assert.equal(adapterCalls, 0, "malformed claims must not reach adapter preflight or launch");
    assert.deepEqual(await readdir(workspaceRoot), [], "malformed claims must not provision a workspace");
    await assert.rejects(access(npmSentinel), { code: "ENOENT" }, "malformed claims must not invoke npm");
  } finally {
    await Promise.all([
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(commandRoot, { recursive: true, force: true }),
    ]);
  }
});

const claimWithoutTemplateStepDecision = (): ClaimedTask => {
  const templateStep = { ...mechanicalClaim.task.templateStep! } as Record<string, unknown>;
  delete templateStep.provisionDependencies;
  return {
    ...agentClaim,
    task: { ...mechanicalClaim.task, templateStep },
  } as unknown as ClaimedTask;
};

test("a refused template-step dependency decision is rejected before workspace or adapter work", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "runner-template-step-protocol-"));
  const controlPlane = createControlPlaneDouble();
  let preflightCalls = 0;
  let startCalls = 0;
  const adapter: CliAdapter = {
    ...adapters.CLAUDE,
    preflight: async () => {
      preflightCalls += 1;
      throw new Error("adapter preflight must not be reached for a malformed template step");
    },
    start: async () => {
      startCalls += 1;
      throw new Error("provider start must not be reached for a malformed template step");
    },
  };

  try {
    await executeClaimProduction(
      config(workspaceRoot),
      claimWithoutTemplateStepDecision(),
      { adapter, controlPlane: controlPlane.controlPlane },
    );
    const completion = controlPlane.completions.at(-1);
    assert.ok(completion, "malformed claims must complete the run");
    assert.equal(completion.outcome.case, "terminal-protocol-failure");
    assert.equal(failureReasonOf(completion.outcome), "template-step-provision-dependencies-missing");
    assert.equal(completion.terminationReason, "template-step-provision-dependencies-missing");
    assert.equal(completion.cleanupStatus, "SUCCEEDED");
    assert.equal(completion.workspaceRetained, false);
    assert.equal(preflightCalls, 0);
    assert.equal(startCalls, 0);
    assert.deepEqual(await readdir(workspaceRoot), [], "malformed claims must not provision a workspace");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a review step records the dependency skip before fake adapter preflight and launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-review-dependency-activity-"));
  try {
    const remote = await seedDependencyRemote(root);
    const configured = {
      ...config(join(root, "workspaces")),
      home: root,
      path: process.env.PATH ?? "/usr/bin:/bin",
      dependencyCacheRoot: join(root, "dependency-cache"),
    };
    const timeline: string[] = [];
    const controlPlane = createControlPlaneDouble({
      note: async () => { timeline.push("activity"); },
      outputStatus: async () => persistedResultOutput,
    });
    const adapter: CliAdapter = {
      ...adapters.CLAUDE,
      preflight: async () => {
        timeline.push("preflight");
        return { ok: true, cliVersion: "test", authMode: "test", capabilities: {} };
      },
      start: async () => {
        timeline.push("provider");
        const now = new Date();
        return {
          runId: "run-review",
          runner: "CLAUDE",
          child: null as never,
          pid: null,
          startedAt: now,
          lastProcessAliveAt: now,
          lastProgressEventAt: now,
          inFlightTool: null,
          providerConversationId: null,
          terminalEventSeen: true,
          terminalSuccess: true,
          terminationReason: null,
          sawError: false,
          providerError: null,
          providerState: null,
          finalOutput: null,
          stdout: "",
          stderr: "",
          exit: Promise.resolve({
            exitCode: 0,
            signal: null,
            terminalEventSeen: true,
            terminalSuccess: true,
            terminationReason: null,
            finalOutput: null,
            providerError: null,
            stdout: "",
            stderr: "",
          }),
        };
      },
      heartbeat: async (handle) => ({
        processAlive: false,
        lastProcessAliveAt: handle.lastProcessAliveAt,
        lastProgressEventAt: handle.lastProgressEventAt,
        inFlightTool: null,
      }),
      kill: async () => ({ signal: null, processAlive: false }),
    };
    const claim = {
      ...agentClaim,
      runner: "CLAUDE" as const,
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      task: {
        ...mechanicalClaim.task,
        templateStep: { name: "Code review", outputKind: "result", provisionDependencies: false, taskTemplate: { name: "review-workflow" } },
      },
      run: {
        ...mechanicalClaim.run,
        requiresCommit: false,
        opensPullRequest: false,
        targetBranch: "master",
        maxRunsPerTask: 3,
      },
      session: testSession(root),
    } satisfies ClaimedTask;

    await executeClaimProduction(configured, claim, {
      adapter,
      controlPlane: controlPlane.controlPlane,
      materializeRuntimeTools: async () => undefined,
      provisionSessionConfig: async () => undefined,
    });

    assert.deepEqual(controlPlane.activities.map(({ body }) => body), [
      "Dependency provisioning skipped: TaskTemplateStep.provisionDependencies=false",
    ]);
    assert.ok(timeline.indexOf("activity") < timeline.indexOf("preflight"));
    assert.ok(timeline.indexOf("preflight") < timeline.indexOf("provider"));
    assert.equal(controlPlane.preflightReports.length, 0, "claim preflight is the adapter seam, not startup reporting");
    assert.equal(controlPlane.completions.at(-1)?.outcome.case, "succeeded");
    await assert.rejects(access(join(root, "dependency-cache")), { code: "ENOENT" });
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("an implementation step provisions dependencies without recording the review skip", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-implementation-dependency-activity-"));
  try {
    const remote = await seedDependencyRemote(root);
    const configured = {
      ...config(join(root, "workspaces")),
      home: root,
      path: process.env.PATH ?? "/usr/bin:/bin",
      dependencyCacheRoot: join(root, "dependency-cache"),
    };
    const controlPlane = createControlPlaneDouble({ outputStatus: async () => persistedResultOutput });
    let preflightCalls = 0;
    let startCalls = 0;
    const adapter: CliAdapter = {
      ...adapters.CLAUDE,
      preflight: async ({ env }) => {
        preflightCalls += 1;
        assert.equal((await stat(join(env.AGENTOS_WORKSPACE_PATH!, "node_modules"))).isDirectory(), true);
        assert.equal(
          await readFile(join(env.AGENTOS_WORKSPACE_PATH!, "node_modules", "fixture-tool", "index.cjs"), "utf8"),
          "module.exports = 'dependency fixture';\n",
        );
        return { ok: true, cliVersion: "test", authMode: "test", capabilities: {} };
      },
      start: async () => {
        startCalls += 1;
        const now = new Date();
        return {
          runId: "run-implementation",
          runner: "CLAUDE",
          child: null as never,
          pid: null,
          startedAt: now,
          lastProcessAliveAt: now,
          lastProgressEventAt: now,
          inFlightTool: null,
          providerConversationId: null,
          terminalEventSeen: true,
          terminalSuccess: true,
          terminationReason: null,
          sawError: false,
          providerError: null,
          providerState: null,
          finalOutput: null,
          stdout: "",
          stderr: "",
          exit: Promise.resolve({
            exitCode: 0,
            signal: null,
            terminalEventSeen: true,
            terminalSuccess: true,
            terminationReason: null,
            finalOutput: null,
            providerError: null,
            stdout: "",
            stderr: "",
          }),
        };
      },
      heartbeat: async (handle) => ({
        processAlive: false,
        lastProcessAliveAt: handle.lastProcessAliveAt,
        lastProgressEventAt: handle.lastProgressEventAt,
        inFlightTool: null,
      }),
      kill: async () => ({ signal: null, processAlive: false }),
    };
    const claim = {
      ...agentClaim,
      runner: "CLAUDE" as const,
      repo: {
        ...mechanicalClaim.repo,
        remoteUrl: remote,
        defaultBranch: "master",
        dependencyProvisioning: "NPM_CI",
      },
      task: {
        ...mechanicalClaim.task,
        templateStep: { name: "Implementation", outputKind: "result", provisionDependencies: true, taskTemplate: { name: "implementation-workflow" } },
      },
      run: {
        ...mechanicalClaim.run,
        requiresCommit: false,
        opensPullRequest: false,
        targetBranch: "master",
        maxRunsPerTask: 3,
      },
      session: testSession(root),
    } satisfies ClaimedTask;

    await executeClaimProduction(configured, claim, {
      adapter,
      controlPlane: controlPlane.controlPlane,
      materializeRuntimeTools: async () => undefined,
      provisionSessionConfig: async () => undefined,
    });

    assert.equal(preflightCalls, 1, JSON.stringify(controlPlane.completions));
    assert.equal(startCalls, 1);
    assert.deepEqual(controlPlane.activities
      .filter(({ body }) => body.includes("Dependency provisioning skipped")), []);
    assert.equal(controlPlane.completions.at(-1)?.outcome.case, "succeeded");
  } finally {
    await cleanupTestSession(root);
    try { execFileSync("/bin/chmod", ["-R", "u+w", join(root, "dependency-cache")]); } catch { /* absent cache */ }
    await rm(root, { recursive: true, force: true });
  }
});

test("NPM_CI manifest failure reaches the Run outcome as a non-retryable protocol error before provider launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-implementation-manifest-missing-"));
  try {
    const remote = await seedRemote(root);
    const configured = {
      ...config(join(root, "workspaces")),
      home: root,
      path: process.env.PATH ?? "/usr/bin:/bin",
      dependencyCacheRoot: join(root, "dependency-cache"),
    };
    const controlPlane = createControlPlaneDouble();
    let preflightCalls = 0;
    let startCalls = 0;
    const adapter: CliAdapter = {
      ...adapters.CLAUDE,
      preflight: async () => {
        preflightCalls += 1;
        throw new Error("provider preflight must not be reached after dependency provisioning failure");
      },
      start: async () => {
        startCalls += 1;
        throw new Error("provider start must not be reached after dependency provisioning failure");
      },
    };
    const claim = {
      ...agentClaim,
      runner: "CLAUDE" as const,
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master", dependencyProvisioning: "NPM_CI" as const },
      task: {
        ...mechanicalClaim.task,
        templateStep: { name: "Implementation", outputKind: "result", provisionDependencies: true, taskTemplate: { name: "implementation-workflow" } },
      },
      run: {
        ...mechanicalClaim.run,
        requiresCommit: false,
        opensPullRequest: false,
        targetBranch: "master",
        maxRunsPerTask: 3,
      },
      session: testSession(root),
    } satisfies ClaimedTask;

    await executeClaimProduction(configured, claim, {
      adapter,
      controlPlane: controlPlane.controlPlane,
      materializeRuntimeTools: async () => { throw new Error("runtime tools must not be materialized after provisioning failure"); },
    });

    const completion = controlPlane.completions.at(-1);
    assert.ok(completion, "manifest failure must complete the run");
    assert.equal(completion.outcome.case, "provider-failure");
    assert.equal(failureReasonOf(completion.outcome), "dependency-provisioning-manifest-missing");
    const envelope = envelopeOf(completion.outcome);
    // `agentExited: false` is the fact the API reads as "the environment
    // failed"; the runner no longer asserts an `externalFailure` flag of its own.
    assert.equal(envelope.phase, "PROVISION");
    assert.equal(envelope.agentExited, false);
    assert.equal(envelope.runnerClass, "PROTOCOL_ERROR");
    assert.equal(preflightCalls, 0, "dependency provisioning must fail before adapter preflight");
    assert.equal(startCalls, 0, "dependency provisioning must fail before provider launch");
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("an ordinary claim is not short-circuited by the mechanical refusal", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "runner-agent-"));
  const calls: string[] = [];
  setControlPlane(async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  // Over budget, so it exits on the very next guard — enough to prove the
  // mechanical branch did not swallow it, without provisioning anything.
  await executeClaim(config(workspaceRoot), {
    ...agentClaim,
    run: { ...mechanicalClaim.run, runNumber: 9, maxRunsPerTask: 3 },
  });
  assert.deepEqual(calls, ["http://api.invalid/runner/runs/run-10/complete"]);
});

/* ------------------------------------- Codex is the only backend v0.1 needs */

/**
 * Plan Step 6, evidence row E11. A clean install has one CLI on it: the
 * official Codex one. Claude and Pi are optional, and the property that makes
 * them optional is not a message in the UI — it is that this process reports
 * them blocked, keeps their telemetry, and goes on to run a Codex claim
 * anyway.
 *
 * The stub answers the two official checks and nothing else, and it records
 * what it was asked, so "preserve exact official checks" is asserted rather
 * than assumed: `codex --version`, then `codex login status`. Neither is
 * automated away and nothing reads a credential store.
 */
/**
 * What an unauthenticated CLI actually prints.
 *
 * These are not decoration. A real `codex login status` on a signed-out machine
 * prints whatever it likes — the environment variable it looked for, the remote
 * it tried, the path of the credential file it could not read. That output used
 * to be forwarded verbatim into `RunnerBackendState.circuitReason`, which is
 * returned by `GET /runners` and rendered on the first screen a new operator
 * sees. So the stub prints the three shapes that matter and every assertion
 * below looks for them by name.
 */
const SECRETS = [
  "sk-live-CODEXLEAK9",
  "https://user:hunter2@git.example.test/x.git",
  // Assembled rather than written out: a literal home-directory path is exactly
  // what `snapshot:scan` flags in public source, and a test about not shipping
  // private paths should not ship one.
  ["", "Users", "someone", ".codex", "auth.json"].join("/"),
] as const;

interface CodexStubOptions {
  authFails?: boolean;
  configReportPath?: string;
  session?: {
    lines: readonly string[];
    exitCode: number;
  };
}

const committedFixtureChange = [
  'printf "delivered fixture change\\n" > runner-fixture.txt',
  "git add runner-fixture.txt",
  'git commit -m "test: create delivered fixture change" >/dev/null',
] as const;

const codexStub = (
  log: string,
  {
    authFails = false,
    configReportPath,
    session = {
      lines: [
        'echo \'{"type":"thread.started","thread_id":"thread-6"}\'',
        'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"installed"}}\'',
        'echo \'{"type":"turn.completed"}\'',
      ],
      exitCode: 0,
    },
  }: CodexStubOptions = {},
): string => [
  "#!/bin/sh",
  `echo "$@" >> ${log}`,
  ...(configReportPath ? [`if [ -n "$CODEX_HOME" ]; then printf '%s' "$CODEX_HOME" > ${configReportPath}; fi`] : []),
  'case "$1" in',
  '  --version) echo "codex-cli 0.147.0"; exit 0 ;;',
  '  exec)',
  '    if [ "$2" = "--help" ]; then echo "resume --json --model --config --dangerously-bypass-approvals-and-sandbox"; exit 0; fi',
  '    if [ "$2" = "resume" ] && [ "$3" = "--help" ]; then echo "SESSION_ID --json --model --config --dangerously-bypass-approvals-and-sandbox read from stdin"; exit 0; fi',
  '    ;;',
  authFails
    ? `  login) echo "${SECRETS[0]}"; echo "${SECRETS[1]}" 1>&2; echo "${SECRETS[2]}" 1>&2; exit 1 ;;`
    : '  login) echo "Logged in using ChatGPT"; exit 0 ;;',
  "esac",
  "cat > /dev/null",
  ...(session.exitCode === 0 ? committedFixtureChange : []),
  ...session.lines,
  `exit ${session.exitCode}`,
].join("\n");

const failingCodexStub = (log: string, mutation = ":"): string => [
  "#!/bin/sh",
  `echo "$@" >> ${log}`,
  'case "$1" in',
  '  --version) echo "codex-cli 0.147.0"; exit 0 ;;',
  '  exec)',
  '    if [ "$2" = "--help" ]; then echo "resume --json --model --config --dangerously-bypass-approvals-and-sandbox"; exit 0; fi',
  '    if [ "$2" = "resume" ] && [ "$3" = "--help" ]; then echo "SESSION_ID --json --model --config --dangerously-bypass-approvals-and-sandbox read from stdin"; exit 0; fi',
  '    ;;',
  '  login) echo "Logged in using ChatGPT"; exit 0 ;;',
  "esac",
  "cat > /dev/null",
  mutation,
  'echo \'{"type":"error","message":"agent execution failed"}\'',
  "exit 1",
].join("\n");

const successfulCodexMutationStub = (log: string, mutation: string): string => [
  "#!/bin/sh",
  `echo "$@" >> ${log}`,
  'case "$1" in',
  '  --version) echo "codex-cli 0.147.0"; exit 0 ;;',
  '  exec)',
  '    if [ "$2" = "--help" ]; then echo "resume --json --model --config --dangerously-bypass-approvals-and-sandbox"; exit 0; fi',
  '    if [ "$2" = "resume" ] && [ "$3" = "--help" ]; then echo "SESSION_ID --json --model --config --dangerously-bypass-approvals-and-sandbox read from stdin"; exit 0; fi',
  '    ;;',
  '  login) echo "Logged in using ChatGPT"; exit 0 ;;',
  "esac",
  "cat > /dev/null",
  mutation,
  'echo \'{"type":"thread.started","thread_id":"thread-mutation"}\'',
  'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"implemented"}}\'',
  'echo \'{"type":"turn.completed"}\'',
  "exit 0",
].join("\n");

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const seedRemote = async (root: string): Promise<string> => {
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--initial-branch=master", remote);
  git(root, "init", "--initial-branch=master", seed);
  git(seed, "config", "user.name", "Anneal Test");
  git(seed, "config", "user.email", "runner@agentos.local");
  await writeFile(join(seed, "tree.txt"), "base\n");
  git(seed, "add", "tree.txt");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "master");
  return remote;
};

const seedDependencyRemote = async (root: string): Promise<string> => {
  const remote = await seedRemote(root);
  const seed = join(root, "seed");
  await mkdir(join(seed, "packages/tool"), { recursive: true });
  await writeFile(join(seed, "package.json"), `${JSON.stringify({
    name: "runner-dependency-fixture",
    version: "1.0.0",
    private: true,
    workspaces: ["packages/*"],
    dependencies: { "fixture-tool": "*" },
  })}\n`);
  await writeFile(join(seed, "packages/tool/package.json"), `${JSON.stringify({
    name: "fixture-tool",
    version: "1.0.0",
    main: "index.cjs",
  })}\n`);
  await writeFile(join(seed, "packages/tool/index.cjs"), "module.exports = 'dependency fixture';\n");
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: seed,
    env: process.env,
    stdio: "ignore",
  });
  git(seed, "add", ".");
  git(seed, "commit", "-m", "dependency fixture");
  git(seed, "push", "origin", "master");
  return remote;
};

const commitFixtureChange = async (workspace: string): Promise<void> => {
  await writeFile(join(workspace, "runner-fixture.txt"), "delivered fixture change\n");
  git(workspace, "add", "runner-fixture.txt");
  git(workspace, "commit", "-m", "test: create delivered fixture change");
};

const seedCodexAuth = async (root: string): Promise<void> => {
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(join(root, ".codex", "auth.json"), '{"tokens":"test-only"}\n', { mode: 0o600 });
};

const seedPiAuth = async (root: string): Promise<void> => {
  await mkdir(join(root, ".pi", "agent"), { recursive: true });
  await writeFile(join(root, ".pi", "agent", "auth.json"), '{"openai-codex":{"type":"oauth"}}\n', { mode: 0o600 });
};

const runtimeToolSources = [
  ["merge-train.sh", "../runtime-tools/merge-train.sh"],
  ["merge-train.mjs", "../runtime-tools/merge-train.mjs"],
  ["regression-verification.sh", "../runtime-tools/regression-verification.sh"],
  ["gate-worker/gate-dispatch.sh", "../runtime-tools/gate-worker/gate-dispatch.sh"],
  ["gate-worker/lib.sh", "../runtime-tools/gate-worker/lib.sh"],
  ["gate-worker/mirror-push.sh", "../runtime-tools/gate-worker/mirror-push.sh"],
  ["gate-worker/remote-gate.sh", "../runtime-tools/gate-worker/remote-gate.sh"],
  ["gate-worker/run-gate.sh", "../runtime-tools/gate-worker/run-gate.sh"],
] as const;

const createRuntimeToolsFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "runner-runtime-tools-source-"));
  await mkdir(join(root, "gate-worker"));
  const sourceRoot = dirname(fileURLToPath(import.meta.url));
  await Promise.all(runtimeToolSources.map(async ([relativePath, sourcePath]) => {
    await copyFile(resolve(sourceRoot, sourcePath), join(root, relativePath));
  }));
  return root;
};

const pathWithFailingCommand = async (root: string, command: "cp" | "chmod"): Promise<string> => {
  const bin = join(root, `${command}-fails`);
  await mkdir(bin);
  await writeFile(join(bin, command), `#!/bin/sh\n/bin/${command} "$@"\nexit 73\n`);
  await chmod(join(bin, command), 0o755);
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
};

const outcomeOf = (body: Record<string, unknown>): RunOutcome => body.outcome as RunOutcome;

const removeRetainedSessionConfig = async (completion: { body: Record<string, unknown> }): Promise<void> => {
  const retained = /session CLI config retained at (.+)$/u.exec(failureReasonOf(outcomeOf(completion.body)))?.[1];
  if (retained) await rm(dirname(retained), { recursive: true, force: true });
};

const regressionBlockClaim = (remoteUrl: string): ClaimedTask => ({
  ...agentClaim,
  runner: "CLAUDE",
  repo: { ...mechanicalClaim.repo, remoteUrl, defaultBranch: "master" },
  task: {
    ...mechanicalClaim.task,
    chainId: "chain-1",
    chainIndex: 5,
    templateStep: {
      name: "Regression verification",
      outputKind: "regression-verification-v2",
      provisionDependencies: false,
      taskTemplate: { name: "regression-workflow" },
    },
  },
  run: {
    ...mechanicalClaim.run,
    requiresCommit: false,
    opensPullRequest: false,
    targetBranch: "master",
    maxRunsPerTask: 3,
  },
});

const regressionBlockRecord = (runId: string): string => JSON.stringify({
  schemaVersion: 1,
  runId,
  kind: "regression-verification-v2",
  reason: "target-fetch-failed",
  stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
});

const regressionBlockAdapter = async (
  workingDirectory: string,
  runId: string,
): Promise<ReturnType<CliAdapter["start"]> extends Promise<infer T> ? T : never> => {
  await mkdir(join(workingDirectory, ".agentos"), { recursive: true });
  await writeFile(join(workingDirectory, ".agentos", "regression-output.json"), regressionBlockRecord(runId), { mode: 0o600 });
  const now = new Date();
  return {
    runId,
    runner: "CLAUDE",
    child: null as never,
    pid: null,
    startedAt: now,
    lastProcessAliveAt: now,
    lastProgressEventAt: now,
    inFlightTool: null,
    providerConversationId: null,
    terminalEventSeen: true,
    terminalSuccess: true,
    terminationReason: null,
    sawError: false,
    providerError: null,
    providerState: null,
    finalOutput: null,
    stdout: "",
    stderr: "",
    exit: Promise.resolve({
      exitCode: 0,
      signal: null,
      terminalEventSeen: true,
      terminalSuccess: true,
      terminationReason: null,
      finalOutput: null,
      providerError: null,
      stdout: "",
      stderr: "",
    }),
  };
};

test("a Regression target-fetch block record is reported in the terminal reason and remediation event", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-regression-target-fetch-block-"));
  try {
    const remote = await seedRemote(root);
    const claim = { ...regressionBlockClaim(remote), session: testSession(root) };
    const controlPlane = createControlPlaneDouble({
      outputStatus: async () => ({
        satisfaction: {
          case: "absent",
          outputKind: "regression-verification-v2",
          remediable: false,
        },
        prHandoff: { case: "not-a-pr-delivery" },
      }),
    });
    const adapter: CliAdapter = {
      ...adapters.CLAUDE,
      preflight: async () => ({ ok: true, cliVersion: "test", authMode: "test", capabilities: {} }),
      start: async ({ workingDirectory }) => regressionBlockAdapter(workingDirectory, claim.run.id),
      heartbeat: async () => ({
        processAlive: false,
        lastProcessAliveAt: new Date(),
        lastProgressEventAt: new Date(),
        inFlightTool: null,
      }),
      kill: async () => ({ signal: null, processAlive: false }),
    };

    await executeClaimProduction({ ...config(join(root, "workspaces")), home: root }, claim, {
      materializeRuntimeTools: async () => undefined,
      adapter,
      controlPlane: controlPlane.controlPlane,
      provisionSessionConfig: async () => undefined,
    });

    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.outcome.case, "required-output-unsatisfied");
    assert.match(failureReasonOf(completion?.outcome), /target-fetch-failed/u);
    assert.match(failureReasonOf(completion?.outcome), /could not read Username/u);
    const unavailable = controlPlane.eventBatches.flat()
      .find(({ type }) => type === "TASK_OUTPUT_REMEDIATION_UNAVAILABLE");
    assert.deepEqual(unavailable?.payload, {
      outputKind: "regression-verification-v2",
      outputRemediationAllowed: false,
      providerConversationIdAvailable: false,
      reason: "target-fetch-failed",
      stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    });
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a Regression missing-output refusal without a block record keeps its existing message and payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-regression-no-target-fetch-block-"));
  try {
    const remote = await seedRemote(root);
    const claim = { ...regressionBlockClaim(remote), session: testSession(root) };
    const controlPlane = createControlPlaneDouble({
      outputStatus: async () => ({
        satisfaction: {
          case: "absent",
          outputKind: "regression-verification-v2",
          remediable: false,
        },
        prHandoff: { case: "not-a-pr-delivery" },
      }),
    });
    const adapter: CliAdapter = {
      ...adapters.CLAUDE,
      preflight: async () => ({ ok: true, cliVersion: "test", authMode: "test", capabilities: {} }),
      start: async () => {
        const now = new Date();
        return {
          runId: claim.run.id,
          runner: "CLAUDE",
          child: null as never,
          pid: null,
          startedAt: now,
          lastProcessAliveAt: now,
          lastProgressEventAt: now,
          inFlightTool: null,
          providerConversationId: null,
          terminalEventSeen: true,
          terminalSuccess: true,
          terminationReason: null,
          sawError: false,
          providerError: null,
          providerState: null,
          finalOutput: null,
          stdout: "",
          stderr: "",
          exit: Promise.resolve({
            exitCode: 0,
            signal: null,
            terminalEventSeen: true,
            terminalSuccess: true,
            terminationReason: null,
            finalOutput: null,
            providerError: null,
            stdout: "",
            stderr: "",
          }),
        };
      },
      heartbeat: async () => ({
        processAlive: false,
        lastProcessAliveAt: new Date(),
        lastProgressEventAt: new Date(),
        inFlightTool: null,
      }),
      kill: async () => ({ signal: null, processAlive: false }),
    };

    await executeClaimProduction({ ...config(join(root, "workspaces")), home: root }, claim, {
      materializeRuntimeTools: async () => undefined,
      adapter,
      controlPlane: controlPlane.controlPlane,
      provisionSessionConfig: async () => undefined,
    });

    const completion = controlPlane.completions.at(-1);
    assert.equal(
      failureReasonOf(completion?.outcome),
      `A step declaring output kind 'regression-verification-v2' finished without a current-Run mechanical output handoff for Run ${claim.run.id}`,
    );
    const unavailable = controlPlane.eventBatches.flat()
      .find(({ type }) => type === "TASK_OUTPUT_REMEDIATION_UNAVAILABLE");
    assert.deepEqual(unavailable?.payload, {
      outputKind: "regression-verification-v2",
      outputRemediationAllowed: false,
      providerConversationIdAvailable: false,
      reason: "mechanical-handoff-absent",
    });
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex provision auth failure is PROVISION, retains its root, and never spawns the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-provision-failure-"));
  try {
    const remote = await seedRemote(root);
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "argv.log")));
    await chmod(binary, 0o755);
    const configured = codexOnly(join(root, "workspaces"), root, binary);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    let preflightCalls = 0;
    let startCalls = 0;
    const adapter: CliAdapter = {
      ...adapters.CODEX,
      preflight: async () => { preflightCalls += 1; return { ok: true } as never; },
      start: async () => { startCalls += 1; throw new Error("CLI must not spawn"); },
    };
    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    }, { adapter });
    assert.equal(preflightCalls, 0);
    assert.equal(startCalls, 0);
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(envelopeOf(outcomeOf(completion.body)).phase, "PROVISION");
    assert.match(failureReasonOf(outcomeOf(completion.body)), /Unable to establish Codex authentication/u);
    const retained = /session CLI config retained at (.+)$/u.exec(failureReasonOf(outcomeOf(completion.body)))?.[1];
    assert.ok(retained);
    assert.equal((await stat(retained)).isDirectory(), true);
    await rm(dirname(retained), { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex baseline-copy failure is PROVISION and never reaches preflight or the host config", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-baseline-failure-"));
  try {
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const configured = {
      ...codexOnly(join(root, "workspaces"), root, join(root, "codex-must-not-start")),
      sessionConfigBaselineRoot: join(root, "missing-baseline"),
    };
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    let preflightCalls = 0;
    let startCalls = 0;
    const adapter: CliAdapter = {
      ...adapters.CODEX,
      preflight: async () => { preflightCalls += 1; return { ok: true } as never; },
      start: async () => { startCalls += 1; throw new Error("host ~/.codex must never be used"); },
    };
    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    }, { adapter });
    assert.equal(preflightCalls, 0);
    assert.equal(startCalls, 0);
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(envelopeOf(outcomeOf(completion.body)).phase, "PROVISION");
    assert.match(failureReasonOf(outcomeOf(completion.body)), /Unable to create session CLI config root/u);
    assert.match(failureReasonOf(outcomeOf(completion.body)), /missing-baseline/u);
    await removeRetainedSessionConfig(completion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-tool materialization failure is PROVISION and never reaches preflight or provider start", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-runtime-tools-failure-"));
  try {
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const configured = codexOnly(join(root, "workspaces"), root, join(root, "codex-must-not-start"));
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    let materializeCalls = 0;
    let preflightCalls = 0;
    let startCalls = 0;
    const adapter: CliAdapter = {
      ...adapters.CODEX,
      preflight: async () => { preflightCalls += 1; return { ok: true } as never; },
      start: async () => { startCalls += 1; throw new Error("provider must not spawn"); },
    };
    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    }, {
      adapter,
      materializeRuntimeTools: async (_runnerConfig, scratch) => {
        materializeCalls += 1;
        assert.equal(scratch.toolsDir, join(scratch.base, "tools"));
        throw new Error("release-local runtime tools are absent");
      },
    });
    assert.equal(materializeCalls, 1);
    assert.equal(preflightCalls, 0);
    assert.equal(startCalls, 0);
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(envelopeOf(outcomeOf(completion.body)).phase, "PROVISION");
    assert.match(failureReasonOf(outcomeOf(completion.body)), /release-local runtime tools are absent/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const failureCase of ["collision", "missing source", "wrong source type", "copy failure", "chmod failure"] as const) {
  test(`a runtime-tool ${failureCase} fails before adapter preflight or provider start`, async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-runtime-tools-failure-case-"));
    const sourceRoot = await createRuntimeToolsFixture();
    try {
      const remote = await seedRemote(root);
      const configured = {
        ...codexOnly(join(root, "workspaces"), root, join(root, "codex-must-not-start")),
        ...(failureCase === "copy failure" || failureCase === "chmod failure"
          ? { path: await pathWithFailingCommand(root, failureCase === "copy failure" ? "cp" : "chmod") }
          : {}),
      };
      if (failureCase === "missing source") await rm(join(sourceRoot, "gate-worker", "lib.sh"));
      if (failureCase === "wrong source type") {
        await rm(join(sourceRoot, "gate-worker", "lib.sh"));
        await mkdir(join(sourceRoot, "gate-worker", "lib.sh"));
      }
      const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
      setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
        posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      });
      let preflightCalls = 0;
      let startCalls = 0;
      const adapter: CliAdapter = {
        ...adapters.CODEX,
        preflight: async () => { preflightCalls += 1; return { ok: true } as never; },
        start: async () => { startCalls += 1; throw new Error("provider must not spawn"); },
      };
      await executeClaim(configured, {
        ...agentClaim,
        runner: "CODEX",
        repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
        agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
        run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
        session: testSession(root),
      }, {
        adapter,
        materializeRuntimeTools: (runnerConfig, scratch) => {
          if (failureCase === "collision") return mkdir(scratch.toolsDir).then(() =>
            materializeRuntimeTools(runnerConfig, scratch, { sourceRoot }));
          return materializeRuntimeTools(runnerConfig, scratch, { sourceRoot });
        },
      });
      assert.equal(preflightCalls, 0);
      assert.equal(startCalls, 0);
      const completion = posts.find((post) => post.path.endsWith("/complete"));
      assert.ok(completion);
      assert.equal(envelopeOf(outcomeOf(completion.body)).phase, "PROVISION");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Codex rejects a run-as config-root symlink in PROVISION without copying host auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-config-symlink-"));
  const sessionId = `session-codex-config-symlink-${root.slice(-6)}`;
  const sessionParent = join(await realpath(tmpdir()), "agentos-session-config", sessionId);
  try {
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const plantedTarget = join(root, "planted-target");
    await mkdir(plantedTarget);
    const launcher = join(root, "run-as.sh");
    await writeFile(launcher, [
      "#!/bin/sh",
      `planted_target=${JSON.stringify(plantedTarget)}`,
      'if [ "$1" = "/bin/sh" ] && [ "$4" = "agentos-codex-config" ]; then',
      '  ln -s "$planted_target" "$5"',
      'elif [ "$1" = "/bin/mkdir" ] && [ "$2" = "-m" ] && [ "$3" = "700" ]; then',
      '  case "$4" in */agentos-session-config/*/config) ln -s "$planted_target" "$4" ;; esac',
      "fi",
      'exec "$@"',
    ].join("\n"));
    await chmod(launcher, 0o755);
    const workspaceRoot = join(root, "workspaces");
    await mkdir(workspaceRoot);
    const configured = {
      ...codexOnly(workspaceRoot, root, join(root, "codex-must-not-start")),
      runAsPrefix: [launcher],
    };
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    let preflightCalls = 0;
    let startCalls = 0;
    const adapter: CliAdapter = {
      ...adapters.CODEX,
      preflight: async () => { preflightCalls += 1; return { ok: true } as never; },
      start: async () => { startCalls += 1; throw new Error("host ~/.codex must never be used"); },
    };
    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: { id: sessionId },
    }, { adapter });
    assert.equal(preflightCalls, 0);
    assert.equal(startCalls, 0);
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(envelopeOf(outcomeOf(completion.body)).phase, "PROVISION");
    assert.match(failureReasonOf(outcomeOf(completion.body)), /Unable to create session CLI config root/u);
    assert.match(failureReasonOf(outcomeOf(completion.body)), /mkdir/u);
    assert.deepEqual(await readdir(plantedTarget), [], "neither baseline nor host auth may reach the symlink target");
    assert.equal((await stat(sessionParent)).mode & 0o777, 0o711, "the writable parent window must close after mkdir fails");
  } finally {
    await rm(sessionParent, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/** The config the two tests below share: a real Codex stub, and nothing at all
 *  where the other two CLIs would be. */
const codexOnly = (workspaceRoot: string, root: string, codexBinary: string): RunnerConfig => ({
  ...config(workspaceRoot),
  home: root,
  path: process.env.PATH ?? "/usr/bin:/bin",
  binaries: { CLAUDE: join(root, "no-claude-here"), CODEX: codexBinary, PI: join(root, "no-pi-here") },
});

test("served kinds scope startup and heartbeat reports and the startup log", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-served-kinds-startup-"));
  try {
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "codex-argv.log")));
    await chmod(binary, 0o755);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      posts.push({ path, body });
      return new Response(JSON.stringify({ revalidatePreflight: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const declared = { ...codexOnly(join(root, "workspaces"), root, binary), servedKinds: ["CODEX"] as const };
    const declaredAvailability: string[] = [];
    const declaredPreflight = await runStartupPreflight(declared, {
      onAvailability: ({ runner }) => { declaredAvailability.push(runner); },
    });
    assert.deepEqual(Object.keys(declaredPreflight), ["CODEX"]);
    assert.deepEqual(declaredAvailability, ["CODEX"]);
    assert.equal(startupPreflightLog(declaredPreflight), "CLI preflight: codex=ok");
    assert.deepEqual(posts.map(({ path, body }) => [path, body.runner]), [
      ["http://api.invalid/runner/availability", "CODEX"],
      ["http://api.invalid/runner/preflight", "CODEX"],
    ]);

    posts.length = 0;
    await reportCliAvailabilityHeartbeat(declared);
    assert.deepEqual(posts.map(({ path, body }) => [path, body.runner]), [
      ["http://api.invalid/runner/availability", "CODEX"],
    ]);

    const unrestricted = { ...declared, servedKinds: null };
    posts.length = 0;
    const unrestrictedAvailability: string[] = [];
    const unrestrictedPreflight = await runStartupPreflight(unrestricted, {
      onAvailability: ({ runner }) => { unrestrictedAvailability.push(runner); },
    });
    assert.deepEqual(Object.keys(unrestrictedPreflight), RUNNER_KINDS);
    assert.deepEqual(unrestrictedAvailability, RUNNER_KINDS);
    assert.equal(startupPreflightLog(unrestrictedPreflight), "CLI preflight: claude=blocked codex=ok pi=blocked");
    assert.deepEqual(posts.filter(({ path }) => path.endsWith("/availability")).map(({ body }) => body.runner), RUNNER_KINDS);
    assert.deepEqual(posts.filter(({ path }) => path.endsWith("/preflight")).map(({ body }) => body.runner), ["CODEX"]);

    posts.length = 0;
    await reportCliAvailabilityHeartbeat(unrestricted);
    assert.deepEqual(posts.map(({ path, body }) => [path, body.runner]), RUNNER_KINDS.map((runner) => [
      "http://api.invalid/runner/availability", runner,
    ]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const codexResumeClaim = (remoteUrl: string, root: string): ClaimedTask => ({
  ...agentClaim,
  runner: "CODEX",
  repo: { ...mechanicalClaim.repo, remoteUrl, defaultBranch: "master" },
  agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
  run: {
    ...agentClaim.run,
    model: "gpt-5.6-sol",
    requiresCommit: false,
    opensPullRequest: false,
    maxRunsPerTask: 3,
  },
  session: testSession(root),
});

const reconnectEvidence = (overrides: Partial<ExitEvidence> = {}): ExitEvidence => ({
  exitCode: 0,
  signal: null,
  terminalEventSeen: false,
  terminalSuccess: false,
  terminationReason: null,
  finalOutput: null,
  providerError: "Reconnecting... 3/5 (stream disconnected before completion: tls handshake eof)",
  stdout: "",
  stderr: "",
  ...overrides,
});

const successfulResumeEvidence = (overrides: Partial<ExitEvidence> = {}): ExitEvidence => ({
  exitCode: 0,
  signal: null,
  terminalEventSeen: true,
  terminalSuccess: true,
  terminationReason: null,
  finalOutput: "resumed output",
  providerError: null,
  stdout: "",
  stderr: "",
  ...overrides,
});

type PlannedResumeChild = {
  evidence: ExitEvidence;
  providerConversationId: string | null;
  /** The Codex adapter's own record of the child, when a case needs one. */
  providerState?: CodexProviderState;
  startedAt?: Date;
  event?: AdapterEvent;
  exit?: Promise<ExitEvidence>;
};

type ResumeCall = {
  providerConversationId: string;
  input: string;
};

const fakeRuntimeHandle = (
  claim: ClaimedTask,
  child: PlannedResumeChild,
): RuntimeHandle => {
  const startedAt = child.startedAt ?? new Date();
  return {
    runId: claim.run.id,
    runner: claim.runner,
    child: null as never,
    pid: null,
    startedAt,
    lastProcessAliveAt: startedAt,
    lastProgressEventAt: startedAt,
    inFlightTool: null,
    providerConversationId: child.providerConversationId,
    terminalEventSeen: child.evidence.terminalEventSeen,
    terminalSuccess: child.evidence.terminalSuccess,
    terminationReason: child.evidence.terminationReason,
    sawError: child.evidence.providerError !== null,
    providerError: child.evidence.providerError,
    providerState: child.providerState ?? initialCodexState(),
    finalOutput: child.evidence.finalOutput,
    stdout: child.evidence.stdout,
    stderr: child.evidence.stderr,
    exit: child.exit ?? Promise.resolve(child.evidence),
  };
};

const fakeCodexAdapter = (
  claim: ClaimedTask,
  planned: readonly PlannedResumeChild[],
  resumeCalls: ResumeCall[],
  options: {
    onLaunch?: (handle: RuntimeHandle, resumed: boolean) => void;
    heartbeat?: (handle: RuntimeHandle) => Promise<{
      processAlive: boolean;
      lastProcessAliveAt: Date;
      lastProgressEventAt: Date;
      inFlightTool: null;
    }>;
  } = {},
): CliAdapter => {
  let index = 0;
  const launch = async (
    sink: (event: AdapterEvent) => void,
    resumed: boolean,
  ): Promise<RuntimeHandle> => {
    const child = planned[index++];
    if (!child) throw new Error(`fake Codex launch ${index} was not planned`);
    const handle = fakeRuntimeHandle(claim, child);
    if (child.event) sink(child.event);
    options.onLaunch?.(handle, resumed);
    return handle;
  };
  return {
    ...adapters.CODEX,
    preflight: async () => ({ ok: true, cliVersion: "test", authMode: "test", capabilities: {} }),
    start: async (_spec, sink) => launch(sink, false),
    resume: async (spec, sink) => {
      resumeCalls.push({ providerConversationId: spec.providerConversationId, input: spec.input });
      return launch(sink, true);
    },
    heartbeat: options.heartbeat ?? (async (handle) => ({
      processAlive: false,
      lastProcessAliveAt: handle.lastProcessAliveAt,
      lastProgressEventAt: handle.lastProgressEventAt,
      inFlightTool: null,
    })),
    kill: async (handle, reason) => {
      handle.terminationReason = reason;
      return { signal: "SIGTERM", processAlive: false };
    },
  };
};

const executeCodexResumeScenario = async (
  root: string,
  remote: string,
  planned: readonly PlannedResumeChild[],
  options: {
    claim?: ClaimedTask;
    controlPlaneOverrides?: ControlPlaneOverrides;
    providerResumeBackoff?: (attempt: number) => Promise<void>;
    runLeaseClock?: RunLeaseClock;
    adapter?: (claim: ClaimedTask, resumeCalls: ResumeCall[]) => CliAdapter;
  } = {},
): Promise<{ claim: ClaimedTask; controlPlane: ReturnType<typeof createControlPlaneDouble>; resumeCalls: ResumeCall[] }> => {
  const claim = options.claim ?? codexResumeClaim(remote, root);
  const controlPlane = createControlPlaneDouble(options.controlPlaneOverrides);
  const resumeCalls: ResumeCall[] = [];
  const adapter = options.adapter?.(claim, resumeCalls) ?? fakeCodexAdapter(claim, planned, resumeCalls);
  await executeClaimProduction({
    ...codexOnly(join(root, "workspaces"), root, join(root, "codex-must-not-start")),
    failedWorkspaceRetention: 0,
  }, claim, {
    adapter,
    controlPlane: controlPlane.controlPlane,
    materializeRuntimeTools: async () => undefined,
    provisionSessionConfig: async () => undefined,
    ...(options.providerResumeBackoff ? { providerResumeBackoff: options.providerResumeBackoff } : {}),
    ...(options.runLeaseClock ? { runLeaseClock: options.runLeaseClock } : {}),
  });
  return { claim, controlPlane, resumeCalls };
};

class ResumeFakeClock implements RunLeaseClock {
  time = Date.now();
  readonly intervals = new Set<{ callback: () => void | Promise<void>; intervalMs: number; nextAt: number }>();

  now = (): number => this.time;

  setInterval = (callback: () => void | Promise<void>, intervalMs: number): unknown => {
    const timer = { callback, intervalMs, nextAt: this.time + intervalMs };
    this.intervals.add(timer);
    return timer;
  };

  clearInterval = (timer: unknown): void => {
    this.intervals.delete(timer as { callback: () => void | Promise<void>; intervalMs: number; nextAt: number });
  };

  async advanceBy(deltaMs: number): Promise<void> {
    const target = this.time + deltaMs;
    while (true) {
      const nextAt = this.intervals.size === 0
        ? Number.POSITIVE_INFINITY
        : Math.min(...[...this.intervals].map((timer) => timer.nextAt));
      if (nextAt > target) break;
      this.time = nextAt;
      const due = [...this.intervals].filter((timer) => timer.nextAt === nextAt);
      for (const timer of due) {
        timer.nextAt += timer.intervalMs;
        await timer.callback();
      }
    }
    this.time = target;
  }
}

test("a qualifying Codex disconnect resumes once with the continuation input", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-in-run-resume-success-"));
  try {
    const remote = await seedRemote(root);
    const clock = new ResumeFakeClock();
    const continuation = providerDisconnectResumeInput();
    const firstEvidence = reconnectEvidence();
    const { controlPlane, resumeCalls } = await executeCodexResumeScenario(root, remote, [
      { evidence: firstEvidence, providerConversationId: "thread-resume" },
      { evidence: successfulResumeEvidence(), providerConversationId: null },
    ], {
      providerResumeBackoff: async () => undefined,
      runLeaseClock: clock,
    });

    assert.equal(resumeCalls.length, 1);
    assert.deepEqual(resumeCalls[0], {
      providerConversationId: "thread-resume",
      input: continuation,
    });
    assert.equal(controlPlane.starts.length, 1, "resuming a child must not start a second session");
    assert.equal(controlPlane.completions.at(-1)?.outcome.case, "succeeded");
    assert.equal(
      controlPlane.eventBatches.flat().filter(({ type }) => type === "PROVIDER_RESUME_EXHAUSTED").length,
      0,
    );
    const started = controlPlane.eventBatches.flat().find(({ type }) => type === "PROVIDER_RESUME_STARTED");
    assert.deepEqual(started?.payload, {
      attempt: 1,
      cap: PROVIDER_RESUME_MAX_ATTEMPTS,
      providerConversationId: "thread-resume",
      backoffMs: 0,
      evidence: {
        exitCode: firstEvidence.exitCode,
        signal: firstEvidence.signal,
        terminalEventSeen: firstEvidence.terminalEventSeen,
        terminalSuccess: firstEvidence.terminalSuccess,
        terminationReason: firstEvidence.terminationReason,
        finalOutputTail: null,
        providerErrorTail: firstEvidence.providerError,
        stdoutTail: null,
        stderrTail: null,
      },
    });
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("three Codex resume attempts exhaust on the fourth disconnect and preserve its failure class", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-in-run-resume-exhausted-"));
  try {
    const remote = await seedRemote(root);
    const fourthEvidence = reconnectEvidence({
      providerError: "Reconnecting... 5/5 (stream disconnected before completion: tls handshake eof)",
    });
    let outputStatusReads = 0;
    const { controlPlane, resumeCalls } = await executeCodexResumeScenario(root, remote, [
      { evidence: reconnectEvidence(), providerConversationId: "thread-resume" },
      { evidence: reconnectEvidence(), providerConversationId: null },
      { evidence: reconnectEvidence(), providerConversationId: null },
      { evidence: fourthEvidence, providerConversationId: null },
    ], {
      providerResumeBackoff: async () => undefined,
      controlPlaneOverrides: {
        outputStatus: async () => {
          outputStatusReads += 1;
          return {
            satisfaction: { case: "absent", outputKind: "result", remediable: false },
            prHandoff: { case: "not-a-pr-delivery" },
          };
        },
      },
    });

    assert.equal(resumeCalls.length, PROVIDER_RESUME_MAX_ATTEMPTS);
    const exhausted = controlPlane.eventBatches.flat().filter(({ type }) => type === "PROVIDER_RESUME_EXHAUSTED");
    assert.equal(exhausted.length, 1);
    assert.equal(exhausted[0]?.payload.attempt, PROVIDER_RESUME_MAX_ATTEMPTS + 1);
    assert.equal(exhausted[0]?.payload.cap, PROVIDER_RESUME_MAX_ATTEMPTS);
    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.outcome.case, "provider-failure", JSON.stringify(completion));
    const expectedClass = adapters.CODEX.classifyError(fourthEvidence).failureClass;
    assert.equal(envelopeOf(completion?.outcome).runnerClass, expectedClass);

    // The fourth evidence is classified independently of whether the optional
    // Codex capability is exposed; the resume loop must not alter the verdict.
    const { isProviderDisconnect: _capability, ...withoutCapability } = adapters.CODEX;
    assert.equal(withoutCapability.classifyError(fourthEvidence).failureClass, expectedClass);
    assert.equal(outputStatusReads, 2, "the terminal-product probe runs once, followed by the settling-path read");
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

type NoResumeCase = {
  name: string;
  evidence: ExitEvidence;
  providerConversationId?: string | null;
  withoutCapability?: boolean;
};

// The provider-shaped wording a Codex disconnect is disqualified by is the
// adapter's own question, proven in adapters.test.ts, and the exit record's
// own shape is `agentExitVerdict`'s, proven in run-outcome.test.ts. These
// three cases prove the wiring: the loop starts no second child when the
// verdict is not a drop, when the adapter offers no reading, or when the
// relaunch gate refuses.
const noResumeCases: NoResumeCase[] = [
  {
    name: "a missing provider conversation id",
    evidence: reconnectEvidence(),
    providerConversationId: null,
  },
  {
    name: "an adapter without the optional capability",
    evidence: reconnectEvidence(),
    withoutCapability: true,
  },
  {
    // Codex disconnect wording on an exit the runner itself ended: the shared
    // verdict calls it `stopped`, so the adapter is never consulted.
    name: "an exit the shared verdict does not call a drop",
    evidence: reconnectEvidence({ terminationReason: "cancelled" }),
  },
];

for (const noResumeCase of noResumeCases) {
  test(`a Codex resume is not attempted for ${noResumeCase.name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-codex-in-run-resume-refused-"));
    try {
      const remote = await seedRemote(root);
      const { controlPlane, resumeCalls } = await executeCodexResumeScenario(root, remote, [{
        evidence: noResumeCase.evidence,
        providerConversationId: noResumeCase.providerConversationId === undefined
          ? "thread-resume"
          : noResumeCase.providerConversationId,
      }], {
        providerResumeBackoff: async () => assert.fail("a disqualified exit must not wait before resuming"),
        ...(noResumeCase.withoutCapability ? {
          adapter: (claim, calls) => {
            const { isProviderDisconnect: _capability, ...adapter } = fakeCodexAdapter(claim, [{
              evidence: noResumeCase.evidence,
              providerConversationId: noResumeCase.providerConversationId === undefined
                ? "thread-resume"
                : noResumeCase.providerConversationId,
            }], calls);
            return adapter;
          },
        } : {}),
      });

      assert.equal(resumeCalls.length, 0);
      assert.equal(
        controlPlane.eventBatches.flat().some(({ type }) => type === "PROVIDER_RESUME_STARTED"),
        false,
      );
      assert.equal(controlPlane.completions.at(-1)?.outcome.case, "provider-failure");
    } finally {
      await cleanupTestSession(root);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Codex resume backoff uses attempts one, two, and three within the seven-second ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-in-run-resume-backoff-"));
  const clock = new ResumeFakeClock();
  try {
    const remote = await seedRemote(root);
    const waits: number[] = [];
    const relaunchTimes: number[] = [];
    const planned = [
      { evidence: reconnectEvidence(), providerConversationId: "thread-resume" },
      { evidence: reconnectEvidence(), providerConversationId: null },
      { evidence: reconnectEvidence(), providerConversationId: null },
      { evidence: reconnectEvidence(), providerConversationId: null },
    ] as const;
    const { controlPlane, resumeCalls } = await executeCodexResumeScenario(root, remote, planned, {
      runLeaseClock: clock,
      providerResumeBackoff: async (attempt) => {
        waits.push(attempt);
        await clock.advanceBy([1_000, 2_000, 4_000][attempt - 1]!);
      },
      adapter: (claim, calls) => fakeCodexAdapter(claim, planned, calls, {
        onLaunch: (_handle, resumed) => { if (resumed) relaunchTimes.push(clock.now()); },
      }),
    });

    assert.deepEqual(waits, [1, 2, 3]);
    assert.equal(resumeCalls.length, PROVIDER_RESUME_MAX_ATTEMPTS);
    assert.deepEqual(relaunchTimes.map((time) => time - (relaunchTimes[0]! - 1_000)), [1_000, 3_000, 7_000]);
    assert.ok(
      relaunchTimes.at(-1)! - (relaunchTimes[0]! - 1_000) <= PROVIDER_RESUME_BACKOFF_CEILING_MS,
      "resume backoff exceeded the declared ceiling",
    );
    const started = controlPlane.eventBatches.flat().filter(({ type }) => type === "PROVIDER_RESUME_STARTED");
    assert.deepEqual(started.map((event) => event.payload.backoffMs), [1_000, 2_000, 4_000]);
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

// The lease floor is the one gate fact the backoff itself can invalidate, so
// it is proven end to end: the wait consumes the lease this Run is holding.
test("a lease the backoff consumes down to the floor does not relaunch a disconnected provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-in-run-resume-ttl-floor-"));
  const clock = new ResumeFakeClock();
  try {
    const remote = await seedRemote(root);
    const { controlPlane, resumeCalls } = await executeCodexResumeScenario(root, remote, [{
      evidence: reconnectEvidence(),
      providerConversationId: "thread-resume",
    }], {
      runLeaseClock: clock,
      providerResumeBackoff: async () => { await clock.advanceBy(45_000); },
    });

    assert.equal(resumeCalls.length, 0);
    assert.equal(
      controlPlane.eventBatches.flat().some(({ type }) => type === "PROVIDER_RESUME_STARTED"),
      false,
    );
    assert.equal(controlPlane.completions.at(-1)?.outcome.case, "provider-failure");
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a refused renewal never relaunches a disconnected provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-in-run-resume-refused-"));
  try {
    const remote = await seedRemote(root);
    let heartbeatCalls = 0;
    const result = await executeCodexResumeScenario(root, remote, [{
      evidence: reconnectEvidence(),
      providerConversationId: "thread-resume",
    }], {
      providerResumeBackoff: async () => undefined,
      controlPlaneOverrides: {
        heartbeat: async () => {
          heartbeatCalls += 1;
          return { held: false, reason: "revoked" };
        },
      },
    });

    assert.equal(result.resumeCalls.length, 0, "refused renewal must block relaunch");
    assert.equal(heartbeatCalls, 1, "the gate performs one explicit renewal before stopping");
    assert.equal(result.controlPlane.eventBatches.flat().some(({ type }) => type === "PROVIDER_RESUME_STARTED"), false);
    assert.equal(result.controlPlane.completions.length, 0, "revoked authority follows the existing lease-loss path");
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("an unacknowledged renewal during pending backoff never spawns a resume child", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-in-run-resume-unacknowledged-"));
  try {
    const remote = await seedRemote(root);
    let releaseBackoff!: () => void;
    const backoffPending = new Promise<void>((resolve) => { releaseBackoff = resolve; });
    let renewalAttempted!: () => void;
    const renewalAttempt = new Promise<void>((resolve) => { renewalAttempted = resolve; });
    let observedResumeCalls: ResumeCall[] | null = null;
    const planned = [{ evidence: reconnectEvidence(), providerConversationId: "thread-resume" }] as const;
    const execution = executeCodexResumeScenario(root, remote, planned, {
      providerResumeBackoff: async () => backoffPending,
      adapter: (claim, calls) => {
        observedResumeCalls = calls;
        return fakeCodexAdapter(claim, planned, calls);
      },
      controlPlaneOverrides: {
        heartbeat: async () => {
          renewalAttempted();
          throw new Error("renewal unavailable");
        },
      },
    });

    await renewalAttempt;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((observedResumeCalls as ResumeCall[] | null)?.length ?? 0, 0, "renewal failure must not launch while backoff is pending");
    releaseBackoff();
    const result = await execution;
    assert.equal(result.resumeCalls.length, 0);
    assert.equal(result.controlPlane.completions.at(-1)?.outcome.case, "provider-failure");
    assert.equal(
      envelopeOf(result.controlPlane.completions.at(-1)?.outcome).runnerClass,
      adapters.CODEX.classifyError(planned[0].evidence).failureClass,
    );
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation observed during resume backoff ends the Run without another child", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-in-run-resume-cancel-"));
  const clock = new ResumeFakeClock();
  try {
    const remote = await seedRemote(root);
    let cancellationReady = false;
    const acknowledgements: string[] = [];
    const result = await executeCodexResumeScenario(root, remote, [{
      evidence: reconnectEvidence(),
      providerConversationId: "thread-resume",
    }], {
      runLeaseClock: clock,
      providerResumeBackoff: async () => {
        cancellationReady = true;
        await clock.advanceBy(1_000);
      },
      controlPlaneOverrides: {
        heartbeat: async () => cancellationReady
          ? {
            held: false,
            reason: "cancelled",
            request: { requestId: "resume-cancel", reason: "operator stop", requestedAt: new Date(0).toISOString() },
          }
          : { held: true },
        acknowledgeCancellation: async (request) => { acknowledgements.push(request.requestId); },
      },
    });

    assert.equal(result.resumeCalls.length, 0);
    assert.deepEqual(acknowledgements, ["resume-cancel"]);
    assert.equal(result.controlPlane.completions.length, 0, "cancellation follows the existing cancellation path");
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a resumed Codex child carries one session id through queued events and remediation", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-in-run-resume-session-id-"));
  try {
    const remote = await seedRemote(root);
    const claim = {
      ...codexResumeClaim(remote, root),
      task: {
        ...codexResumeClaim(remote, root).task,
        templateStep: {
          name: "Implementation",
          outputKind: "implementation",
          provisionDependencies: true,
          taskTemplate: { name: "implementation-workflow" },
        },
      },
    };
    const absent: RunOutputEvidence = {
      satisfaction: { case: "absent", outputKind: "implementation", remediable: true },
      prHandoff: { case: "not-a-pr-delivery" },
    };
    const delivered: RunOutputEvidence = {
      satisfaction: { case: "delivered", output: { kind: "implementation", commitSha: null } },
      prHandoff: { case: "not-a-pr-delivery" },
    };
    let outputStatusReads = 0;
    const emittedIds: Array<string | null | undefined> = [];
    let releaseFirstEmit!: () => void;
    const firstEmitBlocked = new Promise<void>((resolve) => { releaseFirstEmit = resolve; });
    const planned = [
      {
        evidence: reconnectEvidence(),
        providerConversationId: "thread-session-id",
        event: { source: "CODEX", type: "MODEL_TEXT", payload: { text: "queued before relaunch" } },
      },
      { evidence: successfulResumeEvidence(), providerConversationId: null },
      { evidence: successfulResumeEvidence({ finalOutput: "remediation complete" }), providerConversationId: null },
    ] as const;
    const { controlPlane, resumeCalls } = await executeCodexResumeScenario(root, remote, planned, {
      claim,
      providerResumeBackoff: async () => undefined,
      controlPlaneOverrides: {
        emit: async (_events, providerConversationId) => {
          emittedIds.push(providerConversationId);
          if (emittedIds.length === 1) await firstEmitBlocked;
        },
        outputStatus: async () => {
          outputStatusReads += 1;
          return outputStatusReads >= 3 ? delivered : absent;
        },
      },
      adapter: (adapterClaim, calls) => fakeCodexAdapter(adapterClaim, planned, calls, {
        onLaunch: (_handle, resumed) => { if (resumed) releaseFirstEmit(); },
      }),
    });

    assert.equal(controlPlane.starts.length, 1, "a resume and remediation share one session.start");
    assert.equal(resumeCalls.length, 2, "the second resume is output remediation");
    assert.deepEqual(resumeCalls.map(({ providerConversationId }) => providerConversationId), [
      "thread-session-id",
      "thread-session-id",
    ]);
    assert.match(resumeCalls[1]?.input ?? "", /task_output/u);
    assert.ok(emittedIds.length > 0, "the queued and resume events must be emitted");
    assert.equal(emittedIds.includes(null), false, "a later child must not publish null over the session id");
    assert.deepEqual(emittedIds, emittedIds.map(() => "thread-session-id"));
    assert.equal(controlPlane.completions.at(-1)?.outcome.case, "succeeded");
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a resumed child inherits an execute-phase stall deadline from its predecessor", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-in-run-resume-stall-"));
  const clock = new ResumeFakeClock();
  try {
    const remote = await seedRemote(root);
    const claim = codexResumeClaim(remote, root);
    const firstStartedAt = new Date(clock.now() - 20 * 60_000);
    let resumedHandle: RuntimeHandle | null = null;
    let resolveResumedExit!: (evidence: ExitEvidence) => void;
    const resumedExit = new Promise<ExitEvidence>((resolve) => { resolveResumedExit = resolve; });
    const planned = [
      {
        evidence: reconnectEvidence(),
        providerConversationId: "thread-stall",
        startedAt: firstStartedAt,
      },
      {
        evidence: reconnectEvidence(),
        providerConversationId: null,
        startedAt: new Date(clock.now()),
        exit: resumedExit,
      },
    ] as const;
    const resumeCalls: ResumeCall[] = [];
    const controlPlane = createControlPlaneDouble();
    const adapter = fakeCodexAdapter(claim, planned, resumeCalls, {
      onLaunch: (handle, resumed) => { if (resumed) resumedHandle = handle; },
      heartbeat: async (handle) => ({
        // The relaunch is alive, which makes the stale carried timestamp the
        // decisive budget fact rather than the generic dead-process gate.
        processAlive: handle === resumedHandle,
        lastProcessAliveAt: new Date(clock.now()),
        lastProgressEventAt: handle.lastProgressEventAt,
        inFlightTool: null,
      }),
    });
    const execution = executeClaimProduction({
      ...codexOnly(join(root, "workspaces"), root, join(root, "codex-must-not-start")),
      failedWorkspaceRetention: 0,
    }, claim, {
      adapter,
      controlPlane: controlPlane.controlPlane,
      materializeRuntimeTools: async () => undefined,
      provisionSessionConfig: async () => undefined,
      providerResumeBackoff: async () => undefined,
      runLeaseClock: clock,
    });

    const launchDeadline = Date.now() + 15_000;
    while (resumedHandle === null && Date.now() < launchDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(resumedHandle, "the resume child must launch before the heartbeat check");
    await clock.advanceBy(5_000);
    resolveResumedExit(reconnectEvidence({
      signal: "SIGTERM",
      terminationReason: "structured progress deadline exceeded",
    }));
    await execution;

    assert.equal(resumeCalls.length, 1);
    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.outcome.case, "budget-exhausted", JSON.stringify(completion));
    assert.equal(
      completion?.outcome.case === "budget-exhausted" ? completion.outcome.gate : null,
      "stall",
      "the carried execute-phase stall, not a fresh child window, must stop the Run",
    );
    assert.match(failureReasonOf(completion?.outcome), /structured progress deadline exceeded/u);
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("event delivery failures do not starve heartbeats and recover in seq order", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-event-heartbeat-isolation-"));
  try {
    const remote = await seedRemote(root);
    const configured = {
      ...config(join(root, "workspaces")),
      home: root,
      heartbeatIntervalMs: 20,
      apiTimeoutMs: 100,
      failedWorkspaceRetention: 0,
      binaries: { CLAUDE: join(root, "unused-claude"), CODEX: join(root, "unused-codex"), PI: join(root, "unused-pi") },
    };
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    let started = false;
    let heartbeatAttempts = 0;
    let eventAttempts = 0;
    let eventFailures = 0;
    let processExited = false;
    let recoverEvents = false;
    let resolveExit!: (evidence: Record<string, unknown>) => void;
    let resolveActiveFailures!: () => void;
    let resolveDeliveryHeartbeat!: () => void;
    let resolvePostExitFailure!: () => void;
    const exit = new Promise<Record<string, unknown>>((resolve) => { resolveExit = resolve; });
    const activeFailures = new Promise<void>((resolve) => { resolveActiveFailures = resolve; });
    const deliveryHeartbeat = new Promise<void>((resolve) => { resolveDeliveryHeartbeat = resolve; });
    const postExitFailure = new Promise<void>((resolve) => { resolvePostExitFailure = resolve; });
    const acceptedBatches: number[][] = [];
    const maybeResolveActiveFailures = (): void => {
      if (heartbeatAttempts >= 2 && eventFailures >= 2) resolveActiveFailures();
    };
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      posts.push({ path, body });
      if (path.endsWith("/start")) started = true;
      if (started && path.endsWith("/heartbeat")) {
        heartbeatAttempts += 1;
        if ((body.inFlightTool as { name?: string } | null)?.name === "delivery") resolveDeliveryHeartbeat();
        maybeResolveActiveFailures();
      }
      if (started && path.endsWith("/events")) {
        eventAttempts += 1;
        if (!recoverEvents) {
          eventFailures += 1;
          maybeResolveActiveFailures();
          if (processExited) resolvePostExitFailure();
          return new Response(JSON.stringify({ error: "events temporarily unavailable" }), { status: 503 });
        }
        acceptedBatches.push((body.events as Array<{ seq: number }>).map((event) => event.seq));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const adapter: CliAdapter = {
      ...adapters.CLAUDE,
      preflight: async () => ({ ok: true, cliVersion: "test", authMode: "test", capabilities: {} }),
      start: async (spec, sink) => {
        await commitFixtureChange(spec.workingDirectory);
        const now = new Date();
        sink({ source: "CLAUDE", type: "EVENT_A", payload: { text: "first" } });
        sink({ source: "CLAUDE", type: "EVENT_B", providerEventId: "provider-b", toolCallId: "tool-b", payload: { text: "second" } });
        sink({ source: "CLAUDE", type: "EVENT_C", payload: { text: "third" } });
        return {
          runner: "CLAUDE",
          child: { exitCode: null, signalCode: null } as never,
          pid: null,
          startedAt: now,
          lastProcessAliveAt: now,
          lastProgressEventAt: now,
          inFlightTool: null,
          providerConversationId: null,
          terminalEventSeen: true,
          terminalSuccess: true,
          terminationReason: null,
          sawError: false,
          providerError: null,
          piTurnCompleted: false,
          finalOutput: null,
          stdout: "",
          stderr: "",
          exit,
        } as never;
      },
      heartbeat: async (handle) => ({
        processAlive: true,
        lastProcessAliveAt: handle.lastProcessAliveAt,
        lastProgressEventAt: handle.lastProgressEventAt,
        inFlightTool: null,
      }),
      kill: async () => ({ signal: null, processAlive: false }),
    };

    const execution = executeClaim(configured, {
      ...agentClaim,
      runner: "CLAUDE",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    }, { adapter });

    await activeFailures;
    processExited = true;
    resolveExit({
      exitCode: 0,
      signal: null,
      terminalEventSeen: true,
      terminalSuccess: true,
      terminationReason: null,
      finalOutput: null,
      providerError: null,
      stdout: "",
      stderr: "",
    });
    await Promise.all([deliveryHeartbeat, postExitFailure]);
    recoverEvents = true;
    await execution;

    assert.ok(heartbeatAttempts >= 3, `expected active heartbeats plus a delivery heartbeat, got ${heartbeatAttempts}`);
    assert.ok(eventFailures >= 3, `expected failures across two active intervals and after exit, got ${eventFailures}`);
    assert.ok(eventAttempts > eventFailures, "the recovered endpoint must receive a retry");
    assert.deepEqual(acceptedBatches, [[0, 1, 2]], "the accepted retry must preserve order and carry each event once");
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.equal(outcomeOf(completion!.body).case, "succeeded", "event recovery must preserve successful completion");
    assert.equal(completion?.body.pushStatus, "SUCCEEDED", "the successful branch must still be delivered");
    const startIndex = posts.findIndex((post) => post.path.endsWith("/start"));
    const firstActiveHeartbeat = posts.findIndex((post, index) => index > startIndex && post.path.endsWith("/heartbeat") && post.body.processAlive === true);
    const eventAfterHeartbeat = posts.findIndex((post, index) => index > firstActiveHeartbeat && post.path.endsWith("/events"));
    assert.ok(firstActiveHeartbeat >= 0 && eventAfterHeartbeat > firstActiveHeartbeat, "heartbeat must be attempted before the interval event flush");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a 413 naming one event of a batch drops that event, records it, and resends the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-event-rejection-"));
  try {
    const remote = await seedRemote(root);
    const configured = {
      ...config(join(root, "workspaces")),
      home: root,
      heartbeatIntervalMs: 20,
      apiTimeoutMs: 100,
      failedWorkspaceRetention: 0,
      binaries: { CLAUDE: join(root, "unused-claude"), CODEX: join(root, "unused-codex"), PI: join(root, "unused-pi") },
    };
    const heartbeatQueueBytes: number[] = [];
    const acceptedBatches: Array<Array<{ seq: number; type: string }>> = [];
    let refusals = 0;
    let resolveExit!: (evidence: Record<string, unknown>) => void;
    const exit = new Promise<Record<string, unknown>>((resolve) => { resolveExit = resolve; });

    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      if (path.endsWith("/heartbeat")) heartbeatQueueBytes.push(body.eventQueueBytes as number);
      if (path.endsWith("/events")) {
        const events = body.events as Array<{ seq: number; type: string }>;
        // Refuse the fourth event of the first batch the runner forms. The
        // runner truncates client-side, so only a cap disagreement across a
        // rolling deployment produces this; the queue must survive it.
        if (refusals === 0 && events.length > 3) {
          refusals += 1;
          return new Response(JSON.stringify({
            error: "Session event payload exceeds the cap",
            code: SESSION_EVENT_PAYLOAD_TOO_LARGE_CODE,
            eventIndex: 3,
            seq: events[3]!.seq,
          }), { status: 413, headers: { "content-type": "application/json" } });
        }
        acceptedBatches.push(events.map((event) => ({ seq: event.seq, type: event.type })));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const adapter: CliAdapter = {
      ...adapters.CLAUDE,
      preflight: async () => ({ ok: true, cliVersion: "test", authMode: "test", capabilities: {} }),
      start: async (spec, sink) => {
        await commitFixtureChange(spec.workingDirectory);
        const now = new Date();
        for (const index of [0, 1, 2, 3, 4]) {
          sink({ source: "CLAUDE", type: `EVENT_${index}`, payload: { text: `event-${index}` } });
        }
        return {
          runner: "CLAUDE",
          child: { exitCode: null, signalCode: null } as never,
          pid: null,
          startedAt: now,
          lastProcessAliveAt: now,
          lastProgressEventAt: now,
          inFlightTool: null,
          providerConversationId: null,
          terminalEventSeen: true,
          terminalSuccess: true,
          terminationReason: null,
          sawError: false,
          providerError: null,
          piTurnCompleted: false,
          finalOutput: null,
          stdout: "",
          stderr: "",
          exit,
        } as never;
      },
      heartbeat: async (handle) => ({
        processAlive: true,
        lastProcessAliveAt: handle.lastProcessAliveAt,
        lastProgressEventAt: handle.lastProgressEventAt,
        inFlightTool: null,
      }),
      kill: async () => ({ signal: null, processAlive: false }),
    };

    const execution = executeClaim(configured, {
      ...agentClaim,
      runner: "CLAUDE",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      session: testSession(root),
    }, { adapter });
    resolveExit({
      exitCode: 0,
      signal: null,
      terminalEventSeen: true,
      terminalSuccess: true,
      terminationReason: null,
      finalOutput: null,
      providerError: null,
      stdout: "",
      stderr: "",
    });
    await execution;

    assert.equal(refusals, 1, "the batch must be refused exactly once");
    const delivered = acceptedBatches.flat();
    assert.deepEqual(
      delivered.filter((event) => /^EVENT_\d$/u.test(event.type)).map((event) => event.type),
      ["EVENT_0", "EVENT_1", "EVENT_2", "EVENT_4"],
      "only the named event is lost, and the rest keep their order",
    );
    const record = delivered.find((event) => event.type === EVENT_REJECTED_EVENT_TYPE);
    assert.ok(record, "the drop is itself recorded as an event");
    assert.ok(
      heartbeatQueueBytes.some((bytes) => bytes > 0),
      "a heartbeat must carry the undelivered queue size an operator watches",
    );
    assert.ok(
      heartbeatQueueBytes.every((bytes) => typeof bytes === "number" && bytes >= 0),
      "every heartbeat carries the field, in every lease phase",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a 413 naming no event drains through smaller batches instead of resending the same body", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-request-too-large-"));
  try {
    const remote = await seedRemote(root);
    const configured = {
      ...config(join(root, "workspaces")),
      home: root,
      heartbeatIntervalMs: 20,
      apiTimeoutMs: 100,
      failedWorkspaceRetention: 0,
      binaries: { CLAUDE: join(root, "unused-claude"), CODEX: join(root, "unused-codex"), PI: join(root, "unused-pi") },
    };
    const acceptedBatches: Array<Array<{ seq: number; type: string }>> = [];
    let refusals = 0;
    let resolveExit!: (evidence: Record<string, unknown>) => void;
    const exit = new Promise<Record<string, unknown>>((resolve) => { resolveExit = resolve; });

    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      if (path.endsWith("/events")) {
        const events = body.events as Array<{ seq: number; type: string }>;
        // A proxy body limit below the API's own cap, or a peer carrying the
        // previous cap through a rolling deployment: the refusal names no
        // event, so only a smaller request can ever be accepted.
        if (events.length > 2) {
          refusals += 1;
          return new Response(JSON.stringify({
            error: "Session event request body exceeds the cap",
            code: SESSION_EVENTS_REQUEST_TOO_LARGE_CODE,
            limitBytes: 1024,
          }), { status: 413, headers: { "content-type": "application/json" } });
        }
        acceptedBatches.push(events.map((event) => ({ seq: event.seq, type: event.type })));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const adapter: CliAdapter = {
      ...adapters.CLAUDE,
      preflight: async () => ({ ok: true, cliVersion: "test", authMode: "test", capabilities: {} }),
      start: async (spec, sink) => {
        await commitFixtureChange(spec.workingDirectory);
        const now = new Date();
        for (const index of [0, 1, 2, 3, 4]) {
          sink({ source: "CLAUDE", type: `EVENT_${index}`, payload: { text: `event-${index}` } });
        }
        return {
          runner: "CLAUDE",
          child: { exitCode: null, signalCode: null } as never,
          pid: null,
          startedAt: now,
          lastProcessAliveAt: now,
          lastProgressEventAt: now,
          inFlightTool: null,
          providerConversationId: null,
          terminalEventSeen: true,
          terminalSuccess: true,
          terminationReason: null,
          sawError: false,
          providerError: null,
          piTurnCompleted: false,
          finalOutput: null,
          stdout: "",
          stderr: "",
          exit,
        } as never;
      },
      heartbeat: async (handle) => ({
        processAlive: true,
        lastProcessAliveAt: handle.lastProcessAliveAt,
        lastProgressEventAt: handle.lastProgressEventAt,
        inFlightTool: null,
      }),
      kill: async () => ({ signal: null, processAlive: false }),
    };

    const execution = executeClaim(configured, {
      ...agentClaim,
      runner: "CLAUDE",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      session: testSession(root),
    }, { adapter });
    resolveExit({
      exitCode: 0,
      signal: null,
      terminalEventSeen: true,
      terminalSuccess: true,
      terminationReason: null,
      finalOutput: null,
      providerError: null,
      stdout: "",
      stderr: "",
    });
    await execution;

    assert.ok(refusals > 0, "the first request must be refused for its size");
    const delivered = acceptedBatches.flat();
    assert.deepEqual(
      delivered.filter((event) => /^EVENT_\d$/u.test(event.type)).map((event) => event.type),
      ["EVENT_0", "EVENT_1", "EVENT_2", "EVENT_3", "EVENT_4"],
      "no event is lost to a refusal that named none, and order is untouched",
    );
    assert.ok(
      acceptedBatches.every((batch) => batch.length <= 2),
      "the runner sends less rather than retrying a body the peer cannot accept",
    );
    assert.equal(
      delivered.filter((event) => event.type === EVENT_REJECTED_EVENT_TYPE).length,
      0,
      "shrinking resolves it, so nothing is dropped",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup reports Claude and Pi blocked, keeps their telemetry, and passes Codex", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-gate-"));
  try {
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log));
    await chmod(binary, 0o755);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const availability: Array<{ runner: string; available: boolean; resolvedPath: string | null }> = [];
    const results = await runStartupPreflight(codexOnly(join(root, "workspaces"), root, binary), {
      onAvailability: (probe) => { availability.push(probe); },
    });

    assert.deepEqual(results, { CLAUDE: false, CODEX: true, PI: false });
    // Telemetry for the absent backends is not dropped: someone does use them,
    // and a silent gap is worse than a reported failure.
    assert.deepEqual(availability.map(({ runner, available }) => ({ runner, available })), [
      { runner: "CLAUDE", available: false },
      { runner: "CODEX", available: true },
      { runner: "PI", available: false },
    ]);
    assert.equal(availability[1]?.resolvedPath, binary);
    assert.deepEqual(posts.map((post) => post.body.runner), ["CLAUDE", "CODEX", "PI", "CODEX"]);
    assert.deepEqual(posts.map((post) => post.path), [
      ...Array<string>(3).fill("http://api.invalid/runner/availability"),
      "http://api.invalid/runner/preflight",
    ]);
    const codex = posts.find((post) => post.path.endsWith("/preflight") && post.body.runner === "CODEX")!;
    assert.equal(codex.body.ok, true);
    assert.equal(codex.body.cliVersion, "codex-cli 0.147.0");
    assert.equal(codex.body.authMode, "chatgpt");
    // The two official checks, in order, and nothing else — no `login --api-key`,
    // no credential file read, no attempt to authenticate on the operator's
    // behalf.
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "--version", "exec --help", "exec resume --help", "login status",
    ]);
    // What is reported about a blocked backend is a verdict and a message, never
    // an environment or a credential.
    const claude = posts.find((post) => post.path.endsWith("/availability") && post.body.runner === "CLAUDE")!;
    assert.equal(claude.body.available, false);
    assert.equal(claude.body.binary, join(root, "no-claude-here"));
    assert.equal(claude.body.resolvedPath, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup blocks a Codex CLI that lacks the exec protocol Anneal invokes", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-incompatible-"));
  try {
    const binary = join(root, "codex.sh");
    await writeFile(binary, [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.1.0"; exit 0; fi',
      'if [ "$1" = "exec" ]; then echo "legacy exec help"; exit 0; fi',
      'if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
      "exit 1",
    ].join("\n"));
    await chmod(binary, 0o755);
    const posts: Array<{ body: Record<string, unknown> }> = [];
    setControlPlane(async (_input: string | URL | Request, init?: RequestInit) => {
      posts.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    assert.deepEqual(
      await runStartupPreflight(codexOnly(join(root, "workspaces"), root, binary)),
      { CLAUDE: false, CODEX: false, PI: false },
    );
    const codex = posts.find((post) => post.body.runner === "CODEX" && "error" in post.body)!;
    assert.equal(codex.body.error, "cli-incompatible: the CLI does not expose the required Anneal exec protocol");
    assert.equal(codex.body.cliVersion, "codex-cli 0.1.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup retries a temporarily unavailable API without rerunning CLI probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-startup-retry-"));
  try {
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log));
    await chmod(binary, 0o755);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    let calls = 0;
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls <= 2) throw new TypeError("fetch failed");
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const waits: number[] = [];
    const retries: Array<{ runner: string; attempt: number; attempts: number }> = [];

    const results = await runStartupPreflight(codexOnly(join(root, "workspaces"), root, binary), {
      wait: async (attempt) => { waits.push(attempt); },
      onRetry: (runner, attempt, attempts) => { retries.push({ runner, attempt, attempts }); },
    });

    assert.deepEqual(results, { CLAUDE: false, CODEX: true, PI: false });
    assert.equal(calls, 6, "two failed sends plus availability for each backend and one Codex preflight");
    assert.deepEqual(waits, [1, 2]);
    assert.deepEqual(retries, [
      { runner: "CLAUDE", attempt: 1, attempts: 5 },
      { runner: "CLAUDE", attempt: 2, attempts: 5 },
    ]);
    assert.deepEqual(posts.map((post) => post.body.runner), ["CLAUDE", "CODEX", "PI", "CODEX"]);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "--version", "exec --help", "exec resume --help", "login status",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup does not retry an API authentication refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-startup-refused-"));
  try {
    const waits: number[] = [];
    let calls = 0;
    setControlPlane(async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    });

    await assert.rejects(
      runStartupPreflight(codexOnly(join(root, "workspaces"), root, join(root, "codex")), {
        wait: async (attempt) => { waits.push(attempt); },
        onRetry: () => assert.fail("a deterministic refusal must not be retried"),
      }),
      /Anneal API 401/u,
    );
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex claim passes its own preflight and starts while the others stay blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-claim-"));
  try {
    const log = join(root, "codex-argv.log");
    const configReportPath = join(root, "successful-config-root.txt");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log, { configReportPath }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const configured = codexOnly(join(root, "workspaces"), root, binary);
    // Startup first, exactly as `index.ts` orders it: the claim below runs on a
    // process that has just reported two of three backends blocked.
    assert.deepEqual(await runStartupPreflight(configured), { CLAUDE: false, CODEX: true, PI: false });
    const codexClaim = {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    } satisfies ClaimedTask;
    await executeClaim(configured, codexClaim);

    const started = posts.find((post) => post.path.endsWith("/start"));
    assert.ok(started, "a blocked Claude and Pi must not keep a Codex run from starting");
    assert.equal(started.body.cliVersion, "codex-cli 0.147.0");
    assert.equal(started.body.authMode, "chatgpt");
    const expectedPromptHash = createHash("sha256").update(buildPrompt(codexClaim)).digest("hex");
    assert.equal(started.body.promptHash, expectedPromptHash);
    assert.equal((started.body.manifest as Record<string, unknown>).promptHash, expectedPromptHash);
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(outcomeOf(completion.body).case, "succeeded");
    assert.equal(completion.body.worktreeContainmentViolations, undefined);
    const configRoot = await readFile(configReportPath, "utf8");
    await assert.rejects(stat(configRoot), /ENOENT/u, "successful Codex runs must remove CODEX_HOME");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an outside worktree is reported without changing a successful run outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-worktree-containment-"));
  try {
    const workspaces = join(root, "workspaces");
    const outsideWorktree = join(root, "outside-worktree");
    const binary = join(root, "codex.sh");
    await writeFile(binary, successfulCodexMutationStub(
      join(root, "argv.log"),
      `git worktree add --detach '${outsideWorktree}' HEAD >/dev/null 2>&1; printf "delivered work\\n" > delivered.txt; git add delivered.txt; git commit -m "test: create delivered change" >/dev/null`,
    ));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim({ ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 }, {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(outcomeOf(completion.body).case, "succeeded");
    assert.equal(completion.body.pushStatus, "SUCCEEDED");
    assert.equal(completion.body.cleanupStatus, "SUCCEEDED");
    assert.deepEqual(completion.body.worktreeContainmentViolations, [await realpath(outsideWorktree)]);
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex records success after reconnecting and reaching terminal completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-reconnect-recovered-"));
  try {
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "argv.log"), {
      session: {
        lines: [
          'echo \'{"type":"error","message":"Reconnecting... 1/5"}\'',
          'echo \'{"type":"error","message":"Reconnecting... 2/5"}\'',
          'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"output persisted"}}\'',
          'echo \'{"type":"turn.completed"}\'',
        ],
        exitCode: 0,
      },
    }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim({ ...codexOnly(join(root, "workspaces"), root, binary), failedWorkspaceRetention: 0 }, {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(outcomeOf(completion.body).case, "succeeded");
    assert.equal(completion.body.output, "output persisted");
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex preserves reconnect evidence when the stream ends before terminal completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-reconnect-interrupted-"));
  try {
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "argv.log"), {
      session: {
        lines: ['echo \'{"type":"error","message":"Reconnecting... 3/5"}\''],
        exitCode: 1,
      },
    }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim({ ...codexOnly(join(root, "workspaces"), root, binary), failedWorkspaceRetention: 0 }, {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(outcomeOf(completion.body).case, "provider-failure");
    assert.match(failureReasonOf(outcomeOf(completion.body)), /Reconnecting\.\.\. 3\/5/u);
    await removeRetainedSessionConfig({ body: completion.body });
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex preserves reconnect evidence when terminal completion is followed by a nonzero exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-reconnect-nonzero-"));
  try {
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "argv.log"), {
      session: {
        lines: [
          'echo \'{"type":"error","message":"Reconnecting... 2/5"}\'',
          'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"not persisted"}}\'',
          'echo \'{"type":"turn.completed"}\'',
        ],
        exitCode: 1,
      },
    }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim({ ...codexOnly(join(root, "workspaces"), root, binary), failedWorkspaceRetention: 0 }, {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(outcomeOf(completion.body).case, "provider-failure");
    assert.match(failureReasonOf(outcomeOf(completion.body)), /Reconnecting\.\.\. 2\/5/u);
    await removeRetainedSessionConfig({ body: completion.body });
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed first completion request restores and retains CODEX_HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-completion-failure-"));
  try {
    const configReportPath = join(root, "config-root.txt");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "argv.log"), { configReportPath }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    let completionAttempts = 0;
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const post = { path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
      posts.push(post);
      if (post.path.endsWith("/complete") && completionAttempts++ === 0) {
        return new Response(JSON.stringify({ error: "completion unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim(codexOnly(join(root, "workspaces"), root, binary), {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    });

    const completions = posts.filter((post) => post.path.endsWith("/complete"));
    assert.equal(completions.length, 2);
    assert.equal(outcomeOf(completions[0]!.body).case, "succeeded");
    assert.equal(outcomeOf(completions[1]!.body).case, "provider-failure");
    const configRoot = await readFile(configReportPath, "utf8");
    assert.match(failureReasonOf(outcomeOf(completions[1]!.body)), new RegExp(`session CLI config retained at ${configRoot.replaceAll("/", "\\/")}$`, "u"));
    assert.equal((await stat(configRoot)).isDirectory(), true);
    await removeRetainedSessionConfig(completions[1]!);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a suspended PI claim retains the session config root for reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-pi-waiting-inbox-"));
  const observed: { scratch?: AgentScratch } = {};
  try {
    const remote = await seedRemote(root);
    await seedPiAuth(root);
    const configured = config(join(root, "workspaces"));
    configured.home = root;

    await executeClaim(configured, {
      ...agentClaim,
      runner: "PI",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "openai-codex/gpt-5.1-codex-max" },
      run: { ...mechanicalClaim.run, model: "openai-codex/gpt-5.1-codex-max", maxRunsPerTask: 3 },
      session: testSession(root),
    }, {
      provisionSessionConfig: async (runnerConfig, runner, provisionedScratch, options) => {
        observed.scratch = provisionedScratch;
        await provisionSessionConfig(runnerConfig, runner, provisionedScratch, options);
        throw Object.assign(new Error("run suspended for Inbox reply"), { status: 409, code: "WAITING_INBOX" });
      },
    });

    assert.ok(observed.scratch);
    assert.equal((await stat(observed.scratch.configRoot)).isDirectory(), true);
    await provisionSessionConfig(configured, "PI", observed.scratch, { reuse: true });
  } finally {
    if (observed.scratch) await cleanupAgentScratch(config(join(root, "workspaces")), observed.scratch).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("session-config cleanup failure does not turn delivered work into a failed run", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-cleanup-failure-"));
  try {
    const configReportPath = join(root, "config-root.txt");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "argv.log"), { configReportPath }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim(codexOnly(join(root, "workspaces"), root, binary), {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    }, {
      cleanupAgentScratch: async (runnerConfig, scratch) => {
        await cleanupAgentScratch(runnerConfig, scratch, { retainConfigRoot: true });
        throw new Error("simulated config cleanup refusal");
      },
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(outcomeOf(completion.body).case, "succeeded");
    assert.equal(completion.body.cleanupStatus, "FAILED");
    const configRoot = await readFile(configReportPath, "utf8");
    assert.match(String(completion.body.cleanupFailureReason), /simulated config cleanup refusal/u);
    assert.match(String(completion.body.cleanupFailureReason), /session CLI config retained at/u);
    assert.equal((await stat(configRoot)).isDirectory(), true);
    await rm(dirname(configRoot), { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default failed-workspace retention still salvages and records the exact durable ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-salvage-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, failingCodexStub(log, 'printf "work\\n" > recovered.txt'));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = codexOnly(workspaces, root, binary);

    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    const salvage = "agentos/task-10/run-1";
    const publication = posts.find((post) => post.path.endsWith("/publication"));
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.equal(publication?.body.pushedBranch, salvage);
    assert.equal(completion?.body.pushedBranch, salvage);
    assert.equal(completion?.body.salvageParentSha, git(root, `--git-dir=${remote}`, "rev-parse", "master").trim());
    assert.equal(completion?.body.cleanupStatus, "RETAINED");
    assert.equal(completion?.body.workspaceRetained, true);
    assert.ok(posts.indexOf(publication!) < posts.indexOf(completion!), "publication must precede terminal completion");
    assert.match(git(root, `--git-dir=${remote}`, "show-ref", `refs/heads/${salvage}`), new RegExp(`refs/heads/${salvage}$`, "u"));
    await access(join(workspaces, "run-10", "recovered.txt"));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a dead delivery lease still salvages before cleanup without terminal API authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dead-lease-salvage-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, failingCodexStub(log, 'printf "work\\n" > recovered.txt'));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    let started = false;
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      posts.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      if (path.endsWith("/start")) started = true;
      if (started && path.endsWith("/heartbeat")) {
        return new Response(JSON.stringify({ error: "Stale fencing token" }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = { ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 };

    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    const salvage = "agentos/task-10/run-1";
    assert.equal(posts.find((post) => post.path.endsWith("/publication"))?.body.pushedBranch, salvage);
    assert.equal(posts.some((post) => post.path.endsWith("/complete")), false);
    assert.match(git(root, `--git-dir=${remote}`, "show-ref", `refs/heads/${salvage}`), new RegExp(`refs/heads/${salvage}$`, "u"));
    await assert.rejects(access(join(workspaces, "run-10")));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a heartbeat cancellation kills the provider group, acknowledges once, and retains the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-active-cancellation-"));
  try {
    const workspaces = join(root, "workspaces");
    const outsideWorktree = join(root, "outside-worktree");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, successfulCodexMutationStub(
      log,
      `git worktree add --detach '${outsideWorktree}' HEAD >/dev/null 2>&1; touch '${outsideWorktree}/ready'; sleep 30`,
    ));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    let started = false;
    let cancellationSent = false;
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      posts.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      if (path.endsWith("/start")) started = true;
      if (started && path.endsWith("/heartbeat") && !cancellationSent) {
        try {
          await access(join(outsideWorktree, "ready"));
        } catch {
          return new Response(JSON.stringify({ ok: true, cancellation: null }), { status: 200, headers: { "content-type": "application/json" } });
        }
        cancellationSent = true;
        return new Response(JSON.stringify({
          ok: false,
          cancellation: { requestId: "cancel-1", reason: "operator stop", requestedAt: new Date(0).toISOString() },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, cancellation: null }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = { ...codexOnly(workspaces, root, binary), heartbeatIntervalMs: 20 };

    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    const acknowledgements = posts.filter((post) => post.path.endsWith("/cancel/acknowledge"));
    assert.equal(acknowledgements.length, 1);
    assert.equal(acknowledgements[0]?.body.requestId, "cancel-1");
    assert.equal(acknowledgements[0]?.body.workspacePath, join(workspaces, "run-10"));
    assert.equal(acknowledgements[0]?.body.branch, "agentos/task-10/run-1");
    assert.deepEqual(acknowledgements[0]?.body.worktreeContainmentViolations, [await realpath(outsideWorktree)]);
    assert.equal(posts.some((post) => post.path.endsWith("/complete")), false);
    assert.equal(posts.some((post) => post.path.endsWith("/publication")), false);
    await access(join(workspaces, "run-10"));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean failed run records that there is nothing to salvage before cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-clean-failure-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, failingCodexStub(log));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = { ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 };

    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    assert.equal(posts.some((post) => post.path.endsWith("/publication")), false);
    assert.ok(posts.some((post) => post.path.endsWith("/activity")
      && String(post.body.body).includes("nothing to salvage")));
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.equal(completion?.body.cleanupStatus, "SUCCEEDED");
    assert.equal(completion?.body.workspaceRetained, false);
    await assert.rejects(access(join(workspaces, "run-10")));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("failed-run salvage excludes worktrees created at the instructed in-workspace location", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-salvage-contained-worktree-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, failingCodexStub(log, [
      "mkdir -p .agentos/worktrees",
      "git worktree add --detach .agentos/worktrees/spike HEAD >/dev/null 2>&1",
      'printf "work\\n" > recovered.txt',
    ].join("; ")));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim({ ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 }, {
      ...agentClaim,
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    const salvage = "agentos/task-10/run-1";
    const salvagedPaths = git(root, `--git-dir=${remote}`, "ls-tree", "--name-only", salvage).split("\n");
    assert.ok(salvagedPaths.includes("recovered.txt"));
    assert.equal(salvagedPaths.some((path) => path.startsWith(".agentos")), false);
    assert.equal(posts.find((post) => post.path.endsWith("/complete"))?.body.worktreeContainmentViolations, undefined);
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed salvage keeps the workspace and reports cleanup failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-salvage-failure-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    const missingRemote = join(root, "missing-origin.git");
    await writeFile(binary, failingCodexStub(log,
      `printf "work\\n" > recovered.txt; git remote set-url origin ${missingRemote}`));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = { ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 };

    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.equal(completion?.body.cleanupStatus, "FAILED");
    assert.equal(completion?.body.workspaceRetained, true);
    assert.match(String(completion?.body.cleanupFailureReason), /WIP salvage failed/u);
    await access(join(workspaces, "run-10", "recovered.txt"));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("successful execution with failed delivery salvages before removing the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-delivery-failure-salvage-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, successfulCodexMutationStub(log, 'printf "delivered work\\n" > recovered.txt; git add recovered.txt; git commit -m "test: create delivered change" >/dev/null'));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const hook = join(remote, "hooks", "pre-receive");
    await writeFile(hook, [
      "#!/bin/sh",
      "while read old new ref; do",
      '  [ "$ref" = "refs/heads/declared/head" ] && exit 1',
      "done",
      "exit 0",
    ].join("\n"));
    await chmod(hook, 0o755);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = { ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 };
    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: {
        ...mechanicalClaim.run,
        model: "gpt-5.6-sol",
        maxRunsPerTask: 3,
        branch: "declared/head",
      },
    });
    const salvage = "agentos/task-10/run-1";
    const publication = posts.find((post) => post.path.endsWith("/publication"));
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.equal(outcomeOf(completion!.body).case, "provider-failure");
    assert.match(failureReasonOf(outcomeOf(completion!.body)), /push|remote|receive/u);
    assert.equal(completion?.body.pushedBranch, salvage);
    assert.equal(completion?.body.cleanupStatus, "SUCCEEDED");
    assert.ok(posts.indexOf(publication!) < posts.indexOf(completion!), "salvage publication must precede cleanup completion");
    assert.match(git(root, `--git-dir=${remote}`, "show-ref", `refs/heads/${salvage}`), new RegExp(`refs/heads/${salvage}$`, "u"));
    await assert.rejects(access(join(workspaces, "run-10")));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a pull-request failure after publication keeps the primary delivery evidence and skips salvage", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-pr-failure-after-push-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    const gh = join(root, "gh");
    const githubRemote = "git@github.com:owner/name.git";
    await writeFile(binary, successfulCodexMutationStub(log, 'printf "delivered work\\n" > delivered.txt; git add delivered.txt; git commit -m "test: create delivered change" >/dev/null'));
    await chmod(binary, 0o755);
    await writeFile(gh, [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "GraphQL: Base branch was not found" 1>&2; exit 1; fi',
      "exit 1",
    ].join("\n"));
    await chmod(gh, 0o755);
    const remote = await seedRemote(root);
    git(root, "config", "--file", join(root, ".gitconfig"), `url.${remote}.insteadOf`, githubRemote);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = {
      ...codexOnly(workspaces, root, binary),
      path: `${root}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      failedWorkspaceRetention: 0,
    };

    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: githubRemote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: {
        ...mechanicalClaim.run,
        model: "gpt-5.6-sol",
        maxRunsPerTask: 3,
        opensPullRequest: true,
        branch: "declared/head",
      },
    });

    const publications = posts.filter((post) => post.path.endsWith("/publication"));
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.deepEqual(publications.map((post) => post.body.pushedBranch), ["declared/head"]);
    assert.equal(outcomeOf(completion!.body).case, "provider-failure");
    assert.equal(completion?.body.pushStatus, "FAILED");
    assert.equal(completion?.body.pushedBranch, "declared/head");
    assert.match(failureReasonOf(outcomeOf(completion!.body)), /Base branch was not found/u);
    assert.match(String(completion?.body.deliveryInstructions), /PR creation failed/u);
    assert.equal(envelopeOf(outcomeOf(completion!.body)).phase, "DELIVER");
    assert.equal(git(root, `--git-dir=${remote}`, "branch", "--list", "agentos/task-10/run-1"), "");
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful pinned review never publishes its dirty detached checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-pinned-no-salvage-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, successfulCodexMutationStub(log, 'printf "review scratch\\n" > review.txt'));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const pinned = git(root, `--git-dir=${remote}`, "rev-parse", "refs/heads/master");
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await executeClaim({ ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 }, {
      ...agentClaim,
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: {
        ...mechanicalClaim.run,
        model: "gpt-5.6-sol",
        targetBranch: pinned,
        pinnedBaseSha: pinned,
        implementationBaseSha: pinned,
        implementationHeadSha: pinned,
      },
    });
    assert.equal(posts.some((post) => post.path.endsWith("/publication")), false);
    assert.equal(outcomeOf(posts.find((post) => post.path.endsWith("/complete"))!.body).case, "succeeded");
    assert.throws(() => git(root, `--git-dir=${remote}`, "show-ref", "refs/heads/agentos/task-10/run-1"));
    await assert.rejects(access(join(workspaces, "run-10")));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed pinned review reports failure without publishing its dirty detached checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-failed-pinned-no-salvage-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, failingCodexStub(log, 'printf "review scratch\\n" > review.txt'));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const pinned = git(root, `--git-dir=${remote}`, "rev-parse", "refs/heads/master");
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim({ ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 }, {
      ...agentClaim,
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: {
        ...mechanicalClaim.run,
        model: "gpt-5.6-sol",
        targetBranch: pinned,
        pinnedBaseSha: pinned,
        implementationBaseSha: pinned,
        implementationHeadSha: pinned,
      },
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.equal(outcomeOf(completion!.body).case, "provider-failure");
    assert.match(failureReasonOf(outcomeOf(completion!.body)), /agent execution failed/u);
    assert.equal(completion?.body.pushedBranch, undefined);
    assert.equal(posts.some((post) => post.path.endsWith("/publication")), false);
    assert.throws(() => git(root, `--git-dir=${remote}`, "show-ref", "refs/heads/agentos/task-10/run-1"));
    await assert.rejects(access(join(workspaces, "run-10")));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a dead-lease salvage failure is durably reported and retains the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dead-lease-salvage-failure-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, failingCodexStub(log, 'printf "work\\n" > recovered.txt'));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const hook = join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    let started = false;
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      posts.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      if (path.endsWith("/start")) started = true;
      if (started && path.endsWith("/heartbeat")) {
        return new Response(JSON.stringify({ error: "Stale fencing token" }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await executeClaim({ ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 }, {
      ...agentClaim,
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });
    const cleanup = posts.find((post) => post.path.endsWith("/cleanup"));
    assert.equal(cleanup?.body.cleanupStatus, "FAILED");
    assert.equal(cleanup?.body.workspaceRetained, true);
    assert.match(String(cleanup?.body.cleanupFailureReason), /WIP salvage failed/u);
    assert.equal(posts.some((post) => post.path.endsWith("/complete")), false);
    await access(join(workspaces, "run-10", "recovered.txt"));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Plan Step 6's security condition: no credential material in telemetry or UI.
 *
 * The channel this closes is specific. A failed preflight's `error` is posted to
 * `POST /runner/preflight`, stored as `RunnerBackendState.circuitReason`,
 * returned by `GET /runners`, and rendered — so a signed-out CLI's stdout became
 * telemetry and then became a screenshot in a bug report. Nothing about that
 * text is bounded, so nothing about it can be sanitised downstream; what is
 * reported is a class this repository authors, plus an exit code.
 *
 * The failure class the run system assigns must survive that, which is the
 * second half of the test: an operator whose Codex is signed out still gets
 * AUTH_REQUIRED and the action that goes with it.
 */
test("a signed-out Codex reports a class and an exit code, never what the CLI printed", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-secret-"));
  try {
    const log = join(root, "codex-argv.log");
    const configReportPath = join(root, "failed-config-root.txt");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log, { authFails: true, configReportPath }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const configured = codexOnly(join(root, "workspaces"), root, binary);
    assert.deepEqual(await runStartupPreflight(configured), { CLAUDE: false, CODEX: false, PI: false });
    const codex = posts.find((post) => post.path.endsWith("/preflight") && post.body.runner === "CODEX")!;
    assert.equal(codex.body.ok, false);
    assert.equal(codex.body.error, "not-authenticated: the CLI's own login check did not pass (exit 1)");
    // The version was read before the login check and is this repository's own
    // reading of `--version`, so it is still reported.
    assert.equal(codex.body.cliVersion, "codex-cli 0.147.0");

    // A claim on the same machine: the run fails, and it fails as AUTH_REQUIRED
    // rather than as a generic task failure, which is what tells the operator to
    // go and run `codex login`.
    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    });
    const completion = posts.find((post) => post.path.endsWith("/complete"))!;
    assert.equal(envelopeOf(outcomeOf(completion.body)).runnerClass, "AUTH_REQUIRED");
    const configRoot = await readFile(configReportPath, "utf8");
    assert.equal((await stat(configRoot)).isDirectory(), true, "failed Codex runs retain CODEX_HOME");

    // Nothing the CLI printed is anywhere in what this process sent — not in the
    // preflight report, not in the run's failure envelope, not in its events.
    const wire = JSON.stringify(posts);
    for (const secret of SECRETS) assert.ok(!wire.includes(secret), `${secret} reached the control plane`);
    // And the login check itself is still the official one, unchanged.
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").slice(0, 4), [
      "--version", "exec --help", "exec resume --help", "login status",
    ]);
    await removeRetainedSessionConfig(completion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex CLI that is not installed is a class of its own, and still reads as a missing binary", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-absent-"));
  try {
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const configured = codexOnly(join(root, "workspaces"), root, join(root, "no-codex-here"));
    assert.deepEqual(await runStartupPreflight(configured), { CLAUDE: false, CODEX: false, PI: false });
    const codex = posts.find((post) => post.path.endsWith("/availability") && post.body.runner === "CODEX")!;
    assert.equal(codex.body.available, false);
    assert.equal(codex.body.binary, join(root, "no-codex-here"));
    assert.equal(codex.body.resolvedPath, null);

    await executeClaim(configured, {
      ...agentClaim,
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    });
    const completion = posts.find((post) => post.path.endsWith("/complete"))!;
    // The runner reports the fact, not the verdict: exit 127 is what the API
    // reads as a missing binary, and the adapter's own guess rides beside it.
    const envelope = envelopeOf(completion.body.outcome as RunOutcome);
    assert.equal(envelope.exitCode, 127);
    assert.equal(envelope.runnerClass, "BINARY_NOT_FOUND");
    assert.ok(!JSON.stringify(posts).includes("ENOENT"));
    await removeRetainedSessionConfig(completion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an availability heartbeat reports a CLI recovery without restarting the runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cli-recovery-"));
  try {
    const binary = join(root, "codex");
    const configured = codexOnly(join(root, "workspaces"), root, binary);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(null, { status: 200 });
    });

    await reportCliAvailabilityHeartbeat(configured);
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
    await chmod(binary, 0o755);
    await reportCliAvailabilityHeartbeat(configured);

    const codexReports = posts.filter((post) => post.body.runner === "CODEX");
    assert.deepEqual(codexReports.map((post) => post.body.available), [false, true]);
    assert.deepEqual(codexReports.map((post) => post.body.resolvedPath), [null, binary]);
    assert.ok(posts.every((post) => post.path === "http://api.invalid/runner/availability"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI availability uses an independent one-minute cadence with stable runner jitter", () => {
  const first = cliAvailabilityHeartbeatSchedule("runner-1");
  const same = cliAvailabilityHeartbeatSchedule("runner-1");
  const other = cliAvailabilityHeartbeatSchedule("runner-2");
  assert.deepEqual(first, same);
  assert.equal(first.intervalMs, 60_000);
  assert.ok(first.initialDelayMs >= 60_000 && first.initialDelayMs < 75_000);
  assert.notEqual(first.initialDelayMs, other.initialDelayMs);
});

test("an availability heartbeat runs one requested preflight and reports its recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-auth-recovery-"));
  try {
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log));
    await chmod(binary, 0o755);
    const configured = codexOnly(join(root, "workspaces"), root, binary);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      posts.push({ path, body });
      const revalidatePreflight = path.endsWith("/runner/availability") && body.runner === "CODEX";
      return new Response(JSON.stringify({ revalidatePreflight }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await reportCliAvailabilityHeartbeat(configured);

    assert.ok(posts.filter((post) => post.path.endsWith("/runner/availability"))
      .every((post) => post.body.runnerId === configured.runnerId));
    const reports = posts.filter((post) => post.path.endsWith("/runner/preflight"));
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.body.runner, "CODEX");
    assert.equal(reports[0]?.body.ok, true);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "--version", "exec --help", "exec resume --help", "login status",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
