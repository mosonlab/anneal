import { setTimeout as delay } from "node:timers/promises";
import { createGitHubReader, type BranchAncestryReader } from "./github-read.js";
import { READINESS_READ_BUDGET_MS } from "./readiness-decision.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";

import {
  AssigneeType,
  CleanupStatus,
  DependencyProvisioning,
  INTEGRATOR_TEMPLATE_NAME,
  MergeRecoveryStatus,
  PushStatus,
  REGRESSION_VERIFICATION_OUTPUT_KIND,
  templateRolloverName,
  PrismaClient,
  TaskStatus,
  asJsonObject,
  enqueueTaskRun,
  latestMarker,
  readMarkerHistory,
  readMarkers,
} from "@anneal/db";

import {
  MERGE_TAIL_REPAIR_BINDING_MISMATCH,
  MERGE_TAIL_REPAIR_BINDING_MISMATCH_KIND,
  handleRegressionCompletion,
} from "./merge-tail-actions.js";
import { type ReleaseMergeLease } from "./merge-lease.js";
import { completeRun } from "./run-completion.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const BRANCH = "agentos/repair-test";
const RESOLVED = "c".repeat(40);
const REPAIRED = "d".repeat(40);
const REPAIRED_AGAIN = "e".repeat(40);
const exec = promisify(execFile);

let seedCounter = 0;

// A real chain reaches Regression with the brief, the acceptance criteria, and
// both review reports already persisted. The repair task is chain-detached, so
// these are the bodies it can only see if the repair prompt carries them.
const IMPLEMENTATION_BODY = "Feature brief: reject unregistered graphs at every entry point. Acceptance: the webhook and manual fire paths refuse them too.";
const SOL_FINDINGS_BODY = "review-findings: MF-2 the HTTP layer validates but the webhook path calls the executor directly.";
const BLIND_FINDINGS_BODY = "blind-findings: the manual fire path repeats the same bypass and the board reads the retired field.";

type RegressionSeedOptions = {
  withLibrarian?: boolean;
  withLibrarianHistory?: boolean;
  templateName?: string;
  gateFailureExcerpt?: string;
  /** Give the canonical conflict resolver an operator-chosen name, as R9 allows. */
  renamedResolver?: boolean;
  repairProfile?: "recorded" | "default" | "empty" | "archived" | "operator" | "webhook";
};

const seedRegression = async (options: RegressionSeedOptions = {}) => {
  // A test may seed several chains in one millisecond, and both the slug and the
  // chain id have to stay distinct across them.
  const seedId = `${Date.now()}-${(seedCounter += 1)}`;
  const project = await db.project.create({ data: { name: "Repair", slug: `repair-${seedId}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const makeAgent = (name: string) => db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name, title: name,
    model: "gpt-5.6-sol:high", runnerPreference: "CODEX", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const [regressionAgent, resolverAgent, fixAgent, reviewAgent, librarianAgent] = await Promise.all([
    makeAgent("code-reviewer-sol-high"), makeAgent("merge-resolver-opus-medium"), makeAgent("senior-dev-astra-medium"),
    makeAgent("review-coordinator-astra-medium"), makeAgent("librarian-luna-xhigh"),
  ]);
  if (options.renamedResolver) {
    await db.agent.update({ where: { id: resolverAgent.id }, data: {
      canonicalRole: "merge-resolver-opus-medium",
      name: "conflict-resolver",
      customizedFields: ["name"],
    } });
  }
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "widgets", remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo", defaultBranch: "main", dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  for (const agent of [regressionAgent, resolverAgent, fixAgent, reviewAgent, librarianAgent]) {
    await db.agentRepoAccess.create({ data: {
      projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE",
    } });
  }
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: options.templateName ?? (options.withLibrarian ? INTEGRATOR_TEMPLATE_NAME : "direct-engineer-workflow"),
    description: "tail", variables: [],
  } });
  const fixIndex = options.withLibrarian ? 8 : 4;
  const fixLayer = options.withLibrarian ? 7 : 3;
  const librarianIndex = 9;
  const librarianLayer = 8;
  const regressionIndex = options.withLibrarian ? 10 : 5;
  const regressionLayer = options.withLibrarian ? 9 : 4;
  const readinessIndex = options.withLibrarian ? 11 : 6;
  const readinessLayer = options.withLibrarian ? 10 : 5;
  const [fixStep, regressionStep, readinessStep, librarianStep] = await Promise.all([
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: fixIndex, layer: fixLayer, name: "Fix", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: fixAgent.id, prompt: "fix", approvalGate: false, outputKind: "fixed-implementation",
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: regressionIndex, layer: regressionLayer, name: "Regression", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: regressionAgent.id, prompt: "verify", approvalGate: false, outputKind: "regression-verification",
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: readinessIndex, layer: readinessLayer, name: "Readiness", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: reviewAgent.id, prompt: "authorize", approvalGate: false, outputKind: "merge-authorization",
    } }),
    options.withLibrarian ? db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: librarianIndex, layer: librarianLayer, name: "Librarian", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: librarianAgent.id, prompt: "document", approvalGate: false, outputKind: "documentation",
    } }) : null,
  ]);
  const chainId = `chain-${seedId}`;
  const fix = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: fixStep.id,
    name: "Fix", description: "fix", assigneeType: AssigneeType.AGENT, assigneeAgentId: fixAgent.id,
    status: TaskStatus.DONE, chainId, chainIndex: fixIndex, chainLayer: fixLayer, targetBranch: "main",
  } });
  for (const prior of options.withLibrarian
    ? [
      { index: 4, name: "Implementation", kind: "implementation", body: IMPLEMENTATION_BODY },
      { index: 5, name: "Sol review", kind: "review-findings", body: SOL_FINDINGS_BODY },
      { index: 6, name: "Blind review", kind: "blind-findings", body: BLIND_FINDINGS_BODY },
    ]
    : [
      { index: 0, name: "Implementation", kind: "implementation", body: IMPLEMENTATION_BODY },
      { index: 1, name: "Sol review", kind: "review-findings", body: SOL_FINDINGS_BODY },
      { index: 2, name: "Blind review", kind: "blind-findings", body: BLIND_FINDINGS_BODY },
    ]) {
    const step = await db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: prior.index, layer: prior.index, name: prior.name,
      assigneeType: AssigneeType.AGENT, assigneeAgentId: fixAgent.id, prompt: prior.name.toLowerCase(),
      approvalGate: false, outputKind: prior.kind,
    } });
    const priorTask = await db.task.create({ data: {
      projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: step.id,
      name: prior.name, description: prior.name, assigneeType: AssigneeType.AGENT, assigneeAgentId: fixAgent.id,
      status: TaskStatus.DONE, chainId, chainIndex: prior.index, chainLayer: prior.index, targetBranch: "main",
    } });
    const priorRun = await db.run.create({ data: {
      projectId: project.id, taskId: priorTask.id, agentId: fixAgent.id, repoId: repo.id,
      runNumber: 1, dedupeKey: `task:${priorTask.id}:run:1`, runner: "CODEX", model: fixAgent.model,
      promptHash: "hash", status: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH,
      targetBranch: "main", headSha: HEAD,
    } });
    await db.taskStepOutput.create({ data: {
      taskId: priorTask.id, runId: priorRun.id, kind: prior.kind, body: prior.body, commitSha: HEAD,
    } });
  }
  const librarian = librarianStep ? await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: librarianStep.id,
    name: "Librarian", description: "document", assigneeType: AssigneeType.AGENT, assigneeAgentId: librarianAgent.id,
    status: TaskStatus.DONE, chainId, chainIndex: librarianIndex, chainLayer: librarianLayer, targetBranch: "main",
  } }) : null;
  if (librarian && options.withLibrarianHistory) {
    const librarianRun = await db.run.create({ data: {
      projectId: project.id, taskId: librarian.id, agentId: librarianAgent.id, repoId: repo.id,
      runNumber: 1, dedupeKey: `task:${librarian.id}:run:1`, runner: "CODEX", model: librarianAgent.model,
      promptHash: "hash", status: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH,
      targetBranch: "main", headSha: HEAD,
    } });
    await db.taskStepOutput.create({ data: {
      taskId: librarian.id,
      runId: librarianRun.id,
      kind: "documentation",
      body: JSON.stringify({
        schemaVersion: 1,
        headSha: HEAD,
        summary: "Original documentation is current.",
        changes: [],
      }),
      commitSha: HEAD,
    } });
  }
  const regression = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: regressionStep.id,
    name: "Regression", description: "verify", assigneeType: AssigneeType.AGENT, assigneeAgentId: regressionAgent.id,
    status: TaskStatus.DOING, chainId, chainIndex: regressionIndex, chainLayer: regressionLayer, targetBranch: "main",
  } });
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: regression.id, agentId: regressionAgent.id, repoId: repo.id,
    runNumber: 1, dedupeKey: `task:${regression.id}:run:1`, runner: "CODEX", model: regressionAgent.model,
    promptHash: "hash", status: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH,
    targetBranch: "main", headSha: HEAD,
  } });
  const session = await db.session.create({ data: {
    runId: run.id, projectId: project.id, agentId: regressionAgent.id, taskId: regression.id,
    runner: "CODEX", executionStatus: "SUCCEEDED",
  } });
  const repairAgent = options.repairProfile ? await makeAgent("senior-dev-luna-max") : null;
  if (repairAgent) {
    await db.agentRepoAccess.create({ data: {
      projectId: project.id, agentId: repairAgent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE",
    } });
    const profile = await db.staffingProfile.create({ data: {
      projectId: project.id, taskTemplateId: template.id, name: "Repair staffing",
      isDefault: options.repairProfile === "default",
      mergeTailRepairAgentId: options.repairProfile === "empty" ? null : repairAgent.id,
    } });
    if (options.repairProfile === "default") {
      const root = await db.task.findFirstOrThrow({ where: { chainId }, orderBy: { chainIndex: "asc" } });
      await db.taskActivity.create({ data: {
        taskId: root.id, actorType: "operator", body: "ordinary note with colliding metadata",
        metadata: { staffingProfileId: "not-instantiation-provenance" },
      } });
    }
    if (options.repairProfile !== "default") {
      // A different current default must not override the recorded profile.
      await db.staffingProfile.create({ data: {
        projectId: project.id, taskTemplateId: template.id, name: "Other default", isDefault: true,
        mergeTailRepairAgentId: reviewAgent.id,
      } });
      const root = await db.task.findFirstOrThrow({ where: { chainId }, orderBy: { chainIndex: "asc" } });
      await db.taskActivity.create({ data: {
        taskId: root.id, actorType: options.repairProfile === "operator" || options.repairProfile === "webhook"
          ? options.repairProfile : "control-plane", body: "Template instantiated",
        metadata: { staffingProfileId: profile.id },
      } });
    }
    if (options.repairProfile === "archived") {
      await db.agent.update({ where: { id: repairAgent.id }, data: { archivedAt: new Date() } });
    }
  }
  return { project, template, repo, regressionAgent, resolverAgent, reviewAgent, repairAgent, readinessStep, regression, librarian, fix, run, session };
};

const verdict = (outcome: RegressionOutcome, headSha: string = HEAD, gateFailureExcerpt?: string) => JSON.stringify(outcome === "refresh-conflict"
  ? { schemaVersion: 1, outcome, headSha, baseHeadSha: BASE, summary: "merge conflict" }
  : outcome === "review-fail"
    ? { schemaVersion: 1, outcome, headSha, baseHeadSha: BASE, summary: "MF-2 remains open" }
    : {
      schemaVersion: 1,
      outcome,
      headSha,
      baseHeadSha: BASE,
      gateVerdict: "FAIL",
      summary: "suite failed",
      ...(gateFailureExcerpt === undefined ? {} : { gateFailureExcerpt }),
    });

type RegressionOutcome = "refresh-conflict" | "review-fail" | "gate-fail";

const exercise = async (
  outcome: RegressionOutcome,
  options: RegressionSeedOptions & { branch?: string } = {},
) => {
  const seeded = await seedRegression(options);
  await db.taskStepOutput.create({ data: {
    taskId: seeded.regression.id, runId: seeded.run.id, kind: "regression-verification",
    body: verdict(outcome, HEAD, options.gateFailureExcerpt), commitSha: HEAD,
  } });
  const input = {
    task: seeded.regression,
    run: {
      id: seeded.run.id, agentId: seeded.regressionAgent.id,
      branch: options.branch ?? BRANCH, headSha: HEAD, sessionId: seeded.session.id,
    },
    now: new Date(),
  };
  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, input)), "handled");
  return { ...seeded, input };
};

const repairFor = (
  seeded: Awaited<ReturnType<typeof exercise>>,
  repairKind: "refresh-conflict" | "review-fix" | "gate-fix",
) => db.task.findFirstOrThrow({ where: {
  projectId: seeded.project.id,
  name: `Autonomous merge tail: ${repairKind}`,
} });

/**
 * The next turn of the repair loop, as the tail actually runs it: the queued
 * Regression Run the last repair completion created publishes its own verdict,
 * bound to that Run and to the head the repair produced, and completes.
 *
 * Re-invoking the first completion would exercise the attempt counter without
 * exercising the loop it bounds.
 */
const failRegressionAgain = async (
  seeded: Awaited<ReturnType<typeof exercise>>,
  outcome: RegressionOutcome,
  runNumber: number,
  headSha: string,
) => {
  const run = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id, runNumber } });
  await db.run.update({ where: { id: run.id }, data: {
    status: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH, targetBranch: "main", headSha,
  } });
  const session = await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, agentId: seeded.regressionAgent.id, taskId: seeded.regression.id,
    runner: "CODEX", executionStatus: "SUCCEEDED",
  } });
  await db.taskStepOutput.update({ where: { taskId: seeded.regression.id }, data: {
    runId: run.id, body: verdict(outcome, headSha), commitSha: headSha,
  } });
  return db.$transaction((tx) => handleRegressionCompletion(tx, {
    task: seeded.regression,
    run: { id: run.id, agentId: seeded.regressionAgent.id, branch: BRANCH, headSha, sessionId: session.id },
    now: new Date(),
  }));
};

const repairCount = (seeded: Awaited<ReturnType<typeof exercise>>) => db.task.count({ where: {
  projectId: seeded.project.id,
  name: { startsWith: "Autonomous merge tail:" },
} });

const completeRepair = async (
  seeded: Awaited<ReturnType<typeof seedRegression>>,
  repairId: string,
  output: string,
  headSha: string | null = RESOLVED,
  runNumber = 1,
  repositoryReader?: BranchAncestryReader,
) => {
  const run = await db.run.findFirstOrThrow({ where: { taskId: repairId, runNumber } });
  const repair = await db.task.findUniqueOrThrow({ where: { id: repairId } });
  // The control plane declared this Run's head at birth; a fixture that
  // rebuilds the name here would stop proving that it did.
  const publishBranch = run.branch;
  assert.ok(publishBranch, `repair Run ${runNumber} was born without a publish head`);
  const runnerId = `repair-runner-${run.id}`;
  const fencingToken = `repair:${run.id}:1`;
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", runnerId, fencingToken, leaseExpiresAt: new Date(Date.now() + 60_000),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, agentId: repair.assigneeAgentId!, taskId: repair.id,
    runner: "CODEX", executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: repair.id }, data: { status: TaskStatus.DOING } });
  await db.taskStepOutput.create({ data: {
    taskId: repair.id, runId: run.id, kind: "result", body: output, commitSha: headSha,
  } });
  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "merge-tail-repair-token";
  try {
    const response = await createApp(db, { repositoryReader }).request(`/runner/runs/${run.id}/complete`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-repair-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId, fencingToken, exitCode: 0, outcome: { case: "succeeded" },
        cleanupStatus: "SUCCEEDED", branch: publishBranch, pushedBranch: publishBranch,
        pushStatus: "SUCCEEDED", headSha,
      }),
    });
    assert.equal(response.status, 200, await response.text());
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = prior;
  }
};

/**
 * The failure the repair budget exists for: the agent delivered its commit and
 * the provider stream dropped on the way out, so the completion arrives with a
 * clean exit and no terminal success. It is retryable and it is the agent's own
 * EXECUTE phase, so it neither refunds nor raises the ceiling.
 */
const failRepairAfterDelivery = async (
  seeded: Awaited<ReturnType<typeof seedRegression>>,
  repairId: string,
  runNumber: number,
  headSha: string,
  pushedBranch = BRANCH,
) => {
  const run = await db.run.findFirstOrThrow({ where: { taskId: repairId, runNumber } });
  const repair = await db.task.findUniqueOrThrow({ where: { id: repairId } });
  const runnerId = `repair-runner-${run.id}`;
  const fencingToken = `repair:${run.id}:1`;
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", runnerId, fencingToken, leaseExpiresAt: new Date(Date.now() + 60_000),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, agentId: repair.assigneeAgentId!, taskId: repair.id,
    runner: "CODEX", executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: repair.id }, data: { status: TaskStatus.DOING } });
  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "merge-tail-repair-token";
  try {
    const response = await createApp(db).request(`/runner/runs/${run.id}/complete`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-repair-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId, fencingToken, exitCode: 0,
        cleanupStatus: "SUCCEEDED", branch: BRANCH, pushedBranch,
        pushStatus: "SUCCEEDED", headSha,
        outcome: {
          case: "provider-failure",
          reason: "stream disconnected before completion: tls handshake eof",
          envelope: {
            version: 1, phase: "EXECUTE", agentExited: true, exitCode: 0, signal: null,
            terminationReason: null, timedOut: false, timeoutMs: null, transient: false,
            runnerClass: "PROTOCOL_ERROR",
            providerError: "stream disconnected before completion: tls handshake eof",
            stderrSummary: null, stdoutSummary: null,
            terminalEventSeen: false, terminalSuccess: false,
          },
        },
      }),
    });
    assert.equal(response.status, 200, await response.text());
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = prior;
  }
  return db.run.findUniqueOrThrow({ where: { id: run.id } });
};

const completeDocumentation = async (
  seeded: Awaited<ReturnType<typeof seedRegression>>,
  headSha: string,
) => {
  assert.ok(seeded.librarian);
  const run = await db.run.findFirstOrThrow({
    where: { taskId: seeded.librarian.id, status: "QUEUED" },
    orderBy: { runNumber: "desc" },
  });
  const step = await db.taskTemplateStep.findUniqueOrThrow({ where: { id: seeded.librarian.templateStepId! } });
  const runnerId = `librarian-runner-${run.id}`;
  const fencingToken = `librarian:${run.id}:1`;
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", runnerId, fencingToken, leaseExpiresAt: new Date(Date.now() + 60_000),
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: seeded.project.id,
    agentId: seeded.librarian.assigneeAgentId!,
    taskId: seeded.librarian.id,
    runner: "CODEX",
    executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: seeded.librarian.id }, data: { status: TaskStatus.DOING } });
  const output = {
    runId: run.id,
    kind: step.outputKind,
    body: JSON.stringify({
      schemaVersion: 1,
      headSha,
      summary: "Documentation refreshed for the repaired head.",
      changes: [],
    }),
    commitSha: headSha,
  };
  await db.taskStepOutput.upsert({
    where: { taskId: seeded.librarian.id },
    create: { taskId: seeded.librarian.id, ...output },
    update: output,
  });

  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "merge-tail-librarian-token";
  try {
    const response = await createApp(db).request(`/runner/runs/${run.id}/complete`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-librarian-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId,
        fencingToken,
        exitCode: 0,
        outcome: { case: "succeeded" },
        cleanupStatus: "SUCCEEDED",
        branch: BRANCH,
        pushedBranch: BRANCH,
        pushStatus: "SUCCEEDED",
        headSha,
      }),
    });
    assert.equal(response.status, 200, await response.text());
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = prior;
  }
  return db.run.findUniqueOrThrow({ where: { id: run.id } });
};

const claimNext = async () => {
  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "merge-tail-claim-token";
  try {
    const response = await createApp(db).request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-claim-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "merge-tail-claim-runner", leaseSeconds: 60 }),
    });
    return { status: response.status, body: response.status === 200 ? await response.json() : null };
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = prior;
  }
};

test("successful auxiliary repair completion preserves success when its chain target or target assignee is archived", async () => {
  for (const mode of ["task", "assignee"] as const) {
    await resetTestDb(db);
    const seeded = await exercise("gate-fail");
    const repair = await repairFor(seeded, "gate-fix");
    if (mode === "task") {
      await db.task.update({ where: { id: seeded.regression.id }, data: { archivedAt: new Date() } });
    } else {
      await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.BACKLOG } });
      await db.agent.update({ where: { id: seeded.regressionAgent.id }, data: { archivedAt: new Date() } });
      await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.TODO } });
    }

    await completeRepair(seeded, repair.id, "repair completed", HEAD);
    const completedRun = await db.run.findFirstOrThrow({ where: { taskId: repair.id }, orderBy: { runNumber: "desc" } });
    assert.equal(completedRun.status, "SUCCEEDED", mode);
    assert.equal(await db.run.count({ where: { taskId: seeded.regression.id, status: "QUEUED" } }), 0, mode);
    const target = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
    if (mode === "assignee") {
      assert.equal(target.status, TaskStatus.REVIEW);
      assert.match(target.failureReason ?? "", /archived/u);
    }
    assert.equal(await db.taskActivity.count({
      where: { taskId: seeded.regression.id, body: { contains: mode === "task" ? "target is archived" : "assignee" } },
    }), 1, mode);
  }
});

test("a repair Run that fails retryably opens a second Run instead of stopping the tail", async () => {
  const seeded = await exercise("review-fail");
  const repair = await repairFor(seeded, "review-fix");
  assert.equal(repair.maxSessionsPerTask, 2);

  const failed = await failRepairAfterDelivery(seeded, repair.id, 1, REPAIRED);
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.failureClass, "PROTOCOL_ERROR");
  assert.equal(failed.retryable, true);

  const retry = await db.run.findFirstOrThrow({ where: { taskId: repair.id, runNumber: 2 } });
  assert.equal(retry.status, "QUEUED");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: repair.id } })).status, TaskStatus.DOING);
  // The tail is still open: a stopped tail files this notice and moves its
  // regression task out of the repair loop.
  assert.equal(await db.inboxMessage.count({
    where: { taskId: seeded.regression.id, body: { startsWith: "Autonomous merge tail stopped:" } },
  }), 0);
  assert.equal(await repairCount(seeded), 1);

  // The second Run closes the repair the first one had already delivered, and
  // the tail reads the same four facts it reads after any healthy repair.
  await completeRepair(seeded, repair.id, "repair completed", REPAIRED, 2);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: repair.id } })).status, TaskStatus.DONE);
  const closed = await db.run.findFirstOrThrow({ where: { taskId: repair.id, runNumber: 2 } });
  assert.equal(closed.status, "SUCCEEDED");
  assert.equal(closed.pushedBranch, BRANCH);
  const marker = latestMarker(await readMarkers(db, seeded.regression.id), "repairResult");
  assert.equal(marker?.repairKind, "review-fix");
  assert.equal(marker?.state, null);
});

test("retryable repairs retain the shared publish head while retrying from salvage", async () => {
  const cases = [
    { outcome: "refresh-conflict", repairKind: "refresh-conflict" },
    { outcome: "review-fail", repairKind: "review-fix" },
    { outcome: "gate-fail", repairKind: "gate-fix" },
  ] as const;

  for (const [index, { outcome, repairKind }] of cases.entries()) {
    if (index > 0) await resetTestDb(db);
    const seeded = await exercise(outcome);
    const repair = await repairFor(seeded, repairKind);
    const salvageBranch = `agentos/${repair.id}/run-1`;

    const failed = await failRepairAfterDelivery(seeded, repair.id, 1, REPAIRED, salvageBranch);
    assert.equal(failed.branch, BRANCH, repairKind);
    assert.equal(failed.pushedBranch, salvageBranch, repairKind);
    assert.equal(failed.pushStatus, "SUCCEEDED", repairKind);

    const retry = await db.run.findFirstOrThrow({ where: { taskId: repair.id, runNumber: 2 } });
    assert.equal(retry.status, "QUEUED", repairKind);
    assert.equal(retry.branch, BRANCH, repairKind);
    assert.equal(retry.targetBranch, salvageBranch, repairKind);

    const output = repairKind === "refresh-conflict"
      ? JSON.stringify({
        schemaVersion: 1, outcome: "resolved", startHeadSha: HEAD, targetHeadSha: BASE,
        resolvedHeadSha: REPAIRED, tradeOffs: [], changedTestExpectations: [],
      })
      : `${repairKind} completed`;
    await completeRepair(seeded, repair.id, output, REPAIRED, 2);
    const completed = await db.run.findFirstOrThrow({ where: { taskId: repair.id, runNumber: 2 } });
    assert.equal(completed.status, "SUCCEEDED", repairKind);
    assert.equal(completed.pushedBranch, BRANCH, repairKind);
    assert.equal(completed.pushStatus, "SUCCEEDED", repairKind);

    const claimed = await claimNext();
    assert.equal(claimed.status, 200, repairKind);
    const body = claimed.body as {
      regressionRepairHandoff: {
        repair: { taskId: string; resolvedHeadSha: string };
      };
    };
    assert.equal(body.regressionRepairHandoff.repair.taskId, repair.id, repairKind);
    assert.equal(body.regressionRepairHandoff.repair.resolvedHeadSha, REPAIRED, repairKind);
  }
});

test("a repair whose whole budget fails retryably still stops the tail", async () => {
  const seeded = await exercise("review-fail");
  const repair = await repairFor(seeded, "review-fix");

  await failRepairAfterDelivery(seeded, repair.id, 1, REPAIRED);
  const exhausted = await failRepairAfterDelivery(seeded, repair.id, 2, REPAIRED);
  assert.equal(exhausted.status, "FAILED");

  assert.equal(await db.run.count({ where: { taskId: repair.id } }), 2);
  assert.equal(await db.inboxMessage.count({
    where: { taskId: seeded.regression.id, body: { startsWith: "Autonomous merge tail stopped:" } },
  }), 1);
});

test("a refresh conflict creates exactly one resolver and its completion re-runs regression", async () => {
  const seeded = await exercise("refresh-conflict");
  const repair = await repairFor(seeded, "refresh-conflict");
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: repair.assigneeAgentId! } })).name, "merge-resolver-opus-medium");
  assert.equal(await repairCount(seeded), 1);
  await completeRepair(seeded, repair.id, JSON.stringify({
    schemaVersion: 1, outcome: "resolved", startHeadSha: HEAD, targetHeadSha: BASE,
    resolvedHeadSha: RESOLVED, tradeOffs: [], changedTestExpectations: [],
  }));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);
  const result = latestMarker(await readMarkers(db, seeded.regression.id), "repairResult");
  assert.equal(result?.startHeadSha, HEAD);
  assert.equal(result?.resolvedHeadSha, RESOLVED);

  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, seeded.input)), "handled");
  assert.equal(await repairCount(seeded), 1);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
});

test("a resolver result whose tradeOffs entries are objects still binds start to target", async () => {
  // The role prompt asks the resolver to record "the exact trade-off", which a
  // model renders as an entry per conflicting file. A repair that committed a
  // real merge is accepted rather than rejected as malformed.
  const seeded = await exercise("refresh-conflict");
  const repair = await repairFor(seeded, "refresh-conflict");
  await completeRepair(seeded, repair.id, JSON.stringify({
    schemaVersion: 1,
    outcome: "resolved",
    startHeadSha: HEAD,
    targetHeadSha: BASE,
    resolvedHeadSha: RESOLVED,
    tradeOffs: [{
      file: "packages/db/src/merge-tail.ts",
      decision: "kept main's fail-loud rejection",
      reason: "the branch's fallback contradicts current main's stated goal",
      intentPreserved: true,
    }],
    changedTestExpectations: [],
  }));

  assert.equal((await db.task.findUniqueOrThrow({ where: { id: repair.id } })).status, TaskStatus.DONE);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.TODO);
  const result = latestMarker(await readMarkers(db, seeded.regression.id), "repairResult");
  assert.equal(result?.state, null);
  assert.equal(result?.startHeadSha, HEAD);
  assert.equal(result?.raw.targetHeadSha, BASE);
  assert.equal(result?.resolvedHeadSha, RESOLVED);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);

  const claimed = await claimNext();
  assert.equal(claimed.status, 200);
  const body = claimed.body as {
    regressionRepairHandoff: { repair: { kind: string; taskId: string; resolvedHeadSha: string } };
  };
  assert.equal(body.regressionRepairHandoff.repair.kind, "refresh-conflict");
  assert.equal(body.regressionRepairHandoff.repair.taskId, repair.id);
  assert.equal(body.regressionRepairHandoff.repair.resolvedHeadSha, RESOLVED);
});

test("a rejected resolver output records its offending key and the retry refusal names the repair task", async () => {
  const seeded = await exercise("refresh-conflict");
  const repair = await repairFor(seeded, "refresh-conflict");
  await completeRepair(seeded, repair.id, JSON.stringify({
    schemaVersion: 1,
    outcome: "resolved",
    startHeadSha: HEAD,
    targetHeadSha: BASE,
    resolvedHeadSha: RESOLVED,
    tradeOffs: [42],
    changedTestExpectations: [],
  }));

  // The rejection is on the resolver's own card, with the key that failed.
  const rejection = latestMarker(await readMarkers(db, repair.id), "repairResult");
  assert.equal(rejection?.state, "invalid-output");
  assert.equal(rejection?.raw.rejectedKey, "tradeOffs");
  assert.match(String(rejection?.raw.reason ?? ""), /tradeOffs/u);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.REVIEW);

  // An operator retry of the parked Regression is refused, and the refusal says
  // which repair task produced the output that was thrown away.
  await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.TODO } });
  const retry = await db.$transaction((tx) => enqueueTaskRun(tx, seeded.regression.id));
  assert.equal((await claimNext()).status, 204);
  const stopped = await db.run.findUniqueOrThrow({ where: { id: retry.id } });
  assert.equal(stopped.status, "FAILED");
  assert.match(stopped.failureReason ?? "", new RegExp(`repair task ${repair.id} returned invalid output`, "u"));
});

test("a renamed canonical resolver still receives the refresh-conflict repair", async () => {
  // R9: `canonicalRole` is the Agent's identity and `name` is the operator's
  // label. Addressing the resolver by name meant a legitimate rename turned
  // every refresh conflict into "required repair agent absent".
  const seeded = await exercise("refresh-conflict", { renamedResolver: true });
  const repair = await repairFor(seeded, "refresh-conflict");

  assert.equal(repair.assigneeAgentId, seeded.resolverAgent.id);
  const assignee = await db.agent.findUniqueOrThrow({ where: { id: repair.assigneeAgentId! } });
  assert.equal(assignee.name, "conflict-resolver");
  assert.equal(assignee.canonicalRole, "merge-resolver-opus-medium");
  assert.equal(await db.inboxMessage.count({
    where: { taskId: seeded.regression.id, body: { startsWith: "Autonomous merge tail stopped:" } },
  }), 0);
});

test("a gate FAIL is repaired three times and the fourth FAIL escalates with both heads in activity", async () => {
  const seeded = await exercise("gate-fail");
  const first = await repairFor(seeded, "gate-fix");
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: first.assigneeAgentId! } })).name, "senior-dev-astra-medium");
  await completeRepair(seeded, first.id, "Fixed the failing regression and reran the affected suite.", RESOLVED);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);
  // The first repair moved the tree, so this FAIL is a verdict on a different
  // head and buys one more automatic attempt rather than a stop.
  assert.equal(await failRegressionAgain(seeded, "gate-fail", 2, RESOLVED), "handled");
  assert.equal(await repairCount(seeded), 2);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
  const second = await db.task.findFirstOrThrow({
    where: { projectId: seeded.project.id, name: "Autonomous merge tail: gate-fix" },
    orderBy: { createdAt: "desc" },
  });
  await completeRepair(seeded, second.id, "Fixed the remaining failure and reran the affected suite.", REPAIRED);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 3);
  assert.equal(await failRegressionAgain(seeded, "gate-fail", 3, REPAIRED), "handled");
  assert.equal(await repairCount(seeded), 3);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
  const third = await db.task.findFirstOrThrow({
    where: { projectId: seeded.project.id, name: "Autonomous merge tail: gate-fix" },
    orderBy: { createdAt: "desc" },
  });
  await completeRepair(seeded, third.id, "Fixed the last failure and reran the affected suite.", REPAIRED_AGAIN);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 4);
  assert.equal(await failRegressionAgain(seeded, "gate-fail", 4, REPAIRED_AGAIN), "handled");
  assert.equal(await repairCount(seeded), 3);
  const notice = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  assert.match(notice.body, /after 3 automatic repair attempts/u);
  const trail = await db.taskActivity.findMany({ where: { taskId: seeded.regression.id }, select: { body: true } });
  assert.match(trail.map(({ body }) => body).join("\n"), new RegExp(`${HEAD}.*${BASE}`, "s"));
});

test("a gate-fix prompt renders its failure excerpt while other repair prompts remain unchanged", async () => {
  const excerpt = [
    "not ok 1 - packages/api/src/merge-tail.test.ts",
    "AssertionError: expected gate failure excerpt",
  ].join("\n");
  const gateSeeded = await exercise("gate-fail", { gateFailureExcerpt: excerpt });
  const gateRepair = await repairFor(gateSeeded, "gate-fix");
  const gateContext = [
    "Persisted outputs from prior template steps:",
    `## Implementation (implementation)\n${IMPLEMENTATION_BODY}`,
  ].join("\n\n");
  assert.equal(gateRepair.description, [
    `Repair the autonomous merge tail failure at ${HEAD} against target ${BASE}.`,
    "suite failed",
    "Gate failure excerpt",
    excerpt,
    "Make exactly the changes needed to close this failure, run affected suites, commit, and persist the result as task output. Before changing any shared type, schema, or route contract, enumerate its callers across every workspace, including apps/web, and update or test each one in the same change.",
    gateContext,
  ].join("\n\n"));

  await resetTestDb(db);
  const reviewSeeded = await exercise("review-fail");
  const reviewRepair = await repairFor(reviewSeeded, "review-fix");
  const reviewContext = [
    "Persisted outputs from prior template steps:",
    `## Implementation (implementation)\n${IMPLEMENTATION_BODY}`,
    `## Sol review (review-findings)\n${SOL_FINDINGS_BODY}`,
    `## Blind review (blind-findings)\n${BLIND_FINDINGS_BODY}`,
  ].join("\n\n");
  assert.equal(reviewRepair.description, [
    `Repair the autonomous merge tail failure at ${HEAD} against target ${BASE}.`,
    "MF-2 remains open",
    "Make exactly the changes needed to close this failure, run affected suites, commit, and persist the result as task output. Before changing any shared type, schema, or route contract, enumerate its callers across every workspace, including apps/web, and update or test each one in the same change.",
    reviewContext,
  ].join("\n\n"));

  await resetTestDb(db);
  const conflictSeeded = await exercise("refresh-conflict");
  const conflictRepair = await repairFor(conflictSeeded, "refresh-conflict");
  const conflictContext = [
    "Persisted outputs from prior template steps:",
    `## Implementation (implementation)\n${IMPLEMENTATION_BODY}`,
  ].join("\n\n");
  assert.equal(conflictRepair.description, [
    `Resolve the refresh conflict between chain head ${HEAD} and target head ${BASE}.`,
    "merge conflict",
    `Re-run the merge, preserve both intents under the merge-resolver-opus-medium role contract, commit the resolution, and persist the role's versioned JSON bound to start ${HEAD} and target ${BASE}.`,
    conflictContext,
  ].join("\n\n"));
});

test("a semantic FAIL skips the gate path and is repaired three times before it escalates", async () => {
  const seeded = await exercise("review-fail");
  const first = await repairFor(seeded, "review-fix");
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: first.assigneeAgentId! } })).name, "senior-dev-astra-medium");
  assert.match(first.description, /MF-2 remains open/u);
  await completeRepair(seeded, first.id, "Closed MF-2 and reran its focused regression.", RESOLVED);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);
  assert.equal(await failRegressionAgain(seeded, "review-fail", 2, RESOLVED), "handled");
  assert.equal(await repairCount(seeded), 2);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
  const second = await db.task.findFirstOrThrow({
    where: { projectId: seeded.project.id, name: "Autonomous merge tail: review-fix" },
    orderBy: { createdAt: "desc" },
  });
  // The second repair carries the chain's context too, not only the first one.
  assert.ok(second.description.includes(SOL_FINDINGS_BODY));
  await completeRepair(seeded, second.id, "Closed the remaining finding and reran its focused regression.", REPAIRED);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 3);
  assert.equal(await failRegressionAgain(seeded, "review-fail", 3, REPAIRED), "handled");
  assert.equal(await repairCount(seeded), 3);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
  const third = await db.task.findFirstOrThrow({
    where: { projectId: seeded.project.id, name: "Autonomous merge tail: review-fix" },
    orderBy: { createdAt: "desc" },
  });
  await completeRepair(seeded, third.id, "Closed the last finding and reran its focused regression.", REPAIRED_AGAIN);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 4);
  assert.equal(await failRegressionAgain(seeded, "review-fail", 4, REPAIRED_AGAIN), "handled");
  assert.equal(await repairCount(seeded), 3);
  const notice = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  assert.match(notice.body, /after 3 automatic repair attempts/u);
});

test("all five merge-tail repairs grant the sixth Regression run without changing the configured budget", async () => {
  const seeded = await exercise("review-fail");
  const heads = [RESOLVED, REPAIRED, "e".repeat(40), "f".repeat(40), "1".repeat(40), "2".repeat(40)];
  const repairOutput = "Repair completed and the focused verification passed.";

  const completeLatest = async (
    kind: "refresh-conflict" | "review-fix" | "gate-fix",
    output: string,
    headSha: string,
  ) => {
    const repair = await db.task.findFirstOrThrow({
      where: { projectId: seeded.project.id, name: `Autonomous merge tail: ${kind}` },
      orderBy: { createdAt: "desc" },
    });
    await completeRepair(seeded, repair.id, output, headSha);
  };

  // The repair cap is one refresh conflict plus three attempts for each review
  // and gate failure; five repairs stay inside it. Every successful repair queues a fresh Regression Run;
  // only those platform requeues should accumulate grants.
  await completeLatest("review-fix", repairOutput, heads[1]!);
  assert.equal(await failRegressionAgain(seeded, "gate-fail", 2, heads[1]!), "handled");
  await completeLatest("gate-fix", repairOutput, heads[2]!);
  assert.equal(await failRegressionAgain(seeded, "review-fail", 3, heads[2]!), "handled");
  await completeLatest("review-fix", repairOutput, heads[3]!);
  assert.equal(await failRegressionAgain(seeded, "gate-fail", 4, heads[3]!), "handled");
  await completeLatest("gate-fix", repairOutput, heads[4]!);
  assert.equal(await failRegressionAgain(seeded, "refresh-conflict", 5, heads[4]!), "handled");
  await completeLatest("refresh-conflict", JSON.stringify({
    schemaVersion: 1,
    outcome: "resolved",
    startHeadSha: heads[4],
    targetHeadSha: BASE,
    resolvedHeadSha: heads[5],
    tradeOffs: [],
    changedTestExpectations: [],
  }), heads[5]!);

  const runs = await db.run.findMany({
    where: { taskId: seeded.regression.id },
    orderBy: { runNumber: "asc" },
    select: { runNumber: true, status: true, maxRunsPerTask: true, budgetGrants: true, leaseLossRefunds: true },
  });
  assert.equal(runs.length, 6);
  assert.deepEqual(runs.at(-1), {
    runNumber: 6,
    status: "QUEUED",
    maxRunsPerTask: 10,
    budgetGrants: 5,
    leaseLossRefunds: 0,
  });
  assert.equal(await db.taskActivity.count({
    where: {
      taskId: seeded.regression.id,
      metadata: { path: ["kind"], equals: "mergeTail.requeue" },
    },
  }), 0);
});

test("a repair task carries only the chain outputs its repair kind reads", async () => {
  for (const outcome of ["review-fail", "gate-fail", "refresh-conflict"] as const) {
    await resetTestDb(db);
    const seeded = await exercise(outcome);
    const repairKind = outcome === "review-fail" ? "review-fix" : outcome === "gate-fail" ? "gate-fix" : "refresh-conflict";
    const repair = await repairFor(seeded, repairKind);
    // Chain-detached by design: the claim path's prior-output lookup cannot
    // fire for this row, so the prompt is the only carrier.
    assert.equal(repair.chainId, null, outcome);
    assert.equal(repair.chainIndex, null, outcome);
    assert.match(repair.description, /Persisted outputs from prior template steps:/u, outcome);
    assert.ok(repair.description.includes(IMPLEMENTATION_BODY), outcome);
    if (repairKind === "review-fix") {
      // Only the repair that traces finding ids reads the review reports,
      // still in chain order.
      assert.ok(repair.description.includes(SOL_FINDINGS_BODY), outcome);
      assert.ok(repair.description.includes(BLIND_FINDINGS_BODY), outcome);
      assert.ok(
        repair.description.indexOf(IMPLEMENTATION_BODY) < repair.description.indexOf(SOL_FINDINGS_BODY),
        outcome,
      );
    } else {
      assert.ok(!repair.description.includes(SOL_FINDINGS_BODY), outcome);
      assert.ok(!repair.description.includes(BLIND_FINDINGS_BODY), outcome);
    }
    // Nothing from the Regression step that opened the repair.
    assert.ok(!repair.description.includes("regression-verification"), outcome);
  }
});

test("a review-fix prompt names the blast radius a summary-literal repair would miss", async () => {
  const seeded = await exercise("review-fail");
  const repair = await repairFor(seeded, "review-fix");
  assert.match(repair.description, /enumerate its callers across every workspace, including apps\/web/u);
  const conflict = await exercise("refresh-conflict");
  const resolver = await repairFor(conflict, "refresh-conflict");
  assert.doesNotMatch(resolver.description, /enumerate its callers/u);
});

test("a Full Assurance repair revalidates documentation before Regression", async () => {
  const seeded = await exercise("review-fail", { withLibrarian: true });
  const repair = await repairFor(seeded, "review-fix");
  await completeRepair(seeded, repair.id, "Closed MF-2 and reran its focused regression.");
  assert.ok(seeded.librarian);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.librarian.id } })).status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: seeded.librarian.id } }), 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.REVIEW);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 1);
});

test("a Full Assurance documentation requeue grants the following Regression hop exactly once", async () => {
  const seeded = await exercise("review-fail", { withLibrarian: true });
  const repair = await repairFor(seeded, "review-fix");
  await completeRepair(seeded, repair.id, "Closed MF-2 and reran its focused regression.", RESOLVED);
  const completedDocumentation = await completeDocumentation(seeded, RESOLVED);
  assert.equal(completedDocumentation.maxRunsPerTask, 6);
  assert.equal(completedDocumentation.budgetGrants, 1);
  assert.deepEqual((await db.taskActivity.findFirstOrThrow({
    where: {
      taskId: seeded.librarian!.id,
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: "mergeTail.requeue" },
    },
    select: { metadata: true },
  })).metadata, {
    kind: "mergeTail.requeue",
    runId: completedDocumentation.id,
    schemaVersion: 1,
  });
  const regressionRun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id, runNumber: 2 },
  });
  assert.equal(regressionRun.status, "QUEUED");
  assert.equal(regressionRun.maxRunsPerTask, 6);
  assert.equal(regressionRun.budgetGrants, 1);
});

test("non-control-plane requeue metadata cannot grant an ordinary Documentation successor", async () => {
  const seeded = await seedRegression({ withLibrarian: true });
  assert.ok(seeded.librarian);
  await db.task.update({ where: { id: seeded.librarian.id }, data: { status: TaskStatus.TODO } });
  await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.REVIEW } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx, seeded.librarian!.id));
  for (const actorType of ["agent", "operator"]) {
    await db.taskActivity.create({ data: {
      taskId: seeded.librarian.id,
      actorType,
      body: `${actorType} supplied colliding metadata`,
      metadata: {
        kind: "mergeTail.requeue",
        schemaVersion: 1,
        state: "queued",
        runId: run.id,
      },
    } });
  }

  await completeDocumentation(seeded, HEAD);
  const regressionRun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id, runNumber: 2 },
  });
  assert.equal(regressionRun.maxRunsPerTask, 5);
  assert.equal(regressionRun.budgetGrants, 0);
});

test("a durable Documentation requeue survives more than twenty later activity rows", async () => {
  const seeded = await exercise("review-fail", { withLibrarian: true });
  const repair = await repairFor(seeded, "review-fix");
  await completeRepair(seeded, repair.id, "Closed MF-2 and reran its focused regression.", RESOLVED);
  assert.ok(seeded.librarian);
  await db.taskActivity.createMany({ data: Array.from({ length: 25 }, (_, index) => ({
    taskId: seeded.librarian!.id,
    actorType: "agent",
    body: `Routine documentation progress ${String(index + 1)}`,
  })) });

  await completeDocumentation(seeded, RESOLVED);
  const regressionRun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id, runNumber: 2 },
  });
  assert.equal(regressionRun.maxRunsPerTask, 6);
  assert.equal(regressionRun.budgetGrants, 1);
});

test("a version-suffixed Documentation output preserves its merge-tail successor grant", async () => {
  const seeded = await exercise("review-fail", { withLibrarian: true });
  assert.ok(seeded.librarian);
  await db.taskTemplateStep.update({
    where: { id: seeded.librarian.templateStepId! },
    data: { outputKind: "documentation-v1" },
  });
  const repair = await repairFor(seeded, "review-fix");
  await completeRepair(seeded, repair.id, "Closed MF-2 and reran its focused regression.", RESOLVED);
  await completeDocumentation(seeded, RESOLVED);

  const regressionRun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id, runNumber: 2 },
  });
  assert.equal(regressionRun.maxRunsPerTask, 6);
  assert.equal(regressionRun.budgetGrants, 1);
});

test("all five Full Assurance repairs grant sixth Documentation and Regression runs", async () => {
  const seeded = await exercise("review-fail", { withLibrarian: true, withLibrarianHistory: true });
  assert.ok(seeded.librarian);
  const heads = [RESOLVED, REPAIRED, "e".repeat(40), "f".repeat(40), "1".repeat(40), "2".repeat(40)];
  const repairOutput = "Repair completed and the focused verification passed.";
  const completeLatest = async (kind: "refresh-conflict" | "review-fix" | "gate-fix", headSha: string) => {
    const repair = await db.task.findFirstOrThrow({
      where: { projectId: seeded.project.id, name: `Autonomous merge tail: ${kind}` },
      orderBy: { createdAt: "desc" },
    });
    const output = kind === "refresh-conflict"
      ? JSON.stringify({
        schemaVersion: 1,
        outcome: "resolved",
        startHeadSha: heads[4],
        targetHeadSha: BASE,
        resolvedHeadSha: headSha,
        tradeOffs: [],
        changedTestExpectations: [],
      })
      : repairOutput;
    await completeRepair(seeded, repair.id, output, headSha);
  };

  await completeLatest("review-fix", heads[1]!);
  await completeDocumentation(seeded, heads[1]!);
  assert.equal(await failRegressionAgain(seeded, "gate-fail", 2, heads[1]!), "handled");
  await completeLatest("gate-fix", heads[2]!);
  await completeDocumentation(seeded, heads[2]!);
  assert.equal(await failRegressionAgain(seeded, "review-fail", 3, heads[2]!), "handled");
  await completeLatest("review-fix", heads[3]!);
  await completeDocumentation(seeded, heads[3]!);
  assert.equal(await failRegressionAgain(seeded, "gate-fail", 4, heads[3]!), "handled");
  await completeLatest("gate-fix", heads[4]!);
  await completeDocumentation(seeded, heads[4]!);
  assert.equal(await failRegressionAgain(seeded, "refresh-conflict", 5, heads[4]!), "handled");
  await completeLatest("refresh-conflict", heads[5]!);

  const documentationRun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.librarian.id, runNumber: 6 },
  });
  assert.deepEqual({
    status: documentationRun.status,
    maxRunsPerTask: documentationRun.maxRunsPerTask,
    budgetGrants: documentationRun.budgetGrants,
  }, { status: "QUEUED", maxRunsPerTask: 10, budgetGrants: 5 });
  assert.equal(documentationRun.leaseLossRefunds, 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.librarian.id } })).maxSessionsPerTask, 5);

  await completeDocumentation(seeded, heads[5]!);
  const regressionRun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id, runNumber: 6 },
  });
  assert.deepEqual({
    status: regressionRun.status,
    maxRunsPerTask: regressionRun.maxRunsPerTask,
    budgetGrants: regressionRun.budgetGrants,
  }, { status: "QUEUED", maxRunsPerTask: 10, budgetGrants: 5 });
  assert.equal(regressionRun.leaseLossRefunds, 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).maxSessionsPerTask, 5);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
});

test("repairs on every previously omitted legacy generation reopen the Librarian Step", async () => {
  for (const marker of [
    "pre-narrow-regression-lease",
    "pre-blind-review-retirement",
    "pre-regression-step-split",
  ]) {
    const seeded = await exercise("review-fail", {
      withLibrarian: true,
      templateName: templateRolloverName(INTEGRATOR_TEMPLATE_NAME, marker, `template-${marker}`),
    });
    const repair = await repairFor(seeded, "review-fix");
    await completeRepair(seeded, repair.id, `Closed ${marker} findings.`);
    assert.ok(seeded.librarian, marker);
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: seeded.librarian.id } })).status,
      TaskStatus.TODO,
      marker,
    );
    assert.equal(await db.run.count({ where: { taskId: seeded.librarian.id } }), 1, marker);
    assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 1, marker);
  }
});

test("a repair on a seed-era template row reopens the Librarian Step", async () => {
  // These markers were registered for identity alone: their retired graphs were
  // never recorded, so routing through a registered shape skipped the Librarian
  // in silence. The Step comes from the chain's own persisted template rows now.
  for (const marker of ["10", "9", "human-12", "regression-first-13"]) {
    const seeded = await exercise("review-fail", {
      withLibrarian: true,
      templateName: templateRolloverName(INTEGRATOR_TEMPLATE_NAME, marker, `template-${marker}`),
    });
    const repair = await repairFor(seeded, "review-fix");
    await completeRepair(seeded, repair.id, `Closed ${marker} findings.`);
    assert.ok(seeded.librarian, marker);
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: seeded.librarian.id } })).status,
      TaskStatus.TODO,
      marker,
    );
    assert.equal(await db.run.count({ where: { taskId: seeded.librarian.id } }), 1, marker);
    assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 1, marker);
  }
});

test("repair selects the lowest-indexed Documentation role across versioned kinds", async () => {
  const seeded = await exercise("review-fail", { withLibrarian: true });
  assert.ok(seeded.librarian);
  const step = await db.taskTemplateStep.create({ data: {
    taskTemplateId: seeded.template.id, stepIndex: 7, layer: 7, name: "Earlier Documentation",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: seeded.librarian.assigneeAgentId,
    prompt: "document", approvalGate: false, outputKind: "documentation-v2",
  } });
  const earlier = await db.task.create({ data: {
    projectId: seeded.project.id, repoId: seeded.repo.id, templateId: seeded.template.id,
    templateStepId: step.id, name: step.name, description: "document",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: seeded.librarian.assigneeAgentId,
    status: TaskStatus.DONE, chainId: seeded.librarian.chainId, chainIndex: 7, chainLayer: 7, targetBranch: "main",
  } });
  const repair = await repairFor(seeded, "review-fix");
  await completeRepair(seeded, repair.id, "Closed findings with two persisted Documentation roles.");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: earlier.id } })).status, TaskStatus.TODO);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.librarian.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: earlier.id } }), 1);
});

test("a repair on a template with no Documentation Step says so rather than skipping in silence", async () => {
  const seeded = await exercise("review-fail");
  const repair = await repairFor(seeded, "review-fix");
  await completeRepair(seeded, repair.id, "Closed MF-2 and reran its focused regression.");
  const absence = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.regression.id,
    actorType: "control-plane",
    metadata: { path: ["kind"], equals: "mergeTail.documentationStepAbsent" },
  } });
  assert.match(absence.body, /has no Documentation Step/u);
  // The tail still re-opens Regression directly, which is what it always did.
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);
});

test("invalid Regression output opens a stop notice with no unusable operator choices", async () => {
  const seeded = await seedRegression();
  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, {
    task: seeded.regression,
    run: { id: seeded.run.id, agentId: seeded.regressionAgent.id, branch: BRANCH, headSha: HEAD, sessionId: seeded.session.id },
    now: new Date(),
  })), "handled");
  const card = await db.inboxMessage.findFirstOrThrow({ where: { taskId: seeded.regression.id } });
  assert.equal(card.kind, "TEXT");
  assert.equal(card.choices, null);
  assert.match(card.dedupeKey ?? "", /^merge-tail-stop:/u);
});

test("a fresh Regression retry ignores an unconsumed no-changes output", async () => {
  const seeded = await seedRegression();
  await db.taskStepOutput.create({ data: {
    taskId: seeded.regression.id,
    runId: seeded.run.id,
    kind: "regression-verification",
    body: verdict("refresh-conflict"),
    commitSha: HEAD,
  } });
  await db.run.update({
    where: { id: seeded.run.id },
    data: {
      status: "FAILED",
      failureClass: "NO_CHANGES_PRODUCED",
      failureReason: "delivery failed after the verdict was persisted",
      endedAt: new Date(),
    },
  });
  await db.task.update({
    where: { id: seeded.regression.id },
    data: { status: TaskStatus.REVIEW, failureReason: "delivery failed after the verdict was persisted" },
  });

  const priorOperator = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "merge-tail-operator-token";
  try {
    const retried = await createApp(db).request(`/tasks/${seeded.regression.id}/retry`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-operator-token" },
    });
    assert.equal(retried.status, 201, await retried.text());
  } finally {
    if (priorOperator === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = priorOperator;
  }

  const run2 = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id, runNumber: 2 } });
  const claimed = await claimNext();
  assert.equal(claimed.status, 200);
  const body = claimed.body as {
    run: { id: string };
    regressionRepairHandoff: unknown;
    resume: unknown;
  };
  assert.equal(body.run.id, run2.id);
  assert.equal(body.regressionRepairHandoff, null);
  assert.equal(body.resume, null);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
});

test("a fresh Regression claim carries the prior verdict and exact published repair without resuming context", async () => {
  const seeded = await exercise("review-fail");
  const repair = await repairFor(seeded, "review-fix");
  const repairOutput = "Closed MF-2 and reran its focused regression.";
  await completeRepair(seeded, repair.id, repairOutput);
  const run2 = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id, runNumber: 2 } });

  const claimed = await claimNext();
  assert.equal(claimed.status, 200);
  const body = claimed.body as {
    run: { id: string };
    resume: unknown;
    regressionRepairHandoff: {
      trigger: { kind: string; verdict: { outcome: string; headSha: string; baseHeadSha: string; summary: string } };
      repair: { kind: string; taskId: string; startHeadSha: string; targetHeadSha: string; resolvedHeadSha: string; outputBody: string };
    };
  };
  assert.equal(body.run.id, run2.id);
  assert.equal(body.resume, null);
  assert.deepEqual(body.regressionRepairHandoff.trigger, {
    kind: "regression-verdict",
    verdict: { schemaVersion: 1, outcome: "review-fail", headSha: HEAD, baseHeadSha: BASE, summary: "MF-2 remains open" },
  });
  assert.deepEqual(body.regressionRepairHandoff.repair, {
    kind: "review-fix", taskId: repair.id, startHeadSha: HEAD, targetHeadSha: BASE,
    resolvedHeadSha: RESOLVED, outputKind: "result", outputBody: repairOutput,
  });
});

test("a repaired Regression claim keeps the handoff from a failed durable source Run", async () => {
  const seeded = await exercise("review-fail");
  await db.run.update({
    where: { id: seeded.run.id },
    data: {
      status: "FAILED",
      failureClass: "PROTOCOL_ERROR",
      failureReason: "provider stream ended after the verdict was persisted",
      retryable: true,
      endedAt: new Date(),
    },
  });
  const repair = await repairFor(seeded, "review-fix");
  await completeRepair(seeded, repair.id, "Closed MF-2 and reran its focused regression.");
  const run2 = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id, runNumber: 2 } });

  const claimed = await claimNext();
  assert.equal(claimed.status, 200);
  const body = claimed.body as {
    run: { id: string };
    regressionRepairHandoff: {
      trigger: { verdict: { outcome: string } };
      repair: { taskId: string; resolvedHeadSha: string };
    };
  };
  assert.equal(body.run.id, run2.id);
  assert.equal(body.regressionRepairHandoff.trigger.verdict.outcome, "review-fail");
  assert.equal(body.regressionRepairHandoff.repair.taskId, repair.id);
  assert.equal(body.regressionRepairHandoff.repair.resolvedHeadSha, RESOLVED);
});

test("a repaired Regression retry pins a failed prior Run's published head without rewriting repair evidence", async () => {
  const seeded = await exercise("review-fail");
  const repair = await repairFor(seeded, "review-fix");
  await completeRepair(seeded, repair.id, "Closed MF-2 and reran its focused regression.");
  const firstClaim = await claimNext();
  assert.equal(firstClaim.status, 200);
  const firstBody = firstClaim.body as {
    run: { id: string };
    regressionRepairHandoff: { retry?: unknown };
  };
  assert.equal(firstBody.regressionRepairHandoff.retry, undefined);

  const continuationHead = "d".repeat(40);
  const retryBranch = "agentos/regression/retry-run-2";
  await db.run.update({
    where: { id: firstBody.run.id },
    data: {
      status: "FAILED",
      failureReason: "mechanical output handoff failed after the verdict was published",
      headSha: continuationHead,
      pushedBranch: retryBranch,
      pushStatus: "SUCCEEDED",
      endedAt: new Date(),
    },
  });
  await db.task.update({
    where: { id: seeded.regression.id },
    data: { status: TaskStatus.REVIEW, failureReason: "gate formed no verdict" },
  });

  const priorOperator = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "merge-tail-operator-token";
  try {
    const retried = await createApp(db).request(`/tasks/${seeded.regression.id}/retry`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-operator-token" },
    });
    assert.equal(retried.status, 201, await retried.text());
  } finally {
    if (priorOperator === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = priorOperator;
  }

  const retryClaim = await claimNext();
  assert.equal(retryClaim.status, 200);
  const retryBody = retryClaim.body as {
    regressionRepairHandoff: {
      repair: { resolvedHeadSha: string };
      retry: { previousRunId: string; startHeadSha: string };
    };
  };
  assert.equal(retryBody.regressionRepairHandoff.repair.resolvedHeadSha, RESOLVED);
  assert.deepEqual(retryBody.regressionRepairHandoff.retry, {
    previousRunId: firstBody.run.id,
    startHeadSha: continuationHead,
  });
});

test("a stale repair output stops the queued Regression Run before a provider session starts", async () => {
  const seeded = await exercise("review-fail");
  const repair = await repairFor(seeded, "review-fix");
  await completeRepair(seeded, repair.id, "Closed MF-2.");
  await db.taskStepOutput.update({ where: { taskId: repair.id }, data: { commitSha: "d".repeat(40) } });
  const run2 = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id, runNumber: 2 } });

  const claimed = await claimNext();
  assert.equal(claimed.status, 204);
  const stopped = await db.run.findUniqueOrThrow({ where: { id: run2.id } });
  assert.equal(stopped.status, "FAILED");
  assert.match(stopped.failureReason ?? "", /output and Run do not bind resolved head/u);
  const task = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(task.status, TaskStatus.REVIEW);
  assert.equal(await db.session.count({ where: { runId: run2.id } }), 0);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 1);
});

test("malformed, unknown, and head-unbound resolver outputs stop loudly", async () => {
  const cases: Array<[string, string, string | null]> = [
    ["prose", "resolved it", RESOLVED],
    ["unknown", JSON.stringify({ schemaVersion: 1, outcome: "other", startHeadSha: HEAD, targetHeadSha: BASE }), RESOLVED],
    ["null-head", JSON.stringify({
      schemaVersion: 1, outcome: "resolved", startHeadSha: HEAD, targetHeadSha: BASE,
      resolvedHeadSha: RESOLVED, tradeOffs: [], changedTestExpectations: [],
    }), null],
  ];
  for (const [label, output, headSha] of cases) {
    const seeded = await exercise("refresh-conflict");
    const repair = await repairFor(seeded, "refresh-conflict");
    await completeRepair(seeded, repair.id, output, headSha);
    const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
    assert.equal(regression.status, TaskStatus.REVIEW, label);
    assert.match(regression.failureReason ?? "", /invalid output/u, label);
    assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 1, label);
    await resetTestDb(db);
  }
});

test("successful resolver, review-fix, and gate-fix completions rerun regression with exact-head PASS evidence", async () => {
  for (const outcome of ["refresh-conflict", "review-fail", "gate-fail"] as const) {
    const seeded = await exercise(outcome);
    const repair = await repairFor(seeded, outcome === "gate-fail" ? "gate-fix" : outcome === "review-fail" ? "review-fix" : outcome);
    const output = outcome === "refresh-conflict"
      ? JSON.stringify({
        schemaVersion: 1, outcome: "resolved", startHeadSha: HEAD, targetHeadSha: BASE,
        resolvedHeadSha: RESOLVED, tradeOffs: [], changedTestExpectations: [],
      })
      : "fixed gate failure";
    await completeRepair(seeded, repair.id, output);
    const run2 = await db.run.findFirstOrThrow({ where: { taskId: seeded.regression.id, runNumber: 2 } });
    await db.run.update({ where: { id: run2.id }, data: { headSha: RESOLVED } });
    await db.taskStepOutput.update({ where: { taskId: seeded.regression.id }, data: {
      runId: run2.id,
      body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: RESOLVED, baseHeadSha: BASE, gateVerdict: "PASS" }),
      commitSha: RESOLVED,
    } });
    assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, {
      task: seeded.regression,
      run: { id: run2.id, agentId: seeded.regressionAgent.id, branch: BRANCH, headSha: RESOLVED, sessionId: seeded.session.id },
      now: new Date(),
    })), "advance", outcome);
    await resetTestDb(db);
  }
});

test("a completed repair permanently consumes its source Regression verdict", async () => {
  for (const outcome of ["refresh-conflict", "review-fail", "gate-fail"] as const) {
    const seeded = await exercise(outcome);
    const repair = await repairFor(
      seeded,
      outcome === "gate-fail" ? "gate-fix" : outcome === "review-fail" ? "review-fix" : outcome,
    );
    const output = outcome === "refresh-conflict"
      ? JSON.stringify({
        schemaVersion: 1,
        outcome: "resolved",
        startHeadSha: HEAD,
        targetHeadSha: BASE,
        resolvedHeadSha: RESOLVED,
        tradeOffs: [],
        changedTestExpectations: [],
      })
      : "fixed regression verdict";
    await completeRepair(seeded, repair.id, output);
    const before = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
    const noticesBefore = await db.inboxMessage.count({ where: { taskId: seeded.regression.id } });

    assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, seeded.input)), "handled", outcome);
    assert.equal(await repairCount(seeded), 1, `${outcome} opened a second repair from the same source Run`);
    const after = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
    assert.equal(after.status, before.status, outcome);
    assert.equal(after.failureReason, before.failureReason, outcome);
    assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), noticesBefore, outcome);
    await resetTestDb(db);
  }
});

test("a resolver process failure escalates instead of leaving regression silently parked", async () => {
  const seeded = await exercise("refresh-conflict");
  const repair = await repairFor(seeded, "refresh-conflict");
  const run = await db.run.findFirstOrThrow({ where: { taskId: repair.id } });
  const runnerId = "merge-tail-repair-runner";
  const fencingToken = `repair:${run.id}:1`;
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", runnerId, fencingToken, leaseExpiresAt: new Date(Date.now() + 60_000),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, agentId: repair.assigneeAgentId!, taskId: repair.id,
    runner: "CODEX", executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: repair.id }, data: { status: TaskStatus.DOING } });
  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "merge-tail-repair-token";
  try {
    const response = await createApp(db).request(`/runner/runs/${run.id}/complete`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-repair-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId, fencingToken, exitCode: 1,
        outcome: {
          case: "provider-failure",
          reason: "resolver crashed",
          envelope: {
            version: 1, phase: "EXECUTE", agentExited: true, exitCode: 1, signal: null,
            terminationReason: null, timedOut: false, timeoutMs: null, transient: false,
            runnerClass: "TASK_FAILED", providerError: null,
            stderrSummary: "resolver crashed", stdoutSummary: null,
            terminalEventSeen: true, terminalSuccess: false,
          },
        },
        cleanupStatus: "SUCCEEDED",
      }),
    });
    assert.equal(response.status, 200);
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = prior;
  }
  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.status, TaskStatus.REVIEW);
  assert.match(regression.failureReason ?? "", /failed without closing/u);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 1);
});

test("a stale branch is mechanically refreshed before exact-head PASS advances", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-merge-refresh-"));
  try {
    const origin = join(root, "origin.git");
    const author = ["-c", "user.name=Anneal Test", "-c", "user.email=test@example.invalid"];
    await exec("git", ["init", "--bare", origin]);
    const source = join(root, "source");
    await exec("git", ["clone", origin, source]);
    await writeFile(join(source, "base.txt"), "base\n");
    await exec("git", [...author, "add", "base.txt"], { cwd: source });
    await exec("git", [...author, "commit", "-m", "base"], { cwd: source });
    await exec("git", ["branch", "-M", "main"], { cwd: source });
    await exec("git", ["push", "origin", "main"], { cwd: source });
    await exec("git", ["checkout", "-b", "feature"], { cwd: source });
    await writeFile(join(source, "feature.txt"), "feature\n");
    await exec("git", [...author, "add", "feature.txt"], { cwd: source });
    await exec("git", [...author, "commit", "-m", "feature"], { cwd: source });
    await exec("git", ["push", "origin", "feature"], { cwd: source });
    await exec("git", ["checkout", "main"], { cwd: source });
    await writeFile(join(source, "main.txt"), "advanced\n");
    await exec("git", [...author, "add", "main.txt"], { cwd: source });
    await exec("git", [...author, "commit", "-m", "advance main"], { cwd: source });
    await exec("git", ["push", "origin", "main"], { cwd: source });
    const baseSha = (await exec("git", ["rev-parse", "main"], { cwd: source })).stdout.trim();

    const work = join(root, "work");
    await exec("git", ["clone", "--branch", "feature", origin, work]);
    await exec("git", ["fetch", "origin", "main"], { cwd: work });
    await exec("git", [...author, "merge", "--no-edit", "origin/main"], { cwd: work });
    const refreshedHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: work })).stdout.trim();
    await exec("git", ["merge-base", "--is-ancestor", baseSha, refreshedHead], { cwd: work });

    const seeded = await seedRegression();
    await db.run.update({ where: { id: seeded.run.id }, data: { headSha: refreshedHead } });
    await db.taskStepOutput.create({ data: {
      taskId: seeded.regression.id, runId: seeded.run.id, kind: "regression-verification",
      body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: refreshedHead, baseHeadSha: baseSha, gateVerdict: "PASS" }),
      commitSha: refreshedHead,
    } });
    assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, {
      task: seeded.regression,
      run: { id: seeded.run.id, agentId: seeded.regressionAgent.id, branch: BRANCH, headSha: refreshedHead, sessionId: seeded.session.id },
      now: new Date(),
    })), "advance");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The chain's base-drift recovery, bound to a Run that is not the one a repair
 * repairs. Every column `recoveryContext` requires is present and the aggregate
 * is REPAIRING, so what the tail refuses is the binding itself rather than an
 * identity it could not read.
 */
const seedRecoveryBoundTo = async (
  seeded: Awaited<ReturnType<typeof seedRegression>>,
  boundRunId: string,
) => {
  const integrator = await db.task.create({ data: {
    projectId: seeded.project.id, repoId: seeded.repo.id, name: "Integrator", description: "merge",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: seeded.reviewAgent.id,
    status: TaskStatus.DOING, targetBranch: "main",
  } });
  const readiness = await db.task.create({ data: {
    projectId: seeded.project.id, repoId: seeded.repo.id, templateId: seeded.template.id,
    templateStepId: seeded.readinessStep.id, name: "Readiness", description: "authorize",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: seeded.reviewAgent.id,
    status: TaskStatus.DOING, chainId: seeded.regression.chainId,
    chainIndex: seeded.readinessStep.stepIndex, chainLayer: seeded.readinessStep.layer,
    targetBranch: "main",
  } });
  // The Run the recovery was opened from. It is neither the Run the recovery is
  // bound to nor the Run a repair would repair, so the recorded
  // `boundSourceRunId` can only match by reading the aggregate's binding.
  const sourceRun = await db.run.create({ data: {
    projectId: seeded.project.id, taskId: readiness.id, agentId: seeded.reviewAgent.id,
    repoId: seeded.repo.id, runNumber: 1, dedupeKey: `task:${readiness.id}:run:1`,
    runner: "CODEX", model: seeded.reviewAgent.model, promptHash: "hash",
    status: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH, targetBranch: "main", headSha: HEAD,
  } });
  const authorization = await db.taskActivity.create({ data: {
    taskId: readiness.id, actorType: "control-plane", body: "merge authorized for the recovered head",
  } });
  const stop = await db.taskActivity.create({ data: {
    taskId: integrator.id, actorType: "control-plane", body: "merge tail stopped on base drift",
  } });
  const recovery = await db.mergeRecoveryAttempt.create({ data: {
    integratorTaskId: integrator.id,
    sourceStopId: stop.id,
    attempt: 1,
    status: MergeRecoveryStatus.REPAIRING,
    boundSourceRunId: sourceRun.id,
    authorizationActivityId: authorization.id,
    // The binding every repair is read against.
    recoveryRunId: boundRunId,
    readinessTaskId: readiness.id,
    regressionTaskId: seeded.regression.id,
    repository: "acme/widgets",
    prNumber: 123,
    targetBranch: "main",
    authorizedHeadSha: HEAD,
    authorizedBaseSha: BASE,
    observedBaseSha: BASE,
    currentBaseSha: BASE,
  } });
  return { integrator, readiness, recovery, sourceRun };
};

/** Run A: a Regression Run of the same chain that is not the Run whose verdict
 *  is being settled, so it can stand in for a recovery bound elsewhere. */
const seedOtherRegressionRun = (seeded: Awaited<ReturnType<typeof seedRegression>>) => db.run.create({ data: {
  projectId: seeded.project.id, taskId: seeded.regression.id, agentId: seeded.regressionAgent.id,
  repoId: seeded.repo.id, runNumber: 2, dedupeKey: `task:${seeded.regression.id}:run:2`,
  runner: "CODEX", model: seeded.regressionAgent.model, promptHash: "hash",
  status: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH, targetBranch: "main", headSha: HEAD,
} });

/**
 * `exercise`, with the chain's recovery already naming another Run when the
 * failing verdict arrives. The aggregate is not bound to this Run, so the
 * recovery-aware branch of `handleRegressionCompletion` does not fire and the
 * ordinary automatic repair path is the one that has to refuse.
 */
const exerciseWithRecoveryBoundElsewhere = async (outcome: RegressionOutcome = "gate-fail") => {
  const seeded = await seedRegression();
  await db.taskStepOutput.create({ data: {
    taskId: seeded.regression.id, runId: seeded.run.id, kind: "regression-verification",
    body: verdict(outcome), commitSha: HEAD,
  } });
  const recoveryRun = await seedOtherRegressionRun(seeded);
  const { recovery, sourceRun } = await seedRecoveryBoundTo(seeded, recoveryRun.id);
  const input = {
    task: seeded.regression,
    run: {
      id: seeded.run.id, agentId: seeded.regressionAgent.id,
      branch: BRANCH, headSha: HEAD, sessionId: seeded.session.id,
    },
    now: new Date(),
  };
  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, input)), "handled");
  return { ...seeded, input, recoveryRun, recoverySourceRun: sourceRun, recovery };
};

/**
 * `completeRepair` through the action rather than the route, because the value
 * under test is the classified refusal the route turns into a 409: over HTTP it
 * survives only as a status code.
 *
 * The repair task is an auxiliary Merge Lease holder, so its completion ends in
 * a lease release. The releaser is the caller's here, as it is for every other
 * `completeRun` test: the production adapter shells out to `merge-lease.sh`
 * against origin, which no test checkout has, and the released chains are what
 * this test can assert about the lease anyway.
 */
const completeRepairThroughAction = async (
  seeded: Awaited<ReturnType<typeof seedRegression>>,
  repairId: string,
  output: string,
  headSha: string = RESOLVED,
) => {
  const run = await db.run.findFirstOrThrow({ where: { taskId: repairId, runNumber: 1 } });
  const repair = await db.task.findUniqueOrThrow({ where: { id: repairId } });
  const publishBranch = run.branch;
  assert.ok(publishBranch, "repair Run 1 was born without a publish head");
  const runnerId = `repair-runner-${run.id}`;
  const fencingToken = `repair:${run.id}:1`;
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", runnerId, fencingToken, leaseExpiresAt: new Date(Date.now() + 60_000),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, agentId: repair.assigneeAgentId!, taskId: repair.id,
    runner: "CODEX", executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: repair.id }, data: { status: TaskStatus.DOING } });
  await db.taskStepOutput.create({ data: {
    taskId: repair.id, runId: run.id, kind: "result", body: output, commitSha: headSha,
  } });
  const releasedChains: string[] = [];
  const release: ReleaseMergeLease = async (target) => {
    if (target) releasedChains.push(target.chainId);
  };
  const result = await completeRun(db, {
    runId: run.id,
    body: {
      runnerId, fencingToken, outcome: { case: "succeeded" }, exitCode: 0,
      cleanupStatus: CleanupStatus.SUCCEEDED, branch: publishBranch, pushedBranch: publishBranch,
      pushStatus: PushStatus.SUCCEEDED, headSha, workspaceRetained: false,
    },
    claimantClass: "runner",
  }, release);
  return { run, result, releasedChains };
};

test("a repair is refused at open when the chain's recovery names another Run", async () => {
  const seeded = await exerciseWithRecoveryBoundElsewhere();

  // No card, and therefore no agent handed a repair whose completion could
  // never be reported.
  assert.equal(await repairCount(seeded), 0);
  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.status, TaskStatus.REVIEW);
  assert.ok((regression.failureReason ?? "").includes(MERGE_TAIL_REPAIR_BINDING_MISMATCH), regression.failureReason ?? "");
  // A refused open consumes no attempt: the head keeps no repairAttempt marker.
  assert.equal(latestMarker(await readMarkerHistory(db, seeded.regression.id), "repairAttempt"), null);
  assert.equal(await db.inboxMessage.count({
    where: { taskId: seeded.regression.id, body: { startsWith: "Autonomous merge tail stopped:" } },
  }), 1);
});

test("the binding mismatch is recorded on the regression task with all three ids", async () => {
  const seeded = await exerciseWithRecoveryBoundElsewhere("review-fail");

  const recorded = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.regression.id,
    actorType: "control-plane",
    metadata: { path: ["kind"], equals: MERGE_TAIL_REPAIR_BINDING_MISMATCH_KIND },
  } });
  const metadata = asJsonObject(recorded.metadata);
  assert.ok(metadata);
  assert.equal(metadata.phase, "open");
  assert.equal(metadata.recoveryId, seeded.recovery.id);
  // The Run the recovery is bound to, and the aggregate's own differently
  // valued `boundSourceRunId` column: the activity names both mechanisms.
  assert.equal(metadata.boundRecoveryRunId, seeded.recoveryRun.id);
  assert.equal(metadata.boundSourceRunId, seeded.recoverySourceRun.id);
  assert.equal(metadata.repairedRunId, seeded.run.id);
  assert.ok(String(metadata.reason).includes(MERGE_TAIL_REPAIR_BINDING_MISMATCH), String(metadata.reason));
});

test("a repair completion the platform cannot bind is rejected without a 500", async () => {
  // The card is opened while nothing contradicts it; the aggregate that names
  // another Run appears while the repair is in flight, which is the only way a
  // genuine repair reaches settlement unbindable. The chain owns a
  // Documentation Step, so the settlement's documentation requeue is part of
  // what the rejection has to undo.
  const seeded = await exercise("gate-fail", { withLibrarian: true });
  const repair = await repairFor(seeded, "gate-fix");
  const recoveryRun = await seedOtherRegressionRun(seeded);
  const { recovery, readiness, integrator, sourceRun } = await seedRecoveryBoundTo(seeded, recoveryRun.id);

  const { run, result, releasedChains } = await completeRepairThroughAction(
    seeded,
    repair.id,
    "Fixed the failing regression and reran the affected suite.",
  );
  // A refused completion still gives the merge window on main back: the repair
  // holds the Regression chain's Lease as an auxiliary, and a rejection that
  // kept it would lock every other chain out.
  assert.deepEqual(releasedChains, [seeded.regression.chainId]);
  // A classified refusal, not a thrown error and not a RunCompletion.
  assert.ok("message" in result, JSON.stringify(result));
  assert.equal(result.reason, "merge-tail-repair-unbound");
  assert.ok(result.message.includes(MERGE_TAIL_REPAIR_BINDING_MISMATCH), result.message);
  assert.deepEqual(result.detail, {
    recoveryId: recovery.id,
    boundRecoveryRunId: recoveryRun.id,
    boundSourceRunId: sourceRun.id,
    repairedRunId: seeded.run.id,
  });

  // The repair's work is real and published, so the Run stays terminal and
  // carries why its completion was rejected.
  const settled = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(settled.status, "SUCCEEDED");
  assert.ok((settled.failureReason ?? "").includes(MERGE_TAIL_REPAIR_BINDING_MISMATCH), settled.failureReason ?? "");
  const parked = await db.task.findUniqueOrThrow({ where: { id: repair.id } });
  assert.equal(parked.status, TaskStatus.REVIEW);
  assert.equal(parked.failureReason, settled.failureReason);

  // No tail task of the recovery has a live Run, so the tail parks in exactly
  // the state the reentry route reopens.
  assert.equal(
    (await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: recovery.id } })).status,
    MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
  );
  for (const taskId of [seeded.regression.id, readiness.id, integrator.id]) {
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status, TaskStatus.REVIEW);
  }
  // The Documentation Step the settlement re-opened is not left announcing a
  // repair the platform refused, and it is not dispatched.
  assert.ok(seeded.librarian);
  const documentation = await db.task.findUniqueOrThrow({ where: { id: seeded.librarian.id } });
  assert.equal(documentation.status, TaskStatus.REVIEW);
  assert.ok((documentation.failureReason ?? "").includes(MERGE_TAIL_REPAIR_BINDING_MISMATCH), documentation.failureReason ?? "");
  assert.equal(await db.run.count({ where: { taskId: seeded.librarian.id } }), 0);

  const recorded = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.regression.id,
    actorType: "control-plane",
    metadata: { path: ["kind"], equals: MERGE_TAIL_REPAIR_BINDING_MISMATCH_KIND },
  } });
  const metadata = asJsonObject(recorded.metadata);
  assert.ok(metadata);
  assert.equal(metadata.phase, "settlement");
  assert.equal(metadata.recoveryId, recovery.id);
  assert.equal(metadata.boundRecoveryRunId, recoveryRun.id);
  assert.equal(metadata.boundSourceRunId, sourceRun.id);
  assert.equal(metadata.repairedRunId, seeded.run.id);
  assert.equal(metadata.repairTaskId, repair.id);
});

test("a rejected repair leaves a recovery that is still running alone", async () => {
  // The overlap the incident produced: the newer recovery requeued the
  // Regression task and enqueued its own Run. Blocking it would stop the
  // mechanism that owns the chain, and the reentry route refuses
  // `merge_tail_repair_active_run` while that Run is alive, so the rejection
  // records the overlap and stops at the notice.
  const seeded = await exercise("gate-fail");
  const repair = await repairFor(seeded, "gate-fix");
  const recoveryRun = await seedOtherRegressionRun(seeded);
  const { recovery, readiness, integrator } = await seedRecoveryBoundTo(seeded, recoveryRun.id);
  await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.TODO } });
  const liveRun = await db.run.create({ data: {
    projectId: seeded.project.id, taskId: seeded.regression.id, agentId: seeded.regressionAgent.id,
    repoId: seeded.repo.id, runNumber: 3, dedupeKey: `task:${seeded.regression.id}:run:3`,
    runner: "CODEX", model: seeded.regressionAgent.model, promptHash: "hash",
    status: "QUEUED", branch: BRANCH, targetBranch: "main",
  } });

  const { result } = await completeRepairThroughAction(
    seeded,
    repair.id,
    "Fixed the failing regression and reran the affected suite.",
  );
  assert.ok("message" in result, JSON.stringify(result));
  assert.equal(result.reason, "merge-tail-repair-unbound");

  // The live recovery keeps its aggregate, its tasks and its Run.
  assert.equal(
    (await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: recovery.id } })).status,
    MergeRecoveryStatus.REPAIRING,
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.TODO);
  for (const taskId of [readiness.id, integrator.id]) {
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status, TaskStatus.DOING);
  }
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: liveRun.id } })).status, "QUEUED");
  // Only the repair parks, and the overlap still reaches an operator.
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: repair.id } })).status, TaskStatus.REVIEW);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: seeded.regression.id,
    metadata: { path: ["kind"], equals: MERGE_TAIL_REPAIR_BINDING_MISMATCH_KIND },
  } }), 1);
  assert.equal(await db.inboxMessage.count({
    where: { taskId: seeded.regression.id, body: { startsWith: "Autonomous merge tail stopped:" } },
  }), 1);
});

for (const [outcome, repairKind] of [["review-fail", "review-fix"], ["gate-fail", "gate-fix"]] as const) {
  for (const repairProfile of ["recorded", "default", "empty", "archived", "operator", "webhook"] as const) {
    test(`${repairKind} honors ${repairProfile} profile repair staffing`, async () => {
      const seeded = await exercise(outcome, { repairProfile });
      const repair = await repairFor(seeded, repairKind);
      const fallback = repairProfile === "empty" || repairProfile === "archived";
      assert.equal(repair.assigneeAgentId, fallback ? seeded.fix.assigneeAgentId : seeded.repairAgent!.id);
      if (repairProfile === "archived") {
        const activity = await db.taskActivity.findFirstOrThrow({ where: {
          task: { chainId: seeded.regression.chainId },
          metadata: { path: ["reason"], equals: "merge_tail_repair_agent_archived" },
        } });
        assert.match(activity.body, /archived; falling back.*fixed-implementation/u);
      }
      // Changing a slot only affects future repairs, not an existing repair card.
      await db.staffingProfile.updateMany({ where: { taskTemplateId: seeded.template.id }, data: { mergeTailRepairAgentId: seeded.reviewAgent.id } });
      assert.equal((await db.task.findUniqueOrThrow({ where: { id: repair.id } })).assigneeAgentId, repair.assigneeAgentId);
    });
  }
}

test("refresh-conflict ignores a staffed repair slot and keeps the resolver role", async () => {
  const seeded = await exercise("refresh-conflict", { repairProfile: "recorded", renamedResolver: true });
  assert.equal((await repairFor(seeded, "refresh-conflict")).assigneeAgentId, seeded.resolverAgent.id);
});

type ExternalRegressionOutcome = "review-fail" | "refresh-conflict" | "gate-fail" | "pass";

const v2Verdict = (outcome: ExternalRegressionOutcome) => JSON.stringify(
  outcome === "pass"
    ? {
      schemaVersion: 2,
      outcome,
      headSha: HEAD,
      baseHeadSha: BASE,
      gateVerdict: "PASS",
      gateProof: `MERGE GATE: PASS ${HEAD}`,
    }
    : {
      schemaVersion: 2,
      outcome,
      headSha: HEAD,
      baseHeadSha: BASE,
      summary: outcome === "review-fail" ? "MF-2 remains open" : "merge conflict",
      ...(outcome === "gate-fail" ? { gateVerdict: "FAIL", gateProof: "MERGE GATE: FAIL (unit tests)" } : {}),
    },
);

/** Complete a Regression Run after its v2 verdict is already durable, while
 * the runner reports a non-retryable git delivery failure without a head. */
const completeRegressionAfterExternalGitFailure = async (
  seeded: Awaited<ReturnType<typeof seedRegression>>,
  outcome: ExternalRegressionOutcome,
  options: {
    completionHead?: string | null;
    recovery?: boolean;
    failureMode?: "task-failed-git" | "transient-provider";
  } = {},
) => {
  await db.taskTemplateStep.update({
    where: { id: seeded.regression.templateStepId! },
    data: { outputKind: REGRESSION_VERIFICATION_OUTPUT_KIND },
  });
  await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.DOING } });
  const runnerId = `regression-external-${seeded.run.id}`;
  const fencingToken = `regression-external-fence-${seeded.run.id}`;
  await db.run.update({ where: { id: seeded.run.id }, data: {
    status: "RUNNING",
    runnerId,
    fencingToken,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    headSha: null,
  } });
  await db.session.update({ where: { id: seeded.session.id }, data: { executionStatus: "RUNNING" } });
  await db.taskStepOutput.create({ data: {
    taskId: seeded.regression.id,
    runId: seeded.run.id,
    kind: REGRESSION_VERIFICATION_OUTPUT_KIND,
    body: v2Verdict(outcome),
    commitSha: HEAD,
  } });
  if (options.recovery) await seedRecoveryBoundTo(seeded, seeded.run.id);

  // Keep completion's lease release observable without invoking the host adapter.
  const releasedChains: string[] = [];
  const release: ReleaseMergeLease = async (target) => {
    if (target) releasedChains.push(target.chainId);
  };
  const completion = await completeRun(db, {
    runId: seeded.run.id,
    body: {
      runnerId,
      fencingToken,
      outcome: {
        case: "provider-failure",
        reason: options.failureMode === "transient-provider"
          ? "provider stream dropped"
          : "git delivery failed",
        envelope: {
          version: 1,
          phase: options.failureMode === "transient-provider" ? "EXECUTE" : "DELIVER",
          runnerClass: options.failureMode === "transient-provider" ? "TRANSIENT_PROVIDER" : "TASK_FAILED",
          exitCode: options.failureMode === "transient-provider" ? 0 : 1,
          signal: null,
          terminationReason: null,
          terminalEventSeen: false,
          terminalSuccess: false,
          agentExited: true,
          providerError: options.failureMode === "transient-provider" ? "connection lost" : null,
          stderrSummary: null,
          stdoutSummary: options.failureMode === "transient-provider" ? null : "git push failed",
          timedOut: false,
          transient: false,
          timeoutMs: null,
        },
      },
      exitCode: 1,
      branch: BRANCH,
      pushedBranch: null,
      pushStatus: PushStatus.FAILED,
      cleanupStatus: CleanupStatus.SUCCEEDED,
      workspaceRetained: false,
      headSha: options.completionHead ?? null,
    },
    claimantClass: "runner",
  }, release);
  assert.ok("taskId" in completion, JSON.stringify(completion));
  assert.deepEqual(releasedChains, [seeded.regression.chainId]);
  return {
    completion,
    run: await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    task: await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
  };
};

test("a task-failed git delivery preserves review-fail and queues repair at the persisted head", async () => {
  const seeded = await seedRegression();
  const settled = await completeRegressionAfterExternalGitFailure(seeded, "review-fail");

  assert.equal(settled.run.status, "FAILED");
  assert.equal(settled.run.failureClass, "TASK_FAILED");
  assert.equal(settled.run.failureReason, "git delivery failed");
  assert.equal(settled.run.headSha, HEAD);
  assert.equal(settled.task.status, TaskStatus.REVIEW);
  assert.equal(settled.completion.retryCreated, false);

  const activity = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.regression.id,
    actorType: "runner",
    body: { contains: "negative Regression verdict" },
  } });
  const activityMetadata = asJsonObject(activity.metadata);
  assert.equal(activityMetadata?.failureReason, "git delivery failed");
  assert.equal(activityMetadata?.headSha, HEAD);

  const repair = await db.task.findFirstOrThrow({ where: {
    projectId: seeded.project.id,
    name: "Autonomous merge tail: review-fix",
  } });
  const attempt = latestMarker(await readMarkers(db, seeded.regression.id), "repairAttempt");
  assert.equal(attempt?.repairKind, "review-fix");
  assert.equal(attempt?.headSha, HEAD);
  assert.equal(attempt?.baseHeadSha, BASE);
  assert.equal(attempt?.raw.sourceRunId, seeded.run.id);
  assert.equal((await db.run.findFirstOrThrow({ where: { taskId: repair.id, runNumber: 1 } })).status, "QUEUED");
});

test("a task-failed git delivery preserves refresh-conflict and queues its resolver at the persisted head", async () => {
  const seeded = await seedRegression();
  const settled = await completeRegressionAfterExternalGitFailure(seeded, "refresh-conflict");

  assert.equal(settled.run.status, "FAILED");
  assert.equal(settled.run.failureClass, "TASK_FAILED");
  assert.equal(settled.run.headSha, HEAD);
  assert.equal(settled.task.status, TaskStatus.REVIEW);
  assert.equal(settled.completion.retryCreated, false);

  const repair = await db.task.findFirstOrThrow({ where: {
    projectId: seeded.project.id,
    name: "Autonomous merge tail: refresh-conflict",
  } });
  const attempt = latestMarker(await readMarkers(db, seeded.regression.id), "repairAttempt");
  assert.equal(attempt?.repairKind, "refresh-conflict");
  assert.equal(attempt?.headSha, HEAD);
  assert.equal(attempt?.baseHeadSha, BASE);
  assert.equal(attempt?.raw.sourceRunId, seeded.run.id);
  assert.equal((await db.run.findFirstOrThrow({ where: { taskId: repair.id, runNumber: 1 } })).status, "QUEUED");
});

test("an external failure in a recovery Run stops recovery with the persisted semantic reason", async () => {
  const seeded = await seedRegression();
  await completeRegressionAfterExternalGitFailure(seeded, "review-fail", { recovery: true });

  const recovery = await db.mergeRecoveryAttempt.findFirstOrThrow({ where: { regressionTaskId: seeded.regression.id } });
  assert.equal(recovery.status, MergeRecoveryStatus.BLOCKED_DOWNSTREAM);
  assert.match(recovery.failureReason ?? "", /semantic regression FAIL at a{40} against b{40}: MF-2 remains open/u);
  assert.equal(await db.task.count({ where: {
    projectId: seeded.project.id,
    name: { startsWith: "Autonomous merge tail:" },
  } }), 0);
  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.status, TaskStatus.REVIEW);
  assert.match(regression.failureReason ?? "", /Automatic base-drift recovery 1 stopped at regression: semantic regression FAIL/u);
});

test("a transient provider drop preserves review-fail instead of queueing a retry", async () => {
  const seeded = await seedRegression();
  const settled = await completeRegressionAfterExternalGitFailure(seeded, "review-fail", {
    failureMode: "transient-provider",
  });

  assert.equal(settled.run.status, "FAILED");
  assert.equal(settled.run.failureClass, "TRANSIENT_PROVIDER");
  assert.equal(settled.run.retryable, true);
  assert.equal(settled.completion.retryCreated, false);
  const repair = await db.task.findFirstOrThrow({ where: {
    projectId: seeded.project.id,
    name: "Autonomous merge tail: review-fix",
  } });
  const attempt = latestMarker(await readMarkers(db, seeded.regression.id), "repairAttempt");
  assert.equal(attempt?.headSha, HEAD);
  assert.equal(attempt?.raw.sourceRunId, seeded.run.id);
  assert.equal((await db.run.findFirstOrThrow({ where: { taskId: repair.id, runNumber: 1 } })).status, "QUEUED");
});

test("a persisted PASS does not advance after an external git failure", async () => {
  const seeded = await seedRegression();
  const settled = await completeRegressionAfterExternalGitFailure(seeded, "pass", { completionHead: HEAD });

  assert.equal(settled.run.status, "FAILED");
  assert.equal(settled.run.failureClass, "TASK_FAILED");
  assert.equal(settled.run.headSha, HEAD);
  assert.equal(settled.task.status, TaskStatus.REVIEW);
  assert.equal(settled.completion.retryCreated, false);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 1);
  assert.equal(await db.task.count({ where: {
    projectId: seeded.project.id,
    name: { startsWith: "Autonomous merge tail:" },
  } }), 0);
  assert.equal(await db.task.count({ where: { templateStepId: seeded.readinessStep.id } }), 0);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 0);
});

test("a persisted gate-fail keeps ordinary external git failure settlement", async () => {
  const seeded = await seedRegression();
  const settled = await completeRegressionAfterExternalGitFailure(seeded, "gate-fail");

  assert.equal(settled.run.status, "FAILED");
  assert.equal(settled.run.failureClass, "TASK_FAILED");
  assert.equal(settled.run.headSha, null);
  assert.equal(settled.task.status, TaskStatus.REVIEW);
  assert.equal(await db.task.count({ where: {
    projectId: seeded.project.id,
    name: { startsWith: "Autonomous merge tail:" },
  } }), 0);
  assert.equal(await db.task.count({ where: { templateStepId: seeded.readinessStep.id } }), 0);
});

for (const scenario of ["adopt", "no-push", "wrong-base", "slow-adopt", "read-timeout"] as const) {
  test(`refresh-conflict malformed result uses repository ancestry: ${scenario}`, async () => {
    const seeded = await exercise("refresh-conflict");
    const repair = await repairFor(seeded, "refresh-conflict");
    const head = scenario === "no-push" ? HEAD : RESOLVED;
    const adopts = scenario === "adopt" || scenario === "slow-adopt";
    const reads: string[] = [];
    const repositoryReader = createGitHubReader("test-token", async (input, init) => {
      const url = String(input);
      reads.push(url);
      if (url.endsWith(`/git/ref/heads/${BRANCH}`)) {
        // Both exceed Prisma's default 5s transaction timeout. The timeout
        // case honors the real shared repository deadline, not a fake clock.
        if (scenario === "slow-adopt") await delay(5_500, undefined, { signal: init?.signal ?? undefined });
        if (scenario === "read-timeout") await delay(READINESS_READ_BUDGET_MS + 5_000, undefined, { signal: init?.signal ?? undefined });
        return Response.json({ object: { type: "commit", sha: head } });
      }
      assert.ok(url.endsWith(`/compare/${HEAD}...${head}`) || url.endsWith(`/compare/${BASE}...${head}`), url);
      const missingBase = !adopts && url.endsWith(`/compare/${BASE}...${head}`);
      return Response.json({ status: missingBase ? "diverged" : head === HEAD ? "identical" : "ahead", behind_by: missingBase ? 1 : 0, files: [] });
    });
    // Deliberately omit the delivered head too: the repository is the evidence.
    await completeRepair(seeded, repair.id, "resolved it", null, 1, repositoryReader);
    assert.equal(reads.length, scenario === "read-timeout" ? 1 : 3);
    assert.equal((await db.run.findFirstOrThrow({ where: { taskId: repair.id } })).status, "SUCCEEDED");
    const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
    const result = latestMarker(await readMarkerHistory(db, seeded.regression.id), "repairResult");
    const activity = await db.taskActivity.findFirstOrThrow({ where: {
      taskId: repair.id,
      metadata: { path: ["kind"], equals: "mergeTail.resolverRepositoryFallback" },
    } });
    assert.match(activity.body, /fallback/u);
    assert.equal(asJsonObject(activity.metadata)?.rejectedKey, "body");
    if (scenario === "read-timeout") assert.match(activity.body, /read failed: GitHub read aborted at its deadline/u);
    if (adopts) {
      assert.equal(result?.resolvedHeadSha, head);
      assert.equal(result?.state, null);
      assert.match(activity.body, /adopted/u);
      assert.notEqual(regression.status, TaskStatus.REVIEW);
      assert.equal(await db.inboxMessage.count({ where: { taskId: regression.id } }), 0);
      const claimed = await claimNext();
      assert.equal(claimed.status, 200);
      const body = claimed.body as { regressionRepairHandoff: { repair: { resolvedHeadSha: string } } };
      assert.equal(body.regressionRepairHandoff.repair.resolvedHeadSha, head);
    } else {
      assert.equal(regression.status, TaskStatus.REVIEW);
      assert.match(regression.failureReason ?? "", /invalid output/u);
      assert.equal(result?.state, "invalid-output");
      assert.equal(await db.inboxMessage.count({ where: { taskId: regression.id } }), 1);
    }
  });
}
