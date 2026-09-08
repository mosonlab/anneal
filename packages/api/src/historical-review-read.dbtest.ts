import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
  LEGACY_TEMPLATE_GENERATIONS,
  PrismaClient,
  TaskStatus,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;

before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "historical-review-read-operator";

/** Read the retired output kind from the registered generation rather than
 * repeating its historical spelling in a new test fixture. */
const retiredReviewOutputKind = (): string => {
  const generation = LEGACY_TEMPLATE_GENERATIONS[DIRECT_TEMPLATE_NAME]
    .find(({ marker }) => marker === "pre-model-neutral-review-output");
  assert.ok(generation, "the historical review-output generation must remain registered");
  const reviewStep = generation.shape.find(({ name }) => name === "Code review");
  assert.ok(reviewStep, "the historical review step must remain registered");
  return reviewStep.outputKind;
};

const operatorGet = async (path: string, replacement?: { kind: string; body: string }): Promise<{ status: number; body: any }> => {
  const previous = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(path, {
      method: replacement ? "PUT" : "GET",
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      ...(replacement ? { body: JSON.stringify(replacement) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previous;
  }
};

const seedArchivedHistoricalChain = async () => {
  const suffix = randomUUID();
  const project = await db.project.create({
    data: { name: `Historical read ${suffix}`, slug: `historical-read-${suffix}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: `historical-agent-${suffix}`,
      title: "Historical review agent",
      model: "claude",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: `historical-repo-${suffix}`,
      remoteUrl: "https://example.test/historical.git",
      mountPath: "/repo",
      dependencyProvisioning: DependencyProvisioning.NONE,
    },
  });
  await db.agentRepoAccess.create({
    data: {
      projectId: project.id,
      agentId: agent.id,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: "GIT_WRITE",
    },
  });

  const generation = LEGACY_TEMPLATE_GENERATIONS[DIRECT_TEMPLATE_NAME]
    .find(({ marker }) => marker === "pre-model-neutral-review-output");
  assert.ok(generation);
  const template = await db.taskTemplate.create({
    data: {
      projectId: project.id,
      name: `historical-template-${suffix}`,
      description: "historical template",
      variables: [],
    },
  });
  const templateSteps = [];
  for (const [index, shape] of generation.shape.entries()) {
    templateSteps.push(await db.taskTemplateStep.create({
      data: {
        taskTemplateId: template.id,
        assigneeAgentId: agent.id,
        stepIndex: index + 1,
        name: shape.name,
        assigneeType: shape.assigneeType,
        prompt: `historical prompt for ${shape.name}`,
        approvalGate: shape.approvalGate,
        optional: shape.optional ?? false,
        attachmentsFromPrevious: shape.attachmentsFromPrevious,
        outputKind: shape.outputKind,
        opensPullRequest: shape.opensPullRequest,
        requiresCommit: shape.requiresCommit ?? false,
        provisionDependencies: shape.provisionDependencies ?? true,
        baseFromStepIndex: shape.baseFromStepIndex,
        layer: shape.layer,
        ...(shape.spawnPolicy === null ? {} : { spawnPolicy: shape.spawnPolicy }),
      },
    }));
  }

  const chainId = `historical-chain-${suffix}`;
  const archivedAt = new Date("2026-09-08T00:00:00.000Z");
  const tasks = [];
  for (const [index, templateStep] of templateSteps.entries()) {
    tasks.push(await db.task.create({
      data: {
        projectId: project.id,
        assigneeAgentId: agent.id,
        repoId: repo.id,
        templateId: template.id,
        templateStepId: templateStep.id,
        name: templateStep.name,
        description: `historical task description ${index + 1}`,
        assigneeType: AssigneeType.AGENT,
        approvalGate: templateStep.approvalGate,
        opensPullRequest: templateStep.opensPullRequest,
        chainId,
        chainIndex: index,
        chainLayer: templateStep.layer,
        status: TaskStatus.DONE,
        archivedAt,
      },
    }));
  }

  const reviewIndex = templateSteps.findIndex((step) => step.outputKind === retiredReviewOutputKind());
  assert.ok(reviewIndex >= 0, "the historical Chain must include its review Step");
  const reviewTask = tasks[reviewIndex]!;
  const retiredKind = retiredReviewOutputKind();
  const runTail = `historical run tail for ${retiredKind}\nkept byte-for-byte`;
  const reportBody = `historical report for ${retiredKind}\nwith exact text preserved`;
  const run = await db.run.create({
    data: {
      projectId: project.id,
      taskId: reviewTask.id,
      agentId: agent.id,
      repoId: repo.id,
      runNumber: 1,
      dedupeKey: `task:${reviewTask.id}:run:1`,
      runner: "CLAUDE",
      model: agent.model,
      status: "SUCCEEDED",
      promptHash: "historical-prompt-hash",
      output: runTail,
      opensPullRequest: false,
      requiresCommit: false,
    },
  });
  await db.taskStepOutput.create({
      data: { taskId: reviewTask.id, runId: run.id, kind: retiredKind, body: reportBody },
  });

  return { reviewTask, run, reportBody, runTail, retiredKind, chainId };
};

test("GET task detail and output retain archived historical review records verbatim", async () => {
  const seeded = await seedArchivedHistoricalChain();

  const detail = await operatorGet(`/tasks/${seeded.reviewTask.id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.chainId, seeded.chainId);
  assert.equal(detail.body.archivedAt, "2026-09-08T00:00:00.000Z");
  assert.equal(detail.body.templateStep.outputKind, seeded.retiredKind);
  assert.deepEqual(detail.body.stepOutput, {
    kind: seeded.retiredKind,
    body: seeded.reportBody,
    runId: seeded.run.id,
  });
  assert.equal(detail.body.runs[0].id, seeded.run.id);
  assert.equal(detail.body.runs[0].status, "SUCCEEDED");
  // Run.output is deliberately excluded from task detail to keep a multi-run
  // read bounded; the durable report is the TaskStepOutput projection above.
  assert.equal(Object.hasOwn(detail.body.runs[0], "output"), false);

  const output = await operatorGet(`/tasks/${seeded.reviewTask.id}/output`);
  assert.equal(output.status, 200, JSON.stringify(output.body));
  assert.equal(output.body.kind, seeded.retiredKind);
  assert.equal(output.body.body, seeded.reportBody);
  assert.equal(output.body.runId, seeded.run.id);

  const persistedRun = await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
  assert.equal(persistedRun.output, seeded.runTail);
});

test("operator PUT preserves an archived historical review output byte-for-byte", async () => {
  const seeded = await seedArchivedHistoricalChain();
  const where = { taskId: seeded.reviewTask.id };
  const before = await db.taskStepOutput.findUniqueOrThrow({ where });
  const response = await operatorGet(`/tasks/${seeded.reviewTask.id}/output`, { kind: "note", body: "replacement" });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, `${seeded.retiredKind} task output is immutable once persisted`);
  assert.deepEqual(await db.taskStepOutput.findUniqueOrThrow({ where }), before);
});
