import assert from "node:assert/strict";
import test from "node:test";

import { MergeEvidenceError, Prisma, type PrismaClient } from "@anneal/db";

import { eventIdentity, processFeishuEvent, type FeishuEnvelope } from "./events.js";

const envelope: FeishuEnvelope = {
  header: { event_id: "evt-1", event_type: "card.action.trigger" },
  event: { action: { value: { inboxMessageId: "question-1", choiceId: "approve" } }, operator: { open_id: "ou-1" } },
};

type CandidateQuery = {
  where: {
    thread: { externalChatId: string };
    from: string;
    status: string;
    session: unknown;
  };
  take: number;
};

type CandidateCard = {
  id: string;
  status: string;
  session: { run: { status: string } } | null;
};

const openDefaultThreadStopCards = (): CandidateCard[] => [
  { id: "sessionless-stop-notice", status: "OPEN", session: null },
  { id: "completed-run-stop-notice", status: "OPEN", session: { run: { status: "SUCCEEDED" } } },
];

const answerableCandidates = (query: CandidateQuery, openCards: CandidateCard[]): CandidateCard[] => {
  assert.deepEqual(query.where, {
    thread: { externalChatId: "oc-default" },
    from: "AGENT",
    status: "OPEN",
    session: { is: { run: { is: { status: "WAITING_INBOX" } } } },
  });
  assert.equal(query.take, 2);
  return openCards
    .filter((card) => card.status === query.where.status && card.session?.run.status === "WAITING_INBOX")
    .slice(0, query.take);
};

test("event_id is the stable Feishu dedupe identity", () => {
  assert.deepEqual(eventIdentity(envelope), { eventId: "evt-1", eventType: "card.action.trigger" });
});

test("inbound text nobody is waiting on lands as a visible human message", async () => {
  let landed: Record<string, unknown> | undefined;
  let livenessReads = 0;
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
  }, new Date(), {
    readMergeExecutorLiveness: async () => {
      livenessReads += 1;
      return [];
    },
  });
  assert.deepEqual(result, { duplicate: false, resumed: false, unmatched: true, messageId: "inbound-1" });
  assert.equal(landed?.from, "HUMAN");
  assert.equal(landed?.body, "怎么样了？");
  assert.equal(landed?.threadId, "thread-9");
  // Unmatched text is inert: no session, no gate, nothing to decide.
  assert.equal(landed?.sessionId, undefined);
  assert.equal(landed?.status, "CLOSED");
  assert.equal(livenessReads, 1, "an unthreaded message still receives the liveness observation before candidate lookup");
});

test("unthreaded text selects the waiting Inbox question when the default thread also has OPEN stop notices", async () => {
  let decision: Record<string, unknown> | undefined;
  let humanReply: Record<string, unknown> | undefined;
  const question = {
    id: "inbox-ask-1", from: "AGENT", kind: "MULTIPLE_CHOICE", status: "OPEN",
    agentId: "agent-1", sessionId: "session-1", taskId: "task-1", goalId: null,
    threadId: "default-thread", gateTaskId: null, dedupeKey: "inbox-ask:1",
    body: "Should I continue?", choices: [{ id: "continue", label: "Continue" }],
    session: { id: "session-1", run: { id: "run-waiting", status: "WAITING_INBOX" } },
    gateTask: null, thread: { externalChatId: "oc-default" },
  };
  const openCards = [...openDefaultThreadStopCards(), question];
  const tx = {
    inboxExternalEvent: { create: async () => ({}), update: async () => ({}) },
    inboxMessage: {
      findMany: async (query: CandidateQuery) => answerableCandidates(query, openCards),
      findUnique: async () => question,
      updateMany: async () => ({ count: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        humanReply = data;
        return { id: "reply-1" };
      },
    },
    inboxDecision: { create: async ({ data }: { data: Record<string, unknown> }) => { decision = data; return { id: "decision-1" }; } },
    run: { updateMany: async () => ({ count: 1 }) },
    session: { update: async () => ({}) },
  };
  const db = {
    $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;

  const result = await processFeishuEvent(db, {
    header: { event_id: "evt-ask-with-stop", event_type: "im.message.receive_v1" },
    event: { message: { message_id: "om-answer", chat_id: "oc-default", content: JSON.stringify({ text: "继续" }) } },
  });

  assert.deepEqual(result, { duplicate: false, resumed: true, messageId: "reply-1" });
  assert.deepEqual(openCards.map((card) => card.id), [
    "sessionless-stop-notice", "completed-run-stop-notice", "inbox-ask-1",
  ]);
  assert.equal(decision?.inboxMessageId, "inbox-ask-1");
  assert.equal(decision?.decision, "继续");
  assert.equal(humanReply?.replyToMessageId, "inbox-ask-1");
});

test("OPEN stop notices alone do not turn unthreaded text into Inbox decisions", async () => {
  let landed: Record<string, unknown> | undefined;
  let decisionWrites = 0;
  const stopCards = openDefaultThreadStopCards();
  const tx = {
    inboxExternalEvent: { create: async () => ({}), update: async () => ({}) },
    inboxMessage: {
      findMany: async (query: CandidateQuery) => answerableCandidates(query, stopCards),
      create: async ({ data }: { data: Record<string, unknown> }) => { landed = data; return { id: "inbound-1", ...data }; },
    },
    inboxDecision: { create: async () => { decisionWrites += 1; return {}; } },
    inboxThread: { findFirst: async () => ({ id: "default-thread" }), create: async () => ({ id: "unexpected-thread" }) },
  };
  const db = {
    $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;

  const result = await processFeishuEvent(db, {
    header: { event_id: "evt-stop-only", event_type: "im.message.receive_v1" },
    event: { message: { message_id: "om-stop-reply", chat_id: "oc-default", content: JSON.stringify({ text: "处理一下" }) } },
  });

  assert.deepEqual(result, { duplicate: false, resumed: false, unmatched: true, messageId: "inbound-1" });
  assert.deepEqual(stopCards.map((card) => card.status), ["OPEN", "OPEN"]);
  assert.equal(landed?.from, "HUMAN");
  assert.equal(landed?.threadId, "default-thread");
  assert.equal(landed?.status, "CLOSED");
  assert.equal(decisionWrites, 0);
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
