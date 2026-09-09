import assert from "node:assert/strict";
import test from "node:test";

import { restorePreFrozenRegressionPrompt, restorePreOptionalReviewPrompt, restorePreSolHighHardTierPrompt, restorePreTierRevalidationPrompt } from "./canonical-prompt-sync-fixtures.js";
import { LEGACY_TEMPLATE_GENERATIONS, templatePromptGenerationDigest } from "./canonical-template-transition.js";
import { loadAllTemplateStepSources } from "./template-sources.js";

for (const marker of ["pre-runner-provided-regression-tooling", "pre-optional-review-omission"] as const) {
  test(`sync fixtures reconstruct the registered ${marker} prompt generation`, async () => {
    const sources = await loadAllTemplateStepSources();
    for (const name of ["direct-engineer-workflow", "compound-engineer-workflow"] as const) {
      const steps = sources.get(name)!.map((step) => {
        let prompt = step.prompt.replaceAll("review-findings", "sol-findings").replaceAll("the code review report", "the Sol report");
        if (step.outputKind === "revalidation") prompt = restorePreTierRevalidationPrompt(prompt);
        if (["fixed-implementation", "regression-verification-v2"].includes(step.outputKind)) {
          prompt = restorePreOptionalReviewPrompt(prompt);
        }
        if (marker === "pre-runner-provided-regression-tooling" && step.outputKind === "regression-verification-v2") {
          prompt = prompt.replaceAll('"${AGENTOS_TOOLS:?AGENTOS_TOOLS is required}/regression-verification.sh"', ["scripts", "regression-verification.sh"].join("/"));
        }
        return { ...step, prompt };
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
