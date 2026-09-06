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
 * error events are the record of what the Run did and are kept while anything
 * else can be given up.
 *
 * A protected event is never shed, but it is not exempt from the bound either,
 * because a provider can produce protected events without limit too — one
 * `ADAPTER_ERROR` per unparsable line, a `TOOL_STARTED` per call. Once nothing
 * droppable is left, a protected event loses its payload — and the provider
 * identifiers no cap covers — to a `queue-bound` marker, keeping its sequence
 * number, type, source and time. That caps what
 * one protected event costs but not how many of them there are, so once every
 * unclaimed entry is a marker the two oldest adjacent markers merge into one
 * carrying their summed counts and their spanning sequence range, repeating
 * until both bounds hold. What a protected event gives up is its detail, never
 * its account: the queue an unreachable API leaves behind is O(1) in the number
 * of protected events it saw, and every one of them is still counted, in
 * aggregate, in a marker the control plane receives.
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

/**
 * Synthetic record standing in for a run of adjacent protected events whose
 * payloads were already given up and whose markers the bound then merged.
 *
 * It carries what survives merging: how many queue entries it accounts for, the
 * inclusive sequence range they spanned, and the drop totals of any
 * `EVENTS_DROPPED` record it absorbed — those count events that are no longer
 * in the queue at all, so letting them merge away would lose them from the
 * account entirely. Everything else an absorbed marker held is one more unit of
 * `coalescedEvents`.
 */
export const EVENTS_COALESCED_EVENT_TYPE = "EVENTS_COALESCED";

/** The `null` standing in for the payload while the envelope alone is measured. */
const NULL_JSON_BYTES = 4;

type Entry = {
  event: SessionEventPayload;
  bytes: number;
  droppable: boolean;
  /** In the batch currently being delivered, and so neither droppable nor mutable. */
  claimed: boolean;
  /**
   * Already reduced to its `truncated` marker, or a queue record whose counts
   * are the whole point of it. Either way there is nothing left to give up
   * short of the event itself.
   */
  degraded: boolean;
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
   * A lower bound on the position of the oldest droppable unclaimed entry.
   *
   * The bound is enforced on every `push`, so searching the whole queue for the
   * next entry to drop would make the hot path cost the length of the queue —
   * worst in exactly the state this feature exists for, where an outage has
   * piled up protected entries ahead of the droppable tail. Dropping the entry
   * found at `index` leaves the next droppable one at or after it, so the
   * search resumes there. Every other mutation only lowers the hint, which is
   * always safe: a hint that is too low costs a scan, never a missed entry.
   */
  let oldestDroppable = 0;

  /** Keep the hint at or before `index`, the position a mutation disturbs. */
  const lowerHint = (index: number): void => {
    if (index < oldestDroppable) oldestDroppable = index;
  };

  /**
   * Envelope plus payload rather than one pass over the whole event: `push` is
   * the runner's hottest path — one call per streaming token — and the payload
   * is already serialized to test it against the per-event cap.
   */
  const measure = (event: SessionEventPayload, payloadBytes: number): number =>
    jsonByteLength({ ...event, payload: null }) - NULL_JSON_BYTES + payloadBytes;

  const entryFor = (
    event: SessionEventPayload,
    droppable: boolean,
    payloadBytes: number,
    degraded = false,
  ): Entry => ({ event, bytes: measure(event, payloadBytes), droppable, claimed: false, degraded });

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
    // A queue record is born degraded: its payload is the account of what was
    // lost, so truncating it would erase the very thing it exists to carry.
    return entryFor(event, false, jsonByteLength(payload), true);
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
      payload.lastDroppedSeq = Math.max(payload.lastDroppedSeq, lastSeq);
      bytes -= dropRecord.bytes;
      dropRecord.bytes = measure(dropRecord.event, jsonByteLength(payload));
      bytes += dropRecord.bytes;
      return;
    }
    // Opened from inside the drop loop, so the entry and the few hundred bytes
    // it costs are paid for by the same loop as everything else rather than
    // appended to a queue that had just reached its bound.
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

  /**
   * Reduce a protected event to its queue-pressure marker.
   *
   * The event keeps its sequence number, type, source and time, so the shape of
   * what the Run did survives; what it loses is the detail. That includes
   * `providerEventId` and `toolCallId`: they are detail like the payload, and
   * nothing caps what a provider puts in them, so leaving them would leave an
   * entry that degradation cannot bring under the byte bound at all.
   *
   * The marker names its own cause rather than reusing the per-event cap's
   * shape, which would report a `limitBytes` of zero for a cap that was never
   * reached. An already-truncated payload keeps the original size it recorded
   * rather than reporting the cap marker's own.
   */
  const degrade = (entry: Entry): void => {
    entry.degraded = true;
    const current = entry.event.payload as { truncated?: unknown; originalBytes?: unknown };
    const payload = {
      truncated: true,
      reason: "queue-bound",
      originalBytes: current?.truncated === true && typeof current.originalBytes === "number"
        ? current.originalBytes
        : jsonByteLength(entry.event.payload),
      queueMaxBytes: maxBytes,
    };
    const reduced: SessionEventPayload = {
      seq: entry.event.seq,
      ...(entry.event.at !== undefined ? { at: entry.event.at } : {}),
      source: entry.event.source,
      type: entry.event.type,
      payload,
    };
    const reducedBytes = measure(reduced, jsonByteLength(payload));
    // A payload smaller than the marker exists; replacing it would spend bytes
    // to save them. The entry is still marked degraded so the loop advances.
    if (reducedBytes >= entry.bytes) return;
    // Replaced rather than mutated, and only ever for an unclaimed entry: the
    // event object a request is carrying is the identity `release` matches on.
    entry.event = reduced;
    bytes -= entry.bytes - reducedBytes;
    entry.bytes = reducedBytes;
  };

  /**
   * What one entry accounts for, so merging two of them can sum it.
   *
   * Beyond the events it stands for, an entry may carry an account no other
   * entry holds: the events a drop record says are already gone, and the events
   * a rejection record says the API refused. Merging must carry both forward or
   * the merge would erase the very losses the queue exists to report.
   */
  const accountOf = (entry: Entry): {
    events: number;
    firstSeq: number;
    lastSeq: number;
    droppedEvents: number;
    droppedBytes: number;
    rejectedEvents: number;
    lastRejectedSeq: number;
  } => {
    const payload = entry.event.payload as Record<string, unknown>;
    const number = (value: unknown): number => (typeof value === "number" ? value : 0);
    // An entry that already stands for a merged span says so, whether it is an
    // `EVENTS_COALESCED` marker or the rejection record that replaced one.
    const merged = number(payload.coalescedEvents);
    const rejection = entry.event.type === EVENT_REJECTED_EVENT_TYPE;
    return {
      events: merged > 0 ? merged : 1,
      firstSeq: merged > 0 ? number(payload.firstSeq) : entry.event.seq,
      lastSeq: merged > 0 ? number(payload.lastSeq) : entry.event.seq,
      droppedEvents: entry.event.type === EVENTS_DROPPED_EVENT_TYPE || merged > 0 ? number(payload.droppedEvents) : 0,
      droppedBytes: entry.event.type === EVENTS_DROPPED_EVENT_TYPE || merged > 0 ? number(payload.droppedBytes) : 0,
      rejectedEvents: (rejection ? 1 : 0) + number(payload.rejectedEvents),
      lastRejectedSeq: Math.max(
        rejection ? number(payload.rejectedSeq) : 0,
        number(payload.lastRejectedSeq),
      ),
    };
  };

  /**
   * Merge the two oldest adjacent unclaimed markers into one; false when no
   * such pair exists.
   *
   * Adjacency is in the queue, not merely among candidates: a claimed entry
   * between two markers holds a sequence number the request in flight will
   * deliver, and a merged range spanning it would count that event twice. The
   * merged entry keeps the older marker's sequence number and time, so it keeps
   * its place in the order and the ranges of the surviving markers stay
   * contiguous with no gap between them.
   */
  const coalesceOldestPair = (): boolean => {
    for (let index = 0; index + 1 < entries.length; index += 1) {
      const left = entries[index] as Entry;
      const right = entries[index + 1] as Entry;
      if (left.claimed || right.claimed || !left.degraded || !right.degraded) continue;
      const older = accountOf(left);
      const newer = accountOf(right);
      const rejectedEvents = older.rejectedEvents + newer.rejectedEvents;
      const payload = {
        reason: "queue-bound",
        coalescedEvents: older.events + newer.events,
        firstSeq: older.firstSeq,
        lastSeq: newer.lastSeq,
        droppedEvents: older.droppedEvents + newer.droppedEvents,
        droppedBytes: older.droppedBytes + newer.droppedBytes,
        // Carried only when there is a rejection to carry, so the marker every
        // pressured Run produces does not pay for the rare one.
        ...(rejectedEvents > 0
          ? { rejectedEvents, lastRejectedSeq: Math.max(older.lastRejectedSeq, newer.lastRejectedSeq) }
          : {}),
        queueMaxBytes: maxBytes,
        queueMaxEvents: maxEvents,
      };
      const merged = entryFor({
        seq: left.event.seq,
        ...(left.event.at !== undefined ? { at: left.event.at } : {}),
        source: "RUNNER",
        type: EVENTS_COALESCED_EVENT_TYPE,
        payload,
      }, false, jsonByteLength(payload), true);
      forget(left);
      forget(right);
      lowerHint(index);
      entries.splice(index, 2, merged);
      bytes += merged.bytes;
      return true;
    }
    return false;
  };

  /** The oldest entry the bound may drop, resuming from the hint; -1 when none. */
  const findDroppable = (): number => {
    for (let index = oldestDroppable; index < entries.length; index += 1) {
      const entry = entries[index] as Entry;
      if (entry.droppable && !entry.claimed) {
        oldestDroppable = index;
        return index;
      }
    }
    oldestDroppable = entries.length;
    return -1;
  };

  /**
   * The next thing to give up, cheapest first: a droppable liveness event, then
   * the payload of the oldest protected event, then the separate identity of
   * the two oldest adjacent markers. A protected event's account is never given
   * up. A claimed entry belongs to a request in flight and is not available
   * either: a queue whose entries are all claimed is the one state this returns
   * from still over a bound, and it lasts only until that request settles.
   *
   * The record of a drop is opened inside the loop, so it competes for room
   * with everything else instead of being appended to a queue that had just
   * reached its bound. Each iteration therefore removes an entry, reduces one,
   * or merges two, except the single iteration that trades a dropped event for
   * the record of it — so the loop still terminates, and it terminates with the
   * queue inside both bounds unless everything left in it is in flight.
   */
  const enforceBound = (): void => {
    while (bytes > maxBytes || entries.length > maxEvents) {
      const index = findDroppable();
      if (index === -1) {
        // Nothing droppable is left. The oldest protected event that still has
        // a payload gives it up for its marker; once none does, markers merge,
        // which costs one entry each time and so cannot run forever.
        const degradable = entries.find((entry) => !entry.claimed && !entry.degraded);
        if (degradable) {
          degrade(degradable);
          continue;
        }
        if (coalesceOldestPair()) continue;
        break;
      }
      const [removed] = entries.splice(index, 1) as [Entry];
      forget(removed);
      recordDrop(1, removed.bytes, removed.event.seq, removed.event.seq);
    }
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
      // Unclaiming can expose a droppable entry anywhere in the queue.
      oldestDroppable = 0;
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
        lowerHint(index);
      }
    },
    reject: (seq_, reason) => {
      const index = entries.findIndex((entry) => entry.event.seq === seq_);
      if (index === -1) return false;
      const [removed] = entries.splice(index, 1) as [Entry];
      forget(removed);
      lowerHint(index);
      // Never record the rejection of a record. An API that refuses everything
      // would otherwise trade each rejected marker for a fresh one and the
      // flush loop would never drain — the wedge this whole design exists to
      // rule out.
      if (removed.event.type === EVENT_REJECTED_EVENT_TYPE || removed.event.type === EVENTS_DROPPED_EVENT_TYPE) {
        return true;
      }
      // A merged marker stands for events that are in no other entry, so the
      // record of its rejection carries its account forward; refusing that
      // record in turn is the terminal case ruled out just above.
      const absorbed = accountOf(removed);
      const carried = removed.event.type === EVENTS_COALESCED_EVENT_TYPE
        ? {
          coalescedEvents: absorbed.events,
          firstSeq: absorbed.firstSeq,
          lastSeq: absorbed.lastSeq,
          droppedEvents: absorbed.droppedEvents,
          droppedBytes: absorbed.droppedBytes,
          ...(absorbed.rejectedEvents > 0
            ? { rejectedEvents: absorbed.rejectedEvents, lastRejectedSeq: absorbed.lastRejectedSeq }
            : {}),
        }
        : {};
      append(runnerEntry(EVENT_REJECTED_EVENT_TYPE, {
        reason,
        rejectedSeq: removed.event.seq,
        rejectedType: removed.event.type,
        rejectedBytes: removed.bytes,
        ...carried,
      }));
      // The record is one more entry against the same bound as any other.
      enforceBound();
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
