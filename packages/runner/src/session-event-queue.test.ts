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

test("sustained tool output holds the bound while lifecycle and error events survive", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 8_000 });
  queue.push(lifecycle("PROCESS_STARTED"));
  queue.push(lifecycle("ADAPTER_ERROR"));
  for (let index = 0; index < 500; index += 1) {
    queue.push({ source: "PI", type: index % 2 === 0 ? "TOOL_COMPLETED" : "TOOL_PROGRESS", payload: { out: "o".repeat(400) } });
    queue.push({ source: "PI", type: "PROVIDER_STATUS", payload: { note: "s".repeat(400) } });
    assert.ok(queue.bytes <= 8_000 + 800, `tool traffic must not grow the queue, held ${queue.bytes}`);
  }

  assert.deepEqual(
    queue.batch().filter((event) => event.source !== "PI" && event.type !== EVENTS_DROPPED_EVENT_TYPE)
      .map((event) => event.type),
    ["PROCESS_STARTED", "ADAPTER_ERROR"],
    "the record of what the Run did outlives 200x its own weight in tool output",
  );
});

test("protected traffic alone is never shed, however far past the bound it runs", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 500, maxEvents: 3, batchMaxEvents: 1_000 });
  for (let index = 0; index < 1_000; index += 1) {
    queue.push({ source: "CLAUDE", type: "ADAPTER_ERROR", payload: { error: "invalid-json", line: "x".repeat(200) } });
  }

  assert.equal(queue.length, 1_000, "an error event is never given up, whatever the bound says");
  const held = queue.batch();
  assert.equal(
    held.filter((event) => event.type === EVENTS_DROPPED_EVENT_TYPE).length,
    0,
    "nothing was dropped, so there is nothing to record",
  );
  assert.deepEqual(held.map((event) => event.seq), Array.from({ length: 1_000 }, (_, index) => index),
    "every error the provider raised reaches the control plane, in order");
  const detail = held.filter((event) => (event.payload as { truncated?: boolean }).truncated !== true);
  assert.ok(detail.length <= 2, `pressure takes the payloads first, kept ${detail.length} intact`);
  assert.ok(
    queue.bytes / queue.length < 200,
    `a marker-only queue costs a fraction of an untruncated one, held ${queue.bytes} over ${queue.length}`,
  );
});

test("a protected event under pressure loses its payload before it loses its place", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 1_200, maxEvents: 50 });
  queue.push({ source: "CLAUDE", type: "FINAL_OUTPUT", payload: { text: "f".repeat(2_000) } });
  queue.push({ source: "CLAUDE", type: "ADAPTER_ERROR", payload: { error: "e".repeat(2_000) } });

  assert.equal(queue.length, 2, "no protected event is shed while one still has a payload to give");
  assert.ok(queue.bytes <= 1_200, `the bound holds by truncation alone, held ${queue.bytes}`);
  const held = queue.batch();
  assert.deepEqual(held.map((event) => event.type), ["FINAL_OUTPUT", "ADAPTER_ERROR"]);
  const marker = held[0]!.payload as { truncated?: boolean; originalBytes?: number };
  assert.equal(marker.truncated, true, "the loss of the detail is recorded in the event itself");
  assert.ok((marker.originalBytes ?? 0) > 2_000, "the marker carries the size it was cut from");
});

test("an event truncated at the per-event cap keeps its original size when pressure truncates it again", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 400, maxEvents: 50, payloadMaxBytes: 2_000 });
  queue.push({ source: "CLAUDE", type: "FINAL_OUTPUT", payload: { text: "f".repeat(100_000) } });

  const marker = queue.batch()[0]!.payload as { truncated?: boolean; originalBytes?: number };
  assert.equal(marker.truncated, true);
  assert.ok((marker.originalBytes ?? 0) > 100_000, "the size reported is the provider's, not the first marker's");
});

test("a batch in flight is neither dropped by the bound nor released by count", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 3_000 });
  for (let index = 0; index < 4; index += 1) queue.push(chunk(`head-${index}`.padEnd(300, "x")));
  const inFlight = queue.batch();
  assert.equal(inFlight.length, 4);

  // The provider keeps streaming while the append is in flight, past the bound.
  for (let index = 0; index < 40; index += 1) queue.push(chunk(`tail-${index}`.padEnd(300, "y")));
  const record = queue.batch().find((event) => event.type === EVENTS_DROPPED_EVENT_TYPE);
  assert.ok(record, "the pressure that hit the tail is recorded");

  // Reclaiming the queue for the next batch must not have disturbed the events
  // the accepted request actually carried.
  queue.release(inFlight);
  const remaining = queue.batch();
  assert.equal(
    remaining.filter((event) => inFlight.includes(event)).length,
    0,
    "every accepted event is gone",
  );
  assert.ok(
    remaining.every((event) => event.type === EVENTS_DROPPED_EVENT_TYPE || (event.payload as { text: string }).text.startsWith("tail-")),
    "and nothing the request never carried went with them",
  );
  assert.deepEqual(
    remaining.map((event) => event.seq),
    [...remaining].sort((left, right) => left.seq - right.seq).map((event) => event.seq),
    "order is untouched for what survives",
  );
});

test("drops during an in-flight batch open a fresh record instead of editing the one being sent", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 2_000 });
  for (let index = 0; index < 12; index += 1) queue.push(chunk("a".repeat(300)));
  const inFlight = queue.batch();
  const sentRecord = inFlight.find((event) => event.type === EVENTS_DROPPED_EVENT_TYPE);
  assert.ok(sentRecord, "the first pressure episode is in the batch being delivered");
  const sentCount = (sentRecord.payload as { droppedEvents: number }).droppedEvents;

  for (let index = 0; index < 12; index += 1) queue.push(chunk("b".repeat(300)));
  assert.equal(
    (sentRecord.payload as { droppedEvents: number }).droppedEvents,
    sentCount,
    "a record already serialized into a request is never edited afterwards",
  );
  queue.release(inFlight);
  const records = queue.batch().filter((event) => event.type === EVENTS_DROPPED_EVENT_TYPE);
  assert.equal(records.length, 1, "the later drops get their own record");
  assert.ok((records[0]!.payload as { droppedEvents: number }).droppedEvents > 0);
});

test("a whole-request refusal is answered by halving the batch, down to one event", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, batchMaxEvents: 8, maxBytes: 1_000_000 });
  for (let index = 0; index < 8; index += 1) queue.push(lifecycle(`STEP_${index}`));
  assert.equal(queue.batch().length, 8);

  assert.equal(queue.reduceBatch(), true);
  assert.equal(queue.batch().length, 4);
  assert.equal(queue.reduceBatch(), true);
  assert.equal(queue.batch().length, 2);
  assert.equal(queue.reduceBatch(), true);
  assert.equal(queue.batch().length, 1);
  // The floor is where shrinking stops being an answer and the caller must
  // lose the one event no request can carry.
  for (let index = 0; index < 40; index += 1) queue.reduceBatch();
  assert.equal(queue.reduceBatch(), false);
  assert.equal(queue.batch().length, 1);
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
  queue.release(batch);
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
  queue.release(queue.batch().slice(0, 2));

  assert.ok(queue.bytes < before && queue.bytes > 0);
  assert.equal(queue.length, 2);
});

test("the truncation cap the runner applies is the cap the API enforces", () => {
  const marker = truncateSessionEventPayload({ text: "b".repeat(SESSION_EVENT_PAYLOAD_MAX_BYTES * 2) });
  assert.ok(jsonByteLength(marker) <= SESSION_EVENT_PAYLOAD_MAX_BYTES);
  assert.equal(marker.limitBytes, SESSION_EVENT_PAYLOAD_MAX_BYTES);
});
