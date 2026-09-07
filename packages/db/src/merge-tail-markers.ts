import type { MergeRecoveryAttempt, Prisma, PrismaClient } from "@prisma/client";

import {
  asJsonObject,
  MERGE_TAIL_KIND,
  MERGE_TAIL_SCHEMA_VERSION,
  type MergeTrainCandidate,
  type MergeTrainWidth,
} from "./merge-tail.js";

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

/** Marker families whose state is a control-plane fact, never agent input. */
const TRUSTED_MARKER_KINDS = new Set<MarkerKind>(["train", "leaseContention"]);

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

const MERGE_TRAIN_MARKER_STATES = new Set(["acquiring", "queued", "settled", "aborted"] as const);
export type MergeTrainMarkerState = "acquiring" | "queued" | "settled" | "aborted";

/** The durable lifecycle binding carried by a `mergeTail.train` marker. */
export type MergeTrainMarker = {
  kind: "train";
  state: MergeTrainMarkerState;
  trainTaskId: string;
  regressionTaskId: string | null;
  readinessTaskId: string | null;
  position: number | null;
  baseSha: string | null;
  width: MergeTrainWidth | null;
  candidates: MergeTrainCandidate[] | null;
  reason: string | null;
  raw: Record<string, unknown>;
};

export type MergeTrainMarkerParse =
  | { status: "ok"; marker: MergeTrainMarker }
  | { status: "invalid"; reason: string };

/** The bounded payload a detached train Task exposes to its claiming Runner. */
export type MergeTrainClaimMetadata = {
  schemaVersion: typeof MERGE_TAIL_SCHEMA_VERSION;
  baseSha: string;
  width: MergeTrainWidth;
  candidates: MergeTrainCandidate[];
};

const MERGE_TRAIN_SHA = /^[0-9a-f]{40}$/u;
const MERGE_TRAIN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const hasControlCharacter = (value: string): boolean => [...value].some((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
});
const hasText = (value: unknown): value is string => (
  typeof value === "string" && value.trim().length > 0 && !hasControlCharacter(value)
);

const parseCandidate = (value: unknown): MergeTrainCandidate | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!hasText(candidate.taskId)
    || typeof candidate.chainId !== "string" || !MERGE_TRAIN_UUID.test(candidate.chainId)
    || typeof candidate.headSha !== "string" || !MERGE_TRAIN_SHA.test(candidate.headSha)
    || !hasText(candidate.branch)) return null;
  return {
    taskId: candidate.taskId,
    chainId: candidate.chainId,
    headSha: candidate.headSha,
    branch: candidate.branch,
  };
};

/**
 * Parse a persisted train marker. Detached train cards carry the complete
 * payload; the corresponding readiness cards intentionally carry only the
 * train id and position, so the payload fields are nullable here and the
 * claim projection applies the complete-payload check below.
 */
export const parseMergeTrainMarker = (
  metadata: Prisma.JsonValue | Record<string, unknown> | null | undefined,
): MergeTrainMarkerParse => {
  const raw = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
  if (!raw || raw.kind !== MERGE_TAIL_KIND.train) return { status: "invalid", reason: "not a merge-train marker" };
  if (raw.schemaVersion !== MERGE_TAIL_SCHEMA_VERSION) return { status: "invalid", reason: "unsupported merge-train marker schemaVersion" };
  if (typeof raw.state !== "string" || !MERGE_TRAIN_MARKER_STATES.has(raw.state as MergeTrainMarkerState)) {
    return { status: "invalid", reason: "invalid merge-train marker state" };
  }
  if (!hasText(raw.trainTaskId)) return { status: "invalid", reason: "merge-train marker has no trainTaskId" };

  const parseOptionalText = (field: string): string | null => (
    raw[field] === undefined || raw[field] === null ? null : hasText(raw[field]) ? raw[field] : null
  );
  const optionalTextFields = [
    "regressionTaskId",
    "readinessTaskId",
  ];
  if (optionalTextFields.some((field) => raw[field] !== undefined && raw[field] !== null && !hasText(raw[field]))) {
    return { status: "invalid", reason: "merge-train marker has malformed text binding" };
  }

  const position = raw.position === undefined || raw.position === null
    ? null
    : typeof raw.position === "number" && Number.isInteger(raw.position) && raw.position > 0
      ? raw.position
      : null;
  if (raw.position !== undefined && raw.position !== null && position === null) {
    return { status: "invalid", reason: "merge-train marker position is invalid" };
  }

  const baseSha = raw.baseSha === undefined || raw.baseSha === null
    ? null
    : typeof raw.baseSha === "string" && MERGE_TRAIN_SHA.test(raw.baseSha) ? raw.baseSha : null;
  if (raw.baseSha !== undefined && raw.baseSha !== null && baseSha === null) {
    return { status: "invalid", reason: "merge-train marker baseSha is invalid" };
  }
  const width = raw.width === undefined || raw.width === null
    ? null
    : typeof raw.width === "number" && Number.isInteger(raw.width) && raw.width >= 1 && raw.width <= 3
      ? raw.width as MergeTrainWidth
      : null;
  if (raw.width !== undefined && raw.width !== null && width === null) {
    return { status: "invalid", reason: "merge-train marker width is invalid" };
  }

  let candidates: MergeTrainCandidate[] | null = null;
  if (raw.candidates !== undefined && raw.candidates !== null) {
    if (!Array.isArray(raw.candidates) || raw.candidates.length === 0 || (width !== null && raw.candidates.length > width)) {
      return { status: "invalid", reason: "merge-train marker candidates are invalid" };
    }
    candidates = [];
    for (const entry of raw.candidates) {
      const candidate = parseCandidate(entry);
      if (!candidate) return { status: "invalid", reason: "merge-train marker candidate is malformed" };
      candidates.push(candidate);
    }
  }

  return {
    status: "ok",
    marker: {
      kind: "train",
      state: raw.state as MergeTrainMarkerState,
      trainTaskId: raw.trainTaskId,
      regressionTaskId: parseOptionalText("regressionTaskId"),
      readinessTaskId: parseOptionalText("readinessTaskId"),
      position,
      baseSha,
      width,
      candidates,
      reason: typeof raw.reason === "string" ? raw.reason : null,
      raw,
    },
  };
};

/** Parse and qualify the complete queued payload for a detached train claim. */
export const mergeTrainClaimMetadata = (
  marker: Marker | null,
): MergeTrainClaimMetadata | null => {
  if (!marker || marker.kind !== "train") return null;
  const parsed = parseMergeTrainMarker(marker.raw);
  if (parsed.status === "invalid" || parsed.marker.state !== "queued"
    || !parsed.marker.baseSha || parsed.marker.width === null || !parsed.marker.candidates) return null;
  return {
    schemaVersion: MERGE_TAIL_SCHEMA_VERSION,
    baseSha: parsed.marker.baseSha,
    width: parsed.marker.width,
    candidates: parsed.marker.candidates,
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
    select: { actorType: true, metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(take === undefined ? {} : { take }),
  });
  return rows.flatMap((row) => {
    const marker = markerFromMetadata(row.metadata);
    return marker && (!TRUSTED_MARKER_KINDS.has(marker.kind) || row.actorType === "control-plane") ? [marker] : [];
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
  const actorFilter = TRUSTED_MARKER_KINDS.has(kind)
    ? { actorType: "control-plane" as const }
    : {};
  const row = await tx.taskActivity.findFirst({
    where: {
      taskId,
      ...actorFilter,
      metadata: { path: ["kind"], equals: MERGE_TAIL_KIND[kind] },
    },
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

export const MERGE_EXECUTOR_OFFLINE_STATE = "requeued-executor-offline";
export const MERGE_EXECUTOR_OFFLINE_REASON = "merge-executor-offline";
export const executorOfflineDetail = (executorRunnerIds: readonly string[]): string =>
  `${MERGE_EXECUTOR_OFFLINE_REASON}: no merge executor in ${executorRunnerIds.join(", ")} is online`;

export type ExecutorOfflineMarker = { id: string; createdAt: Date; metadata: Prisma.JsonValue };

/** The newest skipped authorization on this readiness Step, the outage anchor. */
export const latestExecutorOfflineMarker = async (
  db: PrismaClient | Prisma.TransactionClient,
  readinessTaskId: string,
): Promise<ExecutorOfflineMarker | null> => db.taskActivity.findFirst({
  where: {
    taskId: readinessTaskId,
    metadata: { path: ["state"], equals: MERGE_EXECUTOR_OFFLINE_STATE },
  },
  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  select: { id: true, createdAt: true, metadata: true },
});

/**
 * When the outage this marker belongs to began, or `null` once that outage has
 * ended. An episode ends on an observed fact rather than after an elapsed time:
 * readiness closes it on the tick that finds an executor online or settles the
 * Step some other way, and on the stop it writes at the ceiling. Elapsed time
 * cannot decide this -- `MERGE_READINESS_POLL_INTERVAL_MS` sets the distance
 * between two skipped authorizations of one outage, so any fixed gap an
 * interval can exceed would restart the wait every tick and let an executor
 * stay offline forever without ever reaching the ceiling.
 */
export const openEpisodeStart = (marker: ExecutorOfflineMarker | null): Date | null => {
  if (!marker) return null;
  const metadata = marker.metadata as {
    episodeStartedAt?: unknown;
    episodeClosed?: unknown;
  } | null;
  if (metadata?.episodeClosed === true) return null;
  const recorded = metadata?.episodeStartedAt;
  if (typeof recorded !== "string") return marker.createdAt;
  const started = new Date(recorded);
  return Number.isNaN(started.getTime()) ? marker.createdAt : started;
};

/** Caller owns the mutation fence; this body never opens a transaction. */
export const closeExecutorOfflineEpisodeTx = async (
  tx: Prisma.TransactionClient, readinessTaskId: string, observation: string,
): Promise<void> => {
  const marker = await latestExecutorOfflineMarker(tx, readinessTaskId);
  if (!marker || openEpisodeStart(marker) === null) return;
  const metadata = (marker.metadata ?? {}) as Prisma.JsonObject;
  await tx.taskActivity.update({
    where: { id: marker.id },
    data: { metadata: { ...metadata, episodeClosed: true } },
  });
  await tx.taskActivity.create({ data: {
    taskId: readinessTaskId,
    actorType: "control-plane",
    body: `Merge readiness executor-offline episode ended: ${observation}`,
    metadata: { kind: MERGE_TAIL_KIND.readiness, state: "executor-offline-closed", observation },
  } });

};
