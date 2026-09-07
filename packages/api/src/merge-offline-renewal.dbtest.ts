import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  applyInboxDecision,
  applyInboxDecisionTx,
  MERGE_INTEGRATOR_KIND,
  PrismaClient,
  TaskStatus,
} from "@anneal/db";

import { type PullRequestSnapshot } from "./github-read.js";
import { evidenceTick } from "./merge-evidence-worker.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const EXECUTOR_ID = "merge-executor-1";
const EXECUTOR_TOKEN = "merge-executor-token-offline-renewal";

const withExecutorEnvironment = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = [
    ["OPERATOR_TOKEN", process.env.OPERATOR_TOKEN],
    ["MERGE_EXECUTOR_TOKEN", process.env.MERGE_EXECUTOR_TOKEN],
    ["MERGE_EXECUTOR_RUNNER_IDS", process.env.MERGE_EXECUTOR_RUNNER_IDS],
  ] as const;
  process.env.OPERATOR_TOKEN = "operator-offline-renewal";
  process.env.MERGE_EXECUTOR_TOKEN = EXECUTOR_TOKEN;
  process.env.MERGE_EXECUTOR_RUNNER_IDS = EXECUTOR_ID;
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

const liveIntegratorRun = async (
  chain: Awaited<ReturnType<typeof seedIntegratorChain>>,
) => {
  const run = await db.run.create({ data: {
    projectId: chain.project.id,
    taskId: chain.integratorTask!.id,
    agentId: chain.integratorAgent.id,
    repoId: chain.repo.id,
    runNumber: 1,
    dedupeKey: `task:${chain.integratorTask!.id}:run:1`,
    runner: "CLAUDE",
    model: "mechanical/merge-executor-v1",
    promptHash: "mechanical",
    status: "RUNNING",
    opensPullRequest: false,
    runnerId: EXECUTOR_ID,
    maxRunsPerTask: 5,
    fencingToken: `1:${chain.integratorTask!.id}:1`,
    leaseExpiresAt: new Date(Date.now() + 600_000),
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: chain.project.id,
    agentId: chain.integratorAgent.id,
    taskId: chain.integratorTask!.id,
    runner: "CLAUDE",
    executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: chain.integratorTask!.id }, data: { status: TaskStatus.DOING } });
  return run;
};

const stopIntegrator = async (
  chain: Awaited<ReturnType<typeof seedIntegratorChain>>,
) => {
  const run = await liveIntegratorRun(chain);
  await db.taskStepOutput.upsert({
    where: { taskId: chain.integratorTask!.id },
    create: {
      taskId: chain.integratorTask!.id,
      runId: run.id,
      kind: "merge-result",
      body: JSON.stringify({ outcome: "stopped", condition: "head-drift", evidence: "authorized head a…, live head c…" }),
    },
    update: {
      runId: run.id,
      body: JSON.stringify({ outcome: "stopped", condition: "head-drift", evidence: "authorized head a…, live head c…" }),
    },
  });
  const response = await createApp(db).request(`/runner/runs/${run.id}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${EXECUTOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: EXECUTOR_ID,
      fencingToken: run.fencingToken,
      exitCode: 0,
      outcome: { case: "succeeded" },
      cleanupStatus: "SUCCEEDED",
    }),
  });
  assert.equal(response.status, 200, await response.text());
};

const snapshot = (): PullRequestSnapshot => ({
  repository: "acme/widgets",
  number: 123,
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRefName: "master",
  baseSha: "b".repeat(40),
  headRefOid: "a".repeat(40),
  headCommitOid: "a".repeat(40),
  autoMergeRequest: null,
  mergeQueueEntry: null,
  repositoryMergeQueue: null,
  mergedBy: null,
  mergeCommit: null,
  requiredCheckNames: ["ci/build"],
  checkContexts: [{ __typename: "CheckRun", name: "ci/build", status: "COMPLETED", conclusion: "SUCCESS" }],
  readAt: new Date("2026-08-22T00:00:00.000Z").toISOString(),
});

const confirmationCard = async () => {
  const chain = await seedIntegratorChain(db, {
    label: "renew-offline",
    shape: "twelve-step-readiness",
    gatedReadiness: true,
  });
  assert.ok(chain.readinessTask);
  await db.task.update({ where: { id: chain.readinessTask.id }, data: { status: TaskStatus.DONE } });
  await stopIntegrator(chain);

  const stopQuestion = await db.inboxMessage.findFirstOrThrow({
    where: { taskId: chain.integratorTask!.id, status: "OPEN", kind: "MULTIPLE_CHOICE" },
    orderBy: { createdAt: "desc" },
  });
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: stopQuestion.id,
    externalEventId: "offline-renewal-request",
    decision: "re-authorize",
  }));
  const request = await db.taskActivity.findFirstOrThrow({
    where: {
      taskId: chain.readinessTask.id,
      metadata: { path: ["purpose"], equals: "confirmation" },
    },
    orderBy: { createdAt: "desc" },
  });
  const card = await db.inboxMessage.findUniqueOrThrow({
    where: { id: (request.metadata as { cardId: string }).cardId },
  });
  assert.equal((await evidenceTick(db, { readPullRequest: async () => snapshot() })).filled, 1);
  return { chain, card };
};

test("confirmation renewal defers and records the offline episode when no executor is live", async () => {
  await withExecutorEnvironment(async () => {
    const { chain, card } = await confirmationCard();
    assert.ok(chain.readinessTask);

    await assert.rejects(
      () => applyInboxDecision(db, {
        inboxMessageId: card.id,
        externalEventId: "offline-renewal-approve",
        decision: "approve",
        mergeExecutorLiveness: () => [{ runnerId: EXECUTOR_ID, online: false }],
      }),
      /merge-executor-offline/u,
    );

    assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } })).status, "OPEN");
    assert.equal(await db.inboxDecision.count({ where: { inboxMessageId: card.id } }), 0);
    assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);
    assert.equal(
      await db.taskActivity.count({
        where: {
          taskId: chain.readinessTask.id,
          metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization },
        },
      }),
      0,
    );
    const marker = await db.taskActivity.findFirstOrThrow({
      where: {
        taskId: chain.readinessTask.id,
        metadata: { path: ["state"], equals: "requeued-executor-offline" },
      },
      orderBy: { createdAt: "desc" },
    });
    const metadata = marker.metadata as {
      kind?: unknown;
      state?: unknown;
      reason?: unknown;
      executorRunnerIds?: unknown;
      episodeStartedAt?: unknown;
    };
    assert.equal(metadata.kind, "mergeTail.readiness");
    assert.equal(metadata.state, "requeued-executor-offline");
    assert.equal(metadata.reason, "merge-executor-offline");
    assert.deepEqual(metadata.executorRunnerIds, [EXECUTOR_ID]);
    assert.equal(typeof metadata.episodeStartedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(metadata.episodeStartedAt as string)));
  });
});

test("a live confirmation renewal closes the open offline episode", async () => {
  await withExecutorEnvironment(async () => {
    const { chain, card } = await confirmationCard();
    assert.ok(chain.readinessTask);
    const episodeStartedAt = "2026-08-22T00:00:00.000Z";
    await db.taskActivity.create({ data: {
      taskId: chain.readinessTask.id,
      actorType: "control-plane",
      body: "Merge readiness withheld its authorization: merge-executor-offline: no merge executor in merge-executor-1 is online",
      metadata: {
        kind: "mergeTail.readiness",
        state: "requeued-executor-offline",
        reason: "merge-executor-offline",
        executorRunnerIds: [EXECUTOR_ID],
        episodeStartedAt,
      },
    } });

    const result = await applyInboxDecision(db, {
      inboxMessageId: card.id,
      externalEventId: "online-renewal-approve",
      decision: "approve",
      mergeExecutorLiveness: () => [{ runnerId: EXECUTOR_ID, online: true }],
    });
    assert.equal(result.gateAction, "approved");
    assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } })).status, "ANSWERED");
    assert.equal(
      await db.taskActivity.count({
        where: {
          taskId: chain.readinessTask.id,
          metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization },
        },
      }),
      1,
    );
    const marker = await db.taskActivity.findFirstOrThrow({
      where: {
        taskId: chain.readinessTask.id,
        metadata: { path: ["state"], equals: "requeued-executor-offline" },
      },
    });
    assert.equal((marker.metadata as { episodeClosed?: unknown }).episodeClosed, true);
    const closed = await db.taskActivity.findMany({
      where: {
        taskId: chain.readinessTask.id,
        metadata: { path: ["state"], equals: "executor-offline-closed" },
      },
    });
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.body, "Merge readiness executor-offline episode ended: executor observed online during operator renewal");
  });
});
