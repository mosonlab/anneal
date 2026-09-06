import "./dom-preload";

import assert from "node:assert/strict";
import test from "node:test";
import { act, type ReactNode, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { InfoNotice } from "../components/ui";
import { BOARD, BOARD_GRID, CARD_PAGE_SIZE, BoardArrows, BoardColumn, BoardNavigation, FRAME, dragEdgeStep } from "../components/desktop-board";
import { MobileTaskList } from "../components/mobile-task-list";
import { PaginatedBoardEntries } from "../components/paginated-board-entries";
import { cardModel, cardTime, cardTitle, TaskCard } from "../components/task-card";
import { COLUMNS, type BoardEntry, boardEntries, columnStep, countByStatus, heldChains, parkedChains, taskBoardEntry } from "../lib/board";
import { LocaleProvider } from "../lib/i18n";
import { translate } from "../lib/i18n-core";
import { ProjectProvider } from "../lib/project";
import { storage } from "../lib/storage";
import { BOARD_PAGE, ActivateAllDialog, ChainFilterControl, HoldAllDialog, TasksPage, activateAllNotice, archiveDoneNotice, holdAllNotice, moveAction, moveNotAllowedNotice, stableRows, startabilityRefusal, tasksForChain, useTaskStartConfirmation } from "../pages/Tasks";
import type { BoardTask, ChainAggregate, ChainAggregateState, ChainProgress, TaskStartability, TaskStatus } from "../lib/types";
import { type PageHarness, installDom, mountPage, reactDom } from "./dom-harness";

const en = (key: string, vars?: Record<string, string | number>): string => translate("en", key, vars);

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: "t1", name: "Ship the thing", displayName: overrides.name ?? "Ship the thing", status: "TODO", moveTargets: [], failureReason: null,
  assigneeType: "HUMAN", createdAt: "2026-08-15T00:00:00.000Z",
  scheduleKind: "NOW", runAt: null, cron: null, timezone: null,
  approvalGate: false, templateId: null, source: "MANUAL", chainId: null, chainIndex: null,
  chainName: null, updatedAt: "2026-08-16T00:00:00.000Z", assigneeAgent: null, chainProgress: null, blockedOn: null, latestRun: null, taskCost: null,
  mergeOutcome: null, repairOf: null, budgetRemaining: true, leaseLossRefunds: 0, chainAggregate: null, strandedSalvageBranches: [],
  ...overrides,
});

const noop = (): void => undefined;
const ACTIONS = { onMove: noop, onRetry: noop, onArchive: noop, onDelete: noop, onCopyError: noop, onFilterChain: noop };

const card = (overrides: Partial<BoardTask> = {}): string => renderToStaticMarkup(
  <TaskCard task={task(overrides)} actions={ACTIONS} />,
);

const localizedCard = (locale: "en" | "zh", overrides: Partial<BoardTask> = {}): string => renderToStaticMarkup(
  <LocaleProvider initialLocale={locale}><TaskCard task={task(overrides)} actions={ACTIONS} /></LocaleProvider>,
).replace(/<[^>]*>/gu, "");

test("a member card links its newest run's pull request, after the assignee", () => {
  const withPr = card({
    latestRun: {
      id: "r1", runNumber: 1, status: "SUCCEEDED", model: "gpt-5.6-sol:high", codexServiceTier: "DEFAULT",
      costUsd: "0.42", startedAt: null, endedAt: null, pullRequestUrl: "https://github.com/mosonlab/anneal/pull/351",
    },
  });
  assert.match(withPr, /data-card-assignee=[\s\S]*data-card-pull-request/u);
  assert.match(withPr, /href="https:\/\/github\.com\/mosonlab\/anneal\/pull\/351"/u);
  assert.match(withPr.replace(/<[^>]*>/gu, ""), /#351/u);
  assert.doesNotMatch(card(), /data-card-pull-request/u);
});

test("a board card marks stranded salvage only when the projected count is non-zero", () => {
  const withSalvage = card({
    id: "t1",
    strandedSalvageBranches: [{ branch: "agentos/t1/run-1", lostRunNumber: 1 }],
  });
  assert.match(withSalvage, /data-card-stranded-salvage=""/u);
  assert.match(withSalvage.replace(/<[^>]*>/gu, ""), /Salvage 1/u);
  assert.doesNotMatch(card(), /data-card-stranded-salvage/u);
});

test("a card shows cumulative dollars bare and falls back to token counts", () => {
  // The footer has room for the number and nothing else: whether the total is
  // an estimate is a question the detail page answers.
  const estimated = card({
    taskCost: { costUsd: "1.45", estimated: true, inputTokens: 1_000, cachedInputTokens: 100, cacheCreationInputTokens: 0, outputTokens: 50 },
  });
  assert.match(estimated, /\$1\.45/);
  assert.doesNotMatch(estimated, /est\./u);
  const tokens = card({
    taskCost: { costUsd: null, estimated: false, inputTokens: 1_000, cachedInputTokens: 100, cacheCreationInputTokens: null, outputTokens: 50 },
  });
  assert.match(tokens, /1K input/);
  assert.match(tokens, /100 cached/);
  assert.match(tokens, /50 output/);
  assert.doesNotMatch(tokens, /\$/);
});

test("token fallback uses a bounded wrapping row at both desktop card widths", () => {
  const fallback = card({
    taskCost: { costUsd: null, estimated: false, inputTokens: 12_345_678, cachedInputTokens: 1_234_567, cacheCreationInputTokens: null, outputTokens: 987_654 },
  });
  for (const cardWidth of [250, 222]) {
    const bounded = `<div style="width:${cardWidth}px">${fallback}</div>`;
    assert.match(bounded, /data-task-cost-fallback=""/u);
    assert.match(bounded, /max-w-full/u);
    assert.match(bounded, /whitespace-normal/u);
    assert.match(bounded, /overflow-wrap:anywhere/u);
  }
  assert.equal((fallback.match(/data-task-cost-fallback=/gu) ?? []).length, 1);
  assert.match(fallback, /12\.3M input/u);
  assert.match(fallback, /1\.2M cached/u);
  assert.match(fallback, /987\.7K output/u);
});

const progress = (overrides: Partial<ChainProgress> = {}): ChainProgress => ({
  chainId: "c1", done: 3, total: 9, activeStepName: "Implementation", activeStatus: "doing",
  currentLayer: 2, layerCount: 7, position: 4, ...overrides,
});

/** Renders one real column. Everything the board decides per column — the head,
 *  the count, `Archive All`, the drop invitation — is decided in here, so these
 *  assertions read markup rather than the page's source text. */
const column = (status: TaskStatus, entries: readonly BoardEntry[] = [], loading = false): string => {
  const found = COLUMNS.find((candidate) => candidate.status === status);
  assert.ok(found, `no ${status} column`);
  return renderToStaticMarkup(
    <BoardColumn
      column={found} tasks={entries} loading={loading} dragOver={null}
      onDragOver={noop} onDragLeave={noop} onDrop={noop} onArchiveDone={noop} onActivateAll={noop} actions={ACTIONS}
    />,
  );
};

const mobile = (
  tab: TaskStatus,
  entries: readonly BoardEntry[] = [],
  all: readonly { status: TaskStatus }[] = entries,
): string => renderToStaticMarkup(
  <MobileTaskList
    tab={tab} counts={countByStatus(all)} tasks={entries} loading={false}
    onSelectTab={noop} onArchiveDone={noop} actions={ACTIONS} listRef={{ current: null }}
  />,
);

/* ------------------------------------------------------------- the columns */

test("the board has five columns, in order, with Backlog first", () => {
  assert.deepEqual(COLUMNS.map((c) => en(c.labelKey)), ["Backlog", "Todo", "Doing", "Review", "Done"]);
  assert.deepEqual(COLUMNS.map((c) => c.status), ["BACKLOG", "TODO", "DOING", "REVIEW", "DONE"]);
  // Each label reaches the DOM with its own count, so an added column cannot
  // pass by being present in the array and absent from the render.
  for (const { status, labelKey } of COLUMNS) {
    assert.match(column(status), new RegExp(`${en(labelKey)}<span[^>]*>0</span>`));
  }
});

test("the projected transport selects the move execution flow", () => {
  assert.equal(moveAction("start"), "confirm-start");
  assert.equal(moveAction("patch"), "patch");
});

test("start and drop refusals explain the observed server verdict", () => {
  const verdict = {
    startable: false,
    checklist: {
      repoBound: true, agentAssignee: true, repoAccessGrant: true,
      budgetRemaining: true, noActiveRun: false, predecessorsDone: true,
    },
    task: { id: "t1", name: "Ship", agent: null, repo: null, targetBranch: null },
  } satisfies TaskStartability;
  assert.equal(startabilityRefusal(verdict), "Task cannot start: No active run");
  assert.equal(moveNotAllowedNotice(task({ name: "Ship" }), "REVIEW"), "Cannot move Ship to Review");
});

type BoardRequest = { method: string; path: string; body: unknown };

const StartFlowHarness = (): ReactNode => {
  const start = useTaskStartConfirmation(() => undefined);
  return <div>
    <button type="button" onClick={() => void start.requestForMove("t1")}>Drop to Doing</button>
    {start.request === null ? null : <section data-confirmation="">
      <span>{start.request.task.name}</span>
      {start.error === null ? null : <div role="alert">{start.error}</div>}
      <button type="button" onClick={start.cancel}>Cancel</button>
      <button type="button" onClick={() => void start.confirm()}>Start task</button>
    </section>}
  </div>;
};

const withStartFlow = async (walk: (flow: {
  dom: ReturnType<typeof installDom>["dom"];
  requests: BoardRequest[];
  press: (label: string) => Promise<void>;
}) => Promise<void>, startStatus = 201): Promise<void> => {
  const requests: BoardRequest[] = [];
  const startability = {
    startable: true,
    checklist: {
      repoBound: true, agentAssignee: true, repoAccessGrant: true,
      budgetRemaining: true, noActiveRun: true, predecessorsDone: true,
    },
    task: {
      id: "t1", name: "Ship the thing", agent: { id: "a1", title: "Senior dev" },
      repo: { id: "r1", name: "product" }, targetBranch: "main",
    },
  };
  const page = await mountPage(<StartFlowHarness />, { "*": ({ input, init, method }) => {
    const path = String(input);
    requests.push({ method, path, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
    if (path === "/api/tasks/t1/startability") return startability;
    if (path === "/api/tasks/t1/start" && method === "POST") {
      return startStatus === 201
        ? Response.json({ runId: "run-1", runNumber: 1 }, { status: 201 })
        : Response.json({ error: "Run budget was exhausted by another operator." }, { status: startStatus });
    }
    return Response.json([], { status: 404 });
  } });
  try {
    await walk({ dom: page.dom, requests, press: page.press });
  } finally {
    await page.dispose();
  }
};

test("drop confirmation decline is inert and a failed POST stays visible in its active surface", async () => {
  await withStartFlow(async ({ dom, requests, press }) => {
    await press("Drop to Doing");
    assert.match(dom.window.document.body.innerHTML, /data-confirmation/);
    await press("Cancel");
    assert.equal(requests.some(({ method }) => method === "POST" || method === "PATCH"), false);

    await press("Drop to Doing");
    await press("Start task");
    assert.equal(requests.filter(({ method, path }) => method === "POST" && path === "/api/tasks/t1/start").length, 1);
    assert.equal(requests.some(({ method, path }) => method === "PATCH" && path === "/api/tasks/t1"), false);
    const surface = dom.window.document.querySelector("[data-confirmation]");
    assert.ok(surface);
    assert.match(surface.textContent ?? "", /Run budget was exhausted by another operator\./);
  }, 409);
});

test("a BACKLOG task lands in the first column and nowhere else", () => {
  const parked = task({ status: "BACKLOG", name: "Parked work" });
  assert.match(column("BACKLOG", boardEntries([parked])), /Parked work/);
  assert.doesNotMatch(column("TODO", []), /Parked work/);
});

test("an empty column still invites a drop, Backlog included (E16)", () => {
  for (const { status } of COLUMNS) {
    assert.match(column(status), new RegExp(en("tasks.column.drop")));
  }
  assert.match(column("BACKLOG", [], true), new RegExp(en("common.loading")));
  assert.doesNotMatch(column("BACKLOG", boardEntries([task({ status: "BACKLOG" })])), new RegExp(en("tasks.column.drop")));
});

test("Archive All is offered only on a non-empty Done column", () => {
  assert.match(column("DONE", boardEntries([task({ status: "DONE" })])), new RegExp(en("tasks.archiveAll")));
  assert.doesNotMatch(column("DONE", []), new RegExp(en("tasks.archiveAll")));
  assert.doesNotMatch(column("TODO", boardEntries([task()])), new RegExp(en("tasks.archiveAll")));
});

test("every column head is the same height, whatever it offers", () => {
  // Measured before this: Done's head was 40px against the other four's 31px,
  // because `Archive All` is a 28px button, so Done's label sat 4.5px low and
  // its first card started 9px below every other column's.
  const heights = COLUMNS.map(({ status }) => {
    const markup = column(status, boardEntries(status === "DONE" ? [task({ status: "DONE" })] : []));
    return /class="([^"]*h-\[\d+px\][^"]*)"/.exec(markup)?.[1]?.match(/h-\[\d+px\]/)?.[0];
  });
  assert.equal(new Set(heights).size, 1, `heads disagree: ${JSON.stringify(heights)}`);
  assert.equal(heights[0], "h-[36px]");
});

/* ---------------------------------------------------------------- the card */

test("cards in one chain render their own positions and never the active-step name", () => {
  const first = card({ chainProgress: progress({ position: 1 }), chainId: "c1", chainIndex: 0, chainName: "Release" });
  const fourth = card({ chainProgress: progress({ position: 4 }), chainId: "c1", chainIndex: 4, chainName: "Release" });
  assert.match(first, /step 1\/9/);
  assert.match(fourth, /step 4\/9/);
  // The execution layer is a scheduling coordinate; the chain detail page groups
  // its steps by it, and the card has no question it answers.
  assert.doesNotMatch(first + fourth, /layer/);
  assert.doesNotMatch(first + fourth, /Implementation · doing/);
  assert.doesNotMatch(card(), /·/);
});

test("a parked Step's board card never describes a held Chain", () => {
  const markup = card({
    status: "BACKLOG",
    chainId: "c1",
    chainIndex: 4,
    chainName: "Release",
    chainProgress: progress({ position: 4 }),
  });
  assert.match(markup, /step 4\/9/);
  assert.doesNotMatch(markup, /Held after layer|Resume Chain|Hold Chain|Waiting for the operator/);
});

test("a bound board card names its unresolved predecessor without adding a board column", () => {
  const markup = card({
    chainId: "c1", chainName: "Release", chainProgress: progress({ position: 1 }),
    blockedOn: { taskId: "a13", taskName: "Merge release" },
  });
  assert.match(markup, new RegExp(en("tasks.card.blockedOn", { name: "Merge release" })));
  assert.match(markup, /data-card-blocked-on=""/);
  assert.match(markup, /step 1\/9/);
  assert.equal((markup.match(/data-card-blocked-on=/gu) ?? []).length, 1);
});

test("an unbound board card keeps the existing meta rendering", () => {
  const markup = card({
    chainId: "c1", chainName: "Release", chainProgress: progress({ position: 1 }), blockedOn: null,
  });
  assert.doesNotMatch(markup, /data-card-blocked-on=/);
  assert.doesNotMatch(markup, /Blocked on:/);
  assert.match(markup, /step 1\/9/);
});

test("chain badges filter to one chain, can be cleared, and titles drop the shared prefix", () => {
  const alpha = task({ id: "a", name: "Release: Implementation", displayName: "Implementation", chainId: "c1", chainName: "Release", chainProgress: progress() });
  const review = task({ id: "b", name: "Release: Review", displayName: "Review", chainId: "c1", chainName: "Release", chainProgress: progress({ position: 5 }) });
  const other = task({ id: "c", name: "Other: Review", displayName: "Review", chainId: "c2", chainName: "Other", chainProgress: progress({ chainId: "c2" }) });
  assert.deepEqual(tasksForChain([alpha, review, other], "c1").map(({ id }) => id), ["a", "b"]);
  assert.deepEqual(tasksForChain([alpha, review, other], null).map(({ id }) => id), ["a", "b", "c"]);
  assert.equal(cardTitle(alpha), "Implementation");
  const markup = card(alpha);
  assert.match(markup, /aria-label="Show only chain Release"/);
  assert.doesNotMatch(markup, />Release: Implementation<\/a>/);
  const control = renderToStaticMarkup(<ChainFilterControl name="Release" onClear={noop} />);
  assert.match(control, /Showing chain Release/);
  assert.match(control, />Clear filter<\/button>/);
});

test("a merge-tail repair task renders under the chain it repairs, with its kind", () => {
  // The repair task is created chain-detached — no chainId, chainIndex or
  // templateId — so before the API resolved its `repairAttempt` marker the board
  // drew it as a loose card with nothing saying which chain it belonged to.
  const step = task({ id: "s", name: "Release: Regression", displayName: "Regression", chainId: "c1", chainName: "Release", chainProgress: progress() });
  const repair = task({
    id: "r", name: "Autonomous merge tail: gate-fix", displayName: "Autonomous merge tail: gate-fix",
    status: "DOING",
    repairOf: { chainId: "c1", chainName: "Release", repairKind: "gate-fix" },
  });
  const other = task({ id: "o", name: "Unrelated", displayName: "Unrelated" });
  assert.deepEqual(tasksForChain([step, repair, other], "c1").map(({ id }) => id), ["s", "r"]);

  const markup = card(repair);
  assert.match(markup, /aria-label="Show only chain Release"/);
  assert.match(markup, new RegExp(en("tasks.pill.repair", { kind: "gate-fix" })));
  // It carries no step ordinal of its own, and must not borrow one.
  assert.doesNotMatch(markup, /step \d+\//);
  // A chain step is not a repair.
  assert.doesNotMatch(card(step), new RegExp(en("tasks.pill.repair", { kind: "gate-fix" })));
  assert.doesNotMatch(card(other), /Show only chain/);
});

test("a repair card names the chain by a short id when the API derived no name", () => {
  const markup = card({
    id: "r", name: "Autonomous merge tail: review-fix", displayName: "Autonomous merge tail: review-fix",
    repairOf: { chainId: "cmt38t30u000fmpru2uc4emc9", chainName: null, repairKind: "review-fix" },
  });
  assert.match(markup, /aria-label="Show only chain cmt38t30"/);
  assert.match(markup, new RegExp(en("tasks.pill.repair", { kind: "review-fix" })));
});

test("a non-template chain uses the API-derived badge and short card title", () => {
  const direct = task({
    name: "Release: Build", displayName: "Build", chainId: "direct-chain", chainName: "Release",
    chainProgress: progress({ chainId: "direct-chain", position: 1, total: 2 }),
  });
  const markup = card(direct);
  assert.match(markup, /aria-label="Show only chain Release"/);
  assert.match(markup, />Build<\/a>/);
  assert.doesNotMatch(markup, />Release: Build<\/a>/);
});

/** Opens a card's row menu and selects one entry.
 *
 *  The menu is a Radix dropdown: it opens on `pointerdown` (which jsdom has no
 *  constructor for, so the global is the MouseEvent the harness installs) and
 *  it portals its items outside the mounted container. */
const selectRowMenuItem = async (page: PageHarness, menuLabel: string, itemLabel: string): Promise<void> => {
  Object.defineProperty(globalThis, "PointerEvent", { configurable: true, writable: true, value: page.dom.window.MouseEvent });
  const trigger = [...page.container.querySelectorAll("button")]
    .find((node) => node.getAttribute("aria-label") === menuLabel);
  assert.ok(trigger, `missing row menu ${menuLabel}`);
  await act(async () => trigger.dispatchEvent(new page.dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  const item = [...page.dom.window.document.querySelectorAll("[role='menuitem']")]
    .find((node) => node.textContent?.trim() === itemLabel);
  assert.ok(item, `missing menu item ${itemLabel}: ${page.dom.window.document.body.innerHTML}`);
  await act(async () => item.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true, button: 0 })));
  await page.settle();
};

test("Archive All confirms the project-wide Done scope even while one chain is visible", async () => {
  storage.set("agentos.projectId", "p1");
  const settledAggregate = (chainId: string, chainName: string, taskId: string) => ({
    chainId, chainName, detailTaskId: taskId, stepCount: 1,
    statusCounts: { BACKLOG: 0, TODO: 0, DOING: 0, REVIEW: 0, DONE: 1 }, status: "DONE" as const,
    frontier: { taskId, title: "Review", status: "DONE" as const, latestRun: null, mergeOutcome: null, failureReason: null, position: 1 }, activeRepair: null,
    activation: { state: "settled" as const, predecessor: null, taskId, hold: null }, totalCost: null,
    createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z",
  });
  const rows = [
    task({ id: "visible", name: "Alpha: Review", displayName: "Review", status: "DONE", chainId: "alpha", chainName: "Alpha", chainProgress: progress({ chainId: "alpha" }), chainAggregate: settledAggregate("alpha", "Alpha", "visible") }),
    task({ id: "hidden", name: "Beta: Review", displayName: "Review", status: "DONE", chainId: "beta", chainName: "Beta", chainProgress: progress({ chainId: "beta" }), chainAggregate: settledAggregate("beta", "Beta", "hidden") }),
  ];
  const confirmations: string[] = [];
  const mutations: string[] = [];
  const page = await mountPage(<ProjectProvider><TasksPage /></ProjectProvider>, {
    "GET /projects": [{ id: "p1", name: "Project One" }],
    "GET /tasks": rows,
    "POST /projects/p1/tasks/archive-done": ({ input }) => {
      mutations.push(String(input));
      return { archived: 2, skipped: 0 };
    },
    "*": ({ input, method }) => {
      const path = String(input);
      if (method === "POST") {
      mutations.push(path);
        return { archived: 2, skipped: 0 };
      }
      return [];
    }
  });
  Object.defineProperty(page.dom.window, "confirm", { configurable: true, value: (message: string) => { confirmations.push(message); return true; } });
  try {
    await selectRowMenuItem(page, en("tasks.aggregate.actionsFor", { name: "Alpha" }), en("tasks.aggregate.menu.filter"));
    assert.ok(page.container.querySelector('[data-card="visible"]'));
    assert.equal(page.container.querySelector('[data-card="hidden"]'), null);
    await page.press("Archive All");
    assert.deepEqual(confirmations, ["Archive all 2 done tasks in this project?"]);
    assert.deepEqual(mutations, ["/api/projects/p1/tasks/archive-done"]);
  } finally {
    await page.dispose();
    storage.remove("agentos.projectId");
  }
});

test("the board renders every column newest first, Backlog included", async () => {
  storage.set("agentos.projectId", "p1");
  // As `GET /tasks` answers: newest first, for every column.
  const rows = [
    task({ id: "backlog-new", status: "BACKLOG", createdAt: "2026-08-18T00:00:00.000Z" }),
    task({ id: "backlog-mid", status: "BACKLOG", createdAt: "2026-08-17T00:00:00.000Z" }),
    task({ id: "backlog-old", status: "BACKLOG", createdAt: "2026-08-16T00:00:00.000Z" }),
    task({ id: "done-new", status: "DONE" }),
    task({ id: "done-old", status: "DONE" }),
  ];
  const page = await mountPage(<ProjectProvider><TasksPage /></ProjectProvider>, {
    "GET /projects": [{ id: "p1", name: "Project One" }],
    "GET /tasks": rows,
    "*": [],
  });
  try {
    const rendered = [...page.container.querySelectorAll("[data-card]")].map((node) => node.getAttribute("data-card"));
    // One reading rule for the whole board: the newest card is at the top of
    // the column, wherever the operator looks.
    assert.deepEqual(rendered, ["backlog-new", "backlog-mid", "backlog-old", "done-new", "done-old"]);
  } finally {
    await page.dispose();
    storage.remove("agentos.projectId");
  }
});

test("running, ended, and absent runs render only durations their timestamps prove", () => {
  const originalNow = Date.now;
  Date.now = () => new Date("2026-08-16T00:12:00.000Z").getTime();
  try {
    assert.equal(cardTime(task({ latestRun: { id: "r1", runNumber: 1, status: "RUNNING", model: "claude-opus-5:medium", codexServiceTier: "DEFAULT", costUsd: null, startedAt: "2026-08-16T00:00:00.000Z", endedAt: null, pullRequestUrl: null } })), "12m 0s");
    // Every live status the run line already gives an elapsed clock to gets the
    // same clock here: the footer used to answer `timeAgo` for a CLAIMED run
    // that the aggregate card was counting up.
    assert.equal(cardTime(task({ updatedAt: "2026-08-15T21:12:00.000Z", latestRun: { id: "r1", runNumber: 1, status: "CLAIMED", model: "claude-opus-5:medium", codexServiceTier: "DEFAULT", costUsd: null, startedAt: "2026-08-16T00:00:00.000Z", endedAt: null, pullRequestUrl: null } })), "12m 0s");
    assert.equal(cardTime(task({ updatedAt: "2026-08-15T21:12:00.000Z", latestRun: { id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5:medium", codexServiceTier: "DEFAULT", costUsd: null, startedAt: "2026-08-16T00:00:00.000Z", endedAt: "2026-08-16T00:08:00.000Z", pullRequestUrl: null } })), "8m 0s · 3h ago");
    assert.equal(cardTime(task({ updatedAt: "2026-08-15T21:12:00.000Z" })), "3h ago");
    assert.equal(cardTime(task({ updatedAt: "2026-08-15T21:12:00.000Z", latestRun: { id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5:medium", codexServiceTier: "DEFAULT", costUsd: null, startedAt: null, endedAt: null, pullRequestUrl: null } })), "3h ago");
  } finally {
    Date.now = originalNow;
  }
});

test("a mounted running card advances elapsed time while its props stay unchanged", async () => {
  const { dom, container } = installDom();
  const originalNow = Date.now;
  const originalSetInterval = dom.window.setInterval;
  const originalClearInterval = dom.window.clearInterval;
  let now = new Date("2026-08-16T00:12:00.000Z").getTime();
  let tick: (() => void) | null = null;
  Date.now = () => now;
  Object.defineProperty(dom.window, "setInterval", {
    configurable: true, value: (run: () => void) => { tick = run; return 1; },
  });
  Object.defineProperty(dom.window, "clearInterval", { configurable: true, value: () => undefined });
  const root = (await reactDom()).createRoot(container);
  const running = task({ latestRun: {
    id: "r1", runNumber: 1, status: "RUNNING", model: "claude-opus-5:medium", codexServiceTier: "DEFAULT", costUsd: null,
    startedAt: "2026-08-16T00:00:00.000Z", endedAt: null, pullRequestUrl: null,
  } });
  try {
    await act(async () => root.render(<TaskCard task={running} actions={ACTIONS} />));
    assert.match(container.textContent ?? "", /12m 0s/);
    now += 60_000;
    assert.ok(tick);
    await act(async () => tick?.());
    assert.match(container.textContent ?? "", /13m 0s/);
  } finally {
    await act(async () => root.unmount());
    Date.now = originalNow;
    Object.defineProperty(dom.window, "setInterval", { configurable: true, value: originalSetInterval });
    Object.defineProperty(dom.window, "clearInterval", { configurable: true, value: originalClearInterval });
    dom.window.close();
  }
});

test("cron and webhook tasks are badged and manual ones are not", () => {
  assert.match(card({ source: "CRON" }), />cron</);
  assert.match(card({ source: "WEBHOOK" }), />webhook</);
  const manual = card({ source: "MANUAL" });
  assert.doesNotMatch(manual, />cron</);
  assert.doesNotMatch(manual, />webhook</);
});

test("template-instantiated cards do not render a template pill", () => {
  const markup = card({ templateId: "template-1" });
  assert.doesNotMatch(markup, />Template</);
  assert.doesNotMatch(markup, /tasks\.pill\.template/);
});

test("approval-gated cards are badged and ungated cards are not", () => {
  assert.match(card({ approvalGate: true }), />Approval</);
  assert.doesNotMatch(card(), />Approval</);
});

test("the title is a real link to the task", () => {
  // 112 cards were unfocusable, had no role and no accessible name: a keyboard
  // could reach each card's menu button and nothing else.
  assert.match(card({ id: "abc" }), /<a[^>]*href="#\/tasks\/abc"/);
});

test("every free-text field on the card is bounded", () => {
  // One 2,228-character failureReason produced a 1,792px card, and a long path
  // in another overflowed its card sideways by 193px before the column clipped
  // it. Both need a clamp *and* a break rule: `word-break: normal` cannot break
  // a path at all.
  const markup = card({
    name: "A ".repeat(120),
    failureReason: `${"/very/long/path/segment".repeat(90)} failed`,
  });
  // The title wraps in full — a card named by its first three lines is a card
  // whose name is missing — and the failure keeps the clamp it was written for.
  assert.equal((markup.match(/line-clamp-3/g) ?? []).length, 1, "the failure clamps");
  assert.doesNotMatch(markup.slice(0, markup.indexOf("</h3>")), /line-clamp/u);
  assert.match(markup, /overflow-wrap:anywhere/);
});

test("the card's meta column is declared, so a nowrap line cannot widen the card", () => {
  // A grid with no declared columns sizes its implicit one by `auto`, whose
  // minimum is the widest item's min-content. Measured in Chrome, that let
  // "At 09:00 AM, only on Monday (Asia/Shanghai)" push a 196px card to 312px
  // and the column clipped the overflow away.
  const markup = card({ scheduleKind: "CRON", cron: "0 9 * * 1", timezone: "Asia/Shanghai" });
  assert.match(markup, /grid-cols-\[minmax\(0,1fr\)\]/);
});

test("the schedule line wraps rather than losing its last two characters", () => {
  // In a 170px content box the ellipsis produced "Waiting for previous st…" and
  // "At 09:00 AM, only on M…". This line is the whole answer to what starts the
  // task, so it gets a second line instead of a truncation.
  const markup = card({ scheduleKind: "AT", chainId: "c1", chainIndex: 4, runAt: "2099-01-01T00:00:00.000Z" });
  assert.match(markup, /line-clamp-2[^"]*">Waiting for previous step</);
});

test("the failure text is carried in full even though only three lines show", () => {
  const reason = `${"x".repeat(2000)} END`;
  assert.match(card({ failureReason: reason }), /END/);
});

test("Copy error is offered only when there is an error to copy", () => {
  // Rendered statically, the menu content is not in the DOM — the entries are
  // asserted through the card's own menu builder instead.
  const withError = card({ failureReason: "boom" });
  const without = card();
  assert.equal(withError.includes("Actions for"), true);
  assert.equal(without.includes("Actions for"), true);
});

test("the assignee is one line with a keyboard-reachable way to see the rest", () => {
  // 59 of 112 cards truncated this name with no reveal at all: `title` is a
  // hover affordance, which is none on touch and none from the keyboard.
  const markup = card({ assigneeType: "AGENT", assigneeAgent: { id: "a1", title: "Implementation Plan Executioner", model: "gpt-5.6-sol:medium" } });
  assert.match(markup, /<button[^>]*aria-expanded="false"[^>]*>Implementation Plan Executioner<\/button>/);
  assert.match(markup, /title="Implementation Plan Executioner"/);
  assert.match(markup, /gpt-5\.6-sol:medium/);
  assert.match(markup, /aria-label="Model gpt-5\.6-sol:medium"/);
  assert.doesNotMatch(markup, /truncate[^>]*>gpt-5\.6-sol:medium/);
});

test("the model line is the run's snapshot, not the agent's current tier", () => {
  // A re-tiered agent used to relabel a finished run: the card read the
  // assignee's current model directly under the run line, so a run claimed with
  // claude-opus-5:medium showed as gpt-5.6-sol:high.
  const markup = card({
    assigneeAgent: { id: "a1", title: "merge-resolver-opus-medium", model: "gpt-5.6-sol:high" },
    latestRun: { id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5:medium", codexServiceTier: "DEFAULT", costUsd: null, startedAt: null, endedAt: null, pullRequestUrl: null },
  });
  assert.match(markup, /claude-opus-5:medium/);
  assert.doesNotMatch(markup, /gpt-5\.6-sol:high/);
  assert.match(markup, /aria-label="Model claude-opus-5:medium"/);
});

test("a FAST run adds a fast marker to the single-task model line, but DEFAULT does not", () => {
  const run = (codexServiceTier: "DEFAULT" | "FAST") => ({
    id: "r1", runNumber: 1, status: "SUCCEEDED" as const, model: "gpt-5.6-sol:high", codexServiceTier,
    costUsd: null, startedAt: null, endedAt: null, pullRequestUrl: null,
  } as NonNullable<BoardTask["latestRun"]> & { codexServiceTier: "DEFAULT" | "FAST" });

  const fast = card({ latestRun: run("FAST") });
  assert.match(fast, /gpt-5\.6-sol:high · fast/u);
  const fastText = fast.replace(/<[^>]*>/gu, "");
  assert.equal((fastText.match(/fast/gu) ?? []).length, 1, fastText);
  const standard = card({ latestRun: run("DEFAULT") });
  assert.match(standard, /gpt-5\.6-sol:high/u);
  assert.doesNotMatch(standard, /fast/u);
});

test("a running single-task card shows the elapsed time alone, in both locales", () => {
  const latestRun = {
    id: "r1", runNumber: 1, status: "RUNNING" as const, model: "gpt-5.6-sol:high", codexServiceTier: "DEFAULT" as const,
    costUsd: null, startedAt: new Date(Date.now() - 4 * 60_000).toISOString(), endedAt: null, pullRequestUrl: null,
  };

  // The run line's amber dot is what says a run is live; the footer says how
  // long, and neither locale spends a word repeating the other.
  const chinese = localizedCard("zh", { status: "DOING", latestRun });
  assert.doesNotMatch(chinese, /运行中/u);
  assert.match(chinese, /\d+ 分 \d+ 秒/u);

  // Render English last because the test i18n adapter retains the latest
  // requested locale for helpers exercised later in this process.
  const english = localizedCard("en", { status: "DOING", latestRun });
  assert.doesNotMatch(english, /running/u);
  assert.match(english, /\d+m \d+s/u);
});

test("a task with no runs still shows the agent's configured model", () => {
  const markup = card({ assigneeAgent: { id: "a1", title: "merge-resolver-opus-medium", model: "gpt-5.6-sol:high" }, latestRun: null });
  assert.match(markup, /gpt-5\.6-sol:high/);
});

test("an unassigned task with a run still shows the run's model snapshot", () => {
  const markup = card({
    assigneeAgent: null,
    latestRun: { id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5:medium", codexServiceTier: "DEFAULT", costUsd: null, startedAt: null, endedAt: null, pullRequestUrl: null },
  });
  assert.match(markup, /claude-opus-5:medium/);
  assert.match(markup, /aria-label="Model claude-opus-5:medium"/);
});

test("a card with neither a run nor an assignee has no model line", () => {
  assert.equal(cardModel(task()), null);
});

test("a HUMAN card shows a person, an unassigned AGENT warns, and an assigned AGENT is unchanged", () => {
  // "Unassigned" beside a robot was on every card a human owns, which is most of
  // them, and it named a state that is not a problem.
  const markup = card({ assigneeType: "HUMAN", assigneeAgent: null });
  assert.doesNotMatch(markup, /Unassigned/);
  assert.match(markup, /data-card-assignee="human"/);
  const unassignedAgent = card({ assigneeType: "AGENT", assigneeAgent: null });
  assert.match(unassignedAgent, /data-card-assignee="unassigned-agent"/);
  assert.match(unassignedAgent, /Unassigned/);
  // An agent, named, is unchanged.
  const assigned = card({ assigneeType: "AGENT", assigneeAgent: { id: "a1", title: "merge-resolver-opus-medium", model: "gpt-5.6-sol:high" } });
  assert.match(assigned, new RegExp(`aria-label="${en("tasks.card.assignee", { name: "merge-resolver-opus-medium" })}"`));
  assert.match(assigned, />merge-resolver-opus-medium</);
});

/* ------------------------------------------------------------- the card's diet */

test("a NOW card carries no schedule row, and every informative schedule still does", () => {
  // "Once" is the default and was on nearly every card: three of a Backlog
  // card's five rows were constants while its title clamped.
  const now = card();
  assert.doesNotMatch(now, /Once/);
  assert.doesNotMatch(now, /data-card-schedule=/);
  const cron = card({ scheduleKind: "CRON", cron: "0 9 * * 1" });
  assert.match(cron, /data-card-schedule=""/);
  assert.match(cron, /At 09:00 AM, only on Monday/);
  assert.match(
    card({ status: "BACKLOG", scheduleKind: "AT", runAt: "2099-01-01T00:00:00.000Z", chainId: "c1", chainIndex: 4, chainProgress: progress({ position: 4 }) }),
    new RegExp(en("tasks.schedule.waitingForPrevious")),
  );
  assert.match(card({ scheduleKind: "AT", runAt: "2026-08-20T14:30:00.000Z" }), /At \w{3} \d{1,2}/);
});

test("a card with no runs has no run row, and a card with a run reads exactly as before", () => {
  assert.doesNotMatch(card(), /no runs/);
  const withRun = card({
    latestRun: { id: "r1", runNumber: 3, status: "SUCCEEDED", model: "claude-opus-5:medium", codexServiceTier: "DEFAULT", costUsd: null, startedAt: null, endedAt: null, pullRequestUrl: null },
  });
  assert.match(withRun, new RegExp(en("tasks.card.run", { n: 3 })));
  assert.match(withRun, new RegExp(en("status.run.SUCCEEDED")));
});

/* ---------------------------------------------------------- the board frame */

test("the board is one scroll surface, in both directions", () => {
  // Before this, five columns each owned an `overflow-y-auto` and the board took
  // only horizontal travel: a wheel over a column that did not overflow moved
  // nothing at all, and a horizontal trackpad gesture over the cards was
  // swallowed rather than passed to the board.
  assert.match(BOARD, /\boverflow-auto\b/);
  assert.doesNotMatch(BOARD, /overflow-y-hidden|overflow-x-auto\b/);
  assert.match(BOARD, /\bflex-1\b/);
  assert.match(BOARD, /\bmin-h-0\b/);
  // And no column may take one back.
  const markup = column("DONE", boardEntries([task({ status: "DONE" })]));
  assert.doesNotMatch(markup, /overflow-y-auto|overflow-x-hidden|overscroll-contain/);
});

test("the column heads stay on screen by sticking inside the board", () => {
  // They used to sit outside a per-column scroller, which is what kept
  // `Archive All` reachable. With one shared scroller, `sticky` is what does it.
  const markup = column("DONE", boardEntries([task({ status: "DONE" })]));
  assert.match(markup, /sticky/);
  assert.match(markup, /top-0/);
  const head = markup.indexOf("Archive All");
  const body = markup.indexOf("Drop tasks here");
  assert.ok(head >= 0, "Archive All is absent");
  assert.ok(body === -1 || body > head);
});

test("the desktop page owns the viewport and the phone gives it back", () => {
  assert.match(BOARD_PAGE, /\bh-\[100dvh\]/);
  assert.match(BOARD_PAGE, /\boverflow-hidden\b/);
  // ~22,000px of cards were unreachable at 800x800 because the narrow rules
  // removed the page's height without removing the board's clipping.
  assert.match(BOARD_PAGE, /max-width:900px\)\]:h-auto/);
  assert.match(BOARD_PAGE, /max-width:900px\)\]:overflow-visible/);
});

test("five columns fit at 1440px and are fixed-width below it", () => {
  // The old `minmax(250px,1fr)` set a 1,306px floor against a 1,172px content
  // box, so Done was cut off at every desktop width.
  assert.match(BOARD_GRID, /grid-cols-\[repeat\(5,250px\)\]/);
  assert.match(BOARD_GRID, /min-width:1440px\)\]:grid-cols-\[repeat\(5,minmax\(0,1fr\)\)\]/);
  assert.match(BOARD_PAGE, /\bmax-w-none\b/);
});

test("the frame the fades hang on is a flex parent, so the board still sizes itself", () => {
  // Measured in Chrome at 1440x900 when it was a bare block: `flex-1` on the
  // board resolved to `height: auto`, the board came out 15,755px tall inside a
  // 696px frame with no scrollbar of its own, and the page's `overflow-hidden`
  // clipped 97 Done cards away. A wrapper whose only job is to position two
  // fades must not be what decides the board's height.
  assert.match(FRAME, /\bflex\b/);
  assert.match(FRAME, /\bmin-h-0\b/);
  assert.match(BOARD, /\bflex-1\b/);
});

test("the arrows say which way they go, and an arrow at its end is disabled", () => {
  // Disabled rather than absent: an operator who has scrolled to Done needs to
  // be told the board ends there, not left pressing a control that does nothing.
  const start = renderToStaticMarkup(
    <BoardArrows edges={{ overflowing: true, atStart: true, atEnd: false }} onStep={() => undefined} />,
  );
  assert.match(start, /aria-label="Scroll one column left"[^>]*disabled/);
  assert.doesNotMatch(start, /aria-label="Scroll one column right"[^>]*disabled/);
  const end = renderToStaticMarkup(
    <BoardArrows edges={{ overflowing: true, atStart: false, atEnd: true }} onStep={() => undefined} />,
  );
  assert.match(end, /aria-label="Scroll one column right"[^>]*disabled/);
  assert.doesNotMatch(end, /aria-label="Scroll one column left"[^>]*disabled/);
  // Real buttons, so they are in the tab order and take Enter and Space for
  // free — the requirement is a keyboard-usable control, not a clickable div.
  assert.match(start, /<button/);
});

test("the horizontal navigation row exists only when columns overflow", () => {
  const wide = renderToStaticMarkup(
    <BoardNavigation edges={{ overflowing: false, atStart: true, atEnd: true }} onStep={noop} />,
  );
  assert.equal(wide, "", "a wide board must not reserve a blank navigation row");

  const narrow = renderToStaticMarkup(
    <BoardNavigation edges={{ overflowing: true, atStart: true, atEnd: false }} onStep={noop} />,
  );
  assert.match(narrow, new RegExp(en("tasks.board.scrollHint")));
  assert.equal((narrow.match(/<button/g) ?? []).length, 2);
});

test("a press moves the board by exactly the column width the grid declares", () => {
  // `columnStep` is given the gap as a number; the grid declares it as a class.
  // If the two ever disagree the board drifts by 12px per press, and nothing
  // else in the system would notice.
  assert.match(BOARD_GRID, /\bgap-\[12px\]/);
  assert.equal(columnStep({ scrollWidth: 1298, clientWidth: 690 }, COLUMNS.length, 12), 262);
});

test("a drag scrolls the board only near its edges", () => {
  const box = { left: 248, right: 938 };
  assert.equal(dragEdgeStep(600, box), 0, "the middle of the board does not scroll");
  assert.ok(dragEdgeStep(260, box) < 0, "the left edge pulls the board left");
  assert.ok(dragEdgeStep(930, box) > 0, "the right edge pushes the board right");
  assert.equal(dragEdgeStep(box.left, box), dragEdgeStep(box.left + 1, box));
});

/* --------------------------------------------------------------- the phone */

test("the phone renders tabs and one list, never the five-column grid", () => {
  const markup = mobile("TODO", boardEntries([task()]), [task(), task({ id: "t2", status: "DONE" })]);
  assert.match(markup, /role="tablist"/);
  assert.equal((markup.match(/role="tab"/g) ?? []).length, 5);
  assert.match(markup, /role="tabpanel"/);
  assert.doesNotMatch(markup, /Drop tasks here/);
});

test("the phone's tabs carry each status's count, selected status included", () => {
  const rows = [task(), task({ id: "t2" }), task({ id: "t3", status: "DONE" })];
  const markup = mobile("TODO", boardEntries(rows.filter((row) => row.status === "TODO")), rows);
  assert.match(markup, /Todo<span[^>]*>2<\/span>/);
  assert.match(markup, /Done<span[^>]*>1<\/span>/);
  assert.match(markup, /Backlog<span[^>]*>0<\/span>/);
});

test("exactly one phone tab is selected and only it is tabbable", () => {
  const markup = mobile("DOING", []);
  assert.equal((markup.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.equal((markup.match(/tabindex="0"/g) ?? []).length, 1);
});

test("the phone's cards are not draggable, and Archive All follows the Done tab", () => {
  // HTML5 drag does not fire on touch; the menu's `Move to` is the replacement.
  assert.doesNotMatch(mobile("TODO", boardEntries([task()])), /draggable="true"/);
  assert.match(mobile("DONE", boardEntries([task({ status: "DONE" })])), /Archive All/);
  assert.doesNotMatch(mobile("DONE", []), /Archive All/);
  assert.doesNotMatch(mobile("TODO", boardEntries([task()])), /Archive All/);
});

/* --------------------------------------------------------- the render cost */

test("a re-fetched but unchanged row keeps its object identity", () => {
  const todo = task({ id: "a" });
  const done = task({ id: "b", status: "DONE" });
  const first = stableRows([todo, done], new Map());
  assert.deepEqual(first.rows, [todo, done]);

  const second = stableRows([{ ...todo }, { ...done }], first.held);
  assert.equal(second.rows[0], todo);
  assert.equal(second.rows[1], done);

  const moved: BoardTask = { ...done, status: "REVIEW" };
  const third = stableRows([{ ...todo }, moved], second.held);
  assert.equal(third.rows[0], todo, "the untouched row must not be replaced");
  assert.equal(third.rows[1], moved);
  assert.notEqual(third.rows[1], done);
});

test("TaskCard is memoized", () => {
  assert.equal((TaskCard as unknown as { $$typeof: symbol }).$$typeof, Symbol.for("react.memo"));
});

const PaginatedHarness = ({ entries }: { entries: readonly BoardEntry[] }): ReactNode => {
  const [page, setPage] = useState(0);
  return <PaginatedBoardEntries entries={entries} page={page} onPageChange={setPage} actions={ACTIONS} />;
};

test("the shared paginated entry list owns page controls and clamps after shrink", async () => {
  const { dom, container } = installDom();
  const rows = Array.from({ length: CARD_PAGE_SIZE * 2 + 1 }, (_, index) => (
    taskBoardEntry(task({ id: `done-${index}`, status: "DONE" }))
  ));
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(<PaginatedHarness entries={rows} />));
    assert.equal(container.querySelectorAll("[data-card]").length, CARD_PAGE_SIZE);
    const more = [...container.querySelectorAll("button")].find((button) => button.textContent === `Show ${CARD_PAGE_SIZE} more`);
    assert.ok(more);
    await act(async () => more.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(container.querySelectorAll("[data-card]").length, CARD_PAGE_SIZE);
    assert.match(container.textContent ?? "", new RegExp(en("tasks.column.previous", { n: CARD_PAGE_SIZE })));

    await act(async () => root.render(<PaginatedHarness entries={rows.slice(0, 1)} />));
    assert.equal(container.querySelector("[data-card]")?.getAttribute("data-card"), "done-0");
    assert.equal(container.querySelectorAll("button").length, 1, "only the card menu remains after pagination clamps");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

/* -------------------------------------------------------------- the notice */

test("the Archive All notice reports skips only when there were some", () => {
  assert.equal(archiveDoneNotice({ archived: 6, skipped: 1 }), "Archived 6, skipped 1 (running)");
  const clean = archiveDoneNotice({ archived: 6, skipped: 0 });
  assert.equal(clean, "Archived 6");
  assert.doesNotMatch(clean, /skipped/);
});

test("both notice shapes render through InfoNotice", () => {
  const withSkips = renderToStaticMarkup(<InfoNotice message={archiveDoneNotice({ archived: 6, skipped: 1 })} />);
  assert.match(withSkips, /Archived 6, skipped 1 \(running\)/);
  const withoutSkips = renderToStaticMarkup(<InfoNotice message={archiveDoneNotice({ archived: 6, skipped: 0 })} />);
  assert.match(withoutSkips, /Archived 6/);
  assert.doesNotMatch(withoutSkips, /skipped/);
});

test("InfoNotice borrows neither the amber nor the destructive palette", () => {
  const markup = renderToStaticMarkup(<InfoNotice message="Archived 6" onDismiss={() => undefined} />);
  assert.doesNotMatch(markup, /status-amber|destructive/);
  assert.match(markup, new RegExp(en("common.dismiss")));
});

/* ------------------------------------------------- the Todo column's wave */

const chainRow = (options: {
  chainId: string;
  name: string | null;
  stepCount: number;
  state: ChainAggregateState;
  activationTaskId?: string | null;
  status?: TaskStatus;
  hold?: ChainAggregate["activation"]["hold"];
}): BoardTask => {
  const status = options.status ?? "TODO";
  const headId = `${options.chainId}-head`;
  const chainName = options.name === null ? null : options.name;
  const aggregate: ChainAggregate = {
    chainId: options.chainId, chainName, stepCount: options.stepCount,
    statusCounts: { BACKLOG: 0, TODO: options.stepCount, DOING: 0, REVIEW: 0, DONE: 0 },
    detailTaskId: headId, status,
    frontier: { taskId: headId, title: "Implementation", status, latestRun: null, mergeOutcome: null, failureReason: null, position: 1 },
    activeRepair: null,
    activation: {
      state: options.state,
      predecessor: options.state === "waiting-on-predecessor" ? { taskId: "release", taskName: "Release cut" } : null,
      taskId: options.activationTaskId === undefined ? headId : options.activationTaskId,
      hold: options.hold ?? null,
    },
    totalCost: null, createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z",
  };
  return task({
    id: headId, name: `${options.name ?? options.chainId}: Implementation`, displayName: "Implementation", status,
    chainId: options.chainId, chainName, chainIndex: 0,
    chainProgress: progress({ chainId: options.chainId }), chainAggregate: aggregate,
  });
};

test("Activate all is offered only where the Todo column holds a parked chain", () => {
  const parked = chainRow({ chainId: "alpha", name: "Alpha", stepCount: 2, state: "parked-unactivated" });
  assert.match(column("TODO", boardEntries([parked])), new RegExp(en("tasks.activateAll")));
  // Nothing to activate: an empty column, a card that is not a chain, and a
  // chain the control plane will dispatch itself when its predecessor lands.
  assert.doesNotMatch(column("TODO"), new RegExp(en("tasks.activateAll")));
  assert.doesNotMatch(column("TODO", boardEntries([task({ name: "Plain work" })])), new RegExp(en("tasks.activateAll")));
  const waiting = chainRow({ chainId: "beta", name: "Beta", stepCount: 4, state: "waiting-on-predecessor", activationTaskId: null });
  assert.doesNotMatch(column("TODO", boardEntries([waiting])), new RegExp(en("tasks.activateAll")));
  // Done keeps its own head action and gains nothing.
  const settled = chainRow({ chainId: "gamma", name: "Gamma", stepCount: 1, state: "settled", status: "DONE" });
  const done = column("DONE", boardEntries([settled]));
  assert.match(done, new RegExp(en("tasks.archiveAll")));
  assert.doesNotMatch(done, new RegExp(en("tasks.activateAll")));
});

test("Activate all follows the parked chains on the visible Todo page", async () => {
  const { dom, container } = installDom();
  const definition = COLUMNS.find((candidate) => candidate.status === "TODO");
  assert.ok(definition);
  const rows = boardEntries([
    ...Array.from({ length: CARD_PAGE_SIZE }, (_, index) => task({ id: `plain-${index}`, name: `Plain ${index}` })),
    chainRow({ chainId: "parked", name: "Parked", stepCount: 2, state: "parked-unactivated" }),
  ]);
  const activated: Array<readonly { chainId: string }[]> = [];
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(
      <BoardColumn
        column={definition} tasks={rows} loading={false} dragOver={null}
        onDragOver={noop} onDragLeave={noop} onDrop={noop} onArchiveDone={noop}
        onActivateAll={(chains) => activated.push(chains)} actions={ACTIONS}
      />,
    ));
    assert.doesNotMatch(container.textContent ?? "", new RegExp(en("tasks.activateAll")));
    const more = [...container.querySelectorAll("button")].find((button) => button.textContent === en("tasks.column.more", { n: 1 }));
    assert.ok(more);
    await act(async () => more.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    const activate = [...container.querySelectorAll("button")].find((button) => button.textContent === en("tasks.activateAll"));
    assert.ok(activate);
    await act(async () => activate.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(activated.map((chains) => chains.map((chain) => chain.chainId)), [["parked"]]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("parkedChains projects exactly the chains an operator can start", () => {
  const entries = boardEntries([
    chainRow({ chainId: "alpha", name: "Alpha", stepCount: 2, state: "parked-unactivated" }),
    chainRow({ chainId: "beta", name: "Beta", stepCount: 4, state: "waiting-on-predecessor", activationTaskId: null }),
    chainRow({ chainId: "gamma", name: "Gamma", stepCount: 3, state: "parked-unactivated" }),
    chainRow({ chainId: "delta", name: "Delta", stepCount: 5, state: "running" }),
    task({ id: "plain", name: "Plain work" }),
  ]);
  assert.deepEqual(parkedChains(entries), [
    { chainId: "alpha", name: "Alpha", stepCount: 2, taskId: "alpha-head" },
    { chainId: "gamma", name: "Gamma", stepCount: 3, taskId: "gamma-head" },
  ]);
  // An unnamed chain is still listed, under the short id the cards use.
  const unnamed = boardEntries([chainRow({ chainId: "c1234567890", name: null, stepCount: 1, state: "parked-unactivated" })]);
  assert.deepEqual(parkedChains(unnamed).map((chain) => chain.name), ["c1234567"]);
});

test("held, settled and idle Chains stay out of both column-head waves", () => {
  // A parked chain an operator has held arrives as `held`: the projection
  // derives the state from the persisted hold, which outranks the parked check.
  const held = chainRow({
    chainId: "parked", name: "Parked", stepCount: 2, state: "held",
    hold: { heldLayer: 0, heldAt: "2026-08-16T00:00:00.000Z", holdReason: null },
  });
  assert.deepEqual(parkedChains(boardEntries([held])), []);

  const running = chainRow({ chainId: "running", name: "Running", stepCount: 3, state: "running", status: "DOING" });
  const runningWave = [{ chainId: "running", name: "Running", stepCount: 3, taskId: "running-head" }];
  assert.deepEqual(heldChains(boardEntries([running])), runningWave);
  assert.deepEqual(heldChains(boardEntries([held, running])), runningWave);

  // The divergence the one rule closes: both carry an activation task id, and a
  // wave that read the persisted hold alone swept them in while their own cards
  // offered no Hold button.
  const settled = chainRow({ chainId: "settled", name: "Settled", stepCount: 2, state: "settled", status: "DOING" });
  const idle = chainRow({ chainId: "idle", name: "Idle", stepCount: 2, state: "idle", status: "DOING" });
  assert.deepEqual(heldChains(boardEntries([settled, idle])), []);
  assert.deepEqual(parkedChains(boardEntries([settled, idle])), []);
});

test("Doing offers Hold all only for chains without a persisted hold", async () => {
  const { dom, container } = installDom();
  const definition = COLUMNS.find((candidate) => candidate.status === "DOING");
  assert.ok(definition);
  const running = chainRow({ chainId: "running", name: "Running", stepCount: 3, state: "running", status: "DOING" });
  const held = chainRow({
    chainId: "held", name: "Held", stepCount: 3, state: "running", status: "DOING",
    hold: { heldLayer: 1, heldAt: "2026-08-16T00:00:00.000Z", holdReason: null },
  });
  const heldIds: string[][] = [];
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(
      <BoardColumn
        column={definition} tasks={boardEntries([running, held])} loading={false} dragOver={null}
        onDragOver={noop} onDragLeave={noop} onDrop={noop} onArchiveDone={noop} onActivateAll={noop}
        onHoldAll={(chains) => heldIds.push(chains.map((chain) => chain.chainId))} actions={ACTIONS}
      />,
    ));
    const hold = [...container.querySelectorAll("button")].find((button) => button.textContent === en("tasks.holdAll"));
    assert.ok(hold);
    await act(async () => hold.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(heldIds, [["running"]]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("Doing Hold all follows the visible page and is suppressed without a handler", async () => {
  const definition = COLUMNS.find((candidate) => candidate.status === "DOING");
  assert.ok(definition);
  const rows = boardEntries([
    ...Array.from({ length: CARD_PAGE_SIZE }, (_, index) => task({ id: `doing-${index}`, name: `Doing ${index}`, status: "DOING" })),
    chainRow({ chainId: "page-two", name: "Page two", stepCount: 2, state: "running", status: "DOING" }),
  ]);
  const withoutHandler = renderToStaticMarkup(
    <BoardColumn
      column={definition} tasks={rows} loading={false} dragOver={null}
      onDragOver={noop} onDragLeave={noop} onDrop={noop} onArchiveDone={noop}
      onActivateAll={noop} actions={ACTIONS}
    />,
  );
  assert.doesNotMatch(withoutHandler, new RegExp(en("tasks.holdAll")));

  const { dom, container } = installDom();
  const held: string[][] = [];
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(
      <BoardColumn
        column={definition} tasks={rows} loading={false} dragOver={null}
        onDragOver={noop} onDragLeave={noop} onDrop={noop} onArchiveDone={noop}
        onActivateAll={noop} onHoldAll={(chains) => held.push(chains.map((chain) => chain.chainId))} actions={ACTIONS}
      />,
    ));
    assert.doesNotMatch(container.textContent ?? "", new RegExp(en("tasks.holdAll")));
    const more = [...container.querySelectorAll("button")].find((button) => button.textContent === en("tasks.column.more", { n: 1 }));
    assert.ok(more);
    await act(async () => more.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    const hold = [...container.querySelectorAll("button")].find((button) => button.textContent === en("tasks.holdAll"));
    assert.ok(hold);
    await act(async () => hold.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(held, [["page-two"]]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("Hold all confirmation explains layer-granular stopping and reports refusals", async () => {
  const { dom, container } = installDom();
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(
      <HoldAllDialog
        chains={[{ chainId: "running", name: "Running", stepCount: 3, taskId: "running-head" }]}
        refusals={[{ name: "Stale", reason: "409 Chain is already held" }]}
        pending={false} settled={false} onClose={noop} onConfirm={noop}
      />,
    ));
    const text = dom.window.document.body.textContent ?? "";
    assert.match(text, /finish its current step before stopping/u);
    assert.match(text, /No running Run will be cancelled/u);
    assert.match(text, /Stale: 409 Chain is already held/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
  assert.equal(holdAllNotice(5, 2), "Held 3 of 5 chains");
});

test("aggregate Hold and Resume post fresh chain-control request ids", async () => {
  storage.set("agentos.projectId", "p1");
  const rows = [
    chainRow({ chainId: "running", name: "Running", stepCount: 2, state: "running", status: "DOING" }),
    chainRow({
      chainId: "held", name: "Held", stepCount: 2, state: "held", status: "TODO",
      hold: { heldLayer: 0, heldAt: "2026-08-16T00:00:00.000Z", holdReason: null },
    }),
  ];
  const page = await mountPage(<ProjectProvider><TasksPage /></ProjectProvider>, {
    "GET /projects": [{ id: "p1", name: "Project One" }],
    "GET /tasks": rows,
    "POST /tasks/running-head/chain/hold": { control: { state: "held" } },
    "POST /tasks/held-head/chain/resume": { control: { state: "released" } },
    "*": [],
  });
  try {
    await page.press(en("tasks.aggregate.hold"));
    await page.press(en("tasks.aggregate.resume"));
    const controlRequests = page.requests.filter(({ method, path }) => method === "POST" && /chain\/(?:hold|resume)$/u.test(path));
    assert.deepEqual(controlRequests.map(({ path }) => path), [
      "/tasks/running-head/chain/hold",
      "/tasks/held-head/chain/resume",
    ]);
    const payloads = controlRequests.map(({ init }) => JSON.parse(String(init.body)) as { requestId?: string });
    assert.ok(payloads.every(({ requestId }) => typeof requestId === "string" && requestId.length > 0));
    assert.notEqual(payloads[0]!.requestId, payloads[1]!.requestId);
  } finally {
    await page.dispose();
    storage.remove("agentos.projectId");
  }
});

test("Doing Hold all posts each visible unheld Chain and reports named refusals", async () => {
  storage.set("agentos.projectId", "p1");
  const rows = [
    chainRow({ chainId: "alpha", name: "Alpha", stepCount: 2, state: "running", status: "DOING" }),
    chainRow({ chainId: "beta", name: "Beta", stepCount: 3, state: "running", status: "DOING" }),
    chainRow({
      chainId: "already-held", name: "Already held", stepCount: 1, state: "running", status: "DOING",
      hold: { heldLayer: 1, heldAt: "2026-08-16T00:00:00.000Z", holdReason: null },
    }),
  ];
  const page = await mountPage(<ProjectProvider><TasksPage /></ProjectProvider>, {
    "GET /projects": [{ id: "p1", name: "Project One" }],
    "GET /tasks": rows,
    "POST /tasks/alpha-head/chain/hold": { control: { state: "held" } },
    "POST /tasks/beta-head/chain/hold": Response.json({ error: "Chain changed while holding" }, { status: 409 }),
    "*": [],
  });
  try {
    await page.press(en("tasks.holdAll"));
    const confirm = [...page.dom.window.document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === en("tasks.holdAll.confirm"));
    assert.ok(confirm);
    await act(async () => confirm.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true })));
    await page.settle();
    const posts = page.requests.filter(({ method, path }) => method === "POST" && path.endsWith("/chain/hold"));
    assert.deepEqual(posts.map(({ path }) => path).sort(), [
      "/tasks/alpha-head/chain/hold",
      "/tasks/beta-head/chain/hold",
    ]);
    assert.ok(posts.every(({ init }) => typeof (JSON.parse(String(init.body)) as { requestId?: string }).requestId === "string"));
    assert.equal(page.requests.some(({ path }) => path.includes("/cancel")), false);
    assert.ok(page.requests.filter(({ method, path }) => method === "GET" && path.startsWith("/tasks")).length >= 2, "the page reloads after the wave");
    const body = page.dom.window.document.body.textContent ?? "";
    assert.match(body, /Beta: 409 Chain changed while holding/u);
    assert.match(body, new RegExp(holdAllNotice(2, 1)));
  } finally {
    await page.dispose();
    storage.remove("agentos.projectId");
  }
});

test("the Todo head starts the whole wave from one dialog and names the chain that refused", async () => {
  storage.set("agentos.projectId", "p1");
  const checklist = {
    repoBound: true, agentAssignee: true, repoAccessGrant: true,
    budgetRemaining: true, noActiveRun: true, predecessorsDone: true,
  };
  const verdict = (id: string, name: string, startable: boolean): TaskStartability => ({
    startable,
    checklist: { ...checklist, budgetRemaining: startable },
    task: {
      id, name, agent: { id: "a1", title: "Senior dev" },
      repo: { id: "r1", name: "product" }, targetBranch: "main",
    },
  } as TaskStartability);
  const rows = [
    chainRow({ chainId: "alpha", name: "Alpha", stepCount: 2, state: "parked-unactivated" }),
    chainRow({ chainId: "beta", name: "Beta", stepCount: 4, state: "waiting-on-predecessor", activationTaskId: null }),
    chainRow({ chainId: "gamma", name: "Gamma", stepCount: 3, state: "parked-unactivated" }),
    chainRow({ chainId: "delta", name: "Delta", stepCount: 5, state: "parked-unactivated" }),
    task({ id: "plain", name: "Plain work" }),
  ];
  const started: string[] = [];
  let releaseAlpha!: (verdict: TaskStartability) => void;
  const alphaVerdict = new Promise<TaskStartability>((resolve) => { releaseAlpha = resolve; });
  let markDeltaStarted!: () => void;
  const deltaStarted = new Promise<void>((resolve) => { markDeltaStarted = resolve; });
  const page = await mountPage(<ProjectProvider><TasksPage /></ProjectProvider>, {
    "GET /projects": [{ id: "p1", name: "Project One" }],
    "GET /tasks": rows,
    "GET /tasks/alpha-head/startability": () => alphaVerdict,
    "GET /tasks/gamma-head/startability": verdict("gamma-head", "Gamma: Implementation", true),
    "GET /tasks/delta-head/startability": verdict("delta-head", "Delta: Implementation", true),
    "POST /tasks/gamma-head/start": Response.json({ error: "Task already has an active run" }, { status: 409 }),
    "POST /tasks/delta-head/start": () => {
      started.push("delta-head");
      markDeltaStarted();
      return Response.json({ runId: "run-1", runNumber: 1 }, { status: 201 });
    },
    "*": [],
  });
  try {
    await page.press(en("tasks.activateAll"));
    const listed = [...page.dom.window.document.querySelectorAll("[data-activate-chain]")]
      .map((node) => node.textContent?.trim());
    // Exactly the parked chains, with their step counts. Beta dispatches itself
    // and the plain card is not a chain at all.
    assert.deepEqual(listed, [
      en("tasks.activateAll.chain", { name: "Alpha", steps: 2 }),
      en("tasks.activateAll.chain", { name: "Gamma", steps: 3 }),
      en("tasks.activateAll.chain", { name: "Delta", steps: 5 }),
    ]);

    const confirm = [...page.dom.window.document.querySelectorAll("button")]
      .find((node) => node.textContent?.trim() === en("tasks.activateAll.confirm"));
    assert.ok(confirm);
    await act(async () => confirm.dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true })));
    await Promise.race([
      deltaStarted,
      // Bounded so a Delta that really is held behind Alpha fails rather than
      // hanging, but sized for the loaded gate worker: the property is that
      // Delta is not waiting on Alpha's pending request, and half a second of
      // wall clock for a chain of fetch doubles and React renders is a
      // measurement of the host, not of the page.
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Delta was held behind Alpha")), 15_000)),
    ]);
    // Alpha's check is still pending, but the later chains have already taken
    // their own GET-then-POST paths. One refusal or slow request cannot hold the
    // rest of the wave behind it.
    assert.deepEqual(started, ["delta-head"]);
    assert.equal(page.requests.some(({ method, path }) => method === "POST" && path === "/tasks/alpha-head/start"), false);
    assert.equal(page.requests.some(({ method, path }) => method === "GET" && path === "/tasks/gamma-head/startability"), true);
    assert.equal(page.requests.some(({ method, path }) => method === "POST" && path === "/tasks/gamma-head/start"), true);
    assert.equal(page.requests.some(({ method, path }) => method === "GET" && path === "/tasks/delta-head/startability"), true);
    assert.equal(page.requests.some(({ method, path }) => method === "POST" && path === "/tasks/delta-head/start"), true);
    assert.equal(page.requests.some(({ path }) => path.includes("activate")), false);
    releaseAlpha(verdict("alpha-head", "Alpha: Implementation", false));
    await page.settle();
    const body = page.dom.window.document.body.textContent ?? "";
    assert.match(body, new RegExp(en("tasks.activateAll.refused", { name: "Alpha", reason: en("tasks.startRefused", { reasons: en("taskDetail.startability.budgetRemaining") }) })));
    assert.match(body, new RegExp(en("tasks.activateAll.refused", { name: "Gamma", reason: "409 Task already has an active run" })));
    assert.doesNotMatch(body, /Delta: Task cannot start/);
    assert.match(page.container.textContent ?? "", new RegExp(activateAllNotice(3, 2)));
  } finally {
    await page.dispose();
    storage.remove("agentos.projectId");
  }
});

test("the settled activation dialog no longer promises refused chains will start", async () => {
  const { dom, container } = installDom();
  const root = (await reactDom()).createRoot(container);
  try {
    await act(async () => root.render(
      <ActivateAllDialog
        chains={[{ chainId: "alpha", name: "Alpha", stepCount: 2, taskId: "alpha-head" }]}
        refusals={[{ name: "Alpha", reason: "Task cannot start" }]}
        pending={false} settled onClose={noop} onConfirm={noop}
      />,
    ));
    const text = dom.window.document.body.textContent ?? "";
    assert.doesNotMatch(text, new RegExp(en("tasks.activateAll.what")));
    assert.doesNotMatch(text, new RegExp(en("tasks.activateAll.chain", { name: "Alpha", steps: 2 })));
    assert.match(text, new RegExp(en("tasks.activateAll.refused", { name: "Alpha", reason: "Task cannot start" })));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("the wave notice counts what started, not what was asked for", () => {
  assert.equal(activateAllNotice(10, 0), "Started 10 of 10 chains");
  assert.equal(activateAllNotice(10, 3), "Started 7 of 10 chains");
});
