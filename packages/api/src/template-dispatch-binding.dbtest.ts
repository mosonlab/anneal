import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { DependencyProvisioning, PrismaClient, TaskStatus } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "template-dispatch-binding-operator";
const STEP_COUNT = 13;
const testDatabaseUrl = process.env.TEST_DATABASE_URL!;

let db: PrismaClient;

type Fixture = Awaited<ReturnType<typeof fixture>>;

const fixture = async (label: string) => {
  const project = await db.project.create({
    data: { name: label, slug: `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: "chain-agent",
      title: "Chain agent",
      model: "claude",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: "repo",
      remoteUrl: "https://example.test/repo.git",
      mountPath: "/repo",
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
  const template = await db.taskTemplate.create({
    data: {
      projectId: project.id,
      name: "dispatch-template",
      description: "dispatch fixture",
      variables: [],
      steps: {
        create: Array.from({ length: STEP_COUNT }, (_, offset) => {
          const stepIndex = offset + 1;
          return {
            stepIndex,
            layer: stepIndex,
            name: `Step ${stepIndex}`,
            assigneeType: "AGENT" as const,
            assigneeAgentId: agent.id,
            prompt: `step ${stepIndex} {{chainId}}`,
            outputKind: "result",
            approvalGate: false,
            opensPullRequest: false,
          };
        }),
      },
    },
  });
  return { project, repo, agent, template };
};

const configureDirectTemplate = async (seed: Fixture) => {
  await db.taskTemplate.update({
    where: { id: seed.template.id },
    data: { name: "direct-engineer-workflow" },
  });
  const implementation = await db.taskTemplateStep.findFirstOrThrow({
    where: { taskTemplateId: seed.template.id, stepIndex: 1 },
  });
  await db.taskTemplateStep.update({
    where: { id: implementation.id },
    data: { outputKind: "implementation", opensPullRequest: true },
  });
  return implementation;
};

const createRouteAgent = async (
  seed: Fixture,
  name: string,
  options: { archived?: boolean; grant?: boolean } = {},
) => {
  const agent = await db.agent.create({
    data: {
      projectId: seed.project.id,
      environmentId: (await db.agent.findUniqueOrThrow({ where: { id: seed.agent.id } })).environmentId,
      name,
      title: name,
      model: "codex",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
      archivedAt: options.archived ? new Date() : null,
    },
  });
  if (options.grant !== false) {
    await db.agentRepoAccess.create({
      data: {
        projectId: seed.project.id,
        agentId: agent.id,
        repoId: seed.repo.id,
        mountPath: "/repo",
        permissions: "GIT_WRITE",
      },
    });
  }
  return agent;
};

const renameUnderHeldLock = async <T>(agentId: string, name: string, operation: () => Promise<T>): Promise<T> => {
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => { acquired = resolve; });
  try {
    const renaming = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${agentId} FOR UPDATE`;
      await tx.agent.update({ where: { id: agentId }, data: { name } });
      acquired();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }, { timeout: 10_000 });
    await held;
    const pending = operation();
    await renaming;
    return await pending;
  } finally {
    await holder.$disconnect();
  }
};

const request = async (
  projectId: string,
  templateId: string,
  body: unknown,
): Promise<{ status: number; body: any }> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(
      `/projects/${projectId}/task-templates/${templateId}/instantiate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = prior;
  }
};

const instantiate = async (seed: Fixture, autoStart = false) => {
  const result = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    name: "dispatch chain",
    autoStart,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return db.task.findMany({ where: { chainId: result.body.chainId }, orderBy: { chainIndex: "asc" } });
};

const operatorRequest = async (path: string, method: "POST" | "DELETE"): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}` },
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
};

const patchTaskStatus = async (taskId: string, status: TaskStatus): Promise<Response> => createApp(db).request(
  `/tasks/${taskId}`,
  {
    method: "PATCH",
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  },
);

const rowCounts = async () => ({
  tasks: await db.task.count(),
  activities: await db.taskActivity.count(),
  runs: await db.run.count(),
  fires: await db.triggerFire.count(),
});

const assertNoPartialRows = async (beforeCounts: Awaited<ReturnType<typeof rowCounts>>) => {
  assert.deepEqual(await rowCounts(), beforeCounts);
};

before(() => {
  process.env.OPERATOR_TOKEN = OPERATOR;
  db = setupTestDb();
});

beforeEach(async () => { await resetTestDb(db); });

after(async () => {
  await db.$disconnect();
  delete process.env.OPERATOR_TOKEN;
});

test("afterTaskId binds only the first of the chain's tasks and writes both audit rows", async () => {
  const seed = await fixture("valid-binding");
  const predecessorTasks = await instantiate(seed);
  const predecessor = predecessorTasks.at(-1)!;
  const before = await db.task.findMany({ where: { chainId: predecessor.chainId }, orderBy: { chainIndex: "asc" } });

  const response = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    name: "bound successor",
    afterTaskId: predecessor.id,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.tasks.length, STEP_COUNT);
  const successorTasks = await db.task.findMany({ where: { chainId: response.body.chainId }, orderBy: { chainIndex: "asc" } });
  assert.equal(successorTasks.length, STEP_COUNT);
  assert.equal(successorTasks[0]!.dispatchAfterTaskId, predecessor.id);
  assert.ok(successorTasks.slice(1).every((task) => task.dispatchAfterTaskId === null));
  assert.ok(successorTasks.every((task) => task.status === "TODO"));
  assert.equal(await db.run.count({ where: { task: { chainId: response.body.chainId } } }), 0);
  assert.deepEqual(
    await db.task.findMany({ where: { chainId: predecessor.chainId }, orderBy: { chainIndex: "asc" } }),
    before,
    "binding does not mutate predecessor tasks",
  );

  const firstActivity = await db.taskActivity.findFirstOrThrow({
    where: { taskId: successorTasks[0]!.id },
    orderBy: { id: "asc" },
  });
  assert.equal(firstActivity.body, `Template instantiated; waiting for predecessor ${predecessor.name}`);
  assert.deepEqual(firstActivity.metadata, {
    chainId: response.body.chainId,
    templateId: seed.template.id,
    afterTaskId: predecessor.id,
    dispatchAfterTaskId: predecessor.id,
    predecessorTaskId: predecessor.id,
    predecessorChainId: predecessor.chainId,
  });
  const predecessorActivity = await db.taskActivity.findFirstOrThrow({
    where: { taskId: predecessor.id, body: { contains: "bound to predecessor" } },
  });
  assert.equal((predecessorActivity.metadata as { chainId: string }).chainId, response.body.chainId);
  assert.equal((predecessorActivity.metadata as { successorChainId: string }).successorChainId, response.body.chainId);
});

test("a direct brief routes any valid same-project Agent name and preserves every Route refusal atomically", async () => {
  const seed = await fixture("implementation-route");
  const senior = await createRouteAgent(seed, "project_specific.implementer");
  const archived = await createRouteAgent(seed, "archived-route-agent", { archived: true });
  const ungranted = await createRouteAgent(seed, "ungranted-route-agent", { grant: false });
  await createRouteAgent(seed, "merge-integrator");
  const implementation = await configureDirectTemplate(seed);

  const routed = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    name: "routed implementation",
    description: "Implement the brief.\n\nRoute: implementation=project_specific.implementer - explicit fixture route.",
  });
  assert.equal(routed.status, 201, JSON.stringify(routed.body));
  const routedImplementation = await db.task.findFirstOrThrow({
    where: { chainId: routed.body.chainId, templateStepId: implementation.id },
  });
  assert.equal(routedImplementation.assigneeAgentId, senior.id);

  const refusals = [
    { name: "missing-agent", code: "step_override_agent_not_found" },
    { name: archived.name, code: "step_override_agent_archived" },
    { name: ungranted.name, code: "step_override_missing_repo_grant" },
    { name: "merge-integrator", code: "step_override_integrator_binding" },
  ];
  for (const refusal of refusals) {
    const before = await rowCounts();
    const response = await request(seed.project.id, seed.template.id, {
      repoId: seed.repo.id,
      variables: {},
      name: `route ${refusal.name}`,
      description: `Implement the brief.\n\nRoute: implementation=${refusal.name}`,
    });
    assert.equal(response.status, 400, `${refusal.code}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, refusal.code, JSON.stringify(response.body));
    await assertNoPartialRows(before);
  }
});

test("a Route Agent renamed under a held lock keeps its original identity across serializable retry", { timeout: 30_000 }, async () => {
  const seed = await fixture("implementation-route-rename");
  const routed = await createRouteAgent(seed, "rename.route_agent");
  await configureDirectTemplate(seed);
  const before = await rowCounts();

  const response = await renameUnderHeldLock(routed.id, "renamed-route-agent", () => request(
    seed.project.id,
    seed.template.id,
    {
      repoId: seed.repo.id,
      variables: {},
      name: "renamed route",
      description: "Implement the brief.\n\nRoute: implementation=rename.route_agent",
    },
  ));

  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.code, "implementation_route_agent_renamed", JSON.stringify(response.body));
  await assertNoPartialRows(before);
});

test("status PATCH cannot move an unresolved bound first task away from TODO", async () => {
  const seed = await fixture("bound-status-patch");
  for (const status of [TaskStatus.DOING, TaskStatus.DONE]) {
    const predecessor = (await instantiate(seed)).at(-1)!;
    const binding = await request(seed.project.id, seed.template.id, {
      repoId: seed.repo.id,
      variables: {},
      name: `bound ${status}`,
      afterTaskId: predecessor.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const first = await db.task.findFirstOrThrow({
      where: { chainId: binding.body.chainId },
      orderBy: { chainIndex: "asc" },
    });

    const response = await patchTaskStatus(first.id, status);
    const responseBody = await response.json() as { error: string };
    assert.equal(response.status, 409, JSON.stringify(responseBody));
    assert.match(responseBody.error, new RegExp(predecessor.name, "u"));
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: first.id } })).status, TaskStatus.TODO);
    assert.equal(await db.run.count({ where: { task: { chainId: binding.body.chainId } } }), 0);
    assert.equal(
      await db.task.count({ where: { chainId: binding.body.chainId, status: { not: TaskStatus.TODO } } }),
      0,
    );
  }
});

test("afterTaskId plus autoStart is a schema refusal before any database write", async () => {
  const seed = await fixture("auto-start-conflict");
  const predecessorTasks = await instantiate(seed);
  const predecessor = predecessorTasks.at(-1)!;
  const before = await rowCounts();
  const result = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    name: "auto-start conflict",
    afterTaskId: predecessor.id,
    autoStart: true,
  });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, "dispatch_conflicts_with_auto_start");
  await assertNoPartialRows(before);
});

test("after-task refusals are typed and leave no partial chain rows", async () => {
  const seed = await fixture("binding-refusals");
  const missing = "missing-predecessor";
  const foreignProject = await db.project.create({
    data: { name: "foreign", slug: `foreign-${Date.now()}-${Math.floor(Math.random() * 1e6)}` },
  });
  const foreign = await db.task.create({
    data: {
      projectId: foreignProject.id,
      name: "Foreign predecessor",
      description: "foreign",
      chainId: "foreign-chain",
      chainIndex: STEP_COUNT,
      chainLayer: STEP_COUNT,
      status: "TODO",
    },
  });
  const manual = await db.task.create({
    data: {
      projectId: seed.project.id,
      repoId: seed.repo.id,
      assigneeAgentId: seed.agent.id,
      name: "Manual task",
      description: "manual",
      status: "TODO",
    },
  });
  const nonTerminal = (await instantiate(seed))[0]!;
  const parallelTasks = await instantiate(seed);
  const parallelTarget = parallelTasks.at(-1)!;
  const parallelSibling = parallelTasks.at(-2)!;
  await db.task.update({ where: { id: parallelSibling.id }, data: { chainLayer: parallelTarget.chainLayer } });
  const archived = (await instantiate(seed)).at(-1)!;
  await db.task.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
  const done = (await instantiate(seed)).at(-1)!;
  await db.task.update({ where: { id: done.id }, data: { status: "DONE" } });

  const cases = [
    { id: missing, code: "after_task_not_found" },
    { id: foreign.id, code: "after_task_not_found" },
    { id: manual.id, code: "after_task_not_chained" },
    { id: nonTerminal.id, code: "after_task_not_terminal" },
    { id: parallelTarget.id, code: "after_task_not_terminal" },
    { id: archived.id, code: "after_task_archived" },
    { id: done.id, code: "after_task_already_done" },
  ];
  for (const { id, code } of cases) {
    const before = await rowCounts();
    const result = await request(seed.project.id, seed.template.id, {
      repoId: seed.repo.id,
      variables: {},
      name: `refusal ${code}`,
      afterTaskId: id,
    });
    assert.equal(result.status, 400, `${code}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, code, `${code}: ${JSON.stringify(result.body)}`);
    await assertNoPartialRows(before);
  }
});

test("a predecessor accepts several bound successor chains and records one binding activity each", async () => {
  const seed = await fixture("fan-out-binding");
  const predecessor = (await instantiate(seed)).at(-1)!;
  const first = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    name: "first bound successor",
    afterTaskId: predecessor.id,
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstTasks = await db.task.findMany({ where: { chainId: first.body.chainId }, orderBy: { chainIndex: "asc" } });
  const second = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    name: "second bound successor",
    afterTaskId: predecessor.id,
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const third = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    name: "third bound successor",
    afterTaskId: predecessor.id,
  });
  assert.equal(third.status, 201, JSON.stringify(third.body));

  // The first chain is untouched by the later bindings.
  assert.deepEqual(
    await db.task.findMany({ where: { chainId: first.body.chainId }, orderBy: { chainIndex: "asc" } }),
    firstTasks,
  );
  const bound = await db.task.findMany({
    where: { dispatchAfterTaskId: predecessor.id },
    select: { chainId: true, chainIndex: true },
  });
  assert.deepEqual(
    bound.map((task) => task.chainId).sort(),
    [first.body.chainId, second.body.chainId, third.body.chainId].sort(),
  );
  assert.deepEqual(bound.map((task) => task.chainIndex), [0, 0, 0]);
  // One binding activity per successor, not one per predecessor.
  assert.equal(
    await db.taskActivity.count({ where: { taskId: predecessor.id, body: { contains: "bound to predecessor" } } }),
    3,
  );
});

test("concurrent binds serialize on the predecessor chain and both succeed", { timeout: 30_000 }, async () => {
  const seed = await fixture("concurrent-binding");
  const predecessor = (await instantiate(seed)).at(-1)!;
  const body = { repoId: seed.repo.id, variables: {}, name: "concurrent successor", afterTaskId: predecessor.id };
  const results = await Promise.all([
    request(seed.project.id, seed.template.id, body),
    request(seed.project.id, seed.template.id, body),
  ]);
  assert.deepEqual(results.map((result) => result.status), [201, 201], JSON.stringify(results.map((r) => r.body)));
  assert.notEqual(results[0]!.body.chainId, results[1]!.body.chainId);
  assert.equal(await db.task.count(), STEP_COUNT * 3);
  assert.equal(await db.task.count({ where: { dispatchAfterTaskId: predecessor.id } }), 2);
  assert.equal(await db.taskActivity.count({ where: { taskId: predecessor.id, body: { contains: "bound to predecessor" } } }), 2);
});

test("every chain bound to one predecessor waits for it, starts independently, and survives a sibling's deletion", async () => {
  const seed = await fixture("fan-out-lifecycle");
  const predecessorTasks = await instantiate(seed);
  const predecessor = predecessorTasks.at(-1)!;
  const successors = [];
  for (const name of ["successor A", "successor B"]) {
    const created = await request(seed.project.id, seed.template.id, {
      repoId: seed.repo.id,
      variables: {},
      name,
      afterTaskId: predecessor.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const tasks = await db.task.findMany({ where: { chainId: created.body.chainId }, orderBy: { chainIndex: "asc" } });
    successors.push({ chainId: created.body.chainId as string, first: tasks[0]! });
  }
  const [first, second] = successors as [typeof successors[number], typeof successors[number]];
  assert.equal(first.first.dispatchAfterTaskId, predecessor.id);
  assert.equal(second.first.dispatchAfterTaskId, predecessor.id);

  // While the predecessor is TODO, neither bound first step may be started.
  for (const successor of successors) {
    const refused = await operatorRequest(`/tasks/${successor.first.id}/start`, "POST");
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(String(refused.body.error), /predecessor .+ is not done/u);
  }
  assert.equal(await db.run.count({ where: { taskId: { in: successors.map((one) => one.first.id) } } }), 0);

  // The predecessor settling makes both of them startable, and starting one
  // leaves the other exactly where it was.
  await db.task.update({ where: { id: predecessor.id }, data: { status: TaskStatus.DONE } });
  const started = await operatorRequest(`/tasks/${first.first.id}/start`, "POST");
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(await db.run.count({ where: { taskId: first.first.id } }), 1);
  assert.equal(await db.run.count({ where: { taskId: second.first.id } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: second.first.id } })).status, TaskStatus.TODO);
  const startedSibling = await operatorRequest(`/tasks/${second.first.id}/start`, "POST");
  assert.equal(startedSibling.status, 201, JSON.stringify(startedSibling.body));
  assert.equal(await db.run.count({ where: { taskId: second.first.id } }), 1);
});

test("deleting one bound chain releases only its own binding", async () => {
  const seed = await fixture("fan-out-release");
  const predecessor = (await instantiate(seed)).at(-1)!;
  const chainIds: string[] = [];
  for (const name of ["released successor", "retained successor"]) {
    const created = await request(seed.project.id, seed.template.id, {
      repoId: seed.repo.id,
      variables: {},
      name,
      afterTaskId: predecessor.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    chainIds.push(created.body.chainId as string);
  }
  const [releasedChainId, retainedChainId] = chainIds as [string, string];
  const releasedFirst = await db.task.findFirstOrThrow({ where: { chainId: releasedChainId, chainIndex: 0 } });

  const deleted = await operatorRequest(`/tasks/${releasedFirst.id}/chain`, "DELETE");
  assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
  assert.equal(await db.task.count({ where: { chainId: releasedChainId } }), 0);
  const stillBound = await db.task.findMany({
    where: { dispatchAfterTaskId: predecessor.id },
    select: { chainId: true },
  });
  assert.deepEqual(stillBound.map((task) => task.chainId), [retainedChainId]);
  assert.equal(await db.task.count({ where: { chainId: retainedChainId } }), STEP_COUNT);
});
