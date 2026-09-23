import assert from "node:assert/strict";
import test from "node:test";

import { InboxDeliveryStatus, InboxStatus, type PrismaClient } from "@anneal/db";

import { deliverPending } from "./delivery.js";

test("delivery requires an OPEN message both when selecting and when claiming it", async () => {
  let sent = false;
  const db = {
    inboxMessage: {
      findMany: async (query: { where: { status?: string } }) => {
        assert.equal(query.where.status, InboxStatus.OPEN);
        return [{
          id: "message-1",
          status: InboxStatus.CLOSED,
          deliveryStatus: InboxDeliveryStatus.PENDING,
          deliveryAttempts: 0,
          body: "closed before delivery",
          choices: [],
          taskId: "task-1",
          thread: { externalChatId: "chat-1" },
        }];
      },
      updateMany: async (query: { where: { status?: string } }) => {
        assert.equal(query.where.status, InboxStatus.OPEN);
        return { count: 0 };
      },
    },
  } as unknown as PrismaClient;

  const result = await deliverPending(db, {
    send: async () => {
      sent = true;
      return { messageId: "external-1" };
    },
  });

  assert.deepEqual(result, { delivered: 0, failed: 0 });
  assert.equal(sent, false);
});

test("delivery cards show project, repository, Chain, reason, action, and the Inbox deep link", async () => {
  const cards: Record<string, unknown>[] = [];
  const messages = [
    {
      id: "decision-1",
      status: InboxStatus.OPEN,
      deliveryStatus: InboxDeliveryStatus.PENDING,
      deliveryAttempts: 0,
      body: "The change is ready to merge.",
      choices: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
      taskId: "task-1",
      thread: { externalChatId: "chat-1" },
      task: {
        name: "Review the release",
        chainId: "chain-abc",
        chainIndex: 2,
        project: { name: "Anneal" },
        repo: { name: "control-plane" },
      },
      gateTask: null,
      session: null,
      goal: null,
      agent: null,
    },
    {
      id: "notice-2",
      status: InboxStatus.OPEN,
      deliveryStatus: InboxDeliveryStatus.PENDING,
      deliveryAttempts: 0,
      body: "Autonomous merge tail stopped: target branch moved.",
      choices: null,
      taskId: "task-2",
      thread: { externalChatId: "chat-1" },
      task: null,
      gateTask: null,
      session: null,
      goal: { project: { name: "Budgeting" } },
      agent: null,
    },
    {
      id: "question-3",
      status: InboxStatus.OPEN,
      deliveryStatus: InboxDeliveryStatus.PENDING,
      deliveryAttempts: 0,
      body: "What should the agent name this branch?",
      choices: [],
      taskId: null,
      thread: { externalChatId: "chat-1" },
      task: null,
      gateTask: null,
      session: {
        waitingOnMessageId: "question-3",
        task: {
          name: "Answer release question",
          chainId: null,
          chainIndex: null,
          project: { name: "Console" },
          repo: null,
        },
      },
      goal: null,
      agent: null,
    },
  ];
  const db = {
    inboxMessage: {
      findMany: async (query: { include: Record<string, unknown> }) => {
        assert.deepEqual(query.include.session, { select: {
          waitingOnMessageId: true,
          task: { select: {
            name: true,
            chainId: true,
            chainIndex: true,
            project: { select: { name: true } },
            repo: { select: { name: true } },
          } },
        } });
        assert.deepEqual(query.include.task, { select: {
          name: true,
          chainId: true,
          chainIndex: true,
          project: { select: { name: true } },
          repo: { select: { name: true } },
        } });
        assert.ok(query.include.gateTask);
        assert.deepEqual(query.include.goal, { select: { project: { select: { name: true } } } });
        assert.deepEqual(query.include.agent, { select: { project: { select: { name: true } } } });
        return messages;
      },
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
    },
  } as unknown as PrismaClient;

  const result = await deliverPending(db, {
    send: async (_chatId, card) => {
      cards.push(card);
      return { messageId: `external-${cards.length}` };
    },
  });

  assert.deepEqual(result, { delivered: 3, failed: 0 });
  const elements = cards.map((card) => card.elements as Array<{ text?: { content?: string } }>);
  const content = elements.map((cardElements) => cardElements.map((element) => element.text?.content ?? "").join("\n"));
  const titles = cards.map((card) => ((card.header as { title?: { content?: string } }).title?.content));
  assert.equal(titles[0], "Anneal 需要你的决策");
  assert.equal(titles[1], "Anneal 需要人工处理");
  assert.equal(titles[2], "Anneal 需要你的回复");
  assert.match(content[0] ?? "", /项目：Anneal/u);
  assert.match(content[0] ?? "", /仓库：control-plane/u);
  assert.match(content[0] ?? "", /任务：Review the release/u);
  assert.match(content[0] ?? "", /Chain：chain-abc · Step 3/u);
  assert.match(content[0] ?? "", /\*\*原因 \/ 详情：\*\*\nThe change is ready to merge\./u);
  assert.match(content[0] ?? "", /需要决策：Approve \/ Reject/u);
  assert.match(content[0] ?? "", /\[打开 Inbox 处理\]\(https:\/\/agentos\.novelcatch\.com\/#\/inbox\/decision-1\)/u);
  assert.match(content[1] ?? "", /需要处理：需调查并在 Inbox 中处理/u);
  assert.match(content[1] ?? "", /项目：Budgeting/u);
  assert.doesNotMatch(content[1] ?? "", /需要回复/u);
  assert.match(content[1] ?? "", /https:\/\/agentos\.novelcatch\.com\/#\/inbox\/notice-2/u);
  assert.match(content[2] ?? "", /需要回复：请在 Inbox 中回复/u);
  assert.match(content[2] ?? "", /项目：Console\n任务：Answer release question/u);
  assert.ok(!(cards[1]?.elements as Array<{ tag?: string }>).some((element) => element.tag === "note"));
  assert.ok((cards[2]?.elements as Array<{ tag?: string }>).some((element) => element.tag === "note"));
});

test("a failed Feishu send records FAILED and retries without changing the stopped task", async () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const task = { status: "REVIEW" };
  const message = {
    id: "stopped-1", status: InboxStatus.OPEN, deliveryStatus: InboxDeliveryStatus.PENDING as string,
    deliveryAttempts: 0, nextDeliveryAt: now, taskId: "task-1", body: "Run budget exhausted",
    choices: null, thread: { externalChatId: "chat-1" }, task: null, gateTask: null,
    session: null, goal: null, agent: null,
  };
  const errors: unknown[][] = [];
  const previousError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const update = async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(message, data);
      return message;
    };
    const db = {
      inboxMessage: {
        findMany: async ({ where }: { where: { nextDeliveryAt: { lte: Date } } }) =>
          message.status === InboxStatus.OPEN && message.nextDeliveryAt <= where.nextDeliveryAt.lte
            ? [{ ...message }] : [],
        updateMany: async ({ where }: { where: { deliveryStatus: string; status: string } }) => {
          if (message.status !== where.status || message.deliveryStatus !== where.deliveryStatus) return { count: 0 };
          message.deliveryStatus = InboxDeliveryStatus.SENDING;
          message.deliveryAttempts += 1;
          return { count: 1 };
        },
        update,
      },
      $transaction: async (callback: (tx: { inboxMessage: { update: typeof update } }) => Promise<void>) =>
        callback({ inboxMessage: { update } }),
    } as unknown as PrismaClient;
    let sends = 0;
    const sender = { send: async (chatId: string) => {
      assert.equal(chatId, "chat-1");
      sends += 1;
      if (sends === 1) throw new Error("Feishu unavailable");
      return { messageId: "feishu-2" };
    } };

    assert.deepEqual(await deliverPending(db, sender, now), { delivered: 0, failed: 1 });
    assert.equal(message.deliveryStatus, InboxDeliveryStatus.FAILED);
    assert.equal(message.deliveryAttempts, 1);
    assert.match(String((message as { lastDeliveryError?: string }).lastDeliveryError), /Feishu unavailable/u);
    assert.equal(message.nextDeliveryAt.getTime(), now.getTime() + 30_000);
    assert.equal(task.status, "REVIEW");
    assert.match(String(errors[0]?.[0]), /Feishu delivery failed/u);

    assert.deepEqual(await deliverPending(db, sender, new Date(now.getTime() + 30_000)), { delivered: 1, failed: 0 });
    assert.equal(message.deliveryStatus, InboxDeliveryStatus.DELIVERED);
    assert.equal(sends, 2);
    assert.equal(task.status, "REVIEW");
  } finally {
    console.error = previousError;
  }
});
