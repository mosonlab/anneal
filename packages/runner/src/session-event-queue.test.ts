import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SESSION_EVENT_PAYLOAD_MAX_BYTES,
  jsonByteLength,
  truncateSessionEventPayload,
} from "@anneal/db/session-event-limits";

import type { AdapterEvent } from "./adapters.js";
import type { SessionEventPayload } from "./api.js";
import {
  createSessionEventQueue,
  EVENTS_COALESCED_EVENT_TYPE,
  EVENTS_DROPPED_EVENT_TYPE,
  EVENT_REJECTED_EVENT_TYPE,
} from "./session-event-queue.js";

const chunk = (text: string): AdapterEvent => ({ source: "CLAUDE", type: "MODEL_DELTA", payload: { text } });
const lifecycle = (type: string): AdapterEvent => ({ source: "CLAUDE", type, payload: { note: type } });

test("the byte bound drops the oldest chunk events and records one marker", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 4_000 });
  for (let index = 0; index < 12; index += 1) queue.push(chunk(`${index}`.padEnd(500, "x")));

  assert.ok(queue.bytes <= 4_000, `queue must stay at its bound, held ${queue.bytes}`);
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
    assert.ok(queue.bytes <= 8_000, `tool traffic must not grow the queue, held ${queue.bytes}`);
  }

  assert.deepEqual(
    queue.batch().filter((event) => event.source !== "PI" && event.type !== EVENTS_DROPPED_EVENT_TYPE)
      .map((event) => event.type),
    ["PROCESS_STARTED", "ADAPTER_ERROR"],
    "the record of what the Run did outlives 200x its own weight in tool output",
  );
});

/**
 * What the surviving markers claim to account for: one span per held event,
 * widened to the merged range where markers were coalesced.
 */
const spans = (held: readonly SessionEventPayload[]): { events: number; firstSeq: number; lastSeq: number }[] =>
  held.map((event) => {
    if (event.type !== EVENTS_COALESCED_EVENT_TYPE) {
      return { events: 1, firstSeq: event.seq, lastSeq: event.seq };
    }
    const payload = event.payload as { coalescedEvents: number; firstSeq: number; lastSeq: number };
    return { events: payload.coalescedEvents, firstSeq: payload.firstSeq, lastSeq: payload.lastSeq };
  });

test("protected traffic far past the count bound is held inside it, still accounting for every event", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 500, maxEvents: 3, batchMaxEvents: 1_000 });
  for (let index = 0; index < 1_000; index += 1) {
    queue.push({ source: "CLAUDE", type: "ADAPTER_ERROR", payload: { error: "invalid-json", line: "x".repeat(200) } });
  }

  assert.ok(queue.length <= 3, `the count bound holds against protected traffic too, held ${queue.length}`);
  assert.ok(queue.bytes <= 500, `so does the byte bound, held ${queue.bytes}`);
  const held = queue.batch();
  assert.equal(
    held.filter((event) => event.type === EVENTS_DROPPED_EVENT_TYPE).length,
    0,
    "an error event is still never dropped, so there is nothing to record as lost",
  );
  const account = spans(held);
  assert.equal(
    account.reduce((total, span) => total + span.events, 0),
    1_000,
    "every error the provider raised is accounted for by the markers that survive",
  );
  assert.equal(account[0]!.firstSeq, 0, "the account starts at the first event");
  assert.equal(account.at(-1)!.lastSeq, 999, "and ends at the last");
  for (let index = 1; index < account.length; index += 1) {
    assert.equal(
      account[index]!.firstSeq,
      account[index - 1]!.lastSeq + 1,
      "the surviving markers cover a contiguous range with no gap between them",
    );
  }
  assert.deepEqual(
    held.map((event) => event.seq),
    [...held].sort((left, right) => left.seq - right.seq).map((event) => event.seq),
    "and they reach the control plane in order",
  );
});

test("coalescing keeps the drop account of a record it absorbs", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 900, maxEvents: 2, batchMaxEvents: 1_000 });
  // Chunks first, so a drop record exists; then protected traffic that leaves
  // nothing droppable and forces the record itself to be merged away. Nothing
  // is claimed in between, or the record would be exempt for the wrong reason.
  for (let index = 0; index < 20; index += 1) queue.push(chunk("d".repeat(300)));
  for (let index = 0; index < 50; index += 1) {
    queue.push({ source: "CLAUDE", type: "ADAPTER_ERROR", payload: { error: "e".repeat(200) } });
  }

  assert.ok(queue.length <= 2, `the count bound holds, held ${queue.length}`);
  const held = queue.batch();
  assert.equal(
    held.filter((event) => event.type === EVENTS_DROPPED_EVENT_TYPE).length,
    0,
    "the drop record was merged like any other marker",
  );
  const merged = held.filter((event) => event.type === EVENTS_COALESCED_EVENT_TYPE)
    .map((event) => event.payload as { droppedEvents: number; droppedBytes: number });
  assert.equal(
    merged.reduce((total, payload) => total + payload.droppedEvents, 0),
    20,
    "the events it said were dropped are in no other entry, so merging carries them forward",
  );
  assert.ok(merged.every((payload) => payload.droppedBytes > 0), "with the bytes they cost");
});

test("tool output is given up before any lifecycle or error event", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 3_000, batchMaxEvents: 1_000 });
  queue.push(lifecycle("PROCESS_STARTED"));
  for (let index = 0; index < 10; index += 1) {
    queue.push({ source: "PI", type: "TOOL_COMPLETED", payload: { out: "o".repeat(400) } });
    queue.push({ source: "PI", type: "TOOL_PROGRESS", payload: { out: "p".repeat(400) } });
  }
  queue.push(lifecycle("TOOL_STARTED"));
  queue.push(lifecycle("ADAPTER_ERROR"));
  for (let index = 0; index < 40; index += 1) {
    queue.push({ source: "PI", type: "TOOL_COMPLETED", payload: { out: "q".repeat(400) } });
  }

  const held = queue.batch();
  assert.deepEqual(
    held.filter((event) => event.source !== "RUNNER").map((event) => event.type)
      .filter((type) => type !== "TOOL_COMPLETED" && type !== "TOOL_PROGRESS"),
    ["PROCESS_STARTED", "TOOL_STARTED", "ADAPTER_ERROR"],
    "the chunk types carrying tool output go first; the lifecycle and error events stay",
  );
  const record = held.find((event) => event.type === EVENTS_DROPPED_EVENT_TYPE);
  assert.ok(record, "and the loss is recorded");
  assert.ok((record.payload as { droppedEvents: number }).droppedEvents > 0);
});

test("a protected event under pressure loses its payload before it loses its place", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 1_200, maxEvents: 50 });
  queue.push({ source: "CLAUDE", type: "FINAL_OUTPUT", payload: { text: "f".repeat(2_000) } });
  queue.push({ source: "CLAUDE", type: "ADAPTER_ERROR", payload: { error: "e".repeat(2_000) } });

  assert.equal(queue.length, 2, "no protected event is shed while one still has a payload to give");
  assert.ok(queue.bytes <= 1_200, `the bound holds by truncation alone, held ${queue.bytes}`);
  const held = queue.batch();
  assert.deepEqual(held.map((event) => event.type), ["FINAL_OUTPUT", "ADAPTER_ERROR"]);
  const marker = held[0]!.payload as { truncated?: boolean; reason?: string; originalBytes?: number; limitBytes?: number; queueMaxBytes?: number };
  assert.equal(marker.truncated, true, "the loss of the detail is recorded in the event itself");
  assert.ok((marker.originalBytes ?? 0) > 2_000, "the marker carries the size it was cut from");
  assert.equal(marker.reason, "queue-bound", "and names the pressure that cut it, not the per-event cap");
  assert.equal(marker.queueMaxBytes, 1_200, "reporting the bound that was actually reached");
  assert.equal(marker.limitBytes, undefined, "a cap of zero bytes would describe a cap that does not exist");
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

  assert.ok(queue.length <= 5, `the drop record is one of the five, not a sixth, held ${queue.length}`);
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

test("the record of a drop is held inside the bounds like any other entry", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 3_000, maxEvents: 5 });
  for (let index = 0; index < 200; index += 1) {
    queue.push(chunk("x".repeat(200)));
    assert.ok(queue.length <= 5, `the count bound holds through the drop record too, held ${queue.length}`);
    assert.ok(queue.bytes <= 3_000, `and so does the byte bound, held ${queue.bytes}`);
  }

  const held = queue.batch();
  const record = held.find((event) => event.type === EVENTS_DROPPED_EVENT_TYPE);
  assert.ok(record, "the drops are still recorded, inside the bound rather than beyond it");
  const dropped = (record.payload as { droppedEvents: number }).droppedEvents;
  assert.equal(dropped + held.length - 1, 200, "and account for every event that is no longer held");
});

test("the bound a batch in flight suspends holds again as soon as it settles", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 3_000, maxEvents: 6 });
  for (let index = 0; index < 6; index += 1) queue.push(chunk("a".repeat(200)));
  const inFlight = queue.batch();
  // Pressure while the request is in flight: the claimed entries are exempt,
  // and the record of what it forced out is opened beside them.
  for (let index = 0; index < 50; index += 1) queue.push(chunk("b".repeat(200)));
  const record = queue.batch().find((event) => event.type === EVENTS_DROPPED_EVENT_TYPE);
  assert.ok(record, "the drops of an in-flight episode are recorded");

  queue.release(inFlight);
  queue.push(chunk("c".repeat(200)));
  assert.ok(queue.length <= 6, `the count bound is back once nothing is claimed, held ${queue.length}`);
  assert.ok(queue.bytes <= 3_000, `and the byte bound with it, held ${queue.bytes}`);
});

test("a protected event whose provider identifier alone exceeds the bound is still reduced under it", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 1_000, maxEvents: 50 });
  queue.push({
    source: "PI",
    type: "TOOL_STARTED",
    payload: { name: "read" },
    toolCallId: "t".repeat(4_000),
    providerEventId: "p".repeat(4_000),
  });

  assert.ok(queue.bytes <= 1_000, `an identifier no cap covers must not hold the queue over its bound, held ${queue.bytes}`);
  assert.equal(queue.length, 1, "the event keeps its place; it is its detail that is given up");
  const [event] = queue.batch();
  assert.equal(event!.type, "TOOL_STARTED");
  assert.equal(event!.seq, 0, "with the account of what the Run did intact");
  assert.equal(event!.toolCallId, undefined, "the identifiers are detail and go with the payload");
  assert.equal(event!.providerEventId, undefined);
});

test("coalescing keeps the account of an event the API refused", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 900, maxEvents: 2, batchMaxEvents: 1_000 });
  queue.push(lifecycle("FINAL_OUTPUT"));
  assert.equal(queue.reject(0, "payload-too-large"), true);
  // Protected traffic with nothing droppable left forces the rejection record
  // itself into a merge.
  for (let index = 0; index < 50; index += 1) {
    queue.push({ source: "CLAUDE", type: "ADAPTER_ERROR", payload: { error: "e".repeat(200) } });
  }

  const held = queue.batch();
  assert.equal(
    held.filter((event) => event.type === EVENT_REJECTED_EVENT_TYPE).length,
    0,
    "the rejection record was merged like any other marker",
  );
  const merged = held.filter((event) => event.type === EVENTS_COALESCED_EVENT_TYPE)
    .map((event) => event.payload as { rejectedEvents?: number; lastRejectedSeq?: number });
  assert.equal(
    merged.reduce((total, payload) => total + (payload.rejectedEvents ?? 0), 0),
    1,
    "the durable stream still records that the API forced an event out",
  );
  assert.ok(merged.some((payload) => payload.lastRejectedSeq === 0), "naming the event it refused");
});

test("rejecting a merged marker carries the account it stood for into what remains", () => {
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 900, maxEvents: 2, batchMaxEvents: 1_000 });
  for (let index = 0; index < 20; index += 1) queue.push(chunk("d".repeat(300)));
  for (let index = 0; index < 50; index += 1) {
    queue.push({ source: "CLAUDE", type: "ADAPTER_ERROR", payload: { error: "e".repeat(200) } });
  }
  const head = queue.batch()[0]!;
  assert.equal(head.type, EVENTS_COALESCED_EVENT_TYPE, "an outage leaves a merged marker at the head");
  const stood = head.payload as { coalescedEvents: number; droppedEvents: number };
  assert.ok(stood.coalescedEvents > 1 && stood.droppedEvents > 0);

  assert.equal(queue.reject(head.seq, "request-too-large"), true);
  const remaining = queue.batch();
  const account = remaining.map((event) => event.payload as { coalescedEvents?: number; droppedEvents?: number });
  assert.ok(
    account.reduce((total, payload) => total + (payload.coalescedEvents ?? 1), 0) >= stood.coalescedEvents,
    "a refused marker does not take the events it stood for with it",
  );
  assert.ok(
    account.reduce((total, payload) => total + (payload.droppedEvents ?? 0), 0) >= stood.droppedEvents,
    "nor the drops it was the only record of",
  );
});

test("push does not cost the length of the protected prefix ahead of the droppable tail", () => {
  // The state this feature exists for: an outage piles protected entries up at
  // the head while the provider keeps streaming into the tail. Finding the
  // oldest droppable entry must not mean walking that prefix once per token.
  const pushCost = (prefix: number): number => {
    const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 1_024 * 1_024 * 1_024, maxEvents: prefix + 200 });
    for (let index = 0; index < prefix; index += 1) {
      queue.push({ source: "CLAUDE", type: "ADAPTER_ERROR", payload: { error: "e" } });
    }
    for (let index = 0; index < 200; index += 1) queue.push(chunk("x".repeat(50)));
    const started = process.hrtime.bigint();
    for (let index = 0; index < 20_000; index += 1) queue.push(chunk("x".repeat(50)));
    return Number(process.hrtime.bigint() - started);
  };

  pushCost(100);
  const shallow = pushCost(100);
  const deep = pushCost(20_000);
  assert.ok(
    deep < shallow * 10,
    `a 200x deeper protected prefix must not make the hot path 200x slower: ${shallow}ns shallow, ${deep}ns deep`,
  );
});

test("the bound holds again as soon as a rejection settles the batch that suspended it", () => {
  // The bound is tight enough that the queue is at it when the batch forms, so
  // the record of the rejection has to displace something to fit.
  const queue = createSessionEventQueue({ nextSeq: 0, maxBytes: 2_530 });
  for (let index = 0; index < 4; index += 1) queue.push(chunk("x".repeat(500)));
  queue.push(chunk("t"));
  const inFlight = queue.batch();
  assert.equal(inFlight.length, 5, "the whole queue is in flight");

  // The request settles by naming one of its events: nothing is in flight any
  // more, so the exemption the batch held ends with the request.
  assert.equal(queue.reject(inFlight[4]!.seq, "payload-too-large"), true);
  assert.ok(
    queue.bytes <= 2_530,
    `a batch that has settled must not hold the queue over its byte bound, held ${queue.bytes}`,
  );

  const held = queue.batch();
  const record = held.find((event) => event.type === EVENT_REJECTED_EVENT_TYPE);
  assert.ok(record, "and the rejection is still recorded");
  assert.equal((record.payload as { rejectedSeq: number }).rejectedSeq, inFlight[4]!.seq);
});
