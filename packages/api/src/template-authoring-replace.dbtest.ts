import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  DIRECT_TEMPLATE_NAME,
  templateRolloverName,
  Prisma,
  RunnerKind,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "template-authoring-replace-operator";
let db: PrismaClient;
let priorOperatorToken: string | undefined;
let priorEncryptionKey: string | undefined;

before(() => {
  priorOperatorToken = process.env.OPERATOR_TOKEN;
  priorEncryptionKey = process.env.AGENTOS_SECRET_ENCRYPTION_KEY;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.AGENTOS_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 37).toString("base64");
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

const unique = (label: string): string => label + "-" + Date.now() + "-" + Math.round(performance.now() * 1000);

type SeededTemplate = Awaited<ReturnType<typeof seedTemplate>>;

const seedTemplate = async (label: string, name = "editable-template") => {
  const project = await db.project.create({ data: { name: label, slug: unique(label) } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agents = await Promise.all(["implementation-agent", "review-agent", "regression-agent"].map((agentName) =>
    db.agent.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        name: agentName,
        title: agentName,
        model: "gpt-5.6-sol:medium",
        foundationalPrompt: "foundation",
        rolePrompt: "role",
      },
    })));
  const template = await db.taskTemplate.create({
    data: {
      projectId: project.id,
      name,
      description: "Editable template",
      variables: ["branchName"],
    },
  });
  const steps = await Promise.all([
    db.taskTemplateStep.create({
      data: {
        taskTemplateId: template.id,
        stepIndex: 1,
        layer: 1,
        name: "Implementation",
        assigneeType: AssigneeType.AGENT,
        assigneeAgentId: agents[0]!.id,
        prompt: "Implement the change",
        approvalGate: false,
        attachmentsFromPrevious: false,
        priorOutputKinds: [],
        spawnPolicy: { maxChildren: 2 },
        runner: RunnerKind.CODEX,
        outputKind: "implementation",
        opensPullRequest: true,
        requiresCommit: true,
        baseFromStepIndex: null,
      },
    }),
    db.taskTemplateStep.create({
      data: {
        taskTemplateId: template.id,
        stepIndex: 2,
        layer: 2,
        name: "Code review",
        assigneeType: AssigneeType.AGENT,
        assigneeAgentId: agents[1]!.id,
        prompt: "Review the implementation",
        approvalGate: false,
        attachmentsFromPrevious: true,
        priorOutputKinds: ["implementation"],
        spawnPolicy: Prisma.JsonNull,
        runner: null,
        outputKind: "review-findings",
        opensPullRequest: false,
        requiresCommit: false,
        baseFromStepIndex: 1,
      },
    }),
    db.taskTemplateStep.create({
      data: {
        taskTemplateId: template.id,
        stepIndex: 3,
        layer: 2,
        name: "Documentation",
        assigneeType: AssigneeType.AGENT,
        assigneeAgentId: agents[2]!.id,
        prompt: "Document the implementation",
        approvalGate: false,
        attachmentsFromPrevious: true,
        priorOutputKinds: ["implementation"],
        spawnPolicy: { maxChildren: 1, mode: "serial" },
        runner: RunnerKind.PI,
        outputKind: "documentation",
        opensPullRequest: false,
        requiresCommit: true,
        baseFromStepIndex: 1,
      },
    }),
  ]);
  return { project, environment, agents, template, steps };
};

const request = async (
  projectId: string,
  templateId: string,
  body: unknown,
): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request(
    "/projects/" + projectId + "/task-templates/" + templateId + "/steps",
    {
      method: "PUT",
      headers: { Authorization: "Bearer " + OPERATOR, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
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

const replacementStep = (seed: SeededTemplate) => ({
  name: "Implementation (edited)",
  assigneeType: AssigneeType.AGENT,
  assigneeAgentId: seed.agents[0]!.id,
  prompt: "Implement the edited change",
  approvalGate: false,
  optional: false,
  attachmentsFromPrevious: false,
  priorOutputKinds: [],
  spawnPolicy: { maxChildren: 4, mode: "parallel" },
  runner: RunnerKind.CLAUDE,
  outputKind: "implementation",
  opensPullRequest: true,
  requiresCommit: false,
  baseFromStepIndex: null,
  layer: 1,
});

test("replace adds, removes, reorders, and edits every Step field with dense indexes", async () => {
  const seed = await seedTemplate("replace-success");
  const input = [
    replacementStep(seed),
    {
      name: "Regression verification",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: seed.agents[2]!.id,
      prompt: "Verify the edited head",
      approvalGate: false,
      optional: false,
      attachmentsFromPrevious: true,
      priorOutputKinds: ["implementation"],
      spawnPolicy: null,
      runner: RunnerKind.PI,
      outputKind: "regression-verification",
      opensPullRequest: false,
      requiresCommit: true,
      baseFromStepIndex: 1,
      layer: 2,
    },
    {
      name: "Code review",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: seed.agents[1]!.id,
      prompt: "Review the edited implementation",
      approvalGate: false,
      optional: false,
      attachmentsFromPrevious: true,
      priorOutputKinds: ["implementation"],
      spawnPolicy: { maxChildren: 1 },
      runner: null,
      outputKind: "review-findings",
      opensPullRequest: false,
      requiresCommit: false,
      baseFromStepIndex: 1,
      layer: 2,
    },
    {
      name: "Operator approval",
      assigneeType: AssigneeType.HUMAN,
      assigneeAgentId: null,
      prompt: "Approve the edited graph",
      approvalGate: true,
      optional: false,
      attachmentsFromPrevious: true,
      priorOutputKinds: ["review-findings"],
      spawnPolicy: null,
      runner: null,
      outputKind: "approval",
      opensPullRequest: false,
      requiresCommit: false,
      baseFromStepIndex: 3,
      layer: 3,
    },
  ];
  const beforeTasks = await db.task.count();
  const beforeActivities = await db.taskActivity.count();
  const result = await request(seed.project.id, seed.template.id, { steps: input });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.warnings, []);
  assert.deepEqual(result.body.template.steps.map(stepProjection), input.map((step, index) => ({
    ...step,
    stepIndex: index + 1,
  })));
  const persisted = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: seed.template.id },
    include: { assigneeAgent: true },
    orderBy: { stepIndex: "asc" },
  });
  assert.deepEqual(persisted.map(stepProjection), input.map((step, index) => ({
    ...step,
    stepIndex: index + 1,
  })));
  assert.equal(await db.task.count(), beforeTasks);
  assert.equal(await db.taskActivity.count(), beforeActivities);

  const reducedInput = [
    { ...replacementStep(seed), opensPullRequest: false },
    {
      ...input[2]!,
      baseFromStepIndex: 1,
      layer: 2,
    },
  ];
  const reduced = await request(seed.project.id, seed.template.id, { steps: reducedInput });
  assert.equal(reduced.status, 200, JSON.stringify(reduced.body));
  assert.deepEqual(reduced.body.warnings, []);
  assert.deepEqual(reduced.body.template.steps.map(stepProjection), reducedInput.map((step, index) => ({
    ...step,
    stepIndex: index + 1,
  })));
  const reducedPersisted = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: seed.template.id },
    orderBy: { stepIndex: "asc" },
  });
  assert.deepEqual(reducedPersisted.map(stepProjection), reducedInput.map((step, index) => ({
    ...step,
    stepIndex: index + 1,
  })));
});

test("replace strict schema refuses unknown fields and bounds without changing the prior graph", async () => {
  const seed = await seedTemplate("replace-schema");
  const valid = { steps: [replacementStep(seed)] };
  const before = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: seed.template.id },
    orderBy: { stepIndex: "asc" },
  });
  const cases = [
    { steps: valid.steps, unexpected: true },
    { steps: [{ ...valid.steps[0], stepIndex: 1 }] },
    { steps: [{ ...valid.steps[0], unknownStepField: "reject" }] },
    { steps: [{ ...valid.steps[0], name: "x".repeat(201) }] },
    { steps: [{ ...valid.steps[0], prompt: "x".repeat(500_001) }] },
    { steps: Array.from({ length: 65 }, () => valid.steps[0]!) },
    { steps: [{ ...valid.steps[0], layer: 2_147_483_648 }] },
    { steps: [{ ...valid.steps[0], baseFromStepIndex: 0 }] },
  ];
  for (const candidate of cases) {
    const result = await request(seed.project.id, seed.template.id, candidate);
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.deepEqual(
      await db.taskTemplateStep.findMany({ where: { taskTemplateId: seed.template.id }, orderBy: { stepIndex: "asc" } }),
      before,
    );
  }
});

test("replace addresses the project and refuses canonical or registered-legacy templates", async () => {
  const seed = await seedTemplate("replace-addressing");
  const foreign = await seedTemplate("replace-foreign");
  const currentCanonical = await seedTemplate("replace-current-canonical", DIRECT_TEMPLATE_NAME);
  const legacyCanonical = await seedTemplate(
    "replace-legacy-canonical",
    templateRolloverName(DIRECT_TEMPLATE_NAME, "pre-narrow-regression-lease", "legacy-row"),
  );
  const cases = [
    {
      projectId: foreign.project.id,
      templateId: seed.template.id,
      status: 404,
      code: "template_not_in_project",
    },
    {
      projectId: currentCanonical.project.id,
      templateId: currentCanonical.template.id,
      status: 409,
      code: "template_canonical",
    },
    {
      projectId: legacyCanonical.project.id,
      templateId: legacyCanonical.template.id,
      status: 409,
      code: "template_canonical",
    },
  ] as const;
  for (const candidate of cases) {
    const before = await db.taskTemplateStep.findMany({
      where: { taskTemplateId: candidate.templateId },
      orderBy: { stepIndex: "asc" },
    });
    const result = await request(candidate.projectId, candidate.templateId, { steps: [replacementStep(seed)] });
    assert.equal(result.status, candidate.status, JSON.stringify(result.body));
    assert.equal(result.body.code, candidate.code, JSON.stringify(result.body));
    assert.deepEqual(
      await db.taskTemplateStep.findMany({ where: { taskTemplateId: candidate.templateId }, orderBy: { stepIndex: "asc" } }),
      before,
    );
  }
});

test("replace refuses structural and prompt-only edits after a Task references the template", async () => {
  const seed = await seedTemplate("replace-in-use");
  await db.task.create({
    data: {
      projectId: seed.project.id,
      templateId: seed.template.id,
      templateStepId: seed.steps[0]!.id,
      name: "Existing task",
      description: "Existing task",
    },
  });
  const before = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: seed.template.id },
    orderBy: { stepIndex: "asc" },
  });
  const promptOnlySteps = before.map((step, index) => {
    const { stepIndex: _serverOwnedStepIndex, ...payload } = stepProjection(step);
    return index === 1 ? { ...payload, prompt: `${payload.prompt} (edited)` } : payload;
  });
  for (const candidate of [
    { steps: [replacementStep(seed)] },
    { steps: promptOnlySteps },
  ]) {
    const result = await request(seed.project.id, seed.template.id, candidate);
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.code, "template_in_use", JSON.stringify(result.body));
    assert.match(result.body.error, /clone it again/iu);
    assert.deepEqual(
      await db.taskTemplateStep.findMany({ where: { taskTemplateId: seed.template.id }, orderBy: { stepIndex: "asc" } }),
      before,
    );
  }
});

test("replace rejects an empty graph with graph_empty and leaves all side effects untouched", async () => {
  const seed = await seedTemplate("replace-empty");
  const beforeSteps = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: seed.template.id },
    orderBy: { stepIndex: "asc" },
  });
  const beforeTasks = await db.task.count();
  const beforeActivities = await db.taskActivity.count();
  const result = await request(seed.project.id, seed.template.id, { steps: [] });

  assert.equal(result.status, 422, JSON.stringify(result.body));
  assert.equal(result.body.code, "graph_empty", JSON.stringify(result.body));
  assert.deepEqual(
    await db.taskTemplateStep.findMany({ where: { taskTemplateId: seed.template.id }, orderBy: { stepIndex: "asc" } }),
    beforeSteps,
  );
  assert.equal(await db.task.count(), beforeTasks);
  assert.equal(await db.taskActivity.count(), beforeActivities);
});

test("replace remaps staffing entries by exact output kind and reports the orphans", async () => {
  const seed = await seedTemplate("replace-staffing");
  await db.staffingProfile.create({
    data: {
      projectId: seed.project.id,
      taskTemplateId: seed.template.id,
      name: "Default",
      isDefault: true,
      entries: {
        create: [
          { outputKind: "implementation", assigneeAgentId: seed.agents[0]!.id, include: null },
          { outputKind: "review-findings", assigneeAgentId: seed.agents[1]!.id, include: null },
          { outputKind: "documentation", assigneeAgentId: seed.agents[2]!.id, include: null },
        ],
      },
    },
  });

  const result = await request(seed.project.id, seed.template.id, {
    steps: [
      replacementStep(seed),
      {
        name: "Optional blind review",
        assigneeType: AssigneeType.AGENT,
        assigneeAgentId: seed.agents[1]!.id,
        prompt: "Review blind",
        approvalGate: false,
        optional: true,
        attachmentsFromPrevious: true,
        priorOutputKinds: ["implementation"],
        spawnPolicy: null,
        runner: null,
        outputKind: "review-findings",
        opensPullRequest: false,
        requiresCommit: false,
        baseFromStepIndex: 1,
        layer: 2,
      },
    ],
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(
    result.body.warnings.filter((warning: { code: string }) => warning.code === "staffing_profile_entry_dropped"),
    [{
      code: "staffing_profile_entry_dropped",
      message: "Staffing profile Default entry documentation was dropped: the replacement graph has no step producing it",
      outputKind: "documentation",
    }],
  );

  const entries = await db.staffingProfileEntry.findMany({
    where: { profile: { taskTemplateId: seed.template.id } },
    orderBy: { outputKind: "asc" },
  });
  // The surviving kinds keep their exact opinions; the orphan is gone rather
  // than re-pointed at a step the operator never chose. `review-findings` became
  // optional in the replacement, so it gains the default opinion instead of
  // staying an optional step the profile says nothing about (R3).
  assert.deepEqual(
    entries.map(({ outputKind, assigneeAgentId, include }) => ({ outputKind, assigneeAgentId, include })),
    [
      { outputKind: "implementation", assigneeAgentId: seed.agents[0]!.id, include: null },
      { outputKind: "review-findings", assigneeAgentId: seed.agents[1]!.id, include: true },
    ],
  );
});

test("replace clears an include flag from a step that stopped being optional", async () => {
  const seed = await seedTemplate("replace-staffing-optional");
  await db.staffingProfile.create({
    data: {
      projectId: seed.project.id,
      taskTemplateId: seed.template.id,
      name: "Default",
      isDefault: true,
      entries: { create: [{ outputKind: "review-findings", assigneeAgentId: null, include: false }] },
    },
  });
  // The seeded graph already has a non-optional `review-findings` step; replacing
  // it with itself is enough to prove the flag cannot survive.
  const result = await request(seed.project.id, seed.template.id, {
    steps: [
      replacementStep(seed),
      {
        name: "Code review",
        assigneeType: AssigneeType.AGENT,
        assigneeAgentId: seed.agents[1]!.id,
        prompt: "Review the implementation",
        approvalGate: false,
        optional: false,
        attachmentsFromPrevious: true,
        priorOutputKinds: ["implementation"],
        spawnPolicy: null,
        runner: null,
        outputKind: "review-findings",
        opensPullRequest: false,
        requiresCommit: false,
        baseFromStepIndex: 1,
        layer: 2,
      },
    ],
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(
    (await db.staffingProfileEntry.findMany({ where: { profile: { taskTemplateId: seed.template.id } } }))
      .map(({ outputKind, include }) => ({ outputKind, include })),
    [{ outputKind: "review-findings", include: null }],
  );
});

test("replace clears a staffing opinion the new graph no longer allows", async () => {
  const seed = await seedTemplate("replace-staffing-invalid");
  await db.staffingProfile.create({
    data: {
      projectId: seed.project.id,
      taskTemplateId: seed.template.id,
      name: "Default",
      isDefault: true,
      entries: {
        create: [
          { outputKind: "implementation", assigneeAgentId: seed.agents[0]!.id, include: null },
          { outputKind: "review-findings", assigneeAgentId: seed.agents[1]!.id, include: null },
        ],
      },
    },
  });

  // The review step becomes a human handover under the same output kind. The
  // entry survives the remap by kind, but its Agent no longer belongs there:
  // left alone it would refuse every instantiation of the default profile with
  // `staffing_profile_step_not_agent`.
  const result = await request(seed.project.id, seed.template.id, {
    steps: [
      replacementStep(seed),
      {
        name: "Human review",
        assigneeType: AssigneeType.HUMAN,
        assigneeAgentId: null,
        prompt: "Review the implementation",
        approvalGate: false,
        optional: false,
        attachmentsFromPrevious: true,
        priorOutputKinds: ["implementation"],
        spawnPolicy: null,
        runner: null,
        outputKind: "review-findings",
        opensPullRequest: false,
        requiresCommit: false,
        baseFromStepIndex: 1,
        layer: 2,
      },
    ],
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const dropped = result.body.warnings
    .filter((warning: { code: string }) => warning.code === "staffing_profile_assignee_dropped");
  assert.equal(dropped.length, 1, JSON.stringify(result.body.warnings));
  assert.equal(dropped[0].outputKind, "review-findings");
  assert.match(dropped[0].message, /Staffing profile Default entry review-findings lost its Agent/u);
  assert.match(dropped[0].message, /only AGENT steps may be staffed/u);

  assert.deepEqual(
    (await db.staffingProfileEntry.findMany({
      where: { profile: { taskTemplateId: seed.template.id } },
      orderBy: { outputKind: "asc" },
    })).map(({ outputKind, assigneeAgentId, include }) => ({ outputKind, assigneeAgentId, include })),
    [
      { outputKind: "implementation", assigneeAgentId: seed.agents[0]!.id, include: null },
      { outputKind: "review-findings", assigneeAgentId: null, include: null },
    ],
  );
});

test("replace clears a staffing opinion whose Agent was archived meanwhile", async () => {
  const seed = await seedTemplate("replace-staffing-archived");
  await db.staffingProfile.create({
    data: {
      projectId: seed.project.id,
      taskTemplateId: seed.template.id,
      name: "Default",
      isDefault: true,
      entries: { create: [{ outputKind: "implementation", assigneeAgentId: seed.agents[0]!.id, include: null }] },
    },
  });
  await db.agent.update({ where: { id: seed.agents[0]!.id }, data: { archivedAt: new Date() } });

  // The compound implementation-root rule is checked by the same predicate but
  // cannot be reached from this route: a compound graph is canonical, and
  // canonical templates refuse step replacement outright.
  const result = await request(seed.project.id, seed.template.id, {
    steps: [{ ...replacementStep(seed), assigneeAgentId: seed.agents[1]!.id }],
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(
    result.body.warnings.filter((warning: { code: string }) => warning.code === "staffing_profile_assignee_dropped")
      .map(({ outputKind }: { outputKind: string }) => outputKind),
    ["implementation"],
  );
  assert.deepEqual(
    (await db.staffingProfileEntry.findMany({ where: { profile: { taskTemplateId: seed.template.id } } }))
      .map(({ outputKind, assigneeAgentId }) => ({ outputKind, assigneeAgentId })),
    [{ outputKind: "implementation", assigneeAgentId: null }],
  );
});
