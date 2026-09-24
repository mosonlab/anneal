import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { DependencyProvisioning, PrismaClient, RunStatus, SessionExecutionStatus, TaskStatus } from "@anneal/db";

import { suspendForInbox } from "./inbox.js";
import type { ReleaseMergeLease } from "./merge-lease.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
import {
  acknowledgeCancellation as acknowledgeCancellationWithLease,
  cancelRun as cancelRunWithLease,
} from "./run-cancel.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "active-cancel-operator";
const RUNNER = "active-cancel-runner-token";
const RUNNER_ID = "active-cancel-runner";
const noOpReleaseMergeLease: ReleaseMergeLease = async () => {};
const cancelRun = (
  client: PrismaClient,
  runId: string,
  body: Parameters<typeof cancelRunWithLease>[2],
) => cancelRunWithLease(client, runId, body, noOpReleaseMergeLease);
const acknowledgeCancellation = (
  client: PrismaClient,
  runId: string,
  body: Parameters<typeof acknowledgeCancellationWithLease>[2],
) => acknowledgeCancellationWithLease(client, runId, body, noOpReleaseMergeLease);

const call = async (method: string, path: string, token: string, body?: unknown, client: PrismaClient = db) => {
  const priorOperator = process.env.OPERATOR_TOKEN;
  const priorRunner = process.env.RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  try {
    const response = await createApp(client).request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  } finally {
    if (priorOperator === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorOperator;
    if (priorRunner === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = priorRunner;
  }
};

let sequence = 0;
const seed = async (status: RunStatus, leaseExpiresAt = new Date(Date.now() + 600_000)) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Cancellation", slug: `cancel-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: `agent-${suffix}`, title: "Agent",
    model: "gpt-5.6-sol:high", runnerPreference: "CODEX", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://github.com/acme/repo.git",
    mountPath: "/repo", defaultBranch: "main", dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  const successor = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, name: "Successor", description: "must stay stopped",
    assigneeAgentId: agent.id, status: TaskStatus.TODO,
  } });
  const task = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, name: "Active", description: "cancel me",
    assigneeAgentId: agent.id, status: status === RunStatus.QUEUED ? TaskStatus.TODO : TaskStatus.DOING,
  } });
  const owned = status === RunStatus.QUEUED ? {} : {
    runnerId: RUNNER_ID,
    fencingToken: `fence-${suffix}`,
    leaseGeneration: 1,
    leaseExpiresAt,
    heartbeatAt: new Date(),
    claimedAt: new Date(),
  };
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: task.id, agentId: agent.id, repoId: repo.id,
    runNumber: 1, dedupeKey: `task:${task.id}:run:1`, status,
    runner: "CODEX", model: agent.model, promptHash: "hash", branch: `codex/cancel-${suffix}`,
    workspacePath: `/scratch/${suffix}`, ...owned,
  } });
  const session = status === RunStatus.QUEUED ? null : await db.session.create({ data: {
    runId: run.id, projectId: project.id, taskId: task.id, agentId: agent.id, runner: "CODEX",
    executionStatus: status === RunStatus.RUNNING
      ? SessionExecutionStatus.RUNNING
      : status === RunStatus.WAITING_INBOX ? SessionExecutionStatus.WAITING_INBOX : SessionExecutionStatus.PROVISIONING,
  } });
  return { project, task, successor, run, session };
};

const heartbeat = (runId: string, fencingToken: string) => call("POST", `/runner/runs/${runId}/heartbeat`, RUNNER, {
  runnerId: RUNNER_ID, fencingToken, leaseSeconds: 60, processAlive: true,
  lastProgressEventAt: null, inFlightTool: null,
});

test("every live provider status exposes one idempotent cancellation through heartbeat and acknowledgement", async () => {
  for (const status of [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING]) {
    const seeded = await seed(status);
    const requestId = `cancel-${status.toLowerCase()}`;
    const requested = await cancelRun(db, seeded.run.id, {
      requestId,
      reason: `stop ${status}`,
      parkTask: false,
    });
    assert.ok(!("message" in requested));
    assert.equal(requested.cancellationState, "requested");

    const duplicate = await cancelRun(db, seeded.run.id, {
      requestId,
      reason: "ignored duplicate wording",
      parkTask: false,
    });
    assert.ok(!("message" in duplicate));
    assert.equal(duplicate.requestId, requestId);
    const conflict = await cancelRun(db, seeded.run.id, {
      requestId: `${requestId}-other`,
      reason: "other",
      parkTask: false,
    });
    assert.ok("message" in conflict);
    assert.equal(conflict.reason, "conflict");

    const lateEvents = await call("POST", `/runner/runs/${seeded.run.id}/events`, RUNNER, {
      runnerId: RUNNER_ID,
      fencingToken: seeded.run.fencingToken,
      events: [{ seq: 0, source: "CLAUDE", type: "LATE", payload: { text: "must lose" } }],
    });
    assert.equal(lateEvents.status, 409);
    const lateActivity = await call("POST", `/runner/runs/${seeded.run.id}/activity`, RUNNER, {
      fencingToken: seeded.run.fencingToken,
      body: "late activity must lose",
    });
    assert.equal(lateActivity.status, 409);

    const observed = await heartbeat(seeded.run.id, seeded.run.fencingToken!);
    assert.equal(observed.status, 200);
    assert.equal(observed.body.cancellation.requestId, requestId);
    assert.equal(observed.body.cancellation.reason, `stop ${status}`);

    const acknowledged = await acknowledgeCancellation(db, seeded.run.id, {
      runnerId: RUNNER_ID, fencingToken: seeded.run.fencingToken!, requestId,
    });
    assert.ok(!("message" in acknowledged));
    assert.equal(acknowledged.status, RunStatus.CANCELLED);
    const acknowledgementReplay = await acknowledgeCancellation(db, seeded.run.id, {
      runnerId: RUNNER_ID, fencingToken: seeded.run.fencingToken!, requestId,
    });
    assert.ok(!("message" in acknowledgementReplay));

    const [run, task, successor, runs] = await Promise.all([
      db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      db.task.findUniqueOrThrow({ where: { id: seeded.task.id } }),
      db.task.findUniqueOrThrow({ where: { id: seeded.successor.id } }),
      db.run.count({ where: { taskId: seeded.task.id } }),
    ]);
    assert.equal(run.status, RunStatus.CANCELLED);
    assert.equal(run.workspacePath, seeded.run.workspacePath);
    assert.equal(run.workspaceRetained, true);
    assert.equal(run.worktreeContainmentViolations, null);
    assert.ok(run.cancelAcknowledgedAt);
    assert.equal(task.status, TaskStatus.REVIEW);
    assert.equal(successor.status, TaskStatus.TODO);
    assert.equal(runs, 1);

    const lateCompletion = await call("POST", `/runner/runs/${seeded.run.id}/complete`, RUNNER, {
      runnerId: RUNNER_ID, fencingToken: seeded.run.fencingToken, exitCode: 0,
      outcome: { case: "succeeded" }, pushStatus: "NOT_REQUESTED",
      cleanupStatus: "RETAINED", workspaceRetained: true,
    });
    assert.equal(lateCompletion.status, 409);
  }
});

test("mechanical merge Runs refuse cancellation before recording an intent", async () => {
  const seeded = await seed(RunStatus.RUNNING);
  const template = await db.taskTemplate.create({ data: {
    projectId: seeded.project.id,
    name: "direct-engineer-workflow",
    description: "mechanical tail",
    variables: [],
  } });
  const step = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    stepIndex: 7,
    layer: 7,
    name: "Merge execution",
    prompt: "merge",
    outputKind: "merge-result",
    assigneeType: "AGENT",
  } });
  await db.task.update({ where: { id: seeded.task.id }, data: { templateId: template.id, templateStepId: step.id } });

  const response = await cancelRun(db, seeded.run.id, {
    requestId: "cancel-mechanical",
    reason: "must be refused",
    parkTask: false,
  });
  assert.ok("message" in response);
  assert.match(response.message, /Mechanical merge Runs cannot be cancelled/u);
  const run = await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
  assert.equal(run.cancelRequestId, null);
  assert.equal(run.cancelRequestedAt, null);

  assert.equal((await call("POST", `/runs/${seeded.run.id}/cancel`, RUNNER, {
    requestId: "cancel-mechanical",
    reason: "runner lacks operator authority",
  })).status, 403);
  assert.equal((await call("POST", `/runs/${seeded.run.id}/cancel`, OPERATOR, {
    requestId: "cancel-mechanical",
    reason: "map module conflict",
  })).status, 409);

  await db.run.update({ where: { id: seeded.run.id }, data: {
    cancelRequestId: "legacy-mechanical-cancel",
    cancelReason: "persisted before upgrade",
    cancelRequestedAt: new Date(),
  } });
  const replay = await cancelRun(db, seeded.run.id, {
    requestId: "legacy-mechanical-cancel",
    reason: "same request replay",
    parkTask: false,
  });
  assert.ok(!("message" in replay));
  assert.equal(replay.cancellationState, "requested");
  const replayConflict = await cancelRun(db, seeded.run.id, {
    requestId: "different-mechanical-cancel",
    reason: "must conflict",
    parkTask: false,
  });
  assert.ok("message" in replayConflict);
  assert.equal(replayConflict.reason, "conflict");
});

test("cancellation acknowledgement persists a provisioning workspace before terminalizing", async () => {
  const seeded = await seed(RunStatus.PROVISIONING);
  await db.run.update({ where: { id: seeded.run.id }, data: { workspacePath: null, branch: null, baseSha: null } });
  const requestId = "cancel-with-workspace";
  const requested = await cancelRun(db, seeded.run.id, {
    requestId,
    reason: "retain provisioning evidence",
    parkTask: false,
  });
  assert.ok(!("message" in requested));
  const acknowledged = await acknowledgeCancellation(db, seeded.run.id, {
    runnerId: RUNNER_ID,
    fencingToken: seeded.run.fencingToken!,
    requestId,
    workspacePath: "/scratch/provisioning-evidence",
    branch: "codex/provisioning-evidence",
    baseSha: "a".repeat(40),
  });
  assert.ok(!("message" in acknowledged));
  const run = await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
  assert.equal(run.status, RunStatus.CANCELLED);
  assert.equal(run.workspacePath, "/scratch/provisioning-evidence");
  assert.equal(run.branch, "codex/provisioning-evidence");
  assert.equal(run.baseSha, "a".repeat(40));
});

test("start and cancellation acknowledgement serialize to one Run and Session outcome", { timeout: 20_000 }, async () => {
  const seeded = await seed(RunStatus.PROVISIONING);
  const startClient = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  let sessionWriteReached!: () => void;
  let releaseSessionWrite!: () => void;
  const reached = new Promise<void>((resolve) => { sessionWriteReached = resolve; });
  const release = new Promise<void>((resolve) => { releaseSessionWrite = resolve; });
  let intercepted = false;
  const startDb = new Proxy(startClient, { get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const instrumentedTx = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        if (txProperty !== "session") return Reflect.get(txTarget, txProperty, txReceiver);
        return new Proxy(txTarget.session, { get(sessionTarget, sessionProperty, sessionReceiver) {
          if (sessionProperty !== "updateMany") return Reflect.get(sessionTarget, sessionProperty, sessionReceiver);
          return async (...args: unknown[]) => {
            if (!intercepted) {
              intercepted = true;
              sessionWriteReached();
              await release;
            }
            return Reflect.apply(sessionTarget.updateMany, sessionTarget, args);
          };
        } });
      } });
      return operation(instrumentedTx);
    }, options as any);
  } }) as PrismaClient;
  const priorOperator = process.env.OPERATOR_TOKEN;
  const priorRunner = process.env.RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  try {
    const start = createApp(startDb).request(`/runner/runs/${seeded.run.id}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: RUNNER_ID,
        fencingToken: seeded.run.fencingToken,
        adapterVersion: "test",
        cliVersion: "test",
        promptHash: "a".repeat(64),
        manifest: {},
        workspacePath: "/scratch/start-cancel-race",
        runtimeHandle: "test:123",
      }),
    });
    await reached;
    let cancellationSettled = false;
    const cancellation = (async () => {
      const requested = await cancelRun(db, seeded.run.id, {
        requestId: "cancel-start-race",
        reason: "operator stop",
        parkTask: false,
      });
      assert.ok(!("message" in requested));
      const acknowledged = await acknowledgeCancellation(db, seeded.run.id, {
        runnerId: RUNNER_ID,
        fencingToken: seeded.run.fencingToken!,
        requestId: "cancel-start-race",
      });
      assert.ok(!("message" in acknowledged));
      cancellationSettled = true;
    })();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(cancellationSettled, false, "cancellation must wait for the atomic start transaction");
    releaseSessionWrite();
    const started = await start;
    assert.equal(started.status, 200, await started.text());
    await cancellation;
  } finally {
    if (priorOperator === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorOperator;
    if (priorRunner === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = priorRunner;
    await startClient.$disconnect();
  }
  const [run, session] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    db.session.findUniqueOrThrow({ where: { runId: seeded.run.id } }),
  ]);
  assert.equal(run.status, RunStatus.CANCELLED);
  assert.equal(session.executionStatus, SessionExecutionStatus.CANCELLED);
});

test("only an unclaimed QUEUED cancellation settles without runner acknowledgement", async () => {
  const queued = await seed(RunStatus.QUEUED);
  const queuedResponse = await cancelRun(db, queued.run.id, {
    requestId: "cancel-immediate-queued", reason: "operator stop", parkTask: false,
  });
  assert.ok(!("message" in queuedResponse));
  assert.equal(queuedResponse.cancellationState, "acknowledged");
  assert.equal("reason" in queuedResponse, false);
  assert.ok((await db.run.findUniqueOrThrow({ where: { id: queued.run.id } })).cancelAcknowledgedAt);

  const waiting = await seed(RunStatus.WAITING_INBOX);
  const requestId = "cancel-waiting-provider-cleanup";
  const waitingResponse = await cancelRun(db, waiting.run.id, {
    requestId, reason: "operator stop", parkTask: false,
  });
  assert.ok(!("message" in waitingResponse));
  assert.equal(waitingResponse.cancellationState, "requested");
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: waiting.run.id } })).status, RunStatus.WAITING_INBOX);
  const acknowledged = await acknowledgeCancellation(db, waiting.run.id, {
    runnerId: RUNNER_ID, fencingToken: waiting.run.fencingToken!, requestId,
  });
  assert.ok(!("message" in acknowledged));
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: waiting.run.id } })).status, RunStatus.CANCELLED);
});

test("stop-and-park records cancellation intent and keeps the Task in Backlog after acknowledgement", async () => {
  const seeded = await seed(RunStatus.RUNNING);
  const requestId = "cancel-and-park";
  const requested = await cancelRun(db, seeded.run.id, {
    requestId, reason: "pause implementation", parkTask: true,
  });
  assert.ok(!("message" in requested));
  assert.equal(requested.cancellationState, "requested");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.task.id } })).status, TaskStatus.BACKLOG);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.successor.id } })).status, TaskStatus.TODO);

  const acknowledged = await acknowledgeCancellation(db, seeded.run.id, {
    runnerId: RUNNER_ID, fencingToken: seeded.run.fencingToken!, requestId,
  });
  assert.ok(!("message" in acknowledged));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.task.id } })).status, TaskStatus.BACKLOG);
  assert.equal(await db.run.count({ where: { taskId: seeded.task.id, status: { in: [
    RunStatus.QUEUED, RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING, RunStatus.WAITING_INBOX,
  ] } } }), 0);
});

test("stop-and-park takes the full-chain mutex while a sibling row is locked", { timeout: 20_000 }, async () => {
  const seeded = await seed(RunStatus.RUNNING);
  const chainId = `cancel-chain-${Date.now()}`;
  await db.task.update({
    where: { id: seeded.task.id },
    data: { chainId, chainIndex: 0, chainLayer: 0 },
  });
  await db.task.update({
    where: { id: seeded.successor.id },
    data: { chainId, chainIndex: 1, chainLayer: 1 },
  });

  const blockerClient = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  const cancellationClient = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  let releaseSibling!: () => void;
  let siblingLocked!: () => void;
  let reportLockScope!: (fullChain: boolean) => void;
  const siblingLockHeld = new Promise<void>((resolve) => { siblingLocked = resolve; });
  const siblingMayProceed = new Promise<void>((resolve) => { releaseSibling = resolve; });
  const observedLockScope = new Promise<boolean>((resolve) => { reportLockScope = resolve; });
  let scopeReported = false;
  const instrumentedCancellationClient = new Proxy(cancellationClient, { get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const instrumentedTx = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
        return (...args: any[]) => {
          const query = (tx.$queryRaw as any)(...args);
          if (!scopeReported && (args[1] === seeded.task.id || args[2] === chainId)) {
            scopeReported = true;
            reportLockScope(args[2] === chainId);
          }
          return query;
        };
      } });
      return operation(instrumentedTx);
    }, options as any);
  } }) as PrismaClient;

  const blocker = blockerClient.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${seeded.successor.id} FOR UPDATE`;
    siblingLocked();
    await siblingMayProceed;
  });
  try {
    await siblingLockHeld;
    let cancellationSettled = false;
    const cancellation = cancelRun(instrumentedCancellationClient, seeded.run.id, {
      requestId: "cancel-chain-mutex",
      reason: "pause chained implementation",
      parkTask: true,
    }).finally(() => { cancellationSettled = true; });
    assert.equal(await observedLockScope, true);
    assert.equal(cancellationSettled, false);
    releaseSibling();
    const response = await cancellation;
    assert.ok(!("message" in response));
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.task.id } })).status, TaskStatus.BACKLOG);
  } finally {
    releaseSibling();
    await blocker;
    await Promise.all([blockerClient.$disconnect(), cancellationClient.$disconnect()]);
  }
});

test("lease reconciliation settles an unacknowledged cancellation without retrying", async () => {
  const now = new Date();
  const seeded = await seed(RunStatus.RUNNING, new Date(now.getTime() - 1_000));
  await db.run.update({ where: { id: seeded.run.id }, data: {
    cancelRequestId: "cancel-expired", cancelReason: "stop after runner loss", cancelRequestedAt: new Date(now.getTime() - 2_000),
  } });
  assert.equal(await reconcileDatabaseRuns(db, now), 1);
  const [run, count, successor] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    db.run.count({ where: { taskId: seeded.task.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.successor.id } }),
  ]);
  assert.equal(run.status, RunStatus.CANCELLED);
  assert.equal(run.cancelAcknowledgedAt, null);
  assert.equal(count, 1);
  assert.equal(successor.status, TaskStatus.TODO);
});

test("a late runner acknowledgement backfills workspace evidence after reconciliation", async () => {
  const now = new Date();
  const seeded = await seed(RunStatus.PROVISIONING, new Date(now.getTime() - 1_000));
  await db.run.update({ where: { id: seeded.run.id }, data: {
    cancelRequestId: "cancel-reconciled-first",
    cancelReason: "stop during provisioning",
    cancelRequestedAt: new Date(now.getTime() - 2_000),
    workspacePath: null,
    branch: null,
    baseSha: null,
  } });
  assert.equal(await reconcileDatabaseRuns(db, now), 1);
  const replay = await cancelRun(db, seeded.run.id, {
    requestId: "cancel-reconciled-first",
    reason: "replayed after runner loss",
    parkTask: false,
  });
  assert.ok(!("message" in replay));
  assert.equal(replay.cancellationState, "unconfirmed");
  const response = await acknowledgeCancellation(db, seeded.run.id, {
    runnerId: RUNNER_ID,
    fencingToken: seeded.run.fencingToken!,
    requestId: "cancel-reconciled-first",
    workspacePath: "/scratch/reconciled-first",
    branch: "codex/reconciled-first",
    baseSha: "b".repeat(40),
    worktreeContainmentViolations: ["/operator/worktrees/reconciled-first"],
  });
  assert.ok(!("message" in response));
  const run = await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
  assert.equal(run.status, RunStatus.CANCELLED);
  assert.ok(run.cancelAcknowledgedAt);
  assert.equal(run.workspacePath, "/scratch/reconciled-first");
  assert.equal(run.branch, "codex/reconciled-first");
  assert.equal(run.baseSha, "b".repeat(40));
  assert.deepEqual(run.worktreeContainmentViolations, ["/operator/worktrees/reconciled-first"]);

  const conflicting = await acknowledgeCancellation(db, seeded.run.id, {
    runnerId: RUNNER_ID,
    fencingToken: seeded.run.fencingToken!,
    requestId: "cancel-reconciled-first",
    workspacePath: "/scratch/must-not-overwrite",
    branch: "codex/must-not-overwrite",
    baseSha: "c".repeat(40),
    worktreeContainmentViolations: ["/operator/worktrees/must-not-overwrite"],
  });
  assert.ok(!("message" in conflicting));
  const preserved = await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
  assert.equal(preserved.workspacePath, "/scratch/reconciled-first");
  assert.equal(preserved.branch, "codex/reconciled-first");
  assert.equal(preserved.baseSha, "b".repeat(40));
  assert.deepEqual(preserved.worktreeContainmentViolations, ["/operator/worktrees/reconciled-first"]);
});

test("cancellation acknowledgement persists containment evidence without changing cancellation", async () => {
  const seeded = await seed(RunStatus.RUNNING);
  const requestId = "cancel-with-containment";
  const requested = await cancelRun(db, seeded.run.id, {
    requestId, reason: "stop after worktree escape", parkTask: false,
  });
  assert.ok(!("message" in requested));
  const violations = ["/operator/worktrees/one", "/operator/worktrees/two"];
  const acknowledged = await acknowledgeCancellation(db, seeded.run.id, {
    runnerId: RUNNER_ID,
    fencingToken: seeded.run.fencingToken!,
    requestId,
    worktreeContainmentViolations: violations,
  });
  assert.ok(!("message" in acknowledged));
  assert.equal(acknowledged.status, RunStatus.CANCELLED);
  const run = await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
  assert.equal(run.status, RunStatus.CANCELLED);
  assert.deepEqual(run.worktreeContainmentViolations, violations);
});

test("reconciliation re-reads cancellation after its stale candidate snapshot", { timeout: 20_000 }, async () => {
  const now = new Date();
  const seeded = await seed(RunStatus.RUNNING, new Date(now.getTime() - 1_000));
  await db.run.update({ where: { id: seeded.run.id }, data: {
    heartbeatAt: new Date(now.getTime() - 20 * 60_000),
    stallTimeoutMin: 1,
  } });
  const reconcileClient = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  let snapshotRead!: () => void;
  let releaseSnapshot!: () => void;
  const reached = new Promise<void>((resolve) => { snapshotRead = resolve; });
  const release = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  let intercepted = false;
  const reconcileDb = new Proxy(reconcileClient, { get(target, property, receiver) {
    if (property !== "run") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return new Proxy(target.run, { get(runTarget, runProperty, runReceiver) {
      if (runProperty !== "findMany") return Reflect.get(runTarget, runProperty, runReceiver);
      return async (...args: unknown[]) => {
        const rows = await Reflect.apply(runTarget.findMany, runTarget, args);
        const query = args[0] as { where?: { status?: unknown } } | undefined;
        if (!intercepted && typeof query?.where?.status === "object") {
          intercepted = true;
          snapshotRead();
          await release;
        }
        return rows;
      };
    } });
  } }) as PrismaClient;
  try {
    const reconciliation = reconcileDatabaseRuns(reconcileDb, now);
    await reached;
    const cancellation = await cancelRun(db, seeded.run.id, {
      requestId: "cancel-after-snapshot",
      reason: "operator stop",
      parkTask: false,
    });
    assert.ok(!("message" in cancellation));
    assert.equal(cancellation.cancellationState, "requested");
    releaseSnapshot();
    assert.equal(await reconciliation, 1);
  } finally {
    await reconcileClient.$disconnect();
  }
  const [run, runCount] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    db.run.count({ where: { taskId: seeded.task.id } }),
  ]);
  assert.equal(run.status, RunStatus.CANCELLED);
  assert.equal(run.cancelRequestId, "cancel-after-snapshot");
  assert.equal(runCount, 1);
});

test("a cancellation intent fences out a late Inbox suspension", async () => {
  const seeded = await seed(RunStatus.RUNNING);
  await db.session.update({
    where: { id: seeded.session!.id },
    data: { providerConversationId: "conversation-before-cancel" },
  });
  const requested = await cancelRun(db, seeded.run.id, {
    requestId: "cancel-before-inbox", reason: "stop before question", parkTask: false,
  });
  assert.ok(!("message" in requested));
  assert.equal(requested.cancellationState, "requested");
  await assert.rejects(
    suspendForInbox(db, {
      runId: seeded.run.id,
      fencingToken: seeded.run.fencingToken!,
      requestId: "late-question",
      body: "This must not be delivered",
      choices: [],
      chatId: "chat-after-cancel",
    }),
    /Run is not resumable/u,
  );
  assert.equal(await db.inboxMessage.count({ where: { sessionId: seeded.session!.id } }), 0);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).status, RunStatus.RUNNING);
});

test("a completion that commits first remains authoritative", async () => {
  const seeded = await seed(RunStatus.RUNNING);
  const completed = await call("POST", `/runner/runs/${seeded.run.id}/complete`, RUNNER, {
    runnerId: RUNNER_ID, fencingToken: seeded.run.fencingToken, exitCode: 1,
    outcome: {
      case: "provider-failure",
      reason: "finished first",
      envelope: {
        version: 1, phase: "EXECUTE", runnerClass: "TASK_FAILED", exitCode: 1, signal: null,
        terminationReason: null, terminalEventSeen: true, terminalSuccess: false, agentExited: true,
        providerError: null, stderrSummary: "finished first", stdoutSummary: null,
        timedOut: false, transient: false, timeoutMs: null,
      },
    },
    pushStatus: "NOT_REQUESTED", cleanupStatus: "RETAINED", workspaceRetained: true,
  });
  assert.equal(completed.status, 200);
  const cancellation = await cancelRun(db, seeded.run.id, {
    requestId: "cancel-too-late", reason: "too late", parkTask: false,
  });
  assert.ok(!("message" in cancellation));
  assert.equal(cancellation.cancellationState, "terminal");
  const run = await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(run.cancelRequestId, null);
});
