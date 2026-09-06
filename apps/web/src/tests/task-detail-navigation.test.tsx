import assert from "node:assert/strict";
import test from "node:test";

import { act, type ReactNode, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiError } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { Chain, Run, TaskDetail, TaskStartability, TaskStepOutput } from "../lib/types";
import { RunRow, TaskDetailPage, TaskOutput } from "../pages/TaskDetail";
import { mountPage } from "./dom-harness";
import prompts from "./fixtures/tc-ux-v1-prompts.json";

const now = "2026-08-17T00:00:00.000Z";
const task = (id: string, name: string, promptIndex: number, chainId: string | null = null): TaskDetail => ({
  id, projectId: "project-1", assigneeAgentId: "agent-1", repoId: "repo-1",
  templateId: null, templateStepId: null, name,
  description: prompts[promptIndex]!.prompt,
  workingDirectory: null, targetBranch: "main", failureReason: null, status: "TODO",
  moveTargets: chainId === null
    ? [{ status: "BACKLOG", via: "patch" }, { status: "DOING", via: "start" }]
    : [],
  assigneeType: "AGENT", executionOwner: "agent", approvalGate: false, scheduleKind: "NOW", runAt: null,
  cron: null, timezone: null, maxDurationMin: 120, stallTimeoutMin: 10,
  maxSessionsPerTask: 3, createdAt: now, updatedAt: now, assigneeAgent: null,
  repo: null, runs: [], strandedSalvageBranches: [], chainId, chainIndex: chainId ? 0 : null, source: "MANUAL",
  archivedAt: null, schedulePausedAt: null, recurringSourceTaskId: null,
  templateStep: null, taskCost: null, mergeOutcome: null, mergeRecovery: null,
  budgetRemaining: true, editableBrief: null,
});

const output = (taskId: string, body: string): TaskStepOutput => ({
  id: `output-${taskId}`, taskId, runId: `run-${taskId}`, kind: "revised-plan", body,
  metadata: null, commitSha: null, createdAt: now, updatedAt: now,
});

const sourceRun = (taskId: string): Run => ({
  id: `run-${taskId}`, projectId: "project-1", taskId, goalId: null, agentId: "agent-1", repoId: "repo-1",
  runNumber: 1, status: "SUCCEEDED", runner: "CLAUDE", runnerId: "runner-source", model: "claude",
  codexServiceTier: "DEFAULT", subagentModel: null, subagentMaxConcurrent: null,
  leaseGeneration: 1, cancelRequestId: null, cancelReason: null, cancelRequestedAt: null, cancelAcknowledgedAt: null,
  workspacePath: "/source-only-workspace", workspaceRetained: true,
  targetBranch: "main", branch: "source-branch", baseSha: "1111111111111111", headSha: "2222222222222222",
  pushStatus: "SUCCEEDED", pullRequestUrl: null, maxDurationMin: 120, stallTimeoutMin: 10,
  maxRunsPerTask: 3, failureClass: null, failureReason: null, retryable: null, retryAt: null,
  terminationReason: null, queuedAt: now, claimedAt: now, startedAt: now, endedAt: now, session: null,
});

const emptyChain = (): Chain => ({ chainId: null, total: 0, done: 0, control: null, steps: [] });
const chainFor = (taskId: string): Chain => ({
  chainId: "chain-c", total: 1, done: 0, steps: [{
    taskId, position: 1, chainIndex: 0, layer: null, name: "Chain C", stepName: "Chain C",
    status: "TODO", approvalGate: false, gateSlot: null, assigneeType: "AGENT", executionOwner: "agent",
    agent: { id: "agent-1", title: "Builder", name: "senior-dev-astra-medium", model: "gpt-6-astra:medium" },
    archivedAt: null, failureReason: null, latestRun: null, reassignable: true,
    startable: true, startAction: "start", holdRefusal: null,
    blockedOn: null, currentExecution: false, mergeRecovery: null,
  }], control: null,
});

test("a resumed run identifies Duration as wall-clock time that includes Inbox wait", () => {
  const run = sourceRun("task-1");
  run.startedAt = "2026-08-17T00:00:00.000Z";
  run.endedAt = "2026-08-17T00:05:00.000Z";
  run.session = { executionStatus: "SUCCEEDED", resumeAttempt: 1 } as NonNullable<Run["session"]>;
  const markup = renderToStaticMarkup(<table><tbody><RunRow run={run} remoteUrl={null} expanded={false} onToggle={() => undefined} /></tbody></table>);
  assert.match(markup, /5m 0s wall-clock \(includes Inbox wait\)/);
});

test("the run row links its session in a column of its own, with Branch last", () => {
  const run = sourceRun("task-1");
  run.session = { id: "session-1", executionStatus: "SUCCEEDED", resumeAttempt: 0 } as NonNullable<Run["session"]>;
  const rowMarkup = (expanded: boolean): string => renderToStaticMarkup(
    <table><tbody><RunRow run={run} remoteUrl={null} expanded={expanded} onToggle={() => undefined} /></tbody></table>,
  );

  const collapsed = rowMarkup(false);
  assert.match(collapsed, /href="#\/sessions\/session-1"/u);
  const cells = [...collapsed.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gu)].map((match) => match[1]!);
  assert.match(cells.at(-1)!, /source-branch/u, collapsed);
  assert.equal(cells.filter((cell) => /source-branch/u.test(cell)).length, 1);

  // The expanded panel no longer repeats the link the row already carries.
  assert.equal((rowMarkup(true).match(/Open session/gu) ?? []).length, 1);
});

const startability = (satisfied: boolean): TaskStartability => ({
  startable: satisfied,
  checklist: {
    repoBound: satisfied, agentAssignee: satisfied, repoAccessGrant: satisfied,
    budgetRemaining: satisfied, noActiveRun: satisfied, predecessorsDone: satisfied,
  },
  task: { id: "details", name: "Details task", agent: null, repo: null, targetBranch: null },
});

test("an exhausted budget is a lever on the page, not a button the API answers 409", async () => {
  const subject = task("spent", "Spent task", 0);
  subject.runs = [{ ...sourceRun("spent"), status: "FAILED" }];
  subject.failureReason = "gate refused the candidate";
  subject.budgetRemaining = false;
  subject.maxSessionsPerTask = 5;
  subject.editableBrief = "Ship the retry control.";
  const page = await mountPage(<TaskDetailPage taskId="spent" />, {
    "/tasks/spent": subject,
    "/tasks/spent/output": new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    "/tasks/spent/startability": startability(false),
    "/tasks/spent/activity": [],
    "/tasks/spent/chain": emptyChain(),
    "PATCH /tasks/spent": subject,
  }, "http://localhost/tasks/spent");
  const retry = (): HTMLButtonElement => {
    const button = [...page.container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === "Retry");
    assert.ok(button instanceof HTMLButtonElement, page.container.innerHTML);
    return button;
  };
  const patches = (): unknown[] => page.requests
    .filter((request) => request.method === "PATCH")
    .map((request) => JSON.parse(String(request.init.body)));
  try {
    // Offered and disabled, with the way out named. Hiding it would leave the
    // operator guessing, and enabling it spends a round trip on a refusal.
    assert.equal(retry().disabled, true);
    assert.match(retry().title, /Raise this task's run budget/u);

    const budget = page.container.querySelector("input[aria-label='Run budget']");
    assert.ok(budget instanceof page.dom.window.HTMLInputElement);
    assert.equal(budget.value, "5");
    assert.match(page.container.textContent ?? "", /1 used/u);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(page.dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(budget, "10");
      budget.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => { // React delegates onBlur through focusout; a bare `blur` event never reaches it.
      budget.dispatchEvent(new page.dom.window.FocusEvent("focusout", { bubbles: true })); });
    await page.settle();
    assert.deepEqual(patches(), [{ maxSessionsPerTask: 10 }]);

    // The prompt is read-only until asked, and what saves is the operator's
    // half of it — the server decided which half that is.
    assert.equal(page.container.querySelector("textarea"), null);
    await page.press("Edit");
    const draft = page.container.querySelector("textarea");
    assert.ok(draft instanceof page.dom.window.HTMLTextAreaElement);
    assert.equal(draft.value, "Ship the retry control.");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(page.dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(draft, "Ship it, and say why the last attempt stalled.");
      draft.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
    });
    await page.press("Save");
    assert.deepEqual(patches()[1], { description: "Ship it, and say why the last attempt stalled." });

    // A stale failure the operator has read is theirs to clear; no run invented.
    await page.press("Clear");
    assert.deepEqual(patches()[2], { failureReason: null });
  } finally {
    await page.dispose();
  }
});

test("the Details card leads with the live fields and keeps configuration behind a toggle", async () => {
  const subject = task("details", "Details task", 0);
  subject.runs = [sourceRun("details")];
  subject.repo = {
    id: "repo-1", projectId: "project-1", credentialSecretId: null, name: "anneal",
    remoteUrl: "https://github.com/o/r", mountPath: "/repos/anneal", defaultBranch: "main",
    dependencyProvisioning: "NONE",
    createdAt: now, updatedAt: now,
  };
  const page = await mountPage(<TaskDetailPage taskId="details" />, {
    "/tasks/details": subject,
    "/tasks/details/output": new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    "/tasks/details/startability": startability(true),
    "/tasks/details/activity": [],
    "/tasks/details/chain": emptyChain(),
  }, "http://localhost/tasks/details");
  const text = (): string => page.container.textContent ?? "";
  const configurationButton = (): HTMLButtonElement => {
    const button = [...page.container.querySelectorAll("button")]
      .find((candidate) => /configuration/u.test(candidate.textContent ?? ""));
    assert.ok(button instanceof HTMLButtonElement);
    return button;
  };
  try {
    for (const label of ["Execution owner", "Branch", "Pull request"]) assert.match(text(), new RegExp(label), label);
    for (const label of ["Repo", "Target branch", "Schedule", "Working directory", "Created"]) {
      assert.doesNotMatch(text(), new RegExp(label), label);
    }
    // Every checklist item is satisfied and the task has run, so it says nothing.
    assert.doesNotMatch(text(), /Ready to start/u);
    assert.equal(configurationButton().getAttribute("aria-expanded"), "false");

    await page.press("Show configuration");
    assert.equal(configurationButton().getAttribute("aria-expanded"), "true");
    for (const label of ["Repo", "Target branch", "Schedule", "Working directory", "Requires approval", "Created"]) {
      assert.match(text(), new RegExp(label), label);
    }

    await page.press("Hide configuration");
    assert.doesNotMatch(text(), /Working directory/u);
  } finally {
    await page.dispose();
  }
});

test("the Now block shows the newest run, latest agent message and session link, and expands plain text", async () => {
  const fullBody = "<agent update>\nline two\nline three\nline four";
  const subject = task("now", "Now task", 0);
  const newest = sourceRun("now");
  newest.runNumber = 2;
  newest.session = {
    id: "session-now", executionStatus: "SUCCEEDED", resumeAttempt: 0,
    latestAgentMessage: { body: fullBody, at: now },
  } as NonNullable<Run["session"]>;
  const older = sourceRun("now-older");
  older.taskId = "now";
  older.session = {
    id: "session-older", executionStatus: "SUCCEEDED", resumeAttempt: 0,
    latestAgentMessage: { body: "older message must not win", at: now },
  } as NonNullable<Run["session"]>;
  subject.runs = [newest, older];
  const page = await mountPage(<TaskDetailPage taskId="now" />, {
    "/tasks/now": subject,
    "/tasks/now/output": new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    "/tasks/now/startability": startability(true),
    "/tasks/now/activity": [],
    "/tasks/now/chain": emptyChain(),
  }, "http://localhost/tasks/now");
  const text = (): string => page.container.textContent ?? "";
  const toggle = (): HTMLButtonElement => {
    const button = page.container.querySelector("[data-task-now] button[aria-expanded]");
    assert.ok(button instanceof HTMLButtonElement);
    return button;
  };
  try {
    assert.match(text(), /run 2 · claude · succeeded/u);
    assert.match(text(), new RegExp(fullBody.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.doesNotMatch(text(), /older message must not win/u);
    assert.match(text(), new RegExp(timeAgo(now).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.match(text(), /Open session/u);
    assert.equal(page.container.querySelector("a[href='#/sessions/session-now']")?.textContent, "Open session ↗");
    assert.equal(toggle().getAttribute("aria-expanded"), "false");
    assert.equal(toggle().getAttribute("aria-label"), null);
    assert.match(toggle().className, /line-clamp-3/u);

    await act(async () => toggle().dispatchEvent(new page.dom.window.MouseEvent("click", { bubbles: true })));
    assert.equal(toggle().getAttribute("aria-expanded"), "true");
    assert.doesNotMatch(toggle().className, /line-clamp-3/u);
    assert.equal(toggle().textContent, fullBody);
  } finally {
    await page.dispose();
  }
});

test("the task detail omits the Now block when it has no runs", async () => {
  const subject = task("no-now", "No Now task", 0);
  const page = await mountPage(<TaskDetailPage taskId="no-now" />, {
    "/tasks/no-now": subject,
    "/tasks/no-now/output": new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    "/tasks/no-now/startability": startability(true),
    "/tasks/no-now/activity": [],
    "/tasks/no-now/chain": emptyChain(),
  }, "http://localhost/tasks/no-now");
  try {
    assert.equal(page.container.querySelector("[data-task-now]"), null);
  } finally {
    await page.dispose();
  }
});

let replaceSubject: ((subject: ReactNode) => void) | null = null;

const SubjectHarness = ({ initial }: { initial: ReactNode }): ReactNode => {
  const [subject, setSubject] = useState(initial);
  replaceSubject = (next) => setSubject(next);
  return subject;
};

test("task-id switches expose a clean loading shell and destination-scoped actions", async () => {
  const mutations: Array<{ url: string; method: string; body: string }> = [];
  let resolveB: ((response: Response) => void) | null = null;
  let resolveAActivity: ((response: Response) => void) | null = null;
  let firstB = true;
  let firstAActivity = true;
  const tasks = { a: task("a", "Source A", 0), b: task("b", "Destination B", 1), c: task("c", "Destination C", 2, "chain-c") };
  tasks.a.runs = [sourceRun("a")];
  const page = await mountPage(<SubjectHarness initial={<TaskDetailPage taskId="a" />} />, { "*": ({ input, init, method }) => {
    const url = String(input).replace(/^.*\/api/, "");
    if (method !== "GET") {
      mutations.push({ url, method, body: String(init.body ?? "") });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/tasks/b" && firstB) {
      firstB = false;
      return new Promise<Response>((resolve) => { resolveB = resolve; });
    }
    const main = /^\/tasks\/([^/]+)$/.exec(url);
    if (main) return new Response(JSON.stringify(tasks[main[1] as keyof typeof tasks]), { status: 200 });
    const out = /^\/tasks\/([^/]+)\/output$/.exec(url);
    if (out) {
      if (out[1] === "a") return new Response(JSON.stringify(output("a", "revised-plan source artifact")), { status: 200 });
      return new Response(JSON.stringify({ error: "Output not found" }), { status: 404 });
    }
    const activity = /^\/tasks\/([^/]+)\/activity$/.exec(url);
    if (activity) {
      if (activity[1] === "a" && firstAActivity) {
        firstAActivity = false;
        return new Promise<Response>((resolve) => { resolveAActivity = resolve; });
      }
      return new Response("[]", { status: 200 });
    }
    const chain = /^\/tasks\/([^/]+)\/chain$/.exec(url);
    if (chain) return new Response(JSON.stringify(chain[1] === "c" ? chainFor("c") : emptyChain()), { status: 200 });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  } }, "http://localhost/tasks/a");
  const { dom, container } = page;
  try {
    assert.match(container.textContent ?? "", /Source A/);
    assert.match(container.textContent ?? "", /revised-plan source artifact/);

    const sourceInput = container.querySelector("input[placeholder='Add a comment...']") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(sourceInput, "unsent source draft");
      sourceInput.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "unsent source draft" }));
    });
    const sourceRunRow = [...container.querySelectorAll("tr")].find((row) => row.textContent?.includes("#1"))!;
    await act(async () => { sourceRunRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.match(container.textContent ?? "", /source-only-workspace/);
    assert.equal(sourceInput.value, "unsent source draft");

    act(() => replaceSubject?.(<TaskDetailPage taskId="b" />));
    assert.match(container.textContent ?? "", /Loading/);
    assert.doesNotMatch(container.textContent ?? "", /Source A|revised-plan source artifact|unsent source draft|source-only-workspace/);
    assert.equal(container.querySelector("button"), null, "destination shell exposes no source action");
    assert.equal(container.querySelector("input"), null, "destination shell exposes no source draft field");

    resolveB!(new Response(JSON.stringify(tasks.b), { status: 200 }));
    await page.settle();
    assert.match(container.textContent ?? "", /Destination B/);
    assert.match(container.textContent ?? "", /No output recorded/);
    assert.match(container.textContent ?? "", /independently review the persisted plan/);
    assert.doesNotMatch(container.textContent ?? "", /revised-plan source artifact/);
    const destinationInput = container.querySelector("input[placeholder='Add a comment...']") as HTMLInputElement;
    assert.equal(destinationInput.value, "", "the unsent source draft must not cross task identity");
    resolveAActivity!(new Response(JSON.stringify([{
      id: "late-a", taskId: "a", actorType: "operator", actorId: null,
      body: "late source activity", metadata: null, createdAt: now,
    }]), { status: 200 }));
    await page.settle();
    assert.doesNotMatch(container.textContent ?? "", /late source activity/);
    assert.equal(destinationInput.value, "", "a late source response must not restore the source draft");
    assert.doesNotMatch(container.textContent ?? "", /source-only-workspace/);

    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "DOING";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await page.settle();
    const archive = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Archive"))!;
    await act(async () => { archive.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await page.settle();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(destinationInput, "destination comment");
      destinationInput.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "destination comment" }));
      destinationInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await page.settle();
    const send = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Send"))!;
    assert.equal(send.disabled, false, `comment=${destinationInput.value}`);
    await act(async () => { send.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await page.settle();

    act(() => replaceSubject?.(<TaskDetailPage taskId="c" />));
    assert.doesNotMatch(container.textContent ?? "", /Destination B|destination comment/);
    await page.settle();
    const start = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Start next step"))!;
    await act(async () => { start.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await page.settle();

    assert.ok(mutations.some((item) => item.url === "/tasks/b/start" && item.method === "POST"));
    assert.ok(mutations.some((item) => item.url === "/tasks/b/archive" && item.method === "POST"));
    assert.ok(mutations.some((item) => item.url === "/tasks/b/activity" && item.body.includes("destination comment")), JSON.stringify(mutations));
    assert.ok(mutations.some((item) => item.url === "/tasks/c/start" && item.method === "POST"));
    assert.equal(mutations.some((item) => item.url.includes("/tasks/a")), false);

    const heldOutput = {
      data: output("b", "same-resource artifact"), error: null, loading: false,
      lastSuccessAt: now, reload: () => undefined,
    };
    act(() => replaceSubject?.(<TaskOutput poll={heldOutput} />));
    assert.match(container.textContent ?? "", /same-resource artifact/);
    act(() => replaceSubject?.(<TaskOutput poll={{
      ...heldOutput, error: new ApiError(404, "/tasks/b/output", "Output not found"),
    }} />));
    assert.match(container.textContent ?? "", /No output recorded/);
    assert.doesNotMatch(container.textContent ?? "", /same-resource artifact|Output not found/);
    for (const status of [405, 501]) {
      act(() => replaceSubject?.(<TaskOutput poll={{
        ...heldOutput, data: null, error: new ApiError(status, "/tasks/b/output", `HTTP ${status}`),
      }} />));
      assert.match(container.textContent ?? "", new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(container.textContent ?? "", /No output recorded/);
    }
  } finally {
    replaceSubject = null;
    await page.dispose();
  }
});

test("the task-detail Chain card reflects a completed held layer on the next poll and deduplicates Resume", async () => {
  const holdTask = task("hold", "Held task", 0, "chain-hold");
  const runningChain = chainFor("hold");
  runningChain.chainId = "chain-hold";
  runningChain.steps[0] = { ...runningChain.steps[0]!, layer: 1, status: "DOING", startable: false, startAction: null, currentExecution: true };
  runningChain.control = {
    state: "held", heldLayer: 1,
    heldAt: now, holdRequestId: "hold-1", holdReason: "inspect output",
    releasedAt: null,
  };
  const completedChain: Chain = {
    ...runningChain,
    done: 1,
    steps: [{ ...runningChain.steps[0]!, status: "DONE", currentExecution: false }],
  };
  let latestChain = runningChain;
  let chainPolls = 0;
  const mutations: Array<{ url: string; method: string; body: string }> = [];
  const page = await mountPage(<TaskDetailPage taskId="hold" />, { "*": ({ input, init, method }) => {
    const url = String(input).replace(/^.*\/api/, "");
    if (method !== "GET") {
      mutations.push({ url, method, body: String(init.body ?? "") });
      return new Response("{}", { status: 200 });
    }
    if (url === "/tasks/hold") return new Response(JSON.stringify(holdTask), { status: 200 });
    if (url === "/tasks/hold/output") return new Response("null", { status: 200 });
    if (url === "/tasks/hold/startability") return new Response(JSON.stringify({
      startable: false,
      checklist: { repoBound: true, agentAssignee: true, repoAccessGrant: true, budgetRemaining: true, noActiveRun: true, predecessorsDone: true },
      task: { id: "hold", name: "Held task", agent: { id: "agent-1", title: "Builder" }, repo: { id: "repo-1", name: "repo" }, targetBranch: "main" },
    }), { status: 200 });
    if (url === "/tasks/hold/activity") return new Response("[]", { status: 200 });
    if (url === "/tasks/hold/chain") {
      chainPolls += 1;
      return new Response(JSON.stringify(latestChain), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  } }, "http://localhost/tasks/hold");
  const { dom, container } = page;
  try {
    assert.ok(chainPolls >= 1);
    assert.match(container.textContent ?? "", /Current execution/);
    assert.doesNotMatch(container.textContent ?? "", /Waiting for the operator to resume/);

    latestChain = completedChain;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_600)); });
    await page.settle();
    assert.ok(chainPolls >= 2, `expected a poll after the initial response, got ${chainPolls}`);
    assert.match(container.textContent ?? "", /Waiting for the operator to resume/);

    const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Resume Chain"));
    assert.ok(toggle);
    latestChain = { ...completedChain, control: null };
    await act(async () => {
      toggle!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      toggle!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await page.settle();
    const resumes = mutations.filter((item) => item.url === "/tasks/hold/chain/resume");
    assert.equal(resumes.length, 1, JSON.stringify(mutations));
    assert.match(JSON.parse(resumes[0]!.body).requestId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/u);

    const stop = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Hold Chain"));
    assert.ok(stop);
    await act(async () => {
      stop!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      stop!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await page.settle();
    const holds = mutations.filter((item) => item.url === "/tasks/hold/chain/hold");
    assert.equal(holds.length, 1, JSON.stringify(mutations));
    assert.match(JSON.parse(holds[0]!.body).requestId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
  } finally {
    await page.dispose();
  }
});
