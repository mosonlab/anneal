import { processProviderEvent, type AdapterState, type AdapterEventParser, type ProviderEventPersistencePredicate } from "./runtime.js";

export type RecordedEvent = { type: string; payload: Record<string, unknown> };
export type TimedProviderEvent = { at: number; event: Record<string, unknown> };

/** Test-only replay with deterministic provider-arrival times. */
export const replayTranscriptAt = (
  state: AdapterState,
  transcript: readonly TimedProviderEvent[],
  parseEvent: AdapterEventParser,
  persistence: ProviderEventPersistencePredicate,
): RecordedEvent[] => {
  const events: RecordedEvent[] = [];
  for (const { at, event } of transcript) {
    const nativeDate = globalThis.Date;
    class FixedDate extends nativeDate {
      constructor(value?: string | number | Date) {
        super(value === undefined ? at : value);
      }

      static override now(): number {
        return at;
      }
    }
    globalThis.Date = FixedDate as unknown as DateConstructor;
    try {
      processProviderEvent(state, event, (recorded) => { events.push(recorded); }, parseEvent, persistence);
    } finally {
      globalThis.Date = nativeDate;
    }
  }
  return events;
};
