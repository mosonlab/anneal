import assert from "node:assert/strict";
import test from "node:test";

import {
  AssigneeType,
  ChainControlState,
  CodexServiceTier,
  Prisma,
  RunnerKind,
  RunnerPreference,
  RunStatus,
} from "@prisma/client";

import {
  type OpenRunIntent,
  type OpenRunDisposition,
  type OpenRunRefusal,
  NATIVE_IMPLEMENTATION_SUBAGENT_MAX_CONCURRENT,
  NATIVE_IMPLEMENTATION_SUBAGENT_MODEL,
  codexGptCapability,
  compoundImplementationAssigneeValid,
  enqueueTaskRun,
  LEASE_LOSS_REFUND_CAP,
  leaseLossRefundAvailable,
  leaseLossRefundDecision,
  basePublishedStamp,
  openRun,
  parksInsteadOfRaising,
  pinnedImplementationRange,
  recordRunBirthRefusal,
  runBirthRefusalMetadata,
  runBudgetCeiling,
} from "./run-open.js";
import { runOwnedHead } from "./run-head.js";

const now = new Date("2026-08-26T12:00:00.000Z");

const agent = (overrides: Record<string, unknown> = {}) => ({
  id: "agent-1",
  projectId: "project-1",
  environmentId: null,
  name: "senior-dev-astra-medium",
  title: "Senior Developer",
  model: "claude-sonnet",
  codexServiceTier: CodexServiceTier.DEFAULT,
  runnerPreference: RunnerPreference.CLAUDE,
  foundationalPrompt: "foundation",
  rolePrompt: "role",
  inboxAccess: false,
  disabledTools: [],
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const priorRun = (overrides: Record<string, unknown> = {}) => ({
  id: "run-3",
  projectId: "project-1",
  taskId: "task-1",
  goalId: "goal-1",
  agentId: "agent-1",
  repoId: null,
  runNumber: 3,
  runner: RunnerKind.CLAUDE,
  model: "snapshot-model",
  codexServiceTier: CodexServiceTier.DEFAULT,
  subagentModel: null,
  subagentMaxConcurrent: null,
  targetBranch: "main",
  branch: "agentos/task-1/run-3",
  pushedBranch: null,
  promptHash: "snapshot-hash",
  maxDurationMin: 90,
  stallTimeoutMin: 12,
  maxRunsPerTask: 5,
  budgetGrants: 1,
  ...overrides,
});

const taskRow = (overrides: Record<string, unknown> = {}) => ({
  id: "task-1",
  projectId: "project-1",
  name: "Implement seam",
  description: "Create the Run once",
  assigneeType: AssigneeType.AGENT,
  assigneeAgentId: "agent-1",
  assigneeAgent: agent(),
  repoId: null,
  repo: null,
  templateId: null,
  templateStepId: null,
  templateStep: null,
  chainId: null,
  chainIndex: null,
  targetBranch: "main",
  opensPullRequest: true,
  maxDurationMin: 120,
  stallTimeoutMin: 10,
  maxSessionsPerTask: 5,
  spendCap: null,
  archivedAt: null,
  runs: [],
  ...overrides,
});

/** A Run as the spend-cap basis reads it: its model and its session's costs. */
const costedRun = (costUsd: string | null, overrides: Record<string, unknown> = {}) => ({
  model: "claude-opus-5",
  session: {
    costUsd: costUsd === null ? null : new Prisma.Decimal(costUsd),
    inputTokens: null,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    outputTokens: null,
    nativeChildUsed: false,
    ...overrides,
  },
});

const intents = (): OpenRunIntent[] => [
  { kind: "enqueue", readyAt: now },
  { kind: "merge-tail-requeue", readyAt: now, budgetGrant: 1 },
  { kind: "claim-invalidated", sourceRunId: "run-3", readyAt: now },
  { kind: "merge-tail-repair", readyAt: now },
  { kind: "task-created", readyAt: now },
  { kind: "retry", readyAt: now },
  { kind: "integrator-authorized", readyAt: now },
  {
    kind: "retry-after-completion",
    readyAt: now,
    sourceRunId: "run-3",
    sourceMaxRunsPerTask: 5,
    sourceBudgetGrants: 1,
    budgetGrant: 1,
  },
  {
    kind: "retry-after-lease-loss",
    readyAt: now,
    sourceRunId: "run-3",
    sourceMaxRunsPerTask: 5,
    sourceBudgetGrants: 1,
  },
];

const fakeTx = (
  task: ReturnType<typeof taskRow> | null,
  options: {
    chainControlRows?: Array<Record<string, unknown>>;
    lockedAgent?: ReturnType<typeof agent> | null;
    publishedRuns?: Array<{ taskId: string; repoId: string; pushedBranch: string | null }>;
    stopRows?: Array<Record<string, unknown>>;
    /** The task's costed Run rows, as the spend-cap basis reads them. */
    costedRuns?: Array<Record<string, unknown>>;
  } = {},
) => {
  const creates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const taskUpdates: Array<Record<string, unknown>> = [];
  let agentLocks = 0;
  const tx = {
    $queryRaw: async () => {
      agentLocks += 1;
      return options.lockedAgent === null ? [] : [{ id: task?.assigneeAgentId ?? "agent-1" }];
    },
    agent: {
      findUnique: async () => options.lockedAgent === undefined ? task?.assigneeAgent ?? null : options.lockedAgent,
    },
    task: {
      findUnique: async () => task,
      findFirst: async () => null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        taskUpdates.push(data);
        return { ...task, ...data };
      },
    },
    taskActivity: {
      findMany: async () => options.stopRows ?? [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        activities.push(data);
        return { id: "activity-1" };
      },
    },
    chainControl: {
      findMany: async () => options.chainControlRows ?? [],
    },
    taskTemplateStep: { findUnique: async () => null },
    run: {
      findFirst: async ({ where }: { where: Record<string, any> }) => {
        const rows = options.publishedRuns ?? [];
        return rows.find((row) => (
          (typeof where.taskId !== "string" || row.taskId === where.taskId)
          && (typeof where.repoId !== "string" || row.repoId === where.repoId)
          && (typeof where.pushedBranch !== "string" || row.pushedBranch === where.pushedBranch)
          && (typeof where.task?.id !== "string" || row.taskId === where.task.id)
        )) ?? null;
      },
      findMany: async () => options.costedRuns ?? [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { id: "opened-run", ...data };
      },
    },
  };
  return { tx: tx as never, creates, activities, taskUpdates, agentLocks: () => agentLocks };
};

const integratorStep = {
  id: "integrator-step",
  stepIndex: 12,
  outputKind: "merge-result",
  baseFromStepIndex: null,
  taskTemplate: { name: "compound-engineer-workflow" },
};

const outputOnlyStep = {
  id: "regression-step",
  stepIndex: 6,
  outputKind: "regression-verification-v2",
  requiresCommit: false,
  baseFromStepIndex: null,
  taskTemplate: { name: "direct-engineer-workflow" },
};

test("Run birth derives a manual commit policy from delivery shape and snapshots a template Step", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const fixtures = [
    {
      name: "manual pull-request Task",
      task: taskRow({ repoId: repo.id, repo }),
      expected: true,
    },
    {
      name: "manual branch-only Task",
      task: taskRow({ repoId: repo.id, repo, opensPullRequest: false }),
      expected: false,
    },
    {
      name: "output-only template Step",
      task: taskRow({
        repoId: repo.id,
        repo,
        templateId: "template-1",
        templateStepId: outputOnlyStep.id,
        templateStep: outputOnlyStep,
      }),
      expected: false,
    },
  ] as const;

  for (const fixture of fixtures) {
    const { tx, creates } = fakeTx(fixture.task);
    const opened = await openRun(tx, fixture.task.id, { kind: "task-created", readyAt: now });
    assert.equal(opened.ok, true, fixture.name);
    assert.equal(creates[0]?.requiresCommit, fixture.expected, fixture.name);
  }
});

test("a retry snapshots the current Step commit contract instead of inheriting its prior Run", async () => {
  const task = taskRow({
    templateId: "template-1",
    templateStepId: outputOnlyStep.id,
    templateStep: outputOnlyStep,
    runs: [priorRun({ requiresCommit: true })],
  });
  const { tx, creates } = fakeTx(task);

  const opened = await openRun(tx, task.id, { kind: "retry", readyAt: now });

  assert.equal(opened.ok, true);
  assert.equal(creates[0]?.requiresCommit, false);
});

test("a Run based on its own Task's prior publication does not require another commit", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const salvage = "agentos/task-1/run-1";
  const publishedRuns = [{ taskId: "task-1", repoId: repo.id, pushedBranch: salvage }];
  const task = taskRow({
    repoId: repo.id,
    repo,
    runs: [priorRun({ repoId: repo.id, branch: salvage, pushedBranch: salvage })],
  });
  const { tx, creates } = fakeTx(task, { publishedRuns });

  const opened = await openRun(tx, task.id, { kind: "retry", readyAt: now });

  assert.equal(opened.ok, true);
  assert.equal(creates[0]?.targetBranch, salvage);
  assert.equal(creates[0]?.requiresCommit, false);
});

test("ordinary and other-Task bases keep the configured commit contract", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const otherTaskBranch = "agentos/task-2/run-1";
  const fixtures = [
    { name: "target branch", targetBranch: repo.defaultBranch, publishedRuns: [] },
    {
      name: "another Task's publication",
      targetBranch: otherTaskBranch,
      publishedRuns: [{ taskId: "task-2", repoId: repo.id, pushedBranch: otherTaskBranch }],
    },
  ];

  for (const fixture of fixtures) {
    const task = taskRow({ repoId: repo.id, repo, targetBranch: fixture.targetBranch });
    const { tx, creates } = fakeTx(task, { publishedRuns: fixture.publishedRuns });
    const opened = await openRun(tx, task.id, { kind: "task-created", readyAt: now });
    assert.equal(opened.ok, true, fixture.name);
    assert.equal(creates[0]?.targetBranch, fixture.targetBranch, fixture.name);
    assert.equal(creates[0]?.requiresCommit, true, fixture.name);
  }
});

test("a null resolved base cannot match an unpublished prior Run", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const prior = priorRun({ repoId: repo.id, branch: null, targetBranch: null });
  const task = taskRow({
    repoId: repo.id,
    repo,
    targetBranch: null,
    runs: [prior],
  });
  const { tx, creates } = fakeTx(task, {
    publishedRuns: [{ taskId: task.id, repoId: repo.id, pushedBranch: null }],
  });

  const opened = await openRun(tx, task.id, {
    kind: "retry-after-completion",
    readyAt: now,
    sourceRunId: prior.id,
    sourceMaxRunsPerTask: prior.maxRunsPerTask,
    sourceBudgetGrants: prior.budgetGrants,
    budgetGrant: 1,
  });

  assert.equal(opened.ok, true);
  assert.equal(creates[0]?.targetBranch, null);
  assert.equal(creates[0]?.requiresCommit, true);
});

test("an automatic retry preserves a Task-owned head while using salvage as its base", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const shared = "feat/shared";
  const salvage = "agentos/task-1/run-1";
  const intent: OpenRunIntent = {
    kind: "retry-after-completion",
    readyAt: now,
    sourceRunId: "run-3",
    sourceMaxRunsPerTask: 5,
    sourceBudgetGrants: 1,
    budgetGrant: 1,
  };

  for (const priorBranch of [shared, null] as const) {
    const prior = priorRun({
      repoId: repo.id,
      targetBranch: shared,
      branch: priorBranch,
      pushedBranch: salvage,
    });
    const task = taskRow({
      repoId: repo.id,
      repo,
      chainId: null,
      chainIndex: null,
      targetBranch: shared,
      runs: [prior],
    });
    const { tx, creates } = fakeTx(task, {
      publishedRuns: [{ taskId: task.id, repoId: repo.id, pushedBranch: salvage }],
    });

    const opened = await openRun(tx, task.id, intent);

    assert.equal(opened.ok, true, `prior branch ${priorBranch ?? "null"}`);
    // A head the Task owns carries forward; a prior Run that never received one
    // leaves this Run to publish the ref it owns.
    assert.equal(
      creates[0]?.branch,
      priorBranch ?? runOwnedHead(task.id, 4),
      `prior branch ${priorBranch ?? "null"}`,
    );
    assert.equal(creates[0]?.targetBranch, salvage, `prior branch ${priorBranch ?? "null"}`);
  }
});

test("automatic retries publish the ref they own rather than the previous Run's", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const run1Salvage = runOwnedHead("task-1", 1);
  const run2Salvage = runOwnedHead("task-1", 2);
  const publishedRuns = [
    { taskId: "task-1", repoId: repo.id, pushedBranch: run2Salvage },
    { taskId: "task-1", repoId: repo.id, pushedBranch: run1Salvage },
  ];

  const run1 = priorRun({
    id: "run-1",
    runNumber: 1,
    repoId: repo.id,
    branch: run1Salvage,
    pushedBranch: run1Salvage,
  });
  const run1Task = taskRow({ repoId: repo.id, repo, runs: [run1] });
  const firstRetry = fakeTx(run1Task, { publishedRuns });
  const openedRun2 = await openRun(firstRetry.tx, run1Task.id, {
    kind: "retry-after-completion",
    readyAt: now,
    sourceRunId: run1.id,
    sourceMaxRunsPerTask: run1.maxRunsPerTask,
    sourceBudgetGrants: run1.budgetGrants,
    budgetGrant: 1,
  });

  assert.equal(openedRun2.ok, true);
  assert.equal(firstRetry.creates[0]?.branch, run2Salvage);
  assert.equal(firstRetry.creates[0]?.targetBranch, run1Salvage);

  const run2 = priorRun({
    id: "run-2",
    runNumber: 2,
    repoId: repo.id,
    targetBranch: run1Salvage,
    branch: run2Salvage,
    pushedBranch: run2Salvage,
  });
  const run2Task = taskRow({ repoId: repo.id, repo, runs: [run2] });
  const secondRetry = fakeTx(run2Task, { publishedRuns });
  const openedRun3 = await openRun(secondRetry.tx, run2Task.id, {
    kind: "retry-after-completion",
    readyAt: now,
    sourceRunId: run2.id,
    sourceMaxRunsPerTask: run2.maxRunsPerTask,
    sourceBudgetGrants: run2.budgetGrants,
    budgetGrant: 1,
  });

  assert.equal(openedRun3.ok, true);
  assert.equal(secondRetry.creates[0]?.branch, runOwnedHead("task-1", 3));
  assert.equal(secondRetry.creates[0]?.targetBranch, run2Salvage);
});

test("every birth intent takes its publish head from one module and none is left null", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const chainHead = "agentos/chain/tail-deadbeef";
  const priorHead = runOwnedHead("task-1", 3);
  const withPrior = (overrides: Record<string, unknown> = {}) => taskRow({
    repoId: repo.id,
    repo,
    runs: [priorRun({ repoId: repo.id, branch: priorHead, targetBranch: "main" })],
    ...overrides,
  });
  const sourceRetry = {
    sourceRunId: "run-3",
    sourceMaxRunsPerTask: 5,
    sourceBudgetGrants: 1,
  } as const;
  const cases: Array<{
    name: string;
    task: ReturnType<typeof taskRow>;
    intent: OpenRunIntent;
    branch: string;
    targetBranch: string | null;
  }> = [
    {
      name: "enqueue",
      task: taskRow({ repoId: repo.id, repo }),
      intent: { kind: "enqueue", readyAt: now },
      branch: runOwnedHead("task-1", 1),
      targetBranch: "main",
    },
    {
      name: "merge-tail-requeue",
      task: taskRow({ repoId: repo.id, repo }),
      intent: { kind: "merge-tail-requeue", readyAt: now, budgetGrant: 1 },
      branch: runOwnedHead("task-1", 1),
      targetBranch: "main",
    },
    {
      // The replacement is bound to the revoked claim and preserves its head.
      name: "claim-invalidated",
      task: withPrior(),
      intent: { kind: "claim-invalidated", sourceRunId: "run-3", readyAt: now },
      branch: priorHead,
      targetBranch: "main",
    },
    {
      name: "task-created",
      task: taskRow({ repoId: repo.id, repo }),
      intent: { kind: "task-created", readyAt: now },
      branch: runOwnedHead("task-1", 1),
      targetBranch: "main",
    },
    {
      // The repair card is chain-detached and publishes onto the chain head it
      // was created to repair, which is its own targetBranch.
      name: "merge-tail-repair",
      task: taskRow({ repoId: repo.id, repo, targetBranch: chainHead }),
      intent: { kind: "merge-tail-repair", readyAt: now },
      branch: chainHead,
      targetBranch: chainHead,
    },
    {
      // An operator retry continues the head its predecessor was told to
      // publish; provisioning recreates the ref when the remote lacks it.
      name: "retry",
      task: withPrior(),
      intent: { kind: "retry", readyAt: now },
      branch: priorHead,
      targetBranch: "main",
    },
    {
      name: "integrator-authorized",
      task: withPrior({
        assigneeAgent: agent({ name: "merge-integrator" }),
        templateStepId: integratorStep.id,
        templateStep: integratorStep,
        runs: [priorRun({ repoId: repo.id, branch: chainHead, targetBranch: "release/1.2" })],
      }),
      intent: { kind: "integrator-authorized", readyAt: now },
      branch: chainHead,
      targetBranch: "release/1.2",
    },
    {
      // The ref the previous Run owned is not carried forward: this one
      // receives its own.
      name: "retry-after-completion",
      task: withPrior(),
      intent: { kind: "retry-after-completion", readyAt: now, budgetGrant: 1, ...sourceRetry },
      branch: runOwnedHead("task-1", 4),
      targetBranch: "main",
    },
    {
      // A lost lease reported nothing terminal about the head, so the
      // replacement continues it.
      name: "retry-after-lease-loss",
      task: withPrior(),
      intent: { kind: "retry-after-lease-loss", readyAt: now, ...sourceRetry },
      branch: priorHead,
      targetBranch: "main",
    },
  ];
  assert.deepEqual(
    cases.map((fixture) => fixture.name).sort(),
    intents().map((intent) => intent.kind).sort(),
    "every birth intent states its publish target here",
  );

  for (const fixture of cases) {
    const options = fixture.name === "integrator-authorized"
      ? { lockedAgent: agent({ name: "merge-integrator" }) }
      : {};
    const { tx, creates } = fakeTx(fixture.task, options);
    const opened = await openRun(tx, fixture.task.id, fixture.intent);
    assert.equal(opened.ok, true, fixture.name);
    assert.equal(creates[0]?.branch, fixture.branch, fixture.name);
    assert.equal(creates[0]?.targetBranch, fixture.targetBranch, fixture.name);
  }
});

test("a Task without a Repo is born with no publish head at all", async () => {
  const { tx, creates } = fakeTx(taskRow({ runs: [priorRun({ branch: null })] }));
  const opened = await openRun(tx, "task-1", { kind: "retry", readyAt: now });
  assert.equal(opened.ok, true);
  assert.equal(creates[0]?.branch, null);
});

type PinnedRunRow = {
  runNumber: number;
  baseSha: string | null;
  basePublishedAt?: Date | null;
  pushedBranch?: string | null;
  status?: RunStatus;
};

/** The publication clause the selector sends, emulated on the seeded rows. */
const matchesPublishedBase = (
  where: Record<string, any> | undefined,
  run: PinnedRunRow,
): boolean => {
  const clauses = where?.OR;
  if (!Array.isArray(clauses)) return true;
  return clauses.some((clause: Record<string, any>) => {
    if (clause.basePublishedAt?.not === null) return (run.basePublishedAt ?? null) !== null;
    if ((run.basePublishedAt ?? null) !== null) return false;
    return clause.pushedBranch?.not === null
      ? (run.pushedBranch ?? null) !== null
      : (run.status ?? RunStatus.FAILED) === clause.status;
  });
};

/**
 * The pinning fake answers the two reads the derivation makes: the referenced
 * step's canonical output, and the implementation Task's own Runs. The Run read
 * is emulated from the query it receives — filtered and ordered as Prisma would
 * — so a test that seeds several Runs proves which one the derivation picks.
 * A seeded Run with no marker and no status is an unpublished failure, which
 * is the row shape the 2026-09-06 incident left behind.
 */
const pinningTx = (options: {
  output?: { taskId?: string; kind?: string; commitSha?: string | null; body?: string } | null;
  runs?: PinnedRunRow[];
}) => {
  const seen: { outputWhere?: unknown; runQuery?: Record<string, any>; runQueries: Array<Record<string, any>> } = {
    runQueries: [],
  };
  const output = options.output === null ? null : {
    taskId: "implementation-task",
    kind: "implementation",
    commitSha: implementationHead,
    body: JSON.stringify({ schemaVersion: 1, baseSha: bodyBase, headSha: implementationHead }),
    ...options.output,
  };
  const tx = {
    taskStepOutput: {
      findFirst: async (query: { where: unknown }) => {
        seen.outputWhere = query.where;
        return output;
      },
    },
    run: {
      findFirst: async (query: Record<string, any>) => {
        seen.runQuery = query;
        seen.runQueries.push(query);
        const rows = (options.runs ?? [])
          .filter(() => query.where?.taskId === output?.taskId)
          .filter((run) => (query.where?.baseSha?.not === null ? run.baseSha !== null : true))
          .filter((run) => matchesPublishedBase(query.where, run))
          .sort((left, right) => (query.orderBy?.runNumber === "asc"
            ? left.runNumber - right.runNumber
            : right.runNumber - left.runNumber));
        return rows[0] ?? null;
      },
    },
  } as never;
  return { tx, seen };
};

const implementationHead = "2".repeat(40);
const bodyBase = "9".repeat(40);
const recordedBase = "1".repeat(40);
const publishedBase = "7".repeat(40);

const reviewTask = {
  id: "review-task",
  projectId: "project-1",
  templateId: "direct-template",
  chainId: "direct-chain",
  templateStep: { baseFromStepIndex: 2 },
};

test("a pinned base follows the template Step when conditional tasks use dense chain ordinals", async () => {
  const { tx, seen } = pinningTx({ runs: [{ runNumber: 1, baseSha: recordedBase, basePublishedAt: now }] });
  const range = await pinnedImplementationRange(tx, reviewTask);

  assert.deepEqual(range, {
    implementationBaseSha: recordedBase,
    implementationHeadSha: implementationHead,
  });
  assert.deepEqual(seen.outputWhere, {
    task: {
      projectId: "project-1",
      templateId: "direct-template",
      chainId: "direct-chain",
      templateStep: { stepIndex: 2 },
    },
  });
  assert.deepEqual(seen.runQuery, {
    where: {
      taskId: "implementation-task",
      baseSha: { not: null },
      OR: [
        { basePublishedAt: { not: null } },
        { basePublishedAt: null, pushedBranch: { not: null } },
        { basePublishedAt: null, status: RunStatus.SUCCEEDED },
      ],
    },
    orderBy: { runNumber: "asc" },
    select: { baseSha: true },
  });
});

test("the pinned base is the Run the platform recorded, not the SHA the implementer typed", async () => {
  // The 2026-09-05 incident: the body named a commit that never existed, and
  // every review sibling failed provisioning fetching it.
  const { tx } = pinningTx({
    output: { body: JSON.stringify({ schemaVersion: 1, baseSha: bodyBase, headSha: implementationHead }) },
    runs: [{ runNumber: 1, baseSha: recordedBase, basePublishedAt: now }],
  });
  const range = await pinnedImplementationRange(tx, reviewTask);
  assert.equal(range?.implementationBaseSha, recordedBase);
  assert.notEqual(range?.implementationBaseSha, bodyBase);
});

test("a recovery Run's own base never moves the pinned range", async () => {
  const { tx } = pinningTx({
    runs: [
      { runNumber: 2, baseSha: implementationHead, basePublishedAt: now },
      { runNumber: 1, baseSha: recordedBase, basePublishedAt: now },
      { runNumber: 3, baseSha: "8".repeat(40), basePublishedAt: now },
    ],
  });
  const range = await pinnedImplementationRange(tx, reviewTask);
  assert.equal(range?.implementationBaseSha, recordedBase);
});

test("an implementation Task whose Runs recorded no base refuses instead of trusting the body", async () => {
  const { tx } = pinningTx({ runs: [{ runNumber: 1, baseSha: null }] });
  await assert.rejects(
    () => pinnedImplementationRange(tx, reviewTask),
    (error: Error) => {
      assert.equal(error.name, "PinnedBaseCommitError");
      assert.match(error.message, /implementation task implementation-task has no Run that published a baseSha/u);
      assert.doesNotMatch(error.message, new RegExp(bodyBase, "u"));
      return true;
    },
  );
});

test("a base only a dead Run recorded never pins the range", async () => {
  // The 2026-09-06 incident: Run 1 died before its push with the specification
  // commit only in its own workspace, and Run 2 published a different one.
  const { tx } = pinningTx({
    runs: [
      { runNumber: 1, baseSha: recordedBase, status: RunStatus.FAILED },
      { runNumber: 2, baseSha: publishedBase, basePublishedAt: now, status: RunStatus.SUCCEEDED },
    ],
  });
  const range = await pinnedImplementationRange(tx, reviewTask);
  assert.equal(range?.implementationBaseSha, publishedBase);
});

test("an unpublished base refuses and names the commit and the implementation Task", async () => {
  const { tx, seen } = pinningTx({ runs: [{ runNumber: 1, baseSha: recordedBase, status: RunStatus.FAILED }] });
  await assert.rejects(
    () => pinnedImplementationRange(tx, reviewTask),
    (error: Error & { unpublishedBase?: { implementationTaskId: string; baseSha: string | null } }) => {
      assert.equal(error.name, "PinnedBaseCommitError");
      assert.match(error.message, new RegExp(`implementation task implementation-task recorded baseSha ${recordedBase}`, "u"));
      assert.deepEqual(error.unpublishedBase, {
        implementationTaskId: "implementation-task",
        baseSha: recordedBase,
      });
      return true;
    },
  );
  // The refusal costs the second read — the recorded base it names — and the
  // published selection costs the first. Nothing else asks the Runs anything.
  assert.equal(seen.runQueries.length, 2);
  assert.deepEqual(seen.runQueries[0]?.where?.OR?.length, 3);
  assert.deepEqual(seen.runQueries[1]?.where, { taskId: "implementation-task", baseSha: { not: null } });
});

test("a pre-marker Run that published its branch pins the range even though it failed", async () => {
  // `resolveRunBranches`'s standing rule, applied here: a Run that pushed and
  // then died in `gh` is recorded FAILED with the ref on the remote, so its
  // base is fetchable and it still owns the specification commit.
  const { tx } = pinningTx({
    runs: [
      { runNumber: 1, baseSha: recordedBase, status: RunStatus.FAILED, pushedBranch: "agentos/chain/c1" },
      { runNumber: 2, baseSha: publishedBase, basePublishedAt: now, status: RunStatus.SUCCEEDED },
    ],
  });
  assert.equal((await pinnedImplementationRange(tx, reviewTask))?.implementationBaseSha, recordedBase);
});

test("a Run written before the marker existed is read through its own outcome", async () => {
  const succeeded = pinningTx({ runs: [{ runNumber: 1, baseSha: recordedBase, status: RunStatus.SUCCEEDED }] });
  assert.equal(
    (await pinnedImplementationRange(succeeded.tx, reviewTask))?.implementationBaseSha,
    recordedBase,
  );
  const lost = pinningTx({ runs: [{ runNumber: 1, baseSha: recordedBase, status: RunStatus.LOST }] });
  await assert.rejects(() => pinnedImplementationRange(lost.tx, reviewTask), /no Run published a base/u);
});

test("a publication ACK stamps a recorded base once and never restamps it", () => {
  const later = new Date(now.getTime() + 60_000);
  assert.equal(basePublishedStamp({ baseSha: recordedBase, basePublishedAt: null }, now), now);
  assert.equal(basePublishedStamp({ baseSha: recordedBase, basePublishedAt: now }, later), now);
  assert.equal(basePublishedStamp({ baseSha: null, basePublishedAt: null }, now), null);
});

test("an implementation output body with no baseSha still pins from the platform record", async () => {
  const { tx } = pinningTx({
    output: { body: JSON.stringify({ schemaVersion: 1, headSha: implementationHead }) },
    runs: [{ runNumber: 1, baseSha: recordedBase, basePublishedAt: now }],
  });
  assert.deepEqual(await pinnedImplementationRange(tx, reviewTask), {
    implementationBaseSha: recordedBase,
    implementationHeadSha: implementationHead,
  });
});

test("every OpenRunIntent applies shared Run-birth invariants unless its branch names the exception", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const stopRows = [{
    id: "stop-1",
    createdAt: now,
    metadata: {
      kind: "mergeIntegrator.result",
      schemaVersion: 1,
      outcome: "stopped",
      condition: "head-drift",
      evidence: "head moved",
      sourceRunId: "run-3",
    },
  }];
  const cases = [
    {
      name: "archived Task",
      task: taskRow({ archivedAt: now, repoId: repo.id, repo }),
      options: {},
      reason: "archived-task",
    },
    {
      name: "integrator stop state",
      task: taskRow({
        assigneeAgent: agent({ name: "merge-integrator" }),
        repoId: repo.id,
        repo,
        templateStepId: integratorStep.id,
        templateStep: integratorStep,
      }),
      options: { stopRows },
      reason: "integrator-stopped",
    },
    {
      name: "archived Agent under the shared row mutex",
      task: taskRow({ repoId: repo.id, repo }),
      options: { lockedAgent: agent({ archivedAt: now }) },
      reason: "archived-assignee",
    },
    {
      name: "compound implementation assignee",
      task: taskRow({
        repoId: repo.id,
        repo,
        templateStepId: "implementation-step",
        templateStep: {
          id: "implementation-step",
          stepIndex: 5,
          outputKind: "implementation",
          baseFromStepIndex: null,
          taskTemplate: { name: "compound-engineer-workflow" },
        },
      }),
      options: {},
      reason: "compound-implementation-assignee",
    },
    {
      name: "integrator binding",
      task: taskRow({ repoId: repo.id, repo, assigneeAgent: agent({ name: "merge-integrator" }) }),
      options: { lockedAgent: agent({ name: "merge-integrator" }) },
      reason: "invalid-request",
    },
  ] as const;

  for (const intent of intents()) {
    for (const invariant of cases) {
      if (intent.kind === "integrator-authorized" && invariant.name === "integrator stop state") continue;
      const { tx, creates } = fakeTx(invariant.task, invariant.options);
      const opened = await openRun(tx, invariant.task.id, intent);
      assert.equal(opened.ok, false, `${intent.kind} must refuse ${invariant.name}`);
      if (!opened.ok) assert.equal(opened.refusal.reason, invariant.reason, `${intent.kind}: ${invariant.name}`);
      assert.equal(creates.length, 0, `${intent.kind} must not create after ${invariant.name}`);
    }
  }
});

test("integrator-authorized is the named human reauthorization exit from an unresolved stop", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const integrator = agent({ name: "merge-integrator" });
  const task = taskRow({
    assigneeAgent: integrator,
    repoId: repo.id,
    repo,
    templateStepId: integratorStep.id,
    templateStep: integratorStep,
    maxSessionsPerTask: 3,
    runs: [priorRun({ runNumber: 3, maxRunsPerTask: 3, budgetGrants: 0 })],
  });
  const stopRows = [{
    id: "stop-1",
    createdAt: now,
    metadata: {
      kind: "mergeIntegrator.result",
      schemaVersion: 1,
      outcome: "stopped",
      condition: "head-drift",
      evidence: "head moved",
      sourceRunId: "run-3",
    },
  }];
  const { tx, creates } = fakeTx(task, { lockedAgent: integrator, stopRows });
  const opened = await openRun(tx, task.id, { kind: "integrator-authorized", readyAt: now });
  assert.equal(opened.ok, true);
  assert.equal(creates.length, 1);
  assert.equal(creates[0]?.runNumber, 4);
  assert.equal(creates[0]?.maxRunsPerTask, 4);
});

test("every OpenRunRefusal code comes from a real guard, carries a disposition, and creates no Run", async () => {
  type RefusalFixtures = {
    [Code in OpenRunRefusal["code"]]: {
      task: ReturnType<typeof taskRow> | null;
      intent: OpenRunIntent;
      options?: Parameters<typeof fakeTx>[1];
      reason: Extract<OpenRunRefusal, { code: Code }>["reason"];
      disposition: OpenRunDisposition;
      message: string;
      detail?: OpenRunRefusal["detail"];
      context?: OpenRunRefusal["context"];
    };
  };

  const repo = { id: "repo-1", defaultBranch: "main" };
  const integrator = agent({ name: "merge-integrator" });
  const cases: RefusalFixtures = {
    "task-not-found": {
      task: null,
      intent: { kind: "enqueue", readyAt: now },
      reason: "not-found",
      disposition: "fault",
      message: "Task not found",
    },
    "task-assignee-type-invalid": {
      task: taskRow({ assigneeType: AssigneeType.HUMAN, assigneeAgent: null, assigneeAgentId: null }),
      intent: { kind: "retry", readyAt: now },
      reason: "invalid-request",
      disposition: "fault",
      message: "Task task-1 cannot open a Run without an Agent assignee",
    },
    "task-assignee-missing": {
      task: taskRow({ assigneeAgent: null }),
      intent: { kind: "retry", readyAt: now },
      reason: "conflict",
      disposition: "fault",
      message: "Task assignee no longer exists; assign an agent before retrying",
    },
    "repo-required": {
      task: taskRow(),
      intent: { kind: "enqueue", readyAt: now },
      reason: "invalid-request",
      disposition: "fault",
      message: "Task task-1 cannot open a enqueue Run without a Repo",
    },
    "task-archived": {
      task: taskRow({ archivedAt: now, repoId: repo.id, repo }),
      intent: { kind: "enqueue", readyAt: now },
      reason: "archived-task",
      disposition: "fault",
      message: "Task Implement seam is archived; unarchive it before queueing a run",
      context: { taskId: "task-1", taskName: "Implement seam" },
    },
    "integrator-stopped": {
      task: taskRow({
        assigneeAgent: integrator,
        repoId: repo.id,
        repo,
        templateStepId: integratorStep.id,
        templateStep: integratorStep,
      }),
      intent: { kind: "enqueue", readyAt: now },
      options: {
        lockedAgent: integrator,
        stopRows: [{
          id: "stop-1",
          createdAt: now,
          metadata: {
            kind: "mergeIntegrator.result",
            schemaVersion: 1,
            outcome: "stopped",
            condition: "head-drift",
            evidence: "head moved",
            sourceRunId: "run-3",
          },
        }],
      },
      reason: "integrator-stopped",
      disposition: "stopped",
      message: "Merge integrator stopped on head-drift; answer the stop question before starting another run",
      context: { taskId: "task-1", condition: "head-drift" },
    },
    "assignee-archived": {
      task: taskRow({ repoId: repo.id, repo }),
      intent: { kind: "enqueue", readyAt: now },
      options: { lockedAgent: agent({ archivedAt: now }) },
      reason: "archived-assignee",
      disposition: "fault",
      message: "Task Implement seam assignee senior-dev-astra-medium is archived; unarchive the agent to queue this step",
      context: { taskId: "task-1", taskName: "Implement seam", agentName: "senior-dev-astra-medium" },
    },
    "compound-implementation-assignee": {
      task: taskRow({
        repoId: repo.id,
        repo,
        templateStepId: "implementation-step",
        templateStep: {
          id: "implementation-step",
          stepIndex: 5,
          outputKind: "implementation",
          baseFromStepIndex: null,
          taskTemplate: { name: "compound-engineer-workflow" },
        },
      }),
      intent: { kind: "enqueue", readyAt: now },
      reason: "compound-implementation-assignee",
      disposition: "fault",
      message: "Compound implementation step requires an active in-project Agent on a Codex gpt-* model",
      detail: { code: "COMPOUND_IMPLEMENTATION_ASSIGNEE_INVALID" },
    },
    "integrator-binding-invalid": {
      task: taskRow({ assigneeAgent: integrator, repoId: repo.id, repo }),
      intent: { kind: "enqueue", readyAt: now },
      options: { lockedAgent: integrator },
      reason: "invalid-request",
      disposition: "fault",
      message: "Agent merge-integrator may bind only a merge-execution step",
      context: { code: "INTEGRATOR_BINDING_INVALID" },
    },
    "initial-run-already-exists": {
      task: taskRow({ repoId: repo.id, repo, runs: [priorRun()] }),
      intent: { kind: "task-created", readyAt: now },
      reason: "conflict",
      disposition: "fault",
      message: "Task Implement seam already has a Run",
    },
    "prior-run-required": {
      task: taskRow(),
      intent: { kind: "retry", readyAt: now },
      reason: "conflict",
      disposition: "fault",
      message: "Task Implement seam has no Run to continue",
    },
    "source-run-stale": {
      task: taskRow({ runs: [priorRun({ id: "newer-run" })] }),
      intent: {
        kind: "retry-after-completion",
        readyAt: now,
        sourceRunId: "run-3",
        sourceMaxRunsPerTask: 5,
        sourceBudgetGrants: 1,
        budgetGrant: 0,
      },
      reason: "conflict",
      disposition: "fault",
      message: "Run run-3 is no longer the latest Run for task Implement seam",
    },
    "task-not-integrator": {
      task: taskRow({ repoId: repo.id, repo, runs: [priorRun()] }),
      intent: { kind: "integrator-authorized", readyAt: now },
      reason: "invalid-request",
      disposition: "fault",
      message: "Task Implement seam is not an integrator Step",
    },
    "run-budget-exhausted": {
      task: taskRow({ maxSessionsPerTask: 2, runs: [priorRun({ runNumber: 3, budgetGrants: 1 })] }),
      intent: { kind: "retry", readyAt: now },
      reason: "conflict",
      disposition: "fault",
      message: "Run budget exhausted",
    },
    "lease-loss-refunds-exhausted": {
      task: taskRow({
        repoId: repo.id,
        repo,
        runs: [priorRun({ repoId: repo.id, leaseLossRefunds: 3 })],
      }),
      intent: {
        kind: "retry-after-lease-loss",
        readyAt: now,
        sourceRunId: "run-3",
        sourceMaxRunsPerTask: 5,
        sourceBudgetGrants: 1,
      },
      reason: "conflict",
      disposition: "fault",
      message: "Lease-loss refunds exhausted after 3 platform-refunded attempts; raise maxSessionsPerTask and retry",
      detail: { leaseLossRefunds: 3, cap: 3 },
      context: { taskId: "task-1", taskName: "Implement seam" },
    },
    "spend-cap-exhausted": {
      task: taskRow({
        repoId: repo.id,
        repo,
        spendCap: new Prisma.Decimal("1.00"),
        runs: [priorRun({ repoId: repo.id })],
      }),
      intent: { kind: "retry", readyAt: now },
      options: { costedRuns: [costedRun("1.50")] },
      reason: "conflict",
      disposition: "fault",
      message: "Spend cap $1.00 reached: $1.50 spent across 1 run; raise or clear spendCap to continue",
      detail: { spendCapUsd: "1.00", spentUsd: "1.50", runs: 1 },
      context: { taskId: "task-1", taskName: "Implement seam" },
    },
    "chain-held": {
      task: taskRow({
        repoId: repo.id,
        repo,
        chainId: "chain-1",
        chainIndex: 2,
        chainLayer: 2,
      }),
      intent: { kind: "enqueue", readyAt: now },
      options: {
        chainControlRows: [{
          projectId: "project-1",
          chainId: "chain-1",
          state: ChainControlState.HELD,
          heldLayer: 1,
          heldAt: now,
          holdRequestId: "hold-1",
          holdReason: "operator hold",
          releasedAt: null,
          releaseRequestId: null,
          holdGeneration: 1,
        }],
      },
      reason: "chain-held",
      disposition: "held",
      message: "Chain chain-1 is held after layer 1; Task task-1 at layer 2 cannot queue a Run",
      detail: { chainId: "chain-1", taskLayer: 2, heldLayer: 1 },
      context: { taskId: "task-1", chainId: "chain-1", taskLayer: 2, heldLayer: 1 },
    },
  };

  for (const code of Object.keys(cases) as Array<OpenRunRefusal["code"]>) {
    const fixture = cases[code];
    const { tx, creates } = fakeTx(fixture.task, fixture.options);
    const opened = await openRun(tx, fixture.task?.id ?? "missing", fixture.intent);
    assert.equal(opened.ok, false, code);
    assert.deepEqual({ ok: opened.ok, code: opened.refusal.code }, { ok: false, code });
    assert.equal(opened.refusal.reason, fixture.reason, code);
    assert.equal(opened.refusal.disposition, fixture.disposition, `${code} disposition`);
    assert.equal(opened.refusal.message, fixture.message, code);
    assert.deepEqual(opened.refusal.detail, fixture.detail, `${code} detail`);
    assert.deepEqual(opened.refusal.context, fixture.context, `${code} context`);
    assert.equal(creates.length, 0, `${code} must not write a Run`);
  }
});

test("each OpenRunIntent creates through one seam with its named budget rule", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const cases: Array<{
    intent: OpenRunIntent;
    task: ReturnType<typeof taskRow>;
    expected: { runNumber: number; maxRunsPerTask: number; budgetGrants: number };
  }> = [
    {
      intent: { kind: "task-created", readyAt: now },
      task: taskRow({ repoId: repo.id, repo }),
      expected: { runNumber: 1, maxRunsPerTask: 5, budgetGrants: 0 },
    },
    {
      intent: { kind: "enqueue", readyAt: now },
      task: taskRow({ repoId: repo.id, repo, runs: [priorRun({ budgetGrants: 2 })] }),
      expected: { runNumber: 4, maxRunsPerTask: 7, budgetGrants: 2 },
    },
    {
      intent: { kind: "merge-tail-requeue", readyAt: now, budgetGrant: 1 },
      task: taskRow({
        repoId: repo.id,
        repo,
        runs: [priorRun({ runNumber: 5, maxRunsPerTask: 5, budgetGrants: 0 })],
      }),
      expected: { runNumber: 6, maxRunsPerTask: 6, budgetGrants: 1 },
    },
    {
      // The revoked claim already carries the refund, so the replacement's
      // arithmetic is an ordinary enqueue's; only the refund count moves.
      intent: { kind: "claim-invalidated", sourceRunId: "run-3", readyAt: now },
      task: taskRow({
        repoId: repo.id,
        repo,
        runs: [priorRun({ runNumber: 5, maxRunsPerTask: 6, budgetGrants: 1 })],
      }),
      expected: { runNumber: 6, maxRunsPerTask: 6, budgetGrants: 1 },
    },
    {
      intent: { kind: "retry", readyAt: now },
      task: taskRow({ maxSessionsPerTask: 5, runs: [priorRun({ runNumber: 2, budgetGrants: 2 })] }),
      expected: { runNumber: 3, maxRunsPerTask: 7, budgetGrants: 2 },
    },
    {
      intent: { kind: "integrator-authorized", readyAt: now },
      task: taskRow({
        assigneeAgent: agent({ name: "merge-integrator" }),
        repoId: repo.id,
        repo,
        templateStepId: integratorStep.id,
        templateStep: integratorStep,
        maxSessionsPerTask: 3,
        // A historical absolute ceiling of 10 came from an old Task budget.
        // Authorization grants only the next Run against the current budget;
        // it must not carry that opaque old sum forward.
        runs: [priorRun({ runNumber: 3, maxRunsPerTask: 10, budgetGrants: 0 })],
      }),
      expected: { runNumber: 4, maxRunsPerTask: 4, budgetGrants: 1 },
    },
    {
      intent: {
        kind: "retry-after-completion",
        readyAt: now,
        sourceRunId: "run-3",
        sourceMaxRunsPerTask: 5,
        sourceBudgetGrants: 1,
        budgetGrant: 1,
      },
      task: taskRow({ runs: [priorRun()] }),
      expected: { runNumber: 4, maxRunsPerTask: 6, budgetGrants: 2 },
    },
    {
      intent: {
        kind: "retry-after-lease-loss",
        readyAt: now,
        sourceRunId: "run-3",
        sourceMaxRunsPerTask: 5,
        sourceBudgetGrants: 1,
      },
      task: taskRow({ runs: [priorRun()] }),
      expected: { runNumber: 4, maxRunsPerTask: 6, budgetGrants: 2 },
    },
  ];

  for (const item of cases) {
    const locked = item.task.assigneeAgent as ReturnType<typeof agent>;
    const { tx, creates, agentLocks } = fakeTx(item.task, { lockedAgent: locked });
    const opened = await openRun(tx, item.task.id, item.intent);
    assert.equal(opened.ok, true, item.intent.kind);
    assert.equal(agentLocks(), 1, `${item.intent.kind} must take the Agent-row mutex`);
    assert.equal(creates.length, 1, `${item.intent.kind} must create exactly once`);
    assert.deepEqual(
      {
        runNumber: creates[0]?.runNumber,
        maxRunsPerTask: creates[0]?.maxRunsPerTask,
        budgetGrants: creates[0]?.budgetGrants,
      },
      item.expected,
      item.intent.kind,
    );
  }
});

test("enqueueTaskRun's merge-tail option grants one attempt and ordinary enqueue does not", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const task = taskRow({
    repoId: repo.id,
    repo,
    runs: [priorRun({ runNumber: 5, maxRunsPerTask: 5, budgetGrants: 0 })],
  });

  const ordinary = fakeTx(task);
  const ordinaryRun = await enqueueTaskRun(ordinary.tx, task.id, now);
  assert.equal(ordinaryRun.maxRunsPerTask, 5);
  assert.equal(ordinaryRun.budgetGrants, 0);

  const mergeTail = fakeTx(task);
  const mergeTailRun = await enqueueTaskRun(mergeTail.tx, task.id, now, { budgetGrant: 1 });
  assert.equal(mergeTailRun.maxRunsPerTask, 6);
  assert.equal(mergeTailRun.budgetGrants, 1);
});

// §D-P7's ledger half. A refund raises `maxRunsPerTask` and `budgetGrants` by
// construction, so a bound read off either can never be reached: these tests
// pin the count that is kept apart from them, and the one seam that spends it.
test("a platform refund is bounded by the refunds already granted, not by the ceiling they raised", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const leaseLoss = (sourceRunId = "run-3"): OpenRunIntent => ({
    kind: "retry-after-lease-loss",
    readyAt: now,
    sourceRunId,
    sourceMaxRunsPerTask: 5,
    sourceBudgetGrants: 1,
  });

  // Each refund raises the ceiling it is measured against, so the ceiling
  // never refuses. The count does.
  for (const refunds of [0, 1, 2] as const) {
    const task = taskRow({
      repoId: repo.id,
      repo,
      runs: [priorRun({
        repoId: repo.id,
        leaseLossRefunds: refunds,
        maxRunsPerTask: 5 + refunds,
        budgetGrants: refunds,
      })],
    });
    const { tx, creates } = fakeTx(task);
    const opened = await openRun(tx, task.id, leaseLoss());
    assert.equal(opened.ok, true, `refund ${refunds}`);
    assert.equal(creates[0]?.leaseLossRefunds, refunds + 1, `refund ${refunds} increments once`);
  }

  const spent = taskRow({
    repoId: repo.id,
    repo,
    runs: [priorRun({ repoId: repo.id, leaseLossRefunds: LEASE_LOSS_REFUND_CAP, maxRunsPerTask: 8, budgetGrants: 3 })],
  });
  const { tx, creates } = fakeTx(spent);
  const refused = await openRun(tx, spent.id, leaseLoss());
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.refusal.code, "lease-loss-refunds-exhausted");
  assert.equal(creates.length, 0);
});

test("the refund bound is a property of the task, not of the intent kind that reaches it", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const spentPrior = priorRun({
    repoId: repo.id,
    leaseLossRefunds: LEASE_LOSS_REFUND_CAP,
    maxRunsPerTask: 8,
    budgetGrants: 3,
  });
  const refunding: OpenRunIntent[] = [
    { kind: "retry-after-lease-loss", readyAt: now, sourceRunId: "run-3", sourceMaxRunsPerTask: 5, sourceBudgetGrants: 1 },
    { kind: "merge-tail-requeue", readyAt: now, budgetGrant: 1 },
    { kind: "claim-invalidated", sourceRunId: "run-3", readyAt: now },
  ];
  for (const intent of refunding) {
    const task = taskRow({ repoId: repo.id, repo, runs: [spentPrior] });
    const { tx, creates } = fakeTx(task);
    const opened = await openRun(tx, task.id, intent);
    assert.equal(opened.ok, false, intent.kind);
    if (!opened.ok) assert.equal(opened.refusal.code, "lease-loss-refunds-exhausted", intent.kind);
    assert.equal(creates.length, 0, intent.kind);
  }

  // The way out the bound deliberately leaves open: an operator raises the
  // configured budget and asks for the attempt itself. `retry` keeps its own
  // refusal, and it does not spend a refund.
  const raised = taskRow({ repoId: repo.id, repo, maxSessionsPerTask: 9, runs: [spentPrior] });
  const { tx, creates } = fakeTx(raised);
  const retried = await openRun(tx, raised.id, { kind: "retry", readyAt: now });
  assert.equal(retried.ok, true);
  assert.equal(creates[0]?.leaseLossRefunds, LEASE_LOSS_REFUND_CAP);
  assert.equal(creates[0]?.maxRunsPerTask, 12);
});

test("readiness base drift grants a fresh attempt without spending exhausted lease-loss refunds", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const task = taskRow({ repoId: repo.id, repo, runs: [priorRun({
    repoId: repo.id, leaseLossRefunds: LEASE_LOSS_REFUND_CAP, budgetGrants: 3,
  })] });
  const { tx, creates } = fakeTx(task);
  const opened = await openRun(tx, task.id, {
    kind: "merge-tail-requeue", readyAt: now, budgetGrant: 1, readinessBaseDrift: true,
  });
  assert.equal(opened.ok, true);
  assert.equal(creates[0]?.leaseLossRefunds, LEASE_LOSS_REFUND_CAP);
  assert.equal(creates[0]?.budgetGrants, 4);
  assert.equal(creates[0]?.maxRunsPerTask, task.maxSessionsPerTask + 4);
});

test("an ordinary birth carries the task's refund count forward without spending one", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const task = taskRow({
    repoId: repo.id,
    repo,
    runs: [priorRun({ repoId: repo.id, leaseLossRefunds: 2 })],
  });
  const { tx, creates } = fakeTx(task);
  assert.equal((await openRun(tx, task.id, { kind: "enqueue", readyAt: now })).ok, true);
  assert.equal(creates[0]?.leaseLossRefunds, 2);
  // A task that has never been refunded starts at zero rather than at null.
  const fresh = taskRow({ repoId: repo.id, repo });
  const first = fakeTx(fresh);
  assert.equal((await openRun(first.tx, fresh.id, { kind: "task-created", readyAt: now })).ok, true);
  assert.equal(first.creates[0]?.leaseLossRefunds, 0);
});

test("leaseLossRefundAvailable reads the count alone and clamps a negative one", () => {
  assert.equal(LEASE_LOSS_REFUND_CAP, 3);
  assert.deepEqual(
    [-1, 0, 1, 2, 3, 4].map((refunds) => leaseLossRefundAvailable(refunds)),
    [true, true, true, true, false, false],
  );
  assert.equal(leaseLossRefundAvailable(null), true);
  assert.equal(leaseLossRefundAvailable(undefined), true);
});

test("runBudgetCeiling is the only ceiling algorithm and clamps negative grants", () => {
  assert.equal(runBudgetCeiling(5, undefined), 5);
  assert.equal(runBudgetCeiling(5, null), 5);
  assert.equal(runBudgetCeiling(5, -2), 5);
  assert.equal(runBudgetCeiling(5, 3), 8);
});

// §R14. The compound implementation root is a capability, so the predicate is
// tested directly: name is not an input, and the runtime configuration is.
const compoundStep = {
  stepIndex: 5,
  outputKind: "implementation",
  taskTemplate: { name: "compound-engineer-workflow" },
};

const capabilityAgent = (overrides: Record<string, unknown> = {}) => ({
  projectId: "project-1",
  archivedAt: null,
  model: "gpt-6-astra:medium",
  runnerPreference: RunnerPreference.CODEX,
  ...overrides,
}) as { projectId: string; archivedAt: Date | null; model: string; runnerPreference: RunnerPreference };

test("the compound implementation root admits any in-project Codex gpt-* Agent", () => {
  for (const model of ["gpt-6-astra:medium", "gpt-5.6-sol:high", "gpt-5.6-luna:max"]) {
    assert.equal(
      compoundImplementationAssigneeValid("project-1", AssigneeType.AGENT, capabilityAgent({ model }), compoundStep),
      true,
      model,
    );
  }
});

test("the compound implementation root refuses a non-Codex runner, a non-gpt model, and a foreign or archived Agent", () => {
  const refused: Array<[string, Record<string, unknown>]> = [
    ["claude runner", { runnerPreference: RunnerPreference.CLAUDE, model: "claude-opus-5:high" }],
    // A Codex preference does not make a Claude model a gpt-* one.
    ["codex runner on a claude model", { runnerPreference: RunnerPreference.CODEX, model: "claude-opus-5:high" }],
    ["pi runner on a pi-hosted gpt model", { runnerPreference: RunnerPreference.PI, model: "openai-codex/gpt-5.6-sol:high" }],
    ["another project", { projectId: "project-2" }],
    ["archived", { archivedAt: now }],
  ];
  for (const [name, overrides] of refused) {
    assert.equal(
      compoundImplementationAssigneeValid("project-1", AssigneeType.AGENT, capabilityAgent(overrides), compoundStep),
      false,
      name,
    );
  }
  assert.equal(compoundImplementationAssigneeValid("project-1", AssigneeType.HUMAN, capabilityAgent(), compoundStep), false);
  assert.equal(compoundImplementationAssigneeValid("project-1", AssigneeType.AGENT, null, compoundStep), false);
  // Any other step is unconstrained by this rule.
  assert.equal(
    compoundImplementationAssigneeValid("project-1", AssigneeType.AGENT, capabilityAgent({ runnerPreference: RunnerPreference.CLAUDE }), null),
    true,
  );
});

test("INHERIT and AUTO resolve through the same runner authority a Run will use", () => {
  // `runnerFor` decides the CLI for a preference that names none, and it reads
  // the model name — which for a bare `gpt-*` id is CLAUDE. The predicate
  // therefore refuses these, exactly as `deriveRunConfig` would at Run open,
  // rather than admitting an assignment the Run could not honour.
  for (const preference of [RunnerPreference.INHERIT, RunnerPreference.AUTO] as const) {
    assert.equal(codexGptCapability({ model: "gpt-6-astra:medium", runnerPreference: preference }), false, preference);
    // A model the naming rule does route to Codex passes on the same authority.
    assert.equal(codexGptCapability({ model: "gpt-5.6-codex:high", runnerPreference: preference }), true, preference);
  }
  assert.equal(codexGptCapability({ model: "gpt-6-astra:medium", runnerPreference: RunnerPreference.CODEX }), true);
});

// §R5's other half: a retry after failure with a new assignee must run the new
// Agent's configuration, not the snapshot the previous Agent failed with.
const reassignedRetryIntents: OpenRunIntent[] = [
  {
    kind: "retry-after-completion" as const,
    readyAt: now,
    sourceRunId: "run-3",
    sourceMaxRunsPerTask: 5,
    sourceBudgetGrants: 1,
    budgetGrant: 1,
  },
  {
    kind: "retry-after-lease-loss" as const,
    readyAt: now,
    sourceRunId: "run-3",
    sourceMaxRunsPerTask: 5,
    sourceBudgetGrants: 1,
  },
];

for (const intent of reassignedRetryIntents) {
  // A lease-loss retry resumes the source Run's branch; a completion retry
  // opens the next one. Neither depends on who the assignee is.
  const expectedBranch = intent.kind === "retry-after-lease-loss"
    ? "agentos/task-1/run-3"
    : "agentos/task-1/run-4";
  test(`${intent.kind} derives runner, model, service tier and native subagent config from a new assignee`, async () => {
    const successor = agent({
      id: "agent-2",
      name: "plan-executor-astra-medium",
      model: "gpt-6-astra:medium",
      runnerPreference: RunnerPreference.CODEX,
      codexServiceTier: CodexServiceTier.FAST,
    });
    const task = taskRow({
      assigneeAgentId: successor.id,
      assigneeAgent: successor,
      repoId: "repo-1",
      repo: { id: "repo-1", defaultBranch: "main" },
      templateStepId: "implementation-step",
      templateStep: {
        id: "implementation-step",
        stepIndex: 5,
        outputKind: "implementation",
        baseFromStepIndex: null,
        runner: null,
        taskTemplate: { name: "compound-engineer-workflow" },
      },
      runs: [priorRun({ agentId: "agent-1", runner: RunnerKind.CLAUDE, model: "claude-opus-5:high" })],
    });
    const { tx, creates } = fakeTx(task, { lockedAgent: successor });
    const opened = await openRun(tx, "task-1", intent);
    assert.equal(opened.ok, true);
    assert.equal(creates.length, 1);
    assert.deepEqual({
      agentId: creates[0]!.agentId,
      runner: creates[0]!.runner,
      model: creates[0]!.model,
      codexServiceTier: creates[0]!.codexServiceTier,
      subagentModel: creates[0]!.subagentModel,
      subagentMaxConcurrent: creates[0]!.subagentMaxConcurrent,
    }, {
      agentId: "agent-2",
      runner: RunnerKind.CODEX,
      model: "gpt-6-astra:medium",
      codexServiceTier: CodexServiceTier.FAST,
      subagentModel: NATIVE_IMPLEMENTATION_SUBAGENT_MODEL,
      subagentMaxConcurrent: NATIVE_IMPLEMENTATION_SUBAGENT_MAX_CONCURRENT,
    });
    // Only the Agent-derived configuration moves. The branch/target derivation
    // is untouched by the reassignment: it is the same pair the unchanged-
    // assignee case below produces.
    assert.equal(creates[0]!.branch, expectedBranch);
    assert.equal(creates[0]!.targetBranch, "main");
  });

  test(`${intent.kind} still preserves the prior configuration when the assignee is unchanged`, async () => {
    const unchanged = agent({ model: "gpt-6-astra:medium", runnerPreference: RunnerPreference.CODEX });
    const task = taskRow({
      assigneeAgent: unchanged,
      repoId: "repo-1",
      repo: { id: "repo-1", defaultBranch: "main" },
      runs: [priorRun({ agentId: "agent-1", runner: RunnerKind.CLAUDE, model: "claude-opus-5:high" })],
    });
    const { tx, creates } = fakeTx(task, { lockedAgent: unchanged });
    const opened = await openRun(tx, "task-1", intent);
    assert.equal(opened.ok, true);
    assert.equal(creates[0]!.runner, RunnerKind.CLAUDE);
    assert.equal(creates[0]!.model, "claude-opus-5:high");
    assert.equal(creates[0]!.branch, expectedBranch);
    assert.equal(creates[0]!.targetBranch, "main");
  });
}

test("terminal refund grants and replacement birth use the same source Run", async () => {
  for (const refunds of [0, 1, 2, 3]) {
    const source = priorRun({ leaseLossRefunds: refunds, maxRunsPerTask: 1 + refunds, budgetGrants: refunds });
    const decision = leaseLossRefundDecision(source, source.id);
    const task = taskRow({ repoId: "repo-1", repo: { id: "repo-1", defaultBranch: "main" }, runs: [source] });
    const { tx, creates } = fakeTx(task);
    const result = await openRun(tx, task.id, {
      kind: "retry-after-lease-loss", sourceRunId: decision.sourceRunId, readyAt: now,
      sourceMaxRunsPerTask: source.maxRunsPerTask, sourceBudgetGrants: source.budgetGrants,
    });
    assert.equal(result.ok, decision.refundAvailable);
    if (result.ok) {
      assert.equal(creates[0]?.maxRunsPerTask, decision.maxRunsPerTask);
      assert.equal(creates[0]?.budgetGrants, decision.budgetGrants);
    } else {
      assert.equal(decision.maxRunsPerTask, source.maxRunsPerTask);
      assert.equal(decision.budgetGrants, source.budgetGrants);
    }
    // Claim invalidation records the grant before birth reads the same row.
    const revoked = { ...source, maxRunsPerTask: decision.maxRunsPerTask, budgetGrants: decision.budgetGrants };
    const claimTask = taskRow({ ...task, maxSessionsPerTask: 1, runs: [revoked] });
    const claimTx = fakeTx(claimTask);
    const claimBirth = await openRun(claimTx.tx, claimTask.id, {
      kind: "claim-invalidated", sourceRunId: decision.sourceRunId, readyAt: now,
    });
    assert.equal(claimBirth.ok, decision.refundAvailable);
    if (claimBirth.ok) {
      assert.equal(claimTx.creates[0]?.maxRunsPerTask, decision.maxRunsPerTask);
      assert.equal(claimTx.creates[0]?.budgetGrants, decision.budgetGrants);
      assert.equal(claimTx.creates[0]?.leaseLossRefunds, refunds + 1);
    }
  }
  const task = taskRow({ repoId: "repo-1", repo: { id: "repo-1", defaultBranch: "main" }, runs: [priorRun()] });
  const { tx, creates } = fakeTx(task);
  const stale = await openRun(tx, task.id, { kind: "claim-invalidated", sourceRunId: "older-run", readyAt: now });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.refusal.code, "source-run-stale");
  assert.equal(creates.length, 0);
});

test("a terminalized source cannot record a refund belonging to a newer Run", () => {
  const source = priorRun({ leaseLossRefunds: 0 });
  const decision = leaseLossRefundDecision(source, "newer-run");
  assert.equal(decision.refundAvailable, false);
  assert.equal(decision.maxRunsPerTask, source.maxRunsPerTask);
  assert.equal(decision.budgetGrants, source.budgetGrants);
});

test("completed merge-tail repairs grant verification attempts without spending loss refunds", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  for (const runNumber of [1, 2, 3, 4, 5]) {
    const task = taskRow({ repoId: repo.id, repo, runs: [priorRun({
      repoId: repo.id, runNumber, budgetGrants: runNumber - 1,
      leaseLossRefunds: LEASE_LOSS_REFUND_CAP,
    })] });
    const { tx, creates } = fakeTx(task);
    const opened = await enqueueTaskRun(tx, task.id, now, {
      budgetGrant: 1, repairCompleted: true,
    });
    assert.equal(opened.runNumber, runNumber + 1, `repair ${runNumber}`);
    assert.equal(creates[0]?.budgetGrants, runNumber);
    assert.equal(creates[0]?.leaseLossRefunds, LEASE_LOSS_REFUND_CAP);
  }
});

test("a spend cap refuses every replacement intent, loudly, once the task's runs have reached it", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const task = taskRow({
    repoId: repo.id,
    repo,
    spendCap: new Prisma.Decimal("1.00"),
    runs: [priorRun({ repoId: repo.id })],
  });
  // Every intent that replaces an attempt, not just the operator's `retry`:
  // the previous budget bound was escaped precisely by arriving as a different
  // intent kind.
  const replacements: OpenRunIntent[] = [
    { kind: "enqueue", readyAt: now },
    { kind: "retry", readyAt: now },
    { kind: "merge-tail-requeue", readyAt: now, budgetGrant: 1 },
    { kind: "merge-tail-repair", readyAt: now },
    { kind: "claim-invalidated", sourceRunId: "run-3", readyAt: now },
    {
      kind: "retry-after-completion",
      readyAt: now,
      sourceRunId: "run-3",
      sourceMaxRunsPerTask: 5,
      sourceBudgetGrants: 1,
      budgetGrant: 1,
    },
    {
      kind: "retry-after-lease-loss",
      readyAt: now,
      sourceRunId: "run-3",
      sourceMaxRunsPerTask: 5,
      sourceBudgetGrants: 1,
    },
  ];

  for (const intent of replacements) {
    const { tx, creates, activities, taskUpdates } = fakeTx(task, {
      costedRuns: [costedRun("0.75"), costedRun("0.75")],
    });
    const opened = await openRun(tx, task.id, intent);

    assert.equal(opened.ok, false, intent.kind);
    if (opened.ok) return;
    assert.equal(opened.refusal.code, "spend-cap-exhausted", intent.kind);
    assert.equal(creates.length, 0, `${intent.kind} must not open a Run`);
    assert.equal(
      opened.refusal.message,
      "Spend cap $1.00 reached: $1.50 spent across 2 runs;"
        + " raise or clear spendCap to continue",
      intent.kind,
    );
    // The consequence belongs to the caller, as it does for every other code:
    // `attemptRunBirth` rolls the birth back to a savepoint, so a park written
    // here would not survive on the paths that use it and would be written
    // twice on the ones that write their own.
    assert.equal(taskUpdates.length, 0, `${intent.kind} must not park the task itself`);
    assert.equal(activities.length, 0, `${intent.kind} must not write its own activity`);
  }
});

test("the park a raising caller owes a spend-cap refusal names the cap and the total", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const task = taskRow({
    repoId: repo.id,
    repo,
    spendCap: new Prisma.Decimal("1.00"),
    runs: [priorRun({ repoId: repo.id })],
  });
  const { tx, activities, taskUpdates } = fakeTx(task, { costedRuns: [costedRun("1.50")] });
  const opened = await openRun(tx, task.id, { kind: "retry", readyAt: now });
  assert.equal(opened.ok, false);
  if (opened.ok) return;

  // Only this code is parked rather than raised. Every other refusal either
  // belongs to a caller that already parks it or is an invariant failure.
  assert.equal(parksInsteadOfRaising(opened.refusal), true);
  await recordRunBirthRefusal(tx, task.id, opened.refusal);
  assert.equal(taskUpdates.length, 1);
  assert.equal(taskUpdates[0]?.status, "REVIEW");
  assert.equal(
    taskUpdates[0]?.failureReason,
    "Spend cap $1.00 reached: $1.50 spent across 1 run; raise or clear spendCap to continue",
  );
  assert.equal(activities.length, 1);
  assert.equal(
    activities[0]?.body,
    "Run birth refused: Spend cap $1.00 reached: $1.50 spent across 1 run;"
      + " raise or clear spendCap to continue",
  );
  // Named, not merely prose: this is what an operator filters the REVIEW by,
  // and it carries the refusal's own detail so the cap and the total are
  // readable as data, in the same money rendering as the message.
  assert.deepEqual(activities[0]?.metadata, {
    refusal: "spend-cap-exhausted",
    spendCapUsd: "1.00",
    spentUsd: "1.50",
    runs: 1,
  });
  // The callers that write a park of their own — the automatic lease-loss and
  // after-completion retries, the chain activations, the merge-tail requeue,
  // the claim-invalidation replacement and the scheduler — name the refusal
  // through the same builder, so an operator reads the same cap and total
  // whichever intent was refused.
  assert.deepEqual(runBirthRefusalMetadata(opened.refusal), activities[0]?.metadata);
});

/**
 * The park's shape is decided in one place, and only the spend cap widens it.
 * Every other refusal keeps the exact `{ refusal }` each caller recorded before
 * the cap existed, so adding a `detail` to a refusal for its message or its
 * error never silently reshapes an activity an operator or a test reads.
 */
test("only the spend-cap park carries detail; every other refusal is its code alone", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };

  // A refusal that carries `detail` of its own and is not the spend cap.
  const lostTask = taskRow({
    repoId: repo.id,
    repo,
    runs: [priorRun({ repoId: repo.id, leaseLossRefunds: 3 })],
  });
  const lost = await openRun(fakeTx(lostTask).tx, lostTask.id, {
    kind: "retry-after-lease-loss",
    readyAt: now,
    sourceRunId: "run-3",
    sourceMaxRunsPerTask: 5,
    sourceBudgetGrants: 1,
  });
  assert.equal(lost.ok, false);
  if (lost.ok) return;
  assert.deepEqual(lost.refusal.detail, { leaseLossRefunds: 3, cap: 3 });
  assert.deepEqual(runBirthRefusalMetadata(lost.refusal), {
    refusal: "lease-loss-refunds-exhausted",
  });

  const cappedTask = taskRow({
    repoId: repo.id,
    repo,
    spendCap: new Prisma.Decimal("1.00"),
    runs: [priorRun({ repoId: repo.id })],
  });
  const capped = await openRun(
    fakeTx(cappedTask, { costedRuns: [costedRun("1.50")] }).tx,
    cappedTask.id,
    { kind: "retry", readyAt: now },
  );
  assert.equal(capped.ok, false);
  if (capped.ok) return;
  assert.deepEqual(runBirthRefusalMetadata(capped.refusal), {
    refusal: "spend-cap-exhausted",
    spendCapUsd: "1.00",
    spentUsd: "1.50",
    runs: 1,
  });
});

test("the spend basis counts reported and estimated run cost, and a raised cap queues again", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const capped = (spendCap: string) => taskRow({
    repoId: repo.id,
    repo,
    spendCap: new Prisma.Decimal(spendCap),
    runs: [priorRun({ repoId: repo.id })],
  });
  // 1M input tokens with 0 cached and 100k output at the claude-opus-5 rates:
  // $5 + $2.5 = $7.50, priced at read time because no amount was reported.
  const estimated = costedRun(null, {
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 100_000,
  });
  // An unpriced Run is unknown, not expensive: it contributes nothing.
  const unpriced = costedRun(null);

  const belowCap = fakeTx(capped("10.00"), { costedRuns: [estimated, unpriced, costedRun("2.00")] });
  const opened = await openRun(belowCap.tx, "task-1", { kind: "retry", readyAt: now });
  assert.equal(opened.ok, true);
  assert.equal(belowCap.creates.length, 1);
  assert.equal(belowCap.taskUpdates.length, 0);

  const atCap = fakeTx(capped("9.50"), { costedRuns: [estimated, unpriced, costedRun("2.00")] });
  const refused = await openRun(atCap.tx, "task-1", { kind: "retry", readyAt: now });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.refusal.code, "spend-cap-exhausted");

  // A task with no cap never asks what it has spent.
  const uncapped = fakeTx(taskRow({ repoId: repo.id, repo, runs: [priorRun({ repoId: repo.id })] }), {
    costedRuns: [costedRun("999.00")],
  });
  const uncappedOpen = await openRun(uncapped.tx, "task-1", { kind: "retry", readyAt: now });
  assert.equal(uncappedOpen.ok, true);
});

test("a held chain outranks the spend cap, so a hold never parks a task in REVIEW", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const task = taskRow({
    repoId: repo.id,
    repo,
    chainId: "chain-1",
    chainIndex: 2,
    chainLayer: 2,
    spendCap: new Prisma.Decimal("1.00"),
  });
  const { tx, taskUpdates } = fakeTx(task, {
    costedRuns: [costedRun("5.00")],
    chainControlRows: [{
      projectId: "project-1",
      chainId: "chain-1",
      state: ChainControlState.HELD,
      heldLayer: 1,
      heldAt: now,
      holdRequestId: "hold-1",
      holdReason: "operator hold",
      releasedAt: null,
      releaseRequestId: null,
      holdGeneration: 1,
    }],
  });

  const opened = await openRun(tx, task.id, { kind: "enqueue", readyAt: now });

  assert.equal(opened.ok, false);
  if (!opened.ok) assert.equal(opened.refusal.code, "chain-held");
  assert.equal(taskUpdates.length, 0);
});
