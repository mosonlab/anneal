import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@prisma/client";

import type { BoardCard, TaskDetail, TaskList } from "./board-contract.js";
import type { JsonSerialized, SerializesTo } from "./wire-serialization.js";

/** A contract written the way the shared ones are: wire forms by default, and
 *  the native forms supplied by the projecting route. */
type Report<DateTime = string, DecimalValue = string> = {
  id: string;
  startedAt: DateTime | null;
  usd: DecimalValue;
  tags: string[];
  nested: { at: DateTime };
};

type NativeReport = Report<Date, Prisma.Decimal>;

const nativeReport = (): NativeReport => ({
  id: "run-1",
  startedAt: new Date(0),
  usd: new Prisma.Decimal("1.25"),
  tags: ["merge"],
  nested: { at: new Date(0) },
});

const wireReport: Report = {
  id: "run-1",
  startedAt: "1970-01-01T00:00:00.000Z",
  usd: "1.25",
  tags: ["merge"],
  nested: { at: "1970-01-01T00:00:00.000Z" },
};

test("the serialized form the proof claims is the one JSON.stringify produces", () => {
  const projection = nativeReport() satisfies SerializesTo<NativeReport, Report>;
  const serialized: JsonSerialized<NativeReport> = JSON.parse(JSON.stringify(projection));
  assert.deepEqual(serialized, wireReport);
});

test("a contract that still declares a Decimal is refused", () => {
  type DecimalContract = Omit<Report, "usd"> & { usd: Prisma.Decimal };
  // @ts-expect-error the projected Decimal reaches the browser as a string, never as a Decimal.
  const projection = nativeReport() satisfies SerializesTo<NativeReport, DecimalContract>;
  assert.equal(projection.usd.toString(), "1.25");
});

test("a nested Date the contract leaves unserialized is refused", () => {
  type NestedDateContract = Omit<Report, "nested"> & { nested: { at: Date } };
  // @ts-expect-error the nested Date reaches the browser as an ISO string.
  const projection = nativeReport() satisfies SerializesTo<NativeReport, NestedDateContract>;
  assert.equal(projection.nested.at.getTime(), 0);
});

test("a key the contract does not name is refused", () => {
  type SurplusReport = NativeReport & { internalRowVersion: number };
  const surplus: SurplusReport = { ...nativeReport(), internalRowVersion: 3 };
  // @ts-expect-error the projection carries a key no browser contract names.
  const projection = surplus satisfies SerializesTo<SurplusReport, Report>;
  assert.equal(projection.internalRowVersion, 3);
});

test("a key the contract names and the projection drops is refused", () => {
  type PartialReport = Omit<NativeReport, "tags">;
  const { tags, ...withoutTags } = nativeReport();
  assert.deepEqual(tags, ["merge"]);
  // @ts-expect-error the contract names `tags` and the projection never emits it.
  const projection = withoutTags satisfies SerializesTo<PartialReport, Report>;
  assert.equal(projection.id, "run-1");
});

test("a key the projection makes optional and the contract requires is refused", () => {
  type OptionalTagsReport = Omit<NativeReport, "tags"> & { tags?: string[] };
  const optional: OptionalTagsReport = nativeReport();
  // @ts-expect-error an absent key is not the same wire shape as a present one,
  // which is why the proof compares type identity and not assignability.
  const projection = optional satisfies SerializesTo<OptionalTagsReport, Report>;
  assert.deepEqual(projection.tags, ["merge"]);
});

const strandedSalvageBranches = [{
  branch: "agentos/task-1/run-2",
  lostRunNumber: 2,
}];

const projectionDate = new Date("2026-09-02T12:00:00.000Z");

type NativeBoardCard = BoardCard<Date>;
type NativeTaskList = TaskList<Date, Prisma.Decimal>;
type NativeTaskDetail = TaskDetail<Date, Prisma.Decimal>;

const nativeBoardCard = (): NativeBoardCard => ({
  id: "task-1",
  baseline: null,
  name: "Repair the board",
  displayName: "Repair the board",
  status: "TODO",
  moveTargets: [],
  assigneeType: "HUMAN",
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
  blockedOn: null,
  createdAt: projectionDate,
  updatedAt: projectionDate,
  assigneeAgent: null,
  chainProgress: null,
  latestRun: null,
  strandedSalvageBranches,
  taskCost: null,
  mergeOutcome: null,
  repairOf: null,
  budgetRemaining: true,
  leaseLossRefunds: 0,
  chainAggregate: null,
  readinessRequeues: 0,
  readinessGrants: 0,
});

const nativeRun: NativeTaskList["runs"][number] = {
  id: "run-2",
  projectId: "project-1",
  taskId: "task-1",
  goalId: null,
  agentId: "agent-1",
  repoId: null,
  runNumber: 2,
  status: "LOST",
  runner: "CODEX",
  runnerId: null,
  model: "gpt-5.6-sol",
  codexServiceTier: "DEFAULT",
  subagentModel: null,
  subagentMaxConcurrent: null,
  leaseGeneration: 1,
  cancelRequestId: null,
  cancelReason: null,
  cancelRequestedAt: null,
  cancelAcknowledgedAt: null,
  workspacePath: null,
  workspaceRetained: false,
  targetBranch: null,
  branch: null,
  baseSha: null,
  headSha: null,
  pushStatus: "NOT_REQUESTED",
  pullRequestUrl: null,
  maxDurationMin: 30,
  stallTimeoutMin: 10,
  maxRunsPerTask: 3,
  failureClass: null,
  failureReason: null,
  retryable: null,
  retryAt: null,
  terminationReason: null,
  queuedAt: projectionDate,
  claimedAt: null,
  startedAt: null,
  endedAt: null,
  session: null,
  mergeOutcome: null,
  mergeRecovery: null,
};

const nativeTaskBase = {
  id: "task-1",
  projectId: "project-1",
  assigneeAgentId: null,
  repoId: null,
  templateId: null,
  templateStepId: null,
  name: "Repair the board",
  description: "Keep the durable salvage visible.",
  workingDirectory: null,
  targetBranch: null,
  failureReason: null,
  status: "TODO",
  assigneeType: "HUMAN",
  executionOwner: "human",
  approvalGate: false,
  scheduleKind: "NOW",
  runAt: null,
  cron: null,
  timezone: null,
  maxDurationMin: 30,
  stallTimeoutMin: 10,
  maxSessionsPerTask: 3,
  createdAt: projectionDate,
  updatedAt: projectionDate,
  assigneeAgent: null,
  repo: null,
  runs: [nativeRun],
  strandedSalvageBranches,
  chainId: null,
  chainIndex: null,
  source: "MANUAL",
  archivedAt: null,
  schedulePausedAt: null,
  recurringSourceTaskId: null,
  templateStep: null,
} satisfies Omit<NativeTaskList, "chainProgress" | "baseline" | "recurringLastFiredAt" | "recurringFireCount">;

const nativeTaskList = (): NativeTaskList => ({
  ...nativeTaskBase,
  chainProgress: null,
  baseline: null,
  recurringLastFiredAt: null,
  recurringFireCount: 0,
});

const nativeTaskDetail = (): NativeTaskDetail => ({
  ...nativeTaskBase,
  baseline: null,
  moveTargets: [],
  taskCost: null,
  mergeOutcome: null,
  mergeRecovery: null,
  budgetRemaining: true,
  editableBrief: null,
});

test("native board, task-list, and task-detail salvage fields serialize to the browser shape", () => {
  const boardProjection = nativeBoardCard() satisfies SerializesTo<NativeBoardCard, BoardCard>;
  const serializedBoard: JsonSerialized<NativeBoardCard> = JSON.parse(JSON.stringify(boardProjection));
  assert.equal(serializedBoard.createdAt, projectionDate.toISOString());
  assert.deepEqual(serializedBoard.strandedSalvageBranches, strandedSalvageBranches);

  const taskListProjection = nativeTaskList() satisfies SerializesTo<NativeTaskList, TaskList>;
  const serializedTaskList: JsonSerialized<NativeTaskList> = JSON.parse(JSON.stringify(taskListProjection));
  assert.equal(serializedTaskList.createdAt, projectionDate.toISOString());
  assert.deepEqual(serializedTaskList.strandedSalvageBranches, strandedSalvageBranches);

  const taskDetailProjection = nativeTaskDetail() satisfies SerializesTo<NativeTaskDetail, TaskDetail>;
  const serializedTaskDetail: JsonSerialized<NativeTaskDetail> = JSON.parse(JSON.stringify(taskDetailProjection));
  assert.equal(serializedTaskDetail.createdAt, projectionDate.toISOString());
  assert.deepEqual(serializedTaskDetail.strandedSalvageBranches, strandedSalvageBranches);
});
