import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";

import { parseSessionListFilters, sessionStatusMatches, type SessionStatusFilter } from "@anneal/db/session-filter-contract";

import { LocaleProvider } from "../lib/i18n";
import type { Session } from "../lib/types";
import { mountPage, type PageHarness, type PageRoute } from "./dom-harness";

/**
 * The Sessions list filters on the server, so these tests answer the page's
 * requests the way the route does — by reading the query — rather than handing
 * back a fixed array. What is asserted is therefore both halves of the
 * contract: the query the page sends, and that it renders only what came back.
 */

const AGENTS = [
  { id: "agent-match", title: "Matching agent" },
  { id: "agent-other", title: "Other agent" },
];

const at = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

const session = (overrides: Partial<Session> & Pick<Session, "id">): Session => ({
  runId: `run-${overrides.id}`, projectId: "p1", agentId: "agent-match", taskId: `task-${overrides.id}`,
  goalId: null, runner: "CLAUDE", executionStatus: "RUNNING", cleanupStatus: "PENDING",
  providerConversationId: null, waitingOnMessageId: null, resumeAttempt: 0,
  requestedAt: at(0), startedAt: at(0), endedAt: null, terminationReason: null, exitCode: null,
  costUsd: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null,
  failureReason: null, agent: { id: "agent-match", title: "Matching agent" },
  task: { id: `task-${overrides.id}`, name: overrides.id, chainId: null, chainName: null },
  goal: null,
  run: { id: `run-${overrides.id}`, runNumber: 1, model: "claude-opus-5", branch: "feat/x", pullRequestUrl: null, workspacePath: null, repo: null },
  ...overrides,
});

/** The route's narrowing, modelled only for the parameters these tests send. */
const narrow = (rows: readonly Session[], query: URLSearchParams): Session[] => {
  const status = query.get("status");
  const q = query.get("q")?.toLowerCase() ?? null;
  const before = query.get("before");
  const since = query.get("since");
  return rows.filter((row) => (
    (query.get("agentId") === null || row.agentId === query.get("agentId"))
    && (status === null || sessionStatusMatches(row.executionStatus, status as SessionStatusFilter))
    && (query.get("runner") === null || row.runner === query.get("runner"))
    && (query.get("taskId") === null || row.taskId === query.get("taskId"))
    && (query.get("chainId") === null || (row.task?.chainId ?? null) === query.get("chainId"))
    && (before === null || row.requestedAt < before)
    && (since === null || row.requestedAt >= since)
    && (q === null || [row.task?.name, row.run?.branch, row.failureReason]
      .some((field) => field?.toLowerCase().includes(q) === true))
  ));
};

const queryOf = (path: string): URLSearchParams => new URLSearchParams(path.slice(path.indexOf("?") + 1));

const listRequests = (page: PageHarness): URLSearchParams[] => page.requests
  .filter((request) => request.path.startsWith("/sessions?"))
  .map((request) => queryOf(request.path));

/**
 * The page owns timers the tests do not drive — a search debounce and a
 * range-boundary refresh — so the newest list request is not necessarily the
 * one the action under test caused. Reading `listRequests(page).at(-1)` after
 * an action therefore asserts against whichever request happened to land last,
 * which is how "the second page carries the cursor" failed a gate on a loaded
 * worker while the branch was correct. Each assertion below names the request
 * it means instead: mark the requests already seen, act, then take the first
 * request after the mark that the action would have issued.
 */
const requestMark = (page: PageHarness): number => listRequests(page).length;

/**
 * How many 25ms polls a wait for such a request may take. Counted rather than
 * clocked because two tests below mock `Date`, and bounded so a timer that
 * never fires fails here rather than hanging the suite. The count is sized for
 * the loaded merge-gate worker — on 2026-09-06 it carried load1 20-55 all day,
 * where a real one-second timer is descheduled well past the fixed sleeps these
 * waits replaced — and costs nothing on a green run, because every wait returns
 * at the first request that matches.
 */
const REQUEST_POLL_LIMIT = 1_200;

const requestSince = async (
  page: PageHarness,
  mark: number,
  matches: (query: URLSearchParams) => boolean,
  what: string,
): Promise<URLSearchParams> => {
  for (let poll = 0; poll < REQUEST_POLL_LIMIT; poll += 1) {
    const found = listRequests(page).slice(mark).find(matches);
    if (found) return found;
    await act(async () => { await new Promise((resolve) => page.dom.window.setTimeout(resolve, 25)); });
    await page.settle();
  }
  return assert.fail(`the page never asked the server ${what}`);
};

const mountSessions = async (rows: readonly Session[], hash = "#/sessions", route?: PageRoute): Promise<PageHarness> => {
  const [{ SessionsPage }, { ProjectProvider }] = await Promise.all([
    import("../pages/Sessions"), import("../lib/project"),
  ]);
  return await mountPage(
    <LocaleProvider initialLocale="en"><ProjectProvider><SessionsPage /></ProjectProvider></LocaleProvider>,
    {
      "/projects": [{ id: "p1", name: "Demo" }],
      "/projects/p1/agents": AGENTS,
      "/sessions": route ?? (({ path }) => narrow(rows, queryOf(path))),
    },
    `http://127.0.0.1:5173/${hash}`,
  );
};

const select = async (page: PageHarness, attribute: string, value: string): Promise<void> => {
  const node = page.container.ownerDocument.querySelector<HTMLSelectElement>(`[${attribute}]`);
  assert.ok(node, `${attribute} is not on the page: ${page.container.innerHTML}`);
  node.value = value;
  await act(async () => { node.dispatchEvent(new page.dom.window.Event("change", { bubbles: true })); });
  await page.settle();
};

const rowText = (page: PageHarness): string[] =>
  [...page.container.querySelectorAll("[data-session-row]")].map((row) => row.textContent ?? "");

const hashOf = (page: PageHarness): string => page.dom.window.location.hash;

const ROWS: Session[] = [
  session({ id: "live-match", executionStatus: "RUNNING" }),
  session({ id: "cancelled-match", executionStatus: "CANCELLED", requestedAt: at(1), startedAt: at(1) }),
  session({
    id: "failed-other", executionStatus: "FAILED", agentId: "agent-other", runner: "CODEX",
    agent: { id: "agent-other", title: "Other agent" }, failureReason: "Lease LOST during merge",
    requestedAt: at(2), startedAt: at(2),
    run: { id: "run-failed-other", runNumber: 2, model: "gpt-6-astra", branch: "fix/Login", pullRequestUrl: null, workspacePath: null, repo: null },
  }),
];

test("each filter narrows the list on the server, and the loaded-only hint is gone", async () => {
  const page = await mountSessions(ROWS);
  try {
    assert.equal(rowText(page).length, 3);
    // The hint promised the opposite of what the page now does.
    assert.doesNotMatch(page.container.textContent ?? "", /Filters apply to loaded Sessions only/u);
    assert.equal(page.container.querySelector("[data-session-filter-hint]"), null);

    let mark = requestMark(page);
    await select(page, "data-session-filter-status", "cancelled");
    await requestSince(page, mark, (query) => query.get("status") === "cancelled", "for the cancelled status");
    assert.equal(rowText(page).length, 1);
    assert.ok(rowText(page)[0]?.includes("cancelled-match"));

    await select(page, "data-session-filter-status", "all");
    mark = requestMark(page);
    await select(page, "data-session-filter-agent", "agent-other");
    const narrowed = await requestSince(page, mark, (query) => query.get("agentId") === "agent-other", "for the other agent");
    assert.equal(narrowed.get("status"), null, "clearing an axis drops it from the request");
    assert.deepEqual(rowText(page).length, 1);

    mark = requestMark(page);
    await select(page, "data-session-filter-runner", "CODEX");
    const combined = await requestSince(page, mark, (query) => query.get("runner") === "CODEX", "for the CODEX runner");
    assert.equal(combined.get("agentId"), "agent-other");
    assert.equal(rowText(page).length, 1, "filters combine with AND");

    await select(page, "data-session-filter-runner", "CLAUDE");
    assert.equal(rowText(page).length, 0);
    assert.match(page.container.textContent ?? "", /No sessions match the selected filters/u);
  } finally {
    await page.dispose();
  }
});

test("the Agent choices come from the roster, not from the rows still on screen", async () => {
  const page = await mountSessions(ROWS);
  try {
    const options = (): string[] => [...page.container.querySelectorAll<HTMLSelectElement>("[data-session-filter-agent]")[0]!.options]
      .map((option) => option.textContent ?? "");
    assert.deepEqual(options(), ["All", "Matching agent", "Other agent"]);

    await select(page, "data-session-filter-agent", "agent-other");
    assert.deepEqual(options(), ["All", "Matching agent", "Other agent"], "narrowing must not shrink the choices");
  } finally {
    await page.dispose();
  }
});

test("a date range asks the server for a window and Clear puts the whole history back", async () => {
  const page = await mountSessions(ROWS);
  try {
    const beforePreset = requestMark(page);
    await select(page, "data-session-filter-range", "today");
    const since = (await requestSince(page, beforePreset, (query) => query.has("since"), "for a window")).get("since");
    assert.ok(since, "a preset resolves to an instant the route can filter on");
    assert.equal(new Date(since).getTime() <= Date.now(), true);
    assert.equal(rowText(page).length, 1, "only today's row survives the window");
    assert.match(hashOf(page), /range=today/u);

    await select(page, "data-session-filter-range", "custom");
    const from = page.container.ownerDocument.querySelector<HTMLInputElement>("[data-session-filter-since]");
    const to = page.container.ownerDocument.querySelector<HTMLInputElement>("[data-session-filter-until]");
    assert.ok(from, "the custom window offers its two date boxes");
    assert.ok(to);

    await select(page, "data-session-filter-range", "today");
    const clear = [...page.container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Clear");
    assert.ok(clear);
    const beforeClear = requestMark(page);
    await act(async () => { clear.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true, button: 0 })); });
    await page.settle();
    await requestSince(page, beforeClear, (query) => !query.has("since"), "for the whole history again");
    assert.equal(rowText(page).length, 3);
    assert.equal(hashOf(page), "#/sessions");
  } finally {
    await page.dispose();
  }
});

test("filters ride in the hash, are restored from it on load, and survive a reload of the page", async () => {
  const page = await mountSessions(ROWS, "#/sessions?status=failed&runner=CODEX&agentId=agent-other");
  try {
    const first = listRequests(page)[0];
    assert.equal(first?.get("status"), "failed");
    assert.equal(first?.get("runner"), "CODEX");
    assert.equal(first?.get("agentId"), "agent-other");
    assert.equal(rowText(page).length, 1);

    const value = (attribute: string): string | undefined =>
      page.container.ownerDocument.querySelector<HTMLSelectElement>(`[${attribute}]`)?.value;
    assert.equal(value("data-session-filter-status"), "failed");
    assert.equal(value("data-session-filter-runner"), "CODEX");
    assert.equal(value("data-session-filter-agent"), "agent-other");

    await select(page, "data-session-filter-status", "all");
    const hash = hashOf(page);
    assert.doesNotMatch(hash, /status=/u);
    assert.match(hash, /runner=CODEX/u);
    assert.match(hash, /agentId=agent-other/u);
  } finally {
    await page.dispose();
  }
});

test("the search box reaches the server once the operator pauses, and matches branch and failure text", async () => {
  const page = await mountSessions(ROWS);
  try {
    const box = page.container.ownerDocument.querySelector<HTMLInputElement>("[data-session-filter-search]");
    assert.ok(box, page.container.innerHTML);
    const before = page.requests.length;

    const type = async (value: string): Promise<void> => {
      const setter = Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(box, value);
      await act(async () => {
        box.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
        box.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
      });
    };

    const mark = requestMark(page);
    await type("Log");
    assert.equal(page.requests.length, before, "typing alone does not reach the server");

    // The pause is the debounce elapsing, so the wait is for the request it
    // eventually issues rather than for a sleep long enough to cover it.
    await requestSince(page, mark, (query) => query.get("q") === "Log", "for the typed search");
    assert.match(hashOf(page), /q=Log/u);
    // `Log` is in neither task name; it is in one run branch, case-insensitively.
    assert.equal(rowText(page).length, 1);
    assert.ok(rowText(page)[0]?.includes("failed-other"));
  } finally {
    await page.dispose();
  }
});

test("a chain row links to the chain's sessions, and its task name to the task", async () => {
  const chained = ROWS.map((row) => ({
    ...row,
    task: { id: row.taskId ?? row.id, name: row.id, chainId: "chain-1", chainName: "Release" },
  }));
  const page = await mountSessions([...chained, session({ id: "unchained" })]);
  try {
    const chip = page.container.querySelector<HTMLElement>("[data-session-chain]");
    assert.ok(chip, page.container.innerHTML);
    assert.equal(chip.textContent, "Release");
    assert.equal(chip.getAttribute("data-session-chain"), "chain-1");
    assert.equal(page.container.querySelectorAll("[data-session-chain]").length, 3, "only chained rows show a chain");

    const chainLink = chip.closest("a");
    assert.equal(chainLink?.getAttribute("href"), "#/sessions?chainId=chain-1");
    const taskLink = [...page.container.querySelectorAll("a")].find((link) => link.textContent === "live-match");
    assert.equal(taskLink?.getAttribute("href"), "#/tasks/task-live-match");

    const mark = requestMark(page);
    await act(async () => { chainLink?.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true, button: 0 })); });
    await page.settle();
    await requestSince(page, mark, (query) => query.get("chainId") === "chain-1", "for the linked chain");
    assert.equal(rowText(page).length, 3, "the unchained row is filtered out by the link");
  } finally {
    await page.dispose();
  }
});

test("Load more pages through the filtered history under the same filters", async () => {
  const rows = [
    ...Array.from({ length: 50 }, (_, index) => session({
      id: `page-one-${index}`, requestedAt: at(index + 1), startedAt: at(index + 1),
    })),
    ...Array.from({ length: 3 }, (_, index) => session({
      id: `page-two-${index}`, requestedAt: at(index + 60), startedAt: at(index + 60),
    })),
    session({ id: "other-agent", agentId: "agent-other", agent: { id: "agent-other", title: "Other agent" } }),
  ];
  const page = await mountSessions(rows);
  try {
    await select(page, "data-session-filter-agent", "agent-match");
    assert.equal(rowText(page).some((text) => text.includes("other-agent")), false);

    const more = [...page.container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Load more");
    assert.ok(more, page.container.innerHTML);
    const beforePress = listRequests(page).length;
    await act(async () => { more.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true, button: 0 })); });
    await page.settle();

    // The head keeps polling on its own timer, so the newest request is not
    // necessarily the paged one: assert against the request the press issued.
    const paged = listRequests(page).slice(beforePress).find((query) => query.get("before") !== null);
    assert.ok(paged, "the second page carries the cursor");
    assert.equal(paged.get("agentId"), "agent-match", "and the same filter");
    assert.ok(rowText(page).some((text) => text.includes("page-two-0")), "the older page is appended");
    assert.equal(rowText(page).some((text) => text.includes("other-agent")), false);
  } finally {
    await page.dispose();
  }
});

for (const outcome of ["success", "error"] as const) test(`stale Load more ${outcome} cannot update a new filter`, async () => {
  let finish!: (value: Response | Session[]) => void;
  const pending = new Promise<Response | Session[]>((resolve) => { finish = resolve; });
  const rows = Array.from({ length: 50 }, (_, index) => session({ id: `current-${index}`, executionStatus: "FAILED", requestedAt: at(index), startedAt: at(index) }));
  const page = await mountSessions(rows, "#/sessions", ({ path }) => queryOf(path).has("before") ? pending : rows);
  try {
    await page.press("Load more");
    await select(page, "data-session-filter-status", "failed");
    await act(async () => { finish(outcome === "success" ? [session({ id: "STALE", requestedAt: at(60), startedAt: at(60) })] : new Response(JSON.stringify({ error: "STALE" }), { status: 500 })); });
    await page.settle();
    assert.doesNotMatch(page.container.textContent ?? "", /STALE/u);
    const more = [...page.container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Load more");
    assert.ok(more);
    assert.equal(more.disabled, false);
  } finally { await page.dispose(); }
});

for (const [query, parameter, value] of [["status=running", "status", "running"], ["runner=pi", "runner", "pi"], ["range=custom&since=2026-02-31", "since", "2026-02-31"], ["until=bad", "until", "bad"]]) test(`invalid hash ${query} is explicitly refused`, async () => {
  const page = await mountSessions([], `#/sessions?${query}`, ({ path }) => {
    assert.equal(queryOf(path).get(parameter!), value);
    const parsed = parseSessionListFilters((key) => queryOf(path).get(key));
    assert.ok(parsed.refusal);
    return new Response(JSON.stringify({ error: parsed.refusal.message, code: parsed.refusal.code }), { status: 400 });
  });
  try {
    assert.ok(listRequests(page).length > 0);
    assert.match(page.container.textContent ?? "", new RegExp(`session-filter-${parameter}-invalid`));
  } finally { await page.dispose(); }
});

test("custom dates survive switching presets", async () => {
  const page = await mountSessions([], "#/sessions?range=custom&since=2026-08-01&until=2026-08-03");
  try {
    await select(page, "data-session-filter-range", "today");
    const mark = requestMark(page);
    await select(page, "data-session-filter-range", "custom");
    assert.equal(page.container.querySelector<HTMLInputElement>("[data-session-filter-since]")?.value, "2026-08-01");
    assert.equal(page.container.querySelector<HTMLInputElement>("[data-session-filter-until]")?.value, "2026-08-03");
    await requestSince(page, mark, (query) => query.get("since") === new Date(2026, 7, 1).toISOString(), "for the remembered custom window");
  } finally { await page.dispose(); }
});

test("Any time clears a custom window while remembering its dates", async () => {
  const page = await mountSessions([], "#/sessions?range=custom&since=2026-08-01&until=2026-08-03");
  try {
    const mark = requestMark(page);
    await select(page, "data-session-filter-range", "all");
    const whole = await requestSince(page, mark, (query) => !query.has("since"), "for the whole history");
    assert.equal(whole.get("until"), null, "Any time asks for the whole history");
    assert.equal(page.container.querySelector<HTMLSelectElement>("[data-session-filter-range]")?.value, "all", "the preset stays on Any time after a reload of the hash");
    await select(page, "data-session-filter-range", "custom");
    assert.equal(page.container.querySelector<HTMLInputElement>("[data-session-filter-since]")?.value, "2026-08-01");
  } finally { await page.dispose(); }
});

test("Today refreshes across midnight without a selection change", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 7, 16, 23, 59, 59) });
  const page = await mountSessions([], "#/sessions?range=today");
  try {
    const mark = requestMark(page);
    context.mock.timers.setTime(new Date(2026, 7, 17, 0, 0, 1).getTime());
    // The page schedules a real timer for the boundary. Wait for the request it
    // fires rather than for a sleep sized to outlast it: a descheduled callback
    // on a loaded host lands after any fixed sleep this test could pick.
    await requestSince(page, mark, (query) => query.get("since") === new Date(2026, 7, 17).toISOString(), "for the new day");
  } finally { await page.dispose(); }
});

test("one matching direct-chain session renders its resolved name", async () => {
  const page = await mountSessions([session({ id: "direct", task: { id: "task-direct", name: "Direct chain: Build", chainId: "direct-chain", chainName: "Direct chain" } })], "#/sessions?taskId=task-direct");
  try {
    assert.equal(page.container.querySelector("[data-session-chain]")?.textContent, "Direct chain");
    assert.equal(page.container.querySelector("[data-session-chain]")?.closest("a")?.getAttribute("href"), "#/sessions?chainId=direct-chain");
  } finally { await page.dispose(); }
});

for (const range of ["7d", "30d"]) test(`${range} refreshes on the hourly boundary`, async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 7, 16, 14, 59, 59) });
  const page = await mountSessions([], `#/sessions?range=${range}`);
  try {
    const initial = listRequests(page).at(-1)?.get("since");
    await page.settle();
    assert.equal(listRequests(page).at(-1)?.get("since"), initial);
    const next = new Date(2026, 7, 16, 15, 0, 1);
    const mark = requestMark(page);
    context.mock.timers.setTime(next.getTime());
    const rolled = new Date(next.getTime() - Number.parseInt(range, 10) * 86_400_000).toISOString();
    await requestSince(page, mark, (query) => query.get("since") === rolled, "for the new hour");
  } finally { await page.dispose(); }
});
