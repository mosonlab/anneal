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

/** A Step's output protocol generation is the `-vN` suffix on its output kind,
 *  and nothing else. Template identity used to override it through a retired
 *  graph marker, but a rollover preserves the output protocol unless outputKind
 *  itself changes, so the only production caller (`canonicalOutputSchema`)
 *  deliberately passed template identity in as absent. The `taskTemplate` fields
 *  stay on `TemplateStepLike` for the role predicates that still read them. */
export const stepGeneration = (step: TemplateStepLike): string =>
  step.outputKind.match(VERSION_SUFFIX)?.[1] ?? "v1";
