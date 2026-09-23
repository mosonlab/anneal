import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  DependencyProvisioning,
  enqueueTaskRun,
  FailureClass,
  PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const RUNNER_TOKEN = "merge-tail-stop-notice-runner";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const BRANCH = "agentos/stop-notice-test";
const STOP_REASON = "regression repair handoff is invalid: no successful gate-fix result binds "
  + `${HEAD} to ${BASE}`;
const STOP_DEDUPE_PREFIX = "merge-tail-stop:";

const priorRunnerToken = process.env.RUNNER_TOKEN;
let db: PrismaClient;
let seedCounter = 0;

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
});

const claim = (client: PrismaClient, runnerId: string) => createApp(client).request("/runner/tasks/claim", {
  method: "POST",
  headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ runnerId, leaseSeconds: 60 }),
});

/**
 * A Regression step whose only prior evidence is a negative verdict with no
 * repair result behind it: the claim path judges its handoff invalid, stops the
 * tail, and writes the stop notice. Re-queueing it reproduces the incident,
 * because the second stop carries the same task and the same reason.
 */
const seedInvalidHandoffRegression = async () => {
  const seedId = `${Date.now()}-${(seedCounter += 1)}`;
  const project = await db.project.create({ data: { name: "Stop notice", slug: `stop-notice-${seedId}` } });
  const environment = await db.environment.create({ data: {
    projectId: project.id, name: "local", allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "code-reviewer-sol-high",
    title: "Regression",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "widgets",
    remoteUrl: "https://example.test/widgets.git",
    mountPath: "/repo",
    defaultBranch: "main",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE",
  } });
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id, name: `stop-notice-workflow-${seedId}`, description: "tail", variables: [],
  } });
  const regressionStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    stepIndex: 5,
    layer: 4,
    name: "Regression",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agent.id,
    prompt: "verify",
    approvalGate: false,
    outputKind: "regression-verification",
  } });
  const regression = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    templateId: template.id,
    templateStepId: regressionStep.id,
    name: "Regression",
    description: "verify",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agent.id,
    status: TaskStatus.TODO,
    targetBranch: BRANCH,
  } });
  const firstRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, regression.id));
  await db.run.update({
    where: { id: firstRun.id },
    data: { status: RunStatus.SUCCEEDED, branch: BRANCH, headSha: HEAD, endedAt: new Date() },
  });
  await db.taskStepOutput.create({ data: {
    taskId: regression.id,
    runId: firstRun.id,
    kind: "regression-verification",
    commitSha: HEAD,
    body: JSON.stringify({
      schemaVersion: 1,
      outcome: "gate-fail",
      gateVerdict: "FAIL",
      headSha: HEAD,
      baseHeadSha: BASE,
      summary: "merge gate FAIL on the chain head",
    }),
  } });
  return { project, environment, agent, repo, regression };
};

/** The re-queue an operator performs after the chain stops. */
const requeueRegression = async (
  seeded: Awaited<ReturnType<typeof seedInvalidHandoffRegression>>,
  readyAt: Date,
) => {
  await db.task.update({
    where: { id: seeded.regression.id },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx as never, seeded.regression.id, readyAt));
  await db.run.update({ where: { id: run.id }, data: { branch: BRANCH } });
  return run;
};

const seedUnrelatedQueuedRun = async (
  seeded: Awaited<ReturnType<typeof seedInvalidHandoffRegression>>,
  readyAt: Date,
) => {
  const task = await db.task.create({ data: {
    projectId: seeded.project.id,
    repoId: seeded.repo.id,
    name: "Unrelated queued work",
    description: "unrelated",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: seeded.agent.id,
    status: TaskStatus.TODO,
  } });
  return db.$transaction((tx) => enqueueTaskRun(tx as never, task.id, readyAt));
};

const assertStopSettled = async (
  seeded: Awaited<ReturnType<typeof seedInvalidHandoffRegression>>,
  runId: string,
) => {
  const [run, task, notices] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: runId } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
    db.inboxMessage.findMany({
      where: { taskId: seeded.regression.id, dedupeKey: { startsWith: STOP_DEDUPE_PREFIX } },
    }),
  ]);
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(run.failureClass, FailureClass.TASK_FAILED);
  assert.equal(run.failureReason, STOP_REASON);
  assert.equal(run.retryable, false);
  assert.equal(task.status, TaskStatus.REVIEW);
  assert.equal(task.failureReason, STOP_REASON);
  // One row per (task, reason) is the intended state of a digest, so the repeat
  // stop settles against the row the first one wrote instead of colliding.
  assert.equal(notices.length, 1);
  assert.equal(
    notices[0]!.dedupeKey,
    `${STOP_DEDUPE_PREFIX}${seeded.regression.id}:${createHash("sha256").update(STOP_REASON).digest("hex")}`,
  );
  assert.match(notices[0]!.body, /^推荐：需调查/u);
  assert.ok(notices[0]!.body.includes(`Autonomous merge tail stopped: ${STOP_REASON}`));
};

test("a repeated same-reason merge-tail stop settles its run and leaves the queue claimable", async () => {
  const seeded = await seedInvalidHandoffRegression();
  const firstStopped = await requeueRegression(seeded, new Date("2026-01-01T00:00:00.000Z"));

  assert.equal((await claim(db, "first-stop-runner")).status, 204);
  await assertStopSettled(seeded, firstStopped.id);

  // The operator retry, racing ahead of an unrelated queued run so the poisoned
  // candidate is the head of the queue this poll observes.
  const secondStopped = await requeueRegression(seeded, new Date("2026-01-01T00:00:01.000Z"));
  const unrelated = await seedUnrelatedQueuedRun(seeded, new Date("2026-01-01T00:00:02.000Z"));

  const response = await claim(db, "repeat-stop-runner");
  assert.equal(response.status, 200);
  const claimed = await response.json() as { run: { id: string } };
  assert.equal(claimed.run.id, unrelated.id);
  await assertStopSettled(seeded, secondStopped.id);
});

test("a candidate that raises is isolated from the rest of the claim queue", async () => {
  const seeded = await seedInvalidHandoffRegression();
  const poisoned = await requeueRegression(seeded, new Date("2026-01-01T00:00:00.000Z"));
  const unrelated = await seedUnrelatedQueuedRun(seeded, new Date("2026-01-01T00:00:01.000Z"));
  const failingDb = db.$extends({
    query: {
      inboxMessage: {
        async upsert() {
          throw new Error("stop-notice-write-failed");
        },
      },
    },
  }) as unknown as PrismaClient;

  const response = await claim(failingDb, "isolation-runner");
  assert.equal(response.status, 200);
  const claimed = await response.json() as { run: { id: string } };
  assert.equal(claimed.run.id, unrelated.id);

  // The poisoned candidate's own writes are rolled back to its savepoint, so it
  // is left exactly as it was found rather than half settled.
  const [poisonedRun, task, notices] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: poisoned.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
    db.inboxMessage.count({ where: { taskId: seeded.regression.id } }),
  ]);
  assert.equal(poisonedRun.status, RunStatus.QUEUED);
  assert.equal(poisonedRun.failureReason, null);
  assert.equal(task.status, TaskStatus.TODO);
  assert.equal(notices, 0);
});

test("an isolated candidate error surfaces when the poll claims nothing", async () => {
  const seeded = await seedInvalidHandoffRegression();
  const poisoned = await requeueRegression(seeded, new Date("2026-01-01T00:00:00.000Z"));
  const failingDb = db.$extends({
    query: {
      inboxMessage: {
        async upsert() {
          throw new Error("stop-notice-write-failed");
        },
      },
    },
  }) as unknown as PrismaClient;

  assert.equal((await claim(failingDb, "surfacing-runner")).status, 500);
  const poisonedRun = await db.run.findUniqueOrThrow({ where: { id: poisoned.id } });
  assert.equal(poisonedRun.status, RunStatus.QUEUED);
});
