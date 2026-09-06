/**
 * The byte caps a session event crosses the runner/API boundary under, declared
 * once so neither side can be sized against a stale copy of the other.
 *
 * The two limits are designed together. The runner truncates any payload above
 * `SESSION_EVENT_PAYLOAD_MAX_BYTES` before it enqueues and forms batches under
 * `SESSION_EVENT_BATCH_MAX_BYTES`, so a batch it sends cannot be refused for one
 * oversized event; the API enforces the same per-event cap and reads at most
 * `SESSION_EVENTS_REQUEST_MAX_BYTES` of body. A refusal the API does raise names
 * the offending event's index, because the runner only removes events from its
 * queue once they are accepted: a named 413 costs exactly the event that caused
 * it, while an unnamed one leaves the runner nothing to lose and only the
 * option of sending a smaller batch until it fits.
 */

import { Buffer } from "node:buffer";

/** Largest `payload` one event may carry on the wire, measured as JSON bytes. */
export const SESSION_EVENT_PAYLOAD_MAX_BYTES = 256 * 1024;

/** Largest number of events one append request may carry. */
export const SESSION_EVENT_BATCH_MAX_EVENTS = 250;

/** Largest serialized size of the events one append request may carry. */
export const SESSION_EVENT_BATCH_MAX_BYTES = 1024 * 1024;

/**
 * Largest provider conversation identifier the events envelope may carry.
 *
 * Adapters copy this straight from provider output, so it is the one envelope
 * field a provider can grow. Capping it is what makes the overhead allowance
 * below an actual bound rather than an estimate: without it a long enough
 * identifier pushes a legal batch over the body cap, and the request is refused
 * for something no smaller batch can fix.
 */
export const SESSION_EVENT_CONVERSATION_ID_MAX_CHARS = 512;

/**
 * Room above the batch cap for the request envelope: runner id, fencing token,
 * provider conversation id, and the JSON punctuation joining 250 events.
 */
const SESSION_EVENTS_REQUEST_OVERHEAD_BYTES = 64 * 1024;

/** Largest events request body the API reads before refusing it unparsed. */
export const SESSION_EVENTS_REQUEST_MAX_BYTES =
  SESSION_EVENT_BATCH_MAX_BYTES + SESSION_EVENTS_REQUEST_OVERHEAD_BYTES;

/** Largest undelivered event queue a runner holds in memory for one Run. */
export const SESSION_EVENT_QUEUE_MAX_BYTES = 32 * 1024 * 1024;

/** Companion count bound, for a queue that fills with many small events. */
export const SESSION_EVENT_QUEUE_MAX_EVENTS = 20_000;

/** Refusal code of the per-event cap, which the runner reads off the 413 body. */
export const SESSION_EVENT_PAYLOAD_TOO_LARGE_CODE = "EVENT_PAYLOAD_TOO_LARGE";

/** Refusal code of the whole-body cap. */
export const SESSION_EVENTS_REQUEST_TOO_LARGE_CODE = "EVENTS_REQUEST_TOO_LARGE";

/** The serialized size of a value, in the bytes the wire actually carries. */
export const jsonByteLength = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");

/** The payload an event carries once its original exceeded the per-event cap. */
export type TruncatedSessionEventPayload = {
  truncated: true;
  originalBytes: number;
  limitBytes: number;
  preview: string;
};

export const sessionEventPayloadTooLarge = (
  payload: unknown,
  limitBytes: number = SESSION_EVENT_PAYLOAD_MAX_BYTES,
): boolean => jsonByteLength(payload) > limitBytes;

/**
 * The replacement payload for an event above the cap: the leading JSON of the
 * original, cut until the whole marker fits, beside the size it was cut from.
 *
 * The cut is on a UTF-16 code-unit boundary of the *serialized* payload, so the
 * preview is a JSON fragment rather than a value; it exists to keep the event
 * readable in the console, not to be reparsed. Escaping means a character can
 * cost more than one byte, hence the shrink loop rather than one slice.
 */
export const truncateSessionEventPayload = (
  payload: unknown,
  limitBytes: number = SESSION_EVENT_PAYLOAD_MAX_BYTES,
): TruncatedSessionEventPayload => {
  const serialized = JSON.stringify(payload) ?? "null";
  const marker: TruncatedSessionEventPayload = {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    limitBytes,
    preview: "",
  };
  const budget = limitBytes - jsonByteLength(marker);
  if (budget <= 0) return marker;

  let preview = serialized.slice(0, budget);
  let bytes = jsonByteLength({ ...marker, preview });
  while (bytes > limitBytes && preview.length > 0) {
    // Every removed code unit is worth at least one byte, so cutting the
    // overshoot terminates and usually settles in a single pass.
    preview = preview.slice(0, Math.max(0, preview.length - Math.max(1, bytes - limitBytes)));
    bytes = jsonByteLength({ ...marker, preview });
  }
  // A cut through a surrogate pair would leave a lone half; drop it rather than
  // emit an unpaired escape.
  const last = preview.charCodeAt(preview.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) preview = preview.slice(0, -1);
  return { ...marker, preview };
};
