import { DIRECT_TEMPLATE_NAME, LEGACY_TEMPLATE_GENERATIONS } from "@anneal/db";

// Historical identity is used only to protect stored reports and refuse new
// execution. It must never restore a role alias or a versioned output schema.
const retiredReviewKind = LEGACY_TEMPLATE_GENERATIONS[DIRECT_TEMPLATE_NAME]
  .find(({ marker }) => marker === "pre-model-neutral-review-output")!.shape
  .find(({ name }) => name === "Code review")!.outputKind;

export const isRetiredReviewOutputKind = (kind: string | undefined): boolean => kind === retiredReviewKind;

export const retiredReviewOutputRefusal = (kind: string | undefined): string | null =>
  isRetiredReviewOutputKind(kind) ? `unknown-kind: retired task output kind ${kind}` : null;
