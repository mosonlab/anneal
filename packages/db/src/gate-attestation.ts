/**
 * Merge gate attestations — the gate's signature, persisted.
 *
 * `scripts/merge-gate.sh` binds its verdict to a commit by printing
 * `MERGE GATE: PASS <oid>`. A Regression verification run copies that line into
 * its output and `parseRegressionVerdict` asserts the oid names the same head,
 * but that check lives on the verdict-parsing path — and one of the two merge
 * authorization channels never walks it. The Inbox and PATCH channels build an
 * authorization out of the card body alone, so before this module a human
 * approval could authorize a merge at a head no gate had ever signed.
 *
 * The two channels run in different processes and different transactions; their
 * only shared ground is the database. So the proof line becomes a row, written
 * at ingestion, and both channels require it.
 *
 * `deriveGateAttestation` is pure and is the only place that decides whether an
 * output attests anything. Legacy `regression-verification` (v1) outputs carry
 * no proof line and derive nothing. Only registered pre-attestation generations
 * with the frozen v1 Regression protocol receive the compatibility exemption.
 */

import { TaskStatus, type Prisma } from "@prisma/client";

import {
  REGRESSION_VERIFICATION_OUTPUT_KIND,
  REGRESSION_VERIFICATION_V3_OUTPUT_KIND,
  parseRegressionVerdict,
} from "./merge-tail.js";
import { stepGeneration, stepRole } from "./step-role.js";

type Tx = Prisma.TransactionClient;

export type GateAttestation = {
  headSha: string;
  baseHeadSha: string;
  proof: string;
};

/**
 * The attestation an output carries, or null when it carries none. Only a v2
 * Regression verification that actually passed the gate attests. The v3
 * semantic contract carries no gate authority.
 */
export const deriveGateAttestation = (
  kind: string,
  body: string | null | undefined,
): GateAttestation | null => {
  if (kind !== REGRESSION_VERIFICATION_OUTPUT_KIND) return null;
  const parsed = parseRegressionVerdict(body, kind);
  if (parsed.status !== "ok") return null;
  const verdict = parsed.verdict;
  if (verdict.outcome !== "pass" || !("gateProof" in verdict)) return null;
  return {
    headSha: verdict.headSha,
    baseHeadSha: verdict.baseHeadSha,
    proof: verdict.gateProof,
  };
};

export type SemanticPassEvidence = {
  taskId: string;
  runId: string;
  headSha: string;
  baseHeadSha: string;
  semanticSourceRunId: string;
};

export type SemanticPassEvidenceRequirement =
  | { satisfied: true; evidence: SemanticPassEvidence }
  | { satisfied: false; reason: string };

/**
 * Require trusted v3 candidate evidence for an operator Approval gate. This is
 * intentionally separate from gate attestation: the approval binds the
 * candidate's semantic evidence, while merge-train settlement independently
 * requires a full-gate proof for the actual publish prefix.
 */
export const requireSemanticPassEvidence = async (
  tx: Tx,
  input: { chainId: string | null; headSha: string; baseHeadSha: string },
): Promise<SemanticPassEvidenceRequirement> => {
  if (!input.chainId) {
    return { satisfied: false, reason: "semantic candidate approval requires a chain" };
  }
  const task = await tx.task.findFirst({
    where: {
      chainId: input.chainId,
      status: TaskStatus.DONE,
      templateStep: { outputKind: REGRESSION_VERIFICATION_V3_OUTPUT_KIND },
    },
    select: {
      id: true,
      stepOutput: {
        select: {
          kind: true,
          body: true,
          commitSha: true,
          runId: true,
          run: { select: { id: true, taskId: true, headSha: true } },
        },
      },
    },
  });
  const output = task?.stepOutput;
  const parsed = parseRegressionVerdict(output?.body, output?.kind);
  if (!task || !output || parsed.status !== "ok" || parsed.verdict.outcome !== "semantic-pass") {
    return { satisfied: false, reason: `no trusted semantic PASS evidence for head ${input.headSha}` };
  }
  const verdict = parsed.verdict;
  if (verdict.headSha !== input.headSha || verdict.baseHeadSha !== input.baseHeadSha
    || output.commitSha !== verdict.headSha || !output.runId
    || output.run?.id !== output.runId || output.run.taskId !== task.id
    || output.run.headSha !== verdict.headSha) {
    return {
      satisfied: false,
      reason: `semantic PASS evidence does not bind its source Run, head ${input.headSha}, and base ${input.baseHeadSha}`,
    };
  }
  const semanticSourceRunId = verdict.semanticVerdict === "reused"
    ? verdict.semanticSourceRunId!
    : output.runId;
  if (verdict.semanticVerdict === "reused") {
    const source = await tx.run.findUnique({
      where: { id: semanticSourceRunId },
      select: { taskId: true },
    });
    if (source?.taskId !== task.id) {
      return { satisfied: false, reason: `semantic PASS source Run ${semanticSourceRunId} is not trusted` };
    }
  }
  return {
    satisfied: true,
    evidence: {
      taskId: task.id,
      runId: output.runId,
      headSha: verdict.headSha,
      baseHeadSha: verdict.baseHeadSha,
      semanticSourceRunId,
    },
  };
};

/**
 * Records the attestation an output carries. Idempotent on `(chainId, headSha)`:
 * a repair loop may re-persist the same passing verdict. A new passing verdict
 * at the same head refreshes its base and provenance for base-drift renewal.
 *
 * A chainless task cannot be merged by any channel, so it records nothing.
 */
export const recordGateAttestation = async (
  tx: Tx,
  input: {
    chainId: string | null;
    taskId: string;
    runId: string | null;
    kind: string;
    body: string | null | undefined;
  },
): Promise<GateAttestation | null> => {
  if (!input.chainId) return null;
  const attestation = deriveGateAttestation(input.kind, input.body);
  if (!attestation) return null;
  await tx.mergeGateAttestation.upsert({
    where: { chainId_headSha: { chainId: input.chainId, headSha: attestation.headSha } },
    create: {
      chainId: input.chainId,
      taskId: input.taskId,
      runId: input.runId,
      headSha: attestation.headSha,
      baseHeadSha: attestation.baseHeadSha,
      proof: attestation.proof,
    },
    update: {
      baseHeadSha: attestation.baseHeadSha,
      proof: attestation.proof,
      taskId: input.taskId,
      runId: input.runId,
    },
  });
  return attestation;
};

export type GateAttestationRequirement =
  | { satisfied: true; attestation: GateAttestation | null }
  | { satisfied: false; reason: string };

/**
 * The Regression generations that predate the proof line, and are therefore the
 * only ones a chain may present nothing for. Anything else — a later generation,
 * or an outputKind this build does not recognise as a Regression Step at all —
 * has to produce a row, because "no attestation found" must never be the same
 * answer as "this chain was never asked for one".
 */
export const PRE_ATTESTATION_REGRESSION_GENERATIONS: readonly string[] = [
  "v1",
  "pre-narrow-regression-lease",
  "pre-adjudication",
  "pre-zero-gate",
  "10", "9", "human-12", "regression-first-13", "human-6",
];

/**
 * Whether this chain may be authorized to merge `headSha`.
 *
 * `satisfied` with a null attestation is the legacy carve-out: a chain whose
 * Regression step is the frozen v1 generation produces no proof line at all, so
 * requiring one would strand it. Every current chain runs v2 and must present a
 * row naming the exact head being authorized.
 */
export const requireGateAttestation = async (
  tx: Tx,
  input: { chainId: string | null; headSha: string },
): Promise<GateAttestationRequirement> => {
  if (!input.chainId) {
    return { satisfied: false, reason: "merge authorization requires a chain" };
  }
  const found = await tx.mergeGateAttestation.findUnique({
    where: { chainId_headSha: { chainId: input.chainId, headSha: input.headSha } },
    select: { headSha: true, baseHeadSha: true, proof: true },
  });
  if (found) return { satisfied: true, attestation: found };
  // The generation probe reads the chain's *step*, not its output: an output is
  // absent both before the Regression run lands and on a frozen v1 chain, and
  // only the second may skip the requirement. The exemption is stated as a
  // registered generation rather than inferred from a failed match on the
  // current outputKind, so renaming or adding a kind cannot silently exempt a
  // chain the gate never signed for.
  const chainSteps = await tx.task.findMany({
    where: { chainId: input.chainId, templateStep: { isNot: null } },
    select: { templateStep: { select: { outputKind: true, taskTemplate: { select: { name: true } } } } },
  });
  const regressionStep = chainSteps
    .map((task) => task.templateStep)
    .find((step) => step !== null && stepRole(step) === "regression") ?? null;
  if (regressionStep?.outputKind === "regression-verification"
    && PRE_ATTESTATION_REGRESSION_GENERATIONS.includes(stepGeneration(regressionStep))) {
    return { satisfied: true, attestation: null };
  }
  return {
    satisfied: false,
    reason: `no merge gate attestation for head ${input.headSha}; the gate never signed this commit`,
  };
};
