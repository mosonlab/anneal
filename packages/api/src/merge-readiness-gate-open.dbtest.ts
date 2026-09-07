import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  advanceTemplateTask,
  CHAIN_AUTO_RESUME_KIND,
  EVIDENCE_PLACEHOLDER_BODY,
  MERGE_INTEGRATOR_KIND,
  MERGE_TAIL_KIND,
  mergeExecutorRunnerIds,
  PrismaClient,
  TaskStatus,
  parseEvidence,
} from "@anneal/db";

import type { PullRequestReader, PullRequestSnapshot } from "./github-read.js";
import {
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";
import { readinessTick, type DaemonSnapshotReader } from "./merge-readiness-worker.js";
import { evidenceTick } from "./merge-evidence-worker.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

/** Every configured merge executor reported online, which is what readiness requires before it authorizes. */
const executorsOnline: DaemonSnapshotReader = (now) => mergeExecutorRunnerIds().map((runnerId) => ({
  runnerId,
  online: true,
  lastSeenAt: now,
  daemonVersion: null,
  diskFreeBytes: null,
  pollIntervalMs: null,
  workspaceRoot: null,
}));

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

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
  readAt: new Date("2026-08-31T00:00:00.000Z").toISOString(),
  ...overrides,
});

const reader: PullRequestReader = {
  readPullRequest: async () => snapshot(),
  compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
};

// The REVIEW candidate assertion below means neither callback should be
// reached. Keeping these adapters explicit makes the test fail if a future
// readiness candidate query accidentally starts claiming gated tasks.
const releaseLease: ReleaseMergeLease = async () => {};
const claimLease: WithMergeLease = async () => {
  throw new Error("a REVIEW readiness task must not acquire the merge lease");
};

test("the gated-readiness fixture creates a pre-activation merge gate and rejects non-readiness shapes", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "gated-fixture",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });

  assert.ok(chain.readinessTask);
  assert.ok(chain.readinessStep);
  assert.equal(chain.readinessStep.approvalGate, true);
  assert.equal(chain.readinessTask.approvalGate, true);
  assert.equal(chain.readinessTask.status, TaskStatus.TODO);
  assert.equal(chain.gateTask.status, TaskStatus.DONE);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: chain.gateRun.id } })).status, "SUCCEEDED");

  await assert.rejects(
    seedIntegratorChain(db, { label: "invalid-gated-fixture", gatedReadiness: true }),
    /gatedReadiness.*no readiness slot/u,
  );
});

test("regression completion opens the merge gate, while an ungated readiness successor keeps the queued path", async () => {
  const gated = await seedIntegratorChain(db, {
    label: "gated-open",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });
  const ungated = await seedIntegratorChain(db, {
    label: "ungated-open",
    shape: "canonical-compound-readiness",
  });
  assert.ok(gated.readinessTask);
  assert.ok(ungated.readinessTask);

  // Existing callers intentionally get a post-readiness fixture. Put the
  // control chain back at the same pre-activation boundary as the gated one;
  // its approval flag remains the default false.
  await db.task.update({ where: { id: ungated.readinessTask.id }, data: { status: TaskStatus.TODO } });

  const gatedAdvance = await db.$transaction((tx) => advanceTemplateTask(
    tx,
    gated.gateTask.id,
    gated.gateRun.id,
    null,
    new Date("2026-08-31T00:00:01.000Z"),
  ));
  const ungatedAdvance = await db.$transaction((tx) => advanceTemplateTask(
    tx,
    ungated.gateTask.id,
    ungated.gateRun.id,
    null,
    new Date("2026-08-31T00:00:02.000Z"),
  ));

  assert.equal(gatedAdvance.gated, true);
  assert.equal(ungatedAdvance.gated, false);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: gated.readinessTask.id } })).status, TaskStatus.REVIEW);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: ungated.readinessTask.id } })).status, TaskStatus.TODO);

  const gatedCards = await db.inboxMessage.findMany({ where: { gateTaskId: gated.readinessTask.id, status: "OPEN" } });
  assert.equal(gatedCards.length, 1);
  assert.equal(gatedCards[0]!.body, EVIDENCE_PLACEHOLDER_BODY);
  const request = await db.taskActivity.findFirst({
    where: { taskId: gated.readinessTask.id, actorType: "control-plane", metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.evidenceRequest } },
  });
  assert.ok(request);
  const requestMetadata = request.metadata as Record<string, unknown>;
  assert.equal(requestMetadata.purpose, "gate");
  assert.equal(requestMetadata.sourceRunId, gated.gateRun.id);
  assert.equal(requestMetadata.cardId, gatedCards[0]!.id);

  const gatedReadinessMarkers = await db.taskActivity.findMany({
    where: { taskId: gated.readinessTask.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.readiness } },
  });
  assert.equal(gatedReadinessMarkers.length, 0, "a gate opening does not write a queued marker");
  const ungatedReadinessMarkers = await db.taskActivity.findMany({
    where: { taskId: ungated.readinessTask.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.readiness } },
  });
  assert.equal(ungatedReadinessMarkers.length, 1);
  assert.equal((ungatedReadinessMarkers[0]!.metadata as Record<string, unknown>).state, "queued");
  assert.equal(await db.inboxMessage.count({ where: { gateTaskId: ungated.readinessTask.id } }), 0);
});

test("the evidence worker fills a gated readiness card and the readiness worker cannot claim it", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "gated-worker",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });
  assert.ok(chain.readinessTask);
  await db.$transaction((tx) => advanceTemplateTask(
    tx,
    chain.gateTask.id,
    chain.gateRun.id,
    null,
    new Date("2026-08-31T00:00:01.000Z"),
  ));
  const card = await db.inboxMessage.findFirstOrThrow({ where: { gateTaskId: chain.readinessTask.id, status: "OPEN" } });

  const filled = await evidenceTick(db, reader, new Date("2026-08-31T00:00:02.000Z"));
  assert.deepEqual(filled, { claimed: 1, filled: 1, unavailable: 0 });
  const body = await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } });
  const evidence = parseEvidence(body.body);
  assert.equal(evidence.status, "ok");
  if (evidence.status !== "ok") return;
  assert.equal(evidence.evidence.headSha, HEAD);
  assert.equal(evidence.evidence.baseRef, "master");
  assert.equal(evidence.evidence.baseSha, BASE);
  assert.deepEqual(evidence.evidence.requiredChecks, [{ name: "ci/build", conclusion: "SUCCESS" }]);

  const tick = await readinessTick(
    db,
    reader,
    new Date("2026-08-31T00:00:03.000Z"),
    5,
    releaseLease,
    claimLease,
    executorsOnline,
  );
  assert.deepEqual(tick, { claimed: 0, authorized: 0, requeued: 0, stopped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.REVIEW);
  assert.equal(await db.taskActivity.count({ where: { taskId: chain.readinessTask.id, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization } } }), 0);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 0);
});

test("replaying predecessor completion does not auto-resume a deliberate merge gate", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "gated-replay",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });
  assert.ok(chain.readinessTask);
  await db.$transaction((tx) => advanceTemplateTask(
    tx,
    chain.gateTask.id,
    chain.gateRun.id,
    null,
    new Date("2026-08-31T00:00:01.000Z"),
  ));
  const initialCard = await db.inboxMessage.findFirstOrThrow({
    where: { gateTaskId: chain.readinessTask.id, status: "OPEN" },
  });

  // A duplicate completion notification must not treat an operator's REVIEW
  // gate as the stalled REVIEW state that chain auto-resume is allowed to
  // repair. In particular, it must not create a second card or release the
  // readiness worker while the original decision is still open.
  await assert.doesNotReject(() => db.$transaction((tx) => advanceTemplateTask(
    tx,
    chain.gateTask.id,
    chain.gateRun.id,
    null,
    new Date("2026-08-31T00:00:02.000Z"),
  )));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.REVIEW);
  assert.deepEqual(
    await db.inboxMessage.findMany({ where: { gateTaskId: chain.readinessTask.id, status: "OPEN" }, select: { id: true } }),
    [{ id: initialCard.id }],
  );
  assert.equal(await db.taskActivity.count({
    where: {
      taskId: chain.readinessTask.id,
      metadata: { path: ["kind"], equals: CHAIN_AUTO_RESUME_KIND },
    },
  }), 0);
});
