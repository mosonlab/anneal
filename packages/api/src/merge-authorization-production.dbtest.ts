/**
 * §D-P2 / SPEC §8.2 — authorization production on both approval channels.
 *
 * The property under test is identity, not similarity: the payload's only
 * source is the evidence block inside the card body the human read, so
 * "presented equals recorded" is asserted by field-by-field equality against
 * that block rather than by comparing two independently-read snapshots. A test
 * that re-read GitHub and compared would pass even under the design MF-2
 * rejected.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  applyInboxDecisionTx,
  gateQuestion,
  MERGE_INTEGRATOR_KIND,
  parseAuthorizationMetadata,
  parseEvidence,
  Prisma,
  PrismaClient,
} from "@anneal/db";

import { type PullRequestSnapshot } from "./github-read.js";
import { evidenceTick } from "./merge-evidence-worker.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-merge-authorization";

const snapshot = (): PullRequestSnapshot => ({
  repository: "acme/widgets", number: 123, state: "OPEN", isDraft: false, merged: false,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "master", baseSha: "b".repeat(40),
  headRefOid: "a".repeat(40), headCommitOid: "a".repeat(40), autoMergeRequest: null, mergeQueueEntry: null,
  repositoryMergeQueue: null, mergedBy: null, mergeCommit: null, requiredCheckNames: ["ci/build"],
  checkContexts: [{ __typename: "CheckRun", name: "ci/build", status: "COMPLETED", conclusion: "SUCCESS" }],
  readAt: new Date("2026-08-18T00:00:00.000Z").toISOString(),
});

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(path, {
      method,
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const filledGate = async (label: string) => {
  // The approval-gate shape has no Regression node, so the gate's signature for
  // the head the snapshot names has to be seeded here: without it every
  // authorization below is refused for a head no gate ever signed.
  const chain = await seedIntegratorChain(db, {
    label, gateAttestation: { headSha: "a".repeat(40), baseHeadSha: "b".repeat(40) },
  });
  const card = await db.$transaction(
    (tx) => gateQuestion(tx, chain.gateTask.id, chain.gateRun.id, null),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  await evidenceTick(db, { readPullRequest: async () => snapshot() }, new Date());
  const filled = await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } });
  return { chain, card: filled };
};

const authorizationsFor = async (taskId: string) =>
  (await db.taskActivity.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } }))
    .filter((row) => (row.metadata as Record<string, unknown> | null)?.kind === MERGE_INTEGRATOR_KIND.authorization);

test("N13 inbox channel: one authorization, bound to the winning decision, equal to the card field by field", async () => {
  const { chain, card } = await filledGate("n13-inbox");
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: card.id, externalEventId: "feishu-approve-1", decision: "approve", actorOpenId: "ou_human",
  }));

  const records = await authorizationsFor(chain.gateTask.id);
  assert.equal(records.length, 1);
  const parsed = parseAuthorizationMetadata(records[0]!.metadata);
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") return;
  const block = parseEvidence(card.body);
  assert.equal(block.status, "ok");
  if (block.status !== "ok") return;

  for (const key of ["repository", "prNumber", "headSha", "baseRef", "baseSha", "mergeMethod", "nonce", "readAt"] as const) {
    assert.deepEqual(parsed.payload[key], block.evidence[key], `${key} presented equals ${key} recorded`);
  }
  assert.deepEqual(parsed.payload.requiredChecks, block.evidence.requiredChecks);

  const decision = await db.inboxDecision.findFirstOrThrow({ where: { inboxMessageId: card.id } });
  assert.equal(decision.decision, "approve");
  assert.equal(parsed.payload.decision.inboxDecisionId, decision.id);
  assert.equal(parsed.payload.decision.inboxMessageId, card.id);
  assert.equal(parsed.payload.decision.channel, "inbox");
  assert.equal(records[0]!.actorType, "operator");
  // Atomicity: decision row and record share one transaction, so they land
  // inside the binding window the selection validator enforces.
  assert.ok(Math.abs(records[0]!.createdAt.getTime() - decision.createdAt.getTime()) < 5_000);
  const answered = await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } });
  assert.equal(answered.status, "ANSWERED");
  assert.equal(answered.selectedChoiceId, "approve");
});

test("N13 rejection produces no authorization at all", async () => {
  const { chain, card } = await filledGate("n13-reject");
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: card.id, externalEventId: "feishu-reject-1", decision: "reject",
  }));
  assert.equal((await authorizationsFor(chain.gateTask.id)).length, 0);
});

test("N13 PATCH cannot substitute for the Inbox authorization channel", async () => {
  const { chain, card } = await filledGate("n13-patch");
  const response = await call("PATCH", `/tasks/${chain.gateTask.id}`, { status: "DONE" });
  assert.equal(response.status, 409);
  assert.equal((await authorizationsFor(chain.gateTask.id)).length, 0);
  assert.equal(await db.inboxDecision.count({ where: { inboxMessageId: card.id } }), 0);
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } })).status, "OPEN");
});

test("N5 the PATCH no-gate-rows edge stays fail-closed: no decision, no authorization", async () => {
  const chain = await seedIntegratorChain(db, { label: "n5-nogate" });
  const response = await call("PATCH", `/tasks/${chain.gateTask.id}`, { status: "DONE" });
  assert.equal(response.status, 409);
  assert.equal(await db.inboxDecision.count(), 0);
  assert.equal((await authorizationsFor(chain.gateTask.id)).length, 0);
});

test("N5 an unfilled card refuses the PATCH channel too, leaving the gate untouched", async () => {
  const chain = await seedIntegratorChain(db, { label: "n5-unfilled" });
  const card = await db.$transaction(
    (tx) => gateQuestion(tx, chain.gateTask.id, chain.gateRun.id, null),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  const response = await call("PATCH", `/tasks/${chain.gateTask.id}`, { status: "DONE" });
  assert.notEqual(response.status, 200);
  const untouched = await db.task.findUniqueOrThrow({ where: { id: chain.gateTask.id } });
  assert.notEqual(untouched.status, "DONE");
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } })).status, "OPEN");
  assert.equal(await db.inboxDecision.count(), 0);
  assert.equal((await authorizationsFor(chain.gateTask.id)).length, 0);
});

test("an ordinary gate approval writes no merge record on either channel", async () => {
  const chain = await seedIntegratorChain(db, { label: "ordinary-gate-auth", withIntegrator: false });
  const card = await db.$transaction(
    (tx) => gateQuestion(tx, chain.gateTask.id, chain.gateRun.id, null),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: card.id, externalEventId: "feishu-nine", decision: "approve",
  }));
  assert.equal((await authorizationsFor(chain.gateTask.id)).length, 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.gateTask.id } })).status, "DONE");
});
