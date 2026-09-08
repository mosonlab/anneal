import { isDeterministicAccessRefusal, isTransientTransportFailure } from "@anneal/db/transport-vocabulary";

/**
 * One vocabulary for the only question a failed GitHub write raises: **did it
 * land?**
 *
 * A write to GitHub has three possible fates, and conflating any two of them is
 * how a lost response becomes a duplicate operation:
 *
 *   applied  the platform committed the write and said so.
 *   refused  the platform answered, and the answer was "no". Nothing was
 *            written, and sending the same request again will get the same
 *            answer.
 *   lost     no answer arrived, or the answer cannot be read. The write may or
 *            may not have been committed on the far side.
 *
 * `lost` is the state the 2026-08-18 night produced five times over: an EOF on
 * a merge POST that had already merged. It is not an error class, it is an
 * *absence of information*, and the only thing that resolves it is a read-back.
 *
 * Misclassification is deliberately made cheap in both directions by
 * `confirmedWrite`: every non-applied outcome is read back before anything is
 * decided, and a resend needs a read-back that positively found nothing. So
 * calling a lost response `refused` costs a legitimate retry, and calling a
 * refusal `lost` costs one extra read. Neither costs a duplicate write.
 */

// A write can lose its response without a transport-specific symptom. These
// ambiguous terms require read-back here, but do not justify a Run refund.
const WRITE_RESPONSE_UNCERTAINTY_PATTERNS = [
  /\bEOF\b/,
  /timed out/i,
  /\bAbortError\b/,
  /\baborted\b/i,
] as const;

const messageOf = (subject: unknown): string =>
  subject instanceof Error ? `${subject.name}: ${subject.message}` : String(subject);

/** True when the far side answered, and the answer cannot be changed by asking again. */
export const isDeterministicRefusal = (subject: unknown): boolean =>
  isDeterministicAccessRefusal(messageOf(subject));

/**
 * True when this error leaves the write's fate unknown. A deterministic refusal
 * is never lost, however transient its wording sounds.
 */
export const isLostResponse = (subject: unknown): boolean => {
  const message = messageOf(subject);
  if (isDeterministicAccessRefusal(message)) return false;
  return isTransientTransportFailure(message)
    || WRITE_RESPONSE_UNCERTAINTY_PATTERNS.some((pattern) => pattern.test(message));
};

/** The sentinel `HttpAttempt.status` for "the request produced no response at all". */
export const NO_RESPONSE = -1;

export type ResponseClass = "applied" | "refused" | "lost";

/**
 * The HTTP half of the same three-way split.
 *
 * A 2xx is the only status that says the write happened. A 3xx is not an
 * answer to a write — it is the platform asking for the request to be made
 * somewhere else — and a 429 is an answer that may or may not have been
 * preceded by execution, so both are read back rather than assumed.
 */
export const classifyHttpStatus = (status: number): ResponseClass => {
  if (status === NO_RESPONSE || status < 100) return "lost";
  if (status >= 200 && status < 300) return "applied";
  if (status === 408 || status === 425 || status === 429) return "lost";
  if (status >= 400 && status < 500) return "refused";
  return "lost";
};
