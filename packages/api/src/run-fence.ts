import { lockRunRow, lockTaskRow, Prisma, runOwnedHead, RunStatus } from "@anneal/db";

import type { Refusal } from "./refusal.js";

/**
 * The statuses a lease can still be live under. Distinct from the database
 * package's `ACTIVE_RUN_STATUSES`, which answers "does this task already have a
 * run?" and therefore includes QUEUED -- a queued run has no runner, no fencing
 * token and no lease, so it can never satisfy a fence.
 */
export const activeRunStatuses: RunStatus[] = [
  RunStatus.CLAIMED,
  RunStatus.PROVISIONING,
  RunStatus.RUNNING,
  RunStatus.WAITING_INBOX,
];

/**
 * One request's claim to still own a run.
 *
 * `at` is required, and that is the point: the instant a fence is asked about
 * is a decision the caller has to make once, at route entry, rather than a
 * `new Date()` evaluated wherever a `where` happens to be built. Two fencing
 * predicates in one request used to be able to disagree about whether a lease
 * expiring between them was live; with `at` there is nowhere to write the
 * second instant.
 *
 * `runnerId` is absent for the session-principal routes, whose caller holds a
 * session token rather than a runner identity.
 *
 * `statuses` narrows the fence for a route that acts on a subset of the live
 * statuses -- `/runner/runs/:runId/start` admits only a run that has not
 * started yet. It lives on the fence so that the predicate and its explanation
 * cannot disagree about which statuses were required.
 */
export type RunFence = {
  runId: string;
  runnerId?: string;
  fencingToken: string;
  at: Date;
  statuses?: RunStatus[];
};

/** Why a fenced query matched nothing. Ordered from the most specific cause to
 *  the least: a run that does not exist is `unknown-run`, never `stale-fence`. */
export type LeaseFenceRefusal =
  | "unknown-run"
  | "wrong-runner"
  | "stale-fence"
  | "cancel-requested"
  | "lease-expired"
  | "not-active";

export type FenceRefusal =
  | LeaseFenceRefusal
  | "waiting-inbox"
  | "cleanup-not-authorized";

export type FenceRefusalResponse = {
  error: "Stale fencing token";
  reason: LeaseFenceRefusal;
};

export const fenceRefusalResponse = (reason: LeaseFenceRefusal): FenceRefusalResponse => ({
  error: "Stale fencing token",
  reason,
});

/** The one transport-neutral refusal vocabulary for every Run authority mode. */
export const runFenceRefusal = (reason: FenceRefusal): Refusal => {
  if (reason === "waiting-inbox") {
    return {
      reason: "conflict",
      message: "Run suspended for Inbox",
      detail: { code: "WAITING_INBOX" },
    };
  }
  if (reason === "cleanup-not-authorized") {
    return {
      reason: "conflict",
      message: "Cleanup outcome is not authorized for a live or foreign run",
    };
  }
  return {
    reason: "conflict",
    message: "Stale fencing token",
    detail: { reason },
  };
};

export const isFenceRefusalResponse = (value: unknown): value is FenceRefusalResponse => (
  typeof value === "object"
  && value !== null
  && "error" in value
  && value.error === "Stale fencing token"
  && "reason" in value
);

/** The six clauses that make a run this request's to write. */
export const fencedRunWhere = (fence: RunFence): Prisma.RunWhereInput => ({
  id: fence.runId,
  ...(fence.runnerId === undefined ? {} : { runnerId: fence.runnerId }),
  fencingToken: fence.fencingToken,
  cancelRequestedAt: null,
  leaseExpiresAt: { gt: fence.at },
  status: { in: fence.statuses ?? activeRunStatuses },
});

/**
 * Names which clause of the fence the run failed.
 *
 * Runs on the miss path only, where the request is already being refused and
 * one more read costs nothing. Calling it on the hit path both wastes a query
 * and answers a question nobody asked.
 *
 * The fallback is `stale-fence`: every enumerated cause has been ruled out, so
 * either the row changed between the refusal and this read, or the route added
 * a clause of its own on top of the fence -- the session routes' fence on
 * `leaseGeneration`, which is a superseded fence by another name.
 */
export const explainFenceRefusal = async (
  tx: Prisma.TransactionClient,
  fence: RunFence,
): Promise<LeaseFenceRefusal> => {
  const run = await tx.run.findUnique({
    where: { id: fence.runId },
    select: { runnerId: true, fencingToken: true, cancelRequestedAt: true, leaseExpiresAt: true, status: true },
  });
  if (!run) return "unknown-run";
  if (fence.runnerId !== undefined && run.runnerId !== fence.runnerId) return "wrong-runner";
  if (run.fencingToken !== fence.fencingToken) return "stale-fence";
  if (run.cancelRequestedAt !== null) return "cancel-requested";
  if (run.leaseExpiresAt === null || run.leaseExpiresAt <= fence.at) return "lease-expired";
  if (!(fence.statuses ?? activeRunStatuses).includes(run.status)) return "not-active";
  return "stale-fence";
};

export type LockedAuthorityRun = {
  id: string;
  runnerId: string | null;
  fencingToken: string | null;
  cancelRequestId: string | null;
  cancelReason: string | null;
  cancelRequestedAt: Date | null;
  leaseExpiresAt: Date | null;
  status: RunStatus;
  taskId: string | null;
  repoId: string | null;
  runNumber: number;
  pushedBranch: string | null;
  baseSha: string | null;
  basePublishedAt: Date | null;
  branch: string | null;
  targetBranch: string | null;
};

/**
 * Locks the Run mutex before reading any authority mode. Callers that also
 * mutate Task state acquire that lock only after this function returns.
 */
export const lockAuthorityRun = async (
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<LockedAuthorityRun | null> => {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT candidate."id" FROM "Run" AS candidate WHERE candidate."id" = ${runId} FOR UPDATE
  `;
  return tx.run.findFirst({
    where: { id: runId },
    select: {
      id: true,
      runnerId: true,
      fencingToken: true,
      cancelRequestId: true,
      cancelReason: true,
      cancelRequestedAt: true,
      leaseExpiresAt: true,
      status: true,
      taskId: true,
      repoId: true,
      runNumber: true,
      pushedBranch: true,
      baseSha: true,
      basePublishedAt: true,
      branch: true,
      targetBranch: true,
    },
  });
};

/** Live authority is the full six-clause lease fence. */
export const liveAuthorityRefusal = (
  run: LockedAuthorityRun | null,
  fence: RunFence,
): LeaseFenceRefusal | null => {
  if (!run) return "unknown-run";
  if (fence.runnerId !== undefined && run.runnerId !== fence.runnerId) return "wrong-runner";
  if (run.fencingToken !== fence.fencingToken) return "stale-fence";
  if (run.cancelRequestedAt !== null) return "cancel-requested";
  if (run.leaseExpiresAt === null || run.leaseExpiresAt <= fence.at) return "lease-expired";
  if (!(fence.statuses ?? activeRunStatuses).includes(run.status)) return "not-active";
  return null;
};

export type SalvageAuthority = {
  runnerId: string;
  fencingToken: string;
  pushedBranch: string;
};

/**
 * Salvage authority is deliberately narrower than live authority: it admits
 * only the recorded owner publishing this Run's deterministic per-run ref.
 */
export const salvageAuthorityRefusal = (
  run: LockedAuthorityRun | null,
  authority: SalvageAuthority,
): LeaseFenceRefusal | null => {
  if (!run) return "unknown-run";
  if (run.runnerId !== authority.runnerId) return "wrong-runner";
  if (run.fencingToken !== authority.fencingToken) return "stale-fence";
  const expectedBranch = run.taskId ? runOwnedHead(run.taskId, run.runNumber) : null;
  if (
    run.repoId === null
    || authority.pushedBranch !== expectedBranch
    || run.pushedBranch !== null && run.pushedBranch !== authority.pushedBranch
  ) return "not-active";
  return null;
};

export type CleanupAuthority = {
  runnerId: string;
  fencingToken: string;
  at: Date;
};

/** Cleanup authority admits only the recorded owner after lease loss or terminalization. */
export const cleanupAuthorityRefusal = (
  run: LockedAuthorityRun | null,
  authority: CleanupAuthority,
): FenceRefusal | null => {
  if (
    !run
    || run.runnerId !== authority.runnerId
    || run.fencingToken !== authority.fencingToken
    || run.leaseExpiresAt !== null && run.leaseExpiresAt > authority.at && activeRunStatuses.includes(run.status)
  ) return "cleanup-not-authorized";
  return null;
};

/**
 * Runs one write-authorizing read behind the complete fence while holding only
 * the Run mutex. Callers use this when every mutation is owned by the Run and
 * its Session, so taking the Task mutex would add a lock-order dependency that
 * the transition does not need.
 */
export const withRunOnlyFencedRun = async <Select extends Prisma.RunSelect, Result>(
  tx: Prisma.TransactionClient,
  fence: RunFence,
  select: Select,
  body: (run: Prisma.RunGetPayload<{ select: Select }>) => Promise<Result> | Result,
): Promise<Result | FenceRefusalResponse> => {
  await lockRunRow(tx, fence.runId);
  const run = await tx.run.findFirst({
    where: fencedRunWhere(fence),
    select,
  });
  if (!run) return fenceRefusalResponse(await explainFenceRefusal(tx, fence));
  return body(run);
};

/**
 * Runs one write-authorizing read behind the complete fence.
 *
 * Run owns fencing and cancellation, while Task owns the lifecycle mutations
 * that a fenced callback may make. The callback therefore starts only after
 * Run and then its Task have been locked in that order. The selected row is
 * read after both locks, so Task fields cannot go stale while the Task lock is
 * being acquired.
 *
 * Both reads are built here from the same required `fence.at`. A caller can
 * neither omit one of the six clauses nor introduce a second clock instant.
 */
export const withFencedRun = async <Select extends Prisma.RunSelect, Result>(
  tx: Prisma.TransactionClient,
  fence: RunFence,
  select: Select,
  body: (run: Prisma.RunGetPayload<{ select: Select }>) => Promise<Result> | Result,
): Promise<Result | FenceRefusalResponse> => {
  await lockRunRow(tx, fence.runId);
  const owner = await tx.run.findFirst({
    where: fencedRunWhere(fence),
    select: { taskId: true },
  });
  if (!owner) return fenceRefusalResponse(await explainFenceRefusal(tx, fence));
  if (owner.taskId !== null) await lockTaskRow(tx, owner.taskId);

  const run = await tx.run.findFirst({
    where: fencedRunWhere(fence),
    select,
  });
  if (!run) return fenceRefusalResponse(await explainFenceRefusal(tx, fence));
  return body(run);
};
