import assert from "node:assert/strict";
import test from "node:test";

import {
  completionActivityBody,
  completionAdvancement,
  type CompletionAdvancement,
  type CompletionAdvancementFacts,
} from "./completion-advancement.js";

// One row per arm of the completion outcome ladder. Before this table the same
// arms were reachable only through a scratch PostgreSQL, because the decision
// was fused with the writes it selected; the Prisma fake that stood in for it
// could only reach the last row by pinning chainId, templateId and templateStep
// to null.
const facts = (overrides: Partial<CompletionAdvancementFacts> = {}): CompletionAdvancementFacts => ({
  runNumber: 3,
  succeeded: true,
  mechanical: false,
  task: {
    templateId: null,
    chainId: null,
    approvalGate: false,
    regressionVerificationStep: false,
  },
  durableNegativeRegressionVerdict: false,
  outputRefusal: null,
  mergeTailAuxiliary: false,
  mergeTailHandled: false,
  mergeTrainSettled: false,
  repairBindingRefusal: null,
  auxiliaryTargetTaskId: null,
  mergeTailRequeue: false,
  mergeTailRecoverySourceRunId: null,
  retryCreated: false,
  retryRefusalMessage: null,
  budgetExhausted: false,
  budgetCeiling: 3,
  missingOutputReason: null,
  reportedFailureReason: null,
  ...overrides,
});

const templateTask = (overrides: Partial<CompletionAdvancementFacts["task"]> = {}) => ({
  templateId: "template-1",
  chainId: "chain-1",
  approvalGate: false,
  regressionVerificationStep: false,
  ...overrides,
});

const rows: { name: string; facts: CompletionAdvancementFacts; expected: CompletionAdvancement }[] = [
  {
    name: "a failed Run that published a negative Regression verdict hands the chain to repair",
    facts: facts({
      succeeded: false,
      durableNegativeRegressionVerdict: true,
      task: templateTask({ regressionVerificationStep: true }),
      reportedFailureReason: "stream closed",
    }),
    expected: { case: "repair-after-negative-regression" },
  },
  {
    name: "a successful integrator Step is already settled by its own merge result",
    facts: facts({ mechanical: true, task: templateTask() }),
    expected: { case: "mechanical-merge-already-recorded" },
  },
  {
    name: "a refused canonical output is terminal, whatever else the Step is",
    facts: facts({ task: templateTask(), outputRefusal: "missing implementation output" }),
    expected: { case: "stop-with-output-refusal", reason: "missing implementation output" },
  },
  {
    name: "a successful Regression Step is settled by its verdict",
    facts: facts({ task: templateTask({ regressionVerificationStep: true }) }),
    expected: { case: "settle-regression-verdict" },
  },
  {
    name: "an ordinary canonical Step advances its template task",
    facts: facts({
      task: templateTask(),
      mergeTailRequeue: true,
      mergeTailRecoverySourceRunId: "run-recovery",
    }),
    expected: {
      case: "advance-template-step",
      mergeTailRequeue: true,
      mergeTailRecoverySourceRunId: "run-recovery",
    },
  },
  {
    name: "a chain step the merge tail already settled writes nothing further",
    facts: facts({ task: templateTask({ templateId: null }), mergeTailHandled: true }),
    expected: { case: "merge-tail-settled" },
  },
  {
    name: "a gated chain step asks its gate question",
    facts: facts({ task: templateTask({ templateId: null, approvalGate: true }) }),
    expected: { case: "ask-approval-gate-question" },
  },
  {
    name: "an ungated chain step completes and activates its successor",
    facts: facts({ task: templateTask({ templateId: null }) }),
    expected: {
      case: "complete-and-activate-successors",
      activateChainSuccessor: true,
      auxiliaryTargetTaskId: null,
    },
  },
  {
    name: "a successful automatic repair activates the merge-tail target it serves",
    facts: facts({ mergeTailAuxiliary: true, auxiliaryTargetTaskId: "task-regression" }),
    expected: {
      case: "complete-and-activate-successors",
      activateChainSuccessor: false,
      auxiliaryTargetTaskId: "task-regression",
    },
  },
  {
    name: "a repair whose recovery names another Run is rejected, not activated",
    facts: facts({
      mergeTailAuxiliary: true,
      auxiliaryTargetTaskId: "task-regression",
      repairBindingRefusal: "merge-tail-repair-binding-mismatch: merge recovery aggregate-1 is bound to source Run run-a, not to repaired Run run-b",
    }),
    expected: {
      case: "reject-repair-binding",
      reason: "merge-tail-repair-binding-mismatch: merge recovery aggregate-1 is bound to source Run run-a, not to repaired Run run-b",
    },
  },
  {
    name: "a repair the merge tail already settled is not re-decided by its binding",
    facts: facts({
      mergeTailAuxiliary: true,
      mergeTailHandled: true,
      auxiliaryTargetTaskId: "task-regression",
      repairBindingRefusal: "merge-tail-repair-binding-mismatch: merge recovery aggregate-1 is bound to source Run run-a, not to repaired Run run-b",
    }),
    expected: { case: "merge-tail-settled" },
  },
  {
    name: "a settled merge train card keeps the status its settlement wrote",
    facts: facts({ mergeTrainSettled: true }),
    expected: { case: "merge-train-control-plane-settled" },
  },
  {
    name: "a failed Run on a settled merge train card still leaves the settlement standing",
    facts: facts({ succeeded: false, mergeTrainSettled: true, reportedFailureReason: "exit 1" }),
    expected: { case: "merge-train-control-plane-settled" },
  },
  {
    name: "a standalone success parks the task for review",
    facts: facts(),
    expected: { case: "park-task", status: "REVIEW", failureReason: null },
  },
  {
    name: "a failure with a retry parks the task as DOING and still carries its reason",
    facts: facts({ succeeded: false, retryCreated: true, reportedFailureReason: "exit 1" }),
    expected: { case: "park-task", status: "DOING", failureReason: "exit 1" },
  },
  {
    name: "a spent budget parks the task naming the ceiling",
    facts: facts({ succeeded: false, budgetExhausted: true, budgetCeiling: 4 }),
    expected: { case: "park-task", status: "REVIEW", failureReason: "Maximum 4 runs reached" },
  },
  {
    name: "a refused automatic retry parks the task naming the refusal",
    facts: facts({ succeeded: false, retryRefusalMessage: "chain is held" }),
    expected: {
      case: "park-task",
      status: "REVIEW",
      failureReason: "Automatic retry refused: chain is held",
    },
  },
  {
    name: "an absent deliverable outranks both the ceiling and the reported reason",
    facts: facts({
      succeeded: false,
      budgetExhausted: true,
      missingOutputReason: "missing implementation task output for current Run run-3",
      reportedFailureReason: "exit 1",
    }),
    expected: {
      case: "park-task",
      status: "REVIEW",
      failureReason: "missing implementation task output for current Run run-3",
    },
  },
  {
    name: "a failure that reported nothing still says the execution failed",
    facts: facts({ succeeded: false }),
    expected: { case: "park-task", status: "REVIEW", failureReason: "Execution failed" },
  },
];

for (const row of rows) {
  test(`completion advancement: ${row.name}`, () => {
    assert.deepEqual(completionAdvancement(row.facts), row.expected);
  });
}

test("every advancement case has a row", () => {
  const cases = new Set(rows.map((row) => completionAdvancement(row.facts).case));
  assert.deepEqual([...cases].sort(), [
    "advance-template-step",
    "ask-approval-gate-question",
    "complete-and-activate-successors",
    "mechanical-merge-already-recorded",
    "merge-tail-settled",
    "merge-train-control-plane-settled",
    "park-task",
    "reject-repair-binding",
    "repair-after-negative-regression",
    "settle-regression-verdict",
    "stop-with-output-refusal",
  ]);
});

test("a negative Regression verdict on a Task with no template parks rather than repairs", () => {
  assert.deepEqual(
    completionAdvancement(facts({
      succeeded: false,
      durableNegativeRegressionVerdict: true,
      task: templateTask({ templateId: null, regressionVerificationStep: true }),
      reportedFailureReason: "stream closed",
    })),
    { case: "park-task", status: "REVIEW", failureReason: "stream closed" },
  );
});

test("a merge train card whose settlement has not run yet still parks", () => {
  assert.deepEqual(
    completionAdvancement(facts({ mergeTrainSettled: false })),
    { case: "park-task", status: "REVIEW", failureReason: null },
  );
});

const narrations: { name: string; facts: CompletionAdvancementFacts; expected: string | null }[] = [
  {
    name: "an integrator success narrates nothing; its own branch already did",
    facts: facts({ mechanical: true, task: templateTask() }),
    expected: null,
  },
  {
    name: "a durable negative Regression verdict is named before anything else",
    facts: facts({
      succeeded: false,
      durableNegativeRegressionVerdict: true,
      outputRefusal: "refused",
      task: templateTask(),
    }),
    expected: "Run 3 failed after publishing a negative Regression verdict; merge tail settled on the persisted verdict",
  },
  {
    name: "a refused canonical output is named even when the merge tail settled the Task",
    facts: facts({ task: templateTask({ templateId: null }), mergeTailHandled: true, outputRefusal: "refused" }),
    expected: "Run 3 succeeded but canonical task output was refused",
  },
  {
    name: "a rejected repair binding is narrated with its reason",
    facts: facts({
      mergeTailAuxiliary: true,
      auxiliaryTargetTaskId: "task-regression",
      repairBindingRefusal: "merge-tail-repair-binding-mismatch: merge recovery aggregate-1 is bound to source Run run-a, not to repaired Run run-b",
    }),
    expected: "Run 3 succeeded but its repair completion was rejected: merge-tail-repair-binding-mismatch: merge recovery aggregate-1 is bound to source Run run-a, not to repaired Run run-b",
  },
  {
    name: "a chain or template success reads as an advance or an awaited approval",
    facts: facts({ task: templateTask() }),
    expected: "Run 3 succeeded; chain advanced or awaiting approval",
  },
  {
    name: "a standalone success reads as a move to review",
    facts: facts(),
    expected: "Run 3 succeeded; task moved to review",
  },
  {
    name: "a retried failure reads as a queued retry",
    facts: facts({ succeeded: false, retryCreated: true }),
    expected: "Run 3 failed; retry queued",
  },
  {
    name: "a refused retry names the refusal",
    facts: facts({ succeeded: false, retryRefusalMessage: "chain is held" }),
    expected: "Run 3 failed; automatic retry refused: chain is held",
  },
  {
    name: "a final failure reads as a move to review",
    facts: facts({ succeeded: false }),
    expected: "Run 3 failed; task moved to review",
  },
];

for (const row of narrations) {
  test(`completion activity: ${row.name}`, () => {
    assert.equal(completionActivityBody(row.facts), row.expected);
  });
}
