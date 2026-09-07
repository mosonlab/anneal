import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { DependencyProvisioning, InboxStatus, MERGE_TAIL_KIND, PrismaClient } from "@anneal/db";

import { blockedLockCount, waitForBlockedLocks } from "./blocked-locks-wait.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-db-token";
const RUNNER = "runner-db-token";

const asOperator = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    return await operation();
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const asRunner = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = RUNNER;
  try {
    return await operation();
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = prior;
  }
};

const call = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> => asOperator(async () => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
});

const seedBareProject = (label: string) => db.project.create({
  data: { name: label, slug: `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}` },
});

const seedTask = async (label: string, overrides: Record<string, unknown> = {}) => {
  const project = await seedBareProject(label);
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo", dependencyProvisioning: DependencyProvisioning.NONE } });
  await db.agentRepoAccess.create({ data: { projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE" } });
  const task = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "Step", description: "work",
    ...overrides,
    ...(("chainId" in overrides || "chainIndex" in overrides) && !("chainLayer" in overrides)
      ? { chainLayer: typeof overrides.chainIndex === "number" ? overrides.chainIndex : null }
      : {}),
  } });
  return { project, agent, repo, task };
};

const seedRun = async (
  context: Awaited<ReturnType<typeof seedTask>>,
  runNumber: number,
  status: "QUEUED" | "CLAIMED" | "PROVISIONING" | "RUNNING" | "WAITING_INBOX" | "SUCCEEDED" | "FAILED" | "CANCELLED",
) => db.run.create({ data: {
  projectId: context.project.id, taskId: context.task.id, agentId: context.agent.id, repoId: context.repo.id,
  runNumber, dedupeKey: `task:${context.task.id}:run:${runNumber}`, runner: "CLAUDE", model: "claude",
  promptHash: "hash", status, maxRunsPerTask: context.task.maxSessionsPerTask,
} });

test("task detail projects the newest non-empty agent message, preferring FINAL_OUTPUT", async () => {
  const context = await seedTask("task-detail-latest-agent-message");
  const run = await seedRun(context, 1, "SUCCEEDED");
  const session = await db.session.create({ data: {
    runId: run.id,
    projectId: context.project.id,
    agentId: context.agent.id,
    taskId: context.task.id,
    runner: "CLAUDE",
  } });
  const finalAt = new Date("2026-08-31T18:03:00.000Z");
  await db.sessionEvent.createMany({ data: [
    {
      sessionId: session.id, runId: run.id, seq: 1, at: new Date("2026-08-31T18:01:00.000Z"),
      source: "CLAUDE", type: "MODEL_DELTA",
      payload: { message: { content: [{ type: "text", text: "intermediate one" }] } },
    },
    {
      sessionId: session.id, runId: run.id, seq: 2, at: new Date("2026-08-31T18:02:00.000Z"),
      source: "CLAUDE", type: "MODEL_DELTA",
      payload: { message: { content: [{ type: "text", text: "intermediate two" }] } },
    },
    {
      sessionId: session.id, runId: run.id, seq: 3, at: finalAt,
      source: "CLAUDE", type: "FINAL_OUTPUT", payload: { type: "result", result: "The final output" },
    },
  ] });

  const response = await call("GET", `/tasks/${context.task.id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.runs[0].session.latestAgentMessage, {
    body: "The final output",
    at: finalAt.toISOString(),
  });
});

test("task detail returns null when a session has no text events", async () => {
  const context = await seedTask("task-detail-no-agent-message");
  const run = await seedRun(context, 1, "SUCCEEDED");
  const session = await db.session.create({ data: {
    runId: run.id,
    projectId: context.project.id,
    agentId: context.agent.id,
    taskId: context.task.id,
    runner: "CLAUDE",
  } });
  await db.sessionEvent.createMany({ data: [
    {
      sessionId: session.id, runId: run.id, seq: 1,
      source: "CLAUDE", type: "MODEL_COMPLETED", payload: { status: "completed" },
    },
    {
      sessionId: session.id, runId: run.id, seq: 2,
      source: "CLAUDE", type: "FINAL_OUTPUT", payload: { type: "result" },
    },
  ] });

  const response = await call("GET", `/tasks/${context.task.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.runs[0].session.latestAgentMessage, null);
});

// --- POST /runs/:runId/cancel ----------------------------------------------

test("operator cancellation terminates an unclaimed queued run and lands its task in Review", async () => {
  const context = await seedTask("cancel-queued", { status: "DOING" });
  const run = await seedRun(context, 1, "QUEUED");
  const requestId = "cancel-queued-request";

  const response = await call("POST", `/runs/${run.id}/cancel`, { requestId, reason: "operator stop" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    runId: run.id,
    taskId: context.task.id,
    status: "CANCELLED",
    cancellationState: "acknowledged",
    requestId,
  });

  const cancelled = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(cancelled.status, "CANCELLED");
  assert.notEqual(cancelled.endedAt, null);
  assert.equal(cancelled.cancelRequestId, requestId);
  assert.equal(cancelled.cancelReason, "operator stop");
  assert.notEqual(cancelled.cancelAcknowledgedAt, null);
  assert.equal(cancelled.failureClass, "CANCELLED_OR_TIMED_OUT");
  assert.equal(cancelled.failureReason, "operator stop");
  assert.equal(cancelled.retryable, false);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).status, "REVIEW");
  assert.equal(await db.taskActivity.count({ where: {
    taskId: context.task.id,
    actorType: "operator",
    body: "Cancellation requested for Run 1: operator stop",
    metadata: { path: ["requestId"], equals: requestId },
  } }), 1);
});

test("operator cancellation records an intent for a claimed run and waits for runner acknowledgement", async () => {
  const context = await seedTask("cancel-claimed", { status: "DOING" });
  const run = await seedRun(context, 1, "CLAIMED");
  await db.run.update({ where: { id: run.id }, data: {
    runnerId: "runner-1",
    fencingToken: `fence-${run.id}`,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    claimedAt: new Date(),
  } });

  const requestId = "cancel-claimed-request";
  const response = await call("POST", `/runs/${run.id}/cancel`, { requestId, reason: "operator stop" });
  assert.equal(response.status, 200);
  assert.equal(response.body.cancellationState, "requested");
  assert.equal(response.body.requestId, requestId);
  const cancelling = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(cancelling.status, "CLAIMED");
  assert.equal(cancelling.cancelRequestId, requestId);
  assert.equal(cancelling.cancelReason, "operator stop");
  assert.notEqual(cancelling.cancelRequestedAt, null);
  assert.equal(cancelling.cancelAcknowledgedAt, null);
  assert.notEqual(cancelling.sessionTokenRevokedAt, null);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).status, "DOING");
  assert.equal(await db.taskActivity.count({ where: {
    taskId: context.task.id,
    metadata: { path: ["requestId"], equals: requestId },
  } }), 1);
});

test("repeated queued-run cancellation is idempotent for one request id and rejects another", async () => {
  const context = await seedTask("cancel-repeat", { status: "TODO" });
  const run = await seedRun(context, 1, "QUEUED");
  const request = { requestId: "cancel-repeat-request", reason: "operator stop" };

  assert.equal((await call("POST", `/runs/${run.id}/cancel`, request)).status, 200);
  const replay = await call("POST", `/runs/${run.id}/cancel`, request);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.cancellationState, "acknowledged");
  const conflict = await call("POST", `/runs/${run.id}/cancel`, {
    requestId: "cancel-repeat-conflict",
    reason: "different operator request",
  });
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /already has cancellation request/);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: context.task.id,
    body: "Run 1 cancellation acknowledged; execution authority revoked and evidence retained",
    metadata: { path: ["requestId"], equals: request.requestId },
  } }), 1);
});

// --- POST /tasks/:taskId/start ----------------------------------------------

test("start queues exactly one run and records the operator activity", async () => {
  const context = await seedTask("start-happy");
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 201);
  assert.equal(body.runNumber, 1);
  assert.equal(await db.run.count({ where: { taskId: context.task.id, status: "QUEUED" } }), 1);
  assert.equal(await db.taskActivity.count({
    where: { taskId: context.task.id, body: "Started task manually" },
  }), 1);
});

test("startability endpoint exposes the shared checklist and dependency verdict", async () => {
  const context = await seedTask("startability-read");
  const ready = await call("GET", `/tasks/${context.task.id}/startability`);
  assert.equal(ready.status, 200);
  assert.equal(ready.body.startable, true);
  assert.deepEqual(ready.body.checklist, {
    repoBound: true,
    agentAssignee: true,
    repoAccessGrant: true,
    budgetRemaining: true,
    noActiveRun: true,
    predecessorsDone: true,
  });
  assert.deepEqual(ready.body.task, {
    id: context.task.id,
    name: context.task.name,
    agent: { id: context.agent.id, title: context.agent.title },
    repo: { id: context.repo.id, name: context.repo.name },
    targetBranch: context.repo.defaultBranch,
  });

  const chainId = `startability-${Date.now()}`;
  await db.task.create({ data: {
    projectId: context.project.id,
    name: "Blocking predecessor",
    description: "work",
    status: "TODO",
    chainId,
    chainIndex: 0,
    chainLayer: 0,
  } });
  await db.task.update({ where: { id: context.task.id }, data: { chainId, chainIndex: 1, chainLayer: 1 } });
  const blocked = await call("GET", `/tasks/${context.task.id}/startability`);
  assert.equal(blocked.body.startable, false);
  assert.equal(blocked.body.checklist.predecessorsDone, false);
});

test("every false admission checklist fact drives the matching start refusal", async () => {
  type SeededTask = Awaited<ReturnType<typeof seedTask>>;
  type ChecklistKey = "repoBound" | "agentAssignee" | "repoAccessGrant" | "budgetRemaining" | "noActiveRun" | "predecessorsDone";
  const cases: Array<{
    key: ChecklistKey;
    arrange: (context: SeededTask) => Promise<void>;
    status: number;
    error: RegExp;
  }> = [
    {
      key: "repoBound",
      arrange: async (context) => { await db.task.update({ where: { id: context.task.id }, data: { repoId: null } }); },
      status: 400,
      error: /no repository/u,
    },
    {
      key: "agentAssignee",
      arrange: async (context) => { await db.task.update({ where: { id: context.task.id }, data: { assigneeAgentId: null } }); },
      status: 400,
      error: /no assignee/u,
    },
    {
      key: "repoAccessGrant",
      arrange: async (context) => {
        await db.agentRepoAccess.delete({ where: { agentId_repoId: { agentId: context.agent.id, repoId: context.repo.id } } });
      },
      status: 400,
      error: /no grant/u,
    },
    {
      key: "budgetRemaining",
      arrange: async (context) => {
        await db.task.update({ where: { id: context.task.id }, data: { maxSessionsPerTask: 1 } });
        await seedRun(context, 1, "FAILED");
      },
      status: 409,
      error: /budget exhausted/u,
    },
    {
      key: "noActiveRun",
      arrange: async (context) => { await seedRun(context, 1, "WAITING_INBOX"); },
      status: 409,
      error: /active run/u,
    },
    {
      key: "predecessorsDone",
      arrange: async (context) => {
        const chainId = `admission-predecessor-${Date.now()}-${context.task.id}`;
        await db.task.create({ data: {
          projectId: context.project.id,
          name: "Admission blocker",
          description: "work",
          status: "TODO",
          chainId,
          chainIndex: 0,
          chainLayer: 0,
        } });
        await db.task.update({
          where: { id: context.task.id },
          data: { chainId, chainIndex: 1, chainLayer: 1 },
        });
      },
      status: 409,
      error: /predecessor Admission blocker is not done/u,
    },
  ];

  for (const item of cases) {
    const context = await seedTask(`admission-${item.key}`);
    await item.arrange(context);
    const beforeRuns = await db.run.count({ where: { taskId: context.task.id } });
    const read = await call("GET", `/tasks/${context.task.id}/startability`);
    assert.equal(read.status, 200, item.key);
    assert.equal(read.body.startable, false, item.key);
    assert.equal(read.body.checklist[item.key], false, item.key);

    const write = await call("POST", `/tasks/${context.task.id}/start`);
    assert.equal(write.status, item.status, item.key);
    assert.match(write.body.error, item.error, item.key);
    assert.equal(await db.run.count({ where: { taskId: context.task.id } }), beforeRuns, item.key);
  }
});

test("startability and start accept the same admission snapshot", async () => {
  const context = await seedTask("admission-consistency");
  const read = await call("GET", `/tasks/${context.task.id}/startability`);
  assert.equal(read.status, 200);
  assert.equal(read.body.startable, true);
  assert.equal((await call("POST", `/tasks/${context.task.id}/start`)).status, 201);
});

test("unfinished chain predecessor blocks every future start with zero side effects", async () => {
  const chainId = `safe-chain-${Date.now()}`;
  const context = await seedTask("chain-block", { chainId, chainIndex: 0, name: "Step 1", status: "DONE" });
  const createStep = (chainIndex: number, name: string, status: "DONE" | "DOING" | "TODO") => db.task.create({ data: {
    projectId: context.project.id,
    assigneeAgentId: context.agent.id,
    repoId: context.repo.id,
    chainId,
    chainIndex,
    chainLayer: chainIndex,
    name,
    description: "work",
    status,
  } });
  await createStep(1, "Step 2", "DONE");
  await createStep(2, "Step 3", "DONE");
  const blocker = await createStep(3, "Step 4", "DOING");
  const fifth = await createStep(4, "Step 5", "TODO");
  const sixth = await createStep(5, "Step 6", "TODO");
  const before = await db.task.findMany({ where: { chainId }, orderBy: { chainIndex: "asc" }, select: { id: true, status: true, updatedAt: true } });
  for (const target of [fifth, sixth]) {
    const response = await call("POST", `/tasks/${target.id}/start`);
    assert.equal(response.status, 409);
    assert.match(response.body.error, new RegExp(`predecessor ${blocker.name} is not done`));
  }
  assert.deepEqual(await db.task.findMany({ where: { chainId }, orderBy: { chainIndex: "asc" }, select: { id: true, status: true, updatedAt: true } }), before);
  assert.equal(await db.run.count({ where: { taskId: { in: [fifth.id, sixth.id] } } }), 0);
  assert.equal(await db.taskActivity.count({ where: { taskId: { in: [fifth.id, sixth.id] } } }), 0);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: { in: [fifth.id, sixth.id] } } }), 0);
});

test("the dependency-safe next chain step starts or recovers exactly once", async () => {
  for (const status of ["TODO", "BACKLOG"] as const) {
    const chainId = `next-${status}-${Date.now()}-${Math.random()}`;
    const context = await seedTask(`next-${status}`, { chainId, chainIndex: 0, name: "Done predecessor", status: "DONE" });
    const target = await db.task.create({ data: {
      projectId: context.project.id,
      assigneeAgentId: context.agent.id,
      repoId: context.repo.id,
      chainId,
      chainIndex: 1,
      chainLayer: 1,
      name: `${status} target`,
      description: "work",
      status,
    } });
    assert.equal((await call("POST", `/tasks/${target.id}/start`)).status, 201);
    assert.equal((await call("POST", `/tasks/${target.id}/start`)).status, 409);
    assert.equal(await db.run.count({ where: { taskId: target.id } }), 1);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: target.id } })).status, "TODO");
    assert.equal(await db.taskActivity.count({ where: {
      taskId: target.id,
      body: status === "BACKLOG" ? "Recovered parked chain step manually" : "Started next chain step manually",
    } }), 1);
  }
});

test("ordinary PATCH cannot rewrite chain gates, skip predecessors, or complete an active task", async () => {
  const chainId = `patch-guard-${Date.now()}`;
  const context = await seedTask("patch-guard", { chainId, chainIndex: 0, name: "Blocking predecessor", status: "DOING", approvalGate: true });
  const future = await db.task.create({ data: {
    projectId: context.project.id,
    assigneeAgentId: context.agent.id,
    repoId: context.repo.id,
    chainId,
    chainIndex: 1,
    chainLayer: 1,
    name: "Future step",
    description: "work",
    status: "TODO",
  } });
  const gateChange = await call("PATCH", `/tasks/${context.task.id}`, { approvalGate: false });
  assert.equal(gateChange.status, 409);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).approvalGate, true);
  const futureDone = await call("PATCH", `/tasks/${future.id}`, { status: "DONE" });
  assert.equal(futureDone.status, 409);
  assert.match(futureDone.body.error, /predecessor Blocking predecessor is not done/);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: future.id } })).status, "TODO");

  await seedRun(context, 1, "WAITING_INBOX");
  const activeDone = await call("PATCH", `/tasks/${context.task.id}`, { status: "DONE" });
  assert.equal(activeDone.status, 409);
  assert.match(activeDone.body.error, /active run/);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).status, "DOING");
  assert.equal(await db.taskActivity.count({ where: { taskId: context.task.id, body: { startsWith: "Status changed:" } } }), 0);
});

test("repo-grant revocation and manual start serialize without an unclaimable Run", { timeout: 20_000 }, async () => {
  const context = await seedTask("grant-start-race");
  const app = createApp(db);
  const responses = await asOperator(() => synchronised([
    async (release, gate) => { release(); await gate; return app.request(`/tasks/${context.task.id}/start`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
    async (release, gate) => { release(); await gate; return app.request(`/agents/${context.agent.id}/repos/${context.repo.id}/access`, { method: "DELETE", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
  ]));
  const [start, revoke] = responses;
  assert.ok(start!.status === 201 && revoke!.status === 409 || start!.status === 400 && revoke!.status === 204,
    `start=${start!.status} revoke=${revoke!.status}`);
  const runs = await db.run.count({ where: { taskId: context.task.id } });
  const grants = await db.agentRepoAccess.count({ where: { agentId: context.agent.id, repoId: context.repo.id } });
  assert.equal(runs, start!.status === 201 ? 1 : 0);
  assert.equal(grants, runs === 1 ? 1 : 0, `runs=${runs} grants=${grants}`);
});

test("repo-grant revocation and template instantiation serialize across future steps", { timeout: 20_000 }, async () => {
  const context = await seedTask("grant-template-race", { status: "DONE" });
  const template = await seedTemplate(context);
  const app = createApp(db);
  const [instantiate, revoke] = await asOperator(() => synchronised([
    async (release, gate) => {
      release();
      await gate;
      return app.request(`/projects/${context.project.id}/task-templates/${template.id}/instantiate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: context.repo.id, variables: {}, name: "grant template race", autoStart: true }),
      });
    },
    async (release, gate) => {
      release();
      await gate;
      return app.request(`/agents/${context.agent.id}/repos/${context.repo.id}/access`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${OPERATOR}` },
      });
    },
  ]));
  assert.ok(
    instantiate!.status === 201 && revoke!.status === 409
      || instantiate!.status === 400 && revoke!.status === 204,
    `instantiate=${instantiate!.status} revoke=${revoke!.status}`,
  );
  const chainTasks = await db.task.count({ where: { templateId: template.id } });
  const grants = await db.agentRepoAccess.count({ where: { agentId: context.agent.id, repoId: context.repo.id } });
  assert.equal(chainTasks, instantiate!.status === 201 ? 2 : 0);
  assert.equal(grants, chainTasks > 0 ? 1 : 0);
});

test("claim turns a legacy queued run with a missing grant into an actionable failure", async () => {
  const context = await seedTask("claim-missing-grant");
  await seedRun(context, 1, "QUEUED");
  await db.agentRepoAccess.delete({ where: { agentId_repoId: { agentId: context.agent.id, repoId: context.repo.id } } });
  const response = await asRunner(() => createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "grant-repair-runner", leaseSeconds: 60 }),
  }));
  assert.equal(response.status, 204);
  const run = await db.run.findFirstOrThrow({ where: { taskId: context.task.id } });
  const task = await db.task.findUniqueOrThrow({ where: { id: context.task.id } });
  assert.equal(run.status, "FAILED");
  assert.match(run.failureReason ?? "", /restore the agent Repo grant/);
  assert.equal(task.status, "BACKLOG");
  assert.match(task.failureReason ?? "", /repository-grant-missing/);
  assert.equal(await db.taskActivity.count({ where: { taskId: task.id, body: { contains: "restore the grant and retry" } } }), 1);
});

test("a second start press is 409, not a second run", async () => {
  const context = await seedTask("start-double");
  assert.equal((await call("POST", `/tasks/${context.task.id}/start`)).status, 201);
  const second = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "Task already has an active run");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 1);
});

test("a human step cannot be started", async () => {
  const context = await seedTask("start-human", { assigneeType: "HUMAN", assigneeAgentId: null });
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 409);
  assert.equal(body.error, "Human steps cannot be started");
});

test("start names the archived assignee rather than failing anonymously", async () => {
  const context = await seedTask("start-archived-agent");
  await db.agent.update({ where: { id: context.agent.id }, data: { archivedAt: new Date() } });
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 409);
  assert.match(body.error, /agent is archived/);
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 0);
});

test("start refuses a task at its run ceiling even when every run is terminal", async () => {
  const context = await seedTask("start-budget", { maxSessionsPerTask: 2 });
  await seedRun(context, 1, "FAILED");
  await seedRun(context, 2, "FAILED");
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 409);
  assert.equal(body.error, "Run budget exhausted");
});

test("start on a BACKLOG task queues a run and moves it to TODO", async () => {
  const context = await seedTask("start-backlog", { status: "BACKLOG" });
  assert.equal((await call("POST", `/tasks/${context.task.id}/start`)).status, 201);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).status, "TODO");
});

test("a run parked on an Inbox question still counts as active", async () => {
  // The regression the shared ACTIVE_RUN_STATUSES exists for: WAITING_INBOX
  // resumes the moment the operator answers.
  const context = await seedTask("start-waiting");
  await seedRun(context, 1, "WAITING_INBOX");
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 409);
  assert.equal(body.error, "Task already has an active run");
});

test("start refuses a done task and an archived task", async () => {
  const done = await seedTask("start-done", { status: "DONE" });
  assert.equal((await call("POST", `/tasks/${done.task.id}/start`)).body.error, "Task is already done");
  const archived = await seedTask("start-arch", { archivedAt: new Date() });
  assert.equal((await call("POST", `/tasks/${archived.task.id}/start`)).body.error, "Cannot start an archived task");
});

// --- archive / unarchive / archive-done -------------------------------------

test("archive and unarchive round-trip, and the board hides the archived task", async () => {
  const context = await seedTask("archive-trip");
  assert.equal((await call("POST", `/tasks/${context.task.id}/archive`)).status, 200);
  assert.equal((await call("GET", `/tasks?projectId=${context.project.id}`)).body.length, 0);
  assert.equal((await call("GET", `/tasks?projectId=${context.project.id}&archived=all`)).body.length, 1);
  assert.equal((await call("GET", `/tasks?projectId=${context.project.id}&archived=true`)).body.length, 1);
  assert.equal((await call("POST", `/tasks/${context.task.id}/unarchive`)).status, 200);
  assert.equal((await call("GET", `/tasks?projectId=${context.project.id}`)).body.length, 1);
  // Unarchiving an already-live task is a no-op, not an error.
  assert.equal((await call("POST", `/tasks/${context.task.id}/unarchive`)).status, 200);
});

test("archiving or unarchiving one Chain task changes the whole Chain atomically", async () => {
  const chainId = `archive-chain-${Date.now()}`;
  const context = await seedTask("archive-chain", { chainId, chainIndex: 0, status: "DONE" });
  const frontier = await db.task.create({ data: {
    projectId: context.project.id,
    assigneeAgentId: context.agent.id,
    repoId: context.repo.id,
    name: "Archive Chain frontier",
    description: "d",
    status: "REVIEW",
    chainId,
    chainIndex: 1,
    chainLayer: 1,
  } });

  assert.equal((await call("POST", `/tasks/${frontier.id}/archive`)).status, 200);
  assert.equal((await db.task.count({ where: { chainId, archivedAt: null } })), 0);
  assert.equal((await call("GET", `/tasks?projectId=${context.project.id}`)).body.length, 0);
  assert.equal(await db.taskActivity.count({
    where: { taskId: { in: [context.task.id, frontier.id] }, body: "Task archived" },
  }), 2);

  assert.equal((await call("POST", `/tasks/${context.task.id}/unarchive`)).status, 200);
  assert.equal((await db.task.count({ where: { chainId, archivedAt: null } })), 2);
  assert.equal((await call("GET", `/tasks?projectId=${context.project.id}`)).body.length, 2);
  assert.equal(await db.taskActivity.count({
    where: { taskId: { in: [context.task.id, frontier.id] }, body: "Task unarchived" },
  }), 2);
});

test("archiving a Chain closes its merge-tail stop notices and audits each affected task", async () => {
  const chainId = `archive-stop-notices-${Date.now()}`;
  const context = await seedTask("archive-stop-notices", { chainId, chainIndex: 0, status: "DONE" });
  const regression = await db.task.create({ data: {
    projectId: context.project.id,
    assigneeAgentId: context.agent.id,
    repoId: context.repo.id,
    name: "Regression",
    description: "d",
    status: "DONE",
    chainId,
    chainIndex: 1,
    chainLayer: 1,
  } });
  const first = await db.inboxMessage.create({ data: {
    from: "AGENT", taskId: regression.id, kind: "TEXT", body: "first stop",
    dedupeKey: `merge-tail-stop:${regression.id}:first`,
  } });
  const second = await db.inboxMessage.create({ data: {
    from: "AGENT", taskId: regression.id, kind: "TEXT", body: "second stop",
    dedupeKey: `merge-tail-stop:${regression.id}:second`,
  } });
  const unrelated = await db.inboxMessage.create({ data: {
    from: "AGENT", taskId: regression.id, kind: "TEXT", body: "operator question",
    dedupeKey: `question:${regression.id}`,
  } });

  assert.equal((await call("POST", `/tasks/${regression.id}/archive`)).status, 200);

  const messages = await db.inboxMessage.findMany({
    where: { id: { in: [first.id, second.id, unrelated.id] } },
    orderBy: { id: "asc" },
  });
  for (const notice of messages.filter((message) => message.id !== unrelated.id)) {
    assert.equal(notice.status, InboxStatus.CLOSED);
    assert.ok(notice.answeredAt instanceof Date);
  }
  assert.equal(messages.find((message) => message.id === unrelated.id)?.status, InboxStatus.OPEN);
  assert.equal(messages.find((message) => message.id === unrelated.id)?.answeredAt, null);
  const closure = await db.taskActivity.findMany({
    where: { taskId: regression.id, actorType: "control-plane" },
  });
  assert.equal(closure.length, 1);
  assert.deepEqual((closure[0]?.metadata as { inboxMessageIds: string[] }).inboxMessageIds.sort(), [first.id, second.id].sort());
});

test("archiving a Chain without merge-tail stop notices writes no closure activity", async () => {
  const chainId = `archive-no-stop-notices-${Date.now()}`;
  const context = await seedTask("archive-no-stop-notices", { chainId, chainIndex: 0, status: "DONE" });

  assert.equal((await call("POST", `/tasks/${context.task.id}/archive`)).status, 200);
  assert.equal(await db.taskActivity.count({
    where: { taskId: context.task.id, actorType: "control-plane" },
  }), 0);
});

test("an active chain-detached repair run refuses archive before Inbox mutation", async () => {
  const chainId = `archive-active-repair-${Date.now()}`;
  const context = await seedTask("archive-active-repair", { chainId, chainIndex: 0, status: "DONE" });
  const repair = await db.task.create({ data: {
    projectId: context.project.id,
    assigneeAgentId: context.agent.id,
    repoId: context.repo.id,
    name: "Autonomous merge tail: gate-fix",
    description: "d",
    status: "DOING",
  } });
  await db.taskActivity.create({ data: {
    taskId: context.task.id,
    actorType: "control-plane",
    body: "Automatic gate-fix attempt queued",
    metadata: {
      schemaVersion: 1, kind: MERGE_TAIL_KIND.repairAttempt,
      repairKind: "gate-fix", repairTaskId: repair.id,
    },
  } });
  await db.run.create({ data: {
    projectId: context.project.id,
    taskId: repair.id,
    agentId: context.agent.id,
    repoId: context.repo.id,
    runNumber: 1,
    dedupeKey: `task:${repair.id}:run:1`,
    runner: "CLAUDE",
    model: "claude",
    promptHash: "h",
    status: "RUNNING",
  } });
  const notice = await db.inboxMessage.create({ data: {
    from: "AGENT", taskId: context.task.id, kind: "TEXT", body: "existing stop",
    dedupeKey: `merge-tail-stop:${context.task.id}:existing`,
  } });

  const response = await call("POST", `/tasks/${context.task.id}/archive`);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, "Cannot archive a task with an active run");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).archivedAt, null);
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: notice.id } })).status, InboxStatus.OPEN);
});

test("archive waits for detached repair completion and closes the notice it emits", { timeout: 20_000 }, async () => {
  const chainId = `archive-repair-race-${Date.now()}`;
  const context = await seedTask("archive-repair-race", { chainId, chainIndex: 0, status: "DONE" });
  const repair = await db.task.create({ data: {
    projectId: context.project.id,
    assigneeAgentId: context.agent.id,
    repoId: context.repo.id,
    name: "Autonomous merge tail: review-fix",
    description: "d",
    status: "DOING",
  } });
  await db.taskActivity.create({ data: {
    taskId: context.task.id,
    actorType: "control-plane",
    body: "Automatic review-fix attempt queued",
    metadata: {
      schemaVersion: 1, kind: MERGE_TAIL_KIND.repairAttempt,
      repairKind: "review-fix", repairTaskId: repair.id,
    },
  } });
  const run = await db.run.create({ data: {
    projectId: context.project.id,
    taskId: repair.id,
    agentId: context.agent.id,
    repoId: context.repo.id,
    runNumber: 1,
    dedupeKey: `task:${repair.id}:run:1`,
    runner: "CLAUDE",
    model: "claude",
    promptHash: "h",
    status: "RUNNING",
  } });
  const producer = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let releaseProducer!: () => void;
  let producerLocked!: () => void;
  const release = new Promise<void>((resolve) => { releaseProducer = resolve; });
  const locked = new Promise<void>((resolve) => { producerLocked = resolve; });
  const noticeKey = `merge-tail-stop:${context.task.id}:repair-completion`;
  const producing = producer.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${repair.id} FOR UPDATE`;
    producerLocked();
    await release;
    await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "projectId" = ${context.project.id} AND "chainId" = ${chainId} FOR UPDATE`;
    await tx.run.update({ where: { id: run.id }, data: { status: "FAILED", endedAt: new Date() } });
    await tx.inboxMessage.create({ data: {
      from: "AGENT", taskId: context.task.id, kind: "TEXT", body: "repair failed",
      dedupeKey: noticeKey,
    } });
  });
  try {
    await locked;
    const baseline = await blockedLockCount(db);
    const archiving = call("POST", `/tasks/${context.task.id}/archive`);
    try {
      await waitForBlockedLocks(db, baseline + 1);
    } finally {
      releaseProducer();
    }
    await producing;
    assert.equal((await archiving).status, 200);
    const notice = await db.inboxMessage.findUniqueOrThrow({ where: { dedupeKey: noticeKey } });
    assert.equal(notice.status, InboxStatus.CLOSED);
    assert.ok(notice.answeredAt instanceof Date);
    assert.equal(await db.taskActivity.count({
      where: {
        taskId: context.task.id,
        actorType: "control-plane",
        metadata: { path: ["inboxMessageIds"], array_contains: [notice.id] },
      },
    }), 1);
  } finally {
    releaseProducer();
    await Promise.allSettled([producing]);
    await producer.$disconnect();
  }
});

test("a busy Chain member refuses the whole archive without partial writes", async () => {
  const chainId = `archive-chain-busy-${Date.now()}`;
  const context = await seedTask("archive-chain-busy", { chainId, chainIndex: 0, status: "DONE" });
  const busy = await db.task.create({ data: {
    projectId: context.project.id,
    assigneeAgentId: context.agent.id,
    repoId: context.repo.id,
    name: "Busy Chain member",
    description: "d",
    status: "DOING",
    chainId,
    chainIndex: 1,
    chainLayer: 1,
  } });
  await db.run.create({ data: {
    projectId: context.project.id,
    taskId: busy.id,
    agentId: context.agent.id,
    repoId: context.repo.id,
    runNumber: 1,
    dedupeKey: `task:${busy.id}:run:1`,
    runner: "CLAUDE",
    model: "claude",
    promptHash: "h",
    status: "RUNNING",
  } });

  const response = await call("POST", `/tasks/${context.task.id}/archive`);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, "Cannot archive a task with an active run");
  assert.equal((await db.task.count({ where: { chainId, archivedAt: null } })), 2);
});

test("archive refuses a task with an active run", async () => {
  const context = await seedTask("archive-busy");
  await seedRun(context, 1, "RUNNING");
  const { status, body } = await call("POST", `/tasks/${context.task.id}/archive`);
  assert.equal(status, 409);
  assert.equal(body.error, "Cannot archive a task with an active run");
});

test("archive refuses a REVIEW task with an open approval gate", async () => {
  const context = await seedTask("archive-gate", { status: "REVIEW", approvalGate: true });
  const run = await seedRun(context, 1, "SUCCEEDED");
  const session = await db.session.create({ data: {
    runId: run.id, projectId: context.project.id, agentId: context.agent.id, taskId: context.task.id, runner: "CLAUDE",
  } });
  await db.inboxMessage.create({ data: {
    from: "AGENT", agentId: context.agent.id, sessionId: session.id, taskId: context.task.id,
    gateTaskId: context.task.id, kind: "MULTIPLE_CHOICE", body: "approve?",
    choices: [{ id: "approve", label: "Approve" }], dedupeKey: `gate:${context.task.id}`,
  } });
  const { status, body } = await call("POST", `/tasks/${context.task.id}/archive`);
  assert.equal(status, 409);
  assert.equal(body.error, "Decide the approval gate in the Inbox first");
});

test("HUMAN final DONE answers only the exact OPEN gate even when approvalGate is false", async () => {
  const chainId = `human-final-${Date.now()}`;
  const target = await seedTask("human-final", {
    status: "REVIEW", assigneeType: "HUMAN", assigneeAgentId: null, repoId: null,
    approvalGate: false, chainId, chainIndex: 0,
  });
  const unrelated = await seedTask("human-final-unrelated", { status: "REVIEW" });
  const run = await seedRun(target, 1, "SUCCEEDED");
  const session = await db.session.create({ data: {
    runId: run.id,
    projectId: target.project.id,
    agentId: target.agent.id,
    taskId: target.task.id,
    runner: "CLAUDE",
  } });
  const exactOpen = await db.inboxMessage.create({ data: {
    from: "AGENT", agentId: target.agent.id, sessionId: session.id,
    taskId: target.task.id, gateTaskId: target.task.id,
    kind: "MULTIPLE_CHOICE", body: "exact open", status: "OPEN",
    choices: [{ id: "approve", label: "Approve" }], dedupeKey: `gate:exact:${target.task.id}`,
  } });
  const exactClosed = await db.inboxMessage.create({ data: {
    from: "AGENT", taskId: target.task.id, gateTaskId: target.task.id,
    kind: "MULTIPLE_CHOICE", body: "exact closed", status: "CLOSED",
    choices: [{ id: "approve", label: "Approve" }], dedupeKey: `gate:closed:${target.task.id}`,
  } });
  const ordinaryOpen = await db.inboxMessage.create({ data: {
    from: "AGENT", taskId: target.task.id, kind: "TEXT", body: "ordinary open",
    status: "OPEN", dedupeKey: `ordinary:${target.task.id}`,
  } });
  const unrelatedOpen = await db.inboxMessage.create({ data: {
    from: "AGENT", taskId: unrelated.task.id, gateTaskId: unrelated.task.id,
    kind: "MULTIPLE_CHOICE", body: "unrelated open", status: "OPEN",
    choices: [{ id: "approve", label: "Approve" }], dedupeKey: `gate:unrelated:${unrelated.task.id}`,
  } });

  assert.equal((await call("PATCH", `/tasks/${target.task.id}`, { status: "DONE" })).status, 200);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: target.task.id } })).status, "DONE");
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: exactOpen.id } })).status, "ANSWERED");
  assert.equal(await db.inboxDecision.count({ where: { inboxMessageId: exactOpen.id } }), 1);
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: exactClosed.id } })).status, "CLOSED");
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: ordinaryOpen.id } })).status, "OPEN");
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: unrelatedOpen.id } })).status, "OPEN");

  // A replay is a no-op, including its activity and chain activation side effects.
  assert.equal((await call("PATCH", `/tasks/${target.task.id}`, { status: "DONE" })).status, 200);
  assert.equal(await db.taskActivity.count({
    where: { taskId: target.task.id, body: { startsWith: "Status changed:" } },
  }), 1);
});

test("archive-done archives every finished task and reports the ones it skipped", async () => {
  const context = await seedTask("archive-done", { status: "DONE" });
  const extra = await Promise.all([1, 2, 3, 4, 5].map((index) => db.task.create({ data: {
    projectId: context.project.id, name: `Done ${index}`, description: "d", status: "DONE",
  } })));
  const busy = await db.task.create({ data: {
    projectId: context.project.id, assigneeAgentId: context.agent.id, repoId: context.repo.id,
    name: "Done but running", description: "d", status: "DONE",
  } });
  await db.run.create({ data: {
    projectId: context.project.id, taskId: busy.id, agentId: context.agent.id, repoId: context.repo.id,
    runNumber: 1, dedupeKey: `task:${busy.id}:run:1`, runner: "CLAUDE", model: "claude", promptHash: "h", status: "RUNNING",
  } });
  await db.task.create({ data: { projectId: context.project.id, name: "Still todo", description: "d" } });

  const { status, body } = await call("POST", `/projects/${context.project.id}/tasks/archive-done`);
  assert.equal(status, 200);
  assert.deepEqual(body, { archived: 6, skipped: 1 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: busy.id } })).archivedAt, null);
  for (const task of [context.task, ...extra]) {
    assert.notEqual((await db.task.findUniqueOrThrow({ where: { id: task.id } })).archivedAt, null);
  }

  // A second press has nothing left to do.
  assert.deepEqual((await call("POST", `/projects/${context.project.id}/tasks/archive-done`)).body, { archived: 0, skipped: 1 });
});

// --- PATCH BACKLOG guard and retry ------------------------------------------

test("PATCH to BACKLOG is refused while a run is active and allowed when none is", async () => {
  const context = await seedTask("patch-backlog");
  await seedRun(context, 1, "RUNNING");
  const refused = await call("PATCH", `/tasks/${context.task.id}`, { status: "BACKLOG" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "Cannot move a task with an active run to Backlog");

  await db.run.updateMany({ where: { taskId: context.task.id }, data: { status: "FAILED" } });
  const allowed = await call("PATCH", `/tasks/${context.task.id}`, { status: "BACKLOG" });
  assert.equal(allowed.status, 200);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).status, "BACKLOG");
});

test("retry refuses while any run is active, including PROVISIONING and WAITING_INBOX", async () => {
  // The old check read only the latest run's status against QUEUED/CLAIMED/
  // RUNNING: a retry during a clone (PROVISIONING) or an Inbox suspension
  // (WAITING_INBOX, up to 7 days) minted a second concurrent run.
  for (const status of ["PROVISIONING", "WAITING_INBOX"] as const) {
    const context = await seedTask(`retry-active-${status.toLowerCase()}`);
    await seedRun(context, 1, status);
    const { status: code, body } = await call("POST", `/tasks/${context.task.id}/retry`);
    assert.equal(code, 409, `${status} must refuse retry`);
    assert.equal(body.error, "Task already has an active run");
    assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 1);
  }

  // An active run older than the latest must also refuse: latest-only checks
  // pass when run 1 is still suspended but run 2 already reached a terminal
  // state.
  const context = await seedTask("retry-active-older-run");
  await seedRun(context, 1, "WAITING_INBOX");
  await seedRun(context, 2, "FAILED");
  const { status: code, body } = await call("POST", `/tasks/${context.task.id}/retry`);
  assert.equal(code, 409);
  assert.equal(body.error, "Task already has an active run");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 2);
});

test("retry refuses an archived task", async () => {
  const context = await seedTask("retry-archived", { archivedAt: new Date() });
  await seedRun(context, 1, "FAILED");
  const { status, body } = await call("POST", `/tasks/${context.task.id}/retry`);
  assert.equal(status, 409);
  assert.equal(body.error, "Cannot retry an archived task");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 1);
});

test("PATCH validates a cron expression server-side and moves runAt into the future", async () => {
  // The Automations page's cron field depends on this: it deliberately ships no
  // client-side validator.
  const context = await seedTask("patch-cron", {
    scheduleKind: "CRON", cron: "0 8 * * *", timezone: "UTC", runAt: new Date("2020-01-01T08:00:00Z"),
  });
  const ok = await call("PATCH", `/tasks/${context.task.id}`, { cron: "0 9 * * *" });
  assert.equal(ok.status, 200);
  const updated = await db.task.findUniqueOrThrow({ where: { id: context.task.id } });
  assert.ok(updated.runAt!.getTime() > Date.now());

  const bad = await call("PATCH", `/tasks/${context.task.id}`, { cron: "not a cron at all" });
  assert.equal(bad.status, 400);
  assert.ok(typeof bad.body.error === "string" && bad.body.error.length > 0);
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).cron,
    "0 9 * * *",
    "a rejected cron changes nothing",
  );
});

// --- synchronised races (two sequential calls would pass without the lock) ---

/** Releases both callers only once both are inside their transaction, so the
 *  lock is what orders them rather than wall-clock luck. */
const synchronised = async <T>(
  operations: Array<(release: () => void, gate: Promise<void>) => Promise<T>>,
): Promise<T[]> => {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const release = () => {
    arrived += 1;
    if (arrived === operations.length) open();
  };
  return Promise.all(operations.map((operation) => operation(release, gate)));
};

test("two simultaneous start presses produce one run and one 409, never a 500", async () => {
  const context = await seedTask("race-start");
  const app = createApp(db);
  const responses = await asOperator(() => synchronised([
    async (release, gate) => { release(); await gate; return app.request(`/tasks/${context.task.id}/start`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
    async (release, gate) => { release(); await gate; return app.request(`/tasks/${context.task.id}/start`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
  ]));
  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  const loser = responses.find((response) => response.status === 409)!;
  assert.equal((await loser.json() as any).error, "Task already has an active run");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 1);
});

test("archive and retry released together leave a consistent state, never both", async () => {
  const context = await seedTask("race-archive-retry", { status: "DONE" });
  await seedRun(context, 1, "SUCCEEDED");
  const app = createApp(db);
  await asOperator(() => synchronised([
    async (release, gate) => { release(); await gate; return app.request(`/tasks/${context.task.id}/archive`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
    async (release, gate) => { release(); await gate; return app.request(`/tasks/${context.task.id}/retry`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
  ]));
  const task = await db.task.findUniqueOrThrow({ where: { id: context.task.id } });
  const runs = await db.run.count({ where: { taskId: context.task.id } });
  // Either archive won (no new run) or retry won (still unarchived). Never both.
  assert.equal((task.archivedAt !== null) !== (runs > 1), true, `archivedAt=${task.archivedAt}, runs=${runs}`);
});

test("archive and archive-done released together double-count nothing and do not deadlock", { timeout: 20_000 }, async () => {
  const context = await seedTask("race-archive-all", { status: "DONE" });
  const sibling = await db.task.create({ data: {
    projectId: context.project.id, name: "Also done", description: "d", status: "DONE",
  } });
  const app = createApp(db);
  const responses = await asOperator(() => synchronised([
    async (release, gate) => { release(); await gate; return app.request(`/tasks/${context.task.id}/archive`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
    async (release, gate) => { release(); await gate; return app.request(`/projects/${context.project.id}/tasks/archive-done`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
  ]));
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  for (const taskId of [context.task.id, sibling.id]) {
    assert.notEqual((await db.task.findUniqueOrThrow({ where: { id: taskId } })).archivedAt, null);
  }
  const bulk = await responses[1]!.json() as { archived: number; skipped: number };
  assert.ok(bulk.archived <= 2 && bulk.skipped === 0, `archived=${bulk.archived} skipped=${bulk.skipped}`);
});

test("a lock held by a foreign transaction makes start wait rather than double-run", { timeout: 20_000 }, async () => {
  // Direct proof that lockTask really takes a row lock: holding the Task row in
  // another transaction blocks the route until it commits.
  const context = await seedTask("race-lock-proof");
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let released = false;
  try {
    const held = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${context.task.id} FOR UPDATE`;
      await new Promise((resolve) => setTimeout(resolve, 700));
      released = true;
    }, { timeout: 10_000 });
    const start = call("POST", `/tasks/${context.task.id}/start`);
    const [, response] = await Promise.all([held, start]);
    assert.equal(released, true);
    assert.equal(response.status, 201);
  } finally {
    await holder.$disconnect();
  }
});

// --- review fixes: the startable contract (CODE-REVIEW M1) -------------------

test("start refuses a REVIEW step whose approval gate is still open, and creates no run", async () => {
  // The defect: the route re-derived its own guard set instead of calling
  // `startable`, so it accepted a step no human had approved. A run enqueued
  // here has an agent working ahead of the gate, and its completion can open a
  // second gate card for the same task.
  const context = await seedTask("start-gated-review", { status: "REVIEW", approvalGate: true });
  const run = await seedRun(context, 1, "SUCCEEDED");
  const session = await db.session.create({ data: {
    runId: run.id, projectId: context.project.id, agentId: context.agent.id, taskId: context.task.id, runner: "CLAUDE",
  } });
  await db.inboxMessage.create({ data: {
    from: "AGENT", agentId: context.agent.id, sessionId: session.id, taskId: context.task.id,
    gateTaskId: context.task.id, kind: "MULTIPLE_CHOICE", body: "Approve?", status: "OPEN",
    choices: [{ id: "approve", label: "Approve" }], dedupeKey: `gate:${context.task.id}`,
  } });
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 409);
  assert.equal(body.error, "Only Todo and Backlog steps can be started");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 1, "no second run");
  // The gate is untouched: refusing to start must not decide it.
  assert.equal(await db.inboxMessage.count({ where: { gateTaskId: context.task.id, status: "OPEN" } }), 1);
});

test("start refuses a DOING step — that is Retry's territory", async () => {
  const context = await seedTask("start-doing", { status: "DOING" });
  await seedRun(context, 1, "FAILED");
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 409);
  assert.equal(body.error, "Only Todo and Backlog steps can be started");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 1);
});

test("start on a task with no repository is 400, never a 500", async () => {
  // `enqueueTaskRun` throws a plain Error for a missing repo and the route's
  // catch maps only ArchivedAssigneeError and P2002, so this used to be a 500
  // on a documented endpoint.
  const context = await seedTask("start-no-repo");
  await db.task.update({ where: { id: context.task.id }, data: { repoId: null } });
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 400);
  assert.equal(body.error, "This task has no repository");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 0);
});

// --- review fixes: the Backlog PATCH joins the mutex (SOL-REVIEW M1) ---------

test("start and a Backlog PATCH released together never strand a queued run in Backlog", async () => {
  // The runner claims only unarchived TODO/DOING tasks, so a QUEUED run left on
  // a BACKLOG task is never claimed and never completes — the race does not
  // "resolve on completion" as the old comment claimed.
  const context = await seedTask("race-start-backlog");
  const app = createApp(db);
  const post = (path: string, body?: unknown) => app.request(path, {
    method: body === undefined ? "POST" : "PATCH",
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await asOperator(() => synchronised([
    async (release, gate) => { release(); await gate; return post(`/tasks/${context.task.id}/start`); },
    async (release, gate) => { release(); await gate; return post(`/tasks/${context.task.id}`, { status: "BACKLOG" }); },
  ]));
  const task = await db.task.findUniqueOrThrow({ where: { id: context.task.id } });
  const queued = await db.run.count({ where: { taskId: context.task.id, status: "QUEUED" } });
  // Either the park won (no run) or the start won (not parked). Never both.
  assert.equal(
    (task.status === "BACKLOG") !== (queued > 0),
    true,
    `status=${task.status}, queuedRuns=${queued}`,
  );
});

test("a Backlog PATCH is refused outright while a run is active", async () => {
  const context = await seedTask("backlog-active-run");
  await seedRun(context, 1, "WAITING_INBOX");
  const { status, body } = await call("PATCH", `/tasks/${context.task.id}`, { status: "BACKLOG" });
  assert.equal(status, 409);
  assert.equal(body.error, "Cannot move a task with an active run to Backlog");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).status, "TODO");
});

test("a successful Backlog PATCH still records the status-change activity", async () => {
  const context = await seedTask("backlog-activity");
  assert.equal((await call("PATCH", `/tasks/${context.task.id}`, { status: "BACKLOG" })).status, 200);
  assert.equal(await db.taskActivity.count({
    where: { taskId: context.task.id, body: "Status changed: TODO → BACKLOG" },
  }), 1);
});

// --- review fixes: archive-done re-checks status under the lock (SOL M3) -----

test("archive-done does not archive a task dragged out of Done between selection and lock", async () => {
  // `SELECT … FOR UPDATE` re-applies its own WHERE to the row version it waited
  // for, so restating `status = 'done'` in the locking query is what makes the
  // re-check atomic. Without it the operator's move back to the board is
  // silently undone.
  const context = await seedTask("archive-done-moved", { status: "DONE" });
  const app = createApp(db);
  const responses = await asOperator(() => synchronised([
    async (release, gate) => { release(); await gate; return app.request(`/projects/${context.project.id}/tasks/archive-done`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
    async (release, gate) => {
      release();
      await gate;
      return app.request(`/tasks/${context.task.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "TODO" }),
      });
    },
  ]));
  // archive-done always answers 200; the PATCH is either 200 (it got there
  // first, and the locking query then skipped the row) or 409 (archive-done
  // committed first, and the status write refuses to move an archived task).
  assert.equal(responses[0]!.status, 200);
  assert.ok([200, 409].includes(responses[1]!.status), `patch=${responses[1]!.status}`);
  const task = await db.task.findUniqueOrThrow({ where: { id: context.task.id } });
  // Whichever order won, the invariant holds: an archived task is a DONE task.
  // The failure this pins is `status=TODO, archivedAt=<set>` — work the operator
  // explicitly pulled back onto the board, silently hidden again.
  assert.equal(
    task.archivedAt === null || task.status === "DONE",
    true,
    `status=${task.status}, archivedAt=${task.archivedAt}`,
  );
});

test("an archived task rejects status writes before applying ordinary ownership rules", async () => {
  const context = await seedTask("archived-status-write", { status: "DONE" });
  assert.equal((await call("POST", `/tasks/${context.task.id}/archive`)).status, 200);
  const { status, body } = await call("PATCH", `/tasks/${context.task.id}`, { status: "TODO" });
  assert.equal(status, 409);
  assert.match(body.error, /unarchive it first/);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).status, "DONE");
  // Once unarchived, an operator-owned queue transition is accepted.
  assert.equal((await call("POST", `/tasks/${context.task.id}/unarchive`)).status, 200);
  await db.task.update({ where: { id: context.task.id }, data: { status: "BACKLOG" } });
  assert.equal((await call("PATCH", `/tasks/${context.task.id}`, { status: "TODO" })).status, 200);
});

test("archive-done never reaches across projects, even for ids handed to it", async () => {
  const mine = await seedTask("archive-done-scope-a", { status: "DONE" });
  const theirs = await seedTask("archive-done-scope-b", { status: "DONE" });
  const { status, body } = await call("POST", `/projects/${mine.project.id}/tasks/archive-done`);
  assert.equal(status, 200);
  assert.deepEqual(body, { archived: 1, skipped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: theirs.task.id } })).archivedAt, null);
});

// --- review fixes: E1 consistency between list and detail (SOL SS3) ---------

test("E1: a partial chain identity is rejected before it can reach the board", async () => {
  const context = await seedTask("e1-list", { chainId: "chain-e1", chainIndex: 0 });
  await assert.rejects(
    () => db.task.create({ data: {
      projectId: context.project.id, name: "Broken row", description: "d",
      chainId: "chain-e1", chainIndex: null,
    } }),
    /Task_chain_identity_all_or_none_check/u,
  );
  const { body } = await call("GET", `/tasks?projectId=${context.project.id}`);
  const real = body.find((task: any) => task.id === context.task.id);
  assert.equal(real.chainProgress.total, 1);
});

test("enrich=false drops the extra fields and keeps the rows", async () => {
  const context = await seedTask("enrich-off", { chainId: "chain-enrich", chainIndex: 0 });
  const { body } = await call("GET", `/tasks?projectId=${context.project.id}&enrich=false`);
  assert.equal(body.length, 1);
  assert.equal(body[0].id, context.task.id);
  assert.equal(body[0].chainProgress, null);
  assert.equal(body[0].recurringFireCount, 0);
});

// --- the Agent-row exclusion protocol (archive versus every run writer) ------
//
// Archive used to write `archivedAt` unconditionally while task creation,
// template instantiation and run enqueue checked it in another transaction.
// Both sides could be right at the same instant, and the loser left a QUEUED
// run for an archived agent — a row the claim query filters out forever. These
// tests hold real PostgreSQL locks, so they fail if either half is missing.

const agentRunCount = (agentId: string) => db.run.count({ where: { agentId } });

const seedTemplate = async (context: Awaited<ReturnType<typeof seedTask>>) => {
  const template = await db.taskTemplate.create({ data: {
    projectId: context.project.id, name: "Two steps", description: "two agent steps", variables: [],
  } });
  await db.taskTemplateStep.createMany({ data: [0, 1].map((stepIndex) => ({
    taskTemplateId: template.id,
    stepIndex,
    layer: stepIndex,
    name: `Step ${stepIndex}`,
    assigneeType: "AGENT" as const,
    assigneeAgentId: context.agent.id,
    prompt: "do the work",
    outputKind: "result",
  })) });
  return template;
};

test("template instantiation creates an inert chain unless autoStart is true", async () => {
  const context = await seedTask("template-autostart", { status: "DONE" });
  const template = await seedTemplate(context);
  const inert = await call("POST", `/projects/${context.project.id}/task-templates/${template.id}/instantiate`, {
    repoId: context.repo.id,
    variables: {},
    name: "inert template chain",
    autoStart: false,
  });
  assert.equal(inert.status, 201);
  assert.equal(await db.run.count({ where: { task: { chainId: inert.body.chainId } } }), 0);

  const started = await call("POST", `/projects/${context.project.id}/task-templates/${template.id}/instantiate`, {
    repoId: context.repo.id,
    variables: {},
    name: "started template chain",
    autoStart: true,
  });
  assert.equal(started.status, 201);
  assert.equal(await db.run.count({ where: { task: { chainId: started.body.chainId } } }), 1);
});

test("human task creation accepts BACKLOG atomically without queuing a Run", async () => {
  const project = await seedBareProject("backlog-create");
  const created = await call("POST", `/projects/${project.id}/tasks`, {
    name: "Human backlog card",
    assigneeType: "HUMAN",
    status: "BACKLOG",
  });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, "BACKLOG");
  const stored = await db.task.findUniqueOrThrow({ where: { id: created.body.id } });
  assert.equal(stored.status, "BACKLOG");
  assert.equal(stored.assigneeType, "HUMAN");
  assert.equal(await db.run.count({ where: { taskId: stored.id } }), 0);
});

test("human task creation keeps TODO as the default status", async () => {
  const project = await seedBareProject("todo-create");
  const created = await call("POST", `/projects/${project.id}/tasks`, {
    name: "Human todo card",
    assigneeType: "HUMAN",
  });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, "TODO");
  assert.equal(await db.task.count({ where: { id: created.body.id, status: "TODO" } }), 1);
  assert.equal(await db.run.count({ where: { taskId: created.body.id } }), 0);
});

test("task creation rejects statuses other than BACKLOG or TODO", async () => {
  const project = await seedBareProject("invalid-create-status");
  for (const status of ["DOING", "REVIEW", "DONE"] as const) {
    const created = await call("POST", `/projects/${project.id}/tasks`, {
      name: `Invalid ${status}`,
      assigneeType: "HUMAN",
      status,
    });
    assert.equal(created.status, 400, `${status}: ${JSON.stringify(created.body)}`);
    assert.equal(created.body.error, "Validation failed");
  }
  assert.equal(await db.task.count({ where: { projectId: project.id } }), 0);
  assert.equal(await db.run.count({ where: { projectId: project.id } }), 0);
});

test("agent task creation parks explicit BACKLOG and queues default TODO", async () => {
  const context = await seedTask("agent-create-status", { status: "DONE" });
  const request = {
    name: "Agent card",
    assigneeType: "AGENT",
    assigneeAgentId: context.agent.id,
    repoId: context.repo.id,
    scheduleKind: "NOW",
  };

  const backlog = await call("POST", `/projects/${context.project.id}/tasks`, {
    ...request,
    status: "BACKLOG",
  });
  assert.equal(backlog.status, 201, JSON.stringify(backlog.body));
  assert.equal(backlog.body.status, "BACKLOG");
  assert.equal(await db.run.count({ where: { taskId: backlog.body.id } }), 0);

  const todo = await call("POST", `/projects/${context.project.id}/tasks`, request);
  assert.equal(todo.status, 201, JSON.stringify(todo.body));
  assert.equal(todo.body.status, "TODO");
  assert.equal(await db.run.count({ where: { taskId: todo.body.id, status: "QUEUED" } }), 1);
});

test("archive and direct task creation released together never strand a queued run", async () => {
  // The seeded task is DONE so this test is about the run the creation makes:
  // archive fails closed on any live task, and a TODO seed would refuse the
  // archive before the race under test could decide anything.
  const context = await seedTask("race-archive-create", { status: "DONE" });
  const app = createApp(db);
  const [archive, create] = await asOperator(() => synchronised([
    async (release, gate) => {
      release();
      await gate;
      return app.request(`/agents/${context.agent.id}/archive`, {
        method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` },
      });
    },
    async (release, gate) => {
      release();
      await gate;
      return app.request(`/projects/${context.project.id}/tasks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Raced task", description: "work",
          assigneeType: "AGENT", assigneeAgentId: context.agent.id, repoId: context.repo.id,
        }),
      });
    },
  ]));
  const archived = (await db.agent.findUniqueOrThrow({ where: { id: context.agent.id } })).archivedAt !== null;
  const runs = await agentRunCount(context.agent.id);
  assert.equal(archived !== (runs > 0), true, `archived=${archived}, runs=${runs}`);
  if (archived) {
    assert.equal(archive!.status, 200);
    assert.equal(create!.status, 400);
    assert.match((await create!.json() as any).error, /is archived/);
    assert.equal(await db.task.count({ where: { name: "Raced task" } }), 0);
  } else {
    assert.equal(create!.status, 201);
    assert.equal(archive!.status, 409);
    assert.match((await archive!.json() as any).error, /Cannot archive an agent with a QUEUED run/);
  }
});

test("archive and template instantiation released together never strand a queued run", async () => {
  // DONE for the same reason as the creation race above.
  const context = await seedTask("race-archive-instantiate", { status: "DONE" });
  const template = await seedTemplate(context);
  const app = createApp(db);
  const [archive, instantiate] = await asOperator(() => synchronised([
    async (release, gate) => {
      release();
      await gate;
      return app.request(`/agents/${context.agent.id}/archive`, {
        method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` },
      });
    },
    async (release, gate) => {
      release();
      await gate;
      return app.request(`/projects/${context.project.id}/task-templates/${template.id}/instantiate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: context.repo.id, variables: {}, name: "archive instantiate race", autoStart: true }),
      });
    },
  ]));
  const archived = (await db.agent.findUniqueOrThrow({ where: { id: context.agent.id } })).archivedAt !== null;
  const runs = await agentRunCount(context.agent.id);
  assert.equal(archived !== (runs > 0), true, `archived=${archived}, runs=${runs}`);
  if (archived) {
    assert.equal(archive!.status, 200);
    assert.equal(instantiate!.status, 400);
    assert.match((await instantiate!.json() as any).error, /is archived/);
    // A rolled-back instantiation leaves no half-written chain behind.
    assert.equal(await db.task.count({ where: { templateId: template.id } }), 0);
  } else {
    assert.equal(instantiate!.status, 201);
    assert.equal(archive!.status, 409);
    assert.equal(await db.task.count({ where: { templateId: template.id } }), 2);
  }
});

/** Archives the agent inside a foreign transaction that keeps the row locked,
 *  starts `operation` while that archive is still uncommitted — so every check
 *  outside the protocol sees a live agent — and commits underneath it. */
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

const updateAgentUnderHeldLock = async <T>(
  agentId: string,
  data: { model: string; runnerPreference: "CODEX" | "PI"; codexServiceTier: "DEFAULT" | "FAST" },
  operation: () => Promise<T>,
): Promise<T> => {
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => { acquired = resolve; });
  try {
    const updating = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${agentId} FOR UPDATE`;
      await tx.agent.update({ where: { id: agentId }, data });
      acquired();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }, { timeout: 10_000 });
    await held;
    const pending = operation();
    await updating;
    return await pending;
  } finally {
    await holder.$disconnect();
  }
};

test("Agent PATCH validates the locked current row instead of committing a raced runner/model contradiction", { timeout: 30_000 }, async () => {
  const context = await seedTask("locked-agent-patch", { status: "DONE" });
  await db.agent.update({ where: { id: context.agent.id }, data: {
    model: "gpt-5.6-luna:max", runnerPreference: "CODEX", codexServiceTier: "DEFAULT",
  } });
  const patched = await updateAgentUnderHeldLock(context.agent.id, {
    model: "openai-codex/gpt-5.6-sol:high", runnerPreference: "PI", codexServiceTier: "DEFAULT",
  }, () => call("PATCH", `/agents/${context.agent.id}`, { model: "gpt-5.6-terra:high" }));
  assert.equal(patched.status, 400, JSON.stringify(patched.body));
  assert.match(patched.body.error, /requires CODEX, but this Agent stores PI/u);
  const stored = await db.agent.findUniqueOrThrow({ where: { id: context.agent.id } });
  assert.equal(stored.runnerPreference, "PI");
  assert.equal(stored.model, "openai-codex/gpt-5.6-sol:high");
});

test("task creation snapshots the Agent configuration re-read after its row lock", { timeout: 30_000 }, async () => {
  const context = await seedTask("locked-agent-run-snapshot", { status: "DONE" });
  const created = await updateAgentUnderHeldLock(context.agent.id, {
    model: "gpt-5.6-luna:max", runnerPreference: "CODEX", codexServiceTier: "FAST",
  }, () => call("POST", `/projects/${context.project.id}/tasks`, {
    name: "Fresh snapshot", description: "work", assigneeType: "AGENT",
    assigneeAgentId: context.agent.id, repoId: context.repo.id,
  }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await db.run.findFirstOrThrow({ where: { taskId: created.body.id } });
  assert.equal(run.runner, "CODEX");
  assert.equal(run.model, "gpt-5.6-luna:max");
  assert.equal(run.codexServiceTier, "FAST");
});

test("Run native subagent snapshots reject incomplete or noncanonical capability", async () => {
  const context = await seedTask("subagent-snapshot", { status: "DONE" });
  const base = {
    projectId: context.project.id, taskId: context.task.id, agentId: context.agent.id, repoId: context.repo.id,
    runner: "CODEX" as const, model: "gpt-5.6-sol:medium", promptHash: "hash",
  };
  await assert.rejects(() => db.run.create({ data: {
    ...base, runNumber: 1, dedupeKey: `task:${context.task.id}:run:1`, subagentModel: "gpt-5.6-luna:max",
  } }));
  await assert.rejects(() => db.run.create({ data: {
    ...base, runNumber: 2, dedupeKey: `task:${context.task.id}:run:2`,
    subagentModel: "gpt-5.6-luna:max", subagentMaxConcurrent: 7,
  } }));
  await assert.rejects(() => db.run.create({ data: {
    ...base, runNumber: 3, dedupeKey: `task:${context.task.id}:run:3`, runner: "CLAUDE",
    subagentModel: "gpt-5.6-luna:max", subagentMaxConcurrent: 8,
  } }));
});

test("an archive committing under the lock is seen by task creation and by instantiation", { timeout: 30_000 }, async () => {
  // Both writers passed their unlocked assignee check before the archive
  // committed. Only the re-read under the Agent-row mutex can still refuse
  // them, and refusing is what keeps a queued run out of an archived agent.
  const create = await seedTask("locked-archive-create");
  const created = await archiveUnderHeldLock(create.agent.id, () => call("POST", `/projects/${create.project.id}/tasks`, {
    name: "Loses the race", description: "work",
    assigneeType: "AGENT", assigneeAgentId: create.agent.id, repoId: create.repo.id,
  }));
  assert.equal(created.status, 400, JSON.stringify(created.body));
  assert.match(created.body.error, /is archived/);
  assert.equal(await db.task.count({ where: { name: "Loses the race" } }), 0);
  assert.equal(await agentRunCount(create.agent.id), 0);

  const chain = await seedTask("locked-archive-instantiate");
  const template = await seedTemplate(chain);
  const instantiated = await archiveUnderHeldLock(chain.agent.id, () => call(
    "POST",
    `/projects/${chain.project.id}/task-templates/${template.id}/instantiate`,
    { repoId: chain.repo.id, variables: {}, name: "locked archive instantiate", autoStart: true },
  ));
  assert.equal(instantiated.status, 400, JSON.stringify(instantiated.body));
  assert.match(instantiated.body.error, /is archived/);
  assert.equal(await db.task.count({ where: { templateId: template.id } }), 0);
  assert.equal(await agentRunCount(chain.agent.id), 0);
});

test("an Agent row held by a foreign transaction makes assignment and archive wait", { timeout: 30_000 }, async () => {
  // Direct proof that both halves take the same row lock: hold the Agent row in
  // another transaction and neither writer may answer before it is released.
  const context = await seedTask("race-agent-lock-proof");
  const holdAgentRow = async <T>(operation: () => Promise<T>): Promise<{ result: T; waited: boolean }> => {
    const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
    let released = false;
    let waited = true;
    let acquired!: () => void;
    const lockHeld = new Promise<void>((resolve) => { acquired = resolve; });
    try {
      const held = holder.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${context.agent.id} FOR UPDATE`;
        acquired();
        await new Promise((resolve) => setTimeout(resolve, 700));
        released = true;
      }, { timeout: 10_000 });
      // Connecting a fresh client is slower than the request under test, so the
      // writer is only fired once the row is provably held.
      await lockHeld;
      const pending = operation().then((value) => { waited = released; return value; });
      const [, result] = await Promise.all([held, pending]);
      return { result, waited };
    } finally {
      await holder.$disconnect();
    }
  };

  const created = await holdAgentRow(() => call("POST", `/projects/${context.project.id}/tasks`, {
    name: "Waits for the lock", description: "work",
    assigneeType: "AGENT", assigneeAgentId: context.agent.id, repoId: context.repo.id,
  }));
  assert.equal(created.waited, true, "task creation must wait for the Agent row");
  assert.equal(created.result.status, 201);

  const archived = await holdAgentRow(() => call("POST", `/agents/${context.agent.id}/archive`));
  assert.equal(archived.waited, true, "archive must wait for the Agent row");
  // And once it gets the row it fails closed on the run the creation just made.
  assert.equal(archived.result.status, 409);
  assert.match(archived.result.body.error, /Cannot archive an agent with a QUEUED run/);
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: context.agent.id } })).archivedAt, null);
});

test("archive fails closed on every live task status and stays open on the parked ones", async () => {
  // A run is not the only live reference. TODO holds a scheduled definition and
  // every chain step waiting for its predecessor; REVIEW holds a step whose gate
  // can still be rejected, which queues the producing step again. Neither has a
  // run yet, so the run half of the blocker cannot see them at all. DONE is
  // history and BACKLOG is where an operator parks work on purpose — archiving
  // over those must stay a one-click operation.
  const cases = [
    { status: "TODO" as const, blocked: true },
    { status: "DOING" as const, blocked: true },
    { status: "REVIEW" as const, blocked: true },
    { status: "DONE" as const, blocked: false },
    { status: "BACKLOG" as const, blocked: false },
  ];
  for (const { status, blocked } of cases) {
    const context = await seedTask(`archive-${status.toLowerCase()}`, { status, name: `${status} work` });
    assert.equal(await agentRunCount(context.agent.id), 0, "the matrix is about task references, not runs");
    const response = await call("POST", `/agents/${context.agent.id}/archive`);
    const stored = await db.agent.findUniqueOrThrow({ where: { id: context.agent.id } });
    if (blocked) {
      assert.equal(response.status, 409, `${status}: ${JSON.stringify(response.body)}`);
      assert.equal(
        response.body.error,
        `Cannot archive an agent assigned to ${status} task ${status} work; finish, park, archive, or reassign that task first`,
      );
      assert.equal(stored.archivedAt, null, `${status} must leave the agent unarchived`);
      // Each of the four exits the message offers actually unblocks the archive.
      await db.task.update({ where: { id: context.task.id }, data: { status: "BACKLOG" } });
      assert.equal((await call("POST", `/agents/${context.agent.id}/archive`)).status, 200);
    } else {
      assert.equal(response.status, 200, `${status}: ${JSON.stringify(response.body)}`);
      assert.notEqual(stored.archivedAt, null, `${status} must not hold the agent open`);
    }
  }
});

test("an already-archived task never holds its assignee open", async () => {
  // `archivedAt: null` is half the filter and is easy to lose: an archived TODO
  // task is not a reference to anything, and the operator who archived it has
  // already said so.
  const context = await seedTask("archive-archived-task", { status: "TODO", archivedAt: new Date() });
  assert.equal((await call("POST", `/agents/${context.agent.id}/archive`)).status, 200);
});

test("archive and a scheduled task creation released together never strand a runless task", async () => {
  // The gap this closes, as a real race: a scheduled task is created with no
  // run at all, so the run half of the blocker sees nothing. If archive commits
  // beside it, the scheduler later tries to enqueue for an archived agent and
  // the definition never fires again.
  const context = await seedTask("race-archive-scheduled", { status: "DONE" });
  const app = createApp(db);
  const runAt = new Date(Date.now() + 3_600_000).toISOString();
  const [archive, create] = await asOperator(() => synchronised([
    async (release, gate) => {
      release();
      await gate;
      return app.request(`/agents/${context.agent.id}/archive`, {
        method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` },
      });
    },
    async (release, gate) => {
      release();
      await gate;
      return app.request(`/projects/${context.project.id}/tasks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Scheduled sweep", description: "work",
          assigneeType: "AGENT", assigneeAgentId: context.agent.id, repoId: context.repo.id,
          scheduleKind: "AT", runAt,
        }),
      });
    },
  ]));
  const archived = (await db.agent.findUniqueOrThrow({ where: { id: context.agent.id } })).archivedAt !== null;
  const scheduled = await db.task.count({ where: { name: "Scheduled sweep" } });
  assert.equal(await agentRunCount(context.agent.id), 0, "an AT task queues no run yet");
  assert.equal(archived !== (scheduled > 0), true, `archived=${archived}, scheduled=${scheduled}`);
  if (archived) {
    assert.equal(archive!.status, 200);
    assert.equal(create!.status, 400);
    assert.match((await create!.json() as any).error, /is archived/);
  } else {
    assert.equal(create!.status, 201);
    assert.equal(archive!.status, 409);
    assert.match((await archive!.json() as any).error, /Cannot archive an agent assigned to TODO task Scheduled sweep/);
  }
});

// --- review fixes: reactivation joins the exclusion protocol (MF-1) ----------
//
// A task is live when it is unarchived and TODO|DOING|REVIEW — the same set
// `agentArchiveBlocker` refuses to archive an agent out from under. Two writers
// could still produce one: a status-only PATCH out of BACKLOG or DONE named no
// assignee, so the Agent row was never read, and unarchive took no lock at all.
// The result is not "assigned": the runner claims only unarchived TODO|DOING
// tasks whose agent is unarchived, so the task sits on the board as work in
// progress that nothing will ever pick up.

const archivedAssigneeContext = async (label: string, status: "BACKLOG" | "DONE" | "TODO" | "DOING" | "REVIEW") => {
  const context = await seedTask(label, { status });
  // Archived through the real route, which is the only thing that proves the
  // agent was archivable at all: a live task would have blocked it.
  assert.equal((await call("POST", `/agents/${context.agent.id}/archive`)).status, 200);
  return context;
};

const statusOf = async (taskId: string) => (await db.task.findUniqueOrThrow({ where: { id: taskId } })).status;

test("promoting parked or finished history to a live status is refused while the assignee is archived", async () => {
  for (const from of ["BACKLOG", "DONE"] as const) {
    for (const to of ["TODO", "DOING", "REVIEW"] as const) {
      const context = await archivedAssigneeContext(`reactivate-${from}-${to}`.toLowerCase(), from);
      const { status, body } = await call("PATCH", `/tasks/${context.task.id}`, { status: to });
      assert.equal(status, 409, `${from} → ${to}: ${JSON.stringify(body)}`);
      assert.equal(body.error, "Assignee agent is archived; unarchive the agent or reassign this task first");
      assert.equal(await statusOf(context.task.id), from, `${from} → ${to} changed the status anyway`);
      assert.equal(await db.taskActivity.count({ where: { taskId: context.task.id } }), 0);
      assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 0);
    }
  }
});

test("a status write that only looks like a no-op still joins the Task-row mutex", async () => {
  // The old entry condition compared the body against a read taken *before* the
  // transaction, so a request naming the status the row already had skipped the
  // lock, every guard behind it, and wrote through unchecked. The archived-task
  // freeze is the observable proof that it no longer does.
  const context = await seedTask("status-echo-freeze");
  assert.equal((await call("POST", `/tasks/${context.task.id}/archive`)).status, 200);
  const { status, body } = await call("PATCH", `/tasks/${context.task.id}`, { status: "TODO", description: "edited" });
  assert.equal(status, 409, JSON.stringify(body));
  assert.equal(body.error, "Cannot change the status of an archived task; unarchive it first");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).description, "work");
});

test("a promotion decided on a stale read is refused by the row it actually locked", { timeout: 20_000 }, async () => {
  // The exact gap, deterministically: the route reads the task outside the
  // transaction, so `status: TODO` on a task that *was* TODO can arrive at a row
  // another writer has since parked and whose agent it has since archived —
  // which is the state two ordinary requests (park in Backlog, then archive the
  // now-idle agent) legitimately leave behind. Both writes are made here inside
  // the transaction that holds the row, so the PATCH is provably still waiting
  // when they commit.
  const context = await seedTask("stale-read-promotion");
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let acquired!: () => void;
  const lockHeld = new Promise<void>((resolve) => { acquired = resolve; });
  try {
    const held = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${context.task.id} FOR UPDATE`;
      acquired();
      // Long enough for the route to take its stale `before` read and block.
      await new Promise((resolve) => setTimeout(resolve, 700));
      await tx.$executeRaw`UPDATE "Task" SET "status" = 'backlog'::"TaskStatus" WHERE "id" = ${context.task.id}`;
      await tx.$executeRaw`UPDATE "Agent" SET "archivedAt" = now() WHERE "id" = ${context.agent.id}`;
    }, { timeout: 10_000 });
    await lockHeld;
    const pending = call("PATCH", `/tasks/${context.task.id}`, { status: "TODO" });
    const [, response] = await Promise.all([held, pending]);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error, "Assignee agent is archived; unarchive the agent or reassign this task first");
    assert.equal(await statusOf(context.task.id), "BACKLOG");
    assert.equal(await db.taskActivity.count({ where: { taskId: context.task.id } }), 0);
  } finally {
    await holder.$disconnect();
  }
});

test("unarchiving the agent or reassigning the task lets the same promotion through", async () => {
  const revived = await archivedAssigneeContext("reactivate-unarchive-agent", "BACKLOG");
  assert.equal((await call("POST", `/agents/${revived.agent.id}/unarchive`)).status, 200);
  assert.equal((await call("PATCH", `/tasks/${revived.task.id}`, { status: "TODO" })).status, 200);
  assert.equal(await statusOf(revived.task.id), "TODO");
  assert.equal(await db.taskActivity.count({
    where: { taskId: revived.task.id, body: "Status changed: BACKLOG → TODO" },
  }), 1);

  const reassigned = await archivedAssigneeContext("reactivate-reassign", "BACKLOG");
  const successor = await db.agent.create({ data: {
    projectId: reassigned.project.id, environmentId: reassigned.agent.environmentId, name: "successor",
    title: "Successor", model: "claude", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: reassigned.project.id, agentId: successor.id, repoId: reassigned.repo.id,
    mountPath: "/repo", permissions: "GIT_WRITE",
  } });
  const handed = await call("PATCH", `/tasks/${reassigned.task.id}`, { status: "TODO", assigneeAgentId: successor.id });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(await statusOf(reassigned.task.id), "TODO");
});

test("Human queue movement remains operator-owned while unassigned AGENT state does not", async () => {
  const context = await seedTask("reactivate-human", { status: "BACKLOG", assigneeType: "HUMAN", assigneeAgentId: null });
  assert.equal((await call("PATCH", `/tasks/${context.task.id}`, { status: "TODO" })).status, 200);
  assert.equal(await statusOf(context.task.id), "TODO");

  const unassigned = await seedTask("reactivate-unassigned", { status: "DONE", assigneeAgentId: null });
  assert.equal((await call("PATCH", `/tasks/${unassigned.task.id}`, { status: "REVIEW" })).status, 409);
  assert.equal(await statusOf(unassigned.task.id), "DONE");
});

test("naming an archived agent in the promotion itself is still the 400 it always was", async () => {
  const context = await archivedAssigneeContext("reactivate-explicit", "BACKLOG");
  const { status, body } = await call("PATCH", `/tasks/${context.task.id}`, {
    status: "TODO", assigneeAgentId: context.agent.id,
  });
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(body.error, "Assignee agent is archived");
  assert.equal(await statusOf(context.task.id), "BACKLOG");
});

test("unarchiving a live-status task is refused while its assignee is archived", async () => {
  for (const status of ["TODO", "DOING", "REVIEW"] as const) {
    const context = await seedTask(`unarchive-live-${status}`.toLowerCase(), { status });
    assert.equal((await call("POST", `/tasks/${context.task.id}/archive`)).status, 200);
    // Only now is the agent archivable — the archived task no longer blocks it.
    assert.equal((await call("POST", `/agents/${context.agent.id}/archive`)).status, 200);
    const response = await call("POST", `/tasks/${context.task.id}/unarchive`);
    assert.equal(response.status, 409, `${status}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, "Assignee agent is archived; unarchive the agent or reassign this task first");
    assert.notEqual((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).archivedAt, null);
    assert.equal(await db.taskActivity.count({ where: { taskId: context.task.id, body: "Task unarchived" } }), 0);
    // Unarchive the agent and the operator gets their task back.
    assert.equal((await call("POST", `/agents/${context.agent.id}/unarchive`)).status, 200);
    assert.equal((await call("POST", `/tasks/${context.task.id}/unarchive`)).status, 200);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).archivedAt, null);
  }
});

test("archived history stays unarchivable whatever became of its assignee", async () => {
  // Refusing these would let an agent's archival delete the operator's ability
  // to read their own finished and parked work back onto the board.
  for (const status of ["DONE", "BACKLOG"] as const) {
    const context = await seedTask(`unarchive-history-${status}`.toLowerCase(), { status });
    assert.equal((await call("POST", `/tasks/${context.task.id}/archive`)).status, 200);
    assert.equal((await call("POST", `/agents/${context.agent.id}/archive`)).status, 200);
    const response = await call("POST", `/tasks/${context.task.id}/unarchive`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const task = await db.task.findUniqueOrThrow({ where: { id: context.task.id } });
    assert.equal(task.archivedAt, null);
    assert.equal(task.status, status);
    assert.equal(task.assigneeAgentId, context.agent.id, "unarchiving must not quietly unassign");
    assert.equal(await db.taskActivity.count({ where: { taskId: context.task.id, body: "Task unarchived" } }), 1);
    // And the row is still frozen out of the live statuses, by the guard above.
    assert.equal((await call("PATCH", `/tasks/${context.task.id}`, { status: "TODO" })).status, 409);
  }
});

test("an agent archive and a Backlog promotion released together never leave a live task on an archived agent", async () => {
  const context = await seedTask("race-archive-promote", { status: "BACKLOG" });
  const app = createApp(db);
  const responses = await asOperator(() => synchronised([
    async (release, gate) => {
      release();
      await gate;
      return app.request(`/agents/${context.agent.id}/archive`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } });
    },
    async (release, gate) => {
      release();
      await gate;
      return app.request(`/tasks/${context.task.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "TODO" }),
      });
    },
  ]));
  for (const response of responses) assert.ok(response.status < 500, `unexpected ${response.status}`);
  const agent = await db.agent.findUniqueOrThrow({ where: { id: context.agent.id } });
  const task = await db.task.findUniqueOrThrow({ where: { id: context.task.id } });
  const live = task.archivedAt === null && task.status === "TODO";
  // Either the archive won (the task stays parked) or the promotion won (the
  // agent stays unarchived). Never both.
  assert.equal(
    (agent.archivedAt !== null) !== live,
    true,
    `agentArchivedAt=${agent.archivedAt}, status=${task.status}`,
  );
});

test("an archive that commits mid-unarchive is seen by the unarchive, not written over", { timeout: 20_000 }, async () => {
  // The concurrent half for unarchive, forced into the losing order rather than
  // left to wall-clock luck: the request is provably already inside the route
  // when the agent's archival commits. Unlocked, it read `archivedAt` first and
  // cleared it afterwards — restoring a TODO task onto an agent that no runner
  // will claim for.
  const context = await seedTask("race-archive-unarchive", { status: "TODO" });
  assert.equal((await call("POST", `/tasks/${context.task.id}/archive`)).status, 200);
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let acquired!: () => void;
  const lockHeld = new Promise<void>((resolve) => { acquired = resolve; });
  try {
    const held = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${context.task.id} FOR UPDATE`;
      acquired();
      await new Promise((resolve) => setTimeout(resolve, 700));
      // What POST /agents/:id/archive commits here: the task is archived, so it
      // no longer holds its assignee open and the archival is allowed.
      await tx.$executeRaw`UPDATE "Agent" SET "archivedAt" = now() WHERE "id" = ${context.agent.id}`;
    }, { timeout: 10_000 });
    await lockHeld;
    const pending = call("POST", `/tasks/${context.task.id}/unarchive`);
    const [, response] = await Promise.all([held, pending]);
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.notEqual((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).archivedAt, null);
    assert.equal(await db.taskActivity.count({ where: { taskId: context.task.id, body: "Task unarchived" } }), 0);
  } finally {
    await holder.$disconnect();
  }
});

test("a Task row held by a foreign transaction makes unarchive wait", { timeout: 20_000 }, async () => {
  // Direct proof that unarchive now joins the Task-row mutex instead of writing
  // outside it: holding the row in another transaction blocks the route.
  const context = await seedTask("race-unarchive-lock-proof");
  assert.equal((await call("POST", `/tasks/${context.task.id}/archive`)).status, 200);
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let released = false;
  let acquired!: () => void;
  const lockHeld = new Promise<void>((resolve) => { acquired = resolve; });
  try {
    const held = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${context.task.id} FOR UPDATE`;
      acquired();
      await new Promise((resolve) => setTimeout(resolve, 700));
      released = true;
    }, { timeout: 10_000 });
    await lockHeld;
    let waited = true;
    const pending = call("POST", `/tasks/${context.task.id}/unarchive`).then((value) => { waited = released; return value; });
    const [, response] = await Promise.all([held, pending]);
    assert.equal(waited, true, "unarchive must wait for the Task row");
    assert.equal(response.status, 200);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).archivedAt, null);
  } finally {
    await holder.$disconnect();
  }
});
