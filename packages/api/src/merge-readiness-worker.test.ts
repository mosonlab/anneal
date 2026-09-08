import assert from "node:assert/strict";
import test from "node:test";

import { TaskStatus, type PrismaClient } from "@anneal/db";

import {
  executorsBlockingAuthorization,
  READINESS_CLAIM_LEASE_MS,
  READINESS_READ_BUDGET_MS,
  startReadinessWorker,
} from "./merge-readiness-worker.js";
import { waitUntil } from "./worker-tick-wait.js";
import { createRunnerRegistry } from "./runners.js";

const withExecutorAllowlist = (runnerIds: string | undefined, body: () => void): void => {
  const previous = process.env.MERGE_EXECUTOR_RUNNER_IDS;
  if (runnerIds === undefined) delete process.env.MERGE_EXECUTOR_RUNNER_IDS;
  else process.env.MERGE_EXECUTOR_RUNNER_IDS = runnerIds;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.MERGE_EXECUTOR_RUNNER_IDS;
    else process.env.MERGE_EXECUTOR_RUNNER_IDS = previous;
  }
};

test("readiness reads merge executor liveness from the registry GET /runners reports", () => {
  const seenAt = new Date("2026-09-06T12:00:00.000Z");
  const registry = createRunnerRegistry();
  registry.note("merge-executor-1", {}, seenAt);
  const offline = new Date(seenAt.getTime() + 31_000);
  const online = new Date(seenAt.getTime() + 5_000);

  withExecutorAllowlist("merge-executor-1", () => {
    assert.deepEqual(executorsBlockingAuthorization(() => registry.snapshot(online)), []);
    assert.deepEqual(executorsBlockingAuthorization(() => registry.snapshot(offline)), ["merge-executor-1"]);
    // A daemon that never reported at all is not online either.
    assert.deepEqual(executorsBlockingAuthorization(() => []), ["merge-executor-1"]);
  });

  // A second, unrelated daemon does not stand in for the executor.
  withExecutorAllowlist("merge-executor-2", () => {
    assert.deepEqual(executorsBlockingAuthorization(() => registry.snapshot(online)), ["merge-executor-2"]);
  });

  // No allowlist, no check: authorization proceeds as it did before.
  withExecutorAllowlist(undefined, () => {
    assert.deepEqual(executorsBlockingAuthorization(() => []), []);
  });
});

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  }, () => []);
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

for (const condition of ["base-advanced", "train-base-stale", "stale-head", "ancestry-refused"] as const) {
  for (const withRecovery of [false, true]) {
    test(`readiness parks with the applicable bound (condition=${condition}, recovery=${withRecovery})`, async () => {
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
      const ceiling = withRecovery ? 2 : 3;
      const baseDrift = condition === "base-advanced" || condition === "train-base-stale";
      const tx = {
        $queryRaw: async () => [{ id: agent.id }],
        agent: { findUnique: async () => agent },
        task: {
          findUniqueOrThrow: async () => ({ id: "regression-1", chainId: null }),
          findUnique: async () => ({
            id: "regression-1", name: "Regression", assigneeType: "AGENT", assigneeAgent: agent,
            archivedAt: null, repo: { id: "repo-1", defaultBranch: "main" },
            runs: [{ id: "run-4", runNumber: 4, maxRunsPerTask: 4, budgetGrants: 3, leaseLossRefunds: 3 }],
          }),
          update: async (args: typeof updates[number]) => { updates.push(args); return {}; },
          updateMany: async (args: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
            for (const id of args.where.id.in) updates.push({ where: { id }, data: args.data });
            return { count: args.where.id.in.length };
          },
        },
        taskActivity: {
          findMany: async () => [...Array.from({ length: ceiling }, (_, index) => ({ metadata: {
            kind: "mergeReadiness.requeue", ordinal: index + 1, baseDrift: true,
            ...(withRecovery ? { recoveryAggregateId: "recovery-1" } : {}),
          } })), { metadata: {
            kind: "mergeReadiness.requeue", ordinal: 50, baseDrift: false,
            ...(withRecovery ? { recoveryAggregateId: "recovery-1" } : {}),
          } }, { metadata: {
            kind: "mergeReadiness.requeue", ordinal: 51, baseDrift: true,
            recoveryAggregateId: "past-recovery",
          } }],
          create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return data; },
        },
        inboxMessage: { upsert: async () => ({}) },
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
        staleBaseSha: "old-base", currentBaseSha: "new-base", condition, reason: "base drift",
        now: new Date(), recovery: withRecovery ? recovery : null,
      }).body(tx, claim);
      assert.equal(result.value.applied, true);
      if (baseDrift) assert.equal(result.value.stopped, true);
      for (const id of ["regression-1", "readiness-1"]) {
        const last = updates.filter((update) => update.where.id === id).at(-1)?.data;
        assert.equal(last?.status, TaskStatus.REVIEW);
        if (baseDrift) {
          assert.equal(last?.failureReason,
            `${withRecovery ? "base-drift-recovery" : "readiness-base-drift"}-requeue-limit: ${ceiling} requeues reached ceiling ${ceiling}`);
        } else {
          assert.match(String(last?.failureReason), /Lease-loss refunds exhausted/);
        }
        assert.doesNotMatch(String(last?.failureReason), /readiness evaluation failed/);
      }
      if (withRecovery) assert.equal(recoveryUpdates.at(-1)?.data.status, "BLOCKED_DOWNSTREAM");
      assert.ok(activities.some((activity) => {
        const metadata = activity.metadata as Record<string, unknown>;
        return baseDrift ? metadata?.state === "stopped" : metadata?.refusal === "lease-loss-refunds-exhausted";
      }));
    });

  }
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

test("closing an offline episode cannot mutate a marker after claim loss", async () => {
  const { closeExecutorOfflineEpisodeTx } = await import("./merge-readiness-worker.js");
  let reads = 0;
  const tx = { taskActivity: { findFirst: async () => { reads += 1; throw new Error("unfenced read"); } } };
  const claim = {
    settle: async () => ({ settled: false, ownership: "released" }),
  } as unknown as import("./readiness-claim.js").ReadinessClaimHandle;
  await closeExecutorOfflineEpisodeTx(tx as unknown as import("@anneal/db").Prisma.TransactionClient,
    "readiness", claim, "executor observed online");
  assert.equal(reads, 0);
});

for (const allowlist of ["", "merge-executor-1"]) {
  test(`a pending Regression without an episode performs no claim transactions (allowlist=${allowlist})`, async () => {
    const { readinessTick } = await import("./merge-readiness-worker.js");
    const previous = process.env.MERGE_EXECUTOR_RUNNER_IDS;
    process.env.MERGE_EXECUTOR_RUNNER_IDS = allowlist;
    let regressionReads = 0;
    let markerReads = 0;
    const db = {
      task: {
        findMany: async (input: { where: { chainId?: null } }) => input.where.chainId === null ? [] : [{
          id: "readiness", status: TaskStatus.TODO, chainId: "chain", projectId: "project", repoId: "repo", templateId: "template",
          templateStep: { outputKind: "merge-authorization", stepIndex: 6, taskTemplate: { name: "direct-engineer-workflow" } },
        }],
        findFirst: async () => { regressionReads++; return { id: "regression", status: TaskStatus.TODO }; },
      },
      taskActivity: { findFirst: async () => { markerReads++; return null; } },
      $transaction: async () => { throw new Error("a skipped tick must not claim"); },
    } as unknown as PrismaClient;
    try {
      const result = await readinessTick(db, {} as import("./github-read.js").PullRequestReader, new Date(), 5,
        async () => { throw new Error("no lease to release"); },
        async () => { throw new Error("no lease to acquire"); },
        () => [{ runnerId: "merge-executor-1", online: true }] as import("./runners.js").DaemonSnapshot[], 0);
      assert.equal(result.claimed, 0);
      assert.equal(regressionReads, 1);
      assert.equal(markerReads, allowlist ? 1 : 0);
    } finally {
      if (previous === undefined) delete process.env.MERGE_EXECUTOR_RUNNER_IDS;
      else process.env.MERGE_EXECUTOR_RUNNER_IDS = previous;
    }
  });
}
