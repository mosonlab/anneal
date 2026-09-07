import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChainAggregateCard } from "../components/chain-aggregate-card";
import { BoardColumn } from "../components/desktop-board";
import { MobileTaskList } from "../components/mobile-task-list";
import { COLUMNS, type BoardEntry, boardEntries, boardEntriesByStatus, countByStatus } from "../lib/board";
import { LocaleProvider } from "../lib/i18n";
import { translate } from "../lib/i18n-core";
import type { BoardTask, ChainAggregate, TaskStatus } from "../lib/types";
import { useTaskStartConfirmation } from "../pages/Tasks";
import { installDom, mountPage, reactDom } from "./dom-harness";

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: "task-1", name: "Release: Build", displayName: "Build", status: "TODO", moveTargets: [], failureReason: null,
  assigneeType: "AGENT", createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T01:00:00.000Z",
  scheduleKind: "NOW", runAt: null, cron: null, timezone: null, approvalGate: false, templateId: null,
  source: "MANUAL", chainId: null, chainIndex: null, chainName: null, assigneeAgent: null,
  chainProgress: null, latestRun: null, strandedSalvageBranches: [], taskCost: null, budgetRemaining: true, leaseLossRefunds: 0, blockedOn: null, mergeOutcome: null,
  repairOf: null, chainAggregate: null, baseline: null, ...overrides,
});

const aggregate = (overrides: Partial<ChainAggregate> = {}): ChainAggregate => ({
  chainId: "chain-1", chainName: "Release", stepCount: 12,
  detailTaskId: "step-3",
  statusCounts: { BACKLOG: 0, TODO: 10, DOING: 0, REVIEW: 0, DONE: 2 }, status: "TODO",
  frontier: { taskId: "step-3", title: "Implement release", status: "TODO", latestRun: null, mergeOutcome: null, failureReason: null, position: 3 },
  activeRepair: null,
  activation: { state: "running", predecessor: null, taskId: "step-1", hold: null }, totalCost: null,
  createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T01:00:00.000Z", ...overrides,
});

type RunWithTier = NonNullable<BoardTask["latestRun"]> & { codexServiceTier: "DEFAULT" | "FAST" };
type AggregateWithRepair = ChainAggregate & {
  activeRepair: { repairKind: string; latestRun: RunWithTier };
};

const runWithTier = (overrides: Partial<RunWithTier> = {}): RunWithTier => ({
  id: "run-1", runNumber: 1, status: "SUCCEEDED", model: "gpt-5.6-sol:high", codexServiceTier: "DEFAULT",
  costUsd: null, startedAt: null, endedAt: null, pullRequestUrl: null, ...overrides,
});

const activeRepairAggregate = (overrides: Partial<ChainAggregate> = {}): AggregateWithRepair => ({
  ...aggregate(overrides),
  activeRepair: {
    repairKind: "gate-fix",
    latestRun: runWithTier({ id: "repair-run", runNumber: 3, status: "RUNNING", codexServiceTier: "FAST", startedAt: new Date(Date.now() - 4 * 60_000).toISOString() }),
  },
});

const visibleText = (markup: string): string => markup.replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ");

const chainStep = (id: string, position: number, status: TaskStatus, projection: ChainAggregate, overrides: Partial<BoardTask> = {}): BoardTask => task({
  id, name: `Release: ${id}`, displayName: id, chainId: projection.chainId, chainIndex: position - 1, chainName: projection.chainName,
  status, chainAggregate: projection, chainProgress: {
    chainId: projection.chainId, done: projection.statusCounts.DONE, total: projection.stepCount,
    activeStepName: projection.frontier.title, activeStatus: projection.frontier.status,
    currentLayer: position, layerCount: projection.stepCount, position,
  }, ...overrides,
});

const noop = (): void => undefined;
const actions = { onMove: noop, onRetry: noop, onArchive: noop, onDelete: noop, onCopyError: noop, onFilterChain: noop };
const column = (status: TaskStatus, entries: readonly BoardEntry[] = []): string => {
  const definition = COLUMNS.find((candidate) => candidate.status === status)!;
  return renderToStaticMarkup(<BoardColumn column={definition} tasks={entries} loading={false} dragOver={null} onDragOver={noop} onDragLeave={noop} onDrop={noop} onArchiveDone={noop} onActivateAll={noop} actions={actions} />);
};

test("one aggregate entry owns chain steps and a detached repair, while standalone tasks remain cards", () => {
  const projection = aggregate();
  const rows = [
    chainStep("step-1", 1, "DONE", projection),
    chainStep("step-3", 3, "TODO", projection),
    task({ id: "repair", displayName: "Merge-tail repair", status: "DOING", repairOf: { chainId: "chain-1", chainName: "Release", repairKind: "gate-fix" } }),
    task({ id: "standalone", displayName: "Standalone" }),
  ];
  const entries = boardEntries(rows);
  assert.deepEqual(entries.map((entry) => entry.kind), ["chain", "task"]);
  assert.equal(entries[0]?.kind === "chain" ? entries[0].members.length : 0, 3);
  assert.equal(entries[0]?.kind === "chain" ? entries[0].representativeTaskId : "", "step-3");
  assert.equal(entries[1]?.kind === "task" ? entries[1].task.id : "", "standalone");
});

test("clicking an aggregate card opens the frontier Step, not the first one", async () => {
  // The API sets `detailTaskId` to the frontier; the board carries it through as
  // the representative, so the operator lands on the Step that is actually
  // moving instead of walking the chain list down from Step 1.
  const projection = aggregate();
  const entries = boardEntries([
    chainStep("step-1", 1, "DONE", projection),
    chainStep("step-2", 2, "DONE", projection),
    chainStep("step-3", 3, "TODO", projection),
  ]);
  const entry = entries[0];
  assert.ok(entry?.kind === "chain");
  assert.equal(entry.representativeTaskId, projection.frontier.taskId);

  const { dom, container } = installDom();
  Object.defineProperty(dom.window, "getSelection", { configurable: true, value: () => ({ toString: () => "" }) });
  const root = (await reactDom()).createRoot(container);
  try {
    dom.window.location.hash = "#/tasks/origin";
    await act(async () => root.render(
      <ChainAggregateCard aggregate={entry.aggregate} members={entry.members} representativeTaskId={entry.representativeTaskId} />,
    ));
    const card = container.querySelector("[data-chain-card]");
    assert.ok(card);
    await act(async () => card.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(dom.window.location.hash, "#/tasks/step-3");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("aggregate placement follows API-derived frontier status and counts entries, not raw steps", () => {
  for (const [status, expectedColumn] of [
    ["TODO", "TODO"], ["DOING", "DOING"], ["REVIEW", "REVIEW"], ["DONE", "DONE"],
  ] as const) {
    const projection = aggregate({
      status,
      statusCounts: { BACKLOG: 0, TODO: status === "TODO" ? 12 : 0, DOING: status === "DOING" ? 1 : 0, REVIEW: status === "REVIEW" ? 1 : 0, DONE: status === "DONE" ? 12 : 0 },
      frontier: { taskId: "frontier", title: "Frontier", status, latestRun: null, mergeOutcome: null, failureReason: null, position: 3 },
    });
    const rows = Array.from({ length: 12 }, (_, index) => chainStep(`step-${index}`, index + 1, status === "DONE" ? "DONE" : index === 2 ? status : "TODO", projection));
    const grouped = boardEntriesByStatus(boardEntries(rows));
    assert.equal(grouped.get(expectedColumn)?.length, 1, status);
    assert.equal(countByStatus(boardEntries(rows))[expectedColumn], 1, status);
  }
});

test("aggregate card exposes progress, frontier, activation/lock state, and no drag or Move To", () => {
  const parked = aggregate({ activation: { state: "parked-unactivated", predecessor: null, taskId: "step-1", hold: null } });
  const parkedMarkup = renderToStaticMarkup(<ChainAggregateCard aggregate={parked} />);
  assert.match(parkedMarkup, /Step 3\/12/);
  assert.match(parkedMarkup, /Implement release/);
  assert.match(parkedMarkup, />Activate<\/button>/);
  assert.doesNotMatch(parkedMarkup, /draggable/);
  assert.doesNotMatch(parkedMarkup, /Move to/);

  const waitingMarkup = renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate({ activation: { state: "waiting-on-predecessor", predecessor: { taskId: "previous", taskName: "Prepare release" }, taskId: "step-1", hold: null } })} />);
  assert.match(waitingMarkup, /Prepare release/);
  assert.match(waitingMarkup, /Locked by/);
  assert.match(waitingMarkup, />Hold<\/button>/);
  assert.doesNotMatch(waitingMarkup, />Activate<\/button>/);
});

test("an aggregate board card carries the stranded salvage count from its members", () => {
  const projection = aggregate();
  const member = task({
    id: "step-with-salvage",
    strandedSalvageBranches: [{ branch: "agentos/task-1/run-1", lostRunNumber: 1 }],
  });
  const markup = renderToStaticMarkup(<ChainAggregateCard aggregate={projection} members={[member]} />);
  assert.match(markup, /data-card-stranded-salvage=""/u);
  assert.match(visibleText(markup), /Salvage 1/u);

  const ordinary = renderToStaticMarkup(<ChainAggregateCard aggregate={projection} members={[task()]} />);
  assert.doesNotMatch(ordinary, /data-card-stranded-salvage=""/u);
});

test("the hold pill and Resume follow the persisted hold, running or held", () => {
  const running = renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate()} />);
  assert.match(running, />Hold<\/button>/u);

  const held = renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate({
    activation: {
      state: "held", predecessor: null, taskId: "step-1",
      hold: { heldLayer: 0, heldAt: "2026-08-28T01:00:00.000Z", holdReason: "inspect output" },
    },
  })} />);
  assert.match(held, /data-slot="badge"[^>]*>Held</u);
  assert.match(held, /Reason: inspect output/u);
  assert.match(held, /data-chain-resume=""/u);

  const runningHeld = renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate({
    activation: {
      state: "running", predecessor: null, taskId: "step-1",
      hold: { heldLayer: 2, heldAt: "2026-08-28T01:00:00.000Z", holdReason: null },
    },
  })} />);
  assert.match(runningHeld, /data-slot="badge"[^>]*>Stops after step/u);
  assert.match(runningHeld, /data-chain-resume=""/u);
});

/** The Doing column head, which is the only other surface that decides whether
 *  a chain can be held. `onHoldAll` is what makes the head offer the wave at
 *  all, so a column rendered without it proves nothing. */
const holdColumn = (entries: readonly BoardEntry[]): string => {
  const definition = COLUMNS.find((candidate) => candidate.status === "DOING")!;
  return renderToStaticMarkup(<BoardColumn column={definition} tasks={entries} loading={false} dragOver={null} onDragOver={noop} onDragLeave={noop} onDrop={noop} onArchiveDone={noop} onActivateAll={noop} onHoldAll={noop} actions={actions} />);
};

const offersButton = (markup: string, label: string): boolean =>
  [...new JSDOM(`<!doctype html><html><body>${markup}</body></html>`).window.document.querySelectorAll("button")]
    .some((button) => button.textContent === label);

test("the card and the Doing column head offer Hold for exactly the same chains", () => {
  // Both surfaces used to restate the rule, and they disagreed: the column head
  // read only the persisted hold, so a `settled` or `idle` chain carrying an
  // activation task id joined the wave while its own card offered no button.
  const cases: Array<[ChainAggregate["activation"], boolean]> = [
    [{ state: "running", predecessor: null, taskId: "step-1", hold: null }, true],
    [{ state: "waiting-on-predecessor", predecessor: { taskId: "previous", taskName: "Prepare release" }, taskId: "step-1", hold: null }, true],
    [{ state: "running", predecessor: null, taskId: "step-1", hold: { heldLayer: 2, heldAt: "2026-08-28T01:00:00.000Z", holdReason: null } }, false],
    [{ state: "held", predecessor: null, taskId: "step-1", hold: { heldLayer: 2, heldAt: "2026-08-28T01:00:00.000Z", holdReason: null } }, false],
    [{ state: "settled", predecessor: null, taskId: "step-1", hold: null }, false],
    [{ state: "idle", predecessor: null, taskId: "step-1", hold: null }, false],
    [{ state: "parked-unactivated", predecessor: null, taskId: "step-1", hold: null }, false],
    [{ state: "running", predecessor: null, taskId: null, hold: null }, false],
  ];
  for (const [activation, offered] of cases) {
    const projection = aggregate({ activation, status: "DOING" });
    const card = renderToStaticMarkup(<ChainAggregateCard aggregate={projection} />);
    const head = holdColumn(boardEntries([chainStep("step-3", 3, "DOING", projection)]));
    const onCard = offersButton(card, translate("en", "tasks.aggregate.hold"));
    assert.equal(onCard, offered, `card, ${activation.state}`);
    assert.equal(offersButton(head, translate("en", "tasks.holdAll")), offered, `column head, ${activation.state}`);
  }
});

const element = (markup: string, selector: string): Element => {
  const found = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`)
    .window.document.body.querySelector(selector);
  assert.ok(found, `${selector} renders: ${markup}`);
  return found;
};

test("a long chain title wraps in full rather than ending in an ellipsis", () => {
  const name = "Board cards: full titles, single-state rows, and a PR link";
  const title = element(renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate({ chainName: name })} />), "[data-card-title]");
  assert.equal(title.textContent, name);
  assert.doesNotMatch(title.className, /line-clamp/u);
});

test("a running aggregate drops the state pill and the frontier row's filter button", () => {
  // Running is already on the card twice over — the run line's amber dot and
  // its own status — so the pill was the third telling. Every other state has
  // nothing else to say it.
  const running = renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate({
    frontier: { taskId: "step-3", title: "Implement release", status: "DOING", latestRun: runWithTier({ status: "RUNNING" }), mergeOutcome: null, failureReason: null, position: 3 },
  })} />);
  assert.doesNotMatch(running, /data-slot="badge"/u);
  assert.doesNotMatch(running, /Filter steps/u);

  const parked = renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate({
    activation: { state: "parked-unactivated", predecessor: null, taskId: "step-1", hold: null },
  })} />);
  assert.match(parked, /data-slot="badge"[^>]*>Parked</u);
});

test("the progress and the step it names are one row", () => {
  const row = element(renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate()} />), "[data-chain-progress]");
  assert.equal(row.textContent, "Step 3/12 · Implement release");
  assert.ok(row.querySelector("[data-chain-frontier]"), "the frontier keeps its own hook");
});

test("the footer links the newest run's pull request and states the cost bare", () => {
  const markup = renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate({
    frontier: {
      taskId: "step-3", title: "Implement release", status: "DOING",
      latestRun: runWithTier({ pullRequestUrl: "https://github.com/mosonlab/anneal/pull/351" }),
      mergeOutcome: null, failureReason: null, position: 3,
    },
    totalCost: { costUsd: "13.74", estimated: true, inputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: null, outputTokens: null },
  })} />);
  const link = element(markup, "a[data-card-pull-request]");
  assert.equal(link.getAttribute("href"), "https://github.com/mosonlab/anneal/pull/351");
  assert.equal(link.textContent, "#351");
  const text = visibleText(markup);
  assert.match(text, /\$13\.74 · \d+d ago/u);
  assert.doesNotMatch(text, /Cost:|est\./u);

  // No run, no link: the footer's left slot is simply empty.
  assert.doesNotMatch(renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate()} />), /data-card-pull-request/u);
});

test("aggregate card renders an active repair line and omits it when no repair is active", () => {
  const activeMarkup = renderToStaticMarkup(<ChainAggregateCard aggregate={activeRepairAggregate()} />);
  const activeText = visibleText(activeMarkup);
  assert.match(activeMarkup, /data-chain-repair=""/u);
  assert.match(activeText, /gate-fix · .*run 3 · gpt-5\.6-sol · high · fast · \d+m/u);

  const settledMarkup = renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate()} />);
  assert.doesNotMatch(settledMarkup, /data-chain-repair=/u);
});

test("aggregate run lines split model effort, mark FAST only, and never say a run is running twice", () => {
  const finished = aggregate({
    frontier: {
      taskId: "step-3", title: "Implement release", status: "DONE", latestRun: runWithTier(),
      mergeOutcome: null, failureReason: null, position: 3,
    },
  });
  const finishedText = visibleText(renderToStaticMarkup(<ChainAggregateCard aggregate={finished} />));
  assert.match(finishedText, /run 1 · gpt-5\.6-sol · high · succeeded/u);
  assert.doesNotMatch(finishedText, /fast/u);

  // The dot carries the state, so the word appears in neither locale.
  const active = activeRepairAggregate();
  const englishText = visibleText(renderToStaticMarkup(<ChainAggregateCard aggregate={active} />));
  assert.doesNotMatch(englishText, /running/u);

  const chineseText = visibleText(renderToStaticMarkup(
    <LocaleProvider initialLocale="zh"><ChainAggregateCard aggregate={active} /></LocaleProvider>,
  ));
  assert.doesNotMatch(chineseText, /运行中/u);
  assert.match(chineseText, /第 3 次运行 · gpt-5\.6-sol · high · fast · \d+ 分/u);
});

test("active elapsed preserves non-running statuses and merge-outcome badges", () => {
  const waiting = {
    ...activeRepairAggregate(),
    activeRepair: {
      repairKind: "review-fix",
      latestRun: runWithTier({ status: "WAITING_INBOX", startedAt: new Date(Date.now() - 4 * 60_000).toISOString() }),
    },
  };
  const waitingText = visibleText(renderToStaticMarkup(
    <LocaleProvider initialLocale="en"><ChainAggregateCard aggregate={waiting} /></LocaleProvider>,
  ));
  assert.match(waitingText, /review-fix · .*waiting inbox · \d+m/u);

  const stopped = aggregate({
    status: "DOING",
    frontier: {
      taskId: "step-3", title: "Merge", status: "DOING",
      latestRun: runWithTier({ status: "RUNNING", startedAt: new Date(Date.now() - 4 * 60_000).toISOString() }),
      mergeOutcome: { outcome: "stopped", condition: "head-drift", incident: false },
      failureReason: null, position: 3,
    },
  });
  const stoppedText = visibleText(renderToStaticMarkup(
    <LocaleProvider initialLocale="en"><ChainAggregateCard aggregate={stopped} /></LocaleProvider>,
  ));
  assert.match(stoppedText, /Stopped · \d+m/u);
});

test("the shared card shell does not navigate a Chain card while text is selected", async () => {
  const { dom, container } = installDom();
  let selection = "Release";
  Object.defineProperty(dom.window, "getSelection", {
    configurable: true,
    value: () => ({ toString: () => selection }),
  });
  const root = (await reactDom()).createRoot(container);
  try {
    dom.window.location.hash = "#/tasks/origin";
    await act(async () => root.render(<ChainAggregateCard aggregate={aggregate()} />));
    const progress = container.querySelector("[data-chain-progress]");
    assert.ok(progress);
    await act(async () => progress.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(dom.window.location.hash, "#/tasks/origin");

    selection = "";
    await act(async () => progress.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(dom.window.location.hash, "#/tasks/step-3");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("mobile and desktop receive the same aggregate entry list", () => {
  const projection = aggregate({ status: "DOING", frontier: { taskId: "step-1", title: "Implement release", status: "DOING", latestRun: null, mergeOutcome: null, failureReason: null, position: 1 } });
  const entries = boardEntries([chainStep("step-1", 1, "DOING", projection), chainStep("step-2", 2, "TODO", projection)]);
  assert.equal(entries.length, 1);
  const grouped = boardEntriesByStatus(entries);
  const desktop = column("DOING", grouped.get("DOING"));
  const mobile = renderToStaticMarkup(<MobileTaskList tab="DOING" counts={countByStatus(entries)} tasks={grouped.get("DOING") ?? []} loading={false} onSelectTab={noop} onArchiveDone={noop} actions={actions} listRef={{ current: null }} />);
  assert.equal((desktop.match(/data-chain-card=/gu) ?? []).length, 1);
  assert.equal((mobile.match(/data-chain-card=/gu) ?? []).length, 1);
  assert.match(desktop, /Implement release/);
  assert.match(mobile, /Implement release/);
});

test("aggregate translations keep the state and action copy localized", () => {
  assert.equal(translate("en", "tasks.aggregate.activate"), "Activate");
  assert.notEqual(translate("zh", "tasks.aggregate.activate"), "Activate");
});

const AggregateActivationHarness = (): ReactNode => {
  const start = useTaskStartConfirmation(noop);
  const projection = aggregate({ activation: { state: "parked-unactivated", predecessor: null, taskId: "step-1", hold: null } });
  return <>
    <ChainAggregateCard
      aggregate={projection}
      representativeTaskId="step-1"
      actions={{
        onActivate: (taskId) => { void start.requestForMove(taskId); },
        onHold: noop,
        onResume: noop,
        onFilter: noop,
        onArchive: noop,
      }}
    />
    {start.request === null ? null : (
      <section data-aggregate-confirmation="">
        {start.error === null ? null : <div role="alert">{start.error}</div>}
        <button type="button" onClick={() => void start.confirm()}>Confirm activation</button>
      </section>
    )}
  </>;
};

test("aggregate Activate starts step zero and keeps a stale-view 4xx visible", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  const page = await mountPage(<AggregateActivationHarness />, { "*": ({ input, method }) => {
    const path = String(input);
    requests.push({ method, path });
    if (path === "/api/tasks/step-1/startability") return {
      startable: true,
      checklist: {
        repoBound: true, agentAssignee: true, repoAccessGrant: true,
        budgetRemaining: true, noActiveRun: true, predecessorsDone: true,
      },
      task: {
        id: "step-1", name: "Release: Build", agent: { id: "a1", title: "Senior dev" },
        repo: { id: "r1", name: "product" }, targetBranch: "main",
      },
    };
    if (path === "/api/tasks/step-1/start" && method === "POST") {
      return Response.json({ error: "This chain was already activated." }, { status: 409 });
    }
    return Response.json([], { status: 404 });
  } });
  try {
    await page.press("Activate");
    assert.ok(page.container.querySelector("[data-aggregate-confirmation]"));
    await page.press("Confirm activation");
    assert.equal(requests.filter(({ method, path }) => method === "POST" && path === "/api/tasks/step-1/start").length, 1);
    assert.match(page.container.textContent ?? "", /already activated/u);
  } finally {
    await page.dispose();
  }
});
