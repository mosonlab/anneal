import assert from "node:assert/strict";
import test from "node:test";

import {
  AssigneeType,
  COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE,
  type PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { refusalResponse } from "./refusal.js";
import { composeBrief, readBrief } from "./task-brief.js";
import { patchTask } from "./task-patch.js";

const patchFixture = (description: string, outputKind = "implementation") => {
  let update: Record<string, unknown> | null = null;
  const activities: Array<Record<string, unknown>> = [];
  const templateStep = {
    stepIndex: 1,
    outputKind,
    priorOutputKinds: [],
    taskTemplate: { name: "direct-engineer-workflow" },
  };
  const task = {
    id: "task-1",
    projectId: "project-1",
    templateId: "template-1",
    templateStepId: "step-1",
    chainId: "chain-1",
    description,
    name: "Direct implementation",
    approvalGate: false,
    archivedAt: null,
    status: TaskStatus.TODO as TaskStatus,
    dispatchAfterTaskId: null,
    dispatchAfter: null,
    assigneeType: AssigneeType.HUMAN,
    assigneeAgentId: null,
    repoId: null,
    scheduleKind: null,
    templateStep,
  };
  const tx = {
    $queryRaw: async () => [{ id: task.id }],
    task: {
      findUnique: async () => task,
      findUniqueOrThrow: async () => task,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        update = data;
        Object.assign(task, data);
        return { ...task, ...data };
      },
    },
    taskTemplateStep: { findUnique: async () => templateStep },
    taskActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        activities.push(data);
        return { id: `activity-${activities.length}` };
      },
    },
  };
  const db = {
    ...tx,
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  return { db, update: () => update, activities: () => activities };
};

test("an operator description edit rewrites only a template Chain task's brief", async () => {
  const description = composeBrief({
    prompt: "Implement the Specification of record.",
    brief: "Original brief",
    attachmentsFromPrevious: false,
    outputKind: "implementation",
  });
  const fixture = patchFixture(description);

  const result = await patchTask(fixture.db, "task-1", { description: "Operator-edited brief" });

  assert.ok("task" in result);
  const written = fixture.update()?.description;
  assert.equal(typeof written, "string");
  assert.deepEqual(readBrief(written as string), {
    prompt: "Implement the Specification of record.",
    brief: "Operator-edited brief",
    hadReminder: false,
  });
  assert.match(written as string, /Persist the final implementation output/u);
});

test("a template Chain description patch refuses an unparseable stored brief", async () => {
  const fixture = patchFixture("operator-corrupted description");

  const result = await patchTask(fixture.db, "task-1", { description: "Replacement brief" });

  assert.deepEqual(result, {
    reason: "invalid-request",
    message: "Cannot rewrite task brief: task brief marker is missing",
  });
  assert.equal(fixture.update(), null);
});

test("a mechanical template Step keeps its free-form description patch", async () => {
  const fixture = patchFixture("Run the merge readiness gate.", "merge-authorization");

  const result = await patchTask(fixture.db, "task-1", { description: "concurrent writer completed after recovery" });

  assert.ok("task" in result);
  assert.equal(fixture.update()?.description, "concurrent writer completed after recovery");
});

test("a compound implementation reassignment returns a structured refusal directly", async () => {
  const task = {
    id: "task-compound",
    projectId: "project-1",
    templateStepId: "step-compound",
    chainId: "chain-1",
    approvalGate: false,
    archivedAt: null,
    status: TaskStatus.TODO,
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: "executioner",
    repoId: "repo-1",
    scheduleKind: null,
  };
  const db = {
    task: { findUniqueOrThrow: async () => task },
    agent: { findFirst: async () => null },
    taskTemplateStep: { findUnique: async () => ({
      stepIndex: 5,
      outputKind: "implementation",
      taskTemplate: { name: "compound-engineer-workflow" },
    }) },
  } as unknown as PrismaClient;

  assert.deepEqual(await patchTask(db, task.id, {
    assigneeType: AssigneeType.HUMAN,
    assigneeAgentId: null,
  }), {
    reason: "compound-implementation-assignee",
    message: "Compound implementation step requires an active in-project Agent on a Codex gpt-* model",
    detail: { code: COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE },
  });
});

test("TODO specification and merge slots accept approval-gate toggles with activity", async () => {
  for (const [outputKind, slot] of [["spec", "spec"], ["merge-authorization-v2", "merge"]] as const) {
    const fixture = patchFixture("Gate slot", outputKind);

    const enabled = await patchTask(fixture.db, "task-1", { approvalGate: true });
    assert.ok("task" in enabled);
    assert.equal(fixture.update()?.approvalGate, true);
    assert.deepEqual(fixture.activities(), [{ taskId: "task-1", actorType: "operator", body: `Approval gate changed: ${slot} = true` }]);

    const disabled = await patchTask(fixture.db, "task-1", { approvalGate: false });
    assert.ok("task" in disabled);
    assert.equal(fixture.update()?.approvalGate, false);
    assert.deepEqual(fixture.activities().map(({ taskId: _taskId, ...activity }) => activity), [
      { actorType: "operator", body: `Approval gate changed: ${slot} = true` },
      { actorType: "operator", body: `Approval gate changed: ${slot} = false` },
    ]);
  }
});

test("a non-slot chain task keeps the gate restriction", async () => {
  const fixture = patchFixture("Non-slot", "implementation");
  const result = await patchTask(fixture.db, "task-1", { approvalGate: true });
  assert.deepEqual(result, {
    reason: "conflict",
    message: "Only the specification and merge readiness steps carry a configurable gate",
  });
  assert.equal(fixture.update(), null);
  assert.deepEqual(fixture.activities(), []);
});

test("a slot that is no longer TODO is refused under the Task lock", async () => {
  const fixture = patchFixture("Gate slot", "spec");
  const task = {
    id: "task-1",
    projectId: "project-1",
    templateId: "template-1",
    templateStepId: "step-1",
    chainId: "chain-1",
    description: composeBrief({
      prompt: "Implement the Specification of record.",
      brief: "Gate slot",
      attachmentsFromPrevious: false,
      outputKind: "spec",
    }),
    name: "Specification",
    approvalGate: false,
    archivedAt: null,
    status: TaskStatus.TODO,
    dispatchAfterTaskId: null,
    dispatchAfter: null,
    assigneeType: AssigneeType.HUMAN,
    assigneeAgentId: null,
    repoId: null,
    scheduleKind: null,
    templateStep: {
      stepIndex: 1,
      outputKind: "spec",
      priorOutputKinds: [],
      taskTemplate: { name: "compound-engineer-workflow" },
    },
  };
  let lockedRead = false;
  const tx = fixture.db as unknown as {
    task: { findUnique: (...args: unknown[]) => Promise<unknown>; findUniqueOrThrow: (...args: unknown[]) => Promise<unknown> };
  };
  tx.task.findUniqueOrThrow = async () => ({ ...task });
  tx.task.findUnique = async () => {
    if (lockedRead) return { ...task, status: TaskStatus.DOING };
    lockedRead = true;
    return { ...task };
  };

  const result = await patchTask(fixture.db, task.id, { approvalGate: true });
  assert.deepEqual(result, {
    reason: "conflict",
    message: "The specification gate is already DOING; approval gates may only be changed while the step is TODO",
  });
  assert.equal(fixture.update(), null);
  assert.deepEqual(fixture.activities(), []);
});

/**
 * §R5, through the route. The four PATCH branches all reach `writeTask`, so the
 * fixture is deliberately the plain field-edit branch: it is the one that
 * carries no status and no `opensPullRequest`, and its refusal is the mapping
 * every other branch shares.
 */
const reassignmentFixture = (runs: Array<{ runNumber: number; status: RunStatus }>) => {
  const task = {
    id: "task-busy",
    projectId: "project-1",
    templateId: null,
    templateStepId: null,
    chainId: null,
    description: "work",
    name: "Busy task",
    approvalGate: false,
    archivedAt: null,
    status: TaskStatus.DOING as TaskStatus,
    dispatchAfterTaskId: null,
    dispatchAfter: null,
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: "agent-1",
    repoId: null,
    scheduleKind: null,
    maxSessionsPerTask: 5,
    templateStep: null,
  };
  const agents = [
    { id: "agent-1", name: "senior-dev-astra-medium", projectId: "project-1", archivedAt: null },
    { id: "agent-2", name: "senior-dev-luna-max", projectId: "project-1", archivedAt: null },
  ];
  const writes: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => [{ id: task.id }],
    task: {
      findUnique: async () => task,
      findUniqueOrThrow: async () => task,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { ...task, ...data };
      },
    },
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        agents.find((agent) => agent.id === where.id) ?? null,
      findFirst: async ({ where }: { where: { id: string; projectId?: string } }) =>
        agents.find((agent) => agent.id === where.id) ?? null,
    },
    run: {
      findFirst: async ({ where }: { where: { status: { in: readonly RunStatus[] } } }) =>
        runs.find((run) => where.status.in.includes(run.status)) ?? null,
    },
    taskActivity: { create: async () => ({ id: "activity-1" }) },
  };
  const db = {
    ...tx,
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  return { db, writes };
};

for (const status of [RunStatus.RUNNING, RunStatus.QUEUED, RunStatus.WAITING_INBOX] as const) {
  test(`PATCH refuses a reassignment with 409 while a ${status} Run exists`, async () => {
    const fixture = reassignmentFixture([{ runNumber: 3, status }]);
    assert.deepEqual(await patchTask(fixture.db, "task-busy", { assigneeAgentId: "agent-2" }), {
      reason: "conflict",
      message: `Cannot change the assignee while run 3 is ${status}; stop or finish it first`,
    });
    assert.deepEqual(fixture.writes, []);
  });
}

test("the reassignment refusal is a 409, not a 400", async () => {
  const fixture = reassignmentFixture([{ runNumber: 1, status: RunStatus.RUNNING }]);
  const refusal = await patchTask(fixture.db, "task-busy", { assigneeAgentId: "agent-2" });
  assert.ok("reason" in refusal);
  assert.equal(refusalResponse(refusal).status, 409);
});

test("PATCH refuses clearing the assignee and changing the assignee type the same way", async () => {
  for (const body of [{ assigneeAgentId: null }, { assigneeType: AssigneeType.HUMAN }] as const) {
    const fixture = reassignmentFixture([{ runNumber: 1, status: RunStatus.RUNNING }]);
    const result = await patchTask(fixture.db, "task-busy", body);
    assert.ok("reason" in result);
    assert.equal(result.reason, "conflict");
    assert.deepEqual(fixture.writes, []);
  }
});

test("PATCH accepts the same reassignment once the task's Runs are terminal", async () => {
  const fixture = reassignmentFixture([{ runNumber: 1, status: RunStatus.FAILED }]);
  const result = await patchTask(fixture.db, "task-busy", { assigneeAgentId: "agent-2" });
  assert.ok("task" in result);
  assert.deepEqual(fixture.writes, [{ assigneeAgentId: "agent-2" }]);
});

/**
 * The chain-binding PATCH decides entirely from rows read under the chain
 * mutex, so the seam a fake transaction has to provide is small: the chain's
 * own rows, its Run count, and the predecessor the request names.
 */
const bindingFixture = (options: {
  dispatchAfterTaskId?: string | null;
  chainRows?: ReadonlyArray<{ id: string }>;
  runCount?: number;
  predecessors?: ReadonlyArray<{ id: string; name: string; chainId: string | null; archivedAt: Date | null }>;
  chainId?: string | null;
} = {}) => {
  const task = {
    id: "task-first",
    projectId: "project-1",
    templateId: null,
    templateStepId: null,
    chainId: options.chainId === undefined ? "chain-1" : options.chainId,
    description: "work",
    name: "First step",
    approvalGate: false,
    archivedAt: null,
    status: TaskStatus.TODO as TaskStatus,
    dispatchAfterTaskId: options.dispatchAfterTaskId ?? null,
    dispatchAfter: null,
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: null,
    repoId: null,
    scheduleKind: null,
    maxSessionsPerTask: 5,
    templateStep: null,
  };
  const writes: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => [{ id: task.id }],
    task: {
      findUnique: async () => task,
      findUniqueOrThrow: async () => task,
      findMany: async () => options.chainRows ?? [{ id: task.id }, { id: "task-second" }],
      findFirst: async ({ where }: { where: { id: string } }) =>
        (options.predecessors ?? []).find((candidate) => candidate.id === where.id) ?? null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { ...task, ...data };
      },
    },
    run: { count: async () => options.runCount ?? 0 },
    taskActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        activities.push(data);
        return { id: `activity-${activities.length}` };
      },
    },
  };
  const db = {
    ...tx,
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  return { db, writes, activities };
};

const donePredecessor = {
  id: "task-done",
  name: "Predecessor",
  chainId: "chain-0",
  archivedAt: null,
};

test("an unstarted chain is re-pointed at a DONE predecessor and records the change", async () => {
  const fixture = bindingFixture({
    dispatchAfterTaskId: "task-old",
    predecessors: [donePredecessor],
  });

  const result = await patchTask(fixture.db, "task-first", { dispatchAfterTaskId: "task-done" });

  assert.ok("task" in result);
  assert.equal(result.task.dispatchAfterTaskId, "task-done");
  assert.deepEqual(fixture.writes, [{ dispatchAfterTaskId: "task-done" }]);
  assert.deepEqual(fixture.activities, [{
    taskId: "task-first",
    actorType: "operator",
    body: "Chain binding changed by operator request: predecessor task-old → task-done",
    metadata: {
      chainId: "chain-1",
      previousDispatchAfterTaskId: "task-old",
      dispatchAfterTaskId: "task-done",
    },
  }]);
});

test("null releases the binding without starting the chain", async () => {
  const fixture = bindingFixture({ dispatchAfterTaskId: "task-old" });

  const result = await patchTask(fixture.db, "task-first", { dispatchAfterTaskId: null });

  assert.ok("task" in result);
  assert.equal(result.task.dispatchAfterTaskId, null);
  assert.deepEqual(fixture.writes, [{ dispatchAfterTaskId: null }]);
  assert.equal(fixture.activities.length, 1);
  assert.equal(
    fixture.activities[0]!.body,
    "Chain binding changed by operator request: predecessor task-old → none",
  );
});

test("restating the binding a chain already has writes no activity", async () => {
  const fixture = bindingFixture({ dispatchAfterTaskId: "task-old", runCount: 3 });

  const result = await patchTask(fixture.db, "task-first", { dispatchAfterTaskId: "task-old" });

  assert.ok("task" in result);
  assert.deepEqual(fixture.activities, []);
});

test("a chain with a Run keeps its binding, as does a later step and a standalone task", async () => {
  const cases = [
    { fixture: bindingFixture({ runCount: 1, predecessors: [donePredecessor] }), label: "started chain" },
    {
      fixture: bindingFixture({
        chainRows: [{ id: "task-zero" }, { id: "task-first" }],
        predecessors: [donePredecessor],
      }),
      label: "later step",
    },
    { fixture: bindingFixture({ chainId: null, predecessors: [donePredecessor] }), label: "standalone task" },
  ];
  for (const { fixture, label } of cases) {
    const result = await patchTask(fixture.db, "task-first", { dispatchAfterTaskId: "task-done" });
    assert.ok("reason" in result, label);
    assert.equal(result.reason, "chain_binding_immutable_after_start", label);
    assert.equal(refusalResponse(result).status, 409, label);
    assert.deepEqual(fixture.writes, [], label);
    assert.deepEqual(fixture.activities, [], label);
  }
});

test("an archived, foreign, or same-chain predecessor is an invalid target", async () => {
  const cases = [
    { id: "task-archived", predecessors: [{ ...donePredecessor, id: "task-archived", archivedAt: new Date() }] },
    { id: "task-foreign", predecessors: [] },
    { id: "task-second", predecessors: [{ ...donePredecessor, id: "task-second", chainId: "chain-1" }] },
    { id: "task-first", predecessors: [{ ...donePredecessor, id: "task-first", chainId: "chain-1" }] },
  ];
  for (const { id, predecessors } of cases) {
    const fixture = bindingFixture({ predecessors });
    const result = await patchTask(fixture.db, "task-first", { dispatchAfterTaskId: id });
    assert.ok("reason" in result, id);
    assert.equal(result.reason, "chain_binding_target_invalid", id);
    assert.equal(refusalResponse(result).status, 400, id);
    assert.deepEqual(fixture.writes, [], id);
    assert.deepEqual(fixture.activities, [], id);
  }
});
