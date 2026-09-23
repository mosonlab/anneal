import {
  markerFromMetadata,
  MERGE_TAIL_KIND,
  Prisma,
} from "@anneal/db";
import type { RegressionRecoveryContext } from "@anneal/db/claim-contract";

type DbTx = Prisma.TransactionClient;

const text = (value: unknown): value is string => (
  typeof value === "string" && value.length > 0
);

const priorOutput = (value: unknown): RegressionRecoveryContext["priorOutput"] | undefined => {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!text(raw.runId) || !text(raw.kind) || typeof raw.body !== "string"
    || !(raw.commitSha === null || typeof raw.commitSha === "string")) return undefined;
  return {
    runId: raw.runId,
    kind: raw.kind,
    body: raw.body,
    commitSha: raw.commitSha,
  };
};

const ciFailures = (value: unknown): RegressionRecoveryContext["ciFailures"] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return undefined;
  const failures = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const raw = entry as Record<string, unknown>;
    return text(raw.name) && text(raw.conclusion) && text(raw.log)
      ? { name: raw.name, conclusion: raw.conclusion, log: raw.log } : null;
  });
  return failures.every((entry) => entry !== null)
    ? failures as NonNullable<RegressionRecoveryContext["ciFailures"]> : undefined;
};

const contextFromMetadata = (
  metadata: Prisma.JsonValue | null | undefined,
  runId: string,
): RegressionRecoveryContext | null => {
  const marker = markerFromMetadata(metadata);
  if (marker?.kind !== "baseDriftRecovery" || marker.state !== "queued") return null;
  const { raw } = marker;
  if (raw.recoveryRunId !== runId || !text(raw.currentBaseSha) || !text(raw.authorizedHeadSha)
    || !text(raw.recoveryRunId) || !Object.hasOwn(raw, "priorOutput")) return null;
  const output = priorOutput(raw.priorOutput);
  if (output === undefined) return null;
  const failures = ciFailures(raw.ciFailures);
  if (Object.hasOwn(raw, "ciFailures") && !failures) return null;
  return {
    state: "queued",
    currentBaseSha: raw.currentBaseSha,
    authorizedHeadSha: raw.authorizedHeadSha,
    recoveryRunId: raw.recoveryRunId,
    priorOutput: output,
    ...(failures ? { ciFailures: failures } : {}),
  };
};

/**
 * Read the one durable base-drift recovery handoff eligible for this claim.
 * The newest marker wins: an older queued marker must not survive a later
 * recovery result or be used to bypass a newer persisted output. The actor
 * fence keeps runner-authored activity from becoming control-plane authority.
 */
export const regressionRecoveryContextForClaim = async (
  tx: DbTx,
  input: { taskId: string; runId: string },
): Promise<RegressionRecoveryContext | null> => {
  const marker = await tx.taskActivity.findFirst({
    where: {
      taskId: input.taskId,
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.baseDriftRecovery },
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return contextFromMetadata(marker?.metadata, input.runId);
};

export { contextFromMetadata as parseRegressionRecoveryContext };
