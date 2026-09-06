import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  type ChangedFile,
  DependencyProvisioning,
  INTEGRATOR_SENTINEL_MODEL,
  MergeLeaseEventState,
  MERGE_TAIL_KIND,
  Prisma,
  PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import type { PullRequestReader, PullRequestSnapshot } from "./github-read.js";
import {
  deferredLeaseReleases,
  deferredLeaseReleasesStatement,
  LeaseReleaseDeferralRecordError,
  withMergeLease,
  type MergeLeaseAcquirer,
  type MergeLeaseReleaser,
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";
import type { MergeLeaseTarget } from "./merge-lease-hold.js";
import { READINESS_CLAIM_LEASE_MS, readinessTick } from "./merge-readiness-worker.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
const releasedChainLeases: string[] = [];
const releasedLeaseTargets: MergeLeaseTarget[] = [];
const leasedTargets: MergeLeaseTarget[] = [];
const releaseLeaseAdapter: MergeLeaseReleaser = async (chainId) => {
  releasedChainLeases.push(chainId);
  return {
    outcome: "released",
    ref: "refs/merge-lease/holder",
    sha: "lease-fixture",
    acquiredAt: "2026-08-27T12:00:00.000Z",
  };
};
const releaseChainLease: ReleaseMergeLease = async (target) => {
  if (target) {
    releasedChainLeases.push(target.chainId);
    releasedLeaseTargets.push(target);
  }
};
const acquireChainLease: MergeLeaseAcquirer = async () => ({ outcome: "acquired" });
const leaseRunner = (acquire: MergeLeaseAcquirer): WithMergeLease => (
  target,
  fn,
  db,
) => {
  if (target) leasedTargets.push(target);
  return withMergeLease(target, fn, db, {
    acquire,
    release: async (chainId) => {
      const release = await releaseLeaseAdapter(chainId);
      if (target) releasedLeaseTargets.push(target);
      return release;
    },
    now: () => CONFIRMED_RELEASED_AT,
  });
};
const runWithMergeLease = leaseRunner(acquireChainLease);
const unreachableReleaseRunner = (attempts: { count: number }): WithMergeLease => (
  target,
  fn,
  database,
) => withMergeLease(target, fn, database, {
  acquire: acquireChainLease,
  release: async () => {
    attempts.count += 1;
    return { outcome: "unreachable", detail: "release helper timed out" };
  },
});
const leaseHoldMarkers = (projectId: string) => db.taskActivity.findMany({
  where: {
    task: { projectId },
    metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHold },
  },
  orderBy: { createdAt: "asc" },
});
const assertConfirmedHold = async (projectId: string): Promise<void> => {
  const markers = await leaseHoldMarkers(projectId);
  assert.equal(markers.length, 1);
  const metadata = markers[0]!.metadata as Record<string, unknown>;
  assert.equal(metadata.leaseRef, "refs/merge-lease/holder");
  assert.equal(metadata.leaseSha, "lease-fixture");
  assert.equal(metadata.acquiredAt, "2026-08-27T12:00:00.000Z");
  assert.equal(metadata.releasedAt, CONFIRMED_RELEASED_AT.toISOString());
  assert.equal(metadata.heldForSeconds, 62);
};
beforeEach(async () => {
  releasedChainLeases.length = 0;
  releasedLeaseTargets.length = 0;
  leasedTargets.length = 0;
  await resetTestDb(db);
});
after(async () => { await db.$disconnect(); });

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const BRANCH = "agentos/merge-tail-test";
const NEWER_CLAIM_TOKEN = "new-worker-token";
const NEWER_CLAIM_EXPIRY = new Date("2099-01-01T00:00:00.000Z");
const CONFIRMED_RELEASED_AT = new Date("2026-08-27T12:01:02.999Z");

const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  repository: "acme/widgets",
  number: 41,
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRefName: "main",
  headRefOid: HEAD,
  baseSha: BASE,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  repositoryMergeQueue: null,
  mergedBy: null,
  mergeCommit: null,
  requiredCheckNames: [],
  checkContexts: [],
  headCommitOid: HEAD,
  readAt: new Date().toISOString(),
  ...overrides,
});

const reader = (
  files: ChangedFile[] = [],
  pullRequest = snapshot(),
): PullRequestReader => ({
  readPullRequest: async () => pullRequest,
  compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files }),
});

const seedReadiness = async () => {
  const project = await db.project.create({ data: { name: "Merge tail", slug: `merge-tail-${Date.now()}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const makeAgent = (name: string, model = "gpt-5.6-sol:high") => db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name,
    title: name,
    model,
    runnerPreference: model === INTEGRATOR_SENTINEL_MODEL ? "INHERIT" : "CODEX",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const [regressionAgent, reviewAgent, integratorAgent] = await Promise.all([
    makeAgent("code-reviewer-sol-high"),
    makeAgent("review-coordinator-astra-medium"),
    makeAgent("merge-integrator", INTEGRATOR_SENTINEL_MODEL),
  ]);
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "widgets",
    remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo",
    defaultBranch: "main",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  for (const agent of [regressionAgent, reviewAgent, integratorAgent]) {
    await db.agentRepoAccess.create({ data: {
      projectId: project.id,
      agentId: agent.id,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: "GIT_WRITE",
    } });
  }
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: "direct-engineer-workflow",
    description: "autonomous direct tail",
    variables: [],
  } });
  const [regressionStep, readinessStep, integratorStep] = await Promise.all([
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: 5, layer: 5, name: "Regression", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: regressionAgent.id, prompt: "verify", approvalGate: false,
      outputKind: "regression-verification", opensPullRequest: false,
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: 6, layer: 6, name: "Readiness", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: reviewAgent.id, prompt: "mechanical", approvalGate: false,
      outputKind: "merge-authorization", opensPullRequest: false,
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: 7, layer: 7, name: "Merge", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: integratorAgent.id, prompt: "merge", approvalGate: false,
      outputKind: "merge-result", opensPullRequest: false,
    } }),
  ]);
  const chainId = `tail-${Date.now()}`;
  const regression = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: regressionStep.id,
    name: "Regression", description: "verify", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: regressionAgent.id, status: TaskStatus.DONE, chainId, chainIndex: 5, chainLayer: 5, targetBranch: "main",
  } });
  const readiness = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: readinessStep.id,
    name: "Readiness", description: "authorize", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: reviewAgent.id, status: TaskStatus.TODO, chainId, chainIndex: 6, chainLayer: 6, targetBranch: "main",
  } });
  const integrator = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: integratorStep.id,
    name: "Merge", description: "merge", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: integratorAgent.id, status: TaskStatus.TODO, chainId, chainIndex: 7, chainLayer: 7,
    targetBranch: "main", opensPullRequest: false,
  } });
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: regression.id, agentId: regressionAgent.id, repoId: repo.id,
    runNumber: 1, dedupeKey: `task:${regression.id}:run:1`, runner: "CODEX", model: regressionAgent.model,
    promptHash: "hash", status: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH,
    targetBranch: "main", headSha: HEAD, pullRequestNumber: 41,
    pullRequestUrl: "https://github.com/acme/widgets/pull/41",
  } });
  await db.taskStepOutput.create({ data: {
    taskId: regression.id,
    runId: run.id,
    kind: "regression-verification",
    body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: HEAD, baseHeadSha: BASE, gateVerdict: "PASS" }),
    commitSha: HEAD,
  } });
  return { project, repo, regression, readiness, integrator };
};

const assertDeferredReleaseAndRetry = async (
  seeded: Awaited<ReturnType<typeof seedReadiness>>,
  now: Date,
): Promise<void> => {
  const pending = await db.taskActivity.findMany({ where: {
    taskId: seeded.regression.id,
    metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseRelease },
  }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  assert.equal(pending.length, 1, "the failed release writes exactly one durable record");
  const metadata = pending[0]!.metadata as Record<string, unknown>;
  assert.equal(metadata.state, "release-deferred");
  assert.equal(metadata.projectId, seeded.project.id);
  assert.equal(metadata.chainId, seeded.regression.chainId);
  assert.equal(metadata.taskId, seeded.regression.id);
  assert.equal(metadata.failureDetail, "release helper timed out");
  assert.equal(typeof metadata.ledgerId, "string");
  const ledgerId = String(metadata.ledgerId);
  const pendingLedger = await db.mergeLeaseEvent.findUniqueOrThrow({ where: { id: ledgerId } });
  assert.equal(pendingLedger.state, MergeLeaseEventState.RELEASE_DEFERRED);

  const retried: MergeLeaseTarget[] = [];
  assert.equal(await reconcileDatabaseRuns(db, new Date(now.getTime() + 1_000), async (target) => {
    if (target) retried.push(target);
  }), 1);
  assert.deepEqual(retried, [{ projectId: seeded.project.id, chainId: seeded.regression.chainId }]);
  const terminal = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.regression.id,
    AND: [
      { metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseRelease } },
      { metadata: { path: ["state"], equals: "released" } },
    ],
  } });
  assert.equal((terminal.metadata as Record<string, unknown>).ledgerId, ledgerId);
  assert.equal(
    (await db.mergeLeaseEvent.findUniqueOrThrow({ where: { id: ledgerId } })).state,
    MergeLeaseEventState.RELEASED,
  );
  assert.equal(await reconcileDatabaseRuns(db, new Date(now.getTime() + 2_000), async () => {
    throw new Error("a terminal deferred release must not retry");
  }), 0);
};

test("the no-deferral sweep uses its ledger index without a MergeLeaseEvent scan or sort", async () => {
  const seeded = await seedReadiness();
  const settledAt = new Date("2026-08-29T12:00:00.000Z");
  const noise = Array.from({ length: 5_000 }, (_, index) => ({
    projectId: seeded.project.id,
    chainId: `${seeded.regression.chainId}-terminal-${index}`,
    leaseRef: "refs/merge-lease/holder",
    leaseSha: `terminal-lease-${index}`,
    state: MergeLeaseEventState.RELEASED,
    owningTaskId: seeded.regression.id,
    settledAt,
    acquiredAt: settledAt,
  }));
  const handoffRun = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  const openHandoffNoise = Array.from({ length: 5_000 }, (_, index) => ({
    projectId: seeded.project.id,
    chainId: `${seeded.regression.chainId}-handoff-${index}`,
    state: MergeLeaseEventState.HANDOFF_PENDING,
    owningTaskId: seeded.regression.id,
    handedOffRunId: handoffRun.id,
    handedOffAt: settledAt,
  }));
  await db.mergeLeaseEvent.createMany({ data: noise });
  await db.mergeLeaseEvent.createMany({ data: openHandoffNoise });
  await db.$executeRawUnsafe('ANALYZE "MergeLeaseEvent"');

  type PlanNode = {
    "Node Type"?: string;
    "Relation Name"?: string;
    "Index Name"?: string;
    Plans?: PlanNode[];
  };
  const rows = await db.$transaction(async (tx) => {
    assert.deepEqual(await deferredLeaseReleases(tx), []);
    return tx.$queryRaw<Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>>(
      Prisma.sql`EXPLAIN (FORMAT JSON, COSTS OFF) ${deferredLeaseReleasesStatement}`,
    );
  });

  const root = rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
  assert.ok(root, "PostgreSQL returned an EXPLAIN plan");
  const nodes: PlanNode[] = [];
  const collect = (node: PlanNode): void => {
    nodes.push(node);
    node.Plans?.forEach(collect);
  };
  collect(root);
  assert.ok(
    nodes.some((node) => node["Index Name"] === "MergeLeaseEvent_state_deferredAt_id_idx"),
    `unexpected deferred-release plan: ${JSON.stringify(root)}`,
  );
  assert.equal(nodes.some((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "MergeLeaseEvent"), false);
  assert.equal(nodes.some((node) => node["Node Type"] === "Sort"), false);
});

test("clean exact-head readiness authorizes and queues mechanical merge", async () => {
  const seeded = await seedReadiness();
  await db.task.update({
    where: { id: seeded.regression.id },
    data: { failureReason: "readiness evaluation failed: GitHub read failed: fetch failed" },
  });
  assert.deepEqual(await readinessTick(db, reader(), new Date(), 5, releaseChainLease, runWithMergeLease), { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).failureReason, null);
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: seeded.readiness.id } });
  assert.equal(output.commitSha, HEAD);
  assert.equal((await db.run.count({ where: { taskId: seeded.integrator.id } })), 1);
  assert.deepEqual(leasedTargets, [{ projectId: seeded.project.id, chainId: seeded.readiness.chainId }]);
  assert.deepEqual(releasedChainLeases, [], "retained authorization is released by the final consumer");
  assert.deepEqual(releasedLeaseTargets, []);
  assert.equal((await leaseHoldMarkers(seeded.project.id)).length, 0, "retained authorization is not measured before its consumer releases");
});

test("a defense-list diff authorizes the merge and leaves one audit message behind", async () => {
  const seeded = await seedReadiness();
  const guarded = reader([{ filename: "scripts/merge-gate.sh", previousFilename: null, patch: "@@ -1 +1 @@\n-old\n+new" }]);
  assert.deepEqual(await readinessTick(db, guarded, new Date(), 5, releaseChainLease, runWithMergeLease), { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });

  // The merge is not held: the readiness step completes and the mechanical
  // merge is queued exactly as it is for an untriggered diff.
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: seeded.integrator.id } }), 1);
  assert.equal(await db.task.count({ where: { name: "Autonomous merge tail: independent review" } }), 0);

  const audit = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.readiness.id } });
  assert.equal(audit.dedupeKey, `defense-audit:${seeded.readiness.id}:${HEAD}`);
  assert.match(audit.body, /^Merge proceeded with defense-list changes/u);
  assert.match(audit.body, /- scripts\/merge-gate\.sh \(merge-tail-machinery\)/u);
});

test("a re-evaluated head writes the audit message once rather than raising P2002", async () => {
  const seeded = await seedReadiness();
  const guarded = reader([{ filename: "scripts/merge-gate.sh", previousFilename: null, patch: "@@ -1 +1 @@\n-old\n+new" }]);
  assert.equal((await readinessTick(db, guarded, new Date(), 5, releaseChainLease, runWithMergeLease)).authorized, 1);
  // Same readiness task, same exact head: the second authorization leaves the
  // existing digest row alone instead of failing inside its own transaction.
  await db.task.update({ where: { id: seeded.readiness.id }, data: { status: TaskStatus.TODO, failureReason: null } });
  const mergeRuns = await db.run.findMany({
    where: { taskId: seeded.integrator.id },
    select: { id: true },
  });
  assert.equal((await db.mergeLeaseEvent.deleteMany({ where: {
    projectId: seeded.project.id,
    chainId: seeded.integrator.chainId!,
    handedOffRunId: { in: mergeRuns.map((run) => run.id) },
  } })).count, 1);
  await db.run.deleteMany({ where: { taskId: seeded.integrator.id } });
  assert.equal((await readinessTick(db, guarded, new Date(), 5, releaseChainLease, runWithMergeLease)).authorized, 1);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.readiness.id } }), 1);
});

test("base drift invalidates a head-bound PASS and returns the chain to regression", async () => {
  const seeded = await seedReadiness();
  const driftedBase = "d".repeat(40);
  assert.deepEqual(await readinessTick(db, reader([], snapshot({ baseSha: driftedBase })), new Date(), 5, releaseChainLease, runWithMergeLease), { claimed: 1, authorized: 0, requeued: 1, stopped: 0 });
  const [readiness, regression] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
  ]);
  assert.equal(readiness.status, TaskStatus.TODO);
  assert.equal(regression.status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);
  const compensated = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id },
    orderBy: { runNumber: "desc" },
  });
  assert.equal(compensated.runNumber, 2);
  assert.equal(compensated.maxRunsPerTask, 6);
  assert.equal(compensated.budgetGrants, 1);
  assert.deepEqual(releasedChainLeases, [seeded.readiness.chainId], "base drift requeue releases before the next v2 Regression run");
});

test("base drift after lease acquisition is rechecked before authorization", async () => {
  const seeded = await seedReadiness();
  const driftedBase = "d".repeat(40);
  let reads = 0;
  const movingReader: PullRequestReader = {
    readPullRequest: async () => {
      reads += 1;
      return snapshot({ baseSha: reads === 1 ? BASE : driftedBase });
    },
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
  };

  assert.deepEqual(
    await readinessTick(db, movingReader, new Date(), 5, releaseChainLease, runWithMergeLease),
    { claimed: 1, authorized: 0, requeued: 1, stopped: 0 },
  );
  assert.equal(reads, 2);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.TODO);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: seeded.integrator.id } }), 0);
  assert.deepEqual(releasedChainLeases, [seeded.readiness.chainId]);
  assert.deepEqual(leasedTargets, [{ projectId: seeded.project.id, chainId: seeded.readiness.chainId }]);
  assert.deepEqual(releasedLeaseTargets, [{ projectId: seeded.project.id, chainId: seeded.readiness.chainId }]);
  await assertConfirmedHold(seeded.project.id);
});

test("post-acquire readiness stop releases its own confirmed lease", async () => {
  const seeded = await seedReadiness();
  let reads = 0;
  const movingReader: PullRequestReader = {
    readPullRequest: async () => {
      reads += 1;
      return snapshot({ baseSha: reads === 1 ? BASE : null });
    },
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
  };

  assert.deepEqual(
    await readinessTick(db, movingReader, new Date(), 5, releaseChainLease, runWithMergeLease),
    { claimed: 1, authorized: 0, requeued: 0, stopped: 1 },
  );
  assert.equal(reads, 2);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.REVIEW);
  assert.deepEqual(leasedTargets, [{ projectId: seeded.project.id, chainId: seeded.readiness.chainId }]);
  assert.deepEqual(releasedChainLeases, [seeded.readiness.chainId]);
  assert.deepEqual(releasedLeaseTargets, [{ projectId: seeded.project.id, chainId: seeded.readiness.chainId }]);
  await assertConfirmedHold(seeded.project.id);
});

test("a post-acquire release or hold-recording failure remains observable", async () => {
  const seeded = await seedReadiness();
  let reads = 0;
  const movingReader: PullRequestReader = {
    readPullRequest: async () => {
      reads += 1;
      return snapshot({ baseSha: reads === 1 ? BASE : null });
    },
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
  };
  const releaseFailure = new Error("lease hold recording failed");
  const failingFinalRelease: WithMergeLease = async (target, fn) => {
    if (target) leasedTargets.push(target);
    const result = await fn();
    if (result.leaseOutcome.kind === "stop") throw releaseFailure;
    return { outcome: "ran", value: result.value };
  };

  await assert.rejects(
    readinessTick(db, movingReader, new Date(), 5, releaseChainLease, failingFinalRelease),
    (error: unknown) => error === releaseFailure,
  );
  assert.equal(reads, 2);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.REVIEW);
  assert.deepEqual(leasedTargets, [{ projectId: seeded.project.id, chainId: seeded.readiness.chainId }]);
  assert.deepEqual(releasedLeaseTargets, []);
});

test("ordinary base requeue authorizes the refreshed exact head", async () => {
  const seeded = await seedReadiness();
  const driftedBase = "d".repeat(40);
  assert.equal((await readinessTick(db, reader([], snapshot({ baseSha: driftedBase })), new Date(), 5, releaseChainLease, runWithMergeLease)).requeued, 1);
  const freshRun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
  });
  await db.run.update({ where: { id: freshRun.id }, data: { status: "SUCCEEDED", headSha: HEAD } });
  await db.taskStepOutput.update({ where: { taskId: seeded.regression.id }, data: {
    runId: freshRun.id,
    body: JSON.stringify({
      schemaVersion: 1, outcome: "pass", headSha: HEAD, baseHeadSha: driftedBase, gateVerdict: "PASS",
    }),
    commitSha: HEAD,
  } });
  await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.DONE } });
  const guarded = reader(
    [{ filename: "scripts/merge-gate.sh", previousFilename: null, patch: "@@ -1 +1 @@\n-old\n+new" }],
    snapshot({ baseSha: driftedBase }),
  );
  assert.deepEqual(await readinessTick(db, guarded, new Date(), 5, releaseChainLease, runWithMergeLease), {
    claimed: 1, authorized: 1, requeued: 0, stopped: 0,
  });
  assert.equal(await db.task.count({ where: { name: "Autonomous merge tail: independent review" } }), 0);
});

test("future readiness waits but the readiness role is claimed regardless of ordinal", async () => {
  const future = await seedReadiness();
  await db.task.update({ where: { id: future.regression.id }, data: { status: TaskStatus.TODO } });
  assert.deepEqual(await readinessTick(db, reader(), new Date(), 5, releaseChainLease, runWithMergeLease), { claimed: 0, authorized: 0, requeued: 0, stopped: 0 });
  assert.equal(await db.inboxMessage.count(), 0);

  await db.task.update({ where: { id: future.regression.id }, data: { status: TaskStatus.DONE } });
  await db.taskTemplateStep.update({ where: { id: future.readiness.templateStepId! }, data: { stepIndex: 9 } });
  assert.deepEqual(await readinessTick(db, reader(), new Date(), 5, releaseChainLease, runWithMergeLease), { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: future.readiness.id } })).status, TaskStatus.DONE);
});

test("an expired orphaned DOING readiness claim is reclaimed after restart", async () => {
  const seeded = await seedReadiness();
  await db.task.update({ where: { id: seeded.readiness.id }, data: {
    status: TaskStatus.DOING,
    readinessClaimToken: "dead-worker-token",
    readinessClaimExpiresAt: new Date("2000-01-01T00:00:00.000Z"),
  } });
  assert.deepEqual(await readinessTick(db, reader(), new Date(), 5, releaseChainLease, runWithMergeLease), { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });
});

test("a pre-migration readiness claim waits through its expiry and is then recovered", async () => {
  const seeded = await seedReadiness();
  const expiresAt = new Date("2026-08-29T12:01:00.000Z");
  await db.task.update({ where: { id: seeded.readiness.id }, data: {
    status: TaskStatus.DOING,
    failureReason: `merge-readiness-claim:legacy|${expiresAt.toISOString()}`,
    readinessClaimToken: null,
    readinessClaimExpiresAt: null,
  } });

  assert.deepEqual(
    await readinessTick(db, reader(), new Date(expiresAt.getTime() - 1), 5, releaseChainLease, runWithMergeLease),
    { claimed: 0, authorized: 0, requeued: 0, stopped: 0 },
  );
  const waiting = await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } });
  assert.match(waiting.failureReason ?? "", /^merge-readiness-claim:/u);
  assert.equal(waiting.readinessClaimToken, null);
  assert.equal(waiting.readinessClaimExpiresAt, null);

  assert.deepEqual(
    await readinessTick(db, reader(), expiresAt, 5, releaseChainLease, runWithMergeLease),
    { claimed: 1, authorized: 1, requeued: 0, stopped: 0 },
  );
  const recovered = await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } });
  assert.equal(recovered.status, TaskStatus.DONE);
  assert.equal(recovered.failureReason, null);
  assert.equal(recovered.readinessClaimToken, null);
  assert.equal(recovered.readinessClaimExpiresAt, null);
});

test("an incomplete compare response and a behind head fail closed", async () => {
  const incomplete = await seedReadiness();
  const maxFiles = Array.from({ length: 300 }, (_, index) => ({
    filename: `docs/benign-${index}.md`, previousFilename: null, patch: "+new",
  }));
  const incompleteReader: PullRequestReader = {
    readPullRequest: async () => snapshot(),
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: false, files: maxFiles }),
  };
  assert.deepEqual(await readinessTick(db, incompleteReader, new Date(), 5, releaseChainLease, runWithMergeLease), { claimed: 1, authorized: 0, requeued: 0, stopped: 1 });
  assert.match((await db.task.findUniqueOrThrow({ where: { id: incomplete.readiness.id } })).failureReason ?? "", /completeness/u);
  assert.deepEqual(releasedChainLeases, [incomplete.readiness.chainId]);
  assert.deepEqual(releasedLeaseTargets, [{ projectId: incomplete.readiness.projectId, chainId: incomplete.readiness.chainId }]);

  await resetTestDb(db);
  releasedChainLeases.length = 0;
  const behind = await seedReadiness();
  const behindReader: PullRequestReader = {
    readPullRequest: async () => snapshot(),
    compareCommits: async () => ({ status: "behind", behindBy: 1, filesComplete: true, files: [] }),
  };
  assert.deepEqual(await readinessTick(db, behindReader, new Date(), 5, releaseChainLease, runWithMergeLease), { claimed: 1, authorized: 0, requeued: 1, stopped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: behind.regression.id } })).status, TaskStatus.TODO);
  assert.deepEqual(releasedChainLeases, [behind.readiness.chainId]);
});

test("an absent runner-created PR identity stops loudly before authorization", async () => {
  const seeded = await seedReadiness();
  await db.run.updateMany({ where: { taskId: seeded.regression.id }, data: {
    pullRequestNumber: null, pullRequestUrl: null,
  } });
  assert.deepEqual(await readinessTick(db, reader(), new Date(), 5, releaseChainLease, runWithMergeLease), { claimed: 1, authorized: 0, requeued: 0, stopped: 1 });
  assert.match((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).failureReason ?? "", /pull-request target/u);
  assert.deepEqual(releasedChainLeases, [seeded.readiness.chainId]);
});

test("manual start cannot turn server-owned readiness into a model run", async () => {
  const seeded = await seedReadiness();
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "merge-tail-readiness-operator";
  try {
    const response = await createApp(db).request(`/tasks/${seeded.readiness.id}/start`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-readiness-operator", "Content-Type": "application/json" },
    });
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /server-owned/u);
    assert.equal(await db.run.count({ where: { taskId: seeded.readiness.id } }), 0);
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = prior;
  }
});

test("a contended lease leaves readiness for a later tick instead of authorizing", async () => {
  const seeded = await seedReadiness();
  const asked: string[] = [];
  const holder = {
    holder: "runner@executor",
    task: "chain-elsewhere",
    reason: "chain merge tail chain-elsewhere",
    acquiredAt: "2026-09-06T10:00:00.000Z",
    sha: "b".repeat(40),
  };
  const contended: MergeLeaseAcquirer = async (chainId) => {
    asked.push(chainId);
    return { outcome: "contended", holder };
  };
  const started = new Date();
  assert.deepEqual(
    await readinessTick(db, reader(), started, 5, releaseChainLease, leaseRunner(contended)),
    { claimed: 1, authorized: 0, requeued: 0, stopped: 0 },
  );
  assert.deepEqual(asked, [seeded.readiness.chainId]);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: seeded.readiness.id } }), 0);
  assert.equal(await db.run.count({ where: { taskId: seeded.integrator.id } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DOING);
  assert.deepEqual(releasedChainLeases, []);
  // The contention is visible from the first tick: an operator reading this
  // task learns who is in the way without waiting for the alert window.
  const contention = await db.taskActivity.findMany({
    where: {
      taskId: seeded.readiness.id,
      metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseContention },
    },
  });
  assert.equal(contention.length, 1);
  assert.equal((contention[0]!.metadata as Record<string, unknown>).state, "contended");
  assert.match(contention[0]!.body, /held by runner@executor \(task chain-elsewhere/u);

  // The claim, not a retry counter, is what brings it back: once the claim
  // expires the next tick re-evaluates and takes the lease it could not get.
  const acquired: MergeLeaseAcquirer = async () => ({ outcome: "acquired" });
  assert.deepEqual(
    await readinessTick(
      db,
      reader(),
      new Date(started.getTime() + (READINESS_CLAIM_LEASE_MS * 2)),
      5,
      releaseChainLease,
      leaseRunner(acquired),
    ),
    { claimed: 1, authorized: 1, requeued: 0, stopped: 0 },
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: seeded.integrator.id } }), 1);
  // Taking the lease closes the episode, so the next contention is measured
  // from its own beginning rather than from this one.
  const resolved = await db.taskActivity.findFirst({
    where: {
      taskId: seeded.readiness.id,
      metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseContention },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  assert.equal((resolved!.metadata as Record<string, unknown>).state, "resolved");
});

test("a stale worker cannot stop readiness after a newer worker owns the claim", async () => {
  const seeded = await seedReadiness();
  let startRead!: () => void;
  let finishRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { startRead = resolve; });
  const readMayFinish = new Promise<void>((resolve) => { finishRead = resolve; });
  const delayed: PullRequestReader = {
    readPullRequest: async () => {
      startRead();
      await readMayFinish;
      return snapshot({ baseSha: null });
    },
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
  };
  const tick = readinessTick(db, delayed, new Date(), 5, releaseChainLease, runWithMergeLease);
  await readStarted;
  await db.task.update({
    where: { id: seeded.readiness.id },
    data: {
      status: TaskStatus.DOING,
      readinessClaimToken: NEWER_CLAIM_TOKEN,
      readinessClaimExpiresAt: NEWER_CLAIM_EXPIRY,
    },
  });
  finishRead();

  assert.deepEqual(await tick, { claimed: 1, authorized: 0, requeued: 0, stopped: 0 });
  const [readiness, regression] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
  ]);
  assert.equal(readiness.status, TaskStatus.DOING);
  assert.equal(readiness.readinessClaimToken, NEWER_CLAIM_TOKEN);
  assert.equal(regression.status, TaskStatus.DONE);
  assert.deepEqual(releasedChainLeases, []);
});

test("a stale worker cannot requeue regression after a newer worker owns the claim", async () => {
  const seeded = await seedReadiness();
  let startRead!: () => void;
  let finishRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { startRead = resolve; });
  const readMayFinish = new Promise<void>((resolve) => { finishRead = resolve; });
  const delayed: PullRequestReader = {
    readPullRequest: async () => {
      startRead();
      await readMayFinish;
      return snapshot({ headRefOid: "c".repeat(40) });
    },
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
  };
  const tick = readinessTick(db, delayed, new Date(), 5, releaseChainLease, runWithMergeLease);
  await readStarted;
  await db.task.update({
    where: { id: seeded.readiness.id },
    data: {
      status: TaskStatus.DOING,
      readinessClaimToken: NEWER_CLAIM_TOKEN,
      readinessClaimExpiresAt: NEWER_CLAIM_EXPIRY,
    },
  });
  finishRead();

  assert.deepEqual(await tick, { claimed: 1, authorized: 0, requeued: 0, stopped: 0 });
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.DONE);
});

test("an unreachable merge lease acquire defers mechanically without spending regression", async () => {
  const seeded = await seedReadiness();
  const unreachable: MergeLeaseAcquirer = async () => ({ outcome: "unreachable", detail: "spawn bash ENOENT" });
  const started = new Date();
  assert.deepEqual(
    await readinessTick(db, reader(), started, 5, releaseChainLease, leaseRunner(unreachable)),
    { claimed: 1, authorized: 0, requeued: 0, stopped: 0 },
  );
  const readiness = await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } });
  assert.equal(readiness.status, TaskStatus.DOING);
  assert.notEqual(readiness.readinessClaimToken, null);
  assert.notEqual(readiness.readinessClaimExpiresAt, null);
  assert.equal(readiness.failureReason, null);
  const activity = await db.taskActivity.findFirstOrThrow({ where: { taskId: seeded.readiness.id } });
  assert.match(activity.body, /lease transport deferred.*ENOENT/ui);
  assert.deepEqual(releasedChainLeases, []);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 1);

  assert.deepEqual(
    await readinessTick(
      db,
      reader(),
      new Date(started.getTime() + (READINESS_CLAIM_LEASE_MS * 2)),
      5,
      releaseChainLease,
      runWithMergeLease,
    ),
    { claimed: 1, authorized: 1, requeued: 0, stopped: 0 },
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 1);
});

test("authorize without a handoff durably defers an unreachable finished-claim release for reconciliation", async () => {
  const seeded = await seedReadiness();
  await db.task.update({ where: { id: seeded.integrator.id }, data: { status: TaskStatus.DONE } });
  const now = new Date();
  const attempts = { count: 0 };

  assert.deepEqual(
    await readinessTick(db, reader(), now, 5, releaseChainLease, unreachableReleaseRunner(attempts)),
    { claimed: 1, authorized: 0, requeued: 0, stopped: 0 },
  );
  assert.equal(attempts.count, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.DONE);
  await assertDeferredReleaseAndRetry(seeded, now);
  assert.equal(attempts.count, 1, "readiness does not immediately retry the unreachable release");
});

test("a semantic stop durably defers an unreachable finished-claim release for reconciliation", async () => {
  const seeded = await seedReadiness();
  const now = new Date();
  const attempts = { count: 0 };
  let reads = 0;
  const movingReader: PullRequestReader = {
    readPullRequest: async () => {
      reads += 1;
      return snapshot({ baseSha: reads === 1 ? BASE : null });
    },
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
  };

  assert.deepEqual(
    await readinessTick(db, movingReader, now, 5, releaseChainLease, unreachableReleaseRunner(attempts)),
    { claimed: 1, authorized: 0, requeued: 0, stopped: 1 },
  );
  assert.equal(attempts.count, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.REVIEW);
  await assertDeferredReleaseAndRetry(seeded, now);
  assert.equal(attempts.count, 1);
});

test("a base requeue durably defers an unreachable finished-claim release for reconciliation", async () => {
  const seeded = await seedReadiness();
  const now = new Date();
  const attempts = { count: 0 };
  const movedBase = "d".repeat(40);
  let reads = 0;
  const movingReader: PullRequestReader = {
    readPullRequest: async () => {
      reads += 1;
      return snapshot({ baseSha: reads === 1 ? BASE : movedBase });
    },
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
  };

  assert.deepEqual(
    await readinessTick(db, movingReader, now, 5, releaseChainLease, unreachableReleaseRunner(attempts)),
    { claimed: 1, authorized: 0, requeued: 1, stopped: 0 },
  );
  assert.equal(attempts.count, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.TODO);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.TODO);
  await assertDeferredReleaseAndRetry(seeded, now);
  assert.equal(attempts.count, 1);
});

test("a deferred-release record failure surfaces without a readiness REVIEW or second release", async () => {
  const seeded = await seedReadiness();
  await db.task.update({ where: { id: seeded.integrator.id }, data: { status: TaskStatus.DONE } });
  const target = { projectId: seeded.project.id, chainId: seeded.regression.chainId! };
  const recordFailure = new Error("release-deferred activity write failed");
  let callbackRan = false;
  const failedWriter: WithMergeLease = async (_target, fn) => {
    await fn();
    callbackRan = true;
    throw new LeaseReleaseDeferralRecordError(target, seeded.regression.id, recordFailure);
  };

  await assert.rejects(
    readinessTick(db, reader(), new Date(), 5, releaseChainLease, failedWriter),
    (error: unknown) => error instanceof LeaseReleaseDeferralRecordError && error.cause === recordFailure,
  );
  assert.equal(callbackRan, true);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.DONE);
  assert.deepEqual(releasedLeaseTargets, []);
});

test("reconciliation invalidates a deferred release whose validated holder later changes", async () => {
  const seeded = await seedReadiness();
  await db.task.update({ where: { id: seeded.integrator.id }, data: { status: TaskStatus.DONE } });
  const now = new Date();
  const attempts = { count: 0 };
  await readinessTick(db, reader(), now, 5, releaseChainLease, unreachableReleaseRunner(attempts));
  const deferred = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.regression.id,
    metadata: { path: ["state"], equals: "release-deferred" },
  } });
  const deferredMetadata = deferred.metadata as Record<string, unknown>;
  assert.equal(typeof deferredMetadata.ledgerId, "string");
  const ledgerId = String(deferredMetadata.ledgerId);
  assert.equal(
    (await db.mergeLeaseEvent.findUniqueOrThrow({ where: { id: ledgerId } })).state,
    MergeLeaseEventState.RELEASE_DEFERRED,
  );
  await db.task.update({
    where: { id: seeded.regression.id },
    data: { chainId: `${seeded.regression.chainId}-changed` },
  });

  assert.equal(await reconcileDatabaseRuns(db, new Date(now.getTime() + 1_000), async () => {
    throw new Error("an invalid deferred target must not be released");
  }), 1);
  const invalid = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.regression.id,
    metadata: { path: ["state"], equals: "invalid" },
  } });
  const metadata = invalid.metadata as Record<string, unknown>;
  assert.equal(metadata.ledgerId, ledgerId);
  assert.equal(
    (await db.mergeLeaseEvent.findUniqueOrThrow({ where: { id: ledgerId } })).state,
    MergeLeaseEventState.INVALID,
  );
  assert.match(String(metadata.reason), /no longer matches/u);
  assert.equal(await reconcileDatabaseRuns(db, new Date(now.getTime() + 2_000), async () => {
    throw new Error("an invalid deferred target must remain terminal");
  }), 0);
});

test("an unreachable post-acquire release durably defers without review or a second release", async () => {
  const seeded = await seedReadiness();
  let releaseAttempts = 0;
  const unreachableRelease: WithMergeLease = (target, _fn, database) => withMergeLease(target, async () => {
    throw new Error("authorization transaction failed before settlement");
  }, database, {
    acquire: acquireChainLease,
    release: async () => {
      releaseAttempts += 1;
      return { outcome: "unreachable", detail: "release helper timed out" };
    },
  });

  assert.deepEqual(
    await readinessTick(db, reader(), new Date(), 5, releaseChainLease, unreachableRelease),
    { claimed: 1, authorized: 0, requeued: 0, stopped: 0 },
  );
  assert.equal(releaseAttempts, 1);
  assert.deepEqual(releasedLeaseTargets, []);
  const readiness = await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } });
  assert.equal(readiness.status, TaskStatus.DOING);
  assert.equal(readiness.failureReason, null);
  assert.notEqual(readiness.readinessClaimToken, null);
  const activity = await db.taskActivity.findFirstOrThrow({
    where: { taskId: seeded.readiness.id, metadata: { path: ["state"], equals: "lease-transport-deferred" } },
  });
  assert.match(activity.body, /authorization transaction failed before settlement/u);
  assert.match(activity.body, /release helper timed out/u);
});

test("a worker that acquired then lost its claim releases without a concrete successor Run", async () => {
  const abandoned = await seedReadiness();
  const loseToOperator: MergeLeaseAcquirer = async () => {
    await db.task.update({
      where: { id: abandoned.readiness.id },
      data: { status: TaskStatus.REVIEW, failureReason: "operator parked readiness" },
    });
    return { outcome: "acquired" };
  };
  assert.deepEqual(
    await readinessTick(db, reader(), new Date(), 5, releaseChainLease, leaseRunner(loseToOperator)),
    { claimed: 1, authorized: 0, requeued: 0, stopped: 0 },
  );
  assert.deepEqual(releasedChainLeases, [abandoned.readiness.chainId]);

  await resetTestDb(db);
  releasedChainLeases.length = 0;
  const succeeded = await seedReadiness();
  const loseToWorker: MergeLeaseAcquirer = async () => {
    await db.task.update({
      where: { id: succeeded.readiness.id },
      data: {
        status: TaskStatus.DOING,
        readinessClaimToken: NEWER_CLAIM_TOKEN,
        readinessClaimExpiresAt: NEWER_CLAIM_EXPIRY,
      },
    });
    return { outcome: "acquired" };
  };
  assert.deepEqual(
    await readinessTick(db, reader(), new Date(), 5, releaseChainLease, leaseRunner(loseToWorker)),
    { claimed: 1, authorized: 0, requeued: 0, stopped: 0 },
  );
  assert.deepEqual(releasedChainLeases, [succeeded.readiness.chainId]);
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: succeeded.readiness.id } })).readinessClaimToken,
    NEWER_CLAIM_TOKEN,
  );
});

test("a foreign project's active successor cannot receive a claim-loss lease handoff", async () => {
  const owner = await seedReadiness();
  const foreign = await seedReadiness();
  await db.task.update({
    where: { id: foreign.integrator.id },
    data: { chainId: owner.readiness.chainId, chainIndex: 8, chainLayer: 8 },
  });
  await db.run.create({ data: {
    projectId: foreign.project.id,
    taskId: foreign.integrator.id,
    agentId: foreign.integrator.assigneeAgentId!,
    repoId: foreign.repo.id,
    runNumber: 1,
    dedupeKey: `task:${foreign.integrator.id}:run:1`,
    runner: "CLAUDE",
    model: INTEGRATOR_SENTINEL_MODEL,
    promptHash: "foreign-successor",
    status: RunStatus.QUEUED,
    branch: BRANCH,
    targetBranch: "main",
  } });
  const loseAfterAcquire: MergeLeaseAcquirer = async () => {
    await db.task.update({ where: { id: owner.readiness.id }, data: { status: TaskStatus.DONE } });
    return { outcome: "acquired" };
  };

  assert.deepEqual(
    await readinessTick(db, reader(), new Date(), 1, releaseChainLease, leaseRunner(loseAfterAcquire)),
    { claimed: 1, authorized: 0, requeued: 0, stopped: 0 },
  );
  assert.deepEqual(releasedLeaseTargets, [{ projectId: owner.project.id, chainId: owner.readiness.chainId }]);
  await assertConfirmedHold(owner.project.id);
  assert.equal((await leaseHoldMarkers(foreign.project.id)).length, 0);
});

test("eligible readiness is not hidden behind the first hundred ineligible candidates", async () => {
  const seeded = await seedReadiness();
  await db.task.createMany({ data: Array.from({ length: 100 }, (_, index) => ({
    projectId: seeded.readiness.projectId,
    repoId: seeded.readiness.repoId,
    templateId: seeded.readiness.templateId,
    templateStepId: seeded.readiness.templateStepId,
    name: `Blocked readiness ${index}`,
    description: "regression is not done",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: seeded.readiness.assigneeAgentId,
    status: TaskStatus.TODO,
    chainId: `blocked-tail-${index}`,
    chainIndex: seeded.readiness.chainIndex,
    chainLayer: seeded.readiness.chainLayer,
    targetBranch: "main",
    createdAt: new Date(0),
  })) });

  assert.deepEqual(
    await readinessTick(db, reader(), new Date(), 1, releaseChainLease, runWithMergeLease),
    { claimed: 1, authorized: 1, requeued: 0, stopped: 0 },
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
});
