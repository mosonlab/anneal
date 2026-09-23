import assert from "node:assert/strict";
import test from "node:test";

import { classifyHeadCheckFailures } from "./ci-failure-recovery.js";
import type { PullRequestSnapshot } from "./github-read.js";

const HEAD = "a".repeat(40);
const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  repository: "acme/widgets", number: 1, state: "OPEN", isDraft: false, merged: false,
  mergeable: "MERGEABLE", mergeStateStatus: "UNSTABLE", baseRefName: "main",
  baseSha: "b".repeat(40), headRefOid: HEAD, headCommitOid: HEAD,
  autoMergeRequest: null, mergeQueueEntry: null, repositoryMergeQueue: null,
  mergedBy: null, mergeCommit: null, requiredCheckNames: [],
  checkContexts: [], checksComplete: true, readAt: new Date().toISOString(), ...overrides,
});

test("all terminal PR-head failures count even when required checks are empty", () => {
  const result = classifyHeadCheckFailures(snapshot({ checkContexts: [
    { __typename: "CheckRun", name: "optional typecheck", status: "COMPLETED", conclusion: "FAILURE",
      detailsUrl: "https://github.com/acme/widgets/actions/runs/1/job/2" },
    { __typename: "StatusContext", context: "external", state: "ERROR" },
    { __typename: "CheckRun", name: "skipped", status: "COMPLETED", conclusion: "SKIPPED" },
    { __typename: "CheckRun", name: "neutral", status: "COMPLETED", conclusion: "NEUTRAL" },
    { __typename: "CheckRun", name: "pending", status: "IN_PROGRESS", conclusion: null },
  ] }), HEAD);
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.deepEqual(result.checks.map((check) => check.name), ["external", "optional typecheck"]);
});

test("pending, skipped and neutral checks do not become terminal failures", () => {
  assert.deepEqual(classifyHeadCheckFailures(snapshot({ checkContexts: [
    { __typename: "CheckRun", name: "pending", status: "IN_PROGRESS", conclusion: null },
    { __typename: "CheckRun", name: "skipped", status: "COMPLETED", conclusion: "SKIPPED" },
    { __typename: "CheckRun", name: "neutral", status: "COMPLETED", conclusion: "NEUTRAL" },
  ] }), HEAD), { kind: "none" });
});

test("missing rollup pages and stale head evidence fail closed", () => {
  assert.match(String((classifyHeadCheckFailures(snapshot({ checksComplete: false }), HEAD) as { reason: string }).reason), /100 contexts/u);
  assert.match(String((classifyHeadCheckFailures(snapshot({ headCommitOid: "c".repeat(40) }), HEAD) as { reason: string }).reason), /authorized head/u);
});
