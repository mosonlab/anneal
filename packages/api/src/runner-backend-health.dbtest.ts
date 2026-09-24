import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { DependencyProvisioning, enqueueTaskRun, PrismaClient, RunnerKind, RunnerPreference, RunStatus, TaskStatus } from "@anneal/db";

import {
  projectRunnerBackend,
  recordRunnerBackendReport,
  runnerBackendAllowsClaim,
} from "./runner-backend-health.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
let sequence = 0;
const priorDefaultChatId = process.env.FEISHU_DEFAULT_CHAT_ID;
const priorRunnerToken = process.env.RUNNER_TOKEN;
const RUNNER_TOKEN = "runner-backend-health-test-token";

before(() => {
  process.env.FEISHU_DEFAULT_CHAT_ID = "backend-health-operators";
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorDefaultChatId === undefined) delete process.env.FEISHU_DEFAULT_CHAT_ID;
  else process.env.FEISHU_DEFAULT_CHAT_ID = priorDefaultChatId;
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
});

const seedQueuedTask = async (runnerPreference: RunnerPreference) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({
    data: { name: `Backend health ${suffix}`, slug: `backend-health-${suffix}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: `agent-${suffix}`,
      title: "Agent",
      model: runnerPreference === RunnerPreference.CODEX ? "gpt-5.6-sol" : "claude-opus-5:high",
      runnerPreference,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: "repo",
      remoteUrl: "https://github.com/acme/widgets.git",
      mountPath: "/repo",
      defaultBranch: "main",
      dependencyProvisioning: DependencyProvisioning.NONE,
    },
  });
  await db.agentRepoAccess.create({
    data: {
      projectId: project.id,
      agentId: agent.id,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: "GIT_WRITE",
    },
  });
  const task = await db.task.create({
    data: {
      projectId: project.id,
      name: `${runnerPreference} task`,
      description: "exercise runner backend health",
      assigneeAgentId: agent.id,
      repoId: repo.id,
      status: TaskStatus.TODO,
    },
  });
  await db.$transaction((tx) => enqueueTaskRun(tx as never, task.id));
  return task;
};

test("preflight opens one circuit alert, fans out its reason, and closes the alert on recovery", async () => {
  const task = await seedQueuedTask(RunnerPreference.CODEX);
  const openedAt = new Date("2026-08-29T10:00:00.000Z");
  const repeatedAt = new Date("2026-08-29T10:01:00.000Z");
  const recoveredAt = new Date("2026-08-29T10:02:00.000Z");
  const initialFailure = {
    kind: "preflight",
    runner: RunnerKind.CODEX,
    ok: false,
    cliVersion: "codex-cli test",
    authMode: "chatgpt",
    capabilities: { resume: true },
    error: "not-authenticated: run codex login",
  } as const;

  await Promise.all([
    recordRunnerBackendReport(db, initialFailure, openedAt),
    recordRunnerBackendReport(db, initialFailure, openedAt),
  ]);
  const repeated = await recordRunnerBackendReport(db, {
    kind: "preflight",
    runner: RunnerKind.CODEX,
    ok: false,
    cliVersion: "codex-cli test",
    authMode: "chatgpt",
    capabilities: { resume: true },
    error: "not-authenticated: refresh codex login",
  }, repeatedAt);

  assert.equal(repeated.circuitOpenedAt?.toISOString(), openedAt.toISOString());
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).failureReason,
    "not-authenticated: refresh codex login");
  const openAlerts = await db.inboxMessage.findMany({
    where: { dedupeKey: { startsWith: "runner-preflight-failed:CODEX:" } },
  });
  assert.equal(openAlerts.length, 1);
  assert.equal(openAlerts[0]?.status, "OPEN");
  assert.ok(openAlerts[0]?.threadId);
  assert.deepEqual(projectRunnerBackend(RunnerKind.CODEX, repeated), {
    runner: "CODEX",
    cliVersion: "codex-cli test",
    cliAvailable: null,
    cliResolvedPath: null,
    cliAvailabilityReason: null,
    cliUnavailableSince: null,
    lastAvailabilityAt: null,
    authMode: "chatgpt",
    lastPreflightAt: repeatedAt.toISOString(),
    lastPreflightOk: false,
    circuitOpen: true,
    circuitReason: "not-authenticated: refresh codex login",
  });

  const recovered = await recordRunnerBackendReport(db, {
    kind: "preflight",
    runner: RunnerKind.CODEX,
    ok: true,
    cliVersion: "codex-cli test",
    authMode: "chatgpt",
    capabilities: { resume: true },
  }, recoveredAt);

  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).failureReason, null);
  const closedAlert = await db.inboxMessage.findUniqueOrThrow({ where: { id: openAlerts[0]!.id } });
  assert.equal(closedAlert.status, "CLOSED");
  assert.equal(closedAlert.answeredAt?.toISOString(), recoveredAt.toISOString());
  assert.equal(projectRunnerBackend(RunnerKind.CODEX, recovered).circuitOpen, false);
  assert.equal(projectRunnerBackend(RunnerKind.CODEX, recovered).lastPreflightOk, true);
});

test("CLI availability shares the alert lifecycle and its transition is visible in the projection", async () => {
  const task = await seedQueuedTask(RunnerPreference.CLAUDE);
  const unavailableAt = new Date("2026-08-29T11:00:00.000Z");
  const repeatedAt = new Date("2026-08-29T11:01:00.000Z");
  const recoveredAt = new Date("2026-08-29T11:02:00.000Z");
  const unavailable = {
    kind: "availability" as const,
    runner: RunnerKind.CLAUDE,
    binary: "claude",
    available: false,
    resolvedPath: null,
  };

  await recordRunnerBackendReport(db, unavailable, unavailableAt);
  const repeated = await recordRunnerBackendReport(db, unavailable, repeatedAt);

  assert.match((await db.task.findUniqueOrThrow({ where: { id: task.id } })).failureReason ?? "",
    /claude CLI "claude" was not found/u);
  const openAlerts = await db.inboxMessage.findMany({
    where: { dedupeKey: { startsWith: "runner-cli-unavailable:CLAUDE:" } },
  });
  assert.equal(openAlerts.length, 1);
  assert.equal(openAlerts[0]?.status, "OPEN");
  assert.ok(openAlerts[0]?.threadId);
  const unavailableProjection = projectRunnerBackend(RunnerKind.CLAUDE, repeated);
  assert.equal(unavailableProjection.cliAvailable, false);
  assert.equal(unavailableProjection.cliUnavailableSince, unavailableAt.toISOString());
  assert.equal(unavailableProjection.lastAvailabilityAt, repeatedAt.toISOString());

  const recovered = await recordRunnerBackendReport(db, {
    kind: "availability",
    runner: RunnerKind.CLAUDE,
    binary: "claude",
    available: true,
    resolvedPath: "/opt/runner/bin/claude",
  }, recoveredAt);

  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).failureReason, null);
  const closedAlert = await db.inboxMessage.findUniqueOrThrow({ where: { id: openAlerts[0]!.id } });
  assert.equal(closedAlert.status, "CLOSED");
  assert.equal(closedAlert.answeredAt?.toISOString(), recoveredAt.toISOString());
  assert.deepEqual(projectRunnerBackend(RunnerKind.CLAUDE, recovered), {
    runner: "CLAUDE",
    cliVersion: null,
    cliAvailable: true,
    cliResolvedPath: "/opt/runner/bin/claude",
    cliAvailabilityReason: null,
    cliUnavailableSince: null,
    lastAvailabilityAt: recoveredAt.toISOString(),
    authMode: null,
    lastPreflightAt: null,
    lastPreflightOk: false,
    circuitOpen: false,
    circuitReason: null,
  });
});

test("availability reported by a CODEX-only runner does not affect CLAUDE health or tasks", async () => {
  const codexTask = await seedQueuedTask(RunnerPreference.CODEX);
  const claudeTask = await seedQueuedTask(RunnerPreference.CLAUDE);

  const response = await createApp(db).request("/runner/availability", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: "codex-only-runner",
      runner: RunnerKind.CODEX,
      binary: "codex",
      available: false,
      resolvedPath: null,
    }),
  });
  assert.equal(response.status, 200, await response.text());

  const codexState = await db.runnerBackendState.findUniqueOrThrow({ where: { runner: RunnerKind.CODEX } });
  assert.equal(runnerBackendAllowsClaim(codexState), false);
  const codexProjection = projectRunnerBackend(RunnerKind.CODEX, codexState);
  assert.equal(codexProjection.cliAvailable, false);
  assert.match(codexProjection.cliAvailabilityReason ?? "", /codex CLI "codex" was not found/u);
  const claudeState = await db.runnerBackendState.findUnique({ where: { runner: RunnerKind.CLAUDE } });
  assert.equal(claudeState, null);
  assert.equal(runnerBackendAllowsClaim(claudeState), true);

  const [storedCodexTask, storedClaudeTask] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: codexTask.id } }),
    db.task.findUniqueOrThrow({ where: { id: claudeTask.id } }),
  ]);
  assert.match(storedCodexTask.failureReason ?? "", /codex CLI "codex" was not found/u);
  assert.equal(storedClaudeTask.failureReason, null);
});

test("claims stay queued while CLI availability or preflight health denies the backend, then recover", async () => {
  const task = await seedQueuedTask(RunnerPreference.CODEX);
  const run = await db.run.findFirstOrThrow({ where: { taskId: task.id } });
  const claim = (runnerId: string) => createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId, leaseSeconds: 60 }),
  });

  const unavailable = await recordRunnerBackendReport(db, {
    kind: "availability",
    runner: RunnerKind.CODEX,
    binary: "codex",
    available: false,
    resolvedPath: null,
  }, new Date("2026-08-29T12:00:00.000Z"));
  assert.equal(runnerBackendAllowsClaim(unavailable), false);
  assert.equal((await claim("cli-unavailable-runner")).status, 204);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.QUEUED);
  assert.equal(await db.session.count({ where: { runId: run.id } }), 0);

  await recordRunnerBackendReport(db, {
    kind: "availability",
    runner: RunnerKind.CODEX,
    binary: "codex",
    available: true,
    resolvedPath: "/opt/runner/bin/codex",
  }, new Date("2026-08-29T12:01:00.000Z"));
  const openCircuit = await recordRunnerBackendReport(db, {
    kind: "preflight",
    runner: RunnerKind.CODEX,
    ok: false,
    capabilities: { resume: true },
    error: "not-authenticated: run codex login",
  }, new Date("2026-08-29T12:02:00.000Z"));
  assert.equal(runnerBackendAllowsClaim(openCircuit), false);
  assert.equal((await claim("open-circuit-runner")).status, 204);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.QUEUED);
  assert.equal(await db.session.count({ where: { runId: run.id } }), 0);

  const recovered = await recordRunnerBackendReport(db, {
    kind: "preflight",
    runner: RunnerKind.CODEX,
    ok: true,
    capabilities: { resume: true },
  }, new Date("2026-08-29T12:03:00.000Z"));
  assert.equal(runnerBackendAllowsClaim(recovered), true);
  const claimed = await claim("healthy-backend-runner");
  assert.equal(claimed.status, 200, await claimed.text());
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.CLAIMED);
  assert.equal(await db.session.count({ where: { runId: run.id } }), 1);
});
