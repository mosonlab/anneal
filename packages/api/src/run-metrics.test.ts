import assert from "node:assert/strict";
import test from "node:test";

import type { RunnerKind, RunStatus } from "@anneal/db";
import type { RunBaseline } from "@anneal/db/board-contract";

import {
  runMetrics,
  runPhase,
  type RunMetricsSession,
  type RunMetricsToolEvent,
  type RunMetricsTtftEvent,
} from "./run-metrics.js";

const READY = new Date("2026-09-01T10:00:00.000Z");
const PROVISIONED = new Date("2026-09-01T10:00:05.000Z");
const STARTED = new Date("2026-09-01T10:00:20.000Z");
const ENDED = new Date("2026-09-01T10:02:00.000Z");
const CLEANUP_STARTED = new Date("2026-09-01T10:02:01.000Z");
const CLEANUP_ENDED = new Date("2026-09-01T10:02:04.000Z");

const session = (overrides: Partial<RunMetricsSession> = {}): RunMetricsSession => ({
  runner: "CLAUDE",
  costUsd: null,
  executionStatus: "SUCCEEDED",
  resumeAttempt: 0,
  provisionedAt: PROVISIONED,
  startedAt: STARTED,
  endedAt: ENDED,
  cleanupStartedAt: CLEANUP_STARTED,
  cleanupEndedAt: CLEANUP_ENDED,
  inputTokens: null,
  cachedInputTokens: null,
  cacheCreationInputTokens: null,
  outputTokens: null,
  terminationReason: null,
  exitCode: null,
  signal: null,
  ...overrides,
});

const at = (offsetMs: number): Date => new Date(STARTED.getTime() + offsetMs);

const started = (toolCallId: string | null, offsetMs: number, payload: unknown): RunMetricsToolEvent =>
  ({ type: "TOOL_STARTED", at: at(offsetMs), toolCallId, payload });

const completed = (toolCallId: string | null, offsetMs: number, payload: unknown): RunMetricsToolEvent =>
  ({ type: "TOOL_COMPLETED", at: at(offsetMs), toolCallId, payload });

const ttftEvent = (ttftMs: unknown): RunMetricsTtftEvent => ({
  type: "MODEL_COMPLETED",
  payload: { anneal: { ttftMs } },
});

const metricsOf = (input: {
  session?: RunMetricsSession | null;
  toolEvents?: readonly RunMetricsToolEvent[];
  ttftEvents?: readonly RunMetricsTtftEvent[];
  readyAt?: Date;
  runStatus?: RunStatus;
  runEndedAt?: Date | null;
  now?: Date;
  baseline?: RunBaseline | null;
} = {}) => runMetrics({
  // A settled run by default, because the fixture session below is a settled
  // one: the run row and its session have to describe the same run for the
  // phase they share to mean anything.
  run: {
    readyAt: input.readyAt ?? READY,
    status: input.runStatus ?? "SUCCEEDED",
    endedAt: input.runEndedAt === undefined ? ENDED : input.runEndedAt,
  },
  session: input.session === undefined ? session() : input.session,
  toolEvents: input.toolEvents ?? [],
  ttftEvents: input.ttftEvents ?? [],
  now: input.now ?? new Date(ENDED.getTime() + 60_000),
  baseline: input.baseline ?? null,
});

const baseline = (): RunBaseline => ({
  sampleSize: 6,
  costUsd: { sampleSize: 6, p50: 2, p90: 4 },
  durationMs: { sampleSize: 6, p50: 200_000, p90: 400_000 },
});

/* --------------------------------------------------------------- phases */

test("phases carry the millisecond split of a settled run", () => {
  const { phases } = metricsOf();
  assert.deepEqual(phases, {
    queuedMs: 5_000,
    provisioningMs: 15_000,
    executingMs: 100_000,
    inboxWaitMs: 0,
    cleanupMs: 3_000,
  });
});

test("each phase is null when either bounding timestamp is missing", () => {
  const noProvision = metricsOf({ session: session({ provisionedAt: null }) });
  assert.equal(noProvision.phases.queuedMs, null);
  assert.equal(noProvision.phases.provisioningMs, null);

  const noEnd = metricsOf({ session: session({ endedAt: null }) });
  assert.equal(noEnd.phases.executingMs, null);

  const noStart = metricsOf({ session: session({ startedAt: null }) });
  assert.equal(noStart.phases.provisioningMs, null);
  assert.equal(noStart.phases.executingMs, null);

  const noCleanupEnd = metricsOf({ session: session({ cleanupEndedAt: null }) });
  assert.equal(noCleanupEnd.phases.cleanupMs, null);

  const noCleanupStart = metricsOf({ session: session({ cleanupStartedAt: null }) });
  assert.equal(noCleanupStart.phases.cleanupMs, null);

  const noSession = metricsOf({ session: null });
  assert.deepEqual(noSession.phases, {
    queuedMs: null, provisioningMs: null, executingMs: null, inboxWaitMs: null, cleanupMs: null,
  });
});

test("the phase a run is named by is the phase its executing clock is measured to", () => {
  // One helper, two readers: the board card names the phase and the
  // diagnostics measure the durations between the same boundaries. A run whose
  // phase is `executing` is exactly the run whose executingMs is still growing.
  const live = session({
    executionStatus: "RUNNING", endedAt: null, cleanupStartedAt: null, cleanupEndedAt: null,
  });
  const liveRun = { readyAt: READY, status: "RUNNING" as RunStatus, endedAt: null };
  assert.deepEqual(runPhase(liveRun, live), { phase: "executing", phaseSince: STARTED });
  assert.equal(
    runMetrics({ run: liveRun, session: live, toolEvents: [], ttftEvents: [], now: new Date(STARTED.getTime() + 42_000) }).phases.executingMs,
    42_000,
  );

  // And a settled run's executing phase is closed, whatever its session status
  // column happens to say.
  const settledRun = { readyAt: READY, status: "SUCCEEDED" as RunStatus, endedAt: ENDED };
  assert.equal(runPhase(settledRun, session()).phase, "finished");
  assert.equal(metricsOf().phases.executingMs, 100_000);
});

test("the shared phase helper uses the current question timestamp for an Inbox wait", () => {
  const waiting = session({ executionStatus: "WAITING_INBOX", endedAt: null,
    cleanupStartedAt: null, cleanupEndedAt: null, inboxWaitStartedAt: at(30_000) });
  const run = { readyAt: READY, status: "WAITING_INBOX" as const, endedAt: null };
  assert.deepEqual(runPhase(run, waiting), { phase: "waiting-inbox", phaseSince: at(30_000) });
  assert.deepEqual(runPhase(run, { ...waiting, inboxWaitStartedAt: null }), { phase: "waiting-inbox", phaseSince: null });
});

test("a live run measures executingMs to now and leaves cleanup unknown", () => {
  const now = new Date(STARTED.getTime() + 42_000);
  const live = metricsOf({
    session: session({
      executionStatus: "RUNNING", endedAt: null, cleanupStartedAt: null, cleanupEndedAt: null,
    }),
    // The Run row of a live session is not terminal either: the phase is read
    // from both, so a fixture that settles one and not the other is not a run.
    runStatus: "RUNNING", runEndedAt: null,
    now,
  });
  assert.equal(live.phases.executingMs, 42_000);
  assert.equal(live.phases.cleanupMs, null);
});

test("inbox wait is unknown — never zero — once the stored data says a wait happened", () => {
  assert.equal(metricsOf({ session: session({ executionStatus: "WAITING_INBOX" }) }).phases.inboxWaitMs, null);
  assert.equal(metricsOf({ session: session({ resumeAttempt: 2 }) }).phases.inboxWaitMs, null);
  assert.equal(metricsOf().phases.inboxWaitMs, 0);
});

/* --------------------------------------------------------------- tokens */

test("tokens report the canonical split, its cache hit ratio and its uncached remainder", () => {
  const { tokens } = metricsOf({ session: session({
    inputTokens: 1_000, cachedInputTokens: 600, cacheCreationInputTokens: 150, outputTokens: 400,
  }) });
  assert.deepEqual(tokens, {
    input: 1_000, cachedRead: 600, cacheWrite: 150, uncachedInput: 250, output: 400, cacheHitRatio: 0.6,
  });
});

test("an inconsistent split leaves uncachedInput and cacheHitRatio unknown while the raw columns survive", () => {
  const { tokens } = metricsOf({ session: session({
    inputTokens: 100, cachedInputTokens: 90, cacheCreationInputTokens: 50, outputTokens: 10,
  }) });
  assert.equal(tokens.input, 100);
  assert.equal(tokens.cachedRead, 90);
  assert.equal(tokens.cacheWrite, 50);
  assert.equal(tokens.uncachedInput, null);
  assert.equal(tokens.cacheHitRatio, null);
});

test("a missing split component leaves the derived fields unknown", () => {
  const { tokens } = metricsOf({ session: session({
    inputTokens: 100, cachedInputTokens: null, cacheCreationInputTokens: 10, outputTokens: 10,
  }) });
  assert.equal(tokens.cachedRead, null);
  assert.equal(tokens.uncachedInput, null);
  assert.equal(tokens.cacheHitRatio, null);
});

test("a zero input total yields no cache hit ratio rather than a division by zero", () => {
  const { tokens } = metricsOf({ session: session({
    inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0,
  }) });
  assert.equal(tokens.uncachedInput, 0);
  assert.equal(tokens.cacheHitRatio, null);
});

/* ---------------------------------------------------------------- tools */

const CLAUDE_TOOLS: readonly RunMetricsToolEvent[] = [
  started("toolu_1", 1_000, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }),
  completed("toolu_1", 3_000, { type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }),
  started("toolu_2", 4_000, { type: "tool_use", id: "toolu_2", name: "Edit" }),
  completed("toolu_2", 9_000, { type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true }),
];

const CODEX_TOOLS: readonly RunMetricsToolEvent[] = [
  started("command-1", 1_000, { id: "command-1", type: "command_execution", command: "ls" }),
  completed("command-1", 3_000, { id: "command-1", type: "command_execution", status: "completed", exit_code: 0 }),
  started("command-2", 4_000, { id: "command-2", type: "command_execution", command: "false" }),
  completed("command-2", 9_000, { id: "command-2", type: "command_execution", status: "failed", exit_code: 1 }),
];

const PI_TOOLS: readonly RunMetricsToolEvent[] = [
  started("call_1", 1_000, { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash" }),
  completed("call_1", 3_000, { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false }),
  started("call_2", 4_000, { type: "tool_execution_start", toolCallId: "call_2", toolName: "edit" }),
  completed("call_2", 9_000, { type: "tool_execution_end", toolCallId: "call_2", toolName: "edit", isError: true }),
];

const runnerFixtures: ReadonlyArray<[RunnerKind, readonly RunMetricsToolEvent[], string[]]> = [
  ["CLAUDE", CLAUDE_TOOLS, ["Bash", "Edit"]],
  ["CODEX", CODEX_TOOLS, ["command_execution"]],
  ["PI", PI_TOOLS, ["bash", "edit"]],
];

for (const [runner, toolEvents, names] of runnerFixtures) {
  test(`${runner}: one successful and one failed tool call are counted, timed and named`, () => {
    const { tools } = metricsOf({ session: session({ runner }), toolEvents });
    assert.equal(tools.calls, 2);
    assert.equal(tools.failed, 1);
    assert.equal(tools.unclassified, 0);
    assert.equal(tools.totalToolMs, 7_000);
    assert.deepEqual(tools.byName.map((entry) => entry.name), names);
    assert.equal(tools.byName.reduce((sum, entry) => sum + entry.calls, 0), 2);
    assert.equal(tools.byName.reduce((sum, entry) => sum + entry.failed, 0), 1);
  });
}

test("Codex reports an item-level error as a failure even when the exit code says zero", () => {
  const { tools } = metricsOf({ session: session({ runner: "CODEX" }), toolEvents: [
    started("command-1", 1_000, { id: "command-1", type: "command_execution" }),
    completed("command-1", 2_000, {
      id: "command-1", type: "command_execution", exit_code: 0, error: { message: "aborted" },
    }),
  ] });
  assert.equal(tools.failed, 1);
  assert.equal(tools.unclassified, 0);
});

for (const [runner, payload] of [
  ["CLAUDE", { type: "tool_result", tool_use_id: "toolu_1" }],
  ["CODEX", { id: "command-1", type: "command_execution" }],
  ["PI", { type: "tool_execution_end", toolCallId: "call_1" }],
  ["CLAUDE", { type: "other", is_error: false }],
  ["CLAUDE", { is_error: true }],
  ["CLAUDE", { type: "tool_result", is_error: "false" }],
  ["CODEX", { type: "other", exit_code: 0 }],
  ["CODEX", { error: "wrong record" }],
  ["CODEX", { type: "command_execution", status: "completed" }],
  ["CODEX", { type: "command_execution", status: "failed" }],
  ["CODEX", { type: "command_execution", exit_code: "0" }],
  ["CODEX", { type: "command_execution", exit_code: Number.NaN }],
  ["PI", { type: "other", isError: false }],
  ["PI", { isError: true }],
  ["PI", { type: "tool_execution_end", isError: "true" }],
] as ReadonlyArray<[RunnerKind, unknown]>) {
  test(`${runner}: a completion with no readable outcome counts as unclassified, never as a success`, () => {
    const { tools } = metricsOf({ session: session({ runner }), toolEvents: [
      started("id-1", 1_000, { type: "tool_use", id: "id-1", name: "Bash", toolName: "bash" }),
      completed("id-1", 2_000, payload),
    ] });
    assert.equal(tools.calls, 1);
    assert.equal(tools.failed, 0);
    assert.equal(tools.unclassified, 1);
    assert.equal(tools.totalToolMs, 1_000);
  });
}

test("a payload of the wrong shape entirely is unclassified rather than thrown or counted as success", () => {
  for (const payload of [null, 42, "done", ["done"]]) {
    const { tools } = metricsOf({ toolEvents: [
      started("id-1", 1_000, { type: "tool_use", id: "id-1", name: "Bash" }),
      completed("id-1", 2_000, payload),
    ] });
    assert.equal(tools.unclassified, 1, `payload ${JSON.stringify(payload)}`);
    assert.equal(tools.failed, 0);
  }
});

test("an unpaired start is a call with unknown duration, and an unpaired completion is still a call", () => {
  const { tools } = metricsOf({ toolEvents: [
    started("toolu_1", 1_000, { type: "tool_use", id: "toolu_1", name: "Bash" }),
    started("toolu_2", 2_000, { type: "tool_use", id: "toolu_2", name: "Read" }),
    completed("toolu_2", 6_000, { type: "tool_result", tool_use_id: "toolu_2", is_error: false }),
    completed("toolu_9", 7_000, { type: "tool_result", tool_use_id: "toolu_9", is_error: true }),
  ] });
  assert.equal(tools.calls, 3);
  assert.equal(tools.unclassified, 0);
  assert.equal(tools.failed, 1);
  assert.equal(tools.totalToolMs, 4_000);
});

test("byName keeps the five busiest tools, most calls first", () => {
  const events: RunMetricsToolEvent[] = [];
  const plan: ReadonlyArray<[string, number]> = [["a", 6], ["b", 5], ["c", 4], ["d", 3], ["e", 2], ["f", 1]];
  let seq = 0;
  for (const [name, calls] of plan) {
    for (let index = 0; index < calls; index += 1) {
      seq += 1;
      events.push(started(`${name}-${index}`, seq * 10, { type: "tool_use", id: `${name}-${index}`, name }));
      events.push(completed(`${name}-${index}`, seq * 10 + 5, {
        type: "tool_result", tool_use_id: `${name}-${index}`, is_error: false,
      }));
    }
  }
  const { tools } = metricsOf({ toolEvents: events });
  assert.equal(tools.calls, 21);
  assert.deepEqual(tools.byName, [
    { name: "a", calls: 6, failed: 0 },
    { name: "b", calls: 5, failed: 0 },
    { name: "c", calls: 4, failed: 0 },
    { name: "d", calls: 3, failed: 0 },
    { name: "e", calls: 2, failed: 0 },
  ]);
});

/* ------------------------------------------------- model-active and rate */

test("model-active time is executing time less tool time and inbox wait", () => {
  const metrics = metricsOf({
    session: session({ outputTokens: 1_000 }),
    toolEvents: CLAUDE_TOOLS,
  });
  assert.equal(metrics.phases.executingMs, 100_000);
  assert.equal(metrics.tools.totalToolMs, 7_000);
  assert.equal(metrics.modelActiveMs, 93_000);
  assert.equal(metrics.modelActiveIsUpperBound, false);
  assert.equal(metrics.outputTokensPerSecond, 10.75);
});

test("an unmeasurable inbox wait makes model-active time an upper bound rather than a measurement", () => {
  const metrics = metricsOf({ session: session({ resumeAttempt: 1, outputTokens: 1_000 }) });
  assert.equal(metrics.phases.inboxWaitMs, null);
  assert.equal(metrics.modelActiveMs, 100_000);
  assert.equal(metrics.modelActiveIsUpperBound, true);
});

test("an unpaired tool call also makes model-active time an upper bound", () => {
  const metrics = metricsOf({ toolEvents: [started("toolu_1", 1_000, { type: "tool_use", id: "toolu_1", name: "Bash" })] });
  assert.equal(metrics.modelActiveIsUpperBound, true);
});

test("model-active time is unknown when the run has no measured executing phase", () => {
  const metrics = metricsOf({ session: session({ startedAt: null, outputTokens: 100 }) });
  assert.equal(metrics.modelActiveMs, null);
  assert.equal(metrics.outputTokensPerSecond, null);
});

test("model-active time is clamped at zero and yields no rate", () => {
  const metrics = metricsOf({
    session: session({ endedAt: new Date(STARTED.getTime() + 2_000), outputTokens: 500 }),
    toolEvents: CLAUDE_TOOLS,
  });
  assert.equal(metrics.modelActiveMs, 0);
  assert.equal(metrics.outputTokensPerSecond, null);
});

test("the rate is unknown when output tokens were never reported", () => {
  assert.equal(metricsOf({ session: session({ outputTokens: null }) }).outputTokensPerSecond, null);
});

/* ----------------------------------------------------------- termination */

test("termination reports the session's own account of how the run ended", () => {
  const metrics = metricsOf({ session: session({
    terminationReason: "provider exited", exitCode: 137, signal: "SIGKILL",
  }) });
  assert.deepEqual(metrics.termination, { reason: "provider exited", exitCode: 137, signal: "SIGKILL" });
  assert.deepEqual(metricsOf({ session: null }).termination, { reason: null, exitCode: null, signal: null });
});

test("anonymous starts and completions cannot establish a pairing", () => {
  const metrics = metricsOf({ toolEvents: [
    started(null, 1_000, { type: "tool_use", name: "Bash" }),
    started(null, 2_000, { type: "tool_use", name: "Read" }),
    completed(null, 3_000, { type: "tool_result", is_error: false }),
    completed(null, 4_000, { type: "tool_result", is_error: true }),
  ] });
  assert.equal(metrics.tools.calls, 4);
  assert.equal(metrics.tools.totalToolMs, 0);
  assert.equal(metrics.tools.failed, 1);
  assert.equal(metrics.modelActiveIsUpperBound, true);
});

test("overlapping tool calls consume their union of wall time", () => {
  const metrics = metricsOf({ session: session({ outputTokens: 8_000 }), toolEvents: [
    started("a", 10_000, { type: "tool_use", name: "Bash" }),
    started("b", 20_000, { type: "tool_use", name: "Bash" }),
    completed("a", 30_000, { type: "tool_result", is_error: false }),
    completed("b", 40_000, { type: "tool_result", is_error: false }),
  ] });
  assert.equal(metrics.tools.calls, 2);
  assert.equal(metrics.tools.totalToolMs, 30_000);
  assert.equal(metrics.modelActiveMs, 70_000);
  assert.equal(metrics.outputTokensPerSecond, 114.29);
  assert.equal(metrics.modelActiveIsUpperBound, false);
});

test("the public tools shape contains only the specified counters and breakdown", () => {
  assert.deepEqual(Object.keys(metricsOf().tools).sort(), ["byName", "calls", "failed", "totalToolMs", "unclassified"]);
});

/* --------------------------------------------------------------- TTFT */

test("TTFT reports continuous p50 and p90 over persisted completion measurements", () => {
  const metrics = metricsOf({ ttftEvents: [ttftEvent(10), ttftEvent(20), ttftEvent(30), ttftEvent(40)] });
  assert.deepEqual(metrics.ttft, { p50Ms: 25, p90Ms: 37, samples: 4 });
});

test("TTFT ignores malformed values and is null when no completion was measured", () => {
  assert.deepEqual(metricsOf({ ttftEvents: [ttftEvent(10), ttftEvent("20"), ttftEvent(-1), ttftEvent(Number.NaN)] }).ttft, {
    p50Ms: 10, p90Ms: 10, samples: 1,
  });
  assert.equal(metricsOf().ttft, null);
});

/* ----------------------------------------------------------- baseline */

test("a settled run is measured against its step baseline", () => {
  const metrics = metricsOf({ session: session({ costUsd: "1" }), baseline: baseline() });
  assert.deepEqual(metrics.vsBaseline, { costRatio: 0.5, durationRatio: 0.5 });
});

test("a live run has no durationRatio: its executing phase is still running", () => {
  const live = session({
    costUsd: "1", endedAt: null, executionStatus: "RUNNING", cleanupStartedAt: null, cleanupEndedAt: null,
  });
  const metrics = metricsOf({
    session: live, runStatus: "RUNNING", runEndedAt: null,
    now: new Date(STARTED.getTime() + 20_000), baseline: baseline(),
  });
  assert.equal(metrics.phases.executingMs, 20_000);
  assert.deepEqual(metrics.vsBaseline, { costRatio: 0.5, durationRatio: null });
});
