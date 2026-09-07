import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  enqueueTaskRun,
  PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const RUNNER_TOKEN = "dispatch-drain-runner-token";
const OPERATOR_TOKEN = "dispatch-drain-operator-token";
const RUNNER_ID = "dispatch-drain-runner";
const READY_AT = new Date("2026-08-01T00:00:00.000Z");

let db: PrismaClient;
const previousEnvironment = {
  runner: process.env.RUNNER_TOKEN,
  operator: process.env.OPERATOR_TOKEN,
};

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  for (const [key, value] of [
    ["RUNNER_TOKEN", previousEnvironment.runner],
    ["OPERATOR_TOKEN", previousEnvironment.operator],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const seedQueuedRun = async () => {
  const suffix = randomUUID();
  const project = await db.project.create({ data: {
    name: `Dispatch drain ${suffix}`,
    slug: `dispatch-drain-${suffix}`,
  } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "local",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "dispatch-drain-agent",
    title: "Dispatch drain agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "dispatch-drain-repo",
    remoteUrl: "https://example.test/dispatch-drain.git",
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
  const task = await db.task.create({ data: {
    projectId: project.id,
    assigneeAgentId: agent.id,
    repoId: repo.id,
    name: "Dispatch drain step",
    description: "Dispatch drain fixture",
    status: TaskStatus.TODO,
    maxSessionsPerTask: 5,
  } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx, task.id, READY_AT));
  return { task, run };
};

const claim = async (): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: RUNNER_ID,
      leaseSeconds: 60,
      contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
    }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json().catch(() => null) as any,
  };
};

const runners = async (): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request("/runners", {
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` },
  });
  return { status: response.status, body: await response.json() as any };
};

const openDrain = async (expiresAt: Date, reason = "quiet-window-wait-exceeded host=test-host role=control-plane from=aaaaaaaaaaaa to=bbbbbbbbbbbb") =>
  db.dispatchDrain.create({ data: { reason, requestedBy: "auto-deploy:dispatch-drain-dbtest", expiresAt } });

/** What the drain must leave untouched: the queued Run, the Task it belongs
 * to, and everything `maxSessionsPerTask` is counted from. */
const accounting = async (taskId: string) => ({
  task: await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { status: true, maxSessionsPerTask: true, failureReason: true },
  }),
  runs: await db.run.findMany({
    where: { taskId },
    select: { id: true, status: true, runNumber: true, budgetGrants: true, leaseGeneration: true },
    orderBy: { runNumber: "asc" },
  }),
  sessions: await db.session.count({ where: { taskId } }),
});

test("an unexpired dispatch drain refuses every claim and charges the task nothing", async () => {
  const { task, run } = await seedQueuedRun();
  const before = await accounting(task.id);
  const drain = await openDrain(new Date(Date.now() + 30 * 60_000));

  for (let poll = 0; poll < 3; poll += 1) {
    const refused = await claim();
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.reason, "dispatch-draining");
    assert.equal(refused.body.code, "dispatch-draining");
    assert.equal(refused.body.expiresAt, drain.expiresAt.toISOString());
    assert.match(refused.body.error, /Dispatch is draining for a pending deploy/u);
  }

  // Nothing was parked, nothing was charged, and the Run is still claimable.
  assert.deepEqual(await accounting(task.id), before);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.QUEUED);

  const status = await runners();
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.dispatchDrain, {
    reason: drain.reason,
    startedAt: drain.startedAt.toISOString(),
    expiresAt: drain.expiresAt.toISOString(),
  });
  // The refused runner reported itself on every claim, so it reads as online
  // rather than lost: the drain is what explains the idle fleet.
  assert.deepEqual(
    status.body.daemons.map((daemon: { runnerId: string; online: boolean }) => ({
      runnerId: daemon.runnerId,
      online: daemon.online,
    })),
    [{ runnerId: RUNNER_ID, online: true }],
  );
  assert.equal(status.body.online, 1);
});

test("deleting the drain admits the very next claim", async () => {
  const { task, run } = await seedQueuedRun();
  const drain = await openDrain(new Date(Date.now() + 30 * 60_000));
  assert.equal((await claim()).status, 409);

  await db.dispatchDrain.delete({ where: { id: drain.id } });

  const claimed = await claim();
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.run.id, run.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.CLAIMED);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, TaskStatus.DOING);
  assert.equal((await runners()).body.dispatchDrain, null);
});

test("an expired drain is absent: a dead deploy cannot drain the fleet for good", async () => {
  const { run } = await seedQueuedRun();
  const expired = await openDrain(new Date(Date.now() - 60_000));

  const claimed = await claim();
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.run.id, run.id);
  // The row is still there; it is the deadline, not a delete, that ended it.
  assert.notEqual(await db.dispatchDrain.findUnique({ where: { id: expired.id } }), null);
  assert.equal((await runners()).body.dispatchDrain, null);
});
