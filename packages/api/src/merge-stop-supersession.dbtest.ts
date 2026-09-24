/**
 * A re-authorized merge stop is superseded by a fresh mechanical authorization.
 *
 * The observed sequence: merge execution stopped on `api-error`, the operator
 * answered `re-authorize`, rejected the stale confirmation card, and the chain
 * went back through Regression. Readiness then re-verified the new head and
 * authorized it mechanically, yet the integrator's Run birth was refused on the
 * old stop and a second-generation confirmation card went to the human. The
 * fresh authorization is exactly the evidence `re-authorize` asked for, so it
 * must queue merge execution itself; an unanswered stop must still refuse.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  AUTHORIZED_MERGE_METHOD,
  MERGE_INTEGRATOR_KIND,
  Prisma,
  PrismaClient,
  RunStatus,
  TaskStatus,
  advanceTemplateTask,
  applyInboxDecisionTx,
  authorizationMetadata,
  recordIntegratorStop,
} from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";

import type { PullRequestReader, PullRequestSnapshot } from "./github-read.js";
import { evidenceTick } from "./merge-evidence-worker.js";
import { executorsOnline } from "./merge-executor-daemon-fixture.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import {
  withMergeLease,
  type MergeLeaseAcquirer,
  type MergeLeaseReleaser,
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";
import { readinessTick } from "./merge-readiness-worker.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const HEAD = "a".repeat(40);
const HEAD_2 = "d".repeat(40);
const BASE = "b".repeat(40);
const BASE_2 = "c".repeat(40);
const OPERATOR = "stop-supersession-operator";
const RUNNER = "stop-supersession-runner";
const EXECUTOR = "stop-supersession-executor";
const EXECUTOR_RUNNER_ID = "merge-executor-1";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const snapshot = (headSha: string, baseSha: string): PullRequestSnapshot => ({
  repository: "acme/widgets", number: 123, state: "OPEN", isDraft: false, merged: false,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "master", baseSha,
  headRefOid: headSha, headCommitOid: headSha, autoMergeRequest: null, mergeQueueEntry: null,
  repositoryMergeQueue: null, mergedBy: null, mergeCommit: null, requiredCheckNames: [],
  checkContexts: [], readAt: new Date("2026-09-24T08:00:00.000Z").toISOString(),
});

const reader = (current: PullRequestSnapshot): PullRequestReader => ({
  readPullRequest: async () => current,
  compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
});

const acquire: MergeLeaseAcquirer = async () => ({ outcome: "acquired" });
const release: MergeLeaseReleaser = async () => ({ outcome: "not-held" });
const releaseChainLease: ReleaseMergeLease = async () => {};
const leased: WithMergeLease = async (target, fn, leaseDb) => withMergeLease(target, fn, leaseDb, { acquire, release });

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

type Seeded = Awaited<ReturnType<typeof seedIntegratorChain>>;

/** The mechanical authorization readiness wrote before the first merge Run. */
const authorize = async (readinessTaskId: string) => {
  const binding = `mechanical:${readinessTaskId}:${randomUUID()}`;
  const activity = await db.taskActivity.create({ data: {
    taskId: readinessTaskId,
    actorType: "control-plane",
    body: `authorized ${HEAD}`,
    metadata: authorizationMetadata({
      schemaVersion: 1, nonce: randomUUID(), repository: "acme/widgets", prNumber: 123,
      headSha: HEAD, baseRef: "master", baseSha: BASE, mergeMethod: AUTHORIZED_MERGE_METHOD,
      requiredChecks: [], readAt: new Date().toISOString(), issuedAt: new Date().toISOString(),
      decision: { channel: "mechanical", inboxDecisionId: binding, inboxMessageId: binding },
    }) as Prisma.InputJsonObject,
  } });
  const output = { kind: "merge-authorization", body: JSON.stringify({ authorizationActivityId: activity.id, headSha: HEAD }), commitSha: HEAD };
  await db.taskStepOutput.upsert({ where: { taskId: readinessTaskId }, create: { taskId: readinessTaskId, ...output }, update: output });
};

/** Merge execution Run 1, ending in an `api-error` stop with its question open. */
const apiErrorStop = async (seeded: Seeded) => {
  const integratorTaskId = seeded.integratorTask!.id;
  const run = await db.run.create({ data: {
    projectId: seeded.project.id, taskId: integratorTaskId, agentId: seeded.integratorAgent.id,
    repoId: seeded.repo.id, runNumber: 1, dedupeKey: `task:${integratorTaskId}:run:1`,
    runner: "CLAUDE", model: "mechanical/merge-executor-v1", promptHash: "mechanical",
    status: RunStatus.SUCCEEDED, opensPullRequest: false, maxRunsPerTask: 5, targetBranch: "master",
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, taskId: integratorTaskId,
    agentId: seeded.integratorAgent.id, runner: "CLAUDE", executionStatus: "SUCCEEDED",
  } });
  const evidence = JSON.stringify({ reason: "GitHub API 502 while reading the pull request" });
  const outputBody = JSON.stringify({ outcome: "stopped", condition: "api-error", evidence });
  await db.taskStepOutput.upsert({
    where: { taskId: integratorTaskId },
    create: { taskId: integratorTaskId, runId: run.id, kind: "merge-result", body: outputBody },
    update: { runId: run.id, kind: "merge-result", body: outputBody },
  });
  const stop = await db.$transaction((tx) => recordIntegratorStop(tx, {
    integratorTaskId, condition: "api-error", evidence, sourceRunId: run.id,
  }));
  assert.ok(stop.questionId, "api-error opens its stop question");
  return stop;
};

/** Regression reruns on the rejected card's redo and passes on the moved base. */
const regressionPasses = async (seeded: Seeded) => {
  const run = await db.run.findFirstOrThrow({ where: { taskId: seeded.gateTask.id }, orderBy: { runNumber: "desc" } });
  assert.equal(run.status, RunStatus.QUEUED, "the rejected confirmation queued the Regression redo");
  await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, agentId: run.agentId, taskId: seeded.gateTask.id,
    runner: "CLAUDE", executionStatus: "SUCCEEDED",
  } });
  await db.run.update({ where: { id: run.id }, data: { status: RunStatus.SUCCEEDED, headSha: HEAD_2 } });
  const body = JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: HEAD_2, baseHeadSha: BASE_2, gateVerdict: "PASS" });
  await db.taskStepOutput.upsert({
    where: { taskId: seeded.gateTask.id },
    create: { taskId: seeded.gateTask.id, runId: run.id, kind: "regression-verification", body, commitSha: HEAD_2 },
    update: { runId: run.id, kind: "regression-verification", body, commitSha: HEAD_2 },
  });
  await db.task.update({ where: { id: seeded.gateTask.id }, data: { status: TaskStatus.DONE } });
  await db.$transaction((tx) => advanceTemplateTask(tx, seeded.gateTask.id, run.id, null, new Date()));
};

const readinessAuthorizes = () => readinessTick(
  db, reader(snapshot(HEAD_2, BASE_2)), new Date(), 5, releaseChainLease, leased, executorsOnline,
);

test("a fresh mechanical authorization supersedes a re-authorized api-error stop without a confirmation card", async () => {
  const seeded = await seedIntegratorChain(db, { label: "stop-supersession", shape: "canonical-compound-readiness" });
  const readinessTaskId = seeded.readinessTask!.id;
  const integratorTaskId = seeded.integratorTask!.id;
  await authorize(readinessTaskId);
  const stop = await apiErrorStop(seeded);

  // 07:23:59 — the operator answers re-authorize; confirmation G0 is requested.
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: stop.questionId!, externalEventId: "evt-supersede-reauthorize", decision: "re-authorize",
  }));
  const g0Key = `confirmation:${integratorTaskId}:${stop.stopId}`;
  const g0 = await db.inboxMessage.findUniqueOrThrow({ where: { dedupeKey: g0Key } });
  await evidenceTick(db, { readPullRequest: async () => snapshot(HEAD, BASE_2) }, new Date());

  // Base drifted, so the operator rejects G0 and the chain returns to Regression.
  const rejected = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: g0.id, externalEventId: "evt-supersede-reject", decision: "reject",
  }));
  assert.equal(rejected.gateAction, "rejected");
  await regressionPasses(seeded);

  // 08:39:52 — readiness re-verifies the new head and authorizes it mechanically.
  assert.deepEqual(await readinessAuthorizes(), { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });

  const runs = await db.run.findMany({ where: { taskId: integratorTaskId }, orderBy: { runNumber: "asc" } });
  assert.equal(runs.length, 2, "merge execution is queued despite the old stop");
  assert.equal(runs[1]!.status, RunStatus.QUEUED);
  assert.equal(
    await db.inboxMessage.count({ where: { dedupeKey: { startsWith: `${g0Key}:r` } } }), 0,
    "no next-generation confirmation card reaches the human",
  );
  assert.equal(
    await db.inboxMessage.count({ where: { dedupeKey: `run-birth-refusal:${integratorTaskId}:integrator-stopped` } }), 0,
    "Run birth was not refused",
  );
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: g0.id } })).status, "ANSWERED");
  const superseded = await db.taskActivity.findMany({
    where: { taskId: integratorTaskId, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.stopSuperseded } },
  });
  assert.equal(superseded.length, 1, "the supersession is recorded once");
  assert.equal(superseded[0]!.actorType, "control-plane");
  const metadata = superseded[0]!.metadata as Record<string, unknown>;
  assert.equal(metadata.stopId, stop.stopId);
  assert.equal(metadata.condition, "api-error");
  assert.equal(metadata.headSha, HEAD_2);
  assert.equal(metadata.baseSha, BASE_2);
  assert.equal(metadata.runId, runs[1]!.id);
  assert.equal(
    await db.taskActivity.count({
      where: { taskId: integratorTaskId, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.stopAnswer } },
    }),
    1,
    "no stop answer or disposition is synthesized (ADR-0011)",
  );

  // The queued Run is claimable and merges, which terminates the old stop.
  const claimed = await call("POST", "/runner/tasks/claim", {
    runnerId: EXECUTOR_RUNNER_ID, contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
  }, EXECUTOR);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.run.id, runs[1]!.id);
  const output = await call("PUT", `/session/runs/${runs[1]!.id}/output`, {
    fencingToken: claimed.body.fencingToken, kind: "merge-result",
    body: JSON.stringify({ outcome: "merged", mergeCommitSha: "e".repeat(40) }),
  }, claimed.body.sessionToken);
  assert.equal(output.status, 200, JSON.stringify(output.body));
  const completed = await call("POST", `/runner/runs/${runs[1]!.id}/complete`, {
    runnerId: EXECUTOR_RUNNER_ID, fencingToken: claimed.body.fencingToken, exitCode: 0,
    outcome: { case: "succeeded" }, cleanupStatus: "SUCCEEDED",
  }, EXECUTOR);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: integratorTaskId } })).status, TaskStatus.DONE);
});

test("an unanswered stop still refuses the birth after a mechanical authorization", async () => {
  const seeded = await seedIntegratorChain(db, { label: "stop-unanswered", shape: "canonical-compound-readiness" });
  const readinessTaskId = seeded.readinessTask!.id;
  const integratorTaskId = seeded.integratorTask!.id;
  await authorize(readinessTaskId);
  const stop = await apiErrorStop(seeded);

  // Readiness runs again without anyone answering the stop question.
  const regression = await db.run.findFirstOrThrow({ where: { taskId: seeded.gateTask.id }, orderBy: { runNumber: "desc" } });
  await db.run.create({ data: {
    projectId: seeded.project.id, taskId: seeded.gateTask.id, agentId: regression.agentId, repoId: seeded.repo.id,
    runNumber: regression.runNumber + 1, dedupeKey: `task:${seeded.gateTask.id}:run:${String(regression.runNumber + 1)}`,
    runner: "CLAUDE", model: regression.model, promptHash: "hash", status: RunStatus.QUEUED,
    opensPullRequest: false, maxRunsPerTask: 5, targetBranch: "master",
  } });
  await db.task.update({ where: { id: readinessTaskId }, data: { status: TaskStatus.TODO } });
  await regressionPasses(seeded);
  assert.deepEqual(await readinessAuthorizes(), { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });

  assert.equal(await db.run.count({ where: { taskId: integratorTaskId } }), 1, "the unanswered stop still guards");
  assert.equal(
    await db.taskActivity.count({
      where: { taskId: integratorTaskId, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.stopSuperseded } },
    }),
    0,
  );
  assert.equal(
    (await db.inboxMessage.findUniqueOrThrow({ where: { id: stop.questionId! } })).status, "OPEN",
    "the operator's stop question remains the exit",
  );
  assert.equal(await db.inboxMessage.count({ where: { dedupeKey: { startsWith: `confirmation:${integratorTaskId}:` } } }), 0);
});
