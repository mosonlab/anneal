import assert from "node:assert/strict";
import { test } from "node:test";

import { type Prisma, RunStatus } from "@anneal/db";

import {
  cleanupAuthorityRefusal,
  explainFenceRefusal,
  fencedRunWhere,
  liveAuthorityRefusal,
  lockAuthorityRun,
  runFenceRefusal,
  type LockedAuthorityRun,
  type RunFence,
  salvageAuthorityRefusal,
  withFencedRun,
  withRunOnlyFencedRun,
} from "./run-fence.js";

const fence: RunFence = {
  runId: "run-1",
  runnerId: "runner-1",
  fencingToken: "3:run-1:current",
  at: new Date("2026-08-25T12:00:00.000Z"),
};

type Row = {
  runnerId: string | null;
  fencingToken: string | null;
  cancelRequestedAt: Date | null;
  leaseExpiresAt: Date | null;
  status: RunStatus;
};

const live: Row = {
  runnerId: "runner-1",
  fencingToken: "3:run-1:current",
  cancelRequestedAt: null,
  leaseExpiresAt: new Date("2026-08-25T12:05:00.000Z"),
  status: RunStatus.RUNNING,
};

const explain = (row: Row | null, asked: RunFence = fence) => explainFenceRefusal(
  { run: { findUnique: async () => row } } as unknown as Prisma.TransactionClient,
  asked,
);

test("one fenced read owns its clock and Run -> Task lock order", async () => {
  const calls: string[] = [];
  const predicates: Prisma.RunWhereInput[] = [];
  let read = 0;
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => {
      if (query.join("?").includes('FROM "Run"')) {
        calls.push("lock.run");
        return [{ id: "run-1" }];
      }
      calls.push("lock.task");
      return [{ id: "task-1", archivedAt: null }];
    },
    run: {
      findFirst: async ({ where }: { where: Prisma.RunWhereInput }) => {
        predicates.push(where);
        calls.push(`read.${++read}`);
        return read === 1 ? { taskId: "task-1" } : { id: "run-1" };
      },
    },
  } as unknown as Prisma.TransactionClient;

  const result = await withFencedRun(tx, fence, { id: true }, (run) => {
    calls.push("body");
    return run.id;
  });

  assert.equal(result, "run-1");
  assert.deepEqual(calls, ["lock.run", "read.1", "lock.task", "read.2", "body"]);
  assert.equal(predicates.length, 2);
  assert.equal((predicates[0]?.leaseExpiresAt as { gt: Date }).gt, fence.at);
  assert.equal((predicates[1]?.leaseExpiresAt as { gt: Date }).gt, fence.at);
});

test("a Run-only fenced read preserves the complete predicate without taking the Task lock", async () => {
  const calls: string[] = [];
  let predicate: Prisma.RunWhereInput | undefined;
  const tx = {
    $queryRaw: async () => { calls.push("lock.run"); return [{ id: "run-1" }]; },
    run: { findFirst: async ({ where }: { where: Prisma.RunWhereInput }) => {
      calls.push("read.run");
      predicate = where;
      return { id: "run-1" };
    } },
  } as unknown as Prisma.TransactionClient;

  const result = await withRunOnlyFencedRun(tx, fence, { id: true }, (run) => {
    calls.push("body");
    return run.id;
  });

  assert.equal(result, "run-1");
  assert.deepEqual(calls, ["lock.run", "read.run", "body"]);
  assert.deepEqual(predicate, fencedRunWhere(fence));
});

test("the predicate carries the six clauses that make a run this request's to write", () => {
  assert.deepEqual(fencedRunWhere(fence), {
    id: "run-1",
    runnerId: "runner-1",
    fencingToken: "3:run-1:current",
    cancelRequestedAt: null,
    leaseExpiresAt: { gt: fence.at },
    status: { in: [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING, RunStatus.WAITING_INBOX] },
  });
});

test("a session-principal fence asks nothing about a runner", () => {
  const sessionFence: RunFence = { runId: "run-1", fencingToken: "3:run-1:current", at: fence.at };
  assert.equal("runnerId" in fencedRunWhere(sessionFence), false);
});

test("a narrowed fence narrows the predicate and its explanation together", async () => {
  const startFence: RunFence = { ...fence, statuses: [RunStatus.CLAIMED, RunStatus.PROVISIONING] };
  assert.deepEqual(fencedRunWhere(startFence).status, { in: [RunStatus.CLAIMED, RunStatus.PROVISIONING] });
  assert.equal(await explain(live, startFence), "not-active");
});

test("every refusal cause is named rather than guessed", async () => {
  assert.equal(await explain(null), "unknown-run");
  assert.equal(await explain({ ...live, runnerId: "runner-2" }), "wrong-runner");
  assert.equal(await explain({ ...live, fencingToken: "2:run-1:superseded" }), "stale-fence");
  assert.equal(await explain({ ...live, cancelRequestedAt: new Date("2026-08-25T11:59:00.000Z") }), "cancel-requested");
  assert.equal(await explain({ ...live, leaseExpiresAt: new Date("2026-08-25T11:59:00.000Z") }), "lease-expired");
  assert.equal(await explain({ ...live, leaseExpiresAt: null }), "lease-expired");
  assert.equal(await explain({ ...live, status: RunStatus.CANCELLED }), "not-active");
});

test("an unowned run is wrong-runner before it is stale-fence", async () => {
  // Both clauses fail here. The more specific cause is the useful one: an
  // operator reading `wrong-runner` knows a second runner is alive on the run.
  assert.equal(
    await explain({ ...live, runnerId: "runner-2", fencingToken: "2:run-1:superseded" }),
    "wrong-runner",
  );
});

const authorityRun: LockedAuthorityRun = {
  id: "run-1",
  runnerId: "runner-1",
  fencingToken: "3:run-1:current",
  cancelRequestId: null,
  cancelReason: null,
  cancelRequestedAt: null,
  leaseExpiresAt: new Date("2026-08-25T12:05:00.000Z"),
  status: RunStatus.RUNNING,
  taskId: "task-1",
  repoId: "repo-1",
  runNumber: 4,
  pushedBranch: null,
  baseSha: null,
  basePublishedAt: null,
  branch: "feature/task-1",
  targetBranch: "main",
};

test("authority modes stay distinct while sharing one refusal vocabulary", () => {
  assert.equal(liveAuthorityRefusal(authorityRun, fence), null);
  assert.equal(salvageAuthorityRefusal(authorityRun, {
    runnerId: "runner-1",
    fencingToken: "3:run-1:current",
    pushedBranch: "agentos/task-1/run-4",
  }), null);
  assert.equal(salvageAuthorityRefusal(authorityRun, {
    runnerId: "runner-1",
    fencingToken: "3:run-1:current",
    pushedBranch: "feature/task-1",
  }), "not-active");
  assert.equal(cleanupAuthorityRefusal(authorityRun, {
    runnerId: "runner-1",
    fencingToken: "3:run-1:current",
    at: fence.at,
  }), "cleanup-not-authorized");
  assert.equal(cleanupAuthorityRefusal({ ...authorityRun, status: RunStatus.SUCCEEDED }, {
    runnerId: "runner-1",
    fencingToken: "3:run-1:current",
    at: fence.at,
  }), null);
});

test("authority refusals preserve their transport behavior from one vocabulary", () => {
  assert.deepEqual(runFenceRefusal("stale-fence"), {
    reason: "conflict",
    message: "Stale fencing token",
    detail: { reason: "stale-fence" },
  });
  assert.deepEqual(runFenceRefusal("waiting-inbox"), {
    reason: "conflict",
    message: "Run suspended for Inbox",
    detail: { code: "WAITING_INBOX" },
  });
  assert.deepEqual(runFenceRefusal("cleanup-not-authorized"), {
    reason: "conflict",
    message: "Cleanup outcome is not authorized for a live or foreign run",
  });
});

test("authority inspection locks the Run before reading it", async () => {
  const calls: string[] = [];
  const tx = {
    $queryRaw: async () => { calls.push("lock.run"); return [{ id: "run-1" }]; },
    run: { findFirst: async () => { calls.push("read.run"); return authorityRun; } },
  } as unknown as Prisma.TransactionClient;

  assert.equal(await lockAuthorityRun(tx, "run-1"), authorityRun);
  assert.deepEqual(calls, ["lock.run", "read.run"]);
});
