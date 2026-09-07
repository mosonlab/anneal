import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import {
  ChainControlState,
  DependencyProvisioning,
  lockChainRows,
  PrismaClient,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
} from "@anneal/db";
// The production runner, not a stand-in. The runner exposes these two
// entrypoints the way @anneal/db does — types from source, runtime from dist —
// so this typechecks before anything is built and runs against the compiled
// daemon (`pretest:db` builds it). What it buys is that the deletion side of
// the protocol under test is the code that actually runs in production: its
// authorizer, its physical root check, its settlement path.
import { reclaimWorkspaces } from "@anneal/runner/reclaim";
import type { RunnerConfig } from "@anneal/runner/config";

import { reconcileDatabaseRuns } from "./reconcile.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";
import { acknowledgeReclaimSalvage } from "./workspace-reclaim.js";

/**
 * Workspace GC ownership (issue #115), end to end.
 *
 * Real runner → real HTTP routes → real database. What is being asserted is a
 * boundary, not a feature: the control plane marks rows and answers questions,
 * and the only process that unlinks anything is the one that owns the root.
 */

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const RUNNER_TOKEN = "runner-reclaim-token";
const API_ORIGIN = "http://control-plane.test";

const withRunnerToken = async <T>(root: string, operation: () => T | Promise<T>): Promise<T> => {
  const priorToken = process.env.RUNNER_TOKEN;
  const priorRoot = process.env.RUNNER_WORKSPACE_ROOT;
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  process.env.RUNNER_WORKSPACE_ROOT = root;
  try {
    return await operation();
  } finally {
    if (priorToken === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = priorToken;
    if (priorRoot === undefined) delete process.env.RUNNER_WORKSPACE_ROOT; else process.env.RUNNER_WORKSPACE_ROOT = priorRoot;
  }
};

const call = async (root: string, path: string, body: unknown): Promise<{ status: number; body: any }> =>
  withRunnerToken(root, async () => {
    const response = await createApp(db, { workspaceRoot: root }).request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  });

const runnerConfig = (root: string, runnerId: string): RunnerConfig => ({
  apiUrl: API_ORIGIN,
  runnerToken: RUNNER_TOKEN,
  runnerId,
  servedKinds: null,
  daemonVersion: "0.0.0-dbtest",
  pollIntervalMs: 1_000,
  claimMaxLoadAverage: 1.5,
  leaseSeconds: 60,
  heartbeatIntervalMs: 5_000,
  path: "/usr/bin:/bin",
  home: root,
  gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
  workspaceRoot: root,
  hostProofSlots: 3,
  failedWorkspaceRetention: 2,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
});

const originalFetch = globalThis.fetch;

/**
 * Routes the runner's own HTTP client into the real app. `failOn` simulates the
 * one crash the protocol has to survive: the removal succeeded and the report
 * never landed.
 */
const routeRunnerToApi = (root: string, failOn: string[] = []): Array<{ path: string; body: any }> => {
  const calls: Array<{ path: string; body: any }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) });
    if (failOn.some((path) => url.pathname.endsWith(path))) throw new Error("simulated control-plane loss");
    return withRunnerToken(root, () => createApp(db, { workspaceRoot: root }).request(url.pathname, {
      method: init?.method ?? "POST",
      headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
      body: init?.body as string,
    }));
  }) as typeof fetch;
  return calls;
};

const restoreFetch = (): void => { globalThis.fetch = originalFetch; };

let seedCounter = 0;

const seedRun = async (options: {
  root: string;
  runnerId: string;
  status?: "RUNNING" | "SUCCEEDED" | "FAILED" | "LOST";
  workspaceRetained?: boolean;
  workspacePath?: string | null;
  endedAt?: Date | null;
  pushedBranch?: string | null;
}) => {
  const suffix = `${Date.now()}-${seedCounter++}`;
  const project = await db.project.create({ data: { name: "Reclaim", slug: `reclaim-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  const task = await db.task.create({ data: {
    projectId: project.id, name: "Task", description: "task", assigneeAgentId: agent.id, repoId: repo.id, status: "DOING",
  } });
  const status = options.status ?? "RUNNING";
  const fencingToken = `1:${task.id}:${suffix}`;
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: task.id, agentId: agent.id, repoId: repo.id, runNumber: 1,
    dedupeKey: `task:${task.id}:run:1`, runner: "CLAUDE", runnerId: options.runnerId,
    fencingToken, leaseExpiresAt: new Date(Date.now() + 60_000),
    status, model: "claude", promptHash: "hash", maxRunsPerTask: 5,
    workspaceRetained: options.workspaceRetained ?? false,
    // These ownership/retry fixtures predate terminal salvage and exercise a
    // workspace whose normal delivery is already durable. Tests for an
    // unpublished workspace opt back into null explicitly.
    pushedBranch: options.pushedBranch === undefined ? "already/durable" : options.pushedBranch,
    ...(options.endedAt === undefined ? {} : { endedAt: options.endedAt }),
  } });
  // Written after create so a caller can ask for the canonical path without
  // repeating a run id it does not know yet.
  const workspacePath = options.workspacePath === undefined ? join(options.root, run.id) : options.workspacePath;
  if (workspacePath !== null) await db.run.update({ where: { id: run.id }, data: { workspacePath } });
  await db.session.create({ data: {
    runId: run.id, projectId: project.id, agentId: agent.id, taskId: task.id, runner: "CLAUDE",
    executionStatus: status === "RUNNING" ? "RUNNING" : "FAILED",
    cleanupStatus: "PENDING",
  } });
  await mkdir(join(options.root, run.id), { recursive: true });
  await writeFile(join(options.root, run.id, "tree.txt"), "work");
  return { project, agent, repo, task, run, fencingToken };
};

const scratchRoot = async (label: string): Promise<string> => resolve(await mkdtemp(join(tmpdir(), `agentos-reclaim-db-${label}-`)));

test("the real runner reclaims through the real routes, and the status is written back", async (t) => {
  const root = await scratchRoot("chain");
  const runnerId = "runner-alpha";
  const { run } = await seedRun({ root, runnerId, status: "SUCCEEDED", endedAt: new Date() });
  const calls = routeRunnerToApi(root);
  t.after(restoreFetch);

  const sweep = await reclaimWorkspaces(runnerConfig(root, runnerId));

  assert.deepEqual(sweep, { offered: 1, removed: 1, refused: 0, failed: 0, settled: 0 });
  await assert.rejects(access(join(root, run.id)));
  assert.deepEqual(calls.map(({ path }) => path), [
    "/runner/workspaces/reclaimable",
    "/runner/workspaces/reclaimed",
  ]);
  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { session: true } });
  assert.ok(closed.workspaceReclaimAt, "the intent must be published before anything is removed");
  assert.ok(closed.workspaceReclaimedAt);
  assert.equal(closed.session?.cleanupStatus, "SUCCEEDED");

  // A closed intent is not re-offered, and a second sweep is a no-op.
  const second = await reclaimWorkspaces(runnerConfig(root, runnerId));
  assert.deepEqual(second, { offered: 0, removed: 0, refused: 0, failed: 0, settled: 0 });
});

test("a removal whose report is lost converges on the next sweep", async (t) => {
  // The delete-then-ack crash. The directory is gone, so no later inventory can
  // mention it: without the settlement path the intent hangs open forever and
  // the session's cleanupStatus never catches up.
  const root = await scratchRoot("lost-ack");
  const runnerId = "runner-crash";
  const { run } = await seedRun({ root, runnerId, status: "FAILED", endedAt: new Date() });
  routeRunnerToApi(root, ["/reclaimed"]);
  t.after(restoreFetch);

  await assert.rejects(reclaimWorkspaces(runnerConfig(root, runnerId)), /simulated control-plane loss/u);
  await assert.rejects(access(join(root, run.id)), "the removal itself succeeded");
  const hanging = await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { session: true } });
  assert.ok(hanging.workspaceReclaimAt);
  assert.equal(hanging.workspaceReclaimedAt, null);
  assert.equal(hanging.session?.cleanupStatus, "PENDING");

  routeRunnerToApi(root);
  const sweep = await reclaimWorkspaces(runnerConfig(root, runnerId));

  assert.deepEqual(sweep, { offered: 0, removed: 0, refused: 0, failed: 0, settled: 1 });
  const settled = await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { session: true } });
  assert.ok(settled.workspaceReclaimedAt);
  assert.equal(settled.session?.cleanupStatus, "SUCCEEDED");
});

test("a stale FAILED arriving after the intent closed cannot roll the cleanup back", async () => {
  const root = await scratchRoot("late-failure");
  const runnerId = "runner-order";
  const { run } = await seedRun({ root, runnerId, status: "FAILED", endedAt: new Date() });
  await call(root, "/runner/workspaces/reclaimable", { runnerId, workspaceRoot: root, directories: [run.id] });
  const removed = await call(root, "/runner/workspaces/reclaimed", {
    runnerId, workspaceRoot: root, results: [{ runId: run.id, outcome: "REMOVED" }],
  });
  assert.deepEqual(removed.body, { closed: 1, failed: 0, ignored: 0 });

  // Two overlapping sweeps: the older one's failure lands after the newer one's
  // success. The terminal state must be decided by what closed the intent, not
  // by arrival order.
  const late = await call(root, "/runner/workspaces/reclaimed", {
    runnerId, workspaceRoot: root, results: [{ runId: run.id, outcome: "FAILED", failureReason: "EACCES" }],
  });
  assert.deepEqual(late.body, { closed: 0, failed: 0, ignored: 1 });
  const final = await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { session: true } });
  assert.equal(final.session?.cleanupStatus, "SUCCEEDED");
  assert.equal(final.session?.cleanupFailureReason, null);
  assert.equal(final.workspaceReclaimAttempts, 0);
});

test("a duplicate REMOVED is a no-op, and a REFUSED cannot overwrite a closed intent", async () => {
  const root = await scratchRoot("duplicate");
  const runnerId = "runner-dup";
  const { run } = await seedRun({ root, runnerId, status: "FAILED", endedAt: new Date() });
  await call(root, "/runner/workspaces/reclaimable", { runnerId, workspaceRoot: root, directories: [run.id] });
  await call(root, "/runner/workspaces/reclaimed", { runnerId, workspaceRoot: root, results: [{ runId: run.id, outcome: "REMOVED" }] });
  const closedAt = (await db.run.findUniqueOrThrow({ where: { id: run.id } })).workspaceReclaimedAt;

  const again = await call(root, "/runner/workspaces/reclaimed", {
    runnerId, workspaceRoot: root,
    results: [{ runId: run.id, outcome: "REMOVED" }, { runId: run.id, outcome: "REFUSED", failureReason: "too late" }],
  });
  assert.deepEqual(again.body, { closed: 0, failed: 0, ignored: 2 });
  const final = await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { session: true } });
  assert.deepEqual(final.workspaceReclaimedAt, closedAt, "the close timestamp is the first one and does not move");
  assert.equal(final.session?.cleanupStatus, "SUCCEEDED");
});

test("two concurrent reports close an intent exactly once", async () => {
  const root = await scratchRoot("concurrent");
  const runnerId = "runner-race";
  const { run } = await seedRun({ root, runnerId, status: "FAILED", endedAt: new Date() });
  await call(root, "/runner/workspaces/reclaimable", { runnerId, workspaceRoot: root, directories: [run.id] });

  const both = await Promise.all([
    call(root, "/runner/workspaces/reclaimed", { runnerId, workspaceRoot: root, results: [{ runId: run.id, outcome: "REMOVED" }] }),
    call(root, "/runner/workspaces/reclaimed", { runnerId, workspaceRoot: root, results: [{ runId: run.id, outcome: "REMOVED" }] }),
  ]);
  assert.equal(both.filter(({ body }) => body.closed === 1).length, 1, "exactly one report may close the intent");
  assert.equal(both.filter(({ body }) => body.ignored === 1).length, 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { session: true } })).session?.cleanupStatus, "SUCCEEDED");
});

test("a failed removal keeps the intent open, counts the attempt, and is retried", async () => {
  const root = await scratchRoot("retry");
  const runnerId = "runner-retry";
  const { run } = await seedRun({ root, runnerId, status: "FAILED", endedAt: new Date() });
  await call(root, "/runner/workspaces/reclaimable", { runnerId, workspaceRoot: root, directories: [run.id] });
  const failed = await call(root, "/runner/workspaces/reclaimed", {
    runnerId, workspaceRoot: root, results: [{ runId: run.id, outcome: "FAILED", failureReason: "EACCES" }],
  });
  assert.deepEqual(failed.body, { closed: 0, failed: 1, ignored: 0 });
  const open = await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { session: true } });
  assert.equal(open.workspaceReclaimedAt, null);
  assert.equal(open.workspaceReclaimAttempts, 1);
  assert.equal(open.session?.cleanupStatus, "FAILED");

  const again = await call(root, "/runner/workspaces/reclaimable", { runnerId, workspaceRoot: root, directories: [run.id] });
  assert.deepEqual(again.body.reclaim.map((offer: { runId: string }) => offer.runId), [run.id]);
});

test("completing a run no longer deletes anything from the API side", async () => {
  // The regression this issue is about. Before the ownership move, /complete
  // called into the API's own `rm`; a control plane whose root or database was
  // wrong could destroy a workspace it did not own.
  const root = await scratchRoot("complete");
  const runnerId = "runner-complete";
  const { run, fencingToken } = await seedRun({ root, runnerId });

  const completion = await call(root, `/runner/runs/${run.id}/complete`, {
    runnerId, fencingToken, exitCode: 0, signal: null, outcome: { case: "succeeded" },
    // The runner says its own cleanup failed. Under API-side GC this was the
    // signal to delete the directory here; now it is only a status.
    cleanupStatus: "FAILED", cleanupFailureReason: "rm failed", workspaceRetained: false,
  });
  assert.equal(completion.status, 200);
  await access(join(root, run.id));
  assert.equal((await db.session.findFirstOrThrow({ where: { runId: run.id } })).cleanupStatus, "FAILED");

  const plan = await call(root, "/runner/workspaces/reclaimable", { runnerId, workspaceRoot: root, directories: [run.id] });
  assert.deepEqual(plan.body.reclaim.map((offer: { runId: string }) => offer.runId), [run.id]);
});

test("a second runner sharing the root gets nothing, and cannot report on it either", async (t) => {
  // Same root, different identity. `RUNNER_TOKEN` authenticates a runner class,
  // so `runnerId` is the only identity in the exchange; a caller that can name
  // the directory must still not be able to delete another runner's run.
  const root = await scratchRoot("shared-root");
  const { run } = await seedRun({ root, runnerId: "runner-owner", status: "SUCCEEDED", endedAt: new Date() });
  routeRunnerToApi(root);
  t.after(restoreFetch);

  const sweep = await reclaimWorkspaces(runnerConfig(root, "runner-intruder"));

  assert.deepEqual(sweep, { offered: 0, removed: 0, refused: 0, failed: 0, settled: 0 });
  await access(join(root, run.id));
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).workspaceReclaimAt, null);

  // Even with an intent open for the real owner, the intruder cannot close it.
  await db.run.update({ where: { id: run.id }, data: { workspaceReclaimAt: new Date() } });
  const report = await call(root, "/runner/workspaces/reclaimed", {
    runnerId: "runner-intruder", workspaceRoot: root, results: [{ runId: run.id, outcome: "REMOVED" }],
  });
  assert.deepEqual(report.body, { closed: 0, failed: 0, ignored: 1 });
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).workspaceReclaimedAt, null);
});

test("an active run's workspace and an unknown directory both survive a real sweep", async (t) => {
  const root = await scratchRoot("keep");
  const runnerId = "runner-keep";
  const { run } = await seedRun({ root, runnerId, status: "RUNNING" });
  await mkdir(join(root, "unknown-to-this-database"));
  const calls = routeRunnerToApi(root);
  t.after(restoreFetch);

  const sweep = await reclaimWorkspaces(runnerConfig(root, runnerId));

  assert.deepEqual(sweep, { offered: 0, removed: 0, refused: 0, failed: 0, settled: 0 });
  await access(join(root, run.id));
  await access(join(root, "unknown-to-this-database"));
  assert.deepEqual(calls.map(({ path }) => path), ["/runner/workspaces/reclaimable"]);
});

test("retained failures beyond the configured quota are the only retained ones offered", async () => {
  const root = await scratchRoot("retention");
  const runnerId = "runner-retention";
  const now = Date.now();
  const newest = await seedRun({ root, runnerId, status: "FAILED", workspaceRetained: true, endedAt: new Date(now) });
  const oldest = await seedRun({ root, runnerId, status: "FAILED", workspaceRetained: true, endedAt: new Date(now - 10_000) });
  const prior = process.env.RUNNER_FAILED_WORKSPACE_RETENTION;
  process.env.RUNNER_FAILED_WORKSPACE_RETENTION = "1";
  try {
    const plan = await call(root, "/runner/workspaces/reclaimable", {
      runnerId, workspaceRoot: root, directories: [newest.run.id, oldest.run.id],
    });
    assert.deepEqual(plan.body.reclaim.map((offer: { runId: string }) => offer.runId), [oldest.run.id]);
    assert.deepEqual(plan.body.keep, [{ directory: newest.run.id, reason: "retained-failure" }]);
  } finally {
    if (prior === undefined) delete process.env.RUNNER_FAILED_WORKSPACE_RETENTION;
    else process.env.RUNNER_FAILED_WORKSPACE_RETENTION = prior;
  }
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: oldest.run.id } })).workspaceRetained, false);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: newest.run.id } })).workspaceRetained, true);
});

test("an old runner that never asks leaves its workspaces in place, and nothing else deletes them", async () => {
  // The backward-compatibility contract, stated as a test: with no runner
  // speaking the reclaim protocol, the workspace leaks. Leaking is the failure
  // direction this design chooses — the alternative is the API deleting again.
  const root = await scratchRoot("legacy");
  const runnerId = "runner-legacy";
  const { run, fencingToken } = await seedRun({ root, runnerId });
  await call(root, `/runner/runs/${run.id}/complete`, {
    runnerId, fencingToken, exitCode: 1, signal: null,
    outcome: {
      case: "provider-failure",
      reason: "failed",
      envelope: {
        version: 1, phase: "EXECUTE", runnerClass: "TASK_FAILED", exitCode: 1, signal: null,
        terminationReason: null, terminalEventSeen: true, terminalSuccess: false, agentExited: true,
        providerError: null, stderrSummary: "failed", stdoutSummary: null,
        timedOut: false, transient: false, timeoutMs: null,
      },
    },
    cleanupStatus: "FAILED", workspaceRetained: false,
  });
  await access(join(root, run.id));
  const untouched = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(untouched.workspaceReclaimAt, null);
  assert.equal(untouched.workspaceReclaimedAt, null);
});

test("reclaim salvage acknowledgement rebases an already-queued retry", async () => {
  const root = await scratchRoot("salvage-repair");
  const runnerId = "runner-salvage-repair";
  const seeded = await seedRun({ root, runnerId, status: "LOST", pushedBranch: null });
  await db.run.update({
    where: { id: seeded.run.id },
    data: { workspaceReclaimAt: new Date(), leaseExpiresAt: null },
  });
  const replacement = await db.run.create({ data: {
    projectId: seeded.project.id,
    taskId: seeded.task.id,
    agentId: seeded.agent.id,
    repoId: seeded.repo.id,
    runNumber: 2,
    dedupeKey: `task:${seeded.task.id}:run:2`,
    runner: "CLAUDE",
    model: "claude",
    promptHash: "hash-2",
    status: "QUEUED",
    targetBranch: seeded.repo.defaultBranch,
    maxRunsPerTask: 5,
  } });
  const salvage = `agentos/${seeded.task.id}/run-1`;
  const response = await call(root, "/runner/workspaces/salvaged", {
    runnerId, runId: seeded.run.id, pushedBranch: salvage,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).pushedBranch, salvage);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: replacement.id } })).targetBranch, salvage);
});

test("a salvaged implementation continuation can deliver its unchanged base and activate the next layer", async () => {
  const root = await scratchRoot("salvage-continuation");
  const runnerId = "runner-salvage-continuation";
  const seeded = await seedRun({ root, runnerId, status: "LOST", pushedBranch: null });
  const template = await db.taskTemplate.create({ data: {
    projectId: seeded.project.id,
    name: "direct-engineer-workflow",
    description: "Salvage continuation delivery",
    variables: [],
  } });
  const implementationStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    assigneeAgentId: seeded.agent.id,
    stepIndex: 2,
    layer: 2,
    name: "Implementation",
    assigneeType: "AGENT",
    prompt: "implement",
    outputKind: "implementation",
    opensPullRequest: true,
    requiresCommit: true,
  } });
  const reviewStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    assigneeAgentId: seeded.agent.id,
    stepIndex: 3,
    layer: 3,
    name: "Code review",
    assigneeType: "AGENT",
    prompt: "review",
    outputKind: "review-findings",
    opensPullRequest: false,
    requiresCommit: false,
    baseFromStepIndex: 2,
  } });
  const chainId = `salvage-continuation-${seeded.task.id}`;
  const sharedBranch = `agentos/${seeded.project.id}/chain-${chainId}`;
  const baseSha = "4".repeat(40);
  const salvagedHead = "5".repeat(40);
  await db.task.update({ where: { id: seeded.task.id }, data: {
    templateId: template.id,
    templateStepId: implementationStep.id,
    chainId,
    chainIndex: 2,
    chainLayer: 2,
    targetBranch: seeded.repo.defaultBranch,
    opensPullRequest: true,
  } });
  const successor = await db.task.create({ data: {
    projectId: seeded.project.id,
    repoId: seeded.repo.id,
    templateId: template.id,
    templateStepId: reviewStep.id,
    assigneeAgentId: seeded.agent.id,
    name: "Code review",
    description: "review the salvaged implementation",
    chainId,
    chainIndex: 3,
    chainLayer: 3,
    status: TaskStatus.TODO,
    opensPullRequest: false,
  } });
  await db.run.update({ where: { id: seeded.run.id }, data: {
    branch: sharedBranch,
    baseSha,
    headSha: salvagedHead,
    workspaceReclaimAt: new Date(),
    leaseExpiresAt: null,
  } });
  const staleReplacement = await db.run.create({ data: {
    projectId: seeded.project.id,
    taskId: seeded.task.id,
    agentId: seeded.agent.id,
    repoId: seeded.repo.id,
    runNumber: 2,
    dedupeKey: `task:${seeded.task.id}:run:2`,
    runner: "CLAUDE",
    runnerId: "stale-replacement-runner",
    fencingToken: `2:${seeded.task.id}:stale`,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    model: "claude",
    promptHash: "hash-2",
    status: RunStatus.CLAIMED,
    branch: sharedBranch,
    targetBranch: seeded.repo.defaultBranch,
    requiresCommit: true,
    maxRunsPerTask: 5,
  } });
  await db.session.create({ data: {
    runId: staleReplacement.id,
    projectId: seeded.project.id,
    agentId: seeded.agent.id,
    taskId: seeded.task.id,
    runner: "CLAUDE",
    executionStatus: SessionExecutionStatus.PROVISIONING,
  } });
  const salvage = `agentos/${seeded.task.id}/run-1`;

  const repaired = await acknowledgeReclaimSalvage(db, {
    runnerId,
    runId: seeded.run.id,
    pushedBranch: salvage,
  });

  assert.equal(repaired, "requeued");
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: staleReplacement.id } })).status, RunStatus.CANCELLED);
  const continuation = await db.run.findFirstOrThrow({ where: { taskId: seeded.task.id, runNumber: 3 } });
  assert.equal(continuation.targetBranch, salvage);
  assert.equal(continuation.requiresCommit, false);

  const completionRunner = "runner-salvage-delivery";
  const fencingToken = `3:${seeded.task.id}:delivery`;
  await db.run.update({ where: { id: continuation.id }, data: {
    status: RunStatus.RUNNING,
    runnerId: completionRunner,
    fencingToken,
    leaseGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    claimedAt: new Date(),
    startedAt: new Date(),
    promptHash: "hash-3",
    baseSha: salvagedHead,
  } });
  await db.session.create({ data: {
    runId: continuation.id,
    projectId: seeded.project.id,
    agentId: seeded.agent.id,
    taskId: seeded.task.id,
    runner: "CLAUDE",
    executionStatus: SessionExecutionStatus.RUNNING,
  } });
  await db.taskStepOutput.create({ data: {
    taskId: seeded.task.id,
    runId: continuation.id,
    kind: "implementation",
    body: JSON.stringify({
      schemaVersion: 1,
      headSha: salvagedHead,
      baseSha: salvagedHead,
      summary: "The salvaged head already satisfies the implementation brief.",
      testsRun: ["focused"],
    }),
    commitSha: salvagedHead,
    metadata: {},
  } });

  const completion = await call(root, `/runner/runs/${continuation.id}/complete`, {
    runnerId: completionRunner,
    fencingToken,
    exitCode: 0,
    signal: null,
    outcome: { case: "succeeded" },
    branch: sharedBranch,
    pushedBranch: sharedBranch,
    baseSha: salvagedHead,
    headSha: salvagedHead,
    pushStatus: "SUCCEEDED",
    cleanupStatus: "SUCCEEDED",
    workspaceRetained: false,
  });

  assert.equal(completion.status, 200, JSON.stringify(completion.body));
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: continuation.id } })).status, RunStatus.SUCCEEDED);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.task.id } })).status, TaskStatus.DONE);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: successor.id } })).status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: successor.id, status: RunStatus.QUEUED } }), 1);
});

test("a committed Chain Hold bars the fresh replacement after late salvage", async () => {
  const root = await scratchRoot("salvage-held-replacement");
  const runnerId = "runner-salvage-held";
  const seeded = await seedRun({ root, runnerId, status: "LOST", pushedBranch: null });
  const chainId = `salvage-held-${seeded.task.id}`;
  await db.task.create({ data: {
    projectId: seeded.project.id,
    repoId: seeded.repo.id,
    assigneeAgentId: seeded.agent.id,
    name: "Held predecessor",
    description: "holds the replacement layer",
    chainId,
    chainIndex: 0,
    chainLayer: 1,
    status: TaskStatus.DOING,
  } });
  await db.task.update({
    where: { id: seeded.task.id },
    data: { chainId, chainIndex: 1, chainLayer: 2, status: TaskStatus.DOING },
  });
  await db.agentRepoAccess.create({ data: {
    projectId: seeded.project.id,
    agentId: seeded.agent.id,
    repoId: seeded.repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  await db.run.update({
    where: { id: seeded.run.id },
    data: { workspaceReclaimAt: new Date(), leaseExpiresAt: null },
  });
  const replacement = await db.run.create({ data: {
    projectId: seeded.project.id,
    taskId: seeded.task.id,
    agentId: seeded.agent.id,
    repoId: seeded.repo.id,
    runNumber: 2,
    dedupeKey: `task:${seeded.task.id}:run:2`,
    runner: "CLAUDE",
    runnerId: "replacement-runner",
    fencingToken: `2:${seeded.task.id}:replacement`,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    model: "claude",
    promptHash: "hash-2",
    status: RunStatus.CLAIMED,
    targetBranch: seeded.repo.defaultBranch,
    maxRunsPerTask: 5,
  } });
  await db.session.create({ data: {
    runId: replacement.id,
    projectId: seeded.project.id,
    agentId: seeded.agent.id,
    taskId: seeded.task.id,
    runner: "CLAUDE",
    executionStatus: SessionExecutionStatus.PROVISIONING,
  } });

  const holdClient = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const salvageClientBase = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let releaseHold!: () => void;
  let reportHeld!: () => void;
  let reportRepairAttempt!: () => void;
  const holdGate = new Promise<void>((resolve) => { releaseHold = resolve; });
  const held = new Promise<void>((resolve) => { reportHeld = resolve; });
  const repairAttempt = new Promise<void>((resolve) => { reportRepairAttempt = resolve; });
  let attemptReported = false;
  const reportOnce = () => {
    if (attemptReported) return;
    attemptReported = true;
    reportRepairAttempt();
  };
  const salvageClient = new Proxy(salvageClientBase, {
    get(target, property, receiver) {
      if (property !== "$transaction") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
        const instrumented = new Proxy(tx, {
          get(txTarget, txProperty, txReceiver) {
            if (txProperty === "$queryRaw") {
              return (...args: unknown[]) => {
                const query = args[0] as string[] | { strings?: string[] } | undefined;
                const sql = Array.isArray(query) ? query.join(" ") : query?.strings?.join(" ") ?? "";
                if (sql.includes('ORDER BY "chainLayer"')) reportOnce();
                return Reflect.apply(txTarget.$queryRaw, txTarget, args);
              };
            }
            if (txProperty === "run") {
              return new Proxy(txTarget.run, {
                get(runTarget, runProperty, runReceiver) {
                  if (runProperty !== "create") return Reflect.get(runTarget, runProperty, runReceiver);
                  return (...args: unknown[]) => {
                    reportOnce();
                    return Reflect.apply(runTarget.create, runTarget, args);
                  };
                },
              });
            }
            return Reflect.get(txTarget, txProperty, txReceiver);
          },
        });
        return operation(instrumented);
      }, options as any);
    },
  }) as PrismaClient;

  const salvage = `agentos/${seeded.task.id}/run-1`;
  try {
    const holding = holdClient.$transaction(async (tx) => {
      await lockChainRows(tx, { projectId: seeded.project.id, chainId });
      await tx.chainControl.create({ data: {
        projectId: seeded.project.id,
        chainId,
        state: ChainControlState.HELD,
        heldLayer: 1,
        holdGeneration: 1,
      } });
      reportHeld();
      await holdGate;
    });
    await held;
    const repairing = acknowledgeReclaimSalvage(salvageClient, {
      runnerId,
      runId: seeded.run.id,
      pushedBranch: salvage,
    });
    await repairAttempt;
    releaseHold();
    const [repair] = await Promise.all([repairing, holding]);
    assert.equal(repair, "repaired");
  } finally {
    releaseHold();
    await Promise.all([holdClient.$disconnect(), salvageClientBase.$disconnect()]);
  }

  assert.equal((await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).pushedBranch, salvage);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: replacement.id } })).status, RunStatus.CANCELLED);
  assert.equal(await db.run.count({ where: { taskId: seeded.task.id } }), 2, "Hold must bar a later-layer Run 3");
});

test("reclaim salvage acknowledgement refuses cleanup after the replacement started", async () => {
  const root = await scratchRoot("salvage-started-replacement");
  const runnerId = "runner-salvage-started";
  const seeded = await seedRun({ root, runnerId, status: "LOST", pushedBranch: null });
  await db.run.update({
    where: { id: seeded.run.id },
    data: { workspaceReclaimAt: new Date(), leaseExpiresAt: null },
  });
  const replacement = await db.run.create({ data: {
    projectId: seeded.project.id,
    taskId: seeded.task.id,
    agentId: seeded.agent.id,
    repoId: seeded.repo.id,
    runNumber: 2,
    dedupeKey: `task:${seeded.task.id}:run:2`,
    runner: "CLAUDE",
    runnerId: "replacement-runner",
    fencingToken: `2:${seeded.task.id}:replacement`,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    model: "claude",
    promptHash: "hash-2",
    status: "RUNNING",
    startedAt: new Date(),
    targetBranch: seeded.repo.defaultBranch,
    maxRunsPerTask: 5,
  } });
  const salvage = `agentos/${seeded.task.id}/run-1`;

  const response = await call(root, "/runner/workspaces/salvaged", {
    runnerId, runId: seeded.run.id, pushedBranch: salvage,
  });

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.match(String(response.body.error), /replacement already started/u);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).pushedBranch, salvage);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: replacement.id } })).targetBranch, seeded.repo.defaultBranch);
});

test("a reconciled-lost run records lease-independent cleanup failure from its owning fence", async () => {
  const root = await scratchRoot("lease-cleanup");
  const runnerId = "runner-lease-cleanup";
  const { run, fencingToken } = await seedRun({ root, runnerId, status: "RUNNING" });
  await db.run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(Date.now() - 60_000) } });
  assert.ok(await reconcileDatabaseRuns(db, new Date()) > 0);
  const lost = await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { session: true } });
  assert.equal(lost.status, "LOST");
  assert.equal(lost.runnerId, runnerId);
  assert.equal(lost.fencingToken, fencingToken);
  assert.equal(lost.session?.cleanupStatus, "PENDING");
  const response = await call(root, `/runner/runs/${run.id}/cleanup`, {
    runnerId,
    fencingToken,
    cleanupStatus: "FAILED",
    cleanupFailureReason: "WIP salvage failed after lease expiry",
    workspaceRetained: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const storedRun = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  const session = await db.session.findUniqueOrThrow({ where: { runId: run.id } });
  assert.equal(storedRun.workspaceRetained, true);
  assert.equal(session.cleanupStatus, "FAILED");
  assert.equal(session.cleanupFailureReason, "WIP salvage failed after lease expiry");
});
