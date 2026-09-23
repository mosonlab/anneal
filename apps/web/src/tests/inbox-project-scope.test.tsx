import assert from "node:assert/strict";
import test from "node:test";

import { LocaleProvider } from "../lib/i18n";
import { ProjectProvider } from "../lib/project";
import { storage } from "../lib/storage";
import { ThemeProvider } from "../lib/theme";
import type { InboxMessage } from "../lib/types";
import { mountPage, type PageRoutes } from "./dom-harness";

const PROJECT = { id: "p-selected", name: "Selected project", slug: "selected-project" };
const PROJECTS = [PROJECT];
const now = "2026-08-26T00:00:00.000Z";

const deployNotice: InboxMessage = {
  id: "deploy-1", from: "AGENT", dismissible: true, agentId: null, sessionId: null,
  taskId: null, goalId: null, gateTaskId: null, acceptsFreeText: false, artifactTaskId: null, threadId: "thread-1",
  replyToMessageId: null, kind: "TEXT", body: "[auto-deploy] success: old -> cb46e4a; reason=deployed",
  choices: null, selectedChoiceId: null, status: "CLOSED", channel: "FEISHU",
  deliveryStatus: "DELIVERED", deliveryAttempts: 1, lastDeliveryError: null,
  createdAt: now, answeredAt: now, decisions: [], replies: [],
};

const plainMessage: InboxMessage = {
  ...deployNotice,
  id: "message-1",
  body: "A project-scoped message",
  status: "OPEN",
  answeredAt: null,
  project: { id: "p-other", name: "Other project", slug: "other-project" },
};

const selectedProjectRoutes = (messages: InboxMessage[] = [plainMessage]): PageRoutes => ({
  "/projects": PROJECTS,
  "/projects/p-selected/agents": [],
  "/inbox/messages?projectId=p-selected": messages,
  "/inbox/messages/message-1": plainMessage,
  "/inbox/messages/summary?projectId=p-selected": { needsReply: 1 },
});

const emptyProjectRoutes = (): PageRoutes => ({
  "/projects": [],
  "/inbox/messages": [],
  "/inbox/messages/summary": { needsReply: 0 },
});

const prepareSelection = (projectId: string | null) => (): void => {
  if (projectId === null) storage.remove("agentos.projectId");
  else storage.set("agentos.projectId", projectId);
};

test("InboxPage scopes its messages request and still renders a global deploy notice", async () => {
  const [{ InboxPage }] = await Promise.all([import("../pages/Inbox")]);
  const page = await mountPage(
    <ProjectProvider><InboxPage /></ProjectProvider>,
    selectedProjectRoutes([deployNotice]),
    "http://127.0.0.1:5173/inbox",
    prepareSelection("p-selected"),
  );
  try {
    assert.ok(page.requests.some(({ path }) => path === "/inbox/messages?projectId=p-selected"));
    assert.match(page.container.textContent ?? "", /cb46e4a/);
  } finally {
    await page.dispose();
    storage.remove("agentos.projectId");
  }
});

test("InboxThreadPage loads a cross-project message by id without changing the selected project", async () => {
  const [{ InboxThreadPage }] = await Promise.all([import("../pages/Inbox")]);
  const page = await mountPage(
    <ProjectProvider><InboxThreadPage messageId="message-1" /></ProjectProvider>,
    selectedProjectRoutes(),
    "http://127.0.0.1:5173/inbox/message-1",
    prepareSelection("p-selected"),
  );
  try {
    assert.ok(page.requests.some(({ path }) => path === "/inbox/messages/message-1"));
    assert.equal(page.requests.some(({ path }) => path.includes("/inbox/messages?")), false);
    assert.match(page.container.textContent ?? "", /A project-scoped message/);
    assert.match(page.container.textContent ?? "", /Other project/);
    assert.equal(storage.get("agentos.projectId"), "p-selected");
  } finally {
    await page.dispose();
    storage.remove("agentos.projectId");
  }
});

test("InboxThreadPage hides the Project hint when the message belongs to the selected Project", async () => {
  const [{ InboxThreadPage }] = await Promise.all([import("../pages/Inbox")]);
  const selectedProjectMessage = { ...plainMessage, project: PROJECT };
  const page = await mountPage(
    <ProjectProvider><InboxThreadPage messageId="message-1" /></ProjectProvider>,
    { ...selectedProjectRoutes(), "/inbox/messages/message-1": selectedProjectMessage },
    "http://127.0.0.1:5173/inbox/message-1",
    prepareSelection("p-selected"),
  );
  try {
    assert.match(page.container.textContent ?? "", /A project-scoped message/);
    assert.doesNotMatch(page.container.textContent ?? "", /belongs to project/u);
  } finally {
    await page.dispose();
    storage.remove("agentos.projectId");
  }
});

test("Shell scopes the Inbox summary request to the selected project", async () => {
  const [{ Shell }] = await Promise.all([import("../components/Shell")]);
  const page = await mountPage(
    <ThemeProvider><LocaleProvider initialLocale="en"><ProjectProvider><Shell><div /></Shell></ProjectProvider></LocaleProvider></ThemeProvider>,
    selectedProjectRoutes(),
    "http://127.0.0.1:5173/tasks",
    prepareSelection("p-selected"),
  );
  try {
    assert.ok(page.requests.some(({ path }) => path === "/inbox/messages/summary?projectId=p-selected"));
  } finally {
    await page.dispose();
    storage.remove("agentos.projectId");
  }
});

test("InboxPage, InboxThreadPage, and Shell retain unfiltered paths without a project", async () => {
  const [{ InboxPage, InboxThreadPage }, { Shell }] = await Promise.all([
    import("../pages/Inbox"),
    import("../components/Shell"),
  ]);

  const inbox = await mountPage(
    <ProjectProvider><InboxPage /></ProjectProvider>,
    emptyProjectRoutes(),
    "http://127.0.0.1:5173/inbox",
    prepareSelection(null),
  );
  try {
    assert.ok(inbox.requests.some(({ path }) => path === "/inbox/messages"));
    assert.equal(inbox.requests.some(({ path }) => path.includes("projectId=")), false);
  } finally {
    await inbox.dispose();
  }

  const thread = await mountPage(
    <ProjectProvider><InboxThreadPage messageId="missing" /></ProjectProvider>,
    {
      ...emptyProjectRoutes(),
      "/inbox/messages/missing": new Response(JSON.stringify({ error: "Inbox message not found" }), { status: 404 }),
    },
    "http://127.0.0.1:5173/inbox/missing",
    prepareSelection(null),
  );
  try {
    assert.ok(thread.requests.some(({ path }) => path === "/inbox/messages/missing"));
    assert.equal(thread.requests.some(({ path }) => path.includes("projectId=")), false);
    assert.match(thread.container.textContent ?? "", /Message not found/);
  } finally {
    await thread.dispose();
  }

  const shell = await mountPage(
    <ThemeProvider><LocaleProvider initialLocale="en"><ProjectProvider><Shell><div /></Shell></ProjectProvider></LocaleProvider></ThemeProvider>,
    emptyProjectRoutes(),
    "http://127.0.0.1:5173/tasks",
    prepareSelection(null),
  );
  try {
    assert.ok(shell.requests.some(({ path }) => path === "/inbox/messages/summary"));
    assert.equal(shell.requests.some(({ path }) => path.includes("projectId=")), false);
  } finally {
    await shell.dispose();
    storage.remove("agentos.projectId");
  }
});

test("a project-level alert with no project relation opens from its id", async () => {
  const [{ InboxThreadPage }] = await Promise.all([import("../pages/Inbox")]);
  const alert: InboxMessage = {
    ...deployNotice,
    id: "global-alert-1",
    body: "A global project-level alert",
    status: "OPEN",
    answeredAt: null,
    project: null,
  };
  const page = await mountPage(
    <ProjectProvider><InboxThreadPage messageId="global-alert-1" /></ProjectProvider>,
    {
      ...emptyProjectRoutes(),
      "/projects/p-selected/agents": [],
      "/inbox/messages/global-alert-1": alert,
    },
    "http://127.0.0.1:5173/inbox/global-alert-1",
    prepareSelection("p-selected"),
  );
  try {
    assert.ok(page.requests.some(({ path }) => path === "/inbox/messages/global-alert-1"));
    assert.match(page.container.textContent ?? "", /A global project-level alert/);
    assert.doesNotMatch(page.container.textContent ?? "", /belongs to project/u);
  } finally {
    await page.dispose();
    storage.remove("agentos.projectId");
  }
});

test("the Project hint stays hidden in the all-project view", async () => {
  const [{ InboxThreadPage }] = await Promise.all([import("../pages/Inbox")]);
  const page = await mountPage(
    <ProjectProvider><InboxThreadPage messageId="message-1" /></ProjectProvider>,
    { ...emptyProjectRoutes(), "/inbox/messages/message-1": plainMessage },
    "http://127.0.0.1:5173/inbox/message-1",
    prepareSelection(null),
  );
  try {
    assert.match(page.container.textContent ?? "", /A project-scoped message/);
    assert.doesNotMatch(page.container.textContent ?? "", /belongs to project/u);
  } finally {
    await page.dispose();
    storage.remove("agentos.projectId");
  }
});

test("a true 404 shows the new not-found message in both locales", async () => {
  const [{ InboxThreadPage }, { ProjectProvider }, { LocaleProvider }] = await Promise.all([
    import("../pages/Inbox"),
    import("../lib/project"),
    import("../lib/i18n"),
  ]);
  for (const [locale, expected] of [["en", "Message not found."], ["zh", "找不到该消息。"]] as const) {
    const page = await mountPage(
      <LocaleProvider initialLocale={locale}><ProjectProvider><InboxThreadPage messageId="gone" /></ProjectProvider></LocaleProvider>,
      {
        ...emptyProjectRoutes(),
        "/inbox/messages/gone": new Response(JSON.stringify({ error: "Inbox message not found" }), { status: 404 }),
      },
      "http://127.0.0.1:5173/inbox/gone",
      prepareSelection(null),
    );
    try {
      assert.ok(page.requests.some(({ path }) => path === "/inbox/messages/gone"));
      assert.match(page.container.textContent ?? "", new RegExp(expected, "u"));
      assert.doesNotMatch(page.container.textContent ?? "", /control plane|控制面/u);
    } finally {
      await page.dispose();
      storage.remove("agentos.projectId");
    }
  }
});

test("a non-404 Inbox detail error renders ErrorNotice", async () => {
  const [{ InboxThreadPage }, { ProjectProvider }] = await Promise.all([
    import("../pages/Inbox"),
    import("../lib/project"),
  ]);
  const page = await mountPage(
    <ProjectProvider><InboxThreadPage messageId="broken" /></ProjectProvider>,
    {
      ...emptyProjectRoutes(),
      "/inbox/messages/broken": new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }),
    },
    "http://127.0.0.1:5173/inbox/broken",
    prepareSelection(null),
  );
  try {
    assert.match(page.container.textContent ?? "", /500 Internal server error/u);
    assert.doesNotMatch(page.container.textContent ?? "", /Message not found/u);
    assert.ok([...page.container.querySelectorAll("div")].some((element) => element.className.includes("destructive-line")));
  } finally {
    await page.dispose();
    storage.remove("agentos.projectId");
  }
});
