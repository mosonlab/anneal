import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

/** Resolve the configured default Feishu chat to its shared Inbox thread. */
export const requireDefaultFeishuThread = async (
  tx: Prisma.TransactionClient,
): Promise<{ id: string; externalChatId: string }> => {
  const externalChatId = process.env["FEISHU_DEFAULT_CHAT_ID"]?.trim();
  if (!externalChatId) {
    const message = "FEISHU_DEFAULT_CHAT_ID is required to bind a human-needed Inbox message";
    console.error(message);
    throw new Error(message);
  }

  const where = { channel: "FEISHU" as const, externalChatId, sessionId: null };
  const existing = await tx.inboxThread.findFirst({
    where,
    select: { id: true, externalChatId: true },
  });
  if (existing) return existing;

  // PostgreSQL treats NULL values in the sessionId composite unique index as
  // distinct. A stable primary key makes concurrent first writers converge.
  const id = `feishu-default-${createHash("sha256").update(externalChatId).digest("hex")}`;
  return tx.inboxThread.upsert({
    where: { id },
    create: { id, channel: "FEISHU", externalChatId },
    update: {},
    select: { id: true, externalChatId: true },
  });
};
