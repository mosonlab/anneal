import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { DependencyProvisioning, enqueueTaskRun, FailureClass, LEGACY_ALL_PRIOR_OUTPUTS, PrismaClient, RunStatus, TaskStatus } from "@anneal/db";
import { buildPrompt } from "@anneal/runner/adapters";
import type { ClaimedTask } from "@anneal/runner/api";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const RUNNER_TOKEN = "prior-output-whitelist-runner-token";
const priorRunnerToken = process.env.RUNNER_TOKEN;
let db: PrismaClient;

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
});

const claim = () => createApp(db).request("/runner/tasks/claim", {
  method: "POST",
  headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ runnerId: "prior-output-whitelist-runner", leaseSeconds: 60 }),
});

const createFixture = async (
  steps: Array<{ outputKind: string; priorOutputKinds: string[] }>,
  omitStepIndexes: ReadonlySet<number> = new Set(),
) => {
  const project = await db.project.create({ data: {
    name: `prior-output-whitelist-${Date.now()}`,
    slug: `prior-output-whitelist-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "prior-output-whitelist",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "prior-output-whitelist-agent",
    title: "Prior output whitelist agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "prior-output-whitelist-repo",
    remoteUrl: "https://example.test/prior-output-whitelist.git",
    mountPath: "/repo",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  const template = await db.taskTemplate.create({
    data: {
      projectId: project.id,
      name: `toy prior output chain ${steps.length}`,
      description: "toy chain for exact prompt-input selection",
      variables: [],
      steps: { create: steps.map((step, index) => ({
        stepIndex: index + 1,
        layer: index + 1,
        name: `Toy step ${index + 1}`,
        assigneeType: "AGENT",
        assigneeAgentId: agent.id,
        prompt: `perform toy step ${index + 1}`,
        outputKind: step.outputKind,
        priorOutputKinds: step.priorOutputKinds,
        attachmentsFromPrevious: true,
        opensPullRequest: false,
      })) },
    },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const chainId = `prior-output-whitelist-chain-${Math.floor(Math.random() * 1e9)}`;
  const tasks = [];
  for (const step of template.steps) {
    if (omitStepIndexes.has(step.stepIndex)) continue;
    tasks.push(await db.task.create({ data: {
      projectId: project.id,
      repoId: repo.id,
      assigneeAgentId: agent.id,
      templateId: template.id,
      templateStepId: step.id,
      chainId,
      chainIndex: step.stepIndex,
      chainLayer: step.layer,
      name: step.name,
      description: step.prompt,
      status: TaskStatus.TODO,
    } }));
  }
  return { template, tasks };
};

test("a 12-step toy chain sends every claim exactly its declared prior outputs", async () => {
  const kinds = Array.from({ length: 12 }, (_, index) => `toy-step-${String(index + 1).padStart(2, "0")}`);
  const declarations = [
    [],
    [kinds[0]!],
    [kinds[0]!, kinds[1]!],
    [kinds[0]!, kinds[1]!, kinds[2]!],
    [kinds[3]!],
    [],
    [],
    [kinds[5]!, kinds[6]!],
    [kinds[4]!],
    [kinds[4]!, kinds[5]!, kinds[6]!, kinds[7]!],
    [],
    [],
  ];
  const { template, tasks } = await createFixture(kinds.map((outputKind, index) => ({
    outputKind,
    priorOutputKinds: declarations[index]!,
  })));
  const outputs: Array<{ kind: string; body: string; task: { name: string; chainIndex: number } }> = [];
  let savedPromptBytes = 0;
  const promptSizes: Array<{ step: number; filtered: number; unfiltered: number }> = [];

  for (const [index, task] of tasks.entries()) {
    const queued = await db.$transaction((tx) => enqueueTaskRun(tx as never, task.id));
    const response = await claim();
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const claimed = JSON.parse(text) as ClaimedTask;
    assert.equal(claimed.run.id, queued.id);
    assert.deepEqual(claimed.priorOutputs.map(({ kind }) => kind), declarations[index]);
    assert.deepEqual(claimed.priorOutputs.map(({ task: source }) => source.chainIndex), declarations[index]!.map((kind) => kinds.indexOf(kind) + 1));
    assert.deepEqual(
      claimed.priorOutputs.map(({ body }) => body),
      outputs.filter(({ kind }) => declarations[index]!.includes(kind)).map(({ body }) => body),
    );

    const prompt = buildPrompt(claimed);
    for (const output of outputs) {
      const marker = output.body.split("\n", 1)[0]!;
      if (declarations[index]!.includes(output.kind)) assert.match(prompt, new RegExp(marker, "u"));
      else assert.doesNotMatch(prompt, new RegExp(marker, "u"));
    }
    const unfilteredPrompt = buildPrompt({ ...claimed, priorOutputs: outputs });
    const filteredBytes = Buffer.byteLength(prompt);
    const unfilteredBytes = Buffer.byteLength(unfilteredPrompt);
    if (declarations[index]!.length < outputs.length) assert.ok(filteredBytes < unfilteredBytes);
    savedPromptBytes += unfilteredBytes - filteredBytes;
    promptSizes.push({ step: index + 1, filtered: filteredBytes, unfiltered: unfilteredBytes });

    const body = `unique-marker-${index + 1}\n${"x".repeat(index === 0 ? 42_000 : 7_000)}`;
    const headSha = (index + 1).toString(16).padStart(40, "0");
    await db.taskStepOutput.create({ data: {
      taskId: task.id,
      runId: queued.id,
      kind: template.steps[index]!.outputKind,
      body,
      commitSha: headSha,
    } });
    await db.run.update({ where: { id: queued.id }, data: {
      status: RunStatus.SUCCEEDED,
      baseSha: headSha,
      endedAt: new Date(),
    } });
    await db.task.update({ where: { id: task.id }, data: { status: TaskStatus.DONE } });
    outputs.push({
      kind: kinds[index]!,
      body,
      task: { name: `Toy step ${index + 1}`, chainIndex: index + 1 },
    });
  }

  const tailReductions = promptSizes.slice(8).map(({ filtered, unfiltered }) => unfiltered - filtered);
  assert.ok(
    tailReductions.every((bytes) => bytes >= 40_000),
    `expected every tail prompt to save at least 40 KB; sizes=${JSON.stringify(promptSizes)}`,
  );
  assert.ok(
    savedPromptBytes >= 80_000,
    `expected at least 80 KB saved across the toy chain; saved=${savedPromptBytes}; sizes=${JSON.stringify(promptSizes)}`,
  );
  console.log(JSON.stringify({ audit: "prior-output-prompt-sizes", promptSizes, savedPromptBytes }));
});

test("an omitted producer kind is satisfied by absence without parking the target", async () => {
  const { template, tasks } = await createFixture([
    { outputKind: "implementation", priorOutputKinds: [] },
    { outputKind: "review-findings", priorOutputKinds: ["implementation"] },
    { outputKind: "blind-findings", priorOutputKinds: ["implementation"] },
    { outputKind: "fixed-implementation", priorOutputKinds: ["review-findings", "blind-findings"] },
  ], new Set([3]));
  const implementationRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, tasks[0]!.id));
  await db.run.update({ where: { id: implementationRun.id }, data: { status: RunStatus.SUCCEEDED, endedAt: new Date() } });
  await db.task.update({ where: { id: tasks[0]!.id }, data: { status: TaskStatus.DONE } });
  await db.taskStepOutput.create({ data: {
    taskId: tasks[0]!.id,
    runId: implementationRun.id,
    kind: template.steps[0]!.outputKind,
    body: "available implementation",
  } });

  const solRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, tasks[1]!.id));
  await db.run.update({ where: { id: solRun.id }, data: { status: RunStatus.SUCCEEDED, endedAt: new Date() } });
  await db.task.update({ where: { id: tasks[1]!.id }, data: { status: TaskStatus.DONE } });
  await db.taskStepOutput.create({ data: {
    taskId: tasks[1]!.id,
    runId: solRun.id,
    kind: template.steps[1]!.outputKind,
    body: "available sol findings",
  } });

  const targetRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, tasks[2]!.id));
  const response = await claim();
  const body = await response.json() as ClaimedTask;
  assert.equal(response.status, 200);
  assert.equal(body.run.id, targetRun.id);
  assert.deepEqual(body.priorOutputs.map(({ kind }) => kind), ["review-findings"]);
});

test("a present producer without output keeps refusing the declared kind", async () => {
  const { template, tasks } = await createFixture([
    { outputKind: "implementation", priorOutputKinds: [] },
    { outputKind: "review-findings", priorOutputKinds: ["implementation"] },
    { outputKind: "blind-findings", priorOutputKinds: ["implementation"] },
    { outputKind: "fixed-implementation", priorOutputKinds: ["review-findings", "blind-findings"] },
  ]);
  const implementationRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, tasks[0]!.id));
  await db.run.update({ where: { id: implementationRun.id }, data: { status: RunStatus.SUCCEEDED, endedAt: new Date() } });
  await db.task.update({ where: { id: tasks[0]!.id }, data: { status: TaskStatus.DONE } });
  await db.taskStepOutput.create({ data: {
    taskId: tasks[0]!.id,
    runId: implementationRun.id,
    kind: template.steps[0]!.outputKind,
    body: "available implementation",
  } });

  const solRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, tasks[1]!.id));
  await db.run.update({ where: { id: solRun.id }, data: { status: RunStatus.SUCCEEDED, endedAt: new Date() } });
  await db.task.update({ where: { id: tasks[1]!.id }, data: { status: TaskStatus.DONE } });
  await db.taskStepOutput.create({ data: {
    taskId: tasks[1]!.id,
    runId: solRun.id,
    kind: template.steps[1]!.outputKind,
    body: "available sol findings",
  } });

  const targetRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, tasks[3]!.id));
  const response = await claim();
  const body = await response.json() as { error: string; reason: string };
  assert.equal(response.status, 409);
  assert.equal(body.reason, "prior-output-missing");
  assert.equal(body.error, "Prior output claim refused: missing declared output kind: blind-findings");
  const [failedRun, parkedTask] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: targetRun.id } }),
    db.task.findUniqueOrThrow({ where: { id: tasks[3]!.id } }),
  ]);
  assert.equal(failedRun.status, RunStatus.FAILED);
  assert.equal(failedRun.failureClass, FailureClass.TASK_FAILED);
  assert.equal(failedRun.retryable, false);
  assert.equal(parkedTask.status, TaskStatus.BACKLOG);
});

test("a missing declared prior output loudly refuses the claim", async () => {
  const { tasks } = await createFixture([
    { outputKind: "spec", priorOutputKinds: [] },
    { outputKind: "implementation", priorOutputKinds: ["spec", "plan-review"] },
  ]);
  const sourceRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, tasks[0]!.id));
  await db.run.update({ where: { id: sourceRun.id }, data: { status: RunStatus.SUCCEEDED, endedAt: new Date() } });
  await db.task.update({ where: { id: tasks[0]!.id }, data: { status: TaskStatus.DONE } });
  await db.taskStepOutput.create({ data: {
    taskId: tasks[0]!.id,
    runId: sourceRun.id,
    kind: "spec",
    body: "available spec",
  } });
  const targetRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, tasks[1]!.id));

  const response = await claim();
  const body = await response.json() as { error: string; reason: string };
  assert.equal(response.status, 409);
  assert.equal(body.reason, "prior-output-missing");
  assert.match(body.error, /plan-review/u);
  const [failedRun, parkedTask, activity, notice] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: targetRun.id } }),
    db.task.findUniqueOrThrow({ where: { id: tasks[1]!.id } }),
    db.taskActivity.findFirstOrThrow({ where: { taskId: tasks[1]!.id, metadata: { path: ["condition"], equals: "prior-output-missing" } } }),
    db.inboxMessage.findUniqueOrThrow({ where: { dedupeKey: `prior-output-missing:${targetRun.id}` } }),
  ]);
  assert.equal(failedRun.status, RunStatus.FAILED);
  assert.equal(failedRun.failureClass, FailureClass.TASK_FAILED);
  assert.equal(failedRun.retryable, false);
  assert.equal(parkedTask.status, TaskStatus.BACKLOG);
  assert.match(activity.body, /prior output/i);
  assert.match(notice.body, /plan-review/u);
});

test("a legacy all-prior-outputs step claims every earlier output in chain order", async () => {
  const { tasks } = await createFixture([
    { outputKind: "legacy-spec", priorOutputKinds: [] },
    { outputKind: "legacy-plan", priorOutputKinds: [] },
    { outputKind: "legacy-target", priorOutputKinds: [LEGACY_ALL_PRIOR_OUTPUTS] },
  ]);
  // Insert in reverse order so insertion order cannot satisfy the chain-order proof.
  for (const index of [1, 0]) {
    const task = tasks[index]!;
    const run = await db.$transaction((tx) => enqueueTaskRun(tx as never, task.id));
    await db.run.update({ where: { id: run.id }, data: { status: RunStatus.SUCCEEDED, endedAt: new Date() } });
    await db.task.update({ where: { id: task.id }, data: { status: TaskStatus.DONE } });
    await db.taskStepOutput.create({ data: {
      taskId: task.id,
      runId: run.id,
      kind: index === 0 ? "legacy-spec" : "legacy-plan",
      body: index === 0 ? "legacy-spec-marker" : "legacy-plan-marker",
    } });
  }
  const targetRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, tasks[2]!.id));
  const response = await claim();
  const text = await response.text();
  // No producer emits the sentinel kind: success also proves missing-kind refusal is bypassed.
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text) as ClaimedTask;
  assert.equal(body.run.id, targetRun.id);
  assert.deepEqual(body.priorOutputs.map(({ kind, body: outputBody, task }) => ({
    kind, body: outputBody, chainIndex: task.chainIndex,
  })), [
    { kind: "legacy-spec", body: "legacy-spec-marker", chainIndex: 1 },
    { kind: "legacy-plan", body: "legacy-plan-marker", chainIndex: 2 },
  ]);
});
