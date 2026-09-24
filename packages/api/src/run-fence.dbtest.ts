import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { DependencyProvisioning, PrismaClient, RunStatus, SessionExecutionStatus, TaskStatus } from "@anneal/db";

import { createApp } from "./test-app.js";
import { publishRun, startRun } from "./run-lifecycle.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "run-fence-operator";
const RUNNER = "run-fence-runner-token";
const RUNNER_ID = "run-fence-runner";

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const priorOperator = process.env.OPERATOR_TOKEN;
  const priorRunner = process.env.RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  try {
    const response = await createApp(db).request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null) as { error?: string; reason?: string } | null,
    };
  } finally {
    if (priorOperator === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorOperator;
    if (priorRunner === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = priorRunner;
  }
};

let sequence = 0;
const seed = async (overrides: {
  status?: RunStatus;
  leaseExpiresAt?: Date | null;
  cancelRequestedAt?: Date | null;
  runnerId?: string;
} = {}) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Fence", slug: `fence-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: `agent-${suffix}`, title: "Agent",
    model: "gpt-5.6-sol:high", runnerPreference: "CODEX", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://github.com/acme/repo.git",
    mountPath: "/repo", defaultBranch: "main", dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  const task = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, name: "Fenced", description: "fenced work",
    assigneeAgentId: agent.id, status: TaskStatus.DOING,
  } });
  const status = overrides.status ?? RunStatus.RUNNING;
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: task.id, agentId: agent.id, repoId: repo.id,
    runNumber: 1, dedupeKey: `task:${task.id}:run:1`, status,
    runner: "CODEX", model: agent.model, promptHash: "hash", branch: `codex/fence-${suffix}`,
    workspacePath: `/scratch/${suffix}`,
    runnerId: overrides.runnerId ?? RUNNER_ID,
    fencingToken: `fence-${suffix}`,
    leaseGeneration: 1,
    leaseExpiresAt: overrides.leaseExpiresAt === undefined ? new Date(Date.now() + 600_000) : overrides.leaseExpiresAt,
    cancelRequestedAt: overrides.cancelRequestedAt ?? null,
    ...(overrides.cancelRequestedAt ? { cancelRequestId: `cancel-${suffix}`, cancelReason: "stop" } : {}),
    heartbeatAt: new Date(),
    claimedAt: new Date(),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: project.id, taskId: task.id, agentId: agent.id, runner: "CODEX",
    executionStatus: SessionExecutionStatus.RUNNING,
  } });
  return { project, task, run };
};

/** The route with the fewest preconditions, so the refusal under test is the
 *  only reason the request can fail. */
const heartbeat = (runId: string, fencingToken: string, runnerId = RUNNER_ID) => call(
  "POST",
  `/runner/runs/${runId}/heartbeat`,
  RUNNER,
  { runnerId, fencingToken, leaseSeconds: 60, processAlive: true, lastProgressEventAt: null, inFlightTool: null },
);

test("a run nobody has heard of is unknown-run, not a stale fence", async () => {
  const refused = await heartbeat("run-that-never-existed", "fence-anything");
  assert.equal(refused.status, 409);
  assert.equal(refused.body?.error, "Stale fencing token");
  assert.equal(refused.body?.reason, "unknown-run");
});

test("a second runner on someone else's run is wrong-runner", async () => {
  const seeded = await seed({ runnerId: "a-different-runner" });
  const refused = await heartbeat(seeded.run.id, seeded.run.fencingToken!);
  assert.equal(refused.status, 409);
  assert.equal(refused.body?.reason, "wrong-runner");
});

test("a superseded fencing token is stale-fence", async () => {
  const seeded = await seed();
  const refused = await heartbeat(seeded.run.id, "fence-from-a-previous-generation");
  assert.equal(refused.status, 409);
  assert.equal(refused.body?.reason, "stale-fence");
});

test("an already-requested cancellation is cancel-requested, not a stale fence", async () => {
  // The heartbeat's own cancellation branch answers 200 while the request is
  // deliverable; this is the run whose cancellation has no deliverable body,
  // which used to be indistinguishable from a lost lease.
  const seeded = await seed({ cancelRequestedAt: new Date() });
  await db.run.update({ where: { id: seeded.run.id }, data: { cancelRequestId: null, cancelReason: null } });
  const refused = await heartbeat(seeded.run.id, seeded.run.fencingToken!);
  assert.equal(refused.status, 409);
  assert.equal(refused.body?.reason, "cancel-requested");
});

test("a lease that ran out is lease-expired, which is the stall an operator has to see", async () => {
  const seeded = await seed({ leaseExpiresAt: new Date(Date.now() - 60_000) });
  const refused = await heartbeat(seeded.run.id, seeded.run.fencingToken!);
  assert.equal(refused.status, 409);
  assert.equal(refused.body?.reason, "lease-expired");
});

test("a run that already ended is not-active", async () => {
  const seeded = await seed({ status: RunStatus.SUCCEEDED });
  const refused = await heartbeat(seeded.run.id, seeded.run.fencingToken!);
  assert.equal(refused.status, 409);
  assert.equal(refused.body?.reason, "not-active");
});

test("a run that has already started refuses a second start as not-active", async () => {
  // `/start`'s fence is narrower than the live-lease set, and the refusal is
  // explained against the same narrowed set rather than the general one.
  const seeded = await seed({ status: RunStatus.RUNNING });
  const refused = await call("POST", `/runner/runs/${seeded.run.id}/start`, RUNNER, {
    runnerId: RUNNER_ID,
    fencingToken: seeded.run.fencingToken,
    adapterVersion: "1",
    cliVersion: "1",
    promptHash: "a".repeat(64),
    manifest: {},
    workspacePath: "/scratch/started",
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body?.error, "Stale fencing token");
  assert.equal(refused.body?.reason, "not-active");
});

test("replacement start and late salvage publication complete without a Run-Task deadlock", { timeout: 20_000 }, async () => {
  const seeded = await seed({ status: RunStatus.LOST, leaseExpiresAt: null });
  const replacementRunner = "replacement-runner";
  const replacementFence = `replacement-${seeded.run.id}`;
  const originalBase = "main";
  const replacement = await db.run.create({ data: {
    projectId: seeded.project.id,
    taskId: seeded.task.id,
    agentId: seeded.task.assigneeAgentId!,
    repoId: seeded.task.repoId,
    runNumber: 2,
    dedupeKey: `task:${seeded.task.id}:run:2`,
    status: RunStatus.CLAIMED,
    runner: "CODEX",
    model: "gpt-5.6-sol:high",
    promptHash: "b".repeat(64),
    targetBranch: originalBase,
    runnerId: replacementRunner,
    fencingToken: replacementFence,
    leaseGeneration: 2,
    leaseExpiresAt: new Date(Date.now() + 600_000),
    claimedAt: new Date(),
  } });
  await db.session.create({ data: {
    runId: replacement.id,
    projectId: seeded.project.id,
    taskId: seeded.task.id,
    agentId: seeded.task.assigneeAgentId!,
    runner: "CODEX",
    executionStatus: SessionExecutionStatus.PROVISIONING,
  } });

  const startClient = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const publishClient = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let reportStartLocked!: () => void;
  let releaseStart!: () => void;
  let reportTaskLocked!: () => void;
  let reportRepairUpdate!: () => void;
  const startLocked = new Promise<void>((resolve) => { reportStartLocked = resolve; });
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const taskLocked = new Promise<void>((resolve) => { reportTaskLocked = resolve; });
  const repairUpdate = new Promise<void>((resolve) => { reportRepairUpdate = resolve; });

  const startDb = {
    $transaction: (operation: (tx: unknown) => Promise<unknown>) => startClient.$transaction(async (tx) => {
      const instrumented = new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.$queryRaw, target, args);
            const query = args[0] as string[] | { strings?: string[] } | undefined;
            const sql = Array.isArray(query) ? query.join(" ") : query?.strings?.join(" ") ?? "";
            if (sql.includes('FROM "Run"') && args[1] === replacement.id) {
              reportStartLocked();
              await startGate;
            }
            return result;
          };
        },
      });
      return operation(instrumented);
    }),
  } as unknown as PrismaClient;
  const publishDb = {
    $transaction: (operation: (tx: unknown) => Promise<unknown>) => publishClient.$transaction(async (tx) => {
      const instrumented = new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "$queryRaw") {
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(target.$queryRaw, target, args);
              const query = args[0] as string[] | { strings?: string[] } | undefined;
              const sql = Array.isArray(query) ? query.join(" ") : query?.strings?.join(" ") ?? "";
              if (sql.includes('FROM "Task"') && args[1] === seeded.task.id) reportTaskLocked();
              return result;
            };
          }
          if (property === "run") {
            return new Proxy(target.run, {
              get(runTarget, runProperty, runReceiver) {
                if (runProperty !== "updateMany") return Reflect.get(runTarget, runProperty, runReceiver);
                return (...args: unknown[]) => {
                  const update = args[0] as { where?: { id?: string } } | undefined;
                  if (update?.where?.id === replacement.id) reportRepairUpdate();
                  return Reflect.apply(runTarget.updateMany, runTarget, args);
                };
              },
            });
          }
          return Reflect.get(target, property, receiver);
        },
      });
      return operation(instrumented);
    }),
  } as unknown as PrismaClient;

  const startedBranch = "replacement/original-base";
  const salvage = `agentos/${seeded.task.id}/run-1`;
  let starting: Promise<unknown> | undefined;
  let publishing: Promise<unknown> | undefined;
  try {
    starting = startRun(startDb, {
      runId: replacement.id,
      body: {
        runnerId: replacementRunner,
        fencingToken: replacementFence,
        adapterVersion: "test-adapter",
        cliVersion: "test-cli",
        promptHash: "b".repeat(64),
        manifest: {},
        workspacePath: `/scratch/${replacement.id}`,
        branch: startedBranch,
      },
    });
    await startLocked;
    publishing = publishRun(publishDb, {
      runId: seeded.run.id,
      body: { runnerId: RUNNER_ID, fencingToken: seeded.run.fencingToken!, pushedBranch: salvage },
    });
    await taskLocked;
    await repairUpdate;
    releaseStart();

    const [startResult, publishResult] = await Promise.all([starting, publishing]);
    assert.deepEqual(startResult, { ok: true });
    assert.deepEqual(publishResult, {
      reason: "conflict",
      message: "Salvage is durable, but the replacement already started from its prior base",
    });
  } finally {
    releaseStart();
    await Promise.allSettled([starting, publishing].filter((pending): pending is Promise<unknown> => pending !== undefined));
    await Promise.all([startClient.$disconnect(), publishClient.$disconnect()]);
  }

  const published = await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
  const started = await db.run.findUniqueOrThrow({ where: { id: replacement.id } });
  assert.equal(published.pushedBranch, salvage);
  assert.equal(started.status, RunStatus.RUNNING);
  assert.equal(started.targetBranch, originalBase);
  assert.equal(started.branch, startedBranch);
  assert.equal(await db.run.count({ where: { taskId: seeded.task.id } }), 2);
});

test("every fenced route on one expired run names the same cause", async () => {
  // The defect: `/events` and `/activity` used to evaluate `new Date()` where
  // the query was built while their siblings used the instant captured at route
  // entry, so one request's two predicates could disagree about this lease.
  const seeded = await seed({ leaseExpiresAt: new Date(Date.now() - 60_000) });
  const events = await call("POST", `/runner/runs/${seeded.run.id}/events`, RUNNER, {
    runnerId: RUNNER_ID,
    fencingToken: seeded.run.fencingToken,
    events: [{ seq: 0, source: "CLAUDE", type: "LATE", payload: { text: "after the lease" } }],
  });
  assert.equal(events.status, 409);
  assert.equal(events.body?.reason, "lease-expired");
  const activity = await call("POST", `/runner/runs/${seeded.run.id}/activity`, RUNNER, {
    fencingToken: seeded.run.fencingToken,
    body: "after the lease",
  });
  assert.equal(activity.status, 409);
  assert.equal(activity.body?.reason, "lease-expired");
});
