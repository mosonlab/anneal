import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  CodexServiceTier,
  DependencyProvisioning,
  NATIVE_IMPLEMENTATION_SUBAGENT_MAX_CONCURRENT,
  NATIVE_IMPLEMENTATION_SUBAGENT_MODEL,
  openRun,
  attemptRunBirth,
  settleRunBirthRefusal,
  Prisma,
  PrismaClient,
  RunnerKind,
  RunnerPreference,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { patchTask } from "./task-patch.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

/**
 * §R5's second half, end to end: a retry after failure with a new assignee has
 * to open its Run with the *new* Agent's configuration.
 *
 * An automatic retry normally replays the prior Run's snapshot, which is right
 * while the assignee is unchanged and wrong the moment an operator has moved
 * the task — the whole point of moving it is that the next attempt runs
 * somewhere else. Only a database test can show both halves: the reassignment
 * has to be accepted by the real PATCH guard (terminal Run history), and the
 * Run has to be born from the real `openRun` derivation.
 *
 * Environment: the scratch PostgreSQL the other `*.dbtest.ts` files use
 * (`AGENTOS_ALLOW_SCRATCH_DATABASES=1`, `TEST_DATABASE_URL`,
 * `TEST_DATABASE_MAINTENANCE_URL`); see `src/testdb.ts`.
 */

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

let sequence = 0;

const seed = async (options: { compoundStep?: boolean } = {}) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Retry", slug: `retry-${suffix}` } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const failing = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `senior-dev-opus-medium-${suffix}`,
    title: "Senior Dev",
    model: "claude-opus-5:medium",
    runnerPreference: RunnerPreference.CLAUDE,
    codexServiceTier: CodexServiceTier.DEFAULT,
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const successor = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `plan-executor-astra-medium-${suffix}`,
    title: "Plan Executor",
    model: "gpt-6-astra:medium",
    runnerPreference: RunnerPreference.CODEX,
    codexServiceTier: CodexServiceTier.FAST,
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: `retry-repo-${suffix}`,
    remoteUrl: "https://example.test/retry.git",
    mountPath: "/repo",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  for (const agent of [failing, successor]) {
    await db.agentRepoAccess.create({ data: {
      projectId: project.id,
      agentId: agent.id,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: "GIT_WRITE",
    } });
  }
  // The compound implementation root is the step whose native subagent
  // configuration a reassignment has to re-derive; §R14 also requires its
  // assignee to be a Codex gpt-* Agent, so only that case uses it.
  const template = options.compoundStep === true
    ? await db.taskTemplate.create({ data: {
      projectId: project.id,
      name: "compound-engineer-workflow",
      description: "Retry regression",
      variables: [],
    } })
    : null;
  const step = template === null ? null : await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    stepIndex: 5,
    layer: 5,
    name: "Implementation",
    assigneeType: "AGENT",
    assigneeAgentId: successor.id,
    prompt: "implement",
    outputKind: "implementation",
  } });
  const task = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    name: "Implement the plan",
    description: "work",
    assigneeAgentId: failing.id,
    status: TaskStatus.DOING,
    ...(template === null ? {} : { templateId: template.id, templateStepId: step!.id }),
    targetBranch: "main",
  } });
  const priorRun = await db.run.create({ data: {
    projectId: project.id,
    taskId: task.id,
    agentId: failing.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${task.id}:run:1`,
    status: RunStatus.FAILED,
    runner: RunnerKind.CLAUDE,
    model: failing.model,
    codexServiceTier: CodexServiceTier.DEFAULT,
    promptHash: "prior",
    branch: `agentos/${task.id}/run-1`,
    targetBranch: "main",
    maxRunsPerTask: 5,
    budgetGrants: 0,
    endedAt: new Date(),
    retryable: true,
  } });
  return { project, failing, successor, repo, task, priorRun };
};

test("a retry after failure with a new assignee runs the new agent's configuration", async () => {
  const { failing, successor, task, priorRun } = await seed({ compoundStep: true });

  // The failed Run is terminal, so the assignment freeze does not apply.
  const reassigned = await patchTask(db, task.id, { assigneeAgentId: successor.id });
  assert.ok("task" in reassigned, JSON.stringify(reassigned));
  assert.equal(reassigned.task.assigneeAgentId, successor.id);

  const opened = await db.$transaction(async (tx) => openRun(tx, task.id, {
    kind: "retry-after-completion",
    readyAt: new Date(),
    sourceRunId: priorRun.id,
    sourceMaxRunsPerTask: priorRun.maxRunsPerTask,
    sourceBudgetGrants: priorRun.budgetGrants,
    budgetGrant: 1,
  }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  assert.equal(opened.ok, true, opened.ok ? "" : opened.refusal.message);
  const run = await db.run.findUniqueOrThrow({ where: { id: opened.ok ? opened.run.id : "" } });
  assert.deepEqual({
    agentId: run.agentId,
    runner: run.runner,
    model: run.model,
    codexServiceTier: run.codexServiceTier,
    subagentModel: run.subagentModel,
    subagentMaxConcurrent: run.subagentMaxConcurrent,
  }, {
    agentId: successor.id,
    runner: RunnerKind.CODEX,
    model: "gpt-6-astra:medium",
    codexServiceTier: CodexServiceTier.FAST,
    subagentModel: NATIVE_IMPLEMENTATION_SUBAGENT_MODEL,
    subagentMaxConcurrent: NATIVE_IMPLEMENTATION_SUBAGENT_MAX_CONCURRENT,
  });
  // The Run the previous Agent failed is untouched history.
  const prior = await db.run.findUniqueOrThrow({ where: { id: priorRun.id } });
  assert.equal(prior.agentId, failing.id);
  assert.equal(prior.model, "claude-opus-5:medium");
});

test("a retry with the assignee unchanged still replays the prior Run's configuration", async () => {
  const { failing, task, priorRun } = await seed();

  const opened = await db.$transaction(async (tx) => openRun(tx, task.id, {
    kind: "retry-after-completion",
    readyAt: new Date(),
    sourceRunId: priorRun.id,
    sourceMaxRunsPerTask: priorRun.maxRunsPerTask,
    sourceBudgetGrants: priorRun.budgetGrants,
    budgetGrant: 1,
  }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  assert.equal(opened.ok, true, opened.ok ? "" : opened.refusal.message);
  const run = await db.run.findUniqueOrThrow({ where: { id: opened.ok ? opened.run.id : "" } });
  assert.equal(run.agentId, failing.id);
  assert.equal(run.runner, RunnerKind.CLAUDE);
  assert.equal(run.model, "claude-opus-5:medium");
});


test("refusal settlement commits a park after birth rollback and leaves no trace when raised", async () => {
  const { task, failing } = await seed();
  await db.agent.update({ where: { id: failing.id }, data: { archivedAt: new Date() } });
  const now = new Date();
  const settle = async (mode: "park" | "raise") => db.$transaction(async (tx) => {
    const attempt = await attemptRunBirth(tx, (client) => openRun(client, task.id, { kind: "retry", readyAt: now }));
    assert.equal(attempt.outcome, "refused");
    if (attempt.outcome !== "refused") throw new Error("Expected archived-assignee refusal");
    const settlement = await settleRunBirthRefusal(tx, {
      taskId: task.id, refusal: attempt.refusal, mode, origin: { kind: "request" }, now,
    });
    if (settlement.kind === "raise") throw settlement.error;
    return settlement;
  });
  await assert.rejects(settle("raise"), /archived/i);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, TaskStatus.DOING);
  assert.equal(await db.taskActivity.count({ where: { taskId: task.id } }), 0);
  assert.equal(await db.inboxMessage.count({ where: { taskId: task.id } }), 0);
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 1);

  assert.deepEqual(await settle("park"), { kind: "parked" });
  const parked = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(parked.status, TaskStatus.REVIEW);
  assert.match(parked.failureReason ?? "", /archived/i);
  const activity = await db.taskActivity.findFirstOrThrow({ where: { taskId: task.id } });
  assert.deepEqual(activity.metadata, { refusal: "assignee-archived" });
  const notice = await db.inboxMessage.findFirstOrThrow({ where: { taskId: task.id } });
  assert.match(notice.body, /archived/i);
  assert.equal(notice.dedupeKey, `run-birth-refusal:${task.id}:assignee-archived`);
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 1);
  // Replaying the refusal reopens the same notice, including after an answer.
  await db.inboxMessage.update({ where: { id: notice.id }, data: { status: "ANSWERED", answeredAt: now } });
  await settle("park");
  assert.equal(await db.inboxMessage.count({ where: { taskId: task.id } }), 1);
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: notice.id } })).status, "OPEN");
});
