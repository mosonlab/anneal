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

/** Every requeue a readiness Task recorded, oldest first. */
export const readReadinessRequeues = async (tx: Tx, taskId: string): Promise<ReadinessRequeue[]> => {
  const rows = await tx.taskActivity.findMany({
    where: { taskId, metadata: { path: ["kind"], equals: MERGE_READINESS_REQUEUE_KIND } },
    select: { metadata: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.flatMap((row) => {
    const requeue = readinessRequeueFromMetadata(row.metadata);
    return requeue ? [requeue] : [];
  });
};

/**
 * Records one pre-authorization requeue on the readiness Task.
 *
 * The caller passes its settlement transaction, so the count cannot drift from
 * the grants: a settlement that rolls back takes its counter row with it, and
 * the ordinal is read under the same transaction that writes the next one.
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
  const prior = await tx.taskActivity.count({
    where: {
      taskId: input.readinessTaskId,
      metadata: { path: ["kind"], equals: MERGE_READINESS_REQUEUE_KIND },
    },
  });
  const requeue: ReadinessRequeue = {
    ordinal: prior + 1,
    staleBaseSha: input.staleBaseSha,
    currentBaseSha: input.currentBaseSha,
    budgetGrant: input.budgetGrant,
  };
  await tx.taskActivity.create({ data: {
    taskId: input.readinessTaskId,
    actorType: "control-plane",
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
