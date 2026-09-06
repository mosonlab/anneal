import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { durationMs, percent, pullRequestLabel, tokensPerSecond } from "../lib/format";
import { RunDiagnostics, StartabilityChecklist, StepOutput, StrandedSalvageList, TaskPrompt, branchUrl } from "../pages/TaskDetail";
import { partitionTaskPrompt } from "../lib/task-prompt";
import type { RunMetrics, TaskStartability, TaskStepOutput } from "../lib/types";
import prompts from "./fixtures/tc-ux-v1-prompts.json";
import provenance from "./fixtures/tc-ux-v1-prompts.provenance.json";

const source = readFileSync(fileURLToPath(new URL("../pages/TaskDetail.tsx", import.meta.url)), "utf8");

test("every task-detail run row uses the projected cost with estimate and token fallback semantics", () => {
  assert.match(source, /usageCostLabel\(run\.session\?\.usageCost\)/u);
  assert.match(source, /usageCostLabel\(task\.taskCost\)/u);
  assert.doesNotMatch(source, /money\(run\.session\?\.costUsd/u);
});

test("the Runs section is rendered before the Chain section", () => {
  assert.ok(source.indexOf('t("taskDetail.runs.title")') < source.indexOf("<ChainList chain={chain.data}"));
});

test("active Runs expose cancellation and an outstanding intent renders Cancelling", () => {
  assert.match(source, /runLiveness\(newest\)\.live/u);
  assert.match(source, /newest\.cancelRequestedAt !== null/u);
  assert.match(source, /newest\.cancelAcknowledgedAt === null/u);
  assert.match(source, /taskDetail\.cancel\.cancelling/u);
  assert.match(source, /\/runs\/\$\{newest\.id\}\/cancel/u);
  assert.match(source, /parkTask/u);
  assert.match(source, /taskDetail\.stop\.action/u);
  assert.match(source, /task\.executionOwner === "agent"/u);
});

const output = (body: string): TaskStepOutput => ({
  id: "o1", taskId: "t1", runId: "r1", kind: "review", body, metadata: null, commitSha: null,
  createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z",
});

test("the Details checklist renders every server verdict as satisfied or missing", () => {
  const verdict: TaskStartability = {
    startable: false,
    checklist: {
      repoBound: true,
      agentAssignee: false,
      repoAccessGrant: true,
      budgetRemaining: false,
      noActiveRun: true,
      predecessorsDone: false,
    },
    task: { id: "t1", name: "Task", agent: null, repo: null, targetBranch: null },
  };
  const markup = renderToStaticMarkup(<StartabilityChecklist verdict={verdict} hasRuns={false} />);
  assert.equal((markup.match(/Satisfied/g) ?? []).length, 3);
  assert.equal((markup.match(/Missing/g) ?? []).length, 3);
  for (const label of [
    "Repository bound", "Agent assigned", "Repository access granted",
    "Run budget remaining", "No active run", "Predecessors done",
  ]) assert.match(markup, new RegExp(label));
});

test("the readiness checklist disappears once it is fully satisfied on a task that has run", () => {
  const satisfied: TaskStartability = {
    startable: true,
    checklist: {
      repoBound: true, agentAssignee: true, repoAccessGrant: true,
      budgetRemaining: true, noActiveRun: true, predecessorsDone: true,
    },
    task: { id: "t1", name: "Task", agent: null, repo: null, targetBranch: null },
  };
  assert.equal(renderToStaticMarkup(<StartabilityChecklist verdict={satisfied} hasRuns />), "");
  // A task with no run is exactly when startability is still a live question.
  assert.match(renderToStaticMarkup(<StartabilityChecklist verdict={satisfied} hasRuns={false} />), /Ready to start/);
  // One unsatisfied item keeps the card even after the task has run.
  const missing = { ...satisfied, startable: false, checklist: { ...satisfied.checklist, budgetRemaining: false } };
  assert.match(renderToStaticMarkup(<StartabilityChecklist verdict={missing} hasRuns />), /Ready to start/);
});

/* ------------------------------------------------------------ link builders */

test("the branch link is built for GitHub remotes only", () => {
  assert.equal(branchUrl("https://github.com/o/r.git", "feat/x"), "https://github.com/o/r/tree/feat/x");
  assert.equal(branchUrl("https://github.com/o/r", "feat/x"), "https://github.com/o/r/tree/feat/x");
  assert.equal(branchUrl("git@github.com:o/r.git", "feat/x"), "https://github.com/o/r/tree/feat/x");
  // Any other forge falls back to plain text rather than a link that 404s.
  assert.equal(branchUrl("https://gitlab.com/o/r.git", "feat/x"), null);
  assert.equal(branchUrl(null, "feat/x"), null);
  assert.equal(branchUrl("https://github.com/o/r", null), null);
});

test("the task detail lists stranded salvage branches with their LOST Run number", () => {
  const markup = renderToStaticMarkup(<StrandedSalvageList
    branches={[{ branch: "agentos/t1/run-1", lostRunNumber: 1 }]}
    remoteUrl="https://github.com/o/r"
  />);
  assert.match(markup, /data-task-stranded-salvage=""/u);
  assert.match(markup, /agentos\/t1\/run-1/u);
  assert.match(markup, /LOST Run #1/u);
  assert.match(markup, /href="https:\/\/github\.com\/o\/r\/tree\/agentos\/t1\/run-1"/u);

  const empty = renderToStaticMarkup(<StrandedSalvageList branches={[]} remoteUrl="https://github.com/o/r" />);
  assert.equal(empty, "", "an ordinary task must not get an empty salvage card");
});

test("the pull-request label is the number, falling back to the whole URL", () => {
  assert.equal(pullRequestLabel("https://github.com/o/r/pull/39"), "#39");
  assert.equal(pullRequestLabel("https://github.com/o/r/pull/39/"), "#39");
  assert.equal(pullRequestLabel("https://github.com/o/r/pull/39/files"), "https://github.com/o/r/pull/39/files");
  assert.equal(pullRequestLabel("https://example.com/mr/7"), "https://example.com/mr/7");
});

test("structured task prompts lead with responsibility and collapse the common contract", () => {
  const artifact = readFileSync(fileURLToPath(new URL("./fixtures/tc-ux-v1-prompts.json", import.meta.url)));
  assert.equal(artifact.byteLength, provenance.artifactBytes);
  assert.equal(createHash("sha256").update(artifact).digest("hex"), provenance.artifactSha256);
  const responsibilities = new Set<string>();
  for (const [index, fixture] of prompts.entries()) {
    assert.equal(fixture.chainIndex, index);
    assert.equal(Buffer.byteLength(fixture.prompt, "utf8"), fixture.promptBytes);
    assert.equal(createHash("sha256").update(fixture.prompt, "utf8").digest("hex"), fixture.promptSha256);
    const parts = partitionTaskPrompt(fixture.prompt);
    assert.ok(parts.productContract?.startsWith("Product Contract: TC-UX v1.0"), fixture.name);
    assert.ok(parts.responsibility.length > 20, fixture.name);
    responsibilities.add(parts.responsibility);
    const markup = renderToStaticMarkup(<TaskPrompt description={fixture.prompt} editableBrief={null} pending={false} onSave={() => {}} />);
    assert.ok(markup.indexOf(parts.responsibility.slice(0, 40)) < markup.indexOf("Product Contract"), fixture.name);
    assert.match(markup, /<details>/);
    assert.doesNotMatch(markup, /<details open/);
    assert.match(markup, /foundational prompt.*role prompt.*tool manifest.*prior outputs/i);
    assert.match(markup, /Task prompt/);
  }
  assert.equal(responsibilities.size, 7, "all seven authoritative responsibilities must differ");
});

test("unstructured task prompts remain the responsibility verbatim", () => {
  assert.deepEqual(partitionTaskPrompt("  Free-form responsibility  "), {
    responsibility: "Free-form responsibility",
    productContract: null,
  });
});

/* --------------------------------------------------------- step output card */

test("a whitespace-only step output renders the empty state and no body", () => {
  const markup = renderToStaticMarkup(<StepOutput output={output("   \n\t\n")} />);
  assert.match(markup, /No output recorded\./);
  assert.doesNotMatch(markup, /Show more/);
  // The card, the kind pill and the Updated line stay so the operator can still
  // see that the step reported at all.
  assert.match(markup, /Step output/);
  assert.match(markup, /review/);
  assert.match(markup, /Updated /);
});

test("a non-empty step output renders markdown, not the empty state", () => {
  const markup = renderToStaticMarkup(<StepOutput output={output("# Title\n\nSome **bold** prose.")} />);
  assert.doesNotMatch(markup, /No output recorded\./);
  assert.match(markup, /Title/);
  assert.match(markup, /<strong[^>]*>bold<\/strong>/);
});

test("a long step output clamps and offers Show more; a short one does neither", () => {
  const long = renderToStaticMarkup(<StepOutput output={output(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"))} />);
  assert.match(long, /max-h-\[420px\]/);
  assert.match(long, /Show more/);

  const short = renderToStaticMarkup(<StepOutput output={output("one line")} />);
  assert.doesNotMatch(short, /max-h-\[420px\]/);
  assert.doesNotMatch(short, /Show more/);
});

/* ---------------------------------------------------------- run diagnostics */

const unknownMetrics: RunMetrics = {
  phases: { queuedMs: null, provisioningMs: null, executingMs: null, inboxWaitMs: null, cleanupMs: null },
  tokens: { input: null, cachedRead: null, cacheWrite: null, uncachedInput: null, output: null, cacheHitRatio: null },
  tools: { calls: 0, failed: 0, unclassified: 0, totalToolMs: 0, unpairedCalls: 0, byName: [] },
  modelActiveMs: null,
  modelActiveIsUpperBound: false,
  outputTokensPerSecond: null,
  termination: { reason: null, exitCode: null, signal: null },
};

const measuredMetrics: RunMetrics = {
  phases: { queuedMs: 12_000, provisioningMs: 3_000, executingMs: 600_000, inboxWaitMs: 30_000, cleanupMs: 250 },
  tokens: { input: 120_000, cachedRead: 90_000, cacheWrite: 5_000, uncachedInput: 25_000, output: 8_000, cacheHitRatio: 0.75 },
  tools: { calls: 42, failed: 3, unclassified: 1, totalToolMs: 9_000, unpairedCalls: 2, byName: [{ name: "Bash", calls: 20, failed: 1 }] },
  modelActiveMs: 400_000,
  modelActiveIsUpperBound: true,
  outputTokensPerSecond: 20,
  termination: { reason: "completed", exitCode: 0, signal: null },
};

test("an unmeasured diagnostic renders the unknown marker, never a zero reading", () => {
  const markup = renderToStaticMarkup(<RunDiagnostics metrics={unknownMetrics} />);
  // Five phases, five token figures, the rate, the model-active time and three
  // termination fields: every one of them unknown.
  assert.equal((markup.match(/—/gu) ?? []).length, 15);
  for (const zero of [/0%/u, /0ms/u, /\b0s\b/u, /0 tok\/s/u]) assert.doesNotMatch(markup, zero);
  // A measured `0` is still a measurement: the three tool counters keep it.
  assert.equal((markup.match(/<span>0<\/span>/gu) ?? []).length, 3);
  // The phase bar draws no segment at all when nothing was measured.
  assert.match(markup, /data-run-phase-bar=""><\/div>/u);
});

test("measured diagnostics render their phases, tokens, tools and termination", () => {
  const markup = renderToStaticMarkup(<RunDiagnostics metrics={measuredMetrics} />);
  for (const shown of [
    /Queued<\/span><span>12s/u, /Provisioning<\/span><span>3s/u, /Executing<\/span><span>10m 0s/u,
    /Inbox wait<\/span><span>30s/u, /Cleanup<\/span><span>250ms/u,
    /Input<\/span><span>120K/u, /Cached read<\/span><span>90K/u, /Cache write<\/span><span>5K/u,
    /Output<\/span><span>8K/u, /Cache hit<\/span><span>75%/u,
    /Calls<\/span><span>42/u, /Failed<\/span><span>3/u, /Unclassified<\/span><span>1/u,
    /Bash<\/span><span>20 calls · 1 failed/u,
    /Reason<\/span><span>completed/u, /Exit code<\/span><span>0<\/span>/u, /Signal<\/span><span>—/u,
  ]) assert.match(markup, shown);
  // Widths are proportional to the measured phases: 12s of a 645.25s bar.
  assert.match(markup, /width:1\.8[0-9]*%/u);
});

test("the output rate is labelled a session average and marked when it is an upper bound", () => {
  const markup = renderToStaticMarkup(<RunDiagnostics metrics={measuredMetrics} />);
  assert.match(markup, /Effective output rate/u);
  assert.match(markup, /A session average over model-active time, not a provider peak rate\./u);
  // `modelActiveIsUpperBound` makes the rate and the time it divides ceilings.
  assert.match(markup, /≤ 20 tok\/s \(upper bound\)/u);
  assert.match(markup, /≤ 6m 40s \(upper bound\)/u);

  const measured = { ...measuredMetrics, modelActiveIsUpperBound: false };
  const plain = renderToStaticMarkup(<RunDiagnostics metrics={measured} />);
  assert.doesNotMatch(plain, /upper bound/u);
  assert.match(plain, /20 tok\/s/u);
});

test("a run with no diagnostics says so rather than rendering a block of zeroes", () => {
  for (const metrics of [null, undefined]) {
    const markup = renderToStaticMarkup(<RunDiagnostics metrics={metrics} />);
    assert.match(markup, /No diagnostics recorded for this run\./u);
    assert.doesNotMatch(markup, /0%/u);
  }
});

test("the diagnostics formatters keep a measured zero and refuse to invent one", () => {
  assert.equal(percent(0.75), "75%");
  assert.equal(percent(0.8125), "81.3%");
  // A measured zero is a reading; an unmeasured ratio is not, and `null` is the
  // caller's signal to drop the clause rather than to print `0%`.
  assert.equal(percent(0), "0%");
  assert.equal(percent(null), null);
  assert.equal(percent(undefined), null);

  // A sub-second span keeps its millisecond unit rather than rounding to `0s`.
  assert.equal(durationMs(250), "250ms");
  assert.equal(durationMs(0), "0ms");
  assert.equal(durationMs(12_000), "12s");
  assert.equal(durationMs(600_000), "10m 0s");
  assert.equal(durationMs(null), "—");

  assert.equal(tokensPerSecond(20), "20 tok/s");
  assert.equal(tokensPerSecond(19.94), "19.9 tok/s");
  assert.equal(tokensPerSecond(null), "—");
});

test("the newest run's cache hit reaches the tokens stat pill", () => {
  assert.match(source, /const newestCacheHit = percent\(newest\?\.metrics\?\.tokens\.cacheHitRatio\)/u);
  assert.match(source, /newestCacheHit === null\s*\?\s*t\("taskDetail\.stats\.tokens"/u);
  assert.match(source, /t\("taskDetail\.stats\.tokensWithCacheHit", \{ n: compactTokens\(totalTokens\), ratio: newestCacheHit \}\)/u);
});

test("termination is stated once, in the diagnostics block rather than twice", () => {
  assert.doesNotMatch(source, /taskDetail\.run\.termination/u);
  assert.doesNotMatch(source, /run\.terminationReason/u);
  const row = source.slice(source.indexOf("const RunRow"), source.indexOf("const Activity"));
  assert.match(row.slice(row.indexOf("{expanded ?")), /<RunDiagnostics metrics=\{run\.metrics\} \/>/u);
});

/* ------------------------------------------------------------ static guards */

test("the raw event table has left the task page", () => {
  for (const symbol of ["RunEvents", "EVENT_LOG", "EVENT_ROW"]) {
    assert.doesNotMatch(source, new RegExp(`\\b${symbol}\\b`), symbol);
  }
  // The link moved to a dictionary key in batch 1, so the guard follows it: the
  // point of the assertion is that the session is reachable from the run row.
  assert.match(source, /taskDetail\.run\.openSession/);
});

test("the runs table's head count, cell count and expanded colSpan agree", () => {
  const heads = source.slice(source.indexOf("<TableHeader>"), source.indexOf("</TableHeader>"));
  const headCount = (heads.match(/<TableHead[ />]/g) ?? []).length;

  const row = source.slice(source.indexOf("const RunRow"), source.indexOf("const Activity"));
  const body = row.slice(0, row.indexOf("{expanded ?"));
  const cellCount = (body.match(/<TableCell[ />]/g) ?? []).length;

  const colSpan = Number(/colSpan=\{(\d+)\}/.exec(source)?.[1]);
  assert.equal(headCount, cellCount, "a head with no cell silently shifts every column right of it");
  assert.equal(colSpan, headCount, "the expanded row must span the whole table");
});

test("every run's pull request is reachable, not just the newest one's", () => {
  // The task Details card sources its anchor from `runs[0]` alone, so without a
  // per-run entry a retry or a review run whose PR is not the newest is
  // reachable from nowhere in the product.
  const row = source.slice(source.indexOf("const RunRow"), source.indexOf("const Activity"));
  const expanded = row.slice(row.indexOf("{expanded ?"));
  assert.match(expanded, /k: t\("taskDetail\.run\.pullRequest"\)/);
  assert.match(expanded, /run\.pullRequestUrl/);
  // Distinct from Push, which is the status word and never a link.
  assert.match(expanded, /k: t\("taskDetail\.run\.push"\)/);
});
