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
    error: "Agent has task, run, session, or staffing profile references; remove them before deleting it",
    code: "agent_referenced",
    references: { tasks: 0, runs: 1, sessions: 0, staffingProfiles: 0 },
  });
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
