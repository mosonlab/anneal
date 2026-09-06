import assert from "node:assert/strict";
import test from "node:test";

import { MergeEvidenceError, Prisma, type PrismaClient } from "@anneal/db";

import { eventIdentity, processFeishuEvent, type FeishuEnvelope } from "./events.js";

const envelope: FeishuEnvelope = {
  header: { event_id: "evt-1", event_type: "card.action.trigger" },
  event: { action: { value: { inboxMessageId: "question-1", choiceId: "approve" } }, operator: { open_id: "ou-1" } },
};

test("event_id is the stable Feishu dedupe identity", () => {
  assert.deepEqual(eventIdentity(envelope), { eventId: "evt-1", eventType: "card.action.trigger" });
});

test("inbound text nobody is waiting on lands as a visible human message", async () => {
  let landed: Record<string, unknown> | undefined;
  const tx = {
    inboxExternalEvent: { create: async () => ({}), update: async () => ({}) },
    inboxMessage: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => { landed = data; return { id: "inbound-1", ...data }; },
    },
    inboxThread: { findFirst: async () => null, create: async () => ({ id: "thread-9" }) },
  };
  const db = {
    $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  const result = await processFeishuEvent(db, {
    header: { event_id: "evt-9", event_type: "im.message.receive_v1" },
    event: { message: { message_id: "om-9", chat_id: "oc-1", content: JSON.stringify({ text: "怎么样了？" }) } },
  });
  assert.deepEqual(result, { duplicate: false, resumed: false, unmatched: true, messageId: "inbound-1" });
  assert.equal(landed?.from, "HUMAN");
  assert.equal(landed?.body, "怎么样了？");
  assert.equal(landed?.threadId, "thread-9");
  // Unmatched text is inert: no session, no gate, nothing to decide.
  assert.equal(landed?.sessionId, undefined);
  assert.equal(landed?.status, "CLOSED");
});

test("a card click that matches nothing still fails loudly instead of being filed", async () => {
  const tx = {
    inboxExternalEvent: { create: async () => ({}), update: async () => ({}) },
    inboxMessage: { findUnique: async () => null, create: async () => { throw new Error("must not file a card click"); } },
    inboxThread: { findFirst: async () => null, create: async () => ({ id: "thread-9" }) },
  };
  const db = {
    $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
    inboxExternalEvent: { create: async () => ({}) },
  } as unknown as PrismaClient;
  await assert.rejects(() => processFeishuEvent(db, envelope), /No matching Inbox question/);
});

test("duplicate external event is acknowledged without a second resume", async () => {
  let transactions = 0;
  const db = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
      transactions += 1;
      if (transactions === 2) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
      return operation(tx);
    },
  } as unknown as PrismaClient;
  let resumeWrites = 0;
  const tx = {
    inboxExternalEvent: { create: async () => ({}), update: async () => ({}) },
    inboxMessage: {
      findUnique: async () => ({
        id: "question-1", agentId: "agent-1", sessionId: "session-1", taskId: "task-1", goalId: null, threadId: "thread-1",
        session: { id: "session-1", run: { id: "run-1", status: "WAITING_INBOX" } },
      }),
      updateMany: async () => ({ count: 1 }),
      create: async () => ({ id: "reply-1" }),
    },
    inboxDecision: { create: async () => ({}) },
    run: { updateMany: async () => { resumeWrites += 1; return { count: 1 }; } },
    session: { update: async () => ({}) },
  };
  // Replace the first transaction callback's tx without requiring a database.
  (db.$transaction as unknown as (operation: (value: unknown) => Promise<unknown>) => Promise<unknown>) = async (operation) => {
    transactions += 1;
    if (transactions === 2) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
    return operation(tx);
  };
  assert.equal((await processFeishuEvent(db, envelope)).resumed, true);
  assert.deepEqual(await processFeishuEvent(db, envelope), { duplicate: true, resumed: false });
  assert.equal(resumeWrites, 1);
});

test("Feishu retains the named base refusal after rollback alongside the raw event", async () => {
  const refusal = { taskId: "readiness", metadata: {
    kind: "gate-attestation-base-mismatch", attestedBaseSha: "old", authorizationBaseSha: "new",
  } };
  const error = new MergeEvidenceError("gate-attestation-base-mismatch: approval refused", refusal);
  const events: string[] = [];
  const db = {
    $transaction: async () => { events.push("rollback"); throw error; },
    taskActivity: { create: async ({ data }: { data: unknown }) => {
      events.push("activity");
      assert.deepEqual(data, { ...refusal, actorType: "control-plane", body: error.message });
    } },
    inboxExternalEvent: { create: async () => { events.push("raw-event"); } },
  } as unknown as PrismaClient;
  await assert.rejects(() => processFeishuEvent(db, envelope), (caught: unknown) => caught === error);
  assert.deepEqual(events, ["rollback", "activity", "raw-event"]);
});
