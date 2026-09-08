import "../test-workspace-root.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE,
  InboxStatus,
  LEGACY_TEMPLATE_GENERATIONS,
  LEASE_LOSS_REFUND_EXHAUSTED_PREFIX,
  RunnerKind,
  RunnerPreference,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "../test-app.js";
import {
  boardDatabase,
  getTasks,
  lockedAgent,
  taskRow,
  withTokens,
} from "./test-support.js";

type ArchiveTestMessage = {
  id: string;
  taskId: string;
  dedupeKey: string;
  status: InboxStatus;
  answeredAt: Date | null;
};

const archiveRouteDatabase = (input: {
  messages?: ArchiveTestMessage[];
  activeRuns?: number;
  activeRunTaskIds?: string[];
  repairTaskIds?: string[];
  closeDuringUpdateIds?: string[];
  skipUpdateIds?: string[];
}) => {
  const chainId = "archive-chain";
  const tasks: Array<{
    id: string;
    projectId: string;
    chainId: string;
    status: string;
    archivedAt: Date | null;
  }> = [
    {
      id: "implementation-task", projectId: "project-1", chainId, status: "DONE", archivedAt: null,
    },
    {
      id: "regression-task", projectId: "project-1", chainId, status: "DONE", archivedAt: null,
    },
  ];
  const messages = input.messages ?? [];
  const repairs = (input.repairTaskIds ?? []).map((id) => ({
    id, projectId: "project-1", chainId: null, status: "DOING", archivedAt: null,
  }));
  const allTasks = [...tasks, ...repairs];
  const activities: Array<Record<string, unknown>> = [];
  let inboxFindManyCalls = 0;
  let inboxUpdateManyCalls = 0;
  const lockedTask = {
    ...tasks[1], approvalGate: false, dispatchAfterTaskId: null, dispatchAfter: null,
    assigneeType: "AGENT", assigneeAgentId: "agent-1", templateStep: null,
  };
  const tx = {
    $queryRaw: async () => allTasks.map(({ id }) => ({ id })),
    task: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
        const task = allTasks.find((candidate) => candidate.id === where.id);
        if (!task) return null;
        if (select && "status" in select) return task.id === lockedTask.id ? lockedTask : task;
        return { projectId: task.projectId, chainId: task.chainId };
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const task = allTasks.find((candidate) => candidate.id === where.id);
        if (!task) throw new Error(`Missing task ${where.id}`);
        return task;
      },
      findMany: async ({ where }: { where?: {
        id?: { in: string[] };
        projectId?: string;
        chainId?: string | null;
      } } = {}) => allTasks.filter((task) => (
        (!where?.id || where.id.in.includes(task.id))
        && (where?.projectId === undefined || task.projectId === where.projectId)
        && (where?.chainId === undefined || task.chainId === where.chainId)
      )),
      updateMany: async ({ data }: { data: { archivedAt: Date } }) => {
        for (const task of tasks) task.archivedAt = data.archivedAt;
        return { count: tasks.length };
      },
    },
    run: { count: async ({ where }: { where: { taskId: { in: string[] } } }) => (
      input.activeRunTaskIds
        ? input.activeRunTaskIds.filter((taskId) => where.taskId.in.includes(taskId)).length
        : input.activeRuns ?? 0
    ) },
    inboxMessage: {
      count: async () => {
        throw new Error("Inbox must not be read after an active-run refusal");
      },
      findMany: async ({ where }: { where: {
        id?: { in: string[] };
        taskId?: { in: string[] };
        status?: InboxStatus;
        dedupeKey?: { startsWith: string };
      } }) => {
        inboxFindManyCalls += 1;
        return messages
          .filter((message) => (
            (!where.id || where.id.in.includes(message.id))
            && (!where.taskId || where.taskId.in.includes(message.taskId))
            && (where.status === undefined || message.status === where.status)
            && (!where.dedupeKey || message.dedupeKey.startsWith(where.dedupeKey.startsWith))
          ))
          .map(({ id, taskId }) => ({ id, taskId }));
      },
      updateMany: async ({ where, data }: {
        where: {
          id: { in: string[] };
          taskId: { in: string[] };
          status: InboxStatus;
          dedupeKey: { startsWith: string };
        };
        data: { status: InboxStatus; answeredAt: Date };
      }) => {
        inboxUpdateManyCalls += 1;
        for (const message of messages) {
          if (input.closeDuringUpdateIds?.includes(message.id)) message.status = InboxStatus.CLOSED;
        }
        let count = 0;
        for (const message of messages) {
          if (
            where.id.in.includes(message.id)
            && where.taskId.in.includes(message.taskId)
            && message.status === where.status
            && message.dedupeKey.startsWith(where.dedupeKey.startsWith)
            && !input.skipUpdateIds?.includes(message.id)
          ) {
            message.status = data.status;
            message.answeredAt = data.answeredAt;
            count += 1;
          }
        }
        return { count };
      },
    },
    taskActivity: {
      findMany: async () => repairs.map((repair) => ({ metadata: {
        schemaVersion: 1,
        kind: "mergeTail.repairAttempt",
        repairKind: "gate-fix",
        repairTaskId: repair.id,
      } })),
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        activities.push(...data);
        return { count: data.length };
      },
    },
  };
  const database = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  return { database, messages, activities, get inboxFindManyCalls() { return inboxFindManyCalls; }, get inboxUpdateManyCalls() { return inboxUpdateManyCalls; } };
};

const retryRequest = async (
  assigneeAgent: {
    id: string;
    model: string;
    runnerPreference: RunnerPreference;
    foundationalPrompt: string;
    rolePrompt: string;
    archivedAt?: Date | null;
    name?: string;
    projectId?: string;
  } | null,
  templateStep: {
    runner: RunnerKind | null;
    stepIndex?: number;
    outputKind?: string;
    taskTemplate?: { name: string };
  } | null = null,
  options: { leaseLossRefunds?: number; taskStatus?: string; failureReason?: string | null; maxSessionsPerTask?: number } = {},
) => {
  let created: Record<string, unknown> | undefined;
  const activities: Array<Record<string, unknown>> = [];
  const currentTemplateStep = templateStep
    ? { stepIndex: 1, outputKind: "result", taskTemplate: { name: "direct-engineer-workflow" }, ...templateStep }
    : null;
  const last = {
    id: "run-1",
    projectId: "project-1",
    taskId: "task-1",
    goalId: "goal-1",
    agentId: "old-agent",
    repoId: "repo-previous",
    runNumber: 1,
    status: "FAILED",
    runner: RunnerKind.CLAUDE,
    model: "old-model",
    targetBranch: "main",
    branch: "feature/retry",
    promptHash: createHash("sha256").update("foundation\nrole\nRetry me\nUse current config").digest("hex"),
    maxDurationMin: 90,
    stallTimeoutMin: 7,
    maxRunsPerTask: 4,
    // Nothing granted, so the retry ceiling is the task's configured budget —
    // which is what `maxRunsPerTask: 4` already was.
    budgetGrants: 0,
    leaseLossRefunds: options.leaseLossRefunds ?? 0,
  };
  const currentTask = {
    id: "task-1",
    projectId: "project-1",
    status: options.taskStatus ?? "TODO",
    failureReason: options.failureReason ?? null,
    name: "Retry me",
    description: "Use current config",
    assigneeType: "AGENT",
    assigneeAgentId: assigneeAgent?.id ?? null,
    repoId: "repo-current",
    repo: null,
    templateId: null,
    templateStepId: currentTemplateStep ? "step-1" : null,
    maxSessionsPerTask: options.maxSessionsPerTask ?? 4,
    maxDurationMin: 120,
    stallTimeoutMin: 10,
    opensPullRequest: true,
    chainId: null,
    chainIndex: null,
    targetBranch: "main",
    archivedAt: null,
    dispatchAfterTaskId: null,
    dispatchAfter: null,
    assigneeAgent,
    templateStep: currentTemplateStep,
    runs: [last],
  };
  const database = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      // Retry takes the shared task-row lock before it reads anything else.
      $queryRaw: async () => [{ id: "task-1" }],
      agent: { findUnique: async () => lockedAgent(assigneeAgent as Record<string, unknown> | null) },
      task: {
        findUniqueOrThrow: async () => ({ id: "task-1", status: "TODO", archivedAt: null }),
        findUnique: async () => currentTask,
        findMany: async () => [currentTask],
        update: async () => ({}),
      },
      run: {
        count: async () => 0,
        findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => (
          where && Object.keys(where).length === 1 && where.taskId === "task-1" ? last : null
        ),
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (where.id === "run-2" && created) Object.assign(created, data);
          else Object.assign(last, data);
          return last;
        },
        groupBy: async () => [{
          taskId: "task-1",
          status: "FAILED",
          _count: { _all: 1 },
          _max: { budgetGrants: 0 },
        }],
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created = data;
          return { id: "run-2", ...data };
        },
      },
      agentRepoAccess: { count: async () => 1 },
      taskActivity: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          activities.push(data);
          return data;
        },
      },
    }),
  } as unknown as PrismaClient;
  const response = await createApp(database).request("/tasks/task-1/retry", {
    method: "POST",
    headers: { Authorization: "Bearer operator-unit-token" },
  });
  return { response, created, last, activities };
};

type SessionEventQuery = { where?: Record<string, any>; select?: Record<string, unknown>; sql?: string; values?: unknown[] };

/** `events.queries` records every event query the detail route
 *  issues, which is what proves the diagnostics read does not grow per run. */
const taskDetailDatabase = (
  task: Record<string, unknown>,
  events: {
    rows?: Array<Record<string, unknown>>;
    queries?: SessionEventQuery[];
    baselines?: Array<Record<string, unknown>>;
  } = {},
): PrismaClient => ({
  task: { findUnique: async () => task, findMany: async () => [task] },
  run: { groupBy: async () => [] },
  $queryRaw: async (query: { sql: string; values: unknown[] }) => {
    // The detail route issues two raw reads. Only the tool-event one carries
    // the projection this double models.
    if (/percentile_cont/u.test(query.sql)) {
      events.queries?.push(query);
      return events.baselines ?? [];
    }
    events.queries?.push(query);
    // Model the SQL projection, including a large provider output that must
    // never be selected into the metrics input.
    assert.match(query.sql, /jsonb_build_object/u);
    assert.doesNotMatch(query.sql, /SELECT[\s\S]*?,\s*"payload"\s*(?:,|FROM)/u);
    assert.match(query.sql, /"payload"->>'type' = 'assistant'/u);
    assert.match(query.sql, /"payload"->>'type' = 'item.completed' AND "payload"->'item'->>'type' = 'agent_message'/u);
    assert.match(query.sql, /"type"::text = 'MODEL_COMPLETED'\s+AND "payload"->>'type' = 'message_end'\s+AND "payload"->'message'->>'role' = 'assistant'/u);
    const keys = [...query.sql.matchAll(/'([^']+)',/gu)].map((match) => match[1]!);
    assert.deepEqual(keys, ["type", "name", "toolName", "is_error", "isError", "exit_code", "error", "anneal", "ttftMs"]);
    return (events.rows ?? []).flatMap((row) => {
      if (!query.values.includes(row.sessionId)) return [];
      const payload = row.payload as Record<string, unknown>;
      const item = payload.item as Record<string, unknown> | undefined;
      const message = payload.message as Record<string, unknown> | undefined;
      const completion = row.type === "MODEL_DELTA" && (
        payload.type === "assistant"
        || (payload.type === "item.completed" && item?.type === "agent_message")
      ) || row.type === "MODEL_COMPLETED" && payload.type === "message_end" && message?.role === "assistant";
      if (!completion && row.type !== "TOOL_STARTED" && row.type !== "TOOL_COMPLETED") return [];
      return [{
        ...row,
        payload: Object.fromEntries(Object.entries(payload).filter(([key]) => keys.includes(key))),
      }];
    });
  },
  sessionEvent: {
    findMany: async (args: SessionEventQuery) => {
      events.queries?.push(args);
      const types = args.where?.type?.in as string[] | undefined;
      const sessionIds = args.where?.sessionId?.in as string[] | undefined
        ?? (args.where?.sessionId === undefined ? undefined : [args.where.sessionId as string]);
      return (events.rows ?? []).filter((row) => (
        (types === undefined || types.includes(row.type as string))
        && (sessionIds === undefined || sessionIds.includes(row.sessionId as string))
      ));
    },
  },
  agentRepoAccess: { findMany: async () => [{ projectId: task.projectId, agentId: task.assigneeAgentId, repoId: task.repoId }] },
  mergeRecoveryAttempt: { findFirst: async () => null },
} as unknown as PrismaClient);

test("task status patch does not apply create defaults to other fields", async () => {
  await withTokens(async () => {
    let updateData: unknown;
    // A status write now runs under the Task-row mutex, so the mock supplies
    // `$transaction` and the `FOR UPDATE` read the route takes first.
    const tx = {
      $queryRaw: async (_strings: unknown, taskId: string) => [{ id: taskId, status: "REVIEW", archivedAt: null }],
      task: {
        findUniqueOrThrow: async () => ({ id: "task-1", projectId: "project-1", status: "REVIEW", archivedAt: null, assigneeType: "HUMAN", chainId: null, dispatchAfterTaskId: null, dispatchAfter: null }),
        // §D-P7's stop-state guard loads the task with its template step before
        // any status write. An ordinary task has no step, and the guard is then
        // a no-op — but it still asks.
        findUnique: async () => ({ id: "task-1", projectId: "project-1", status: "REVIEW", archivedAt: null, assigneeType: "HUMAN", chainId: null, templateStep: null }),
        update: async ({ data }: { data: unknown }) => { updateData = data; return { id: "task-1", status: "DONE" }; },
      },
      run: { count: async () => 0 },
      inboxMessage: { findFirst: async () => null, updateMany: async () => ({ count: 0 }), count: async () => 0 },
      taskActivity: { create: async () => ({ id: "activity-1" }) },
    };
    const database = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/tasks/task-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(updateData, { status: "DONE" });
  });
});

test("task PATCH names and rejects an invalid compound implementation assignee before writing", async () => {
  await withTokens(async () => {
    let updates = 0;
    const before = {
      id: "implementation-1",
      projectId: "project-1",
      name: "Implementation",
      description: "execute the plan",
      status: "TODO",
      archivedAt: null,
      assigneeType: "AGENT",
      assigneeAgentId: "executioner-1",
      repoId: "repo-1",
      templateStepId: "step-5",
      chainId: "chain-1",
      approvalGate: false,
    };
    // §R14: what disqualifies this assignee is its runtime configuration, not
    // its name — a Claude agent cannot execute the compound implementation root.
    const senior = {
      id: "senior-1",
      projectId: before.projectId,
      name: "senior-dev-opus-medium",
      model: "claude-opus-5:medium",
      runnerPreference: RunnerPreference.CLAUDE,
      archivedAt: null,
    };
    const database = {
      task: {
        findUniqueOrThrow: async () => before,
        update: async () => { updates += 1; return before; },
      },
      agent: { findFirst: async () => senior },
      taskTemplateStep: { findUnique: async () => ({
        stepIndex: 5,
        outputKind: "implementation",
        taskTemplate: { name: "compound-engineer-workflow" },
      }) },
    } as unknown as PrismaClient;
    const response = await createApp(database).request(`/tasks/${before.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeAgentId: senior.id }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Compound implementation step requires an active in-project Agent on a Codex gpt-* model",
      code: COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE,
    });
    assert.equal(updates, 0);
  });
});

test("task create requires chainId and chainIndex together", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/projects/project-1/tasks", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Broken chain", chainId: "chain-1" }),
    });
    assert.equal(response.status, 400);
  });
});

test("POST merge-tail repair is operator-authenticated and returns the action's typed result", async () => {
  await withTokens(async () => {
    const tx = { task: { findUnique: async () => null } };
    const database = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/tasks/missing/merge-tail/repair", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "repair-request-1" }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Task not found" });
  });
});

test("POST merge-tail rerun is operator-authenticated and returns the action's typed result", async () => {
  await withTokens(async () => {
    const tx = { task: { findUnique: async () => null } };
    const database = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/tasks/missing/merge-tail/rerun", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "rerun-request-1" }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Task not found" });
  });
});

test("public task creation assigns a linear layer and rejects layer/dependency inputs", async () => {
  await withTokens(async () => {
    let stored: Record<string, unknown> | undefined;
    const database = {
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
        task: {
          count: async () => 0,
          create: async ({ data }: { data: Record<string, unknown> }) => {
            stored = data;
            return { id: "task-1", ...data };
          },
        },
        taskActivity: { create: async () => ({}) },
        $queryRaw: async () => [{ locked: "" }],
      }),
    } as unknown as PrismaClient;
    const created = await createApp(database).request("/projects/project-1/tasks", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Layered API task", assigneeType: "HUMAN", chainId: "chain-1", chainIndex: 4,
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(stored?.chainLayer, 4);

    for (const field of ["layer", "chainLayer", "dependencies", "blockedBy"]) {
      const response = await createApp({} as PrismaClient).request("/projects/project-1/tasks", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Rejected", assigneeType: "HUMAN", [field]: field === "layer" ? 2 : [] }),
      });
      assert.equal(response.status, 400, field);
    }
  });
});

test("operator DONE on an AGENT chain task is refused without closing its gate", async () => {
  await withTokens(async () => {
    let closed = false;
    const successor = {
      id: "task-2", projectId: "project-1", name: "Next", description: "next", chainId: "chain-1", chainIndex: 1,
      updatedAt: new Date(), assigneeType: "AGENT", assigneeAgentId: "agent-1", repoId: "repo-1", templateId: null,
      targetBranch: "main", maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 5, runs: [],
      assigneeAgent: { id: "agent-1", model: "claude", runnerPreference: "CLAUDE", foundationalPrompt: "f", rolePrompt: "r" },
      repo: { id: "repo-1", defaultBranch: "main" }, templateStep: null, archivedAt: null,
    };
    const before = { id: "task-1", projectId: "project-1", name: "Gate", status: "REVIEW", templateId: null, approvalGate: true, chainId: "chain-1", chainIndex: 0, assigneeType: "AGENT", assigneeAgentId: "agent-1", repoId: "repo-1", archivedAt: null, dispatchAfterTaskId: null, dispatchAfter: null };
    const tx = {
      // The status write takes the Task-row mutex before advancing the chain.
      $queryRaw: async (_strings: unknown, taskId: string) => [{ id: taskId }],
      task: {
        update: async () => ({ ...before, status: "DONE" }),
        findFirst: async () => successor,
        findMany: async () => [before],
        findUnique: async ({ where }: { where: { id: string } }) => where.id === before.id ? before : successor,
        updateMany: async () => ({ count: 1 }),
        findUniqueOrThrow: async () => successor,
      },
      inboxMessage: {
        findFirst: async () => null,
        updateMany: async () => { closed = true; return { count: 1 }; },
        count: async () => 1,
      },
      taskActivity: { create: async () => ({}) },
      chainControl: { findMany: async () => [] },
      // findFirst answers resolveRunBranches' publication query: nothing in this
      // chain has pushed the shared branch, so the successor bases on the default.
      run: { create: async () => ({ id: "run-1" }), findFirst: async () => null, count: async () => 0 },
      agent: { findUnique: async () => lockedAgent(successor.assigneeAgent) },
    };
    const database = {
      task: { findUniqueOrThrow: async () => before },
      agentRepoAccess: { findFirst: async () => ({}) },
      // §D-P4 resolves the effective assignee's *name* before allowing a
      // reassignment, because the invariant is stated over the name.
      agent: { findUnique: async () => ({ name: "senior-dev-astra-medium" }) },
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/tasks/task-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });
    assert.equal(response.status, 409);
    assert.match(String((await response.json() as { error: string }).error), /controlled by chain execution/u);
    assert.equal(closed, false);
  });
});

test("a template HUMAN final step closes its exact OPEN gate even when approvalGate is false", async () => {
  await withTokens(async () => {
    let closedWhere: unknown;
    const before = {
      id: "task-1", projectId: "project-1", name: "Human final", status: "REVIEW", templateId: "template-1",
      approvalGate: false, chainId: "chain-1", chainIndex: 2,
      assigneeType: "HUMAN", assigneeAgentId: null, repoId: null, archivedAt: null,
      dispatchAfterTaskId: null, dispatchAfter: null,
    };
    const tx = {
      $queryRaw: async () => [{ id: before.id }],
      task: {
        findUniqueOrThrow: async () => before,
        findUnique: async () => before,
        findMany: async () => [before],
        update: async () => ({ ...before, status: "DONE" }),
        findFirst: async () => null,
      },
      run: { count: async () => 0 },
      inboxMessage: {
        findFirst: async () => null,
        updateMany: async ({ where }: { where: unknown }) => { closedWhere = where; return { count: 1 }; },
        count: async () => 1,
      },
      taskActivity: { create: async () => ({}) },
      chainControl: { findMany: async () => [] },
    };
    const database = {
      task: { findUniqueOrThrow: async () => before },
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/tasks/task-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(closedWhere, { gateTaskId: before.id, status: "OPEN" });
  });
});

test("a stale HUMAN gate approval PATCH cannot replay an answered rejection", async () => {
  await withTokens(async () => {
    let updates = 0;
    const predecessor = {
      id: "task-1", name: "Agent predecessor", status: "TODO", chainIndex: 0, chainLayer: 1,
    };
    const successor = {
      id: "task-2", projectId: "project-1", name: "Human gate", status: "TODO", templateId: null,
      templateStepId: null, templateStep: null, approvalGate: false, chainId: "chain-1", chainIndex: 1,
      chainLayer: 2, assigneeType: "HUMAN", assigneeAgentId: null, repoId: null, archivedAt: null,
      dispatchAfterTaskId: null, dispatchAfter: null, scheduleKind: null,
    };
    const tx = {
      $queryRaw: async () => [{ id: successor.id }],
      task: {
        findUniqueOrThrow: async () => successor,
        findUnique: async () => successor,
        findMany: async () => [predecessor, successor],
        update: async () => { updates += 1; return { ...successor, status: "DONE" }; },
      },
      run: { count: async () => 0 },
      inboxMessage: {
        findFirst: async ({ where }: { where: { status: string } }) => where.status === "ANSWERED"
          ? { selectedChoiceId: "reject" }
          : null,
      },
      chainControl: { findMany: async () => [] },
    };
    const database = {
      task: { findUniqueOrThrow: async () => successor },
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;

    const response = await createApp(database).request(`/tasks/${successor.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });

    assert.equal(response.status, 409);
    assert.match(String((await response.json() as { error: string }).error), /durable reject decision/u);
    assert.equal(updates, 0);
  });
});

test("CRON create computes runAt, ignores caller runAt, and creates no immediate run", async () => {
  await withTokens(async () => {
    let stored: Record<string, any> | undefined;
    let runs = 0;
    const agent = { id: "agent-1", runnerPreference: "CLAUDE", model: "claude", foundationalPrompt: "f", rolePrompt: "r" };
    const repo = { id: "repo-1", defaultBranch: "main" };
    const tx = {
      $queryRaw: async () => [{ id: agent.id, archivedAt: null }],
      agent: { findUnique: async () => lockedAgent(agent) },
      task: { create: async ({ data }: { data: Record<string, any> }) => { stored = data; return { id: "task-1", ...data }; } },
      taskActivity: { create: async () => ({}) },
      run: { create: async () => { runs += 1; return {}; } },
    };
    const database = {
      agent: { findFirst: async () => agent }, repo: { findFirst: async () => repo },
      agentRepoAccess: { findFirst: async () => ({}) },
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/projects/project-1/tasks", {
      method: "POST", headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Nightly", assigneeAgentId: "agent-1", repoId: "repo-1", scheduleKind: "CRON",
        cron: "0 2 * * *", timezone: "Asia/Shanghai", runAt: "2000-01-01T00:00:00Z",
      }),
    });
    assert.equal(response.status, 201);
    assert.equal(runs, 0);
    assert.ok(stored?.runAt instanceof Date);
    assert.ok(stored!.runAt.getTime() > Date.now());
  });
});

test("schedule create rejects invalid dialect, timezone, missing fields, and non-agent AT", async () => {
  await withTokens(async () => {
    const database = {
      agent: { findFirst: async () => ({ id: "agent-1" }) }, repo: { findFirst: async () => ({ id: "repo-1" }) },
      agentRepoAccess: { findFirst: async () => ({}) },
    } as unknown as PrismaClient;
    const cases = [
      { scheduleKind: "CRON", cron: "0 */2 * * * *" },
      { scheduleKind: "CRON", cron: "* * * * * *" },
      { scheduleKind: "CRON", cron: "@daily" },
      { scheduleKind: "CRON", cron: "0 2 * * *", timezone: "Mars/Olympus" },
      { scheduleKind: "CRON" },
      { scheduleKind: "AT", assigneeType: "HUMAN", runAt: new Date().toISOString() },
      { scheduleKind: "AT", assigneeAgentId: "agent-1", runAt: null },
    ];
    for (const value of cases) {
      const response = await createApp(database).request("/projects/project-1/tasks", {
        method: "POST", headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Invalid", ...value }),
      });
      assert.equal(response.status, 400, JSON.stringify(value));
    }
  });
});

test("AT create waits for the scheduler and merged-view patch cannot remove its executor", async () => {
  await withTokens(async () => {
    let runs = 0;
    const runAt = new Date(Date.now() - 60_000);
    const before = { id: "task-1", projectId: "project-1", status: "TODO", templateId: null, approvalGate: false, chainId: null, scheduleKind: "AT", runAt, cron: null, timezone: null, assigneeType: "AGENT", assigneeAgentId: "agent-1", repoId: "repo-1" };
    const database = {
      agent: { findFirst: async () => ({ id: "agent-1", runnerPreference: "CLAUDE", model: "claude", foundationalPrompt: "f", rolePrompt: "r" }) },
      repo: { findFirst: async () => ({ id: "repo-1", defaultBranch: "main" }) },
      agentRepoAccess: { findFirst: async () => ({}) },
      task: { findUniqueOrThrow: async () => before },
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [{ id: "agent-1", archivedAt: null }],
        agent: { findUnique: async () => lockedAgent({ id: "agent-1", runnerPreference: "CLAUDE", model: "claude", foundationalPrompt: "f", rolePrompt: "r" }) },
        task: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "task-1", ...data }) },
        taskActivity: { create: async () => ({}) }, run: { create: async () => { runs += 1; return {}; } },
      }),
    } as unknown as PrismaClient;
    const created = await createApp(database).request("/projects/project-1/tasks", {
      method: "POST", headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Later", scheduleKind: "AT", runAt, assigneeAgentId: "agent-1", repoId: "repo-1" }),
    });
    assert.equal(created.status, 201);
    assert.equal(runs, 0);
    const patched = await createApp(database).request("/tasks/task-1", {
      method: "PATCH", headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeType: "HUMAN", assigneeAgentId: null }),
    });
    assert.equal(patched.status, 400);
  });
});

test("operator retry re-derives runtime configuration and clears promptHash until dispatch", async () => {
  await withTokens(async () => {
    const { response, created, last } = await retryRequest({
      id: "current-agent",
      model: "deepseek-current",
      runnerPreference: RunnerPreference.PI,
      foundationalPrompt: "new foundation",
      rolePrompt: "new role",
    });
    assert.equal(response.status, 201);
    assert.equal(created?.agentId, "current-agent");
    assert.equal(created?.repoId, "repo-current");
    assert.equal(created?.runner, RunnerKind.PI);
    assert.equal(created?.model, "deepseek-current");
    assert.equal(created?.promptHash, null);
    assert.equal(created?.branch, last.branch);
    assert.equal(created?.targetBranch, last.targetBranch);
    assert.equal(created?.maxRunsPerTask, last.maxRunsPerTask);
  });
});

test("operator retry resets an exhausted lease-loss counter for Regression", async () => {
  await withTokens(async () => {
    const { response, created, last, activities } = await retryRequest({
      id: "old-agent",
      model: "old-model",
      runnerPreference: RunnerPreference.CLAUDE,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    }, {
      runner: RunnerKind.CLAUDE,
      outputKind: "regression-verification-v2",
    }, { leaseLossRefunds: 3, taskStatus: "REVIEW", failureReason: `Lease-loss retry refused: ${LEASE_LOSS_REFUND_EXHAUSTED_PREFIX} after 3 platform-refunded attempts; raise maxSessionsPerTask and retry` });
    assert.equal(response.status, 201, JSON.stringify(await response.json()));
    assert.equal(created?.leaseLossRefunds, 0);
    assert.equal(last.leaseLossRefunds, 3, "the historical source Run remains unchanged");
    assert.deepEqual(activities, [{
      taskId: "task-1",
      actorType: "operator",
      body: "Lease-loss refund counter reset from 3 to 0 by operator retry",
      metadata: { kind: "lease-loss-refunds-reset", previous: 3, current: 0 },
    }, {
      taskId: "task-1",
      actorType: "operator",
      body: "Run 2 queued by operator retry",
    }]);
  });
});

test("operator retry does not reset the lease-loss counter on an ordinary task", async () => {
  await withTokens(async () => {
    const { response, created, last, activities } = await retryRequest({
      id: "old-agent",
      model: "old-model",
      runnerPreference: RunnerPreference.CLAUDE,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    }, null, { leaseLossRefunds: 3, taskStatus: "REVIEW", failureReason: `Lease-loss retry refused: ${LEASE_LOSS_REFUND_EXHAUSTED_PREFIX} after 3 platform-refunded attempts; raise maxSessionsPerTask and retry` });
    assert.equal(response.status, 201);
    assert.equal(created?.leaseLossRefunds, 3);
    assert.equal(last.leaseLossRefunds, 3);
    assert.deepEqual(activities, [{
      taskId: "task-1",
      actorType: "operator",
      body: "Run 2 queued by operator retry",
    }]);
  });
});

test("a refused Regression retry leaves its lease-loss counter and reset activity untouched", async () => {
  await withTokens(async () => {
    const { response, created, last, activities } = await retryRequest({
      id: "old-agent",
      model: "old-model",
      runnerPreference: RunnerPreference.CLAUDE,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    }, {
      runner: RunnerKind.CLAUDE,
      outputKind: "regression-verification-v2",
    }, {
      leaseLossRefunds: 3,
      taskStatus: "REVIEW",
      failureReason: `Lease-loss retry refused: ${LEASE_LOSS_REFUND_EXHAUSTED_PREFIX} after 3 platform-refunded attempts; raise maxSessionsPerTask and retry`,
      maxSessionsPerTask: 1,
    });
    assert.equal(response.status, 409);
    assert.equal(created, undefined);
    assert.equal(last.leaseLossRefunds, 3);
    assert.deepEqual(activities, []);
  });
});

test("operator retry with unchanged agent preserves runtime config but not a prior dispatch hash", async () => {
  await withTokens(async () => {
    const { response, created } = await retryRequest({
      id: "old-agent",
      model: "old-model",
      runnerPreference: RunnerPreference.CLAUDE,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    });
    assert.equal(response.status, 201);
    assert.deepEqual({
      agentId: created?.agentId,
      repoId: created?.repoId,
      runner: created?.runner,
      model: created?.model,
      branch: created?.branch,
      targetBranch: created?.targetBranch,
      maxDurationMin: created?.maxDurationMin,
      stallTimeoutMin: created?.stallTimeoutMin,
      maxRunsPerTask: created?.maxRunsPerTask,
      promptHash: created?.promptHash,
    }, {
      agentId: "old-agent",
      repoId: "repo-current",
      runner: RunnerKind.CLAUDE,
      model: "old-model",
      branch: "feature/retry",
      targetBranch: "main",
      maxDurationMin: 90,
      stallTimeoutMin: 7,
      maxRunsPerTask: 4,
      promptHash: null,
    });
  });
});

test("operator retry honors a template-step runner override", async () => {
  await withTokens(async () => {
    const { response, created } = await retryRequest({
      id: "agent-1",
      model: "deepseek-current",
      runnerPreference: RunnerPreference.PI,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    }, { runner: RunnerKind.CODEX });
    assert.equal(response.status, 201);
    assert.equal(created?.runner, RunnerKind.CODEX);
  });
});

// §R14 replaced the name-based invariant with a capability predicate, so the
// pair below is the whole rule: any Codex `gpt-*` Agent may hold the compound
// implementation root, and no other Agent may, whatever it is called.
test("operator retry refuses a compound implementation Step whose assignee cannot run Codex gpt-*", async () => {
  await withTokens(async () => {
    const { response, created } = await retryRequest({
      id: "agent-1",
      model: "claude-opus-5:medium",
      runnerPreference: RunnerPreference.CLAUDE,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
      name: "senior-dev-opus-medium",
    }, {
      runner: RunnerKind.CODEX,
      stepIndex: 5,
      outputKind: "implementation",
      taskTemplate: { name: "compound-engineer-workflow" },
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Compound implementation step requires an active in-project Agent on a Codex gpt-* model",
      code: "COMPOUND_IMPLEMENTATION_ASSIGNEE_INVALID",
    });
    assert.equal(created, undefined);
  });
});

test("operator retry admits any Codex gpt-* Agent on a compound implementation Step", async () => {
  await withTokens(async () => {
    const { response, created } = await retryRequest({
      id: "agent-1",
      projectId: "project-1",
      model: "gpt-5.6-sol:high",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
      name: "senior-dev-sol-high",
    }, {
      runner: RunnerKind.CODEX,
      stepIndex: 5,
      outputKind: "implementation",
      taskTemplate: { name: "compound-engineer-workflow" },
    });
    assert.equal(response.status, 201, JSON.stringify(await response.json()));
    assert.equal(created?.model, "gpt-5.6-sol:high");
    assert.equal(created?.runner, RunnerKind.CODEX);
  });
});

test("operator retry returns 409 when the task assignee no longer exists", async () => {
  await withTokens(async () => {
    const { response, created } = await retryRequest(null);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Task assignee no longer exists; assign an agent before retrying",
    });
    assert.equal(created, undefined);
  });
});

test("operator retry rejects an archived assignee with a named 409", async () => {
  await withTokens(async () => {
    const { response, created } = await retryRequest({
      id: "agent-archived",
      model: "model",
      runnerPreference: RunnerPreference.CLAUDE,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
      archivedAt: new Date(),
      name: "Archived Ada",
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Assignee Archived Ada is archived; unarchive it to retry" });
    assert.equal(created, undefined);
  });
});

test("a task creation that loses the Agent-row race writes neither task nor run", async () => {
  await withTokens(async () => {
    // The unlocked check above the transaction sees a live agent; the archive
    // commits; the locked re-read inside the transaction is what decides.
    let taskCreates = 0;
    const database = {
      agent: { findFirst: async () => ({ id: "agent-1", name: "Agent", archivedAt: null, runnerPreference: "CLAUDE", model: "claude", foundationalPrompt: "f", rolePrompt: "r" }) },
      repo: { findFirst: async () => ({ id: "repo-1", defaultBranch: "main" }) },
      agentRepoAccess: { findFirst: async () => ({}) },
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [{ id: "agent-1", archivedAt: new Date() }],
        agent: { findUnique: async () => lockedAgent({ id: "agent-1", name: "Agent", archivedAt: new Date(), runnerPreference: "CLAUDE", model: "claude", foundationalPrompt: "f", rolePrompt: "r" }) },
        task: { create: async () => { taskCreates += 1; return { id: "task-1" }; } },
        taskActivity: { create: async () => ({}) },
        run: { create: async () => { throw new Error("must not create run"); } },
      }),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/projects/project-1/tasks", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Race", description: "race", assigneeAgentId: "agent-1", repoId: "repo-1" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Assignee Agent is archived" });
    assert.equal(taskCreates, 0);
  });
});

test("task create and patch reject an archived assignee with a named 400", async () => {
  await withTokens(async () => {
    const archived = { id: "agent-archived", name: "Archived Ada", archivedAt: new Date() };
    const createDb = {
      agent: { findFirst: async () => archived },
    } as unknown as PrismaClient;
    const created = await createApp(createDb).request("/projects/project-1/tasks", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Blocked", assigneeAgentId: archived.id, repoId: "repo-1" }),
    });
    assert.equal(created.status, 400);
    assert.deepEqual(await created.json(), { error: "Assignee Archived Ada is archived" });

    const patchDb = {
      task: { findUniqueOrThrow: async () => ({ id: "task-1", projectId: "project-1", assigneeAgentId: null, repoId: null }) },
      agent: { findFirst: async () => archived },
    } as unknown as PrismaClient;
    const patched = await createApp(patchDb).request("/tasks/task-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeAgentId: archived.id }),
    });
    assert.equal(patched.status, 400);
    assert.deepEqual(await patched.json(), { error: "Assignee Archived Ada is archived" });
  });
});

test("archiving a Chain closes only its OPEN merge-tail stop notices", async () => {
  await withTokens(async () => {
    const fixture = archiveRouteDatabase({ messages: [
      { id: "stop-1", taskId: "regression-task", dedupeKey: "merge-tail-stop:regression-task:one", status: InboxStatus.OPEN, answeredAt: null },
      { id: "stop-2", taskId: "regression-task", dedupeKey: "merge-tail-stop:regression-task:two", status: InboxStatus.OPEN, answeredAt: null },
      { id: "question-1", taskId: "regression-task", dedupeKey: "question:regression-task", status: InboxStatus.OPEN, answeredAt: null },
      { id: "readiness-1", taskId: "regression-task", dedupeKey: "merge-readiness-stop:regression-task", status: InboxStatus.OPEN, answeredAt: null },
      { id: "other-task-stop", taskId: "other-task", dedupeKey: "merge-tail-stop:other-task:one", status: InboxStatus.OPEN, answeredAt: null },
    ] });
    const response = await createApp(fixture.database).request("/tasks/regression-task/archive", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token" },
    });

    assert.equal(response.status, 200);
    const stopNotices = fixture.messages.filter((message) => message.id.startsWith("stop-"));
    assert.equal(stopNotices.length, 2);
    for (const notice of stopNotices) {
      assert.equal(notice.status, InboxStatus.CLOSED);
      assert.ok(notice.answeredAt instanceof Date);
    }
    const unrelated = fixture.messages.find((message) => message.id === "question-1");
    assert.equal(unrelated?.status, InboxStatus.OPEN);
    assert.equal(unrelated?.answeredAt, null);
    assert.equal(fixture.messages.find((message) => message.id === "readiness-1")?.status, InboxStatus.OPEN);
    assert.equal(fixture.messages.find((message) => message.id === "other-task-stop")?.status, InboxStatus.OPEN);

    const closureActivities = fixture.activities.filter((activity) => activity.actorType === "control-plane");
    assert.deepEqual(closureActivities, [{
      taskId: "regression-task",
      actorType: "control-plane",
      body: "Closed merge-tail stop notices: stop-1, stop-2",
      metadata: { inboxMessageIds: ["stop-1", "stop-2"] },
    }]);
  });
});

test("archiving a Chain with no merge-tail stop notices writes no Inbox closure", async () => {
  await withTokens(async () => {
    const fixture = archiveRouteDatabase({ messages: [] });
    const response = await createApp(fixture.database).request("/tasks/regression-task/archive", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token" },
    });

    assert.equal(response.status, 200);
    assert.equal(fixture.inboxUpdateManyCalls, 0);
    assert.equal(fixture.activities.some((activity) => activity.actorType === "control-plane"), false);
  });
});

test("archive refuses an active Chain run before touching Inbox messages", async () => {
  await withTokens(async () => {
    const fixture = archiveRouteDatabase({ activeRuns: 1, messages: [
      { id: "stop-1", taskId: "regression-task", dedupeKey: "merge-tail-stop:regression-task:one", status: InboxStatus.OPEN, answeredAt: null },
    ] });
    const response = await createApp(fixture.database).request("/tasks/regression-task/archive", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token" },
    });

    assert.equal(response.status, 409);
    assert.equal(fixture.inboxFindManyCalls, 0);
    assert.equal(fixture.inboxUpdateManyCalls, 0);
    assert.equal(fixture.messages[0]?.status, InboxStatus.OPEN);
    assert.equal(fixture.activities.length, 0);
  });
});

test("archive refuses an active chain-detached repair run before touching Inbox messages", async () => {
  await withTokens(async () => {
    const fixture = archiveRouteDatabase({
      repairTaskIds: ["repair-task"],
      activeRunTaskIds: ["repair-task"],
      messages: [
        { id: "stop-1", taskId: "regression-task", dedupeKey: "merge-tail-stop:regression-task:one", status: InboxStatus.OPEN, answeredAt: null },
      ],
    });
    const response = await createApp(fixture.database).request("/tasks/regression-task/archive", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token" },
    });

    assert.equal(response.status, 409);
    assert.equal(fixture.inboxFindManyCalls, 0);
    assert.equal(fixture.inboxUpdateManyCalls, 0);
    assert.equal(fixture.messages[0]?.status, InboxStatus.OPEN);
    assert.equal(fixture.activities.length, 0);
  });
});

test("a concurrent close of a selected stop notice does not roll back archive", async () => {
  await withTokens(async () => {
    const fixture = archiveRouteDatabase({
      closeDuringUpdateIds: ["stop-2"],
      messages: [
        { id: "stop-1", taskId: "regression-task", dedupeKey: "merge-tail-stop:regression-task:one", status: InboxStatus.OPEN, answeredAt: null },
        { id: "stop-2", taskId: "regression-task", dedupeKey: "merge-tail-stop:regression-task:two", status: InboxStatus.OPEN, answeredAt: null },
      ],
    });
    const response = await createApp(fixture.database).request("/tasks/regression-task/archive", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token" },
    });

    assert.equal(response.status, 200);
    assert.ok(fixture.messages.every((message) => message.status === InboxStatus.CLOSED));
    assert.equal(fixture.activities.filter((activity) => activity.actorType === "control-plane").length, 1);
  });
});

test("archive fails loud when a selected stop notice remains OPEN", async () => {
  await withTokens(async () => {
    const fixture = archiveRouteDatabase({
      skipUpdateIds: ["stop-2"],
      messages: [
        { id: "stop-1", taskId: "regression-task", dedupeKey: "merge-tail-stop:regression-task:one", status: InboxStatus.OPEN, answeredAt: null },
        { id: "stop-2", taskId: "regression-task", dedupeKey: "merge-tail-stop:regression-task:two", status: InboxStatus.OPEN, answeredAt: null },
      ],
    });
    const response = await createApp(fixture.database).request("/tasks/regression-task/archive", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token" },
    });

    assert.equal(response.status, 500);
    assert.equal(fixture.messages.find((message) => message.id === "stop-2")?.status, InboxStatus.OPEN);
  });
});

test("GET /tasks?view=board answers with the card projection, not the whole row", async () => {
  await withTokens(async () => {
    const response = await getTasks(boardDatabase([taskRow()]), "?view=board");
    assert.equal(response.status, 200);
    const body = await response.json() as Array<Record<string, unknown>>;
    assert.equal(body.length, 1);
    // The fields the board reads survive...
    assert.equal(body[0]!.name, "Ship the thing");
    assert.equal(body[0]!.displayName, "Ship the thing");
    assert.deepEqual(body[0]!.latestRun, {
      id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5", codexServiceTier: "DEFAULT",
      costUsd: "0.42", startedAt: null, endedAt: null, pullRequestUrl: null,
      // The run settled, so the phase is finished and dated from the Run's own
      // end: the card reads this instead of counting a clock that never stops.
      phase: "finished", phaseSince: "2026-08-16T00:05:00.000Z", lastProgressEventAt: null, maxRunsPerTask: 5,
    });
    assert.deepEqual(body[0]!.taskCost, {
      costUsd: "0.42", estimated: false, inputTokens: null, cachedInputTokens: null,
      cacheCreationInputTokens: null, outputTokens: null,
    });
    // ...and the ones it does not are gone, which is the entire point.
    for (const dropped of ["description", "repo", "runs", "maxDurationMin", "workingDirectory"]) {
      assert.equal(dropped in body[0]!, false, `${dropped} must not ride along`);
    }
  });
});

test("GET /tasks/:id projects per-run and cumulative usage costs", async () => {
  await withTokens(async () => {
    const task = taskRow({
      assigneeType: "AGENT",
      description: "detail",
      runs: [
        {
          id: "prefixed-run", runNumber: 2, status: "SUCCEEDED", model: "openai-codex/gpt-5.6-sol:high",
          subagentModel: "gpt-5.6-luna:max",
          session: {
            nativeChildUsed: false, costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 400_000,
            cacheCreationInputTokens: 0, outputTokens: 100_000,
            startedAt: null, endedAt: null,
          },
        },
        {
          id: "reported-run", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5:medium",
          subagentModel: null,
          session: {
            costUsd: "0.42", inputTokens: null, cachedInputTokens: null,
            cacheCreationInputTokens: null, outputTokens: null,
            startedAt: null, endedAt: null,
          },
        },
        { id: "unreported-run", runNumber: 0, status: "SUCCEEDED", model: "gpt-5.6-luna:max", subagentModel: null, session: null },
      ],
    });
    const response = await createApp(taskDetailDatabase(task)).request("/tasks/t1", {
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      taskCost: { costUsd: string; estimated: boolean; inputTokens: number | null; cachedInputTokens: number | null; cacheCreationInputTokens: number | null; outputTokens: number | null };
      runs: Array<{ id: string; session: { usageCost: { costUsd: string; estimated: boolean } } | null }>;
    };
    assert.deepEqual(body.taskCost, {
      costUsd: "6.62", estimated: true, inputTokens: 1_000_000, cachedInputTokens: 400_000,
      cacheCreationInputTokens: 0, outputTokens: 100_000,
    });
    assert.deepEqual(body.runs.map((run) => ({ id: run.id, usageCost: run.session?.usageCost ?? null })), [
      { id: "prefixed-run", usageCost: { costUsd: "6.2", estimated: true, inputTokens: 1_000_000, cachedInputTokens: 400_000, cacheCreationInputTokens: 0, outputTokens: 100_000 } },
      { id: "reported-run", usageCost: { costUsd: "0.42", estimated: false, inputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: null, outputTokens: null } },
      { id: "unreported-run", usageCost: null },
    ]);
    assert.equal("moveTargets" in body, true, "the detail shape keeps operator move targets");
    for (const listOnly of ["chainProgress", "recurringLastFiredAt", "recurringFireCount"]) {
      assert.equal(listOnly in body, false, `${listOnly} must remain list-only`);
    }
  });
});

test("the board derives a shared title and badge for API-created chains", async () => {
  await withTokens(async () => {
    const response = await getTasks(boardDatabase([
      taskRow({ id: "build", chainId: "direct", chainIndex: 0, name: "Release: Build", templateStep: null }),
      taskRow({ id: "review", chainId: "direct", chainIndex: 1, name: "Release: Review", templateStep: null }),
    ]), "?view=board");
    assert.equal(response.status, 200);
    const body = await response.json() as Array<{ id: string; name: string; displayName: string; chainName: string | null }>;
    assert.deepEqual(body.map(({ id, name, displayName, chainName }) => ({ id, name, displayName, chainName })), [
      { id: "build", name: "Release: Build", displayName: "Build", chainName: "Release" },
      { id: "review", name: "Release: Review", displayName: "Review", chainName: "Release" },
    ]);
  });
});

test("the board binds a chain-detached repair task to the chain its marker names", async () => {
  await withTokens(async () => {
    const response = await getTasks(boardDatabase(
      [
        taskRow({ id: "regression", chainId: "c1", chainIndex: 1, name: "Release: Regression", templateStep: { name: "Regression" } }),
        taskRow({ id: "repair", name: "Autonomous merge tail: gate-fix", templateStep: null }),
      ],
      {
        related: [{ id: "regression", projectId: "p1", chainId: "c1" }],
        activity: [{ taskId: "repair", metadata: {
          schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", regressionTaskId: "regression",
        } }],
      },
    ), "?view=board");
    assert.equal(response.status, 200);
    const body = await response.json() as Array<{ id: string; chainId: string | null; repairOf: unknown }>;
    const repair = body.find((card) => card.id === "repair")!;
    // The repair task stays chain-detached on the wire — the binding is the
    // read side's answer to where the card belongs, not a chain column.
    assert.equal(repair.chainId, null);
    assert.deepEqual(repair.repairOf, { chainId: "c1", chainName: "Release", repairKind: "gate-fix" });
    assert.equal(body.find((card) => card.id === "regression")!.repairOf, null);
  });
});

test("a global board keeps two projects' same-named chains apart when it binds their repairs", async () => {
  await withTokens(async () => {
    // `chainId` is unique per project, not globally, so a board that spans
    // projects can hold the same one twice. A repair card must be named by its
    // own project's chain, not by whichever came first on the page.
    const response = await getTasks(boardDatabase(
      [
        taskRow({ id: "regression-1", chainId: "c1", chainIndex: 1, name: "Release: Regression", templateStep: { name: "Regression" } }),
        taskRow({ id: "repair-1", name: "Autonomous merge tail: gate-fix", templateStep: null }),
        taskRow({ id: "regression-2", projectId: "p2", chainId: "c1", chainIndex: 1, name: "Hotfix: Regression", templateStep: { name: "Regression" } }),
        taskRow({ id: "repair-2", projectId: "p2", name: "Autonomous merge tail: review-fix", templateStep: null }),
      ],
      {
        related: [
          { id: "regression-1", projectId: "p1", chainId: "c1" },
          { id: "regression-2", projectId: "p2", chainId: "c1" },
        ],
        activity: [
          { taskId: "repair-1", metadata: {
            schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", regressionTaskId: "regression-1",
          } },
          { taskId: "repair-2", metadata: {
            schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "review-fix", regressionTaskId: "regression-2",
          } },
        ],
      },
    ), "?view=board");
    assert.equal(response.status, 200);
    const body = await response.json() as Array<{ id: string; repairOf: unknown }>;
    assert.deepEqual(body.find((card) => card.id === "repair-1")!.repairOf, {
      chainId: "c1", chainName: "Release", repairKind: "gate-fix",
    });
    assert.deepEqual(body.find((card) => card.id === "repair-2")!.repairOf, {
      chainId: "c1", chainName: "Hotfix", repairKind: "review-fix",
    });
  });
});

test("GET /tasks?enrich=false keeps creation ordering without enrichment queries", async () => {
  await withTokens(async () => {
    const response = await getTasks(boardDatabase([
      taskRow({ id: "older", createdAt: new Date("2026-08-15T00:00:00Z") }),
      taskRow({ id: "newer", createdAt: new Date("2026-08-16T00:00:00Z") }),
    ]), "?enrich=false");
    assert.equal(response.status, 200);
    const body = await response.json() as Array<{ id: string }>;
    assert.deepEqual(body.map(({ id }) => id), ["newer", "older"]);
  });
});

test("board and full task views order by createdAt descending with a stable id tie-break", async () => {
  await withTokens(async () => {
    const rows = [
      taskRow({ id: "older-recently-updated", createdAt: new Date("2026-08-15T00:00:00Z"), updatedAt: new Date("2026-08-20T00:00:00Z") }),
      taskRow({ id: "b-tie", createdAt: new Date("2026-08-16T00:00:00Z"), updatedAt: new Date("2026-08-18T00:00:00Z") }),
      taskRow({ id: "newest", createdAt: new Date("2026-08-17T00:00:00Z"), updatedAt: new Date("2026-08-17T00:00:00Z") }),
      taskRow({ id: "a-tie", createdAt: new Date("2026-08-16T00:00:00Z"), updatedAt: new Date("2026-08-19T00:00:00Z") }),
    ];
    for (const query of ["?view=board", ""]) {
      const response = await getTasks(boardDatabase(rows), query);
      assert.equal(response.status, 200);
      const body = await response.json() as Array<{ id: string }>;
      assert.deepEqual(body.map(({ id }) => id), ["newest", "a-tie", "b-tie", "older-recently-updated"]);
    }
  });
});

/* ------------------------------------- GET /tasks/:taskId run diagnostics */

/** A detail-shaped Run row with the Session columns the diagnostics read. */
const diagnosticsRun = (
  runNumber: number,
  overrides: { sessionId: string } & Record<string, unknown>,
): Record<string, unknown> => ({
  id: `run-${runNumber}`,
  projectId: "project-1",
  taskId: "task-1",
  runNumber,
  status: "SUCCEEDED",
  runner: "CLAUDE",
  model: "claude-opus-5",
  codexServiceTier: "DEFAULT",
  subagentModel: null,
  readyAt: new Date("2026-09-01T10:00:00.000Z"),
  queuedAt: new Date("2026-09-01T10:00:00.000Z"),
  startedAt: new Date("2026-09-01T10:00:20.000Z"),
  endedAt: new Date("2026-09-01T10:02:00.000Z"),
  pushStatus: "PUSHED",
  pushedBranch: null,
  baseSha: null,
  headSha: null,
  terminationReason: null,
  failureClass: null,
  budgetGrants: 0,
  session: {
    id: overrides.sessionId,
    runner: "CLAUDE",
    executionStatus: "SUCCEEDED",
    resumeAttempt: 0,
    provisionedAt: new Date("2026-09-01T10:00:05.000Z"),
    startedAt: new Date("2026-09-01T10:00:20.000Z"),
    endedAt: new Date("2026-09-01T10:02:00.000Z"),
    cleanupStartedAt: null,
    cleanupEndedAt: null,
    inputTokens: 1_000,
    cachedInputTokens: 600,
    cacheCreationInputTokens: 150,
    outputTokens: 400,
    costUsd: null,
    nativeChildUsed: false,
    terminationReason: "provider completed",
    exitCode: 0,
    signal: null,
  },
  ...overrides,
});

const toolEventRow = (
  sessionId: string,
  seq: number,
  type: string,
  toolCallId: string,
  payload: unknown,
): Record<string, unknown> => ({
  id: `${sessionId}-${seq}`,
  sessionId,
  type,
  at: new Date(`2026-09-01T10:00:${String(20 + seq).padStart(2, "0")}.000Z`),
  toolCallId,
  payload,
});

const DIAGNOSTICS_TOOL_EVENTS = [
  toolEventRow("session-2", 1, "TOOL_STARTED", "toolu_1", { type: "tool_use", id: "toolu_1", name: "Bash" }),
  toolEventRow("session-2", 3, "TOOL_COMPLETED", "toolu_1", { type: "tool_result", tool_use_id: "toolu_1", is_error: false, content: "large-tool-output".repeat(100_000) }),
  toolEventRow("session-1", 1, "TOOL_STARTED", "toolu_9", { type: "tool_use", id: "toolu_9", name: "Edit" }),
  toolEventRow("session-1", 5, "TOOL_COMPLETED", "toolu_9", { type: "tool_result", tool_use_id: "toolu_9", is_error: true }),
];

const TTFT_EVENTS = [
  toolEventRow("session-2", 10, "MODEL_DELTA", "", { type: "assistant", anneal: { ttftMs: 10 } }),
  // A first item event can be an observed chunk, but only the completed agent
  // message carries the turn's persisted measurement.
  toolEventRow("session-2", 11, "MODEL_DELTA", "", { type: "item.started", item: { type: "agent_message" }, anneal: { ttftMs: 999 } }),
  toolEventRow("session-2", 12, "MODEL_DELTA", "", { type: "item.completed", item: { type: "agent_message" }, anneal: { ttftMs: 20 } }),
  // PI repeats assistant messages on turn_end; it is not the completion row
  // that owns the persisted measurement.
  toolEventRow("session-2", 13, "MODEL_COMPLETED", "", { type: "turn_end", message: { role: "assistant" }, anneal: { ttftMs: 888 } }),
  toolEventRow("session-2", 14, "MODEL_COMPLETED", "", { type: "message_end", message: { role: "assistant" }, anneal: { ttftMs: 30 } }),
];

const diagnosticsTask = (): Record<string, unknown> => taskRow({
  id: "task-1",
  projectId: "project-1",
  description: "work",
  maxDurationMin: 240,
  stallTimeoutMin: 10,
  repo: null,
  stepOutput: [],
  // Newest first, exactly as the route orders them.
  runs: [
    diagnosticsRun(2, { sessionId: "session-2" }),
    diagnosticsRun(1, { sessionId: "session-1" }),
  ],
});

/* ------------------------------------------- GET /tasks/:taskId run baseline */

/** One grouped row exactly as `readRunBaselines` reads it out of PostgreSQL. */
const baselineRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  projectId: "project-1",
  templateStepId: "step-1",
  sampleSize: 8,
  costSampleSize: 8,
  costP50: 3,
  costP90: 5,
  durationSampleSize: 8,
  durationP50: 50_000,
  durationP90: 80_000,
  ...overrides,
});

/** The diagnostics fixture bound to a template step, with a costed newest run
 *  and an older one whose session reported no cost at all. */
const baselineTask = (): Record<string, unknown> => {
  const task = diagnosticsTask();
  const runs = (task.runs as Array<Record<string, unknown>>).map((run) => (
    run.runNumber === 2
      ? { ...run, session: { ...(run.session as Record<string, unknown>), costUsd: "6.0000" } }
      : run
  ));
  return { ...task, templateStepId: "step-1", runs };
};

test("task detail carries its step baseline and measures every run against it", async () => {
  await withTokens(async () => {
    const queries: SessionEventQuery[] = [];
    const database = taskDetailDatabase(baselineTask(), {
      rows: DIAGNOSTICS_TOOL_EVENTS,
      queries,
      baselines: [baselineRow()],
    });
    const response = await createApp(database).request("/tasks/task-1", {
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      baseline: unknown;
      runs: Array<{ runNumber: number; metrics: { vsBaseline: unknown } }>;
    };
    assert.deepEqual(body.baseline, {
      sampleSize: 8,
      costUsd: { sampleSize: 8, p50: 3, p90: 5 },
      durationMs: { sampleSize: 8, p50: 50_000, p90: 80_000 },
    });
    // One baseline statement for the whole task, whatever its run count.
    const baselineQueries = queries.filter((query) => /percentile_cont/u.test(query.sql ?? ""));
    assert.equal(baselineQueries.length, 1);
    assert.deepEqual(baselineQueries[0]!.values, ["succeeded", "project-1", "step-1"]);

    // $6.00 against a $3.00 median, and 100s of executing against 50s.
    assert.deepEqual(body.runs.find((run) => run.runNumber === 2)!.metrics.vsBaseline, {
      costRatio: 2, durationRatio: 2,
    });
    // A run that reported no cost has no cost ratio — that is unknown, not 0.
    assert.deepEqual(body.runs.find((run) => run.runNumber === 1)!.metrics.vsBaseline, {
      costRatio: null, durationRatio: 2,
    });
  });
});

test("too little history is a null baseline and null ratios, never a zero one", async () => {
  await withTokens(async () => {
    const database = taskDetailDatabase(baselineTask(), {
      rows: DIAGNOSTICS_TOOL_EVENTS,
      // Four completed runs: history, not a baseline.
      baselines: [baselineRow({ sampleSize: 4, costSampleSize: 4, durationSampleSize: 4 })],
    });
    const response = await createApp(database).request("/tasks/task-1", {
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      baseline: unknown;
      runs: Array<{ metrics: { vsBaseline: unknown } }>;
    };
    assert.equal(body.baseline, null);
    for (const run of body.runs) {
      assert.deepEqual(run.metrics.vsBaseline, { costRatio: null, durationRatio: null });
    }
  });
});

test("a task with no template step has no population to compare against and asks for none", async () => {
  await withTokens(async () => {
    const queries: SessionEventQuery[] = [];
    const database = taskDetailDatabase(diagnosticsTask(), { rows: DIAGNOSTICS_TOOL_EVENTS, queries });
    const response = await createApp(database).request("/tasks/task-1", {
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { baseline: unknown; runs: Array<{ metrics: { vsBaseline: unknown } }> };
    assert.equal(body.baseline, null);
    assert.deepEqual(body.runs[0]!.metrics.vsBaseline, { costRatio: null, durationRatio: null });
    assert.equal(queries.filter((query) => /percentile_cont/u.test(query.sql ?? "")).length, 0);
  });
});

test("the board reads one baseline statement however many cards the page carries", async () => {
  await withTokens(async () => {
    const page = (size: number): Array<Record<string, unknown>> => Array.from({ length: size }, (_unused, index) => taskRow({
      id: `task-${index}`,
      projectId: "p1",
      templateStepId: index % 2 === 0 ? "step-1" : "step-2",
      createdAt: new Date(`2026-08-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`),
    }));
    const baselines = [
      baselineRow({ projectId: "p1", templateStepId: "step-1" }),
      // Two runs of the other step: no baseline, so its cards carry null.
      baselineRow({ projectId: "p1", templateStepId: "step-2", sampleSize: 2, costSampleSize: 2, durationSampleSize: 2 }),
    ];
    for (const size of [1, 12]) {
      const baselineQueries: Array<{ sql: string; values: unknown[] }> = [];
      const response = await getTasks(boardDatabase(page(size), { baselines, baselineQueries }), "?view=board");
      assert.equal(response.status, 200);
      const body = await response.json() as Array<{ id: string; baseline: unknown }>;
      assert.equal(body.length, size);
      assert.equal(baselineQueries.length, 1, "the board's baseline read must not grow with the page");
      for (const card of body) {
        const step1 = Number(card.id.slice("task-".length)) % 2 === 0;
        assert.deepEqual(card.baseline, step1
          ? { sampleSize: 8, costUsd: { sampleSize: 8, p50: 3, p90: 5 }, durationMs: { sampleSize: 8, p50: 50_000, p90: 80_000 } }
          : null);
      }
    }
  });
});

test("the full list carries the same baseline from one statement, whatever the page", async () => {
  await withTokens(async () => {
    const page = (size: number): Array<Record<string, unknown>> => Array.from({ length: size }, (_unused, index) => taskRow({
      id: `task-${index}`,
      projectId: "p1",
      templateStepId: index % 2 === 0 ? "step-1" : "step-2",
      createdAt: new Date(`2026-08-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`),
    }));
    const baselines = [
      baselineRow({ projectId: "p1", templateStepId: "step-1" }),
      // Two runs of the other step: no baseline, so its rows carry null.
      baselineRow({ projectId: "p1", templateStepId: "step-2", sampleSize: 2, costSampleSize: 2, durationSampleSize: 2 }),
    ];
    for (const size of [1, 12]) {
      const baselineQueries: Array<{ sql: string; values: unknown[] }> = [];
      const response = await getTasks(boardDatabase(page(size), { baselines, baselineQueries }), "?view=full");
      assert.equal(response.status, 200);
      const body = await response.json() as Array<{ id: string; baseline: unknown }>;
      assert.equal(body.length, size);
      assert.equal(baselineQueries.length, 1, "the list's baseline read must not grow with the page");
      for (const row of body) {
        const step1 = Number(row.id.slice("task-".length)) % 2 === 0;
        assert.deepEqual(row.baseline, step1
          ? { sampleSize: 8, costUsd: { sampleSize: 8, p50: 3, p90: 5 }, durationMs: { sampleSize: 8, p50: 50_000, p90: 80_000 } }
          : null);
      }
    }
  });
});

test("a full list with no template step anywhere asks for no baseline at all", async () => {
  await withTokens(async () => {
    const baselineQueries: Array<{ sql: string; values: unknown[] }> = [];
    const response = await getTasks(boardDatabase([taskRow()], { baselineQueries }), "?view=full");
    assert.equal(response.status, 200);
    const body = await response.json() as Array<{ baseline: unknown }>;
    assert.equal(body[0]!.baseline, null);
    assert.equal(baselineQueries.length, 0);
  });
});

test("task detail attaches read-time diagnostics to every run from one metric-event query", async () => {
  await withTokens(async () => {
    const queries: SessionEventQuery[] = [];
    const database = taskDetailDatabase(diagnosticsTask(), { rows: DIAGNOSTICS_TOOL_EVENTS, queries });
    const response = await createApp(database).request("/tasks/task-1", {
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { runs: Array<{ runNumber: number; metrics: any }> };

    // Two runs, one events query: the route's query count must not grow with
    // the number of runs.
    const toolQueries = queries.filter((query) => query.sql !== undefined);
    assert.equal(toolQueries.length, 1);
    assert.match(toolQueries[0]!.sql!, /FROM "SessionEvent"/u);
    assert.deepEqual(toolQueries[0]!.values, ["session-2", "session-1", "TOOL_STARTED", "TOOL_COMPLETED"]);
    assert.doesNotMatch(JSON.stringify(body), /large-tool-output/u);

    assert.equal(body.runs.length, 2);
    for (const run of body.runs) assert.notEqual(run.metrics, undefined);
    const newest = body.runs.find((run) => run.runNumber === 2)!;
    assert.deepEqual(newest.metrics.phases, {
      queuedMs: 5_000, provisioningMs: 15_000, executingMs: 100_000, inboxWaitMs: 0, cleanupMs: null,
    });
    assert.deepEqual(newest.metrics.tokens, {
      input: 1_000, cachedRead: 600, cacheWrite: 150, uncachedInput: 250, output: 400, cacheHitRatio: 0.6,
    });
    assert.equal(newest.metrics.tools.calls, 1);
    assert.equal(newest.metrics.tools.failed, 0);
    assert.deepEqual(newest.metrics.termination, {
      reason: "provider completed", exitCode: 0, signal: null,
    });
    // Each run reads only its own session's events.
    const oldest = body.runs.find((run) => run.runNumber === 1)!;
    assert.equal(oldest.metrics.tools.calls, 1);
    assert.equal(oldest.metrics.tools.failed, 1);
    assert.equal(newest.metrics.ttft, null);
  });
});

test("task detail computes TTFT from completion rows and excludes non-completions", async () => {
  await withTokens(async () => {
    const queries: SessionEventQuery[] = [];
    const database = taskDetailDatabase(diagnosticsTask(), { rows: TTFT_EVENTS, queries });
    const response = await createApp(database).request("/tasks/task-1", {
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { runs: Array<{ runNumber: number; metrics: { ttft: unknown } }> };
    const newest = body.runs.find((run) => run.runNumber === 2)!;
    assert.deepEqual(newest.metrics.ttft, { p50Ms: 20, p90Ms: 28, samples: 3 });
    assert.equal(body.runs.find((run) => run.runNumber === 1)!.metrics.ttft, null);

    const metricQuery = queries.find((query) => query.sql !== undefined && /FROM "SessionEvent"/u.test(query.sql));
    assert.ok(metricQuery);
    assert.deepEqual(metricQuery.values, ["session-2", "session-1", "TOOL_STARTED", "TOOL_COMPLETED"]);
    assert.match(metricQuery.sql!, /'anneal'/u);
    assert.match(metricQuery.sql!, /WHERE[\s\S]*OR[\s\S]*'item.completed'[\s\S]*'message_end'/u);
    assert.doesNotMatch(metricQuery.sql!, /'completion'/u);
    assert.doesNotMatch(metricQuery.sql!, /PROVIDER_RAW/u);
  });
});


test("session and task detail return identical complete diagnostics for the same runs", async () => {
  await withTokens(async () => {
    const task = baselineTask();
    const runs = task.runs as Array<Record<string, unknown>>;
    const queries: SessionEventQuery[] = [];
    const database = taskDetailDatabase(task, {
      rows: [...DIAGNOSTICS_TOOL_EVENTS, ...TTFT_EVENTS], queries, baselines: [baselineRow()],
    });
    Object.assign(database, { session: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const run = runs.find((run) => (run.session as { id: string }).id === where.id)!;
        return { ...(run.session as object), projectId: task.projectId, runId: run.id, run, task };
      },
    } });
    const app = createApp(database);
    const headers = { Authorization: "Bearer operator-unit-token" };
    const taskResponse = await app.request("/tasks/task-1", { headers });
    assert.equal(taskResponse.status, 200);
    const taskDetail = await taskResponse.json() as {
      baseline: unknown;
      runs: Array<{ session: { id: string }; metrics: { ttft: unknown; vsBaseline: unknown; phases: { cleanupMs: unknown } } }>;
    };
    for (const run of taskDetail.runs) {
      const response = await app.request(`/sessions/${run.session.id}`, { headers });
      assert.equal(response.status, 200);
      const detail = await response.json() as { metrics: unknown; baseline: unknown };
      assert.deepEqual(detail.metrics, run.metrics);
      assert.deepEqual(detail.baseline, taskDetail.baseline);
      assert.equal(run.metrics.phases.cleanupMs, null);
    }
    assert.deepEqual(taskDetail.runs[0]!.metrics.ttft, { p50Ms: 20, p90Ms: 28, samples: 3 });
    assert.deepEqual(taskDetail.runs[0]!.metrics.vsBaseline, { costRatio: 2, durationRatio: 2 });
    assert.equal(taskDetail.runs[1]!.metrics.ttft, null);
    assert.deepEqual(taskDetail.runs[1]!.metrics.vsBaseline, { costRatio: null, durationRatio: 2 });
    assert.equal(queries.filter((query) => query.sql?.includes('FROM "SessionEvent"')).length, 3);
  });
});

test("operator output PUT refuses overwriting archived historical review reports", async () => {
  await withTokens(async () => {
    const kind = LEGACY_TEMPLATE_GENERATIONS["direct-engineer-workflow"]
      .find(({ marker }) => marker === "pre-model-neutral-review-output")!.shape
      .find(({ name }) => name === "Code review")!.outputKind;
    const task = { id: "historical", projectId: "project", chainId: "chain", status: "DONE",
      archivedAt: new Date(), templateStep: { outputKind: kind } };
    let stored = { kind, body: "historical report\nunchanged", metadata: { historical: true } };
    const before = structuredClone(stored);
    let writes = 0;
    const tx = {
      $queryRaw: async () => [{ id: task.id }],
      task: { findUnique: async () => task, findUniqueOrThrow: async () => task },
      taskStepOutput: {
        findUnique: async () => stored,
        upsert: async ({ update }: { update: typeof stored }) => { writes++; stored = update; return stored; },
      },
    };
    const database = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
    const response = await createApp(database).request(`/tasks/${task.id}/output`, {
      method: "PUT", headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "note", body: "replacement" }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: string }).error, `${kind} task output is immutable once persisted`);
    assert.equal(writes, 0);
    assert.deepEqual(stored, before);
  });
});

test("operator revalidation output respects the persisted template protocol", async () => {
  await withTokens(async () => {
    for (const [templateName, schemaVersion, includeRoute, expectedStatus, expectedRoutes] of [
      ["direct-engineer-workflow-legacy-pre-judged-implementation-route-row", 1, false, 200, 0],
      ["direct-engineer-workflow", 1, false, 409, 0],
      ["direct-engineer-workflow", 2, false, 409, 0],
      ["direct-engineer-workflow", 2, true, 200, 1],
    ] as const) {
      let routeLookups = 0;
      let writes = 0;
      const tx = {
        $queryRaw: async () => [{ id: "task-1" }],
        task: {
          findUnique: async ({ select }: { select: Record<string, unknown> }) => {
            if (select.templateId) { routeLookups += 1; return null; }
            return { id: "task-1", projectId: "project-1", chainId: null };
          },
          findUniqueOrThrow: async () => ({ templateStep: {
            outputKind: "revalidation", stepIndex: 1, taskTemplate: { name: templateName },
          } }),
        },
        taskStepOutput: {
          findUnique: async () => null,
          upsert: async ({ create }: { create: Record<string, unknown> }) => {
            writes += 1;
            return { id: "output", ...create, metadata: null };
          },
        },
      };
      const database = {
        ...tx, $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      } as unknown as PrismaClient;
      const response = await createApp(database).request("/tasks/task-1/output", {
        method: "PUT",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "revalidation", commitSha: "a".repeat(40),
          body: JSON.stringify({
            schemaVersion, headSha: "a".repeat(40), outcome: "unchanged", summary: "Still valid", changedReferences: [],
            ...(includeRoute ? { route: { tier: "default", reason: "No escalation criterion applies" } } : {}),
          }),
        }),
      });
      assert.equal(response.status, expectedStatus, await response.text());
      assert.equal(writes, expectedStatus === 200 ? 1 : 0);
      assert.equal(routeLookups, expectedRoutes);
    }
  });
});
