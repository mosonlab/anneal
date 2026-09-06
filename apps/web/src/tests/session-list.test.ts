import assert from "node:assert/strict";
import test from "node:test";

import { SESSION_STATUS_EXECUTION_STATUSES } from "@anneal/db/session-filter-contract";

import { storage } from "../lib/storage";
import type { Session, SessionExecutionStatus } from "../lib/types";
import {
  ALL_SESSION_FILTER, EMPTY_SESSION_SELECTION, groupSessionsByDay, isLiveStatus, isSessionUnseen, localDayKey,
  markSessionOpened, readSessionSeenState, readSessionSelection, sessionAgentOptions, sessionFinishTimestamp,
  sessionListPath, sessionRangeWindow, sessionSeenKey, sessionSelectionFilters, sessionSelectionSearch,
  sessionsFilterHref, sessionTimestamp, type SessionListSelection,
} from "../lib/session-list";

const atLocalDay = (offset: number, hour: number): string => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, 0, 0, 0).toISOString();
};

const row = (id: string, requestedAt: string, startedAt: string | null = requestedAt): Session => ({
  id,
  requestedAt,
  startedAt,
} as Session);

test("groups sessions by their local started day, falling back to requested time", () => {
  const todayEarly = row("today-early", atLocalDay(0, 8));
  const todayLate = row("today-late", atLocalDay(0, 17));
  const yesterday = row("yesterday", atLocalDay(-1, 12));
  const queued = row("queued", atLocalDay(-2, 9), null);

  const groups = groupSessionsByDay([queued, todayEarly, yesterday, todayLate]);

  assert.deepEqual(groups.map((group) => group.key), [
    localDayKey(todayLate.startedAt!),
    localDayKey(yesterday.startedAt!),
    localDayKey(queued.requestedAt),
  ]);
  assert.deepEqual(groups[0]?.sessions.map((session) => session.id), ["today-late", "today-early"]);
  assert.equal(sessionTimestamp(queued), queued.requestedAt);
});

test("grouping does not mutate the input order", () => {
  const older = row("older", atLocalDay(0, 8));
  const newer = row("newer", atLocalDay(0, 9));
  const input = [older, newer];

  groupSessionsByDay(input);

  assert.deepEqual(input.map((session) => session.id), ["older", "newer"]);
});

test("unseen uses the terminal finish fallback and never marks live sessions", () => {
  const baseline = "2026-08-20T00:00:00.000Z";
  const state = { since: baseline, opened: {} };
  const base = row("seen-test", "2026-08-21T00:00:00.000Z");

  assert.equal(isSessionUnseen({ ...base, executionStatus: "RUNNING" } as Session, state), false);
  assert.equal(isSessionUnseen({ ...base, executionStatus: "SUCCEEDED", endedAt: baseline } as Session, state), false);
  assert.equal(isSessionUnseen({ ...base, executionStatus: "SUCCEEDED", endedAt: "2026-08-21T01:00:00.000Z" } as Session, state), true);
  assert.equal(isSessionUnseen({ ...base, executionStatus: "LOST", endedAt: null, startedAt: "2026-08-21T00:00:00.000Z" } as Session, state), true);
  assert.equal(sessionFinishTimestamp({ ...base, endedAt: null, startedAt: null } as Session), base.requestedAt);
  assert.equal(isSessionUnseen({ ...base, executionStatus: "SUCCEEDED", endedAt: "2026-08-21T01:00:00.000Z" } as Session, {
    ...state,
    opened: { [base.id]: "2026-08-21T02:00:00.000Z" },
  }), false);
});

test("first read creates a per-project baseline and marking opened writes the exact key", () => {
  const first = readSessionSeenState("seen-baseline-project");
  assert.match(first.since, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(first.opened, {});
  const raw = storage.get(sessionSeenKey("seen-baseline-project"));
  assert.ok(raw);
  assert.deepEqual(JSON.parse(raw), first);

  const second = readSessionSeenState("seen-baseline-project");
  assert.deepEqual(second, first);
  const other = readSessionSeenState("seen-other-project");
  assert.notEqual(other.since, undefined);
  assert.notEqual(sessionSeenKey("seen-baseline-project"), sessionSeenKey("seen-other-project"));

  const opened = markSessionOpened("seen-baseline-project", "session-a", "2026-08-22T00:00:00.000Z");
  assert.equal(opened.opened["session-a"], "2026-08-22T00:00:00.000Z");
  assert.equal(readSessionSeenState("seen-baseline-project").opened["session-a"], "2026-08-22T00:00:00.000Z");
});

test("opening prunes to the 500 newest entries and malformed records recover", () => {
  const projectId = "seen-prune-project";
  const opened = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [
    `old-${index}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  ]));
  storage.set(sessionSeenKey(projectId), JSON.stringify({ since: "2025-01-01T00:00:00.000Z", opened }));
  const next = markSessionOpened(projectId, "newest", "2026-08-22T00:00:00.000Z");
  assert.equal(Object.keys(next.opened).length, 500);
  assert.equal(next.opened.newest, "2026-08-22T00:00:00.000Z");
  assert.equal(next.opened["old-0"], undefined);

  const malformedId = "seen-malformed-project";
  storage.set(sessionSeenKey(malformedId), "{not-json");
  assert.doesNotThrow(() => readSessionSeenState(malformedId));
  const recovered = readSessionSeenState(malformedId);
  assert.deepEqual(recovered.opened, {});
  assert.deepEqual(JSON.parse(storage.get(sessionSeenKey(malformedId))!), recovered);

  const wrongShapeId = "seen-wrong-shape-project";
  storage.set(sessionSeenKey(wrongShapeId), JSON.stringify({ since: 42, opened: {} }));
  assert.doesNotThrow(() => readSessionSeenState(wrongShapeId));
  const recoveredWrongShape = readSessionSeenState(wrongShapeId);
  assert.match(recoveredWrongShape.since, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(recoveredWrongShape.opened, {});
});

test("marking one Session opened clears only that Session", () => {
  const projectId = "seen-one-project";
  const first = row("first", "2026-08-21T00:00:00.000Z");
  const second = row("second", "2026-08-22T00:00:00.000Z");
  const state = { since: "2026-08-20T00:00:00.000Z", opened: {} };
  storage.set(sessionSeenKey(projectId), JSON.stringify(state));
  const opened = markSessionOpened(projectId, first.id, "2026-08-23T00:00:00.000Z");

  assert.equal(isSessionUnseen({ ...first, executionStatus: "SUCCEEDED", endedAt: first.requestedAt } as Session, opened), false);
  assert.equal(isSessionUnseen({ ...second, executionStatus: "SUCCEEDED", endedAt: second.requestedAt } as Session, opened), true);
  assert.deepEqual(Object.keys(opened.opened), [first.id]);
});

test("seen state works through the storage wrapper's degraded path", () => {
  const projectId = "seen-degraded-project";
  const key = sessionSeenKey(projectId);
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const blockedWindow = {};
  Object.defineProperty(blockedWindow, "localStorage", {
    configurable: true,
    get: () => { throw new Error("storage blocked"); },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: blockedWindow });
  try {
    const initial = readSessionSeenState(projectId);
    const opened = markSessionOpened(projectId, "degraded-session", "2026-08-23T00:00:00.000Z");
    assert.equal(opened.opened["degraded-session"], "2026-08-23T00:00:00.000Z");
    assert.equal(storage.get(key) !== null, true);
    assert.equal(isSessionUnseen({
      ...row("degraded-session", "2026-08-22T00:00:00.000Z"),
      executionStatus: "SUCCEEDED", endedAt: "2026-08-22T00:00:00.000Z",
    } as Session, opened), false);
    assert.notEqual(initial.since, undefined);
  } finally {
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", priorWindow);
  }
});

test("the live bucket is read from the shared mapping, not restated here", () => {
  const statuses: SessionExecutionStatus[] = [
    "REQUESTED", "PROVISIONING", "RUNNING", "WAITING_INBOX", "SUCCEEDED", "FAILED", "TIMED_OUT", "LOST", "CANCELLED",
  ];
  for (const status of statuses) {
    assert.equal(
      isLiveStatus(status),
      SESSION_STATUS_EXECUTION_STATUSES.live.includes(status),
      status,
    );
  }
});

test("agent options are distinct, title-labelled, sorted, and include All", () => {
  const sessions = [
    { ...row("z", atLocalDay(0, 8)), agentId: "agent-1" },
    { ...row("a", atLocalDay(0, 9)), agentId: "agent-z", agent: { id: "agent-z", title: "Zed" } },
    { ...row("b", atLocalDay(0, 10)), agentId: "agent-a", agent: { id: "agent-a", title: "Ada" } },
    { ...row("c", atLocalDay(0, 11)), agentId: "agent-z", agent: { id: "agent-z", title: "Zed" } },
  ] as Session[];

  assert.deepEqual(sessionAgentOptions(sessions, [], "All"), [
    { value: ALL_SESSION_FILTER, label: "All" },
    { value: "agent-a", label: "Ada" },
    { value: "agent-1", label: "agent-1" },
    { value: "agent-z", label: "Zed" },
  ]);
});

test("agent options keep a roster Agent that no loaded row names", () => {
  const sessions = [{ ...row("a", atLocalDay(0, 9)), agentId: "agent-z", agent: { id: "agent-z", title: "Zed" } }] as Session[];
  const roster = [{ id: "agent-a", title: "Ada" }, { id: "agent-z", title: "Zed" }];

  // Narrowing to one Agent must not leave that Agent as the only choice left,
  // and an archived Agent that still owns history must not disappear either.
  assert.deepEqual(sessionAgentOptions(sessions, roster, "All"), [
    { value: ALL_SESSION_FILTER, label: "All" },
    { value: "agent-a", label: "Ada" },
    { value: "agent-z", label: "Zed" },
  ]);
  assert.deepEqual(sessionAgentOptions(sessions, [{ id: "agent-a", title: "Ada" }], "All").map((option) => option.value), [
    ALL_SESSION_FILTER, "agent-a", "agent-z",
  ]);
});

/* ------------------------------------------------------------- the filters */

const selection = (overrides: Partial<SessionListSelection> = {}): SessionListSelection =>
  ({ ...EMPTY_SESSION_SELECTION, ...overrides });

test("a hash query round-trips through the selection, preserving invalid values", () => {
  const search = "status=failed&agentId=agent-1&runner=CODEX&taskId=task-1&chainId=chain-1&q=login&range=custom&since=2026-08-01&until=2026-08-03";
  const parsed = readSessionSelection(new URLSearchParams(search));
  assert.deepEqual(parsed, selection({
    status: "failed", agentId: "agent-1", runner: "CODEX", taskId: "task-1", chainId: "chain-1",
    q: "login", range: "custom", since: "2026-08-01", until: "2026-08-03",
  }));
  assert.equal(sessionSelectionSearch(parsed), search);

  const invalid = readSessionSelection(new URLSearchParams("status=running&runner=pi"));
  assert.equal(invalid.status, "running");
  assert.equal(invalid.runner, "pi");
  assert.equal(sessionSelectionSearch(EMPTY_SESSION_SELECTION), "");
  assert.equal(sessionSelectionSearch(selection({ range: "7d", since: "2026-08-01" })), "range=7d&since=2026-08-01");

  // Retained dates are read back as an inferred custom range unless the hash
  // spells the preset out, so `all` stays explicit while it remembers them.
  const anyTime = selection({ range: "all", since: "2026-08-01", until: "2026-08-03" });
  assert.equal(sessionSelectionSearch(anyTime), "range=all&since=2026-08-01&until=2026-08-03");
  const restored = readSessionSelection(new URLSearchParams(sessionSelectionSearch(anyTime)));
  assert.deepEqual(restored, anyTime);
  assert.deepEqual(sessionRangeWindow(restored, new Date()), { since: null, until: null });
});

test("a range preset resolves to the window the route filters requestedAt on", () => {
  const now = new Date(2026, 7, 16, 14, 30);
  assert.deepEqual(sessionRangeWindow(selection(), now), { since: null, until: null });
  assert.deepEqual(sessionRangeWindow(selection({ range: "today" }), now), {
    since: new Date(2026, 7, 16).toISOString(), until: null,
  });
  assert.deepEqual(sessionRangeWindow(selection({ range: "7d" }), now), {
    since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString(), until: null,
  });
  assert.deepEqual(sessionRangeWindow(selection({ range: "30d" }), now), {
    since: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString(), until: null,
  });
  // A custom `until` covers the whole day it names: an operator who typed one
  // date meant that day's sessions, not the instant it began.
  assert.deepEqual(sessionRangeWindow(selection({ range: "custom", since: "2026-08-01", until: "2026-08-03" }), now), {
    since: new Date(2026, 7, 1).toISOString(),
    until: new Date(new Date(2026, 7, 4).getTime() - 1).toISOString(),
  });
  assert.deepEqual(sessionRangeWindow(selection({ range: "custom", until: "not-a-day" }), now), {
    since: null, until: "not-a-day",
  });
});

test("the request carries every filter, the project scope and the cursor", () => {
  const now = new Date(2026, 7, 16, 14, 30);
  const filters = sessionSelectionFilters(selection({
    status: "live", agentId: "agent-1", runner: "CLAUDE", chainId: "chain-1", q: "feat/x", range: "today",
  }), now);
  const path = sessionListPath("p 1", 50, filters, "2026-08-16T00:00:00.000Z");
  const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));

  assert.ok(path.startsWith("/sessions?"));
  assert.equal(query.get("projectId"), "p 1");
  assert.equal(query.get("limit"), "50");
  assert.equal(query.get("status"), "live");
  assert.equal(query.get("agentId"), "agent-1");
  assert.equal(query.get("runner"), "CLAUDE");
  assert.equal(query.get("chainId"), "chain-1");
  assert.equal(query.get("q"), "feat/x");
  assert.equal(query.get("since"), new Date(2026, 7, 16).toISOString());
  assert.equal(query.get("before"), "2026-08-16T00:00:00.000Z");
  assert.equal(query.get("taskId"), null, "an unfiltered axis is absent, not empty");

  // An unfiltered list asks for exactly what it asked for before this contract.
  assert.equal(
    sessionListPath("p1", 50, sessionSelectionFilters(EMPTY_SESSION_SELECTION, now)),
    "/sessions?projectId=p1&limit=50",
  );
});

test("a filter link opens the list narrowed to one axis only", () => {
  assert.equal(sessionsFilterHref({ chainId: "chain-1" }), "/sessions?chainId=chain-1");
  assert.equal(sessionsFilterHref({ taskId: "task-1" }), "/sessions?taskId=task-1");
  assert.equal(sessionsFilterHref({}), "/sessions");
});

 test("custom end dates follow local midnight across DST", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    for (const [until, expected] of [["2026-03-08", "2026-03-09T03:59:59.999Z"], ["2026-11-01", "2026-11-02T04:59:59.999Z"]] as const) {
      assert.equal(sessionRangeWindow(selection({ range: "custom", until }), new Date()).until, expected);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("dates without a range infer custom and invalid calendar days reach refusal", () => {
  const parsed = readSessionSelection(new URLSearchParams("until=2026-02-31"));
  assert.equal(parsed.range, "custom");
  assert.equal(sessionSelectionFilters(parsed, new Date()).until, "2026-02-31");
});
