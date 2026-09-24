import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  DependencyProvisioning,
  enqueueTaskRun,
  PrismaClient,
  RunStatus,
  RunnerKind,
  TaskStatus,
} from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION, type ClaimContract } from "@anneal/db/claim-contract";

import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

const RUNNER_TOKEN = "runner-served-kinds-token";
const EXECUTOR_TOKEN = "merge-executor-served-kinds-token";
const EXECUTOR_RUNNER = "merge-executor-served-kinds";
const EARLIER = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-02T00:00:00.000Z");

let db: PrismaClient;
const previousEnvironment = {
  runner: process.env.RUNNER_TOKEN,
  executorToken: process.env.MERGE_EXECUTOR_TOKEN,
  executorRunnerIds: process.env.MERGE_EXECUTOR_RUNNER_IDS,
};

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  process.env.MERGE_EXECUTOR_TOKEN = EXECUTOR_TOKEN;
  process.env.MERGE_EXECUTOR_RUNNER_IDS = EXECUTOR_RUNNER;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  for (const [key, value] of [
    ["RUNNER_TOKEN", previousEnvironment.runner],
    ["MERGE_EXECUTOR_TOKEN", previousEnvironment.executorToken],
    ["MERGE_EXECUTOR_RUNNER_IDS", previousEnvironment.executorRunnerIds],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const seedRunner = async () => {
  const suffix = randomUUID();
  const project = await db.project.create({
    data: { name: `Served kinds ${suffix}`, slug: `served-kinds-${suffix}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: "served-kinds-agent",
      title: "Served kinds agent",
      model: "claude-opus-5:high",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: "served-kinds-repo",
      remoteUrl: "https://example.test/served-kinds.git",
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
  return { project, agent, repo };
};

type RunnerSeed = Awaited<ReturnType<typeof seedRunner>>;

const queueAgentRun = async (
  owner: RunnerSeed,
  runner: RunnerKind,
  readyAt = EARLIER,
  createdAt?: Date,
) => {
  const task = await db.task.create({
    data: {
      projectId: owner.project.id,
      repoId: owner.repo.id,
      assigneeAgentId: owner.agent.id,
      name: `${runner} task ${randomUUID()}`,
      description: "served-kinds claim fixture",
      status: TaskStatus.TODO,
      assigneeType: AssigneeType.AGENT,
    },
  });
  const run = await db.run.create({
    data: {
      projectId: owner.project.id,
      taskId: task.id,
      agentId: owner.agent.id,
      repoId: owner.repo.id,
      runNumber: 1,
      dedupeKey: `task:${task.id}:run:1`,
      status: RunStatus.QUEUED,
      runner,
      model: runner === RunnerKind.CODEX ? "gpt-5.6-sol" : "claude-opus-5:high",
      readyAt,
      ...(createdAt ? { createdAt } : {}),
    },
  });
  return { task, run };
};

type ClaimResult = { status: number; body: unknown };

const claimedBody = (result: ClaimResult): ClaimContract => {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body && typeof result.body === "object");
  return result.body as ClaimContract;
};

const claim = async (input: {
  runnerId: string;
  servedKinds?: string[];
  token?: string;
  client?: PrismaClient;
}): Promise<ClaimResult> => {
  const response = await createApp(input.client ?? db).request("/runner/tasks/claim", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token ?? RUNNER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      runnerId: input.runnerId,
      leaseSeconds: 60,
      contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
      ...(input.servedKinds === undefined ? {} : { servedKinds: input.servedKinds }),
    }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json().catch(() => null),
  };
};

const createClient = () => new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });

test("a declared runner claims only its kinds and leaves other queued Runs untouched", async () => {
  const owner = await seedRunner();
  const claude = await queueAgentRun(owner, RunnerKind.CLAUDE, EARLIER);
  const codex = await queueAgentRun(owner, RunnerKind.CODEX, LATER);

  const first = await claim({ runnerId: "codex-only-runner", servedKinds: [RunnerKind.CODEX] });
  assert.equal(claimedBody(first).run.id, codex.run.id);

  const second = await claim({ runnerId: "codex-only-runner", servedKinds: [RunnerKind.CODEX] });
  assert.equal(second.status, 204, JSON.stringify(second.body));

  const [claudeAfter, codexAfter] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: claude.run.id }, select: { status: true, runnerId: true } }),
    db.run.findUniqueOrThrow({ where: { id: codex.run.id }, select: { status: true, runnerId: true } }),
  ]);
  assert.equal(claudeAfter.status, RunStatus.QUEUED);
  assert.equal(claudeAfter.runnerId, null);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: claude.task.id } })).failureReason, null);
  assert.equal(codexAfter.status, RunStatus.CLAIMED);
});

test("a declared runner's filter is applied inside the twenty-Run ranking window", async () => {
  const owner = await seedRunner();
  const claudeRuns = [];
  for (let index = 0; index < 21; index += 1) {
    claudeRuns.push(await queueAgentRun(
      owner,
      RunnerKind.CLAUDE,
      EARLIER,
      new Date(EARLIER.getTime() + index),
    ));
  }
  const codex = await queueAgentRun(owner, RunnerKind.CODEX, LATER, LATER);

  const result = await claim({ runnerId: "codex-window-runner", servedKinds: [RunnerKind.CODEX] });
  assert.equal(claimedBody(result).run.id, codex.run.id);
  assert.equal(
    await db.run.count({ where: { id: { in: claudeRuns.map(({ run }) => run.id) }, status: RunStatus.QUEUED } }),
    claudeRuns.length,
  );
});

test("omitting servedKinds preserves the unrestricted highest-ranked claim", async () => {
  const owner = await seedRunner();
  const claude = await queueAgentRun(owner, RunnerKind.CLAUDE, EARLIER);
  const codex = await queueAgentRun(owner, RunnerKind.CODEX, LATER);

  const result = await claim({ runnerId: "undeclared-runner" });
  assert.equal(claimedBody(result).run.id, claude.run.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: codex.run.id } })).status, RunStatus.QUEUED);
});

test("the merge executor claims its mechanical Run with its unchanged body", async () => {
  const chain = await seedIntegratorChain(db, { label: "served-kinds-mechanical" });
  assert.ok(chain.integratorTask);
  const mechanical = await db.$transaction((tx) => enqueueTaskRun(tx, chain.integratorTask!.id));

  const result = await claim({
    runnerId: EXECUTOR_RUNNER,
    token: EXECUTOR_TOKEN,
  });
  const body = claimedBody(result);
  assert.equal(body.run.id, mechanical.id);
  assert.equal(body.executionMode, "mechanical");
});

test("an unknown served kind is rejected before any Run is claimed", async () => {
  const owner = await seedRunner();
  const queued = await queueAgentRun(owner, RunnerKind.CODEX);

  const result = await claim({ runnerId: "invalid-kind-runner", servedKinds: ["GPT"] });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  const run = await db.run.findUniqueOrThrow({
    where: { id: queued.run.id },
    select: { status: true, runnerId: true },
  });
  assert.equal(run.status, RunStatus.QUEUED);
  assert.equal(run.runnerId, null);
  assert.equal(await db.session.count({ where: { runId: queued.run.id } }), 0);
});

test("concurrent declarations cannot hand one CODEX Run to a CLAUDE-only claimant", { timeout: 20_000 }, async () => {
  const owner = await seedRunner();
  const queued = await queueAgentRun(owner, RunnerKind.CODEX);
  const codexClient = createClient();
  const claudeClient = createClient();
  try {
    const [codex, claude] = await Promise.all([
      claim({ runnerId: "concurrent-codex-runner", servedKinds: [RunnerKind.CODEX], client: codexClient }),
      claim({ runnerId: "concurrent-claude-runner", servedKinds: [RunnerKind.CLAUDE], client: claudeClient }),
    ]);
    assert.equal(claimedBody(codex).run.id, queued.run.id);
    assert.equal(claude.status, 204, JSON.stringify(claude.body));
  } finally {
    await Promise.all([codexClient.$disconnect(), claudeClient.$disconnect()]);
  }

  const persisted = await db.run.findUniqueOrThrow({
    where: { id: queued.run.id },
    select: { status: true, runnerId: true },
  });
  assert.equal(persisted.status, RunStatus.CLAIMED);
  assert.equal(persisted.runnerId, "concurrent-codex-runner");
  assert.equal(await db.session.count({ where: { runId: queued.run.id } }), 1);
});
