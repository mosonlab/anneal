import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ARCHIVED_LIMIT, ArchivedRow } from "../pages/Archived";
import { TasksPageHead, type TasksTab } from "../components/tasks-tabs";
import { NewTask } from "../components/new-task-panel";
import { translate } from "../lib/i18n-core";
import { ProjectProvider } from "../lib/project";
import type { ChainProgress, TaskList } from "../lib/types";

/* Same expected values as before batch 1; they now come from the `en`
 * dictionary rather than from a literal in the component (spec §7.20). */
const en = (key: string): string => translate("en", key);

/** The head reads the project scope. `renderToStaticMarkup` runs no effects, so
 *  the provider's poll never fires and the scope stays at its empty default —
 *  which is all these assertions need. */
const head = (active: TasksTab): string => renderToStaticMarkup(
  <ProjectProvider><TasksPageHead active={active} /></ProjectProvider>,
);

const task = (overrides: Partial<TaskList> = {}): TaskList => ({
  id: "t1", projectId: "p1", assigneeAgentId: null, repoId: null, templateId: null, templateStepId: null,
  name: "Ship the thing", description: "d", workingDirectory: null, targetBranch: null,
  failureReason: null, status: "DONE", assigneeType: "AGENT", executionOwner: "agent", approvalGate: false, scheduleKind: "NOW",
  runAt: null, cron: null, timezone: null,
  maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 5,
  createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z",
  assigneeAgent: null, repo: null, runs: [], strandedSalvageBranches: [],
  chainId: null, chainIndex: null, source: "MANUAL", archivedAt: "2026-08-16T09:00:00.000Z",
  schedulePausedAt: null, recurringSourceTaskId: null, templateStep: null, chainProgress: null, baseline: null,
  recurringLastFiredAt: null, recurringFireCount: 0,
  ...overrides,
});

const progress = (overrides: Partial<ChainProgress> = {}): ChainProgress => ({
  chainId: "c1", done: 4, total: 9, activeStepName: "Implementation", activeStatus: "doing", currentLayer: 2, layerCount: 7, position: 5,
  ...overrides,
});

/* ------------------------------------------------------------- the tab head */

test("the head renders exactly four tabs, in order, with My Tasks dropped", () => {
  const markup = head("tasks");
  const labels = [...markup.matchAll(/>([A-Za-z ]+)<\/button>/g)].map((match) => match[1]);
  const wanted = [en("tasks.tab.tasks"), en("tasks.tab.automations"), en("tasks.tab.triggers"), en("tasks.tab.archived"), "My Tasks"];
  assert.deepEqual(labels.filter((label) => wanted.includes(label!)), [
    "Tasks", "Automations", "Triggers", "Archived",
  ]);
});

test("the active tab is the one carrying the selected background", () => {
  for (const active of ["tasks", "automations", "triggers", "archived"] as TasksTab[]) {
    const markup = head(active);
    const selected = [...markup.matchAll(/<button[^>]*bg-accent[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
    const expected = en(`tasks.tab.${active}`);
    assert.deepEqual(selected, [expected], active);
  }
});

test("Create Task is present on every one of the four tabs", () => {
  // The regression this exists for: the button used to live in Tasks.tsx, so
  // three of the four tabs the spec puts it on would have shipped without it.
  for (const active of ["tasks", "automations", "triggers", "archived"] as TasksTab[]) {
    assert.match(head(active), new RegExp(en("tasks.create")), active);
  }
});

test("the panel the head owns renders its first field", () => {
  // `creating` is the head's own state and a static render cannot press the
  // button, so the panel is rendered directly: what this pins is that the
  // hoisted component is intact and reachable from the shared head's module.
  const markup = renderToStaticMarkup(
    <NewTask projectId="p1" agents={[]} repos={[]} onClose={() => undefined} onCreated={() => undefined} />,
  );
  assert.match(markup, new RegExp(en("newTask.title")));
  assert.match(markup, new RegExp(en("newTask.field.title.label")));
  assert.match(markup, /Implement feat\/inbox-search/);
});

/* ------------------------------------------------------------- the archive */

test("an archived row renders its chain marker, and a chainless one renders a dash", () => {
  const withChain = renderToStaticMarkup(
    <table><tbody><ArchivedRow task={task({ chainProgress: progress() })} onUnarchive={() => undefined} /></tbody></table>,
  );
  assert.match(withChain, /4\/9 · Implementation · doing/);
  const without = renderToStaticMarkup(
    <table><tbody><ArchivedRow task={task()} onUnarchive={() => undefined} /></tbody></table>,
  );
  assert.match(without, /—/);
  assert.doesNotMatch(without, /·/);
});

test("the archive window is 200 rows", () => {
  // The footer's threshold and the slice must be the same number; the page
  // reads this constant for both.
  assert.equal(ARCHIVED_LIMIT, 200);
  const rows = Array.from({ length: 201 }, (_, index) => task({ id: `t${index}` }));
  assert.equal(rows.slice(0, ARCHIVED_LIMIT).length, 200);
  assert.equal(rows.length > ARCHIVED_LIMIT, true);
  assert.equal(rows.slice(0, 200).length > ARCHIVED_LIMIT, false);
});
