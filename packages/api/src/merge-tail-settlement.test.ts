import assert from "node:assert/strict";
import test from "node:test";
import {
  FailureClass, markerFromMetadata, MERGE_TAIL_KIND,
  type Marker, type MarkerKind, type RegressionVerdict,
} from "@anneal/db";
import { deriveMergeTailFacts, type MergeTailFacts } from "./merge-tail-settlement.js";

type Input = Parameters<typeof deriveMergeTailFacts>[0];
const headSha = "a".repeat(40);
const marker = <K extends MarkerKind>(kind: K, fields: Record<string, string> = {}): Marker<K> => {
  const parsed = markerFromMetadata({ kind: MERGE_TAIL_KIND[kind], schemaVersion: 1, ...fields });
  assert.ok(parsed && parsed.kind === kind);
  return parsed as Marker<K>;
};
const repair = marker("repairAttempt", {
  regressionTaskId: "regression", sourceRunId: "source", headSha,
  repairKind: "review-fix",
});
const base = (): Input => ({
  run: { id: "run", taskId: "task", runNumber: 1 },
  task: { id: "task", templateId: null, chainId: null, templateStep: null },
  succeeded: true, external: false, retryable: false, failureClass: null,
  headSha, budgetCeiling: 2,
  markers: [], trainMarker: null, failedRepairHistory: [], failedRepairOutput: null,
  failedRegressionVerdict: null, requeueContext: null,
  documentationTaskId: null, documentationAbsence: null, repairBinding: null,
});
const mismatch = {
  reason: "merge-tail-repair-binding-mismatch: wrong recovery Run",
  recoveryId: "recovery", boundRecoveryRunId: "other", boundSourceRunId: "source",
  repairedRunId: "source", blockable: null,
};
const cases: Array<{ name: string; input: Partial<Input>; expected: Partial<MergeTailFacts> }> = [
  ...["settled", "aborted", "queued"].flatMap((state) => [true, false].map((succeeded) => ({
    name: `49880442: ${state} train after ${succeeded ? "success" : "failure"}`,
    input: { succeeded, trainMarker: marker("train", { trainTaskId: "task", state }) },
    expected: { mergeTrainSettled: state !== "queued" },
  }))),
  {
    name: "49880442: another train cannot settle this card",
    input: { trainMarker: marker("train", { trainTaskId: "other", state: "settled" }) },
    expected: { mergeTrainSettled: false },
  },
  {
    name: "49880442: candidate marker cannot settle a Chain Step",
    input: {
      task: { ...base().task!, chainId: "chain" },
      trainMarker: marker("train", { trainTaskId: "task", state: "settled" }),
    },
    expected: { mergeTrainSettled: false },
  },
  {
    name: "e503dc18: unbindable successful repair carries its refusal and target",
    input: { markers: [repair], repairBinding: { case: "mismatch", mismatch }, documentationTaskId: "docs" },
    expected: {
      mergeTailAuxiliary: true, auxiliaryTargetTaskId: "docs", documentationTaskId: "docs",
      repairBindingRefusal: mismatch.reason, unboundRepair: { regressionTaskId: "regression", mismatch },
      terminalFailureStopsLease: true,
    },
  },
  {
    name: "e503dc18: failed repair stops the Lease without rejecting its binding",
    input: { succeeded: false, markers: [repair], repairBinding: { case: "mismatch", mismatch } },
    expected: { mergeTailAuxiliary: false, repairBindingRefusal: null, terminalFailureStopsLease: true },
  },
  {
    name: "ordinary repair reopens Regression when its template has no Documentation Step",
    input: { markers: [repair], documentationAbsence: "retired-template", repairBinding: { case: "ordinary" } },
    expected: { auxiliaryTargetTaskId: "regression", repairDocumentationAbsence: "retired-template", repairBindingRefusal: null },
  },
  {
    name: "bound recovery is carried with the repair",
    input: { markers: [repair], repairBinding: { case: "recovery", recoverySourceRunId: "source" } },
    expected: { repairBinding: { case: "recovery", recoverySourceRunId: "source" }, repairBindingRefusal: null },
  },
  {
    name: "a repair with no current Run output can spend its next attempt",
    input: { succeeded: false, failedRepairHistory: [repair], failedRepairOutput: { runId: "old" } },
    expected: { retryFailedRepair: true },
  },
  {
    name: "current Run repair output prevents the missing-output retry",
    input: { succeeded: false, failedRepairHistory: [repair], failedRepairOutput: { runId: "run" } },
    expected: { retryFailedRepair: false },
  },
  {
    name: "a durable repair result prevents the missing-output retry",
    input: { succeeded: false, failedRepairHistory: [marker("repairResult", { runId: "run" }), repair] },
    expected: { retryFailedRepair: false },
  },
  {
    name: "Documentation requeue carries its recovery source",
    input: { requeueContext: { recoverySourceRunId: "source" } },
    expected: { mergeTailSuccessorRequeue: true, mergeTailRecoverySourceRunId: "source" },
  },
  {
    name: "ordinary completion does not stop or hand off the Lease",
    input: {}, expected: { terminalFailureStopsLease: false, retryInheritsLease: false },
  },
];
for (const { name, input, expected } of cases) {
  test(name, () => {
    const actual = deriveMergeTailFacts({ ...base(), ...input });
    for (const key of Object.keys(expected) as Array<keyof MergeTailFacts>) {
      assert.deepEqual(actual[key], expected[key], key);
    }
  });
}

for (const outcome of ["review-fail", "refresh-conflict", "gate-fail", "pass"] as const) {
  for (const mode of ["external", "protocol", "ordinary", "legacy-external", "refused", "success"] as const) {
    test(`cd62ba08: ${mode} completion with ${outcome} evidence`, () => {
      const evidence = { schemaVersion: 2 as const, headSha, baseHeadSha: "b".repeat(40) };
      const verdict: RegressionVerdict = outcome === "pass"
        ? { ...evidence, outcome, gateVerdict: "PASS", gateProof: "gate-proof" }
        : outcome === "gate-fail"
          ? { ...evidence, outcome, gateVerdict: "FAIL", gateProof: "gate-proof", summary: "fail" }
          : { ...evidence, outcome, summary: "fail" };
      const input: Input = {
        ...base(),
        task: { ...base().task!, templateStep: {
          stepIndex: 8, taskTemplate: { name: "direct-engineer-workflow" },
          outputKind: mode === "legacy-external" ? "regression-verification" : "regression-verification-v2",
        } },
        succeeded: mode === "success",
        external: mode === "external" || mode === "legacy-external",
        retryable: mode === "protocol",
        failureClass: mode === "protocol" ? FailureClass.PROTOCOL_ERROR : FailureClass.TASK_FAILED,
        headSha: mode === "protocol" ? headSha : null,
        failedRegressionVerdict: mode === "refused"
          ? { status: "refused", reason: "foreign Run or stale head" }
          : { status: "ok", verdict, headSha },
      };
      const actual = deriveMergeTailFacts(input);
      const expected = mode === "protocol" ? outcome !== "pass"
        : mode === "external" && (outcome === "review-fail" || outcome === "refresh-conflict");
      assert.equal(actual.durableNegativeRegressionVerdict, expected);
      assert.equal(actual.completionHeadSha, expected ? headSha : input.headSha);
      assert.equal(actual.terminalFailureStopsLease, true);
      assert.equal(actual.retryInheritsLease, true);
    });
  }
}

test("protocol failure cannot use a negative verdict for an unreported head", () => {
  const actual = deriveMergeTailFacts({
    ...base(), succeeded: false, retryable: true, failureClass: FailureClass.PROTOCOL_ERROR,
    task: { ...base().task!, templateStep: { stepIndex: 8, taskTemplate: { name: "direct-engineer-workflow" }, outputKind: "regression-verification-v2" } },
    headSha: null,
    failedRegressionVerdict: { status: "ok", headSha, verdict: {
      schemaVersion: 2, outcome: "review-fail", headSha, baseHeadSha: "b".repeat(40), summary: "fail",
    } },
  });
  assert.equal(actual.durableNegativeRegressionVerdict, false);
  assert.equal(actual.completionHeadSha, null);
});
