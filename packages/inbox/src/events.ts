import {
  applyInboxDecisionTx,
  recordMergeEvidenceRefusal,
  InboxSender,
  InboxStatus,
  Prisma,
  type MergeExecutorObservation,
  type PrismaClient,
} from "@anneal/db";

export type FeishuEnvelope = {
  header?: { event_id?: string; event_type?: string };
  event?: Record<string, unknown>;
};

type EventResult = { duplicate: boolean; resumed: boolean; messageId?: string; unmatched?: boolean };

export type FeishuEventOptions = {
  /**
   * Read the API's shared daemon registry before opening the DB transaction.
   * Network-backed readers belong here, outside `applyInboxDecisionTx`.
   */
  readMergeExecutorLiveness?: () => Promise<MergeExecutorObservation>;
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

const textContent = (message: Record<string, unknown>): string | null => {
  const raw = string(message.content);
  if (!raw) return null;
  try { return string(record(JSON.parse(raw))?.text); } catch { return raw; }
};

export const eventIdentity = (envelope: FeishuEnvelope): { eventId: string; eventType: string } => {
  const event = envelope.event ?? {};
  const message = record(event.message);
  const action = record(event.action);
  const eventType = envelope.header?.event_type ?? (action ? "card.action.trigger" : "im.message.receive_v1");
  const eventId = envelope.header?.event_id ?? string(message?.message_id) ?? string(event.token);
  if (!eventId) throw new Error("Feishu event is missing event_id");
  return { eventId, eventType };
};

export const processFeishuEvent = async (
  db: PrismaClient,
  envelope: FeishuEnvelope,
  now = new Date(),
  options: FeishuEventOptions = {},
): Promise<EventResult> => {
  const { eventId, eventType } = eventIdentity(envelope);
  const event = envelope.event ?? {};
  const message = record(event.message);
  const action = record(event.action);
  // An unthreaded text event can still resolve to the sole OPEN card in its
  // chat, so every message event needs the same liveness observation as a
  // threaded reply. The reader is only invoked before the transaction.
  const mayBeDecision = action !== null || message !== null;
  // Confirmation cards are normally action events, but a text reply to a
  // card is also a possible decision. Pre-read those candidate events and
  // freeze the observation for the transaction; non-message events do not
  // perform a liveness request.
  let daemonSnapshot: MergeExecutorObservation = { observation: "unreadable", cause: "no-reader" };
  if (mayBeDecision && options.readMergeExecutorLiveness) {
    try {
      daemonSnapshot = await options.readMergeExecutorLiveness();
    } catch {
      console.error("Inbox executor liveness unreadable: unreachable");
      daemonSnapshot = { observation: "unreadable", cause: "unreachable" };
    }
  }
  try {
    return await db.$transaction(async (tx) => {
      await tx.inboxExternalEvent.create({ data: {
        channel: "FEISHU", externalEventId: eventId, eventType,
        payload: envelope as Prisma.InputJsonValue,
      } });
      const message = record(event.message);
      const action = record(event.action);
      const actionValue = record(action?.value);
      const explicitQuestionId = string(actionValue?.inboxMessageId);
      const externalReplyId = string(message?.parent_id) ?? string(message?.root_id);
      const chatId = string(message?.chat_id) ?? string(record(event.context)?.open_chat_id);
      const candidates = explicitQuestionId || externalReplyId || !chatId ? [] : await tx.inboxMessage.findMany({
        where: { thread: { externalChatId: chatId }, from: InboxSender.AGENT, status: InboxStatus.OPEN },
        include: { session: { include: { run: true } } },
        orderBy: { createdAt: "desc" },
        take: 2,
      });
      if (candidates.length > 1) throw new Error("Reply is ambiguous; reply to the specific Feishu card message");
      const question = explicitQuestionId
        ? await tx.inboxMessage.findUnique({ where: { id: explicitQuestionId }, include: { session: { include: { run: true } } } })
        : externalReplyId
          ? await tx.inboxMessage.findUnique({ where: { externalMessageId: externalReplyId }, include: { session: { include: { run: true } } } })
          : candidates[0] ?? null;
      const choiceId = string(actionValue?.choiceId);
      const answer = choiceId ?? (message ? textContent(message) : null);
      // Inbound text nobody is waiting on used to vanish into the audit table.
      // Land it as a plain human message on the chat's thread so the Inbox page
      // shows it; it stays out of the decision flow (no session, no gate).
      if (!question?.session?.run && choiceId === null && answer && chatId) {
        const thread = await tx.inboxThread.findFirst({ where: { channel: "FEISHU", externalChatId: chatId, sessionId: null } })
          ?? await tx.inboxThread.create({ data: { channel: "FEISHU", externalChatId: chatId } });
        const landed = await tx.inboxMessage.create({ data: {
          from: InboxSender.HUMAN,
          kind: "TEXT",
          body: answer,
          threadId: thread.id,
          status: InboxStatus.CLOSED,
          dedupeKey: `inbound:${eventId}`,
          externalMessageId: string(message?.message_id),
          deliveryStatus: "DELIVERED",
          deliveredAt: now,
        } });
        await tx.inboxExternalEvent.update({
          where: { channel_externalEventId: { channel: "FEISHU", externalEventId: eventId } }, data: { processedAt: now },
        });
        return { duplicate: false, resumed: false, unmatched: true, messageId: landed.id };
      }
      if (!question?.session?.run) throw new Error("No matching Inbox question");
      if (!answer) throw new Error("Inbox reply is empty");
      const result = await applyInboxDecisionTx(tx, {
        inboxMessageId: question.id,
        externalEventId: eventId,
        decision: answer,
        allowFreeText: choiceId === null,
        actorOpenId: string(record(event.operator)?.open_id) ?? string(record(record(event.sender)?.sender_id)?.open_id),
        externalMessageId: string(message?.message_id),
        // Preserve unreadable observations and their cause through rollback;
        // an empty observed fleet is a distinct, real offline observation.
        mergeExecutorLiveness: () => daemonSnapshot,
      }, now);
      await tx.inboxExternalEvent.update({
        where: { channel_externalEventId: { channel: "FEISHU", externalEventId: eventId } }, data: { processedAt: now },
      });
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { duplicate: true, resumed: false };
    }
    await recordMergeEvidenceRefusal(db, error);
    // The transaction above rolled back, taking the audit record with it.
    // Re-persist the raw event so unmatched inbound messages stay inspectable.
    await db.inboxExternalEvent.create({ data: {
      channel: "FEISHU", externalEventId: eventId, eventType,
      payload: envelope as Prisma.InputJsonValue,
    } }).catch(() => undefined);
    throw error;
  }
};
