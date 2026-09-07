import { randomUUID } from "node:crypto";

import {
  AUTHORIZED_MERGE_METHOD,
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
  MERGE_TAIL_KIND,
  parseRegressionVerdict,
  readMarkerHistory,
  requireMergeGateAuthorization,
  REGRESSION_VERIFICATION_OUTPUT_KINDS,
  recordReadinessRequeue,
  recoveryContext,
  resolveChainTarget,
  writeMarker,
  type PrismaClient,
  type RecoveryContext,
} from "@anneal/db";

import { lockTaskMutationRows } from "./task-write.js";
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
type ReadinessCandidate = Prisma.TaskGetPayload<{ include: typeof READINESS_CANDIDATE_INCLUDE }>;
const READINESS_REGRESSION_INCLUDE = {
  stepOutput: true,
  runs: { orderBy: { runNumber: "desc" as const }, take: 1, select: { id: true } },
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
        status: { in: [TaskStatus.TODO, TaskStatus.DOING] },
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
    reason: string;
    now: Date;
    recovery: RecoveryContext | null;
  },
): ReadinessSettlement => readinessSettlement("requeue", {
  taskId: input.regressionTaskId,
  at: input.now,
  apply: async (tx) => {
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
        readinessRequeue: { staleBaseSha: input.staleBaseSha, reason: input.reason },
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
      const attempt = await requeueMergeTailRun(tx, input.regressionTaskId, input.now);
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

type ClaimedReadiness = {
  claimed: true;
  readiness: ReadinessCandidate;
  regression: ReadinessRegression;
  recovery: RecoveryContext | null;
  claim: ReadinessClaimHandle;
  input: ReadinessInput;
};

type ReadinessRead = ClaimedReadiness | { claimed: false; input: ReadinessInput };

const decisionContext = (readiness: ReadinessCandidate, now: Date) => ({
  readiness: {
    id: readiness.id,
    chainId: readiness.chainId,
    projectId: readiness.projectId,
    repoId: readiness.repoId,
  },
  now,
});

const readReadiness = async (
  db: PrismaClient,
  readiness: ReadinessCandidate,
  now: Date,
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
  if (!regression || regression.status !== TaskStatus.DONE) {
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
      // bound to the exact head/base this worker just re-verified. The check is
      // inside the settlement transaction so a stale approval cannot race the
      // status transition or manufacture a mechanical authorization path.
      if (isGatedMergeReadinessTask(currentReadiness)) {
        await requireMergeGateAuthorization(tx, {
          taskId: readiness.id,
          headSha: decision.evidence.headSha,
          baseSha: decision.evidence.baseSha,
        });
      }
      await tx.task.update({
        where: { id: readiness.id },
        data: { status: TaskStatus.DONE, failureReason: null },
      });
      const binding = `mechanical:${readiness.id}:${randomUUID()}`;
      const payload = {
        ...decision.evidence,
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
          }),
          commitSha: decision.evidence.headSha,
        },
        update: {
          kind: "merge-authorization",
          body: JSON.stringify({
            authorizationActivityId: activity.id,
            headSha: decision.evidence.headSha,
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
        activated = recoveryActivation;
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
): Promise<ReadinessSettlementApplication> => {
  const { readiness, regression, recovery, claim } = read;
  return dispatchReadinessDecision(decision, {
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
        result.requeued += 1;
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
): Promise<void> => {
  const { readiness, regression, claim } = read;
  const preAcquireRunner = createReadinessSettlementRunner(db, {
    kind: "pre-acquire",
    release: releaseChainLease,
  });
  const target: MergeLeaseTarget | null = readiness.chainId
    ? { projectId: readiness.projectId, chainId: readiness.chainId }
    : null;

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
    const leasedApplication = await applyReadinessDecision(
      read,
      leasedDecision,
      result,
      heldRunner,
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

export const readinessTick = async (
  db: PrismaClient,
  reader: PullRequestReader,
  now: Date,
  limit: number,
  releaseChainLease: ReleaseMergeLease,
  runWithMergeLease: WithMergeLease,
): Promise<ReadinessTickResult> => {
  const result: ReadinessTickResult = { claimed: 0, authorized: 0, requeued: 0, stopped: 0 };
  const exceptionRequeueLimit = readinessExceptionRequeueLimit();
  const pageSize = Math.max(limit * 20, 100);
  for await (const readiness of readinessCandidates(db, pageSize)) {
    if (result.claimed >= limit) break;
    if (!isMergeReadinessStep(readiness.templateStep)) continue;

    const read = await readReadiness(db, readiness, now);
    if (!read.claimed) continue;
    const decision = await evaluateReadiness(reader, read.input);
    result.claimed += 1;
    try {
      await runReadinessDecision(
        db,
        read,
        decision,
        result,
        releaseChainLease,
        runWithMergeLease,
        reader,
      );
    } catch (error: unknown) {
      if (error instanceof LeaseReleaseDeferralRecordError) throw error;
      const refusalCode = error instanceof MergeRecoveryRefusalError ? error.refusalCode : null;
      const message = error instanceof Error ? error.message : String(error);
      // A refusal is a decision and stops the tail on its first occurrence. An
      // unexpected exception is not: the stop it would write carries no
      // review-fail or gate-fail verdict, so `merge-tail/repair` refuses to
      // re-enter it and only a manual delivery finishes the branch. A killed
      // child or a restarted deploy therefore costs one requeue of the
      // readiness Step, bounded so a permanent fault still reaches an operator.
      const spent = refusalCode === null
        ? await spentExceptionRequeues(db, read.regression.id, read.recovery)
        : 0;
      const requeuing = refusalCode === null && spent < exceptionRequeueLimit;
      // Stopping the tail is not another refusal by the holder either, and the
      // settlement below releases the claim this write is fenced by.
      await forgetContention(
        db,
        readiness.chainId ? { projectId: readiness.projectId, chainId: readiness.chainId } : null,
        readiness.id,
        new Date(),
        read.claim,
      );
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
          limit: exceptionRequeueLimit,
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
  }
  return result;
};

export const startReadinessWorker = (
  db: PrismaClient,
  reader: PullRequestReader,
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
      ))
      .catch((error: unknown) => console.error("Merge readiness tick failed", error))
      .finally(() => {
        inFlight = false;
      });
  }, readinessPollIntervalMs());
  timer.unref?.();
  return timer;
};
