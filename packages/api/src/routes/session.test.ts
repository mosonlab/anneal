import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  Prisma,
  RunStatus,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "../test-app.js";
import { activeRunStatuses } from "../run-fence.js";
import { withTokens } from "./test-support.js";

test("session output authorization cannot introduce a second fence instant", async () => {
  const fencedPredicates: Prisma.RunWhereInput[] = [];
  const task = {
    id: "task-1",
    projectId: "project-1",
    chainId: null,
    chainIndex: null,
    chainLayer: null,
    status: "IN_PROGRESS",
    templateStep: {
      stepIndex: 1,
      outputKind: "implementation",
      baseFromStepIndex: null,
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  };
  const database: Record<string, unknown> = {
    $queryRaw: async (query: TemplateStringsArray) => query.join("?").includes('FROM "Run"')
      ? [{ id: "run-1" }]
      : [{ id: "task-1", archivedAt: null }],
    run: { findFirst: async ({ where }: { where: Prisma.RunWhereInput }) => {
      if ("sessionTokenHash" in where) return { id: "run-1", leaseGeneration: 1 };
      fencedPredicates.push(where);
      return { taskId: "task-1", runnerId: "runner-1", task };
    } },
  };
  database.$transaction = async (operation: (tx: unknown) => Promise<unknown>) => operation(database);

  const response = await createApp(database as unknown as PrismaClient).request("/session/runs/run-1/output", {
    method: "PUT",
    headers: { Authorization: "Bearer agos_session_current", "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: "1:run-1:current",
      kind: "wrong-kind",
      body: "not persisted",
      commitSha: "a".repeat(40),
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "task_output kind must be implementation for this canonical step" });
  assert.equal(fencedPredicates.length, 4);
  const instants = fencedPredicates.map((where) => (where.leaseExpiresAt as { gt: Date }).gt);
  assert.ok(instants.every((at) => at === instants[0]));
  assert.ok(fencedPredicates.every((where) => (
    where.status as { in: RunStatus[] }
  ).in === activeRunStatuses));
});

test("GET /session/runs/:runId/status projects the decided output evidence", async () => {
  await withTokens(async () => {
    const commitSha = "a".repeat(40);
    const outputCases = [
      {
        stepOutput: { runId: "run-1", kind: "implementation", commitSha },
        expected: { case: "delivered", output: { kind: "implementation", commitSha } },
      },
      { stepOutput: null, expected: { case: "not-required" } },
      {
        // A Step that requires no deliverable never claims an earlier Run's.
        stepOutput: { runId: "run-prior", kind: "implementation", commitSha },
        expected: { case: "not-required" },
      },
    ] as const;

    for (const { stepOutput, expected } of outputCases) {
      const database = {
        run: {
          findFirst: async () => ({ id: "run-1", leaseGeneration: 1 }),
          findUnique: async () => ({
            id: "run-1",
            runNumber: 1,
            maxRunsPerTask: 5,
            status: "RUNNING",
            startedAt: new Date("2026-08-31T00:00:00.000Z"),
            maxDurationMin: 240,
            stallTimeoutMin: 10,
            branch: "agent/task-1",
            targetBranch: "main",
            agent: { name: "agent" },
            task: {
              id: "task-1",
              name: "Task",
              status: "DOING",
              approvalGate: false,
              chainIndex: 0,
              templateStep: null,
              stepOutput,
            },
          }),
        },
      } as unknown as PrismaClient;

      const response = await createApp(database).request("/session/runs/run-1/status", {
        headers: { Authorization: "Bearer agos_session_current" },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as {
        run: { id: string; status: string };
        task: {
          id: string;
          name: string;
          status: string;
          approvalGate: boolean;
          chainIndex: number;
          outputEvidence: unknown;
        };
      };
      assert.equal(body.run.id, "run-1");
      assert.equal(body.run.status, "RUNNING");
      assert.equal(body.task.id, "task-1");
      assert.equal(body.task.name, "Task");
      assert.equal(body.task.status, "DOING");
      assert.equal(body.task.approvalGate, false);
      assert.equal(body.task.chainIndex, 0);
      assert.deepEqual(body.task.outputEvidence, {
        satisfaction: expected,
        prHandoff: { case: "not-a-pr-delivery" },
      });
    }
  });
});

for (const [templateName, reviewKind, persistedKind] of [
  ["pr-engineer-workflow", "review-findings", "review-findings"],
  ["pr-engineer-workflow-legacy-pre-model-neutral-review-output-row", "sol-findings", "sol-findings"],
  ["pr-engineer-workflow", "review-findings", "sol-findings"],
  ["pr-engineer-workflow-legacy-pre-model-neutral-review-output-row", "sol-findings", "review-findings"],
] as const) {
  test(`PR workflow ${templateName} checks ${persistedKind} against ${reviewKind} handoff through the current step`, async () => {
    await withTokens(async () => {
      const outputs = [
        {
          id: "task-implementation",
          chainIndex: 1,
          templateStep: { outputKind: "implementation" },
          stepOutput: { kind: "implementation", body: "implementation body", commitSha: "1".repeat(40) },
        },
        {
          id: "task-sol",
          chainIndex: 2,
          templateStep: { outputKind: reviewKind },
          stepOutput: { kind: persistedKind, body: "sol body", commitSha: "2".repeat(40) },
        },
        {
          id: "task-blind",
          chainIndex: 3,
          templateStep: { outputKind: "blind-findings" },
          stepOutput: { kind: "blind-findings", body: "blind body", commitSha: "3".repeat(40) },
        },
        {
          id: "task-fixed",
          chainIndex: 4,
          templateStep: { outputKind: "fixed-implementation" },
          stepOutput: { kind: "fixed-implementation", body: "fixed body", commitSha: "4".repeat(40) },
        },
      ];
      const calls: Array<Record<string, unknown>> = [];
      const database = {
        run: {
          findFirst: async () => ({ id: "run-1", leaseGeneration: 1 }),
          findUnique: async () => ({
            id: "run-1",
            runNumber: 1,
            maxRunsPerTask: 5,
            status: "RUNNING",
            startedAt: new Date("2026-08-31T00:00:00.000Z"),
            maxDurationMin: 240,
            stallTimeoutMin: 10,
            branch: "feature/pr-workflow",
            targetBranch: "main",
            agent: { name: "agent" },
            task: {
              id: "task-fixed",
              projectId: "project-1",
              chainId: "chain-1",
              name: "Task",
              status: "DOING",
              approvalGate: false,
              chainIndex: 4,
              templateStep: {
                outputKind: "fixed-implementation",
                taskTemplate: { name: templateName },
              },
              stepOutput: outputs[3]!.stepOutput,
            },
          }),
        },
        task: {
          findMany: async (args: Record<string, unknown>) => {
            calls.push(args);
            return outputs;
          },
        },
      } as unknown as PrismaClient;

      const response = await createApp(database).request("/session/runs/run-1/status", {
        headers: { Authorization: "Bearer agos_session_current" },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as {
        task: { outputEvidence: { prHandoff: unknown } };
      };
      if (persistedKind !== reviewKind) {
        assert.deepEqual(body.task.outputEvidence.prHandoff, {
          case: "incomplete", reason: "canonical PR output kind does not match the producing Step for Task task-sol",
        });
        return;
      }
      assert.deepEqual(body.task.outputEvidence.prHandoff, {
        case: "complete",
        outputs: outputs.map(({ id, chainIndex, stepOutput }) => ({
          taskId: id,
          chainIndex,
          kind: stepOutput.kind,
          body: stepOutput.body,
          commitSha: stepOutput.commitSha,
        })),
      });
      const where = (calls[0] as { where: Record<string, unknown> }).where;
      assert.equal(where.projectId, "project-1");
      assert.equal(where.chainId, "chain-1");
      assert.deepEqual(where.chainIndex, { lte: 4 });
      assert.deepEqual(where.templateStep, {
        outputKind: { in: ["implementation", "review-findings", "sol-findings", "blind-findings", "fixed-implementation"] },
        taskTemplate: { name: templateName },
      });
      assert.deepEqual(where.stepOutput, { isNot: null });
      assert.deepEqual(where.OR, [
        { id: { not: "task-fixed" } },
        { id: "task-fixed", stepOutput: { is: { runId: "run-1" } } },
      ]);
    });
  });

}

test("PR implementation status projects only the current Run's implementation evidence", async () => {
  await withTokens(async () => {
    const current = {
      id: "task-implementation",
      chainIndex: 1,
      templateStep: { outputKind: "implementation" },
      stepOutput: { runId: "run-1", kind: "implementation", body: "implementation body", commitSha: "a".repeat(40) },
    };
    let query: Record<string, unknown> | undefined;
    const database = {
      run: {
        findFirst: async () => ({ id: "run-1", leaseGeneration: 1 }),
        findUnique: async () => ({
          id: "run-1",
          runNumber: 1,
          maxRunsPerTask: 5,
          status: "RUNNING",
          startedAt: new Date("2026-08-31T00:00:00.000Z"),
          maxDurationMin: 240,
          stallTimeoutMin: 10,
          branch: "feature/pr-workflow",
          targetBranch: "main",
          agent: { name: "agent" },
          task: {
            id: current.id,
            projectId: "project-current",
            chainId: "chain-current",
            name: "Task",
            status: "DOING",
            approvalGate: false,
            chainIndex: current.chainIndex,
            templateStep: {
              outputKind: "implementation",
              taskTemplate: { name: "pr-engineer-workflow" },
            },
            stepOutput: current.stepOutput,
          },
        }),
      },
      task: { findMany: async (args: Record<string, unknown>) => { query = args; return [current]; } },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/session/runs/run-1/status", {
      headers: { Authorization: "Bearer agos_session_current" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { task: { outputEvidence: { prHandoff: unknown } } };
    assert.deepEqual(body.task.outputEvidence.prHandoff, {
      case: "complete",
      outputs: [{
        taskId: current.id,
        chainIndex: 1,
        kind: "implementation",
        body: "implementation body",
        commitSha: "a".repeat(40),
      }],
    });
    const where = (query as { where: Record<string, unknown> }).where;
    assert.equal(where.projectId, "project-current");
    assert.equal(where.chainId, "chain-current");
    assert.equal(where.chainIndex, 1);
    assert.deepEqual(where.stepOutput, { is: { runId: "run-1", kind: "implementation" } });
  });
});

test("PR workflow status refuses a nullable commit identity instead of shortening the handoff", async () => {
  await withTokens(async () => {
    const database = {
      run: {
        findFirst: async () => ({ id: "run-1", leaseGeneration: 1 }),
        findUnique: async () => ({
          id: "run-1", runNumber: 1, maxRunsPerTask: 5, status: "RUNNING",
          startedAt: new Date("2026-08-31T00:00:00.000Z"), maxDurationMin: 240, stallTimeoutMin: 10,
          branch: "feature/pr-workflow", targetBranch: "main", agent: { name: "agent" },
          task: {
            id: "task-fixed", projectId: "project-1", chainId: "chain-1", chainIndex: 4,
            name: "Task", status: "DOING", approvalGate: false,
            templateStep: { outputKind: "fixed-implementation", taskTemplate: { name: "pr-engineer-workflow" } },
            stepOutput: { runId: "run-1", kind: "fixed-implementation", commitSha: null },
          },
        }),
      },
      task: { findMany: async () => [{
        id: "task-fixed", chainIndex: 4, templateStep: { outputKind: "fixed-implementation" },
        stepOutput: { kind: "fixed-implementation", body: "{}", commitSha: null },
      }] },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/session/runs/run-1/status", {
      headers: { Authorization: "Bearer agos_session_current" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { task: { outputEvidence: { prHandoff: { case: string; reason: string } } } };
    assert.equal(body.task.outputEvidence.prHandoff.case, "incomplete");
    assert.match(
      body.task.outputEvidence.prHandoff.reason,
      /requires exactly 4 output entries, not 1/u,
    );
  });
});

test("non-PR session status does not expose the PR evidence projection", async () => {
  await withTokens(async () => {
    let queried = false;
    const database = {
      run: {
        findFirst: async () => ({ id: "run-1", leaseGeneration: 1 }),
        findUnique: async () => ({
          id: "run-1",
          runNumber: 1,
          maxRunsPerTask: 5,
          status: "RUNNING",
          startedAt: new Date("2026-08-31T00:00:00.000Z"),
          maxDurationMin: 240,
          stallTimeoutMin: 10,
          branch: "feature/task",
          targetBranch: "main",
          agent: { name: "agent" },
          task: {
            id: "task-1",
            projectId: "project-1",
            chainId: "chain-1",
            chainIndex: 1,
            name: "Task",
            status: "DOING",
            approvalGate: false,
            templateStep: {
              outputKind: "implementation",
              taskTemplate: { name: "direct-engineer-workflow" },
            },
            stepOutput: null,
          },
        }),
      },
      task: { findMany: async () => { queried = true; return []; } },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/session/runs/run-1/status", {
      headers: { Authorization: "Bearer agos_session_current" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { task: { outputEvidence: { prHandoff: unknown } } };
    assert.deepEqual(body.task.outputEvidence.prHandoff, { case: "not-a-pr-delivery" });
    assert.equal(queried, false);
  });
});

test("GET /sessions is project-scoped, clamped, cursored, and reachable by the operator", async () => {
  await withTokens(async () => {
    const calls: Array<Record<string, unknown>> = [];
    const database = {
      session: {
        findMany: async (args: Record<string, unknown>) => { calls.push(args); return []; },
      },
    } as unknown as PrismaClient;
    const app = createApp(database);
    const get = (query: string) => app.request(`/sessions${query}`, { headers: { Authorization: "Bearer operator-unit-token" } });

    // The route is one character from "/session/", which principalMayAccess
    // denies the operator. Pin the 200 so a rename cannot silently 403.
    const scoped = await get("?projectId=p&limit=5&before=2026-08-16T00:00:00.000Z");
    assert.equal(scoped.status, 200);
    const args = calls[0] as { where: { projectId: string; requestedAt: { lt: Date } }; take: number; orderBy: { requestedAt: string }; include: Record<string, unknown> };
    assert.equal(args.where.projectId, "p");
    assert.ok(args.where.requestedAt.lt instanceof Date);
    assert.equal(args.take, 5);
    assert.equal(args.orderBy.requestedAt, "desc");
    assert.deepEqual(Object.keys(args.include).sort(), ["agent", "goal", "run", "task"]);
    // Without remoteUrl the detail page's Branch field could never be a link.
    const run = args.include.run as { select: { repo: { select: Record<string, boolean> } } };
    assert.deepEqual(Object.keys(run.select.repo.select).sort(), ["id", "name", "remoteUrl"]);

    await get("?limit=9999");
    assert.equal((calls[1] as { take: number }).take, 200);
    await get("?limit=abc");
    assert.equal((calls[2] as { take: number }).take, 50);
    await get("?before=not-a-date");
    assert.equal((calls[3] as { where: Record<string, unknown> }).where.requestedAt, undefined);
  });
});

/**
 * The fixture the filter tests query: two steps of one instantiated chain, a
 * standalone task, a session with no task at all, and a second chain's step.
 */
type SessionFixture = {
  id: string;
  runId: string;
  projectId: string;
  agentId: string;
  taskId: string | null;
  runner: string;
  executionStatus: string;
  requestedAt: Date;
  failureReason: string | null;
  task: {
    id: string;
    name: string;
    chainId: string | null;
    templateStep: { name: string } | null;
    stepOutput: null;
    runs: [];
  } | null;
  run: { id: string; branch: string | null } | null;
};

const sessionFixture = (
  id: string,
  at: string,
  named: Partial<SessionFixture> & { taskName?: string; chainId?: string | null; stepName?: string | null; branch?: string | null },
): SessionFixture => ({
  id,
  runId: `run-${id}`,
  projectId: "p",
  agentId: named.agentId ?? "agent-1",
  taskId: named.taskName === undefined ? null : `task-${id}`,
  runner: named.runner ?? "CLAUDE",
  executionStatus: named.executionStatus ?? "RUNNING",
  requestedAt: new Date(at),
  failureReason: named.failureReason ?? null,
  task: named.taskName === undefined ? null : {
    id: `task-${id}`,
    name: named.taskName,
    chainId: named.chainId ?? null,
    templateStep: named.stepName === undefined || named.stepName === null ? null : { name: named.stepName },
    stepOutput: null,
    runs: [],
  },
  run: { id: `run-${id}`, branch: named.branch ?? null },
});

const sessionFixtures: SessionFixture[] = [
  sessionFixture("s1", "2026-08-20T00:00:00.000Z", {
    taskName: "Chain Alpha: Implement the filters", chainId: "chain-alpha", stepName: "Implement the filters",
    agentId: "agent-1", runner: "CLAUDE", executionStatus: "RUNNING", branch: "feat/alpha",
  }),
  sessionFixture("s2", "2026-08-19T00:00:00.000Z", {
    taskName: "Chain Alpha: Review the filters", chainId: "chain-alpha", stepName: "Review the filters",
    agentId: "agent-2", runner: "CODEX", executionStatus: "SUCCEEDED", branch: "feat/alpha",
  }),
  sessionFixture("s3", "2026-08-18T00:00:00.000Z", {
    taskName: "Standalone cleanup", agentId: "agent-1", runner: "CODEX",
    executionStatus: "FAILED", branch: "chore/sweep", failureReason: "gate timed out",
  }),
  sessionFixture("s4", "2026-08-17T00:00:00.000Z", {
    agentId: "agent-3", runner: "PI", executionStatus: "CANCELLED",
  }),
  sessionFixture("s5", "2026-08-16T00:00:00.000Z", {
    taskName: "Chain Beta: Ship it", chainId: "chain-beta", stepName: "Ship it",
    agentId: "agent-2", runner: "CLAUDE", executionStatus: "TIMED_OUT", branch: "feat/beta",
    failureReason: "lost the runner",
  }),
];

/** The only `where` shapes `sessionListWhere` emits. This matcher models those
 *  and refuses anything else, so a predicate the route cannot build fails here
 *  instead of passing an assertion the fake never applied. */
type EmittedWhere = {
  projectId?: string;
  requestedAt?: { lt?: Date; gte?: Date; lte?: Date };
  executionStatus?: { in: string[] };
  agentId?: string;
  runner?: string;
  taskId?: string;
  task?: { chainId: string };
  OR?: [
    { task: { name: { contains: string } } },
    { run: { branch: { contains: string } } },
    { failureReason: { contains: string } },
  ];
};

const modelledWhereKeys = ["projectId", "requestedAt", "executionStatus", "agentId", "runner", "taskId", "task", "OR"];

// Model PostgreSQL LIKE: unescaped wildcards broaden, escaped ones are literal.
const containsInsensitive = (value: string | null | undefined, needle: string): boolean => {
  let pattern = "";
  const literal = (character: string): string => character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  for (let index = 0; index < needle.length; index += 1) {
    const character = needle[index]!;
    if (character === "\\" && index + 1 < needle.length) pattern += literal(needle[++index]!);
    else pattern += character === "%" ? ".*" : character === "_" ? "." : literal(character);
  }
  return typeof value === "string" && new RegExp(pattern, "isu").test(value);
};

const matchesEmittedWhere = (row: SessionFixture, where: EmittedWhere): boolean => {
  for (const key of Object.keys(where)) {
    assert.ok(modelledWhereKeys.includes(key), `the test matcher does not model where.${key}`);
  }
  if (where.projectId !== undefined && row.projectId !== where.projectId) return false;
  if (where.requestedAt?.lt !== undefined && !(row.requestedAt < where.requestedAt.lt)) return false;
  if (where.requestedAt?.gte !== undefined && !(row.requestedAt >= where.requestedAt.gte)) return false;
  if (where.requestedAt?.lte !== undefined && !(row.requestedAt <= where.requestedAt.lte)) return false;
  if (where.executionStatus !== undefined && !where.executionStatus.in.includes(row.executionStatus)) return false;
  if (where.agentId !== undefined && row.agentId !== where.agentId) return false;
  if (where.runner !== undefined && row.runner !== where.runner) return false;
  if (where.taskId !== undefined && row.taskId !== where.taskId) return false;
  if (where.task !== undefined && row.task?.chainId !== where.task.chainId) return false;
  if (where.OR !== undefined) {
    const [byName, byBranch, byReason] = where.OR;
    const matched = containsInsensitive(row.task?.name, byName.task.name.contains)
      || containsInsensitive(row.run?.branch, byBranch.run.branch.contains)
      || containsInsensitive(row.failureReason, byReason.failureReason.contains);
    if (!matched) return false;
  }
  return true;
};

type ListedSession = {
  id: string;
  task: { id: string; name: string; chainId: string | null; chainName: string | null } | null;
};

const listSessions = (recorded: Array<Record<string, unknown>>) => {
  const app = createApp({
    task: { findMany: async () => sessionFixtures.flatMap((row) => row.task ? [{ ...row.task, projectId: row.projectId }] : []) },
    session: {
      findMany: async (args: Record<string, unknown>) => {
        recorded.push(args);
        return sessionFixtures
          .filter((row) => matchesEmittedWhere(row, args.where as EmittedWhere))
          .sort((left, right) => right.requestedAt.getTime() - left.requestedAt.getTime())
          .slice(0, args.take as number);
      },
    },
  } as unknown as PrismaClient);
  return async (query: string): Promise<ListedSession[]> => {
    const response = await app.request(`/sessions${query}`, { headers: { Authorization: "Bearer operator-unit-token" } });
    assert.equal(response.status, 200);
    return await response.json() as ListedSession[];
  };
};

const listedIds = async (list: (query: string) => Promise<ListedSession[]>, query: string): Promise<string[]> =>
  (await list(query)).map((session) => session.id);

test("GET /sessions narrows by each filter and by filters in combination", async () => {
  await withTokens(async () => {
    const list = listSessions([]);
    const ids = (query: string) => listedIds(list, query);

    assert.deepEqual(await ids("?projectId=p&status=live"), ["s1"]);
    assert.deepEqual(await ids("?projectId=p&status=done"), ["s2"]);
    assert.deepEqual(await ids("?projectId=p&status=failed"), ["s3", "s5"]);
    assert.deepEqual(await ids("?projectId=p&status=cancelled"), ["s4"]);
    assert.deepEqual(await ids("?projectId=p&agentId=agent-1"), ["s1", "s3"]);
    assert.deepEqual(await ids("?projectId=p&runner=CODEX"), ["s2", "s3"]);
    assert.deepEqual(await ids("?projectId=p&taskId=task-s3"), ["s3"]);
    assert.deepEqual(await ids("?projectId=p&chainId=chain-alpha"), ["s1", "s2"]);
    assert.deepEqual(await ids("?projectId=p&since=2026-08-18T00:00:00.000Z"), ["s1", "s2", "s3"]);
    assert.deepEqual(await ids("?projectId=p&until=2026-08-17T00:00:00.000Z"), ["s4", "s5"]);

    // Filters combine by AND, with each other and with the scope.
    assert.deepEqual(await ids("?projectId=p&chainId=chain-alpha&runner=CODEX"), ["s2"]);
    assert.deepEqual(await ids("?projectId=p&status=failed&agentId=agent-1"), ["s3"]);
    assert.deepEqual(
      await ids("?projectId=p&since=2026-08-16T00:00:00.000Z&until=2026-08-19T00:00:00.000Z&runner=CLAUDE"),
      ["s5"],
    );
    assert.deepEqual(await ids("?projectId=other&status=live"), []);
  });
});

test("GET /sessions still pages by cursor under a filter", async () => {
  await withTokens(async () => {
    const list = listSessions([]);
    assert.deepEqual(await listedIds(list, "?projectId=p&agentId=agent-1&limit=1"), ["s1"]);
    // The second page under the same filter carries only rows older than the cursor.
    assert.deepEqual(
      await listedIds(list, "?projectId=p&agentId=agent-1&before=2026-08-20T00:00:00.000Z"),
      ["s3"],
    );
  });
});

test("GET /sessions q searches task name, run branch and failure reason, and never an id", async () => {
  await withTokens(async () => {
    const list = listSessions([]);
    const ids = (query: string) => listedIds(list, query);

    assert.deepEqual(await ids("?projectId=p&q=standalone"), ["s3"]);
    assert.deepEqual(await ids("?projectId=p&q=sweep"), ["s3"]);
    assert.deepEqual(await ids("?projectId=p&q=timed%20out"), ["s3"]);
    // Case-insensitive on all three columns: the name and branch of the chain.
    assert.deepEqual(await ids("?projectId=p&q=ALPHA"), ["s1", "s2"]);
    assert.deepEqual(await ids("?projectId=p&q=LOST%20the%20runner"), ["s5"]);
    // An id is addressed by taskId or chainId; q must never reach one.
    assert.deepEqual(await ids("?projectId=p&q=task-s3"), []);
    assert.deepEqual(await ids("?projectId=p&q=chain-alpha"), []);
  });
});

test("GET /sessions refuses a present-but-unusable filter by name", async () => {
  await withTokens(async () => {
    const app = createApp({
      session: { findMany: async () => { assert.fail("a refused request must not query"); } },
    } as unknown as PrismaClient);
    const get = (query: string) => app.request(`/sessions${query}`, { headers: { Authorization: "Bearer operator-unit-token" } });

    for (const parameter of ["since", "until"]) {
      for (const value of ["0", "August 16, 2026", "2026-02-31T00:00:00Z"]) {
        const response = await get(`?${parameter}=${encodeURIComponent(value)}`);
        assert.equal(response.status, 400);
        assert.equal((await response.json() as { code: string }).code, `session-filter-${parameter}-invalid`);
      }
    }
    const since = await get("?since=yesterday");
    assert.equal(since.status, 400);
    assert.equal((await since.json() as { code: string }).code, "session-filter-since-invalid");

    const status = await get("?status=running");
    assert.equal(status.status, 400);
    assert.equal((await status.json() as { code: string }).code, "session-filter-status-invalid");

    // An empty value meant something and lost it, so it refuses rather than widening.
    const empty = await get("?agentId=");
    assert.equal(empty.status, 400);
    assert.equal((await empty.json() as { code: string }).code, "session-filter-agent-id-invalid");
  });
});

test("GET /sessions without filters asks exactly the question it asked before them", async () => {
  await withTokens(async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const list = listSessions(recorded);
    await list("?projectId=p");
    await list("");
    await list("?before=2026-08-19T00:00:00.000Z");
    assert.deepEqual(recorded.map((call) => call.where), [
      { projectId: "p" },
      {},
      { requestedAt: { lt: new Date("2026-08-19T00:00:00.000Z") } },
    ]);
  });
});

test("GET /sessions projects chain identity onto every row", async () => {
  await withTokens(async () => {
    const sessions = await listSessions([])("?projectId=p");
    const byId = new Map(sessions.map((session) => [session.id, session.task]));
    assert.deepEqual(byId.get("s1"), {
      id: "task-s1", name: "Chain Alpha: Implement the filters", chainId: "chain-alpha", chainName: "Chain Alpha",
    });
    // A task outside a chain has an id but no name to derive.
    assert.deepEqual(byId.get("s3"), {
      id: "task-s3", name: "Standalone cleanup", chainId: null, chainName: null,
    });
    assert.equal(byId.get("s4"), null);
    // The include's merge-outcome fields are the route's business, not the wire's.
    assert.deepEqual(Object.keys(byId.get("s1") ?? {}).sort(), ["chainId", "chainName", "id", "name"]);
  });
});

test("GET /sessions/:sessionId carries task-detail metrics while list rows stay metric-free", async () => {
  await withTokens(async () => {
    const readyAt = new Date("2026-09-01T10:00:00.000Z");
    const startedAt = new Date("2026-09-01T10:00:20.000Z");
    const endedAt = new Date("2026-09-01T10:02:00.000Z");
    const row = {
      ...sessionFixture("metrics", "2026-09-01T10:00:00.000Z", {
        taskName: "Chain Alpha: Implement the filters", chainId: "chain-alpha", stepName: "Implement the filters",
        runner: "CLAUDE", executionStatus: "SUCCEEDED",
      }),
      provisionedAt: new Date("2026-09-01T10:00:05.000Z"),
      startedAt,
      endedAt,
      cleanupStartedAt: null,
      cleanupEndedAt: null,
      resumeAttempt: 0,
      inputTokens: 1_000,
      cachedInputTokens: 600,
      cacheCreationInputTokens: 150,
      outputTokens: 400,
      costUsd: "6.0000",
      terminationReason: "provider completed",
      exitCode: 0,
      signal: null,
      task: {
        ...sessionFixture("metrics", "2026-09-01T10:00:00.000Z", {
          taskName: "Chain Alpha: Implement the filters", chainId: "chain-alpha", stepName: "Implement the filters",
        }).task!,
        templateStepId: "step-1",
      },
      run: {
        id: "run-metrics", runNumber: 2, model: "claude-opus-5", branch: "feat/alpha",
        readyAt, status: "SUCCEEDED", endedAt,
        pullRequestUrl: null, workspacePath: null,
        repo: { id: "repo-1", name: "repo", remoteUrl: "https://example.test/repo" },
      },
    };
    const metricEvents = [
      {
        type: "TOOL_STARTED", at: new Date("2026-09-01T10:00:30.000Z"), toolCallId: "tool-1",
        payload: { type: "tool_use", name: "Bash" },
      },
      {
        type: "TOOL_COMPLETED", at: new Date("2026-09-01T10:00:40.000Z"), toolCallId: "tool-1",
        payload: { type: "tool_result", is_error: false },
      },
      { type: "MODEL_COMPLETED", at: endedAt, toolCallId: null, payload: { anneal: { ttftMs: 20 } } },
    ];
    const rawQueries: Array<{ sql?: string }> = [];
    const database = {
      session: {
        findUnique: async () => row,
        findMany: async () => [row],
      },
      task: {
        findMany: async () => [{
          id: row.task!.id, projectId: row.projectId, name: row.task!.name,
          chainId: row.task!.chainId, templateStep: row.task!.templateStep,
        }],
      },
      $queryRaw: async (query: { sql?: string }) => {
        rawQueries.push(query);
        if (query.sql?.includes("percentile_cont")) {
          return [{
            projectId: row.projectId, templateStepId: "step-1", sampleSize: 8,
            costSampleSize: 8, costP50: 3, costP90: 5,
            durationSampleSize: 8, durationP50: 50_000, durationP90: 80_000,
          }];
        }
        return metricEvents;
      },
    } as unknown as PrismaClient;
    const app = createApp(database);

    const detailResponse = await app.request("/sessions/metrics", { headers: { Authorization: "Bearer operator-unit-token" } });
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { metrics: Record<string, unknown> };
    assert.deepEqual(Object.keys(detail.metrics).sort(), [
      "modelActiveIsUpperBound", "modelActiveMs", "outputTokensPerSecond", "phases",
      "termination", "tokens", "tools", "ttft", "vsBaseline",
    ]);
    assert.deepEqual((detail.metrics.ttft), { p50Ms: 20, p90Ms: 20, samples: 1 });
    assert.deepEqual(detail.metrics.vsBaseline, { costRatio: 2, durationRatio: 2 });
    assert.deepEqual(detail.metrics.phases, {
      queuedMs: 5_000, provisioningMs: 15_000, executingMs: 100_000, inboxWaitMs: 0, cleanupMs: null,
    });

    const listResponse = await app.request("/sessions?projectId=p", { headers: { Authorization: "Bearer operator-unit-token" } });
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.equal("metrics" in list[0]!, false);
    // The detail uses one event projection and one baseline aggregate. The list
    // reuses its existing findMany/include query and performs neither read.
    assert.equal(rawQueries.length, 2);
  });
});

test("GET /sessions/:sessionId 404s cleanly and carries the repo remote URL", async () => {
  await withTokens(async () => {
    const calls: Array<Record<string, unknown>> = [];
    const database = {
      session: { findUnique: async (args: Record<string, unknown>) => { calls.push(args); return null; } },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/sessions/unknown", { headers: { Authorization: "Bearer operator-unit-token" } });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Session not found" });
    const include = (calls[0] as { include: { run: { select: { repo: { select: Record<string, boolean> } } } } }).include;
    assert.equal(include.run.select.repo.select.remoteUrl, true);
  });
});

test("GET /sessions/:sessionId derives a chain name only when one row proves it", async () => {
  await withTokens(async () => {
    const row = sessionFixture("s1", "2026-08-20T00:00:00.000Z", {
      taskName: "Chain Alpha: Implement the filters", chainId: "chain-alpha", stepName: "Implement the filters",
    });
    const detail = async (task: SessionFixture["task"]) => {
      const app = createApp({
        session: { findUnique: async () => ({ ...row, task }) },
        $queryRaw: async () => [],
      } as unknown as PrismaClient);
      const response = await app.request("/sessions/s1", { headers: { Authorization: "Bearer operator-unit-token" } });
      assert.equal(response.status, 200);
      return (await response.json() as ListedSession).task;
    };

    // The persisted template-step suffix is the only proof a lone row carries.
    assert.deepEqual(await detail(row.task), {
      id: "task-s1", name: "Chain Alpha: Implement the filters", chainId: "chain-alpha", chainName: "Chain Alpha",
    });
    assert.deepEqual(await detail(row.task === null ? null : { ...row.task, templateStep: null }), {
      id: "task-s1", name: "Chain Alpha: Implement the filters", chainId: "chain-alpha", chainName: null,
    });
  });
});

test("GET /runs/:runId/events pages by seq and reports hasMore without a second count", async () => {
  await withTokens(async () => {
    const rows = (count: number, from: number) => Array.from({ length: count }, (_, index) => ({ id: `e${from + index}`, seq: from + index }));
    const findManyArgs: Array<Record<string, unknown>> = [];
    const makeApp = (returned: Array<{ seq: number }>) => createApp({
      sessionEvent: {
        findMany: async (args: Record<string, unknown>) => { findManyArgs.push(args); return returned; },
        count: async () => 12,
      },
    } as unknown as PrismaClient);

    const more = await makeApp(rows(3, 8)).request("/runs/r1/events?afterSeq=7&limit=2", { headers: { Authorization: "Bearer operator-unit-token" } });
    const body = await more.json() as { events: Array<{ seq: number }>; hasMore: boolean; nextAfterSeq: number; total: number };
    assert.equal(body.events.length, 2);
    assert.equal(body.hasMore, true);
    assert.equal(body.nextAfterSeq, 9);
    assert.equal(body.total, 12);
    assert.deepEqual((findManyArgs[0] as { where: { seq: { gt: number } } }).where.seq, { gt: 7 });
    assert.equal((findManyArgs[0] as { take: number }).take, 3);

    const done = await makeApp(rows(2, 8)).request("/runs/r1/events?afterSeq=7&limit=2", { headers: { Authorization: "Bearer operator-unit-token" } });
    assert.equal((await done.json() as { hasMore: boolean }).hasMore, false);

    await makeApp([]).request("/runs/r1/events?limit=99999", { headers: { Authorization: "Bearer operator-unit-token" } });
    const clamped = findManyArgs.at(-1) as { take: number; where: Record<string, unknown> };
    assert.equal(clamped.take, 2001);
    assert.equal(clamped.where.seq, undefined);
  });
});

// §R11/§R5: the revalidation capability is keyed on the canonical Step, so a
// staffing profile may bind any Agent to it and the bound implementation task
// still resolves. Before this the route dispatched on `run.agent.name`.
test("GET /session/runs/:runId/status binds the implementation task for any agent on the revalidation step", async () => {
  await withTokens(async () => {
    const revalidationStep = {
      name: "Revalidate the brief",
      stepIndex: 1,
      outputKind: "revalidation",
      priorOutputKinds: [],
      taskTemplate: { name: "direct-engineer-workflow" },
    };
    const callerTask = {
      id: "task-revalidate",
      projectId: "project-1",
      chainId: "chain-1",
      chainIndex: 0,
      chainLayer: 0,
      dispatchAfterTaskId: "task-prior",
      description: "brief",
      name: "Revalidate",
      status: "DOING",
      approvalGate: false,
      assigneeAgentId: "agent-anything",
      templateId: "template-1",
      templateStepId: "step-1",
      templateStep: revalidationStep,
      stepOutput: null,
    };
    const implementationTask = {
      ...callerTask,
      id: "task-implementation",
      name: "Implement",
      chainIndex: 1,
      chainLayer: 1,
      dispatchAfterTaskId: null,
      templateStepId: "step-2",
      templateStep: {
        name: "Implement",
        stepIndex: 2,
        outputKind: "implementation",
        priorOutputKinds: ["revalidation"],
        taskTemplate: { name: "direct-engineer-workflow" },
      },
    };
    const database = {
      run: {
        findFirst: async () => ({ id: "run-1", leaseGeneration: 1 }),
        findUnique: async () => ({
          id: "run-1",
          runNumber: 1,
          maxRunsPerTask: 5,
          status: "RUNNING",
          startedAt: new Date("2026-09-05T00:00:00.000Z"),
          maxDurationMin: 240,
          stallTimeoutMin: 10,
          branch: "agentos/task-revalidate/run-1",
          targetBranch: "main",
          // Deliberately not the retired `spec-revalidator` identity.
          agentId: "agent-anything",
          task: callerTask,
        }),
      },
      task: { findMany: async () => [callerTask, implementationTask] },
    } as unknown as PrismaClient;

    const response = await createApp(database).request("/session/runs/run-1/status", {
      headers: { Authorization: "Bearer agos_session_current" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { task: { boundImplementationTask?: { id: string; name: string } } };
    assert.deepEqual(body.task.boundImplementationTask?.id, "task-implementation");
    assert.deepEqual(body.task.boundImplementationTask?.name, "Implement");
  });
});

test("GET /session/runs/:runId/status omits the bound implementation task off the revalidation step", async () => {
  await withTokens(async () => {
    let chainReads = 0;
    const database = {
      run: {
        findFirst: async () => ({ id: "run-1", leaseGeneration: 1 }),
        findUnique: async () => ({
          id: "run-1",
          runNumber: 1,
          maxRunsPerTask: 5,
          status: "RUNNING",
          startedAt: new Date("2026-09-05T00:00:00.000Z"),
          maxDurationMin: 240,
          stallTimeoutMin: 10,
          branch: "agentos/task-1/run-1",
          targetBranch: "main",
          agentId: "agent-anything",
          task: {
            id: "task-1",
            name: "Implement",
            status: "DOING",
            approvalGate: false,
            chainIndex: 1,
            templateStep: {
              name: "Implement",
              stepIndex: 2,
              outputKind: "implementation",
              priorOutputKinds: [],
              taskTemplate: { name: "direct-engineer-workflow" },
            },
            stepOutput: null,
          },
        }),
      },
      task: { findMany: async () => { chainReads += 1; return []; } },
    } as unknown as PrismaClient;

    const response = await createApp(database).request("/session/runs/run-1/status", {
      headers: { Authorization: "Bearer agos_session_current" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { task: Record<string, unknown> };
    assert.equal("boundImplementationTask" in body.task, false);
    assert.equal(chainReads, 0);
  });
});

test("GET /sessions resolves a direct chain from tasks outside the returned page", async () => {
  await withTokens(async () => {
    const row = sessionFixture("direct", "2026-08-20T00:00:00Z", { taskName: "Direct chain: Build", chainId: "direct-chain" });
    const tasks = [row.task!, { ...row.task!, id: "other", name: "Direct chain: Review" }].map((task) => ({ ...task, projectId: "p" }));
    const app = createApp({ session: { findMany: async () => [row] }, task: { findMany: async (args: unknown) => {
      assert.deepEqual((args as { where: unknown }).where, { OR: [{ projectId: "p", chainId: "direct-chain" }] });
      return tasks;
    } } } as unknown as PrismaClient);
    const response = await app.request("/sessions?limit=1&taskId=task-direct", { headers: { Authorization: "Bearer operator-unit-token" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as ListedSession[])[0]?.task?.chainName, "Direct chain");
  });
});

test("GET /sessions matches percent literally instead of widening search", async () => {
  await withTokens(async () => {
    const literal = sessionFixture("literal", "2026-08-20T00:00:00Z", { failureReason: "100% complete" });
    const plain = sessionFixture("plain", "2026-08-19T00:00:00Z", { failureReason: "100 complete" });
    const app = createApp({ session: { findMany: async (args: { where: EmittedWhere }) => [literal, plain].filter((row) => matchesEmittedWhere(row, args.where)) } } as unknown as PrismaClient);
    const response = await app.request("/sessions?q=100%25", { headers: { Authorization: "Bearer operator-unit-token" } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as ListedSession[]).map((row) => row.id), ["literal"]);
  });
});
