import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ClaimedTask, FailureClass } from "../api.js";
import type { InFlightTool } from "../budget.js";
import type { RunnerConfig, RunnerKind } from "../config.js";
import { isTransientNetworkError } from "../network-retry.js";
import type { SessionToolTransport } from "../session-tool-contract.js";
import type { AgentScratch } from "../workspace.js";
import type { SessionConfigOptions } from "./session-config.js";

export type ToolKey = "BASH" | "READ" | "WRITE" | "EDIT" | "GLOB" | "GREP" | "WEB_FETCH" | "WEB_SEARCH";

export type AdapterEvent = {
  source: "RUNNER" | "CLAUDE" | "CODEX" | "PI";
  type: string;
  providerEventId?: string | null;
  toolCallId?: string | null;
  payload: Record<string, unknown>;
};

export type SessionEventSink = (event: AdapterEvent) => void;

export type ExitEvidence = {
  exitCode: number | null;
  signal: string | null;
  terminalEventSeen: boolean;
  terminalSuccess: boolean;
  terminationReason: string | null;
  finalOutput: string | null;
  providerError: string | null;
  stdout: string;
  stderr: string;
};

export type ClassifiedFailure = {
  failureClass: FailureClass;
  retryable: boolean;
  operatorAction?: string;
};

export type HeartbeatSnapshot = {
  processAlive: boolean;
  lastProcessAliveAt: Date;
  lastProgressEventAt: Date;
  inFlightTool: InFlightTool | null;
};

export type AdapterState = {
  runId: string;
  runner: RunnerKind;
  startedAt: Date;
  lastProcessAliveAt: Date;
  lastProgressEventAt: Date;
  /**
   * In-memory provider-boundary timing for the currently requested model turn.
   * The provider parsers stamp the first turn at their MODEL_STARTED event,
   * then stamp later turns at the tool completion or user-input event that
   * completes the next model input. These values never become standalone
   * SessionEvent rows; only the completion payload receives the derived TTFT.
   */
  turnRequestedAt: Date | null;
  firstChunkAt: Date | null;
  /** Guards the provider's one-time first-turn MODEL_STARTED boundary. */
  turnRequestSeen: boolean;
  inFlightTool: InFlightTool | null;
  providerConversationId: string | null;
  terminalEventSeen: boolean;
  terminalSuccess: boolean;
  terminationReason: string | null;
  sawError: boolean;
  providerError: string | null;
  /** The provider's own record of this child, owned by its adapter alone. */
  providerState: unknown;
  finalOutput: string | null;
  stdout: string;
  stderr: string;
};

export type RuntimeHandle = AdapterState & {
  child: ChildProcess;
  pid: number | null;
  exit: Promise<ExitEvidence>;
};

export type PreflightSpec = {
  config: RunnerConfig;
  runner: RunnerKind;
  model: string | null;
  env: NodeJS.ProcessEnv;
};

export type PreflightResult = {
  ok: boolean;
  cliVersion: string | null;
  authMode: string | null;
  capabilities: Record<string, unknown>;
  error?: string;
};

export type RunSpec = {
  config: RunnerConfig;
  claim: ClaimedTask;
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  /** 0600 file the Anneal MCP server reads its session credentials from. */
  credentialsPath: string;
};

export type ResumeSpec = RunSpec & { providerConversationId: string; input: string };
export type KillResult = { signal: "SIGTERM" | "SIGKILL" | null; processAlive: boolean };

/** One CLI implementation at the runner seam. */
export interface CliAdapter {
  preflight(spec: PreflightSpec): Promise<PreflightResult>;
  start(spec: RunSpec, sink: SessionEventSink): Promise<RuntimeHandle>;
  resume(spec: ResumeSpec, sink: SessionEventSink): Promise<RuntimeHandle>;
  kill(handle: RuntimeHandle, reason: string): Promise<KillResult>;
  heartbeat(handle: RuntimeHandle): Promise<HeartbeatSnapshot>;
  classifyError(evidence: ExitEvidence): ClassifiedFailure;
  /**
   * Is this dead child's exit a disconnect of the provider's own transport?
   *
   * Asked only about an exit the shared verdict already classified as
   * `dropped`, so the fields that say a child was stopped or reported its own
   * end are not this hook's business. What it adds is provider-shaped: the
   * text a provider uses for a lost connection, and the adapter's own
   * `providerState` from that child, so no provider-shaped history has to
   * travel on the shared exit record.
   */
  isProviderDisconnect?(evidence: ExitEvidence, providerState: unknown): boolean;
}

export type AdapterEventParser = (
  state: AdapterState,
  event: Record<string, unknown>,
  sink: SessionEventSink,
) => void;

/** Decides whether a provider line and its parsed adapter events are persisted. */
export type ProviderEventPersistencePredicate = (event: Record<string, unknown>) => boolean;

/**
 * Everything provider-specific that the runner needs, declared by the provider
 * module that owns it. The hub derives its public registry and environment
 * policy from these declarations.
 */
export type AdapterDeclaration = {
  runner: RunnerKind;
  binaryEnvironment: string;
  defaultBinary: string;
  toolIntroduction: string;
  toolTransport: SessionToolTransport;
  toolEntrypoint(): string;
  /** Tool policy keys this CLI can actually deny in argv. */
  enforcedTools: readonly ToolKey[];
  isolatesSessionConfig: boolean;
  startupPreflightModel: string | null;
  /** Task secrets with these names may not override provider policy. */
  protectedEnvironmentVariables: readonly string[];
  /** Provider-owned values that must survive a scrubbing run-as launcher. */
  launcherEnvironmentVariables: readonly string[];
  promptSections(claim: ClaimedTask): string[];
  args(spec: RunSpec, resume?: ResumeSpec): string[];
  childEnvironment(claim: Pick<ClaimedTask, "run">, scratch: AgentScratch): NodeJS.ProcessEnv;
  provisionSessionConfig(
    config: RunnerConfig,
    scratch: AgentScratch,
    options?: SessionConfigOptions,
  ): Promise<void>;
  initialProviderState(): unknown;
  providerEventPersistence: ProviderEventPersistencePredicate;
  /** Optional filter for provider lines retained in exit evidence stdout. */
  stdoutPersistence?: ProviderEventPersistencePredicate;
  parseEvent: AdapterEventParser;
  preflight(spec: PreflightSpec): Promise<PreflightResult>;
  /** Optional provider-owned reading of a dropped exit, see `CliAdapter`. */
  isProviderDisconnect?(evidence: ExitEvidence, providerState: unknown): boolean;
};

export const createAdapterState = (
  runner: RunnerKind,
  runId: string,
  providerState: unknown = undefined,
  startedAt = new Date(),
): AdapterState => ({
  runId,
  runner,
  startedAt,
  lastProcessAliveAt: startedAt,
  lastProgressEventAt: startedAt,
  turnRequestedAt: null,
  firstChunkAt: null,
  turnRequestSeen: false,
  inFlightTool: null,
  providerConversationId: null,
  terminalEventSeen: false,
  terminalSuccess: false,
  terminationReason: null,
  sawError: false,
  providerError: null,
  providerState,
  finalOutput: null,
  stdout: "",
  stderr: "",
});

const cap = (value: string, limit = 1_000_000): string => value.length <= limit ? value : value.slice(value.length - limit);
const sourceFor = (runner: RunnerKind): AdapterEvent["source"] => runner;

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const stringField = (object: Record<string, unknown> | null, field: string): string | null =>
  typeof object?.[field] === "string" ? object[field] as string : null;

export const eventErrorMessage = (event: Record<string, unknown>): string | null =>
  stringField(event, "message")
  ?? stringField(event, "error")
  ?? stringField(asRecord(event.error), "message");

export const emitAdapterEvent = (state: AdapterState, sink: SessionEventSink, type: string, payload: Record<string, unknown>, toolCallId?: string | null): void => {
  state.lastProgressEventAt = new Date();
  sink({ source: sourceFor(state.runner), type, payload, ...(toolCallId !== undefined ? { toolCallId } : {}) });
};

/**
 * Stamp the completion of the current model input and begin a new turn.
 * Provider boundary choices are intentionally narrow: Claude uses its first
 * system event, then each user/tool-result event; Codex uses thread.started,
 * then each completed command or non-command tool item; PI uses session, then
 * each completed tool or user message. A later boundary replaces an earlier
 * one when a provider reports several tool completions separately.
 */
export const markTurnRequested = (state: AdapterState, at = new Date()): void => {
  state.turnRequestedAt = at;
  state.firstChunkAt = null;
  state.turnRequestSeen = true;
};

/** Record only the first provider output chunk observed for the current turn. */
export const markFirstChunk = (state: AdapterState, at = new Date()): void => {
  if (state.turnRequestedAt !== null && state.firstChunkAt === null) state.firstChunkAt = at;
};

/** Add the derived timing namespace without changing an existing payload. */
const withTurnTtft = (state: AdapterState, payload: Record<string, unknown>): Record<string, unknown> => {
  if (state.turnRequestedAt === null || state.firstChunkAt === null) return payload;
  const anneal = asRecord(payload.anneal) ?? {};
  return {
    ...payload,
    anneal: {
      ...anneal,
      ttftMs: Math.max(0, state.firstChunkAt.getTime() - state.turnRequestedAt.getTime()),
    },
  };
};

/** Add TTFT to one completion payload, then consume its first-chunk stamp. */
export const consumeTurnTtft = (state: AdapterState, payload: Record<string, unknown>): Record<string, unknown> => {
  const completed = withTurnTtft(state, payload);
  state.turnRequestedAt = null;
  state.firstChunkAt = null;
  return completed;
};

export const markInFlightToolProgress = (state: AdapterState): void => {
  if (state.inFlightTool) state.inFlightTool.lastProgressAt = new Date();
};

const discardAdapterEvent: SessionEventSink = () => undefined;

export const processProviderEvent = (
  state: AdapterState,
  event: Record<string, unknown>,
  sink: SessionEventSink,
  parseEvent: AdapterEventParser,
  providerEventPersistence: ProviderEventPersistencePredicate,
): void => {
  const shouldPersist = providerEventPersistence(event);
  if (shouldPersist) sink({ source: sourceFor(state.runner), type: "PROVIDER_RAW", payload: event });
  parseEvent(state, event, shouldPersist ? sink : discardAdapterEvent);
};

const processLine = (
  state: AdapterState,
  line: string,
  sink: SessionEventSink,
  parseEvent: AdapterEventParser,
  providerEventPersistence: ProviderEventPersistencePredicate,
): void => {
  if (!line.trim()) return;
  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    event = asRecord(parsed) ?? { value: parsed };
  } catch {
    state.sawError = true;
    emitAdapterEvent(state, sink, "ADAPTER_ERROR", { error: "invalid-json", line });
    return;
  }
  processProviderEvent(state, event, sink, parseEvent, providerEventPersistence);
};

const retainStdoutLine = (
  line: string,
  persistence: ProviderEventPersistencePredicate | undefined,
): boolean => {
  if (!persistence) return true;
  try {
    const parsed = JSON.parse(line) as unknown;
    return persistence(asRecord(parsed) ?? { value: parsed });
  } catch {
    // Preserve non-JSON diagnostics. A valid partial provider event is always
    // line-delimited JSON, so malformed text cannot be classified as one.
    return true;
  }
};

// Run.model carries an optional reasoning-effort suffix: "<model>[:<effort>]".
export const modelSpec = (raw: string): { model: string; effort: string | null } => {
  const at = raw.lastIndexOf(":");
  return at > 0 ? { model: raw.slice(0, at), effort: raw.slice(at + 1) } : { model: raw, effort: null };
};

/**
 * The prompt or resume input is stdin, never argv. Persisted predecessor
 * outputs can exceed operating-system argv limits, and argv is visible in ps.
 */
export const inputForRunner = (spec: RunSpec, resume?: ResumeSpec): string => resume?.input ?? spec.prompt;

export const promptHashFor = (prompt: string): string => createHash("sha256").update(prompt).digest("hex");

const COMMON_LAUNCHER_ENVIRONMENT = [
  "RUNNER_WORKSPACE_ROOT", "CONTROL_PLANE_STATE_DIR", "HOME", "GIT_CONFIG_GLOBAL", "AGENTOS_GATE_SERVER",
  "AGENTOS_GATE_PRIMARY_SERVER", "AGENTOS_GATE_FALLBACK_SERVER",
  "AGENTOS_GATE_ALLOW_LOCAL", "AGENTOS_GATE_LOCAL_SLOTS", "AGENTOS_GATE_PRIMARY_SLOTS",
  "AGENTOS_RUN_ID", "AGENTOS_TOOLS", "AGENTOS_HOST_PROOF_SLOT_DIR", "AGENTOS_HOST_PROOF_SLOTS",
  "AGENTOS_REGRESSION_RECOVERY_CONTEXT",
  "AGENTOS_RUNNER_HOME",
] as const;

/**
 * The runner's `git -c` overrides are a numbered list, so the launcher forwards
 * as many pairs as GIT_CONFIG_COUNT declares. Naming a fixed first pair instead
 * would silently drop every later one across the run-as boundary, and git reads
 * GIT_CONFIG_COUNT before the pairs: a forwarded count with a missing pair is a
 * hard git error, not a quiet default.
 */
const gitConfigLauncherNames = (env: NodeJS.ProcessEnv): string[] => {
  const declared = Number(env.GIT_CONFIG_COUNT);
  if (!Number.isSafeInteger(declared) || declared <= 0) return [];
  return [
    "GIT_CONFIG_COUNT",
    ...Array.from({ length: declared }, (_unused, index) => [`GIT_CONFIG_KEY_${index}`, `GIT_CONFIG_VALUE_${index}`]).flat(),
  ];
};

export const launchAdapterArgv = (
  config: Pick<RunnerConfig, "runAsPrefix" | "binaries">,
  declaration: Pick<AdapterDeclaration, "runner" | "launcherEnvironmentVariables">,
  args: string[],
  env: NodeJS.ProcessEnv,
): { executable: string; args: string[] } => {
  const binary = config.binaries[declaration.runner];
  if (config.runAsPrefix.length === 0) return { executable: binary, args };
  const names = [
    ...COMMON_LAUNCHER_ENVIRONMENT,
    ...gitConfigLauncherNames(env),
    ...declaration.launcherEnvironmentVariables,
  ];
  const assignments = names.flatMap((name) => env[name] !== undefined ? [`${name}=${env[name]}`] : []);
  return {
    executable: config.runAsPrefix[0]!,
    args: [
      ...config.runAsPrefix.slice(1),
      ...(assignments.length > 0 ? ["/usr/bin/env", ...assignments] : []),
      binary,
      ...args,
    ],
  };
};

export const spawnAdapterRuntime = (
  declaration: AdapterDeclaration,
  spec: RunSpec,
  sink: SessionEventSink,
  resume?: ResumeSpec,
): RuntimeHandle => {
  const { runner } = declaration;
  const binary = spec.config.binaries[runner];
  const args = declaration.args(spec, resume);
  const input = inputForRunner(spec, resume);
  const { executable, args: fullArgs } = launchAdapterArgv(spec.config, declaration, args, spec.env);
  const startedAt = new Date();
  const child = spawn(executable, fullArgs, {
    cwd: spec.workingDirectory,
    env: spec.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const handle: RuntimeHandle = {
    ...createAdapterState(runner, spec.claim.run.id, declaration.initialProviderState(), startedAt),
    child,
    pid: child.pid ?? null,
    exit: Promise.resolve({} as ExitEvidence),
  };
  let buffer = "";
  const stdoutPersistence = declaration.stdoutPersistence;
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    if (!stdoutPersistence) handle.stdout = cap(handle.stdout + chunk);
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (stdoutPersistence && retainStdoutLine(line, stdoutPersistence)) handle.stdout = cap(handle.stdout + `${line}\n`);
      processLine(handle, line, sink, declaration.parseEvent, declaration.providerEventPersistence);
    }
  });
  child.stderr!.on("data", (chunk: string) => {
    handle.stderr = cap(handle.stderr + chunk);
    sink({ source: sourceFor(runner), type: "STDERR", payload: { text: chunk } });
  });
  handle.exit = new Promise<ExitEvidence>((resolvePromise) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      if (buffer.trim()) {
        if (stdoutPersistence && retainStdoutLine(buffer, stdoutPersistence)) handle.stdout = cap(handle.stdout + buffer);
        processLine(handle, buffer, sink, declaration.parseEvent, declaration.providerEventPersistence);
      }
      resolvePromise({
        exitCode,
        signal,
        terminalEventSeen: handle.terminalEventSeen,
        terminalSuccess: handle.terminalSuccess,
        terminationReason: handle.terminationReason,
        finalOutput: handle.finalOutput,
        providerError: handle.providerError,
        stdout: handle.stdout,
        stderr: handle.stderr,
      });
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      handle.sawError = true;
      handle.stderr = cap(`${handle.stderr}\n${error.message}`);
      finish(error.code === "ENOENT" ? 127 : 1, null);
    });
    child.once("close", (code, signal) => finish(code, signal));
  });
  child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
    sink({
      source: "RUNNER",
      type: "PROMPT_DELIVERY_FAILED",
      payload: { message: error.message, code: error.code ?? null },
    });
  });
  child.stdin!.end(input);
  sink({ source: "RUNNER", type: "PROCESS_STARTED", payload: {
    pid: handle.pid,
    binary,
    args,
    promptTransport: "stdin",
    promptBytes: Buffer.byteLength(input),
    promptHash: promptHashFor(input),
  } });
  return handle;
};

export const capturePreflight = async (
  config: RunnerConfig,
  declaration: Pick<AdapterDeclaration, "runner" | "launcherEnvironmentVariables">,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((resolvePromise) => {
  const launch = launchAdapterArgv(config, declaration, args, env);
  const child = spawn(launch.executable, launch.args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (code: number | null, extra = ""): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolvePromise({ code, stdout, stderr: `${stderr}${extra}` });
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(1, "\npreflight timed out after 30 seconds");
  }, 30_000);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? 127 : 1, `\n${error.message}`));
  child.once("close", (code) => finish(code));
});

export const PREFLIGHT_CLASS = {
  cliMissing: "cli-missing",
  cliIncompatible: "cli-incompatible",
  notAuthenticated: "not-authenticated",
  unsupportedModel: "unsupported-model",
} as const;

export const PREFLIGHT_REASONS = {
  cliMissing: `${PREFLIGHT_CLASS.cliMissing}: the CLI did not answer --version`,
  cliIncompatible: `${PREFLIGHT_CLASS.cliIncompatible}: the CLI does not expose the required Anneal exec protocol`,
  notAuthenticated: `${PREFLIGHT_CLASS.notAuthenticated}: the CLI's own login check did not pass`,
  unsupportedModel: `${PREFLIGHT_CLASS.unsupportedModel}: an explicit provider/model is required`,
} as const;

export const preflightFailure = (reason: string, code: number | null): string =>
  code === null ? reason : `${reason} (exit ${code})`;

export const outputTail = (evidence: ExitEvidence): string | null =>
  (evidence.finalOutput ?? evidence.stdout).trim().slice(-500_000) || null;

export const failureReasonFromEvidence = (evidence: ExitEvidence): string =>
  evidence.providerError?.trim()
  || evidence.stderr.trim()
  || `CLI exited with code ${evidence.exitCode}`;

export const classifyRuntimeError = (evidence: ExitEvidence): ClassifiedFailure => {
  const text = evidence.providerError?.trim()
    ? `${evidence.providerError}\n${evidence.stderr}`
    : `${evidence.stderr}\n${evidence.stdout}`;
  const authEvidence = `${evidence.providerError ?? ""}\n${evidence.stderr}`;
  if (evidence.terminationReason) return { failureClass: "CANCELLED_OR_TIMED_OUT", retryable: false };
  if (evidence.exitCode === 127) {
    return { failureClass: "BINARY_NOT_FOUND", retryable: false, operatorAction: "Install the configured CLI or repair RUNNER_PATH" };
  }
  if (new RegExp(`authentication_failed|\\b401\\b|Missing authentication|No API key found|not logged in|${PREFLIGHT_CLASS.notAuthenticated}`, "iu").test(authEvidence)) {
    return { failureClass: "AUTH_REQUIRED", retryable: false, operatorAction: "Log the runner account into the CLI" };
  }
  if (/connection lost|server_error/iu.test(`${evidence.providerError ?? ""}`)) {
    return { failureClass: "TRANSIENT_PROVIDER", retryable: true };
  }
  if (/\b429\b|rate.?limit|usage.?limit|quota/iu.test(text)) return { failureClass: "RATE_LIMITED", retryable: true };
  if (isTransientNetworkError(text) || /\b5\d\d\b|provider outage/iu.test(text)) {
    return { failureClass: "TRANSIENT_PROVIDER", retryable: true };
  }
  if (/"isError"\s*:\s*true|"command_execution"[\s\S]{0,500}"status"\s*:\s*"failed"/u.test(text)) {
    return { failureClass: "TOOL_FAILED", retryable: false };
  }
  if (evidence.exitCode === 0 && (!evidence.terminalEventSeen || !evidence.terminalSuccess)) {
    return { failureClass: "PROTOCOL_ERROR", retryable: true, operatorAction: "Check CLI protocol/version drift" };
  }
  return { failureClass: "TASK_FAILED", retryable: false };
};

const ownedRunProcesses = async (runId: string): Promise<number[]> => new Promise((resolvePromise, rejectPromise) => {
  const args = process.platform === "darwin"
    ? ["-Eww", "-axo", "pid=,ppid=,pgid=,command="]
    : ["-axeww", "-o", "pid=,ppid=,pgid=,command="];
  execFile("ps", args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
    if (error) {
      rejectPromise(new Error(`Unable to inspect Run-owned processes: ${error.message}`));
      return;
    }
    const marker = ` AGENTOS_RUN_ID=${runId}`;
    const pids = stdout.split("\n").flatMap((line) => {
      if (!line.includes(marker)) return [];
      const match = /^\s*(\d+)\s+/u.exec(line);
      return match ? [Number.parseInt(match[1]!, 10)] : [];
    });
    resolvePromise(pids.filter((pid) => pid !== process.pid));
  });
});

const signalProcesses = (pids: number[], signal: NodeJS.Signals): void => {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
};

const waitForRunDrain = async (runId: string, timeoutMs: number): Promise<number[]> => {
  const deadline = Date.now() + timeoutMs;
  let remaining = await ownedRunProcesses(runId);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    remaining = await ownedRunProcesses(runId);
  }
  return remaining;
};

export const killRuntime = async (handle: RuntimeHandle, reason: string): Promise<KillResult> => {
  handle.terminationReason = reason;
  const pid = handle.pid;
  if (pid && handle.child.exitCode === null && handle.child.signalCode === null) {
    try { process.kill(-pid, "SIGTERM"); } catch { /* the ownership scan below is authoritative */ }
  }
  let remaining = await ownedRunProcesses(handle.runId);
  signalProcesses(remaining, "SIGTERM");
  remaining = await waitForRunDrain(handle.runId, 5_000);
  if (remaining.length === 0) {
    await handle.exit;
    return { signal: pid ? "SIGTERM" : null, processAlive: false };
  }
  signalProcesses(remaining, "SIGKILL");
  remaining = await waitForRunDrain(handle.runId, 5_000);
  if (remaining.length > 0) throw new Error(`Unable to terminate ${remaining.length} process(es) owned by Run ${handle.runId}`);
  await handle.exit;
  return { signal: "SIGKILL", processAlive: false };
};

export const heartbeatRuntime = async (handle: RuntimeHandle): Promise<HeartbeatSnapshot> => {
  const processAlive = handle.child.exitCode === null && handle.child.signalCode === null;
  if (processAlive) handle.lastProcessAliveAt = new Date();
  return {
    processAlive,
    lastProcessAliveAt: handle.lastProcessAliveAt,
    lastProgressEventAt: handle.lastProgressEventAt,
    inFlightTool: handle.inFlightTool,
  };
};

export const createCliAdapter = (declaration: AdapterDeclaration): CliAdapter => Object.freeze<CliAdapter>({
  preflight: (spec) => declaration.preflight({ ...spec, runner: declaration.runner }),
  start: async (spec, sink) => spawnAdapterRuntime(declaration, spec, sink),
  resume: async (spec, sink) => spawnAdapterRuntime(declaration, spec, sink, spec),
  kill: (handle, reason) => killRuntime(handle, reason),
  heartbeat: (handle) => heartbeatRuntime(handle),
  classifyError: (evidence) => classifyRuntimeError(evidence),
  ...(declaration.isProviderDisconnect
    ? { isProviderDisconnect: declaration.isProviderDisconnect }
    : {}),
});

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
export const mcpServerPath = (): string => process.env.RUNNER_MCP_SERVER_PATH ?? join(packageRoot, "dist", "mcp-server.js");
export const nodeBinaryPath = (): string => process.env.RUNNER_NODE_BINARY ?? process.execPath;
export const mcpServerArgs = (credentialsPath: string): string[] => [mcpServerPath(), "--credentials", credentialsPath];
export const mcpConfig = (credentialsPath: string): { mcpServers: Record<string, { type: string; command: string; args: string[] }> } => ({
  mcpServers: { agentos: { type: "stdio", command: nodeBinaryPath(), args: mcpServerArgs(credentialsPath) } },
});

/** Whether a delta record carries non-empty output text beyond its type tag. */
export const carriesTextPayload = (record: Record<string, unknown> | null): boolean =>
  Object.entries(record ?? {}).some(([key, value]) => key !== "type" && typeof value === "string" && value.length > 0);
