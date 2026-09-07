/**
 * §4.0, §D-P5, §D-P7 and §D-P8 — the control plane's half of the contract.
 *
 * What these tests are really about is exclusivity. A stop is not a status; it
 * is a state the chain cannot leave except through an answer with a terminal
 * disposition, and the interesting cases are the ones where an answer exists
 * and the chain still must not move.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  applyInboxDecisionTx,
  EVIDENCE_PLACEHOLDER_BODY,
  enqueueTaskRun,
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  MergeLeaseEventState,
  MERGE_TAIL_KIND,
  parseAuthorizationMetadata,
  parseStopAnswerMetadata,
  Prisma,
  PrismaClient,
  TaskStatus,
} from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";

import { type PullRequestSnapshot } from "./github-read.js";
import { evidenceTick } from "./merge-evidence-worker.js";
import { baseDriftRecoveryTick } from "./merge-base-drift-worker.js";
import { seedIntegratorChain, type IntegratorChain } from "./merge-integrator-fixture.js";
import { recordMergeLeaseHold } from "./merge-lease-hold.js";
import { createRunnerRegistry } from "./runners.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
const releasedChainLeases: string[] = [];
const releasedLeaseTargets: Array<{ chainId: string; projectId: string }> = [];
beforeEach(async () => {
  releasedChainLeases.length = 0;
  releasedLeaseTargets.length = 0;
  await resetTestDb(db);
});
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-stop-state";
const RUNNER = "runner-stop-state";
/** §D-P1 rule 3: completing a mechanical run needs the executor's own bearer,
 *  not the fleet-wide runner token. See merge-integrator-forgery.dbtest.ts. */
const EXECUTOR = "merge-executor-token-stop-state";
const CONFIRMED_RELEASED_AT = new Date("2026-08-27T12:01:02.999Z");
const CONFIRMED_RELEASE = {
  outcome: "released" as const,
  ref: "refs/merge-lease/holder",
  sha: "merge-consumer-lease",
  acquiredAt: "2026-08-27T12:00:00.250Z",
};

const freshSnapshot = (): PullRequestSnapshot => ({
  repository: "acme/widgets", number: 123, state: "OPEN", isDraft: false, merged: false,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "master", baseSha: "b".repeat(40),
  headRefOid: "a".repeat(40), headCommitOid: "a".repeat(40), autoMergeRequest: null, mergeQueueEntry: null,
  repositoryMergeQueue: null, mergedBy: null, mergeCommit: null, requiredCheckNames: ["ci/build"],
  checkContexts: [{ __typename: "CheckRun", name: "ci/build", status: "COMPLETED", conclusion: "SUCCESS" }],
  readAt: new Date("2026-08-22T00:00:00.000Z").toISOString(),
});

const call = async (method: string, path: string, body?: unknown, token = OPERATOR): Promise<{ status: number; body: any }> => {
  const prior = [
    ["OPERATOR_TOKEN", process.env.OPERATOR_TOKEN],
    ["RUNNER_TOKEN", process.env.RUNNER_TOKEN],
    ["MERGE_EXECUTOR_TOKEN", process.env.MERGE_EXECUTOR_TOKEN],
    ["MERGE_EXECUTOR_RUNNER_IDS", process.env.MERGE_EXECUTOR_RUNNER_IDS],
  ] as const;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  process.env.MERGE_EXECUTOR_TOKEN = EXECUTOR;
  process.env.MERGE_EXECUTOR_RUNNER_IDS = "merge-executor-1";
  try {
    // These stop/renewal scenarios assume an available executor, including
    // PATCH approval's liveness check before it preserves the authorization.
    const runnerRegistry = createRunnerRegistry();
    runnerRegistry.note("merge-executor-1", {}, new Date());
    const response = await createApp(db, {
      runnerRegistry,
      releaseMergeLease: async (target) => {
        if (target) {
          releasedChainLeases.push(target.chainId);
          releasedLeaseTargets.push(target);
          await recordMergeLeaseHold(db, target, CONFIRMED_RELEASE, CONFIRMED_RELEASED_AT);
        }
      },
    }).request(path, {
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

/** A live merge-execution run the merge executor would be holding. */
const liveIntegratorRun = async (chain: IntegratorChain, runNumber = 1, maxRuns = 5) => {
  const run = await db.run.create({ data: {
    projectId: chain.project.id, taskId: chain.integratorTask!.id, agentId: chain.integratorAgent.id,
    repoId: chain.repo.id, runNumber, dedupeKey: `task:${chain.integratorTask!.id}:run:${runNumber}`,
    runner: "CLAUDE", model: "mechanical/merge-executor-v1", promptHash: "mechanical", status: "RUNNING",
    opensPullRequest: false, runnerId: "merge-executor-1", maxRunsPerTask: maxRuns,
    fencingToken: `1:${chain.integratorTask!.id}:${runNumber}`, leaseExpiresAt: new Date(Date.now() + 600_000),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: chain.project.id, agentId: chain.integratorAgent.id,
    taskId: chain.integratorTask!.id, runner: "CLAUDE", executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: chain.integratorTask!.id }, data: { status: "DOING" } });
  return run;
};

const completeRun = async (run: { id: string; fencingToken: string | null }, overrides: Record<string, unknown> = {}) =>
  call("POST", `/runner/runs/${run.id}/complete`, {
    runnerId: "merge-executor-1", fencingToken: run.fencingToken, exitCode: 0,
    outcome: { case: "succeeded" }, cleanupStatus: "SUCCEEDED", ...overrides,
  }, EXECUTOR);

/** What the executor writes before it completes: the fenced merge-result output. */
const persistOutcome = async (taskId: string, runId: string, body: string) => {
  await db.taskStepOutput.upsert({
    where: { taskId }, create: { taskId, runId, kind: "merge-result", body }, update: { runId, body },
  });
};

const stopQuestionFor = async (taskId: string) =>
  db.inboxMessage.findFirst({ where: { taskId, status: "OPEN", kind: "MULTIPLE_CHOICE" }, orderBy: { createdAt: "desc" } });

const stoppedChain = async (
  label: string,
  condition = "head-drift",
  shape: "twelve-step" | "twelve-step-readiness" | "legacy-seven-step-direct" = "twelve-step",
  runNumber = 1,
  maxRuns = 5,
  gatedReadiness = false,
) => {
  const chain = await seedIntegratorChain(db, { label, shape, gatedReadiness });
  if (gatedReadiness && chain.readinessTask) {
    await db.task.update({
      where: { id: chain.readinessTask.id },
      data: { status: TaskStatus.DONE },
    });
  }
  const run = await liveIntegratorRun(chain, runNumber, maxRuns);
  await persistOutcome(chain.integratorTask!.id, run.id, JSON.stringify({
    outcome: "stopped", condition, evidence: "authorized head a…, live head c…",
  }));
  assert.equal((await completeRun(run)).status, 200);
  return { chain, run };
};

const claimIntegratorRun = async (chain: IntegratorChain) => {
  const queued = await db.$transaction((tx) => enqueueTaskRun(tx, chain.integratorTask!.id));
  const claimed = await call("POST", "/runner/tasks/claim", {
    runnerId: "merge-executor-1",
    contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
  }, EXECUTOR);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.run.id, queued.id);
  assert.equal(claimed.body.executionMode, "mechanical");
  return {
    runId: queued.id,
    sessionToken: claimed.body.sessionToken as string,
    fencingToken: claimed.body.fencingToken as string,
  };
};

const POST_MERGE_STOP = JSON.stringify({
  outcome: "stopped",
  condition: "base-drift-post-merge",
  evidence: "merge commit 8bfa2f08 landed; post-merge parent verification failed",
});

const failedProtocolCompletion = (fencingToken: string) => ({
  runnerId: "merge-executor-1",
  fencingToken,
  exitCode: 1,
  signal: null,
  outcome: {
    case: "required-output-unsatisfied",
    reason: "merge completion transport failed",
  },
  pushStatus: "NOT_REQUESTED",
  cleanupStatus: "SUCCEEDED",
  workspaceRetained: false,
});

test("a SESSION stop and definitive output outrank a later failed completion envelope", async () => {
  const chain = await seedIntegratorChain(db, { label: "session-stop-precedence" });
  const claimed = await claimIntegratorRun(chain);

  const output = await call("PUT", `/session/runs/${claimed.runId}/output`, {
    fencingToken: claimed.fencingToken,
    kind: "merge-result",
    body: POST_MERGE_STOP,
  }, claimed.sessionToken);
  assert.equal(output.status, 200, JSON.stringify(output.body));

  const resultActivity = await call("POST", `/session/runs/${claimed.runId}/activity`, {
    fencingToken: claimed.fencingToken,
    actorType: "session",
    actorId: "merge-executor-1",
    body: "Mechanical merge stopped after commit 8bfa2f08 landed",
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.result,
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      outcome: "stopped",
      condition: "base-drift-post-merge",
      evidence: "merge commit 8bfa2f08 landed; post-merge parent verification failed",
    },
  }, claimed.sessionToken);
  assert.equal(resultActivity.status, 201, JSON.stringify(resultActivity.body));

  const completionBody = failedProtocolCompletion(claimed.fencingToken);
  const completion = await call(
    "POST",
    `/runner/runs/${claimed.runId}/complete`,
    completionBody,
    EXECUTOR,
  );
  assert.equal(completion.status, 200, JSON.stringify(completion.body));
  assert.deepEqual(completion.body, {
    taskId: chain.integratorTask!.id,
    succeeded: true,
    retryCreated: false,
    failureClass: null,
  });

  const settledRun = await db.run.findUniqueOrThrow({
    where: { id: claimed.runId },
    include: { session: { select: { id: true } } },
  });
  assert.equal(settledRun.status, "SUCCEEDED");
  assert.equal(settledRun.failureClass, null);
  assert.equal(settledRun.failureReason, "merge completion transport failed");
  assert.equal(settledRun.failureEnvelope, null, "a required-output-unsatisfied outcome carries no envelope");
  assert.equal(settledRun.retryable, false);
  assert.equal(settledRun.retryAt, null);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);

  const task = await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } });
  assert.equal(task.status, "REVIEW");
  assert.equal(task.failureReason, "Mechanical merge stopped: base-drift-post-merge");
  const cards = await db.inboxMessage.findMany({
    where: { taskId: task.id, kind: "MULTIPLE_CHOICE" },
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.dedupeKey, `merge-stop:${resultActivity.body.id}`);
  assert.equal(cards[0]!.agentId, settledRun.agentId);
  assert.equal(cards[0]!.sessionId, settledRun.session!.id);
  assert.deepEqual((cards[0]!.choices as Array<{ id: string }>).map((choice) => choice.id), ["accept", "revert"]);
  assert.equal(await db.inboxMessage.count({ where: { taskId: task.id, kind: "TEXT" } }), 0);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: task.id,
    metadata: { path: ["sourceRunId"], equals: claimed.runId },
  } }), 1, "completion adopted the SESSION result instead of recording a duplicate stop");

  const replay = await call(
    "POST",
    `/runner/runs/${claimed.runId}/complete`,
    completionBody,
    EXECUTOR,
  );
  assert.equal(replay.status, 409);
  assert.equal(await db.inboxMessage.count({ where: { dedupeKey: `merge-stop:${resultActivity.body.id}` } }), 1);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: task.id,
    metadata: { path: ["sourceRunId"], equals: claimed.runId },
  } }), 1);

  const retry = await call("POST", `/tasks/${task.id}/retry`);
  assert.equal(retry.status, 409);
  const accepted = await call("POST", `/inbox/messages/${cards[0]!.id}/decision`, {
    decision: "accept",
    requestId: "accept-post-merge-stop",
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  const done = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(done.status, "DONE");
  assert.equal(done.failureReason, null);
});

test("an ordinary base-drift activity cannot expose a RUNNING source Run to recovery", async () => {
  const chain = await seedIntegratorChain(db, { label: "active-base-drift-deferral" });
  const claimed = await claimIntegratorRun(chain);
  const evidence = JSON.stringify({ observed: "c".repeat(40), authorized: "b".repeat(40) });
  const output = await call("PUT", `/session/runs/${claimed.runId}/output`, {
    fencingToken: claimed.fencingToken,
    kind: "merge-result",
    body: JSON.stringify({ outcome: "stopped", condition: "base-drift", evidence }),
  }, claimed.sessionToken);
  assert.equal(output.status, 200, JSON.stringify(output.body));

  const activity = await call("POST", `/session/runs/${claimed.runId}/activity`, {
    fencingToken: claimed.fencingToken,
    actorType: "session",
    actorId: "merge-executor-1",
    body: "Mechanical merge stopped: base-drift",
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.result,
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      outcome: "stopped",
      condition: "base-drift",
      evidence,
    },
  }, claimed.sessionToken);
  assert.equal(activity.status, 201, JSON.stringify(activity.body));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "DOING");

  assert.deepEqual(await baseDriftRecoveryTick(db, {
    readPullRequest: async () => { throw new Error("unexpected GitHub read"); },
  }), {
    examined: 0,
    recovered: 0,
    exhausted: 0,
    ineligible: 0,
  });
  assert.equal(await db.mergeRecoveryAttempt.count({ where: { integratorTaskId: chain.integratorTask!.id } }), 0);
  assert.equal(await db.inboxMessage.count({ where: { taskId: chain.integratorTask!.id } }), 0);
});

test("a valid merge-result owned by another Run cannot override failed completion", async () => {
  const chain = await seedIntegratorChain(db, { label: "foreign-output-no-precedence" });
  const claimed = await claimIntegratorRun(chain);
  const foreignChain = await seedIntegratorChain(db, { label: "foreign-output-owner" });
  const foreignRun = await liveIntegratorRun(foreignChain);
  await db.taskStepOutput.upsert({
    where: { taskId: chain.integratorTask!.id },
    create: {
      taskId: chain.integratorTask!.id,
      runId: foreignRun.id,
      kind: "merge-result",
      body: JSON.stringify({ outcome: "merged", mergeCommitSha: "a".repeat(40) }),
    },
    update: {
      runId: foreignRun.id,
      kind: "merge-result",
      body: JSON.stringify({ outcome: "merged", mergeCommitSha: "a".repeat(40) }),
    },
  });

  const completion = await call(
    "POST",
    `/runner/runs/${claimed.runId}/complete`,
    failedProtocolCompletion(claimed.fencingToken),
    EXECUTOR,
  );
  assert.equal(completion.status, 200, JSON.stringify(completion.body));
  assert.deepEqual(completion.body, {
    taskId: chain.integratorTask!.id,
    succeeded: false,
    retryCreated: true,
    failureClass: "PROTOCOL_ERROR",
  });
  const failedRun = await db.run.findUniqueOrThrow({ where: { id: claimed.runId } });
  assert.equal(failedRun.status, "FAILED");
  assert.equal(failedRun.failureClass, "PROTOCOL_ERROR");
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 2);
  assert.equal(await db.inboxMessage.count({ where: { taskId: chain.integratorTask!.id } }), 0);
});

test("completion creates and lands one stop when output committed but result activity did not", async () => {
  const chain = await seedIntegratorChain(db, { label: "output-only-stop-precedence" });
  const claimed = await claimIntegratorRun(chain);
  const output = await call("PUT", `/session/runs/${claimed.runId}/output`, {
    fencingToken: claimed.fencingToken,
    kind: "merge-result",
    body: POST_MERGE_STOP,
  }, claimed.sessionToken);
  assert.equal(output.status, 200, JSON.stringify(output.body));

  const completion = await call(
    "POST",
    `/runner/runs/${claimed.runId}/complete`,
    failedProtocolCompletion(claimed.fencingToken),
    EXECUTOR,
  );
  assert.equal(completion.status, 200, JSON.stringify(completion.body));
  assert.equal(completion.body.succeeded, true);
  assert.equal(completion.body.retryCreated, false);

  const results = await db.taskActivity.findMany({ where: {
    taskId: chain.integratorTask!.id,
    metadata: { path: ["sourceRunId"], equals: claimed.runId },
  } });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.actorType, "control-plane");
  assert.equal((results[0]!.metadata as any).condition, "base-drift-post-merge");
  assert.equal(await db.inboxMessage.count({ where: {
    dedupeKey: `merge-stop:${results[0]!.id}`,
    kind: "MULTIPLE_CHOICE",
    status: "OPEN",
  } }), 1);
});

test("a stopped output without string evidence cannot override a failed completion", async () => {
  const chain = await seedIntegratorChain(db, { label: "malformed-stop-no-precedence" });
  const claimed = await claimIntegratorRun(chain);
  const output = await call("PUT", `/session/runs/${claimed.runId}/output`, {
    fencingToken: claimed.fencingToken,
    kind: "merge-result",
    body: JSON.stringify({ outcome: "stopped", condition: "base-drift-post-merge" }),
  }, claimed.sessionToken);
  assert.equal(output.status, 200, JSON.stringify(output.body));

  const completion = await call(
    "POST",
    `/runner/runs/${claimed.runId}/complete`,
    failedProtocolCompletion(claimed.fencingToken),
    EXECUTOR,
  );
  assert.equal(completion.status, 200, JSON.stringify(completion.body));
  assert.deepEqual(completion.body, {
    taskId: chain.integratorTask!.id,
    succeeded: false,
    retryCreated: true,
    failureClass: "PROTOCOL_ERROR",
  });
  const failedRun = await db.run.findUniqueOrThrow({ where: { id: claimed.runId } });
  assert.equal(failedRun.status, "FAILED");
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 2);
  assert.equal(await db.inboxMessage.count({ where: { taskId: chain.integratorTask!.id } }), 0);
});

test("a failed mechanical completion keeps the existing lease across its retry", async () => {
  const chain = await seedIntegratorChain(db, { label: "completion-retry-hold", shape: "twelve-step" });
  const run = await liveIntegratorRun(chain, 1, 3);
  const completed = await completeRun(run, {
    exitCode: 1,
    outcome: {
      case: "provider-failure",
      reason: "provider disconnected",
      envelope: {
        version: 1, phase: "EXECUTE", runnerClass: "TRANSIENT_PROVIDER", exitCode: 1, signal: null,
        terminationReason: null, terminalEventSeen: false, terminalSuccess: false, agentExited: false,
        providerError: null, stderrSummary: "provider disconnected", stdoutSummary: null,
        timedOut: false, transient: true, timeoutMs: null,
      },
    },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.retryCreated, true);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 2);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: chain.integratorTask!.id,
    metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHandoff },
  } }), 1);
  const retry = await db.run.findFirstOrThrow({
    where: { taskId: chain.integratorTask!.id, runNumber: 2 },
  });
  const handoff = await db.mergeLeaseEvent.findFirstOrThrow({
    where: { chainId: chain.chainId, state: MergeLeaseEventState.HANDOFF_PENDING },
  });
  assert.equal(handoff.handedOffRunId, retry.id);
  assert.deepEqual(releasedChainLeases, []);
  assert.deepEqual(releasedLeaseTargets, []);
});

test("N16 a recorded stop lands the stop state: run SUCCEEDED, task REVIEW, question open, no chain advance", async () => {
  const { chain, run } = await stoppedChain("n16");
  // Protocol-level success: the executor executed its contract exactly. The
  // deviation is in the outcome, not in the run.
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, "SUCCEEDED");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "REVIEW");
  const question = await stopQuestionFor(chain.integratorTask!.id);
  assert.ok(question, "a stop question is open");
  assert.deepEqual((question!.choices as Array<{ id: string }>).map((choice) => choice.id), ["re-authorize", "abandon"]);
  const activities = await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } });
  assert.equal(activities.filter((row) => (row.metadata as any)?.kind === MERGE_INTEGRATOR_KIND.result).length, 1);
  assert.equal(activities.filter((row) => row.body.includes("Chain complete")).length, 0);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1, "no automatic retry");
  assert.deepEqual(releasedChainLeases, [chain.integratorTask!.chainId]);
  assert.deepEqual(releasedLeaseTargets, [{
    chainId: chain.integratorTask!.chainId,
    projectId: chain.project.id,
  }]);
});

test("a legacy integrator role enters automatic base-drift recovery regardless of ordinal", async () => {
  const chain = await seedIntegratorChain(db, { label: "legacy-base-drift-exit", shape: "twelve-step" });
  const run = await liveIntegratorRun(chain);
  await persistOutcome(chain.integratorTask!.id, run.id, JSON.stringify({
    outcome: "stopped",
    condition: "base-drift",
    evidence: JSON.stringify({ observed: "c".repeat(40), authorized: "b".repeat(40) }),
  }));
  assert.equal((await completeRun(run)).status, 200);
  const question = await stopQuestionFor(chain.integratorTask!.id);
  assert.equal(question, null, "the merge-result role is an automatic-recovery candidate in every template generation");
});

test("a fresh regression completion preserves success and parks a legacy-stopped integrator", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "completion-legacy-stop-park",
    shape: "legacy-seven-step-direct",
  });
  assert.ok(chain.readinessTask, "the historical readiness step exists");
  assert.equal(chain.readinessTask.status, "DONE", "readiness was already complete before the fresh regression");
  assert.ok(chain.integratorTask, "the integrator successor exists");

  const stop = await db.taskActivity.create({ data: {
    taskId: chain.integratorTask.id,
    actorType: "control-plane",
    body: "Mechanical merge stopped: base-drift",
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.result,
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      outcome: "stopped",
      condition: "base-drift",
      evidence: "legacy stop without server-owned binding",
    },
  } });
  await db.task.update({
    where: { id: chain.integratorTask.id },
    data: { failureReason: "Mechanical merge stopped: base-drift" },
  });

  const regression = await db.run.create({ data: {
    projectId: chain.project.id,
    taskId: chain.gateTask.id,
    agentId: chain.agent.id,
    repoId: chain.repo.id,
    runNumber: 2,
    dedupeKey: `task:${chain.gateTask.id}:run:2`,
    runner: "CLAUDE",
    model: chain.agent.model,
    promptHash: "fresh-regression",
    status: "RUNNING",
    runnerId: RUNNER,
    maxRunsPerTask: 5,
    fencingToken: `1:${chain.gateTask.id}:2`,
    leaseExpiresAt: new Date(Date.now() + 600_000),
  } });
  await db.session.create({ data: {
    runId: regression.id,
    projectId: chain.project.id,
    taskId: chain.gateTask.id,
    agentId: chain.agent.id,
    runner: "CLAUDE",
    executionStatus: "RUNNING",
  } });
  const regressionOutput = JSON.stringify({
    schemaVersion: 1,
    outcome: "pass",
    headSha: "a".repeat(40),
    baseHeadSha: "b".repeat(40),
    gateVerdict: "PASS",
  });
  await db.taskStepOutput.upsert({
    where: { taskId: chain.gateTask.id },
    create: {
      taskId: chain.gateTask.id,
      runId: regression.id,
      kind: "regression-verification",
      body: regressionOutput,
      commitSha: "a".repeat(40),
    },
    update: {
      runId: regression.id,
      kind: "regression-verification",
      body: regressionOutput,
      commitSha: "a".repeat(40),
    },
  });
  await db.task.update({ where: { id: chain.gateTask.id }, data: { status: "DOING" } });

  const completion = await call("POST", `/runner/runs/${regression.id}/complete`, {
    runnerId: RUNNER,
    fencingToken: regression.fencingToken,
    exitCode: 0,
    outcome: { case: "succeeded" },
    cleanupStatus: "SUCCEEDED",
    headSha: "a".repeat(40),
    output: regressionOutput,
  }, RUNNER);

  assert.equal(completion.status, 200);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: regression.id } })).status, "SUCCEEDED");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.gateTask.id } })).status, "DONE");
  const parked = await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask.id } });
  assert.equal(parked.status, "REVIEW");
  assert.match(parked.failureReason ?? "", /predecessor success preserved/u);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask.id } }), 0, "the stopped successor was not queued");
  assert.equal(await db.run.count({ where: { taskId: chain.gateTask.id } }), 2, "no automatic regression retry was scheduled");
  const activity = await db.taskActivity.findFirst({
    where: { taskId: chain.integratorTask.id, metadata: { path: ["sourceRunId"], equals: regression.id } },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(activity, "the park is auditable from the successful predecessor run");
  assert.match(activity.body, /completed successfully and was preserved/u);
  assert.equal((activity.metadata as any).condition, "base-drift");
  assert.equal((activity.metadata as any).sourceStopId, stop.id);
});

test("Y1 the append-only stop history survives an output replacement", async () => {
  const { chain, run } = await stoppedChain("y1");
  // A later write replaces the single output row; the guard reads history, not
  // the replaceable latest view, so the stop cannot be erased by overwriting it.
  await persistOutcome(chain.integratorTask!.id, run.id, JSON.stringify({ outcome: "merged", mergeCommitSha: "d".repeat(40) }));
  const patched = await call("PATCH", `/tasks/${chain.integratorTask!.id}`, { status: "DONE" });
  assert.equal(patched.status, 409);
  assert.match(patched.body.error, /head-drift/u);
});

test("N18 an absent, wrong-kind or unparseable output lands missing-or-malformed-result, synthesizing nothing", async () => {
  for (const [label, prepare] of [
    ["absent", async () => {}],
    ["wrong-kind", async (taskId: string, runId: string) => {
      await db.taskStepOutput.create({ data: { taskId, runId, kind: "result", body: "done" } });
    }],
    ["unparseable", async (taskId: string, runId: string) => {
      await persistOutcome(taskId, runId, "the merge went fine, trust me");
    }],
  ] as const) {
    const chain = await seedIntegratorChain(db, { label: `n18-${label}` });
    const run = await liveIntegratorRun(chain);
    await prepare(chain.integratorTask!.id, run.id);
    assert.equal((await completeRun(run, { output: "Run finished" })).status, 200, label);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "REVIEW", label);
    const stop = (await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } }))
      .find((row) => (row.metadata as any)?.kind === MERGE_INTEGRATOR_KIND.result);
    assert.equal((stop!.metadata as any).condition, "missing-or-malformed-result", label);
    const output = await db.taskStepOutput.findUnique({ where: { taskId: chain.integratorTask!.id } });
    // X3: the control plane never writes "Run N completed successfully." onto a
    // merge step, because that body would read as a merge that never happened.
    assert.ok(!output || !output.body.includes("completed successfully"), label);
  }
});

test("a merged outcome advances the chain and lands DONE", async () => {
  const chain = await seedIntegratorChain(db, { label: "merged" });
  const run = await liveIntegratorRun(chain);
  await persistOutcome(chain.integratorTask!.id, run.id, JSON.stringify({ outcome: "merged", mergeCommitSha: "e".repeat(40) }));
  assert.equal(await db.taskActivity.count({
    where: { taskId: chain.integratorTask!.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHold } },
  }), 0, "the retained readiness lease is not measured before merge completion");
  assert.equal((await completeRun(run)).status, 200);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "DONE");
  assert.equal(await stopQuestionFor(chain.integratorTask!.id), null);
  assert.deepEqual(releasedChainLeases, [chain.integratorTask!.chainId]);
  assert.deepEqual(releasedLeaseTargets, [{
    chainId: chain.integratorTask!.chainId,
    projectId: chain.project.id,
  }]);
  const hold = await db.taskActivity.findFirstOrThrow({
    where: { taskId: chain.integratorTask!.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHold } },
  });
  const ledger = await db.mergeLeaseEvent.findUniqueOrThrow({
    where: { projectId_chainId_leaseSha: {
      projectId: chain.project.id,
      chainId: chain.integratorTask!.chainId!,
      leaseSha: CONFIRMED_RELEASE.sha,
    } },
  });
  assert.equal(ledger.state, MergeLeaseEventState.RELEASED);
  assert.deepEqual(hold.metadata, {
    kind: MERGE_TAIL_KIND.leaseHold,
    schemaVersion: 1,
    ledgerId: ledger.id,
    chainId: chain.integratorTask!.chainId,
    leaseRef: CONFIRMED_RELEASE.ref,
    leaseSha: CONFIRMED_RELEASE.sha,
    acquiredAt: CONFIRMED_RELEASE.acquiredAt,
    releasedAt: CONFIRMED_RELEASED_AT.toISOString(),
    heldForSeconds: 62,
  });
});

test("N19 no generic exit from a stop: PATCH, retry and enqueue are all refused", async () => {
  const { chain } = await stoppedChain("n19");
  assert.equal((await call("PATCH", `/tasks/${chain.integratorTask!.id}`, { status: "DONE" })).status, 409);
  assert.equal((await call("POST", `/tasks/${chain.integratorTask!.id}/retry`)).status, 409);
  await assert.rejects(
    db.$transaction((tx) => enqueueTaskRun(tx, chain.integratorTask!.id)),
    /stopped on head-drift/u,
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "REVIEW");
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);
});

test("N19 flag-incident is not an exit: the guard holds and the promised later choices are actually offered", async () => {
  const { chain } = await stoppedChain("n19-incident", "changed-underneath-me");
  const question = await stopQuestionFor(chain.integratorTask!.id);
  assert.deepEqual(
    (question!.choices as Array<{ id: string }>).map((choice) => choice.id),
    ["accept-foreign-merge", "flag-incident"],
  );
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-flag", decision: "flag-incident",
  }));
  const answer = (await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } }))
    .map((row) => parseStopAnswerMetadata(row.metadata)).find(Boolean);
  assert.equal(answer!.disposition, "nonterminal");

  // C3: an answer exists, and every generic exit is still refused.
  assert.equal((await call("PATCH", `/tasks/${chain.integratorTask!.id}`, { status: "DONE" })).status, 409);
  assert.equal((await call("POST", `/tasks/${chain.integratorTask!.id}/retry`)).status, 409);
  const followUp = await stopQuestionFor(chain.integratorTask!.id);
  assert.ok(followUp && followUp.id !== question!.id, "a fresh follow-up question exists");
  assert.deepEqual(
    (followUp!.choices as Array<{ id: string }>).map((choice) => choice.id),
    ["accept-foreign-merge", "abandon"],
  );
  // A replayed identical answer changes nothing.
  const replay = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-flag-2", decision: "flag-incident",
  }));
  assert.equal(replay.duplicate, true);

  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: followUp!.id, externalEventId: "evt-accept", decision: "accept-foreign-merge",
  }));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "DONE");
  // The stop is resolved, but chain-derived status ownership remains intact.
  assert.equal((await call("PATCH", `/tasks/${chain.integratorTask!.id}`, { status: "REVIEW" })).status, 409);
});

test("N19 abandon closes the chain with the abandonment explicit, never as a delivery", async () => {
  const { chain } = await stoppedChain("n19-abandon");
  const question = await stopQuestionFor(chain.integratorTask!.id);
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-abandon", decision: "abandon",
  }));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "DONE");
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: chain.integratorTask!.id } });
  assert.match(output.body, /abandoned/iu);
  assert.match(output.body, /No merge was performed/iu);
  const completion = (await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } }))
    .find((row) => row.body.includes("abandoned"));
  assert.ok(completion, "the completion activity names the abandonment");
});

test("N19 re-authorize creates no run and writes no authorization; it asks for evidence first", async () => {
  const { chain } = await stoppedChain("n19-reauth");
  const question = await stopQuestionFor(chain.integratorTask!.id);
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-reauth", decision: "re-authorize",
  }));
  // C2 in the control plane: the answer to a stop is a *request* for evidence,
  // not an authorization. Nothing runs until the human reads the new card.
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);
  const authorizations = (await db.taskActivity.findMany({ where: { taskId: chain.gateTask.id } }))
    .filter((row) => (row.metadata as any)?.kind === MERGE_INTEGRATOR_KIND.authorization);
  assert.equal(authorizations.length, 0);
  const confirmation = await db.inboxMessage.findFirst({
    where: { gateTaskId: chain.gateTask.id, status: "OPEN" }, orderBy: { createdAt: "desc" },
  });
  assert.ok(confirmation, "a fresh confirmation card was requested");
  const requests = (await db.taskActivity.findMany({ where: { taskId: chain.gateTask.id } }))
    .filter((row) => (row.metadata as any)?.purpose === "confirmation");
  assert.equal(requests.length, 1);
  // The guard is still in force: refresh-requested is not terminal.
  assert.equal((await call("PATCH", `/tasks/${chain.integratorTask!.id}`, { status: "DONE" })).status, 409);
});

test("legacy seven-step re-authorize binds the card to readiness and evidence to the nearest Run/Session", async () => {
  const { chain } = await stoppedChain("legacy-seven-reauth", "head-drift", "legacy-seven-step-direct");
  assert.ok(chain.readinessTask, "the legacy shape has an immediate Merge readiness predecessor");
  assert.equal(await db.run.count({ where: { taskId: chain.readinessTask!.id } }), 0);
  assert.equal(await db.session.count({ where: { taskId: chain.readinessTask!.id } }), 0);

  const question = await stopQuestionFor(chain.integratorTask!.id);
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-legacy-seven-reauth", decision: "re-authorize",
  }));

  const cards = await db.inboxMessage.findMany({
    where: { dedupeKey: `confirmation:${chain.integratorTask!.id}:` + (question!.dedupeKey!.split(":").at(-1)!) },
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.status, "OPEN");
  assert.equal(cards[0]!.body, EVIDENCE_PLACEHOLDER_BODY);
  assert.equal(cards[0]!.gateTaskId, chain.readinessTask!.id);
  assert.equal(cards[0]!.sessionId, chain.gateSession.id);
  const requests = (await db.taskActivity.findMany({ where: { taskId: chain.readinessTask!.id } }))
    .filter((row) => (row.metadata as any)?.purpose === "confirmation");
  assert.equal(requests.length, 1);
  assert.equal((requests[0]!.metadata as any).sourceRunId, chain.gateRun.id);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);
  assert.equal(
    await db.taskActivity.count({
      where: {
        taskId: chain.readinessTask!.id,
        metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization },
      },
    }),
    0,
  );
});

test("legacy seven-step re-authorize fails loudly rather than crossing chains for evidence", async () => {
  const { chain } = await stoppedChain("legacy-seven-no-source", "head-drift", "legacy-seven-step-direct");
  await db.session.delete({ where: { id: chain.gateSession.id } });
  const foreignTask = await db.task.create({ data: {
    projectId: chain.project.id, repoId: chain.repo.id, name: "Foreign evidence", description: "unrelated chain",
    assigneeType: "AGENT", assigneeAgentId: chain.agent.id, chainId: "foreign-chain", chainIndex: 5, chainLayer: 5,
    status: "DONE", targetBranch: "master",
  } });
  const foreignRun = await db.run.create({ data: {
    projectId: chain.project.id, taskId: foreignTask.id, repoId: chain.repo.id, agentId: chain.agent.id,
    runNumber: 1, dedupeKey: `task:${foreignTask.id}:run:1`, runner: "CLAUDE", model: chain.agent.model,
    promptHash: "foreign", status: "SUCCEEDED", pullRequestNumber: 123,
  } });
  await db.session.create({ data: {
    runId: foreignRun.id, projectId: chain.project.id, taskId: foreignTask.id, agentId: chain.agent.id,
    runner: "CLAUDE", executionStatus: "SUCCEEDED",
  } });

  const question = await stopQuestionFor(chain.integratorTask!.id);
  await assert.rejects(
    db.$transaction((tx) => applyInboxDecisionTx(tx, {
      inboxMessageId: question!.id, externalEventId: "evt-legacy-seven-foreign", decision: "re-authorize",
    })),
    /no preceding same-chain Run with a Session/u,
  );
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: question!.id } })).status, "OPEN");
  assert.equal(
    (await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } }))
      .filter((row) => parseStopAnswerMetadata(row.metadata)).length,
    0,
  );
});

test("safe replay repairs refresh-requested without a card exactly once under concurrent attempts", async () => {
  const { chain } = await stoppedChain("legacy-seven-recovery", "head-drift", "legacy-seven-step-direct");
  const question = await stopQuestionFor(chain.integratorTask!.id);
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-legacy-seven-old-answer", decision: "re-authorize",
  }));

  // Reproduce the durable legacy state: the stop and refresh-requested answer
  // remain append-only authority, while the null-card outcome left no Phase-A
  // request/card behind.
  const initialRequests = (await db.taskActivity.findMany({ where: { taskId: chain.readinessTask!.id } }))
    .filter((row) => (row.metadata as any)?.purpose === "confirmation");
  assert.equal(initialRequests.length, 1);
  const initialCardId = (initialRequests[0]!.metadata as any).cardId as string;
  await db.taskActivity.delete({ where: { id: initialRequests[0]!.id } });
  await db.inboxMessage.delete({ where: { id: initialCardId } });
  assert.equal(
    (await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } }))
      .filter((row) => parseStopAnswerMetadata(row.metadata)?.disposition === "refresh-requested").length,
    1,
  );

  const replays = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    db.$transaction((tx) => applyInboxDecisionTx(tx, {
      inboxMessageId: question!.id,
      externalEventId: `evt-legacy-seven-replay-${index}`,
      decision: "re-authorize",
    })),
  ));
  assert.ok(replays.every((result) => result.duplicate));
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-legacy-seven-replay-again", decision: "re-authorize",
  }));

  const recoveredRequests = (await db.taskActivity.findMany({ where: { taskId: chain.readinessTask!.id } }))
    .filter((row) => (row.metadata as any)?.purpose === "confirmation");
  assert.equal(recoveredRequests.length, 1);
  const recoveredCards = await db.inboxMessage.findMany({
    where: { dedupeKey: `confirmation:${chain.integratorTask!.id}:` + (question!.dedupeKey!.split(":").at(-1)!) },
  });
  assert.equal(recoveredCards.length, 1);
  assert.equal(recoveredCards[0]!.status, "OPEN");
  assert.equal((recoveredRequests[0]!.metadata as any).cardId, recoveredCards[0]!.id);
  assert.equal((recoveredRequests[0]!.metadata as any).sourceRunId, chain.gateRun.id);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);
  assert.equal(
    (await db.taskActivity.findMany({ where: { taskId: chain.readinessTask!.id } }))
      .filter((row) => (row.metadata as any)?.kind === MERGE_INTEGRATOR_KIND.authorization).length,
    0,
  );
});

test("recovered confirmation approval renews authorization through gated seven- and twelve-step readiness tails", async () => {
  for (const shape of ["legacy-seven-step-direct", "twelve-step-readiness"] as const) {
    const { chain } = await stoppedChain(`renew-${shape}`, "head-drift", shape, 5, 5, true);
    assert.ok(chain.readinessTask, `${shape} has a server-owned readiness gate`);
    const question = await stopQuestionFor(chain.integratorTask!.id);
    await db.$transaction((tx) => applyInboxDecisionTx(tx, {
      inboxMessageId: question!.id, externalEventId: `evt-${shape}-reauth`, decision: "re-authorize",
    }));

    const replays = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      db.$transaction((tx) => applyInboxDecisionTx(tx, {
        inboxMessageId: question!.id,
        externalEventId: `evt-${shape}-replay-${index}`,
        decision: "re-authorize",
      })),
    ));
    assert.ok(replays.every((result) => result.duplicate));

    const requests = (await db.taskActivity.findMany({ where: { taskId: chain.readinessTask!.id } }))
      .filter((row) => (row.metadata as any)?.purpose === "confirmation");
    assert.equal(requests.length, 1, `${shape}: recovery is deduped on readiness`);
    assert.equal((requests[0]!.metadata as any).sourceRunId, chain.gateRun.id);
    const card = await db.inboxMessage.findUniqueOrThrow({
      where: { id: (requests[0]!.metadata as any).cardId as string },
    });
    assert.equal(card.gateTaskId, chain.readinessTask!.id);
    assert.equal(card.sessionId, chain.gateSession.id);
    assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);
    assert.equal(
      await db.taskActivity.count({
        where: {
          taskId: chain.readinessTask!.id,
          metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization },
        },
      }),
      0,
    );

    const filled = await evidenceTick(db, { readPullRequest: async () => freshSnapshot() }, new Date());
    assert.deepEqual(filled, { claimed: 1, filled: 1, unavailable: 0 });
    await db.$transaction((tx) => applyInboxDecisionTx(tx, {
      inboxMessageId: card.id, externalEventId: `evt-${shape}-approve`, decision: "approve",
    }));

    const authorizations = await db.taskActivity.findMany({
      where: {
        taskId: chain.readinessTask!.id,
        metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization },
      },
    });
    assert.equal(authorizations.length, 1, `${shape}: fresh evidence creates one readiness authorization`);
    assert.equal(parseAuthorizationMetadata(authorizations[0]!.metadata).status, "ok");
    assert.equal(
      await db.taskActivity.count({
        where: {
          taskId: chain.gateTask.id,
          metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization },
        },
      }),
      0,
      `${shape}: evidence source is not the authorization gate`,
    );
    const runs = await db.run.findMany({
      where: { taskId: chain.integratorTask!.id }, orderBy: { runNumber: "asc" },
    });
    assert.equal(runs.length, 2, `${shape}: exactly one renewed mechanical Run`);
    assert.equal(runs[1]!.runNumber, 6);
    assert.equal(runs[1]!.maxRunsPerTask, 6, `${shape}: renewal raises the exhausted ceiling`);
    assert.equal(runs[1]!.budgetGrants, 1);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "TODO");

    const replay = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
      inboxMessageId: card.id, externalEventId: `evt-${shape}-approve-replay`, decision: "approve",
    }));
    assert.equal(replay.duplicate, true);
    assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 2);
  }
});

test("task PATCH renews a stopped integrator from confirmation bound to gated readiness", async () => {
  const { chain } = await stoppedChain(
    "renew-gated-readiness-patch",
    "head-drift",
    "twelve-step-readiness",
    5,
    5,
    true,
  );
  assert.ok(chain.readinessTask, "the readiness tail has a server-owned gate");
  const question = await stopQuestionFor(chain.integratorTask!.id);
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id,
    externalEventId: "evt-renew-gated-readiness-patch-request",
    decision: "re-authorize",
  }));
  const request = await db.taskActivity.findFirstOrThrow({
    where: {
      taskId: chain.readinessTask.id,
      metadata: { path: ["purpose"], equals: "confirmation" },
    },
    orderBy: { createdAt: "desc" },
  });
  const card = await db.inboxMessage.findUniqueOrThrow({
    where: { id: (request.metadata as any).cardId as string },
  });
  assert.equal((await evidenceTick(db, { readPullRequest: async () => freshSnapshot() }, new Date())).filled, 1);

  const approved = await call("PATCH", `/tasks/${chain.readinessTask.id}`, { status: "DONE" });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } })).status, "ANSWERED");
  assert.equal(
    await db.taskActivity.count({
      where: {
        taskId: chain.readinessTask.id,
        metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization },
      },
    }),
    1,
  );
  const runs = await db.run.findMany({
    where: { taskId: chain.integratorTask!.id },
    orderBy: { runNumber: "asc" },
  });
  assert.equal(runs.length, 2);
  assert.equal(runs[1]!.runNumber, 6);
  assert.equal(runs[1]!.status, "QUEUED");
});

/**
 * The confirmation path raises every other Run-birth refusal, which rolls back
 * the transaction that carries the human's authorization. A spend cap must not
 * be enforced that way: rolling back would discard both the approval and the
 * record naming the cap, leaving an operator with a 409 and no way to see which
 * limit refused the renewal.
 */
test("a spend cap parks the renewed integrator instead of discarding the authorization", async () => {
  const { chain } = await stoppedChain(
    "renew-gated-readiness-spend-cap",
    "head-drift",
    "twelve-step-readiness",
    5,
    5,
    true,
  );
  assert.ok(chain.readinessTask, "the readiness tail has a server-owned gate");
  const question = await stopQuestionFor(chain.integratorTask!.id);
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id,
    externalEventId: "evt-renew-gated-readiness-spend-cap-request",
    decision: "re-authorize",
  }));
  await evidenceTick(db, { readPullRequest: async () => freshSnapshot() }, new Date());
  // A cap of zero refuses every attempt, which is the cheapest exhausted cap.
  await db.task.update({
    where: { id: chain.integratorTask!.id },
    data: { spendCap: new Prisma.Decimal("0") },
  });

  const approved = await call("PATCH", `/tasks/${chain.readinessTask.id}`, { status: "DONE" });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  // The authorization the human gave is kept.
  assert.equal(
    await db.taskActivity.count({
      where: {
        taskId: chain.readinessTask.id,
        metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization },
      },
    }),
    1,
    "the authorization committed",
  );
  assert.equal(
    await db.run.count({ where: { taskId: chain.integratorTask!.id } }),
    1,
    "no mechanical merge run was queued past the cap",
  );
  const parked = await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } });
  assert.equal(parked.status, "REVIEW");
  assert.match(String(parked.failureReason), /Spend cap \$0\.00 reached/u);
  assert.equal(
    await db.taskActivity.count({
      where: {
        taskId: chain.integratorTask!.id,
        metadata: { path: ["refusal"], equals: "spend-cap-exhausted" },
      },
    }),
    1,
    "the refusal names itself where an operator filters for it",
  );
});

test("fresh confirmation rejection reruns regression, never gated readiness, for seven- and twelve-step tails", async () => {
  for (const shape of ["legacy-seven-step-direct", "twelve-step-readiness"] as const) {
    const { chain } = await stoppedChain(`reject-${shape}`, "head-drift", shape, 1, 5, true);
    assert.ok(chain.readinessTask, `${shape} has a server-owned readiness gate`);
    const question = await stopQuestionFor(chain.integratorTask!.id);
    await db.$transaction((tx) => applyInboxDecisionTx(tx, {
      inboxMessageId: question!.id, externalEventId: `evt-${shape}-reauth-for-reject`, decision: "re-authorize",
    }));

    const request = (await db.taskActivity.findMany({ where: { taskId: chain.readinessTask!.id } }))
      .find((row) => (row.metadata as any)?.purpose === "confirmation");
    assert.ok(request, `${shape}: confirmation evidence was requested on readiness`);
    const card = await db.inboxMessage.findUniqueOrThrow({
      where: { id: (request.metadata as any).cardId as string },
    });
    const filled = await evidenceTick(db, { readPullRequest: async () => freshSnapshot() }, new Date());
    assert.deepEqual(filled, { claimed: 1, filled: 1, unavailable: 0 });

    const rejected = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
      inboxMessageId: card.id, externalEventId: `evt-${shape}-reject`, decision: "reject",
    }));
    assert.equal(rejected.gateAction, "rejected");
    assert.equal(await db.run.count({ where: { taskId: chain.readinessTask!.id } }), 0,
      `${shape}: readiness never receives a model Run`);
    const regressionRuns = await db.run.findMany({
      where: { taskId: chain.gateTask.id }, orderBy: { runNumber: "asc" },
    });
    assert.equal(regressionRuns.length, 2, `${shape}: regression receives exactly one recovery Run`);
    assert.equal(regressionRuns[1]!.status, "QUEUED", `${shape}: regression is queued again`);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.gateTask.id } })).status, "TODO");
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask!.id } })).status, "TODO");
    assert.equal(
      await db.taskActivity.count({
        where: { taskId: chain.gateTask.id, body: "Approval gate rejected; step queued again" },
      }),
      1,
      `${shape}: rejection records the regression recovery`,
    );
  }
});

test("N20 an external failure at the ceiling buys an integrator step no extra run", async () => {
  const chain = await seedIntegratorChain(db, { label: "n20-external" });
  const run = await liveIntegratorRun(chain, 5, 5);
  const completion = await completeRun(run, {
    exitCode: 1,
    outcome: {
      case: "provider-failure",
      reason: "network",
      envelope: {
        version: 1, phase: "EXECUTE", runnerClass: "TRANSIENT_PROVIDER", exitCode: 1, signal: null,
        terminationReason: null, terminalEventSeen: false, terminalSuccess: false, agentExited: false,
        providerError: null, stderrSummary: "network", stdoutSummary: null,
        timedOut: false, transient: true, timeoutMs: null,
      },
    },
  });
  assert.equal(completion.status, 200);
  // §D-P5: the automatic path may not raise the ceiling, so no run 6 exists and
  // the row's own ceiling is unchanged.
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).maxRunsPerTask, 5);
});

test("N20 an ordinary task's external-failure compensation is unchanged", async () => {
  const chain = await seedIntegratorChain(db, { label: "n20-ordinary" });
  const run = await db.run.create({ data: {
    projectId: chain.project.id, taskId: chain.gateTask.id, agentId: chain.agent.id, repoId: chain.repo.id,
    runNumber: 5, dedupeKey: `task:${chain.gateTask.id}:run:5`, runner: "CLAUDE", model: "claude-opus-5:high",
    // An ordinary run, so an ordinary runner id and an ordinary bearer: the
    // executor identity belongs to mechanical runs and to nothing else.
    promptHash: "hash", status: "RUNNING", runnerId: "runner-1", maxRunsPerTask: 5,
    fencingToken: `1:${chain.gateTask.id}:5`, leaseExpiresAt: new Date(Date.now() + 600_000),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: chain.project.id, agentId: chain.agent.id, taskId: chain.gateTask.id,
    runner: "CLAUDE", executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: chain.gateTask.id }, data: { status: "DOING" } });
  const completion = await call("POST", `/runner/runs/${run.id}/complete`, {
    runnerId: "runner-1", fencingToken: run.fencingToken, exitCode: 1, cleanupStatus: "SUCCEEDED",
    outcome: {
      case: "provider-failure",
      reason: "network",
      envelope: {
        version: 1, phase: "EXECUTE", runnerClass: "TRANSIENT_PROVIDER", exitCode: 1, signal: null,
        terminationReason: null, terminalEventSeen: false, terminalSuccess: false, agentExited: false,
        providerError: null, stderrSummary: "network", stdoutSummary: null,
        timedOut: false, transient: true, timeoutMs: null,
      },
    },
  }, RUNNER);
  assert.equal(completion.status, 200);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).maxRunsPerTask, 6);
});

test("N22 the repair path: a correction bounded by the chain's own delivered pull requests", async () => {
  const chain = await seedIntegratorChain(db, { label: "n22-repair", prNumbers: [10, 11] });
  const run = await liveIntegratorRun(chain);
  await persistOutcome(chain.integratorTask!.id, run.id, JSON.stringify({
    outcome: "stopped", condition: "target-unresolvable", evidence: "observed 10, 11",
  }));
  await completeRun(run);
  const question = await stopQuestionFor(chain.integratorTask!.id);
  // MF-8: re-authorize is not offered, because it could not change the run rows
  // the target is derived from.
  assert.deepEqual(
    (question!.choices as Array<{ id: string }>).map((choice) => choice.id),
    ["open-repair", "abandon"],
  );
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-repair", decision: "open-repair",
  }));

  const foreign = await call("POST", `/tasks/${chain.integratorTask!.id}/merge-target`, { prNumber: 999 });
  assert.equal(foreign.status, 409);
  assert.match(foreign.body.error, /not among this chain/u);
  assert.equal(
    (await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } }))
      .filter((row) => (row.metadata as any)?.kind === MERGE_INTEGRATOR_KIND.targetCorrection).length,
    0,
    "a refused correction writes no record",
  );

  const accepted = await call("POST", `/tasks/${chain.integratorTask!.id}/merge-target`, { prNumber: 11 });
  assert.equal(accepted.status, 201);
  assert.deepEqual(accepted.body.observed, [10, 11]);
  assert.ok(accepted.body.confirmationCardId, "the repair asks for a confirmation card");
  assert.equal(
    (await db.inboxMessage.findUniqueOrThrow({ where: { id: accepted.body.confirmationCardId } })).status,
    "OPEN",
  );
  // The guard is still in force until that card is approved.
  assert.equal((await call("PATCH", `/tasks/${chain.integratorTask!.id}`, { status: "DONE" })).status, 409);
});

test("N22 a chain that delivered no pull request is told so, and abandon is the exit", async () => {
  const chain = await seedIntegratorChain(db, { label: "n22-empty" });
  await db.run.updateMany({ where: { taskId: chain.gateTask.id }, data: { pullRequestNumber: null } });
  const run = await liveIntegratorRun(chain);
  await persistOutcome(chain.integratorTask!.id, run.id, JSON.stringify({
    outcome: "stopped", condition: "target-unresolvable", evidence: "observed none",
  }));
  await completeRun(run);
  const refused = await call("POST", `/tasks/${chain.integratorTask!.id}/merge-target`, { prNumber: 7 });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /delivered no pull request/u);
  const question = await stopQuestionFor(chain.integratorTask!.id);
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-empty-abandon", decision: "abandon",
  }));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, "DONE");
});

test("N22 target correction remains durable when confirmation evidence has no same-chain source", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "n22-durable-correction",
    prNumbers: [10, 11],
    shape: "legacy-seven-step-direct",
  });
  const run = await liveIntegratorRun(chain);
  await persistOutcome(chain.integratorTask!.id, run.id, JSON.stringify({
    outcome: "stopped", condition: "target-unresolvable", evidence: "observed 10, 11",
  }));
  await completeRun(run);
  const question = await stopQuestionFor(chain.integratorTask!.id);
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question!.id, externalEventId: "evt-durable-repair", decision: "open-repair",
  }));
  await db.session.deleteMany({ where: { taskId: chain.gateTask.id } });

  const refused = await call("POST", `/tasks/${chain.integratorTask!.id}/merge-target`, { prNumber: 11 });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /no preceding same-chain Run with a Session/u);
  const corrections = (await db.taskActivity.findMany({ where: { taskId: chain.integratorTask!.id } }))
    .filter((row) => (row.metadata as any)?.kind === MERGE_INTEGRATOR_KIND.targetCorrection);
  assert.equal(corrections.length, 1, "the authenticated correction commits despite card refusal");
  assert.equal((corrections[0]!.metadata as any).prNumber, 11);
  assert.equal(
    await db.inboxMessage.count({
      where: { dedupeKey: { startsWith: `confirmation:${chain.integratorTask!.id}:` } },
    }),
    0,
  );
});
