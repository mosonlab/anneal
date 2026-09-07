import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  enqueueTaskRun,
  FailureClass,
  pinnedImplementationRange,
  PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

/**
 * A pinned range may only name a commit some Run actually published.
 *
 * On 2026-09-06 three implementation Runs died before their push with
 * `cli-missing (exit 127)`. Each had already recorded the `baseSha` its
 * workspace was provisioned at, and that workspace was later discarded, so the
 * derived pin named a commit no remote carried: every review sibling of chain
 * `c4148ba3` failed on the runner with `upload-pack: not our ref`, and retrying
 * reproduced it exactly.
 */
const RUNNER_TOKEN = "pinned-base-publication-runner";
const UNPUBLISHED_BASE = "4".repeat(40);
const PUBLISHED_BASE = "d".repeat(40);
const IMPLEMENTATION_HEAD = "a".repeat(40);
const implementationBody = JSON.stringify({
  schemaVersion: 1,
  baseSha: PUBLISHED_BASE,
  headSha: IMPLEMENTATION_HEAD,
  summary: "implementation evidence",
  testsRun: ["focused"],
});
const priorRunnerToken = process.env.RUNNER_TOKEN;
let db: PrismaClient;

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
});

const claim = (runnerId = "pinned-base-runner") => createApp(db).request("/runner/tasks/claim", {
  method: "POST",
  headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ runnerId, leaseSeconds: 60 }),
});

/** The project, agent, repo grant and two-Step template both fixtures share. */
const seedTemplateChain = async () => {
  const label = `pinned-base-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const project = await db.project.create({ data: { name: label, slug: label } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "pinned-base",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "pinned-base-agent",
    title: "Pinned base agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "pinned-base-repo",
    remoteUrl: "https://example.test/pinned-base.git",
    mountPath: "/repo",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  const template = await db.taskTemplate.create({
    data: {
      projectId: project.id,
      name: `${label} template`,
      description: "pinned base publication fixture",
      variables: [],
      steps: { create: [
        {
          stepIndex: 0,
          layer: 0,
          name: "Implementation",
          assigneeType: "AGENT",
          assigneeAgentId: agent.id,
          prompt: "implement",
        },
        {
          stepIndex: 1,
          layer: 1,
          name: "Review",
          assigneeType: "AGENT",
          assigneeAgentId: agent.id,
          prompt: "review",
          baseFromStepIndex: 0,
        },
      ] },
    },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const chainId = `${label}-chain`;
  return { label, project, repo, agent, template, chainId };
};

/** An implementation Task carrying the caller's Runs, and a review Step pinned
 *  to it with one queued Run. Each seeded Run is terminalized before the next
 *  is opened, exactly as a failed attempt and its replacement appear in
 *  production. */
const seedPinnedChain = async (runs: Array<{
  status: RunStatus;
  baseSha: string;
  published?: boolean;
}>) => {
  const { label, project, repo, agent, template, chainId } = await seedTemplateChain();
  const implementationTask = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    assigneeAgentId: agent.id,
    templateId: template.id,
    templateStepId: template.steps[0]!.id,
    chainId,
    chainIndex: 0,
    chainLayer: 0,
    name: "Implementation",
    description: "implementation",
  } });
  const seededRuns = [];
  for (const [index, seed] of runs.entries()) {
    const run = await db.$transaction((tx) => enqueueTaskRun(
      tx as never,
      implementationTask.id,
      new Date(`2026-09-06T0${index}:00:00.000Z`),
    ));
    seededRuns.push(await db.run.update({
      where: { id: run.id },
      data: {
        status: seed.status,
        baseSha: seed.baseSha,
        headSha: IMPLEMENTATION_HEAD,
        endedAt: new Date(`2026-09-06T0${index}:30:00.000Z`),
        ...(seed.published
          ? {
            pushedBranch: `agentos/chain/${label}`,
            basePublishedAt: new Date(`2026-09-06T0${index}:20:00.000Z`),
          }
          : {}),
      },
    }));
  }
  await db.task.update({ where: { id: implementationTask.id }, data: { status: TaskStatus.DONE } });
  const succeeded = seededRuns.find((run) => run.status === RunStatus.SUCCEEDED) ?? seededRuns.at(-1)!;
  await db.taskStepOutput.create({ data: {
    taskId: implementationTask.id,
    runId: succeeded.id,
    kind: "implementation",
    body: implementationBody,
    commitSha: IMPLEMENTATION_HEAD,
  } });
  const reviewTask = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    assigneeAgentId: agent.id,
    templateId: template.id,
    templateStepId: template.steps[1]!.id,
    chainId,
    chainIndex: 1,
    chainLayer: 1,
    name: "Review",
    description: "review",
  } });
  // The dependent is queued the way production queued it: while its base still
  // counted as published. Run birth derives the pinned range too (chain.dbtest:
  // a successor whose implementation Run holds no publishable base is refused
  // and never created), so the row a claim parks is always one that predates
  // the poisoning — the incident's own review Runs, queued before this rule
  // existed. Seeding it means publishing the base for the birth and taking the
  // marker back afterwards.
  const publishedForBirth = new Date("2026-09-06T09:00:00.000Z");
  await db.run.updateMany({
    where: { taskId: implementationTask.id },
    data: { pushedBranch: `agentos/chain/${label}`, basePublishedAt: publishedForBirth },
  });
  const reviewRun = await db.$transaction((tx) => enqueueTaskRun(
    tx as never,
    reviewTask.id,
    new Date("2026-09-06T10:00:00.000Z"),
  ));
  for (const [index, seed] of runs.entries()) {
    if (seed.published) continue;
    await db.run.update({
      where: { id: seededRuns[index]!.id },
      data: { pushedBranch: null, basePublishedAt: null },
    });
  }
  return { implementationTask, seededRuns, reviewTask, reviewRun };
};

const pinnedRangeFor = async (reviewTaskId: string) => pinnedImplementationRange(
  db as never,
  await db.task.findUniqueOrThrow({
    where: { id: reviewTaskId },
    select: {
      id: true,
      projectId: true,
      templateId: true,
      chainId: true,
      templateStep: { select: { baseFromStepIndex: true } },
    },
  }),
);

test("the pinned base skips a dead Run's unpublished base for the one a later Run published", async () => {
  const seeded = await seedPinnedChain([
    { status: RunStatus.FAILED, baseSha: UNPUBLISHED_BASE },
    { status: RunStatus.SUCCEEDED, baseSha: PUBLISHED_BASE, published: true },
  ]);

  assert.deepEqual(await pinnedRangeFor(seeded.reviewTask.id), {
    implementationBaseSha: PUBLISHED_BASE,
    implementationHeadSha: IMPLEMENTATION_HEAD,
  });
});

test("a chain whose only base is unpublished parks its dependent and names the commit", async () => {
  const seeded = await seedPinnedChain([{ status: RunStatus.FAILED, baseSha: UNPUBLISHED_BASE }]);

  assert.equal((await claim()).status, 204);

  const [run, task, activities, notifications] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: seeded.reviewRun.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.reviewTask.id } }),
    db.taskActivity.findMany({ where: { taskId: seeded.reviewTask.id } }),
    db.inboxMessage.findMany({ where: { taskId: seeded.reviewTask.id } }),
  ]);
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(run.failureClass, FailureClass.TASK_FAILED);
  assert.equal(run.retryable, false);
  assert.match(run.failureReason ?? "", /^PinnedBaseCommitError: /u);
  assert.equal(task.status, TaskStatus.BACKLOG);
  assert.equal(activities.length, 1);
  const metadata = activities[0]!.metadata as Record<string, unknown>;
  assert.equal(metadata.condition, "candidate-activation-failed");
  assert.equal(metadata.failureType, "PinnedBaseCommitError");
  assert.equal(metadata.unpublishedBaseSha, UNPUBLISHED_BASE);
  assert.equal(metadata.implementationTaskId, seeded.implementationTask.id);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!.body, new RegExp(UNPUBLISHED_BASE, "u"));
  assert.match(notifications[0]!.body, new RegExp(seeded.implementationTask.id, "u"));
  // Fail loud, but never on the runner: nothing was handed out to fetch it.
  assert.equal(await db.session.count({ where: { runId: seeded.reviewRun.id } }), 0);
});

test("a Run written before the marker existed is read through its own outcome", async () => {
  // No backfill wrote `basePublishedAt` onto rows that predate it, so a
  // succeeded Run of a committing step still counts as published…
  const legacySuccess = await seedPinnedChain([{ status: RunStatus.SUCCEEDED, baseSha: PUBLISHED_BASE }]);
  assert.deepEqual(await pinnedRangeFor(legacySuccess.reviewTask.id), {
    implementationBaseSha: PUBLISHED_BASE,
    implementationHeadSha: IMPLEMENTATION_HEAD,
  });

  // …and a Run that ended any other way does not.
  const legacyLoss = await seedPinnedChain([{ status: RunStatus.LOST, baseSha: UNPUBLISHED_BASE }]);
  await assert.rejects(
    () => pinnedRangeFor(legacyLoss.reviewTask.id),
    (error: Error) => {
      assert.equal(error.name, "PinnedBaseCommitError");
      assert.match(error.message, new RegExp(`recorded baseSha ${UNPUBLISHED_BASE}, but no Run published a base`, "u"));
      return true;
    },
  );
});

/** A claimed and started implementation Run, provisioned at PUBLISHED_BASE and
 *  not yet published — the row every publication writer is handed. */
const startedImplementationRun = async () => {
  const { project, repo, agent, template, chainId } = await seedTemplateChain();
  const implementationTask = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    assigneeAgentId: agent.id,
    templateId: template.id,
    templateStepId: template.steps[0]!.id,
    chainId,
    chainIndex: 0,
    chainLayer: 0,
    name: "Implementation",
    description: "implementation",
  } });
  const queued = await db.$transaction((tx) => enqueueTaskRun(tx as never, implementationTask.id));

  const claimed = await (await claim()).json() as { run: { id: string; branch: string | null }; fencingToken: string };
  assert.equal(claimed.run.id, queued.id);
  const started = await createApp(db).request(`/runner/runs/${claimed.run.id}/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: "pinned-base-runner",
      fencingToken: claimed.fencingToken,
      adapterVersion: "test-adapter",
      cliVersion: "test-cli",
      promptHash: "a".repeat(64),
      manifest: {},
      workspacePath: `${process.env.RUNNER_WORKSPACE_ROOT}/${claimed.run.id}`,
      branch: claimed.run.branch,
      baseSha: PUBLISHED_BASE,
    }),
  });
  assert.equal(started.status, 200);
  // Provisioning alone is not publication: the base exists only in a workspace
  // that a `cli-missing` death would discard.
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: claimed.run.id } })).basePublishedAt, null);
  return claimed;
};

const completeRun = async (
  claimed: { run: { id: string }; fencingToken: string },
  body: Record<string, unknown>,
) => createApp(db).request(`/runner/runs/${claimed.run.id}/complete`, {
  method: "POST",
  headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    runnerId: "pinned-base-runner",
    fencingToken: claimed.fencingToken,
    exitCode: 0,
    outcome: { case: "succeeded" },
    cleanupStatus: "SUCCEEDED",
    ...body,
  }),
});

test("the publication ACK is what marks a Run's base as reachable", async () => {
  const claimed = await startedImplementationRun();

  const published = await createApp(db).request(`/runner/runs/${claimed.run.id}/publication`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: "pinned-base-runner",
      fencingToken: claimed.fencingToken,
      pushedBranch: claimed.run.branch ?? "agentos/chain/pinned-base",
    }),
  });
  assert.equal(published.status, 200);
  const acknowledged = await db.run.findUniqueOrThrow({ where: { id: claimed.run.id } });
  assert.ok(acknowledged.basePublishedAt, "the push ACK records that the base reached the remote");
  assert.equal(acknowledged.baseSha, PUBLISHED_BASE);
});

test("a completion that reports a push marks the base even when the ACK never arrived", async () => {
  const claimed = await startedImplementationRun();

  const completed = await completeRun(claimed, {
    pushedBranch: claimed.run.branch ?? "agentos/chain/pinned-base",
    pushStatus: "SUCCEEDED",
  });
  assert.equal(completed.status, 200);
  const run = await db.run.findUniqueOrThrow({ where: { id: claimed.run.id } });
  assert.ok(run.basePublishedAt, "the completion's own push report is publication evidence");
  assert.equal(run.baseSha, PUBLISHED_BASE);
});

test("a completion that reports no push leaves the base unmarked", async () => {
  const claimed = await startedImplementationRun();

  assert.equal((await completeRun(claimed, {})).status, 200);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: claimed.run.id } })).basePublishedAt, null);
});
