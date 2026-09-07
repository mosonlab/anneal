import type { Prisma, RunnerKind, RunStatus, SessionExecutionStatus } from "@anneal/db";
import { RUN_STATUS_IS_ACTIVE } from "@anneal/db/board-contract";
import type {
  RunBaseline,
  RunMetrics,
  RunPhase,
  RunPhaseMetrics,
  RunTerminationMetrics,
  RunTtftMetrics,
  RunTokenMetrics,
  RunToolMetrics,
  RunToolNameMetrics,
} from "@anneal/db/board-contract";

import { inputTokenSplit } from "./costs.js";
import { vsBaseline } from "./run-baseline.js";

/**
 * Per-run diagnostics: where a run's wall clock went, how its tokens split,
 * how its tools behaved, and how it terminated.
 *
 * Pure and read-time only. Nothing computed here is persisted, and this module
 * reads no database of its own — the route hands it rows. `null` always means
 * *unknown*; it is never a stand-in for zero, and no caller may render it as
 * one. No payload field is assumed to exist: an unexpected shape produces
 * `unclassified` or `null` and never throws.
 *
 * TOOL PAYLOAD SHAPES. The runner adapters persist provider payloads verbatim
 * (packages/runner/src/adapters/{claude,codex,pi}.ts), so the outcome markers
 * below are the providers' own field names, verified against the fixtures in
 * that package and in the console's stream normalizer:
 *
 *   CLAUDE  TOOL_STARTED   is the `tool_use` content part: `{ type:
 *           "tool_use", id, name }` — `name` is the only place a Claude tool
 *           name appears. TOOL_COMPLETED is the `tool_result` part:
 *           `{ type: "tool_result", tool_use_id, content, is_error }`.
 *           `is_error === true` is a failure, `false` a success, absent is
 *           unclassified (apps/web/src/tests/session-stream.test.tsx).
 *   CODEX   Both events carry the `command_execution` item itself:
 *           `{ id, type: "command_execution", status, exit_code }`, with an
 *           optional item-level `error`. An item-level `error` or a non-zero
 *           numeric `exit_code` is a failure; `exit_code === 0` is a success.
 *           Status alone cannot classify an outcome
 *           (packages/runner/src/adapters.test.ts). Codex reports no tool name
 *           beyond the item type.
 *   PI      TOOL_STARTED is `{ type: "tool_execution_start", toolCallId,
 *           toolName }` and TOOL_COMPLETED `{ type: "tool_execution_end",
 *           toolCallId, toolName, isError }` — camelCase, unlike Claude's
 *           `is_error` (packages/runner/src/adapters/pi.ts and
 *           apps/web/src/lib/session-stream.ts).
 *
 * Anything else — a payload that is null, a number, a string, an array, or a
 * record whose marker is missing or of the wrong type — is `unclassified`.
 */

/** The Run columns the phase rule needs. `readyAt` is when the run became
 *  eligible to be claimed, which is where the queued phase starts; `status` and
 *  `endedAt` are what settle a run whose session stopped short of a milestone. */
export type RunPhaseRun = {
  readyAt: Date;
  status: RunStatus;
  endedAt: Date | null;
};

/** The Session columns the phase rule needs. Stated apart from the full metrics
 *  input so the board's projection selects six timestamps rather than every
 *  token and cost column the diagnostics read. */
export type RunPhaseSession = {
  /** Creation of the exact question referenced by Session.waitingOnMessageId. */
  inboxWaitStartedAt?: Date | null;
  executionStatus: SessionExecutionStatus;
  provisionedAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  cleanupStartedAt: Date | null;
  cleanupEndedAt: Date | null;
};

/** The Run columns the metrics need. */
export type RunMetricsRun = RunPhaseRun;

/** The Session columns the metrics need. */
export type RunMetricsSession = RunPhaseSession & {
  runner: RunnerKind;
  resumeAttempt: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  outputTokens: number | null;
  terminationReason: string | null;
  exitCode: number | null;
  signal: string | null;
  /** The provider-captured amount, which is the same raw column the baseline
   *  percentiles are computed over. Null is *unreported*, never zero. */
  costUsd: Prisma.Decimal | string | null;
};

/** One TOOL_STARTED or TOOL_COMPLETED row. The route projects provider names
 *  and outcome markers into `payload`; fixtures may supply the stored value.
 *  It remains `unknown` and every access through it is guarded. */
export type RunMetricsToolEvent = {
  type: string;
  at: Date;
  toolCallId: string | null;
  payload: unknown;
};

/** A persisted model-completion row carrying the adapter's in-memory TTFT
 * measurement. The route filters provider completion rows before handing them
 * here and selects only the `anneal.ttftMs` field. */
export type RunMetricsTtftEvent = {
  type: string;
  payload: unknown;
};

export const TOOL_METRIC_EVENT_TYPES = ["TOOL_STARTED", "TOOL_COMPLETED"] as const;

/** Normalized event types that can carry a provider completion payload. The
 * adapter-specific completion marker is in the payload; the adapter adds the
 * `anneal.ttftMs` field only to that completion row. */
export const TTFT_METRIC_EVENT_TYPES = ["MODEL_DELTA", "MODEL_COMPLETED"] as const;

/** How many tool names the `byName` breakdown keeps. */
const TOP_TOOL_NAMES = 5;

/** A tool call whose name the payload did not report. */
const UNKNOWN_TOOL_NAME = "unknown";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const stringField = (record: Record<string, unknown>, key: string): string | null =>
  typeof record[key] === "string" && record[key].length > 0 ? record[key] : null;

const finiteNumberField = (record: Record<string, unknown>, key: string): number | null =>
  typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : null;

/** Elapsed milliseconds, or null when either bound is missing. Clock skew is
 *  clamped at 0 rather than published as a negative duration. */
const elapsed = (from: Date | null | undefined, to: Date | null | undefined): number | null =>
  from == null || to == null ? null : Math.max(0, to.getTime() - from.getTime());

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** The stored data marks *that* a session waited on the Inbox — the same
 *  signal the console's "includes Inbox wait" label reads — without recording
 *  all historical resume boundaries. So the wait is 0 only when the session
 *  demonstrably never waited, and otherwise unknown: reporting a bound this
 *  data cannot support would be worse than reporting nothing. */
const inboxWaitMs = (session: RunMetricsSession | null): number | null => {
  if (session === null) return null;
  return session.executionStatus === "WAITING_INBOX" || session.resumeAttempt > 0 ? null : 0;
};

/** Where a run is right now, and when it got there.
 *
 *  One helper for two readers. The board card names the phase and counts the
 *  time spent in it; the detail page measures the durations between the same
 *  boundaries. Stating the boundaries twice is how a card that says
 *  "provisioning" ends up beside a diagnostics table that gave provisioning a
 *  duration and moved on.
 *
 *  The board resolves the current question's creation time before calling this
 *  helper. A missing question leaves its wait start unknown; historical total
 *  Inbox wait remains unknown because resume boundaries are not recorded. */
export type RunPhaseState = { phase: RunPhase; phaseSince: Date | null };

export const runPhase = (
  run: RunPhaseRun,
  session: RunPhaseSession | null,
): RunPhaseState => {
  // No current writer stamps cleanupStartedAt; this branch supports recorded
  // milestones but is currently unreachable in normal runner execution.
  // Cleanup outranks the run's own terminality. The control plane settles a
  // run's status while the owning runner is still disposing of its workspace,
  // and "finished" over a workspace still being torn down answers the wrong
  // question.
  if (session?.cleanupStartedAt != null && session.cleanupEndedAt == null) {
    return { phase: "cleanup", phaseSince: session.cleanupStartedAt };
  }
  if (session?.cleanupEndedAt != null) return { phase: "finished", phaseSince: session.cleanupEndedAt };
  if (session?.endedAt != null) return { phase: "finished", phaseSince: session.endedAt };
  if (!RUN_STATUS_IS_ACTIVE[run.status]) {
    // A settled run is finished whatever milestone its session last reached: a
    // FAILED run whose session never started is not still provisioning, and a
    // card counting time in a phase nothing will ever leave is a clock that
    // never stops. The instant is the most recent one the rows can prove.
    return {
      phase: "finished",
      phaseSince: run.endedAt ?? session?.startedAt ?? session?.provisionedAt ?? run.readyAt,
    };
  }
  if (session?.startedAt != null) {
    // Suspension writes both sides in one transaction, so either alone is
    // enough to say the run is waiting rather than working — and reading only
    // one would let the card's status pill and its phase disagree.
    return session.executionStatus === "WAITING_INBOX" || run.status === "WAITING_INBOX"
      ? { phase: "waiting-inbox", phaseSince: session.inboxWaitStartedAt ?? null }
      : { phase: "executing", phaseSince: session.startedAt };
  }
  if (session?.provisionedAt != null) return { phase: "provisioning", phaseSince: session.provisionedAt };
  return { phase: "queued", phaseSince: run.readyAt };
};

const phaseMetrics = (
  session: RunMetricsSession | null,
  now: Date,
  phase: RunPhase,
  readyAt: Date,
): RunPhaseMetrics => ({
  queuedMs: elapsed(readyAt, session?.provisionedAt),
  provisioningMs: elapsed(session?.provisionedAt, session?.startedAt),
  // A live run has no `endedAt` yet; its executing phase is measured to now so
  // the diagnostics of a running session are not a blank row. Which runs are
  // still in that phase is `runPhase`'s answer, not a second reading of the
  // session's status.
  executingMs: session === null ? null : elapsed(session.startedAt, session.endedAt ?? (
    phase === "executing" || phase === "waiting-inbox" ? now : null
  )),
  inboxWaitMs: inboxWaitMs(session),
  cleanupMs: elapsed(session?.cleanupStartedAt, session?.cleanupEndedAt),
});

const tokenMetrics = (session: RunMetricsSession | null): RunTokenMetrics => {
  // The canonical split rule lives in costs.ts and is imported rather than
  // restated: an operator's diagnostics and the spend report must not be able
  // to disagree about what "cached" means.
  const split = session === null ? null : inputTokenSplit(session);
  return {
    input: session?.inputTokens ?? null,
    cachedRead: session?.cachedInputTokens ?? null,
    cacheWrite: session?.cacheCreationInputTokens ?? null,
    uncachedInput: split === null ? null : split.uncachedInputTokens,
    output: session?.outputTokens ?? null,
    // A zero input total has no ratio to report; that is unknown, not 0%.
    cacheHitRatio: split === null || split.inputTokens === 0
      ? null
      : round(split.cachedInputTokens / split.inputTokens, 4),
  };
};

/** PostgreSQL's percentile_cont interpolation over a small in-memory sample.
 * TTFT samples are whole milliseconds, but a percentile between two samples
 * can be fractional, so the continuous value is retained. */
const percentile = (values: readonly number[], fraction: number): number => {
  const ordered = [...values].sort((left, right) => left - right);
  const rank = (ordered.length - 1) * fraction;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return ordered[lower]!;
  const weight = rank - lower;
  return ordered[lower]! + (ordered[upper]! - ordered[lower]!) * weight;
};

const ttftValue = (payload: unknown): number | null => {
  const record = asRecord(payload);
  const anneal = asRecord(record?.anneal);
  const value = anneal === null ? null : finiteNumberField(anneal, "ttftMs");
  return value === null || value < 0 ? null : value;
};

const ttftMetrics = (events: readonly RunMetricsTtftEvent[]): RunTtftMetrics | null => {
  const values = events
    .map((event) => ttftValue(event.payload))
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return {
    p50Ms: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    samples: values.length,
  };
};

/** Whether a TOOL_COMPLETED payload reports success, failure, or nothing this
 *  module is willing to read as either. */
type ToolOutcome = "ok" | "failed" | "unclassified";

const claudeOutcome = (payload: Record<string, unknown>): ToolOutcome => {
  if (payload.type !== "tool_result") return "unclassified";
  if (payload.is_error === true) return "failed";
  return payload.is_error === false ? "ok" : "unclassified";
};

const codexOutcome = (payload: Record<string, unknown>): ToolOutcome => {
  if (payload.type !== "command_execution") return "unclassified";
  if (payload.error !== undefined && payload.error !== null) return "failed";
  if (typeof payload.exit_code === "number" && Number.isFinite(payload.exit_code)) {
    return payload.exit_code === 0 ? "ok" : "failed";
  }
  return "unclassified";
};

const piOutcome = (payload: Record<string, unknown>): ToolOutcome => {
  if (payload.type !== "tool_execution_end") return "unclassified";
  if (payload.isError === true) return "failed";
  return payload.isError === false ? "ok" : "unclassified";
};

const toolOutcome = (runner: RunnerKind | null, payload: unknown): ToolOutcome => {
  const record = asRecord(payload);
  if (record === null || runner === null) return "unclassified";
  if (runner === "CLAUDE") return claudeOutcome(record);
  if (runner === "CODEX") return codexOutcome(record);
  if (runner === "PI") return piOutcome(record);
  return "unclassified";
};

const toolName = (runner: RunnerKind | null, payload: unknown): string | null => {
  const record = asRecord(payload);
  if (record === null || runner === null) return null;
  if (runner === "CLAUDE") return stringField(record, "name");
  if (runner === "PI") return stringField(record, "toolName");
  // Codex names no tool: every tool event it emits is a `command_execution`
  // item, and the item type is the only name available.
  return runner === "CODEX" ? stringField(record, "type") : null;
};

type OpenCall = { name: string; startedAt: Date };

type ToolCall = { interval: readonly [number, number] | null; name: string; durationMs: number | null; outcome: ToolOutcome | "unpaired" };

/** Pair TOOL_STARTED with TOOL_COMPLETED by `toolCallId`. Adapters fall back to
 *  a literal "unknown" id, so a repeated id is matched first-in-first-out
 *  rather than assumed unique. A completion with no open start is still a call
 *  the run made; its duration is simply unknown. */
const pairCalls = (
  runner: RunnerKind | null,
  toolEvents: readonly RunMetricsToolEvent[],
): ToolCall[] => {
  const open = new Map<string, OpenCall[]>();
  const calls: ToolCall[] = [];
  const ordered = [...toolEvents].sort((left, right) => left.at.getTime() - right.at.getTime());
  for (const event of ordered) {
    const key = event.toolCallId;
    if (key === null) {
      calls.push({
        name: toolName(runner, event.payload) ?? UNKNOWN_TOOL_NAME,
        interval: null,
        durationMs: null,
        outcome: event.type === "TOOL_COMPLETED" ? toolOutcome(runner, event.payload) : "unpaired",
      });
      continue;
    }
    if (event.type === "TOOL_STARTED") {
      const queue = open.get(key) ?? [];
      queue.push({ name: toolName(runner, event.payload) ?? UNKNOWN_TOOL_NAME, startedAt: event.at });
      open.set(key, queue);
    } else if (event.type === "TOOL_COMPLETED") {
      const queue = open.get(key);
      const start = queue?.shift() ?? null;
      calls.push({
        name: start?.name ?? toolName(runner, event.payload) ?? UNKNOWN_TOOL_NAME,
        interval: start === null ? null : [start.startedAt.getTime(), event.at.getTime()],
        durationMs: start === null ? null : Math.max(0, event.at.getTime() - start.startedAt.getTime()),
        outcome: toolOutcome(runner, event.payload),
      });
    }
  }
  // Whatever is still open never completed: a call the run made whose duration
  // and outcome the stored events cannot settle.
  for (const queue of open.values()) {
    for (const start of queue) calls.push({ name: start.name, interval: null, durationMs: null, outcome: "unpaired" });
  }
  return calls;
};

const byName = (calls: readonly ToolCall[]): RunToolNameMetrics[] => {
  const totals = new Map<string, RunToolNameMetrics>();
  for (const call of calls) {
    const entry = totals.get(call.name) ?? { name: call.name, calls: 0, failed: 0 };
    entry.calls += 1;
    if (call.outcome === "failed") entry.failed += 1;
    totals.set(call.name, entry);
  }
  return [...totals.values()]
    // Name breaks the tie so the same events always produce the same order.
    .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name))
    .slice(0, TOP_TOOL_NAMES);
};

/** Parallel calls share wall time. Count their merged intervals only once. */
const toolWallMs = (calls: readonly ToolCall[]): number => {
  const intervals = calls.flatMap((call) => call.interval ? [call.interval] : [])
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let end = -Infinity;
  for (const [start, stop] of intervals) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
};

const toolMetrics = (
  runner: RunnerKind | null,
  toolEvents: readonly RunMetricsToolEvent[],
): RunToolMetrics & { unpairedCalls: number } => {
  const calls = pairCalls(runner, toolEvents);
  return {
    calls: calls.length,
    failed: calls.filter((call) => call.outcome === "failed").length,
    unclassified: calls.filter((call) => call.outcome === "unclassified").length,
    totalToolMs: toolWallMs(calls),
    unpairedCalls: calls.filter((call) => call.durationMs === null).length,
    byName: byName(calls),
  };
};

const terminationMetrics = (session: RunMetricsSession | null): RunTerminationMetrics => ({
  reason: session?.terminationReason ?? null,
  exitCode: session?.exitCode ?? null,
  signal: session?.signal ?? null,
});

/** The reported cost as a number, or null when nothing was reported. A stored
 *  value that will not parse is unknown rather than 0. */
const reportedCost = (session: RunMetricsSession | null): number | null => {
  if (session?.costUsd == null) return null;
  const value = Number(session.costUsd);
  return Number.isFinite(value) ? value : null;
};

/** Compute one run's diagnostics. `now` is injectable so a live run's
 *  executing phase is deterministic under test. `baseline` is the run's own
 *  template step baseline, or null when the task has no step or too little
 *  history. */
export const runMetrics = (input: {
  run: RunMetricsRun;
  session: RunMetricsSession | null;
  toolEvents: readonly RunMetricsToolEvent[];
  ttftEvents: readonly RunMetricsTtftEvent[];
  baseline?: RunBaseline | null;
  now?: Date;
}): RunMetrics => {
  const { run, session } = input;
  const phases = phaseMetrics(session, input.now ?? new Date(), runPhase(run, session).phase, run.readyAt);
  const tokens = tokenMetrics(session);
  const { unpairedCalls, ...tools } = toolMetrics(session?.runner ?? null, input.toolEvents);
  // Model-active time is what is left of the executing phase once the tools
  // and the Inbox had their turn. An unknown subtrahend is subtracted as 0,
  // which can only overstate the remainder — hence the upper-bound flag, which
  // also covers a tool call whose duration the events never closed.
  const modelActiveIsUpperBound = phases.inboxWaitMs === null || unpairedCalls > 0;
  const modelActiveMs = phases.executingMs === null
    ? null
    : Math.max(0, phases.executingMs - tools.totalToolMs - (phases.inboxWaitMs ?? 0));
  return {
    phases,
    tokens,
    tools,
    modelActiveMs,
    modelActiveIsUpperBound,
    // An effective session-average rate over model-active time, not a provider
    // peak rate: it divides all reported output tokens by the wall clock that
    // was not tools or Inbox wait.
    outputTokensPerSecond: tokens.output === null || modelActiveMs === null || modelActiveMs === 0
      ? null
      : round(tokens.output / (modelActiveMs / 1_000), 2),
    ttft: ttftMetrics(input.ttftEvents),
    termination: terminationMetrics(session),
    // Measured against the same executing phase published above, so the
    // comparison and the figure it compares can never disagree. A session that
    // has not ended has no comparable duration: its executing phase is measured
    // to now, while every baseline sample is a completed run, so the ratio
    // would report "not finished yet" as "faster than usual". Null instead.
    vsBaseline: vsBaseline(input.baseline ?? null, {
      costUsd: reportedCost(session),
      durationMs: session?.endedAt == null ? null : phases.executingMs,
    }),
  };
};
