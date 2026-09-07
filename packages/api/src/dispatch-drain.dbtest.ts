import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  DependencyProvisioning,
  enqueueTaskRun,
  PrismaClient,
  RunnerPreference,
  RunStatus,
  TaskStatus,
} from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";

import { createApp } from "./test-app.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { claimReadinessStep } from "./readiness-claim.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const RUNNER_TOKEN = "dispatch-drain-runner-token";
const OPERATOR_TOKEN = "dispatch-drain-operator-token";
const RUNNER_ID = "dispatch-drain-runner";
const EXECUTOR_TOKEN = "dispatch-drain-merge-executor-token";
const EXECUTOR_RUNNER_ID = "dispatch-drain-merge-executor";
const READY_AT = new Date("2026-08-01T00:00:00.000Z");

let db: PrismaClient;
// One app per test. The runner registry behind `GET /runners` is in-memory
// state owned by an app instance, so the claim that reports a runner and the
// read that must see it online have to run against the same instance.
let app: ReturnType<typeof createApp>;
const previousEnvironment = {
  runner: process.env.RUNNER_TOKEN,
  operator: process.env.OPERATOR_TOKEN,
  executor: process.env.MERGE_EXECUTOR_TOKEN,
  executorIds: process.env.MERGE_EXECUTOR_RUNNER_IDS,
};

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR_TOKEN;
  process.env.MERGE_EXECUTOR_TOKEN = EXECUTOR_TOKEN;
  process.env.MERGE_EXECUTOR_RUNNER_IDS = EXECUTOR_RUNNER_ID;
  db = setupTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  app = createApp(db);
});
after(async () => {
  await db.$disconnect();
  for (const [key, value] of [
    ["RUNNER_TOKEN", previousEnvironment.runner],
    ["OPERATOR_TOKEN", previousEnvironment.operator],
    ["MERGE_EXECUTOR_TOKEN", previousEnvironment.executor],
    ["MERGE_EXECUTOR_RUNNER_IDS", previousEnvironment.executorIds],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const seedQueuedRun = async () => {
  const suffix = randomUUID();
  const project = await db.project.create({ data: {
    name: `Dispatch drain ${suffix}`,
    slug: `dispatch-drain-${suffix}`,
  } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "local",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "dispatch-drain-agent",
    title: "Dispatch drain agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "dispatch-drain-repo",
    remoteUrl: "https://example.test/dispatch-drain.git",
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
  const task = await db.task.create({ data: {
    projectId: project.id,
    assigneeAgentId: agent.id,
    repoId: repo.id,
    name: "Dispatch drain step",
    description: "Dispatch drain fixture",
    status: TaskStatus.TODO,
    maxSessionsPerTask: 5,
  } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx, task.id, READY_AT));
  return { task, run };
};

const claim = async (): Promise<{ status: number; body: any }> => {
  return claimAs(RUNNER_TOKEN, RUNNER_ID);
};

const claimAs = async (token: string, runnerId: string): Promise<{ status: number; body: any }> => {
  const response = await app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId,
      leaseSeconds: 60,
      contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
    }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json().catch(() => null) as any,
  };
};

const runners = async (): Promise<{ status: number; body: any }> => {
  const response = await app.request("/runners", {
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` },
  });
  return { status: response.status, body: await response.json() as any };
};

const openDrain = async (expiresAt: Date, reason = "quiet-window-wait-exceeded host=test-host role=control-plane from=aaaaaaaaaaaa to=bbbbbbbbbbbb") =>
  db.dispatchDrain.create({ data: { reason, requestedBy: "auto-deploy:dispatch-drain-dbtest", expiresAt } });

/** What the drain must leave untouched: the queued Run, the Task it belongs
 * to, and everything `maxSessionsPerTask` is counted from. */
const accounting = async (taskId: string) => ({
  task: await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { status: true, maxSessionsPerTask: true, failureReason: true },
  }),
  runs: await db.run.findMany({
    where: { taskId },
    select: { id: true, status: true, runNumber: true, budgetGrants: true, leaseGeneration: true },
    orderBy: { runNumber: "asc" },
  }),
  sessions: await db.session.count({ where: { taskId } }),
});

test("an unexpired dispatch drain refuses every claim and charges the task nothing", async () => {
  const { task, run } = await seedQueuedRun();
  const before = await accounting(task.id);
  const drain = await openDrain(new Date(Date.now() + 30 * 60_000));

  for (let poll = 0; poll < 3; poll += 1) {
    const refused = await claim();
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.reason, "dispatch-draining");
    assert.equal(refused.body.code, "dispatch-draining");
    assert.equal(refused.body.expiresAt, drain.expiresAt.toISOString());
    assert.match(refused.body.error, /Dispatch is draining for a pending deploy/u);
  }

  // Nothing was parked, nothing was charged, and the Run is still claimable.
  assert.deepEqual(await accounting(task.id), before);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.QUEUED);

  const status = await runners();
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.dispatchDrain, {
    reason: drain.reason,
    startedAt: drain.startedAt.toISOString(),
    expiresAt: drain.expiresAt.toISOString(),
  });
  // The refused runner reported itself on every claim, so it reads as online
  // rather than lost: the drain is what explains the idle fleet.
  assert.deepEqual(
    status.body.daemons.map((daemon: { runnerId: string; online: boolean }) => ({
      runnerId: daemon.runnerId,
      online: daemon.online,
    })),
    [{ runnerId: RUNNER_ID, online: true }],
  );
  assert.equal(status.body.online, 1);
});

test("a drain scopes refusal to agent Runs while mechanical merge and readiness work continue", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "drain-scope",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });
  assert.ok(chain.readinessTask);
  assert.ok(chain.integratorTask);

  // Queue an ordinary Run first so the merge executor has to pass over an
  // agent candidate before it reaches the mechanical merge Run.
  const ordinaryTask = await db.task.create({ data: {
    projectId: chain.project.id,
    repoId: chain.repo.id,
    name: "Drain scope implementation",
    description: "agent work must wait for the drain",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: chain.agent.id,
    status: TaskStatus.TODO,
  } });
  const ordinaryRun = await db.$transaction((tx) => enqueueTaskRun(tx, ordinaryTask.id, READY_AT));
  const mechanicalRun = await db.$transaction((tx) => enqueueTaskRun(tx, chain.integratorTask!.id, READY_AT));
  const drain = await openDrain(new Date(Date.now() + 30 * 60_000));

  const refused = await claim();
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.reason, "dispatch-draining");
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: ordinaryRun.id } })).status, RunStatus.QUEUED);

  // Readiness evaluation is a server-owned Task claim, so the dispatch drain
  // does not block it. The unexpired row remains in force for the executor
  // claim below.
  const readiness = await claimReadinessStep(db, chain.readinessTask.id, new Date());
  assert.ok(readiness, "readiness evaluation should remain claimable during a drain");

  const claimed = await claimAs(EXECUTOR_TOKEN, EXECUTOR_RUNNER_ID);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.run.id, mechanicalRun.id);
  assert.equal(claimed.body.executionMode, "mechanical");
  assert.equal((await db.dispatchDrain.findUniqueOrThrow({ where: { id: drain.id } })).id, drain.id);
});

test("deleting the drain admits the very next claim", async () => {
  const { task, run } = await seedQueuedRun();
  const drain = await openDrain(new Date(Date.now() + 30 * 60_000));
  assert.equal((await claim()).status, 409);

  await db.dispatchDrain.delete({ where: { id: drain.id } });

  const claimed = await claim();
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.run.id, run.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.CLAIMED);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, TaskStatus.DOING);
  assert.equal((await runners()).body.dispatchDrain, null);
});

test("an expired drain is absent: a dead deploy cannot drain the fleet for good", async () => {
  const { run } = await seedQueuedRun();
  const expired = await openDrain(new Date(Date.now() - 60_000));

  const claimed = await claim();
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.run.id, run.id);
  // The row is still there; it is the deadline, not a delete, that ended it.
  assert.notEqual(await db.dispatchDrain.findUnique({ where: { id: expired.id } }), null);
  assert.equal((await runners()).body.dispatchDrain, null);
});

test("a drained claim cannot park a Task after its Repo grant is revoked", async () => {
  const { task } = await seedQueuedRun();
  await db.agentRepoAccess.deleteMany({ where: { agentId: task.assigneeAgentId! } });
  const before = await accounting(task.id);
  await openDrain(new Date(Date.now() + 30 * 60_000));
  const refused = await claim();
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "dispatch-draining");
  assert.deepEqual(await accounting(task.id), before);
  assert.equal((await accounting(task.id)).task.status, TaskStatus.TODO);
});

test("quiet-window SQL excludes active mechanical Steps and preserves agent and host scope", async () => {
  const { blockingRunsStatement } = await import(new URL("../../../scripts/deploy/deploy-preflight.mjs", import.meta.url).href);
  const chain = await seedIntegratorChain(db, { label: "blocker-scope", shape: "canonical-compound-readiness", gatedReadiness: true });
  assert.ok(chain.integratorTask);
  assert.ok(chain.readinessTask);
  // Compound implementation Run birth requires a Codex/gpt-capable Agent;
  // the shared merge-tail fixture uses Claude for its Regression predecessor.
  await db.agent.update({ where: { id: chain.agent.id }, data: {
    model: "gpt-6-astra:medium", runnerPreference: RunnerPreference.CODEX,
  } });
  const implementationStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: chain.template.id, stepIndex: 0, layer: 0, name: "Implementation",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: chain.agent.id,
    prompt: "implement", outputKind: "implementation",
  } });
  const implementationTask = await db.task.create({ data: {
    projectId: chain.project.id, repoId: chain.repo.id, templateId: chain.template.id,
    templateStepId: implementationStep.id, assigneeAgentId: chain.agent.id,
    name: "Blocker implementation", description: "active agent work", status: TaskStatus.TODO,
  } });
  const agentRun = await db.$transaction((tx) => enqueueTaskRun(tx, implementationTask.id, READY_AT));
  const mechanicalRun = await db.$transaction((tx) => enqueueTaskRun(tx, chain.integratorTask!.id, READY_AT));
  await db.run.update({ where: { id: agentRun.id }, data: { status: RunStatus.RUNNING, runnerId: "agent-host" } });
  await db.run.update({ where: { id: mechanicalRun.id }, data: { status: RunStatus.RUNNING, runnerId: "merge-host" } });
  const read = async (runnerIds: string[] | null = null) => {
    const statement = blockingRunsStatement(undefined, runnerIds);
    return db.$queryRawUnsafe<Array<{ id: string }>>(statement.sql, ...statement.parameters);
  };
  assert.deepEqual((await read()).map(({ id }) => id), [agentRun.id]);
  assert.deepEqual(await read(["merge-host"]), []);
  assert.deepEqual((await read(["agent-host"])).map(({ id }) => id), [agentRun.id]);
  await db.run.update({ where: { id: agentRun.id }, data: { status: RunStatus.SUCCEEDED } });
  assert.deepEqual(await read(), [], "mechanical work alone leaves the natural quiet window open");
  const { automaticCadenceForTick } = await import(new URL("../../../scripts/deploy/quiet-window-deploy.mjs", import.meta.url).href);
  const cadence = await automaticCadenceForTick({
    targetCommit: "b".repeat(40), readDeployed: () => "a".repeat(40),
    readBlockingRuns: read, environment: {},
    now: () => new Date("2026-09-07T12:00:00Z"),
    readLastSuccessful: () => new Date("2026-09-07T11:00:00Z"),
  });
  assert.notEqual(cadence.coalesced, true);
  assert.equal(cadence.allowWait, false, "the mechanical-only tick takes the early quiet-window exception");
});
