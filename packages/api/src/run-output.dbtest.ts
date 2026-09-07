/**
 * Issue #114: what a run produced has to outlive the run.
 *
 * The runner has always sent the tail of a run's output on every completion,
 * succeeded or failed (see `packages/runner/src/run-output.test.ts`, which
 * drives the real `executeClaim` and asserts the exact payloads reproduced
 * below). This handler read it in one place only — synthesizing a
 * `TaskStepOutput` for a *successful* run whose task had a template, chain or
 * follow-up — and dropped it everywhere else. A failed run therefore left the
 * system with no record of what it had found, which is the case where the
 * record is worth the most: an incident could afterwards only be guessed at.
 *
 * The second defect is one of identity rather than loss. When a task already
 * had an output row, the completion transaction restamped that row's `runId`
 * and `metadata` with the completing run's while leaving the body written by an
 * earlier run — a row that claimed to be run 2's work while its text was run
 * 1's. Which run's output *counts* when more than one has produced something is
 * a cardinality question this table cannot express yet, and it is answered by
 * issue #121; this test only pins the lie shut.
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
  enqueueTaskRun,
  PrismaClient,
  runOwnedHead,
  TaskStatus,
} from "@anneal/db";

import { buildPrompt } from "@anneal/runner/adapters";
import type { ClaimedTask } from "@anneal/runner/api";

import { hashToken } from "./auth.js";
import { previousRunHandoffForClaim } from "./canonical-task-output.js";
import { handleRegressionCompletion } from "./merge-tail-actions.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
const releasedChainLeases: string[] = [];
beforeEach(async () => {
  releasedChainLeases.length = 0;
  await resetTestDb(db);
});
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-run-output";
const RUNNER = "runner-run-output";
const isolatedRoot = process.env.RUNNER_WORKSPACE_ROOT!;

const withTokens = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = [
    ["OPERATOR_TOKEN", process.env.OPERATOR_TOKEN],
    ["RUNNER_TOKEN", process.env.RUNNER_TOKEN],
    ["RUNNER_WORKSPACE_ROOT", process.env.RUNNER_WORKSPACE_ROOT],
  ] as const;
  mkdirSync(isolatedRoot, { recursive: true });
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  process.env.RUNNER_WORKSPACE_ROOT = isolatedRoot;
  try {
    return await operation();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

const call = async (
  method: string, path: string, token: string, body?: unknown,
): Promise<{ status: number; body: any }> => withTokens(async () => {
  const response = await createApp(db, {
    releaseMergeLease: async (target) => {
      if (target) releasedChainLeases.push(target.chainId);
    },
  }).request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) as any };
});

let sequence = 0;
const seedTask = async (options: { chained: boolean; outputKind?: string; templateName?: string; stepIndex?: number; approvalGate?: boolean }) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Run output", slug: `run-output-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: `agent-${suffix}`, title: "Agent",
    model: "claude-opus-5:high", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo", defaultBranch: "master", dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE",
  } });
  const template = options.outputKind ? await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: options.templateName ?? `template-${suffix}`,
    description: "completion boundary fixture",
    variables: [],
  } }) : null;
  const templateStep = template ? await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    stepIndex: options.stepIndex ?? 0,
    layer: options.stepIndex ?? 0,
    name: "Regression verification",
    assigneeType: "AGENT",
    assigneeAgentId: agent.id,
    prompt: "verify",
    approvalGate: options.approvalGate ?? false,
    outputKind: options.outputKind!,
  } }) : null;
  const task = await db.task.create({ data: {
    projectId: project.id, name: "Find the inbox deadlock", description: "work", assigneeAgentId: agent.id,
    repoId: repo.id, status: TaskStatus.TODO, targetBranch: "master", approvalGate: options.approvalGate ?? false,
    ...(template && templateStep ? { templateId: template.id, templateStepId: templateStep.id } : {}),
    ...(options.chained ? { chainId: `chain-${suffix}`, chainIndex: 0, chainLayer: 0 } : {}),
  } });
  return { project, agent, repo, task };
};

/**
 * Puts a queued run into the state a successful claim leaves behind. The claim
 * route is exercised by its own tests; what these need is the *session*
 * credential a claim issues, because the output route below is the only
 * production writer of a step output and it authenticates with one.
 */
const claimRun = async (runId: string, runnerId: string) => {
  const sessionToken = `agos_session_${runId}`;
  const fencingToken = `fence-${runId}`;
  const now = new Date();
  const run = await db.run.update({ where: { id: runId }, data: {
    status: "RUNNING", runnerId, fencingToken, leaseGeneration: 1,
    leaseExpiresAt: new Date(now.getTime() + 600_000),
    sessionTokenHash: hashToken(sessionToken),
    sessionTokenExpiresAt: new Date(now.getTime() + 600_000),
    sessionTokenRevokedAt: null,
    claimedAt: now, heartbeatAt: now, startedAt: now,
  } });
  await db.session.create({ data: {
    runId, projectId: run.projectId, agentId: run.agentId, taskId: run.taskId, runner: run.runner,
    executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: run.taskId! }, data: { status: TaskStatus.DOING } });
  return { run, sessionToken, fencingToken };
};

const enqueue = async (taskId: string): Promise<string> => {
  await db.task.update({ where: { id: taskId }, data: { status: TaskStatus.TODO } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx as never, taskId));
  return (run as { id: string }).id;
};

const addSuccessor = async (seed: Awaited<ReturnType<typeof seedTask>>) => {
  assert.ok(seed.task.chainId);
  return db.task.create({ data: {
    projectId: seed.project.id,
    name: "Canonical successor",
    description: "must not start from refused output",
    assigneeAgentId: seed.agent.id,
    repoId: seed.repo.id,
    status: TaskStatus.TODO,
    targetBranch: "master",
    chainId: seed.task.chainId,
    chainIndex: 1,
    chainLayer: 1,
  } });
};

/**
 * Both payloads are the objects `packages/runner/src/run-output.test.ts`
 * observed on the wire out of a real `executeClaim`: a stub agent that prints
 * to stdout and exits 1, and one that emits the adapter's terminal `result`
 * event and exits 0. Only the volatile fields (runner id, fencing token, shas)
 * are parameterised. Keep the two files in step — a shape invented here would
 * make these tests agree with nothing.
 */
const FAILED_TAIL = "reproduced the deadlock: workers 3 and 7 both hold the inbox advisory lock\n"
  + "the fix needs the lock ordering inverted in reconcile.ts";
const SUCCEEDED_TAIL = "inverted the lock ordering in reconcile.ts and added the regression test";
const SHA = "02283bb8e9a08426394a5d2dc471b19bbaea22d7";
const implementationOutput = (summary: string, headSha = SHA) => JSON.stringify({
  schemaVersion: 1,
  headSha,
  baseSha: SHA,
  summary,
  testsRun: ["npm test -- focused"],
});
const regressionOutput = (summary: string, headSha = SHA) => JSON.stringify({
  schemaVersion: 1,
  outcome: "gate-fail",
  headSha,
  baseHeadSha: "b".repeat(40),
  gateVerdict: "FAIL",
  summary,
});
const solFindingsOutput = (headSha = SHA) => JSON.stringify({
  schemaVersion: 1,
  headSha,
  reviewedBase: "b".repeat(40),
  reviewedHead: headSha,
  findings: [],
  commandsRun: ["git diff --check"],
});
const specOutput = (spec: string, headSha = SHA) => JSON.stringify({ schemaVersion: 1, headSha, spec });

const failedCompletion = (runnerId: string, fencingToken: string, branch: string) => ({
  runnerId,
  fencingToken,
  exitCode: 1,
  signal: null,
  terminationReason: null,
  output: FAILED_TAIL,
  outcome: {
    case: "provider-failure" as const,
    reason: "Error: session ended without a result",
    envelope: {
      version: 1,
      phase: "EXECUTE" as const,
      runnerClass: "TASK_FAILED" as const,
      exitCode: 1,
      signal: null,
      terminationReason: null,
      terminalEventSeen: false,
      terminalSuccess: false,
      agentExited: true,
      providerError: null,
      stderrSummary: "Error: session ended without a result",
      stdoutSummary: FAILED_TAIL,
      timedOut: false,
      transient: false,
      timeoutMs: null,
    },
  },
  branch,
  baseSha: SHA,
  headSha: SHA,
  pushStatus: "NOT_REQUESTED",
  cleanupStatus: "SUCCEEDED",
  workspaceRetained: false,
});

const succeededCompletion = (runnerId: string, fencingToken: string, branch: string) => ({
  runnerId,
  fencingToken,
  exitCode: 0,
  signal: null,
  outcome: { case: "succeeded" as const },
  terminationReason: null,
  output: SUCCEEDED_TAIL,
  branch,
  baseSha: SHA,
  headSha: SHA,
  pushStatus: "SUCCEEDED",
  pushRemote: "https://github.com/acme/widgets.git",
  pushedBranch: branch,
  deliveryInstructions: `Branch '${branch}' was pushed. This step does not open a pull request.`,
  cleanupStatus: "SUCCEEDED",
  workspaceRetained: false,
});

const protocolErrorCompletion = (runnerId: string, fencingToken: string, branch: string) => ({
  ...failedCompletion(runnerId, fencingToken, branch),
  exitCode: 0,
  outcome: {
    case: "provider-failure" as const,
    reason: "Provider stream disconnected before its terminal result event",
    envelope: {
      version: 1,
      phase: "EXECUTE" as const,
      runnerClass: "PROTOCOL_ERROR" as const,
      exitCode: 0,
      signal: null,
      terminationReason: null,
      terminalEventSeen: false,
      terminalSuccess: false,
      agentExited: true,
      providerError: null,
      stderrSummary: "Provider stream disconnected before its terminal result event",
      stdoutSummary: FAILED_TAIL,
      timedOut: false,
      transient: false,
      timeoutMs: null,
    },
  },
});

const REGRESSION_STEP = {
  chained: true,
  outputKind: "regression-verification",
  templateName: DIRECT_TEMPLATE_NAME,
  stepIndex: 5,
} as const;

const REGRESSION_V2_STEP = {
  ...REGRESSION_STEP,
  outputKind: "regression-verification-v2",
} as const;

const negativeRegressionVerdict = (
  outcome: "review-fail" | "gate-fail" | "refresh-conflict",
  schemaVersion: 1 | 2,
) => outcome === "gate-fail"
  ? {
      schemaVersion,
      outcome,
      headSha: SHA,
      baseHeadSha: "b".repeat(40),
      gateVerdict: "FAIL",
      ...(schemaVersion === 2 ? { gateProof: "MERGE GATE: FAIL (targeted DB regression)" } : {}),
      summary: "gate failed",
    }
  : {
      schemaVersion,
      outcome,
      headSha: SHA,
      baseHeadSha: "b".repeat(40),
      summary: `${outcome} requires repair`,
    };

const addRepairAgent = async (
  seeded: Awaited<ReturnType<typeof seedTask>>,
  agentName: "senior-dev-astra-medium" | "merge-resolver-opus-medium",
) => {
  const repairAgent = await db.agent.create({ data: {
    projectId: seeded.project.id,
    environmentId: seeded.agent.environmentId,
    name: agentName,
    title: agentName,
    model: "claude-opus-5:high",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: seeded.project.id,
    agentId: repairAgent.id,
    repoId: seeded.repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  if (agentName !== "merge-resolver-opus-medium") {
    // Implementation repairs use the chain's explicit staffing, not a role-name fallback.
    assert.ok(seeded.task.templateId);
    assert.ok(seeded.task.chainId);
    await db.task.update({
      where: { id: seeded.task.id },
      data: { chainIndex: 5, chainLayer: 5 },
    });
    const step = await db.taskTemplateStep.create({ data: {
      taskTemplateId: seeded.task.templateId,
      stepIndex: 4,
      layer: 4,
      name: "Apply review fixes",
      assigneeType: "AGENT",
      assigneeAgentId: repairAgent.id,
      prompt: "fix",
      approvalGate: false,
      outputKind: "fixed-implementation",
    } });
    await db.task.create({ data: {
      projectId: seeded.project.id,
      name: "Apply review fixes",
      description: "Explicit repair staffing",
      assigneeAgentId: repairAgent.id,
      repoId: seeded.repo.id,
      templateId: seeded.task.templateId,
      templateStepId: step.id,
      chainId: seeded.task.chainId,
      chainIndex: 4,
      chainLayer: 4,
      targetBranch: "master",
      status: TaskStatus.DONE,
    } });
  }
  return repairAgent;
};

test("a failed run's output survives on the run that produced it", async () => {
  const { task } = await seedTask({ chained: false });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-1");

  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    failedCompletion("runner-1", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const closed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(closed.status, "FAILED");
  // The whole of issue #114: before this, the tail this failure arrived with
  // was read by nothing and stored nowhere, and the run's own account of what
  // it found died in the handler that received it.
  assert.equal(closed.output, FAILED_TAIL);
  // And it stays telemetry. The deliverables table is not where a failure's
  // stdout belongs, and nothing downstream may read this as a step's product.
  assert.equal(await db.taskStepOutput.count({ where: { taskId: task.id } }), 0);
});

test("the tail is kept off the task read routes that serialize whole run rows", async () => {
  const { project, task } = await seedTask({ chained: false });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-1");
  await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    failedCompletion("runner-1", fencingToken, run.branch ?? "master"),
  );
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).output, FAILED_TAIL);

  // Both routes spread whole run rows into their responses, so a 500k forensic
  // column would ride along on every poll of the board and the task page. The
  // evidence is on the row for whoever goes looking; it is not part of the
  // shape either client asks for.
  const detail = await call("GET", `/tasks/${task.id}`, OPERATOR);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.runs.length, 1);
  assert.equal("output" in detail.body.runs[0], false);
  assert.equal(detail.body.runs[0].failureReason, "Error: session ended without a result");

  const list = await call("GET", `/tasks?projectId=${project.id}`, OPERATOR);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const listed = (list.body as Array<{ id: string; runs: Array<Record<string, unknown>> }>)
    .find((row) => row.id === task.id);
  assert.ok(listed, "the task must still be listed");
  assert.equal("output" in listed.runs[0]!, false);
});

test("a successful run's output is kept on its run as well", async () => {
  const { task } = await seedTask({ chained: false });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-1");

  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    succeededCompletion("runner-1", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const closed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(closed.status, "SUCCEEDED");
  // A plain task has no template, chain or follow-up, so this tail used to be
  // discarded too — success was no protection, only a different branch of the
  // same omission.
  assert.equal(closed.output, SUCCEEDED_TAIL);
});

test("ordinary chained steps retain completion-time output synthesis", async () => {
  const { task } = await seedTask({ chained: true });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-ordinary-chain");
  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    succeededCompletion("runner-ordinary-chain", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: task.id } });
  assert.equal(output.runId, runId);
  assert.equal(output.body, SUCCEEDED_TAIL);
});

test("regression completion keeps final prose as Run.output but requires this run's explicit task_output", async () => {
  const { task } = await seedTask({ chained: true, outputKind: "regression-verification" });
  const runId = await enqueue(task.id);
  // The budget is spent, so the missing deliverable is not re-queued and this
  // terminal stop is what completion reaches.
  await db.run.update({ where: { id: runId }, data: { maxRunsPerTask: 1 } });
  const { run, sessionToken, fencingToken } = await claimRun(runId, "runner-regression");
  const nonVerdict = "GATE NOT RUN: the exact candidate was not transported";
  const activity = await call("POST", `/session/runs/${runId}/activity`, sessionToken, {
    fencingToken,
    body: nonVerdict,
  });
  assert.equal(activity.status, 201, JSON.stringify(activity.body));

  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    { ...succeededCompletion("runner-regression", fencingToken, run.branch ?? "master"), output: "I could not obtain a gate verdict." },
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).output, "I could not obtain a gate verdict.");
  assert.equal(await db.taskStepOutput.count({ where: { taskId: task.id } }), 0, "completion prose became structured output");
  const stopped = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(stopped.status, TaskStatus.REVIEW);
  assert.match(stopped.failureReason ?? "", /missing regression-verification task output for current Run/u);
  const activities = await db.taskActivity.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } });
  assert.ok(activities.some(({ body }) => body === nonVerdict), "the agent's original non-verdict activity was lost");
  assert.ok(activities.some(({ metadata }) => (metadata as Record<string, unknown> | null)?.kind === "canonicalTaskOutput.refusal"));
  assert.deepEqual(releasedChainLeases, [task.chainId]);
});

test("every authored Regression stop verdict releases its chain lease", async () => {
  for (const verdict of [
    { schemaVersion: 1, outcome: "refresh-conflict", headSha: SHA, baseHeadSha: "b".repeat(40), summary: "conflict" },
    { schemaVersion: 1, outcome: "review-fail", headSha: SHA, baseHeadSha: "b".repeat(40), summary: "must-fix remains" },
    { schemaVersion: 1, outcome: "gate-fail", headSha: SHA, baseHeadSha: "b".repeat(40), gateVerdict: "FAIL", summary: "gate failed" },
  ] as const) {
    releasedChainLeases.length = 0;
    const { task } = await seedTask({
      chained: true,
      outputKind: "regression-verification",
      templateName: DIRECT_TEMPLATE_NAME,
      stepIndex: 5,
    });
    const runId = await enqueue(task.id);
    const { run, sessionToken, fencingToken } = await claimRun(runId, `runner-${verdict.outcome}`);
    const written = await call("PUT", `/session/runs/${runId}/output`, sessionToken, {
      fencingToken,
      kind: "regression-verification",
      body: JSON.stringify(verdict),
      commitSha: SHA,
    });
    assert.equal(written.status, 200, JSON.stringify(written.body));
    const completed = await call(
      "POST",
      `/runner/runs/${runId}/complete`,
      RUNNER,
      succeededCompletion(`runner-${verdict.outcome}`, fencingToken, run.branch ?? "master"),
    );
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.deepEqual(releasedChainLeases, [task.chainId], verdict.outcome);
  }
});

test("a retryable protocol failure consumes its durable negative Regression verdict exactly once", async () => {
  for (const [outcome, repairKind, agentName] of [
    ["review-fail", "review-fix", "senior-dev-astra-medium"],
    ["gate-fail", "gate-fix", "senior-dev-astra-medium"],
    ["refresh-conflict", "refresh-conflict", "merge-resolver-opus-medium"],
  ] as const) {
    await resetTestDb(db);
    const seeded = await seedTask(REGRESSION_STEP);
    const repairAgent = await addRepairAgent(seeded, agentName);
    const runId = await enqueue(seeded.task.id);
    const claimed = await claimRun(runId, `runner-durable-${outcome}`);
    const body = outcome === "gate-fail"
      ? { schemaVersion: 1, outcome, headSha: SHA, baseHeadSha: "b".repeat(40), gateVerdict: "FAIL", summary: "gate failed" }
      : { schemaVersion: 1, outcome, headSha: SHA, baseHeadSha: "b".repeat(40), summary: `${outcome} requires repair` };
    const written = await call("PUT", `/session/runs/${runId}/output`, claimed.sessionToken, {
      fencingToken: claimed.fencingToken,
      kind: "regression-verification",
      body: JSON.stringify(body),
      commitSha: SHA,
    });
    assert.equal(written.status, 200, JSON.stringify(written.body));

    const completion = protocolErrorCompletion(
      `runner-durable-${outcome}`,
      claimed.fencingToken,
      claimed.run.branch ?? "master",
    );
    const completed = await call("POST", `/runner/runs/${runId}/complete`, RUNNER, completion);
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.succeeded, false, outcome);
    assert.equal(completed.body.retryCreated, false, outcome);

    const settled = await db.run.findUniqueOrThrow({ where: { id: runId } });
    assert.equal(settled.status, "FAILED", outcome);
    assert.equal(settled.failureClass, "PROTOCOL_ERROR", outcome);
    assert.equal(settled.retryable, true, outcome);
    assert.equal(await db.run.count({ where: { taskId: seeded.task.id } }), 1, `${outcome} queued Regression Run 2`);
    assert.equal(await db.task.count({ where: {
      projectId: seeded.project.id,
      name: `Autonomous merge tail: ${repairKind}`,
      assigneeAgentId: repairAgent.id,
    } }), 1, outcome);

    const duplicate = await call("POST", `/runner/runs/${runId}/complete`, RUNNER, completion);
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(await reconcileDatabaseRuns(db, new Date()), 0, outcome);
    const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.task.id } });
    const session = await db.session.findUniqueOrThrow({ where: { runId } });
    assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, {
      task: regression,
      run: {
        id: runId,
        agentId: seeded.agent.id,
        branch: claimed.run.branch,
        headSha: SHA,
        sessionId: session.id,
      },
      now: new Date(),
    })), "handled", outcome);
    assert.equal(await db.task.count({ where: {
      projectId: seeded.project.id,
      name: { startsWith: "Autonomous merge tail:" },
    } }), 1, `${outcome} duplicated its repair`);
  }
});

test("a current v2 gate-fail with gate proof is consumed after protocol failure", async () => {
  const seeded = await seedTask(REGRESSION_V2_STEP);
  const repairAgent = await addRepairAgent(seeded, "senior-dev-astra-medium");
  const runId = await enqueue(seeded.task.id);
  const claimed = await claimRun(runId, "runner-v2-durable-gate-fail");
  const written = await call("PUT", `/session/runs/${runId}/output`, claimed.sessionToken, {
    fencingToken: claimed.fencingToken,
    kind: "regression-verification-v2",
    body: JSON.stringify(negativeRegressionVerdict("gate-fail", 2)),
    commitSha: SHA,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));

  const completed = await call(
    "POST",
    `/runner/runs/${runId}/complete`,
    RUNNER,
    protocolErrorCompletion("runner-v2-durable-gate-fail", claimed.fencingToken, claimed.run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, false);
  assert.equal(completed.body.retryCreated, false);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).status, "FAILED");
  assert.equal(await db.run.count({ where: { taskId: seeded.task.id } }), 1);
  assert.equal(await db.task.count({ where: {
    projectId: seeded.project.id,
    name: "Autonomous merge tail: gate-fix",
    assigneeAgentId: repairAgent.id,
  } }), 1);
});

test("current v2 durable negative verdicts survive lease-loss reconciliation without a Regression retry", async () => {
  for (const [outcome, repairKind, agentName] of [
    ["review-fail", "review-fix", "senior-dev-astra-medium"],
    ["gate-fail", "gate-fix", "senior-dev-astra-medium"],
    ["refresh-conflict", "refresh-conflict", "merge-resolver-opus-medium"],
  ] as const) {
    await resetTestDb(db);
    const seeded = await seedTask(REGRESSION_V2_STEP);
    const repairAgent = await addRepairAgent(seeded, agentName);
    const runId = await enqueue(seeded.task.id);
    const claimed = await claimRun(runId, `runner-reconcile-${outcome}`);
    const written = await call("PUT", `/session/runs/${runId}/output`, claimed.sessionToken, {
      fencingToken: claimed.fencingToken,
      kind: "regression-verification-v2",
      body: JSON.stringify(negativeRegressionVerdict(outcome, 2)),
      commitSha: SHA,
    });
    assert.equal(written.status, 200, JSON.stringify(written.body));
    await db.run.update({ where: { id: runId }, data: {
      branch: claimed.run.branch ?? "master",
      leaseExpiresAt: new Date(Date.now() - 60_000),
      heartbeatAt: null,
    } });

    assert.equal(await reconcileDatabaseRuns(db, new Date(), async () => {}), 1, outcome);
    const settled = await db.run.findUniqueOrThrow({ where: { id: runId } });
    assert.equal(settled.status, "LOST", outcome);
    assert.equal(await db.run.count({ where: { taskId: seeded.task.id } }), 1, `${outcome} queued Regression Run 2`);
    assert.equal(await db.task.count({ where: {
      projectId: seeded.project.id,
      name: `Autonomous merge tail: ${repairKind}`,
      assigneeAgentId: repairAgent.id,
    } }), 1, outcome);

    assert.equal(await reconcileDatabaseRuns(db, new Date(), async () => {}), 0, outcome);
    assert.equal(await db.task.count({ where: {
      projectId: seeded.project.id,
      name: { startsWith: "Autonomous merge tail:" },
    } }), 1, `${outcome} duplicated its repair during reconciliation`);
  }
});

test("only same-Run exact-head negative evidence enters the protocol-failure exception", async () => {
  const cases = [
    {
      label: "body-commit-head-mismatch",
      body: JSON.stringify({ ...negativeRegressionVerdict("review-fail", 2), headSha: "c".repeat(40) }),
      commitSha: SHA,
      completionHeadSha: SHA,
    },
    {
      label: "completion-head-mismatch",
      body: JSON.stringify(negativeRegressionVerdict("review-fail", 2)),
      commitSha: SHA,
      completionHeadSha: "c".repeat(40),
    },
    {
      label: "malformed-output",
      body: "not-json",
      commitSha: SHA,
      completionHeadSha: SHA,
    },
    {
      label: "pass",
      body: JSON.stringify({
        schemaVersion: 2,
        outcome: "pass",
        headSha: SHA,
        baseHeadSha: "b".repeat(40),
        gateVerdict: "PASS",
        gateProof: `MERGE GATE: PASS ${SHA}`,
      }),
      commitSha: SHA,
      completionHeadSha: SHA,
    },
  ] as const;

  for (const scenario of cases) {
    await resetTestDb(db);
    const seeded = await seedTask(REGRESSION_V2_STEP);
    const runId = await enqueue(seeded.task.id);
    const claimed = await claimRun(runId, `runner-boundary-${scenario.label}`);
    await db.taskStepOutput.create({ data: {
      taskId: seeded.task.id,
      runId,
      kind: "regression-verification-v2",
      body: scenario.body,
      commitSha: scenario.commitSha,
    } });
    const completion = {
      ...protocolErrorCompletion(`runner-boundary-${scenario.label}`, claimed.fencingToken, claimed.run.branch ?? "master"),
      headSha: scenario.completionHeadSha,
    };
    const completed = await call("POST", `/runner/runs/${runId}/complete`, RUNNER, completion);
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.retryCreated, true, scenario.label);
    assert.equal(await db.task.count({ where: {
      projectId: seeded.project.id,
      name: { startsWith: "Autonomous merge tail:" },
    } }), 0, scenario.label);
    assert.equal(await db.run.count({ where: { taskId: seeded.task.id } }), 2, scenario.label);
  }

  await resetTestDb(db);
  const seeded = await seedTask(REGRESSION_V2_STEP);
  const priorRunId = await enqueue(seeded.task.id);
  const prior = await claimRun(priorRunId, "runner-prior-output");
  await db.taskStepOutput.create({ data: {
    taskId: seeded.task.id,
    runId: priorRunId,
    kind: "regression-verification-v2",
    body: JSON.stringify(negativeRegressionVerdict("review-fail", 2)),
    commitSha: SHA,
  } });
  await db.run.update({ where: { id: priorRunId }, data: { status: "FAILED", endedAt: new Date() } });
  const currentRunId = await enqueue(seeded.task.id);
  const current = await claimRun(currentRunId, "runner-current-output");
  const completed = await call(
    "POST",
    `/runner/runs/${currentRunId}/complete`,
    RUNNER,
    protocolErrorCompletion("runner-current-output", current.fencingToken, current.run.branch ?? prior.run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.retryCreated, true);
  assert.equal(await db.task.count({ where: {
    projectId: seeded.project.id,
    name: { startsWith: "Autonomous merge tail:" },
  } }), 0);
  assert.equal(await db.run.count({ where: { taskId: seeded.task.id } }), 3);
});

/**
 * A step whose deliverable only its agent can author used to settle SUCCEEDED
 * when the session ended without persisting one — the Claude adapter reads the
 * end of a turn as the end of the session, so a step that parked on a
 * background wait (a merge lease, a gate verdict) had its wait killed and its
 * run recorded as a success. The chain then stopped at the fail-loud below,
 * which only an operator could clear. The miss is a retryable failure of the
 * run instead, and the fail-loud is what is left when the budget is spent.
 */
test("a required deliverable the run never persisted is a retryable failure, not a success", async () => {
  const { task } = await seedTask(REGRESSION_STEP);
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-missing-output");
  const completed = await call(
    "POST",
    `/runner/runs/${runId}/complete`,
    RUNNER,
    succeededCompletion("runner-missing-output", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, false);
  assert.equal(completed.body.retryCreated, true);

  const settled = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(settled.status, "FAILED");
  assert.equal(settled.retryable, true);
  assert.equal(settled.failureClass, "PROTOCOL_ERROR");
  assert.match(settled.failureReason ?? "", /missing regression-verification task output for current Run/u);

  const retry = await db.run.findFirstOrThrow({ where: { taskId: task.id, runNumber: 2 } });
  assert.equal(retry.status, "QUEUED");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, TaskStatus.DOING);
  // The chain still owns the delivery it is retrying, exactly as for any other
  // retried Regression failure.
  assert.deepEqual(releasedChainLeases, []);
});

test("a failed required-output status check is a non-retryable protocol failure", async () => {
  const { task } = await seedTask({ chained: true, outputKind: "implementation" });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-output-status-failure");
  const completion = {
    ...failedCompletion("runner-output-status-failure", fencingToken, run.branch ?? "master"),
    exitCode: 0,
    // Not a provider failure: the control plane could not say whether the
    // required output exists, and re-asking a question that did not answer is
    // not a repair.
    outcome: {
      case: "terminal-protocol-failure" as const,
      reason: "Task output status could not be established for a step declaring output kind 'implementation'",
    },
  };

  const completed = await call("POST", `/runner/runs/${runId}/complete`, RUNNER, completion);

  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, false);
  assert.equal(completed.body.retryCreated, false);
  const settled = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(settled.status, "FAILED");
  assert.equal(settled.failureClass, "PROTOCOL_ERROR");
  assert.equal(settled.retryable, false);
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 1, "status-check failure queued a retry Run");
});

test("Regression v2 status reserves remediation for the mechanical Runner path", async () => {
  const { task } = await seedTask(REGRESSION_V2_STEP);
  const runId = await enqueue(task.id);
  const claimed = await claimRun(runId, "runner-regression-mechanical-output");

  const status = await call("GET", `/session/runs/${runId}/status`, claimed.sessionToken);

  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.task.outputKind, "regression-verification-v2");
  assert.deepEqual(status.body.task.outputEvidence.satisfaction, {
    case: "absent",
    outputKind: "regression-verification-v2",
    remediable: false,
  });
});

test("a run that authored nothing is re-queued even when a prior run's output is on the task", async () => {
  const { task } = await seedTask({
    chained: true,
    outputKind: "implementation",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 1,
  });
  const firstRunId = await enqueue(task.id);
  const first = await claimRun(firstRunId, "prior-output-runner-1");
  const written = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "implementation",
    body: implementationOutput("Run 1 implementation"),
    commitSha: SHA,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal((await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    failedCompletion("prior-output-runner-1", first.fencingToken, first.run.branch ?? "master"),
  )).status, 200);
  const retried = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const secondRunId = retried.body.id as string;
  const claimed = await claimRun(secondRunId, "prior-output-runner-2");
  const status = await call("GET", `/session/runs/${secondRunId}/status`, claimed.sessionToken);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.deepEqual(
    status.body.task.outputEvidence.satisfaction,
    { case: "absent", outputKind: "implementation", remediable: true },
    "the prior Run's replaceable output is not this Run's deliverable",
  );

  const completed = await call(
    "POST", `/runner/runs/${secondRunId}/complete`, RUNNER,
    succeededCompletion("prior-output-runner-2", claimed.fencingToken, claimed.run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, false);
  assert.equal(completed.body.retryCreated, true);
  // The row an earlier run authored is neither counted as this run's work nor
  // disturbed by the retry it produces.
  assert.equal((await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: task.id } })).runId, firstRunId);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, TaskStatus.DOING);
  assert.equal((await db.run.findFirstOrThrow({ where: { taskId: task.id, runNumber: 3 } })).status, "QUEUED");
});

test("an immutable prior Run output disables remediation and explicitly satisfies the task", async () => {
  const seeded = await seedTask({
    chained: true,
    outputKind: "review-findings",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 2,
  });
  const { task } = seeded;
  const successor = await addSuccessor(seeded);
  const firstRunId = await enqueue(task.id);
  const first = await claimRun(firstRunId, "immutable-output-runner-1");
  const written = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "review-findings",
    body: solFindingsOutput(),
    commitSha: SHA,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal((await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    failedCompletion("immutable-output-runner-1", first.fencingToken, first.run.branch ?? "master"),
  )).status, 200);
  const retried = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const secondRunId = retried.body.id as string;
  const second = await claimRun(secondRunId, "immutable-output-runner-2");

  const status = await call("GET", `/session/runs/${secondRunId}/status`, second.sessionToken);

  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.deepEqual(status.body.task.outputEvidence.satisfaction, {
    case: "satisfied-by-prior-run",
    outputKind: "review-findings",
  });

  const completed = await call(
    "POST", `/runner/runs/${secondRunId}/complete`, RUNNER,
    succeededCompletion("immutable-output-runner-2", second.fencingToken, second.run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, true);
  assert.equal(completed.body.retryCreated, false);

  const settled = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(settled.status, TaskStatus.DONE);
  assert.equal(settled.failureReason, null);
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: task.id } });
  assert.equal(output.runId, firstRunId);

  const activities = await db.taskActivity.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } });
  const priorRunSatisfaction = activities.filter(({ actorType, body }) => (
    actorType === "control-plane" && body.includes(firstRunId)
  ));
  assert.equal(priorRunSatisfaction.length, 1, "one control-plane activity records prior-Run satisfaction");
  assert.match(priorRunSatisfaction[0]!.body, /prior Run/u);
  assert.equal(
    activities.filter(({ body }) => body.includes("belongs to prior Run")).length,
    0,
    "accepted immutable output does not record the prior-Run refusal",
  );
  assert.equal(await db.run.count({ where: { taskId: successor.id, status: "QUEUED" } }), 1);
});

test("an immutable prior Run output bound to another head remains refused", async () => {
  const seeded = await seedTask({
    chained: true,
    outputKind: "review-findings",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 2,
  });
  const { task } = seeded;
  const successor = await addSuccessor(seeded);
  const authoredHead = "a".repeat(40);
  const firstRunId = await enqueue(task.id);
  const first = await claimRun(firstRunId, "immutable-bound-head-runner-1");
  const written = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "review-findings",
    body: solFindingsOutput(authoredHead),
    commitSha: authoredHead,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  const firstCompleted = await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    {
      ...failedCompletion("immutable-bound-head-runner-1", first.fencingToken, first.run.branch ?? "master"),
      baseSha: authoredHead,
      headSha: authoredHead,
    },
  );
  assert.equal(firstCompleted.status, 200, JSON.stringify(firstCompleted.body));

  const retried = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const secondRunId = retried.body.id as string;
  const second = await claimRun(secondRunId, "immutable-bound-head-runner-2");
  const completed = await call(
    "POST", `/runner/runs/${secondRunId}/complete`, RUNNER,
    succeededCompletion("immutable-bound-head-runner-2", second.fencingToken, second.run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: task.id } });
  assert.equal(output.runId, firstRunId);
  assert.equal(output.commitSha, authoredHead);
  const stopped = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(stopped.status, TaskStatus.REVIEW);
  assert.match(stopped.failureReason ?? "", /is bound to .*not completion head/u);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
});

test("a required deliverable that is present still settles SUCCEEDED", async () => {
  const { task } = await seedTask(REGRESSION_STEP);
  const runId = await enqueue(task.id);
  const { run, fencingToken, sessionToken } = await claimRun(runId, "runner-present-output");
  const written = await call("PUT", `/session/runs/${runId}/output`, sessionToken, {
    fencingToken,
    kind: "regression-verification",
    body: regressionOutput("gate failed"),
    commitSha: SHA,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  const completed = await call(
    "POST",
    `/runner/runs/${runId}/complete`,
    RUNNER,
    succeededCompletion("runner-present-output", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, true);
  assert.equal(completed.body.retryCreated, false);
  const settled = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(settled.status, "SUCCEEDED");
  assert.equal(settled.failureReason, null);
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 1);
});

test("a canonical Regression output refusal is the backstop once the run budget is spent", async () => {
  const { task } = await seedTask(REGRESSION_STEP);
  const runId = await enqueue(task.id);
  await db.run.update({ where: { id: runId }, data: { maxRunsPerTask: 1 } });
  const { run, fencingToken } = await claimRun(runId, "runner-canonical-refusal");
  const completed = await call(
    "POST",
    `/runner/runs/${runId}/complete`,
    RUNNER,
    succeededCompletion("runner-canonical-refusal", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 1, "a spent budget queues nothing");
  assert.match((await db.task.findUniqueOrThrow({ where: { id: task.id } })).failureReason ?? "", /missing regression-verification task output/u);
  const refusal = await db.taskActivity.findFirst({
    where: { taskId: task.id, metadata: { path: ["kind"], equals: "canonicalTaskOutput.refusal" } },
  });
  assert.ok(refusal, "the stop is the canonical output refusal path");
  assert.deepEqual(releasedChainLeases, [task.chainId]);
});

test("a runner too old to send an output completes exactly as it always did", async () => {
  const { task } = await seedTask({ chained: false });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-1");

  // The same real payload with the field removed, which is what a runner
  // predating it sends: `output` is optional on the wire and this is the whole
  // of the backward-compatibility contract. The column stays NULL — the honest
  // answer for a run whose tail was never reported — and nothing else about the
  // completion changes.
  const { output: _omitted, ...oldRunnerBody } = succeededCompletion(
    "runner-1", fencingToken, run.branch ?? "master",
  );
  const completed = await call("POST", `/runner/runs/${runId}/complete`, RUNNER, oldRunnerBody);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, true);

  const closed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(closed.status, "SUCCEEDED");
  assert.equal(closed.output, null);
  assert.equal(closed.headSha, SHA, "the rest of the completion landed as usual");
});

test("a later run does not restamp the output row an earlier run wrote", async () => {
  const { task } = await seedTask({ chained: true });
  const firstRunId = await enqueue(task.id);
  const first = await claimRun(firstRunId, "runner-1");

  // The only production writer of a step output: the agent's own session,
  // through the MCP output tool's route.
  const written = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "result",
    body: "The deadlock is in reconcile.ts; here is the patch and its proof.",
    commitSha: SHA,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));

  const firstCompleted = await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    failedCompletion("runner-1", first.fencingToken, first.run.branch ?? "master"),
  );
  assert.equal(firstCompleted.status, 200, JSON.stringify(firstCompleted.body));

  // An operator reruns the step: the fourth run-creating path, and the one an
  // operator actually reaches from a task that landed in review.
  const retried = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const second = await claimRun(retried.body.id as string, "runner-2");

  // Run 2 succeeds without writing an output of its own — the agent simply did
  // not call the tool, which is ordinary.
  const secondCompleted = await call(
    "POST", `/runner/runs/${second.run.id}/complete`, RUNNER,
    succeededCompletion("runner-2", second.fencingToken, second.run.branch ?? "master"),
  );
  assert.equal(secondCompleted.status, 200, JSON.stringify(secondCompleted.body));

  const row = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: task.id } });
  // One act of authorship: body, author and metadata all still run 1's. The
  // restamp used to move two of the three and leave the body behind.
  assert.equal(row.body, "The deadlock is in reconcile.ts; here is the patch and its proof.");
  assert.equal(row.runId, firstRunId);
  assert.equal(row.metadata, null);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: task.id } }), 1);

  // Neither run lost its own tail to the other's completion.
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: firstRunId } })).output, FAILED_TAIL);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: second.run.id } })).output, SUCCEEDED_TAIL);
});

test("a canonical step cannot advance from a prior Run's output", async () => {
  const { task } = await seedTask({
    chained: true,
    outputKind: "implementation",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 1,
  });
  const firstRunId = await enqueue(task.id);
  const first = await claimRun(firstRunId, "canonical-runner-1");
  const wrongKind = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "result",
    body: "wrong canonical kind",
    commitSha: SHA,
  });
  assert.equal(wrongKind.status, 409);
  const written = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "implementation",
    body: implementationOutput("Run 1 implementation"),
    commitSha: SHA,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal((await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    failedCompletion("canonical-runner-1", first.fencingToken, first.run.branch ?? "master"),
  )).status, 200);

  const retried = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const second = await claimRun(retried.body.id as string, "canonical-runner-2");
  // The budget is spent on this attempt, so the run that authors nothing is
  // not re-queued and this refusal is the terminal outcome.
  await db.run.update({ where: { id: second.run.id }, data: { maxRunsPerTask: 2 } });
  const completed = await call(
    "POST", `/runner/runs/${second.run.id}/complete`, RUNNER,
    succeededCompletion("canonical-runner-2", second.fencingToken, second.run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: task.id } });
  assert.equal(output.runId, firstRunId);
  const stopped = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(stopped.status, TaskStatus.REVIEW);
  assert.match(stopped.failureReason ?? "", /belongs to prior Run/u);

  const queuedThird = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(queuedThird.status, 201, JSON.stringify(queuedThird.body));
  const loaded = await db.task.findUniqueOrThrow({
    where: { id: task.id },
    include: { templateStep: { include: { taskTemplate: { select: { name: true } } } } },
  });
  const handoff = await db.$transaction((tx) => previousRunHandoffForClaim(tx, {
    taskId: task.id,
    runId: queuedThird.body.id as string,
    runNumber: 3,
    templateStep: loaded.templateStep,
  }));
  assert.deepEqual(handoff?.output, {
    runId: firstRunId,
    kind: "implementation",
    body: implementationOutput("Run 1 implementation"),
    commitSha: SHA,
  });
});

for (const cancelledIntermediary of [false, true]) {
  test(`a real claim carries salvage through the runner prompt (cancelled intermediary: ${cancelledIntermediary})`, async () => {
    // 2026-09-05: two fix Runs died on a provider capacity refusal after editing
    // files, salvage committed the edits on top of the reviewed head, and the
    // replacement Run had no way to learn that its starting HEAD was its own
    // prior attempt — so both stopped and asked a human.
    const { task } = await seedTask({
      chained: true,
      outputKind: "fixed-implementation",
      templateName: DIRECT_TEMPLATE_NAME,
      stepIndex: 5,
    });
    const salvageSha = "a".repeat(40);
    const firstRunId = await enqueue(task.id);
    const first = await claimRun(firstRunId, "salvage-handoff-runner-1");
    const salvageBranch = runOwnedHead(task.id, first.run.runNumber);
    assert.equal((await call("POST", `/runner/runs/${firstRunId}/complete`, RUNNER, {
      ...failedCompletion("salvage-handoff-runner-1", first.fencingToken, first.run.branch ?? "master"),
      pushStatus: "SUCCEEDED",
      pushRemote: "https://github.com/acme/widgets.git",
      pushedBranch: salvageBranch,
      headSha: salvageSha,
      salvageParentSha: SHA,
    })).status, 200);

    const queuedSecond = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
    assert.equal(queuedSecond.status, 201, JSON.stringify(queuedSecond.body));
    if (cancelledIntermediary) {
      await db.run.update({ where: { id: queuedSecond.body.id }, data: { status: "CANCELLED", endedAt: new Date() } });
      const queuedThird = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
      assert.equal(queuedThird.status, 201, JSON.stringify(queuedThird.body));
    }
    const claimed = await call("POST", "/runner/tasks/claim", RUNNER, {
      runnerId: "salvage-successor", leaseSeconds: 60,
    });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    const claim = claimed.body as ClaimedTask;
    assert.equal(claim.task.id, task.id);
    assert.equal(claim.run.runNumber, cancelledIntermediary ? 3 : 2);
    assert.equal(claim.run.targetBranch, salvageBranch);
    assert.equal(claim.run.targetBranchPublished, true);
    assert.deepEqual(claim.previousRunHandoff?.salvage, { commitSha: salvageSha, parentSha: SHA });
    assert.match(buildPrompt(claim), new RegExp(`WIP salvage commit ${salvageSha}, made on top of ${SHA}`, "u"));
  });
}

test("a retry handoff includes valid immutable findings refused under the prior ownership rule", async () => {
  const { task } = await seedTask({
    chained: true,
    outputKind: "review-findings",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 2,
  });
  const firstRunId = await enqueue(task.id);
  const first = await claimRun(firstRunId, "immutable-handoff-runner-1");
  const body = solFindingsOutput();
  const written = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "review-findings",
    body,
    commitSha: SHA,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal((await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    failedCompletion("immutable-handoff-runner-1", first.fencingToken, first.run.branch ?? "master"),
  )).status, 200);

  const retried = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const second = await claimRun(retried.body.id as string, "immutable-handoff-runner-2");
  const legacyRefusal = `review-findings task output belongs to prior Run ${firstRunId}, not current Run ${second.run.id}`;
  const endedAt = new Date();
  await db.$transaction([
    db.run.update({ where: { id: second.run.id }, data: {
      status: "SUCCEEDED",
      headSha: SHA,
      endedAt,
      failureReason: null,
    } }),
    db.task.update({ where: { id: task.id }, data: {
      status: TaskStatus.REVIEW,
      failureReason: legacyRefusal,
    } }),
    db.taskActivity.create({ data: {
      taskId: task.id,
      actorType: "control-plane",
      body: `Canonical task output refused: ${legacyRefusal}`,
      metadata: {
        kind: "canonicalTaskOutput.refusal",
        schemaVersion: 1,
        runId: second.run.id,
        reason: legacyRefusal,
      },
    } }),
  ]);

  const queuedThird = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(queuedThird.status, 201, JSON.stringify(queuedThird.body));
  const loaded = await db.task.findUniqueOrThrow({
    where: { id: task.id },
    include: { templateStep: { include: { taskTemplate: { select: { name: true } } } } },
  });
  const handoff = await db.$transaction((tx) => previousRunHandoffForClaim(tx, {
    taskId: task.id,
    runId: queuedThird.body.id as string,
    runNumber: 3,
    templateStep: loaded.templateStep,
  }));
  assert.deepEqual(handoff?.output, {
    runId: firstRunId,
    kind: "review-findings",
    body,
    commitSha: SHA,
  });
});

test("canonical JSON contracts reject malformed bodies and never activate a successor", async () => {
  const malformed = [
    { name: "non-JSON", body: "implementation prose", error: /must be valid JSON/u },
    {
      name: "missing schemaVersion",
      body: JSON.stringify({ headSha: SHA, baseSha: SHA, summary: "implemented", testsRun: ["focused"] }),
      error: /schemaVersion 1 at schemaVersion/u,
    },
    {
      name: "unsupported schemaVersion",
      body: JSON.stringify({ schemaVersion: 2, headSha: SHA, baseSha: SHA, summary: "implemented", testsRun: ["focused"] }),
      error: /schemaVersion 1 at schemaVersion/u,
    },
    {
      name: "kind-specific malformed body",
      body: JSON.stringify({ schemaVersion: 1, headSha: SHA, summary: "implemented", testsRun: ["focused"] }),
      error: /schemaVersion 1 at baseSha/u,
    },
  ];
  for (const fixture of malformed) {
    const seed = await seedTask({
      chained: true,
      outputKind: "implementation",
      templateName: DIRECT_TEMPLATE_NAME,
      stepIndex: 1,
    });
    const successor = await addSuccessor(seed);
    const runId = await enqueue(seed.task.id);
    // A refused output leaves the run with nothing to deliver, which is
    // retryable until the budget is spent; this fixture is about the stop it
    // ends at, so it starts with the last attempt.
    await db.run.update({ where: { id: runId }, data: { maxRunsPerTask: 1 } });
    const claimed = await claimRun(runId, `contract-${fixture.name}`);
    const refused = await call("PUT", `/session/runs/${runId}/output`, claimed.sessionToken, {
      fencingToken: claimed.fencingToken,
      kind: "implementation",
      body: fixture.body,
      commitSha: SHA,
    });
    assert.equal(refused.status, 409, fixture.name);
    assert.match(refused.body.error, fixture.error, fixture.name);

    const completed = await call(
      "POST", `/runner/runs/${runId}/complete`, RUNNER,
      succeededCompletion(`contract-${fixture.name}`, claimed.fencingToken, claimed.run.branch ?? "master"),
    );
    assert.equal(completed.status, 200, `${fixture.name}: ${JSON.stringify(completed.body)}`);
    const stopped = await db.task.findUniqueOrThrow({ where: { id: seed.task.id } });
    assert.equal(stopped.status, TaskStatus.REVIEW, fixture.name);
    assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0, fixture.name);
  }
});

test("a canonical output authored at an earlier head is not restamped at completion", async () => {
  const authoredHead = "a".repeat(40);
  const seed = await seedTask({
    chained: true,
    outputKind: "implementation",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 1,
  });
  const successor = await addSuccessor(seed);
  const runId = await enqueue(seed.task.id);
  const claimed = await claimRun(runId, "stale-authored-head");
  const written = await call("PUT", `/session/runs/${runId}/output`, claimed.sessionToken, {
    fencingToken: claimed.fencingToken,
    kind: "implementation",
    body: implementationOutput("authored before final delivery commit", authoredHead),
    commitSha: authoredHead,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));

  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    succeededCompletion("stale-authored-head", claimed.fencingToken, claimed.run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: seed.task.id } });
  assert.equal(output.commitSha, authoredHead);
  assert.equal((JSON.parse(output.body) as { headSha: string }).headSha, authoredHead);
  const stopped = await db.task.findUniqueOrThrow({ where: { id: seed.task.id } });
  assert.equal(stopped.status, TaskStatus.REVIEW);
  assert.match(stopped.failureReason ?? "", /not completion head/u);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
});

test("completion makes an admitted replacement output lose atomically before successor activation", { timeout: 20_000 }, async () => {
  const seed = await seedTask({
    chained: true,
    outputKind: "implementation",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 1,
  });
  const successor = await addSuccessor(seed);
  const runId = await enqueue(seed.task.id);
  const claimed = await claimRun(runId, "output-completion-race");
  const originalBody = implementationOutput("the immutable accepted handoff");
  assert.equal((await call("PUT", `/session/runs/${runId}/output`, claimed.sessionToken, {
    fencingToken: claimed.fencingToken,
    kind: "implementation",
    body: originalBody,
    commitSha: SHA,
  })).status, 200);

  const completionClient = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  const outputClient = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  let completionLocked!: () => void;
  let outputWaiting!: () => void;
  let releaseCompletion!: () => void;
  const completionHasLock = new Promise<void>((resolve) => { completionLocked = resolve; });
  const outputReachedLock = new Promise<void>((resolve) => { outputWaiting = resolve; });
  const release = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  const instrumentTransactions = (
    client: PrismaClient,
    intercept: (pending: Promise<unknown>) => Promise<unknown>,
  ): PrismaClient => new Proxy(client, { get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const instrumentedTx = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
        return (...args: unknown[]) => intercept(Reflect.apply(txTarget.$queryRaw, txTarget, args));
      } });
      return operation(instrumentedTx);
    }, options as any);
  } }) as PrismaClient;
  let completionIntercepted = false;
  let outputIntercepted = false;
  const completionDb = instrumentTransactions(completionClient, async (pending) => {
    const result = await pending;
    if (!completionIntercepted) {
      completionIntercepted = true;
      completionLocked();
      await release;
    }
    return result;
  });
  const outputDb = instrumentTransactions(outputClient, async (pending) => {
    if (!outputIntercepted) {
      outputIntercepted = true;
      outputWaiting();
    }
    return pending;
  });
  try {
    await withTokens(async () => {
      const completion = createApp(completionDb).request(`/runner/runs/${runId}/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
        body: JSON.stringify(succeededCompletion("output-completion-race", claimed.fencingToken, claimed.run.branch ?? "master")),
      });
      await completionHasLock;
      const replacement = createApp(outputDb).request(`/session/runs/${runId}/output`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          fencingToken: claimed.fencingToken,
          kind: "implementation",
          body: implementationOutput("late replacement must lose"),
          commitSha: SHA,
        }),
      });
      await outputReachedLock;
      releaseCompletion();
      const [completed, replaced] = await Promise.all([completion, replacement]);
      assert.equal(completed.status, 200, await completed.text());
      assert.equal(replaced.status, 409);
      assert.match((await replaced.json() as { error: string }).error, /Stale fencing token/u);
    });
  } finally {
    await Promise.all([completionClient.$disconnect(), outputClient.$disconnect()]);
  }
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: seed.task.id } });
  assert.equal(output.body, originalBody);
  assert.equal(await db.run.count({ where: { taskId: successor.id, status: "QUEUED" } }), 1);
});

test("cancellation holding the Run mutex makes an already-authenticated output lose", { timeout: 20_000 }, async () => {
  const seed = await seedTask({
    chained: true,
    outputKind: "implementation",
    templateName: DIRECT_TEMPLATE_NAME,
    stepIndex: 1,
  });
  const runId = await enqueue(seed.task.id);
  const claimed = await claimRun(runId, "output-cancellation-race");
  const cancellationClient = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  const outputClient = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  let cancellationLocked!: () => void;
  let outputWaiting!: () => void;
  let releaseCancellation!: () => void;
  const cancellationHasLock = new Promise<void>((resolve) => { cancellationLocked = resolve; });
  const outputReachedLock = new Promise<void>((resolve) => { outputWaiting = resolve; });
  const release = new Promise<void>((resolve) => { releaseCancellation = resolve; });
  const instrumentTransactions = (
    client: PrismaClient,
    intercept: (pending: Promise<unknown>) => Promise<unknown>,
  ): PrismaClient => new Proxy(client, { get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const instrumentedTx = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
        return (...args: unknown[]) => intercept(Reflect.apply(txTarget.$queryRaw, txTarget, args));
      } });
      return operation(instrumentedTx);
    }, options as any);
  } }) as PrismaClient;
  let cancellationIntercepted = false;
  let outputIntercepted = false;
  const cancellationDb = instrumentTransactions(cancellationClient, async (pending) => {
    const result = await pending;
    if (!cancellationIntercepted) {
      cancellationIntercepted = true;
      cancellationLocked();
      await release;
    }
    return result;
  });
  const outputDb = instrumentTransactions(outputClient, async (pending) => {
    if (!outputIntercepted) {
      outputIntercepted = true;
      outputWaiting();
    }
    return pending;
  });
  try {
    await withTokens(async () => {
      const cancellation = createApp(cancellationDb).request(`/runs/${runId}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "cancel-output-race", reason: "operator stop" }),
      });
      await cancellationHasLock;
      const output = createApp(outputDb).request(`/session/runs/${runId}/output`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          fencingToken: claimed.fencingToken,
          kind: "implementation",
          body: implementationOutput("late output must lose"),
          commitSha: SHA,
        }),
      });
      await outputReachedLock;
      releaseCancellation();
      const [cancelled, written] = await Promise.all([cancellation, output]);
      assert.equal(cancelled.status, 200, await cancelled.text());
      assert.equal(written.status, 409);
      assert.match((await written.json() as { error: string }).error, /Stale fencing token/u);
    });
  } finally {
    await Promise.all([cancellationClient.$disconnect(), outputClient.$disconnect()]);
  }
  assert.equal(await db.taskStepOutput.count({ where: { taskId: seed.task.id } }), 0);
  const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(run.cancelRequestId, "cancel-output-race");
});

test("canonical approval revision requeues the same Spec, hands off its output, and activates Plan once after replacement approval", async () => {
  const seed = await seedTask({
    chained: true,
    outputKind: "spec",
    templateName: "compound-engineer-workflow",
    stepIndex: 1,
    approvalGate: true,
  });
  const plan = await addSuccessor(seed);
  const firstRunId = await enqueue(seed.task.id);
  const first = await claimRun(firstRunId, "revision-runner-1");
  assert.equal((await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "spec",
    body: specOutput("first specification rejected at approval"),
    commitSha: SHA,
  })).status, 200);
  assert.equal((await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    succeededCompletion("revision-runner-1", first.fencingToken, first.run.branch ?? "master"),
  )).status, 200);

  const firstGate = await db.inboxMessage.findFirstOrThrow({ where: { gateTaskId: seed.task.id, status: "OPEN" } });
  const rejected = await call("POST", `/inbox/messages/${firstGate.id}/decision`, OPERATOR, {
    requestId: "revision-reject",
    decision: "reject",
  });
  assert.equal(rejected.status, 201, JSON.stringify(rejected.body));
  assert.equal(rejected.body.gateAction, "rejected");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seed.task.id } })).status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: plan.id } }), 0);

  const claimed = await call("POST", "/runner/tasks/claim", RUNNER, {
    runnerId: "revision-runner-2",
    leaseSeconds: 60,
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.task.id, seed.task.id);
  assert.deepEqual(claimed.body.previousRunHandoff, {
    schemaVersion: 1,
    previousRunId: firstRunId,
    status: "SUCCEEDED",
    failureReason: null,
    retryReason: "approval-rejected-without-feedback",
    salvage: null,
    output: {
      runId: firstRunId,
      kind: "spec",
      body: specOutput("first specification rejected at approval"),
      commitSha: SHA,
    },
  });
  // A fresh branch/head alone is not approval evidence: Plan remains closed
  // until this Run publishes and completes a replacement persisted artifact.
  await db.run.update({ where: { id: claimed.body.run.id }, data: { headSha: "d".repeat(40) } });
  assert.equal(await db.run.count({ where: { taskId: plan.id } }), 0);

  const secondRunId = claimed.body.run.id as string;
  const replacementBody = specOutput("replacement specification accepted at approval");
  const replacement = await call("PUT", `/session/runs/${secondRunId}/output`, claimed.body.sessionToken, {
    fencingToken: claimed.body.fencingToken,
    kind: "spec",
    body: replacementBody,
    commitSha: SHA,
  });
  assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
  const completed = await call(
    "POST", `/runner/runs/${secondRunId}/complete`, RUNNER,
    succeededCompletion("revision-runner-2", claimed.body.fencingToken, claimed.body.run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const secondGate = await db.inboxMessage.findFirstOrThrow({ where: { gateTaskId: seed.task.id, status: "OPEN" } });
  const approved = await call("POST", `/inbox/messages/${secondGate.id}/decision`, OPERATOR, {
    requestId: "revision-approve",
    decision: "approve",
  });
  assert.equal(approved.status, 201, JSON.stringify(approved.body));
  assert.equal(approved.body.gateAction, "approved");
  assert.equal(await db.run.count({ where: { taskId: plan.id } }), 1);
  assert.equal(await db.run.count({ where: { taskId: plan.id, status: "QUEUED" } }), 1);
  assert.equal((await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: seed.task.id } })).body, replacementBody);
});
