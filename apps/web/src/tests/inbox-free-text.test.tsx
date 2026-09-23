import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";

import { mountPage } from "./dom-harness";
import type { InboxMessage } from "../lib/types";

const now = "2026-08-27T00:00:00.000Z";

const card = (overrides: Partial<InboxMessage> & Pick<InboxMessage, "id" | "body">): InboxMessage => ({
  from: "AGENT", agentId: "agent-1", sessionId: "session-1",
  taskId: "task-1", goalId: null, gateTaskId: null, acceptsFreeText: true, dismissible: false,
  artifactTaskId: null, threadId: "thread-1", replyToMessageId: null, kind: "MULTIPLE_CHOICE",
  choices: [{ id: "continue", label: "Continue" }, { id: "revise", label: "Revise" }],
  selectedChoiceId: null, status: "OPEN", channel: "FEISHU", deliveryStatus: "DELIVERED",
  deliveryAttempts: 1, lastDeliveryError: null, createdAt: now, answeredAt: null, decisions: [], replies: [],
  ...overrides,
});

type Post = { path: string; body: Record<string, unknown> };

const renderThread = async (message: InboxMessage, posts: Post[] = []) => {
  const [{ InboxThreadPage }, { ProjectProvider }] = await Promise.all([import("../pages/Inbox"), import("../lib/project")]);
  const page = await mountPage(
    <ProjectProvider><InboxThreadPage messageId={message.id} /></ProjectProvider>,
    { "*": async ({ input, init, method }) => {
      const path = String(input).replace(/^.*\/api/, "");
      if (method === "POST") {
        posts.push({ path, body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> });
        return new Response("{}", { status: 200 });
      }
      if (path === `/inbox/messages/${message.id}`) return new Response(JSON.stringify(message), { status: 200 });
      return new Response("[]", { status: 200 });
    } },
    `http://127.0.0.1:5173/inbox/${message.id}`,
  );
  return page;
};

const fill = async (page: Awaited<ReturnType<typeof renderThread>>, value: string): Promise<void> => {
  const textarea = page.container.querySelector("textarea");
  assert.ok(textarea, "the card should render a text box");
  const setter = Object.getOwnPropertyDescriptor(page.dom.window.HTMLTextAreaElement.prototype, "value")?.set;
  assert.ok(setter);
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new page.dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  });
};

const button = (page: Awaited<ReturnType<typeof renderThread>>, label: string): HTMLButtonElement => {
  const found = [...page.container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  assert.ok(found, `missing button ${label}`);
  return found as HTMLButtonElement;
};

test("an open choice card renders choices and a separate free-text reply", async () => {
  const posts: Post[] = [];
  const page = await renderThread(card({ id: "choice-1", body: "Choose a direction" }), posts);
  try {
    assert.equal(page.container.querySelectorAll("textarea").length, 1);
    assert.ok(button(page, "Continue"));
    assert.ok(button(page, "Revise"));
    assert.ok(button(page, "Reply"));

    await fill(page, "  use the safer direction  ");
    await act(async () => { button(page, "Reply").click(); });
    await page.settle();
    const post = posts[0];
    assert.ok(post);
    assert.equal(post.path, "/inbox/messages/choice-1/reply");
    assert.equal(post.body.body, "use the safer direction");
    assert.match(String(post.body.requestId), /^choice-1:reply:\d+$/u);
    assert.equal(posts.length, 1);
  } finally {
    await page.dispose();
  }
});

test("an open gate renders approve and reject with its note text box", async () => {
  const posts: Post[] = [];
  const page = await renderThread(card({
    id: "gate-1", body: "Approve the artifact", gateTaskId: "gate-1", choices: null,
  }), posts);
  try {
    assert.equal(page.container.querySelectorAll("textarea").length, 1);
    assert.equal(page.container.querySelector("textarea")?.getAttribute("placeholder"), "Optional note attached to Approve or Reject…");
    assert.ok(button(page, "Approve"));
    assert.ok(button(page, "Reject"));
    assert.equal([...page.container.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Reply"), false);

    await fill(page, "  please address the missing test  ");
    await act(async () => { button(page, "Reject").click(); });
    await page.settle();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]?.path, "/inbox/messages/gate-1/decision");
    assert.equal(posts[0]?.body.decision, "reject");
    assert.equal(posts[0]?.body.note, "please address the missing test");
    assert.equal(posts[0]?.body.requestId, "gate-1:reject");
  } finally {
    await page.dispose();
  }
});

test("a card the server marks as not accepting free text has no text box", async () => {
  const page = await renderThread(card({
    id: "choice-closed-to-text", body: "Choose only", acceptsFreeText: false,
  }));
  try {
    assert.equal(page.container.querySelectorAll("textarea").length, 0);
    assert.ok(button(page, "Continue"));
    assert.ok(button(page, "Revise"));
    assert.equal([...page.container.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Reply"), false);
  } finally {
    await page.dispose();
  }
});

test("a gate without free text keeps one approve and reject control set even when it carries choices", async () => {
  const page = await renderThread(card({
    id: "gate-no-text", body: "Approve only", gateTaskId: "gate-no-text", acceptsFreeText: false,
  }));
  try {
    assert.equal(page.container.querySelectorAll("textarea").length, 0);
    assert.ok(button(page, "Approve"));
    assert.ok(button(page, "Reject"));
    assert.equal([...page.container.querySelectorAll("button")].some((candidate) => candidate.textContent?.includes("Continue")), false);
  } finally {
    await page.dispose();
  }
});
