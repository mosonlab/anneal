import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
  GoalDispatchState,
  MergeLeaseEventState,
  Prisma,
  RepoPermission,
  RunStatus,
  type PrismaClient,
} from "@anneal/db";

import { instantiateTemplate } from "./templates.js";
import { runDbScript } from "./test-db-script.js";
import { resetTestDb, setupTestDb } from "./testdb.js";
import { createApp } from "./test-app.js";

let db: PrismaClient;
const OPERATOR = "operator-project-delete-token";
const priorOperatorToken = process.env.OPERATOR_TOKEN;

before(() => {
  process.env.OPERATOR_TOKEN = OPERATOR;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
});

const call = async (
  method: "DELETE" | "POST",
  path: string,
  requestBody?: unknown,
): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
};

const createProject = async (slug: string): Promise<{ id: string }> => {
  const response = await call("POST", "/projects", {
    name: `Project ${slug}`,
    slug,
    yamlDocument: "",
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { id: response.body.id as string };
};

/**
 * These are every Prisma model with a projectId column. Keep this list
 * explicit: a newly added project-scoped model should make this test fail
 * loudly until the delete operation and its isolation assertion are updated.
 */
const projectCounts = async (projectId: string): Promise<Record<string, number>> => Object.fromEntries(await Promise.all(([
  ["Environment", db.environment.count({ where: { projectId } })],
  ["Agent", db.agent.count({ where: { projectId } })],
  ["Skill", db.skill.count({ where: { projectId } })],
  ["AgentSkill", db.agentSkill.count({ where: { projectId } })],
  ["MCPConnection", db.mCPConnection.count({ where: { projectId } })],
  ["AgentMCPConnection", db.agentMCPConnection.count({ where: { projectId } })],
  ["Repo", db.repo.count({ where: { projectId } })],
  ["AgentRepoAccess", db.agentRepoAccess.count({ where: { projectId } })],
  ["AgentCollaboration", db.agentCollaboration.count({ where: { projectId } })],
  ["TaskTemplate", db.taskTemplate.count({ where: { projectId } })],
  ["StaffingProfile", db.staffingProfile.count({ where: { projectId } })],
  ["Task", db.task.count({ where: { projectId } })],
  ["ChainControl", db.chainControl.count({ where: { projectId } })],
  ["MergeLeaseEvent", db.mergeLeaseEvent.count({ where: { projectId } })],
  ["Goal", db.goal.count({ where: { projectId } })],
  ["Run", db.run.count({ where: { projectId } })],
  ["Session", db.session.count({ where: { projectId } })],
] as const).map(async ([name, count]) => [name, await count])));

const relationOwnedCounts = async (projectId: string): Promise<Record<string, number>> => ({
  Project: await db.project.count({ where: { id: projectId } }),
  AgentSecretGrant: await db.agentSecretGrant.count({ where: { agent: { projectId } } }),
  FilesystemGrant: await db.filesystemGrant.count({ where: { agent: { projectId } } }),
  EnvironmentSecret: await db.environmentSecret.count({ where: { environment: { projectId } } }),
  StaffingProfileEntry: await db.staffingProfileEntry.count({ where: { profile: { projectId } } }),
  StaffingProfileTier: await db.staffingProfileTier.count({ where: { profile: { projectId } } }),
  TaskTemplateStep: await db.taskTemplateStep.count({ where: { taskTemplate: { projectId } } }),
  TriggerFire: await db.triggerFire.count({ where: { template: { projectId } } }),
  TaskStepOutput: await db.taskStepOutput.count({ where: { task: { projectId } } }),
  MergeGateAttestation: await db.mergeGateAttestation.count({ where: { task: { projectId } } }),
  MergeRecoveryAttempt: await db.mergeRecoveryAttempt.count({ where: { integratorTask: { projectId } } }),
  TaskActivity: await db.taskActivity.count({ where: { task: { projectId } } }),
  ChainControlEvent: await db.chainControlEvent.count({ where: { chainControl: { projectId } } }),
  MergeLeaseEvent: await db.mergeLeaseEvent.count({ where: { projectId } }),
  GoalDefinitionItem: await db.goalDefinitionItem.count({ where: { goal: { projectId } } }),
  GoalProgressEntry: await db.goalProgressEntry.count({ where: { goal: { projectId } } }),
  GoalExecutionEvent: await db.goalExecutionEvent.count({ where: {
    OR: [{ goal: { projectId } }, { task: { projectId } }, { run: { projectId } }],
  } }),
  SessionEvent: await db.sessionEvent.count({ where: { session: { projectId } } }),
  InboxMessage: await db.inboxMessage.count({ where: {
    OR: [
      { agent: { projectId } },
      { session: { projectId } },
      { task: { projectId } },
      { goal: { projectId } },
      { gateTask: { projectId } },
    ],
  } }),
  InboxThread: await db.inboxThread.count({ where: {
    OR: [{ session: { projectId } }, { task: { projectId } }, { goal: { projectId } }],
  } }),
  InboxDecision: await db.inboxDecision.count({ where: { run: { projectId } } }),
});

const projectState = async (projectId: string): Promise<Record<string, number>> => ({
  ...await projectCounts(projectId),
  ...await relationOwnedCounts(projectId),
});

const emptyProjectState = (counts: Record<string, number>): void => {
  for (const [model, count] of Object.entries(counts)) assert.equal(count, 0, `${model} still has rows`);
};

const bootstrapRows = async (projectId: string): Promise<Record<string, number>> => ({
  Project: await db.project.count({ where: { id: projectId } }),
  Environment: await db.environment.count({ where: { projectId } }),
  Agent: await db.agent.count({ where: { projectId } }),
  StaffingProfile: await db.staffingProfile.count({ where: { projectId } }),
  StaffingProfileEntry: await db.staffingProfileEntry.count({ where: { profile: { projectId } } }),
  StaffingProfileTier: await db.staffingProfileTier.count({ where: { profile: { projectId } } }),
  TaskTemplate: await db.taskTemplate.count({ where: { projectId } }),
  TaskTemplateStep: await db.taskTemplateStep.count({ where: { taskTemplate: { projectId } } }),
});

type DirectFixture = {
  projectId: string;
  directTemplateId: string;
  repoId: string;
  firstTaskId: string;
  secondTaskId: string;
  firstRunId: string;
};

const seedDirectFixture = async (): Promise<DirectFixture> => {
  await runDbScript("seed.ts");
  const project = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const direct = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: DIRECT_TEMPLATE_NAME } },
  });
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: `project-delete-${randomUUID()}`,
      remoteUrl: "https://example.test/project-delete.git",
      mountPath: "/repo",
      dependencyProvisioning: DependencyProvisioning.NONE,
    },
  });
  const agents = await db.agent.findMany({ where: { projectId: project.id }, select: { id: true } });
  await db.agentRepoAccess.createMany({
    data: agents.map(({ id: agentId }) => ({
      projectId: project.id,
      agentId,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: RepoPermission.GIT_WRITE,
    })),
  });

  const variables = Object.fromEntries(direct.variables.map((variable) => [
    variable,
    variable === "branchName" ? `project-delete/${randomUUID()}` : `project-delete-${variable}`,
  ]));
  const chain = await instantiateTemplate(db, project.id, direct.id, {
    repoId: repo.id,
    variables,
    name: "project delete direct chain",
  });
  const firstTask = chain.tasks[0];
  const secondTask = chain.tasks[1];
  assert.ok(firstTask && secondTask, "the direct template must instantiate at least two Tasks");
  await db.task.update({ where: { id: secondTask.id }, data: { dispatchAfterTaskId: firstTask.id } });

  const firstRun = await db.run.create({
    data: {
      projectId: project.id,
      taskId: firstTask.id,
      agentId: agents[0]!.id,
      repoId: repo.id,
      runNumber: 1,
      dedupeKey: `project-delete-first-${randomUUID()}`,
      runner: "CLAUDE",
      model: "claude",
      promptHash: "project-delete-first",
      status: RunStatus.SUCCEEDED,
      endedAt: new Date(),
    },
  });
  await db.session.create({
    data: {
      runId: firstRun.id,
      projectId: project.id,
      agentId: agents[0]!.id,
      taskId: firstTask.id,
      runner: "CLAUDE",
      executionStatus: "SUCCEEDED",
      cleanupStatus: "SUCCEEDED",
      endedAt: new Date(),
    },
  });
  await db.run.create({
    data: {
      projectId: project.id,
      taskId: secondTask.id,
      agentId: agents[0]!.id,
      repoId: repo.id,
      runNumber: 1,
      dedupeKey: `project-delete-retry-${randomUUID()}`,
      retryOfRunId: firstRun.id,
      runner: "CLAUDE",
      model: "claude",
      promptHash: "project-delete-retry",
      status: RunStatus.SUCCEEDED,
      endedAt: new Date(),
    },
  });

  const goal = await db.goal.create({
    data: {
      projectId: project.id,
      title: "Project deletion goal",
      spec: "Exercise goal-lineage deletion ordering",
      goalGeneration: 1,
      nextGoalIteration: 3,
    },
  });
  const firstGoalTask = await db.task.create({
    data: {
      projectId: project.id,
      assigneeAgentId: agents[0]!.id,
      repoId: repo.id,
      name: "Goal iteration 1",
      description: "Executing Goal iteration",
      goalId: goal.id,
      goalGeneration: 1,
      goalIteration: 1,
      goalDispatchKey: `project-delete-goal-dispatch-1-${randomUUID()}`,
      goalDispatchRequestHash: "project-delete-goal-request-1",
      goalDispatchState: GoalDispatchState.EXECUTING,
    },
  });
  await db.task.create({
    data: {
      projectId: project.id,
      assigneeAgentId: agents[0]!.id,
      repoId: repo.id,
      name: "Goal iteration 2",
      description: "Closed successor Goal iteration",
      goalId: goal.id,
      goalGeneration: 1,
      goalIteration: 2,
      goalDispatchKey: `project-delete-goal-dispatch-2-${randomUUID()}`,
      goalDispatchRequestHash: "project-delete-goal-request-2",
      goalDispatchState: GoalDispatchState.MIGRATED_CLOSED,
      goalPredecessorTaskId: firstGoalTask.id,
    },
  });
  const goalRun = await db.run.create({
    data: {
      projectId: project.id,
      taskId: firstGoalTask.id,
      goalId: goal.id,
      goalGeneration: 1,
      goalIteration: 1,
      agentId: agents[0]!.id,
      repoId: repo.id,
      runNumber: 1,
      dedupeKey: `project-delete-goal-run-${randomUUID()}`,
      runner: "CLAUDE",
      model: "claude",
      promptHash: "project-delete-goal-run",
      status: RunStatus.SUCCEEDED,
      endedAt: new Date(),
    },
  });
  const goalSession = await db.session.create({
    data: {
      runId: goalRun.id,
      projectId: project.id,
      agentId: agents[0]!.id,
      taskId: firstGoalTask.id,
      goalId: goal.id,
      runner: "CLAUDE",
      executionStatus: "SUCCEEDED",
      cleanupStatus: "SUCCEEDED",
      endedAt: new Date(),
    },
  });
  await db.goalDefinitionItem.create({
    data: { goalId: goal.id, itemIndex: 0, text: "Delete every Goal-owned row" },
  });
  await db.goalProgressEntry.create({
    data: { goalId: goal.id, sessionId: goalSession.id, body: "Goal fixture progress" },
  });
  await db.goalExecutionEvent.create({
    data: {
      goalId: goal.id,
      goalGeneration: 1,
      goalIteration: 1,
      taskId: firstGoalTask.id,
      runId: goalRun.id,
      type: "project-delete-fixture",
      dedupeKey: `project-delete-goal-event-${randomUUID()}`,
    },
  });
  await db.mergeLeaseEvent.create({
    data: {
      projectId: project.id,
      chainId: firstTask.chainId!,
      state: MergeLeaseEventState.HANDOFF_PENDING,
      owningTaskId: firstTask.id,
      handedOffRunId: goalRun.id,
      handedOffAt: new Date(),
    },
  });

  assert.equal(await db.task.count({ where: { projectId: project.id, dispatchAfterTaskId: firstTask.id } }), 1);
  assert.equal(await db.run.count({ where: { projectId: project.id, retryOfRunId: firstRun.id } }), 1);
  assert.equal(await db.session.count({ where: { projectId: project.id, runId: firstRun.id } }), 1);
  assert.equal(await db.goalExecutionEvent.count({ where: { goalId: goal.id } }), 1);
  assert.equal(await db.goalProgressEntry.count({ where: { goalId: goal.id, sessionId: goalSession.id } }), 1);
  assert.equal(await db.mergeLeaseEvent.count({ where: { projectId: project.id, handedOffRunId: goalRun.id } }), 1);
  return {
    projectId: project.id,
    directTemplateId: direct.id,
    repoId: repo.id,
    firstTaskId: firstTask.id,
    secondTaskId: secondTask.id,
    firstRunId: firstRun.id,
  };
};

test("projectCounts covers every Prisma model with a projectId field", async () => {
  const countedModels = Object.keys(await projectCounts(`project-model-inventory-${randomUUID()}`)).sort();
  const schemaModels = Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === "projectId"))
    .map((model) => model.name)
    .sort();
  assert.deepEqual(countedModels, schemaModels);
});

test("deleting a freshly bootstrapped Project removes its bootstrap rows", async () => {
  const project = await createProject(`project-delete-empty-${randomUUID()}`);
  const response = await call("DELETE", `/projects/${project.id}`);
  assert.equal(response.status, 204, JSON.stringify(response.body));
  assert.equal(response.body, null);

  assert.equal(await db.project.count({ where: { id: project.id } }), 0);
  const rows = await bootstrapRows(project.id);
  for (const [model, count] of Object.entries(rows)) assert.equal(count, 0, `${model} still has rows`);
});

test("deleting a Project with Chain, Run, Session, Goal, and self-reference history leaves no project rows", async () => {
  const fixture = await seedDirectFixture();
  const response = await call("DELETE", `/projects/${fixture.projectId}`);
  assert.equal(response.status, 204, JSON.stringify(response.body));
  assert.equal(response.body, null);
  assert.equal(await db.project.count({ where: { id: fixture.projectId } }), 0);
  emptyProjectState(await projectState(fixture.projectId));
});

test("deleting one Project leaves a second bootstrapped Project and its Task unchanged", async () => {
  const fixture = await seedDirectFixture();
  const survivor = await createProject(`project-delete-survivor-${randomUUID()}`);
  const survivorAgent = await db.agent.findFirstOrThrow({ where: { projectId: survivor.id } });
  const survivorTask = await db.task.create({
    data: {
      projectId: survivor.id,
      assigneeAgentId: survivorAgent.id,
      name: "Surviving Project Task",
      description: "Must survive deletion of another Project",
    },
  });
  const survivorRun = await db.run.create({
    data: {
      projectId: survivor.id,
      taskId: survivorTask.id,
      agentId: survivorAgent.id,
      runNumber: 1,
      dedupeKey: `project-delete-survivor-run-${randomUUID()}`,
      runner: "CLAUDE",
      model: "claude",
      promptHash: "project-delete-survivor-run",
      status: RunStatus.SUCCEEDED,
      endedAt: new Date(),
    },
  });
  const deletedProjectThread = await db.inboxThread.create({
    data: {
      externalChatId: `project-delete-shared-thread-${randomUUID()}`,
      taskId: fixture.firstTaskId,
    },
  });
  const deletedProjectMessage = await db.inboxMessage.create({
    data: {
      from: "AGENT",
      threadId: deletedProjectThread.id,
      body: "Thread-owned message from the deleted Project",
    },
  });
  const survivorMessage = await db.inboxMessage.create({
    data: {
      from: "AGENT",
      taskId: survivorTask.id,
      threadId: deletedProjectThread.id,
      body: "Survivor message in a deleted Project's thread",
    },
  });
  const survivorDecision = await db.inboxDecision.create({
    data: {
      inboxMessageId: survivorMessage.id,
      runId: survivorRun.id,
      externalEventId: `project-delete-survivor-decision-${randomUUID()}`,
      decision: "survive",
    },
  });
  const before = await projectState(survivor.id);

  const response = await call("DELETE", `/projects/${fixture.projectId}`);
  assert.equal(response.status, 204, JSON.stringify(response.body));
  assert.equal(response.body, null);
  assert.equal(await db.project.count({ where: { id: fixture.projectId } }), 0);
  emptyProjectState(await projectState(fixture.projectId));
  assert.deepEqual(await projectState(survivor.id), before);
  assert.equal(await db.project.count({ where: { id: survivor.id } }), 1);
  assert.deepEqual(await db.inboxMessage.findUnique({
    where: { id: survivorMessage.id },
    select: { id: true, threadId: true },
  }), { id: survivorMessage.id, threadId: null });
  assert.equal(await db.inboxMessage.count({ where: { id: deletedProjectMessage.id } }), 0);
  assert.equal(await db.inboxDecision.count({ where: { id: survivorDecision.id } }), 1);
});

test("deleting an unknown Project answers 404", async () => {
  const response = await call("DELETE", "/projects/project-does-not-exist");
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: "Project not found" });
});

test("concurrent Project deletes answer 204 and 404", async () => {
  const project = await createProject(`project-delete-concurrent-${randomUUID()}`);
  const responses = await Promise.all([
    call("DELETE", `/projects/${project.id}`),
    call("DELETE", `/projects/${project.id}`),
  ]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [204, 404]);
  assert.equal(await db.project.count({ where: { id: project.id } }), 0);
});
