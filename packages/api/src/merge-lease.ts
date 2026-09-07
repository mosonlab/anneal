import {
  executionModeFor,
  isRegressionVerificationOutputKind,
  latestMarker,
  listUnresolvedLeaseEvents,
  Prisma,
  readMarkers,
  recordLeaseDeferral,
  recordLeaseHandoff,
  settleLeaseEvent,
  type PrismaClient,
} from "@anneal/db";
import {
  acquireMergeLease as invokeMergeLeaseAcquisition,
  isMergeLeaseReleaseAnomaly,
  readMergeLeaseHolder as invokeMergeLeaseStatus,
  releaseMergeLease as invokeMergeLeaseRelease,
  type LeaseRunner,
  type MergeLeaseAcquisition as LeaseScriptAcquisition,
  type MergeLeaseHolder,
  type MergeLeaseStatus,
} from "../../../scripts/merge-lease-adapter.mjs";
import {
  recordMergeLeaseHold,
  type MergeLeaseRelease,
  type MergeLeaseTarget,
} from "./merge-lease-hold.js";

/**
 * What one `merge-lease.sh release` did. The script has four outcomes and three
 * of them exit 0, so the exit code cannot tell them apart -- and the one that
 * matters, a lease left standing because it is held for another task, looked
 * exactly like a lease this caller had freed. `unreachable` is the fifth: the
 * release never got far enough to say anything.
 */
export type MergeLeaseReleaser = (chainId: string) => Promise<MergeLeaseRelease>;

/** Who holds the lease on origin right now. Reads only; `status` writes nothing. */
export type MergeLeaseHolderReader = () => Promise<MergeLeaseStatus>;

export const readMergeLeaseHolderAdapter: MergeLeaseHolderReader = async () => await invokeMergeLeaseStatus({
  environment: process.env,
  processTimeoutMs: 30_000,
});

export const releaseMergeLeaseAdapter = async (
  chainId: string,
  options: { environment?: NodeJS.ProcessEnv; runner?: LeaseRunner } = {},
): Promise<MergeLeaseRelease> => {
  const release = await invokeMergeLeaseRelease({
    environment: options.environment ?? process.env,
    ...(options.runner ? { runner: options.runner } : {}),
    task: chainId,
    processTimeoutMs: 90_000,
  });
  if (release.detail) {
    if (release.outcome === "unreachable") console.error(`Merge lease release failed for chain ${chainId}: ${release.detail}`);
    else console.log(release.detail);
  }
  return release;
};

const releaseMergeLeaseWith = async (
  releaser: MergeLeaseReleaser,
  target: MergeLeaseTarget | null,
): Promise<MergeLeaseRelease | null> => {
  if (!target) return null;
  const release = await releaser(target.chainId);
  reportMergeLeaseAnomaly(target.chainId, release);
  return release;
};

export type ReleaseMergeLease = (
  target: MergeLeaseTarget | null,
  db: PrismaClient,
) => Promise<MergeLeaseRelease | void>;

export const releaseMergeLease: ReleaseMergeLease = async (target, db) => {
  const release = await releaseMergeLeaseWith(releaseMergeLeaseAdapter, target);
  if (target && release?.outcome === "unreachable") {
    throw new Error(`Merge lease release for chain ${target.chainId} was unreachable: ${release.detail}`);
  }
  if (target && release?.outcome === "released") {
    await recordMergeLeaseHold(db, target, release, new Date());
  }
  return release ?? undefined;
};

/**
 * Say out loud that a release did not free the lock it was asked to free.
 * `released` and `not-held` are the ordinary answers. The other three are
 * anomalies on the Lease that serialises the merge window on main -- the Lease is
 * still standing, or nobody knows whether it is -- and they arrive on a path
 * that otherwise reports nothing at all. The caller has no reporting
 * obligation: every release adapter result is consumed inside this module.
 */
const reportMergeLeaseAnomaly = (chainId: string, release: MergeLeaseRelease): void => {
  if (!isMergeLeaseReleaseAnomaly(release)) return;
  switch (release.outcome) {
    case "released":
    case "not-held":
      return;
    case "skipped":
      console.error(
        `Merge lease anomaly: the release for chain ${chainId} was skipped because the lease is held for task ${release.heldFor}. The merge window on main is still locked and this chain is not the holder.`,
      );
      return;
    case "refused":
      console.error(
        `Merge lease anomaly: the release for chain ${chainId} was refused because the lease is held by ${release.heldBy}. The merge window on main is still locked by another machine.`,
      );
      return;
    case "unreachable":
      console.error(
        `Merge lease anomaly: the release for chain ${chainId} could not be carried out: ${release.detail}. Whether the merge window on main is still locked is unknown.`,
      );
  }
};

/**
 * The chain whose merge lease a Task's run holds, or null when that Task is not
 * part of the merge tail. This mirrors the completion path's `tailLeaseChainId`:
 * the mechanical merge step consumes the current readiness handoff. Regression
 * and auxiliary shapes remain here as cleanup identities for older retained
 * handoffs and interrupted generations; their release is idempotent when the
 * current readiness-owned protocol holds no Lease yet. An auxiliary task
 * answers for the Regression chain it serves rather than for a chain of its
 * own. It reads the same marker window the completion path reads because it is
 * the same question, which is why the window no longer needs restating here.
 */
export type LeaseHolder = {
  chainId: string;
  projectId: string;
  taskId: string;
  role: "mechanical" | "regression" | "auxiliary";
};

export const leaseHolderFor = async (
  tx: Prisma.TransactionClient,
  taskId: string | null,
): Promise<LeaseHolder | null> => {
  if (!taskId) return null;
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: {
      chainId: true,
      projectId: true,
      templateStep: { select: {
        stepIndex: true,
        outputKind: true,
        taskTemplate: { select: { name: true } },
      } },
    },
  });
  if (!task) return null;
  const directRole = executionModeFor(task.templateStep) === "mechanical"
    ? "mechanical" as const
    : isRegressionVerificationOutputKind(task.templateStep?.outputKind)
      ? "regression" as const
      : null;
  if (directRole) {
    return task.chainId
      ? { chainId: task.chainId, projectId: task.projectId, taskId, role: directRole }
      : null;
  }
  const markers = await readMarkers(tx, taskId);
  const auxiliaryRegressionTaskId = latestMarker(markers, "repairAttempt")?.regressionTaskId ?? null;
  if (!auxiliaryRegressionTaskId) return null;
  const regression = await tx.task.findUnique({
    where: { id: auxiliaryRegressionTaskId },
    select: { chainId: true, projectId: true },
  });
  return regression?.chainId
    ? { chainId: regression.chainId, projectId: regression.projectId, taskId, role: "auxiliary" }
    : null;
};

export type LeaseOutcome =
  | { kind: "continue" }
  | {
    kind: "stop";
    taskId: string | null;
    releasedHandoff?: { eventId: string; toRunId: string; target: MergeLeaseTarget; at: Date; reason?: string };
    deferredRelease?: { eventId: string; target: MergeLeaseTarget; at: Date };
  }
  | { kind: "hand-off"; taskId: string | null; handoffRunId: string; at: Date; fromRunId?: string };

type LeaseSettlement = {
  target: MergeLeaseTarget | null;
  releasedHandoff: { eventId: string; taskId: string; at: Date; reason?: string } | null;
  deferredRelease: {
    eventId: string;
    target: MergeLeaseTarget;
    taskId: string;
    at: Date;
  } | null;
};

/** Resolve one declared outcome to the module-owned holder and persistence. */
const settleLease = async (
  tx: Prisma.TransactionClient,
  outcome: LeaseOutcome,
): Promise<LeaseSettlement> => {
  if (outcome.kind === "continue") {
    return { target: null, releasedHandoff: null, deferredRelease: null };
  }
  const holder = await leaseHolderFor(tx, outcome.taskId);
  if (outcome.kind === "hand-off") {
    if (!holder) throw new Error(`Cannot hand off a Merge Lease from Task ${outcome.taskId ?? "without a Task"}`);
    await recordLeaseHandoff(tx, {
      target: { projectId: holder.projectId, chainId: holder.chainId },
      toRunId: outcome.handoffRunId,
      ...(outcome.fromRunId ? { fromRunId: outcome.fromRunId } : {}),
      at: outcome.at,
    });
    return { target: null, releasedHandoff: null, deferredRelease: null };
  }
  if (outcome.releasedHandoff && outcome.deferredRelease) {
    throw new Error("A Merge Lease stop cannot settle both a handoff and a deferred release");
  }
  if (outcome.releasedHandoff && !holder) {
    if (!outcome.taskId) throw new Error("Cannot diagnose a Merge Lease handoff without a Task");
    await settleLeaseEvent(tx, {
      eventId: outcome.releasedHandoff.eventId,
      state: "invalid",
      at: outcome.releasedHandoff.at,
      failureDetail: "the handoff Task does not resolve to a Merge Lease holder",
    });
    return { target: null, releasedHandoff: null, deferredRelease: null };
  }
  if (outcome.deferredRelease) {
    const expected = outcome.deferredRelease.target;
    if (!holder || holder.chainId !== expected.chainId || holder.projectId !== expected.projectId) {
      await settleLeaseEvent(tx, {
        eventId: outcome.deferredRelease.eventId,
        state: "invalid",
        at: outcome.deferredRelease.at,
        failureDetail: holder
          ? "the deferred target no longer matches the Task's Merge Lease holder"
          : "the deferred Task no longer resolves to a Merge Lease holder",
      });
      return { target: null, releasedHandoff: null, deferredRelease: null };
    }
  }
  if (outcome.releasedHandoff?.reason) {
    await tx.mergeLeaseEvent.update({ where: { id: outcome.releasedHandoff.eventId },
      data: { failureDetail: outcome.releasedHandoff.reason } });
  }
  return {
    target: holder
      ? { chainId: holder.chainId, projectId: holder.projectId }
      : null,
    releasedHandoff: holder && outcome.releasedHandoff
      ? {
        eventId: outcome.releasedHandoff.eventId,
        taskId: holder.taskId,
        at: outcome.releasedHandoff.at,
        ...(outcome.releasedHandoff.reason ? { reason: outcome.releasedHandoff.reason } : {}),
      }
      : null,
    deferredRelease: holder && outcome.deferredRelease
      ? {
        eventId: outcome.deferredRelease.eventId,
        target: { projectId: holder.projectId, chainId: holder.chainId },
        taskId: holder.taskId,
        at: outcome.deferredRelease.at,
      }
      : null,
  };
};

const LEASE_HANDOFF_GRACE_MS = 60_000;

/** Query-plan evidence retained for the sibling dbtest; production reads use the ledger module. */
export const deferredLeaseReleasesStatement = Prisma.sql`
  SELECT "id"
  FROM "MergeLeaseEvent"
  WHERE "state" = 'release-deferred'::"MergeLeaseEventState"
  ORDER BY "deferredAt" ASC, "id" ASC
  LIMIT 100
`;

export class LeaseReleaseDeferralRecordError extends Error {
  readonly target: MergeLeaseTarget;
  readonly taskId: string;

  constructor(target: MergeLeaseTarget, taskId: string, cause: unknown) {
    super(`Failed to record deferred Merge Lease release for chain ${target.chainId}`);
    this.name = "LeaseReleaseDeferralRecordError";
    this.target = target;
    this.taskId = taskId;
    this.cause = cause;
  }
}

const recordDeferredLeaseRelease = async (
  db: PrismaClient,
  input: { target: MergeLeaseTarget; taskId: string; detail: string; at: Date },
): Promise<void> => {
  try {
    await db.$transaction(async (tx) => {
      const holder = await leaseHolderFor(tx, input.taskId);
      if (!holder || holder.projectId !== input.target.projectId || holder.chainId !== input.target.chainId) {
        throw new Error(`Cannot defer Merge Lease release for Task ${input.taskId}: target validation failed`);
      }
      await recordLeaseDeferral(tx, {
        target: { projectId: holder.projectId, chainId: holder.chainId },
        taskId: holder.taskId,
        failureDetail: input.detail,
        at: input.at,
      });
    });
  } catch (error: unknown) {
    throw new LeaseReleaseDeferralRecordError(input.target, input.taskId, error);
  }
};

export const deferredLeaseReleases = async (
  tx: Prisma.TransactionClient,
  staleBefore: Date = new Date(),
): Promise<Array<{ eventId: string; taskId: string; target: MergeLeaseTarget }>> => (
  listUnresolvedLeaseEvents(tx, { kind: "deferral", staleBefore })
);

/** Find retained handoffs whose queued Run never became a Lease consumer. */
export const leaseHandoffsWithoutConsumer = async (
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<Array<{ eventId: string; toRunId: string; taskId: string; target: MergeLeaseTarget }>> => {
  const staleBefore = new Date(now.getTime() - LEASE_HANDOFF_GRACE_MS);
  return listUnresolvedLeaseEvents(tx, { kind: "handoff", staleBefore });
};

export type TransactionLeaseOutcome<T> = {
  value: T;
  leaseOutcome: LeaseOutcome;
};

export type CommitWithLeaseOutcomeOptions = {
  release?: ReleaseMergeLease | undefined;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

type CommittedLeaseOutcome<T> = {
  value: T;
  settlement: LeaseSettlement;
};

export type LeaseOutcomePostCommitFailure = {
  target: MergeLeaseTarget;
  phase: "release" | "record";
  error: unknown;
};

export class LeaseOutcomePostCommitError extends AggregateError {
  readonly failures: LeaseOutcomePostCommitFailure[];

  constructor(failures: LeaseOutcomePostCommitFailure[]) {
    super(failures.map((failure) => failure.error), "One or more Merge Lease releases or records failed");
    this.name = "LeaseOutcomePostCommitError";
    this.failures = failures;
  }
}

const releaseCommittedLeaseOutcomes = async (
  db: PrismaClient,
  committed: Array<CommittedLeaseOutcome<unknown>>,
  release: ReleaseMergeLease,
  aggregateFailures: boolean,
): Promise<void> => {
  const targets = new Map<string, {
    target: MergeLeaseTarget;
    handoffs: Array<NonNullable<LeaseSettlement["releasedHandoff"]>>;
    deferredReleases: Array<NonNullable<LeaseSettlement["deferredRelease"]>>;
  }>();
  for (const entry of committed) {
    const target = entry.settlement.target;
    if (!target) continue;
    const key = JSON.stringify([target.projectId, target.chainId]);
    const existing = targets.get(key) ?? { target, handoffs: [], deferredReleases: [] };
    if (entry.settlement.releasedHandoff) existing.handoffs.push(entry.settlement.releasedHandoff);
    if (entry.settlement.deferredRelease) existing.deferredReleases.push(entry.settlement.deferredRelease);
    targets.set(key, existing);
  }

  const failures: LeaseOutcomePostCommitFailure[] = [];
  for (const entry of targets.values()) {
    let releaseResult: MergeLeaseRelease | void;
    try {
      releaseResult = await release(entry.target, db);
    } catch (error: unknown) {
      failures.push({ target: entry.target, phase: "release", error });
      // A claimed, ended Run is outside the queued-handoff sweep. Move its
      // failed release to the existing deferred-release reconciler only after
      // the origin call has ended, so no replacement races that call.
      for (const handoff of entry.handoffs.filter((item) => item.reason)) {
        try {
          await db.$transaction(async (tx) => {
            await settleLeaseEvent(tx, { eventId: handoff.eventId, state: "invalid", at: handoff.at,
              failureDetail: "Completion Lease release deferred after transport failure",
              reason: "Chain Lease release deferred after the completed Run's release attempt failed" });
            await recordLeaseDeferral(tx, { target: entry.target, taskId: handoff.taskId,
              failureDetail: handoff.reason!, at: handoff.at });
          });
        } catch (recordError: unknown) {
          failures.push({ target: entry.target, phase: "record", error: recordError });
        }
      }
      continue;
    }
    // A custom release dependency historically returned void, which means it
    // completed without a machine-readable refusal. Treat that as confirmed
    // for compatibility. Real adapters return `skipped`/`refused` when a newer
    // holder owns the ref; leave the event open so reconciliation cannot mark a
    // newer generation as released.
    const releaseConfirmed = releaseResult === undefined
      || releaseResult.outcome === "released"
      || releaseResult.outcome === "not-held";
    if (!releaseConfirmed) continue;
    if (entry.handoffs.length > 0 || entry.deferredReleases.length > 0) {
      try {
        await db.$transaction(async (tx) => {
          for (const handoff of entry.handoffs) {
            await settleLeaseEvent(tx, {
              eventId: handoff.eventId,
              state: "released",
              at: handoff.at,
              ...(handoff.reason ? { reason: handoff.reason } : {}),
            });
          }
          for (const deferred of entry.deferredReleases) {
            await settleLeaseEvent(tx, {
              eventId: deferred.eventId,
              state: "released",
              at: deferred.at,
            });
          }
        });
      } catch (error: unknown) {
        failures.push({ target: entry.target, phase: "record", error });
      }
    }
  }
  if (failures.length === 1 && !aggregateFailures) throw failures[0]!.error;
  if (failures.length > 0) throw new LeaseOutcomePostCommitError(failures);
};

/** Commit database state before carrying out its one post-commit Lease release. */
export const commitWithLeaseOutcome = async <T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<TransactionLeaseOutcome<T> | null>,
  options: CommitWithLeaseOutcomeOptions = {},
): Promise<T | null> => {
  const committed = await db.$transaction(async (tx) => {
    const result = await fn(tx);
    if (result === null) return null;
    return {
      value: result.value,
      settlement: await settleLease(tx, result.leaseOutcome),
    };
  }, options.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined);
  if (committed === null) return null;
  await releaseCommittedLeaseOutcomes(db, [committed], options.release ?? releaseMergeLease, false);
  return committed.value;
};

/** Commit a reconciliation batch, deduplicating its post-commit Lease targets. */
export const commitWithLeaseOutcomes = async <T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<{ value: T; leaseOutcomes: LeaseOutcome[] }>,
  options: CommitWithLeaseOutcomeOptions = {},
): Promise<T> => {
  const committed = await db.$transaction(async (tx) => {
    const result = await fn(tx);
    const settlements: LeaseSettlement[] = [];
    for (const outcome of result.leaseOutcomes) settlements.push(await settleLease(tx, outcome));
    return {
      value: result.value,
      settlements,
    };
  }, options.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined);
  await releaseCommittedLeaseOutcomes(
    db,
    committed.settlements.map((settlement) => ({ value: undefined, settlement })),
    options.release ?? releaseMergeLease,
    true,
  );
  return committed.value;
};

/**
 * What one `merge-lease.sh acquire --timeout-minutes 0` did. Unlike release,
 * the exit code alone separates these, so there is no machine line to read: 0
 * means this chain holds the lease -- freshly taken, or already held for the
 * same task id, which is what its own regression run leaves behind -- and 75
 * means somebody else holds it. Anything else never got far enough to say.
 */
export type MergeLeaseAcquisition = LeaseScriptAcquisition;

/**
 * A lease this chain could not take, and whoever was holding it. The holder is
 * absent when `merge-lease.sh` could not read the blob on origin: contention is
 * still contention, and the caller says so rather than naming nobody.
 */
export type MergeLeaseContention = { outcome: "contended"; holder?: MergeLeaseHolder };

export type MergeLeaseAcquirer = (chainId: string) => Promise<MergeLeaseAcquisition>;

/**
 * One attempt, never a poll. The caller is the readiness tick, which cannot
 * block on a lock another delivery line may hold for minutes; a tick that
 * cannot take the lease leaves its step claimed and comes back. The reason
 * string matches the one the chain's own regression run writes, so an operator
 * reading `merge-lease.sh status` sees the same lease either way.
 */
export const acquireMergeLeaseAdapter = async (
  chainId: string,
  options: { environment?: NodeJS.ProcessEnv; runner?: LeaseRunner } = {},
): Promise<MergeLeaseAcquisition> => {
  const acquisition = await invokeMergeLeaseAcquisition({
    environment: options.environment ?? process.env,
    ...(options.runner ? { runner: options.runner } : {}),
    task: chainId,
    reason: `chain merge tail ${chainId}`,
    timeoutMinutes: 0,
    processTimeoutMs: 30_000,
  });
  if (acquisition.detail) {
    if (acquisition.outcome === "unreachable") console.error(`Merge lease acquire failed for chain ${chainId}: ${acquisition.detail}`);
    else if (acquisition.outcome === "acquired") console.log(acquisition.detail);
  }
  return acquisition;
};

export type HeldLeaseOutcome =
  | { kind: "continue" }
  | { kind: "stop"; taskId: string };

export type MergeLeaseDependencies = {
  acquire: MergeLeaseAcquirer;
  release: MergeLeaseReleaser;
  now?: () => Date;
};

export type WithMergeLease = <T>(
  target: MergeLeaseTarget | null,
  fn: () => Promise<{ leaseOutcome: HeldLeaseOutcome; value: T }>,
  db: PrismaClient,
  dependencies?: MergeLeaseDependencies,
) => Promise<
  | MergeLeaseContention
  | { outcome: "unreachable"; detail: string; releaseDeferred?: true }
  | { outcome: "ran"; value: T }
>;

/**
 * Run one authorization attempt under the Chain's merge Lease. A successful
 * authorization continues the Lease for mechanical merge after its handoff
 * was persisted by commitWithLeaseOutcome; every stop or exceptional callback
 * path gives it back here.
 * A Task without a Chain has no Lease to acquire or release, but still runs the
 * callback through the same interface.
 */
export const withMergeLease = async <T>(
  target: MergeLeaseTarget | null,
  fn: () => Promise<{ leaseOutcome: HeldLeaseOutcome; value: T }>,
  db: PrismaClient,
  dependencies: MergeLeaseDependencies = {
    acquire: acquireMergeLeaseAdapter,
    release: releaseMergeLeaseAdapter,
  },
): Promise<
  | MergeLeaseContention
  | { outcome: "unreachable"; detail: string; releaseDeferred?: true }
  | { outcome: "ran"; value: T }
> => {
  if (target === null) {
    const result = await fn();
    return { outcome: "ran", value: result.value };
  }

  const acquisition = await dependencies.acquire(target.chainId);
  if (acquisition.outcome === "contended") {
    return { outcome: "contended", ...(acquisition.holder ? { holder: acquisition.holder } : {}) };
  }
  if (acquisition.outcome === "unreachable") {
    return { outcome: "unreachable", detail: acquisition.detail };
  }

  let leaseOutcome: HeldLeaseOutcome | { kind: "stop"; taskId: null } = { kind: "stop", taskId: null };
  let callbackFailed = false;
  let callbackError: unknown;
  let result: { leaseOutcome: HeldLeaseOutcome; value: T } | undefined;
  try {
    result = await fn();
    leaseOutcome = result.leaseOutcome;
  } catch (error: unknown) {
    callbackFailed = true;
    callbackError = error;
  }
  if (leaseOutcome.kind === "stop") {
    const deferRelease = async (detail: string): Promise<{
      outcome: "unreachable";
      detail: string;
      releaseDeferred?: true;
    }> => {
      if (!leaseOutcome.taskId) return { outcome: "unreachable", detail };
      await recordDeferredLeaseRelease(db, {
        target,
        taskId: leaseOutcome.taskId,
        detail,
        at: dependencies.now?.() ?? new Date(),
      });
      return { outcome: "unreachable", detail, releaseDeferred: true };
    };
    let release: MergeLeaseRelease | null;
    try {
      release = await releaseMergeLeaseWith(dependencies.release, target);
    } catch (releaseError: unknown) {
      const releaseDetail = `Merge lease release transport failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`;
      return deferRelease(callbackFailed
        ? `Merge lease callback failed before release: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}; ${releaseDetail}`
        : releaseDetail);
    }
    if (release?.outcome === "unreachable") {
      return deferRelease(callbackFailed
        ? `Merge lease callback failed before release: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}; release transport unreachable: ${release.detail}`
        : release.detail);
    }
    if (release?.outcome === "released") {
      try {
        await recordMergeLeaseHold(db, target, release, dependencies.now?.() ?? new Date());
      } catch (releaseError: unknown) {
        if (callbackFailed) {
          throw new AggregateError(
            [callbackError, releaseError],
            "Merge lease callback and confirmed-release recording both failed",
          );
        }
        throw releaseError;
      }
    }
  }
  if (callbackFailed) throw callbackError;
  return { outcome: "ran", value: result!.value };
};
