import { AsyncLocalStorage } from "node:async_hooks";

import * as Lark from "@larksuiteoapi/node-sdk";
import {
  isArchivedAssigneeError,
  isArchivedTaskError,
  prisma,
} from "@anneal/db";
import { config as loadEnvironment } from "dotenv";

import { readMergeExecutorLiveness } from "./merge-executor-liveness.js";
import { deliverPending, type FeishuMessageClient } from "./delivery.js";
import { processFeishuEvent, type FeishuEnvelope } from "./events.js";
import { ConnectionSupervisor, type SocketCallbacks } from "./supervisor.js";

loadEnvironment({ path: new URL("../../../.env", import.meta.url), quiet: true });

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
if (!appId || !appSecret) throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required in the repository root .env");

await prisma.inboxMessage.updateMany({
  where: { deliveryStatus: "SENDING" },
  data: { deliveryStatus: "FAILED", nextDeliveryAt: new Date(), lastDeliveryError: "Inbox service restarted during delivery" },
});
const client = new Lark.Client({ appId, appSecret, domain: Lark.Domain.Feishu });
const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.info });
const headerContext = new AsyncLocalStorage<NonNullable<FeishuEnvelope["header"]>>();
const envelopeFor = (event: Record<string, unknown>): FeishuEnvelope => {
  const scoped = headerContext.getStore();
  const eventId = typeof event.event_id === "string" ? event.event_id : scoped?.event_id;
  const eventType = typeof event.event_type === "string" ? event.event_type : scoped?.event_type;
  return eventId || eventType ? { event, header: { ...(eventId ? { event_id: eventId } : {}), ...(eventType ? { event_type: eventType } : {}) } } : { event };
};

dispatcher.register({
  "im.message.receive_v1": async (data) => {
    const body = data as unknown as Record<string, unknown>;
    const message = body.message as Record<string, unknown> | undefined;
    if (message?.message_type !== "text") return;
    await processFeishuEvent(prisma, envelopeFor(body), new Date(), { readMergeExecutorLiveness });
  },
  "card.action.trigger": async (data: unknown) => {
    const event = data as Record<string, unknown>;
    try {
      const result = await processFeishuEvent(prisma, envelopeFor(event), new Date(), { readMergeExecutorLiveness });
      return { toast: { type: "success", content: result.duplicate ? "该决策已处理" : "决策已收到，任务将继续" } };
    } catch (error: unknown) {
      if (isArchivedAssigneeError(error) || isArchivedTaskError(error)) return { toast: { type: "error", content: error.message } };
      throw error;
    }
  },
});

type DispatcherInternals = { invoke(data: unknown, params?: unknown): Promise<unknown> };
const dispatcherInternals = dispatcher as unknown as DispatcherInternals;
const originalInvoke = dispatcherInternals.invoke.bind(dispatcherInternals);
dispatcherInternals.invoke = async (wsData: unknown, params?: unknown) => {
  // WSClient's DataCache has already decoded and merged all protobuf chunks
  // before invoke(); the full v2 envelope (including header.event_id) is here.
  const envelope = wsData as FeishuEnvelope;
  return envelope.header
    ? await headerContext.run(envelope.header, () => originalInvoke(wsData, params))
    : await originalInvoke(wsData, params);
};

const sender: FeishuMessageClient = {
  send: async (chatId, card) => {
    const response = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
    });
    if (response.code !== undefined && response.code !== 0) throw new Error(`Feishu API ${response.code}: ${response.msg ?? "unknown"}`);
    const messageId = response.data?.message_id;
    if (!messageId) throw new Error("Feishu send response omitted message_id");
    return { messageId };
  },
};

let deliveryBusy = false;
const deliveryTimer = setInterval(() => {
  if (deliveryBusy) return;
  deliveryBusy = true;
  void deliverPending(prisma, sender).catch((error: unknown) => console.error("Inbox outbox poll failed", error))
    .finally(() => { deliveryBusy = false; });
}, Number.parseInt(process.env.INBOX_DELIVERY_POLL_MS ?? "2000", 10));

const supervisor = new ConnectionSupervisor((callbacks: SocketCallbacks) => {
  const ws = new Lark.WSClient({
    appId, appSecret, domain: Lark.Domain.Feishu, loggerLevel: Lark.LoggerLevel.info,
    onReady: callbacks.onReady,
    onError: callbacks.onError,
    onReconnecting: callbacks.onReconnecting,
    onReconnected: callbacks.onReconnected,
  });
  return {
    start: () => ws.start({ eventDispatcher: dispatcher }),
    close: () => { ws.close({ force: true }); },
  };
}, (event, detail) => {
  const state = supervisor.state.snapshot();
  console.log(`Inbox connection ${event}; state=${state.state}; reconnects=${state.reconnectCount}`, detail ?? "");
});
const socket = supervisor.start();
void deliverPending(prisma, sender).catch((error: unknown) => console.error("Initial Inbox outbox poll failed", error));

const shutdown = async (): Promise<void> => {
  clearInterval(deliveryTimer);
  supervisor.stop(socket);
  await prisma.$disconnect();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
