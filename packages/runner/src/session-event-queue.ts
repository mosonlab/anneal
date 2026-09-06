import {
  SESSION_EVENT_BATCH_MAX_BYTES,
  SESSION_EVENT_BATCH_MAX_EVENTS,
  SESSION_EVENT_PAYLOAD_MAX_BYTES,
  SESSION_EVENT_QUEUE_MAX_BYTES,
  SESSION_EVENT_QUEUE_MAX_EVENTS,
  jsonByteLength,
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
 * deltas, raw provider frames, captured stderr, provider status and tool output
 * are liveness detail and are dropped oldest-first; lifecycle, terminal and
 * error events are the record of what the Run did and are never dropped, so a
 * queue made entirely of those may exceed the bound rather than lose the
 * account of the Run. Those are a bounded few per Run, unlike the streaming and
 * tool traffic that actually fills memory.
 *
 * A batch is *claimed* from the moment it is formed until its request settles.
 * A claimed entry is never dropped and never accumulated into: the queue is
 * mutated by the provider's synchronous callback while an append is in flight,
 * and dropping something the API is about to accept would lose it with no
 * record and release it as if it had been sent.
 *
 * Every loss is itself an event: `EVENTS_DROPPED` for memory pressure and
 * `EVENT_REJECTED` for the single event the API refused. Order is untouched for
 * the events that survive.
 */

/**
 * Event types the queue may drop under memory pressure.
 *
 * Tool output and provider status belong here beside the streaming types: a
 * tool result carries a file read or a command's stdout and is the largest
 * event a Run produces, so leaving it undroppable left the bound unenforceable
 * on exactly the runs that need it. `TOOL_STARTED`, `TOOL_FAILED`,
 * `ADAPTER_ERROR`, `FINAL_OUTPUT` and the lifecycle types stay undroppable.
 */
export const DROPPABLE_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "MODEL_DELTA",
  "PROVIDER_RAW",
  "PROVIDER_STATUS",
  "STDERR",
  "TOOL_COMPLETED",
  "TOOL_PROGRESS",
]);

/** Synthetic record of events the byte or count bound forced out of the queue. */
export const EVENTS_DROPPED_EVENT_TYPE = "EVENTS_DROPPED";

/** Synthetic record of the one event an API refusal named. */
export const EVENT_REJECTED_EVENT_TYPE = "EVENT_REJECTED";

/** The `null` standing in for the payload while the envelope alone is measured. */
const NULL_JSON_BYTES = 4;

type Entry = {
  event: SessionEventPayload;
  bytes: number;
  droppable: boolean;
  /** In the batch currently being delivered, and so neither droppable nor mutable. */
  claimed: boolean;
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
  /** The head events that fit one append request, by count and by bytes, claimed until released. */
  batch: () => SessionEventPayload[];
  /** Forget exactly these events, which the API has accepted. */
  release: (events: readonly SessionEventPayload[]) => void;
  /** Drop the event the API refused by sequence number; false when it is already gone. */
  reject: (seq: number, reason: string) => boolean;
  /** Halve the batch budget after a whole-request refusal; false once a batch is one event. */
  reduceBatch: () => boolean;
  /** Undelivered events currently held. */
  readonly length: number;
  /** Undelivered bytes currently held, as reported in the heartbeat. */
  readonly bytes: number;
};

export const createSessionEventQueue = (options: SessionEventQueueOptions): SessionEventQueue => {
  const maxBytes = options.maxBytes ?? SESSION_EVENT_QUEUE_MAX_BYTES;
  const maxEvents = options.maxEvents ?? SESSION_EVENT_QUEUE_MAX_EVENTS;
  const payloadMaxBytes = options.payloadMaxBytes ?? SESSION_EVENT_PAYLOAD_MAX_BYTES;
  const now = options.now ?? ((): Date => new Date());
  let batchMaxBytes = options.batchMaxBytes ?? SESSION_EVENT_BATCH_MAX_BYTES;
  let batchMaxEvents = options.batchMaxEvents ?? SESSION_EVENT_BATCH_MAX_EVENTS;

  const entries: Entry[] = [];
  let seq = options.nextSeq;
  let bytes = 0;
  /** The one unclaimed drop record, accumulated into rather than duplicated. */
  let dropRecord: Entry | null = null;

  /**
   * Envelope plus payload rather than one pass over the whole event: `push` is
   * the runner's hottest path — one call per streaming token — and the payload
   * is already serialized to test it against the per-event cap.
   */
  const measure = (event: SessionEventPayload, payloadBytes: number): number =>
    jsonByteLength({ ...event, payload: null }) - NULL_JSON_BYTES + payloadBytes;

  const entryFor = (event: SessionEventPayload, droppable: boolean, payloadBytes: number): Entry =>
    ({ event, bytes: measure(event, payloadBytes), droppable, claimed: false });

  const append = (entry: Entry): void => {
    entries.push(entry);
    bytes += entry.bytes;
  };

  const forget = (entry: Entry): void => {
    bytes -= entry.bytes;
    if (entry === dropRecord) dropRecord = null;
  };

  const runnerEvent = (type: string, payload: Record<string, unknown>): SessionEventPayload => ({
    seq: seq++,
    at: now().toISOString(),
    source: "RUNNER",
    type,
    payload,
  });

  const runnerEntry = (type: string, payload: Record<string, unknown>): Entry => {
    const event = runnerEvent(type, payload);
    return entryFor(event, false, jsonByteLength(payload));
  };

  const recordDrop = (
    droppedEvents: number,
    droppedBytes: number,
    firstSeq: number,
    lastSeq: number,
  ): void => {
    if (dropRecord && !dropRecord.claimed) {
      // One record per delivery, not per drop: under sustained pressure a
      // record per dropped event would itself be undroppable queue growth.
      // A claimed record is excluded because its counts are already serialized
      // into a request in flight; accumulating into it would report those
      // later drops to nobody.
      const payload = dropRecord.event.payload as { droppedEvents: number; droppedBytes: number; lastDroppedSeq: number };
      payload.droppedEvents += droppedEvents;
      payload.droppedBytes += droppedBytes;
      payload.lastDroppedSeq = lastSeq;
      bytes -= dropRecord.bytes;
      dropRecord.bytes = measure(dropRecord.event, jsonByteLength(payload));
      bytes += dropRecord.bytes;
      return;
    }
    // Appending the record can put the queue a few hundred bytes back over the
    // bound. That is deliberate: re-entering the drop loop to make room for the
    // record of a drop cannot terminate usefully.
    dropRecord = runnerEntry(EVENTS_DROPPED_EVENT_TYPE, {
      reason: "queue-bound",
      droppedEvents,
      droppedBytes,
      firstDroppedSeq: firstSeq,
      lastDroppedSeq: lastSeq,
      queueMaxBytes: maxBytes,
      queueMaxEvents: maxEvents,
    });
    append(dropRecord);
  };

  const enforceBound = (): void => {
    let droppedEvents = 0;
    let droppedBytes = 0;
    let firstSeq = 0;
    let lastSeq = 0;
    while (bytes > maxBytes || entries.length > maxEvents) {
      const index = entries.findIndex((entry) => entry.droppable && !entry.claimed);
      if (index === -1) break;
      const [removed] = entries.splice(index, 1) as [Entry];
      forget(removed);
      droppedBytes += removed.bytes;
      if (droppedEvents === 0) firstSeq = removed.event.seq;
      lastSeq = removed.event.seq;
      droppedEvents += 1;
    }
    if (droppedEvents > 0) recordDrop(droppedEvents, droppedBytes, firstSeq, lastSeq);
  };

  return {
    push: (event) => {
      const payloadBytes = jsonByteLength(event.payload);
      // Truncating here rather than letting the API refuse it keeps the
      // per-event cap from ever failing a whole batch.
      const payload = payloadBytes > payloadMaxBytes
        ? { ...truncateSessionEventPayload(event.payload, payloadMaxBytes) }
        : event.payload;
      append(entryFor({
        seq: seq++,
        at: now().toISOString(),
        source: event.source,
        type: event.type,
        payload,
        ...(event.providerEventId !== undefined ? { providerEventId: event.providerEventId } : {}),
        ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
      }, DROPPABLE_SESSION_EVENT_TYPES.has(event.type),
      payload === event.payload ? payloadBytes : jsonByteLength(payload)));
      enforceBound();
    },
    batch: () => {
      const batch: SessionEventPayload[] = [];
      let size = 0;
      // At most one append is ever in flight, so forming a batch is also the
      // proof that the previous one has settled and may be dropped again.
      for (const entry of entries) entry.claimed = false;
      for (const entry of entries) {
        if (batch.length >= batchMaxEvents) break;
        if (batch.length > 0 && size + entry.bytes > batchMaxBytes) break;
        entry.claimed = true;
        batch.push(entry.event);
        size += entry.bytes;
      }
      return batch;
    },
    release: (released) => {
      // By identity, not by position: the provider's callback appends and the
      // bound drops entries while the request is in flight, so the accepted
      // events are no longer the first `released.length` of the queue.
      const accepted = new Set(released);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index] as Entry;
        if (!accepted.has(entry.event)) continue;
        entries.splice(index, 1);
        forget(entry);
      }
    },
    reject: (seq_, reason) => {
      const index = entries.findIndex((entry) => entry.event.seq === seq_);
      if (index === -1) return false;
      const [removed] = entries.splice(index, 1) as [Entry];
      forget(removed);
      // Never record the rejection of a record. An API that refuses everything
      // would otherwise trade each rejected marker for a fresh one and the
      // flush loop would never drain — the wedge this whole design exists to
      // rule out.
      if (removed.event.type === EVENT_REJECTED_EVENT_TYPE || removed.event.type === EVENTS_DROPPED_EVENT_TYPE) {
        return true;
      }
      append(runnerEntry(EVENT_REJECTED_EVENT_TYPE, {
        reason,
        rejectedSeq: removed.event.seq,
        rejectedType: removed.event.type,
        rejectedBytes: removed.bytes,
      }));
      return true;
    },
    reduceBatch: () => {
      // A whole-request refusal names no event, so the queue cannot know which
      // one to lose. Halving until a batch is one event finds out: whatever
      // still refuses a single event is that event's own problem, and the
      // caller drops it. Anything else — a proxy body limit, a peer carrying a
      // smaller cap — drains at the reduced size instead of retrying forever.
      if (batchMaxEvents <= 1 && batchMaxBytes <= 1) return false;
      batchMaxEvents = Math.max(1, Math.floor(batchMaxEvents / 2));
      batchMaxBytes = Math.max(1, Math.floor(batchMaxBytes / 2));
      return true;
    },
    get length() { return entries.length; },
    get bytes() { return bytes; },
  };
};
