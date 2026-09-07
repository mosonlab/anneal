import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  DependencyProvisioning,
  INTEGRATOR_SENTINEL_MODEL,
  MERGE_TRAIN_OUTPUT_KIND,
  MergeLeaseEventState,
  openRun,
  mergeTrainClaimMetadata,
  readLatestMarker,
  PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";

import type { PullRequestReader, PullRequestSnapshot } from "./github-read.js";
import {
  type ReleaseMergeLease,
  type WithMergeLease,
  withMergeLease,
} from "./merge-lease.js";
import type { MergeLeaseAcquirer } from "./merge-lease.js";
import type { MergeLeaseTarget } from "./merge-lease-hold.js";
import { readinessTick } from "./merge-readiness-worker.js";
import { claimRun } from "./run-claim.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

/**
 * Database coverage for the opt-in readiness train. The fixture keeps one
 * repository and one template while giving every candidate its own UUID chain;
 * this is the smallest shape that can prove grouping, FIFO evidence order,
 * candidate ownership, and prefix settlement without touching the real gate
 * worker or GitHub.
 */

const TRAIN_MARKER_KIND = "mergeTail.train";
const HEADS = ["a", "c", "d", "e"].map((letter) => letter.repeat(40));
const BASE = "b".repeat(40);
const PREFIXES = ["1", "2", "3", "4"].map((letter) => letter.repeat(40));
const BRANCHES = ["agentos/train-candidate-1", "agentos/train-candidate-2", "agentos/train-candidate-3", "agentos/train-candidate-4"];
const TEST_NOW = new Date("2026-09-07T12:00:00.000Z");

type Candidate = {
  chainId: string;
  headSha: string;
  branch: string;
  regression: Awaited<ReturnType<PrismaClient["task"]["findUniqueOrThrow"]>>;
  readiness: Awaited<ReturnType<PrismaClient["task"]["findUniqueOrThrow"]>>;
  integrator: Awaited<ReturnType<PrismaClient["task"]["findUniqueOrThrow"]>>;
  prNumber: number;
};

type Seed = {
  project: { id: string };
  repo: { id: string };
  candidates: Candidate[];
};

type TrainVerdict = "pass" | "fail" | "no-verdict";

let db: PrismaClient;
const previousTrainWidth = process.env.MERGE_TRAIN_WIDTH;
const leasedTargets: MergeLeaseTarget[] = [];
const releasedTargets: MergeLeaseTarget[] = [];
const releasedChainIds: string[] = [];
let observeLeaseAcquisition: ((chainId: string) => Promise<void>) | undefined;
/** Replaces the acquisition outcome so a tick can meet a real refusal. */
let leaseAcquisition: (() => Promise<Awaited<ReturnType<MergeLeaseAcquirer>>>) | undefined;

const releaseChainLease: ReleaseMergeLease = async (target) => {
  if (!target) return;
  releasedTargets.push(target);
  releasedChainIds.push(target.chainId);
};

const acquireChainLease: MergeLeaseAcquirer = async (chainId) => {
  await observeLeaseAcquisition?.(chainId);
  if (leaseAcquisition) return leaseAcquisition();
  return { outcome: "acquired" };
};

const runWithMergeLease: WithMergeLease = (target, fn, database) => {
  if (target) leasedTargets.push(target);
  return withMergeLease(target, fn, database, {
    acquire: acquireChainLease,
    release: async (chainId) => {
      releasedChainIds.push(chainId);
      return {
        outcome: "released",
        ref: "refs/merge-lease/test",
        sha: "f".repeat(40),
        acquiredAt: TEST_NOW.toISOString(),
      };
    },
  });
};

before(() => { db = setupTestDb(); });
beforeEach(async () => {
  leasedTargets.length = 0;
  releasedTargets.length = 0;
  releasedChainIds.length = 0;
  observeLeaseAcquisition = undefined;
  leaseAcquisition = undefined;
  process.env.MERGE_TRAIN_WIDTH = "0";
  await resetTestDb(db);
});
after(async () => {
  await db.$disconnect();
  if (previousTrainWidth === undefined) delete process.env.MERGE_TRAIN_WIDTH;
  else process.env.MERGE_TRAIN_WIDTH = previousTrainWidth;
});

const snapshot = (candidate: Pick<Candidate, "headSha" | "prNumber">, baseSha = BASE): PullRequestSnapshot => ({
  repository: "acme/widgets",
  number: candidate.prNumber,
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRefName: "main",
  headRefOid: candidate.headSha,
  baseSha,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  repositoryMergeQueue: null,
  mergedBy: null,
  mergeCommit: null,
  requiredCheckNames: [],
  checkContexts: [],
  headCommitOid: candidate.headSha,
  readAt: TEST_NOW.toISOString(),
});

const readerFor = (
  seed: Seed,
  options: {
    baseSha?: string;
    comparisonStatus?: "ahead" | "diverged";
    headShaByPr?: Map<number, string>;
  } = {},
): PullRequestReader => ({
  readPullRequest: async (_repository, prNumber) => {
    const candidate = seed.candidates.find((entry) => entry.prNumber === prNumber);
    if (!candidate) throw new Error(`unknown PR ${String(prNumber)}`);
    return snapshot({
      ...candidate,
      headSha: options.headShaByPr?.get(prNumber) ?? candidate.headSha,
    }, options.baseSha ?? BASE);
  },
  compareCommits: async () => ({
    status: options.comparisonStatus ?? "ahead",
    behindBy: options.comparisonStatus === "diverged" ? 1 : 0,
    filesComplete: true,
    files: [],
  }),
});

const passBody = (headSha: string, baseHeadSha = BASE): string => JSON.stringify({
  schemaVersion: 2,
  outcome: "pass",
  headSha,
  baseHeadSha,
  gateVerdict: "PASS",
  gateProof: `MERGE GATE: PASS ${headSha}`,
});

const seedTrainCandidates = async (
  count: number,
  options: { evidenceBaseSha?: string } = {},
): Promise<Seed> => {
  assert.ok(count >= 1 && count <= HEADS.length);
  const project = await db.project.create({ data: {
    name: "Merge train readiness",
    slug: `merge-train-readiness-${Date.now()}-${randomUUID().slice(0, 8)}`,
  } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "local",
    allowedHosts: [],
  } });
  const regressionAgents = await Promise.all(Array.from({ length: count }, (_, index) => db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `regression-agent-${index + 1}`,
    title: `Regression ${index + 1}`,
    model: "gpt-5.6-sol:high",
    runnerPreference: "CODEX",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } })));
  const reviewAgent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "review-coordinator-astra-medium",
    title: "Readiness",
    model: "gpt-5.6-sol:high",
    runnerPreference: "CODEX",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const integratorAgent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "merge-integrator",
    title: "Merge integrator",
    model: INTEGRATOR_SENTINEL_MODEL,
    runnerPreference: "INHERIT",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "widgets",
    remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo",
    defaultBranch: "main",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  for (const agent of [...regressionAgents, reviewAgent, integratorAgent]) {
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
  const [fixStep, regressionStep, readinessStep, integratorStep] = await Promise.all([
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id,
      stepIndex: 4,
      layer: 4,
      name: "Fixed implementation",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: regressionAgents[0]!.id,
      prompt: "fix",
      approvalGate: false,
      outputKind: "fixed-implementation",
      opensPullRequest: false,
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id,
      stepIndex: 5,
      layer: 5,
      name: "Regression",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: regressionAgents[0]!.id,
      prompt: "verify",
      approvalGate: false,
      outputKind: "regression-verification-v2",
      opensPullRequest: false,
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id,
      stepIndex: 6,
      layer: 6,
      name: "Readiness",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: reviewAgent.id,
      prompt: "mechanical",
      approvalGate: false,
      outputKind: "merge-authorization",
      opensPullRequest: false,
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id,
      stepIndex: 7,
      layer: 7,
      name: "Merge",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: integratorAgent.id,
      prompt: "merge",
      approvalGate: false,
      outputKind: "merge-result",
      opensPullRequest: false,
    } }),
  ]);

  const candidates: Candidate[] = [];
  for (let index = 0; index < count; index += 1) {
    const chainId = randomUUID();
    const headSha = HEADS[index]!;
    const branch = BRANCHES[index]!;
    const prNumber = 41 + index;
    const regression = await db.task.create({ data: {
      projectId: project.id,
      repoId: repo.id,
      templateId: template.id,
      templateStepId: regressionStep.id,
      name: "Regression",
      description: "verify",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: regressionAgents[index]!.id,
      status: TaskStatus.DONE,
      chainId,
      chainIndex: 5,
      chainLayer: 5,
      targetBranch: "main",
    } });
    await db.task.create({ data: {
      projectId: project.id,
      repoId: repo.id,
      templateId: template.id,
      templateStepId: fixStep.id,
      name: "Fixed implementation",
      description: "fix",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: regressionAgents[0]!.id,
      status: TaskStatus.DONE,
      chainId,
      chainIndex: 4,
      chainLayer: 4,
      targetBranch: "main",
    } });
    const readiness = await db.task.create({ data: {
      projectId: project.id,
      repoId: repo.id,
      templateId: template.id,
      templateStepId: readinessStep.id,
      name: "Readiness",
      description: "authorize",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: reviewAgent.id,
      status: TaskStatus.TODO,
      chainId,
      chainIndex: 6,
      chainLayer: 6,
      targetBranch: "main",
    } });
    const integrator = await db.task.create({ data: {
      projectId: project.id,
      repoId: repo.id,
      templateId: template.id,
      templateStepId: integratorStep.id,
      name: "Merge",
      description: "merge",
      assigneeType: AssigneeType.AGENT,
      assigneeAgentId: integratorAgent.id,
      status: TaskStatus.TODO,
      chainId,
      chainIndex: 7,
      chainLayer: 7,
      targetBranch: "main",
      opensPullRequest: false,
    } });
    const run = await db.run.create({ data: {
      projectId: project.id,
      taskId: regression.id,
      agentId: regressionAgents[index]!.id,
      repoId: repo.id,
      runNumber: 1,
      dedupeKey: `task:${regression.id}:run:1`,
      runner: "CODEX",
      model: regressionAgents[index]!.model,
      promptHash: `train-${index}`,
      status: RunStatus.SUCCEEDED,
      branch,
      pushedBranch: branch,
      targetBranch: "main",
      baseSha: BASE,
      headSha,
      pullRequestNumber: prNumber,
      pullRequestUrl: `https://github.com/acme/widgets/pull/${prNumber}`,
    } });
    await db.taskStepOutput.create({ data: {
      taskId: regression.id,
      runId: run.id,
      kind: "regression-verification-v2",
      body: passBody(headSha, options.evidenceBaseSha ?? BASE),
      commitSha: headSha,
      // Deliberately make the evidence clock explicit: the worker's train
      // ordering is by persisted Regression evidence, rather than PR number.
      createdAt: new Date(TEST_NOW.getTime() + index * 1_000),
      updatedAt: new Date(TEST_NOW.getTime() + index * 1_000),
    } });
    await db.mergeGateAttestation.create({ data: {
      chainId,
      taskId: regression.id,
      runId: run.id,
      headSha,
      baseHeadSha: options.evidenceBaseSha ?? BASE,
      proof: `MERGE GATE: PASS ${headSha}`,
    } });
    candidates.push({ chainId, headSha, branch, regression, readiness, integrator, prNumber });
  }
  return { project, repo, candidates };
};

/** Build the durable half of a reservation as if the worker died before the
 * external Lease acquisition. Recovery must be able to resume this state even
 * when the train switch is subsequently disabled. */
const reserveAcquiringTrain = async (seed: Seed) => {
  const candidates = seed.candidates.slice(0, 2).map((candidate) => ({
    taskId: candidate.readiness.id,
    chainId: candidate.chainId,
    headSha: candidate.headSha,
    branch: candidate.branch,
  }));
  const first = seed.candidates[0]!;
  const task = await db.task.create({ data: {
    projectId: seed.project.id,
    repoId: seed.repo.id,
    name: "Merge train: 2 candidates",
    description: "This is a detached merge-train task. Run ${AGENTOS_TOOLS}/merge-train.sh when queued.",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: first.regression.assigneeAgentId,
    approvalGate: false,
    opensPullRequest: false,
    status: TaskStatus.REVIEW,
    targetBranch: "main",
    maxSessionsPerTask: 1,
  } });
  const metadata = {
    state: "acquiring",
    trainTaskId: task.id,
    regressionTaskId: first.regression.id,
    baseSha: BASE,
    width: 2,
    candidates,
  };
  await db.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "control-plane",
    body: "Merge train reservation is acquiring the repository Lease",
    metadata: { kind: TRAIN_MARKER_KIND, schemaVersion: 1, ...metadata },
  } });
  for (const [position, candidate] of candidates.entries()) {
    await db.taskActivity.create({ data: {
      taskId: candidate.taskId,
      actorType: "control-plane",
      body: `Merge train ${task.id} reservation at position ${position + 1}`,
      metadata: {
        kind: TRAIN_MARKER_KIND,
        schemaVersion: 1,
        state: "acquiring",
        trainTaskId: task.id,
        position: position + 1,
      },
    } });
  }
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 0);
  return { task, candidates };
};

const trainTaskFor = async (seed: Seed) => {
  const detached = await db.task.findMany({
    where: { projectId: seed.project.id, repoId: seed.repo.id, chainId: null },
    include: { templateStep: true },
  });
  const train = detached.find((task) => task.description.includes("merge-train.sh")
    || task.name.toLowerCase().includes("merge train")
    || task.templateStep?.outputKind === MERGE_TRAIN_OUTPUT_KIND);
  assert.ok(train, "readiness created a detached merge-train task");
  return train;
};

const trainMarkersFor = async (readinessTaskId: string) => db.taskActivity.findMany({
  where: {
    taskId: readinessTaskId,
    metadata: { path: ["kind"], equals: TRAIN_MARKER_KIND },
  },
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
});

const trainTaskMarkerFor = async (trainTaskId: string) => db.taskActivity.findFirstOrThrow({
  where: {
    taskId: trainTaskId,
    metadata: { path: ["kind"], equals: TRAIN_MARKER_KIND },
  },
  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
});

const finishTrainRun = async (
  seed: Seed,
  body: string | null,
  status: RunStatus = RunStatus.SUCCEEDED,
) => {
  const train = await trainTaskFor(seed);
  const run = await db.run.findFirstOrThrow({ where: { taskId: train.id }, orderBy: { runNumber: "desc" } });
  await db.run.update({
    where: { id: run.id },
    data: { status, endedAt: TEST_NOW, failureReason: status === RunStatus.LOST ? "merge train Run was lost" : null },
  });
  await db.task.update({ where: { id: train.id }, data: { status: status === RunStatus.LOST ? TaskStatus.REVIEW : TaskStatus.DONE } });
  if (body !== null) {
    await db.taskStepOutput.create({
      data: {
        taskId: train.id,
        runId: run.id,
        kind: MERGE_TRAIN_OUTPUT_KIND,
        body,
        commitSha: PREFIXES[0]!,
      },
    });
  }
  return { train, run };
};

const recordFor = (
  seed: Seed,
  verdicts: TrainVerdict[],
  contiguousPassCount: number,
  options: { blocked?: Candidate[]; skipped?: Candidate[] } = {},
): string => JSON.stringify({
  schemaVersion: 1,
  baseSha: BASE,
  width: seed.candidates.length,
  prefixes: verdicts.map((verdict, index) => ({
    index: index + 1,
    taskId: seed.candidates[index]!.readiness.id,
    chainId: seed.candidates[index]!.chainId,
    candidateHeadSha: seed.candidates[index]!.headSha,
    predecessorOid: index === 0 ? BASE : PREFIXES[index - 1]!,
    prefixOid: PREFIXES[index]!,
    ref: `refs/anneal/train/${PREFIXES[index]}`,
    verdict,
    gateExcerpt: verdict === "pass"
      ? `MERGE GATE: PASS ${PREFIXES[index]}`
      : verdict === "fail" ? "MERGE GATE: FAIL (cumulative gate failed)" : "No gate verdict was produced",
  })),
  blocked: (options.blocked ?? []).map((candidate) => ({
    taskId: candidate.readiness.id,
    chainId: candidate.chainId,
    candidateHeadSha: candidate.headSha,
    reason: "merge conflict",
  })),
  skipped: (options.skipped ?? []).map((candidate) => candidate.readiness.id),
  contiguousPassCount,
});

const blockedRecordFor = (seed: Seed): string => JSON.stringify({
  schemaVersion: 1,
  baseSha: BASE,
  width: 2,
  prefixes: [{
    index: 1,
    taskId: seed.candidates[0]!.readiness.id,
    chainId: seed.candidates[0]!.chainId,
    candidateHeadSha: seed.candidates[0]!.headSha,
    predecessorOid: BASE,
    prefixOid: PREFIXES[0],
    ref: `refs/anneal/train/${PREFIXES[0]}`,
    verdict: "pass",
    gateExcerpt: `MERGE GATE: PASS ${PREFIXES[0]}`,
  }],
  blocked: [{
    taskId: seed.candidates[1]!.readiness.id,
    chainId: seed.candidates[1]!.chainId,
    candidateHeadSha: seed.candidates[1]!.headSha,
    reason: "merge conflict",
  }],
  skipped: [],
  contiguousPassCount: 1,
});

test("two ready candidates form one detached train with ordered claim metadata and lease marker", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  const tick = await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);

  assert.equal(tick.claimed, 2);
  assert.equal(tick.authorized, 0);
  const train = await trainTaskFor(seed);
  assert.equal(train.chainId, null);
  assert.equal(train.assigneeType, AssigneeType.AGENT);
  assert.equal(train.assigneeAgentId, seed.candidates[0]!.regression.assigneeAgentId);
  assert.equal(train.maxSessionsPerTask, 1);
  assert.equal(train.status, TaskStatus.TODO);
  assert.match(train.description, /\$\{AGENTOS_TOOLS\}\/merge-train\.sh/u);

  // The durable train marker is the claim metadata consumed after a worker
  // restart. The description is an operator projection of the same list.
  const claimMarker = await trainTaskMarkerFor(train.id);
  const metadata = claimMarker.metadata as Record<string, unknown>;
  assert.equal(metadata.state, "queued");
  assert.equal(metadata.regressionTaskId, seed.candidates[0]!.regression.id);
  assert.equal(metadata.baseSha, BASE);
  assert.equal(metadata.width, 2);
  assert.deepEqual(mergeTrainClaimMetadata(await readLatestMarker(db, train.id, "train", "control-plane")), {
    schemaVersion: 1, baseSha: BASE, width: 2, candidates: metadata.candidates,
  });
  assert.deepEqual(metadata.candidates, seed.candidates.map((candidate) => ({
    taskId: candidate.readiness.id,
    chainId: candidate.chainId,
    headSha: candidate.headSha,
    branch: candidate.branch,
  })));
  for (const candidate of seed.candidates) assert.ok(train.description.includes(candidate.readiness.id));
  const trainRun = await db.run.findFirstOrThrow({ where: { taskId: train.id } });
  assert.equal(trainRun.status, RunStatus.QUEUED);
  assert.deepEqual(leasedTargets, [{ projectId: seed.project.id, chainId: seed.candidates[0]!.chainId }]);
  assert.deepEqual(releasedTargets, []);
  assert.deepEqual(releasedChainIds, []);

  for (const [position, candidate] of seed.candidates.entries()) {
    const markers = await trainMarkersFor(candidate.readiness.id);
    assert.equal(markers.length, 2);
    const acquiring = markers[0]!.metadata as Record<string, unknown>;
    assert.equal(acquiring.state, "acquiring");
    assert.equal(acquiring.trainTaskId, train.id);
    assert.equal(acquiring.position, position + 1);
    const queued = markers[1]!.metadata as Record<string, unknown>;
    assert.equal(queued.state, "queued");
    assert.equal(queued.trainTaskId, train.id);
    assert.equal(queued.position, position + 1);
  }
});

test("train reservation is visible before external Lease acquisition and has no Run yet", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  let observedChainId: string | undefined;
  let observedTrainId: string | undefined;
  observeLeaseAcquisition = async (chainId) => {
    observedChainId = chainId;
    const detached = await db.task.findMany({
      where: { projectId: seed.project.id, repoId: seed.repo.id, chainId: null },
      include: { activity: true, runs: true },
    });
    const reservation = detached.find((candidate) => candidate.activity.some((activity) => {
      const metadata = activity.metadata as Record<string, unknown> | null;
      return metadata?.kind === TRAIN_MARKER_KIND && metadata.state === "acquiring";
    }));
    assert.ok(reservation, "the detached reservation is committed before Lease acquisition");
    observedTrainId = reservation.id;
    assert.equal(reservation.status, TaskStatus.REVIEW);
    assert.equal(reservation.runs.length, 0);
    assert.equal(chainId, seed.candidates[0]!.chainId);
    for (const candidate of seed.candidates) {
      const markers = await trainMarkersFor(candidate.readiness.id);
      const marker = markers.at(-1)!.metadata as Record<string, unknown>;
      assert.equal(marker.state, "acquiring");
      assert.equal(marker.trainTaskId, reservation.id);
    }
  };

  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  assert.equal(observedChainId, seed.candidates[0]!.chainId);
  assert.equal(typeof observedTrainId, "string");
  const train = await trainTaskFor(seed);
  assert.equal(train.id, observedTrainId);
  assert.equal((await db.run.count({ where: { taskId: train.id } })), 1);
  assert.equal((await trainTaskMarkerFor(train.id).then((marker) => (marker.metadata as Record<string, unknown>).state)), "queued");
});

test("a two-prefix passing train authorizes positions one and two and repairs the failing prefix against its predecessor", async () => {
  process.env.MERGE_TRAIN_WIDTH = "3";
  const seed = await seedTrainCandidates(3);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  const body = recordFor(seed, ["pass", "pass", "fail"], 2);
  const { train } = await finishTrainRun(seed, body);

  const settled = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  assert.equal(settled.authorized, 2);
  assert.equal(settled.stopped, 0);
  assert.equal(settled.requeued, 0);

  for (const candidate of seed.candidates.slice(0, 2)) {
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: candidate.readiness.id } })).status, TaskStatus.DONE);
    const authorization = await db.taskActivity.findFirstOrThrow({
      where: {
        taskId: candidate.readiness.id,
        metadata: { path: ["kind"], equals: "mergeIntegrator.authorization" },
      },
    });
    const metadata = authorization.metadata as Record<string, unknown>;
    assert.deepEqual(metadata.train, {
      publishHead: PREFIXES[1],
      predecessorOid: candidate === seed.candidates[0] ? BASE : PREFIXES[0],
      ref: `refs/anneal/train/${PREFIXES[1]}`,
      position: candidate === seed.candidates[0] ? 1 : 2,
      trainTaskId: train.id,
    });
  }

  const failed = seed.candidates[2]!;
  const repairMarker = await db.taskActivity.findFirstOrThrow({
    where: {
      taskId: failed.regression.id,
      metadata: { path: ["kind"], equals: "mergeTail.repairAttempt" },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const repairMetadata = repairMarker.metadata as Record<string, unknown>;
  assert.equal(repairMetadata.headSha, failed.headSha);
  assert.equal(repairMetadata.baseHeadSha, PREFIXES[1]);
  assert.equal(repairMetadata.repairKind, "gate-fix");
  const repairTaskId = repairMetadata.repairTaskId;
  assert.equal(typeof repairTaskId, "string");
  const repairTask = await db.task.findUniqueOrThrow({ where: { id: String(repairTaskId) } });
  assert.equal(repairTask.status, TaskStatus.TODO);
  const trainMarker = await trainMarkersFor(failed.readiness.id);
  const settlement = trainMarker.at(-1)!.metadata as Record<string, unknown>;
  assert.equal(settlement.state, "settled");
  assert.equal(settlement.position, 3);
  assert.equal(settlement.settlement, "fail");
  assert.equal(settlement.outcome, "repairing");
  assert.equal(settlement.predecessorOid, PREFIXES[1]);
  assert.deepEqual(releasedTargets, []);
  assert.deepEqual(releasedChainIds, [seed.candidates[0]!.chainId]);
});

test("a blocked train candidate enters the refresh-conflict stop with its recorded reason", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  const { train } = await finishTrainRun(seed, blockedRecordFor(seed));

  const settled = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  assert.equal(settled.authorized, 1);
  assert.equal(settled.stopped, 1);
  const blocked = seed.candidates[1]!;
  const blockedReadiness = await db.task.findUniqueOrThrow({ where: { id: blocked.readiness.id } });
  assert.equal(blockedReadiness.status, TaskStatus.REVIEW);
  assert.match(blockedReadiness.failureReason ?? "", /merge conflict/u);
  const stopNotice = await db.inboxMessage.findFirstOrThrow({ where: {
    taskId: blocked.regression.id,
    body: { contains: "merge conflict" },
  } });
  assert.match(stopNotice.body, /Autonomous merge tail stopped/u);
  const marker = (await trainMarkersFor(blocked.readiness.id)).at(-1)!.metadata as Record<string, unknown>;
  assert.equal(marker.trainTaskId, train.id);
  assert.equal(marker.position, 2);
  assert.equal(marker.settlement, "blocked");
  assert.equal(marker.state, "settled");
  assert.equal(marker.outcome, "blocked");
  assert.equal(marker.reason, "merge conflict");
  assert.deepEqual(releasedTargets, []);
  assert.deepEqual(releasedChainIds, [seed.candidates[0]!.chainId]);
});

test("a no-verdict prefix returns to ready while a blocked candidate stops", async () => {
  process.env.MERGE_TRAIN_WIDTH = "3";
  const seed = await seedTrainCandidates(3);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  const noVerdict = seed.candidates[1]!;
  const blocked = seed.candidates[2]!;
  await finishTrainRun(seed, recordFor(seed, ["pass", "no-verdict"], 1, { blocked: [blocked] }));

  const settled = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  assert.equal(settled.authorized, 1);
  assert.equal(settled.stopped, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: noVerdict.readiness.id } })).status, TaskStatus.TODO);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: blocked.readiness.id } })).status, TaskStatus.REVIEW);
  assert.match((await db.task.findUniqueOrThrow({ where: { id: blocked.readiness.id } })).failureReason ?? "", /merge conflict/u);

  const noVerdictMarker = (await trainMarkersFor(noVerdict.readiness.id)).at(-1)!.metadata as Record<string, unknown>;
  assert.equal(noVerdictMarker.state, "settled");
  assert.equal(noVerdictMarker.settlement, "no-verdict");
  assert.equal(noVerdictMarker.outcome, "ready");
  const blockedMarker = (await trainMarkersFor(blocked.readiness.id)).at(-1)!.metadata as Record<string, unknown>;
  assert.equal(blockedMarker.state, "settled");
  assert.equal(blockedMarker.settlement, "blocked");
  assert.equal(blockedMarker.outcome, "blocked");
  for (const candidate of seed.candidates) {
    assert.equal(await db.run.count({ where: { taskId: candidate.regression.id } }), 1);
  }
});

test("a skipped train candidate returns to ready with no Regression rerun", async () => {
  process.env.MERGE_TRAIN_WIDTH = "3";
  const seed = await seedTrainCandidates(3);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  const skipped = seed.candidates[2]!;
  await finishTrainRun(seed, recordFor(seed, ["pass"], 1, {
    blocked: [seed.candidates[1]!],
    skipped: [skipped],
  }));

  const settled = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  assert.equal(settled.authorized, 1);
  assert.equal(settled.stopped, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: skipped.readiness.id } })).status, TaskStatus.TODO);
  const marker = (await trainMarkersFor(skipped.readiness.id)).at(-1)!.metadata as Record<string, unknown>;
  assert.equal(marker.state, "settled");
  assert.equal(marker.settlement, "skipped");
  assert.equal(marker.outcome, "ready");
  assert.equal(await db.run.count({ where: { taskId: skipped.regression.id } }), 1);
});

test("an aborted train releases its lease, records every candidate, and returns them to ready without Regression re-runs", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  await finishTrainRun(seed, null, RunStatus.LOST);

  const settled = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  assert.equal(settled.authorized, 0);
  assert.equal(settled.requeued, 0);
  assert.equal(settled.stopped, 0);
  for (const [position, candidate] of seed.candidates.entries()) {
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: candidate.readiness.id } })).status, TaskStatus.TODO);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: candidate.regression.id } })).status, TaskStatus.DONE);
    assert.equal(await db.run.count({ where: { taskId: candidate.regression.id } }), 1);
    const marker = (await trainMarkersFor(candidate.readiness.id)).at(-1)!.metadata as Record<string, unknown>;
    assert.equal(marker.state, "aborted");
    assert.equal(marker.trainTaskId, (await trainTaskFor(seed)).id);
    assert.equal(marker.position, position + 1);
  }
  assert.deepEqual(releasedTargets, []);
  assert.deepEqual(releasedChainIds, [seed.candidates[0]!.chainId]);
});

test("a stale train base authorizes nothing and releases the held lease", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  await finishTrainRun(seed, recordFor(seed, ["pass", "pass"], 2));

  const staleBase = "9".repeat(40);
  const settled = await readinessTick(
    db,
    readerFor(seed, { baseSha: staleBase }),
    new Date(TEST_NOW.getTime() + 1_000),
    5,
    releaseChainLease,
    runWithMergeLease,
  );
  assert.equal(settled.authorized, 0);
  assert.equal(settled.requeued, 0);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: { in: seed.candidates.map((candidate) => candidate.readiness.id) },
    metadata: { path: ["kind"], equals: "mergeIntegrator.authorization" },
  } }), 0);
  assert.deepEqual(releasedTargets, []);
  assert.deepEqual(releasedChainIds, [seed.candidates[0]!.chainId]);
  for (const candidate of seed.candidates) {
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: candidate.readiness.id } })).status, TaskStatus.TODO);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: candidate.regression.id } })).status, TaskStatus.DONE);
    assert.equal(await db.run.count({ where: { taskId: candidate.regression.id } }), 1);
  }
});

test("an active train keeps the repository busy across a later readiness tick", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(3);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  const pending = await trainTaskFor(seed);

  const secondTick = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  assert.deepEqual(secondTick, { claimed: 0, authorized: 0, requeued: 0, stopped: 0 });
  assert.equal(await db.task.count({ where: {
    projectId: seed.project.id,
    repoId: seed.repo.id,
    chainId: null,
    description: { contains: "merge-train.sh" },
  } }), 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: pending.id } })).status, TaskStatus.TODO);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seed.candidates[2]!.readiness.id } })).status, TaskStatus.TODO);
  assert.deepEqual(leasedTargets, [
    { projectId: seed.project.id, chainId: seed.candidates[0]!.chainId },
    { projectId: seed.project.id, chainId: seed.candidates[0]!.chainId },
  ]);
  assert.deepEqual(releasedChainIds, []);
});

test("an acquiring reservation resumes into its sole queued Run with the switch disabled", async () => {
  const seed = await seedTrainCandidates(2);
  const { task, candidates } = await reserveAcquiringTrain(seed);
  process.env.MERGE_TRAIN_WIDTH = "0";

  const resumed = await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  assert.deepEqual(resumed, { claimed: 0, authorized: 0, requeued: 0, stopped: 0 });
  const current = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(current.status, TaskStatus.TODO);
  const runs = await db.run.findMany({ where: { taskId: task.id }, orderBy: { runNumber: "asc" } });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, RunStatus.QUEUED);
  const trainMarker = await trainTaskMarkerFor(task.id);
  assert.equal((trainMarker.metadata as Record<string, unknown>).state, "queued");
  for (const candidate of candidates) {
    const marker = (await trainMarkersFor(candidate.taskId)).at(-1)!.metadata as Record<string, unknown>;
    assert.equal(marker.state, "queued");
    assert.equal(marker.trainTaskId, task.id);
  }
  assert.deepEqual(leasedTargets, [{ projectId: seed.project.id, chainId: seed.candidates[0]!.chainId }]);
  assert.deepEqual(releasedChainIds, []);
});

test("a detached train with an existing Run cannot retry after lease loss", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  const train = await trainTaskFor(seed);
  const prior = await db.run.findFirstOrThrow({ where: { taskId: train.id }, orderBy: { runNumber: "desc" } });

  const result = await db.$transaction((tx) => openRun(tx, train.id, {
    kind: "retry-after-lease-loss",
    readyAt: TEST_NOW,
    sourceRunId: prior.id,
    sourceMaxRunsPerTask: prior.maxRunsPerTask,
    sourceBudgetGrants: prior.budgetGrants,
  }));
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("merge-train retry unexpectedly opened a second Run");
  assert.equal(result.refusal.code, "run-budget-exhausted");
  assert.match(result.refusal.message, /merge-train task cannot be retried/u);
  assert.equal(await db.run.count({ where: { taskId: train.id } }), 1);
});

test("one drifted candidate uses a train and avoids a per-chain Regression rerun", async () => {
  process.env.MERGE_TRAIN_WIDTH = "3";
  const staleEvidenceBase = "9".repeat(40);
  const seed = await seedTrainCandidates(1, { evidenceBaseSha: staleEvidenceBase });
  const formed = await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  assert.equal(formed.claimed, 1);
  assert.equal(formed.authorized, 0);
  const train = await trainTaskFor(seed);
  assert.match(train.description, /merge-train\.sh/u);
  await finishTrainRun(seed, recordFor(seed, ["pass"], 1));

  const settled = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  assert.equal(settled.authorized, 1);
  assert.equal(settled.requeued, 0);
  assert.equal(settled.stopped, 0);
  assert.equal(await db.run.count({ where: { taskId: seed.candidates[0]!.regression.id } }), 1);
  const authorization = await db.taskActivity.findFirstOrThrow({
    where: {
      taskId: seed.candidates[0]!.readiness.id,
      metadata: { path: ["kind"], equals: "mergeIntegrator.authorization" },
    },
  });
  assert.deepEqual((authorization.metadata as Record<string, unknown>).train, {
    publishHead: PREFIXES[0],
    predecessorOid: BASE,
    ref: `refs/anneal/train/${PREFIXES[0]}`,
    position: 1,
    trainTaskId: train.id,
  });
  assert.deepEqual(releasedChainIds, [seed.candidates[0]!.chainId]);
});

test("a changed PR head aborts the train before it can authorize a stale candidate", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  const changedHead = "e".repeat(40);
  await finishTrainRun(seed, recordFor(seed, ["pass", "pass"], 2));

  const settled = await readinessTick(db, readerFor(seed, {
    headShaByPr: new Map([[seed.candidates[0]!.prNumber, changedHead]]),
  }), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  assert.equal(settled.authorized, 0);
  assert.equal(settled.requeued, 0);
  assert.equal(settled.stopped, 0);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: { in: seed.candidates.map((candidate) => candidate.readiness.id) },
    metadata: { path: ["kind"], equals: "mergeIntegrator.authorization" },
  } }), 0);
  const train = await trainTaskFor(seed);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: train.id } })).status, TaskStatus.REVIEW);
  const marker = (await trainMarkersFor(seed.candidates[0]!.readiness.id)).at(-1)!.metadata as Record<string, unknown>;
  assert.equal(marker.state, "aborted");
  assert.match(String(marker.reason), /stale PASS head/u);
  assert.deepEqual(releasedChainIds, [seed.candidates[0]!.chainId]);
});

test("an unapproved gated candidate stops alone and truncates the authorized prefix", async () => {
  process.env.MERGE_TRAIN_WIDTH = "3";
  const seed = await seedTrainCandidates(3);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  await db.task.update({ where: { id: seed.candidates[1]!.readiness.id }, data: { approvalGate: true } });
  const { train } = await finishTrainRun(seed, recordFor(seed, ["pass", "pass", "pass"], 3));

  const settled = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  // The gate is a per-candidate refusal: position 1 keeps its proven
  // authorization against the shorter prefix, position 2 stops on its own
  // refusal, and position 3 goes back to the next train untouched.
  assert.equal(settled.authorized, 1);
  assert.equal(settled.stopped, 1);
  assert.equal(settled.requeued, 0);

  const authorized = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seed.candidates[0]!.readiness.id,
    metadata: { path: ["kind"], equals: "mergeIntegrator.authorization" },
  } });
  assert.deepEqual((authorized.metadata as Record<string, unknown>).train, {
    publishHead: PREFIXES[0],
    predecessorOid: BASE,
    ref: `refs/anneal/train/${PREFIXES[0]}`,
    position: 1,
    trainTaskId: train.id,
  });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seed.candidates[0]!.readiness.id } })).status, TaskStatus.DONE);

  const gated = await db.task.findUniqueOrThrow({ where: { id: seed.candidates[1]!.readiness.id } });
  assert.equal(gated.status, TaskStatus.REVIEW);
  assert.match(gated.failureReason ?? "", /operator authorization/iu);
  const gatedMarker = (await trainMarkersFor(gated.id)).at(-1)!.metadata as Record<string, unknown>;
  assert.equal(gatedMarker.state, "settled");
  assert.equal(gatedMarker.outcome, "stopped");
  assert.equal(gatedMarker.position, 2);

  const trailing = seed.candidates[2]!;
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: trailing.readiness.id } })).status, TaskStatus.TODO);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: trailing.readiness.id,
    metadata: { path: ["kind"], equals: "mergeIntegrator.authorization" },
  } }), 0);
  assert.equal(await db.run.count({ where: { taskId: trailing.regression.id } }), 1);
  assert.deepEqual(releasedChainIds, [seed.candidates[0]!.chainId]);
});

test("a settled train closes its own card while an aborted train keeps its review state", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  await finishTrainRun(seed, recordFor(seed, ["pass", "pass"], 2));
  await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);

  const settledTrain = await db.task.findUniqueOrThrow({ where: { id: (await trainTaskFor(seed)).id } });
  assert.equal(settledTrain.status, TaskStatus.DONE);
  assert.equal(settledTrain.failureReason, null);
  // A completed automation card must not linger as actionable review work, and
  // the settlement must leave no unresolved lease event behind it.
  assert.equal(await db.mergeLeaseEvent.count({ where: {
    projectId: seed.project.id,
    state: { in: [MergeLeaseEventState.RELEASE_DEFERRED, MergeLeaseEventState.HANDOFF_PENDING] },
    chainId: seed.candidates[0]!.chainId,
  } }), 0);
});

test("an aborted train keeps its diagnostic review state and reason", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  await finishTrainRun(seed, null, RunStatus.LOST);
  await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);

  const aborted = await db.task.findUniqueOrThrow({ where: { id: (await trainTaskFor(seed)).id } });
  assert.equal(aborted.status, TaskStatus.REVIEW);
  assert.match(aborted.failureReason ?? "", /merge train run/iu);
  assert.equal(await db.mergeLeaseEvent.count({ where: {
    projectId: seed.project.id,
    state: { in: [MergeLeaseEventState.RELEASE_DEFERRED, MergeLeaseEventState.HANDOFF_PENDING] },
    chainId: seed.candidates[0]!.chainId,
  } }), 0);
});

test("the queued merge-train Run is claimed with the ordered candidate list", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  const train = await trainTaskFor(seed);

  const claimed = await claimRun(db, {
    body: { runnerId: "merge-train-runner", leaseSeconds: 60, contractVersion: RUN_COMPLETION_CONTRACT_VERSION },
    claimantClass: "runner",
    now: new Date(TEST_NOW.getTime() + 500),
    specificationReader: null,
  });
  assert.ok(claimed && "run" in claimed, JSON.stringify(claimed));
  assert.equal(claimed.run.taskId, train.id);
  // The runtime input the merge-train session actually receives, read at the
  // Run claim rather than from the marker the control plane wrote.
  assert.deepEqual(claimed.task.mergeTrain, {
    schemaVersion: 1,
    baseSha: BASE,
    width: 2,
    candidates: seed.candidates.map((candidate) => ({
      taskId: candidate.readiness.id,
      chainId: candidate.chainId,
      headSha: candidate.headSha,
      branch: candidate.branch,
    })),
  });
});

test("a settled train card cannot emit merge-train claim metadata on a later claim", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  const train = await trainTaskFor(seed);
  await finishTrainRun(seed, recordFor(seed, ["pass", "pass"], 2));
  await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);

  await db.task.update({ where: { id: train.id }, data: { status: TaskStatus.TODO } });
  const revived = await db.run.create({ data: {
    projectId: seed.project.id,
    taskId: train.id,
    agentId: seed.candidates[0]!.regression.assigneeAgentId!,
    repoId: seed.repo.id,
    runNumber: 99,
    dedupeKey: `task:${train.id}:run:99`,
    runner: "CODEX",
    model: "gpt-5.6-sol:high",
    promptHash: "revived-train",
    status: RunStatus.QUEUED,
    targetBranch: "main",
    readyAt: TEST_NOW,
  } });
  const claimed = await claimRun(db, {
    body: { runnerId: "merge-train-runner", leaseSeconds: 60, contractVersion: RUN_COMPLETION_CONTRACT_VERSION },
    claimantClass: "runner",
    now: new Date(TEST_NOW.getTime() + 2_000),
    specificationReader: null,
  });
  assert.ok(claimed && "run" in claimed, JSON.stringify(claimed));
  assert.equal(claimed.run.id, revived.id);
  assert.equal(claimed.task.mergeTrain ?? null, null);
});

test("a contended merge Lease defers the train with a durable, operator-visible record", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  await finishTrainRun(seed, recordFor(seed, ["pass", "pass"], 2));

  leaseAcquisition = async () => ({ outcome: "contended", holder: {
    holder: "another-chain", task: "task-9", reason: "chain merge tail", acquiredAt: TEST_NOW.toISOString(), sha: "e".repeat(40),
  } });
  const deferred = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  leaseAcquisition = undefined;

  assert.deepEqual(deferred, { claimed: 0, authorized: 0, requeued: 0, stopped: 0 });
  const train = await trainTaskFor(seed);
  const contention = await db.taskActivity.findFirstOrThrow({
    where: { taskId: train.id, metadata: { path: ["kind"], equals: "mergeTail.leaseContention" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  assert.equal((contention.metadata as Record<string, unknown>).state, "contended");
  assert.match(contention.body, /another-chain/u);
  for (const candidate of seed.candidates) {
    assert.equal(await db.taskActivity.count({ where: {
      taskId: candidate.readiness.id,
      metadata: { path: ["kind"], equals: "mergeTail.leaseContention" },
    } }), 1);
  }
  // The train itself is untouched and settles on a later tick.
  const resumed = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 2_000), 5, releaseChainLease, runWithMergeLease);
  assert.equal(resumed.authorized, 2);
});

test("an unreachable merge Lease names the transport failure instead of retrying silently", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  await finishTrainRun(seed, recordFor(seed, ["pass", "pass"], 2));

  leaseAcquisition = async () => ({ outcome: "unreachable", detail: "origin refused the lease ref" });
  const deferred = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  leaseAcquisition = undefined;

  assert.deepEqual(deferred, { claimed: 0, authorized: 0, requeued: 0, stopped: 0 });
  const train = await trainTaskFor(seed);
  const named = await db.taskActivity.findFirstOrThrow({
    where: { taskId: train.id, metadata: { path: ["kind"], equals: "mergeTail.leaseContention" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  assert.equal((named.metadata as Record<string, unknown>).state, "unreachable");
  assert.match(named.body, /origin refused the lease ref/u);
});

test("an unresolved lease handoff blocks new train formation, not the repository's readiness", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  // A handoff belonging to another chain in this repository is the ordinary
  // steady state after any authorization; it must not darken readiness.
  await db.mergeLeaseEvent.create({ data: {
    projectId: seed.project.id,
    chainId: randomUUID(),
    state: MergeLeaseEventState.HANDOFF_PENDING,
    owningTaskId: seed.candidates[1]!.regression.id,
    handedOffAt: TEST_NOW,
  } });

  const tick = await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  assert.equal(tick.claimed, 2);
  assert.equal(tick.authorized, 2, "both candidates settled on the single-candidate path");
  assert.equal(await db.task.count({ where: {
    projectId: seed.project.id, chainId: null, description: { contains: "merge-train.sh" },
  } }), 0);
});

test("the readiness tick honours its claim budget on the train path", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(3);
  // Non-ready candidates take the single-candidate path one at a time; the
  // caller's budget bounds how many one tick may claim.
  for (const candidate of seed.candidates) {
    await db.taskStepOutput.delete({ where: { taskId: candidate.regression.id } });
  }
  const tick = await readinessTick(db, readerFor(seed), TEST_NOW, 2, releaseChainLease, runWithMergeLease);
  assert.equal(tick.claimed, 2);
});

test("train order follows when the Regression evidence was persisted, not its last write", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  // Re-writing the first candidate's evidence row moves `updatedAt` past the
  // second candidate's without changing when the evidence was persisted.
  await db.$executeRaw`
    UPDATE "TaskStepOutput" SET "updatedAt" = ${new Date(TEST_NOW.getTime() + 60_000)}
    WHERE "taskId" = ${seed.candidates[0]!.regression.id}
  `;
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);

  const metadata = (await trainTaskMarkerFor((await trainTaskFor(seed)).id)).metadata as Record<string, unknown>;
  assert.deepEqual(metadata.candidates, seed.candidates.map((candidate) => ({
    taskId: candidate.readiness.id,
    chainId: candidate.chainId,
    headSha: candidate.headSha,
    branch: candidate.branch,
  })));
});

test("one fresh candidate remains on the existing single-candidate authorization path", async () => {
  process.env.MERGE_TRAIN_WIDTH = "3";
  const seed = await seedTrainCandidates(1);
  const tick = await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);

  assert.deepEqual(tick, { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });
  assert.equal(await db.task.count({ where: { projectId: seed.project.id, description: { contains: "merge-train.sh" } } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seed.candidates[0]!.readiness.id } })).status, TaskStatus.DONE);
  const authorization = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seed.candidates[0]!.readiness.id,
    metadata: { path: ["kind"], equals: "mergeIntegrator.authorization" },
  } });
  assert.equal((authorization.metadata as Record<string, unknown>).train, undefined);
  assert.deepEqual(leasedTargets, [{ projectId: seed.project.id, chainId: seed.candidates[0]!.chainId }]);
  assert.deepEqual(releasedTargets, []);
  assert.deepEqual(releasedChainIds, []);
});


test("agent activity cannot replace the control-plane train ownership marker", async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  const { train } = await finishTrainRun(seed, recordFor(seed, ["pass", "pass"], 2));
  await db.taskActivity.create({ data: {
    taskId: train.id, actorType: "agent", body: "Untrusted marker-shaped annotation",
    metadata: { kind: TRAIN_MARKER_KIND, schemaVersion: 1, state: "aborted", trainTaskId: train.id },
  } });
  const settled = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  assert.equal(settled.authorized, 2);
});

test("overlapping settlement ticks cannot reacquire or release the same train generation", { timeout: 20_000 }, async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(2);
  await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
  await finishTrainRun(seed, recordFor(seed, ["pass", "pass"], 2));
  let acquired!: () => void;
  const acquisition = new Promise<void>((resolve) => { acquired = resolve; });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  observeLeaseAcquisition = async () => { acquired(); await paused; };
  const first = readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_000), 5, releaseChainLease, runWithMergeLease);
  try {
    await acquisition;
    const second = await readinessTick(db, readerFor(seed), new Date(TEST_NOW.getTime() + 1_001), 5, releaseChainLease, runWithMergeLease);
    assert.equal(second.authorized, 0);
    assert.equal(leasedTargets.length, 2, "one formation and one settlement acquisition");
  } finally {
    observeLeaseAcquisition = undefined;
    resume();
  }
  assert.equal((await first).authorized, 2);
  assert.equal(releasedChainIds.length, 1);
});

test("a readiness claim is released when the repository mutex is already held", { timeout: 30_000 }, async () => {
  process.env.MERGE_TRAIN_WIDTH = "2";
  const seed = await seedTrainCandidates(1);
  const candidate = seed.candidates[0]!;
  // A candidate that is not `ready` goes straight to the single-candidate path,
  // whose early returns must not keep the claim for the whole claim lease.
  await db.taskStepOutput.delete({ where: { taskId: candidate.regression.id } });

  let releaseMutex!: () => void;
  const holding = new Promise<void>((resolve) => { releaseMutex = resolve; });
  let mutexTaken!: () => void;
  const taken = new Promise<void>((resolve) => { mutexTaken = resolve; });
  const holder = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${`anneal:merge-train:${seed.repo.id}`}, 0))`;
    mutexTaken();
    await holding;
  }, { timeout: 25_000 });
  try {
    await taken;
    const tick = await readinessTick(db, readerFor(seed), TEST_NOW, 5, releaseChainLease, runWithMergeLease);
    assert.equal(tick.claimed, 1);
    assert.equal(tick.authorized, 0);
    const readiness = await db.task.findUniqueOrThrow({ where: { id: candidate.readiness.id } });
    assert.equal(readiness.status, TaskStatus.TODO);
    assert.equal(readiness.readinessClaimToken, null);
    assert.equal(readiness.readinessClaimExpiresAt, null);
  } finally {
    releaseMutex();
    await holder;
  }
});
