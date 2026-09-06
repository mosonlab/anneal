import assert from "node:assert/strict";
import test from "node:test";

import { type ChainControlActionKind, chainControlAction, chainStepPosition } from "../lib/chain-aggregate";
import type { BoardTask, ChainAggregate, ChainAggregateState } from "../lib/types";

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
  chainName: "Release", assigneeAgent: null, chainProgress: null, latestRun: null, strandedSalvageBranches: [], taskCost: null, spendCapUsage: null, budgetRemaining: true, leaseLossRefunds: 0,
  blockedOn: null, mergeOutcome: null, repairOf: null, chainAggregate: null, ...overrides,
});

const aggregate = (position: number | null, done: number, stepCount = 12): ChainAggregate => ({
  chainId: "chain-1", chainName: "Release", stepCount,
  statusCounts: { BACKLOG: 0, TODO: stepCount - done, DOING: 0, REVIEW: 0, DONE: done },
  detailTaskId: "step-3", status: "TODO",
  frontier: { taskId: "step-3", title: "Implement release", status: "TODO", latestRun: null, mergeOutcome: null, failureReason: null, position },
  activeRepair: null, activation: activation("running", null), totalCost: null,
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
