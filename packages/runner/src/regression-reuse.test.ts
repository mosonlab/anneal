import assert from "node:assert/strict";
import test from "node:test";

import type { ClaimedTask } from "./api.js";
import { semanticReuseSourceFor } from "./regression-reuse.js";
import type { Workspace } from "./workspace.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const RUN = "recovery-run";
const SOURCE_RUN = "source-run";

const claim = (overrides: Partial<ClaimedTask> = {}): ClaimedTask => ({
  executionMode: "agent",
  specificationMaterialization: null,
  task: {
    id: "task",
    chainId: "chain",
    chainIndex: 2,
    chainLayer: 2,
    name: "Regression verification",
    description: "verify",
    repoId: "repo",
    targetBranch: "main",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxSessionsPerTask: 3,
    templateStep: {
      name: "Regression verification",
      outputKind: "regression-verification-v2",
      provisionDependencies: false,
      taskTemplate: { name: "workflow" },
    },
  },
  agent: { id: "agent", name: "agent", model: "model", foundationalPrompt: "", rolePrompt: "", disabledTools: [] },
  repo: { id: "repo", remoteUrl: "remote", defaultBranch: "main", mountPath: "/unused", dependencyProvisioning: "NONE" },
  run: {
    id: RUN,
    taskId: "task",
    runNumber: 2,
    opensPullRequest: false,
    requiresCommit: false,
    pullRequestBase: "main",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxRunsPerTask: 3,
    model: "model",
    codexServiceTier: "DEFAULT",
    subagentModel: null,
    subagentMaxConcurrent: null,
    targetBranch: "main",
    targetBranchPublished: false,
    pinnedBaseSha: null,
    implementationBaseSha: null,
    implementationHeadSha: null,
    promptHash: null,
    workspacePath: null,
    branch: "agentos/task/run-2",
    baseSha: HEAD,
  },
  session: { id: "session" },
  runner: "CLAUDE",
  fencingToken: "fence",
  sessionToken: "session-token",
  secrets: {},
  priorOutputs: [],
  operatorNotes: [],
  previousRunHandoff: null,
  regressionRepairHandoff: null,
  regressionRecoveryContext: {
    state: "queued",
    currentBaseSha: BASE,
    authorizedHeadSha: HEAD,
    recoveryRunId: RUN,
    priorOutput: {
      runId: SOURCE_RUN,
      kind: "regression-verification-v2",
      body: JSON.stringify({
        schemaVersion: 2,
        outcome: "pass",
        headSha: HEAD,
        baseHeadSha: "c".repeat(40),
        gateVerdict: "PASS",
        gateProof: `MERGE GATE: PASS ${HEAD}`,
      }),
      commitSha: HEAD,
    },
  },
  resume: null,
  nextEventSeq: 0,
  ...overrides,
});

const workspace: Workspace = { path: "/workspace", branch: "agentos/task/run-2", baseSha: HEAD };

test("selects an exact-head current-Run v2 semantic source", () => {
  assert.deepEqual(semanticReuseSourceFor(claim(), workspace), {
    outputKind: "regression-verification-v2",
    runId: SOURCE_RUN,
    headSha: HEAD,
  });
});

test("selects a v2 gate-fail because the semantic verdict already passed", () => {
  const input = claim();
  input.regressionRecoveryContext!.priorOutput!.body = JSON.stringify({
    schemaVersion: 2,
    outcome: "gate-fail",
    headSha: HEAD,
    baseHeadSha: BASE,
    gateVerdict: "FAIL",
    gateProof: "MERGE GATE: FAIL (unit)",
    summary: "The semantic review passed before the merge gate failed.",
    gateFailureExcerpt: "unit failed",
  });
  assert.equal(semanticReuseSourceFor(input, workspace)?.outputKind, "regression-verification-v2");
});

test("selects the v3 semantic-pass generation", () => {
  const input = claim();
  input.task.templateStep!.outputKind = "regression-verification-v3";
  input.regressionRecoveryContext!.priorOutput = {
    runId: SOURCE_RUN,
    kind: "regression-verification-v3",
    body: JSON.stringify({ schemaVersion: 3, outcome: "semantic-pass", headSha: HEAD, baseHeadSha: BASE }),
    commitSha: HEAD,
  };
  assert.equal(semanticReuseSourceFor(input, workspace)?.outputKind, "regression-verification-v3");
});

test("rejects v3 semantic-pass carrying merge gate evidence", () => {
  for (const gateEvidence of [
    { gateVerdict: "PASS" },
    { gateProof: `MERGE GATE: PASS ${HEAD}` },
  ]) {
    const input = claim();
    input.task.templateStep!.outputKind = "regression-verification-v3";
    input.regressionRecoveryContext!.priorOutput = {
      runId: SOURCE_RUN,
      kind: "regression-verification-v3",
      body: JSON.stringify({
        schemaVersion: 3,
        outcome: "semantic-pass",
        headSha: HEAD,
        baseHeadSha: BASE,
        ...gateEvidence,
      }),
      commitSha: HEAD,
    };
    assert.equal(semanticReuseSourceFor(input, workspace), null);
  }
});

test("rejects stale Run, head, CI finding, resume, repair, and negative semantic evidence", () => {
  const cases: ClaimedTask[] = [];
  const staleRun = claim();
  staleRun.regressionRecoveryContext!.recoveryRunId = "other-run";
  cases.push(staleRun);
  const staleHead = claim();
  staleHead.regressionRecoveryContext!.authorizedHeadSha = "d".repeat(40);
  cases.push(staleHead);
  const ci = claim();
  ci.regressionRecoveryContext!.ciFailures = [{ name: "test", conclusion: "failure", log: "failed" }];
  cases.push(ci);
  const malformedCi = claim();
  (malformedCi.regressionRecoveryContext as unknown as { ciFailures: unknown }).ciFailures = "not-an-array";
  cases.push(malformedCi);
  cases.push(claim({ resume: { providerConversationId: "conversation", input: "continue" } }));
  cases.push(claim({ regressionRepairHandoff: {} as ClaimedTask["regressionRepairHandoff"] }));
  const negative = claim();
  negative.regressionRecoveryContext!.priorOutput!.body = JSON.stringify({
    schemaVersion: 2, outcome: "review-fail", headSha: HEAD, baseHeadSha: BASE, summary: "defect",
  });
  cases.push(negative);
  const staleSource = claim();
  staleSource.regressionRecoveryContext!.priorOutput!.commitSha = "f".repeat(40);
  cases.push(staleSource);
  const selfSource = claim();
  selfSource.regressionRecoveryContext!.priorOutput!.runId = RUN;
  cases.push(selfSource);
  const wrongRunBase = claim();
  wrongRunBase.run.baseSha = "1".repeat(40);
  cases.push(wrongRunBase);
  const partialV3 = claim();
  partialV3.regressionRecoveryContext!.priorOutput = {
    runId: SOURCE_RUN,
    kind: "regression-verification-v3",
    body: JSON.stringify({
      schemaVersion: 3,
      outcome: "semantic-pass",
      headSha: HEAD,
      baseHeadSha: BASE,
      semanticVerdict: "reused",
    }),
    commitSha: HEAD,
  };
  cases.push(partialV3);
  for (const input of cases) assert.equal(semanticReuseSourceFor(input, workspace), null);
  assert.equal(semanticReuseSourceFor(claim(), { ...workspace, baseSha: "e".repeat(40) }), null);
});
