import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import { createApp } from "../test-app.js";

const withHealthEnvironment = async (
  chatId: string | null,
  operation: (errors: unknown[][]) => Promise<void>,
): Promise<void> => {
  const previousChatId = process.env.FEISHU_DEFAULT_CHAT_ID;
  const previousConsoleError = console.error;
  const errors: unknown[][] = [];
  if (chatId === null) delete process.env.FEISHU_DEFAULT_CHAT_ID;
  else process.env.FEISHU_DEFAULT_CHAT_ID = chatId;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await operation(errors);
  } finally {
    console.error = previousConsoleError;
    if (previousChatId === undefined) delete process.env.FEISHU_DEFAULT_CHAT_ID;
    else process.env.FEISHU_DEFAULT_CHAT_ID = previousChatId;
  }
};

test("health fails and logs when the default Feishu chat is unconfigured", async () => {
  await withHealthEnvironment(null, async (errors) => {
    let threadLookups = 0;
    const db = {
      $queryRaw: async () => [],
      inboxThread: { findFirst: async () => { threadLookups += 1; return null; } },
    } as unknown as PrismaClient;

    const response = await createApp(db).request("/health");

    assert.equal(response.status, 503);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.status, "error");
    assert.equal(body.database, "connected");
    assert.equal(body.defaultFeishuThread, "unconfigured");
    assert.equal(typeof body.checkedAt, "string");
    assert.equal(threadLookups, 0);
    assert.match(String(errors[0]?.[0]), /default Feishu notification thread is unconfigured/u);
  });
});

test("health fails and logs when the configured default Feishu thread is absent", async () => {
  await withHealthEnvironment("  default-chat-1  ", async (errors) => {
    let lookup: unknown;
    const db = {
      $queryRaw: async () => [],
      inboxThread: { findFirst: async (query: unknown) => { lookup = query; return null; } },
    } as unknown as PrismaClient;

    const response = await createApp(db).request("/health");
    const body = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 503);
    assert.equal(body.status, "error");
    assert.equal(body.database, "connected");
    assert.equal(body.defaultFeishuThread, "missing");
    assert.deepEqual(lookup, {
      where: { channel: "FEISHU", externalChatId: "default-chat-1", sessionId: null },
      select: { id: true },
    });
    assert.match(String(errors[0]?.[0]), /default Feishu notification thread is missing/u);
  });
});

test("health stays healthy when the default Feishu thread exists", async () => {
  await withHealthEnvironment("default-chat-1", async (errors) => {
    const db = {
      $queryRaw: async () => [],
      inboxThread: { findFirst: async () => ({ id: "thread-1" }) },
    } as unknown as PrismaClient;

    const response = await createApp(db).request("/health");

    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.equal(body.database, "connected");
    assert.equal(body.defaultFeishuThread, undefined);
    assert.equal(errors.length, 0);
  });
});

test("health reports a failed default-thread lookup as unavailable and logs the database error", async () => {
  await withHealthEnvironment("default-chat-1", async (errors) => {
    const db = {
      $queryRaw: async () => [],
      inboxThread: { findFirst: async () => { throw new Error("thread table unavailable"); } },
    } as unknown as PrismaClient;

    const response = await createApp(db).request("/health");

    assert.equal(response.status, 503);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.database, "connected");
    assert.equal(body.defaultFeishuThread, "unavailable");
    assert.match(String(errors[0]?.[0]), /default Feishu notification thread lookup failed/u);
  });
});
