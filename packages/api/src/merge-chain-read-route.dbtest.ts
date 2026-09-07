/**
 * SPEC §8.4 and §D-P2 — the chain-relative read route.
 *
 * Two distinct claims are under test. The first is scope: a session may read
 * exactly its own step and its predecessor, and nothing that is not a
 * contractual record leaves the server. The second is that validation happens
 * *here* — N14's forged activity is posted through the real operator route, so
 * the test exercises the same surface an attacker would.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  applyInboxDecisionTx,
  gateQuestion,
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  parseAuthorizationMetadata,
  Prisma,
  PrismaClient,
} from "@anneal/db";

import { issueSessionToken } from "./auth.js";
import { evidenceTick } from "./merge-evidence-worker.js";
import { type PullRequestSnapshot } from "./github-read.js";
import { seedIntegratorChain, type IntegratorChain } from "./merge-integrator-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-chain-read";

const snapshot = (): PullRequestSnapshot => ({
  repository: "acme/widgets", number: 123, state: "OPEN", isDraft: false, merged: false,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "master", baseSha: "b".repeat(40),
  headRefOid: "a".repeat(40), headCommitOid: "a".repeat(40), autoMergeRequest: null, mergeQueueEntry: null,
  repositoryMergeQueue: null, mergedBy: null, mergeCommit: null, requiredCheckNames: ["ci/build"],
  checkContexts: [{ __typename: "CheckRun", name: "ci/build", status: "COMPLETED", conclusion: "SUCCESS" }],
  readAt: new Date("2026-08-18T00:00:00.000Z").toISOString(),
});

/**
 * The step-12 run holding a live session token. The gate approval already
 * activated the successor and enqueued its run, so this adopts that row rather
 * than creating a second one — a step-12 task with two runs would be a fixture
 * artefact the production path never produces.
 */
const seedIntegratorSession = async (chain: IntegratorChain) => {
  const { token, hash } = issueSessionToken();
  const existing = await db.run.findFirst({
    where: { taskId: chain.integratorTask!.id }, orderBy: { runNumber: "desc" },
  });
  const live = {
    status: "RUNNING" as const, sessionTokenHash: hash, leaseGeneration: 1,
    sessionTokenExpiresAt: new Date(Date.now() + 3_600_000), leaseExpiresAt: new Date(Date.now() + 3_600_000),
    fencingToken: `1:${chain.integratorTask!.id}:1`, runnerId: "merge-executor-1",
  };
  const run = existing
    ? await db.run.update({ where: { id: existing.id }, data: live })
    : await db.run.create({ data: {
      projectId: chain.project.id, taskId: chain.integratorTask!.id, agentId: chain.integratorAgent.id,
      repoId: chain.repo.id, runNumber: 1, dedupeKey: `task:${chain.integratorTask!.id}:run:1`,
      runner: "CLAUDE", model: "mechanical/merge-executor-v1", promptHash: "mechanical",
      opensPullRequest: false, ...live,
    } });
  const session = await db.session.findFirst({ where: { runId: run.id } });
  if (!session) {
    await db.session.create({ data: {
      runId: run.id, projectId: chain.project.id, agentId: chain.integratorAgent.id,
      taskId: chain.integratorTask!.id, runner: "CLAUDE", executionStatus: "RUNNING",
    } });
  }
  return { run, token };
};

const sessionGet = async (token: string, path: string): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request(path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};

const requiredChainIndex = (chainIndex: number | null): number => {
  if (chainIndex === null) throw new Error("Integrator fixture task has no chain index");
  return chainIndex;
};

const stepActivityPath = (runId: string, chainIndex: number | null): string =>
  `/session/runs/${runId}/chain/steps/${requiredChainIndex(chainIndex)}/activity`;

const operatorPost = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

/** A chain approved through the real inbox channel, with a live step-12 session. */
const approvedChain = async (label: string) => {
  const chain = await seedIntegratorChain(db, {
    label, gateAttestation: { headSha: "a".repeat(40), baseHeadSha: "b".repeat(40) },
  });
  const card = await db.$transaction(
    (tx) => gateQuestion(tx, chain.gateTask.id, chain.gateRun.id, null),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  await evidenceTick(db, { readPullRequest: async () => snapshot() }, new Date());
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: card.id, externalEventId: `evt-${label}`, decision: "approve",
  }));
  const session = await seedIntegratorSession(chain);
  return { chain, card, ...session };
};

test("N15 the executor reads its predecessor's validated authorization and its own records", async () => {
  const { chain, token, run } = await approvedChain("n15");
  const predecessor = await sessionGet(token, stepActivityPath(run.id, chain.gateTask.chainIndex));
  assert.equal(predecessor.status, 200);
  assert.equal(predecessor.body.authorization.headSha, "a".repeat(40));
  assert.equal(predecessor.body.authorization.prNumber, 123);
  assert.equal(predecessor.body.refusal, null);
  assert.equal(predecessor.body.nearMatchCount, 0);
  // The chain target identity is resolved server-side from immutable run rows.
  assert.equal(predecessor.body.target.resolved, true);
  assert.equal(predecessor.body.target.prNumber, 123);
  assert.equal(predecessor.body.target.repository, "acme/widgets");
});

test("N15 sensitive fields never leave the server", async () => {
  const { chain, token, run } = await approvedChain("n15-sensitive");
  await db.taskActivity.create({ data: {
    taskId: chain.gateTask.id, actorType: "operator",
    body: "operator note: the deploy key is hunter2",
    metadata: { note: "private" },
  } });
  const response = await sessionGet(token, stepActivityPath(run.id, chain.gateTask.chainIndex));
  assert.equal(response.status, 200);
  const serialized = JSON.stringify(response.body);
  assert.ok(!serialized.includes("hunter2"), "operator prose is not part of the contract and is not returned");
  assert.ok(!serialized.includes("private"));
});

test("N15 scope: an earlier index, a later index, and another run's id are all refused", async () => {
  const { chain, token, run } = await approvedChain("n15-scope");
  assert.equal((await sessionGet(token, stepActivityPath(run.id, requiredChainIndex(chain.gateTask.chainIndex) - 1))).status, 403);
  assert.equal((await sessionGet(token, stepActivityPath(run.id, requiredChainIndex(chain.integratorTask!.chainIndex) + 1))).status, 403);
  const other = await approvedChain("n15-other");
  // Path scoping: a session token is bound to its own runId by the auth layer,
  // before any handler sees the request.
  assert.equal((await sessionGet(token, stepActivityPath(other.run.id, other.chain.gateTask.chainIndex))).status, 403);
});

test("N15 eligibility: an ordinary step's session may not use the route at all", async () => {
  const chain = await seedIntegratorChain(db, { label: "n15-eligibility" });
  const { token, hash } = issueSessionToken();
  const run = await db.run.create({ data: {
    projectId: chain.project.id, taskId: chain.gateTask.id, agentId: chain.agent.id, repoId: chain.repo.id,
    runNumber: 9, dedupeKey: `task:${chain.gateTask.id}:run:9`, runner: "CLAUDE", model: "claude-opus-5:high",
    promptHash: "hash", status: "RUNNING", sessionTokenHash: hash, leaseGeneration: 1,
    sessionTokenExpiresAt: new Date(Date.now() + 3_600_000), leaseExpiresAt: new Date(Date.now() + 3_600_000),
  } });
  assert.equal((await sessionGet(token, stepActivityPath(run.id, chain.gateTask.chainIndex))).status, 403);
});

test("N14 a forged authorization carrying a real winning decision id is not returned", async () => {
  const { chain, token, run } = await approvedChain("n14");
  const genuine = (await db.taskActivity.findMany({ where: { taskId: chain.gateTask.id } }))
    .find((row) => (row.metadata as Record<string, unknown> | null)?.kind === MERGE_INTEGRATOR_KIND.authorization);
  const parsed = parseAuthorizationMetadata(genuine!.metadata);
  assert.equal(parsed.status, "ok");

  // The forgery an operator-token holder can actually mount: read a real
  // winning decision id from the Inbox, then post a well-formed record naming
  // it but carrying a head SHA no human ever saw.
  const forged = await operatorPost(`/tasks/${chain.gateTask.id}/activity`, {
    body: "authorization",
    metadata: {
      ...(genuine!.metadata as Record<string, unknown>),
      headSha: "f".repeat(40),
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
    },
  });
  assert.equal(forged.status, 201);

  const response = await sessionGet(token, stepActivityPath(run.id, chain.gateTask.chainIndex));
  assert.equal(response.status, 200);
  // Rule 5 first: the reused decision id disqualifies *both* records, so the
  // executor is left with no authorization rather than with the genuine one —
  // fail closed, then re-authorize.
  assert.equal(response.body.authorization, null);
  assert.notEqual(response.body.refusal, null);
  assert.ok(!JSON.stringify(response.body).includes("f".repeat(40)), "the forged head never reaches the executor");
});

test("N14 a decision id belonging to another chain's gate is refused", async () => {
  const { chain, token, run } = await approvedChain("n14-cross-a");
  const foreign = await approvedChain("n14-cross-b");
  const foreignAuthorization = (await db.taskActivity.findMany({ where: { taskId: foreign.chain.gateTask.id } }))
    .find((row) => (row.metadata as Record<string, unknown> | null)?.kind === MERGE_INTEGRATOR_KIND.authorization);
  // Delete this chain's own record so the foreign one is the only candidate.
  const own = (await db.taskActivity.findMany({ where: { taskId: chain.gateTask.id } }))
    .filter((row) => (row.metadata as Record<string, unknown> | null)?.kind === MERGE_INTEGRATOR_KIND.authorization);
  await db.taskActivity.deleteMany({ where: { id: { in: own.map((row) => row.id) } } });
  await operatorPost(`/tasks/${chain.gateTask.id}/activity`, {
    body: "authorization", metadata: foreignAuthorization!.metadata,
  });
  const response = await sessionGet(token, stepActivityPath(run.id, chain.gateTask.chainIndex));
  assert.equal(response.body.authorization, null);
  assert.equal(response.body.ignoredCount, 1, "a cross-chain decision id is structurally ignored");
});

test("N22 read legs: one, zero, and two observed pull request numbers", async () => {
  const one = await approvedChain("n22-one");
  const single = await sessionGet(one.token, stepActivityPath(one.run.id, one.chain.integratorTask!.chainIndex));
  assert.equal(single.body.target.resolved, true);
  assert.equal(single.body.target.prNumber, 123);
  assert.deepEqual(single.body.records, []);

  // Two delivered pull request numbers cannot be approved at all: the gate
  // falls back to an ordinary card with no evidence block, so the ambiguity
  // surfaces at the gate rather than becoming a coin flip at merge time.
  const twoChain = await seedIntegratorChain(db, { label: "n22-two", prNumbers: [10, 11] });
  const twoSession = await seedIntegratorSession(twoChain);
  const ambiguous = await sessionGet(twoSession.token, stepActivityPath(twoSession.run.id, twoChain.integratorTask!.chainIndex));
  assert.equal(ambiguous.body.target.resolved, false);
  assert.equal(ambiguous.body.target.unresolvable, "ambiguous");
  assert.deepEqual(ambiguous.body.target.observed, [10, 11]);

  const none = await seedIntegratorChain(db, { label: "n22-none" });
  await db.run.updateMany({ where: { taskId: none.gateTask.id }, data: { pullRequestNumber: null } });
  const session = await seedIntegratorSession(none);
  const empty = await sessionGet(session.token, stepActivityPath(session.run.id, none.integratorTask!.chainIndex));
  assert.equal(empty.body.target.resolved, false);
  assert.equal(empty.body.target.unresolvable, "none");
});
