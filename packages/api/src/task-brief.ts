import { stepRole } from "@anneal/db";

const FEATURE_BRIEF_PREFIX = "\nFeature brief:\n";
const PRIOR_OUTPUTS_REMINDER = "\nRead the prior template steps' persisted outputs before working.";
const PERSIST_OUTPUT_PREFIX = "\nPersist the final ";
const PERSIST_OUTPUT_SUFFIX = " output for this step through the Anneal task output endpoint.";

const BRIEF_HEADER_PREFIX = "\n<!-- agentos:task-brief:v1 length=";
const BRIEF_HEADER_SUFFIX = " -->\n";
const BRIEF_FOOTER = "\n<!-- /agentos:task-brief:v1 -->";

/**
 * The operator `TaskActivity` note a brief edit leaves.
 *
 * `PATCH /tasks/:id` writes it, and the review claim reads it back to date an
 * amendment that landed after the Specification of record was materialized —
 * that row is the only record of when the brief changed. The two must not
 * drift, so the text lives here rather than in either of them.
 */
export const BRIEF_EDIT_ACTIVITY_NOTE = "Prompt edited";

export type TaskBrief = {
  prompt: string;
  brief: string;
  hadReminder: boolean;
};

export type UnparseableTaskBrief = { unparseable: string };

type LocatedTaskBrief = TaskBrief & {
  suffix: string;
};

type LegacyBriefMigration = {
  legacyAttachmentsFromPrevious: boolean;
};

/**
 * How to read a brief written before the fence existed, derived from the one
 * fact that decides it: whether the Step's prompt carried the prior-outputs
 * reminder. Every caller holds the same template Step columns, so the
 * derivation lives here once. Passing no migration at all stays a distinct
 * decision: a fenced brief is required and there is no legacy fallback.
 */
export const legacyBriefMigration = (
  templateStep: { priorOutputKinds: readonly string[] } | null | undefined,
): LegacyBriefMigration => ({
  legacyAttachmentsFromPrevious: (templateStep?.priorOutputKinds.length ?? 0) > 0,
});

export const stepHasTaskBrief = (outputKind: string): boolean => {
  const role = stepRole({ outputKind });
  return role !== "readiness" && role !== "integrator";
};

/**
 * Whether `PATCH /tasks/:id { description }` rewrites this task's brief in
 * place instead of replacing the whole description.
 *
 * The read projection and the write path have to answer this the same way. An
 * operator who is shown the wrong half of the prompt edits text the patch then
 * writes somewhere else — the whole canonical prompt copied into the brief
 * fence, or a brief silently replacing the Step's platform-authored body.
 */
export const patchesBriefInPlace = (
  task: { templateId: string | null; chainId: string | null },
  outputKind: string | null,
): boolean => (
  task.templateId !== null
  && task.chainId !== null
  && outputKind !== null
  && stepHasTaskBrief(outputKind)
);

const outputIsPlatformAuthored = (outputKind: string): boolean => {
  const role = stepRole({ outputKind });
  return role === "readiness" || role === "integrator" || role === "regression";
};

const frameBrief = (brief: string): string => (
  `${BRIEF_HEADER_PREFIX}${brief.length}${BRIEF_HEADER_SUFFIX}${brief}${BRIEF_FOOTER}`
);

export const composeBrief = (input: {
  prompt: string;
  brief?: string | undefined;
  attachmentsFromPrevious: boolean;
  outputKind: string;
}): string => {
  // Readiness and merge execution are server-owned mechanical Steps. Their
  // task cards preview the canonical prompt, but no model reads generated
  // brief, predecessor, or output-persistence context from them.
  if (!stepHasTaskBrief(input.outputKind)) return input.prompt;
  return [
    input.prompt,
    input.brief ? frameBrief(input.brief) : "",
    input.attachmentsFromPrevious ? PRIOR_OUTPUTS_REMINDER : "",
    outputIsPlatformAuthored(input.outputKind)
      ? ""
      : `${PERSIST_OUTPUT_PREFIX}${input.outputKind}${PERSIST_OUTPUT_SUFFIX}`,
  ].join("");
};

const readFencedBrief = (description: string): LocatedTaskBrief | UnparseableTaskBrief | null => {
  const headerStart = description.indexOf(BRIEF_HEADER_PREFIX);
  if (headerStart < 0) return null;
  const lengthStart = headerStart + BRIEF_HEADER_PREFIX.length;
  const headerEnd = description.indexOf(BRIEF_HEADER_SUFFIX, lengthStart);
  if (headerEnd < 0) return { unparseable: "task brief fence header is incomplete" };
  const encodedLength = description.slice(lengthStart, headerEnd);
  if (!/^\d+$/u.test(encodedLength)) return { unparseable: "task brief fence length is invalid" };
  const briefLength = Number(encodedLength);
  if (!Number.isSafeInteger(briefLength)) return { unparseable: "task brief fence length is unsafe" };
  const briefStart = headerEnd + BRIEF_HEADER_SUFFIX.length;
  const briefEnd = briefStart + briefLength;
  if (description.slice(briefEnd, briefEnd + BRIEF_FOOTER.length) !== BRIEF_FOOTER) {
    return { unparseable: "task brief fence does not match its declared length" };
  }
  const suffix = description.slice(briefEnd + BRIEF_FOOTER.length);
  return {
    prompt: description.slice(0, headerStart),
    brief: description.slice(briefStart, briefEnd),
    hadReminder: suffix.startsWith(PRIOR_OUTPUTS_REMINDER),
    suffix,
  };
};

/** Read descriptions written before fenced briefs were introduced. */
const readLegacyBrief = (
  description: string,
  attachmentsFromPrevious: boolean,
): LocatedTaskBrief | UnparseableTaskBrief => {
  const markerStart = description.indexOf(FEATURE_BRIEF_PREFIX);
  if (markerStart < 0) return { unparseable: "task brief marker is missing" };
  const briefStart = markerStart + FEATURE_BRIEF_PREFIX.length;
  const persistStart = description.lastIndexOf(PERSIST_OUTPUT_PREFIX);
  const suffixStart = persistStart >= briefStart ? persistStart : description.length;
  const reminderStart = suffixStart - PRIOR_OUTPUTS_REMINDER.length;
  const hadReminder = attachmentsFromPrevious
    && reminderStart >= briefStart
    && description.slice(reminderStart, suffixStart) === PRIOR_OUTPUTS_REMINDER;
  const briefEnd = hadReminder ? reminderStart : suffixStart;
  return {
    prompt: description.slice(0, markerStart),
    brief: description.slice(briefStart, briefEnd),
    hadReminder,
    suffix: description.slice(briefEnd),
  };
};

const locateBrief = (
  description: string,
  migration?: LegacyBriefMigration,
): LocatedTaskBrief | UnparseableTaskBrief => {
  const fenced = readFencedBrief(description);
  if (fenced !== null) return fenced;
  return migration
    ? readLegacyBrief(description, migration.legacyAttachmentsFromPrevious)
    : { unparseable: "task brief fence is missing" };
};

/** Read the direct Chain's Specification of record without caller-supplied encoding facts. */
export const readBrief = (
  description: string,
  migration?: LegacyBriefMigration,
): TaskBrief | UnparseableTaskBrief => {
  const result = locateBrief(description, migration);
  if ("unparseable" in result) return result;
  const { suffix: _suffix, ...brief } = result;
  return brief;
};

/** Replace only the brief and preserve the platform-authored prompt and suffix. */
export const rewriteBrief = (
  description: string,
  newBrief: string,
  migration?: LegacyBriefMigration,
): string | UnparseableTaskBrief => {
  const result = locateBrief(description, migration);
  if ("unparseable" in result) return result;
  return `${result.prompt}${frameBrief(newBrief)}${result.suffix}`;
};

/**
 * The prompt text this task's operator owns, or null when the platform owns all
 * of it. Mirrors what `PATCH /tasks/:id { description }` will do with the text
 * it is handed, which is the only reason the two agree.
 */
export const editableBrief = (
  task: { description: string; templateId: string | null; chainId: string | null },
  templateStep: { outputKind: string; priorOutputKinds: string[] } | null,
): string | null => {
  if (patchesBriefInPlace(task, templateStep?.outputKind ?? null)) {
    const brief = readBrief(task.description, legacyBriefMigration(templateStep));
    // An unreadable fence is not an invitation to rewrite the description
    // wholesale: the patch would refuse the write anyway.
    return "unparseable" in brief ? null : brief.brief;
  }
  // Readiness and merge-execution Steps run a server-authored prompt. Nothing
  // in it belongs to the operator, so nothing in it is offered for editing.
  return templateStep === null ? task.description : null;
};
