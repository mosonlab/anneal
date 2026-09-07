import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_TEMPLATE_NAME,
  RunnerKind,
  RunnerPreference,
  type PrismaClient,
} from "@anneal/db";

import { copyStaffingProfiles, createStaffingProfile } from "./staffing-profiles.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "staffing-profiles-operator";
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

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

const unique = (label: string): string => `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`;

type Seed = Awaited<ReturnType<typeof seed>>;

const seed = async (templateName = "custom-workflow") => {
  const project = await db.project.create({ data: { name: "Staffing", slug: unique("staffing") } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = async (name: string, model: string, runnerPreference: RunnerPreference, archived = false) =>
    db.agent.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        name,
        title: name,
        model,
        runnerPreference,
        foundationalPrompt: "foundation",
        rolePrompt: "role",
        ...(archived ? { archivedAt: new Date() } : {}),
      },
    });
  const implementer = await agent("senior-dev-astra-medium", "gpt-5.6-astra:medium", RunnerPreference.CODEX);
  const reviewer = await agent("code-reviewer-sol-high", "gpt-5.6-sol:high", RunnerPreference.CODEX);
  const claudeAgent = await agent("frontend-dev-opus-medium", "claude-opus-5:medium", RunnerPreference.CLAUDE);
  const integrator = await agent(INTEGRATOR_AGENT_NAME, "mechanical/merge-integrator", RunnerPreference.INHERIT);
  const archivedAgent = await agent("senior-dev-luna-max", "gpt-5.6-luna:max", RunnerPreference.CODEX, true);
  const repairAgent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      canonicalRole: "senior-dev-luna-max",
      name: "senior-dev-luna-max-active",
      title: "Senior Developer Luna Max",
      model: "gpt-5.6-luna:max",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: "staffing-repo",
      remoteUrl: "https://example.test/staffing.git",
      mountPath: "/repo",
      dependencyProvisioning: "NONE",
    },
  });
  await db.agentRepoAccess.create({
    data: {
      projectId: project.id,
      agentId: repairAgent.id,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: "GIT_WRITE",
    },
  });

  const otherProject = await db.project.create({ data: { name: "Other", slug: unique("other") } });
  const otherEnvironment = await db.environment.create({
    data: { projectId: otherProject.id, name: "local", allowedHosts: [] },
  });
  const foreignAgent = await db.agent.create({
    data: {
      projectId: otherProject.id,
      environmentId: otherEnvironment.id,
      name: "senior-dev-astra-medium",
      title: "Foreign",
      model: "gpt-5.6-astra:medium",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });

  const template = await db.taskTemplate.create({
    data: { projectId: project.id, name: templateName, description: "graph", variables: [] },
  });
  const step = async (
    stepIndex: number,
    outputKind: string,
    assigneeAgentId: string | null,
    options: { optional?: boolean; assigneeType?: AssigneeType; runner?: RunnerKind | null } = {},
  ) => db.taskTemplateStep.create({
    data: {
      taskTemplateId: template.id,
      stepIndex,
      layer: stepIndex,
      name: `Step ${outputKind}`,
      assigneeType: options.assigneeType ?? AssigneeType.AGENT,
      assigneeAgentId,
      prompt: "do it",
      outputKind,
      optional: options.optional ?? false,
      runner: options.runner ?? null,
      priorOutputKinds: [],
    },
  });
  await step(1, "implementation", implementer.id, { runner: RunnerKind.CODEX });
  await step(2, "review-findings", reviewer.id);
  await step(3, "blind-findings", reviewer.id, { optional: true });
  await step(4, "merge-result", integrator.id);
  await step(5, "handoff", null, { assigneeType: AssigneeType.HUMAN });

  return {
    project,
    template,
    implementer,
    reviewer,
    claudeAgent,
    integrator,
    archivedAgent,
    repairAgent,
    repo,
    foreignAgent,
  };
};

const profilesPath = (fixture: Seed): string =>
  `/projects/${fixture.project.id}/task-templates/${fixture.template.id}/staffing-profiles`;

const createProfile = async (fixture: Seed, body: unknown) => call("POST", profilesPath(fixture), body);

const minimalEntries = (fixture: Seed) => [
  { outputKind: "implementation", assigneeAgentId: fixture.implementer.id },
];

test("profiles are created, listed, replaced, reset and deleted", async () => {
  const fixture = await seed();

  const empty = await call("GET", profilesPath(fixture));
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body, []);

  const created = await createProfile(fixture, {
    name: "Default",
    entries: [
      { outputKind: "implementation", assigneeAgentId: fixture.implementer.id },
      { outputKind: "blind-findings", include: false },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // The first profile of a template is its default even without asking.
  assert.equal(created.body.profile.isDefault, true);
  assert.deepEqual(created.body.warnings, []);
  assert.deepEqual(created.body.profile.entries, [
    { outputKind: "blind-findings", assigneeAgentId: null, include: false },
    { outputKind: "implementation", assigneeAgentId: fixture.implementer.id, include: null },
  ]);

  const replaced = await call("PUT", `/staffing-profiles/${created.body.profile.id}`, {
    name: "Renamed",
    entries: [{ outputKind: "review-findings", assigneeAgentId: fixture.reviewer.id }],
  });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal(replaced.body.profile.name, "Renamed");
  // Whole replacement: the omitted kinds lose their opinions, except that the
  // optional step keeps a boolean, because a profile always states one (R3).
  assert.deepEqual(replaced.body.profile.entries, [
    { outputKind: "blind-findings", assigneeAgentId: null, include: true },
    { outputKind: "review-findings", assigneeAgentId: fixture.reviewer.id, include: null },
  ]);

  const reset = await call("POST", `/staffing-profiles/${created.body.profile.id}/reset`);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.deepEqual(reset.body.profile.entries, [
    { outputKind: "blind-findings", assigneeAgentId: fixture.reviewer.id, include: true },
    { outputKind: "handoff", assigneeAgentId: null, include: null },
    { outputKind: "implementation", assigneeAgentId: fixture.implementer.id, include: null },
    { outputKind: "merge-result", assigneeAgentId: fixture.integrator.id, include: null },
    { outputKind: "review-findings", assigneeAgentId: fixture.reviewer.id, include: null },
  ]);

  const listed = await call("GET", profilesPath(fixture));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map((profile: { name: string }) => profile.name), ["Renamed"]);

  // The last profile may go; instantiation then falls back to canonical.
  const deleted = await call("DELETE", `/staffing-profiles/${created.body.profile.id}`);
  assert.equal(deleted.status, 204);
  assert.deepEqual((await call("GET", profilesPath(fixture))).body, []);
});

test("exactly one profile of a template is the default, through every transition", async () => {
  const fixture = await seed();
  const first = await createProfile(fixture, { name: "First", entries: minimalEntries(fixture) });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await createProfile(fixture, { name: "Second", entries: [] });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.profile.isDefault, false);

  const third = await createProfile(fixture, { name: "Third", entries: [], isDefault: true });
  assert.equal(third.status, 201, JSON.stringify(third.body));
  const afterCreate = await call("GET", profilesPath(fixture));
  assert.deepEqual(
    afterCreate.body.map((profile: { name: string; isDefault: boolean }) => [profile.name, profile.isDefault]),
    [["Third", true], ["First", false], ["Second", false]],
  );

  const promoted = await call("PATCH", `/staffing-profiles/${second.body.profile.id}`, { isDefault: true });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  const afterPatch = await call("GET", profilesPath(fixture));
  assert.deepEqual(
    afterPatch.body.filter((profile: { isDefault: boolean }) => profile.isDefault)
      .map((profile: { name: string }) => profile.name),
    ["Second"],
  );

  const refusedDelete = await call("DELETE", `/staffing-profiles/${second.body.profile.id}`);
  assert.equal(refusedDelete.status, 409, JSON.stringify(refusedDelete.body));
  assert.equal(refusedDelete.body.code, "staffing_profile_default_delete_refused");

  assert.equal((await call("DELETE", `/staffing-profiles/${first.body.profile.id}`)).status, 204);
  assert.equal((await call("DELETE", `/staffing-profiles/${third.body.profile.id}`)).status, 204);
  // Now the default is the last one left, so it may go.
  assert.equal((await call("DELETE", `/staffing-profiles/${second.body.profile.id}`)).status, 204);
});

test("a name is unique per template and reusable across templates", async () => {
  const fixture = await seed();
  assert.equal((await createProfile(fixture, { name: "Plan A", entries: [] })).status, 201);
  const duplicate = await createProfile(fixture, { name: "Plan A", entries: [] });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.code, "staffing_profile_name_taken");

  const sibling = await db.taskTemplate.create({
    data: { projectId: fixture.project.id, name: "sibling-workflow", description: "graph", variables: [] },
  });
  const other = await call(
    "POST",
    `/projects/${fixture.project.id}/task-templates/${sibling.id}/staffing-profiles`,
    { name: "Plan A", entries: [] },
  );
  assert.equal(other.status, 201, JSON.stringify(other.body));
});

test("a template outside the addressed project is not found", async () => {
  const fixture = await seed();
  const foreign = await db.project.create({ data: { name: "Foreign", slug: unique("foreign") } });
  const listed = await call("GET", `/projects/${foreign.id}/task-templates/${fixture.template.id}/staffing-profiles`);
  assert.equal(listed.status, 404, JSON.stringify(listed.body));
  assert.equal(listed.body.code, "staffing_profile_template_not_found");

  const created = await call(
    "POST",
    `/projects/${foreign.id}/task-templates/${fixture.template.id}/staffing-profiles`,
    { name: "Plan", entries: [] },
  );
  assert.equal(created.status, 404, JSON.stringify(created.body));
  assert.equal(created.body.code, "staffing_profile_template_not_found");
});

test("an unknown profile id is refused on every profile-scoped route", async () => {
  await seed();
  for (const [method, path, body] of [
    ["PUT", "/staffing-profiles/missing", { name: "x", entries: [] }],
    ["PATCH", "/staffing-profiles/missing", { isDefault: true }],
    ["DELETE", "/staffing-profiles/missing", undefined],
    ["POST", "/staffing-profiles/missing/reset", undefined],
  ] as const) {
    const response = await call(method, path, body);
    assert.equal(response.status, 404, `${method} ${path}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, "staffing_profile_not_found");
  }
});

test("entries are validated against the template graph and the Agent rows", async () => {
  const fixture = await seed();
  const refusalFor = async (entries: unknown[]): Promise<{ status: number; body: any }> =>
    createProfile(fixture, { name: unique("plan"), entries });

  const unknownKind = await refusalFor([{ outputKind: "no-such-kind", assigneeAgentId: fixture.implementer.id }]);
  assert.equal(unknownKind.status, 422, JSON.stringify(unknownKind.body));
  assert.equal(unknownKind.body.code, "staffing_profile_unknown_output_kind");
  assert.equal(unknownKind.body.outputKind, "no-such-kind");

  const duplicate = await refusalFor([
    { outputKind: "implementation", assigneeAgentId: fixture.implementer.id },
    { outputKind: "implementation", assigneeAgentId: fixture.reviewer.id },
  ]);
  assert.equal(duplicate.status, 422, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.code, "staffing_profile_entry_duplicate");

  const includeOnRequired = await refusalFor([{ outputKind: "implementation", include: false }]);
  assert.equal(includeOnRequired.status, 422, JSON.stringify(includeOnRequired.body));
  assert.equal(includeOnRequired.body.code, "staffing_profile_include_not_optional");

  const humanStep = await refusalFor([{ outputKind: "handoff", assigneeAgentId: fixture.implementer.id }]);
  assert.equal(humanStep.status, 422, JSON.stringify(humanStep.body));
  assert.equal(humanStep.body.code, "staffing_profile_step_not_agent");

  const foreign = await refusalFor([{ outputKind: "implementation", assigneeAgentId: fixture.foreignAgent.id }]);
  assert.equal(foreign.status, 422, JSON.stringify(foreign.body));
  assert.equal(foreign.body.code, "staffing_profile_agent_not_found");

  const archived = await refusalFor([{ outputKind: "implementation", assigneeAgentId: fixture.archivedAgent.id }]);
  assert.equal(archived.status, 422, JSON.stringify(archived.body));
  assert.equal(archived.body.code, "staffing_profile_agent_archived");
});

test("the merge-execution binding is refused from both sides", async () => {
  const fixture = await seed();
  const modelOnMerge = await createProfile(fixture, {
    name: "Model on merge",
    entries: [{ outputKind: "merge-result", assigneeAgentId: fixture.implementer.id }],
  });
  assert.equal(modelOnMerge.status, 422, JSON.stringify(modelOnMerge.body));
  assert.equal(modelOnMerge.body.code, "staffing_profile_integrator_binding");

  const sentinelElsewhere = await createProfile(fixture, {
    name: "Sentinel elsewhere",
    entries: [{ outputKind: "review-findings", assigneeAgentId: fixture.integrator.id }],
  });
  assert.equal(sentinelElsewhere.status, 422, JSON.stringify(sentinelElsewhere.body));
  assert.equal(sentinelElsewhere.body.code, "staffing_profile_integrator_binding");

  const sentinelOnMerge = await createProfile(fixture, {
    name: "Sentinel on merge",
    entries: [{ outputKind: "merge-result", assigneeAgentId: fixture.integrator.id }],
  });
  assert.equal(sentinelOnMerge.status, 201, JSON.stringify(sentinelOnMerge.body));
});

test("the compound implementation root requires a Codex runner with a gpt-* model", async () => {
  const fixture = await seed(INTEGRATOR_TEMPLATE_NAME);

  const claudeRoot = await createProfile(fixture, {
    name: "Claude root",
    entries: [{ outputKind: "implementation", assigneeAgentId: fixture.claudeAgent.id }],
  });
  assert.equal(claudeRoot.status, 422, JSON.stringify(claudeRoot.body));
  assert.equal(claudeRoot.body.code, "staffing_profile_compound_implementation");

  // Capability, not name: any Codex/gpt-* agent may hold the root.
  const codexRoot = await createProfile(fixture, {
    name: "Codex root",
    entries: [{ outputKind: "implementation", assigneeAgentId: fixture.reviewer.id }],
  });
  assert.equal(codexRoot.status, 201, JSON.stringify(codexRoot.body));
});

test("one agent implementing and reviewing is a warning, not a refusal", async () => {
  const fixture = await seed();
  const created = await createProfile(fixture, {
    name: "Self review",
    entries: [
      { outputKind: "implementation", assigneeAgentId: fixture.implementer.id },
      { outputKind: "review-findings", assigneeAgentId: fixture.implementer.id },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.warnings, [{
    code: "same_agent_implements_and_reviews",
    message: "One Agent implements and reviews under this staffing profile",
  }]);
});

test("saving a profile waits on the Agent-row mutex archive takes", async () => {
  const fixture = await seed();
  let releaseLock = (): void => undefined;
  const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve; });
  const holder = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${fixture.implementer.id} FOR UPDATE`;
    await lockHeld;
  }, { timeout: 20_000 });
  await delay(200);

  let settled = false;
  const save = createStaffingProfile(db, fixture.project.id, fixture.template.id, {
    name: "Locked",
    entries: [{ outputKind: "implementation", assigneeAgentId: fixture.implementer.id }],
  }).then((result) => { settled = true; return result; });
  await delay(400);
  assert.equal(settled, false, "the profile write must block on the held Agent row");

  releaseLock();
  await holder;
  const saved = await save;
  assert.deepEqual(saved.profile.entries, [
    { outputKind: "blind-findings", assigneeAgentId: null, include: true },
    { outputKind: "implementation", assigneeAgentId: fixture.implementer.id, include: null },
  ]);
});

test("a stored profile carries a boolean include for every optional step", async () => {
  const fixture = await seed();

  // Nothing said about the optional step at all.
  const silent = await createProfile(fixture, { name: "Silent", entries: minimalEntries(fixture) });
  assert.equal(silent.status, 201, JSON.stringify(silent.body));
  assert.deepEqual(silent.body.profile.entries, [
    { outputKind: "blind-findings", assigneeAgentId: null, include: true },
    { outputKind: "implementation", assigneeAgentId: fixture.implementer.id, include: null },
  ]);

  // Named, but with no opinion: staffing the step is not skipping it.
  const staffed = await createProfile(fixture, {
    name: "Staffed",
    entries: [{ outputKind: "blind-findings", assigneeAgentId: fixture.reviewer.id }],
  });
  assert.equal(staffed.status, 201, JSON.stringify(staffed.body));
  assert.deepEqual(staffed.body.profile.entries, [
    { outputKind: "blind-findings", assigneeAgentId: fixture.reviewer.id, include: true },
  ]);

  // An explicit null is the same absence of an opinion, and a stated false survives.
  const explicit = await createProfile(fixture, {
    name: "Explicit",
    entries: [{ outputKind: "blind-findings", include: null }],
  });
  assert.equal(explicit.status, 201, JSON.stringify(explicit.body));
  assert.deepEqual(explicit.body.profile.entries, [
    { outputKind: "blind-findings", assigneeAgentId: null, include: true },
  ]);
  const skipped = await call("PUT", `/staffing-profiles/${explicit.body.profile.id}`, {
    name: "Explicit",
    entries: [{ outputKind: "blind-findings", include: false }],
  });
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
  assert.deepEqual(skipped.body.profile.entries, [
    { outputKind: "blind-findings", assigneeAgentId: null, include: false },
  ]);
});

test("the merge-tail repair slot round-trips, checks its Repo grant and refuses archived Agents", async () => {
  const fixture = await seed();
  const created = await createProfile(fixture, {
    name: "Repair slot",
    entries: minimalEntries(fixture),
    mergeTailRepairAgentId: fixture.repairAgent.id,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.profile.mergeTailRepairAgentId, fixture.repairAgent.id);

  const listed = await call("GET", profilesPath(fixture));
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body[0].mergeTailRepairAgentId, fixture.repairAgent.id);

  // Omitting the optional slot on a whole PUT preserves the operator's choice.
  const preserved = await call("PUT", `/staffing-profiles/${created.body.profile.id}`, {
    name: "Repair slot renamed",
    entries: minimalEntries(fixture),
  });
  assert.equal(preserved.status, 200, JSON.stringify(preserved.body));
  assert.equal(preserved.body.profile.mergeTailRepairAgentId, fixture.repairAgent.id);

  const secondRepo = await db.repo.create({
    data: {
      projectId: fixture.project.id,
      name: "staffing-repo-two",
      remoteUrl: "https://example.test/staffing-two.git",
      mountPath: "/repo-two",
      dependencyProvisioning: "NONE",
    },
  });
  await db.agentRepoAccess.create({
    data: {
      projectId: fixture.project.id,
      agentId: fixture.repairAgent.id,
      repoId: secondRepo.id,
      mountPath: "/repo-two",
      permissions: "GIT_WRITE",
    },
  });
  const preservedAcrossRepos = await call("PUT", `/staffing-profiles/${created.body.profile.id}`, {
    name: "Repair slot still selected",
    entries: minimalEntries(fixture),
  });
  assert.equal(preservedAcrossRepos.status, 200, JSON.stringify(preservedAcrossRepos.body));
  assert.equal(preservedAcrossRepos.body.profile.mergeTailRepairAgentId, fixture.repairAgent.id);

  const ambiguous = await createProfile(fixture, {
    name: "Ambiguous repair slot",
    entries: minimalEntries(fixture),
    mergeTailRepairAgentId: fixture.repairAgent.id,
  });
  assert.equal(ambiguous.status, 422, JSON.stringify(ambiguous.body));
  assert.equal(ambiguous.body.code, "staffing_profile_repo_required");

  const explicit = await createProfile(fixture, {
    name: "Explicit repair slot",
    entries: minimalEntries(fixture),
    mergeTailRepairAgentId: fixture.repairAgent.id,
    repoId: secondRepo.id,
  });
  assert.equal(explicit.status, 201, JSON.stringify(explicit.body));

  const noGrant = await db.agent.create({
    data: {
      projectId: fixture.project.id,
      environmentId: (await db.environment.findFirstOrThrow({ where: { projectId: fixture.project.id } })).id,
      name: "ungranted-repair-agent",
      title: "Ungranted repair Agent",
      model: "gpt-5.6-luna:max",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const missingGrant = await createProfile(fixture, {
    name: "Missing repair grant",
    entries: minimalEntries(fixture),
    mergeTailRepairAgentId: noGrant.id,
    repoId: fixture.repo.id,
  });
  assert.equal(missingGrant.status, 422, JSON.stringify(missingGrant.body));
  assert.equal(missingGrant.body.code, "staffing_profile_missing_repo_grant");

  const foreign = await call("PUT", `/staffing-profiles/${created.body.profile.id}`, {
    name: "Repair slot foreign refusal",
    entries: minimalEntries(fixture),
    mergeTailRepairAgentId: fixture.foreignAgent.id,
    repoId: fixture.repo.id,
  });
  assert.equal(foreign.status, 422, JSON.stringify(foreign.body));
  assert.equal(foreign.body.code, "staffing_profile_agent_not_found");

  const archived = await call("PUT", `/staffing-profiles/${created.body.profile.id}`, {
    name: "Repair slot archived refusal",
    entries: minimalEntries(fixture),
    mergeTailRepairAgentId: fixture.archivedAgent.id,
    repoId: fixture.repo.id,
  });
  assert.equal(archived.status, 422, JSON.stringify(archived.body));
  assert.equal(archived.body.code, "staffing_profile_agent_archived");

  await db.agentRepoAccess.create({ data: {
    projectId: fixture.project.id, agentId: fixture.integrator.id, repoId: fixture.repo.id,
    mountPath: "/repo", permissions: "GIT_WRITE",
  } });
  const beforeSentinel = await db.staffingProfile.findUniqueOrThrow({
    where: { id: created.body.profile.id }, include: { entries: true },
  });
  const sentinel = await call("PUT", `/staffing-profiles/${created.body.profile.id}`, {
    name: "Invalid sentinel slot", entries: [], mergeTailRepairAgentId: fixture.integrator.id,
    repoId: fixture.repo.id,
  });
  assert.equal(sentinel.status, 422, JSON.stringify(sentinel.body));
  assert.equal(sentinel.body.code, "staffing_profile_integrator_binding");
  assert.deepEqual(await db.staffingProfile.findUniqueOrThrow({
    where: { id: created.body.profile.id }, include: { entries: true },
  }), beforeSentinel);

  await db.agent.update({ where: { id: fixture.repairAgent.id }, data: { archivedAt: new Date() } });
  const preservedArchived = await call("PUT", `/staffing-profiles/${created.body.profile.id}`, {
    name: "Archived slot preserved", entries: minimalEntries(fixture),
  });
  assert.equal(preservedArchived.status, 200, JSON.stringify(preservedArchived.body));
  assert.equal(preservedArchived.body.profile.mergeTailRepairAgentId, fixture.repairAgent.id);

  const cleared = await call("PUT", `/staffing-profiles/${created.body.profile.id}`, {
    name: "Repair slot cleared",
    entries: minimalEntries(fixture),
    mergeTailRepairAgentId: null,
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.profile.mergeTailRepairAgentId, null);
});

test("reset restores the canonical Luna repair slot and warns for unavailable defaults", async () => {
  const fixture = await seed(INTEGRATOR_TEMPLATE_NAME);
  const created = await createProfile(fixture, {
    name: "Reset repair slot",
    entries: minimalEntries(fixture),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.profile.mergeTailRepairAgentId, null);

  // An empty reset body remains compatible when the project has one Repo.
  const resetPath = `/staffing-profiles/${created.body.profile.id}/reset`;
  const reset = await call("POST", resetPath);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.profile.mergeTailRepairAgentId, fixture.repairAgent.id);

  await db.repo.create({ data: {
    projectId: fixture.project.id, name: "second-reset-repo", remoteUrl: "https://example.test/second.git",
    mountPath: "/second", dependencyProvisioning: "NONE",
  } });
  const ambiguousReset = await call("POST", resetPath);
  assert.equal(ambiguousReset.status, 200, JSON.stringify(ambiguousReset.body));
  assert.equal(ambiguousReset.body.profile.mergeTailRepairAgentId, fixture.repairAgent.id);
  assert.ok(ambiguousReset.body.warnings.some((warning: { code: string }) => warning.code === "merge_tail_repair_repo_unresolved"));

  await db.taskTemplateStep.updateMany({
    where: { taskTemplateId: fixture.template.id, outputKind: "implementation" },
    data: { assigneeAgentId: fixture.repairAgent.id },
  });
  await db.agent.update({ where: { id: fixture.repairAgent.id }, data: { archivedAt: new Date() } });
  const archivedReset = await call("POST", resetPath, { repoId: fixture.repo.id });
  assert.equal(archivedReset.status, 200, JSON.stringify(archivedReset.body));
  assert.equal(archivedReset.body.profile.mergeTailRepairAgentId, null);
  assert.ok(archivedReset.body.warnings.some((warning: { code: string }) => warning.code === "merge_tail_repair_agent_unavailable"));
  assert.equal(archivedReset.body.profile.entries.find(
    (entry: { outputKind: string }) => entry.outputKind === "implementation",
  ).assigneeAgentId, null);
  const implementationStep = await db.taskTemplateStep.findFirstOrThrow({
    where: { taskTemplateId: fixture.template.id, outputKind: "implementation" },
  });
  assert.equal(implementationStep.assigneeAgentId, fixture.repairAgent.id);
  // Restore a valid binding before testing the separate missing-slot case.
  await db.taskTemplateStep.update({
    where: { id: implementationStep.id }, data: { assigneeAgentId: fixture.implementer.id },
  });
  await db.agent.update({ where: { id: fixture.repairAgent.id },
    data: { name: "former-repair-agent", canonicalRole: null } });
  await db.agent.update({ where: { id: fixture.archivedAgent.id }, data: { name: "former-legacy-repair-agent" } });
  const missingReset = await call("POST", resetPath);
  assert.equal(missingReset.status, 200, JSON.stringify(missingReset.body));
  assert.equal(missingReset.body.profile.mergeTailRepairAgentId, null);
  assert.ok(missingReset.body.warnings.some((warning: { code: string }) => warning.code === "merge_tail_repair_agent_unavailable"));
});

test("copying profiles preserves the merge-tail repair slot", async () => {
  const fixture = await seed();
  const source = await createProfile(fixture, {
    name: "Copied repair slot",
    entries: minimalEntries(fixture),
    mergeTailRepairAgentId: fixture.repairAgent.id,
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));

  const target = await db.taskTemplate.create({
    data: {
      projectId: fixture.project.id,
      name: "copied-workflow",
      description: "copy target",
      variables: [],
    },
  });
  await db.$transaction((tx) => copyStaffingProfiles(tx, {
    projectId: fixture.project.id,
    fromTaskTemplateId: fixture.template.id,
    toTaskTemplateId: target.id,
  }));

  const copied = await call(
    "GET",
    `/projects/${fixture.project.id}/task-templates/${target.id}/staffing-profiles`,
  );
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  assert.equal(copied.body[0].mergeTailRepairAgentId, fixture.repairAgent.id);
});
