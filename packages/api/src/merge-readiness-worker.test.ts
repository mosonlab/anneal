import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import {
  READINESS_CLAIM_LEASE_MS,
  READINESS_READ_BUDGET_MS,
  startReadinessWorker,
} from "./merge-readiness-worker.js";

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitUntil = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
    await wait(25);
  }
};

test("the renewed readiness claim covers both the read budget and a lease acquire timeout", () => {
  assert.equal(READINESS_READ_BUDGET_MS, 20_000);
  assert.equal(READINESS_CLAIM_LEASE_MS, 60_000);
  assert.ok(READINESS_READ_BUDGET_MS + 30_000 < READINESS_CLAIM_LEASE_MS);
});

test("the readiness worker never overlaps ticks in one process", async () => {
  const previousInterval = process.env.MERGE_READINESS_POLL_INTERVAL_MS;
  process.env.MERGE_READINESS_POLL_INTERVAL_MS = "250";
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const db = {
    mergeRecoveryAttempt: { findMany: async () => [] },
    task: {
      findMany: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await wait(350);
        active -= 1;
        return [];
      },
    },
  } as unknown as PrismaClient;
  const timer = startReadinessWorker(db, {
    readPullRequest: async () => { throw new Error("unexpected GitHub read"); },
  });
  try {
    await waitUntil(() => calls >= 2);
  } finally {
    clearInterval(timer);
    if (previousInterval === undefined) delete process.env.MERGE_READINESS_POLL_INTERVAL_MS;
    else process.env.MERGE_READINESS_POLL_INTERVAL_MS = previousInterval;
  }
  await waitUntil(() => active === 0);
  assert.equal(maximumActive, 1);
});

for (const withRecovery of [false, true]) {
  test(`a fourth readiness requeue parks regression by name (recovery=${withRecovery})`, async () => {
    const { requeueRegressionSettlement } = await import("./merge-readiness-worker.js");
    const { TaskStatus } = await import("@anneal/db");
    const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
    const activities: Array<Record<string, unknown>> = [];
    const recoveryUpdates: Array<{ data: Record<string, unknown> }> = [];
    const recovery = {
      aggregateId: "recovery-1", attempt: 1, sourceStopId: "stop-1", sourceRunId: "source-1",
      authorizationActivityId: "authorization-1", readinessTaskId: "readiness-1", regressionTaskId: "regression-1",
      integratorTaskId: "integrator-1", repository: "org/repo", prNumber: 1, targetBranch: "main",
      authorizedHeadSha: "head", authorizedBaseSha: "old-base", observedBaseSha: "new-base",
      currentBaseSha: "new-base", recoveryRunId: "run-4",
    };
    const aggregate = { ...recovery, id: recovery.aggregateId, boundSourceRunId: recovery.sourceRunId,
      status: "AWAITING_AUTHORIZATION" };

    const agent = { id: "agent-1", name: "regression", archivedAt: null };
    const tx = {
      $queryRaw: async () => [{ id: agent.id }],
      agent: { findUnique: async () => agent },
      task: {
        findUnique: async () => ({
          id: "regression-1", name: "Regression", assigneeType: "AGENT", assigneeAgent: agent,
          archivedAt: null, repo: { id: "repo-1", defaultBranch: "main" },
          runs: [{ id: "run-4", runNumber: 4, maxRunsPerTask: 4, budgetGrants: 3, leaseLossRefunds: 3 }],
        }),
        update: async (args: typeof updates[number]) => { updates.push(args); return {}; },
      },
      taskActivity: {
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return data; },
      },
      run: { create: async () => { assert.fail("cap exhaustion must not create a Run"); } },
      mergeRecoveryAttempt: {
        findUnique: async () => aggregate,
        findUniqueOrThrow: async () => aggregate,
        update: async (args: typeof recoveryUpdates[number]) => { recoveryUpdates.push(args); return aggregate; },
      },
    } as unknown as import("@anneal/db").Prisma.TransactionClient;
    const claim = {
      settle: async (client: typeof tx, input: { apply: (client: typeof tx) => Promise<{ value: unknown }> }) => ({
        settled: true, claim: "released", value: (await input.apply(client)).value,
      }),
    } as unknown as import("./readiness-claim.js").ReadinessClaimHandle;
    const result = await requeueRegressionSettlement({
      readinessTaskId: "readiness-1", regressionTaskId: "regression-1",
      staleBaseSha: "old-base", currentBaseSha: "new-base", reason: "base drift",
      now: new Date(), recovery: withRecovery ? recovery : null,
    }).body(tx, claim);
    assert.equal(result.value.applied, true);
    for (const id of ["regression-1", "readiness-1"]) {
      const last = updates.filter((update) => update.where.id === id).at(-1)?.data;
      assert.equal(last?.status, TaskStatus.REVIEW);
      assert.match(String(last?.failureReason), /Lease-loss refunds exhausted/);
      assert.doesNotMatch(String(last?.failureReason), /readiness evaluation failed/);
    }
    if (withRecovery) assert.equal(recoveryUpdates.at(-1)?.data.status, "BLOCKED_DOWNSTREAM");
    assert.equal(activities.length, 1);
    assert.deepEqual(activities[0]?.metadata, { refusal: "lease-loss-refunds-exhausted" });
  });

}

test("the exception requeue limit defaults to three and refuses an unusable value", async () => {
  const {
    READINESS_EXCEPTION_REQUEUE_LIMIT,
    readinessExceptionRequeueLimit,
  } = await import("./merge-readiness-worker.js");
  const previous = process.env.MERGE_READINESS_EXCEPTION_REQUEUE_LIMIT;
  try {
    delete process.env.MERGE_READINESS_EXCEPTION_REQUEUE_LIMIT;
    assert.equal(readinessExceptionRequeueLimit(), READINESS_EXCEPTION_REQUEUE_LIMIT);
    assert.equal(READINESS_EXCEPTION_REQUEUE_LIMIT, 3);
    process.env.MERGE_READINESS_EXCEPTION_REQUEUE_LIMIT = "0";
    assert.equal(readinessExceptionRequeueLimit(), 0);
    process.env.MERGE_READINESS_EXCEPTION_REQUEUE_LIMIT = "5";
    assert.equal(readinessExceptionRequeueLimit(), 5);
    for (const unusable of ["two", "-1", "1.5"]) {
      process.env.MERGE_READINESS_EXCEPTION_REQUEUE_LIMIT = unusable;
      assert.throws(
        () => readinessExceptionRequeueLimit(),
        /MERGE_READINESS_EXCEPTION_REQUEUE_LIMIT must be a non-negative integer/u,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.MERGE_READINESS_EXCEPTION_REQUEUE_LIMIT;
    else process.env.MERGE_READINESS_EXCEPTION_REQUEUE_LIMIT = previous;
  }
});

test("an exception requeue returns readiness to TODO and records the retry", async () => {
  const {
    READINESS_EXCEPTION_REQUEUE_STATE,
    requeueReadinessExceptionSettlement,
  } = await import("./merge-readiness-worker.js");
  const { MERGE_TAIL_KIND, TaskStatus } = await import("@anneal/db");
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const activities: Array<Record<string, unknown>> = [];
  const tx = {
    task: {
      update: async (args: typeof updates[number]) => { updates.push(args); return {}; },
    },
    taskActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return data; },
    },
  } as unknown as import("@anneal/db").Prisma.TransactionClient;
  const claim = {
    settle: async (client: typeof tx, input: { apply: (client: typeof tx) => Promise<{ value: unknown }> }) => ({
      settled: true, claim: "released", value: (await input.apply(client)).value,
    }),
  } as unknown as import("./readiness-claim.js").ReadinessClaimHandle;

  const settlement = requeueReadinessExceptionSettlement({
    readinessTaskId: "readiness-1",
    regressionTaskId: "regression-1",
    reason: "readiness evaluation exception: terminated",
    requeue: 2,
    limit: 3,
    recovery: null,
    now: new Date(),
  });
  assert.equal(settlement.kind, "requeue");
  const result = await settlement.body(tx, claim);
  assert.equal(result.value.applied, true);
  assert.deepEqual(result.leaseOutcome, { kind: "stop", taskId: "regression-1" });

  assert.deepEqual(updates, [{
    where: { id: "readiness-1" },
    data: { status: TaskStatus.TODO, failureReason: null },
  }], "only the readiness Step is returned; the regression evidence stands");
  assert.equal(activities.length, 1);
  assert.equal(activities[0]?.taskId, "regression-1", "the retry row joins the readiness markers on the regression task");
  assert.match(String(activities[0]?.body), /Merge readiness requeued after evaluation exception 2 of 3: readiness evaluation exception: terminated/u);
  const metadata = activities[0]?.metadata as Record<string, unknown>;
  assert.equal(metadata.kind, MERGE_TAIL_KIND.readiness);
  assert.equal(metadata.state, READINESS_EXCEPTION_REQUEUE_STATE);
  assert.equal(metadata.reason, "readiness evaluation exception: terminated");
  assert.equal(metadata.requeue, 2);
  assert.equal(metadata.limit, 3);
  assert.equal(metadata.recoveryAggregateId, null);
});
