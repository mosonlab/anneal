import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AutomationRow, CronEditor, stateLabel } from "../pages/Automations";
import type { TaskList } from "../lib/types";

const task = (overrides: Partial<TaskList> = {}): TaskList => ({
  id: "t1", projectId: "p1", assigneeAgentId: "a1", repoId: "r1", templateId: null, templateStepId: null,
  name: "Nightly digest", description: "d", workingDirectory: null, targetBranch: null,
  failureReason: null, status: "TODO", assigneeType: "AGENT", executionOwner: "agent", approvalGate: false, scheduleKind: "CRON",
  runAt: new Date(Date.now() + 3_600_000).toISOString(), cron: "0 9 * * *", timezone: "Asia/Shanghai",
  maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 5,
  createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z",
  assigneeAgent: null, repo: null, runs: [], strandedSalvageBranches: [],
  chainId: null, chainIndex: null, source: "MANUAL", archivedAt: null,
  schedulePausedAt: null, recurringSourceTaskId: null, templateStep: null, chainProgress: null, baseline: null,
  recurringLastFiredAt: null, recurringFireCount: 0,
  ...overrides,
});

/** A collapsed row: no fires poll is mounted, which is the whole point of the
 *  `Last run` assertions below. */
const row = (overrides: Partial<TaskList> = {}): string => renderToStaticMarkup(
  <table><tbody>
    <AutomationRow task={task(overrides)} expanded={false} onToggle={() => undefined}
      onPause={() => undefined} onDelete={() => undefined} onSaved={() => undefined} />
  </tbody></table>,
);

/* -------------------------------------------------------------- the schedule */

test("a cron expression renders as prose over its raw sub-line", () => {
  const markup = row();
  assert.match(markup, /9:00/);
  assert.match(markup, /0 9 \* \* \* · Asia\/Shanghai/);
});

test("an expression the parser rejects renders raw, with no exception text", () => {
  const markup = row({ cron: "not a cron at all" });
  assert.match(markup, /not a cron at all/);
  assert.doesNotMatch(markup, /Error/);
});

/* ---------------------------------------------------------------- the status */

test("the three states render their own pill and sub-line", () => {
  const at = "2026-08-16T00:00:00.000Z";
  assert.equal(stateLabel(task()).label, "Active");
  assert.match(stateLabel(task()).note!, /^Next run /);
  assert.deepEqual(
    { ...stateLabel(task({ schedulePausedAt: at })) },
    { tone: "amber", label: "Paused", note: null },
  );
  assert.deepEqual(
    { ...stateLabel(task({ runAt: null })) },
    { tone: "red", label: "Quarantined", note: "Fix the cron expression" },
  );
  assert.match(row({ runAt: null }), /Fix the cron expression/);
});

test("a parked cron definition reads Active and in Backlog, not one or the other", () => {
  // The scheduler only ever picks up TODO, so "Active" alone would be a lie.
  const markup = row({ status: "BACKLOG" });
  assert.match(markup, />Active</);
  assert.match(markup, /in Backlog/);
  assert.doesNotMatch(row(), /in Backlog/);
});

/* -------------------------------------------------------------- the last run */

test("Last run comes from the list response, with the row collapsed", () => {
  // The regression this exists for: reading it from the expanded-row poll made
  // every collapsed row — that is, every row on load — say Never.
  const fired = row({ recurringLastFiredAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), recurringFireCount: 12 });
  assert.match(fired, /3h ago/);
  assert.match(fired, /12 fired/);
  assert.doesNotMatch(fired, /Never/);
  assert.match(row({ recurringLastFiredAt: null }), /Never/);
});

/* ------------------------------------------------------------- the cron field */

test("the editor holds the raw expression and timezone, and previews without validating", () => {
  const markup = renderToStaticMarkup(<CronEditor task={task()} onSaved={() => undefined} />);
  assert.match(markup, /value="0 9 \* \* \*"/);
  assert.match(markup, /value="Asia\/Shanghai"/);
  assert.match(markup, /9:00/);
  // No client-side validator: the preview degrades to raw text and the control
  // plane owns the rejection.
  const bad = renderToStaticMarkup(<CronEditor task={task({ cron: "nope" })} onSaved={() => undefined} />);
  assert.match(bad, /value="nope"/);
  assert.doesNotMatch(bad, /Error/);
  // Text nodes only. Since batch 1 the Input carries shadcn v4's `aria-invalid:*`
  // classes, so scanning the whole markup for "invalid" would match styling
  // rather than the copy this assertion is about.
  assert.doesNotMatch(bad.replace(/<[^>]*>/g, " "), /invalid/i);
});
