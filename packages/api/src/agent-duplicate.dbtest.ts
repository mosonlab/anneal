/**
 * `POST /agents/:agentId/duplicate` against a real database.
 *
 * Duplication exists so one role can be staffed twice — the same job at two
 * models — so the copy has to be usable on its own: every grant and binding that
 * decides what an Agent may reach comes along, under new grant ids where the row
 * owns one. What must not come along is history and inbound trust. Both halves
 * are asserted here because a join table quietly missed from the copy is a
 * silently under-privileged Agent, and a join table quietly added is a privilege
 * the operator never granted.
 */
import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-duplicate-token";
const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(path, {
      method,
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const unique = (label: string): string => `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`;

const fixture = async () => {
  const project = await db.project.create({ data: { name: "Duplicate", slug: unique("duplicate") } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    canonicalRole: "senior-dev-luna-max",
    customizedFields: ["model"],
    name: "senior-dev-luna-max",
    title: "Senior Dev",
    model: "gpt-6-luna:max",
    runnerPreference: "CODEX",
    codexServiceTier: "FAST",
    inboxAccess: true,
    disabledTools: ["WEB_FETCH"],
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const other = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "librarian-luna-high",
    title: "Librarian",
    model: "gpt-6-luna:high",
    runnerPreference: "CODEX",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "repo",
    remoteUrl: "https://example.invalid/repo.git",
    mountPath: "repo",
    dependencyProvisioning: "NONE",
  } });
  const skill = await db.skill.create({ data: { projectId: project.id, name: "Skill", slug: "skill", kind: "PROMPT", body: "skill" } });
  const connection = await db.mCPConnection.create({ data: { projectId: project.id, name: "mcp", transport: "stdio", config: {}, allowedOperations: [] } });
  const secret = await db.secret.create({ data: { name: unique("secret"), encryptedValue: "cipher", purpose: "ENV" } });
  await db.agentRepoAccess.create({ data: { agentId: agent.id, repoId: repo.id, projectId: project.id, mountPath: "repo", permissions: "GIT_WRITE" } });
  await db.agentSkill.create({ data: { agentId: agent.id, skillId: skill.id, projectId: project.id } });
  await db.agentMCPConnection.create({ data: { agentId: agent.id, mcpConnectionId: connection.id, projectId: project.id } });
  await db.agentSecretGrant.create({ data: { agentId: agent.id, secretId: secret.id, envVar: "GITHUB_TOKEN" } });
  const filesystemGrant = await db.filesystemGrant.create({ data: { agentId: agent.id, folderPath: "wiki", canRead: true, canWrite: true } });
  // Outgoing: this Agent may talk to the librarian. Inbound: the librarian may
  // talk to it. Only the outgoing edge is the copy's to inherit.
  await db.agentCollaboration.create({ data: { agentId: agent.id, allowedAgentId: other.id, projectId: project.id } });
  await db.agentCollaboration.create({ data: { agentId: other.id, allowedAgentId: agent.id, projectId: project.id } });
  return { project, environment, agent, other, repo, skill, connection, secret, filesystemGrant };
};

test("duplicate copies configuration, grants and outgoing collaborations under a new identity", async () => {
  const source = await fixture();
  // History the copy must not inherit.
  const task = await db.task.create({ data: {
    projectId: source.project.id,
    name: "Implementation",
    description: "duplicate fixture",
    assigneeType: "AGENT",
    assigneeAgentId: source.agent.id,
  } });

  const response = await call("POST", `/agents/${source.agent.id}/duplicate`, { name: "senior-dev-luna-max-experiment" });
  assert.equal(response.status, 201);
  assert.notEqual(response.body.id, source.agent.id);

  const copy = await db.agent.findUniqueOrThrow({
    where: { id: response.body.id },
    include: {
      repoAccess: true,
      skills: true,
      mcpConnections: true,
      secretGrants: true,
      filesystemGrants: true,
      collaborators: true,
      collaboratorFor: true,
      assignedTasks: true,
      sessions: true,
      runs: true,
    },
  });

  assert.deepEqual({
    name: copy.name,
    canonicalRole: copy.canonicalRole,
    customizedFields: copy.customizedFields,
    title: copy.title,
    model: copy.model,
    runnerPreference: copy.runnerPreference,
    codexServiceTier: copy.codexServiceTier,
    inboxAccess: copy.inboxAccess,
    disabledTools: copy.disabledTools,
    environmentId: copy.environmentId,
    foundationalPrompt: copy.foundationalPrompt,
    rolePrompt: copy.rolePrompt,
    archivedAt: copy.archivedAt,
  }, {
    name: "senior-dev-luna-max-experiment",
    canonicalRole: null,
    customizedFields: [],
    title: source.agent.title,
    model: source.agent.model,
    runnerPreference: source.agent.runnerPreference,
    codexServiceTier: source.agent.codexServiceTier,
    inboxAccess: source.agent.inboxAccess,
    disabledTools: source.agent.disabledTools,
    environmentId: source.environment.id,
    foundationalPrompt: source.agent.foundationalPrompt,
    rolePrompt: source.agent.rolePrompt,
    archivedAt: null,
  });
  assert.equal(response.body.assignable, true);

  assert.deepEqual(copy.repoAccess.map(({ repoId, mountPath, permissions }) => ({ repoId, mountPath, permissions })),
    [{ repoId: source.repo.id, mountPath: "repo", permissions: "GIT_WRITE" }]);
  assert.deepEqual(copy.skills.map(({ skillId }) => skillId), [source.skill.id]);
  assert.deepEqual(copy.mcpConnections.map(({ mcpConnectionId }) => mcpConnectionId), [source.connection.id]);
  // The same Secret under the same variable, granted again to a different Agent:
  // the per-Agent envVar uniqueness is what makes that legal.
  assert.deepEqual(copy.secretGrants.map(({ secretId, envVar }) => ({ secretId, envVar })),
    [{ secretId: source.secret.id, envVar: "GITHUB_TOKEN" }]);
  const copiedGrant = copy.filesystemGrants[0]!;
  assert.notEqual(copiedGrant.id, source.filesystemGrant.id);
  assert.deepEqual(
    { folderPath: copiedGrant.folderPath, canRead: copiedGrant.canRead, canWrite: copiedGrant.canWrite, canDelete: copiedGrant.canDelete },
    { folderPath: "wiki", canRead: true, canWrite: true, canDelete: false },
  );
  assert.deepEqual(copy.collaborators.map(({ allowedAgentId }) => allowedAgentId), [source.other.id]);
  assert.deepEqual(copy.collaboratorFor, []);
  assert.deepEqual(copy.assignedTasks, []);
  assert.deepEqual(copy.sessions, []);
  assert.deepEqual(copy.runs, []);

  // Nothing moved off the original.
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeAgentId, source.agent.id);
  assert.equal(await db.filesystemGrant.count({ where: { agentId: source.agent.id } }), 1);
});

test("duplicate refuses a taken name and refuses the mechanical merge sentinel", async () => {
  const source = await fixture();
  const taken = await call("POST", `/agents/${source.agent.id}/duplicate`, { name: source.other.name });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /already exists in this project/u);
  assert.equal(await db.agent.count({ where: { projectId: source.project.id } }), 2);

  const sentinel = await db.agent.create({ data: {
    projectId: source.project.id,
    environmentId: source.environment.id,
    canonicalRole: "merge-integrator",
    name: "merge-integrator",
    title: "Merge Integrator",
    model: "mechanical/merge-executor-v1",
    runnerPreference: "INHERIT",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const refused = await call("POST", `/agents/${sentinel.id}/duplicate`, { name: "second-integrator" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /mechanical merge sentinel/u);
  assert.equal(await db.agent.count({ where: { projectId: source.project.id, name: "second-integrator" } }), 0);
});

test("duplicate refuses an unknown body field and writes nothing", async () => {
  const source = await fixture();
  const before = await db.agent.count({ where: { projectId: source.project.id } });

  const refused = await call("POST", `/agents/${source.agent.id}/duplicate`, {
    name: "senior-dev-copy",
    canonicalRole: "senior-dev-astra-medium",
  });

  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(await db.agent.count({ where: { projectId: source.project.id } }), before);
  assert.equal(await db.agent.count({ where: { projectId: source.project.id, name: "senior-dev-copy" } }), 0);
});
