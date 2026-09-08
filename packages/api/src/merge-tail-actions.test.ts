import type { BranchAncestryReader } from "./github-read.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_TEMPLATE_GENERATIONS,
  type Marker,
  MergeRecoveryStatus,
  type Prisma,
  type RecoveryContext,
  TaskStatus,
} from "@anneal/db";

import {
  activeRepairRecoverySourceRun,
  createMergeTailRepairTask,
  handleRegressionCompletion,
  repairBindingMismatchAtOpen,
  openDefenseAuditNotice,
  openMergeTailStopNotice,
  settleMergeTailCompletion,
  stopMergeTail,
  stopUnboundRepair,
  type StopMergeTailInput,
} from "./merge-tail-actions.js";

const recoveryContext: RecoveryContext = {
  aggregateId: "aggregate-1",
  attempt: 2,
  sourceStopId: "stop-1",
  sourceRunId: "source-run-1",
  authorizationActivityId: "authorization-1",
  repository: "acme/widgets",
  prNumber: 42,
  targetBranch: "main",
  authorizedHeadSha: "a".repeat(40),
  authorizedBaseSha: "b".repeat(40),
  observedBaseSha: "c".repeat(40),
  currentBaseSha: "d".repeat(40),
  readinessTaskId: "readiness-1",
  regressionTaskId: "regression-1",
  integratorTaskId: "integrator-1",
  recoveryRunId: "recovery-run-1",
};

const recoveryRow = (overrides: Record<string, unknown> = {}) => ({
  id: recoveryContext.aggregateId,
  attempt: recoveryContext.attempt,
  sourceStopId: recoveryContext.sourceStopId,
  boundSourceRunId: recoveryContext.sourceRunId,
  authorizationActivityId: recoveryContext.authorizationActivityId,
  repository: recoveryContext.repository,
  prNumber: recoveryContext.prNumber,
  targetBranch: recoveryContext.targetBranch,
  authorizedHeadSha: recoveryContext.authorizedHeadSha,
  authorizedBaseSha: recoveryContext.authorizedBaseSha,
  observedBaseSha: recoveryContext.observedBaseSha,
  currentBaseSha: recoveryContext.currentBaseSha,
  readinessTaskId: recoveryContext.readinessTaskId,
  regressionTaskId: recoveryContext.regressionTaskId,
  integratorTaskId: recoveryContext.integratorTaskId,
  recoveryRunId: recoveryContext.recoveryRunId,
  status: MergeRecoveryStatus.REPAIRING,
  refusalCode: null,
  failureReason: null,
  validationAttempts: 0,
  startedAt: new Date(),
  updatedAt: new Date(),
  endedAt: null,
  ...overrides,
});

const recoveryTx = (row: Record<string, unknown> | null) => ({
  mergeRecoveryAttempt: { findFirst: async () => row },
} as unknown as Prisma.TransactionClient);

test("review-fix refuses an unregistered prior output before creating a repair task", async () => {
  const retiredReviewKind = LEGACY_TEMPLATE_GENERATIONS["direct-engineer-workflow"]
    .find(({ marker }) => marker === "pre-model-neutral-review-output")?.shape
    .find(({ name }) => name === "Code review")?.outputKind;
  assert.ok(retiredReviewKind);

  const taskCreates: unknown[] = [];
  const outputQueries: Array<Record<string, unknown>> = [];
  const tx = {
    mergeRecoveryAttempt: { findFirst: async () => null },
    agent: { findFirst: async () => ({ id: "repair-agent" }) },
    agentRepoAccess: { findFirst: async () => ({ id: "repo-grant" }) },
    taskStepOutput: {
      findMany: async (query: Record<string, unknown>) => {
        outputQueries.push(query);
        return [{ kind: retiredReviewKind }];
      },
    },
    task: { create: async (args: unknown) => { taskCreates.push(args); return { id: "repair-task" }; } },
  } as unknown as Prisma.TransactionClient;

  const result = await createMergeTailRepairTask(tx, {
    regressionTask: {
      id: "regression-task",
      projectId: "project",
      repoId: "repo",
      templateId: "template",
      chainId: "chain",
      chainIndex: 5,
      targetBranch: "main",
    },
    sourceRun: { id: "source-run", branch: "agentos/repair" },
    assignee: { kind: "agent", agentId: "repair-agent", label: "senior-dev-astra-medium" },
    repairKind: "review-fix",
    headSha: "a".repeat(40),
    baseHeadSha: "b".repeat(40),
    summary: "review failure",
    now: new Date(),
  });

  assert.deepEqual(result, {
    refusal: `unknown-kind: review-fix prior output ${retiredReviewKind} has no registered Step role`,
  });
  assert.equal(taskCreates.length, 0);
  assert.equal(outputQueries.length, 1);
  const firstQuery = outputQueries[0];
  assert.deepEqual((firstQuery?.where as Record<string, unknown>)?.kind, {
    notIn: ["spec", "implementation", "review-findings", "blind-findings", "fixed-implementation"],
  });
});

test("repair completion carries context only for a complete active recovery", async () => {
  assert.deepEqual(await activeRepairRecoverySourceRun(recoveryTx(recoveryRow()), {
    regressionTaskId: recoveryContext.regressionTaskId,
    sourceRunId: recoveryContext.recoveryRunId,
  }), { case: "recovery", recoverySourceRunId: recoveryContext.recoveryRunId });
});

test("ordinary repairs do not fabricate recovery context", async () => {
  assert.deepEqual(await activeRepairRecoverySourceRun(recoveryTx(null), {
    regressionTaskId: recoveryContext.regressionTaskId,
    sourceRunId: recoveryContext.recoveryRunId,
  }), { case: "ordinary" });
});

test("an existing but incomplete recovery is classified, not thrown, at repair completion", async () => {
  const binding = await activeRepairRecoverySourceRun(
    recoveryTx(recoveryRow({ currentBaseSha: null })),
    { regressionTaskId: recoveryContext.regressionTaskId, sourceRunId: recoveryContext.recoveryRunId },
  );

  assert.equal(binding.case, "mismatch");
  assert.match(binding.case === "mismatch" ? binding.mismatch.reason : "", /incomplete identity/u);
  // Incomplete identity cannot be parked for reentry: there is no context to park.
  assert.equal(binding.case === "mismatch" ? binding.mismatch.blockable : undefined, null);
});

test("a recovery bound to another Run is classified with all three ids", async () => {
  const binding = await activeRepairRecoverySourceRun(recoveryTx(recoveryRow()), {
    regressionTaskId: recoveryContext.regressionTaskId,
    sourceRunId: "repaired-run-9",
  });

  assert.equal(binding.case, "mismatch");
  const mismatch = binding.case === "mismatch" ? binding.mismatch : null;
  assert.equal(mismatch?.recoveryId, recoveryContext.aggregateId);
  // The Run the invariant compares, and the aggregate's own differently valued
  // column of that name: an operator reading the activity sees both.
  assert.equal(mismatch?.boundRecoveryRunId, recoveryContext.recoveryRunId);
  assert.equal(mismatch?.boundSourceRunId, recoveryContext.sourceRunId);
  assert.equal(mismatch?.repairedRunId, "repaired-run-9");
  assert.match(mismatch?.reason ?? "", /^merge-tail-repair-binding-mismatch: /u);
  // REPAIRING may still be parked for the operator reentry route.
  assert.equal(mismatch?.blockable?.aggregateId, recoveryContext.aggregateId);
});

test("a terminal recovery is a mismatch that cannot be parked for reentry", async () => {
  const binding = await activeRepairRecoverySourceRun(
    recoveryTx(recoveryRow({ status: MergeRecoveryStatus.SUCCEEDED })),
    { regressionTaskId: recoveryContext.regressionTaskId, sourceRunId: recoveryContext.recoveryRunId },
  );

  assert.equal(binding.case, "mismatch");
  assert.equal(binding.case === "mismatch" ? binding.mismatch.blockable : undefined, null);
});

test("the open-time check reads the binding alone, not the recovery phase", async () => {
  // The operator reentry route creates its repair while the aggregate is still
  // BLOCKED_DOWNSTREAM, so a phase check there would refuse the one repair that
  // is legitimately bound.
  assert.equal(await repairBindingMismatchAtOpen(
    recoveryTx(recoveryRow({ status: MergeRecoveryStatus.BLOCKED_DOWNSTREAM })),
    { regressionTaskId: recoveryContext.regressionTaskId, sourceRunId: recoveryContext.recoveryRunId },
  ), null);

  const mismatch = await repairBindingMismatchAtOpen(recoveryTx(recoveryRow()), {
    regressionTaskId: recoveryContext.regressionTaskId,
    sourceRunId: "regression-run-2",
  });
  assert.equal(mismatch?.boundRecoveryRunId, recoveryContext.recoveryRunId);
  assert.equal(mismatch?.boundSourceRunId, recoveryContext.sourceRunId);
  assert.equal(mismatch?.repairedRunId, "regression-run-2");
});

test("an unbound repair parks the repair task, the Run and the recovery", async () => {
  const runUpdates: Array<Record<string, any>> = [];
  const taskUpdates: Array<Record<string, any>> = [];
  const activities: Array<Record<string, any>> = [];
  const notices: Array<Record<string, any>> = [];
  const recoveryUpdates: Array<Record<string, any>> = [];
  const tx = {
    run: {
      update: async (args: Record<string, any>) => { runUpdates.push(args); return {}; },
      count: async () => 0,
    },
    mergeRecoveryAttempt: {
      findUnique: async () => ({ status: MergeRecoveryStatus.REPAIRING }),
      update: async (args: Record<string, any>) => { recoveryUpdates.push(args); return {}; },
    },
    task: {
      update: async (args: Record<string, any>) => { taskUpdates.push(args); return {}; },
      updateMany: async (args: Record<string, any>) => { taskUpdates.push(args); return { count: 1 }; },
    },
    taskActivity: { create: async ({ data }: { data: Record<string, any> }) => { activities.push(data); return {}; } },
    inboxMessage: { upsert: async (args: Record<string, any>) => { notices.push(args); return {}; } },
  } as unknown as Prisma.TransactionClient;
  const binding = await activeRepairRecoverySourceRun(recoveryTx(recoveryRow()), {
    regressionTaskId: recoveryContext.regressionTaskId,
    sourceRunId: "repaired-run-9",
  });
  assert.equal(binding.case, "mismatch");
  if (binding.case !== "mismatch") return;

  await stopUnboundRepair(tx, {
    runId: "run-1",
    repairTaskId: "repair-1",
    repairTaskStatus: TaskStatus.DOING,
    regressionTaskId: recoveryContext.regressionTaskId,
    documentationTaskId: "documentation-1",
    mismatch: binding.mismatch,
    run: { agentId: "agent-1", sessionId: "session-1", completedAt: new Date("2026-09-06T14:04:00.000Z") },
  });

  assert.deepEqual(runUpdates, [{
    where: { id: "run-1" },
    data: { failureReason: binding.mismatch.reason },
  }]);
  assert.deepEqual(taskUpdates[0], {
    where: { id: "repair-1", status: TaskStatus.DOING },
    data: { status: TaskStatus.REVIEW, failureReason: binding.mismatch.reason },
  });
  const recorded = activities.find((activity) => activity.metadata?.kind === "mergeTailRepair.bindingMismatch");
  assert.equal(recorded?.taskId, recoveryContext.regressionTaskId);
  assert.equal(recorded?.metadata.phase, "settlement");
  assert.equal(recorded?.metadata.recoveryId, recoveryContext.aggregateId);
  assert.equal(recorded?.metadata.boundRecoveryRunId, recoveryContext.recoveryRunId);
  assert.equal(recorded?.metadata.boundSourceRunId, recoveryContext.sourceRunId);
  assert.equal(recorded?.metadata.repairedRunId, "repaired-run-9");
  assert.equal(recorded?.metadata.repairTaskId, "repair-1");
  // The Documentation Step the settlement re-opened for this repair does not
  // stay TODO for a repair whose completion was rejected.
  assert.deepEqual(taskUpdates.find((update) => update.where.id === "documentation-1"), {
    where: { id: "documentation-1" },
    data: { status: TaskStatus.REVIEW, failureReason: binding.mismatch.reason },
  });
  // Parked for the operator reentry route rather than left REPAIRING.
  assert.equal(recoveryUpdates[0]?.data.status, MergeRecoveryStatus.BLOCKED_DOWNSTREAM);
  assert.equal(notices.length, 1);
});

test("an unbound repair with no parkable recovery still stops the tail with a notice", async () => {
  const taskUpdates: Array<Record<string, any>> = [];
  const notices: Array<Record<string, any>> = [];
  const tx = {
    run: { update: async () => ({}), count: async () => 0 },
    task: {
      update: async (args: Record<string, any>) => { taskUpdates.push(args); return {}; },
      updateMany: async () => ({ count: 1 }),
    },
    taskActivity: { create: async () => ({}) },
    inboxMessage: { upsert: async (args: Record<string, any>) => { notices.push(args); return {}; } },
  } as unknown as Prisma.TransactionClient;
  const binding = await activeRepairRecoverySourceRun(
    recoveryTx(recoveryRow({ status: MergeRecoveryStatus.SUCCEEDED })),
    { regressionTaskId: recoveryContext.regressionTaskId, sourceRunId: "repaired-run-9" },
  );
  assert.equal(binding.case, "mismatch");
  if (binding.case !== "mismatch") return;

  await stopUnboundRepair(tx, {
    runId: "run-1",
    repairTaskId: "repair-1",
    regressionTaskId: recoveryContext.regressionTaskId,
    mismatch: binding.mismatch,
    run: { agentId: "agent-1", sessionId: "session-1", completedAt: new Date("2026-09-06T14:04:00.000Z") },
  });

  assert.deepEqual(taskUpdates, [{
    where: { id: recoveryContext.regressionTaskId },
    data: { status: TaskStatus.REVIEW, failureReason: binding.mismatch.reason },
  }]);
  assert.equal(notices.length, 1);
  assert.match(String(notices[0]?.create.body), /merge-tail-repair-binding-mismatch/u);
});

test("an unbound repair leaves a recovery that still has an active Run alone", async () => {
  // The mismatch is usually a newer recovery that took the chain over while the
  // repair ran. Blocking it would stop the healthy mechanism, and it would also
  // withhold the operator exit: the reentry route refuses while a tail task
  // still has an active Run.
  const taskUpdates: Array<Record<string, any>> = [];
  const notices: Array<Record<string, any>> = [];
  const recoveryUpdates: Array<Record<string, any>> = [];
  let counted: Record<string, any> | null = null;
  const tx = {
    run: {
      update: async () => ({}),
      count: async (args: Record<string, any>) => { counted = args; return 1; },
    },
    mergeRecoveryAttempt: {
      findUnique: async () => ({ status: MergeRecoveryStatus.REPAIRING }),
      update: async (args: Record<string, any>) => { recoveryUpdates.push(args); return {}; },
    },
    task: {
      update: async (args: Record<string, any>) => { taskUpdates.push(args); return {}; },
      updateMany: async (args: Record<string, any>) => { taskUpdates.push(args); return { count: 1 }; },
    },
    taskActivity: { create: async () => ({}) },
    inboxMessage: { upsert: async (args: Record<string, any>) => { notices.push(args); return {}; } },
  } as unknown as Prisma.TransactionClient;
  const binding = await activeRepairRecoverySourceRun(recoveryTx(recoveryRow()), {
    regressionTaskId: recoveryContext.regressionTaskId,
    sourceRunId: "repaired-run-9",
  });
  assert.equal(binding.case, "mismatch");
  if (binding.case !== "mismatch") return;

  await stopUnboundRepair(tx, {
    runId: "run-1",
    repairTaskId: "repair-1",
    regressionTaskId: recoveryContext.regressionTaskId,
    mismatch: binding.mismatch,
    run: { agentId: "agent-1", sessionId: "session-1", completedAt: new Date("2026-09-06T14:04:00.000Z") },
  });

  assert.deepEqual((counted as unknown as Record<string, any> | null)?.where.taskId, {
    in: [recoveryContext.regressionTaskId, recoveryContext.readinessTaskId, recoveryContext.integratorTaskId],
  });
  // The repair itself still parks; the recovery and its tasks do not move.
  assert.deepEqual(taskUpdates.map((update) => update.where.id), ["repair-1"]);
  assert.deepEqual(recoveryUpdates, []);
  // The overlap still reaches an operator.
  assert.equal(notices.length, 1);
});

const stopTx = (recoveryStatus: MergeRecoveryStatus) => {
  const activities: Array<Record<string, any>> = [];
  const notices: Array<Record<string, any>> = [];
  const recoveryUpdates: Array<Record<string, any>> = [];
  const taskUpdates: Array<Record<string, any>> = [];
  const tx = {
    mergeRecoveryAttempt: {
      findUnique: async () => ({ status: recoveryStatus }),
      update: async (args: Record<string, any>) => {
        recoveryUpdates.push(args);
        return {};
      },
    },
    task: {
      findUnique: async () => ({
        chainId: "chain-1",
        projectId: "project-1",
        templateStep: {
          stepIndex: 5,
          outputKind: "regression-verification-v2",
          taskTemplate: { name: "direct-engineer-workflow" },
        },
      }),
      update: async (args: Record<string, any>) => {
        taskUpdates.push(args);
        return {};
      },
      updateMany: async () => ({ count: 1 }),
    },
    taskActivity: {
      create: async ({ data }: { data: Record<string, any> }) => {
        activities.push(data);
        return {};
      },
    },
    inboxMessage: {
      upsert: async (args: Record<string, any>) => {
        notices.push(args);
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, activities, notices, recoveryUpdates, taskUpdates };
};

const repairAttempt = (repairKind: "refresh-conflict" | "gate-fix" | "review-fix"): Marker => ({
  kind: "repairAttempt",
  state: null,
  regressionTaskId: "regression-1",
  repairTaskId: "repair-1",
  readinessTaskId: null,
  repairKind,
  headSha: "a".repeat(40),
  baseHeadSha: "b".repeat(40),
  baseSha: null,
  startHeadSha: null,
  resolvedHeadSha: null,
  recoverySourceStopId: null,
  raw: {},
});

const completionTx = (outputBody = "repair completed") => {
  const activities: Array<Record<string, any>> = [];
  const notices: Array<Record<string, any>> = [];
  const taskUpdates: Array<Record<string, any>> = [];
  const tx = {
    taskStepOutput: {
      findUnique: async () => ({ body: outputBody }),
      upsert: async () => ({}),
    },
    run: { update: async () => ({}) },
    task: {
      findUnique: async () => null,
      update: async (args: Record<string, any>) => {
        taskUpdates.push(args);
        return {};
      },
    },
    taskActivity: {
      create: async ({ data }: { data: Record<string, any> }) => {
        activities.push(data);
        return {};
      },
    },
    inboxMessage: {
      upsert: async (args: Record<string, any>) => {
        notices.push(args);
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, activities, notices, taskUpdates };
};

const completionInput = (
  repairKind: "refresh-conflict" | "gate-fix" | "review-fix",
  succeeded: boolean,
  documentationTaskId?: string,
) => ({
  task: { id: "repair-1", documentationTaskId: documentationTaskId ?? null },
  run: {
    id: "run-1",
    agentId: "agent-1",
    sessionId: "session-1",
    completedAt: new Date("2026-08-27T12:00:00.000Z"),
  },
  body: { headSha: "c".repeat(40) },
  markers: [repairAttempt(repairKind)],
  succeeded,
});

test("openMergeTailStopNotice derives its dedupe key from the task and reason", async () => {
  let upsert: Record<string, unknown> | undefined;
  const tx = {
    inboxMessage: {
      upsert: async (args: Record<string, unknown>) => {
        upsert = args;
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;

  await openMergeTailStopNotice(tx, {
    taskId: "regression-task-1",
    agentId: "regression-verifier-1",
    sessionId: "session-1",
    reason: "merge gate proof no longer matches exact head",
  });

  const dedupeKey = "merge-tail-stop:regression-task-1:9f7b7769875b76f39403dda876c8cc7accdde7037d36052fd9633675f668e6e9";
  assert.deepEqual(upsert, {
    where: { dedupeKey },
    create: {
      from: "AGENT",
      agentId: "regression-verifier-1",
      sessionId: "session-1",
      taskId: "regression-task-1",
      kind: "TEXT",
      body: "Autonomous merge tail stopped: merge gate proof no longer matches exact head",
      dedupeKey,
    },
    update: {},
  });
});

test("openDefenseAuditNotice records the triggered paths against the readiness task", async () => {
  let upsert: Record<string, unknown> | undefined;
  const tx = {
    inboxMessage: {
      upsert: async (args: Record<string, unknown>) => {
        upsert = args;
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;

  await openDefenseAuditNotice(tx, {
    readinessTaskId: "readiness-task-1",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    triggers: [
      { path: "packages/api/src/app.ts", reason: "merge-tail-machinery" },
      { path: "scripts/gate-worker/run.sh", reason: "gate-worker" },
    ],
  });

  const dedupeKey = `defense-audit:readiness-task-1:${"a".repeat(40)}`;
  assert.deepEqual(upsert, {
    where: { dedupeKey },
    create: {
      from: "AGENT",
      taskId: "readiness-task-1",
      kind: "TEXT",
      body: [
        "Merge proceeded with defense-list changes",
        `Exact range ${"b".repeat(40)}..${"a".repeat(40)}.`,
        "- packages/api/src/app.ts (merge-tail-machinery)\n- scripts/gate-worker/run.sh (gate-worker)",
      ].join("\n\n"),
      dedupeKey,
    },
    update: {},
  });
});

test("settleMergeTailCompletion records a successful repair", async () => {
  const observed = completionTx();

  const result = await settleMergeTailCompletion(observed.tx, completionInput("gate-fix", true));

  assert.deepEqual(result, { handled: false, leaseOutcome: "continue" });
  assert.equal(observed.notices.length, 0);
  assert.deepEqual(observed.taskUpdates, []);
  assert.equal(observed.activities.length, 1);
  assert.deepEqual(observed.activities[0]?.metadata, {
    schemaVersion: 1,
    repairKind: "gate-fix",
    repairTaskId: "repair-1",
    startHeadSha: "a".repeat(40),
    targetHeadSha: "b".repeat(40),
    resolvedHeadSha: "c".repeat(40),
    kind: "mergeTail.repairResult",
  });
});

test("settleMergeTailCompletion stops a failed repair", async () => {
  const observed = completionTx();

  const result = await settleMergeTailCompletion(observed.tx, completionInput("review-fix", false));

  assert.deepEqual(result, { handled: true, leaseOutcome: "stop" });
  assert.deepEqual(observed.taskUpdates, [{
    where: { id: "regression-1" },
    data: {
      status: TaskStatus.REVIEW,
      failureReason: `review-fix repair repair-1 failed without closing the repair at ${"a".repeat(40)}`,
    },
  }]);
  assert.equal(observed.activities[0]?.metadata?.state, "failed");
  assert.equal(observed.notices.length, 1);
});

test("settleMergeTailCompletion stops when the resolver reports unable", async () => {
  const observed = completionTx(JSON.stringify({
    schemaVersion: 1,
    outcome: "unable",
    startHeadSha: "a".repeat(40),
    targetHeadSha: "b".repeat(40),
    blockingContradiction: "the two required histories conflict",
  }));

  const result = await settleMergeTailCompletion(observed.tx, completionInput("refresh-conflict", true));

  assert.deepEqual(result, { handled: true, leaseOutcome: "stop" });
  assert.equal(observed.activities.length, 0);
  assert.equal(observed.notices.length, 1);
  assert.deepEqual(observed.taskUpdates.map((update) => update.where.id), ["repair-1", "regression-1"]);
  assert.equal(observed.taskUpdates[0]?.data?.status, TaskStatus.DONE);
  assert.equal(observed.taskUpdates[1]?.data?.status, TaskStatus.REVIEW);
});

test("settleMergeTailCompletion moves Documentation back before Regression", async () => {
  const observed = completionTx();

  const result = await settleMergeTailCompletion(
    observed.tx,
    completionInput("review-fix", true, "documentation-1"),
  );

  assert.deepEqual(result, { handled: false, leaseOutcome: "continue" });
  assert.deepEqual(observed.taskUpdates, [{
    where: { id: "documentation-1" },
    data: {
      status: TaskStatus.TODO,
      failureReason: "documentation invalidated by review-fix repair repair-1",
    },
  }]);
});

const recoveredRegressionTx = () => {
  const observed = stopTx(MergeRecoveryStatus.REPAIRING);
  const aggregate = {
    id: recoveryContext.aggregateId,
    integratorTaskId: recoveryContext.integratorTaskId,
    sourceStopId: recoveryContext.sourceStopId,
    attempt: recoveryContext.attempt,
    status: MergeRecoveryStatus.REPAIRING,
    boundSourceRunId: recoveryContext.sourceRunId,
    authorizationActivityId: recoveryContext.authorizationActivityId,
    recoveryRunId: recoveryContext.recoveryRunId,
    readinessTaskId: recoveryContext.readinessTaskId,
    regressionTaskId: recoveryContext.regressionTaskId,
    repository: recoveryContext.repository,
    prNumber: recoveryContext.prNumber,
    targetBranch: recoveryContext.targetBranch,
    authorizedHeadSha: recoveryContext.authorizedHeadSha,
    authorizedBaseSha: recoveryContext.authorizedBaseSha,
    observedBaseSha: recoveryContext.observedBaseSha,
    currentBaseSha: recoveryContext.currentBaseSha,
  };
  const tx = observed.tx as unknown as {
    mergeRecoveryAttempt: { findFirst: (args: unknown) => Promise<typeof aggregate> };
  };
  tx.mergeRecoveryAttempt.findFirst = async () => aggregate;
  return observed;
};

const recoveredRegressionInput = {
  task: {
    id: recoveryContext.regressionTaskId,
    projectId: "project-1",
    repoId: "repo-1",
    templateId: "template-1",
    chainId: "chain-1",
    chainIndex: 5,
    targetBranch: "main",
  },
  run: {
    id: recoveryContext.recoveryRunId,
    agentId: "regression-agent-1",
    branch: "feat/shared",
    headSha: "e".repeat(40),
    sessionId: "session-1",
  },
  now: new Date("2026-09-03T12:00:00Z"),
};

test("a passing repaired recovery Regression returns to authorization", async () => {
  const observed = recoveredRegressionTx();

  const result = await handleRegressionCompletion(observed.tx, {
    ...recoveredRegressionInput,
    qualifiedVerdict: {
      schemaVersion: 2,
      outcome: "pass",
      headSha: "e".repeat(40),
      baseHeadSha: "f".repeat(40),
      gateVerdict: "PASS",
      gateProof: `MERGE GATE: PASS ${"e".repeat(40)}`,
    },
  });

  assert.equal(result, "advance");
  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.AWAITING_AUTHORIZATION);
  assert.equal(observed.activities[0]?.metadata.outcome, "pass");
  assert.deepEqual(observed.notices, []);
});

test("a second FAIL after repaired recovery parks downstream again", async () => {
  const observed = recoveredRegressionTx();

  const result = await handleRegressionCompletion(observed.tx, {
    ...recoveredRegressionInput,
    qualifiedVerdict: {
      schemaVersion: 2,
      outcome: "review-fail",
      headSha: "e".repeat(40),
      baseHeadSha: "f".repeat(40),
      summary: "the repair exposed another defect",
    },
  });

  assert.equal(result, "handled");
  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.BLOCKED_DOWNSTREAM);
  assert.deepEqual(observed.taskUpdates.map((update) => update.where.id), [
    recoveryContext.regressionTaskId,
    recoveryContext.readinessTaskId,
    recoveryContext.integratorTaskId,
  ]);
  assert.match(observed.notices[0]?.create.body, /stopped at regression/u);
});

test("stopMergeTail owns the phase by recovery matrix", async () => {
  const at = new Date("2026-08-27T12:00:00.000Z");
  const cases: Array<{
    name: string;
    status: MergeRecoveryStatus;
    input: StopMergeTailInput;
    markerStates: string[];
    noticeKey: RegExp;
    recoveryTarget: MergeRecoveryStatus | null;
    result: { leaseOutcome: { kind: "stop"; taskId: string | null } } | undefined;
  }> = [
    {
      name: "regression without recovery",
      status: MergeRecoveryStatus.REPAIRING,
      input: { phase: "regression", regressionTaskId: "regression-1", reason: "bad verdict", at, recovery: null, agentId: "agent-1" },
      markerStates: ["stopped"],
      noticeKey: /^merge-tail-stop:regression-1:/u,
      recoveryTarget: null,
      result: undefined,
    },
    {
      name: "regression during recovery",
      status: MergeRecoveryStatus.REPAIRING,
      input: { phase: "regression", regressionTaskId: "regression-1", reason: "bad verdict", at, recovery: recoveryContext, agentId: "agent-1" },
      markerStates: ["tail-stopped", "tail-stopped"],
      noticeKey: /:stop-1:regression:recovery-run-1$/u,
      recoveryTarget: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
      result: undefined,
    },
    {
      name: "readiness without recovery",
      status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
      input: { phase: "readiness", readinessTaskId: "readiness-1", regressionTaskId: "regression-1", reason: "head drift", at, recovery: null },
      markerStates: ["stopped"],
      noticeKey: /^merge-readiness-stop:readiness-1:/u,
      recoveryTarget: null,
      result: { leaseOutcome: { kind: "stop", taskId: "regression-1" } },
    },
    {
      name: "readiness during recovery",
      status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
      input: { phase: "readiness", readinessTaskId: "readiness-1", regressionTaskId: "regression-1", reason: "head drift", at, recovery: recoveryContext },
      markerStates: ["tail-stopped", "tail-stopped", "stopped"],
      noticeKey: /:stop-1:readiness:recovery-run-1$/u,
      recoveryTarget: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
      result: { leaseOutcome: { kind: "stop", taskId: "regression-1" } },
    },
    {
      name: "recovery validation",
      status: MergeRecoveryStatus.VALIDATING,
      input: {
        phase: "recovery-validation", aggregateId: "aggregate-1", integratorTaskId: "integrator-1",
        sourceStopId: "stop-1", reason: "identity mismatch", at, attempt: 1,
        recoveryData: { repository: "acme/widgets" }, markerMetadata: { repository: "acme/widgets" },
      },
      markerStates: ["ineligible"],
      noticeKey: /:ineligible:stop-1$/u,
      recoveryTarget: MergeRecoveryStatus.FAILED,
      result: undefined,
    },
    {
      name: "recovery exhausted",
      status: MergeRecoveryStatus.VALIDATING,
      input: {
        phase: "recovery-exhausted", aggregateId: "aggregate-1", integratorTaskId: "integrator-1",
        sourceStopId: "stop-1", reason: "attempt limit", at, attempt: 2,
        recoveryData: { repository: "acme/widgets" }, markerMetadata: { repository: "acme/widgets" },
      },
      markerStates: ["exhausted"],
      noticeKey: /:exhausted:stop-1$/u,
      recoveryTarget: MergeRecoveryStatus.FAILED,
      result: undefined,
    },
    {
      name: "repair",
      status: MergeRecoveryStatus.REPAIRING,
      input: {
        phase: "repair", regressionTaskId: "regression-1", repairTaskId: "repair-1", repairKind: "gate-fix",
        startHeadSha: "a".repeat(40), targetHeadSha: "b".repeat(40), resolvedHeadSha: null,
        reason: "repair failed", at, agentId: "agent-1",
      },
      markerStates: ["failed"],
      noticeKey: /^merge-tail-stop:regression-1:/u,
      recoveryTarget: null,
      result: undefined,
    },
  ];

  for (const entry of cases) {
    const observed = stopTx(entry.status);
    const result = entry.input.phase === "readiness"
      ? await stopMergeTail(observed.tx, entry.input)
      : await stopMergeTail(observed.tx, entry.input);
    assert.deepEqual(result, entry.result, entry.name);
    assert.deepEqual(
      observed.activities.map((activity) => (activity.metadata as Record<string, unknown>).state),
      entry.markerStates,
      entry.name,
    );
    assert.match(String(observed.notices[0]?.where?.dedupeKey), entry.noticeKey, entry.name);
    assert.equal(observed.recoveryUpdates[0]?.data?.status ?? null, entry.recoveryTarget, entry.name);
  }
});

test("stopMergeTail refuses an illegal recovery transition before writing it", async () => {
  const observed = stopTx(MergeRecoveryStatus.VALIDATING);
  await assert.rejects(
    stopMergeTail(observed.tx, {
      phase: "readiness",
      readinessTaskId: "readiness-1",
      regressionTaskId: "regression-1",
      reason: "cannot skip repair",
      at: new Date(),
      recovery: recoveryContext,
    }),
    /Illegal merge recovery transition VALIDATING -> BLOCKED_DOWNSTREAM/u,
  );
  assert.deepEqual(observed.recoveryUpdates, []);
});

/** A chain whose template has no fixed-implementation step: `task.findFirst`
 *  finds no fix task to staff the repair from. */
const unstaffedRepairTx = (fixTask: { id: string; assigneeAgent: null } | null = null) => {
  const observed = stopTx(MergeRecoveryStatus.REPAIRING);
  const created: Array<Record<string, any>> = [];
  const tx = observed.tx as unknown as Record<string, any>;
  tx.mergeRecoveryAttempt.findFirst = async () => null;
  tx.taskActivity.findMany = async () => [];
  tx.task.findFirst = async () => fixTask;
  tx.taskActivity.findFirst = async () => null;
  tx.staffingProfile = { findFirst: async () => null };
  tx.task.create = async (args: Record<string, any>) => {
    created.push(args);
    return { id: "repair-1" };
  };
  return { ...observed, created };
};

test("a chain with no fixed-implementation step stops instead of staffing an unconfigured agent", async () => {
  const observed = unstaffedRepairTx();

  const result = await handleRegressionCompletion(observed.tx, {
    task: {
      id: "regression-1",
      projectId: "project-1",
      repoId: "repo-1",
      templateId: "template-1",
      chainId: "chain-1",
      chainIndex: 5,
      targetBranch: "main",
    },
    run: {
      id: "run-1",
      agentId: "regression-agent-1",
      branch: "feat/shared",
      headSha: "e".repeat(40),
      sessionId: "session-1",
    },
    qualifiedVerdict: {
      schemaVersion: 2,
      outcome: "review-fail",
      headSha: "e".repeat(40),
      baseHeadSha: "f".repeat(40),
      summary: "the reviewer found a defect",
    },
    now: new Date("2026-09-03T12:00:00Z"),
  });

  assert.equal(result, "handled");
  const reason = "chain chain-1 has no fixed-implementation step to staff the review-fix repair";
  // No repair card at all, and none assigned to a canonical role the chain
  // never named.
  assert.deepEqual(observed.created, []);
  assert.deepEqual(observed.taskUpdates, [{
    where: { id: "regression-1" },
    data: { status: TaskStatus.REVIEW, failureReason: reason },
  }]);
  assert.equal(observed.notices.length, 1);
  assert.equal(observed.notices[0]?.create.body, `Autonomous merge tail stopped: ${reason}`);
  assert.equal(observed.notices[0]?.create.taskId, "regression-1");
});

test("a fixed-implementation task with no agent stops with an accurate notice", async () => {
  const observed = unstaffedRepairTx({ id: "fix-1", assigneeAgent: null });

  const result = await handleRegressionCompletion(observed.tx, {
    task: {
      id: "regression-1",
      projectId: "project-1",
      repoId: "repo-1",
      templateId: "template-1",
      chainId: "chain-1",
      chainIndex: 5,
      targetBranch: "main",
    },
    run: {
      id: "run-1",
      agentId: "regression-agent-1",
      branch: "feat/shared",
      headSha: "e".repeat(40),
      sessionId: "session-1",
    },
    qualifiedVerdict: {
      schemaVersion: 2,
      outcome: "review-fail",
      headSha: "e".repeat(40),
      baseHeadSha: "f".repeat(40),
      summary: "the reviewer found a defect",
    },
    now: new Date("2026-09-03T12:00:00Z"),
  });

  assert.equal(result, "handled");
  const reason = "chain chain-1 fixed-implementation task fix-1 staffs no Agent for the review-fix repair";
  // No repair card at all, and none assigned to a canonical role the chain
  // never named.
  assert.deepEqual(observed.created, []);
  assert.deepEqual(observed.taskUpdates, [{
    where: { id: "regression-1" },
    data: { status: TaskStatus.REVIEW, failureReason: reason },
  }]);
  assert.equal(observed.notices.length, 1);
  assert.equal(observed.notices[0]?.create.body, `Autonomous merge tail stopped: ${reason}`);
  assert.equal(observed.notices[0]?.create.taskId, "regression-1");
});

for (const recovery of [null, recoveryContext]) {
  test(`a later offline ceiling reopens the same notice (recovery=${recovery !== null})`, async () => {
    const observed = stopTx(MergeRecoveryStatus.AWAITING_AUTHORIZATION);
    const notices = new Map<string, Record<string, unknown>>();
    const tx = observed.tx as unknown as { inboxMessage: { upsert: (input: {
      where: { dedupeKey: string }; create: Record<string, unknown>; update: Record<string, unknown>;
    }) => Promise<unknown> } };
    tx.inboxMessage.upsert = async ({ where, create, update }) => {
      const current = notices.get(where.dedupeKey);
      const next = current ? { ...current, ...update } : { status: "OPEN", ...create };
      notices.set(where.dedupeKey, next);
      return next;
    };
    const input = { phase: "readiness" as const, readinessTaskId: "readiness-1", regressionTaskId: "regression-1",
      reason: "merge-executor-offline: no merge executor in executor is online after 15 minutes",
      at: new Date(), recovery };
    await stopMergeTail(observed.tx, input);
    const first = [...notices.values()][0]!;
    first.status = "CLOSED";
    first.answeredAt = new Date();
    first.body = "previous notice";
    await stopMergeTail(observed.tx, input);
    assert.equal(notices.size, 1);
    const reopened = [...notices.values()][0]!;
    assert.equal(reopened.status, "OPEN");
    assert.equal(reopened.answeredAt, null);
    assert.match(String(reopened.body), /merge-executor-offline/u);
    await stopMergeTail(observed.tx, input);
    assert.equal(notices.size, 1, "repeated settlement within an episode stays idempotent");
  });
}

for (const scenario of ["adopt", "missing-head", "no-push", "wrong-base", "wrong-start", "read-error"] as const) {
  test(`malformed refresh-conflict output repository fallback: ${scenario}`, async (t) => {
    const observed = completionTx(scenario === "missing-head" ? JSON.stringify({
      schemaVersion: 1, outcome: "resolved", startHeadSha: "a".repeat(40), targetHeadSha: "b".repeat(40),
      tradeOffs: [], changedTestExpectations: [],
    }) : "resolved it");
    const adopts = scenario === "adopt" || scenario === "missing-head";
    const runUpdates: unknown[] = [];
    const outputUpdates: Array<{ create: { kind: string } }> = [];
    t.mock.method(observed.tx.task, "findUnique", async () => ({
      targetBranch: "feature", repo: { remoteUrl: "https://github.com/acme/widgets.git" },
    }));
    t.mock.method(observed.tx.run, "update", async (args: unknown) => { runUpdates.push(args); });
    t.mock.method(observed.tx.taskStepOutput, "upsert", async (args: { create: { kind: string } }) => { outputUpdates.push(args); });
    const head = scenario === "no-push" ? "a".repeat(40) : "d".repeat(40);
    const urls: string[] = [];
    const repositoryReader: BranchAncestryReader = {
      readBranchHead: async (repository, branch) => {
        assert.equal(repository, "acme/widgets");
        assert.equal(branch, "feature");
        urls.push("/git/ref/");
        if (scenario === "read-error") throw new Error("read refused");
        return head;
      },
      compareCommits: async (_repository, base, comparedHead) => {
        assert.equal(comparedHead, head);
        urls.push(`/compare/${base}`);
        const wrong = scenario === "wrong-start" && base === "a".repeat(40)
          || (scenario === "wrong-base" || scenario === "no-push") && base === "b".repeat(40);
        return { status: wrong ? "diverged" : "ahead", behindBy: wrong ? 1 : 0, filesComplete: true, files: [] };
      },
    };
    const result = await settleMergeTailCompletion(observed.tx, {
      ...completionInput("refresh-conflict", true),
      task: { id: "repair-1", templateStep: { stepIndex: 1, outputKind: "resolver-result" } },
      repositoryReader,
    });
    assert.deepEqual(result, adopts
      ? { handled: false, leaseOutcome: "continue" }
      : { handled: true, leaseOutcome: "stop" });
    assert.equal(urls.filter((url) => url.includes("/git/ref/")).length, 1);
    if (adopts) {
      assert.equal(urls.length, 3);
      assert.equal(observed.activities.at(-1)?.metadata.resolvedHeadSha, head);
      assert.ok(observed.activities.some((activity) => /fallback/u.test(activity.body) && activity.metadata.rejectedKey === (scenario === "missing-head" ? "resolvedHeadSha" : "body")));
      assert.equal(runUpdates.length, 1);
      assert.equal(outputUpdates.length, 1);
      assert.equal(outputUpdates[0]?.create.kind, "resolver-result");
      assert.equal(observed.notices.length, 0);
    } else {
      assert.equal(runUpdates.length, 0);
      assert.equal(outputUpdates.length, 0);
      assert.equal(observed.activities.at(-1)?.metadata.state, "invalid-output");
      assert.equal(observed.notices.length, 1);
      if (scenario === "read-error") assert.ok(observed.activities.some((activity) => /fallback.*failed/u.test(activity.body)));
    }
  });
}

for (const rejected of ["startHeadSha", "targetHeadSha", "unable"] as const) {
  test(`malformed resolver fallback preserves ${rejected} refusal without a repository read`, async (t) => {
    const observed = completionTx(JSON.stringify({
      schemaVersion: 1, outcome: rejected === "unable" ? "unable" : "resolved",
      startHeadSha: rejected === "startHeadSha" ? "e".repeat(40) : "a".repeat(40),
      targetHeadSha: rejected === "targetHeadSha" ? "e".repeat(40) : "b".repeat(40),
    }));
    const read = t.mock.method(observed.tx.task, "findUnique", async () => { throw new Error("must not read"); });
    assert.deepEqual(await settleMergeTailCompletion(observed.tx, completionInput("refresh-conflict", true)), {
      handled: true, leaseOutcome: "stop",
    });
    assert.equal(read.mock.callCount(), 0);
  });
}
