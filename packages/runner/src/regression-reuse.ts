import type { ClaimedTask } from "./api.js";
import type { Workspace } from "./workspace.js";

const SHA = /^[0-9a-f]{40}$/u;
const REGRESSION_OUTPUT_KINDS = new Set([
  "regression-verification-v2",
  "regression-verification-v3",
]);

type SemanticReuseSource = {
  outputKind: "regression-verification-v2" | "regression-verification-v3";
  runId: string;
  headSha: string;
};

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const nonEmptyToken = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !/\s/u.test(value);

const validV2SemanticPass = (verdict: Record<string, unknown>): boolean => {
  if (verdict.schemaVersion !== 2 || (verdict.outcome !== "pass" && verdict.outcome !== "gate-fail")) return false;
  if (typeof verdict.headSha !== "string" || !SHA.test(verdict.headSha)) return false;
  if (typeof verdict.baseHeadSha !== "string" || !SHA.test(verdict.baseHeadSha)) return false;
  if (verdict.outcome === "pass") {
    if (verdict.gateVerdict !== "PASS" || verdict.gateProof !== `MERGE GATE: PASS ${verdict.headSha}`) return false;
  } else {
    if (verdict.gateVerdict !== "FAIL") return false;
    if (typeof verdict.summary !== "string" || verdict.summary.length === 0) return false;
    if (typeof verdict.gateProof !== "string" || !/^MERGE GATE: FAIL \(.+\)$/u.test(verdict.gateProof)) return false;
    if (Object.hasOwn(verdict, "gateFailureExcerpt") && typeof verdict.gateFailureExcerpt !== "string") return false;
  }
  const hasReuse = Object.hasOwn(verdict, "semanticVerdict") || Object.hasOwn(verdict, "semanticSourceRunId");
  return !hasReuse || (verdict.semanticVerdict === "reused" && nonEmptyToken(verdict.semanticSourceRunId));
};

const validV3SemanticPass = (verdict: Record<string, unknown>): boolean => {
  if (verdict.schemaVersion !== 3 || verdict.outcome !== "semantic-pass") return false;
  if (typeof verdict.headSha !== "string" || !SHA.test(verdict.headSha)) return false;
  if (typeof verdict.baseHeadSha !== "string" || !SHA.test(verdict.baseHeadSha)) return false;
  const hasReuse = Object.hasOwn(verdict, "semanticVerdict") || Object.hasOwn(verdict, "semanticSourceRunId");
  return !hasReuse || (verdict.semanticVerdict === "reused" && nonEmptyToken(verdict.semanticSourceRunId));
};

/**
 * Select the one recovery shape whose semantic verdict may be reused without a
 * model. The control plane already fences the marker to this Run; the Runner
 * independently checks every identity and exact-head binding before it elects
 * the fixed runtime command.
 */
export const semanticReuseSourceFor = (
  claim: ClaimedTask,
  workspace: Workspace,
): SemanticReuseSource | null => {
  if (claim.resume !== null || claim.regressionRepairHandoff !== null) return null;
  const outputKind = claim.task.templateStep?.outputKind;
  if (!outputKind || !REGRESSION_OUTPUT_KINDS.has(outputKind)) return null;
  const context = claim.regressionRecoveryContext;
  if (!context || context.state !== "queued" || context.recoveryRunId !== claim.run.id) return null;
  if (!SHA.test(context.currentBaseSha) || !SHA.test(context.authorizedHeadSha)) return null;
  if (context.ciFailures !== undefined && context.ciFailures.length > 0) return null;
  const prior = context.priorOutput;
  if (!prior || !nonEmptyToken(prior.runId) || prior.runId === claim.run.id) return null;
  if (!REGRESSION_OUTPUT_KINDS.has(prior.kind)) return null;
  if (prior.commitSha !== context.authorizedHeadSha || workspace.baseSha !== context.authorizedHeadSha) return null;
  if (claim.run.baseSha !== null && claim.run.baseSha !== workspace.baseSha) return null;
  let verdict: Record<string, unknown> | null = null;
  try {
    verdict = object(JSON.parse(prior.body));
  } catch {
    return null;
  }
  if (!verdict) return null;
  const sourceValid = prior.kind === "regression-verification-v2"
    ? validV2SemanticPass(verdict)
    : validV3SemanticPass(verdict);
  if (!sourceValid || verdict.headSha !== context.authorizedHeadSha) return null;
  return {
    outputKind: prior.kind as SemanticReuseSource["outputKind"],
    runId: prior.runId,
    headSha: context.authorizedHeadSha,
  };
};
