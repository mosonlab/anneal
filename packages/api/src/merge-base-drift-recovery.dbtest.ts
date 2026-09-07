import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  AUTHORIZED_MERGE_METHOD,
  activateRecoveryIntegratorSuccessor,
  applyInboxDecisionTx,
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
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";

import { classifyCandidate } from "./base-drift-recovery-decision.js";
import {
  baseDriftRecoveryTick,
  readCandidateFacts,
  recordRecoveryClassificationRetry,
} from "./merge-base-drift-worker.js";
import { handleRegressionCompletion } from "./merge-tail-actions.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { claimRun } from "./run-claim.js";
import {
  withMergeLease,
  type MergeLeaseAcquirer,
  type MergeLeaseReleaser,
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";
import { executorsOnline } from "./merge-executor-daemon-fixture.js";
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

test("a fresh base-drift recovery claim carries its pre-recovery Regression output snapshot", async () => {
  const seeded = await seedStopped("canonical-direct", "recovery-claim-context");
  const priorBody = JSON.stringify({
    schemaVersion: 2,
    outcome: "pass",
    headSha: HEAD,
    baseHeadSha: BASE,
    gateVerdict: "PASS",
    gateProof: `MERGE GATE: PASS ${HEAD}`,
  });
  await db.taskStepOutput.upsert({
    where: { taskId: seeded.gateTask.id },
    create: {
      taskId: seeded.gateTask.id,
      runId: seeded.gateRun.id,
      kind: "regression-verification-v2",
      body: priorBody,
      commitSha: HEAD,
    },
    update: {
      runId: seeded.gateRun.id,
      kind: "regression-verification-v2",
      body: priorBody,
      commitSha: HEAD,
    },
  });

  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  const aggregate = await db.mergeRecoveryAttempt.findFirstOrThrow({
    where: { integratorTaskId: seeded.integratorTask!.id },
  });
  const recoveryRunId = aggregate.recoveryRunId;
  assert.ok(recoveryRunId);
  assert.equal(await db.taskStepOutput.findUnique({ where: { taskId: seeded.gateTask.id } }), null);

  const claimed = await claimRun(db, {
    body: {
      runnerId: "recovery-context-runner",
      leaseSeconds: 60,
      contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
    },
    claimantClass: "runner",
    now: new Date(),
    specificationReader: null,
  });
  assert.ok(claimed && "run" in claimed, JSON.stringify(claimed));
  assert.equal(claimed.run.id, recoveryRunId);
  assert.deepEqual(claimed.regressionRecoveryContext, {
    state: "queued",
    currentBaseSha: BASE_2,
    authorizedHeadSha: HEAD,
    recoveryRunId,
    priorOutput: {
      runId: seeded.gateRun.id,
      kind: "regression-verification-v2",
      body: priorBody,
      commitSha: HEAD,
    },
  });
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
  // The rerun answers a host failure, not an agent attempt, so it carries its
  // own budget grant: a Run born past the ceiling is killed at claim as
  // `budget-exhausted` long after this route answered 200.
  const priorRun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.gateTask.id, id: { not: queued.id } },
    orderBy: { runNumber: "desc" },
  });
  assert.equal(queued.budgetGrants, priorRun.budgetGrants + 1);
  assert.ok(
    queued.runNumber <= queued.maxRunsPerTask,
    `rerun Run ${String(queued.runNumber)} exceeds ceiling ${String(queued.maxRunsPerTask)}`,
  );
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

  assert.deepEqual(await acceptedRerun(seeded.gateTask.id, "recovery-rerun-1"), result);
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
    executorsOnline,
  ), { claimed: 1, authorized: 0, requeued: 0, stopped: 1 });
  const stopped = await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: aggregate.id } });
  assert.equal(stopped.status, "BLOCKED_DOWNSTREAM");
  assert.equal(stopped.refusalCode, MergeRecoveryRefusalCode.HEAD_ADOPTION_CONFLICT);
  // A refusal carries a code and is a decision, so it stops on its first
  // occurrence rather than spending an exception requeue.
  assert.equal(await db.taskActivity.count({ where: {
    taskId: seeded.gateTask.id,
    metadata: { path: ["state"], equals: "requeued-exception" },
  } }), 0);
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

// ---------------------------------------------------------------------------
// Retry classes: waiting, transport and validation are accounted separately,
// and only validation spends the counted budget.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-09-01T00:00:00.000Z");
const at = (milliseconds: number): Date => new Date(T0.getTime() + milliseconds);

const failingReader = (): PullRequestReader => ({
  readPullRequest: async () => { throw new Error("upstream unavailable"); },
  compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
});

const attemptFor = async (integratorTaskId: string) => db.mergeRecoveryAttempt.findFirstOrThrow({
  where: { integratorTaskId },
});

const recoveryMarkers = async (integratorTaskId: string, state: string) => (
  (await readMarkers(db, integratorTaskId)).filter((marker) => (
    marker.kind === "baseDriftRecovery" && marker.state === state
  ))
);

const stopIdOf = async (integratorTaskId: string): Promise<string> => (
  await db.taskActivity.findFirstOrThrow({
    where: { taskId: integratorTaskId, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.result } },
    orderBy: { createdAt: "desc" },
  })
).id;

const stopCard = async (integratorTaskId: string) => db.inboxMessage.findFirstOrThrow({
  where: { taskId: integratorTaskId, kind: "MULTIPLE_CHOICE" },
  orderBy: { createdAt: "desc" },
});

test("a chain that stays active is waited on, never counted against the validation budget", async () => {
  const seeded = await seedStopped("canonical-direct", "retry-class-waiting");
  // A sibling Run of the same chain is exactly the `chain-active` input: the
  // recovery is not refused, it is simply not classified yet.
  await db.run.create({ data: {
    projectId: seeded.project.id,
    taskId: seeded.gateTask.id,
    agentId: seeded.agent.id,
    repoId: seeded.repo.id,
    runNumber: 99,
    dedupeKey: `task:${seeded.gateTask.id}:run:99`,
    runner: "CLAUDE",
    model: "claude",
    promptHash: "sibling",
    status: "RUNNING",
    opensPullRequest: false,
    maxRunsPerTask: 5,
    targetBranch: "master",
  } });
  const integratorTaskId = seeded.integratorTask!.id;

  const holds: number[] = [];
  for (let tick = 0; tick < 40; tick += 1) {
    // Each tick lands well past the previous hold, so all forty are recorded.
    const now = at(tick * 61_000);
    await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)), now);
    const attempt = await attemptFor(integratorTaskId);
    holds.push(attempt.nextEligibleAt!.getTime() - now.getTime());
  }

  const attempt = await attemptFor(integratorTaskId);
  assert.equal(attempt.status, "VALIDATING", "forty waits never exhaust the recovery");
  assert.equal(attempt.waitingAttempts, 40);
  assert.equal(attempt.validationAttempts, 0, "waiting spends no validation budget");
  assert.equal(attempt.transportAttempts, 0);
  assert.equal(attempt.lastRetryClass, "WAITING");
  assert.equal(attempt.refusalCode, null);
  // The hold doubles from one worker tick and stops at the minute cap.
  assert.deepEqual(holds.slice(0, 6), [2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
  assert.ok(holds.slice(5).every((hold) => hold === 60_000), "the backoff grows to the cap and stays there");
  assert.equal(await db.inboxMessage.count({ where: { taskId: integratorTaskId, kind: "MULTIPLE_CHOICE" } }), 0);

  // Within one hold the recovery is not classified again at all.
  const before = await attemptFor(integratorTaskId);
  await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)), at(39 * 61_000 + 1_000));
  const held = await attemptFor(integratorTaskId);
  assert.equal(held.waitingAttempts, before.waitingAttempts, "a held backoff records nothing");
  assert.equal(held.updatedAt.getTime(), before.updatedAt.getTime());

  const retries = await recoveryMarkers(integratorTaskId, "classification-retry");
  assert.ok(retries.length > 0);
  assert.equal(retries[0]!.raw.retryClass, "waiting");
  assert.equal(retries[0]!.raw.validationAttempts, 0);
  assert.ok(typeof retries[0]!.raw.nextEligibleAt === "string");
  assert.match(retries[0]!.raw.reason as string, /active foreign run/u);
});

test("a waiting ceiling settles under its own refusal, names its class, and re-validate reopens it", async () => {
  const seeded = await seedStopped("canonical-direct", "retry-class-waiting-ceiling");
  const integratorTaskId = seeded.integratorTask!.id;
  await db.run.create({ data: {
    projectId: seeded.project.id,
    taskId: seeded.gateTask.id,
    agentId: seeded.agent.id,
    repoId: seeded.repo.id,
    runNumber: 99,
    dedupeKey: `task:${seeded.gateTask.id}:run:99`,
    runner: "CLAUDE",
    model: "claude",
    promptHash: "sibling",
    status: "RUNNING",
    opensPullRequest: false,
    maxRunsPerTask: 5,
    targetBranch: "master",
  } });

  // The first wait starts the class clock; six hours later the same wait is
  // all the recovery has ever seen, and that is this class's whole budget.
  await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)), T0);
  const waiting = await attemptFor(integratorTaskId);
  assert.equal(waiting.waitingFirstAt!.getTime(), T0.getTime());
  await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)), at(6 * 60 * 60_000));

  const settled = await attemptFor(integratorTaskId);
  assert.equal(settled.status, "FAILED");
  assert.equal(settled.refusalCode, MergeRecoveryRefusalCode.WAITING_CEILING);
  assert.match(
    settled.failureReason!,
    /^waiting-ceiling reached: the chain stayed active for 6h00m \(limit 6h00m\)/u,
  );
  // The failure that crossed the ceiling is accounted, not lost to the settle.
  assert.equal(settled.waitingAttempts, 2);
  assert.equal(settled.validationAttempts, 0, "waiting never spends the counted budget");
  assert.equal(settled.nextEligibleAt, null, "a settled attempt holds no next tick");

  const ceilingMarker = (await recoveryMarkers(integratorTaskId, "waiting-ceiling"))[0];
  assert.ok(ceilingMarker, "the settle names its class in the recovery activity");
  assert.equal(ceilingMarker.raw.retryClass, "waiting");
  assert.equal(ceilingMarker.raw.waitingAttempts, 2, "the activity states the counters the attempt carries");
  assert.equal(ceilingMarker.raw.validationAttempts, 0);
  assert.equal(ceilingMarker.raw.nextEligibleAt, null);
  assert.match(ceilingMarker.raw.reason as string, /waiting-ceiling reached/u);
  const task = await db.task.findUniqueOrThrow({ where: { id: integratorTaskId } });
  assert.equal(task.status, "REVIEW");
  assert.match(task.failureReason!, /^waiting-ceiling reached/u);

  const card = await stopCard(integratorTaskId);
  assert.equal(card.status, "OPEN");
  assert.deepEqual(
    (card.choices as Array<{ id: string }>).map((choice) => choice.id),
    ["re-validate", "abandon"],
  );

  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: card.id, externalEventId: "evt-waiting-re-validate", decision: "re-validate",
  }));
  const reopened = await attemptFor(integratorTaskId);
  assert.equal(reopened.status, "VALIDATING");
  assert.equal(reopened.waitingAttempts, 0, "re-validate resets the class it settled on");
  assert.equal(reopened.waitingFirstAt, null);
  assert.equal(reopened.refusalCode, null);
  assert.equal(reopened.revalidations, 1);
  const revalidated = (await recoveryMarkers(integratorTaskId, "class-revalidated"))[0];
  assert.ok(revalidated);
  assert.equal(revalidated.raw.retryClass, "waiting", "the activity spells the class as every other one does");
  assert.match(
    (await db.task.findUniqueOrThrow({ where: { id: integratorTaskId } })).failureReason!,
    /after its waiting ceiling was reset$/u,
  );
});

test("a transport ceiling settles under its own refusal, and re-validate resumes the same recovery", async () => {
  const seeded = await seedStopped("canonical-direct", "retry-class-transport");
  const integratorTaskId = seeded.integratorTask!.id;

  await baseDriftRecoveryTick(db, failingReader(), T0);
  const held = await attemptFor(integratorTaskId);
  assert.equal(held.status, "VALIDATING");
  assert.equal(held.transportAttempts, 1);
  assert.equal(held.validationAttempts, 0, "an unreadable repository is not a failed validation");
  assert.equal(held.lastRetryClass, "TRANSPORT");
  assert.equal(held.transportFirstAt!.getTime(), T0.getTime());

  // Half an hour of failed reads is this class's whole budget.
  const settledAt = at(30 * 60_000);
  await baseDriftRecoveryTick(db, failingReader(), settledAt);
  const settled = await attemptFor(integratorTaskId);
  assert.equal(settled.status, "FAILED");
  assert.equal(settled.refusalCode, MergeRecoveryRefusalCode.TRANSPORT_CEILING);
  assert.match(settled.failureReason!, /^transport-ceiling reached: repository reads failed for 30m/u);
  // The read failure that crossed the ceiling is accounted, not lost to the settle.
  assert.equal(settled.transportAttempts, 2);
  assert.equal(settled.validationAttempts, 0);
  assert.equal(settled.nextEligibleAt, null, "a settled attempt holds no next tick");

  const ceilingMarker = (await recoveryMarkers(integratorTaskId, "transport-ceiling"))[0];
  assert.ok(ceilingMarker, "the settle names its class in the recovery activity");
  assert.equal(ceilingMarker.raw.retryClass, "transport");
  assert.equal(ceilingMarker.raw.transportAttempts, 2, "the activity states the counters the attempt carries");
  assert.equal(ceilingMarker.raw.validationAttempts, 0);
  assert.equal(ceilingMarker.raw.nextEligibleAt, null);
  assert.match(ceilingMarker.raw.reason as string, /transport-ceiling reached/u);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: integratorTaskId } })).status, "REVIEW");

  const card = await stopCard(integratorTaskId);
  assert.deepEqual(
    (card.choices as Array<{ id: string }>).map((choice) => choice.id),
    ["re-validate", "abandon"],
    "a class ceiling offers the resume as well as abandoning",
  );

  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: card.id, externalEventId: "evt-re-validate", decision: "re-validate",
  }));
  const reopened = await attemptFor(integratorTaskId);
  assert.equal(reopened.status, "VALIDATING");
  assert.equal(reopened.transportAttempts, 0, "re-validate resets the class it settled on");
  assert.equal(reopened.transportFirstAt, null);
  assert.equal(reopened.nextEligibleAt, null);
  assert.equal(reopened.refusalCode, null);
  assert.equal(reopened.failureReason, null);
  assert.equal(reopened.revalidations, 1);
  assert.equal(reopened.attempt, held.attempt, "the same recovery resumes; no chain is re-instantiated");
  const revalidated = (await recoveryMarkers(integratorTaskId, "class-revalidated"))[0];
  assert.ok(revalidated);
  assert.equal(revalidated.raw.retryClass, "transport", "the activity spells the class as every other one does");
  assert.match(
    (await db.task.findUniqueOrThrow({ where: { id: integratorTaskId } })).failureReason!,
    /after its transport ceiling was reset$/u,
  );

  // The resumed recovery classifies normally against a healthy reader.
  const tick = await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)), at(31 * 60_000));
  assert.equal(tick.recovered, 1);
  assert.equal((await attemptFor(integratorTaskId)).status, "REPAIRING");
});

test("validation failures exhaust on count and elapsed time together, and settle under their own refusal", async () => {
  const burst = await seedStopped("canonical-direct", "retry-class-validation-burst");
  const burstTaskId = burst.integratorTask!.id;
  const burstStopId = await stopIdOf(burstTaskId);
  const failure = {
    kind: "retry" as const,
    retryClass: "validation" as const,
    reason: "authorized-base ancestry facts are incomplete",
  };
  for (let index = 0; index < 30; index += 1) {
    const outcome = await recordRecoveryClassificationRetry(
      db, burstTaskId, burstStopId, failure, at(index * 10_000),
    );
    assert.equal(outcome, "retryable", `failure ${String(index + 1)} inside one incident holds the recovery`);
  }
  const burstAttempt = await attemptFor(burstTaskId);
  assert.equal(burstAttempt.status, "VALIDATING", "thirty failures inside five minutes are one incident");
  assert.equal(burstAttempt.validationAttempts, 30);
  assert.equal(burstAttempt.refusalCode, null);
  assert.equal(burstAttempt.nextEligibleAt, null, "a validation failure takes no backoff");

  const spread = await seedStopped("canonical-direct", "retry-class-validation-spread");
  const spreadTaskId = spread.integratorTask!.id;
  const spreadStopId = await stopIdOf(spreadTaskId);
  const outcomes: string[] = [];
  for (let index = 0; index < 30; index += 1) {
    outcomes.push(await recordRecoveryClassificationRetry(
      db, spreadTaskId, spreadStopId, failure, at(index * 65_000),
    ));
  }
  assert.deepEqual(outcomes.slice(0, 29), Array.from({ length: 29 }, () => "retryable"));
  assert.equal(outcomes[29], "ineligible", "the same thirty failures over half an hour do exhaust");

  const spreadAttempt = await attemptFor(spreadTaskId);
  assert.equal(spreadAttempt.status, "FAILED");
  assert.equal(spreadAttempt.refusalCode, MergeRecoveryRefusalCode.VALIDATION_BUDGET);
  assert.match(spreadAttempt.failureReason!, /^validation-budget exhausted: 30 classification failures over 31m/u);
  // The thirtieth failure — the one that exhausted the budget — is accounted,
  // so the stored counter and the refusal text state the same number.
  assert.equal(spreadAttempt.validationAttempts, 30);
  assert.equal(spreadAttempt.nextEligibleAt, null);
  const budgetMarker = (await recoveryMarkers(spreadTaskId, "validation-budget"))[0];
  assert.ok(budgetMarker, "the settle names its class in the recovery activity");
  assert.equal(budgetMarker.raw.retryClass, "validation");
  assert.equal(budgetMarker.raw.validationAttempts, 30, "the activity states the counters the attempt carries");
  assert.equal(budgetMarker.raw.nextEligibleAt, null);
  assert.deepEqual(
    ((await stopCard(spreadTaskId)).choices as Array<{ id: string }>).map((choice) => choice.id),
    ["re-validate", "abandon"],
  );
});

test("a settle after a re-validate opens a fresh answerable card instead of deduplicating into silence", async () => {
  const seeded = await seedStopped("canonical-direct", "retry-class-settle-after-revalidate");
  const integratorTaskId = seeded.integratorTask!.id;
  const stopId = await stopIdOf(integratorTaskId);

  await baseDriftRecoveryTick(db, failingReader(), T0);
  await baseDriftRecoveryTick(db, failingReader(), at(30 * 60_000));
  const ceilingCard = await stopCard(integratorTaskId);
  assert.equal(ceilingCard.dedupeKey, `merge-stop:${stopId}`, "the first settle keeps the historical key");
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: ceilingCard.id, externalEventId: "evt-settle-again", decision: "re-validate",
  }));
  assert.equal(
    (await db.inboxMessage.findUniqueOrThrow({ where: { id: ceilingCard.id } })).status,
    "ANSWERED",
  );

  // The resumed recovery meets a pull request that closed underneath it: an
  // ordinary ineligibility, not a class ceiling.
  await baseDriftRecoveryTick(db, reader(snapshot(BASE_2, { state: "CLOSED" })), at(31 * 60_000));
  const resettled = await attemptFor(integratorTaskId);
  assert.equal(resettled.status, "FAILED");
  assert.equal(resettled.refusalCode, null, "an ordinary ineligibility is not a class ceiling");
  assert.match(resettled.failureReason!, /no longer an unmerged OPEN pull request/u);

  const reopenedCard = await stopCard(integratorTaskId);
  assert.notEqual(reopenedCard.id, ceilingCard.id, "the answered ceiling card does not absorb the second settle");
  assert.equal(reopenedCard.dedupeKey, `merge-stop:${stopId}:r1`);
  assert.equal(reopenedCard.status, "OPEN");
  assert.deepEqual(
    (reopenedCard.choices as Array<{ id: string }>).map((choice) => choice.id),
    ["abandon"],
    "an ordinary refusal keeps the abandon exit the operator needs",
  );
  // The stop notice generations with it, so the second settle is not silent.
  assert.ok(await db.inboxMessage.findFirst({
    where: { dedupeKey: `merge-base-drift-recovery:ineligible:${stopId}:r1` },
  }));

  // And the abandon exit actually answers.
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: reopenedCard.id, externalEventId: "evt-abandon", decision: "abandon",
  }));
  assert.equal(
    (await db.inboxMessage.findUniqueOrThrow({ where: { id: reopenedCard.id } })).status,
    "ANSWERED",
  );
});
