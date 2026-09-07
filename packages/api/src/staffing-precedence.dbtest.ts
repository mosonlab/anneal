import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_TEMPLATE_NAME,
  PrismaClient,
  RepoPermission,
} from "@anneal/db";

import { isTemplateInstantiationRefusal, type TemplateInstantiationRefusalCode } from "./template-errors.js";
import { runDbScript } from "./test-db-script.js";
import { resetTestDb, setupTestDb } from "./testdb.js";
import { instantiateTemplate } from "./templates.js";

/**
 * Proves R4 against real rows: at instantiation the assignee of a step is the
 * explicit override, else the selected staffing profile, else the canonical
 * binding the template step carries — and the same order decides whether an
 * optional step is instantiated at all.
 *
 * TODO(integrator): `StaffingProfile` is owned by the profile-model lane, so
 * the accessor below casts past the generated client. Drop the cast once that
 * model is in `schema.prisma`.
 */
type StaffingProfileEntryInput = {
  outputKind: string;
  assigneeAgentId?: string | null;
  include?: boolean | null;
};

type StaffingProfileClient = {
  staffingProfile: {
    create(args: {
      data: {
        projectId: string;
        taskTemplateId: string;
        name: string;
        isDefault: boolean;
        entries: { create: StaffingProfileEntryInput[] };
      };
    }): Promise<{ id: string; name: string }>;
    deleteMany(args: { where: { taskTemplateId: string } }): Promise<{ count: number }>;
  };
};

let db: PrismaClient;

const staffingProfiles = (): StaffingProfileClient["staffingProfile"] => {
  const delegate = (db as unknown as Partial<StaffingProfileClient>).staffingProfile;
  // Says which lane is missing rather than failing as an undefined property
  // access several frames down.
  if (!delegate) {
    throw new Error(
      "StaffingProfile is absent from the generated client: this dbtest runs once the staffing-profile model and its migration are merged",
    );
  }
  return delegate;
};

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
    name: `staffing-${randomUUID()}`,
    remoteUrl: "https://example.test/staffing.git",
    mountPath: "/repo",
    defaultBranch: "main",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  const agents = await db.agent.findMany({
    where: { projectId: project.id },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  await db.agentRepoAccess.createMany({ data: agents.map(({ id: agentId }) => ({
    projectId: project.id,
    agentId,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: RepoPermission.GIT_WRITE,
  })) });
  const steps = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: direct.id },
    select: { stepIndex: true, outputKind: true, optional: true, assigneeAgentId: true },
    orderBy: { stepIndex: "asc" },
  });
  const implementation = steps.find((step) => step.outputKind === "implementation")!;
  const optional = steps.find((step) => step.optional)!;
  const fix = steps.find((step) => step.outputKind === "fixed-implementation")!;
  // Two agents that are neither the mechanical integrator sentinel nor the
  // step's own canonical binding, so a staffing change is observable.
  const substitutes = agents.filter(({ id, name }) => (
    name !== INTEGRATOR_AGENT_NAME && id !== implementation.assigneeAgentId && id !== fix.assigneeAgentId
  ));
  return {
    project,
    repo,
    direct,
    compound,
    steps: { implementation, optional, fix },
    profileAgent: substitutes[0]!,
    overrideAgent: substitutes[1]!,
  };
};

type Installation = Awaited<ReturnType<typeof install>>;

const variablesFor = (template: { variables: string[] }, label: string) => Object.fromEntries(
  template.variables.map((name) => [name, name === "branchName" ? `staffing/${label}-${randomUUID()}` : `value-${name}`]),
);

const instantiateDirect = (
  seed: Installation,
  label: string,
  input: Partial<Parameters<typeof instantiateTemplate>[3]> = {},
) => instantiateTemplate(db, seed.project.id, seed.direct.id, {
  repoId: seed.repo.id,
  variables: variablesFor(seed.direct, label),
  name: `staffing ${label}`,
  ...input,
});

const assertRefusal = async (
  operation: () => Promise<unknown>,
  code: TemplateInstantiationRefusalCode,
): Promise<void> => {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(isTemplateInstantiationRefusal(error), String(error));
    assert.equal(error.code, code);
    return true;
  });
};

const assigneeOf = async (chainId: string, outputKind: string): Promise<string | null | undefined> => (
  (await db.task.findFirst({
    where: { chainId, templateStep: { outputKind } },
    select: { assigneeAgentId: true },
  }))?.assigneeAgentId
);

const defaultProfileFor = async (seed: Installation, name = "Default") => staffingProfiles().create({
  data: {
    projectId: seed.project.id,
    taskTemplateId: seed.direct.id,
    name,
    isDefault: true,
    entries: { create: [
      { outputKind: seed.steps.implementation.outputKind, assigneeAgentId: seed.profileAgent.id },
      { outputKind: seed.steps.fix.outputKind, assigneeAgentId: seed.profileAgent.id },
      { outputKind: seed.steps.optional.outputKind, include: false },
    ] },
  },
});

test("the template's default profile staffs a chain, and an explicit override outranks it", async () => {
  const seed = await install();
  await defaultProfileFor(seed);

  const staffed = await instantiateDirect(seed, "default-profile");
  assert.equal(await assigneeOf(staffed.chainId, "implementation"), seed.profileAgent.id);
  assert.equal(await assigneeOf(staffed.chainId, "fixed-implementation"), seed.profileAgent.id);
  assert.equal(await assigneeOf(staffed.chainId, seed.steps.optional.outputKind), undefined);
  assert.equal(await assigneeOf(staffed.chainId, "review-findings"), (await db.taskTemplateStep.findFirstOrThrow({
    where: { taskTemplateId: seed.direct.id, outputKind: "review-findings" },
    select: { assigneeAgentId: true },
  })).assigneeAgentId);

  const overridden = await instantiateDirect(seed, "override-wins", {
    stepOverrides: {
      [String(seed.steps.implementation.stepIndex)]: { assigneeAgentId: seed.overrideAgent.id },
      [String(seed.steps.optional.stepIndex)]: { include: true },
    },
  });
  assert.equal(await assigneeOf(overridden.chainId, "implementation"), seed.overrideAgent.id);
  // The profile still staffs every step the override is silent about.
  assert.equal(await assigneeOf(overridden.chainId, "fixed-implementation"), seed.profileAgent.id);
  assert.notEqual(await assigneeOf(overridden.chainId, seed.steps.optional.outputKind), undefined);
});

test("the chain root records the profile it was staffed from", async () => {
  const seed = await install();
  const profile = await defaultProfileFor(seed);
  const chain = await instantiateDirect(seed, "provenance");
  const activities = await db.taskActivity.findMany({
    where: { task: { chainId: chain.chainId } },
    select: { metadata: true, task: { select: { chainIndex: true } } },
  });
  const root = activities.find(({ task }) => task?.chainIndex === 1)!;
  assert.deepEqual(
    {
      id: (root.metadata as Record<string, unknown>).staffingProfileId,
      name: (root.metadata as Record<string, unknown>).staffingProfileName,
    },
    { id: profile.id, name: profile.name },
  );
  for (const activity of activities.filter(({ task }) => task?.chainIndex !== 1)) {
    assert.equal((activity.metadata as Record<string, unknown>).staffingProfileId, undefined);
  }
});

test("a profile is addressable only from its own template, and only by a name it has", async () => {
  const seed = await install();
  await defaultProfileFor(seed);
  const foreign = await staffingProfiles().create({
    data: {
      projectId: seed.project.id,
      taskTemplateId: seed.compound.id,
      name: "Compound crew",
      isDefault: true,
      entries: { create: [] },
    },
  });

  await assertRefusal(
    () => instantiateDirect(seed, "foreign-profile", { staffingProfileId: foreign.id }),
    "staffing_profile_not_found",
  );
  await assertRefusal(
    () => instantiateDirect(seed, "unknown-name", { description: "Staffing: Night crew" }),
    "staffing_profile_not_found",
  );
  await assertRefusal(
    () => instantiateDirect(seed, "malformed-line", { description: "Staffing:Default" }),
    "staffing_profile_line_malformed",
  );
});

test("a Staffing line selects a profile, and a Route line still owns the implementation step", async () => {
  const seed = await install();
  await defaultProfileFor(seed);
  const weekend = await staffingProfiles().create({
    data: {
      projectId: seed.project.id,
      taskTemplateId: seed.direct.id,
      name: "Weekend crew",
      isDefault: false,
      entries: { create: [
        { outputKind: seed.steps.implementation.outputKind, assigneeAgentId: seed.profileAgent.id },
        { outputKind: seed.steps.fix.outputKind, assigneeAgentId: seed.overrideAgent.id },
      ] },
    },
  });

  const named = await instantiateDirect(seed, "by-name", { description: `Staffing: ${weekend.name}` });
  assert.equal(await assigneeOf(named.chainId, "fixed-implementation"), seed.overrideAgent.id);

  // R4: the Route line beats the profile for the step it names and leaves the
  // rest of the chain staffed by that profile.
  const routed = await instantiateDirect(seed, "route-and-profile", {
    description: `Staffing: ${weekend.name}\nRoute: implementation=${seed.overrideAgent.name}`,
  });
  assert.equal(await assigneeOf(routed.chainId, "implementation"), seed.overrideAgent.id);
  assert.equal(await assigneeOf(routed.chainId, "fixed-implementation"), seed.overrideAgent.id);

  // ... and conflicts only with an explicit override of that same step.
  await assertRefusal(
    () => instantiateDirect(seed, "route-conflict", {
      description: `Route: implementation=${seed.overrideAgent.name}`,
      stepOverrides: { [String(seed.steps.implementation.stepIndex)]: { assigneeAgentId: seed.profileAgent.id } },
    }),
    "implementation_route_conflicts_with_step_override",
  );
});

test("deleting the last profile leaves instantiation on the canonical bindings", async () => {
  const seed = await install();
  await defaultProfileFor(seed);
  await staffingProfiles().deleteMany({ where: { taskTemplateId: seed.direct.id } });

  const chain = await instantiateDirect(seed, "canonical-fallback");
  assert.equal(await assigneeOf(chain.chainId, "implementation"), seed.steps.implementation.assigneeAgentId);
  assert.equal(await assigneeOf(chain.chainId, "fixed-implementation"), seed.steps.fix.assigneeAgentId);
  // The optional step the deleted profile excluded is instantiated again.
  assert.notEqual(await assigneeOf(chain.chainId, seed.steps.optional.outputKind), undefined);
});
