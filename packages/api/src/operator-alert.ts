import { InboxStatus, Prisma, requireDefaultFeishuThread } from "@anneal/db";

export const hasOpenOperatorAlert = async (
  tx: Prisma.TransactionClient,
  dedupeKeyPrefix: string,
): Promise<boolean> => await tx.inboxMessage.findFirst({
  where: {
    status: InboxStatus.OPEN,
    dedupeKey: { startsWith: dedupeKeyPrefix },
  },
  select: { id: true },
}) !== null;

export const openOperatorAlert = async (
  tx: Prisma.TransactionClient,
  input: { body: string; dedupeKey: string },
): Promise<void> => {
  const thread = await requireDefaultFeishuThread(tx);
  await tx.inboxMessage.create({
    data: {
      from: "AGENT",
      kind: "TEXT",
      body: input.body,
      dedupeKey: input.dedupeKey,
      threadId: thread.id,
    },
  });
};
