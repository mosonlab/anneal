import { replayTranscriptAt, type RecordedEvent, type TimedProviderEvent } from "./timed-transcript.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { parseCodexEvent, parseCodexTranscript } from "./codex.js";
import { createAdapterState } from "./runtime.js";

const replayCodexAt = (transcript: readonly TimedProviderEvent[]): RecordedEvent[] =>
  replayTranscriptAt(createAdapterState("CODEX", "transcript", undefined, new Date(0)), transcript, parseCodexEvent, () => true);

test("Codex records TTFT on the completed agent message", () => {
  const events = replayCodexAt([
    { at: 1_000, event: { type: "thread.started", thread_id: "thread-1" } },
    { at: 1_125, event: { type: "item.started", item: { id: "message-1", type: "agent_message", text: "hel" } } },
    { at: 1_400, event: { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "hello" } } },
    { at: 1_500, event: { type: "turn.completed" } },
  ]);

  const message = events.find((event) => event.type === "MODEL_DELTA"
    && event.payload.type === "item.completed");
  assert.ok(message);
  assert.equal((message.payload.anneal as { ttftMs?: unknown }).ttftMs, 125);
  assert.deepEqual(events.map((event) => event.type), [
    "PROVIDER_RAW", "MODEL_STARTED", "PROVIDER_RAW", "MODEL_DELTA",
    "PROVIDER_RAW", "MODEL_DELTA", "PROVIDER_RAW", "FINAL_OUTPUT",
  ]);
});

test("Codex captured CLI output omits TTFT when no agent output chunk was exposed", async () => {
  const capture = await readFile(new URL("../../../../spikes/cli-capabilities/samples/codex-gpt-5.6-luna-max-20260828.stdout", import.meta.url), "utf8");
  const events: RecordedEvent[] = [];
  parseCodexTranscript(capture.trim().split("\n").map((line) => JSON.parse(line) as unknown),
    (event) => { events.push(event); });

  const message = events.find((event) => event.type === "MODEL_DELTA" && event.payload.type === "item.completed");
  assert.ok(message);
  assert.equal(message.payload.anneal, undefined);
  assert.deepEqual(events.map((event) => event.type), [
    "PROVIDER_RAW", "MODEL_STARTED", "PROVIDER_RAW", "PROVIDER_STATUS",
    "PROVIDER_RAW", "MODEL_DELTA", "PROVIDER_RAW", "FINAL_OUTPUT",
  ]);
});

test("Codex uses the latest completed tool boundary for the next turn", () => {
  const events = replayCodexAt([
    { at: 1_000, event: { type: "thread.started", thread_id: "thread-1" } },
    { at: 1_100, event: { type: "item.started", item: { id: "message-1", type: "agent_message", text: "one" } } },
    { at: 1_200, event: { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "one" } } },
    { at: 2_000, event: { type: "item.completed", item: { id: "tool-1", type: "mcp_tool_call", status: "completed" } } },
    { at: 2_100, event: { type: "item.completed", item: { id: "tool-2", type: "file_change", changes: [], status: "completed" } } },
    { at: 2_500, event: { type: "item.started", item: { id: "message-2", type: "agent_message", text: "two" } } },
    { at: 2_600, event: { type: "item.completed", item: { id: "message-2", type: "agent_message", text: "two" } } },
  ]);

  const messages = events.filter((event) => event.type === "MODEL_DELTA" && event.payload.type === "item.completed");
  assert.equal(messages.length, 4);
  assert.equal((messages[0]!.payload.anneal as { ttftMs?: unknown }).ttftMs, 100);
  assert.equal(messages[1]!.payload.anneal, undefined);
  assert.equal(messages[2]!.payload.anneal, undefined);
  assert.equal((messages[3]!.payload.anneal as { ttftMs?: unknown }).ttftMs, 400);
});
