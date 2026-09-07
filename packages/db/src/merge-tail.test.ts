import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MergeRecoveryStatus, type Prisma } from "@prisma/client";

import {
  carryMergeRecoveryRun,
  defenseListReason,
  defenseTriggers,
  isMergeReadinessStep,
  mergeRecoveryPhase,
  mergeRecoveryTransitionAllowed,
  RECOVERY_TRANSITIONS,
  parseResolverResult,
  resolverFallbackEligible,
  parseMergeTrainRecord,
  parseRegressionVerdict,
} from "./merge-tail.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

test("merge recovery state transitions and operator phases are explicit", () => {
  const statuses = Object.values(MergeRecoveryStatus);
  const declaredEdges = statuses.flatMap((from) => (
    [...RECOVERY_TRANSITIONS[from]].map((to) => `${from}->${to}`)
  ));
  assert.deepEqual(declaredEdges, [
    "VALIDATING->REPAIRING",
    "VALIDATING->FAILED",
    "REPAIRING->AWAITING_AUTHORIZATION",
    "REPAIRING->BLOCKED_DOWNSTREAM",
    "AWAITING_AUTHORIZATION->REPAIRING",
    "AWAITING_AUTHORIZATION->BLOCKED_DOWNSTREAM",
    "AWAITING_AUTHORIZATION->SUCCEEDED",
    "BLOCKED_DOWNSTREAM->REPAIRING",
    "SUCCEEDED->AWAITING_AUTHORIZATION",
    "FAILED->VALIDATING",
  ]);
  for (const from of statuses) {
    for (const to of statuses) {
      assert.equal(
        mergeRecoveryTransitionAllowed(from, to),
        from === to || RECOVERY_TRANSITIONS[from].has(to),
        `${from} -> ${to}`,
      );
    }
  }
  assert.deepEqual(Object.values(MergeRecoveryStatus).map((status) => mergeRecoveryPhase(status)), [
    "validation",
    "repair",
    "authorization-wait",
    "downstream-stop",
    "succeeded",
    "actual-failure",
  ]);
});

test("a repaired Regression Run is carried onto the active recovery aggregate", async () => {
  const updates: Array<Record<string, any>> = [];
  const aggregate = {
    id: "recovery-1",
    status: MergeRecoveryStatus.REPAIRING,
    recoveryRunId: "regression-run-1",
  };
  const tx = {
    mergeRecoveryAttempt: {
      findFirst: async () => aggregate,
      findUnique: async () => aggregate,
      updateMany: async (args: Record<string, any>) => {
        updates.push(args);
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ ...aggregate, recoveryRunId: "regression-run-2" }),
    },
  } as unknown as Prisma.TransactionClient;

  await carryMergeRecoveryRun(tx, {
    regressionTaskId: "regression-1",
    recoveryRunId: "regression-run-2",
    previousRecoveryRunId: "regression-run-1",
  });
  assert.equal(updates[0]?.data.status, MergeRecoveryStatus.REPAIRING);
  assert.equal(updates[0]?.data.recoveryRunId, "regression-run-2");
  assert.equal(updates[0]?.where.AND[1].regressionTaskId, "regression-1");
  assert.equal(updates[0]?.where.AND[1].recoveryRunId, "regression-run-1");
});

test("a repaired Regression Run cannot retarget an unrelated recovery", async () => {
  let updates = 0;
  const tx = {
    mergeRecoveryAttempt: {
      findFirst: async () => ({
        id: "recovery-2",
        status: MergeRecoveryStatus.REPAIRING,
        recoveryRunId: "different-source-run",
      }),
      updateMany: async () => { updates += 1; return { count: 1 }; },
    },
  } as unknown as Prisma.TransactionClient;

  await assert.rejects(carryMergeRecoveryRun(tx, {
    regressionTaskId: "regression-1",
    recoveryRunId: "regression-run-2",
    previousRecoveryRunId: "regression-run-1",
  }), /is not bound to repaired Run regression-run-1/u);
  assert.equal(updates, 0);
});

test("an expected recovery carry fails loudly when its aggregate is absent", async () => {
  const tx = {
    mergeRecoveryAttempt: { findFirst: async () => null },
  } as unknown as Prisma.TransactionClient;

  await assert.rejects(carryMergeRecoveryRun(tx, {
    regressionTaskId: "regression-1",
    recoveryRunId: "regression-run-2",
    previousRecoveryRunId: "regression-run-1",
  }), /is absent/u);
});

test("regression verdicts are exact-head, versioned, and fail closed", () => {
  const pass = parseRegressionVerdict(JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: A, baseHeadSha: B, gateVerdict: "PASS" }));
  assert.equal(pass.status, "ok");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    schemaVersion: 1, outcome: "review-fail", headSha: A, baseHeadSha: B, summary: "MF-2 remains open",
  })).status, "ok");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    schemaVersion: 1, outcome: "review-fail", headSha: A, baseHeadSha: B, summary: "  ",
  })).status, "invalid");
  assert.equal(parseRegressionVerdict(JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: A, baseHeadSha: B, gateVerdict: "FAIL" })).status, "invalid");
  assert.equal(parseRegressionVerdict("MERGE GATE: PASS").status, "invalid");
});

test("the narrowed Regression contract requires v2 while legacy output remains readable", () => {
  const v2 = JSON.stringify({
    schemaVersion: 2,
    outcome: "pass",
    headSha: A,
    baseHeadSha: B,
    gateVerdict: "PASS",
    gateProof: `MERGE GATE: PASS ${A}`,
  });
  const v1 = JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: A, baseHeadSha: B, gateVerdict: "PASS" });
  assert.equal(parseRegressionVerdict(v2, "regression-verification-v2").status, "ok");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    schemaVersion: 2,
    outcome: "pass",
    headSha: A,
    baseHeadSha: B,
    gateVerdict: "PASS",
    gateProof: `MERGE GATE: PASS ${B}`,
  }), "regression-verification-v2").status, "invalid");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    schemaVersion: 2,
    outcome: "pass",
    headSha: A,
    baseHeadSha: B,
    gateVerdict: "PASS",
  }), "regression-verification-v2").status, "invalid");
  assert.equal(parseRegressionVerdict(v1, "regression-verification").status, "ok");
  assert.equal(parseRegressionVerdict(v1, "regression-verification-v2").status, "invalid");
  assert.equal(parseRegressionVerdict(v2, "regression-verification").status, "invalid");
});

test("Regression v2 gate failures carry the complete Merge gate verdict", () => {
  const verdict = {
    schemaVersion: 2,
    outcome: "gate-fail",
    headSha: A,
    baseHeadSha: B,
    gateVerdict: "FAIL",
    gateProof: "MERGE GATE: FAIL (unit tests)",
    summary: "unit tests",
  };
  assert.equal(parseRegressionVerdict(JSON.stringify(verdict), "regression-verification-v2").status, "ok");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    schemaVersion: 2,
    outcome: "gate-fail",
    headSha: A,
    baseHeadSha: B,
    gateVerdict: "FAIL",
    summary: "unit tests",
  }), "regression-verification-v2").status, "invalid");
});

test("Regression v2 gate failure excerpts are optional strings", () => {
  const verdict = {
    schemaVersion: 2,
    outcome: "gate-fail",
    headSha: A,
    baseHeadSha: B,
    gateVerdict: "FAIL",
    gateProof: "MERGE GATE: FAIL (unit tests)",
    summary: "unit tests",
  };
  assert.equal(parseRegressionVerdict(JSON.stringify(verdict), "regression-verification-v2").status, "ok");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    ...verdict,
    gateFailureExcerpt: "not ok 1 - packages/db/src/example.test.ts",
  }), "regression-verification-v2").status, "ok");
  for (const gateFailureExcerpt of [null, 42, true, {}, []]) {
    assert.equal(parseRegressionVerdict(JSON.stringify({ ...verdict, gateFailureExcerpt }), "regression-verification-v2").status, "invalid");
  }
});

test("merge train records are versioned and validate the contiguous passing prefix", () => {
  const chainId = "00000000-0000-4000-8000-000000000001";
  const record = {
    schemaVersion: 1,
    baseSha: A,
    width: 3,
    prefixes: [{
      index: 1,
      taskId: "task-1",
      chainId,
      candidateHeadSha: B,
      predecessorOid: A,
      prefixOid: "c".repeat(40),
      ref: `refs/anneal/train/${"c".repeat(40)}`,
      verdict: "pass",
      gateExcerpt: `MERGE GATE: PASS ${"c".repeat(40)}`,
    }],
    blocked: [],
    skipped: [],
    contiguousPassCount: 1,
  };
  const accepted = parseMergeTrainRecord(JSON.stringify(record));
  assert.equal(accepted.status, "ok");
  if (accepted.status === "ok") assert.deepEqual(accepted.record, record);

  const { contiguousPassCount: _missing, ...withoutCount } = record;
  assert.equal(parseMergeTrainRecord(JSON.stringify(withoutCount)).status, "invalid");
  assert.equal(parseMergeTrainRecord(JSON.stringify({
    ...record,
    prefixes: [{ ...record.prefixes[0], verdict: "unknown" }],
  })).status, "invalid");
  assert.equal(parseMergeTrainRecord(JSON.stringify({ ...record, contiguousPassCount: 2 })).status, "invalid");

  const blocked = {
    taskId: "task-blocked",
    chainId,
    candidateHeadSha: "d".repeat(40),
    reason: "merge conflict",
  };
  assert.equal(parseMergeTrainRecord(JSON.stringify({ ...record, blocked: [blocked], skipped: ["task-3"] })).status, "ok");
  assert.equal(parseMergeTrainRecord(JSON.stringify({ ...record, skipped: ["task-3"] })).status, "invalid");
  assert.equal(parseMergeTrainRecord(JSON.stringify({ ...record, blocked: [blocked], skipped: ["task-3", "task-4"] })).status, "invalid");
  assert.equal(parseMergeTrainRecord(JSON.stringify({ ...record, blocked: [blocked, blocked] })).status, "invalid");

  // A pass is an authorization input, so it is only ever accepted with the
  // gate's own proof line for that exact prefix.
  for (const gateExcerpt of [
    "",
    "MERGE GATE: PASS",
    `MERGE GATE: PASS ${"e".repeat(40)}`,
    `noise MERGE GATE: PASS ${"c".repeat(40)}`,
    `MERGE GATE: PASS ${"c".repeat(40)} suffix`,
  ]) {
    assert.equal(parseMergeTrainRecord(JSON.stringify({
      ...record,
      prefixes: [{ ...record.prefixes[0], gateExcerpt }],
    })).status, "invalid", gateExcerpt);
  }
  assert.equal(parseMergeTrainRecord(JSON.stringify({
    ...record,
    prefixes: [{
      ...record.prefixes[0],
      gateExcerpt: `run-gate: noise\nMERGE GATE: PASS ${"c".repeat(40)}\n`,
    }],
  })).status, "ok");
  // A non-pass prefix carries diagnostics, not proof, so no proof is required.
  assert.equal(parseMergeTrainRecord(JSON.stringify({
    ...record,
    prefixes: [{ ...record.prefixes[0], verdict: "no-verdict", gateExcerpt: "GATE NOT RUN" }],
    contiguousPassCount: 0,
  })).status, "ok");
});

test("readiness role is mechanical across template generations and ordinals", () => {
  assert.equal(isMergeReadinessStep({ stepIndex: 6, outputKind: "merge-authorization", taskTemplateName: "direct-engineer-workflow" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 11, outputKind: "merge-authorization", taskTemplateName: "compound-engineer-workflow" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 6, outputKind: "merge-authorization", taskTemplateName: "direct-engineer-workflow-legacy-v1" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 11, outputKind: "merge-authorization", taskTemplateName: "compound-engineer-workflow-legacy-v1" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 7, outputKind: "merge-authorization", taskTemplateName: "direct-engineer-workflow-legacy-pre-adjudication-ckt1" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 12, outputKind: "merge-authorization", taskTemplateName: "compound-engineer-workflow-legacy-pre-adjudication-ckt1" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 1, outputKind: "merge-authorization", taskTemplateName: "unrelated" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 6, outputKind: "approval", taskTemplateName: "direct-engineer-workflow" }), false);
});

test("merge-resolver-opus-medium results are versioned and head-bound", () => {
  assert.equal(parseResolverResult(JSON.stringify({
    schemaVersion: 1, outcome: "resolved", startHeadSha: A, targetHeadSha: B,
    resolvedHeadSha: B, tradeOffs: [], changedTestExpectations: [],
  })).status, "ok");
  for (const body of [undefined, "prose", JSON.stringify({ outcome: "resolved" }), JSON.stringify({
    schemaVersion: 1, outcome: "other", startHeadSha: A, targetHeadSha: B,
  })]) assert.equal(parseResolverResult(body).status, "invalid");
});

test("structured tradeOffs entries are normalised and a rejection names the key that failed", () => {
  const resolved = (tradeOffs: unknown[]) => parseResolverResult(JSON.stringify({
    schemaVersion: 1, outcome: "resolved", startHeadSha: A, targetHeadSha: B,
    resolvedHeadSha: B, tradeOffs, changedTestExpectations: [],
  }));

  // The role prompt asks for "the exact trade-off", which a model renders as an
  // entry per conflicting file. Both readings resolve to the stored string form.
  const parsed = resolved([
    "packages/db/src/merge-tail.ts: kept main's parser",
    { file: "packages/api/src/app.ts", decision: "kept the branch's route", reason: "main never had it", intentPreserved: true },
  ]);
  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.status === "ok" && parsed.result.outcome === "resolved" ? parsed.result.tradeOffs : null, [
    "packages/db/src/merge-tail.ts: kept main's parser",
    "packages/api/src/app.ts: kept the branch's route",
  ]);

  for (const entry of [42, null, ["a"], { file: "a.ts" }, { file: 1, decision: "kept" }]) {
    const rejected = resolved([entry]);
    assert.equal(rejected.status, "invalid", JSON.stringify(entry));
    assert.ok(rejected.status === "invalid" && rejected.reason.includes("tradeOffs"), JSON.stringify(entry));
    assert.equal(rejected.status === "invalid" && rejected.key, "tradeOffs", JSON.stringify(entry));
  }

  const objectExpectation = parseResolverResult(JSON.stringify({
    schemaVersion: 1, outcome: "resolved", startHeadSha: A, targetHeadSha: B,
    resolvedHeadSha: B, tradeOffs: [], changedTestExpectations: [{ file: "a.ts", decision: "kept" }],
  }));
  assert.equal(objectExpectation.status, "invalid");
  assert.equal(objectExpectation.status === "invalid" && objectExpectation.key, "changedTestExpectations");
});

/** Test sources are not merge-tail machinery, so the inventory below skips them. */
const isTestSource = (path: string): boolean => (
  /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/u.test(path)
  || /(?:\.(?:dbtest|test|spec)|-test)\.[^.]+$/u.test(path)
);

test("the defense list covers tracked merge-tail machinery", () => {
  const tracked = execFileSync("git", ["-C", "../..", "ls-files"], { encoding: "utf8" })
    .trim().split("\n");
  const sourcePaths = tracked.filter((path) => (
    /^(?:packages\/api|packages\/db)\/src\/.*\.ts$/u.test(path) && !isTestSource(path)
  ));
  const sourcePatterns = [
    /import\s*(?:type\s*)?\{[^}]*\}\s*from "\.\/merge-tail\.js"/su,
    /\bRegressionRepairHandoff\b/u,
    /\bREGRESSION_VERIFICATION_KIND\b/u,
    /import\s*\{[^}]*\bhandleRegressionCompletion\b[^}]*\}\s*from "\.\/merge-tail-actions\.js"/su,
    /\bmergeTailLeaseChainId\(/u,
  ];
  const structuralPaths = sourcePaths.filter((path) => {
    const source = readFileSync(`../..\/${path}`, "utf8");
    return sourcePatterns.some((pattern) => pattern.test(source));
  });
  const runnerSourcePaths = [
    "packages/runner/runtime-tools/regression-verification.sh",
    "packages/runner/runtime-tools/gate-worker/gate-dispatch.sh",
    "packages/runner/runtime-tools/gate-worker/lib.sh",
    "packages/runner/runtime-tools/gate-worker/mirror-push.sh",
    "packages/runner/runtime-tools/gate-worker/remote-gate.sh",
  ];
  const runnerContractPaths = [
    "packages/runner/scripts/build-runtime-tools.mjs",
    "scripts/deploy/runtime-tool-inventory.mjs",
    "packages/runner/src/workspace.ts",
    "packages/runner/src/adapters.ts",
    "packages/runner/src/adapters/runtime.ts",
  ];

  assert.ok(structuralPaths.length > 0);
  for (const path of [...runnerSourcePaths, ...runnerContractPaths]) {
    assert.ok(tracked.includes(path), `${path} must remain tracked`);
  }
  for (const path of new Set([...structuralPaths, ...runnerSourcePaths, ...runnerContractPaths])) {
    assert.notEqual(defenseListReason(path), null, path);
  }
  assert.equal(defenseListReason("packages/runner/runtime-tools/regression-verification.sh"), "merge-tail-machinery");
  for (const path of runnerSourcePaths.slice(1)) {
    assert.equal(defenseListReason(path), "gate-worker", path);
  }
  for (const path of runnerContractPaths) {
    assert.equal(defenseListReason(path), "merge-tail-machinery", path);
  }
  assert.equal(defenseListReason("apps/web/src/app.tsx"), null);
  assert.equal(defenseListReason("agents/templates/pr-engineer-workflow/01-implementation.md"), "template-step-set");
});

test("renames preserve guarded source identities", () => {
  assert.deepEqual(defenseTriggers([{
    filename: "packages/api/src/reader.ts",
    previousFilename: "packages/api/src/merge-readiness-worker.ts",
    patch: null,
  }]), [{ path: "packages/api/src/merge-readiness-worker.ts", reason: "merge-tail-machinery" }]);
});

test("resolver fallback eligibility preserves explicit refusal and stale bindings in malformed output", () => {
  const start = "a".repeat(40);
  const target = "b".repeat(40);
  for (const body of [undefined, null, "not JSON", "[]", "null", "{}",
    JSON.stringify({ startHeadSha: start, targetHeadSha: target })]) {
    assert.equal(resolverFallbackEligible(body, start, target), true);
  }
  for (const value of [
    { outcome: "unable" },
    { startHeadSha: "c".repeat(40) },
    { targetHeadSha: "c".repeat(40) },
    { startHeadSha: "malformed" },
    { targetHeadSha: "malformed" },
  ]) {
    assert.equal(resolverFallbackEligible(JSON.stringify(value), start, target), false);
  }
});
