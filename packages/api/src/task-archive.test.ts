import "./test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  InboxStatus,
  MERGE_TAIL_KIND,
  Prisma,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import {
  applyArchive,
  applyUnarchive,
  archiveSet,
  partitionArchivable,
  unarchiveSet,
} from "./task-archive.js";

type TaskRow = {
  id: string;
  projectId: string;
  chainId: string | null;
  status: TaskStatus;
  archivedAt: Date | null;
  assigneeAgentId: string | null;
};

type RunRow = { taskId: string | null; status: RunStatus };

type InboxRow = {
  id: string;
  taskId: string | null;
  gateTaskId: string | null;
  status: InboxStatus;
  dedupeKey: string;
  answeredAt: Date | null;
};

type ActivityRow = {
  taskId: string;
  actorType: string;
  body: string;
  metadata?: Prisma.JsonValue;
};

type AgentRow = { id: string; projectId: string; name: string; archivedAt: Date | null };

type Tables = {
  tasks: TaskRow[];
  runs?: RunRow[];
  inbox?: InboxRow[];
  activities?: ActivityRow[];
  agents?: AgentRow[];
};

/** The `where` dialect these three reads speak, and nothing wider: equality,
 * `in`, `null`, `startsWith`, and the one JSON path the repair marker uses. */
const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([field, predicate]) => {
    const value = row[field];
    if (predicate === null || predicate === undefined) return value === null;
    if (typeof predicate === "object") {
      const clause = predicate as Record<string, unknown>;
      if ("in" in clause) return (clause.in as unknown[]).includes(value);
      if ("startsWith" in clause) return typeof value === "string" && value.startsWith(clause.startsWith as string);
      if ("not" in clause) return clause.not === null ? value !== null : value !== clause.not;
      if ("path" in clause) {
        const [key] = clause.path as string[];
        const carried = value as Record<string, unknown> | null;
        return carried !== null && carried[key!] === clause.equals;
      }
    }
    return value === predicate;
  });

type Recording = {
  tx: Prisma.TransactionClient;
  tables: Required<Tables>;
  /** Every `$queryRaw` this transaction issued, as its collapsed SQL text. */
  locks: string[];
  /** How often the Inbox was read and written, so a refusal can prove it
   * decided before it touched Inbox state. */
  calls: { inboxFindMany: number; inboxUpdateMany: number };
};

const transaction = (seed: Tables, options: { closeDuringUpdate?: string[] } = {}): Recording => {
  const tables = {
    tasks: seed.tasks,
    runs: seed.runs ?? [],
    inbox: seed.inbox ?? [],
    activities: seed.activities ?? [],
    agents: seed.agents ?? [],
  };
  const locks: string[] = [];
  const calls = { inboxFindMany: 0, inboxUpdateMany: 0 };
  const tx = {
    $queryRaw: async (query: TemplateStringsArray | Prisma.Sql, ...parameters: unknown[]) => {
      const sql = "sql" in query ? query.sql : query.join("?");
      const values: unknown[] = "sql" in query ? query.values : parameters;
      locks.push(sql.replace(/\s+/gu, " ").trim());
      if (sql.includes('FROM "Agent"')) {
        return tables.agents.filter((agent) => agent.id === values[0]).map(({ id }) => ({ id }));
      }
      if (sql.includes('"chainId" =')) {
        return tables.tasks
          .filter((task) => task.projectId === values[0] && task.chainId === values[1])
          .map(({ id }) => ({ id }));
      }
      return tables.tasks.filter((task) => task.id === values[0]).map(({ id }) => ({ id }));
    },
    task: {
      findUnique: async ({ where }: { where: { id: string } }) => (
        tables.tasks.find((task) => task.id === where.id) ?? null
      ),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const task = tables.tasks.find((candidate) => candidate.id === where.id);
        if (!task) throw new Error(`No task ${where.id}`);
        return task;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => (
        tables.tasks.filter((task) => matches(task, where))
      ),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { archivedAt: Date | null } }) => {
        const affected = tables.tasks.filter((task) => matches(task, where));
        for (const task of affected) task.archivedAt = data.archivedAt;
        return { count: affected.length };
      },
    },
    run: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const busy = tables.runs.filter((run) => matches(run, where));
        return [...new Map(busy.map((run) => [run.taskId, run])).values()];
      },
    },
    agent: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => (
        tables.agents.find((agent) => matches(agent, where)) ?? null
      ),
      findUnique: async ({ where }: { where: { id: string } }) => (
        tables.agents.find((agent) => agent.id === where.id) ?? null
      ),
    },
    inboxMessage: {
      count: async ({ where }: { where: Record<string, unknown> }) => (
        tables.inbox.filter((message) => matches(message, where)).length
      ),
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        calls.inboxFindMany += 1;
        return tables.inbox.filter((message) => matches(message, where));
      },
      updateMany: async (
        { where, data }: { where: Record<string, unknown>; data: { status: InboxStatus; answeredAt: Date } },
      ) => {
        calls.inboxUpdateMany += 1;
        // A concurrent operator close lands between the select and the update.
        for (const message of tables.inbox) {
          if (options.closeDuringUpdate?.includes(message.id)) message.status = InboxStatus.CLOSED;
        }
        const affected = tables.inbox.filter((message) => matches(message, where));
        for (const message of affected) {
          message.status = data.status;
          message.answeredAt = data.answeredAt;
        }
        return { count: affected.length };
      },
    },
    taskActivity: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => (
        tables.activities.filter((activity) => matches(activity, where))
      ),
      createMany: async ({ data }: { data: ActivityRow[] }) => {
        tables.activities.push(...data);
        return { count: data.length };
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, tables, locks, calls };
};

const task = (id: string, overrides: Partial<TaskRow> = {}): TaskRow => ({
  id,
  projectId: "project-1",
  chainId: "chain-1",
  status: TaskStatus.DONE,
  archivedAt: null,
  assigneeAgentId: null,
  ...overrides,
});

test("the archive set is the whole chain, minus the members already archived", async () => {
  const { tx } = transaction({
    tasks: [
      task("step-1", { archivedAt: new Date("2026-09-01T00:00:00Z") }),
      task("step-2"),
      task("step-3"),
      task("other-chain", { chainId: "chain-2" }),
    ],
  });
  assert.deepEqual(await archiveSet(tx, "step-2"), { ids: ["step-2", "step-3"] });
});

test("a task outside a chain is its own archive set", async () => {
  const { tx, locks } = transaction({ tasks: [task("solo", { chainId: null }), task("step-1")] });
  assert.deepEqual(await archiveSet(tx, "solo"), { ids: ["solo"] });
  // No chain, so the chain-wide lock is never taken.
  assert.equal(locks.filter((sql) => sql.includes('"chainId" =')).length, 0);
});

test("archive refuses an active chain member before it reads the Inbox", async () => {
  const { tx, tables, calls } = transaction({
    tasks: [task("step-1"), task("step-2")],
    runs: [{ taskId: "step-2", status: RunStatus.RUNNING }],
    inbox: [{
      id: "notice-1",
      taskId: "step-1",
      gateTaskId: null,
      status: InboxStatus.OPEN,
      dedupeKey: "merge-tail-stop:chain-1:1",
      answeredAt: null,
    }],
  });
  assert.deepEqual(await archiveSet(tx, "step-1"), {
    reason: "conflict",
    message: "Cannot archive a task with an active run",
  });
  assert.deepEqual(calls, { inboxFindMany: 0, inboxUpdateMany: 0 });
  assert.equal(tables.inbox[0]!.status, InboxStatus.OPEN);
  assert.deepEqual(tables.tasks.map((row) => row.archivedAt), [null, null]);
});

test("archive refuses a chain whose detached repair task still holds an active run", async () => {
  const { tx, calls } = transaction({
    tasks: [task("step-1"), task("repair-1", { chainId: null })],
    runs: [{ taskId: "repair-1", status: RunStatus.RUNNING }],
    activities: [{
      taskId: "step-1",
      actorType: "control-plane",
      body: "repair attempt",
      metadata: { kind: MERGE_TAIL_KIND.repairAttempt, repairKind: "regression", repairTaskId: "repair-1" },
    }],
  });
  assert.deepEqual(await archiveSet(tx, "step-1"), {
    reason: "conflict",
    message: "Cannot archive a task with an active run",
  });
  assert.deepEqual(calls, { inboxFindMany: 0, inboxUpdateMany: 0 });
});

test("archive locks the detached repair rows before the chain rows", async () => {
  const { tx, locks } = transaction({
    tasks: [task("step-1"), task("repair-1", { chainId: null })],
    activities: [{
      taskId: "step-1",
      actorType: "control-plane",
      body: "repair attempt",
      metadata: { kind: MERGE_TAIL_KIND.repairAttempt, repairKind: "regression", repairTaskId: "repair-1" },
    }],
  });
  assert.deepEqual(await archiveSet(tx, "step-1"), { ids: ["step-1"] });
  const repairLock = locks.findIndex((sql) => sql.includes('WHERE "id" = ') && sql.includes("FOR UPDATE"));
  const chainLock = locks.findIndex((sql) => sql.includes('"chainId" ='));
  assert.ok(repairLock >= 0 && chainLock > repairLock, locks.join(" | "));
});

test("archive refuses a REVIEW member whose approval gate is still open", async () => {
  const { tx } = transaction({
    tasks: [task("step-1"), task("step-2", { status: TaskStatus.REVIEW })],
    inbox: [{
      id: "message-1",
      taskId: "step-2",
      gateTaskId: "step-2",
      status: InboxStatus.OPEN,
      dedupeKey: "approval-gate:step-2",
      answeredAt: null,
    }],
  });
  assert.deepEqual(await archiveSet(tx, "step-1"), {
    reason: "conflict",
    message: "Decide the approval gate in the Inbox first",
  });
});

test("archive refuses a task that does not exist", async () => {
  const { tx } = transaction({ tasks: [] });
  assert.deepEqual(await archiveSet(tx, "missing"), { reason: "not-found", message: "Task not found" });
});

test("applying an archive flips the rows, writes one activity row each, and closes each stop notice once", async () => {
  const now = new Date("2026-09-07T10:00:00Z");
  const { tx, tables } = transaction({
    tasks: [task("step-1"), task("step-2")],
    inbox: [
      {
        id: "notice-1",
        taskId: "step-1",
        gateTaskId: null,
        status: InboxStatus.OPEN,
        dedupeKey: "merge-tail-stop:chain-1:1",
        answeredAt: null,
      },
      {
        id: "notice-2",
        taskId: "step-1",
        gateTaskId: null,
        status: InboxStatus.OPEN,
        dedupeKey: "merge-tail-stop:chain-1:2",
        answeredAt: null,
      },
      {
        id: "unrelated",
        taskId: "step-2",
        gateTaskId: null,
        status: InboxStatus.OPEN,
        dedupeKey: "approval-gate:step-2",
        answeredAt: null,
      },
      {
        id: "readiness",
        taskId: "step-2",
        gateTaskId: null,
        status: InboxStatus.OPEN,
        dedupeKey: "merge-readiness-stop:step-2",
        answeredAt: null,
      },
      {
        id: "other-chain",
        taskId: "step-9",
        gateTaskId: null,
        status: InboxStatus.OPEN,
        dedupeKey: "merge-tail-stop:chain-9:1",
        answeredAt: null,
      },
    ],
  });
  await applyArchive(tx, ["step-1", "step-2"], now);
  assert.deepEqual(tables.tasks.map((row) => row.archivedAt), [now, now]);
  assert.deepEqual(
    tables.inbox.map((message) => [message.id, message.status, message.answeredAt]),
    [
      ["notice-1", InboxStatus.CLOSED, now],
      ["notice-2", InboxStatus.CLOSED, now],
      ["unrelated", InboxStatus.OPEN, null],
      ["readiness", InboxStatus.OPEN, null],
      ["other-chain", InboxStatus.OPEN, null],
    ],
  );
  assert.deepEqual(tables.activities.map((activity) => [activity.taskId, activity.actorType, activity.body]), [
    ["step-1", "operator", "Task archived"],
    ["step-2", "operator", "Task archived"],
    ["step-1", "control-plane", "Closed merge-tail stop notices: notice-1, notice-2"],
  ]);
});

test("an archive with no stop notices writes no Inbox closure", async () => {
  const { tx, tables, calls } = transaction({
    tasks: [task("step-1")],
    inbox: [{
      id: "question-1",
      taskId: "step-1",
      gateTaskId: null,
      status: InboxStatus.OPEN,
      dedupeKey: "question:step-1",
      answeredAt: null,
    }],
  });
  await applyArchive(tx, ["step-1"], new Date("2026-09-07T10:00:00Z"));
  assert.equal(calls.inboxUpdateMany, 0);
  assert.deepEqual(tables.activities.map((activity) => activity.actorType), ["operator"]);
});

test("a stop notice closed concurrently by an operator does not roll the archive back", async () => {
  const now = new Date("2026-09-07T10:00:00Z");
  const { tx, tables } = transaction({
    tasks: [task("step-1")],
    inbox: [
      {
        id: "notice-1",
        taskId: "step-1",
        gateTaskId: null,
        status: InboxStatus.OPEN,
        dedupeKey: "merge-tail-stop:chain-1:1",
        answeredAt: null,
      },
      {
        id: "notice-2",
        taskId: "step-1",
        gateTaskId: null,
        status: InboxStatus.OPEN,
        dedupeKey: "merge-tail-stop:chain-1:2",
        answeredAt: null,
      },
    ],
  }, { closeDuringUpdate: ["notice-2"] });
  await applyArchive(tx, ["step-1"], now);
  assert.ok(tables.inbox.every((message) => message.status === InboxStatus.CLOSED));
  assert.deepEqual(
    tables.activities.filter((activity) => activity.actorType === "control-plane").map((activity) => activity.body),
    ["Closed merge-tail stop notices: notice-1, notice-2"],
  );
  assert.equal(tables.tasks[0]!.archivedAt, now);
});

test("an archive that leaves a selected stop notice OPEN fails loudly instead of committing", async () => {
  const { tx } = transaction({
    tasks: [task("step-1")],
    inbox: [{
      id: "notice-1",
      taskId: "step-1",
      gateTaskId: null,
      status: InboxStatus.OPEN,
      dedupeKey: "merge-tail-stop:chain-1:1",
      answeredAt: null,
    }],
  });
  // A close that reports fewer rows than it selected, with the notice still OPEN,
  // is the one inconsistency worth rolling the archive back for.
  const inbox = (tx as unknown as { inboxMessage: { updateMany: unknown } }).inboxMessage;
  inbox.updateMany = async () => ({ count: 0 });
  await assert.rejects(
    applyArchive(tx, ["step-1"], new Date("2026-09-07T10:00:00Z")),
    /found 1 OPEN merge-tail stop notices but 1 remained OPEN/u,
  );
});

test("archiving nothing writes nothing", async () => {
  const { tx, tables } = transaction({ tasks: [task("step-1")] });
  await applyArchive(tx, [], new Date("2026-09-07T10:00:00Z"));
  await applyUnarchive(tx, []);
  assert.deepEqual(tables.activities, []);
  assert.equal(tables.tasks[0]!.archivedAt, null);
});

test("the unarchive set is every archived chain member, and the flip is symmetric", async () => {
  const archivedAt = new Date("2026-09-01T00:00:00Z");
  const { tx, tables } = transaction({
    tasks: [task("step-1", { archivedAt }), task("step-2", { archivedAt }), task("step-3")],
  });
  const set = await unarchiveSet(tx, "step-1");
  assert.deepEqual(set, { ids: ["step-1", "step-2"] });
  await applyUnarchive(tx, "ids" in set ? set.ids : []);
  assert.deepEqual(tables.tasks.map((row) => row.archivedAt), [null, null, null]);
  assert.deepEqual(tables.activities.map((activity) => [activity.taskId, activity.body]), [
    ["step-1", "Task unarchived"],
    ["step-2", "Task unarchived"],
  ]);
});

test("unarchive refuses to reactivate a live member whose assignee is archived", async () => {
  const archivedAt = new Date("2026-09-01T00:00:00Z");
  const { tx } = transaction({
    tasks: [task("step-1", { archivedAt, status: TaskStatus.TODO, assigneeAgentId: "agent-1" })],
    agents: [{ id: "agent-1", projectId: "project-1", name: "senior-dev", archivedAt }],
  });
  assert.deepEqual(await unarchiveSet(tx, "step-1"), {
    reason: "conflict",
    message: "Assignee senior-dev is archived; unarchive the agent or reassign this task first",
  });
});

test("partitionArchivable keeps the busy tasks out of the archive set and counts them as skipped", () => {
  assert.deepEqual(partitionArchivable(["a", "b", "c"], ["b"]), { archive: ["a", "c"], skipped: 1 });
  assert.deepEqual(partitionArchivable(["a", "b"], []), { archive: ["a", "b"], skipped: 0 });
  assert.deepEqual(partitionArchivable([], ["b"]), { archive: [], skipped: 0 });
  // A busy id that is not a candidate cannot inflate the skipped count.
  assert.deepEqual(partitionArchivable(["a"], ["z"]), { archive: ["a"], skipped: 0 });
});
