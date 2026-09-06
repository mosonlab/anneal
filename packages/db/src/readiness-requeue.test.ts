import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "@prisma/client";

import {
  MERGE_READINESS_REQUEUE_KIND,
  readReadinessRequeues,
  readinessRequeueFromMetadata,
  readinessRequeueTotals,
  recordReadinessRequeue,
} from "./readiness-requeue.js";

type Row = { taskId: string; metadata: unknown };

/**
 * A transaction that keeps the rows it is given. The ordinal is the module's to
 * own, so the second requeue is counted against what the first one wrote rather
 * than against a number the test supplies.
 */
const recordingTx = (rows: Row[] = []) => {
  const matches = (row: Row): boolean =>
    (row.metadata as { kind?: unknown } | null)?.kind === MERGE_READINESS_REQUEUE_KIND;
  const tx = {
    taskActivity: {
      count: async ({ where }: { where: { taskId: string } }) =>
        rows.filter((row) => row.taskId === where.taskId && matches(row)).length,
      findMany: async ({ where }: { where: { taskId: string } }) =>
        rows.filter((row) => row.taskId === where.taskId && matches(row)),
      create: async ({ data }: { data: Row }) => {
        rows.push(data);
        return data;
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, rows };
};

const requeue = (tx: Prisma.TransactionClient, staleBaseSha: string, currentBaseSha: string) =>
  recordReadinessRequeue(tx, {
    readinessTaskId: "readiness",
    regressionTaskId: "regression",
    staleBaseSha,
    currentBaseSha,
    budgetGrant: 1,
    reason: "base moved before authorization",
  });

test("consecutive requeues on one chain are numbered from one", async () => {
  const { tx, rows } = recordingTx();
  assert.equal((await requeue(tx, "a".repeat(40), "b".repeat(40))).ordinal, 1);
  assert.equal((await requeue(tx, "b".repeat(40), "c".repeat(40))).ordinal, 2);

  assert.equal(rows.length, 2);
  const recorded = await readReadinessRequeues(tx, "readiness");
  assert.deepEqual(recorded.map((row) => row.ordinal), [1, 2]);
  assert.deepEqual(recorded.map((row) => row.staleBaseSha), ["a".repeat(40), "b".repeat(40)]);
  assert.deepEqual(recorded.map((row) => row.currentBaseSha), ["b".repeat(40), "c".repeat(40)]);
  // The grant is what the requeue cost, and it is recorded beside the count so
  // the two can never be read from different rows.
  assert.deepEqual(readinessRequeueTotals(rows as { metadata: Prisma.JsonValue }[]), {
    readinessRequeues: 2,
    readinessGrants: 2,
  });
});

test("another task's requeues do not advance this chain's ordinal", async () => {
  const { tx } = recordingTx([
    { taskId: "other-readiness", metadata: { kind: MERGE_READINESS_REQUEUE_KIND, ordinal: 1, budgetGrant: 1 } },
  ]);
  assert.equal((await requeue(tx, "a".repeat(40), "b".repeat(40))).ordinal, 1);
});

test("activity of any other kind is not a requeue", () => {
  assert.equal(readinessRequeueFromMetadata({ kind: "mergeTail.readiness", ordinal: 1 }), null);
  assert.equal(readinessRequeueFromMetadata(null), null);
  // An ordinal is the one field the counters cannot derive, so a row without
  // one is not counted rather than counted as an unnumbered requeue.
  assert.equal(readinessRequeueFromMetadata({ kind: MERGE_READINESS_REQUEUE_KIND }), null);
  assert.deepEqual(readinessRequeueTotals([{ metadata: { kind: "mergeTail.requeue" } }]), {
    readinessRequeues: 0,
    readinessGrants: 0,
  });
});
