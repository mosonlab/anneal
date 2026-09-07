import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import {
  activateChainSuccessor, DependencyProvisioning, FAILURE_ENVELOPE_VERSION, type FailureEnvelope,
  PrismaClient, type RunOutcome, runOwnedHead, TaskStatus,
} from "@anneal/db";
import { buildChildEnvironment } from "@anneal/runner/adapters";
import type { ClaimedTask } from "@anneal/runner/api";
import type { RunnerConfig } from "@anneal/runner/config";

import { blockedLockCount, waitForBlockedLocks } from "./blocked-locks-wait.js";
import { createApp } from "./test-app.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
import { instantiateTemplate } from "./templates.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "operator-db-token";
const RUNNER = "runner-db-token";
let db: PrismaClient;
// Provisioned by ./test-workspace-root.js above, or by whatever the caller
// exported as RUNNER_WORKSPACE_ROOT. This used to be the literal
// /private/tmp/agentos-api-dbtest-workspaces, which is a macOS-only path:
// on Linux /private is not writable and every test in this file died at
// mkdir before it reached an assertion.
const isolatedRoot = process.env.RUNNER_WORKSPACE_ROOT!;
const priorEnvironment = {
  operator: process.env.OPERATOR_TOKEN,
  runner: process.env.RUNNER_TOKEN,
  root: process.env.RUNNER_WORKSPACE_ROOT,
};
before(() => {
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  process.env.RUNNER_WORKSPACE_ROOT = isolatedRoot;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  for (const [key, value] of [["OPERATOR_TOKEN", priorEnvironment.operator], ["RUNNER_TOKEN", priorEnvironment.runner], ["RUNNER_WORKSPACE_ROOT", priorEnvironment.root]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

/** The branch the tests expect, recomputed from first principles rather than by
 *  calling `sharedChainBranch` — a function compared against itself proves
 *  nothing about the name the platform actually writes. */
const expectedBranch = (projectId: string, chainId: string): string => {
  const fingerprint = createHash("sha256").update(`${projectId}:${chainId}`).digest("hex").slice(0, 8);
  const slug = chainId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  return `agentos/chain/${slug || "chain"}-${fingerprint}`;
};

const withTokens = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  mkdirSync(isolatedRoot, { recursive: true });
  return operation();
};

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", ...(env ? { env } : {}) }).trim();

type Response = { status: number; body: any };

const operatorRequest = async (path: string, init: RequestInit = {}): Promise<Response> => withTokens(async () => {
  const response = await createApp(db).request(path, {
    ...init,
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json", ...init.headers },
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
});

const postTask = async (projectId: string, body: Record<string, unknown>): Promise<Response> =>
  operatorRequest(`/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify(body) });

const settleChainStep = async (taskId: string, advance: boolean): Promise<void> => {
  const task = await db.task.update({ where: { id: taskId }, data: { status: TaskStatus.DONE } });
  if (advance) await db.$transaction((tx) => activateChainSuccessor(tx, task, {}, new Date()));
};

/** Claims whatever run the control plane hands out, asserting it is the one the
 *  test expects. Going through the real route matters: the claim payload is
 *  assembled from live rows, which is where a queued run's snapshot could leak. */
const claimRun = async (expectedRunId?: string): Promise<any> => withTokens(async () => {
  const response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "runner-1" }),
  });
  assert.equal(response.status, 200, "expected a claimable run");
  const claim = await response.json() as any;
  if (expectedRunId) assert.equal(claim.run.id, expectedRunId);
  return claim;
});

/**
 * Drives a run to completion through the real `POST /runner/runs/:runId/complete`
 * so `activateChainSuccessor` and the automatic-retry path run exactly as they do
 * in production. Hand-writing terminal Run rows would advance the chain around
 * the routes this batch changes.
 */
// The verdict a completion carries is one value, so a failing step in this file
// names the failure it is modelling rather than restating six fields. The
// envelope holds only facts; the class beside each one is what `classifyEnvelope`
// reads out of them.
const failedEnvelope = (overrides: Partial<FailureEnvelope> = {}): FailureEnvelope => ({
  version: FAILURE_ENVELOPE_VERSION,
  phase: "EXECUTE",
  runnerClass: null,
  exitCode: 1,
  signal: null,
  terminationReason: null,
  terminalEventSeen: true,
  terminalSuccess: false,
  agentExited: true,
  providerError: null,
  stderrSummary: "the agent reported a failure",
  stdoutSummary: null,
  timedOut: false,
  transient: false,
  timeoutMs: null,
  ...overrides,
});

/** The agent itself failed: TASK_FAILED, not retryable, and it spends the attempt. */
const agentFailure: RunOutcome = {
  case: "provider-failure",
  reason: "the agent reported a failure",
  envelope: failedEnvelope(),
};

/** A dropped provider connection: TRANSIENT_PROVIDER, retried automatically. */
const transientFailure: RunOutcome = {
  case: "provider-failure",
  reason: "the provider connection dropped",
  envelope: failedEnvelope({ transient: true, stderrSummary: "read ECONNRESET" }),
};

const completeRunViaRoute = async (claim: any, overrides: Record<string, unknown> = {}): Promise<Response> => withTokens(async () => {
  const response = await createApp(db).request(`/runner/runs/${claim.run.id}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: "runner-1",
      fencingToken: claim.fencingToken,
      exitCode: 0,
      outcome: { case: "succeeded" },
      cleanupStatus: "SUCCEEDED",
      ...overrides,
    }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
});

const publishViaRoute = async (claim: any, pushedBranch: string): Promise<Response> => withTokens(async () => {
  const response = await createApp(db).request(`/runner/runs/${claim.run.id}/publication`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "runner-1", fencingToken: claim.fencingToken, pushedBranch }),
  });
  return { status: response.status, body: await response.json() };
});

const startRunViaRoute = async (claim: any, branch: string): Promise<Response> => withTokens(async () => {
  const response = await createApp(db).request(`/runner/runs/${claim.run.id}/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: "runner-1",
      fencingToken: claim.fencingToken,
      adapterVersion: "test-adapter",
      cliVersion: "test-cli",
      promptHash: "a".repeat(64),
      manifest: {},
      workspacePath: `${isolatedRoot}/${claim.run.id}`,
      branch,
    }),
  });
  return { status: response.status, body: await response.json() };
});

/** Claim the queued run of `taskId` and finish it, optionally publishing a ref. */
const runStep = async (taskId: string, overrides: Record<string, unknown> = {}): Promise<void> => {
  const queued = await db.run.findFirstOrThrow({ where: { taskId, status: "QUEUED" }, orderBy: { runNumber: "desc" } });
  const claim = await claimRun(queued.id);
  const result = await completeRunViaRoute(claim, overrides);
  assert.equal(result.status, 200);
};

const seedProject = async (label: string) => {
  const project = await db.project.create({ data: { name: label, slug: `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE",
  } });
  return { project, agent, repo };
};

/** Direct insertion remains useful for malformed-row and retry edge cases. The
 * central chain test below deliberately creates every normal step through the
 * public API so it cannot evade admission behavior. */
const seedChainStep = async (
  seed: { project: { id: string }; agent: { id: string }; repo: { id: string } },
  chainId: string,
  chainIndex: number,
  data: Record<string, unknown> = {},
) => db.task.create({ data: {
  projectId: seed.project.id, assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  name: `Step ${chainIndex}`, description: `step ${chainIndex}`, chainId, chainIndex, chainLayer: chainIndex, ...data,
} });

/** `POST /tasks/:id/start` answers `{ runId, runNumber }`, so the row itself has
 *  to be read back — and reading the row is the point: every assertion in this
 *  file is on what the control plane wrote, never on what a helper returned. */
const startStep = async (taskId: string) => {
  const started = await operatorRequest(`/tasks/${taskId}/start`, { method: "POST" });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  return db.run.findUniqueOrThrow({ where: { id: started.body.runId } });
};

// --- WI-3: one branch per chain ---------------------------------------------

test("T1: every run of every step of an API-created chain sits on one branch", async () => {
  // Exactly one PR per chain is proven by composition, not by a test — no test
  // in this repo may call GitHub. One branch per chain (this test) ×
  // `deliverWorkspace` reuses any open PR on that head ("a chain step reuses the
  // open pull request on its shared head branch", delivery.test.ts) × a step
  // with opensPullRequest=false never calls `gh pr create` (delivery.test.ts)
  // ⇒ at most one `gh pr create` per chain, and one open PR per head branch is
  // a GitHub invariant.
  const seed = await seedProject("t1");
  const chainId = `chain-${Date.now()}`;
  const shared = expectedBranch(seed.project.id, chainId);

  const first = await postTask(seed.project.id, {
    name: "Step 0", description: "step 0", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 0,
  });
  assert.equal(first.status, 201);
  const second = await postTask(seed.project.id, {
    name: "Step 1", description: "step 1", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 1,
  });
  const third = await postTask(seed.project.id, {
    name: "Step 2", description: "step 2", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 2,
  });
  assert.equal(second.status, 201);
  assert.equal(third.status, 201);
  assert.equal(await db.run.count({ where: { task: { chainId } } }), 1, "only the head step is admitted initially");
  await runStep(first.body.id, { pushedBranch: shared });
  await runStep(second.body.id, { pushedBranch: shared });
  await runStep(third.body.id, { pushedBranch: shared });

  const runs = await db.run.findMany({ where: { taskId: { in: [first.body.id, second.body.id, third.body.id] } } });
  assert.equal(runs.length, 3, "each step ran exactly once");
  assert.deepEqual([...new Set(runs.map((run) => run.branch))], [shared]);
});

test("T2: the base branch follows the chain, not the task", async () => {
  const seed = await seedProject("t2");
  const chainId = `chain-${Date.now()}`;
  const shared = expectedBranch(seed.project.id, chainId);

  const first = await postTask(seed.project.id, {
    name: "Step 0", description: "step 0", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 0,
  });
  const second = await seedChainStep(seed, chainId, 1);
  const third = await seedChainStep(seed, chainId, 2);
  // Step ① creates the branch, so it must base on something that exists.
  const firstRun = await db.run.findFirstOrThrow({ where: { taskId: first.body.id } });
  assert.equal(firstRun.targetBranch, seed.repo.defaultBranch);
  assert.equal(firstRun.branch, shared);

  await runStep(first.body.id, { pushedBranch: shared });
  const secondRun = await db.run.findFirstOrThrow({ where: { taskId: second.id } });
  assert.equal(secondRun.targetBranch, shared, "step ② reviews step ①'s tree without anyone repointing it");

  await runStep(second.id, { pushedBranch: shared });
  const thirdRun = await db.run.findFirstOrThrow({ where: { taskId: third.id } });
  assert.equal(thirdRun.targetBranch, shared);
});

test("T3: a failed run's WIP salvage push is the successor's durable clone base", async () => {
  // The payload below is exactly what the runner emits after a WIP salvage:
  // `branch` is the workspace branch (the shared one), `pushStatus` is SUCCEEDED
  // — and `deliverFailedWorkspace` pushed `agentos/<taskId>/run-<n>` instead.
  // Inferring publication from `branch` + `pushStatus` would send step ② to
  // clone a ref nobody ever created. `pushedBranch` names the durable salvage
  // ref that the successor must actually clone.
  const seed = await seedProject("t3");
  const chainId = `chain-${Date.now()}`;
  const shared = expectedBranch(seed.project.id, chainId);

  const first = await postTask(seed.project.id, {
    name: "Step 0", description: "step 0", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 0,
  });
  const second = await seedChainStep(seed, chainId, 1);
  const firstRun = await db.run.findFirstOrThrow({ where: { taskId: first.body.id } });
  await runStep(first.body.id, {
    exitCode: 1,
    outcome: agentFailure,
    branch: shared,
    pushStatus: "SUCCEEDED",
    pushedBranch: `agentos/${first.body.id}/run-1`,
  });
  const closed = await db.run.findUniqueOrThrow({ where: { id: firstRun.id } });
  assert.equal(closed.branch, shared, "the misleading column is still written; the test is about not trusting it");
  assert.equal(closed.pushStatus, "SUCCEEDED");

  // This test owns branch selection, not the operator status boundary. Model
  // the machine-owned terminal state and run normal chain advancement.
  await settleChainStep(first.body.id, true);
  const secondRun = await db.run.findFirstOrThrow({ where: { taskId: second.id, status: "QUEUED" } });
  assert.equal(secondRun.targetBranch, `agentos/${first.body.id}/run-1`);
  assert.notEqual(secondRun.targetBranch, shared);
  assert.equal(secondRun.branch, shared, "the successor still publishes the declared chain branch");
});

test("T4: the first step of a chain that has published nothing bases on the default branch", async () => {
  const seed = await seedProject("t4");
  const chainId = `chain-${Date.now()}`;
  const shared = expectedBranch(seed.project.id, chainId);
  const first = await postTask(seed.project.id, {
    name: "Step 0", description: "step 0", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 0,
  });

  await runStep(first.body.id, {
    exitCode: 1, outcome: agentFailure, pushStatus: "FAILED",
  });
  const retried = await operatorRequest(`/tasks/${first.body.id}/retry`, { method: "POST" });
  assert.equal(retried.status, 201);
  assert.equal(retried.body.targetBranch, seed.repo.defaultBranch);
  assert.equal(retried.body.branch, shared);
});

test("T5: two projects sharing one chainId get two branches", async () => {
  // @@unique([chainId, chainIndex]) is global rather than per-project, so the
  // collision can only be written at disjoint indices — which is exactly the
  // case the (projectId, chainId) key exists for.
  const one = await seedProject("t5a");
  const two = await seedProject("t5b");
  const chainId = `shared-${Date.now()}`;
  const branchOne = expectedBranch(one.project.id, chainId);
  const branchTwo = expectedBranch(two.project.id, chainId);
  assert.notEqual(branchOne, branchTwo);

  const first = await postTask(one.project.id, {
    name: "P1 S0", description: "d", assigneeAgentId: one.agent.id, repoId: one.repo.id, chainId, chainIndex: 0,
  });
  const other = await postTask(two.project.id, {
    name: "P2 S0", description: "d", assigneeAgentId: two.agent.id, repoId: two.repo.id, chainId, chainIndex: 11,
  });
  const runOne = await db.run.findFirstOrThrow({ where: { taskId: first.body.id } });
  const runTwo = await startStep(other.body.id);
  assert.equal(runOne.branch, branchOne);
  assert.equal(runTwo.branch, branchTwo);

  // …and neither project's evidence query may see the other's publication.
  await runStep(first.body.id, { pushedBranch: branchOne });
  await runStep(other.body.id);
  const second = await seedChainStep(two, chainId, 12);
  const secondRun = await startStep(second.id);
  assert.equal(secondRun.targetBranch, two.repo.defaultBranch, "project 1's push is not project 2's evidence");
});

test("T6: a template chain still uses agentos/<chainId>, and a branchName override still wins", async () => {
  const seed = await seedProject("t6");
  const template = await db.taskTemplate.create({ data: {
    projectId: seed.project.id, name: "tmpl", description: "t", variables: [],
    steps: { create: [0, 1, 2].map((index) => ({
      stepIndex: index, layer: index, name: `Step ${index}`, assigneeType: "AGENT" as const, assigneeAgentId: seed.agent.id, prompt: `do ${index}`,
    })) },
  } });
  const chain = await instantiateTemplate(db, seed.project.id, template.id, { repoId: seed.repo.id, variables: {}, autoStart: true, name: "T6 chain" });
  const firstRun = await db.run.findFirstOrThrow({ where: { taskId: chain.tasks[0]!.id } });
  assert.equal(firstRun.branch, `agentos/${chain.chainId}`, "the derived chain name must not leak into template chains");
  assert.equal(firstRun.targetBranch, seed.repo.defaultBranch);

  await runStep(chain.tasks[0]!.id);
  const secondRun = await db.run.findFirstOrThrow({ where: { taskId: chain.tasks[1]!.id } });
  assert.equal(secondRun.branch, `agentos/${chain.chainId}`);
  assert.equal(secondRun.targetBranch, `agentos/${chain.chainId}`);

  // The `branchName` override is a declared template variable, and it still wins
  // over both the template default and anything this batch derives.
  const overridable = await db.taskTemplate.create({ data: {
    projectId: seed.project.id, name: "tmpl-branch", description: "t", variables: ["branchName"],
    steps: { create: [0, 1].map((index) => ({
      stepIndex: index, layer: index, name: `Step ${index}`, assigneeType: "AGENT" as const, assigneeAgentId: seed.agent.id, prompt: `do ${index}`,
    })) },
  } });
  const custom = await instantiateTemplate(db, seed.project.id, overridable.id, {
    repoId: seed.repo.id, variables: { branchName: "custom/branch" }, autoStart: true, name: "T6 custom branch",
  });
  const customRun = await db.run.findFirstOrThrow({ where: { taskId: custom.tasks[0]!.id } });
  assert.equal(customRun.branch, "custom/branch");
});

test("T6b: a deferred template start preserves its custom head and successor base", async () => {
  const seed = await seedProject("t6b");
  const template = await db.taskTemplate.create({ data: {
    projectId: seed.project.id, name: "deferred-template", description: "t", variables: ["branchName"],
    steps: { create: [0, 1].map((index) => ({
      stepIndex: index, layer: index, name: `Step ${index}`, assigneeType: "AGENT" as const,
      assigneeAgentId: seed.agent.id, prompt: `do ${index}`,
    })) },
  } });
  const chain = await instantiateTemplate(db, seed.project.id, template.id, {
    repoId: seed.repo.id, variables: { branchName: "custom/deferred" }, autoStart: false, name: "T6b deferred",
  });
  assert.equal(await db.run.count({ where: { task: { chainId: chain.chainId } } }), 0);

  const firstRun = await startStep(chain.tasks[0]!.id);
  assert.equal(firstRun.branch, "custom/deferred");
  assert.equal(firstRun.targetBranch, seed.repo.defaultBranch);

  const claim = await claimRun(firstRun.id);
  const publication = await publishViaRoute(claim, "custom/deferred");
  assert.equal(publication.status, 200);
  const completion = await completeRunViaRoute(claim);
  assert.equal(completion.status, 200);

  const secondRun = await db.run.findFirstOrThrow({ where: { taskId: chain.tasks[1]!.id } });
  assert.equal(secondRun.branch, "custom/deferred");
  assert.equal(secondRun.targetBranch, "custom/deferred");
});

test("T7: an operator's targetBranch on a chain step is ignored, and the run says so once", async () => {
  const seed = await seedProject("t7");
  const chainId = `chain-${Date.now()}`;
  const shared = expectedBranch(seed.project.id, chainId);
  const first = await postTask(seed.project.id, {
    name: "Step 0", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 0,
  });
  await runStep(first.body.id, { pushedBranch: shared });

  // The shape an operator repoints by hand today: step ⑦ aimed at step ①'s run branch.
  const seventh = await seedChainStep(seed, chainId, 6, { targetBranch: `agentos/${first.body.id}/run-1` });
  const seventhRun = await startStep(seventh.id);
  assert.equal(seventhRun.targetBranch, shared);
  assert.equal(seventhRun.branch, shared);

  const notices = await db.taskActivity.findMany({ where: { taskId: seventh.id } });
  const ignored = notices.filter((row) => /is not used for chain steps/.test(row.body));
  assert.equal(ignored.length, 1, "said once per run — silently ignoring an operator's value is the footgun");
  assert.match(ignored[0]!.body, new RegExp(shared.replace(/\//g, "\\/")));
});

test("T7b: a later chain claim retains the first run's custom PR base", async () => {
  const seed = await seedProject("t7b");
  const chainId = `chain-${Date.now()}`;
  const shared = expectedBranch(seed.project.id, chainId);
  const first = await postTask(seed.project.id, {
    name: "Step 0", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
    chainId, chainIndex: 0, targetBranch: "release/1.x",
  });
  const second = await postTask(seed.project.id, {
    name: "Step 1", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
    chainId, chainIndex: 1,
  });
  await runStep(first.body.id, { pushedBranch: shared });
  const secondRun = await db.run.findFirstOrThrow({ where: { taskId: second.body.id } });
  const claim = await claimRun(secondRun.id);
  assert.equal(claim.run.targetBranch, shared);
  assert.equal(claim.run.pullRequestBase, "release/1.x");
});

test("T8: a partial chain identity is rejected before branch resolution", async () => {
  const seed = await seedProject("t8");
  const chainId = `chain-${Date.now()}`;
  const shared = expectedBranch(seed.project.id, chainId);
  const indexed = await postTask(seed.project.id, {
    name: "Indexed", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 0,
  });
  await runStep(indexed.body.id, { pushedBranch: shared });

  await assert.rejects(
    () => db.task.create({ data: {
      projectId: seed.project.id, assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
      name: "No index", description: "d", chainId, chainIndex: null,
    } }),
    /Task_chain_identity_all_or_none_check/u,
  );
});

test("T15: two repos in one chain each need their own published branch", async () => {
  // Spec R2: one chain's steps may sit on different repos; the same branch name
  // on two remotes is two unrelated refs. A push in repo A is not evidence that
  // repo B has the ref, and a step that clones it there fails in provisioning.
  const seed = await seedProject("t15");
  const repoB = await db.repo.create({ data: {
    projectId: seed.project.id, name: "repo-b", remoteUrl: "https://example.test/repo-b.git", mountPath: "/repo-b",
    defaultBranch: "trunk",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: seed.project.id, agentId: seed.agent.id, repoId: repoB.id, mountPath: "/repo-b", permissions: "GIT_WRITE",
  } });
  const chainId = `chain-${Date.now()}`;
  const shared = expectedBranch(seed.project.id, chainId);

  const onA = await postTask(seed.project.id, {
    name: "On A", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 0,
  });
  await runStep(onA.body.id, { pushedBranch: shared });

  const onB = await seedChainStep(seed, chainId, 1, { repoId: repoB.id });
  const runB = await startStep(onB.id);
  assert.equal(runB.targetBranch, repoB.defaultBranch, "repo A's push is not repo B's evidence");
  assert.equal(runB.branch, shared, "same name on both remotes; different refs");

  // Once repo B has it too, a later repo-B step does base on it.
  await runStep(onB.id, { pushedBranch: shared });
  const laterB = await seedChainStep(seed, chainId, 2, { repoId: repoB.id });
  assert.equal((await startStep(laterB.id)).targetBranch, shared);
});

test("T16: a pull-request failure after a successful push still counts as publication", async () => {
  // delivery.ts pushes first; any later `gh` error is reported as
  // pushStatus FAILED with the ref already on the remote. The API may queue a
  // plumbing retry, but that retry still targets the same published branch.
  // Adding `status` or `pushStatus` back into the evidence predicate re-breaks
  // this: step ② would base on the default branch, recreate the already-
  // published shared name locally, and have its push rejected non-fast-forward.
  const seed = await seedProject("t16");
  const chainId = `chain-${Date.now()}`;
  const shared = expectedBranch(seed.project.id, chainId);
  const first = await postTask(seed.project.id, {
    name: "Step 0", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 0,
  });
  const firstRun = await db.run.findFirstOrThrow({ where: { taskId: first.body.id } });

  await runStep(first.body.id, {
    exitCode: 0,
    // The agent exited cleanly and delivery is what failed, so this is a
    // DELIVER envelope: the "exit 0 without a terminal event" protocol rule is
    // about the agent process and does not apply here.
    outcome: {
      case: "provider-failure",
      reason: "the pull request could not be opened",
      envelope: failedEnvelope({
        phase: "DELIVER",
        runnerClass: "TOOL_FAILED",
        exitCode: 0,
        terminalSuccess: true,
        stderrSummary: "the pull request could not be opened",
      }),
    } satisfies RunOutcome,
    branch: shared,
    pushStatus: "FAILED",
    pushError: "gh: API rate limit exceeded",
    pushedBranch: shared,
  });
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: firstRun.id } })).status, "FAILED");

  // The successor is created below, so only the machine-owned terminal state
  // is needed here; its manual start still proves the durable branch base.
  await settleChainStep(first.body.id, false);

  const second = await seedChainStep(seed, chainId, 1);
  assert.equal((await startStep(second.id)).targetBranch, shared, "the branch is on the remote whatever gh did");
});

// --- WI-4: POST /tasks -------------------------------------------------------

test("T9: a non-chain task's first run publishes the ref that run owns", async () => {
  const seed = await seedProject("t9");
  const explicit = await postTask(seed.project.id, {
    name: "Solo", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, targetBranch: "some/branch",
  });
  const explicitRun = await db.run.findFirstOrThrow({ where: { taskId: explicit.body.id } });
  assert.equal(explicitRun.targetBranch, "some/branch");
  // The control plane declares the head at birth, so the runner never has to
  // invent one and the column carries a single fact.
  assert.equal(explicitRun.branch, runOwnedHead(explicit.body.id, 1));

  const implicit = await postTask(seed.project.id, {
    name: "Solo 2", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  const implicitRun = await db.run.findFirstOrThrow({ where: { taskId: implicit.body.id } });
  assert.equal(implicitRun.targetBranch, seed.repo.defaultBranch);
  assert.equal(implicitRun.branch, runOwnedHead(implicit.body.id, 1));
});

// --- WI-5: operator retry and lost-lease requeue -----------------------------

test("T10: an operator retry lands on the shared branch", async () => {
  const seed = await seedProject("t10");
  const chainId = `chain-${Date.now()}`;
  const shared = expectedBranch(seed.project.id, chainId);
  const first = await postTask(seed.project.id, {
    name: "Step 0", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 0,
  });
  const second = await seedChainStep(seed, chainId, 1);
  await runStep(first.body.id, { pushedBranch: shared });

  await runStep(second.id, {
    exitCode: 1, outcome: agentFailure, pushStatus: "FAILED",
  });
  const retried = await operatorRequest(`/tasks/${second.id}/retry`, { method: "POST" });
  assert.equal(retried.status, 201);
  assert.equal(retried.body.branch, shared);
  assert.equal(retried.body.targetBranch, shared);
});

test("an operator-retried template step publishes its declared head from the latest salvage base", async () => {
  const seed = await seedProject("operator-template-salvage");
  const template = await db.taskTemplate.create({ data: {
    projectId: seed.project.id, name: "operator-template", description: "t", variables: [],
    steps: { create: [0, 1].map((stepIndex) => ({
      stepIndex, layer: stepIndex, name: `Step ${stepIndex}`, assigneeType: "AGENT" as const,
      assigneeAgentId: seed.agent.id, prompt: `do ${stepIndex}`,
    })) },
  } });
  const chain = await instantiateTemplate(db, seed.project.id, template.id, {
    repoId: seed.repo.id, variables: {}, autoStart: true, name: "operator template salvage",
  });
  const task = chain.tasks[0]!;
  const declared = `agentos/${chain.chainId}`;
  const salvage = `agentos/${task.id}/run-1`;
  await runStep(task.id, {
    exitCode: 1, outcome: agentFailure,
    branch: salvage, pushStatus: "SUCCEEDED", pushedBranch: salvage,
  });

  const retried = await operatorRequest(`/tasks/${task.id}/retry`, { method: "POST" });
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.equal(retried.body.branch, declared);
  assert.equal(retried.body.targetBranch, salvage);
  const retryRow = await db.run.findFirstOrThrow({ where: { taskId: task.id, runNumber: 2 } });
  assert.equal((await claimRun(retryRow.id)).run.targetBranchPublished, true);
});

test("a successor first run clones the predecessor's salvage publication", async () => {
  const seed = await seedProject("successor-salvage");
  const template = await db.taskTemplate.create({ data: {
    projectId: seed.project.id, name: "successor-template", description: "t", variables: [],
    steps: { create: [0, 1].map((stepIndex) => ({
      stepIndex, layer: stepIndex, name: `Step ${stepIndex}`, assigneeType: "AGENT" as const,
      assigneeAgentId: seed.agent.id, prompt: `do ${stepIndex}`,
    })) },
  } });
  const chain = await instantiateTemplate(db, seed.project.id, template.id, {
    repoId: seed.repo.id, variables: {}, autoStart: true, name: "successor salvage",
  });
  const first = chain.tasks[0]!;
  const second = chain.tasks[1]!;
  const salvage = `agentos/${first.id}/run-1`;
  await runStep(first.id, { pushedBranch: salvage });

  const successor = await db.run.findFirstOrThrow({ where: { taskId: second.id, runNumber: 1 } });
  assert.equal(successor.branch, `agentos/${chain.chainId}`);
  assert.equal(successor.targetBranch, salvage);
  assert.equal((await claimRun(successor.id)).run.targetBranchPublished, true);
});

test("T11: a post-push publication ACK survives lease loss and bases the retry on the shared branch", async () => {
  const seed = await seedProject("t11");
  const chainId = `chain-${Date.now()}`;
  const shared = expectedBranch(seed.project.id, chainId);
  const first = await postTask(seed.project.id, {
    name: "Step 0", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 0,
  });
  const run = await db.run.findFirstOrThrow({ where: { taskId: first.body.id } });
  const claim = await claimRun(run.id);
  const published = await publishViaRoute(claim, shared);
  assert.equal(published.status, 200);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).pushedBranch, shared);
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", leaseExpiresAt: new Date(Date.now() - 60_000), heartbeatAt: null,
  } });

  assert.ok(await reconcileDatabaseRuns(db, new Date()) > 0);
  const requeued = await db.run.findFirstOrThrow({ where: { taskId: first.body.id, runNumber: 2 } });
  assert.equal(requeued.branch, shared);
  assert.equal(requeued.targetBranch, shared, "the ACK is durable before terminal completion");
});

test("a lost run may ACK only its exact salvage ref after lease expiry", async () => {
  const seed = await seedProject("late-salvage-ack");
  const task = await postTask(seed.project.id, {
    name: "Lost", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  const run = await db.run.findFirstOrThrow({ where: { taskId: task.body.id } });
  const claim = await claimRun(run.id);
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", leaseExpiresAt: new Date(Date.now() - 60_000), heartbeatAt: null,
  } });
  await reconcileDatabaseRuns(db, new Date());
  const queuedBeforeAck = await db.run.findFirstOrThrow({ where: { taskId: task.body.id, runNumber: 2 } });
  assert.equal(queuedBeforeAck.targetBranch, seed.repo.defaultBranch);

  const arbitrary = await publishViaRoute(claim, "some/arbitrary-head");
  assert.equal(arbitrary.status, 409);
  const salvage = `agentos/${task.body.id}/run-1`;
  const accepted = await publishViaRoute(claim, salvage);
  assert.equal(accepted.status, 200);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).pushedBranch, salvage);
  const repaired = await db.run.findUniqueOrThrow({ where: { id: queuedBeforeAck.id } });
  assert.equal(repaired.targetBranch, salvage);
});

test("late salvage revokes and repairs a replacement claimed before start", async () => {
  const seed = await seedProject("late-salvage-vs-claim");
  const task = await postTask(seed.project.id, {
    name: "Lost", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  const run = await db.run.findFirstOrThrow({ where: { taskId: task.body.id } });
  const lostClaim = await claimRun(run.id);
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", leaseExpiresAt: new Date(Date.now() - 60_000), heartbeatAt: null,
  } });
  const reconciledAt = new Date();
  await reconcileDatabaseRuns(db, reconciledAt);
  const replacement = await db.run.findFirstOrThrow({ where: { taskId: task.body.id, runNumber: 2 } });
  assert.ok(replacement.readyAt.getTime() > reconciledAt.getTime(), "lease-loss replacement waits for backoff");
  await db.run.update({ where: { id: replacement.id }, data: { readyAt: new Date(0) } });
  const staleClaim = await claimRun(replacement.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: replacement.id } })).status, "CLAIMED");

  const salvage = `agentos/${task.body.id}/run-1`;
  const accepted = await publishViaRoute(lostClaim, salvage);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.replacementRepair, "requeued");
  const invalidated = await db.run.findUniqueOrThrow({ where: { id: replacement.id } });
  assert.equal(invalidated.status, "CANCELLED");
  assert.equal(invalidated.runnerId, "runner-1", "the stale runner retains cleanup ownership for its distinct workspace");
  const repaired = await db.run.findFirstOrThrow({ where: { taskId: task.body.id, runNumber: 3 } });
  assert.equal(repaired.status, "QUEUED");
  assert.equal(repaired.targetBranch, salvage);
  assert.notEqual(repaired.id, replacement.id);
  assert.equal((await startRunViaRoute(staleClaim, "stale/head")).status, 409, "the revoked claim must not start");
});

test("T12: a non-chain requeue is unchanged", async () => {
  const seed = await seedProject("t12");
  const solo = await postTask(seed.project.id, {
    name: "Solo", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, targetBranch: "some/branch",
  });
  const run = await db.run.findFirstOrThrow({ where: { taskId: solo.body.id } });
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", leaseExpiresAt: new Date(Date.now() - 60_000), heartbeatAt: null,
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: seed.project.id, agentId: seed.agent.id, taskId: solo.body.id,
    runner: "CLAUDE", executionStatus: "RUNNING",
  } });

  await reconcileDatabaseRuns(db, new Date());
  const requeued = await db.run.findFirstOrThrow({ where: { taskId: solo.body.id, runNumber: 2 } });
  assert.equal(requeued.targetBranch, "some/branch");
  assert.equal(requeued.branch, runOwnedHead(solo.body.id, 1), "a lost lease keeps the head its run was told to publish");
});

test("T12c: a lost-lease requeue drops a base that is only this run's unpushed head", async () => {
  // A run created before this fix carries `branch === targetBranch ===` a ref
  // no remote has. Requeueing it verbatim is how the issue #118 clone loop
  // survived a lease loss: every attempt cloned the same missing ref.
  const seed = await seedProject("t12c");
  const solo = await postTask(seed.project.id, {
    name: "Solo", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  const run = await db.run.findFirstOrThrow({ where: { taskId: solo.body.id } });
  const poisoned = `agentos/${solo.body.id}/run-1`;
  await db.run.update({ where: { id: run.id }, data: {
    branch: poisoned, targetBranch: poisoned,
    status: "RUNNING", leaseExpiresAt: new Date(Date.now() - 60_000), heartbeatAt: null,
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: seed.project.id, agentId: seed.agent.id, taskId: solo.body.id,
    runner: "CLAUDE", executionStatus: "RUNNING",
  } });

  await reconcileDatabaseRuns(db, new Date());
  const requeued = await db.run.findFirstOrThrow({ where: { taskId: solo.body.id, runNumber: 2 } });
  assert.notEqual(requeued.targetBranch, poisoned, "cloning this would burn the run again");
  assert.equal(requeued.targetBranch, seed.repo.defaultBranch);
  assert.equal(requeued.branch, poisoned, "the head snapshot is kept; only the base falls back");
});

test("T12a: an operator retry never bases on a run branch that was never pushed", async () => {
  // The production shape of issue #118 (runs cmsy9kg5j0001mp76wb95xiyu,
  // cmsya108b00eqmp767igidbmb, cmsyaa0nk00oqmp760jc7693a): a non-chain run
  // reports the workspace branch it created, its push fails, and the retry
  // inherited that branch as its *base* — so provisioning cloned a ref no
  // remote had and the run died in `git clone` about two minutes in.
  const seed = await seedProject("t12a");
  const solo = await postTask(seed.project.id, {
    name: "Solo", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  const workspaceBranch = `agentos/${solo.body.id}/run-1`;
  await runStep(solo.body.id, {
    exitCode: 1, outcome: agentFailure,
    branch: workspaceBranch, pushStatus: "FAILED",
  });
  const failed = await db.run.findFirstOrThrow({ where: { taskId: solo.body.id, runNumber: 1 } });
  assert.equal(failed.branch, workspaceBranch, "the misleading column is still written");
  assert.equal(failed.pushedBranch, null, "nothing was published");

  const retried = await operatorRequest(`/tasks/${solo.body.id}/retry`, { method: "POST" });
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.notEqual(retried.body.targetBranch, workspaceBranch, "cloning this would burn the run");
  assert.equal(retried.body.targetBranch, seed.repo.defaultBranch);
  assert.equal(retried.body.branch, workspaceBranch, "the head keeps its name; only the base falls back");
});

test("T12b: an operator retry bases on the WIP salvage the failed run did publish", async () => {
  const seed = await seedProject("t12b");
  const solo = await postTask(seed.project.id, {
    name: "Solo", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  const workspaceBranch = `agentos/${solo.body.id}/run-1`;
  const salvage = `agentos/${solo.body.id}/run-2`;
  await runStep(solo.body.id, {
    exitCode: 1, outcome: agentFailure,
    branch: workspaceBranch, pushStatus: "FAILED",
  });
  const second = await operatorRequest(`/tasks/${solo.body.id}/retry`, { method: "POST" });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  // Run 2 fails too, but deliverFailedWorkspace salvages its tree to its own
  // per-run ref while `branch` still reports the workspace's (delivery.ts).
  await runStep(solo.body.id, {
    exitCode: 1, outcome: agentFailure,
    branch: workspaceBranch, pushStatus: "SUCCEEDED", pushedBranch: salvage,
  });

  const third = await operatorRequest(`/tasks/${solo.body.id}/retry`, { method: "POST" });
  assert.equal(third.status, 201, JSON.stringify(third.body));
  assert.equal(third.body.targetBranch, salvage, "run 2's work reached the remote and must not be thrown away");
  assert.equal(third.body.branch, workspaceBranch);
});

// --- WI-6: the automatic retry inside the completion transaction -------------

test("T13b: an upgrade-state template retry returns to its chain head", async () => {
  const seed = await seedProject("template-retry");
  const template = await db.taskTemplate.create({ data: {
    projectId: seed.project.id, name: "retry-template", description: "t", variables: [],
    steps: { create: [0, 1].map((index) => ({
      stepIndex: index, layer: index, name: `Step ${index}`, assigneeType: "AGENT" as const,
      assigneeAgentId: seed.agent.id, prompt: `do ${index}`,
    })) },
  } });
  const chain = await instantiateTemplate(db, seed.project.id, template.id, {
    repoId: seed.repo.id, variables: {}, autoStart: true, name: "template retry",
  });
  const chainBranch = `agentos/${chain.chainId}`;
  const firstTask = chain.tasks[0]!;
  const firstRun = await db.run.findFirstOrThrow({ where: { taskId: firstTask.id, runNumber: 1 } });
  // Reproduce a retry queued before the fix: it had no branch, so provisioning
  // selected a per-run fallback and the start route persisted that workspace
  // branch before completion read the row.
  await db.run.update({ where: { id: firstRun.id }, data: { branch: null } });
  const failedClaim = await claimRun(firstRun.id);
  const workspaceBranch = `agentos/${firstTask.id}/run-1`;
  assert.equal((await startRunViaRoute(failedClaim, workspaceBranch)).status, 200);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: firstRun.id } })).branch, workspaceBranch);

  const salvageBranch = `agentos/${firstTask.id}/run-2`;
  const failed = await completeRunViaRoute(failedClaim, {
    exitCode: 1, outcome: transientFailure,
    branch: workspaceBranch, pushStatus: "SUCCEEDED", pushedBranch: salvageBranch,
  });
  assert.equal(failed.status, 200);

  const retry = await db.run.findFirstOrThrow({ where: { taskId: firstTask.id, runNumber: 2 } });
  assert.equal(retry.branch, chainBranch, "the retry publishes where its successor will clone");
  assert.equal(retry.targetBranch, salvageBranch, "same-transaction WIP evidence still decides the base");

  await db.run.update({ where: { id: retry.id }, data: { readyAt: new Date(0) } });
  const retryClaim = await claimRun(retry.id);
  assert.equal((await publishViaRoute(retryClaim, chainBranch)).status, 200);
  assert.equal((await completeRunViaRoute(retryClaim)).status, 200);
  const publishedRetry = await db.run.findUniqueOrThrow({ where: { id: retry.id } });
  assert.equal(publishedRetry.pushedBranch, chainBranch);
});

test("T13: an automatic retry of a chain step stays on the shared branch", async () => {
  const seed = await seedProject("t13");
  const chainId = `chain-${Date.now()}`;
  const shared = expectedBranch(seed.project.id, chainId);
  const first = await postTask(seed.project.id, {
    name: "Step 0", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, chainId, chainIndex: 0,
  });
  // A transient failure: no operator involved, and this is the path a chain hits
  // most often. Before this batch it copied targetBranch and carried no branch,
  // so the retry silently left the chain's tree.
  await runStep(first.body.id, {
    exitCode: 1, outcome: transientFailure, pushStatus: "FAILED",
  });
  const retry = await db.run.findFirstOrThrow({ where: { taskId: first.body.id, runNumber: 2 } });
  assert.equal(retry.branch, shared);
  assert.equal(retry.targetBranch, seed.repo.defaultBranch, "nothing published yet");

  // …and once a step of the chain has published, the automatic retry bases on it.
  await db.run.update({ where: { id: retry.id }, data: { readyAt: new Date(0) } });
  await runStep(first.body.id);
  const second = await seedChainStep(seed, chainId, 1);
  await startStep(second.id);
  await runStep(second.id, {
    exitCode: 1, outcome: transientFailure,
    pushStatus: "SUCCEEDED", pushedBranch: shared,
  });
  const secondRetry = await db.run.findFirstOrThrow({ where: { taskId: second.id, runNumber: 2 } });
  assert.equal(secondRetry.branch, shared);
  assert.equal(secondRetry.targetBranch, shared, "the completing run's own push is evidence in the same transaction");
});

test("T14a: an automatic retry of a non-chain task answers to publication evidence", async () => {
  const seed = await seedProject("t14a");
  const solo = await postTask(seed.project.id, {
    name: "Solo", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  // The pre-fix shape reaching the automatic retry: the run was created with a
  // base that is its own never-pushed head, so copying `targetBranch` forward
  // reproduces the clone failure for as long as the budget lasts.
  const first = await db.run.findFirstOrThrow({ where: { taskId: solo.body.id } });
  const poisoned = `agentos/${solo.body.id}/run-1`;
  await db.run.update({ where: { id: first.id }, data: { branch: poisoned, targetBranch: poisoned } });
  await runStep(solo.body.id, {
    exitCode: 1, outcome: transientFailure,
    branch: poisoned, pushStatus: "FAILED",
  });
  const retry = await db.run.findFirstOrThrow({ where: { taskId: solo.body.id, runNumber: 2 } });
  assert.notEqual(retry.targetBranch, poisoned, "nothing published this ref");
  assert.equal(retry.targetBranch, seed.repo.defaultBranch);
  assert.equal(retry.branch, runOwnedHead(solo.body.id, 2), "the previous Run's ref is not carried forward");

  // …and the salvage this completion just recorded is evidence in the same
  // transaction, so the next automatic retry keeps the work that reached the
  // remote instead of restarting from the default branch.
  const salvage = `agentos/${solo.body.id}/run-2`;
  await db.run.update({ where: { id: retry.id }, data: { readyAt: new Date(0) } });
  await runStep(solo.body.id, {
    exitCode: 1, outcome: transientFailure,
    branch: poisoned, pushStatus: "SUCCEEDED", pushedBranch: salvage,
  });
  const third = await db.run.findFirstOrThrow({ where: { taskId: solo.body.id, runNumber: 3 } });
  assert.equal(third.targetBranch, salvage, "run 2's work reached the remote and must not be thrown away");
});

test("T14: an automatic retry of a non-chain task is unchanged", async () => {
  const seed = await seedProject("t14");
  const solo = await postTask(seed.project.id, {
    name: "Solo", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, targetBranch: "some/branch",
  });
  await runStep(solo.body.id, {
    exitCode: 1, outcome: transientFailure, pushStatus: "FAILED",
  });
  const retry = await db.run.findFirstOrThrow({ where: { taskId: solo.body.id, runNumber: 2 } });
  assert.equal(retry.targetBranch, "some/branch");
  assert.equal(retry.branch, runOwnedHead(solo.body.id, 2), "the previous Run's ref is not carried forward");
});

// --- WI-7 / WI-8: the flag through the API ----------------------------------

test("T17: opensPullRequest defaults to true and round-trips", async () => {
  const seed = await seedProject("t17");
  const created = await postTask(seed.project.id, {
    name: "Default", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  assert.equal(created.body.opensPullRequest, true, "behaviour-preserving: every existing workflow keeps its PR");

  const explicit = await postTask(seed.project.id, {
    name: "Docs", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id, opensPullRequest: false,
  });
  assert.equal(explicit.body.opensPullRequest, false);

  const patched = await operatorRequest(`/tasks/${explicit.body.id}`, {
    method: "PATCH", body: JSON.stringify({ opensPullRequest: true }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await operatorRequest(`/tasks/${explicit.body.id}`)).body.opensPullRequest, true);
});

test("T18: an instantiated template copies each step's flag onto its task", async () => {
  const seed = await seedProject("t18");
  const template = await db.taskTemplate.create({ data: {
    projectId: seed.project.id, name: "tmpl", description: "t", variables: [],
    steps: { create: [0, 1, 2].map((index) => ({
      stepIndex: index, layer: index, name: `Step ${index}`, assigneeType: "AGENT" as const, assigneeAgentId: seed.agent.id,
      prompt: `do ${index}`, opensPullRequest: index !== 1,
    })) },
  } });
  const chain = await instantiateTemplate(db, seed.project.id, template.id, { repoId: seed.repo.id, variables: {}, autoStart: true, name: "T18 flag copy" });
  const tasks = await db.task.findMany({ where: { chainId: chain.chainId }, orderBy: { chainIndex: "asc" } });
  assert.deepEqual(tasks.map((task) => task.opensPullRequest), [true, false, true]);
});

test("T19: a PATCH does not change a run that is already queued", async () => {
  const seed = await seedProject("t19");
  const created = await postTask(seed.project.id, {
    name: "Queued", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  const queued = await db.run.findFirstOrThrow({ where: { taskId: created.body.id } });
  assert.equal(queued.opensPullRequest, true);

  await operatorRequest(`/tasks/${created.body.id}`, { method: "PATCH", body: JSON.stringify({ opensPullRequest: false }) });
  assert.equal((await operatorRequest(`/tasks/${created.body.id}`)).body.opensPullRequest, false);

  // The claim payload is where the old behaviour leaked: it reads the live task
  // row, so a runner would have seen the patched value on an already-queued run.
  const claim = await claimRun(queued.id);
  assert.equal(claim.run.opensPullRequest, true, "the run carries the snapshot taken when it was created");

  // …and the *next* run does get the new value.
  await completeRunViaRoute(claim, {
    exitCode: 1, outcome: agentFailure, pushStatus: "FAILED",
  });
  const retried = await operatorRequest(`/tasks/${created.body.id}/retry`, { method: "POST" });
  assert.equal(retried.body.opensPullRequest, false);
});

test("operator notes posted before the first claim reach run 1 while generated activity stays out", async () => {
  const seed = await seedProject("first-run-operator-notes");
  const created = await postTask(seed.project.id, {
    name: "First-run operator notes", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const firstRun = await db.run.findFirstOrThrow({ where: { taskId: created.body.id } });

  const note = "Read this before starting the first attempt.";
  const response = await operatorRequest(`/tasks/${created.body.id}/activity`, {
    method: "POST", body: JSON.stringify({ body: note }),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  await db.taskActivity.createMany({ data: [
    { taskId: created.body.id, actorType: "operator", body: "Task status changed by the control plane" },
    { taskId: created.body.id, actorType: "runner", body: "runner-authored activity" },
    { taskId: created.body.id, actorType: "agent", body: "agent-authored activity" },
  ] });

  const firstClaim = await claimRun(firstRun.id);
  assert.deepEqual(firstClaim.operatorNotes, [note]);
});

test("operator notes reach the next run while generated activity stays out and the newest-ten bound holds", async () => {
  const seed = await seedProject("operator-notes");
  const created = await postTask(seed.project.id, {
    name: "Operator notes", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const firstRun = await db.run.findFirstOrThrow({ where: { taskId: created.body.id } });
  const firstClaim = await claimRun(firstRun.id);

  // Exercise both fenced activity writers while the first run owns its lease.
  // Their actor types are intentionally different from the operator route's
  // actorType and must never become instructions for a later attempt.
  const runnerActivity = await createApp(db).request(`/runner/runs/${firstRun.id}/activity`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fencingToken: firstClaim.fencingToken, body: "runner-authored activity" }),
  });
  assert.equal(runnerActivity.status, 201);
  const sessionActivity = await createApp(db).request(`/session/runs/${firstRun.id}/activity`, {
    method: "POST",
    headers: { Authorization: `Bearer ${firstClaim.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fencingToken: firstClaim.fencingToken, body: "agent-authored activity" }),
  });
  assert.equal(sessionActivity.status, 201);

  const completed = await completeRunViaRoute(firstClaim);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const operatorNotes = Array.from({ length: 12 }, (_, index) => `operator-note-${index}-${"x".repeat(200)}`);
  for (const body of operatorNotes) {
    const response = await operatorRequest(`/tasks/${created.body.id}/activity`, {
      method: "POST", body: JSON.stringify({ body }),
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }

  const retried = await operatorRequest(`/tasks/${created.body.id}/retry`, { method: "POST" });
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const nextClaim = await claimRun(retried.body.id);
  assert.deepEqual(nextClaim.operatorNotes, operatorNotes.slice(-10), "only the ten newest direct comments are selected");
  assert.ok(
    nextClaim.operatorNotes.reduce((total: number, note: string) => total + note.length, 0) <= 4_000,
    "the claim must carry at most 4000 note characters",
  );
  assert.doesNotMatch(JSON.stringify(nextClaim.operatorNotes), /runner-authored activity|agent-authored activity/u);
  assert.doesNotMatch(JSON.stringify(nextClaim.operatorNotes), /queued by operator retry/u);
});

test("operator note character bounds never inject a partial note", async () => {
  const seed = await seedProject("operator-note-character-bound");
  const created = await postTask(seed.project.id, {
    name: "Operator note character bound", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  const firstRun = await db.run.findFirstOrThrow({ where: { taskId: created.body.id } });
  const firstClaim = await claimRun(firstRun.id);
  assert.equal((await completeRunViaRoute(firstClaim)).status, 200);

  const notes = [
    `oldest-does-not-fit-${"o".repeat(499)}`,
    ...Array.from({ length: 9 }, (_, index) => `newer-note-${index}-${"n".repeat(384)}`),
  ];
  for (const body of notes) {
    assert.equal((await operatorRequest(`/tasks/${created.body.id}/activity`, {
      method: "POST", body: JSON.stringify({ body }),
    })).status, 201);
  }
  const retried = await operatorRequest(`/tasks/${created.body.id}/retry`, { method: "POST" });
  const nextClaim = await claimRun(retried.body.id);
  assert.deepEqual(nextClaim.operatorNotes, notes.slice(1), "a note that cannot fit is omitted whole");
  assert.ok(nextClaim.operatorNotes.every((note: string) => notes.includes(note)), "every delivered note is byte-identical");
});

test("T19b: PATCH is serialized before automatic retry and lost-lease snapshots", async () => {
  const seed = await seedProject("t19b");
  const holdTask = async (taskId: string) => {
    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const transaction = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE`;
      locked();
      await released;
    });
    await acquired;
    return { release, transaction };
  };

  const automatic = await postTask(seed.project.id, {
    name: "Automatic", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  const automaticRun = await db.run.findFirstOrThrow({ where: { taskId: automatic.body.id } });
  const automaticClaim = await claimRun(automaticRun.id);
  const heldAutomatic = await holdTask(automatic.body.id);
  const automaticBaseline = await blockedLockCount(db);
  const patchAutomatic = operatorRequest(`/tasks/${automatic.body.id}`, {
    method: "PATCH", body: JSON.stringify({ opensPullRequest: false }),
  });
  await waitForBlockedLocks(db, automaticBaseline + 1);
  const completeAutomatic = completeRunViaRoute(automaticClaim, {
    exitCode: 1, outcome: transientFailure, pushStatus: "FAILED",
  });
  await waitForBlockedLocks(db, automaticBaseline + 2);
  heldAutomatic.release();
  assert.equal((await patchAutomatic).status, 200);
  assert.equal((await completeAutomatic).status, 200);
  await heldAutomatic.transaction;
  assert.equal((await db.run.findFirstOrThrow({ where: { taskId: automatic.body.id, runNumber: 2 } })).opensPullRequest, false);

  const lost = await postTask(seed.project.id, {
    name: "Lost", description: "d", assigneeAgentId: seed.agent.id, repoId: seed.repo.id,
  });
  const lostRun = await db.run.findFirstOrThrow({ where: { taskId: lost.body.id } });
  await db.run.update({ where: { id: lostRun.id }, data: {
    status: "RUNNING", leaseExpiresAt: new Date(Date.now() - 60_000), heartbeatAt: null,
  } });
  await db.session.create({ data: {
    runId: lostRun.id, projectId: seed.project.id, agentId: seed.agent.id, taskId: lost.body.id,
    runner: "CLAUDE", executionStatus: "RUNNING",
  } });
  const heldLost = await holdTask(lost.body.id);
  const lostBaseline = await blockedLockCount(db);
  const patchLost = operatorRequest(`/tasks/${lost.body.id}`, {
    method: "PATCH", body: JSON.stringify({ opensPullRequest: false }),
  });
  await waitForBlockedLocks(db, lostBaseline + 1);
  const reconcile = reconcileDatabaseRuns(db, new Date());
  await waitForBlockedLocks(db, lostBaseline + 2);
  heldLost.release();
  assert.equal((await patchLost).status, 200);
  assert.ok(await reconcile > 0);
  await heldLost.transaction;
  assert.equal((await db.run.findFirstOrThrow({ where: { taskId: lost.body.id, runNumber: 2 } })).opensPullRequest, false);
});

test("T20: a template step's PR flag reaches the task it instantiates", async () => {
  const seed = await seedProject("t20");
  const template = await db.taskTemplate.create({ data: {
    projectId: seed.project.id, name: "tmpl", description: "t", variables: [],
    steps: { create: [0, 1].map((index) => ({
      stepIndex: index, layer: index, name: `Step ${index}`, assigneeType: "AGENT" as const, assigneeAgentId: seed.agent.id, prompt: `do ${index}`,
      opensPullRequest: index === 0,
    })) },
  } });
  const chain = await instantiateTemplate(db, seed.project.id, template.id, { repoId: seed.repo.id, variables: {}, autoStart: true, name: "T20 PR flag" });
  const tasks = await db.task.findMany({ where: { chainId: chain.chainId }, orderBy: { chainIndex: "asc" } });
  assert.deepEqual(tasks.map((task) => task.opensPullRequest), [true, false]);
});

test("T21: a claimed database chain run is the exact provenance recorded by its real Git commit", async () => {
  mkdirSync(isolatedRoot, { recursive: true });
  const root = await mkdtemp(join(isolatedRoot, "chain-provenance-"));
  try {
    const remote = join(root, "origin.git");
    const seedRepo = join(root, "seed");
    git(root, ["init", "--bare", "--initial-branch=main", remote]);
    git(root, ["init", "--initial-branch=main", seedRepo]);
    git(seedRepo, ["config", "user.name", "Seed Author"]);
    git(seedRepo, ["config", "user.email", "seed@example.invalid"]);
    await writeFile(join(seedRepo, "base.txt"), "base\n");
    git(seedRepo, ["add", "base.txt"]);
    git(seedRepo, ["commit", "-m", "seed"]);
    git(seedRepo, ["remote", "add", "origin", remote]);
    git(seedRepo, ["push", "-u", "origin", "main"]);

    const seeded = await seedProject("t21-provenance");
    await db.repo.update({ where: { id: seeded.repo.id }, data: { remoteUrl: remote, defaultBranch: "main" } });
    const template = await db.taskTemplate.create({ data: {
      projectId: seeded.project.id,
      name: "provenance-template",
      description: "provenance integration",
      variables: [],
      steps: { create: [{
        stepIndex: 0,
        layer: 0,
        name: "Implementation",
        assigneeType: "AGENT",
        assigneeAgentId: seeded.agent.id,
        prompt: "make one commit",
        outputKind: "implementation",
      }] },
    } });
    const chain = await instantiateTemplate(db, seeded.project.id, template.id, {
      repoId: seeded.repo.id,
      variables: {},
      name: "chain provenance",
      autoStart: true,
    });
    const queued = await db.run.findFirstOrThrow({ where: { taskId: chain.tasks[0]!.id, status: "QUEUED" } });
    const claimed = await claimRun(queued.id) as ClaimedTask;
    assert.equal(claimed.task.chainId, chain.chainId);
    assert.equal(claimed.task.chainIndex, 0);
    assert.equal(claimed.task.templateStep?.name, "Implementation");

    const configured: RunnerConfig = {
      apiUrl: "http://api.invalid",
      runnerToken: RUNNER,
      runnerId: "runner-1",
      servedKinds: null,
      daemonVersion: "0.0.0-dbtest",
      pollIntervalMs: 1_000,
      claimMaxLoadAverage: 1.5,
      leaseSeconds: 60,
      heartbeatIntervalMs: 5_000,
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: join(root, "home"),
      gitIdentity: { name: "Human Maintainer", email: "maintainer@example.invalid" },
      workspaceRoot: join(root, "runs"),
      hostProofSlots: 3,
      failedWorkspaceRetention: 0,
      workspaceReclaimIntervalMs: 300_000,
      toolDeadlineMs: 60_000,
      apiTimeoutMs: 5_000,
      runAsPrefix: [],
      binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
    };
    const runnerWorkspaceUrl = new URL("../../runner/src/workspace.js", import.meta.url).href;
    const { provisionWorkspace } = await import(runnerWorkspaceUrl) as {
      provisionWorkspace: (
        config: RunnerConfig,
        claim: ClaimedTask,
        provisioning: { provision: false; evidence: string },
      ) => Promise<{
        path: string;
        branch: string;
        baseSha: string;
        commitHooksPath?: string;
      }>;
    };
    // The dependency decision is made when the claim is admitted; this test
    // provisions a chain branch, not dependencies.
    const workspace = await provisionWorkspace(configured, claimed, {
      provision: false,
      evidence: "Dependency provisioning skipped: Repo.dependencyProvisioning=NONE",
    });
    const childEnvironment = buildChildEnvironment(configured, claimed, {
      base: join(root, "scratch"),
      workspaceRoot: join(root, "scratch", "workspaces"),
      stateDir: join(root, "scratch", "state"),
      toolsDir: join(root, "scratch", "tools"),
      configRoot: join(root, "scratch", "config"),
    }, workspace.path, workspace.commitHooksPath);
    await writeFile(join(workspace.path, "claimed.txt"), "claimed chain work\n");
    git(workspace.path, ["add", "claimed.txt"], childEnvironment);
    git(workspace.path, ["commit", "-m", "claimed chain commit"], childEnvironment);
    const message = git(workspace.path, ["show", "-s", "--format=%B", "HEAD"]);
    assert.match(message, new RegExp(`^X-Anneal-Run: ${claimed.run.id}$`, "mu"));

    const persisted = await db.run.findUniqueOrThrow({
      where: { id: claimed.run.id },
      include: { task: { include: { templateStep: true } } },
    });
    assert.equal(persisted.id, claimed.run.id);
    assert.equal(persisted.task?.chainId, chain.chainId);
    assert.equal(persisted.task?.chainIndex, 0);
    assert.equal(persisted.task?.templateStep?.name, "Implementation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
