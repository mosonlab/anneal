import "./test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  activateChainSuccessor,
  advanceTemplateTask,
  agentArchiveBlocker,
  applyInboxDecisionTx,
  ArchivedAssigneeError,
  AssigneeType,
  CodexServiceTier,
  deriveRunConfig,
  enqueueTaskRun,
  InboxKind,
  isArchivedAssigneeError,
  isArchivedTaskError,
  LIVE_TASK_STATUSES,
  nativeImplementationSubagentRunConfig,
  resolveRequeueBase,
  resolveRunBranches,
  RunStatus,
  runnerFor,
  RunnerKind,
  RunnerPreference,
  TaskStatus,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { noteArchivedQueuedRuns } from "./reconcile.js";

const runAgent = (overrides: Record<string, unknown> = {}) => ({
  id: "agent-1",
  projectId: "project-1",
  environmentId: "environment-1",
  name: "senior-dev-astra-medium",
  title: "Senior Developer",
  model: "claude",
  codexServiceTier: CodexServiceTier.DEFAULT,
  runnerPreference: RunnerPreference.CLAUDE,
  foundationalPrompt: "f",
  rolePrompt: "r",
  inboxAccess: false,
  disabledTools: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  archivedAt: null,
  ...overrides,
});

test("runnerFor preserves explicit preferences and every inherited model heuristic", () => {
  const cases: [RunnerPreference, string, RunnerKind][] = [
    [RunnerPreference.CLAUDE, "openai-codex", RunnerKind.CLAUDE],
    [RunnerPreference.CODEX, "deepseek-r1", RunnerKind.CODEX],
    [RunnerPreference.PI, "claude-opus-5", RunnerKind.PI],
    [RunnerPreference.INHERIT, "openai-codex/gpt", RunnerKind.CODEX],
    [RunnerPreference.INHERIT, "deepseek-r1", RunnerKind.PI],
    [RunnerPreference.INHERIT, "agent-pi-v2", RunnerKind.PI],
    [RunnerPreference.AUTO, "agent/pi-v2", RunnerKind.PI],
    [RunnerPreference.INHERIT, "OpenAI-CoDeX/GPT", RunnerKind.CODEX],
    [RunnerPreference.INHERIT, "claude-opus-5", RunnerKind.CLAUDE],
    [RunnerPreference.INHERIT, "anthropic/claude-opus-5", RunnerKind.CLAUDE],
    [RunnerPreference.AUTO, "openrouter/anthropic/claude-opus-5", RunnerKind.CLAUDE],
    [RunnerPreference.AUTO, "apiary/model", RunnerKind.CLAUDE],
  ];
  for (const [preference, model, expected] of cases) {
    assert.equal(runnerFor(preference, model), expected, `${preference} / ${model}`);
  }
});

test("deriveRunConfig preserves the selected Agent runtime profile for ordinary and compound runs", () => {
  const ordinaryAgent = {
    runnerPreference: RunnerPreference.PI,
    model: "current-model",
    codexServiceTier: CodexServiceTier.DEFAULT,
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  };
  assert.deepEqual(deriveRunConfig(ordinaryAgent, { runner: RunnerKind.CODEX }), {
    runner: RunnerKind.CODEX,
    model: "current-model",
    codexServiceTier: CodexServiceTier.DEFAULT,
  });
  const executionerAgent = {
    ...ordinaryAgent,
    runnerPreference: RunnerPreference.CODEX,
    model: "gpt-5.6-luna:max",
    codexServiceTier: CodexServiceTier.FAST,
  };
  assert.deepEqual(deriveRunConfig(executionerAgent, {
    runner: null,
    stepIndex: 5,
    outputKind: "implementation",
    taskTemplate: { name: "compound-engineer-workflow" },
  }), {
    runner: RunnerKind.CODEX,
    model: "gpt-5.6-luna:max",
    codexServiceTier: CodexServiceTier.FAST,
  });
  assert.throws(() => deriveRunConfig(ordinaryAgent, {
    runner: null,
    stepIndex: 5,
    outputKind: "implementation",
    taskTemplate: { name: "compound-engineer-workflow" },
  }), /requires a Codex gpt-\* model/u);
});

test("Codex implementation steps receive the fixed native Luna child capability", () => {
  const compound = {
    stepIndex: 5,
    outputKind: "implementation",
    taskTemplate: { name: "compound-engineer-workflow" },
  };
  const direct = {
    stepIndex: 1,
    outputKind: "implementation",
    taskTemplate: { name: "direct-engineer-workflow" },
  };
  const pullRequestWorkflow = {
    stepIndex: 1,
    outputKind: "implementation",
    taskTemplate: { name: "pr-engineer-workflow" },
  };
  const expected = { subagentModel: "gpt-5.6-luna:max", subagentMaxConcurrent: 8 };
  assert.deepEqual(nativeImplementationSubagentRunConfig(RunnerKind.CODEX, compound), expected);
  assert.deepEqual(nativeImplementationSubagentRunConfig(RunnerKind.CODEX, direct), expected);
  assert.equal(nativeImplementationSubagentRunConfig(RunnerKind.CODEX, pullRequestWorkflow), null);
  assert.equal(nativeImplementationSubagentRunConfig(RunnerKind.CLAUDE, direct), null);
  assert.equal(nativeImplementationSubagentRunConfig(RunnerKind.CODEX, null), null);
});

test("task creation leaves promptHash empty until the exact prompt is dispatched", async () => {
  const previousToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-workflow-test";
  try {
    let runData: Record<string, unknown> | undefined;
    let createdTask: Record<string, unknown> | undefined;
    const agent = runAgent({
      model: "OpenAI-CoDeX/GPT",
      runnerPreference: RunnerPreference.INHERIT,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    });
    const database = {
      agent: { findFirst: async () => agent },
      repo: { findFirst: async () => ({ id: "repo-1", defaultBranch: "main" }) },
      agentRepoAccess: { findFirst: async () => ({ id: "grant-1" }) },
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [{ id: agent.id, archivedAt: null }],
        agent: { findUnique: async () => agent },
        task: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            createdTask = { id: "task-1", ...data };
            return createdTask;
          },
          findUnique: async () => createdTask ? {
            ...createdTask,
            assigneeAgent: agent,
            repo: { id: "repo-1", defaultBranch: "main" },
            templateStep: null,
            runs: [],
          } : null,
        },
        taskActivity: { create: async () => ({ id: "activity-1" }) },
        run: {
          findFirst: async () => null,
          create: async ({ data }: { data: Record<string, unknown> }) => { runData = data; return { id: "run-1", ...data }; },
        },
      }),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/projects/project-1/tasks", {
      method: "POST",
      headers: { Authorization: "Bearer operator-workflow-test", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Task name",
        description: "Task description",
        repoId: "repo-1",
        assigneeAgentId: "agent-1",
      }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual({
      runner: runData?.runner,
      model: runData?.model,
      codexServiceTier: runData?.codexServiceTier,
      promptHash: runData?.promptHash,
      maxDurationMin: runData?.maxDurationMin,
    }, {
      runner: RunnerKind.CODEX,
      model: agent.model,
      codexServiceTier: CodexServiceTier.DEFAULT,
      promptHash: null,
      maxDurationMin: 240,
    });
  } finally {
    if (previousToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousToken;
  }
});

test("layer activation refuses a missing chain row instead of following a linked successor", async () => {
  const activities: string[] = [];
  const tx = {
    $queryRaw: async () => [],
    task: { findMany: async () => [] },
    taskActivity: { create: async ({ data }: { data: { body: string } }) => { activities.push(data.body); return {}; } },
  } as any;
  const result = await activateChainSuccessor(tx, {
    id: "broken", projectId: "project-1", name: "Broken", chainId: "chain-1", chainIndex: 0, chainLayer: 1,
  });
  assert.deepEqual(result, { nextTaskId: null, gated: false });
  assert.deepEqual(activities, ["Chain row missing execution layer; auto-advance skipped"]);
});

test("a later chain step runs on the chain's shared branch so the chain lands in one PR", async () => {
  const queued: Record<string, unknown>[] = [];
  const task = {
    id: "task-2", projectId: "project-1", name: "Plan", description: "plan", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: "agent-1", repoId: "repo-1", templateId: "template-1", templateStepId: "step-2",
    chainId: "chain-1", chainIndex: 2, targetBranch: "feat/lines", opensPullRequest: true, maxDurationMin: 120,
    stallTimeoutMin: 10, maxSessionsPerTask: 5, archivedAt: null, runs: [],
    assigneeAgent: runAgent(),
    repo: { id: "repo-1", defaultBranch: "main" },
    templateStep: { stepIndex: 2, outputKind: "plan", baseFromStepIndex: null, runner: null, taskTemplate: { name: "template" } },
  };
  const tx = {
    $queryRaw: async () => [{ id: "agent-1", archivedAt: null }],
    agent: { findUnique: async () => runAgent() },
    task: {
      findUniqueOrThrow: async () => task,
      findUnique: async () => task,
      findFirst: async () => null,
    },
    chainControl: { findMany: async () => [] },
    run: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { queued.push(data); return { id: "run-1", ...data }; },
    },
  } as any;
  await enqueueTaskRun(tx, "task-2");
  assert.equal(queued[0]!.branch, "feat/lines");
  assert.equal(queued[0]!.targetBranch, "feat/lines");
});

test("a template approval gate persists an outbox card and leaves the task in review", async () => {
  const updates: unknown[] = [];
  let gate: Record<string, unknown> | undefined;
  const task = { id: "task-1", name: "Write spec", templateId: "template-1", approvalGate: true };
  const tx = {
    task: {
      findUniqueOrThrow: async () => task,
      update: async ({ data }: { data: unknown }) => { updates.push(data); return task; },
    },
    run: { findUniqueOrThrow: async () => ({ id: "run-1", taskId: task.id, agentId: "agent-1", pullRequestUrl: "https://github.com/acme/app/pull/7", session: { id: "session-1" } }) },
    inboxThread: { upsert: async () => ({ id: "thread-1" }) },
    inboxMessage: { create: async ({ data }: { data: Record<string, unknown> }) => { gate = data; return { id: "gate-1", ...data }; } },
    taskStepOutput: { findUnique: async () => ({ kind: "spec", body: "S".repeat(2_500) }) },
  } as any;
  const result = await advanceTemplateTask(tx, task.id, "run-1", "chat-1");
  assert.equal(result.gated, true);
  assert.deepEqual(updates[0], { status: "REVIEW" });
  assert.equal(gate?.gateTaskId, task.id);
  // The approver decides from the card: PR link plus a truncated artifact preview.
  assert.match(String(gate?.body), /pull\/7/);
  assert.match(String(gate?.body), /产物（spec）/);
  assert.match(String(gate?.body), /已截断/);
  assert.ok(String(gate?.body).length < 2_500);
  assert.deepEqual(gate?.choices, [{ id: "approve", label: "批准并继续" }, { id: "reject", label: "打回上一步" }]);
});

test("the shared decision compare-and-set makes a second Web or Feishu click a no-op", async () => {
  let decisionWrites = 0;
  const events: string[] = [];
  const tx = {
    $queryRaw: async () => { events.push("task-lock"); return [{ id: "task-1", archivedAt: null }]; },
    inboxMessage: {
      findUnique: async () => ({ id: "gate-1", gateTaskId: "task-1", session: { id: "session-1", run: { id: "run-1", status: RunStatus.SUCCEEDED } }, gateTask: { id: "task-1" } }),
      updateMany: async () => { events.push("open-cas"); return { count: 0 }; },
      create: async () => { throw new Error("must not create reply"); },
    },
    inboxDecision: { create: async () => { decisionWrites += 1; } },
  } as any;
  assert.deepEqual(await applyInboxDecisionTx(tx, { inboxMessageId: "gate-1", externalEventId: "web:req-2", decision: "approve" }), {
    duplicate: true, resumed: false,
  });
  assert.equal(decisionWrites, 0);
  assert.deepEqual(events, ["task-lock", "open-cas"]);
});

const rejectionTx = (options: { redoArchivedAt?: Date | null; agentArchivedAt?: Date | null } = {}) => {
  const queued: Record<string, unknown>[] = [];
  const replies: Record<string, unknown>[] = [];
  const activities: Record<string, unknown>[] = [];
  const locks: string[] = [];
  const executable = {
    id: "task-1", projectId: "project-1", name: "Write spec", description: "spec", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: "agent-1", repoId: "repo-1", targetBranch: "main", maxDurationMin: 120, stallTimeoutMin: 10,
    maxSessionsPerTask: 3, archivedAt: null,
    assigneeAgent: runAgent(),
    repo: { id: "repo-1", defaultBranch: "main" }, templateStep: { runner: null }, runs: [{ runNumber: 1, branch: "feature/x" }],
  };
  const tx = {
    // The Task-row mutex the reject path takes before queueing the redo, then
    // the Agent-row mutex enqueueTaskRun takes before creating the run.
    // Returning the archive state from *these* reads, not from the rows that
    // travelled with the Inbox message, is the point of the locks.
    $queryRaw: async (_strings: unknown, lockedId: string) => {
      locks.push(lockedId);
      return [{
        id: lockedId,
        archivedAt: lockedId === "agent-1" ? options.agentArchivedAt ?? null : options.redoArchivedAt ?? null,
      }];
    },
    inboxMessage: {
      findUnique: async () => ({
        id: "gate-1", gateTaskId: "task-1", agentId: "agent-1", sessionId: "session-1", taskId: "task-1", goalId: null, threadId: "thread-1",
        session: { id: "session-1", run: { id: "run-1", status: RunStatus.SUCCEEDED } },
        gateTask: { id: "task-1", name: "Write spec", assigneeType: AssigneeType.AGENT, previousTask: null },
      }),
      updateMany: async () => ({ count: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => { replies.push(data); return { id: "reply-1" }; },
    },
    inboxDecision: { create: async () => ({}) },
    task: {
      update: async () => ({}),
      findUniqueOrThrow: async () => executable,
      findUnique: async () => executable,
    },
    taskActivity: { create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return {}; } },
    agent: { findUnique: async () => runAgent({ archivedAt: options.agentArchivedAt ?? null }) },
    run: {
      // enqueueTaskRun asks whether the producing run's branch actually reached
      // the remote before reusing it as the redo's base. A gate exists because
      // it did, so this answers yes for that ref and no for anything else.
      findFirst: async ({ where }: { where: { pushedBranch?: unknown } }) =>
        (where.pushedBranch === "feature/x" ? { id: "run-1", pushedBranch: "feature/x" } : null),
      create: async ({ data }: { data: Record<string, unknown> }) => { queued.push(data); return { id: "run-2", ...data }; },
    },
  } as any;
  return { tx, queued, replies, activities, locks };
};

test("rejecting a gate transactionally returns the producing step to the queue", async () => {
  const { tx, queued, activities, locks } = rejectionTx();
  const result = await applyInboxDecisionTx(tx, { inboxMessageId: "gate-1", externalEventId: "feishu:evt-1", decision: "reject" });
  assert.equal(result.gateAction, "rejected");
  // Task row first, Agent row second: the one global lock order.
  assert.deepEqual(locks, ["task-1", "agent-1"]);
  assert.equal(queued[0]!.runNumber, 2);
  assert.equal(queued[0]!.branch, "feature/x");
  assert.equal(queued[0]!.targetBranch, "feature/x");
  assert.deepEqual(activities[0], {
    taskId: "task-1",
    actorType: "operator",
    body: "Approval gate rejected; step queued again",
  });
});

test("rejecting a gate with feedback stores the note on the reply and activity", async () => {
  const { tx, queued, replies, activities } = rejectionTx();
  const note = "The implementation must preserve the existing retry contract.";
  const result = await applyInboxDecisionTx(tx, {
    inboxMessageId: "gate-1",
    externalEventId: "feishu:evt-feedback",
    decision: "reject",
    note,
  });
  assert.equal(result.gateAction, "rejected");
  assert.equal(queued.length, 1);
  assert.equal(replies[0]?.body, `reject\n\nOperator feedback on previous attempt:\n${note}`);
  assert.equal((replies[0]?.selectedChoiceId), "reject");
  assert.equal(activities[0]?.body, `Approval gate rejected; step queued again\nOperator feedback on previous attempt:\n${note}`);
  assert.deepEqual(activities[0]?.metadata, {
    approvalGateFeedback: true,
    note,
  });
});

test("rejecting a gate onto a step whose agent archived under the lock queues nothing", async () => {
  const { tx, queued } = rejectionTx({ agentArchivedAt: new Date("2026-08-17T00:00:00.000Z") });
  await assert.rejects(
    () => applyInboxDecisionTx(tx, { inboxMessageId: "gate-1", externalEventId: "feishu:evt-3", decision: "reject" }),
    (error: unknown) => isArchivedAssigneeError(error),
  );
  assert.equal(queued.length, 0);
});

test("rejecting a gate onto an archived predecessor throws rather than queueing a run nothing will claim", async () => {
  // The runner claims only unarchived TODO/DOING tasks, so a run queued here
  // would sit forever. Throwing rolls the transaction back, which leaves the
  // Inbox decision OPEN for the human to make again after unarchiving.
  const { tx, queued } = rejectionTx({ redoArchivedAt: new Date("2026-08-16T00:00:00.000Z") });
  await assert.rejects(
    () => applyInboxDecisionTx(tx, { inboxMessageId: "gate-1", externalEventId: "feishu:evt-2", decision: "reject" }),
    (error: unknown) => isArchivedTaskError(error) && /archived/.test((error as Error).message),
  );
  assert.equal(queued.length, 0);
});

test("a multiple-choice Inbox decision accepts an option id and persists the human reply", async () => {
  let reply: Record<string, unknown> | undefined;
  let resumeInput: unknown;
  const tx = {
    inboxMessage: {
      findUnique: async () => ({
        id: "question-1", kind: InboxKind.MULTIPLE_CHOICE,
        choices: [{ id: "ship", label: "Ship it" }, { id: "wait", label: "Wait" }],
        gateTaskId: null, agentId: "agent-1", sessionId: "session-1", taskId: "task-1", goalId: null, threadId: "thread-1",
        session: { id: "session-1", run: { id: "run-1", status: RunStatus.WAITING_INBOX } }, gateTask: null,
      }),
      updateMany: async () => ({ count: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => { reply = data; return { id: "reply-1" }; },
    },
    inboxDecision: { create: async () => ({}) },
    run: { updateMany: async () => ({ count: 1 }) },
    session: { update: async ({ data }: { data: { resumeInput: unknown } }) => { resumeInput = data.resumeInput; return {}; } },
  } as any;
  const result = await applyInboxDecisionTx(tx, {
    inboxMessageId: "question-1", externalEventId: "web:ship", decision: "ship", actorOpenId: "web-operator",
  });
  assert.equal(result.resumed, true);
  assert.equal(reply?.from, "HUMAN");
  assert.equal(reply?.selectedChoiceId, "ship");
  assert.equal(resumeInput, "ship");
  await assert.rejects(() => applyInboxDecisionTx(tx, {
    inboxMessageId: "question-1", externalEventId: "web:unknown", decision: "unknown",
  }), /must match an Inbox choice id/);
  await assert.rejects(() => applyInboxDecisionTx(tx, {
    inboxMessageId: "question-1", externalEventId: "web:note", decision: "ship", note: "not a gate note",
  }), /only supported for an approval-gate card/);
});

test("agentArchiveBlocker asks the database for exactly the live task statuses", async () => {
  // The status set is the contract, and a mocked findFirst cannot demonstrate a
  // filter it never applies — so the query itself is asserted. DONE is terminal
  // history and BACKLOG is explicitly parked; both must stay archivable, and an
  // already-archived task is not a reference to anything.
  let where: Record<string, unknown> | undefined;
  const tx = {
    run: { findFirst: async () => null },
    task: {
      findFirst: async (args: { where: Record<string, unknown> }) => { where = args.where; return null; },
    },
  } as any;
  assert.equal(await agentArchiveBlocker(tx, "agent-1"), null);
  assert.deepEqual(where, {
    assigneeAgentId: "agent-1",
    archivedAt: null,
    status: { in: [TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW] },
  });
  assert.deepEqual(LIVE_TASK_STATUSES, [TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW]);
});

test("agentArchiveBlocker reports the live run before the live task and names both precisely", async () => {
  const blockerFor = (run: unknown, task: unknown) => agentArchiveBlocker({
    run: { findFirst: async () => run },
    task: { findFirst: async () => task },
  } as any, "agent-1");
  // A queued run and a REVIEW task are the same stranding one step apart; the
  // run is reported first because cancelling it is the narrower operator action.
  assert.equal(
    await blockerFor({ runNumber: 3, status: RunStatus.QUEUED, task: { name: "Ship it" } }, { name: "Ship it", status: TaskStatus.REVIEW }),
    "Cannot archive an agent with a QUEUED run on Ship it; finish or cancel run 3 first",
  );
  assert.equal(
    await blockerFor(null, { name: "Awaiting the gate", status: TaskStatus.REVIEW }),
    "Cannot archive an agent assigned to REVIEW task Awaiting the gate; finish, park, archive, or reassign that task first",
  );
  assert.equal(await blockerFor(null, null), null);
});

test("enqueueTaskRun rejects archived agents with a name-recognisable typed error", async () => {
  const tx = {
    // The locked re-read is the authority; the relation below only agrees.
    $queryRaw: async () => [{ id: "agent-1", archivedAt: new Date() }],
    agent: { findUnique: async () => runAgent({ name: "Ada", archivedAt: new Date() }) },
    task: {
      findUnique: async () => ({
        id: "task-archived", projectId: "project-1", name: "Archived work", description: "work", archivedAt: null,
        assigneeType: AssigneeType.AGENT, assigneeAgentId: "agent-1", repoId: "repo-1", templateId: null,
        templateStepId: null, chainId: null, chainIndex: null, targetBranch: "main", opensPullRequest: true,
        maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 3, runs: [],
        assigneeAgent: {
          id: "agent-1", name: "Ada", archivedAt: new Date(), model: "claude",
          runnerPreference: RunnerPreference.CLAUDE, foundationalPrompt: "f", rolePrompt: "r",
        },
        repo: { id: "repo-1", defaultBranch: "main" },
        templateStep: null,
      }),
    },
    run: { create: async () => { throw new Error("must not create run"); } },
  } as any;
  const error = await enqueueTaskRun(tx, "task-archived").then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof ArchivedAssigneeError);
  assert.equal(isArchivedAssigneeError(error), true);
  assert.equal(isArchivedAssigneeError({ name: "ArchivedAssigneeError" }), false);
});

test("enqueueTaskRun preserves the precise archived-assignee refusal for a compound executioner", async () => {
  const archivedAt = new Date();
  const executioner = runAgent({
    name: "plan-executor-astra-low",
    archivedAt,
  });
  const tx = {
    $queryRaw: async () => [{ id: executioner.id }],
    agent: { findUnique: async () => executioner },
    task: {
      findUnique: async () => ({
        id: "compound-implementation",
        projectId: "project-1",
        name: "Implementation",
        description: "implement",
        archivedAt: null,
        assigneeType: AssigneeType.AGENT,
        assigneeAgentId: executioner.id,
        repoId: "repo-1",
        templateId: "compound-template",
        templateStepId: "implementation-step",
        chainId: "chain-1",
        chainIndex: 5,
        targetBranch: "main",
        opensPullRequest: true,
        maxDurationMin: 120,
        stallTimeoutMin: 10,
        maxSessionsPerTask: 3,
        runs: [],
        assigneeAgent: executioner,
        repo: { id: "repo-1", defaultBranch: "main" },
        templateStep: {
          stepIndex: 5,
          outputKind: "implementation",
          baseFromStepIndex: null,
          taskTemplate: { name: "compound-engineer-workflow" },
        },
      }),
    },
    run: { create: async () => { throw new Error("must not create run"); } },
  } as any;
  const error = await enqueueTaskRun(tx, "compound-implementation").then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof ArchivedAssigneeError);
  assert.equal(
    error.message,
    "Task Implementation assignee plan-executor-astra-low is archived; unarchive the agent to queue this step",
  );
});

test("chain advancement parks an archived successor without throwing or enqueueing", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  let creates = 0;
  const archivedAgent = runAgent({
    id: "agent-2",
    name: "Archived Successor",
    archivedAt: new Date(),
  });
  const next = {
    id: "task-2", projectId: "project-1", chainId: "chain-1", chainIndex: 2, chainLayer: 2,
    name: "Archived Successor", description: "archived successor", status: TaskStatus.TODO, templateStepId: null,
    assigneeType: AssigneeType.AGENT, assigneeAgentId: "agent-2", approvalGate: false,
    repoId: "repo-1", templateId: null, targetBranch: "main", opensPullRequest: true,
    maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 5,
    archivedAt: null, updatedAt: new Date(), runs: [],
    assigneeAgent: archivedAgent,
    repo: { id: "repo-1", defaultBranch: "main" },
    templateStep: null,
  };
  const predecessor = {
    id: "task-1", projectId: "project-1", chainId: "chain-1", chainIndex: 1, chainLayer: 1,
    name: "Completed predecessor", status: TaskStatus.DONE, templateStepId: null,
    assigneeType: AssigneeType.AGENT, assigneeAgentId: "agent-1", approvalGate: false,
    repoId: "repo-1", updatedAt: new Date(), runs: [], assigneeAgent: null,
  };
  const tx = {
    $queryRaw: async () => [predecessor, next],
    task: {
      findUniqueOrThrow: async () => ({ ...predecessor, templateId: "template-1" }),
      // Chain rows for this chain; the predecessor has no cross-chain binding,
      // so the bound-successor query answers with nothing.
      findMany: async ({ where }: { where?: { dispatchAfterTaskId?: string } } = {}) => (
        where?.dispatchAfterTaskId === undefined ? [predecessor, next] : []
      ),
      findUnique: async ({ where }: { where: { id?: string } }) => where.id === next.id ? next : null,
      findFirst: async () => null,
      updateMany: async () => ({ count: 1 }),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, ...data });
        return {};
      },
    },
    agent: { findUnique: async () => archivedAgent },
    taskTemplateStep: { findUnique: async () => null },
    run: {
      findFirst: async () => null,
      create: async () => { creates += 1; return {}; },
    },
    taskActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return {}; },
    },
    chainControl: { findMany: async () => [] },
  } as any;
  assert.deepEqual(await advanceTemplateTask(tx, "task-1", "run-1", null), {
    gated: false,
    nextTaskId: "task-2",
  });
  assert.equal(creates, 0);
  assert.equal(updates[1]?.status, "REVIEW");
  assert.match(String(updates[1]?.failureReason), /Archived Successor/);
  assert.match(String(activities[0]?.body), /Run birth was refused:.*Archived Successor/);
  assert.deepEqual(activities[0]?.metadata, { refusal: "assignee-archived" });
});

test("an Inbox-resumed queued run for an archived agent is surfaced by the sweep", async () => {
  let status: RunStatus = RunStatus.WAITING_INBOX;
  const archivedAt = new Date("2026-08-16T06:00:00.000Z");
  const tx = {
    inboxMessage: {
      findUnique: async () => ({
        id: "question-1", kind: InboxKind.TEXT, gateTaskId: null, agentId: "agent-1",
        sessionId: "session-1", taskId: "task-1", goalId: null, threadId: "thread-1",
        session: { id: "session-1", run: { id: "run-1", status } }, gateTask: null,
      }),
      updateMany: async () => ({ count: 1 }),
      create: async () => ({ id: "reply-1" }),
    },
    inboxDecision: { create: async () => ({}) },
    run: { updateMany: async () => { status = RunStatus.QUEUED; return { count: 1 }; } },
    session: { update: async () => ({}) },
  } as any;
  await applyInboxDecisionTx(tx, {
    inboxMessageId: "question-1", externalEventId: "web:resume", decision: "continue",
  });
  const notices: Record<string, unknown>[] = [];
  const db = {
    run: {
      findMany: async () => status === RunStatus.QUEUED
        ? [{ id: "run-1", taskId: "task-1", runNumber: 1, agent: { name: "Archived", archivedAt } }]
        : [],
    },
    taskActivity: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => { notices.push(...data); return { count: data.length }; },
    },
  } as unknown as PrismaClient;
  assert.equal(await noteArchivedQueuedRuns(db), 1);
  assert.match(String(notices[0]?.body), /Archived.*run 1/);
});

// `pushedBranch` rows, answered the two ways resolveRunBranches asks for them:
// "did anything publish this exact ref on this repo" and "what is the newest ref
// this task ever pushed".
const branchTx = (rows: Array<{
  taskId: string; chainId: string | null; repoId: string; runNumber: number; pushedBranch: string;
}>, templateBranch: string | null = null) => ({
  run: {
    findFirst: async ({ where, orderBy }: any) => {
      const scoped = rows.filter((row) => row.repoId === where.repoId
        && (where.taskId === undefined || row.taskId === where.taskId)
        && (where.task?.id === undefined || row.taskId === where.task.id)
        && (where.task?.chainId === undefined || row.chainId === where.task.chainId));
      if (typeof where.pushedBranch === "string") {
        return scoped.find((row) => row.pushedBranch === where.pushedBranch) ?? null;
      }
      assert.deepEqual(orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
      return [...scoped].sort((a, b) => b.runNumber - a.runNumber)[0] ?? null;
    },
  },
  task: { findFirst: async () => templateBranch === null ? null : { targetBranch: templateBranch } },
  taskActivity: { create: async () => ({}) },
} as any);

test("a non-chain retry inherits the prior branch as its base only against push evidence", async () => {
  const task = {
    id: "task-1", projectId: "project-1", repoId: "repo-1", chainId: null, chainIndex: null,
    templateId: null, targetBranch: null, repo: { defaultBranch: "main" },
  };
  const prior = { branch: "agentos/task-1/run-1", targetBranch: null, runNumber: 1 };
  const birth = { intent: "retry", runNumber: 2, prior } as const;
  // The production shape (issue #118, runs cmsy9kg5j0001mp76wb95xiyu and
  // siblings): run 1's push failed, so `branch` names a ref no remote has and
  // cloning it burns the retry. Falling back is what makes the retry runnable.
  assert.deepEqual(await resolveRunBranches(branchTx([]), task, birth), {
    branch: "agentos/task-1/run-1", targetBranch: "main",
  });
  // Evidence from another task or another remote is not evidence for this one.
  const foreign = branchTx([
    { taskId: "task-9", chainId: null, repoId: "repo-1", runNumber: 1, pushedBranch: "agentos/task-1/run-1" },
    { taskId: "task-1", chainId: null, repoId: "repo-2", runNumber: 1, pushedBranch: "agentos/task-1/run-1" },
  ]);
  assert.deepEqual(await resolveRunBranches(foreign, { ...task, targetBranch: "release/1.2" }, birth), {
    branch: "agentos/task-1/run-1", targetBranch: "release/1.2",
  });
  // The push landed: the ref exists, so the retry continues on top of it.
  const published = branchTx([
    { taskId: "task-1", chainId: null, repoId: "repo-1", runNumber: 1, pushedBranch: "agentos/task-1/run-1" },
  ]);
  assert.deepEqual(await resolveRunBranches(published, task, birth), {
    branch: "agentos/task-1/run-1", targetBranch: "agentos/task-1/run-1",
  });
});

test("a retry bases on the newest WIP salvage rather than discarding what did reach the remote", async () => {
  // Run 1 pushed nothing; run 2 inherited its branch name, failed, and salvaged
  // its tree to its own per-run ref (delivery.ts). Run 3 must start from that
  // ref — the fallback base would silently throw run 2's work away.
  const tx = branchTx([
    { taskId: "task-1", chainId: null, repoId: "repo-1", runNumber: 2, pushedBranch: "agentos/task-1/run-2" },
  ]);
  assert.deepEqual(await resolveRunBranches(tx, {
    id: "task-1", projectId: "project-1", repoId: "repo-1", chainId: null, chainIndex: null,
    templateId: null, targetBranch: null, repo: { defaultBranch: "main" },
  }, { intent: "retry", runNumber: 3, prior: { branch: "agentos/task-1/run-1", targetBranch: null, runNumber: 1 } }), {
    branch: "agentos/task-1/run-1", targetBranch: "agentos/task-1/run-2",
  });
});

test("a template retry falls back to its own targetBranch but still honours a sibling's publication", async () => {
  // Step ①: its base is the default branch, and run 1's unpublished workspace
  // branch must not become the base of run 2.
  assert.deepEqual(await resolveRunBranches(branchTx([]), {
    id: "task-1", projectId: "project-1", repoId: "repo-1", chainId: "chain-1", chainIndex: 0,
    templateId: "template-1", targetBranch: "main", repo: { defaultBranch: "main" },
  }, { intent: "retry", runNumber: 2, prior: { branch: "agentos/task-1/run-1", targetBranch: null, runNumber: 1 } }), {
    branch: "agentos/task-1/run-1", targetBranch: "main",
  });
  // Step ②: the chain branch is shared across the template's tasks, so the
  // publication that keeps this retry on it belongs to step ① — hence the
  // chain-scoped evidence query. Even an operator-repointed targetBranch does
  // not move a step off a branch its chain has already published.
  const tx = branchTx([
    { taskId: "task-1", chainId: "chain-1", repoId: "repo-1", runNumber: 1, pushedBranch: "agentos/chain-1" },
  ]);
  assert.deepEqual(await resolveRunBranches(tx, {
    id: "task-2", projectId: "project-1", repoId: "repo-1", chainId: "chain-1", chainIndex: 1,
    templateId: "template-1", targetBranch: "main", repo: { defaultBranch: "main" },
  }, { intent: "retry", runNumber: 2, prior: { branch: "agentos/chain-1", targetBranch: null, runNumber: 1 } }), {
    branch: "agentos/chain-1", targetBranch: "agentos/chain-1",
  });
});

test("a template operator retry publishes the declared head while basing on the newest salvage", async () => {
  const salvage = "agentos/task-1/run-2";
  const tx = branchTx([
    { taskId: "task-1", chainId: "chain-1", repoId: "repo-1", runNumber: 2, pushedBranch: salvage },
  ], "declared/chain-head");
  assert.deepEqual(await resolveRunBranches(tx, {
    id: "task-1", projectId: "project-1", repoId: "repo-1", chainId: "chain-1", chainIndex: 0,
    templateId: "template-1", targetBranch: "main", repo: { defaultBranch: "main" },
  }, { intent: "retry", runNumber: 3, prior: { branch: salvage, targetBranch: null, runNumber: 2 } }), {
    branch: "declared/chain-head",
    targetBranch: salvage,
  });
});

test("a successor first run bases on the newest sibling publication whatever ref carried it", async () => {
  const salvage = "agentos/task-1/run-2";
  const tx = branchTx([
    { taskId: "task-1", chainId: "chain-1", repoId: "repo-1", runNumber: 2, pushedBranch: salvage },
  ], "declared/chain-head");
  assert.deepEqual(await resolveRunBranches(tx, {
    id: "task-2", projectId: "project-1", repoId: "repo-1", chainId: "chain-1", chainIndex: 1,
    templateId: "template-1", targetBranch: "declared/chain-head", repo: { defaultBranch: "main" },
  }, { intent: "enqueue", runNumber: 1, prior: null }), {
    branch: "declared/chain-head",
    targetBranch: salvage,
  });

  const declared = branchTx([
    { taskId: "task-1", chainId: "chain-1", repoId: "repo-1", runNumber: 1, pushedBranch: "declared/chain-head" },
  ], "declared/chain-head");
  assert.deepEqual(await resolveRunBranches(declared, {
    id: "task-2", projectId: "project-1", repoId: "repo-1", chainId: "chain-1", chainIndex: 1,
    templateId: "template-1", targetBranch: "declared/chain-head", repo: { defaultBranch: "main" },
  }, { intent: "enqueue", runNumber: 1, prior: null }), {
    branch: "declared/chain-head",
    targetBranch: "declared/chain-head",
  });
});

test("a deferred template first run recovers its shared head from a later step", async () => {
  assert.deepEqual(await resolveRunBranches(branchTx([], "custom/template-head"), {
    id: "task-1", projectId: "project-1", repoId: "repo-1", chainId: "chain-1", chainIndex: 0,
    templateId: "template-1", targetBranch: "main", repo: { defaultBranch: "main" },
  }, { intent: "enqueue", runNumber: 1, prior: null }), {
    branch: "custom/template-head", targetBranch: "main",
  });
});

test("a requeue keeps its own base snapshot unless that base is its unpushed head", async () => {
  const task = {
    id: "task-1", projectId: "project-1", repoId: "repo-1", chainId: null, chainIndex: null,
    templateId: null, targetBranch: "release/1.2", repo: { defaultBranch: "main" },
  };
  const workspace = "agentos/task-1/run-1";
  // The snapshot is the point of this path: an operator edit to the task's
  // targetBranch must not retarget a run that was created before it.
  assert.equal(
    await resolveRequeueBase(branchTx([]), task, { branch: workspace, targetBranch: "operator/base" }),
    "operator/base",
  );
  // …but a base that is only this run's own never-pushed head is the issue #118
  // shape, and copying it forward is what kept the clone loop alive.
  assert.equal(
    await resolveRequeueBase(branchTx([]), task, { branch: workspace, targetBranch: workspace }),
    "release/1.2",
  );
  // Evidence still wins over the snapshot, both for the head itself…
  const published = branchTx([
    { taskId: "task-1", chainId: null, repoId: "repo-1", runNumber: 1, pushedBranch: workspace },
  ]);
  assert.equal(
    await resolveRequeueBase(published, task, { branch: workspace, targetBranch: workspace }),
    workspace,
  );
  // …and for a WIP salvage recorded on the run being replaced.
  const salvaged = branchTx([
    { taskId: "task-1", chainId: null, repoId: "repo-1", runNumber: 1, pushedBranch: "agentos/task-1/run-1-wip" },
  ]);
  assert.equal(
    await resolveRequeueBase(salvaged, task, { branch: workspace, targetBranch: "operator/base" }),
    "agentos/task-1/run-1-wip",
  );
});

test("a no-result repair retry reuses the repair card ref and ignores salvage", async () => {
  const tx = branchTx([
    { taskId: "repair", chainId: null, repoId: "repo-1", runNumber: 1, pushedBranch: "wip/repair" },
  ]);
  const task = {
    id: "repair", projectId: "project-1", repoId: "repo-1", chainId: null, chainIndex: null,
    templateId: null, targetBranch: "fix/chain", repo: { defaultBranch: "main" },
  };
  const birth = {
    intent: "retry-after-completion", retryFailedRepair: true, runNumber: 2,
    prior: { branch: "fix/chain", targetBranch: "fix/chain", runNumber: 1 },
  } as const;
  assert.deepEqual(await resolveRunBranches(tx, task, birth), {
    branch: "fix/chain", targetBranch: "fix/chain",
  });
  assert.deepEqual(await resolveRunBranches(tx, { ...task, targetBranch: null }, {
    ...birth, prior: { branch: null, targetBranch: null, runNumber: 1 },
  }), { branch: "agentos/repair/run-2", targetBranch: null });
  assert.deepEqual(await resolveRunBranches(tx, { ...task, repo: null }, birth), {
    branch: "fix/chain", targetBranch: "fix/chain",
  });
});
