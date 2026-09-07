import "./test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import { RunStatus, RunnerKind, type PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";
import { createRunnerRegistry, RUNNER_FORGET_MS } from "./runners.js";

const BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("runner online windows use the 30s floor and three poll intervals", () => {
  const registry = createRunnerRegistry();
  const start = new Date("2026-08-17T00:00:00.000Z");
  registry.note("fast", { pollIntervalMs: 5_000 }, start);
  registry.note("slow", { pollIntervalMs: 20_000 }, start);
  assert.equal(registry.snapshot(new Date(start.getTime() + 29_000)).find((row) => row.runnerId === "fast")?.online, true);
  assert.equal(registry.snapshot(new Date(start.getTime() + 31_000)).find((row) => row.runnerId === "fast")?.online, false);
  assert.equal(registry.snapshot(new Date(start.getTime() + 59_000)).find((row) => row.runnerId === "slow")?.online, true);
  assert.equal(registry.snapshot(new Date(start.getTime() + 61_000)).find((row) => row.runnerId === "slow")?.online, false);
});

test("runner observations replace omitted telemetry", () => {
  const registry = createRunnerRegistry();
  const now = new Date("2026-08-17T00:00:00.000Z");
  registry.note("runner-a", { daemonVersion: "1.0.0", diskFreeBytes: 42, pollIntervalMs: 5_000, workspaceRoot: "/tmp" }, now);
  registry.note("runner-a", {}, new Date(now.getTime() + 1_000));
  assert.deepEqual(registry.snapshot(new Date(now.getTime() + 2_000))[0], {
    runnerId: "runner-a", lastSeenAt: new Date(now.getTime() + 1_000), online: true,
    daemonVersion: null, diskFreeBytes: null, pollIntervalMs: null, workspaceRoot: null,
  });
});

test("the registry keeps every runner inside the forget window and retires stale entries", () => {
  const registry = createRunnerRegistry();
  const start = new Date("2026-08-17T00:00:00.000Z");
  registry.note("stale-runner", {}, start);
  const recent = Array.from({ length: 23 }, (_, index) => `runner-${String(index + 1).padStart(2, "0")}`);
  for (const runnerId of recent) registry.note(runnerId, {}, new Date(start.getTime() + 1));

  const snapshot = registry.snapshot(new Date(start.getTime() + RUNNER_FORGET_MS + 1));
  assert.deepEqual(snapshot.map((row) => row.runnerId), recent);
});

const withTokens = async (operation: () => Promise<void>): Promise<void> => {
  const operator = process.env.OPERATOR_TOKEN;
  const runner = process.env.RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = "runners-test-operator";
  process.env.RUNNER_TOKEN = "runners-test-runner";
  try { await operation(); } finally {
    if (operator === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = operator;
    if (runner === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = runner;
  }
};

type DrainRow = { reason: string; startedAt: Date; expiresAt: Date };

/** The stored drain, answered through the same deadline predicate the route
 * and the claim send: an expired row is absent to both of them. */
const drainReader = (drain: DrainRow | null) => ({
  findFirst: async ({ where }: { where: { expiresAt: { gt: Date } } }) =>
    drain !== null && drain.expiresAt > where.expiresAt.gt ? drain : null,
});

const makeDatabase = (
  candidates: Record<string, unknown>[] = [],
  barrierGranted = true,
  onCandidateRead: () => void = () => undefined,
  drain: DrainRow | null = null,
): PrismaClient => {
  const tx = {
    dispatchDrain: drainReader(drain),
    $queryRaw: async (query: unknown) => {
      const sql = Array.isArray(query) ? query.join("") : JSON.stringify(query);
      if (sql.includes("pg_try_advisory_xact_lock_shared")) return [{ granted: barrierGranted }];
      if (sql.includes('FROM \\"TaskActivity\\" AS activity') || sql.includes('FROM "TaskActivity" AS activity')) return [];
      if (sql.includes('FROM \\"TaskActivity\\" AS deferred') || sql.includes('FROM "TaskActivity" AS deferred')) return [];
      if (sql.includes('FROM "Run" AS candidate')) {
        onCandidateRead();
        return candidates.map(({ id }) => ({ id }));
      }
      if (sql.includes('FROM "Task"')) {
        return candidates.map(({ task }) => ({ id: (task as { id: string }).id }));
      }
      throw new Error(`Unexpected raw claim query: ${sql}`);
    },
    // The claim loop brackets every candidate in a savepoint.
    $executeRawUnsafe: async () => 0,
    run: {
      findMany: async () => { onCandidateRead(); return candidates; },
      findFirst: async () => null,
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ id: where.id, status: RunStatus.CLAIMED }),
    },
    runnerBackendState: { findUnique: async () => null },
    session: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "session-1", ...data }) },
    sessionEvent: { aggregate: async () => ({ _max: { seq: null } }) },
    task: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const found = candidates.find((candidate) => (candidate.task as { id?: string } | undefined)?.id === where.id);
        const task = found?.task as { id: string; chainId: string | null; status?: string } | undefined;
        return task ? {
          ...task,
          projectId: "project-1",
          archivedAt: null,
          assigneeAgentId: null,
          status: task.status ?? "TODO",
        } : null;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const found = candidates.find((candidate) => (candidate.task as { id?: string } | undefined)?.id === where.id);
        const task = found?.task as { id: string; chainId: string | null; status?: string } | undefined;
        if (!task) throw new Error(`Task ${where.id} not found`);
        return {
          ...task,
          projectId: "project-1",
          archivedAt: null,
          assigneeAgentId: null,
          status: task.status ?? "TODO",
        };
      },
      update: async () => ({}),
    },
    taskActivity: { findMany: async () => [], findFirst: async () => null, create: async () => ({}) },
    mergeLeaseEvent: { findMany: async () => [] },
    taskStepOutput: { findMany: async () => [] },
  };
  return {
    dispatchDrain: drainReader(drain),
    run: {
      findMany: async () => [],
      groupBy: async ({ where }: { where: { status: { in: RunStatus[] } } }) => {
        assert.deepEqual(where.status.in, [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING, RunStatus.WAITING_INBOX]);
        assert.ok(!(where.status.in as RunStatus[]).includes(RunStatus.QUEUED));
        return [{ runnerId: "runner-a", _count: { _all: 1 } }];
      },
    },
    runnerBackendState: { findMany: async () => [{ runner: RunnerKind.CLAUDE, cliVersion: "1.2.3", authMode: "subscription", lastPreflightAt: new Date(), lastPreflightOk: true, circuitOpen: false, circuitReason: null }] },
    taskActivity: { createMany: async () => ({ count: 0 }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
};

test("deploy barrier refuses claims before candidate reads", async () => {
  await withTokens(async () => {
    let candidateRead = false;
    const database = makeDatabase([], false, () => { candidateRead = true; });
    assert.equal((await runnerRequest(createApp(database), {})).status, 204);
    assert.equal(candidateRead, false);
  });
});

const runnerRequest = async (app: ReturnType<typeof createApp>, body: Record<string, unknown>): Promise<Response> => app.request("/runner/tasks/claim", {
  method: "POST",
  headers: { Authorization: "Bearer runners-test-runner", "Content-Type": "application/json" },
  body: JSON.stringify({ runnerId: "runner-a", leaseSeconds: 60, ...body }),
});

test("GET /runners is operator-only, includes all backends, and ages a 204 claim", async () => {
  await withTokens(async () => {
    const app = createApp(makeDatabase());
    assert.equal((await app.request("/runners")).status, 401);
    assert.equal((await app.request("/runners", { headers: { Authorization: "Bearer runners-test-runner" } })).status, 403);
    assert.equal((await runnerRequest(app, { daemonVersion: BUILD_COMMIT })).status, 204);
    const response = await app.request("/runners", { headers: { Authorization: "Bearer runners-test-operator" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { checkedAt: string; online: number; total: number; daemons: Array<{ busy: boolean; activeRuns: number; daemonVersion: string | null }>; backends: Array<{ runner: RunnerKind; cliVersion: string | null }> };
    assert.ok(Date.parse(body.checkedAt));
    assert.equal(body.online, 1);
    assert.equal(body.total, 1);
    assert.deepEqual(body.daemons.map(({ busy, activeRuns }) => ({ busy, activeRuns })), [{ busy: true, activeRuns: 1 }]);
    assert.deepEqual(body.daemons.map(({ daemonVersion }) => daemonVersion), [BUILD_COMMIT]);
    assert.deepEqual(body.backends.map((backend) => backend.runner).sort(), Object.values(RunnerKind).sort());
    assert.equal(body.backends.find((backend) => backend.runner === RunnerKind.CLAUDE)?.cliVersion, "1.2.3");
    assert.equal(body.backends.find((backend) => backend.runner === RunnerKind.CODEX)?.cliVersion, null);
  });
});

test("two runner observations can share one reported API workspace root", async () => {
  await withTokens(async () => {
    const app = createApp(makeDatabase());
    const workspaceRoot = "/isolated/shared-runner-root";
    assert.equal((await runnerRequest(app, { runnerId: "runner-a", workspaceRoot })).status, 204);
    assert.equal((await runnerRequest(app, { runnerId: "runner-b", workspaceRoot })).status, 204);
    const response = await app.request("/runners", { headers: { Authorization: "Bearer runners-test-operator" } });
    const body = await response.json() as { total: number; daemons: Array<{ runnerId: string; workspaceRoot: string | null }> };
    assert.equal(body.total, 2);
    assert.deepEqual(body.daemons.map(({ runnerId, workspaceRoot: root }) => ({ runnerId, root })), [
      { runnerId: "runner-a", root: workspaceRoot },
      { runnerId: "runner-b", root: workspaceRoot },
    ]);
  });
});

test("invalid optional telemetry cannot block empty or successful claims", async () => {
  await withTokens(async () => {
    const emptyApp = createApp(makeDatabase());
    assert.equal((await runnerRequest(emptyApp, { diskFreeBytes: -1 })).status, 204);
    assert.equal((await runnerRequest(emptyApp, { runnerId: "" })).status, 400);
    const emptyStatus = await emptyApp.request("/runners", { headers: { Authorization: "Bearer runners-test-operator" } });
    const emptyBody = await emptyStatus.json() as { daemons: Array<{ diskFreeBytes: number | null }> };
    assert.equal(emptyBody.daemons[0]?.diskFreeBytes, null);

    const candidate = {
      id: "run-1", projectId: "project-1", taskId: "task-1", goalId: null, agentId: "agent-1", repoId: "repo-1",
      runner: RunnerKind.CLAUDE, runNumber: 1, leaseGeneration: 0, maxDurationMin: 120, session: null,
      task: { id: "task-1", chainId: null, chainIndex: null, templateStep: null }, repo: { id: "repo-1" },
      agent: { id: "agent-1", repoAccess: [{ repoId: "repo-1", projectId: "project-1" }], environment: { secrets: [] }, secretGrants: [] },
    };
    const claimedApp = createApp(makeDatabase([candidate]));
    const claimed = await runnerRequest(claimedApp, { diskFreeBytes: -1, daemonVersion: "0.0.0", pollIntervalMs: 5_000, workspaceRoot: "/tmp/runs" });
    assert.equal(claimed.status, 200);
    const claimedStatus = await claimedApp.request("/runners", { headers: { Authorization: "Bearer runners-test-operator" } });
    const claimedBody = await claimedStatus.json() as { daemons: Array<{ diskFreeBytes: number | null; daemonVersion: string | null; workspaceRoot: string | null }> };
    assert.deepEqual(claimedBody.daemons.map(({ diskFreeBytes, daemonVersion, workspaceRoot }) => ({ diskFreeBytes, daemonVersion, workspaceRoot })), [
      { diskFreeBytes: null, daemonVersion: "0.0.0", workspaceRoot: "/tmp/runs" },
    ]);
  });
});

test("a stale heartbeat still records that the daemon is alive", async () => {
  await withTokens(async () => {
    const database = makeDatabase() as unknown as { run: Record<string, unknown> };
    // `findUnique` is what the refusal is explained from: no row means the
    // heartbeat is refused as `unknown-run` rather than guessed at.
    database.run = {
      ...database.run,
      updateMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      findUnique: async () => null,
    };
    const app = createApp(database as unknown as PrismaClient);
    const response = await app.request("/runner/runs/run-1/heartbeat", {
      method: "POST", headers: { Authorization: "Bearer runners-test-runner", "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "heartbeat-runner", fencingToken: "1:run-1:fence", leaseSeconds: 60, processAlive: true, daemonVersion: "0.0.0" }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Stale fencing token", reason: "unknown-run" });
    const status = await app.request("/runners", { headers: { Authorization: "Bearer runners-test-operator" } });
    const body = await status.json() as { daemons: Array<{ runnerId: string }> };
    assert.equal(body.daemons[0]?.runnerId, "heartbeat-runner");
  });
});

test("an unexpired dispatch drain refuses every claim and explains the idle fleet", async () => {
  await withTokens(async () => {
    let candidateRead = false;
    const drain = {
      reason: "quiet-window-wait-exceeded host=vm-control-plane role=control-plane from=aaaaaaaaaaaa to=bbbbbbbbbbbb",
      startedAt: new Date("2026-09-07T01:00:00.000Z"),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    };
    const candidate = {
      id: "drained-run",
      projectId: "project-1",
      taskId: "drained-task",
      goalId: null,
      agentId: "agent-1",
      repoId: "repo-1",
      runner: RunnerKind.CLAUDE,
      runNumber: 1,
      leaseGeneration: 0,
      maxDurationMin: 120,
      session: null,
      task: { id: "drained-task", chainId: null, chainIndex: null, templateStep: null },
      repo: { id: "repo-1" },
      agent: {
        id: "agent-1",
        repoAccess: [{ repoId: "repo-1", projectId: "project-1" }],
        environment: { secrets: [] },
        secretGrants: [],
      },
    };
    const app = createApp(makeDatabase([candidate], true, () => { candidateRead = true; }, drain));

    const refused = await runnerRequest(app, {});
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), {
      error: `Dispatch is draining for a pending deploy (${drain.reason})`,
      reason: "dispatch-draining",
      code: "dispatch-draining",
      expiresAt: drain.expiresAt.toISOString(),
    });
    assert.equal(candidateRead, true, "a drained claim checks the candidate step before refusing agent work");

    const status = await app.request("/runners", { headers: { Authorization: "Bearer runners-test-operator" } });
    const body = await status.json() as { daemons: Array<{ online: boolean }>; dispatchDrain: unknown };
    // The refused runner is still online: it heartbeats through the drain.
    assert.deepEqual(body.daemons.map(({ online }) => online), [true]);
    assert.deepEqual(body.dispatchDrain, {
      reason: drain.reason,
      startedAt: drain.startedAt.toISOString(),
      expiresAt: drain.expiresAt.toISOString(),
    });
  });
});

test("an expired dispatch drain is absent to the claim and to GET /runners", async () => {
  await withTokens(async () => {
    const expired = {
      reason: "quiet-window-wait-exceeded host=mac-runner-1 role=runner from=aaaaaaaaaaaa to=bbbbbbbbbbbb",
      startedAt: new Date(Date.now() - 3 * 60 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    };
    const app = createApp(makeDatabase([], true, () => undefined, expired));

    assert.equal((await runnerRequest(app, {})).status, 204);
    const status = await app.request("/runners", { headers: { Authorization: "Bearer runners-test-operator" } });
    assert.equal((await status.json() as { dispatchDrain: unknown }).dispatchDrain, null);
  });
});
