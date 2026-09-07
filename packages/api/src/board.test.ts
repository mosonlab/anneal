import assert from "node:assert/strict";
import test from "node:test";

import { ChainControlState, markerFromMetadata, Prisma, type PrismaClient } from "@anneal/db";

import {
  type BoardChainControl,
  type BoardChainMember,
  type BoardRow,
  boardCard,
  chainAggregate,
  chainDisplayByTask,
  etagFor,
  etagMatches,
  readBoard,
  repairBinding,
  repairChainBindingsFromRows,
  readTaskList,
  strandedSalvageBranchesFromRuns,
  taskChainName,
} from "./board.js";
import { chainProgress, type ChainRow } from "./chain.js";

/** When every fixture run became eligible to be claimed, which is where the
 *  queued phase starts. */
const RUN_READY = new Date("2026-08-15T00:00:00.000Z");

const session = (overrides: Partial<NonNullable<BoardRow["runs"][number]["session"]>> = {}): NonNullable<BoardRow["runs"][number]["session"]> => ({
  nativeChildUsed: false, costUsd: null, inputTokens: null, cachedInputTokens: null,
  cacheCreationInputTokens: 0, outputTokens: null, executionStatus: "SUCCEEDED",
  provisionedAt: null, startedAt: null, endedAt: null, cleanupStartedAt: null, cleanupEndedAt: null,
  ...overrides,
});

const row = (overrides: Partial<BoardRow> = {}): BoardRow => ({
  id: "t1",
  projectId: "p1",
  name: "Ship the thing",
  status: "TODO" as BoardRow["status"],
  assigneeType: "AGENT" as BoardRow["assigneeType"],
  assigneeAgentId: null,
  repoId: null,
  archivedAt: null,
  maxSessionsPerTask: 5,
  failureReason: null,
  scheduleKind: "NOW" as BoardRow["scheduleKind"],
  runAt: null,
  cron: null,
  timezone: null,
  approvalGate: false,
  templateId: null,
  source: "MANUAL" as BoardRow["source"],
  chainId: null,
  chainIndex: null,
  chainLayer: null,
  templateStepId: null,
  dispatchAfterTaskId: null,
  createdAt: new Date("2026-08-15T00:00:00.000Z"),
  updatedAt: new Date("2026-08-16T00:00:00.000Z"),
  templateStep: null,
  assigneeAgent: null,
  runs: [],
  ...overrides,
});

const moveContext = { hasRepoGrant: false, chainPredecessorsDone: true };

test("the polled task list bounds its full Run relation to the newest row", async () => {
  let taskQuery: Record<string, unknown> | undefined;
  const db = {
    task: {
      findMany: async (args: Record<string, unknown>) => { taskQuery = args; return []; },
      groupBy: async () => [],
    },
  } as unknown as PrismaClient;

  assert.deepEqual(await readTaskList(db, { archived: "false" }, { enrich: false }), []);
  assert.equal(((taskQuery?.include as any)?.runs as any)?.take, 1);
});

const member = (overrides: Partial<BoardChainMember> = {}): BoardChainMember => ({
  id: "step-1",
  projectId: "p1",
  name: "Release: Step 1",
  displayName: "Step 1",
  chainId: "c1",
  chainIndex: 0,
  chainLayer: 0,
  status: "TODO" as BoardChainMember["status"],
  failureReason: null,
  dispatchAfterTaskId: null,
  createdAt: new Date("2026-08-15T00:00:00.000Z"),
  updatedAt: new Date("2026-08-16T00:00:00.000Z"),
  templateStep: { name: "Step 1" },
  runs: [],
  ...overrides,
});

const boardReadDatabase = ({
  rows,
  chainRows = [],
  related = [],
  activities = [],
  controls = [],
}: {
  rows: BoardRow[];
  chainRows?: Array<Record<string, unknown>>;
  related?: Array<{
    id: string;
    name?: string;
    status?: BoardRow["status"];
    projectId?: string;
    chainId?: string | null;
  }>;
  activities?: Array<{ taskId: string; metadata: Record<string, unknown> }>;
  controls?: Array<BoardChainControl & { projectId: string; chainId: string }>;
}): { db: PrismaClient; predecessorLookups: string[][]; controlLookups: string[][] } => {
  const predecessorLookups: string[][] = [];
  const controlLookups: string[][] = [];
  const db = {
    task: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        const where = args.where ?? {};
        if (where.id !== undefined) {
          const ids = (where.id as { in: string[] }).in;
          predecessorLookups.push(ids);
          return related.filter((candidate) => ids.includes(candidate.id));
        }
        if (where.chainId !== undefined) return chainRows;
        return rows;
      },
    },
    taskActivity: { findMany: async () => activities },
    chainControl: {
      findMany: async (args: { where?: { OR?: Array<{ projectId: string; chainId: string }> } }) => {
        const keys = args.where?.OR ?? [];
        controlLookups.push(keys.map((key) => `${key.projectId}:${key.chainId}`));
        return controls;
      },
    },
  } as unknown as PrismaClient;
  return { db, predecessorLookups, controlLookups };
};

/* ------------------------------------------------------------ the read model */

test("readBoard performs no predecessor lookup for an unbound page", async () => {
  const { db, predecessorLookups } = boardReadDatabase({ rows: [row()] });

  const cards = await readBoard(db, { projectId: "p1", archived: "false" });

  assert.equal(cards[0]?.blockedOn, null);
  assert.deepEqual(predecessorLookups, []);
});

test("readBoard resolves every bound row in one deduplicated predecessor lookup", async () => {
  const predecessorOne = { id: "predecessor-1", name: "Build predecessor", status: "DOING" as BoardRow["status"] };
  const predecessorTwo = { id: "predecessor-2", name: "Review predecessor", status: "REVIEW" as BoardRow["status"] };
  const { db, predecessorLookups } = boardReadDatabase({
    rows: [
      row({ id: "first", chainId: "successor-1", chainIndex: 0, dispatchAfterTaskId: predecessorOne.id }),
      row({ id: "same-binding", chainId: "successor-2", chainIndex: 0, dispatchAfterTaskId: predecessorOne.id }),
      row({ id: "second", chainId: "successor-3", chainIndex: 0, dispatchAfterTaskId: predecessorTwo.id }),
      row({ id: "unbound", chainId: "successor-4", chainIndex: 0 }),
    ],
    related: [predecessorOne, predecessorTwo],
  });

  const cards = await readBoard(db, { projectId: "p1", archived: "false" });

  assert.deepEqual(predecessorLookups, [[predecessorOne.id, predecessorTwo.id]]);
  assert.deepEqual(cards.find((card) => card.id === "first")?.blockedOn, {
    taskId: predecessorOne.id, taskName: predecessorOne.name,
  });
  assert.deepEqual(cards.find((card) => card.id === "same-binding")?.blockedOn, {
    taskId: predecessorOne.id, taskName: predecessorOne.name,
  });
  assert.deepEqual(cards.find((card) => card.id === "second")?.blockedOn, {
    taskId: predecessorTwo.id, taskName: predecessorTwo.name,
  });
  assert.equal(cards.find((card) => card.id === "unbound")?.blockedOn, null);
});

test("readBoard loads ChainControl rows once and projects a held aggregate", async () => {
  const heldAt = new Date("2026-08-16T02:00:00.000Z");
  const { db, controlLookups } = boardReadDatabase({
    rows: [
      row({ id: "held-first", chainId: "held-chain", chainIndex: 0, chainLayer: 0 }),
      row({ id: "held-second", chainId: "held-chain", chainIndex: 1, chainLayer: 1 }),
    ],
    controls: [{
      projectId: "p1",
      chainId: "held-chain",
      state: ChainControlState.HELD,
      held: true,
      heldLayer: 0,
      heldAt,
      holdReason: "operator review",
    }],
  });

  const cards = await readBoard(db, { projectId: "p1", archived: "false" });
  const aggregate = cards[0]?.chainAggregate;

  assert.deepEqual(controlLookups, [["p1:held-chain"]]);
  assert.equal(aggregate?.activation.state, "held");
  assert.deepEqual(aggregate?.activation.hold, {
    heldLayer: 0,
    heldAt,
    holdReason: "operator review",
  });
  assert.equal(aggregate?.activation.taskId, "held-first");
  assert.equal(aggregate?.status, "TODO");
});

/* ------------------------------------------------------------ the projection */

test("the board projection carries every field the board consumes and nothing else", () => {
  // Spelled out rather than derived: a field added to the projection is a
  // deliberate act with a payload cost, so it has to be added here too.
  assert.deepEqual(Object.keys(boardCard(row(), null, moveContext)).sort(), [
    "approvalGate", "assigneeAgent", "assigneeType", "baseline", "blockedOn", "budgetRemaining", "chainAggregate", "chainId", "chainIndex", "chainName", "chainProgress", "createdAt", "cron",
    "displayName", "failureReason", "id", "latestRun", "leaseLossRefunds", "mergeOutcome", "moveTargets", "name", "readinessGrants", "readinessRequeues", "repairOf", "runAt", "scheduleKind", "source", "status",
    "strandedSalvageBranches", "taskCost", "templateId", "timezone", "updatedAt",
  ]);
});

test("the projection derives stranded salvage only when a later Run kept the LOST base", () => {
  const baseSha = "a".repeat(40);
  assert.deepEqual(strandedSalvageBranchesFromRuns([
    { runNumber: 3, status: "RUNNING", pushedBranch: null, baseSha },
    { runNumber: 2, status: "LOST", pushedBranch: "agentos/task-1/run-2", baseSha },
    { runNumber: 1, status: "LOST", pushedBranch: "agentos/task-1/run-1", baseSha: "b".repeat(40) },
  ]), [{ branch: "agentos/task-1/run-2", lostRunNumber: 2 }]);
  assert.deepEqual(strandedSalvageBranchesFromRuns([
    { runNumber: 2, status: "RUNNING", pushedBranch: null, baseSha: "b".repeat(40) },
    { runNumber: 1, status: "LOST", pushedBranch: "agentos/task-1/run-1", baseSha },
  ]), []);
  assert.deepEqual(strandedSalvageBranchesFromRuns([
    { runNumber: 1, status: "FAILED", pushedBranch: "agentos/task-1/run-1", baseSha },
  ]), []);
});

test("a board card carries the stranded salvage branch and LOST Run number", () => {
  const baseSha = "a".repeat(40);
  const card = boardCard(row({ runs: [
    { id: "run-2", runNumber: 2, status: "RUNNING", model: "claude", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: null },
    { id: "run-1", runNumber: 1, status: "LOST", model: "claude", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: "agentos/task-1/run-1", baseSha, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: null },
  ]}), null, moveContext);
  assert.deepEqual(card.strandedSalvageBranches, [{ branch: "agentos/task-1/run-1", lostRunNumber: 1 }]);
});

test("the board projection carries the operator transition matrix", () => {
  const targets = (overrides: Partial<BoardRow>, context = moveContext) =>
    boardCard(row(overrides), null, context).moveTargets;
  const startableAgent = {
    assigneeType: "AGENT" as const,
    assigneeAgentId: "a1",
    repoId: "r1",
    assigneeAgent: { id: "a1", title: "Developer", model: "gpt-5.6-sol", archivedAt: null },
  };
  const startable = { hasRepoGrant: true, chainPredecessorsDone: true };

  assert.deepEqual(targets({ assigneeType: "HUMAN", status: "TODO" }), [
    { status: "BACKLOG", via: "patch" }, { status: "DONE", via: "patch" },
  ]);
  assert.deepEqual(targets({ assigneeType: "HUMAN", status: "DOING" }), [{ status: "DONE", via: "patch" }]);
  assert.deepEqual(targets({ assigneeType: "HUMAN", status: "REVIEW" }), [{ status: "DONE", via: "patch" }]);
  assert.deepEqual(targets({ assigneeType: "HUMAN", status: "DONE" }), []);
  assert.deepEqual(targets({ ...startableAgent, status: "TODO" }, startable), [
    { status: "BACKLOG", via: "patch" }, { status: "DOING", via: "start" },
  ]);
  assert.deepEqual(targets({ ...startableAgent, status: "BACKLOG" }, startable), [
    { status: "TODO", via: "patch" }, { status: "DOING", via: "start" },
  ]);
  assert.deepEqual(targets({ ...startableAgent, status: "DOING" }, startable), []);
  assert.deepEqual(targets({ ...startableAgent, status: "REVIEW" }, startable), []);
  assert.deepEqual(targets({ ...startableAgent, status: "DONE" }, startable), []);
  assert.deepEqual(targets({ assigneeType: "HUMAN", status: "TODO" }, {
    hasRepoGrant: false, chainPredecessorsDone: false,
  }), []);

  const humanApprovalGate = targets({
    assigneeType: "HUMAN", approvalGate: true, chainId: "c1", chainIndex: 2, status: "TODO",
  });
  assert.deepEqual(humanApprovalGate, [{ status: "DONE", via: "patch" }]);

  const agentTargets = targets({ ...startableAgent, status: "TODO" }, startable);
  assert.deepEqual(agentTargets.find(({ status }) => status === "DOING"), { status: "DOING", via: "start" });
  assert.equal(agentTargets.some(({ status, via }) => via === "patch" && ["DOING", "REVIEW", "DONE"].includes(status)), false);
});

test("a standalone Agent task with an active Run does not offer Backlog", () => {
  const card = boardCard(row({
    status: "TODO",
    assigneeAgentId: "a1",
    repoId: "r1",
    assigneeAgent: {
      id: "a1", name: "developer", title: "Developer", model: "gpt-5.6-sol", archivedAt: null,
    },
    runs: [{
      id: "run-1", runNumber: 1, status: "RUNNING", model: "gpt-5.6-sol", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: null,
    }],
  }), null, { hasRepoGrant: true, chainPredecessorsDone: true });

  assert.equal(card.moveTargets.some(({ status }) => status === "BACKLOG"), false);
});

test("a Backlog task with an archived assignee does not offer Todo", () => {
  const card = boardCard(row({
    status: "BACKLOG",
    assigneeAgentId: "a1",
    repoId: "r1",
    assigneeAgent: {
      id: "a1", name: "retired", title: "Retired", model: "gpt-5.6-sol", archivedAt: new Date(),
    },
  }), null, { hasRepoGrant: true, chainPredecessorsDone: true });

  assert.equal(card.moveTargets.some(({ status }) => status === "TODO"), false);
});

test("a repair task is bound to the chain of the regression task its marker names", () => {
  const chain = (): { chainId: string; chainName: string | null } => ({ chainId: "c1", chainName: "Release" });
  assert.deepEqual(
    repairBinding(markerFromMetadata({ schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", regressionTaskId: "reg-1" }), chain),
    { chainId: "c1", chainName: "Release", repairKind: "gate-fix" },
  );
  // The regression side of the same marker names the repair task, not a chain
  // this card could be put under, so it is not this card's binding.
  assert.equal(
    repairBinding(markerFromMetadata({ schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", repairTaskId: "fix-1" }), chain),
    null,
  );
  // A regression task that is itself chain-detached binds nothing.
  assert.equal(repairBinding(markerFromMetadata({ kind: "mergeTail.repairAttempt", repairKind: "review-fix", regressionTaskId: "reg-1" }), () => null), null);
  assert.equal(repairBinding(null, chain), null);
  assert.equal(boardCard(row(), null, moveContext).repairOf, null);
  assert.deepEqual(
    boardCard(row(), null, moveContext, undefined, null, { chainId: "c1", chainName: "Release", repairKind: "review-fix" }).repairOf,
    { chainId: "c1", chainName: "Release", repairKind: "review-fix" },
  );
});

test("row-based repair binding preserves the board rule for newly introduced repair kinds", () => {
  const bindings = repairChainBindingsFromRows(
    [{ id: "repair-1", projectId: "p1" }],
    [{
      taskId: "repair-1",
      metadata: {
        schemaVersion: 1,
        kind: "mergeTail.repairAttempt",
        repairKind: "future-repair",
        regressionTaskId: "regression-1",
      },
    }],
    [{ id: "regression-1", projectId: "p1", chainId: "chain-1" }],
  );

  assert.deepEqual(bindings.get("repair-1"), {
    projectId: "p1",
    chainId: "chain-1",
    repairKind: "future-repair",
  });
});

test("chainAggregate derives primary progress and every board column from the frontier", () => {
  const allTodo = chainAggregate("c1", "Release", [
    member({ id: "step-1", name: "Release: Build", displayName: "Build", chainIndex: 0, chainLayer: 0 }),
    member({ id: "step-2", name: "Release: Review", displayName: "Review", chainIndex: 1, chainLayer: 1 }),
    member({ id: "step-3", name: "Release: Ship", displayName: "Ship", chainIndex: 2, chainLayer: 2 }),
  ], []);
  assert.equal(allTodo.status, "TODO");
  assert.equal(allTodo.stepCount, 3);
  assert.deepEqual(allTodo.statusCounts, { BACKLOG: 0, TODO: 3, DOING: 0, REVIEW: 0, DONE: 0 });
  assert.deepEqual(allTodo.frontier, {
    taskId: "step-1", title: "Build", status: "TODO", latestRun: null, mergeOutcome: null, failureReason: null, position: 1,
  });
  assert.deepEqual(allTodo.activation, {
    state: "parked-unactivated", predecessor: null, taskId: "step-1", hold: null,
  });

  const doing = chainAggregate("c1", "Release", [
    member({ id: "step-1", status: "DONE", chainIndex: 0, chainLayer: 0 }),
    member({ id: "step-2", status: "DOING", chainIndex: 1, chainLayer: 1 }),
    member({ id: "step-3", status: "TODO", chainIndex: 2, chainLayer: 2 }),
  ], []);
  assert.equal(doing.status, "DOING");
  assert.equal(doing.frontier.taskId, "step-2");
  assert.equal(doing.activation.state, "running");

  const review = chainAggregate("c1", "Release", [
    member({ id: "step-1", status: "DONE", chainIndex: 0, chainLayer: 0 }),
    member({ id: "step-2", status: "REVIEW", failureReason: "needs approval", chainIndex: 1, chainLayer: 1 }),
  ], []);
  assert.equal(review.status, "REVIEW");
  assert.equal(review.activation.state, "idle");
  assert.deepEqual(review.frontier, {
    taskId: "step-2", title: "Step 1", status: "REVIEW", latestRun: null, mergeOutcome: null, failureReason: "needs approval", position: 2,
  });

  const done = chainAggregate("c1", "Release", [
    member({ id: "step-1", status: "DONE", chainIndex: 0, chainLayer: 0 }),
    member({ id: "step-2", status: "DONE", chainIndex: 1, chainLayer: 1 }),
  ], []);
  assert.equal(done.status, "DONE");
  assert.equal(done.activation.state, "settled");
  assert.equal(done.frontier.taskId, "step-2");
});

test("chainAggregate opens the frontier Step, not the first one", () => {
  const midChain = chainAggregate("c1", "Release", [
    member({ id: "step-1", status: "DONE", chainIndex: 0, chainLayer: 0 }),
    member({ id: "step-2", status: "DONE", chainIndex: 1, chainLayer: 1 }),
    member({ id: "step-3", status: "DOING", chainIndex: 2, chainLayer: 2 }),
    member({ id: "step-4", status: "TODO", chainIndex: 3, chainLayer: 3 }),
  ], []);
  assert.equal(midChain.frontier.taskId, "step-3");
  assert.equal(midChain.detailTaskId, midChain.frontier.taskId);
});

test("chainAggregate returns the exact board contract keys", () => {
  const aggregate = chainAggregate("c1", "Release", [member()], []);

  assert.deepEqual(Object.keys(aggregate).sort(), [
    "activation", "activeRepair", "chainId", "chainName", "createdAt", "detailTaskId", "firstRunStartedAt", "frontier",
    "status", "statusCounts", "stepCount", "totalCost", "updatedAt",
  ]);
  assert.deepEqual(Object.keys(aggregate.frontier).sort(), [
    "failureReason", "latestRun", "mergeOutcome", "position", "status", "taskId", "title",
  ]);
});

test("board aggregate and Chain detail choose the same first unfinished execution layer", () => {
  const shared = [
    { id: "done", name: "Completed layer", chainIndex: 1, chainLayer: 10, status: "DONE" as const },
    { id: "later", name: "Later layer", chainIndex: 2, chainLayer: 90, status: "TODO" as const },
    { id: "parallel-done", name: "Finished sibling", chainIndex: 3, chainLayer: 40, status: "DONE" as const },
    { id: "frontier", name: "First unfinished layer", chainIndex: 4, chainLayer: 40, status: "TODO" as const },
  ];
  const aggregate = chainAggregate("c1", "Release", shared.map((item) => member({
    ...item,
    displayName: item.name,
    templateStep: { name: item.name },
  })), []);
  const detail = chainProgress(shared.map((item): ChainRow => ({
    ...item,
    projectId: "p1",
    chainId: "c1",
    archivedAt: null,
    templateStep: { name: item.name },
  })));

  assert.equal(aggregate.frontier.taskId, "frontier");
  assert.equal(aggregate.frontier.title, detail?.activeStepName);
  assert.equal(detail?.currentLayer, 2);
});

test("chainAggregate reports a predecessor-bound chain and never offers parked activation", () => {
  const predecessor = { id: "previous-task", name: "Finish source", status: "DOING" as BoardRow["status"] };
  const aggregate = chainAggregate("c1", "Release", [
    member({ dispatchAfterTaskId: predecessor.id }),
    member({ id: "step-2", chainIndex: 1, chainLayer: 1 }),
  ], [], new Map([[predecessor.id, predecessor]]));

  assert.deepEqual(aggregate.activation, {
    state: "waiting-on-predecessor",
    predecessor: { taskId: predecessor.id, taskName: predecessor.name },
    taskId: "step-1",
    hold: null,
  });
});

test("chainAggregate offers activation after a bound predecessor has settled", () => {
  const predecessor = { id: "previous-task", name: "Finish source", status: "DONE" as BoardRow["status"] };
  const aggregate = chainAggregate("c1", "Release", [
    member({ dispatchAfterTaskId: predecessor.id }),
    member({ id: "step-2", chainIndex: 1, chainLayer: 1 }),
  ], [], new Map([[predecessor.id, predecessor]]));

  assert.deepEqual(aggregate.activation, {
    state: "parked-unactivated",
    predecessor: null,
    taskId: "step-1",
    hold: null,
  });
});

test("chainAggregate projects a held chain without changing active-run or column semantics", () => {
  const heldAt = new Date("2026-08-16T02:00:00.000Z");
  const hold = {
    state: ChainControlState.HELD,
    held: true,
    heldLayer: 1,
    heldAt,
    holdReason: "wait for operator review",
  } satisfies BoardChainControl;
  const held = chainAggregate("c1", "Release", [
    member({ id: "step-1", status: "DONE", chainIndex: 0, chainLayer: 0 }),
    member({ id: "step-2", status: "TODO", chainIndex: 1, chainLayer: 1 }),
  ], [], new Map(), hold);

  assert.equal(held.status, "TODO");
  assert.equal(held.activation.state, "held");
  assert.deepEqual(held.activation.hold, {
    heldLayer: 1,
    heldAt,
    holdReason: "wait for operator review",
  });

  const running = chainAggregate("c1", "Release", [
    member({ id: "step-1", status: "DOING", chainIndex: 0, chainLayer: 0 }),
  ], [], new Map(), { ...hold, heldLayer: 0 });
  assert.equal(running.status, "DOING");
  assert.equal(running.activation.state, "running");
  assert.deepEqual(running.activation.hold, {
    heldLayer: 0,
    heldAt,
    holdReason: "wait for operator review",
  });
});

test("chainAggregate sums member usage and groups a detached repair without inflating steps", () => {
  const aggregate = chainAggregate("c1", "Release", [
    member({ id: "step-1", status: "DONE", chainIndex: 0, chainLayer: 0, runs: [
      { id: "run-1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: session({ costUsd: "1.25" }) },
    ] }),
    member({ id: "step-2", status: "DONE", chainIndex: 1, chainLayer: 1 }),
  ], [
    member({
      id: "repair", name: "Merge-tail repair", displayName: "Merge-tail repair", chainId: null,
      chainIndex: null, chainLayer: null, status: "TODO", runs: [
        { id: "run-2", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: session({ costUsd: "0.50" }) },
      ],
    }),
  ]);

  assert.equal(aggregate.stepCount, 2);
  assert.deepEqual(aggregate.statusCounts, { BACKLOG: 0, TODO: 0, DOING: 0, REVIEW: 0, DONE: 2 });
  assert.equal(aggregate.status, "TODO");
  assert.deepEqual(aggregate.frontier, {
    taskId: "repair", title: "Merge-tail repair", status: "TODO", latestRun: {
      id: "run-2", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5", codexServiceTier: "DEFAULT", costUsd: "0.50", startedAt: null, endedAt: null, pullRequestUrl: null,
      phase: "finished", phaseSince: RUN_READY, lastProgressEventAt: null, maxRunsPerTask: 5,
    }, mergeOutcome: null, failureReason: null,
  });
  assert.equal(aggregate.activation.state, "idle");
  assert.equal(aggregate.totalCost?.costUsd, "1.75");
});

test("chainAggregate projects an active detached repair without moving the frontier", () => {
  const startedAt = new Date("2026-08-16T00:00:00.000Z");
  const aggregate = chainAggregate("c1", "Release", [
    member({ id: "regression", status: "REVIEW", chainIndex: 0, chainLayer: 0 }),
  ], [
    member({
      id: "repair", name: "Merge-tail repair", displayName: "Merge-tail repair", chainId: null,
      chainIndex: null, chainLayer: null, status: "TODO", repairKind: "gate-fix", runs: [
        { id: "repair-run", runNumber: 3, status: "RUNNING", model: "gpt-5.6-sol:high", codexServiceTier: "FAST", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: session({ startedAt }) },
      ],
    }),
  ]);

  assert.equal(aggregate.frontier.taskId, "regression");
  assert.deepEqual(aggregate.activeRepair, {
    repairKind: "gate-fix",
    latestRun: {
      id: "repair-run", runNumber: 3, status: "RUNNING", model: "gpt-5.6-sol:high", codexServiceTier: "FAST",
      costUsd: null, startedAt, endedAt: null, pullRequestUrl: null,
      phase: "executing", phaseSince: startedAt, lastProgressEventAt: null, maxRunsPerTask: 5,
    },
  });
});

test("chainAggregate omits an inactive detached repair", () => {
  const aggregate = chainAggregate("c1", "Release", [member({ status: "REVIEW" })], [
    member({
      id: "repair", chainId: null, chainIndex: null, chainLayer: null, repairKind: "gate-fix",
      runs: [{ id: "repair-run", runNumber: 1, status: "SUCCEEDED", model: "gpt-5.6-sol", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: null }],
    }),
  ]);
  assert.equal(aggregate.activeRepair, null);
});

test("the Chain frontier projects a stopped merge outcome only for the Run it shows", () => {
  const stopped = JSON.stringify({ outcome: "stopped", condition: "head-drift", evidence: "live head changed" });
  const frontierRun = {
    id: "run-2", runNumber: 2, status: "SUCCEEDED" as const,
    model: "claude-opus-5", codexServiceTier: "DEFAULT" as const, budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: null,
  };
  const projection = (runId: string) => chainAggregate("c1", "Release", [member({
    status: "DONE",
    runs: [frontierRun],
    stepOutput: { kind: "merge-result", body: stopped, runId },
  })], []);

  assert.deepEqual(projection("run-2").frontier.mergeOutcome, {
    outcome: "stopped", condition: "head-drift", incident: false,
  });
  assert.equal(projection("run-1").frontier.mergeOutcome, null);
});

test("blockedOn is projected from the resolved predecessor without storing its status", () => {
  const predecessor = { id: "after-1", name: "Finish the release", status: "DOING" as BoardRow["status"] };
  const blocked = boardCard(row({ dispatchAfterTaskId: predecessor.id }), null, moveContext, undefined, predecessor);
  assert.deepEqual(blocked.blockedOn, { taskId: predecessor.id, taskName: predecessor.name });

  const resolved = boardCard(row({ dispatchAfterTaskId: predecessor.id }), null, moveContext, undefined, {
    ...predecessor, status: "DONE" as BoardRow["status"],
  });
  assert.equal(resolved.blockedOn, null);

  const unbound = boardCard(row(), null, moveContext);
  assert.equal(unbound.blockedOn, null);
  const { blockedOn: _blockedOn, ...rest } = unbound;
  assert.deepEqual(rest, {
    id: "t1",
    name: "Ship the thing",
    displayName: "Ship the thing",
    status: "TODO",
    assigneeType: "AGENT",
    failureReason: null,
    scheduleKind: "NOW",
    runAt: null,
    cron: null,
    timezone: null,
    approvalGate: false,
    templateId: null,
    source: "MANUAL",
    chainId: null,
    chainIndex: null,
    chainName: null,
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
    updatedAt: new Date("2026-08-16T00:00:00.000Z"),
    assigneeAgent: null,
    chainProgress: null,
    moveTargets: [{ status: "BACKLOG", via: "patch" }],
    latestRun: null,
    strandedSalvageBranches: [],
    taskCost: null,
    mergeOutcome: null,
    repairOf: null,
    budgetRemaining: true,
    leaseLossRefunds: 0,
    chainAggregate: null,
    baseline: null,
    readinessRequeues: 0,
    readinessGrants: 0,
  });
});

test("the card's merge outcome is bound to the run it shows, and is null everywhere else", () => {
  const merged = JSON.stringify({ outcome: "merged", mergeCommitSha: "a".repeat(40) });
  const run = { id: "r1", runNumber: 3, status: "SUCCEEDED" as const, model: "gpt-5.6-sol", codexServiceTier: "DEFAULT" as const, budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: null };
  // §SF-1: an ordinary step's output is not a malformed merge result, it is not
  // a merge result at all, and 112 board cards must not each carry a marker.
  assert.equal(boardCard(row({ runs: [run], stepOutput: { kind: "code-review", body: "fine", runId: "r1" } }), null, moveContext).mergeOutcome, null);
  assert.equal(boardCard(row({ runs: [], stepOutput: { kind: "merge-result", body: merged, runId: "r1" } }), null, moveContext).mergeOutcome, null);
  // A stop recorded by an earlier run is not the newest run's outcome.
  assert.equal(boardCard(row({ runs: [run], stepOutput: { kind: "merge-result", body: merged, runId: "r0" } }), null, moveContext).mergeOutcome, null);
  assert.deepEqual(
    boardCard(row({ runs: [run], stepOutput: { kind: "merge-result", body: merged, runId: "r1" } }), null, moveContext).mergeOutcome,
    { outcome: "merged", condition: null, incident: false },
  );
});

test("the projection drops the Run and Session columns the board never reads", () => {
  const card = boardCard(row({
    runs: [{
      id: "r1", runNumber: 3, status: "FAILED", model: "claude-opus-5", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null,
      readyAt: RUN_READY, startedAt: null, endedAt: new Date("2026-08-16T00:02:01Z"), lastProgressEventAt: new Date("2026-08-16T00:01:30Z"), maxRunsPerTask: 5,
      // The real row carries ~45 more columns; only these fields survive.
      session: session({ costUsd: "1.25", startedAt: new Date("2026-08-16T00:00:00Z"), endedAt: new Date("2026-08-16T00:02:00Z") }),
    }],
  }), null, moveContext);
  assert.deepEqual(card.latestRun, {
    id: "r1", runNumber: 3, status: "FAILED", model: "claude-opus-5", codexServiceTier: "DEFAULT", costUsd: "1.25",
    startedAt: new Date("2026-08-16T00:00:00Z"), endedAt: new Date("2026-08-16T00:02:00Z"), pullRequestUrl: null,
    phase: "finished", phaseSince: new Date("2026-08-16T00:02:00Z"),
    lastProgressEventAt: new Date("2026-08-16T00:01:30Z"), maxRunsPerTask: 5,
  });
  assert.equal(card.taskCost?.costUsd, "1.25");
});

test("the latest run carries its own claimed model, not the assignee's current one", () => {
  // The board card labels the run line with this; a re-tiered agent must not
  // relabel a run that already happened.
  const card = boardCard(row({
    assigneeAgent: { id: "a1", title: "merge-resolver-opus-medium", model: "gpt-5.6-sol:high", archivedAt: null },
    runs: [{ id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5:medium", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: null }],
  }), null, moveContext);
  assert.equal(card.latestRun?.model, "claude-opus-5:medium");
  assert.equal(card.assigneeAgent?.model, "gpt-5.6-sol:high");
});

test("the latest run carries its claimed Codex service tier", () => {
  const card = boardCard(row({ runs: [{
    id: "r1", runNumber: 1, status: "RUNNING", model: "gpt-5.6-sol:high", codexServiceTier: "FAST", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5,
    session: null,
  }] }), null, moveContext);
  assert.equal(card.latestRun?.codexServiceTier, "FAST");
});

/* ------------------------------------------------------------- the phase */

const PROVISIONED = new Date("2026-08-15T00:00:05.000Z");
const STARTED = new Date("2026-08-15T00:00:20.000Z");
const SESSION_ENDED = new Date("2026-08-15T00:04:00.000Z");
const CLEANUP_STARTED = new Date("2026-08-15T00:04:01.000Z");
const CLEANUP_ENDED = new Date("2026-08-15T00:04:04.000Z");

/** One run of a card, as the phase rule reads it. */
const phaseRun = (
  status: BoardRow["runs"][number]["status"],
  overrides: Partial<NonNullable<BoardRow["runs"][number]["session"]>> | null,
  runOverrides: Partial<BoardRow["runs"][number]> = {},
): BoardRow["runs"][number] => ({
  id: "r1", runNumber: 1, status, model: "claude-opus-5", codexServiceTier: "DEFAULT",
  budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null,
  readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5,
  session: overrides === null ? null : session(overrides),
  ...runOverrides,
});

const phaseOf = (run: BoardRow["runs"][number]): { phase: string; phaseSince: Date | null } => {
  const latest = boardCard(row({ runs: [run] }), null, moveContext).latestRun!;
  return { phase: latest.phase, phaseSince: latest.phaseSince };
};

test("every phase a run can be in is named, and dated from the timestamp that opened it", () => {
  // The queued phase starts when the run became claimable, which is the one
  // instant a run with no session at all can be dated from.
  assert.deepEqual(phaseOf(phaseRun("QUEUED", null)), { phase: "queued", phaseSince: RUN_READY });
  assert.deepEqual(
    phaseOf(phaseRun("PROVISIONING", { provisionedAt: PROVISIONED, executionStatus: "PROVISIONING" })),
    { phase: "provisioning", phaseSince: PROVISIONED },
  );
  assert.deepEqual(
    phaseOf(phaseRun("RUNNING", { provisionedAt: PROVISIONED, startedAt: STARTED, executionStatus: "RUNNING" })),
    { phase: "executing", phaseSince: STARTED },
  );
  // The current question dates this wait, independently of execution start.
  assert.deepEqual(
    phaseOf(phaseRun("WAITING_INBOX", { provisionedAt: PROVISIONED, startedAt: STARTED, executionStatus: "WAITING_INBOX", inboxWaitStartedAt: SESSION_ENDED })),
    { phase: "waiting-inbox", phaseSince: SESSION_ENDED },
  );
  // Cleanup outranks the run's own terminality: the control plane settles the
  // status while the runner is still disposing of the workspace.
  assert.deepEqual(
    phaseOf(phaseRun("SUCCEEDED", {
      provisionedAt: PROVISIONED, startedAt: STARTED, endedAt: SESSION_ENDED, cleanupStartedAt: CLEANUP_STARTED,
    })),
    { phase: "cleanup", phaseSince: CLEANUP_STARTED },
  );
  assert.deepEqual(
    phaseOf(phaseRun("SUCCEEDED", {
      provisionedAt: PROVISIONED, startedAt: STARTED, endedAt: SESSION_ENDED,
      cleanupStartedAt: CLEANUP_STARTED, cleanupEndedAt: CLEANUP_ENDED,
    })),
    { phase: "finished", phaseSince: CLEANUP_ENDED },
  );
});

test("readBoard dates current Inbox waits with one lookup of the exact question IDs", async () => {
  const rows = ["first", "second"].map((id) => row({ id, runs: [phaseRun("WAITING_INBOX", {
    startedAt: STARTED, executionStatus: "WAITING_INBOX", waitingOnMessageId: id,
  })] }));
  const { db } = boardReadDatabase({ rows });
  const lookups: unknown[] = [];
  Object.assign(db, { inboxMessage: { findMany: async (args: unknown) => {
    lookups.push(args);
    return [{ id: "first", createdAt: SESSION_ENDED }, { id: "second", createdAt: CLEANUP_STARTED }];
  } } });
  const cards = await readBoard(db, { projectId: "p1", archived: "false" });
  assert.deepEqual(lookups, [{ where: { id: { in: ["first", "second"] } }, select: { id: true, createdAt: true } }]);
  const wire = JSON.parse(JSON.stringify(cards));
  assert.equal(wire[0].latestRun.phaseSince, SESSION_ENDED.toISOString());
  assert.equal(wire[1].latestRun.phaseSince, CLEANUP_STARTED.toISOString());
  assert.equal(wire[0].latestRun.phase, "waiting-inbox");
});

test("chain lead time retains the failed first attempt from complete primary history", async () => {
  const firstStarted = new Date("2026-08-14T00:00:00.000Z");
  const failedEnded = new Date("2026-08-14T00:04:00.000Z");
  const failed = phaseRun("FAILED", { executionStatus: "FAILED", startedAt: new Date("2026-08-14T00:00:20.000Z"), endedAt: failedEnded },
    { id: "original", runNumber: 1, startedAt: firstStarted, endedAt: failedEnded });
  const retry = phaseRun("RUNNING", { executionStatus: "RUNNING", startedAt: STARTED }, { id: "retry", runNumber: 2, startedAt: RUN_READY });
  const primary = member({ runs: [retry, failed] });
  const result = chainAggregate("c1", "Release", [primary], []);
  assert.equal(result.firstRunStartedAt?.toISOString(), firstStarted.toISOString());
  assert.equal(result.frontier.latestRun?.id, "retry");
  assert.equal(chainAggregate("c1", "Release", [member()], []).firstRunStartedAt, null);
  const { db } = boardReadDatabase({ rows: [row({ id: "step-2", chainId: "c1", chainIndex: 1, runs: [retry] })], chainRows: [{ ...primary, archivedAt: SESSION_ENDED }] });
  const [card] = await readBoard(db, { projectId: "p1", archived: "false" });
  assert.equal(card?.chainAggregate?.firstRunStartedAt?.toISOString(), firstStarted.toISOString());
});

test("a settled run is finished whatever milestone its session stopped at", () => {
  // A FAILED run whose session never started is not still provisioning, and a
  // card counting time in a phase nothing will leave is a clock that never
  // stops. The instant is the most recent one the rows can prove.
  const failedAt = new Date("2026-08-15T00:00:30.000Z");
  assert.deepEqual(
    phaseOf(phaseRun("FAILED", { provisionedAt: PROVISIONED, executionStatus: "FAILED" }, { endedAt: failedAt })),
    { phase: "finished", phaseSince: failedAt },
  );
  assert.deepEqual(
    phaseOf(phaseRun("CANCELLED", null)),
    { phase: "finished", phaseSince: RUN_READY },
  );
});

test("a live run is dated from its phase start, not from the card being read", () => {
  // The card counts time in phase from this instant, so a run that has been
  // provisioning for ten minutes stops looking like one that has been
  // executing for ten minutes. `run-metrics.test.ts` proves the same helper
  // decides which phase the diagnostics measure to now.
  const live = phaseRun("RUNNING", { provisionedAt: PROVISIONED, startedAt: STARTED, executionStatus: "RUNNING" });
  assert.deepEqual(phaseOf(live), { phase: "executing", phaseSince: STARTED });
  const provisioning = phaseRun("PROVISIONING", { provisionedAt: PROVISIONED, executionStatus: "PROVISIONING" });
  assert.deepEqual(phaseOf(provisioning), { phase: "provisioning", phaseSince: PROVISIONED });
});

test("the card carries the run's last reported progress and its attempt ceiling", () => {
  // The stalled badge is measured from the same signal the runner's stall
  // timeout is, and the retry count is read against the ceiling the run was
  // born with rather than the task's configured budget of the moment.
  const progressAt = new Date("2026-08-15T00:03:00.000Z");
  const card = boardCard(row({ runs: [phaseRun(
    "RUNNING",
    { provisionedAt: PROVISIONED, startedAt: STARTED, executionStatus: "RUNNING" },
    { runNumber: 3, lastProgressEventAt: progressAt, maxRunsPerTask: 7 },
  )] }), null, moveContext);
  assert.deepEqual(card.latestRun?.lastProgressEventAt, progressAt);
  assert.equal(card.latestRun?.maxRunsPerTask, 7);
  // Unreported progress stays unknown; a card must not read it as "just now".
  assert.equal(boardCard(row({ runs: [phaseRun("QUEUED", null)] }), null, moveContext).latestRun?.lastProgressEventAt, null);
});

test("the latest run carries the pull request it published, and null when it published none", () => {
  // The card's footer links this; the board reads no other delivery column.
  const run = (pullRequestUrl: string | null) => ({
    id: "r1", runNumber: 1, status: "SUCCEEDED" as const, model: "gpt-5.6-sol:high",
    codexServiceTier: "DEFAULT" as const, budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl,
    pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: null,
  });
  assert.equal(
    boardCard(row({ runs: [run("https://github.com/o/r/pull/39")] }), null, moveContext).latestRun?.pullRequestUrl,
    "https://github.com/o/r/pull/39",
  );
  assert.equal(boardCard(row({ runs: [run(null)] }), null, moveContext).latestRun?.pullRequestUrl, null);
});

test("a task with no runs reports no latest run rather than an empty one", () => {
  assert.equal(boardCard(row(), null, moveContext).latestRun, null);
});

test("a run with no session reports a null cost, not a zero one", () => {
  // `0` would read as "this run spent nothing"; the runner simply never said.
  const card = boardCard(row({ runs: [{ id: "r1", runNumber: 1, status: "RUNNING", model: "gpt-5.6-sol", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: null }] }), null, moveContext);
  assert.equal(card.taskCost, null);
});

test("a Decimal cost is serialised as the string the web client reads", () => {
  // Prisma hands back a Decimal instance, not a string, and `JSON.stringify`
  // of one is `{"s":1,"e":0,...}` unless it is stringified on the way out.
  const decimal = new Prisma.Decimal("0.42");
  const card = boardCard(row({ runs: [{ id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: session({ costUsd: decimal }) }] }), null, moveContext);
  assert.equal(card.taskCost?.costUsd, "0.42");
  assert.equal(card.latestRun?.costUsd, "0.42");
  assert.match(JSON.stringify(card), /"costUsd":"0\.42"/);
});

test("task cost sums every run including failures and marks an estimated summand", () => {
  const card = boardCard(row({ runs: [
    { id: "r2", runNumber: 2, status: "SUCCEEDED", model: "gpt-5.6-luna:max", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: session({
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0,
    }) },
    { id: "r1", runNumber: 1, status: "FAILED", model: "claude-opus-5:high", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: session({ costUsd: "1.25" }) },
  ] }), null, moveContext);
  assert.deepEqual(card.latestRun, {
    id: "r2", runNumber: 2, status: "SUCCEEDED", model: "gpt-5.6-luna:max", codexServiceTier: "DEFAULT",
    costUsd: null, startedAt: null, endedAt: null, pullRequestUrl: null,
    phase: "finished", phaseSince: RUN_READY, lastProgressEventAt: null, maxRunsPerTask: 5,
  });
  assert.equal(card.taskCost?.costUsd, "1.45");
  assert.equal(card.taskCost?.estimated, true);
});

test("board cost preserves its estimate when cache creation is split from cached input", () => {
  const card = boardCard(row({ runs: [{
    id: "r1", runNumber: 1, status: "SUCCEEDED", model: "gpt-5.6-luna", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5,
    session: session({
      inputTokens: 160,
      cachedInputTokens: 100,
      cacheCreationInputTokens: 50,
      outputTokens: 10,
    }),
  }] }), null, moveContext);

  assert.equal(card.taskCost?.costUsd, "0.000017");
  assert.equal(card.taskCost?.estimated, true);
  assert.equal(card.taskCost?.cacheCreationInputTokens, 50);
});

test("an observed native-child Run is estimated at its own root model", () => {
  const cardFor = (model: string): ReturnType<typeof boardCard> => boardCard(row({ runs: [{
    id: "r1", runNumber: 1, status: "SUCCEEDED", model, codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5,
    subagentModel: "gpt-5.6-luna:max",
    session: session({ nativeChildUsed: true, inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000 }),
  }] }), null, moveContext);

  // 1M uncached input and 100k output: $5 + $3 at Sol, $10 + $5 at Astra.
  const sol = cardFor("gpt-5.6-sol:high");
  assert.equal(sol.taskCost?.costUsd, "8");
  assert.equal(sol.taskCost?.estimated, true);
  assert.equal(sol.taskCost?.inputTokens, 1_000_000);

  const astra = cardFor("gpt-6-astra:high");
  assert.equal(astra.taskCost?.costUsd, "15");
  assert.equal(astra.taskCost?.estimated, true);
});

test("the assignee carries the model spec the card shows", () => {
  const card = boardCard(row({ assigneeAgent: { id: "a1", title: "Frontend Developer", model: "gpt-5.6-sol:medium", archivedAt: null } }), null, moveContext);
  assert.deepEqual(card.assigneeAgent, { id: "a1", title: "Frontend Developer", model: "gpt-5.6-sol:medium" });
});

test("the card carries task ownership even when no agent is assigned", () => {
  assert.equal(boardCard(row({ assigneeType: "HUMAN", assigneeAgent: null }), null, moveContext).assigneeType, "HUMAN");
  assert.equal(boardCard(row({ assigneeType: "AGENT", assigneeAgent: null }), null, moveContext).assigneeType, "AGENT");
});

test("chain names are derived only from the exact persisted template-step suffix", () => {
  assert.equal(taskChainName(row({ chainId: "c1", name: "Release: Review", templateStep: { name: "Review" } })), "Release");
  assert.equal(taskChainName(row({ chainId: "c1", name: "Release: Review notes", templateStep: { name: "Review" } })), null);
  assert.equal(taskChainName(row({ chainId: null, name: "Release: Review", templateStep: { name: "Review" } })), null);
});

test("direct chains derive one verified shared display prefix without changing stored names", () => {
  const rows = [
    row({ id: "build", chainId: "direct", name: "Release: Build" }),
    row({ id: "review", chainId: "direct", name: "Release: Review" }),
  ];
  const display = chainDisplayByTask(rows);
  assert.deepEqual(display.get("build"), { chainName: "Release", displayName: "Build" });
  assert.deepEqual(display.get("review"), { chainName: "Release", displayName: "Review" });
  assert.equal(rows[0]!.name, "Release: Build");
  assert.deepEqual(boardCard(rows[0]!, null, moveContext, display.get("build")), {
    ...boardCard(rows[0]!, null, moveContext), chainName: "Release", displayName: "Build",
  });
});

test("a direct chain prefix is not guessed from one row or a partial match", () => {
  const displays = chainDisplayByTask([
    row({ id: "solo", chainId: "solo-chain", name: "Release: Build" }),
    row({ id: "a", chainId: "mixed", name: "Release: Build" }),
    row({ id: "b", chainId: "mixed", name: "Other: Review" }),
  ]);
  assert.deepEqual(displays.get("solo"), { chainName: null, displayName: "Release: Build" });
  assert.deepEqual(displays.get("a"), { chainName: null, displayName: "Release: Build" });
});

test("readBoard computes chainProgress from the complete chain lookup", async () => {
  const current = row({
    id: "current", chainId: "c1", chainIndex: 0, chainLayer: 0,
    name: "Release: Implementation", templateStep: { name: "Implementation" },
  });
  const { db } = boardReadDatabase({
    rows: [current],
    chainRows: [
      {
        id: current.id, projectId: current.projectId, chainId: "c1", chainIndex: 0, chainLayer: 0,
        status: current.status, name: current.name, archivedAt: null, templateStep: current.templateStep,
      },
      {
        id: "archived-review", projectId: current.projectId, chainId: "c1", chainIndex: 1, chainLayer: 1,
        status: "DONE", name: "Release: Review", archivedAt: new Date("2026-08-15T00:00:00Z"),
        templateStep: { name: "Review" },
      },
    ],
  });

  const cards = await readBoard(db, { projectId: "p1", archived: "false" });

  assert.deepEqual(cards[0]?.chainProgress, {
    chainId: "c1", done: 1, total: 2, activeStepName: "Implementation",
    activeStatus: "todo", currentLayer: 1, layerCount: 2, position: 1,
  });
});

test("readBoard carries one aggregate for visible chain members and repair", async () => {
  const regression = row({
    id: "regression", chainId: "c1", chainIndex: 0, chainLayer: 0,
    name: "Release: Regression", templateStep: { name: "Regression" }, status: "DONE",
  });
  const repair = row({ id: "repair", name: "Merge-tail repair", status: "TODO" });
  const { db } = boardReadDatabase({
    rows: [regression, repair],
    related: [{ id: regression.id, projectId: "p1", chainId: "c1" }],
    activities: [{ taskId: repair.id, metadata: {
      schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", regressionTaskId: regression.id,
    } }],
  });

  const cards = await readBoard(db, { projectId: "p1", archived: "false" });
  const primary = cards.find((card) => card.id === regression.id)!;
  const detachedRepair = cards.find((card) => card.id === repair.id)!;
  const projection = primary.chainAggregate ?? detachedRepair.chainAggregate;
  assert.ok(projection);
  assert.equal([primary, detachedRepair].filter((card) => card.chainAggregate !== null).length, 1);
  assert.equal(projection.stepCount, 1);
  assert.deepEqual(projection.statusCounts, { BACKLOG: 0, TODO: 0, DOING: 0, REVIEW: 0, DONE: 1 });
  assert.equal(projection.status, "TODO");
  assert.equal(detachedRepair.repairOf?.chainId, "c1");
  assert.equal(projection.frontier.taskId, repair.id);
  assert.equal(projection.detailTaskId, repair.id);
});

test("readBoard projects an active repair kind and latest Run without replacing the frontier", async () => {
  const startedAt = new Date("2026-08-16T00:00:00.000Z");
  const regression = row({
    id: "regression", chainId: "c1", chainIndex: 0, chainLayer: 0,
    name: "Release: Regression", templateStep: { name: "Regression" }, status: "REVIEW",
  });
  const repair = row({
    id: "repair", name: "Merge-tail repair", status: "TODO",
    runs: [{
      id: "repair-run", runNumber: 3, status: "RUNNING", model: "gpt-5.6-sol:high", codexServiceTier: "FAST",
      budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: session({ startedAt }),
    }],
  });
  const { db } = boardReadDatabase({
    rows: [regression, repair],
    related: [{ id: regression.id, projectId: "p1", chainId: "c1" }],
    activities: [{ taskId: repair.id, metadata: {
      schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", regressionTaskId: regression.id,
    } }],
  });

  const cards = await readBoard(db, { projectId: "p1", archived: "false" });
  const projection = cards.find((card) => card.id === regression.id)?.chainAggregate;
  assert.ok(projection);
  assert.equal(projection.frontier.taskId, regression.id);
  assert.deepEqual(projection.activeRepair, {
    repairKind: "gate-fix",
    latestRun: {
      id: "repair-run", runNumber: 3, status: "RUNNING", model: "gpt-5.6-sol:high", codexServiceTier: "FAST",
      costUsd: null, startedAt, endedAt: null, pullRequestUrl: null,
      phase: "executing", phaseSince: startedAt, lastProgressEventAt: null, maxRunsPerTask: 5,
    },
  });
});

test("readBoard does not resurrect a fully archived chain through a detached repair", async () => {
  const archivedAt = new Date("2026-08-15T00:00:00Z");
  const implementation = row({
    id: "implementation", chainId: "c1", chainIndex: 0, chainLayer: 0,
    name: "Release: Implementation", templateStep: { name: "Implementation" }, status: "DONE", archivedAt,
  });
  const regression = row({
    id: "regression", chainId: "c1", chainIndex: 1, chainLayer: 1,
    name: "Release: Regression", templateStep: { name: "Regression" }, status: "BACKLOG", archivedAt,
  });
  const repair = row({ id: "repair", name: "Merge-tail repair", status: "TODO" });
  const { db } = boardReadDatabase({
    rows: [repair],
    chainRows: [implementation, regression],
    related: [{ id: regression.id, projectId: "p1", chainId: "c1" }],
    activities: [{ taskId: repair.id, metadata: {
      schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", regressionTaskId: regression.id,
    } }],
  });

  const cards = await readBoard(db, { projectId: "p1", archived: "false" });

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.id, repair.id);
  assert.equal(cards[0]?.repairOf, null);
  assert.equal(cards[0]?.chainAggregate, null);
});

test("readBoard restores partly archived primary facts when only a detached repair is visible", async () => {
  const archivedAt = new Date("2026-08-15T00:00:00Z");
  const regression = row({
    id: "regression", chainId: "c1", chainIndex: 1, chainLayer: 1,
    name: "Release: Regression", templateStep: { name: "Regression" }, status: "DONE",
    runs: [{ id: "run-regression", runNumber: 1, status: "SUCCEEDED", model: "gpt-5.6-sol", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: session({ costUsd: "1.25" }) }],
  });
  const implementation = row({
    id: "implementation", chainId: "c1", chainIndex: 0, chainLayer: 0,
    name: "Release: Implementation", templateStep: { name: "Implementation" }, status: "DONE", archivedAt,
    runs: [{ id: "run-implementation", runNumber: 1, status: "SUCCEEDED", model: "gpt-5.6-sol", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: session({ costUsd: "0.75" }) }],
  });
  const repair = row({ id: "repair", name: "Merge-tail repair", status: "TODO" });
  const { db } = boardReadDatabase({
    rows: [repair, regression],
    chainRows: [implementation, regression],
    related: [{ id: regression.id, projectId: "p1", chainId: "c1" }],
    activities: [{ taskId: repair.id, metadata: {
      schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", regressionTaskId: regression.id,
    } }],
  });

  const cards = await readBoard(db, { projectId: "p1", archived: "false" });
  const repairCard = cards.find((card) => card.id === repair.id);
  const projection = repairCard?.chainAggregate;
  assert.ok(projection);
  assert.equal(repairCard.repairOf?.chainId, "c1");
  assert.equal(projection.stepCount, 2);
  assert.deepEqual(projection.statusCounts, { BACKLOG: 0, TODO: 0, DOING: 0, REVIEW: 0, DONE: 2 });
  assert.equal(projection.totalCost?.costUsd, "2");
  assert.equal(projection.frontier.taskId, repair.id);
  assert.equal(projection.detailTaskId, repair.id);
});

test("readBoard keeps an archived repair bound when its primary chain remains live", async () => {
  const archivedAt = new Date("2026-08-15T00:00:00Z");
  const implementation = row({
    id: "implementation", chainId: "c1", chainIndex: 0, chainLayer: 0,
    name: "Release: Implementation", templateStep: { name: "Implementation" }, status: "DONE",
    runs: [{ id: "run-implementation", runNumber: 1, status: "SUCCEEDED", model: "gpt-5.6-sol", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: session({ costUsd: "0.75" }) }],
  });
  const regression = row({
    id: "regression", chainId: "c1", chainIndex: 1, chainLayer: 1,
    name: "Release: Regression", templateStep: { name: "Regression" }, status: "TODO",
  });
  const repair = row({ id: "repair", name: "Merge-tail repair", status: "TODO", archivedAt });
  const { db } = boardReadDatabase({
    rows: [repair],
    chainRows: [implementation, regression],
    related: [{ id: regression.id, projectId: "p1", chainId: "c1" }],
    activities: [{ taskId: repair.id, metadata: {
      schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", regressionTaskId: regression.id,
    } }],
  });

  const [card] = await readBoard(db, { projectId: "p1", archived: "true" });

  assert.equal(card?.repairOf?.chainId, "c1");
  assert.equal(card?.chainAggregate?.stepCount, 2);
  assert.deepEqual(card?.chainAggregate?.statusCounts, { BACKLOG: 0, TODO: 1, DOING: 0, REVIEW: 0, DONE: 1 });
  assert.equal(card?.chainAggregate?.totalCost?.costUsd, "0.75");
});

test("readBoard does not invent a direct-chain name from a duplicated single row", async () => {
  const direct = row({ id: "solo", chainId: "direct", chainIndex: 0, name: "Release: Build" });
  const { db } = boardReadDatabase({ rows: [direct], chainRows: [direct] });

  const [card] = await readBoard(db, { projectId: "p1", archived: "false" });
  assert.equal(card?.chainName, null);
  assert.equal(card?.displayName, "Release: Build");
  assert.equal(card?.chainAggregate?.chainName, null);
});

test("the failure reason is carried in full, because Copy error hands it over", () => {
  const long = `${"/very/long/path/segment".repeat(80)} failed`;
  assert.equal(boardCard(row({ failureReason: long }), null, moveContext).failureReason, long);
});

test("a board card is an order of magnitude smaller than the row it projects", () => {
  // The measured board: 112 cards, 1,581,550 bytes of full rows. The acceptance
  // bar is a 250KB initial payload, so a card has ~2.2KB to spend and uses far
  // less than that whenever the task did not fail.
  const card = boardCard(row({
    assigneeAgent: { id: "cmsuawxym0000mpoyd5ga82sm", title: "Implementation Plan Executioner", model: "gpt-5.6-sol:medium", archivedAt: null },
    runs: [{ id: "cmsuawxym0001mpoyd5ga82sm", runNumber: 2, status: "SUCCEEDED", model: "claude-opus-5", codexServiceTier: "DEFAULT", budgetGrants: 0, leaseLossRefunds: 0, pullRequestUrl: null, pushedBranch: null, baseSha: null, readyAt: RUN_READY, startedAt: null, endedAt: null, lastProgressEventAt: null, maxRunsPerTask: 5, session: session({ costUsd: "0.42" }) }],
  }), null, moveContext);
  // The card carries both cost surfaces — the latest run's own cost and the
  // cross-run task total, ownership and the creation timestamp used for queue
  // order — plus the three merge-tail counters (lease-loss refunds, readiness
  // requeues and the grants they funded) and the run's phase, when it entered
  // it, its last reported progress and its attempt ceiling, so the clean-card
  // bound remains at roughly half the ~2.2KB acceptance budget even with
  // executable move targets.
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 1_300, "a clean card must stay well inside its budget");
});

/* --------------------------------------------------------------- the ETag */

test("the ETag is weak and stable for identical bytes", () => {
  const tag = etagFor('[{"id":"t1"}]');
  assert.match(tag, /^W\/"[A-Za-z0-9_-]+"$/);
  assert.equal(tag, etagFor('[{"id":"t1"}]'));
  assert.notEqual(tag, etagFor('[{"id":"t2"}]'));
});

test("If-None-Match matches a list, a lone tag and the wildcard", () => {
  const tag = etagFor("[]");
  assert.equal(etagMatches(tag, tag), true);
  assert.equal(etagMatches(`W/"stale", ${tag}`, tag), true);
  assert.equal(etagMatches("*", tag), true);
  assert.equal(etagMatches('W/"stale"', tag), false);
  assert.equal(etagMatches(undefined, tag), false);
  assert.equal(etagMatches("", tag), false);
});
