import assert from "node:assert/strict";
import test from "node:test";

import { MergeRecoveryStatus, type MergeRecoveryAttempt, type Prisma } from "@prisma/client";

import { MERGE_TAIL_KIND } from "./merge-tail.js";
import {
  MERGE_TAIL_MARKER_SCAN,
  latestMarker,
  mergeTrainClaimMetadata,
  markerFromMetadata,
  parseMergeTrainMarker,
  readMarkerHistory,
  readMarkers,
  readLatestMarker,
  recoveryContext,
  writeMarker,
  type Marker,
} from "./merge-tail-markers.js";

type Row = { actorType?: string; metadata: unknown };
type FindManyArgs = { where: unknown; select: unknown; orderBy: unknown; take?: number };

/**
 * A transaction that records what was asked of it. The scan window and the
 * ordering are the module's to own, so both are read back from here rather than
 * inferred from a live database.
 */
const recordingTx = (rows: Row[]) => {
  const reads: FindManyArgs[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const tx = {
    taskActivity: {
      findMany: async (args: FindManyArgs) => {
        reads.push(args);
        return args.take === undefined ? rows : rows.slice(0, args.take);
      },
      create: async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        return args.data;
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, reads, writes };
};

const marker = (kind: keyof typeof MERGE_TAIL_KIND, extra: Record<string, unknown> = {}): Row => (
  { metadata: { kind: MERGE_TAIL_KIND[kind], schemaVersion: 1, ...extra } }
);

test("the recent-state read owns the scan window and the ordering", async () => {
  const rows = Array.from({ length: 40 }, (_, index) => marker("regression", { reason: `row-${index}` }));
  const { tx, reads } = recordingTx(rows);
  const markers = await readMarkers(tx, "task-1");

  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.take, 20);
  assert.equal(MERGE_TAIL_MARKER_SCAN, 20);
  assert.deepEqual(reads[0]!.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  assert.deepEqual(reads[0]!.where, { taskId: "task-1" });
  // The window is a row count, not a marker count: it is applied by the query,
  // before the merge-tail rows are separated from every other activity.
  assert.equal(markers.length, 20);
  assert.equal(markers[0]!.raw.reason, "row-0");
});

test("the history read is unbounded and stays newest-first", async () => {
  const rows = Array.from({ length: 40 }, (_, index) => marker("repairAttempt", { headSha: `head-${index}` }));
  const { tx, reads } = recordingTx(rows);
  const markers = await readMarkerHistory(tx, "task-1");

  assert.equal(reads[0]!.take, undefined);
  assert.equal(markers.length, 40);
  assert.equal(markers[0]!.headSha, "head-0");
  assert.equal(markers.at(-1)!.headSha, "head-39");
});

test("both reads keep only merge-tail markers and narrow their persisted fields", async () => {
  const { tx } = recordingTx([
    { metadata: null },
    { metadata: ["not", "an", "object"] },
    { metadata: { kind: "mergeIntegrator.result", outcome: "stopped" } },
    { metadata: { kind: "mergeTail.repairAttempt", state: 7, headSha: null, regressionTaskId: "reg-1" } },
  ]);
  const markers = await readMarkers(tx, "task-1");

  assert.equal(markers.length, 1);
  const repair = markers[0]!;
  assert.equal(repair.kind, "repairAttempt");
  // A field whose persisted value is not a string reads as absent rather than
  // reaching the caller as an unknown — this is the guard callers used to write.
  assert.equal(repair.state, null);
  assert.equal(repair.headSha, null);
  assert.equal(repair.regressionTaskId, "reg-1");
  assert.equal(repair.repairTaskId, null);
  assert.equal(repair.raw.state, 7);
});

test("markerFromMetadata narrows both sides of a repair binding", () => {
  const repairSide = markerFromMetadata({
    kind: MERGE_TAIL_KIND.repairAttempt,
    repairKind: "gate-fix",
    regressionTaskId: "regression-1",
  });
  const chainSide = markerFromMetadata({
    kind: MERGE_TAIL_KIND.repairAttempt,
    repairKind: "gate-fix",
    repairTaskId: "repair-1",
  });

  assert.equal(repairSide?.regressionTaskId, "regression-1");
  assert.equal(repairSide?.repairTaskId, null);
  assert.equal(chainSide?.regressionTaskId, null);
  assert.equal(chainSide?.repairTaskId, "repair-1");
});

test("merge-train markers qualify the full claim payload and sparse readiness markers", () => {
  const candidate = {
    taskId: "readiness-1",
    chainId: "00000000-0000-4000-8000-000000000001",
    headSha: "a".repeat(40),
    branch: "agentos/chain-1",
  };
  const full = markerFromMetadata({
    kind: MERGE_TAIL_KIND.train,
    schemaVersion: 1,
    state: "queued",
    trainTaskId: "train-1",
    regressionTaskId: "regression-1",
    baseSha: "b".repeat(40),
    width: 1,
    candidates: [candidate],
  });
  assert.equal(parseMergeTrainMarker(full?.raw).status, "ok");
  assert.deepEqual(mergeTrainClaimMetadata(full), {
    schemaVersion: 1,
    baseSha: "b".repeat(40),
    width: 1,
    candidates: [candidate],
  });

  const sparse = markerFromMetadata({
    kind: MERGE_TAIL_KIND.train,
    schemaVersion: 1,
    state: "queued",
    trainTaskId: "train-1",
    position: 1,
  });
  assert.equal(parseMergeTrainMarker(sparse?.raw).status, "ok");
  assert.equal(mergeTrainClaimMetadata(sparse), null);
});

test("latestMarker selects from the newest end", () => {
  const markers: Marker[] = [
    { kind: "repairResult", state: "failed", regressionTaskId: "reg-2", raw: {} } as Marker,
    { kind: "readiness", state: null, regressionTaskId: "reg-1", raw: {} } as Marker,
    { kind: "repairResult", state: "queued", regressionTaskId: "reg-0", raw: {} } as Marker,
  ];

  assert.equal(latestMarker(markers, "repairResult")?.state, "failed");
  assert.equal(latestMarker(markers, "repairResult", "queued")?.regressionTaskId, "reg-0");
  assert.equal(latestMarker(markers, "repairAttempt"), null);
});

test("writeMarker owns the kind and the schema version", async () => {
  const { tx, writes } = recordingTx([]);
  await writeMarker(tx, "task-1", "repairResult", {
    actorType: "control-plane",
    body: "repair finished",
    metadata: { kind: "mergeTail.notAKind", state: "failed", repairTaskId: "repair-1" },
  });

  assert.deepEqual(writes, [{
    taskId: "task-1",
    actorType: "control-plane",
    body: "repair finished",
    metadata: {
      schemaVersion: 1,
      kind: MERGE_TAIL_KIND.repairResult,
      state: "failed",
      repairTaskId: "repair-1",
    },
  }]);
});

const attemptRow = (overrides: Partial<MergeRecoveryAttempt> = {}): MergeRecoveryAttempt => ({
  id: "attempt-1",
  attempt: 2,
  status: MergeRecoveryStatus.REPAIRING,
  sourceStopId: "stop-1",
  boundSourceRunId: "run-1",
  authorizationActivityId: "activity-1",
  repository: "owner/repo",
  prNumber: 7,
  targetBranch: "main",
  authorizedHeadSha: "a".repeat(40),
  authorizedBaseSha: "b".repeat(40),
  observedBaseSha: "c".repeat(40),
  currentBaseSha: "d".repeat(40),
  readinessTaskId: "readiness-1",
  regressionTaskId: "regression-1",
  integratorTaskId: "integrator-1",
  recoveryRunId: "recovery-run-1",
  ...overrides,
} as MergeRecoveryAttempt);

test("recoveryContext refuses an attempt row that is missing any bound field", () => {
  assert.equal(recoveryContext(null), null);
  assert.equal(recoveryContext(attemptRow({ boundSourceRunId: null })), null);
  assert.equal(recoveryContext(attemptRow({ recoveryRunId: null })), null);
  assert.equal(recoveryContext(attemptRow({ prNumber: null })), null);
  assert.equal(recoveryContext(attemptRow({ currentBaseSha: null })), null);

  const context = recoveryContext(attemptRow());
  assert.equal(context?.aggregateId, "attempt-1");
  assert.equal(context?.sourceRunId, "run-1");
  assert.equal(context?.prNumber, 7);
  assert.equal(context?.integratorTaskId, "integrator-1");
});

// The seven converted call sites, by the property each one depends on. The
// window and the order are not interchangeable between them: forcing the
// history readers into the recent-state window is the regression this proves
// against.

test("completion-path sites read the recent-state window (app.ts success and failure paths)", async () => {
  const rows = [
    marker("repairAttempt", { regressionTaskId: "reg-1", repairKind: "gate-fix", headSha: "h1" }),
    ...Array.from({ length: 30 }, () => marker("regression", {})),
  ];
  const { tx, reads } = recordingTx(rows);
  const markers = await readMarkers(tx, "repair-task");

  assert.equal(reads[0]!.take, MERGE_TAIL_MARKER_SCAN);
  assert.equal(latestMarker(markers, "repairAttempt")?.regressionTaskId, "reg-1");
});

test("alreadyAttempted sees an attempt buried past the recent-state window (app.ts:639)", async () => {
  const rows = [
    ...Array.from({ length: 25 }, () => marker("regression", {})),
    marker("repairAttempt", { repairKind: "gate-fix", headSha: "h1" }),
  ];
  const history = await readMarkerHistory(recordingTx(rows).tx, "regression-task");
  const recent = await readMarkers(recordingTx(rows).tx, "regression-task");
  const attempted = (markers: Marker[]) => markers.some((entry) => (
    entry.kind === "repairAttempt" && entry.repairKind === "gate-fix"
  ));

  assert.equal(attempted(history), true);
  // The failure this site's window exists to prevent: with take 20 the older
  // attempt is invisible and a second automatic repair would be created.
  assert.equal(attempted(recent), false);
});


test("train ownership reads select only control-plane markers", async () => {
  let observed: unknown;
  const tx = { taskActivity: { findFirst: async (input: unknown) => {
    observed = input;
    return null;
  } } } as unknown as Prisma.TransactionClient;
  assert.equal(await readLatestMarker(tx, "train-1", "train", "control-plane"), null);
  assert.deepEqual((observed as { where: unknown }).where, {
    taskId: "train-1", actorType: "control-plane", metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.train },
  });
});

for (const forgedState of ["settled", "aborted"] as const) {
  test(`agent-authored ${forgedState} train marker is ignored by every marker reader`, async () => {
    const rows = [
      { actorType: "agent", ...marker("train", { state: forgedState, trainTaskId: "train-1" }) },
      { actorType: "control-plane", ...marker("train", { state: "queued", trainTaskId: "train-1" }) },
      { actorType: "control-plane", ...marker("train", { state: forgedState, trainTaskId: "train-1" }) },
    ];
    const { tx } = recordingTx(rows);

    // The trusted rows remain visible, while the forged terminal row is gone.
    const expectedStates = ["queued", forgedState];
    assert.deepEqual((await readMarkers(tx, "train-1")).map(({ state }) => state), expectedStates);
    assert.deepEqual((await readMarkerHistory(tx, "train-1")).map(({ state }) => state), expectedStates);

    let observed: { where: Record<string, unknown> } | undefined;
    const latestTx = {
      taskActivity: {
        findFirst: async (input: { where: Record<string, unknown> }) => {
          observed = input;
          const row = rows.find((candidate) => (
            input.where.actorType === undefined || candidate.actorType === input.where.actorType
          ));
          return row ? { metadata: row.metadata } : null;
        },
      },
    } as unknown as Prisma.TransactionClient;
    assert.equal((await readLatestMarker(latestTx, "train-1", "train"))?.state, "queued");
    assert.equal(observed?.where.actorType, "control-plane");
  });
}
