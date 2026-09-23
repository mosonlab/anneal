import assert from "node:assert/strict";
import test from "node:test";

import { mountPage } from "./dom-harness";
import type { InboxMessage, TaskStepOutput } from "../lib/types";

const now = "2026-08-25T00:00:00.000Z";

/** A gate card as the API returns it: the body carries only the truncated
 *  preview that has to fit in a Feishu card, `taskId` is the gate step, and
 *  `artifactTaskId` is the step that produced the artifact under review. */
const gateCard = (): InboxMessage => ({
  id: "gate-1", from: "AGENT", dismissible: false, agentId: "agent-1", sessionId: "session-1",
  taskId: "gate-task", goalId: null, gateTaskId: "gate-task", acceptsFreeText: true, artifactTaskId: "producing-task",
  threadId: "thread-1", replyToMessageId: null, kind: "MULTIPLE_CHOICE",
  body: "审批闸门：Write a spec\n\n产物（spec）：\nPREVIEW HEAD\n…（预览已截断，完整产物见 Inbox 页的产物卡片）",
  choices: [{ id: "approve", label: "批准并继续" }, { id: "reject", label: "打回上一步" }],
  selectedChoiceId: null, status: "OPEN", channel: "FEISHU", deliveryStatus: "DELIVERED",
  deliveryAttempts: 1, lastDeliveryError: null, createdAt: now, answeredAt: null,
  decisions: [], replies: [],
});

const artifact: TaskStepOutput = {
  id: "output-1", taskId: "producing-task", runId: "run-1", kind: "spec",
  body: "FULL ARTIFACT TAIL", metadata: null, commitSha: null, createdAt: now, updatedAt: now,
};

test("an approval gate shows the producing step's full artifact, not just the card's truncated preview", async () => {
  const [{ InboxThreadPage }, { ProjectProvider }] = await Promise.all([import("../pages/Inbox"), import("../lib/project")]);

  const requested: string[] = [];
  const page = await mountPage(<ProjectProvider><InboxThreadPage messageId="gate-1" /></ProjectProvider>, { "*": ({ input }) => {
    const url = String(input).replace(/^.*\/api/, "");
    requested.push(url);
    if (url === "/inbox/messages/gate-1") return new Response(JSON.stringify(gateCard()), { status: 200 });
    if (url === "/tasks/producing-task/output") return new Response(JSON.stringify(artifact), { status: 200 });
    return new Response("[]", { status: 200 });
  } }, "http://127.0.0.1:5173/inbox/gate-1");
  try {
    const text = page.container.textContent ?? "";
    assert.match(text, /PREVIEW HEAD/);
    // The point of the card: the part the preview cut off is on screen.
    assert.match(text, /FULL ARTIFACT TAIL/);
    // And the producing step is reachable, where before only the gate step was.
    assert.ok(page.container.querySelector("a[href='#/tasks/producing-task']"));
    assert.ok(requested.includes("/tasks/producing-task/output"));
  } finally {
    await page.dispose();
  }
});

test("a card that is not an approval gate polls no artifact at all", async () => {
  const [{ InboxThreadPage }, { ProjectProvider }] = await Promise.all([import("../pages/Inbox"), import("../lib/project")]);

  const requested: string[] = [];
  const plain: InboxMessage = { ...gateCard(), id: "plain-1", kind: "TEXT", gateTaskId: null, artifactTaskId: null, choices: null, body: "A plain question" };
  const page = await mountPage(<ProjectProvider><InboxThreadPage messageId="plain-1" /></ProjectProvider>, { "*": ({ input }) => {
    const url = String(input).replace(/^.*\/api/, "");
    requested.push(url);
    if (url === "/inbox/messages/plain-1") return new Response(JSON.stringify(plain), { status: 200 });
    return new Response("[]", { status: 200 });
  } }, "http://127.0.0.1:5173/inbox/plain-1");
  try {
    assert.ok(!requested.some((url) => url.endsWith("/output")));
  } finally {
    await page.dispose();
  }
});
