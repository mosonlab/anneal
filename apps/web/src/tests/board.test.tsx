import assert from "node:assert/strict";
import test from "node:test";

import {
  chainBinding, chainBindingLabel, chainParked, clampScroll, columnStep, countByStatus, defaultTab, edgeState,
  focusAfterMove, orderColumn, parseStatus, retryShape, retryable, runLiveness, sameEdges, scheduleLabel, storedScroll,
} from "../lib/board";
import type { BoardTask, ChainProgress, RunStatus } from "../lib/types";

const task = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: "t1", name: "Ship the thing", displayName: overrides.name ?? "Ship the thing", status: "TODO", moveTargets: [], failureReason: null,
  assigneeType: "HUMAN", createdAt: "2026-08-15T00:00:00.000Z",
  scheduleKind: "NOW", runAt: null, cron: null, timezone: null,
  approvalGate: false, templateId: null, source: "MANUAL", chainId: null, chainIndex: null,
  chainName: null, updatedAt: "2026-08-16T00:00:00.000Z", assigneeAgent: null, chainProgress: null, latestRun: null, strandedSalvageBranches: [], taskCost: null, budgetRemaining: true, leaseLossRefunds: 0,
  blockedOn: null, mergeOutcome: null, repairOf: null, chainAggregate: null, readinessRequeues: 0, readinessGrants: 0,
  ...overrides,
});

/** A chain step as the live board's actually are: parked at the sentinel date so
 *  the scheduler's `runAt <= now` sweep never picks it up, started instead by its
 *  predecessor finishing. */
const step = (position: number, overrides: Partial<BoardTask> = {}): BoardTask => task({
  scheduleKind: "AT",
  runAt: "2099-01-01T00:00:00.000Z",
  chainId: "c1",
  chainIndex: position,
  chainProgress: {
    chainId: "c1", done: 1, total: 9, activeStepName: "Implementation", activeStatus: "doing", currentLayer: 2, layerCount: 7, position,
  } satisfies ChainProgress,
  ...overrides,
});

/* ------------------------------------------------------------- the binding */

test("a merge-tail repair task binds to a chain it has no columns for", () => {
  assert.deepEqual(chainBinding(step(4, { chainName: "Release" })), { id: "c1", name: "Release" });
  assert.equal(chainBinding(task()), null);
  // Chain-detached by design: the binding is the API's resolution of the
  // repair marker, and it is the only thing that puts the card with its chain.
  const repair = task({ repairOf: { chainId: "c1", chainName: "Release", repairKind: "gate-fix" } });
  assert.deepEqual(chainBinding(repair), { id: "c1", name: "Release" });
  assert.equal(chainBindingLabel(chainBinding(repair)!), "Release");
  // A chain with no step of its own on the page has no derived name, so the
  // card names it by a short id rather than by nothing at all.
  assert.equal(
    chainBindingLabel(chainBinding(task({ repairOf: { chainId: "cmt38t30u000fmpru2uc4emc9", chainName: null, repairKind: "review-fix" } }))!),
    "cmt38t30",
  );
});

/* --------------------------------------------------------- schedule labels */

test("a NOW task has no schedule line at all", () => {
  // The default, and true of nearly every card: "Once" on all of them was a row
  // of filler under a title that had to clamp to make room for it.
  assert.equal(scheduleLabel(task()), null);
});

test("an AT task with a real schedule shows the time, not the enum", () => {
  // 42 of the live board's 112 cards rendered a lone "at": the enum lower-cased,
  // with `runAt` never read at all.
  const label = scheduleLabel(task({ scheduleKind: "AT", runAt: "2026-08-20T14:30:00.000Z" }));
  assert.ok(label);
  assert.match(label, /^At \w{3} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/, label);
  assert.notEqual(label, "at");
});

test("a parked chain step says what it is waiting for, and never leaks the sentinel", () => {
  const waiting = scheduleLabel(step(4));
  assert.equal(waiting, "Waiting for previous step");
  assert.doesNotMatch(waiting, /2099/);
  // Once it is running, it is no longer waiting for anything.
  assert.equal(scheduleLabel(step(4, { status: "DOING" })), "Started by chain");
  assert.equal(scheduleLabel(step(4, { status: "DONE" })), "Started by chain");
  assert.equal(scheduleLabel(step(4, { status: "BACKLOG" })), "Waiting for previous step");
});

test("the parking rule reads the chain columns, not the date", () => {
  // A magic constant would be a second, undocumented contract with whoever
  // writes the chain, and would start lying the day a step is parked at 2098.
  assert.equal(chainParked(step(4, { runAt: "2098-06-01T00:00:00.000Z" })), true);
  // The chain's *first* step is genuinely fireable by the scheduler, so its
  // runAt is a real answer.
  assert.equal(chainParked(step(1)), false);
  assert.match(scheduleLabel(step(1)) ?? "", /^At /);
  // Not a chain member at all.
  assert.equal(chainParked(task({ scheduleKind: "AT", runAt: "2099-01-01T00:00:00.000Z" })), false);
  // A chainId with no index is the broken one-row-chain case, not a parked step.
  assert.equal(chainParked(task({ scheduleKind: "AT", runAt: "x", chainId: "c1", chainIndex: null })), false);
  // NOW and CRON are never parked, whatever their chain columns say.
  assert.equal(chainParked(step(4, { scheduleKind: "NOW" })), false);
});

test("a chain step whose progress never arrived is still not shown a raw date", () => {
  // `chainProgress` is null on `?enrich=false` and on an older control plane.
  // Unknown position must fail towards the business phrasing, not towards 2099.
  assert.equal(scheduleLabel(step(4, { chainProgress: null })), "Waiting for previous step");
});

test("a CRON task reads as prose, and an unparseable expression reads as itself", () => {
  assert.equal(scheduleLabel(task({ scheduleKind: "CRON", cron: "0 9 * * 1" })), "At 09:00 AM, only on Monday");
  assert.equal(scheduleLabel(task({ scheduleKind: "CRON", cron: "not a cron" })), "not a cron");
});

test("an AT task with no runAt says so rather than rendering an empty row", () => {
  assert.equal(scheduleLabel(task({ scheduleKind: "AT", runAt: null })), "Not scheduled");
});

/* --------------------------------------------------------------- the tabs */

test("the phone opens on Todo", () => {
  assert.equal(defaultTab(countByStatus([task(), task({ id: "t2", status: "DONE" })])), "TODO");
});

test("an empty Todo falls to the first non-empty unfinished status, never to Done", () => {
  // The live board is Todo 12, Doing 3, Done 97. Volume is not interest: a board
  // that opens on finished work has answered a question nobody asked.
  const rows = [task({ id: "a", status: "DOING" }), ...Array.from({ length: 97 }, (_, index) =>
    task({ id: `d${index}`, status: "DONE" }))];
  assert.equal(defaultTab(countByStatus(rows)), "DOING");
  assert.equal(defaultTab(countByStatus([task({ status: "BACKLOG" }), task({ id: "b", status: "REVIEW" })])), "BACKLOG");
  assert.equal(defaultTab(countByStatus([task({ status: "DONE" })])), "TODO", "an all-Done board still opens on Todo");
  assert.equal(defaultTab(countByStatus([])), "TODO");
});

test("only a real status is accepted off the URL", () => {
  assert.equal(parseStatus("done"), "DONE");
  assert.equal(parseStatus("DOING"), "DOING");
  assert.equal(parseStatus("archived"), null);
  assert.equal(parseStatus(null), null);
  assert.equal(parseStatus(""), null);
});

test("counts cover every status, including the empty ones", () => {
  const counts = countByStatus([task(), task({ id: "b", status: "DONE" })]);
  assert.deepEqual(counts, { BACKLOG: 0, TODO: 1, DOING: 0, REVIEW: 0, DONE: 1 });
});

/* ------------------------------------------------------------ the ordering */

test("every column reads newest first, Backlog included", () => {
  // Backlog used to be the one column read oldest-first. It is the same board:
  // the operator reads what arrived last at the top of every column.
  const newest = task({ id: "new", createdAt: "2026-08-18T00:00:00.000Z" });
  const middle = task({ id: "mid", createdAt: "2026-08-17T00:00:00.000Z" });
  const oldest = task({ id: "old", createdAt: "2026-08-16T00:00:00.000Z" });
  const shuffled = [middle, oldest, newest];
  assert.deepEqual(orderColumn(shuffled).map((row) => row.id), ["new", "mid", "old"]);
  // Never in place: the page holds the polled rows and reorders a copy.
  assert.deepEqual(shuffled.map((row) => row.id), ["mid", "old", "new"]);
});

test("a column preserves the API's id-ascending tiebreak within one creation time", () => {
  // The sort is stable, so cards created in the same instant stay in the order
  // the API delivered them, which is id ascending.
  const createdAt = "2026-08-16T00:00:00.000Z";
  const asDelivered = [task({ id: "a", createdAt }), task({ id: "b", createdAt })];
  assert.deepEqual(orderColumn(asDelivered).map((row) => row.id), ["a", "b"]);
});

/* ------------------------------------------------------------ the actions */

test("a retry waits for the last run to be terminal", () => {
  const failed = { status: "FAILED" as const };
  assert.equal(retryable(task({ failureReason: "boom" }), failed), true);
  assert.equal(retryable(task(), null), false, "a task with no runs cannot be retried");
  assert.equal(retryable(task(), { status: "RUNNING" }), false);
  assert.equal(retryable(task(), { status: "QUEUED" }), false);
  assert.equal(retryable(task(), { status: "WAITING_INBOX" }), false);
  assert.equal(retryable(task(), { status: "SUCCEEDED" }), false);
  assert.equal(retryable(task({ status: "REVIEW" }), { status: "SUCCEEDED" }), true);
});

test("an exhausted budget is reported apart from the refusals an operator cannot lift", () => {
  const failed = { status: "FAILED" as const };
  const spent = task({ failureReason: "boom", budgetRemaining: false });
  assert.equal(retryShape(spent, failed), "budget-exhausted");
  assert.equal(retryable(spent, failed), false, "the API would answer this one 409");
  // An exhausted budget on a task that could not be retried anyway stays
  // `unavailable`: raising the budget would not produce a retry, so the detail
  // page must not offer the field as though it would.
  assert.equal(retryShape(task({ budgetRemaining: false }), { status: "RUNNING" }), "unavailable");
  assert.equal(retryShape(task({ budgetRemaining: false }), { status: "SUCCEEDED" }), "unavailable");
  assert.equal(retryShape(task({ failureReason: "boom" }), failed), "available");
});

/* ------------------------------------------------------------- run liveness */

const STARTED = "2026-08-16T00:00:00.000Z";

test("one liveness rule answers the clock, the live state and the suppressed status word", () => {
  // Every Run status, started and not, with the answer stated rather than
  // recomputed. Suspended Inbox work is live; every terminal status is not, and
  // a terminal run's `startedAt` belongs to a duration that already ended.
  const rows: Array<{
    status: RunStatus; startedAt: string | null;
    live: boolean; elapsedSince: string | null; statusSuppressed: boolean;
  }> = [
    { status: "QUEUED", startedAt: null, live: true, elapsedSince: null, statusSuppressed: false },
    { status: "QUEUED", startedAt: STARTED, live: true, elapsedSince: STARTED, statusSuppressed: false },
    { status: "CLAIMED", startedAt: null, live: true, elapsedSince: null, statusSuppressed: false },
    // The divergence this rule exists to close: a CLAIMED run with a start took
    // an elapsed clock from one card and a `timeAgo` from another.
    { status: "CLAIMED", startedAt: STARTED, live: true, elapsedSince: STARTED, statusSuppressed: false },
    { status: "PROVISIONING", startedAt: null, live: true, elapsedSince: null, statusSuppressed: false },
    { status: "PROVISIONING", startedAt: STARTED, live: true, elapsedSince: STARTED, statusSuppressed: false },
    { status: "RUNNING", startedAt: null, live: true, elapsedSince: null, statusSuppressed: false },
    { status: "RUNNING", startedAt: STARTED, live: true, elapsedSince: STARTED, statusSuppressed: true },
    { status: "WAITING_INBOX", startedAt: null, live: true, elapsedSince: null, statusSuppressed: false },
    { status: "WAITING_INBOX", startedAt: STARTED, live: true, elapsedSince: STARTED, statusSuppressed: false },
    { status: "SUCCEEDED", startedAt: STARTED, live: false, elapsedSince: null, statusSuppressed: false },
    { status: "FAILED", startedAt: STARTED, live: false, elapsedSince: null, statusSuppressed: false },
    { status: "TIMED_OUT", startedAt: STARTED, live: false, elapsedSince: null, statusSuppressed: false },
    { status: "CANCELLED", startedAt: STARTED, live: false, elapsedSince: null, statusSuppressed: false },
    { status: "LOST", startedAt: STARTED, live: false, elapsedSince: null, statusSuppressed: false },
  ];
  for (const { status, startedAt, ...expected } of rows) {
    assert.deepEqual(runLiveness({ status, startedAt }), expected, `${status} startedAt=${startedAt}`);
  }
});

/* -------------------------------------------------------------- the focus */

test("focus follows the moved card when it is still on screen", () => {
  // The desktop board: a move only changes column, so the card itself is still
  // there and taking the focus anywhere else would be a jump for no reason.
  assert.equal(focusAfterMove(["a", "b", "c"], "b", ["a", "b", "c"]), "b");
});

test("focus lands on the next card when the moved one leaves the list", () => {
  assert.equal(focusAfterMove(["a", "c"], "b", ["a", "b", "c"]), "c");
});

test("focus after a Backlog move follows the rendered newest-first order", () => {
  const asDelivered = [
    task({ id: "old", status: "BACKLOG", createdAt: "2026-08-16T00:00:00.000Z" }),
    task({ id: "mid", status: "BACKLOG", createdAt: "2026-08-17T00:00:00.000Z" }),
    task({ id: "new", status: "BACKLOG", createdAt: "2026-08-18T00:00:00.000Z" }),
  ];
  const renderedBefore = orderColumn(asDelivered).map((row) => row.id);
  assert.equal(focusAfterMove(["new", "old"], "mid", renderedBefore), "old");
});

test("focus falls back upwards when the moved card was last", () => {
  assert.equal(focusAfterMove(["a", "b"], "c", ["a", "b", "c"]), "b");
});

test("an emptied list has nothing to focus, and says so", () => {
  // The page focuses the list container itself, which is why null is a value
  // rather than a failure.
  assert.equal(focusAfterMove([], "a", ["a"]), null);
});

/* ------------------------------------------------- horizontal arithmetic */

test("one press moves the board by exactly one column", () => {
  // 5 columns of 250 with 12px gaps: 1,298 total, so a step is 262.
  assert.equal(columnStep({ scrollWidth: 1298, clientWidth: 690 }, 5, 12), 262);
  assert.equal(columnStep({ scrollWidth: 690, clientWidth: 690 }, 0, 12), 690, "no columns: fall back to a page");
});

test("the board's ends are exact, so an arrow at an edge cannot stay enabled", () => {
  const board = { scrollWidth: 1298, clientWidth: 690 };
  assert.equal(clampScroll(-40, board), 0);
  assert.equal(clampScroll(999_999, board), 608);
  assert.equal(clampScroll(261.6, board), 262);
  assert.equal(clampScroll(100, { scrollWidth: 690, clientWidth: 690 }), 0);
});

test("a board with nothing off screen is at both of its ends", () => {
  // Which is what disables both arrows and draws neither fade at 1440px, where
  // all five columns are already visible.
  const edges = edgeState({ scrollLeft: 0, scrollWidth: 1400, clientWidth: 1400 });
  assert.deepEqual(edges, { overflowing: false, atStart: true, atEnd: true });
});

test("the ends tolerate the fraction of a pixel Chrome actually reports", () => {
  // At 110% zoom `scrollWidth - clientWidth` comes back as 607.6 and scrolling
  // to the end lands on 607.2: exact comparison would leave `>` enabled forever
  // with nothing left to scroll to.
  const box = { scrollWidth: 1297.6, clientWidth: 690 };
  assert.equal(edgeState({ ...box, scrollLeft: 607.2 }).atEnd, true);
  assert.equal(edgeState({ ...box, scrollLeft: 0.4 }).atStart, true);
  // A whole column away from an end is not an end.
  assert.equal(edgeState({ ...box, scrollLeft: 262 }).atStart, false);
  assert.equal(edgeState({ ...box, scrollLeft: 262 }).atEnd, false);
  assert.equal(edgeState({ ...box, scrollLeft: 262 }).overflowing, true);
});

test("edge state is compared by value, so a scroll that crosses nothing re-renders nothing", () => {
  const a = edgeState({ scrollLeft: 30, scrollWidth: 1298, clientWidth: 690 });
  const b = edgeState({ scrollLeft: 300, scrollWidth: 1298, clientWidth: 690 });
  assert.equal(sameEdges(a, b), true, "both are mid-board");
  assert.equal(sameEdges(a, edgeState({ scrollLeft: 0, scrollWidth: 1298, clientWidth: 690 })), false);
});

test("a remembered position is clamped to the board it is being restored into", () => {
  const board = { scrollLeft: 0, scrollWidth: 1298, clientWidth: 690 };
  assert.equal(storedScroll("262", board), 262);
  // Remembered on a 901px viewport, restored on a 1440px one where there is no
  // travel left at all.
  assert.equal(storedScroll("608", { scrollLeft: 0, scrollWidth: 1400, clientWidth: 1400 }), 0);
  assert.equal(storedScroll("999999", board), 608);
  assert.equal(storedScroll(null, board), 0);
  assert.equal(storedScroll("", board), 0);
  assert.equal(storedScroll("left", board), 0, "whatever else is in localStorage is not a position");
  assert.equal(storedScroll("-40", board), 0);
});
