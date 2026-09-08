import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { agentExitVerdict, isCodexReconnectStatus } from "@anneal/db";

import {
  adapters, argsForRunner, buildChildEnvironment, buildPrompt, createAdapterState, failureReasonFromEvidence,
  claudePlatformSettingsPath, inputForRunner, launchArgv, mcpConfig, mcpServerPath, nodeBinaryPath, piExtensionPath,
  PREFLIGHT_REASONS, RUNNER_DEFINITIONS, RUNNER_KINDS, runtimeDescriptor, type AdapterState, type ExitEvidence,
} from "./adapters.js";
import { parseClaudeTranscript } from "./adapters/claude.js";
import {
  CODEX_STARTER_MODEL,
  initialCodexState,
  isCodexProviderDisconnect,
  parseCodexEvent,
  parseCodexTranscript,
  type CodexProviderState,
} from "./adapters/codex.js";
import { parsePiTranscript, piDeclaration } from "./adapters/pi.js";
import type { ClaimedTask } from "./api.js";
import type { RunnerConfig, RunnerKind } from "./config.js";
import { hostProofSlotDirectory } from "./host-proof-slots.js";
import { isTransientNetworkError } from "./network-retry.js";
import { cleanupAgentScratch, provisionAgentScratch } from "./workspace.js";

const claim: ClaimedTask = {
  executionMode: "agent",
  specificationMaterialization: null,
  task: {
    id: "task-1",
    chainId: "chain-1",
    chainIndex: 0,
    chainLayer: 0,
    name: "Ship it",
    description: "Do the work",
    repoId: "repo-1",
    targetBranch: "main",
    maxDurationMin: 120,
    stallTimeoutMin: 10,
    maxSessionsPerTask: 3,
    templateStep: null,
  },
  agent: { id: "agent-1", name: "senior-dev-astra-medium", model: "codex", foundationalPrompt: "Foundation", rolePrompt: "Implement", disabledTools: [] },
  repo: {
    id: "repo-1",
    remoteUrl: "/repo",
    defaultBranch: "main",
    mountPath: "repo",
    dependencyProvisioning: "NPM_CI",
  },
  run: {
    id: "run-1",
    taskId: "task-1",
    runNumber: 1,
    opensPullRequest: true,
    requiresCommit: true,
    pullRequestBase: "main",
    maxDurationMin: 120,
    stallTimeoutMin: 10,
    maxRunsPerTask: 3,
    model: "codex",
    codexServiceTier: "DEFAULT",
    subagentModel: null,
    subagentMaxConcurrent: null,
    targetBranch: "main",
    targetBranchPublished: false,
    pinnedBaseSha: null,
    implementationBaseSha: null,
    implementationHeadSha: null,
    promptHash: "hash",
    workspacePath: null,
    branch: null,
    baseSha: null,
  },
  session: { id: "session-1" },
  resume: null,
  nextEventSeq: 0,
  runner: "CODEX",
  fencingToken: "1:run-1:token",
  sessionToken: "agos_session_secret",
  secrets: { ALLOWED_SECRET: "secret" },
  priorOutputs: [],
  operatorNotes: [],
  previousRunHandoff: null,
  regressionRepairHandoff: null,
};

const scratch = {
  base: "/scratch/run-1",
  toolsDir: "/scratch/run-1/tools",
  workspaceRoot: "/scratch/run-1/workspaces",
  stateDir: "/scratch/run-1/control-plane",
  configRoot: "/scratch/run-1/codex-config",
};
const productionRoot = join(homedir(), ".agentos", "runs");

const runSpec = (disabledTools: string[] = []) => ({
  config: { binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" }, runAsPrefix: [] } as unknown as RunnerConfig,
  claim: { ...claim, agent: { ...claim.agent, disabledTools } },
  workingDirectory: "/work",
  env: {},
  prompt: "prompt",
  credentialsPath: "/work/.agentos/session.json",
});

const stableArgv = (args: string[]): string[] => args.map((arg) => arg
  .replaceAll(process.execPath, "<NODE>")
  .replaceAll(mcpServerPath(), "<MCP_SERVER>")
  .replaceAll(piExtensionPath(), "<PI_EXTENSION>")
  .replaceAll(claudePlatformSettingsPath(), "<CLAUDE_SETTINGS>"));

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * How long a real child of this suite may take to reach what a test waits for.
 *
 * Bounded on purpose: a descendant that never dies has to fail rather than hang
 * the gate forever. What it has to cover is a real provider child's node
 * startup, sized for the loaded gate worker rather than an idle host
 * (CONTRIBUTING.md, "Test timing on the gate worker"). Each wait below returns
 * the moment its condition holds, so these budgets cost nothing on a run that
 * passes.
 */
const CHILD_START_BUDGET_MS = 60_000;
/** A process being killed has already started, so only signal delivery and
 *  reaping remain — a shorter budget still leaves room for a starved reaper. */
const CHILD_EXIT_BUDGET_MS = 30_000;
/** The node:test bound for a case that launches real provider children. It is
 *  the outer bound, and every such case uses it directly: it has to exceed the
 *  waits inside the case by a wide margin, or the case dies of the outer budget
 *  while an inner wait was still going to succeed. The widest case waits
 *  CHILD_START_BUDGET_MS then CHILD_EXIT_BUDGET_MS in series (90s), so this
 *  clears the inner waits by a further 90s. Bounded so a child that never
 *  answers is still reported as a failure. */
const SPAWNING_TEST_TIMEOUT_MS = 180_000;

const waitForProcessExit = async (pid: number): Promise<boolean> => {
  const deadline = Date.now() + CHILD_EXIT_BUDGET_MS;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return !processAlive(pid);
};

test("cancellation drains a Run-owned descendant that starts a separate process group", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "agentos-run-drain-"));
  const binary = join(fixture, "provider.mjs");
  const pidFile = join(fixture, "descendant.pid");
  await writeFile(binary, [
    "#!/usr/bin/env node",
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    `const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { detached: true, stdio: "ignore", env: process.env });`,
    "descendant.unref();",
    `writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));`,
    "setInterval(() => undefined, 1000);",
    "",
  ].join("\n"));
  await chmod(binary, 0o755);
  let descendantPid: number | null = null;
  try {
    const spec = runSpec();
    spec.config = { ...spec.config, binaries: { CLAUDE: binary, CODEX: binary, PI: binary } };
    spec.claim = { ...spec.claim, run: { ...spec.claim.run, id: `run-drain-${process.pid}` } };
    spec.workingDirectory = fixture;
    spec.env = { PATH: process.env.PATH ?? "/usr/bin:/bin", AGENTOS_RUN_ID: spec.claim.run.id };
    const handle = await adapters.CODEX.start(spec, () => undefined);
    const descendantDeadline = Date.now() + CHILD_START_BUDGET_MS;
    while (Date.now() < descendantDeadline) {
      try {
        descendantPid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
        break;
      } catch {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    }
    assert.ok(descendantPid && Number.isInteger(descendantPid));
    assert.equal(processAlive(descendantPid), true);
    const result = await adapters.CODEX.kill(handle, "operator stop");
    assert.equal(result.processAlive, false);
    assert.equal(await waitForProcessExit(descendantPid), true, "detached Run-owned descendant survived cancellation");
  } finally {
    if (descendantPid && processAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    await rm(fixture, { recursive: true, force: true });
  }
});

test("buildPrompt combines foundational, role, and task context", () => {
  assert.match(buildPrompt(claim), /Foundation[\s\S]*Role \(senior-dev-astra-medium\): Implement[\s\S]*Task: Ship it[\s\S]*Do the work/);
});

test("a recovery Regression claim carries the pinned context and skip instruction through every adapter", () => {
  const context = {
    state: "queued" as const,
    currentBaseSha: "b".repeat(40),
    authorizedHeadSha: "a".repeat(40),
    recoveryRunId: "run-1",
    priorOutput: {
      runId: "prior-run",
      kind: "regression-verification-v2",
      body: "{\"schemaVersion\":2,\"outcome\":\"pass\"}",
      commitSha: "a".repeat(40),
    },
  };
  const recoveryClaim = {
    ...claim,
    task: {
      ...claim.task,
      templateStep: {
        name: "Regression",
        outputKind: "regression-verification-v2",
        provisionDependencies: true,
        taskTemplate: { name: "regression-workflow" },
      },
    },
    regressionRecoveryContext: context,
  } as unknown as ClaimedTask;
  const prompt = buildPrompt(recoveryClaim);
  assert.match(prompt, /Platform-pinned base-drift recovery instruction:/u);
  assert.match(prompt, /semantic-reused[\s\S]*skip the semantic model recheck[\s\S]*finalize immediately/u);
  assert.match(prompt, /finalize always runs the Merge gate/u);
  assert.match(prompt, /head and baseline frozen by prepare/u);
  assert.doesNotMatch(prompt, /semantic-stale|exit 77/u);

  const config = {
    path: "/bin",
    home: "/runner",
    apiUrl: "http://api",
    runAsPrefix: ["/usr/bin/env", "-i"],
    workspaceRoot: productionRoot,
    hostProofSlots: 3,
  };
  for (const runner of ["CLAUDE", "CODEX", "PI"] as const) {
    const env = buildChildEnvironment(config, { ...recoveryClaim, runner }, scratch, "/work");
    assert.deepEqual(JSON.parse(env.AGENTOS_REGRESSION_RECOVERY_CONTEXT ?? "null"), context, runner);
    const launch = launchArgv(
      { binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" }, runAsPrefix: config.runAsPrefix },
      runner,
      [],
      env,
    );
    assert.ok(launch.args.includes(`AGENTOS_REGRESSION_RECOVERY_CONTEXT=${env.AGENTOS_REGRESSION_RECOVERY_CONTEXT}`), runner);
    const ordinary = buildChildEnvironment(config, { ...claim, runner }, scratch, "/work");
    assert.equal(ordinary.AGENTOS_REGRESSION_RECOVERY_CONTEXT, undefined, runner);
  }
});

test("buildPrompt injects runner-owned worktree containment into every session", () => {
  for (const runner of ["CLAUDE", "CODEX", "PI"] as const) {
    const prompt = buildPrompt({
      ...claim,
      runner,
      run: { ...claim.run, pinnedBaseSha: "a".repeat(40) },
    });
    assert.match(prompt, /Runner-owned run workspace containment:/u);
    assert.match(prompt, /Any git worktree this session creates must live inside the run workspace using a relative path/u);
    assert.match(prompt, /\.\/\.agentos\/worktrees\/<name>/u);
    assert.match(prompt, /This rule overrides any contrary repository documentation/u);
  }
});

test("buildPrompt appends operator notes after the task context", () => {
  const prompt = buildPrompt({
    ...claim,
    operatorNotes: ["Please preserve the existing API shape.", "The deployment window closes at 5pm."],
  });
  assert.match(prompt, /Task: Ship it[\s\S]*Do the work[\s\S]*Operator notes:\n- Please preserve the existing API shape\.\n- The deployment window closes at 5pm\./u);
});

test("buildPrompt states an amendment that landed after the specification was materialized", () => {
  const note = "Task task-9 had its brief amended at 2026-09-06T18:47:00.000Z, after .chain/feature/x/spec.md was materialized.";
  const prompt = buildPrompt({ ...claim, specificationAmendment: note });
  assert.match(prompt, new RegExp(`Do the work[\\s\\S]*Specification of record amended after materialization:\\n- ${note.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  assert.doesNotMatch(buildPrompt(claim), /Specification of record amended after materialization/u);
});

test("buildPrompt labels approval-gate feedback separately from bounded operator notes", () => {
  const feedback = "x".repeat(8_000);
  const prompt = buildPrompt({ ...claim, operatorFeedback: feedback });
  assert.match(prompt, /Operator feedback on previous attempt:\n- /u);
  assert.match(prompt, new RegExp(`Operator feedback on previous attempt:\\n- ${feedback}`));
});

test("buildPrompt makes the platform-pinned pull request base comparison and merge authority", () => {
  const retriedClaim = {
    ...claim,
    task: { ...claim.task, targetBranch: "stale-task-value", description: "Refresh onto the current target branch." },
    run: { ...claim.run, runNumber: 2, pullRequestBase: "release/1.x" },
  };
  const prompt = buildPrompt(retriedClaim);
  assert.match(prompt, /Platform-pinned run authority \(not task-authored text\):/u);
  assert.match(prompt, /run\.pullRequestBase: release\/1\.x/u);
  assert.match(prompt, /run\.pullRequestBase is authoritative for comparison and merge authorization/u);
  assert.match(prompt, /not authority to rewrite the checked-out branch/u);
  assert.doesNotMatch(prompt, /fetch and refresh/u);
  assert.doesNotMatch(prompt, /Template-chain append-only handoff contract:/u);
  assert.doesNotMatch(prompt, /checked-out starting commit is append-only shared lineage and handoff state/u);
  assert.match(prompt, /Task: Ship it[\s\S]*Refresh onto the current target branch\./u);
});

test("buildPrompt protects template-chain handoff lineage from contradictory task instructions", () => {
  const templateClaim = {
    ...claim,
    task: {
      ...claim.task,
      templateStep: { name: "Review implementation", outputKind: "result", provisionDependencies: true, taskTemplate: { name: "review-workflow" } },
      description: "Fetch and refresh onto the current target branch; rebase and force-push if needed.",
    },
    run: { ...claim.run, pullRequestBase: "release/1.x" },
  };
  const prompt = buildPrompt(templateClaim);
  assert.match(prompt, /Template-chain append-only handoff contract:/u);
  assert.match(prompt, /checked-out starting commit is append-only shared lineage and handoff state/u);
  assert.match(prompt, /Final HEAD must descend from it and remain fast-forward publishable/u);
  assert.match(prompt, /Fetch origin\/<run\.pullRequestBase> for comparison only by default/u);
  assert.match(prompt, /a normal merge commit into the checked-out branch is permitted/u);
  assert.match(prompt, /because it preserves the starting commit and fast-forward publishability/u);
  assert.match(prompt, /Task-authored instructions to rewrite the starting commit[\s\S]*are a workflow error: stop and report the conflict/u);
  assert.match(prompt, /Task: Ship it[\s\S]*Fetch and refresh onto the current target branch; rebase and force-push if needed\./u);
});

test("buildPrompt exposes a pinned implementation range without predecessor outputs", () => {
  const pinned = {
    ...claim,
    run: {
      ...claim.run,
      pinnedBaseSha: "b".repeat(40),
      implementationBaseSha: "a".repeat(40),
      implementationHeadSha: "b".repeat(40),
    },
  };
  const prompt = buildPrompt(pinned);
  assert.match(prompt, new RegExp(`implementationBaseSha: ${"a".repeat(40)}`));
  assert.match(prompt, new RegExp(`implementationHeadSha: ${"b".repeat(40)}`));
  assert.doesNotMatch(prompt, /Persisted outputs from prior template steps/u);
});

test("buildPrompt gives a fresh Regression session only the head-bound repair handoff", () => {
  const repaired = {
    ...claim,
    priorOutputs: [{ kind: "must-fix", body: "MF-2", task: { name: "Adjudication", chainIndex: 3 } }],
    regressionRepairHandoff: {
      schemaVersion: 1 as const,
      trigger: {
        kind: "regression-verdict" as const,
        verdict: {
          schemaVersion: 1 as const,
          outcome: "review-fail" as const,
          headSha: "a".repeat(40),
          baseHeadSha: "b".repeat(40),
          summary: "MF-2 remains open",
        },
      },
      repair: {
        kind: "review-fix" as const,
        taskId: "repair-1",
        startHeadSha: "a".repeat(40),
        targetHeadSha: "b".repeat(40),
        resolvedHeadSha: "c".repeat(40),
        outputKind: "result",
        outputBody: "Closed MF-2 and reran its focused regression.",
      },
    },
  };
  const prompt = buildPrompt(repaired);
  assert.match(prompt, /Persisted outputs from prior template steps:[\s\S]*MF-2[\s\S]*Platform-pinned regression repair handoff:/u);
  assert.match(prompt, /fresh provider session; do not assume any prior conversation state/u);
  assert.match(prompt, /MF-2 remains open/u);
  assert.match(prompt, new RegExp(`resolvedHeadSha":"${"c".repeat(40)}`));
  assert.match(prompt, /Closed MF-2 and reran its focused regression/u);
  assert.match(prompt, /verify the checked-out starting HEAD equals repair\.resolvedHeadSha/u);
});

test("buildPrompt pins a repaired Regression retry to the prior same-task pushed head", () => {
  const prompt = buildPrompt({
    ...claim,
    regressionRepairHandoff: {
      schemaVersion: 1,
      trigger: {
        kind: "regression-verdict",
        verdict: {
          schemaVersion: 1,
          outcome: "review-fail",
          headSha: "a".repeat(40),
          baseHeadSha: "b".repeat(40),
          summary: "MF-2 remains open",
        },
      },
      repair: {
        kind: "review-fix",
        taskId: "repair-1",
        startHeadSha: "a".repeat(40),
        targetHeadSha: "b".repeat(40),
        resolvedHeadSha: "c".repeat(40),
        outputKind: "result",
        outputBody: "Closed MF-2.",
      },
      retry: {
        previousRunId: "regression-run-2",
        startHeadSha: "d".repeat(40),
      },
    },
  });
  assert.match(prompt, new RegExp(`previousRunId":"regression-run-2","startHeadSha":"${"d".repeat(40)}`));
  assert.match(prompt, /verify the checked-out starting HEAD equals retry\.startHeadSha/u);
  assert.doesNotMatch(prompt, /verify the checked-out starting HEAD equals repair\.resolvedHeadSha/u);
});

test("buildPrompt gives a retry the immediate prior output without reusing provider context", () => {
  const prompt = buildPrompt({
    ...claim,
    previousRunHandoff: {
      schemaVersion: 1,
      previousRunId: "run-1",
      status: "SUCCEEDED",
      failureReason: null,
      retryReason: "approval-rejected-without-feedback",
      output: { runId: "run-1", kind: "plan", body: "Prior plan body", commitSha: "a".repeat(40) },
      salvage: null,
    },
  });
  assert.match(prompt, /Platform-pinned previous-run handoff:[\s\S]*Prior plan body/u);
  assert.match(prompt, /fresh provider Session/u);
  assert.match(prompt, /approval-rejected-without-feedback/u);
  assert.match(prompt, /output remains bound to Run run-1/u);
  assert.match(prompt, /publish the current Run's canonical task_output/u);
  assert.match(prompt, /Use inbox_ask to obtain the required change/u);
});

test("the prompt manifest names the Anneal tools the session actually got", () => {
  const prompt = buildPrompt(claim);
  // All eight, not the original four: tools/list advertises eight, and a session that is
  // told about four cannot know what it was actually granted.
  for (const tool of [
    "task_activity_log", "task_output", "task_status", "inbox_ask",
    "files_list", "files_read", "files_write", "files_delete",
  ]) assert.match(prompt, new RegExp(tool));
  assert.match(prompt, /Requires a matching FilesystemGrant or returns 403/u);
  // codex/claude see MCP tool names; pi gets the same tools as extension tools.
  assert.match(prompt, /MCP server 'agentos'/);
  assert.match(buildPrompt({ ...claim, runner: "PI" }), /pi extension tools/);
});

test("every CLI is launched with the Anneal tool surface attached", () => {
  const spec = runSpec();
  const claude = argsForRunner("CLAUDE", spec);
  const config = JSON.parse(claude[claude.indexOf("--mcp-config") + 1]!) as ReturnType<typeof mcpConfig>;
  assert.deepEqual(config.mcpServers.agentos!.args, [
    ...[config.mcpServers.agentos!.args[0]!], "--credentials", "/work/.agentos/session.json",
  ]);
  // Strict config keeps the operator's personal MCP servers out of agent sessions.
  assert.ok(claude.includes("--strict-mcp-config"));

  // codex scrubs the environment of MCP servers, so the credentials file is the
  // only channel that reaches it; the tokens themselves stay out of argv.
  const codex = argsForRunner("CODEX", spec).join(" ");
  assert.match(codex, /mcp_servers\.agentos\.command=/);
  assert.match(codex, /--credentials/);
  assert.equal(codex.includes(claim.sessionToken), false);

  assert.ok(argsForRunner("PI", spec).includes("--extension"));
  // Resumed sessions keep the tools; a resume without them silently drops them.
  const resumed = argsForRunner("CODEX", spec, { ...spec, providerConversationId: "thread-1", input: "again" });
  assert.match(resumed.join(" "), /mcp_servers\.agentos\.command=/);
});

test("Claude excludes host settings and auto-memory with the versioned platform settings file", async () => {
  const spec = runSpec();
  const claude = argsForRunner("CLAUDE", spec);
  assert.deepEqual(claude.slice(claude.indexOf("--setting-sources"), claude.indexOf("--setting-sources") + 2), [
    "--setting-sources", "project,local",
  ]);
  const settingsIndex = claude.indexOf("--settings");
  assert.ok(settingsIndex >= 0);
  assert.equal(claude[settingsIndex + 1], claudePlatformSettingsPath());
  const settings = JSON.parse(await readFile(claude[settingsIndex + 1]!, "utf8"));
  assert.equal(settings.autoMemoryEnabled, false);
  assert.equal(settings.disableAllHooks, false, "platform settings override project/local hook disabling");
  assert.equal(settings.hooks.PreToolUse[0].matcher, "^(Agent|Task)$");
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].type, "command");
  const prompt = buildPrompt({ ...claim, runner: "CLAUDE" });
  assert.match(prompt, /opus for implementation.*sonnet only for simple exploration.*haiku only for mechanical scanning/);
  assert.match(prompt, /Keep simple branch merges and integration verification in the main agent/);
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3 },
    { ...claim, runner: "CLAUDE", secrets: { ...claim.secrets, CLAUDE_CONFIG_DIR: "/host/.claude" } },
    scratch,
    "/work",
  );
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.AGENTOS_CODEX_SERVICE_TIER, undefined);
  assert.equal(env.HOME, "/runner", "Claude keeps the runner's existing HOME/authentication path");
});

test("Claude's staged platform settings path is overridable and published", () => {
  const previous = process.env.RUNNER_CLAUDE_SETTINGS_PATH;
  try {
    process.env.RUNNER_CLAUDE_SETTINGS_PATH = "/opt/agentos/lib/claude-platform-settings.json";
    assert.equal(claudePlatformSettingsPath(), "/opt/agentos/lib/claude-platform-settings.json");
    assert.equal(JSON.parse(runtimeDescriptor("runner-1", [])).claudeSettingsPath, "/opt/agentos/lib/claude-platform-settings.json");
  } finally {
    if (previous === undefined) delete process.env.RUNNER_CLAUDE_SETTINGS_PATH;
    else process.env.RUNNER_CLAUDE_SETTINGS_PATH = previous;
  }
});

test("runner proxy environment wins over task secrets for Claude, Codex, and Pi", () => {
  const config = {
    path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3,
    proxyEnvironment: { HTTP_PROXY: "http://runner-http", HTTPS_PROXY: "http://runner-https", NO_PROXY: "localhost" },
  };
  for (const runner of ["CLAUDE", "CODEX", "PI"] as const) {
    const env = buildChildEnvironment(
      config,
      { ...claim, runner, secrets: { ...claim.secrets, HTTP_PROXY: "http://task-http", HTTPS_PROXY: "http://task-https", NO_PROXY: "task" } },
      scratch,
      "/work",
    );
    assert.equal(env.HTTP_PROXY, "http://runner-http");
    assert.equal(env.HTTPS_PROXY, "http://runner-https");
    assert.equal(env.NO_PROXY, "localhost");
  }
});

test("host proof slot environment is runner-owned and survives each run-as adapter", () => {
  const workspaceRoot = "/shared/runner-workspaces";
  const hostProofSlots = 7;
  for (const runner of ["CLAUDE", "CODEX", "PI"] as const) {
    const env = buildChildEnvironment(
      {
        path: "/bin",
        home: "/runner",
        apiUrl: "http://api",
        runAsPrefix: [],
        workspaceRoot,
        hostProofSlots,
      },
      {
        ...claim,
        runner,
        secrets: {
          ...claim.secrets,
          AGENTOS_HOST_PROOF_SLOT_DIR: "/task-controlled/slots",
          AGENTOS_HOST_PROOF_SLOTS: "99",
        },
      },
      scratch,
      "/work",
    );
    assert.equal(env.AGENTOS_HOST_PROOF_SLOT_DIR, hostProofSlotDirectory({ workspaceRoot }));
    assert.equal(env.AGENTOS_HOST_PROOF_SLOTS, String(hostProofSlots));
    assert.notEqual(env.AGENTOS_HOST_PROOF_SLOT_DIR, hostProofSlotDirectory({ workspaceRoot: scratch.workspaceRoot }));

    const launch = launchArgv(
      {
        binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
        runAsPrefix: ["/usr/bin/env", "-i"],
      },
      runner,
      [],
      env,
    );
    assert.ok(launch.args.includes(`AGENTOS_HOST_PROOF_SLOT_DIR=${hostProofSlotDirectory({ workspaceRoot })}`));
    assert.ok(launch.args.includes(`AGENTOS_HOST_PROOF_SLOTS=${hostProofSlots}`));
  }
});

test("AGENTOS_TOOLS is platform-owned for ordinary and regression steps across every adapter", () => {
  const config = {
    path: "/bin",
    home: "/runner",
    apiUrl: "http://api",
    runAsPrefix: [],
    workspaceRoot: productionRoot,
    hostProofSlots: 3,
  };
  const secrets = {
    ...claim.secrets,
    AGENTOS_TOOLS: "/checkout/task-secret-tools",
    AGENTOS_CHAIN_ID: "task-secret-chain",
    AGENTOS_PULL_REQUEST_BASE: "task-secret-base",
  };
  for (const runner of ["CLAUDE", "CODEX", "PI"] as const) {
    const ordinaryEnv = buildChildEnvironment(config, { ...claim, runner, secrets }, scratch, "/work");
    assert.equal(ordinaryEnv.AGENTOS_TOOLS, scratch.toolsDir, `${runner} ordinary step accepted a task-owned tools path`);
    // Keep the existing behavior for non-regression task secrets unchanged.
    assert.equal(ordinaryEnv.AGENTOS_CHAIN_ID, "task-secret-chain");
    assert.equal(ordinaryEnv.AGENTOS_PULL_REQUEST_BASE, "task-secret-base");

    const regressionEnv = buildChildEnvironment(
      config,
      {
        ...claim,
        runner,
        task: { ...claim.task, templateStep: { name: "Regression", outputKind: "regression-verification-v2", provisionDependencies: true, taskTemplate: { name: "regression-workflow" } } },
        secrets,
      },
      scratch,
      "/work",
    );
    assert.equal(regressionEnv.AGENTOS_TOOLS, scratch.toolsDir, `${runner} regression step accepted a task-owned tools path`);
    assert.equal(regressionEnv.AGENTOS_CHAIN_ID, "chain-1");
    assert.equal(regressionEnv.AGENTOS_PULL_REQUEST_BASE, "main");
  }
});

test("only regression steps reserve platform-owned chain and base coordinates", () => {
  const secrets = {
    ...claim.secrets,
    AGENTOS_CHAIN_ID: "task-secret-chain",
    AGENTOS_PULL_REQUEST_BASE: "task-secret-base",
  };
  const regressionEnv = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3 },
    {
      ...claim,
      task: { ...claim.task, templateStep: { name: "Regression", outputKind: "regression-verification-v2", provisionDependencies: true, taskTemplate: { name: "regression-workflow" } } },
      secrets,
    },
    scratch,
    "/work",
  );
  assert.equal(regressionEnv.AGENTOS_CHAIN_ID, "chain-1");
  assert.equal(regressionEnv.AGENTOS_PULL_REQUEST_BASE, "main");
  assert.throws(() => buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3 },
    {
      ...claim,
      task: { ...claim.task, chainId: null, templateStep: { name: "Regression", outputKind: "regression-verification-v2", provisionDependencies: true, taskTemplate: { name: "regression-workflow" } } },
      secrets,
    },
    scratch,
    "/work",
  ), /regression-verification task is missing its platform chain id/u);

  const ordinaryEnv = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3 },
    { ...claim, secrets },
    scratch,
    "/work",
  );
  assert.equal(ordinaryEnv.AGENTOS_CHAIN_ID, "task-secret-chain");
  assert.equal(ordinaryEnv.AGENTOS_PULL_REQUEST_BASE, "task-secret-base");
});

test("a credential-bearing runner proxy stays in env and out of run-as argv", () => {
  const proxyUrl = ["http://proxy-user:", "proxy-pass@", "proxy.invalid:7897"].join("");
  const config = {
    path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: ["sudo", "-E", "--"], workspaceRoot: productionRoot, hostProofSlots: 3,
    binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
    proxyEnvironment: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl },
  };
  const env = buildChildEnvironment(config, { ...claim, runner: "PI" }, scratch, "/work", "/work/.git/anneal-hooks");
  const launch = launchArgv(config, "PI", ["--version"], env);
  const argv = [launch.executable, ...launch.args].join(" ");
  assert.equal(env.HTTP_PROXY, proxyUrl);
  assert.equal(env.HTTPS_PROXY, proxyUrl);
  assert.equal(argv.includes(proxyUrl), false);
  assert.equal(argv.includes("proxy-pass"), false);
  assert.match(argv, /RUNNER_WORKSPACE_ROOT=/u);
  assert.match(argv, /CONTROL_PLANE_STATE_DIR=/u);
  assert.match(argv, /AGENTOS_RUN_ID=run-1/u);
  assert.match(argv, /GIT_CONFIG_COUNT=2/u);
  assert.match(argv, /GIT_CONFIG_KEY_0=credential\.helper/u);
  assert.match(argv, /GIT_CONFIG_VALUE_0=\S*\/git-credential-runner\.sh/u);
  assert.match(argv, /GIT_CONFIG_KEY_1=core\.hooksPath/u);
  assert.match(argv, /GIT_CONFIG_VALUE_1=\/work\/\.git\/anneal-hooks/u);
});

test("a session answers git credentials through the runner account's own home", () => {
  // Codex and PI relocate HOME, so a helper declared in the account's global
  // config resolves no credentials inside a session. Without this the platform
  // can only ever drive public repositories.
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3 },
    claim,
    scratch,
    "/work",
  );
  assert.equal(env.AGENTOS_RUNNER_HOME, "/runner");
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "credential.helper");
  assert.equal(env.GIT_CONFIG_VALUE_0, join(scratch.toolsDir, "git-credential-runner.sh"));
});

test("the interpreter the CLI is told to run the MCP server with is overridable and published", () => {
  // process.execPath is a *resolved* path — a Homebrew Cellar or nvm directory,
  // not the symlink on RUNNER_PATH. Under a run-as prefix the CLI is a different
  // account, and if that account cannot traverse the resolved path the failure
  // arrives as an MCP protocol error inside an agent session. The override lets a
  // deployment name an interpreter both principals can execute; the descriptor
  // publishes whichever one is in force so it can be checked from outside.
  const previous = process.env.RUNNER_NODE_BINARY;
  try {
    delete process.env.RUNNER_NODE_BINARY;
    assert.equal(nodeBinaryPath(), process.execPath);
    assert.equal(mcpConfig("/work/.agentos/session.json").mcpServers.agentos!.command, process.execPath);

    process.env.RUNNER_NODE_BINARY = "/opt/agentos/bin/node";
    assert.equal(nodeBinaryPath(), "/opt/agentos/bin/node");
    // Both CLIs, not just claude: codex builds its command through a separate path.
    assert.equal(mcpConfig("/work/.agentos/session.json").mcpServers.agentos!.command, "/opt/agentos/bin/node");
    assert.ok(argsForRunner("CODEX", runSpec()).includes("mcp_servers.agentos.command=\"/opt/agentos/bin/node\""));

    const descriptor = JSON.parse(runtimeDescriptor("runner-1", ["sudo", "-u", "_agentos1", "-E", "--"]));
    assert.equal(descriptor.runtime, "agentos-runner");
    assert.equal(descriptor.nodeBinary, "/opt/agentos/bin/node");
    // The real execPath stays visible too: verify.sh checks the override is in
    // force rather than inferring it from a path that happens to be readable.
    assert.equal(descriptor.nodeExecPath, process.execPath);
    assert.equal(descriptor.mcpServerPath, mcpServerPath());
    assert.equal(descriptor.piExtensionPath, piExtensionPath());
    assert.equal(descriptor.claudeSettingsPath, claudePlatformSettingsPath());
    assert.match(descriptor.codexBaselinePath, /session-config-baseline\/codex\/config\.toml$/u);
    assert.equal(descriptor.runAsPrefix, "sudo -u _agentos1 -E --");
  } finally {
    if (previous === undefined) delete process.env.RUNNER_NODE_BINARY;
    else process.env.RUNNER_NODE_BINARY = previous;
  }
});

test("an empty denied set keeps every runner argv byte-identical", () => {
  const spec = runSpec();
  assert.deepEqual(stableArgv(argsForRunner("CLAUDE", spec)), [
    "-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--model", "codex", "--effort", "high",
    "--setting-sources", "project,local", "--settings", "<CLAUDE_SETTINGS>",
    "--mcp-config", "{\"mcpServers\":{\"agentos\":{\"type\":\"stdio\",\"command\":\"<NODE>\",\"args\":[\"<MCP_SERVER>\",\"--credentials\",\"/work/.agentos/session.json\"]}}}",
    "--strict-mcp-config",
  ]);
  assert.deepEqual(stableArgv(argsForRunner("CODEX", spec)), [
    "exec", "--json", "-m", "codex",
    "-c", "service_tier=\"default\"",
    "-c", "mcp_servers.agentos.command=\"<NODE>\"",
    "-c", "mcp_servers.agentos.args=[\"<MCP_SERVER>\",\"--credentials\",\"/work/.agentos/session.json\"]",
    "-c", "mcp_servers.agentos.startup_timeout_sec=30",
    "--dangerously-bypass-approvals-and-sandbox", "-",
  ]);
  assert.deepEqual(stableArgv(argsForRunner("PI", spec)), [
    "-p", "--mode", "json", "--session-dir", "/work/.agentos-pi", "--model", "codex",
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--extension", "<PI_EXTENSION>",
  ]);
});

test("Codex fresh and resume launches pin the Run service tier explicitly", () => {
  const fast = runSpec();
  fast.claim = {
    ...fast.claim,
    run: { ...fast.claim.run, model: "gpt-5.6-luna:max", codexServiceTier: "FAST" },
  };
  const resume = { ...fast, providerConversationId: "thread-fast", input: "continue" };
  for (const args of [argsForRunner("CODEX", fast), argsForRunner("CODEX", fast, resume)]) {
    assert.ok(args.includes('service_tier="fast"'));
    assert.ok(args.includes('model_reasoning_effort="max"'));
    assert.ok(args.includes("gpt-5.6-luna"));
  }
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3 },
    fast.claim,
    scratch,
    "/work",
  );
  assert.equal(env.AGENTOS_CODEX_SERVICE_TIER, "fast");
});

test("Codex fresh and resume launches preserve non-interactive tool authorization", () => {
  const spec = runSpec();
  const resume = { ...spec, providerConversationId: "thread-1", input: "continue" };
  for (const args of [argsForRunner("CODEX", spec), argsForRunner("CODEX", spec, resume)]) {
    assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  }
});

test("native implementation subagents are pinned on fresh and resumed Codex launches", () => {
  const executioner = {
    ...claim,
    agent: { ...claim.agent, name: "plan-executor-astra-medium" },
    run: {
      ...claim.run,
      subagentModel: "gpt-5.6-luna:max",
      subagentMaxConcurrent: 8,
    },
  };
  const resume = { ...runSpec(), claim: executioner, providerConversationId: "thread-child", input: "continue" };
  for (const args of [argsForRunner("CODEX", { ...runSpec(), claim: executioner }), argsForRunner("CODEX", resume, resume)]) {
    assert.ok(args.includes("multi_agent_v2"));
    assert.ok(args.includes('agents.default_subagent_model="gpt-5.6-luna"'));
    assert.ok(args.includes('agents.default_subagent_reasoning_effort="max"'));
    assert.ok(args.includes("agents.max_concurrent_threads_per_session=8"));
  }
  const prompt = buildPrompt(executioner);
  assert.match(prompt, /maximum concurrent child threads: 8 \(root excluded\)/u);
  assert.match(prompt, /do not launch nested Codex CLI processes/u);
  assert.match(prompt, /The runner enforces the same child model and concurrency snapshot on fresh starts and resumes/u);
  assert.doesNotMatch(prompt, /Implementation proof is limited/u);
  assert.doesNotMatch(prompt, /repository-wide suites/u);
  assert.throws(
    () => buildPrompt({
      ...executioner,
      run: {
        ...executioner.run,
        subagentMaxConcurrent: null,
      },
    }),
    /incomplete native subagent snapshot/u,
  );
  assert.throws(() => buildPrompt({
    ...executioner,
    run: { ...executioner.run, subagentModel: "gpt-5.6-sol:high" },
  }), /must use gpt-5\.6-luna:max with concurrency 8/u);
  assert.throws(
    () => buildPrompt({ ...executioner, runner: "PI" }),
    /require a Codex root Run/u,
  );
});

test("the PI extension injects the explicit tier only into openai-codex requests", async () => {
  type ProviderContext = { model?: { provider?: string }; abort(): void; shutdown(): void };
  const loaded = await import(pathToFileURL(piExtensionPath()).href) as {
    default: (pi: {
      registerTool(tool: Record<string, unknown>): void;
      on(event: "before_provider_request", handler: (event: { type: "before_provider_request"; payload: unknown }, context: ProviderContext) => unknown): void;
    }) => void;
  };
  let handler: ((event: { type: "before_provider_request"; payload: unknown }, context: ProviderContext) => unknown) | undefined;
  loaded.default({
    registerTool: () => undefined,
    on: (_event, next) => { handler = next; },
  });
  assert.ok(handler);
  const previous = process.env.AGENTOS_CODEX_SERVICE_TIER;
  const previousExpectedProvider = process.env.AGENTOS_PI_EXPECTS_OPENAI_CODEX;
  let aborted = 0;
  let shutdown = 0;
  const context = (provider: string): ProviderContext => ({
    model: { provider },
    abort: () => { aborted += 1; },
    shutdown: () => { shutdown += 1; },
  });
  try {
    process.env.AGENTOS_CODEX_SERVICE_TIER = "fast";
    assert.deepEqual(handler({ type: "before_provider_request", payload: { model: "gpt-5.6-luna" } }, context("openai-codex")), {
      model: "gpt-5.6-luna",
      service_tier: "priority",
    });
    assert.equal(handler({ type: "before_provider_request", payload: {} }, context("anthropic")), undefined);
    process.env.AGENTOS_PI_EXPECTS_OPENAI_CODEX = "1";
    assert.deepEqual(handler({ type: "before_provider_request", payload: {} }, {
      abort: () => { aborted += 1; },
      shutdown: () => { shutdown += 1; },
    }), { service_tier: "agentos-provider-mismatch" });
    delete process.env.AGENTOS_PI_EXPECTS_OPENAI_CODEX;
    process.env.AGENTOS_CODEX_SERVICE_TIER = "default";
    assert.deepEqual(handler({ type: "before_provider_request", payload: {} }, context("openai-codex")), {
      service_tier: "default",
    });
    delete process.env.AGENTOS_CODEX_SERVICE_TIER;
    assert.deepEqual(handler({ type: "before_provider_request", payload: {} }, context("openai-codex")), {
      service_tier: "agentos-invalid-service-tier",
    });
    assert.equal(aborted, 2);
    assert.equal(shutdown, 2);
  } finally {
    if (previousExpectedProvider === undefined) delete process.env.AGENTOS_PI_EXPECTS_OPENAI_CODEX;
    else process.env.AGENTOS_PI_EXPECTS_OPENAI_CODEX = previousExpectedProvider;
    if (previous === undefined) delete process.env.AGENTOS_CODEX_SERVICE_TIER;
    else process.env.AGENTOS_CODEX_SERVICE_TIER = previous;
  }
});

test("PI runtime preflight rejects an openai-codex Run whose explicit service tier is absent", async () => {
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3 },
    {
      ...claim,
      runner: "PI",
      run: { ...claim.run, model: "openai-codex/gpt-5.6-sol:high" },
      secrets: { ...claim.secrets, AGENTOS_PI_EXPECTS_OPENAI_CODEX: "0" },
    },
    scratch,
    "/work",
  );
  assert.equal(env.AGENTOS_PI_EXPECTS_OPENAI_CODEX, "1");
  assert.equal(env.AGENTOS_CODEX_SERVICE_TIER, "default");
  const result = await adapters.PI.preflight({
    config: {} as RunnerConfig,
    runner: "PI",
    model: "openai-codex/gpt-5.6-sol:high",
    env: { AGENTOS_RUN_ID: "run-1" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "PI openai-codex runs require an explicit Anneal Codex service tier");
});

test("Pi relies on its isolated config root while retaining the explicit Anneal extension", () => {
  const args = argsForRunner("PI", runSpec());
  assert.equal(args.includes("--no-extensions"), false, "the global extension kill switch would cancel the Anneal extension");
  for (const flag of ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve"]) {
    assert.equal(args.filter((arg) => arg === flag).length, 1, `${flag} must be unconditional`);
  }
  assert.equal(args.filter((arg) => arg === "--extension").length, 1);
  assert.equal(args[args.indexOf("--extension") + 1], piExtensionPath());
});

test("no runner carries the prompt or the resume input in argv", () => {
  const spec = runSpec();
  const resume = { ...spec, providerConversationId: "thread-1", input: "again" };
  for (const runner of ["CLAUDE", "CODEX", "PI"] satisfies RunnerKind[]) {
    for (const args of [argsForRunner(runner, spec), argsForRunner(runner, spec, resume)]) {
      assert.equal(args.includes("prompt"), false, `${runner} put the prompt in argv`);
      assert.equal(args.includes("again"), false, `${runner} put the resume input in argv`);
    }
  }
  // codex needs the positional `-`, which is what tells it to read stdin.
  assert.equal(argsForRunner("CODEX", spec).at(-1), "-");
  assert.equal(argsForRunner("CODEX", spec, resume).at(-1), "-");
  // Resume still names the conversation to resume; only the input moved.
  assert.deepEqual(argsForRunner("CLAUDE", spec, resume).slice(-2), ["--resume", "thread-1"]);
  assert.deepEqual(argsForRunner("PI", spec, resume).slice(-2), ["--session", "thread-1"]);
  assert.deepEqual(argsForRunner("CODEX", spec, resume).slice(0, 2), ["exec", "resume"]);
  assert.equal(argsForRunner("CODEX", spec, resume).includes("thread-1"), true);
  assert.equal(inputForRunner(spec), "prompt");
  assert.equal(inputForRunner(spec, resume), "again");
});

test("denied tools map in canonical order without consuming the prompt", () => {
  const spec = runSpec(["BASH", "WEB_SEARCH"]);
  const claude = argsForRunner("CLAUDE", spec);
  const pi = argsForRunner("PI", spec);
  assert.deepEqual(claude.slice(claude.indexOf("--disallowedTools"), claude.indexOf("--disallowedTools") + 2), ["--disallowedTools", "Bash,WebSearch"]);
  assert.deepEqual(pi.slice(pi.indexOf("--exclude-tools"), pi.indexOf("--exclude-tools") + 2), ["--exclude-tools", "bash"]);
  assert.equal(argsForRunner("CODEX", spec).includes("--disallowedTools"), false);
  assert.deepEqual(argsForRunner("CODEX", spec), argsForRunner("CODEX", runSpec()));
  assert.ok(claude.indexOf("--disallowedTools") <= claude.length - 4);
  assert.equal(claude.at(-1), "--strict-mcp-config");
});

test("all eight denied tools use each CLI's supported canonical subset", () => {
  const spec = runSpec(["WEB_SEARCH", "GREP", "EDIT", "GLOB", "WRITE", "BASH", "WEB_FETCH", "READ"]);
  const claude = argsForRunner("CLAUDE", spec);
  const pi = argsForRunner("PI", spec);
  assert.equal(claude[claude.indexOf("--disallowedTools") + 1], "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch");
  assert.equal(pi[pi.indexOf("--exclude-tools") + 1], "bash,read,write,edit");
});

test("resume invocations preserve supported deny flags", () => {
  const spec = runSpec(["BASH", "READ"]);
  const resume = { ...spec, providerConversationId: "thread-1", input: "again" };
  assert.equal(argsForRunner("CLAUDE", spec, resume).includes("--disallowedTools"), true);
  assert.equal(argsForRunner("PI", spec, resume).includes("--exclude-tools"), true);
  assert.equal(argsForRunner("CODEX", spec, resume).some((arg) => arg.includes("Tools")), false);
});

// --- launch boundary: the largest prompt a legal chain can produce -----------
//
// `POST /runner/tasks/claim` hands the runner every prior step output verbatim,
// and the write endpoint caps one output at 500k characters. The canonical
// template chain is nine steps, so the last step's claim legally carries eight
// of them. Put that in argv and the run dies at `spawn` with E2BIG — Linux
// refuses any single argument over MAX_ARG_STRLEN (128 KiB), macOS refuses an
// argument block over ~1 MiB — before the provider is ever contacted. These
// tests spawn real processes, so they fail the same way the runner would.
const MAX_STEP_OUTPUT_CHARS = 500_000;
const MAX_PRIOR_OUTPUTS = 8;
const MAX_ARG_STRLEN = 128 * 1024;

const priorOutput = (index: number): ClaimedTask["priorOutputs"][number] => {
  const head = `step-${index}-start\n`;
  const tail = `\nstep-${index}-end`;
  return {
    kind: "spec",
    body: `${head}${"x".repeat(MAX_STEP_OUTPUT_CHARS - head.length - tail.length)}${tail}`,
    task: { name: `Step ${index}`, chainIndex: index },
  };
};

// The child these tests spawn is this stub, not the vendor CLI: `runAsPrefix`
// replaces the binary. So everything below is evidence about *Anneal's* side of
// the process boundary — the bytes it writes to the child's stdin and the argv it
// builds — and deliberately claims nothing about what a real `claude`, `codex` or
// `pi` process does with what it reads. The vendor CLIs are free to normalise the
// outer whitespace of a piped prompt, and that is acceptable: `buildPrompt`
// carries no significant leading or trailing whitespace, only interior structure,
// which no CLI rewrites.
//
// It reports a digest rather than only a length because a byte count alone would
// pass on reordered or corrupted content.
const stubScript = [
  "const { createHash } = require('node:crypto');",
  "let bytes = 0;",
  "const digest = createHash('sha256');",
  "process.stdin.on('data', (chunk) => { bytes += chunk.length; digest.update(chunk); });",
  "process.stdin.on('end', () => {",
  "  const longestArg = process.argv.slice(1).reduce((max, arg) => Math.max(max, Buffer.byteLength(arg)), 0);",
  "  process.stdout.write(JSON.stringify({ type: 'turn.completed', bytes, longestArg, sha256: digest.digest('hex') }) + '\\n');",
  "});",
].join("");

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const launch = async (
  runner: RunnerKind,
  claimed: ClaimedTask,
  resume?: { providerConversationId: string; input: string },
): Promise<{ evidence: ExitEvidence; report: { bytes: number; longestArg: number; sha256: string }; events: Array<{ type: string; payload: Record<string, unknown> }> }> => {
  const config = {
    binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
    runAsPrefix: [process.execPath, "-e", stubScript],
  } as unknown as RunnerConfig;
  const spec = {
    config,
    claim: { ...claimed, runner },
    workingDirectory: process.cwd(),
    env: process.env,
    prompt: buildPrompt(claimed),
    credentialsPath: "/tmp/session.json",
  };
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const sink = (event: { type: string; payload: Record<string, unknown> }): void => { events.push(event); };
  const handle = resume
    ? await adapters[runner].resume({ ...spec, ...resume }, sink)
    : await adapters[runner].start(spec, sink);
  const evidence = await handle.exit;
  const line = evidence.stdout.trim().split("\n").at(-1) ?? "{}";
  return { evidence, report: JSON.parse(line) as { bytes: number; longestArg: number; sha256: string }, events };
};

test("every runner launches with the largest legal chain prompt and receives all of it", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
  const maximal: ClaimedTask = {
    ...claim,
    priorOutputs: Array.from({ length: MAX_PRIOR_OUTPUTS }, (_, index) => priorOutput(index)),
    regressionRepairHandoff: null,
  };
  const prompt = buildPrompt(maximal);
  assert.ok(prompt.length > MAX_PRIOR_OUTPUTS * MAX_STEP_OUTPUT_CHARS, "the fixture must exceed every argv limit");
  for (const runner of ["CLAUDE", "CODEX", "PI"] satisfies RunnerKind[]) {
    const { evidence, report } = await launch(runner, maximal);
    assert.equal(evidence.exitCode, 0, `${runner} failed to launch: ${evidence.stderr}`);
    assert.equal(evidence.signal, null);
    assert.equal(report.bytes, Buffer.byteLength(prompt), `${runner} did not receive the whole prompt`);
    assert.equal(report.sha256, sha256(prompt), `${runner} received the right byte count but not the right bytes`);
    assert.ok(report.longestArg < MAX_ARG_STRLEN, `${runner} argv element of ${report.longestArg} bytes risks E2BIG`);
  }
});

test("every runner is handed the prompt and the resume input byte-exact at the process boundary", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
  // Scope, stated once: the child is the stub above, so this proves what Anneal
  // writes and spawns — the full prompt on stdin, digest-identical, and an argv
  // that never carries it. Whether the vendor CLI then trims a trailing newline
  // of its own is outside this boundary and outside what Anneal controls.
  const prompt = buildPrompt(claim);
  const resumeInput = "operator answered: approve";
  // What makes the tolerance above safe, kept checkable instead of asserted in a
  // comment: if a prompt ever grows outer whitespace, a CLI trimming it would be
  // dropping something Anneal meant to send.
  assert.equal(prompt, prompt.trim(), "buildPrompt must keep no significant outer whitespace");
  assert.equal(resumeInput, resumeInput.trim());
  for (const runner of ["CLAUDE", "CODEX", "PI"] satisfies RunnerKind[]) {
    const started = await launch(runner, claim);
    assert.equal(started.evidence.exitCode, 0);
    assert.equal(started.report.bytes, Buffer.byteLength(prompt));
    assert.equal(started.report.sha256, sha256(prompt), `${runner} altered the prompt on the way to stdin`);
    assert.equal(
      started.evidence.stdout,
      `${JSON.stringify({ type: "turn.completed", ...started.report })}\n`,
      `${runner} changed the provider stdout evidence while capturing it`,
    );
    const processStarted = started.events.find((event) => event.type === "PROCESS_STARTED");
    assert.equal(processStarted?.payload.promptTransport, "stdin");
    assert.equal(processStarted?.payload.promptBytes, Buffer.byteLength(prompt));
    assert.equal(processStarted?.payload.promptHash, sha256(prompt));
    assert.equal((processStarted?.payload.args as string[]).some((arg) => arg.includes("Do the work")), false);

    const resumed = await launch(runner, claim, { providerConversationId: "thread-1", input: resumeInput });
    assert.equal(resumed.evidence.exitCode, 0);
    assert.equal(resumed.report.bytes, Buffer.byteLength(resumeInput));
    assert.equal(resumed.report.sha256, sha256(resumeInput), `${runner} altered the resume input on the way to stdin`);
    const resumedProcessStarted = resumed.events.find((event) => event.type === "PROCESS_STARTED");
    assert.equal(resumedProcessStarted?.payload.promptHash, sha256(resumeInput));
  }
});

test("Claude partial stream stdout is excluded from exit evidence", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "agentos-claude-partial-evidence-"));
  const binary = join(fixture, "claude-stub.sh");
  const partial = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
  });
  const splitPartial = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "split" } },
  });
  const finalPartial = JSON.stringify({
    type: "stream_event",
    event: { type: "message_stop" },
  });
  const splitAt = Math.floor(splitPartial.length / 2);
  const assistant = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "complete" }] },
  });
  await writeFile(binary, [
    "#!/bin/sh",
    "cat >/dev/null",
    `printf '%s\\n' ${JSON.stringify(partial)}`,
    `printf '%s' ${JSON.stringify(splitPartial.slice(0, splitAt))}`,
    "sleep 0.01",
    `printf '%s\\n' ${JSON.stringify(splitPartial.slice(splitAt))}`,
    `printf '%s\\n' ${JSON.stringify(assistant)}`,
    `printf '%s' ${JSON.stringify(finalPartial)}`,
    "exit 1",
    "",
  ].join("\n"));
  await chmod(binary, 0o755);
  try {
    const spec = runSpec();
    spec.config = { ...spec.config, binaries: { CLAUDE: binary, CODEX: binary, PI: binary } };
    spec.claim = { ...spec.claim, runner: "CLAUDE" };
    spec.workingDirectory = fixture;
    spec.env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const handle = await adapters.CLAUDE.start(spec, (event) => { events.push(event); });
    const evidence = await handle.exit;

    assert.equal(evidence.exitCode, 1);
    assert.doesNotMatch(evidence.stdout, /stream_event/u);
    assert.match(evidence.stdout, /assistant/u);
    assert.equal(events.some((event) => event.payload.type === "stream_event"), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

// A REAL `pi --mode json` transcript, captured 2026-08-25 against pi 0.84.2 and
// openai-codex/gpt-5.6-luna with the exact flags argsForRunner builds:
//
//   echo "Run the bash command 'echo hello' and then tell me its output." \
//     | pi -p --mode json --session-dir ./sess --model openai-codex/gpt-5.6-luna \
//         --thinking low --no-skills --no-prompt-templates --no-themes \
//         --no-context-files --no-approve
//
// Trimmed to the events that decide the harvest, each one byte-verbatim: the two
// assistant `message_end`s, the two `turn_end`s that REPEAT them (the double
// count this must not make), and the empty terminal event. If an assertion below
// ever disagrees with these numbers, the code is wrong, never the capture.
const PI_TRANSCRIPT: unknown[] = [
  {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "toolCall", "id": "call_BRyJNXBbsbjHm3nGCztVKlvn|fc_00e0eb3701447702016a8e2fcce81487d0ae08cfa4c0db0a75", "name": "bash", "arguments": {"command": "echo hello"}}], "api": "openai-codex-responses", "provider": "openai-codex", "model": "gpt-5.6-luna", "usage": {"input": 4620, "output": 19, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0, "totalTokens": 4639, "cost": {"input": 0.0009240000000000001, "output": 2.28e-05, "cacheRead": 0, "cacheWrite": 0, "total": 0.0009468000000000001}}, "stopReason": "toolUse", "timestamp": 1787703240541, "responseId": "resp_00e0eb3701447702016a8e2fcb669887d0ade1277f25377b3a", "rawStopReason": "completed"}},
  {"type": "turn_end", "message": {"role": "assistant", "content": [{"type": "toolCall", "id": "call_BRyJNXBbsbjHm3nGCztVKlvn|fc_00e0eb3701447702016a8e2fcce81487d0ae08cfa4c0db0a75", "name": "bash", "arguments": {"command": "echo hello"}}], "api": "openai-codex-responses", "provider": "openai-codex", "model": "gpt-5.6-luna", "usage": {"input": 4620, "output": 19, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0, "totalTokens": 4639, "cost": {"input": 0.0009240000000000001, "output": 2.28e-05, "cacheRead": 0, "cacheWrite": 0, "total": 0.0009468000000000001}}, "stopReason": "toolUse", "timestamp": 1787703240541, "responseId": "resp_00e0eb3701447702016a8e2fcb669887d0ade1277f25377b3a", "rawStopReason": "completed"}, "toolResults": [{"role": "toolResult", "toolCallId": "call_BRyJNXBbsbjHm3nGCztVKlvn|fc_00e0eb3701447702016a8e2fcce81487d0ae08cfa4c0db0a75", "toolName": "bash", "content": [{"type": "text", "text": "hello\n"}], "isError": false, "timestamp": 1787703245849}]},
  {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "hello", "textSignature": "{\"v\":1,\"id\":\"msg_00e0eb3701447702016a8e2fd2dea087d09a0c85f07de241ae\",\"phase\":\"final_answer\"}"}], "api": "openai-codex-responses", "provider": "openai-codex", "model": "gpt-5.6-luna", "usage": {"input": 1068, "output": 5, "cacheRead": 3584, "cacheWrite": 0, "reasoning": 0, "totalTokens": 4657, "cost": {"input": 0.00021360000000000001, "output": 6e-06, "cacheRead": 7.168e-05, "cacheWrite": 0, "total": 0.00029128000000000004}}, "stopReason": "stop", "timestamp": 1787703245851, "responseId": "resp_00e0eb3701447702016a8e2fcebd1087d0be678fe9ff2a3a20", "rawStopReason": "completed"}},
  {"type": "turn_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "hello", "textSignature": "{\"v\":1,\"id\":\"msg_00e0eb3701447702016a8e2fd2dea087d09a0c85f07de241ae\",\"phase\":\"final_answer\"}"}], "api": "openai-codex-responses", "provider": "openai-codex", "model": "gpt-5.6-luna", "usage": {"input": 1068, "output": 5, "cacheRead": 3584, "cacheWrite": 0, "reasoning": 0, "totalTokens": 4657, "cost": {"input": 0.00021360000000000001, "output": 6e-06, "cacheRead": 7.168e-05, "cacheWrite": 0, "total": 0.00029128000000000004}}, "stopReason": "stop", "timestamp": 1787703245851, "responseId": "resp_00e0eb3701447702016a8e2fcebd1087d0be678fe9ff2a3a20", "rawStopReason": "completed"}, "toolResults": []},
  {"type": "agent_settled"},
];

// The second message is the one that settles the caliber: input 1068 and
// cacheRead 3584 are DISJOINT (1068 + 5 + 3584 = 4657, PI's own totalTokens),
// so the raw PI aggregate keeps uncached input separate; the usage extractor
// adds cacheRead exactly once when it persists canonical inputTokens.
const PI_EXPECTED = {
  messages: 2,
  reported: 2,
  input: 4620 + 1068,
  output: 19 + 5,
  cacheRead: 3584,
  cacheWrite: 0,
  // Integer nano-USD, written out rather than summed as doubles: adding the two
  // captured costs in JS gives 0.0012380800000000001, and the point of the
  // integer transport is that the stored value does not depend on that error.
  costNanoUsd: 1_238_080,
};

/** Drive the PI parser directly over a captured or constructed transcript. */
const piStream = (lines: unknown[]): Array<{ type: string; payload: Record<string, unknown> }> => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  parsePiTranscript(lines, (event) => { events.push(event); });
  return events;
};

const finalOutputOf = (events: Array<{ type: string; payload: Record<string, unknown> }>): Record<string, unknown> => {
  const final = events.filter((event) => event.type === "FINAL_OUTPUT");
  assert.equal(final.length, 1, "a PI session settles exactly once");
  return final[0]!.payload;
};

test("PI per-message usage is aggregated onto the terminal event, counting each message once", () => {
  const events = piStream(PI_TRANSCRIPT);
  const payload = finalOutputOf(events);
  assert.equal(payload.type, "agent_settled", "the provider's own terminal event is preserved");
  assert.deepEqual(payload.agentosPiUsage, PI_EXPECTED);
  // The failure this guards is silent arithmetic: turn_end carries the same
  // message object, so a parser that harvested both would report exactly double.
  assert.notEqual((payload.agentosPiUsage as { input: number }).input, PI_EXPECTED.input * 2);
  assert.equal(events.some((event) => event.type === "ADAPTER_ERROR"), false);
});

test("a PI session that reports no usage settles loudly instead of leaving silent nulls", () => {
  const events = piStream([
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    { type: "agent_settled" },
  ]);
  const payload = finalOutputOf(events);
  // No invented zeroes: the columns must stay NULL, which means the aggregate
  // must be absent from the payload entirely.
  assert.equal("agentosPiUsage" in payload, false);
  const reported = events.filter((event) => event.type === "ADAPTER_ERROR");
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]!.payload.error), /cost is incomplete.*no usage on any of 1/u);
  assert.equal(reported[0]!.payload.messages, 1);
  assert.equal(reported[0]!.payload.reported, 0);
});

test("a PI session whose reported usage sums to zero is a gap, not a free session", () => {
  const events = piStream([
    { type: "message_end", message: { role: "assistant", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
    { type: "agent_settled" },
  ]);
  assert.deepEqual(finalOutputOf(events).agentosPiUsage, {
    messages: 1, reported: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costNanoUsd: 0,
  });
  const reported = events.filter((event) => event.type === "ADAPTER_ERROR");
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]!.payload.error), /no tokens; PI reported no cost/u);
});

test("real tokens with no cost is diagnosed rather than left as a silent null column", () => {
  // The dangerous half of a partial report: the token columns land, look
  // healthy, and the cost column stays NULL with nothing saying why.
  const events = piStream([
    { type: "message_end", message: { role: "assistant", usage: { input: 100, output: 10 } } },
    { type: "agent_settled" },
  ]);
  assert.deepEqual(finalOutputOf(events).agentosPiUsage, { messages: 1, reported: 1, input: 100, output: 10 });
  const reported = events.filter((event) => event.type === "ADAPTER_ERROR");
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]!.payload.error), /^Session cost is incomplete: PI reported no cost$/u);
});

test("a session only some of whose messages reported usage does not pass off a short total as whole", () => {
  // Without this the stored total is the reporting messages' alone, and nothing
  // downstream can tell that it is short.
  const events = piStream([
    { type: "message_end", message: { role: "assistant", usage: { input: 100, output: 10, cost: { total: 0.002 } } } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "no usage on this one" }] } },
    { type: "agent_settled" },
  ]);
  assert.deepEqual(finalOutputOf(events).agentosPiUsage, {
    messages: 2, reported: 1, input: 100, output: 10, costNanoUsd: 2_000_000,
  });
  const reported = events.filter((event) => event.type === "ADAPTER_ERROR");
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]!.payload.error), /usage on only 1 of 2 assistant message\(s\)/u);
});

test("PI costs are summed exactly, not through the binary addition the column would round away", () => {
  // usage.ts documents this exact pair: 0.000001 + 0.000049 as doubles lands
  // just below the half-unit and rounds to 0.0000 instead of 0.0001.
  assert.ok(0.000001 + 0.000049 < 0.00005, "the double sum must really fall short, or this proves nothing");
  const events = piStream([
    { type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0.000001 } } } },
    { type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0.000049 } } } },
    { type: "agent_settled" },
  ]);
  assert.equal((finalOutputOf(events).agentosPiUsage as { costNanoUsd: number }).costNanoUsd, 50_000);
});

test("PI reasoning tokens are a breakdown of output and cacheWrite is cached input", () => {
  // output 29 / reasoning 22 is the real second capture; a nonzero cacheWrite is
  // constructed, because neither capture produced one and the fold must still
  // be exercised. Adding reasoning to output would give 51, not 29.
  const events = piStream([
    { type: "message_end", message: { role: "assistant", usage: { input: 4627, output: 29, cacheRead: 100, cacheWrite: 200, reasoning: 22, cost: { total: 0.0009602 } } } },
    { type: "agent_settled" },
  ]);
  assert.deepEqual(finalOutputOf(events).agentosPiUsage, {
    messages: 1, reported: 1, input: 4627, output: 29, cacheRead: 100, cacheWrite: 200, costNanoUsd: 960_200,
  });
});

test("one unusable PI usage field is dropped without taking its siblings with it", () => {
  const events = piStream([
    { type: "message_end", message: { role: "assistant", usage: { input: "lots", output: 7, cacheRead: -1, cost: { total: 0.5 } } } },
    { type: "message_end", message: { role: "user", usage: { input: 999, output: 999 } } },
    { type: "agent_settled" },
  ]);
  // input and cacheRead are rejected, so they stay ABSENT rather than becoming
  // zero; the user message is not an assistant turn and is never harvested.
  assert.deepEqual(finalOutputOf(events).agentosPiUsage, { messages: 1, reported: 1, output: 7, costNanoUsd: 500_000_000 });
});

// A run's checkout may predate any given safety fix (chain and salvage runs
// are pinned to old bases), so the runner — always current code — has to point
// the session's roots at throwaway directories itself. Both 2026-08-18
// production wipes were old checkouts resolving the production default.
test("agent session environment pins both roots inside the run's disposable scratch", () => {
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3 },
    // A task secret must not be able to aim a session at the production root.
    { ...claim, secrets: { ...claim.secrets, RUNNER_WORKSPACE_ROOT: productionRoot, CONTROL_PLANE_STATE_DIR: productionRoot } },
    scratch,
    "/work",
  );
  assert.equal(env.RUNNER_WORKSPACE_ROOT, scratch.workspaceRoot);
  assert.equal(env.CONTROL_PLANE_STATE_DIR, scratch.stateDir);
  assert.notEqual(env.RUNNER_WORKSPACE_ROOT, productionRoot);
  assert.notEqual(env.CONTROL_PLANE_STATE_DIR, productionRoot);
});

test("PI config overrides are stripped and the isolated config root is runner-pinned", () => {
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3 },
    {
      ...claim,
      runner: "PI",
      secrets: {
        ...claim.secrets,
        PI_CODING_AGENT_DIR: "/hostile/pi-agent",
        PI_CODING_AGENT_SESSION_DIR: "/hostile/pi-sessions",
      },
    },
    scratch,
    "/work",
  );
  assert.equal(env.PI_CODING_AGENT_DIR, scratch.configRoot);
  assert.equal(env.PI_CODING_AGENT_SESSION_DIR, undefined);
  assert.notEqual(env.PI_CODING_AGENT_DIR, "/hostile/pi-agent");
});

test("Codex and PI child environments preserve the configured runner Git identity", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "agentos-git-identity-"));
  const runnerHome = join(fixture, "runner-home");
  await mkdir(runnerHome, { recursive: true });
  await writeFile(join(runnerHome, ".gitconfig"), [
    "[user]",
    "\tname = Anneal Runner",
    "\temail = runner@agentos.invalid",
    "",
  ].join("\n"));
  try {
    for (const runner of ["CODEX", "PI"] satisfies RunnerKind[]) {
      const repository = join(fixture, runner.toLowerCase());
      const runnerScratch = { ...scratch, configRoot: join(fixture, `${runner.toLowerCase()}-config`) };
      await mkdir(repository, { recursive: true });
      await mkdir(runnerScratch.configRoot, { recursive: true });
      const env = buildChildEnvironment(
        { path: process.env.PATH ?? "/usr/bin:/bin", home: runnerHome, apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3 },
        { ...claim, runner, secrets: { ...claim.secrets, GIT_CONFIG_GLOBAL: "/hostile/.gitconfig" } },
        runnerScratch,
        repository,
      );
      execFileSync("git", ["init", "--quiet"], { cwd: repository, env });
      await writeFile(join(repository, "tracked.txt"), `${runner}\n`);
      execFileSync("git", ["add", "tracked.txt"], { cwd: repository, env });
      execFileSync("git", ["commit", "--quiet", "-m", "test identity"], { cwd: repository, env });
      const author = execFileSync("git", ["show", "-s", "--format=%an <%ae>", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
        env,
      }).trim();
      assert.equal(author, "Anneal Runner <runner@agentos.invalid>", `${runner} lost the configured runner Git identity`);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("child environment is an explicit allowlist and excludes host variables", () => {
  const previous = process.env.HOST_ONLY_CREDENTIAL;
  process.env.HOST_ONLY_CREDENTIAL = "must-not-leak";
  try {
    const env = buildChildEnvironment({ path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3 }, claim, scratch, "/work");
    assert.equal(env.HOST_ONLY_CREDENTIAL, undefined);
    assert.equal(env.ALLOWED_SECRET, "secret");
    assert.equal(env.AGENTOS_SESSION_TOKEN, "agos_session_secret");
    assert.equal(env.AGENTOS_FENCING_TOKEN, claim.fencingToken);
  } finally {
    if (previous === undefined) delete process.env.HOST_ONLY_CREDENTIAL;
    else process.env.HOST_ONLY_CREDENTIAL = previous;
  }
});

test("the runner pins its configured gate destination over task secrets", () => {
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [], workspaceRoot: productionRoot, hostProofSlots: 3, gateServer: "agentos-gate" },
    { ...claim, secrets: { ...claim.secrets, AGENTOS_GATE_SERVER: "ci-desktop-worker" } },
    scratch,
    "/work",
  );
  assert.equal(env.AGENTOS_GATE_SERVER, "agentos-gate");
});

test("RUNNER_GATE_FALLBACK_SERVER selects a runner-owned two-host environment", async () => {
  const home = await mkdtemp(join(tmpdir(), "gate-environment-"));
  try {
    const config = {
      path: "/bin", home, apiUrl: "http://api", runAsPrefix: ["/usr/bin/env", "-i"],
      workspaceRoot: home, hostProofSlots: 3, gateServer: "gate-self",
    };
    const secrets = {
      ...claim.secrets,
      AGENTOS_GATE_SERVER: "secret-single",
      AGENTOS_GATE_PRIMARY_SERVER: "secret-primary",
      AGENTOS_GATE_FALLBACK_SERVER: "secret-fallback",
    };
    const single = buildChildEnvironment(config, claim, scratch, "/work");
    assert.equal(single.AGENTOS_GATE_SERVER, "gate-self");
    assert.equal(Object.hasOwn(single, "AGENTOS_GATE_PRIMARY_SERVER"), false);
    assert.equal(Object.hasOwn(single, "AGENTOS_GATE_FALLBACK_SERVER"), false);
    assert.deepEqual(buildChildEnvironment(config, { ...claim, secrets }, scratch, "/work"), single);
    const dual = buildChildEnvironment(
      { ...config, gateFallbackServer: "agentos-gate" }, { ...claim, secrets }, scratch, "/work",
    );
    const { AGENTOS_GATE_SERVER: _singleServer, ...unchanged } = single;
    assert.deepEqual(dual, {
      ...unchanged,
      AGENTOS_GATE_PRIMARY_SERVER: "gate-self",
      AGENTOS_GATE_FALLBACK_SERVER: "agentos-gate",
    });
    // The primary worker's slot count is part of the two-host topology only:
    // single-server mode has one slot and nothing to state.
    const singleOneSlot = buildChildEnvironment(
      { ...config, gatePrimarySlots: 1 }, { ...claim, secrets }, scratch, "/work",
    );
    assert.equal(Object.hasOwn(singleOneSlot, "AGENTOS_GATE_PRIMARY_SLOTS"), false);
    const dualOneSlot = buildChildEnvironment(
      { ...config, gateFallbackServer: "agentos-gate", gatePrimarySlots: 1 },
      { ...claim, secrets: { ...secrets, AGENTOS_GATE_PRIMARY_SLOTS: "2" } },
      scratch,
      "/work",
    );
    assert.deepEqual(dualOneSlot, { ...dual, AGENTOS_GATE_PRIMARY_SLOTS: "1" });
    const launch = launchArgv(
      { binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" }, runAsPrefix: config.runAsPrefix },
      "CODEX", [], dual,
    );
    assert.equal(launch.args.includes("AGENTOS_GATE_PRIMARY_SERVER=gate-self"), true);
    assert.equal(launch.args.includes("AGENTOS_GATE_FALLBACK_SERVER=agentos-gate"), true);
    assert.equal(launch.args.some((arg) => arg.startsWith("AGENTOS_GATE_SERVER=")), false);
    const launchOneSlot = launchArgv(
      { binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" }, runAsPrefix: config.runAsPrefix },
      "CODEX", [], dualOneSlot,
    );
    assert.equal(launchOneSlot.args.includes("AGENTOS_GATE_PRIMARY_SLOTS=1"), true);
    const { gateServer: _gateServer, ...withoutGate } = config;
    assert.throws(
      () => buildChildEnvironment(
        { ...withoutGate, gateFallbackServer: "agentos-gate" }, claim, scratch, "/work",
      ),
      /RUNNER_GATE_FALLBACK_SERVER requires RUNNER_GATE_SERVER/,
    );
    const unconfigured = buildChildEnvironment(withoutGate, { ...claim, secrets }, scratch, "/work");
    for (const name of ["AGENTOS_GATE_SERVER", "AGENTOS_GATE_PRIMARY_SERVER", "AGENTOS_GATE_FALLBACK_SERVER"]) {
      assert.equal(Object.hasOwn(unconfigured, name), false);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a run-as launcher cannot strip the operator-selected gate destination", () => {
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: ["/usr/bin/env", "-i"], workspaceRoot: productionRoot, hostProofSlots: 3, gateServer: "agentos-gate" },
    claim,
    scratch,
    "/work",
  );
  const launch = launchArgv(
    { binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" }, runAsPrefix: ["/usr/bin/env", "-i"] },
    "CODEX",
    [],
    env,
  );
  assert.equal(launch.args.includes("AGENTOS_GATE_SERVER=agentos-gate"), true);
});

test("configured local gate capacity is runner-owned and survives a run-as launcher", () => {
  const runAsPrefix = ["/usr/bin/env", "-i"];
  const config = {
    path: "/bin",
    home: "/runner",
    apiUrl: "http://api",
    runAsPrefix,
    workspaceRoot: productionRoot,
    hostProofSlots: 3,
    gateLocalSlots: 2,
  };
  const env = buildChildEnvironment(
    config,
    {
      ...claim,
      secrets: {
        ...claim.secrets,
        AGENTOS_GATE_ALLOW_LOCAL: "0",
        AGENTOS_GATE_LOCAL_SLOTS: "99",
      },
    },
    scratch,
    "/work",
  );
  assert.equal(env.AGENTOS_GATE_ALLOW_LOCAL, "1");
  assert.equal(env.AGENTOS_GATE_LOCAL_SLOTS, "2");

  const launch = launchArgv(
    { binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" }, runAsPrefix },
    "CODEX",
    [],
    env,
  );
  assert.equal(launch.args.includes("AGENTOS_GATE_ALLOW_LOCAL=1"), true);
  assert.equal(launch.args.includes("AGENTOS_GATE_LOCAL_SLOTS=2"), true);
});

test("unset local gate capacity contributes neither child variables nor launcher assignments", () => {
  const runAsPrefix = ["/usr/bin/env", "-i"];
  const config = {
    path: "/bin",
    home: "/runner",
    apiUrl: "http://api",
    runAsPrefix,
    workspaceRoot: productionRoot,
    hostProofSlots: 3,
  };
  const env = buildChildEnvironment(
    config,
    {
      ...claim,
      secrets: {
        ...claim.secrets,
        AGENTOS_GATE_ALLOW_LOCAL: "1",
        AGENTOS_GATE_LOCAL_SLOTS: "99",
      },
    },
    scratch,
    "/work",
  );
  assert.equal(env.AGENTOS_GATE_ALLOW_LOCAL, undefined);
  assert.equal(env.AGENTOS_GATE_LOCAL_SLOTS, undefined);

  const launch = launchArgv(
    { binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" }, runAsPrefix },
    "CODEX",
    [],
    env,
  );
  assert.equal(launch.args.includes("AGENTOS_GATE_ALLOW_LOCAL=1"), false);
  assert.equal(launch.args.includes("AGENTOS_GATE_LOCAL_SLOTS=99"), false);
});

// The launcher named by RUNNER_RUN_AS_PREFIX is an arbitrary command that may
// scrub the environment it was handed — `sudo` resets it by policy, and #126
// wants OS isolation built on precisely this prefix. `/usr/bin/env -i` is that
// worst case made deterministic: nothing the runner put in the launcher's
// environment survives to the CLI. Asserting on the env object handed to
// spawn() cannot see this, so the stub below reports what the *final* process
// actually got. PATH is empty on the far side of `env -i`, so the stub is
// invoked by absolute path and uses only shell builtins.
const hostSkillSentinels = [
  { shellName: "home_agents", environmentVariable: "HOME", relativeRoot: ".agents/skills", fixtureRoot: ".agents/skills", expected: { CLAUDE: 1, CODEX: 0, PI: 0 } },
  { shellName: "home_claude", environmentVariable: "HOME", relativeRoot: ".claude/skills", fixtureRoot: ".claude/skills", expected: { CLAUDE: 1, CODEX: 0, PI: 0 } },
  { shellName: "codex", environmentVariable: "CODEX_HOME", relativeRoot: "skills", fixtureRoot: ".codex/skills", expected: { CLAUDE: 0, CODEX: 0, PI: 0 } },
  { shellName: "pi", environmentVariable: "PI_CODING_AGENT_DIR", relativeRoot: "skills", fixtureRoot: ".pi/agent/skills", expected: { CLAUDE: 0, CODEX: 0, PI: 0 } },
] as const;

const rootReportingStub = [
  "#!/bin/sh",
  'skill_policy=""',
  'while [ "$#" -gt 0 ]; do',
  '  if [ "$1" = "--setting-sources" ]; then shift; [ "$1" = "project,local" ] && skill_policy="claude-user-source-disabled"; fi',
  '  if [ "$1" = "--no-skills" ]; then skill_policy="pi-skills-disabled"; fi',
  '  shift',
  'done',
  '[ -n "$CODEX_HOME" ] && [ "$HOME" = "$CODEX_HOME" ] && skill_policy="codex-home-relocated"',
  ...hostSkillSentinels.flatMap(({ shellName, environmentVariable, relativeRoot }) => [
    `${shellName}=0`,
    `[ -e "$${environmentVariable}/${relativeRoot}/host-personal/SKILL.md" ] && ${shellName}=1`,
  ]),
  'resolved_host_skills=0',
  'if [ -n "$CODEX_HOME" ]; then',
  '  resolved_host_skills=$((home_agents + codex))',
  'elif [ -n "$PI_CODING_AGENT_DIR" ]; then',
  '  if [ "$skill_policy" != "pi-skills-disabled" ]; then',
  '    resolved_host_skills=$((home_agents + pi))',
  '  fi',
  'elif [ "$skill_policy" != "claude-user-source-disabled" ]; then',
  '  resolved_host_skills=$home_claude',
  'fi',
  // Drain the prompt so the parent never sees EPIPE instead of the report.
  "while read -r _line; do :; done",
  'printf \'{"type":"turn.completed","workspaceRoot":"%s","stateDir":"%s","toolsDir":"%s","hostProofSlotDir":"%s","hostProofSlots":"%s","home":"%s","gitConfigGlobal":"%s","codexConfigRoot":"%s","piConfigRoot":"%s","skillPolicy":"%s","hostSkillSentinels":"%s,%s,%s,%s","resolvedHostSkills":%s}\\n\' "$RUNNER_WORKSPACE_ROOT" "$CONTROL_PLANE_STATE_DIR" "$AGENTOS_TOOLS" "$AGENTOS_HOST_PROOF_SLOT_DIR" "$AGENTOS_HOST_PROOF_SLOTS" "$HOME" "$GIT_CONFIG_GLOBAL" "$CODEX_HOME" "$PI_CODING_AGENT_DIR" "$skill_policy" "$home_agents" "$home_claude" "$codex" "$pi" "$resolved_host_skills"',
  "",
].join("\n");

test("a scrubbing run-as launcher cannot strip the isolation roots from any session", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "agentos-runas-scrub-"));
  const stub = join(fixture, "agent-stub.sh");
  for (const { fixtureRoot } of hostSkillSentinels) {
    const markerRoot = join(fixture, fixtureRoot, "host-personal");
    await mkdir(markerRoot, { recursive: true });
    await writeFile(join(markerRoot, "SKILL.md"), "host-only\n");
  }
  await writeFile(stub, rootReportingStub);
  await chmod(stub, 0o755);
  const config = {
    binaries: { CLAUDE: stub, CODEX: stub, PI: stub },
    // The launcher hands the CLI an empty environment, exactly as a locked-down
    // sudoers policy would for anything it has not been told to preserve.
    runAsPrefix: ["/usr/bin/env", "-i"],
    workspaceRoot: productionRoot,
    hostProofSlots: 3,
    path: "/bin",
    home: fixture,
    apiUrl: "http://api",
  } as unknown as RunnerConfig;
  const runScratch = await provisionAgentScratch(config);
  try {
    for (const runner of ["CLAUDE", "CODEX", "PI"] satisfies RunnerKind[]) {
      const runnerClaim = {
        ...claim,
        runner,
        secrets: { ...claim.secrets, AGENTOS_TOOLS: "/checkout/task-secret-tools" },
      };
      const env = buildChildEnvironment(config, runnerClaim, runScratch, fixture);
      const spec = {
        config,
        claim: runnerClaim,
        workingDirectory: fixture,
        env,
        prompt: buildPrompt(claim),
        credentialsPath: join(fixture, "session.json"),
      };
      const sessions = {
        start: () => adapters[runner].start(spec, () => undefined),
        resume: () => adapters[runner].resume(
          { ...spec, providerConversationId: "thread-1", input: "continue" },
          () => undefined,
        ),
      };
      for (const [mode, launchSession] of Object.entries(sessions)) {
        const evidence = await (await launchSession()).exit;
        assert.equal(evidence.exitCode, 0, `${runner} ${mode} failed to launch: ${evidence.stderr}`);
        const report = JSON.parse(evidence.stdout.trim().split("\n").at(-1) ?? "{}") as {
          workspaceRoot?: string;
          stateDir?: string;
          toolsDir?: string;
          hostProofSlotDir?: string;
          hostProofSlots?: string;
          home?: string;
          gitConfigGlobal?: string;
          codexConfigRoot?: string;
          piConfigRoot?: string;
          skillPolicy?: string;
          hostSkillSentinels?: string;
          resolvedHostSkills?: number;
        };
        assert.equal(report.workspaceRoot, runScratch.workspaceRoot, `${runner} ${mode} lost RUNNER_WORKSPACE_ROOT across the launcher`);
        assert.equal(report.stateDir, runScratch.stateDir, `${runner} ${mode} lost CONTROL_PLANE_STATE_DIR across the launcher`);
        assert.equal(report.toolsDir, runScratch.toolsDir, `${runner} ${mode} lost AGENTOS_TOOLS across the launcher`);
        assert.equal(
          report.hostProofSlotDir,
          hostProofSlotDirectory(config),
          `${runner} ${mode} lost AGENTOS_HOST_PROOF_SLOT_DIR across the launcher`,
        );
        assert.equal(report.hostProofSlots, "3", `${runner} ${mode} lost AGENTOS_HOST_PROOF_SLOTS across the launcher`);
        assert.notEqual(report.workspaceRoot, config.workspaceRoot);
        assert.notEqual(report.workspaceRoot, productionRoot);
        assert.notEqual(report.stateDir, productionRoot);
        assert.equal(report.gitConfigGlobal, join(config.home, ".gitconfig"), `${runner} ${mode} lost the runner Git config across the launcher`);
        assert.deepEqual(
          report.hostSkillSentinels?.split(",").map(Number),
          hostSkillSentinels.map(({ expected }) => expected[runner]),
          `${runner} ${mode} did not probe every host-personal skill sentinel`,
        );
        assert.equal(report.resolvedHostSkills, 0, `${runner} ${mode} resolved a host-personal skill sentinel`);
        if (runner === "CLAUDE") {
          assert.equal(report.home, config.home, `${mode} lost Claude's Keychain-compatible HOME across the launcher`);
          assert.equal(report.skillPolicy, "claude-user-source-disabled", `${mode} enabled Claude's ~/.claude/skills discovery`);
        } else {
          assert.equal(report.home, runScratch.configRoot, `${runner} ${mode} resolved HOME-relative skill discovery against the host`);
          if (runner === "CODEX") {
            assert.equal(report.codexConfigRoot, runScratch.configRoot, `${mode} lost CODEX_HOME across the launcher`);
            assert.equal(report.skillPolicy, "codex-home-relocated", `${mode} enabled Codex's ~/.agents/skills discovery`);
          } else {
            assert.equal(report.piConfigRoot, runScratch.configRoot, `${mode} lost PI_CODING_AGENT_DIR across the launcher`);
            assert.equal(report.skillPolicy, "pi-skills-disabled", `${mode} enabled PI's ~/.pi/agent/skills discovery`);
          }
        }
      }
    }
  } finally {
    await cleanupAgentScratch(config, runScratch);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("PI preflight fails closed when the CLI omits an isolation capability", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "agentos-pi-capability-"));
  const stub = join(fixture, "pi-stub.sh");
  await writeFile(stub, [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "0.1.0"; exit 0; fi',
    'if [ "$1" = "--help" ]; then echo "--no-skills --no-prompt-templates --no-themes --no-approve"; exit 0; fi',
    'if [ "$1" = "auth" ]; then exit 0; fi',
    "exit 1",
    "",
  ].join("\n"));
  await chmod(stub, 0o755);
  try {
    const config = {
      binaries: { CLAUDE: stub, CODEX: stub, PI: stub },
      runAsPrefix: [],
    } as unknown as RunnerConfig;
    const result = await adapters.PI.preflight({ config, runner: "PI", model: "openai-codex/gpt-5.6-sol:high", env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.error, "cli-incompatible: the CLI does not expose the required Anneal exec protocol");
    assert.equal(result.authMode, null);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("PI preflight verifies every isolation capability before authentication", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "agentos-pi-capability-"));
  const stub = join(fixture, "pi-stub.sh");
  await writeFile(stub, [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "0.84.2"; exit 0; fi',
    'if [ "$1" = "--help" ]; then echo "--no-skills --no-prompt-templates --no-themes --no-context-files --no-approve"; exit 0; fi',
    'if [ "$1" = "auth" ]; then exit 0; fi',
    "exit 1",
    "",
  ].join("\n"));
  await chmod(stub, 0o755);
  try {
    const config = {
      binaries: { CLAUDE: stub, CODEX: stub, PI: stub },
      runAsPrefix: [],
    } as unknown as RunnerConfig;
    const result = await adapters.PI.preflight({ config, runner: "PI", model: "openai-codex/gpt-5.6-sol:high", env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.authMode, "openai-codex");
    assert.equal(result.capabilities.cliProtocol, "json-stdin-resume-isolated");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("exit code zero without a provider terminal event is failure", () => {
  const evidence: ExitEvidence = {
    exitCode: 0,
    signal: null,
    terminalEventSeen: false,
    finalOutput: null,
    providerError: null,
    terminalSuccess: false,
    terminationReason: null,
    stdout: "",
    stderr: "",
  };
  assert.deepEqual(agentExitVerdict(evidence), { case: "dropped", cleanExit: true });
  assert.equal(agentExitVerdict({ ...evidence, terminalEventSeen: true, terminalSuccess: true }).case, "succeeded");
});

const codexStateOf = (state: AdapterState): CodexProviderState => state.providerState as CodexProviderState;

const evidenceFromState = (state: AdapterState, exitCode = 0): ExitEvidence => ({
  exitCode,
  signal: null,
  terminalEventSeen: state.terminalEventSeen,
  terminalSuccess: state.terminalSuccess,
  terminationReason: state.terminationReason,
  finalOutput: state.finalOutput,
  providerError: state.providerError,
  stdout: state.stdout,
  stderr: state.stderr,
});

test("Codex structured errors take precedence over stderr warnings", () => {
  const state = parseCodexTranscript([{ type: "error", message: "policy denied" }]);
  const evidence = evidenceFromState(state, 1);
  assert.equal(evidence.providerError, "policy denied");
  assert.equal(failureReasonFromEvidence({ ...evidence, stderr: "models cache warning" }), "policy denied");
});

test("Codex treats recovered reconnect evidence as provisional after terminal completion", () => {
  const state = parseCodexTranscript([
    { type: "error", message: "Reconnecting... 1/5" },
    { type: "error", message: "Reconnecting... 2/5" },
    { type: "item.completed", item: { type: "agent_message", text: "implementation persisted" } },
    { type: "turn.completed" },
  ]);
  const evidence = evidenceFromState(state);

  assert.equal(evidence.terminalEventSeen, true);
  assert.equal(evidence.terminalSuccess, true);
  assert.equal(evidence.providerError, "Reconnecting... 2/5");
  assert.equal(agentExitVerdict(evidence).case, "succeeded");
});

test("Codex emits an observed-child signal only after a spawn returns a child thread", () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const state = createAdapterState("CODEX", "transcript", initialCodexState());
  const sink = (event: { type: string; payload: Record<string, unknown> }): void => { events.push(event); };

  parseCodexEvent(state, {
    type: "item.completed",
    item: {
      id: "spawn-1",
      type: "collab_agent_tool_call",
      tool: "spawn_agent",
      status: "completed",
      receiver_thread_ids: ["child-thread-1"],
    },
  }, sink);
  parseCodexEvent(state, {
    type: "item.completed",
    item: {
      id: "spawn-2",
      type: "collab_agent_tool_call",
      tool: "spawn_agent",
      status: "failed",
      receiver_thread_ids: [],
    },
  }, sink);

  const observed = events.filter((event) => event.type === "NATIVE_CHILD_STARTED");
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.payload.id, "spawn-1");
});

test("Codex reconnect classification follows the counter shape instead of a fixed retry budget", () => {
  const cases = [
    { message: "Reconnecting... 2/8", terminalSuccess: true },
    { message: "stream disconnected", terminalSuccess: false },
  ] as const;

  for (const { message, terminalSuccess } of cases) {
    const state = parseCodexTranscript([
      { type: "error", message },
      { type: "turn.completed" },
    ]);
    assert.equal(state.terminalSuccess, terminalSuccess, message);
  }
});

test("Codex reconnect progress stays provisional when the counter carries its cause", () => {
  const state = parseCodexTranscript([
    { type: "error", message: "Reconnecting... 2/5 (stream disconnected before completion: tls handshake eof)" },
    { type: "error", message: "Reconnecting... 3/5 (stream disconnected before completion: tls handshake eof)" },
    { type: "item.completed", item: { type: "agent_message", text: "repair committed" } },
    { type: "turn.completed" },
  ]);
  const evidence = evidenceFromState(state);

  assert.equal(evidence.terminalSuccess, true);
  assert.equal(agentExitVerdict(evidence).case, "succeeded");
});

test("Codex latches a real provider error that only resembles reconnect progress", () => {
  const cases = [
    "stream disconnected before completion: tls handshake eof",
    "Reconnecting... failed (stream disconnected before completion)",
    "Reconnect budget exhausted after Reconnecting... 5/5",
    "Reconnecting... 5/5 (stream disconnected)\npolicy denied",
  ] as const;

  for (const message of cases) {
    const state = parseCodexTranscript([{ type: "error", message }, { type: "turn.completed" }]);
    assert.equal(state.terminalSuccess, false, message);
    assert.equal(agentExitVerdict(evidenceFromState(state)).case, "refused", message);
  }
});

test("Codex preserves reconnect evidence when the stream ends before completion", () => {
  const reconnectMessage = "Reconnecting... 3/5";
  const state = parseCodexTranscript([{ type: "error", message: reconnectMessage }]);
  const evidence = evidenceFromState(state, 1);

  assert.equal(evidence.terminalEventSeen, false);
  assert.equal(evidence.terminalSuccess, false);
  assert.deepEqual(agentExitVerdict(evidence), { case: "dropped", cleanExit: false });
  assert.equal(failureReasonFromEvidence(evidence), reconnectMessage);
});

test("Codex provider-disconnect predicate covers reconnect, network, and disqualifying exits", () => {
  const reconnectMessage = "Reconnecting... 3/5 (stream disconnected before completion: tls handshake eof)";
  const bareDisconnectMessage = "stream disconnected before completion: tls handshake eof";
  const base: ExitEvidence = {
    exitCode: 0,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: null,
    stdout: "",
    stderr: "",
  };

  // The Codex reconnect wording is intentionally not part of the shared
  // network retry pattern list; the Codex-owned status predicate recognizes it.
  assert.equal(isTransientNetworkError(reconnectMessage), false);
  const fresh = initialCodexState();
  assert.equal(isCodexProviderDisconnect({ ...base, providerError: reconnectMessage }, fresh), true);
  assert.equal(isCodexReconnectStatus(bareDisconnectMessage), false);
  assert.equal(isTransientNetworkError(bareDisconnectMessage), false);
  assert.equal(isCodexProviderDisconnect({ ...base, providerError: bareDisconnectMessage }, fresh), true);
  assert.equal(isCodexProviderDisconnect({ ...base, stderr: "fetch failed" }, fresh), true);

  // The exit record's own shape — a terminal event, a signal, a stamped
  // termination — is `agentExitVerdict`'s question, and a missing conversation
  // id is the relaunch gate's. What is left here is Codex-shaped.
  const disqualified: Array<[string, Partial<ExitEvidence>, CodexProviderState]> = [
    ["binary missing", { exitCode: 127, providerError: "connection reset" }, fresh],
    ["authentication", { providerError: "authentication_failed: connection reset" }, fresh],
    ["rate limit", { providerError: "rate limit: connection reset" }, fresh],
    ["tool failure", {
      providerError: '"isError":true stream disconnected before completion: tls handshake eof',
    }, fresh],
    ["prior provider error", { providerError: reconnectMessage }, { sawNonReconnectProviderError: true }],
  ];
  for (const [name, overrides, providerState] of disqualified) {
    assert.equal(isCodexProviderDisconnect({ ...base, ...overrides }, providerState), false, name);
  }
});

test("Codex preserves disqualifying provider-error history after reconnect status", () => {
  const reconnectMessage = "Reconnecting... 3/5 (stream disconnected before completion: tls handshake eof)";
  const state = parseCodexTranscript([
    { type: "error", message: "policy denied" },
    { type: "error", message: reconnectMessage },
  ]);
  const evidence = evidenceFromState(state);

  assert.equal(evidence.providerError, reconnectMessage);
  assert.equal(codexStateOf(state).sawNonReconnectProviderError, true);
  assert.equal(isCodexProviderDisconnect(evidence, state.providerState), false);
});

test("Codex bare disconnect evidence remains resumable provider history", () => {
  const state = parseCodexTranscript([{
    type: "error",
    message: "stream disconnected before completion: tls handshake eof",
  }]);
  const evidence = evidenceFromState(state);

  assert.equal(codexStateOf(state).sawNonReconnectProviderError, false);
  assert.equal(isCodexProviderDisconnect(evidence, state.providerState), true);
});

test("Codex does not let augmented disconnect wording hide a provider error", () => {
  const state = parseCodexTranscript([{
    type: "error",
    message: "stream disconnected before completion: tls handshake eof\npolicy denied",
  }]);
  const evidence = evidenceFromState(state);

  assert.equal(codexStateOf(state).sawNonReconnectProviderError, true);
  assert.equal(isCodexProviderDisconnect(evidence, state.providerState), false);
});

test("only Codex declares the optional provider-disconnect reading", () => {
  assert.equal(typeof adapters.CODEX.isProviderDisconnect, "function");
  assert.equal(adapters.CLAUDE.isProviderDisconnect, undefined);
  assert.equal(adapters.PI.isProviderDisconnect, undefined);
});

test("PI terminal success follows the final provider attempt after an internal retry", () => {
  const state = parsePiTranscript([
    { type: "turn_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" } },
    { type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }], willRetry: true },
    { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "final PASS" }], stopReason: "stop" } },
    { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }], willRetry: false },
    { type: "agent_settled" },
  ]);
  const evidence = evidenceFromState(state);
  assert.equal(evidence.terminalSuccess, true);
  assert.equal(evidence.providerError, null);
  assert.equal(evidence.finalOutput, "final PASS");
  assert.equal(agentExitVerdict(evidence).case, "succeeded");
});

test("PI exposes the exhausted provider error instead of a generic protocol failure", () => {
  const state = parsePiTranscript([
    { type: "turn_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" } },
    { type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }], willRetry: false },
    { type: "agent_settled" },
  ]);
  const evidence = evidenceFromState(state, 1);
  assert.equal(evidence.terminalEventSeen, true);
  assert.equal(evidence.terminalSuccess, false);
  assert.equal(evidence.providerError, "fetch failed");
  assert.deepEqual(adapters.PI.classifyError(evidence), { failureClass: "TRANSIENT_PROVIDER", retryable: true });
});

test("Codex agent progress renews an open command deadline while stderr does not", async () => {
  const state = createAdapterState("CODEX", "transcript", initialCodexState());
  parseCodexEvent(state, { type: "item.started", item: { id: "command-1", type: "command_execution", status: "in_progress" } }, () => undefined);
  const initialProgress = state.inFlightTool?.lastProgressAt;
  assert.ok(initialProgress);
  const stderrProgress = state.inFlightTool?.lastProgressAt;
  assert.equal(stderrProgress?.getTime(), initialProgress.getTime(), "stderr bypasses the Codex parser");

  await new Promise<void>((resolve) => setTimeout(resolve, 2));
  parseCodexEvent(state, {
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: "database Merge gate is still advancing" },
  }, () => undefined);
  const renewedProgress = state.inFlightTool?.lastProgressAt;
  assert.ok(renewedProgress);
  assert.ok(renewedProgress.getTime() > initialProgress.getTime());
  parseCodexEvent(state, {
    type: "item.completed",
    item: { id: "command-1", type: "command_execution", status: "completed", exit_code: 0 },
  }, () => undefined);
  parseCodexEvent(state, { type: "turn.completed" }, () => undefined);
  assert.equal(state.terminalSuccess, true);
  assert.equal(state.inFlightTool, null);
});

test("source text cannot misclassify a provider failure as a missing binary", () => {
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: "request rejected by provider policy",
    stdout: "throw new Error('No such file or directory')",
    stderr: "models cache warning",
  };

  assert.equal(adapters.CODEX.classifyError(evidence).failureClass, "TASK_FAILED");
});

test("workspace TLS failures remain retryable after command retries are exhausted", () => {
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: null,
    stdout: "",
    stderr: "git failed (128): LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
  };

  assert.deepEqual(adapters.CODEX.classifyError(evidence), {
    failureClass: "TRANSIENT_PROVIDER",
    retryable: true,
  });
});

test("a mid-response connection loss classifies TRANSIENT_PROVIDER, not AUTH_REQUIRED", () => {
  // Exact strings observed on run cmsy26f2s0ibqmpmx8t6gyltg (2026-08-18):
  // the provider result event carried this error while stdout held 19 minutes
  // of agent work on auth-adjacent code.
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: true,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: "API Error: Connection lost mid-response. The response above may be incomplete.",
    providerError: "API Error: Connection lost mid-response. The response above may be incomplete.",
    stdout: "",
    stderr: "",
  };
  assert.deepEqual(adapters.CLAUDE.classifyError(evidence), {
    failureClass: "TRANSIENT_PROVIDER",
    retryable: true,
  });
});

test("a literal 401 in agent stdout does not classify as AUTH_REQUIRED", () => {
  // Run-2 evidence shape: providerError and stderr empty, stdout full of the
  // agent's own work — including HTTP status literals from code under edit.
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: null,
    stdout: 'return context.json({ error: "Stale fencing token" }, 401);',
    stderr: "",
  };
  assert.notEqual(adapters.CLAUDE.classifyError(evidence).failureClass, "AUTH_REQUIRED");
});

test("an auth failure that also mentions a dropped connection is AUTH_REQUIRED, not retried", () => {
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: true,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: "authentication_failed: connection lost while refreshing credentials",
    stdout: "",
    stderr: "",
  };
  assert.equal(adapters.CLAUDE.classifyError(evidence).failureClass, "AUTH_REQUIRED");
});

test("a genuine auth failure on stderr still classifies AUTH_REQUIRED", () => {
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: null,
    stdout: "",
    stderr: "authentication_failed: not logged in",
  };
  assert.equal(adapters.CLAUDE.classifyError(evidence).failureClass, "AUTH_REQUIRED");
});

test("an is_error result event is captured as providerError and classifies transient", () => {
  const message = "API Error: Connection lost mid-response. The response above may be incomplete.";
  const state = parseClaudeTranscript([{ type: "result", is_error: true, result: message }]);
  const evidence = evidenceFromState(state, 1);
  assert.equal(evidence.providerError, message);
  assert.deepEqual(adapters.CLAUDE.classifyError(evidence), {
    failureClass: "TRANSIENT_PROVIDER",
    retryable: true,
  });
});

test("a local CLI preflight timeout stays a deterministic failure, not a provider blip", () => {
  // capture() in this module emits this exact wording for a binary that never
  // answers `--version`. The per-command timeout added for hung git/gh work
  // must not reach in here and make a broken CLI look retryable.
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: null,
    stderr: "\npreflight timed out after 30 seconds",
    stdout: "",
  };
  const classified = adapters.CLAUDE.classifyError(evidence);
  assert.notEqual(classified.failureClass, "TRANSIENT_PROVIDER");
  assert.equal(classified.retryable, false);
});

/** `/bin/echo` exits 0 and echoes its argv, so it answers `--version` and every
 *  probe below it without a chmod'd stub CLI on disk. What each preflight then
 *  refuses is the per-runner check this test is about. */
const echoConfig = {
  binaries: { CLAUDE: "/bin/echo", CODEX: "/bin/echo", PI: "/bin/echo" },
  runAsPrefix: [],
} as unknown as RunnerConfig;

test("Claude preflight fails closed when the CLI omits user-source isolation", async () => {
  const result = await adapters.CLAUDE.preflight({ config: echoConfig, runner: "CLAUDE", model: "claude", env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error, PREFLIGHT_REASONS.cliIncompatible);
  assert.equal(result.capabilities.cliProtocol, undefined, "an incompatible CLI must not be recorded as verified");
  assert.equal(result.authMode, null);
});

test("Claude preflight still requires a logged-in session after verifying isolation", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "agentos-claude-capability-"));
  const stub = join(fixture, "claude-stub.sh");
  await writeFile(stub, [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "2.1.237"; exit 0; fi',
    'if [ "$1" = "--help" ]; then echo "--setting-sources"; exit 0; fi',
    'if [ "$1" = "auth" ]; then echo \'{"loggedIn":false}\'; exit 0; fi',
    "exit 1",
    "",
  ].join("\n"));
  await chmod(stub, 0o755);
  try {
    const config = {
      binaries: { CLAUDE: stub, CODEX: stub, PI: stub },
      runAsPrefix: [],
    } as unknown as RunnerConfig;
    const result = await adapters.CLAUDE.preflight({ config, runner: "CLAUDE", model: "claude", env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.error, `${PREFLIGHT_REASONS.notAuthenticated} (exit 0)`);
    assert.equal(result.authMode, null);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Codex preflight refuses a CLI that answers --version but not the exec protocol", async () => {
  const result = await adapters.CODEX.preflight({ config: echoConfig, runner: "CODEX", model: CODEX_STARTER_MODEL, env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error, PREFLIGHT_REASONS.cliIncompatible);
  assert.equal(result.capabilities.cliProtocol, undefined, "an incompatible CLI must not be recorded as verified");
});

test("an adapter is substituted by injection, never by writing over the exported record", () => {
  // executeClaim takes `adapter`; the record itself is frozen so the old
  // mutation path cannot silently come back.
  assert.equal(Object.isFrozen(adapters), true);
  for (const runner of ["CLAUDE", "CODEX", "PI"] as const) {
    assert.equal(Object.isFrozen(adapters[runner]), true, `${runner} adapter must be frozen`);
  }
  assert.deepEqual(RUNNER_KINDS, ["CLAUDE", "CODEX", "PI"]);
  assert.notEqual(adapters.CLAUDE.start, adapters.CODEX.start);
  assert.notEqual(adapters.CODEX.start, adapters.PI.start);
  assert.notEqual(adapters.CLAUDE.kill, adapters.CODEX.kill);
  assert.notEqual(adapters.CODEX.kill, adapters.PI.kill);
  assert.notEqual(adapters.CLAUDE.classifyError, adapters.CODEX.classifyError);
  assert.notEqual(adapters.CODEX.classifyError, adapters.PI.classifyError);
});

test("the runner registry exposes provider-owned session policy", () => {
  assert.deepEqual(
    Object.fromEntries(RUNNER_KINDS.map((runner) => [runner, {
      isolatesSessionConfig: RUNNER_DEFINITIONS[runner].isolatesSessionConfig,
      startupPreflightModel: RUNNER_DEFINITIONS[runner].startupPreflightModel,
      binaryEnvironment: RUNNER_DEFINITIONS[runner].binaryEnvironment,
    }])),
    {
      CLAUDE: { isolatesSessionConfig: false, startupPreflightModel: null, binaryEnvironment: "CLAUDE_BINARY" },
      CODEX: { isolatesSessionConfig: true, startupPreflightModel: CODEX_STARTER_MODEL, binaryEnvironment: "CODEX_BINARY" },
      PI: { isolatesSessionConfig: true, startupPreflightModel: "openai-codex/gpt-5.6-luna", binaryEnvironment: "PI_BINARY" },
    },
  );
  assert.deepEqual(piDeclaration.protectedEnvironmentVariables, [
    "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "AGENTOS_CODEX_SERVICE_TIER", "AGENTOS_PI_EXPECTS_OPENAI_CODEX",
  ]);
  assert.equal(piDeclaration.launcherEnvironmentVariables.includes("PI_CODING_AGENT_SESSION_DIR"), false);
});

test("a salvaged prior attempt names its commit and parent in the prompt", () => {
  const prompt = buildPrompt({
    ...claim,
    previousRunHandoff: {
      schemaVersion: 1,
      previousRunId: "run-1",
      status: "FAILED",
      failureReason: "Selected model is at capacity. Please try a different model.",
      retryReason: "automatic-retry",
      output: null,
      salvage: { commitSha: "s".repeat(40), parentSha: "r".repeat(40) },
    },
  });
  // Without this the fix step has to reconstruct from git history whether the
  // head it starts on is its own salvaged attempt.
  assert.match(prompt, new RegExp(`WIP salvage commit ${"s".repeat(40)}, made on top of ${"r".repeat(40)}`, "u"));
});
