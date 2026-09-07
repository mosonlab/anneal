import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
  PrismaClient,
  RepoPermission,
  RunnerKind,
  TaskStatus,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { runDbScript } from "./test-db-script.js";
import { resetTestDb, setupTestDb } from "./testdb.js";
import { hashToken } from "./auth.js";
import { instantiateTemplate } from "./templates.js";
import { persistSessionTaskOutput } from "./canonical-task-output.js";

type Tier = "default" | "frontend" | "hard" | "hazard";

type Scenario = {
  projectId: string;
  repoId: string;
  profileId: string;
  tierAgents: Partial<Record<Tier, string>>;
  implementationTaskId: string;
  revalidationTaskId: string;
  implementationStepIndex: number;
  previousAgentId: string;
  previousAgentName: string;
  tierAgentNames: Partial<Record<Tier, string>>;
  routeAgentId: string;
  routeAgentName: string;
  stepOverrideAgentId: string | null;
};

let db: PrismaClient;

before(() => { db = setupTestDb(); });
beforeEach(async () => {
  await resetTestDb(db);
  await runDbScript("seed.ts");
});
after(async () => { await db.$disconnect(); });

const tierDelegate = () => db.staffingProfileTier;

const unique = (label: string): string => `${label}-${randomUUID()}`;

const createLiveRun = async (taskId: string, projectId: string, agentId: string, repoId: string) => {
  const runId = unique("revalidation-run");
  const sessionToken = `agos_session_${runId}`;
  const fencingToken = `fence-${runId}`;
  const now = new Date();
  const run = await db.run.create({
    data: {
      id: runId,
      projectId,
      taskId,
      agentId,
      repoId,
      runNumber: 1,
      dedupeKey: `task:${taskId}:run:1:${randomUUID()}`,
      status: "RUNNING",
      runner: RunnerKind.CODEX,
      runnerId: unique("routing-runner"),
      leaseGeneration: 1,
      fencingToken,
      leaseExpiresAt: new Date(now.getTime() + 600_000),
      sessionTokenHash: hashToken(sessionToken),
      sessionTokenExpiresAt: new Date(now.getTime() + 600_000),
      claimedAt: now,
      heartbeatAt: now,
      startedAt: now,
      model: "gpt-5.6-luna:max",
      promptHash: "revalidation-routing-test",
    },
  });
  return { run, sessionToken, fencingToken };
};

const submitRevalidation = async (
  run: Awaited<ReturnType<typeof createLiveRun>>,
  tier: Tier,
  reason = `the ${tier} criterion applies`,
) => {
  const headSha = "a".repeat(40);
  const body = {
    schemaVersion: 2,
    headSha,
    outcome: "unchanged",
    summary: "The current implementation brief remains valid.",
    changedReferences: [],
    route: { tier, reason },
  };
  const response = await createApp(db).request(`/session/runs/${run.run.id}/output`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${run.sessionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fencingToken: run.fencingToken,
      kind: "revalidation",
      body: JSON.stringify(body),
      commitSha: headSha,
    }),
  });
  const responseBody = await response.json().catch(() => null) as unknown;
  assert.equal(response.status, 200, JSON.stringify(responseBody));
  return { body, responseBody };
};

const routeActivity = async (scenario: Scenario) => {
  const activity = await db.taskActivity.findFirst({
    where: {
      taskId: scenario.implementationTaskId,
      body: { startsWith: "Implementation tier" },
    },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(activity, "routing must leave an implementation TaskActivity");
  return {
    body: activity.body,
    metadata: activity.metadata as Record<string, unknown>,
  };
};

const seedScenario = async (options: {
  tierAgents?: Partial<Record<Tier, string>>;
  routeLine?: boolean;
  stepOverrideAgent?: boolean;
  missingGrantTier?: Tier;
  emptyTiers?: readonly Tier[];
} = {}): Promise<Scenario> => {
  const project = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const environment = await db.environment.findFirstOrThrow({ where: { projectId: project.id } });
  const template = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: DIRECT_TEMPLATE_NAME } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const implementationStep = template.steps.find(({ outputKind }) => outputKind === "implementation");
  assert.ok(implementationStep, "canonical Direct template must contain implementation");
  const revalidationStep = template.steps.find(({ outputKind }) => outputKind === "revalidation");
  assert.ok(revalidationStep, "canonical Direct template must contain revalidation");
  assert.ok(implementationStep.assigneeAgentId, "canonical implementation must have an Agent");
  assert.ok(revalidationStep.assigneeAgentId, "canonical revalidation must have an Agent");

  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: unique("revalidation-routing-repo"),
      remoteUrl: "https://example.test/revalidation-routing.git",
      mountPath: "/repo",
      defaultBranch: "main",
      dependencyProvisioning: DependencyProvisioning.NONE,
    },
  });

  const existingAgents = await db.agent.findMany({
    where: { projectId: project.id },
    select: { id: true },
  });
  const tierAgents: Partial<Record<Tier, string>> = { ...(options.tierAgents ?? {}) };
  const tierAgentNames: Partial<Record<Tier, string>> = {};
  const allTierAgents: Array<{ tier: Tier; id: string }> = [];
  for (const tier of ["default", "frontend", "hard", "hazard"] as const) {
    if (options.emptyTiers?.includes(tier)) continue;
    if (tierAgents[tier] !== undefined) continue;
    const agent = await db.agent.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        name: unique(`tier-${tier}`),
        title: `Revalidation ${tier} Agent`,
        model: tier === "frontend" ? "claude-opus-5:medium" : "gpt-6-astra:low",
        foundationalPrompt: "foundation",
        rolePrompt: "role",
      },
    });
    tierAgents[tier] = agent.id;
    tierAgentNames[tier] = agent.name;
    allTierAgents.push({ tier, id: agent.id });
  }

  const routeAgent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: unique("route-agent"),
      title: "Route override Agent",
      model: "gpt-6-astra:medium",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const stepOverrideAgent = options.stepOverrideAgent
    ? await db.agent.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        name: unique("step-override-agent"),
        title: "Step override Agent",
        model: "gpt-6-astra:medium",
        foundationalPrompt: "foundation",
        rolePrompt: "role",
      },
    })
    : null;

  const grantIds = [
    ...existingAgents.map(({ id }) => id),
    ...allTierAgents
      .filter(({ tier }) => tier !== options.missingGrantTier)
      .map(({ id }) => id),
    routeAgent.id,
    ...(stepOverrideAgent ? [stepOverrideAgent.id] : []),
  ];
  await db.agentRepoAccess.createMany({
    data: [...new Set(grantIds)].map((agentId) => ({
      projectId: project.id,
      agentId,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: RepoPermission.GIT_WRITE,
    })),
  });

  const profile = await db.staffingProfile.create({
    data: {
      projectId: project.id,
      taskTemplateId: template.id,
      name: unique("revalidation-routing-profile"),
      isDefault: false,
      entries: { create: [] },
    },
  });
  const tierRows = allTierAgents.map(({ tier, id }) => ({
    profileId: profile.id,
    tier,
    agentId: id,
  }));
  if (tierRows.length > 0) await tierDelegate().createMany({ data: tierRows });

  const predecessor = await db.task.create({
    data: {
      projectId: project.id,
      repoId: repo.id,
      assigneeAgentId: revalidationStep.assigneeAgentId,
      name: "Revalidation routing predecessor",
      description: "The bound predecessor remains in progress until the chain is instantiated.",
      chainId: unique("revalidation-predecessor-chain"),
      chainIndex: 1,
      chainLayer: 1,
      status: TaskStatus.DOING,
    },
  });
  const brief = options.routeLine
    ? `Exercise judged implementation tier routing.
Route: implementation=${routeAgent.name} - operator override`
    : "Exercise judged implementation tier routing.";
  const stepOverrides = stepOverrideAgent === null
    ? undefined
    : { [String(implementationStep.stepIndex)]: { assigneeAgentId: stepOverrideAgent.id } };
  const chain = await instantiateTemplate(db, project.id, template.id, {
    repoId: repo.id,
    variables: { branchName: `routing/${randomUUID()}` },
    name: "revalidation routing chain",
    description: brief,
    afterTaskId: predecessor.id,
    staffingProfileId: profile.id,
    ...(stepOverrides === undefined ? {} : { stepOverrides }),
  });
  const tasks = await db.task.findMany({
    where: { chainId: chain.chainId },
    include: { templateStep: true, assigneeAgent: true },
  });
  const implementation = tasks.find(({ templateStep: step }) => step?.outputKind === "implementation");
  const revalidation = tasks.find(({ templateStep: step }) => step?.outputKind === "revalidation");
  assert.ok(implementation, "bound Direct Chain must contain implementation");
  assert.ok(revalidation, "bound Direct Chain must contain revalidation");
  assert.ok(implementation.assigneeAgent, "implementation must have an initial Agent");
  return {
    projectId: project.id,
    repoId: repo.id,
    profileId: profile.id,
    tierAgents,
    implementationTaskId: implementation.id,
    revalidationTaskId: revalidation.id,
    implementationStepIndex: implementationStep.stepIndex,
    previousAgentId: implementation.assigneeAgent.id,
    previousAgentName: implementation.assigneeAgent.name,
    tierAgentNames,
    routeAgentId: routeAgent.id,
    routeAgentName: routeAgent.name,
    stepOverrideAgentId: stepOverrideAgent?.id ?? null,
  };
};

const implementation = async (scenario: Scenario) => db.task.findUniqueOrThrow({
  where: { id: scenario.implementationTaskId },
  select: { assigneeAgentId: true, assigneeAgent: { select: { id: true, name: true } } },
});

test("judged hard and frontend tiers restaff a bound implementation and audit the reason", async (t) => {
  for (const tier of ["hard", "frontend"] as const) {
    await t.test(tier, async () => {
      const scenario = await seedScenario();
      const run = await createLiveRun(
        scenario.revalidationTaskId,
        scenario.projectId,
        (await db.task.findUniqueOrThrow({ where: { id: scenario.revalidationTaskId }, select: { assigneeAgentId: true } })).assigneeAgentId!,
        scenario.repoId,
      );
      const reason = `${tier} criterion is explicit in the brief and tree`;
      await submitRevalidation(run, tier, reason);
      const changed = await implementation(scenario);
      assert.equal(changed.assigneeAgentId, scenario.tierAgents[tier]);
      const activity = await routeActivity(scenario);
      assert.equal(activity.metadata.tier, tier);
      assert.equal(activity.metadata.reason, reason);
      assert.equal(activity.metadata.previousAgentId, scenario.previousAgentId);
      assert.equal(activity.metadata.newAgentId, scenario.tierAgents[tier]);
      assert.equal(activity.metadata.decision, "applied");
      assert.match(activity.body, new RegExp(`${tier}.*${reason}.*Previous Agent:.*${scenario.previousAgentName}.*new Agent:`, "u"));
      assert.equal(await db.taskStepOutput.count({ where: { taskId: scenario.revalidationTaskId } }), 1);
    });
  }
});

test("a brief Route line overrides the judged tier and records the override", async () => {
  const scenario = await seedScenario({ routeLine: true });
  const run = await createLiveRun(
    scenario.revalidationTaskId,
    scenario.projectId,
    (await db.task.findUniqueOrThrow({ where: { id: scenario.revalidationTaskId }, select: { assigneeAgentId: true } })).assigneeAgentId!,
    scenario.repoId,
  );
  await submitRevalidation(run, "hard", "hard criterion applies");
  const changed = await implementation(scenario);
  assert.equal(changed.assigneeAgentId, scenario.routeAgentId);
  const activity = await routeActivity(scenario);
  assert.equal(activity.metadata.decision, "overridden");
  assert.match(activity.body, /judged tier overridden by brief Route line/u);
});

test("an explicit implementation stepOverride has the same precedence as a Route line", async () => {
  const scenario = await seedScenario({ stepOverrideAgent: true });
  const run = await createLiveRun(
    scenario.revalidationTaskId,
    scenario.projectId,
    (await db.task.findUniqueOrThrow({ where: { id: scenario.revalidationTaskId }, select: { assigneeAgentId: true } })).assigneeAgentId!,
    scenario.repoId,
  );
  await submitRevalidation(run, "frontend", "new interaction requires frontend tier");
  const changed = await implementation(scenario);
  assert.equal(changed.assigneeAgentId, scenario.stepOverrideAgentId);
  const activity = await routeActivity(scenario);
  assert.equal(activity.metadata.decision, "overridden");
  assert.match(activity.body, /judged tier overridden by explicit stepOverrides assignee/u);
});

test("an empty tier slot keeps the current Agent and records unstaffed", async () => {
  const scenario = await seedScenario({ emptyTiers: ["hard"] });
  const run = await createLiveRun(
    scenario.revalidationTaskId,
    scenario.projectId,
    (await db.task.findUniqueOrThrow({ where: { id: scenario.revalidationTaskId }, select: { assigneeAgentId: true } })).assigneeAgentId!,
    scenario.repoId,
  );
  await submitRevalidation(run, "hard", "no hard slot was configured");
  assert.equal((await implementation(scenario)).assigneeAgentId, scenario.previousAgentId);
  const activity = await routeActivity(scenario);
  assert.equal(activity.metadata.decision, "unstaffed");
  assert.match(activity.body, /tier was unstaffed/u);
});

test("an implementation that already has a Run is not restaffed", async () => {
  const scenario = await seedScenario();
  const revalidation = await db.task.findUniqueOrThrow({ where: { id: scenario.revalidationTaskId }, select: { assigneeAgentId: true } });
  const run = await createLiveRun(scenario.revalidationTaskId, scenario.projectId, revalidation.assigneeAgentId!, scenario.repoId);
  const implementationTask = await db.task.findUniqueOrThrow({ where: { id: scenario.implementationTaskId }, select: { assigneeAgentId: true } });
  await createLiveRun(scenario.implementationTaskId, scenario.projectId, implementationTask.assigneeAgentId!, scenario.repoId);
  await submitRevalidation(run, "hard", "hard criterion applies");
  assert.equal((await implementation(scenario)).assigneeAgentId, scenario.previousAgentId);
  const activity = await routeActivity(scenario);
  assert.equal(activity.metadata.decision, "already-running");
  assert.match(activity.body, /implementation already has a Run/u);
});

test("an ungranted tier Agent is refused and recorded", async () => {
  const scenario = await seedScenario({ missingGrantTier: "hard" });
  const run = await createLiveRun(
    scenario.revalidationTaskId,
    scenario.projectId,
    (await db.task.findUniqueOrThrow({ where: { id: scenario.revalidationTaskId }, select: { assigneeAgentId: true } })).assigneeAgentId!,
    scenario.repoId,
  );
  await submitRevalidation(run, "hard", "hard criterion applies");
  assert.equal((await implementation(scenario)).assigneeAgentId, scenario.previousAgentId);
  const activity = await routeActivity(scenario);
  assert.equal(activity.metadata.decision, "refused");
  assert.match(activity.body, /GIT_WRITE Repo grant required/u);
});

test("hazard records application even when it resolves to the current Agent", async () => {
  const scenario = await seedScenario({ emptyTiers: ["hazard"] });
  const current = await db.task.findUniqueOrThrow({
    where: { id: scenario.implementationTaskId },
    select: { assigneeAgentId: true, assigneeAgent: { select: { id: true, name: true } } },
  });
  assert.ok(current.assigneeAgentId && current.assigneeAgent);
  await tierDelegate().createMany({ data: [{ profileId: scenario.profileId, tier: "hazard", agentId: current.assigneeAgentId }] });
  const run = await createLiveRun(
    scenario.revalidationTaskId,
    scenario.projectId,
    (await db.task.findUniqueOrThrow({ where: { id: scenario.revalidationTaskId }, select: { assigneeAgentId: true } })).assigneeAgentId!,
    scenario.repoId,
  );
  await submitRevalidation(run, "hazard", "transaction boundaries are the hazard criterion");
  assert.equal((await implementation(scenario)).assigneeAgentId, current.assigneeAgentId);
  const activity = await routeActivity(scenario);
  assert.equal(activity.metadata.decision, "applied");
  assert.equal(activity.metadata.previousAgentId, current.assigneeAgentId);
  assert.equal(activity.metadata.newAgentId, current.assigneeAgentId);
});

test("routing and output persistence roll back together", async () => {
  const scenario = await seedScenario();
  const revalidation = await db.task.findUniqueOrThrow({
    where: { id: scenario.revalidationTaskId },
    select: { assigneeAgentId: true },
  });
  const run = await createLiveRun(scenario.revalidationTaskId, scenario.projectId, revalidation.assigneeAgentId!, scenario.repoId);
  const headSha = "b".repeat(40);
  const body = JSON.stringify({
    schemaVersion: 2,
    headSha,
    outcome: "unchanged",
    summary: "The current implementation brief remains valid.",
    changedReferences: [],
    route: { tier: "hard", reason: "rollback probe" },
  });
  await assert.rejects(
    db.$transaction(async (tx) => {
      const result = await persistSessionTaskOutput(tx, {
        task: { id: scenario.revalidationTaskId },
        fence: { runId: run.run.id, fencingToken: run.fencingToken, at: new Date() },
        kind: "revalidation",
        body,
        commitSha: headSha,
      });
      assert.equal("ok" in result && result.ok, true, JSON.stringify(result));
      throw new Error("rollback routing probe");
    }),
    /rollback routing probe/u,
  );
  assert.equal((await implementation(scenario)).assigneeAgentId, scenario.previousAgentId);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: scenario.revalidationTaskId } }), 0);
  assert.equal(await db.taskActivity.count({ where: { taskId: scenario.implementationTaskId, body: { startsWith: "Implementation tier" } } }), 0);
});


test("a GIT_READ-only Agent is refused by both Route instantiation and judged tier staffing", async () => {
  const scenario = await seedScenario();
  const agentId = scenario.tierAgents.hard!;
  await db.agentRepoAccess.updateMany({
    where: { agentId, repoId: scenario.repoId },
    data: { permissions: RepoPermission.GIT_READ },
  });
  const source = await db.task.findUniqueOrThrow({ where: { id: scenario.revalidationTaskId } });
  await assert.rejects(
    instantiateTemplate(db, scenario.projectId, source.templateId!, {
      repoId: scenario.repoId,
      variables: { branchName: `read-only/${randomUUID()}` },
      name: "read-only route",
      description: `Route: implementation=${scenario.tierAgentNames.hard}`,
      staffingProfileId: scenario.profileId,
      autoStart: false,
    }),
    (error: unknown) => error instanceof Error
      && "code" in error && error.code === "step_override_missing_repo_grant",
  );
  const run = await createLiveRun(source.id, scenario.projectId, source.assigneeAgentId!, scenario.repoId);
  await submitRevalidation(run, "hard");
  assert.equal((await implementation(scenario)).assigneeAgentId, scenario.previousAgentId);
  assert.equal((await routeActivity(scenario)).metadata.decision, "refused");
});
