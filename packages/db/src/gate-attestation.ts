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
 * once at ingestion, and both channels require it.
 *
 * `deriveGateAttestation` is pure and is the only place that decides whether an
 * output attests anything. Legacy `regression-verification` (v1) outputs carry
 * no proof line and are frozen, so they derive nothing and `requireGateAttestation`
 * leaves their chains alone.
 */

import type { Prisma } from "@prisma/client";

import {
  REGRESSION_VERIFICATION_OUTPUT_KIND,
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
 * Regression verification that passed the gate attests: a review failure, a
 * gate failure and a refresh conflict all describe a head the gate did *not*
 * sign off.
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

/**
 * Records the attestation an output carries. Idempotent on `(chainId, headSha)`:
 * a repair loop may re-persist the same passing verdict, and a Regression step
 * re-run at the same head attests the same fact.
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
    update: {},
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
export const PRE_ATTESTATION_REGRESSION_GENERATIONS: readonly string[] = ["v1"];

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
  if (regressionStep && PRE_ATTESTATION_REGRESSION_GENERATIONS.includes(stepGeneration(regressionStep))) {
    return { satisfied: true, attestation: null };
  }
  return {
    satisfied: false,
    reason: `no merge gate attestation for head ${input.headSha}; the gate never signed this commit`,
  };
};
