import { InboxDeliveryStatus, InboxStatus, Prisma, type PrismaClient } from "@anneal/db";

import { questionCard, type Choice } from "./cards.js";

export interface FeishuMessageClient {
  send(chatId: string, content: Record<string, unknown>): Promise<{ messageId: string }>;
}

const choicesOf = (value: Prisma.JsonValue | null): Choice[] => Array.isArray(value)
  ? value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    return typeof item.id === "string" && typeof item.label === "string" ? [{ id: item.id, label: item.label }] : [];
  }) : [];

const deliveryTaskContext = {
  name: true,
  chainId: true,
  chainIndex: true,
  project: { select: { name: true } },
  repo: { select: { name: true } },
} satisfies Prisma.TaskSelect;

export const deliverPending = async (
  db: PrismaClient,
  client: FeishuMessageClient,
  now = new Date(),
  limit = 20,
): Promise<{ delivered: number; failed: number }> => {
  const messages = await db.inboxMessage.findMany({
    where: {
      from: "AGENT",
      status: InboxStatus.OPEN,
      deliveryStatus: { in: [InboxDeliveryStatus.PENDING, InboxDeliveryStatus.FAILED] },
      nextDeliveryAt: { lte: now },
      thread: { isNot: null },
    },
    include: {
      thread: true,
      task: { select: deliveryTaskContext },
      gateTask: { select: deliveryTaskContext },
      session: { select: { waitingOnMessageId: true, task: { select: deliveryTaskContext } } },
      goal: { select: { project: { select: { name: true } } } },
      agent: { select: { project: { select: { name: true } } } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let delivered = 0;
  let failed = 0;
  for (const message of messages) {
    const won = await db.inboxMessage.updateMany({
      where: { id: message.id, status: InboxStatus.OPEN, deliveryStatus: message.deliveryStatus },
      data: { deliveryStatus: InboxDeliveryStatus.SENDING, deliveryAttempts: { increment: 1 } },
    });
    if (won.count !== 1 || !message.thread) continue;
    try {
      const task = message.task ?? message.gateTask ?? message.session?.task;
      const sent = await client.send(message.thread.externalChatId, questionCard({
        id: message.id,
        body: message.body,
        choices: choicesOf(message.choices),
        replyRequired: message.session?.waitingOnMessageId === message.id,
        projectName: task?.project.name ?? message.goal?.project.name ?? message.agent?.project.name ?? null,
        repoName: task?.repo?.name ?? null,
        taskName: task?.name ?? null,
        chainId: task?.chainId ?? null,
        chainIndex: task?.chainIndex ?? null,
      }));
      await db.inboxMessage.update({ where: { id: message.id }, data: {
        deliveryStatus: InboxDeliveryStatus.DELIVERED,
        externalMessageId: sent.messageId,
        deliveredAt: new Date(),
        lastDeliveryError: null,
      } });
      delivered += 1;
    } catch (error: unknown) {
      const attempts = message.deliveryAttempts + 1;
      const detail = error instanceof Error ? error.message : String(error);
      const delay = Math.min(30_000 * (2 ** Math.max(0, attempts - 1)), 15 * 60_000);
      await db.$transaction(async (tx) => {
        await tx.inboxMessage.update({ where: { id: message.id }, data: {
          deliveryStatus: InboxDeliveryStatus.FAILED,
          nextDeliveryAt: new Date(now.getTime() + delay),
          lastDeliveryError: detail.slice(0, 4000),
        } });
        if (attempts === 5 && message.taskId) await tx.taskActivity.create({ data: {
          taskId: message.taskId,
          actorType: "inbox",
          body: `Feishu delivery failed ${attempts} times; operator attention required`,
          metadata: { inboxMessageId: message.id, error: detail },
        } });
      });
      console.error(`Feishu delivery failed for InboxMessage ${message.id} (attempt ${attempts})`, error);
      failed += 1;
    }
  }
  return { delivered, failed };
};
