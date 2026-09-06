/** Control-plane client.
 *
 *  One transport, always: the same-origin path `/api`, served by the Vite
 *  dev/preview server, which attaches the operator bearer token in its own
 *  process (DECISIONS #17: no login on localhost, and the token must not ship
 *  inside the bundle).
 *
 *  There is deliberately no direct-token path. `VITE_API_URL`/`VITE_API_TOKEN`
 *  used to switch this client to a cross-origin call carrying a bearer token
 *  that Vite had inlined into the bundle — which is a credential in the browser,
 *  readable by every script and extension on the page and by anyone who opens
 *  the built assets. `apps/web/src/tests/bundle-secrets.test.ts` fails the build
 *  if anything of that shape reappears in `dist`.
 */

/** Relative on purpose: it resolves against the page origin, so the request is
 *  same-origin and the browser never holds or sends a credential of its own. */
export const apiBase = "/api";

/**
 * How long any control-plane request may take before the client gives up.
 *
 * `fetch` has no timeout of its own: a connection that is accepted and then
 * never answered leaves the promise pending for as long as the socket lives.
 * That is what turned an API restart into a permanent Loading screen — the
 * bootstrap `GET /projects` overlapped the restart (observed 2026-08-28: the
 * dev proxy reported ETIMEDOUT at 05:09 and ECONNREFUSED through the 05:23
 * restart), `StartupGate` stayed in its pending state, and nothing on the page
 * could say so or offer a retry.
 *
 * 15s is well past a healthy localhost round trip, including the slowest
 * enriched board read, and well inside an operator's patience.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/** `ApiError.code` for a request the client abandoned. Not a status: nothing
 *  answered, so there is no status to report. */
export const TIMEOUT_CODE = "TIMEOUT";

export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly code: string | null;
  readonly reason: string | null;

  constructor(status: number, path: string, message: string, code: string | null = null, reason: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
    this.code = code;
    this.reason = reason;
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** The request was abandoned at `REQUEST_TIMEOUT_MS`, so the control plane
   *  never answered and retrying is the only thing left to offer. */
  get timedOut(): boolean {
    return this.code === TIMEOUT_CODE;
  }
}

const transportError = (path: string, reason: unknown): ApiError => (
  isTimeout(reason)
    ? new ApiError(0, path, `No answer within ${REQUEST_TIMEOUT_MS / 1_000}s`, TIMEOUT_CODE)
    : new ApiError(0, path, reason instanceof Error ? reason.message : "Network error")
);

const responseText = async (response: Response, path: string): Promise<string> => {
  try {
    return await response.text();
  } catch (reason: unknown) {
    throw transportError(path, reason);
  }
};

const parseError = async (response: Response, path: string): Promise<ApiError> => {
  const text = await responseText(response, path);
  let detail = text;
  let code: string | null = null;
  let reason: string | null = null;
  try {
    const parsed = JSON.parse(text) as { error?: string; code?: unknown; reason?: unknown; issues?: unknown };
    if (typeof parsed.error === "string") detail = parsed.error;
    if (typeof parsed.code === "string") code = parsed.code;
    if (typeof parsed.reason === "string") reason = parsed.reason;
  } catch {
    // Non-JSON error bodies (proxy failures, HTML) are surfaced verbatim.
  }
  return new ApiError(response.status, path, detail.slice(0, 400) || `HTTP ${response.status}`, code, reason);
};

/** `AbortSignal.timeout` rejects the fetch with a `TimeoutError`. Chromium may
 *  report `AbortError` when the same signal expires during a response body
 *  read; this client installs no other abort source, so both names mean its
 *  request bound fired. */
const isTimeout = (reason: unknown): boolean =>
  reason instanceof Error && (reason.name === "TimeoutError" || reason.name === "AbortError");

const requestRaw = async (path: string, init?: RequestInit): Promise<Response> => {
  try {
    return await fetch(`${apiBase}${path}`, {
      ...init,
      // Every request is bounded, polls included: a poll that never settles
      // holds a connection and its state for the life of the page.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (reason: unknown) {
    throw transportError(path, reason);
  }
};

const requestText = async (path: string, init?: RequestInit): Promise<string> => {
  const response = await requestRaw(path, init);
  if (!response.ok) throw await parseError(response, path);
  if (response.status === 204) return "";
  return responseText(response, path);
};

/** One poll's answer: whether anything arrived, and the validator to send next
 *  time. `changed: false` means the server said 304 and `body` is meaningless. */
export type Polled = { changed: boolean; body: string; etag: string | null };

/**
 * A conditional GET for the polling loop.
 *
 * Two layers, because they fail in different places. The `If-None-Match` header
 * is the good one: an unchanged `GET /tasks` costs a header exchange instead of
 * a payload, which on a full board is 1.58 MB the page never reads. The text
 * comparison in `usePoll` is the fallback for a control plane that mints no
 * validator — it still skips the `JSON.parse` and the re-render, just not the
 * transfer.
 *
 * `cache: "no-store"` so the browser's own HTTP cache never intercepts: with a
 * cached copy it would attach its own validator and hand back a synthesised 200,
 * and the caller could not tell a fresh payload from a replayed one.
 */
const requestPolled = async (path: string, etag: string | null): Promise<Polled> => {
  const response = await requestRaw(path, {
    cache: "no-store",
    ...(etag === null ? {} : { headers: { "If-None-Match": etag } }),
  });
  const nextTag = response.headers.get("ETag");
  if (response.status === 304) return { changed: false, body: "", etag: nextTag ?? etag };
  if (!response.ok) throw await parseError(response, path);
  if (response.status === 204) return { changed: true, body: "", etag: nextTag };
  return { changed: true, body: await responseText(response, path), etag: nextTag };
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const text = await requestText(path, init);
  return (text.length > 0 ? (JSON.parse(text) as T) : (undefined as T));
};

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  poll: (path: string, etag: string | null): Promise<Polled> => requestPolled(path, etag),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  patch: <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: <T>(path: string): Promise<T> => request<T>(path, { method: "DELETE" }),
};

export const errorMessage = (reason: unknown): string =>
  reason instanceof ApiError
    ? reason.status === 0
      ? `${reason.message} (${apiBase}${reason.path})`
      : `${reason.status} ${reason.message}`
    : reason instanceof Error
      ? reason.message
      : String(reason);
