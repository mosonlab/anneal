import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
  enqueueTaskRun,
  INTEGRATOR_TEMPLATE_NAME,
  pinnedImplementationRange,
  PrismaClient,
  RepoPermission,
  TaskStatus,
} from "@anneal/db";

import { chainProgress } from "./chain.js";
import { runDbScript } from "./test-db-script.js";
import { resetTestDb, setupTestDb } from "./testdb.js";
import { instantiateTemplate } from "./templates.js";

let db: PrismaClient;

before(() => { db = setupTestDb(); });
beforeEach(async () => {
  await resetTestDb(db);
  await runDbScript("seed.ts");
});
after(async () => { await db.$disconnect(); });

const install = async () => {
  const project = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const [direct, compound] = await Promise.all([
    db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: DIRECT_TEMPLATE_NAME } },
      select: { id: true, variables: true },
    }),
    db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: INTEGRATOR_TEMPLATE_NAME } },
      select: { id: true, variables: true },
    }),
  ]);
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: `optional-step-${randomUUID()}`,
    remoteUrl: "https://example.test/optional-step.git",
    mountPath: "/repo",
    defaultBranch: "main",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  const agents = await db.agent.findMany({ where: { projectId: project.id }, select: { id: true } });
  await db.agentRepoAccess.createMany({ data: agents.map(({ id: agentId }) => ({
    projectId: project.id,
    agentId,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: RepoPermission.GIT_WRITE,
  })) });
  return { project, repo, direct, compound };
};

const variablesFor = (template: { variables: string[] }, label: string) => Object.fromEntries(
  template.variables.map((name) => [name, name === "branchName" ? `optional/${label}-${randomUUID()}` : `value-${name}`]),
);

const predecessorFor = async (projectId: string, repoId: string) => db.task.create({ data: {
  projectId,
  repoId,
  name: "Optional-step dispatch predecessor",
  description: "Terminal predecessor for a bound direct chain",
  assigneeType: "HUMAN",
  status: TaskStatus.TODO,
  chainId: `optional-predecessor-${randomUUID()}`,
  chainIndex: 1,
  chainLayer: 1,
} });

const coordinates = (tasks: Array<{ chainIndex: number | null; chainLayer: number | null }>) => ({
  indexes: tasks.map(({ chainIndex }) => chainIndex),
  layers: tasks.map(({ chainLayer }) => chainLayer),
});

/** The stepIndex of the one optional step a canonical template declares. */
const optionalStepIndex = async (taskTemplateId: string): Promise<number> => (
  (await db.taskTemplateStep.findFirstOrThrow({
    where: { taskTemplateId, optional: true },
    select: { stepIndex: true },
  })).stepIndex
);

test("direct instantiation snapshots optional omission and preserves sparse template ordinals", async () => {
  const seed = await install();
  const optionalStep = await optionalStepIndex(seed.direct.id);
  const instantiateDirect = async (skip: boolean, bound: boolean) => {
    const predecessor = bound ? await predecessorFor(seed.project.id, seed.repo.id) : null;
    return instantiateTemplate(db, seed.project.id, seed.direct.id, {
      repoId: seed.repo.id,
      variables: variablesFor(seed.direct, `${skip ? "skip" : "keep"}-${bound ? "bound" : "unbound"}`),
      name: `direct ${skip ? "skip" : "keep"} ${bound ? "bound" : "unbound"}`,
      ...(skip ? { stepOverrides: { [String(optionalStep)]: { include: false } } } : {}),
      ...(predecessor ? { afterTaskId: predecessor.id } : {}),
    });
  };

  const keptUnbound = await instantiateDirect(false, false);
  assert.equal(keptUnbound.tasks.length, 7);
  assert.deepEqual(coordinates(keptUnbound.tasks), {
    indexes: [1, 2, 3, 4, 5, 6, 7],
    layers: [1, 2, 2, 3, 4, 5, 6],
  });
  const keptBound = await instantiateDirect(false, true);
  assert.equal(keptBound.tasks.length, 8);
  assert.deepEqual(coordinates(keptBound.tasks), {
    indexes: [1, 2, 3, 4, 5, 6, 7, 8],
    layers: [1, 2, 3, 3, 4, 5, 6, 7],
  });

  const skippedUnbound = await instantiateDirect(true, false);
  assert.equal(skippedUnbound.tasks.length, 6);
  assert.deepEqual(coordinates(skippedUnbound.tasks), {
    indexes: [1, 2, 4, 5, 6, 7],
    layers: [1, 2, 3, 4, 5, 6],
  });
  assert.equal(await db.task.count({
    where: { chainId: skippedUnbound.chainId, templateStep: { outputKind: "blind-findings" } },
  }), 0);
  const progressRows = await db.task.findMany({
    where: { chainId: skippedUnbound.chainId },
    include: { templateStep: true },
  });
  const progress = chainProgress(progressRows);
  assert.deepEqual(progress, {
    total: 6,
    done: 0,
    activeStepName: "Implementation",
    activeStatus: "todo",
    currentLayer: 1,
    layerCount: 6,
  });

  const skippedBound = await instantiateDirect(true, true);
  assert.equal(skippedBound.tasks.length, 7);
  assert.deepEqual(coordinates(skippedBound.tasks), {
    indexes: [1, 2, 3, 5, 6, 7, 8],
    layers: [1, 2, 3, 4, 5, 6, 7],
  });

  // The omission is a snapshot: nothing outside this chain can put the step
  // back into it, because the absent Task row is the only record of it.
  assert.equal(await db.task.count({ where: { chainId: skippedUnbound.chainId } }), 6);
});

test("compound omission preserves exact-ordinal merge predecessors and retained base references", async () => {
  const seed = await install();
  const chain = await instantiateTemplate(db, seed.project.id, seed.compound.id, {
    repoId: seed.repo.id,
    variables: variablesFor(seed.compound, "compound"),
    name: "compound optional omission",
    stepOverrides: { [String(await optionalStepIndex(seed.compound.id))]: { include: false } },
  });
  assert.equal(chain.tasks.length, 11);
  assert.equal(await db.task.count({
    where: { chainId: chain.chainId, templateStep: { outputKind: "blind-findings" } },
  }), 0);
  const tasks = await db.task.findMany({
    where: { chainId: chain.chainId },
    include: { templateStep: true },
    orderBy: { chainIndex: "asc" },
  });
  assert.ok(tasks.every((task) => task.chainIndex === task.templateStep?.stepIndex));
  for (const kind of ["merge-authorization", "merge-result"]) {
    const tail = tasks.find((task) => task.templateStep?.outputKind === kind)!;
    assert.ok(tasks.some((task) => task.chainIndex === tail.chainIndex! - 1), `${kind} predecessor remains addressable`);
  }

  const implementation = tasks.find((task) => task.templateStep?.stepIndex === 5)!;
  const review = tasks.find((task) => task.templateStep?.stepIndex === 6)!;
  const baseSha = "1".repeat(40);
  const headSha = "2".repeat(40);
  // Where the implementation started is a platform record, not a body field:
  // the pinned base comes from the implementation Run, and the body's own
  // (here deliberately wrong) value is informational.
  const implementationRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, implementation.id));
  // The base has to be published as well as recorded: a range is only pinned
  // to a commit some Run's push carried to the remote.
  await db.run.update({
    where: { id: implementationRun.id },
    data: { baseSha, pushedBranch: `pinned-${implementationRun.id}`, basePublishedAt: new Date() },
  });
  await db.taskStepOutput.create({ data: {
    taskId: implementation.id,
    runId: implementationRun.id,
    kind: "implementation",
    body: JSON.stringify({ schemaVersion: 1, baseSha: "3".repeat(40), headSha, summary: "fixture", testsRun: [] }),
    commitSha: headSha,
  } });
  assert.deepEqual(await pinnedImplementationRange(db, review), {
    implementationBaseSha: baseSha,
    implementationHeadSha: headSha,
  });
});
