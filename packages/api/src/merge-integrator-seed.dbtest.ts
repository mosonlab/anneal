/**
 * Step 7 / SF-3 — the seeded twelve-step template, and the verifier that guards it.
 *
 * The prior plan left this as "edit the seed wherever it is" and relied on
 * `verify-agent-template.ts` to catch a mistake. That is circular: the verifier
 * is code in the same change, and a verifier that never checked
 * `opensPullRequest` would pass a seed that never set it. So the fresh-seed
 * assertion below reads the seeded row **directly**, and only then is the
 * verifier's verdict relied on for anything.
 *
 * Both the seed and the verifier are top-level scripts with their own Prisma
 * client, so they run here as child processes against this suite's scratch
 * schema — which is also the only way to test them as an operator invokes them.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  activateChainSuccessor,
  AssigneeType,
  DependencyProvisioning,
  DIRECT_TEMPLATE_NAME,
  executionModeFor,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  PR_TEMPLATE_NAME,
  LEGACY_TEMPLATE_GENERATIONS,
  templatePromptGenerationDigest,
  legacyNineStepTemplateName,
  legacyAdjudicationTemplateName,
  legacyTenStepTemplateName,
  loadAgentSources,
  loadTemplateStepSources,
  PrismaClient,
  RunnerPreference,
  type Task,
  TaskStatus,
} from "@anneal/db";

import { PROJECT_BOOTSTRAP_ROLE_NAMES } from "./project-bootstrap.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

const execFileAsync = promisify(execFile);

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const DB_DIRECTORY = fileURLToPath(new URL("../../db", import.meta.url));

const retiredReviewOutputKind = LEGACY_TEMPLATE_GENERATIONS[DIRECT_TEMPLATE_NAME]
  .find(({ marker }) => marker === "pre-model-neutral-review-output")?.shape
  .find(({ name }) => name === "Code review")?.outputKind;
if (!retiredReviewOutputKind) throw new Error("the pre-model-neutral generation must define a review output kind");

const runScript = async (script: string): Promise<{ code: number; output: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath, ["--import", "tsx", `prisma/${script}`],
      { cwd: DB_DIRECTORY, env: { ...process.env, DATABASE_URL: testDatabaseUrl }, maxBuffer: 8 * 1024 * 1024 },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error: any) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}` };
  }
};

const seed = () => runScript("seed.ts");
const sync = () => runScript("sync-canonical-prompts.ts");
const verify = () => runScript("verify-agent-template.ts");

const integratorStep = async () => db.taskTemplateStep.findFirstOrThrow({
  where: { stepIndex: INTEGRATOR_STEP_INDEX, taskTemplate: { name: INTEGRATOR_TEMPLATE_NAME } },
  include: { assigneeAgent: true, taskTemplate: { include: { steps: true } } },
});

const directTemplate = async () => db.taskTemplate.findUniqueOrThrow({
  where: { projectId_name: { projectId: (await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } })).id, name: DIRECT_TEMPLATE_NAME } },
  include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
});

/** Build the shape POST /projects creates without exercising the HTTP route. */
const createA1Project = async (slug: string) => {
  const [canonicalProject, sources] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } }),
    loadAgentSources(),
  ]);
  const canonicalTemplate = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonicalProject.id, name: PR_TEMPLATE_NAME } },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  const rolesByName = new Map(sources.roles.map((role) => [role.name, role]));
  const project = await db.project.create({
    data: { name: "A1-shaped Project", slug, yamlDocument: "# A1-shaped fixture\n" },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", networking: "OPEN", allowedHosts: [] },
  });
  const agents = new Map<string, { id: string }>();
  for (const name of PROJECT_BOOTSTRAP_ROLE_NAMES) {
    const role = rolesByName.get(name);
    assert.ok(role, `A1 fixture role source must contain ${name}`);
    const agent = await db.agent.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        name: role.name,
        title: role.title,
        model: role.model,
        runnerPreference: role.runnerPreference,
        inboxAccess: role.inboxAccess,
        foundationalPrompt: sources.foundationalPrompt,
        rolePrompt: role.rolePrompt,
        customizedFields: [],
        runtimeConfigDriftNoticeFingerprint: null,
        disabledTools: [],
      },
      select: { id: true },
    });
    agents.set(name, agent);
  }
  for (const name of PROJECT_BOOTSTRAP_ROLE_NAMES) {
    const role = rolesByName.get(name)!;
    for (const collaboratorName of role.collaborators) {
      const collaborator = agents.get(collaboratorName);
      assert.ok(collaborator, `A1 fixture collaborator ${collaboratorName} must be in the bootstrap role set`);
      await db.agentCollaboration.create({
        data: { agentId: agents.get(name)!.id, allowedAgentId: collaborator.id, projectId: project.id },
      });
    }
  }
  const template = await db.taskTemplate.create({
    data: {
      projectId: project.id,
      name: canonicalTemplate.name,
      description: canonicalTemplate.description,
      variables: canonicalTemplate.variables,
    },
  });
  for (const step of canonicalTemplate.steps) {
    const assignee = step.assigneeAgent ? agents.get(step.assigneeAgent.name) : null;
    if (step.assigneeAgent) assert.ok(assignee, `A1 fixture is missing ${step.assigneeAgent.name}`);
    await db.taskTemplateStep.create({
      data: {
        taskTemplateId: template.id,
        assigneeAgentId: assignee?.id ?? null,
        stepIndex: step.stepIndex,
        name: step.name,
        assigneeType: step.assigneeType,
        prompt: step.prompt,
        approvalGate: step.approvalGate,
        optional: step.optional,
        attachmentsFromPrevious: step.attachmentsFromPrevious,
        priorOutputKinds: step.priorOutputKinds,
        ...(step.spawnPolicy === null ? {} : { spawnPolicy: step.spawnPolicy }),
        runner: step.runner,
        outputKind: step.outputKind,
        opensPullRequest: step.opensPullRequest,
        requiresCommit: step.requiresCommit,
        baseFromStepIndex: step.baseFromStepIndex,
        layer: step.layer,
      },
    });
  }
  return { project, environment, agents };
};

const agentSnapshot = async (projectIds: string[]) => db.agent.findMany({
  where: { projectId: { in: projectIds } },
  select: {
    id: true,
    projectId: true,
    environmentId: true,
    name: true,
    title: true,
    model: true,
    customizedFields: true,
    runtimeConfigDriftNoticeFingerprint: true,
    codexServiceTier: true,
    foundationalPrompt: true,
    rolePrompt: true,
    runnerPreference: true,
    inboxAccess: true,
    disabledTools: true,
    archivedAt: true,
  },
  orderBy: [{ projectId: "asc" }, { name: "asc" }],
});

/* ------------------------------------------------------ the fresh-seed negative */

/** Every registered legacy generation still bound its review-fix step to
 * senior-dev-astra-medium; a fixture that rebuilds one from current rows restores that. */
const rebindFixStepToRetiredSeniorDev = async (projectId: string, templateId: string): Promise<void> => {
  const seniorDev = await db.agent.findUniqueOrThrow({ where: { projectId_name: { projectId, name: "senior-dev-astra-medium" } } });
  await db.taskTemplateStep.updateMany({
    where: { taskTemplateId: templateId, outputKind: "fixed-implementation" },
    data: { assigneeAgentId: seniorDev.id },
  });
};

/** Rebuild the pre-model-neutral shape that the retired registry identifies. */
const restoreRetiredReviewContract = async (templateId: string): Promise<void> => {
  const steps = await db.taskTemplateStep.findMany({ where: { taskTemplateId: templateId } });
  for (const step of steps) {
    await db.taskTemplateStep.update({ where: { id: step.id }, data: {
      outputKind: step.outputKind === "review-findings" ? retiredReviewOutputKind : step.outputKind,
      priorOutputKinds: step.priorOutputKinds.map((kind) => kind === "review-findings" ? retiredReviewOutputKind : kind),
      prompt: step.prompt.replaceAll("review-findings", retiredReviewOutputKind).replaceAll("the code review report", "the Sol report"),
    } });
  }
  await Promise.all([
    db.taskTemplateStep.updateMany({
      where: { taskTemplateId: templateId, outputKind: retiredReviewOutputKind },
      data: { name: "Code review (Sol)" },
    }),
    db.taskTemplateStep.updateMany({
      where: { taskTemplateId: templateId, outputKind: "blind-findings" },
      data: { name: "Code review (Opus blind)" },
    }),
  ]);
};

test("a fresh seed writes the twelve-step, eight-step, and four-step canonical templates", async () => {
  const seeded = await seed();
  assert.equal(seeded.code, 0, seeded.output);

  // Read directly. Not through the verifier, not through the contract module —
  // this is the assertion the verifier's own correctness is allowed to rest on.
  const step = await integratorStep();
  assert.equal(step.taskTemplate.steps.length, 12, "the template has twelve steps");
  assert.equal(step.opensPullRequest, false, "SF-3: the seeded integrator row must not open a pull request");
  assert.equal(step.requiresCommit, false, "the mechanical integrator must not require a workspace commit");
  assert.equal(step.approvalGate, false);
  assert.equal(step.outputKind, INTEGRATOR_OUTPUT_KIND);
  assert.equal(step.assigneeAgent?.name, INTEGRATOR_AGENT_NAME);
  assert.equal(step.assigneeAgent?.model, INTEGRATOR_SENTINEL_MODEL);
  assert.equal(step.spawnPolicy, null);
  assert.equal(step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 7)?.attachmentsFromPrevious, false);
  assert.equal(step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 9)?.assigneeAgentId,
    (await db.agent.findFirstOrThrow({ where: { name: "librarian-luna-xhigh" } })).id);
  assert.equal(step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 10)?.attachmentsFromPrevious, true);
  assert.match(step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 10)?.prompt ?? "", /\$\{AGENTOS_TOOLS:\?AGENTOS_TOOLS is required\}\/regression-verification\.sh" prepare/u);
  assert.match(step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 10)?.prompt ?? "", /head[\s\S]*and baseline frozen by prepare/u);
  // The fix step reads both reports itself; no node authors must-fix any more.
  assert.equal(step.taskTemplate.steps.some((candidate) => candidate.outputKind === "must-fix"), false);
  assert.match(
    step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 8)?.prompt ?? "",
    /Read the immutable `review-findings` review output and, when present, the immutable `blind-findings` output/u,
  );
  assert.match(
    step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 3)?.prompt ?? "",
    /vertical slice[\s\S]*blocked_by[\s\S]*expand–contract staging[\s\S]*fail at base/iu,
  );

  const opening = step.taskTemplate.steps.filter((candidate) => candidate.opensPullRequest).map((candidate) => candidate.stepIndex);
  assert.deepEqual(opening, [5], "only implementation opens the chain pull request");
  assert.deepEqual(
    step.taskTemplate.steps.filter((candidate) => candidate.requiresCommit).map((candidate) => candidate.stepIndex),
    [2, 5],
    "only plan and implementation require a workspace commit",
  );

  const direct = await directTemplate();
  assert.equal(direct.steps.length, 8);
  assert.equal(direct.steps[0]?.assigneeAgent?.name, "spec-revalidator-luna-xhigh");
  assert.equal(direct.steps[0]?.opensPullRequest, false);
  assert.equal(direct.steps[0]?.requiresCommit, false);
  assert.equal(direct.steps[0]?.outputKind, "revalidation");
  assert.equal(direct.steps[1]?.assigneeAgent?.name, "senior-dev-luna-max");
  assert.equal(direct.steps[1]?.opensPullRequest, true);
  assert.equal(direct.steps[1]?.requiresCommit, true);
  assert.match(direct.steps[1]?.prompt ?? "", /brief is the specification of record/u);
  assert.equal(direct.steps[3]?.attachmentsFromPrevious, false);
  assert.equal(direct.steps[6]?.assigneeType, AssigneeType.AGENT);
  assert.equal(direct.steps[6]?.approvalGate, false);
  assert.equal(direct.steps[6]?.outputKind, "merge-authorization");
  assert.equal(direct.steps[7]?.assigneeAgent?.name, INTEGRATOR_AGENT_NAME);
  assert.equal(direct.steps[7]?.outputKind, INTEGRATOR_OUTPUT_KIND);
  assert.match(direct.steps[5]?.prompt ?? "", /\$\{AGENTOS_TOOLS:\?AGENTOS_TOOLS is required\}\/regression-verification\.sh" finalize/u);
  const resolver = await db.agent.findFirstOrThrow({ where: { projectId: step.taskTemplate.projectId, name: "merge-resolver-luna-max" } });
  assert.equal(resolver.model, "gpt-5.6-luna:max");
  assert.equal(resolver.runnerPreference, "CODEX");

  const pullRequest = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: step.taskTemplate.projectId, name: PR_TEMPLATE_NAME } },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  assert.equal(pullRequest.steps.length, 4);
  assert.deepEqual(pullRequest.steps.map(({ name }) => name), [
    "Implementation", "Code review", "Blind code review", "Apply review fixes",
  ]);
  assert.deepEqual(pullRequest.steps.map(({ assigneeAgent }) => assigneeAgent?.name), [
    "senior-dev-luna-max", "code-reviewer-sol-high", "code-reviewer-opus-medium", "senior-dev-astra-low",
  ]);
  assert.deepEqual(pullRequest.steps.map(({ opensPullRequest }) => opensPullRequest), [true, false, false, false]);
  assert.deepEqual(pullRequest.steps.map(({ requiresCommit }) => requiresCommit), [true, false, false, false]);
  assert.equal(pullRequest.steps.at(-1)?.outputKind, "fixed-implementation");
});

test("the verifier passes on a freshly seeded database, and says how many steps it saw", async () => {
  assert.equal((await seed()).code, 0);
  const verified = await verify();
  assert.equal(verified.code, 0, verified.output);
  assert.match(verified.output, /24 steps across 3 templates/u);
});

test("re-seeding is idempotent and does not flip the integrator step back", async () => {
  assert.equal((await seed()).code, 0);
  assert.equal((await seed()).code, 0);
  const step = await integratorStep();
  assert.equal(step.opensPullRequest, false, "the update branch of the upsert sets it too, not only create");
  assert.equal(step.requiresCommit, false, "the update branch of the upsert restores the commit contract too");
  assert.equal(step.taskTemplate.steps.length, 12);
});

test("re-seeding preserves an operator-selected model and runner", async () => {
  assert.equal((await seed()).code, 0);
  const project = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  await db.agent.update({
    where: { projectId_name: { projectId: project.id, name: "spec-opus-high" } },
    data: { model: "claude-opus-5:medium", runnerPreference: "CLAUDE", customizedFields: ["model", "runnerPreference"] },
  });

  const reseeded = await seed();
  assert.equal(reseeded.code, 0, reseeded.output);
  const spec = await db.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "spec-opus-high" } },
    select: { model: true, runnerPreference: true, customizedFields: true },
  });
  assert.deepEqual(spec, { model: "claude-opus-5:medium", runnerPreference: "CLAUDE", customizedFields: ["model", "runnerPreference"] });
});

test("canonical sync restores step, merge-resolver-luna-max role, and foundational prompts when structure matches", async () => {
  assert.equal((await seed()).code, 0);
  const direct = await directTemplate();
  const step = direct.steps[0]!;
  const agent = await db.agent.findFirstOrThrow({ where: { name: "merge-resolver-luna-max" } });
  await Promise.all([
    db.taskTemplateStep.update({ where: { id: step.id }, data: { prompt: "step prompt drift" } }),
    db.agent.update({ where: { id: agent.id }, data: { foundationalPrompt: "foundation drift", rolePrompt: "role drift" } }),
  ]);

  const synced = await sync();
  assert.equal(synced.code, 0, synced.output);
  const expectedStep = (await loadTemplateStepSources(DIRECT_TEMPLATE_NAME))[0]!;
  const sources = await loadAgentSources();
  const expectedRole = sources.roles.find(({ name }) => name === "merge-resolver-luna-max")!;
  const [persistedStep, persistedAgent] = await Promise.all([
    db.taskTemplateStep.findUniqueOrThrow({ where: { id: step.id } }),
    db.agent.findUniqueOrThrow({ where: { id: agent.id } }),
  ]);
  assert.equal(persistedStep.prompt, expectedStep.prompt);
  assert.equal(persistedAgent.foundationalPrompt, sources.foundationalPrompt);
  assert.equal(persistedAgent.rolePrompt, expectedRole.rolePrompt);
});

test("canonical sync installs the reviewed PR prompt generation while instantiated chains stay pinned", async () => {
  assert.equal((await seed()).code, 0);
  const project = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const template = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: PR_TEMPLATE_NAME } },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  const fixed = template.steps.find(({ outputKind }) => outputKind === "fixed-implementation")!;
  // This deployed generation predates the salvage-resume exception as well as
  // the HEAD-tree cleanup check; reconstruct its exact authenticated prompt.
  const reviewedPrompt = fixed.prompt.replace(
    " If that HEAD is a `WIP salvage` commit of a prior Run of this same task and its parent is the reviewed head, the salvaged changes are your own failed attempt's in-progress fixes: validate them against the reports, continue on top of them, and record the reviewed head — the salvage commit's parent — as `sourceHead`. Every other reviewed-head mismatch remains a stop.",
    "",
  ).replace(
    "git ls-tree -r --name-only HEAD -- .chain",
    "git ls-files -- .chain",
  );
  assert.notEqual(reviewedPrompt, fixed.prompt);
  await db.taskTemplateStep.updateMany({
    where: { taskTemplateId: template.id },
    data: { provisionDependencies: true },
  });
  await db.taskTemplateStep.update({ where: { id: fixed.id }, data: { prompt: reviewedPrompt } });
  await rebindFixStepToRetiredSeniorDev(project.id, template.id);
  await restoreRetiredReviewContract(template.id);
  const reviewedSteps = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: template.id },
    include: { assigneeAgent: true },
    orderBy: { stepIndex: "asc" },
  });
  assert.equal(
    templatePromptGenerationDigest(reviewedSteps),
    LEGACY_TEMPLATE_GENERATIONS[PR_TEMPLATE_NAME].find(({ marker }) => marker === "pre-pr-head-tree-check")!.promptDigest,
    "the fixture must reconstruct the published reviewed PR generation",
  );
  const chainId = "pinned-pr-chain";
  const tasks = await Promise.all(reviewedSteps.map((step) => db.task.create({ data: {
    projectId: project.id,
    templateId: template.id,
    templateStepId: step.id,
    name: `Pinned PR step ${String(step.stepIndex)}`,
    description: "pinned reviewed-generation prompt",
    assigneeType: step.assigneeType,
    assigneeAgentId: step.assigneeAgentId,
    status: TaskStatus.TODO,
    chainId,
    chainIndex: step.stepIndex,
    chainLayer: step.layer,
  } })));
  const snapshot = reviewedSteps.map((step) => ({
    id: step.id,
    prompt: step.prompt,
    name: step.name,
    layer: step.layer,
    outputKind: step.outputKind,
    attachmentsFromPrevious: step.attachmentsFromPrevious,
    opensPullRequest: step.opensPullRequest,
    requiresCommit: step.requiresCommit,
    baseFromStepIndex: step.baseFromStepIndex,
  }));

  const synced = await sync();
  assert.equal(synced.code, 0, synced.output);
  const [retired, successor, pinnedTasks, sources] = await Promise.all([
    db.taskTemplate.findUniqueOrThrow({
      where: { id: template.id },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    }),
    db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: PR_TEMPLATE_NAME } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    }),
    db.task.findMany({
      where: { id: { in: tasks.map(({ id }) => id) } },
      include: { templateStep: true },
      orderBy: { chainIndex: "asc" },
    }),
    loadTemplateStepSources(PR_TEMPLATE_NAME),
  ]);
  assert.match(retired.name, /pre-pr-head-tree-check/u);
  assert.notEqual(successor.id, retired.id);
  assert.deepEqual(
    pinnedTasks.map(({ templateStep }) => templateStep?.id),
    snapshot.map(({ id }) => id),
  );
  assert.deepEqual(
    pinnedTasks.map(({ templateStep }) => templateStep?.prompt),
    snapshot.map(({ prompt }) => prompt),
  );
  assert.deepEqual(
    successor.steps.map((step) => ({
      name: step.name,
      layer: step.layer,
      outputKind: step.outputKind,
      attachmentsFromPrevious: step.attachmentsFromPrevious,
      opensPullRequest: step.opensPullRequest,
      requiresCommit: step.requiresCommit,
      baseFromStepIndex: step.baseFromStepIndex,
    })),
    sources.map((step) => ({
      name: step.name,
      layer: step.layer,
      outputKind: step.outputKind,
      attachmentsFromPrevious: step.attachmentsFromPrevious,
      opensPullRequest: step.opensPullRequest,
      requiresCommit: step.requiresCommit,
      baseFromStepIndex: step.baseFromStepIndex,
    })),
  );
  // Retired Chains retain exact output contracts as well as labels and prompts.
  assert.deepEqual(
    pinnedTasks.map(({ templateStep }) => templateStep?.outputKind),
    snapshot.map(({ outputKind }) => outputKind),
  );
  assert.deepEqual(
    pinnedTasks.map(({ templateStep }) => templateStep?.name),
    snapshot.map(({ name }) => name),
  );
  assert.deepEqual(
    snapshot.map(({ id: _id, prompt: _prompt, name: _name, ...shape }) => ({
      ...shape,
      outputKind: shape.outputKind === retiredReviewOutputKind ? "review-findings" : shape.outputKind,
    })),
    successor.steps.map((step) => ({
      layer: step.layer,
      outputKind: step.outputKind,
      attachmentsFromPrevious: step.attachmentsFromPrevious,
      opensPullRequest: step.opensPullRequest,
      requiresCommit: step.requiresCommit,
      baseFromStepIndex: step.baseFromStepIndex,
    })),
  );
});

test("canonical sync rolls quiescent adjudication-era graphs only after active Runs settle", async () => {
  assert.equal((await seed()).code, 0);
  const direct = await directTemplate();
  const compound = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: direct.projectId, name: INTEGRATOR_TEMPLATE_NAME } },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });

  // Rebuild each canonical row as the graph production actually carries: an
  // adjudication node between the review layer and the fix, with every later
  // node one index and one layer further out. The review labels are restored
  // below because this fixture represents rows from before their rename.
  const oldTasks: Task[] = [];
  for (const template of [direct, compound]) {
    await db.taskTemplateStep.updateMany({
      where: { taskTemplateId: template.id },
      data: { provisionDependencies: true },
    });
    await restoreRetiredReviewContract(template.id);
    let historicalSteps = await db.taskTemplateStep.findMany({
      where: { taskTemplateId: template.id },
      include: { assigneeAgent: true },
      orderBy: { stepIndex: "asc" },
    });
    await db.taskTemplateStep.updateMany({
      where: { taskTemplateId: template.id },
      data: { optional: false },
    });
    if (template.name === DIRECT_TEMPLATE_NAME) {
      const revalidation = historicalSteps.find((step) => step.outputKind === "revalidation");
      assert.ok(revalidation);
      await db.taskTemplateStep.delete({ where: { id: revalidation.id } });
      for (const step of historicalSteps.filter((candidate) => candidate.id !== revalidation.id)) {
        await db.taskTemplateStep.update({
          where: { id: step.id },
          data: {
            stepIndex: step.stepIndex - 1,
            layer: (step.layer ?? 0) - 1,
            baseFromStepIndex: step.baseFromStepIndex === null ? null : step.baseFromStepIndex - 1,
          },
        });
      }
      historicalSteps = await db.taskTemplateStep.findMany({
        where: { taskTemplateId: template.id },
        include: { assigneeAgent: true },
        orderBy: { stepIndex: "asc" },
      });
    }
    await rebindFixStepToRetiredSeniorDev(template.projectId, template.id);
    const blind = historicalSteps.find((step) => step.outputKind === "blind-findings")!;
    // The adjudicator role is archived, so the seed no longer creates its
    // Agent row; production still carries the row the old node was bound to.
    const opus = await db.agent.findFirstOrThrow({
      where: { projectId: template.projectId, name: "code-reviewer-opus-medium" },
    });
    const adjudicator = await db.agent.upsert({
      where: { projectId_name: { projectId: template.projectId, name: "review-adjudicator-opus" } },
      update: {},
      create: {
        projectId: template.projectId,
        environmentId: opus.environmentId,
        name: "review-adjudicator-opus",
        title: "Review Adjudicator (Opus)",
        model: opus.model,
        foundationalPrompt: opus.foundationalPrompt,
        rolePrompt: opus.rolePrompt,
        runnerPreference: opus.runnerPreference,
      },
    });
    for (const step of [...historicalSteps].reverse()) {
      if (step.stepIndex <= blind.stepIndex) continue;
      await db.taskTemplateStep.update({
        where: { id: step.id },
        data: { stepIndex: step.stepIndex + 1, layer: (step.layer ?? 0) + 1 },
      });
    }
    const adjudication = await db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id,
      stepIndex: blind.stepIndex + 1,
      layer: (blind.layer ?? 0) + 1,
      name: "Opus adjudication",
      assigneeAgentId: adjudicator.id,
      assigneeType: AssigneeType.AGENT,
      approvalGate: false,
      outputKind: "must-fix",
      prompt: "Apply the canonical merge matrix to every finding from both reports.",
      opensPullRequest: false,
      requiresCommit: false,
      attachmentsFromPrevious: true,
      baseFromStepIndex: blind.baseFromStepIndex,
    } });
    await db.taskTemplateStep.updateMany({
      where: { taskTemplateId: template.id, outputKind: "regression-verification-v2" },
      data: { outputKind: "regression-verification" },
    });
    // The adjudication-era compound graph still gated its spec and revise-plan
    // steps; the zero-gate transition removed those gates from the seeded
    // sources, so the rebuild restores them to land on the exact enumerated
    // historical shape.
    if (template.name === INTEGRATOR_TEMPLATE_NAME) {
      await db.taskTemplateStep.updateMany({
        where: { taskTemplateId: template.id, stepIndex: { in: [1, 4] } },
        data: { approvalGate: true },
      });
    }
    oldTasks.push(await db.task.create({ data: {
      projectId: template.projectId,
      templateId: template.id,
      templateStepId: adjudication.id,
      name: `Adjudication on ${template.name}`,
      description: adjudication.prompt,
      assigneeType: adjudication.assigneeType,
      assigneeAgentId: adjudication.assigneeAgentId,
      status: TaskStatus.TODO,
      chainId: `pre-adjudication-${template.name}-${process.pid}`,
      chainIndex: adjudication.stepIndex,
      chainLayer: adjudication.layer,
    } }));
  }

  const activeRuns = await Promise.all(oldTasks.map(async (task) => {
    const agent = await db.agent.findUniqueOrThrow({ where: { id: task.assigneeAgentId! } });
    return db.run.create({ data: {
      projectId: task.projectId,
      taskId: task.id,
      agentId: agent.id,
      runNumber: 1,
      dedupeKey: `adjudication-active:${task.id}`,
      runner: "CODEX",
      model: agent.model,
      promptHash: "adjudication-active",
    } });
  }));
  const refused = await sync();
  assert.notEqual(refused.code, 0, refused.output);
  assert.match(refused.output, /still has 1 tasks with active Runs or no chain identity/u);
  assert.equal((await db.taskTemplate.findUniqueOrThrow({ where: { id: compound.id } })).name, INTEGRATOR_TEMPLATE_NAME);

  await db.run.deleteMany({ where: { id: { in: activeRuns.map(({ id }) => id) } } });
  const synced = await sync();
  assert.equal(synced.code, 0, synced.output);
  assert.match(synced.output, /"createdCanonicalTemplates":2/u);

  for (const oldTemplate of [direct, compound]) {
    const preserved = await db.taskTemplate.findUniqueOrThrow({
      where: { id: oldTemplate.id },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    // The old row keeps its step ids, so the quiescent tasks keep their contract.
    assert.equal(preserved.name, legacyAdjudicationTemplateName(oldTemplate.name, oldTemplate.id));
    assert.equal(preserved.steps.some((step) => step.outputKind === "must-fix"), true);

    const replacement = await db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: oldTemplate.projectId, name: oldTemplate.name } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.notEqual(replacement.id, oldTemplate.id);
    assert.equal(
      replacement.steps.length,
      oldTemplate.name === DIRECT_TEMPLATE_NAME ? preserved.steps.length : preserved.steps.length - 1,
    );
    assert.equal(replacement.steps.some((step) => step.outputKind === "must-fix"), false);
    assert.match(
      replacement.steps.find((step) => step.outputKind === "fixed-implementation")?.prompt ?? "",
      /Read the immutable `review-findings` review output and, when present, the immutable `blind-findings` output/u,
    );
  }
});

test("canonical sync refuses to mutate instantiated canonical steps", async () => {
  assert.equal((await seed()).code, 0);
  const direct = await directTemplate();
  const compound = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: direct.projectId, name: INTEGRATOR_TEMPLATE_NAME } },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  const regressionSteps = [
    direct.steps.find(({ outputKind }) => outputKind === "regression-verification-v2")!,
    compound.steps.find(({ outputKind }) => outputKind === "regression-verification-v2")!,
  ];
  const opus = await db.agent.findFirstOrThrow({
    where: { projectId: direct.projectId, name: "code-reviewer-opus-medium" },
  });
  await Promise.all(regressionSteps.map((step) => db.taskTemplateStep.update({
    where: { id: step.id }, data: { assigneeAgentId: opus.id, prompt: "previous release prompt" },
  })));
  const existingTasks = await Promise.all(regressionSteps.map((step, index) => db.task.create({ data: {
    projectId: direct.projectId,
    templateId: step.taskTemplateId,
    templateStepId: step.id,
    name: `Already instantiated regression ${index + 1}`,
    description: "legacy assignment",
    assigneeType: "AGENT",
    assigneeAgentId: opus.id,
    status: "TODO",
    chainId: `legacy-chain-${index + 1}`,
    chainIndex: step.stepIndex,
    chainLayer: step.layer,
  } })));

  const synced = await sync();
  assert.notEqual(synced.code, 0, synced.output);
  assert.match(synced.output, /referenced by instantiated tasks/u);
  const [adoptedSteps, migratedTasks] = await Promise.all([
    db.taskTemplateStep.findMany({ where: { id: { in: regressionSteps.map(({ id }) => id) } }, include: { assigneeAgent: true } }),
    db.task.findMany({ where: { id: { in: existingTasks.map(({ id }) => id) } }, include: { assigneeAgent: true } }),
  ]);
  assert.deepEqual(adoptedSteps.map(({ assigneeAgent }) => assigneeAgent?.name), ["code-reviewer-opus-medium", "code-reviewer-opus-medium"]);
  assert.deepEqual(migratedTasks.map(({ assigneeAgent }) => assigneeAgent?.name), ["code-reviewer-opus-medium", "code-reviewer-opus-medium"]);
});

test("canonical sync rejects template structure drift without applying its prompt", async () => {
  assert.equal((await seed()).code, 0);
  const direct = await directTemplate();
  const step = direct.steps[0]!;
  await db.taskTemplateStep.update({
    where: { id: step.id },
    data: { attachmentsFromPrevious: !step.attachmentsFromPrevious, prompt: "step prompt drift" },
  });

  const synced = await sync();
  assert.notEqual(synced.code, 0, synced.output);
  assert.match(synced.output, /attachmentsFromPrevious/u);
  assert.equal((await db.taskTemplateStep.findUniqueOrThrow({ where: { id: step.id } })).prompt, "step prompt drift");
});

test("canonical sync rejects role structure drift without applying its prompts", async () => {
  assert.equal((await seed()).code, 0);
  const agent = await db.agent.findFirstOrThrow({ where: { name: "librarian-luna-xhigh" } });
  await db.agent.update({
    where: { id: agent.id },
    data: { inboxAccess: !agent.inboxAccess, foundationalPrompt: "foundation drift", rolePrompt: "role drift" },
  });

  const synced = await sync();
  assert.notEqual(synced.code, 0, synced.output);
  assert.match(synced.output, /inboxAccess/u);
  const persisted = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
  assert.equal(persisted.foundationalPrompt, "foundation drift");
  assert.equal(persisted.rolePrompt, "role drift");
});

test("canonical sync restores Agent prompts in every Project and preserves customized runtime choices", async () => {
  assert.equal((await seed()).code, 0);
  const sources = await loadAgentSources();
  const canonicalProject = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const second = await createA1Project("custom");
  const sourceByName = new Map(sources.roles.map((role) => [role.name, role]));
  const canonicalDefault = await db.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonicalProject.id, name: "default" } },
  });
  const uncustomized = await db.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: second.project.id, name: "senior-dev-luna-max" } },
  });
  const customized = await db.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: second.project.id, name: "code-reviewer-sol-high" } },
  });
  const uncustomizedSource = sourceByName.get(uncustomized.name)!;
  const customizedSource = sourceByName.get(customized.name)!;

  await db.agent.update({
    where: { id: canonicalDefault.id },
    data: { foundationalPrompt: "canonical foundational prompt drift", rolePrompt: "canonical role prompt drift" },
  });
  await db.agent.update({
    where: { id: uncustomized.id },
    data: {
      model: "gpt-5.6-sol:medium",
      runnerPreference: RunnerPreference.CODEX,
      customizedFields: [],
      runtimeConfigDriftNoticeFingerprint: "stale-runtime-drift",
      foundationalPrompt: "second foundational prompt drift",
      rolePrompt: "second role prompt drift",
    },
  });
  await db.agent.update({
    where: { id: customized.id },
    data: {
      model: "claude-opus-5:medium",
      runnerPreference: RunnerPreference.CLAUDE,
      customizedFields: ["model", "runnerPreference"],
      runtimeConfigDriftNoticeFingerprint: null,
      foundationalPrompt: "custom foundational prompt drift",
      rolePrompt: "custom role prompt drift",
    },
  });

  const synced = await sync();
  assert.equal(synced.code, 0, synced.output);

  const [persistedCanonical, persistedUncustomized, persistedCustomized] = await Promise.all([
    db.agent.findUniqueOrThrow({ where: { id: canonicalDefault.id } }),
    db.agent.findUniqueOrThrow({ where: { id: uncustomized.id } }),
    db.agent.findUniqueOrThrow({ where: { id: customized.id } }),
  ]);
  assert.equal(persistedCanonical.foundationalPrompt, sources.foundationalPrompt);
  assert.equal(persistedCanonical.rolePrompt, sourceByName.get("default")!.rolePrompt);
  assert.deepEqual({
    foundationalPrompt: persistedUncustomized.foundationalPrompt,
    rolePrompt: persistedUncustomized.rolePrompt,
    model: persistedUncustomized.model,
    runnerPreference: persistedUncustomized.runnerPreference,
    customizedFields: persistedUncustomized.customizedFields,
    runtimeConfigDriftNoticeFingerprint: persistedUncustomized.runtimeConfigDriftNoticeFingerprint,
  }, {
    foundationalPrompt: sources.foundationalPrompt,
    rolePrompt: uncustomizedSource.rolePrompt,
    model: uncustomizedSource.model,
    runnerPreference: uncustomizedSource.runnerPreference,
    customizedFields: [],
    runtimeConfigDriftNoticeFingerprint: null,
  });
  assert.deepEqual({
    foundationalPrompt: persistedCustomized.foundationalPrompt,
    rolePrompt: persistedCustomized.rolePrompt,
    model: persistedCustomized.model,
    runnerPreference: persistedCustomized.runnerPreference,
    customizedFields: persistedCustomized.customizedFields,
    runtimeConfigDriftNoticeFingerprint: persistedCustomized.runtimeConfigDriftNoticeFingerprint,
  }, {
    foundationalPrompt: sources.foundationalPrompt,
    rolePrompt: customizedSource.rolePrompt,
    model: "claude-opus-5:medium",
    runnerPreference: RunnerPreference.CLAUDE,
    customizedFields: ["model", "runnerPreference"],
    runtimeConfigDriftNoticeFingerprint: JSON.stringify({
      canonical: { model: customizedSource.model, runnerPreference: customizedSource.runnerPreference },
      production: { model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE },
    }),
  });

  assert.deepEqual(
    (await db.agent.findMany({ where: { projectId: second.project.id }, select: { name: true }, orderBy: { name: "asc" } }))
      .map(({ name }) => name),
    [...PROJECT_BOOTSTRAP_ROLE_NAMES].sort(),
    "ordinary sync does not fill absent canonical roles in a noncanonical Project",
  );
});

test("canonical sync isolates foreign Agent structure drift and still updates canonical prompts", async () => {
  assert.equal((await seed()).code, 0);
  const canonicalProject = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const second = await createA1Project("custom");
  const canonical = await db.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonicalProject.id, name: "default" } },
  });
  const foreign = await db.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: second.project.id, name: "senior-dev-luna-max" } },
  });
  await db.agent.update({ where: { id: canonical.id }, data: { rolePrompt: "canonical role prompt drift" } });
  await db.agent.update({
    where: { id: foreign.id },
    data: { inboxAccess: !foreign.inboxAccess },
  });
  const foreignBefore = await agentSnapshot([second.project.id]);
  const canonicalSource = (await loadAgentSources()).roles.find(({ name }) => name === canonical.name);
  assert.ok(canonicalSource);

  const refused = await sync();
  assert.equal(refused.code, 0, refused.output);
  assert.match(refused.output, /^SYNCED agentos-example:/mu);
  assert.match(refused.output, /^REFUSED custom:/mu);
  assert.match(refused.output, new RegExp(`Agent ${foreign.name} \\(${foreign.id}\\)`, "u"));
  assert.equal(
    (await db.agent.findUniqueOrThrow({ where: { id: canonical.id } })).rolePrompt,
    canonicalSource.rolePrompt,
  );
  assert.deepEqual(await agentSnapshot([second.project.id]), foreignBefore);
});

test("canonical sync isolates a foreign invalid runtime pair and still updates canonical prompts", async () => {
  assert.equal((await seed()).code, 0);
  const canonicalProject = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const second = await createA1Project("custom");
  const canonical = await db.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonicalProject.id, name: "default" } },
  });
  const foreign = await db.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: second.project.id, name: "senior-dev-luna-max" } },
  });
  await db.agent.update({ where: { id: canonical.id }, data: { rolePrompt: "canonical role prompt drift" } });
  await db.agent.update({
    where: { id: foreign.id },
    data: {
      model: "claude-opus-5:medium",
      runnerPreference: RunnerPreference.CODEX,
      customizedFields: [],
    },
  });
  const foreignBefore = await agentSnapshot([second.project.id]);
  const canonicalSource = (await loadAgentSources()).roles.find(({ name }) => name === canonical.name);
  assert.ok(canonicalSource);

  const refused = await sync();
  assert.equal(refused.code, 0, refused.output);
  assert.match(refused.output, /^SYNCED agentos-example:/mu);
  assert.match(refused.output, /^REFUSED custom:/mu);
  assert.match(refused.output, new RegExp(`Agent ${foreign.name} \\(${foreign.id}\\)`, "u"));
  assert.equal(
    (await db.agent.findUniqueOrThrow({ where: { id: canonical.id } })).rolePrompt,
    canonicalSource.rolePrompt,
  );
  assert.deepEqual(await agentSnapshot([second.project.id]), foreignBefore);
});

/* ------------------------------------------------------- the verifier negatives */

/** Each of these is a way the contract could be violated in the database while
 *  the source still looks right. A verifier that passes any of them is not a
 *  verifier. */
const negatives: Array<{ name: string; break: () => Promise<void>; expect: RegExp }> = [
  {
    name: "the integrator step opening a pull request",
    break: async () => {
      const step = await integratorStep();
      await db.taskTemplateStep.update({ where: { id: step.id }, data: { opensPullRequest: true } });
    },
    expect: /opensPullRequest/u,
  },
  {
    name: "the integrator step requiring a workspace commit",
    break: async () => {
      const step = await integratorStep();
      await db.taskTemplateStep.update({ where: { id: step.id }, data: { requiresCommit: true } });
    },
    expect: /requiresCommit/u,
  },
  {
    name: "an LLM model on the integrator agent",
    break: async () => {
      await db.agent.updateMany({ where: { name: INTEGRATOR_AGENT_NAME }, data: { model: "claude-opus-5:high" } });
    },
    expect: /model|runner/iu,
  },
  {
    name: "a non-null spawn policy on the integrator step",
    break: async () => {
      const step = await integratorStep();
      await db.taskTemplateStep.update({ where: { id: step.id }, data: { spawnPolicy: { maxChildren: 1 } } });
    },
    expect: /spawnPolicy/u,
  },
  {
    name: "a template one step short",
    break: async () => {
      const step = await integratorStep();
      await db.taskTemplateStep.delete({ where: { id: step.id } });
    },
    expect: /step/iu,
  },
  {
    name: "one step too many",
    break: async () => {
      const step = await integratorStep();
      await db.taskTemplateStep.create({ data: {
        taskTemplateId: step.taskTemplateId, stepIndex: INTEGRATOR_STEP_INDEX + 1, layer: INTEGRATOR_STEP_INDEX + 1, name: "Extra",
        assigneeType: step.assigneeType, assigneeAgentId: step.assigneeAgentId, prompt: "extra",
        approvalGate: false, outputKind: "notes", opensPullRequest: true,
      } });
    },
    expect: /step/iu,
  },
  {
    name: "an upstream attachment on blind-review step 7",
    break: async () => {
      const step = await integratorStep();
      const blind = step.taskTemplate.steps.find((candidate) => candidate.stepIndex === 7)!;
      await db.taskTemplateStep.update({ where: { id: blind.id }, data: { attachmentsFromPrevious: true } });
    },
    expect: /attachmentsFromPrevious/u,
  },
  {
    name: "role frontmatter drift",
    break: async () => {
      const agent = await db.agent.findFirstOrThrow({ where: { name: "librarian-luna-xhigh" } });
      await db.agent.update({ where: { id: agent.id }, data: { inboxAccess: !agent.inboxAccess } });
    },
    expect: /inboxAccess/u,
  },
  {
    name: "foundational prompt drift",
    break: async () => {
      await db.agent.updateMany({ where: { name: "librarian-luna-xhigh" }, data: { foundationalPrompt: "drift" } });
    },
    expect: /foundational prompt/u,
  },
  {
    name: "role prompt drift",
    break: async () => {
      await db.agent.updateMany({ where: { name: "librarian-luna-xhigh" }, data: { rolePrompt: "drift" } });
    },
    expect: /role prompt/u,
  },
];

for (const negative of negatives) {
  test(`the verifier fails on ${negative.name}`, async () => {
    assert.equal((await seed()).code, 0);
    assert.equal((await verify()).code, 0, "the verifier passes before the contract is broken");
    await negative.break();
    const broken = await verify();
    assert.notEqual(broken.code, 0, `the verifier passed with ${negative.name}: ${broken.output}`);
    assert.match(broken.output, negative.expect);
  });
}

/* -------------------------------------------- 10 -> 12: in-flight continuation */

test("re-seeding a historical ten-step template preserves and queues its in-flight integrator", async () => {
  assert.equal((await seed()).code, 0);
  const fresh = await integratorStep();
  const templateId = fresh.taskTemplateId;
  const projectId = fresh.taskTemplate.projectId;
  const agents = new Map((await db.agent.findMany({ where: { projectId } })).map((agent) => [agent.name, agent]));

  // Reconstruct the historical 10-row shape exactly where the routing changed:
  // review, fix, docs, human approval, then physical step-10 mechanical merge.
  await db.taskTemplateStep.deleteMany({ where: { taskTemplateId: templateId, stepIndex: { in: [11, 12] } } });
  const historicalTail = [
    [6, "review-coordinator-astra-medium", AssigneeType.AGENT, "code-review"],
    [7, "senior-dev-astra-medium", AssigneeType.AGENT, "fixed-implementation"],
    [8, "librarian-luna-xhigh", AssigneeType.AGENT, "documentation"],
    [9, null, AssigneeType.HUMAN, "approval"],
    [10, INTEGRATOR_AGENT_NAME, AssigneeType.AGENT, INTEGRATOR_OUTPUT_KIND],
  ] as const;
  for (const [stepIndex, agentName, assigneeType, outputKind] of historicalTail) {
    const assigneeAgentId = agentName ? agents.get(agentName)!.id : null;
    await db.taskTemplateStep.update({
      where: { taskTemplateId_stepIndex: { taskTemplateId: templateId, stepIndex } },
      data: {
        name: `Historical step ${stepIndex}`,
        assigneeType,
        assigneeAgentId,
        approvalGate: stepIndex === 9,
        outputKind,
        opensPullRequest: false,
      },
    });
  }
  const historicalSteps = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: templateId }, orderBy: { stepIndex: "asc" },
  });
  assert.equal(historicalSteps.length, 10);

  const repo = await db.repo.create({ data: {
    projectId, name: "legacy-upgrade", remoteUrl: "https://github.com/acme/legacy-upgrade.git",
    mountPath: "/scratch/legacy-upgrade", defaultBranch: "main", dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  const integratorAgent = agents.get(INTEGRATOR_AGENT_NAME)!;
  await db.agentRepoAccess.create({ data: {
    projectId, agentId: integratorAgent.id, repoId: repo.id,
    mountPath: "/scratch/legacy-upgrade", permissions: "GIT_WRITE",
  } });

  const chainId = `in-flight-ten-${process.pid}`;
  const tasks: Task[] = [];
  for (const templateStep of historicalSteps) {
    tasks.push(await db.task.create({ data: {
      projectId, repoId: repo.id, templateId, templateStepId: templateStep.id,
      name: templateStep.name, description: templateStep.prompt,
      assigneeType: templateStep.assigneeType, assigneeAgentId: templateStep.assigneeAgentId,
      approvalGate: templateStep.approvalGate, opensPullRequest: templateStep.opensPullRequest,
      chainId, chainIndex: templateStep.stepIndex,
      chainLayer: templateStep.layer,
      status: templateStep.stepIndex < 10 ? TaskStatus.DONE : TaskStatus.TODO,
      targetBranch: "agentos/chain/legacy-upgrade",
    } }));
  }

  // New code re-seeds: the historical template is retained under a deterministic
  // marker and the canonical name is assigned to a different 12-row template.
  assert.equal((await seed()).code, 0);
  const legacy = await db.taskTemplate.findUniqueOrThrow({
    where: { id: templateId }, include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  assert.equal(legacy.name, legacyTenStepTemplateName(templateId));
  assert.equal(legacy.steps.length, 10);
  const canonical = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId, name: INTEGRATOR_TEMPLATE_NAME } },
    include: { steps: true },
  });
  assert.notEqual(canonical.id, templateId);
  assert.equal(canonical.steps.length, 12);

  const oldIntegrator = await db.task.findUniqueOrThrow({
    where: { id: tasks[9]!.id },
    include: { templateStep: { include: { taskTemplate: { select: { name: true } } } } },
  });
  assert.equal(executionModeFor(oldIntegrator.templateStep), "mechanical");

  // The real chain successor path must accept the preserved binding and enqueue
  // the old physical step 10 after its human predecessor completes.
  const advanced = await db.$transaction((tx) => activateChainSuccessor(tx, tasks[8]!));
  assert.deepEqual(advanced, { nextTaskId: oldIntegrator.id, gated: false });
  const queued = await db.run.findFirst({ where: { taskId: oldIntegrator.id }, orderBy: { runNumber: "desc" } });
  assert.ok(queued, "the historical integrator receives a run after re-seed");
  assert.equal(queued.status, "QUEUED");
});

/* ---------------------------------------------- 9 -> 12: foreign-key preservation */

test("re-seeding a historical nine-step template preserves its in-flight task semantics", async () => {
  assert.equal((await seed()).code, 0);
  const fresh = await integratorStep();
  const templateId = fresh.taskTemplateId;
  const projectId = fresh.taskTemplate.projectId;
  const agents = new Map((await db.agent.findMany({ where: { projectId } })).map((agent) => [agent.name, agent]));

  await db.taskTemplateStep.deleteMany({
    where: { taskTemplateId: templateId, stepIndex: { in: [10, 11, 12] } },
  });
  const historicalContract = [
    [1, "Write a spec", "spec-opus-high", AssigneeType.AGENT, "spec", true],
    [2, "Plan", "plan-fable-medium", AssigneeType.AGENT, "plan", false],
    [3, "Plan review", "review-coordinator-astra-medium", AssigneeType.AGENT, "plan-review", false],
    [4, "Revise plan", "plan-reviser-opus-medium", AssigneeType.AGENT, "revised-plan", true],
    [5, "Implementation", "plan-executor-astra-low", AssigneeType.AGENT, "implementation", false],
    [6, "Code review", "review-coordinator-astra-medium", AssigneeType.AGENT, "code-review", false],
    [7, "Apply review fixes", "senior-dev-astra-medium", AssigneeType.AGENT, "fixed-implementation", false],
    [8, "Librarian", "librarian-luna-xhigh", AssigneeType.AGENT, "documentation", false],
    [9, "Human PR review", null, AssigneeType.HUMAN, "approval", true],
  ] as const;
  for (const [stepIndex, name, agentName, assigneeType, outputKind, approvalGate] of historicalContract) {
    await db.taskTemplateStep.update({
      where: { taskTemplateId_stepIndex: { taskTemplateId: templateId, stepIndex } },
      data: {
        name,
        assigneeType,
        assigneeAgentId: agentName ? agents.get(agentName)!.id : null,
        approvalGate,
        outputKind,
      },
    });
  }
  const historicalSteps = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: templateId }, orderBy: { stepIndex: "asc" },
  });
  assert.deepEqual(historicalSteps.map((step) => step.stepIndex), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const beforeSemantics = historicalSteps.map((step) => ({
    id: step.id,
    stepIndex: step.stepIndex,
    name: step.name,
    assigneeType: step.assigneeType,
    assigneeAgentId: step.assigneeAgentId,
    approvalGate: step.approvalGate,
    outputKind: step.outputKind,
  }));

  const reviewStep = historicalSteps[5]!;
  const repo = await db.repo.create({ data: {
    projectId, name: "legacy-nine-upgrade", remoteUrl: "https://github.com/acme/legacy-nine-upgrade.git",
    mountPath: "/scratch/legacy-nine-upgrade", defaultBranch: "main", dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  const inFlight = await db.task.create({ data: {
    projectId, repoId: repo.id, templateId, templateStepId: reviewStep.id,
    name: reviewStep.name, description: reviewStep.prompt,
    assigneeType: reviewStep.assigneeType, assigneeAgentId: reviewStep.assigneeAgentId,
    approvalGate: reviewStep.approvalGate, opensPullRequest: reviewStep.opensPullRequest,
    chainId: `in-flight-nine-${process.pid}`, chainIndex: reviewStep.stepIndex,
    chainLayer: reviewStep.layer,
    status: TaskStatus.DOING, targetBranch: "agentos/chain/legacy-nine-upgrade",
  } });
  await db.taskStepOutput.create({ data: {
    taskId: inFlight.id, kind: reviewStep.outputKind, body: "historical review",
  } });

  assert.equal((await seed()).code, 0);
  const legacy = await db.taskTemplate.findUniqueOrThrow({
    where: { id: templateId }, include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  assert.equal(legacy.name, legacyNineStepTemplateName(templateId));
  assert.deepEqual(legacy.steps.map((step) => ({
    id: step.id,
    stepIndex: step.stepIndex,
    name: step.name,
    assigneeType: step.assigneeType,
    assigneeAgentId: step.assigneeAgentId,
    approvalGate: step.approvalGate,
    outputKind: step.outputKind,
  })), beforeSemantics);

  const canonical = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId, name: INTEGRATOR_TEMPLATE_NAME } },
    include: { steps: true },
  });
  assert.notEqual(canonical.id, templateId);
  assert.equal(canonical.steps.length, 12);

  const preserved = await db.task.findUniqueOrThrow({
    where: { id: inFlight.id },
    include: {
      stepOutput: true,
      templateStep: { include: { assigneeAgent: true, taskTemplate: true } },
    },
  });
  assert.equal(preserved.templateId, templateId);
  assert.equal(preserved.templateStepId, reviewStep.id);
  assert.equal(preserved.templateStep?.taskTemplate.name, legacyNineStepTemplateName(templateId));
  assert.equal(preserved.templateStep?.name, "Code review");
  assert.equal(preserved.templateStep?.assigneeAgent?.name, "review-coordinator-astra-medium");
  assert.equal(preserved.templateStep?.outputKind, "code-review");
  assert.equal(preserved.stepOutput?.kind, "code-review");
});
