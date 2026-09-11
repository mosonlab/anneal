import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { RunnerKind, RunnerPreference, type PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "agent-delete-operator-token";
let db: PrismaClient;
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

const unique = (label: string): string => `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`;

const call = async (method: string, path: string): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

const seedAgent = async (label: string) => {
  const project = await db.project.create({ data: { name: `Project ${label}`, slug: unique(label) } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: "agent",
      title: "Agent",
      model: "gpt-5.6-sol:medium",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  return { project, environment, agent };
};

test("DELETE Agent refuses a Run reference with typed counts and preserves the Agent", async () => {
  const { project, agent } = await seedAgent("agent-delete-run");
  await db.run.create({
    data: {
      projectId: project.id,
      agentId: agent.id,
      runNumber: 1,
      dedupeKey: unique("agent-delete-run-dedupe"),
      runner: RunnerKind.CODEX,
      model: agent.model,
    },
  });

  const response = await call("DELETE", `/agents/${agent.id}`);
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(response.body, {
    error: "Agent has task, run, session, or staffing profile references; archive it with POST /agents/:agentId/archive instead",
    code: "agent_referenced",
    references: { tasks: 0, runs: 1, sessions: 0, staffingProfiles: 0 },
  });
  assert.equal(await db.agent.count({ where: { id: agent.id } }), 1);
});

test("DELETE Agent refuses a Task reference", async () => {
  const { project, agent } = await seedAgent("agent-delete-task");
  await db.task.create({
    data: {
      projectId: project.id,
      assigneeAgentId: agent.id,
      name: "referencing task",
      description: "work",
    },
  });

  const response = await call("DELETE", `/agents/${agent.id}`);
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(response.body.references, { tasks: 1, runs: 0, sessions: 0, staffingProfiles: 0 });
  assert.equal(await db.agent.count({ where: { id: agent.id } }), 1);
});

test("DELETE Agent refuses a Session reference without a Run reference", async () => {
  const { project, environment, agent } = await seedAgent("agent-delete-session");
  const runAgent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: "run-agent",
      title: "Run Agent",
      model: "gpt-5.6-sol:medium",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const run = await db.run.create({
    data: {
      projectId: project.id,
      agentId: runAgent.id,
      runNumber: 1,
      dedupeKey: unique("agent-delete-session-dedupe"),
      runner: RunnerKind.CODEX,
      model: runAgent.model,
    },
  });
  await db.session.create({
    data: { runId: run.id, projectId: project.id, agentId: agent.id, runner: RunnerKind.CODEX },
  });

  const response = await call("DELETE", `/agents/${agent.id}`);
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(response.body.references, { tasks: 0, runs: 0, sessions: 1, staffingProfiles: 0 });
  assert.equal(await db.agent.count({ where: { id: agent.id } }), 1);
});

test("DELETE Agent refuses a staffing-profile entry reference with a distinct profile count", async () => {
  const { project, agent } = await seedAgent("agent-delete-profile-entry");
  const template = await db.taskTemplate.create({
    data: { projectId: project.id, name: "template", description: "template", variables: [] },
  });
  const profile = await db.staffingProfile.create({
    data: { projectId: project.id, taskTemplateId: template.id, name: "profile" },
  });
  await db.staffingProfileEntry.createMany({
    data: [
      { profileId: profile.id, outputKind: "implementation", assigneeAgentId: agent.id },
      { profileId: profile.id, outputKind: "review", assigneeAgentId: agent.id },
    ],
  });

  const response = await call("DELETE", `/agents/${agent.id}`);
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.code, "agent_referenced");
  assert.deepEqual(response.body.references, { tasks: 0, runs: 0, sessions: 0, staffingProfiles: 1 });
  assert.equal(await db.agent.count({ where: { id: agent.id } }), 1);
});

test("DELETE Agent refuses a staffing-profile tier reference", async () => {
  const { project, agent } = await seedAgent("agent-delete-profile-tier");
  const template = await db.taskTemplate.create({
    data: { projectId: project.id, name: "template", description: "template", variables: [] },
  });
  const profile = await db.staffingProfile.create({
    data: { projectId: project.id, taskTemplateId: template.id, name: "profile" },
  });
  await db.staffingProfileTier.create({
    data: { profileId: profile.id, tier: "medium", agentId: agent.id },
  });

  const response = await call("DELETE", `/agents/${agent.id}`);
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(response.body.references, { tasks: 0, runs: 0, sessions: 0, staffingProfiles: 1 });
  assert.equal(await db.agent.count({ where: { id: agent.id } }), 1);
});

test("DELETE Agent refuses a merge-tail repair staffing-profile reference", async () => {
  const { project, agent } = await seedAgent("agent-delete-profile-repair");
  const template = await db.taskTemplate.create({
    data: { projectId: project.id, name: "template", description: "template", variables: [] },
  });
  await db.staffingProfile.create({
    data: {
      projectId: project.id,
      taskTemplateId: template.id,
      name: "profile",
      mergeTailRepairAgentId: agent.id,
    },
  });

  const response = await call("DELETE", `/agents/${agent.id}`);
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.deepEqual(response.body.references, { tasks: 0, runs: 0, sessions: 0, staffingProfiles: 1 });
  assert.equal(await db.agent.count({ where: { id: agent.id } }), 1);
});

test("DELETE Agent with no references answers 204 and removes the Agent", async () => {
  const { agent } = await seedAgent("agent-delete-clean");
  const response = await call("DELETE", `/agents/${agent.id}`);
  assert.equal(response.status, 204);
  assert.equal(await db.agent.count({ where: { id: agent.id } }), 0);
});

test("DELETE unknown Agent answers 404", async () => {
  await seedAgent("agent-delete-unknown");
  const response = await call("DELETE", "/agents/unknown-agent");
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: "Agent not found" });
});
