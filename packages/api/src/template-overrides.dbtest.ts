import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { DependencyProvisioning, PrismaClient } from "@anneal/db";
import { after, before, beforeEach, test } from "node:test";

import { AssigneeType, RunnerPreference } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "template-overrides-operator";
const testDatabaseUrl = process.env.TEST_DATABASE_URL!;
let db: PrismaClient;

const fixture = async (label: string) => {
  const project = await db.project.create({
    data: { name: label, slug: `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const makeAgent = async (name: string, archivedAt: Date | null = null) => db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name,
    title: name,
    model: "gpt-5.6-sol:medium",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
    archivedAt,
  } });
  const canonicalOne = await makeAgent("canonical-one");
  const canonicalTwo = await makeAgent("canonical-two");
  const replacement = await makeAgent("replacement");
  const archived = await makeAgent("archived", new Date());
  const noGrant = await makeAgent("no-grant");
  const foreignProject = await db.project.create({
    data: { name: `${label}-foreign`, slug: `${label}-foreign-${Date.now()}-${Math.floor(Math.random() * 1e6)}` },
  });
  const foreignEnvironment = await db.environment.create({
    data: { projectId: foreignProject.id, name: "local", allowedHosts: [] },
  });
  const foreign = await db.agent.create({ data: {
    projectId: foreignProject.id, environmentId: foreignEnvironment.id, name: "foreign", title: "foreign",
    model: "gpt-5.6-sol:medium", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({
    data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo", dependencyProvisioning: DependencyProvisioning.NONE },
  });
  for (const agent of [canonicalOne, canonicalTwo, replacement, archived]) {
    await db.agentRepoAccess.create({
      data: { projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE" },
    });
  }
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: "override-template",
    description: "override fixture",
    variables: [],
    steps: { create: [
      {
        stepIndex: 1, layer: 1, name: "One", assigneeType: AssigneeType.AGENT, assigneeAgentId: canonicalOne.id,
        prompt: "one {{chainId}}", outputKind: "result", approvalGate: false, opensPullRequest: true,
      },
      {
        stepIndex: 2, layer: 2, name: "Two", assigneeType: AssigneeType.AGENT, assigneeAgentId: canonicalTwo.id,
        prompt: "two {{chainId}}", outputKind: "review-result", approvalGate: true,
        attachmentsFromPrevious: true, opensPullRequest: false,
      },
      {
        stepIndex: 3, layer: 3, name: "Human", assigneeType: AssigneeType.HUMAN,
        prompt: "human {{chainId}}", outputKind: "result", approvalGate: false, opensPullRequest: true,
      },
    ] },
  } });
  return { project, repo, template, canonicalOne, canonicalTwo, replacement, archived, noGrant, foreign };
};

const request = async (projectId: string, templateId: string, body: unknown): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request(`/projects/${projectId}/task-templates/${templateId}/instantiate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const archiveUnderHeldLock = async <T>(agentId: string, operation: () => Promise<T>): Promise<T> => {
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => { acquired = resolve; });
  try {
    const archiving = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${agentId} FOR UPDATE`;
      await tx.$executeRaw`UPDATE "Agent" SET "archivedAt" = now() WHERE "id" = ${agentId}`;
      acquired();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }, { timeout: 10_000 });
    await held;
    const pending = operation();
    await archiving;
    return await pending;
  } finally {
    await holder.$disconnect();
  }
};

const renameUnderHeldLock = async <T>(
  agentId: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => { acquired = resolve; });
  try {
    const renaming = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${agentId} FOR UPDATE`;
      await tx.agent.update({ where: { id: agentId }, data: { name } });
      acquired();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }, { timeout: 10_000 });
    await held;
    const pending = operation();
    await renaming;
    return await pending;
  } finally {
    await holder.$disconnect();
  }
};

before(() => {
  process.env.OPERATOR_TOKEN = OPERATOR;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  delete process.env.OPERATOR_TOKEN;
});

test("valid step override copies only the targeted assignee and leaves template defaults untouched", async () => {
  const seed = await fixture("valid");
  const beforeTemplate = await db.taskTemplate.findUniqueOrThrow({
    where: { id: seed.template.id },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const created = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    name: "override chain",
    autoStart: false,
    stepOverrides: { "2": { assigneeAgentId: seed.replacement.id } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const tasks = await db.task.findMany({
    where: { chainId: created.body.chainId },
    orderBy: { chainIndex: "asc" },
    include: { templateStep: { select: { prompt: true, outputKind: true, attachmentsFromPrevious: true } } },
  });
  assert.deepEqual(tasks.map((task) => task.assigneeAgentId), [seed.canonicalOne.id, seed.replacement.id, null]);
  assert.deepEqual(tasks.map((task) => task.assigneeType), [AssigneeType.AGENT, AssigneeType.AGENT, AssigneeType.HUMAN]);
  assert.deepEqual(tasks.map((task) => ({
    approvalGate: task.approvalGate,
    opensPullRequest: task.opensPullRequest,
    chainIndex: task.chainIndex,
    chainLayer: task.chainLayer,
    targetBranch: task.targetBranch,
  })), [
    { approvalGate: false, opensPullRequest: true, chainIndex: 1, chainLayer: 1, targetBranch: seed.repo.defaultBranch },
    { approvalGate: true, opensPullRequest: false, chainIndex: 2, chainLayer: 2, targetBranch: `agentos/${created.body.chainId}` },
    { approvalGate: false, opensPullRequest: true, chainIndex: 3, chainLayer: 3, targetBranch: `agentos/${created.body.chainId}` },
  ]);
  const control = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    name: "control chain",
    autoStart: false,
  });
  assert.equal(control.status, 201, JSON.stringify(control.body));
  const controlTasks = await db.task.findMany({
    where: { chainId: control.body.chainId },
    orderBy: { chainIndex: "asc" },
    include: { templateStep: { select: { prompt: true, outputKind: true, attachmentsFromPrevious: true } } },
  });
  const producedContract = (
    task: typeof tasks[number],
    chainId: string,
  ) => ({
    description: task.description.replaceAll(chainId, "<chainId>"),
    prompt: task.templateStep?.prompt ?? null,
    outputKind: task.templateStep?.outputKind ?? null,
    attachmentsFromPrevious: task.templateStep?.attachmentsFromPrevious ?? null,
    approvalGate: task.approvalGate,
    opensPullRequest: task.opensPullRequest,
    chainIndex: task.chainIndex,
    chainLayer: task.chainLayer,
    targetBranch: task.targetBranch?.replaceAll(chainId, "<chainId>") ?? null,
  });
  assert.deepEqual(
    tasks.map((task) => producedContract(task, created.body.chainId)),
    controlTasks.map((task) => producedContract(task, control.body.chainId)),
    "assignee-only overrides must preserve every other instantiated step field",
  );
  const afterTemplate = await db.taskTemplate.findUniqueOrThrow({
    where: { id: seed.template.id },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  assert.deepEqual(afterTemplate, beforeTemplate, "overrides must never mutate canonical template rows");
  assert.equal(await db.run.count({ where: { task: { chainId: created.body.chainId } } }), 0);

  const noOp = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id, variables: {}, name: "no-op override", stepOverrides: { "2": { assigneeAgentId: seed.canonicalTwo.id } },
  });
  assert.equal(noOp.status, 201, JSON.stringify(noOp.body));
  const noOpTask = await db.task.findFirstOrThrow({ where: { chainId: noOp.body.chainId, chainIndex: 2 } });
  assert.equal(noOpTask.assigneeAgentId, seed.canonicalTwo.id);
});

test("cross-project template-default assignees on integrator steps are refused as missing", async () => {
  const seed = await fixture("foreign-template-default");
  await db.taskTemplateStep.updateMany({
    where: { taskTemplateId: seed.template.id, stepIndex: 1 },
    data: { assigneeAgentId: seed.foreign.id, outputKind: "merge-result" },
  });
  const before = {
    tasks: await db.task.count(),
    activities: await db.taskActivity.count(),
    runs: await db.run.count(),
  };

  const result = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    name: "foreign default refusal",
  });

  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, "template_step_agent_missing", JSON.stringify(result.body));
  assert.deepEqual({
    tasks: await db.task.count(),
    activities: await db.taskActivity.count(),
    runs: await db.run.count(),
  }, before);
});

test("schema and materializer refusals return stable codes and leave no partial rows", async () => {
  const seed = await fixture("refusals");
  const cases: Array<{ body: unknown; code: string }> = [
    { body: { repoId: seed.repo.id, variables: {}, name: "invalid zero key", stepOverrides: { "0": { assigneeAgentId: seed.replacement.id } } }, code: "step_override_invalid_key" },
    { body: { repoId: seed.repo.id, variables: {}, name: "invalid leading key", stepOverrides: { "09": { assigneeAgentId: seed.replacement.id } } }, code: "step_override_invalid_key" },
    { body: { repoId: seed.repo.id, variables: {}, name: "invalid decimal key", stepOverrides: { "1.5": { assigneeAgentId: seed.replacement.id } } }, code: "step_override_invalid_key" },
    { body: { repoId: seed.repo.id, variables: {}, name: "unknown step key", stepOverrides: { "99": { assigneeAgentId: seed.replacement.id } } }, code: "step_override_unknown_step" },
    { body: { repoId: seed.repo.id, variables: {}, name: "human step override", stepOverrides: { "3": { assigneeAgentId: seed.replacement.id } } }, code: "step_override_step_not_agent" },
    { body: { repoId: seed.repo.id, variables: {}, name: "foreign override agent", stepOverrides: { "2": { assigneeAgentId: seed.foreign.id } } }, code: "step_override_agent_not_found" },
    { body: { repoId: seed.repo.id, variables: {}, name: "archived override agent", stepOverrides: { "2": { assigneeAgentId: seed.archived.id } } }, code: "step_override_agent_archived" },
    { body: { repoId: seed.repo.id, variables: {}, name: "ungranted override agent", stepOverrides: { "2": { assigneeAgentId: seed.noGrant.id } } }, code: "step_override_missing_repo_grant" },
    {
      body: { repoId: seed.repo.id, variables: {}, name: "too many overrides", stepOverrides: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [String(index + 1), { assigneeAgentId: seed.replacement.id }]),
      ) },
      code: "step_override_too_many",
    },
  ];
  for (const { body, code } of cases) {
    const result = await request(seed.project.id, seed.template.id, body);
    assert.equal(result.status, 400, `${code}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, code, `${code}: ${JSON.stringify(result.body)}`);
    assert.equal(await db.task.count(), 0, `${code}: no Task rows`);
    assert.equal(await db.taskActivity.count(), 0, `${code}: no TaskActivity rows`);
    assert.equal(await db.run.count(), 0, `${code}: no Run rows`);
    assert.equal(await db.triggerFire.count(), 0, `${code}: no TriggerFire rows`);
  }
  for (const body of [
    { repoId: seed.repo.id, variables: {}, name: "extra override field", stepOverrides: { "2": { assigneeAgentId: seed.replacement.id, extra: true } } },
    { repoId: seed.repo.id, variables: {}, name: "malformed override", stepOverrides: { "2": "agent-id" } },
  ]) {
    const result = await request(seed.project.id, seed.template.id, body);
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(await db.task.count(), 0);
  }
});

test("the override agent is re-read under its Agent-row mutex before any Task exists", { timeout: 30_000 }, async () => {
  const seed = await fixture("archive-race");
  const result = await archiveUnderHeldLock(seed.replacement.id, () => request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id, variables: {}, name: "archive override race", stepOverrides: { "2": { assigneeAgentId: seed.replacement.id } },
  }));
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, "step_override_agent_archived");
  assert.equal(await db.task.count(), 0);
  assert.equal(await db.taskActivity.count(), 0);
  assert.equal(await db.run.count(), 0);
});

test("an effective-assignee rename is revalidated under the Agent-row mutex before any Task exists", { timeout: 30_000 }, async () => {
  const seed = await fixture("rename-race");
  const result = await renameUnderHeldLock(seed.replacement.id, "merge-integrator", () => request(
    seed.project.id,
    seed.template.id,
    { repoId: seed.repo.id, variables: {}, name: "rename override race", stepOverrides: { "2": { assigneeAgentId: seed.replacement.id } } },
  ));
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, "step_override_integrator_binding");
  assert.equal(await db.task.count(), 0);
  assert.equal(await db.taskActivity.count(), 0);
  assert.equal(await db.run.count(), 0);
});

test("integrator and pinned compound implementation bindings are checked after overrides", async () => {
  const seed = await fixture("binding");
  const executioner = await db.agent.create({ data: {
    projectId: seed.project.id, environmentId: (await db.environment.findFirstOrThrow({ where: { projectId: seed.project.id } })).id,
    // §R14: the compound root is a capability, so this canonical binding has to
    // be a Codex gpt-* Agent or the whole graph is refused before the override
    // cases this test is about are reached.
    name: "plan-executor-astra-low", title: "executioner", model: "gpt-5.6-sol:high",
    runnerPreference: RunnerPreference.CODEX,
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const sentinel = await db.agent.create({ data: {
    projectId: seed.project.id, environmentId: (await db.environment.findFirstOrThrow({ where: { projectId: seed.project.id } })).id,
    name: "merge-integrator", title: "integrator", model: "mechanical/merge-executor-v1",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  for (const agent of [executioner, sentinel]) {
    await db.agentRepoAccess.create({
      data: { projectId: seed.project.id, agentId: agent.id, repoId: seed.repo.id, mountPath: "/repo", permissions: "GIT_WRITE" },
    });
  }
  const template = await db.taskTemplate.create({ data: {
    projectId: seed.project.id, name: "compound-engineer-workflow", description: "canonical fixture", variables: [],
    steps: { create: Array.from({ length: 12 }, (_, offset) => {
      const stepIndex = offset + 1;
      return {
        stepIndex, layer: stepIndex, name: `Step ${stepIndex}`,
        assigneeType: AssigneeType.AGENT,
        assigneeAgentId: stepIndex === 5 ? executioner.id : stepIndex === 12 ? sentinel.id : seed.canonicalOne.id,
        prompt: `step ${stepIndex} {{chainId}}`, outputKind: stepIndex === 5 ? "implementation" : stepIndex === 12 ? "merge-result" : "result",
        opensPullRequest: stepIndex !== 12,
      };
    }) },
  } });
  for (const [stepOverrides, code] of [
    [{ "1": { assigneeAgentId: sentinel.id } }, "step_override_integrator_binding"],
    [{ "12": { assigneeAgentId: seed.replacement.id } }, "step_override_integrator_binding"],
    [{ "5": { assigneeAgentId: seed.replacement.id } }, "step_override_compound_implementation"],
  ] as const) {
    const result = await request(seed.project.id, template.id, { repoId: seed.repo.id, variables: {}, name: `binding override ${code}`, stepOverrides });
    assert.equal(result.status, 400, `${code}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, code, JSON.stringify(result.body));
    assert.equal(await db.task.count(), 0);
    assert.equal(await db.taskActivity.count(), 0);
    assert.equal(await db.run.count(), 0);
  }
});
