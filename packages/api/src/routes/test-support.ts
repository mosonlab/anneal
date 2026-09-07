import "../test-workspace-root.js";
import assert from "node:assert/strict";

import { type PrismaClient } from "@anneal/db";

import { createApp } from "../test-app.js";

export const withTokens = async (callback: () => Promise<void>): Promise<void> => {
  const operator = process.env.OPERATOR_TOKEN;
  const runner = process.env.RUNNER_TOKEN;
  const mergeExecutor = process.env.MERGE_EXECUTOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-unit-token";
  process.env.RUNNER_TOKEN = "runner-unit-token";
  process.env.MERGE_EXECUTOR_TOKEN = "merge-executor-unit-token";
  try {
    await callback();
  } finally {
    if (operator === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = operator;
    if (runner === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = runner;
    if (mergeExecutor === undefined) delete process.env.MERGE_EXECUTOR_TOKEN;
    else process.env.MERGE_EXECUTOR_TOKEN = mergeExecutor;
  }
};

export const lockedAgent = <T extends Record<string, unknown>>(agent: T | null): (T & Record<string, unknown>) | null => agent ? ({
  name: "Agent",
  archivedAt: null,
  codexServiceTier: "DEFAULT",
  ...agent,
}) : null;

/* --------------------------------------------------- GET /tasks, projected */

/** A stub with just enough of `task` for `GET /tasks` to answer: the board row
 *  page, the chain-progress page, and the recurring groupBy the full shape adds. */
/** `related` answers the by-id lookups the board makes for rows that are not on
 *  the page — a bound task's predecessor and a repair task's regression task —
 *  and `activity` the merge-tail markers that name the latter. */
/** `baselines` answers the one grouped baseline statement the board issues, and
 *  `baselineQueries` records it — which is what proves that read stays one
 *  query however many cards the page carries. */
export const boardDatabase = (
  rows: Array<Record<string, unknown>>,
  extras: {
    related?: Array<Record<string, unknown>>;
    activity?: Array<Record<string, unknown>>;
    baselines?: Array<Record<string, unknown>>;
    baselineQueries?: Array<{ sql: string; values: unknown[] }>;
  } = {},
): PrismaClient => {
  let call = 0;
  const taskRows = [...rows].sort((left, right) => (
    (right.createdAt as Date).getTime() - (left.createdAt as Date).getTime()
      || String(left.id).localeCompare(String(right.id))
  ));
  return {
    task: {
      findMany: async (args: Record<string, unknown> | undefined) => {
        if ((args?.where as Record<string, unknown> | undefined)?.id !== undefined) return extras.related ?? [];
        if (call++ !== 0) return [];
        assert.deepEqual(args?.orderBy, [{ createdAt: "desc" }, { id: "asc" }]);
        const take = ((args?.include as any)?.runs as any)?.take;
        return take === 1
          ? taskRows.map((row) => ({ ...row, runs: (row.runs as unknown[] | undefined)?.slice(0, 1) ?? [] }))
          : taskRows;
      },
      groupBy: async () => [],
    },
    run: {
      findMany: async () => taskRows.flatMap((task) => (
        (task.runs as Array<Record<string, unknown>> | undefined ?? []).map((run) => ({
          taskId: task.id,
          runNumber: run.runNumber,
          status: run.status,
          pushedBranch: run.pushedBranch ?? null,
          baseSha: run.baseSha ?? null,
        }))
      )),
    },
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      assert.match(query.sql, /percentile_cont/u);
      extras.baselineQueries?.push(query);
      return extras.baselines ?? [];
    },
    agentRepoAccess: { findMany: async () => [] },
    taskActivity: { findMany: async () => extras.activity ?? [] },
    chainControl: { findMany: async () => [] },
  } as unknown as PrismaClient;
};

export const taskRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "t1", projectId: "p1", name: "Ship the thing", status: "TODO", assigneeType: "AGENT",
  assigneeAgentId: "a1", repoId: "r1", archivedAt: null, maxSessionsPerTask: 5, failureReason: null,
  scheduleKind: "NOW", runAt: null, cron: null, timezone: null, approvalGate: false,
  templateId: null, templateStepId: null, source: "MANUAL", chainId: null, chainIndex: null, chainLayer: null, dispatchAfterTaskId: null,
  createdAt: new Date("2026-08-16T00:00:00.000Z"),
  updatedAt: new Date("2026-08-16T00:00:00.000Z"), templateStep: null,
  assigneeAgent: { id: "a1", title: "Senior Developer", model: "gpt-5.6-sol:medium", archivedAt: null },
  runs: [{
    id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5", codexServiceTier: "DEFAULT", budgetGrants: 0,
    readyAt: new Date("2026-08-16T00:00:00.000Z"), endedAt: new Date("2026-08-16T00:05:00.000Z"),
    lastProgressEventAt: null, maxRunsPerTask: 5,
    session: {
      costUsd: "0.42", inputTokens: null, cachedInputTokens: null,
      cacheCreationInputTokens: null, outputTokens: null, executionStatus: "SUCCEEDED",
      provisionedAt: null, startedAt: null, endedAt: null, cleanupStartedAt: null, cleanupEndedAt: null,
    },
  }],
  ...overrides,
});

export const getTasks = async (database: PrismaClient, query: string, headers: Record<string, string> = {}): Promise<Response> =>
  await createApp(database).request(`/tasks${query}`, {
    headers: { Authorization: "Bearer operator-unit-token", ...headers },
  });

export const untouchableDatabase = (): PrismaClient => new Proxy({}, {
  get(_target, property) {
    throw new Error(`the database must not be reached: ${String(property)}`);
  },
}) as unknown as PrismaClient;
