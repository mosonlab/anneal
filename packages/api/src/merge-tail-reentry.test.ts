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
  lockTailChain,
  MERGE_TAIL_REPAIR_REQUEST_ACTION,
  MERGE_TAIL_RERUN_REQUEST_ACTION,
  type MergeTailRepairReentryDependencies,
  readStoppedTail,
  type ReentryVerb,
  requestMergeTailRepair,
  requestMergeTailRerun,
} from "./merge-tail-reentry.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const marker = (repairKind: "review-fix" | "gate-fix", sourceRunId: string): Marker => ({
  kind: "repairAttempt",
  state: null,
  regressionTaskId: null,
  repairTaskId: "prior-repair",
  readinessTaskId: null,
  repairKind,
  targetHeadSha: null,
  headSha: HEAD,
  baseHeadSha: BASE,
  baseSha: null,
  startHeadSha: null,
  resolvedHeadSha: null,
  recoverySourceStopId: null,
  raw: { sourceRunId },
});

type RerunAggregates = Record<string, { id: string; attempt: number; regressionTaskId: string }>;

type ScenarioOptions = {
  aggregateStatus?: MergeRecoveryStatus;
  activeRuns?: number;
  markers?: Marker[];
  refusalCode?: "HEAD_ADOPTION_CONFLICT";
  verdict?: "review-fail" | "gate-fail" | "pass" | "missing";
  outputRunId?: string;
  readinessProjectId?: string;
  repairRefusal?: string;
  taskMissing?: true;
  chainId?: null;
  regressionOutputKind?: string;
  regressionStatus?: TaskStatus;
  aggregateMissing?: true;
  incompleteRecovery?: true;
  readinessStatus?: TaskStatus;
  readinessOutputKind?: string;
  integratorStatus?: TaskStatus;
  integratorOutputKind?: string;
  sourceRunMissing?: true;
  sourceRunTaskId?: string;
  rerunActivities?: Array<Record<string, unknown>>;
  rerunAggregates?: RerunAggregates;
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
    currentBaseSha: options.incompleteRecovery ? null : BASE,
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
    chainId: options.chainId === null ? null : "chain-1",
    chainIndex: 5,
    targetBranch: "main",
    status: options.regressionStatus ?? TaskStatus.REVIEW,
    templateStep: {
      stepIndex: 5,
      outputKind: options.regressionOutputKind ?? "regression-verification-v2",
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  };
  const tx = {
    $queryRaw: async () => [{ id: regression.id }],
    task: {
      findUnique: async ({ where, select }: { where: { id: string }; select: Record<string, unknown> }) => (
        options.taskMissing
          ? null
          : where.id === "repair-1" && repairCalls.length > 0
            ? { id: "repair-1" }
            : "repoId" in select
              ? regression
              : { id: regression.id, projectId: regression.projectId, chainId: regression.chainId }
      ),
      findMany: async () => [
        regression,
        {
          id: aggregate.readinessTaskId,
          projectId: options.readinessProjectId ?? regression.projectId,
          chainId: regression.chainId,
          status: options.readinessStatus ?? TaskStatus.REVIEW,
          templateStep: {
            stepIndex: 6,
            outputKind: options.readinessOutputKind ?? "merge-authorization",
            taskTemplate: { name: "direct-engineer-workflow" },
          },
        },
        {
          id: aggregate.integratorTaskId,
          projectId: regression.projectId,
          chainId: regression.chainId,
          status: options.integratorStatus ?? TaskStatus.REVIEW,
          templateStep: {
            stepIndex: 7,
            outputKind: options.integratorOutputKind ?? "merge-result",
            taskTemplate: { name: "direct-engineer-workflow" },
          },
        },
      ],
    },
    mergeRecoveryAttempt: {
      findFirst: async () => (options.aggregateMissing ? null : aggregate),
      findUnique: async ({ where }: { where: { id: string } }) => (
        options.rerunAggregates
          ? options.rerunAggregates[where.id] ?? null
          : { status: aggregate.status }
      ),
      update: async (args: Record<string, any>) => {
        recoveryUpdates.push(args);
        Object.assign(aggregate, args.data);
        return aggregate;
      },
    },
    run: {
      count: async () => options.activeRuns ?? 0,
      findUnique: async () => (options.sourceRunMissing ? null : {
        id: aggregate.recoveryRunId,
        taskId: options.sourceRunTaskId ?? regression.id,
        branch: "feat/shared-chain",
        headSha: HEAD,
      }),
    },
    // The rerun verb has no injected verdict reader: its settlement rungs are
    // exercised against the real qualifier over a stored Regression output.
    taskStepOutput: {
      findUnique: async () => ({
        runId: aggregate.recoveryRunId,
        kind: regression.templateStep.outputKind,
        body: JSON.stringify({ schemaVersion: 2, outcome: "review-fail", headSha: HEAD, baseHeadSha: BASE, summary: "semantic defect" }),
        commitSha: HEAD,
        metadata: null,
      }),
    },
    taskActivity: {
      findMany: async ({ where }: { where: Record<string, any> }) => {
        const action = where.AND[0].metadata.equals;
        const requestId = where.AND[1].metadata.equals;
        return [...activities]
          .filter((activity) => (activity.metadata as Record<string, unknown> | undefined)?.action === action
            && (activity.metadata as Record<string, unknown> | undefined)?.requestId === requestId)
          .reverse()
          .map((activity) => ({ metadata: activity.metadata }));
      },
      create: async ({ data }: { data: Record<string, any> }) => {
        activities.push(data);
        return data;
      },
    },
  } as unknown as Prisma.TransactionClient;
  activities.push(...(options.rerunActivities ?? []) as Array<Record<string, any>>);
  const verdict = options.verdict ?? "review-fail";
  const qualifyVerdict: MergeTailRepairReentryDependencies["qualifyVerdict"] = async (_tx, input) => verdict === "missing"
    || (options.outputRunId !== undefined && options.outputRunId !== input.runId)
    ? { status: "refused", reason: "wrong output Run" }
    : verdict === "pass"
      ? { status: "ok", verdict: { schemaVersion: 2, outcome: "pass", headSha: HEAD, baseHeadSha: BASE, gateVerdict: "PASS", gateProof: `MERGE GATE: PASS ${HEAD}` }, headSha: HEAD }
      : verdict === "review-fail"
        ? { status: "ok", verdict: { schemaVersion: 2, outcome: "review-fail", headSha: HEAD, baseHeadSha: BASE, summary: "semantic defect" }, headSha: HEAD }
        : { status: "ok", verdict: { schemaVersion: 2, outcome: "gate-fail", headSha: HEAD, baseHeadSha: BASE, gateVerdict: "FAIL", gateProof: "MERGE GATE: FAIL (tests)", summary: "gate defect" }, headSha: HEAD };
  const dependencies: MergeTailRepairReentryDependencies = {
    readHistory: async () => markers,
    qualifyVerdict,
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
  return { tx, aggregate, activities, recoveryUpdates, repairCalls, dependencies, qualifyVerdict };
};

/** The two steps a settlement takes before its own rungs: lock, then read. */
const readTail = async (observed: ReturnType<typeof scenario>, verb: ReentryVerb) => {
  const chain = await lockTailChain(observed.tx, { taskId: "regression-1", verb });
  if ("message" in chain) return chain;
  return await readStoppedTail(observed.tx, { chain, verb }, observed.qualifyVerdict);
};

const codeOf = (result: object): unknown => ("detail" in result
  ? (result.detail as Record<string, unknown> | undefined)?.code
  : undefined);

const request = (observed: ReturnType<typeof scenario>, requestId = "request-1") => requestMergeTailRepair(
  observed.tx,
  { taskId: "regression-1", requestId, reason: "operator confirmed the defect", now: new Date("2026-09-03T12:00:00Z") },
  observed.dependencies,
);

// Each row breaks one clause of the stopped-tail ladder and names the refusal
// each verb reports for it. The ladder is read once; only the vocabulary is
// per verb.
const LADDER: Array<{
  clause: string;
  options: ScenarioOptions;
  repair: string;
  rerun: string;
}> = [
  {
    clause: "the Task is not a Regression verification step",
    options: { regressionOutputKind: "implementation" },
    repair: "merge_tail_repair_not_blocked",
    rerun: "merge_tail_rerun_not_blocked",
  },
  {
    clause: "no recovery attempt names the Task",
    options: { aggregateMissing: true },
    repair: "merge_tail_repair_not_blocked",
    rerun: "merge_tail_rerun_not_blocked",
  },
  {
    clause: "the recovery carries a pending head-adoption refusal",
    options: { refusalCode: "HEAD_ADOPTION_CONFLICT" },
    repair: "merge_tail_repair_refusal_pending",
    rerun: "merge_tail_rerun_not_blocked",
  },
  {
    clause: "the recovery is not blocked downstream",
    options: { aggregateStatus: MergeRecoveryStatus.REPAIRING },
    repair: "merge_tail_repair_not_blocked",
    rerun: "merge_tail_rerun_not_blocked",
  },
  {
    clause: "the recovery context is incomplete",
    options: { incompleteRecovery: true },
    repair: "merge_tail_repair_not_blocked",
    rerun: "merge_tail_rerun_not_blocked",
  },
  {
    clause: "the Regression Task is not in review",
    options: { regressionStatus: TaskStatus.DOING },
    repair: "merge_tail_repair_not_blocked",
    rerun: "merge_tail_rerun_not_blocked",
  },
  {
    clause: "a bound Task belongs to another project",
    options: { readinessProjectId: "other-project" },
    repair: "merge_tail_repair_not_blocked",
    rerun: "merge_tail_rerun_not_blocked",
  },
  {
    clause: "the readiness Task is not in review",
    options: { readinessStatus: TaskStatus.DOING },
    repair: "merge_tail_repair_not_blocked",
    rerun: "merge_tail_rerun_not_blocked",
  },
  {
    clause: "the readiness Task is not the readiness step",
    options: { readinessOutputKind: "implementation" },
    repair: "merge_tail_repair_not_blocked",
    rerun: "merge_tail_rerun_not_blocked",
  },
  {
    clause: "the integrator Task is not in review",
    options: { integratorStatus: TaskStatus.DOING },
    repair: "merge_tail_repair_not_blocked",
    rerun: "merge_tail_rerun_not_blocked",
  },
  {
    clause: "the integrator Task is not the integrator step",
    options: { integratorOutputKind: "implementation" },
    repair: "merge_tail_repair_not_blocked",
    rerun: "merge_tail_rerun_not_blocked",
  },
  {
    clause: "a bound Task still has an active Run",
    options: { activeRuns: 1 },
    repair: "merge_tail_repair_active_run",
    rerun: "merge_tail_rerun_active_run",
  },
  {
    clause: "the recovery Run is gone",
    options: { sourceRunMissing: true },
    repair: "merge_tail_repair_verdict_missing",
    rerun: "merge_tail_rerun_verdict_not_gate_fail",
  },
  {
    clause: "the recovery Run belongs to another Task",
    options: { sourceRunTaskId: "other-task" },
    repair: "merge_tail_repair_verdict_missing",
    rerun: "merge_tail_rerun_verdict_not_gate_fail",
  },
  {
    clause: "the recovery Run owns no readable verdict",
    options: { verdict: "missing" },
    repair: "merge_tail_repair_verdict_missing",
    rerun: "merge_tail_rerun_verdict_not_gate_fail",
  },
  {
    clause: "the recovery Run's output belongs to another Run",
    options: { outputRunId: "other-run" },
    repair: "merge_tail_repair_verdict_missing",
    rerun: "merge_tail_rerun_verdict_not_gate_fail",
  },
];

test("each broken clause of the stopped-tail read refuses in each verb's vocabulary", async () => {
  for (const row of LADDER) {
    for (const verb of ["repair", "rerun"] as const) {
      const result = await readTail(scenario(row.options), verb);
      assert.equal(codeOf(result), row[verb], `${row.clause} (${verb})`);
    }
  }
});

test("the stopped-tail read refuses a missing Task and a Task with no Chain", async () => {
  for (const verb of ["repair", "rerun"] as const) {
    const missing = await readTail(scenario({ taskMissing: true }), verb);
    assert.equal("reason" in missing && missing.reason, "not-found");

    const unchained = await readTail(scenario({ chainId: null }), verb);
    assert.equal(codeOf(unchained), `merge_tail_${verb}_not_blocked`);
  }
});

test("the stopped-tail read settles the aggregate, the recovery, the Run, and the verdict", async () => {
  const tail = await readTail(scenario({ verdict: "gate-fail" }), "rerun");

  assert.ok(!("message" in tail));
  assert.equal(tail.aggregate.id, "recovery-1");
  assert.equal(tail.recovery.integratorTaskId, "integrator-1");
  assert.equal(tail.recovery.readinessTaskId, "readiness-1");
  assert.equal(tail.regressionTask.id, "regression-1");
  assert.equal(tail.sourceRun.id, "recovery-run-1");
  assert.equal(tail.verdict.outcome, "gate-fail");
});

test("a stopped tail whose verdict is not gate-fail refuses only the rerun verb", async () => {
  const observed = scenario({ verdict: "review-fail" });

  const result = await requestMergeTailRerun(observed.tx, {
    taskId: "regression-1",
    requestId: "request-1",
    now: new Date("2026-09-03T12:00:00Z"),
  });

  assert.equal(codeOf(result), "merge_tail_rerun_verdict_not_gate_fail");
  assert.match("message" in result ? result.message : "", /is review-fail, not gate-fail/u);
});

test("operator recovery repair refuses a passing verdict", async () => {
  const observed = scenario({ verdict: "pass" });

  const result = await request(observed);

  assert.equal(codeOf(result), "merge_tail_repair_verdict_missing");
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

test("a repair replay survives the recovery its own request moved on", async () => {
  const observed = scenario();

  const first = await request(observed);
  // What the first request did: the aggregate is REPAIRING now, so the ladder
  // no longer reads a stopped tail. The replay must still answer.
  assert.equal(observed.aggregate.status, MergeRecoveryStatus.REPAIRING);

  assert.deepEqual(await request(observed), first);
  assert.equal(observed.repairCalls.length, 1);
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
  assert.equal(codeOf(result), "merge_tail_repair_budget_exhausted");
  assert.deepEqual(exhausted.repairCalls, []);
});

test("operator recovery repair reports task creation failures with their own code", async () => {
  const observed = scenario({ repairRefusal: "required repair agent senior-dev-astra-medium is absent or archived" });

  const result = await request(observed);

  assert.equal(codeOf(result), "merge_tail_repair_creation_failed");
  assert.deepEqual(observed.recoveryUpdates, []);
  assert.deepEqual(observed.activities, []);
});

test("operator recovery repair refuses a different request for an already consumed recovery Run", async () => {
  const observed = scenario({ markers: [marker("review-fix", "recovery-run-1")] });

  const result = await request(observed, "request-2");

  assert.equal(codeOf(result), "merge_tail_repair_already_open");
  assert.deepEqual(observed.repairCalls, []);
});

test("operator recovery repair counts the existing per-kind budget", async () => {
  const observed = scenario({ markers: [
    marker("review-fix", "older-run-1"),
    marker("review-fix", "older-run-2"),
    marker("review-fix", "older-run-3"),
  ] });

  const result = await request(observed);

  assert.equal(codeOf(result), "merge_tail_repair_budget_exhausted");
  assert.deepEqual(observed.repairCalls, []);
  assert.deepEqual(observed.recoveryUpdates, []);
  assert.deepEqual(observed.activities, []);
});

const rerunActivity = (metadata: Record<string, unknown>) => ({
  taskId: "regression-1",
  actorType: "operator",
  body: "operator rerun",
  metadata,
});

const RERUN_SETTLED = {
  schemaVersion: 1,
  action: MERGE_TAIL_RERUN_REQUEST_ACTION,
  requestId: "request-1",
  aggregateId: "recovery-2",
  attempt: 2,
  recoveryRunId: "recovery-run-2",
  headSha: HEAD,
  baseHeadSha: BASE,
};

const rerunReplay = (options: ScenarioOptions) => requestMergeTailRerun(scenario(options).tx, {
  taskId: "regression-1",
  requestId: "request-1",
  now: new Date("2026-09-03T12:00:00Z"),
});

test("a rerun replays on the attempt row's immutable identity, not on its recovery Run", async () => {
  const settled = await rerunReplay({
    rerunActivities: [rerunActivity(RERUN_SETTLED)],
    // The row has moved on: a readiness requeue rewrote `recoveryRunId`. The
    // replay still answers, and answers with the Run its own request queued.
    rerunAggregates: { "recovery-2": { id: "recovery-2", attempt: 2, regressionTaskId: "regression-1" } },
  });

  assert.deepEqual(settled, {
    aggregateId: "recovery-2",
    attempt: 2,
    recoveryRunId: "recovery-run-2",
    headSha: HEAD,
    baseHeadSha: BASE,
  });
});

test("a rerun refuses to replay an activity no live attempt row backs", async () => {
  for (const [clause, aggregates] of [
    ["the attempt row is gone", {}],
    ["the attempt row moved to another Regression Task", {
      "recovery-2": { id: "recovery-2", attempt: 2, regressionTaskId: "other-regression" },
    }],
    ["the attempt number no longer matches", {
      "recovery-2": { id: "recovery-2", attempt: 3, regressionTaskId: "regression-1" },
    }],
  ] as const) {
    const result = await rerunReplay({
      verdict: "review-fail",
      rerunActivities: [rerunActivity(RERUN_SETTLED)],
      rerunAggregates: aggregates as RerunAggregates,
    });
    // No replay: the request falls through to the ladder, which refuses this
    // review-fail tail on the rerun verb.
    assert.equal(codeOf(result), "merge_tail_rerun_verdict_not_gate_fail", clause);
  }
});

test("operator notes and malformed rows cannot forge a rerun replay", async () => {
  for (const [clause, metadata] of [
    ["an operator note", { ...RERUN_SETTLED, operatorNote: true }],
    ["a non-numeric attempt", { ...RERUN_SETTLED, attempt: "2" }],
    ["a missing recoveryRunId", { ...RERUN_SETTLED, recoveryRunId: undefined }],
  ] as const) {
    const result = await rerunReplay({
      verdict: "review-fail",
      rerunActivities: [rerunActivity(metadata as Record<string, unknown>)],
      rerunAggregates: { "recovery-2": { id: "recovery-2", attempt: 2, regressionTaskId: "regression-1" } },
    });
    assert.equal(codeOf(result), "merge_tail_rerun_verdict_not_gate_fail", clause);
  }
});
