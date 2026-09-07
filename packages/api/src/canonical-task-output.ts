import {
  canonicalClosedReviewArtifactSchema as closedReviewArtifact,
  canonicalFixedImplementationArtifactSchema as fixedImplementationArtifact,
  canonicalOutputSchema,
  APPROVAL_GATE_FEEDBACK_METADATA_FIELD,
  APPROVAL_GATE_NOTE_METADATA_FIELD,
  canonicalReviewArtifactSchema as reviewArtifact,
  isRegressionVerificationOutputKind,
  Prisma,
  recordGateAttestation,
  REGRESSION_VERIFICATION_OUTPUT_KIND,
  REGRESSION_VERIFICATION_SCHEMA_VERSION,
  RunStatus,
  runOwnedHead,
  stepRole,
  type CanonicalClosedReviewArtifact,
  type CanonicalFixedImplementationArtifact,
  type CanonicalReviewArtifact,
  type TaskStepOutput,
} from "@anneal/db";
import type { ClaimPreviousRunHandoff } from "@anneal/db/claim-contract";

import { chainStepPresence, type ChainStepPresenceIndex } from "./chain-step-omission.js";
import {
  fenceRefusalResponse,
  type FenceRefusalResponse,
  type RunFence,
  withFencedRun,
} from "./run-fence.js";

type DbTx = Prisma.TransactionClient;

/** The Full Assurance and Direct Regression node's deliverable. */
export const REGRESSION_VERIFICATION_KIND = REGRESSION_VERIFICATION_OUTPUT_KIND;

export const BLIND_REVIEW_PHASE = {
  independent: "independent-findings",
  evidenceUnlocked: "predecessor-evidence-unlocked",
  closed: "closed-must-fix",
} as const;

type TemplateStepIdentity = {
  stepIndex?: number;
  outputKind: string;
  taskTemplate?: { name: string };
};

type OutputTask = {
  id: string;
};

/** Declared with the claim payload it travels in, not beside its producer. */
export type PreviousRunHandoff = ClaimPreviousRunHandoff;

export const isCanonicalAgentStep = (step: TemplateStepIdentity | null | undefined): boolean => {
  if (!step) return false;
  const role = stepRole(step);
  return role !== null && role !== "readiness" && role !== "integrator";
};

/** The retired combined review role remains valid for already-instantiated Chains. */
export const isLegacyCombinedBlindReviewStep = (step: TemplateStepIdentity | null | undefined): boolean => (
  step !== null && step !== undefined && stepRole(step) === "must-fix"
);

export const isCanonicalBlindFindingsStep = (step: TemplateStepIdentity | null | undefined): boolean => (
  step !== null && step !== undefined && stepRole(step) === "blind-findings"
);

/**
 * The fix step inherited the adjudicator's authority over the two review
 * reports, so it inherits the adjudicator's obligation to account for every
 * finding in them. Recognized on the current graphs only: a renamed
 * adjudication-era row still routes that obligation through its own node.
 */
export const isCanonicalFixStep = (step: TemplateStepIdentity | null | undefined): boolean => (
  step !== null && step !== undefined && stepRole(step) === "fixed-implementation"
);

export const isCanonicalReviewFindingsStep = (step: TemplateStepIdentity | null | undefined): boolean => (
  step !== null && step !== undefined && stepRole(step) === "review-findings"
);

const metadataPhase = (metadata: Prisma.JsonValue | Prisma.InputJsonValue | undefined): string | null => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const phase = (metadata as Record<string, unknown>).phase;
  return typeof phase === "string" ? phase : null;
};

/** The informational `baseSha` an implementation body carries, if it carries a
 *  well-formed one. Nothing pins on it; only the mismatch record reads it. */
const implementationBodyBaseSha = (body: string): string | null => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const baseSha = (value as Record<string, unknown>).baseSha;
  return typeof baseSha === "string" && baseSha.length > 0 ? baseSha : null;
};

type ReviewArtifact = CanonicalReviewArtifact;
type ClosedReviewArtifact = CanonicalClosedReviewArtifact;

const duplicateValues = (values: string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
};

const closedReviewSelfRefusal = (artifact: ClosedReviewArtifact): string | null => {
  const duplicateFindings = duplicateValues(artifact.findings.map((finding) => finding.id));
  if (duplicateFindings.length > 0) {
    return `closed-must-fix findings contain duplicate ids: ${duplicateFindings.join(", ")}`;
  }
  const duplicateDispositions = duplicateValues(artifact.dispositions.map((disposition) => disposition.id));
  if (duplicateDispositions.length > 0) {
    return `closed-must-fix dispositions contain duplicate ids: ${duplicateDispositions.join(", ")}`;
  }
  const duplicateMustFixIds = duplicateValues(artifact.mustFixIds);
  if (duplicateMustFixIds.length > 0) {
    return `closed-must-fix mustFixIds contain duplicates: ${duplicateMustFixIds.join(", ")}`;
  }
  const expectedMustFixIds = new Set(
    artifact.findings.filter((finding) => finding.severity === "P0" || finding.severity === "P1")
      .map((finding) => finding.id),
  );
  const actualMustFixIds = new Set(artifact.mustFixIds);
  const missing = [...expectedMustFixIds].filter((id) => !actualMustFixIds.has(id)).sort();
  const unexpected = [...actualMustFixIds].filter((id) => !expectedMustFixIds.has(id)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    return `closed-must-fix mustFixIds must exactly equal final P0/P1 finding ids; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`;
  }
  return null;
};

const closedReviewRunRefusal = (
  independent: ReviewArtifact,
  closed: ClosedReviewArtifact,
): string | null => {
  if (closed.headSha !== independent.headSha
    || closed.reviewedBase !== independent.reviewedBase
    || closed.reviewedHead !== independent.reviewedHead) {
    return "closed-must-fix review range must exactly match this Run's independent-findings range";
  }
  const dispositionIds = new Set(closed.dispositions.map((disposition) => disposition.id));
  const missing = independent.findings.map((finding) => finding.id)
    .filter((id) => !dispositionIds.has(id))
    .sort();
  if (missing.length > 0) {
    return `closed-must-fix dispositions must cover every independent finding from this Run; missing: ${missing.join(", ")}`;
  }
  return null;
};

/**
 * With the adjudication node gone the fix step owns the dispositions: it reads
 * the immutable reports available in its review layer and decides each finding
 * itself, so its output is the only place that record can live.
 */
type FixedImplementationArtifact = CanonicalFixedImplementationArtifact;

const fixedImplementationSelfRefusal = (artifact: FixedImplementationArtifact): string | null => {
  const duplicateDispositions = duplicateValues(artifact.dispositions.map(({ id }) => id));
  if (duplicateDispositions.length > 0) {
    return `fixed-implementation dispositions contain duplicate ids: ${duplicateDispositions.join(", ")}`;
  }
  const duplicateClosed = duplicateValues(artifact.closedFindings.map(({ id }) => id));
  if (duplicateClosed.length > 0) {
    return `fixed-implementation closedFindings contain duplicate ids: ${duplicateClosed.join(", ")}`;
  }
  const adopted = artifact.dispositions.filter(({ disposition }) => disposition === "ADOPTED")
    .map(({ id }) => id).sort();
  const closed = artifact.closedFindings.map(({ id }) => id).sort();
  if (JSON.stringify(adopted) !== JSON.stringify(closed)) {
    return `fixed-implementation closedFindings must exactly cover the ADOPTED dispositions; adopted: ${adopted.join(", ") || "none"}; closed: ${closed.join(", ") || "none"}`;
  }
  return null;
};

type FixStepTask = {
  projectId: string;
  chainId: string | null;
  chainLayer: number | null;
  templateStep: { taskTemplateId: string };
};

/**
 * The fix step's self-consistency is not enough: nothing inside its own body
 * proves it looked at the reviews. This is the adjudicator's old cross-check,
 * re-pointed at the step that took over its authority — every present immutable
 * sibling report must be bound to the same range the fix started from, and
 * every finding id in them must carry exactly one disposition.
 */
const fixedImplementationPersistenceRefusal = async (
  tx: DbTx,
  task: FixStepTask,
  body: string,
): Promise<string | null> => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return "fixed-implementation body is not valid JSON";
  }
  const parsed = fixedImplementationArtifact.safeParse(value);
  if (!parsed.success) return "fixed-implementation body does not satisfy its canonical schema";
  const fix = parsed.data;
  if (!task.chainId || task.chainLayer === null) {
    return "fixed-implementation task has no chainId/chainLayer review boundary";
  }
  const predecessor = await tx.task.findFirst({
    where: { projectId: task.projectId, chainId: task.chainId, chainLayer: { lt: task.chainLayer } },
    select: { chainLayer: true },
    orderBy: { chainLayer: "desc" },
  });
  if (!predecessor || predecessor.chainLayer === null) {
    return "fixed-implementation task has no predecessor review layer";
  }
  const reviewTasks = await tx.task.findMany({
    where: { projectId: task.projectId, chainId: task.chainId, chainLayer: predecessor.chainLayer },
    select: {
      id: true,
      templateStep: { select: {
        stepIndex: true,
        outputKind: true,
        taskTemplate: { select: { name: true } },
      } },
      stepOutput: { select: {
        kind: true,
        body: true,
        commitSha: true,
        runId: true,
        run: { select: { taskId: true } },
      } },
    },
  });
  // Review reports are immutable and stay bound to their authoring Run, so a
  // later successful Run of the sibling task may validate the same commit.
  // This mirrors the prior-Run reuse rule in canonicalOutputRefusal below.
  const successfulSiblingRuns = await tx.run.findMany({
    where: {
      taskId: { in: reviewTasks.map(({ id }) => id) },
      status: RunStatus.SUCCEEDED,
    },
    select: { taskId: true, headSha: true },
  });
  const successfulSiblingHeads = new Map<string, Set<string>>();
  for (const run of successfulSiblingRuns) {
    if (run.taskId === null || run.headSha === null) continue;
    const heads = successfulSiblingHeads.get(run.taskId) ?? new Set<string>();
    heads.add(run.headSha);
    successfulSiblingHeads.set(run.taskId, heads);
  }
  const reports: ReviewArtifact[] = [];
  let presence: ChainStepPresenceIndex | null = null;
  for (const kind of ["review-findings", "blind-findings"] as const) {
    const matches = reviewTasks.filter((candidate) => (
      kind === "review-findings"
        ? isCanonicalReviewFindingsStep(candidate.templateStep)
        : isCanonicalBlindFindingsStep(candidate.templateStep)
    ));
    if (matches.length === 0) {
      // Absence of the sibling excuses the fix only when the producing step is
      // absent from the whole chain. A step this chain did instantiate is
      // owed in the fix step's predecessor layer.
      presence ??= await chainStepPresence(tx, {
        projectId: task.projectId,
        chainId: task.chainId,
        taskTemplateId: task.templateStep.taskTemplateId,
      });
      if (presence.ofRole(kind) === "instantiated") {
        return `fixed-implementation requires exactly one immutable ${kind} sibling output`;
      }
      continue;
    }
    if (matches.length !== 1 || !matches[0]!.stepOutput || matches[0]!.stepOutput!.kind !== matches[0]!.templateStep?.outputKind) {
      return `fixed-implementation requires exactly one immutable ${kind} sibling output`;
    }
    const output = matches[0]!.stepOutput!;
    if (output.runId === null
      || output.run?.taskId !== matches[0]!.id
      || output.commitSha === null
      || !successfulSiblingHeads.get(matches[0]!.id)?.has(output.commitSha)) {
      return `fixed-implementation ${kind} sibling output is not backed by a successful completed Run`;
    }
    let reportValue: unknown;
    try {
      reportValue = JSON.parse(output.body);
    } catch {
      return `fixed-implementation ${kind} sibling body is not valid JSON`;
    }
    const report = reviewArtifact.safeParse(reportValue);
    if (!report.success) return `fixed-implementation ${kind} sibling violates its review contract`;
    if (output.commitSha !== fix.sourceHead
      || report.data.headSha !== fix.sourceHead
      || report.data.reviewedHead !== fix.sourceHead) {
      return `fixed-implementation sourceHead does not match immutable ${kind} sibling`;
    }
    reports.push(report.data);
  }
  if (reports.length === 0) {
    return "fixed-implementation requires at least one immutable review sibling output";
  }
  const reviewedBase = reports[0]!.reviewedBase;
  if (reports.some((report) => report.reviewedBase !== reviewedBase)) {
    return "fixed-implementation sibling reviews disagree on the reviewed base";
  }
  const sourceIds = new Set(reports.flatMap((report) => report.findings).map((finding) => finding.id));
  const dispositionIds = new Set(fix.dispositions.map(({ id }) => id));
  const missing = [...sourceIds].filter((id) => !dispositionIds.has(id)).sort();
  const unknown = [...dispositionIds].filter((id) => !sourceIds.has(id)).sort();
  if (missing.length > 0 || unknown.length > 0) {
    return `fixed-implementation dispositions must exactly cover sibling findings; missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}`;
  }
  return null;
};

const canonicalBodyRefusal = (
  step: TemplateStepIdentity,
  body: string,
  authoredHead: string | null,
  phase: string | null,
): string | null => {
  const kind = step.outputKind;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return `${kind} task output body must be valid JSON`;
  }
  const schema = kind === "must-fix" && phase === BLIND_REVIEW_PHASE.closed
    ? closedReviewArtifact
    : kind === "must-fix"
      && (phase === BLIND_REVIEW_PHASE.independent || phase === BLIND_REVIEW_PHASE.evidenceUnlocked)
      ? reviewArtifact
      : canonicalOutputSchema(step);
  if (!schema) return `canonical output kind ${kind} has no versioned JSON contract`;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((issue) => {
      const location = issue.path.length ? issue.path.join(".") : "body";
      return { location, message: issue.message };
    });
    const [first, ...remaining] = issues;
    const additional = remaining.length > 0
      ? `; additional violations: ${remaining.map((issue) => `${issue.location}: ${issue.message}`).join("; ")}`
      : "";
    const schemaVersion = kind === REGRESSION_VERIFICATION_OUTPUT_KIND
      ? REGRESSION_VERIFICATION_SCHEMA_VERSION
      : 1;
    return `${kind} task output body violates schemaVersion ${String(schemaVersion)} at ${first?.location ?? "body"}: ${first?.message ?? "invalid value"}${additional}`;
  }
  const bodyHead = (parsed.data as { headSha: string }).headSha;
  if (bodyHead !== authoredHead) {
    return `${kind} task output body headSha ${bodyHead} does not match authored commit ${authoredHead ?? "none"}`;
  }
  if (kind === "must-fix" && phase === BLIND_REVIEW_PHASE.closed) {
    return closedReviewSelfRefusal(parsed.data as ClosedReviewArtifact);
  }
  if (kind === "fixed-implementation") {
    return fixedImplementationSelfRefusal(parsed.data as FixedImplementationArtifact);
  }
  return null;
};

export const canonicalOutputRefusal = (
  step: TemplateStepIdentity | null | undefined,
  output: Pick<TaskStepOutput, "runId" | "kind" | "body" | "commitSha" | "metadata"> | null,
  runId: string,
  completionHeadSha: string | null,
): string | null => {
  if (!step || !isCanonicalAgentStep(step)) return null;
  if (!output) return `missing ${step.outputKind} task output for current Run ${runId}`;
  // Findings reports are immutable after their first persistence. A later Run
  // may therefore validate and reuse a report authored by an earlier Run, but
  // all other canonical outputs retain the original ownership refusal (and its
  // position before the remaining validation checks).
  const priorRun = output.runId !== runId;
  if (priorRun && (output.runId === null || !outputIsImmutableOncePersisted(step))) {
    return `${step.outputKind} task output belongs to prior Run ${output.runId ?? "none"}, not current Run ${runId}`;
  }
  if (output.kind !== step.outputKind) return `task output kind ${output.kind} does not match canonical kind ${step.outputKind}`;
  if (!completionHeadSha) return `current Run ${runId} completed without an exact head`;
  if (output.commitSha !== completionHeadSha) {
    return `${step.outputKind} task output is bound to ${output.commitSha ?? "no commit"}, not completion head ${completionHeadSha}`;
  }
  const bodyRefusal = canonicalBodyRefusal(
    step,
    output.body,
    output.commitSha,
    metadataPhase(output.metadata),
  );
  if (bodyRefusal) return bodyRefusal;
  if (isLegacyCombinedBlindReviewStep(step) && metadataPhase(output.metadata) !== BLIND_REVIEW_PHASE.closed) {
    return `blind review output is not in required ${BLIND_REVIEW_PHASE.closed} phase`;
  }
  return null;
};

/**
 * A no-change continuation proves the salvaged tree with the implementation
 * protocol even when the current Task has no canonical Step (or has a
 * different one). Keep that exceptional expectation on the same canonical
 * kind, ownership, commit, and body validator as every ordinary Step.
 */
export const canonicalImplementationOutputRefusal = (
  output: Pick<TaskStepOutput, "runId" | "kind" | "body" | "commitSha" | "metadata"> | null,
  runId: string,
  completionHeadSha: string | null,
): string | null => canonicalOutputRefusal(
  { outputKind: "implementation" },
  output,
  runId,
  completionHeadSha,
);

/**
 * A findings artifact is the review it records; a later run may not replace it,
 * which `persistSessionTaskOutput` enforces. A run that finds one already
 * persisted therefore has nothing left to author, whoever wrote it.
 */
export const outputIsImmutableOncePersisted = (step: TemplateStepIdentity | null | undefined): boolean => (
  isCanonicalReviewFindingsStep(step) || isCanonicalBlindFindingsStep(step)
);

/**
 * The output kind a step's own agent must author, or null when completion may
 * synthesize one. Canonical agent nodes and the Regression node are the two
 * families whose deliverable is evidence rather than prose, so completion
 * refuses to invent one — which makes "the run ended without it" a fact about
 * the run, not a detail of the refusal that reads it afterwards.
 */
export const requiredOutputKind = (step: TemplateStepIdentity | null | undefined): string | null => {
  if (!step) return null;
  return isCanonicalAgentStep(step) || isRegressionVerificationOutputKind(step.outputKind) ? step.outputKind : null;
};

type PersistOutputResult =
  | { ok: false; reason: string }
  | { ok: true; output: TaskStepOutput; predecessorOutputs: Array<{
    kind: string;
    body: string;
    commitSha: string | null;
    task: { name: string; chainIndex: number | null };
  }> };

export const persistSessionTaskOutput = async (
  tx: DbTx,
  input: {
    task: OutputTask;
    fence: RunFence;
    kind: string;
    body: string;
    commitSha: string | null;
    metadata?: Prisma.InputJsonValue;
  },
): Promise<PersistOutputResult | FenceRefusalResponse> => withFencedRun(tx, input.fence, {
  task: { select: {
    id: true,
    projectId: true,
    chainId: true,
    chainIndex: true,
    chainLayer: true,
    status: true,
    templateStep: { select: {
      stepIndex: true,
      outputKind: true,
      taskTemplateId: true,
      taskTemplate: { select: { name: true } },
    } },
  } },
}, async (authorized) => {
  if (!authorized.task || authorized.task.id !== input.task.id) return fenceRefusalResponse("stale-fence");
  const task = authorized.task;
  const step = task.templateStep;
  if (step && isCanonicalAgentStep(step) && input.kind !== step.outputKind) {
    return { ok: false, reason: `task_output kind must be ${step.outputKind} for this canonical step` };
  }

  const legacyBlind = isLegacyCombinedBlindReviewStep(step);
  const phase = metadataPhase(input.metadata);
  const existing = await tx.taskStepOutput.findUnique({ where: { taskId: input.task.id } });
  const immutableReviewOutput = outputIsImmutableOncePersisted(step);
  if (immutableReviewOutput && existing) {
    return { ok: false, reason: `${step?.outputKind ?? input.kind} task output is immutable once persisted` };
  }
  if (step && isCanonicalAgentStep(step)) {
    const bodyRefusal = canonicalBodyRefusal(step, input.body, input.commitSha, phase);
    if (bodyRefusal) return { ok: false, reason: bodyRefusal };
  }
  if (step && isCanonicalFixStep(step)) {
    const refusal = await fixedImplementationPersistenceRefusal(tx, { ...task, templateStep: step }, input.body);
    if (refusal) return { ok: false, reason: refusal };
  }
  // The retired must-fix role remains only on already-instantiated Chains.
  // Current blind-findings roles never enter this phased predecessor-evidence path.
  if (legacyBlind) {
    if (phase !== BLIND_REVIEW_PHASE.independent
      && phase !== BLIND_REVIEW_PHASE.evidenceUnlocked
      && phase !== BLIND_REVIEW_PHASE.closed) {
      return { ok: false, reason: `blind review task_output metadata.phase must be ${BLIND_REVIEW_PHASE.independent}, ${BLIND_REVIEW_PHASE.evidenceUnlocked}, or ${BLIND_REVIEW_PHASE.closed}` };
    }
    if (phase === BLIND_REVIEW_PHASE.evidenceUnlocked
      && (existing?.runId !== input.fence.runId || metadataPhase(existing.metadata) !== BLIND_REVIEW_PHASE.independent)) {
      return { ok: false, reason: `blind review must persist ${BLIND_REVIEW_PHASE.independent} in this Run before unlocking predecessor evidence` };
    }
    if (phase === BLIND_REVIEW_PHASE.evidenceUnlocked && existing?.body !== input.body) {
      return { ok: false, reason: "blind review evidence unlock must repeat the exact independent-findings body" };
    }
    if (phase === BLIND_REVIEW_PHASE.closed
      && (existing?.runId !== input.fence.runId || metadataPhase(existing.metadata) !== BLIND_REVIEW_PHASE.evidenceUnlocked)) {
      return { ok: false, reason: `blind review must unlock predecessor evidence in this Run before ${BLIND_REVIEW_PHASE.closed}` };
    }
    if (phase === BLIND_REVIEW_PHASE.closed && existing) {
      let independentValue: unknown;
      let closedValue: unknown;
      try {
        independentValue = JSON.parse(existing.body);
        closedValue = JSON.parse(input.body);
      } catch {
        return { ok: false, reason: "blind review output contract could not parse the persisted review sequence" };
      }
      const independent = reviewArtifact.safeParse(independentValue);
      const closed = closedReviewArtifact.safeParse(closedValue);
      if (!independent.success || !closed.success) {
        return { ok: false, reason: "blind review output contract could not validate the persisted review sequence" };
      }
      const refusal = closedReviewRunRefusal(independent.data, closed.data);
      if (refusal) return { ok: false, reason: refusal };
    }
    if (phase === BLIND_REVIEW_PHASE.independent
      && existing?.runId === input.fence.runId && metadataPhase(existing.metadata) !== BLIND_REVIEW_PHASE.independent) {
      return { ok: false, reason: "closed blind review output cannot return to independent-findings" };
    }
    if (phase === BLIND_REVIEW_PHASE.evidenceUnlocked && existing) {
      await tx.taskActivity.create({ data: {
        taskId: input.task.id,
        actorType: "control-plane",
        body: existing.body,
        metadata: {
          kind: "canonicalTaskOutput.blindIndependentFindings",
          schemaVersion: 1,
          runId: input.fence.runId,
          outputKind: existing.kind,
          commitSha: existing.commitSha,
          phase: BLIND_REVIEW_PHASE.independent,
        },
      } });
    }
  }

  const output = await tx.taskStepOutput.upsert({
    where: { taskId: input.task.id },
    create: {
      taskId: input.task.id,
      runId: input.fence.runId,
      kind: input.kind,
      body: input.body,
      commitSha: input.commitSha,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    update: {
      runId: input.fence.runId,
      kind: input.kind,
      body: input.body,
      ...(input.commitSha ? { commitSha: input.commitSha } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });
  // `baseSha` in an implementation body is informational: the reviewed range is
  // pinned from the platform's own Run records. Persistence therefore never
  // refuses over it, but a body that disagrees with the derived base is the
  // exact typo that once sent every review sibling to a nonexistent commit, so
  // the disagreement is recorded where an operator reads the task.
  if (step && isCanonicalAgentStep(step) && step.outputKind === "implementation") {
    const bodyBaseSha = implementationBodyBaseSha(input.body);
    // This Run's own provisioning base, not the Task's earliest and not the
    // pinned one. The body was authored in this Run's workspace, so its base is
    // the only one it can be a typo of: a first Run that died unpublished keeps
    // its base out of the pin (`platformImplementationBaseSha`), and comparing
    // against it would report a mismatch on a correct body and miss the typo.
    const runBaseSha = (await tx.run.findFirst({
      where: { id: input.fence.runId },
      select: { baseSha: true },
    }))?.baseSha ?? null;
    if (!runBaseSha) {
      await tx.taskActivity.create({ data: {
        taskId: input.task.id,
        actorType: "control-plane",
        body: `Implementation run ${input.fence.runId} of task ${input.task.id} recorded no baseSha; body baseSha ${bodyBaseSha ?? "absent"} is informational and the platform has no provisioning base of this Run to check it against`,
        metadata: {
          kind: "canonicalTaskOutput.implementationBaseShaMissing",
          schemaVersion: 1,
          runId: input.fence.runId,
          outputKind: input.kind,
          bodyBaseSha,
        },
      } });
    } else if (bodyBaseSha && bodyBaseSha !== runBaseSha) {
      await tx.taskActivity.create({ data: {
        taskId: input.task.id,
        actorType: "control-plane",
        body: `Implementation output baseSha ${bodyBaseSha} differs from ${runBaseSha}, the base this Run's workspace was provisioned at; the field is informational and the reviewed range is pinned from the platform's own Run records`,
        metadata: {
          kind: "canonicalTaskOutput.implementationBaseShaMismatch",
          schemaVersion: 1,
          runId: input.fence.runId,
          outputKind: input.kind,
          bodyBaseSha,
          runBaseSha,
        },
      } });
    }
  }
  // The gate's signature is recorded in the same transaction that persists the
  // output it was copied from, so an attestation can never outlive or contradict
  // its evidence. Ingestion is the only writer because it is the only path every
  // Regression verification output takes, whichever channel authorizes the merge
  // afterwards.
  await recordGateAttestation(tx, {
    chainId: task.chainId,
    taskId: task.id,
    runId: input.fence.runId,
    kind: input.kind,
    body: input.body,
  });
  const predecessorOutputs = legacyBlind && phase === BLIND_REVIEW_PHASE.evidenceUnlocked
    && task.chainId && task.chainIndex !== null
    ? await tx.taskStepOutput.findMany({
      where: {
        task: {
          projectId: task.projectId,
          chainId: task.chainId,
          chainIndex: { lt: task.chainIndex },
        },
      },
      select: { kind: true, body: true, commitSha: true, task: { select: { name: true, chainIndex: true } } },
      orderBy: { task: { chainIndex: "asc" } },
    })
    : [];
  return { ok: true, output, predecessorOutputs };
});

/**
 * The salvage a failed attempt left behind, as the commit the next Run starts
 * on plus the commit that salvage was made on top of.
 *
 * `salvageParentSha` distinguishes salvage from ordinary publication: only
 * `salvageWorkspace` reports a parent. The Run-owned `pushedBranch` corroborates
 * ownership; ordinary successful Runs can also publish that ref. Both fields
 * come from the same completion write.
 */
export const salvageResumeEvidence = (
  taskId: string,
  previousRunNumber: number,
  previous: { pushedBranch: string | null; headSha: string | null; salvageParentSha: string | null },
): { commitSha: string; parentSha: string } | null =>
  previous.headSha !== null
    && previous.salvageParentSha !== null
    && previous.pushedBranch === runOwnedHead(taskId, previousRunNumber)
    ? { commitSha: previous.headSha, parentSha: previous.salvageParentSha }
    : null;

export const previousRunHandoffForClaim = async (
  tx: DbTx,
  input: {
    taskId: string;
    runId: string;
    runNumber: number;
    templateStep: TemplateStepIdentity | null;
  },
): Promise<PreviousRunHandoff | null> => {
  if (!isCanonicalAgentStep(input.templateStep) || input.runNumber <= 1) return null;
  const previous = await tx.run.findUnique({
    where: { taskId_runNumber: { taskId: input.taskId, runNumber: input.runNumber - 1 } },
    select: {
      id: true,
      status: true,
      failureReason: true,
      headSha: true,
      pushedBranch: true,
      salvageParentSha: true,
      endedAt: true,
      updatedAt: true,
    },
  });
  if (!previous || previous.id === input.runId) return null;
  // The resolved clone base may come from an older attempt if the immediate
  // predecessor never published. Match that ref within this task, rather than
  // offering stale salvage evidence for a different starting tree.
  const current = await tx.run.findUniqueOrThrow({
    where: { id: input.runId },
    select: { targetBranch: true },
  });
  const publication = current.targetBranch === null ? null : await tx.run.findFirst({
    where: { taskId: input.taskId, runNumber: { lt: input.runNumber }, pushedBranch: current.targetBranch },
    orderBy: { runNumber: "desc" },
    select: { runNumber: true, pushedBranch: true, headSha: true, salvageParentSha: true },
  });
  const output = await tx.taskStepOutput.findUnique({
    where: { taskId: input.taskId },
    select: { runId: true, kind: true, body: true, commitSha: true, metadata: true },
  });
  const activity = await tx.taskActivity.findFirst({
    where: {
      taskId: input.taskId,
      actorType: "operator",
      createdAt: { gte: previous.endedAt ?? previous.updatedAt },
      OR: [
        { body: { startsWith: "Approval gate rejected; step queued again" } },
        { body: `Run ${input.runNumber} queued by operator retry` },
      ],
    },
    select: { body: true, metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const refusalActivity = await tx.taskActivity.findFirst({
    where: {
      taskId: input.taskId,
      actorType: "control-plane",
      body: { startsWith: "Canonical task output refused:" },
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const refusalMetadata = refusalActivity?.metadata && typeof refusalActivity.metadata === "object"
    && !Array.isArray(refusalActivity.metadata)
    ? refusalActivity.metadata as Record<string, unknown>
    : null;
  const recomputedRefusal = output && previous.headSha !== null
    ? canonicalOutputRefusal(input.templateStep, output, previous.id, previous.headSha)
    : null;
  const priorRunOwnershipRefusal = output && input.templateStep
    ? `${input.templateStep.outputKind} task output belongs to prior Run ${output.runId ?? "none"}, not current Run ${previous.id}`
    : null;
  // A retry created before immutable findings became reusable carries the old
  // ownership refusal. Preserve its artifact in the handoff only when the
  // current canonical checks accept that exact output at the previous head.
  const acceptedImmutableOutputHadLegacyOwnershipRefusal = outputIsImmutableOncePersisted(input.templateStep)
    && recomputedRefusal === null
    && refusalMetadata?.reason === priorRunOwnershipRefusal;
  const refusedOutputMatchesPreviousHead = output?.runId !== null
    && output?.runId !== previous.id
    && previous.status === "SUCCEEDED"
    && previous.headSha !== null
    && output?.commitSha === previous.headSha
    && refusalMetadata?.kind === "canonicalTaskOutput.refusal"
    && refusalMetadata.runId === previous.id
    && (refusalMetadata.reason === recomputedRefusal || acceptedImmutableOutputHadLegacyOwnershipRefusal);
  const activityMetadata = activity?.metadata && typeof activity.metadata === "object" && !Array.isArray(activity.metadata)
    ? activity.metadata as Record<string, unknown>
    : null;
  const gateFeedbackNote = activityMetadata?.[APPROVAL_GATE_NOTE_METADATA_FIELD];
  const hasGateFeedback = activityMetadata?.[APPROVAL_GATE_FEEDBACK_METADATA_FIELD] === true
    && typeof gateFeedbackNote === "string"
    && gateFeedbackNote.length > 0;
  const rejectedByGate = activity?.body.startsWith("Approval gate rejected; step queued again") === true;
  const operatorRetry = activity?.body === `Run ${input.runNumber} queued by operator retry`;
  const retryReason = rejectedByGate
    ? hasGateFeedback ? "approval-rejected-with-feedback" : "approval-rejected-without-feedback"
    : operatorRetry ? "operator-retry" : previous.failureReason ? "automatic-retry" : "retry";
  return {
    schemaVersion: 1,
    previousRunId: previous.id,
    status: previous.status,
    failureReason: previous.failureReason,
    retryReason,
    output: output?.runId && (output.runId === previous.id || refusedOutputMatchesPreviousHead)
      ? { runId: output.runId, kind: output.kind, body: output.body, commitSha: output.commitSha }
      : null,
    salvage: publication ? salvageResumeEvidence(input.taskId, publication.runNumber, publication) : null,
  };
};
