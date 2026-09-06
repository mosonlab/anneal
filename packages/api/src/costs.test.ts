import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, RunStatus, TaskStatus } from "@anneal/db";

import { aggregateCosts, costsWindowEnd, costsWindowStart, type CostsRunRow } from "./costs.js";

const row = (overrides: Partial<CostsRunRow> & Pick<CostsRunRow, "id" | "model" | "status">): CostsRunRow => {
  const { id, model, status, ...rest } = overrides;
  return {
    id,
    model,
    status,
    subagentModel: null,
    startedAt: new Date("2026-08-28T12:00:00.000Z"),
    agent: { id: "dev-id", name: "dev" },
    task: null,
    session: {
      nativeChildUsed: false,
      costUsd: new Prisma.Decimal(1),
      inputTokens: null,
      cachedInputTokens: null,
      cacheCreationInputTokens: 0,
      outputTokens: null,
    },
    ...rest,
  };
};

const aggregateWindow = (runs: CostsRunRow[]) => aggregateCosts(
  runs,
  new Date("2026-08-28T00:00:00.000Z"),
  1,
  "UTC",
  { tasks: [], runs, until: new Date("2026-08-29T00:00:00.000Z") },
);

test("timezone windows use local midnight and retain one local date across DST", () => {
  const now = new Date("2026-03-08T18:00:00.000Z");
  assert.equal(costsWindowStart(now, 1, "America/Los_Angeles").toISOString(), "2026-03-08T08:00:00.000Z");
  assert.equal(costsWindowEnd(now, "America/Los_Angeles").toISOString(), "2026-03-09T07:00:00.000Z");
});

test("timezone windows start at the first valid instant when local midnight is skipped", () => {
  const now = new Date("2020-09-06T12:00:00.000Z");
  assert.equal(costsWindowStart(now, 1, "America/Santiago").toISOString(), "2020-09-06T04:00:00.000Z");
  assert.equal(costsWindowEnd(now, "America/Santiago").toISOString(), "2020-09-07T03:00:00.000Z");
});

test("aggregateCosts preserves root model identity for native-child runs and reconciles spend", () => {
  const runs = [
    row({
      id: "success", model: "openai-codex/gpt-5.6-luna:max", status: RunStatus.SUCCEEDED,
      session: {
        nativeChildUsed: false, costUsd: new Prisma.Decimal(5),
        inputTokens: 1_000, cachedInputTokens: 250, cacheCreationInputTokens: 0, outputTokens: 10,
      },
    }),
    row({
      id: "failed", model: "claude-opus-5:high", status: RunStatus.FAILED,
      session: {
        nativeChildUsed: false, costUsd: new Prisma.Decimal(2),
        inputTokens: 3_000, cachedInputTokens: 750, cacheCreationInputTokens: 0, outputTokens: 20,
      },
    }),
    row({
      id: "mixed", model: "openai-codex/gpt-5.6-sol:max", status: RunStatus.CANCELLED,
      session: {
        nativeChildUsed: true, costUsd: new Prisma.Decimal(3),
        inputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: 0, outputTokens: null,
      },
    }),
    row({
      id: "mixed-astra", model: "openai-codex/gpt-6-astra:high", status: RunStatus.SUCCEEDED,
      session: {
        nativeChildUsed: true, costUsd: null,
        inputTokens: 1_000_000, cachedInputTokens: 250_000, cacheCreationInputTokens: 0, outputTokens: 100_000,
      },
    }),
    row({
      id: "unpriced", model: "openai-codex/gpt-5.6-luna:max", status: RunStatus.LOST,
      agent: { id: "review-id", name: "reviewer" },
      session: {
        nativeChildUsed: false, costUsd: null,
        inputTokens: 100, cachedInputTokens: null, cacheCreationInputTokens: 0, outputTokens: null,
      },
    }),
  ];

  const report = aggregateWindow(runs);

  assert.ok(report.since instanceof Date);
  assert.deepEqual(report.byModel.map(({ model, usd, runs, costUnavailableRuns }) => ({
    model, usd: usd.toString(), runs, costUnavailableRuns,
  })), [
    // Astra: 750k * $10/M + 250k * $1/M + 100k * $50/M = $12.75.
    { model: "openai-codex/gpt-6-astra:high", usd: "12.75", runs: 1, costUnavailableRuns: 0 },
    { model: "openai-codex/gpt-5.6-luna:max", usd: "5", runs: 2, costUnavailableRuns: 1 },
    { model: "openai-codex/gpt-5.6-sol:max", usd: "3", runs: 1, costUnavailableRuns: 0 },
    { model: "claude-opus-5:high", usd: "2", runs: 1, costUnavailableRuns: 0 },
  ]);
  assert.equal(report.byModel.reduce((sum, entry) => sum + Number(entry.usd), 0), Number(report.totalUsd));
  assert.equal(report.totalUsd.toString(), "22.75");

  const dev = report.byAgent.find((entry) => entry.agent === "dev");
  const reviewer = report.byAgent.find((entry) => entry.agent === "reviewer");
  assert.equal(dev?.cachePct, 25);
  assert.equal(reviewer?.cachePct, null);
  assert.equal(dev?.wastedUsd.toString(), "5");
  assert.equal(reviewer?.wastedUsd.toString(), "0");
  assert.equal(report.wastedUsd.toString(), "5");
});

test("aggregateCosts reconciles by-model rounding with the serialized total", () => {
  const runs = [
    row({
      id: "model-a", model: "gpt-5.6-sol:high", status: RunStatus.SUCCEEDED,
      session: {
        nativeChildUsed: false, costUsd: null,
        inputTokens: 13, cachedInputTokens: 13, cacheCreationInputTokens: 0, outputTokens: 0,
      },
    }),
    row({
      id: "model-b", model: "gpt-5.6-sol:max", status: RunStatus.SUCCEEDED,
      session: {
        nativeChildUsed: false, costUsd: null,
        inputTokens: 13, cachedInputTokens: 13, cacheCreationInputTokens: 0, outputTokens: 0,
      },
    }),
  ];

  const report = aggregateWindow(runs);

  assert.equal(report.totalUsd.toString(), "0.000013");
  assert.deepEqual(report.byModel.map(({ model, usd }) => ({ model, usd: usd.toString() })), [
    { model: "gpt-5.6-sol:high", usd: "0.000007" },
    { model: "gpt-5.6-sol:max", usd: "0.000006" },
  ]);
  assert.equal(
    report.byModel.reduce((sum, entry) => sum.plus(entry.usd), new Prisma.Decimal(0)).toString(),
    report.totalUsd.toString(),
  );
});

test("cache metrics count reads only and retain unknown split runs separately", () => {
  const runs = [
      row({
        id: "known", model: "gpt-5.6-luna", status: RunStatus.SUCCEEDED,
        session: {
          nativeChildUsed: false, costUsd: new Prisma.Decimal(1),
          inputTokens: 160, cachedInputTokens: 100, cacheCreationInputTokens: 50, outputTokens: 10,
        },
      }),
      row({
        id: "unknown", model: "gpt-5.6-luna", status: RunStatus.SUCCEEDED,
        session: {
          nativeChildUsed: false, costUsd: new Prisma.Decimal(1),
          inputTokens: 160, cachedInputTokens: 100, cacheCreationInputTokens: null, outputTokens: 10,
        },
      }),
    ];
  const report = aggregateWindow(runs);
  assert.deepEqual(report.byAgent[0], {
    agent: "dev",
    usd: new Prisma.Decimal(2),
    runs: 2,
    costUnavailableRuns: 0,
    avgUsd: new Prisma.Decimal(1),
    cachePct: 62.5,
    cacheUnknownRuns: 1,
    uncachedInputTokens: 10,
    uncachedInputUsd: new Prisma.Decimal("0.000002"),
    wastedUsd: new Prisma.Decimal(0),
  });
});

test("waste separates operator cancellation from failed failure classes", () => {
  const report = aggregateWindow([
    row({ id: "cancelled", model: "gpt-5.6-luna", status: RunStatus.CANCELLED, cancelRequestId: "cancel-1", session: { nativeChildUsed: false, costUsd: new Prisma.Decimal(1), inputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: 0, outputTokens: null } }),
    row({ id: "environment", model: "gpt-5.6-luna", status: RunStatus.FAILED, failureClass: "ENVIRONMENT", session: { nativeChildUsed: false, costUsd: new Prisma.Decimal(2), inputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: 0, outputTokens: null } }),
    row({ id: "provider", model: "gpt-5.6-luna", status: RunStatus.TIMED_OUT, failureClass: "PROVIDER", session: { nativeChildUsed: false, costUsd: new Prisma.Decimal(3), inputTokens: null, cachedInputTokens: null, cacheCreationInputTokens: 0, outputTokens: null } }),
  ]);
  assert.equal(report.wastedUsd.toString(), "6");
  assert.equal(report.waste.totalUsd.toString(), "6");
  assert.equal(report.waste.operatorCancelledUsd.toString(), "1");
  assert.equal(report.waste.failedUsd.toString(), "5");
  assert.deepEqual(report.waste.byFailureClass.map((entry) => [entry.failureClass, entry.usd.toString(), entry.runs]), [
    ["ENVIRONMENT", "2", 1],
    ["PROVIDER", "3", 1],
  ]);
});

test("uncached input dollars use the model input rate and stay unknown for absent models", () => {
  const report = aggregateWindow([
      row({
        id: "claude", model: "claude-opus-5:high", status: RunStatus.SUCCEEDED,
        session: {
          nativeChildUsed: false, costUsd: new Prisma.Decimal(1),
          inputTokens: 160, cachedInputTokens: 100, cacheCreationInputTokens: 50, outputTokens: 10,
        },
      }),
      row({
        id: "unlisted", model: "model-not-in-table", status: RunStatus.SUCCEEDED,
        agent: { id: "unlisted-id", name: "unlisted" },
        session: {
          nativeChildUsed: false, costUsd: new Prisma.Decimal(1),
          inputTokens: 160, cachedInputTokens: 100, cacheCreationInputTokens: 50, outputTokens: 10,
        },
      }),
  ]);

  const claude = report.byAgent.find((entry) => entry.agent === "dev");
  const unlisted = report.byAgent.find((entry) => entry.agent === "unlisted");
  assert.equal(claude?.uncachedInputUsd?.toString(), "0.00005");
  assert.equal(unlisted?.uncachedInputUsd, null);
});

const chainTask = (
  id: string,
  index: number,
  outputKind: string,
  name: string,
  readiness: { readinessRequeues: number; readinessGrants: number } = { readinessRequeues: 0, readinessGrants: 0 },
): import("./costs.js").CostsTaskRow => ({
  id,
  projectId: "project",
  name,
  status: "DONE",
  chainId: "chain",
  chainIndex: index,
  chainLayer: index,
  templateStep: { name: name.split(": ").at(-1)!, outputKind },
  ...readiness,
});

const chainRun = (
  id: string,
  task: import("./costs.js").CostsTaskRow,
  startedAt: string,
  endedAt: string,
  cost: string,
  status: RunStatus = RunStatus.SUCCEEDED,
): CostsRunRow => ({
  id,
  taskId: task.id,
  model: "gpt-5.6-luna",
  status,
  subagentModel: null,
  startedAt: new Date(startedAt),
  endedAt: new Date(endedAt),
  agent: { id: "dev-id", name: "dev" },
  task,
  session: {
    nativeChildUsed: false,
    costUsd: new Prisma.Decimal(cost),
    inputTokens: null,
    cachedInputTokens: null,
    cacheCreationInputTokens: 0,
    outputTokens: null,
  },
});

test("chains include retries and bound repairs, partition cost by step role, and expose the widest idle gap", () => {
  const implementation = chainTask("task-1", 0, "implementation", "Release: Implement");
  const documentation = chainTask("task-2", 1, "documentation", "Release: Document");
  const regression = chainTask("task-3", 2, "regression-verification-v2", "Release: Verify");
  const repair: import("./costs.js").CostsTaskRow = {
    id: "repair", projectId: "project", name: "Autonomous merge tail: gate-fix", status: "DONE",
    chainId: null, chainIndex: null, chainLayer: null, repairKind: "gate-fix", repairChainId: "chain", templateStep: null,
    readinessRequeues: 0, readinessGrants: 0,
  };
  const runs = [
    chainRun("run-1", implementation, "2026-08-01T00:00:00.000Z", "2026-08-01T00:05:00.000Z", "1", RunStatus.FAILED),
    chainRun("run-2", implementation, "2026-08-01T00:06:00.000Z", "2026-08-01T00:10:00.000Z", "2"),
    chainRun("run-3", documentation, "2026-08-01T01:00:00.000Z", "2026-08-01T01:05:00.000Z", "3"),
    chainRun("run-4", regression, "2026-08-01T01:07:00.000Z", "2026-08-01T01:10:00.000Z", "4"),
    chainRun("run-5", repair, "2026-08-02T00:00:00.000Z", "2026-08-02T00:05:00.000Z", "5"),
  ];
  const report = aggregateCosts(
    runs,
    new Date("2026-08-01T00:00:00.000Z"),
    30,
    "UTC",
    { tasks: [implementation, documentation, regression, repair], runs, until: new Date("2026-08-31T00:00:00.000Z") },
  );
  assert.equal(report.chains.length, 1);
  const [chain] = report.chains;
  assert.ok(chain);
  assert.equal(chain.detailTaskId, "task-1");
  assert.equal(chain.taskCount, 3);
  assert.equal(chain.leadMinutes, 1445);
  assert.equal(chain.busyMinutes, 22);
  assert.equal(chain.repairs.gateFix, 1);
  assert.equal(chain.longestGap.beforeTaskName, "Autonomous merge tail: gate-fix");
  assert.deepEqual(Object.fromEntries(Object.entries(chain.costByRole).map(([role, usd]) => [role, usd.toString()])), {
    documentation: "3", implementation: "3", regression: "4", repair: "5",
  });
  assert.equal(chain.costUsd?.toString(), "15");
});

test("chains sum the pre-authorization readiness requeues their members recorded", () => {
  // Only the readiness Step records a requeue, so the chain total is that
  // Step's; the assertion is here rather than on the Step so a future second
  // recording site cannot silently stop being attributed to the chain.
  const regression = chainTask("task-regression", 0, "regression-verification-v2", "Release: Verify");
  const readiness = chainTask("task-readiness", 1, "merge-authorization", "Release: Authorize", {
    readinessRequeues: 2,
    readinessGrants: 2,
  });
  const runs = [
    chainRun("run-1", regression, "2026-08-01T00:00:00.000Z", "2026-08-01T00:05:00.000Z", "1"),
    chainRun("run-2", readiness, "2026-08-01T00:06:00.000Z", "2026-08-01T00:10:00.000Z", "2"),
  ];
  const report = aggregateCosts(
    runs,
    new Date("2026-08-01T00:00:00.000Z"),
    30,
    "UTC",
    { tasks: [regression, readiness], runs, until: new Date("2026-08-31T00:00:00.000Z") },
  );
  const [chain] = report.chains;
  assert.ok(chain);
  assert.equal(chain.readinessRequeues, 2);
  assert.equal(chain.readinessGrants, 2);
});

test("a chain that never requeued reports no readiness requeues", () => {
  const implementation = chainTask("task-quiet", 0, "implementation", "Quiet: Implement");
  const runs = [chainRun("run-quiet", implementation, "2026-08-01T00:00:00.000Z", "2026-08-01T00:05:00.000Z", "1")];
  const report = aggregateCosts(
    runs,
    new Date("2026-08-01T00:00:00.000Z"),
    30,
    "UTC",
    { tasks: [implementation], runs, until: new Date("2026-08-31T00:00:00.000Z") },
  );
  const [chain] = report.chains;
  assert.ok(chain);
  assert.equal(chain.readinessRequeues, 0);
  assert.equal(chain.readinessGrants, 0);
});

test("chains retain priced spend when another run is unavailable", () => {
  const implementation = chainTask("task-priced", 0, "implementation", "Release: Implement");
  const regression = chainTask("task-unpriced", 1, "regression-verification", "Release: Verify");
  const priced = chainRun(
    "run-priced", implementation,
    "2026-08-01T00:00:00.000Z", "2026-08-01T00:05:00.000Z", "2",
  );
  const unavailable: CostsRunRow = {
    ...chainRun(
      "run-unavailable", regression,
      "2026-08-01T00:06:00.000Z", "2026-08-01T00:10:00.000Z", "0",
    ),
    session: null,
  };
  const report = aggregateCosts(
    [priced, unavailable],
    new Date("2026-08-01T00:00:00.000Z"),
    30,
    "UTC",
    {
      tasks: [implementation, regression],
      runs: [priced, unavailable],
      until: new Date("2026-08-31T00:00:00.000Z"),
    },
  );
  const [chain] = report.chains;
  assert.ok(chain);
  assert.equal(chain.costUsd?.toString(), "2");
  assert.equal(chain.costByRole.implementation?.toString(), "2");
  assert.equal(chain.costByRole.regression?.toString(), "0");
  assert.equal(chain.costUnavailableRuns, 1);
});

test("overlapping chain runs do not manufacture idle time", () => {
  const first = chainTask("overlap-1", 0, "implementation", "Overlap: First");
  const parallel = chainTask("overlap-2", 1, "documentation", "Overlap: Parallel");
  const after = chainTask("overlap-3", 2, "regression-verification", "Overlap: After");
  const runs = [
    chainRun("overlap-run-1", first, "2026-08-01T00:00:00.000Z", "2026-08-01T02:00:00.000Z", "1"),
    chainRun("overlap-run-2", parallel, "2026-08-01T00:10:00.000Z", "2026-08-01T00:20:00.000Z", "1"),
    chainRun("overlap-run-3", after, "2026-08-01T02:10:00.000Z", "2026-08-01T02:20:00.000Z", "1"),
  ];
  const report = aggregateCosts(
    runs,
    new Date("2026-08-01T00:00:00.000Z"),
    30,
    "UTC",
    { tasks: [first, parallel, after], runs, until: new Date("2026-08-31T00:00:00.000Z") },
  );

  assert.equal(report.chains[0]?.longestGap.minutes, 10);
  assert.equal(report.chains[0]?.longestGap.beforeTaskName, "Overlap: After");
});

test("chains retain unassigned priced spend and seed roles represented only by unpriced runs", () => {
  const unknown: import("./costs.js").CostsTaskRow = {
    ...chainTask("unknown-role", 0, "implementation", "Manual chain task"),
    templateStep: null,
  };
  const implementation = chainTask("unpriced-primary", 1, "implementation", "Manual: Implement");
  const repair: import("./costs.js").CostsTaskRow = {
    id: "unpriced-repair", projectId: "project", name: "Autonomous merge tail: review-fix", status: "DONE",
    chainId: null, chainIndex: null, chainLayer: null, repairKind: "review-fix", repairChainId: "chain", templateStep: null,
    readinessRequeues: 0, readinessGrants: 0,
  };
  const pricedUnknown = chainRun(
    "unknown-role-run", unknown,
    "2026-08-01T00:00:00.000Z", "2026-08-01T00:05:00.000Z", "2",
  );
  const unpricedPrimary = { ...chainRun(
    "unpriced-primary-run", implementation,
    "2026-08-01T00:06:00.000Z", "2026-08-01T00:10:00.000Z", "0",
  ), session: null };
  const unpricedRepair = { ...chainRun(
    "unpriced-repair-run", repair,
    "2026-08-01T00:11:00.000Z", "2026-08-01T00:15:00.000Z", "0",
  ), session: null };
  const runs = [pricedUnknown, unpricedPrimary, unpricedRepair];
  const report = aggregateCosts(
    runs,
    new Date("2026-08-01T00:00:00.000Z"),
    30,
    "UTC",
    { tasks: [unknown, implementation, repair], runs, until: new Date("2026-08-31T00:00:00.000Z") },
  );

  assert.equal(report.chains.length, 1);
  assert.equal(report.chains[0]?.costUsd?.toString(), "2");
  assert.equal(report.chains[0]?.costUnavailableRuns, 2);
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.chains[0]?.costByRole ?? {}).map(([role, usd]) => [role, usd.toString()])),
    { implementation: "0", repair: "0", unassigned: "2" },
  );
});

test("in-flight chain tasks are excluded from the costs chain table", () => {
  const task = { ...chainTask("task-running", 0, "implementation", "Release: Running"), status: TaskStatus.DOING };
  const run = chainRun("run-running", task, "2026-08-01T00:00:00.000Z", "2026-08-01T00:05:00.000Z", "1", RunStatus.RUNNING);
  const report = aggregateCosts(
    [run],
    new Date("2026-08-01T00:00:00.000Z"), 30, "UTC",
    { tasks: [task], runs: [run], until: new Date("2026-08-31T00:00:00.000Z") },
  );
  assert.deepEqual(report.chains, []);
});
