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
  markInFlightToolProgress,
  markTurnRequested,
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
} from "./runtime.js";
import { provisionIsolatedSessionConfig, type SessionConfigOptions } from "./session-config.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

export const piExtensionPath = (): string =>
  process.env.RUNNER_PI_EXTENSION_PATH ?? join(packageRoot, "assets", "pi-agentos-extension.ts");

const PI_ENFORCED_TOOLS = Object.freeze(["BASH", "READ", "WRITE", "EDIT"] as const);

const PI_TOOL_NAMES: Record<(typeof PI_ENFORCED_TOOLS)[number], string> = {
  BASH: "bash", READ: "read", WRITE: "write", EDIT: "edit",
};

const denyArgs = (disabledTools: string[]): string[] => {
  const denied = new Set(disabledTools);
  const names = PI_ENFORCED_TOOLS.flatMap((tool) => denied.has(tool) ? [PI_TOOL_NAMES[tool]] : []);
  return names.length === 0 ? [] : ["--exclude-tools", names.join(",")];
};

export const piArgs = (spec: RunSpec, resume?: ResumeSpec): string[] => {
  const { model, effort } = modelSpec(spec.claim.run.model);
  return [
    "-p", "--mode", "json", "--session-dir", join(spec.workingDirectory, ".agentos-pi"),
    "--model", model,
    ...(effort ? ["--thinking", effort] : []),
    ...denyArgs(spec.claim.agent.disabledTools),
    // Disable PI's $PI_CODING_AGENT_DIR/skills discovery (normally
    // ~/.pi/agent/skills) and the other user resource classes. The config root
    // is fresh, so only the explicit Anneal extension below remains enabled.
    // The reviewer's role prompt supplies its rules, and repository context
    // files remain review material rather than instructions.
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--extension", piExtensionPath(),
    ...(resume ? ["--session", resume.providerConversationId] : []),
  ];
};

/** PI prices per message in USD; the accumulator carries integer nano-USD. */
const NANOS_PER_USD = 1_000_000_000;

export type PiUsageTotals = {
  messages: number;
  reported: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  costNanoUsd: number | null;
};

type PiState = {
  turnCompleted: boolean;
  finalAttemptFailed: boolean;
  usage: PiUsageTotals;
};

const initialPiState = (): PiState => ({
  turnCompleted: false,
  finalAttemptFailed: false,
  usage: { messages: 0, reported: 0, input: null, output: null, cacheRead: null, cacheWrite: null, costNanoUsd: null },
});

const PI_SUPPRESSED_PROVIDER_EVENT_TYPES = new Set([
  "message_update",
  "tool_execution_update",
]);

/**
 * PI's incremental chunks are liveness-only. The runtime uses this adapter
 * policy before emitting either the raw provider row or the parsed event;
 * parsing still runs so the adapter can renew its stall-detector timestamps.
 */
export const providerEventPersistence = (event: Record<string, unknown>): boolean =>
  !PI_SUPPRESSED_PROVIDER_EVENT_TYPES.has(stringField(event, "type") ?? "");

const isPiMessageChunk = (event: Record<string, unknown>): boolean => {
  const messageEvent = asRecord(event.assistantMessageEvent);
  if (!messageEvent) return false;
  const type = stringField(messageEvent, "type");
  if (type === "text_delta" || type === "thinking_delta" || type === "reasoning_delta") {
    return Object.entries(messageEvent).some(([key, value]) => key !== "type" && typeof value === "string" && value.length > 0);
  }
  return type?.endsWith("_delta") === true
    && Object.entries(messageEvent).some(([key, value]) => key !== "type" && typeof value === "string" && value.length > 0);
};

const piState = (state: AdapterState): PiState => state.providerState as PiState;

const piNumber = (value: unknown, field: string, integral: boolean): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integral || Number.isSafeInteger(value))) return value;
  console.warn(JSON.stringify({ audit: "pi-usage", event: "field-dropped", field, value: String(value) }));
  return null;
};

/**
 * Fold one PI message's usage into the session totals.
 *
 * A captured `pi --mode json` transcript establishes that only assistant
 * `message_end` events contribute: `turn_end` repeats the same usage object.
 * PI's input excludes cacheRead, output includes reasoning, and cost.total is
 * per-message USD. Costs therefore accumulate as integer nano-USD and round
 * only once at the storage boundary.
 */
const harvestUsage = (totals: PiUsageTotals, message: Record<string, unknown>): void => {
  totals.messages += 1;
  const usage = asRecord(message.usage);
  if (!usage) return;
  totals.reported += 1;
  const input = piNumber(usage.input, "input", true);
  if (input !== null) totals.input = (totals.input ?? 0) + input;
  const output = piNumber(usage.output, "output", true);
  if (output !== null) totals.output = (totals.output ?? 0) + output;
  const cacheRead = piNumber(usage.cacheRead, "cacheRead", true);
  if (cacheRead !== null) totals.cacheRead = (totals.cacheRead ?? 0) + cacheRead;
  const cacheWrite = piNumber(usage.cacheWrite, "cacheWrite", true);
  if (cacheWrite !== null) totals.cacheWrite = (totals.cacheWrite ?? 0) + cacheWrite;
  const cost = piNumber(asRecord(usage.cost)?.total, "cost.total", false);
  if (cost !== null) {
    const nanos = Math.round(cost * NANOS_PER_USD);
    if (!Number.isSafeInteger(nanos) || !Number.isSafeInteger((totals.costNanoUsd ?? 0) + nanos)) {
      console.warn(JSON.stringify({ audit: "pi-usage", event: "field-dropped", field: "cost.total", value: String(cost) }));
    } else totals.costNanoUsd = (totals.costNanoUsd ?? 0) + nanos;
  }
};

const usagePayload = (totals: PiUsageTotals): Record<string, unknown> => ({
  messages: totals.messages,
  reported: totals.reported,
  ...(totals.input === null ? {} : { input: totals.input }),
  ...(totals.output === null ? {} : { output: totals.output }),
  ...(totals.cacheRead === null ? {} : { cacheRead: totals.cacheRead }),
  ...(totals.cacheWrite === null ? {} : { cacheWrite: totals.cacheWrite }),
  ...(totals.costNanoUsd === null ? {} : { costNanoUsd: totals.costNanoUsd }),
});

const usageGaps = (totals: PiUsageTotals): string[] => {
  if (totals.messages === 0) return ["PI settled without ending a single assistant message"];
  if (totals.reported === 0) return [`PI reported no usage on any of ${totals.messages} assistant message(s)`];
  const gaps: string[] = [];
  if (totals.reported < totals.messages) {
    gaps.push(`PI reported usage on only ${totals.reported} of ${totals.messages} assistant message(s)`);
  }
  const hasTokens = [totals.input, totals.output, totals.cacheRead, totals.cacheWrite]
    .some((value) => value !== null && value > 0);
  if (!hasTokens) gaps.push("PI reported no tokens");
  if ((totals.costNanoUsd ?? 0) === 0) gaps.push("PI reported no cost");
  return gaps;
};

export const parsePiEvent = (
  state: AdapterState,
  event: Record<string, unknown>,
  sink: SessionEventSink,
): void => {
  const provider = piState(state);
  const type = stringField(event, "type");
  if (type === "session") {
    state.providerConversationId = stringField(event, "id") ?? state.providerConversationId;
    // PI's session event closes the first prompt boundary. Later turns begin
    // at a completed tool call or a completed user message below.
    if (!state.turnRequestSeen) markTurnRequested(state);
    emitAdapterEvent(state, sink, "MODEL_STARTED", event);
  } else if (type === "tool_execution_start") {
    const toolId = stringField(event, "toolCallId") ?? "unknown";
    const now = new Date();
    state.inFlightTool = { id: toolId, name: stringField(event, "toolName") ?? "tool", startedAt: now, lastProgressAt: now };
    emitAdapterEvent(state, sink, "TOOL_STARTED", event, toolId);
  } else if (type === "tool_execution_update") {
    markInFlightToolProgress(state);
    emitAdapterEvent(state, sink, "TOOL_PROGRESS", event, stringField(event, "toolCallId"));
  } else if (type === "message_update") {
    // PI's message_update is the chunk already consumed for liveness. It is
    // intentionally filtered from persistence by providerEventPersistence.
    if (isPiMessageChunk(event)) markFirstChunk(state);
    emitAdapterEvent(state, sink, "MODEL_DELTA", event);
  } else if (type === "tool_execution_end") {
    // Stamp at provider-event arrival, before the completion sink can do
    // synchronous work that would distort the provider-boundary TTFT.
    markTurnRequested(state);
    state.inFlightTool = null;
    emitAdapterEvent(state, sink, "TOOL_COMPLETED", event, stringField(event, "toolCallId"));
  } else if (type === "turn_end" || type === "message_end") {
    provider.turnCompleted = true;
    const message = asRecord(event.message);
    if (message && stringField(message, "role") === "user") markTurnRequested(state);
    if (type === "message_end" && message && stringField(message, "role") === "assistant") {
      harvestUsage(provider.usage, message);
    }
    if (message && stringField(message, "role") === "assistant" && Array.isArray(message.content)) {
      const text = message.content
        .map((part) => stringField(asRecord(part) ?? {}, "text"))
        .filter((part): part is string => part !== null)
        .join("\n");
      if (text) state.finalOutput = text;
    }
    emitAdapterEvent(state, sink, "MODEL_COMPLETED", type === "message_end"
      && message !== null && stringField(message, "role") === "assistant"
      ? consumeTurnTtft(state, event)
      : event);
  } else if (type === "agent_end") {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const finalMessage = asRecord(messages.at(-1));
    const stopReason = stringField(finalMessage, "stopReason");
    const errorMessage = stringField(finalMessage, "errorMessage");
    provider.finalAttemptFailed = event.willRetry === true || stopReason === "error" || errorMessage !== null;
    state.providerError = provider.finalAttemptFailed
      ? errorMessage ?? (stopReason ? `PI stopped with ${stopReason}` : "PI provider retry failed")
      : null;
    emitAdapterEvent(state, sink, "PROVIDER_STATUS", event);
  } else if (type === "agent_settled") {
    state.terminalEventSeen = true;
    state.terminalSuccess = provider.turnCompleted && !provider.finalAttemptFailed && !state.sawError;
    const gaps = usageGaps(provider.usage);
    if (gaps.length > 0) {
      const reason = gaps.join("; ");
      console.warn(JSON.stringify({ audit: "pi-usage", event: "incomplete", runId: state.runId, reason }));
      emitAdapterEvent(state, sink, "ADAPTER_ERROR", { error: `Session cost is incomplete: ${reason}`, ...usagePayload(provider.usage) });
    }
    emitAdapterEvent(state, sink, "FINAL_OUTPUT", provider.usage.reported === 0
      ? event
      : { ...event, agentosPiUsage: usagePayload(provider.usage) });
  } else {
    if (type?.includes("error")) state.sawError = true;
    emitAdapterEvent(state, sink, type?.includes("message") ? "MODEL_DELTA" : "PROVIDER_STATUS", event);
  }
};

export const parsePiTranscript = (
  transcript: readonly unknown[],
  sink: SessionEventSink = () => undefined,
): AdapterState => {
  const state = createAdapterState("PI", "transcript", initialPiState());
  for (const value of transcript) {
    processProviderEvent(
      state,
      asRecord(value) ?? { value },
      sink,
      parsePiEvent,
      providerEventPersistence,
    );
  }
  return state;
};

const helpIsCompatible = (help: string): boolean => [
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-approve",
].every((flag) => help.includes(flag));

const preflight = async (spec: PreflightSpec): Promise<PreflightResult> => {
  const capabilities = { structuredEvents: true, resume: true, killProcessGroup: true, heartbeat: true, classifyError: true };
  if (spec.model === null || !spec.model.includes("/")) {
    return { ok: false, cliVersion: null, authMode: null, capabilities, error: PREFLIGHT_REASONS.unsupportedModel };
  }
  if (spec.model.startsWith("openai-codex/") && spec.env.AGENTOS_RUN_ID
    && spec.env.AGENTOS_CODEX_SERVICE_TIER !== "default" && spec.env.AGENTOS_CODEX_SERVICE_TIER !== "fast") {
    return {
      ok: false,
      cliVersion: null,
      authMode: null,
      capabilities,
      error: "PI openai-codex runs require an explicit Anneal Codex service tier",
    };
  }
  const version = await capturePreflight(spec.config, piDeclaration, ["--version"], spec.env);
  if (version.code !== 0) {
    return { ok: false, cliVersion: null, authMode: null, capabilities, error: preflightFailure(PREFLIGHT_REASONS.cliMissing, version.code) };
  }
  const help = await capturePreflight(spec.config, piDeclaration, ["--help"], spec.env);
  if (help.code !== 0 || !helpIsCompatible(`${help.stdout}\n${help.stderr}`)) {
    return {
      ok: false,
      cliVersion: version.stdout.trim() || version.stderr.trim(),
      authMode: null,
      capabilities,
      error: PREFLIGHT_REASONS.cliIncompatible,
    };
  }
  Object.assign(capabilities, { verifiedModel: spec.model, cliProtocol: "json-stdin-resume-isolated" });
  const provider = spec.model.split("/")[0] ?? "openai-codex";
  const auth = await capturePreflight(spec.config, piDeclaration, ["auth", "check", "--provider", provider], spec.env);
  const ok = auth.code === 0;
  return {
    ok,
    cliVersion: version.stdout.trim() || version.stderr.trim(),
    authMode: provider,
    capabilities,
    ...(!ok ? { error: preflightFailure(PREFLIGHT_REASONS.notAuthenticated, auth.code) } : {}),
  };
};

export const piChildEnvironment = (
  claim: Pick<ClaimedTask, "run">,
  scratch: AgentScratch,
): NodeJS.ProcessEnv => ({
  // PI's other global skill root is $HOME/.agents/skills, independent of
  // PI_CODING_AGENT_DIR. Keep it inside the session as well. Authentication is
  // copied into the explicit config root below, so relocating HOME preserves
  // the existing auth channel.
  HOME: scratch.configRoot,
  PI_CODING_AGENT_DIR: scratch.configRoot,
  ...(claim.run.model.startsWith("openai-codex/") ? {
    AGENTOS_CODEX_SERVICE_TIER: claim.run.codexServiceTier.toLowerCase(),
    AGENTOS_PI_EXPECTS_OPENAI_CODEX: "1",
  } : {}),
});

export const provisionPiSessionConfig = (
  config: RunnerConfig,
  scratch: AgentScratch,
  options: SessionConfigOptions = {},
): Promise<void> => provisionIsolatedSessionConfig(config, scratch, {
  label: "PI",
  authFile: join(config.home, ".pi", "agent", "auth.json"),
}, options);

const promptSections = (claim: ClaimedTask): string[] => {
  if (claim.run.subagentModel !== null || claim.run.subagentMaxConcurrent !== null) {
    throw new Error("Native implementation subagents require a Codex root Run");
  }
  return [];
};

export const piDeclaration: AdapterDeclaration = Object.freeze({
  runner: "PI",
  binaryEnvironment: "PI_BINARY",
  defaultBinary: "pi",
  toolIntroduction: "Anneal tools attached to this session (pi extension tools):",
  toolTransport: "pi-extension",
  toolEntrypoint: piExtensionPath,
  enforcedTools: PI_ENFORCED_TOOLS,
  isolatesSessionConfig: true,
  startupPreflightModel: "openai-codex/gpt-5.6-luna",
  // PI_CODING_AGENT_SESSION_DIR is real, but --session-dir is authoritative.
  // Deny task overrides without pretending the adapter depends on the variable.
  protectedEnvironmentVariables: [
    "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "AGENTOS_CODEX_SERVICE_TIER", "AGENTOS_PI_EXPECTS_OPENAI_CODEX",
  ],
  launcherEnvironmentVariables: ["PI_CODING_AGENT_DIR", "AGENTOS_CODEX_SERVICE_TIER", "AGENTOS_PI_EXPECTS_OPENAI_CODEX"],
  providerEventPersistence,
  promptSections,
  args: piArgs,
  childEnvironment: piChildEnvironment,
  provisionSessionConfig: provisionPiSessionConfig,
  initialProviderState: initialPiState,
  parseEvent: parsePiEvent,
  preflight,
});
