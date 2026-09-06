import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  activateChainSuccessor,
  applyInboxDecisionTx,
  DependencyProvisioning,
  enqueueTaskRun,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  Prisma,
  PrismaClient,
  TaskStatus,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

let db: PrismaClient;
const RUNNER_TOKEN = "dispatch-activation-runner-token";
const OPERATOR_TOKEN = "dispatch-activation-operator-token";
const priorRunnerToken = process.env.RUNNER_TOKEN;
const priorOperatorToken = process.env.OPERATOR_TOKEN;

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = priorRunnerToken;
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorOperatorToken;
});

type BindingFixture = {
  project: { id: string };
  agent: { id: string };
  repo: { id: string; name: string; defaultBranch: string };
  predecessor: Awaited<ReturnType<typeof db.task.create>>;
  firstPredecessor: Awaited<ReturnType<typeof db.task.create>>;
  successor: Awaited<ReturnType<typeof db.task.create>>;
};

const seedBinding = async (input: {
  predecessorLayers?: number;
  terminalStatus?: TaskStatus;
  bind?: boolean;
} = {}): Promise<BindingFixture> => {
  const suffix = randomUUID();
  const project = await db.project.create({ data: { name: `dispatch-${suffix}`, slug: `dispatch-${suffix}` } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "dispatch-test",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `dispatch-agent-${suffix}`,
    title: "Dispatch test agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: `dispatch-repo-${suffix}`,
    remoteUrl: "https://example.test/dispatch.git",
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

  const predecessorLayers = input.predecessorLayers ?? 1;
  const predecessorTasks = [];
  for (let layer = 0; layer < predecessorLayers; layer += 1) {
    predecessorTasks.push(await db.task.create({ data: {
      projectId: project.id,
      repoId: repo.id,
      assigneeAgentId: agent.id,
      name: `Predecessor ${layer + 1}`,
      description: `predecessor ${layer + 1}`,
      chainId: `predecessor-${suffix}`,
      chainIndex: layer,
      chainLayer: layer,
      status: layer === predecessorLayers - 1
        ? input.terminalStatus ?? TaskStatus.DONE
        : TaskStatus.DONE,
    } }));
  }
  const predecessor = predecessorTasks.at(-1)!;
  const successor = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    assigneeAgentId: agent.id,
    name: "Bound successor",
    description: "bound successor",
    chainId: `successor-${suffix}`,
    chainIndex: 0,
    chainLayer: 0,
    status: TaskStatus.TODO,
    ...(input.bind === false ? {} : { dispatchAfterTaskId: predecessor.id }),
  } });
  return {
    project,
    agent,
    repo,
    predecessor,
    firstPredecessor: predecessorTasks[0]!,
    successor,
  };
};

const bindingMetadata = (value: unknown): Record<string, unknown> => {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
};

const seedRunningPredecessor = async (fixture: BindingFixture) => {
  await db.task.update({ where: { id: fixture.predecessor.id }, data: { status: TaskStatus.DOING } });
  const runnerId = `dispatch-runner-${randomUUID()}`;
  const fencingToken = `dispatch-fence-${randomUUID()}`;
  const run = await db.run.create({ data: {
    projectId: fixture.project.id,
    taskId: fixture.predecessor.id,
    agentId: fixture.agent.id,
    repoId: fixture.repo.id,
    runNumber: 1,
    dedupeKey: `task:${fixture.predecessor.id}:run:1`,
    runner: "CLAUDE",
    runnerId,
    fencingToken,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    status: "RUNNING",
    model: "claude",
    promptHash: "dispatch-completion",
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: fixture.project.id,
    agentId: fixture.agent.id,
    taskId: fixture.predecessor.id,
    runner: "CLAUDE",
    executionStatus: "RUNNING",
  } });
  return { run, runnerId, fencingToken };
};

const completionBody = (runnerId: string, fencingToken: string) => ({
  runnerId,
  fencingToken,
  exitCode: 0,
  outcome: { case: "succeeded" },
  cleanupStatus: "SUCCEEDED",
});

test("terminal completion dispatches one run with the ordinary enqueue configuration and audit metadata", async () => {
  const fixture = await seedBinding();
  const plain = await db.task.create({ data: {
    projectId: fixture.project.id,
    repoId: fixture.repo.id,
    assigneeAgentId: fixture.agent.id,
    name: fixture.successor.name,
    description: fixture.successor.description,
    chainId: `plain-${randomUUID()}`,
    chainIndex: 0,
    chainLayer: 0,
  } });
  const plainRun = await db.$transaction((tx) => enqueueTaskRun(tx, plain.id));

  await db.$transaction((tx) => activateChainSuccessor(tx, fixture.predecessor, {}, new Date()));

  const dispatchedRun = await db.run.findFirstOrThrow({ where: { taskId: fixture.successor.id } });
  assert.equal(dispatchedRun.runNumber, 1);
  assert.deepEqual(
    {
      agentId: dispatchedRun.agentId,
      repoId: dispatchedRun.repoId,
      runner: dispatchedRun.runner,
      model: dispatchedRun.model,
      codexServiceTier: dispatchedRun.codexServiceTier,
      promptHash: dispatchedRun.promptHash,
      targetBranch: dispatchedRun.targetBranch,
      opensPullRequest: dispatchedRun.opensPullRequest,
      maxDurationMin: dispatchedRun.maxDurationMin,
      stallTimeoutMin: dispatchedRun.stallTimeoutMin,
      maxRunsPerTask: dispatchedRun.maxRunsPerTask,
      budgetGrants: dispatchedRun.budgetGrants,
    },
    {
      agentId: plainRun.agentId,
      repoId: plainRun.repoId,
      runner: plainRun.runner,
      model: plainRun.model,
      codexServiceTier: plainRun.codexServiceTier,
      promptHash: plainRun.promptHash,
      targetBranch: plainRun.targetBranch,
      opensPullRequest: plainRun.opensPullRequest,
      maxDurationMin: plainRun.maxDurationMin,
      stallTimeoutMin: plainRun.stallTimeoutMin,
      maxRunsPerTask: plainRun.maxRunsPerTask,
      budgetGrants: plainRun.budgetGrants,
    },
  );

  const successorActivity = await db.taskActivity.findFirstOrThrow({
    where: { taskId: fixture.successor.id, body: "Bound predecessor completed; first step queued" },
    orderBy: { id: "desc" },
  });
  const predecessorActivity = await db.taskActivity.findFirstOrThrow({
    where: { taskId: fixture.predecessor.id, body: "Bound chain dispatched" },
    orderBy: { id: "desc" },
  });
  for (const metadata of [successorActivity.metadata, predecessorActivity.metadata]) {
    assert.deepEqual(bindingMetadata(metadata), {
      predecessorTaskId: fixture.predecessor.id,
      predecessorChainId: fixture.predecessor.chainId,
      successorTaskId: fixture.successor.id,
      successorChainId: fixture.successor.chainId,
      state: "queued",
      runId: dispatchedRun.id,
    });
  }
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.successor.id } })).dispatchAfterTaskId, fixture.predecessor.id);
});

test("run completion dispatches a bound successor through the production runner route", async () => {
  const fixture = await seedBinding({ terminalStatus: TaskStatus.TODO });
  const running = await seedRunningPredecessor(fixture);
  const response = await createApp(db).request(`/runner/runs/${running.run.id}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(completionBody(running.runnerId, running.fencingToken)),
  });
  assert.equal(response.status, 200);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.predecessor.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 1);
});

for (const archiveFirst of [false, true]) {
  test(`runner completion fans out independently with first successor ${archiveFirst ? "archived" : "active"}`, async () => {
    const fixture = await seedBinding({ terminalStatus: TaskStatus.TODO });
    // Sort the optionally parked successor first, proving its outcome does not
    // short-circuit dispatch of the next binding.
    const first = await db.task.update({
      where: { id: fixture.successor.id },
      data: { id: `a-${randomUUID()}`, ...(archiveFirst ? { archivedAt: new Date() } : {}) },
    });
    const second = await db.task.create({ data: {
      id: `z-${randomUUID()}`,
      projectId: fixture.project.id,
      repoId: fixture.repo.id,
      assigneeAgentId: fixture.agent.id,
      name: "Second bound successor",
      description: "independent dispatch",
      chainId: `second-successor-${randomUUID()}`,
      chainIndex: 0,
      chainLayer: 0,
      dispatchAfterTaskId: fixture.predecessor.id,
    } });
    const running = await seedRunningPredecessor(fixture);
    const response = await createApp(db).request(`/runner/runs/${running.run.id}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(completionBody(running.runnerId, running.fencingToken)),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.predecessor.id } })).status, TaskStatus.DONE);
    for (const successor of [first, second]) {
      const runs = await db.run.findMany({ where: { taskId: successor.id } });
      const parked = archiveFirst && successor.id === first.id;
      assert.equal(runs.length, parked ? 0 : 1);
      if (!parked) assert.equal(runs[0]!.status, "QUEUED");
    }
    const dispatched = await db.taskActivity.findMany({
      where: { taskId: fixture.predecessor.id, body: "Bound chain dispatched" },
    });
    assert.deepEqual(
      dispatched.map((row) => bindingMetadata(row.metadata).successorTaskId).sort(),
      (archiveFirst ? [second.id] : [first.id, second.id]).sort(),
    );
    if (archiveFirst) {
      const activities = await db.taskActivity.findMany({ where: { taskId: first.id } });
      assert.equal(activities.length, 1);
      assert.match(activities[0]!.body, /parked in REVIEW/u);
      assert.equal(bindingMetadata(activities[0]!.metadata).state, "parked");
    }
  });
}

// The two bound invariants break in different ways. The merge-execution
// sentinel is still an identity, so renaming its Agent breaks it; §R14 made
// the compound implementation root a *capability*, so what breaks it is the
// Agent losing its Codex `gpt-*` runtime configuration, and a rename does not.
for (const invariant of [
  {
    name: "merge-integrator rename",
    bind: { name: INTEGRATOR_AGENT_NAME },
    breakBinding: { name: "renamed-merge-integrator" },
    templateName: INTEGRATOR_TEMPLATE_NAME,
    stepIndex: INTEGRATOR_STEP_INDEX,
    outputKind: INTEGRATOR_OUTPUT_KIND,
    expectedReason: /A merge-execution step may bind only agent merge-integrator/u,
    expectedRefusal: "integrator-binding-invalid",
  },
  {
    name: "compound implementation capability loss",
    bind: { model: "gpt-6-astra:medium", runnerPreference: "CODEX" },
    breakBinding: { model: "claude-opus-5:high", runnerPreference: "CLAUDE" },
    templateName: INTEGRATOR_TEMPLATE_NAME,
    stepIndex: 5,
    outputKind: "implementation",
    expectedReason: /Compound implementation step requires an active in-project Agent on a Codex gpt-\* model/u,
    expectedRefusal: "compound-implementation-assignee",
  },
] as const) {
  test(`runner completion preserves DONE and parks a post-instantiation ${invariant.name}`, async () => {
    const fixture = await seedBinding({ terminalStatus: TaskStatus.TODO });
    await db.agent.update({ where: { id: fixture.agent.id }, data: invariant.bind });
    const template = await db.taskTemplate.create({ data: {
      projectId: fixture.project.id,
      name: invariant.templateName,
      description: `${invariant.name} rename regression`,
      variables: [],
    } });
    const step = await db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id,
      assigneeAgentId: fixture.agent.id,
      stepIndex: invariant.stepIndex,
      layer: invariant.stepIndex,
      name: "Bound successor",
      assigneeType: "AGENT",
      prompt: "dispatch after predecessor",
      outputKind: invariant.outputKind,
    } });
    await db.task.update({
      where: { id: fixture.successor.id },
      data: { templateId: template.id, templateStepId: step.id },
    });
    await db.agent.update({ where: { id: fixture.agent.id }, data: invariant.breakBinding });
    const running = await seedRunningPredecessor(fixture);

    const response = await createApp(db).request(`/runner/runs/${running.run.id}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(completionBody(running.runnerId, running.fencingToken)),
    });

    assert.equal(response.status, 200, await response.text());
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.predecessor.id } })).status, TaskStatus.DONE);
    const successor = await db.task.findUniqueOrThrow({ where: { id: fixture.successor.id } });
    assert.equal(successor.status, TaskStatus.REVIEW);
    assert.match(successor.failureReason ?? "", invariant.expectedReason);
    assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 0);
    const activity = await db.taskActivity.findFirstOrThrow({
      where: { taskId: fixture.successor.id, body: { contains: "parked in REVIEW" } },
      orderBy: { id: "desc" },
    });
    assert.equal(bindingMetadata(activity.metadata).refusal, invariant.expectedRefusal);
  });
}

test("approval-gate approval dispatches a bound successor through the inbox completion path", async () => {
  const fixture = await seedBinding({ terminalStatus: TaskStatus.REVIEW });
  await db.task.update({ where: { id: fixture.predecessor.id }, data: { approvalGate: true } });
  const run = await db.run.create({ data: {
    projectId: fixture.project.id,
    taskId: fixture.predecessor.id,
    agentId: fixture.agent.id,
    repoId: fixture.repo.id,
    runNumber: 1,
    dedupeKey: `task:${fixture.predecessor.id}:gate-run:1`,
    runner: "CLAUDE",
    model: "claude",
    promptHash: "dispatch-gate",
    status: "SUCCEEDED",
  } });
  const session = await db.session.create({ data: {
    runId: run.id,
    projectId: fixture.project.id,
    agentId: fixture.agent.id,
    taskId: fixture.predecessor.id,
    runner: "CLAUDE",
  } });
  const gate = await db.inboxMessage.create({ data: {
    from: "AGENT",
    agentId: fixture.agent.id,
    sessionId: session.id,
    taskId: fixture.predecessor.id,
    gateTaskId: fixture.predecessor.id,
    kind: "MULTIPLE_CHOICE",
    body: "Approve this predecessor",
    choices: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
    dedupeKey: `gate:dispatch:${fixture.predecessor.id}`,
  } });
  const decision = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: gate.id,
    externalEventId: `dispatch-gate-${randomUUID()}`,
    decision: "approve",
  }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  assert.equal(decision.gateAction, "approved");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.predecessor.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 1);
});

test("run completion and approval dispatch once while operator DONE replay is idempotent", async () => {
  const fixture = await seedBinding({ terminalStatus: TaskStatus.TODO });
  await db.task.update({ where: { id: fixture.predecessor.id }, data: { approvalGate: true } });
  const running = await seedRunningPredecessor(fixture);

  const completion = await createApp(db).request(`/runner/runs/${running.run.id}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(completionBody(running.runnerId, running.fencingToken)),
  });
  assert.equal(completion.status, 200, await completion.text());
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.predecessor.id } })).status, TaskStatus.REVIEW);
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 0);

  const gate = await db.inboxMessage.findFirstOrThrow({
    where: { gateTaskId: fixture.predecessor.id, status: "OPEN" },
  });
  const decision = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: gate.id,
    externalEventId: `dispatch-three-entrypoints-${randomUUID()}`,
    decision: "approve",
  }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  assert.equal(decision.gateAction, "approved");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.predecessor.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 1);

  const replay = await createApp(db).request(`/tasks/${fixture.predecessor.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: TaskStatus.DONE }),
  });
  assert.equal(replay.status, 200, await replay.text());
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 1);
});

test("operator DONE cannot dispatch an AGENT successor binding through PATCH", async () => {
  const fixture = await seedBinding({ terminalStatus: TaskStatus.TODO });
  const response = await createApp(db).request(`/tasks/${fixture.predecessor.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: TaskStatus.DONE }),
  });
  assert.equal(response.status, 409);
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 0);
});

test("concurrent terminal completion attempts queue exactly one bound successor run", { timeout: 20_000 }, async () => {
  const fixture = await seedBinding();
  const otherDb = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const complete = (client: PrismaClient) => client.$transaction(
    (tx) => activateChainSuccessor(tx, fixture.predecessor, {}, new Date()),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  try {
    await Promise.all([complete(db), complete(otherDb)]);
  } finally {
    await otherDb.$disconnect();
  }
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.successor.id } })).status, TaskStatus.TODO);
});

test("dispatch waits for the terminal layer after failed and retried predecessor runs", async () => {
  const fixture = await seedBinding({ predecessorLayers: 2, terminalStatus: TaskStatus.TODO });
  await db.$transaction((tx) => activateChainSuccessor(tx, fixture.firstPredecessor, {}, new Date()));
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 0);

  const firstRun = await db.run.findFirstOrThrow({ where: { taskId: fixture.predecessor.id } });
  await db.run.update({ where: { id: firstRun.id }, data: { status: "FAILED" } });
  await db.task.update({ where: { id: fixture.predecessor.id }, data: { status: TaskStatus.TODO } });
  await db.$transaction((tx) => activateChainSuccessor(tx, fixture.firstPredecessor, {}, new Date()));
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 0);

  await db.task.update({ where: { id: fixture.predecessor.id }, data: { status: TaskStatus.DONE } });
  await db.$transaction((tx) => activateChainSuccessor(tx, fixture.predecessor, {}, new Date()));
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 1);
});

test("a DONE terminal task with an unfinished lower layer parks instead of dispatching", async () => {
  const fixture = await seedBinding({ predecessorLayers: 2 });
  await db.task.update({ where: { id: fixture.firstPredecessor.id }, data: { status: TaskStatus.TODO } });

  await db.$transaction((tx) => activateChainSuccessor(tx, fixture.predecessor, {}, new Date()));

  const successor = await db.task.findUniqueOrThrow({ where: { id: fixture.successor.id } });
  assert.equal(successor.status, TaskStatus.REVIEW);
  assert.match(successor.failureReason ?? "", /bound predecessor is no longer terminal/u);
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 0);
});

test("a non-terminal replay parks an already dispatched queued successor", async () => {
  const fixture = await seedBinding();
  await db.$transaction((tx) => activateChainSuccessor(tx, fixture.predecessor, {}, new Date()));
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 1);

  await db.task.create({ data: {
    projectId: fixture.project.id,
    repoId: fixture.repo.id,
    assigneeAgentId: fixture.agent.id,
    name: "Later predecessor layer",
    description: "added after the binding resolved",
    chainId: fixture.predecessor.chainId,
    chainIndex: 1,
    chainLayer: 1,
    status: TaskStatus.TODO,
  } });
  await db.$transaction((tx) => activateChainSuccessor(tx, fixture.predecessor, {}, new Date()));

  const successor = await db.task.findUniqueOrThrow({ where: { id: fixture.successor.id } });
  const failureReason = "bound predecessor is no longer terminal; successor was not queued";
  assert.equal(successor.status, TaskStatus.REVIEW);
  assert.equal(successor.failureReason, failureReason);
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 1);
  const activities = await db.taskActivity.findMany({
    where: {
      taskId: { in: [fixture.predecessor.id, fixture.successor.id] },
      body: { contains: failureReason },
    },
  });
  assert.deepEqual(new Set(activities.map((row) => row.taskId)), new Set([
    fixture.predecessor.id,
    fixture.successor.id,
  ]));
  assert.equal(activities.length, 2);
  for (const activity of activities) {
    assert.deepEqual(bindingMetadata(activity.metadata), {
      predecessorTaskId: fixture.predecessor.id,
      predecessorChainId: fixture.predecessor.chainId,
      successorTaskId: fixture.successor.id,
      successorChainId: fixture.successor.chainId,
      state: "parked",
      failureReason,
      predecessorTerminal: false,
    });
  }
});

test("unbound terminal completion keeps the legacy Chain complete activity and has no dispatch side effect", async () => {
  const fixture = await seedBinding({ bind: false });
  await db.$transaction((tx) => activateChainSuccessor(tx, fixture.predecessor, {}, new Date()));
  assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 0);
  assert.equal(await db.taskActivity.count({ where: { taskId: fixture.predecessor.id, body: "Chain complete" } }), 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.successor.id } })).dispatchAfterTaskId, null);
});

for (const refusal of [
  {
    name: "an archived successor task",
    prepare: async (fixture: BindingFixture) => {
      await db.task.update({ where: { id: fixture.successor.id }, data: { archivedAt: new Date() } });
    },
    expected: /successor .* is archived/u,
  },
  {
    name: "an archived successor assignee",
    prepare: async (fixture: BindingFixture) => {
      await db.agent.update({ where: { id: fixture.agent.id }, data: { archivedAt: new Date() } });
    },
    expected: /assignee .* is archived/u,
  },
  {
    name: "a revoked successor repository grant",
    prepare: async (fixture: BindingFixture) => {
      await db.agentRepoAccess.delete({ where: { agentId_repoId: { agentId: fixture.agent.id, repoId: fixture.repo.id } } });
    },
    expected: /has no grant for Repo/u,
  },
] as const) {
  test(`fail-closed dispatch parks ${refusal.name} and preserves predecessor completion`, async () => {
    const fixture = await seedBinding();
    await refusal.prepare(fixture);
    await db.$transaction((tx) => activateChainSuccessor(tx, fixture.predecessor, {}, new Date()));

    const predecessor = await db.task.findUniqueOrThrow({ where: { id: fixture.predecessor.id } });
    const successor = await db.task.findUniqueOrThrow({ where: { id: fixture.successor.id } });
    assert.equal(predecessor.status, TaskStatus.DONE);
    assert.equal(successor.status, TaskStatus.REVIEW);
    assert.match(successor.failureReason ?? "", refusal.expected);
    assert.equal(await db.run.count({ where: { taskId: fixture.successor.id } }), 0);
    const activities = await db.taskActivity.findMany({
      where: { taskId: { in: [fixture.predecessor.id, fixture.successor.id] } },
      orderBy: { id: "asc" },
    });
    assert.equal(activities.filter((row) => row.taskId === fixture.predecessor.id).length, 2);
    assert.equal(activities.filter((row) => row.taskId === fixture.successor.id).length, 1);
    const parkedActivity = activities.find((row) => row.taskId === fixture.successor.id && row.body.includes("parked in REVIEW"));
    assert.ok(parkedActivity);
    assert.equal(bindingMetadata(parkedActivity.metadata).predecessorTaskId, fixture.predecessor.id);
  });
}
