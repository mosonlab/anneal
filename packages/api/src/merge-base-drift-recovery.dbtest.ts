import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  AUTHORIZED_MERGE_METHOD,
  activateRecoveryIntegratorSuccessor,
  authorizationMetadata,
  MERGE_INTEGRATOR_KIND,
  MergeRecoveryRefusalCode,
  Prisma,
  PrismaClient,
  readMarkerHistory,
  readMarkers,
  latestMarker,
  recordIntegratorStop,
  TaskStatus,
} from "@anneal/db";

import { classifyCandidate } from "./base-drift-recovery-decision.js";
import { baseDriftRecoveryTick, readCandidateFacts } from "./merge-base-drift-worker.js";
import { handleRegressionCompletion } from "./merge-tail-actions.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import {
  withMergeLease,
  type MergeLeaseAcquirer,
  type MergeLeaseReleaser,
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";
import { readinessTick, reopenRecoveryHeadAdoptionFailures } from "./merge-readiness-worker.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
import type { PullRequestReader, PullRequestSnapshot } from "./github-read.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const HEAD = "a".repeat(40);
const HEAD_2 = "f".repeat(40);
const BASE = "b".repeat(40);
const BASE_2 = "c".repeat(40);
const BASE_3 = "d".repeat(40);
const BASE_4 = "e".repeat(40);
const OPERATOR = "base-drift-recovery-operator";
const acquireChainLease: MergeLeaseAcquirer = async () => ({ outcome: "acquired" });
const releaseLeaseAdapter: MergeLeaseReleaser = async () => ({ outcome: "not-held" });
const releaseChainLease: ReleaseMergeLease = async () => {};

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const snapshot = (
  baseSha: string,
  overrides: Partial<PullRequestSnapshot> = {},
): PullRequestSnapshot => ({
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
  readAt: new Date("2026-08-22T01:00:00.000Z").toISOString(),
  ...overrides,
});

const reader = (current: PullRequestSnapshot): PullRequestReader => ({
  readPullRequest: async () => current,
  compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
});

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

const mechanicalStop = async (
  seeded: Awaited<ReturnType<typeof seedIntegratorChain>>,
  authorizationActivityId: string,
) => {
  const previous = await db.run.findFirst({
    where: { taskId: seeded.integratorTask!.id },
    orderBy: { runNumber: "desc" },
  });
  const run = previous?.status === "QUEUED"
    ? await db.run.update({ where: { id: previous.id }, data: { status: "SUCCEEDED" } })
    : await db.run.create({ data: {
        projectId: seeded.project.id,
        taskId: seeded.integratorTask!.id,
        agentId: seeded.integratorAgent.id,
        repoId: seeded.repo.id,
        runNumber: (previous?.runNumber ?? 0) + 1,
        dedupeKey: `task:${seeded.integratorTask!.id}:run:${(previous?.runNumber ?? 0) + 1}`,
        runner: "CLAUDE",
        model: "mechanical/merge-executor-v1",
        promptHash: "mechanical",
        status: "SUCCEEDED",
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
    create: {
      taskId: seeded.integratorTask!.id,
      runId: run.id,
      kind: "merge-result",
      body: outputBody,
    },
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

const seedStopped = async (
  shape: "canonical-direct" | "canonical-compound-readiness",
  label: string,
) => {
  const seeded = await seedIntegratorChain(db, { label, shape });
  const authorization = await authorize(seeded.readinessTask!.id, BASE);
  const sourceRun = await mechanicalStop(seeded, authorization.id);
  return { ...seeded, authorization, sourceRun };
};

const recordRecoveryPass = async (
  seeded: Awaited<ReturnType<typeof seedStopped>>,
  baseSha: string,
  headSha: string,
) => {
  const run = await db.run.findFirstOrThrow({
    where: { taskId: seeded.gateTask.id },
    orderBy: { runNumber: "desc" },
  });
  await db.run.update({ where: { id: run.id }, data: { status: "SUCCEEDED", headSha } });
  await db.taskStepOutput.upsert({
    where: { taskId: seeded.gateTask.id },
    create: {
      taskId: seeded.gateTask.id,
      runId: run.id,
      kind: "regression-verification",
      body: JSON.stringify({
        schemaVersion: 1,
        outcome: "pass",
        headSha,
        baseHeadSha: baseSha,
        gateVerdict: "PASS",
      }),
      commitSha: headSha,
    },
    update: {
      runId: run.id,
      kind: "regression-verification",
      body: JSON.stringify({
        schemaVersion: 1,
        outcome: "pass",
        headSha,
        baseHeadSha: baseSha,
        gateVerdict: "PASS",
      }),
      commitSha: headSha,
    },
  });
  await db.task.update({
    where: { id: seeded.gateTask.id },
    data: { status: TaskStatus.DONE },
  });
};

const addRepairTailFixtures = async (
  seeded: Awaited<ReturnType<typeof seedStopped>>,
  withDocumentation: boolean,
) => {
  const regressionIndex = seeded.gateStep.stepIndex;
  const fixedIndex = regressionIndex - (withDocumentation ? 2 : 1);
  const fixedStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: seeded.template.id,
    stepIndex: fixedIndex,
    layer: fixedIndex,
    name: "Apply review fixes",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: seeded.agent.id,
    prompt: "fix",
    approvalGate: false,
    outputKind: "fixed-implementation",
  } });
  await db.task.create({ data: {
    projectId: seeded.project.id,
    repoId: seeded.repo.id,
    templateId: seeded.template.id,
    templateStepId: fixedStep.id,
    name: "Apply review fixes",
    description: "fix",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: seeded.agent.id,
    status: TaskStatus.DONE,
    chainId: seeded.chainId,
    chainIndex: fixedIndex,
    chainLayer: fixedIndex,
    targetBranch: "master",
  } });
  if (!withDocumentation) return null;
  const documentationIndex = regressionIndex - 1;
  const documentationStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: seeded.template.id,
    stepIndex: documentationIndex,
    layer: documentationIndex,
    name: "Documentation",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: seeded.agent.id,
    prompt: "document",
    approvalGate: false,
    outputKind: "documentation",
  } });
  return db.task.create({ data: {
    projectId: seeded.project.id,
    repoId: seeded.repo.id,
    templateId: seeded.template.id,
    templateStepId: documentationStep.id,
    name: "Documentation",
    description: "document",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: seeded.agent.id,
    status: TaskStatus.DONE,
    chainId: seeded.chainId,
    chainIndex: documentationIndex,
    chainLayer: documentationIndex,
    targetBranch: "master",
  } });
};

/**
 * Stops the recovery Run that the named attempt is bound to, with the verdict
 * the tail would have recorded for it. The tail parks every recovery FAIL in
 * `BLOCKED_DOWNSTREAM`, so this is the state both operator reentry routes read.
 */
const failRecoveryRegression = async (
  seeded: Awaited<ReturnType<typeof seedStopped>>,
  aggregateId: string,
  outcome: "review-fail" | "gate-fail",
) => {
  const aggregate = await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: aggregateId } });
  const recoveryRun = await db.run.findUniqueOrThrow({ where: { id: aggregate.recoveryRunId! } });
  await db.run.update({ where: { id: recoveryRun.id }, data: {
    status: "SUCCEEDED",
    branch: "agentos/chain/recovery",
    pushedBranch: "agentos/chain/recovery",
    targetBranch: "master",
    headSha: HEAD,
  } });
  const body = JSON.stringify(outcome === "review-fail"
    ? {
      schemaVersion: 1,
      outcome,
      headSha: HEAD,
      baseHeadSha: BASE_2,
      summary: "recovery exposed a semantic defect",
    }
    : {
      schemaVersion: 1,
      outcome,
      headSha: HEAD,
      baseHeadSha: BASE_2,
      gateVerdict: "FAIL",
      summary: "unit tests (all workspaces)",
      gateFailureExcerpt: "a mismatched daemon process stays alive and still exits 0 on SIGTERM",
    });
  await db.taskStepOutput.upsert({
    where: { taskId: seeded.gateTask.id },
    create: {
      taskId: seeded.gateTask.id,
      runId: recoveryRun.id,
      kind: "regression-verification",
      body,
      commitSha: HEAD,
    },
    update: {
      runId: recoveryRun.id,
      kind: "regression-verification",
      body,
      commitSha: HEAD,
    },
  });
  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, {
    task: seeded.gateTask,
    run: {
      id: recoveryRun.id,
      agentId: seeded.agent.id,
      branch: "agentos/chain/recovery",
      headSha: HEAD,
      sessionId: seeded.gateSession.id,
    },
    now: new Date(),
  })), "handled");
  return recoveryRun;
};

const prepareBlockedRecovery = async (
  shape: "canonical-direct" | "canonical-compound-readiness",
  label: string,
  outcome: "review-fail" | "gate-fail" = "review-fail",
) => {
  const seeded = await seedStopped(shape, label);
  const documentation = await addRepairTailFixtures(seeded, shape === "canonical-compound-readiness");
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  const aggregate = await db.mergeRecoveryAttempt.findFirstOrThrow({
    where: { integratorTaskId: seeded.integratorTask!.id },
  });
  const recoveryRun = await failRecoveryRegression(seeded, aggregate.id, outcome);
  return { ...seeded, documentation, aggregateId: aggregate.id, recoveryRun };
};

const requestRecoveryRepair = async (taskId: string, requestId: string) => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    return await createApp(db).request(`/tasks/${taskId}/merge-tail/repair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, reason: "operator accepted the recovery finding" }),
    });
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = prior;
  }
};

const requestRecoveryRerun = async (taskId: string, requestId: string) => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    return await createApp(db).request(`/tasks/${taskId}/merge-tail/rerun`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, reason: "the failing test is not in this branch's change set" }),
    });
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = prior;
  }
};

type RerunResult = {
  aggregateId: string;
  attempt: number;
  recoveryRunId: string;
  headSha: string;
  baseHeadSha: string;
};

const acceptedRerun = async (taskId: string, requestId: string): Promise<RerunResult> => {
  const response = await requestRecoveryRerun(taskId, requestId);
  const result = await response.json() as RerunResult;
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
};

const refusedRerun = async (taskId: string, requestId: string, code: string) => {
  const response = await requestRecoveryRerun(taskId, requestId);
  const body = await response.json() as { error: string; code: string };
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.code, code, body.error);
};

const repairSpend = async (seeded: Awaited<ReturnType<typeof prepareBlockedRecovery>>) => ({
  repairTasks: await db.task.count({
    where: { projectId: seeded.project.id, name: { startsWith: "Autonomous merge tail:" } },
  }),
  repairAttempts: (await readMarkerHistory(db, seeded.gateTask.id))
    .filter((marker) => marker.kind === "repairAttempt").length,
});

const completeQueuedTask = async (taskId: string, headSha: string, output?: { kind: string; body: string }) => {
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  const run = await db.run.findFirstOrThrow({ where: { taskId, status: "QUEUED" }, orderBy: { runNumber: "desc" } });
  const runnerId = `recovery-repair-runner-${run.id}`;
  const fencingToken = `recovery-repair:${run.id}:1`;
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING",
    runnerId,
    fencingToken,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: task.projectId,
    agentId: task.assigneeAgentId!,
    taskId,
    runner: run.runner,
    executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: taskId }, data: { status: TaskStatus.DOING } });
  if (output) {
    await db.taskStepOutput.upsert({
      where: { taskId },
      create: { taskId, runId: run.id, kind: output.kind, body: output.body, commitSha: headSha },
      update: { runId: run.id, kind: output.kind, body: output.body, commitSha: headSha },
    });
  }
  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "recovery-repair-runner-token";
  try {
    const response = await createApp(db).request(`/runner/runs/${run.id}/complete`, {
      method: "POST",
      headers: { Authorization: "Bearer recovery-repair-runner-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId,
        fencingToken,
        exitCode: 0,
        outcome: { case: "succeeded" },
        cleanupStatus: "SUCCEEDED",
        branch: "agentos/chain/recovery",
        pushedBranch: "agentos/chain/recovery",
        pushStatus: "SUCCEEDED",
        headSha,
      }),
    });
    assert.equal(response.status, 200, await response.text());
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = prior;
  }
  return run;
};

const openRecoveryRepair = async (
  shape: "canonical-direct" | "canonical-compound-readiness",
  label: string,
) => {
  const seeded = await prepareBlockedRecovery(shape, label);
  await db.taskActivity.create({ data: {
    taskId: seeded.gateTask.id,
    actorType: "operator",
    body: "ordinary note with colliding metadata",
    metadata: {
      operatorNote: true,
      action: "merge-tail-repair-request",
      requestId: "recovery-repair-1",
      repairTaskId: "invented-repair",
      repairKind: "review-fix",
      headSha: HEAD,
      baseHeadSha: BASE_2,
    },
  } });
  const first = await requestRecoveryRepair(seeded.gateTask.id, "recovery-repair-1");
  const result = await first.json() as { repairTaskId: string; repairKind: string };
  assert.equal(first.status, 200, JSON.stringify(result));
  const repair = await db.task.findUniqueOrThrow({
    where: { id: result.repairTaskId },
    include: { assigneeAgent: { select: { id: true } } },
  });
  assert.equal(result.repairKind, "review-fix");
  assert.equal(repair.assigneeAgent?.id, seeded.agent.id);
  const attempt = latestMarker(await readMarkers(db, seeded.gateTask.id), "repairAttempt");
  assert.equal(attempt?.raw.sourceRunId, seeded.recoveryRun.id);
  assert.equal(attempt?.repairTaskId, repair.id);
  const repairing = await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: seeded.aggregateId } });
  assert.equal(repairing.status, "REPAIRING");
  assert.equal(repairing.failureReason, null);
  await db.taskActivity.create({ data: {
    taskId: seeded.gateTask.id,
    actorType: "operator",
    body: "malformed newer replay record",
    metadata: {
      action: "merge-tail-repair-request",
      requestId: "recovery-repair-1",
      repairTaskId: "invented-repair",
      repairKind: "review-fix",
      headSha: HEAD,
      baseHeadSha: BASE_2,
    },
  } });
  const replay = await requestRecoveryRepair(seeded.gateTask.id, "recovery-repair-1");
  const replayResult = await replay.json();
  assert.equal(replay.status, 200, JSON.stringify(replayResult));
  assert.deepEqual(replayResult, result);
  assert.equal(await db.task.count({ where: { projectId: seeded.project.id, name: "Autonomous merge tail: review-fix" } }), 1);
  return { ...seeded, repair };
};

test("operator recovery repair reentry carries a direct Regression rerun through authorization", async () => {
  const seeded = await openRecoveryRepair("canonical-direct", "operator-repair-direct");
  await completeQueuedTask(seeded.repair.id, HEAD_2);
  const repairResult = latestMarker(await readMarkers(db, seeded.gateTask.id), "repairResult");
  assert.equal(repairResult?.repairTaskId, seeded.repair.id);
  assert.equal(repairResult?.resolvedHeadSha, HEAD_2);
  const rerun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.gateTask.id, status: "QUEUED" },
    orderBy: { runNumber: "desc" },
  });
  assert.equal((await db.mergeRecoveryAttempt.findUniqueOrThrow({
    where: { id: seeded.aggregateId },
  })).recoveryRunId, rerun.id);

  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, {
    task: seeded.gateTask,
    run: {
      id: rerun.id,
      agentId: seeded.agent.id,
      branch: "agentos/chain/recovery",
      headSha: HEAD_2,
      sessionId: seeded.gateSession.id,
    },
    qualifiedVerdict: {
      schemaVersion: 1,
      outcome: "pass",
      headSha: HEAD_2,
      baseHeadSha: BASE_2,
      gateVerdict: "PASS",
    },
    now: new Date(),
  })), "advance");
  assert.equal((await db.mergeRecoveryAttempt.findUniqueOrThrow({
    where: { id: seeded.aggregateId },
  })).status, "AWAITING_AUTHORIZATION");
});

test("operator recovery repair reentry carries the Documentation hop and surfaces a fresh second FAIL", async () => {
  const seeded = await openRecoveryRepair("canonical-compound-readiness", "operator-repair-documentation");
  assert.ok(seeded.documentation);
  await completeQueuedTask(seeded.repair.id, HEAD_2);
  assert.equal((await db.mergeRecoveryAttempt.findUniqueOrThrow({
    where: { id: seeded.aggregateId },
  })).recoveryRunId, seeded.recoveryRun.id);
  await completeQueuedTask(seeded.documentation.id, HEAD_2, {
    kind: "documentation",
    body: JSON.stringify({
      schemaVersion: 1,
      headSha: HEAD_2,
      summary: "Documentation refreshed for the recovery repair.",
      changes: [],
    }),
  });
  const rerun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.gateTask.id, status: "QUEUED" },
    orderBy: { runNumber: "desc" },
  });
  assert.equal((await db.mergeRecoveryAttempt.findUniqueOrThrow({
    where: { id: seeded.aggregateId },
  })).recoveryRunId, rerun.id);

  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, {
    task: seeded.gateTask,
    run: {
      id: rerun.id,
      agentId: seeded.agent.id,
      branch: "agentos/chain/recovery",
      headSha: HEAD_2,
      sessionId: seeded.gateSession.id,
    },
    qualifiedVerdict: {
      schemaVersion: 1,
      outcome: "review-fail",
      headSha: HEAD_2,
      baseHeadSha: BASE_2,
      summary: "the completed repair exposed a second current defect",
    },
    now: new Date(),
  })), "handled");
  assert.equal((await db.mergeRecoveryAttempt.findUniqueOrThrow({
    where: { id: seeded.aggregateId },
  })).status, "BLOCKED_DOWNSTREAM");
  const notices = await db.inboxMessage.findMany({
    where: { taskId: seeded.gateTask.id },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(notices.length, 2);
  assert.match(notices[1]!.body, /second current defect/u);
  assert.match(notices[1]!.dedupeKey ?? "", new RegExp(`${rerun.id}$`, "u"));
});

test("an operator rerun requeues a host-caused gate FAIL without opening a repair", async () => {
  const seeded = await prepareBlockedRecovery("canonical-direct", "operator-rerun-gate-fail", "gate-fail");
  const stopped = await db.task.findUniqueOrThrow({ where: { id: seeded.gateTask.id } });
  assert.equal(stopped.status, TaskStatus.REVIEW);
  assert.match(stopped.failureReason ?? "", /merge gate FAIL/u);
  const blocked = await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: seeded.aggregateId } });

  const result = await acceptedRerun(seeded.gateTask.id, "recovery-rerun-1");
  assert.notEqual(result.aggregateId, seeded.aggregateId);
  assert.deepEqual(
    { attempt: result.attempt, headSha: result.headSha, baseHeadSha: result.baseHeadSha },
    { attempt: blocked.attempt + 1, headSha: HEAD, baseHeadSha: BASE_2 },
  );

  const reran = await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: result.aggregateId } });
  assert.equal(reran.status, "REPAIRING");
  assert.equal(reran.failureReason, null);
  assert.equal(reran.sourceStopId, blocked.sourceStopId);
  assert.equal(reran.authorizedHeadSha, blocked.authorizedHeadSha);
  assert.equal(reran.currentBaseSha, blocked.currentBaseSha);
  assert.equal(reran.recoveryRunId, result.recoveryRunId);
  assert.equal((await db.mergeRecoveryAttempt.findUniqueOrThrow({
    where: { id: seeded.aggregateId },
  })).status, "BLOCKED_DOWNSTREAM");

  const queued = await db.run.findUniqueOrThrow({ where: { id: result.recoveryRunId } });
  assert.equal(queued.status, "QUEUED");
  assert.equal(queued.taskId, seeded.gateTask.id);
  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.gateTask.id } });
  assert.equal(regression.status, TaskStatus.TODO);
  assert.equal(regression.failureReason, null);
  assert.equal((await db.task.findUniqueOrThrow({
    where: { id: seeded.readinessTask!.id },
  })).failureReason, null);
  assert.deepEqual(await repairSpend(seeded), { repairTasks: 0, repairAttempts: 0 });

  const activity = await db.taskActivity.findFirstOrThrow({
    where: { taskId: seeded.gateTask.id, actorType: "operator" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const metadata = activity.metadata as Record<string, unknown>;
  assert.match(activity.body, /Operator re-ran recovery attempt 2/u);
  assert.deepEqual(
    {
      action: metadata.action,
      requestId: metadata.requestId,
      reason: metadata.reason,
      attempt: metadata.attempt,
      aggregateId: metadata.aggregateId,
    },
    {
      action: "merge-tail-rerun-request",
      requestId: "recovery-rerun-1",
      reason: "the failing test is not in this branch's change set",
      attempt: result.attempt,
      aggregateId: result.aggregateId,
    },
  );

  const replay = await requestRecoveryRerun(seeded.gateTask.id, "recovery-rerun-1");
  assert.equal(replay.status, 200, await replay.text());
  assert.deepEqual(await replay.json(), result);
  assert.equal(await db.mergeRecoveryAttempt.count({
    where: { integratorTaskId: seeded.integratorTask!.id },
  }), 2);
  assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id, status: "QUEUED" } }), 1);
});

test("an operator rerun refuses a semantic recovery FAIL", async () => {
  const seeded = await prepareBlockedRecovery("canonical-direct", "operator-rerun-review-fail");
  await refusedRerun(seeded.gateTask.id, "recovery-rerun-1", "merge_tail_rerun_verdict_not_gate_fail");
  assert.equal(await db.mergeRecoveryAttempt.count({
    where: { integratorTaskId: seeded.integratorTask!.id },
  }), 1);
  assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id, status: "QUEUED" } }), 0);
});

test("an operator rerun refuses a tail that still has an active Run", async () => {
  const seeded = await prepareBlockedRecovery("canonical-direct", "operator-rerun-active-run", "gate-fail");
  await db.run.update({ where: { id: seeded.recoveryRun.id }, data: { status: "RUNNING" } });
  await refusedRerun(seeded.gateTask.id, "recovery-rerun-1", "merge_tail_rerun_active_run");
  assert.equal(await db.mergeRecoveryAttempt.count({
    where: { integratorTaskId: seeded.integratorTask!.id },
  }), 1);
});

test("a third operator rerun of one recovery stop is refused as budget exhausted", async () => {
  const seeded = await prepareBlockedRecovery("canonical-direct", "operator-rerun-budget", "gate-fail");
  const first = await acceptedRerun(seeded.gateTask.id, "recovery-rerun-1");
  await failRecoveryRegression(seeded, first.aggregateId, "gate-fail");
  const second = await acceptedRerun(seeded.gateTask.id, "recovery-rerun-2");
  assert.equal(second.attempt, first.attempt + 1);
  await failRecoveryRegression(seeded, second.aggregateId, "gate-fail");

  await refusedRerun(seeded.gateTask.id, "recovery-rerun-3", "merge_tail_rerun_budget_exhausted");
  assert.equal(await db.mergeRecoveryAttempt.count({
    where: { integratorTaskId: seeded.integratorTask!.id },
  }), 3);
  assert.equal((await db.mergeRecoveryAttempt.findUniqueOrThrow({
    where: { id: second.aggregateId },
  })).status, "BLOCKED_DOWNSTREAM");
  assert.deepEqual(await repairSpend(seeded), { repairTasks: 0, repairAttempts: 0 });
});

test("the durable reader selects the direct and compound recovery facts", async () => {
  for (const shape of ["canonical-direct", "canonical-compound-readiness"] as const) {
    const seeded = await seedStopped(shape, `reader-${shape}`);
    const facts = await readCandidateFacts(db, seeded.integratorTask!.id);

    assert.deepEqual(facts.task, {
      id: seeded.integratorTask!.id,
      chainId: seeded.integratorTask!.chainId,
      chainIndex: seeded.integratorTask!.chainIndex,
      repoId: seeded.repo.id,
      repositoryPresent: true,
      status: "REVIEW",
      isIntegratorStep: true,
    });
    assert.equal(facts.stop?.sourceRunId, seeded.sourceRun.id);
    assert.equal(facts.sourceRun?.id, seeded.sourceRun.id);
    assert.deepEqual(facts.output, {
      runId: seeded.sourceRun.id,
      kind: "merge-result",
      outcome: "stopped",
      condition: "base-drift",
      evidence: JSON.stringify({ observed: BASE_2, authorized: BASE }),
    });
    assert.equal(facts.readiness?.id, seeded.readinessTask!.id);
    assert.equal(facts.regression?.id, seeded.gateTask.id);
    assert.equal(facts.authorizationSelection?.authorization?.activityId, seeded.authorization.id);
    assert.equal(facts.intents?.length, 1);
    assert.deepEqual(facts.target, { resolved: true, repository: "acme/widgets", prNumber: 123 });
    assert.equal(facts.firstRunTargetRef, "master");
    assert.deepEqual(classifyCandidate(facts), {
      kind: "inspect",
      candidate: {
        integratorTaskId: seeded.integratorTask!.id,
        readinessTaskId: seeded.readinessTask!.id,
        regressionTaskId: seeded.gateTask.id,
        sourceRunId: seeded.sourceRun.id,
        stopId: facts.stop!.stopId,
        authorizationActivityId: seeded.authorization.id,
        repository: "acme/widgets",
        prNumber: 123,
        targetBranch: "master",
        authorizedHeadSha: HEAD,
        authorizedBaseSha: BASE,
        observedBaseSha: BASE_2,
      },
    });
    await resetTestDb(db);
  }
});

test("recovery activation returns a typed stale-authorization refusal", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "typed-activation-refusal");
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  const aggregate = await db.mergeRecoveryAttempt.findFirstOrThrow({
    where: { integratorTaskId: seeded.integratorTask!.id },
  });
  assert.ok(aggregate.recoveryRunId);
  await db.mergeRecoveryAttempt.update({
    where: { id: aggregate.id },
    data: { status: "AWAITING_AUTHORIZATION" },
  });
  await db.task.update({
    where: { id: seeded.readinessTask!.id },
    data: { status: TaskStatus.DONE },
  });
  const binding = `mechanical:${seeded.readinessTask!.id}:${randomUUID()}`;
  const activity = await db.taskActivity.create({ data: {
    taskId: seeded.readinessTask!.id,
    actorType: "control-plane",
    body: "stale recovery authorization",
    metadata: {
      ...authorizationMetadata({
        schemaVersion: 1,
        nonce: randomUUID(),
        repository: aggregate.repository!,
        prNumber: aggregate.prNumber!,
        headSha: HEAD_2,
        baseRef: aggregate.targetBranch!,
        baseSha: aggregate.currentBaseSha!,
        mergeMethod: AUTHORIZED_MERGE_METHOD,
        requiredChecks: [],
        readAt: new Date().toISOString(),
        issuedAt: new Date().toISOString(),
        decision: { channel: "mechanical", inboxDecisionId: binding, inboxMessageId: binding },
      }),
      recoverySourceStopId: aggregate.sourceStopId,
    } as Prisma.InputJsonObject,
  } });
  await db.taskStepOutput.upsert({
    where: { taskId: seeded.readinessTask!.id },
    create: {
      taskId: seeded.readinessTask!.id,
      kind: "merge-authorization",
      body: JSON.stringify({ authorizationActivityId: activity.id, headSha: HEAD_2 }),
      commitSha: HEAD_2,
    },
    update: {
      kind: "merge-authorization",
      body: JSON.stringify({ authorizationActivityId: activity.id, headSha: HEAD_2 }),
      commitSha: HEAD_2,
    },
  });

  assert.deepEqual(await db.$transaction((tx) => activateRecoveryIntegratorSuccessor(tx, {
    readinessTaskId: seeded.readinessTask!.id,
    integratorTaskId: seeded.integratorTask!.id,
    sourceStopId: aggregate.sourceStopId,
    recoveryRunId: aggregate.recoveryRunId!,
    authorizationActivityId: activity.id,
  })), {
    outcome: "refused",
    refusalCode: MergeRecoveryRefusalCode.ACTIVATION_AUTHORIZATION_STALE,
  });
  assert.equal(await db.run.count({
    where: { taskId: seeded.integratorTask!.id, status: "QUEUED" },
  }), 0);
});

test("readiness records and reopens a head-adoption refusal by code, independent of its text", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "typed-head-adoption-refusal");
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  await recordRecoveryPass(seeded, BASE_3, HEAD_2);
  const aggregate = await db.mergeRecoveryAttempt.findFirstOrThrow({
    where: { integratorTaskId: seeded.integratorTask!.id },
  });
  const mutateBeforeLeaseCallback: WithMergeLease = async (target, fn, leaseDb) => {
    await leaseDb.mergeRecoveryAttempt.update({
      where: { id: aggregate.id },
      data: { currentBaseSha: BASE_4 },
    });
    return withMergeLease(target, fn, leaseDb, {
      acquire: acquireChainLease,
      release: releaseLeaseAdapter,
    });
  };

  assert.deepEqual(await readinessTick(
    db,
    reader(snapshot(BASE_3, { headRefOid: HEAD_2, headCommitOid: HEAD_2 })),
    new Date(),
    5,
    releaseChainLease,
    mutateBeforeLeaseCallback,
  ), { claimed: 1, authorized: 0, requeued: 0, stopped: 1 });
  const stopped = await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: aggregate.id } });
  assert.equal(stopped.status, "BLOCKED_DOWNSTREAM");
  assert.equal(stopped.refusalCode, MergeRecoveryRefusalCode.HEAD_ADOPTION_CONFLICT);
  assert.equal(
    stopped.failureReason,
    "readiness evaluation failed: Recovery authorization could not adopt the verified regression head",
  );

  await db.mergeRecoveryAttempt.update({
    where: { id: aggregate.id },
    data: { failureReason: "operator-facing recovery detail changed" },
  });
  assert.equal(await reopenRecoveryHeadAdoptionFailures(db), 1);
  assert.equal(await reopenRecoveryHeadAdoptionFailures(db), 0);
  const reopened = await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: aggregate.id } });
  assert.equal(reopened.status, "REPAIRING");
  assert.equal(reopened.refusalCode, null);
});

test("recovery holds the full chain mutex before mutation and a concurrent chain writer completes without deadlock or lost recovery", { timeout: 20_000 }, async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "recovery-lock-order");

  let lockObserved!: () => void;
  let releaseRecovery!: () => void;
  const recoveryHasChain = new Promise<void>((resolve) => { lockObserved = resolve; });
  const release = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  let paused = false;
  const recoveryDb = new Proxy(db, { get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) => target.$transaction(async (tx) => {
      const instrumented = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const result = await (tx.$queryRaw as (...args: unknown[]) => Promise<unknown>)(strings, ...values);
          if (!paused && strings.join("?").includes('ORDER BY "chainLayer"')) {
            paused = true;
            lockObserved();
            await release;
          }
          return result;
        };
      } });
      return operation(instrumented);
    }, options as never);
  } }) as PrismaClient;
  const writerDb = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  const priorToken = process.env.OPERATOR_TOKEN;
  try {
    const recovery = baseDriftRecoveryTick(recoveryDb, reader(snapshot(BASE_2)));
    await recoveryHasChain;
    process.env.OPERATOR_TOKEN = OPERATOR;
    const writer = createApp(writerDb).request(`/tasks/${seeded.integratorTask!.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      body: JSON.stringify({ description: "concurrent writer completed after recovery" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseRecovery();
    const [tick, response] = await Promise.all([recovery, writer]);
    assert.equal(tick.recovered, 1);
    assert.equal(response.status, 200, await response.text());
  } finally {
    if (priorToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = priorToken;
    await writerDb.$disconnect();
  }
  assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id, status: "QUEUED" } }), 1);
  assert.equal((await db.mergeRecoveryAttempt.findFirstOrThrow({
    where: { integratorTaskId: seeded.integratorTask!.id },
  })).status, "REPAIRING");
  assert.equal((await db.task.findUniqueOrThrow({
    where: { id: seeded.integratorTask!.id },
  })).description, "concurrent writer completed after recovery");
});

test("duplicate ticks and output replay upsert one recovery", async () => {
  for (const shape of ["canonical-direct", "canonical-compound-readiness"] as const) {
    const seeded = await seedStopped(shape, `idempotent-${shape}`);
    const ticks = await Promise.all(
      Array.from({ length: 6 }, () => baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))),
    );
    assert.equal(ticks.reduce((sum, tick) => sum + tick.recovered, 0), 1);
    assert.equal(await db.mergeRecoveryAttempt.count({
      where: { integratorTaskId: seeded.integratorTask!.id },
    }), 1);
    assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id } }), 2);

    const replayed = await db.taskStepOutput.findUniqueOrThrow({
      where: { taskId: seeded.integratorTask!.id },
    });
    await db.taskStepOutput.update({ where: { id: replayed.id }, data: { body: replayed.body } });
    await reconcileDatabaseRuns(db, new Date());
    await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)));
    assert.equal(await db.mergeRecoveryAttempt.count({
      where: { integratorTaskId: seeded.integratorTask!.id },
    }), 1);
    assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id } }), 2);
    await resetTestDb(db);
  }
});

test("the aggregate rejects a duplicate source-stop attempt identity", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "aggregate-unique");
  const stop = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.integratorTask!.id,
    metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.result },
  }, orderBy: { createdAt: "desc" } });
  await db.mergeRecoveryAttempt.create({ data: {
    integratorTaskId: seeded.integratorTask!.id,
    sourceStopId: stop.id,
    attempt: 1,
  } });
  await assert.rejects(
    db.mergeRecoveryAttempt.create({ data: {
      integratorTaskId: seeded.integratorTask!.id,
      sourceStopId: stop.id,
      attempt: 1,
    } }),
    (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
  );
});
