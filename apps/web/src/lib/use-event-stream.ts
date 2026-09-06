import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "./api";
import { POLL_MS } from "./hooks";
import type { SessionEvent } from "./types";

/* The polling contract for the session event stream. It sits beside `usePoll`
 * rather than inside it: `usePoll` replaces its data on every response and
 * clears it when the path goes null, neither of which an append-only,
 * self-stopping stream can use. hooks.ts is deliberately untouched. */

export const EVENT_PAGE = 500;
/** 40 × 500 = 20 000 rendered events. A single retunable constant. */
export const EVENT_PAGE_CEILING = 40;
export const BACKOFF_AFTER_EMPTY = 4;
export const BACKOFF_CEILING_MS = 15_000;

export type EventPage = {
  events: SessionEvent[];
  hasMore: boolean;
  total: number;
};

/** 2.5 s while anything is happening; after four consecutive empty polls the
 *  delay doubles per empty poll up to a 15 s ceiling. Any new event resets the
 *  counter to 0. */
export const nextIntervalMs = (emptyPolls: number): number => {
  if (emptyPolls < BACKOFF_AFTER_EMPTY) return POLL_MS;
  return Math.min(POLL_MS * 2 ** (emptyPolls - (BACKOFF_AFTER_EMPTY - 1)), BACKOFF_CEILING_MS);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The event route has one supported response shape. Parse it at the network
 * boundary so a changed or malformed response fails loudly rather than being
 * rendered as an incomplete transcript. */
const parseEventPage = (body: unknown): EventPage => {
  if (!isRecord(body)
    || !Array.isArray(body.events)
    || typeof body.hasMore !== "boolean"
    || typeof body.total !== "number"
    || !Number.isInteger(body.total)
    || body.total < 0) {
    throw new Error("Invalid session event page response");
  }
  return { events: body.events as SessionEvent[], hasMore: body.hasMore, total: body.total };
};

export const useEventStream = (runId: string | null, terminal: boolean): {
  events: SessionEvent[];
  total: number;
  capped: boolean;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
} => {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(runId !== null);
  const [nonce, setNonce] = useState(0);
  const terminalRef = useRef(terminal);
  terminalRef.current = terminal;
  /** Survives a `reload()`, so reloading resumes the stream rather than
   *  re-downloading and re-rendering the whole history. Reset only when the run
   *  changes. */
  const highestSeqRef = useRef<number | null>(null);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (runId === null) return;
    if (runIdRef.current !== runId) {
      runIdRef.current = runId;
      highestSeqRef.current = null;
      setEvents([]);
      setTotal(0);
      setCapped(false);
      setError(null);
    }
    setLoading(true);

    let cancelled = false;
    let timer = 0;
    let pages = 0;
    let emptyPolls = 0;

    const fetchPage = async (): Promise<EventPage | null> => {
      const afterSeq = highestSeqRef.current;
      const query = `?limit=${EVENT_PAGE}${afterSeq === null ? "" : `&afterSeq=${afterSeq}`}`;
      const body = await api.get<unknown>(`/runs/${runId}/events${query}`);
      return cancelled ? null : parseEventPage(body);
    };

    const absorb = (page: EventPage): number => {
      // Dedup by seq: unique and ascending per session, so one comparison is
      // enough. Keep this guard for an overlapping page after a reload().
      const held = highestSeqRef.current;
      const fresh = page.events.filter((row) => held === null || row.seq > held);
      setTotal(page.total);
      if (fresh.length > 0) {
        highestSeqRef.current = fresh[fresh.length - 1]?.seq ?? held;
        setEvents((current) => [...current, ...fresh]);
      }
      return fresh.length;
    };

    const schedule = (delay: number): void => {
      if (cancelled) return;
      timer = window.setTimeout(() => void tick(), delay);
    };

    const tick = async (): Promise<void> => {
      // Matches usePoll: a hidden tab issues no requests but keeps its timer.
      if (document.hidden) { schedule(nextIntervalMs(emptyPolls)); return; }
      try {
        const page = await fetchPage();
        if (page === null || cancelled) return;
        const fresh = absorb(page);
        setError(null);
        emptyPolls = fresh > 0 ? 0 : emptyPolls + 1;

        // Initial drain: keep pulling while the server says there is more.
        if (page.hasMore) {
          pages += 1;
          if (pages >= EVENT_PAGE_CEILING) { setCapped(true); setLoading(false); return; }
          schedule(0);
          return;
        }
        setLoading(false);
        // Hard stop: a terminal session that has nothing more to give is done.
        if (terminalRef.current && fresh === 0) return;
        schedule(nextIntervalMs(emptyPolls));
      } catch (reason: unknown) {
        if (cancelled) return;
        // A failed poll keeps every event already held and keeps polling.
        setError(reason instanceof ApiError ? reason : new ApiError(0, `/runs/${runId}/events`, String(reason)));
        setLoading(false);
        emptyPolls += 1;
        schedule(nextIntervalMs(emptyPolls));
      }
    };

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [runId, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { events, total, capped, error, loading, reload };
};
