import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
  templateRolloverName,
  Prisma,
  RunnerKind,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { encryptSecret } from "./secrets.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "template-authoring-clone-operator";
let db: PrismaClient;
let priorOperatorToken: string | undefined;
let priorEncryptionKey: string | undefined;

before(() => {
  priorOperatorToken = process.env.OPERATOR_TOKEN;
  priorEncryptionKey = process.env.AGENTOS_SECRET_ENCRYPTION_KEY;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.AGENTOS_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
  if (priorEncryptionKey === undefined) delete process.env.AGENTOS_SECRET_ENCRYPTION_KEY;
  else process.env.AGENTOS_SECRET_ENCRYPTION_KEY = priorEncryptionKey;
});

const unique = (label: string): string => `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`;

const seedTemplate = async (label: string, name = "source-template") => {
  const project = await db.project.create({ data: { name: label, slug: unique(label) } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: "authoring-agent",
      title: "Authoring agent",
      model: "gpt-5.6-sol:medium",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: "repo",
      remoteUrl: "https://example.test/repo.git",
      mountPath: "/repo",
      dependencyProvisioning: DependencyProvisioning.NONE,
    },
  });
  const secret = await db.secret.create({
    data: {
      name: unique("webhook-secret"),
      encryptedValue: encryptSecret("webhook-value"),
      purpose: "WEBHOOK",
    },
  });
  const template = await db.taskTemplate.create({
    data: {
      projectId: project.id,
      name,
      description: "Source description",
      variables: ["branchName", "ticket"],
      webhookSecretId: secret.id,
      webhookRepoId: repo.id,
      webhookPayloadMapping: { map: { ticket: "issue.title" }, defaults: { ticket: "fallback" } },
      webhookPausedAt: new Date("2026-08-30T12:00:00.000Z"),
      webhookReplayWindowSec: 900,
    },
  });
  const firstStep = await db.taskTemplateStep.create({
    data: {
      taskTemplateId: template.id,
      stepIndex: 1,
      layer: 1,
      name: "Implementation",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: agent.id,
      prompt: "Implement {{ticket}} on {{branchName}}",
      approvalGate: false,
      attachmentsFromPrevious: false,
      priorOutputKinds: [],
      spawnPolicy: { maxChildren: 2 },
      runner: RunnerKind.CODEX,
      outputKind: "implementation",
      opensPullRequest: true,
      requiresCommit: false,
      baseFromStepIndex: null,
    },
  });
  await db.taskTemplateStep.create({
    data: {
      taskTemplateId: template.id,
      stepIndex: 2,
      layer: 2,
      name: "Operator approval",
      assigneeType: AssigneeType.HUMAN,
      assigneeAgentId: null,
      prompt: "Approve {{ticket}}",
      approvalGate: true,
      attachmentsFromPrevious: true,
      priorOutputKinds: ["implementation"],
      spawnPolicy: Prisma.JsonNull,
      runner: null,
      outputKind: "approval",
      opensPullRequest: false,
      requiresCommit: true,
      baseFromStepIndex: 1,
    },
  });
  return { project, environment, agent, repo, secret, template, firstStep };
};

const request = async (
  projectId: string,
  templateId: string,
  body: unknown,
): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request(`/projects/${projectId}/task-templates/${templateId}/clone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

const stepProjection = (step: any) => ({
  stepIndex: step.stepIndex,
  layer: step.layer,
  name: step.name,
  assigneeType: step.assigneeType,
  assigneeAgentId: step.assigneeAgentId,
  prompt: step.prompt,
  approvalGate: step.approvalGate,
  optional: step.optional,
  attachmentsFromPrevious: step.attachmentsFromPrevious,
  priorOutputKinds: step.priorOutputKinds,
  spawnPolicy: step.spawnPolicy,
  runner: step.runner,
  outputKind: step.outputKind,
  opensPullRequest: step.opensPullRequest,
  requiresCommit: step.requiresCommit,
  baseFromStepIndex: step.baseFromStepIndex,
});

test("clone returns a faithful independent graph and clears runtime trigger state", async () => {
  const seed = await seedTemplate("clone-fidelity");
  await db.task.create({
    data: {
      projectId: seed.project.id,
      repoId: seed.repo.id,
      templateId: seed.template.id,
      templateStepId: seed.firstStep.id,
      name: "Source task",
      description: "Source task description",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: seed.agent.id,
    },
  });
  await db.triggerFire.create({ data: { templateId: seed.template.id, source: "MANUAL" } });

  const result = await request(seed.project.id, seed.template.id, { name: "  cloned-template  " });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.name, "cloned-template");
  assert.equal(result.body.description, seed.template.description);
  assert.deepEqual(result.body.variables, seed.template.variables);
  assert.equal(result.body.webhookSecretId, null);
  assert.equal(result.body.webhookRepoId, null);
  assert.equal(result.body.webhookPayloadMapping, null);
  assert.equal(result.body.webhookPausedAt, null);
  assert.equal(result.body.webhookReplayWindowSec, null);

  const clone = await db.taskTemplate.findUniqueOrThrow({
    where: { id: result.body.id },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  const source = await db.taskTemplate.findUniqueOrThrow({
    where: { id: seed.template.id },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  assert.deepEqual(clone.steps.map(stepProjection), source.steps.map(stepProjection));
  assert.equal(await db.task.count({ where: { templateId: clone.id } }), 0);
  assert.equal(await db.triggerFire.count({ where: { templateId: clone.id } }), 0);
  assert.equal(await db.task.count({ where: { templateId: source.id } }), 1);
  assert.equal(await db.triggerFire.count({ where: { templateId: source.id } }), 1);
});

test("clone allows canonical and used sources and accepts an explicit description", async () => {
  const seed = await seedTemplate("clone-canonical", DIRECT_TEMPLATE_NAME);
  await db.task.create({
    data: {
      projectId: seed.project.id,
      repoId: seed.repo.id,
      templateId: seed.template.id,
      templateStepId: seed.firstStep.id,
      name: "Existing task",
      description: "Existing task",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: seed.agent.id,
    },
  });
  const result = await request(seed.project.id, seed.template.id, {
    name: "canonical-copy",
    description: "Operator description",
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.name, "canonical-copy");
  assert.equal(result.body.description, "Operator description");
  assert.equal(await db.task.count({ where: { templateId: result.body.id } }), 0);
});

test("clone refusals identify addressing and name conflicts without creating rows", async () => {
  const seed = await seedTemplate("clone-refusals");
  const foreign = await seedTemplate("clone-foreign");
  await db.taskTemplate.create({
    data: { projectId: seed.project.id, name: "taken-name", description: "taken", variables: [] },
  });
  const cases = [
    {
      projectId: foreign.project.id,
      templateId: seed.template.id,
      body: { name: "foreign-source" },
      status: 404,
      code: "template_not_in_project",
    },
    {
      projectId: seed.project.id,
      templateId: seed.template.id,
      body: { name: "taken-name" },
      status: 409,
      code: "template_name_taken",
    },
    {
      projectId: seed.project.id,
      templateId: seed.template.id,
      body: { name: DIRECT_TEMPLATE_NAME },
      status: 409,
      code: "template_name_reserved",
    },
    {
      projectId: seed.project.id,
      templateId: seed.template.id,
      body: { name: templateRolloverName(DIRECT_TEMPLATE_NAME, "pre-narrow-regression-lease", "legacy-row") },
      status: 409,
      code: "template_name_reserved",
    },
  ] as const;
  for (const candidate of cases) {
    const before = await db.taskTemplate.count();
    const result = await request(candidate.projectId, candidate.templateId, candidate.body);
    assert.equal(result.status, candidate.status, JSON.stringify(result.body));
    assert.equal(result.body.code, candidate.code, JSON.stringify(result.body));
    assert.equal(await db.taskTemplate.count(), before, candidate.code);
  }
});

test("clone name schema rejects blank and overlong names", async () => {
  const seed = await seedTemplate("clone-schema");
  for (const name of ["   ", "a".repeat(201)]) {
    const result = await request(seed.project.id, seed.template.id, { name });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(await db.taskTemplate.count(), 1);
  }
});

test("clone copies the source template's staffing profiles", async () => {
  const seed = await seedTemplate("clone-staffing");
  const profile = await db.staffingProfile.create({
    data: {
      projectId: seed.project.id,
      taskTemplateId: seed.template.id,
      name: "Default",
      isDefault: true,
      entries: {
        create: [
          { outputKind: "implementation", assigneeAgentId: seed.agent.id, include: null },
          { outputKind: "approval", assigneeAgentId: null, include: null },
        ],
      },
    },
  });
  await db.staffingProfile.create({
    data: {
      projectId: seed.project.id,
      taskTemplateId: seed.template.id,
      name: "Alternate",
      isDefault: false,
      entries: { create: [{ outputKind: "implementation", assigneeAgentId: null, include: null }] },
    },
  });

  const result = await request(seed.project.id, seed.template.id, { name: "cloned-with-staffing" });
  assert.equal(result.status, 201, JSON.stringify(result.body));

  const cloned = await db.staffingProfile.findMany({
    where: { taskTemplateId: result.body.id },
    orderBy: { name: "asc" },
    include: { entries: { orderBy: { outputKind: "asc" } } },
  });
  assert.deepEqual(
    cloned.map(({ name, isDefault, entries }) => ({
      name,
      isDefault,
      entries: entries.map(({ outputKind, assigneeAgentId, include }) => ({ outputKind, assigneeAgentId, include })),
    })),
    [
      {
        name: "Alternate",
        isDefault: false,
        entries: [{ outputKind: "implementation", assigneeAgentId: null, include: null }],
      },
      {
        name: "Default",
        isDefault: true,
        entries: [
          { outputKind: "approval", assigneeAgentId: null, include: null },
          { outputKind: "implementation", assigneeAgentId: seed.agent.id, include: null },
        ],
      },
    ],
  );
  // The copies are independent rows, and the source keeps its own.
  assert.ok(cloned.every((copy) => copy.id !== profile.id));
  assert.equal(await db.staffingProfile.count({ where: { taskTemplateId: seed.template.id } }), 2);
});
