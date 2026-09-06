/**
 * Browser-safe filter contract for the operator Sessions list.
 *
 * One definition of what `GET /sessions` accepts, what each parameter means,
 * and which refusal code an unusable value earns. The API parses its query
 * through `parseSessionListFilters` and the web builds its query through
 * `sessionListFilterParams`, so a parameter cannot be spelled two ways and the
 * status vocabulary cannot drift between the page and the route.
 *
 * The same rules as `board-contract.ts` apply: Prisma is imported as types
 * only, so the browser receives no generated client code while a persisted
 * enum widening becomes a compile-time change at this seam.
 */

import type {
  RunnerKind as PrismaRunnerKind,
  SessionExecutionStatus as PrismaSessionExecutionStatus,
} from "@prisma/client";

export type RunnerKind = PrismaRunnerKind;
export type SessionExecutionStatus = PrismaSessionExecutionStatus;

/** The lifecycle buckets an operator filters by, and the only accepted
 *  `status` values. They are user-facing words, not persisted enum names. */
export const SESSION_STATUS_FILTERS = ["live", "done", "failed", "cancelled"] as const;

export type SessionStatusFilter = typeof SESSION_STATUS_FILTERS[number];

/**
 * The status mapping, in one place.
 *
 * Every `SessionExecutionStatus` belongs to exactly one bucket; the partition
 * is asserted by this module's test rather than restated by any caller. The
 * web never re-implements it, and the route never spells the enum names again.
 */
export const SESSION_STATUS_EXECUTION_STATUSES: Record<SessionStatusFilter, readonly SessionExecutionStatus[]> = {
  live: ["REQUESTED", "PROVISIONING", "RUNNING", "WAITING_INBOX"],
  done: ["SUCCEEDED"],
  failed: ["FAILED", "TIMED_OUT", "LOST"],
  cancelled: ["CANCELLED"],
};

/** The runner choices the Sessions filter offers. The coverage alias makes a
 *  `RunnerKind` added to the schema fail to compile until it is offered here. */
export const SESSION_RUNNER_FILTERS = ["CLAUDE", "CODEX", "PI"] as const satisfies readonly RunnerKind[];

type RunnerFilterCoverage =
  Exclude<RunnerKind, typeof SESSION_RUNNER_FILTERS[number]> extends never ? unknown : never;

export type SessionRunnerFilter = RunnerKind & RunnerFilterCoverage;

export const isSessionStatusFilter = (value: string): value is SessionStatusFilter =>
  (SESSION_STATUS_FILTERS as readonly string[]).includes(value);

export const isSessionRunnerFilter = (value: string): value is SessionRunnerFilter =>
  (SESSION_RUNNER_FILTERS as readonly string[]).includes(value);

/** Match one execution status against a lifecycle bucket, from the mapping
 *  above. The Sessions list filters on the server; this is what any remaining
 *  client-side read of the same vocabulary must use. */
export const sessionStatusMatches = (
  status: SessionExecutionStatus,
  filter: SessionStatusFilter,
): boolean => SESSION_STATUS_EXECUTION_STATUSES[filter].includes(status);

/** The query parameters `GET /sessions` accepts as filters. `projectId`,
 *  `limit` and `before` are the list's pre-existing scope, page size and
 *  cursor, and are deliberately not filters. */
export const SESSION_FILTER_PARAMETERS = [
  "status", "agentId", "runner", "taskId", "chainId", "since", "until", "q",
] as const;

export type SessionFilterParameter = typeof SESSION_FILTER_PARAMETERS[number];

/** The longest `q` the route accepts. Past this the value is a paste, not a
 *  search, and refusing it keeps an unbounded string out of the query. */
export const SESSION_FILTER_QUERY_MAX = 200;

/** One refusal code per parameter, so a 400 names the value that was wrong.
 *  A filter is never dropped silently: a present-but-unusable value refuses. */
export const SESSION_FILTER_REFUSAL_CODES = {
  status: "session-filter-status-invalid",
  agentId: "session-filter-agent-id-invalid",
  runner: "session-filter-runner-invalid",
  taskId: "session-filter-task-id-invalid",
  chainId: "session-filter-chain-id-invalid",
  since: "session-filter-since-invalid",
  until: "session-filter-until-invalid",
  q: "session-filter-q-invalid",
} as const satisfies Record<SessionFilterParameter, string>;

export type SessionFilterRefusalCode = typeof SESSION_FILTER_REFUSAL_CODES[SessionFilterParameter];

/**
 * The parsed filters. `null` means the parameter was absent — never that it
 * was present and unusable, which refuses instead.
 *
 * `since`/`until` are normalized ISO instants, so the route converts them once
 * and the URL that produced them can be rebuilt exactly.
 */
export type SessionListFilters = {
  status: SessionStatusFilter | null;
  agentId: string | null;
  runner: SessionRunnerFilter | null;
  taskId: string | null;
  chainId: string | null;
  since: string | null;
  until: string | null;
  q: string | null;
};

/** The unfiltered list: what `GET /sessions` answered before this contract,
 *  and what a request naming no filter still answers. */
export const NO_SESSION_FILTERS: SessionListFilters = {
  status: null, agentId: null, runner: null, taskId: null,
  chainId: null, since: null, until: null, q: null,
};

export type SessionFilterRefusal = {
  parameter: SessionFilterParameter;
  code: SessionFilterRefusalCode;
  message: string;
};

export type SessionFilterParse =
  | { filters: SessionListFilters; refusal?: undefined }
  | { filters?: undefined; refusal: SessionFilterRefusal };

/** Reads one raw parameter. `URLSearchParams.get` and Hono's `req.query` both
 *  satisfy it, which is why neither side needs to marshal its query first. */
export type SessionFilterQueryReader = (parameter: SessionFilterParameter) => string | null | undefined;

const refuse = (parameter: SessionFilterParameter, message: string): SessionFilterParse => ({
  refusal: { parameter, code: SESSION_FILTER_REFUSAL_CODES[parameter], message },
});

/** An absent parameter is `null`; a present one is trimmed and must carry a
 *  value. An empty `status=` is a request that meant something and lost it, so
 *  it refuses rather than widening back to the whole history. */
const present = (read: SessionFilterQueryReader, parameter: SessionFilterParameter): string | null | undefined => {
  const raw = read(parameter);
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const isoInstant = (value: string): string | null => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

/**
 * Parse the filter half of a `GET /sessions` query.
 *
 * The first unusable parameter refuses, in the declared parameter order, so a
 * request with two bad values reports a stable one of them.
 */
export const parseSessionListFilters = (read: SessionFilterQueryReader): SessionFilterParse => {
  const status = present(read, "status");
  if (status === undefined || (status !== null && !isSessionStatusFilter(status))) {
    return refuse("status", `status must be one of ${SESSION_STATUS_FILTERS.join(", ")}`);
  }
  const agentId = present(read, "agentId");
  if (agentId === undefined) return refuse("agentId", "agentId must be a non-empty Agent id");
  const runner = present(read, "runner");
  if (runner === undefined || (runner !== null && !isSessionRunnerFilter(runner))) {
    return refuse("runner", `runner must be one of ${SESSION_RUNNER_FILTERS.join(", ")}`);
  }
  const taskId = present(read, "taskId");
  if (taskId === undefined) return refuse("taskId", "taskId must be a non-empty Task id");
  const chainId = present(read, "chainId");
  if (chainId === undefined) return refuse("chainId", "chainId must be a non-empty chain id");

  const rawSince = present(read, "since");
  if (rawSince === undefined) return refuse("since", "since must be an ISO timestamp");
  const since = rawSince === null ? null : isoInstant(rawSince);
  if (since === null && rawSince !== null) return refuse("since", "since must be an ISO timestamp");
  const rawUntil = present(read, "until");
  if (rawUntil === undefined) return refuse("until", "until must be an ISO timestamp");
  const until = rawUntil === null ? null : isoInstant(rawUntil);
  if (until === null && rawUntil !== null) return refuse("until", "until must be an ISO timestamp");

  const q = present(read, "q");
  if (q === undefined) return refuse("q", "q must be a non-empty search term");
  if (q !== null && q.length > SESSION_FILTER_QUERY_MAX) {
    return refuse("q", `q must be at most ${SESSION_FILTER_QUERY_MAX} characters`);
  }

  return { filters: { status, agentId, runner, taskId, chainId, since, until, q } };
};

/** The filters as query parameters, absent ones omitted. The caller appends
 *  them to its own `projectId`/`limit`/`before`. */
export const sessionListFilterParams = (
  filters: SessionListFilters,
): Array<[SessionFilterParameter, string]> =>
  SESSION_FILTER_PARAMETERS
    .map((parameter) => [parameter, filters[parameter]] as const)
    .filter((entry): entry is [SessionFilterParameter, string] => entry[1] !== null);

/** Whether anything is narrowing the list. The page's empty state and its
 *  Clear control both read this rather than testing eight fields. */
export const hasSessionListFilters = (filters: SessionListFilters): boolean =>
  sessionListFilterParams(filters).length > 0;
