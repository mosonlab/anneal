import type { MergeRecoveryAttempt, Prisma } from "@prisma/client";

import { asJsonObject, MERGE_TAIL_KIND, MERGE_TAIL_SCHEMA_VERSION } from "./merge-tail.js";

type Tx = Prisma.TransactionClient;

/**
 * How far back a recent-state marker read looks. The completion path fixed this
 * number and `merge-lease.ts` used to restate it in a comment — "matching the
 * completion path" — because there was nowhere else to say it. `TaskActivity`
 * rows are live production data, so the window is part of the persisted read
 * contract and not a tuning knob.
 */
export const MERGE_TAIL_MARKER_SCAN = 20;

export type MarkerKind = keyof typeof MERGE_TAIL_KIND;

/**
 * A merge-tail marker with its persisted fields already narrowed. Callers read
 * these instead of re-deriving them from `metadata`: the `typeof x === "string"`
 * guard that used to follow every `asJsonObject` call lives here now. `raw` is
 * the untouched object for the fields no reader has needed yet.
 */
export type Marker = {
  kind: MarkerKind;
  state: string | null;
  regressionTaskId: string | null;
  repairTaskId: string | null;
  readinessTaskId: string | null;
  repairKind: string | null;
  headSha: string | null;
  baseHeadSha: string | null;
  baseSha: string | null;
  startHeadSha: string | null;
  resolvedHeadSha: string | null;
  recoverySourceStopId: string | null;
  raw: Record<string, unknown>;
};

const KIND_BY_VALUE = new Map<string, MarkerKind>(
  (Object.entries(MERGE_TAIL_KIND) as Array<[MarkerKind, string]>).map(([name, value]) => [value, name]),
);

const text = (raw: Record<string, unknown>, field: string): string | null => (
  typeof raw[field] === "string" ? raw[field] : null
);

export const markerFromMetadata = (metadata: Prisma.JsonValue | null | undefined): Marker | null => {
  const raw = asJsonObject(metadata);
  const kind = raw && typeof raw.kind === "string" ? KIND_BY_VALUE.get(raw.kind) : undefined;
  if (!raw || !kind) return null;
  return {
    kind,
    state: text(raw, "state"),
    regressionTaskId: text(raw, "regressionTaskId"),
    repairTaskId: text(raw, "repairTaskId"),
    readinessTaskId: text(raw, "readinessTaskId"),
    repairKind: text(raw, "repairKind"),
    headSha: text(raw, "headSha"),
    baseHeadSha: text(raw, "baseHeadSha"),
    baseSha: text(raw, "baseSha"),
    startHeadSha: text(raw, "startHeadSha"),
    resolvedHeadSha: text(raw, "resolvedHeadSha"),
    recoverySourceStopId: text(raw, "recoverySourceStopId"),
    raw,
  };
};

// A task's activity carries operator notes and other families of marker
// (`mergeIntegrator.*`, evidence requests) alongside the merge tail's. Both
// reads take rows first and keep the merge-tail ones second, which is what the
// open-coded scans did and what makes the window a row count rather than a
// marker count.
const scan = async (tx: Tx, taskId: string, take?: number): Promise<Marker[]> => {
  const rows = await tx.taskActivity.findMany({
    where: { taskId },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(take === undefined ? {} : { take }),
  });
  return rows.flatMap((row) => {
    const marker = markerFromMetadata(row.metadata);
    return marker ? [marker] : [];
  });
};

/** The recent state of a task's merge tail: newest first, `MERGE_TAIL_MARKER_SCAN` rows deep. */
export const readMarkers = async (tx: Tx, taskId: string): Promise<Marker[]> => (
  scan(tx, taskId, MERGE_TAIL_MARKER_SCAN)
);

/**
 * Every merge-tail marker a task ever recorded, newest first. This answers "has
 * this ever happened", which the recent-state window cannot: an older
 * `repairAttempt` pushed past row 20 would let a second automatic repair start
 * where the tail stops today.
 */
export const readMarkerHistory = async (tx: Tx, taskId: string): Promise<Marker[]> => scan(tx, taskId);

/**
 * The newest marker of one `kind`, found by asking for that kind rather than by
 * filtering the recent window. `readMarkers` answers "what has this task been
 * doing lately", which unrelated activity pushes a still-open episode out of
 * once it exceeds `MERGE_TAIL_MARKER_SCAN` rows. State that must survive its own
 * duration -- a contention episode outlives 30 minutes of other writes -- is
 * read this way instead.
 */
export const readLatestMarker = async (
  tx: Tx,
  taskId: string,
  kind: MarkerKind,
): Promise<Marker | null> => {
  const row = await tx.taskActivity.findFirst({
    where: { taskId, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND[kind] } },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return row ? markerFromMetadata(row.metadata) : null;
};

/** The newest marker of `kind`, optionally restricted to one `state`. */
export const latestMarker = (markers: Marker[], kind: MarkerKind, state?: string): Marker | null => (
  markers.find((marker) => marker.kind === kind && (state === undefined || marker.state === state)) ?? null
);

export type MarkerWrite = {
  actorType: string;
  body: string;
  metadata?: Record<string, unknown>;
};

/**
 * Records one marker. `kind` and `schemaVersion` are the module's to write, so
 * a caller cannot record a marker under a kind string that no reader matches.
 */
export const writeMarker = async (
  tx: Tx,
  taskId: string,
  kind: MarkerKind,
  payload: MarkerWrite,
): Promise<void> => {
  await tx.taskActivity.create({ data: {
    taskId,
    actorType: payload.actorType,
    body: payload.body,
    metadata: {
      schemaVersion: MERGE_TAIL_SCHEMA_VERSION,
      ...payload.metadata,
      kind: MERGE_TAIL_KIND[kind],
    } as Prisma.InputJsonObject,
  } });
};

/**
 * A base-drift recovery attempt that carries every field its tail needs. The
 * columns are individually nullable, so a row that is missing one is not a
 * recovery this code can act on — that is what the null return means.
 */
export type RecoveryContext = {
  aggregateId: string;
  attempt: number;
  sourceStopId: string;
  sourceRunId: string;
  authorizationActivityId: string;
  repository: string;
  prNumber: number;
  targetBranch: string;
  authorizedHeadSha: string;
  authorizedBaseSha: string;
  observedBaseSha: string;
  currentBaseSha: string;
  readinessTaskId: string;
  regressionTaskId: string;
  integratorTaskId: string;
  recoveryRunId: string;
};

export const recoveryContext = (row: MergeRecoveryAttempt | null): RecoveryContext | null => {
  if (!row?.boundSourceRunId || !row.authorizationActivityId || !row.recoveryRunId
    || !row.readinessTaskId || !row.regressionTaskId || !row.repository
    || row.prNumber === null || !row.targetBranch || !row.authorizedHeadSha
    || !row.authorizedBaseSha || !row.observedBaseSha || !row.currentBaseSha) return null;
  return {
    aggregateId: row.id,
    attempt: row.attempt,
    sourceStopId: row.sourceStopId,
    sourceRunId: row.boundSourceRunId,
    authorizationActivityId: row.authorizationActivityId,
    repository: row.repository,
    prNumber: row.prNumber,
    targetBranch: row.targetBranch,
    authorizedHeadSha: row.authorizedHeadSha,
    authorizedBaseSha: row.authorizedBaseSha,
    observedBaseSha: row.observedBaseSha,
    currentBaseSha: row.currentBaseSha,
    readinessTaskId: row.readinessTaskId,
    regressionTaskId: row.regressionTaskId,
    integratorTaskId: row.integratorTaskId,
    recoveryRunId: row.recoveryRunId,
  };
};
