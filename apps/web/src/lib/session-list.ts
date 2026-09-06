import {
  NO_SESSION_FILTERS,
  SESSION_FILTER_PARAMETERS,
  sessionListFilterParams,
  sessionStatusMatches,
  type SessionListFilterInput,
} from "@anneal/db/session-filter-contract";

import { storage } from "./storage";
import type { Agent, Session, SessionExecutionStatus } from "./types";

/** The number of rows that keep a busy calendar day from hiding later days. */
export const SESSION_DAY_PAGE_SIZE = 5;

/** Whether this session is still running or waiting on work, answered from the
 *  shared status mapping so the page's vocabulary and the server's filter
 *  cannot drift apart. */
export const isLiveStatus = (status: SessionExecutionStatus): boolean => sessionStatusMatches(status, "live");

/** The select value that stands for "do not narrow on this axis". It is a UI
 *  word only: an unfiltered axis is simply absent from the request. */
export const ALL_SESSION_FILTER = "all" as const;

export type SessionFilterOption = {
  value: string;
  label: string;
};

/** The date windows the list offers. `custom` is the only one that reads the
 *  two date boxes; the relative ones are resolved against the current instant
 *  when selected and at clock boundaries, so a shared link means the same words
 *  rather than the same frozen hour. */
export const SESSION_RANGE_PRESETS = ["all", "today", "7d", "30d", "custom"] as const;

export type SessionRangePreset = typeof SESSION_RANGE_PRESETS[number];

const isRangePreset = (value: string): value is SessionRangePreset =>
  (SESSION_RANGE_PRESETS as readonly string[]).includes(value);

/**
 * What the operator chose, as the URL carries it.
 *
 * The filter axes keep the shared contract's parameter names, so the hash and
 * the request spell them identically. `range` is the page's own control, and
 * `since`/`until` are local calendar days — the value an `input[type=date]`
 * holds — rather than instants, so a reload restores the boxes exactly.
 */
export type SessionListSelection = SessionListFilterInput & { range: SessionRangePreset };

export const EMPTY_SESSION_SELECTION: SessionListSelection = { ...NO_SESSION_FILTERS, range: "all" };

/** Preserve raw values so the shared server parser can refuse invalid links. */
export const readSessionSelection = (query: URLSearchParams): SessionListSelection => {
  const axes = { ...NO_SESSION_FILTERS } as SessionListFilterInput;
  for (const parameter of SESSION_FILTER_PARAMETERS) axes[parameter] = query.get(parameter);
  const range = query.get("range");
  return {
    ...axes,
    range: range !== null && isRangePreset(range) ? range : axes.since !== null || axes.until !== null ? "custom" : "all",
  };
};

/** The selection as a hash query, in a fixed order so an unchanged selection
 *  never rewrites the address bar. Empty when nothing is narrowed. */
export const sessionSelectionSearch = (selection: SessionListSelection): string => {
  const query = new URLSearchParams();
  for (const parameter of SESSION_FILTER_PARAMETERS) {
    if (parameter === "since" || parameter === "until") continue;
    const value = selection[parameter];
    if (value !== null) query.set(parameter, value);
  }
  // `all` is the default and stays out of an otherwise empty hash, but dates
  // kept from an earlier custom window would be read back as an inferred
  // custom range, so a remembered window keeps the preset spelled out.
  if (selection.range !== "all" || selection.since !== null || selection.until !== null) {
    query.set("range", selection.range);
  }
  if (selection.since !== null) query.set("since", selection.since);
  if (selection.until !== null) query.set("until", selection.until);
  return query.toString();
};

/** The list's own route, so every link into it agrees on the spelling. */
export const SESSIONS_ROUTE = "/sessions";

/** A link that opens the Sessions list already narrowed — the chain chip on a
 *  row, and the task detail page's way in. Unnamed axes stay unfiltered. */
export const sessionsFilterHref = (selection: Partial<SessionListSelection>): string => {
  const search = sessionSelectionSearch({ ...EMPTY_SESSION_SELECTION, ...selection });
  return search.length === 0 ? SESSIONS_ROUTE : `${SESSIONS_ROUTE}?${search}`;
};

const startOfDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const localDay = (value: string): Date | null => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!parts) return null;
  const day = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return day.getFullYear() !== Number(parts[1]) || day.getMonth() !== Number(parts[2]) - 1 || day.getDate() !== Number(parts[3]) ? null : day;
};

const daysBefore = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);

/** The chosen window as the two instants the route filters `requestedAt` on.
 *  A custom `until` covers the whole day it names, which is what an operator
 *  who typed one date and expected its sessions means. */
export const sessionRangeWindow = (
  selection: SessionListSelection,
  now: Date,
): { since: string | null; until: string | null } => {
  if (selection.range === "today") return { since: startOfDay(now).toISOString(), until: null };
  if (selection.range === "7d") return { since: daysBefore(now, 7).toISOString(), until: null };
  if (selection.range === "30d") return { since: daysBefore(now, 30).toISOString(), until: null };
  if (selection.range !== "custom") return { since: null, until: null };
  const from = selection.since === null ? null : localDay(selection.since);
  const to = selection.until === null ? null : localDay(selection.until);
  return {
    since: from === null ? selection.since : from.toISOString(),
    until: to === null ? selection.until : new Date(new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime() - 1).toISOString(),
  };
};

/** The selection as the shared filter contract, ready to be spelled into a
 *  request. `now` is passed in so one render resolves one window. */
export const sessionSelectionFilters = (
  selection: SessionListSelection,
  now: Date,
): SessionListFilterInput => {
  const { range: _range, since: _since, until: _until, ...axes } = selection;
  return { ...axes, ...sessionRangeWindow(selection, now) };
};

/** The list request, cursor included. Every filter reaches the server, so the
 *  page never narrows a page it has already loaded. */
export const sessionListPath = (
  projectId: string,
  limit: number,
  filters: SessionListFilterInput,
  before?: string,
): string => {
  const query = new URLSearchParams({ projectId, limit: String(limit) });
  for (const [parameter, value] of sessionListFilterParams(filters)) query.set(parameter, value);
  if (before !== undefined) query.set("before", before);
  return `/sessions?${query.toString()}`;
};

export type SessionDayGroup = {
  /** A local YYYY-MM-DD key, suitable for React keys and expansion state. */
  key: string;
  /** The newest row's timestamp, used when an older day needs an absolute label. */
  at: string;
  sessions: Session[];
};

/** The same instant the list uses for its relative time and day membership. */
export const sessionTimestamp = (session: Pick<Session, "startedAt" | "requestedAt">): string =>
  session.startedAt ?? session.requestedAt;

/**
 * The Agent choices the filter offers.
 *
 * The project roster is the stable source — narrowing to one Agent must not
 * shrink the list of Agents to choose from next. Loaded rows are merged in
 * because a session outlives its Agent: an archived Agent no longer on the
 * roster is still the one that ran, and dropping it would hide the only way to
 * find its sessions.
 */
export const sessionAgentOptions = (
  sessions: readonly Pick<Session, "agentId" | "agent">[],
  roster: readonly Pick<Agent, "id" | "title">[],
  allLabel: string,
): SessionFilterOption[] => {
  const labels = new Map<string, string>();
  for (const agent of roster) labels.set(agent.id, agent.title || agent.id);
  for (const session of sessions) {
    const label = session.agent?.title || session.agentId;
    const current = labels.get(session.agentId);
    // A relation can be absent on a partially-expanded response. Prefer a
    // later title when an earlier row only supplied the id.
    if (current === undefined || current === session.agentId) labels.set(session.agentId, label);
  }
  const options = [...labels.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
  return [{ value: ALL_SESSION_FILTER, label: allLabel }, ...options];
};

/** Format an instant as a calendar day in the browser's local timezone. */
export const localDayKey = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "invalid";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const timestampValue = (value: string): number => {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

/**
 * Group already-loaded Sessions without mutating the caller's array. Both the
 * rows and the groups are newest-first, and a queued Session still belongs to
 * a day because `sessionTimestamp` falls back to requestedAt.
 */
export const groupSessionsByDay = (sessions: readonly Session[]): SessionDayGroup[] => {
  const ordered = sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const difference = timestampValue(sessionTimestamp(right.session)) - timestampValue(sessionTimestamp(left.session));
      return difference === 0 ? left.index - right.index : difference;
    });

  const groups = new Map<string, SessionDayGroup>();
  for (const { session } of ordered) {
    const at = sessionTimestamp(session);
    const key = localDayKey(at);
    const group = groups.get(key);
    if (group) {
      group.sessions.push(session);
    } else {
      groups.set(key, { key, at, sessions: [session] });
    }
  }
  return [...groups.values()];
};

export type SessionDayLabelKind = "today" | "yesterday" | "date";

/** Resolve the semantic heading at render time, rather than caching Today. */
export const sessionDayLabelKind = (key: string, now = new Date()): SessionDayLabelKind => {
  const today = localDayKey(now.toISOString());
  if (key === today) return "today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return key === localDayKey(yesterday.toISOString()) ? "yesterday" : "date";
};

/* ---------------------------------------------------------- seen sessions */

export type SessionSeenState = {
  since: string;
  opened: Record<string, string>;
};

export const sessionSeenKey = (projectId: string): string => `agentos.sessions.seen.${projectId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSeenState = (raw: string | null): SessionSeenState | null => {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.since !== "string" || !isRecord(parsed.opened)) return null;
    const opened: Record<string, string> = {};
    for (const [id, at] of Object.entries(parsed.opened)) {
      if (typeof at !== "string") return null;
      opened[id] = at;
    }
    return { since: parsed.since, opened };
  } catch {
    return null;
  }
};

const newSeenState = (): SessionSeenState => ({ since: new Date().toISOString(), opened: {} });

const writeSeenState = (projectId: string, state: SessionSeenState): void => {
  storage.set(sessionSeenKey(projectId), JSON.stringify(state));
};

/** Read once per list mount; a missing or malformed local cache starts clean. */
export const readSessionSeenState = (projectId: string): SessionSeenState => {
  const existing = parseSeenState(storage.get(sessionSeenKey(projectId)));
  if (existing !== null) return existing;
  const fresh = newSeenState();
  writeSeenState(projectId, fresh);
  return fresh;
};

/** A terminal row still has a meaningful finish instant when endedAt is absent. */
export const sessionFinishTimestamp = (
  session: Pick<Session, "endedAt" | "startedAt" | "requestedAt">,
): string => session.endedAt ?? session.startedAt ?? session.requestedAt;

export const isSessionUnseen = (session: Session, state: SessionSeenState): boolean => {
  if (isLiveStatus(session.executionStatus)) return false;
  const finish = timestampValue(sessionFinishTimestamp(session));
  const seenAt = state.opened[session.id] ?? state.since;
  return finish > timestampValue(seenAt);
};

const pruneOpened = (opened: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(opened)
      .map(([id, at], index) => ({ id, at, index }))
      .sort((left, right) => {
        const difference = timestampValue(right.at) - timestampValue(left.at);
        return difference === 0 ? left.index - right.index : difference;
      })
      .slice(0, 500)
      .map(({ id, at }) => [id, at]),
  );

/** Persist an open timestamp and bound the browser-local record. */
export const markSessionOpened = (
  projectId: string,
  sessionId: string,
  openedAt = new Date().toISOString(),
): SessionSeenState => {
  const current = readSessionSeenState(projectId);
  const next: SessionSeenState = {
    since: current.since,
    opened: pruneOpened({ ...current.opened, [sessionId]: openedAt }),
  };
  writeSeenState(projectId, next);
  return next;
};
