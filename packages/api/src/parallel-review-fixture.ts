import assert from "node:assert/strict";
import { after, before, beforeEach } from "node:test";

import {
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
  enqueueTaskRun,
  INTEGRATOR_TEMPLATE_NAME,
  RepoPermission,
  RunStatus,
  TaskStatus,
  type CanonicalReviewArtifact,
  type PrismaClient,
} from "@anneal/db";
import type { ClaimContract } from "@anneal/db/claim-contract";

import { createApp } from "./test-app.js";
import { runDbScript } from "./test-db-script.js";
import { resetTestDb, setupTestDb } from "./testdb.js";
import { instantiateTemplate } from "./templates.js";

export const RUNNER_TOKEN = "parallel-review-runner-token";
export const OPERATOR_TOKEN = "parallel-review-operator-token";
export const IMPLEMENTATION_BASE = "1".repeat(40);
export const IMPLEMENTATION_HEAD = "2".repeat(40);
export const SPECIFICATION_BRIEF = "Parallel review specification fixture brief.";
export const BOUND_SPECIFICATION_BRIEF = [
  "Keep direct-chain intent fixed.",
  "",
  "Background: oldRouteName is current behavior.",
  "",
  "Changes:",
  "1. Revalidate oldHandler while preserving claim ordering.",
  "",
  "Out of scope: compound templates.",
  "",
  "Constraints: existing chains remain unchanged.",
  "",
  "Acceptance: bound claims materialize the refreshed brief.",
  "",
  "Route: implementation=senior-dev-astra-medium - claim-time materialization",
].join("\n");

/**
 * The claim these fixtures cast a response body to. It was a third hand-written
 * mirror of the claim payload; naming the contract instead is what makes a
 * field these tests read but the projection stops sending a compile error here
 * rather than an `undefined` in an assertion.
 */
export type Claim = ClaimContract;

export type CanonicalInstallation = {
  projectId: string;
  directTemplateId: string;
  fullTemplateId: string;
  repoId: string;
};

export type DirectFixture = CanonicalInstallation & {
  chainId: string;
  branchName: string;
  implementationTaskId: string;
  solTaskId: string;
  blindTaskId: string;
  fixTaskId: string;
};

export type BoundDirectFixture = DirectFixture & {
  revalidationTaskId: string;
};

export type OptionalDirectFixture = CanonicalInstallation & {
  chainId: string;
  branchName: string;
  implementationTaskId: string;
  solTaskId: string;
  fixTaskId: string;
  regressionTaskId: string;
  readinessTaskId: string;
  mergeTaskId: string;
};

export type FullFixture = CanonicalInstallation & {
  chainId: string;
  branchName: string;
  implementationTaskId: string;
  solTaskId: string;
  blindTaskId: string;
};

type SpecificationRead = {
  repository: string;
  path: string;
  commitSha: string;
};

const createParallelReviewHarness = ({
  getDb,
  getMaterializedSpecification,
  specificationReads,
}: {
  getDb: () => PrismaClient;
  getMaterializedSpecification: () => string;
  specificationReads: SpecificationRead[];
}) => {
  const specificationReader = {
    readFileAtCommit: async (repository: string, path: string, commitSha: string): Promise<Uint8Array> => {
      specificationReads.push({ repository, path, commitSha });
      return new TextEncoder().encode(getMaterializedSpecification());
    },
  };

  const request = async (path: string, method: "GET" | "POST" | "PATCH", token: string, body?: Record<string, unknown>): Promise<{ status: number; body: unknown }> => {
    const response = await createApp(getDb(), { specificationReader }).request(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  };

  const runnerRequest = (path: string, body: Record<string, unknown>) => request(path, "POST", RUNNER_TOKEN, body);
  const operatorRequest = (path: string, method: "POST" | "PATCH", body?: Record<string, unknown>) => request(path, method, OPERATOR_TOKEN, body);

  const seedRepoGrants = async (projectId: string): Promise<string> => {
    const repo = await getDb().repo.create({
      data: {
        projectId,
        name: "parallel-review-repo",
        remoteUrl: "https://github.com/example/parallel-review.git",
        mountPath: "/repo",
        defaultBranch: "main",
        dependencyProvisioning: DependencyProvisioning.NONE,
      },
    });
    const agents = await getDb().agent.findMany({
      where: { projectId },
      select: { id: true },
    });
    await getDb().agentRepoAccess.createMany({
      data: agents.map(({ id: agentId }) => ({
        projectId,
        agentId,
        repoId: repo.id,
        mountPath: "/repo",
        permissions: RepoPermission.GIT_WRITE,
      })),
    });
    return repo.id;
  };

  const canonicalInstallation = async (): Promise<CanonicalInstallation> => {
    const project = await getDb().project.findUniqueOrThrow({
      where: { slug: "agentos-example" },
    });
    const [direct, full] = await Promise.all([
      getDb().taskTemplate.findUniqueOrThrow({
        where: {
          projectId_name: { projectId: project.id, name: DIRECT_TEMPLATE_NAME },
        },
        include: { steps: { orderBy: { stepIndex: "asc" } } },
      }),
      getDb().taskTemplate.findUniqueOrThrow({
        where: {
          projectId_name: {
            projectId: project.id,
            name: INTEGRATOR_TEMPLATE_NAME,
          },
        },
        include: { steps: { orderBy: { stepIndex: "asc" } } },
      }),
    ]);
    assert.deepEqual(
      direct.steps.map((step) => step.layer),
      [1, 2, 3, 3, 4, 5, 6, 7],
    );
    assert.deepEqual(
      full.steps.map((step) => step.layer),
      [1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11],
    );
    return {
      projectId: project.id,
      directTemplateId: direct.id,
      fullTemplateId: full.id,
      repoId: await seedRepoGrants(project.id),
    };
  };

  /**
   * Chain tasks are addressed by the output kind their template step produces.
   * A chain that omitted an optional or conditional step renumbers every later
   * ordinal, so a hardcoded chainIndex silently names a different node.
   */
  const chainTasks = async <ChainTask extends { id: string; templateStepId: string | null }>(
    taskTemplateId: string,
    tasks: ChainTask[],
  ) => {
    const steps = await getDb().taskTemplateStep.findMany({
      where: { taskTemplateId },
      select: { id: true, outputKind: true },
    });
    const outputKindOf = new Map(steps.map(({ id, outputKind }) => [id, outputKind]));
    const byOutputKind = new Map<string, ChainTask>();
    for (const task of tasks) {
      const outputKind = task.templateStepId === null ? null : outputKindOf.get(task.templateStepId) ?? null;
      assert.ok(outputKind, `chain task ${task.id} names no step of template ${taskTemplateId}`);
      assert.ok(!byOutputKind.has(outputKind), `template ${taskTemplateId} declares ${outputKind} twice`);
      byOutputKind.set(outputKind, task);
    }
    return {
      taskFor: (outputKind: string): ChainTask => {
        const task = byOutputKind.get(outputKind);
        assert.ok(task, `chain has no ${outputKind} task`);
        return task;
      },
      omits: (outputKind: string): boolean => !byOutputKind.has(outputKind),
    };
  };

  const instantiateDirect = async (brief = SPECIFICATION_BRIEF): Promise<DirectFixture> => {
    const installation = await canonicalInstallation();
    const branchName = `parallel/direct-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const chain = await instantiateTemplate(getDb(), installation.projectId, installation.directTemplateId, {
      repoId: installation.repoId,
      variables: { branchName },
      name: "parallel direct",
      description: brief,
      autoStart: true,
    });
    const { taskFor } = await chainTasks(installation.directTemplateId, chain.tasks);
    return {
      ...installation,
      chainId: chain.chainId,
      branchName,
      implementationTaskId: taskFor("implementation").id,
      solTaskId: taskFor("review-findings").id,
      blindTaskId: taskFor("blind-findings").id,
      fixTaskId: taskFor("fixed-implementation").id,
    };
  };

  const instantiateBoundDirect = async (brief = BOUND_SPECIFICATION_BRIEF): Promise<BoundDirectFixture> => {
    const installation = await canonicalInstallation();
    const predecessor = await getDb().task.create({
      data: {
        projectId: installation.projectId,
        repoId: installation.repoId,
        name: "Bound direct predecessor",
        description: "Complete to dispatch revalidation",
        chainId: `predecessor-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
        chainIndex: 1,
        chainLayer: 1,
        status: TaskStatus.TODO,
        assigneeType: "HUMAN",
      },
    });
    const branchName = `parallel/bound-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const chain = await instantiateTemplate(getDb(), installation.projectId, installation.directTemplateId, {
      repoId: installation.repoId,
      variables: { branchName },
      name: "parallel bound direct",
      description: brief,
      afterTaskId: predecessor.id,
    });
    assert.equal(chain.tasks.length, 8);
    const { taskFor } = await chainTasks(installation.directTemplateId, chain.tasks);
    const dispatched = await operatorRequest(`/tasks/${predecessor.id}`, "PATCH", { status: TaskStatus.DONE });
    assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
    return {
      ...installation,
      chainId: chain.chainId,
      branchName,
      revalidationTaskId: taskFor("revalidation").id,
      implementationTaskId: taskFor("implementation").id,
      solTaskId: taskFor("review-findings").id,
      blindTaskId: taskFor("blind-findings").id,
      fixTaskId: taskFor("fixed-implementation").id,
    };
  };

  const instantiateOptionalDirect = async (brief = SPECIFICATION_BRIEF): Promise<OptionalDirectFixture> => {
    const installation = await canonicalInstallation();
    // Optional-step omission is a per-instantiation staffing decision now, so
    // the fixture excludes the step it wants absent instead of switching a
    // project-wide setting.
    const optionalStep = await getDb().taskTemplateStep.findFirstOrThrow({
      where: { taskTemplateId: installation.directTemplateId, optional: true },
      select: { stepIndex: true },
    });
    const branchName = `parallel/optional-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const chain = await instantiateTemplate(getDb(), installation.projectId, installation.directTemplateId, {
      repoId: installation.repoId,
      variables: { branchName },
      name: "parallel optional direct",
      description: brief,
      autoStart: true,
      stepOverrides: { [String(optionalStep.stepIndex)]: { include: false } },
    });
    const { taskFor, omits } = await chainTasks(installation.directTemplateId, chain.tasks);
    assert.equal(chain.tasks.length, 6);
    assert.equal(omits("blind-findings"), true);
    return {
      ...installation,
      chainId: chain.chainId,
      branchName,
      implementationTaskId: taskFor("implementation").id,
      solTaskId: taskFor("review-findings").id,
      fixTaskId: taskFor("fixed-implementation").id,
      regressionTaskId: taskFor("regression-verification-v2").id,
      readinessTaskId: taskFor("merge-authorization").id,
      mergeTaskId: taskFor("merge-result").id,
    };
  };

  /** Full Assurance has approval-gated planning nodes. This fixture completes
   * those already-reviewed nodes as historical evidence, then enters the real
   * implementation-to-parallel-review boundary through the runner API. */
  const instantiateFullAtReviewFrontier = async (): Promise<FullFixture> => {
    const installation = await canonicalInstallation();
    const branchName = `parallel/full-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const chain = await instantiateTemplate(getDb(), installation.projectId, installation.fullTemplateId, {
      repoId: installation.repoId,
      variables: { branchName },
      name: "parallel full review",
      description: SPECIFICATION_BRIEF,
      autoStart: false,
    });
    const { taskFor } = await chainTasks(installation.fullTemplateId, chain.tasks);
    const implementation = taskFor("implementation");
    const priorIds = chain.tasks
      .filter((task) => (task.chainIndex ?? 0) < (implementation.chainIndex ?? 0))
      .map((task) => task.id);
    await getDb().task.updateMany({
      where: { id: { in: priorIds } },
      data: { status: TaskStatus.DONE },
    });
    const specificationTask = taskFor("spec");
    await getDb().taskStepOutput.create({
      data: {
        taskId: specificationTask.id,
        kind: "spec",
        body: JSON.stringify({
          schemaVersion: 1,
          headSha: IMPLEMENTATION_BASE,
          spec: SPECIFICATION_BRIEF,
        }),
        commitSha: IMPLEMENTATION_BASE,
      },
    });
    const revisedPlanTask = taskFor("revised-plan");
    await getDb().taskStepOutput.create({
      data: {
        taskId: revisedPlanTask.id,
        kind: "revised-plan",
        body: JSON.stringify({
          schemaVersion: 1,
          headSha: IMPLEMENTATION_BASE,
          summary: "Parallel review fixture plan approved without revisions.",
          addressedFindingIds: [],
          declinedFindings: [],
        }),
        commitSha: IMPLEMENTATION_BASE,
      },
    });
    await getDb().$transaction((tx) => enqueueTaskRun(tx, implementation.id));
    return {
      ...installation,
      chainId: chain.chainId,
      branchName,
      implementationTaskId: implementation.id,
      solTaskId: taskFor("review-findings").id,
      blindTaskId: taskFor("blind-findings").id,
    };
  };

  const claim = async (runnerId: string): Promise<Claim> => {
    const result = await runnerRequest("/runner/tasks/claim", {
      runnerId,
      leaseSeconds: 120,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body as Claim;
  };

  const persistSessionOutput = async (claimed: Claim, kind: string, body: Record<string, unknown>, commitSha: string): Promise<void> => {
    const response = await createApp(getDb()).request(`/session/runs/${claimed.run.id}/output`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${claimed.sessionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fencingToken: claimed.fencingToken,
        kind,
        body: JSON.stringify(body),
        commitSha,
      }),
    });
    const responseBody = await response.json();
    assert.equal(response.status, 200, JSON.stringify(responseBody));
  };

  const complete = async (
    claimed: Claim,
    runnerId: string,
    options: {
      outputKind?: string;
      output?: Record<string, unknown>;
      headSha?: string;
      baseSha?: string;
      branch?: string;
      failed?: boolean;
    } = {},
  ): Promise<{ status: number; body: unknown }> => {
    const headSha = options.headSha ?? IMPLEMENTATION_HEAD;
    if (options.output && options.outputKind) {
      await persistSessionOutput(claimed, options.outputKind, options.output, headSha);
    }
    return runnerRequest(`/runner/runs/${claimed.run.id}/complete`, {
      runnerId,
      fencingToken: claimed.fencingToken,
      outcome: options.failed
        ? {
            case: "provider-failure",
            reason: "parallel-review fixture failure",
            envelope: {
              version: 1,
              phase: "EXECUTE",
              runnerClass: "TASK_FAILED",
              exitCode: 1,
              signal: null,
              terminationReason: null,
              terminalEventSeen: true,
              terminalSuccess: false,
              agentExited: true,
              providerError: null,
              stderrSummary: "parallel-review fixture failure",
              stdoutSummary: null,
              timedOut: false,
              transient: false,
              timeoutMs: null,
            },
          }
        : { case: "succeeded" },
      exitCode: options.failed ? 1 : 0,
      branch: options.branch ?? claimed.run.branch ?? "parallel/review-head",
      pushedBranch: options.branch ?? claimed.run.branch ?? "parallel/review-head",
      baseSha: options.baseSha ?? IMPLEMENTATION_BASE,
      headSha: options.failed ? null : headSha,
      pushStatus: options.failed ? "FAILED" : "SUCCEEDED",
      cleanupStatus: "SUCCEEDED",
      workspaceRetained: false,
    });
  };

  const implementationOutput = (headSha = IMPLEMENTATION_HEAD) => ({
    schemaVersion: 1,
    headSha,
    baseSha: IMPLEMENTATION_BASE,
    summary: "parallel review integration fixture implementation",
    testsRun: ["npm test -- parallel review"],
  });

  const reviewOutput = (
    kind: "review-findings" | "blind-findings",
    findings: CanonicalReviewArtifact["findings"] = [],
  ) => ({
    schemaVersion: 1,
    headSha: IMPLEMENTATION_HEAD,
    reviewedBase: IMPLEMENTATION_BASE,
    reviewedHead: IMPLEMENTATION_HEAD,
    findings,
    ...(kind === "review-findings" ? { commandsRun: ["git diff --check"] } : {}),
  });

  const completeImplementation = async (fixture: DirectFixture | FullFixture | OptionalDirectFixture, runnerId = "implementation-runner"): Promise<Claim> => {
    const claimed = await claim(runnerId);
    assert.equal(claimed.run.taskId, fixture.implementationTaskId);
    assert.equal(claimed.run.implementationBaseSha, null);
    const result = await complete(claimed, runnerId, {
      outputKind: "implementation",
      output: implementationOutput(),
      baseSha: IMPLEMENTATION_BASE,
      branch: fixture.branchName,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return claimed;
  };

  const reviewClaims = async (fixture: DirectFixture | FullFixture, firstRunner = "sol-runner", secondRunner = "blind-runner") => {
    const first = await claim(firstRunner);
    const second = await claim(secondRunner);
    const reviewTasks = new Set([fixture.solTaskId, fixture.blindTaskId]);
    assert.ok(reviewTasks.has(first.run.taskId));
    assert.ok(reviewTasks.has(second.run.taskId));
    assert.notEqual(first.run.taskId, second.run.taskId);
    assert.equal((await getDb().run.findUniqueOrThrow({ where: { id: first.run.id } })).runnerId, firstRunner);
    assert.equal((await getDb().run.findUniqueOrThrow({ where: { id: second.run.id } })).runnerId, secondRunner);
    for (const claimed of [first, second]) {
      assert.equal(claimed.run.implementationBaseSha, IMPLEMENTATION_BASE);
      assert.equal(claimed.run.implementationHeadSha, IMPLEMENTATION_HEAD);
      assert.equal(claimed.run.pinnedBaseSha, IMPLEMENTATION_HEAD);
      assert.equal(claimed.run.targetBranch, IMPLEMENTATION_HEAD);
    }
    assert.ok(specificationReads.length >= 2);
    assert.ok(specificationReads.every(({ commitSha, path }) => commitSha === IMPLEMENTATION_HEAD && path === `.chain/${fixture.branchName}/spec.md`));
    return { first, second };
  };

  const completeReview = async (
    claimed: Claim,
    runnerId: string,
    kind: "review-findings" | "blind-findings",
    findings: CanonicalReviewArtifact["findings"] = [],
  ) => {
    const result = await complete(claimed, runnerId, {
      outputKind: kind,
      output: reviewOutput(kind, findings),
      headSha: IMPLEMENTATION_HEAD,
      baseSha: IMPLEMENTATION_BASE,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };

  const queuedRunsFor = (taskIds: string[]) =>
    getDb().run.findMany({
      where: { taskId: { in: taskIds }, status: RunStatus.QUEUED },
      select: { id: true, taskId: true, runNumber: true, promptHash: true },
    });

  return {
    request,
    runnerRequest,
    operatorRequest,
    instantiateDirect,
    instantiateBoundDirect,
    instantiateOptionalDirect,
    instantiateFullAtReviewFrontier,
    claim,
    complete,
    completeImplementation,
    reviewClaims,
    completeReview,
    queuedRunsFor,
  };
};

export const installParallelReviewLifecycle = () => {
  const db = setupTestDb();
  let materializedSpecification = SPECIFICATION_BRIEF;
  const specificationReads: SpecificationRead[] = [];
  const previousEnvironment = {
    runner: process.env.RUNNER_TOKEN,
    operator: process.env.OPERATOR_TOKEN,
  };

  before(() => {
    process.env.RUNNER_TOKEN = RUNNER_TOKEN;
    process.env.OPERATOR_TOKEN = OPERATOR_TOKEN;
  });

  beforeEach(async () => {
    materializedSpecification = SPECIFICATION_BRIEF;
    specificationReads.length = 0;
    await resetTestDb(db);
    await runDbScript("seed.ts");
  });

  after(async () => {
    await db.$disconnect();
    if (previousEnvironment.runner === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = previousEnvironment.runner;
    if (previousEnvironment.operator === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousEnvironment.operator;
  });

  return {
    db,
    specificationReads,
    setMaterializedSpecification: (value: string) => {
      materializedSpecification = value;
    },
    ...createParallelReviewHarness({
      getDb: () => db,
      getMaterializedSpecification: () => materializedSpecification,
      specificationReads,
    }),
  };
};
