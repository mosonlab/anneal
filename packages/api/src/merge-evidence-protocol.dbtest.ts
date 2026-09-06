/**
 * §D-P3 — the two-phase evidence protocol (MF-3, C2, SF-2).
 *
 * The contradiction this closes: the human must judge fresh evidence *presented
 * in the question*, so the read has to precede the card, not follow the answer.
 * The tests below therefore assert an ordering, not just a value — a card is
 * born saying nothing and undeliverable, a worker outside every transaction
 * fills it, and only then can it be approved.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  applyInboxDecisionTx,
  EVIDENCE_PLACEHOLDER_BODY,
  EVIDENCE_UNAVAILABLE_MARKER,
  gateQuestion,
  MERGE_INTEGRATOR_KIND,
  parseEvidence,
  Prisma,
  PrismaClient,
} from "@anneal/db";

import { evidenceTick } from "./merge-evidence-worker.js";
import { type PullRequestSnapshot } from "./github-read.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  repository: "acme/widgets", number: 123, state: "OPEN", isDraft: false, merged: false,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "master", baseSha: "b".repeat(40),
  headRefOid: "a".repeat(40), headCommitOid: "a".repeat(40), autoMergeRequest: null, mergeQueueEntry: null,
  repositoryMergeQueue: null, mergedBy: null, mergeCommit: null, requiredCheckNames: ["ci/build"],
  checkContexts: [{ __typename: "CheckRun", name: "ci/build", status: "COMPLETED", conclusion: "SUCCESS" }],
  readAt: new Date("2026-08-18T00:00:00.000Z").toISOString(), ...overrides,
});

const readerReturning = (value: PullRequestSnapshot | (() => Promise<PullRequestSnapshot>)) => ({
  readPullRequest: async (
    _repository: string,
    _prNumber: number,
    _baseRef: string,
    signal?: AbortSignal,
  ): Promise<PullRequestSnapshot> => {
    if (signal?.aborted) throw new Error("aborted");
    return typeof value === "function" ? value() : value;
  },
});

/** The gate signature for the head and base every snapshot below reports. */
const ATTESTED = { headSha: "a".repeat(40), baseHeadSha: "b".repeat(40) };

const openGate = async (chain: Awaited<ReturnType<typeof seedIntegratorChain>>) => db.$transaction(
  (tx) => gateQuestion(tx, chain.gateTask.id, chain.gateRun.id, null),
  { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
);

test("Phase A opens a card that says nothing yet, withholds it from the outbox, and reads no GitHub", async () => {
  const chain = await seedIntegratorChain(db, { label: "phase-a" });
  const before = Date.now();
  const card = await openGate(chain);
  assert.equal(card.body, EVIDENCE_PLACEHOLDER_BODY);
  assert.equal(card.status, "OPEN");
  assert.equal(card.deliveryStatus, "PENDING");
  // The outbox selects nextDeliveryAt <= now, so a future stamp is what keeps a
  // placeholder off the human's phone.
  assert.ok((card.nextDeliveryAt?.getTime() ?? 0) > before, "placeholder is not deliverable yet");
  const request = await db.taskActivity.findFirst({ where: { taskId: chain.gateTask.id, actorType: "control-plane" } });
  const metadata = request?.metadata as Record<string, unknown>;
  assert.equal(metadata.kind, MERGE_INTEGRATOR_KIND.evidenceRequest);
  assert.equal(metadata.cardId, card.id);
  assert.equal(metadata.prNumber, 123);
  assert.equal(metadata.purpose, "gate");
});

test("an ordinary gate without a mechanical successor is untouched by the protocol", async () => {
  const chain = await seedIntegratorChain(db, { label: "ordinary-gate", withIntegrator: false });
  const card = await openGate(chain);
  assert.notEqual(card.body, EVIDENCE_PLACEHOLDER_BODY);
  assert.equal(
    await db.taskActivity.count({ where: { taskId: chain.gateTask.id, actorType: "control-plane" } }),
    0,
    "no evidence request is written for a chain with no integrator step",
  );
});

test("Phase B fills the card by compare-and-swap, makes it deliverable, and refuses to fill it twice", async () => {
  const chain = await seedIntegratorChain(db, { label: "phase-b" });
  const card = await openGate(chain);
  const first = await evidenceTick(db, readerReturning(snapshot()), new Date());
  assert.deepEqual(first, { claimed: 1, filled: 1, unavailable: 0 });
  const filled = await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } });
  const parsed = parseEvidence(filled.body);
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") return;
  assert.equal(parsed.evidence.headSha, "a".repeat(40));
  assert.equal(parsed.evidence.baseSha, "b".repeat(40));
  assert.equal(parsed.evidence.baseRef, "master");
  assert.deepEqual(parsed.evidence.requiredChecks, [{ name: "ci/build", conclusion: "SUCCESS" }]);
  assert.ok((filled.nextDeliveryAt?.getTime() ?? Infinity) <= Date.now(), "a filled card is deliverable");
  // The body CAS is what makes a fill single-shot: a second tick finds no
  // placeholder to claim, so a stale worker cannot overwrite a judged snapshot.
  const second = await evidenceTick(db, readerReturning(snapshot({ headRefOid: "c".repeat(40) })), new Date());
  assert.deepEqual(second, { claimed: 0, filled: 0, unavailable: 0 });
  const unchanged = await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } });
  assert.equal(unchanged.body, filled.body);
});

test("a read that stalls past the deadline is aborted and lands evidence-unavailable, not a guess", async () => {
  const chain = await seedIntegratorChain(db, { label: "timeout" });
  const card = await openGate(chain);
  const prior = { timeout: process.env.MERGE_EVIDENCE_READ_TIMEOUT_MS, attempts: process.env.MERGE_EVIDENCE_ATTEMPTS };
  process.env.MERGE_EVIDENCE_READ_TIMEOUT_MS = "40";
  process.env.MERGE_EVIDENCE_ATTEMPTS = "2";
  try {
    // A reader that ignores its abort signal. The bound has to hold anyway.
    const stalling = readerReturning(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return snapshot();
    });
    const result = await evidenceTick(db, stalling, new Date());
    assert.equal(result.unavailable, 1);
    assert.equal(result.filled, 0);
  } finally {
    if (prior.timeout === undefined) delete process.env.MERGE_EVIDENCE_READ_TIMEOUT_MS;
    else process.env.MERGE_EVIDENCE_READ_TIMEOUT_MS = prior.timeout;
    if (prior.attempts === undefined) delete process.env.MERGE_EVIDENCE_ATTEMPTS;
    else process.env.MERGE_EVIDENCE_ATTEMPTS = prior.attempts;
  }
  const marked = await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } });
  assert.match(marked.body, new RegExp(EVIDENCE_UNAVAILABLE_MARKER, "u"));
  assert.equal(marked.status, "OPEN", "the card stays open; the human is told, not silently approved");
  // SF-2: a competing operator write completes, which it could not if the read
  // had been holding a task lock.
  const competing = await db.task.update({ where: { id: chain.gateTask.id }, data: { failureReason: null } });
  assert.equal(competing.id, chain.gateTask.id);
});

test("approving an unfilled or unavailable card is refused, and the card stays open", async () => {
  const chain = await seedIntegratorChain(db, { label: "refusal" });
  const card = await openGate(chain);
  await assert.rejects(
    db.$transaction((tx) => applyInboxDecisionTx(tx, {
      inboxMessageId: card.id, externalEventId: "evt-unfilled", decision: "approve",
    })),
    /has not been read yet/u,
  );
  const stillOpen = await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } });
  assert.equal(stillOpen.status, "OPEN");
  assert.equal(await db.inboxDecision.count(), 0, "a refused approval leaves no decision row behind");
  assert.equal(await db.taskActivity.count({ where: { taskId: chain.gateTask.id, actorType: "operator" } }), 0);

  process.env.MERGE_EVIDENCE_READ_TIMEOUT_MS = "30";
  process.env.MERGE_EVIDENCE_ATTEMPTS = "1";
  try {
    await evidenceTick(db, readerReturning(async () => { throw new Error("github is down"); }), new Date());
  } finally {
    delete process.env.MERGE_EVIDENCE_READ_TIMEOUT_MS;
    delete process.env.MERGE_EVIDENCE_ATTEMPTS;
  }
  await assert.rejects(
    db.$transaction((tx) => applyInboxDecisionTx(tx, {
      inboxMessageId: card.id, externalEventId: "evt-unavailable", decision: "approve",
    })),
    /could not be read/u,
  );
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } })).status, "OPEN");
});

test("two simultaneous approvals of one filled card produce exactly one authorization", async () => {
  const chain = await seedIntegratorChain(db, { label: "concurrent", gateAttestation: ATTESTED });
  const card = await openGate(chain);
  await evidenceTick(db, readerReturning(snapshot()), new Date());
  const other = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const approve = (client: PrismaClient, event: string) => client.$transaction(
    (tx) => applyInboxDecisionTx(tx, { inboxMessageId: card.id, externalEventId: event, decision: "approve" }),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  try {
    const results = await Promise.allSettled([approve(db, "evt-a"), approve(other, "evt-b")]);
    assert.ok(results.some((result) => result.status === "fulfilled"));
  } finally {
    await other.$disconnect();
  }
  const records = (await db.taskActivity.findMany({ where: { taskId: chain.gateTask.id } }))
    .filter((row) => (row.metadata as Record<string, unknown> | null)?.kind === MERGE_INTEGRATOR_KIND.authorization);
  assert.equal(records.length, 1, "exactly one authorization, whichever click won");
  assert.equal(await db.inboxDecision.count({ where: { inboxMessageId: card.id } }), 1);
});

test("a replayed Feishu event produces no second authorization", async () => {
  const chain = await seedIntegratorChain(db, { label: "replay", gateAttestation: ATTESTED });
  const card = await openGate(chain);
  await evidenceTick(db, readerReturning(snapshot()), new Date());
  const first = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: card.id, externalEventId: "feishu-evt-1", decision: "approve",
  }));
  assert.equal(first.duplicate, false);
  const second = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: card.id, externalEventId: "feishu-evt-1", decision: "approve",
  }));
  assert.equal(second.duplicate, true);
  const records = (await db.taskActivity.findMany({ where: { taskId: chain.gateTask.id } }))
    .filter((row) => (row.metadata as Record<string, unknown> | null)?.kind === MERGE_INTEGRATOR_KIND.authorization);
  assert.equal(records.length, 1);
});
