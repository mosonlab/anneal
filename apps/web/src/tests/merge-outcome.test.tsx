import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChainAggregateCard } from "../components/chain-aggregate-card";
import { RunPill } from "../components/ui";
import { TaskCard } from "../components/task-card";
import { translate } from "../lib/i18n-core";
import { lifecycleStat, sessionPill } from "../pages/Sessions";
import type { BoardTask, ChainAggregate, MergeOutcome, RunStatus } from "../lib/types";
import { boardRun } from "./board-run";

/**
 * §SF-1 — the merge integrator's outcome as an operator reads it.
 *
 * A mechanical merge that refuses to merge ends its run `SUCCEEDED`, because
 * the executor did exactly what its contract says. Every surface below reads
 * only that status, so before this each of them told an operator that a merge
 * which never happened was Done. The regression at the bottom is the other half
 * of the claim: no ordinary run's rendering moved.
 */

const en = (key: string): string => translate("en", key);

const STOPPED: MergeOutcome = { outcome: "stopped", condition: "head-drift", incident: false };
const INCIDENT: MergeOutcome = { outcome: "stopped", condition: "base-drift-post-merge", incident: true };
const MERGED: MergeOutcome = { outcome: "merged", condition: null, incident: false };

const AMBER = "text-[color:var(--status-amber-fg)]";
const RED = "text-[color:var(--destructive-fg)]";
const GREEN = "text-[color:var(--status-green-fg)]";

const AMBER_DOT = "bg-[color:var(--status-amber-fg)]";
const RED_DOT = "bg-[color:var(--destructive-fg)]";
const GREEN_DOT = "bg-[color:var(--status-green-fg)]";

const runPill = (status: RunStatus, mergeOutcome?: MergeOutcome | null): string =>
  renderToStaticMarkup(<RunPill status={status} mergeOutcome={mergeOutcome} />);

const noop = (): void => undefined;
const ACTIONS = { onMove: noop, onRetry: noop, onArchive: noop, onDelete: noop, onCopyError: noop, onFilterChain: noop };

const boardTask = (overrides: Partial<BoardTask> = {}): BoardTask => ({
  id: "t1", name: "Merge execution", displayName: overrides.name ?? "Merge execution", status: "DONE", moveTargets: [], failureReason: null,
  assigneeType: "AGENT", createdAt: "2026-08-17T00:00:00.000Z",
  scheduleKind: "NOW", runAt: null, cron: null, timezone: null,
  approvalGate: false, templateId: null, source: "MANUAL", chainId: "c1", chainIndex: 10,
  chainName: null, updatedAt: "2026-08-18T00:00:00.000Z", assigneeAgent: null, chainProgress: null,
  latestRun: boardRun({ id: "run-1" }), strandedSalvageBranches: [], taskCost: null, budgetRemaining: true, leaseLossRefunds: 0,
  blockedOn: null, mergeOutcome: null, repairOf: null, chainAggregate: null, baseline: null, readinessRequeues: 0, readinessGrants: 0,
  ...overrides,
});

const card = (overrides: Partial<BoardTask> = {}): string =>
  renderToStaticMarkup(<TaskCard task={boardTask(overrides)} actions={ACTIONS} />);

/* ---------------------------------------------------------- the pre-merge stop */

test("a pre-merge stop reads amber Stopped in all four run-centric surfaces", () => {
  const label = en("status.merge.stopped");
  assert.equal(label, "Stopped");

  // 1. The run row on the task page.
  const row = runPill("SUCCEEDED", STOPPED);
  assert.ok(row.includes(label), row);
  assert.ok(row.includes(AMBER), row);
  assert.ok(!row.includes(en("status.run.SUCCEEDED")), row);

  // 2. The sessions list and detail pill.
  assert.deepEqual(sessionPill("SUCCEEDED", STOPPED), { tone: "amber", label });

  // 3. The session detail's lifecycle stat, whose two tones become three.
  assert.deepEqual(lifecycleStat("SUCCEEDED", STOPPED), { tone: "amber", label });

  // 4. The board card's run line.
  const markup = card({ mergeOutcome: STOPPED });
  assert.ok(markup.includes(label), markup);
  assert.ok(markup.includes(AMBER_DOT), markup);
  assert.ok(!markup.includes(en("status.run.SUCCEEDED")), markup);
});

test("a succeeded frontier Run with a stopped merge outcome does not render the Chain as succeeded", () => {
  const aggregate: ChainAggregate = {
    chainId: "chain-1",
    chainName: "Release",
    stepCount: 1,
    detailTaskId: "merge-step",
    statusCounts: { BACKLOG: 0, TODO: 0, DOING: 0, REVIEW: 0, DONE: 1 },
    status: "DONE",
    frontier: {
      taskId: "merge-step",
      title: "Merge execution",
      status: "DONE",
      latestRun: boardTask().latestRun,
      mergeOutcome: STOPPED,
      failureReason: null,
      position: 1,
    },
    activeRepair: null,
    activation: { state: "settled", predecessor: null, taskId: "merge-step", hold: null },
    totalCost: null, firstRunStartedAt: null,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
  const markup = renderToStaticMarkup(<ChainAggregateCard aggregate={aggregate} />);

  assert.ok(markup.includes(en("status.merge.stopped")), markup);
  assert.ok(markup.includes(AMBER_DOT), markup);
  assert.ok(!markup.includes(en("status.run.SUCCEEDED")), markup);
});

/* ------------------------------------------------------- the post-merge incident */

test("a post-merge incident reads red Incident in all four run-centric surfaces", () => {
  const label = en("status.merge.incident");
  assert.equal(label, "Incident");

  const row = runPill("SUCCEEDED", INCIDENT);
  assert.ok(row.includes(label), row);
  assert.ok(row.includes(RED), row);

  assert.deepEqual(sessionPill("SUCCEEDED", INCIDENT), { tone: "red", label });
  assert.deepEqual(lifecycleStat("SUCCEEDED", INCIDENT), { tone: "red", label });

  const markup = card({ mergeOutcome: INCIDENT });
  assert.ok(markup.includes(label), markup);
  assert.ok(markup.includes(RED_DOT), markup);
});

/* ------------------------------------------------------------------ regression */

test("an ordinary successful run still renders green Done, outcome or none", () => {
  const done = en("status.run.SUCCEEDED");

  for (const outcome of [null, undefined, MERGED]) {
    const row = runPill("SUCCEEDED", outcome);
    assert.ok(row.includes(done), row);
    assert.ok(row.includes(GREEN), row);
    assert.ok(!row.includes(en("status.merge.stopped")), row);

    assert.deepEqual(sessionPill("SUCCEEDED", outcome), { tone: "green", label: en("sessions.pill.done") });
    assert.deepEqual(lifecycleStat("SUCCEEDED", outcome), { tone: "green", label: en("sessions.lifecycle.done") });

    const markup = card(outcome === undefined ? {} : { mergeOutcome: outcome });
    assert.ok(markup.includes(done), markup);
    assert.ok(markup.includes(GREEN_DOT), markup);
  }
});

test("a failed run is untouched by the merge projection", () => {
  const row = runPill("FAILED", null);
  assert.ok(row.includes(en("status.run.FAILED")), row);
  assert.ok(row.includes(RED), row);
  assert.deepEqual(sessionPill("FAILED"), { tone: "red", label: en("status.session.FAILED") });
  assert.deepEqual(lifecycleStat("FAILED"), { tone: "red", label: en("sessions.lifecycle.failed") });
});

/* ------------------------------------------------- pre-authorization requeues */

/**
 * The requeue counters share the merge-tail line, and share this file's claim:
 * a readiness Step whose base kept moving must not read like an ordinary rerun.
 */

test("a requeued readiness Step names its requeues and the attempts they granted", () => {
  const markup = card({ readinessRequeues: 2, readinessGrants: 3 });

  assert.ok(markup.includes("data-card-readiness-requeues"), markup);
  assert.ok(markup.includes(translate("en", "tasks.pill.readinessRequeue", { n: 2, grants: 3 })), markup);
});

test("the counters survive a readiness Step that has no Run of its own", () => {
  // The control plane settles readiness without launching a Run, so the card
  // that owns these counters is usually the one with no run line at all.
  const markup = card({ latestRun: null, readinessRequeues: 2, readinessGrants: 2 });

  assert.ok(markup.includes("data-card-readiness-requeues"), markup);
  assert.ok(markup.includes(translate("en", "tasks.pill.readinessRequeue", { n: 2, grants: 2 })), markup);
});

test("the overwhelming zero case renders no requeue pill at all", () => {
  const markup = card({ readinessRequeues: 0, readinessGrants: 0 });

  assert.ok(!markup.includes("data-card-readiness-requeues"), markup);
});
