import { MergeRecoveryStatus, type MergeRecoveryAttempt, type Prisma } from "@prisma/client";

import { stepRole } from "./step-role.js";

export const MERGE_TAIL_SCHEMA_VERSION = 1;
export const REGRESSION_VERIFICATION_SCHEMA_VERSION = 2;
export const REGRESSION_VERIFICATION_OUTPUT_KIND = "regression-verification-v2";
export const LEGACY_REGRESSION_VERIFICATION_OUTPUT_KIND = "regression-verification";
export const REGRESSION_VERIFICATION_OUTPUT_KINDS = [
  REGRESSION_VERIFICATION_OUTPUT_KIND,
  LEGACY_REGRESSION_VERIFICATION_OUTPUT_KIND,
] as const;
export const isRegressionVerificationOutputKind = (kind: string | null | undefined): boolean =>
  REGRESSION_VERIFICATION_OUTPUT_KINDS.some((candidate) => candidate === kind);
export const MERGE_READINESS_OUTPUT_KIND = "merge-authorization";
export const MERGE_TAIL_KIND = {
  baseDriftRecovery: "mergeTail.baseDriftRecovery",
  leaseContention: "mergeTail.leaseContention",
  leaseHandoff: "mergeTail.leaseHandoff",
  leaseHold: "mergeTail.leaseHold",
  leaseRelease: "mergeTail.leaseRelease",
  regression: "mergeTail.regression",
  repairAttempt: "mergeTail.repairAttempt",
  repairResult: "mergeTail.repairResult",
  requeue: "mergeTail.requeue",
  readiness: "mergeTail.readiness",
} as const;

/**
 * How many automatic repairs one chain gets per repair kind before the tail
 * stops. A semantic or gate FAIL after a repair is a different verdict against
 * a different tree, so one more attempt is progress rather than a loop; a
 * refresh conflict is not covered by this and stays at one attempt per head.
 */
export const MAX_MERGE_TAIL_REPAIR_ATTEMPTS = 2;

export const MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES = 2;
export const MAX_BASE_DRIFT_CLASSIFICATION_RETRIES = 30;

export type MergeRecoveryPhase =
  | "validation"
  | "repair"
  | "authorization-wait"
  | "downstream-stop"
  | "succeeded"
  | "actual-failure";

export const RECOVERY_TRANSITIONS: Record<MergeRecoveryStatus, ReadonlySet<MergeRecoveryStatus>> = {
  [MergeRecoveryStatus.VALIDATING]: new Set([MergeRecoveryStatus.REPAIRING, MergeRecoveryStatus.FAILED]),
  [MergeRecoveryStatus.REPAIRING]: new Set([
    MergeRecoveryStatus.AWAITING_AUTHORIZATION,
    MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
  ]),
  [MergeRecoveryStatus.AWAITING_AUTHORIZATION]: new Set([
    MergeRecoveryStatus.REPAIRING,
    MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
    MergeRecoveryStatus.SUCCEEDED,
  ]),
  [MergeRecoveryStatus.BLOCKED_DOWNSTREAM]: new Set([MergeRecoveryStatus.REPAIRING]),
  [MergeRecoveryStatus.SUCCEEDED]: new Set(),
  [MergeRecoveryStatus.FAILED]: new Set([MergeRecoveryStatus.VALIDATING]),
};

export const mergeRecoveryTransitionAllowed = (
  from: MergeRecoveryStatus,
  to: MergeRecoveryStatus,
): boolean => from === to || RECOVERY_TRANSITIONS[from].has(to);

export type MergeRecoveryTransitionData = Omit<Prisma.MergeRecoveryAttemptUpdateManyMutationInput, "status">;

export type MergeRecoveryTransitionGuard = Prisma.MergeRecoveryAttemptWhereInput;

/**
 * The fail-loud persistence primitive for every recovery status change. Named
 * merge-tail operations own the surrounding Task and marker writes; the
 * activation module also uses this primitive for its authorization-bound
 * terminal success.
 */
export function transitionMergeRecovery(
  tx: Prisma.TransactionClient,
  aggregateId: string,
  target: MergeRecoveryStatus,
  data?: MergeRecoveryTransitionData,
): Promise<MergeRecoveryAttempt>;
export function transitionMergeRecovery(
  tx: Prisma.TransactionClient,
  aggregateId: string,
  target: MergeRecoveryStatus,
  data: MergeRecoveryTransitionData,
  expected: MergeRecoveryTransitionGuard,
): Promise<MergeRecoveryAttempt | null>;
export async function transitionMergeRecovery(
  tx: Prisma.TransactionClient,
  aggregateId: string,
  target: MergeRecoveryStatus,
  data: MergeRecoveryTransitionData = {},
  expected?: MergeRecoveryTransitionGuard,
): Promise<MergeRecoveryAttempt | null> {
  const aggregate = await tx.mergeRecoveryAttempt.findUnique({
    where: { id: aggregateId },
    select: { status: true },
  });
  if (!aggregate) {
    if (expected) return null;
    throw new Error(`Merge recovery aggregate ${aggregateId} is absent`);
  }
  if (expected) {
    const guardedFrom = typeof expected.status === "string" ? expected.status : aggregate.status;
    if (!mergeRecoveryTransitionAllowed(guardedFrom, target)) {
      throw new Error(`Illegal merge recovery transition ${guardedFrom} -> ${target} for ${aggregateId}`);
    }
    if (aggregate.status !== guardedFrom) return null;
    const updated = await tx.mergeRecoveryAttempt.updateMany({
      where: { AND: [{ id: aggregateId, status: aggregate.status }, expected] },
      data: { ...data, status: target },
    });
    return updated.count === 1
      ? tx.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: aggregateId } })
      : null;
  }
  if (!mergeRecoveryTransitionAllowed(aggregate.status, target)) {
    throw new Error(`Illegal merge recovery transition ${aggregate.status} -> ${target} for ${aggregateId}`);
  }
  return tx.mergeRecoveryAttempt.update({
    where: { id: aggregateId },
    data: { ...data, status: target },
  });
}

/** Carries an expected in-progress recovery onto the Regression Run born after
 * genuine repair completion. Callers qualify ordinary repairs before this
 * point, so a missing or inactive aggregate is a state-machine fault. */
export const carryMergeRecoveryRun = async (
  tx: Prisma.TransactionClient,
  input: { regressionTaskId: string; recoveryRunId: string; previousRecoveryRunId: string },
): Promise<void> => {
  const aggregate = await tx.mergeRecoveryAttempt.findFirst({
    where: { regressionTaskId: input.regressionTaskId },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  if (!aggregate) {
    throw new Error(`Merge recovery for Regression task ${input.regressionTaskId} is absent`);
  }
  if (aggregate.status !== MergeRecoveryStatus.REPAIRING) {
    throw new Error(`Merge recovery ${aggregate.id} is ${aggregate.status}, not REPAIRING`);
  }
  if (aggregate.recoveryRunId !== input.previousRecoveryRunId) {
    throw new Error(`Merge recovery ${aggregate.id} is not bound to repaired Run ${input.previousRecoveryRunId}`);
  }
  const transitioned = await transitionMergeRecovery(
    tx,
    aggregate.id,
    MergeRecoveryStatus.REPAIRING,
    { recoveryRunId: input.recoveryRunId },
    {
      status: MergeRecoveryStatus.REPAIRING,
      regressionTaskId: input.regressionTaskId,
      recoveryRunId: input.previousRecoveryRunId,
    },
  );
  if (!transitioned) {
    throw new Error(`Merge recovery ${aggregate.id} changed while carrying its repaired Regression Run`);
  }
};

export const mergeRecoveryPhase = (status: MergeRecoveryStatus): MergeRecoveryPhase => (
  status === MergeRecoveryStatus.VALIDATING ? "validation"
    : status === MergeRecoveryStatus.REPAIRING ? "repair"
      : status === MergeRecoveryStatus.AWAITING_AUTHORIZATION ? "authorization-wait"
        : status === MergeRecoveryStatus.BLOCKED_DOWNSTREAM ? "downstream-stop"
          : status === MergeRecoveryStatus.SUCCEEDED ? "succeeded"
            : "actual-failure"
);

const SHA = /^[0-9a-f]{40}$/u;
const PASS_GATE_PROOF = /^MERGE GATE: PASS ([0-9a-f]{40})$/u;
const FAIL_GATE_PROOF = /^MERGE GATE: FAIL \(.+\)$/u;

type RegressionVerdictSchemaVersion = typeof MERGE_TAIL_SCHEMA_VERSION | typeof REGRESSION_VERIFICATION_SCHEMA_VERSION;

export type RegressionVerdict =
  | { schemaVersion: typeof MERGE_TAIL_SCHEMA_VERSION; outcome: "pass"; headSha: string; baseHeadSha: string; gateVerdict: "PASS" }
  | { schemaVersion: typeof REGRESSION_VERIFICATION_SCHEMA_VERSION; outcome: "pass"; headSha: string; baseHeadSha: string; gateVerdict: "PASS"; gateProof: string }
  | { schemaVersion: RegressionVerdictSchemaVersion; outcome: "review-fail"; headSha: string; baseHeadSha: string; summary: string }
  | { schemaVersion: typeof MERGE_TAIL_SCHEMA_VERSION; outcome: "gate-fail"; headSha: string; baseHeadSha: string; gateVerdict: "FAIL"; summary: string; gateFailureExcerpt?: string }
  | { schemaVersion: typeof REGRESSION_VERIFICATION_SCHEMA_VERSION; outcome: "gate-fail"; headSha: string; baseHeadSha: string; gateVerdict: "FAIL"; gateProof: string; summary: string; gateFailureExcerpt?: string }
  | { schemaVersion: RegressionVerdictSchemaVersion; outcome: "refresh-conflict"; headSha: string; baseHeadSha: string; summary: string };

export type RegressionRepairHandoff = {
  schemaVersion: 1;
  trigger: { kind: "regression-verdict"; verdict: Exclude<RegressionVerdict, { outcome: "pass" }> };
  repair: {
    kind: "review-fix" | "gate-fix" | "refresh-conflict";
    taskId: string;
    startHeadSha: string;
    targetHeadSha: string;
    resolvedHeadSha: string;
    outputKind: string;
    outputBody: string;
  };
  retry?: {
    previousRunId: string;
    startHeadSha: string;
  };
};

export type ResolverResult =
  | { schemaVersion: 1; outcome: "resolved"; startHeadSha: string; targetHeadSha: string; resolvedHeadSha: string; tradeOffs: string[]; changedTestExpectations: string[] }
  | { schemaVersion: 1; outcome: "unable"; startHeadSha: string; targetHeadSha: string; blockingContradiction: string };

export type RegressionParse =
  | { status: "ok"; verdict: RegressionVerdict }
  | { status: "invalid"; reason: string };

export const parseRegressionVerdict = (
  body: string | null | undefined,
  outputKind?: string | null,
): RegressionParse => {
  if (!body) return { status: "invalid", reason: "missing regression output" };
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { status: "invalid", reason: "regression output is not JSON" }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid", reason: "regression output is not an object" };
  }
  const value = parsed as Record<string, unknown>;
  const expectedSchemaVersion = outputKind === REGRESSION_VERIFICATION_OUTPUT_KIND
    ? REGRESSION_VERIFICATION_SCHEMA_VERSION
    : outputKind === LEGACY_REGRESSION_VERIFICATION_OUTPUT_KIND
      ? MERGE_TAIL_SCHEMA_VERSION
      : null;
  if (expectedSchemaVersion !== null && value.schemaVersion !== expectedSchemaVersion) {
    return { status: "invalid", reason: `regression ${outputKind} requires schemaVersion ${String(expectedSchemaVersion)}` };
  }
  if (value.schemaVersion !== MERGE_TAIL_SCHEMA_VERSION
    && value.schemaVersion !== REGRESSION_VERIFICATION_SCHEMA_VERSION) {
    return { status: "invalid", reason: "unsupported regression schemaVersion" };
  }
  if (typeof value.headSha !== "string" || !SHA.test(value.headSha)) return { status: "invalid", reason: "invalid regression headSha" };
  if (typeof value.baseHeadSha !== "string" || !SHA.test(value.baseHeadSha)) return { status: "invalid", reason: "invalid regression baseHeadSha" };
  if (value.outcome === "pass" && value.gateVerdict === "PASS") {
    if (value.schemaVersion === REGRESSION_VERIFICATION_SCHEMA_VERSION) {
      const proof = typeof value.gateProof === "string" ? PASS_GATE_PROOF.exec(value.gateProof) : null;
      if (!proof) return { status: "invalid", reason: "invalid regression gateProof for PASS" };
      if (proof[1] !== value.headSha) {
        return { status: "invalid", reason: "regression gateProof oid does not match headSha" };
      }
    }
    return { status: "ok", verdict: value as RegressionVerdict };
  }
  if (value.outcome === "review-fail" && typeof value.summary === "string" && value.summary.trim().length > 0) {
    return { status: "ok", verdict: value as RegressionVerdict };
  }
  if (value.outcome === "gate-fail" && value.gateVerdict === "FAIL" && typeof value.summary === "string" && value.summary.length > 0) {
    if (Object.hasOwn(value, "gateFailureExcerpt") && typeof value.gateFailureExcerpt !== "string") {
      return { status: "invalid", reason: "invalid regression gateFailureExcerpt" };
    }
    if (value.schemaVersion === REGRESSION_VERIFICATION_SCHEMA_VERSION
      && (typeof value.gateProof !== "string" || !FAIL_GATE_PROOF.test(value.gateProof))) {
      return { status: "invalid", reason: "invalid regression gateProof for FAIL" };
    }
    return { status: "ok", verdict: value as RegressionVerdict };
  }
  if (value.outcome === "refresh-conflict" && typeof value.summary === "string" && value.summary.length > 0) {
    return { status: "ok", verdict: value as RegressionVerdict };
  }
  return { status: "invalid", reason: "regression outcome and gateVerdict disagree or required summary is absent" };
};

export const parseResolverResult = (
  body: string | null | undefined,
): { status: "ok"; result: ResolverResult } | { status: "invalid"; reason: string } => {
  let value: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(body ?? "null") as unknown;
    value = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return { status: "invalid", reason: "merge-resolver-opus-medium output is not valid JSON" };
  }
  if (!value || value.schemaVersion !== 1 || (value.outcome !== "resolved" && value.outcome !== "unable")) {
    return { status: "invalid", reason: "merge-resolver-opus-medium output has an unknown schema or outcome" };
  }
  if (typeof value.startHeadSha !== "string" || !SHA.test(value.startHeadSha)
    || typeof value.targetHeadSha !== "string" || !SHA.test(value.targetHeadSha)) {
    return { status: "invalid", reason: "merge-resolver-opus-medium output is not bound to well-formed start and target heads" };
  }
  if (value.outcome === "unable") {
    if (typeof value.blockingContradiction !== "string" || value.blockingContradiction.trim().length === 0) {
      return { status: "invalid", reason: "merge-resolver-opus-medium unable output has no blocking contradiction" };
    }
    return { status: "ok", result: value as ResolverResult };
  }
  if (typeof value.resolvedHeadSha !== "string" || !SHA.test(value.resolvedHeadSha)
    || !Array.isArray(value.tradeOffs) || !value.tradeOffs.every((entry) => typeof entry === "string")
    || !Array.isArray(value.changedTestExpectations) || !value.changedTestExpectations.every((entry) => typeof entry === "string")) {
    return { status: "invalid", reason: "merge-resolver-opus-medium resolved output is malformed or has no resolved head" };
  }
  return { status: "ok", result: value as ResolverResult };
};

export type MergeReadinessStepShape = {
  stepIndex: number;
  outputKind: string;
  taskTemplate?: { name: string } | null;
  taskTemplateName?: string | null;
} | null | undefined;

export const isMergeReadinessStep = (step: MergeReadinessStepShape): boolean =>
  step !== null && step !== undefined && stepRole(step) === "readiness";

const DEFENSE_EXACT = new Set([
  "scripts/merge-gate.sh",
  "scripts/merge-lease.sh",
  "packages/runner/runtime-tools/regression-verification.sh",
  "packages/runner/scripts/build-runtime-tools.mjs",
  "packages/runner/src/workspace.ts",
  "packages/runner/src/adapters.ts",
  "packages/runner/src/adapters/runtime.ts",
  "packages/db/src/chain-activation.ts",
  "packages/db/src/claim-contract.ts",
  "packages/db/src/inbox-decision.ts",
  "packages/db/src/merge-gate.ts",
  "packages/db/src/merge-integrator.ts",
  "packages/db/src/gate-attestation.ts",
  "packages/db/src/merge-integrator-db.ts",
  "packages/db/src/merge-tail.ts",
  "packages/db/src/merge-tail-markers.ts",
  "packages/db/src/canonical-output-schema.ts",
  "packages/db/src/template-sources.ts",
  "packages/db/src/agent-contract.ts",
  "packages/db/prisma/seed.ts",
  "packages/db/prisma/sync-canonical-prompts.ts",
  "packages/api/src/merge-readiness-worker.ts",
  "packages/api/src/run-completion.ts",
  "packages/api/src/regression-repair-handoff.ts",
  "packages/api/src/reconcile.ts",
  "packages/api/src/canonical-task-output.ts",
  "packages/api/src/github-read.ts",
  "packages/api/src/index.ts",
  "packages/api/src/app.ts",
  "agents/roles/merge-resolver-opus-medium.md",
  "agents/roles/merge-integrator.md",
]);

export const defenseListReason = (path: string): string | null => {
  if (DEFENSE_EXACT.has(path)) return "merge-tail-machinery";
  if (path.startsWith("packages/api/src/merge-")) return "merge-tail-machinery";
  if (path.startsWith("scripts/gate-worker/") || path.startsWith("packages/runner/runtime-tools/gate-worker/")) return "gate-worker";
  if (path.startsWith("packages/db/prisma/migrations/")) return "database-migration";
  if (path.startsWith("packages/merge-executor/")) return "merge-execution";
  if (path.startsWith("agents/templates/direct-engineer-workflow/")
    || path.startsWith("agents/templates/compound-engineer-workflow/")
    || path.startsWith("agents/templates/pr-engineer-workflow/")) return "template-step-set";
  return null;
};

export type ChangedFile = { filename: string; previousFilename: string | null; patch: string | null };

export const defenseTriggers = (files: ChangedFile[]): Array<{ path: string; reason: string }> => files.flatMap((file) => {
  const paths = file.previousFilename && file.previousFilename !== file.filename
    ? [file.filename, file.previousFilename]
    : [file.filename];
  return paths.flatMap((path) => {
    const reason = defenseListReason(path);
    return reason ? [{ path, reason }] : [];
  });
});

export const asJsonObject = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null => (
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
);
