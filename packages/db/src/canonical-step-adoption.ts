import type { Prisma } from "@prisma/client";

import {
  LEGACY_ALL_PRIOR_OUTPUTS,
  templateStepStructureDifferences,
  type CanonicalTemplateName,
  type PersistedTemplateStepStructure,
  type TemplateStepSource,
} from "./template-sources.js";

/**
 * The complete set of differences between a persisted canonical template step
 * and its Markdown source that the platform forgives, and the write that
 * resolves each. Every reader of canonical drift consults this module:
 * `planCanonicalInstallation` to decide that a row is current,
 * `sync-canonical-prompts.ts` to perform the write, and
 * `verify-agent-template.ts` with `refuse-all` so the verifier's zero-tolerance
 * stance is stated against the same roster instead of restating the rules.
 *
 * Apart from the Agent binding, which every step adopts from its source, an
 * adoption is permitted only from an exact retired value to an exact canonical
 * value at a named step. Any other difference is drift and is refused.
 */

/**
 * Canonical role slugs the sync names directly. They are role file names, which
 * is the Agent's canonical identity; an operator-edited `name` never addresses
 * one of these.
 */
export const REGRESSION_VERIFIER_AGENT_NAME = "regression-verifier-luna-max";
export const SPEC_REVALIDATOR_AGENT_NAME = "spec-revalidator-luna-xhigh";

/** The sync report counter one adoption increments. */
export type CanonicalAdoptionCounter =
  | "adoptedAssignees"
  | "adoptedStepBases"
  | "adoptedPriorOutputDeclarations"
  | "adoptedDependencyProvisioning"
  | "adoptedOptionalSteps"
  | "renamedSteps";

/**
 * The write that resolves one tolerated difference. `bind-agent` needs the
 * caller's transaction to resolve the named active Agent to its id; every
 * other adoption is a column value taken from the canonical source.
 */
export type CanonicalAdoptionWrite =
  | Readonly<{ kind: "bind-agent"; agentName: string }>
  | Readonly<{ kind: "set-columns"; data: Prisma.TaskTemplateStepUncheckedUpdateInput }>;

export type CanonicalStepAdoption = Readonly<{
  /** The `templateStepStructureDifferences` field this adoption forgives. */
  difference: string;
  counter: CanonicalAdoptionCounter;
  /** The write changes a column instantiated Tasks copy; refuse a referenced step instead of mutating it. */
  refusesReferencedStep: boolean;
  write: CanonicalAdoptionWrite;
}>;

/** Whether the reader forgives what an adoption resolves, or refuses every difference. */
export type CanonicalAdoptionTolerance = "adopt" | "refuse-all";

type AdoptionRule = Readonly<{
  difference: string;
  counter: CanonicalAdoptionCounter;
  refusesReferencedStep: boolean;
  matches: (actual: PersistedTemplateStepStructure, source: TemplateStepSource) => boolean;
  write: (source: TemplateStepSource) => CanonicalAdoptionWrite;
}>;

/**
 * A canonical step binds the Agent its source states, whatever it binds now.
 *
 * The binding is the one canonical column an operator does not own: staffing a
 * chain differently is a staffing profile, which instantiation applies to the
 * Task, and the template row keeps stating the canonical default. So this is
 * not a roster of retired roles to forgive at named steps -- every step adopts
 * its source binding, including a step instantiated Tasks already reference.
 * Those Tasks keep the assignee they were instantiated with; only the template
 * row moves, so `refusesReferencedStep` is false. Every other adoption still
 * refuses a referenced step, because every other column is copied into work
 * that is already running.
 */
const ADOPTS_AGENT_BINDING: AdoptionRule = {
  difference: "agent",
  counter: "adoptedAssignees",
  refusesReferencedStep: false,
  // A source step with no Agent is a human step: adopting that is an
  // assigneeType change as well, which stays drift and refuses.
  matches: (_actual, source) => source.agentName !== null,
  write: (source) => ({ kind: "bind-agent", agentName: source.agentName! }),
};

const adoptsStepName = (from: string, to: string): AdoptionRule => ({
  difference: "name",
  counter: "renamedSteps",
  refusesReferencedStep: true,
  matches: (actual, source) => actual.name === from && source.name === to,
  write: (source) => ({ kind: "set-columns", data: { name: source.name } }),
});

const adoptsStepBase = (from: number | null, to: number): AdoptionRule => ({
  difference: "baseFromStepIndex",
  counter: "adoptedStepBases",
  refusesReferencedStep: true,
  matches: (actual, source) => actual.baseFromStepIndex === from && source.baseFromStepIndex === to,
  write: (source) => ({ kind: "set-columns", data: { baseFromStepIndex: source.baseFromStepIndex } }),
});

/** Review steps read the tree only; they drop the provisioning their predecessors carried. */
const ADOPTS_REVIEW_PROVISIONING: AdoptionRule = {
  difference: "provisionDependencies",
  counter: "adoptedDependencyProvisioning",
  refusesReferencedStep: false,
  matches: (actual, source) => actual.provisionDependencies === true && source.provisionDependencies === false,
  write: (source) => ({ kind: "set-columns", data: { provisionDependencies: source.provisionDependencies } }),
};

/** The additive schema migration leaves every existing Step non-optional;
 * only the two canonical blind-review rows adopt the new source-owned flag. */
const ADOPTS_OPTIONAL_STEP: AdoptionRule = {
  difference: "optional",
  counter: "adoptedOptionalSteps",
  refusesReferencedStep: false,
  matches: (actual, source) => actual.optional === false && source.optional === true,
  write: (source) => ({ kind: "set-columns", data: { optional: source.optional } }),
};

/**
 * The retired all-output handoff marker is a repository-wide migration state,
 * not a transition at one named step, so it is permitted wherever it survives.
 */
const ADOPTS_PRIOR_OUTPUT_WHITELIST: AdoptionRule = {
  difference: "priorOutputKinds",
  counter: "adoptedPriorOutputDeclarations",
  refusesReferencedStep: false,
  matches: (actual) => actual.priorOutputKinds.length === 1 && actual.priorOutputKinds[0] === LEGACY_ALL_PRIOR_OUTPUTS,
  write: (source) => ({ kind: "set-columns", data: { priorOutputKinds: source.priorOutputKinds } }),
};

const ADOPTIONS_AT_EVERY_STEP: readonly AdoptionRule[] = [ADOPTS_AGENT_BINDING, ADOPTS_PRIOR_OUTPUT_WHITELIST];

/** Keyed by `templateName:stepIndex`. This is the roster of canonical review steps too. */
const ADOPTIONS_BY_STEP: ReadonlyMap<string, readonly AdoptionRule[]> = new Map([
  ["compound-engineer-workflow:6", [ADOPTS_REVIEW_PROVISIONING, adoptsStepBase(null, 5)]],
  ["compound-engineer-workflow:7", [ADOPTS_REVIEW_PROVISIONING, ADOPTS_OPTIONAL_STEP]],
  ["compound-engineer-workflow:11", [adoptsStepName("Merge readiness", "Merge authorization")]],
  ["direct-engineer-workflow:3", [ADOPTS_REVIEW_PROVISIONING, adoptsStepBase(null, 2)]],
  ["direct-engineer-workflow:4", [ADOPTS_REVIEW_PROVISIONING, ADOPTS_OPTIONAL_STEP]],
  ["direct-engineer-workflow:7", [adoptsStepName("Merge readiness", "Merge authorization")]],
  ["pr-engineer-workflow:2", [ADOPTS_REVIEW_PROVISIONING]],
  ["pr-engineer-workflow:3", [ADOPTS_REVIEW_PROVISIONING]],
]);

/**
 * The adoptions that resolve the differences between one persisted step and
 * its canonical source, in the order their writes may be applied.
 */
export const canonicalStepAdoptions = (
  templateName: CanonicalTemplateName,
  actual: PersistedTemplateStepStructure,
  source: TemplateStepSource,
): readonly CanonicalStepAdoption[] => {
  const differences = templateStepStructureDifferences(actual, source);
  if (differences.length === 0) return [];
  const rules = [
    ...ADOPTIONS_AT_EVERY_STEP,
    ...ADOPTIONS_BY_STEP.get(`${templateName}:${source.stepIndex}`) ?? [],
  ];
  return rules
    .filter((rule) => differences.includes(rule.difference) && rule.matches(actual, source))
    .map((rule) => ({
      difference: rule.difference,
      counter: rule.counter,
      refusesReferencedStep: rule.refusesReferencedStep,
      write: rule.write(source),
    }));
};

/**
 * The differences the reader must refuse. Under `adopt`, the differences an
 * adoption resolves are absent; under `refuse-all`, every difference is
 * reported and no adoption is offered.
 */
export const canonicalStepDrift = (
  templateName: CanonicalTemplateName,
  actual: PersistedTemplateStepStructure,
  source: TemplateStepSource,
  tolerance: CanonicalAdoptionTolerance,
): string[] => {
  const differences = templateStepStructureDifferences(actual, source);
  if (tolerance === "refuse-all") return differences;
  const adopted = new Set(canonicalStepAdoptions(templateName, actual, source).map(({ difference }) => difference));
  return differences.filter((difference) => !adopted.has(difference));
};
