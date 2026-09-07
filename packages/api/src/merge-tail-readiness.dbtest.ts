import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  type ChangedFile,
  DependencyProvisioning,
  INTEGRATOR_SENTINEL_MODEL,
  LEASE_LOSS_REFUND_CAP,
  MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES,
  MergeLeaseEventState,
  MergeRecoveryStatus,
  MERGE_READINESS_REQUEUE_KIND,
  MERGE_TAIL_KIND,
  Prisma,
  PrismaClient,
  readinessRequeueFromMetadata,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { readBoard } from "./board.js";
import { GitHubReadError, type PullRequestReader, type PullRequestSnapshot } from "./github-read.js";
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
import { executorsOnline } from "./merge-executor-daemon-fixture.js";
import {
  MERGE_EXECUTOR_OFFLINE_WAIT_MS,
  READINESS_BASE_DRIFT_REQUEUE_LIMIT,
  READINESS_CLAIM_LEASE_MS,
  READINESS_EXCEPTION_REQUEUE_LIMIT,
  READINESS_EXCEPTION_REQUEUE_STATE,
  readinessTick,
  requeueRegressionSettlement,
  type DaemonSnapshotReader,
} from "./merge-readiness-worker.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
import { createRunnerRegistry } from "./runners.js";
import { completeRun } from "./run-completion.js";
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

/** Build the exact history that used to make a later readiness requeue refuse.
 * Each replacement is opened by reconciliation after a genuinely expired Run
 * lease, so the final queued Run carries three platform refunds rather than a
 * fixture-only counter. */
const exhaustedLeaseLossRun = async (
  seeded: Awaited<ReturnType<typeof seedReadiness>>,
) => {
  let current = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
  });
  const start = new Date("2026-09-07T00:00:00.000Z");
  for (let loss = 0; loss < LEASE_LOSS_REFUND_CAP; loss += 1) {
    const at = new Date(start.getTime() + loss * 60 * 60_000);
    await db.run.update({ where: { id: current.id }, data: {
      status: RunStatus.RUNNING,
      heartbeatAt: null,
      startedAt: new Date(at.getTime() - 30 * 60_000),
      leaseExpiresAt: new Date(at.getTime() - 60_000),
    } });
    assert.ok(await reconcileDatabaseRuns(db, at, releaseChainLease) > 0, `lease loss ${loss + 1}`);
    current = await db.run.findFirstOrThrow({
      where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
    });
    assert.equal(current.leaseLossRefunds, loss + 1);
  }
  return current;
};

/** Exercise the separate capped external-failure retry path on the exhausted
 * task. Its replacement must carry the lease-loss history unchanged. */
const externalRetryAfterLeaseLosses = async (
  seeded: Awaited<ReturnType<typeof seedReadiness>>,
  queued: Awaited<ReturnType<typeof exhaustedLeaseLossRun>>,
) => {
  const runnerId = `readiness-external-${queued.id}`;
  const fencingToken = `readiness-external-fence-${queued.id}`;
  await db.run.update({ where: { id: queued.id }, data: {
    status: RunStatus.RUNNING,
    runnerId,
    fencingToken,
    leaseGeneration: 1,
    heartbeatAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 600_000),
  } });
  await db.session.create({ data: {
    runId: queued.id,
    projectId: seeded.project.id,
    agentId: seeded.regression.assigneeAgentId!,
    taskId: seeded.regression.id,
    runner: "CODEX",
    executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.DOING } });

  const completion = await completeRun(db, {
    runId: queued.id,
    claimantClass: "runner",
    body: {
      runnerId,
      fencingToken,
      exitCode: 1,
      pushStatus: "NOT_REQUESTED",
      cleanupStatus: "SUCCEEDED",
      workspaceRetained: false,
      outcome: {
        case: "provider-failure",
        reason: "provider transport failed",
        envelope: {
          version: 1,
          phase: "EXECUTE",
          runnerClass: "TRANSIENT_PROVIDER",
          exitCode: 1,
          signal: null,
          terminationReason: null,
          terminalEventSeen: false,
          terminalSuccess: false,
          agentExited: false,
          providerError: null,
          stderrSummary: "provider transport failed",
          stdoutSummary: null,
          timedOut: false,
          transient: true,
          timeoutMs: null,
        },
      },
    },
  });
  assert.ok(!("reason" in completion), JSON.stringify(completion));
  assert.equal(completion.retryCreated, true);
  const retry = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
  });
  assert.equal(retry.leaseLossRefunds, LEASE_LOSS_REFUND_CAP);
  assert.equal(retry.budgetGrants, queued.budgetGrants + 1);
  return retry;
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
  assert.deepEqual(await readinessTick(db, reader(), new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline), { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });
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
  assert.deepEqual(await readinessTick(db, guarded, new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline), { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });

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
  assert.equal((await readinessTick(db, guarded, new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline)).authorized, 1);
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
  assert.equal((await readinessTick(db, guarded, new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline)).authorized, 1);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.readiness.id } }), 1);
});

test("base drift invalidates a head-bound PASS and returns the chain to regression", async () => {
  const seeded = await seedReadiness();
  const driftedBase = "d".repeat(40);
  assert.deepEqual(await readinessTick(db, reader([], snapshot({ baseSha: driftedBase })), new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline), { claimed: 1, authorized: 0, requeued: 1, stopped: 0 });
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

test("an exhausted lease-loss history does not reject a valid PASS after lease contention", async () => {
  const seeded = await seedReadiness();
  const exhausted = await exhaustedLeaseLossRun(seeded);
  assert.equal(exhausted.leaseLossRefunds, LEASE_LOSS_REFUND_CAP);
  assert.equal(
    await db.run.count({ where: { taskId: seeded.regression.id, status: RunStatus.LOST } }),
    LEASE_LOSS_REFUND_CAP,
  );

  // The external provider retry is a separate refund class. It carries the
  // lease-loss history forward, so readiness still sees the exhausted value.
  const externalRetry = await externalRetryAfterLeaseLosses(seeded, exhausted);
  await db.run.update({ where: { id: externalRetry.id }, data: {
    status: RunStatus.SUCCEEDED,
    headSha: HEAD,
    leaseExpiresAt: null,
  } });
  await db.taskStepOutput.update({ where: { taskId: seeded.regression.id }, data: {
    runId: externalRetry.id,
    body: JSON.stringify({
      schemaVersion: 1,
      outcome: "pass",
      headSha: HEAD,
      baseHeadSha: BASE,
      gateVerdict: "PASS",
    }),
    commitSha: HEAD,
  } });
  await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.DONE } });

  const holder = {
    holder: "runner@other-chain",
    task: "other-chain-readiness",
    reason: "other chain holds the merge Lease",
    acquiredAt: "2026-09-07T03:00:00.000Z",
    sha: "c".repeat(40),
  };
  const contended: MergeLeaseAcquirer = async () => ({ outcome: "contended", holder });
  const started = new Date("2026-09-07T04:00:00.000Z");
  assert.deepEqual(
    await readinessTick(db, reader(), started, 5, releaseChainLease, leaseRunner(contended), executorsOnline),
    { claimed: 1, authorized: 0, requeued: 0, stopped: 0 },
  );

  const driftedBase = "d".repeat(40);
  assert.deepEqual(
    await readinessTick(
      db,
      reader([], snapshot({ baseSha: driftedBase })),
      new Date(started.getTime() + READINESS_CLAIM_LEASE_MS * 2),
      5,
      releaseChainLease,
      runWithMergeLease,
      executorsOnline,
    ),
    { claimed: 1, authorized: 0, requeued: 1, stopped: 0 },
  );

  const requeued = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
  });
  assert.equal(requeued.leaseLossRefunds, LEASE_LOSS_REFUND_CAP);
  assert.equal(requeued.budgetGrants, externalRetry.budgetGrants + 1);
  assert.equal(
    await db.taskActivity.count({
      where: { taskId: seeded.regression.id, metadata: { path: ["refusal"], equals: "lease-loss-refunds-exhausted" } },
    }),
    0,
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.TODO);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.TODO);
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
    await readinessTick(db, movingReader, new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline),
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
    await readinessTick(db, movingReader, new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline),
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
    readinessTick(db, movingReader, new Date(), 5, releaseChainLease, failingFinalRelease, executorsOnline),
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
  assert.equal((await readinessTick(db, reader([], snapshot({ baseSha: driftedBase })), new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline)).requeued, 1);
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
  assert.deepEqual(await readinessTick(db, guarded, new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline), {
    claimed: 1, authorized: 1, requeued: 0, stopped: 0,
  });
  assert.equal(await db.task.count({ where: { name: "Autonomous merge tail: independent review" } }), 0);
});

test("consecutive pre-authorization requeues are counted on the readiness card", async () => {
  const seeded = await seedReadiness();
  const firstDrift = "d".repeat(40);
  const secondDrift = "e".repeat(40);
  // The public activity route preserves caller-supplied metadata, so an
  // operator or an agent can post a row carrying this kind, and a control-plane
  // row of this kind can lack an ordinal the counters could place. Seeded
  // before the first settlement, a counted one would both inflate the card and
  // push the first real ordinal past 1.
  await db.taskActivity.createMany({ data: [
    {
      taskId: seeded.readiness.id,
      actorType: "operator",
      body: "operator note shaped like a requeue",
      metadata: { kind: MERGE_READINESS_REQUEUE_KIND, ordinal: 1, budgetGrant: 9 },
    },
    {
      taskId: seeded.readiness.id,
      actorType: "agent",
      body: "agent note shaped like a requeue",
      metadata: { kind: MERGE_READINESS_REQUEUE_KIND, ordinal: 2, budgetGrant: 9 },
    },
    {
      taskId: seeded.readiness.id,
      actorType: "control-plane",
      body: "unnumbered row shaped like a requeue",
      metadata: { kind: MERGE_READINESS_REQUEUE_KIND, budgetGrant: 9 },
    },
  ] });
  assert.equal(
    (await readinessTick(db, reader([], snapshot({ baseSha: firstDrift })), new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline)).requeued,
    1,
  );
  // The requeued Regression run passes against the base that moved, which is
  // what puts readiness back in front of a base that has moved again.
  const rerun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
  });
  await db.run.update({ where: { id: rerun.id }, data: { status: "SUCCEEDED", headSha: HEAD } });
  await db.taskStepOutput.update({ where: { taskId: seeded.regression.id }, data: {
    runId: rerun.id,
    body: JSON.stringify({
      schemaVersion: 1, outcome: "pass", headSha: HEAD, baseHeadSha: firstDrift, gateVerdict: "PASS",
    }),
    commitSha: HEAD,
  } });
  await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.DONE } });
  assert.equal(
    (await readinessTick(db, reader([], snapshot({ baseSha: secondDrift })), new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline)).requeued,
    1,
  );

  const requeues = await db.taskActivity.findMany({
    where: {
      taskId: seeded.readiness.id,
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: MERGE_READINESS_REQUEUE_KIND },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  // The unnumbered seed is still on the Task; it is simply not a requeue.
  assert.equal(requeues.length, 3);
  assert.deepEqual(
    requeues.flatMap((row) => readinessRequeueFromMetadata(row.metadata) ?? []),
    [
      { ordinal: 1, staleBaseSha: BASE, currentBaseSha: firstDrift, budgetGrant: 1 },
      { ordinal: 2, staleBaseSha: firstDrift, currentBaseSha: secondDrift, budgetGrant: 1 },
    ],
  );
  // Each grant funded one extra Regression attempt, so the counted grants and
  // the runs the chain actually paid for agree.
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 3);

  const cards = await readBoard(db, { projectId: seeded.project.id, archived: "false" });
  const readinessCard = cards.find((card) => card.id === seeded.readiness.id);
  assert.ok(readinessCard);
  assert.equal(readinessCard.readinessRequeues, 2);
  assert.equal(readinessCard.readinessGrants, 2);
  // The counters belong to the readiness Step; no other card in the chain
  // claims its chain's requeues.
  const regressionCard = cards.find((card) => card.id === seeded.regression.id);
  assert.ok(regressionCard);
  assert.equal(regressionCard.readinessRequeues, 0);
  assert.equal(regressionCard.readinessGrants, 0);
});

test("non-drift requeues and past recovery rows do not spend the standalone drift ceiling", async () => {
  const seeded = await seedReadiness();
  for (const condition of ["stale-head", "ancestry-refused", "stale-head"] as const) {
    const prior = await db.run.findFirstOrThrow({
      where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
    });
    await db.run.update({ where: { id: prior.id }, data: { status: RunStatus.SUCCEEDED, leaseExpiresAt: null } });
    // Exercise the real settlement and Run birth in one transaction; this
    // isolated fixture supplies the already-owned readiness claim.
    await db.$transaction(async (tx) => {
      const claim = {
        settle: async (client: typeof tx, input: { apply: (client: typeof tx) => Promise<{ value: unknown }> }) => ({
          settled: true, claim: "released", value: (await input.apply(client)).value,
        }),
      } as unknown as import("./readiness-claim.js").ReadinessClaimHandle;
      await requeueRegressionSettlement({
        readinessTaskId: seeded.readiness.id, regressionTaskId: seeded.regression.id,
        staleBaseSha: BASE, currentBaseSha: BASE, condition, reason: condition,
        now: new Date(), recovery: null,
      }).body(tx, claim);
    });
  }
  await db.taskActivity.create({ data: {
    taskId: seeded.readiness.id, actorType: "control-plane", body: "prior recovery drift",
    metadata: { kind: MERGE_READINESS_REQUEUE_KIND, ordinal: 4, baseDrift: true, recoveryAggregateId: "past-recovery" },
  } });
  const prior = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
  });
  assert.equal(prior.leaseLossRefunds, LEASE_LOSS_REFUND_CAP);
  await db.run.update({ where: { id: prior.id }, data: { status: RunStatus.SUCCEEDED, headSha: HEAD, leaseExpiresAt: null } });
  await db.taskStepOutput.update({ where: { taskId: seeded.regression.id }, data: { runId: prior.id } });
  await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.DONE } });
  assert.deepEqual(await readinessTick(
    db, reader([], snapshot({ baseSha: "d".repeat(40) })), new Date(), 5,
    releaseChainLease, runWithMergeLease, executorsOnline,
  ), { claimed: 1, authorized: 0, requeued: 1, stopped: 0 });
  const next = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
  });
  assert.equal(next.runNumber, prior.runNumber + 1);
  assert.equal(next.leaseLossRefunds, LEASE_LOSS_REFUND_CAP);
});

test("a readiness requeue reaches its independent ceiling without spending lease-loss refunds", async () => {
  const seeded = await seedReadiness();
  const drifts = ["c", "d", "e", "f"].map((letter) => letter.repeat(40));

  for (const [index, currentBaseSha] of drifts.entries()) {
    const prior = await db.run.findFirstOrThrow({
      where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
    });
    await db.run.update({ where: { id: prior.id }, data: {
      status: RunStatus.SUCCEEDED,
      headSha: HEAD,
      leaseExpiresAt: null,
    } });
    if (index > 0) {
      await db.taskStepOutput.update({ where: { taskId: seeded.regression.id }, data: {
        runId: prior.id,
        body: JSON.stringify({
          schemaVersion: 1,
          outcome: "pass",
          headSha: HEAD,
          baseHeadSha: drifts[index - 1],
          gateVerdict: "PASS",
        }),
        commitSha: HEAD,
      } });
      await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.DONE } });
    }

    const tick = await readinessTick(
      db,
      reader([], snapshot({ baseSha: currentBaseSha })),
      new Date(`2026-09-07T${String(10 + index).padStart(2, "0")}:00:00.000Z`),
      5,
      releaseChainLease,
      runWithMergeLease,
      executorsOnline,
    );
    assert.equal(tick.requeued, index < READINESS_BASE_DRIFT_REQUEUE_LIMIT ? 1 : 0);
    assert.equal(tick.stopped, index < READINESS_BASE_DRIFT_REQUEUE_LIMIT ? 0 : 1);
    if (index < READINESS_BASE_DRIFT_REQUEUE_LIMIT) {
      const next = await db.run.findFirstOrThrow({
        where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
      });
      assert.equal(next.leaseLossRefunds, 0, `lease-loss count ${index + 1}`);
      continue;
    }

    const [readiness, regression] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } }),
      db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
    ]);
    const reason = `readiness-base-drift-requeue-limit: ${READINESS_BASE_DRIFT_REQUEUE_LIMIT} requeues reached ceiling ${READINESS_BASE_DRIFT_REQUEUE_LIMIT}`;
    assert.equal(readiness.status, TaskStatus.REVIEW);
    assert.equal(regression.status, TaskStatus.REVIEW);
    assert.equal(readiness.failureReason, reason);
    assert.equal(regression.failureReason, reason);
    assert.equal(
      await db.run.count({ where: { taskId: seeded.regression.id } }),
      READINESS_BASE_DRIFT_REQUEUE_LIMIT + 1,
    );
    const stop = await db.taskActivity.findFirstOrThrow({ where: {
      taskId: seeded.regression.id,
      metadata: { path: ["state"], equals: "stopped" },
    } });
    assert.match(stop.body, new RegExp(reason.replaceAll(" ", "\\s+"), "u"));
  }
});

test("a requeue that carries a recovery aggregate is counted the same way", async () => {
  const seeded = await seedReadiness();
  const driftedBase = "d".repeat(40);
  const sourceRun = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  const stop = await db.taskActivity.create({ data: {
    taskId: seeded.integrator.id,
    actorType: "control-plane",
    body: "merge stopped on base drift",
    metadata: { kind: MERGE_TAIL_KIND.readiness, state: "stopped" },
  } });
  const authorization = await db.taskActivity.create({ data: {
    taskId: seeded.readiness.id,
    actorType: "control-plane",
    body: "merge authorized",
    metadata: { kind: MERGE_TAIL_KIND.readiness, state: "authorized" },
  } });
  // A recovery already awaiting authorization: readiness settles this requeue
  // through enterRepair rather than through its own branch, and the counter has
  // to come out the same on either path.
  const aggregate = await db.mergeRecoveryAttempt.create({ data: {
    integratorTaskId: seeded.integrator.id,
    sourceStopId: stop.id,
    attempt: 1,
    status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
    boundSourceRunId: sourceRun.id,
    authorizationActivityId: authorization.id,
    recoveryRunId: sourceRun.id,
    readinessTaskId: seeded.readiness.id,
    regressionTaskId: seeded.regression.id,
    repository: "acme/widgets",
    prNumber: 41,
    targetBranch: "main",
    authorizedHeadSha: HEAD,
    authorizedBaseSha: BASE,
    observedBaseSha: BASE,
    currentBaseSha: BASE,
  } });

  assert.equal(
    (await readinessTick(db, reader([], snapshot({ baseSha: driftedBase })), new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline)).requeued,
    1,
  );

  assert.equal(
    (await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: aggregate.id } })).status,
    MergeRecoveryStatus.REPAIRING,
  );
  const requeues = await db.taskActivity.findMany({
    where: {
      taskId: seeded.readiness.id,
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: MERGE_READINESS_REQUEUE_KIND },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  assert.equal(requeues.length, 1);
  assert.deepEqual(readinessRequeueFromMetadata(requeues[0]!.metadata), {
    ordinal: 1, staleBaseSha: BASE, currentBaseSha: driftedBase, budgetGrant: 1,
  });
  // One grant, one extra Regression attempt, exactly as on the ordinary path.
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);

  const cards = await readBoard(db, { projectId: seeded.project.id, archived: "false" });
  const readinessCard = cards.find((card) => card.id === seeded.readiness.id);
  assert.ok(readinessCard);
  assert.equal(readinessCard.readinessRequeues, 1);
  assert.equal(readinessCard.readinessGrants, 1);
  const regressionCard = cards.find((card) => card.id === seeded.regression.id);
  assert.ok(regressionCard);
  assert.equal(regressionCard.readinessRequeues, 0);
  assert.equal(regressionCard.readinessGrants, 0);
});

test("a recovery requeue uses its aggregate ceiling and records a named stop", async () => {
  const seeded = await seedReadiness();
  const sourceRun = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  const stop = await db.taskActivity.create({ data: {
    taskId: seeded.integrator.id,
    actorType: "control-plane",
    body: "merge stopped on base drift",
    metadata: { kind: MERGE_TAIL_KIND.readiness, state: "stopped" },
  } });
  const authorization = await db.taskActivity.create({ data: {
    taskId: seeded.readiness.id,
    actorType: "control-plane",
    body: "merge authorized",
    metadata: { kind: MERGE_TAIL_KIND.readiness, state: "authorized" },
  } });
  const aggregate = await db.mergeRecoveryAttempt.create({ data: {
    integratorTaskId: seeded.integrator.id,
    sourceStopId: stop.id,
    attempt: 1,
    status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
    boundSourceRunId: sourceRun.id,
    authorizationActivityId: authorization.id,
    recoveryRunId: sourceRun.id,
    readinessTaskId: seeded.readiness.id,
    regressionTaskId: seeded.regression.id,
    repository: "acme/widgets",
    prNumber: 41,
    targetBranch: "main",
    authorizedHeadSha: HEAD,
    authorizedBaseSha: BASE,
    observedBaseSha: BASE,
    currentBaseSha: BASE,
  } });
  const driftedBases = ["d", "e", "f"].map((letter) => letter.repeat(40));

  for (const [index, currentBaseSha] of driftedBases.entries()) {
    const prior = await db.run.findFirstOrThrow({
      where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
    });
    if (index > 0) {
      await db.run.update({ where: { id: prior.id }, data: {
        status: RunStatus.SUCCEEDED,
        headSha: HEAD,
        leaseExpiresAt: null,
      } });
      await db.taskStepOutput.update({ where: { taskId: seeded.regression.id }, data: {
        runId: prior.id,
        body: JSON.stringify({
          schemaVersion: 1,
          outcome: "pass",
          headSha: HEAD,
          baseHeadSha: driftedBases[index - 1],
          gateVerdict: "PASS",
        }),
        commitSha: HEAD,
      } });
      await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.DONE } });
    }

    const tick = await readinessTick(
      db,
      reader([], snapshot({ baseSha: currentBaseSha })),
      new Date(`2026-09-07T${String(14 + index).padStart(2, "0")}:00:00.000Z`),
      5,
      releaseChainLease,
      runWithMergeLease,
      executorsOnline,
    );
    assert.equal(tick.requeued, index < MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES ? 1 : 0);
    assert.equal(tick.stopped, index < MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES ? 0 : 1);
    if (index < MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES) continue;

    const reason = `base-drift-recovery-requeue-limit: ${MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES} requeues reached ceiling ${MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES}`;
    const [updatedAggregate, readiness, regression, integrator] = await Promise.all([
      db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: aggregate.id } }),
      db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } }),
      db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
      db.task.findUniqueOrThrow({ where: { id: seeded.integrator.id } }),
    ]);
    assert.equal(updatedAggregate.status, MergeRecoveryStatus.BLOCKED_DOWNSTREAM);
    assert.equal(updatedAggregate.failureReason, reason);
    assert.equal(readiness.status, TaskStatus.REVIEW);
    assert.equal(readiness.failureReason, reason);
    assert.equal(regression.status, TaskStatus.REVIEW);
    assert.equal(regression.failureReason, reason);
    assert.equal(integrator.status, TaskStatus.REVIEW);
    assert.equal(
      await db.run.count({ where: { taskId: seeded.regression.id } }),
      MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES + 1,
    );

    const requeues = await db.taskActivity.findMany({
      where: {
        taskId: seeded.readiness.id,
        actorType: "control-plane",
        metadata: { path: ["kind"], equals: MERGE_READINESS_REQUEUE_KIND },
      },
    });
    const recoveryRequeues = requeues.filter((row) => (
      (row.metadata as Record<string, unknown>).recoveryAggregateId === aggregate.id
    ));
    assert.equal(recoveryRequeues.length, MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES);
    assert.equal(
      (await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" } })).leaseLossRefunds,
      0,
    );
  }
});

test("future readiness waits but the readiness role is claimed regardless of ordinal", async () => {
  const future = await seedReadiness();
  await db.task.update({ where: { id: future.regression.id }, data: { status: TaskStatus.TODO } });
  assert.deepEqual(await readinessTick(db, reader(), new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline), { claimed: 0, authorized: 0, requeued: 0, stopped: 0 });
  assert.equal(await db.inboxMessage.count(), 0);

  await db.task.update({ where: { id: future.regression.id }, data: { status: TaskStatus.DONE } });
  await db.taskTemplateStep.update({ where: { id: future.readiness.templateStepId! }, data: { stepIndex: 9 } });
  assert.deepEqual(await readinessTick(db, reader(), new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline), { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: future.readiness.id } })).status, TaskStatus.DONE);
});

test("an expired orphaned DOING readiness claim is reclaimed after restart", async () => {
  const seeded = await seedReadiness();
  await db.task.update({ where: { id: seeded.readiness.id }, data: {
    status: TaskStatus.DOING,
    readinessClaimToken: "dead-worker-token",
    readinessClaimExpiresAt: new Date("2000-01-01T00:00:00.000Z"),
  } });
  assert.deepEqual(await readinessTick(db, reader(), new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline), { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });
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
    await readinessTick(db, reader(), new Date(expiresAt.getTime() - 1), 5, releaseChainLease, runWithMergeLease, executorsOnline),
    { claimed: 0, authorized: 0, requeued: 0, stopped: 0 },
  );
  const waiting = await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } });
  assert.match(waiting.failureReason ?? "", /^merge-readiness-claim:/u);
  assert.equal(waiting.readinessClaimToken, null);
  assert.equal(waiting.readinessClaimExpiresAt, null);

  assert.deepEqual(
    await readinessTick(db, reader(), expiresAt, 5, releaseChainLease, runWithMergeLease, executorsOnline),
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
  assert.deepEqual(await readinessTick(db, incompleteReader, new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline), { claimed: 1, authorized: 0, requeued: 0, stopped: 1 });
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
  assert.deepEqual(await readinessTick(db, behindReader, new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline), { claimed: 1, authorized: 0, requeued: 1, stopped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: behind.regression.id } })).status, TaskStatus.TODO);
  assert.deepEqual(releasedChainLeases, [behind.readiness.chainId]);
});

test("an absent runner-created PR identity stops loudly before authorization", async () => {
  const seeded = await seedReadiness();
  await db.run.updateMany({ where: { taskId: seeded.regression.id }, data: {
    pullRequestNumber: null, pullRequestUrl: null,
  } });
  assert.deepEqual(await readinessTick(db, reader(), new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline), { claimed: 1, authorized: 0, requeued: 0, stopped: 1 });
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
    await readinessTick(db, reader(), started, 5, releaseChainLease, leaseRunner(contended), executorsOnline),
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
      executorsOnline,
    ),
    { claimed: 1, authorized: 1, requeued: 0, stopped: 0 },
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: seeded.integrator.id } }), 1);
  // Taking the lease closes the episode, so the next contention is measured
  // from its own beginning rather than from this one. The authorization is the
  // terminal transition and clears the claim, so the close has to be written
  // inside the Lease window; a close attempted afterwards would be refused and
  // leave this episode open forever.
  const resolved = await db.taskActivity.findFirst({
    where: {
      taskId: seeded.readiness.id,
      metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseContention },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  assert.equal((resolved!.metadata as Record<string, unknown>).state, "resolved");
  // It closed this episode rather than opening and closing an unrelated one.
  assert.equal(
    (resolved!.metadata as Record<string, unknown>).firstContendedAt,
    (contention[0]!.metadata as Record<string, unknown>).firstContendedAt,
  );
});

const contentionMarkers = async (taskId: string) => await db.taskActivity.findMany({
  where: { taskId, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseContention } },
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
});

const contentionState = async (taskId: string): Promise<Array<string | undefined>> => (
  (await contentionMarkers(taskId)).map((marker) => (
    (marker.metadata as Record<string, unknown>).state as string | undefined
  ))
);

test("a stale worker records no contention after a newer worker owns the claim", async () => {
  const seeded = await seedReadiness();
  let startRead!: () => void;
  let finishRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { startRead = resolve; });
  const readMayFinish = new Promise<void>((resolve) => { finishRead = resolve; });
  let reads = 0;
  const delayed: PullRequestReader = {
    readPullRequest: async () => {
      reads += 1;
      if (reads === 1) {
        startRead();
        await readMayFinish;
      }
      return snapshot({});
    },
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
  };
  const contended: MergeLeaseAcquirer = async () => ({
    outcome: "contended",
    holder: {
      holder: "runner@executor",
      task: "chain-elsewhere",
      reason: "chain merge tail chain-elsewhere",
      acquiredAt: "2026-09-06T10:00:00.000Z",
      sha: "b".repeat(40),
    },
  });
  const tick = readinessTick(db, delayed, new Date(), 5, releaseChainLease, leaseRunner(contended), executorsOnline);
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
  await tick;

  // The contention is real, but this worker is no longer the Step's owner, so
  // it says nothing a successor's own bookkeeping would then have to unpick.
  assert.deepEqual(await contentionMarkers(seeded.readiness.id), []);
  assert.equal(await db.mergeLeaseEvent.count({
    where: { chainId: seeded.readiness.chainId!, state: MergeLeaseEventState.CONTENDED },
  }), 0);
  assert.equal(await db.inboxMessage.count({ where: { dedupeKey: { startsWith: "merge-lease-contention:" } } }), 0);
});

test("an unreachable origin breaks the run of contended results", async () => {
  const seeded = await seedReadiness();
  const contended: MergeLeaseAcquirer = async () => ({ outcome: "contended" });
  const unreachable: MergeLeaseAcquirer = async () => ({ outcome: "unreachable", detail: "spawn bash ENOENT" });
  const started = new Date();
  const later = (ticks: number): Date => new Date(started.getTime() + READINESS_CLAIM_LEASE_MS * 2 * ticks);

  await readinessTick(db, reader(), started, 5, releaseChainLease, leaseRunner(contended), executorsOnline);
  assert.deepEqual(await contentionState(seeded.readiness.id), ["contended"]);

  await readinessTick(db, reader(), later(1), 5, releaseChainLease, leaseRunner(unreachable), executorsOnline);
  // The window counts continuous contention. A tick that could not reach origin
  // learned nothing about the holder, so it is not another refusal.
  assert.deepEqual(await contentionState(seeded.readiness.id), ["contended", "resolved"]);

  await readinessTick(db, reader(), later(2), 5, releaseChainLease, leaseRunner(contended), executorsOnline);
  const markers = await contentionMarkers(seeded.readiness.id);
  assert.deepEqual(markers.map((marker) => (marker.metadata as Record<string, unknown>).state), [
    "contended",
    "resolved",
    "contended",
  ]);
  // The new episode's 30 minutes start now, not at the first contention.
  assert.equal(
    (markers[2]!.metadata as Record<string, unknown>).firstContendedAt,
    later(2).toISOString(),
  );
});

test("a requeue before the lease ends the contention episode", async () => {
  const seeded = await seedReadiness();
  const contended: MergeLeaseAcquirer = async () => ({ outcome: "contended" });
  const started = new Date();

  await readinessTick(db, reader(), started, 5, releaseChainLease, leaseRunner(contended), executorsOnline);
  assert.deepEqual(await contentionState(seeded.readiness.id), ["contended"]);

  const driftedBase = "d".repeat(40);
  assert.equal(
    (await readinessTick(
      db,
      reader([], snapshot({ baseSha: driftedBase })),
      new Date(started.getTime() + READINESS_CLAIM_LEASE_MS * 2),
      5,
      releaseChainLease,
      runWithMergeLease,
      executorsOnline,
    )).requeued,
    1,
  );
  // This tick settled before it ever reached for the lease, so the run of
  // contended results is broken and the next one starts its own window.
  assert.deepEqual(await contentionState(seeded.readiness.id), ["contended", "resolved"]);
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
  const tick = readinessTick(db, delayed, new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline);
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
  const tick = readinessTick(db, delayed, new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline);
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
    await readinessTick(db, reader(), started, 5, releaseChainLease, leaseRunner(unreachable), executorsOnline),
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
      executorsOnline,
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
    await readinessTick(db, reader(), now, 5, releaseChainLease, unreachableReleaseRunner(attempts), executorsOnline),
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
    await readinessTick(db, movingReader, now, 5, releaseChainLease, unreachableReleaseRunner(attempts), executorsOnline),
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
    await readinessTick(db, movingReader, now, 5, releaseChainLease, unreachableReleaseRunner(attempts), executorsOnline),
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
    readinessTick(db, reader(), new Date(), 5, releaseChainLease, failedWriter, executorsOnline),
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
  await readinessTick(db, reader(), now, 5, releaseChainLease, unreachableReleaseRunner(attempts), executorsOnline);
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
    await readinessTick(db, reader(), new Date(), 5, releaseChainLease, unreachableRelease, executorsOnline),
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
    await readinessTick(db, reader(), new Date(), 5, releaseChainLease, leaseRunner(loseToOperator), executorsOnline),
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
    await readinessTick(db, reader(), new Date(), 5, releaseChainLease, leaseRunner(loseToWorker), executorsOnline),
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
    await readinessTick(db, reader(), new Date(), 1, releaseChainLease, leaseRunner(loseAfterAcquire), executorsOnline),
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
    await readinessTick(db, reader(), new Date(), 1, releaseChainLease, runWithMergeLease, executorsOnline),
    { claimed: 1, authorized: 1, requeued: 0, stopped: 0 },
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
});

const withExecutorAllowlist = async (
  runnerIds: string | undefined,
  body: () => Promise<void>,
): Promise<void> => {
  const previous = process.env.MERGE_EXECUTOR_RUNNER_IDS;
  if (runnerIds === undefined) delete process.env.MERGE_EXECUTOR_RUNNER_IDS;
  else process.env.MERGE_EXECUTOR_RUNNER_IDS = runnerIds;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.MERGE_EXECUTOR_RUNNER_IDS;
    else process.env.MERGE_EXECUTOR_RUNNER_IDS = previous;
  }
};

const EXECUTOR_RUNNER_ID = "merge-executor-1";
const SEEN_AT = new Date("2026-09-06T12:00:00.000Z");
/** The daemon registry `GET /runners` answers from, with one executor heartbeat in it. */
const executorRegistry = () => {
  const registry = createRunnerRegistry();
  registry.note(EXECUTOR_RUNNER_ID, {}, SEEN_AT);
  return registry;
};
// Outside `DaemonSnapshot.online`, which is three poll intervals or 30s.
const OFFLINE_NOW = new Date(SEEN_AT.getTime() + 31_000);
const ONLINE_NOW = new Date(SEEN_AT.getTime() + 5_000);
/** Liveness as the readiness worker reads it: a reader that carries its own clock. */
const executorsAt = (now: Date): DaemonSnapshotReader => {
  const snapshot = executorRegistry().snapshot;
  return () => snapshot(now);
};
const offlineMarkers = (readinessTaskId: string) => db.taskActivity.findMany({
  where: {
    taskId: readinessTaskId,
    metadata: { path: ["state"], equals: "requeued-executor-offline" },
  },
  orderBy: { createdAt: "asc" },
});

test("readiness requeues itself rather than authorizing a merge no online executor can claim", async () => {
  await withExecutorAllowlist(EXECUTOR_RUNNER_ID, async () => {
    const seeded = await seedReadiness();
    assert.deepEqual(
      await readinessTick(db, reader(), OFFLINE_NOW, 5, releaseChainLease, runWithMergeLease, executorsAt(OFFLINE_NOW)),
      { claimed: 1, authorized: 0, requeued: 1, stopped: 0 },
    );

    // Nothing was authorized: no readiness output, no merge Run, no Merge Lease.
    assert.equal(await db.taskStepOutput.count({ where: { taskId: seeded.readiness.id } }), 0);
    assert.equal(await db.run.count({ where: { taskId: seeded.integrator.id } }), 0);
    assert.deepEqual(leasedTargets, []);

    // The wait surrenders the chain lease rather than blocking the delivery
    // line for the whole outage; nothing can be authorized while it lasts.
    assert.deepEqual(releasedChainLeases, [seeded.readiness.chainId]);

    // The chain waits at readiness, and the regression evidence it waits on is untouched.
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.TODO);
    const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
    assert.equal(regression.status, TaskStatus.DONE);
    assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 1);
    assert.equal(await db.taskStepOutput.count({ where: { taskId: seeded.regression.id } }), 1);

    const [activity] = await offlineMarkers(seeded.readiness.id);
    const metadata = activity!.metadata as Record<string, unknown>;
    assert.equal(metadata.reason, "merge-executor-offline");
    assert.deepEqual(metadata.executorRunnerIds, [EXECUTOR_RUNNER_ID]);
    assert.match(activity!.body, /merge-executor-offline/u);
  });
});

test("an executor that goes down under the merge lease still has no authorization written", async () => {
  await withExecutorAllowlist(EXECUTOR_RUNNER_ID, async () => {
    const seeded = await seedReadiness();
    // The liveness read before the Lease sees the executor; the one that
    // decides, immediately before the leased authorization, sees it gone.
    let reads = 0;
    const snapshot = executorRegistry().snapshot;
    const goesOffline: DaemonSnapshotReader = () => {
      reads += 1;
      return snapshot(reads === 1 ? ONLINE_NOW : OFFLINE_NOW);
    };

    assert.deepEqual(
      await readinessTick(db, reader(), ONLINE_NOW, 5, releaseChainLease, runWithMergeLease, goesOffline),
      { claimed: 1, authorized: 0, requeued: 1, stopped: 0 },
    );
    assert.equal(reads, 2);
    // The Lease was taken and then released with nothing authorized.
    assert.deepEqual(leasedTargets, [{ projectId: seeded.project.id, chainId: seeded.readiness.chainId }]);
    assert.deepEqual(releasedChainLeases, [seeded.readiness.chainId]);
    assert.equal(await db.taskStepOutput.count({ where: { taskId: seeded.readiness.id } }), 0);
    assert.equal(await db.run.count({ where: { taskId: seeded.integrator.id } }), 0);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.TODO);
    assert.equal((await offlineMarkers(seeded.readiness.id)).length, 1);
  });
});

test("a merge executor that stays offline past the wait stops the tail by name", async () => {
  await withExecutorAllowlist(EXECUTOR_RUNNER_ID, async () => {
    const seeded = await seedReadiness();
    const offline = executorsAt(OFFLINE_NOW);
    assert.equal(
      (await readinessTick(db, reader(), OFFLINE_NOW, 5, releaseChainLease, runWithMergeLease, offline)).requeued,
      1,
    );
    // The wait is measured from the start of the outage the latest marker
    // belongs to, whatever the distance between two skipped authorizations:
    // MERGE_READINESS_POLL_INTERVAL_MS decides that distance, so the ceiling
    // must not depend on it. Here the second tick is the whole wait later --
    // one poll interval of fifteen minutes -- and it still stops.
    const expired = new Date(OFFLINE_NOW.getTime() + MERGE_EXECUTOR_OFFLINE_WAIT_MS);
    assert.deepEqual(
      await readinessTick(db, reader(), expired, 5, releaseChainLease, runWithMergeLease, offline),
      { claimed: 1, authorized: 0, requeued: 0, stopped: 1 },
    );
    for (const taskId of [seeded.readiness.id, seeded.regression.id]) {
      const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
      assert.equal(task.status, TaskStatus.REVIEW);
      assert.match(task.failureReason ?? "", /merge-executor-offline/u);
    }
    assert.equal(await db.run.count({ where: { taskId: seeded.integrator.id } }), 0);
  });
});

test("a later outage waits out its own ceiling rather than the task's whole history", async () => {
  await withExecutorAllowlist(EXECUTOR_RUNNER_ID, async () => {
    const seeded = await seedReadiness();
    const offline = executorsAt(OFFLINE_NOW);
    assert.equal(
      (await readinessTick(db, reader(), OFFLINE_NOW, 5, releaseChainLease, runWithMergeLease, offline)).requeued,
      1,
    );

    // The executor came back: a tick observes it online and settles the Step
    // some other way -- here the merge Lease is held elsewhere -- which is what
    // ends the outage. Elapsed time never does.
    const back = new Date(OFFLINE_NOW.getTime() + 4_000);
    const contended: MergeLeaseAcquirer = async () => ({ outcome: "contended" });
    await readinessTick(db, reader(), back, 5, releaseChainLease, leaseRunner(contended), executorsAt(SEEN_AT));
    assert.equal(
      ((await offlineMarkers(seeded.readiness.id))[0]!.metadata as Record<string, unknown>).episodeClosed,
      true,
    );

    // Hours later the executor goes down again. That is a new outage: readiness
    // waits it out rather than charging it for the wait the first one served.
    const laterOutage = new Date(OFFLINE_NOW.getTime() + 2 * 60 * 60_000);
    assert.deepEqual(
      await readinessTick(db, reader(), laterOutage, 5, releaseChainLease, runWithMergeLease, offline),
      { claimed: 1, authorized: 0, requeued: 1, stopped: 0 },
    );
    const markers = await offlineMarkers(seeded.readiness.id);
    assert.equal(markers.length, 2);
    assert.equal(
      (markers[1]!.metadata as Record<string, unknown>).episodeStartedAt,
      laterOutage.toISOString(),
      "the second outage anchors its wait to itself",
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.TODO);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.DONE);
  });
});

test("a deferred read inside an outage keeps the outage's wait", async () => {
  await withExecutorAllowlist(EXECUTOR_RUNNER_ID, async () => {
    const seeded = await seedReadiness();
    const offline = executorsAt(OFFLINE_NOW);
    assert.equal(
      (await readinessTick(db, reader(), OFFLINE_NOW, 5, releaseChainLease, runWithMergeLease, offline)).requeued,
      1,
    );

    // A GitHub timeout defers the tick, but the executor is still observed
    // offline: the episode stays open and keeps its original wait.
    const timingOut: PullRequestReader = {
      readPullRequest: async () => {
        throw new GitHubReadError("readiness evaluation timed out", "timeout");
      },
      compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
    };
    const midWait = new Date(OFFLINE_NOW.getTime() + 5 * 60_000);
    await readinessTick(db, timingOut, midWait, 5, releaseChainLease, runWithMergeLease, offline);
    const markers = await offlineMarkers(seeded.readiness.id);
    assert.equal(markers.length, 1);
    assert.notEqual((markers[0]!.metadata as Record<string, unknown>).episodeClosed, true);

    const expired = new Date(OFFLINE_NOW.getTime() + MERGE_EXECUTOR_OFFLINE_WAIT_MS);
    assert.deepEqual(
      await readinessTick(db, reader(), expired, 5, releaseChainLease, runWithMergeLease, offline),
      { claimed: 1, authorized: 0, requeued: 0, stopped: 1 },
    );
    assert.match(
      (await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).failureReason ?? "",
      /merge-executor-offline/u,
    );
  });
});

test("an operator retry after the executor-offline stop waits out the next outage", async () => {
  await withExecutorAllowlist(EXECUTOR_RUNNER_ID, async () => {
    const seeded = await seedReadiness();
    const offline = executorsAt(OFFLINE_NOW);
    assert.equal(
      (await readinessTick(db, reader(), OFFLINE_NOW, 5, releaseChainLease, runWithMergeLease, offline)).requeued,
      1,
    );
    const expired = new Date(OFFLINE_NOW.getTime() + MERGE_EXECUTOR_OFFLINE_WAIT_MS);
    assert.equal(
      (await readinessTick(db, reader(), expired, 5, releaseChainLease, runWithMergeLease, offline)).stopped,
      1,
    );

    // The stop answered that outage in full, so it closes it.
    assert.equal(
      ((await offlineMarkers(seeded.readiness.id))[0]!.metadata as Record<string, unknown>).episodeClosed,
      true,
    );

    // An operator retry therefore starts a fresh wait rather than stopping
    // again on its first tick.
    await db.task.update({
      where: { id: seeded.readiness.id },
      data: { status: TaskStatus.TODO, failureReason: null },
    });
    await db.task.update({
      where: { id: seeded.regression.id },
      data: { status: TaskStatus.DONE, failureReason: null },
    });
    assert.deepEqual(
      await readinessTick(
        db,
        reader(),
        new Date(expired.getTime() + 1_000),
        5,
        releaseChainLease,
        runWithMergeLease,
        offline,
      ),
      { claimed: 1, authorized: 0, requeued: 1, stopped: 0 },
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.TODO);
  });
});

test("an online merge executor authorizes the merge exactly as before the check existed", async () => {
  await withExecutorAllowlist(EXECUTOR_RUNNER_ID, async () => {
    const seeded = await seedReadiness();
    assert.deepEqual(
      await readinessTick(db, reader(), ONLINE_NOW, 5, releaseChainLease, runWithMergeLease, executorsAt(ONLINE_NOW)),
      { claimed: 1, authorized: 1, requeued: 0, stopped: 0 },
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
    assert.equal(await db.run.count({ where: { taskId: seeded.integrator.id } }), 1);
    assert.equal((await offlineMarkers(seeded.readiness.id)).length, 0);
  });
});

test("an unconfigured executor allowlist authorizes whatever the daemon registry says", async () => {
  await withExecutorAllowlist(undefined, async () => {
    const seeded = await seedReadiness();
    assert.deepEqual(
      await readinessTick(db, reader(), OFFLINE_NOW, 5, releaseChainLease, runWithMergeLease, executorsAt(OFFLINE_NOW)),
      { claimed: 1, authorized: 1, requeued: 0, stopped: 0 },
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
    assert.equal(await db.run.count({ where: { taskId: seeded.integrator.id } }), 1);
  });
});

// The 2026-09-06 incident shape: a merge lease stall plus a deploy restart
// killed readiness mid-evaluation. The exception carries no review-fail or
// gate-fail verdict, so the stop it used to write could not be re-entered
// through `merge-tail/repair` and the branch had to be delivered by hand.
const terminatingLease: WithMergeLease = async (target) => {
  if (target) leasedTargets.push(target);
  throw new Error("terminated");
};

const exceptionRequeueMarkers = (regressionTaskId: string) => db.taskActivity.findMany({
  where: {
    taskId: regressionTaskId,
    AND: [
      { metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.readiness } },
      { metadata: { path: ["state"], equals: READINESS_EXCEPTION_REQUEUE_STATE } },
    ],
  },
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
});

test("a readiness evaluation exception requeues the step instead of stopping the tail", async () => {
  const seeded = await seedReadiness();

  assert.deepEqual(
    await readinessTick(db, reader(), new Date(), 5, releaseChainLease, terminatingLease, executorsOnline),
    { claimed: 1, authorized: 0, requeued: 1, stopped: 0 },
  );

  const [readiness, regression] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
  ]);
  assert.equal(readiness.status, TaskStatus.TODO);
  assert.equal(readiness.failureReason, null);
  assert.equal(readiness.readinessClaimToken, null);
  assert.equal(regression.status, TaskStatus.DONE, "the regression evidence is untouched");
  assert.equal(regression.failureReason, null);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 1);
  assert.equal(await db.inboxMessage.count(), 0, "a requeue writes no stop notice");
  assert.deepEqual(releasedChainLeases, [seeded.readiness.chainId]);

  const markers = await exceptionRequeueMarkers(seeded.regression.id);
  assert.equal(markers.length, 1);
  const metadata = markers[0]!.metadata as Record<string, unknown>;
  assert.equal(metadata.reason, "readiness evaluation exception: terminated");
  assert.equal(metadata.requeue, 1);
  assert.equal(metadata.limit, READINESS_EXCEPTION_REQUEUE_LIMIT);
  assert.equal(metadata.recoveryAggregateId, null);
  assert.match(markers[0]!.body, /Merge readiness requeued after evaluation exception 1 of 3/u);

  // The requeued step is evaluated again on the next tick.
  assert.deepEqual(
    await readinessTick(db, reader(), new Date(), 5, releaseChainLease, runWithMergeLease, executorsOnline),
    { claimed: 1, authorized: 1, requeued: 0, stopped: 0 },
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
});

test("exception requeues are bounded and the stop past the limit counts them", async () => {
  const seeded = await seedReadiness();
  for (let requeue = 1; requeue <= READINESS_EXCEPTION_REQUEUE_LIMIT; requeue += 1) {
    assert.deepEqual(
      await readinessTick(db, reader(), new Date(), 5, releaseChainLease, terminatingLease, executorsOnline),
      { claimed: 1, authorized: 0, requeued: 1, stopped: 0 },
    );
  }
  assert.deepEqual(
    await readinessTick(db, reader(), new Date(), 5, releaseChainLease, terminatingLease, executorsOnline),
    { claimed: 1, authorized: 0, requeued: 0, stopped: 1 },
  );

  const reason = "readiness evaluation failed after 3 exception requeues: terminated";
  const [readiness, regression] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
  ]);
  assert.equal(readiness.status, TaskStatus.REVIEW);
  assert.equal(readiness.failureReason, reason);
  assert.equal(regression.status, TaskStatus.REVIEW);
  assert.equal(regression.failureReason, reason);
  assert.equal((await exceptionRequeueMarkers(seeded.regression.id)).length, READINESS_EXCEPTION_REQUEUE_LIMIT);
  const notice = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  assert.equal(notice.body, `Autonomous merge readiness stopped: ${reason}`);
});

test("a live skip tick closes outage A before a held Step resumes into outage B", async () => {
  await withExecutorAllowlist(EXECUTOR_RUNNER_ID, async () => {
    const seeded = await seedReadiness();
    const offline = executorsAt(OFFLINE_NOW);
    await readinessTick(db, reader(), OFFLINE_NOW, 5, releaseChainLease, runWithMergeLease, offline);
    await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.REVIEW } });
    await readinessTick(db, reader(), new Date(OFFLINE_NOW.getTime() + 60_000), 5,
      releaseChainLease, runWithMergeLease, executorsAt(ONLINE_NOW));
    assert.equal(((await offlineMarkers(seeded.readiness.id))[0]!.metadata as Record<string, unknown>).episodeClosed, true);
    await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.DONE } });
    const later = new Date(OFFLINE_NOW.getTime() + 2 * 86_400_000);
    const tick = await readinessTick(db, reader(), later, 5, releaseChainLease, runWithMergeLease, offline);
    assert.equal(tick.requeued, 1);
    assert.equal(tick.stopped, 0);
    assert.equal(((await offlineMarkers(seeded.readiness.id)).at(-1)!.metadata as Record<string, unknown>).episodeStartedAt,
      later.toISOString());
  });
});

for (const drifted of [false, true]) {
  test(`a ceiling stop re-arms on executor return without opening Regression (base drift=${drifted})`, async () => {
    await withExecutorAllowlist(EXECUTOR_RUNNER_ID, async () => {
      const seeded = await seedReadiness();
      const offline = executorsAt(OFFLINE_NOW);
      await readinessTick(db, reader(), OFFLINE_NOW, 5, releaseChainLease, runWithMergeLease, offline);
      const expired = new Date(OFFLINE_NOW.getTime() + MERGE_EXECUTOR_OFFLINE_WAIT_MS);
      await readinessTick(db, reader(), expired, 5, releaseChainLease, runWithMergeLease, offline);
      const notices = await db.inboxMessage.findMany({ where: { taskId: seeded.regression.id, status: "OPEN" } });
      assert.ok(notices.length > 0);
      const before = await db.run.count({ where: { taskId: seeded.regression.id } });
      const live = executorsAt(ONLINE_NOW);
      const facts = reader();
      const current = drifted ? { ...facts, readPullRequest: async (...args: Parameters<PullRequestReader["readPullRequest"]>) => ({
        ...await facts.readPullRequest(...args), baseSha: "d".repeat(40),
      }) } : facts;
      const resumed = await readinessTick(db, current, new Date(expired.getTime() + 1_000), 5,
        releaseChainLease, runWithMergeLease, live);
      assert.equal(resumed.authorized, drifted ? 0 : 1);
      assert.equal(resumed.requeued, drifted ? 1 : 0);
      if (!drifted) assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), before);
      assert.equal(await db.inboxMessage.count({ where: { id: { in: notices.map((notice) => notice.id) }, status: "OPEN" } }), 0);
    });
  });
}

test("a tick whose readiness claim was replaced cannot close the offline episode", async () => {
  await withExecutorAllowlist(EXECUTOR_RUNNER_ID, async () => {
    const seeded = await seedReadiness();
    await readinessTick(db, reader(), OFFLINE_NOW, 5, releaseChainLease, runWithMergeLease, executorsAt(OFFLINE_NOW));
    const { claimReadinessStep } = await import("./readiness-claim.js");
    const { closeExecutorOfflineEpisode } = await import("./merge-readiness-worker.js");
    const claim = await claimReadinessStep(db, seeded.readiness.id, OFFLINE_NOW);
    assert.ok(claim);
    await db.task.update({ where: { id: seeded.readiness.id }, data: { readinessClaimToken: "replacement" } });
    await closeExecutorOfflineEpisode(db, seeded.readiness.id, claim, "executor observed online");
    assert.notEqual(((await offlineMarkers(seeded.readiness.id))[0]!.metadata as Record<string, unknown>).episodeClosed, true);
  });
});

test("executor return re-arms a ceiling stop without discarding its recovery aggregate", async () => {
  await withExecutorAllowlist(EXECUTOR_RUNNER_ID, async () => {
    const seeded = await seedReadiness();
    const run = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
    const stop = await db.taskActivity.create({ data: {
      taskId: seeded.integrator.id, actorType: "control-plane", body: "base drift stop",
    } });
    const authorization = await db.taskActivity.create({ data: {
      taskId: seeded.readiness.id, actorType: "control-plane", body: "prior authorization",
    } });
    const aggregate = await db.mergeRecoveryAttempt.create({ data: {
      integratorTaskId: seeded.integrator.id, sourceStopId: stop.id, attempt: 1,
      status: MergeRecoveryStatus.AWAITING_AUTHORIZATION, boundSourceRunId: run.id,
      authorizationActivityId: authorization.id, recoveryRunId: run.id,
      readinessTaskId: seeded.readiness.id, regressionTaskId: seeded.regression.id,
      repository: "acme/widgets", prNumber: 41, targetBranch: "main",
      authorizedHeadSha: HEAD, authorizedBaseSha: BASE, observedBaseSha: BASE, currentBaseSha: BASE,
    } });
    const offline = executorsAt(OFFLINE_NOW);
    await readinessTick(db, reader(), OFFLINE_NOW, 5, releaseChainLease, runWithMergeLease, offline);
    const expired = new Date(OFFLINE_NOW.getTime() + MERGE_EXECUTOR_OFFLINE_WAIT_MS);
    await readinessTick(db, reader(), expired, 5, releaseChainLease, runWithMergeLease, offline);
    assert.equal((await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: aggregate.id } })).status,
      MergeRecoveryStatus.BLOCKED_DOWNSTREAM);
    const result = await readinessTick(db, reader([], snapshot({ baseSha: "d".repeat(40) })),
      new Date(expired.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease, executorsAt(ONLINE_NOW));
    assert.equal(await db.inboxMessage.count({ where: {
      taskId: seeded.regression.id, status: "OPEN",
      dedupeKey: { startsWith: "merge-base-drift-recovery-tail-stop:" },
    } }), 0);
    assert.equal(result.authorized, 0);
    assert.equal(result.requeued, 1);
    assert.equal((await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: aggregate.id } })).status,
      MergeRecoveryStatus.REPAIRING);
  });
});

test("a second identical outage ceiling reopens its previously closed stop notice", async () => {
  await withExecutorAllowlist(EXECUTOR_RUNNER_ID, async () => {
    const seeded = await seedReadiness();
    const offline = executorsAt(OFFLINE_NOW);
    await readinessTick(db, reader(), OFFLINE_NOW, 5, releaseChainLease, runWithMergeLease, offline);
    const expired = new Date(OFFLINE_NOW.getTime() + MERGE_EXECUTOR_OFFLINE_WAIT_MS);
    await readinessTick(db, reader(), expired, 5, releaseChainLease, runWithMergeLease, offline);
    const notice = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id, status: "OPEN" } });
    const second = new Date(expired.getTime() + 1_000);
    let observations = 0;
    // The executor returns for re-arm, then outage B starts before authorization.
    await readinessTick(db, reader(), second, 5, releaseChainLease, runWithMergeLease,
      () => ++observations === 1 ? executorsAt(ONLINE_NOW)() : offline());
    assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: notice.id } })).status, "CLOSED");
    await readinessTick(db, reader(), new Date(second.getTime() + MERGE_EXECUTOR_OFFLINE_WAIT_MS),
      5, releaseChainLease, runWithMergeLease, offline);
    const reopened = await db.inboxMessage.findUniqueOrThrow({ where: { id: notice.id } });
    assert.equal(reopened.status, "OPEN");
    assert.equal(reopened.answeredAt, null);
    for (const id of [seeded.regression.id, seeded.readiness.id]) {
      assert.equal((await db.task.findUniqueOrThrow({ where: { id } })).status, TaskStatus.REVIEW);
    }
    assert.equal(await db.inboxMessage.count({ where: { dedupeKey: notice.dedupeKey } }), 1);
  });
});

test("pending Regression with no allowlist or episode never takes a readiness claim", async () => {
  const seeded = await seedReadiness();
  await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.TODO } });
  const before = await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } });
  for (const allowlist of ["", EXECUTOR_RUNNER_ID]) {
    await withExecutorAllowlist(allowlist, async () => {
      const result = await readinessTick(db, reader(), ONLINE_NOW, 5, releaseChainLease, runWithMergeLease, executorsAt(ONLINE_NOW));
      assert.equal(result.authorized, 0);
      const after = await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } });
      assert.deepEqual(after.updatedAt, before.updatedAt);
      assert.equal(after.readinessClaimToken, null);
    });
  }
});
