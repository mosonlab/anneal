import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SESSION_EVENT_PAYLOAD_MAX_BYTES,
  jsonByteLength,
  truncateSessionEventPayload,
} from "@anneal/db/session-event-limits";

import type { AdapterEvent } from "./adapters.js";
import {
  createSessionEventQueue,
  EVENTS_DROPPED_EVENT_TYPE,
  EVENT_REJECTED_EVENT_TYPE,
} from "./session-event-queue.js";

const chunk = (text: string): AdapterEvent => ({ source: "CLAUDE", type: "MODEL_DELTA", payload: { text } });
const lifecycle = (type: string): AdapterEvent => ({ source: "CLAUDE", type, payload: { note: type } });

test("the byte bound drops the oldest chunk events and records one marker", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 4_000 });
  for (let index = 0; index < 12; index += 1) queue.push(chunk(`${index}`.padEnd(500, "x")));

  assert.ok(queue.bytes <= 4_000 + 400, `queue must stay at its bound, held ${queue.bytes}`);
  const kept = queue.batch();
  const markers = kept.filter((event) => event.type === EVENTS_DROPPED_EVENT_TYPE);
  assert.equal(markers.length, 1, "one drop record covers the whole episode, not one per dropped event");
  const dropped = markers[0]!.payload as { droppedEvents: number; droppedBytes: number; firstDroppedSeq: number; lastDroppedSeq: number };
  const survivors = kept.filter((event) => event.type === "MODEL_DELTA");
  assert.equal(dropped.droppedEvents + survivors.length, 12, "every pushed event is either held or counted as dropped");
  assert.ok(dropped.droppedBytes > 0);
  assert.equal(dropped.firstDroppedSeq, 0, "the oldest event goes first");
  assert.equal(dropped.lastDroppedSeq, dropped.droppedEvents - 1);
  assert.deepEqual(
    survivors.map((event) => event.seq),
    [...survivors].sort((left, right) => left.seq - right.seq).map((event) => event.seq),
    "the events that survive keep their order",
  );
  assert.ok(
    survivors.every((event) => event.seq > dropped.lastDroppedSeq),
    "what survives is the tail of the stream, not an arbitrary subset",
  );
});

test("lifecycle and error events survive a queue held far over its byte bound", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 2_000 });
  queue.push(lifecycle("PROCESS_STARTED"));
  for (let index = 0; index < 20; index += 1) queue.push(chunk("x".repeat(400)));
  queue.push(lifecycle("ADAPTER_ERROR"));
  queue.push(lifecycle("FINAL_OUTPUT"));
  for (let index = 0; index < 20; index += 1) queue.push(chunk("y".repeat(400)));

  const held = queue.batch();
  assert.deepEqual(
    held.filter((event) => event.type !== "MODEL_DELTA" && event.type !== EVENTS_DROPPED_EVENT_TYPE)
      .map((event) => event.type),
    ["PROCESS_STARTED", "ADAPTER_ERROR", "FINAL_OUTPUT"],
    "no pressure drops the record of what the Run did",
  );
});

test("a queue of only undroppable events exceeds the bound rather than losing the account of the Run", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 500 });
  for (let index = 0; index < 10; index += 1) queue.push(lifecycle("TOOL_COMPLETED"));

  assert.equal(queue.length, 10);
  assert.ok(queue.bytes > 500);
  assert.equal(queue.batch().filter((event) => event.type === EVENTS_DROPPED_EVENT_TYPE).length, 0);
});

test("the count bound drops chunk events even when the queue is small in bytes", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxEvents: 5 });
  for (let index = 0; index < 20; index += 1) queue.push(chunk("."));

  assert.ok(queue.length <= 6, `five events plus at most one drop record, held ${queue.length}`);
  const record = queue.batch().find((event) => event.type === EVENTS_DROPPED_EVENT_TYPE);
  // Sixteen, not fifteen: the drop record occupies a slot of the count bound
  // like any other queued event.
  assert.equal((record?.payload as { droppedEvents: number }).droppedEvents, 16);
});

test("an oversized payload is truncated at the cap with its original size", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, payloadMaxBytes: 1_000 });
  const original = { text: "z".repeat(5_000) };
  queue.push({ source: "CODEX", type: "TOOL_COMPLETED", payload: original });

  const [event] = queue.batch();
  const payload = event!.payload as { truncated: boolean; originalBytes: number; limitBytes: number; preview: string };
  assert.equal(payload.truncated, true);
  assert.equal(payload.originalBytes, jsonByteLength(original));
  assert.equal(payload.limitBytes, 1_000);
  assert.ok(jsonByteLength(payload) <= 1_000, "the truncated payload must fit the cap the API enforces");
  assert.ok(payload.preview.startsWith('{"text":"zzz'), "the preview keeps the head of the original payload");
});

test("a payload inside the cap is forwarded untouched", () => {
  const queue = createSessionEventQueue({ nextSeq: 7 });
  queue.push({ source: "PI", type: "MODEL_DELTA", payload: { text: "small" }, toolCallId: "tool-1" });

  assert.deepEqual(queue.batch(), [{
    seq: 7,
    at: queue.batch()[0]!.at,
    source: "PI",
    type: "MODEL_DELTA",
    payload: { text: "small" },
    toolCallId: "tool-1",
  }]);
});

test("batches are formed by bytes as well as by count", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, batchMaxBytes: 2_000, batchMaxEvents: 100, maxBytes: 1_000_000 });
  for (let index = 0; index < 10; index += 1) queue.push(chunk("q".repeat(600)));

  const batch = queue.batch();
  assert.ok(batch.length >= 1 && batch.length <= 3, `a 2 KB batch holds a few 600-byte events, got ${batch.length}`);
  assert.ok(jsonByteLength(batch) <= 2_400, "the formed batch stays inside its byte budget");
  queue.release(batch.length);
  assert.equal(queue.batch()[0]!.seq, batch.length, "release advances the queue head in order");
});

test("one event larger than the whole batch budget is still sent alone", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, batchMaxBytes: 100, payloadMaxBytes: 5_000 });
  queue.push(lifecycle("FINAL_OUTPUT"));
  queue.push(lifecycle("PROCESS_STARTED"));

  assert.equal(queue.batch().length, 1, "a batch never forms empty, however tight the budget");
});

test("a rejected event is dropped by sequence number and recorded, leaving the rest to resend", () => {
  const queue = createSessionEventQueue({ nextSeq: 0 });
  for (let index = 0; index < 5; index += 1) queue.push(lifecycle(`STEP_${index}`));
  const batch = queue.batch();

  assert.equal(queue.reject(batch[3]!.seq, "payload-too-large"), true);
  const resent = queue.batch();
  assert.deepEqual(
    resent.filter((event) => event.type !== EVENT_REJECTED_EVENT_TYPE).map((event) => event.type),
    ["STEP_0", "STEP_1", "STEP_2", "STEP_4"],
    "only the named event is lost",
  );
  const record = resent.find((event) => event.type === EVENT_REJECTED_EVENT_TYPE);
  assert.deepEqual(record?.payload, {
    reason: "payload-too-large",
    rejectedSeq: 3,
    rejectedType: "STEP_3",
    rejectedBytes: jsonByteLength(batch[3]),
  });
  assert.equal(queue.reject(batch[3]!.seq, "payload-too-large"), false, "an event already gone cannot be rejected twice");
});

test("a rejected record is not itself recorded, so a refusing API cannot wedge the drain", () => {
  const queue = createSessionEventQueue({ nextSeq: 0 });
  queue.push(lifecycle("PROCESS_STARTED"));
  queue.reject(0, "payload-too-large");

  const [record] = queue.batch();
  assert.equal(record!.type, EVENT_REJECTED_EVENT_TYPE);
  assert.equal(queue.reject(record!.seq, "payload-too-large"), true);
  assert.equal(queue.length, 0, "trading each rejected record for a fresh one would never drain");
});

test("released events stop counting against the bound", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 4_000 });
  for (let index = 0; index < 4; index += 1) queue.push(chunk("w".repeat(400)));
  const before = queue.bytes;
  queue.release(2);

  assert.ok(queue.bytes < before && queue.bytes > 0);
  assert.equal(queue.length, 2);
});

test("the truncation cap the runner applies is the cap the API enforces", () => {
  const marker = truncateSessionEventPayload({ text: "b".repeat(SESSION_EVENT_PAYLOAD_MAX_BYTES * 2) });
  assert.ok(jsonByteLength(marker) <= SESSION_EVENT_PAYLOAD_MAX_BYTES);
  assert.equal(marker.limitBytes, SESSION_EVENT_PAYLOAD_MAX_BYTES);
});
