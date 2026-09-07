import "./test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  type Marker,
  MergeRecoveryStatus,
  type Prisma,
  TaskStatus,
} from "@anneal/db";

import {
  MERGE_TAIL_REPAIR_REQUEST_ACTION,
  requestMergeTailRepair,
  type MergeTailRepairReentryDependencies,
} from "./merge-tail-repair-reentry.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const marker = (repairKind: "review-fix" | "gate-fix", sourceRunId: string): Marker => ({
  kind: "repairAttempt",
  state: null,
  regressionTaskId: null,
  repairTaskId: "prior-repair",
  readinessTaskId: null,
  repairKind,
  headSha: HEAD,
  baseHeadSha: BASE,
  baseSha: null,
  startHeadSha: null,
  resolvedHeadSha: null,
  recoverySourceStopId: null,
  raw: { sourceRunId },
});

type ScenarioOptions = {
  aggregateStatus?: MergeRecoveryStatus;
  activeRuns?: number;
  markers?: Marker[];
  refusalCode?: "HEAD_ADOPTION_CONFLICT";
  verdict?: "review-fail" | "gate-fail" | "pass" | "missing";
  outputRunId?: string;
  readinessProjectId?: string;
  repairRefusal?: string;
};

const scenario = (options: ScenarioOptions = {}) => {
  const activities: Array<Record<string, any>> = [];
  const recoveryUpdates: Array<Record<string, any>> = [];
  const repairCalls: Array<Record<string, any>> = [];
  const markers = [...(options.markers ?? [])];
  const aggregate = {
    id: "recovery-1",
    integratorTaskId: "integrator-1",
    sourceStopId: "stop-1",
    attempt: 1,
    status: options.aggregateStatus ?? MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
    validationAttempts: 0,
    boundSourceRunId: "source-run-1",
    authorizationActivityId: "authorization-1",
    recoveryRunId: "recovery-run-1",
    readinessTaskId: "readiness-1",
    regressionTaskId: "regression-1",
    repository: "acme/widgets",
    prNumber: 42,
    targetBranch: "main",
    authorizedHeadSha: HEAD,
    authorizedBaseSha: BASE,
    observedBaseSha: "c".repeat(40),
    currentBaseSha: BASE,
    failureReason: "semantic regression FAIL",
    refusalCode: options.refusalCode ?? null,
    startedAt: new Date("2026-09-03T10:00:00Z"),
    updatedAt: new Date("2026-09-03T10:01:00Z"),
    endedAt: new Date("2026-09-03T10:01:00Z"),
  };
  const regression = {
    id: "regression-1",
    projectId: "project-1",
    repoId: "repo-1",
    templateId: "template-1",
    chainId: "chain-1",
    chainIndex: 5,
    targetBranch: "main",
    status: TaskStatus.REVIEW,
    templateStep: {
      stepIndex: 5,
      outputKind: "regression-verification-v2",
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  };
  const tx = {
    $queryRaw: async () => [{ id: regression.id }],
    task: {
      findUnique: async ({ where, select }: { where: { id: string }; select: Record<string, unknown> }) => (
        where.id === "repair-1" && repairCalls.length > 0
          ? { id: "repair-1" }
          : "repoId" in select ? regression : { id: regression.id, projectId: regression.projectId, chainId: regression.chainId }
      ),
      findMany: async () => [
        regression,
        {
          id: aggregate.readinessTaskId,
          projectId: options.readinessProjectId ?? regression.projectId,
          chainId: regression.chainId,
          status: TaskStatus.REVIEW,
          templateStep: { stepIndex: 6, outputKind: "merge-authorization", taskTemplate: { name: "direct-engineer-workflow" } },
        },
        {
          id: aggregate.integratorTaskId,
          projectId: regression.projectId,
          chainId: regression.chainId,
          status: TaskStatus.REVIEW,
          templateStep: { stepIndex: 7, outputKind: "merge-result", taskTemplate: { name: "direct-engineer-workflow" } },
        },
      ],
    },
    mergeRecoveryAttempt: {
      findFirst: async () => aggregate,
      findUnique: async () => ({ status: aggregate.status }),
      update: async (args: Record<string, any>) => {
        recoveryUpdates.push(args);
        Object.assign(aggregate, args.data);
        return aggregate;
      },
    },
    run: {
      count: async () => options.activeRuns ?? 0,
      findUnique: async () => ({
        id: aggregate.recoveryRunId,
        taskId: regression.id,
        branch: "feat/shared-chain",
        headSha: HEAD,
      }),
    },
    taskActivity: {
      findMany: async ({ where }: { where: Record<string, any> }) => {
        const requestId = where.AND[1].metadata.equals;
        return [...activities]
          .filter((activity) => activity.metadata?.requestId === requestId)
          .reverse()
          .map((activity) => ({ metadata: activity.metadata }));
      },
      create: async ({ data }: { data: Record<string, any> }) => {
        activities.push(data);
        return data;
      },
    },
  } as unknown as Prisma.TransactionClient;
  const verdict = options.verdict ?? "review-fail";
  const dependencies: MergeTailRepairReentryDependencies = {
    readHistory: async () => markers,
    qualifyVerdict: async (_tx, input) => verdict === "missing"
      || (options.outputRunId !== undefined && options.outputRunId !== input.runId)
      ? { status: "refused", reason: "wrong output Run" }
      : verdict === "pass"
        ? { status: "ok", verdict: { schemaVersion: 2, outcome: "pass", headSha: HEAD, baseHeadSha: BASE, gateVerdict: "PASS", gateProof: `MERGE GATE: PASS ${HEAD}` }, headSha: HEAD }
        : verdict === "review-fail"
          ? { status: "ok", verdict: { schemaVersion: 2, outcome: "review-fail", headSha: HEAD, baseHeadSha: BASE, summary: "semantic defect" }, headSha: HEAD }
          : { status: "ok", verdict: { schemaVersion: 2, outcome: "gate-fail", headSha: HEAD, baseHeadSha: BASE, gateVerdict: "FAIL", gateProof: "MERGE GATE: FAIL (tests)", summary: "gate defect" }, headSha: HEAD },
    resolveAssignee: async () => ({ kind: "agent", agentId: "fixed-implementation-agent", label: "fix" }),
    createRepairTask: async (_tx, input) => {
      if (options.repairRefusal) return { refusal: options.repairRefusal };
      assert.notEqual(input.repairKind, "refresh-conflict");
      repairCalls.push(input);
      markers.push({
        ...marker(input.repairKind as "review-fix" | "gate-fix", input.sourceRun.id),
        repairTaskId: "repair-1",
      });
      return { taskId: "repair-1" };
    },
  };
  return { tx, aggregate, activities, recoveryUpdates, repairCalls, dependencies };
};

const request = (observed: ReturnType<typeof scenario>, requestId = "request-1") => requestMergeTailRepair(
  observed.tx,
  { taskId: "regression-1", requestId, reason: "operator confirmed the defect", now: new Date("2026-09-03T12:00:00Z") },
  observed.dependencies,
);

test("operator recovery repair refuses an aggregate that is not blocked", async () => {
  const observed = scenario({ aggregateStatus: MergeRecoveryStatus.REPAIRING });

  const result = await request(observed);

  assert.equal("detail" in result && result.detail?.code, "merge_tail_repair_not_blocked");
  assert.deepEqual(observed.repairCalls, []);
  assert.deepEqual(observed.activities, []);
});

test("operator recovery repair refuses a malformed cross-chain aggregate", async () => {
  const observed = scenario({ readinessProjectId: "other-project" });

  const result = await request(observed);

  assert.equal("detail" in result && result.detail?.code, "merge_tail_repair_not_blocked");
  assert.deepEqual(observed.repairCalls, []);
});

test("operator recovery repair refuses an incomplete recovery context without side effects", async () => {
  const observed = scenario();
  observed.aggregate.currentBaseSha = null as unknown as string;

  const result = await request(observed);

  assert.equal("detail" in result && result.detail?.code, "merge_tail_repair_not_blocked");
  assert.deepEqual(observed.repairCalls, []);
  assert.deepEqual(observed.recoveryUpdates, []);
  assert.deepEqual(observed.activities, []);
});

test("operator recovery repair refuses missing, foreign, and passing verdicts", async () => {
  for (const [name, options] of [
    ["missing", { verdict: "missing" as const }],
    ["foreign", { outputRunId: "other-run" }],
    ["pass", { verdict: "pass" as const }],
  ] as const) {
    const observed = scenario(options);
    const result = await request(observed);
    assert.equal("detail" in result && result.detail?.code, "merge_tail_repair_verdict_missing", name);
    assert.deepEqual(observed.repairCalls, []);
  }
});

test("operator recovery repair refuses while any tail task has an active Run", async () => {
  const observed = scenario({ activeRuns: 1 });

  const result = await request(observed);

  assert.equal("detail" in result && result.detail?.code, "merge_tail_repair_active_run");
  assert.deepEqual(observed.repairCalls, []);
});

test("operator recovery repair leaves head-adoption refusals to their existing recovery path", async () => {
  const observed = scenario({ refusalCode: "HEAD_ADOPTION_CONFLICT" });

  const result = await request(observed);

  assert.equal("detail" in result && result.detail?.code, "merge_tail_repair_refusal_pending");
  assert.deepEqual(observed.repairCalls, []);
});

test("operator recovery repair creates once, uses the fixed assignee, and replays by requestId", async () => {
  const observed = scenario();

  const first = await request(observed);
  const replay = await request(observed);

  const expected = { repairTaskId: "repair-1", repairKind: "review-fix", headSha: HEAD, baseHeadSha: BASE };
  assert.deepEqual(first, expected);
  assert.deepEqual(replay, expected);
  assert.equal(observed.repairCalls.length, 1);
  assert.deepEqual(observed.repairCalls[0]?.assignee, {
    kind: "agent",
    agentId: "fixed-implementation-agent",
    label: "fix",
  });
  assert.equal(observed.repairCalls[0]?.sourceRun.id, "recovery-run-1");
  assert.equal(observed.recoveryUpdates.length, 1);
  assert.deepEqual(observed.recoveryUpdates[0]?.data, {
    status: MergeRecoveryStatus.REPAIRING,
    failureReason: null,
    endedAt: null,
  });
  assert.equal(observed.activities.length, 1);
  assert.deepEqual(observed.activities[0]?.metadata, {
    schemaVersion: 1,
    action: MERGE_TAIL_REPAIR_REQUEST_ACTION,
    requestId: "request-1",
    reason: "operator confirmed the defect",
    sourceRunId: "recovery-run-1",
    repairKind: "review-fix",
    headSha: HEAD,
    baseHeadSha: BASE,
    repairTaskId: "repair-1",
  });
});

test("operator notes cannot forge a repair reentry replay", async () => {
  const observed = scenario();
  observed.activities.push({
    taskId: "regression-1",
    actorType: "operator",
    body: "ordinary operator note",
    metadata: {
      operatorNote: true,
      action: MERGE_TAIL_REPAIR_REQUEST_ACTION,
      requestId: "request-1",
      repairKind: "review-fix",
      repairTaskId: "invented-repair",
      headSha: HEAD,
      baseHeadSha: BASE,
    },
  });

  const result = await request(observed);

  assert.ok("repairTaskId" in result);
  assert.equal(result.repairTaskId, "repair-1");
  assert.equal(observed.repairCalls.length, 1);
});

test("a malformed newer request activity cannot hide a genuine replay", async () => {
  const observed = scenario();
  const first = await request(observed);
  observed.activities.push({
    taskId: "regression-1",
    actorType: "operator",
    body: "malformed duplicate",
    metadata: {
      action: MERGE_TAIL_REPAIR_REQUEST_ACTION,
      requestId: "request-1",
      repairKind: "review-fix",
      repairTaskId: "invented-repair",
      headSha: HEAD,
      baseHeadSha: BASE,
    },
  });

  assert.deepEqual(await request(observed), first);
  assert.equal(observed.repairCalls.length, 1);
});

test("operator recovery repair maps a gate verdict onto the gate-fix budget", async () => {
  const accepted = scenario({ verdict: "gate-fail" });
  assert.deepEqual(await request(accepted), {
    repairTaskId: "repair-1",
    repairKind: "gate-fix",
    headSha: HEAD,
    baseHeadSha: BASE,
  });
  assert.equal(accepted.repairCalls[0]?.repairKind, "gate-fix");

  const exhausted = scenario({
    verdict: "gate-fail",
    markers: [marker("gate-fix", "older-run-1"), marker("gate-fix", "older-run-2"), marker("gate-fix", "older-run-3")],
  });
  const result = await request(exhausted);
  assert.equal("detail" in result && result.detail?.code, "merge_tail_repair_budget_exhausted");
  assert.deepEqual(exhausted.repairCalls, []);
});

test("operator recovery repair reports task creation failures with their own code", async () => {
  const observed = scenario({ repairRefusal: "required repair agent senior-dev-astra-medium is absent or archived" });

  const result = await request(observed);

  assert.equal("detail" in result && result.detail?.code, "merge_tail_repair_creation_failed");
  assert.deepEqual(observed.recoveryUpdates, []);
  assert.deepEqual(observed.activities, []);
});

test("operator recovery repair refuses a different request for an already consumed recovery Run", async () => {
  const observed = scenario({ markers: [marker("review-fix", "recovery-run-1")] });

  const result = await request(observed, "request-2");

  assert.equal("detail" in result && result.detail?.code, "merge_tail_repair_already_open");
  assert.deepEqual(observed.repairCalls, []);
});

test("operator recovery repair counts the existing per-kind budget", async () => {
  const observed = scenario({ markers: [
    marker("review-fix", "older-run-1"),
    marker("review-fix", "older-run-2"),
    marker("review-fix", "older-run-3"),
  ] });

  const result = await request(observed);

  assert.equal("detail" in result && result.detail?.code, "merge_tail_repair_budget_exhausted");
  assert.deepEqual(observed.repairCalls, []);
  assert.deepEqual(observed.recoveryUpdates, []);
  assert.deepEqual(observed.activities, []);
});
