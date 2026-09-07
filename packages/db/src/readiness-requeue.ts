import type { Prisma } from "@prisma/client";

import { asJsonObject } from "./merge-tail.js";

type Tx = Prisma.TransactionClient;

/**
 * Merge readiness requeues a candidate whose base moved before authorization,
 * and each requeue funds the replacement Regression run with one budget grant.
 * The grant is real spend, so the requeue is recorded as its own activity
 * family rather than as another `mergeTail.*` marker: merge-tail markers are a
 * recent-state window read by the tail's own decisions, and these rows are a
 * per-chain count that must stay complete however deep the tail gets.
 */
export const MERGE_READINESS_REQUEUE_KIND = "mergeReadiness.requeue";
export const MERGE_READINESS_REQUEUE_SCHEMA_VERSION = 1;
/**
 * Only the control plane settles a requeue. The public activity route keeps
 * caller-supplied metadata on an `operator` row, so an ordinary note carrying
 * this kind would otherwise advance the next ordinal and inflate the counters;
 * every reader and the ordinal itself qualify on the actor as well as the kind.
 */
export const MERGE_READINESS_REQUEUE_ACTOR_TYPE = "control-plane";

/**
 * The rows the counters may read, narrowed to what a query can express. A row
 * that passes this still has to carry a numeric ordinal to be a requeue, which
 * only `readinessRequeueFromMetadata` can decide; every reader, and the ordinal
 * itself, folds this row set through that check.
 */
export const readinessRequeueActivityWhere = <T>(taskId: T) => ({
  taskId,
  actorType: MERGE_READINESS_REQUEUE_ACTOR_TYPE,
  metadata: { path: ["kind"], equals: MERGE_READINESS_REQUEUE_KIND },
});

/** One recorded pre-authorization requeue, as the counters read it. */
export type ReadinessRequeue = {
  /** One-based position of this requeue among the chain's, oldest first. */
  ordinal: number;
  staleBaseSha: string | null;
  currentBaseSha: string | null;
  /** Extra attempts the settlement granted, which is what the requeue cost. */
  budgetGrant: number;
};

export type ReadinessRequeueTotals = {
  readinessRequeues: number;
  readinessGrants: number;
};

export const EMPTY_READINESS_REQUEUE_TOTALS: ReadinessRequeueTotals = {
  readinessRequeues: 0,
  readinessGrants: 0,
};

const text = (raw: Record<string, unknown>, field: string): string | null =>
  typeof raw[field] === "string" ? raw[field] : null;

/** The requeue a `TaskActivity` row carries, or null when it is not one. */
export const readinessRequeueFromMetadata = (
  metadata: Prisma.JsonValue | null | undefined,
): ReadinessRequeue | null => {
  const raw = asJsonObject(metadata);
  if (!raw || raw.kind !== MERGE_READINESS_REQUEUE_KIND) return null;
  const ordinal = typeof raw.ordinal === "number" ? raw.ordinal : null;
  if (ordinal === null) return null;
  return {
    ordinal,
    staleBaseSha: text(raw, "staleBaseSha"),
    currentBaseSha: text(raw, "currentBaseSha"),
    budgetGrant: typeof raw.budgetGrant === "number" ? raw.budgetGrant : 0,
  };
};

/** How many times these rows requeued, and what the requeues granted. */
export const readinessRequeueTotals = (
  rows: readonly { metadata: Prisma.JsonValue | null }[],
): ReadinessRequeueTotals => {
  const requeues = rows.flatMap((row) => {
    const requeue = readinessRequeueFromMetadata(row.metadata);
    return requeue ? [requeue] : [];
  });
  return {
    readinessRequeues: requeues.length,
    readinessGrants: requeues.reduce((sum, requeue) => sum + requeue.budgetGrant, 0),
  };
};

/**
 * Records one pre-authorization requeue on the readiness Task, numbered by the
 * requeues the counters can already read on this chain.
 *
 * The caller passes its settlement transaction, so the count cannot drift from
 * the grants: a settlement that rolls back takes its counter row with it.
 *
 * Precondition: the caller holds the readiness claim for this chain
 * (`readiness-claim.ts`), whose row-locked Step serializes the settlements of
 * one chain. Sharing a transaction does not serialize anything by itself --
 * under READ COMMITTED two concurrent counts would both read the same prior
 * total -- so the claim, not the transaction, is what makes the ordinal unique.
 *
 * `budgetGrant` must be a non-negative integer: it is stored verbatim in JSON
 * metadata and read back as an integer by the costs SQL.
 */
export const recordReadinessRequeue = async (
  tx: Tx,
  input: {
    readinessTaskId: string;
    regressionTaskId: string;
    staleBaseSha: string;
    currentBaseSha: string;
    budgetGrant: number;
    reason: string;
  },
): Promise<ReadinessRequeue> => {
  if (!Number.isInteger(input.budgetGrant) || input.budgetGrant < 0) {
    throw new Error(`readiness requeue budgetGrant must be a non-negative integer, got ${String(input.budgetGrant)}`);
  }
  // Counted the way the board and the costs view count, so an unnumbered row
  // cannot consume an ordinal that neither of them can see.
  const prior = await tx.taskActivity.findMany({
    where: readinessRequeueActivityWhere(input.readinessTaskId),
    select: { metadata: true },
  });
  const requeue: ReadinessRequeue = {
    ordinal: readinessRequeueTotals(prior).readinessRequeues + 1,
    staleBaseSha: input.staleBaseSha,
    currentBaseSha: input.currentBaseSha,
    budgetGrant: input.budgetGrant,
  };
  await tx.taskActivity.create({ data: {
    taskId: input.readinessTaskId,
    actorType: MERGE_READINESS_REQUEUE_ACTOR_TYPE,
    body: `Merge readiness requeue ${String(requeue.ordinal)}: ${input.reason};`
      + ` ${input.staleBaseSha} -> ${input.currentBaseSha}; ${String(input.budgetGrant)} extra attempt granted`,
    metadata: {
      schemaVersion: MERGE_READINESS_REQUEUE_SCHEMA_VERSION,
      kind: MERGE_READINESS_REQUEUE_KIND,
      ordinal: requeue.ordinal,
      reason: input.reason,
      regressionTaskId: input.regressionTaskId,
      staleBaseSha: input.staleBaseSha,
      currentBaseSha: input.currentBaseSha,
      budgetGrant: input.budgetGrant,
    } as Prisma.InputJsonObject,
  } });
  return requeue;
};
