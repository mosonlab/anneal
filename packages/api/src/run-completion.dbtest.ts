import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  CleanupStatus,
  DependencyProvisioning,
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  Prisma,
  PrismaClient,
  PushStatus,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
  isIntegratorStoppedError,
} from "@anneal/db";

import { completeRun } from "./run-completion.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

/**
 * The seam. Every one of these refusals is reachable over HTTP, but only as a
 * status code and a body; here each is a named value the caller maps, and the
 * "why did this refuse" question the route used to answer with a follow-up
 * query of its own is answered behind the interface.
 */

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const RUNNER_ID = "run-completion-runner";

let sequence = 0;
const seed = async (status: RunStatus = RunStatus.RUNNING) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Completion", slug: `completion-${suffix}` } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: `agent-${suffix}`, title: "Agent",
    model: "gpt-6-sol:high", runnerPreference: "CODEX", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://github.com/acme/repo.git",
    mountPath: "/repo", defaultBranch: "main", dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  const task = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, name: "Completing", description: "work",
    assigneeAgentId: agent.id, status: TaskStatus.DOING,
  } });
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: task.id, agentId: agent.id, repoId: repo.id,
    runNumber: 1, dedupeKey: `task:${task.id}:run:1`, status,
    runner: "CODEX", model: agent.model, promptHash: "hash", branch: `codex/completion-${suffix}`,
    runnerId: RUNNER_ID, fencingToken: `fence-${suffix}`, leaseGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 600_000),
    heartbeatAt: new Date(), claimedAt: new Date(),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: project.id, taskId: task.id, agentId: agent.id, runner: "CODEX",
    executionStatus: SessionExecutionStatus.RUNNING,
  } });
  return { project, agent, task, run };
};

const completion = (fencingToken: string) => ({
  runnerId: RUNNER_ID,
  fencingToken,
  outcome: { case: "succeeded" as const },
  exitCode: 0,
  pushStatus: PushStatus.NOT_REQUESTED,
  cleanupStatus: CleanupStatus.SUCCEEDED,
  workspaceRetained: false,
});

const seedCanonicalImplementationContinuation = async () => {
  const seeded = await seed();
  const template = await db.taskTemplate.create({ data: {
    projectId: seeded.project.id,
    name: "direct-engineer-workflow",
    description: "Canonical completion evidence",
    variables: [],
  } });
  const step = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    assigneeAgentId: seeded.agent.id,
    stepIndex: 2,
    name: "Implementation",
    assigneeType: "AGENT",
    prompt: "Implement the brief",
    outputKind: "implementation",
    requiresCommit: true,
    opensPullRequest: true,
    layer: 2,
  } });
  const salvage = `agentos/${seeded.task.id}/run-1`;
  const baseSha = "5".repeat(40);
  await db.task.update({ where: { id: seeded.task.id }, data: {
    templateId: template.id,
    templateStepId: step.id,
    chainId: `continuation-${seeded.task.id}`,
    chainIndex: 2,
    chainLayer: 2,
    opensPullRequest: true,
  } });
  const run = await db.run.update({ where: { id: seeded.run.id }, data: {
    runNumber: 2,
    dedupeKey: `task:${seeded.task.id}:run:2`,
    branch: salvage,
    pushedBranch: null,
    targetBranch: salvage,
    baseSha,
    requiresCommit: false,
    maxRunsPerTask: 2,
  } });
  await db.run.create({ data: {
    projectId: seeded.project.id,
    taskId: seeded.task.id,
    agentId: seeded.agent.id,
    repoId: run.repoId,
    runNumber: 1,
    dedupeKey: `task:${seeded.task.id}:run:1`,
    status: RunStatus.LOST,
    runner: "CODEX",
    model: seeded.agent.model,
    promptHash: "prior-hash",
    branch: salvage,
    pushedBranch: salvage,
    targetBranch: "main",
    baseSha: "4".repeat(40),
    headSha: baseSha,
    maxRunsPerTask: 2,
    endedAt: new Date(),
  } });
  return { ...seeded, step, run, baseSha };
};

test("the merge-executor principal on an ordinary run is refused before anything is written", async () => {
  const { run } = await seed();
  const refused = await completeRun(db, {
    runId: run.id,
    body: completion(run.fencingToken!),
    claimantClass: "merge-executor",
  });
  assert.deepEqual(refused, {
    reason: "forbidden",
    message: "The merge-executor principal may only act on mechanical runs",
  });
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.RUNNING);
});

// WAITING_INBOX is an active status, so a suspended run whose fence is still
// good completes normally. The refusal exists for what `suspendForInbox`
// actually leaves behind: a suspended run the caller no longer holds the fence
// for. That is one stale token away from the case below, and the two must not
// answer the same thing.
test("a suspended run refuses as waiting-inbox, not as a stale fence", async () => {
  const { run } = await seed(RunStatus.WAITING_INBOX);
  const refused = await completeRun(db, {
    runId: run.id,
    body: completion("fence-from-a-previous-generation"),
    claimantClass: "runner",
  });
  assert.deepEqual(refused, {
    reason: "conflict",
    message: "Run suspended for Inbox",
    detail: { code: "WAITING_INBOX" },
  });
});

test("a superseded fencing token refuses as a fence, carrying the reason", async () => {
  const { run } = await seed();
  const refused = await completeRun(db, {
    runId: run.id,
    body: completion("fence-from-a-previous-generation"),
    claimantClass: "runner",
  });
  assert.deepEqual(refused, {
    reason: "conflict",
    message: "Stale fencing token",
    detail: { reason: "stale-fence" },
  });
});

test("an accepted completion returns what it did rather than a response", async () => {
  const { task, run } = await seed();
  const result = await completeRun(db, {
    runId: run.id,
    body: completion(run.fencingToken!),
    claimantClass: "runner",
  });
  assert.deepEqual(result, {
    taskId: task.id,
    succeeded: true,
    retryCreated: false,
    failureClass: null,
  });
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.SUCCEEDED);
});

test("a no-change salvage continuation succeeds only with canonical implementation evidence at its base", async () => {
  for (const withOutput of [true, false]) {
    const { task, run, baseSha } = await seedCanonicalImplementationContinuation();
    if (withOutput) {
      await db.taskStepOutput.create({ data: {
        taskId: task.id,
        runId: run.id,
        kind: "implementation",
        body: JSON.stringify({
          schemaVersion: 1,
          headSha: baseSha,
          baseSha,
          summary: "The salvaged base already delivers the brief.",
          testsRun: ["focused"],
        }),
        commitSha: baseSha,
        metadata: {},
      } });
    }

    const result = await completeRun(db, {
      runId: run.id,
      body: {
        ...completion(run.fencingToken!),
        branch: run.branch,
        pushedBranch: run.pushedBranch,
        baseSha,
        headSha: baseSha,
      },
      claimantClass: "runner",
    });
    const stored = await db.run.findUniqueOrThrow({ where: { id: run.id } });

    assert.equal((result as { succeeded: boolean }).succeeded, withOutput);
    assert.equal(stored.status, withOutput ? RunStatus.SUCCEEDED : RunStatus.FAILED);
    assert.equal(stored.failureReason, withOutput
      ? null
      : `missing implementation task output for current Run ${run.id}`);
  }
});

test("a manual no-change continuation is proved by this Run's own output, whatever its kind", async () => {
  for (const withOutput of [true, false]) {
    const { task, run, baseSha } = await seedCanonicalImplementationContinuation();
    await db.task.update({ where: { id: task.id }, data: {
      templateId: null,
      templateStepId: null,
      chainId: null,
      chainIndex: null,
      chainLayer: null,
    } });
    if (withOutput) {
      await db.taskStepOutput.create({ data: {
        taskId: task.id,
        runId: run.id,
        kind: "result",
        body: "The audit found nothing left to change.",
        commitSha: baseSha,
        metadata: {},
      } });
    }

    const result = await completeRun(db, {
      runId: run.id,
      body: {
        ...completion(run.fencingToken!),
        branch: run.branch,
        baseSha,
        headSha: baseSha,
      },
      claimantClass: "runner",
    });
    const stored = await db.run.findUniqueOrThrow({ where: { id: run.id } });

    assert.equal("succeeded" in result && result.succeeded, withOutput);
    assert.equal(stored.status, withOutput ? RunStatus.SUCCEEDED : RunStatus.FAILED);
    assert.equal(stored.failureReason, withOutput
      ? null
      : `missing task output for current Run ${run.id}`);
  }
});

test("a configured non-committing Step at its ceiling is not treated as a relaxed continuation", async () => {
  const { step, run, baseSha } = await seedCanonicalImplementationContinuation();
  await db.taskTemplateStep.update({
    where: { id: step.id },
    data: { outputKind: "documentation", requiresCommit: false },
  });

  const result = await completeRun(db, {
    runId: run.id,
    body: {
      ...completion(run.fencingToken!),
      branch: run.branch,
      baseSha,
      headSha: baseSha,
    },
    claimantClass: "runner",
  });
  const stored = await db.run.findUniqueOrThrow({ where: { id: run.id } });

  assert.equal("succeeded" in result && result.succeeded, true);
  assert.equal(stored.status, RunStatus.SUCCEEDED);
});

test("a resolved integrator stop race rolls back the whole predecessor completion", async () => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Stop race", slug: `stop-race-${suffix}` } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const predecessorAgent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `predecessor-${suffix}`,
    title: "Predecessor",
    model: "gpt-6-sol:high",
    runnerPreference: "CODEX",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const integratorAgent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "merge-integrator",
    title: "Merge integrator",
    model: "mechanical/merge-executor-v1",
    runnerPreference: "CLAUDE",
    foundationalPrompt: "mechanical",
    rolePrompt: "mechanical",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "repo",
    remoteUrl: "https://github.com/acme/repo.git",
    mountPath: "/repo",
    defaultBranch: "main",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: `stop-race-template-${suffix}`,
    description: "Exercise the completion-to-integrator transaction seam",
    variables: [],
  } });
  const predecessorStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    assigneeAgentId: predecessorAgent.id,
    stepIndex: 1,
    name: "Predecessor",
    assigneeType: "AGENT",
    prompt: "produce output",
    outputKind: "result",
    layer: 1,
  } });
  const integratorStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id,
    assigneeAgentId: integratorAgent.id,
    stepIndex: 2,
    name: "Integrator",
    assigneeType: "AGENT",
    prompt: "merge",
    outputKind: "merge-result",
    opensPullRequest: false,
    layer: 2,
  } });
  const chainId = `stop-race-chain-${suffix}`;
  const predecessor = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    templateId: template.id,
    templateStepId: predecessorStep.id,
    assigneeAgentId: predecessorAgent.id,
    name: "Predecessor",
    description: "complete",
    status: TaskStatus.DOING,
    chainId,
    chainIndex: 1,
    chainLayer: 1,
  } });
  const successor = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    templateId: template.id,
    templateStepId: integratorStep.id,
    assigneeAgentId: integratorAgent.id,
    name: "Integrator",
    description: "merge",
    status: TaskStatus.TODO,
    chainId,
    chainIndex: 2,
    chainLayer: 2,
    opensPullRequest: false,
  } });
  const run = await db.run.create({ data: {
    projectId: project.id,
    taskId: predecessor.id,
    agentId: predecessorAgent.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${predecessor.id}:run:1`,
    status: RunStatus.RUNNING,
    runner: "CODEX",
    model: predecessorAgent.model,
    promptHash: "hash",
    branch: `codex/stop-race-${suffix}`,
    runnerId: RUNNER_ID,
    fencingToken: `fence-${suffix}`,
    leaseGeneration: 1,
    leaseExpiresAt: new Date(Date.now() + 600_000),
    heartbeatAt: new Date(),
    claimedAt: new Date(),
  } });
  const session = await db.session.create({ data: {
    runId: run.id,
    projectId: project.id,
    taskId: predecessor.id,
    agentId: predecessorAgent.id,
    runner: "CODEX",
    executionStatus: SessionExecutionStatus.RUNNING,
  } });
  const stop = await db.taskActivity.create({ data: {
    taskId: successor.id,
    actorType: "control-plane",
    body: "Merge integrator stopped: base-drift",
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.result,
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      outcome: "stopped",
      condition: "base-drift",
      evidence: "base advanced",
      sourceRunId: run.id,
    },
  } });

  let dispositionReads = 0;
  const withResolvedStopOnReread = (tx: Prisma.TransactionClient): Prisma.TransactionClient => {
    const activity = new Proxy(tx.taskActivity, {
      get(target, property, receiver) {
        if (property === "findMany") {
          return async (args: Prisma.TaskActivityFindManyArgs) => {
            const rows = await target.findMany(args);
            const ascending = !Array.isArray(args.orderBy) && args.orderBy?.createdAt === "asc";
            if (args.where?.taskId === successor.id && ascending) {
              dispositionReads += 1;
              if (dispositionReads === 2) {
                return [...rows, { metadata: {
                  kind: MERGE_INTEGRATOR_KIND.stopAnswer,
                  schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
                  stopId: stop.id,
                  condition: "base-drift",
                  choice: "abandon",
                  disposition: "terminal-abandoned",
                } }];
              }
            }
            return rows;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return new Proxy(tx, {
      get(target, property, receiver) {
        if (property === "taskActivity") return activity;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const racingDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number },
        ) => target.$transaction((tx) => operation(withResolvedStopOnReread(tx)), options);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  await assert.rejects(
    completeRun(racingDb, {
      runId: run.id,
      body: { ...completion(run.fencingToken!), output: "predecessor output" },
      claimantClass: "runner",
    }),
    (error: unknown) => {
      assert.equal(isIntegratorStoppedError(error), true);
      if (!isIntegratorStoppedError(error)) return false;
      assert.equal(error.taskId, successor.id);
      assert.equal(error.condition, "base-drift");
      return true;
    },
  );
  assert.equal(dispositionReads, 2, "openRun and the post-savepoint branch must both read stop dispositions");

  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.RUNNING);
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: session.id } })).executionStatus, SessionExecutionStatus.RUNNING);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: predecessor.id } })).status, TaskStatus.DOING);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: predecessor.id } }), 0);
  assert.equal(await db.taskActivity.count({ where: { taskId: predecessor.id } }), 0);
  const parked = await db.task.findUniqueOrThrow({ where: { id: successor.id } });
  assert.equal(parked.status, TaskStatus.TODO);
  assert.equal(parked.failureReason, null);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
  assert.deepEqual(
    await db.taskActivity.findMany({ where: { taskId: successor.id }, select: { id: true } }),
    [{ id: stop.id }],
  );
});

test("completion persists outside-workspace worktree observations without changing the outcome", async () => {
  const { run } = await seed();
  const violations = ["/operator/worktrees/one", "/operator/worktrees/two"];
  const result = await completeRun(db, {
    runId: run.id,
    body: { ...completion(run.fencingToken!), worktreeContainmentViolations: violations },
    claimantClass: "runner",
  });
  assert.equal((result as { succeeded?: boolean }).succeeded, true);
  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.deepEqual(closed.worktreeContainmentViolations, violations);
  assert.equal(closed.status, RunStatus.SUCCEEDED);
});

test("omitted and empty containment observations remain absent on compliant completion", async () => {
  for (const violations of [undefined, []] as const) {
    const { run } = await seed();
    const result = await completeRun(db, {
      runId: run.id,
      body: {
        ...completion(run.fencingToken!),
        ...(violations === undefined ? {} : { worktreeContainmentViolations: [...violations] }),
      },
      claimantClass: "runner",
    });
    assert.equal((result as { succeeded?: boolean }).succeeded, true);
    const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(closed.worktreeContainmentViolations, null);
    assert.equal(closed.status, RunStatus.SUCCEEDED);
  }
});
