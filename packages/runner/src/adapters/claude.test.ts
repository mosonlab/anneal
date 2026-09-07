import { replayTranscriptAt, type RecordedEvent, type TimedProviderEvent } from "./timed-transcript.js";
import assert from "node:assert/strict";
import test from "node:test";

import { parseClaudeEvent, parseClaudeTranscript, providerEventPersistence } from "./claude.js";
import { createAdapterState } from "./runtime.js";

const replayClaudeAt = (transcript: readonly TimedProviderEvent[]): RecordedEvent[] =>
  replayTranscriptAt(createAdapterState("CLAUDE", "transcript", undefined, new Date(0)), transcript, parseClaudeEvent, providerEventPersistence);

test("Claude drops partial stream rows while using the first partial chunk for TTFT", () => {
  const events = replayClaudeAt([
    { at: 1_000, event: { type: "system", session_id: "session-1" } },
    { at: 1_125, event: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } } },
    { at: 1_400, event: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } } },
    { at: 1_500, event: { type: "result", is_error: false, terminal_reason: "completed", result: "hello" } },
  ]);

  assert.equal(events.some((event) => event.type === "PROVIDER_RAW" && event.payload.type === "stream_event"), false);
  assert.equal(events.some((event) => event.payload.type === "stream_event"), false);
  assert.deepEqual(events.map((event) => event.type), [
    "PROVIDER_RAW", "MODEL_STARTED", "PROVIDER_RAW", "MODEL_DELTA", "PROVIDER_RAW", "FINAL_OUTPUT",
  ]);
  const assistant = events.find((event) => event.type === "MODEL_DELTA" && event.payload.type === "assistant");
  assert.ok(assistant);
  assert.equal((assistant.payload.anneal as { ttftMs?: unknown }).ttftMs, 125);
});

test("Claude omits TTFT when no partial chunk was observed", () => {
  const events: RecordedEvent[] = [];
  parseClaudeTranscript([
    { type: "system", session_id: "session-1" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
  ], (event) => { events.push(event); });

  const assistant = events.find((event) => event.type === "MODEL_DELTA" && event.payload.type === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.payload.anneal, undefined);
});

test("Claude stream headers and stops do not count as a first output chunk", () => {
  const events: RecordedEvent[] = [];
  parseClaudeTranscript([
    { type: "system", session_id: "session-1" },
    { type: "stream_event", event: { type: "message_start", message: {} } },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text", text: "" } } },
    { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
    { type: "stream_event", event: { type: "message_stop" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
  ], (event) => { events.push(event); });

  const assistant = events.find((event) => event.type === "MODEL_DELTA" && event.payload.type === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.payload.anneal, undefined);
});

test("Claude resets TTFT only at a later user/tool input boundary", () => {
  const events = replayClaudeAt([
    { at: 1_000, event: { type: "system", session_id: "session-1" } },
    { at: 1_100, event: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "one" } } } },
    { at: 1_200, event: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "one" }] } } },
    { at: 1_500, event: { type: "system", subtype: "status" } },
    { at: 1_600, event: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "duplicate" }] } } },
    { at: 2_000, event: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1" }] } } },
    { at: 2_250, event: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "two" } } } },
    { at: 2_500, event: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "two" }] } } },
  ]);

  const assistants = events.filter((event) => event.type === "MODEL_DELTA" && event.payload.type === "assistant");
  assert.equal(assistants.length, 3);
  assert.equal((assistants[0]!.payload.anneal as { ttftMs?: unknown }).ttftMs, 100);
  assert.equal(assistants[1]!.payload.anneal, undefined);
  assert.equal((assistants[2]!.payload.anneal as { ttftMs?: unknown }).ttftMs, 250);
});
