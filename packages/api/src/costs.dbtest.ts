import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { DependencyProvisioning, PrismaClient, recordReadinessRequeue } from "@anneal/db";

import { COSTS_TOP_RUNS, readProjectCosts } from "./costs.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

/**
 * `GET /projects/:projectId/costs` against a real PostgreSQL.
 *
 * The point of the file is the reconciliation test: provider-reported spend is
 * compared with a raw SQL sum over the same bounded window, while the estimated
 * share is pinned separately. The other tests cover behaviours that one total
 * cannot express — runner-specific token normalization, unavailable costs,
 * stable agent identity, exact range parsing, and timezone-aware boundaries.
 */

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-db-token";

const call = async (path: string): Promise<{ status: number; body: any }> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(path, {
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    });
    return { status: response.status, body: await response.json() };
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const costsPath = (projectId: string, days?: number, tz = "UTC"): string =>
  `/projects/${projectId}/costs?${days === undefined ? "" : `days=${days}&`}tz=${encodeURIComponent(tz)}`;

const unique = (label: string): string => `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`;

const BASE_SHA = "a".repeat(40);
const FIRST_DRIFT_SHA = "b".repeat(40);
const SECOND_DRIFT_SHA = "c".repeat(40);

const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const seedProject = async (label: string) => {
  const project = await db.project.create({ data: { name: label, slug: unique(label) } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  const agent = async (name: string, title: string) => db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name, title, model: "claude-opus-5",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  return { project, repo, agent };
};

type RunSpec = {
  agentId: string;
  model: string;
  runner: "CLAUDE" | "CODEX" | "PI";
  startedAt: Date;
  status?: "SUCCEEDED" | "FAILED" | "RUNNING";
  subagentModel?: true;
  session?: {
    nativeChildUsed?: boolean;
    costUsd?: string | null;
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    cacheCreationInputTokens?: number | null;
    outputTokens?: number | null;
  } | null;
};

let runOrdinal = 0;

const seedRun = async (
  projectId: string,
  repoId: string,
  taskName: string,
  spec: RunSpec,
): Promise<string> => {
  runOrdinal += 1;
  const task = await db.task.create({ data: {
    projectId, name: taskName, description: "costs", assigneeAgentId: spec.agentId, repoId,
  } });
  const run = await db.run.create({ data: {
    projectId, taskId: task.id, agentId: spec.agentId, repoId, runNumber: 1,
    dedupeKey: `task:${task.id}:run:1:${runOrdinal}`, runner: spec.runner, status: spec.status ?? "SUCCEEDED",
    model: spec.model, promptHash: "hash", startedAt: spec.startedAt,
    // `Run_native_subagent_snapshot_check` only accepts the pinned pair, so a
    // mixed-model run is seeded exactly as the control plane writes one.
    ...(spec.subagentModel === true ? { subagentModel: "gpt-5.6-luna:max", subagentMaxConcurrent: 8 } : {}),
  } });
  if (spec.session !== null) {
    const cacheCreationInputTokens = spec.session !== undefined
      && Object.hasOwn(spec.session, "cacheCreationInputTokens")
      ? spec.session.cacheCreationInputTokens ?? null
      : 0;
    await db.session.create({ data: {
      runId: run.id, projectId, agentId: spec.agentId, taskId: task.id, runner: spec.runner,
      executionStatus: "SUCCEEDED", startedAt: spec.startedAt,
      nativeChildUsed: spec.session?.nativeChildUsed ?? false,
      costUsd: spec.session?.costUsd ?? null,
      inputTokens: spec.session?.inputTokens ?? null,
      cachedInputTokens: spec.session?.cachedInputTokens ?? null,
      cacheCreationInputTokens,
      outputTokens: spec.session?.outputTokens ?? null,
    } });
  }
  return run.id;
};

test("totalUsd reconciles with a raw SQL sum over the same window", async () => {
  const { project, repo, agent } = await seedProject("costs-reconcile");
  const dev = await agent("dev", "Frontend Dev");
  const reviewer = await agent("reviewer", "Reviewer");
  await seedRun(project.id, repo.id, "In window A", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(1),
    session: { costUsd: "1.2500" },
  });
  await seedRun(project.id, repo.id, "In window B", {
    agentId: reviewer.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(3),
    session: { costUsd: "0.7500" },
  });
  await seedRun(project.id, repo.id, "Estimated in window", {
    agentId: dev.id, model: "openai-codex/gpt-5.6-luna", runner: "CODEX", startedAt: daysAgo(2),
    // 900k uncached + 100k cached input and 500k output = $0.782.
    session: { costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 500_000 },
  });
  // Outside the 7-day window, and so outside both the route and the SQL sum.
  await seedRun(project.id, repo.id, "Old", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(40),
    session: { costUsd: "99.0000" },
  });
  // Still running: usage is still being written, so it is not settled spend.
  await seedRun(project.id, repo.id, "Live", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(1), status: "RUNNING",
    session: { costUsd: "50.0000" },
  });

  const { status, body } = await call(costsPath(project.id, 7));
  assert.equal(status, 200);

  const [manual] = await db.$queryRaw<Array<{ sum: unknown }>>`
    SELECT COALESCE(SUM(s."costUsd"), 0) AS sum
    FROM "Session" s
    JOIN "Run" r ON r.id = s."runId"
    WHERE r."projectId" = ${project.id}
      AND r.status IN ('succeeded', 'failed', 'timed-out', 'cancelled', 'lost')
      AND r."startedAt" >= ${new Date(body.since)}
      AND r."startedAt" < ${new Date(new Date(body.since).getTime() + 7 * 24 * 60 * 60 * 1000)}
  `;
  assert.equal(Number(body.totalUsd) - Number(body.estimatedUsd), Number(manual?.sum));
  assert.equal(Number(body.totalUsd), 2.782);
  assert.equal(body.runCount, 3);
  assert.equal(body.costUnavailableRuns, 0);
  assert.equal(Number(body.avgUsd), 0.927333);
  assert.equal(Number(body.estimatedUsd), 0.782);
});

test("a codex session without a reported amount is counted apart, never as zero", async () => {
  const { project, repo, agent } = await seedProject("costs-unpriced");
  const dev = await agent("dev", "Frontend Dev");
  await seedRun(project.id, repo.id, "Priced", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(1),
    session: { costUsd: "2.0000" },
  });
  // Codex reports no amount and this run's tokens are incomplete, so there is
  // nothing to price and nothing to estimate.
  await seedRun(project.id, repo.id, "Unpriced", {
    agentId: dev.id, model: "openai-codex/gpt-5.6-luna", runner: "CODEX", startedAt: daysAgo(1),
    session: { costUsd: null, inputTokens: 1_000 },
  });
  // An Astra executioner with native children has one unsplit aggregate. Codex
  // reports no per-thread usage, so the whole aggregate is priced at the root
  // model rather than at the platform-pinned child model.
  await seedRun(project.id, repo.id, "Mixed", {
    agentId: dev.id, model: "openai-codex/gpt-6-astra", runner: "CODEX", startedAt: daysAgo(2),
    subagentModel: true,
    session: { nativeChildUsed: true, costUsd: null, inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 50 },
  });
  // A settled run that never produced a session row at all.
  await seedRun(project.id, repo.id, "Sessionless", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(2), session: null,
  });

  const { body } = await call(costsPath(project.id, 7));
  assert.equal(body.runCount, 4);
  assert.equal(body.costUnavailableRuns, 2);
  // The mixed aggregate has 900 uncached + 100 cached input and 50 output
  // tokens; Astra pricing yields 0.009 + 0.0001 + 0.0025 = $0.0116.
  assert.equal(Number(body.totalUsd), 2.0116);
  // The average is over the two runs that have a cost, not over all four.
  assert.equal(Number(body.avgUsd), 1.0058);
  assert.equal(body.byAgent.length, 1);
  assert.equal(body.byAgent[0].runs, 4);
  assert.equal(body.byAgent[0].costUnavailableRuns, 2);
  assert.equal(Number(body.byAgent[0].usd), 2.0116);
  assert.equal(Number(body.byAgent[0].avgUsd), 1.0058);
  // The Run row itself is priced, not dropped: an estimate at the model that
  // ran its root thread.
  const mixed = body.topRuns.find((run: { taskName: string | null }) => run.taskName === "Mixed");
  assert.equal(Number(mixed.usd), 0.0116);
  assert.equal(mixed.estimated, true);
  assert.equal(mixed.model, "openai-codex/gpt-6-astra");
});

test("a complete codex token set is priced and labelled as an estimate", async () => {
  const { project, repo, agent } = await seedProject("costs-estimate");
  const dev = await agent("dev", "Frontend Dev");
  await seedRun(project.id, repo.id, "Estimated", {
    agentId: dev.id, model: "openai-codex/gpt-5.6-luna", runner: "CODEX", startedAt: daysAgo(1),
    // Luna: 0.2 / 0.02 / 1.2 USD per million. 900k uncached input, 100k cached,
    // 500k output = 0.18 + 0.002 + 0.6 = 0.782.
    session: { costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 500_000 },
  });

  const { body } = await call(costsPath(project.id, 7));
  assert.equal(Number(body.totalUsd), 0.782);
  assert.equal(Number(body.estimatedUsd), 0.782);
  assert.equal(body.costUnavailableRuns, 0);
  assert.equal(body.topRuns.length, 1);
  assert.equal(body.topRuns[0].estimated, true);
  assert.equal(body.topRuns[0].taskName, "Estimated");
  assert.equal(body.topRuns[0].agent, "dev");
  assert.equal(body.topRuns[0].model, "openai-codex/gpt-5.6-luna");
});

test("canonical token rows price identically across runners", async () => {
  const { project, repo, agent } = await seedProject("costs-runner-normalization");
  const claude = await agent("claude", "Claude Implementer");
  const codex = await agent("codex", "Implementer");
  const pi = await agent("pi", "PI Implementer");
  // Canonical persisted input includes its cached subset. Every adapter writes
  // this same triple, so Costs must not need the runner to interpret it.
  await seedRun(project.id, repo.id, "Claude estimated", {
    agentId: claude.id, model: "openai-codex/gpt-5.6-luna", runner: "CLAUDE", startedAt: daysAgo(1),
    session: { costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 500_000 },
  });
  await seedRun(project.id, repo.id, "Codex estimated", {
    agentId: codex.id, model: "openai-codex/gpt-5.6-luna", runner: "CODEX", startedAt: daysAgo(1),
    session: { costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 500_000 },
  });
  await seedRun(project.id, repo.id, "PI estimated", {
    agentId: pi.id, model: "openai-codex/gpt-5.6-luna", runner: "PI", startedAt: daysAgo(1),
    session: { costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 500_000 },
  });

  const { body } = await call(costsPath(project.id, 7));
  assert.equal(Number(body.totalUsd), 2.346);
  assert.equal(Number(body.estimatedUsd), 2.346);
  assert.deepEqual(body.byAgent.map((entry: { agent: string; usd: string }) => [entry.agent, Number(entry.usd)]), [
    ["claude", 0.782],
    ["codex", 0.782],
    ["pi", 0.782],
  ]);
});

test("agents with the same title remain distinct by their unique names", async () => {
  const { project, repo, agent } = await seedProject("costs-agent-identity");
  const first = await agent("frontend-dev-opus-medium", "Developer");
  const second = await agent("backend-dev", "Developer");
  await seedRun(project.id, repo.id, "Frontend", {
    agentId: first.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(1),
    session: { costUsd: "1.0000" },
  });
  await seedRun(project.id, repo.id, "Backend", {
    agentId: second.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(1),
    session: { costUsd: "2.0000" },
  });

  const { body } = await call(costsPath(project.id, 7));
  assert.deepEqual(
    body.daily.find((entry: { byAgent: Record<string, string> }) => Object.keys(entry.byAgent).length > 0)?.byAgent,
    { "backend-dev": "2", "frontend-dev-opus-medium": "1" },
  );
  assert.deepEqual(body.byAgent.map((entry: { agent: string }) => entry.agent), ["backend-dev", "frontend-dev-opus-medium"]);
  assert.deepEqual(body.topRuns.map((run: { agent: string }) => run.agent), ["backend-dev", "frontend-dev-opus-medium"]);
});

test("an entirely unpriced agent is explicit rather than indistinguishable from free", async () => {
  const { project, repo, agent } = await seedProject("costs-all-unpriced");
  const dev = await agent("codex", "Codex");
  await seedRun(project.id, repo.id, "Unknown", {
    agentId: dev.id, model: "openai-codex/gpt-5.6-luna", runner: "CODEX", startedAt: daysAgo(1),
    session: { costUsd: null, inputTokens: 100 },
  });

  const { body } = await call(costsPath(project.id, 7));
  assert.deepEqual(body.byAgent, [{
    agent: "codex", usd: "0", runs: 1, costUnavailableRuns: 1, avgUsd: "0", cachePct: null,
    cacheUnknownRuns: 1, uncachedInputTokens: 0, uncachedInputUsd: null, wastedUsd: "0",
  }]);
});

test("the window is a whole number of local day buckets, and every day is present", async () => {
  const { project, repo, agent } = await seedProject("costs-daily");
  const dev = await agent("dev", "Frontend Dev");
  const reviewer = await agent("reviewer", "Reviewer");
  await seedRun(project.id, repo.id, "Dev today", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: new Date(),
    session: { costUsd: "3.0000" },
  });
  await seedRun(project.id, repo.id, "Reviewer today", {
    agentId: reviewer.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: new Date(),
    session: { costUsd: "1.0000" },
  });

  const { body } = await call(costsPath(project.id, 7));
  assert.equal(body.daily.length, 7);
  assert.equal(body.days, 7);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(body.daily.at(-1).date, today);
  assert.deepEqual(body.daily.at(-1).byAgent, { dev: "3", reviewer: "1" });
  // Days nothing ran on are present and empty rather than missing.
  assert.deepEqual(body.daily[0].byAgent, {});
  assert.deepEqual(body.byAgent.map((entry: { agent: string }) => entry.agent), ["dev", "reviewer"]);
});

test("runs beyond the captured local window end are excluded", async () => {
  const { project, repo, agent } = await seedProject("costs-future");
  const dev = await agent("dev", "Developer");
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 5, 0, 0);
  await seedRun(project.id, repo.id, "Future", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: tomorrow,
    session: { costUsd: "9.0000" },
  });

  const { body } = await call(costsPath(project.id, 7));
  assert.equal(body.runCount, 0);
  assert.equal(Number(body.totalUsd), 0);
});

test("top runs are the ten most expensive, most expensive first", async () => {
  const { project, repo, agent } = await seedProject("costs-top");
  const dev = await agent("dev", "Frontend Dev");
  for (let index = 1; index <= COSTS_TOP_RUNS + 3; index += 1) {
    await seedRun(project.id, repo.id, `Run ${index}`, {
      agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: daysAgo(1),
      session: { costUsd: `${index}.0000` },
    });
  }
  const { body } = await call(costsPath(project.id, 7));
  assert.equal(body.runCount, COSTS_TOP_RUNS + 3);
  assert.equal(body.topRuns.length, COSTS_TOP_RUNS);
  assert.deepEqual(
    body.topRuns.map((run: { usd: string }) => Number(run.usd)),
    [13, 12, 11, 10, 9, 8, 7, 6, 5, 4],
  );
});

test("timezone is required and invalid values are refused", async () => {
  const { project } = await seedProject("costs-timezone-validation");
  for (const path of [
    `/projects/${project.id}/costs?days=7`,
    `/projects/${project.id}/costs?days=7&tz=`,
    `/projects/${project.id}/costs?days=7&tz=Not%2FA_Zone`,
  ]) {
    const response = await call(path);
    assert.equal(response.status, 400, path);
    assert.match(response.body.error, /tz/);
  }
});

test("the same near-midnight run lands on the local date of each timezone", async () => {
  const { project, repo, agent } = await seedProject("costs-timezone-buckets");
  const dev = await agent("dev", "Developer");
  const utcMidnight = new Date();
  utcMidnight.setUTCHours(0, 30, 0, 0);
  await seedRun(project.id, repo.id, "Near midnight", {
    agentId: dev.id, model: "claude-opus-5", runner: "CLAUDE", startedAt: utcMidnight,
    session: { costUsd: "1.0000" },
  });

  const utc = await call(costsPath(project.id, 7, "UTC"));
  const pacific = await call(costsPath(project.id, 7, "America/Los_Angeles"));
  const nonEmptyDate = (body: any): string => body.daily.find((day: any) => Object.keys(day.byAgent).length > 0).date;
  assert.notEqual(nonEmptyDate(utc.body), nonEmptyDate(pacific.body));
});

test("Today returns exactly the current calendar date in the supplied timezone", async () => {
  const { project } = await seedProject("costs-today");
  const tz = "America/Los_Angeles";
  const response = await call(costsPath(project.id, 1, tz));
  const expected = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  assert.equal(response.status, 200);
  assert.equal(response.body.daily.length, 1);
  assert.equal(response.body.daily[0].date, expected);
});

test("the default window is 30 days and unsupported or malformed values are refused", async () => {
  const { project } = await seedProject("costs-range");
  const fallback = await call(costsPath(project.id));
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.days, 30);
  assert.equal(fallback.body.daily.length, 30);

  const refused = await call(`/projects/${project.id}/costs?days=45&tz=UTC`);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /1, 7, 30, 90/);

  for (const malformed of ["7.5", "7junk", "90days"]) {
    const response = await call(`/projects/${project.id}/costs?days=${malformed}&tz=UTC`);
    assert.equal(response.status, 400, malformed);
  }
});

test("completed chains survive raw PostgreSQL Task status decoding", async () => {
  const { project, repo, agent } = await seedProject("costs-completed-chain");
  const dev = await agent("dev", "Developer");
  const startedAt = daysAgo(1);
  const endedAt = new Date(startedAt.getTime() + 5 * 60 * 1000);
  const task = await db.task.create({ data: {
    projectId: project.id,
    name: "Completed chain task",
    description: "costs",
    status: "DONE",
    assigneeAgentId: dev.id,
    repoId: repo.id,
    chainId: unique("completed-chain"),
    chainIndex: 0,
    chainLayer: 0,
  } });
  const run = await db.run.create({ data: {
    projectId: project.id,
    taskId: task.id,
    agentId: dev.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${task.id}:run:1:completed-chain`,
    runner: "CLAUDE",
    status: "SUCCEEDED",
    model: "claude-opus-5",
    promptHash: "hash",
    startedAt,
    endedAt,
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: project.id,
    agentId: dev.id,
    taskId: task.id,
    runner: "CLAUDE",
    executionStatus: "SUCCEEDED",
    startedAt,
    endedAt,
    nativeChildUsed: false,
    costUsd: "1.0000",
    cacheCreationInputTokens: 0,
  } });

  const report = await readProjectCosts(db, project.id, 7, "UTC", new Date());

  assert.equal(report.chains.length, 1);
  assert.equal(report.chains[0]?.chainId, task.chainId);
  assert.equal(report.chains[0]?.costUsd?.toString(), "1");
});

test("a chain's readiness requeues and their grants are summed onto the chain row", async () => {
  const { project, repo, agent } = await seedProject("costs-readiness-requeue");
  const dev = await agent("dev", "Developer");
  const startedAt = daysAgo(1);
  const endedAt = new Date(startedAt.getTime() + 5 * 60 * 1000);
  const chainId = unique("requeue-chain");
  const readiness = await db.task.create({ data: {
    projectId: project.id,
    name: "Autonomous merge tail: merge readiness",
    description: "costs",
    status: "DONE",
    assigneeAgentId: dev.id,
    repoId: repo.id,
    chainId,
    chainIndex: 0,
    chainLayer: 0,
  } });
  const run = await db.run.create({ data: {
    projectId: project.id,
    taskId: readiness.id,
    agentId: dev.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${readiness.id}:run:1:requeue-chain`,
    runner: "CLAUDE",
    status: "SUCCEEDED",
    model: "claude-opus-5",
    promptHash: "hash",
    startedAt,
    endedAt,
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: project.id,
    agentId: dev.id,
    taskId: readiness.id,
    runner: "CLAUDE",
    executionStatus: "SUCCEEDED",
    startedAt,
    endedAt,
    nativeChildUsed: false,
    costUsd: "1.0000",
    cacheCreationInputTokens: 0,
  } });
  // Written the way the settlement writes them, so the SQL sum is read from
  // the same rows and ordinals the control plane produces.
  for (const [stale, current] of [[BASE_SHA, FIRST_DRIFT_SHA], [FIRST_DRIFT_SHA, SECOND_DRIFT_SHA]]) {
    await recordReadinessRequeue(db, {
      readinessTaskId: readiness.id,
      regressionTaskId: readiness.id,
      staleBaseSha: stale!,
      currentBaseSha: current!,
      budgetGrant: 1,
      reason: "base moved before authorization",
    });
  }

  const report = await readProjectCosts(db, project.id, 7, "UTC", new Date());

  assert.equal(report.chains.length, 1);
  assert.equal(report.chains[0]?.readinessRequeues, 2);
  assert.equal(report.chains[0]?.readinessGrants, 2);
});

test("the 90-day costs read uses one project-wide query per table", async () => {
  const { project, repo, agent } = await seedProject("costs-query-count");
  const dev = await agent("dev", "Developer");
  for (let index = 1; index <= 12; index += 1) {
    await seedRun(project.id, repo.id, `Historical ${index}`, {
      agentId: dev.id,
      model: "claude-opus-5",
      runner: "CLAUDE",
      startedAt: daysAgo(index * 5),
      session: { costUsd: "1.0000" },
    });
  }

  const loggedDb = new PrismaClient({
    datasources: { db: { url: testDatabaseUrl } },
    log: [{ emit: "event", level: "query" }],
  });
  const selectQueries: string[] = [];
  loggedDb.$on("query", (event) => {
    if (/^\s*SELECT\b/iu.test(event.query)) selectQueries.push(event.query);
  });
  try {
    const report = await readProjectCosts(loggedDb, project.id, 90, "UTC", new Date());
    assert.equal(report.runCount, 12);
    // Task, detached-repair marker, and Run are each loaded once; there is no
    // per-chain or per-task follow-up query hidden behind the report.
    assert.equal(selectQueries.length, 3);
  } finally {
    await loggedDb.$disconnect();
  }
});
