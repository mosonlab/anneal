export type StepRole =
  | "spec"
  | "revalidation"
  | "plan"
  | "plan-review"
  | "revised-plan"
  | "must-fix"
  | "implementation"
  | "review-findings"
  | "blind-findings"
  | "fixed-implementation"
  | "documentation"
  | "regression"
  | "readiness"
  | "integrator";

export type TemplateStepLike = {
  outputKind: string;
  taskTemplate?: { name: string } | null;
  taskTemplateName?: string | null;
};

const OUTPUT_KIND_ROLES: Readonly<Record<string, StepRole>> = {
  spec: "spec",
  revalidation: "revalidation",
  plan: "plan",
  "plan-review": "plan-review",
  "revised-plan": "revised-plan",
  "must-fix": "must-fix",
  implementation: "implementation",
  "review-findings": "review-findings",
  // Persisted Steps retain their exact legacy output contract.
  "sol-findings": "review-findings",
  "blind-findings": "blind-findings",
  "fixed-implementation": "fixed-implementation",
  documentation: "documentation",
  "regression-verification": "regression",
  "merge-authorization": "readiness",
  "merge-result": "integrator",
};

const VERSION_SUFFIX = /-(v[1-9]\d*)$/u;

export const stepRole = (step: TemplateStepLike): StepRole | null => {
  const normalizedOutputKind = step.outputKind.replace(VERSION_SUFFIX, "");
  return OUTPUT_KIND_ROLES[normalizedOutputKind] ?? null;
};

// These retired Direct templates keep their v1 prompt and instantiated Steps.
// Keep this closed list here: importing the transition registry would create a
// cycle through its structural role checks. Future rollovers default to v2.
const REVALIDATION_V1_TEMPLATE_MARKERS = [
  "pre-product-rename-anneal",
  "pre-runner-provided-regression-tooling",
  "pre-optional-review-omission",
  "pre-astra-low-review-fix",
  "model-neutral-review-step-names",
  "pre-salvage-resume",
  "pre-model-neutral-review-output",
  "pre-judged-implementation-route",
] as const;

/** Explicit output-kind versions take precedence. Bare revalidation is v2,
 * except on the closed set of retired Direct templates whose prompt is v1. */
export const stepGeneration = (step: TemplateStepLike): string => {
  if (step.outputKind === "revalidation") {
    const name = step.taskTemplate?.name ?? step.taskTemplateName;
    const legacy = name && REVALIDATION_V1_TEMPLATE_MARKERS.some((marker) => {
      const prefix = `direct-engineer-workflow-legacy-${marker}-`;
      return name.startsWith(prefix) && name.length > prefix.length;
    });
    return legacy ? "v1" : "v2";
  }
  return step.outputKind.match(VERSION_SUFFIX)?.[1] ?? "v1";
};
