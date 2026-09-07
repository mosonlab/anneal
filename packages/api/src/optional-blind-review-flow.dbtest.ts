import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { RunStatus, TaskStatus } from "@anneal/db";

import type { PullRequestReader, PullRequestSnapshot } from "./github-read.js";
import { withMergeLease, type ReleaseMergeLease, type WithMergeLease } from "./merge-lease.js";
import { executorsOnline } from "./merge-executor-daemon-fixture.js";
import { readinessTick } from "./merge-readiness-worker.js";
import {
  IMPLEMENTATION_BASE,
  IMPLEMENTATION_HEAD,
  installParallelReviewLifecycle,
} from "./parallel-review-fixture.js";
import { createApp } from "./test-app.js";


const {
  db,
  claim,
  complete,
  completeImplementation,
  completeReview,
  instantiateOptionalDirect,
} = installParallelReviewLifecycle();

const DEFAULT_HEAD = "3".repeat(40);
const SOL_FINDING = {
  id: "OPTIONAL-SOL-1",
  severity: "P2" as const,
  file: "packages/api/src/templates.ts",
  line: 1,
  title: "Exercise sole-report disposition coverage",
  evidence: "The optional blind-review flow must account for findings from the code review report.",
  requiredFix: "Submit exactly one disposition for this finding.",
};

const snapshot = (): PullRequestSnapshot => ({
  repository: "example/optional-review",
  number: 314,
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRefName: "main",
  baseSha: DEFAULT_HEAD,
  headRefOid: IMPLEMENTATION_HEAD,
  headCommitOid: IMPLEMENTATION_HEAD,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  repositoryMergeQueue: null,
  mergedBy: null,
  mergeCommit: null,
  requiredCheckNames: ["ci/test"],
  checkContexts: [{ __typename: "CheckRun", name: "ci/test", status: "COMPLETED", conclusion: "SUCCESS" }],
  readAt: new Date().toISOString(),
});

const reader: PullRequestReader = {
  readPullRequest: async () => snapshot(),
  compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
};
const releaseLease: ReleaseMergeLease = async () => {};
const runWithMergeLease: WithMergeLease = (target, fn, database) => withMergeLease(target, fn, database, {
  acquire: async () => ({ outcome: "acquired" }),
  release: async () => ({
    outcome: "released",
    ref: "refs/merge-lease/optional-review",
    sha: "lease-optional-review",
    acquiredAt: new Date().toISOString(),
  }),
});

test("a direct chain without blind review advances through fixes and regression to merge execution", async () => {
  const fixture = await instantiateOptionalDirect();
  const implementation = await completeImplementation(fixture, "optional-implementation");
  await db.run.update({ where: { id: implementation.run.id }, data: {
    pullRequestNumber: 314,
    pullRequestUrl: "https://github.com/example/optional-review/pull/314",
  } });

  const sol = await claim("optional-sol");
  assert.equal(sol.run.taskId, fixture.solTaskId);
  assert.deepEqual(sol.priorOutputs.map(({ kind }) => kind), ["implementation"]);
  await completeReview(sol, "optional-sol", "review-findings", [SOL_FINDING]);

  const fix = await claim("optional-fix");
  assert.equal(fix.run.taskId, fixture.fixTaskId);
  assert.deepEqual(fix.priorOutputs.map(({ kind }) => kind), ["review-findings"]);
  const writeFixedOutput = (body: Record<string, unknown>) => createApp(db).request(`/session/runs/${fix.run.id}/output`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${fix.sessionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fencingToken: fix.fencingToken,
      kind: "fixed-implementation",
      body: JSON.stringify(body),
      commitSha: IMPLEMENTATION_HEAD,
    }),
  });
  const fixedBody = {
      schemaVersion: 1,
      headSha: IMPLEMENTATION_HEAD,
      sourceHead: IMPLEMENTATION_HEAD,
      testsRun: ["npm test -- optional blind review"],
      residualRisks: [],
  };
  let fixedOutput = await writeFixedOutput({ ...fixedBody, dispositions: [], closedFindings: [] });
  assert.equal(fixedOutput.status, 409);
  assert.match(await fixedOutput.text(), /missing: OPTIONAL-SOL-1/u);

  fixedOutput = await writeFixedOutput({
    ...fixedBody,
    dispositions: [{ id: SOL_FINDING.id, disposition: "ADOPTED", reason: "The flow must prove Sol-only coverage." }],
    closedFindings: [{
      id: SOL_FINDING.id,
      status: "CLOSED",
      codeEvidence: "The fixed output accounts for the sole Sol finding.",
      testEvidence: "The preceding output write without the disposition is refused.",
    }],
  });
  assert.equal(fixedOutput.status, 200, await fixedOutput.text());

  const fixed = await complete(fix, "optional-fix");
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));

  const regression = await claim("optional-regression");
  assert.equal(regression.run.taskId, fixture.regressionTaskId);
  assert.deepEqual(
    regression.priorOutputs.map(({ kind }) => kind),
    ["implementation", "review-findings", "fixed-implementation"],
  );
  const regressionResult = await complete(regression, "optional-regression", {
    outputKind: "regression-verification-v2",
    output: {
      schemaVersion: 2,
      outcome: "pass",
      headSha: IMPLEMENTATION_HEAD,
      baseHeadSha: DEFAULT_HEAD,
      gateVerdict: "PASS",
      gateProof: `MERGE GATE: PASS ${IMPLEMENTATION_HEAD}`,
    },
  });
  assert.equal(regressionResult.status, 200, JSON.stringify(regressionResult.body));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.regressionTaskId } })).status, TaskStatus.DONE);

  const readiness = await readinessTick(db, reader, new Date(), 5, releaseLease, runWithMergeLease, executorsOnline);
  assert.deepEqual(readiness, { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.readinessTaskId } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: fixture.mergeTaskId, status: RunStatus.QUEUED } }), 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.mergeTaskId } })).status, TaskStatus.TODO);

  assert.equal(await db.task.count({
    where: { chainId: fixture.chainId, templateStep: { outputKind: "blind-findings" } },
  }), 0);
  assert.equal(await db.taskStepOutput.count({ where: { kind: "blind-findings", task: { chainId: fixture.chainId } } }), 0);
  assert.equal(await db.taskStepOutput.count({ where: { kind: "review-findings", task: { chainId: fixture.chainId } } }), 1);
  assert.equal(await db.taskStepOutput.count({ where: { kind: "fixed-implementation", task: { chainId: fixture.chainId } } }), 1);
  assert.equal(await db.taskStepOutput.count({ where: { kind: "regression-verification-v2", task: { chainId: fixture.chainId } } }), 1);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId, status: RunStatus.SUCCEEDED } }), 1);
  assert.equal(await db.run.count({ where: { taskId: fixture.regressionTaskId, status: RunStatus.SUCCEEDED } }), 1);
  assert.notEqual(IMPLEMENTATION_BASE, IMPLEMENTATION_HEAD);
});
