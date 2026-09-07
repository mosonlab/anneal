import assert from "node:assert/strict";
import test from "node:test";

import { type ChainControlActionKind, chainAggregateFigures, chainControlAction, chainStepPosition } from "../lib/chain-aggregate";
import type { BoardTask, ChainAggregate, ChainAggregateState } from "../lib/types";
import { boardRun } from "./board-run";

const HOLD = { heldLayer: 2, heldAt: "2026-08-16T00:00:00.000Z", holdReason: null };

const activation = (
  state: ChainAggregateState,
  hold: ChainAggregate["activation"]["hold"],
): ChainAggregate["activation"] => ({
  state,
  predecessor: state === "waiting-on-predecessor" ? { taskId: "previous", taskName: "Prepare release" } : null,
  taskId: "step-1",
  hold,
});

/** Every `activation.state` by every `activation.hold`. The cells a non-null
 *  hold pairs with anything but `held` or `running` are shapes the board
 *  projection cannot emit; they are pinned here so the rule stays total and
 *  offers nothing rather than guessing. */
const MATRIX: Array<[ChainAggregateState, ChainControlActionKind | null, ChainControlActionKind | null]> = [
  // state,                    hold null,  hold set
  ["parked-unactivated", "activate", null],
  ["waiting-on-predecessor", "hold", null],
  ["running", "hold", "resume"],
  ["held", null, "resume"],
  ["idle", null, null],
  ["settled", null, null],
];

test("one rule answers which control action a Chain admits, for every state and hold", () => {
  for (const [state, released, holdingBarrier] of MATRIX) {
    for (const [hold, expected] of [[null, released], [HOLD, holdingBarrier]] as const) {
      const action = chainControlAction(activation(state, hold));
      assert.equal(action?.kind ?? null, expected, `${state} with hold ${hold === null ? "null" : "set"}`);
      if (action !== null) assert.equal(action.taskId, "step-1");
    }
  }
});

test("a Chain with no activation task admits nothing, whatever its state says", () => {
  for (const [state] of MATRIX) {
    assert.equal(chainControlAction({ ...activation(state, null), taskId: null }), null, state);
    assert.equal(chainControlAction({ ...activation(state, HOLD), taskId: null }), null, state);
  }
});

const member = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: "step-3", name: "Release: Implement", displayName: "Implement", status: "TODO", moveTargets: [],
  failureReason: null, assigneeType: "AGENT", createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T01:00:00.000Z", scheduleKind: "NOW", runAt: null, cron: null, timezone: null,
  approvalGate: false, templateId: null, source: "MANUAL", chainId: "chain-1", chainIndex: null,
  chainName: "Release", assigneeAgent: null, chainProgress: null, latestRun: null, strandedSalvageBranches: [], taskCost: null, budgetRemaining: true, leaseLossRefunds: 0,
  blockedOn: null, mergeOutcome: null, repairOf: null, chainAggregate: null, baseline: null, readinessRequeues: 0, readinessGrants: 0, ...overrides,
});

const aggregate = (position: number | null, done: number, stepCount = 12): ChainAggregate => ({
  chainId: "chain-1", chainName: "Release", stepCount,
  statusCounts: { BACKLOG: 0, TODO: stepCount - done, DOING: 0, REVIEW: 0, DONE: done },
  detailTaskId: "step-3", status: "TODO",
  frontier: { taskId: "step-3", title: "Implement release", status: "TODO", latestRun: null, mergeOutcome: null, failureReason: null, position },
  activeRepair: null, activation: activation("running", null), totalCost: null, firstRunStartedAt: null,
  createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T01:00:00.000Z",
});

test("the Step a card names falls back from the projection to the member to the settled count", () => {
  assert.equal(chainStepPosition(aggregate(3, 2), []), 3);
  assert.equal(chainStepPosition(aggregate(null, 2), [member({ chainProgress: {
    chainId: "chain-1", done: 2, total: 12, activeStepName: "Implement release", activeStatus: "TODO",
    currentLayer: 5, layerCount: 12, position: 5,
  } })]), 5);
  assert.equal(chainStepPosition(aggregate(null, 2), [member({ chainIndex: 6 })]), 7);
  // No frontier among the rendered members: the settled count is a floor, and a
  // fully settled chain never claims a Step beyond its last.
  assert.equal(chainStepPosition(aggregate(null, 2), []), 3);
  assert.equal(chainStepPosition(aggregate(null, 12), []), 12);
});

test("a sparse frontier member never reports a position above the aggregate step count", () => {
  assert.equal(chainStepPosition(aggregate(null, 2, 3), [member({ chainIndex: 8 })]), 3);
});

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const at = (hoursBeforeNow: number): string => new Date(NOW - hoursBeforeNow * HOUR).toISOString();
const REPAIR = { chainId: "chain-1", chainName: "Release", repairKind: "gate-fix" };
const COST = { costUsd: "13.74", estimated: true, inputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: null, outputTokens: null };

test("the figures state the server's chain cost, never a client re-sum of the visible rows", () => {
  const priced = { ...aggregate(3, 2), totalCost: COST };
  const cheaper = member({ taskCost: { ...COST, costUsd: "0.10" } });
  assert.equal(chainAggregateFigures(priced, [cheaper], NOW).cost, COST);
  assert.equal(chainAggregateFigures(aggregate(3, 2), [cheaper], NOW).cost, null);
});

test("lead time uses the first failed attempt even when the board only projects its retry", () => {
  const retry = member({ latestRun: boardRun({ status: "RUNNING", runNumber: 2, startedAt: at(2) }) });
  const projection = { ...aggregate(1, 0), firstRunStartedAt: at(30) };
  assert.equal(chainAggregateFigures(projection, [retry], NOW).leadTimeMs, 30 * HOUR);
});

test("lead time runs from the authoritative first start to now while a run is active, and to the last end once none is", () => {
  const first = member({ id: "step-1", latestRun: boardRun({ startedAt: at(30), endedAt: at(29) }) });
  const second = member({ id: "step-2", latestRun: boardRun({ startedAt: at(20), endedAt: at(18) }) });
  const running = { ...aggregate(3, 2), firstRunStartedAt: at(30), frontier: { ...aggregate(3, 2).frontier, latestRun: boardRun({ status: "RUNNING", startedAt: at(1) }) } };
  assert.equal(chainAggregateFigures(running, [first, second], NOW).leadTimeMs, 30 * HOUR);
  // A queued frontier has not started but the chain is still going: the span
  // keeps ticking rather than stopping at the last recorded end.
  const queued = { ...aggregate(3, 2), firstRunStartedAt: at(30), frontier: { ...aggregate(3, 2).frontier, latestRun: boardRun({ status: "QUEUED" }) } };
  assert.equal(chainAggregateFigures(queued, [first, second], NOW).leadTimeMs, 30 * HOUR);
  const settled = { ...aggregate(3, 2), firstRunStartedAt: at(30), frontier: { ...aggregate(3, 2).frontier, latestRun: boardRun({ startedAt: at(3), endedAt: at(2) }) } };
  assert.equal(chainAggregateFigures(settled, [first, second], NOW).leadTimeMs, 28 * HOUR);
  // The frontier and the active repair count even when their rows are off the page.
  const repairing = { ...settled, activeRepair: { repairKind: "gate-fix", latestRun: boardRun({ status: "RUNNING", startedAt: at(1) }) } };
  assert.equal(chainAggregateFigures(repairing, [], NOW).leadTimeMs, 30 * HOUR);
});

test("lead time is unknown, not zero, until a run has started or once nothing dates the end", () => {
  assert.equal(chainAggregateFigures(aggregate(3, 2), [member()], NOW).leadTimeMs, null);
  const queued = { ...aggregate(3, 2), frontier: { ...aggregate(3, 2).frontier, latestRun: boardRun({ status: "QUEUED" }) } };
  assert.equal(chainAggregateFigures(queued, [member()], NOW).leadTimeMs, null);
  // Started, no longer active, and no end recorded: the board cannot say how
  // long the chain ran, so it does not.
  const undated = member({ latestRun: boardRun({ status: "LOST", startedAt: at(2) }) });
  assert.equal(chainAggregateFigures(aggregate(3, 2), [undated], NOW).leadTimeMs, null);
});

test("repair rounds count the visible repair rows, or the detached repair the aggregate alone can see", () => {
  const repairs = [member({ id: "fix-1", repairOf: REPAIR }), member({ id: "fix-2", repairOf: REPAIR }), member()];
  assert.equal(chainAggregateFigures(aggregate(3, 2), repairs, NOW).repairRounds, 2);
  assert.equal(chainAggregateFigures(aggregate(3, 2), [member()], NOW).repairRounds, 0);
  const detached = { ...aggregate(3, 2), activeRepair: { repairKind: "gate-fix", latestRun: boardRun({ status: "RUNNING", startedAt: at(1) }) } };
  assert.equal(chainAggregateFigures(detached, [member()], NOW).repairRounds, 1);
  // A visible repair row is the same round the aggregate names, not a second one.
  assert.equal(chainAggregateFigures(detached, [member({ id: "fix-1", repairOf: REPAIR })], NOW).repairRounds, 1);
});
