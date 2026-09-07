import { replayTranscriptAt, type RecordedEvent, type TimedProviderEvent } from "./timed-transcript.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parsePiEvent, parsePiTranscript, providerEventPersistence } from "./pi.js";

const CAPTURE = new URL("../../../../spikes/cli-capabilities/samples/pi-openai-codex-gpt-5.6-luna-20260828T214948Z.jsonl", import.meta.url);

const replayPiAt = (transcript: readonly TimedProviderEvent[]): RecordedEvent[] =>
  replayTranscriptAt(parsePiTranscript([]), transcript, parsePiEvent, providerEventPersistence);

const CHUNK_TYPES = new Set(["message_update", "tool_execution_update"]);
const UNCLASSIFIED_PROVIDER_TYPE = Symbol("unclassified-provider-type");

const capturedTranscript = async (): Promise<unknown[]> => (await readFile(CAPTURE, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as unknown);

const providerTypeOf = (value: unknown): string | typeof UNCLASSIFIED_PROVIDER_TYPE => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return UNCLASSIFIED_PROVIDER_TYPE;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? type : UNCLASSIFIED_PROVIDER_TYPE;
};

const finalOutputOf = (events: RecordedEvent[]): Record<string, unknown> => {
  const final = events.filter((event) => event.type === "FINAL_OUTPUT");
  assert.equal(final.length, 1);
  return final[0]!.payload;
};

const preservedEventCounts = (events: RecordedEvent[]) => {
  const count = (type: string): number => events.filter((event) => event.type === type).length;
  return {
    MODEL_STARTED: count("MODEL_STARTED"),
    MODEL_DELTA: count("MODEL_DELTA"),
    MODEL_COMPLETED: count("MODEL_COMPLETED"),
    TOOL_STARTED: count("TOOL_STARTED"),
    TOOL_COMPLETED: count("TOOL_COMPLETED"),
    PROVIDER_STATUS: count("PROVIDER_STATUS"),
    FINAL_OUTPUT: count("FINAL_OUTPUT"),
  };
};

const CAPTURED_PRESERVED_EVENT_COUNTS = {
  MODEL_STARTED: 1,
  MODEL_DELTA: 2,
  MODEL_COMPLETED: 3,
  TOOL_STARTED: 0,
  TOOL_COMPLETED: 0,
  PROVIDER_STATUS: 3,
  FINAL_OUTPUT: 1,
};

const assertNoPersistedChunks = (events: RecordedEvent[]): void => {
  // The policy suppresses the entire provider line, so no SessionEvent type
  // may carry either chunk payload—not only the parsed event type expected
  // from today's adapter implementation.
  const persistedChunkEvents = events.filter((event) =>
    typeof event.payload.type === "string" && CHUNK_TYPES.has(event.payload.type));
  assert.deepEqual(persistedChunkEvents, []);
};

const assertPreservedRawEvents = (transcript: readonly unknown[], events: RecordedEvent[]): void => {
  const expectedRawTypes = transcript
    .map(providerTypeOf)
    .filter((type) => typeof type !== "string" || !CHUNK_TYPES.has(type));
  const actualRawTypes = events
    .filter((event) => event.type === "PROVIDER_RAW")
    .map((event) => typeof event.payload.type === "string"
      ? event.payload.type
      : UNCLASSIFIED_PROVIDER_TYPE);
  assert.deepEqual(actualRawTypes, expectedRawTypes);
};

test("PI harvests one fresh openai-codex Luna message despite provisional and repeated usage", async () => {
  const transcript = await capturedTranscript();
  const events: RecordedEvent[] = [];
  parsePiTranscript(transcript, (event) => { events.push(event); });

  assertNoPersistedChunks(events);
  assertPreservedRawEvents(transcript, events);
  assert.deepEqual(preservedEventCounts(events), CAPTURED_PRESERVED_EVENT_COUNTS);
  assert.deepEqual(finalOutputOf(events).agentosPiUsage, {
    messages: 1,
    reported: 1,
    input: 2197,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    costNanoUsd: 445400,
  });
  assert.equal(events.some((event) => event.type === "ADAPTER_ERROR"), false);
});

test("PI drops streaming chunks while preserving terminal and tool events", async () => {
  const transcript = await capturedTranscript();
  assert.ok(transcript.some((event) => providerTypeOf(event) === "message_update"));
  assert.equal(transcript.some((event) => providerTypeOf(event) === "tool_execution_update"), false,
    "the captured fixture needs a synthetic tool update to cover chunk suppression");
  transcript.splice(-1, 0,
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" },
    { type: "tool_execution_update", toolCallId: "tool-1", output: "hello" },
    { type: "tool_execution_end", toolCallId: "tool-1", output: "hello" },
  );
  const events: RecordedEvent[] = [];
  parsePiTranscript(transcript, (event) => { events.push(event); });

  assertNoPersistedChunks(events);
  assertPreservedRawEvents(transcript, events);
  assert.deepEqual(preservedEventCounts(events), {
    ...CAPTURED_PRESERVED_EVENT_COUNTS,
    TOOL_STARTED: 1,
    TOOL_COMPLETED: 1,
  });

  const assistantCompleted = events.find((event) => event.type === "MODEL_COMPLETED"
    && (event.payload.message as { role?: unknown } | undefined)?.role === "assistant");
  assert.ok(assistantCompleted, "the assistant message remains a MODEL_COMPLETED event");
  assert.deepEqual(finalOutputOf(events).agentosPiUsage, {
    messages: 1,
    reported: 1,
    input: 2197,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    costNanoUsd: 445400,
  });
});

test("PI streaming chunks still renew both adapter progress clocks", () => {
  const messageState = parsePiTranscript([]);
  const messageBefore = new Date(0);
  messageState.lastProgressEventAt = messageBefore;
  const messageEvents: RecordedEvent[] = [];

  parsePiEvent(messageState, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "still working" },
  }, (event) => { messageEvents.push(event); });

  assert.ok(messageState.lastProgressEventAt.getTime() > messageBefore.getTime());
  assert.deepEqual(messageEvents.map((event) => event.type), ["MODEL_DELTA"]);

  const toolState = parsePiTranscript([
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" },
  ]);
  assert.ok(toolState.inFlightTool);
  const inFlightTool = toolState.inFlightTool;
  const toolBefore = new Date(0);
  toolState.lastProgressEventAt = toolBefore;
  inFlightTool.lastProgressAt = toolBefore;
  const toolEvents: RecordedEvent[] = [];

  parsePiEvent(toolState, {
    type: "tool_execution_update",
    toolCallId: "tool-1",
    output: "still working",
  }, (event) => { toolEvents.push(event); });

  assert.ok(toolState.lastProgressEventAt.getTime() > toolBefore.getTime());
  assert.equal(toolState.inFlightTool, inFlightTool);
  assert.ok(inFlightTool.lastProgressAt.getTime() > toolBefore.getTime());
  assert.deepEqual(toolEvents.map((event) => event.type), ["TOOL_PROGRESS"]);
});

test("PI preserves raw provider events without a string type", () => {
  const transcript: unknown[] = [42, { payload: "missing type" }, { type: "message_update" }];
  const events: RecordedEvent[] = [];

  parsePiTranscript(transcript, (event) => { events.push(event); });

  assertPreservedRawEvents(transcript, events);
  assertNoPersistedChunks(events);
});

test("PI treats cache-only usage as tokens when diagnosing a missing cost", () => {
  const events: RecordedEvent[] = [];
  parsePiTranscript([
    { type: "message_end", message: { role: "assistant", usage: { cacheRead: 7 } } },
    { type: "agent_settled" },
  ], (event) => { events.push(event); });

  const errors = events.filter((event) => event.type === "ADAPTER_ERROR");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]!.payload.error), /^Session cost is incomplete: PI reported no cost$/u);
});

test("PI records TTFT on the assistant message_end while preserving the event histogram", () => {
  const events = replayPiAt([
    { at: 1_000, event: { type: "session", id: "session-1" } },
    { at: 1_125, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } } },
    { at: 1_400, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } } },
    { at: 1_500, event: { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } } },
  ]);

  const assistantMessageEnd = events.find((event) => event.type === "MODEL_COMPLETED"
    && event.payload.type === "message_end");
  assert.ok(assistantMessageEnd);
  assert.equal((assistantMessageEnd.payload.anneal as { ttftMs?: unknown }).ttftMs, 125);
  const turnEnd = events.find((event) => event.type === "MODEL_COMPLETED" && event.payload.type === "turn_end");
  assert.ok(turnEnd);
  assert.equal(turnEnd.payload.anneal, undefined);
  assert.deepEqual(events.map((event) => event.type), [
    "PROVIDER_RAW", "MODEL_STARTED", "PROVIDER_RAW", "MODEL_COMPLETED", "PROVIDER_RAW", "MODEL_COMPLETED",
  ]);
});

test("PI omits TTFT when a turn has no observed message chunk", () => {
  const events: RecordedEvent[] = [];
  parsePiTranscript([
    { type: "session", id: "session-1" },
    { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
  ], (event) => { events.push(event); });

  const assistantMessageEnd = events.find((event) => event.type === "MODEL_COMPLETED");
  assert.ok(assistantMessageEnd);
  assert.equal(assistantMessageEnd.payload.anneal, undefined);
});

test("PI consumes one turn timing and starts the next after user input", () => {
  const events = replayPiAt([
    { at: 1_000, event: { type: "session", id: "session-1" } },
    { at: 1_100, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "one" } } },
    { at: 1_200, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "one" }] } } },
    { at: 1_300, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stale" } } },
    { at: 1_400, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stale" }] } } },
    { at: 2_000, event: { type: "message_end", message: { role: "user", content: [{ type: "text", text: "next" }] } } },
    { at: 2_200, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "two" } } },
    { at: 2_500, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "two" }] } } },
  ]);

  const assistants = events.filter((event) => event.type === "MODEL_COMPLETED"
    && event.payload.type === "message_end"
    && (event.payload.message as { role?: unknown } | undefined)?.role === "assistant");
  assert.equal(assistants.length, 3);
  assert.equal((assistants[0]!.payload.anneal as { ttftMs?: unknown }).ttftMs, 100);
  assert.equal(assistants[1]!.payload.anneal, undefined);
  assert.equal((assistants[2]!.payload.anneal as { ttftMs?: unknown }).ttftMs, 200);
});
