import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
  RunStatus,
  RunnerKind,
  TaskStatus,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "template-authoring-end-to-end-operator";
const RUNNER = "template-authoring-end-to-end-runner";

let db: PrismaClient;
let priorOperatorToken: string | undefined;
let priorRunnerToken: string | undefined;

before(() => {
  priorOperatorToken = process.env.OPERATOR_TOKEN;
  priorRunnerToken = process.env.RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
});

const unique = (label: string): string => `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`;

const seedCanonicalTemplate = async () => {
  const project = await db.project.create({ data: { name: "authoring-e2e", slug: unique("authoring-e2e") } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agents = await Promise.all(["first-agent", "left-agent", "right-agent"].map((name) => db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name,
      title: name,
      model: "gpt-5.6-sol:medium",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  })));
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: "authoring-repo",
      remoteUrl: "https://example.test/authoring.git",
      mountPath: "/repo",
      dependencyProvisioning: DependencyProvisioning.NONE,
    },
  });
  await db.agentRepoAccess.createMany({
    data: agents.map((agent) => ({
      projectId: project.id,
      agentId: agent.id,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: "GIT_WRITE" as const,
    })),
  });
  const template = await db.taskTemplate.create({
    data: {
      projectId: project.id,
      name: DIRECT_TEMPLATE_NAME,
      description: "Canonical source for the authoring story",
      variables: ["branchName", "ticket"],
    },
  });
  await db.taskTemplateStep.createMany({
    data: [
      {
        taskTemplateId: template.id,
        stepIndex: 1,
        layer: 1,
        name: "Canonical first",
        assigneeType: AssigneeType.AGENT,
        assigneeAgentId: agents[0]!.id,
        prompt: "Canonical first prompt",
        approvalGate: false,
        attachmentsFromPrevious: false,
        priorOutputKinds: [],
        spawnPolicy: { source: "canonical" },
        runner: RunnerKind.CODEX,
        outputKind: "canonical-first",
        opensPullRequest: true,
        requiresCommit: true,
        baseFromStepIndex: null,
      },
      {
        taskTemplateId: template.id,
        stepIndex: 2,
        layer: 2,
        name: "Canonical second",
        assigneeType: AssigneeType.HUMAN,
        assigneeAgentId: null,
        prompt: "Canonical second prompt",
        approvalGate: true,
        attachmentsFromPrevious: true,
        priorOutputKinds: ["canonical-first"],
        runner: null,
        outputKind: "canonical-second",
        opensPullRequest: false,
        requiresCommit: false,
        baseFromStepIndex: 1,
      },
    ],
  });
  return { project, repo, agents, template };
};

type ResponseBody = { status: number; body: any };

const operatorRequest = async (
  path: string,
  method: "GET" | "POST" | "PUT",
  body?: unknown,
): Promise<ResponseBody> => {
  const response = await createApp(db).request(path, {
    method,
    headers: {
      Authorization: `Bearer ${OPERATOR}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

const editedGraph = (agents: Array<{ id: string }>) => [
  {
    name: "Edited first",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agents[0]!.id,
    prompt: "Implement {{ticket}} on {{branchName}}",
    approvalGate: false,
    optional: false,
    attachmentsFromPrevious: false,
    priorOutputKinds: [],
    spawnPolicy: { mode: "serial", maxChildren: 1 },
    runner: RunnerKind.CODEX,
    outputKind: "e2e-first",
    opensPullRequest: false,
    requiresCommit: false,
    baseFromStepIndex: null,
    layer: 1,
  },
  {
    name: "Edited left",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agents[1]!.id,
    prompt: "Left review for {{ticket}}",
    approvalGate: false,
    optional: false,
    attachmentsFromPrevious: true,
    priorOutputKinds: ["e2e-first"],
    spawnPolicy: { mode: "parallel", maxChildren: 1 },
    runner: RunnerKind.CLAUDE,
    outputKind: "e2e-left",
    opensPullRequest: false,
    requiresCommit: false,
    baseFromStepIndex: null,
    layer: 2,
  },
  {
    name: "Edited right",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agents[2]!.id,
    prompt: "Right review for {{ticket}}",
    approvalGate: false,
    optional: false,
    attachmentsFromPrevious: true,
    priorOutputKinds: ["e2e-first"],
    spawnPolicy: null,
    runner: RunnerKind.PI,
    outputKind: "e2e-right",
    opensPullRequest: false,
    requiresCommit: false,
    baseFromStepIndex: null,
    layer: 2,
  },
  {
    name: "Edited join",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agents[0]!.id,
    prompt: "Join {{ticket}} on {{branchName}}",
    approvalGate: false,
    optional: false,
    attachmentsFromPrevious: true,
    priorOutputKinds: ["e2e-left", "e2e-right"],
    spawnPolicy: { mode: "serial", maxChildren: 1 },
    runner: RunnerKind.CODEX,
    outputKind: "e2e-join",
    opensPullRequest: false,
    requiresCommit: true,
    baseFromStepIndex: null,
    layer: 3,
  },
];

const expectedDescription = (
  prompt: string,
  outputKind: string,
  variables: Record<string, string>,
  hasPriorOutputs: boolean,
): string => {
  const interpolated = prompt.replace(
    /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
    (_match, name: string) => variables[name] ?? `{{${name}}}`,
  );
  return interpolated
    + (hasPriorOutputs ? "\nRead the prior template steps' persisted outputs before working." : "")
    + `\nPersist the final ${outputKind} output for this step through the Anneal task output endpoint.`;
};

type ClaimedRun = { run: { id: string; taskId: string }; fencingToken: string; runnerId: string };

const claimRun = async (runnerId: string, taskId: string): Promise<ClaimedRun> => {
  const response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId, leaseSeconds: 60 }),
  });
  const body = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.run.taskId, taskId, JSON.stringify(body));
  return { ...(body as Omit<ClaimedRun, "runnerId">), runnerId };
};

const completeRun = async (claim: ClaimedRun, output: string): Promise<void> => {
  const response = await createApp(db).request(`/runner/runs/${claim.run.id}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: claim.runnerId,
      fencingToken: claim.fencingToken,
      exitCode: 0,
      outcome: { case: "succeeded" },
      cleanupStatus: "SUCCEEDED",
      output,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
};

test("clone, replace, instantiate, and activate an edited fan-out chain end to end", async () => {
  const seed = await seedCanonicalTemplate();
  const sourceBefore = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: seed.template.id },
    orderBy: { stepIndex: "asc" },
  });

  const cloned = await operatorRequest(
    `/projects/${seed.project.id}/task-templates/${seed.template.id}/clone`,
    "POST",
    { name: "  authored-fan-out  " },
  );
  assert.equal(cloned.status, 201, JSON.stringify(cloned.body));
  assert.equal(cloned.body.name, "authored-fan-out");
  assert.notEqual(cloned.body.name, DIRECT_TEMPLATE_NAME);

  const cloneRead = await operatorRequest(`/task-templates/${cloned.body.id}`, "GET");
  assert.equal(cloneRead.status, 200, JSON.stringify(cloneRead.body));
  assert.equal(cloneRead.body.name, "authored-fan-out");
  assert.notEqual(cloneRead.body.name, DIRECT_TEMPLATE_NAME);

  const graph = editedGraph(seed.agents);
  const replaced = await operatorRequest(
    `/projects/${seed.project.id}/task-templates/${cloned.body.id}/steps`,
    "PUT",
    { steps: graph },
  );
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.deepEqual(
    replaced.body.template.steps.map((step: any) => ({
      stepIndex: step.stepIndex,
      name: step.name,
      layer: step.layer,
      assigneeAgentId: step.assigneeAgentId,
    })),
    graph.map((step, index) => ({
      stepIndex: index + 1,
      name: step.name,
      layer: step.layer,
      assigneeAgentId: step.assigneeAgentId,
    })),
  );

  const variables = { branchName: "feature/authoring", ticket: "AUTH-42" };
  const instantiated = await operatorRequest(
    `/projects/${seed.project.id}/task-templates/${cloned.body.id}/instantiate`,
    "POST",
    { repoId: seed.repo.id, variables, name: "authored fan-out", autoStart: true },
  );
  assert.equal(instantiated.status, 201, JSON.stringify(instantiated.body));

  const tasks = await db.task.findMany({
    where: { chainId: instantiated.body.chainId },
    orderBy: { chainIndex: "asc" },
  });
  assert.equal(tasks.length, 4);
  assert.deepEqual(
    tasks.map((task) => ({ name: task.name, layer: task.chainLayer, assigneeAgentId: task.assigneeAgentId })),
    graph.map((step) => ({
      name: `authored fan-out: ${step.name}`,
      layer: step.layer,
      assigneeAgentId: step.assigneeAgentId,
    })),
  );
  assert.deepEqual(
    tasks.map((task) => task.description),
    graph.map((step) => expectedDescription(
      step.prompt,
      step.outputKind,
      variables,
      step.priorOutputKinds.length > 0,
    )),
  );

  const initialRuns = await db.run.findMany({
    where: { task: { chainId: instantiated.body.chainId } },
    select: { taskId: true, status: true },
  });
  assert.deepEqual(initialRuns, [{ taskId: tasks[0]!.id, status: RunStatus.QUEUED }]);

  const firstClaim = await claimRun("e2e-first-runner", tasks[0]!.id);
  await completeRun(firstClaim, "first completed");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: tasks[0]!.id } })).status, TaskStatus.DONE);
  assert.deepEqual(
    await db.run.findMany({
      where: { taskId: { in: [tasks[1]!.id, tasks[2]!.id] } },
      select: { taskId: true, status: true },
      orderBy: { taskId: "asc" },
    }),
    [
      { taskId: tasks[1]!.id, status: RunStatus.QUEUED },
      { taskId: tasks[2]!.id, status: RunStatus.QUEUED },
    ].sort((left, right) => left.taskId.localeCompare(right.taskId)),
  );
  assert.equal(await db.run.count({ where: { taskId: tasks[3]!.id } }), 0);

  const leftClaim = await claimRun("e2e-left-runner", tasks[1]!.id);
  const rightClaim = await claimRun("e2e-right-runner", tasks[2]!.id);
  await Promise.all([
    completeRun(leftClaim, "left completed"),
    completeRun(rightClaim, "right completed"),
  ]);
  assert.deepEqual(
    await db.task.findMany({
      where: { id: { in: [tasks[1]!.id, tasks[2]!.id] } },
      select: { id: true, status: true },
      orderBy: { id: "asc" },
    }),
    [
      { id: tasks[1]!.id, status: TaskStatus.DONE },
      { id: tasks[2]!.id, status: TaskStatus.DONE },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );
  assert.equal(await db.run.count({ where: { taskId: tasks[3]!.id } }), 1);
  assert.equal(
    await db.run.count({ where: { taskId: tasks[3]!.id, status: RunStatus.QUEUED } }),
    1,
  );

  const sourceAfter = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: seed.template.id },
    orderBy: { stepIndex: "asc" },
  });
  assert.deepEqual(sourceAfter, sourceBefore);
  assert.equal((await db.taskTemplate.findUniqueOrThrow({ where: { id: seed.template.id } })).name, DIRECT_TEMPLATE_NAME);
});
