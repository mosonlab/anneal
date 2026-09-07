import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, RunStatus, TaskStatus } from "@anneal/db";

import { baselineKey, readRunBaselines } from "./run-baseline.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
let sequence = 0;

before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const STARTED = new Date("2026-09-01T10:00:00.000Z");

/** One project with two template steps of the same template. */
const seedProject = async () => {
  const suffix = `${process.pid}-${sequence++}`;
  const project = await db.project.create({ data: {
    name: "Run baseline",
    slug: `run-baseline-${suffix}`,
  } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "local",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `agent-${suffix}`,
    title: "Agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: `baseline-workflow-${suffix}`,
    description: "baseline fixture",
    variables: [],
  } });
  const step = async (stepIndex: number, name: string) => await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    stepIndex,
    layer: stepIndex,
    name,
    prompt: "work",
    outputKind: "implementation",
    assigneeType: "AGENT",
  } });
  return {
    project,
    agent,
    template,
    implementation: await step(0, "Implementation"),
    review: await step(1, "Code review"),
  };
};

/** One completed run of a template step: a task bound to the step, its Run and
 *  the Session that carries the cost and the clock. */
const seedRun = async (
  context: Awaited<ReturnType<typeof seedProject>>,
  input: {
    templateStepId: string;
    costUsd: string | null;
    durationMs: number | null;
    status?: RunStatus;
  },
) => {
  const ordinal = sequence++;
  const task = await db.task.create({ data: {
    projectId: context.project.id,
    name: `Step ${ordinal}`,
    description: "baseline fixture",
    assigneeType: "AGENT",
    assigneeAgentId: context.agent.id,
    status: TaskStatus.DONE,
    templateId: context.template.id,
    templateStepId: input.templateStepId,
  } });
  const run = await db.run.create({ data: {
    projectId: context.project.id,
    taskId: task.id,
    agentId: context.agent.id,
    runNumber: 1,
    dedupeKey: `run-baseline:${task.id}:run:1`,
    runner: "CLAUDE",
    status: input.status ?? RunStatus.SUCCEEDED,
    model: "claude-opus-5",
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: context.project.id,
    agentId: context.agent.id,
    taskId: task.id,
    runner: "CLAUDE",
    executionStatus: "SUCCEEDED",
    startedAt: input.durationMs === null ? null : STARTED,
    endedAt: input.durationMs === null ? null : new Date(STARTED.getTime() + input.durationMs),
    costUsd: input.costUsd,
  } });
  return { task, run };
};

test("a template step's baseline is the percentiles of its own completed runs", async () => {
  const context = await seedProject();
  // Five costed runs and a sixth that reported none. Every one of the six
  // reports a duration, so the two samples are deliberately different sizes.
  const costs = ["1.0000", "2.0000", "3.0000", "4.0000", "5.0000", null];
  const durations = [1_000, 2_000, 3_000, 4_000, 5_000, 6_000];
  for (const [index, costUsd] of costs.entries()) {
    await seedRun(context, {
      templateStepId: context.implementation.id,
      costUsd,
      durationMs: durations[index]!,
    });
  }
  // A run that stopped is not evidence of what the step takes to complete.
  await seedRun(context, {
    templateStepId: context.implementation.id,
    costUsd: "500.0000",
    durationMs: 900_000,
    status: RunStatus.FAILED,
  });
  // Two runs is history, not a baseline.
  for (const costUsd of ["9.0000", "11.0000"]) {
    await seedRun(context, { templateStepId: context.review.id, costUsd, durationMs: 7_000 });
  }

  const baselines = await readRunBaselines(db, [
    { projectId: context.project.id, templateStepId: context.implementation.id },
    { projectId: context.project.id, templateStepId: context.review.id },
  ]);

  const implementation = baselines.get(baselineKey({
    projectId: context.project.id,
    templateStepId: context.implementation.id,
  }));
  assert.deepEqual(implementation, {
    sampleSize: 6,
    // percentile_cont over [1, 2, 3, 4, 5]: the run with no reported cost is
    // outside this sample entirely, and is not read as a zero-cost run.
    costUsd: { sampleSize: 5, p50: 3, p90: 4.6 },
    // …but it is inside this one: [1000 … 6000] interpolates to 3500, where
    // the five costed runs alone would have given 3000.
    durationMs: { sampleSize: 6, p50: 3_500, p90: 5_500 },
  });
  assert.equal(baselines.get(baselineKey({
    projectId: context.project.id,
    templateStepId: context.review.id,
  })), undefined);
});

test("one read answers every step it is given, scoped to each step's own project", async () => {
  const context = await seedProject();
  const other = await seedProject();
  for (const costUsd of ["1.0000", "1.0000", "1.0000", "1.0000", "1.0000"]) {
    await seedRun(context, { templateStepId: context.implementation.id, costUsd, durationMs: 2_000 });
  }
  for (const costUsd of ["100.0000", "100.0000", "100.0000", "100.0000", "100.0000"]) {
    await seedRun(other, { templateStepId: other.implementation.id, costUsd, durationMs: 90_000 });
  }

  const baselines = await readRunBaselines(db, [
    { projectId: context.project.id, templateStepId: context.implementation.id },
    { projectId: other.project.id, templateStepId: other.implementation.id },
    // A repeated key is one group, never a second lookup.
    { projectId: context.project.id, templateStepId: context.implementation.id },
  ]);
  assert.equal(baselines.size, 2);
  assert.equal(baselines.get(baselineKey({
    projectId: context.project.id, templateStepId: context.implementation.id,
  }))?.costUsd?.p50, 1);
  // The same step in another project is another codebase and another roster.
  assert.equal(baselines.get(baselineKey({
    projectId: other.project.id, templateStepId: other.implementation.id,
  }))?.costUsd?.p50, 100);
});
