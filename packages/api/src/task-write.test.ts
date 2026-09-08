import assert from "node:assert/strict";
import test from "node:test";

import { AssigneeType, type Prisma, RunStatus, TaskStatus } from "@anneal/db";

import { writeTask } from "./task-write.js";

type TaskRow = {
  id: string;
  projectId: string;
  chainId: string | null;
  status: TaskStatus;
  archivedAt: Date | null;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  templateStep: null;
};

type AgentRow = { id: string; name: string; projectId: string; archivedAt: Date | null };

type RunRow = { runNumber: number; status: RunStatus };

const task = (overrides: Partial<TaskRow> = {}): TaskRow => ({
  id: "task-1",
  projectId: "project-1",
  chainId: null,
  status: TaskStatus.TODO,
  archivedAt: null,
  assigneeType: AssigneeType.AGENT,
  assigneeAgentId: null,
  templateStep: null,
  ...overrides,
});

/**
 * A transaction that records which rows were locked and in what order.
 *
 * The lock order is the whole point of the module, and it is invisible to the
 * HTTP tests: `app.test.ts` stubs `$queryRaw` to succeed unconditionally, so a
 * writer that took the Agent row before the Task row would pass there. Here the
 * `FOR UPDATE` statements are the observable.
 */
const recordingTx = (state: {
  task: TaskRow | null;
  agents?: AgentRow[];
  siblings?: string[];
  runs?: RunRow[];
}) => {
  const locks: string[] = [];
  const writes: Array<{ kind: string; data: unknown }> = [];
  const agents = state.agents ?? [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes('FROM "Agent"')) {
        locks.push("agent-row");
        return agents.length > 0 ? [{ id: agents[0]!.id }] : [];
      }
      if (sql.includes('"chainId" = ')) {
        locks.push("chain-rows");
        return (state.siblings ?? [state.task?.id ?? ""]).map((id) => ({ id }));
      }
      locks.push("task-row");
      return state.task ? [{ id: state.task.id }] : [];
    },
    task: {
      findUnique: async () => state.task,
      findUniqueOrThrow: async () => {
        if (!state.task) throw new Error("task is absent");
        return state.task;
      },
      update: async ({ data }: { data: unknown }) => {
        writes.push({ kind: "task.update", data });
        return { ...state.task, ...(data as object) };
      },
    },
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => (
        agents.find((agent) => agent.id === where.id) ?? null
      ),
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) => (
        agents.find((agent) => agent.id === where.id && agent.projectId === where.projectId) ?? null
      ),
    },
    run: {
      findFirst: async ({ where }: { where: { status: { in: readonly RunStatus[] } } }) => (
        (state.runs ?? []).find((run) => where.status.in.includes(run.status)) ?? null
      ),
    },
    taskActivity: {
      create: async ({ data }: { data: unknown }) => {
        writes.push({ kind: "taskActivity.create", data });
        return { id: "activity-1" };
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, locks, writes };
};

const plainWrite = async () => ({
  update: { status: TaskStatus.BACKLOG },
  activity: { actorType: "control-plane", body: "parked" },
  value: "planned" as const,
});

test("a task that is gone is refused as absent, before anything is locked", async () => {
  const { tx, locks, writes } = recordingTx({ task: null });
  const result = await writeTask(tx, "task-1", plainWrite);
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? null : result.refusal, { kind: "absent" });
  assert.deepEqual(locks, []);
  assert.deepEqual(writes, []);
});

test("an unchained write locks the Task row, then the Agent row, and writes once", async () => {
  const { tx, locks, writes } = recordingTx({
    task: task({ assigneeAgentId: "agent-1" }),
    agents: [{ id: "agent-1", name: "engineer", projectId: "project-1", archivedAt: null }],
  });
  const result = await writeTask(tx, "task-1", async () => ({
    update: { status: TaskStatus.DOING, assigneeAgentId: "agent-1" },
    activity: { actorType: "operator", body: "Status changed: todo → doing" },
    value: 7,
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(locks, ["task-row", "agent-row"]);
  assert.deepEqual(writes.map((write) => write.kind), ["task.update", "taskActivity.create"]);
  assert.equal(result.ok && result.value, 7);
  assert.equal(result.ok && result.activityId, "activity-1");
  assert.equal(result.ok && result.chainLocked, false);
});

test("a chained write takes the whole chain and reports that the transaction is chain-locked", async () => {
  const { tx, locks } = recordingTx({
    task: task({ chainId: "chain-1" }),
    siblings: ["task-0", "task-1", "task-2"],
  });
  const result = await writeTask(tx, "task-1", plainWrite);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.chainLocked, true);
  assert.deepEqual(locks, ["chain-rows"]);
});

test("an archived assignee is refused and nothing is written", async () => {
  const { tx, locks, writes } = recordingTx({
    task: task(),
    agents: [{ id: "agent-1", name: "engineer", projectId: "project-1", archivedAt: new Date() }],
  });
  const result = await writeTask(tx, "task-1", async () => ({
    update: { assigneeAgentId: "agent-1" },
    activity: { actorType: "operator", body: "reassigned" },
    value: null,
  }));
  assert.deepEqual(result.ok ? null : result.refusal, {
    kind: "assignment-blocked",
    reason: "Assignee engineer is archived",
  });
  assert.deepEqual(locks, ["task-row", "agent-row"]);
  assert.deepEqual(writes, []);
});

test("an assignee from another project is refused before the Agent row is locked", async () => {
  const { tx, locks, writes } = recordingTx({
    task: task(),
    agents: [{ id: "agent-1", name: "engineer", projectId: "project-2", archivedAt: null }],
  });
  const result = await writeTask(tx, "task-1", async () => ({
    update: { assigneeAgentId: "agent-1" },
    activity: null,
    value: null,
  }));
  assert.deepEqual(result.ok ? null : result.refusal, {
    kind: "assignment-blocked",
    reason: "Assignee does not belong to this project",
  });
  assert.deepEqual(locks, ["task-row"]);
  assert.deepEqual(writes, []);
});

test("a write that names no assignee never reaches the Agent row", async () => {
  const { tx, locks, writes } = recordingTx({ task: task() });
  const result = await writeTask(tx, "task-1", plainWrite);
  assert.equal(result.ok, true);
  assert.deepEqual(locks, ["task-row"]);
  assert.deepEqual(writes.map((write) => write.kind), ["task.update", "taskActivity.create"]);
});

test("a caller that decides under the lock not to write still gets its value back", async () => {
  const { tx, locks, writes } = recordingTx({ task: task() });
  const result = await writeTask(tx, "task-1", async () => ({
    update: null,
    activity: null,
    value: { refused: "already decided" },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, { refused: "already decided" });
  assert.equal(result.ok && result.written, null);
  assert.equal(result.ok && result.activityId, null);
  assert.deepEqual(locks, ["task-row"]);
  assert.deepEqual(writes, []);
});

// §R5. The assignment freeze, per task and keyed on Run status alone.
const reassignmentFixture = (runs: RunRow[]) => recordingTx({
  task: task({ assigneeAgentId: "agent-1" }),
  agents: [{ id: "agent-2", name: "successor", projectId: "project-1", archivedAt: null }],
  runs,
});

for (const status of [RunStatus.RUNNING, RunStatus.QUEUED, RunStatus.WAITING_INBOX] as const) {
  test(`a reassignment is refused as a conflict while a ${status} Run exists`, async () => {
    const { tx, locks, writes } = reassignmentFixture([{ runNumber: 2, status }]);
    const result = await writeTask(tx, "task-1", async () => ({
      update: { assigneeAgentId: "agent-2" },
      activity: { actorType: "operator", body: "reassigned" },
      value: null,
    }));
    assert.deepEqual(result.ok ? null : result.refusal, {
      kind: "assignment-active-run",
      reason: `Cannot change the assignee while run 2 is ${status}; stop or finish it first`,
    });
    // The Agent row is never reached: the freeze decides under the Task lock.
    assert.deepEqual(locks, ["task-row"]);
    assert.deepEqual(writes, []);
  });
}

test("a reassignment is allowed when the task's Run history is entirely terminal", async () => {
  const { tx, writes } = reassignmentFixture([
    { runNumber: 1, status: RunStatus.FAILED },
    { runNumber: 2, status: RunStatus.CANCELLED },
  ]);
  const result = await writeTask(tx, "task-1", async () => ({
    update: { assigneeAgentId: "agent-2" },
    activity: null,
    value: null,
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(writes.map((write) => write.kind), ["task.update"]);
});

test("clearing the assignee to null is guarded by the same active Run", async () => {
  const { tx, writes } = reassignmentFixture([{ runNumber: 1, status: RunStatus.RUNNING }]);
  const result = await writeTask(tx, "task-1", async () => ({
    update: { assigneeAgentId: null },
    activity: null,
    value: null,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.refusal.kind, "assignment-active-run");
  assert.deepEqual(writes, []);
});

test("changing only assigneeType is guarded by the same active Run", async () => {
  const { tx, writes } = reassignmentFixture([{ runNumber: 1, status: RunStatus.RUNNING }]);
  const result = await writeTask(tx, "task-1", async () => ({
    update: { assigneeType: AssigneeType.HUMAN },
    activity: null,
    value: null,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.refusal.kind, "assignment-active-run");
  assert.deepEqual(writes, []);
});

test("restating the assignment a running task already has is not a reassignment", async () => {
  const { tx, locks, writes } = recordingTx({
    task: task({ assigneeAgentId: "agent-1" }),
    agents: [{ id: "agent-1", name: "engineer", projectId: "project-1", archivedAt: null }],
    runs: [{ runNumber: 1, status: RunStatus.RUNNING }],
  });
  const result = await writeTask(tx, "task-1", async () => ({
    update: { assigneeAgentId: "agent-1", assigneeType: AssigneeType.AGENT },
    activity: null,
    value: null,
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(locks, ["task-row", "agent-row"]);
  assert.deepEqual(writes.map((write) => write.kind), ["task.update"]);
});


test("a refusal park retains the existing Task mutex without expanding to Chain siblings", async () => {
  const { tx, locks, writes } = recordingTx({ task: task({ chainId: "chain-1" }), siblings: ["task-1", "task-2"] });
  const result = await writeTask(tx, "task-1", async () => ({
    update: { status: TaskStatus.REVIEW, failureReason: "Run birth refused" },
    activity: { actorType: "control-plane", body: "Run birth refused" },
    value: undefined,
  }), { lockScope: "task" });
  assert.ok(result.ok);
  assert.equal(result.chainLocked, false);
  assert.deepEqual(locks, ["task-row"]);
  assert.deepEqual(writes.map((write) => write.kind), ["task.update", "taskActivity.create"]);
});

test("the Task-only refusal park cannot mutate assignment or other Task fields", async () => {
  const { tx, writes } = recordingTx({ task: task({ chainId: "chain-1" }) });
  await assert.rejects(writeTask(tx, "task-1", async () => ({
    update: { assigneeAgentId: "agent-2" }, activity: null, value: undefined,
  }), { lockScope: "task" }), /restricted to refusal parking fields/);
  assert.deepEqual(writes, []);
});
