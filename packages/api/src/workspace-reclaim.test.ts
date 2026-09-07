import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { RunStatus, type PrismaClient } from "@anneal/db";

import {
  acknowledgeReclaimSalvage, publishReclaimIntents, terminalRunStatuses, workspaceKeepStatuses,
} from "./workspace-reclaim.js";

type Row = {
  id: string;
  taskId: string | null;
  runNumber: number;
  baseSha: string | null;
  pushedBranch: string | null;
  targetBranch: string | null;
  task: { templateStep: { baseFromStepIndex: number | null } | null } | null;
  runnerId: string | null;
  workspacePath: string | null;
  status: RunStatus;
  workspaceRetained: boolean;
  endedAt: Date | null;
  workspaceReclaimAt: Date | null;
  workspaceReclaimedAt: Date | null;
};

const row = (id: string, overrides: Partial<Row> = {}): Row => ({
  id,
  taskId: null,
  runNumber: 1,
  baseSha: null,
  pushedBranch: null,
  targetBranch: null,
  task: null,
  runnerId: "runner-1",
  workspacePath: null,
  status: RunStatus.SUCCEEDED,
  workspaceRetained: false,
  endedAt: new Date("2026-08-18T00:00:00.000Z"),
  workspaceReclaimAt: null,
  workspaceReclaimedAt: null,
  ...overrides,
});

type Write = { ids: string[]; data: Record<string, unknown> };

const fakeDb = (rows: Row[], openIntents: Row[] = []) => {
  const runUpdates: Write[] = [];
  const byId = new Map(rows.map((entry) => [entry.id, entry] as const));
  const db = {
    run: {
      findMany: async ({ where }: {
        where: { id?: { in?: string[]; notIn?: string[] }; runnerId?: string };
      }) => {
        // Two callers: the inventory lookup (`id.in`) and the open-intent
        // settlement query (`runnerId` + `id.notIn`).
        if (where.id?.in) return where.id.in.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
        const excluded = new Set(where.id?.notIn ?? []);
        return openIntents.filter((run) => run.runnerId === where.runnerId && !excluded.has(run.id));
      },
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        runUpdates.push({ ids: where.id.in, data });
        return { count: where.id.in.length };
      },
      count: async () => 0,
    },
  } as unknown as PrismaClient;
  return { db, runUpdates };
};

const root = "/scratch/runs";
const inventory = (directories: string[], runnerId = "runner-1") => ({ runnerId, workspaceRoot: root, directories });

test("the control plane offers a finished run's directory and publishes the intent", async () => {
  const { db, runUpdates } = fakeDb([row("done")]);
  const plan = await publishReclaimIntents(db, inventory(["done"]), 2);
  assert.deepEqual(plan.reclaim, [{
    runId: "done", workspacePath: null, pinnedBaseSha: null,
    taskId: null, runNumber: 1, baseSha: null, pushedBranch: null,
  }]);
  assert.deepEqual(runUpdates.map(({ ids }) => ids), [["done"]]);
  assert.ok(runUpdates[0]!.data.workspaceReclaimAt instanceof Date);
});

test("the control plane derives required pinned checkout evidence from the template step", async () => {
  const pinned = "a".repeat(40);
  const cases: Array<{ label: string; candidate: Row; expected: string | null }> = [
    { label: "ordinary", candidate: row("ordinary", { targetBranch: pinned }), expected: null },
    {
      label: "pinned",
      candidate: row("pinned", {
        targetBranch: pinned,
        task: { templateStep: { baseFromStepIndex: 1 } },
      }),
      expected: pinned,
    },
  ];
  for (const { label, candidate, expected } of cases) {
    const { db } = fakeDb([candidate]);
    const plan = await publishReclaimIntents(db, inventory([candidate.id]), 0);
    assert.equal(plan.reclaim[0]?.pinnedBaseSha, expected, label);
  }
});

test("reclaim salvage ACK accepts only the owner's deterministic ref while the intent is open", async () => {
  let written: string | null = null;
  const activities: Array<Record<string, unknown>> = [];
  const stored = {
    id: "run-3", runnerId: "runner-1", taskId: "task-1", runNumber: 3,
    status: RunStatus.LOST, workspaceReclaimAt: new Date(), workspaceReclaimedAt: null, pushedBranch: null,
  };
  const db: any = {
    $queryRaw: async () => [{ id: "task-1" }],
    run: {
      findUnique: async () => ({ ...stored, pushedBranch: written }),
      findFirst: async () => null,
      updateMany: async ({ data }: { data: { pushedBranch: string } }) => { written = data.pushedBranch; return { count: 1 }; },
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
  db.$transaction = async (operation: (tx: any) => unknown) => operation(db);
  assert.equal(await acknowledgeReclaimSalvage(db, {
    runnerId: "runner-2", runId: stored.id, pushedBranch: "agentos/task-1/run-3",
  }), false);
  assert.equal(await acknowledgeReclaimSalvage(db, {
    runnerId: "runner-1", runId: stored.id, pushedBranch: "arbitrary/head",
  }), false);
  assert.equal(await acknowledgeReclaimSalvage(db, {
    runnerId: "runner-1", runId: stored.id, pushedBranch: "agentos/task-1/run-3",
  }), "none");
  assert.equal(written, "agentos/task-1/run-3");
  assert.deepEqual(activities, []);
});

test("reclaim salvage ACK marks the base it published as reachable", async () => {
  // The salvage commit descends from the base its Run was provisioned at, so
  // pushing it puts that base on the remote too.
  const ackFor = async (run: { baseSha: string | null; basePublishedAt: Date | null }) => {
    let written: Record<string, unknown> | null = null;
    const stored = {
      id: "run-3", runnerId: "runner-1", taskId: "task-1", runNumber: 3,
      status: RunStatus.LOST, workspaceReclaimAt: new Date(), workspaceReclaimedAt: null,
      pushedBranch: null, ...run,
    };
    const db: any = {
      $queryRaw: async () => [{ id: "task-1" }],
      run: {
        findUnique: async () => stored,
        findFirst: async () => null,
        updateMany: async ({ data }: { data: Record<string, unknown> }) => { written = data; return { count: 1 }; },
      },
      task: {
        findUnique: async () => ({ projectId: "project-1", chainId: null }),
        findUniqueOrThrow: async () => ({ id: "task-1" }),
      },
      taskActivity: { create: async () => ({}) },
    };
    db.$transaction = async (operation: (tx: any) => unknown) => operation(db);
    assert.equal(await acknowledgeReclaimSalvage(db, {
      runnerId: "runner-1", runId: stored.id, pushedBranch: "agentos/task-1/run-3",
    }), "none");
    return written as unknown as { basePublishedAt: Date | null };
  };

  assert.ok((await ackFor({ baseSha: "base-sha", basePublishedAt: null }))?.basePublishedAt);
  const stamped = new Date("2026-09-06T00:00:00.000Z");
  assert.equal((await ackFor({ baseSha: "base-sha", basePublishedAt: stamped }))?.basePublishedAt, stamped);
  // A Run that never recorded a base published nothing to mark.
  assert.equal((await ackFor({ baseSha: null, basePublishedAt: null }))?.basePublishedAt, null);
});

test("reclaim salvage ACK records when a started replacement leaves the branch unconsumed", async () => {
  const activities: Array<Record<string, unknown>> = [];
  const stored = {
    id: "run-3", runnerId: "runner-1", taskId: "task-1", runNumber: 3,
    status: RunStatus.LOST, workspaceReclaimAt: new Date(), workspaceReclaimedAt: null, pushedBranch: null,
  };
  const replacement = {
    id: "run-4", runNumber: 4, status: RunStatus.RUNNING, startedAt: new Date(), baseSha: "base-before-salvage",
  };
  const db: any = {
    $queryRaw: async () => [{ id: "task-1" }],
    run: {
      findUnique: async () => ({ ...stored, pushedBranch: "agentos/task-1/run-3" }),
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
  db.$transaction = async (operation: (tx: any) => unknown) => operation(db);

  assert.equal(await acknowledgeReclaimSalvage(db, {
    runnerId: "runner-1", runId: stored.id, pushedBranch: "agentos/task-1/run-3",
  }), "already-started");
  assert.equal(activities.length, 1);
  assert.deepEqual(activities[0], {
    taskId: "task-1",
    actorType: "control-plane",
    body: "Salvage branch agentos/task-1/run-3 from LOST Run 3 was not consumed by replacement Run 4 (RUNNING) from baseSha base-before-salvage",
  });
});

test("reclaim salvage ACK describes an unstarted replacement without claiming it started", async () => {
  const activities: Array<Record<string, unknown>> = [];
  const stored = {
    id: "run-3", runnerId: "runner-1", taskId: "task-1", runNumber: 3,
    status: RunStatus.LOST, workspaceReclaimAt: new Date(), workspaceReclaimedAt: null,
    pushedBranch: null, branch: "feat/salvage",
  };
  const replacement = {
    id: "run-4", runNumber: 4, status: RunStatus.QUEUED, startedAt: null, baseSha: null,
  };
  const db: any = {
    run: {
      findUnique: async () => stored,
      findFirst: async () => replacement,
      updateMany: async () => ({ count: 1 }),
    },
    taskActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return {}; },
    },
  };
  db.$transaction = async (operation: (tx: any) => unknown) => operation(db);

  assert.equal(await acknowledgeReclaimSalvage(db, {
    runnerId: "runner-1", runId: stored.id, pushedBranch: "agentos/task-1/run-3",
  }, async () => "already-started"), "already-started");
  assert.equal(activities.length, 1);
  assert.equal(
    activities[0]?.body,
    "Salvage branch agentos/task-1/run-3 from LOST Run 3 was not consumed by replacement Run 4 (QUEUED), which has no recorded baseSha",
  );
});

test("repaired and requeued salvage replacements write no stranded-salvage activity", async () => {
  for (const outcome of ["repaired", "requeued"] as const) {
    const activities: Array<Record<string, unknown>> = [];
    const stored = {
      id: "run-3", runnerId: "runner-1", taskId: "task-1", runNumber: 3,
      status: RunStatus.LOST, workspaceReclaimAt: new Date(), workspaceReclaimedAt: null,
      pushedBranch: null, branch: "feat/salvage",
    };
    const db: any = {
      run: {
        findUnique: async () => stored,
        updateMany: async () => ({ count: 1 }),
      },
      taskActivity: {
        create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return {}; },
      },
    };
    db.$transaction = async (operation: (tx: any) => unknown) => operation(db);

    assert.equal(await acknowledgeReclaimSalvage(db, {
      runnerId: "runner-1", runId: stored.id, pushedBranch: "agentos/task-1/run-3",
    }, async () => outcome), outcome);
    assert.deepEqual(activities, [], outcome);
  }
});

test("a directory the database has never heard of is kept, never offered", async () => {
  // The 2026-08-18 incident shape: a scratch database knows nothing about the
  // directories under the root. Under API-side GC that emptiness deleted them.
  const { db, runUpdates } = fakeDb([]);
  const plan = await publishReclaimIntents(db, inventory(["live-workspace-a", "live-workspace-b"]), 2);
  assert.deepEqual(plan.reclaim, []);
  assert.deepEqual(plan.keep, [
    { directory: "live-workspace-a", reason: "unknown-run" },
    { directory: "live-workspace-b", reason: "unknown-run" },
  ]);
  assert.deepEqual(runUpdates, []);
});

test("one known in-root run does not license offering unknown siblings", async () => {
  const { db } = fakeDb([row("known", { status: RunStatus.RUNNING, workspacePath: join(root, "known") })]);
  const plan = await publishReclaimIntents(db, inventory(["known", "live-a", "live-b"]), 2);
  assert.deepEqual(plan.reclaim, []);
  assert.deepEqual(plan.keep.map(({ reason }) => reason), ["active-run", "unknown-run", "unknown-run"]);
});

test("every status whose workspace is still in use is kept", async () => {
  for (const status of workspaceKeepStatuses) {
    const { db } = fakeDb([row("live", { status, endedAt: null })]);
    const plan = await publishReclaimIntents(db, inventory(["live"]), 2);
    assert.deepEqual(plan.reclaim, [], `${status} must never be offered for reclaim`);
  }
});

test("the keep list and the terminal list partition every run status", async () => {
  // The predicate offers a directory only when the status is terminal, so a
  // status in neither list keeps its workspace. This asserts there is no such
  // status *today*, which is what makes the keep list an accurate description
  // rather than a stale one — and if a status is added later, this is the test
  // that says so instead of a workspace quietly becoming undeletable.
  const covered = new Set<string>([...workspaceKeepStatuses, ...terminalRunStatuses]);
  assert.equal(covered.size, workspaceKeepStatuses.length + terminalRunStatuses.length, "the two lists overlap");
  assert.deepEqual([...Object.values(RunStatus)].filter((status) => !covered.has(status)), []);
});

test("retained failures keep the newest N and offer the rest", async () => {
  const now = Date.now();
  const { db, runUpdates } = fakeDb([
    row("new-failure", { status: RunStatus.FAILED, workspaceRetained: true, endedAt: new Date(now) }),
    row("mid-failure", { status: RunStatus.FAILED, workspaceRetained: true, endedAt: new Date(now - 1_000) }),
    row("old-failure", { status: RunStatus.FAILED, workspaceRetained: true, endedAt: new Date(now - 2_000) }),
  ]);
  const plan = await publishReclaimIntents(db, inventory(["new-failure", "mid-failure", "old-failure"]), 2);
  assert.deepEqual(plan.reclaim.map(({ runId }) => runId), ["old-failure"]);
  // Retention expiring is recorded when the intent is published, because
  // `workspaceRetained` is what an operator reads to know a workspace is held.
  assert.deepEqual(runUpdates.find(({ data }) => data.workspaceRetained === false)?.ids, ["old-failure"]);
});

test("an active retained run never consumes the retention quota", async () => {
  const now = Date.now();
  const { db } = fakeDb([
    row("active", { status: RunStatus.RUNNING, workspaceRetained: true, endedAt: new Date(now) }),
    row("failed", { status: RunStatus.FAILED, workspaceRetained: true, endedAt: new Date(now - 1_000) }),
  ]);
  const plan = await publishReclaimIntents(db, inventory(["active", "failed"]), 1);
  assert.deepEqual(plan.reclaim, []);
});

test("a workspacePath that disagrees with the run's own directory is kept, not offered", async () => {
  const { db } = fakeDb([row("done", { workspacePath: join(root, "victim") })]);
  const plan = await publishReclaimIntents(db, inventory(["done"]), 2);
  assert.deepEqual(plan.reclaim, []);
  assert.deepEqual(plan.keep, [{ directory: "done", reason: "noncanonical-workspace-path" }]);
});

test("a run claimed by another runner is not offered to this one", async () => {
  const { db } = fakeDb([row("someone-elses", { runnerId: "runner-2", workspacePath: "/other/root/someone-elses" })]);
  const plan = await publishReclaimIntents(db, inventory(["someone-elses"]), 2);
  assert.deepEqual(plan.reclaim, []);
  assert.deepEqual(plan.keep, [{ directory: "someone-elses", reason: "foreign-runner" }]);
});

test("a run whose recorded runnerId is not the caller is never offered, whatever root it names", async () => {
  // The whole ownership rule. A directory sitting in the caller's own root, or
  // a run with no runner at all, is still not the caller's to remove: the shared
  // RUNNER_TOKEN authenticates a runner class, so `runnerId` is the only
  // identity in this exchange and a self-reported root cannot stand in for it.
  for (const owner of ["runner-before-restart", null]) {
    const { db, runUpdates } = fakeDb([row("orphan", { runnerId: owner, workspacePath: join(root, "orphan") })]);
    const plan = await publishReclaimIntents(db, inventory(["orphan"], "runner-after-restart"), 2);
    assert.deepEqual(plan.reclaim, [], `runnerId ${String(owner)} must not be reclaimable by another caller`);
    assert.deepEqual(plan.keep, [{ directory: "orphan", reason: "foreign-runner" }]);
    assert.deepEqual(runUpdates, []);
  }
});

test("still-open intents whose directories are absent come back for settlement", async () => {
  // The delete-then-report crash: the directory is gone, so no inventory can
  // mention it again, and only this list can ever close the intent.
  const { db } = fakeDb(
    [row("present")],
    [row("vanished", { workspaceReclaimAt: new Date(), workspacePath: join(root, "vanished") })],
  );
  const plan = await publishReclaimIntents(db, inventory(["present"]), 2);
  assert.deepEqual(plan.verify, [{ runId: "vanished", workspacePath: join(root, "vanished"), pinnedBaseSha: null }]);
});

test("an empty inventory still returns the open intents that need settling", async () => {
  const { db } = fakeDb([], [row("vanished", { workspaceReclaimAt: new Date(), workspacePath: null })]);
  const plan = await publishReclaimIntents(db, inventory([]), 2);
  assert.deepEqual(plan.reclaim, []);
  assert.deepEqual(plan.verify, [{ runId: "vanished", workspacePath: null, pinnedBaseSha: null }]);
});

test("another runner's open intents are not offered for settlement either", async () => {
  const { db } = fakeDb([], [row("theirs", { runnerId: "runner-2", workspaceReclaimAt: new Date() })]);
  const plan = await publishReclaimIntents(db, inventory([]), 2);
  assert.deepEqual(plan.verify, []);
});

test("an intent the owner already answered is not offered again", async () => {
  const { db } = fakeDb([row("answered", {
    workspaceReclaimAt: new Date("2026-08-18T01:00:00.000Z"),
    workspaceReclaimedAt: new Date("2026-08-18T01:00:01.000Z"),
  })]);
  const plan = await publishReclaimIntents(db, inventory(["answered"]), 2);
  assert.deepEqual(plan.reclaim, []);
  assert.deepEqual(plan.keep, [{ directory: "answered", reason: "intent-closed" }]);
});
