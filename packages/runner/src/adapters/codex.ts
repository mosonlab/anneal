import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isCodexReconnectStatus } from "@anneal/db";

import type { ClaimedTask } from "../api.js";
import type { RunnerConfig, RunnerKind } from "../config.js";
import { isTransientNetworkError } from "../network-retry.js";
import type { AgentScratch } from "../workspace.js";
import {
  asRecord,
  capturePreflight,
  classifyRuntimeError,
  consumeTurnTtft,
  createAdapterState,
  emitAdapterEvent,
  eventErrorMessage,
  markFirstChunk,
  markInFlightToolProgress,
  markTurnRequested,
  mcpServerArgs,
  mcpServerPath,
  modelSpec,
  nodeBinaryPath,
  PREFLIGHT_REASONS,
  preflightFailure,
  processProviderEvent,
  stringField,
  type AdapterDeclaration,
  type AdapterState,
  type ExitEvidence,
  type PreflightResult,
  type PreflightSpec,
  type ResumeSpec,
  type RunSpec,
  type SessionEventSink,
} from "./runtime.js";
import { provisionIsolatedSessionConfig, type SessionConfigOptions } from "./session-config.js";

export const CODEX_STARTER_MODEL = "gpt-5.6-sol:medium";

const CODEX_BARE_DISCONNECT = /^stream disconnected before completion:[^\r\n]+$/iu;
const isCodexBareDisconnect = (message: string | null): boolean => CODEX_BARE_DISCONNECT.test(message?.trim() ?? "");

const NON_RESUMABLE_FAILURE_CLASSES = new Set([
  "BINARY_NOT_FOUND",
  "AUTH_REQUIRED",
  "TOOL_FAILED",
  "RATE_LIMITED",
  "CANCELLED_OR_TIMED_OUT",
]);

/** What the Codex adapter remembers about one child beyond the shared record. */
export type CodexProviderState = {
  /** A reconnect status is provisional; this flag preserves a real provider
   *  error observed earlier in the same child. */
  sawNonReconnectProviderError: boolean;
};

export const initialCodexState = (): CodexProviderState => ({ sawNonReconnectProviderError: false });

const codexState = (providerState: unknown): CodexProviderState => providerState as CodexProviderState;

/**
 * Is this dead Codex child's exit Codex's own transport dropping?
 *
 * Asked only about an exit the shared `agentExitVerdict` already classified as
 * `dropped`, so nothing here re-reads whether the child was stopped or
 * reported its own end. What is left is Codex-shaped. Reconnect progress is
 * reported through Codex's `error` event, but a plain reconnect message is only
 * provisional: the adapter's own state carries the history of non-reconnect
 * provider errors so a later reconnect status cannot hide an earlier terminal
 * provider error.
 */
export const isCodexProviderDisconnect = (evidence: ExitEvidence, providerState: unknown): boolean => {
  if (codexState(providerState).sawNonReconnectProviderError) return false;

  if (NON_RESUMABLE_FAILURE_CLASSES.has(classifyRuntimeError(evidence).failureClass)) return false;

  const reconnectStatus = isCodexReconnectStatus(evidence.providerError);
  const bareDisconnect = isCodexBareDisconnect(evidence.providerError);
  const transientNetwork = isTransientNetworkError(`${evidence.providerError ?? ""}\n${evidence.stderr}`);
  return reconnectStatus || bareDisconnect || transientNetwork;
};

export const codexNativeSubagentProfile = (run: ClaimedTask["run"], runner: RunnerKind): {
  model: string;
  effort: string;
  maxConcurrent: number;
} | null => {
  if (run.subagentModel === null && run.subagentMaxConcurrent === null) return null;
  if (run.subagentModel === null || run.subagentMaxConcurrent === null) {
    throw new Error("Run contains an incomplete native subagent snapshot");
  }
  if (runner !== "CODEX") throw new Error("Native implementation subagents require a Codex root Run");
  const { model, effort } = modelSpec(run.subagentModel);
  if (model !== "gpt-5.6-luna" || effort !== "max" || run.subagentMaxConcurrent !== 8) {
    throw new Error("Native implementation subagents must use gpt-5.6-luna:max with concurrency 8");
  }
  return { model, effort, maxConcurrent: run.subagentMaxConcurrent };
};

export const codexSessionConfigBaselineRoot = (): string =>
  fileURLToPath(new URL("../../assets/session-config-baseline", import.meta.url));

export const codexPlatformBaselinePath = (): string => join(
  process.env.RUNNER_SESSION_CONFIG_BASELINE_ROOT ?? codexSessionConfigBaselineRoot(),
  "codex",
  "config.toml",
);

const mcpArgs = (credentialsPath: string): string[] => [
  "-c", `mcp_servers.agentos.command=${JSON.stringify(nodeBinaryPath())}`,
  "-c", `mcp_servers.agentos.args=${JSON.stringify(mcpServerArgs(credentialsPath))}`,
  "-c", "mcp_servers.agentos.startup_timeout_sec=30",
];

const nativeSubagentArgs = (run: ClaimedTask["run"]): string[] => {
  const profile = codexNativeSubagentProfile(run, "CODEX");
  if (!profile) return [];
  return [
    "--enable", "multi_agent_v2",
    "-c", `agents.default_subagent_model=${JSON.stringify(profile.model)}`,
    "-c", `agents.default_subagent_reasoning_effort=${JSON.stringify(profile.effort)}`,
    "-c", `agents.max_concurrent_threads_per_session=${profile.maxConcurrent}`,
  ];
};

const codexPromptSections = (claim: ClaimedTask): string[] => {
  const profile = codexNativeSubagentProfile(claim.run, "CODEX");
  if (!profile) return [];
  return [
    "",
    "Platform-pinned native implementation subagents:",
    `- model: ${profile.model}`,
    `- reasoning effort: ${profile.effort}`,
    `- maximum concurrent child threads: ${profile.maxConcurrent} (root excluded)`,
    "- multi_agent_v2 is enabled by the runner. Spawn, message, wait for, and close native children through the session collaboration tools; do not launch nested Codex CLI processes.",
    "- The runner enforces the same child model and concurrency snapshot on fresh starts and resumes. Do not select or escalate a child model.",
  ];
};

export const codexArgs = (spec: RunSpec, resume?: ResumeSpec): string[] => {
  const { model, effort } = modelSpec(spec.claim.run.model);
  const serviceTier = spec.claim.run.codexServiceTier.toLowerCase();
  // Codex exposes no supported per-tool deny flags. CliAdapter's interface
  // makes this limitation explicit; disabledTools remains policy metadata and
  // the console marks every Codex tool toggle as not enforced.
  return resume
    ? [
      "exec", "resume", "--json", "-m", model,
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
      "-c", `service_tier="${serviceTier}"`,
      ...nativeSubagentArgs(spec.claim.run),
      ...mcpArgs(spec.credentialsPath),
      "--dangerously-bypass-approvals-and-sandbox", resume.providerConversationId, "-",
    ]
    : [
      "exec", "--json", "-m", model,
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
      "-c", `service_tier="${serviceTier}"`,
      ...nativeSubagentArgs(spec.claim.run),
      ...mcpArgs(spec.credentialsPath),
      "--dangerously-bypass-approvals-and-sandbox", "-",
    ];
};

const observedNativeChild = (item: Record<string, unknown> | null): boolean => {
  if (!item) return false;
  const itemType = stringField(item, "type");
  const tool = stringField(item, "tool");
  const status = stringField(item, "status");
  const receiverThreadIds = Array.isArray(item.receiver_thread_ids)
    ? item.receiver_thread_ids
    : Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
  return (itemType === "collab_agent_tool_call" || itemType === "collabAgentToolCall")
    && (tool === "spawn_agent" || tool === "spawnAgent")
    && status === "completed"
    && receiverThreadIds.some((value) => typeof value === "string" && value.length > 0);
};

/** Tool results and applied file changes complete the next model input.
 * Reasoning and todo updates are model output, not completed tool input. */
const CODEX_TOOL_ITEM_TYPES = new Set([
  "command_execution", "mcp_tool_call", "collab_agent_tool_call",
  "file_change",
]);

const isCodexToolItem = (item: Record<string, unknown> | null): boolean => {
  const type = stringField(item, "type");
  return type !== null && CODEX_TOOL_ITEM_TYPES.has(type);
};

const isCodexAgentMessage = (item: Record<string, unknown> | null): boolean =>
  stringField(item, "type") === "agent_message";

export const parseCodexEvent = (
  state: AdapterState,
  event: Record<string, unknown>,
  sink: SessionEventSink,
): void => {
  const type = stringField(event, "type");
  if (type === "thread.started") {
    state.providerConversationId = stringField(event, "thread_id") ?? state.providerConversationId;
    // Codex exposes the initial prompt boundary at thread.started. Later
    // turns are bounded by completed command/tool items below; this is the
    // narrowest boundary available because the CLI does not expose a separate
    // user-input event for every resumed model request.
    if (!state.turnRequestSeen) markTurnRequested(state);
    emitAdapterEvent(state, sink, "MODEL_STARTED", event);
  } else if (type === "item.started") {
    const item = asRecord(event.item);
    if (stringField(item, "type") === "command_execution") {
      const toolId = stringField(item, "id") ?? "unknown";
      const now = new Date();
      state.inFlightTool = { id: toolId, name: "command_execution", startedAt: now, lastProgressAt: now };
      emitAdapterEvent(state, sink, "TOOL_STARTED", item ?? {}, toolId);
    } else {
      // Use agent-message item.started when exposed. The checked-in Codex
      // capture emits only item.completed, so it correctly has no TTFT:
      // completion time cannot stand in for an unobserved first chunk.
      if (isCodexAgentMessage(item)) markFirstChunk(state);
      emitAdapterEvent(state, sink, "MODEL_DELTA", event);
    }
  } else if (type === "item.completed") {
    const item = asRecord(event.item);
    if (observedNativeChild(item)) emitAdapterEvent(state, sink, "NATIVE_CHILD_STARTED", item ?? {});
    if (stringField(item, "type") === "command_execution") {
      // Command completion is the provider-visible input boundary for the
      // next turn; stamp it before the synchronous completion sink runs.
      markTurnRequested(state);
      state.inFlightTool = null;
      emitAdapterEvent(state, sink, "TOOL_COMPLETED", item ?? {}, stringField(item, "id"));
    } else if (isCodexAgentMessage(item)) {
      // Codex may report an agent progress message while a long-running
      // command_execution remains open. Raw stderr deliberately does not
      // reach this path, so background warnings cannot renew a stuck tool.
      markInFlightToolProgress(state);
      state.finalOutput = stringField(item, "text") ?? state.finalOutput;
      emitAdapterEvent(state, sink, "MODEL_DELTA", consumeTurnTtft(state, event));
    } else {
      if (isCodexToolItem(item)) markTurnRequested(state);
      emitAdapterEvent(state, sink, "MODEL_DELTA", event);
    }
    // A nonzero shell command inside the session is normal agent behavior;
    // only item-level errors count as a run failure.
    if (item?.error) state.sawError = true;
  } else if (type === "error") {
    const message = eventErrorMessage(event);
    // Codex emits reconnect progress through the same `error` event used for
    // terminal provider failures. Keep the latest message as evidence while
    // the stream is disconnected, but do not make it an irreversible verdict:
    // a later turn.completed proves the reconnect recovered. Every other error
    // remains latched, including an unrecognised error with no message.
    if (!isCodexReconnectStatus(message)) {
      state.sawError = true;
      // The final bare disconnect is the resumable terminal form of the
      // reconnect status, not a separate provider rejection.
      if (!isCodexBareDisconnect(message)) codexState(state.providerState).sawNonReconnectProviderError = true;
    }
    state.providerError = message ?? state.providerError;
    emitAdapterEvent(state, sink, "ADAPTER_ERROR", event);
  } else if (type === "turn.completed") {
    state.terminalEventSeen = true;
    state.terminalSuccess = !state.sawError;
    emitAdapterEvent(state, sink, "FINAL_OUTPUT", event);
  } else {
    emitAdapterEvent(state, sink, "PROVIDER_STATUS", event);
  }
};

export const parseCodexTranscript = (
  transcript: readonly unknown[],
  sink: SessionEventSink = () => undefined,
): AdapterState => {
  const state = createAdapterState("CODEX", "transcript", initialCodexState());
  for (const value of transcript) processProviderEvent(state, asRecord(value) ?? { value }, sink, parseCodexEvent, () => true);
  return state;
};

const execHelpIsCompatible = (help: string, resumeHelp: string): boolean => [
  "--json",
  "--model",
  "--config",
  "--dangerously-bypass-approvals-and-sandbox",
].every((flag) => help.includes(flag) && resumeHelp.includes(flag))
  && help.includes("resume")
  && resumeHelp.includes("SESSION_ID")
  && resumeHelp.includes("read from stdin");

const preflight = async (spec: PreflightSpec): Promise<PreflightResult> => {
  const capabilities = { structuredEvents: true, resume: true, killProcessGroup: true, heartbeat: true, classifyError: true };
  if (spec.model === null) {
    return { ok: false, cliVersion: null, authMode: null, capabilities, error: PREFLIGHT_REASONS.unsupportedModel };
  }
  const version = await capturePreflight(spec.config, codexDeclaration, ["--version"], spec.env);
  if (version.code !== 0) {
    return { ok: false, cliVersion: null, authMode: null, capabilities, error: preflightFailure(PREFLIGHT_REASONS.cliMissing, version.code) };
  }
  const help = await capturePreflight(spec.config, codexDeclaration, ["exec", "--help"], spec.env);
  const resumeHelp = await capturePreflight(spec.config, codexDeclaration, ["exec", "resume", "--help"], spec.env);
  if (help.code !== 0 || resumeHelp.code !== 0 || !execHelpIsCompatible(help.stdout, resumeHelp.stdout)) {
    return {
      ok: false,
      cliVersion: version.stdout.trim() || version.stderr.trim(),
      authMode: null,
      capabilities,
      error: PREFLIGHT_REASONS.cliIncompatible,
    };
  }
  Object.assign(capabilities, { verifiedModel: spec.model, cliProtocol: "exec-json-stdin-resume" });
  const auth = await capturePreflight(spec.config, codexDeclaration, ["login", "status"], spec.env);
  const text = `${auth.stdout}\n${auth.stderr}`;
  const ok = auth.code === 0;
  return {
    ok,
    cliVersion: version.stdout.trim() || version.stderr.trim(),
    authMode: text.includes("ChatGPT") ? "chatgpt" : null,
    capabilities,
    ...(!ok ? { error: preflightFailure(PREFLIGHT_REASONS.notAuthenticated, auth.code) } : {}),
  };
};

export const codexChildEnvironment = (
  _claim: Pick<ClaimedTask, "run">,
  scratch: AgentScratch,
): NodeJS.ProcessEnv => ({
  // Codex discovers user skills through both $CODEX_HOME/skills and the
  // cross-agent $HOME/.agents/skills root. Keep both inside this session's
  // provisioned config root; auth.json and the platform baseline already live
  // there, so relocating HOME does not change the authentication channel.
  HOME: scratch.configRoot,
  CODEX_HOME: scratch.configRoot,
  AGENTOS_CODEX_SERVICE_TIER: _claim.run.codexServiceTier.toLowerCase(),
});

export const provisionCodexSessionConfig = (
  config: RunnerConfig,
  scratch: AgentScratch,
  options: SessionConfigOptions = {},
): Promise<void> => provisionIsolatedSessionConfig(config, scratch, {
  label: "Codex",
  authFile: join(config.home, ".codex", "auth.json"),
  baselineFile: join(config.sessionConfigBaselineRoot ?? codexSessionConfigBaselineRoot(), "codex", "config.toml"),
}, options);

export const codexDeclaration: AdapterDeclaration = Object.freeze({
  runner: "CODEX",
  binaryEnvironment: "CODEX_BINARY",
  defaultBinary: "codex",
  toolIntroduction: "Anneal tools attached to this session (MCP server 'agentos'; your client may prefix them, e.g. mcp__agentos__task_output):",
  toolTransport: "mcp-stdio",
  toolEntrypoint: mcpServerPath,
  enforcedTools: [],
  isolatesSessionConfig: true,
  startupPreflightModel: CODEX_STARTER_MODEL,
  protectedEnvironmentVariables: ["CODEX_HOME", "AGENTOS_CODEX_SERVICE_TIER"],
  launcherEnvironmentVariables: ["CODEX_HOME", "AGENTOS_CODEX_SERVICE_TIER"],
  promptSections: codexPromptSections,
  args: codexArgs,
  childEnvironment: codexChildEnvironment,
  provisionSessionConfig: provisionCodexSessionConfig,
  initialProviderState: initialCodexState,
  providerEventPersistence: () => true,
  parseEvent: parseCodexEvent,
  preflight,
  isProviderDisconnect: isCodexProviderDisconnect,
});
