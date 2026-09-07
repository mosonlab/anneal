import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { formatDate, setFormatLocale, timeAgo } from "../lib/format";
import { LocaleProvider } from "../lib/i18n";
import { translate } from "../lib/i18n-core";
import { isSessionUnseen, sessionSeenKey } from "../lib/session-list";
import { storage } from "../lib/storage";
import { TEXT_NODE_MAX_LINES, TOOL_OUTPUT_MAX_LINES } from "../lib/session-stream";
import type { RunMetrics, Session, SessionEvent, SessionExecutionStatus } from "../lib/types";
import { installFetch, installFetchFunction } from "./dom-harness";

// Radix chooses useLayoutEffect or useEffect when its module is first loaded.
// Seed a browser global before importing Sessions so portaled hover-card content
// is observable in this jsdom test, just as it is in the browser.
const preloadDom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const [key, value] of Object.entries({
  window: preloadDom.window, document: preloadDom.window.document, navigator: preloadDom.window.navigator,
  HTMLElement: preloadDom.window.HTMLElement, Element: preloadDom.window.Element, Node: preloadDom.window.Node,
  NodeFilter: preloadDom.window.NodeFilter,
  CustomEvent: preloadDom.window.CustomEvent, MutationObserver: preloadDom.window.MutationObserver,
  PointerEvent: preloadDom.window.MouseEvent, DOMRect: preloadDom.window.DOMRect,
  getComputedStyle: preloadDom.window.getComputedStyle.bind(preloadDom.window),
})) Object.defineProperty(globalThis, key, { configurable: true, value });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const {
  DebugEvents, FilesTouched, SessionRow, SessionsPage, StreamNodeView, WaitingNotice, fileTrackingHint, lifecycleStat,
  sessionPill, truncateBlock,
} = await import("../pages/Sessions");
preloadDom.window.close();

const STATUSES: SessionExecutionStatus[] = [
  "REQUESTED", "PROVISIONING", "RUNNING", "WAITING_INBOX", "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "LOST",
];

const session = (overrides: Partial<Session> = {}): Session => ({
  id: "session-1", runId: "run-1", projectId: "p1", agentId: "agent-1", taskId: "task-1", goalId: null,
  runner: "CLAUDE", executionStatus: "RUNNING", cleanupStatus: "PENDING", providerConversationId: null,
  waitingOnMessageId: null, resumeAttempt: 0, requestedAt: "2026-08-16T00:00:00.000Z",
  startedAt: "2026-08-16T00:00:01.000Z", endedAt: null, terminationReason: null, exitCode: null,
  costUsd: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null,
  failureReason: null, agent: { id: "agent-1", title: "Frontend Dev" },
  task: { id: "task-1", name: "Batch 4", chainId: null, chainName: null },
  goal: null, run: { id: "run-1", runNumber: 3, model: "claude-opus-5", branch: "feat/x", pullRequestUrl: null, workspacePath: "/tmp/w", repo: null },
  ...overrides,
});

const event = (overrides: Partial<SessionEvent> = {}): SessionEvent => ({
  id: "e1", sessionId: "session-1", runId: "run-1", seq: 1, at: "2026-08-16T00:00:00.000Z",
  source: "RUNNER", type: "PROCESS_STARTED", toolCallId: null, payload: {}, ...overrides,
});

const CLAUDE_TEXT_ASSISTANT = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "3" }] } };

/* ------------------------------------------------------------ pure mappings */

test("the status pill uses only tones that already exist", () => {
  const expected: Record<SessionExecutionStatus, { tone: string; label: string }> = {
    REQUESTED: { tone: "grey", label: "queued" },
    PROVISIONING: { tone: "grey", label: "queued" },
    RUNNING: { tone: "green", label: "running" },
    WAITING_INBOX: { tone: "amber", label: "waiting" },
    SUCCEEDED: { tone: "green", label: "done" },
    FAILED: { tone: "red", label: "failed" },
    TIMED_OUT: { tone: "red", label: "timed out" },
    LOST: { tone: "red", label: "lost" },
    CANCELLED: { tone: "grey", label: "cancelled" },
  };
  const tones = new Set(["green", "amber", "violet", "red", "grey", "accent"]);
  for (const status of STATUSES) {
    assert.deepEqual(sessionPill(status), expected[status], status);
    assert.ok(tones.has(sessionPill(status).tone), status);
  }
});

test("the stat bar's lifecycle slot reads Live, Done or Failed", () => {
  // Driven off the same status list as the pill mapping so the two cannot drift.
  for (const status of STATUSES) {
    const expected = ["REQUESTED", "PROVISIONING", "RUNNING", "WAITING_INBOX"].includes(status)
      ? { label: "Live", tone: "green" }
      : status === "SUCCEEDED" ? { label: "Done", tone: "green" } : { label: "Failed", tone: "red" };
    assert.deepEqual(lifecycleStat(status), expected, status);
  }
});

test("blocks truncate at 8 000 characters and say how much is left", () => {
  assert.equal(truncateBlock("short"), "short");
  const long = truncateBlock("x".repeat(9_000));
  assert.match(long, /… truncated, 1000 more characters$/);
  assert.equal(long.split("\n")[0]?.length, 8_000);
});

/* --------------------------------------------------------- initial markup */

test("a collapsed tool row is one line and hides its Arguments and Result", () => {
  const markup = renderToStaticMarkup(<StreamNodeView node={{
    kind: "tools", id: "group-0", at: "2026-08-16T00:00:00.000Z", calls: [{
      kind: "tool", id: "t1", at: "2026-08-16T00:00:00.000Z", name: "Read",
      primaryArg: "/Users/dev/repo/src/adapters.ts", filePath: "/Users/dev/repo/src/adapters.ts",
      args: { file_path: "/Users/dev/repo/src/adapters.ts" }, result: "ok", state: "ok",
    }],
  }} />);
  assert.match(markup, /Read/);
  assert.match(markup, /\/Users\/dev\/repo\/src\/adapters\.ts/);
  assert.doesNotMatch(markup, />Arguments</);
  assert.doesNotMatch(markup, />Result</);
});

const toolNode = {
  kind: "tools" as const,
  id: "group-1",
  at: "2026-08-16T00:00:00.000Z",
  calls: [
    {
      kind: "tool" as const, id: "read-1", at: "2026-08-16T00:00:00.000Z", name: "Read",
      primaryArg: "/repo/a.ts", filePath: "/repo/a.ts", args: { file_path: "/repo/a.ts" }, result: "READ_RESULT_UNIQUE", state: "ok" as const,
    },
    {
      kind: "tool" as const, id: "run-1", at: "2026-08-16T00:00:01.000Z", name: "Bash",
      primaryArg: "npm test", filePath: null, args: { command: "npm test" }, result: "RUN_RESULT_UNIQUE", state: "running" as const,
    },
  ],
};

test("a tools node is one card of collapsed one-line calls", () => {
  const markup = renderToStaticMarkup(<StreamNodeView node={toolNode} />);
  assert.match(markup, /Tool calls/);
  assert.equal((markup.match(/data-tool-line=/g) ?? []).length, 2);
  assert.match(markup, /Read/);
  assert.match(markup, /Bash/);
  assert.match(markup, /\/repo\/a\.ts/);
  assert.match(markup, /npm test/);
  assert.doesNotMatch(markup, /READ_RESULT_UNIQUE|RUN_RESULT_UNIQUE/);
  assert.doesNotMatch(markup, />Arguments</);
  assert.doesNotMatch(markup, />Result</);
});

test("a failed tool line shows the first result line in the destructive tone", () => {
  const failed = {
    ...toolNode,
    calls: [{ ...toolNode.calls[0]!, state: "error" as const, result: "first failure line\nsecond failure line" }],
  };
  const markup = renderToStaticMarkup(<StreamNodeView node={failed} />);
  assert.match(markup, /first failure line/);
  assert.doesNotMatch(markup, /second failure line/);
  assert.match(markup, /text-\[color:var\(--destructive-fg\)\]/);
});

test("a failed tool line without result text keeps its primary argument", () => {
  const failed = {
    ...toolNode,
    calls: [{ ...toolNode.calls[1]!, state: "error" as const, result: null }],
  };
  const markup = renderToStaticMarkup(<StreamNodeView node={failed} />);
  assert.match(markup, /npm test/);
});

test("text nodes keep the existing Agent and Result message headings", () => {
  const agent = renderToStaticMarkup(<StreamNodeView node={{ kind: "text", id: "m1", at: "2026-08-16T00:00:00.000Z", text: "agent prose", final: false }} />);
  const result = renderToStaticMarkup(<StreamNodeView node={{ kind: "text", id: "m2", at: "2026-08-16T00:00:00.000Z", text: "final prose", final: true }} />);
  assert.match(agent, />Agent</);
  assert.match(agent, /agent prose/);
  assert.match(result, />Result</);
  assert.match(result, /final prose/);
});

test("text nodes clamp at the named line limit behind Show more", () => {
  const text = Array.from({ length: TEXT_NODE_MAX_LINES + 2 }, (_, index) => `prose line ${index + 1}`).join("\n");
  const markup = renderToStaticMarkup(<StreamNodeView node={{ kind: "text", id: "long", at: "2026-08-16T00:00:00.000Z", text, final: false }} />);
  assert.match(markup, /Show more/);
  assert.match(markup, /prose line 12/);
  assert.doesNotMatch(markup, /prose line 13/);
});

test("stream markers render muted resume copy in both locales and errors through ErrorNotice", () => {
  const info = { kind: "marker" as const, id: "resume-1", at: "2026-08-16T00:00:00.000Z", variant: "info" as const, text: "sessions.stream.resumed" };
  const error = { kind: "marker" as const, id: "error-1", at: "2026-08-16T00:00:00.000Z", variant: "error" as const, text: "stream disconnected" };

  const english = renderToStaticMarkup(<LocaleProvider initialLocale="en"><StreamNodeView node={info} /></LocaleProvider>);
  const chinese = renderToStaticMarkup(<LocaleProvider initialLocale="zh"><StreamNodeView node={info} /></LocaleProvider>);
  const errorMarkup = renderToStaticMarkup(<StreamNodeView node={error} />);
  assert.match(english, /Session resumed/);
  assert.match(chinese, /会话已恢复/);
  assert.match(english, /text-muted-foreground/);
  assert.match(errorMarkup, /stream disconnected/);
  assert.match(errorMarkup, /var\(--destructive-bg\)/);
});

test("operator input renders in the message card under a translated Operator heading", () => {
  const input = { kind: "input" as const, id: "input-1", at: "2026-08-16T00:00:00.000Z", text: "continue with the repair" };
  const english = renderToStaticMarkup(<LocaleProvider initialLocale="en"><StreamNodeView node={input} /></LocaleProvider>);
  const chinese = renderToStaticMarkup(<LocaleProvider initialLocale="zh"><StreamNodeView node={input} /></LocaleProvider>);
  assert.match(english, /Operator/);
  assert.match(english, /continue with the repair/);
  assert.match(english, /rounded-xl border border-border bg-card/);
  assert.match(chinese, /操作员/);
  assert.match(chinese, /continue with the repair/);
});

test("operator input uses the same line clamp and Show more control as agent prose", () => {
  const text = Array.from({ length: TEXT_NODE_MAX_LINES + 2 }, (_, index) => `operator line ${index + 1}`).join("\n");
  const markup = renderToStaticMarkup(<StreamNodeView node={{
    kind: "input", id: "long-input", at: "2026-08-16T00:00:00.000Z", text,
  }} />);
  assert.match(markup, /Show more/);
  assert.match(markup, /operator line 12/);
  assert.doesNotMatch(markup, /operator line 13/);
});

test("tool groups and text node headings are translated in English and Chinese", () => {
  try {
    const english = renderToStaticMarkup(<LocaleProvider initialLocale="en"><StreamNodeView node={toolNode} /></LocaleProvider>);
    const chinese = renderToStaticMarkup(<LocaleProvider initialLocale="zh"><StreamNodeView node={toolNode} /></LocaleProvider>);
    const englishText = renderToStaticMarkup(<LocaleProvider initialLocale="en"><StreamNodeView node={{ kind: "text", id: "m1", at: toolNode.at, text: "agent prose", final: false }} /></LocaleProvider>);
    const chineseText = renderToStaticMarkup(<LocaleProvider initialLocale="zh"><StreamNodeView node={{ kind: "text", id: "m1", at: toolNode.at, text: "agent prose", final: false }} /></LocaleProvider>);
    assert.match(english, /Tool calls/);
    assert.match(chinese, /工具调用/);
    assert.match(englishText, />Agent</);
    assert.match(chineseText, />Agent</);
  } finally {
    setFormatLocale("en", (key, vars) => translate("en", key, vars));
  }
});

test("Files touched and Debug events render collapsed by default", () => {
  const files = renderToStaticMarkup(<FilesTouched files={[{ path: "/a.ts", count: 2 }]} hint={null} />);
  assert.match(files, /Files touched/);
  assert.doesNotMatch(files, /\/a\.ts/, "body is absent while collapsed");

  const debug = renderToStaticMarkup(<DebugEvents events={[event()]} />);
  assert.match(debug, /Debug events/);
  assert.doesNotMatch(debug, /PROCESS_STARTED/, "body is absent while collapsed");
});

test("the file-tracking hint fires for every runner whose path keys are inferred", () => {
  // CLAUDE's extraction is verified against real captured stdout, so a zero
  // there is a fact about the session and must not be explained away.
  assert.equal(fileTrackingHint("CLAUDE", 0, 12), null);
  for (const runner of ["CODEX", "PI"] as const) {
    assert.equal(fileTrackingHint(runner, 0, 12), `File tracking is not available for ${runner} sessions.`);
    // Nothing to explain when paths were found, or when no tool ever ran.
    assert.equal(fileTrackingHint(runner, 3, 12), null);
    assert.equal(fileTrackingHint(runner, 0, 0), null);
  }
});

test("a WAITING_INBOX session always says why, with or without a message id", () => {
  const linked = renderToStaticMarkup(<WaitingNotice status="WAITING_INBOX" messageId="inb-1" />);
  assert.match(linked, /Waiting on an Inbox decision\./);
  assert.match(linked, /#\/inbox\/inb-1/);

  // The id has not landed yet: the notice still renders, unlinked. This is the
  // state where an operator most needs to be told why nothing is happening.
  const bare = renderToStaticMarkup(<WaitingNotice status="WAITING_INBOX" messageId={null} />);
  assert.match(bare, /Waiting on an Inbox decision\./);
  assert.doesNotMatch(bare, /<a/);

  for (const status of STATUSES.filter((candidate) => candidate !== "WAITING_INBOX")) {
    assert.equal(renderToStaticMarkup(<WaitingNotice status={status} messageId="inb-1" />), "", status);
  }
});

test("a session row leads with its title and status, not table columns", () => {
  const markup = renderToStaticMarkup(<SessionRow session={session()} />);
  assert.match(markup, /data-session-row/);
  assert.match(markup, />Batch 4</);
  assert.match(markup, />Frontend Dev</);
  assert.match(markup, /bg-\[color:var\(--status-green-fg\)\]/);
  assert.doesNotMatch(markup, /<table|Started|Runner|Duration|Result/);
});

test("a session row's chip carries the model that run executed with", () => {
  const markup = renderToStaticMarkup(<SessionRow session={session()} />);
  // One chip, two facts: who ran it and what it ran. The row's own Run snapshot
  // holds the model, so no second read is needed to say it.
  assert.match(markup, /data-agent-chip-model="true"[^>]*>Claude Opus 5</u);

  const withEffort = renderToStaticMarkup(<SessionRow session={session({
    run: { id: "run-1", runNumber: 3, model: "gpt-6-astra:high", branch: null, pullRequestUrl: null, workspacePath: null, repo: null },
  })} />);
  assert.match(withEffort, /data-agent-chip-model="true"[^>]*>GPT-6 Astra \(codex\) · high</u);

  // A row with no Run snapshot names the agent and invents no model.
  const bare = renderToStaticMarkup(<SessionRow session={session({ run: null })} />);
  assert.match(bare, />Frontend Dev</u);
  assert.doesNotMatch(bare, /data-agent-chip-model/u);
});

test("a queued row uses requestedAt for its relative time when it has not started", () => {
  const requestedAt = new Date(Date.now() - 2_000).toISOString();
  const markup = renderToStaticMarkup(<SessionRow session={session({ startedAt: null, requestedAt })} />);
  const renderedTime = /data-session-time="true"[^>]*>([^<]*)</u.exec(markup)?.[1];
  assert.equal(renderedTime, timeAgo(requestedAt));
});

test("a session row title falls back from Task to Goal to Session id", () => {
  const task = renderToStaticMarkup(<SessionRow session={session()} />);
  assert.match(task, />Batch 4</);

  const goal = renderToStaticMarkup(<SessionRow session={session({
    task: null, taskId: null, goal: { id: "goal-1", title: "Ship it" }, goalId: "goal-1",
  })} />);
  assert.match(goal, />Ship it</);

  const id = renderToStaticMarkup(<SessionRow session={session({
    task: null, taskId: null, goal: null, goalId: null,
  })} />);
  assert.match(id, />session-1</);
});

test("expanding a session row loads shared diagnostics and renders its null state", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const metrics: RunMetrics = {
    phases: { queuedMs: 1_000, provisioningMs: 2_000, executingMs: 3_000, inboxWaitMs: 0, cleanupMs: 4_000 },
    tokens: { input: 100, cachedRead: 10, cacheWrite: 5, uncachedInput: 85, output: 20, cacheHitRatio: 0.1 },
    tools: { calls: 2, failed: 1, unclassified: 0, totalToolMs: 500, byName: [{ name: "Bash", calls: 2, failed: 1 }] },
    ttft: { p50Ms: 250, p90Ms: 500, samples: 2 },
    modelActiveMs: 2_500,
    modelActiveIsUpperBound: false,
    outputTokensPerSecond: 8,
    termination: { reason: "completed", exitCode: 0, signal: null },
    vsBaseline: { costRatio: null, durationRatio: null },
  };
  let release!: () => void;
  const pending = new Promise<Response>((resolve) => { release = () => resolve(Response.json({ ...session(), metrics })); });
  let nullMetrics = false;
  const fetchHarness = installFetchFunction(async (input) => {
    const path = String(input);
    assert.match(path, /\/sessions\/session-1/u);
    if (!nullMetrics) return pending;
    return Response.json({ ...session(), metrics: null });
  });
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<LocaleProvider initialLocale="en"><SessionRow session={session()} /></LocaleProvider>); });
    assert.equal(fetchHarness.requests.length, 0, "the list row does not read detail metrics while collapsed");

    const toggle = dom.window.document.querySelector<HTMLButtonElement>("[data-session-row-toggle]");
    assert.ok(toggle, container.innerHTML);
    await click(dom, toggle);
    assert.match(container.textContent ?? "", /Loading…/u);
    assert.equal(fetchHarness.requests.length, 1);
    release();
    await fetchHarness.settle();
    assert.ok(container.querySelector("[data-run-diagnostics]"), container.innerHTML);
    assert.match(container.textContent ?? "", /Time to first token/u);
    assert.match(container.textContent ?? "", /250ms/u);

    nullMetrics = true;
    await click(dom, toggle);
    await click(dom, toggle);
    await fetchHarness.settle();
    assert.match(container.textContent ?? "", /No diagnostics recorded for this run\./u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    fetchHarness.dispose();
  }
});

test("sessions are grouped by day, capped at five, and expandable in both locales", async () => {
  const localIso = (offset: number, hour: number): string => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, 0, 0, 0).toISOString();
  };
  const today = Array.from({ length: 6 }, (_, index) => {
    const at = localIso(0, 8 + index);
    return session({ id: `today-${index}`, requestedAt: at, startedAt: at });
  });
  const yesterdayAt = localIso(-1, 12);
  const yesterday = session({ id: "yesterday", requestedAt: yesterdayAt, startedAt: yesterdayAt });
  const olderAt = localIso(-2, 15);
  const older = session({ id: "older", requestedAt: olderAt, startedAt: olderAt });
  const sessions = [...today, yesterday, older];

  const { ProjectProvider } = await import("../lib/project");
  try {
    for (const locale of ["en", "zh"] as const) {
      const dom = jsdom();
      const container = dom.window.document.querySelector("#root");
      assert.ok(container);
      const fetchHarness = installFetchFunction(async (input) => {
          const path = String(input);
          const payload = path.includes("/projects") ? [{ id: "p1", name: "Demo" }] : sessions;
          return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
      });
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(<LocaleProvider initialLocale={locale}><ProjectProvider><SessionsPage /></ProjectProvider></LocaleProvider>);
        });
        await fetchHarness.settle();

        const dayGroups = [...dom.window.document.querySelectorAll<HTMLElement>("[data-session-day]")];
        assert.equal(dayGroups.length, 3, container.innerHTML);
        const dayText = dayGroups.map((group) => group.textContent ?? "");
        assert.match(dayText[0]!, locale === "en" ? /Today/ : /今天/);
        assert.match(dayText[1]!, locale === "en" ? /Yesterday/ : /昨天/);
        assert.ok(dayText[2]?.includes(formatDate(olderAt)), `${dayText[2]} does not include ${formatDate(olderAt)}`);
        assert.match(dayText[0]!, locale === "en" ? /6 sessions/ : /6 个会话/);
        assert.equal(dom.window.document.querySelectorAll("table").length, 0);
        // The rows carry no table headings. Scoped to the list, because the
        // filter bar above it legitimately says Runner.
        const list = dom.window.document.querySelector("[data-session-list]");
        assert.doesNotMatch(list?.textContent ?? "", /Started|Runner|Duration|Result/u);
        assert.equal(dom.window.document.querySelectorAll("[data-session-row]").length, 7);

        const expand = dom.window.document.querySelector<HTMLButtonElement>("[data-session-day-toggle]");
        assert.ok(expand, container.innerHTML);
        assert.match(expand.textContent ?? "", locale === "en" ? /Show 1 more/ : /再显示 1 个/);
        await click(dom, expand);
        assert.equal(dom.window.document.querySelectorAll("[data-session-row]").length, 8);
        assert.match(expand.textContent ?? "", locale === "en" ? /Show fewer/ : /显示更少/);
        await click(dom, expand);
        assert.equal(dom.window.document.querySelectorAll("[data-session-row]").length, 7);
      } finally {
        fetchHarness.dispose();
        await act(async () => root.unmount());
        dom.window.close();
      }
    }
  } finally {
    setFormatLocale("en", (key, vars) => translate("en", key, vars));
  }
});

test("a 404 from GET /sessions renders the standard error state", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const fetchHarness = installFetch({
    "/projects": [{ id: "p1", name: "Demo" }],
    "GET /sessions": () => new Response(JSON.stringify({ error: "Session list is gone" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
  });
  const { ProjectProvider } = await import("../lib/project");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<LocaleProvider initialLocale="en"><ProjectProvider><SessionsPage /></ProjectProvider></LocaleProvider>);
    });
    await fetchHarness.settle();

    const body = container.textContent ?? "";
    assert.match(body, /404 Session list is gone/u);
    assert.match(body, /Retry/u);
    assert.doesNotMatch(body, /The control plane has no .*GET \/sessions/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    fetchHarness.dispose();
  }
});

test("day expansion resets when the Project scope changes", async () => {
  const localIso = (offset: number, hour: number): string => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, 0, 0, 0).toISOString();
  };
  const sessionsFor = (projectId: string): Session[] => Array.from({ length: 6 }, (_, index) => {
    const at = localIso(0, 8 + index);
    return session({ id: `${projectId}-${index}`, projectId, requestedAt: at, startedAt: at });
  });
  const byProject = { p1: sessionsFor("p1"), p2: sessionsFor("p2") };
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const fetchHarness = installFetchFunction(async (input) => {
      const path = String(input);
      const payload = path.includes("/projects")
        ? [{ id: "p1", name: "One" }, { id: "p2", name: "Two" }]
        : path.includes("projectId=p2") ? byProject.p2 : byProject.p1;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
  });
  const { ProjectProvider, useProjectScope } = await import("../lib/project");
  const ScopeProbe = (): ReactNode => {
    const scope = useProjectScope();
    return <button type="button" data-switch-project onClick={() => scope.select("p2")}>Switch project</button>;
  };
  const root = createRoot(container);
  const flush = fetchHarness.settle;
  try {
    await act(async () => {
      root.render(<LocaleProvider initialLocale="en"><ProjectProvider><ScopeProbe /><SessionsPage /></ProjectProvider></LocaleProvider>);
    });
    await flush();
    const expand = dom.window.document.querySelector<HTMLButtonElement>("[data-session-day-toggle]");
    assert.ok(expand, container.innerHTML);
    await click(dom, expand);
    assert.equal(dom.window.document.querySelectorAll("[data-session-row]").length, 6);

    const switchProject = dom.window.document.querySelector<HTMLButtonElement>("[data-switch-project]");
    assert.ok(switchProject);
    await click(dom, switchProject);
    await flush();
    assert.equal(dom.window.document.querySelectorAll("[data-session-row]").length, 5, "new project starts collapsed");
    assert.match(dom.window.document.querySelector("[data-session-day-toggle]")?.textContent ?? "", /Show 1 more/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    fetchHarness.dispose();
  }
});

test("an unseen terminal row has a trailing green dot and bold title, while a seen row has neither", () => {
  const finished = session({ executionStatus: "SUCCEEDED", endedAt: "2026-08-21T00:00:00.000Z" });
  const unseen = renderToStaticMarkup(<SessionRow session={finished} unseen />);
  const seen = renderToStaticMarkup(<SessionRow session={finished} unseen={false} />);
  assert.match(unseen, /data-session-unseen/);
  assert.match(unseen, /data-session-unseen="true"[^>]*bg-\[color:var\(--status-green-fg\)\]/);
  assert.ok(unseen.indexOf("data-session-unseen") < unseen.indexOf("data-session-time"), "unseen dot trails title and precedes time");
  assert.match(unseen, /font-bold/);
  assert.doesNotMatch(seen, /data-session-unseen/);
  assert.match(seen, /font-normal/);
});

test("Sessions.tsx uses design tokens, never a hard-coded hex colour", () => {
  const source = readFileSync(fileURLToPath(new URL("../pages/Sessions.tsx", import.meta.url)), "utf8");
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(source), false);
});

test("opening a Session marks it opened, and returning to the list clears its dot", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const detail = session({ projectId: "p-open", executionStatus: "SUCCEEDED", endedAt: "2026-08-21T01:00:00.000Z" });
  const seenKey = sessionSeenKey("p-open");
  storage.set(seenKey, JSON.stringify({ since: "2026-08-20T00:00:00.000Z", opened: {} }));
  const fetchHarness = installFetchFunction(async (input) => {
      const path = String(input);
      const payload = path.includes("/runs/")
        ? { events: [], hasMore: false, total: 0 }
        : path.includes("/projects")
          ? [{ id: "p-open", name: "Open project" }]
          : path.includes("/sessions/session-1") ? detail : [detail];
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
  });
  const { SessionDetailPage } = await import("../pages/Sessions");
  const { ProjectProvider } = await import("../lib/project");
  const root = createRoot(container);
  const flush = fetchHarness.settle;
  try {
    await act(async () => { root.render(<SessionDetailPage sessionId="session-1" />); });
    await flush();
    const opened = JSON.parse(storage.get(seenKey) ?? "null") as { opened: Record<string, string> } | null;
    assert.ok(opened?.opened[detail.id], "detail mount records the opened Session");

    await act(async () => { root.render(<ProjectProvider><SessionsPage /></ProjectProvider>); });
    await flush();
    assert.equal(dom.window.document.querySelectorAll("[data-session-unseen]").length, 0, container.innerHTML);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    fetchHarness.dispose();
  }
});

test("a Session finishing while its detail page is open is marked opened again", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  let detail = session({ projectId: "p-transition", executionStatus: "RUNNING", endedAt: null });
  const seenKey = sessionSeenKey("p-transition");
  storage.set(seenKey, JSON.stringify({ since: "2026-08-20T00:00:00.000Z", opened: {} }));
  const fetchHarness = installFetchFunction(async (input) => {
      const path = String(input);
      const payload = path.includes("/runs/")
        ? { events: [], hasMore: false, total: 0 }
        : detail;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
  });
  const { SessionDetailPage } = await import("../pages/Sessions");
  const root = createRoot(container);
  const flush = fetchHarness.settle;
  try {
    await act(async () => { root.render(<SessionDetailPage sessionId="session-1" />); });
    await flush();
    const initial = JSON.parse(storage.get(seenKey) ?? "null") as { opened: Record<string, string> } | null;
    const initialStamp = initial?.opened[detail.id];
    assert.ok(initialStamp, "mount records the live Session too");

    await new Promise((resolve) => dom.window.setTimeout(resolve, 2));
    detail = { ...detail, executionStatus: "SUCCEEDED", endedAt: "2026-08-21T01:00:00.000Z" };
    const refresh = [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Refresh");
    assert.ok(refresh, container.innerHTML);
    await click(dom, refresh);
    await flush();
    const transitioned = JSON.parse(storage.get(seenKey) ?? "null") as { since: string; opened: Record<string, string> } | null;
    const transitionedStamp = transitioned?.opened[detail.id];
    assert.ok(transitionedStamp, "terminal transition writes another opened stamp");
    assert.ok(new Date(transitionedStamp!).getTime() > new Date(initialStamp!).getTime(), "terminal transition writes a newer stamp");
    assert.equal(isSessionUnseen(detail, transitioned!), false, "the watched Session remains seen after finishing");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    fetchHarness.dispose();
  }
});

/* ------------------------------------------------------------ interaction */

const jsdom = (hash = ""): JSDOM => {
  // A real URL, because the page describes its filters in the hash and
  // `history.replaceState` refuses to run on `about:blank`.
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    pretendToBeVisual: true,
    url: `http://127.0.0.1:5173/${hash}`,
  });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    // `Event` is the global the router constructs its `hashchange` from, and
    // jsdom rejects an event built by a different window's constructor.
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
    PointerEvent: dom.window.MouseEvent, DOMRect: dom.window.DOMRect,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  return dom;
};

const click = async (dom: JSDOM, node: Element): Promise<void> => {
  await act(async () => { node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 })); });
};

test("focusing the title opens the translated hover card, including Inbox-wait duration", async () => {
  const data = session({
    executionStatus: "FAILED", resumeAttempt: 1, endedAt: "2026-08-16T00:05:01.000Z",
    failureReason: `first line ${"x".repeat(240)}`,
  });
  try {
    for (const [locale, labels] of [
      ["en", { started: "Started", duration: "Duration", runner: "Runner", result: "Result", run: "Run", failure: "Failure reason", wait: "wall-clock \\(includes Inbox wait\\)" }],
      ["zh", { started: "开始时间", duration: "时长", runner: "Runner", result: "结果", run: "运行", failure: "失败原因", wait: "墙上时钟时间（包括收件箱等待）" }],
    ] as const) {
      const dom = jsdom();
      const container = dom.window.document.querySelector("#root");
      assert.ok(container);
      const root = createRoot(container);
      try {
        await act(async () => { root.render(<LocaleProvider initialLocale={locale}><SessionRow session={data} /></LocaleProvider>); });
        await new Promise((resolve) => setTimeout(resolve, 10));
        await act(async () => { await Promise.resolve(); });
        const title = dom.window.document.querySelector<HTMLElement>("[data-session-title]");
        assert.ok(title, container.innerHTML);
        await act(async () => {
          title.focus();
          title.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }));
        });
        // The card opens on its own delay, so wait for the card rather than for
        // a sleep chosen to outlast that delay. Bounded at 600 polls so a card
        // that never opens fails at the assertion below rather than hanging the
        // suite, and counted rather than clocked so the bound scales with the
        // loaded gate worker rather than an idle host (CONTRIBUTING.md, "Test
        // timing on the gate worker").
        for (let poll = 0; poll < 600 && dom.window.document.querySelector("[data-slot='hover-card-content']") === null; poll += 1) {
          await act(async () => { await new Promise((resolve) => dom.window.setTimeout(resolve, 25)); });
        }
        assert.ok(dom.window.document.querySelector("[data-slot='hover-card-content']"), "the hover card never opened");
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await new Promise((resolve) => dom.window.setTimeout(resolve, 0)); });
        const body = dom.window.document.body.textContent ?? "";
        for (const label of [labels.started, labels.duration, labels.runner, labels.result, labels.run, labels.failure]) {
          assert.match(body, new RegExp(label));
        }
        assert.match(body, new RegExp(labels.wait));
        assert.match(body, /first line/);
        assert.doesNotMatch(body, /x{240}/);
        assert.equal(dom.window.document.querySelector("[data-slot='hover-card-content'] button"), null);
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    }
  } finally {
    setFormatLocale("en", (key, vars) => translate("en", key, vars));
  }
});

test("clicking the nested Task link opens the task, not the session", async () => {
  const dom = jsdom();
  dom.window.location.hash = "#/sessions";
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => { root.render(<SessionRow session={session()} />); });

  const link = dom.window.document.querySelector<HTMLAnchorElement>("a[href='#/tasks/task-1']");
  assert.ok(link, container.innerHTML);
  await click(dom, link);
  // Link prevents the default but does not stop propagation; the row handler
  // must yield to it or the operator lands on the session they did not click.
  assert.equal(dom.window.location.hash, "#/tasks/task-1");

  await act(async () => root.unmount());
  dom.window.close();
});

test("clicking a row anywhere else opens the session", async () => {
  const dom = jsdom();
  dom.window.location.hash = "#/sessions";
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => { root.render(<SessionRow session={session()} />); });

  const row = dom.window.document.querySelector("[data-session-row]");
  assert.ok(row);
  await click(dom, row);
  assert.equal(dom.window.location.hash, "#/sessions/session-1");

  await act(async () => root.unmount());
  dom.window.close();
});

test("clicking a collapsed tool row reveals Arguments and Result", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<StreamNodeView node={{
      kind: "tools", id: "group-0", at: "2026-08-16T00:00:00.000Z", calls: [{
        kind: "tool", id: "t1", at: "2026-08-16T00:00:00.000Z", name: "Bash", primaryArg: "printf 3",
        filePath: null, args: { command: "printf 3" }, result: "3", state: "ok",
      }],
    }} />);
  });
  assert.doesNotMatch(container.innerHTML, />Arguments</);

  const toggle = dom.window.document.querySelector("button");
  assert.ok(toggle);
  await click(dom, toggle);
  assert.match(container.innerHTML, />Arguments</);
  assert.match(container.innerHTML, />Result</);

  await act(async () => root.unmount());
  dom.window.close();
});

test("clicking one tool line expands only that call", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => { root.render(<StreamNodeView node={toolNode} />); });

  const lines = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button[data-tool-line]")];
  assert.equal(lines.length, 2);
  assert.doesNotMatch(container.innerHTML, /READ_RESULT_UNIQUE|RUN_RESULT_UNIQUE/);
  await click(dom, lines[0]!);
  assert.match(container.innerHTML, /READ_RESULT_UNIQUE/);
  assert.doesNotMatch(container.innerHTML, /RUN_RESULT_UNIQUE/);

  await act(async () => root.unmount());
  dom.window.close();
});

const oversizedToolNode = {
  kind: "tools" as const,
  id: "oversized-group",
  at: "2026-08-16T00:00:00.000Z",
  calls: [{
    kind: "tool" as const,
    id: "oversized-call",
    at: "2026-08-16T00:00:00.000Z",
    name: "Bash",
    primaryArg: "printf output",
    filePath: null,
    args: Array.from({ length: TOOL_OUTPUT_MAX_LINES + 3 }, (_, index) => `argument ${index + 1}`),
    result: Array.from({ length: TOOL_OUTPUT_MAX_LINES + 5 }, (_, index) => `result ${index + 1}`).join("\n"),
    state: "ok" as const,
  }],
};

test("expanded tool arguments and results clamp at 40 lines and show what was withheld", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => { root.render(<StreamNodeView node={oversizedToolNode} />); });
  const toggle = dom.window.document.querySelector<HTMLButtonElement>("button[data-tool-line]");
  assert.ok(toggle);
  await click(dom, toggle);

  const body = container.textContent ?? "";
  assert.match(body, /argument 1/);
  assert.match(body, /result 1/);
  assert.doesNotMatch(body, /argument 43/);
  assert.doesNotMatch(body, /result 45/);
  assert.equal((body.match(/5 more lines withheld/gu) ?? []).length, 2);
  assert.match(container.innerHTML, /max-h-\[460px\]/);

  await act(async () => root.unmount());
  dom.window.close();
});

test("a one-line result still reaches the 8 000-character byte backstop after line clamping", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<StreamNodeView node={{
      kind: "tools", id: "byte-group", at: "2026-08-16T00:00:00.000Z", calls: [{
        kind: "tool", id: "byte-call", at: "2026-08-16T00:00:00.000Z", name: "Bash", primaryArg: "printf",
        filePath: null, args: null, result: "x".repeat(9_000), state: "ok",
      }],
    }} />);
  });
  const toggle = dom.window.document.querySelector<HTMLButtonElement>("button[data-tool-line]");
  assert.ok(toggle);
  await click(dom, toggle);
  assert.match(container.textContent ?? "", /… truncated, 1000 more characters/);
  assert.doesNotMatch(container.textContent ?? "", /more lines withheld/);

  await act(async () => root.unmount());
  dom.window.close();
});

test("withheld-line wording is translated with its count in English and Chinese", async () => {
  const renderExpanded = async (locale: "en" | "zh"): Promise<{ dom: JSDOM; root: ReturnType<typeof createRoot>; container: Element }> => {
    const dom = jsdom();
    const container = dom.window.document.querySelector("#root");
    assert.ok(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<LocaleProvider initialLocale={locale}><StreamNodeView node={oversizedToolNode} /></LocaleProvider>);
    });
    const toggle = dom.window.document.querySelector<HTMLButtonElement>("button[data-tool-line]");
    assert.ok(toggle);
    await click(dom, toggle);
    return { dom, root, container };
  };

  try {
    const english = await renderExpanded("en");
    assert.match(english.container.textContent ?? "", /5 more lines withheld/);
    await act(async () => english.root.unmount());
    english.dom.window.close();

    const chinese = await renderExpanded("zh");
    assert.match(chinese.container.textContent ?? "", /还有 5 行未显示/);
    await act(async () => chinese.root.unmount());
    chinese.dom.window.close();
  } finally {
    setFormatLocale("en", (key, vars) => translate("en", key, vars));
  }
});

test("clicking Show more reveals the rest of a long text node", async () => {
  const dom = jsdom();
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const text = Array.from({ length: TEXT_NODE_MAX_LINES + 2 }, (_, index) => `full prose ${index + 1}`).join("\n");
  await act(async () => { root.render(<StreamNodeView node={{ kind: "text", id: "long-interactive", at: "2026-08-16T00:00:00.000Z", text, final: false }} />); });
  assert.doesNotMatch(container.textContent ?? "", /full prose 14/);
  const more = [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Show more");
  assert.ok(more);
  await click(dom, more);
  assert.match(container.textContent ?? "", /full prose 14/);
  assert.match(container.textContent ?? "", /Show less/);

  await act(async () => root.unmount());
  dom.window.close();
});

test("the Debug events filter switches between all, provider and runner rows", async () => {
  const dom = jsdom();
  const events = [event(), event({ id: "e2", seq: 2, source: "CLAUDE", type: "PROVIDER_RAW" })];
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => { root.render(<DebugEvents events={events} />); });

  const byLabel = async (label: string): Promise<void> => {
    const button = [...dom.window.document.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
    assert.ok(button, `${label} not found in ${container.innerHTML}`);
    await click(dom, button);
  };

  await byLabel("Debug events");
  assert.match(container.innerHTML, /PROCESS_STARTED/);
  assert.match(container.innerHTML, /PROVIDER_RAW/);

  await byLabel("Runner");
  assert.match(container.innerHTML, /PROCESS_STARTED/);
  assert.doesNotMatch(container.innerHTML, /PROVIDER_RAW/);

  await byLabel("Provider");
  assert.doesNotMatch(container.innerHTML, /PROCESS_STARTED/);
  assert.match(container.innerHTML, /PROVIDER_RAW/);

  await act(async () => root.unmount());
  dom.window.close();
});

test("Load more keeps page one and dedupes it against the live head", async () => {
  // No localStorage stub: jsdom's default about:blank origin is opaque and the
  // getter throws, which lib/storage.ts already degrades to its in-memory map.
  const dom = jsdom();

  const head = (ids: string[]) => ids.map((id, index) => {
    const at = new Date(Date.UTC(2026, 7, 16 - index, 2, 0, 0)).toISOString();
    return session({ id, requestedAt: at, startedAt: at });
  });
  const older = Array.from({ length: 50 }, (_, index) => {
    const at = new Date(Date.UTC(2026, 1, 15 - index, 1, 0, 0)).toISOString();
    return session({ id: `old-${index}`, requestedAt: at, startedAt: at });
  });

  let headRows = head(Array.from({ length: 50 }, (_, index) => `new-${index}`));
  const requests: string[] = [];
  const fetchHarness = installFetchFunction(async (input) => {
      const path = String(input);
      requests.push(path);
      const payload = path.includes("/projects") ? [{ id: "p1", name: "Demo" }]
        : path.includes("before=") ? older
          : headRows;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
  });

  const { ProjectProvider } = await import("../lib/project");
  const { SessionsPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const flush = fetchHarness.settle;
  await act(async () => { root.render(<ProjectProvider><SessionsPage /></ProjectProvider>); });
  await flush();

  const rows = (): number => dom.window.document.querySelectorAll("[data-session-row]").length;
  assert.equal(dom.window.document.querySelectorAll("table").length, 0);
  assert.equal(rows(), 50);

  const more = [...dom.window.document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Load more");
  assert.ok(more, container.innerHTML);
  await click(dom, more);
  await flush();
  assert.equal(rows(), 100, "page one is retained under page two");
  assert.ok(requests.some((path) => path.includes("before=")));

  // A head poll that now overlaps an older row must not double it: 50 + 50 with
  // one shared id is 100 rows, not the 101 a naive concatenation would produce.
  headRows = [...head(Array.from({ length: 50 }, (_, index) => `new-${index}`)), older[0] as Session];
  await act(async () => {
    const refresh = [...dom.window.document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Refresh");
    assert.ok(refresh);
    refresh.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await flush();
  assert.equal(rows(), 100, "the id dedup holds");

  await act(async () => root.unmount());
  dom.window.close();
  fetchHarness.dispose();
});

test("the detail page does not call the initial drain `N new`", async () => {
  // Caught in a real browser against a 771-event session: every historical
  // event was counted as unseen, so the page opened offering `98 new ↓`.
  const dom = jsdom();
  // JSDOM has no layout, so every scroll metric is 0 and the stream always reads
  // as "already at the bottom" — which is the one branch that never counts.
  // Stub the two metrics so the scrolled-up branch is the one under test.
  Object.defineProperty(dom.window.Element.prototype, "scrollHeight", { configurable: true, get: () => 5_000 });
  Object.defineProperty(dom.window.Element.prototype, "clientHeight", { configurable: true, get: () => 400 });

  const events = Array.from({ length: 12 }, (_, index) => event({
    id: `e${index}`, seq: index + 1, source: "CLAUDE", type: "MODEL_DELTA",
    payload: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `line ${index}` }] } },
  }));
  const detail = session({ executionStatus: "SUCCEEDED", endedAt: "2026-08-16T00:10:00.000Z" });
  const fetchHarness = installFetchFunction(async (input) => {
      const path = String(input);
      // Two pages, so the flag has to survive an intermediate render.
      const payload = path.includes("/events")
        ? path.includes("afterSeq=6")
          ? { events: events.slice(6), hasMore: false, total: 12 }
          : { events: events.slice(0, 6), hasMore: true, total: 12 }
        : detail;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
  });

  const { SessionDetailPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<SessionDetailPage sessionId="session-1" />); });
    for (let guard = 0; guard < 100 && !/line 5/u.test(container.innerHTML); guard += 1) {
      await fetchHarness.settle();
      await act(async () => { await new Promise((resolve) => dom.window.setTimeout(resolve, 0)); });
    }
    assert.match(container.innerHTML, /line 5/, "both pages drained into the visible merged node");
    assert.doesNotMatch(container.innerHTML, /new ↓/, "history is not news");
  } finally {
    // The page polls forever on real timers; without an unmount on the failure
    // path the runner never sees the event loop drain and the file hangs.
    await act(async () => root.unmount());
    dom.window.close();
    fetchHarness.dispose();
  }
});

test("the live stream counts a call added to the tail tool group as one new node", async () => {
  const dom = jsdom();
  Object.defineProperty(dom.window, "scrollTo", { configurable: true, value: () => undefined });
  Object.defineProperty(dom.window.Element.prototype, "scrollHeight", { configurable: true, get: () => 5_000 });
  Object.defineProperty(dom.window.Element.prototype, "clientHeight", { configurable: true, get: () => 400 });

  const initial = [
    event({ id: "tool-1-start", seq: 1, source: "CLAUDE", type: "TOOL_STARTED", toolCallId: "tool-1", payload: { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/a.ts" } } }),
    event({ id: "tool-1-end", seq: 2, source: "CLAUDE", type: "TOOL_COMPLETED", toolCallId: "tool-1", payload: { tool_use_id: "tool-1", content: "a", is_error: false } }),
  ];
  const calls = [
    event({ id: "tool-2-start", seq: 3, source: "CLAUDE", type: "TOOL_STARTED", toolCallId: "tool-2", payload: { type: "tool_use", id: "tool-2", name: "Bash", input: { command: "npm test" } } }),
    event({ id: "tool-2-end", seq: 4, source: "CLAUDE", type: "TOOL_COMPLETED", toolCallId: "tool-2", payload: { tool_use_id: "tool-2", content: "ok", is_error: false } }),
  ];
  let current = initial;
  const detail = session({ executionStatus: "RUNNING" });
  const fetchHarness = installFetchFunction(async (input) => {
      const path = String(input);
      const payload = path.includes("/runs/")
        ? path.includes("afterSeq=2")
          ? { events: calls, hasMore: false, total: 4 }
          : { events: current, hasMore: false, total: current.length }
        : detail;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
  });

  const { SessionDetailPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const flush = fetchHarness.settle;
  try {
    await act(async () => { root.render(<SessionDetailPage sessionId="session-1" />); });
    await flush();
    const scroller = container.querySelector<HTMLElement>('div[class*="max-h-[720px]"]');
    assert.ok(scroller, container.innerHTML);
    scroller.scrollTop = 0;
    current = [...initial, ...calls];
    const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Refresh");
    assert.ok(refresh, container.innerHTML);
    await click(dom, refresh);
    await flush();

    assert.match(container.textContent ?? "", /1 new ↓/u, "one call inside the projected tools node is new");
    assert.equal((container.textContent?.match(/Tool calls/gu) ?? []).length, 1);
    const news = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "1 new ↓");
    assert.ok(news, container.innerHTML);
    await click(dom, news);
    assert.equal(scroller.scrollTop, 5_000);
    assert.doesNotMatch(container.textContent ?? "", /1 new ↓/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    fetchHarness.dispose();
  }
});

test("a live stream at the bottom auto-scrolls after its initial drain", async () => {
  const dom = jsdom();
  Object.defineProperty(dom.window, "scrollTo", { configurable: true, value: () => undefined });
  Object.defineProperty(dom.window.Element.prototype, "scrollHeight", { configurable: true, get: () => 5_000 });
  Object.defineProperty(dom.window.Element.prototype, "clientHeight", { configurable: true, get: () => 400 });
  const initial = event({
    id: "initial-bottom", seq: 1, source: "CLAUDE", type: "MODEL_DELTA", payload: CLAUDE_TEXT_ASSISTANT,
  });
  let current = [initial];
  const detail = session({ executionStatus: "RUNNING" });
  const fetchHarness = installFetchFunction(async (input) => {
      const path = String(input);
      const payload = path.includes("/runs/")
        ? { events: current, hasMore: false, total: current.length }
        : detail;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
  });

  const { SessionDetailPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const flush = fetchHarness.settle;
  try {
    await act(async () => { root.render(<SessionDetailPage sessionId="session-1" />); });
    await flush();
    const scroller = container.querySelector<HTMLElement>('div[class*="max-h-[720px]"]');
    assert.ok(scroller, container.innerHTML);
    assert.equal(scroller.scrollTop, 5_000);
    scroller.scrollTop = 4_600;
    current = [initial, event({ id: "new-bottom", seq: 2, source: "CLAUDE", type: "MODEL_DELTA", payload: CLAUDE_TEXT_ASSISTANT })];
    const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Refresh");
    assert.ok(refresh, container.innerHTML);
    await click(dom, refresh);
    await flush();
    assert.equal(scroller.scrollTop, 5_000);
    assert.doesNotMatch(container.textContent ?? "", /new ↓/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    fetchHarness.dispose();
  }
});

test("a live stream counts assistant prose absorbed by the tail text node", async () => {
  const dom = jsdom();
  Object.defineProperty(dom.window, "scrollTo", { configurable: true, value: () => undefined });
  Object.defineProperty(dom.window.Element.prototype, "scrollHeight", { configurable: true, get: () => 5_000 });
  Object.defineProperty(dom.window.Element.prototype, "clientHeight", { configurable: true, get: () => 400 });
  const first = event({ id: "assistant-1", seq: 1, source: "CLAUDE", type: "MODEL_DELTA", payload: CLAUDE_TEXT_ASSISTANT });
  let current = [first];
  const detail = session({ executionStatus: "RUNNING" });
  const fetchHarness = installFetchFunction(async (input) => {
      const path = String(input);
      const payload = path.includes("/runs/")
        ? { events: current, hasMore: false, total: current.length }
        : detail;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
  });

  const { SessionDetailPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const flush = fetchHarness.settle;
  try {
    await act(async () => { root.render(<SessionDetailPage sessionId="session-1" />); });
    await flush();
    const scroller = container.querySelector<HTMLElement>('div[class*="max-h-[720px]"]');
    assert.ok(scroller, container.innerHTML);
    scroller.scrollTop = 0;
    current = [first, event({
      id: "assistant-2", seq: 2, source: "CLAUDE", type: "MODEL_DELTA",
      payload: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "more prose" }] } },
    })];
    const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Refresh");
    assert.ok(refresh, container.innerHTML);
    await click(dom, refresh);
    await flush();
    assert.match(container.textContent ?? "", /more prose/u);
    assert.match(container.textContent ?? "", /1 new ↓/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    fetchHarness.dispose();
  }
});

test("a capped stream keeps the visible event-cap notice", async () => {
  const dom = jsdom();
  Object.defineProperty(dom.window, "scrollTo", { configurable: true, value: () => undefined });
  const detail = session({ executionStatus: "SUCCEEDED", endedAt: "2026-08-16T00:10:00.000Z" });
  let seq = 0;
  const fetchHarness = installFetchFunction(async (input) => {
      const path = String(input);
      if (!path.includes("/runs/")) {
        return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(detail) } as unknown as Response;
      }
      seq += 1;
      const row = event({
        id: `capped-${seq}`, seq, source: "CLAUDE", type: "MODEL_DELTA",
        payload: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `event ${seq}` }] } },
      });
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({
        events: [row], hasMore: true, total: 100,
      }) } as unknown as Response;
  });

  const { SessionDetailPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<SessionDetailPage sessionId="session-1" />); });
    for (let guard = 0; guard < 100 && seq < 40; guard += 1) {
      await fetchHarness.settle();
      await act(async () => { await new Promise((resolve) => dom.window.setTimeout(resolve, 0)); });
    }
    assert.equal(seq, 40);
    assert.match(container.textContent ?? "", /Showing the first 40 of 100 events/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    fetchHarness.dispose();
  }
});

test("a failed Load more tells the operator instead of vanishing into the console", async () => {
  const dom = jsdom();
  const headRows = Array.from({ length: 50 }, (_, index) => {
    const at = new Date(Date.UTC(2026, 7, 16 - index, 2, 0, 0)).toISOString();
    return session({ id: `new-${index}`, requestedAt: at, startedAt: at });
  });

  const fetchHarness = installFetchFunction(async (input) => {
      const path = String(input);
      if (path.includes("/projects")) {
        return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify([{ id: "p1", name: "Demo" }]) } as unknown as Response;
      }
      // Only the older page fails, so the live head stays on screen.
      if (path.includes("before=")) {
        return { ok: false, status: 503, headers: new Headers(), text: async () => JSON.stringify({ error: "Service unavailable" }) } as unknown as Response;
      }
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(headRows) } as unknown as Response;
  });

  const { ProjectProvider } = await import("../lib/project");
  const { SessionsPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  const flush = fetchHarness.settle;
  await act(async () => { root.render(<ProjectProvider><SessionsPage /></ProjectProvider>); });
  await flush();

  const more = [...dom.window.document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Load more");
  assert.ok(more, container.innerHTML);
  await click(dom, more);
  await flush();

  assert.match(container.textContent ?? "", /503/, "the failure is on the page, not only in the console");
  assert.equal(dom.window.document.querySelectorAll("[data-session-row]").length, 50, "page one survives a failed page two");
  const retry = [...dom.window.document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Load more");
  assert.ok(retry, "the button stays available as the retry");
  assert.equal(retry.hasAttribute("disabled"), false);

  await act(async () => root.unmount());
  dom.window.close();
  fetchHarness.dispose();
});

test("the session detail header names the model the run executed with", async () => {
  const dom = jsdom();
  Object.defineProperty(dom.window, "scrollTo", { configurable: true, value: () => undefined });
  const detail = session({
    run: { id: "run-1", runNumber: 3, model: "gpt-6-astra:high", branch: null, pullRequestUrl: null, workspacePath: null, repo: null },
  });
  const fetchHarness = installFetchFunction(async (input) => {
    const payload = String(input).includes("/runs/")
      ? { events: [], hasMore: false, total: 0 }
      : detail;
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
  });
  const { SessionDetailPage } = await import("../pages/Sessions");
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<SessionDetailPage sessionId="session-1" />); });
    await fetchHarness.settle();
    const heading = container.querySelector("h1");
    assert.ok(heading, container.innerHTML);
    const header = heading.parentElement;
    assert.ok(header);
    // The heading names the Agent; beside it, the runtime that Run carried.
    assert.match(header.textContent ?? "", /Frontend Dev/u);
    assert.match(header.textContent ?? "", /GPT-6 Astra \(codex\)/u);
    assert.match(header.textContent ?? "", /high/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    fetchHarness.dispose();
  }
});
