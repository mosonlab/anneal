import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  DependencyProvisioning,
  LEASE_LOSS_REFUND_CAP,
  PrismaClient,
  RunStatus,
  RunnerKind,
  TaskStatus,
} from "@anneal/db";

import { reconcileDatabaseRuns } from "./reconcile.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
let sequence = 0;

before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-regression-retry-reset-token";

const asOperator = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    return await operation();
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const seedRegressionAtLeaseLossCap = async () => {
  const suffix = `${process.pid}-${sequence++}`;
  const project = await db.project.create({ data: { name: "Regression retry", slug: `regression-retry-${suffix}` } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "local",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `regression-agent-${suffix}`,
    title: "Regression agent",
    model: "gpt-5.6-sol:high",
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
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: `direct-engineer-workflow-${suffix}`,
    description: "Regression retry fixture",
    variables: [],
  } });
  const step = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    stepIndex: 0,
    layer: 0,
    name: "Regression",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agent.id,
    prompt: "verify",
    approvalGate: false,
    outputKind: "regression-verification-v2",
    opensPullRequest: false,
    requiresCommit: false,
  } });
  const task = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    templateId: template.id,
    templateStepId: step.id,
    name: "Regression",
    description: "verify",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agent.id,
    status: TaskStatus.DOING,
    failureReason: null,
    targetBranch: "main",
  } });
  await db.task.update({ where: { id: task.id }, data: { maxSessionsPerTask: 1 } });
  const sourceRun = await db.run.create({ data: {
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${task.id}:run:1`,
    runner: RunnerKind.CODEX,
    model: agent.model,
    status: RunStatus.QUEUED,
    branch: `agentos/${task.id}/run-1`,
    targetBranch: "main",
    maxRunsPerTask: 1,
    budgetGrants: 0,
    leaseLossRefunds: 0,
  } });
  return { project, task, sourceRun };
};

test("Regression operator retry resets lease-loss refunds on its replacement Run", async () => {
  const seeded = await seedRegressionAtLeaseLossCap();

  const loseLatestRun = async (at: Date): Promise<void> => {
    const latest = await db.run.findFirstOrThrow({
      where: { taskId: seeded.task.id },
      orderBy: { runNumber: "desc" },
    });
    await db.run.update({ where: { id: latest.id }, data: {
      status: RunStatus.RUNNING,
      startedAt: new Date(at.getTime() - 30 * 60_000),
      heartbeatAt: null,
      leaseExpiresAt: new Date(at.getTime() - 60_000),
    } });
  };

  const start = new Date("2026-09-07T06:00:00.000Z");
  for (const attempt of [0, 1, 2]) {
    const at = new Date(start.getTime() + attempt * 60 * 60_000);
    await loseLatestRun(at);
    assert.ok(await reconcileDatabaseRuns(db, at) > 0, `reconciliation ${attempt}`);

    const replacement = await db.run.findFirstOrThrow({
      where: { taskId: seeded.task.id },
      orderBy: { runNumber: "desc" },
    });
    assert.equal(replacement.status, RunStatus.QUEUED);
    assert.equal(replacement.leaseLossRefunds, attempt + 1);
    assert.equal(replacement.targetBranch, "main", "the replacement keeps the target snapshot");
  }

  const fourth = new Date(start.getTime() + 3 * 60 * 60_000);
  await loseLatestRun(fourth);
  assert.ok(await reconcileDatabaseRuns(db, fourth) > 0, "the capped loss is reconciled");

  const parked = await db.task.findUniqueOrThrow({ where: { id: seeded.task.id } });
  assert.equal(parked.status, TaskStatus.REVIEW);
  assert.match(String(parked.failureReason), /Lease-loss refunds exhausted/u);
  const cappedRun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.task.id },
    orderBy: { runNumber: "desc" },
  });
  assert.equal(cappedRun.status, RunStatus.LOST);
  assert.equal(cappedRun.leaseLossRefunds, LEASE_LOSS_REFUND_CAP);

  // The ordinary retry is refused while the operator's configured budget is
  // still exhausted. This exercises the real openRun refusal path and proves
  // the reset has no partial write to roll back.
  const refused = await asOperator(() => createApp(db).request(`/tasks/${seeded.task.id}/retry`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR}` },
  }));
  const refusedBody = await refused.text();
  assert.equal(refused.status, 409, refusedBody);
  assert.match(refusedBody, /Run budget exhausted/u);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: cappedRun.id } })).leaseLossRefunds, LEASE_LOSS_REFUND_CAP);
  assert.equal(await db.taskActivity.count({
    where: { taskId: seeded.task.id, body: { startsWith: "Lease-loss refund counter reset" } },
  }), 0);

  const patched = await asOperator(() => createApp(db).request(`/tasks/${seeded.task.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    body: JSON.stringify({ maxSessionsPerTask: 9 }),
  }));
  assert.equal(patched.status, 200, await patched.text());

  const response = await asOperator(() => createApp(db).request(`/tasks/${seeded.task.id}/retry`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR}` },
  }));
  assert.equal(response.status, 201, await response.text());

  const runs = await db.run.findMany({ where: { taskId: seeded.task.id }, orderBy: { runNumber: "asc" } });
  assert.equal(runs.length, 5);
  assert.equal(runs[0]?.id, seeded.sourceRun.id);
  assert.equal(runs[0]?.leaseLossRefunds, 0);
  assert.deepEqual(runs.slice(0, 4).map((run) => run.status), [
    RunStatus.LOST,
    RunStatus.LOST,
    RunStatus.LOST,
    RunStatus.LOST,
  ]);
  assert.equal(runs[3]?.leaseLossRefunds, LEASE_LOSS_REFUND_CAP);
  assert.equal(runs[4]?.status, RunStatus.QUEUED);
  assert.equal(runs[4]?.leaseLossRefunds, 0);
  assert.equal(runs[4]?.targetBranch, "main", "the operator retry keeps the target snapshot");

  const reset = await db.taskActivity.findFirstOrThrow({
    where: { taskId: seeded.task.id, body: { startsWith: "Lease-loss refund counter reset" } },
  });
  assert.equal(reset.actorType, "operator");
  assert.deepEqual(reset.metadata, { kind: "lease-loss-refunds-reset", previous: 3, current: 0 });
  assert.equal(await db.taskActivity.count({
    where: { taskId: seeded.task.id, body: { contains: "queued by operator retry" } },
  }), 1);
});
