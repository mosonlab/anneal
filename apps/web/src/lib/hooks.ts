import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api, errorMessage } from "./api";
import { storage } from "./storage";

/** DECISIONS #16: realtime is polling. 2.5s matches the runner heartbeat cadence. */
export const POLL_MS = 2_500;

export type Poll<T> = {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  lastSuccessAt: string | null;
  reload: () => void;
};

/** Polls a GET endpoint. Pass `null` to stay idle (e.g. no project selected).
 *
 *  The poll is change-aware at two levels. The outer one is the HTTP validator:
 *  the held `ETag` rides out as `If-None-Match`, and a 304 ends the poll before
 *  a single byte of payload crosses the wire. The inner one is the body text,
 *  which still catches a control plane that mints no validator.
 *
 *  Both exist to protect the same thing. Most polls on a mostly-idle board
 *  return the same payload, and `setData` with a *new* array of *new* objects
 *  re-renders every consumer — 112 task cards, 24 times a minute, for no new
 *  information. Keeping the previous reference lets React bail out of the update
 *  entirely, and lets `React.memo` downstream mean something. Comparing the raw
 *  *text* also skips the `JSON.parse`, which was itself a long task. */
export const usePoll = <T>(path: string | null, intervalMs = POLL_MS): Poll<T> => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null);
  const [resourcePath, setResourcePath] = useState<string | null>(path);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  const generation = useRef(0);
  const renderedPath = useRef(path);
  const heldPath = useRef(path);
  /** The serialization of whatever `data` currently holds, or `null` when the
   *  held value cannot be trusted to match the path being polled. */
  const held = useRef<string | null>(null);
  /** The validator that came with `held`, sent back as `If-None-Match`. */
  const tag = useRef<string | null>(null);

  // Effects run after paint. Advance the generation during render so the first
  // destination frame cannot expose source state and an old response resolving
  // before cleanup still cannot commit.
  if (renderedPath.current !== path) {
    renderedPath.current = path;
    generation.current += 1;
  }

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const requestGeneration = generation.current;
    const pathChanged = heldPath.current !== path;
    heldPath.current = path;
    setResourcePath(path);
    if (path === null) {
      held.current = null;
      tag.current = null;
      setData(null);
      setError(null);
      setLoading(false);
      setLastSuccessAt(null);
      return;
    }
    if (pathChanged) {
      setData(null);
      setError(null);
      setLastSuccessAt(null);
    }
    // A new path — or a `reload()` — invalidates the held payload: the next
    // response must land even if it happens to serialize the same. The validator
    // goes with it, or the server would answer 304 to a caller holding nothing.
    held.current = null;
    tag.current = null;
    let cancelled = false;
    setLoading(true);
    const load = async (): Promise<void> => {
      if (document.hidden) return;
      try {
        const polled = await api.poll(path, tag.current);
        if (cancelled || !alive.current || generation.current !== requestGeneration) return;
        tag.current = polled.etag;
        if (polled.changed && polled.body !== held.current) {
          held.current = polled.body;
          setData(polled.body.length > 0 ? (JSON.parse(polled.body) as T) : null);
        }
        setError(null);
        setLastSuccessAt(new Date().toISOString());
      } catch (reason: unknown) {
        if (cancelled || !alive.current || generation.current !== requestGeneration) return;
        setError(reason instanceof ApiError ? reason : new ApiError(0, path, String(reason)));
      } finally {
        if (!cancelled && alive.current && generation.current === requestGeneration) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [path, intervalMs, nonce]);

  const reload = useCallback(() => {
    generation.current += 1;
    setNonce((value) => value + 1);
  }, []);
  if (resourcePath !== path) {
    return {
      data: null,
      error: null,
      loading: path !== null,
      lastSuccessAt: null,
      reload,
    };
  }
  return { data, error, loading, lastSuccessAt, reload };
};

/** Wraps a write call with pending/error state and a caller-supplied refresh. */
export const useAction = (): {
  pending: boolean;
  error: string | null;
  clearError: () => void;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
} => {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (reason: unknown) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, error, clearError: useCallback(() => setError(null), []), run };
};

export const useLocalStorage = (key: string, fallback: string): [string, (value: string) => void] => {
  const [value, setValue] = useState(() => storage.get(key) ?? fallback);
  const update = useCallback((next: string) => {
    storage.set(key, next);
    setValue(next);
  }, [key]);
  return [value, update];
};

/**
 * A media query as state, so a page can render one layout instead of both.
 *
 * The Tasks board is the caller: its desktop and phone shells are different DOM,
 * not one DOM with different CSS, and rendering both would put every card on the
 * page twice. Defaults to `false` where there is no `window` — the tests render
 * to static markup, and the desktop board is the shape they assert.
 */
export const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(() => (
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? false
      : window.matchMedia(query).matches
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const handler = (): void => setMatches(list.matches);
    handler();
    list.addEventListener("change", handler);
    return () => list.removeEventListener("change", handler);
  }, [query]);
  return matches;
};
