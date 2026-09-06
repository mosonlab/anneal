import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  Prisma,
  PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { readBoard } from "./board.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

/**
 * A task's spend cap stops the next attempt.
 *
 * `Task.spendCap` was displayed on Goal and Run projections and compared
 * against nothing: the attempt budgets beside it count attempts, not money, so
 * a task whose attempts cost more than its operator expected spent past its cap
 * without a single decision point noticing. What is asserted here is the
 * refusal at the one place a Run is born, the loud trail it leaves, and the
 * operator's way out.
 */

let db: PrismaClient;
let sequence = 0;

before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-task-spend-cap-token";

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

const seedTask = async (label: string, spendCap: string | null) => {
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
    model: "claude-opus-5",
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
    name: "Capped task",
    description: "spends money",
    assigneeAgentId: agent.id,
    repoId: repo.id,
    status: TaskStatus.DOING,
    spendCap: spendCap === null ? null : new Prisma.Decimal(spendCap),
  } });
  return { project, environment, agent, repo, task };
};

type Seeded = Awaited<ReturnType<typeof seedTask>>;

/** A finished Run whose session reported `costUsd`, which is exactly what the
 *  spend basis charges against the cap. */
const seedCostedRun = async (seeded: Seeded, runNumber: number, costUsd: string | null) => {
  const run = await db.run.create({ data: {
    projectId: seeded.project.id,
    taskId: seeded.task.id,
    agentId: seeded.agent.id,
    repoId: seeded.repo.id,
    runNumber,
    dedupeKey: `task:${seeded.task.id}:run:${runNumber}`,
    runner: "CLAUDE",
    model: "claude-opus-5",
    status: RunStatus.SUCCEEDED,
    targetBranch: seeded.repo.defaultBranch,
    maxRunsPerTask: 20,
  } });
  await db.session.create({ data: {
    projectId: seeded.project.id,
    runId: run.id,
    agentId: seeded.agent.id,
    taskId: seeded.task.id,
    runner: "CLAUDE",
    costUsd: costUsd === null ? null : new Prisma.Decimal(costUsd),
  } });
  return run;
};

test("a task at its spend cap refuses the next attempt by name, and a raised cap queues it", async () => {
  const seeded = await seedTask("task-spend-cap", "1.00");
  await seedCostedRun(seeded, 1, "1.00");
  await seedCostedRun(seeded, 2, "0.50");
  // Never captured is not zero and not large: it simply adds nothing.
  await seedCostedRun(seeded, 3, null);

  const refused = await call("POST", `/tasks/${seeded.task.id}/retry`);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(String(refused.body?.error ?? refused.body?.message ?? ""), /Spend cap \$1\.00 reached/u);
  assert.equal(await db.run.count({ where: { taskId: seeded.task.id } }), 3, "no attempt is queued");

  const parked = await db.task.findUniqueOrThrow({ where: { id: seeded.task.id } });
  assert.equal(parked.status, TaskStatus.REVIEW);
  assert.match(String(parked.failureReason), /Spend cap \$1\.00 reached: \$1\.50 spent/u);
  const named = await db.taskActivity.findMany({
    where: { taskId: seeded.task.id, metadata: { path: ["refusal"], equals: "spend-cap-exhausted" } },
  });
  assert.equal(named.length, 1, "the REVIEW states its reason by name");
  assert.match(String(named[0]?.body), /Spend cap \$1\.00 reached: \$1\.50 spent across 3 runs/u);
  // The committed metadata carries the amounts as data, not only as prose, so
  // an operator filtering the REVIEW reads the cap and the total without
  // parsing the message.
  assert.deepEqual(named[0]?.metadata, {
    refusal: "spend-cap-exhausted",
    spendCapUsd: "1.00",
    spentUsd: "1.50",
    runs: 3,
  });

  // The board shows the limit beside what has been spent against it.
  const cards = await readBoard(db, { projectId: seeded.project.id, archived: "false" });
  assert.deepEqual(cards[0]?.spendCapUsage, { capUsd: "1.00", spentUsd: "1.50", exhausted: true });

  // The operator's way out: raise the cap, retry, and the attempt is queued.
  const patched = await call("PATCH", `/tasks/${seeded.task.id}`, { spendCap: 5 });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const capEdit = await db.taskActivity.findMany({ where: { taskId: seeded.task.id, actorType: "operator" } });
  assert.ok(
    capEdit.some((activity) => /Spend cap: \$1\.00 → \$5\.00/u.test(String(activity.body))),
    "the cap edit names the value the write replaced, read under its own lock",
  );

  const retried = await call("POST", `/tasks/${seeded.task.id}/retry`);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const queued = await db.run.findFirstOrThrow({
    where: { taskId: seeded.task.id }, orderBy: { runNumber: "desc" },
  });
  assert.equal(queued.runNumber, 4);
  assert.equal(queued.status, RunStatus.QUEUED);
  const afterRaise = await readBoard(db, { projectId: seeded.project.id, archived: "false" });
  assert.deepEqual(afterRaise[0]?.spendCapUsage, { capUsd: "5.00", spentUsd: "1.50", exhausted: false });

  // Clearing the cap removes the limit and the projection with it.
  const cleared = await call("PATCH", `/tasks/${seeded.task.id}`, { spendCap: null });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const uncapped = await readBoard(db, { projectId: seeded.project.id, archived: "false" });
  assert.equal(uncapped[0]?.spendCapUsage, null);
  // Removing a spend limit is an operator action and leaves the same trail
  // raising one does; without the locked read it left none at all.
  const clearEdit = await db.taskActivity.findMany({ where: { taskId: seeded.task.id, actorType: "operator" } });
  assert.ok(
    clearEdit.some((activity) => /Spend cap: \$5\.00 → none/u.test(String(activity.body))),
    "clearing the cap is recorded",
  );
});

test("a cap out of the column's range refuses rather than overflowing the database", async () => {
  const seeded = await seedTask("task-spend-cap-range", null);
  const refused = await call("PATCH", `/tasks/${seeded.task.id}`, { spendCap: 1e15 });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: seeded.task.id } })).spendCap,
    null,
    "the refused cap was never written",
  );
});

/**
 * The trail must survive the caller, not just the decision point. Start raises
 * every other Run-birth refusal out of its transaction, which would roll the
 * park back with it and leave a spend cap enforced silently — the operator
 * would see a 409 and a task whose row says nothing about which cap refused it.
 */
test("Start commits the spend-cap park it refuses on, not only Retry", async () => {
  const seeded = await seedTask("task-spend-cap-start", "1.00");
  await db.task.update({ where: { id: seeded.task.id }, data: { status: TaskStatus.TODO } });
  await seedCostedRun(seeded, 1, "1.50");

  const refused = await call("POST", `/tasks/${seeded.task.id}/start`);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(await db.run.count({ where: { taskId: seeded.task.id } }), 1, "no attempt is queued");

  const parked = await db.task.findUniqueOrThrow({ where: { id: seeded.task.id } });
  assert.equal(parked.status, TaskStatus.REVIEW, "the park committed with the refusal");
  assert.match(String(parked.failureReason), /Spend cap \$1\.00 reached: \$1\.50 spent/u);
  const named = await db.taskActivity.findMany({
    where: { taskId: seeded.task.id, metadata: { path: ["refusal"], equals: "spend-cap-exhausted" } },
  });
  assert.equal(named.length, 1, "exactly one activity, written once by the caller");
  assert.match(String(named[0]?.body), /Spend cap \$1\.00 reached: \$1\.50 spent across 1 run/u);

  // And only this code is parked: Start's other refusals leave the task where
  // the operator found it rather than moving it to REVIEW.
  const other = await seedTask("task-spend-cap-start-other", null);
  await db.task.update({
    where: { id: other.task.id },
    data: { status: TaskStatus.TODO, archivedAt: new Date() },
  });
  const archived = await call("POST", `/tasks/${other.task.id}/start`);
  assert.equal(archived.status, 409, JSON.stringify(archived.body));
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: other.task.id } })).status,
    TaskStatus.TODO,
    "an archived-task refusal parks nothing",
  );
});

test("a task under its cap, and a task with no cap, queue their next attempt", async () => {
  const capped = await seedTask("task-spend-cap-room", "10.00");
  await seedCostedRun(capped, 1, "1.50");
  const underCap = await call("POST", `/tasks/${capped.task.id}/retry`);
  assert.equal(underCap.status, 201, JSON.stringify(underCap.body));
  // The retry queues the attempt and re-arms the task rather than parking it.
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: capped.task.id } })).status,
    TaskStatus.TODO,
  );
  assert.equal(
    await db.taskActivity.count({
      where: { taskId: capped.task.id, metadata: { path: ["refusal"], equals: "spend-cap-exhausted" } },
    }),
    0,
    "an attempt under the cap leaves no refusal behind",
  );

  const uncapped = await seedTask("task-spend-cap-absent", null);
  await seedCostedRun(uncapped, 1, "999.00");
  const spent = await call("POST", `/tasks/${uncapped.task.id}/retry`);
  assert.equal(spent.status, 201, JSON.stringify(spent.body));
  const cards = await readBoard(db, { projectId: uncapped.project.id, archived: "false" });
  assert.equal(cards[0]?.spendCapUsage, null);
});
