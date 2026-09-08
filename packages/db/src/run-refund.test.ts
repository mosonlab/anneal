import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTERNAL_FAILURE_REFUND_CAP,
  LEASE_LOSS_REFUND_CAP,
  budgetRemaining,
  highestBudgetGrants,
  leaseLossRefundAvailable,
  refundDecision,
  refundForLostRun,
  reopenRefundedRun,
  runBudgetCeiling,
  type LostRunRefund,
} from "./run-refund.js";

const now = new Date("2026-09-07T12:00:00.000Z");

const lostRun = (over: Partial<{
  id: string; runNumber: number; leaseLossRefunds: number; maxRunsPerTask: number; budgetGrants: number;
}> = {}) => ({
  id: "run-1",
  runNumber: 1,
  leaseLossRefunds: 0,
  maxRunsPerTask: 5,
  budgetGrants: 0,
  ...over,
});

test("runBudgetCeiling is the only ceiling algorithm and clamps negative grants", () => {
  assert.equal(runBudgetCeiling(5, undefined), 5);
  assert.equal(runBudgetCeiling(5, null), 5);
  assert.equal(runBudgetCeiling(5, -2), 5);
  assert.equal(runBudgetCeiling(5, 3), 8);
});

test("leaseLossRefundAvailable reads the count alone and clamps a negative one", () => {
  assert.equal(LEASE_LOSS_REFUND_CAP, 3);
  assert.deepEqual(
    [-1, 0, 1, 2, 3, 4].map((refunds) => leaseLossRefundAvailable(refunds)),
    [true, true, true, true, false, false],
  );
  assert.equal(leaseLossRefundAvailable(null), true);
  assert.equal(leaseLossRefundAvailable(undefined), true);
});

test("budgetRemaining measures run count against the ceiling the grants raised", () => {
  assert.equal(budgetRemaining(2, { total: 2 }), false);
  assert.equal(budgetRemaining(2, { total: 2, budgetGrants: 1 }), true);
  assert.equal(budgetRemaining(2, { total: 3, budgetGrants: 1 }), false);
  // Absent and null grants fail closed at the configured budget.
  assert.equal(budgetRemaining(2, { total: 1, budgetGrants: null }), true);
  assert.equal(budgetRemaining(2, { total: 2, budgetGrants: null }), false);
});

test("highestBudgetGrants reads the carried-forward running total", () => {
  assert.equal(highestBudgetGrants([]), null);
  assert.equal(highestBudgetGrants([0, 1, 3, 2]), 3);
  assert.equal(highestBudgetGrants([null, undefined, 2]), 2);
  assert.equal(highestBudgetGrants([0]), 0);
});

// The whole roster in one place: every reason, at every cap state, granting or
// refusing, and the budget columns each answer carries.
test("refundDecision answers every refund class with the same shape", () => {
  const platform: ("lease-loss" | "claim-invalidated")[] = ["lease-loss", "claim-invalidated"];
  for (const reason of platform) {
    for (const refunds of [0, 1, 2, LEASE_LOSS_REFUND_CAP, LEASE_LOSS_REFUND_CAP + 1]) {
      const run = lostRun({ leaseLossRefunds: refunds, maxRunsPerTask: 5 + refunds, budgetGrants: refunds });
      const granted = refundDecision({ reason, run, latestRunId: run.id });
      const available = refunds < LEASE_LOSS_REFUND_CAP;
      assert.equal(granted.grant, available, `${reason} at ${refunds}`);
      assert.equal(granted.activity, null);
      assert.deepEqual(granted.budget, available
        ? { maxRunsPerTask: run.maxRunsPerTask + 1, budgetGrants: run.budgetGrants + 1 }
        : { maxRunsPerTask: run.maxRunsPerTask, budgetGrants: run.budgetGrants });
      if (!granted.grant && available === false) assert.equal(granted.why, "refunds-exhausted");

      // A terminalized source cannot record a refund belonging to a newer Run.
      const stale = refundDecision({ reason, run, latestRunId: "newer-run" });
      assert.equal(stale.grant, false);
      if (!stale.grant) assert.equal(stale.why, "not-latest-run");
      assert.deepEqual(stale.budget, { maxRunsPerTask: run.maxRunsPerTask, budgetGrants: run.budgetGrants });
    }
  }
});

test("three capped external failures refund the task and the fourth records the cap", () => {
  let cappedRefunds = 0;
  let budget = { maxRunsPerTask: 1, budgetGrants: 0 };
  for (let runNumber = 1; runNumber <= EXTERNAL_FAILURE_REFUND_CAP; runNumber += 1) {
    const decision = refundDecision({
      reason: "external-failure",
      run: { runNumber, ...budget },
      external: true,
      refundable: true,
      mechanical: false,
      capped: true,
      priorCappedRefunds: cappedRefunds,
    });
    assert.equal(decision.grant, true);
    assert.equal(decision.activity?.metadata.capReached, false);
    assert.match(decision.activity?.body ?? "", new RegExp(`${runNumber} of ${EXTERNAL_FAILURE_REFUND_CAP}`));
    cappedRefunds += 1;
    budget = decision.budget;
    assert.equal(budget.budgetGrants, runNumber);
    assert.equal(budget.maxRunsPerTask, runNumber + 1);
  }
  assert.equal(budget.budgetGrants, EXTERNAL_FAILURE_REFUND_CAP);
  const fourth = refundDecision({
    reason: "external-failure",
    run: { runNumber: EXTERNAL_FAILURE_REFUND_CAP + 1, ...budget },
    external: true,
    refundable: true,
    mechanical: false,
    capped: true,
    priorCappedRefunds: cappedRefunds,
  });
  assert.equal(fourth.grant, false);
  if (!fourth.grant) assert.equal(fourth.why, "refunds-exhausted");
  assert.equal(fourth.activity?.metadata.capReached, true);
  assert.match(fourth.activity?.body ?? "", /external-failure refund cap was reached/i);
  // A refused refund still states the unchanged pair, so both paths write the
  // same two columns.
  assert.deepEqual(fourth.budget, budget);
});

test("legacy external refunds do not consume the capped allowance", () => {
  const decision = refundDecision({
    reason: "external-failure",
    run: { runNumber: 8, maxRunsPerTask: 5, budgetGrants: 2 },
    external: true,
    refundable: true,
    mechanical: false,
    capped: false,
    priorCappedRefunds: EXTERNAL_FAILURE_REFUND_CAP,
  });
  assert.equal(decision.grant, true);
  assert.equal(decision.activity?.metadata.capReached, false);
  assert.equal(decision.activity?.metadata.policy, "uncapped");
  assert.deepEqual(decision.budget, { maxRunsPerTask: 6, budgetGrants: 3 });
});

test("ineligible, mechanical and internal failures never receive a refund", () => {
  for (const [input, why] of [
    [{ external: true, refundable: false, mechanical: false }, "failure-not-refundable"],
    [{ external: true, refundable: true, mechanical: true }, "mechanical-step"],
    [{ external: false, refundable: true, mechanical: false }, "failure-not-external"],
  ] as const) {
    const decision = refundDecision({
      reason: "external-failure",
      run: { runNumber: 2, maxRunsPerTask: 5, budgetGrants: 1 },
      capped: false,
      priorCappedRefunds: 0,
      ...input,
    });
    assert.equal(decision.grant, false);
    if (!decision.grant) assert.equal(decision.why, why);
    assert.deepEqual(decision.budget, { maxRunsPerTask: 5, budgetGrants: 1 });
    assert.equal(decision.activity?.metadata.granted ?? false, false);
  }
  // An internal failure leaves no refund narration at all.
  const internal = refundDecision({
    reason: "external-failure",
    run: { runNumber: 2, maxRunsPerTask: 5, budgetGrants: 1 },
    external: false, refundable: true, mechanical: false, capped: true, priorCappedRefunds: 0,
  });
  assert.equal(internal.activity, null);
});

/** The one query `refundForLostRun` makes: which Run is the task's latest. */
const latestRunTx = (latestRunId: string | null) => ({
  run: { findFirst: async () => (latestRunId === null ? null : { id: latestRunId }) },
});

test("refundForLostRun binds the grant to the task's latest Run and states the birth intent", async () => {
  const run = lostRun({ leaseLossRefunds: 1, maxRunsPerTask: 6, budgetGrants: 1 });
  const refund = await refundForLostRun(latestRunTx(run.id) as never, { taskId: "task-1", run, reason: "lease-loss" });
  assert.equal(refund.granted, true);
  assert.equal(refund.sourceRunId, run.id);
  assert.deepEqual(refund.budget, { maxRunsPerTask: 7, budgetGrants: 2 });
  const readyAt = new Date(now.getTime() + 30_000);
  assert.deepEqual(refund.intent(readyAt), {
    kind: "retry-after-lease-loss",
    sourceRunId: run.id,
    // The pre-refund pair: `openRun` adds the grant, so the replacement's
    // columns match `budget` without either side restating the arithmetic.
    sourceMaxRunsPerTask: 6,
    sourceBudgetGrants: 1,
    readyAt,
  });

  const invalidated = await refundForLostRun(
    latestRunTx(run.id) as never,
    { taskId: "task-1", run, reason: "claim-invalidated" },
  );
  assert.deepEqual(invalidated.intent(readyAt), {
    kind: "claim-invalidated", sourceRunId: run.id, readyAt,
  });

  const stale = await refundForLostRun(
    latestRunTx("newer-run") as never,
    { taskId: "task-1", run, reason: "lease-loss" },
  );
  assert.equal(stale.granted, false);
  assert.equal(stale.why, "not-latest-run");
  assert.deepEqual(stale.budget, { maxRunsPerTask: 6, budgetGrants: 1 });

  // A Run with no task cannot be bound to a latest Run, so it is not refunded.
  const orphan = await refundForLostRun(
    latestRunTx("run-1") as never,
    { taskId: null, run, reason: "lease-loss" },
  );
  assert.equal(orphan.granted, false);
  assert.equal(orphan.why, "not-latest-run");
});

test("reopenRefundedRun refuses a birth for a Run already at the ceiling its refund raised", async () => {
  const refund: LostRunRefund = {
    reason: "lease-loss",
    granted: true,
    why: null,
    sourceRunId: "run-9",
    runNumber: 9,
    budget: { maxRunsPerTask: 9, budgetGrants: 4 },
    intent: () => {
      throw new Error("no birth may be attempted for an exhausted budget");
    },
  };
  const reopened = await reopenRefundedRun({} as never, {
    taskId: "task-1", refund, readyAt: now, now, activityPrefix: "lost",
  });
  assert.deepEqual(reopened, { kind: "exhausted", ceiling: 9 });

  // A refused refund is never measured against a ceiling it did not raise: the
  // birth is attempted so `openRun` states which bound it hit.
  const attempted = new Error("birth attempted");
  const refused: LostRunRefund = {
    ...refund,
    granted: false,
    why: "refunds-exhausted",
    intent: () => {
      throw attempted;
    },
  };
  await assert.rejects(
    reopenRefundedRun({} as never, {
      taskId: "task-1", refund: refused, readyAt: now, now, activityPrefix: "lost",
    }),
    (error: unknown) => error === attempted,
  );
});
