import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
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

const emptyProjectCounts = (counts: Record<string, number>): void => {
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

  assert.equal(await db.task.count({ where: { projectId: project.id, dispatchAfterTaskId: firstTask.id } }), 1);
  assert.equal(await db.run.count({ where: { projectId: project.id, retryOfRunId: firstRun.id } }), 1);
  assert.equal(await db.session.count({ where: { projectId: project.id, runId: firstRun.id } }), 1);
  return {
    projectId: project.id,
    directTemplateId: direct.id,
    repoId: repo.id,
    firstTaskId: firstTask.id,
    secondTaskId: secondTask.id,
    firstRunId: firstRun.id,
  };
};

test("deleting a freshly bootstrapped Project removes its bootstrap rows", async () => {
  const project = await createProject(`project-delete-empty-${randomUUID()}`);
  const response = await call("DELETE", `/projects/${project.id}`);
  assert.equal(response.status, 204, JSON.stringify(response.body));
  assert.equal(response.body, null);

  assert.equal(await db.project.count({ where: { id: project.id } }), 0);
  const rows = await bootstrapRows(project.id);
  for (const [model, count] of Object.entries(rows)) assert.equal(count, 0, `${model} still has rows`);
});

test("deleting a Project with a direct Chain, Runs, a Session, and self-references leaves no project rows", async () => {
  const fixture = await seedDirectFixture();
  const response = await call("DELETE", `/projects/${fixture.projectId}`);
  assert.equal(response.status, 204, JSON.stringify(response.body));
  assert.equal(response.body, null);
  assert.equal(await db.project.count({ where: { id: fixture.projectId } }), 0);
  emptyProjectCounts(await projectCounts(fixture.projectId));
});

test("deleting one Project leaves a second bootstrapped Project and its Task unchanged", async () => {
  const fixture = await seedDirectFixture();
  const survivor = await createProject(`project-delete-survivor-${randomUUID()}`);
  const survivorAgent = await db.agent.findFirstOrThrow({ where: { projectId: survivor.id } });
  await db.task.create({
    data: {
      projectId: survivor.id,
      assigneeAgentId: survivorAgent.id,
      name: "Surviving Project Task",
      description: "Must survive deletion of another Project",
    },
  });
  const before = await projectCounts(survivor.id);

  const response = await call("DELETE", `/projects/${fixture.projectId}`);
  assert.equal(response.status, 204, JSON.stringify(response.body));
  assert.equal(response.body, null);
  assert.equal(await db.project.count({ where: { id: fixture.projectId } }), 0);
  emptyProjectCounts(await projectCounts(fixture.projectId));
  assert.deepEqual(await projectCounts(survivor.id), before);
  assert.equal(await db.project.count({ where: { id: survivor.id } }), 1);
});

test("deleting an unknown Project answers 404", async () => {
  const response = await call("DELETE", "/projects/project-does-not-exist");
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: "Project not found" });
});
