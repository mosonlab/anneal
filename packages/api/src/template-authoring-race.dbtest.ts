import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  DependencyProvisioning,
  Prisma,
  PrismaClient,
  RunnerKind,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "template-authoring-race-operator";
const testDatabaseUrl = process.env.TEST_DATABASE_URL!;
let db: PrismaClient;
let priorOperatorToken: string | undefined;

before(() => {
  priorOperatorToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
});

const unique = (label: string): string => `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`;

type Seed = Awaited<ReturnType<typeof seed>>;

const seed = async (label: string) => {
  const project = await db.project.create({ data: { name: label, slug: unique(label) } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const implementationAgent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: "old-implementation-agent",
      title: "old-implementation-agent",
      model: "gpt-5.6-sol:medium",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const reviewAgent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: "old-review-agent",
      title: "old-review-agent",
      model: "gpt-5.6-sol:medium",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: "race-repo",
      remoteUrl: "https://example.test/race.git",
      mountPath: "/repo",
      dependencyProvisioning: DependencyProvisioning.NONE,
    },
  });
  for (const agent of [implementationAgent, reviewAgent]) {
    await db.agentRepoAccess.create({
      data: {
        projectId: project.id,
        agentId: agent.id,
        repoId: repo.id,
        mountPath: "/repo",
        permissions: "GIT_WRITE",
      },
    });
  }
  const template = await db.taskTemplate.create({
    data: {
      projectId: project.id,
      name: "race-template",
      description: "Template used by the lock race tests",
      variables: ["branchName"],
      steps: {
        create: [
          {
            stepIndex: 1,
            layer: 1,
            name: "Old implementation",
            assigneeType: AssigneeType.AGENT,
            assigneeAgentId: implementationAgent.id,
            prompt: "Implement the old graph",
            approvalGate: false,
            attachmentsFromPrevious: false,
            priorOutputKinds: [],
            spawnPolicy: Prisma.JsonNull,
            runner: RunnerKind.CODEX,
            outputKind: "old-implementation",
            opensPullRequest: true,
            requiresCommit: true,
            baseFromStepIndex: null,
          },
          {
            stepIndex: 2,
            layer: 2,
            name: "Old review",
            assigneeType: AssigneeType.AGENT,
            assigneeAgentId: reviewAgent.id,
            prompt: "Review the old graph",
            approvalGate: false,
            attachmentsFromPrevious: true,
            priorOutputKinds: ["old-implementation"],
            spawnPolicy: Prisma.JsonNull,
            runner: RunnerKind.CODEX,
            outputKind: "old-review",
            opensPullRequest: false,
            requiresCommit: false,
            baseFromStepIndex: 1,
          },
        ],
      },
    },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  return { project, environment, repo, template, implementationAgent, reviewAgent };
};

const replacementSteps = (seeded: Seed) => [
  {
    name: "New implementation",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: seeded.implementationAgent.id,
    prompt: "Implement the new graph",
    approvalGate: false,
    optional: false,
    attachmentsFromPrevious: false,
    priorOutputKinds: [],
    spawnPolicy: { mode: "serial" },
    runner: RunnerKind.CLAUDE,
    outputKind: "new-implementation",
    opensPullRequest: true,
    requiresCommit: true,
    baseFromStepIndex: null,
    layer: 1,
  },
  {
    name: "New review",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: seeded.reviewAgent.id,
    prompt: "Review the new graph",
    approvalGate: false,
    optional: false,
    attachmentsFromPrevious: true,
    priorOutputKinds: ["new-implementation"],
    spawnPolicy: null,
    runner: null,
    outputKind: "new-review",
    opensPullRequest: false,
    requiresCommit: false,
    baseFromStepIndex: 1,
    layer: 2,
  },
];

type JsonResponse = { status: number; body: any };

const replaceRequest = async (seeded: Seed, steps: unknown): Promise<JsonResponse> => {
  const response = await createApp(db).request(
    `/projects/${seeded.project.id}/task-templates/${seeded.template.id}/steps`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      body: JSON.stringify({ steps }),
    },
  );
  return { status: response.status, body: await response.json() as any };
};

const instantiateRequest = async (seeded: Seed): Promise<JsonResponse> => {
  const response = await createApp(db).request(
    `/projects/${seeded.project.id}/task-templates/${seeded.template.id}/instantiate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: seeded.repo.id,
        variables: { branchName: "race/branch" },
        name: "template authoring race",
        autoStart: false,
      }),
    },
  );
  return { status: response.status, body: await response.json() as any };
};

/** Wait until a request is visibly blocked on one of the row-lock statements. */
const waitForBlockedQuery = async (fragment: string): Promise<void> => {
  const observer = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  try {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const rows = await observer.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE ${`%${fragment}%`}
      `;
      if ((rows[0]?.count ?? 0n) > 0n) return;
      await delay(20);
    }
  } finally {
    await observer.$disconnect();
  }
  assert.fail(`no blocked query containing ${fragment}`);
};

type LockFn = (tx: Prisma.TransactionClient) => Promise<void>;

/** Hold a row lock until the test has started the competing request(s). */
const withHeldLock = async <T>(lock: LockFn, operation: (release: () => void) => Promise<T>): Promise<T> => {
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let acquiredResolve!: () => void;
  let releaseResolve!: () => void;
  const acquired = new Promise<void>((resolve) => { acquiredResolve = resolve; });
  const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const held = holder.$transaction(async (tx) => {
    await lock(tx);
    acquiredResolve();
    await released;
  }, { timeout: 30_000 });
  await acquired;
  let releasedAlready = false;
  const release = () => {
    if (releasedAlready) return;
    releasedAlready = true;
    releaseResolve();
  };
  try {
    return await operation(release);
  } finally {
    release();
    await held;
    await holder.$disconnect();
  }
};

test("replace wins a held old-step lock and instantiate reads the committed new graph", { timeout: 30_000 }, async () => {
  const seeded = await seed("replace-first");
  const oldStepId = seeded.template.steps[0]!.id;
  const replacement = replacementSteps(seeded);

  await withHeldLock(
    (tx) => tx.$queryRaw`SELECT "id" FROM "TaskTemplateStep" WHERE "id" = ${oldStepId} FOR UPDATE`.then(() => undefined),
    async (release) => {
      const replacing = replaceRequest(seeded, replacement);
      await waitForBlockedQuery("TaskTemplateStep");
      const instantiating = instantiateRequest(seeded);
      release();
      const [replaced, instantiated] = await Promise.all([replacing, instantiating]);

      assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
      assert.equal(instantiated.status, 201, JSON.stringify(instantiated.body));
      const liveSteps = await db.taskTemplateStep.findMany({
        where: { taskTemplateId: seeded.template.id },
        orderBy: { stepIndex: "asc" },
      });
      const tasks = await db.task.findMany({
        where: { chainId: instantiated.body.chainId },
        include: { templateStep: true },
        orderBy: { chainIndex: "asc" },
      });
      assert.equal(tasks.length, replacement.length);
      assert.deepEqual(tasks.map((task) => task.name), [
        "template authoring race: New implementation",
        "template authoring race: New review",
      ]);
      assert.deepEqual(tasks.map((task) => task.chainLayer), [1, 2]);
      assert.deepEqual(tasks.map((task) => task.templateStepId), liveSteps.map((step) => step.id));
      assert.deepEqual(tasks.map((task) => task.templateStep?.name), liveSteps.map((step) => step.name));
      assert.deepEqual(tasks.map((task) => task.templateStep?.outputKind), ["new-implementation", "new-review"]);
      assert.equal(new Set(tasks.map((task) => task.templateId)).size, 1);
    },
  );
});

test("instantiate wins a held assignee lock and replace then refuses the used template", { timeout: 30_000 }, async () => {
  const seeded = await seed("instantiate-first");
  const replacement = replacementSteps(seeded);

  await withHeldLock(
    (tx) => tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${seeded.implementationAgent.id} FOR UPDATE`.then(() => undefined),
    async (release) => {
      const instantiating = instantiateRequest(seeded);
      await waitForBlockedQuery("FROM \"Agent\"");
      const replacing = replaceRequest(seeded, replacement);
      release();
      const [instantiated, replaced] = await Promise.all([instantiating, replacing]);

      assert.equal(instantiated.status, 201, JSON.stringify(instantiated.body));
      assert.equal(replaced.status, 409, JSON.stringify(replaced.body));
      assert.equal(replaced.body.code, "template_in_use", JSON.stringify(replaced.body));
      assert.match(replaced.body.error, /clone it again/iu);
      const persistedSteps = await db.taskTemplateStep.findMany({
        where: { taskTemplateId: seeded.template.id },
        orderBy: { stepIndex: "asc" },
      });
      assert.deepEqual(persistedSteps.map((step) => step.name), ["Old implementation", "Old review"]);
      const tasks = await db.task.findMany({
        where: { chainId: instantiated.body.chainId },
        include: { templateStep: true },
        orderBy: { chainIndex: "asc" },
      });
      assert.deepEqual(tasks.map((task) => task.templateStep?.name), ["Old implementation", "Old review"]);
      assert.deepEqual(tasks.map((task) => task.templateStepId), persistedSteps.map((step) => step.id));
    },
  );
});

test("instantiate validates variables from the template graph read after the row lock", { timeout: 30_000 }, async () => {
  const seeded = await seed("post-lock-graph");
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let acquiredResolve!: () => void;
  let mutateResolve!: () => void;
  let mutatedResolve!: () => void;
  let releaseResolve!: () => void;
  const acquired = new Promise<void>((resolve) => { acquiredResolve = resolve; });
  const mutate = new Promise<void>((resolve) => { mutateResolve = resolve; });
  const mutated = new Promise<void>((resolve) => { mutatedResolve = resolve; });
  const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const held = holder.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "TaskTemplate" WHERE "id" = ${seeded.template.id} FOR UPDATE`;
    acquiredResolve();
    await mutate;
    await tx.taskTemplate.update({
      where: { id: seeded.template.id },
      data: { variables: ["branchName", "requiredAfterLock"] },
    });
    mutatedResolve();
    await released;
  }, { timeout: 30_000 });

  try {
    await acquired;
    const instantiating = instantiateRequest(seeded);
    await waitForBlockedQuery("TaskTemplate");
    mutateResolve();
    await mutated;
    releaseResolve();
    const instantiated = await instantiating;
    assert.equal(instantiated.status, 400, JSON.stringify(instantiated.body));
    assert.equal(instantiated.body.code, "template_variables_missing", JSON.stringify(instantiated.body));
    assert.match(instantiated.body.error, /requiredAfterLock/iu);
    assert.equal(await db.task.count(), 0);
    assert.equal(await db.taskActivity.count(), 0);
  } finally {
    releaseResolve();
    await held;
    await holder.$disconnect();
  }
});
