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
  ChainControlState,
  MERGE_INTEGRATOR_KIND,
  Prisma,
  PrismaClient,
  RunStatus,
  TaskStatus,
  advanceTemplateTask,
  applyInboxDecisionTx,
  authorizationMetadata,
  openRun,
  recordIntegratorStop,
  resumeChain,
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

/** Regression reruns without a rejected card: a Run is queued and readiness returns to TODO. */
const redoRegression = async (seeded: Seeded) => {
  const regression = await db.run.findFirstOrThrow({ where: { taskId: seeded.gateTask.id }, orderBy: { runNumber: "desc" } });
  await db.run.create({ data: {
    projectId: seeded.project.id, taskId: seeded.gateTask.id, agentId: regression.agentId, repoId: seeded.repo.id,
    runNumber: regression.runNumber + 1, dedupeKey: `task:${seeded.gateTask.id}:run:${String(regression.runNumber + 1)}`,
    runner: "CLAUDE", model: regression.model, promptHash: "hash", status: RunStatus.QUEUED,
    opensPullRequest: false, maxRunsPerTask: 5, targetBranch: "master",
  } });
  await db.task.update({ where: { id: seeded.readinessTask!.id }, data: { status: TaskStatus.TODO } });
  await regressionPasses(seeded);
};

const supersessions = (integratorTaskId: string) => db.taskActivity.findMany({
  where: { taskId: integratorTaskId, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.stopSuperseded } },
});

/** Run 1 stops on `api-error` and the operator answers `re-authorize`; G0 is requested. */
const reauthorize = async (seeded: Seeded, eventId: string) => {
  const integratorTaskId = seeded.integratorTask!.id;
  await authorize(seeded.readinessTask!.id);
  const stop = await apiErrorStop(seeded);
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: stop.questionId!, externalEventId: eventId, decision: "re-authorize",
  }));
  const g0 = await db.inboxMessage.findUniqueOrThrow({ where: { dedupeKey: `confirmation:${integratorTaskId}:${stop.stopId}` } });
  return { stop, g0 };
};

/** Readiness layer held, so the integrator's Run birth is withheld. */
const holdAtReadinessLayer = async (seeded: Seeded) => {
  const rows = await db.task.findMany({
    where: { projectId: seeded.project.id, chainId: seeded.chainId },
    select: { chainLayer: true, chainIndex: true },
  });
  const layers = [...new Set(rows.map((row) => row.chainLayer ?? row.chainIndex))]
    .filter((layer): layer is number => layer !== null)
    .sort((left, right) => left - right);
  const heldExecutionLayer = seeded.readinessStep!.layer!;
  await db.chainControl.create({ data: {
    projectId: seeded.project.id, chainId: seeded.chainId, state: ChainControlState.HELD,
    heldLayer: layers.indexOf(heldExecutionLayer) + 1, heldExecutionLayer, heldAt: new Date(),
    holdRequestId: "hold-before-merge", holdReason: "inspect before merge", holdGeneration: 1,
  } });
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
  await redoRegression(seeded);
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

/** Re-authorize, reject the drifted G0, and let Regression pass on the new head. */
const rejectedAndRegressed = async (seeded: Seeded, label: string) => {
  const { stop, g0 } = await reauthorize(seeded, `evt-${label}-reauthorize`);
  await evidenceTick(db, { readPullRequest: async () => snapshot(HEAD, BASE_2) }, new Date());
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: g0.id, externalEventId: `evt-${label}-reject`, decision: "reject",
  }));
  await regressionPasses(seeded);
  return stop;
};

test("a Chain held across the fresh authorization supersedes the stop on resume", async () => {
  const seeded = await seedIntegratorChain(db, { label: "stop-held", shape: "canonical-compound-readiness" });
  const integratorTaskId = seeded.integratorTask!.id;
  const stop = await rejectedAndRegressed(seeded, "held");
  await holdAtReadinessLayer(seeded);

  assert.deepEqual(await readinessAuthorizes(), { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });
  assert.equal(await db.run.count({ where: { taskId: integratorTaskId } }), 1, "the Hold withholds the birth");
  assert.equal((await supersessions(integratorTaskId)).length, 0, "nothing is superseded while held");

  const resumed = await db.$transaction((tx) => resumeChain(tx, {
    projectId: seeded.project.id, chainId: seeded.chainId, taskId: integratorTaskId, requestId: "resume-held",
  }, new Date()));
  if ("message" in resumed) assert.fail(resumed.message);
  const runs = await db.run.findMany({ where: { taskId: integratorTaskId }, orderBy: { runNumber: "asc" } });
  assert.equal(runs.length, 2, "resume opens the superseding Run");
  assert.equal(runs[1]!.status, RunStatus.QUEUED);
  const recorded = await supersessions(integratorTaskId);
  assert.equal(recorded.length, 1);
  assert.equal((recorded[0]!.metadata as Record<string, unknown>).stopId, stop.stopId);
  assert.equal(
    await db.inboxMessage.count({ where: { dedupeKey: { startsWith: `confirmation:${integratorTaskId}:${stop.stopId}:r` } } }), 0,
    "resume does not fall back to a next-generation confirmation card",
  );
  assert.equal(
    await db.inboxMessage.count({ where: { dedupeKey: `run-birth-refusal:${integratorTaskId}:integrator-stopped` } }), 0,
  );
});

test("platform retries of the superseding Run are admitted", async () => {
  const seeded = await seedIntegratorChain(db, { label: "stop-retry", shape: "canonical-compound-readiness" });
  const integratorTaskId = seeded.integratorTask!.id;
  await rejectedAndRegressed(seeded, "retry");
  await readinessAuthorizes();
  const superseding = await db.run.findFirstOrThrow({ where: { taskId: integratorTaskId }, orderBy: { runNumber: "desc" } });
  assert.equal(superseding.runNumber, 2);

  await db.run.update({ where: { id: superseding.id }, data: { status: RunStatus.FAILED } });
  const leaseLoss = await db.$transaction((tx) => openRun(tx, integratorTaskId, {
    kind: "retry-after-lease-loss", readyAt: new Date(), sourceRunId: superseding.id,
    sourceMaxRunsPerTask: superseding.maxRunsPerTask, sourceBudgetGrants: superseding.budgetGrants,
  }));
  if (!leaseLoss.ok) assert.fail(`lease-loss retry refused: ${leaseLoss.refusal.code}`);
  const retried = await db.run.findFirstOrThrow({ where: { taskId: integratorTaskId }, orderBy: { runNumber: "desc" } });
  assert.equal(retried.runNumber, 3);

  await db.run.update({ where: { id: retried.id }, data: { status: RunStatus.FAILED } });
  const invalidated = await db.$transaction((tx) => openRun(tx, integratorTaskId, {
    kind: "claim-invalidated", sourceRunId: retried.id, readyAt: new Date(),
  }));
  if (!invalidated.ok) assert.fail(`claim-invalidated retry refused: ${invalidated.refusal.code}`);
  assert.equal(await db.run.count({ where: { taskId: integratorTaskId } }), 4);
});

/** A re-authorized stop whose G0 card is OPEN with evidence while readiness re-verifies. */
const openCardAndFreshReadiness = async (label: string) => {
  const seeded = await seedIntegratorChain(db, {
    label, shape: "canonical-compound-readiness", gateAttestation: { headSha: HEAD_2, baseHeadSha: BASE_2 },
  });
  const { stop, g0 } = await reauthorize(seeded, `evt-${label}-reauthorize`);
  await redoRegression(seeded);
  await evidenceTick(db, { readPullRequest: async () => snapshot(HEAD_2, BASE_2) }, new Date());
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: g0.id } })).status, "OPEN");
  return { seeded, stop, g0 };
};

test("a human answering a card closed by supersession gets an explanatory refusal", async () => {
  const { seeded, g0 } = await openCardAndFreshReadiness("stop-closed-card");
  const integratorTaskId = seeded.integratorTask!.id;
  assert.deepEqual(await readinessAuthorizes(), { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });
  assert.equal((await supersessions(integratorTaskId)).length, 1);
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: g0.id } })).status, "CLOSED");

  const answered = await call("POST", `/inbox/messages/${g0.id}/decision`, { decision: "approve", requestId: "late-approve" });
  assert.equal(answered.status, 409, JSON.stringify(answered.body));
  assert.match(JSON.stringify(answered.body), /superseded by a fresh mechanical authorization/u);
  assert.equal(await db.run.count({ where: { taskId: integratorTaskId } }), 2);
});

test("a human approval racing the readiness supersession opens exactly one Run", async () => {
  const { seeded, g0 } = await openCardAndFreshReadiness("stop-race");
  const integratorTaskId = seeded.integratorTask!.id;
  const [approved, ticked] = await Promise.allSettled([
    db.$transaction((tx) => applyInboxDecisionTx(tx, {
      inboxMessageId: g0.id, externalEventId: "evt-race-approve", decision: "approve",
    })),
    readinessAuthorizes(),
  ]);
  const runs = await db.run.findMany({ where: { taskId: integratorTaskId }, orderBy: { runNumber: "asc" } });
  assert.equal(runs.length, 2, `exactly one new Run (approve ${approved.status}, tick ${ticked.status})`);
  assert.equal(runs[1]!.status, RunStatus.QUEUED);
  const recorded = await supersessions(integratorTaskId);
  if (recorded.length === 1) {
    assert.equal(approved.status, "rejected", "the human loses to the recorded supersession");
    assert.equal((recorded[0]!.metadata as Record<string, unknown>).runId, runs[1]!.id);
  } else {
    assert.equal(recorded.length, 0);
    assert.equal(approved.status, "fulfilled", "the human approval opened the Run");
  }
});

test("resume with readiness still bound to the pre-answer authorization issues the next confirmation card", async () => {
  const seeded = await seedIntegratorChain(db, { label: "stop-stale-auth", shape: "canonical-compound-readiness" });
  const integratorTaskId = seeded.integratorTask!.id;
  const stop = await rejectedAndRegressed(seeded, "stale-auth");
  // Readiness completes without re-verifying: its output still selects the
  // authorization the stopped Run consumed, written before the answer.
  await db.task.update({ where: { id: seeded.readinessTask!.id }, data: { status: TaskStatus.DONE } });
  await holdAtReadinessLayer(seeded);

  const resumed = await db.$transaction((tx) => resumeChain(tx, {
    projectId: seeded.project.id, chainId: seeded.chainId, taskId: integratorTaskId, requestId: "resume-stale",
  }, new Date()));
  if ("message" in resumed) assert.fail(resumed.message);
  assert.equal(await db.run.count({ where: { taskId: integratorTaskId } }), 1, "the stop still guards the birth");
  assert.equal((await supersessions(integratorTaskId)).length, 0);
  const next = await db.inboxMessage.findUnique({ where: { dedupeKey: `confirmation:${integratorTaskId}:${stop.stopId}:r1` } });
  assert.ok(next, "the human confirmation path continues with the :r1 card");
  assert.equal(next.status, "OPEN");
});

test("a lease-loss retry after the superseding Run stops again is refused", async () => {
  const seeded = await seedIntegratorChain(db, { label: "stop-restopped", shape: "canonical-compound-readiness" });
  const integratorTaskId = seeded.integratorTask!.id;
  await rejectedAndRegressed(seeded, "restopped");
  await readinessAuthorizes();
  const superseding = await db.run.findFirstOrThrow({ where: { taskId: integratorTaskId }, orderBy: { runNumber: "desc" } });
  assert.equal((await supersessions(integratorTaskId)).length, 1);

  await db.run.update({ where: { id: superseding.id }, data: { status: RunStatus.SUCCEEDED } });
  await db.session.create({ data: {
    runId: superseding.id, projectId: seeded.project.id, taskId: integratorTaskId,
    agentId: seeded.integratorAgent.id, runner: "CLAUDE", executionStatus: "SUCCEEDED",
  } });
  const evidence = JSON.stringify({ reason: "GitHub API 502 again" });
  const body = JSON.stringify({ outcome: "stopped", condition: "api-error", evidence });
  await db.taskStepOutput.update({ where: { taskId: integratorTaskId }, data: { runId: superseding.id, kind: "merge-result", body } });
  const restop = await db.$transaction((tx) => recordIntegratorStop(tx, {
    integratorTaskId, condition: "api-error", evidence, sourceRunId: superseding.id,
  }));
  assert.ok(restop.questionId);

  const retry = await db.$transaction((tx) => openRun(tx, integratorTaskId, {
    kind: "retry-after-lease-loss", readyAt: new Date(), sourceRunId: superseding.id,
    sourceMaxRunsPerTask: superseding.maxRunsPerTask, sourceBudgetGrants: superseding.budgetGrants,
  }));
  assert.equal(retry.ok, false, "the new stop is not covered by the earlier supersession");
  if (!retry.ok) assert.equal(retry.refusal.code, "integrator-stopped");
  assert.equal(await db.run.count({ where: { taskId: integratorTaskId } }), 2);
});
