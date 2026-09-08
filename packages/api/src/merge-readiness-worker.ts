import { randomUUID } from "node:crypto";

import {
  ACTIVE_RUN_STATUSES,
  AUTHORIZED_MERGE_METHOD,
  asJsonObject,
  MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES,
  readinessRequeueActivityWhere,
  readinessRequeueTotals,
  MergeRecoveryRefusalCode,
  MergeRecoveryStatus,
  Prisma,
  RunStatus,
  TaskStatus,
  activateChainSuccessor,
  activateRecoveryIntegratorSuccessor,
  authorizationMetadata,
  isGatedMergeReadinessTask,
  isMergeReadinessStep,
  latestRecordedStop,
  mergeExecutorRunnerIds,
  executorOfflineDetail,
  latestExecutorOfflineMarker,
  openEpisodeStart,
  closeExecutorOfflineEpisodeTx as closeOfflineEpisodeTx,
  mergeExecutorsBlockingAuthorization,
  MERGE_EXECUTOR_OFFLINE_REASON,
  MERGE_EXECUTOR_OFFLINE_STATE,
  MergeGateAuthorizationError,
  MERGE_TAIL_KIND,
  parseRegressionVerdict,
  readMarkerHistory,
  requireMergeGateAuthorization,
  REGRESSION_VERIFICATION_OUTPUT_KINDS,
  recordReadinessRequeue,
  recoveryContext,
  resolveChainTarget,
  transitionMergeRecovery,
  writeMarker,
  type PrismaClient,
  type RecoveryContext,
  type TrainAuthorization,
} from "@anneal/db";

import { mergeTrainWidth } from "./startup-config.js";
import { mergeTrainReadinessTick, pendingMergeTrains } from "./merge-train-readiness.js";

import { lockTaskMutationRows } from "./task-write.js";
import { RUNNER_FORGET_MS, type DaemonSnapshot } from "./runners.js";
import { openDefenseAuditNotice, stopMergeTail } from "./merge-tail-actions.js";
import {
  adoptRecoveryHead,
  awaitAuthorization,
  enterRepair,
  requeueMergeTailRun,
  RECOVERY_HEAD_ADOPTION_CONFLICT_MESSAGE,
  reopenAfterHeadAdoption,
} from "./merge-tail-state.js";
import type { PullRequestReader } from "./github-read.js";
import {
  evaluateReadiness,
  READINESS_READ_BUDGET_MS,
  type ReadinessDecision,
  type ReadinessInput,
} from "./readiness-decision.js";
import {
  LeaseReleaseDeferralRecordError,
  releaseMergeLease,
  withMergeLease,
  type HeldLeaseOutcome,
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";
import type { MergeLeaseTarget } from "./merge-lease-hold.js";
import { clearLeaseContention, noteLeaseContention } from "./merge-lease-contention.js";
import type { MergeLeaseHolder } from "../../../scripts/merge-lease-adapter.mjs";
import {
  claimReadinessStep,
  READINESS_CLAIM_LEASE_MS,
  type ReadinessClaimHandle,
  type ReadinessLeaseOwnership,
} from "./readiness-claim.js";
import {
  createReadinessSettlementRunner,
  readinessSettlement,
  type ReadinessSettlement,
  type ReadinessSettlementApplication,
  type ReadinessSettlementRunner,
} from "./readiness-settlement.js";

export const readinessPollIntervalMs = (): number => {
  const raw = Number(process.env.MERGE_READINESS_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 250 ? Math.floor(raw) : 2_000;
};

// Separate from lease-loss compensation: a valid exact-base PASS earns a
// replacement, but a task continually outrun by main must still stop.
export const READINESS_BASE_DRIFT_REQUEUE_LIMIT = 3;
export const READINESS_EXCEPTION_REQUEUE_LIMIT = 3;

/**
 * How many times one readiness Step may be requeued after an evaluation
 * exception before the tail stops. A misconfigured limit is not silently
 * replaced by the default: an unusable bound would decide, unseen, whether a
 * transient failure costs a retry or a manual delivery.
 */
export const readinessExceptionRequeueLimit = (): number => {
  const raw = process.env.MERGE_READINESS_EXCEPTION_REQUEUE_LIMIT;
  if (raw === undefined || raw.trim() === "") return READINESS_EXCEPTION_REQUEUE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `MERGE_READINESS_EXCEPTION_REQUEUE_LIMIT must be a non-negative integer, got ${raw}`,
    );
  }
  return parsed;
};

export { READINESS_READ_BUDGET_MS };
export { READINESS_CLAIM_LEASE_MS };
const READINESS_CANDIDATE_INCLUDE = {
  templateStep: { include: { taskTemplate: { select: { name: true } } } },
  repo: true,
} as const;
export type ReadinessCandidate = Prisma.TaskGetPayload<{ include: typeof READINESS_CANDIDATE_INCLUDE }>;
const READINESS_REGRESSION_INCLUDE = {
  stepOutput: true,
  runs: { orderBy: { runNumber: "desc" as const }, take: 1, select: { id: true, branch: true } },
} as const;
type ReadinessRegression = Prisma.TaskGetPayload<{ include: typeof READINESS_REGRESSION_INCLUDE }>;

const HEAD_ADOPTION_REFUSAL_CODES = [
  MergeRecoveryRefusalCode.ACTIVATION_AUTHORIZATION_STALE,
  MergeRecoveryRefusalCode.HEAD_ADOPTION_CONFLICT,
] as const;

type HeadAdoptionRefusalCode = (typeof HEAD_ADOPTION_REFUSAL_CODES)[number];

const RECOVERY_REFUSAL_MESSAGES: Record<HeadAdoptionRefusalCode, string> = {
  [MergeRecoveryRefusalCode.ACTIVATION_AUTHORIZATION_STALE]:
    "Recovery activation authorization is not fresh for the recovered exact head and current base",
  [MergeRecoveryRefusalCode.HEAD_ADOPTION_CONFLICT]:
    RECOVERY_HEAD_ADOPTION_CONFLICT_MESSAGE,
};

class MergeRecoveryRefusalError extends Error {
  readonly refusalCode: HeadAdoptionRefusalCode;

  constructor(refusalCode: HeadAdoptionRefusalCode, cause?: unknown) {
    super(
      cause instanceof Error ? cause.message : RECOVERY_REFUSAL_MESSAGES[refusalCode],
      cause === undefined ? undefined : { cause },
    );
    this.name = "MergeRecoveryRefusalError";
    this.refusalCode = refusalCode;
  }
}

const recoveryHeadAdoptionSnapshotChanged = async (
  tx: Prisma.TransactionClient,
  recovery: RecoveryContext,
): Promise<boolean> => {
  const current = await tx.mergeRecoveryAttempt.findUnique({
    where: { id: recovery.aggregateId },
    select: {
      status: true,
      recoveryRunId: true,
      currentBaseSha: true,
      authorizedHeadSha: true,
    },
  });
  return !current
    || current.status !== MergeRecoveryStatus.AWAITING_AUTHORIZATION
    || current.recoveryRunId !== recovery.recoveryRunId
    || current.currentBaseSha !== recovery.currentBaseSha
    || current.authorizedHeadSha !== recovery.authorizedHeadSha;
};

export const reopenRecoveryHeadAdoptionFailures = async (
  db: PrismaClient,
  limit = 5,
): Promise<number> => {
  const candidates = await db.mergeRecoveryAttempt.findMany({
    where: {
      status: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
      refusalCode: { in: [...HEAD_ADOPTION_REFUSAL_CODES] },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  let reopened = 0;
  for (const candidate of candidates) {
    if (!candidate.readinessTaskId || !candidate.regressionTaskId || !candidate.recoveryRunId) continue;
    const applied = await db.$transaction(async (tx) => {
      if (!await lockTaskMutationRows(tx, candidate.readinessTaskId!)) return false;
      const [attempt, regression, readiness, integrator, run, output, stop] = await Promise.all([
        tx.mergeRecoveryAttempt.findUnique({ where: { id: candidate.id } }),
        tx.task.findUnique({ where: { id: candidate.regressionTaskId! }, select: { status: true } }),
        tx.task.findUnique({ where: { id: candidate.readinessTaskId! }, select: { status: true } }),
        tx.task.findUnique({ where: { id: candidate.integratorTaskId }, select: { status: true } }),
        tx.run.findUnique({ where: { id: candidate.recoveryRunId! }, select: { id: true, taskId: true, status: true, headSha: true } }),
        tx.taskStepOutput.findUnique({ where: { taskId: candidate.regressionTaskId! } }),
        latestRecordedStop(tx, candidate.integratorTaskId),
      ]);
      const verdict = parseRegressionVerdict(output?.body ?? "", output?.kind ?? "");
      const context = recoveryContext(attempt);
      const baseBindingMatchesRefusal = verdict.status === "ok" && (
        (attempt?.refusalCode === MergeRecoveryRefusalCode.ACTIVATION_AUTHORIZATION_STALE
          && verdict.verdict.baseHeadSha === attempt.currentBaseSha)
        || (attempt?.refusalCode === MergeRecoveryRefusalCode.HEAD_ADOPTION_CONFLICT
          && verdict.verdict.baseHeadSha !== attempt.currentBaseSha)
      );
      if (!attempt
        || !context
        || attempt.status !== MergeRecoveryStatus.BLOCKED_DOWNSTREAM
        || !HEAD_ADOPTION_REFUSAL_CODES.some((code) => code === attempt.refusalCode)
        || !attempt.failureReason
        || attempt.readinessTaskId !== candidate.readinessTaskId
        || attempt.regressionTaskId !== candidate.regressionTaskId
        || attempt.recoveryRunId !== candidate.recoveryRunId
        || regression?.status !== TaskStatus.REVIEW
        || readiness?.status !== TaskStatus.REVIEW
        || integrator?.status !== TaskStatus.REVIEW
        || run?.taskId !== candidate.regressionTaskId
        || run.status !== RunStatus.SUCCEEDED
        || verdict.status !== "ok"
        || verdict.verdict.outcome !== "pass"
        || output?.runId !== run.id
        || output?.commitSha !== verdict.verdict.headSha
        || run.headSha !== verdict.verdict.headSha
        || !baseBindingMatchesRefusal
        || stop?.stopId !== attempt.sourceStopId
        || stop.sourceRunId !== context.sourceRunId) return false;

      const reopened = await reopenAfterHeadAdoption(tx, {
        recovery: context,
        expectedFailureReason: attempt.failureReason,
      });
      if (!reopened) return false;
      const cleared = await tx.mergeRecoveryAttempt.updateMany({
        where: {
          id: attempt.id,
          status: MergeRecoveryStatus.REPAIRING,
          refusalCode: attempt.refusalCode,
          failureReason: null,
        },
        data: { refusalCode: null },
      });
      if (cleared.count !== 1) {
        throw new Error(`Recovery refusal code was not cleared after reopening ${attempt.id}`);
      }
      return true;
    });
    if (applied) reopened += 1;
  }
  return reopened;
};

const readinessCandidates = async function* (
  db: PrismaClient,
  pageSize: number,
): AsyncGenerator<ReadinessCandidate> {
  let cursor: string | null = null;
  while (true) {
    const page: ReadinessCandidate[] = await db.task.findMany({
      where: {
        OR: [
          { status: { in: [TaskStatus.TODO, TaskStatus.DOING] } },
          { status: TaskStatus.REVIEW, failureReason: { startsWith: `${MERGE_EXECUTOR_OFFLINE_REASON}:` } },
        ],
        templateStep: { outputKind: "merge-authorization" },
      },
      include: READINESS_CANDIDATE_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) return;
    for (const candidate of page) yield candidate;
    if (page.length < pageSize) return;
    cursor = page.at(-1)!.id;
  }
};

const recoveryContextFor = async (
  db: PrismaClient,
  regressionTaskId: string,
  readinessTaskId: string,
  recoveryRunId: string | null,
): Promise<{ context: RecoveryContext; status: MergeRecoveryStatus } | null> => {
  if (!recoveryRunId) return null;
  const row = await db.mergeRecoveryAttempt.findFirst({ where: {
    regressionTaskId,
    readinessTaskId,
    recoveryRunId,
    status: { in: [MergeRecoveryStatus.REPAIRING, MergeRecoveryStatus.AWAITING_AUTHORIZATION] },
  }, orderBy: [{ attempt: "desc" }, { id: "desc" }] });
  const context = recoveryContext(row);
  return row && context ? { context, status: row.status } : null;
};

const stopReadinessSettlement = (
  input: {
    readinessTaskId: string;
    regressionTaskId: string;
    reason: string;
    recovery: RecoveryContext | null;
    refusalCode: MergeRecoveryRefusalCode | null;
    now: Date;
  },
): ReadinessSettlement => readinessSettlement("stop", {
  taskId: input.regressionTaskId,
  at: input.now,
  apply: async (tx) => {
    const stopped = await stopMergeTail(tx, {
      phase: "readiness",
      readinessTaskId: input.readinessTaskId,
      regressionTaskId: input.regressionTaskId,
      reason: input.reason,
      recovery: input.recovery,
      at: input.now,
    });
    if (input.recovery && input.refusalCode) {
      const coded = await tx.mergeRecoveryAttempt.updateMany({
        where: {
          id: input.recovery.aggregateId,
          status: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
          failureReason: input.reason,
        },
        data: { refusalCode: input.refusalCode },
      });
      if (coded.count !== 1) {
        throw new Error(`Recovery refusal code was not recorded for ${input.recovery.aggregateId}`);
      }
    }
    return { ownership: "released", leaseOutcome: stopped.leaseOutcome };
  },
});

export const READINESS_EXCEPTION_REQUEUE_STATE = "requeued-exception";

/**
 * Returns the readiness Step to `TODO` after an evaluation exception so the
 * next tick evaluates it again. That Step is the only row whose status this
 * touches: the Regression evidence it was about to authorize is still valid.
 * The marker goes where every other readiness-phase marker goes -- the
 * Regression task, alongside the readiness requeue and stop rows the board
 * already shows -- so the retries appear in the stream operators read.
 */
export const requeueReadinessExceptionSettlement = (
  input: {
    readinessTaskId: string;
    regressionTaskId: string;
    reason: string;
    requeue: number;
    limit: number;
    recovery: RecoveryContext | null;
    now: Date;
  },
): ReadinessSettlement => readinessSettlement("requeue", {
  taskId: input.regressionTaskId,
  at: input.now,
  apply: async (tx) => {
    await tx.task.update({
      where: { id: input.readinessTaskId },
      data: { status: TaskStatus.TODO, failureReason: null },
    });
    await writeMarker(tx, input.regressionTaskId, "readiness", {
      actorType: "control-plane",
      body: `Merge readiness requeued after evaluation exception ${String(input.requeue)}`
        + ` of ${String(input.limit)}: ${input.reason}`,
      metadata: {
        state: READINESS_EXCEPTION_REQUEUE_STATE,
        reason: input.reason,
        requeue: input.requeue,
        limit: input.limit,
        recoveryAggregateId: input.recovery?.aggregateId ?? null,
      },
    });
    return {
      ownership: "released",
      leaseOutcome: { kind: "stop", taskId: input.regressionTaskId },
    };
  },
});

/**
 * Exception requeues already spent on this readiness Step, read from the
 * Regression task that carries its markers and counted within the recovery
 * attempt that owns them: a base-drift recovery is a fresh tail, and the
 * requeues its predecessor spent are not charged to it.
 */
const spentExceptionRequeues = async (
  db: PrismaClient,
  regressionTaskId: string,
  recovery: RecoveryContext | null,
): Promise<number> => {
  const markers = await readMarkerHistory(db as Prisma.TransactionClient, regressionTaskId);
  return markers.filter((marker) => marker.kind === "readiness"
    && marker.state === READINESS_EXCEPTION_REQUEUE_STATE
    && (marker.raw.recoveryAggregateId ?? null) === (recovery?.aggregateId ?? null)).length;
};

export type ReadinessTickResult = { claimed: number; authorized: number; requeued: number; stopped: number };

export const requeueRegressionSettlement = (
  input: {
    readinessTaskId: string;
    regressionTaskId: string;
    staleBaseSha: string;
    currentBaseSha: string;
    condition: Extract<ReadinessDecision, { kind: "requeue-regression" }>["condition"];
    reason: string;
    now: Date;
    recovery: RecoveryContext | null;
  },
): ReadinessSettlement => readinessSettlement("requeue", {
  taskId: input.regressionTaskId,
  at: input.now,
  apply: async (tx) => {
    const baseDrift = input.condition === "base-advanced" || input.condition === "train-base-stale";
    // The readiness claim serializes this count with the Run grant and its
    // durable activity. Never use the bounded marker-history window here.
    const rows = baseDrift ? await tx.taskActivity.findMany({
      where: readinessRequeueActivityWhere(input.readinessTaskId),
      select: { metadata: true },
    }) : [];
    const aggregateId = input.recovery?.aggregateId ?? null;
    const spent = readinessRequeueTotals(rows.filter((row) => {
      const metadata = asJsonObject(row.metadata);
      return metadata?.baseDrift === true
        && (metadata.recoveryAggregateId ?? null) === aggregateId;
    })).readinessRequeues;
    const ceiling = input.recovery ? MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES : READINESS_BASE_DRIFT_REQUEUE_LIMIT;
    if (baseDrift && spent >= ceiling) {
      const name = input.recovery ? "base-drift-recovery-requeue-limit" : "readiness-base-drift-requeue-limit";
      const stopped = await stopMergeTail(tx, {
        phase: "readiness",
        readinessTaskId: input.readinessTaskId,
        regressionTaskId: input.regressionTaskId,
        recovery: input.recovery,
        reason: `${name}: ${spent} requeues reached ceiling ${ceiling}`,
        at: input.now,
      });
      return { stopped: true, ownership: "released", leaseOutcome: stopped.leaseOutcome };
    }
    // The prior Regression run succeeded; the control plane invalidated its
    // exact-base evidence after a remote read. This retry is therefore external
    // compensation, not another attempt charged to the agent. Without the
    // grant, a requeue at the configured ceiling creates run N+1 with ceiling N
    // and the runner rejects it before launch -- exactly the stuck state the
    // readiness transition was supposed to recover.
    if (input.recovery) {
      await enterRepair(tx, {
        aggregateId: input.recovery.aggregateId,
        currentBaseSha: input.currentBaseSha,
        now: input.now,
        readinessRequeue: { staleBaseSha: input.staleBaseSha, reason: input.reason, baseDrift },
      });
    } else {
      await tx.task.update({
        where: { id: input.readinessTaskId },
        data: { status: TaskStatus.TODO, failureReason: null },
      });
      await tx.task.update({
        where: { id: input.regressionTaskId },
        data: { status: TaskStatus.TODO, failureReason: null },
      });
      const attempt = await requeueMergeTailRun(tx, input.regressionTaskId, input.now, baseDrift);
      if (attempt.outcome !== "opened") {
        if (attempt.outcome === "refused" && attempt.refusal.disposition !== "held") {
          await tx.task.update({ where: { id: input.readinessTaskId }, data: {
            status: TaskStatus.REVIEW, failureReason: attempt.refusal.message,
          } });
        }
        return { ownership: "released", leaseOutcome: { kind: "stop", taskId: input.regressionTaskId } };
      }
      // The counter shares this transaction with the grant it counts, so a
      // rolled-back settlement leaves neither behind, and a refused requeue
      // returns above without granting or counting anything.
      await recordReadinessRequeue(tx, {
        readinessTaskId: input.readinessTaskId,
        regressionTaskId: input.regressionTaskId,
        staleBaseSha: input.staleBaseSha,
        currentBaseSha: input.currentBaseSha,
        budgetGrant: 1,
        baseDrift,
        reason: input.reason,
      });
      await writeMarker(tx, input.regressionTaskId, "readiness", {
        actorType: "control-plane",
        body: `Merge readiness returned to regression: ${input.reason}; ${input.staleBaseSha} -> ${input.currentBaseSha}`,
        metadata: {
          state: "requeued-regression",
          reason: input.reason,
          staleBaseSha: input.staleBaseSha,
          currentBaseSha: input.currentBaseSha,
        },
      });
    }
    return {
      ownership: "released",
      leaseOutcome: { kind: "stop", taskId: input.regressionTaskId },
    };
  },
});

/**
 * The daemon liveness `GET /runners` reports, read by the readiness worker so
 * an authorization is written only while a merge executor can claim it. One
 * reader, one rule: the registry snapshot decides `online`, and this worker
 * never re-derives liveness from a second clock. The reader carries its own
 * clock because the guard that matters runs under the Merge Lease, seconds
 * after the timestamp the tick started with, and must read liveness as of then.
 */
export type DaemonSnapshotReader = () => DaemonSnapshot[];

const EXECUTOR_OFFLINE_STATE = MERGE_EXECUTOR_OFFLINE_STATE;
export { MERGE_EXECUTOR_OFFLINE_REASON };

/**
 * How long readiness waits at the door for a merge executor before the tail
 * stops. It is `RUNNER_FORGET_MS` because that is the existing ceiling on the
 * same liveness fact: past it the registry has forgotten the daemon entirely,
 * so this is no longer a restart to wait out. It is not a new configuration
 * surface, and the wait spends no regression repair budget: nothing is rerun.
 */
export const MERGE_EXECUTOR_OFFLINE_WAIT_MS = RUNNER_FORGET_MS;

/**
 * The configured merge executors when none of them is online, which is exactly
 * when an authorization must not be written; empty when one is online, and
 * empty for an unconfigured allowlist too: with no executor named, readiness
 * authorizes exactly as it did before this check existed.
 */
export const executorsBlockingAuthorization = (
  daemons: DaemonSnapshotReader,
): string[] => {
  const allowlist = mergeExecutorRunnerIds();
  if (allowlist.length === 0) return [];
  return mergeExecutorsBlockingAuthorization(daemons(), allowlist);
};

/**
 * Readiness returning itself to the queue: the regression evidence and its Run
 * are untouched, nothing is authorized, and the next tick asks again.
 *
 * The wait surrenders the chain's Merge Lease rather than holding it, which is
 * what settlement kind `requeue` means here. Holding it would block the whole
 * delivery line for as long as the outage lasts, and it buys nothing: the
 * allowlist is global, so while it is offline no chain can be authorized, and
 * a base that moves some other way is caught by the evidence check on the tick
 * that finally authorizes.
 */
const executorOfflineRequeueSettlement = (
  input: {
    readinessTaskId: string;
    regressionTaskId: string;
    executorRunnerIds: string[];
    episodeStartedAt: Date;
    now: Date;
  },
): ReadinessSettlement => readinessSettlement("requeue", {
  taskId: input.regressionTaskId,
  at: input.now,
  apply: async (tx) => {
    await tx.taskActivity.create({ data: {
      taskId: input.readinessTaskId,
      actorType: "control-plane",
      body: `Merge readiness withheld its authorization: ${executorOfflineDetail(input.executorRunnerIds)}`,
      metadata: {
        kind: MERGE_TAIL_KIND.readiness,
        state: EXECUTOR_OFFLINE_STATE,
        reason: MERGE_EXECUTOR_OFFLINE_REASON,
        executorRunnerIds: input.executorRunnerIds,
        episodeStartedAt: input.episodeStartedAt.toISOString(),
      },
    } });
    await tx.task.update({
      where: { id: input.readinessTaskId },
      data: { status: TaskStatus.TODO, failureReason: null },
    });
    return {
      ownership: "released",
      leaseOutcome: { kind: "stop", taskId: input.regressionTaskId },
    };
  },
});

/** Close only under the readiness claim, using the caller's transaction. */
export const closeExecutorOfflineEpisodeTx = async (
  tx: Prisma.TransactionClient,
  readinessTaskId: string,
  claim: ReadinessClaimHandle,
  observation: string,
): Promise<void> => {
  await claim.settle(tx, {
    kind: "keep",
    apply: (client) => closeOfflineEpisodeTx(client, readinessTaskId, observation),
  });
};

export const closeExecutorOfflineEpisode = async (
  db: PrismaClient,
  readinessTaskId: string,
  claim: ReadinessClaimHandle,
  observation: string,
): Promise<void> => {
  await db.$transaction((tx) => closeExecutorOfflineEpisodeTx(tx, readinessTaskId, claim, observation));
};

/**
 * The decision an authorization must survive: it is written only while a merge
 * executor is online, so an outage costs a requeue rather than an authorization
 * the executor will meet as base drift when it comes back. The wait is bounded
 * by the current outage; past the ceiling the tail parks in REVIEW naming the
 * outage, like every other readiness stop.
 */
const executorOfflineSettlement = async (
  db: Prisma.TransactionClient,
  read: ClaimedReadiness,
  executorRunnerIds: string[],
): Promise<ReadinessSettlement> => {
  const { readiness, regression, recovery } = read;
  const now = read.input.now;
  const episodeStartedAt = openEpisodeStart(await latestExecutorOfflineMarker(db, readiness.id)) ?? now;
  const waitedMs = now.getTime() - episodeStartedAt.getTime();
  if (waitedMs >= MERGE_EXECUTOR_OFFLINE_WAIT_MS) {
    await closeExecutorOfflineEpisodeTx(db, readiness.id, read.claim, "executor-offline ceiling reached");
    return stopReadinessSettlement({
      readinessTaskId: readiness.id,
      regressionTaskId: regression.id,
      reason: `${executorOfflineDetail(executorRunnerIds)} after ${Math.round(waitedMs / 60_000)} minutes`,
      recovery,
      refusalCode: null,
      now,
    });
  }
  return executorOfflineRequeueSettlement({
    readinessTaskId: readiness.id,
    regressionTaskId: regression.id,
    executorRunnerIds,
    episodeStartedAt,
    now,
  });
};

const settleExecutorOffline = async (
  db: PrismaClient,
  read: ClaimedReadiness,
  executorRunnerIds: string[],
  result: ReadinessTickResult,
  runner: ReadinessSettlementRunner,
): Promise<Extract<ReadinessSettlementApplication, { kind: "settled" }>> => {
  const settlement = await db.$transaction((tx) => executorOfflineSettlement(tx, read, executorRunnerIds));
  const application = await runner.apply(settlement, read.claim);
  if (application.kind === "acquire-lease") {
    throw new Error("Readiness executor-offline settlement requested a Merge Lease");
  }
  if (application.outcome.value.applied) {
    if (settlement.kind === "stop") result.stopped += 1;
    else result.requeued += 1;
  }
  return application;
};

export type ClaimedReadiness = {
  claimed: true;
  readiness: ReadinessCandidate;
  regression: ReadinessRegression;
  recovery: RecoveryContext | null;
  claim: ReadinessClaimHandle;
  input: ReadinessInput;
};

export type ReadinessRead = ClaimedReadiness | { claimed: false; input: ReadinessInput };

/** Unclaimed facts used by the train path to order all eligible evidence before
 * its claim/work budget is applied. */
export type ReadinessDiscovery = {
  input: ReadinessInput;
  evidenceCreatedAt: Date | null;
};

const decisionContext = (readiness: ReadinessCandidate, now: Date) => ({
  readiness: {
    id: readiness.id,
    chainId: readiness.chainId,
    projectId: readiness.projectId,
    repoId: readiness.repoId,
  },
  now,
});

const discoverReadiness = async (
  db: PrismaClient,
  readiness: ReadinessCandidate,
  now: Date,
): Promise<ReadinessDiscovery> => {
  const context = decisionContext(readiness, now);
  try {
    const regression = await db.task.findFirst({
      where: {
        projectId: readiness.projectId,
        chainId: readiness.chainId,
        templateId: readiness.templateId,
        templateStep: { outputKind: { in: [...REGRESSION_VERIFICATION_OUTPUT_KINDS] } },
      },
      include: READINESS_REGRESSION_INCLUDE,
    });
    if (!regression || regression.status !== TaskStatus.DONE) {
      return { input: { ...context, stage: "regression-pending" }, evidenceCreatedAt: null };
    }
    if (!regression.stepOutput) {
      return { input: { ...context, stage: "missing-regression-evidence" }, evidenceCreatedAt: null };
    }
    const verdict = parseRegressionVerdict(regression.stepOutput.body, regression.stepOutput.kind);
    if (verdict.status !== "ok" || verdict.verdict.outcome !== "pass"
      || regression.stepOutput.commitSha !== verdict.verdict.headSha) {
      return { input: { ...context, stage: "invalid-regression-evidence" }, evidenceCreatedAt: null };
    }
    const target = await db.$transaction((tx) => resolveChainTarget(tx, readiness));
    return {
      input: {
        ...context,
        stage: "ready",
        regression: {
          headSha: verdict.verdict.headSha,
          baseHeadSha: verdict.verdict.baseHeadSha,
        },
        target,
        defaultBranch: readiness.repo?.defaultBranch ?? "main",
      },
      evidenceCreatedAt: regression.stepOutput.createdAt,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      input: { ...context, stage: "read-failed", failure: { kind: "unexpected", message } },
      evidenceCreatedAt: null,
    };
  }
};

const EXECUTOR_OFFLINE_REARMED = "executor-offline-rearmed";

/** Re-arm only the pair parked by this outage, under the Chain mutation lock. */
const rearmExecutorOffline = async (
  db: PrismaClient,
  readiness: ReadinessCandidate,
  regression: ReadinessRegression,
  now: Date,
): Promise<boolean> => {
  return db.$transaction(async (tx) => {
    await lockTaskMutationRows(tx, readiness.id);
    const tasks = await tx.task.findMany({ where: { id: { in: [readiness.id, regression.id] } } });
    if (tasks.length !== 2 || tasks.some((task) => task.status !== TaskStatus.REVIEW
      || task.failureReason !== readiness.failureReason)) return false;
    if (await tx.run.count({ where: {
      taskId: { in: [readiness.id, regression.id] }, status: { in: [...ACTIVE_RUN_STATUSES] },
    } })) return false;
    const recovery = await tx.mergeRecoveryAttempt.findFirst({ where: {
      readinessTaskId: readiness.id, regressionTaskId: regression.id,
      recoveryRunId: regression.runs[0]?.id ?? null,
      status: MergeRecoveryStatus.BLOCKED_DOWNSTREAM, failureReason: readiness.failureReason,
    }, orderBy: [{ attempt: "desc" }, { id: "desc" }] });
    if (recovery) {
      await transitionMergeRecovery(tx, recovery.id, MergeRecoveryStatus.REPAIRING, {
        failureReason: null, endedAt: null,
      });
    }
    await tx.task.update({
      where: { id: readiness.id },
      data: { status: TaskStatus.TODO, failureReason: null, readinessClaimToken: null, readinessClaimExpiresAt: null },
    });
    await tx.task.update({
      where: { id: regression.id },
      data: { status: TaskStatus.DONE, failureReason: null, readinessClaimToken: null, readinessClaimExpiresAt: null },
    });
    await tx.taskActivity.create({ data: {
      taskId: readiness.id,
      actorType: "control-plane",
      body: "Merge executor observed online; executor-offline ceiling stop exited, readiness returned to TODO and existing Regression evidence restored to DONE without a new Run",
      metadata: { kind: MERGE_TAIL_KIND.readiness, state: EXECUTOR_OFFLINE_REARMED,
        regressionTaskId: regression.id, regressionOutputId: regression.stepOutput?.id ?? null },
    } });
    await tx.inboxMessage.updateMany({ where: {
      taskId: { in: [readiness.id, regression.id] }, status: "OPEN",
      body: { contains: readiness.failureReason! },
      OR: [
        { dedupeKey: { startsWith: `merge-readiness-stop:${readiness.id}:` } },
        { dedupeKey: { startsWith: "merge-tail-stop:" } },
        ...(recovery ? [{ dedupeKey: {
          equals: `merge-base-drift-recovery-tail-stop:${recovery.sourceStopId}:readiness:${recovery.recoveryRunId}`,
        } }] : []),
      ],
    }, data: { status: "CLOSED", answeredAt: now } });
    return true;
  });
};

const readReadiness = async (
  db: PrismaClient,
  readiness: ReadinessCandidate,
  now: Date,
  daemons: DaemonSnapshotReader,
): Promise<ReadinessRead> => {
  const context = decisionContext(readiness, now);
  const regression = await db.task.findFirst({
    where: {
      projectId: readiness.projectId,
      chainId: readiness.chainId,
      templateId: readiness.templateId,
      templateStep: { outputKind: { in: [...REGRESSION_VERIFICATION_OUTPUT_KINDS] } },
    },
    include: READINESS_REGRESSION_INCLUDE,
  });
  if (readiness.status === TaskStatus.REVIEW) {
    if (executorsBlockingAuthorization(daemons).length !== 0 || !regression
      || !readiness.failureReason?.startsWith(`${MERGE_EXECUTOR_OFFLINE_REASON}:`)
      || !await rearmExecutorOffline(db, readiness, regression, now)) {
      return { claimed: false, input: { ...context, stage: "regression-pending" } };
    }
    regression.status = TaskStatus.DONE;
    readiness = { ...readiness, status: TaskStatus.TODO, failureReason: null };
  }

  if (!regression || regression.status !== TaskStatus.DONE) {
    // Read first: skipped Steps without an open episode need no mutation fence.
    if (mergeExecutorRunnerIds().length > 0
      && executorsBlockingAuthorization(daemons).length === 0
      && openEpisodeStart(await latestExecutorOfflineMarker(db, readiness.id)) !== null) {
      const claim = await claimReadinessStep(db, readiness.id, now);
      if (claim) {
        await closeExecutorOfflineEpisode(db, readiness.id, claim, "executor observed online on a skipped tick");
        await db.$transaction((tx) => claim.settle(tx, {
          kind: "finish", at: now,
          apply: async (client) => {
            await client.task.update({ where: { id: readiness.id }, data: { status: TaskStatus.TODO } });
            return { value: null, ownership: "released" };
          },
        }));
      }
    }
    return { claimed: false, input: { ...context, stage: "regression-pending" } };
  }
  const claim = await claimReadinessStep(db, readiness.id, now);
  if (!claim) return { claimed: false, input: { ...context, stage: "claim-lost" } };

  let recovery: RecoveryContext | null = null;
  try {
    const recoveryRead = await recoveryContextFor(db, regression.id, readiness.id, regression.runs[0]?.id ?? null);
    recovery = recoveryRead?.context ?? null;
    const claimedRead = (input: ReadinessInput): ClaimedReadiness => ({
      claimed: true,
      readiness,
      regression,
      recovery,
      claim,
      input,
    });
    if (recovery && recoveryRead?.status === MergeRecoveryStatus.REPAIRING) {
      const transition = await db.$transaction((tx) => claim.settle(tx, {
        kind: "keep",
        apply: async (client) => awaitAuthorization(client, recovery!),
      }));
      if (!transition.settled) {
        return { claimed: false, input: { ...context, stage: "claim-lost" } };
      }
    }
    if (!regression.stepOutput) {
      return claimedRead({ ...context, stage: "missing-regression-evidence" });
    }
    const verdict = parseRegressionVerdict(regression.stepOutput.body, regression.stepOutput.kind);
    if (verdict.status !== "ok" || verdict.verdict.outcome !== "pass"
      || regression.stepOutput.commitSha !== verdict.verdict.headSha) {
      return claimedRead({ ...context, stage: "invalid-regression-evidence" });
    }
    const target = await db.$transaction((tx) => resolveChainTarget(tx, readiness));
    return claimedRead({
      ...context,
      stage: "ready",
      regression: {
        headSha: verdict.verdict.headSha,
        baseHeadSha: verdict.verdict.baseHeadSha,
      },
      target,
      defaultBranch: readiness.repo?.defaultBranch ?? "main",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      claimed: true,
      readiness,
      regression,
      recovery,
      claim,
      input: { ...context, stage: "read-failed", failure: { kind: "unexpected", message } },
    };
  }
};

const deferReadinessSettlement = (
  readinessTaskId: string,
  regressionTaskId: string,
  now: Date,
): ReadinessSettlement => readinessSettlement("defer", {
  taskId: regressionTaskId,
  at: now,
  apply: async (tx) => {
    await tx.task.update({
      where: { id: readinessTaskId },
      data: { status: TaskStatus.TODO, failureReason: null },
    });
    return {
      ownership: "released",
      leaseOutcome: { kind: "stop", taskId: regressionTaskId },
    };
  },
});

const recordLeaseDeferral = async (
  db: PrismaClient,
  input: {
    readinessTaskId: string;
    chainId: string | null;
    detail: string;
    at: Date;
  },
  claim: ReadinessClaimHandle,
): Promise<boolean> => db.$transaction(async (tx) => {
  const settlement = await claim.settle(tx, {
    kind: "keep",
    apply: async (client) => client.taskActivity.create({ data: {
      taskId: input.readinessTaskId,
      actorType: "control-plane",
      body: `Merge lease transport deferred: ${input.detail}`,
      metadata: {
        kind: MERGE_TAIL_KIND.readiness,
        state: "lease-transport-deferred",
        chainId: input.chainId,
        detail: input.detail,
        retryAfter: new Date(input.at.getTime() + READINESS_CLAIM_LEASE_MS).toISOString(),
      },
    } }),
  });
  return settlement.settled;
});

const heldLeaseOutcome = (ownership: ReadinessLeaseOwnership, taskId: string): HeldLeaseOutcome => ownership === "released"
  ? { kind: "stop", taskId }
  : { kind: "continue" };

const authorizeReadinessSettlement = (
  read: ClaimedReadiness,
  decision: Extract<ReadinessDecision, { kind: "authorize" }>,
  train?: TrainAuthorization,
): ReadinessSettlement => {
  const { readiness, regression, recovery } = read;
  return readinessSettlement("authorize", {
    taskId: regression.id,
    at: read.input.now,
    apply: async (tx) => {
      const currentReadiness = await tx.task.findUniqueOrThrow({
        where: { id: readiness.id },
        select: {
          id: true,
          projectId: true,
          chainId: true,
          chainIndex: true,
          approvalGate: true,
          templateStep: {
            select: {
              stepIndex: true,
              outputKind: true,
              taskTemplate: { select: { name: true } },
            },
          },
        },
      });
      // A gated readiness task may be released only by an operator decision
      // bound to the exact Regression evidence. A train independently verifies
      // its publication base; ordinary settlement keeps the second-read binding.
      // The check is inside the transaction so a stale approval cannot race the
      // status transition or manufacture a mechanical authorization path.
      if (isGatedMergeReadinessTask(currentReadiness)) {
        await requireMergeGateAuthorization(tx, {
          taskId: readiness.id,
          headSha: train && read.input.stage === "ready" ? read.input.regression.headSha : decision.evidence.headSha,
          baseSha: train && read.input.stage === "ready" ? read.input.regression.baseHeadSha : decision.evidence.baseSha,
        });
      }
      await tx.task.update({
        where: { id: readiness.id },
        data: { status: TaskStatus.DONE, failureReason: null },
      });
      const binding = `mechanical:${readiness.id}:${randomUUID()}`;
      const payload = {
        ...decision.evidence,
        ...(train ? { train } : {}),
        mergeMethod: AUTHORIZED_MERGE_METHOD,
        issuedAt: decision.issuedAt,
        decision: {
          channel: "mechanical" as const,
          inboxDecisionId: binding,
          inboxMessageId: binding,
        },
      };
      if (recovery) {
        // Recovery regression merges the current base before it proves the
        // candidate, so its gated head may legitimately replace the head that
        // first stopped on base drift. Adopt only the head re-read under the
        // merge Lease and bind the CAS to the pre-Lease recovery snapshot.
        try {
          await adoptRecoveryHead(tx, {
            recovery,
            currentBaseSha: decision.evidence.baseSha,
            authorizedHeadSha: decision.evidence.headSha,
          });
        } catch (error: unknown) {
          if (!await recoveryHeadAdoptionSnapshotChanged(tx, recovery)) throw error;
          throw new MergeRecoveryRefusalError(MergeRecoveryRefusalCode.HEAD_ADOPTION_CONFLICT, error);
        }
      }
      const activity = await tx.taskActivity.create({ data: {
        taskId: readiness.id,
        actorType: "control-plane",
        body: `Mechanical merge authorized for PR #${decision.prNumber} at ${decision.evidence.headSha}`,
        metadata: {
          ...authorizationMetadata(payload),
          recoverySourceStopId: recovery?.sourceStopId ?? null,
        } as Prisma.InputJsonObject,
      } });
      await tx.taskStepOutput.upsert({
        where: { taskId: readiness.id },
        create: {
          taskId: readiness.id,
          kind: "merge-authorization",
          body: JSON.stringify({
            authorizationActivityId: activity.id,
            headSha: decision.evidence.headSha,
            ...(train ? { train } : {}),
          }),
          commitSha: decision.evidence.headSha,
        },
        update: {
          kind: "merge-authorization",
          body: JSON.stringify({
            authorizationActivityId: activity.id,
            headSha: decision.evidence.headSha,
            ...(train ? { train } : {}),
          }),
          commitSha: decision.evidence.headSha,
        },
      });
      await tx.task.update({ where: { id: regression.id }, data: { failureReason: null } });
      if (decision.auditTriggers.length > 0) {
        await openDefenseAuditNotice(tx, {
          readinessTaskId: readiness.id,
          headSha: decision.headSha,
          baseSha: decision.baseSha,
          triggers: decision.auditTriggers,
        });
      }
      await writeMarker(tx, readiness.id, "readiness", {
        actorType: "control-plane",
        body: `Merge readiness authorized exact head ${decision.evidence.headSha}; merge execution queued`,
        metadata: {
          state: "authorized",
          headSha: decision.evidence.headSha,
          authorizationActivityId: activity.id,
          recoverySourceStopId: recovery?.sourceStopId ?? null,
        },
      });
      let activated: { nextTaskId: string | null; gated: boolean };
      if (recovery) {
        const recoveryActivation = await activateRecoveryIntegratorSuccessor(tx, {
          readinessTaskId: readiness.id,
          integratorTaskId: recovery.integratorTaskId,
          sourceStopId: recovery.sourceStopId,
          recoveryRunId: recovery.recoveryRunId,
          authorizationActivityId: activity.id,
        }, read.input.now);
        if (recoveryActivation.outcome === "refused") {
          throw new MergeRecoveryRefusalError(recoveryActivation.refusalCode);
        }
        // A Hold on the integrator's layer refused the Run birth, not the
        // authorization: it is written, and the aggregate now carries the
        // pending intent `chain/resume` replays. Settle this tick with no
        // successor and no handoff, so the readiness Lease is released rather
        // than retained for a Run that does not exist.
        activated = recoveryActivation.outcome === "withheld"
          ? { nextTaskId: null, gated: false }
          : recoveryActivation;
      } else {
        activated = await activateChainSuccessor(tx, readiness, {}, read.input.now);
      }
      const handoff = activated.nextTaskId
        ? await tx.run.findFirst({
          where: { taskId: activated.nextTaskId, status: RunStatus.QUEUED },
          select: { id: true },
          orderBy: { runNumber: "desc" },
        })
        : null;
      return handoff
        ? {
          ownership: { retainFor: handoff.id },
          leaseOutcome: {
            kind: "hand-off",
            taskId: regression.id,
            handoffRunId: handoff.id,
            at: read.input.now,
          },
        }
        : { ownership: "released", leaseOutcome: { kind: "continue" } };
    },
  });
};

type ReadinessDecisionHandlers<T> = {
  [Kind in ReadinessDecision["kind"]]: (
    decision: Extract<ReadinessDecision, { kind: Kind }>,
  ) => T;
};

const dispatchReadinessDecision = <T>(
  decision: ReadinessDecision,
  handlers: ReadinessDecisionHandlers<T>,
): T => {
  const handler = handlers[decision.kind] as unknown as (
    selected: ReadinessDecision,
  ) => T;
  return handler(decision);
};

const applyReadinessDecision = async (
  read: ClaimedReadiness,
  decision: ReadinessDecision,
  result: ReadinessTickResult,
  runner: ReadinessSettlementRunner,
  trainWidth: number,
): Promise<ReadinessSettlementApplication> => {
  const { readiness, regression, recovery, claim } = read;
  const selectedDecision = trainWidth > 0 && decision.kind === "requeue-regression"
    && decision.condition === "base-advanced"
    ? { kind: "defer" as const, reason: "Base advanced; candidate will join a merge train" }
    : decision;
  return dispatchReadinessDecision(selectedDecision, {
    skip: () => Promise.resolve(runner.skip(regression.id)),
    defer: () => runner.apply(
      deferReadinessSettlement(readiness.id, regression.id, new Date()),
      claim,
    ),
    stop: async (stopping) => {
      const application = await runner.apply(stopReadinessSettlement({
        readinessTaskId: readiness.id,
        regressionTaskId: regression.id,
        reason: stopping.evidence,
        recovery,
        refusalCode: null,
        now: new Date(),
      }), claim);
      if (application.kind === "settled" && application.outcome.value.applied) {
        result.stopped += 1;
      }
      return application;
    },
    "requeue-regression": async (requeue) => {
      const application = await runner.apply(requeueRegressionSettlement({
        readinessTaskId: readiness.id,
        regressionTaskId: regression.id,
        ...requeue,
        now: read.input.now,
        recovery,
      }), claim);
      if (application.kind === "settled" && application.outcome.value.applied) {
        if (application.outcome.value.stopped) result.stopped += 1;
        else result.requeued += 1;
      }
      return application;
    },
    authorize: async (authorization) => {
      return runner.apply(
        authorizeReadinessSettlement(read, authorization),
        claim,
      );
    },
  });
};

/**
 * Contention bookkeeping is what the tick reports, not what it depends on: the
 * lease is held either way and this chain comes back on the next tick. A failed
 * write is said out loud here rather than raised, because the readiness catch
 * below stops the merge tail, and losing visibility of a contention must not
 * also stop the chain that reported it.
 */
const recordContention = async (
  db: PrismaClient,
  input: {
    target: MergeLeaseTarget | null;
    readinessTaskId: string;
    holder: MergeLeaseHolder | null;
    now: Date;
    claim: ReadinessClaimHandle;
  },
): Promise<void> => {
  if (!input.target) return;
  try {
    await noteLeaseContention(db, {
      target: input.target,
      readinessTaskId: input.readinessTaskId,
      holder: input.holder,
      now: input.now,
      claim: input.claim,
    });
  } catch (error: unknown) {
    console.error(`Recording merge Lease contention for chain ${input.target.chainId} failed`, error);
  }
};

const forgetContention = async (
  db: PrismaClient,
  target: MergeLeaseTarget | null,
  readinessTaskId: string,
  now: Date,
  claim: ReadinessClaimHandle,
): Promise<void> => {
  if (!target) return;
  try {
    await clearLeaseContention(db, { target, readinessTaskId, now, claim });
  } catch (error: unknown) {
    console.error(`Clearing merge Lease contention for chain ${target.chainId} failed`, error);
  }
};

const runReadinessDecision = async (
  db: PrismaClient,
  read: ClaimedReadiness,
  decision: ReadinessDecision,
  result: ReadinessTickResult,
  releaseChainLease: ReleaseMergeLease,
  runWithMergeLease: WithMergeLease,
  reader: PullRequestReader,
  daemons: DaemonSnapshotReader,
  trainWidth: number,
): Promise<void> => {
  const { readiness, regression, claim } = read;
  const preAcquireRunner = createReadinessSettlementRunner(db, {
    kind: "pre-acquire",
    release: releaseChainLease,
  });
  const target: MergeLeaseTarget | null = readiness.chainId
    ? { projectId: readiness.projectId, chainId: readiness.chainId }
    : null;

  // An authorization nobody can claim is a base-drift stop waiting to happen,
  // so it is refused rather than written and left standing: the chain waits at
  // readiness while its executor is down. The check that decides is the one
  // under the Lease, below; this one only spares an outage the cost of taking
  // a Lease every tick, exactly as the pre-acquire read spares a base move one.
  // Settling here also ends the contention episode below.
  const blockedExecutors = executorsBlockingAuthorization(daemons);
  if (decision.kind === "authorize" && blockedExecutors.length > 0) {
    await forgetContention(db, target, readiness.id, read.input.now, claim);
    await settleExecutorOffline(db, read, blockedExecutors, result, preAcquireRunner);
    return;
  }

  const regressionWillRequeue = decision.kind === "requeue-regression"
    && !(trainWidth > 0 && decision.condition === "base-advanced");
  if (blockedExecutors.length === 0 || regressionWillRequeue || decision.kind === "stop") {
    await closeExecutorOfflineEpisode(db, readiness.id, claim,
      blockedExecutors.length === 0 ? "executor observed online" : `readiness ${decision.kind}`);
  }

  // The alert window measures continuous contention, so anything other than
  // another refusal breaks the run. Only an authorization reaches for the
  // Lease; a skip, deferral, requeue or stop settles before it and ends the
  // episode here, while this Handle still owns the Step -- a settling
  // transition clears the claim, and the fenced write would then be refused.
  if (decision.kind !== "authorize") {
    await forgetContention(db, target, readiness.id, read.input.now, claim);
  }

  const application = await applyReadinessDecision(
    read,
    decision,
    result,
    preAcquireRunner,
    trainWidth,
  );
  if (application.kind === "settled") return;

  // From the base this authorization pins to the merge that consumes it,
  // `main` must not move. The Handle records the successor Run before its
  // transition can return retained Lease ownership.
  const leased = await runWithMergeLease(target, async () => {
    if (!await claim.renew()) {
      const ownership = await claim.ownershipAfterLoss(db);
      return { leaseOutcome: heldLeaseOutcome(ownership, regression.id), value: "claim-lost" as const };
    }

    // Taking the Lease is the answer other than contention that ends the
    // episode, and it is recorded here rather than after the window closes:
    // the settlement below may be the terminal transition, which clears the
    // claim this write is fenced by.
    await forgetContention(db, target, readiness.id, read.input.now, claim);

    // Regression evidence is durable before this short Lease window. Repeat
    // the remote decision after acquisition so a base move between the first
    // read and the Lease cannot authorize stale evidence.
    const heldRunner = createReadinessSettlementRunner(db, {
      kind: "held",
      release: releaseChainLease,
    });
    const leasedDecision = await evaluateReadiness(reader, read.input);

    // Repeat the liveness read too, for the same reason: an executor that went
    // down while this tick was acquiring the Lease and re-reading GitHub must
    // not have an authorization written for it. This is the read that decides.
    const leasedBlockedExecutors = executorsBlockingAuthorization(daemons);
    if (leasedBlockedExecutors.length === 0) {
      await closeExecutorOfflineEpisode(db, readiness.id, claim, "executor observed online under the Merge Lease");
    }
    if (leasedDecision.kind === "authorize" && leasedBlockedExecutors.length > 0) {
      const settlement = await settleExecutorOffline(
        db,
        read,
        leasedBlockedExecutors,
        result,
        heldRunner,
      );
      return { leaseOutcome: settlement.outcome.leaseOutcome, value: "settled" as const };
    }

    const leasedApplication = await applyReadinessDecision(
      read,
      leasedDecision,
      result,
      heldRunner,
      trainWidth,
    );
    if (leasedApplication.kind === "acquire-lease") {
      throw new Error("Held readiness settlement requested another Merge Lease");
    }
    const value = leasedDecision.kind === "authorize" && leasedApplication.outcome.value.applied
      ? "authorized" as const
      : "settled" as const;
    return {
      leaseOutcome: leasedApplication.outcome.leaseOutcome,
      value,
    };
  }, db);
  if (leased.outcome === "contended") {
    await recordContention(db, {
      target,
      readinessTaskId: readiness.id,
      holder: leased.holder ?? null,
      now: read.input.now,
      claim,
    });
    return;
  }
  if (leased.outcome === "unreachable") {
    // An origin this tick could not reach is not another refusal by the holder,
    // so it breaks the run of contended results the window counts.
    await forgetContention(db, target, readiness.id, read.input.now, claim);
    if (!leased.releaseDeferred) {
      await recordLeaseDeferral(db, {
        readinessTaskId: readiness.id,
        chainId: readiness.chainId,
        detail: leased.detail,
        at: read.input.now,
      }, claim);
    }
    return;
  }
  // The remaining outcome is a Lease this tick took: the episode was already
  // ended inside the window, above, while the claim was still ours.
  if (leased.value === "authorized") result.authorized += 1;
};

const runReadinessDecisionSafely = async (
  db: PrismaClient,
  read: ClaimedReadiness,
  decision: ReadinessDecision,
  result: ReadinessTickResult,
  releaseChainLease: ReleaseMergeLease,
  runWithMergeLease: WithMergeLease,
  reader: PullRequestReader,
  daemons: DaemonSnapshotReader,
  trainWidth: number,
): Promise<void> => {
  const { readiness } = read;
  try {
    await runReadinessDecision(
      db,
      read,
      decision,
      result,
      releaseChainLease,
      runWithMergeLease,
      reader,
      daemons,
      trainWidth,
    );
  } catch (error: unknown) {
    if (error instanceof LeaseReleaseDeferralRecordError) throw error;
    const refusalCode = error instanceof MergeRecoveryRefusalError ? error.refusalCode : null;
    const message = error instanceof Error ? error.message : String(error);
    // A refusal is a decision and stops the tail on its first occurrence. So
    // is a missing or mismatched operator authorization: the gate is
    // fail-closed, and retrying it would re-ask the same settled question
    // three more times. An unexpected exception is neither: the stop it would
    // write carries no review-fail or gate-fail verdict, so
    // `merge-tail/repair` refuses to re-enter it and only a manual delivery
    // finishes the branch. A killed child or a restarted deploy therefore
    // costs one requeue of the readiness Step, bounded so a permanent fault
    // still reaches an operator.
    const decided = refusalCode !== null || error instanceof MergeGateAuthorizationError;
    const spent = decided
      ? 0
      : await spentExceptionRequeues(db, read.regression.id, read.recovery);
    const requeuing = !decided && spent < readinessExceptionRequeueLimit();
    // Stopping the tail is not another refusal by the holder either, and the
    // settlement below releases the claim this write is fenced by.
    await forgetContention(
      db,
      readiness.chainId ? { projectId: readiness.projectId, chainId: readiness.chainId } : null,
      readiness.id,
      new Date(),
      read.claim,
    );
    if (!requeuing || executorsBlockingAuthorization(daemons).length === 0) {
      await closeExecutorOfflineEpisode(db, readiness.id, read.claim,
        requeuing ? "executor observed online after an exception" : "readiness exception stop");
    }
    const runner = createReadinessSettlementRunner(db, {
      kind: "pre-acquire",
      release: releaseChainLease,
    });
    const settlement = requeuing
      ? requeueReadinessExceptionSettlement({
        readinessTaskId: readiness.id,
        regressionTaskId: read.regression.id,
        reason: `readiness evaluation exception: ${message}`,
        requeue: spent + 1,
        limit: readinessExceptionRequeueLimit(),
        recovery: read.recovery,
        now: new Date(),
      })
      : stopReadinessSettlement({
        readinessTaskId: readiness.id,
        regressionTaskId: read.regression.id,
        reason: spent === 0
          ? `readiness evaluation failed: ${message}`
          : `readiness evaluation failed after ${String(spent)} exception requeues: ${message}`,
        recovery: read.recovery,
        refusalCode,
        now: new Date(),
      });
    const settled = await runner.apply(settlement, read.claim);
    if (settled.kind === "acquire-lease") {
      throw new Error(`Readiness ${settlement.kind} requested a Merge Lease`);
    }
    if (settled.outcome.value.applied) {
      if (requeuing) result.requeued += 1;
      else result.stopped += 1;
    }
    // A failed release/hold recording can happen after stopMergeTail has
    // already committed its state transition. A second stop then returns
    // false and must not turn that failure into a successful-looking tick.
    // Surface it to the worker caller so the missing evidence is observable.
    if (!settled.outcome.value.applied) throw error;
  }
};

export const readinessTick = async (
  db: PrismaClient,
  reader: PullRequestReader,
  now: Date,
  limit: number,
  releaseChainLease: ReleaseMergeLease,
  runWithMergeLease: WithMergeLease,
  daemons: DaemonSnapshotReader,
  width: number = mergeTrainWidth(),
): Promise<ReadinessTickResult> => {
  const pendingTrains = width === 0 ? await pendingMergeTrains(db) : undefined;
  if (width > 0 || pendingTrains?.length) {
    return mergeTrainReadinessTick(db, reader, now, { width, limit }, releaseChainLease, runWithMergeLease, {
      candidates: readinessCandidates,
      discover: discoverReadiness,
      read: (database, task, at) => readReadiness(database, task, at, daemons),
      authorize: authorizeReadinessSettlement,
      refuse: (read, decision) => decision.kind === "stop"
        ? stopReadinessSettlement({ readinessTaskId: read.readiness.id, regressionTaskId: read.regression.id,
          reason: decision.evidence, recovery: read.recovery, refusalCode: null, now: read.input.now })
        : requeueRegressionSettlement({ readinessTaskId: read.readiness.id, regressionTaskId: read.regression.id,
          ...decision, recovery: read.recovery, now: read.input.now }),
      executor: {
        blocking: () => executorsBlockingAuthorization(daemons),
        closeEpisode: (tx, read) => closeExecutorOfflineEpisodeTx(tx, read.readiness.id, read.claim, "executor observed online under the train Lease"),
        settleOffline: async (tx, read, executorRunnerIds) => {
          const settlement = await executorOfflineSettlement(tx, read, executorRunnerIds);
          const applied = await settlement.body(tx, read.claim);
          if (!applied.value.applied) throw new Error(`Merge train readiness claim lost for ${read.readiness.id}`);
          return settlement.kind === "stop" ? "stopped" : "ready";
        },
      },
      single: (database, read, decision, result, release, lease, pullRequests) =>
        runReadinessDecisionSafely(database, read, decision, result, release, lease, pullRequests, daemons, width),
    }, pendingTrains);
  }
  const result: ReadinessTickResult = { claimed: 0, authorized: 0, requeued: 0, stopped: 0 };
  const pageSize = Math.max(limit * 20, 100);
  for await (const readiness of readinessCandidates(db, pageSize)) {
    if (result.claimed >= limit) break;
    if (!isMergeReadinessStep(readiness.templateStep)) continue;

    const read = await readReadiness(db, readiness, now, daemons);
    if (!read.claimed) continue;
    const decision = await evaluateReadiness(reader, read.input);
    result.claimed += 1;
    await runReadinessDecisionSafely(db, read, decision, result, releaseChainLease, runWithMergeLease, reader, daemons, width);
  }
  return result;
};

export const startReadinessWorker = (
  db: PrismaClient,
  reader: PullRequestReader,
  daemons: DaemonSnapshotReader,
  /** The width judged at startup; the ambient read is the fallback for callers
   * that construct a worker without a startup verdict. */
  width: number = mergeTrainWidth(),
): ReturnType<typeof setInterval> => {
  // Read once here so a misconfigured bound fails the service at startup rather
  // than inside the first tick that hits an exception.
  readinessExceptionRequeueLimit();
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void reopenRecoveryHeadAdoptionFailures(db)
      .then(() => readinessTick(
        db,
        reader,
        new Date(),
        5,
        releaseMergeLease,
        withMergeLease,
        daemons,
        width,
      ))
      .catch((error: unknown) => console.error("Merge readiness tick failed", error))
      .finally(() => {
        inFlight = false;
      });
  }, readinessPollIntervalMs());
  timer.unref?.();
  return timer;
};
