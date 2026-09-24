import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, RunStatus, TaskStatus } from "@anneal/db";

import { patchTask } from "./task-patch.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

/**
 * The seam itself. Every other test of this behaviour drives it over HTTP,
 * where a refusal is only ever a status code and a body; here the refusal is
 * the return value, so a test can ask for one without constructing a request.
 */

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const waitForDatabaseLockWaiter = async (): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [waiting] = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    if ((waiting?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for the PATCH to reach the Task-row mutex");
};

let sequence = 0;
const seed = async (overrides: {
  chainId?: string;
  archivedAt?: Date | null;
  status?: TaskStatus;
  outputKind?: string;
} = {}) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Patch", slug: `patch-${suffix}` } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: `agent-${suffix}`, title: "Agent",
    model: "gpt-5.6-sol:high", runnerPreference: "CODEX", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const template = overrides.outputKind === undefined
    ? null
    : await db.taskTemplate.create({
      data: { projectId: project.id, name: `patch-template-${suffix}`, description: "Patch", variables: [] },
    });
  const templateStep = template === null
    ? null
    : await db.taskTemplateStep.create({
      data: {
        taskTemplateId: template.id,
        stepIndex: 1,
        name: "Gate slot",
        assigneeType: "AGENT",
        prompt: "Gate slot",
        ...(overrides.outputKind === undefined ? {} : { outputKind: overrides.outputKind }),
        layer: 1,
      },
    });
  const task = await db.task.create({ data: {
    projectId: project.id, name: "Patchable", description: "work",
    assigneeAgentId: agent.id, status: overrides.status ?? TaskStatus.TODO,
    chainId: overrides.chainId ?? null,
    ...(overrides.chainId ? { chainIndex: 0, chainLayer: 0 } : {}),
    ...(template === null ? {} : { templateId: template.id, templateStepId: templateStep!.id }),
    archivedAt: overrides.archivedAt ?? null,
  } });
  return { project, agent, task };
};

test("a non-slot dispatched chain task refuses an approval-gate patch", async () => {
  const { task } = await seed({ chainId: `chain-${process.pid}` });
  const result = await patchTask(db, task.id, { approvalGate: true });
  assert.deepEqual(result, {
    reason: "conflict",
    message: "Only the specification and merge readiness steps carry a configurable gate",
  });
});

test("TODO gate slots accept on/off changes and record the operator activity", async () => {
  for (const [outputKind, slot] of [["spec", "spec"], ["merge-authorization-v2", "merge"]] as const) {
    const { task } = await seed({ chainId: `${slot}-${process.pid}`, outputKind });

    const enabled = await patchTask(db, task.id, { approvalGate: true });
    assert.ok("task" in enabled);
    assert.equal(enabled.task.approvalGate, true);
    assert.deepEqual(await db.taskActivity.findMany({
      where: { taskId: task.id },
      select: { actorType: true, body: true },
    }), [{ actorType: "operator", body: `Approval gate changed: ${slot} = true` }]);

    const disabled = await patchTask(db, task.id, { approvalGate: false });
    assert.ok("task" in disabled);
    assert.equal(disabled.task.approvalGate, false);
    assert.deepEqual(await db.taskActivity.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "asc" },
      select: { actorType: true, body: true },
    }), [
      { actorType: "operator", body: `Approval gate changed: ${slot} = true` },
      { actorType: "operator", body: `Approval gate changed: ${slot} = false` },
    ]);
  }
});

test("a slot past TODO is refused with its locked actual state", async () => {
  for (const status of [TaskStatus.DOING, TaskStatus.REVIEW, TaskStatus.DONE]) {
    const { task } = await seed({ chainId: `${status}-${process.pid}`, outputKind: "spec", status });
    const result = await patchTask(db, task.id, { approvalGate: true });
    assert.deepEqual(result, {
      reason: "conflict",
      message: `The specification gate is already ${status}; approval gates may only be changed while the step is TODO`,
    });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).approvalGate, false);
    assert.equal(await db.taskActivity.count({ where: { taskId: task.id } }), 0);
  }
});

test("an approval-gate PATCH loses the race when the locked slot has already started", { timeout: 10_000 }, async () => {
  const { task } = await seed({ chainId: `gate-race-${process.pid}`, outputKind: "spec" });
  let releaseHolder!: () => void;
  let holderReady!: () => void;
  const release = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const ready = new Promise<void>((resolve) => { holderReady = resolve; });
  const holder = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${task.id} FOR UPDATE`;
    await tx.task.update({
      where: { id: task.id },
      data: { approvalGate: true, status: TaskStatus.DOING },
    });
    holderReady();
    await release;
  });
  await ready;

  const patching = patchTask(db, task.id, { approvalGate: false });
  try {
    await waitForDatabaseLockWaiter();
  } finally {
    releaseHolder();
  }
  await holder;

  const result = await patching;
  assert.deepEqual(result, {
    reason: "conflict",
    message: "The specification gate is already DOING; approval gates may only be changed while the step is TODO",
  });
  const persisted = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(persisted.approvalGate, true);
  assert.equal(persisted.status, TaskStatus.DOING);
  assert.equal(await db.taskActivity.count({ where: { taskId: task.id } }), 0);
});

test("a standalone task keeps its existing approval-gate edit behaviour", async () => {
  const { task } = await seed();
  const result = await patchTask(db, task.id, { approvalGate: true });
  assert.ok("task" in result);
  assert.equal(result.task.approvalGate, true);
  assert.equal(await db.taskActivity.count({ where: { taskId: task.id } }), 0);
});

test("an assignee from another project is refused with 400", async () => {
  const { task } = await seed();
  const other = await seed();
  const result = await patchTask(db, task.id, { assigneeAgentId: other.agent.id });
  assert.deepEqual(result, { reason: "invalid-request", message: "Assignee does not belong to this project" });
});

test("an archived task refuses a status write from inside the transaction", async () => {
  const { task } = await seed({ archivedAt: new Date() });
  const result = await patchTask(db, task.id, { status: TaskStatus.DONE });
  assert.deepEqual(result, {
    reason: "conflict",
    message: "Cannot change the status of an archived task; unarchive it first",
  });
});

test("an active Run refuses a move to Backlog from inside the transaction", async () => {
  const { project, agent, task } = await seed();
  await db.run.create({ data: {
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
    runNumber: 1,
    dedupeKey: `task:${task.id}:run:1`,
    status: RunStatus.QUEUED,
    runner: "CODEX",
    model: agent.model,
    promptHash: "hash",
    branch: `codex/${task.id}`,
    workspacePath: `/scratch/${task.id}`,
  } });

  const result = await patchTask(db, task.id, { status: TaskStatus.BACKLOG });

  assert.deepEqual(result, {
    reason: "conflict",
    message: "Cannot move a task with an active run to Backlog",
  });
});

test("an archived stored assignee refuses Backlog reactivation", async () => {
  const { agent, task } = await seed({ status: TaskStatus.BACKLOG });
  await db.agent.update({ where: { id: agent.id }, data: { archivedAt: new Date() } });

  const result = await patchTask(db, task.id, { status: TaskStatus.TODO });

  assert.deepEqual(result, {
    reason: "conflict",
    message: `Assignee ${agent.name} is archived; unarchive the agent or reassign this task first`,
  });
});

test("an accepted patch returns the written task rather than a response", async () => {
  const { task } = await seed();
  const result = await patchTask(db, task.id, { name: "Renamed" });
  assert.ok("task" in result, "expected the written task");
  assert.equal(result.task.name, "Renamed");
});

/**
 * §R5 under real concurrency: a reassignment and a run enqueue both take the
 * Task row, so exactly one of them decides.
 *
 * The unit tests prove the predicate; only the database can prove the
 * serialization, because the refusal depends on a `Run` row another transaction
 * committed while this one was already waiting on the Task mutex — the exact
 * read ReadCommitted would otherwise answer from a stale snapshot.
 */
const successorAgent = async (projectId: string, environmentId: string) => {
  sequence += 1;
  return db.agent.create({ data: {
    projectId,
    environmentId,
    name: `successor-${process.pid}-${sequence}`,
    title: "Successor",
    model: "gpt-6-astra:medium",
    runnerPreference: "CODEX",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
};

test("a reassignment racing a run enqueue loses to the run that committed first", { timeout: 10_000 }, async () => {
  const { project, agent, task } = await seed();
  const successor = await successorAgent(project.id, agent.environmentId!);
  let releaseHolder!: () => void;
  let holderReady!: () => void;
  const release = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const ready = new Promise<void>((resolve) => { holderReady = resolve; });
  const enqueue = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${task.id} FOR UPDATE`;
    await tx.run.create({ data: {
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      runNumber: 1,
      dedupeKey: `task:${task.id}:run:1`,
      status: RunStatus.QUEUED,
      runner: "CODEX",
      model: agent.model,
      promptHash: "hash",
      branch: `codex/${task.id}`,
      workspacePath: `/scratch/${task.id}`,
    } });
    holderReady();
    await release;
  });
  await ready;

  const patching = patchTask(db, task.id, { assigneeAgentId: successor.id });
  try {
    await waitForDatabaseLockWaiter();
  } finally {
    releaseHolder();
  }
  await enqueue;

  const result = await patching;
  assert.deepEqual(result, {
    reason: "conflict",
    message: `Cannot change the assignee while run 1 is ${RunStatus.QUEUED}; stop or finish it first`,
  });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeAgentId, agent.id);
});

test("a reassignment that wins the Task mutex is the assignment the next run opens with", { timeout: 10_000 }, async () => {
  const { project, agent, task } = await seed();
  const successor = await successorAgent(project.id, agent.environmentId!);
  let releaseHolder!: () => void;
  let holderReady!: () => void;
  const release = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const ready = new Promise<void>((resolve) => { holderReady = resolve; });
  // The holder takes the same mutex and commits no Run, so the waiting PATCH
  // observes an empty active set the instant it is admitted.
  const holder = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${task.id} FOR UPDATE`;
    holderReady();
    await release;
  });
  await ready;

  const patching = patchTask(db, task.id, { assigneeAgentId: successor.id });
  try {
    await waitForDatabaseLockWaiter();
  } finally {
    releaseHolder();
  }
  await holder;

  const result = await patching;
  assert.ok("task" in result);
  assert.equal(result.task.assigneeAgentId, successor.id);
  const opened = await db.run.create({ data: {
    projectId: project.id,
    taskId: task.id,
    agentId: (await db.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeAgentId!,
    runNumber: 1,
    dedupeKey: `task:${task.id}:run:1`,
    status: RunStatus.QUEUED,
    runner: "CODEX",
    model: successor.model,
    promptHash: "hash",
    branch: `codex/${task.id}`,
    workspacePath: `/scratch/${task.id}`,
  } });
  assert.equal(opened.agentId, successor.id);
});
