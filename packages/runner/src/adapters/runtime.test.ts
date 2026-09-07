import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeTurnTtft,
  createAdapterState,
  emitAdapterEvent,
  markFirstChunk,
  markTurnRequested,
  processProviderEvent,
  type AdapterEventParser,
} from "./runtime.js";

test("provider-event persistence can suppress output while retaining parser state and progress", () => {
  const state = createAdapterState("PI", "runtime-test", undefined, new Date(0));
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const parseEvent: AdapterEventParser = (parserState, event, sink) => {
    parserState.providerConversationId = String(event.id);
    emitAdapterEvent(parserState, sink, "MODEL_DELTA", event);
  };
  const before = state.lastProgressEventAt;

  processProviderEvent(state, { type: "message_update", id: "suppressed" }, (event) => events.push(event), parseEvent, () => false);

  assert.deepEqual(events, []);
  assert.equal(state.providerConversationId, "suppressed");
  assert.ok(state.lastProgressEventAt.getTime() > before.getTime());
});

test("provider-event persistence keeps raw and parsed output when accepted", () => {
  const state = createAdapterState("CODEX", "runtime-test");
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const parseEvent: AdapterEventParser = (_parserState, event, sink) => {
    sink({ source: "CODEX", type: "MODEL_COMPLETED", payload: event });
  };

  processProviderEvent(state, { type: "turn.completed" }, (event) => events.push(event), parseEvent, () => true);

  assert.deepEqual(events.map(({ type }) => type), ["PROVIDER_RAW", "MODEL_COMPLETED"]);
});

test("turn timing computes exact milliseconds and is consumed after completion", () => {
  const state = createAdapterState("CLAUDE", "runtime-test", undefined, new Date(0));
  markTurnRequested(state, new Date(1_000));
  markFirstChunk(state, new Date(1_125));

  assert.deepEqual(consumeTurnTtft(state, { type: "assistant" }), {
    type: "assistant",
    anneal: { ttftMs: 125 },
  });
  assert.equal(state.turnRequestedAt, null);
  assert.equal(state.firstChunkAt, null);
  assert.equal(state.turnRequestSeen, true);
});
