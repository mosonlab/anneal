import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  CleanupStatus,
  MERGE_INTEGRATOR_KIND,
  MERGE_TAIL_KIND,
  PrismaClient,
  PushStatus,
  REGRESSION_VERIFICATION_OUTPUT_KIND,
  TaskStatus,
  applyInboxDecisionTx,
  advanceTemplateTask,
  gateQuestion,
} from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";

import type { PullRequestReader, PullRequestSnapshot } from "./github-read.js";
import { persistSessionTaskOutput } from "./canonical-task-output.js";
import {
  withMergeLease,
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";
import { evidenceTick } from "./merge-evidence-worker.js";
import { executorsOnline } from "./merge-executor-daemon-fixture.js";
import { readinessTick } from "./merge-readiness-worker.js";
import { claimRun } from "./run-claim.js";
import { completeRun, completionInput } from "./run-completion.js";
import { patchTask } from "./task-patch.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NEW_HEAD = "c".repeat(40);
const NEW_BASE = "d".repeat(40);
const TEST_EPOCH_MS = Date.now();
const testTime = (seconds: number): Date => new Date(TEST_EPOCH_MS + seconds * 1_000);

const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  repository: "acme/widgets",
  number: 123,
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRefName: "master",
  baseSha: BASE,
  headRefOid: HEAD,
  headCommitOid: HEAD,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  repositoryMergeQueue: null,
  mergedBy: null,
  mergeCommit: null,
  requiredCheckNames: ["ci/build"],
  checkContexts: [{ __typename: "CheckRun", name: "ci/build", status: "COMPLETED", conclusion: "SUCCESS" }],
  readAt: testTime(0).toISOString(),
  ...overrides,
});

const reader = (current: Partial<PullRequestSnapshot> = {}): PullRequestReader => ({
  readPullRequest: async () => snapshot(current),
  compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
});

const releaseLease: ReleaseMergeLease = async () => {};
const runWithMergeLease: WithMergeLease = (target, fn, database) => withMergeLease(
  target,
  fn,
  database,
  {
    acquire: async () => ({ outcome: "acquired" }),
    release: async () => ({
      outcome: "released",
      ref: "refs/merge-lease/test",
      sha: "lease-test",
      acquiredAt: testTime(0).toISOString(),
    }),
  },
);

/** Make the fixture's Regression output current-v2 and persist its signature. */
const attestRegression = async (
  chain: Awaited<ReturnType<typeof seedIntegratorChain>>,
  headSha = HEAD,
  baseHeadSha = BASE,
): Promise<void> => {
  await db.taskTemplateStep.update({
    where: { id: chain.gateStep.id },
    data: { outputKind: REGRESSION_VERIFICATION_OUTPUT_KIND },
  });
  const body = JSON.stringify({
    schemaVersion: 2,
    outcome: "pass",
    headSha,
    baseHeadSha,
    gateVerdict: "PASS",
    gateProof: `MERGE GATE: PASS ${headSha}`,
  });
  await db.taskStepOutput.create({
    data: {
      taskId: chain.gateTask.id,
      runId: chain.gateRun.id,
      kind: REGRESSION_VERIFICATION_OUTPUT_KIND,
      body,
      commitSha: headSha,
    },
  });
  await db.mergeGateAttestation.create({
    data: {
      chainId: chain.chainId,
      taskId: chain.gateTask.id,
      runId: chain.gateRun.id,
      headSha,
      baseHeadSha,
      proof: `MERGE GATE: PASS ${headSha}`,
    },
  });
};

const openGate = async (
  chain: Awaited<ReturnType<typeof seedIntegratorChain>>,
  now = testTime(1),
): Promise<{ id: string; body: string }> => {
  assert.ok(chain.readinessTask);
  await db.$transaction((tx) => advanceTemplateTask(
    tx,
    chain.gateTask.id,
    chain.gateRun.id,
    null,
    now,
  ));
  const card = await db.inboxMessage.findFirstOrThrow({
    where: { gateTaskId: chain.readinessTask.id, status: "OPEN" },
  });
  return card;
};

const fillGate = async (
  chain: Awaited<ReturnType<typeof seedIntegratorChain>>,
  current: Partial<PullRequestSnapshot> = {},
): Promise<{ id: string; body: string }> => {
  const card = await openGate(chain);
  await evidenceTick(db, reader(current), testTime(2));
  return db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } });
};

const approveInbox = (cardId: string, externalEventId: string) => db.$transaction((tx) => (
  applyInboxDecisionTx(tx, {
    inboxMessageId: cardId,
    externalEventId,
    decision: "approve",
    actorOpenId: "operator-1",
  })
));

const authorizationRows = async (taskId: string) => (await db.taskActivity.findMany({ where: { taskId } }))
  .filter((row) => (row.metadata as Record<string, unknown> | null)?.kind === MERGE_INTEGRATOR_KIND.authorization);

const recordRegressionRetry = async (
  chain: Awaited<ReturnType<typeof seedIntegratorChain>>,
  headSha = HEAD,
  baseHeadSha = BASE,
) => {
  const previous = await db.run.findFirstOrThrow({
    where: { taskId: chain.gateTask.id },
    orderBy: { runNumber: "desc" },
  });
  const run = await db.run.create({ data: {
    projectId: chain.project.id,
    taskId: chain.gateTask.id,
    agentId: chain.agent.id,
    repoId: chain.repo.id,
    runNumber: previous.runNumber + 1,
    dedupeKey: `task:${chain.gateTask.id}:run:${previous.runNumber + 1}`,
    runner: "CLAUDE",
    model: chain.agent.model,
    promptHash: "retry-hash",
    status: "SUCCEEDED",
    pullRequestNumber: 123,
    pullRequestUrl: "https://github.com/acme/widgets/pull/123",
    targetBranch: "master",
    branch: "agentos/chain/demo",
    headSha,
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: chain.project.id,
    agentId: chain.agent.id,
    taskId: chain.gateTask.id,
    runner: "CLAUDE",
    executionStatus: "SUCCEEDED",
  } });
  await db.taskStepOutput.update({
    where: { taskId: chain.gateTask.id },
    data: {
      runId: run.id,
      body: JSON.stringify({
        schemaVersion: 2,
        outcome: "pass",
        headSha,
        baseHeadSha,
        gateVerdict: "PASS",
        gateProof: `MERGE GATE: PASS ${headSha}`,
      }),
      commitSha: headSha,
    },
  });
  await db.mergeGateAttestation.update({
    where: { chainId_headSha: { chainId: chain.chainId, headSha } },
    data: { taskId: chain.gateTask.id, runId: run.id, baseHeadSha },
  });
  await db.task.update({ where: { id: chain.gateTask.id }, data: { status: TaskStatus.DONE } });
  return run;
};

test("Inbox approval releases gated readiness only after exact-head authorization", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "merge-gate-approval-inbox",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });
  assert.ok(chain.readinessTask);
  await attestRegression(chain);
  const card = await fillGate(chain);

  const decision = await approveInbox(card.id, "merge-gate-inbox-approve");
  assert.equal(decision.gateAction, "approved");
  const released = await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } });
  assert.equal(released.status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 0);
  const authorizations = await authorizationRows(chain.readinessTask.id);
  assert.equal(authorizations.length, 1);
  assert.equal((authorizations[0]!.metadata as Record<string, unknown>).headSha, HEAD);
  assert.equal((authorizations[0]!.metadata as Record<string, unknown>).baseSha, BASE);
  assert.equal(await db.taskActivity.count({
    where: { taskId: chain.readinessTask.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.readiness } },
  }), 1, "approval writes the ordinary queued readiness marker");

  const tick = await readinessTick(
    db,
    reader(),
    testTime(3),
    5,
    releaseLease,
    runWithMergeLease,
    executorsOnline,
  );
  assert.deepEqual(tick, { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.DONE);
  assert.equal((await db.run.count({ where: { taskId: chain.integratorTask!.id } })), 1);
  const mechanical = await authorizationRows(chain.readinessTask.id);
  assert.equal(mechanical.length, 2, "the worker adds the sole downstream mechanical authorization");
  assert.ok(mechanical.some((row) => (
    ((row.metadata as Record<string, unknown>).decision as Record<string, unknown>).channel === "mechanical"
  )));

  const priorExecutors = process.env.MERGE_EXECUTOR_RUNNER_IDS;
  process.env.MERGE_EXECUTOR_RUNNER_IDS = "merge-executor-gated-happy";
  try {
    const claimed = await claimRun(db, {
      body: {
        runnerId: "merge-executor-gated-happy",
        leaseSeconds: 60,
        contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
      },
      claimantClass: "merge-executor",
      now: testTime(4),
      specificationReader: null,
    });
    assert.ok(claimed && "run" in claimed);
    assert.equal(claimed.run.taskId, chain.integratorTask!.id);
    assert.equal(claimed.executionMode, "mechanical");
    const mergedBody = JSON.stringify({ outcome: "merged", mergeCommitSha: "e".repeat(40) });
    const persisted = await db.$transaction((tx) => persistSessionTaskOutput(tx, {
      task: { id: chain.integratorTask!.id },
      fence: { runId: claimed.run.id, fencingToken: claimed.fencingToken, at: testTime(5) },
      kind: "merge-result",
      body: mergedBody,
      commitSha: null,
    }));
    assert.ok("ok" in persisted && persisted.ok, JSON.stringify(persisted));
    const completed = await completeRun(db, {
      runId: claimed.run.id,
      claimantClass: "merge-executor",
      body: completionInput.parse({
        runnerId: "merge-executor-gated-happy",
        fencingToken: claimed.fencingToken,
        exitCode: 0,
        outcome: { case: "succeeded" },
        pushStatus: PushStatus.NOT_REQUESTED,
        cleanupStatus: CleanupStatus.SUCCEEDED,
      }),
    }, releaseLease);
    assert.deepEqual(completed, {
      taskId: chain.integratorTask!.id,
      succeeded: true,
      retryCreated: false,
      failureClass: null,
    });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, TaskStatus.DONE);
    assert.equal((await db.run.findUniqueOrThrow({ where: { id: claimed.run.id } })).status, "SUCCEEDED");
    const mergeResult = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: chain.integratorTask!.id } });
    assert.equal(mergeResult.runId, claimed.run.id);
    assert.equal(mergeResult.kind, "merge-result");
    assert.deepEqual(JSON.parse(mergeResult.body), { outcome: "merged", mergeCommitSha: "e".repeat(40) });
    assert.deepEqual(
      (await db.task.findMany({
        where: { projectId: chain.project.id, chainId: chain.chainId },
        orderBy: { chainIndex: "asc" },
      })).map(({ status }) => status),
      [TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE],
    );
  } finally {
    if (priorExecutors === undefined) delete process.env.MERGE_EXECUTOR_RUNNER_IDS;
    else process.env.MERGE_EXECUTOR_RUNNER_IDS = priorExecutors;
  }
});

test("task PATCH approval shares the Inbox disposition and leaves readiness worker-owned", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "merge-gate-approval-patch",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });
  assert.ok(chain.readinessTask);
  await attestRegression(chain);
  await fillGate(chain);

  const patched = await patchTask(db, chain.readinessTask.id, { status: TaskStatus.DONE });
  assert.ok("task" in patched, JSON.stringify(patched));
  assert.equal(patched.task.status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 0);
  const authorization = await authorizationRows(chain.readinessTask.id);
  assert.equal(authorization.length, 1);
  assert.equal(((authorization[0]!.metadata as Record<string, unknown>).decision as Record<string, unknown>).channel, "patch");

  const tick = await readinessTick(
    db,
    reader(),
    testTime(3),
    5,
    releaseLease,
    runWithMergeLease,
    executorsOnline,
  );
  assert.equal(tick.authorized, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);
  // The PATCH path consumes the same exact card; a second status write cannot
  // manufacture a second decision or authorization.
  const replay = await patchTask(db, chain.readinessTask.id, { status: TaskStatus.DONE });
  assert.ok("task" in replay);
  assert.equal((await authorizationRows(chain.readinessTask.id)).length, 2);
});

test("head and base drift after approval requeues regression and opens a fresh evidence card", async () => {
  for (const [label, drift] of [
    ["head", { headRefOid: NEW_HEAD, headCommitOid: NEW_HEAD, baseSha: BASE }],
    ["base", { headRefOid: HEAD, headCommitOid: HEAD, baseSha: NEW_BASE }],
  ] as const) {
    const chain = await seedIntegratorChain(db, {
      label: `merge-gate-drift-${label}`,
      shape: "canonical-compound-readiness",
      gatedReadiness: true,
    });
    assert.ok(chain.readinessTask);
    await attestRegression(chain);
    const card = await fillGate(chain);
    await approveInbox(card.id, `merge-gate-drift-approve-${label}`);

    const drifted = await readinessTick(
      db,
      reader(drift),
      testTime(3),
      5,
      releaseLease,
      runWithMergeLease,
      executorsOnline,
    );
    assert.deepEqual(drifted, { claimed: 1, authorized: 0, requeued: 1, stopped: 0 });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.TODO);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.gateTask.id } })).status, TaskStatus.TODO);
    assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 0);

    const newRun = await db.run.findFirstOrThrow({ where: { taskId: chain.gateTask.id }, orderBy: { runNumber: "desc" } });
    await db.session.create({ data: {
      runId: newRun.id,
      projectId: newRun.projectId,
      agentId: newRun.agentId,
      taskId: newRun.taskId,
      runner: newRun.runner,
      executionStatus: "SUCCEEDED",
    } });
    const newHead = label === "head" ? NEW_HEAD : HEAD;
    const newBase = label === "base" ? NEW_BASE : BASE;
    await db.taskStepOutput.update({
      where: { taskId: chain.gateTask.id },
      data: {
        runId: newRun.id,
        body: JSON.stringify({
          schemaVersion: 2,
          outcome: "pass",
          headSha: newHead,
          baseHeadSha: newBase,
          gateVerdict: "PASS",
          gateProof: `MERGE GATE: PASS ${newHead}`,
        }),
        commitSha: newHead,
      },
    });
    await db.mergeGateAttestation.upsert({
      where: { chainId_headSha: { chainId: chain.chainId, headSha: newHead } },
      create: {
        chainId: chain.chainId,
        taskId: chain.gateTask.id,
        runId: newRun.id,
        headSha: newHead,
        baseHeadSha: newBase,
        proof: `MERGE GATE: PASS ${newHead}`,
      },
      update: {},
    });
    await db.task.update({ where: { id: chain.gateTask.id }, data: { status: TaskStatus.DONE } });
    await db.$transaction((tx) => advanceTemplateTask(
      tx,
      chain.gateTask.id,
      newRun.id,
      null,
      testTime(4),
    ));
    const fresh = await db.inboxMessage.findFirstOrThrow({
      where: { gateTaskId: chain.readinessTask.id, status: "OPEN" },
      orderBy: { createdAt: "desc" },
    });
    await evidenceTick(db, reader({ headRefOid: newHead, headCommitOid: newHead, baseSha: newBase }), new Date());
    const freshBody = await db.inboxMessage.findUniqueOrThrow({ where: { id: fresh.id } });
    assert.match(freshBody.body, new RegExp(newHead, "u"));
    assert.match(freshBody.body, new RegExp(newBase, "u"));
    assert.notEqual(fresh.id, card.id);
    assert.equal((await authorizationRows(chain.readinessTask.id)).length, 1, "old authorization is not reused");
  }
});

test("an old gate authorization cannot release a fresh gate after the state is re-opened", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "merge-gate-fresh-decision",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
    prNumbers: [123, 123],
  });
  assert.ok(chain.readinessTask);
  await attestRegression(chain);
  const firstCard = await fillGate(chain);
  await approveInbox(firstCard.id, "merge-gate-fresh-decision-first");

  // Re-open the same slot with a different completing run, as the normal
  // regression-requeue path does after remote drift. Deliberately release the
  // fresh REVIEW gate below to exercise the worker's fail-closed fence: the
  // old authorization has the same head/base, but it belongs to the old card.
  const firstRun = await db.run.findFirstOrThrow({
    where: { taskId: chain.gateTask.id },
    orderBy: { runNumber: "asc" },
  });
  await db.task.update({ where: { id: chain.readinessTask.id }, data: { status: TaskStatus.REVIEW } });
  await db.$transaction((tx) => gateQuestion(tx, chain.readinessTask!.id, firstRun.id, null));
  const freshCard = await db.inboxMessage.findFirstOrThrow({
    where: { gateTaskId: chain.readinessTask.id, status: "OPEN" },
    orderBy: { createdAt: "desc" },
  });
  assert.notEqual(freshCard.id, firstCard.id);
  await evidenceTick(db, reader(), testTime(4));
  await db.task.update({ where: { id: chain.readinessTask.id }, data: { status: TaskStatus.TODO } });

  const tick = await readinessTick(
    db,
    reader(),
    testTime(5),
    5,
    releaseLease,
    runWithMergeLease,
    executorsOnline,
  );
  assert.equal(tick.stopped, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.REVIEW);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 0);
  assert.equal(await authorizationRows(chain.readinessTask.id).then((rows) => rows.length), 1);
});

test("a hard-stopped gated readiness tail reopens a fresh gate after regression completes again", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "merge-gate-hard-stop-reopen",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });
  assert.ok(chain.readinessTask);
  await attestRegression(chain);
  const firstCard = await fillGate(chain);
  await approveInbox(firstCard.id, "merge-gate-hard-stop-approve");

  const stopped = await readinessTick(
    db,
    {
      readPullRequest: async () => snapshot(),
      compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: false, files: [] }),
    },
    testTime(3),
    5,
    releaseLease,
    runWithMergeLease,
    executorsOnline,
  );
  assert.deepEqual(stopped, { claimed: 1, authorized: 0, requeued: 0, stopped: 1 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.REVIEW);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.gateTask.id } })).status, TaskStatus.REVIEW);
  assert.equal(await db.inboxMessage.count({ where: { gateTaskId: chain.readinessTask.id, status: "OPEN" } }), 0);

  const retry = await recordRegressionRetry(chain);
  await db.$transaction((tx) => advanceTemplateTask(
    tx,
    chain.gateTask.id,
    retry.id,
    null,
    testTime(4),
  ));

  const fresh = await db.inboxMessage.findFirst({
    where: { gateTaskId: chain.readinessTask.id, status: "OPEN" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(fresh, "the production successor transition must reopen the stopped readiness gate");
  assert.notEqual(fresh.id, firstCard.id);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).failureReason, null);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 0);
});

test("missing or mismatched operator approval stops a gated readiness settlement closed", async () => {
  for (const [label, metadata] of [
    ["missing", null],
    ["wrong-head", { headSha: NEW_HEAD, baseSha: BASE }],
    ["wrong-base", { headSha: HEAD, baseSha: NEW_BASE }],
  ] as const) {
    const chain = await seedIntegratorChain(db, {
      label: `merge-gate-auth-${label}`,
      shape: "canonical-compound-readiness",
      gatedReadiness: true,
    });
    assert.ok(chain.readinessTask);
    await attestRegression(chain);
    if (metadata) {
      await db.taskActivity.create({
        data: {
          taskId: chain.readinessTask.id,
          actorType: "operator",
          body: "forged merge gate approval",
          metadata: {
            kind: MERGE_INTEGRATOR_KIND.authorization,
            schemaVersion: 1,
            nonce: "n".repeat(8),
            repository: "acme/widgets",
            prNumber: 123,
            headSha: metadata.headSha,
            baseRef: "master",
            baseSha: metadata.baseSha,
            mergeMethod: "merge",
            requiredChecks: [],
            readAt: new Date().toISOString(),
            issuedAt: new Date().toISOString(),
            decision: { channel: "inbox", inboxDecisionId: `forged-${label}`, inboxMessageId: `forged-${label}` },
          },
        },
      });
    }
    const tick = await readinessTick(
      db,
      reader(),
      testTime(3),
      5,
      releaseLease,
      runWithMergeLease,
      executorsOnline,
    );
    assert.equal(tick.stopped, 1, label);
    const [readiness, regression] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } }),
      db.task.findUniqueOrThrow({ where: { id: chain.gateTask.id } }),
    ]);
    assert.equal(readiness.status, TaskStatus.REVIEW, label);
    assert.equal(regression.status, TaskStatus.REVIEW, label);
    assert.match(readiness.failureReason ?? "", /merge gate operator authorization/iu, label);
    assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 0, label);
  }
});

test("a merge-gate approval without a regression attestation remains open", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "merge-gate-unattested",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });
  assert.ok(chain.readinessTask);
  // Current readiness tails require a v2 Regression attestation. The shared
  // fixture intentionally defaults to the frozen v1 role for legacy tests,
  // whose compatibility carve-out would make this scenario inapplicable.
  await db.taskTemplateStep.update({
    where: { id: chain.gateStep.id },
    data: { outputKind: REGRESSION_VERIFICATION_OUTPUT_KIND },
  });
  const card = await fillGate(chain);
  await assert.rejects(
    () => approveInbox(card.id, "merge-gate-unattested-approve"),
    /no merge gate attestation/iu,
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.REVIEW);
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } })).status, "OPEN");
  assert.equal((await authorizationRows(chain.readinessTask.id)).length, 0);
});
