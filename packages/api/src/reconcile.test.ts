import assert from "node:assert/strict";
import test from "node:test";

import { CleanupStatus, Prisma, RunStatus, SessionExecutionStatus, TaskStatus, type PrismaClient } from "@anneal/db";

import {
  createArchivedRunNoticeScheduler,
  noteArchivedQueuedRuns,
  reconcileAtStartup,
  reconcileDatabaseRuns,
} from "./reconcile.js";

test("database reconciliation active status query remains limited to three execution states", async () => {
  let statuses: unknown;
  const database = {
    run: { findMany: async ({ where }: { where: { status: RunStatus | { in: unknown } } }) => {
      if (typeof where.status === "object") statuses = where.status.in;
      return [];
    } },
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      $queryRaw: async () => [],
      mergeLeaseEvent: { findMany: async () => [] },
    }),
  } as unknown as PrismaClient;
  assert.equal(await reconcileDatabaseRuns(database), 0);
  assert.deepEqual(statuses, [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING]);
});

test("four concurrent archived-run sweeps use one deterministic idempotency key", async () => {
  const archivedAt = new Date("2026-08-16T06:00:00.000Z");
  const ids = new Set<string>();
  const inserted: Record<string, unknown>[] = [];
  const database = {
    run: {
      findMany: async () => [{
        id: "run-7",
        taskId: "task-7",
        runNumber: 7,
        agent: { name: "Archived Agent", archivedAt },
      }],
    },
    taskActivity: {
      createMany: async ({ data, skipDuplicates }: { data: Record<string, unknown>[]; skipDuplicates: boolean }) => {
        assert.equal(skipDuplicates, true);
        let count = 0;
        for (const row of data) {
          const id = String(row.id);
          if (ids.has(id)) continue;
          ids.add(id);
          inserted.push(row);
          count += 1;
        }
        return { count };
      },
    },
  } as unknown as PrismaClient;
  assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => noteArchivedQueuedRuns(database))), [1, 0, 0, 0]);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.id, "archived-skip:run-7:2026-08-16T06:00:00.000Z");
});

test("archived-run sweep paginates without capping eventual coverage and supports agentId", async () => {
  const archivedAt = new Date("2026-08-16T06:00:00.000Z");
  const seenQueries: Array<Record<string, unknown>> = [];
  const seeded = [
    ...Array.from({ length: 101 }, (_, index) => ({
      id: `queued-${String(index).padStart(3, "0")}`, taskId: `task-${index}`, runNumber: 1,
      status: RunStatus.QUEUED, agentId: "archived-agent", agent: { name: "Archived", archivedAt },
    })),
    { id: "running-1", taskId: "task-2", runNumber: 1, status: RunStatus.RUNNING, agentId: "archived-agent", agent: { name: "Archived", archivedAt } },
    { id: "active-1", taskId: "task-3", runNumber: 1, status: RunStatus.QUEUED, agentId: "active-agent", agent: { name: "Active", archivedAt: null } },
  ];
  const database = {
    run: {
      findMany: async (query: { where: Record<string, unknown>; take: number; cursor?: { id: string }; skip?: number }) => {
        seenQueries.push(query as unknown as Record<string, unknown>);
        const matching = seeded.filter((run) => (
          run.status === query.where.status
          && run.agent.archivedAt !== null
          && (!query.where.agentId || run.agentId === query.where.agentId)
        ));
        const start = query.cursor ? matching.findIndex((run) => run.id === query.cursor?.id) + (query.skip ?? 0) : 0;
        return matching.slice(start, start + query.take);
      },
    },
    taskActivity: { createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }) },
  } as unknown as PrismaClient;
  assert.equal(await noteArchivedQueuedRuns(database), 101);
  assert.equal(await noteArchivedQueuedRuns(database, { agentId: "active-agent" }), 0);
  assert.deepEqual(seenQueries[0]?.where, {
    status: RunStatus.QUEUED,
    taskId: { not: null },
    agent: { archivedAt: { not: null } },
  });
  assert.equal((seenQueries.at(-1)?.where as Record<string, unknown>)?.agentId, "active-agent");
  assert.equal(seenQueries[0]?.take, 100);
  assert.deepEqual(seenQueries[1]?.cursor, { id: "queued-099" });
});

test("claim-time archived-run scheduler coalesces polls and sweeps again after its interval", async () => {
  let sweeps = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const database = {
    run: { findMany: async () => { sweeps += 1; await blocked; return []; } },
  } as unknown as PrismaClient;
  const schedule = createArchivedRunNoticeScheduler(database, 1_000);
  const first = schedule(new Date(1_000));
  const concurrent = schedule(new Date(1_001));
  release?.();
  assert.deepEqual(await Promise.all([first, concurrent]), [0, 0]);
  assert.equal(sweeps, 1);
  assert.equal(await schedule(new Date(1_999)), 0);
  assert.equal(sweeps, 1);
  assert.equal(await schedule(new Date(2_000)), 0);
  assert.equal(sweeps, 2);
});

test("database reconciliation times out expired Inbox waits and makes retained workspace quota-managed", async () => {
  const now = new Date("2026-08-16T07:00:00.000Z");
  const writes: Array<{ target: string; data: Record<string, unknown> }> = [];
  const database = {
    run: {
      findMany: async ({ where }: { where: {
        status: RunStatus | { in: RunStatus[] };
        session?: { is: { resumableUntil: { lt: Date } } };
      } }) => {
        if (where.status !== RunStatus.WAITING_INBOX) return [];
        assert.equal(where.session?.is.resumableUntil.lt, now);
        return [{ id: "waiting-1", taskId: "task-1", session: { id: "session-1", waitingOnMessageId: "message-1" } }];
      },
    },
    $transaction: async (operation: (tx: any) => Promise<unknown>) => operation({
      $queryRaw: async () => [],
      run: { updateMany: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ target: "run", data }); return { count: 1 }; } },
      session: { updateMany: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ target: "session", data }); return { count: 1 }; } },
      inboxMessage: { updateMany: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ target: "message", data }); return { count: 1 }; } },
      task: { update: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ target: "task", data }); return {}; } },
      taskActivity: { findMany: async () => [], create: async () => ({}) },
      mergeLeaseEvent: { findMany: async () => [] },
    }),
  } as unknown as PrismaClient;
  assert.equal(await reconcileDatabaseRuns(database, now), 1);
  assert.equal(writes.find((write) => write.target === "run")?.data.status, RunStatus.TIMED_OUT);
  assert.equal(writes.find((write) => write.target === "session")?.data.executionStatus, SessionExecutionStatus.TIMED_OUT);
  assert.equal(writes.find((write) => write.target === "session")?.data.cleanupStatus, CleanupStatus.RETAINED);
  assert.equal(writes.find((write) => write.target === "task")?.data.status, TaskStatus.REVIEW);
  assert.equal(writes.find((write) => write.target === "message")?.data.status, "CLOSED");
});

test("startup reconciliation does not fail when archived notice persistence fails", async () => {
  const database = {
    run: {
      findMany: async ({ where }: { where: { status: RunStatus | { in: RunStatus[] } } }) => {
        if (where.status === RunStatus.QUEUED) throw new Error("audit unavailable");
        return [];
      },
      count: async () => 0,
    },
    // The retired-park sweep runs in the same startup pass and reads these.
    task: { findMany: async () => [] },
    inboxMessage: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    taskActivity: { findMany: async () => [] },
    taskTemplate: { findMany: async () => [] },
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      $queryRaw: async () => [],
      mergeLeaseEvent: { findMany: async () => [] },
    }),
  } as unknown as PrismaClient;
  const originalError = console.error;
  let logged = "";
  console.error = (...args: unknown[]) => { logged = args.map(String).join(" "); };
  try {
    const result = await reconcileAtStartup(database);
    // Startup still survives the failure, but the count it could not read is
    // `null` rather than `0`: a fabricated zero is indistinguishable from a
    // healthy idle control plane in the startup line an operator reads.
    assert.deepEqual(result, {
      runs: 0,
      openReclaimIntents: 0,
      archivedNotices: null,
    });
    assert.match(logged, /Archived-run startup notice failed.*audit unavailable/);
  } finally {
    console.error = originalError;
  }
});

test("lease-loss retry refuses an archived Agent and parks the Task visibly", async () => {
  const now = new Date("2026-08-16T06:00:00.000Z");
  let queued: Record<string, unknown> | undefined;
  let lostUpdate: Record<string, unknown> | undefined;
  const activities: Record<string, unknown>[] = [];
  const taskUpdates: Record<string, unknown>[] = [];
  const inbox: Record<string, unknown>[] = [];
  const candidate = {
    id: "lost-1", heartbeatAt: new Date(now.getTime() - 20 * 60_000),
    leaseExpiresAt: new Date(now.getTime() - 10 * 60_000), projectId: "project-1",
    taskId: "task-1", goalId: null, agentId: "agent-1", repoId: "repo-1", runNumber: 1,
    runner: "CLAUDE", model: "model", targetBranch: "main", branch: "feature/x", promptHash: "hash",
    maxDurationMin: 120, stallTimeoutMin: 10, maxRunsPerTask: 3, budgetGrants: 0, leaseLossRefunds: 0,
  };
  const database = {
    run: {
      findMany: async ({ where }: { where: { status: unknown } }) => typeof where.status === "object" && where.status !== null && "in" in where.status
        ? [candidate]
        : queued ? [{ id: "retry-2", taskId: "task-1", runNumber: 2, agent: { name: "Archived", archivedAt: now } }] : [],
    },
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      $queryRaw: async (query: TemplateStringsArray | Prisma.Sql, ...parameters: unknown[]) => {
        const sql = "sql" in query ? query.sql : query.join("");
        const values = "values" in query ? query.values : parameters;
        if (sql.includes('FROM "TaskActivity" AS deferred')) {
          assert.deepEqual(values, [100]);
          return [];
        }
        return sql.includes("TaskActivity") ? [] : [{ id: "task-1", archivedAt: null }];
      },
      agent: { findUnique: async () => ({ id: "agent-1", name: "Archived", archivedAt: now }) },
      run: {
        findFirst: async () => ({ id: "lost-1", cancelRequestId: null, cancelReason: null, cancelRequestedAt: null }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => { lostUpdate = data; return { count: 1 }; },
        create: async ({ data }: { data: Record<string, unknown> }) => { queued = data; return { id: "retry-2", ...data }; },
      },
      session: { updateMany: async () => ({ count: 1 }) },
      task: {
        update: async ({ data }: { data: Record<string, unknown> }) => { taskUpdates.push(data); return {}; },
        findUnique: async () => ({
          id: "task-1", projectId: "project-1", name: "Lost task", description: "retry",
          assigneeType: "AGENT", assigneeAgentId: "agent-1",
          assigneeAgent: { id: "agent-1", name: "Archived", archivedAt: now },
          repoId: null, repo: null, templateId: null, templateStepId: null, templateStep: null,
          chainId: null, chainIndex: null, targetBranch: "main", opensPullRequest: true,
          maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 3, archivedAt: null,
          runs: [{ ...candidate, maxRunsPerTask: 4, budgetGrants: 1 }],
        }),
        findUniqueOrThrow: async () => ({ id: "task-1", archivedAt: null }),
      },
      taskActivity: {
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return {}; },
      },
      mergeLeaseEvent: { findMany: async () => [] },
      inboxMessage: {
        create: async ({ data }: { data: Record<string, unknown> }) => { inbox.push(data); return {}; },
        upsert: async ({ create }: { create: Record<string, unknown> }) => { inbox.push(create); return {}; },
      },
    }),
    taskActivity: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => { activities.push(...data); return { count: data.length }; },
    },
  } as unknown as PrismaClient;
  assert.equal(await reconcileDatabaseRuns(database, now), 1);
  assert.equal(lostUpdate?.failureClass, "CANCELLED_OR_TIMED_OUT");
  assert.match(String(lostUpdate?.failureReason), /heartbeat starved.*lease expired/i);
  assert.equal(queued, undefined);
  assert.equal(taskUpdates.at(-1)?.status, TaskStatus.REVIEW);
  assert.match(String(taskUpdates.at(-1)?.failureReason), /Archived/i);
  assert.match(String(activities.at(-1)?.body), /automatic retry refused.*Archived/i);
  assert.match(String(inbox.at(-1)?.body), /Automatic retry refused.*Archived/i);
});

/* --------------------------------------------- bounded lease-loss refunds */

// One mock for the whole bound: a Run whose lease has expired, a task whose
// refund count is the only thing that varies between the cases below.
const lostRunDatabase = (options: {
  leaseLossRefunds: number;
  maxSessionsPerTask?: number;
  runNumber?: number;
  spendCap?: string;
  spentUsd?: string;
}) => {
  const now = new Date("2026-09-06T06:00:00.000Z");
  const created: Record<string, unknown>[] = [];
  const lostUpdates: Record<string, unknown>[] = [];
  const activities: Record<string, unknown>[] = [];
  const taskUpdates: Record<string, unknown>[] = [];
  const inbox: Record<string, unknown>[] = [];
  const candidate = {
    id: "lost-1", heartbeatAt: new Date(now.getTime() - 20 * 60_000),
    leaseExpiresAt: new Date(now.getTime() - 10 * 60_000), projectId: "project-1",
    taskId: "task-1", goalId: null, agentId: "agent-1", repoId: null, runNumber: options.runNumber ?? 2,
    runner: "CLAUDE", model: "model", targetBranch: "main", branch: "feature/x", promptHash: "hash",
    cancelRequestedAt: null, cancelRequestId: null, cancelReason: null,
    maxDurationMin: 120, stallTimeoutMin: 10,
    maxRunsPerTask: (options.maxSessionsPerTask ?? 5) + options.leaseLossRefunds,
    budgetGrants: options.leaseLossRefunds,
    leaseLossRefunds: options.leaseLossRefunds,
  };
  const live = { id: "agent-1", name: "Senior Dev", archivedAt: null };
  const database = {
    run: {
      findMany: async ({ where }: { where: { status: unknown } }) => (
        typeof where.status === "object" && where.status !== null && "in" in where.status ? [candidate] : []
      ),
    },
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      $queryRaw: async (query: TemplateStringsArray | Prisma.Sql) => {
        const sql = "sql" in query ? query.sql : query.join("");
        if (sql.includes('FROM "TaskActivity" AS deferred')) return [];
        return sql.includes("TaskActivity") ? [] : [{ id: "task-1", archivedAt: null }];
      },
      agent: { findUnique: async () => live },
      run: {
        // The spend-cap basis reads every Run of the task priced by its session.
        findMany: async () => (options.spentUsd === undefined ? [] : [{
          model: "model",
          session: {
            costUsd: new Prisma.Decimal(options.spentUsd),
            inputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: null,
            outputTokens: null, nativeChildUsed: false,
          },
        }]),
        findFirst: async () => ({ id: "lost-1", cancelRequestId: null, cancelReason: null, cancelRequestedAt: null, headSha: null }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          lostUpdates.push(data);
          return { count: 1 };
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "retry-3", ...data };
        },
      },
      session: { updateMany: async () => ({ count: 1 }) },
      task: {
        update: async ({ data }: { data: Record<string, unknown> }) => { taskUpdates.push(data); return {}; },
        findUnique: async () => ({
          id: "task-1", projectId: "project-1", name: "Lost task", description: "retry",
          assigneeType: "AGENT", assigneeAgentId: "agent-1", assigneeAgent: live,
          repoId: null, repo: null, templateId: null, templateStepId: null, templateStep: null,
          chainId: null, chainIndex: null, chainLayer: null, targetBranch: "main", opensPullRequest: true,
          maxDurationMin: 120, stallTimeoutMin: 10,
          maxSessionsPerTask: options.maxSessionsPerTask ?? 5,
          spendCap: options.spendCap === undefined ? null : new Prisma.Decimal(options.spendCap),
          archivedAt: null,
          runs: [candidate],
        }),
        findUniqueOrThrow: async () => ({ id: "task-1", archivedAt: null }),
      },
      taskActivity: {
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return {}; },
      },
      mergeLeaseEvent: { findMany: async () => [] },
      inboxMessage: {
        create: async ({ data }: { data: Record<string, unknown> }) => { inbox.push(data); return {}; },
        upsert: async ({ create }: { create: Record<string, unknown> }) => { inbox.push(create); return {}; },
      },
    }),
    taskActivity: { createMany: async () => ({ count: 0 }) },
  } as unknown as PrismaClient;
  return { database, now, created, lostUpdates, activities, taskUpdates, inbox };
};

test("a lease-loss replacement is spaced by the refunds already granted and records the next one", async () => {
  // The completion path's schedule, read off the refund count: 30s, 60s, 120s.
  for (const [refunds, delayMs] of [[0, 30_000], [1, 60_000], [2, 120_000]] as const) {
    const { database, now, created, lostUpdates } = lostRunDatabase({ leaseLossRefunds: refunds });
    assert.equal(await reconcileDatabaseRuns(database, now), 1);
    assert.equal(created.length, 1, `refund ${refunds}`);
    assert.equal(
      (created[0]?.readyAt as Date).getTime() - now.getTime(),
      delayMs,
      `refund ${refunds} backs off`,
    );
    assert.equal(created[0]?.leaseLossRefunds, refunds + 1, `refund ${refunds} counts once`);
    // The refund is still a refund: the lost Run records the grant it bought.
    assert.equal(lostUpdates.at(-1)?.budgetGrants, refunds + 1, `refund ${refunds} grants`);
  }
});

test("the fourth lease loss is refused by name, parks the Task, and grants nothing", async () => {
  const { database, now, created, lostUpdates, activities, taskUpdates, inbox } = lostRunDatabase({
    leaseLossRefunds: 3,
  });

  assert.equal(await reconcileDatabaseRuns(database, now), 1);

  assert.deepEqual(created, [], "no replacement is queued");
  assert.equal(taskUpdates.at(-1)?.status, TaskStatus.REVIEW);
  assert.match(String(taskUpdates.at(-1)?.failureReason), /Lease-loss refunds exhausted after 3/);
  assert.match(String(activities.at(-1)?.body), /Run 2 lost; automatic retry refused/);
  assert.match(String(inbox.at(-1)?.body), /Lease-loss refunds exhausted/);
  // A refund nobody may use is not recorded: the operator's own retry must not
  // inherit the attempt this reconciliation just refused.
  assert.equal(lostUpdates.at(-1)?.budgetGrants, 3);
  assert.equal(lostUpdates.at(-1)?.maxRunsPerTask, 8);
});

test("refund exhaustion wins when the fourth lost run also reaches the ordinary ceiling", async () => {
  const { database, now, created, activities, taskUpdates } = lostRunDatabase({
    leaseLossRefunds: 3, maxSessionsPerTask: 1, runNumber: 4,
  });
  await reconcileDatabaseRuns(database, now);
  assert.equal(created.length, 0);
  assert.equal(taskUpdates.at(-1)?.status, TaskStatus.REVIEW);
  assert.match(String(taskUpdates.at(-1)?.failureReason), /Lease-loss refunds exhausted/);
  assert.equal(activities.filter((activity) =>
    (activity.metadata as { refusal?: string } | undefined)?.refusal === "lease-loss-refunds-exhausted").length, 1);
});
