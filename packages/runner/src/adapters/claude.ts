import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ClaimedTask } from "../api.js";
import type { RunnerConfig } from "../config.js";
import type { AgentScratch } from "../workspace.js";
import {
  asRecord,
  capturePreflight,
  consumeTurnTtft,
  createAdapterState,
  emitAdapterEvent,
  markFirstChunk,
  markTurnRequested,
  mcpConfig,
  mcpServerPath,
  modelSpec,
  PREFLIGHT_REASONS,
  preflightFailure,
  processProviderEvent,
  stringField,
  type AdapterDeclaration,
  type AdapterState,
  type PreflightResult,
  type PreflightSpec,
  type ResumeSpec,
  type RunSpec,
  type SessionEventSink,
  type ToolKey,
} from "./runtime.js";
import type { SessionConfigOptions } from "./session-config.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

export const claudePlatformSettingsPath = (): string =>
  process.env.RUNNER_CLAUDE_SETTINGS_PATH ?? join(packageRoot, "assets", "claude-platform-settings.json");

const CLAUDE_ENFORCED_TOOLS = Object.freeze([
  "BASH", "READ", "WRITE", "EDIT", "GLOB", "GREP", "WEB_FETCH", "WEB_SEARCH",
] as const);

const CLAUDE_TOOL_NAMES: Record<ToolKey, string> = {
  BASH: "Bash", READ: "Read", WRITE: "Write", EDIT: "Edit",
  GLOB: "Glob", GREP: "Grep", WEB_FETCH: "WebFetch", WEB_SEARCH: "WebSearch",
};

const denyArgs = (disabledTools: string[]): string[] => {
  const denied = new Set(disabledTools);
  const names = CLAUDE_ENFORCED_TOOLS.flatMap((tool) => denied.has(tool) ? [CLAUDE_TOOL_NAMES[tool]] : []);
  return names.length === 0 ? [] : ["--disallowedTools", names.join(",")];
};

export const claudeArgs = (spec: RunSpec, resume?: ResumeSpec): string[] => {
  const { model, effort } = modelSpec(spec.claim.run.model);
  return [
    "-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    // Model must be pinned explicitly; the CLI otherwise inherits the
    // operator's personal default, which is reserved quota.
    "--model", model, "--effort", effort ?? "high",
    ...denyArgs(spec.claim.agent.disabledTools),
    // Excluding the user source prevents host CLAUDE.md, settings, hooks,
    // plugins, memory, and Claude's user skill root ~/.claude/skills from
    // entering the session. Audited separately: this CLI does not discover the
    // cross-agent ~/.agents/skills root used by Codex and PI.
    // Authentication remains the CLI's existing Keychain flow: no
    // CLAUDE_CONFIG_DIR or HOME override is supplied here.
    // The guard is self-contained in this file: OS isolation also stages it
    // outside the release tree, so hook commands cannot depend on repo paths.
    "--setting-sources", "project,local", "--settings", claudePlatformSettingsPath(),
    // strict keeps the operator's personal MCP servers out of an agent session:
    // the manifest is supposed to be the whole tool surface.
    "--mcp-config", JSON.stringify(mcpConfig(spec.credentialsPath)), "--strict-mcp-config",
    ...(resume ? ["--resume", resume.providerConversationId] : []),
  ];
};

/** Partial stream rows are liveness and TTFT signals only. */
export const providerEventPersistence = (event: Record<string, unknown>): boolean =>
  stringField(event, "type") !== "stream_event";

const isClaudeOutputChunk = (event: Record<string, unknown>): boolean => {
  const stream = asRecord(event.event);
  const streamType = stringField(stream, "type");
  if (streamType === "content_block_delta") {
    const delta = asRecord(stream?.delta);
    return Object.entries(delta ?? {}).some(([key, value]) => key !== "type" && typeof value === "string" && value.length > 0);
  }
  if (streamType === "content_block_start") {
    const block = asRecord(stream?.content_block);
    // Tool-use block starts carry the tool name before input deltas arrive;
    // message_start/content_block_stop/message_delta/message_stop are headers
    // or completion metadata and cannot establish first output.
    return stringField(block, "type") === "tool_use"
      || (typeof block?.text === "string" && block.text.length > 0);
  }
  return false;
};

export const parseClaudeEvent = (
  state: AdapterState,
  event: Record<string, unknown>,
  sink: SessionEventSink,
): void => {
  const type = stringField(event, "type");
  if (type === "system") {
    state.providerConversationId = stringField(event, "session_id") ?? state.providerConversationId;
    // Claude's first system event closes the initial prompt boundary. Later
    // system notifications describe the same turn and must not reset TTFT.
    if (!state.turnRequestSeen) markTurnRequested(state);
    emitAdapterEvent(state, sink, "MODEL_STARTED", event);
  } else if (type === "stream_event") {
    // The parser still runs for suppressed rows, so this renews liveness and
    // records the first provider output without persisting partial payloads.
    if (isClaudeOutputChunk(event)) markFirstChunk(state);
    emitAdapterEvent(state, sink, "MODEL_DELTA", event);
  } else if (type === "assistant") {
    const message = asRecord(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of content) {
      const part = asRecord(item);
      if (stringField(part, "type") === "tool_use") {
        const toolId = stringField(part, "id") ?? "unknown";
        const now = new Date();
        state.inFlightTool = { id: toolId, name: stringField(part, "name") ?? "tool", startedAt: now, lastProgressAt: now };
        emitAdapterEvent(state, sink, "TOOL_STARTED", part ?? {}, toolId);
      }
    }
    emitAdapterEvent(state, sink, "MODEL_DELTA", consumeTurnTtft(state, event));
  } else if (type === "user") {
    const message = asRecord(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const inputCompleted = content.some((item) => stringField(asRecord(item), "type") === "tool_result");
    // Stamp at provider-event arrival, before any synchronous SessionEvent
    // sink work, so TTFT measures the provider boundary itself.
    if (inputCompleted || message !== null) markTurnRequested(state);
    for (const item of content) {
      const part = asRecord(item);
      if (stringField(part, "type") === "tool_result") {
        const toolId = stringField(part, "tool_use_id");
        state.inFlightTool = null;
        emitAdapterEvent(state, sink, "TOOL_COMPLETED", part ?? {}, toolId);
      }
    }
    // A user message (including a tool result) is the provider-visible end of
    // Claude's next model input. If several tool results arrive separately,
    // the latest event is the boundary used for the next turn.
  } else if (type === "result") {
    state.terminalEventSeen = true;
    state.terminalSuccess = event.is_error === false && event.terminal_reason === "completed";
    if (!state.terminalSuccess) state.sawError = true;
    if (event.is_error === true) state.providerError = stringField(event, "result") ?? state.providerError;
    state.finalOutput = stringField(event, "result") ?? state.finalOutput;
    emitAdapterEvent(state, sink, "FINAL_OUTPUT", event);
  } else {
    emitAdapterEvent(state, sink, "PROVIDER_STATUS", event);
  }
};

export const parseClaudeTranscript = (
  transcript: readonly unknown[],
  sink: SessionEventSink = () => undefined,
): AdapterState => {
  const state = createAdapterState("CLAUDE", "transcript");
  for (const value of transcript) processProviderEvent(state, asRecord(value) ?? { value }, sink, parseClaudeEvent, providerEventPersistence);
  return state;
};

const preflight = async (spec: PreflightSpec): Promise<PreflightResult> => {
  const capabilities = { structuredEvents: true, resume: true, killProcessGroup: true, heartbeat: true, classifyError: true };
  const version = await capturePreflight(spec.config, claudeDeclaration, ["--version"], spec.env);
  if (version.code !== 0) {
    return { ok: false, cliVersion: null, authMode: null, capabilities, error: preflightFailure(PREFLIGHT_REASONS.cliMissing, version.code) };
  }
  const help = await capturePreflight(spec.config, claudeDeclaration, ["--help"], spec.env);
  if (help.code !== 0 || !`${help.stdout}\n${help.stderr}`.includes("--setting-sources")) {
    return {
      ok: false,
      cliVersion: version.stdout.trim() || version.stderr.trim(),
      authMode: null,
      capabilities,
      error: PREFLIGHT_REASONS.cliIncompatible,
    };
  }
  Object.assign(capabilities, {
    ...(spec.model === null ? {} : { verifiedModel: spec.model }),
    cliProtocol: "print-stream-json-user-source-isolated",
  });
  const auth = await capturePreflight(spec.config, claudeDeclaration, ["auth", "status"], spec.env);
  const text = `${auth.stdout}\n${auth.stderr}`;
  const ok = auth.code === 0 && /"loggedIn"\s*:\s*true/u.test(text);
  return {
    ok,
    cliVersion: version.stdout.trim() || version.stderr.trim(),
    authMode: /"authMethod"\s*:\s*"([^"]+)"/u.exec(text)?.[1] ?? null,
    capabilities,
    ...(!ok ? { error: preflightFailure(PREFLIGHT_REASONS.notAuthenticated, auth.code) } : {}),
  };
};

export const claudeChildEnvironment = (
  _claim: Pick<ClaimedTask, "run">,
  _scratch: AgentScratch,
): NodeJS.ProcessEnv => ({});

/** Claude deliberately has no config-root strategy; authentication stays in Keychain. */
export const provisionClaudeSessionConfig = async (
  _config: RunnerConfig,
  _scratch: AgentScratch,
  _options: SessionConfigOptions = {},
): Promise<void> => undefined;

const promptSections = (claim: ClaimedTask): string[] => {
  if (claim.run.subagentModel !== null || claim.run.subagentMaxConcurrent !== null) {
    throw new Error("Native implementation subagents require a Codex root Run");
  }
  return [
    "Claude native subagent dispatch: Explicitly set model to opus for implementation and reasoning, sonnet only for simple exploration, or haiku only for mechanical scanning. Fable, omitted model, and inherit are blocked by the platform PreToolUse guard. A fork ignores model and is allowed only when its transcript proves an Opus, Sonnet, or Haiku parent. Keep simple branch merges and integration verification in the main agent; delegate integration only when it is independent, complex work and explain why. Parallel implementation slices need clear file boundaries and separate worktrees for concurrent edits.",
  ];
};

export const claudeDeclaration: AdapterDeclaration = Object.freeze({
  runner: "CLAUDE",
  binaryEnvironment: "CLAUDE_BINARY",
  defaultBinary: "claude",
  toolIntroduction: "Anneal tools attached to this session (MCP server 'agentos'; your client may prefix them, e.g. mcp__agentos__task_output):",
  toolTransport: "mcp-stdio",
  toolEntrypoint: mcpServerPath,
  enforcedTools: CLAUDE_ENFORCED_TOOLS,
  isolatesSessionConfig: false,
  startupPreflightModel: null,
  protectedEnvironmentVariables: ["CLAUDE_CONFIG_DIR"],
  launcherEnvironmentVariables: [],
  promptSections,
  args: claudeArgs,
  childEnvironment: claudeChildEnvironment,
  provisionSessionConfig: provisionClaudeSessionConfig,
  initialProviderState: () => undefined,
  providerEventPersistence,
  stdoutPersistence: providerEventPersistence,
  parseEvent: parseClaudeEvent,
  preflight,
});
