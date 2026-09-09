import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";

import { mountPage } from "./dom-harness";
import type { InboxMessage } from "../lib/types";

const now = "2026-08-26T00:00:00.000Z";

const card = (overrides: Partial<InboxMessage> & Pick<InboxMessage, "id" | "body">): InboxMessage => ({
  from: "AGENT", dismissible: true, agentId: null, sessionId: null, taskId: null, goalId: null,
  gateTaskId: null, acceptsFreeText: false, artifactTaskId: null, threadId: "thread-1", replyToMessageId: null,
  kind: "TEXT", choices: null, selectedChoiceId: null, status: "OPEN", channel: "FEISHU",
  deliveryStatus: "DELIVERED", deliveryAttempts: 1, lastDeliveryError: null,
  createdAt: now, answeredAt: null, decisions: [], replies: [],
  ...overrides,
});

/** The three shapes the lanes have to tell apart: a gate that blocks a task, a
 *  detached notification nobody is blocked on, and an archived deploy record. */
const gate = card({
  id: "gate-1", body: "审批闸门：合并 PR #44", kind: "MULTIPLE_CHOICE", agentId: "agent-1", dismissible: false,
  taskId: "gate-task", gateTaskId: "gate-task", choices: [{ id: "approve", label: "批准" }],
});
const notice = card({ id: "notice-1", body: "Autonomous merge tail stopped: missing regression output" });
const deployed = card({
  id: "deploy-1", status: "CLOSED", answeredAt: now,
  body: "[auto-deploy] success: cd63e56186022274da18288bfd7ef36bd6b318ea -> cb46e4a003c3296fbd2f9ee49d6450ae7b7b3b3b; reason=deployed",
});

const serve = (messages: InboxMessage[], posted: string[] = []): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(/^.*\/api/, "");
    if (init?.method === "POST") { posted.push(url); return new Response("{}", { status: 200 }); }
    if (url === "/inbox/messages") return new Response(JSON.stringify(messages), { status: 200 });
    return new Response("[]", { status: 200 });
  }) as typeof fetch;

const renderInbox = async (messages: InboxMessage[], posted: string[] = []) => {
  const [{ InboxPage }, { ProjectProvider }] = await Promise.all([import("../pages/Inbox"), import("../lib/project")]);
  const page = await mountPage(<ProjectProvider><InboxPage /></ProjectProvider>, { "*": ({ input, init }) => serve(messages, posted)(input, init) }, "http://127.0.0.1:5173/inbox");
  return { container: page.container, page };
};

const lane = (container: Element, label: RegExp): HTMLButtonElement => {
  const found = [...container.querySelectorAll("button")].find((button) => label.test(button.textContent ?? ""));
  assert.ok(found, `no lane matching ${String(label)}`);
  return found as HTMLButtonElement;
};

test("the active lane holds only cards that owe a reply; a detached notification is not one", async () => {
  const { container, page } = await renderInbox([gate, notice, deployed]);
  try {
    const text = container.textContent ?? "";
    assert.match(text, /合并 PR/);
    // The lane the operator lands on must not be padded with cards that need
    // nothing from them — that is what made the badge read 145.
    assert.doesNotMatch(text, /merge tail stopped/);
  } finally {
    await page.dispose();
  }
});

test("the notices lane lists the detached notification and dismisses it without a decision", async () => {
  const posted: string[] = [];
  const { container, page } = await renderInbox([gate, notice, deployed], posted);
  try {
    // The lane's own count tells the operator there is something there without
    // spending the sidebar badge on it.
    assert.match(lane(container, /^Notices/).textContent ?? "", /^Notices 1$/);
    act(() => { lane(container, /^Notices/).click(); });
    await page.settle();
    const text = container.textContent ?? "";
    assert.match(text, /merge tail stopped/);
    assert.doesNotMatch(text, /合并 PR/);

    const dismiss = [...container.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim() === "Dismiss");
    assert.ok(dismiss, "the notices lane offers a row-level dismiss");
    act(() => { (dismiss as HTMLButtonElement).click(); });
    await page.settle();
    assert.deepEqual(posted, ["/inbox/messages/notice-1/close"]);
  } finally {
    await page.dispose();
  }
});

test("a deploy that succeeded reports where production is, without occupying a lane", async () => {
  const { container, page } = await renderInbox([deployed]);
  try {
    const text = container.textContent ?? "";
    assert.match(text, /cb46e4a/);
    // Archived on write, so it is not in the active lane it is rendered above.
    assert.match(text, /Nothing waiting on you/);
  } finally {
    await page.dispose();
  }
});

test("a deploy notice names the host that wrote it", async () => {
  const failed = card({
    id: "deploy-2", status: "CLOSED", answeredAt: now,
    body: "[auto-deploy] failure: cd63e56186022274da18288bfd7ef36bd6b318ea -> cb46e4a003c3296fbd2f9ee49d6450ae7b7b3b3b;"
      + " reason=release-artifact-build-failed; host=runner-host-1; detail=exit-1: fatal: unable to access",
  });
  const { container, page } = await renderInbox([failed]);
  try {
    const text = container.textContent ?? "";
    // Without this the operator cannot tell which of the deploying hosts to go
    // and look at, and the detail after it must not be mistaken for the host.
    assert.match(text, /runner-host-1/);
    assert.match(text, /release-artifact-build-failed/);
    assert.doesNotMatch(text, /exit-1/);
  } finally {
    await page.dispose();
  }
});

test("a deploy notice written before hosts were named still renders", async () => {
  const { latestDeploy } = await import("../lib/inbox");
  assert.deepEqual(latestDeploy([deployed])?.host, null);
  const { container, page } = await renderInbox([deployed]);
  try {
    assert.match(container.textContent ?? "", /cb46e4a/);
  } finally {
    await page.dispose();
  }
});

test("the sidebar badge counts the reply-owing cards only", async () => {
  const { needsReply } = await import("../lib/inbox");
  assert.deepEqual([gate, notice, deployed].filter(needsReply).map((message) => message.id), ["gate-1"]);
});
