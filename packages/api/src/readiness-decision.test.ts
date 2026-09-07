import assert from "node:assert/strict";
import test from "node:test";

import type { MergeEvidence } from "@anneal/db";

import { evaluateReadiness, type ReadinessInput } from "./readiness-decision.js";
import { GitHubReadError, type PullRequestReader, type PullRequestSnapshot } from "./github-read.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TRAIN_BASE = "c".repeat(40);
const NOW = new Date("2026-08-26T12:00:00.000Z");

const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  repository: "mosonlab/agentos",
  number: 42,
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRefName: "main",
  headRefOid: HEAD,
  baseSha: BASE,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  repositoryMergeQueue: null,
  mergedBy: null,
  mergeCommit: null,
  requiredCheckNames: [],
  checkContexts: [],
  headCommitOid: HEAD,
  readAt: NOW.toISOString(),
  ...overrides,
});

const evidence: MergeEvidence = {
  schemaVersion: 1,
  nonce: "nonce",
  repository: "mosonlab/agentos",
  prNumber: 42,
  headSha: HEAD,
  baseRef: "main",
  baseSha: BASE,
  mergeMethod: "merge",
  requiredChecks: [],
  readAt: NOW.toISOString(),
};

const context = {
  readiness: { id: "readiness-1", chainId: "chain-1", projectId: "project-1", repoId: "repo-1" },
  now: NOW,
} as const;

const ready = (): Extract<ReadinessInput, { stage: "ready" }> => ({
  ...context,
  stage: "ready",
  regression: { headSha: HEAD, baseHeadSha: BASE },
  target: { resolved: true, repository: "mosonlab/agentos", prNumber: 42 },
  defaultBranch: "main",
});

const trainReady = (): Extract<ReadinessInput, { stage: "ready" }> => ({
  ...ready(),
  train: { baseSha: TRAIN_BASE, candidateHeadSha: HEAD },
});

type Comparison = Awaited<ReturnType<NonNullable<PullRequestReader["compareCommits"]>>>;

const compared: Comparison = {
  status: "ahead",
  behindBy: 0,
  filesComplete: true,
  files: [],
};

const reader = (values: {
  snapshot?: PullRequestSnapshot;
  comparison?: Comparison;
} = {}): PullRequestReader => ({
  readPullRequest: async () => values.snapshot ?? snapshot(),
  compareCommits: async () => values.comparison ?? compared,
});

test("authorize carries the exact head evidence into apply", async () => {
  const decision = await evaluateReadiness(reader(), ready());
  assert.equal(decision.kind, "authorize");
  if (decision.kind !== "authorize") return;
  assert.equal(typeof decision.evidence.nonce, "string");
  assert.deepEqual({ ...decision.evidence, nonce: "nonce" }, evidence);
  assert.deepEqual({ ...decision, evidence: { ...decision.evidence, nonce: "nonce" } }, {
    kind: "authorize",
    evidence,
    repository: "mosonlab/agentos",
    prNumber: 42,
    issuedAt: NOW.toISOString(),
    baseSha: BASE,
    headSha: HEAD,
    auditTriggers: [],
  });
});

test("a defense-list path authorizes the merge and is reported as audit triggers", async () => {
  // The defence list used to hold the merge for a blind review. It now only
  // names what a human would want to have seen move, and the merge proceeds.
  const decision = await evaluateReadiness(reader({
    comparison: {
      ...compared,
      files: [{ filename: "packages/api/src/app.ts", previousFilename: null, patch: null }],
    },
  }), ready());
  assert.equal(decision.kind, "authorize");
  assert.deepEqual(decision.kind === "authorize" ? decision.auditTriggers : null, [
    { path: "packages/api/src/app.ts", reason: "merge-tail-machinery" },
  ]);
});

test("head drift requeues Regression without comparing commits", async () => {
  const calls: string[] = [];
  const recordingReader: PullRequestReader = {
    readPullRequest: async () => {
      calls.push("readPullRequest");
      return snapshot({ headRefOid: "c".repeat(40) });
    },
    compareCommits: async () => {
      calls.push("compareCommits");
      return compared;
    },
  };
  const decision = await evaluateReadiness(recordingReader, ready());
  assert.equal(decision.kind, "requeue-regression");
  assert.match(decision.kind === "requeue-regression" ? decision.reason : "", /stale PASS head/u);
  assert.deepEqual(calls, ["readPullRequest"]);
});

test("timeout and transport failures defer from either remote read", async () => {
  for (const phase of ["readPullRequest", "compareCommits"] as const) {
    for (const kind of ["timeout", "transport"] as const) {
      const failingReader: PullRequestReader = {
        readPullRequest: async () => {
          if (phase === "readPullRequest") throw new GitHubReadError(`${kind} failure`, kind);
          return snapshot();
        },
        compareCommits: async () => {
          if (phase === "compareCommits") throw new GitHubReadError(`${kind} failure`, kind);
          return compared;
        },
      };
      assert.deepEqual(await evaluateReadiness(failingReader, ready()), {
        kind: "defer",
        reason: `readiness evaluation failed: ${kind} failure`,
      });
    }
  }
});

test("a reader without commit comparison stops before reading the pull request", async () => {
  let reads = 0;
  const incompleteReader: PullRequestReader = {
    readPullRequest: async () => {
      reads += 1;
      return snapshot();
    },
  };
  assert.deepEqual(await evaluateReadiness(incompleteReader, ready()), {
    kind: "stop",
    condition: "github-reader-unavailable",
    evidence: "server-side GitHub comparison reader is unavailable",
  });
  assert.equal(reads, 0);
});

test("deterministic GitHub response failures stop", async () => {
  const failingReader: PullRequestReader = {
    readPullRequest: async () => { throw new GitHubReadError("malformed comparison", "response"); },
    compareCommits: async () => compared,
  };
  assert.deepEqual(await evaluateReadiness(failingReader, ready()), {
    kind: "stop",
    condition: "readiness-read-failed",
    evidence: "readiness evaluation failed: malformed comparison",
  });
});

test("an unclaimed candidate skips", async () => {
  assert.deepEqual(await evaluateReadiness(reader(), { ...context, stage: "claim-lost" }), { kind: "skip" });
});

test("an incomplete comparison is a named stop", async () => {
  const decision = await evaluateReadiness(reader({
    comparison: { ...compared, filesComplete: false },
  }), ready());
  assert.equal(decision.kind, "stop");
  assert.equal(decision.kind === "stop" ? decision.condition : null, "comparison-incomplete");
});

test("validated train evidence allows a diverged candidate comparison", async () => {
  const decision = await evaluateReadiness(reader({
    snapshot: snapshot({ baseSha: TRAIN_BASE }),
    comparison: { ...compared, status: "diverged", behindBy: 1 },
  }), trainReady());
  assert.equal(decision.kind, "authorize");
  if (decision.kind !== "authorize") return;
  assert.equal(decision.baseSha, TRAIN_BASE);
  assert.equal(decision.headSha, HEAD);
  assert.equal(decision.evidence.baseSha, TRAIN_BASE);
});

test("each requeue names the condition callers branch on", async () => {
  // The merge train suppresses exactly `base-advanced`; the prose reason is for
  // operators and must never be the thing a caller matches on.
  const advanced = await evaluateReadiness(reader({ snapshot: snapshot({ baseSha: TRAIN_BASE }) }), ready());
  assert.equal(advanced.kind, "requeue-regression");
  assert.equal(advanced.kind === "requeue-regression" ? advanced.condition : null, "base-advanced");

  const staleTrainBase = await evaluateReadiness(reader({ snapshot: snapshot({ baseSha: BASE }) }), trainReady());
  assert.equal(staleTrainBase.kind, "requeue-regression");
  assert.equal(staleTrainBase.kind === "requeue-regression" ? staleTrainBase.condition : null, "train-base-stale");

  const staleHead = await evaluateReadiness(reader({ snapshot: snapshot({ headRefOid: "c".repeat(40) }) }), ready());
  assert.equal(staleHead.kind, "requeue-regression");
  assert.equal(staleHead.kind === "requeue-regression" ? staleHead.condition : null, "stale-head");
});

test("a diverged comparison still requeues without train evidence", async () => {
  const decision = await evaluateReadiness(reader({
    comparison: { ...compared, status: "diverged", behindBy: 1 },
  }), ready());
  assert.equal(decision.kind, "requeue-regression");
  assert.equal(decision.kind === "requeue-regression" ? decision.condition : null, "ancestry-refused");
});
