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

/** The output-kind protocol version. Bare revalidation defaults to v2;
 * canonicalOutputGeneration resolves retained template-specific contracts. */
export const stepGeneration = (step: TemplateStepLike): string => {
  if (step.outputKind === "revalidation") return "v2";
  return step.outputKind.match(VERSION_SUFFIX)?.[1] ?? "v1";
};
