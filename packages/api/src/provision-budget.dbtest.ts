import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

import { DependencyProvisioning, FAILURE_ENVELOPE_VERSION, type FailureEnvelope, PrismaClient } from "@anneal/db";

import { retryDelayMs } from "./execution.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

/**
 * Issue #113: a failure in the supply phase must not spend one of the task's
 * sessions.
 *
 * The 2026-08-17 shape is the whole point of this file — two `git clone`s that
 * lost their TLS connection in under a second each, before any agent process
 * existed, cost the task two of its five sessions. #111 moved the verdict to
 * the API and refunds those attempts onto `Run.maxRunsPerTask`, but the refund
 * only reached the routes that read a run row. `POST /tasks/:id/start`,
 * `startable` (the web app's Start button) and `enqueueTaskRun` all measured
 * against `Task.maxSessionsPerTask` instead, so from an operator's seat the
 * budget was still gone. These tests exercise the whole loop: a real completion
 * through the runner route, then the operator route that has to honour it.
 */

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const isolatedRoot = process.env.RUNNER_WORKSPACE_ROOT!;
const RUNNER = "runner-budget-token";
const OPERATOR = "operator-budget-token";

const withTokens = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = { runner: process.env.RUNNER_TOKEN, operator: process.env.OPERATOR_TOKEN, root: process.env.RUNNER_WORKSPACE_ROOT };
  mkdirSync(isolatedRoot, { recursive: true });
  process.env.RUNNER_TOKEN = RUNNER;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_WORKSPACE_ROOT = isolatedRoot;
  try {
    return await operation();
  } finally {
    for (const [key, value] of [["RUNNER_TOKEN", prior.runner], ["OPERATOR_TOKEN", prior.operator], ["RUNNER_WORKSPACE_ROOT", prior.root]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

let seedCounter = 0;

const seedTask = async (label: string, maxSessionsPerTask: number) => {
  const suffix = `${Date.now()}-${seedCounter++}`;
  const project = await db.project.create({ data: { name: label, slug: `${label}-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE",
  } });
  const task = await db.task.create({ data: {
    projectId: project.id, name: "Step", description: "work", assigneeAgentId: agent.id, repoId: repo.id,
    status: "DOING", maxSessionsPerTask,
  } });
  return { project, agent, repo, task, suffix };
};

type Seeded = Awaited<ReturnType<typeof seedTask>>;

/** Puts an existing queued run — or a first one — on the wire as a claimed,
 *  leased, RUNNING run with the session the complete route requires. */
const makeRunnable = async (context: Seeded, runNumber: number) => {
  const runnerId = `runner-${context.suffix}-${runNumber}`;
  const fencingToken = `1:${context.task.id}:${context.suffix}-${runNumber}`;
  const existing = await db.run.findFirst({ where: { taskId: context.task.id, runNumber } });
  const run = existing
    ? await db.run.update({ where: { id: existing.id }, data: {
      status: "RUNNING", runnerId, fencingToken, leaseExpiresAt: new Date(Date.now() + 60_000),
    } })
    : await db.run.create({ data: {
      projectId: context.project.id, taskId: context.task.id, agentId: context.agent.id, repoId: context.repo.id,
      runNumber, dedupeKey: `task:${context.task.id}:run:${runNumber}`, runner: "CLAUDE", model: "claude",
      promptHash: "hash", status: "RUNNING", runnerId, fencingToken,
      leaseExpiresAt: new Date(Date.now() + 60_000), maxRunsPerTask: context.task.maxSessionsPerTask,
    } });
  await db.session.create({ data: {
    runId: run.id, projectId: context.project.id, agentId: context.agent.id, taskId: context.task.id,
    runner: "CLAUDE", executionStatus: "RUNNING",
  } });
  return { run, runnerId, fencingToken };
};

/**
 * The envelope a real `git clone` failure produces, copied verbatim from the
 * payload `packages/runner/src/provision-failure.test.ts` captures out of a
 * real `executeClaim`. Keep the two in step: it is what makes this a test of
 * what the runner sends rather than of a shape invented here.
 *
 * The previous version of this file hand-wrote `terminationReason: null` and
 * so asserted a retry only its own fixture could produce. The real runner
 * stamps every escaped exception `"runner exception"`, and the API used to read
 * any termination reason as a cancelled session — which is exactly why the
 * production path refunded the attempt and then stopped dead in REVIEW.
 */
const unreachableRemoteEnvelope = {
  version: FAILURE_ENVELOPE_VERSION,
  phase: "PROVISION",
  runnerClass: "TASK_FAILED",
  exitCode: 1,
  signal: null,
  terminationReason: "runner exception",
  terminalEventSeen: false,
  terminalSuccess: false,
  agentExited: false,
  providerError: null,
  stderrSummary: "git failed (128): fatal: repository '/nonexistent/agentos-issue-113-no-such-repo.git' does not exist",
  stdoutSummary: null,
  timedOut: false,
  transient: false,
  timeoutMs: null,
} as const;

/**
 * The 2026-08-17 shape: the same catch path, the same `"runner exception"`,
 * differing only in the one field the runner's typed network predicate sets.
 * `provision-failure.test.ts` proves that a real transient clone failure
 * escaping the real `provisionWorkspace` produces `transient: true` here.
 */
const lostTlsEnvelope = {
  ...unreachableRemoteEnvelope,
  runnerClass: "TRANSIENT_PROVIDER",
  stderrSummary: "git failed (128): fatal: unable to access 'https://example.test/repo.git/': "
    + "LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to example.test:443",
  transient: true,
} as const;

/** A retryable protocol miss after the agent had started work: the agent's
 * attempt, so it has to cost a session without resembling transport evidence. */
const executeEnvelope = {
  ...lostTlsEnvelope,
  phase: "EXECUTE",
  runnerClass: "PROTOCOL_ERROR",
  exitCode: 0,
  terminationReason: null,
  agentExited: true,
  terminalEventSeen: false,
  stderrSummary: "agent stream ended without a terminal event",
  transient: false,
} as const;

/** The rest of the completion payload exactly as `runner.ts`'s catch sends it:
 *  the runner's own advisory verdict rides inside the envelope as `runnerClass`
 *  and must lose to the API's. */
const completeRun = (
  runId: string,
  identity: { runnerId: string; fencingToken: string },
  envelope: FailureEnvelope,
  extra: Record<string, unknown> = {},
) => withTokens(() => createApp(db).request(`/runner/runs/${runId}/complete`, {
  method: "POST",
  headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    ...identity,
    outcome: {
      case: "provider-failure",
      reason: envelope.stderrSummary ?? "clone failed",
      envelope,
    },
    exitCode: envelope.exitCode,
    signal: null,
    terminationReason: envelope.terminationReason,
    cleanupStatus: "SUCCEEDED",
    ...extra,
  }),
}));

const start = async (taskId: string): Promise<{ status: number; body: any }> => withTokens(async () => {
  const response = await createApp(db).request(`/tasks/${taskId}/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
  });
  return { status: response.status, body: await response.json() };
});

const retry = async (taskId: string): Promise<{ status: number; body: any }> => withTokens(async () => {
  const response = await createApp(db).request(`/tasks/${taskId}/retry`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
  });
  return { status: response.status, body: await response.json() };
});

/** Drives one full provisioning failure and returns the closed run. */
const failProvisioning = async (context: Seeded, runNumber: number, envelope: FailureEnvelope = lostTlsEnvelope as unknown as FailureEnvelope) => {
  const { run, runnerId, fencingToken } = await makeRunnable(context, runNumber);
  assert.equal((await completeRun(run.id, { runnerId, fencingToken }, envelope)).status, 200);
  return db.run.findUniqueOrThrow({ where: { id: run.id } });
};

test("a lost TLS connection during clone is refunded AND retried, on the payload the runner really sends", async () => {
  const context = await seedTask("provision-refund", 2);
  const closed = await failProvisioning(context, 1);
  assert.equal(closed.failureClass, "TRANSIENT_PROVIDER");
  assert.equal(closed.retryable, true, "a lost TLS connection is retried, not sent to an operator");
  assert.equal(closed.maxRunsPerTask, 3, "budget 2 + one refunded attempt");
  const retry = await db.run.findFirstOrThrow({ where: { taskId: context.task.id, runNumber: 2 } });
  assert.equal(retry.maxRunsPerTask, 3, "and the refund is carried onto the attempt it paid for");
});

test("two clone failures leave both of a two-session budget for the agent's own work", async () => {
  const context = await seedTask("provision-budget", 2);
  await failProvisioning(context, 1);
  const second = await failProvisioning(context, 2);
  assert.equal(second.maxRunsPerTask, 4, "two refunds, so four run numbers for two sessions");

  // The auto-retry has already queued run 3; take it off the board so the
  // operator route sees a task whose runs are all terminal — the seat from
  // which #113 was reported.
  await db.run.deleteMany({ where: { taskId: context.task.id, runNumber: 3 } });
  await db.task.update({ where: { id: context.task.id }, data: { status: "TODO" } });

  // Before this fix: 409 "Run budget exhausted". Two runs existed, the task's
  // configured budget was two, and this gate could not see either refund.
  const started = await start(context.task.id);
  assert.equal(started.status, 201, "network flakiness must not exhaust a task's sessions");
  const queued = await db.run.findFirstOrThrow({ where: { taskId: context.task.id, runNumber: started.body.runNumber } });
  // And the run it queued has to be claimable: `enqueueTaskRun` used to reset
  // the ceiling to the task's raw budget, handing the runner a run whose
  // `runNumber` already exceeded its own `maxRunsPerTask` — refused at boot,
  // forever.
  assert.equal(queued.runNumber, 3);
  assert.equal(queued.maxRunsPerTask, 4, "a requeue must not throw away the refunds already granted");
});

test("a failure the agent's own work produced still spends a session", async () => {
  const context = await seedTask("execute-budget", 2);
  const { run: first, runnerId, fencingToken } = await makeRunnable(context, 1);
  assert.equal((await completeRun(first.id, { runnerId, fencingToken }, executeEnvelope as unknown as FailureEnvelope)).status, 200);
  const closedFirst = await db.run.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(closedFirst.retryable, true);
  assert.equal(closedFirst.maxRunsPerTask, 2, "the agent ran; no refund");

  const second = await makeRunnable(context, 2);
  assert.equal((await completeRun(second.run.id, { runnerId: second.runnerId, fencingToken: second.fencingToken }, executeEnvelope as unknown as FailureEnvelope)).status, 200);
  const closedSecond = await db.run.findUniqueOrThrow({ where: { id: second.run.id } });
  assert.equal(closedSecond.maxRunsPerTask, 2);
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 2, "two sessions, two attempts, no third");

  await db.task.update({ where: { id: context.task.id }, data: { status: "TODO" } });
  const started = await start(context.task.id);
  assert.equal(started.status, 409);
  assert.equal(started.body.error, "Run budget exhausted", "the ceiling still closes when the agent is the one failing");
});

test("an unknown clone failure is refunded and retried even with a runner exception", async () => {
  const context = await seedTask("provision-deterministic", 2);
  const closed = await failProvisioning(context, 1, unreachableRemoteEnvelope as unknown as FailureEnvelope);
  // A runner exception and an unknown clone error are both plumbing facts;
  // neither is a deterministic access refusal, so the phase default refunds
  // this attempt and queues the same task for another run.
  assert.equal(closed.maxRunsPerTask, 3, "the pre-agent failure earns a refund");
  assert.equal(closed.budgetGrants, 1);
  assert.equal(closed.failureClass, "TRANSIENT_PROVIDER");
  assert.equal(closed.retryable, true);
  const retryRun = await db.run.findFirstOrThrow({ where: { taskId: context.task.id, runNumber: 2 } });
  assert.equal(retryRun.status, "QUEUED");
  assert.equal(retryRun.maxRunsPerTask, 3);
});

/** `PATCH /tasks/:id` — the route an operator uses to re-budget a task. */
const patchTask = async (taskId: string, body: unknown): Promise<number> => withTokens(async () =>
  (await createApp(db).request(`/tasks/${taskId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).status);

test("lowering a task's budget takes effect even though its runs carry the old ceiling", async () => {
  // Nothing external here: two ordinary EXECUTE failures, each leaving
  // `maxRunsPerTask: 5` on its row because that was the budget at the time.
  const context = await seedTask("budget-lowered", 5);
  for (const runNumber of [1, 2]) {
    const { run, runnerId, fencingToken } = await makeRunnable(context, runNumber);
    await completeRun(run.id, { runnerId, fencingToken }, executeEnvelope as unknown as FailureEnvelope);
  }
  const closed = await db.run.findFirstOrThrow({ where: { taskId: context.task.id, runNumber: 2 } });
  assert.equal(closed.maxRunsPerTask, 5, "the absolute ceiling of the moment it was written");
  assert.equal(closed.budgetGrants, 0, "and not one attempt of it was granted");

  await db.run.deleteMany({ where: { taskId: context.task.id, runNumber: { gt: 2 } } });
  assert.equal(await patchTask(context.task.id, { maxSessionsPerTask: 2 }), 200);
  await db.task.update({ where: { id: context.task.id }, data: { status: "TODO" } });

  // Reading the historical `maxRunsPerTask` as though it were a grant would
  // let this through on a budget the operator has just spent: 5 is the old
  // configured budget, not a refund, and nothing in that number says which.
  const started = await start(context.task.id);
  assert.equal(started.status, 409);
  assert.equal(started.body.error, "Run budget exhausted");
  // The operator-retry route answers the same, from the same ceiling.
  assert.equal((await retry(context.task.id)).status, 409);
});

test("a task refunded twice keeps both refunds across a budget change", async () => {
  const context = await seedTask("budget-edited-refunds", 2);
  await failProvisioning(context, 1);
  const second = await failProvisioning(context, 2);
  assert.equal(second.budgetGrants, 2, "two attempts that never reached an agent");
  await db.run.deleteMany({ where: { taskId: context.task.id, runNumber: 3 } });

  // Lowered to one session. Two runs exist, both refunded, so exactly one
  // attempt remains: 2 < 1 + 2.
  assert.equal(await patchTask(context.task.id, { maxSessionsPerTask: 1 }), 200);
  await db.task.update({ where: { id: context.task.id }, data: { status: "TODO" } });
  const started = await start(context.task.id);
  assert.equal(started.status, 201, "refunds are not forfeited by re-budgeting");
  const queued = await db.run.findFirstOrThrow({ where: { taskId: context.task.id, runNumber: started.body.runNumber } });
  assert.equal(queued.maxRunsPerTask, 3, "the new budget plus the grants already earned");
  assert.equal(queued.budgetGrants, 2);

  // That was the last one: three runs against a budget of one plus two grants.
  await db.run.update({ where: { id: queued.id }, data: { status: "FAILED", endedAt: new Date() } });
  await db.task.update({ where: { id: context.task.id }, data: { status: "TODO" } });
  assert.equal((await start(context.task.id)).status, 409);
});

test("raising a task's budget is honoured without waiting for a refund", async () => {
  const context = await seedTask("budget-raised", 1);
  const { run, runnerId, fencingToken } = await makeRunnable(context, 1);
  await completeRun(run.id, { runnerId, fencingToken }, executeEnvelope as unknown as FailureEnvelope);
  await db.run.deleteMany({ where: { taskId: context.task.id, runNumber: { gt: 1 } } });
  await db.task.update({ where: { id: context.task.id }, data: { status: "TODO" } });
  assert.equal((await start(context.task.id)).status, 409, "one session, one spent");

  assert.equal(await patchTask(context.task.id, { maxSessionsPerTask: 3 }), 200);
  await db.task.update({ where: { id: context.task.id }, data: { status: "TODO" } });
  const started = await start(context.task.id);
  assert.equal(started.status, 201);
  const queued = await db.run.findFirstOrThrow({ where: { taskId: context.task.id, runNumber: started.body.runNumber } });
  assert.equal(queued.maxRunsPerTask, 3);
  assert.equal(queued.budgetGrants, 0, "a raised budget is a bigger budget, not a grant");
});

for (const providerError of [
  "Selected model is at capacity. Please try a different model.",
  "This model is currently at capacity. Please try again.",
]) {
  test(`EXECUTE capacity refusal refunds and queues the delayed retry: ${providerError}`, async () => {
    const context = await seedTask("capacity-refund", 1);
    const { run, runnerId, fencingToken } = await makeRunnable(context, 1);
    const envelope: FailureEnvelope = {
      ...executeEnvelope, runnerClass: null, terminalEventSeen: true, terminalSuccess: false,
      providerError, stderrSummary: null,
    };
    const before = Date.now();
    const response = await completeRun(run.id, { runnerId, fencingToken }, envelope);
    const after = Date.now();
    assert.equal(response.status, 200, await response.text());
    const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(closed.failureClass, "TRANSIENT_PROVIDER");
    assert.equal(closed.budgetGrants, 1);
    assert.equal(closed.maxRunsPerTask, 2);
    const retry = await db.run.findFirstOrThrow({ where: { taskId: context.task.id, runNumber: 2 } });
    assert.equal(retry.status, "QUEUED");
    assert.equal(retry.budgetGrants, 1);
    assert.equal(retry.maxRunsPerTask, 2);
    const delay = retryDelayMs(1, "TRANSIENT_PROVIDER");
    assert.ok(retry.readyAt.getTime() >= before + delay);
    assert.ok(retry.readyAt.getTime() <= after + delay);
  });
}
