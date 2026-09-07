import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CleanupStatus,
  EXTERNAL_FAILURE_REFUND_CAP,
  FailureClass,
  PushStatus,
  RunStatus,
  type PrismaClient,
  type FailureEnvelope,
  type RunOutcome,
  runOutcomeVerdict,
} from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";
import { z } from "zod";

import { classifyEnvelope } from "./execution.js";
import {
  completionBudgetAfterRefund,
  completionEvidenceRefusal,
  completionInput,
  completionOutputFailurePolicy,
  completeRun,
  externalFailureRefundDecision,
} from "./run-completion.js";

const baseSha = "5".repeat(40);

test("the completion input schema references the shared contract version", () => {
  assert.equal(completionInput.description, `Run completion contract version ${RUN_COMPLETION_CONTRACT_VERSION}`);
});

test("the completion input shape is pinned to its shared contract version", () => {
  const schemaHash = createHash("sha256")
    .update(JSON.stringify(z.toJSONSchema(completionInput, { unrepresentable: "any" })))
    .digest("hex");
  const schemaHashesByVersion: Record<number, string> = {
    1: "fb27fe3f07d0dce703452f1706186bfe61521eb3bcd41fad9d193b51876ad9b7",
    2: "f5011d9c1544cfa944e5de207d3bd045e3a221eced953677051f4317bae886c7",
  };

  assert.equal(schemaHash, schemaHashesByVersion[RUN_COMPLETION_CONTRACT_VERSION]);
});

const implementationStep = {
  outputKind: "implementation",
  requiresCommit: true,
  taskTemplate: { name: "direct-engineer-workflow" },
};

const continuation = (overrides: Record<string, unknown> = {}) => ({
  id: "run-2",
  runNumber: 2,
  maxRunsPerTask: 2,
  requiresCommit: false,
  opensPullRequest: true,
  baseSha,
  task: { templateStep: implementationStep },
  ...overrides,
});

const implementationOutput = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-2",
  kind: "implementation",
  body: JSON.stringify({
    schemaVersion: 1,
    headSha: baseSha,
    baseSha,
    summary: "The salvaged base already delivers the brief.",
    testsRun: ["focused"],
  }),
  commitSha: baseSha,
  metadata: {},
  ...overrides,
});

test("an unchanged relaxed Run completes SUCCEEDED only with canonical implementation evidence", () => {
  const run = continuation();

  assert.equal(completionEvidenceRefusal(run, true, baseSha, implementationOutput()), null);
  assert.equal(
    completionEvidenceRefusal(run, true, baseSha, null),
    "missing implementation task output for current Run run-2",
  );
});

test("a manual own-publication continuation cannot clean-exit without implementation evidence", () => {
  const run = continuation({ task: { templateStep: null } });

  assert.equal(
    completionEvidenceRefusal(run, true, baseSha, null),
    "missing implementation task output for current Run run-2",
  );
  assert.equal(
    completionEvidenceRefusal(run, true, baseSha, implementationOutput({ kind: "result" })),
    "task output kind result does not match canonical kind implementation",
  );
});

test("a configured non-committing Step keeps its ordinary completion semantics", () => {
  const run = continuation({
    opensPullRequest: false,
    task: {
      templateStep: {
        outputKind: "regression-verification-v2",
        requiresCommit: false,
        taskTemplate: { name: "direct-engineer-workflow" },
      },
    },
  });

  assert.equal(completionEvidenceRefusal(run, true, baseSha, null), null);
});

test("three capped external failures refund the task and the fourth records the cap", () => {
  let cappedRefunds = 0;
  let completionBudget = { maxRunsPerTask: 1, budgetGrants: 0 };

  for (let runNumber = 1; runNumber <= EXTERNAL_FAILURE_REFUND_CAP; runNumber += 1) {
    const decision = externalFailureRefundDecision({
      runNumber,
      external: true,
      refundable: true,
      mechanical: false,
      capped: true,
      priorCappedRefunds: cappedRefunds,
    });
    assert.equal(decision.refunded, 1);
    assert.equal(decision.capReached, false);
    assert.match(decision.activity?.body ?? "", new RegExp(`${runNumber} of ${EXTERNAL_FAILURE_REFUND_CAP}`));
    cappedRefunds += decision.refunded;
    completionBudget = completionBudgetAfterRefund(
      completionBudget.maxRunsPerTask,
      completionBudget.budgetGrants,
      decision.refunded,
    );
    assert.equal(completionBudget.budgetGrants, runNumber);
    assert.equal(completionBudget.maxRunsPerTask, runNumber + 1);
  }

  assert.equal(completionBudget.budgetGrants, EXTERNAL_FAILURE_REFUND_CAP);
  const fourth = externalFailureRefundDecision({
    runNumber: EXTERNAL_FAILURE_REFUND_CAP + 1,
    external: true,
    refundable: true,
    mechanical: false,
    capped: true,
    priorCappedRefunds: cappedRefunds,
  });
  assert.equal(fourth.refunded, 0);
  assert.equal(fourth.capReached, true);
  assert.match(fourth.activity?.body ?? "", /external-failure refund cap was reached/i);
  assert.deepEqual(
    completionBudgetAfterRefund(
      completionBudget.maxRunsPerTask,
      completionBudget.budgetGrants,
      fourth.refunded,
    ),
    completionBudget,
  );
});

test("legacy external refunds do not consume the capped allowance", () => {
  const decision = externalFailureRefundDecision({
    runNumber: 8,
    external: true,
    refundable: true,
    mechanical: false,
    capped: false,
    priorCappedRefunds: EXTERNAL_FAILURE_REFUND_CAP,
  });
  assert.equal(decision.refunded, 1);
  assert.equal(decision.capReached, false);
  assert.equal(decision.activity?.metadata.policy, "uncapped");
});

test("ineligible and mechanical failures never receive a refund", () => {
  for (const input of [
    { refundable: false, mechanical: false },
    { refundable: true, mechanical: true },
  ]) {
    const decision = externalFailureRefundDecision({
      runNumber: 2,
      external: true,
      capped: false,
      priorCappedRefunds: 0,
      ...input,
    });
    assert.equal(decision.refunded, 0);
    assert.equal(decision.activity?.metadata.granted, false);
  }
});

test("a Regression target-fetch block keeps its git diagnostic and is externally refundable", () => {
  const policy = completionOutputFailurePolicy({
    outputKind: "regression-verification-v2",
    outcome: {
      case: "required-output-unsatisfied",
      reason: "A step finished without a handoff [target-fetch-failed]: fatal: could not read Username for 'https://github.com'",
    },
  });
  assert.equal(policy.externalFailure, true);
  assert.equal(policy.cappedExternalFailure, true);
});

test("a legacy Regression target-fetch text remains non-external", () => {
  const policy = completionOutputFailurePolicy({
    outputKind: "regression-verification",
    outcome: {
      case: "required-output-unsatisfied",
      reason: "A step finished without a handoff [target-fetch-failed]: fatal: could not read Username",
    },
  });

  assert.equal(policy.externalFailure, false);
  assert.equal(policy.cappedExternalFailure, false);
});

test("an ordinary missing-output refusal remains non-external", () => {
  const policy = completionOutputFailurePolicy({
    outputKind: "implementation",
    outcome: {
      case: "required-output-unsatisfied",
      reason: "A step finished without a handoff",
    },
  });
  assert.equal(policy.externalFailure, false);
  assert.equal(policy.cappedExternalFailure, false);
});

type RecordedActivity = { taskId: string; actorType?: string; body: string; metadata?: Record<string, unknown> };
type MetadataClause = { metadata?: { path?: unknown; equals?: unknown } };
type HarnessRun = Record<string, unknown> & { id: string; fencingToken: string };

const statefulCompletionHarness = (
  taskOverrides: Record<string, unknown> = {},
  persistedOutput: Record<string, unknown> | null = null,
) => {
  const activities: RecordedActivity[] = [];
  const closedRuns = new Map<string, Record<string, unknown>>();
  const taskUpdates: Record<string, unknown>[] = [];
  const archivedAt = new Date("2026-08-16T06:00:00.000Z");
  let currentRun: HarnessRun;

  const task = {
    id: "task-refunds", projectId: "project-1", name: "Refund cap", description: "test",
    assigneeType: "AGENT", assigneeAgentId: "agent-1",
    assigneeAgent: { id: "agent-1", name: "Archived test agent", archivedAt },
    repoId: "repo-1", repo: null, chainId: null, chainIndex: null, chainLayer: null,
    templateId: null, templateStepId: null, templateStep: null as Record<string, unknown> | null,
    targetBranch: "main", opensPullRequest: true, maxDurationMin: 120, stallTimeoutMin: 10,
    maxSessionsPerTask: 1, status: "DOING", archivedAt: null, approvalGate: false,
    ...taskOverrides,
  };

  const metadataMatches = (metadata: Record<string, unknown> | undefined, clause: MetadataClause): boolean => {
    const filter = clause.metadata;
    if (!filter || !Array.isArray(filter.path)) return true;
    let value: unknown = metadata;
    for (const part of filter.path) value = (value as Record<string, unknown> | undefined)?.[String(part)];
    return value === filter.equals;
  };
  const tx = {
    $queryRaw: async () => [{ id: task.id }],
    run: {
      findFirst: async () => currentRun,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(currentRun, data);
        closedRuns.set(currentRun.id, { ...currentRun });
        return { count: 1 };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "unexpected-retry", ...data }),
    },
    agent: { findUnique: async () => task.assigneeAgent },
    session: { update: async () => ({}) },
    task: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        taskUpdates.push(data);
        Object.assign(task, data);
        return { count: 1 };
      },
      findUnique: async () => ({ ...task, runs: [{ ...currentRun, task: undefined, session: undefined }] }),
      findUniqueOrThrow: async () => ({ ...task, runs: [{ ...currentRun, task: undefined, session: undefined }] }),
    },
    taskStepOutput: { findUnique: async () => persistedOutput },
    taskActivity: {
      findMany: async ({ where, take }: { where: { taskId: string }; take?: number }) => activities
        .filter((activity) => activity.taskId === where.taskId).reverse().slice(0, take),
      findFirst: async ({ where }: { where: MetadataClause & { taskId: string; actorType?: string } }) => activities
        .filter((activity) => activity.taskId === where.taskId
          && (!where.actorType || activity.actorType === where.actorType)
          && metadataMatches(activity.metadata, where)).at(-1) ?? null,
      count: async ({ where }: { where: { taskId: string; AND?: MetadataClause[] } }) => activities.filter((activity) =>
        activity.taskId === where.taskId
        && (where.AND ?? []).every((clause) => metadataMatches(activity.metadata, clause))).length,
      create: async ({ data }: { data: RecordedActivity }) => { activities.push(data); return data; },
    },
    runnerBackendState: { upsert: async () => ({ consecutiveAuthFailures: 0 }), update: async () => ({}) },
    inboxMessage: { create: async () => ({}) },
  };
  const database = {
    $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation(tx),
    run: { findUnique: async () => ({ runnerId: "runner-1", task: { templateStep: task.templateStep } }) },
  } as unknown as PrismaClient;

  const complete = async ({
    runNumber,
    maxRunsPerTask,
    budgetGrants,
    outcome,
    templateStep = null,
    headSha,
    runHeadSha,
  }: {
    runNumber: number;
    maxRunsPerTask: number;
    budgetGrants: number;
    outcome: RunOutcome;
    templateStep?: Record<string, unknown> | null;
    headSha?: string;
    runHeadSha?: string;
  }) => {
    task.templateStep = templateStep;
    currentRun = {
      id: `run-${runNumber}`, projectId: task.projectId, taskId: task.id, goalId: null,
      agentId: task.assigneeAgentId, repoId: task.repoId, runNumber, maxRunsPerTask, budgetGrants,
      runner: "CODEX", model: "gpt-5.6-sol:high", targetBranch: "main", branch: "feat/refunds",
      headSha: runHeadSha, pushedBranch: null, baseSha: null, runnerId: "runner-1", fencingToken: `fence-${runNumber}`,
      requiresCommit: false, opensPullRequest: task.opensPullRequest, codexServiceTier: "DEFAULT",
      subagentModel: null, subagentMaxConcurrent: null, promptHash: "hash",
      maxDurationMin: 120, stallTimeoutMin: 10, task: { ...task }, session: { id: `session-${runNumber}` },
      status: RunStatus.RUNNING,
    };
    const result = await completeRun(database, {
      runId: currentRun.id,
      claimantClass: "runner",
      body: {
        runnerId: "runner-1",
        fencingToken: currentRun.fencingToken,
        outcome,
        headSha,
        exitCode: outcome.case === "succeeded" ? 0 : 1,
        pushStatus: PushStatus.NOT_REQUESTED,
        cleanupStatus: CleanupStatus.SUCCEEDED,
        workspaceRetained: false,
      },
    });
    assert.ok(result && !("reason" in result));
    return closedRuns.get(currentRun.id)!;
  };

  return { activities, complete, taskUpdates };
};

for (const state of ["settled", "aborted"]) {
  for (const actorType of ["agent", "control-plane"]) {
    test(`completeRun ${actorType === "agent" ? "ignores agent-authored" : "preserves control-plane"} ${state} train settlement`, async () => {
      const status = actorType === "agent" ? "DOING" : state === "settled" ? "DONE" : "REVIEW";
      const harness = statefulCompletionHarness({ opensPullRequest: false, status });
      harness.activities.push({
        taskId: "task-refunds", actorType: "control-plane", body: "Train queued",
        metadata: { kind: "mergeTail.train", schemaVersion: 1, trainTaskId: "task-refunds", state: "queued" },
      }, {
        taskId: "task-refunds", actorType, body: "Marker-shaped settlement",
        metadata: { kind: "mergeTail.train", schemaVersion: 1, trainTaskId: "task-refunds", state },
      });
      const closed = await harness.complete({
        runNumber: 1, maxRunsPerTask: 1, budgetGrants: 0, outcome: { case: "succeeded" },
      });
      assert.equal(closed.status, RunStatus.SUCCEEDED);
      if (actorType === "agent") {
        assert.deepEqual(harness.taskUpdates, [{ status: "REVIEW", failureReason: null }]);
        assert.match(harness.activities.at(-1)!.body, /task moved to review/);
      } else {
        assert.deepEqual(harness.taskUpdates, []);
        assert.match(harness.activities.at(-1)!.body, /merge train settlement already decided this card/);
      }
    });
  }
}

test("completeRun preserves a control-plane train settlement buried under session activity", async () => {
  const harness = statefulCompletionHarness({ opensPullRequest: false, status: "DONE" });
  harness.activities.push({
    taskId: "task-refunds", actorType: "control-plane", body: "Train settled",
    metadata: { kind: "mergeTail.train", schemaVersion: 1, trainTaskId: "task-refunds", state: "settled" },
  }, ...Array.from({ length: 25 }, () => ({
    taskId: "task-refunds", actorType: "agent", body: "Session progress",
  })), {
    taskId: "task-refunds", actorType: "agent", body: "Forged train state",
    metadata: { kind: "mergeTail.train", schemaVersion: 1, trainTaskId: "task-refunds", state: "queued" },
  });
  const closed = await harness.complete({
    runNumber: 1, maxRunsPerTask: 1, budgetGrants: 0, outcome: { case: "succeeded" },
  });
  assert.equal(closed.status, RunStatus.SUCCEEDED);
  assert.deepEqual(harness.taskUpdates, []);
  assert.match(harness.activities.at(-1)!.body, /merge train settlement already decided this card/);
});

const fetchFailureOutcome = (): RunOutcome => ({
  case: "provider-failure",
  reason: "fetch failed",
  envelope: {
    version: 1, phase: "EXECUTE", runnerClass: null, exitCode: 0, signal: null,
    terminationReason: null, terminalEventSeen: true, terminalSuccess: false, agentExited: true,
    providerError: null, stderrSummary: "fetch failed", stdoutSummary: null, timedOut: false,
    transient: false, timeoutMs: null,
  },
});

test("completeRun persists three capped refunds and refuses the fourth", async () => {
  const harness = statefulCompletionHarness();
  let budget = { maxRunsPerTask: 1, budgetGrants: 0 };
  for (let runNumber = 1; runNumber <= EXTERNAL_FAILURE_REFUND_CAP + 1; runNumber += 1) {
    const closed = await harness.complete({ runNumber, ...budget, outcome: fetchFailureOutcome() });
    const expectedGrants = Math.min(runNumber, EXTERNAL_FAILURE_REFUND_CAP);
    assert.equal(closed.budgetGrants, expectedGrants);
    assert.equal(closed.maxRunsPerTask, 1 + expectedGrants);
    budget = { maxRunsPerTask: Number(closed.maxRunsPerTask), budgetGrants: Number(closed.budgetGrants) };
  }
  assert.equal(harness.activities.filter(({ metadata }) => metadata?.kind === "externalFailureRefund.granted").length, 3);
  assert.match(harness.activities.find(({ metadata }) => metadata?.capReached === true)?.body ?? "", /refund cap was reached/i);
});

test("completeRun refunds a target-fetch block and preserves its git diagnostic", async () => {
  const harness = statefulCompletionHarness();
  const reason = "A step finished without a handoff [target-fetch-failed]: fatal: could not read Username";
  const closed = await harness.complete({
    runNumber: 1,
    maxRunsPerTask: 1,
    budgetGrants: 0,
    outcome: { case: "required-output-unsatisfied", reason },
    templateStep: {
      outputKind: "regression-verification-v2", requiresCommit: false,
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  });
  assert.equal(closed.budgetGrants, 1);
  assert.equal(closed.failureReason, reason);
});

test("completeRun neither refunds nor rewrites an ordinary missing-output refusal", async () => {
  const harness = statefulCompletionHarness();
  const closed = await harness.complete({
    runNumber: 1,
    maxRunsPerTask: 2,
    budgetGrants: 0,
    outcome: { case: "succeeded" },
    templateStep: {
      outputKind: "implementation", requiresCommit: true,
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  });
  assert.equal(closed.budgetGrants, 0);
  assert.equal(closed.failureReason, "missing implementation task output for current Run run-1");
});

// --- Run outcome -----------------------------------------------------------
//
// One row per case. No git remote, no shell agent, no control-plane double:
// the sentence "this Run's outcome is X" is decided by the runner and read
// here, so reading it is a pure function and its table is the whole contract.
// Before this, the same verdict was assembled from thirteen locals in
// `executeClaim`, encoded as seven wire fields, and re-derived by roughly
// thirty branch sites in `completeRun` — and the only way to test any of it was
// to boot a real agent and assert `completions.at(-1).failureClass`.

const envelope = (overrides: Partial<FailureEnvelope> = {}): FailureEnvelope => ({
  version: 1,
  phase: "EXECUTE",
  runnerClass: null,
  exitCode: 1,
  signal: null,
  terminationReason: null,
  terminalEventSeen: true,
  terminalSuccess: false,
  agentExited: true,
  providerError: null,
  stderrSummary: "the agent reported a failure",
  stdoutSummary: null,
  timedOut: false,
  transient: false,
  timeoutMs: null,
  ...overrides,
});

const verdictOf = (outcome: RunOutcome) => runOutcomeVerdict(outcome, classifyEnvelope);

const outcomeRows: ReadonlyArray<{
  name: string;
  outcome: RunOutcome;
  succeeded: boolean;
  failureClass: FailureClass | null;
  retryable: boolean;
  externalFailure: boolean;
  timedOut: boolean;
}> = [
  {
    name: "an agent that exited cleanly",
    outcome: { case: "succeeded" },
    succeeded: true, failureClass: null, retryable: false, externalFailure: false, timedOut: false,
  },
  {
    name: "a Regression whose fenced mechanical handoff is the step's product",
    outcome: { case: "regression-mechanically-settled" },
    succeeded: true, failureClass: null, retryable: false, externalFailure: false, timedOut: false,
  },
  {
    name: "a provider that dropped after the server already held this Run's output",
    outcome: { case: "delivered-then-disconnected" },
    succeeded: true, failureClass: null, retryable: false, externalFailure: false, timedOut: false,
  },
  {
    name: "a walltime budget kill",
    outcome: { case: "budget-exhausted", gate: "walltime", reason: "walltime: walltime budget exceeded" },
    succeeded: false,
    failureClass: FailureClass.BUDGET_EXCEEDED,
    // Retrying into the ceiling, or raising it for exceeding it, is an
    // unbounded loop either way.
    retryable: false, externalFailure: false, timedOut: true,
  },
  {
    name: "a run-count budget refusal before launch",
    outcome: { case: "budget-exhausted", gate: "max-runs", reason: "Maximum run budget exceeded before launch" },
    succeeded: false,
    failureClass: FailureClass.BUDGET_EXCEEDED,
    retryable: false, externalFailure: false,
    // Not a clock, so not TIMED_OUT. This used to be decided by looking for the
    // substrings "walltime" and "stall" inside the runner's own prose.
    timedOut: false,
  },
  {
    name: "a required deliverable the Run never persisted",
    outcome: { case: "required-output-unsatisfied", reason: "finished without persisting implementation output" },
    succeeded: false,
    failureClass: FailureClass.PROTOCOL_ERROR,
    // The next attempt can still author it, and the absent deliverable is the
    // agent's own attempt, so it spends the attempt.
    retryable: true, externalFailure: false, timedOut: false,
  },
  {
    name: "an output status the control plane could not establish",
    outcome: { case: "terminal-protocol-failure", reason: "Task output status could not be established" },
    succeeded: false,
    failureClass: FailureClass.PROTOCOL_ERROR,
    // Re-asking a question that did not answer is not a repair. The runner used
    // to spell this by omitting the failure envelope entirely.
    retryable: false, externalFailure: false, timedOut: false,
  },
  {
    name: "an agent failure classified from its envelope",
    outcome: { case: "provider-failure", reason: "the agent reported a failure", envelope: envelope() },
    succeeded: false,
    failureClass: FailureClass.TASK_FAILED,
    retryable: false, externalFailure: false, timedOut: false,
  },
  {
    name: "a clone that failed before the agent started",
    outcome: {
      case: "provider-failure",
      reason: "git failed (128)",
      envelope: envelope({ phase: "PROVISION", agentExited: false, terminationReason: "runner exception" }),
    },
    succeeded: false,
    failureClass: FailureClass.TASK_FAILED,
    // The runner's plumbing failed, so the attempt buys the task one instead of
    // spending one. `agentExited` says that, not a flag the runner asserts.
    retryable: false, externalFailure: true, timedOut: false,
  },
  {
    name: "a hung push, which the envelope types as a timeout its text does not name",
    outcome: {
      case: "provider-failure",
      reason: "git push timed out after 6000ms",
      envelope: envelope({
        phase: "DELIVER",
        runnerClass: FailureClass.TOOL_FAILED,
        exitCode: 0,
        terminalSuccess: true,
        timedOut: true,
        transient: true,
        timeoutMs: 6000,
        stderrSummary: "git push timed out after 6000ms; its process group was killed",
      }),
    },
    succeeded: false,
    failureClass: FailureClass.TRANSIENT_PROVIDER,
    retryable: true, externalFailure: true, timedOut: false,
  },
];

for (const row of outcomeRows) {
  test(`the outcome of ${row.name}`, () => {
    const verdict = verdictOf(row.outcome);
    assert.equal(verdict.succeeded, row.succeeded);
    assert.equal(verdict.failureClass, row.failureClass);
    assert.equal(verdict.retryable, row.retryable);
    assert.equal(verdict.externalFailure, row.externalFailure);
    assert.equal(verdict.timedOut, row.timedOut);
    assert.equal(
      verdict.failureReason === null,
      row.succeeded,
      "a reason is present exactly when the Run failed",
    );
  });
}

test("a delivery failure is not read as an agent that exited without finishing", () => {
  // The agent's own clean exit rides on a DELIVER envelope, and "exit 0 with no
  // successful terminal event" is a statement about the agent process. Reading
  // it here is what forced the runner to overwrite `terminalEventSeen` and
  // `terminalSuccess` on a mechanically settled or post-delivery-disconnect run
  // before handing the envelope over.
  const verdict = verdictOf({
    case: "provider-failure",
    reason: "remote rejected the push",
    envelope: envelope({
      phase: "DELIVER",
      exitCode: 0,
      terminalEventSeen: false,
      terminalSuccess: false,
      stderrSummary: "remote rejected the push",
    }),
  });
  assert.equal(verdict.failureClass, FailureClass.TASK_FAILED);
  assert.equal(verdict.externalFailure, true, "the agent finished; the push is the runner's plumbing");
});

test("the same envelope in EXECUTE is still the protocol drift it was", () => {
  const verdict = verdictOf({
    case: "provider-failure",
    reason: "the provider stream ended without a terminal event",
    envelope: envelope({
      exitCode: 0,
      terminalEventSeen: false,
      terminalSuccess: false,
      stderrSummary: null,
    }),
  });
  assert.equal(verdict.failureClass, FailureClass.PROTOCOL_ERROR);
  assert.equal(verdict.retryable, true);
});

test("completeRun applies and caps EXECUTE model-capacity refunds", async () => {
  for (const providerError of [
    "Selected model is at capacity. Please try a different model.",
    "This model is currently at capacity. Please try again.",
  ]) {
    const harness = statefulCompletionHarness();
    let budget = { maxRunsPerTask: 1, budgetGrants: 0 };
    const original = fetchFailureOutcome();
    assert.equal(original.case, "provider-failure");
    if (original.case !== "provider-failure") throw new Error("expected provider failure");
    const outcome: RunOutcome = {
      ...original, reason: providerError,
      envelope: { ...original.envelope, providerError, stderrSummary: null },
    };
    for (let runNumber = 1; runNumber <= EXTERNAL_FAILURE_REFUND_CAP + 1; runNumber += 1) {
      const closed = await harness.complete({ runNumber, ...budget, outcome });
      const grants = Math.min(runNumber, EXTERNAL_FAILURE_REFUND_CAP);
      assert.equal(closed.failureClass, FailureClass.TRANSIENT_PROVIDER);
      assert.equal(closed.budgetGrants, grants);
      assert.equal(closed.maxRunsPerTask, 1 + grants);
      budget = { maxRunsPerTask: Number(closed.maxRunsPerTask), budgetGrants: Number(closed.budgetGrants) };
    }
    assert.equal(harness.activities.filter(({ metadata }) => metadata?.kind === "externalFailureRefund.granted").length, EXTERNAL_FAILURE_REFUND_CAP);
    assert.ok(harness.activities.some(({ metadata }) => metadata?.capReached === true));
  }
});

test("a retryable detached repair whose retry is refused keeps ordinary task failure settlement", async () => {
  const harness = statefulCompletionHarness({ opensPullRequest: false });
  harness.activities.push({ taskId: "task-refunds", actorType: "control-plane", body: "Repair opened",
    metadata: { kind: "mergeTail.repairAttempt", schemaVersion: 1, state: "opened",
      regressionTaskId: "parent-regression", repairTaskId: "task-refunds", repairKind: "gate-fix",
      headSha: baseSha, baseHeadSha: "6".repeat(40) },
  });
  const closed = await harness.complete({
    runNumber: 1, maxRunsPerTask: 2, budgetGrants: 0, outcome: fetchFailureOutcome(),
  });
  assert.equal(closed.status, RunStatus.FAILED);
  assert.ok(harness.activities.some(({ body }) => /retry.*refused/iu.test(body)), "the archived assignee refuses the retry");
  assert.equal(harness.taskUpdates.at(-1)?.status, "REVIEW");
  assert.equal(harness.activities.some(({ metadata }) => metadata?.kind === "mergeTail.stop"), false);
});

for (const outcome of ["review-fail", "refresh-conflict"]) {
  for (const scenario of ["unreported", "reported", "foreign-run", "malformed", "stale-output", "reported-mismatch", "persisted-mismatch", "absent", "pass"] as const) {
    test(`completeRun qualifies ${outcome} after external git failure: ${scenario}`, async () => {
      const reason = "git fetch failed: gnutls_handshake() failed";
      const otherHead = "7".repeat(40);
      const accepted = scenario === "unreported" || scenario === "reported";
      const reportedHead = scenario === "reported" ? baseSha : scenario === "reported-mismatch" ? otherHead : undefined;
      const harness = statefulCompletionHarness({}, scenario === "absent" ? null : {
        runId: scenario === "foreign-run" ? "other-run" : "run-1",
        kind: "regression-verification-v2", commitSha: scenario === "stale-output" ? otherHead : baseSha,
        body: scenario === "malformed" ? "invalid JSON" : JSON.stringify({
          schemaVersion: 2, outcome: scenario === "pass" ? "pass" : outcome,
          headSha: baseSha, baseHeadSha: "6".repeat(40), summary: "persisted reason",
          ...(scenario === "pass" ? { gateVerdict: "PASS", gateProof: `MERGE GATE: PASS ${baseSha}` } : {}),
        }),
        metadata: null,
      });
      const closed = await harness.complete({
        runNumber: 1, maxRunsPerTask: 1, budgetGrants: 0,
        headSha: reportedHead,
        runHeadSha: scenario === "persisted-mismatch" ? otherHead : undefined,
        templateStep: { outputKind: "regression-verification-v2", requiresCommit: true, taskTemplate: { name: "direct-engineer-workflow" } },
        outcome: {
          case: "provider-failure", reason,
          envelope: {
            version: 1, phase: "DELIVER", agentExited: true, exitCode: 1, signal: null,
            terminationReason: null, timedOut: false, timeoutMs: null, transient: false,
            runnerClass: "TASK_FAILED", providerError: null, stderrSummary: null, stdoutSummary: reason,
            terminalEventSeen: true, terminalSuccess: false,
          },
        },
      });
      assert.equal(closed.headSha, accepted ? baseSha : reportedHead ?? null);
      assert.equal(closed.failureClass, FailureClass.TASK_FAILED);
      assert.equal(harness.activities.some((activity) => activity.metadata?.failureReason === reason), accepted);
    });
}
}
