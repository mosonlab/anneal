import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RunnerPreference } from "@prisma/client";

import {
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  integratorBindingValid,
} from "../src/merge-integrator.js";

import {
  loadAgentSources,
  type PersistedRoleStructure,
  roleSourceStructureDifferences,
} from "../src/agent-sources.js";
import {
  assertCanonicalAgentSources,
  catalogRunnerForModel,
  DIRECT_TEMPLATE_NAME,
  PR_TEMPLATE_NAME,
} from "../src/agent-contract.js";
import {
  CANONICAL_TEMPLATE_SOURCE_SPECS,
  loadAllTemplateStepSources,
  loadTemplateStepSources,
  type PersistedTemplateStepStructure,
  templateStepStructureDifferences,
} from "../src/template-sources.js";

const rolesRoot = fileURLToPath(new URL("../../../agents/roles/", import.meta.url));
const prismaRoot = fileURLToPath(new URL("./", import.meta.url));

const roleSource = (name: string): Promise<string> => readFile(`${rolesRoot}${name}.md`, "utf8");

const frontmatterValue = (source: string, key: string): string => {
  const match = source.match(new RegExp(`^${key}:\\s*(.+)$`, "mu"));
  assert.ok(match, `role source must declare ${key}`);
  return match[1].trim();
};

test("canonical role frontmatter matches the Prisma seed contract", async () => {
  const files = (await readdir(rolesRoot)).filter((file) => file.endsWith(".md")).sort();
  const roles = await Promise.all(files.map(async (file) => {
    const source = await readFile(`${rolesRoot}${file}`, "utf8");
    const runner = frontmatterValue(source, "runner").toUpperCase();
    assert.ok(runner in RunnerPreference, `${file} must declare a supported runner`);
    return {
      // The file name is the canonical role; the contract refuses a file whose
      // frontmatter names a different role, so both are read from the source.
      canonicalRole: file.slice(0, -".md".length),
      name: frontmatterValue(source, "name"),
      title: frontmatterValue(source, "title"),
      model: frontmatterValue(source, "model"),
      runnerPreference: RunnerPreference[runner as keyof typeof RunnerPreference],
    };
  }));

  for (const { name, model, runnerPreference } of roles) {
    assert.equal(model.startsWith("openai-codex/"), false, name);
    assert.notEqual(runnerPreference, RunnerPreference.PI, name);
  }
  assert.doesNotThrow(() => assertCanonicalAgentSources(roles));
});

/** The Markdown body of a role source, without its frontmatter block. */
const bodyOf = (source: string): string => source.split("---\n").slice(2).join("---\n");

test("canonical OpenAI roles pin their Codex model and runner", async () => {
  const [reviewCoordinator, reviewCoordinatorSol, librarian, specRevalidator, seniorDev, reviewFix] = await Promise.all([
    roleSource("review-coordinator-astra-medium"),
    roleSource("code-reviewer-sol-high"),
    roleSource("librarian-luna-xhigh"),
    roleSource("spec-revalidator-luna-xhigh"),
    roleSource("senior-dev-astra-medium"),
    roleSource("senior-dev-astra-low"),
  ]);

  assert.equal(frontmatterValue(reviewCoordinator, "model"), "gpt-6-astra:medium");
  assert.equal(frontmatterValue(reviewCoordinator, "runner"), "codex");
  assert.equal(frontmatterValue(reviewCoordinatorSol, "model"), "gpt-5.6-sol:high");
  assert.equal(frontmatterValue(reviewCoordinatorSol, "runner"), "codex");
  assert.equal(frontmatterValue(librarian, "model"), "gpt-5.6-luna:xhigh");
  assert.equal(frontmatterValue(librarian, "runner"), "codex");
  assert.equal(frontmatterValue(specRevalidator, "model"), "gpt-5.6-luna:xhigh");
  assert.equal(frontmatterValue(specRevalidator, "runner"), "codex");
  assert.equal(frontmatterValue(seniorDev, "model"), "gpt-6-astra:medium");
  assert.equal(frontmatterValue(seniorDev, "runner"), "codex");
  assert.equal(frontmatterValue(reviewFix, "model"), "gpt-6-astra:low");
  assert.equal(frontmatterValue(reviewFix, "runner"), "codex");
  assert.equal(reviewFix.rolePrompt, seniorDev.rolePrompt);
});

test("canonical role slugs spell role-model-effort and titles name the role only", async () => {
  const modelShortNames = ["astra", "luna", "sol", "opus", "fable"];
  const effortWords = ["low", "medium", "high", "xhigh", "max"];
  const exemptions = new Set(["default", INTEGRATOR_AGENT_NAME]);

  for (const role of (await loadAgentSources()).roles) {
    const words = role.title.trim().split(/\s+/u);
    assert.ok(words.length <= 2, `${role.name} title must name the role in at most two words`);
    for (const word of words) {
      assert.equal(modelShortNames.includes(word.toLowerCase()), false, `${role.name} title must not name a model`);
      assert.equal(effortWords.includes(word.toLowerCase()), false, `${role.name} title must not name an effort`);
    }
    if (exemptions.has(role.name)) continue;
    const [modelName, effort] = role.model.split(":");
    const shortName = modelName!.split("-").find((part) => modelShortNames.includes(part));
    assert.ok(shortName, `${role.name} must run a catalog model with a known short name`);
    assert.ok(
      role.name.endsWith(`-${shortName}-${effort}`),
      `${role.name} must end in -${shortName}-${effort} to match its model and effort`,
    );
  }
});

test("canonical profiles start at Default and native child capability replaces Agent subprocess profiles", async () => {
  const [seed, publishedMigration, historicalRepair, nativeMigration] = await Promise.all([
    readFile(`${prismaRoot}seed.ts`, "utf8"),
    readFile(`${prismaRoot}migrations/20260823010000_codex_service_tier/migration.sql`, "utf8"),
    readFile(`${prismaRoot}migrations/20260823033000_executioner_subprocess_profiles/migration.sql`, "utf8"),
    readFile(`${prismaRoot}migrations/20260824010000_native_implementation_subagents/migration.sql`, "utf8"),
  ]);

  assert.match(seed, /create:\s*\{[\s\S]*codexServiceTier: CodexServiceTier\.DEFAULT,/u);
  assert.doesNotMatch(seed, /CodexServiceTier\.FAST/u);
  assert.match(publishedMigration, /UPDATE\s+"Agent"[\s\S]*"codexServiceTier"\s*=\s*'fast'/u);
  assert.match(publishedMigration, /ADD COLUMN "codexServiceTier" "CodexServiceTier" NOT NULL DEFAULT 'default'/u);
  assert.match(historicalRepair, /migration\."finished_at" IS NOT NULL/u);
  assert.match(historicalRepair, /agent\."updatedAt" < migration\."finished_at"/u);
  assert.match(nativeMigration, /ADD COLUMN "subagentModel" TEXT/u);
  assert.match(nativeMigration, /"subagentModel" = 'gpt-5\.6-luna:max'/u);
  assert.match(nativeMigration, /"subagentMaxConcurrent" = 8/u);
  assert.match(nativeMigration, /DROP COLUMN "ordinarySubprocessModel"/u);
  assert.match(nativeMigration, /DROP COLUMN "elevatedSubprocessModel"/u);
});

test("template-step dependency provisioning is a non-null true-default migration", async () => {
  const schema = await readFile(`${prismaRoot}schema.prisma`, "utf8");
  const migration = await readFile(`${prismaRoot}migrations/20260901010000_task_template_step_dependency_provisioning/migration.sql`, "utf8");
  assert.match(schema, /provisionDependencies\s+Boolean\s+@default\(true\)/u);
  assert.match(migration, /ALTER TABLE "TaskTemplateStep"[\s\S]*ADD COLUMN "provisionDependencies" BOOLEAN NOT NULL DEFAULT true;/u);
  assert.doesNotMatch(migration, /DROP|UPDATE|CREATE TYPE/u);
});

test("named canonical roles use their model catalog runner and retired role names stay absent", async () => {
  const canonical = new Map((await loadAgentSources()).roles.map((role) => [role.name, role]));
  for (const name of [
    "spec-opus-high",
    "code-reviewer-opus-high",
    "frontend-dev-opus-medium",
    "frontend-dev-opus-high",
    "review-coordinator-astra-medium",
    "code-reviewer-sol-high",
    "regression-verifier-luna-xhigh",
    "librarian-luna-xhigh",
    "senior-dev-astra-medium",
    "senior-dev-sol-high",
    "senior-dev-opus-medium",
    "senior-dev-opus-high",
    "senior-dev-astra-low",
    "spec-revalidator-luna-xhigh",
    "plan-executor-astra-medium",
  ]) {
    const role = canonical.get(name);
    assert.ok(role, `role source must contain ${name}`);
    assert.equal(catalogRunnerForModel(role.model), role.runnerPreference);
  }
  assert.equal(canonical.has("senior-dev-high"), false);
  assert.equal(canonical.has("review-adjudicator-opus"), false);
});

/**
 * The two frontend roles are one prompt at two efforts: the only permitted
 * difference is the `name` and `model` frontmatter lines, so a prompt edit that
 * lands on one file and not the other stops here rather than in production.
 */
test("the frontend roles differ only in their name and model frontmatter lines", async () => {
  const [medium, high] = await Promise.all([
    roleSource("frontend-dev-opus-medium"),
    roleSource("frontend-dev-opus-high"),
  ]);

  assert.equal(frontmatterValue(high, "name"), "frontend-dev-opus-high");
  assert.equal(frontmatterValue(high, "model"), "claude-opus-5:high");
  assert.equal(frontmatterValue(medium, "model"), "claude-opus-5:medium");

  const withoutNameAndModelLines = (source: string): string[] => source
    .split("\n")
    .filter((line) => !/^(name|model):/u.test(line));
  assert.deepEqual(withoutNameAndModelLines(high), withoutNameAndModelLines(medium));
  assert.equal(bodyOf(high), bodyOf(medium));
});

/**
 * The two senior-dev Opus roles are one prompt at two efforts: the only
 * permitted difference is the `name` and `model` frontmatter lines, so a prompt
 * edit that lands on one file and not the other stops here rather than in
 * production.
 */
test("the senior-dev Opus roles differ only in their name and model frontmatter lines", async () => {
  const [medium, high] = await Promise.all([
    roleSource("senior-dev-opus-medium"),
    roleSource("senior-dev-opus-high"),
  ]);

  assert.equal(frontmatterValue(high, "name"), "senior-dev-opus-high");
  assert.equal(frontmatterValue(high, "model"), "claude-opus-5:high");
  assert.equal(frontmatterValue(medium, "model"), "claude-opus-5:medium");

  const withoutNameAndModelLines = (source: string): string[] => source
    .split("\n")
    .filter((line) => !/^(name|model):/u.test(line));
  assert.deepEqual(withoutNameAndModelLines(high), withoutNameAndModelLines(medium));
  assert.equal(bodyOf(high), bodyOf(medium));
});

test("the split review prompts enforce persisted-range, blindness, and regression contracts", async () => {
  const [planReview, firstReview, blindReview, regressionVerification] = await Promise.all([
    roleSource("review-coordinator-astra-medium"),
    roleSource("code-reviewer-sol-high"),
    roleSource("code-reviewer-opus-high"),
    roleSource("regression-verifier-luna-xhigh"),
  ]);

  assert.match(planReview, /never review implementation\s+diffs/u);
  assert.match(planReview, /acceptance criterion fail at the frozen base commit/u);
  assert.match(planReview, /mislabelled risk\s+flags/u);

  // Both reviewer roles share one prompt body: the Sol two-pass discipline, but
  // taking the reviewed range from the platform-pinned claim metadata so the
  // blind step can carry the same text without reading another step's output.
  assert.equal(bodyOf(firstReview), bodyOf(blindReview));

  for (const review of [firstReview, blindReview]) {
    assert.match(review, /platform-pinned claim metadata/u);
    assert.match(review, /`implementationBaseSha` and `implementationHeadSha`/u);
    assert.match(review, /complete `base\.\.\.head` diff/u);
    assert.match(review, /approved specification from\s+`\.chain\/<chain branch>\/spec\.md`/u);
    assert.match(review, /revised slice set from\s+`\.chain\/<chain branch>\/slices\/`/u);
    assert.match(review, /only as the Anneal task output/u);
    assert.match(review, /the step prompt names/u);
    assert.doesNotMatch(review, /reviews\/sol-findings\.md/u);
    assert.match(review, /quote the exact governing\s+specification text/u);
    assert.match(review, /one session, make two sequential explicit passes over the same reviewed range/u);
    assert.match(review, /first complete the Standards pass/u);
    assert.match(review, /only then start a separate Spec pass/u);
    assert.match(review, /merge both passes into one persisted report/u);
    assert.doesNotMatch(review, /codex exec review/u);
    assert.doesNotMatch(review, /service[-_ ]tier/iu);
    assert.doesNotMatch(review, /merge matrix/u);
    // The 2026-08-25 incident: this role ran the full merge gate inside its review
    // step, deadlocked the host twice, and recorded the interrupted gate's FAIL
    // line as review evidence. The gate belongs to the later regression step.
    assert.match(review, /repository merge gate is not yours to run/u);
    assert.match(review, /a gate\s+that is interrupted reports no verdict at all/u);
    // The blind step forbids predecessor and sibling evidence, so the shared body
    // may never send a reviewer to another step's persisted output. Post-fix
    // regression verification lives in the regression role, not here.
    assert.doesNotMatch(review, /persisted output/u);
    assert.doesNotMatch(review, /predecessor|sibling/u);
    assert.doesNotMatch(review, /post-fix regression verification/u);
    assert.doesNotMatch(review, /adjudicate findings/u);
  }

  assert.equal(frontmatterValue(regressionVerification, "model"), "gpt-5.6-luna:xhigh");
  assert.equal(frontmatterValue(regressionVerification, "runner"), "codex");
  assert.equal(frontmatterValue(regressionVerification, "inboxAccess"), "false");
  assert.match(regressionVerification, /complete persisted review package/u);
  assert.match(regressionVerification, /Review the whole fix diff/u);
  assert.match(regressionVerification, /platform script prepares the refreshed tree/u);
  assert.match(regressionVerification, /never[\s\S]*operate the merge lease[\s\S]*author the final task output/u);
  assert.doesNotMatch(regressionVerification, /blind reports mechanically/u);
  // The 2026-09-02 incident: this role adopted the fix step's own "pre-existing
  // baseline" label for three failures that chain's own diff had caused, one of
  // which was a rejected approval gate replayed as a success, and finalized.
  // The merge gate caught all three, so the independent verification step had
  // contributed nothing.
  assert.match(regressionVerification, /is not evidence/u);
  assert.match(regressionVerification, /Dismiss one only on a cause you named and observed/u);
  assert.match(regressionVerification, /never environmental/u);
});

test("the executioner delegates only through platform-pinned native Luna children", async () => {
  const executioner = await roleSource("plan-executor-astra-medium");
  assert.equal(frontmatterValue(executioner, "model"), "gpt-6-astra:medium");
  assert.match(executioner, /pins every native child to Luna max/u);
  assert.match(executioner, /eight concurrent child threads/u);
  assert.match(executioner, /Delegation is not one slice per child/u);
  assert.match(executioner, /one long-lived Luna max merger child/u);
  assert.match(executioner, /Do not run a Merge Gate or repository-wide suite during Implementation/u);
  assert.doesNotMatch(executioner, /codex exec/u);
});

test("the canonical twelve-step layered template sources split review and preserve mechanical merge", async () => {
  const templateSteps = await loadTemplateStepSources();
  assert.equal(templateSteps.length, 12);
  assert.deepEqual(
    templateSteps.map(({ stepIndex, layer, agentName, outputKind }) => ({ stepIndex, layer, agentName, outputKind })),
    [
      { stepIndex: 1, layer: 1, agentName: "spec-opus-high", outputKind: "spec" },
      { stepIndex: 2, layer: 2, agentName: "plan-fable-medium", outputKind: "plan" },
      { stepIndex: 3, layer: 3, agentName: "review-coordinator-astra-medium", outputKind: "plan-review" },
      { stepIndex: 4, layer: 4, agentName: "plan-reviser-opus-high", outputKind: "revised-plan" },
      { stepIndex: 5, layer: 5, agentName: "plan-executor-astra-medium", outputKind: "implementation" },
      { stepIndex: 6, layer: 6, agentName: "code-reviewer-sol-high", outputKind: "sol-findings" },
      { stepIndex: 7, layer: 6, agentName: "code-reviewer-opus-high", outputKind: "blind-findings" },
      { stepIndex: 8, layer: 7, agentName: "senior-dev-astra-low", outputKind: "fixed-implementation" },
      { stepIndex: 9, layer: 8, agentName: "librarian-luna-xhigh", outputKind: "documentation" },
      { stepIndex: 10, layer: 9, agentName: "regression-verifier-luna-xhigh", outputKind: "regression-verification-v2" },
      { stepIndex: 11, layer: 10, agentName: "review-coordinator-astra-medium", outputKind: "merge-authorization" },
      { stepIndex: 12, layer: 11, agentName: "merge-integrator", outputKind: "merge-result" },
    ],
  );
  assert.deepEqual(templateSteps.map(({ optional }) => optional), [false, false, false, false, false, false, true, false, false, false, false, false]);
  assert.equal(templateSteps.some((step) => step.agentName === "code-reviewer"), false);
  assert.equal(templateSteps.find((step) => step.stepIndex === 6)?.baseFromStepIndex, 5);
  assert.equal(templateSteps.find((step) => step.stepIndex === 7)?.attachmentsFromPrevious, false);
  assert.equal(templateSteps.find((step) => step.stepIndex === 8)?.attachmentsFromPrevious, true);
  assert.equal(templateSteps.find((step) => step.stepIndex === 10)?.attachmentsFromPrevious, true);
  const compoundFix = templateSteps.find((step) => step.stepIndex === 8)!.prompt;
  assert.match(compoundFix, /Read the immutable `sol-findings` review output/u);
  assert.match(compoundFix, /`sol-findings`[\s\S]*`blind-findings`/u);
  assert.match(compoundFix, /blind review may be absent/u);
  assert.match(compoundFix, /No adjudication step stands between the reviews and this one/u);
  assert.match(compoundFix, /ADOPTED[\s\S]*REJECTED[\s\S]*MERGED/u);
  const compoundRegression = templateSteps.find((step) => step.stepIndex === 10)!.prompt;
  assert.match(compoundRegression, /platform script owns refresh\/merge[\s\S]*final `regression-verification-v2`/u);
  assert.match(compoundRegression, /\$\{AGENTOS_TOOLS:\?AGENTOS_TOOLS is required\}\/regression-verification\.sh" prepare/u);
  assert.match(compoundRegression, /\$\{AGENTOS_TOOLS:\?AGENTOS_TOOLS is required\}\/regression-verification\.sh" review-fail/u);
  assert.match(compoundRegression, /\$\{AGENTOS_TOOLS:\?AGENTOS_TOOLS is required\}\/regression-verification\.sh" finalize/u);
  assert.match(compoundRegression, /finalize exit 77[\s\S]*Repeat the full semantic verification/u);
  assert.match(compoundRegression, /implementation summary,\s+every present review report/u);
  assert.match(compoundRegression, /blind review report may be absent/u);
  assert.match(compoundRegression, /fixed implementation with its dispositions/u);
  assert.doesNotMatch(compoundRegression, /all\s+preceding Step outputs/u);
  assert.doesNotMatch(compoundRegression, /merge-lease\.sh|gate-dispatch\.sh|gateProof/u);
  const directRegression = (await loadTemplateStepSources(DIRECT_TEMPLATE_NAME))
    .find((step) => step.stepIndex === 6)!.prompt;
  assert.equal(compoundRegression, directRegression);
  assert.equal(templateSteps.every((step) => step.prompt.length > 0), true);
  assert.equal(templateSteps.every((step) => step.spawnPolicy === null), true);
  assert.match(templateSteps[1]!.prompt, /load-bearing decisions in `decisions\.md`/u);
  assert.doesNotMatch(templateSteps[1]!.prompt, /sessions\.md|plan_authoring/u);
  assert.match(templateSteps[1]!.prompt, /chain-level evidence, including the repository Merge Gate, remains outside the slice set/u);
  assert.match(templateSteps[2]!.prompt, /merge or split decisions priced against frontier width/u);
  assert.match(templateSteps[3]!.prompt, /Start a fresh session — never resume the planning conversation/u);
  assert.match(templateSteps[3]!.prompt, /rewrite its `decisions\.md` entry/u);
  assert.doesNotMatch(templateSteps[3]!.prompt, /sessions\.md|plan_authoring|plan_revision/u);
  assert.match(templateSteps[4]!.prompt, /platform-pinned Implementation proof boundary/u);
});

test("only artifact-producing steps require a commit, only implementation opens a pull request, and the integrator is not a model row", async () => {
  const templateSteps = await loadTemplateStepSources();
  const requiringCommit = templateSteps.filter((step) => step.requiresCommit).map((step) => step.stepIndex);
  assert.deepEqual(requiringCommit, [2, 5]);
  const opening = templateSteps.filter((step) => step.opensPullRequest).map((step) => step.stepIndex);
  assert.deepEqual(opening, [5]);
  const integrator = templateSteps.find((step) => step.stepIndex === INTEGRATOR_STEP_INDEX)!;
  assert.equal(integrator.agentName, INTEGRATOR_AGENT_NAME);
  assert.equal(integrator.outputKind, INTEGRATOR_OUTPUT_KIND);
  assert.equal(integrator.approvalGate, false);

  const sentinel = (await loadAgentSources()).roles.find((agent) => agent.name === INTEGRATOR_AGENT_NAME);
  assert.ok(sentinel);
  assert.equal(sentinel.model, INTEGRATOR_SENTINEL_MODEL);
  assert.equal(sentinel.runnerPreference, RunnerPreference.INHERIT);
  // The load-bearing property: no model-CLI runner is derivable from this
  // string, so `assertCanonicalAgentSources`' runner/model mismatch check
  // cannot fire on it and nothing maps it onto a real adapter.
  assert.equal(catalogRunnerForModel(sentinel.model), null);
});

test("only canonical code-review rows disable dependency provisioning", async () => {
  const templates = await loadAllTemplateStepSources();
  const disabled = [...templates].flatMap(([templateName, steps]) => steps
    .filter((step) => !step.provisionDependencies)
    .map((step) => `${templateName}:${step.stepIndex}`));
  assert.deepEqual(disabled, [
    `${INTEGRATOR_TEMPLATE_NAME}:6`,
    `${INTEGRATOR_TEMPLATE_NAME}:7`,
    `${DIRECT_TEMPLATE_NAME}:3`,
    `${DIRECT_TEMPLATE_NAME}:4`,
    `${PR_TEMPLATE_NAME}:2`,
    `${PR_TEMPLATE_NAME}:3`,
  ]);
  assert.equal([...templates.values()].flat().every((step) => step.provisionDependencies === true || step.provisionDependencies === false), true);
});

test("the direct template sources expose the layered review spine and mechanical tail", async () => {
  const directTemplateSteps = await loadTemplateStepSources(DIRECT_TEMPLATE_NAME);
  assert.deepEqual(
    directTemplateSteps.map(({ stepIndex, layer, agentName, outputKind }) => ({ stepIndex, layer, agentName, outputKind })),
    [
      { stepIndex: 1, layer: 1, agentName: "spec-revalidator-luna-xhigh", outputKind: "revalidation" },
      { stepIndex: 2, layer: 2, agentName: "senior-dev-luna-max", outputKind: "implementation" },
      { stepIndex: 3, layer: 3, agentName: "code-reviewer-sol-high", outputKind: "sol-findings" },
      { stepIndex: 4, layer: 3, agentName: "code-reviewer-opus-high", outputKind: "blind-findings" },
      { stepIndex: 5, layer: 4, agentName: "senior-dev-astra-low", outputKind: "fixed-implementation" },
      { stepIndex: 6, layer: 5, agentName: "regression-verifier-luna-xhigh", outputKind: "regression-verification-v2" },
      { stepIndex: 7, layer: 6, agentName: "review-coordinator-astra-medium", outputKind: "merge-authorization" },
      { stepIndex: 8, layer: 7, agentName: "merge-integrator", outputKind: "merge-result" },
    ],
  );
  assert.deepEqual(directTemplateSteps.map(({ optional }) => optional), [false, false, false, true, false, false, false, false]);
  // Only implementation opens the chain's pull request; the blind review
  // starts blind; regression verification reads the fix diff.
  assert.deepEqual(directTemplateSteps.filter((step) => step.requiresCommit).map((step) => step.stepIndex), [2]);
  assert.deepEqual(directTemplateSteps.filter((step) => step.opensPullRequest).map((step) => step.stepIndex), [2]);
  assert.equal(directTemplateSteps.find((step) => step.stepIndex === 3)?.baseFromStepIndex, 2);
  assert.equal(directTemplateSteps.find((step) => step.stepIndex === 4)?.attachmentsFromPrevious, false);
  assert.equal(directTemplateSteps.find((step) => step.stepIndex === 5)?.attachmentsFromPrevious, true);
  assert.equal(directTemplateSteps.find((step) => step.stepIndex === 6)?.attachmentsFromPrevious, true);
  const directFix = directTemplateSteps.find((step) => step.stepIndex === 5)!.prompt;
  assert.match(directFix, /Read the immutable `sol-findings` review output/u);
  assert.match(directFix, /blind review may be absent/u);
  assert.match(directFix, /No adjudication step stands between the reviews and this one/u);
  const directRegression = directTemplateSteps.find((step) => step.stepIndex === 6)!.prompt;
  assert.match(directRegression, /\$\{AGENTOS_TOOLS:\?AGENTOS_TOOLS is required\}\/regression-verification\.sh" prepare/u);
  assert.match(directRegression, /\$\{AGENTOS_TOOLS:\?AGENTOS_TOOLS is required\}\/regression-verification\.sh" review-fail/u);
  assert.match(directRegression, /\$\{AGENTOS_TOOLS:\?AGENTOS_TOOLS is required\}\/regression-verification\.sh" finalize/u);
  assert.match(directRegression, /finalize exit 77[\s\S]*Repeat the full semantic verification/u);
  assert.doesNotMatch(directRegression, /merge-lease\.sh|gate-dispatch\.sh|gateProof/u);
  const directImplementation = directTemplateSteps.find((step) => step.stepIndex === 2)!.prompt;
  assert.match(directImplementation, /brief is the specification of record/u);
  assert.doesNotMatch(directImplementation, /Copy the brief verbatim/u);
  assert.match(
    directImplementation,
    /The platform materializes `\.chain\/\{\{branchName\}\}\/spec\.md` as the specification of record; leave it untouched\./u,
  );
  assert.match(directImplementation, /at least two child-writer branches need integration/u);
  assert.match(directImplementation, /integrate a sole child-writer branch yourself/u);
  assert.match(directImplementation, /resolves only mechanical conflicts[\s\S]*reports semantic conflicts to you/u);
  assert.match(directImplementation, /platform-pinned Implementation proof boundary/u);
  assert.match(directTemplateSteps[6]!.prompt, /server-owned mechanical readiness step/u);
  // Readiness is server-owned and the terminal step is the sentinel-bound
  // mechanical executor, with no human approval gate on either.
  const last = directTemplateSteps.at(-1)!;
  assert.equal(last.approvalGate, false);
  assert.equal(last.agentName, INTEGRATOR_AGENT_NAME);
  for (const step of directTemplateSteps) {
    assert.equal(
      integratorBindingValid(step.agentName, { stepIndex: step.stepIndex, outputKind: step.outputKind, taskTemplate: { name: DIRECT_TEMPLATE_NAME } }),
      true,
    );
  }
});

test("the complete template source inventory contains exactly the three canonical workflows", async () => {
  const templates = await loadAllTemplateStepSources();
  assert.deepEqual([...templates.keys()], [INTEGRATOR_TEMPLATE_NAME, DIRECT_TEMPLATE_NAME, PR_TEMPLATE_NAME]);
  assert.equal(templates.get(INTEGRATOR_TEMPLATE_NAME)?.length, 12);
  assert.equal(templates.get(DIRECT_TEMPLATE_NAME)?.length, 8);
  assert.equal(templates.get(PR_TEMPLATE_NAME)?.length, 4);
});

test("the complete template source inventory rejects an unregistered workflow directory", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "agentos-template-sources-"));
  try {
    await Promise.all(CANONICAL_TEMPLATE_SOURCE_SPECS.map(({ name }) => mkdir(join(sourceRoot, name))));
    await mkdir(join(sourceRoot, "unregistered-workflow"));
    await assert.rejects(
      loadAllTemplateStepSources(sourceRoot),
      /canonical template inventory must be exactly/u,
    );
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("the complete template source inventory rejects a missing workflow or non-directory entry", async () => {
  const missingRoot = await mkdtemp(join(tmpdir(), "agentos-template-sources-missing-"));
  const fileRoot = await mkdtemp(join(tmpdir(), "agentos-template-sources-file-"));
  try {
    await mkdir(join(missingRoot, INTEGRATOR_TEMPLATE_NAME));
    await assert.rejects(loadAllTemplateStepSources(missingRoot), /canonical template inventory must be exactly/u);

    await mkdir(join(fileRoot, INTEGRATOR_TEMPLATE_NAME));
    await writeFile(join(fileRoot, DIRECT_TEMPLATE_NAME), "not a directory\n");
    await assert.rejects(loadAllTemplateStepSources(fileRoot), /must contain only canonical template directories/u);
  } finally {
    await Promise.all([
      rm(missingRoot, { recursive: true, force: true }),
      rm(fileRoot, { recursive: true, force: true }),
    ]);
  }
});

test("canonical prompt sync can detect every Markdown-owned structural field", async () => {
  const expected = (await loadTemplateStepSources(DIRECT_TEMPLATE_NAME))[0]!;
  const persisted: PersistedTemplateStepStructure = {
    name: expected.name,
    assigneeAgent: { name: expected.agentName! },
    assigneeType: "AGENT",
    layer: expected.layer,
    approvalGate: expected.approvalGate,
    optional: expected.optional,
    outputKind: expected.outputKind,
    attachmentsFromPrevious: expected.attachmentsFromPrevious,
    priorOutputKinds: expected.priorOutputKinds,
    opensPullRequest: expected.opensPullRequest,
    requiresCommit: expected.requiresCommit,
    provisionDependencies: expected.provisionDependencies,
    baseFromStepIndex: expected.baseFromStepIndex,
    spawnPolicy: expected.spawnPolicy,
  };
  assert.deepEqual(templateStepStructureDifferences(persisted, expected), []);
  const mutations: Array<[string, PersistedTemplateStepStructure]> = [
    ["name", { ...persisted, name: "Different display name" }],
    ["agent", { ...persisted, assigneeAgent: { name: "different-agent" } }],
    ["assigneeType", { ...persisted, assigneeType: "HUMAN" }],
    ["layer", { ...persisted, layer: expected.layer + 1 }],
    ["approvalGate", { ...persisted, approvalGate: !persisted.approvalGate }],
    ["optional", { ...persisted, optional: !persisted.optional }],
    ["outputKind", { ...persisted, outputKind: "different-output" }],
    ["attachmentsFromPrevious", { ...persisted, attachmentsFromPrevious: !persisted.attachmentsFromPrevious }],
    ["priorOutputKinds", { ...persisted, priorOutputKinds: ["different-output"] }],
    ["opensPullRequest", { ...persisted, opensPullRequest: !persisted.opensPullRequest }],
    ["requiresCommit", { ...persisted, requiresCommit: !persisted.requiresCommit }],
    ["provisionDependencies", { ...persisted, provisionDependencies: !persisted.provisionDependencies }],
    ["baseFromStepIndex", { ...persisted, baseFromStepIndex: 0 }],
    ["spawnPolicy", { ...persisted, spawnPolicy: { tier: "sub" } }],
  ];
  for (const [field, mutation] of mutations) {
    assert.deepEqual(templateStepStructureDifferences(mutation, expected), [field]);
  }
});

test("canonical prompt sync can detect every role frontmatter field", async () => {
  const role = (await loadAgentSources()).roles.find(({ name }) => name === "librarian-luna-xhigh")!;
  const persisted: PersistedRoleStructure = {
    name: role.name,
    title: role.title,
    model: role.model,
    runnerPreference: role.runnerPreference,
    inboxAccess: role.inboxAccess,
    collaborators: role.collaborators.map((name) => ({ allowedAgent: { name } })),
  };
  assert.deepEqual(roleSourceStructureDifferences(persisted, role), []);
  const mutations: Array<[string, PersistedRoleStructure]> = [
    ["name", { ...persisted, name: "different-name" }],
    ["title", { ...persisted, title: "Different title" }],
    ["model", { ...persisted, model: "different-model" }],
    ["runnerPreference", { ...persisted, runnerPreference: RunnerPreference.CLAUDE }],
    ["inboxAccess", { ...persisted, inboxAccess: !persisted.inboxAccess }],
    ["collaborators", { ...persisted, collaborators: [{ allowedAgent: { name: "default" } }] }],
  ];
  for (const [field, mutation] of mutations) {
    assert.deepEqual(roleSourceStructureDifferences(mutation, role), [field]);
  }
});

test("the sentinel may bind only step 12, and step 12 only the sentinel", () => {
  const step12 = { stepIndex: INTEGRATOR_STEP_INDEX, outputKind: INTEGRATOR_OUTPUT_KIND, taskTemplate: { name: INTEGRATOR_TEMPLATE_NAME } };
  const step5 = { stepIndex: 5, outputKind: "implementation", taskTemplate: { name: INTEGRATOR_TEMPLATE_NAME } };
  assert.equal(integratorBindingValid(INTEGRATOR_AGENT_NAME, step12), true);
  assert.equal(integratorBindingValid("senior-dev-astra-medium", step5), true);
  assert.equal(integratorBindingValid(INTEGRATOR_AGENT_NAME, step5), false);
  assert.equal(integratorBindingValid("senior-dev-astra-medium", step12), false);
  assert.equal(integratorBindingValid(INTEGRATOR_AGENT_NAME, null), false);
});
