import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  LEGACY_TEMPLATE_GENERATIONS,
  templateRolloverName,
} from "./canonical-template-transition.js";
import {
  gateFeedsIntegratorStep,
  taskIsIntegratorStep,
  type IntegratorTask,
} from "./merge-integrator-db.js";
import { isIntegratorStep } from "./merge-integrator.js";
import { isMergeReadinessStep, REGRESSION_VERIFICATION_OUTPUT_KIND } from "./merge-tail.js";
import { stepGeneration, stepRole, type StepRole } from "./step-role.js";
import { PR_TEMPLATE_NAME } from "./agent-contract.js";
import { loadTemplateStepSources, type CanonicalTemplateName } from "./template-sources.js";
import { isCompoundImplementationStep, isDirectImplementationStep } from "./run-open.js";

const EXPECTED_ROLES: Readonly<Record<string, StepRole>> = {
  spec: "spec",
  revalidation: "revalidation",
  plan: "plan",
  "plan-review": "plan-review",
  "revised-plan": "revised-plan",
  "must-fix": "must-fix",
  implementation: "implementation",
  "review-findings": "review-findings",
  "blind-findings": "blind-findings",
  "fixed-implementation": "fixed-implementation",
  documentation: "documentation",
  "regression-verification": "regression",
  [REGRESSION_VERIFICATION_OUTPUT_KIND]: "regression",
  "merge-authorization": "readiness",
  "merge-result": "integrator",
};

// The first direct legacy generation is the persisted graph whose review kind
// predates the model-neutral review output contract. Keep the fixture as the
// source of this historical kind so this test does not re-register it.
const legacyReviewOutputKind = LEGACY_TEMPLATE_GENERATIONS["direct-engineer-workflow"][0]!.shape[1]!.outputKind;

for (const [templateName, generations] of Object.entries(LEGACY_TEMPLATE_GENERATIONS)) {
  for (const generation of generations) {
    test(`${templateName} ${generation.marker} exposes every registered Step role`, () => {
      const persistedName = templateRolloverName(templateName, generation.marker, "template-row");
      for (const step of generation.shape) {
        const { outputKind } = step;
        const generation = stepGeneration({ outputKind });
        assert.equal(stepGeneration({ outputKind, taskTemplateName: persistedName }), generation);
        assert.equal(stepGeneration({ outputKind, taskTemplate: { name: persistedName } }), generation);
        if (outputKind === legacyReviewOutputKind) {
          assert.equal(stepRole({ outputKind, taskTemplateName: persistedName }), null);
        } else {
          assert.equal(stepRole({ outputKind, taskTemplateName: persistedName }), EXPECTED_ROLES[outputKind]);
        }
      }
      const implementation = { outputKind: "implementation", taskTemplate: { name: persistedName } };
      assert.equal(isCompoundImplementationStep(implementation), templateName === "compound-engineer-workflow");
      assert.equal(isDirectImplementationStep(implementation), templateName === "direct-engineer-workflow");
    });
  }
}

for (const templateName of ["compound-engineer-workflow", "direct-engineer-workflow", PR_TEMPLATE_NAME] as const) {
  test(`${templateName} source exposes every current Step role`, async () => {
    const steps = await loadTemplateStepSources(templateName as CanonicalTemplateName);
    for (const step of steps) {
      assert.equal(stepRole(step), EXPECTED_ROLES[step.outputKind]);
      assert.equal(
        stepGeneration(step),
        step.outputKind === REGRESSION_VERIFICATION_OUTPUT_KIND || step.outputKind === "revalidation" ? "v2" : "v1",
      );
    }
  });
}

test("role normalization is generation-independent and unknown output kinds have no role", () => {
  assert.equal(stepRole({ outputKind: "regression-verification-v3" }), "regression");
  assert.equal(stepGeneration({ outputKind: "regression-verification-v3" }), "v3");
  assert.equal(stepRole({ outputKind: "revalidation-v99" }), "revalidation");
  assert.equal(stepGeneration({ outputKind: "revalidation-v99" }), "v99");
  assert.equal(stepRole({ outputKind: "unregistered-v2" }), null);
  assert.equal(stepGeneration({ outputKind: "unregistered-v2" }), "v2");
});

test("the historical review output kind is refused as an unknown Step role", () => {
  assert.equal(stepRole({ outputKind: legacyReviewOutputKind }), null);
});

test("role predicates ignore ordinals and template generations", () => {
  const integrator = { stepIndex: 1, outputKind: "merge-result", taskTemplate: { name: "retired-or-current" } };
  const readiness = { stepIndex: 99, outputKind: "merge-authorization", taskTemplateName: "retired-or-current" };
  assert.equal(isIntegratorStep(integrator), true);
  assert.equal(isMergeReadinessStep(readiness), true);
  assert.equal(isIntegratorStep({ ...integrator, outputKind: "implementation" }), false);
  assert.equal(isIntegratorStep({ stepIndex: 1 }), false);
  assert.equal(isMergeReadinessStep({ ...readiness, outputKind: "implementation" }), false);
});

test("implementation predicates retain the template seam without depending on ordinals", () => {
  const compound = { stepIndex: 99, outputKind: "implementation", taskTemplate: { name: "compound-engineer-workflow" } };
  const direct = { stepIndex: 99, outputKind: "implementation", taskTemplate: { name: "direct-engineer-workflow" } };
  assert.equal(isCompoundImplementationStep(compound), true);
  assert.equal(isDirectImplementationStep(direct), true);
  assert.equal(isCompoundImplementationStep(direct), false);
  assert.equal(isDirectImplementationStep(compound), false);
});

test("task and successor integrator predicates delegate to Step role", async () => {
  const integratorTask = {
    templateStep: { stepIndex: 1, outputKind: "merge-result", taskTemplate: { name: "any-generation" } },
  } as unknown as IntegratorTask;
  assert.equal(taskIsIntegratorStep(integratorTask), true);

  const tx = {
    task: { findFirst: async () => integratorTask },
  } as unknown as Parameters<typeof gateFeedsIntegratorStep>[0];
  assert.equal(await gateFeedsIntegratorStep(tx, { projectId: "project", chainId: "chain", chainIndex: 3 }), integratorTask);
  assert.equal(await gateFeedsIntegratorStep(tx, { projectId: "project", chainId: null, chainIndex: 3 }), null);
});

test("seed-era identities select implementation guards by canonical family", () => {
  for (const [canonicalName, markers] of [
    ["compound-engineer-workflow", ["10", "9", "human-12", "regression-first-13"]],
    ["direct-engineer-workflow", ["human-6"]],
  ] as const) {
    for (const marker of markers) {
      const taskTemplate = { name: templateRolloverName(canonicalName, marker, "persisted-row") };
      const step = { taskTemplate, outputKind: "implementation" };
      assert.equal(isCompoundImplementationStep(step), canonicalName === "compound-engineer-workflow");
      assert.equal(isDirectImplementationStep(step), canonicalName === "direct-engineer-workflow");
    }
  }
});

test("step-role is a leaf module, so no sibling can close an import cycle through it", async () => {
  // `stepGeneration` used to resolve a retired graph marker through
  // `canonical-template-transition.js`, which imports `stepRole` back: an ESM
  // cycle whose evaluation order decided whether either module saw the other's
  // bindings. Generation compatibility must stay importless, so a future
  // edit cannot reintroduce the cycle silently.
  const source = await readFile(new URL("./step-role.ts", import.meta.url), "utf8");
  assert.deepEqual(source.match(/^(?:\s*import\b|\s*export\b[^;]*\bfrom\b)|\bimport\s*\(/gmu), null);
});
