import assert from "node:assert/strict";
import test from "node:test";

import { type Prisma } from "@anneal/db";

import {
  noticeMergeTrainAbort,
  settleMergeTrainFailure,
  type MergeTrainRepairDependencies,
} from "./merge-train-repair.js";

const HEAD = "a".repeat(40);
const PREFIX = "b".repeat(40);

const regressionTask = {
  id: "regression-task",
  projectId: "project-1",
  repoId: "repo-1",
  templateId: "template-1",
  chainId: "chain-1",
  chainIndex: 5,
  targetBranch: "main",
  assigneeAgentId: "regression-agent",
  templateStep: {
    stepIndex: 5,
    outputKind: "regression-verification-v2",
    taskTemplate: { name: "direct-engineer-workflow" },
  },
};

const sourceRun = {
  id: "regression-run",
  taskId: regressionTask.id,
  agentId: "regression-agent",
  branch: "feat/chain-1",
  headSha: HEAD,
  session: { id: "regression-session" },
};

const makeTx = (markerTaskId: string | null = "repair-task") => ({
  task: {
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => (
      where.id === regressionTask.id
        ? regressionTask
        : {
          id: "readiness-task",
          projectId: regressionTask.projectId,
          chainId: regressionTask.chainId,
          assigneeAgentId: "readiness-agent",
        }
    ),
    findFirst: async () => ({ id: regressionTask.id, assigneeAgentId: regressionTask.assigneeAgentId }),
    update: async () => ({}),
  },
  taskStepOutput: { findUnique: async () => ({ runId: sourceRun.id }) },
  run: {
    findUnique: async () => sourceRun,
    findFirst: async () => sourceRun,
  },
  taskActivity: {
    findFirst: (() => {
      let reads = 0;
      return async () => {
        reads += 1;
        return reads === 1 || markerTaskId === null
          ? null
          : { metadata: { repairTaskId: markerTaskId } };
      };
    })(),
    create: async () => ({}),
  },
} as unknown as Prisma.TransactionClient);

test("a train gate failure delegates the candidate to the existing gate-fix path", async () => {
  const calls: { verdict?: Record<string, unknown>; notice?: Record<string, unknown> } = {};
  const dependencies: MergeTrainRepairDependencies = {
    handleRegression: async (_tx, input) => {
      calls.verdict = input.qualifiedVerdict as unknown as Record<string, unknown>;
      return "handled";
    },
    stopTail: async () => assert.fail("a source Run is available"),
    openStopNotice: async (_tx, input) => { calls.notice = input; },
  };

  const result = await settleMergeTrainFailure(makeTx(), {
    regressionTaskId: regressionTask.id,
    readinessTaskId: "readiness-task",
    headSha: HEAD,
    predecessorOid: PREFIX,
    trainTaskId: "train-task",
    now: new Date("2026-09-07T00:00:00Z"),
    kind: "fail",
    gateExcerpt: "MERGE GATE: FAIL (test failure)",
  }, dependencies);

  assert.deepEqual(result, { kind: "repair-opened", repairTaskId: "repair-task" });
  assert.equal(calls.verdict?.outcome, "gate-fail");
  assert.equal(calls.verdict?.headSha, HEAD);
  assert.equal(calls.verdict?.baseHeadSha, PREFIX);
  assert.equal(calls.verdict?.gateFailureExcerpt, "MERGE GATE: FAIL (test failure)");
  assert.match(String(calls.notice?.reason), /train-task/u);
});

test("a blocked train candidate uses the existing readiness stop path", async () => {
  let stopInput: Record<string, unknown> | undefined;
  const dependencies: MergeTrainRepairDependencies = {
    handleRegression: async () => assert.fail("blocked candidates do not open a repair"),
    stopTail: (async (_tx, input) => {
      stopInput = input as unknown as Record<string, unknown>;
      return { leaseOutcome: { kind: "stop", taskId: regressionTask.id } };
    }) as MergeTrainRepairDependencies["stopTail"],
    openStopNotice: async () => assert.fail("readiness stop owns the notice"),
  };

  const result = await settleMergeTrainFailure(makeTx(), {
    regressionTaskId: regressionTask.id,
    readinessTaskId: "readiness-task",
    headSha: HEAD,
    predecessorOid: PREFIX,
    trainTaskId: "train-task",
    now: new Date("2026-09-07T00:00:00Z"),
    kind: "blocked",
    reason: "runtime could not inspect candidate",
  }, dependencies);

  assert.equal(result.kind, "stopped");
  assert.equal(stopInput?.phase, "readiness");
  assert.match(String(stopInput?.reason), /runtime could not inspect candidate/u);
});

test("an aborted train writes one stop notice for the candidate", async () => {
  let notice: Record<string, unknown> | undefined;
  await noticeMergeTrainAbort(makeTx(null), {
    readinessTaskId: "readiness-task",
    trainTaskId: "train-task",
    reason: "train Run was lost",
    now: new Date("2026-09-07T00:00:00Z"),
  }, {
    openStopNotice: async (_tx, input) => { notice = input; },
  });

  assert.equal(notice?.taskId, regressionTask.id);
  assert.equal(notice?.agentId, regressionTask.assigneeAgentId);
  assert.match(String(notice?.reason), /train Run was lost/u);
});
