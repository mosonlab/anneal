import assert from "node:assert/strict";
import test from "node:test";

import { restorePreDirectAutonomyPrompt, restorePreChainWorkspaceScopePrompt, restorePreDefectClassSweepPrompt, restorePreFrozenRegressionPrompt, restorePreOptionalReviewPrompt, restorePreSemanticIntegrationSeparationOutputKind, restorePreSolHighHazardTierPrompt, restorePreSolHighHardTierPrompt, restorePreTierRevalidationPrompt } from "./canonical-prompt-sync-fixtures.js";
import { LEGACY_TEMPLATE_GENERATIONS, templatePromptGenerationDigest } from "./canonical-template-transition.js";
import { loadAllTemplateStepSources } from "./template-sources.js";

for (const marker of ["pre-runner-provided-regression-tooling", "pre-optional-review-omission"] as const) {
  test(`sync fixtures reconstruct the registered ${marker} prompt generation`, async () => {
    const sources = await loadAllTemplateStepSources();
    for (const name of ["direct-engineer-workflow", "compound-engineer-workflow"] as const) {
      const steps = sources.get(name)!.map((step) => {
        const outputKind = restorePreSemanticIntegrationSeparationOutputKind(step.outputKind);
        let prompt = restorePreDefectClassSweepPrompt(step.prompt).replaceAll("review-findings", "sol-findings").replaceAll("the code review report", "the Sol report");
        if (outputKind === "revalidation") prompt = restorePreTierRevalidationPrompt(prompt);
        if (["fixed-implementation", "regression-verification-v2"].includes(outputKind)) {
          prompt = restorePreOptionalReviewPrompt(prompt);
        }
        if (marker === "pre-runner-provided-regression-tooling" && outputKind === "regression-verification-v2") {
          prompt = prompt.replaceAll('"${AGENTOS_TOOLS:?AGENTOS_TOOLS is required}/regression-verification.sh"', ["scripts", "regression-verification.sh"].join("/"));
        }
        return { ...step, outputKind, prompt };
      });
      assert.equal(templatePromptGenerationDigest(steps), LEGACY_TEMPLATE_GENERATIONS[name].find((generation) => generation.marker === marker)!.promptDigest, name);
    }
  });
}

test("sync fixtures reconstruct the registered pre-frozen-regression-baseline generation", async () => {
  const sources = await loadAllTemplateStepSources();
  for (const name of ["direct-engineer-workflow", "compound-engineer-workflow"] as const) {
    const steps = sources.get(name)!.map((step) => ({ ...step, prompt: restorePreFrozenRegressionPrompt(step.prompt) }));
    assert.equal(templatePromptGenerationDigest(steps), LEGACY_TEMPLATE_GENERATIONS[name].find((generation) => generation.marker === "pre-frozen-regression-baseline")!.promptDigest, name);
  }
});

test("sync fixtures reconstruct the registered pre-sol-high-hard-tier generation", async () => {
  const sources = await loadAllTemplateStepSources();
  const steps = sources.get("direct-engineer-workflow")!.map((step) => ({ ...step, prompt: restorePreSolHighHardTierPrompt(step.prompt) }));
  assert.equal(
    templatePromptGenerationDigest(steps),
    LEGACY_TEMPLATE_GENERATIONS["direct-engineer-workflow"].find((generation) => generation.marker === "pre-sol-high-hard-tier")!.promptDigest,
  );
});

test("sync fixtures reconstruct the registered pre-sol-high-hazard-tier generation", async () => {
  const sources = await loadAllTemplateStepSources();
  const steps = sources.get("direct-engineer-workflow")!.map((step) => ({ ...step, prompt: restorePreSolHighHazardTierPrompt(step.prompt) }));
  assert.equal(
    templatePromptGenerationDigest(steps),
    LEGACY_TEMPLATE_GENERATIONS["direct-engineer-workflow"].find((generation) => generation.marker === "pre-sol-high-hazard-tier")!.promptDigest,
  );
});

test("sync fixtures reconstruct the registered pre-defect-class-sweep generation", async () => {
  const sources = await loadAllTemplateStepSources();
  for (const name of ["direct-engineer-workflow", "compound-engineer-workflow", "pr-engineer-workflow"] as const) {
    const steps = sources.get(name)!.map((step) => ({ ...step, prompt: restorePreDefectClassSweepPrompt(step.prompt) }));
    assert.equal(templatePromptGenerationDigest(steps), LEGACY_TEMPLATE_GENERATIONS[name].find((generation) => generation.marker === "pre-defect-class-sweep")!.promptDigest, name);
  }
});

test("sync fixtures reconstruct the registered pre-chain-workspace-scope-exemption generation", async () => {
  const sources = await loadAllTemplateStepSources();
  for (const name of ["direct-engineer-workflow", "compound-engineer-workflow"] as const) {
    const steps = sources.get(name)!.map((step) => ({ ...step, prompt: restorePreChainWorkspaceScopePrompt(step.prompt) }));
    assert.equal(templatePromptGenerationDigest(steps), LEGACY_TEMPLATE_GENERATIONS[name].find((generation) => generation.marker === "pre-chain-workspace-scope-exemption")!.promptDigest, name);
  }
});

test("sync fixtures reconstruct the deployed pre-direct-work-directed-delegation generation", async () => {
  const sources = await loadAllTemplateStepSources();
  const steps = sources.get("direct-engineer-workflow")!.map((step) => ({ ...step, prompt: restorePreDirectAutonomyPrompt(step.prompt) }));
  assert.equal(templatePromptGenerationDigest(steps), LEGACY_TEMPLATE_GENERATIONS["direct-engineer-workflow"].find((generation) => generation.marker === "pre-direct-work-directed-delegation")!.promptDigest);
});
