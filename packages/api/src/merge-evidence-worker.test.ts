import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";

import type { MergeEvidence, PrismaClient } from "@anneal/db";

import { GitHubReadError, type PullRequestReader, type PullRequestSnapshot } from "./github-read.js";
import { renderMergeEvidenceCard, startEvidenceWorker, transientEvidenceError } from "./merge-evidence-worker.js";
import { waitUntil } from "./worker-tick-wait.js";

test("only GitHub transport and deadline errors receive evidence retry", () => {
  assert.equal(transientEvidenceError(new GitHubReadError("deadline", "timeout")), true);
  assert.equal(transientEvidenceError(new GitHubReadError("server unavailable", "transport")), true);
  assert.equal(transientEvidenceError(new GitHubReadError("forbidden", "permission")), false);
  assert.equal(transientEvidenceError(new GitHubReadError("pull request is null", "response")), false);
});

const gateEvidence: MergeEvidence = {
  schemaVersion: 1,
  nonce: "nonce",
  repository: "acme/widgets",
  prNumber: 42,
  headSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "b".repeat(40),
  mergeMethod: "merge",
  requiredChecks: [{ name: "ci/build", conclusion: "SUCCESS" }],
  readAt: new Date(0).toISOString(),
};

const mergeSnapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  repository: "acme/widgets",
  number: 42,
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRefName: "main",
  headRefOid: "a".repeat(40),
  baseSha: "b".repeat(40),
  autoMergeRequest: null,
  mergeQueueEntry: null,
  repositoryMergeQueue: null,
  mergedBy: null,
  mergeCommit: null,
  requiredCheckNames: ["ci/build"],
  checkContexts: [{ __typename: "CheckRun", name: "ci/build", status: "COMPLETED", conclusion: "SUCCESS" }],
  headCommitOid: "a".repeat(40),
  readAt: new Date(0).toISOString(),
  ...overrides,
});

test("a completed merge approval card puts its recommendation first and preserves choice ids", () => {
  const card = renderMergeEvidenceCard(gateEvidence, mergeSnapshot(), "main", "main", "b".repeat(40));

  assert.match(card.body, /^推荐：批准并合并/u);
  assert.deepEqual(card.choices, [
    { id: "approve", label: "批准并合并（推荐）" },
    { id: "reject", label: "打回上一步" },
  ]);
});

test("a failed merge approval card puts reject first and names the failed check", () => {
  const evidence = { ...gateEvidence, requiredChecks: [{ name: "ci/build", conclusion: "FAILURE" }] };
  const snapshot = mergeSnapshot({
    mergeStateStatus: "UNSTABLE",
    checkContexts: [{ __typename: "CheckRun", name: "ci/build", status: "COMPLETED", conclusion: "FAILURE" }],
  });
  const card = renderMergeEvidenceCard(evidence, snapshot, "main", "main", "b".repeat(40));

  assert.match(card.body, /^推荐：打回/u);
  assert.match(card.body, /ci\/build（FAILURE）/u);
  assert.deepEqual(card.choices, [
    { id: "reject", label: "打回上一步（推荐）" },
    { id: "approve", label: "批准并合并" },
  ]);
});

test("a merge approval with no required checks rejects a failed optional check", () => {
  const evidence = { ...gateEvidence, requiredChecks: [] };
  const snapshot = mergeSnapshot({
    mergeStateStatus: "UNSTABLE",
    requiredCheckNames: [],
    checkContexts: [
      { __typename: "CheckRun", name: "ci/optional", status: "COMPLETED", conclusion: "FAILURE" },
    ],
  });
  const card = renderMergeEvidenceCard(evidence, snapshot, "main", "main", "b".repeat(40));

  assert.match(card.body, /^推荐：打回/u);
  assert.match(card.body, /ci\/optional（FAILURE）/u);
  assert.equal(card.choices[0]?.id, "reject");
});

test("a merge approval with no required checks waits on an optional pending check", () => {
  const evidence = { ...gateEvidence, requiredChecks: [] };
  const snapshot = mergeSnapshot({
    requiredCheckNames: [],
    checkContexts: [
      { __typename: "CheckRun", name: "ci/optional", status: "IN_PROGRESS", conclusion: null },
    ],
  });
  const card = renderMergeEvidenceCard(evidence, snapshot, "main", "main", "b".repeat(40));

  assert.match(card.body, /^推荐：等待 CI，先不操作/u);
  assert.match(card.body.split("\n")[0] ?? "", /以 GitHub 当前状态为准/u);
  assert.ok(card.choices.every(({ label }) => !label.endsWith("（推荐）")));
});

test("a merge approval with no required checks describes the passing-check evidence accurately", () => {
  const evidence = { ...gateEvidence, requiredChecks: [] };
  const snapshot = mergeSnapshot({
    requiredCheckNames: [],
    checkContexts: [
      { __typename: "CheckRun", name: "ci/optional", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
  });
  const card = renderMergeEvidenceCard(evidence, snapshot, "main", "main", "b".repeat(40));

  assert.match(card.body, /^推荐：批准并合并/u);
  assert.match(card.body, /检查全部通过（本仓库无必需检查）/u);
  assert.doesNotMatch(card.body.split("\n")[0] ?? "", /必需检查全部通过/u);
});

test("a merge approval card recommends reject when Regression's base is stale", () => {
  const card = renderMergeEvidenceCard(gateEvidence, mergeSnapshot(), "main", "main", "c".repeat(40));

  assert.match(card.body, /^推荐：打回/u);
  assert.match(card.body, /Regression base.*落后/u);
  assert.equal(card.choices[0]?.id, "reject");
  assert.match(card.choices[0]?.label ?? "", /（推荐）$/u);
});

test("a pending merge approval card says to wait without recommending an answer", () => {
  const evidence = { ...gateEvidence, requiredChecks: [{ name: "ci/build", conclusion: "PENDING:IN_PROGRESS" }] };
  const snapshot = mergeSnapshot({
    checkContexts: [{ __typename: "CheckRun", name: "ci/build", status: "IN_PROGRESS", conclusion: null }],
  });
  const card = renderMergeEvidenceCard(evidence, snapshot, "main", "main", "b".repeat(40));

  assert.match(card.body, /^推荐：等待 CI，先不操作/u);
  assert.deepEqual(card.choices.map(({ id, label }) => ({ id, label })), [
    { id: "approve", label: "批准并合并" },
    { id: "reject", label: "打回上一步" },
  ]);
});

test("a DIRTY confirmation card recommends reject and puts it first", () => {
  const snapshot = mergeSnapshot({ mergeStateStatus: "DIRTY" });
  const card = renderMergeEvidenceCard(gateEvidence, snapshot, "main", "main", "b".repeat(40));

  assert.match(card.body, /^推荐：打回/u);
  assert.deepEqual(card.choices, [
    { id: "reject", label: "打回上一步（推荐）" },
    { id: "approve", label: "批准并合并" },
  ]);
});

/**
 * A tick reads GitHub up to three times under an 8 s deadline, which is longer
 * than the 2 s poll interval. Before the in-flight guard the second interval
 * fired into the first tick's GitHub reads; this pins that it no longer does.
 */
test("a second evidence tick is skipped while the first is still in flight", async () => {
  const previousInterval = process.env.MERGE_EVIDENCE_POLL_INTERVAL_MS;
  process.env.MERGE_EVIDENCE_POLL_INTERVAL_MS = "250";
  after(() => {
    if (previousInterval === undefined) delete process.env.MERGE_EVIDENCE_POLL_INTERVAL_MS;
    else process.env.MERGE_EVIDENCE_POLL_INTERVAL_MS = previousInterval;
  });

  let ticks = 0;
  let releaseFirstTick = (): void => {};
  const firstTickHeld = new Promise<void>((resolve) => { releaseFirstTick = resolve; });
  const db = {
    inboxMessage: {
      findMany: async () => {
        ticks += 1;
        // Hold the first tick open across several interval firings; later ticks
        // return immediately so the guard is observably released, not stuck.
        if (ticks === 1) await firstTickHeld;
        return [];
      },
    },
  } as unknown as PrismaClient;
  const reader = {} as unknown as PullRequestReader;

  const timer = startEvidenceWorker(db, reader);
  try {
    await waitUntil(() => ticks >= 1, "the evidence worker did not start");
    await delay(750);
    assert.equal(ticks, 1, "the interval fired repeatedly but only one tick may run at a time");
    releaseFirstTick();
    await waitUntil(() => ticks > 1, "the guard was never cleared, so no later tick ran");
  } finally {
    releaseFirstTick();
    if (timer) clearInterval(timer);
  }
});
