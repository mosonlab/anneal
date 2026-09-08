import { z } from "zod";

import { stepRole } from "./step-role.js";

/**
 * Whether the deliverable a Run's Step requires exists, decided once.
 *
 * Before this, the sentence "a valid, current-Run output exists" was projected
 * as four booleans plus the raw output row and re-judged by everyone who read
 * it: the session status route emitted `outputRequired`,
 * `outputRemediationAllowed`, `outputSatisfiedByPriorRun` and
 * `outputPersisted`; the runner re-derived the same combinations at four
 * separate reads of that route; `completeRun` re-derived it a fifth time from
 * its own query of the same row. The canonical PR handoff array was validated
 * three times independently -- ordering and uniqueness in the runner's wire
 * parse, ordering and Task identity again in `deliverWorkspace`, and scoping in
 * the route's query.
 *
 * The cases below are what those booleans were spelling, and each one names a
 * situation an operator can act on. Combinations that could not occur stop
 * being representable: remediation is a property of an absent deliverable, not
 * a free-standing flag, and a deliverable satisfied by an immutable earlier Run
 * is neither present for this Run nor remediable by it.
 */
export type RunOutputSatisfaction =
  /**
   * This Run persisted the Task's output row. `output` is the server-side
   * identity of what it wrote; only the runner can compare it with local HEAD.
   */
  | { case: "delivered"; output: PersistedRunOutput }
  /** The Step declares no deliverable its own agent must author. */
  | { case: "not-required" }
  /**
   * An earlier Run persisted the immutable findings artifact this Step
   * requires. A findings artifact is the review it records, so this Run has
   * nothing left to author and may not replace it.
   */
  | { case: "satisfied-by-prior-run"; outputKind: string }
  /**
   * The required deliverable is not there. `remediable` is whether asking the
   * agent again can produce it: a mechanical verdict cannot be re-asked, so a
   * Regression Step's absent handoff is terminal rather than remediable.
   */
  | { case: "absent"; outputKind: string; remediable: boolean };

export type PersistedRunOutput = {
  kind: string;
  commitSha: string | null;
};

/** A Step's output contract: what its own agent must author, and on what terms. */
export type RunOutputRequirement = {
  /** The output kind the agent must author, or null when completion may synthesize one. */
  outputKind: string | null;
  /** A findings artifact is immutable once persisted, whoever authored it. */
  immutableOncePersisted: boolean;
  /** Whether the agent can be asked again for it. A mechanical verdict cannot. */
  remediable: boolean;
};

/** The persisted Task output row, as the control plane holds it. */
export type PersistedTaskOutput = {
  runId: string | null;
  kind: string;
  commitSha: string | null;
};

export const decideRunOutputSatisfaction = (
  runId: string,
  requirement: RunOutputRequirement,
  persisted: PersistedTaskOutput | null,
): RunOutputSatisfaction => {
  if (persisted && persisted.runId === runId) {
    return { case: "delivered", output: { kind: persisted.kind, commitSha: persisted.commitSha } };
  }
  const { outputKind } = requirement;
  if (outputKind === null) return { case: "not-required" };
  if (persisted && requirement.immutableOncePersisted) {
    return { case: "satisfied-by-prior-run", outputKind };
  }
  return { case: "absent", outputKind, remediable: requirement.remediable };
};

/** Accepted PR output kinds for the current review contract. */
export const PR_HANDOFF_KINDS = [
  "implementation",
  "review-findings",
  "blind-findings",
  "fixed-implementation",
] as const;

export type PrHandoffKind = (typeof PR_HANDOFF_KINDS)[number];

/**
 * Which canonical PR delivery a Run is: the implementation Run publishes the
 * pull request from its own output alone, the fix Run updates it from all four.
 */
export type PrHandoffStage = "implementation" | "final";

const PR_HANDOFF_SEQUENCE: Record<PrHandoffStage, readonly PrHandoffKind[]> = {
  implementation: ["implementation"],
  final: ["implementation", "review-findings", "blind-findings", "fixed-implementation"],
};

export type PrHandoffOutput = {
  taskId: string;
  chainIndex: number;
  kind: PrHandoffKind;
  body: string;
  commitSha: string;
};

/** Whether this Run's delivery may publish a canonical pull request, decided once. */
export type PrHandoff =
  /** This Run's Step is not a canonical PR delivery and carries no handoff. */
  | { case: "not-a-pr-delivery" }
  /**
   * Exactly the ordered handoff the stage requires, every entry well formed,
   * one Task per chain index, and the last entry bound to this delivery.
   * Delivery still parses the bodies: their schemas and their agreement with
   * each other and with local HEAD are a different fact.
   */
  | { case: "complete"; outputs: readonly PrHandoffOutput[] }
  /** The handoff cannot be assembled, so delivery must fail rather than publish. */
  | { case: "incomplete"; reason: string };

/** Canonical repositories may use SHA-1 (40 hex) or SHA-256 (64 hex). */
const CANONICAL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** A persisted PR-workflow output row as the route's scoped query projects it. */
export type PrHandoffCandidate = {
  taskId: string;
  chainIndex: number | null;
  kind: string;
  body: string;
  commitSha: string | null;
};

export const decidePrHandoff = (
  delivery: { taskId: string; chainIndex: number; stage: PrHandoffStage } | null,
  candidates: readonly PrHandoffCandidate[],
): PrHandoff => {
  if (!delivery) return { case: "not-a-pr-delivery" };
  const expected = PR_HANDOFF_SEQUENCE[delivery.stage];
  if (candidates.length !== expected.length) {
    return {
      case: "incomplete",
      reason: `canonical PR handoff requires exactly ${expected.length} output entr${expected.length === 1 ? "y" : "ies"}, not ${candidates.length}`,
    };
  }
  const outputs: PrHandoffOutput[] = [];
  for (const [index, kind] of expected.entries()) {
    const candidate = candidates[index]!;
    if (!PR_HANDOFF_KINDS.some((accepted) => accepted === candidate.kind)
      || stepRole({ outputKind: candidate.kind }) !== stepRole({ outputKind: kind })) {
      return { case: "incomplete", reason: `canonical PR handoff evidence is missing or out of order at ${kind}` };
    }
    if (candidate.taskId.trim().length === 0
      || candidate.chainIndex === null
      || !Number.isInteger(candidate.chainIndex)
      || candidate.chainIndex <= 0
      || candidate.body.trim().length === 0
      || candidate.commitSha === null
      || !CANONICAL_COMMIT_SHA.test(candidate.commitSha)) {
      return { case: "incomplete", reason: `malformed ${candidate.kind} canonical output evidence` };
    }
    const previous = outputs[index - 1];
    if (previous && candidate.chainIndex <= previous.chainIndex) {
      return { case: "incomplete", reason: "canonical PR handoff evidence is not ordered by chain index" };
    }
    if (outputs.some((output) => output.taskId === candidate.taskId)) {
      return { case: "incomplete", reason: "canonical PR handoff evidence repeats a Task" };
    }
    outputs.push({
      taskId: candidate.taskId,
      chainIndex: candidate.chainIndex,
      kind: candidate.kind as PrHandoffKind,
      body: candidate.body,
      commitSha: candidate.commitSha,
    });
  }
  const current = outputs.at(-1)!;
  if (current.taskId !== delivery.taskId) {
    return { case: "incomplete", reason: `${current.kind} canonical output evidence belongs to another Task` };
  }
  if (current.chainIndex !== delivery.chainIndex) {
    return { case: "incomplete", reason: `${current.kind} canonical output evidence is not for the current chain index` };
  }
  return { case: "complete", outputs };
};

/** Everything the session status route decides about this Run's deliverables. */
export type RunOutputEvidence = {
  satisfaction: RunOutputSatisfaction;
  prHandoff: PrHandoff;
};

const satisfactionSchema: z.ZodType<RunOutputSatisfaction> = z.discriminatedUnion("case", [
  z.object({
    case: z.literal("delivered"),
    output: z.object({ kind: z.string().min(1), commitSha: z.string().nullable() }),
  }),
  z.object({ case: z.literal("not-required") }),
  z.object({ case: z.literal("satisfied-by-prior-run"), outputKind: z.string().min(1) }),
  z.object({ case: z.literal("absent"), outputKind: z.string().min(1), remediable: z.boolean() }),
]);

const prHandoffSchema: z.ZodType<PrHandoff> = z.discriminatedUnion("case", [
  z.object({ case: z.literal("not-a-pr-delivery") }),
  z.object({
    case: z.literal("complete"),
    outputs: z.array(z.object({
      taskId: z.string().min(1),
      chainIndex: z.number().int().positive(),
      kind: z.enum(PR_HANDOFF_KINDS),
      body: z.string().min(1),
      commitSha: z.string().regex(CANONICAL_COMMIT_SHA),
    })).min(1),
  }),
  z.object({ case: z.literal("incomplete"), reason: z.string().min(1) }),
]);

const runOutputEvidenceSchema: z.ZodType<RunOutputEvidence> = z.object({
  satisfaction: satisfactionSchema,
  prHandoff: prHandoffSchema,
});

/**
 * Read the decided answer off the wire. The runner is on the untrusted side of
 * this seam and must reject a payload that is not one, but it no longer
 * re-derives any of the rules the decision applied: this rejects a shape, not a
 * verdict. Throws a `ZodError` on anything else.
 */
export const parseRunOutputEvidence = (value: unknown): RunOutputEvidence =>
  runOutputEvidenceSchema.parse(value);
