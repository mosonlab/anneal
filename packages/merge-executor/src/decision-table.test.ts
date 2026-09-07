import assert from "node:assert/strict";
import { test } from "node:test";

import { execute, idempotencyKeyFor, matchingProtectionRule, synchronousExecution } from "./decision-table.js";
import type { DirectCommitRead, RepositorySnapshot } from "./github.js";
import {
  AUTHORIZED_BASE,
  AUTHORIZED_HEAD,
  MERGE_COMMIT,
  authorization,
  cleanSnapshot,
  makeFake,
  mergedSnapshot,
  refLandedBeforeProjection,
} from "./fake-pr-surface.js";



const stopped = (outcome: Awaited<ReturnType<typeof execute>>): { condition: string; evidence: string } => {
  assert.equal(outcome.outcome, "stopped", `expected a stop, got ${JSON.stringify(outcome)}`);
  return outcome as { outcome: "stopped"; condition: string; evidence: string };
};

/** The single assertion N24 rests on: the only mutating call ever observed is the guarded merge. */
const assertNoPublication = (calls: string[]): void => {
  const mutating = calls.filter((call) => call === "merge" || call === "disableAutoMerge" || call === "dequeuePullRequest");
  assert.ok(mutating.every((call) => call === "merge"), `unexpected mutating calls: ${mutating.join(", ")}`);
};

test("the happy path merges once, under the authorized head, and verifies the landed parents", async () => {
  const fake = makeFake({
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: mergedSnapshot() },
    ],
  });
  const outcome = await execute(fake.deps);
  assert.deepEqual(outcome, { outcome: "merged", mergeCommitSha: MERGE_COMMIT });
  const merges = fake.trace.filter((entry) => entry.call === "merge");
  assert.equal(merges.length, 1);
  assert.equal(merges[0]!.detail?.expectedHeadSha, AUTHORIZED_HEAD);
  // The intent is written BEFORE the merge, never after.
  assert.ok(fake.calls().indexOf("writeIntent") < fake.calls().indexOf("merge"));
  assertNoPublication(fake.calls());
});

test("post-merge verification accepts our identified merge after a concurrent base advance", async () => {
  const concurrentMergeSha = "d".repeat(40);
  const fake = makeFake({
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: { ...mergedSnapshot(), baseRefOid: concurrentMergeSha } },
    ],
  });

  assert.deepEqual(await execute(fake.deps), { outcome: "merged", mergeCommitSha: MERGE_COMMIT });
});

test("post-merge verification stops after a concurrent base advance when the direct read cannot settle it either", async () => {
  const concurrentMergeSha = "d".repeat(40);
  const mismatchedMergeSha = "e".repeat(40);
  const cases = [
    { label: "missing merge commit", mergeCommit: null },
    {
      label: "mismatched merge commit",
      mergeCommit: { oid: mismatchedMergeSha, parents: [AUTHORIZED_BASE, AUTHORIZED_HEAD] },
    },
  ];

  for (const { label, mergeCommit } of cases) {
    const fake = makeFake({
      reads: [
        { status: "ok", snapshot: cleanSnapshot() },
        { status: "ok", snapshot: cleanSnapshot() },
        {
          status: "ok",
          snapshot: { ...mergedSnapshot({ mergeCommit }), baseRefOid: concurrentMergeSha },
        },
      ],
      // Neither pull-request-side predicate holds, so the stop below is the
      // direct read's verdict: it is stated here rather than left to the fake's
      // default, because a successful read of the authorized parents would
      // instead complete the run as merged.
      directCommit: { status: "error", reason: "landed commit read failed: network: request timed out" },
    });

    const verdict = stopped(await execute(fake.deps));
    assert.equal(verdict.condition, "base-drift-post-merge", label);
    assert.equal(JSON.parse(verdict.evidence).observedBaseRefOid, concurrentMergeSha, label);
  }
});

test("post-merge verification stops when the base ref cannot be resolved", async () => {
  const fake = makeFake({
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: { ...mergedSnapshot(), baseRefOid: null } },
    ],
  });

  assert.equal(stopped(await execute(fake.deps)).condition, "base-drift-post-merge");
});

/** The 2026-09-06 shape: our merge landed, a later merge moved the base ref on,
 *  and GitHub's `mergeCommit` projection never caught up. Neither
 *  pull-request-side predicate can identify the merge from this. */
const staleProjection = (laterMerge: string): RepositorySnapshot =>
  ({ ...mergedSnapshot({ mergeCommit: null }), baseRefOid: laterMerge });

test("a landed merge self-verifies from the commit when the pull-request projection cannot", async () => {
  const fake = makeFake({
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: staleProjection("d".repeat(40)) },
    ],
    directCommit: { status: "ok", parents: [AUTHORIZED_BASE, AUTHORIZED_HEAD], reachableFromMain: true },
  });

  assert.deepEqual(await execute(fake.deps), { outcome: "merged", mergeCommitSha: MERGE_COMMIT });
  // One bounded attempt, asked about the commit this run built and the base ref
  // the human authorized.
  const direct = fake.trace.filter((entry) => entry.call === "readLandedCommit");
  assert.equal(direct.length, 1);
  assert.equal(direct[0]!.detail?.mergeCommitSha, MERGE_COMMIT);
  assert.equal(direct[0]!.detail?.baseRef, "master");
  assertNoPublication(fake.calls());
});

test("the direct commit read accepts nothing short of both parents and reachability", async () => {
  const foreign = "7".repeat(40);
  const cases: Array<[string, DirectCommitRead, Record<string, unknown>]> = [
    [
      "the first parent is not the authorized base",
      { status: "ok", parents: [foreign, AUTHORIZED_HEAD], reachableFromMain: true },
      { parents: [foreign, AUTHORIZED_HEAD], reachableFromMain: true },
    ],
    [
      "the second parent is not the authorized head",
      { status: "ok", parents: [AUTHORIZED_BASE, foreign], reachableFromMain: true },
      { parents: [AUTHORIZED_BASE, foreign], reachableFromMain: true },
    ],
    [
      "the authorized parents are not the only parents",
      { status: "ok", parents: [AUTHORIZED_BASE, AUTHORIZED_HEAD, foreign], reachableFromMain: true },
      { parents: [AUTHORIZED_BASE, AUTHORIZED_HEAD, foreign], reachableFromMain: true },
    ],
    [
      "the commit is not reachable from the base ref",
      { status: "ok", parents: [AUTHORIZED_BASE, AUTHORIZED_HEAD], reachableFromMain: false },
      { parents: [AUTHORIZED_BASE, AUTHORIZED_HEAD], reachableFromMain: false },
    ],
    [
      "the read timed out",
      { status: "error", reason: "landed commit read failed: network: request timed out" },
      { error: "landed commit read failed: network: request timed out" },
    ],
  ];

  for (const [label, directCommit, expected] of cases) {
    const fake = makeFake({
      reads: [
        { status: "ok", snapshot: cleanSnapshot() },
        { status: "ok", snapshot: cleanSnapshot() },
        { status: "ok", snapshot: staleProjection("d".repeat(40)) },
      ],
      directCommit,
    });

    const verdict = stopped(await execute(fake.deps));
    assert.equal(verdict.condition, "base-drift-post-merge", label);
    // The Inbox question shows why the mechanical check did not settle it.
    assert.deepEqual(JSON.parse(verdict.evidence).directParentCheck, expected, label);
    // A failed or refuted read is never retried into a confirmation.
    assert.equal(fake.calls().filter((call) => call === "readLandedCommit").length, 1, label);
  }
});

test("a successful atomic ref update is not falsely rejected while GitHub still reports the PR open", async () => {
  const fake = makeFake({ reads: [
    { status: "ok", snapshot: cleanSnapshot() },
    { status: "ok", snapshot: cleanSnapshot() },
    { status: "ok", snapshot: refLandedBeforeProjection() },
  ] });
  assert.deepEqual(await execute(fake.deps), { outcome: "merged", mergeCommitSha: MERGE_COMMIT });
});

test("N1 — an advanced head stops head-drift and issues no merge", async () => {
  const fake = makeFake({
    reads: [{ status: "ok", snapshot: cleanSnapshot({ pullRequest: { headRefOid: "d".repeat(40), rollupCommitOid: "d".repeat(40) } }) }],
  });
  assert.equal(stopped(await execute(fake.deps)).condition, "head-drift");
  assert.equal(fake.calls().includes("merge"), false);
});

test("N1 [platform] — a refused beforeOid CAS is named by the read-back, not by a retry", async () => {
  // The ref update is the merge, so a `beforeOid` mismatch means the base moved
  // under the run. The read-back that proves nothing landed is what names it.
  const fake = makeFake({
    merge: { status: "ref-update-refused", reason: "UNKNOWN: beforeOid mismatch" },
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot({ repository: { baseRefOid: "e".repeat(40) } }) },
    ],
  });
  assert.equal(stopped(await execute(fake.deps)).condition, "base-drift");
  assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 1);
});

test("N2 — base drift stops on the ref name, on the base sha, and again on the pre-merge re-read", async () => {
  const byName = makeFake({ reads: [{ status: "ok", snapshot: cleanSnapshot({ pullRequest: { baseRefName: "release" } }) }] });
  assert.equal(stopped(await execute(byName.deps)).condition, "base-drift");

  const bySha = makeFake({ reads: [{ status: "ok", snapshot: cleanSnapshot({ repository: { baseRefOid: "e".repeat(40) } }) }] });
  assert.equal(stopped(await execute(bySha.deps)).condition, "base-drift");

  // Clean at verification, moved by the last read before the merge.
  const lateDrift = makeFake({
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot({ repository: { baseRefOid: "f".repeat(40) } }) },
    ],
  });
  assert.equal(stopped(await execute(lateDrift.deps)).condition, "base-drift");
  assert.equal(lateDrift.calls().includes("merge"), false);
});

test("N3 — a failing check and an absent check both stop; absence is never a pass", async () => {
  const failing = makeFake({
    reads: [{ status: "ok", snapshot: cleanSnapshot({ pullRequest: { checks: [{ kind: "CheckRun", name: "ci", conclusion: "FAILURE", status: "COMPLETED" }] } }) }],
  });
  assert.equal(stopped(await execute(failing.deps)).condition, "check-failure-or-absence");

  const absent = makeFake({ reads: [{ status: "ok", snapshot: cleanSnapshot({ pullRequest: { checks: [] } }) }] });
  const verdict = stopped(await execute(absent.deps));
  assert.equal(verdict.condition, "check-failure-or-absence");
  assert.match(verdict.evidence, /absent from the rollup/u);
});

test("N3 — a check that succeeded for a different head is not credited to the authorized one", async () => {
  const fake = makeFake({
    reads: [{ status: "ok", snapshot: cleanSnapshot({ pullRequest: { rollupCommitOid: "9".repeat(40) } }) }],
  });
  const verdict = stopped(await execute(fake.deps));
  assert.equal(verdict.condition, "check-failure-or-absence");
  assert.match(verdict.evidence, /belongs to commit/u);
});

test("N4 — CONFLICTING, BEHIND, DRAFT and CLOSED all stop non-clean", async () => {
  for (const overrides of [
    { mergeable: "CONFLICTING" },
    { mergeStateStatus: "BEHIND" },
    { mergeStateStatus: "BLOCKED" },
    { isDraft: true },
    { state: "CLOSED" },
  ]) {
    const fake = makeFake({ reads: [{ status: "ok", snapshot: cleanSnapshot({ pullRequest: overrides }) }] });
    assert.equal(stopped(await execute(fake.deps)).condition, "non-clean-mergeability", JSON.stringify(overrides));
    assert.equal(fake.calls().includes("merge"), false);
  }
});

test("N5 — no authorization stops missing-authorization with nothing consumed", async () => {
  const fake = makeFake({ envelope: { authorization: null, refusal: "missing" } });
  assert.equal(stopped(await execute(fake.deps)).condition, "missing-authorization");
  assert.deepEqual(fake.calls(), ["readChain"]);
});

test("N6 — an authorization superseded between verification and merge stops rather than merging", async () => {
  const fake = makeFake({
    recheckEnvelope: { authorization: authorization({ activityId: "authorization-2" }) },
  });
  const verdict = stopped(await execute(fake.deps));
  assert.equal(verdict.condition, "superseded-authorization");
  assert.equal(fake.calls().includes("merge"), false);
  // The intent was already written, so the history records the attempt that was
  // abandoned rather than silently dropping it.
  assert.ok(fake.calls().includes("writeIntent"));
});

test("N7 — an authorization created after this run started is retroactive", async () => {
  const fake = makeFake({ startedAt: new Date("2026-08-18T00:00:00.000Z") });
  assert.equal(stopped(await execute(fake.deps)).condition, "retroactive-authorization");
});

test("N8 — an API error stops api-error, and a permission error is never read as 'no queue'", async () => {
  const fake = makeFake({ reads: [{ status: "api-error", reason: "FORBIDDEN: Resource not accessible" }] });
  const verdict = stopped(await execute(fake.deps));
  assert.equal(verdict.condition, "api-error");
  assert.match(verdict.evidence, /FORBIDDEN/u);
  assert.equal(fake.calls().includes("merge"), false);
});

test("N9 — a near match, a tie, and a wrong method are all ambiguity or payload-mismatch", async () => {
  const nearMatch = makeFake({ envelope: { authorization: null, nearMatchCount: 1, refusal: "malformed-near-match" } });
  assert.equal(stopped(await execute(nearMatch.deps)).condition, "ambiguity");

  const tie = makeFake({ envelope: { authorization: null, refusal: "ambiguous-tie" } });
  assert.equal(stopped(await execute(tie.deps)).condition, "ambiguity");

  // A near match alongside a valid record is still ambiguity, not a merge.
  const both = makeFake({ envelope: { nearMatchCount: 1 } });
  assert.equal(stopped(await execute(both.deps)).condition, "ambiguity");
  assert.equal(both.calls().includes("merge"), false);

  const wrongMethod = makeFake({ envelope: { authorization: authorization({ mergeMethod: "squash" }) } });
  assert.equal(stopped(await execute(wrongMethod.deps)).condition, "payload-mismatch");
});

test("N10 / X6 — an already-merged PR replays as merged only with all three facts plus the parent check", async () => {
  const key = idempotencyKeyFor(123, AUTHORIZED_HEAD, "authorization-1");
  const replay = makeFake({
    reads: [{ status: "ok", snapshot: mergedSnapshot() }],
    intents: [{ activityId: "intent-0", idempotencyKey: key, prNumber: 123, headSha: AUTHORIZED_HEAD, authorizationActivityId: "authorization-1" }],
  });
  assert.deepEqual(await execute(replay.deps), { outcome: "merged", mergeCommitSha: MERGE_COMMIT });
  // A replay issues no second merge. That is the whole idempotency claim.
  assert.equal(replay.calls().includes("merge"), false);

  // Same three facts, but the landed commit's first parent is not the base the
  // human authorized: an incident, never a success.
  const drifted = makeFake({
    reads: [{ status: "ok", snapshot: mergedSnapshot({ mergeCommit: { oid: MERGE_COMMIT, parents: ["7".repeat(40), AUTHORIZED_HEAD] } }) }],
    intents: [{ activityId: "intent-0", idempotencyKey: key, prNumber: 123, headSha: AUTHORIZED_HEAD, authorizationActivityId: "authorization-1" }],
  });
  assert.equal(stopped(await execute(drifted.deps)).condition, "base-drift-post-merge");
});

test("N11 — a foreign merge stops changed-underneath-me in each of its four shapes", async () => {
  const key = idempotencyKeyFor(123, AUTHORIZED_HEAD, "authorization-1");
  const intent = { activityId: "intent-0", idempotencyKey: key, prNumber: 123, headSha: AUTHORIZED_HEAD, authorizationActivityId: "authorization-1" };
  const cases: Array<[string, Parameters<typeof mergedSnapshot>[0], typeof intent[] ]> = [
    ["merged by someone else", { mergedByLogin: "someone-else" }, [intent]],
    ["merged at a head we never authorized", { headRefOid: "8".repeat(40) }, [intent]],
    ["no prior intent of ours", {}, []],
    ["merged with no recorded commit", { mergeCommit: null, mergedByLogin: "someone-else" }, [intent]],
  ];
  for (const [label, overrides, intents] of cases) {
    const fake = makeFake({ reads: [{ status: "ok", snapshot: mergedSnapshot(overrides) }], intents });
    assert.equal(stopped(await execute(fake.deps)).condition, "changed-underneath-me", label);
    assert.equal(fake.calls().includes("merge"), false, label);
  }
});

test("N12 — an UNKNOWN mergeability polls to its bound and then stops unresolved", async () => {
  const fake = makeFake({
    reads: [{ status: "ok", snapshot: cleanSnapshot({ pullRequest: { mergeable: "UNKNOWN" } }) }],
    pollAttempts: 2,
  });
  const verdict = stopped(await execute(fake.deps));
  assert.equal(verdict.condition, "unresolved-mergeability");
  assert.equal(fake.trace.filter((entry) => entry.call === "sleep").length, 2);
  assert.equal(fake.calls().includes("merge"), false);
});

test("N12 — an UNKNOWN that resolves inside the bound proceeds to the merge", async () => {
  const fake = makeFake({
    reads: [
      { status: "ok", snapshot: cleanSnapshot({ pullRequest: { mergeable: "UNKNOWN" } }) },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: mergedSnapshot() },
    ],
  });
  assert.deepEqual(await execute(fake.deps), { outcome: "merged", mergeCommitSha: MERGE_COMMIT });
});

test("N12 — a check still running is a poll, not a failure", async () => {
  const fake = makeFake({
    reads: [{ status: "ok", snapshot: cleanSnapshot({ pullRequest: { checks: [{ kind: "CheckRun", name: "ci", conclusion: null, status: "IN_PROGRESS" }] } }) }],
    pollAttempts: 1,
  });
  const verdict = stopped(await execute(fake.deps));
  assert.equal(verdict.condition, "unresolved-mergeability");
  assert.match(verdict.evidence, /pendingChecks/u);
});

test("N21 — a merge queue, a queue entry and armed auto-merge each stop, disarm, and read back", async () => {
  const queued = makeFake({
    reads: [
      { status: "ok", snapshot: cleanSnapshot({ repository: { mergeQueue: { id: "MQ_1" } } }) },
      { status: "ok", snapshot: cleanSnapshot() },
    ],
  });
  assert.equal(stopped(await execute(queued.deps)).condition, "deferred-merge-machinery");
  assert.equal(queued.calls().includes("merge"), false);

  const armed = makeFake({
    reads: [
      { status: "ok", snapshot: cleanSnapshot({ pullRequest: { autoMergeRequest: { enabledAt: "2026-08-18T00:00:00Z", mergeMethod: "MERGE" }, mergeQueueEntry: { id: "MQE_1", state: "QUEUED", position: 2 } } }) },
      { status: "ok", snapshot: cleanSnapshot() },
    ],
  });
  const verdict = stopped(await execute(armed.deps));
  assert.equal(verdict.condition, "deferred-merge-machinery");
  // Both disarms ran, and the readback is asserted independently of the trace.
  assert.deepEqual(
    armed.calls().filter((call) => call === "disableAutoMerge" || call === "dequeuePullRequest"),
    ["disableAutoMerge", "dequeuePullRequest"],
  );
  assert.match(verdict.evidence, /"armedStateIncident":null/u);
});

test("N21 — a disarm that does not take is escalated inside the stop as an armed-state incident", async () => {
  const fake = makeFake({
    reads: [
      { status: "ok", snapshot: cleanSnapshot({ pullRequest: { autoMergeRequest: { enabledAt: null, mergeMethod: "MERGE" } } }) },
      { status: "ok", snapshot: cleanSnapshot({ pullRequest: { autoMergeRequest: { enabledAt: null, mergeMethod: "MERGE" } } }) },
    ],
    disableAutoMerge: { ok: false, reason: "FORBIDDEN" },
  });
  const verdict = stopped(await execute(fake.deps));
  assert.equal(verdict.condition, "deferred-merge-machinery");
  assert.match(verdict.evidence, /armedStateIncident/u);
  assert.match(verdict.evidence, /still shows an armed state/u);
});

test("N21 — an omitted synchronous-execution field is a stop, never 'no queue'", async () => {
  const fake = makeFake({ reads: [{ status: "sync-unknown", reason: "repository.mergeQueue was omitted from the response" }] });
  assert.equal(stopped(await execute(fake.deps)).condition, "deferred-merge-machinery");
  assert.equal(fake.calls().includes("merge"), false);
});

test("N22 — an unresolvable or mismatched chain target stops before any read", async () => {
  for (const unresolvable of ["none", "ambiguous", "repository"] as const) {
    const fake = makeFake({ envelope: { target: { resolved: false, unresolvable, observed: [] } } });
    assert.equal(stopped(await execute(fake.deps)).condition, "target-unresolvable");
    assert.deepEqual(fake.calls(), ["readChain"]);
  }
  // A foreign PR authorized against this chain: the chain target wins.
  const foreign = makeFake({ envelope: { authorization: authorization({ prNumber: 999 }) } });
  assert.equal(stopped(await execute(foreign.deps)).condition, "payload-mismatch");
  assert.equal(foreign.calls().includes("merge"), false);
});

test("N17 — a refused ref update is classified by exactly one re-read and never a second merge", async () => {
  const fake = makeFake({
    merge: { status: "ref-update-refused", reason: "UNKNOWN: refusing to update ref" },
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot({ pullRequest: { mergeStateStatus: "BLOCKED" } }) },
    ],
  });
  assert.equal(stopped(await execute(fake.deps)).condition, "non-clean-mergeability");
  assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 1);
});

test("N17 — a 403 and a 404 stop api-error rather than escalating", async () => {
  for (const response of [{ status: "forbidden" as const, reason: "HTTP 403" }, { status: "not-found" as const, reason: "HTTP 404" }]) {
    const fake = makeFake({ merge: response });
    assert.equal(stopped(await execute(fake.deps)).condition, "api-error");
    assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 1);
  }
});

test("a 5xx whose merge in fact landed is resolved by the replay determination, not a second merge", async () => {
  const fake = makeFake({
    merge: { status: "unknown", reason: "HTTP 502" },
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: mergedSnapshot() },
    ],
  });
  assert.deepEqual(await execute(fake.deps), { outcome: "merged", mergeCommitSha: MERGE_COMMIT });
  assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 1);
});

test("a merge that reports success but lands on unauthorized parents is an incident, not a success", async () => {
  const fake = makeFake({
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: mergedSnapshot({ mergeCommit: { oid: MERGE_COMMIT, parents: ["1".repeat(40), AUTHORIZED_HEAD] } }) },
    ],
  });
  assert.equal(stopped(await execute(fake.deps)).condition, "base-drift-post-merge");
});

test("synchronous execution is determined positively, and the protection rule is the most specific match", () => {
  assert.deepEqual(synchronousExecution(cleanSnapshot()), { armed: false });
  assert.equal(synchronousExecution(cleanSnapshot({ repository: { mergeQueue: { id: "MQ" } } })).armed, true);

  const rules = [
    { pattern: "*", requiresStatusChecks: true, requiresStrictStatusChecks: false, requiredStatusCheckContexts: ["loose"] },
    { pattern: "master", requiresStatusChecks: true, requiresStrictStatusChecks: false, requiredStatusCheckContexts: ["strict"] },
    { pattern: "release/*", requiresStatusChecks: true, requiresStrictStatusChecks: false, requiredStatusCheckContexts: ["release"] },
  ];
  assert.equal(matchingProtectionRule(rules, "master")?.requiredStatusCheckContexts[0], "strict");
  assert.equal(matchingProtectionRule(rules, "release/1.0")?.requiredStatusCheckContexts[0], "release");
  // A rule that does not require status checks supplies no contexts at all.
  assert.equal(matchingProtectionRule([{ pattern: "master", requiresStatusChecks: false, requiresStrictStatusChecks: false, requiredStatusCheckContexts: ["x"] }], "master"), null);
});

test("N24 — across every stop leg, the only mutating call ever observed is the guarded merge", async () => {
  const legs = [
    makeFake({ reads: [{ status: "ok", snapshot: cleanSnapshot({ pullRequest: { headRefOid: "d".repeat(40) } }) }] }),
    makeFake({ envelope: { authorization: null, refusal: "missing" } }),
    makeFake({ reads: [{ status: "api-error", reason: "boom" }] }),
    makeFake({ merge: { status: "ref-update-refused", reason: "UNKNOWN: beforeOid mismatch" } }),
    makeFake({ reads: [{ status: "ok", snapshot: mergedSnapshot({ mergedByLogin: "someone" }) }] }),
  ];
  for (const leg of legs) {
    await execute(leg.deps);
    assertNoPublication(leg.calls());
  }
});

test("the idempotency key binds PR, authorized head and authorization record together", () => {
  assert.equal(idempotencyKeyFor(1, AUTHORIZED_HEAD, "act"), `1:${AUTHORIZED_HEAD}:act`);
  assert.notEqual(idempotencyKeyFor(1, AUTHORIZED_HEAD, "act"), idempotencyKeyFor(1, AUTHORIZED_BASE, "act"));
});

/**
 * The review of PR #130 found the last read before the merge compared only base
 * and head, so anything that changed inside the verification window without
 * moving an oid — auto-merge, draft, required checks — was not caught. The
 * final read now re-runs the whole pre-merge classification and the
 * synchronous-execution determination.
 */
test("a state that degrades after the intent, without moving an oid, is caught by the final read", async () => {
  const cases: Array<[string, Parameters<typeof cleanSnapshot>[0], string]> = [
    ["converted to a draft", { pullRequest: { isDraft: true } }, "non-clean-mergeability"],
    ["mergeability turned CONFLICTING", { pullRequest: { mergeable: "CONFLICTING" } }, "non-clean-mergeability"],
    ["a required check turned red", {
      pullRequest: { checks: [{ kind: "CheckRun", name: "ci", conclusion: "FAILURE", status: "COMPLETED" }] },
    }, "check-failure-or-absence"],
    ["a new required context was added", {
      repository: { branchProtectionRules: [{
        pattern: "master", requiresStatusChecks: true, requiresStrictStatusChecks: false,
        requiredStatusCheckContexts: ["ci", "security"],
      }] },
    }, "check-failure-or-absence"],
    ["mergeability went back to UNKNOWN", { pullRequest: { mergeable: "UNKNOWN" } }, "unresolved-mergeability"],
  ];
  for (const [label, degraded, condition] of cases) {
    const fake = makeFake({
      reads: [
        { status: "ok", snapshot: cleanSnapshot() },
        { status: "ok", snapshot: cleanSnapshot(degraded) },
      ],
    });
    const verdict = stopped(await execute(fake.deps));
    assert.equal(verdict.condition, condition, `${label}: ${JSON.stringify(verdict)}`);
    assert.equal(fake.calls().includes("merge"), false, label);
  }
});

test("auto-merge armed after the intent is disarmed by the final read, not merged through", async () => {
  const fake = makeFake({
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot({ pullRequest: { autoMergeRequest: { enabledAt: "2026-08-18T00:00:00Z", mergeMethod: "MERGE" } } }) },
    ],
  });
  const verdict = stopped(await execute(fake.deps));
  assert.equal(verdict.condition, "deferred-merge-machinery", JSON.stringify(verdict));
  // §11.4: the disarm runs, and the merge does not.
  assert.ok(fake.calls().includes("disableAutoMerge"), fake.calls().join(","));
  assert.equal(fake.calls().includes("merge"), false);
});

test("a PR merged by someone else between the intent and the final read is a replay determination", async () => {
  const fake = makeFake({
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: mergedSnapshot({ mergedByLogin: "someone-else" }) },
    ],
  });
  const outcome = await execute(fake.deps);
  // Not "base-drift", not a second merge: the replay determination owns it.
  assert.notEqual(outcome.outcome, "merged");
  assert.equal(fake.calls().includes("merge"), false);
});

/*
 * #139's production wiring: the merge PUT goes through `confirmedWrite`, so a
 * lost response is adjudicated by a read-back rather than by its own error
 * text. The two tests named for PRs are the two halves of the night of
 * 2026-08-18, driven through the real decision table rather than through the
 * engine's own fake.
 */

test("#147 — a lost merge response confirmed OPEN is re-sent exactly once, under a re-verified authorization", async () => {
  const fake = makeFake({
    merges: [{ status: "unknown", reason: "Post \"https://api.github.com/...\": EOF" }, { status: "merged", sha: MERGE_COMMIT }],
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },   // verification
      { status: "ok", snapshot: cleanSnapshot() },   // pre-merge final read
      { status: "ok", snapshot: cleanSnapshot() },   // read-back: still OPEN, nothing landed
      { status: "ok", snapshot: mergedSnapshot() },  // post-merge parent verification
    ],
  });
  assert.deepEqual(await execute(fake.deps), { outcome: "merged", mergeCommitSha: MERGE_COMMIT });
  const merges = fake.trace.filter((entry) => entry.call === "merge");
  assert.equal(merges.length, 2);
  // Both sends carry the compare-and-swap, so neither could have landed a head
  // the human did not authorize — that is what makes the second one safe.
  assert.deepEqual(merges.map((entry) => entry.detail?.expectedHeadSha), [AUTHORIZED_HEAD, AUTHORIZED_HEAD]);
  // And the second send is a fresh decision, not a repeated request: the guard
  // re-read the chain for supersession before it.
  assert.equal(fake.calls().filter((call) => call === "readChain").length, 3);
  assertNoPublication(fake.calls());
});

test("#150 — a lost merge response confirmed MERGED is not re-sent at all", async () => {
  const fake = makeFake({
    merges: [{ status: "unknown", reason: "unexpected EOF" }, { status: "merged", sha: "d".repeat(40) }],
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: mergedSnapshot() },
    ],
  });
  // The second element of `merges` is the negative: it is what a blind resend
  // would have landed, and it never appears in the outcome.
  assert.deepEqual(await execute(fake.deps), { outcome: "merged", mergeCommitSha: MERGE_COMMIT });
  assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 1);
});

test("a lost merge response whose read-back cannot be completed is never re-sent", async () => {
  const fake = makeFake({
    merges: [{ status: "unknown", reason: "EOF" }, { status: "merged", sha: "d".repeat(40) }],
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "api-error", reason: "read timed out" },
    ],
  });
  const outcome = stopped(await execute(fake.deps));
  assert.equal(outcome.condition, "api-error");
  assert.match(outcome.evidence, /read timed out/u);
  // Unknown fate, so nothing more is sent — including the merge the sequence
  // above would have answered with.
  assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 1);
});

test("a resend is refused when the read-back that authorized it shows the world moved", async () => {
  for (const [name, moved] of [
    ["head-drift", cleanSnapshot({ pullRequest: { headRefOid: "e".repeat(40) } })],
    ["base-drift", cleanSnapshot({ repository: { baseRefOid: "f".repeat(40) } })],
    ["non-clean-mergeability", cleanSnapshot({ pullRequest: { mergeStateStatus: "BLOCKED" } })],
    ["check-failure-or-absence", cleanSnapshot({ pullRequest: { checks: [{ kind: "CheckRun", name: "ci", conclusion: "FAILURE", status: "COMPLETED" }] } })],
  ] as const) {
    const fake = makeFake({
      merges: [{ status: "unknown", reason: "EOF" }, { status: "merged", sha: "d".repeat(40) }],
      reads: [
        { status: "ok", snapshot: cleanSnapshot() },
        { status: "ok", snapshot: cleanSnapshot() },
        { status: "ok", snapshot: moved },
      ],
    });
    assert.equal(stopped(await execute(fake.deps)).condition, name);
    assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 1, `${name} sent a second merge`);
  }
});

test("a resend is refused when an authorization landed while the first send was in flight", async () => {
  const fake = makeFake({
    merges: [{ status: "unknown", reason: "EOF" }, { status: "merged", sha: "d".repeat(40) }],
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
    ],
    // The pre-merge re-check still agrees; only the guard's third read differs.
    resendEnvelope: { authorization: authorization({ activityId: "authorization-2" }) },
  });
  const outcome = stopped(await execute(fake.deps));
  assert.equal(outcome.condition, "superseded-authorization");
  assert.match(outcome.evidence, /"phase":"resend guard"/u);
  assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 1);
});

test("auto-merge armed while the first send was in flight is disarmed, not merged through by the resend", async () => {
  const fake = makeFake({
    merges: [{ status: "unknown", reason: "EOF" }, { status: "merged", sha: "d".repeat(40) }],
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot({ pullRequest: { autoMergeRequest: { enabledAt: "2026-08-18T00:06:00.000Z", mergeMethod: "MERGE" } } }) },
      { status: "ok", snapshot: cleanSnapshot() },
    ],
  });
  assert.equal(stopped(await execute(fake.deps)).condition, "deferred-merge-machinery");
  assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 1);
  assert.equal(fake.calls().includes("disableAutoMerge"), true);
});

test("two lost responses stop rather than sending a third", async () => {
  const fake = makeFake({
    merges: [{ status: "unknown", reason: "EOF" }, { status: "unknown", reason: "EOF" }],
    reads: [{ status: "ok", snapshot: cleanSnapshot() }],
  });
  const outcome = stopped(await execute(fake.deps));
  assert.equal(outcome.condition, "api-error");
  assert.match(outcome.evidence, /"sends":2/u);
  assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 2);
});

/*
 * The ref update is the merge, and its response can be lost like any other.
 * A lost one is not a refusal: GitHub's pull-request projection lags the ref,
 * so the read-back that settles it has to compare the ref against the commit
 * this run built. Reclassifying from the pull request alone reported our own
 * landed merge as base drift, recovered it automatically, and then stopped
 * `changed-underneath-me` on the next authorization.
 */

const REF_UPDATE_LOST = {
  status: "ref-update-uncertain" as const,
  reason: "network: Post \"https://api.github.com/graphql\": EOF",
  mergeCommitSha: MERGE_COMMIT,
};

test("a lost ref-update response whose ref reads back as our merge commit is a merge, not base drift", async () => {
  // The ref has moved; the PR projection has not caught up, which is the exact
  // window the old code reclassified inside.
  const fake = makeFake({
    // The second element is the negative: what a blind resend would have landed.
    merges: [REF_UPDATE_LOST, { status: "merged", sha: "d".repeat(40) }],
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: refLandedBeforeProjection() },
    ],
  });

  assert.deepEqual(await execute(fake.deps), { outcome: "merged", mergeCommitSha: MERGE_COMMIT });
  assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 1);
  assertNoPublication(fake.calls());
});

test("a lost ref-update response whose ref reads back as another commit stops base-drift, and sends nothing more", async () => {
  const foreignCommit = "f".repeat(40);
  const fake = makeFake({
    merges: [REF_UPDATE_LOST, { status: "merged", sha: "d".repeat(40) }],
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot({ repository: { baseRefOid: foreignCommit } }) },
    ],
  });

  const outcome = stopped(await execute(fake.deps));
  assert.equal(outcome.condition, "base-drift");
  assert.equal(JSON.parse(outcome.evidence).observed, foreignCommit);
  assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 1);
});

test("a lost ref-update response confirmed absent stops without a second write, and the stop names it", async () => {
  const fake = makeFake({
    merges: [REF_UPDATE_LOST, { status: "merged", sha: "d".repeat(40) }],
    // The read-back finds the world exactly as it was authorized: the ref never
    // moved, so the update did not land — and the uncertain path resolves by
    // reading, never by sending again.
    reads: [{ status: "ok", snapshot: cleanSnapshot() }],
  });

  const outcome = stopped(await execute(fake.deps));
  assert.equal(outcome.condition, "api-error");
  assert.match(outcome.evidence, /ref-update-uncertain/u);
  assert.equal(fake.trace.filter((entry) => entry.call === "merge").length, 1);
  assertNoPublication(fake.calls());
});

test("a deterministic GitHub rejection keeps its class: no read-back retry, and a named stop", async () => {
  const refused = makeFake({ merge: { status: "ref-update-refused", reason: "UNKNOWN: beforeOid mismatch" } });
  const refusal = stopped(await execute(refused.deps));
  assert.equal(refusal.condition, "api-error");
  assert.match(refusal.evidence, /beforeOid mismatch/u);
  assert.equal(refused.trace.filter((entry) => entry.call === "merge").length, 1);

  const unprocessable = makeFake({
    merge: { status: "unprocessable", reason: "merge commit creation failed: HTTP 422 {\"message\":\"Invalid request\"}" },
  });
  const outcome = stopped(await execute(unprocessable.deps));
  assert.equal(outcome.condition, "payload-mismatch");
  assert.match(outcome.evidence, /HTTP 422/u);
  assert.equal(unprocessable.trace.filter((entry) => entry.call === "merge").length, 1);
});

test("a GraphQL timeout confirmed against the landed ref merges without resending", async () => {
  const fake = makeFake({
    merge: { ...REF_UPDATE_LOST, reason: "TIMEOUT: The request timed out" },
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: refLandedBeforeProjection() },
    ],
  });
  assert.deepEqual(await execute(fake.deps), { outcome: "merged", mergeCommitSha: MERGE_COMMIT });
  assert.equal(fake.calls().filter((call) => call === "merge").length, 1);
  assertNoPublication(fake.calls());
});

test("an uncertain ref update disarms re-armed auto-merge and stops without another merge", async () => {
  const fake = makeFake({
    merge: REF_UPDATE_LOST,
    reads: [
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot() },
      { status: "ok", snapshot: cleanSnapshot({ pullRequest: {
        autoMergeRequest: { enabledAt: "2026-08-18T00:05:00.000Z", mergeMethod: "MERGE" },
      } }) },
      { status: "ok", snapshot: cleanSnapshot() },
    ],
  });
  assert.equal(stopped(await execute(fake.deps)).condition, "deferred-merge-machinery");
  assert.equal(fake.calls().filter((call) => call === "merge").length, 1);
  assert.equal(fake.calls().filter((call) => call === "disableAutoMerge").length, 1);
  assert.ok(fake.calls().indexOf("disableAutoMerge") > fake.calls().indexOf("merge"));
});
