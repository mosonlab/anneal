import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "@prisma/client";

import {
  MERGE_READINESS_REQUEUE_ACTOR_TYPE,
  MERGE_READINESS_REQUEUE_KIND,
  readinessRequeueFromMetadata,
  readinessRequeueTotals,
  recordReadinessRequeue,
} from "./readiness-requeue.js";

type Row = { taskId: string; actorType: string; metadata: unknown };

/**
 * A transaction that keeps the rows it is given, filtering exactly as the
 * module's own where-clause does. The ordinal is the module's to own, so the
 * second requeue is counted against what the first one wrote rather than
 * against a number the test supplies.
 */
const recordingTx = (rows: Row[] = []) => {
  const matches = (row: Row, where: { taskId: string; actorType: string }): boolean =>
    row.taskId === where.taskId
    && row.actorType === where.actorType
    && (row.metadata as { kind?: unknown } | null)?.kind === MERGE_READINESS_REQUEUE_KIND;
  const tx = {
    taskActivity: {
      count: async ({ where }: { where: { taskId: string; actorType: string } }) =>
        rows.filter((row) => matches(row, where)).length,
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
  const recorded = rows.map((row) => readinessRequeueFromMetadata(row.metadata as Prisma.JsonValue));
  assert.deepEqual(recorded.map((row) => row?.ordinal), [1, 2]);
  assert.deepEqual(recorded.map((row) => row?.staleBaseSha), ["a".repeat(40), "b".repeat(40)]);
  assert.deepEqual(recorded.map((row) => row?.currentBaseSha), ["b".repeat(40), "c".repeat(40)]);
  assert.deepEqual([...new Set(rows.map((row) => row.actorType))], [MERGE_READINESS_REQUEUE_ACTOR_TYPE]);
  // The grant is what the requeue cost, and it is recorded beside the count so
  // the two can never be read from different rows.
  assert.deepEqual(readinessRequeueTotals(rows as { metadata: Prisma.JsonValue }[]), {
    readinessRequeues: 2,
    readinessGrants: 2,
  });
});

test("another task's requeues do not advance this chain's ordinal", async () => {
  const { tx } = recordingTx([{
    taskId: "other-readiness",
    actorType: MERGE_READINESS_REQUEUE_ACTOR_TYPE,
    metadata: { kind: MERGE_READINESS_REQUEUE_KIND, ordinal: 1, budgetGrant: 1 },
  }]);
  assert.equal((await requeue(tx, "a".repeat(40), "b".repeat(40))).ordinal, 1);
});

test("an activity from any other actor does not advance the ordinal", async () => {
  // The public activity route preserves caller-supplied metadata, so an
  // operator note can carry this kind; only the control plane settles requeues.
  const { tx } = recordingTx([
    { taskId: "readiness", actorType: "operator", metadata: { kind: MERGE_READINESS_REQUEUE_KIND, ordinal: 1, budgetGrant: 1 } },
    { taskId: "readiness", actorType: "agent", metadata: { kind: MERGE_READINESS_REQUEUE_KIND, ordinal: 2, budgetGrant: 7 } },
  ]);
  assert.equal((await requeue(tx, "a".repeat(40), "b".repeat(40))).ordinal, 1);
});

test("a grant that the counters could not read back is refused", async () => {
  const { tx } = recordingTx();
  await assert.rejects(
    recordReadinessRequeue(tx, {
      readinessTaskId: "readiness",
      regressionTaskId: "regression",
      staleBaseSha: "a".repeat(40),
      currentBaseSha: "b".repeat(40),
      budgetGrant: 1.5,
      reason: "base moved before authorization",
    }),
    /non-negative integer/,
  );
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
