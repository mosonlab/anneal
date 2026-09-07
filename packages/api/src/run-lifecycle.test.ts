import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  type PrismaClient,
  RunStatus,
} from "@anneal/db";

import {
  appendRunActivity,
  appendRunEvents,
  eventsInput,
  heartbeatInput,
  heartbeatRun,
  publishRun,
  recordRunCleanup,
  startRun,
} from "./run-lifecycle.js";
import type { LockedAuthorityRun } from "./run-fence.js";

const now = new Date("2026-08-30T12:00:00.000Z");

const databaseFor = (tx: Record<string, unknown>, calls: string[] = []): PrismaClient => ({
  $transaction: async (operation: (client: unknown) => Promise<unknown>) => {
    calls.push("transaction");
    return operation(tx);
  },
} as unknown as PrismaClient);

const authorityRun = (overrides: Partial<LockedAuthorityRun> = {}): LockedAuthorityRun => ({
  id: "run-1",
  runnerId: "runner-1",
  fencingToken: "fence-1",
  cancelRequestId: null,
  cancelReason: null,
  cancelRequestedAt: null,
  leaseExpiresAt: new Date(now.getTime() + 60_000),
  status: RunStatus.RUNNING,
  taskId: "task-1",
  repoId: "repo-1",
  runNumber: 1,
  pushedBranch: null,
  baseSha: null,
  basePublishedAt: null,
  branch: "feature/task-1",
  targetBranch: "main",
  ...overrides,
});

const finalOutputPayload = {
  type: "result",
  total_cost_usd: 0.049117,
  usage: { input_tokens: 4, output_tokens: 77, cache_read_input_tokens: 8_700, cache_creation_input_tokens: 120 },
};

const eventDatabase = (options: {
  finalOutputRows?: Array<{ payload: unknown }>;
  onUsageUpdate?: () => void;
  stored?: Array<Record<string, unknown>>;
  sessionWrites?: Array<Record<string, unknown>>;
} = {}): PrismaClient => {
  let fencedRead = 0;
  const stored = options.stored ?? [];
  const sessionWrites = options.sessionWrites ?? [];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => query.join("?").includes('FROM "Run"')
      ? [{ id: "run-1" }]
      : [{ id: "task-1", archivedAt: null }],
    $executeRawUnsafe: async () => 0,
    run: { findFirst: async () => {
      fencedRead += 1;
      return fencedRead === 1
        ? { taskId: "task-1" }
        : { session: { id: "session-1", providerConversationId: null } };
    } },
    sessionEvent: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        stored.push(...data);
        return { count: data.length };
      },
      findMany: async () => options.finalOutputRows ?? [],
    },
    session: {
      findUnique: async () => ({
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        cacheCreationInputTokens: null,
        totalTokens: null,
        costUsd: null,
      }),
      update: async (args: Record<string, unknown>) => {
        const data = args.data as Record<string, unknown>;
        if ("inputTokens" in data) options.onUsageUpdate?.();
        sessionWrites.push(args);
        return {};
      },
    },
  };
  return databaseFor(tx);
};

const eventBody = (types: string[]) => eventsInput.parse({
  runnerId: "runner-1",
  fencingToken: "fence-1",
  events: types.map((type, index) => ({
    seq: index + 1,
    source: "CLAUDE",
    type,
    payload: type === "FINAL_OUTPUT" ? finalOutputPayload : { text: "hello" },
  })),
});

test("start owns the transaction and preserves one Run and Session lifecycle timestamp", async () => {
  const calls: string[] = [];
  const runWrites: Array<Record<string, unknown>> = [];
  const sessionWrites: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => { calls.push("lock.run"); return [{ id: "run-1" }]; },
    run: {
      findFirst: async () => {
        calls.push("read.run");
        return { startedAt: null };
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("write.run");
        runWrites.push(data);
        return { count: 1 };
      },
    },
    session: { updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      calls.push("write.session");
      sessionWrites.push(data);
      return { count: 1 };
    } },
  };

  const result = await startRun(databaseFor(tx, calls), {
    runId: "run-1",
    now,
    body: {
      runnerId: "runner-1",
      fencingToken: "fence-1",
      adapterVersion: "adapter-1",
      cliVersion: "cli-1",
      manifest: {},
      workspacePath: "/scratch/run-1",
      promptHash: "a".repeat(64),
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(runWrites[0]?.startedAt, now);
  assert.equal(sessionWrites[0]?.startedAt, now);
  assert.deepEqual(calls, [
    "transaction",
    "lock.run",
    "read.run",
    "write.run",
    "write.session",
  ]);
});

test("start preserves a resumed lifecycle anchor and admits the mechanical null prompt", async () => {
  const originalStartedAt = new Date("2026-08-29T10:00:00.000Z");
  const runWrites: Array<Record<string, unknown>> = [];
  const sessionWrites: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => [{ id: "run-1" }],
    run: {
      findFirst: async () => ({ startedAt: originalStartedAt }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        runWrites.push(data);
        return { count: 1 };
      },
    },
    session: { updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      sessionWrites.push(data);
      return { count: 1 };
    } },
  };

  const result = await startRun(databaseFor(tx), {
    runId: "run-1",
    now,
    body: {
      runnerId: "merge-executor-1",
      fencingToken: "fence-1",
      adapterVersion: "executor-1",
      cliVersion: "executor-1",
      manifest: { executionMode: "mechanical" },
      workspacePath: null,
      promptHash: null,
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(runWrites[0]?.startedAt, originalStartedAt);
  assert.equal(sessionWrites[0]?.startedAt, originalStartedAt);
  assert.equal(runWrites[0]?.promptHash, null);
});

test("heartbeat observes the runner before refusing stale and WAITING_INBOX Runs", async () => {
  const body = heartbeatInput.parse({
    runnerId: "runner-1",
    fencingToken: "stale-fence",
    leaseSeconds: 60,
    processAlive: true,
  });
  const calls: string[] = [];
  const makeDb = (run: LockedAuthorityRun) => databaseFor({
    $queryRaw: async () => { calls.push("lock.run"); return [{ id: "run-1" }]; },
    run: { findFirst: async () => run },
  }, calls);
  const noteRunner = () => { calls.push("note.runner"); };

  const stale = await heartbeatRun(makeDb(authorityRun()), { runId: "run-1", body, noteRunner, now });
  assert.deepEqual(stale, {
    reason: "conflict",
    message: "Stale fencing token",
    detail: { reason: "stale-fence" },
  });
  assert.equal(calls[0], "note.runner");

  calls.length = 0;
  const waiting = await heartbeatRun(makeDb(authorityRun({
    status: RunStatus.WAITING_INBOX,
    leaseExpiresAt: null,
  })), { runId: "run-1", body: { ...body, fencingToken: "fence-1" }, noteRunner, now });
  assert.deepEqual(waiting, {
    reason: "conflict",
    message: "Run suspended for Inbox",
    detail: { code: "WAITING_INBOX" },
  });
});

test("heartbeat writes through live authority and returns cancellation through the same interface", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const makeDb = (run: LockedAuthorityRun) => databaseFor({
    $queryRaw: async () => [{ id: "run-1" }],
    run: {
      findFirst: async () => run,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { count: 1 };
      },
    },
  });
  const body = heartbeatInput.parse({
    runnerId: "runner-1",
    fencingToken: "fence-1",
    leaseSeconds: 60,
    processAlive: true,
  });
  const live = await heartbeatRun(makeDb(authorityRun()), {
    runId: "run-1", body, noteRunner: () => {}, now,
  });
  assert.deepEqual(live, { ok: true, cancellation: null, mechanicalCancellationPolicy: "refused" });
  assert.equal(writes[0]?.heartbeatAt, now);

  const requestedAt = new Date(now.getTime() - 1_000);
  const cancellation = await heartbeatRun(makeDb(authorityRun({
    cancelRequestId: "cancel-1",
    cancelReason: "stop",
    cancelRequestedAt: requestedAt,
  })), { runId: "run-1", body, noteRunner: () => {}, now });
  assert.deepEqual(cancellation, {
    ok: false,
    mechanicalCancellationPolicy: "refused",
    cancellation: { requestId: "cancel-1", reason: "stop", requestedAt },
  });
});

test("publication admits deterministic salvage after lease loss and keeps Run before Task lock order", async () => {
  const calls: string[] = [];
  const run = authorityRun({
    leaseExpiresAt: new Date(now.getTime() - 1_000),
    status: RunStatus.LOST,
  });
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => {
      const target = query.join("?").includes('FROM "Run"') ? "run" : "task";
      calls.push(`lock.${target}`);
      return [{ id: `${target}-1`, archivedAt: null }];
    },
    run: {
      findFirst: async ({ select }: { select: Record<string, unknown> }) => {
        if (select.runnerId) { calls.push("read.run"); return run; }
        calls.push("read.replacement");
        return null;
      },
      updateMany: async () => { calls.push("write.run"); return { count: 1 }; },
    },
    task: {
      findUnique: async () => { calls.push("read.task-identity"); return { projectId: "project-1", chainId: null }; },
      findUniqueOrThrow: async () => { calls.push("read.task"); return { id: "task-1" }; },
    },
  };

  const result = await publishRun(databaseFor(tx, calls), {
    runId: "run-1",
    now,
    body: {
      runnerId: "runner-1",
      fencingToken: "fence-1",
      pushedBranch: "agentos/task-1/run-1",
    },
  });

  assert.deepEqual(result, { ok: true, replacementRepair: "none" });
  assert.ok(calls.indexOf("lock.run") < calls.indexOf("lock.task"));
});

test("cleanup admits only the owning fence after live authority has ended", async () => {
  const writes: string[] = [];
  const makeDb = (run: LockedAuthorityRun) => databaseFor({
    $queryRaw: async () => [{ id: "run-1" }],
    run: {
      findFirst: async () => run,
      update: async () => { writes.push("run"); return {}; },
    },
    session: { updateMany: async () => { writes.push("session"); return { count: 1 }; } },
  });
  const body = {
    runnerId: "runner-1",
    fencingToken: "fence-1",
    cleanupStatus: "FAILED" as const,
    cleanupFailureReason: "retained",
    workspaceRetained: true,
  };

  const refused = await recordRunCleanup(makeDb(authorityRun()), { runId: "run-1", body, now });
  assert.deepEqual(refused, {
    reason: "conflict",
    message: "Cleanup outcome is not authorized for a live or foreign run",
  });
  assert.deepEqual(writes, []);

  const accepted = await recordRunCleanup(makeDb(authorityRun({ status: RunStatus.LOST })), {
    runId: "run-1", body, now,
  });
  assert.deepEqual(accepted, { ok: true });
  assert.deepEqual(writes, ["run", "session"]);
});

test("events normalize and persist through the lifecycle interface without changing seq order", async () => {
  const nul = "\u0000";
  const visibleNul = "\\u0000";
  const stored: Array<Record<string, unknown>> = [];
  const body = eventsInput.parse({
    runnerId: "runner-1",
    fencingToken: "fence-1",
    events: [
      {
        seq: 4,
        source: "CLAUDE",
        type: `EVENT${nul}TYPE`,
        providerEventId: `provider${nul}id`,
        toolCallId: `tool${nul}id`,
        payload: {
          unchanged: "plain text",
          nested: { message: `left${nul}right`, list: [`a${nul}b`, { deep: "value" }] },
          [`field${visibleNul}`]: "literal key value",
          [`field${nul}`]: "NUL key value",
          [`key${nul}`]: "key value",
        },
      },
      { seq: 9, source: "CLAUDE", type: "VALID", payload: { unchanged: "still exact" } },
    ],
  });

  const result = await appendRunEvents(eventDatabase({ stored }), { runId: "run-1", body, now });
  assert.deepEqual(result, { accepted: 2 });
  assert.deepEqual(stored.map((event) => event.seq), [4, 9]);
  assert.equal(stored[0]?.type, `EVENT${visibleNul}TYPE`);
  assert.equal(stored[0]?.providerEventId, `provider${visibleNul}id`);
  assert.equal(stored[0]?.toolCallId, `tool${visibleNul}id`);
  assert.deepEqual(stored[0]?.payload, {
    unchanged: "plain text",
    nested: { message: `left${visibleNul}right`, list: [`a${visibleNul}b`, { deep: "value" }] },
    [`field${visibleNul}`]: "literal key value",
    [`field${visibleNul}${visibleNul}`]: "NUL key value",
    [`key${visibleNul}`]: "key value",
  });
  assert.deepEqual(stored[1]?.payload, { unchanged: "still exact" });
});

test("FINAL_OUTPUT recomputes derived usage through the lifecycle interface", async () => {
  const sessionWrites: Array<Record<string, unknown>> = [];
  const result = await appendRunEvents(eventDatabase({
    finalOutputRows: [{ payload: finalOutputPayload }],
    sessionWrites,
  }), { runId: "run-1", body: eventBody(["MODEL_COMPLETED", "FINAL_OUTPUT"]), now });

  assert.deepEqual(result, { accepted: 2 });
  assert.equal(sessionWrites.length, 1);
  const write = sessionWrites[0] as { where: { id: string }; data: Record<string, unknown> };
  assert.equal(write.where.id, "session-1");
  assert.equal(write.data.inputTokens, 8_824);
  assert.equal(write.data.outputTokens, 77);
  assert.equal(write.data.cachedInputTokens, 8_700);
  assert.equal(write.data.cacheCreationInputTokens, 120);
  assert.equal(write.data.totalTokens, 8_901);
  assert.equal(String(write.data.costUsd), "0.0491");
});

test("events without FINAL_OUTPUT do not touch derived usage", async () => {
  const sessionWrites: Array<Record<string, unknown>> = [];
  const result = await appendRunEvents(eventDatabase({
    finalOutputRows: [{ payload: finalOutputPayload }],
    sessionWrites,
  }), { runId: "run-1", body: eventBody(["MODEL_COMPLETED", "TOOL_STARTED"]), now });

  assert.deepEqual(result, { accepted: 2 });
  assert.deepEqual(sessionWrites, []);
});

test("an observed native child is persisted independently of the launch grant", async () => {
  const sessionWrites: Array<Record<string, unknown>> = [];
  const result = await appendRunEvents(eventDatabase({ sessionWrites }), {
    runId: "run-1",
    body: eventBody(["NATIVE_CHILD_STARTED"]),
    now,
  });

  assert.deepEqual(result, { accepted: 1 });
  assert.deepEqual(sessionWrites, [{
    where: { id: "session-1" },
    data: { nativeChildUsed: true },
  }]);
});

test("a failing derived usage write does not fail event ingestion", async () => {
  const errors: unknown[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const result = await appendRunEvents(eventDatabase({
      finalOutputRows: [{ payload: finalOutputPayload }],
      onUsageUpdate: () => { throw new Error("value out of range for type integer"); },
    }), { runId: "run-1", body: eventBody(["FINAL_OUTPUT"]), now });
    assert.deepEqual(result, { accepted: 1 });
  } finally {
    console.error = consoleError;
  }
  assert.equal(errors.length, 1);
});

test("events decide WAITING_INBOX refusal before the locked transaction releases", async () => {
  let transactionOpen = false;
  let signalWaitingRead: (() => void) | undefined;
  let continueWaitingRead: (() => void) | undefined;
  const waitingReadStarted = new Promise<void>((resolve) => { signalWaitingRead = resolve; });
  const waitingReadAllowed = new Promise<void>((resolve) => { continueWaitingRead = resolve; });
  const calls: string[] = [];
  let findFirstCalls = 0;
  const tx = {
    $queryRaw: async () => { calls.push("lock.run"); return [{ id: "run-1" }]; },
    run: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        findFirstCalls += 1;
        if (findFirstCalls === 1) return null;
        assert.deepEqual(where, { id: "run-1", status: RunStatus.WAITING_INBOX });
        calls.push("read.waiting");
        signalWaitingRead?.();
        await waitingReadAllowed;
        assert.equal(transactionOpen, true);
        return { id: "run-1" };
      },
      findUnique: async () => ({
        runnerId: "runner-1",
        fencingToken: "fence-1",
        cancelRequestedAt: null,
        leaseExpiresAt: null,
        status: RunStatus.WAITING_INBOX,
      }),
    },
  };
  const database = {
    $transaction: async (operation: (client: unknown) => Promise<unknown>) => {
      transactionOpen = true;
      try {
        return await operation(tx);
      } finally {
        calls.push("transaction.release");
        transactionOpen = false;
      }
    },
    run: { findFirst: async () => { calls.push("outside.read"); return null; } },
  } as unknown as PrismaClient;

  const pending = appendRunEvents(database, {
    runId: "run-1",
    body: eventBody(["MODEL_COMPLETED"]),
    now,
  });
  await waitingReadStarted;
  assert.equal(transactionOpen, true);
  assert.equal(calls.includes("transaction.release"), false);
  continueWaitingRead?.();

  assert.deepEqual(await pending, {
    reason: "conflict",
    message: "Run suspended for Inbox",
    detail: { code: "WAITING_INBOX" },
  });
  assert.ok(calls.indexOf("read.waiting") < calls.indexOf("transaction.release"));
  assert.equal(calls.includes("outside.read"), false);
});

test("activity persists the authenticated principal through the lifecycle interface", async () => {
  let fencedRead = 0;
  const writes: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => query.join("?").includes('FROM "Run"')
      ? [{ id: "run-1" }]
      : [{ id: "task-1", archivedAt: null }],
    run: { findFirst: async () => {
      fencedRead += 1;
      return fencedRead === 1
        ? { taskId: "task-1" }
        : { taskId: "task-1", leaseGeneration: 1, task: { templateStep: null } };
    } },
    taskActivity: { create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(data);
      return { id: "activity-1", ...data };
    } },
  };

  const result = await appendRunActivity(databaseFor(tx), {
    runId: "run-1",
    now,
    principal: { kind: "session", runId: "run-1", leaseGeneration: 1 },
    body: { actorType: "operator", fencingToken: "fence-1", body: "progress" },
  });
  assert.equal("message" in result, false);
  assert.deepEqual(writes[0], {
    taskId: "task-1",
    actorType: "session",
    actorId: null,
    body: "progress",
  });
});

test("completion-rejection activity is bound to the authenticated Run", async () => {
  let fencedRead = 0;
  const writes: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => query.join("?").includes('FROM "Run"')
      ? [{ id: "run-1" }]
      : [{ id: "task-1", archivedAt: null }],
    run: { findFirst: async () => {
      fencedRead += 1;
      return fencedRead === 1
        ? { taskId: "task-1" }
        : {
            taskId: "task-1",
            leaseGeneration: 1,
            task: {
              templateStep: {
                stepIndex: 7,
                outputKind: "merge-result",
                taskTemplate: { name: "direct-engineer-workflow" },
              },
            },
          };
    } },
    taskActivity: { create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(data);
      return { id: "activity-1", ...data };
    } },
  };

  const result = await appendRunActivity(databaseFor(tx), {
    runId: "run-1",
    now,
    principal: { kind: "session", runId: "run-1", leaseGeneration: 1 },
    body: {
      actorType: "operator",
      fencingToken: "fence-1",
      body: "Mechanical completion rejected with HTTP 400: incompatible payload",
      metadata: {
        kind: "mergeExecutor.completionRejected",
        schemaVersion: 1,
        status: 400,
        responseBody: "incompatible payload",
        sourceRunId: "spoofed-run",
      },
    },
  });

  assert.equal("message" in result, false);
  assert.deepEqual(writes[0]?.metadata, {
    kind: "mergeExecutor.completionRejected",
    schemaVersion: 1,
    status: 400,
    responseBody: "incompatible payload",
    sourceRunId: "run-1",
  });
});

test("a fenced SESSION or merge-executor stopped result lands its question in the activity transaction", async () => {
  const taskUpdates: Array<Record<string, unknown>> = [];
  const questions: Array<Record<string, unknown>> = [];
  let runRead = 0;
  const metadata = {
    kind: MERGE_INTEGRATOR_KIND.result,
    schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
    outcome: "stopped",
    condition: "base-drift-post-merge",
    evidence: "merge commit landed before base verification",
  };
  const resultActivity = {
    id: "session-result-1",
    taskId: "task-1",
    createdAt: now,
    actorType: "session",
    actorId: "merge-executor-1",
    metadata: { ...metadata, sourceRunId: "run-1" },
  };
  const tx = {
    $queryRaw: async () => [{ id: "task-1" }],
    run: {
      findFirst: async () => {
        runRead += 1;
        return runRead === 1
          ? { taskId: "task-1" }
          : {
              taskId: "task-1",
              leaseGeneration: 1,
              agentId: "agent-1",
              session: { id: "session-1" },
              task: { templateStep: { stepIndex: 7, outputKind: "merge-result", taskTemplate: { name: "direct-engineer-workflow" } } },
            };
      },
      findUnique: async () => ({ taskId: "task-1", agentId: "agent-1", session: { id: "session-1" } }),
    },
    task: {
      findUnique: async () => ({
        id: "task-1",
        assigneeAgentId: "agent-1",
        chainId: "chain-1",
        chainIndex: 7,
        templateStep: { stepIndex: 7, outputKind: "merge-result", taskTemplate: { name: "direct-engineer-workflow" } },
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => { taskUpdates.push(data); return {}; },
    },
    taskActivity: {
      create: async () => resultActivity,
      findUnique: async () => resultActivity,
      findMany: async () => [],
    },
    inboxMessage: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        questions.push(data);
        return { id: "question-1" };
      },
    },
  };

  const result = await appendRunActivity(databaseFor(tx), {
    runId: "run-1",
    now,
    principal: { kind: "session", runId: "run-1", leaseGeneration: 1 },
    body: {
      actorType: "operator",
      actorId: "merge-executor-1",
      fencingToken: "fence-1",
      body: "Mechanical merge stopped: base-drift-post-merge",
      metadata,
    },
  });

  assert.equal("message" in result, false);
  assert.deepEqual(taskUpdates, [{
    status: "REVIEW",
    failureReason: "Mechanical merge stopped: base-drift-post-merge",
  }]);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.dedupeKey, "merge-stop:session-result-1");
  assert.deepEqual((questions[0]?.choices as Array<{ id: string }>).map((choice) => choice.id), ["accept", "revert"]);

  taskUpdates.length = 0;
  questions.length = 0;
  runRead = 0;
  const executorResult = await appendRunActivity(databaseFor(tx), {
    runId: "run-1",
    now,
    principal: { kind: "merge-executor" },
    body: {
      actorType: "operator",
      actorId: "merge-executor-1",
      fencingToken: "fence-1",
      body: "Mechanical merge stopped: base-drift-post-merge",
      metadata,
    },
  });
  assert.equal("message" in executorResult, false);
  assert.equal(taskUpdates.length, 1);
  assert.equal(questions.length, 1);
});

test("a fenced mechanical stopped result with malformed evidence is rejected before append", async () => {
  let activityWrites = 0;
  const tx = {
    $queryRaw: async () => [{ id: "run-1" }],
    run: { findFirst: async () => ({
      taskId: "task-1",
      leaseGeneration: 1,
      agentId: "agent-1",
      session: { id: "session-1" },
      task: { templateStep: { stepIndex: 7, outputKind: "merge-result", taskTemplate: { name: "direct-engineer-workflow" } } },
    }) },
    taskActivity: { create: async () => { activityWrites += 1; return {}; } },
  };
  const result = await appendRunActivity(databaseFor(tx), {
    runId: "run-1",
    now,
    principal: { kind: "session", runId: "run-1", leaseGeneration: 1 },
    body: {
      actorType: "operator",
      fencingToken: "fence-1",
      body: "malformed stopped result",
      metadata: {
        kind: MERGE_INTEGRATOR_KIND.result,
        schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
        outcome: "stopped",
        condition: "base-drift-post-merge",
      },
    },
  });
  assert.deepEqual(result, {
    reason: "conflict",
    message: "Stopped merge result metadata is malformed",
  });
  assert.equal(activityWrites, 0);
});
