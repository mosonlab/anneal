import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";

import { sessionStatusMatches, type SessionStatusFilter } from "@anneal/db/session-filter-contract";

import { LocaleProvider } from "../lib/i18n";
import type { Session } from "../lib/types";
import { mountPage, type PageHarness } from "./dom-harness";

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

const mountSessions = async (rows: readonly Session[], hash = "#/sessions"): Promise<PageHarness> => {
  const [{ SessionsPage }, { ProjectProvider }] = await Promise.all([
    import("../pages/Sessions"), import("../lib/project"),
  ]);
  return await mountPage(
    <LocaleProvider initialLocale="en"><ProjectProvider><SessionsPage /></ProjectProvider></LocaleProvider>,
    {
      "/projects": [{ id: "p1", name: "Demo" }],
      "/projects/p1/agents": AGENTS,
      "/sessions": ({ path }) => narrow(rows, queryOf(path)),
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

    await select(page, "data-session-filter-status", "cancelled");
    assert.deepEqual(listRequests(page).at(-1)?.get("status"), "cancelled");
    assert.equal(rowText(page).length, 1);
    assert.ok(rowText(page)[0]?.includes("cancelled-match"));

    await select(page, "data-session-filter-status", "all");
    await select(page, "data-session-filter-agent", "agent-other");
    assert.equal(listRequests(page).at(-1)?.get("agentId"), "agent-other");
    assert.equal(listRequests(page).at(-1)?.get("status"), null, "clearing an axis drops it from the request");
    assert.deepEqual(rowText(page).length, 1);

    await select(page, "data-session-filter-runner", "CODEX");
    const combined = listRequests(page).at(-1);
    assert.equal(combined?.get("agentId"), "agent-other");
    assert.equal(combined?.get("runner"), "CODEX");
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
    await select(page, "data-session-filter-range", "today");
    const since = listRequests(page).at(-1)?.get("since");
    assert.ok(since, "a preset resolves to an instant the route can filter on");
    assert.equal(new Date(since).getTime() <= Date.now(), true);
    assert.equal(rowText(page).length, 1, "only today's row survives the window");
    assert.match(hashOf(page), /range=today/u);

    await select(page, "data-session-filter-range", "custom");
    const from = page.container.ownerDocument.querySelector<HTMLInputElement>("[data-session-filter-since]");
    const to = page.container.ownerDocument.querySelector<HTMLInputElement>("[data-session-filter-until]");
    assert.ok(from, "the custom window offers its two date boxes");
    assert.ok(to);

    const clear = [...page.container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Clear");
    assert.ok(clear);
    await act(async () => { clear.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true, button: 0 })); });
    await page.settle();
    assert.equal(listRequests(page).at(-1)?.get("since"), null);
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
  const { SESSION_SEARCH_DEBOUNCE_MS } = await import("../pages/Sessions");
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

    await type("Log");
    assert.equal(page.requests.length, before, "typing alone does not reach the server");

    await act(async () => {
      await new Promise((resolve) => page.dom.window.setTimeout(resolve, SESSION_SEARCH_DEBOUNCE_MS + 80));
    });
    await page.settle();
    assert.equal(listRequests(page).at(-1)?.get("q"), "Log");
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

    await act(async () => { chainLink?.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true, button: 0 })); });
    await page.settle();
    assert.equal(listRequests(page).at(-1)?.get("chainId"), "chain-1");
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
    await act(async () => { more.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true, button: 0 })); });
    await page.settle();

    const paged = listRequests(page).at(-1);
    assert.ok(paged?.get("before"), "the second page carries the cursor");
    assert.equal(paged?.get("agentId"), "agent-match", "and the same filter");
    assert.ok(rowText(page).some((text) => text.includes("page-two-0")), "the older page is appended");
    assert.equal(rowText(page).some((text) => text.includes("other-agent")), false);
  } finally {
    await page.dispose();
  }
});
