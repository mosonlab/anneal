import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "@prisma/client";

import { requireDefaultFeishuThread } from "./default-feishu-thread.js";

const withDefaultChat = async <T>(value: string | undefined, run: () => Promise<T>): Promise<T> => {
  const previous = process.env["FEISHU_DEFAULT_CHAT_ID"];
  if (value === undefined) delete process.env["FEISHU_DEFAULT_CHAT_ID"];
  else process.env["FEISHU_DEFAULT_CHAT_ID"] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env["FEISHU_DEFAULT_CHAT_ID"];
    else process.env["FEISHU_DEFAULT_CHAT_ID"] = previous;
  }
};

test("default Feishu thread requires its configured chat and logs the failure", async () => {
  await withDefaultChat(undefined, async () => {
    let logged = "";
    const previousError = console.error;
    console.error = (...messages: unknown[]) => { logged = messages.join(" "); };
    try {
      await assert.rejects(
        () => requireDefaultFeishuThread({} as Prisma.TransactionClient),
        /FEISHU_DEFAULT_CHAT_ID is required/u,
      );
      assert.match(logged, /FEISHU_DEFAULT_CHAT_ID is required/u);
    } finally {
      console.error = previousError;
    }
  });
});

test("default Feishu thread reuses an existing shared thread", async () => {
  await withDefaultChat("oc_default", async () => {
    let created = false;
    const tx = {
      inboxThread: {
        findFirst: async ({ where }: { where: { channel: string; externalChatId: string; sessionId: null } }) => {
          assert.deepEqual(where, { channel: "FEISHU", externalChatId: "oc_default", sessionId: null });
          return { id: "thread-existing", externalChatId: "oc_default" };
        },
        upsert: async () => {
          created = true;
          return { id: "thread-created", externalChatId: "oc_default" };
        },
      },
    } as unknown as Prisma.TransactionClient;

    assert.deepEqual(await requireDefaultFeishuThread(tx), {
      id: "thread-existing",
      externalChatId: "oc_default",
    });
    assert.equal(created, false);
  });
});

test("concurrent first writers converge on one shared thread", async () => {
  await withDefaultChat("oc_default", async () => {
    const rows = new Map<string, { id: string; externalChatId: string }>();
    const tx = {
      inboxThread: {
        findFirst: async () => null,
        upsert: async ({ where, create }: {
          where: { id: string };
          create: { id: string; channel: string; externalChatId: string };
        }) => {
          assert.match(where.id, /^feishu-default-[a-f0-9]{64}$/u);
          assert.equal(where.id, create.id);
          assert.equal(create.channel, "FEISHU");
          rows.set(where.id, rows.get(where.id) ?? { id: create.id, externalChatId: create.externalChatId });
          return rows.get(where.id);
        },
      },
    } as unknown as Prisma.TransactionClient;

    const [first, second] = await Promise.all([requireDefaultFeishuThread(tx), requireDefaultFeishuThread(tx)]);
    assert.deepEqual(first, second);
    assert.equal(first.externalChatId, "oc_default");
    assert.equal(rows.size, 1);
  });
});
