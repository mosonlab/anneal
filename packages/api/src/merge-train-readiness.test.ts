import assert from "node:assert/strict";
import test from "node:test";
import {
  MERGE_TRAIN_OUTPUT_KIND,
  RunStatus,
  TaskStatus,
  type MergeTrainRecord,
  type Prisma,
} from "@anneal/db";
import type { PullRequestReader } from "./github-read.js";
import type { WithMergeLease } from "./merge-lease.js";
import { mergeTrainReadinessTick, trainRecordBindingFailure } from "./merge-train-readiness.js";

const base = "a".repeat(40);
const head = "b".repeat(40);
const oid = "c".repeat(40);
const candidate = { taskId: "ready-1", chainId: "chain-1", headSha: head, branch: "feat/one" };
const record: MergeTrainRecord = {
  schemaVersion: 1, baseSha: base, width: 2, contiguousPassCount: 1,
  prefixes: [{ index: 1, taskId: candidate.taskId, chainId: candidate.chainId,
    candidateHeadSha: head, predecessorOid: base, prefixOid: oid,
    ref: `refs/anneal/train/${oid}`, verdict: "pass", gateExcerpt: `MERGE GATE: PASS ${oid}` }],
  blocked: [], skipped: [],
};

test("train qualification binds the complete ordered candidate list and live base", () => {
  assert.equal(trainRecordBindingFailure(record, { baseSha: base, width: 2, candidates: [candidate] }, base), null);
  assert.match(trainRecordBindingFailure(record, { baseSha: base, width: 2, candidates: [candidate] }, head)!, /live base/);
  assert.match(trainRecordBindingFailure(record, { baseSha: base, width: 2, candidates: [{ ...candidate, headSha: oid }] }, base)!, /candidate/);
  assert.match(trainRecordBindingFailure(record, { baseSha: base, width: 2, candidates: [candidate, { ...candidate, taskId: "ready-2" }] }, base)!, /candidate/);
});

test("train qualification refuses reordered, duplicate, and foreign record entries", () => {
  const second = { ...candidate, taskId: "ready-2", chainId: "chain-2" };
  const intent = { baseSha: base, width: 2, candidates: [candidate, second] };
  assert.match(trainRecordBindingFailure({ ...record, blocked: [{ taskId: "foreign", chainId: second.chainId, candidateHeadSha: head, reason: "conflict" }] }, intent, base)!, /candidate/);
  assert.match(trainRecordBindingFailure({ ...record, blocked: [{ taskId: candidate.taskId, chainId: candidate.chainId, candidateHeadSha: head, reason: "conflict" }] }, intent, base)!, /candidate/);
  assert.equal(trainRecordBindingFailure({ ...record, blocked: [{ taskId: second.taskId, chainId: second.chainId, candidateHeadSha: head, reason: "conflict" }] }, intent, base), null);
});

test("a queued train waits for an offline executor and proceeds when it returns", async () => {
  const now = new Date("2026-09-07T12:00:00.000Z");
  const projectId = "project-1";
  const repoId = "repo-1";
  const candidates = [
    { taskId: "readiness-1", chainId: "11111111-1111-4111-8111-111111111111", headSha: "d".repeat(40), branch: "feat/one" },
    { taskId: "readiness-2", chainId: "22222222-2222-4222-8222-222222222222", headSha: "e".repeat(40), branch: "feat/two" },
  ];
  const regressionByReadiness = new Map(candidates.map((candidate, index) => [candidate.taskId, {
    id: `regression-${index + 1}`,
    projectId,
    repoId,
    chainId: candidate.chainId,
    status: TaskStatus.DONE,
    runs: [{ id: `regression-run-${index + 1}`, branch: candidate.branch }],
    stepOutput: {
      id: `regression-output-${index + 1}`,
      kind: "regression-verification-v2",
      body: JSON.stringify({
        schemaVersion: 2,
        outcome: "pass",
        headSha: candidate.headSha,
        baseHeadSha: base,
        gateVerdict: "PASS",
        gateProof: `MERGE GATE: PASS ${candidate.headSha}`,
      }),
      commitSha: candidate.headSha,
      updatedAt: now,
    },
  }]));
  const readinessById = new Map(candidates.map((candidate) => [candidate.taskId, {
    id: candidate.taskId,
    projectId,
    repoId,
    chainId: candidate.chainId,
    status: TaskStatus.DOING,
    approvalGate: false,
    templateStep: {
      stepIndex: 6,
      outputKind: "merge-authorization",
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  }]));
  const outputFor = (trainTaskId: string): { id: string; kind: string; runId: string; body: string; commitSha: string; updatedAt: Date } => {
    const runId = `${trainTaskId}-run`;
    const body = JSON.stringify({
      schemaVersion: 1,
      baseSha: base,
      width: 2,
      contiguousPassCount: 2,
      prefixes: candidates.map((candidate, index) => ({
        index: index + 1,
        taskId: candidate.taskId,
        chainId: candidate.chainId,
        candidateHeadSha: candidate.headSha,
        predecessorOid: index === 0 ? base : `${index}`.repeat(40),
        prefixOid: `${index + 1}`.repeat(40),
        ref: `refs/anneal/train/${`${index + 1}`.repeat(40)}`,
        verdict: "pass",
        gateExcerpt: `MERGE GATE: PASS ${`${index + 1}`.repeat(40)}`,
      })),
      blocked: [],
      skipped: [],
    } satisfies MergeTrainRecord);
    return { id: `${trainTaskId}-output`, kind: MERGE_TRAIN_OUTPUT_KIND, runId, body,
      commitSha: "f".repeat(40), updatedAt: now };
  };
  const taskFor = (taskId: string): Record<string, unknown> | null => {
    if (taskId !== "train-offline" && taskId !== "train-online") return null;
    const output = outputFor(taskId);
    return {
      id: taskId,
      status: TaskStatus.TODO,
      archivedAt: null,
      projectId,
      repoId,
      description: "merge train",
      runs: [{ id: output.runId, status: RunStatus.SUCCEEDED }],
      stepOutput: output,
    };
  };

  type Activity = { id: string; taskId: string; actorType: string; body: string; metadata: Record<string, unknown>; createdAt: Date };
  const activities: Activity[] = [];
  const markerFor = (taskId: string, kind: string): Activity | null => [...activities].reverse()
    .find((activity) => activity.taskId === taskId && activity.metadata.kind === kind && activity.actorType === "control-plane") ?? null;
  const createActivity = async ({ data }: { data: Record<string, unknown> }): Promise<Activity> => {
    const activity: Activity = {
      id: `activity-${activities.length + 1}`,
      taskId: String(data.taskId),
      actorType: String(data.actorType),
      body: String(data.body ?? ""),
      metadata: (data.metadata ?? {}) as Record<string, unknown>,
      createdAt: now,
    };
    activities.push(activity);
    return activity;
  };
  const tx = {
    $queryRaw: async () => [{ held: true, id: "locked" }],
    task: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const readiness = readinessById.get(where.id);
        if (readiness) return readiness;
        const regression = [...regressionByReadiness.values()].find((candidate) => candidate.id === where.id);
        if (regression) return regression;
        return taskFor(where.id);
      },
      findFirst: async () => [...regressionByReadiness.values()][0],
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = readinessById.get(where.id) ?? taskFor(where.id);
        if (!row) throw new Error(`missing test task ${where.id}`);
        return row;
      },
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
    },
    taskActivity: {
      findFirst: async ({ where }: { where: { taskId: string; metadata?: { path?: string[]; equals?: string } } }) => {
        const expectedKind = where.metadata?.path?.[0] === "kind" ? where.metadata.equals : undefined;
        return expectedKind ? markerFor(where.taskId, expectedKind) : null;
      },
      create: createActivity,
      update: async ({ where, data }: { where: { id: string }; data: { metadata: Record<string, unknown> } }) => {
        const activity = activities.find((candidate) => candidate.id === where.id);
        if (activity) activity.metadata = data.metadata;
        return activity;
      },
    },
    mergeRecoveryAttempt: { findFirst: async () => null },
    mergeLeaseEvent: {
      findMany: async () => [],
      createMany: async () => ({ count: 1 }),
      findFirst: async () => ({
        id: "lease-event-1",
        projectId,
        chainId: candidates[0]!.chainId,
        state: "RELEASE_DEFERRED",
        owningTaskId: regressionByReadiness.get(candidates[0]!.taskId)!.id,
        deferredAt: now,
        failureDetail: "test release",
      }),
    },
  } as unknown as Prisma.TransactionClient;
  const db = {
    $transaction: async <T>(callback: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> => callback(tx),
    task: {
      findUnique: tx.task.findUnique,
    },
    taskActivity: tx.taskActivity,
    mergeRecoveryAttempt: tx.mergeRecoveryAttempt,
    mergeLeaseEvent: tx.mergeLeaseEvent,
  } as unknown as import("@anneal/db").PrismaClient;
  const reader: PullRequestReader = {
    readPullRequest: async (_repository, prNumber) => {
      const candidate = candidates[prNumber - 1]!;
      return {
        repository: "acme/widgets", number: prNumber, state: "OPEN", isDraft: false, merged: false,
        mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "main", baseSha: base,
        headRefOid: candidate.headSha, autoMergeRequest: null, mergeQueueEntry: null,
        repositoryMergeQueue: null, mergedBy: null, mergeCommit: null, requiredCheckNames: [],
        checkContexts: [], headCommitOid: candidate.headSha, readAt: now.toISOString(),
      };
    },
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
  };
  const claimsFinished = new Set<string>();
  const offlineMarkers = new Map<string, Activity>();
  const makeRead = (readinessId: string) => {
    const readiness = readinessById.get(readinessId)!;
    const candidate = candidates.find((entry) => entry.taskId === readinessId)!;
    const regression = regressionByReadiness.get(readinessId)!;
    const claim = {
      renew: async () => true,
      settle: async <T>(_client: Prisma.TransactionClient, transition: { kind: string; apply: (client: Prisma.TransactionClient) => Promise<T> }) => {
        if (claimsFinished.has(readinessId)) return { settled: false, ownership: "released" as const };
        const value = await transition.apply(tx);
        if (transition.kind === "finish") {
          claimsFinished.add(readinessId);
          return { settled: true, claim: "released" as const, value, ownership: "released" as const };
        }
        return { settled: true, claim: "retained" as const, value };
      },
      ownershipAfterLoss: async () => "released" as const,
    };
    return {
      claimed: true as const,
      readiness,
      regression,
      recovery: null,
      claim,
      input: {
        readiness: { id: readiness.id, chainId: readiness.chainId, projectId, repoId },
        now,
        stage: "ready" as const,
        regression: { headSha: candidate.headSha, baseHeadSha: base },
        target: { resolved: true as const, repository: "acme/widgets", prNumber: candidates.indexOf(candidate) + 1 },
        defaultBranch: "main",
      },
    };
  };
  const authorizationIds: string[] = [];
  const offlineIds: string[] = [];
  let executorOnline = false;
  const hooks = {
    candidates: async function* () {},
    discover: async () => { throw new Error("formation is not part of this unit fixture"); },
    read: async (_database: import("@anneal/db").PrismaClient, task: { id: string }) => makeRead(task.id),
    authorize: (read: ReturnType<typeof makeRead>) => ({
      kind: "authorize" as const,
      taskId: read.readiness.id,
      body: async () => {
        authorizationIds.push(read.readiness.id);
        return { value: { applied: true }, leaseOutcome: { kind: "stop" as const, taskId: read.regression.id } };
      },
    }),
    executor: {
      blocking: () => executorOnline ? [] : ["merge-executor-1"],
      settleOffline: async (_client: Prisma.TransactionClient, read: ReturnType<typeof makeRead>, ids: string[]) => {
        offlineIds.push(`${read.readiness.id}:${ids.join(",")}`);
        const marker = await createActivity({ data: {
          taskId: read.readiness.id,
          actorType: "control-plane",
          body: "Merge readiness withheld its authorization: merge-executor-offline",
          metadata: { kind: "mergeTail.readiness", state: "requeued-executor-offline", episodeStartedAt: now.toISOString() },
        } });
        offlineMarkers.set(read.readiness.id, marker);
        return "ready" as const;
      },
      closeEpisode: async (_client: Prisma.TransactionClient, taskId: string) => {
        const marker = offlineMarkers.get(taskId);
        if (marker) marker.metadata.episodeClosed = true;
      },
    },
    single: async () => { throw new Error("single-candidate path is not part of this unit fixture"); },
  } as unknown as Parameters<typeof mergeTrainReadinessTick>[6];
  const releasedTargets: string[] = [];
  const lease: WithMergeLease = async (target, callback) => {
    const result = await callback();
    if (result.leaseOutcome.kind === "stop") releasedTargets.push(target!.chainId);
    return { outcome: "ran", value: result.value };
  };
  const pendingFor = (taskId: string) => ({
    taskId,
    state: "queued" as const,
    regressionTaskId: regressionByReadiness.get(candidates[0]!.taskId)!.id,
    projectId,
    repoId,
    baseSha: base,
    width: 2,
    candidates,
  }) as NonNullable<Parameters<typeof mergeTrainReadinessTick>[7]>[number];

  for (const taskId of ["train-offline", "train-online"]) {
    await createActivity({ data: {
      taskId,
      actorType: "control-plane",
      body: "Merge lease acquired; train Run queued",
      metadata: { schemaVersion: 1, kind: "mergeTail.train", state: "queued", trainTaskId: taskId,
        regressionTaskId: regressionByReadiness.get(candidates[0]!.taskId)!.id, baseSha: base, width: 2, candidates },
    } });
  }

  const offlineResult = await mergeTrainReadinessTick(db, reader, now, { width: 2, limit: 2 }, async () => {}, lease, hooks, [pendingFor("train-offline")]);
  assert.deepEqual(offlineResult, { claimed: 2, authorized: 0, requeued: 2, stopped: 0 });
  assert.deepEqual(authorizationIds, [], "an offline executor cannot receive a train authorization");
  assert.deepEqual(offlineIds, ["readiness-1:merge-executor-1", "readiness-2:merge-executor-1"]);
  assert.deepEqual(releasedTargets, [candidates[0]!.chainId], "the train Lease is released after offline settlement");
  for (const candidate of candidates) {
    const marker = markerFor(candidate.taskId, "mergeTail.train");
    assert.equal(marker?.metadata.state, "settled");
    assert.equal(marker?.metadata.outcome, "ready");
    assert.equal(marker?.metadata.settlement, "pass");
    assert.equal(offlineMarkers.get(candidate.taskId)?.metadata.state, "requeued-executor-offline");
  }

  executorOnline = true;
  claimsFinished.clear();
  const onlineResult = await mergeTrainReadinessTick(db, reader, now, { width: 2, limit: 2 }, async () => {}, lease, hooks, [pendingFor("train-online")]);
  assert.deepEqual(onlineResult, { claimed: 2, authorized: 2, requeued: 0, stopped: 0 });
  assert.deepEqual(authorizationIds, ["readiness-1", "readiness-2"], "the next train proceeds when the executor is back");
  assert.deepEqual(releasedTargets, [candidates[0]!.chainId, candidates[0]!.chainId]);
  assert.deepEqual(candidates.map((candidate) => offlineMarkers.get(candidate.taskId)?.metadata.episodeClosed), [true, true]);
});
