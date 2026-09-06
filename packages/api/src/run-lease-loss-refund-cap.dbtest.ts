import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  LEASE_LOSS_REFUND_CAP,
  PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { readBoard } from "./board.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";
import { acknowledgeReclaimSalvage } from "./workspace-reclaim.js";

/**
 * A task's refunded attempts are bounded and spaced.
 *
 * A refund raises the very ceiling it is measured against — `maxRunsPerTask`
 * and `budgetGrants` both grow by one — so `runNumber < ceiling` can never
 * refuse a pure lease-loss sequence, and the replacement used to be queued at
 * `readyAt: now`. A runner host that was down therefore requeued the same task
 * forever, as fast as the reconciliation loop ran. What is asserted here is the
 * count kept apart from that ceiling, the backoff derived from it, and the fact
 * that no intent kind gets around it.
 */

let db: PrismaClient;
let sequence = 0;

before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-lease-loss-refund-token";

const asOperator = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    return await operation();
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const call = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> => asOperator(async () => {
  const response = await createApp(db).request(path, {
    method,
    headers: {
      Authorization: `Bearer ${OPERATOR}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
});

const seedTask = async (label: string) => {
  const suffix = `${process.pid}-${sequence++}`;
  const project = await db.project.create({ data: { name: label, slug: `${label}-${suffix}` } });
  const environment = await db.environment.create({ data: {
    projectId: project.id, name: "local", allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `agent-${suffix}`,
    title: "Agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: `repo-${suffix}`,
    remoteUrl: "https://example.test/repo.git",
    mountPath: "/repo",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id, agentId: agent.id, repoId: repo.id,
    mountPath: "/repo", permissions: "GIT_WRITE",
  } });
  const task = await db.task.create({ data: {
    projectId: project.id,
    name: "Lease-loss task",
    description: "bounded refunds",
    assigneeAgentId: agent.id,
    repoId: repo.id,
    status: TaskStatus.DOING,
  } });
  return { project, environment, agent, repo, task };
};

type Seeded = Awaited<ReturnType<typeof seedTask>>;

const seedRun = async (seeded: Seeded, run: {
  runNumber: number;
  status: RunStatus;
  maxRunsPerTask?: number;
  budgetGrants?: number;
  leaseLossRefunds?: number;
  runnerId?: string;
  leaseExpiresAt?: Date | null;
}) => db.run.create({ data: {
  projectId: seeded.project.id,
  taskId: seeded.task.id,
  agentId: seeded.agent.id,
  repoId: seeded.repo.id,
  runNumber: run.runNumber,
  dedupeKey: `task:${seeded.task.id}:run:${run.runNumber}`,
  runner: "CLAUDE",
  model: "claude",
  status: run.status,
  runnerId: run.runnerId ?? null,
  targetBranch: seeded.repo.defaultBranch,
  maxRunsPerTask: run.maxRunsPerTask ?? 5,
  budgetGrants: run.budgetGrants ?? 0,
  leaseLossRefunds: run.leaseLossRefunds ?? 0,
  leaseExpiresAt: run.leaseExpiresAt === undefined ? new Date(Date.now() + 60_000) : run.leaseExpiresAt,
} });

/** Put the task's newest Run into the state reconciliation reads as lost: an
 *  execution status, an expired lease, and no heartbeat since. */
const loseLatestRun = async (taskId: string, at: Date): Promise<void> => {
  const latest = await db.run.findFirstOrThrow({ where: { taskId }, orderBy: { runNumber: "desc" } });
  await db.run.update({ where: { id: latest.id }, data: {
    status: RunStatus.RUNNING,
    startedAt: new Date(at.getTime() - 30 * 60_000),
    heartbeatAt: null,
    leaseExpiresAt: new Date(at.getTime() - 60_000),
  } });
};

const latestRun = async (taskId: string) =>
  db.run.findFirstOrThrow({ where: { taskId }, orderBy: { runNumber: "desc" } });

test("three lease losses requeue with a growing delay and the fourth is refused by name", async () => {
  const seeded = await seedTask("lease-loss-sequence");
  await db.task.update({ where: { id: seeded.task.id }, data: { maxSessionsPerTask: 1 } });
  await seedRun(seeded, { runNumber: 1, status: RunStatus.QUEUED, maxRunsPerTask: 1 });
  const start = new Date("2026-09-06T06:00:00.000Z");
  const delays: number[] = [];

  for (const attempt of [0, 1, 2]) {
    const at = new Date(start.getTime() + attempt * 60 * 60_000);
    await loseLatestRun(seeded.task.id, at);
    assert.ok(await reconcileDatabaseRuns(db, at) > 0, `reconciliation ${attempt}`);

    const replacement = await latestRun(seeded.task.id);
    assert.equal(replacement.runNumber, attempt + 2, `replacement ${attempt}`);
    assert.equal(replacement.status, RunStatus.QUEUED, `replacement ${attempt} is queued`);
    // The count, not the ceiling it produced. One per refund, carried forward.
    assert.equal(replacement.leaseLossRefunds, attempt + 1, `refund count ${attempt}`);
    assert.ok(replacement.readyAt.getTime() > at.getTime(), `replacement ${attempt} waits`);
    delays.push(replacement.readyAt.getTime() - at.getTime());

    const lost = await db.run.findFirstOrThrow({ where: { taskId: seeded.task.id, runNumber: attempt + 1 } });
    assert.equal(lost.status, RunStatus.LOST, `run ${attempt + 1} is lost`);
    assert.equal(lost.budgetGrants, attempt + 1, `run ${attempt + 1} bought its refund`);
  }
  assert.deepEqual(delays, [...delays].sort((left, right) => left - right), "each refund waits longer");
  assert.ok(delays[0]! < delays[2]!, "the delay grows across the sequence");
  assert.equal(delays.length, LEASE_LOSS_REFUND_CAP);

  // The fourth loss has no refund left to spend.
  const fourth = new Date(start.getTime() + 4 * 60 * 60_000);
  await loseLatestRun(seeded.task.id, fourth);
  assert.ok(await reconcileDatabaseRuns(db, fourth) > 0);

  assert.equal(await db.run.count({ where: { taskId: seeded.task.id } }), 4, "no replacement is queued");
  const parked = await db.task.findUniqueOrThrow({ where: { id: seeded.task.id } });
  assert.equal(parked.status, TaskStatus.REVIEW);
  assert.match(String(parked.failureReason), /Lease-loss refunds exhausted/u);
  const named = await db.taskActivity.findMany({
    where: { taskId: seeded.task.id, metadata: { path: ["refusal"], equals: "lease-loss-refunds-exhausted" } },
  });
  assert.equal(named.length, 1, "the REVIEW states its reason by name");
  assert.match(String(named[0]?.body), /automatic retry refused/u);
  // A refund that was refused is not recorded as granted: the operator's own
  // retry must not inherit the attempt this reconciliation just refused.
  const stillLost = await latestRun(seeded.task.id);
  assert.equal(stillLost.status, RunStatus.LOST);
  assert.equal(stillLost.budgetGrants, LEASE_LOSS_REFUND_CAP);
  assert.equal(stillLost.leaseLossRefunds, LEASE_LOSS_REFUND_CAP);
});

test("the operator raises the budget and retries, and the bound still holds afterwards", async () => {
  const seeded = await seedTask("lease-loss-operator-retry");
  await seedRun(seeded, {
    runNumber: 4,
    status: RunStatus.LOST,
    maxRunsPerTask: 8,
    budgetGrants: LEASE_LOSS_REFUND_CAP,
    leaseLossRefunds: LEASE_LOSS_REFUND_CAP,
    leaseExpiresAt: null,
  });
  await db.task.update({ where: { id: seeded.task.id }, data: {
    status: TaskStatus.REVIEW,
    failureReason: "Lease-loss retry refused: Lease-loss refunds exhausted",
  } });

  const patched = await call("PATCH", `/tasks/${seeded.task.id}`, { maxSessionsPerTask: 9 });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const retried = await call("POST", `/tasks/${seeded.task.id}/retry`);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));

  const retry = await latestRun(seeded.task.id);
  assert.equal(retry.runNumber, 5);
  assert.equal(retry.status, RunStatus.QUEUED);
  // An operator attempt is not a platform refund: it neither spends one nor
  // clears the ones already spent.
  assert.equal(retry.leaseLossRefunds, LEASE_LOSS_REFUND_CAP);
  assert.equal(retry.maxRunsPerTask, 12);

  // Losing that attempt too is still refused rather than silently requeued.
  const later = new Date("2026-09-06T12:00:00.000Z");
  await loseLatestRun(seeded.task.id, later);
  assert.ok(await reconcileDatabaseRuns(db, later) > 0);
  assert.equal(await db.run.count({ where: { taskId: seeded.task.id } }), 2);
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: seeded.task.id } })).status,
    TaskStatus.REVIEW,
  );
});

test("a late-salvage claim invalidation spends the same bounded refund", async () => {
  const spend = async (leaseLossRefunds: number) => {
    const seeded = await seedTask(`lease-loss-salvage-${leaseLossRefunds}`);
    const runnerId = `runner-salvage-${leaseLossRefunds}`;
    const lost = await seedRun(seeded, {
      runNumber: 1,
      status: RunStatus.LOST,
      runnerId,
      leaseExpiresAt: null,
      leaseLossRefunds,
    });
    await db.run.update({ where: { id: lost.id }, data: { workspaceReclaimAt: new Date() } });
    const replacement = await seedRun(seeded, {
      runNumber: 2,
      status: RunStatus.CLAIMED,
      runnerId: "replacement-runner",
      leaseLossRefunds,
      maxRunsPerTask: 5 + leaseLossRefunds,
      budgetGrants: leaseLossRefunds,
    });
    const repaired = await acknowledgeReclaimSalvage(db, {
      runnerId,
      runId: lost.id,
      pushedBranch: `agentos/${seeded.task.id}/run-1`,
    });
    return { seeded, replacement, repaired };
  };

  // Under the bound: the stale claim is revoked and a fresh Run replaces it,
  // counting one more refund against the same total the lease-loss path spends.
  const granted = await spend(1);
  assert.equal(granted.repaired, "requeued");
  const requeued = await latestRun(granted.seeded.task.id);
  assert.equal(requeued.runNumber, 3);
  assert.equal(requeued.leaseLossRefunds, 2);
  assert.equal(
    (await db.run.findUniqueOrThrow({ where: { id: granted.replacement.id } })).budgetGrants,
    2,
    "the revoked claim records the refund it bought",
  );

  // At the bound: the stale claim is still revoked — its clone base is wrong —
  // but nothing is requeued and the Task is parked with the named reason.
  const spent = await spend(LEASE_LOSS_REFUND_CAP);
  assert.equal(spent.repaired, "repaired");
  assert.equal(await db.run.count({ where: { taskId: spent.seeded.task.id } }), 2, "no replacement is queued");
  const revoked = await db.run.findUniqueOrThrow({ where: { id: spent.replacement.id } });
  assert.equal(revoked.status, RunStatus.CANCELLED);
  assert.equal(revoked.budgetGrants, LEASE_LOSS_REFUND_CAP, "a refused refund is not granted");
  const parked = await db.task.findUniqueOrThrow({ where: { id: spent.seeded.task.id } });
  assert.equal(parked.status, TaskStatus.REVIEW);
  assert.match(String(parked.failureReason), /Lease-loss refunds exhausted/u);
  assert.equal(
    (await db.taskActivity.findMany({
      where: {
        taskId: spent.seeded.task.id,
        metadata: { path: ["refusal"], equals: "lease-loss-refunds-exhausted" },
      },
    })).length,
    1,
  );
});

test("the board card carries the refund count beside the budget verdict", async () => {
  const seeded = await seedTask("lease-loss-board");
  await seedRun(seeded, { runNumber: 1, status: RunStatus.LOST, leaseLossRefunds: 0, leaseExpiresAt: null });
  await seedRun(seeded, { runNumber: 2, status: RunStatus.QUEUED, leaseLossRefunds: 2, budgetGrants: 2, maxRunsPerTask: 7 });

  const cards = await readBoard(db, { projectId: seeded.project.id, archived: "false" });
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.leaseLossRefunds, 2);
  assert.equal(cards[0]?.budgetRemaining, true);
});

test("a fourth readiness base-drift requeue parks with the shared refund refusal", async () => {
  const { requeueRegressionSettlement } = await import("./merge-readiness-worker.js");
  const seeded = await seedTask("readiness-refund-sequence");
  const readiness = await db.task.create({ data: {
    projectId: seeded.project.id, name: "Readiness", description: "readiness",
    assigneeAgentId: seeded.agent.id, repoId: seeded.repo.id,
  } });
  await seedRun(seeded, { runNumber: 1, status: RunStatus.SUCCEEDED });
  // Exercise the settlement's transaction body; ownership is already acquired.
  const claim = {
    settle: async (
      tx: import("@anneal/db").Prisma.TransactionClient,
      input: { apply: (tx: import("@anneal/db").Prisma.TransactionClient) => Promise<{ value: unknown }> },
    ) => ({ settled: true, claim: "released", value: (await input.apply(tx)).value }),
  } as unknown as import("./readiness-claim.js").ReadinessClaimHandle;
  for (const attempt of [1, 2, 3, 4]) {
    const prior = await latestRun(seeded.task.id);
    await db.run.update({ where: { id: prior.id }, data: { status: RunStatus.SUCCEEDED } });
    await db.$transaction((tx) => requeueRegressionSettlement({
      readinessTaskId: readiness.id, regressionTaskId: seeded.task.id,
      staleBaseSha: `base-${attempt}`, currentBaseSha: `base-${attempt + 1}`,
      reason: "base drift", now: new Date(), recovery: null,
    }).body(tx, claim));
    assert.equal(await db.run.count({ where: { taskId: seeded.task.id } }), Math.min(attempt + 1, 4));
  }
  for (const id of [seeded.task.id, readiness.id]) {
    const parked = await db.task.findUniqueOrThrow({ where: { id } });
    assert.equal(parked.status, TaskStatus.REVIEW);
    assert.match(String(parked.failureReason), /Lease-loss refunds exhausted/);
    assert.doesNotMatch(String(parked.failureReason), /readiness evaluation failed/);
  }
  assert.equal(await db.taskActivity.count({ where: {
    taskId: seeded.task.id, metadata: { path: ["refusal"], equals: "lease-loss-refunds-exhausted" },
  } }), 1);
});
