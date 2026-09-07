/**
 * A deferred `base-drift` stop always has an exit after recovery.
 *
 * A canonical integrator step defers its `base-drift` question to the recovery
 * worker, so while that stop stands there is nothing for an operator to answer
 * and `POST /tasks/:id/retry` and `/start` both refuse. The one intent that may
 * open a Run past it is raised once, at authorization time. These tests cover
 * the two shapes that spent it and left the chain with no exit: a Hold that
 * refused the Run birth the authorization paid for, and an integrator Run that
 * opened and then failed.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  AUTHORIZED_MERGE_METHOD,
  ChainControlState,
  MERGE_INTEGRATOR_KIND,
  MergeLeaseEventState,
  Prisma,
  PrismaClient,
  RunStatus,
  TaskStatus,
  authorizationMetadata,
  recordIntegratorStop,
  resumeChain,
  stopQuestionKey,
} from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";

import { baseDriftRecoveryTick } from "./merge-base-drift-worker.js";
import { executorsOnline } from "./merge-executor-daemon-fixture.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import type { MergeLeaseTarget } from "./merge-lease-hold.js";
import {
  withMergeLease,
  type MergeLeaseAcquirer,
  type MergeLeaseReleaser,
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";
import { readinessTick } from "./merge-readiness-worker.js";
import type { PullRequestReader, PullRequestSnapshot } from "./github-read.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const BASE_2 = "c".repeat(40);
const OPERATOR = "integrator-stop-exit-operator";
const RUNNER = "integrator-stop-exit-runner";
const EXECUTOR = "integrator-stop-exit-executor";
const EXECUTOR_RUNNER_ID = "merge-executor-1";

let db: PrismaClient;
const releasedLeaseTargets: MergeLeaseTarget[] = [];

before(() => { db = setupTestDb(); });
beforeEach(async () => {
  releasedLeaseTargets.length = 0;
  await resetTestDb(db);
});
after(async () => { await db.$disconnect(); });

const snapshot = (baseSha: string): PullRequestSnapshot => ({
  repository: "acme/widgets",
  number: 123,
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRefName: "master",
  baseSha,
  headRefOid: HEAD,
  headCommitOid: HEAD,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  repositoryMergeQueue: null,
  mergedBy: null,
  mergeCommit: null,
  requiredCheckNames: [],
  checkContexts: [],
  readAt: new Date("2026-09-07T01:00:00.000Z").toISOString(),
});

const reader = (current: PullRequestSnapshot): PullRequestReader => ({
  readPullRequest: async () => current,
  compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
});

const acquireChainLease: MergeLeaseAcquirer = async () => ({ outcome: "acquired" });
const releaseLeaseAdapter: MergeLeaseReleaser = async () => ({ outcome: "not-held" });
const releaseChainLease: ReleaseMergeLease = async (target) => {
  if (target) releasedLeaseTargets.push(target);
};
const leased: WithMergeLease = async (target, fn, leaseDb) => withMergeLease(target, fn, leaseDb, {
  acquire: acquireChainLease,
  release: releaseLeaseAdapter,
});

const call = async (
  method: string,
  path: string,
  body?: unknown,
  token = OPERATOR,
): Promise<{ status: number; body: any }> => {
  const prior = [
    ["OPERATOR_TOKEN", process.env.OPERATOR_TOKEN],
    ["RUNNER_TOKEN", process.env.RUNNER_TOKEN],
    ["MERGE_EXECUTOR_TOKEN", process.env.MERGE_EXECUTOR_TOKEN],
    ["MERGE_EXECUTOR_RUNNER_IDS", process.env.MERGE_EXECUTOR_RUNNER_IDS],
  ] as const;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  process.env.MERGE_EXECUTOR_TOKEN = EXECUTOR;
  process.env.MERGE_EXECUTOR_RUNNER_IDS = EXECUTOR_RUNNER_ID;
  try {
    const response = await createApp(db, { releaseMergeLease: releaseChainLease }).request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

/** The mechanical authorization the readiness step wrote before the first run. */
const authorize = async (readinessTaskId: string, baseSha: string) => {
  const binding = `mechanical:${readinessTaskId}:${randomUUID()}`;
  const activity = await db.taskActivity.create({ data: {
    taskId: readinessTaskId,
    actorType: "control-plane",
    body: `authorized ${baseSha}`,
    metadata: authorizationMetadata({
      schemaVersion: 1,
      nonce: randomUUID(),
      repository: "acme/widgets",
      prNumber: 123,
      headSha: HEAD,
      baseRef: "master",
      baseSha,
      mergeMethod: AUTHORIZED_MERGE_METHOD,
      requiredChecks: [],
      readAt: new Date().toISOString(),
      issuedAt: new Date().toISOString(),
      decision: { channel: "mechanical", inboxDecisionId: binding, inboxMessageId: binding },
    }) as Prisma.InputJsonObject,
  } });
  await db.taskStepOutput.upsert({
    where: { taskId: readinessTaskId },
    create: {
      taskId: readinessTaskId,
      kind: "merge-authorization",
      body: JSON.stringify({ authorizationActivityId: activity.id, headSha: HEAD }),
      commitSha: HEAD,
    },
    update: {
      kind: "merge-authorization",
      body: JSON.stringify({ authorizationActivityId: activity.id, headSha: HEAD }),
      commitSha: HEAD,
    },
  });
  return activity;
};

type Seeded = Awaited<ReturnType<typeof seedIntegratorChain>>;

/** The first mechanical run, ending in the `base-drift` stop that defers its question. */
const mechanicalBaseDriftStop = async (seeded: Seeded, authorizationActivityId: string) => {
  const run = await db.run.create({ data: {
    projectId: seeded.project.id,
    taskId: seeded.integratorTask!.id,
    agentId: seeded.integratorAgent.id,
    repoId: seeded.repo.id,
    runNumber: 1,
    dedupeKey: `task:${seeded.integratorTask!.id}:run:1`,
    runner: "CLAUDE",
    model: "mechanical/merge-executor-v1",
    promptHash: "mechanical",
    status: RunStatus.SUCCEEDED,
    opensPullRequest: false,
    maxRunsPerTask: 5,
    targetBranch: "master",
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: seeded.project.id,
    taskId: seeded.integratorTask!.id,
    agentId: seeded.integratorAgent.id,
    runner: "CLAUDE",
    executionStatus: "SUCCEEDED",
  } });
  await db.taskActivity.create({ data: {
    taskId: seeded.integratorTask!.id,
    actorType: "merge-executor",
    body: "intent",
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.intent,
      schemaVersion: 1,
      sourceRunId: run.id,
      idempotencyKey: `123:${HEAD}:${authorizationActivityId}`,
      prNumber: 123,
      headSha: HEAD,
      authorizationActivityId,
    },
  } });
  const evidence = JSON.stringify({ observed: BASE_2, authorized: BASE });
  const outputBody = JSON.stringify({ outcome: "stopped", condition: "base-drift", evidence });
  await db.taskStepOutput.upsert({
    where: { taskId: seeded.integratorTask!.id },
    create: { taskId: seeded.integratorTask!.id, runId: run.id, kind: "merge-result", body: outputBody },
    update: { runId: run.id, kind: "merge-result", body: outputBody },
  });
  await db.$transaction((tx) => recordIntegratorStop(tx, {
    integratorTaskId: seeded.integratorTask!.id,
    condition: "base-drift",
    evidence,
    sourceRunId: run.id,
  }));
  return run;
};

/** The verified Regression the recovery's fresh run produced against the new base. */
const recordRecoveryPass = async (seeded: Seeded, baseSha: string) => {
  const run = await db.run.findFirstOrThrow({
    where: { taskId: seeded.gateTask.id },
    orderBy: { runNumber: "desc" },
  });
  await db.run.update({ where: { id: run.id }, data: { status: RunStatus.SUCCEEDED, headSha: HEAD } });
  const body = JSON.stringify({
    schemaVersion: 1,
    outcome: "pass",
    headSha: HEAD,
    baseHeadSha: baseSha,
    gateVerdict: "PASS",
  });
  await db.taskStepOutput.upsert({
    where: { taskId: seeded.gateTask.id },
    create: { taskId: seeded.gateTask.id, runId: run.id, kind: "regression-verification", body, commitSha: HEAD },
    update: { runId: run.id, kind: "regression-verification", body, commitSha: HEAD },
  });
  await db.task.update({ where: { id: seeded.gateTask.id }, data: { status: TaskStatus.DONE } });
};

/**
 * A chain stopped on `base-drift`, whose automatic recovery has produced a
 * fresh verified Regression and is waiting for readiness to authorize it.
 */
const recoveredChain = async (label: string) => {
  const seeded = await seedIntegratorChain(db, { label, shape: "canonical-compound-readiness" });
  const authorization = await authorize(seeded.readinessTask!.id, BASE);
  const sourceRun = await mechanicalBaseDriftStop(seeded, authorization.id);
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  await recordRecoveryPass(seeded, BASE_2);
  const aggregate = await db.mergeRecoveryAttempt.findFirstOrThrow({
    where: { integratorTaskId: seeded.integratorTask!.id },
  });
  assert.equal(aggregate.status, "REPAIRING");
  return { ...seeded, authorization, sourceRun, aggregateId: aggregate.id };
};

/** Hold the Chain so that the integrator's layer, and only it, is refused. */
const holdAtReadinessLayer = async (seeded: Seeded) => {
  const rows = await db.task.findMany({
    where: { projectId: seeded.project.id, chainId: seeded.chainId },
    select: { chainLayer: true, chainIndex: true },
  });
  // The stored operator ordinal Hold records: distinct execution layers, dense
  // and one-based, in ascending order.
  const layers = [...new Set(rows.map((row) => row.chainLayer ?? row.chainIndex))]
    .filter((layer): layer is number => layer !== null)
    .sort((left, right) => left - right);
  const heldExecutionLayer = seeded.readinessStep!.layer!;
  const heldLayer = layers.indexOf(heldExecutionLayer) + 1;
  assert.ok(heldLayer > 0, "readiness layer has no dense ordinal");
  await db.chainControl.create({ data: {
    projectId: seeded.project.id,
    chainId: seeded.chainId,
    state: ChainControlState.HELD,
    heldLayer,
    heldExecutionLayer,
    heldAt: new Date(),
    holdRequestId: "hold-integrator-layer",
    holdReason: "inspect the merge before it runs",
    holdGeneration: 1,
  } });
};

const resume = async (seeded: Seeded, requestId: string) => {
  const result = await db.$transaction((tx) => resumeChain(tx, {
    projectId: seeded.project.id,
    chainId: seeded.chainId,
    taskId: seeded.integratorTask!.id,
    requestId,
  }, new Date()));
  if ("message" in result) assert.fail(result.message);
  return result;
};

const authorizeThroughReadiness = async (baseSha: string) => readinessTick(
  db,
  reader(snapshot(baseSha)),
  new Date(),
  5,
  releaseChainLease,
  leased,
  executorsOnline,
);

const integratorRuns = async (seeded: Seeded) => db.run.findMany({
  where: { taskId: seeded.integratorTask!.id },
  orderBy: { runNumber: "asc" },
  select: { id: true, runNumber: true, status: true },
});

const stopQuestion = async (seeded: Seeded) => db.inboxMessage.findFirst({
  where: { taskId: seeded.integratorTask!.id, kind: "MULTIPLE_CHOICE" },
  orderBy: { createdAt: "desc" },
});

test("an authorization that lands on a held Chain is replayed by resume, exactly once", async () => {
  const seeded = await recoveredChain("held-recovery-authorization");
  await holdAtReadinessLayer(seeded);

  // Readiness authorizes; the Hold refuses the Run birth the authorization pays
  // for. The tail is not stopped by that, and the recovery is not finished.
  assert.deepEqual(
    await authorizeThroughReadiness(BASE_2),
    { claimed: 1, authorized: 1, requeued: 0, stopped: 0 },
  );
  assert.equal((await integratorRuns(seeded)).length, 1);
  const withheld = await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: seeded.aggregateId } });
  assert.equal(withheld.status, "AWAITING_AUTHORIZATION");
  assert.ok(withheld.pendingAuthorizationId, "the held authorization is recorded on the aggregate");
  assert.equal(await db.mergeLeaseEvent.count({ where: { chainId: seeded.chainId } }), 0);

  const resumed = await resume(seeded, "resume-1");
  assert.equal(resumed.duplicate, false);
  assert.ok(resumed.replayedIntegratorRunId);
  const runs = await integratorRuns(seeded);
  assert.equal(runs.length, 2, "resume opens exactly one integrator Run");
  assert.equal(runs[1]!.id, resumed.replayedIntegratorRunId);
  assert.equal(runs[1]!.status, RunStatus.QUEUED);
  const replayed = await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: seeded.aggregateId } });
  assert.equal(replayed.status, "SUCCEEDED", "the aggregate leaves repair only once the Run is born");
  assert.equal(replayed.pendingAuthorizationId, null);
  assert.equal(replayed.authorizationActivityId, withheld.pendingAuthorizationId);
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: seeded.integratorTask!.id } })).status,
    TaskStatus.TODO,
  );
  assert.equal(await db.taskActivity.count({ where: {
    taskId: seeded.integratorTask!.id,
    metadata: { path: ["state"], equals: "authorization-replayed" },
  } }), 1);

  // A second resume finds a released control and a spent intent, and opens
  // nothing: the replay is owned by the aggregate, once.
  const again = await resume(seeded, "resume-2");
  assert.equal(again.duplicate, true);
  assert.equal(again.replayedIntegratorRunId, undefined);
  assert.equal((await integratorRuns(seeded)).length, 2);
});

/** Carry a recovery all the way to a queued integrator Run holding the Lease. */
const recoveredAndQueued = async (label: string) => {
  const seeded = await recoveredChain(label);
  assert.deepEqual(
    await authorizeThroughReadiness(BASE_2),
    { claimed: 1, authorized: 1, requeued: 0, stopped: 0 },
  );
  const runs = await integratorRuns(seeded);
  assert.equal(runs.length, 2);
  const queued = runs[1]!;
  assert.equal(queued.status, RunStatus.QUEUED);
  const handoff = await db.mergeLeaseEvent.findFirstOrThrow({ where: { handedOffRunId: queued.id } });
  assert.equal(handoff.state, MergeLeaseEventState.HANDOFF_PENDING);
  const claimed = await call("POST", "/runner/tasks/claim", {
    runnerId: EXECUTOR_RUNNER_ID,
    contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
  }, EXECUTOR);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.run.id, queued.id);
  return { ...seeded, queuedRunId: queued.id, fencingToken: claimed.body.fencingToken as string, handoffId: handoff.id };
};

const completeIntegratorRun = async (
  claimed: Awaited<ReturnType<typeof recoveredAndQueued>>,
  outcome: unknown,
) => call("POST", `/runner/runs/${claimed.queuedRunId}/complete`, {
  runnerId: EXECUTOR_RUNNER_ID,
  fencingToken: claimed.fencingToken,
  exitCode: 1,
  outcome,
  pushStatus: "NOT_REQUESTED",
  cleanupStatus: "SUCCEEDED",
  workspaceRetained: false,
}, EXECUTOR);

test("a transport failure after recovery re-queues the integrator and releases the Lease it was handed", async () => {
  const claimed = await recoveredAndQueued("integrator-transport-failure");

  const completed = await completeIntegratorRun(claimed, {
    case: "provider-failure",
    reason: "GitHub App installation-token mint failed: transport",
    envelope: {
      version: 1,
      phase: "EXECUTE",
      agentExited: false,
      transient: true,
      exitCode: null,
    },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, false);

  const runs = await integratorRuns(claimed);
  assert.equal(runs.length, 3, "the failed Run is followed by one automatic re-queue");
  assert.equal(runs[2]!.status, RunStatus.QUEUED);
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: claimed.integratorTask!.id } })).status,
    TaskStatus.TODO,
  );
  // No operator input was needed, and none was asked for.
  assert.equal(await stopQuestion(claimed), null);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: claimed.integratorTask!.id,
    metadata: { path: ["state"], equals: "requeued-external-failure" },
  } }), 1);

  const handoff = await db.mergeLeaseEvent.findUniqueOrThrow({ where: { id: claimed.handoffId } });
  assert.equal(handoff.state, MergeLeaseEventState.RELEASED);
  assert.ok(handoff.settledAt);
  assert.deepEqual(
    releasedLeaseTargets.at(-1),
    { projectId: claimed.project.id, chainId: claimed.chainId },
  );
});

test("a deterministic refusal after recovery opens the question the canonical stop deferred", async () => {
  const claimed = await recoveredAndQueued("integrator-deterministic-refusal");
  const stopId = (await db.taskActivity.findFirstOrThrow({
    where: {
      taskId: claimed.integratorTask!.id,
      metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.result },
    },
    orderBy: { createdAt: "desc" },
  })).id;
  assert.equal(await stopQuestion(claimed), null, "the base-drift question is deferred, not open");

  const completed = await completeIntegratorRun(claimed, {
    case: "required-output-unsatisfied",
    reason: "the merge API refused: forbidden",
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const runs = await integratorRuns(claimed);
  assert.equal(runs.length, 2, "a deterministic refusal stops instead of re-queueing");
  const question = await stopQuestion(claimed);
  assert.ok(question, "the deferred base-drift question is opened");
  assert.equal(question.dedupeKey, stopQuestionKey(stopId, 0));
  assert.equal(question.status, "OPEN");
  assert.equal(await db.taskActivity.count({ where: {
    taskId: claimed.integratorTask!.id,
    metadata: { path: ["state"], equals: "question-opened" },
  } }), 1);

  const handoff = await db.mergeLeaseEvent.findUniqueOrThrow({ where: { id: claimed.handoffId } });
  assert.equal(handoff.state, MergeLeaseEventState.RELEASED);
});
