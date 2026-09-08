import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  Prisma,
  RunStatus,
  type PrismaClient,
} from "@anneal/db";

import { createApp, partitionArchivable } from "./test-app.js";
import { createApp as createLiveApp } from "./app.js";
import { LOOPBACK_BROWSER_ORIGINS } from "./local-origin.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
import {
  boardDatabase,
  getTasks,
  taskRow,
  untouchableDatabase,
  withTokens,
} from "./routes/test-support.js";

test("public root reports the execution kernel without touching Prisma", async () => {
  const response = await createApp({} as PrismaClient).request("/");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: "Anneal control plane", phase: "execution-kernel" });
});

test("API routes reject requests without a principal token", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/projects");
    assert.equal(response.status, 401);
  });
});

test("runner principal cannot cross into operator routes", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/projects", {
      headers: { Authorization: "Bearer runner-unit-token" },
    });
    assert.equal(response.status, 403);
  });
});

test("operator principal cannot impersonate a runner", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "fake-runner", leaseSeconds: 60 }),
    });
    assert.equal(response.status, 403);
  });
});

test("live claim reconciliation asserts root ownership before touching database state", async () => {
  await withTokens(async () => {
    let databaseTouched = false;
    const database = {
      run: { findMany: async () => { databaseTouched = true; return []; } },
    } as unknown as PrismaClient;
    const app = createLiveApp(database, {
      ownership: { assertHeld: () => { throw new Error("ownership-poisoned-for-test"); } },
    });
    const response = await app.request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "runner-1", leaseSeconds: 60 }),
    });
    assert.equal(response.status, 500);
    assert.equal(databaseTouched, false);
  });
});

test("heavy polled collection routes validate unchanged payloads and change validators with data", async () => {
  await withTokens(async () => {
    let version = 1;
    const database = {
      project: { findMany: async () => [{ id: `project-${version}` }] },
      agent: { findMany: async () => [{ id: `agent-${version}`, name: "worker" }] },
      repo: { findMany: async () => [{ id: `repo-${version}` }] },
      inboxMessage: { findMany: async () => [{
        id: `message-${version}`, status: "OPEN", from: "AGENT", kind: "CHOICE", choices: null,
        gateTaskId: null, replyToMessageId: null, decisions: [], replies: [], session: null,
      }] },
      session: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const app = createApp(database);
    for (const path of ["/projects", "/projects/project-1/agents", "/projects/project-1/repos", "/inbox/messages"]) {
      const first = await app.request(path, { headers: { Authorization: "Bearer operator-unit-token" } });
      assert.equal(first.status, 200, path);
      const firstTag = first.headers.get("ETag");
      assert.ok(firstTag, `${path} did not return an ETag`);
      const unchanged = await app.request(path, {
        headers: { Authorization: "Bearer operator-unit-token", "If-None-Match": firstTag },
      });
      assert.equal(unchanged.status, 304, path);
      assert.equal(await unchanged.text(), "", `${path} returned a 304 body`);
      version += 1;
      const changed = await app.request(path, {
        headers: { Authorization: "Bearer operator-unit-token", "If-None-Match": firstTag },
      });
      assert.equal(changed.status, 200, path);
      assert.notEqual(changed.headers.get("ETag"), firstTag, path);
    }
  });
});

test("startup reconciliation spares a run whose runner is still heartbeating", async () => {
  const now = new Date("2026-08-15T12:00:00Z");
  const candidates = [
    // Lease expired during an api restart, heartbeat 30s old: still alive.
    { id: "run-live", heartbeatAt: new Date(now.getTime() - 30_000), stallTimeoutMin: 10, taskId: "task-1", runNumber: 1, maxRunsPerTask: 3, cancelRequestId: null, cancelReason: null, cancelRequestedAt: null },
    // Silent for 20 minutes: really gone.
    { id: "run-dead", heartbeatAt: new Date(now.getTime() - 20 * 60_000), stallTimeoutMin: 10, taskId: "task-2", runNumber: 1, maxRunsPerTask: 3, cancelRequestId: null, cancelReason: null, cancelRequestedAt: null },
  ];
  const lost: string[] = [];
  const database = {
    run: {
      findMany: async ({ where }: { where: { status: RunStatus | { in: RunStatus[] } } }) => (
        typeof where.status === "object" ? candidates : []
      ),
      updateMany: async ({ where }: { where: { id: string } }) => { lost.push(where.id); return { count: 1 }; },
      create: async () => ({}),
    },
    $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
      $queryRaw: async (query: TemplateStringsArray | Prisma.Sql, ...parameters: unknown[]) => {
        const sql = "sql" in query ? query.sql : query.join("");
        const values = "values" in query ? query.values : parameters;
        if (sql.includes('FROM "TaskActivity" AS deferred')) {
          assert.deepEqual(values, [100]);
          return [];
        }
        return sql.includes('FROM "TaskActivity" AS activity') ? [] : [{ id: "task-2", archivedAt: null }];
      },
      run: {
        findFirst: async () => ({ cancelRequestId: null, cancelReason: null, cancelRequestedAt: null }),
        updateMany: async ({ where }: { where: { id: string } }) => { lost.push(where.id); return { count: 1 }; },
        create: async () => ({}),
      },
      session: { updateMany: async () => ({}) },
      // The requeue loads the task to decide whether to recompute a chain
      // step's branches; a null row keeps the lost run's fields verbatim.
      task: {
        update: async () => ({}),
        findUnique: async () => null,
        findUniqueOrThrow: async () => ({ id: "task-2", archivedAt: null }),
      },
      taskActivity: { findMany: async () => [], create: async () => ({}) },
      mergeLeaseEvent: { findMany: async () => [] },
      inboxMessage: { create: async () => ({}), upsert: async () => ({}) },
    }),
  } as unknown as PrismaClient;
  assert.equal(await reconcileDatabaseRuns(database, now), 1);
  assert.deepEqual(lost, ["run-dead"]);
});

test("partitionArchivable keeps the busy tasks out of the archive set and counts them as skipped", () => {
  assert.deepEqual(partitionArchivable(["a", "b", "c"], ["b"]), { archive: ["a", "c"], skipped: 1 });
  assert.deepEqual(partitionArchivable(["a", "b"], []), { archive: ["a", "b"], skipped: 0 });
  assert.deepEqual(partitionArchivable([], ["b"]), { archive: [], skipped: 0 });
  // A busy id that is not a candidate cannot inflate the skipped count.
  assert.deepEqual(partitionArchivable(["a"], ["z"]), { archive: ["a"], skipped: 0 });
});

test("an unknown view is refused rather than silently served as the full shape", async () => {
  await withTokens(async () => {
    const response = await getTasks(boardDatabase([]), "?view=compact");
    assert.equal(response.status, 400);
  });
});

test("GET /tasks carries a validator, and an unchanged poll costs a header exchange", async () => {
  await withTokens(async () => {
    const first = await getTasks(boardDatabase([taskRow()]), "?view=board");
    const tag = first.headers.get("etag");
    assert.ok(tag, "no ETag");
    assert.equal(first.headers.get("cache-control"), "no-cache");

    // Same rows, same bytes: 304 and an empty body instead of the payload.
    const second = await getTasks(boardDatabase([taskRow()]), "?view=board", { "If-None-Match": tag! });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), "");
    assert.equal(second.headers.get("etag"), tag);

    // One row moved: the validator changes and the payload comes back.
    const third = await getTasks(boardDatabase([taskRow({ status: "DONE" })]), "?view=board", { "If-None-Match": tag! });
    assert.equal(third.status, 200);
    assert.notEqual(third.headers.get("etag"), tag);
  });
});

test("the full shape is validated too, and its two shapes never share a tag", async () => {
  await withTokens(async () => {
    const full = await getTasks(boardDatabase([taskRow()]), "");
    assert.equal(full.status, 200);
    const body = await full.json() as Array<Record<string, unknown>>;
    assert.equal("runs" in body[0]!, true, "the full shape keeps the Run rows");
    assert.equal(body[0]!.chainProgress, null);
    assert.equal(body[0]!.recurringLastFiredAt, null);
    assert.equal(body[0]!.recurringFireCount, 0);
    assert.equal("moveTargets" in body[0]!, false, "operator move targets remain detail-only");
    const board = await getTasks(boardDatabase([taskRow()]), "?view=board");
    assert.notEqual(full.headers.get("etag"), board.headers.get("etag"));
  });
});

test("only the exact loopback browser origins are answered cross-origin", async () => {
  const app = createApp({} as PrismaClient);
  for (const origin of LOOPBACK_BROWSER_ORIGINS) {
    const response = await app.request("/", { headers: { Origin: origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }
  // Every other origin — including the `localhost` spelling of the same port,
  // which is a different origin to a browser and a DNS name to this process.
  for (const origin of [
    "http://localhost:5173",
    "http://127.0.0.1:5173.evil.example",
    "http://127.0.0.2:5173",
    "https://127.0.0.1:5173",
    "http://evil.example",
    "null",
  ]) {
    const response = await app.request("/", { headers: { Origin: origin } });
    const allowed = response.headers.get("access-control-allow-origin");
    assert.notEqual(allowed, "*", `${origin} was answered with a wildcard`);
    assert.notEqual(allowed, origin, `${origin} was allowed`);
  }
});

test("no wildcard CORS origin survives anywhere in the app", () => {
  const source = readFileSync(fileURLToPath(new URL("./app.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /origin:\s*"\*"/u);
});

test("a request from a foreign origin is refused before it reaches a handler", async () => {
  const app = createApp(untouchableDatabase());
  for (const origin of [
    "http://evil.example",
    "https://evil.example",
    "http://localhost:5173",     // a name, not the numeric loopback
    "http://127.0.0.1:5173.evil.example",
    "http://127.0.0.2:5173",
    "https://127.0.0.1:5173",
    "http://127.0.0.1",          // no port is not an origin this server serves
    "http://127.0.0.1:99999",    // not a port
    "null",                      // an opaque origin: a sandboxed frame or a data: URL
  ]) {
    for (const path of ["/", "/health", "/version", "/tasks"]) {
      const response = await app.request(path, { method: "POST", headers: { Origin: origin } });
      assert.equal(response.status, 403, `${origin} reached ${path}`);
      assert.equal((await response.json() as { error: string }).error, "Forbidden origin");
    }
  }
});

test("a loopback origin on any port is admitted, because `vite --port` is a supported way to start the dev server", async () => {
  await withTokens(async () => {
    const app = createApp({} as PrismaClient);
    for (const origin of ["http://127.0.0.1:5173", "http://127.0.0.1:4173", "http://127.0.0.1:5199", "http://127.0.0.1:39322"]) {
      assert.equal((await app.request("/", { headers: { Origin: origin } })).status, 200, `${origin} was refused`);
      // Past the origin check and into the ordinary principal check, not past it.
      assert.equal((await app.request("/projects", { headers: { Origin: origin } })).status, 401, `${origin} was refused`);
    }
    // And a request with no Origin at all — the runner, the CLI, a local curl.
    assert.equal((await app.request("/")).status, 200);
  });
});

test("the public surface and the 401/403 boundary are unchanged by the origin allowlist", async () => {
  await withTokens(async () => {
    const app = createApp({} as PrismaClient);
    const origin = "http://127.0.0.1:5173";
    // Public routes stay public: the origin check is a boundary, not authentication.
    assert.equal((await app.request("/", { headers: { Origin: origin } })).status, 200);
    // Protected routes still answer 401 without a principal...
    assert.equal((await app.request("/projects", { headers: { Origin: origin } })).status, 401);
    // Principal separation is untouched: an operator token cannot reach a runner
    // route and a runner token cannot reach an operator route.
    const runnerRoute = await app.request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(runnerRoute.status, 403);
    const operatorRoute = await app.request("/projects", { headers: { Authorization: "Bearer runner-unit-token" } });
    assert.equal(operatorRoute.status, 403);
  });
});
