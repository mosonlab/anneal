import assert from "node:assert/strict";
import test from "node:test";

import { CleanupStatus, InboxDeliveryStatus, InboxStatus, RunStatus, SessionExecutionStatus, TaskStatus } from "@anneal/db";

import { terminalFieldsFor, terminalizeRun, type TerminalOutcome } from "./run-terminal.js";

process.env.FEISHU_DEFAULT_CHAT_ID ??= "api-unit-test-default-chat";

const at = new Date("2026-08-27T12:00:00.000Z");
const reason = "terminal reason";

const cases: Array<{
  name: string;
  outcome: TerminalOutcome;
  run: string[];
  session: string[];
}> = [
  {
    name: "cancelled",
    outcome: { kind: "cancelled", requestId: "cancel-1", cleanupConfirmed: true, activity: "acknowledged" },
    run: [
      "status", "endedAt", "leaseExpiresAt", "sessionTokenRevokedAt", "cancelAcknowledgedAt",
      "failureClass", "failureReason", "terminationReason", "retryable", "retryAt", "workspaceRetained",
    ],
    session: [
      "executionStatus", "cleanupStatus", "endedAt", "cleanupEndedAt", "failureReason", "terminationReason",
    ],
  },
  {
    name: "lost",
    outcome: { kind: "lost", where: { id: "run-1" }, reason, maxRunsPerTask: 4, budgetGrants: 1 },
    run: [
      "status", "endedAt", "leaseExpiresAt", "sessionTokenRevokedAt", "failureClass", "retryable",
      "maxRunsPerTask", "budgetGrants", "failureReason",
    ],
    session: ["executionStatus", "cleanupStatus", "endedAt", "failureReason"],
  },
  {
    name: "timed-out",
    outcome: { kind: "timed-out", sessionId: "session-1", waitingOnMessageId: "message-1", taskId: "task-1", reason },
    run: ["status", "endedAt", "retryable", "failureClass", "failureReason"],
    session: ["executionStatus", "cleanupStatus", "endedAt", "cleanupEndedAt", "failureReason"],
  },
  {
    name: "completed",
    outcome: {
      kind: "completed",
      where: { id: "run-1" },
      status: RunStatus.SUCCEEDED,
      run: { retryable: false },
      sessionId: "session-1",
      session: { cleanupStatus: CleanupStatus.SUCCEEDED },
    },
    run: ["status", "endedAt", "leaseExpiresAt", "sessionTokenRevokedAt", "retryable"],
    session: ["executionStatus", "endedAt", "cleanupEndedAt", "cleanupStatus"],
  },
];

for (const row of cases) {
  test(`${row.name} writes exactly its Run and Session terminal fields`, () => {
    const fields = terminalFieldsFor(row.outcome, at);
    assert.deepEqual(Object.keys(fields.run), row.run);
    assert.deepEqual(Object.keys(fields.session), row.session);
  });
}

test("timed-out Inbox wait closes its question and writes one threaded, deduped human-stop card", async () => {
  let runSettlements = 0;
  const notices = new Map<string, Record<string, any>>();
  const writes: Array<{ target: string; data: Record<string, any> }> = [];
  const tx = {
    run: {
      updateMany: async ({ data }: { data: Record<string, any> }) => {
        writes.push({ target: "run", data });
        runSettlements += 1;
        return { count: runSettlements === 1 ? 1 : 0 };
      },
    },
    session: {
      updateMany: async ({ data }: { data: Record<string, any> }) => { writes.push({ target: "session", data }); return { count: 1 }; },
    },
    task: {
      update: async ({ data }: { data: Record<string, any> }) => { writes.push({ target: "task", data }); return {}; },
    },
    taskActivity: { create: async () => ({}) },
    inboxThread: { findFirst: async () => ({ id: "default-thread", externalChatId: "api-unit-test-default-chat" }) },
    inboxMessage: {
      updateMany: async ({ data }: { data: Record<string, any> }) => { writes.push({ target: "question", data }); return { count: 1 }; },
      upsert: async ({ where, create, update }: {
        where: { dedupeKey: string };
        create: Record<string, any>;
        update: Record<string, any>;
      }) => {
        const current = notices.get(where.dedupeKey);
        const next = current
          ? { ...current, ...update }
          : { status: InboxStatus.OPEN, deliveryStatus: InboxDeliveryStatus.PENDING, ...create };
        notices.set(where.dedupeKey, next);
        return next;
      },
    },
  } as any;
  const input = {
    runId: "run-timeout-1",
    at,
    outcome: {
      kind: "timed-out" as const,
      sessionId: "session-1",
      waitingOnMessageId: "question-1",
      taskId: "task-1",
      reason: "Inbox response window expired",
    },
  };

  const result = await terminalizeRun(tx, input);
  if (!result || !("status" in result)) throw new Error("Expected a terminalized Run");
  assert.equal(result.status, RunStatus.TIMED_OUT);
  assert.equal(writes.find((write) => write.target === "run")?.data.status, RunStatus.TIMED_OUT);
  assert.equal(writes.find((write) => write.target === "session")?.data.executionStatus, SessionExecutionStatus.TIMED_OUT);
  assert.equal(writes.find((write) => write.target === "question")?.data.status, InboxStatus.CLOSED);
  assert.equal(writes.find((write) => write.target === "task")?.data.status, TaskStatus.REVIEW);

  const dedupeKey = "inbox-timeout:run-timeout-1";
  const notice = notices.get(dedupeKey);
  assert.equal(notices.size, 1);
  assert.equal(notice?.status, InboxStatus.OPEN);
  assert.equal(notice?.deliveryStatus, InboxDeliveryStatus.PENDING);
  assert.equal(notice?.threadId, "default-thread");
  assert.equal(notice?.dedupeKey, dedupeKey);

  assert.equal(await terminalizeRun(tx, input), null, "the terminal Run fence rejects a duplicate timeout trigger");
  assert.equal(notices.size, 1, "a duplicate trigger cannot create another stop card");
});
