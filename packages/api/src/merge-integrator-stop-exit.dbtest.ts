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
  latestRecordedStop,
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
  commitWithLeaseOutcome,
  type MergeLeaseAcquirer,
  type MergeLeaseReleaser,
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";
import { settleFailedIntegratorRun } from "./merge-integrator-failure-exit.js";
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
let releasePause: (() => Promise<void>) | null = null;
const releasedLeaseTargets: MergeLeaseTarget[] = [];

before(() => { db = setupTestDb(); });
beforeEach(async () => {
  releasedLeaseTargets.length = 0;
  releasePause = null;
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
  await releasePause?.();
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
  await replayTick();
  assert.equal(resumed.duplicate, false);
  const runs = await integratorRuns(seeded);
  assert.equal(runs.length, 2, "resume opens exactly one integrator Run");
  await assertHandoff(runs[1]!.id);
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
  await replayTick();
  assert.equal(again.duplicate, true);
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

  const completed = await completeIntegratorRun(claimed, await executorFailureOutcome(true));
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, false);

  assert.equal((await integratorRuns(claimed)).length, 2, "release completes before replacement birth");
  await replayTick();
  const runs = await integratorRuns(claimed);
  await assertHandoff(runs[2]!.id);
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
    metadata: { path: ["state"], equals: "external-failure-pending" },
  } }), 1);

  const handoff = await db.mergeLeaseEvent.findUniqueOrThrow({ where: { id: claimed.handoffId } });
  assert.equal(handoff.state, MergeLeaseEventState.RELEASED);
  assert.ok(handoff.settledAt);
  assert.ok(await db.taskActivity.findFirst({ where: {
    taskId: claimed.integratorTask!.id,
    body: `Chain Lease released after Run ${claimed.queuedRunId} ended without merging`,
  } }));
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

  const completed = await completeIntegratorRun(claimed, await executorFailureOutcome(false));
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

const replayTick = async (base = BASE_2, lease: WithMergeLease = leased) =>
  baseDriftRecoveryTick(db, reader(snapshot(base)), new Date(), 5, lease);
const assertHandoff = async (runId: string) => {
  const event = await db.mergeLeaseEvent.findFirstOrThrow({ where: { handedOffRunId: runId } });
  assert.equal(event.state, MergeLeaseEventState.HANDOFF_PENDING);
};
const externalOutcome = {
  case: "provider-failure", reason: "transport failed",
  envelope: { version: 1, phase: "EXECUTE", agentExited: false, transient: true, exitCode: null },
};

test("Lease contention preserves pending replay without a claimable Run", async () => {
  const seeded = await recoveredChain("replay-contention");
  await holdAtReadinessLayer(seeded);
  await authorizeThroughReadiness(BASE_2);
  await resume(seeded, "resume");
  await replayTick(BASE_2, async () => ({ outcome: "contended" }));
  assert.equal((await integratorRuns(seeded)).length, 1);
  assert.equal((await call("POST", "/runner/tasks/claim", { runnerId: EXECUTOR_RUNNER_ID, contractVersion: RUN_COMPLETION_CONTRACT_VERSION }, EXECUTOR)).status, 204);
  assert.ok((await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: seeded.aggregateId } })).pendingAuthorizationId);
  await replayTick();
  const runs = await integratorRuns(seeded);
  assert.equal(runs.length, 2);
  await assertHandoff(runs[1]!.id);
});

test("admission repaired after release replays once on a later Resume", async () => {
  const seeded = await recoveredChain("replay-admission");
  await holdAtReadinessLayer(seeded);
  await authorizeThroughReadiness(BASE_2);
  const grant = await db.agentRepoAccess.findFirstOrThrow({ where: { agentId: seeded.integratorAgent.id, repoId: seeded.repo.id } });
  await db.agentRepoAccess.delete({ where: { agentId_repoId: { agentId: grant.agentId, repoId: grant.repoId } } });
  await resume(seeded, "resume-refused");
  await replayTick();
  assert.equal((await integratorRuns(seeded)).length, 1);
  await db.agentRepoAccess.create({ data: grant });
  await resume(seeded, "resume-repaired");
  await replayTick();
  await replayTick();
  const runs = await integratorRuns(seeded);
  assert.equal(runs.length, 2);
  await assertHandoff(runs[1]!.id);
});

test("external failure under Hold keeps the exit pending until Resume", async () => {
  const claimed = await recoveredAndQueued("failure-held");
  await holdAtReadinessLayer(claimed);
  assert.equal((await completeIntegratorRun(claimed, externalOutcome)).status, 200);
  await replayTick();
  assert.equal((await integratorRuns(claimed)).length, 2);
  assert.equal(await stopQuestion(claimed), null);
  await resume(claimed, "resume-failure");
  await replayTick();
  await replayTick();
  const runs = await integratorRuns(claimed);
  assert.equal(runs.length, 3);
  await assertHandoff(runs[2]!.id);
  assert.equal(await stopQuestion(claimed), null);
});

test("a moved base enters fresh recovery without a stale integrator birth", async () => {
  const claimed = await recoveredAndQueued("failure-base-moved");
  assert.equal((await completeIntegratorRun(claimed, externalOutcome)).status, 200);
  await replayTick("d".repeat(40));
  assert.equal((await integratorRuns(claimed)).length, 2);
  const next = await db.mergeRecoveryAttempt.findFirstOrThrow({ where: { integratorTaskId: claimed.integratorTask!.id }, orderBy: { attempt: "desc" } });
  assert.equal(next.status, "REPAIRING");
  assert.equal(next.currentBaseSha, "d".repeat(40));
  assert.ok(next.recoveryRunId);
  assert.notEqual(next.id, claimed.aggregateId);
});

test("recovery allowance includes prior attempts on other stops", async () => {
  const claimed = await recoveredAndQueued("failure-ceiling");
  const aggregate = await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: claimed.aggregateId } });
  await db.mergeRecoveryAttempt.create({ data: {
    integratorTaskId: aggregate.integratorTaskId, sourceStopId: "another-stop", attempt: 2,
    repository: aggregate.repository, prNumber: aggregate.prNumber, targetBranch: aggregate.targetBranch,
    recoveryRunId: "prior-recovery-run", status: "SUCCEEDED",
  } });
  assert.equal((await completeIntegratorRun(claimed, externalOutcome)).status, 200);
  await replayTick();
  assert.equal((await integratorRuns(claimed)).length, 2);
  assert.ok(await stopQuestion(claimed));
});

/** Exercise the installed executor client serializer, not a hand-built envelope. */
const executorFailureOutcome = async (external: boolean): Promise<unknown> => {
  const moduleUrl = new URL("../../merge-executor/src/agentos.ts", import.meta.url);
  const { makeAgentOsClient } = await import(moduleUrl.href);
  let outcome: unknown;
  const client = makeAgentOsClient({
    apiUrl: "http://anneal.test", executorToken: EXECUTOR, runnerId: EXECUTOR_RUNNER_ID, apiTimeoutMs: 1000,
  }, async (_url: unknown, init: RequestInit) => {
    outcome = JSON.parse(String(init.body)).outcome;
    return new Response(null, { status: 204 });
  });
  await client.complete({ run: { id: "wire-test" }, fencingToken: "fence", sessionToken: "session" },
    { succeeded: false, outcome: null, external, failureReason: external ? "installation-token-request-failed" : "installation-token-http-error (HTTP 403)" }, String);
  return outcome;
};

test("ordinary mechanical retry transfers its one pending handoff without releasing", async () => {
  const claimed = await recoveredAndQueued("ordinary-mechanical-retry");
  await db.taskActivity.deleteMany({ where: {
    taskId: claimed.integratorTask!.id, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.result },
  } });
  await db.mergeRecoveryAttempt.deleteMany({ where: { integratorTaskId: claimed.integratorTask!.id } });
  releasedLeaseTargets.length = 0;
  const completed = await completeIntegratorRun(claimed, await executorFailureOutcome(true));
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.retryCreated, true);
  const runs = await integratorRuns(claimed);
  assert.equal(runs.length, 3);
  const events = await db.mergeLeaseEvent.findMany({ where: { chainId: claimed.chainId, state: "HANDOFF_PENDING" } });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.handedOffRunId, runs[2]!.id);
  assert.deepEqual(releasedLeaseTargets, []);
});

test("a non-canonical integrator's existing question is not opened again", async () => {
  const seeded = await seedIntegratorChain(db, { label: "noncanonical-failure", shape: "twelve-step-readiness" });
  const authorization = await authorize(seeded.readinessTask!.id, BASE);
  const source = await mechanicalBaseDriftStop(seeded, authorization.id);
  const question = await stopQuestion(seeded);
  assert.ok(question);
  const stop = await db.$transaction((tx) => latestRecordedStop(tx, seeded.integratorTask!.id));
  assert.ok(stop);
  await db.mergeRecoveryAttempt.create({ data: {
    integratorTaskId: seeded.integratorTask!.id, sourceStopId: stop.stopId,
    attempt: 1, revalidations: 1, status: "SUCCEEDED",
  } });
  const result = await db.$transaction((tx) => settleFailedIntegratorRun(tx, {
    integratorTaskId: seeded.integratorTask!.id, runId: source.id, external: false,
    failureReason: "forbidden", now: new Date(),
  }));
  assert.deepEqual(result, { kind: "none" });
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.integratorTask!.id, kind: "MULTIPLE_CHOICE" } }), 1);
});

test("a pending replay waits for the old completion release to settle", async () => {
  const claimed = await recoveredAndQueued("release-before-replay");
  let finishRelease!: () => void;
  let enteredRelease!: () => void;
  const entered = new Promise<void>((resolve) => { enteredRelease = resolve; });
  const finish = new Promise<void>((resolve) => { finishRelease = resolve; });
  releasePause = async () => { enteredRelease(); await finish; };
  const completion = completeIntegratorRun(claimed, externalOutcome);
  try {
    await entered;
    await replayTick();
    assert.equal((await integratorRuns(claimed)).length, 2);
    assert.equal((await db.mergeLeaseEvent.findUniqueOrThrow({ where: { id: claimed.handoffId } })).state, "HANDOFF_PENDING");
  } finally {
    finishRelease();
    releasePause = null;
  }
  assert.equal((await completion).status, 200);
  await Promise.all([replayTick(), replayTick()]);
  const runs = await integratorRuns(claimed);
  assert.equal(runs.length, 3);
  await assertHandoff(runs[2]!.id);
});


test("a failed completion release remains retryable by the deferred-release reconciler", async () => {
  const claimed = await recoveredAndQueued("release-transport-outage");
  releasePause = async () => { throw new Error("origin unavailable"); };
  try {
    assert.equal((await completeIntegratorRun(claimed, externalOutcome)).status, 500);
  } finally {
    releasePause = null;
  }
  const deferred = await db.mergeLeaseEvent.findFirstOrThrow({ where: { chainId: claimed.chainId, state: "RELEASE_DEFERRED" } });
  await replayTick();
  assert.equal((await integratorRuns(claimed)).length, 2);
  await commitWithLeaseOutcome(db, async () => ({ value: null, leaseOutcome: {
    kind: "stop", taskId: claimed.integratorTask!.id,
    deferredRelease: { eventId: deferred.id, target: { projectId: claimed.project.id, chainId: claimed.chainId }, at: new Date() },
  } }), { release: releaseChainLease });
  assert.equal((await db.mergeLeaseEvent.findUniqueOrThrow({ where: { id: deferred.id } })).state, "RELEASED");
  await replayTick();
  const runs = await integratorRuns(claimed);
  assert.equal(runs.length, 3);
  await assertHandoff(runs[2]!.id);
});
