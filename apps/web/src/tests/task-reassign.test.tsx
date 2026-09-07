import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChainList } from "../components/chain-list";
import { agentOptionLabel } from "../lib/models";
import { LocaleProvider } from "../lib/i18n";
import { translate } from "../lib/i18n-core";
import { TaskDetailPage } from "../pages/TaskDetail";
import type { Agent, Chain, ChainStep, Run, TaskDetail, TaskStartability } from "../lib/types";
import { mountPage, type PageHarness } from "./dom-harness";

const en = (key: string): string => translate("en", key);
const now = "2026-09-05T00:00:00.000Z";

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: "agent-1", projectId: "project-1", environmentId: "env-1", name: "senior-dev-astra-medium",
  canonicalRole: "senior-dev", customizedFields: [], title: "Senior Developer",
  model: "gpt-6-astra:medium", codexServiceTier: "DEFAULT", runnerPreference: "CODEX",
  inboxAccess: false, disabledTools: [], foundationalPrompt: "foundation", rolePrompt: "role",
  assignable: true, createdAt: now, updatedAt: now, archivedAt: null, ...overrides,
});

const roster: Agent[] = [
  agent(),
  agent({ id: "agent-2", name: "senior-dev-opus-medium", title: "Senior Developer Opus", model: "claude-opus-5:medium" }),
  agent({ id: "agent-3", name: "retired-reviewer", title: "Retired Reviewer", archivedAt: now }),
  agent({ id: "agent-4", name: "merge-integrator", title: "Merge Integrator", model: "mechanical", assignable: false }),
];

const step = (overrides: Partial<ChainStep> = {}): ChainStep => ({
  taskId: "task-1", position: 1, chainIndex: 0, layer: null, name: "Implementation",
  stepName: "Implementation", status: "TODO", approvalGate: false, gateSlot: null,
  assigneeType: "AGENT", executionOwner: "agent",
  agent: { id: "agent-1", title: "Senior Developer", name: "senior-dev-astra-medium", model: "gpt-6-astra:medium" },
  archivedAt: null, failureReason: null, latestRun: null, reassignable: true,
  startable: false, startAction: null, holdRefusal: null, blockedOn: null, currentExecution: false,
  mergeRecovery: null, ...overrides,
});

const chainOf = (steps: ChainStep[]): Chain => ({
  chainId: "chain-1", total: steps.length, done: 0, steps, control: null,
});

const renderChain = (steps: ChainStep[], locale: "en" | "zh" = "en"): string => renderToStaticMarkup(
  <LocaleProvider initialLocale={locale}>
    <ChainList chain={chainOf(steps)} taskId="task-1" pending={false} regressionTaskId={null}
      agents={roster} onStart={() => undefined} onReassign={async () => true} />
  </LocaleProvider>,
);

const selectMarkup = (markup: string, taskId: string): string => {
  const row = markup.split(`data-chain-node="${taskId}"`)[1] ?? "";
  const select = row.split("</select>")[0] ?? "";
  assert.ok(select.includes("data-reassign-select"), `no reassign select on ${taskId}: ${row.slice(0, 400)}`);
  return select;
};

test("a chain step names each assignable role as title · model effort", () => {
  const markup = renderChain([step()]);
  const select = selectMarkup(markup, "task-1");
  assert.match(select, /Senior Developer · GPT-6 Astra \(codex\) medium/u);
  assert.match(select, /Senior Developer Opus · Claude Opus 5 medium/u);
  // Archived roles and the mechanical merge sentinel are not staffing choices.
  assert.doesNotMatch(select, /Retired Reviewer/u);
  assert.doesNotMatch(select, /Merge Integrator/u);
  assert.match(select, /<option[^>]*selected=""[^>]*value="agent-1"|value="agent-1"[^>]*selected=""/u);
});

test("the option label falls back to the stored model id for a model outside the catalog", () => {
  assert.equal(agentOptionLabel({ title: "Sol", model: "gpt-5.6-sol:high" }), "Sol · GPT-5.6 Sol (codex) high");
  assert.equal(agentOptionLabel({ title: "Bespoke", model: "some-private-build" }), "Bespoke · some-private-build");
});

test("the picker is enabled only where the server says the step is reassignable", () => {
  const markup = renderChain([
    step({ taskId: "task-1", reassignable: true }),
    step({ taskId: "task-2", position: 2, chainIndex: 1, reassignable: false, status: "DOING" }),
  ]);
  assert.doesNotMatch(selectMarkup(markup, "task-1"), /disabled=""/u);
  assert.match(selectMarkup(markup, "task-2"), /disabled=""/u);
  assert.match(selectMarkup(markup, "task-1"), new RegExp(`title="${en("chain.reassign.label")}"`, "u"));
});

test("a locked step says why it is locked, in both locales", () => {
  for (const locale of ["en", "zh"] as const) {
    const select = selectMarkup(renderChain([step({ reassignable: false })], locale), "task-1");
    const hint = translate(locale, "chain.reassign.locked");
    assert.ok(select.includes(hint.replace(/"/gu, "&quot;")), `${locale}: ${select}`);
  }
  assert.notEqual(translate("zh", "chain.reassign.locked"), en("chain.reassign.locked"));
});

test("steps the operator cannot staff carry no picker at all", () => {
  const markup = renderChain([
    step({ taskId: "human", assigneeType: "HUMAN", executionOwner: "human", agent: null }),
    step({ taskId: "tail", position: 2, chainIndex: 1, executionOwner: "merge-executor" }),
  ]);
  assert.doesNotMatch(markup, /data-reassign-select/u);
});

test("a chain card with no reassign handler stays the read-only projection it was", () => {
  const markup = renderToStaticMarkup(
    <ChainList chain={chainOf([step()])} taskId="task-1" pending={false} regressionTaskId={null}
      onStart={() => undefined} />,
  );
  assert.doesNotMatch(markup, /data-reassign-select/u);
});

/* ------------------------------------------------------------- the live page */

const run = (overrides: Partial<Run> = {}): Run => ({
  id: "run-1", projectId: "project-1", taskId: "task-1", goalId: null, agentId: "agent-1", repoId: "repo-1",
  runNumber: 1, status: "SUCCEEDED", runner: "CODEX", runnerId: "runner-1", model: "gpt-6-astra:medium",
  codexServiceTier: "DEFAULT", subagentModel: null, subagentMaxConcurrent: null, leaseGeneration: 1,
  cancelRequestId: null, cancelReason: null, cancelRequestedAt: null, cancelAcknowledgedAt: null,
  workspacePath: null, workspaceRetained: false, targetBranch: "main", branch: "feat/x",
  baseSha: "1111111111111111", headSha: "2222222222222222", pushStatus: "SUCCEEDED", pullRequestUrl: null,
  maxDurationMin: 120, stallTimeoutMin: 10, maxRunsPerTask: 3, failureClass: null, failureReason: null,
  retryable: null, retryAt: null, terminationReason: null, queuedAt: now, claimedAt: now, startedAt: now,
  endedAt: now, session: null, ...overrides,
});

const task = (overrides: Partial<TaskDetail> = {}): TaskDetail => ({
  id: "task-1", projectId: "project-1", assigneeAgentId: "agent-1", repoId: "repo-1", templateId: null,
  templateStepId: null, name: "Implementation", description: "Ship it.", workingDirectory: null,
  targetBranch: "main", failureReason: null, status: "TODO", moveTargets: [], assigneeType: "AGENT",
  executionOwner: "agent", approvalGate: false, scheduleKind: "NOW", runAt: null, cron: null, timezone: null,
  maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 3, createdAt: now, updatedAt: now,
  assigneeAgent: agent(), repo: null, runs: [], strandedSalvageBranches: [], chainId: null, chainIndex: null,
  source: "MANUAL", archivedAt: null, schedulePausedAt: null, recurringSourceTaskId: null, templateStep: null,
  taskCost: null, mergeOutcome: null, mergeRecovery: null, budgetRemaining: true, baseline: null, editableBrief: null,
  ...overrides,
});

const startability: TaskStartability = {
  startable: true,
  checklist: {
    repoBound: true, agentAssignee: true, repoAccessGrant: true,
    budgetRemaining: true, noActiveRun: true, predecessorsDone: true,
  },
  task: { id: "task-1", name: "Implementation", agent: null, repo: null, targetBranch: null },
};

const emptyChain: Chain = { chainId: null, total: 0, done: 0, steps: [], control: null };

const openPage = async (
  subject: TaskDetail,
  chain: Chain,
  patch: (body: unknown) => Response | Record<string, unknown>,
): Promise<PageHarness> => await mountPage(<TaskDetailPage taskId="task-1" />, {
  "/tasks/task-1": subject,
  "/tasks/task-1/output": new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
  "/tasks/task-1/startability": startability,
  "/tasks/task-1/activity": [],
  "/tasks/task-1/chain": chain,
  "/projects/project-1/agents": roster,
  "PATCH /tasks/task-1": ({ init }) => patch(JSON.parse(String(init.body))),
  "PATCH /tasks/task-2": ({ init }) => patch(JSON.parse(String(init.body))),
}, "http://localhost/tasks/task-1");

const pickers = (page: PageHarness): HTMLSelectElement[] =>
  [...page.container.querySelectorAll("[data-reassign-select]")] as HTMLSelectElement[];

const choose = async (page: PageHarness, select: HTMLSelectElement, value: string): Promise<void> => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  });
  await page.settle();
};

const patchBodies = (page: PageHarness): Array<{ path: string; body: unknown }> => page.requests
  .filter((request) => request.method === "PATCH")
  .map((request) => ({ path: request.path, body: JSON.parse(String(request.init.body)) }));

test("choosing a role patches that task's assignee and holds the choice until the poll agrees", async () => {
  let assigneeAgentId = "agent-1";
  // The reload the write triggers is the read that has not caught up yet — the
  // exact frame in which reseeding from the poll would undo the operator.
  let staleReads = 0;
  const projection = (id: string): TaskDetail => task({ assigneeAgentId: id, assigneeAgent: agent({ id }) });
  const page = await mountPage(<TaskDetailPage taskId="task-1" />, {
    "/tasks/task-1": () => {
      if (staleReads === 0) return projection(assigneeAgentId);
      staleReads -= 1;
      return projection("agent-1");
    },
    "/tasks/task-1/output": new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    "/tasks/task-1/startability": startability,
    "/tasks/task-1/activity": [],
    "/tasks/task-1/chain": emptyChain,
    "/projects/project-1/agents": roster,
    "PATCH /tasks/task-1": ({ init }) => {
      assigneeAgentId = String((JSON.parse(String(init.body)) as { assigneeAgentId: string }).assigneeAgentId);
      staleReads = 1;
      return projection(assigneeAgentId);
    },
  }, "http://localhost/tasks/task-1");
  try {
    const [picker] = pickers(page);
    assert.ok(picker, page.container.innerHTML);
    assert.equal(picker.value, "agent-1");
    await choose(page, picker, "agent-2");
    assert.deepEqual(patchBodies(page), [{ path: "/tasks/task-1", body: { assigneeAgentId: "agent-2" } }]);
    assert.equal(staleReads, 0, "the reload after the write should have been served the old assignee");
    assert.equal(pickers(page)[0]?.value, "agent-2");
  } finally {
    await page.dispose();
  }
});

test("a 409 from the route reaches the operator through the page's action error, and the picker snaps back", async () => {
  const refusal = "Cannot reassign Implementation while Run 1 is active";
  const page = await openPage(
    task({ chainId: "chain-1", chainIndex: 0 }),
    chainOf([step({ reassignable: true })]),
    () => new Response(JSON.stringify({ error: refusal, code: "task_active_run" }), { status: 409 }),
  );
  try {
    const picker = pickers(page).at(-1);
    assert.ok(picker, page.container.innerHTML);
    await choose(page, picker, "agent-2");
    assert.deepEqual(patchBodies(page).map((entry) => entry.body), [{ assigneeAgentId: "agent-2" }]);
    assert.match(page.container.textContent ?? "", new RegExp(`409 ${refusal}`, "u"));
    // The refusal is not a change: the control must not keep claiming one.
    assert.equal(pickers(page).at(-1)?.value, "agent-1");
  } finally {
    await page.dispose();
  }
});

test("a task outside a chain derives its own lock from the runs it already holds", async () => {
  const live = await openPage(task({ runs: [run({ status: "RUNNING" })] }), emptyChain, () => ({}));
  try {
    const picker = pickers(live)[0];
    assert.ok(picker, live.container.innerHTML);
    assert.equal(picker.disabled, true);
    assert.equal(picker.getAttribute("title"), en("taskDetail.reassign.locked"));
  } finally {
    await live.dispose();
  }

  // The same task with only terminal runs is staffable again. An older
  // WAITING_INBOX run behind a newer terminal one still counts as live, which is
  // how the control plane counts (ACTIVE_RUN_STATUSES over every run).
  const settled = await openPage(task({ runs: [run({ status: "FAILED" })] }), emptyChain, () => ({}));
  try {
    assert.equal(pickers(settled)[0]?.disabled, false);
  } finally {
    await settled.dispose();
  }

  const suspended = await openPage(
    task({ runs: [run({ id: "run-2", runNumber: 2, status: "FAILED" }), run({ status: "WAITING_INBOX" })] }),
    emptyChain,
    () => ({}),
  );
  try {
    assert.equal(pickers(suspended)[0]?.disabled, true);
  } finally {
    await suspended.dispose();
  }
});

test("a task inside a chain takes the server's reassignable fact over its own runs", async () => {
  // No live run on the detail projection, and the chain still says no: the
  // page must not talk the server out of its own answer.
  const page = await openPage(
    task({ chainId: "chain-1", chainIndex: 0, runs: [run({ status: "SUCCEEDED" })] }),
    chainOf([step({ reassignable: false })]),
    () => ({}),
  );
  try {
    const [header] = pickers(page);
    assert.ok(header, page.container.innerHTML);
    assert.equal(header.disabled, true);
    assert.equal(header.getAttribute("title"), en("taskDetail.reassign.locked"));
  } finally {
    await page.dispose();
  }
});

test("a human-owned task offers no assignee picker on the detail header", async () => {
  const page = await openPage(
    task({ assigneeType: "HUMAN", executionOwner: "human", assigneeAgentId: null, assigneeAgent: null }),
    emptyChain,
    () => ({}),
  );
  try {
    assert.equal(pickers(page).length, 0);
  } finally {
    await page.dispose();
  }
});
