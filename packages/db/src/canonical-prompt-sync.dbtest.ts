/**
 * The canonical prompt sync's canonical runtime adoption against PostgreSQL.
 *
 * Requires a scratch server. It creates and drops its own schema and never
 * touches an existing one.
 *
 *   AGENTOS_ALLOW_SCRATCH_DATABASES=1 \
 *   TEST_DATABASE_URL=postgresql://...:55777/...?schema=... \
 *     npm run test:db -w @anneal/db
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { AssigneeType, Prisma, PrismaClient, RepoPermission, RunnerPreference, TaskStatus } from "@prisma/client";

import { loadAgentSources } from "./agent-sources.js";
import { parseCanonicalSyncSummary } from "./canonical-sync-report.js";
import { isMergeReadinessStep } from "./merge-tail.js";
import { isIntegratorStep } from "./merge-integrator.js";
import {
  canonicalTemplateIdentity,
  legacyHumanSixStepTemplateName,
  legacyHumanTwelveStepTemplateName,
  legacyNineStepTemplateName,
  legacyRegressionFirstThirteenStepTemplateName,
  legacyTenStepTemplateName,
} from "./canonical-template-transition.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");

const scratchServer = (): URL => {
  if (process.env["AGENTOS_ALLOW_SCRATCH_DATABASES"] !== "1") throw new Error("scratch-database-opt-in-required");
  const raw = process.env["TEST_DATABASE_URL"];
  if (!raw) throw new Error("scratch-test-database-url-required");
  const url = new URL(raw);
  if (!url.protocol.startsWith("postgres")) throw new Error("scratch-database-postgresql-required");
  if ((url.port || "5432") === "5432") throw new Error("scratch-database-refuses-port-5432");
  return url;
};

const server = scratchServer();
const schema = `canonical_prompt_sync_${randomBytes(4).toString("hex")}`;
const databaseUrl = (() => {
  const url = new URL(server.href);
  url.searchParams.set("schema", schema);
  return url.href;
})();
const command = (args: string[]) => {
  const result = spawnSync("npx", args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

type CanonicalRuntime = { model: string; runnerPreference: RunnerPreference };

let prisma: PrismaClient;
let canonicalRuntimes: Map<string, CanonicalRuntime>;

const canonicalRuntime = (name: string): CanonicalRuntime => {
  const runtime = canonicalRuntimes.get(name);
  assert.ok(runtime, `role source must contain ${name}`);
  return runtime;
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const runtimeAdoptionPattern = (
  name: string,
  from: CanonicalRuntime,
  to: CanonicalRuntime,
): RegExp => new RegExp(
  `Canonical runtime config adopted for Agent ${escapeRegex(name)}: `
  + `from model=${escapeRegex(from.model)}, runnerPreference=${from.runnerPreference} `
  + `to model=${escapeRegex(to.model)}, runnerPreference=${to.runnerPreference}`,
  "u",
);

before(async () => {
  canonicalRuntimes = new Map((await loadAgentSources()).roles.map((role) => [role.name, {
    model: role.model,
    runnerPreference: role.runnerPreference,
  }]));
  const migrated = command(["prisma", "migrate", "deploy"]);
  assert.equal(migrated.status, 0, migrated.output);
  const seeded = command(["tsx", "prisma/seed.ts"]);
  assert.equal(seeded.status, 0, seeded.output);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
});

after(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({ datasources: { db: { url: server.href } } });
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.$disconnect();
  }
});

const snapshotInstantiatedTasks = async (taskIds: string[]) => {
  const rows = await prisma.task.findMany({
    where: { id: { in: taskIds } },
    include: { runs: true, sessions: true, stepOutput: true },
    orderBy: { id: "asc" },
  });
  return JSON.stringify(rows);
};

/**
 * The graph that preceded the adjudication node's removal, expressed as the
 * single step this sync deletes. The fixture reopens that hole so the row on
 * disk is the exact adjudication-era graph the transition table enumerates.
 */
const ADJUDICATION_STEPS = {
  "direct-engineer-workflow": { stepIndex: 4, layer: 3, baseFromStepIndex: 1 },
  "compound-engineer-workflow": { stepIndex: 8, layer: 7, baseFromStepIndex: 5 },
} as const;

/**
 * Prompt-only rollover fixtures must restore every prompt byte from before
 * optional review omission, not just the older Regression script path. The
 * generation digest authenticates the whole template.
 */
/** Every registered legacy generation still bound its review-fix step to
 * senior-dev-astra-medium; a fixture that rebuilds one from current rows restores that. */
const rebindFixStepToRetiredSeniorDev = async (projectId: string, templateId: string): Promise<void> => {
  const seniorDev = await prisma.agent.findUniqueOrThrow({ where: { projectId_name: { projectId, name: "senior-dev-astra-medium" } } });
  await prisma.taskTemplateStep.updateMany({
    where: { taskTemplateId: templateId, outputKind: "fixed-implementation" },
    data: { assigneeAgentId: seniorDev.id },
  });
};

const restoreModelSpecificReviewOutput = async (templateId: string): Promise<void> => {
  const steps = await prisma.taskTemplateStep.findMany({ where: { taskTemplateId: templateId } });
  for (const step of steps) {
    await prisma.taskTemplateStep.update({ where: { id: step.id }, data: {
      outputKind: step.outputKind === "review-findings" ? "sol-findings" : step.outputKind,
      priorOutputKinds: step.priorOutputKinds.map((kind) => kind === "review-findings" ? "sol-findings" : kind),
      prompt: step.prompt.replaceAll("review-findings", "sol-findings").replaceAll("the code review report", "the Sol report"),
    } });
  }
};

/** Historical rollover fixtures describe the deployed model-specific labels. */
const restoreRetiredReviewStepNames = async (templateId: string): Promise<void> => {
  await restoreModelSpecificReviewOutput(templateId);
  await prisma.taskTemplateStep.updateMany({
    where: { taskTemplateId: templateId, outputKind: "sol-findings" },
    data: { name: "Code review (Sol)" },
  });
  await prisma.taskTemplateStep.updateMany({
    where: { taskTemplateId: templateId, outputKind: "blind-findings" },
    data: { name: "Code review (Opus blind)" },
  });
};

const restorePreOptionalReviewPrompt = (prompt: string): string => prompt
  .replaceAll("review-findings", "sol-findings")
  .replaceAll("the code review report", "the Sol report")
  // Every registered generation predates the salvage-resume rollover, so the
  // fix prompt drops that sentence pair before the older spellings are restored.
  .replace(
    " If that HEAD is a `WIP salvage` commit of a prior Run of this same task and its parent is the reviewed head, the salvaged changes are your own failed attempt's in-progress fixes: validate them against the reports, continue on top of them, and record the reviewed head — the salvage commit's parent — as `sourceHead`. Every other reviewed-head mismatch remains a stop.",
    "",
  )
  .replace(
    "Read the immutable `sol-findings` review output and, when present, the immutable `blind-findings` output through their Anneal step outputs. The blind review may be absent when its optional step was omitted; when it is absent, the Sol report is the sole report. Verify that every present report's reviewed head is the HEAD you are about to fix. When both reports are present, also verify that they report the same reviewed base and the same reviewed head.",
    "Read both immutable review outputs from the preceding layer — `sol-findings` and `blind-findings` — through their Anneal step outputs, and verify both report the same reviewed base and the same reviewed head, and that the head they reviewed is the HEAD you are about to fix.",
  )
  .replace(
    "Record exactly one disposition per finding id across every present report",
    "Record exactly one disposition per finding id across both reports",
  )
  .replace(
    "Otherwise read the implementation summary,\nevery present review report (`sol-findings` and, when instantiated,\n`blind-findings`), and the fixed implementation with its dispositions from\nAnneal. The blind review report may be absent when its optional step was\nomitted. Review the entire refreshed fix diff as one unit, account for every\nfinding id in every present report, rerun focused regressions, and verify that the approved",
    "Otherwise read the implementation summary,\nboth review reports, and the fixed implementation with its dispositions from\nAnneal. Review the entire refreshed fix diff as one unit, account for every\nfinding id, rerun focused regressions, and verify that the approved",
  );

const downgradeDirectTemplateToHistoricalSevenStep = async (projectId: string): Promise<void> => {
  const template = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId, name: "direct-engineer-workflow" } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const revalidation = template.steps.find(({ stepIndex }) => stepIndex === 1);
  assert.equal(revalidation?.outputKind, "revalidation");
  await prisma.taskTemplateStep.delete({ where: { id: revalidation!.id } });
  for (const step of template.steps.filter(({ stepIndex }) => stepIndex > 1)) {
    await prisma.taskTemplateStep.update({
      where: { id: step.id },
      data: {
        stepIndex: step.stepIndex - 1,
        layer: step.layer - 1,
        baseFromStepIndex: step.baseFromStepIndex === null ? null : step.baseFromStepIndex - 1,
        provisionDependencies: true,
        optional: false,
      },
    });
  }
};

test("sync creates the pull-request template when the pre-existing canonical installation has none", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const preExistingTemplateSnapshot = JSON.stringify(await prisma.taskTemplate.findMany({
    where: {
      projectId: project.id,
      name: { in: ["compound-engineer-workflow", "direct-engineer-workflow"] },
    },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
    orderBy: { name: "asc" },
  }));
  const existing = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "pr-engineer-workflow" } },
  });
  await prisma.taskTemplate.delete({ where: { id: existing.id } });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdCanonicalTemplates":1/u);

  const created = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "pr-engineer-workflow" } },
    include: { steps: { include: { assigneeAgent: { select: { name: true } } }, orderBy: { stepIndex: "asc" } } },
  });
  assert.deepEqual(created.variables, ["branchName"]);
  assert.deepEqual(created.steps.map(({ assigneeAgent }) => assigneeAgent?.name), [
    "senior-dev-luna-max", "code-reviewer-sol-high", "code-reviewer-opus-high", "senior-dev-astra-low",
  ]);
  assert.equal(JSON.stringify(await prisma.taskTemplate.findMany({
    where: {
      projectId: project.id,
      name: { in: ["compound-engineer-workflow", "direct-engineer-workflow"] },
    },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
    orderBy: { name: "asc" },
  })), preExistingTemplateSnapshot);

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /"createdCanonicalTemplates":0/u);

  const canonicalPrompt = created.steps[0]!.prompt;
  await prisma.taskTemplateStep.update({
    where: { id: created.steps[0]!.id },
    data: { prompt: "controlled PR prompt drift" },
  });
  const restored = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(restored.status, 0, restored.output);
  assert.equal(
    (await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: created.steps[0]!.id } })).prompt,
    canonicalPrompt,
  );
});

test("sync creates the canonical-project PR template when a same-name row exists elsewhere", async () => {
  const canonicalProject = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const canonicalTemplate = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonicalProject.id, name: "pr-engineer-workflow" } },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  const foreignProject = await prisma.project.create({
    data: { name: "Foreign PR template", slug: `foreign-pr-${randomBytes(4).toString("hex")}` },
  });
  const environment = await prisma.environment.create({
    data: { projectId: foreignProject.id, name: "local", allowedHosts: [] },
  });
  const foreignAgents = new Map<string, string>();
  for (const source of canonicalTemplate.steps.map(({ assigneeAgent }) => assigneeAgent!)) {
    if (foreignAgents.has(source.name)) continue;
    const created = await prisma.agent.create({ data: {
      projectId: foreignProject.id,
      environmentId: environment.id,
      name: source.name,
      title: source.title,
      model: source.model,
      runnerPreference: source.runnerPreference,
      inboxAccess: source.inboxAccess,
      foundationalPrompt: source.foundationalPrompt,
      rolePrompt: source.rolePrompt,
      disabledTools: source.disabledTools,
    } });
    foreignAgents.set(source.name, created.id);
  }
  const foreignTemplate = await prisma.taskTemplate.create({ data: {
    projectId: foreignProject.id,
    name: canonicalTemplate.name,
    description: canonicalTemplate.description,
    variables: canonicalTemplate.variables,
  } });
  for (const step of canonicalTemplate.steps) {
    await prisma.taskTemplateStep.create({ data: {
      taskTemplateId: foreignTemplate.id,
      stepIndex: step.stepIndex,
      layer: step.layer,
      name: step.name,
      assigneeAgentId: foreignAgents.get(step.assigneeAgent!.name)!,
      assigneeType: step.assigneeType,
      runner: step.runner,
      approvalGate: step.approvalGate,
      optional: step.optional,
      outputKind: step.outputKind,
      prompt: step.prompt,
      opensPullRequest: step.opensPullRequest,
      requiresCommit: step.requiresCommit,
      attachmentsFromPrevious: step.attachmentsFromPrevious,
      priorOutputKinds: step.priorOutputKinds,
      baseFromStepIndex: step.baseFromStepIndex,
      spawnPolicy: step.spawnPolicy === null ? Prisma.JsonNull : step.spawnPolicy,
    } });
  }
  await prisma.taskTemplate.delete({ where: { id: canonicalTemplate.id } });
  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdCanonicalTemplates":1/u);
  await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonicalProject.id, name: "pr-engineer-workflow" } },
  });
  const syncedForeign = await prisma.taskTemplate.findUniqueOrThrow({
    where: { id: foreignTemplate.id },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  assert.ok(syncedForeign.steps
    .filter(({ stepIndex }) => stepIndex === 2 || stepIndex === 3)
    .every(({ provisionDependencies }) => provisionDependencies === false));
  assert.ok(syncedForeign.steps
    .filter(({ stepIndex }) => stepIndex !== 2 && stepIndex !== 3)
    .every(({ provisionDependencies }) => provisionDependencies === true));
  await prisma.project.delete({ where: { id: foreignProject.id } });
});

test("sync rolls the checkout Regression prompt generation once and preserves chain prompt lineage", async (t) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const templateNames = ["direct-engineer-workflow", "compound-engineer-workflow"] as const;
  const runnerResolver = '"${AGENTOS_TOOLS:?AGENTOS_TOOLS is required}/regression-verification.sh"';
  // Rebuild the registered predecessor spelling without leaving the retired
  // path as a source-tree reference. Its exact bytes are the prompt-generation
  // identity that authorizes this one-time canonical rollover.
  const retiredResolver = ["scripts", "regression-verification.sh"].join("/");
  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: project.id, name: { in: [...templateNames] } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
    orderBy: { name: "asc" },
  });
  assert.equal(templates.length, templateNames.length);

  const taskIds: string[] = [];
  const legacyTemplateIds: string[] = [];
  const retired = new Map<string, { templateId: string; regressionTaskId: string; prompt: string }>();
  t.after(async () => {
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.taskTemplate.deleteMany({ where: { id: { in: legacyTemplateIds } } });
  });

  for (const template of templates) {
    await prisma.taskTemplateStep.updateMany({
      where: { taskTemplateId: template.id },
      data: { provisionDependencies: true, optional: false },
    });
    await restoreRetiredReviewStepNames(template.id);
    await rebindFixStepToRetiredSeniorDev(project.id, template.id);
    const regression = template.steps.find(({ outputKind }) => outputKind === "regression-verification-v2");
    assert.ok(regression);
    assert.equal(regression.prompt.split(runnerResolver).length - 1, 3);
    const fix = template.steps.find(({ outputKind }) => outputKind === "fixed-implementation");
    assert.ok(fix);
    await prisma.taskTemplateStep.update({
      where: { id: fix.id },
      data: { prompt: restorePreOptionalReviewPrompt(fix.prompt) },
    });
    const outgoingPrompt = restorePreOptionalReviewPrompt(regression.prompt)
      .replaceAll(runnerResolver, retiredResolver);
    assert.doesNotMatch(outgoingPrompt, /AGENTOS_TOOLS/u);
    await prisma.taskTemplateStep.update({ where: { id: regression.id }, data: { prompt: outgoingPrompt } });

    const chainId = `pre-runner-tools-${template.name}-${randomBytes(4).toString("hex")}`;
    let regressionTaskId = "";
    for (const step of template.steps) {
      const task = await prisma.task.create({ data: {
        projectId: project.id,
        templateId: template.id,
        templateStepId: step.id,
        name: `retired tooling ${template.name} ${step.stepIndex}`,
        description: "prompt-generation rollover fixture",
        assigneeAgentId: step.assigneeAgentId,
        assigneeType: step.assigneeType,
        status: TaskStatus.DONE,
        chainId,
        chainIndex: step.stepIndex,
        chainLayer: step.layer,
      } });
      taskIds.push(task.id);
      if (step.id === regression.id) regressionTaskId = task.id;
    }
    assert.notEqual(regressionTaskId, "");
    retired.set(template.name, { templateId: template.id, regressionTaskId, prompt: outgoingPrompt });
  }

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdCanonicalTemplates":2/u);

  for (const templateName of templateNames) {
    const old = retired.get(templateName)!;
    const legacyName = `${templateName}-legacy-pre-runner-provided-regression-tooling-${old.templateId}`;
    const legacy = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: legacyName } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.equal(legacy.id, old.templateId);
    legacyTemplateIds.push(legacy.id);
    assert.equal(legacy.steps.find(({ outputKind }) => outputKind === "regression-verification-v2")?.prompt, old.prompt);
    const oldTask = await prisma.task.findUniqueOrThrow({
      where: { id: old.regressionTaskId },
      include: { templateStep: true },
    });
    assert.equal(oldTask.templateStep?.prompt, old.prompt);

    const current = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: templateName } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.notEqual(current.id, old.templateId);
    const currentRegression = current.steps.find(({ outputKind }) => outputKind === "regression-verification-v2");
    assert.ok(currentRegression);
    assert.equal(currentRegression.prompt.split(runnerResolver).length - 1, 3);
    assert.equal(currentRegression.prompt.includes(retiredResolver), false);

    const newTask = await prisma.task.create({ data: {
      projectId: project.id,
      templateId: current.id,
      templateStepId: currentRegression.id,
      name: `current tooling ${templateName}`,
      description: "successor prompt fixture",
      assigneeAgentId: currentRegression.assigneeAgentId,
      assigneeType: currentRegression.assigneeType,
      status: TaskStatus.DONE,
      chainId: `runner-tools-current-${templateName}-${randomBytes(4).toString("hex")}`,
      chainIndex: currentRegression.stepIndex,
      chainLayer: currentRegression.layer,
    } });
    taskIds.push(newTask.id);
    const instantiated = await prisma.task.findUniqueOrThrow({
      where: { id: newTask.id },
      include: { templateStep: true },
    });
    assert.equal(instantiated.templateStep?.prompt, currentRegression.prompt);
  }

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /"createdCanonicalTemplates":0/u);
  assert.equal(await prisma.taskTemplate.count({
    where: { projectId: project.id, name: { contains: "legacy-pre-runner-provided-regression-tooling" } },
  }), 2);
});

test("sync rolls the deployed pre-optional-review prompt generation once", async (t) => {
  // The generation production ran when the blind review step became optional:
  // runner-provided Regression tooling was already installed, only the fix and
  // Regression prompts still required both review reports.
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const templateNames = ["direct-engineer-workflow", "compound-engineer-workflow"] as const;
  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: project.id, name: { in: [...templateNames] } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
    orderBy: { name: "asc" },
  });
  assert.equal(templates.length, templateNames.length);

  const taskIds: string[] = [];
  const legacyTemplateIds: string[] = [];
  const retired = new Map<string, { templateId: string; fixTaskId: string; prompt: string }>();
  t.after(async () => {
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.taskTemplate.deleteMany({ where: { id: { in: legacyTemplateIds } } });
  });

  for (const template of templates) {
    await prisma.taskTemplateStep.updateMany({
      where: { taskTemplateId: template.id },
      data: { optional: false },
    });
    await restoreRetiredReviewStepNames(template.id);
    await rebindFixStepToRetiredSeniorDev(project.id, template.id);
    const fix = template.steps.find(({ outputKind }) => outputKind === "fixed-implementation");
    const regression = template.steps.find(({ outputKind }) => outputKind === "regression-verification-v2");
    assert.ok(fix);
    assert.ok(regression);
    const outgoingFixPrompt = restorePreOptionalReviewPrompt(fix.prompt);
    const outgoingRegressionPrompt = restorePreOptionalReviewPrompt(regression.prompt);
    assert.notEqual(outgoingFixPrompt, fix.prompt);
    assert.notEqual(outgoingRegressionPrompt, regression.prompt);
    await prisma.taskTemplateStep.update({ where: { id: fix.id }, data: { prompt: outgoingFixPrompt } });
    await prisma.taskTemplateStep.update({ where: { id: regression.id }, data: { prompt: outgoingRegressionPrompt } });

    const chainId = `pre-optional-review-${template.name}-${randomBytes(4).toString("hex")}`;
    let fixTaskId = "";
    for (const step of template.steps) {
      const task = await prisma.task.create({ data: {
        projectId: project.id,
        templateId: template.id,
        templateStepId: step.id,
        name: `pre-optional review ${template.name} ${step.stepIndex}`,
        description: "prompt-generation rollover fixture",
        assigneeAgentId: step.assigneeAgentId,
        assigneeType: step.assigneeType,
        status: TaskStatus.DONE,
        chainId,
        chainIndex: step.stepIndex,
        chainLayer: step.layer,
      } });
      taskIds.push(task.id);
      if (step.id === fix.id) fixTaskId = task.id;
    }
    assert.notEqual(fixTaskId, "");
    retired.set(template.name, { templateId: template.id, fixTaskId, prompt: outgoingFixPrompt });
  }

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdCanonicalTemplates":2/u);

  for (const templateName of templateNames) {
    const old = retired.get(templateName)!;
    const legacyName = `${templateName}-legacy-pre-optional-review-omission-${old.templateId}`;
    const legacy = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: legacyName } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.equal(legacy.id, old.templateId);
    legacyTemplateIds.push(legacy.id);
    const oldTask = await prisma.task.findUniqueOrThrow({
      where: { id: old.fixTaskId },
      include: { templateStep: true },
    });
    assert.equal(oldTask.templateStep?.prompt, old.prompt);

    const current = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: templateName } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.notEqual(current.id, old.templateId);
    const currentFix = current.steps.find(({ outputKind }) => outputKind === "fixed-implementation");
    assert.ok(currentFix);
    assert.match(currentFix.prompt, /when it is absent, the code review report is the sole report/u);
    assert.equal(current.steps.find(({ outputKind }) => outputKind === "blind-findings")?.optional, true);
  }

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /"createdCanonicalTemplates":0/u);
  assert.equal(await prisma.taskTemplate.count({
    where: { projectId: project.id, name: { contains: "legacy-pre-optional-review-omission" } },
  }), 2);
});

test("sync rolls parked and not-yet-started v1 chains forward without changing them", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  // The canonical source is now eight-step for bound chains. Reconstruct the
  // exact seven-step direct row that a pre-revalidation chain persisted so the
  // rollover proves those task and prompt rows remain untouched.
  await downgradeDirectTemplateToHistoricalSevenStep(project.id);
  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: project.id, name: { in: ["direct-engineer-workflow", "compound-engineer-workflow"] } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const oldPrompt = "Acquire before fetch and emit the v1 Regression contract.";
  const legacyTaskIds: string[] = [];
  for (const template of templates) {
    await prisma.taskTemplateStep.updateMany({
      where: { taskTemplateId: template.id },
      data: { provisionDependencies: true, optional: false },
    });
    await restoreRetiredReviewStepNames(template.id);
    await rebindFixStepToRetiredSeniorDev(project.id, template.id);
    await prisma.taskTemplateStep.updateMany({
      where: { taskTemplateId: template.id, outputKind: "regression-verification-v2" },
      data: { outputKind: "regression-verification", prompt: oldPrompt },
    });
    const regressionIndex = template.steps.find(({ outputKind }) => outputKind === "regression-verification-v2")!.stepIndex;
    const parked = template.name === "compound-engineer-workflow";
    const chainId = `${parked ? "parked" : "not-started"}-v1-${template.id}`;
    for (const step of template.steps) {
      const task = await prisma.task.create({ data: {
        projectId: project.id,
        templateId: template.id,
        templateStepId: step.id,
        name: `parked-v1-${template.name}-${step.stepIndex}`,
        description: "parked v1 rollover compatibility fixture",
        assigneeAgentId: step.assigneeAgentId,
        assigneeType: step.assigneeType,
        status: !parked
          ? TaskStatus.TODO
          : step.stepIndex < regressionIndex
          ? TaskStatus.DONE
          : step.stepIndex === regressionIndex
            ? TaskStatus.BACKLOG
            : TaskStatus.TODO,
        chainId,
        chainIndex: step.stepIndex,
        chainLayer: step.layer,
      } });
      legacyTaskIds.push(task.id);
    }
  }

  const legacyBefore = await snapshotInstantiatedTasks(legacyTaskIds);
  const activeTarget = await prisma.task.findFirstOrThrow({
    where: { id: { in: legacyTaskIds }, status: TaskStatus.BACKLOG },
    include: { assigneeAgent: { select: { model: true } } },
  });
  const activeRun = await prisma.run.create({ data: {
    projectId: activeTarget.projectId,
    taskId: activeTarget.id,
    agentId: activeTarget.assigneeAgentId!,
    runNumber: 1,
    dedupeKey: `parked-v1-active:${activeTarget.id}`,
    runner: "CODEX",
    model: activeTarget.assigneeAgent!.model,
    promptHash: "parked-v1-active",
  } });

  const refusedWhileActive = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.notEqual(refusedWhileActive.status, 0, refusedWhileActive.output);
  assert.match(refusedWhileActive.output, /tasks with active Runs or no chain identity/u);
  // The operator has to find what to settle or archive, so the refusal names
  // the blocking task rather than only counting it.
  assert.ok(
    refusedWhileActive.output.includes(`${activeTarget.id} (${activeTarget.name})`),
    refusedWhileActive.output,
  );
  await prisma.run.delete({ where: { id: activeRun.id } });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdCanonicalTemplates":2/u);
  assert.equal(await snapshotInstantiatedTasks(legacyTaskIds), legacyBefore);

  for (const template of templates) {
    const legacyName = `${template.name}-legacy-pre-narrow-regression-lease-${template.id}`;
    const legacy = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: legacyName } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.equal(legacy.id, template.id);
    const legacyRegression = legacy.steps.find(({ outputKind }) => outputKind === "regression-verification")!;
    assert.equal(legacyRegression.prompt, oldPrompt);
    const readiness = legacy.steps.find(({ outputKind }) => outputKind === "merge-authorization")!;
    const integrator = legacy.steps.find(({ outputKind }) => outputKind === "merge-result")!;
    assert.equal(isMergeReadinessStep({
      stepIndex: readiness.stepIndex,
      outputKind: readiness.outputKind,
      taskTemplateName: legacyName,
    }), true);
    assert.equal(isIntegratorStep({
      stepIndex: integrator.stepIndex,
      outputKind: integrator.outputKind,
      taskTemplate: { name: legacyName },
    }), true);

    const current = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: template.name } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.notEqual(current.id, template.id);
    const currentRegression = current.steps.find(({ outputKind }) => outputKind === "regression-verification-v2")!;
    assert.match(currentRegression.prompt, /AGENTOS_TOOLS:\?AGENTOS_TOOLS is required/u);
    assert.doesNotMatch(currentRegression.prompt, /Run `scripts\/regression-verification\.sh/u);
    assert.match(currentRegression.prompt, /script persists the one allowed v2 outcome/u);
  }

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /"createdCanonicalTemplates":0/u);
  await prisma.task.deleteMany({ where: { id: { in: legacyTaskIds } } });
});

test("sync rolls the exact adjudication-era graphs forward without touching instantiated evidence", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  // The direct adjudication generation predates the revalidation node too.
  await downgradeDirectTemplateToHistoricalSevenStep(project.id);
  const agents = new Map((await prisma.agent.findMany({ where: { projectId: project.id } })).map((agent) => [agent.name, agent]));
  const source = agents.get("code-reviewer-opus-high")!;
  const adjudicator = await prisma.agent.create({ data: {
    projectId: project.id,
    environmentId: source.environmentId,
    name: "review-adjudicator-opus",
    title: "Review Adjudicator (Opus)",
    model: source.model,
    foundationalPrompt: source.foundationalPrompt,
    rolePrompt: source.rolePrompt,
    runnerPreference: source.runnerPreference,
  } });

  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: project.id, name: { in: ["direct-engineer-workflow", "compound-engineer-workflow"] } },
    include: { steps: { include: { assigneeAgent: { select: { name: true } } }, orderBy: { stepIndex: "asc" } } },
  });
  const taskIds: string[] = [];
  const stepIds: string[] = [];
  const legacyNames = new Map<string, string>();
  for (const template of templates) {
    legacyNames.set(template.name, `${template.name}-legacy-pre-adjudication-${template.id}`);
    const adjudication = ADJUDICATION_STEPS[template.name as keyof typeof ADJUDICATION_STEPS];
    await prisma.taskTemplateStep.updateMany({
      where: { taskTemplateId: template.id },
      data: { provisionDependencies: true, optional: false },
    });
    await restoreRetiredReviewStepNames(template.id);
    await rebindFixStepToRetiredSeniorDev(project.id, template.id);
    // Walk down so the (template, stepIndex) unique never collides while the
    // hole opens; every step the adjudication node preceded also sat one layer
    // later than it does now.
    for (const step of [...template.steps].reverse()) {
      if (step.stepIndex < adjudication.stepIndex) continue;
      await prisma.taskTemplateStep.update({
        where: { id: step.id },
        data: { stepIndex: step.stepIndex + 1, layer: step.layer + 1 },
      });
    }
    await prisma.taskTemplateStep.create({ data: {
      taskTemplateId: template.id,
      stepIndex: adjudication.stepIndex,
      layer: adjudication.layer,
      name: "Opus adjudication",
      assigneeAgentId: adjudicator.id,
      assigneeType: "AGENT",
      approvalGate: false,
      outputKind: "must-fix",
      requiresCommit: false,
      attachmentsFromPrevious: true,
      opensPullRequest: false,
      baseFromStepIndex: adjudication.baseFromStepIndex,
      prompt: `Adjudicate the two review reports for ${template.name}.`,
    } });
    await prisma.taskTemplateStep.updateMany({
      where: { taskTemplateId: template.id, outputKind: "regression-verification-v2" },
      data: { outputKind: "regression-verification" },
    });
    // The adjudication-era compound graph still gated its spec and revise-plan
    // steps; the zero-gate transition removed those gates from the sources this
    // fixture derives from, so it restores them to land on the exact
    // enumerated historical shape.
    if (template.name === "compound-engineer-workflow") {
      await prisma.taskTemplateStep.updateMany({
        where: { taskTemplateId: template.id, stepIndex: { in: [1, 4] } },
        data: { approvalGate: true },
      });
    }

    const oldSteps = await prisma.taskTemplateStep.findMany({ where: { taskTemplateId: template.id }, orderBy: { stepIndex: "asc" } });
    for (const [index, step] of oldSteps.entries()) {
      stepIds.push(step.id);
      // Keep the later routing-adoption regression isolated: this test owns
      // the template-row preservation proof, so its historical evidence must
      // not hold a foreign key that would prevent the separate Agent-copy
      // fixture from removing the old verifier row.
      const taskAssigneeId = step.assigneeAgentId === agents.get("regression-verifier-luna-xhigh")?.id ? source.id : step.assigneeAgentId;
      const task = await prisma.task.create({ data: {
        projectId: project.id,
        templateId: template.id,
        templateStepId: step.id,
        name: `legacy-${template.name}-${step.stepIndex}`,
        description: `operator-owned description ${template.name} ${step.stepIndex}`,
        assigneeAgentId: taskAssigneeId,
        assigneeType: step.assigneeType,
        // Finished: the rollover guard refuses to rename a row whose chains are
        // still running, and that refusal is proved separately. This test owns
        // the proof that a rollover leaves finished evidence byte-identical.
        status: TaskStatus.DONE,
      } });
      taskIds.push(task.id);
      if (index === 0) {
        const run = await prisma.run.create({ data: {
          projectId: project.id, taskId: task.id, agentId: taskAssigneeId!, runNumber: 1,
          dedupeKey: `canonical-sync-legacy:${task.id}`, runner: "CODEX", model: agents.get("default")?.model ?? "gpt-5.6-sol:medium", promptHash: "legacy-snapshot",
        } });
        await prisma.session.create({ data: {
          runId: run.id, projectId: project.id, agentId: taskAssigneeId!, taskId: task.id, runner: "CODEX",
        } });
      }
    }
  }
  const beforeTasks = await snapshotInstantiatedTasks(taskIds);
  const beforeSteps = JSON.stringify(await prisma.taskTemplateStep.findMany({ where: { id: { in: stepIds } }, orderBy: { id: "asc" } }));

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);

  const afterTasks = await snapshotInstantiatedTasks(taskIds);
  const afterSteps = JSON.stringify(await prisma.taskTemplateStep.findMany({ where: { id: { in: stepIds } }, orderBy: { id: "asc" } }));
  assert.equal(afterTasks, beforeTasks);
  assert.equal(afterSteps, beforeSteps);
  for (const legacyName of legacyNames.values()) {
    assert.equal(await prisma.taskTemplate.count({ where: { projectId: project.id, name: legacyName } }), 1);
  }
  const direct = await prisma.taskTemplate.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } }, include: { steps: { orderBy: { stepIndex: "asc" } } } });
  const full = await prisma.taskTemplate.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow" } }, include: { steps: { orderBy: { stepIndex: "asc" } } } });
  assert.deepEqual(direct.steps.map(({ layer }) => layer), [1, 2, 3, 3, 4, 5, 6, 7]);
  assert.deepEqual(full.steps.map(({ layer }) => layer), [1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11]);

  const legacyDirect = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: legacyNames.get("direct-engineer-workflow")! } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const legacyFull = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: legacyNames.get("compound-engineer-workflow")! } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  for (const [legacyTemplate, readinessIndex, integratorIndex] of [
    [legacyDirect, 7, 8],
    [legacyFull, 12, 13],
  ] as const) {
    const readiness = legacyTemplate.steps.find(({ stepIndex }) => stepIndex === readinessIndex)!;
    const integrator = legacyTemplate.steps.find(({ stepIndex }) => stepIndex === integratorIndex)!;
    assert.equal(isMergeReadinessStep({
      stepIndex: readiness.stepIndex,
      outputKind: readiness.outputKind,
      taskTemplateName: legacyTemplate.name,
    }), true);
    assert.equal(isIntegratorStep({
      stepIndex: integrator.stepIndex,
      outputKind: integrator.outputKind,
      taskTemplate: { name: legacyTemplate.name },
    }), true);
  }

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  for (const legacyName of legacyNames.values()) {
    assert.equal(await prisma.taskTemplate.count({ where: { projectId: project.id, name: legacyName } }), 1);
  }
});

test("sync rolls the pre-zero-gate compound graph forward and leaves the direct row in place", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const full = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow" } },
    select: { id: true },
  });
  const directBefore = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
    select: { id: true },
  });
  // Regate spec and revise-plan: that is exactly the graph that preceded the
  // zero-gate transition, and nothing else about it moved.
  await prisma.taskTemplateStep.updateMany({
    where: { taskTemplateId: full.id },
    data: { provisionDependencies: true, optional: false },
  });
  await restoreRetiredReviewStepNames(full.id);
  await rebindFixStepToRetiredSeniorDev(project.id, full.id);
  await prisma.taskTemplateStep.updateMany({
    where: { taskTemplateId: full.id, stepIndex: { in: [1, 4] } },
    data: { approvalGate: true },
  });
  await prisma.taskTemplateStep.updateMany({
    where: { taskTemplateId: full.id, outputKind: "regression-verification-v2" },
    data: { outputKind: "regression-verification" },
  });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);

  const legacyName = `compound-engineer-workflow-legacy-pre-zero-gate-${full.id}`;
  const legacy = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: legacyName } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  assert.equal(legacy.id, full.id);
  const fresh = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow" } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  assert.notEqual(fresh.id, full.id);
  assert.deepEqual(fresh.steps.map(({ approvalGate }) => approvalGate), Array.from({ length: 12 }, () => false));
  // The regated ordinals are frozen with the renamed row, and its merge tail
  // stays recognized at the ordinals it was created under.
  assert.deepEqual(legacy.steps.filter(({ approvalGate }) => approvalGate).map(({ stepIndex }) => stepIndex), [1, 4]);
  const readiness = legacy.steps.find(({ stepIndex }) => stepIndex === 11)!;
  const integrator = legacy.steps.find(({ stepIndex }) => stepIndex === 12)!;
  assert.equal(isMergeReadinessStep({
    stepIndex: readiness.stepIndex,
    outputKind: readiness.outputKind,
    taskTemplateName: legacyName,
  }), true);
  assert.equal(isIntegratorStep({
    stepIndex: integrator.stepIndex,
    outputKind: integrator.outputKind,
    taskTemplate: { name: legacyName },
  }), true);
  // The direct graph did not change in this transition, so its row is updated
  // in place rather than rolled over.
  const directAfter = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
    select: { id: true },
  });
  assert.equal(directAfter.id, directBefore.id);
});

test("sync adopts any uncustomized canonical runtime drift", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const names = ["review-coordinator-astra-medium", "code-reviewer-sol-high"];
  const driftedCoordinator = { model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE };
  const driftedSol = { model: "gpt-5.6-sol:medium", runnerPreference: RunnerPreference.CODEX };
  const coordinatorSource = canonicalRuntime("review-coordinator-astra-medium");
  const solSource = canonicalRuntime("code-reviewer-sol-high");

  await prisma.agent.updateMany({ where: { projectId: project.id, name: "review-coordinator-astra-medium" }, data: driftedCoordinator });
  await prisma.agent.updateMany({ where: { projectId: project.id, name: "code-reviewer-sol-high" }, data: driftedSol });
  // §R9 made title adoptable, so it is drifted here as the identity half of the
  // adoption rather than as a refusal. `inboxAccess` is what the Markdown still
  // owns outright, and it is what makes the run refuse.
  const coordinator = await prisma.agent.findFirstOrThrow({
    where: { projectId: project.id, name: "review-coordinator-astra-medium" },
    select: { id: true, inboxAccess: true },
  });
  await prisma.agent.update({
    where: { id: coordinator.id },
    data: { title: "Unrelated drift", inboxAccess: !coordinator.inboxAccess },
  });

  const rejected = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.notEqual(rejected.status, 0, rejected.output);
  assert.match(rejected.output, /Agent review-coordinator-astra-medium .* differs from canonical Markdown structure: inboxAccess/u);
  const rolledBack = await prisma.agent.findMany({
    where: { projectId: project.id, name: { in: names } },
    select: { name: true, title: true, model: true, runnerPreference: true },
  });
  assert.equal(rolledBack.length, 2);
  assert.ok(rolledBack.every((agent) => (agent.name === "review-coordinator-astra-medium"
    ? agent.model === driftedCoordinator.model && agent.runnerPreference === driftedCoordinator.runnerPreference
    : agent.model === driftedSol.model && agent.runnerPreference === driftedSol.runnerPreference)));
  // The adoptable title drift rolled back with the refused transaction too.
  assert.equal(rolledBack.find(({ name }) => name === "review-coordinator-astra-medium")?.title, "Unrelated drift");

  await prisma.agent.update({ where: { id: coordinator.id }, data: { inboxAccess: coordinator.inboxAccess } });
  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"adoptedAgentDefaults":2/u);
  // The drifted title was adopted in the same run, not refused.
  assert.match(synced.output, /"adoptedAgentIdentity":1/u);
  assert.match(synced.output, runtimeAdoptionPattern("review-coordinator-astra-medium", driftedCoordinator, coordinatorSource));
  assert.match(synced.output, runtimeAdoptionPattern("code-reviewer-sol-high", driftedSol, solSource));

  const upgraded = await prisma.agent.findMany({
    where: { projectId: project.id, name: { in: names } },
    select: { name: true, title: true, model: true, runnerPreference: true },
  });
  assert.equal(upgraded.length, 2);
  assert.ok(upgraded.every((agent) => {
    const source = canonicalRuntime(agent.name);
    return agent.model === source.model && agent.runnerPreference === source.runnerPreference;
  }));
  assert.notEqual(upgraded.find(({ name }) => name === "review-coordinator-astra-medium")?.title, "Unrelated drift");
});

test("sync adopts uncustomized model-only runtime drift", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const executionerSource = canonicalRuntime("plan-executor-astra-medium");
  await prisma.agent.update({
    where: { projectId_name: { projectId: project.id, name: "plan-executor-astra-medium" } },
    data: {
      model: "gpt-5.6-sol:medium",
      runnerPreference: RunnerPreference.CODEX,
      customizedFields: [],
      runtimeConfigDriftNoticeFingerprint: "stale-runtime-drift",
    },
  });
  const driftNoticeCountBefore = await prisma.inboxMessage.count({
    where: { body: { startsWith: "Canonical runtime drift detected" } },
  });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"adoptedAgentDefaults":1/u);

  const executioner = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "plan-executor-astra-medium" } },
    select: { model: true, runnerPreference: true, customizedFields: true, runtimeConfigDriftNoticeFingerprint: true },
  });
  assert.deepEqual(executioner, {
    ...executionerSource,
    customizedFields: [],
    runtimeConfigDriftNoticeFingerprint: null,
  });
  assert.equal(await prisma.inboxMessage.count({
    where: { body: { startsWith: "Canonical runtime drift detected" } },
  }), driftNoticeCountBefore);
});

test("sync notifies once per current customized runtime drift without overwriting it", async (t) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const originalProduction = { model: "gpt-5.6-sol:high", runnerPreference: RunnerPreference.CODEX };
  const changedProduction = { model: "gpt-5.6-sol:medium", runnerPreference: RunnerPreference.CODEX };
  const mergeResolverSource = canonicalRuntime("merge-resolver-opus-medium");
  const mergeResolver = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "merge-resolver-opus-medium" } },
    select: {
      id: true,
      model: true,
      runnerPreference: true,
      customizedFields: true,
      runtimeConfigDriftNoticeFingerprint: true,
    },
  });
  const existingNoticeIds = new Set((await prisma.inboxMessage.findMany({
    where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
    select: { id: true },
  })).map(({ id }) => id));
  const operatorChatId = `canonical-drift-dbtest-${randomBytes(4).toString("hex")}`;
  const previousOperatorChatId = process.env["FEISHU_DEFAULT_CHAT_ID"];
  process.env["FEISHU_DEFAULT_CHAT_ID"] = operatorChatId;
  t.after(async () => {
    if (previousOperatorChatId === undefined) delete process.env["FEISHU_DEFAULT_CHAT_ID"];
    else process.env["FEISHU_DEFAULT_CHAT_ID"] = previousOperatorChatId;
    const createdNoticeIds = (await prisma.inboxMessage.findMany({
      where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
      select: { id: true },
    })).map(({ id }) => id).filter((id) => !existingNoticeIds.has(id));
    if (createdNoticeIds.length > 0) await prisma.inboxMessage.deleteMany({ where: { id: { in: createdNoticeIds } } });
    await prisma.agent.update({
      where: { id: mergeResolver.id },
      data: {
        model: mergeResolver.model,
        runnerPreference: mergeResolver.runnerPreference,
        customizedFields: mergeResolver.customizedFields,
        runtimeConfigDriftNoticeFingerprint: mergeResolver.runtimeConfigDriftNoticeFingerprint,
      },
    });
    await prisma.inboxThread.deleteMany({
      where: { channel: "FEISHU", externalChatId: operatorChatId, sessionId: null },
    });
  });
  await prisma.agent.update({
    where: { id: mergeResolver.id },
    data: { ...originalProduction, customizedFields: ["model", "runnerPreference"] },
  });

  const firstSync = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(firstSync.status, 0, firstSync.output);
  assert.match(firstSync.output, /"runtimeDriftNotices":1/u);

  const afterFirstSync = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "merge-resolver-opus-medium" } },
    select: { model: true, runnerPreference: true, customizedFields: true },
  });
  assert.deepEqual(afterFirstSync, { ...originalProduction, customizedFields: ["model", "runnerPreference"] });

  const firstNotice = await prisma.inboxMessage.findMany({
    where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(firstNotice.length, 1);
  assert.equal(firstNotice[0]!.from, "AGENT");
  assert.equal(firstNotice[0]!.kind, "TEXT");
  assert.notEqual(firstNotice[0]!.threadId, null);
  assert.equal((await prisma.inboxThread.findUniqueOrThrow({
    where: { id: firstNotice[0]!.threadId! },
  })).externalChatId, operatorChatId);
  assert.match(firstNotice[0]!.body, /Agent: merge-resolver-opus-medium/u);
  assert.match(firstNotice[0]!.body, new RegExp(
    `Canonical: model=${escapeRegex(mergeResolverSource.model)}, runner=${mergeResolverSource.runnerPreference}`,
    "u",
  ));
  assert.match(firstNotice[0]!.body, /Production: model=gpt-5\.6-sol:high, runner=CODEX/u);
  assert.match(firstNotice[0]!.body, /customizedFields=model,runnerPreference/u);

  const unchangedSync = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(unchangedSync.status, 0, unchangedSync.output);
  assert.match(unchangedSync.output, /"runtimeDriftNotices":0/u);
  assert.equal(await prisma.inboxMessage.count({
    where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
  }), 1);

  await prisma.agent.update({ where: { id: mergeResolver.id }, data: changedProduction });
  const changedSync = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(changedSync.status, 0, changedSync.output);
  assert.match(changedSync.output, /"runtimeDriftNotices":1/u);

  const notices = await prisma.inboxMessage.findMany({
    where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(notices.length, 2);
  assert.match(notices[1]!.body, /Production: model=gpt-5\.6-sol:medium, runner=CODEX/u);
  const afterChangedSync = await prisma.agent.findUniqueOrThrow({
    where: { id: mergeResolver.id },
    select: { model: true, runnerPreference: true, customizedFields: true },
  });
  assert.deepEqual(afterChangedSync, { ...changedProduction, customizedFields: ["model", "runnerPreference"] });

  await prisma.agent.update({ where: { id: mergeResolver.id }, data: originalProduction });
  const returnedSync = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(returnedSync.status, 0, returnedSync.output);
  assert.match(returnedSync.output, /"runtimeDriftNotices":1/u);
  assert.equal(await prisma.inboxMessage.count({
    where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
  }), 3);

  await prisma.agent.update({ where: { id: mergeResolver.id }, data: mergeResolverSource });
  const resolvedSync = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(resolvedSync.status, 0, resolvedSync.output);
  assert.match(resolvedSync.output, /"runtimeDriftNotices":0/u);

  await prisma.agent.update({ where: { id: mergeResolver.id }, data: originalProduction });
  const reappearedSync = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(reappearedSync.status, 0, reappearedSync.output);
  assert.match(reappearedSync.output, /"runtimeDriftNotices":1/u);
  assert.equal(await prisma.inboxMessage.count({
    where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
  }), 4);

});

test("sync adopts uncustomized runtime drift without promoting it", async (t) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const defaultSource = canonicalRuntime("default");
  const agent = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "default" } },
    select: {
      id: true,
      model: true,
      runnerPreference: true,
      customizedFields: true,
      runtimeConfigDriftNoticeFingerprint: true,
    },
  });
  const existingNoticeIds = new Set((await prisma.inboxMessage.findMany({
    where: { agentId: agent.id, body: { startsWith: "Canonical runtime drift detected" } },
    select: { id: true },
  })).map(({ id }) => id));
  t.after(async () => {
    const createdNoticeIds = (await prisma.inboxMessage.findMany({
      where: { agentId: agent.id, body: { startsWith: "Canonical runtime drift detected" } },
      select: { id: true },
    })).map(({ id }) => id).filter((id) => !existingNoticeIds.has(id));
    if (createdNoticeIds.length > 0) await prisma.inboxMessage.deleteMany({ where: { id: { in: createdNoticeIds } } });
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        model: agent.model,
        runnerPreference: agent.runnerPreference,
        customizedFields: agent.customizedFields,
        runtimeConfigDriftNoticeFingerprint: agent.runtimeConfigDriftNoticeFingerprint,
      },
    });
  });
  const production = { model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE };
  await prisma.agent.update({
    where: { id: agent.id },
    data: { ...production, customizedFields: [], runtimeConfigDriftNoticeFingerprint: "stale-runtime-drift" },
  });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"adoptedAgentDefaults":1/u);
  assert.match(synced.output, /"runtimeDriftNotices":0/u);
  assert.match(synced.output, runtimeAdoptionPattern("default", production, defaultSource));

  assert.deepEqual(await prisma.agent.findUniqueOrThrow({
    where: { id: agent.id },
    select: { model: true, runnerPreference: true, customizedFields: true, runtimeConfigDriftNoticeFingerprint: true },
  }), {
    ...defaultSource,
    customizedFields: [],
    runtimeConfigDriftNoticeFingerprint: null,
  });
  const notices = await prisma.inboxMessage.findMany({
    where: { agentId: agent.id, body: { startsWith: "Canonical runtime drift detected" } },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(notices.length, existingNoticeIds.size);
});

test("sync recreates a missing regression verifier and restores canonical bindings", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const verifierSource = canonicalRuntime("regression-verifier-luna-xhigh");
  const source = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "code-reviewer-sol-high" } },
  });
  const existingVerifier = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "regression-verifier-luna-xhigh" } },
  });
  const regressionSteps = await prisma.taskTemplateStep.findMany({
    where: {
      outputKind: "regression-verification-v2",
      taskTemplate: { projectId: project.id },
    },
    select: { id: true, taskTemplate: { select: { name: true } } },
  });
  await prisma.taskTemplateStep.updateMany({
    where: { id: { in: regressionSteps.map(({ id }) => id) } },
    data: { assigneeAgentId: source.id },
  });
  await prisma.agent.delete({ where: { id: existingVerifier.id } });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdAgents":1/u);
  assert.match(synced.output, /"adoptedAssignees":2/u);

  const verifier = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "regression-verifier-luna-xhigh" } },
  });
  assert.equal(verifier.model, verifierSource.model);
  assert.equal(verifier.runnerPreference, verifierSource.runnerPreference);
  assert.equal(verifier.inboxAccess, false);
  const canonicalSteps = regressionSteps.filter(({ taskTemplate }) =>
    taskTemplate.name === "compound-engineer-workflow" || taskTemplate.name === "direct-engineer-workflow");
  assert.equal(await prisma.taskTemplateStep.count({
    where: { id: { in: canonicalSteps.map(({ id }) => id) }, assigneeAgentId: verifier.id },
  }), 2);
});

test("sync recreates a missing spec revalidator with read-only repository coverage", async (t) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const source = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "code-reviewer-sol-high" } },
  });
  const existingRevalidator = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "spec-revalidator-luna-xhigh" } },
  });
  const revalidationSteps = await prisma.taskTemplateStep.findMany({
    where: { outputKind: "revalidation", taskTemplate: { projectId: project.id } },
    select: { id: true },
  });
  assert.ok(revalidationSteps.length > 0);
  await prisma.taskTemplateStep.updateMany({
    where: { id: { in: revalidationSteps.map(({ id }) => id) } },
    data: { assigneeAgentId: null },
  });

  const repo = await prisma.repo.create({
    data: {
      projectId: project.id,
      name: `canonical-sync-revalidator-${randomBytes(4).toString("hex")}`,
      remoteUrl: "file:///tmp/agentos-canonical-sync-revalidator.git",
      mountPath: "/workspace/canonical-sync-revalidator",
      dependencyProvisioning: "NONE",
    },
  });
  await prisma.agentRepoAccess.create({
    data: {
      agentId: source.id,
      repoId: repo.id,
      projectId: project.id,
      mountPath: repo.mountPath,
      permissions: RepoPermission.GIT_WRITE,
    },
  });
  t.after(async () => {
    await prisma.repo.delete({ where: { id: repo.id } });
  });

  await prisma.agent.delete({ where: { id: existingRevalidator.id } });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdAgents":1/u);
  assert.match(synced.output, /"createdAgentRepoGrants":1/u);

  const revalidator = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "spec-revalidator-luna-xhigh" } },
  });
  assert.equal(revalidator.model, "gpt-5.6-luna:xhigh");
  assert.equal(revalidator.runnerPreference, RunnerPreference.CODEX);
  assert.equal(revalidator.inboxAccess, true);
  assert.equal(await prisma.taskTemplateStep.count({
    where: { id: { in: revalidationSteps.map(({ id }) => id) }, assigneeAgentId: revalidator.id },
  }), revalidationSteps.length);
  assert.deepEqual(await prisma.agentRepoAccess.findMany({
    where: { agentId: revalidator.id, repoId: repo.id },
    select: { mountPath: true, permissions: true },
  }), [{ mountPath: repo.mountPath, permissions: RepoPermission.GIT_READ }]);
});

// senior-dev-astra-low is also created through the special-agent table, but
// every template binds it, so deleting it here would leave a bound step with
// no assignee; its creation is exercised by the canonical seed instead.
for (const specialName of ["senior-dev-sol-high", "senior-dev-opus-medium"] as const) {
test(`sync recreates a missing ${specialName} Agent from senior-dev-astra-medium`, async (t) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const specialSource = canonicalRuntime(specialName);
  const source = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "senior-dev-astra-medium" } },
  });
  const existingSol = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: specialName } },
  });

  const repo = await prisma.repo.create({
    data: {
      projectId: project.id,
      name: `canonical-sync-${specialName}-${randomBytes(4).toString("hex")}`,
      remoteUrl: `file:///tmp/agentos-canonical-sync-${specialName}.git`,
      mountPath: `/workspace/canonical-sync-${specialName}`,
      dependencyProvisioning: "NONE",
    },
  });
  await prisma.agentRepoAccess.create({
    data: {
      agentId: source.id,
      repoId: repo.id,
      projectId: project.id,
      mountPath: repo.mountPath,
      permissions: RepoPermission.GIT_WRITE,
    },
  });
  t.after(async () => {
    await prisma.repo.delete({ where: { id: repo.id } });
  });

  await prisma.agent.delete({ where: { id: existingSol.id } });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdAgents":1/u);
  assert.match(synced.output, /"createdAgentRepoGrants":1/u);

  const sol = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: specialName } },
  });
  assert.equal(sol.model, specialSource.model);
  assert.equal(sol.runnerPreference, specialSource.runnerPreference);
  assert.equal(sol.inboxAccess, true);
  assert.equal(sol.environmentId, source.environmentId);
  assert.deepEqual(sol.customizedFields, []);
  // The role binds no template step, so the source Agent's write grant is the
  // only way it can reach a repository.
  assert.deepEqual(await prisma.agentRepoAccess.findMany({
    where: { agentId: sol.id, repoId: repo.id },
    select: { mountPath: true, permissions: true },
  }), [{ mountPath: repo.mountPath, permissions: RepoPermission.GIT_WRITE }]);

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /"createdAgents":0/u);
  assert.equal(await prisma.agent.count({
    where: { projectId: project.id, name: specialName },
  }), 1);
});
}

test("canonical sync adopts the tolerated differences and refuses every other one before mutating", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const template = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const step = (stepIndex: number) => {
    const found = template.steps.find((candidate) => candidate.stepIndex === stepIndex);
    assert.ok(found, `direct-engineer-workflow must contain step ${stepIndex}`);
    return found;
  };
  const reviewStep = step(3);
  const implementationStep = step(2);
  const regressionStep = step(6);
  assert.equal(regressionStep.outputKind, "regression-verification-v2");
  const retiredReviewer = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "code-reviewer-sol-high" } },
  });
  const verifier = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "regression-verifier-luna-xhigh" } },
  });
  const provisioning = async (stepId: string): Promise<boolean> => (
    await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: stepId } })
  ).provisionDependencies;
  const assignee = async (stepId: string): Promise<string | null> => (
    await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: stepId } })
  ).assigneeAgentId;

  // A review step may carry the retired dependency provisioning; an implementation
  // step may not drop it. The refusal stands and the tolerated difference is not written.
  await prisma.taskTemplateStep.update({ where: { id: reviewStep.id }, data: { provisionDependencies: true } });
  await prisma.taskTemplateStep.update({ where: { id: implementationStep.id }, data: { provisionDependencies: false } });
  const refusedDrift = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.notEqual(refusedDrift.status, 0, refusedDrift.output);
  assert.match(refusedDrift.output, /direct-engineer-workflow step 2 \([^)]+\) differs from the canonical source in provisionDependencies/u);
  assert.equal(await provisioning(reviewStep.id), true);
  assert.equal(await provisioning(implementationStep.id), false);
  await prisma.taskTemplateStep.update({ where: { id: implementationStep.id }, data: { provisionDependencies: true } });

  // An adoption that rewrites a column instantiated Tasks copy refuses a
  // referenced step. §R8 took the Agent binding out of that class -- a Task
  // keeps the assignee it was created with, and staffing owns who runs it -- so
  // the case is proved on the step rename, which Tasks do copy.
  const authorizationStep = step(7);
  assert.equal(authorizationStep.name, "Merge authorization");
  await prisma.taskTemplateStep.update({ where: { id: authorizationStep.id }, data: { name: "Merge readiness" } });
  const referenced = await prisma.task.create({ data: {
    projectId: project.id,
    templateId: template.id,
    templateStepId: authorizationStep.id,
    name: "referenced merge readiness",
    description: "operator-owned evidence",
    assigneeAgentId: authorizationStep.assigneeAgentId,
    assigneeType: authorizationStep.assigneeType,
    status: TaskStatus.TODO,
  } });
  const refusedReferenced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.notEqual(refusedReferenced.status, 0, refusedReferenced.output);
  assert.match(refusedReferenced.output, /referenced by instantiated tasks/u);
  assert.equal(
    (await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: authorizationStep.id } })).name,
    "Merge readiness",
  );
  // The tolerated review-step write happened earlier in the same transaction and rolled back with it.
  assert.equal(await provisioning(reviewStep.id), true);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: referenced.id } })).description, "operator-owned evidence");
  await prisma.task.delete({ where: { id: referenced.id } });
  await prisma.taskTemplateStep.update({ where: { id: authorizationStep.id }, data: { name: "Merge authorization" } });

  // The Agent binding is the exception: a referenced step is rebound to its
  // canonical default, and the Task instantiated from it keeps its own
  // assignee, which is now a staffing decision rather than a template one.
  await prisma.taskTemplateStep.update({ where: { id: regressionStep.id }, data: { assigneeAgentId: retiredReviewer.id } });
  const staffedTask = await prisma.task.create({ data: {
    projectId: project.id,
    templateId: template.id,
    templateStepId: regressionStep.id,
    name: "referenced regression",
    description: "operator-owned evidence",
    assigneeAgentId: retiredReviewer.id,
    assigneeType: "AGENT",
    status: TaskStatus.TODO,
  } });
  const rebound = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(rebound.status, 0, rebound.output);
  assert.equal(await assignee(regressionStep.id), verifier.id);
  assert.equal(
    (await prisma.task.findUniqueOrThrow({ where: { id: staffedTask.id } })).assigneeAgentId,
    retiredReviewer.id,
  );
  await prisma.task.delete({ where: { id: staffedTask.id } });
  // Put the drift back so the adoption below is the one being measured.
  await prisma.taskTemplateStep.update({ where: { id: regressionStep.id }, data: { assigneeAgentId: retiredReviewer.id } });
  await prisma.taskTemplateStep.update({ where: { id: reviewStep.id }, data: { provisionDependencies: true } });

  // Both differences are now adoptable; the dependency-provisioning write does not
  // protect a referenced step, so an instantiated Task does not stop it.
  const reviewTask = await prisma.task.create({ data: {
    projectId: project.id,
    templateId: template.id,
    templateStepId: reviewStep.id,
    name: "referenced review",
    description: "dependency-provisioning canonical sync fixture",
    assigneeAgentId: reviewStep.assigneeAgentId,
    assigneeType: reviewStep.assigneeType,
    status: TaskStatus.TODO,
  } });
  try {
    const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
    assert.equal(synced.status, 0, synced.output);
    assert.match(synced.output, /"adoptedDependencyProvisioning":1,/u);
    assert.match(synced.output, /"adoptedAssignees":1,/u);
    assert.equal(await provisioning(reviewStep.id), false);
    assert.equal(await assignee(regressionStep.id), verifier.id);

    const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
    assert.equal(second.status, 0, second.output);
    assert.match(second.output, /"adoptedDependencyProvisioning":0,/u);
    assert.match(second.output, /"adoptedAssignees":0,/u);
  } finally {
    await prisma.task.delete({ where: { id: reviewTask.id } });
  }
});

test("a renamed canonical Agent keeps its bindings and a same-named custom Agent is left alone", async (t) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const role = "senior-dev-astra-medium";
  const canonical = await prisma.agent.findUniqueOrThrow({
    where: { projectId_canonicalRole: { projectId: project.id, canonicalRole: role } },
    select: { id: true, name: true, customizedFields: true, environmentId: true },
  });
  const boundStepIds = (await prisma.taskTemplateStep.findMany({
    where: { assigneeAgentId: canonical.id },
    select: { id: true },
    orderBy: { id: "asc" },
  })).map(({ id }) => id);
  assert.ok(boundStepIds.length > 0, "the fixture role must bind at least one canonical step");

  // R9 in one picture: the operator renames the canonical Agent and then
  // creates their own Agent under the freed slug. Both rows now answer to the
  // role's name; only one of them is the role.
  await prisma.agent.update({
    where: { id: canonical.id },
    data: { name: "house-implementer", customizedFields: ["name"] },
  });
  const custom = await prisma.agent.create({
    data: {
      projectId: project.id,
      environmentId: canonical.environmentId,
      name: role,
      title: "Operator local implementer",
      model: "custom-operator-model",
      runnerPreference: RunnerPreference.AUTO,
      inboxAccess: false,
      foundationalPrompt: "operator foundational prompt",
      rolePrompt: "operator role prompt",
    },
  });
  t.after(async () => {
    await prisma.agent.delete({ where: { id: custom.id } });
    await prisma.agent.update({
      where: { id: canonical.id },
      data: { name: canonical.name, customizedFields: canonical.customizedFields },
    });
  });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  // Nothing was adopted: the binding never moved, and the custom row was never
  // mistaken for a pre-column canonical row waiting to be claimed.
  const counters = parseCanonicalSyncSummary(synced.output).projects["agentos-example"]!;
  assert.equal(counters.adoptedAssignees, 0, synced.output);
  assert.equal(counters.assignedCanonicalRoles, 0, synced.output);
  assert.equal(counters.updated, 0, synced.output);

  const untouched = async () => prisma.agent.findUniqueOrThrow({
    where: { id: custom.id },
    select: { name: true, title: true, canonicalRole: true, customizedFields: true, model: true, rolePrompt: true },
  });
  assert.deepEqual(await untouched(), {
    name: role,
    title: "Operator local implementer",
    canonicalRole: null,
    customizedFields: [],
    model: "custom-operator-model",
    rolePrompt: "operator role prompt",
  });
  assert.deepEqual(
    (await prisma.taskTemplateStep.findMany({
      where: { id: { in: boundStepIds } },
      select: { assigneeAgentId: true },
    })).map(({ assigneeAgentId }) => assigneeAgentId),
    boundStepIds.map(() => canonical.id),
  );

  // A second sync converges: reading the binding identity by name reported the
  // rename as drift forever and re-adopted a binding that never changed.
  const again = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(again.status, 0, again.output);
  assert.equal(parseCanonicalSyncSummary(again.output).projects["agentos-example"]!.updated, 0, again.output);

  // The seed installs the same roles and must reach the same two conclusions.
  const seeded = command(["tsx", "prisma/seed.ts"]);
  assert.equal(seeded.status, 0, seeded.output);
  assert.deepEqual(await untouched(), {
    name: role,
    title: "Operator local implementer",
    canonicalRole: null,
    customizedFields: [],
    model: "custom-operator-model",
    rolePrompt: "operator role prompt",
  });
  const afterSeed = await prisma.agent.findUniqueOrThrow({
    where: { projectId_canonicalRole: { projectId: project.id, canonicalRole: role } },
    select: { id: true, name: true },
  });
  assert.deepEqual(afterSeed, { id: canonical.id, name: "house-implementer" });
});

test("sync rolls model-neutral review output across all canonical templates and carries staffing", async (t) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const templateNames = ["compound-engineer-workflow", "direct-engineer-workflow", "pr-engineer-workflow"] as const;
  const staffedAgent = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "code-reviewer-sol-high" } },
    select: { id: true },
  });
  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: project.id, name: { in: [...templateNames] } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
    orderBy: { name: "asc" },
  });
  assert.equal(templates.length, templateNames.length);

  const taskIds: string[] = [];
  const legacyTemplateIds: string[] = [];
  const legacyStepIds: string[] = [];
  const fixtures = new Map<string, {
    templateId: string;
    profileId: string;
    taskId: string;
    blindPrompt: string;
    blindOptional: boolean;
  }>();
  t.after(async () => {
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.taskTemplate.deleteMany({ where: { id: { in: legacyTemplateIds } } });
  });

  for (const template of templates) {
    const sol = template.steps.find(({ outputKind }) => outputKind === "review-findings");
    const blind = template.steps.find(({ outputKind }) => outputKind === "blind-findings");
    assert.ok(sol);
    assert.ok(blind);

    // Reconstruct the deployed output contract without changing review labels.
    await restoreModelSpecificReviewOutput(template.id);

    const profile = await prisma.staffingProfile.create({
      data: {
        projectId: project.id,
        taskTemplateId: template.id,
        name: "Operator review staffing",
        isDefault: true,
        entries: {
          create: [
            { outputKind: "sol-findings", assigneeAgentId: staffedAgent.id, include: null },
            { outputKind: "blind-findings", assigneeAgentId: staffedAgent.id, include: blind.optional ? true : null },
          ],
        },
      },
      select: { id: true },
    });
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        templateId: template.id,
        templateStepId: blind.id,
        name: `retired review evidence ${template.name}`,
        description: "instantiated task must retain the retired review label and prompt",
        assigneeAgentId: blind.assigneeAgentId,
        assigneeType: blind.assigneeType,
        status: TaskStatus.DONE,
        chainId: `model-neutral-review-${template.id}`,
        chainIndex: blind.stepIndex,
        chainLayer: blind.layer,
      },
      select: { id: true },
    });
    const reviewTask = await prisma.task.create({ data: {
      projectId: project.id, templateId: template.id, templateStepId: sol.id,
      name: "retired code review", description: "preserve legacy output protocol",
      assigneeAgentId: staffedAgent.id, assigneeType: sol.assigneeType,
      status: TaskStatus.DONE, chainId: `model-neutral-review-${template.id}`,
      chainIndex: sol.stepIndex, chainLayer: sol.layer,
      stepOutput: { create: { kind: "sol-findings", body: '{"schemaVersion":1,"findings":[]}' } },
    } });
    taskIds.push(task.id, reviewTask.id);
    legacyStepIds.push(...template.steps.map(({ id }) => id));
    fixtures.set(template.name, {
      templateId: template.id,
      profileId: profile.id,
      taskId: task.id,
      blindPrompt: blind.prompt,
      blindOptional: blind.optional,
    });
  }

  const instantiatedBefore = await snapshotInstantiatedTasks(taskIds);
  const stepsBefore = JSON.stringify(await prisma.taskTemplateStep.findMany({ where: { id: { in: legacyStepIds } }, orderBy: { id: "asc" } }));
  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.equal(await snapshotInstantiatedTasks(taskIds), instantiatedBefore);
  const stepsAfter = JSON.stringify(await prisma.taskTemplateStep.findMany({ where: { id: { in: legacyStepIds } }, orderBy: { id: "asc" } }));
  assert.equal(stepsAfter, stepsBefore);
  const summary = parseCanonicalSyncSummary(synced.output);
  assert.deepEqual(summary.refused, {});
  assert.equal(summary.projects[project.slug]?.createdCanonicalTemplates, 3, synced.output);
  assert.equal(summary.totals.createdCanonicalTemplates, 3, synced.output);

  for (const templateName of templateNames) {
    const fixture = fixtures.get(templateName)!;
    const legacyName = `${templateName}-legacy-pre-model-neutral-review-output-${fixture.templateId}`;
    const legacy = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: legacyName } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.equal(legacy.id, fixture.templateId);
    legacyTemplateIds.push(legacy.id);
    assert.equal(legacy.steps.find(({ outputKind }) => outputKind === "sol-findings")?.name, "Code review");
    assert.equal(legacy.steps.find(({ outputKind }) => outputKind === "blind-findings")?.name, "Blind code review");
    assert.deepEqual(
      await prisma.staffingProfile.findUniqueOrThrow({
        where: { id: fixture.profileId },
        select: { taskTemplateId: true, name: true, isDefault: true },
      }),
      { taskTemplateId: fixture.templateId, name: "Operator review staffing", isDefault: true },
    );

    const current = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: templateName } },
      include: { steps: { orderBy: { stepIndex: "asc" } }, staffingProfiles: { include: { entries: { orderBy: { outputKind: "asc" } } } } },
    });
    assert.notEqual(current.id, fixture.templateId);
    assert.equal(current.steps.find(({ outputKind }) => outputKind === "review-findings")?.name, "Code review");
    assert.equal(current.steps.find(({ outputKind }) => outputKind === "blind-findings")?.name, "Blind code review");

    const carried = current.staffingProfiles.find(({ id }) => id !== fixture.profileId);
    assert.ok(carried);
    assert.equal(carried.name, "Operator review staffing");
    assert.equal(carried.isDefault, true);
    assert.deepEqual(
      carried.entries.map(({ outputKind, assigneeAgentId, include }) => ({ outputKind, assigneeAgentId, include })),
      [
        { outputKind: "blind-findings", assigneeAgentId: staffedAgent.id, include: fixture.blindOptional ? true : null },
        { outputKind: "review-findings", assigneeAgentId: staffedAgent.id, include: null },
      ],
    );

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: fixture.taskId },
      include: { templateStep: true },
    });
    assert.equal(task.templateId, fixture.templateId);
    assert.equal(task.name, `retired review evidence ${templateName}`);
    assert.equal(task.templateStep?.name, "Blind code review");
    assert.equal(task.templateStep?.prompt, fixture.blindPrompt);
  }

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  assert.equal(parseCanonicalSyncSummary(second.output).totals.createdCanonicalTemplates, 0, second.output);
});

test("seed and sync preserve every seed-era legacy template identity", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const templateNames = ["direct-engineer-workflow", "compound-engineer-workflow"] as const;
  type CanonicalTemplateName = (typeof templateNames)[number];
  const loadCanonicalTemplate = async (name: CanonicalTemplateName) => prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  type CanonicalTemplate = Awaited<ReturnType<typeof loadCanonicalTemplate>>;
  const stepAt = (template: CanonicalTemplate, stepIndex: number) => {
    const step = template.steps.find(({ stepIndex: index }) => index === stepIndex);
    assert.ok(step, `${template.name} must contain step ${stepIndex}`);
    return step;
  };
  const agentId = async (name: string): Promise<string> => (
    await prisma.agent.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name } } })
  ).id;
  const [coordinatorId, integratorId, librarianId, regressionVerifierId, seniorDevId] = await Promise.all([
    agentId("review-coordinator-astra-medium"),
    agentId("merge-integrator"),
    agentId("librarian-luna-xhigh"),
    agentId("regression-verifier-luna-xhigh"),
    agentId("senior-dev-astra-medium"),
  ]);

  const legacyRows: Array<{
    canonicalName: CanonicalTemplateName;
    marker: string;
    legacyName: string;
    templateId: string;
    taskId: string;
    templateStepId: string;
  }> = [];

  const seedHistoricalRow = async (
    canonicalName: CanonicalTemplateName,
    marker: string,
    nameForTemplateId: (templateId: string) => string,
    prepare: (template: CanonicalTemplate) => Promise<void>,
  ): Promise<void> => {
    const template = await loadCanonicalTemplate(canonicalName);
    const firstStep = stepAt(template, 1);
    await prepare(template);
    const task = await prisma.task.create({ data: {
      projectId: project.id,
      templateId: template.id,
      templateStepId: firstStep.id,
      name: `seed-legacy-${canonicalName}-${marker}`,
      description: "seed-era legacy template identity fixture",
      assigneeAgentId: firstStep.assigneeAgentId,
      assigneeType: firstStep.assigneeType,
      status: TaskStatus.DONE,
      chainId: `seed-legacy-${canonicalName}-${marker}-${randomBytes(4).toString("hex")}`,
      chainIndex: firstStep.stepIndex,
      chainLayer: firstStep.layer,
    } });
    const legacyName = nameForTemplateId(template.id);
    const seeded = command(["tsx", "prisma/seed.ts"]);
    assert.equal(seeded.status, 0, seeded.output);

    const legacy = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: legacyName } },
    });
    assert.equal(legacy.id, template.id);
    assert.deepEqual(canonicalTemplateIdentity(legacy.name), { canonicalName, generation: marker });
    const current = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: canonicalName } },
    });
    assert.notEqual(current.id, template.id);
    assert.deepEqual(await prisma.task.findUniqueOrThrow({
      where: { id: task.id },
      select: { templateId: true, templateStepId: true, status: true, chainId: true },
    }), {
      templateId: template.id,
      templateStepId: firstStep.id,
      status: TaskStatus.DONE,
      chainId: task.chainId,
    });
    legacyRows.push({
      canonicalName,
      marker,
      legacyName,
      templateId: template.id,
      taskId: task.id,
      templateStepId: firstStep.id,
    });
  };

  await seedHistoricalRow(
    "compound-engineer-workflow",
    "10",
    legacyTenStepTemplateName,
    async (template) => {
      const integrator = stepAt(template, 10);
      await prisma.taskTemplateStep.deleteMany({
        where: { taskTemplateId: template.id, stepIndex: { in: [11, 12] } },
      });
      await prisma.taskTemplateStep.update({
        where: { id: integrator.id },
        data: {
          name: "Merge execution",
          assigneeAgentId: integratorId,
          assigneeType: AssigneeType.AGENT,
          outputKind: "merge-result",
          approvalGate: false,
        },
      });
    },
  );

  await seedHistoricalRow(
    "compound-engineer-workflow",
    "9",
    legacyNineStepTemplateName,
    async (template) => {
      await prisma.taskTemplateStep.deleteMany({
        where: { taskTemplateId: template.id, stepIndex: { in: [10, 11, 12] } },
      });
      await prisma.taskTemplateStep.update({
        where: { id: stepAt(template, 1).id },
        data: { approvalGate: true },
      });
      await prisma.taskTemplateStep.update({
        where: { id: stepAt(template, 4).id },
        data: { approvalGate: true },
      });
      await prisma.taskTemplateStep.update({
        where: { id: stepAt(template, 6).id },
        data: {
          name: "Code review",
          assigneeAgentId: coordinatorId,
          assigneeType: AssigneeType.AGENT,
          outputKind: "code-review",
        },
      });
      await prisma.taskTemplateStep.update({
        where: { id: stepAt(template, 7).id },
        data: {
          name: "Apply review fixes",
          assigneeAgentId: seniorDevId,
          assigneeType: AssigneeType.AGENT,
          outputKind: "fixed-implementation",
          approvalGate: false,
        },
      });
      await prisma.taskTemplateStep.update({
        where: { id: stepAt(template, 8).id },
        data: {
          name: "Librarian",
          assigneeAgentId: librarianId,
          assigneeType: AssigneeType.AGENT,
          outputKind: "documentation",
          approvalGate: false,
        },
      });
      await prisma.taskTemplateStep.update({
        where: { id: stepAt(template, 9).id },
        data: {
          name: "Approval",
          assigneeAgentId: null,
          assigneeType: AssigneeType.HUMAN,
          outputKind: "approval",
          approvalGate: true,
        },
      });
    },
  );

  await seedHistoricalRow(
    "compound-engineer-workflow",
    "human-12",
    legacyHumanTwelveStepTemplateName,
    async (template) => {
      await prisma.taskTemplateStep.update({
        where: { id: stepAt(template, 11).id },
        data: {
          name: "Approval",
          assigneeAgentId: null,
          assigneeType: AssigneeType.HUMAN,
          outputKind: "approval",
          approvalGate: true,
        },
      });
    },
  );

  await seedHistoricalRow(
    "compound-engineer-workflow",
    "regression-first-13",
    legacyRegressionFirstThirteenStepTemplateName,
    async (template) => {
      const readiness = stepAt(template, 11);
      const integrator = stepAt(template, 12);
      await prisma.taskTemplateStep.update({
        where: { id: integrator.id },
        data: { stepIndex: 13, layer: 12 },
      });
      await prisma.taskTemplateStep.update({
        where: { id: stepAt(template, 10).id },
        data: {
          assigneeAgentId: regressionVerifierId,
          assigneeType: AssigneeType.AGENT,
          outputKind: "regression-verification",
          name: "Regression verification",
        },
      });
      await prisma.taskTemplateStep.update({
        where: { id: readiness.id },
        data: {
          name: "Librarian",
          assigneeAgentId: librarianId,
          assigneeType: AssigneeType.AGENT,
          outputKind: "documentation",
          approvalGate: false,
          layer: 10,
        },
      });
      await prisma.taskTemplateStep.create({ data: {
        taskTemplateId: template.id,
        stepIndex: 12,
        layer: 11,
        name: "Merge authorization",
        assigneeAgentId: readiness.assigneeAgentId,
        assigneeType: readiness.assigneeType,
        runner: readiness.runner,
        approvalGate: false,
        optional: readiness.optional,
        outputKind: "merge-authorization",
        prompt: readiness.prompt,
        opensPullRequest: readiness.opensPullRequest,
        requiresCommit: readiness.requiresCommit,
        attachmentsFromPrevious: readiness.attachmentsFromPrevious,
        priorOutputKinds: readiness.priorOutputKinds,
        baseFromStepIndex: readiness.baseFromStepIndex,
        spawnPolicy: readiness.spawnPolicy ?? Prisma.JsonNull,
        provisionDependencies: readiness.provisionDependencies,
      } });
    },
  );

  await seedHistoricalRow(
    "direct-engineer-workflow",
    "human-6",
    legacyHumanSixStepTemplateName,
    async (template) => {
      await prisma.taskTemplateStep.deleteMany({
        where: { taskTemplateId: template.id, stepIndex: { in: [7, 8] } },
      });
      await prisma.taskTemplateStep.update({
        where: { id: stepAt(template, 6).id },
        data: {
          name: "Approval",
          assigneeAgentId: null,
          assigneeType: AssigneeType.HUMAN,
          outputKind: "approval",
          approvalGate: true,
        },
      });
    },
  );

  const legacyBeforeSync = await Promise.all(legacyRows.map(async ({ templateId, taskId, templateStepId }) => ({
    templateId,
    taskId,
    templateStepId,
    template: await prisma.taskTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    }),
    task: await prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { templateId: true, templateStepId: true, status: true, chainId: true },
    }),
  })));
  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  for (const [index, legacyRow] of legacyRows.entries()) {
    const persisted = await prisma.taskTemplate.findUniqueOrThrow({
      where: { id: legacyRow.templateId },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.equal(persisted.name, legacyRow.legacyName);
    assert.deepEqual(persisted.steps, legacyBeforeSync[index]!.template.steps);
    assert.deepEqual(canonicalTemplateIdentity(persisted.name), {
      canonicalName: legacyRow.canonicalName,
      generation: legacyRow.marker,
    });
    assert.deepEqual(await prisma.task.findUniqueOrThrow({
      where: { id: legacyRow.taskId },
      select: { templateId: true, templateStepId: true, status: true, chainId: true },
    }), legacyBeforeSync[index]!.task);
    assert.equal(await prisma.taskTemplate.count({
      where: { projectId: project.id, name: legacyRow.legacyName },
    }), 1);
  }

  const reseeded = command(["tsx", "prisma/seed.ts"]);
  assert.equal(reseeded.status, 0, reseeded.output);
  const resynced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(resynced.status, 0, resynced.output);
  for (const legacyRow of legacyRows) {
    const persisted = await prisma.taskTemplate.findUniqueOrThrow({
      where: { id: legacyRow.templateId },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.equal(persisted.name, legacyRow.legacyName);
    assert.deepEqual(persisted.steps, legacyBeforeSync.find(({ templateId }) => templateId === legacyRow.templateId)!.template.steps);
    assert.equal(await prisma.taskTemplate.count({
      where: { projectId: project.id, name: legacyRow.canonicalName },
    }), 1);
  }
});
