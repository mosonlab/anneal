/**
 * The gate's signature has to survive the seam between the run that reported it
 * and the channel that authorizes the merge.
 *
 * The mechanical channel reads the Regression verdict itself, so it has always
 * seen the proof line. The Inbox and PATCH channels build an authorization out
 * of the card body, which names a head but says nothing about whether any gate
 * ran against it — so before the attestation table a human approval could
 * authorize a merge at a commit the gate never signed. These tests pin that
 * shut, and exempt only registered pre-attestation generations with the frozen
 * v1 Regression protocol. Absent or unrecognised Regression Steps are refused.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  MERGE_INTEGRATOR_KIND,
  Prisma,
  PrismaClient,
  RunStatus,
  TaskStatus,
  applyInboxDecision,
  templateRolloverName,
  DIRECT_INTEGRATOR_TEMPLATE_NAME,
  INTEGRATOR_TEMPLATE_NAME,
  gateQuestion,
  recordGateAttestation,
  requestMergeEvidence,
} from "@anneal/db";

import { patchTask } from "./task-patch.js";
import { persistSessionTaskOutput } from "./canonical-task-output.js";
import { evidenceTick } from "./merge-evidence-worker.js";
import { type PullRequestSnapshot } from "./github-read.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const PROOF = `MERGE GATE: PASS ${HEAD}`;
const V2 = "regression-verification-v2";

const OTHER_BASE = "e".repeat(40);

const passingBody = (head = HEAD, base = BASE): string => JSON.stringify({
  schemaVersion: 2,
  outcome: "pass",
  headSha: head,
  baseHeadSha: base,
  gateVerdict: "PASS",
  gateProof: `MERGE GATE: PASS ${head}`,
});

const snapshot = (): PullRequestSnapshot => ({
  repository: "acme/widgets", number: 123, state: "OPEN", isDraft: false, merged: false,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "master", baseSha: BASE,
  headRefOid: HEAD, headCommitOid: HEAD, autoMergeRequest: null, mergeQueueEntry: null,
  repositoryMergeQueue: null, mergedBy: null, mergeCommit: null, requiredCheckNames: ["ci/build"],
  checkContexts: [{ __typename: "CheckRun", name: "ci/build", status: "COMPLETED", conclusion: "SUCCESS" }],
  readAt: new Date("2026-08-26T00:00:00.000Z").toISOString(),
});

const reader = {
  readPullRequest: async (): Promise<PullRequestSnapshot> => snapshot(),
};

type Chain = Awaited<ReturnType<typeof seedIntegratorChain>>;

/**
 * The Regression node the current canonical graph puts ahead of the merge. The
 * fixture's own gate step models the approval, so the generation of the chain is
 * decided by this step's output kind.
 */
const addRegressionStep = async (chain: Chain, outputKind: string) => {
  const step = await db.taskTemplateStep.create({ data: {
    taskTemplateId: chain.template.id, stepIndex: 0, layer: 0, name: "Regression",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: chain.agent.id, prompt: "verify",
    approvalGate: false, outputKind, opensPullRequest: false,
  } });
  const task = await db.task.create({ data: {
    projectId: chain.project.id, repoId: chain.repo.id, templateId: chain.template.id,
    templateStepId: step.id, name: "Regression", description: "verify",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: chain.agent.id, approvalGate: false,
    chainId: chain.chainId, chainIndex: 0, chainLayer: 0, status: TaskStatus.DONE,
    targetBranch: "master",
  } });
  return { step, task };
};

/** A run this request still owns, which is all `persistSessionTaskOutput` asks for. */
const liveRun = async (chain: Chain, taskId: string) => db.run.create({ data: {
  projectId: chain.project.id, taskId, agentId: chain.agent.id, repoId: chain.repo.id,
  runNumber: 1, dedupeKey: `attestation:${taskId}`, runner: "CLAUDE", model: "claude-opus-5:high",
  promptHash: "hash", status: RunStatus.RUNNING, fencingToken: "token-1",
  leaseExpiresAt: new Date(Date.now() + 600_000), targetBranch: "master", branch: "agentos/chain/demo",
} });

const filledCard = async (chain: Chain) => {
  const card = await db.$transaction(
    (tx) => gateQuestion(tx, chain.gateTask.id, chain.gateRun.id, null),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  await evidenceTick(db, reader, new Date());
  return card;
};

const filledReadinessCard = async (chain: Chain, purpose: "gate" | "confirmation" = "gate") => {
  assert.ok(chain.readinessTask);
  const card = await db.$transaction((tx) => requestMergeEvidence(tx, {
    gateTaskId: chain.readinessTask!.id, integratorTaskId: chain.integratorTask!.id,
    sourceRunId: chain.gateRun.id, agentId: chain.agent.id, sessionId: chain.gateSession.id,
    purpose, repository: "acme/widgets", prNumber: 123, dedupeKey: `${purpose}:${chain.chainId}`,
  }, new Date()));
  await evidenceTick(db, reader, new Date());
  return { id: card.cardId };
};

const approve = (cardId: string, event: string) => applyInboxDecision(
  db, { inboxMessageId: cardId, externalEventId: event, decision: "approve" },
);

const authorizations = async (taskId: string) => (await db.taskActivity.findMany({ where: { taskId } }))
  .filter((row) => (row.metadata as Record<string, unknown> | null)?.kind === MERGE_INTEGRATOR_KIND.authorization);

test("ingesting a passing Regression output records the gate's signature once", async () => {
  const chain = await seedIntegratorChain(db, { label: "attest-ingest" });
  const regression = await addRegressionStep(chain, V2);
  const run = await liveRun(chain, regression.task.id);
  const persist = () => db.$transaction((tx) => persistSessionTaskOutput(tx, {
    task: { id: regression.task.id },
    fence: { runId: run.id, fencingToken: "token-1", at: new Date() },
    kind: V2,
    body: passingBody(),
    commitSha: HEAD,
  }));
  const first = await persist();
  assert.ok("ok" in first && first.ok, "the output persisted");
  // A repair loop may re-persist the same verdict; the attestation is a
  // statement about a commit, so the second write adds nothing.
  await persist();
  const rows = await db.mergeGateAttestation.findMany({ where: { chainId: chain.chainId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.headSha, HEAD);
  assert.equal(rows[0]?.baseHeadSha, BASE);
  assert.equal(rows[0]?.proof, PROOF);
  assert.equal(rows[0]?.runId, run.id);
});

test("a human cannot authorize a merge at a head no gate signed", async () => {
  const chain = await seedIntegratorChain(db, { label: "attest-refuse" });
  await addRegressionStep(chain, V2);
  const card = await filledCard(chain);
  await assert.rejects(
    () => approve(card.id, "evt-unattested"),
    /no merge gate attestation for head/u,
  );
  assert.equal((await authorizations(chain.gateTask.id)).length, 0, "no authorization was written");
});

test("an attestation for another commit does not authorize this head", async () => {
  const chain = await seedIntegratorChain(db, { label: "attest-other" });
  const regression = await addRegressionStep(chain, V2);
  await db.$transaction((tx) => recordGateAttestation(tx, {
    chainId: chain.chainId, taskId: regression.task.id, runId: null,
    kind: V2, body: passingBody("c".repeat(40)),
  }));
  const card = await filledCard(chain);
  await assert.rejects(() => approve(card.id, "evt-other-head"), /no merge gate attestation for head/u);
});

test("the same approval succeeds once the gate has signed the head", async () => {
  const chain = await seedIntegratorChain(db, { label: "attest-allow" });
  const regression = await addRegressionStep(chain, V2);
  await db.$transaction((tx) => recordGateAttestation(tx, {
    chainId: chain.chainId, taskId: regression.task.id, runId: null, kind: V2, body: passingBody(),
  }));
  const card = await filledCard(chain);
  await approve(card.id, "evt-attested");
  assert.equal((await authorizations(chain.gateTask.id)).length, 1);
});

test("a chain whose Regression node is the frozen v1 generation is left alone", async () => {
  const chain = await seedIntegratorChain(db, { label: "attest-legacy" });
  await addRegressionStep(chain, "regression-verification");
  const card = await filledCard(chain);
  await approve(card.id, "evt-legacy");
  assert.equal((await authorizations(chain.gateTask.id)).length, 1);
});

test("an attestation taken against another base does not authorize this merge", async () => {
  // The gate signs a head against a base. This chain has a signature for the
  // exact head the card names, taken while the branch sat on a different base:
  // `satisfied` alone would have let it through.
  const chain = await seedIntegratorChain(db, { label: "attest-base" });
  const regression = await addRegressionStep(chain, V2);
  await db.$transaction((tx) => recordGateAttestation(tx, {
    chainId: chain.chainId, taskId: regression.task.id, runId: null,
    kind: V2, body: passingBody(HEAD, OTHER_BASE),
  }));
  const card = await filledCard(chain);
  await assert.rejects(() => approve(card.id, "evt-base-mismatch"), /gate-attestation-base-mismatch/u);
  assert.equal((await authorizations(chain.gateTask.id)).length, 0, "no authorization was written");
});

test("the same head authorizes once the attested base is the base being merged onto", async () => {
  const chain = await seedIntegratorChain(db, { label: "attest-base-match" });
  const regression = await addRegressionStep(chain, V2);
  await db.$transaction((tx) => recordGateAttestation(tx, {
    chainId: chain.chainId, taskId: regression.task.id, runId: null,
    kind: V2, body: passingBody(HEAD, BASE),
  }));
  const card = await filledCard(chain);
  await approve(card.id, "evt-base-match");
  assert.equal((await authorizations(chain.gateTask.id)).length, 1);
});

test("a Regression Step whose output kind this build does not recognise is not exempt", async () => {
  // The exemption is a registered pre-attestation generation, not "no step of
  // the current kind was found": renaming or adding a kind must not hand a
  // chain the legacy carve-out.
  const chain = await seedIntegratorChain(db, { label: "attest-unknown-kind" });
  await addRegressionStep(chain, "regression-attestation");
  const card = await filledCard(chain);
  await assert.rejects(() => approve(card.id, "evt-unknown-kind"), /no merge gate attestation for head/u);
  assert.equal((await authorizations(chain.gateTask.id)).length, 0, "no authorization was written");
});

test("a Regression Step on a generation later than the frozen one is not exempt", async () => {
  const chain = await seedIntegratorChain(db, { label: "attest-v3" });
  await addRegressionStep(chain, "regression-verification-v3");
  const card = await filledCard(chain);
  await assert.rejects(() => approve(card.id, "evt-v3"), /no merge gate attestation for head/u);
});

for (const templateName of [DIRECT_INTEGRATOR_TEMPLATE_NAME, INTEGRATOR_TEMPLATE_NAME]) {
  for (const marker of ["pre-narrow-regression-lease", "pre-adjudication", ...(templateName === INTEGRATOR_TEMPLATE_NAME ? ["pre-zero-gate", "10", "9", "human-12", "regression-first-13"] : ["human-6"])]) {
    test(`retired ${templateName}/${marker} authorizes its frozen v1 chain`, async () => {
      const chain = await seedIntegratorChain(db, {
        label: "attest-retired",
        shape: templateName === DIRECT_INTEGRATOR_TEMPLATE_NAME ? "canonical-direct" : "canonical-compound-readiness",
        gatedReadiness: true,
      });
      await db.taskTemplate.update({ where: { id: chain.template.id }, data: {
        name: templateRolloverName(templateName, marker, chain.template.id),
      } });
      const card = await filledReadinessCard(chain);
      await approve(card.id, `evt-${marker}`);
      assert.equal((await authorizations(chain.readinessTask!.id)).length, 1);
    });
  }
}

for (const channel of ["inbox", "patch"] as const) {
  for (const purpose of ["gate", "confirmation"] as const) {
    test(`${channel} ${purpose} base refusal survives rollback and preserves the approval card`, async () => {
      const chain = await seedIntegratorChain(db, {
        label: `attest-${channel}-${purpose}`, shape: "canonical-compound-readiness", gatedReadiness: true,
      });
      const readiness = chain.readinessTask!;
      await db.task.update({ where: { id: readiness.id }, data: { status: TaskStatus.REVIEW } });
      const regression = await addRegressionStep(chain, V2);
      await db.$transaction((tx) => recordGateAttestation(tx, {
        chainId: chain.chainId, taskId: regression.task.id, runId: null,
        kind: V2, body: passingBody(HEAD, OTHER_BASE),
      }));
      const card = await filledReadinessCard(chain, purpose);
      await assert.rejects(
        () => channel === "inbox" ? approve(card.id, `evt-${channel}-${purpose}`)
          : patchTask(db, readiness.id, { status: TaskStatus.DONE }),
        /gate-attestation-base-mismatch/u,
      );
      assert.equal((await authorizations(readiness.id)).length, 0);
      assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } })).status, "OPEN");
      assert.equal(await db.inboxDecision.count({ where: { inboxMessageId: card.id } }), 0);
      const activity = await db.taskActivity.findFirstOrThrow({ where: {
        taskId: readiness.id, metadata: { path: ["kind"], equals: "gate-attestation-base-mismatch" },
      } });
      assert.match(activity.body, /gate-attestation-base-mismatch/u);
      assert.deepEqual(activity.metadata, {
        kind: "gate-attestation-base-mismatch", headSha: HEAD, attestedBaseSha: OTHER_BASE,
        authorizationBaseSha: BASE, channel, inboxMessageId: card.id,
      });
    });
  }
}

test("a new attestation at the same head authorizes only the newly verified base", async () => {
  const chain = await seedIntegratorChain(db, { label: "attest-renew-base" });
  const regression = await addRegressionStep(chain, V2);
  const record = (base: string) => db.$transaction((tx) => recordGateAttestation(tx, {
    chainId: chain.chainId, taskId: regression.task.id, runId: null, kind: V2, body: passingBody(HEAD, base),
  }));
  await record(BASE);
  const card = await filledCard(chain);
  await record(OTHER_BASE);
  await assert.rejects(() => approve(card.id, "evt-old-base"), /gate-attestation-base-mismatch/u);
  assert.equal((await authorizations(chain.gateTask.id)).length, 0);
  const stored = await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } });
  await db.inboxMessage.update({ where: { id: card.id }, data: { body: stored.body.replaceAll(BASE, OTHER_BASE) } });
  await approve(card.id, "evt-new-base");
  assert.equal((await authorizations(chain.gateTask.id)).length, 1);
});

for (const kind of [V2, "regression-verification-v3", "regression-attestation"]) {
  test(`a retired name does not exempt ${kind}`, async () => {
    const chain = await seedIntegratorChain(db, { label: "attest-retired-kind" });
    await db.taskTemplate.update({ where: { id: chain.template.id }, data: {
      name: templateRolloverName(INTEGRATOR_TEMPLATE_NAME, "pre-adjudication", chain.template.id),
    } });
    await addRegressionStep(chain, kind);
    const card = await filledCard(chain);
    await assert.rejects(() => approve(card.id, "evt-retired-kind"), /no merge gate attestation for head/u);
    assert.equal((await authorizations(chain.gateTask.id)).length, 0);
  });
}
