import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateRefusalCodes,
  classifyCandidate,
  classifyDurable,
  classifyFresh,
  classifyRetryBudget,
  recoveryDeferred,
  type DurableCandidateFacts,
  type FreshRecoveryFacts,
  type RecoveryCandidate,
  type RecoveryPullRequestFacts,
  type RetryBudgetDecision,
  type RetryBudgetFacts,
  type RetryBudgetPolicy,
  type RetryClass,
} from "./base-drift-recovery-decision.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CURRENT = "c".repeat(40);

const candidate: RecoveryCandidate = {
  integratorTaskId: "integrator-1",
  readinessTaskId: "readiness-1",
  regressionTaskId: "regression-1",
  sourceRunId: "run-1",
  stopId: "stop-1",
  authorizationActivityId: "authorization-1",
  repository: "acme/widgets",
  prNumber: 123,
  targetBranch: "main",
  authorizedHeadSha: HEAD,
  authorizedBaseSha: BASE,
  observedBaseSha: CURRENT,
};

const snapshot = (overrides: Partial<RecoveryPullRequestFacts> = {}): RecoveryPullRequestFacts => ({
  repository: candidate.repository,
  number: candidate.prNumber,
  state: "OPEN",
  isDraft: false,
  merged: false,
  baseRefName: candidate.targetBranch,
  baseSha: CURRENT,
  headRefOid: HEAD,
  headCommitOid: HEAD,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  ...overrides,
});

type SnapshotFacts = Extract<FreshRecoveryFacts, { kind: "snapshot" }>;

const freshDecision = (overrides: Partial<SnapshotFacts> = {}) => classifyFresh({
  kind: "snapshot",
  candidate,
  snapshot: snapshot(),
  comparisonAvailable: true,
  authorizedAdvance: { status: "ahead", behindBy: 0 },
  observedAdvance: null,
  ...overrides,
});

const durableFacts = (): DurableCandidateFacts => ({
  task: {
    id: candidate.integratorTaskId,
    chainId: "chain-1",
    chainIndex: 3,
    repoId: "repo-1",
    repositoryPresent: true,
    status: "REVIEW",
    isIntegratorStep: true,
  },
  stop: {
    stopId: candidate.stopId,
    condition: "base-drift",
    evidence: JSON.stringify({ observed: CURRENT, authorized: BASE }),
    sourceRunId: candidate.sourceRunId,
  },
  existingAttempt: null,
  sourceRun: {
    id: candidate.sourceRunId,
    taskId: candidate.integratorTaskId,
    status: "SUCCEEDED",
    hasSession: true,
  },
  activeRunCount: 0,
  output: {
    runId: candidate.sourceRunId,
    kind: "merge-result",
    outcome: "stopped",
    condition: "base-drift",
    evidence: JSON.stringify({ observed: CURRENT, authorized: BASE }),
  },
  readiness: {
    id: candidate.readinessTaskId,
    status: "DONE",
    isReadinessStep: true,
    outputCommitSha: HEAD,
  },
  regression: { id: candidate.regressionTaskId, status: "DONE" },
  authorizationSelection: {
    authorization: {
      activityId: candidate.authorizationActivityId,
      repository: candidate.repository,
      prNumber: candidate.prNumber,
      headSha: HEAD,
      baseSha: BASE,
      baseRef: candidate.targetBranch,
    },
    refusal: null,
  },
  intents: [{
    sourceRunId: candidate.sourceRunId,
    authorizationActivityId: candidate.authorizationActivityId,
    prNumber: candidate.prNumber,
    headSha: HEAD,
  }],
  target: { resolved: true, repository: candidate.repository, prNumber: candidate.prNumber },
  firstRunTargetRef: candidate.targetBranch,
});

test("durable candidate facts decide every refusal without a database", () => {
  const cases: Array<{
    code: typeof candidateRefusalCodes[number];
    reason: string;
    change: (facts: DurableCandidateFacts) => void;
  }> = [
    { code: "identity-incomplete", reason: "chain or repository identity is incomplete", change: (facts) => { facts.task!.chainId = null; } },
    { code: "source-run-unbound", reason: "stop is not bound to an executor run", change: (facts) => { facts.stop!.sourceRunId = null; } },
    { code: "evidence-invalid", reason: "base-drift evidence is malformed or is not a SHA-only drift payload", change: (facts) => { facts.stop!.evidence = "{}"; } },
    { code: "source-run-mismatch", reason: "source executor run identity or terminal state does not match the stop", change: (facts) => { facts.sourceRun!.hasSession = false; } },
    { code: "chain-active", reason: "the chain has an active foreign run while recovery is being classified", change: (facts) => { facts.activeRunCount = 1; } },
    { code: "output-mismatch", reason: "executor output does not exactly match the recorded source stop", change: (facts) => { facts.output!.runId = "run-2"; } },
    { code: "tail-unresolved", reason: "current direct/compound regression and readiness tail cannot be resolved", change: (facts) => { facts.readiness = null; } },
    { code: "tail-state-mismatch", reason: "merge tail task state is not the completed-readiness/stopped-executor shape", change: (facts) => { facts.regression!.status = "TODO"; } },
    { code: "authorization-invalid", reason: "authorized readiness evidence is ambiguous-tie", change: (facts) => { facts.authorizationSelection = { authorization: null, refusal: "ambiguous-tie" }; } },
    { code: "intent-count", reason: "source executor run has multiple server-bound merge intents", change: (facts) => { facts.intents!.push({ ...facts.intents![0] }); } },
    { code: "intent-mismatch", reason: "executor intent does not match the selected authorization", change: (facts) => { facts.intents![0]!.headSha = "d".repeat(40); } },
    { code: "authorized-base-mismatch", reason: "stop evidence does not match the authorized base SHA", change: (facts) => { facts.authorizationSelection!.authorization!.baseSha = "d".repeat(40); } },
    { code: "readiness-head-mismatch", reason: "readiness output does not match the authorized head SHA", change: (facts) => { facts.readiness!.outputCommitSha = "d".repeat(40); } },
    { code: "target-unresolved", reason: "pull-request identity is repository", change: (facts) => { facts.target = { resolved: false, unresolvable: "repository" }; } },
    { code: "target-mismatch", reason: "resolved repository or pull-request identity differs from the authorization", change: (facts) => { facts.target = { resolved: true, repository: candidate.repository, prNumber: 124 }; } },
    { code: "target-branch-mismatch", reason: "chain first-run target ref differs from the authorized base ref", change: (facts) => { facts.firstRunTargetRef = "release"; } },
  ];
  assert.equal(cases.length, candidateRefusalCodes.length);
  assert.deepEqual(cases.map(({ code }) => code), [...candidateRefusalCodes]);
  for (const refusal of cases) {
    const facts = durableFacts();
    refusal.change(facts);
    assert.deepEqual(classifyCandidate(facts), refusal.code === "chain-active"
      ? { kind: "retry", retryClass: "waiting", code: refusal.code, reason: refusal.reason, stopId: candidate.stopId }
      : { kind: "ineligible", code: refusal.code, reason: refusal.reason, stopId: candidate.stopId });
  }
});

test("durable candidate classification narrows skip and inspect outcomes", () => {
  const missingTask = durableFacts();
  missingTask.task = null;
  assert.deepEqual(classifyCandidate(missingTask), { kind: "skip" });
  const terminalAttempt = durableFacts();
  terminalAttempt.existingAttempt = { status: "FAILED", reopenableLegacyRefusal: false, nextEligibleAt: null };
  assert.deepEqual(classifyCandidate(terminalAttempt), { kind: "skip" });
  assert.deepEqual(classifyCandidate(durableFacts()), { kind: "inspect", candidate });
});

test("all fresh pull-request refusal paths decide without a database", () => {
  const cases: Array<[string, Partial<RecoveryPullRequestFacts>, RegExp]> = [
    ["identity", { number: 124 }, /identity mismatches/u],
    ["state", { state: "CLOSED" }, /no longer an unmerged OPEN/u],
    ["draft", { isDraft: true }, /draft state changed/u],
    ["foreign merge", { autoMergeRequest: { enabledAt: "now", mergeMethod: "MERGE" } }, /automatic merge machinery/u],
    ["target", { baseRefName: "release" }, /target ref changed/u],
    ["head", { headRefOid: "d".repeat(40) }, /head changed/u],
    ["base", { baseSha: BASE }, /does not prove an advanced SHA/u],
  ];
  for (const [label, current, reason] of cases) {
    const decision = freshDecision({ snapshot: snapshot(current) });
    assert.equal(decision.kind, "ineligible", label);
    assert.match(decision.kind === "ineligible" ? decision.reason : "", reason, label);
  }
});

test("fresh classification narrows reader facts and snapshot outcomes", () => {
  assert.deepEqual(classifyFresh({ kind: "reader-failure", reason: "reader timeout" }), {
    kind: "retry",
    retryClass: "transport",
    reason: "reader timeout",
  });
  assert.equal(freshDecision({ comparisonAvailable: false }).kind, "ineligible");
  assert.equal(freshDecision({ authorizedAdvance: { status: "diverged", behindBy: 1 } }).kind, "ineligible");
  assert.equal(freshDecision({
    candidate: { ...candidate, observedBaseSha: "d".repeat(40) },
    observedAdvance: { status: "behind", behindBy: 1 },
  }).kind, "ineligible");
  assert.deepEqual(freshDecision(), { kind: "queue", candidate, currentBaseSha: CURRENT });
});

const POLICY: RetryBudgetPolicy = {
  maxValidationAttempts: 30,
  validationMinElapsedMs: 30 * 60_000,
  waitingCeilingMs: 6 * 60 * 60_000,
  transportCeilingMs: 30 * 60_000,
  backoffStartMs: 2_000,
  backoffCapMs: 60_000,
};

const T0 = new Date("2026-09-01T00:00:00.000Z");
const at = (milliseconds: number): Date => new Date(T0.getTime() + milliseconds);

const budget = (
  retryClass: RetryClass,
  overrides: Partial<RetryBudgetFacts> = {},
): RetryBudgetDecision => classifyRetryBudget({
  reason: `${retryClass} failure`,
  retryClass,
  now: T0,
  attempts: { waiting: 0, transport: 0, validation: 0 },
  firstFailedAt: { waiting: null, transport: null, validation: null },
  policy: POLICY,
  ...overrides,
});

test("only validation failures spend the counted budget", () => {
  // Forty consecutive waits and a hundred transport failures are not evidence
  // about the candidate, so neither the count nor the other classes move.
  const waiting = budget("waiting", {
    attempts: { waiting: 40, transport: 0, validation: 0 },
    firstFailedAt: { waiting: at(-5 * 60_000), transport: null, validation: null },
  });
  assert.equal(waiting.kind, "retry");
  assert.equal(waiting.kind === "retry" ? waiting.classAttempt : 0, 41);
  const transport = budget("transport", {
    attempts: { waiting: 0, transport: 100, validation: 29 },
    firstFailedAt: { waiting: null, transport: at(-60_000), validation: at(-60_000) },
  });
  assert.equal(transport.kind, "retry");
  assert.equal(transport.kind === "retry" ? transport.retryClass : "waiting", "transport");
});

test("each retry class holds the next tick on a doubling backoff capped at a minute", () => {
  const holds = [1, 2, 3, 4, 5, 6, 7, 40].map((attempt) => {
    const decision = budget("waiting", {
      attempts: { waiting: attempt - 1, transport: 0, validation: 0 },
      firstFailedAt: { waiting: at(-60_000), transport: null, validation: null },
    });
    assert.equal(decision.kind, "retry");
    return decision.kind === "retry" ? decision.nextEligibleAt.getTime() - T0.getTime() : -1;
  });
  assert.deepEqual(holds, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
});

test("waiting and transport end only by outlasting their own ceilings", () => {
  const waitingHeld = budget("waiting", {
    attempts: { waiting: 400, transport: 0, validation: 0 },
    firstFailedAt: { waiting: at(-POLICY.waitingCeilingMs + 1_000), transport: null, validation: null },
  });
  assert.equal(waitingHeld.kind, "retry");
  const waitingCeiling = budget("waiting", {
    attempts: { waiting: 400, transport: 0, validation: 0 },
    firstFailedAt: { waiting: at(-POLICY.waitingCeilingMs), transport: null, validation: null },
  });
  assert.equal(waitingCeiling.kind, "ineligible");
  assert.equal(waitingCeiling.retryClass, "waiting");
  assert.match(waitingCeiling.reason, /^waiting-ceiling reached: the chain stayed active for 6h00m \(limit 6h00m\)/u);

  const transportHeld = budget("transport", {
    attempts: { waiting: 0, transport: 3, validation: 0 },
    firstFailedAt: { waiting: null, transport: at(-POLICY.transportCeilingMs + 1_000), validation: null },
  });
  assert.equal(transportHeld.kind, "retry");
  const transportCeiling = budget("transport", {
    attempts: { waiting: 0, transport: 3, validation: 0 },
    firstFailedAt: { waiting: null, transport: at(-POLICY.transportCeilingMs), validation: null },
  });
  assert.equal(transportCeiling.kind, "ineligible");
  assert.match(transportCeiling.reason, /^transport-ceiling reached: repository reads failed for 30m/u);
});

test("validation exhausts on the count and the elapsed time together, never on either alone", () => {
  const burst = budget("validation", {
    attempts: { waiting: 0, transport: 0, validation: 29 },
    firstFailedAt: { waiting: null, transport: null, validation: at(-5 * 60_000) },
  });
  assert.equal(burst.kind, "retry", "thirty failures inside five minutes are one incident");
  const slowButFew = budget("validation", {
    attempts: { waiting: 0, transport: 0, validation: 3 },
    firstFailedAt: { waiting: null, transport: null, validation: at(-31 * 60_000) },
  });
  assert.equal(slowButFew.kind, "retry", "four failures over half an hour are not a budget");
  const exhausted = budget("validation", {
    attempts: { waiting: 0, transport: 0, validation: 29 },
    firstFailedAt: { waiting: null, transport: null, validation: at(-31 * 60_000) },
  });
  assert.equal(exhausted.kind, "ineligible");
  assert.equal(exhausted.retryClass, "validation");
  assert.match(exhausted.reason, /^validation-budget exhausted: 30 classification failures over 31m/u);
});

test("a class that has never failed measures its elapsed time from this tick", () => {
  const first = budget("transport");
  assert.equal(first.kind, "retry");
  if (first.kind !== "retry") return;
  assert.equal(first.firstFailedAt.getTime(), T0.getTime());
  assert.equal(first.elapsedMs, 0);
  assert.equal(first.classAttempt, 1);
});

test("a stored backoff defers a validating attempt and nothing else", () => {
  const deferred = durableFacts();
  deferred.existingAttempt = { status: "VALIDATING", reopenableLegacyRefusal: false, nextEligibleAt: at(1) };
  assert.equal(recoveryDeferred(deferred, T0), true);
  assert.equal(recoveryDeferred(deferred, at(1)), false, "eligibility is inclusive of its own instant");
  const settled = durableFacts();
  settled.existingAttempt = { status: "FAILED", reopenableLegacyRefusal: false, nextEligibleAt: at(60_000) };
  assert.equal(recoveryDeferred(settled, T0), false);
  assert.equal(recoveryDeferred(durableFacts(), T0), false);
});

test("durable classification narrows skip, retry, ineligible, exhausted, and queue outcomes", () => {
  assert.equal(classifyDurable({
    expected: candidate,
    candidateDecision: { kind: "inspect", candidate },
    aggregateValidating: true,
    recoveryCount: 2,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }).kind, "exhausted");
  assert.deepEqual(classifyDurable({
    expected: candidate,
    candidateDecision: { kind: "inspect", candidate },
    aggregateValidating: false,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }), { kind: "skip" });
  assert.equal(classifyDurable({
    expected: candidate,
    candidateDecision: {
      kind: "retry",
      retryClass: "waiting",
      code: "chain-active",
      stopId: candidate.stopId,
      reason: "the chain has an active foreign run while recovery is being classified",
    },
    aggregateValidating: true,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }).kind, "retry");
  assert.equal(classifyDurable({
    expected: candidate,
    candidateDecision: { kind: "inspect", candidate: { ...candidate, sourceRunId: "run-2" } },
    aggregateValidating: true,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }).kind, "ineligible");
  assert.deepEqual(classifyDurable({
    expected: candidate,
    candidateDecision: { kind: "inspect", candidate },
    aggregateValidating: true,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }), { kind: "queue", candidate, currentBaseSha: CURRENT });
});
