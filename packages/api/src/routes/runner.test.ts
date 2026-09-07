import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  InboxStatus,
  Prisma,
  RunStatus,
  RunnerKind,
  type PrismaClient,
} from "@anneal/db";
import {
  RUN_COMPLETION_CONTRACT_VERSION,
  mechanicalContractMismatch,
} from "@anneal/db/claim-contract";
import {
  SESSION_EVENTS_REQUEST_MAX_BYTES,
  SESSION_EVENTS_REQUEST_TOO_LARGE_CODE,
  SESSION_EVENT_CONVERSATION_ID_MAX_CHARS,
  SESSION_EVENT_PAYLOAD_MAX_BYTES,
  SESSION_EVENT_PAYLOAD_TOO_LARGE_CODE,
} from "@anneal/db/session-event-limits";

import { createApp } from "../test-app.js";
import { withTokens } from "./test-support.js";

test("salvage publication records the stranded branch and preserves the already-started 409", async () => {
  await withTokens(async () => {
    const activities: Array<Record<string, unknown>> = [];
    const lost = {
      id: "run-3", runnerId: "runner-1", taskId: "task-1", runNumber: 3,
      status: RunStatus.LOST, workspaceReclaimAt: new Date(), workspaceReclaimedAt: null,
      pushedBranch: null, branch: "feat/salvage",
    };
    const replacement = {
      id: "run-4", runNumber: 4, status: RunStatus.RUNNING,
      startedAt: new Date(), baseSha: "base-before-salvage",
    };
    const tx = {
      $queryRaw: async () => [{ id: "task-1" }],
      run: {
        findUnique: async () => lost,
        findFirst: async () => replacement,
        updateMany: async () => ({ count: 1 }),
      },
      task: {
        findUnique: async () => ({ projectId: "project-1", chainId: null }),
        findUniqueOrThrow: async () => ({ id: "task-1" }),
      },
      taskActivity: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          activities.push(data);
          return {};
        },
      },
    };
    const database = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;

    const response = await createApp(database).request("/runner/workspaces/salvaged", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-1", runId: "run-3", pushedBranch: "agentos/task-1/run-3",
      }),
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Salvage is durable, but the replacement already started from its prior base",
    });
    assert.deepEqual(activities, [{
      taskId: "task-1",
      actorType: "control-plane",
      body: "Salvage branch agentos/task-1/run-3 from LOST Run 3 was not consumed by replacement Run 4 (RUNNING) from baseSha base-before-salvage",
    }]);
  });
});

test("starting a run without an exact dispatched prompt hash is refused before database access", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/runner/runs/run-1/start", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-1",
        fencingToken: "1:run-1:current",
        adapterVersion: "test",
        cliVersion: "test",
        manifest: {},
        workspacePath: "/scratch/fresh",
      }),
    });
    assert.equal(response.status, 400);
  });
});

test("merge-executor start maps an omitted promptHash to null and dispatches", async () => {
  await withTokens(async () => {
    let promptHash: unknown = "not-written";
    const tx = {
      $queryRaw: async () => [{ id: "run-1" }],
      run: {
        findFirst: async () => ({ startedAt: null }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          promptHash = data.promptHash;
          return { count: 1 };
        },
      },
      session: { updateMany: async () => ({ count: 1 }) },
    };
    const database = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/runner/runs/run-1/start", {
      method: "POST",
      headers: { Authorization: "Bearer merge-executor-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "merge-executor-1",
        fencingToken: "1:run-1:current",
        adapterVersion: "executor-1",
        cliVersion: "executor-1",
        manifest: { executionMode: "mechanical" },
        workspacePath: null,
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(promptHash, null);
  });
});

for (const contractVersion of [undefined, RUN_COMPLETION_CONTRACT_VERSION + 1]) {
  test(`a mechanical claim with ${contractVersion === undefined ? "no" : "a mismatched"} completion contract version is visibly refused`, async () => {
    await withTokens(async () => {
      const previousRunnerIds = process.env.MERGE_EXECUTOR_RUNNER_IDS;
      process.env.MERGE_EXECUTOR_RUNNER_IDS = "merge-executor-1";
      const activities: Array<Record<string, unknown>> = [];
      const inboxMessages: Array<Record<string, unknown>> = [];
      let runMutations = 0;
      const candidate = {
        id: "run-mechanical", projectId: "project-1", taskId: "task-mechanical", repoId: "repo-1",
        leaseGeneration: 0,
        task: {
          id: "task-mechanical",
          targetBranch: "main",
          templateStep: {
            stepIndex: 7,
            outputKind: "merge-result",
            taskTemplate: { name: "direct-engineer-workflow" },
          },
        },
        repo: { id: "repo-1", defaultBranch: "main" },
        agent: {
          id: "agent-mechanical",
          name: "merge-integrator",
          repoAccess: [{ repoId: "repo-1", projectId: "project-1" }],
        },
      };
      const tx = {
        $queryRaw: async () => [{ granted: true }],
        $executeRawUnsafe: async () => 0,
        chainControl: { findMany: async () => [] },
        mergeLeaseEvent: { findMany: async () => [] },
        run: {
          findMany: async () => [candidate],
          updateMany: async () => { runMutations += 1; return { count: 1 }; },
          create: async () => { runMutations += 1; return {}; },
        },
        taskActivity: {
          findFirst: async ({ where }: {
            where: {
              taskId: string;
              actorType: string;
              AND: Array<{ metadata: { path: string[]; equals: unknown } }>;
            };
          }) => activities.find((activity) => (
            activity.taskId === where.taskId
            && activity.actorType === where.actorType
            && where.AND.every(({ metadata: condition }) => {
              const metadata = activity.metadata as Record<string, unknown> | undefined;
              const expected = condition.equals === Prisma.JsonNull ? null : condition.equals;
              return metadata?.[condition.path[0] ?? ""] === expected;
            })
          )) ?? null,
          create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return {}; },
        },
        inboxThread: {
          findFirst: async () => null,
          create: async () => ({ id: "thread-1" }),
        },
        inboxMessage: {
          findFirst: async ({ where }: { where: { status: InboxStatus; dedupeKey: { startsWith: string } } }) => (
            inboxMessages.find((message) => (
              message.status === where.status
              && String(message.dedupeKey).startsWith(where.dedupeKey.startsWith)
            )) ?? null
          ),
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const message = { ...data, status: InboxStatus.OPEN, answeredAt: null };
            inboxMessages.push(message);
            return message;
          },
        },
      };
      const database = {
        run: { findMany: async () => [] },
        taskActivity: { createMany: async () => ({ count: 0 }) },
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      } as unknown as PrismaClient;
      try {
        const app = createApp(database);
        const request = (requestedContractVersion = contractVersion) => app.request("/runner/tasks/claim", {
            method: "POST",
            headers: { Authorization: "Bearer merge-executor-unit-token", "Content-Type": "application/json" },
            body: JSON.stringify({
              runnerId: "merge-executor-1",
              leaseSeconds: 60,
              ...(requestedContractVersion === undefined ? {} : { contractVersion: requestedContractVersion }),
            }),
          });

        // The decision the route must reach, composed by the module that owns
        // it. The route may serialise it and nothing else.
        const decided = (received: number | null) => {
          const mismatch = mechanicalContractMismatch({ receivedVersion: received, taskId: "task-mechanical", now: new Date() });
          assert.ok(mismatch);
          return mismatch;
        };
        const expected = decided(contractVersion ?? null);

        const response = await request();
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), expected.refusal);
        assert.equal(runMutations, 0);
        assert.equal(activities.length, 1);
        assert.equal(activities[0]?.taskId, "task-mechanical");
        assert.equal(activities[0]?.body, expected.activity.body);
        assert.deepEqual(activities[0]?.metadata, expected.activity.metadata);
        assert.equal((await request()).status, 409);
        assert.equal(activities.length, 1);
        assert.equal(inboxMessages.length, 1);
        assert.equal(inboxMessages[0]?.status, InboxStatus.OPEN);
        assert.equal(inboxMessages[0]?.body, expected.alert.body);
        assert.ok(String(inboxMessages[0]?.dedupeKey).startsWith(expected.alert.dedupeKeyPrefix));
        if (contractVersion === undefined) {
          const differentVersion = RUN_COMPLETION_CONTRACT_VERSION + 1;
          assert.equal((await request(differentVersion)).status, 409);
          assert.equal(inboxMessages.length, 2);
          assert.equal(inboxMessages.filter(({ status }) => status === InboxStatus.OPEN).length, 2);
          assert.ok(String(inboxMessages[1]?.dedupeKey).startsWith(decided(differentVersion).alert.dedupeKeyPrefix));
          assert.equal(activities.length, 2);
        }
      } finally {
        if (previousRunnerIds === undefined) delete process.env.MERGE_EXECUTOR_RUNNER_IDS;
        else process.env.MERGE_EXECUTOR_RUNNER_IDS = previousRunnerIds;
      }
    });
  });
}

test("a mismatch Inbox failure aborts the claim before a later candidate is considered", async () => {
  await withTokens(async () => {
    const previousRunnerIds = process.env.MERGE_EXECUTOR_RUNNER_IDS;
    const previousChatId = process.env.FEISHU_DEFAULT_CHAT_ID;
    process.env.MERGE_EXECUTOR_RUNNER_IDS = "merge-executor-1";
    process.env.FEISHU_DEFAULT_CHAT_ID = "operator-chat";
    const activities: Array<Record<string, unknown>> = [];
    const inboxMessages: Array<Record<string, unknown>> = [];
    const inboxThreads: Array<Record<string, unknown>> = [];
    const activityAttempts: string[] = [];
    let inboxCreateAttempts = 0;
    const candidate = (suffix: string) => ({
      id: `run-${suffix}`, projectId: "project-1", taskId: `task-${suffix}`, repoId: "repo-1",
      leaseGeneration: 0,
      task: {
        id: `task-${suffix}`,
        targetBranch: "main",
        templateStep: {
          stepIndex: 7,
          outputKind: "merge-result",
          taskTemplate: { name: "direct-engineer-workflow" },
        },
      },
      repo: { id: "repo-1", defaultBranch: "main" },
      agent: {
        id: "agent-mechanical",
        name: "merge-integrator",
        repoAccess: [{ repoId: "repo-1", projectId: "project-1" }],
      },
    });
    const tx = {
      $queryRaw: async () => [{ granted: true }],
      $executeRawUnsafe: async () => 0,
      chainControl: { findMany: async () => [] },
      mergeLeaseEvent: { findMany: async () => [] },
      run: {
        findMany: async () => [candidate("first"), candidate("second")],
      },
      taskActivity: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          activityAttempts.push(String(data.taskId));
          activities.push(data);
          return {};
        },
      },
      inboxThread: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const thread = { id: `thread-${inboxThreads.length + 1}`, ...data };
          inboxThreads.push(thread);
          return thread;
        },
      },
      inboxMessage: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          inboxCreateAttempts += 1;
          if (inboxCreateAttempts === 1) throw new Error("inbox-create-failed");
          const message = { ...data, status: InboxStatus.OPEN };
          inboxMessages.push(message);
          return message;
        },
      },
    };
    const database = {
      run: { findMany: async () => [] },
      taskActivity: { createMany: async () => ({ count: 0 }) },
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => {
        const activityCount = activities.length;
        const messageCount = inboxMessages.length;
        const threadCount = inboxThreads.length;
        try {
          return await operation(tx);
        } catch (error: unknown) {
          activities.length = activityCount;
          inboxMessages.length = messageCount;
          inboxThreads.length = threadCount;
          throw error;
        }
      },
    } as unknown as PrismaClient;
    try {
      const response = await createApp(database).request("/runner/tasks/claim", {
        method: "POST",
        headers: { Authorization: "Bearer merge-executor-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ runnerId: "merge-executor-1", leaseSeconds: 60 }),
      });

      assert.equal(response.status, 500);
      assert.equal(inboxCreateAttempts, 1);
      assert.deepEqual(activityAttempts, ["task-first"]);
      assert.equal(activities.length, 0);
      assert.equal(inboxMessages.length, 0);
      assert.equal(inboxThreads.length, 0);
    } finally {
      if (previousRunnerIds === undefined) delete process.env.MERGE_EXECUTOR_RUNNER_IDS;
      else process.env.MERGE_EXECUTOR_RUNNER_IDS = previousRunnerIds;
      if (previousChatId === undefined) delete process.env.FEISHU_DEFAULT_CHAT_ID;
      else process.env.FEISHU_DEFAULT_CHAT_ID = previousChatId;
    }
  });
});

const matchingMechanicalClaimHarness = () => {
  const now = new Date("2026-09-02T23:00:00.000Z");
  const task = {
    id: "task-mechanical", projectId: "project-1", repoId: "repo-1",
    status: "TODO", assigneeType: "AGENT", archivedAt: null,
    chainId: null, chainIndex: null, chainLayer: null, templateId: null,
    createdAt: now, name: "Merge execution", description: "Mechanical merge",
    targetBranch: "main", maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 3,
    templateStep: {
      name: "Merge execution", stepIndex: 7, outputKind: "merge-result",
      provisionDependencies: false, priorOutputKinds: [], baseFromStepIndex: null,
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  };
  const candidate = {
    id: "run-mechanical", projectId: "project-1", taskId: task.id, goalId: null,
    agentId: "agent-mechanical", repoId: "repo-1", runNumber: 1,
    runner: RunnerKind.CLAUDE, leaseGeneration: 0, maxDurationMin: 120, stallTimeoutMin: 10,
    readyAt: now, createdAt: now, session: null, branch: "fix/merge", targetBranch: "main",
    task,
    repo: {
      id: "repo-1", remoteUrl: "https://github.test/acme/repo.git", defaultBranch: "main",
      mountPath: "repo", dependencyProvisioning: "NONE",
    },
    agent: {
      id: "agent-mechanical", name: "merge-integrator", model: "mechanical/merge-executor-v1",
      foundationalPrompt: "", rolePrompt: "", disabledTools: [], archivedAt: null,
      repoAccess: [{ repoId: "repo-1", projectId: "project-1" }],
      environment: { secrets: [] }, secretGrants: [],
    },
  };
  const activities: Array<Record<string, unknown>> = [];
  const inboxMessages: Array<Record<string, unknown>> = [];
  let runMutations = 0;
  const claimedRun = {
    ...candidate,
    opensPullRequest: false, requiresCommit: false, maxRunsPerTask: 3,
    model: candidate.agent.model, codexServiceTier: "DEFAULT",
    subagentModel: null, subagentMaxConcurrent: null, promptHash: null,
    workspacePath: null, baseSha: null,
  };
  const tx = {
    $queryRaw: async (query: unknown) => {
      const sql = Array.isArray(query)
        ? query.join("?")
        : (query as { strings?: string[] }).strings?.join("?") ?? "";
      if (sql.includes("pg_try_advisory_xact_lock_shared")) return [{ granted: true }];
      if (sql.includes("pg_try_advisory_xact_lock")) return [{ locked: true }];
      if (sql.includes('SELECT "id" FROM "Task"')) return [{ id: task.id }];
      return [];
    },
    $executeRawUnsafe: async () => 0,
    chainControl: { findMany: async () => [] },
    mergeLeaseEvent: { findMany: async () => [] },
    run: {
      findMany: async ({ where }: { where: { id?: { not?: string } } }) => where.id?.not ? [] : [candidate],
      updateMany: async () => { runMutations += 1; return { count: 1 }; },
      findFirst: async () => null,
      findUniqueOrThrow: async () => claimedRun,
    },
    session: { create: async () => ({ id: "session-mechanical" }) },
    sessionEvent: { aggregate: async () => ({ _max: { seq: null } }) },
    task: {
      findUnique: async () => task,
      findUniqueOrThrow: async () => task,
      update: async () => ({}),
    },
    taskActivity: {
      findMany: async () => [],
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return {}; },
    },
    inboxMessage: {
      findFirst: async ({ where }: { where: { status: InboxStatus; dedupeKey: { startsWith: string } } }) => (
        inboxMessages.find((message) => (
          message.status === where.status
          && String(message.dedupeKey).startsWith(where.dedupeKey.startsWith)
        )) ?? null
      ),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const message = { ...data, status: InboxStatus.OPEN, answeredAt: null };
        inboxMessages.push(message);
        return message;
      },
      updateMany: async ({ where, data }: {
        where: { status: InboxStatus; dedupeKey: { startsWith: string } };
        data: { status: InboxStatus; answeredAt: Date };
      }) => {
        let count = 0;
        for (const message of inboxMessages) {
          if (message.status === where.status && String(message.dedupeKey).startsWith(where.dedupeKey.startsWith)) {
            message.status = data.status;
            message.answeredAt = data.answeredAt;
            count += 1;
          }
        }
        return { count };
      },
    },
    inboxThread: {
      findFirst: async () => null,
      create: async () => ({ id: "thread-1" }),
    },
  };
  const database = {
    run: { findMany: async () => [] },
    chainControl: { findUnique: async () => null },
    taskActivity: { createMany: async () => ({ count: 0 }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  const request = (contractVersion?: number) => createApp(database).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: "Bearer merge-executor-unit-token", "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: "merge-executor-1",
      leaseSeconds: 60,
      ...(contractVersion === undefined ? {} : { contractVersion }),
    }),
  });
  return {
    activities,
    candidate,
    inboxMessages,
    request,
    runMutations: () => runMutations,
  };
};

const withMechanicalRunnerId = async (callback: () => Promise<void>): Promise<void> => {
  const previousRunnerIds = process.env.MERGE_EXECUTOR_RUNNER_IDS;
  process.env.MERGE_EXECUTOR_RUNNER_IDS = "merge-executor-1";
  try {
    await callback();
  } finally {
    if (previousRunnerIds === undefined) delete process.env.MERGE_EXECUTOR_RUNNER_IDS;
    else process.env.MERGE_EXECUTOR_RUNNER_IDS = previousRunnerIds;
  }
};

test("a mechanical claim with the matching completion contract version claims normally", async () => {
  await withTokens(async () => withMechanicalRunnerId(async () => {
    const harness = matchingMechanicalClaimHarness();
    const response = await harness.request(RUN_COMPLETION_CONTRACT_VERSION);

    assert.equal(response.status, 200);
    const claim = await response.json() as { executionMode: string; run: { id: string } };
    assert.equal(claim.executionMode, "mechanical");
    assert.equal(claim.run.id, harness.candidate.id);
    assert.equal(harness.runMutations(), 1);
    assert.equal(harness.activities.filter((activity) => (
      (activity.metadata as Record<string, unknown> | undefined)?.code === "mechanical_contract_mismatch"
    )).length, 0);
  }));
});

test("a matching mechanical claim closes an alert opened by a prior refused claim", async () => {
  await withTokens(async () => withMechanicalRunnerId(async () => {
    const harness = matchingMechanicalClaimHarness();
    const refused = await harness.request();
    assert.equal(refused.status, 409);
    assert.equal(harness.inboxMessages.length, 1);
    assert.equal(harness.inboxMessages[0]?.status, InboxStatus.OPEN);

    const response = await harness.request(RUN_COMPLETION_CONTRACT_VERSION);

    assert.equal(response.status, 200);
    const claim = await response.json() as { executionMode: string; run: { id: string } };
    assert.equal(claim.executionMode, "mechanical");
    assert.equal(claim.run.id, harness.candidate.id);
    assert.equal(harness.runMutations(), 1);
    assert.equal(harness.activities.filter((activity) => (
      (activity.metadata as Record<string, unknown> | undefined)?.code === "mechanical_contract_mismatch"
    )).length, 1);
    assert.equal(harness.inboxMessages[0]?.status, InboxStatus.CLOSED);
    assert.ok(harness.inboxMessages[0]?.answeredAt instanceof Date);
  }));
});

test("completion refunds an external failure but refuses an automatic retry for an archived Agent", async () => {
  const previousRoot = process.env.RUNNER_WORKSPACE_ROOT;
  process.env.RUNNER_WORKSPACE_ROOT = `/tmp/agentos-missing-${Date.now()}`;
  try {
    await withTokens(async () => {
    let closed: Record<string, unknown> | undefined;
    let retry: Record<string, unknown> | undefined;
    const taskWrites: Record<string, unknown>[] = [];
    const activities: Record<string, unknown>[] = [];
    const inbox: Record<string, unknown>[] = [];
    const archivedAt = new Date("2026-08-16T06:00:00.000Z");
    const run = {
      id: "run-3", projectId: "project-1", taskId: "task-1", goalId: null, agentId: "agent-1", repoId: "repo-1",
      runNumber: 3, maxRunsPerTask: 3, runner: "CLAUDE", model: "claude", targetBranch: "main", branch: "feat/x",
      codexServiceTier: "DEFAULT", subagentModel: null, subagentMaxConcurrent: null, budgetGrants: 0,
      baseSha: null, promptHash: "hash", maxDurationMin: 120, stallTimeoutMin: 10,
      task: {
        id: "task-1", projectId: "project-1", name: "Archived retry", description: "retry",
        assigneeType: "AGENT", assigneeAgentId: "agent-1",
        assigneeAgent: { id: "agent-1", name: "Archived Retry Agent", archivedAt },
        repoId: "repo-1", chainId: null, chainIndex: null,
        templateId: null, templateStep: null, repo: null, targetBranch: "main", opensPullRequest: true,
        maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 3,
        status: "DOING", archivedAt: null, templateStepId: null,
      }, session: { id: "session-1" },
    };
    const tx = {
      $queryRaw: async () => [{ id: "task-1", archivedAt: null }],
      run: {
        findFirst: async () => run,
        updateMany: async ({ data }: { data: Record<string, unknown> }) => { closed = data; return { count: 1 }; },
        create: async ({ data }: { data: Record<string, unknown> }) => { retry = data; return { id: "run-4", ...data }; },
      },
      agent: { findUnique: async () => run.task.assigneeAgent },
      session: { update: async () => ({}) },
      task: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => { taskWrites.push(data); return { count: 1 }; },
        findUnique: async () => ({
          ...run.task,
          runs: [{ ...run, task: undefined, session: undefined, maxRunsPerTask: 4, budgetGrants: 1 }],
        }),
        findUniqueOrThrow: async () => run.task,
      },
      taskActivity: {
        findMany: async () => [],
        findFirst: async () => null,
        count: async () => 0,
        create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return {}; },
      },
      runnerBackendState: { upsert: async () => ({ consecutiveAuthFailures: 0 }), update: async () => ({}) },
      inboxMessage: { create: async ({ data }: { data: Record<string, unknown> }) => { inbox.push(data); return {}; } },
    };
    const database = {
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
      // The completion route reads the run's step binding before the
      // transaction, to bind a mechanical completion to the merge-executor
      // principal (§D-P1 rule 3). An ordinary run has no template step.
      run: { findFirst: async () => null, findUnique: async () => ({ runnerId: "runner-1", task: { templateStep: null } }) },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/runner/runs/run-3/complete", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-1", fencingToken: "1:run-3:token", exitCode: null, signal: "SIGTERM",
        outcome: {
          case: "provider-failure",
          reason: "read ECONNRESET",
          envelope: {
            version: 1, phase: "EXECUTE", runnerClass: "TRANSIENT_PROVIDER", exitCode: null,
            signal: "SIGTERM", terminationReason: null, terminalEventSeen: false, terminalSuccess: false,
            agentExited: true, providerError: null, stderrSummary: "read ECONNRESET", stdoutSummary: null,
            timedOut: false, transient: true, timeoutMs: null,
          },
        },
        cleanupStatus: "SUCCEEDED",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(closed?.maxRunsPerTask, 4);
    assert.deepEqual(
      activities.find(({ metadata }) => (metadata as { kind?: string })?.kind === "externalFailureRefund.granted")?.metadata,
      {
        kind: "externalFailureRefund.granted",
        schemaVersion: 1,
        policy: "capped",
        granted: true,
        cap: 3,
        capReached: false,
        runId: "run-3",
        priorCappedRefunds: 0,
        budgetGrantsBefore: 0,
        budgetGrantsAfter: 1,
      },
    );
    assert.equal(retry, undefined);
    assert.match(String(taskWrites.at(-1)?.failureReason), /Automatic retry refused.*Archived Retry Agent/);
    assert.match(String(inbox.at(-1)?.body), /Automatic retry refused.*Archived Retry Agent/);
    assert.deepEqual(await response.json(), {
      taskId: "task-1",
      succeeded: false,
      retryCreated: false,
      failureClass: "TRANSIENT_PROVIDER",
    });
    });
  } finally {
    if (previousRoot === undefined) delete process.env.RUNNER_WORKSPACE_ROOT;
    else process.env.RUNNER_WORKSPACE_ROOT = previousRoot;
  }
});

test("claim query filters archived agents before take so active work cannot starve", async () => {
  await withTokens(async () => {
    const completePriorOutput = `schema-start\n${"x".repeat(50_000)}\nstate-machine-end`;
    const candidate = (id: string, archivedAt: Date | null, offset: number) => ({
      id,
      projectId: "project-1",
      taskId: `task-${id}`,
      goalId: null,
      agentId: archivedAt ? "agent-archived" : "agent-active",
      repoId: "repo-1",
      runNumber: 1,
      runner: RunnerKind.CLAUDE,
      leaseGeneration: 0,
      maxDurationMin: 120,
      stallTimeoutMin: 10,
      readyAt: new Date(Date.now() + offset),
      createdAt: new Date(Date.now() + offset),
      session: null,
      task: {
        id: `task-${id}`, status: "TODO",
        projectId: "project-1",
        chainId: archivedAt ? null : "chain-1", chainIndex: archivedAt ? null : 1,
        templateStep: null,
      },
      // The claim must preserve the operator's persisted provisioning policy;
      // it is part of the full Repo row returned by `repo: true` in claimRun.
      repo: {
        id: "repo-1",
        dependencyProvisioning: "NPM_CI",
      },
      agent: {
        id: archivedAt ? "agent-archived" : "agent-active",
        archivedAt,
        repoAccess: [{ repoId: "repo-1", projectId: "project-1" }],
        environment: { secrets: [] },
        secretGrants: [],
      },
    });
    const old = new Date("2026-08-16T06:00:00.000Z");
    const seeded = [
      ...Array.from({ length: 20 }, (_, index) => candidate(`archived-${index}`, old, index)),
      candidate("active", null, 100),
    ];
    let claimQuery: string | undefined;
    let claimedId: string | undefined;
    const tx = {
      $queryRaw: async (query: unknown) => {
        const sql = Array.isArray(query)
          ? query.join("?")
          : (query as { strings?: string[] }).strings?.join("?") ?? "";
        if (sql.includes('SELECT candidate."id"')) {
          claimQuery = sql;
          return [{ id: "active" }];
        }
        if (sql.includes('FROM "TaskActivity" AS activity')) return [];
        if (sql.includes('FROM "TaskActivity" AS deferred')) return [];
        return [{ granted: true }];
      },
      // The claim loop brackets every candidate in a savepoint.
      $executeRawUnsafe: async () => 0,
      run: {
        findMany: async ({ where }: { where: Record<string, any> }) => {
          const selectedIds = where.id?.in as string[] | undefined;
          return selectedIds ? seeded.filter((run) => selectedIds.includes(run.id)) : [];
        },
        updateMany: async ({ where }: { where: { id: string } }) => { claimedId = where.id; return { count: 1 }; },
        findFirst: async () => null,
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ id: where.id, status: RunStatus.CLAIMED }),
      },
      runnerBackendState: { findUnique: async () => null },
      session: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "session-1", ...data }) },
      sessionEvent: { aggregate: async () => ({ _max: { seq: null } }) },
      task: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const found = seeded.find((entry) => entry.task.id === where.id)?.task;
          return found ? { ...found, projectId: "project-1", archivedAt: null, assigneeAgentId: null } : null;
        },
        update: async () => ({}),
      },
      taskActivity: { findMany: async () => [], create: async () => ({}) },
      mergeLeaseEvent: { findMany: async () => [] },
      taskStepOutput: { findMany: async () => [{
        kind: "spec", body: completePriorOutput,
        task: { name: "Approved specification", chainIndex: 0 },
      }] },
    };
    const database = {
      run: { findMany: async () => [] },
      chainControl: { findUnique: async () => null },
      taskActivity: { createMany: async () => ({ count: 0 }) },
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "runner-1", leaseSeconds: 60 }),
    });
    assert.equal(response.status, 200);
    const claim = await response.json() as {
      priorOutputs: Array<{ body: string }>;
      repo: { dependencyProvisioning: string };
    };
    assert.ok(claimQuery);
    assert.ok(claimQuery.includes('agent."archivedAt" IS NULL'));
    assert.ok(claimQuery.indexOf('agent."archivedAt" IS NULL') < claimQuery.indexOf("LIMIT 20"));
    assert.equal(claimedId, "active");
    assert.equal(claim.repo.dependencyProvisioning, "NPM_CI");
    assert.equal(claim.priorOutputs[0]?.body, completePriorOutput);
  });
});

test("claim polling throttles the archived-run audit sweep per API process", async () => {
  await withTokens(async () => {
    let auditQueries = 0;
    const database = {
      run: {
        findMany: async ({ where }: { where: { status: RunStatus | { in: RunStatus[] } } }) => {
          if (where.status === RunStatus.QUEUED) auditQueries += 1;
          return [];
        },
      },
      taskActivity: { createMany: async () => ({ count: 0 }) },
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
        $queryRaw: async (query: unknown) => {
          const sql = Array.isArray(query)
            ? query.join("?")
            : (query as { strings?: string[] }).strings?.join("?") ?? "";
          if (sql.includes('SELECT candidate."id"')) return [];
          if (sql.includes('FROM "TaskActivity" AS activity')) return [];
          if (sql.includes('FROM "TaskActivity" AS deferred')) return [];
          return [{ granted: true }];
        },
        run: { findMany: async () => [] },
        taskActivity: { findMany: async () => [] },
        mergeLeaseEvent: { findMany: async () => [] },
      }),
    } as unknown as PrismaClient;
    const app = createApp(database);
    const request = () => app.request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "runner-1", leaseSeconds: 60 }),
    });
    assert.equal((await request()).status, 204);
    assert.equal((await request()).status, 204);
    assert.equal(auditQueries, 1);
  });
});

test("successful completion commits output and parks an archived chain successor without enqueueing", async () => {
  await withTokens(async () => {
    const previousRoot = process.env.RUNNER_WORKSPACE_ROOT;
    process.env.RUNNER_WORKSPACE_ROOT = `/tmp/agentos-missing-${Date.now()}`;
    try {
      let closed = false;
      let outputCreated = false;
      let successorUpdate: Record<string, unknown> | undefined;
      let successorActivity: Record<string, unknown> | undefined;
      let runCreates = 0;
      const successor = {
        id: "task-2",
        projectId: "project-1",
        name: "Archived Successor",
        chainId: "chain-1",
        chainIndex: 2,
        chainLayer: 2,
        status: "TODO",
        assigneeType: "AGENT",
        assigneeAgentId: "agent-2",
        repoId: "repo-1",
        templateId: "template-1",
        templateStepId: null,
        approvalGate: false,
        archivedAt: null,
        failureReason: null,
        updatedAt: new Date(),
        runs: [],
        assigneeAgent: { id: "agent-2", name: "Archived Successor", archivedAt: new Date() },
        repo: { id: "repo-1", name: "Repo", defaultBranch: "main" },
      };
      const predecessor = {
        id: "task-1",
        projectId: "project-1",
        name: "Predecessor",
        templateId: "template-1",
        chainId: "chain-1",
        chainIndex: 1,
        chainLayer: 1,
        status: "DOING",
        approvalGate: false,
        archivedAt: null,
        assigneeType: "AGENT",
        assigneeAgentId: "agent-1",
        repoId: "repo-1",
        templateStepId: null,
        failureReason: null,
      };
      const run = {
        id: "run-1", projectId: "project-1", taskId: "task-1", goalId: null, agentId: "agent-1",
        repoId: "repo-1", runNumber: 1, maxRunsPerTask: 3, runner: RunnerKind.CLAUDE,
        model: "model", targetBranch: "main", branch: "feature/chain", baseSha: "base",
        promptHash: "hash", maxDurationMin: 120, stallTimeoutMin: 10,
        task: {
          ...predecessor,
          templateStep: { outputKind: "result" },
          repo: { defaultBranch: "main" },
        },
        session: { id: "session-1" },
      };
      const tx = {
        $queryRaw: async () => [{ id: "locked" }],
        run: {
          findFirst: async () => run,
          updateMany: async () => { closed = true; return { count: 1 }; },
          create: async () => { runCreates += 1; return {}; },
        },
        session: { update: async () => ({}) },
        taskStepOutput: {
          findUnique: async () => null,
          create: async () => { outputCreated = true; return {}; },
        },
        task: {
          findUniqueOrThrow: async () => predecessor,
          findUnique: async () => successor,
          findMany: async () => [predecessor, successor],
          updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            if (where.id === predecessor.id && typeof data.status === "string") predecessor.status = data.status;
            return { count: 1 };
          },
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            if (where.id === successor.id) successorUpdate = data;
            return {};
          },
        },
        taskActivity: {
          findMany: async () => [],
          create: async ({ data }: { data: Record<string, unknown> }) => {
            if (data.taskId === successor.id) successorActivity = data;
            return {};
          },
        },
        agent: { findUnique: async () => successor.assigneeAgent },
        chainControl: { findMany: async () => [] },
        runnerBackendState: { upsert: async () => ({ consecutiveAuthFailures: 0 }) },
      };
      const database = {
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
        // The completion route's pre-transaction principal binding read.
        run: { findMany: async () => [], findUnique: async () => ({ runnerId: "runner-1", task: { templateStep: null } }) },
      } as unknown as PrismaClient;
      const response = await createApp(database).request("/runner/runs/run-1/complete", {
        method: "POST",
        headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          runnerId: "runner-1",
          fencingToken: "1:run-1:token",
          exitCode: 0,
          outcome: { case: "succeeded" },
          cleanupStatus: "SUCCEEDED",
          pushStatus: "NOT_REQUESTED",
          output: "done",
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(closed, true);
      assert.equal(outputCreated, true);
      assert.equal(runCreates, 0);
      assert.equal(successorUpdate?.status, "REVIEW");
      assert.match(String(successorUpdate?.failureReason), /Archived Successor/);
      assert.match(String(successorUpdate?.failureReason), /archived/i);
      assert.equal(successorActivity?.taskId, successor.id);
      assert.equal(successorActivity?.actorType, "control-plane");
      assert.match(String(successorActivity?.body), /predecessor.*complet/i);
      assert.match(String(successorActivity?.body), /Archived Successor/);
      assert.match(String(successorActivity?.body), /archived/i);
    } finally {
      if (previousRoot === undefined) delete process.env.RUNNER_WORKSPACE_ROOT;
      else process.env.RUNNER_WORKSPACE_ROOT = previousRoot;
    }
  });
});

const eventsRequest = (body: unknown): Request => new Request("http://api.test/runner/runs/run-1/events", {
  method: "POST",
  headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("an event over the payload cap is refused by index before database access", async () => {
  await withTokens(async () => {
    const events = [0, 1, 2, 3, 4].map((seq) => ({
      seq,
      source: "CLAUDE",
      type: seq === 3 ? "TOOL_COMPLETED" : "MODEL_DELTA",
      payload: { text: "x".repeat(seq === 3 ? SESSION_EVENT_PAYLOAD_MAX_BYTES + 1 : 8) },
    }));
    const response = await createApp({} as PrismaClient).fetch(eventsRequest({
      runnerId: "runner-1", fencingToken: "fence-1", events,
    }));

    assert.equal(response.status, 413);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body["code"], SESSION_EVENT_PAYLOAD_TOO_LARGE_CODE);
    assert.equal(body["eventIndex"], 3, "the runner drops exactly the named event and resends the rest");
    assert.equal(body["seq"], 3);
    assert.equal(body["limitBytes"], SESSION_EVENT_PAYLOAD_MAX_BYTES);
    assert.ok((body["payloadBytes"] as number) > SESSION_EVENT_PAYLOAD_MAX_BYTES);
  });
});

test("a batch inside the payload cap reaches the append", async () => {
  await withTokens(async () => {
    const database = {
      $transaction: async () => ({ sessionId: "session-1" }),
    } as unknown as PrismaClient;
    const response = await createApp(database).fetch(eventsRequest({
      runnerId: "runner-1",
      fencingToken: "fence-1",
      events: [{ seq: 0, source: "CLAUDE", type: "MODEL_DELTA", payload: { text: "x".repeat(1024) } }],
    }));

    assert.equal(response.status, 200);
  });
});

test("the envelope allowance holds because the conversation identifier is capped", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).fetch(eventsRequest({
      runnerId: "runner-1",
      fencingToken: "fence-1",
      // The one envelope field a provider grows. Left unbounded it pushes a
      // legal batch past the body cap, and that refusal names no event, so no
      // smaller batch could fix it.
      providerConversationId: "t".repeat(SESSION_EVENT_CONVERSATION_ID_MAX_CHARS + 1),
      events: [{ seq: 0, source: "CLAUDE", type: "MODEL_DELTA", payload: { text: "x" } }],
    }));

    assert.equal(response.status, 400, "an identifier past the cap is malformed, not merely large");
  });
});

test("a request body over the events cap is refused unparsed", async () => {
  await withTokens(async () => {
    const oversized = JSON.stringify({
      runnerId: "runner-1",
      fencingToken: "fence-1",
      // Individually legal events whose batch exceeds the whole-request cap.
      events: Array.from({ length: 16 }, (_unused, seq) => ({
        seq,
        source: "CLAUDE",
        type: "MODEL_DELTA",
        payload: { text: "x".repeat(SESSION_EVENT_PAYLOAD_MAX_BYTES / 2) },
      })),
    });
    assert.ok(oversized.length > SESSION_EVENTS_REQUEST_MAX_BYTES, "the fixture must exceed the cap it tests");
    const response = await createApp({} as PrismaClient).fetch(new Request("http://api.test/runner/runs/run-1/events", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: oversized,
    }));

    assert.equal(response.status, 413);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body["code"], SESSION_EVENTS_REQUEST_TOO_LARGE_CODE);
    assert.equal(body["limitBytes"], SESSION_EVENTS_REQUEST_MAX_BYTES);
  });
});
