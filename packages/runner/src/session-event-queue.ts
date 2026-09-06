import {
  SESSION_EVENT_BATCH_MAX_BYTES,
  SESSION_EVENT_BATCH_MAX_EVENTS,
  SESSION_EVENT_PAYLOAD_MAX_BYTES,
  SESSION_EVENT_QUEUE_MAX_BYTES,
  SESSION_EVENT_QUEUE_MAX_EVENTS,
  jsonByteLength,
  sessionEventPayloadTooLarge,
  truncateSessionEventPayload,
} from "@anneal/db/session-event-limits";

import type { AdapterEvent } from "./adapters.js";
import type { SessionEventPayload } from "./api.js";

/**
 * The undelivered session events of one Run, bounded in bytes and in count.
 *
 * The queue exists because delivery is detached from lease renewal: a Run whose
 * event writes keep failing stays leased and keeps producing events, and before
 * this bound the queue grew until the process died — sooner with several
 * runners on one host. Bounding it means choosing what to lose. Streaming
 * deltas, raw provider frames and captured stderr are liveness detail and are
 * dropped oldest-first; lifecycle, tool, error and terminal events are the
 * record of what the Run did and are never dropped, so a queue made entirely of
 * those may exceed the bound rather than lose the account of the Run.
 *
 * Every loss is itself an event: `EVENTS_DROPPED` for memory pressure and
 * `EVENT_REJECTED` for the single event the API refused. Order is untouched for
 * the events that survive.
 */

/** Event types the queue may drop under memory pressure. */
export const DROPPABLE_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "MODEL_DELTA",
  "PROVIDER_RAW",
  "STDERR",
]);

/** Synthetic record of events the byte or count bound forced out of the queue. */
export const EVENTS_DROPPED_EVENT_TYPE = "EVENTS_DROPPED";

/** Synthetic record of the one event an API refusal named. */
export const EVENT_REJECTED_EVENT_TYPE = "EVENT_REJECTED";

type Entry = {
  event: SessionEventPayload;
  bytes: number;
  droppable: boolean;
};

export type SessionEventQueueOptions = {
  /** First sequence number this Run may write, from the claim. */
  nextSeq: number;
  maxBytes?: number;
  maxEvents?: number;
  batchMaxBytes?: number;
  batchMaxEvents?: number;
  payloadMaxBytes?: number;
  now?: () => Date;
};

export type SessionEventQueue = {
  /** Enqueue one adapter event, truncating and bounding as this queue's policy requires. */
  push: (event: AdapterEvent) => void;
  /** The head events that fit one append request, by count and by bytes. */
  batch: () => SessionEventPayload[];
  /** Forget the first `count` events, which the API has accepted. */
  release: (count: number) => void;
  /** Drop the event the API refused by sequence number; false when it is already gone. */
  reject: (seq: number, reason: string) => boolean;
  /** Undelivered events currently held. */
  readonly length: number;
  /** Undelivered bytes currently held, as reported in the heartbeat. */
  readonly bytes: number;
};

export const createSessionEventQueue = (options: SessionEventQueueOptions): SessionEventQueue => {
  const maxBytes = options.maxBytes ?? SESSION_EVENT_QUEUE_MAX_BYTES;
  const maxEvents = options.maxEvents ?? SESSION_EVENT_QUEUE_MAX_EVENTS;
  const batchMaxBytes = options.batchMaxBytes ?? SESSION_EVENT_BATCH_MAX_BYTES;
  const batchMaxEvents = options.batchMaxEvents ?? SESSION_EVENT_BATCH_MAX_EVENTS;
  const payloadMaxBytes = options.payloadMaxBytes ?? SESSION_EVENT_PAYLOAD_MAX_BYTES;
  const now = options.now ?? ((): Date => new Date());

  const entries: Entry[] = [];
  let seq = options.nextSeq;
  let bytes = 0;
  /** The one undelivered drop record, accumulated into rather than duplicated. */
  let dropRecord: Entry | null = null;

  const entryFor = (event: SessionEventPayload, droppable: boolean): Entry =>
    ({ event, bytes: jsonByteLength(event), droppable });

  const append = (entry: Entry): void => {
    entries.push(entry);
    bytes += entry.bytes;
  };

  const runnerEvent = (type: string, payload: Record<string, unknown>): SessionEventPayload => ({
    seq: seq++,
    at: now().toISOString(),
    source: "RUNNER",
    type,
    payload,
  });

  const recordDrop = (
    droppedEvents: number,
    droppedBytes: number,
    firstSeq: number,
    lastSeq: number,
  ): void => {
    if (dropRecord) {
      // One record per delivery, not per drop: under sustained pressure a
      // record per dropped event would itself be undroppable queue growth.
      const payload = dropRecord.event.payload as { droppedEvents: number; droppedBytes: number; lastDroppedSeq: number };
      payload.droppedEvents += droppedEvents;
      payload.droppedBytes += droppedBytes;
      payload.lastDroppedSeq = lastSeq;
      bytes -= dropRecord.bytes;
      dropRecord.bytes = jsonByteLength(dropRecord.event);
      bytes += dropRecord.bytes;
      return;
    }
    // Appending the record can put the queue a few hundred bytes back over the
    // bound. That is deliberate: re-entering the drop loop to make room for the
    // record of a drop cannot terminate usefully.
    dropRecord = entryFor(runnerEvent(EVENTS_DROPPED_EVENT_TYPE, {
      reason: "queue-bound",
      droppedEvents,
      droppedBytes,
      firstDroppedSeq: firstSeq,
      lastDroppedSeq: lastSeq,
      queueMaxBytes: maxBytes,
      queueMaxEvents: maxEvents,
    }), false);
    append(dropRecord);
  };

  const enforceBound = (): void => {
    let droppedEvents = 0;
    let droppedBytes = 0;
    let firstSeq = 0;
    let lastSeq = 0;
    while (bytes > maxBytes || entries.length > maxEvents) {
      const index = entries.findIndex((entry) => entry.droppable);
      if (index === -1) break;
      const [removed] = entries.splice(index, 1) as [Entry];
      bytes -= removed.bytes;
      droppedBytes += removed.bytes;
      if (droppedEvents === 0) firstSeq = removed.event.seq;
      lastSeq = removed.event.seq;
      droppedEvents += 1;
    }
    if (droppedEvents > 0) recordDrop(droppedEvents, droppedBytes, firstSeq, lastSeq);
  };

  return {
    push: (event) => {
      const truncated = sessionEventPayloadTooLarge(event.payload, payloadMaxBytes);
      append(entryFor({
        seq: seq++,
        at: now().toISOString(),
        source: event.source,
        type: event.type,
        // Truncating here rather than letting the API refuse it keeps the
        // per-event cap from ever failing a whole batch.
        payload: truncated
          ? { ...truncateSessionEventPayload(event.payload, payloadMaxBytes) }
          : event.payload,
        ...(event.providerEventId !== undefined ? { providerEventId: event.providerEventId } : {}),
        ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
      }, DROPPABLE_SESSION_EVENT_TYPES.has(event.type)));
      enforceBound();
    },
    batch: () => {
      const batch: SessionEventPayload[] = [];
      let size = 0;
      for (const entry of entries) {
        if (batch.length >= batchMaxEvents) break;
        if (batch.length > 0 && size + entry.bytes > batchMaxBytes) break;
        batch.push(entry.event);
        size += entry.bytes;
      }
      return batch;
    },
    release: (count) => {
      for (const entry of entries.splice(0, count)) {
        bytes -= entry.bytes;
        if (entry === dropRecord) dropRecord = null;
      }
    },
    reject: (seq_, reason) => {
      const index = entries.findIndex((entry) => entry.event.seq === seq_);
      if (index === -1) return false;
      const [removed] = entries.splice(index, 1) as [Entry];
      bytes -= removed.bytes;
      if (removed === dropRecord) dropRecord = null;
      // Never record the rejection of a record. An API that refuses everything
      // would otherwise trade each rejected marker for a fresh one and the
      // flush loop would never drain — the wedge this whole design exists to
      // rule out.
      if (removed.event.type === EVENT_REJECTED_EVENT_TYPE || removed.event.type === EVENTS_DROPPED_EVENT_TYPE) {
        return true;
      }
      append(entryFor(runnerEvent(EVENT_REJECTED_EVENT_TYPE, {
        reason,
        rejectedSeq: removed.event.seq,
        rejectedType: removed.event.type,
        rejectedBytes: removed.bytes,
      }), false));
      return true;
    },
    get length() { return entries.length; },
    get bytes() { return bytes; },
  };
};
