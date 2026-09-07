import { createHash } from "node:crypto";

import {
  ACTIVE_RUN_STATUSES,
  MERGE_EXECUTOR_OFFLINE_REASON,
  asJsonObject,
  errorForOpenRunRefusal,
  findCanonicalAgent,
  isIntegratorStep,
  isRegressionVerificationOutputKind,
  latestMarker,
  MAX_MERGE_TAIL_REPAIR_ATTEMPTS,
  MERGE_TAIL_KIND,
  MERGE_TAIL_SCHEMA_VERSION,
  type MergeRecoveryAttempt,
  mergeRecoveryTransitionAllowed,
  MergeRecoveryStatus,
  type Marker,
  openRun,
  parseResolverResult,
  parseRegressionVerdict,
  Prisma,
  readMarkerHistory,
  type RegressionVerdict,
  type RecoveryContext,
  recoveryContext,
  TaskStatus,
  writeMarker,
} from "@anneal/db";

import { FAILURE_REASON_LIMIT, truncateFailureReason } from "./failure-reason.js";
import { canonicalOutputRefusal } from "./canonical-task-output.js";
import type { LeaseOutcome } from "./merge-lease.js";
import type { RetryClass } from "./base-drift-recovery-decision.js";
import {
  awaitAuthorization,
  blockDownstream,
  exhaust,
  recoveryClassSettleState,
} from "./merge-tail-state.js";

/**
 * The autonomous merge tail's own actions: the base-drift recovery aggregate,
 * the repair and follow-up cards it opens, the notices it writes when it stops,
 * and the regression completion that decides between them.
 *
 * They live here rather than in `app.ts` because both `run-completion.ts` and
 * `app.ts` call them, and importing them back out of `app.ts` would be a cycle.
 */

type DbTx = Prisma.TransactionClient;

/** The canonical role a refresh conflict is routed to: no chain step owns that
 *  repair, so it has no staffed Agent to address. It is a role file name — the
 *  Agent's canonical identity under R9 — and never the operator-editable `name`
 *  column, so a renamed canonical Agent still answers. */
const MERGE_RESOLVER_ROLE = "merge-resolver-opus-medium";

/**
 * Who a repair card is assigned to: the Agent the chain already bound to its
 * fix step, or the canonical role that owns a repair no chain step does.
 */
export type MergeTailRepairAssignee =
  | Readonly<{ kind: "agent"; agentId: string; label: string }>
  | Readonly<{ kind: "role"; canonicalRole: string }>;

/** No Agent the chain staffed owns this repair. The tail stops rather than
 *  inventing one; `reason` is the stop reason an operator reads. */
export type MergeTailRepairUnstaffed = Readonly<{ kind: "unstaffed"; reason: string }>;

/**
 * Records the platform-owned requeue that earns one additional attempt for a
 * merge-tail target. The marker is bound to the Run created by that requeue so
 * a later operator retry cannot accidentally propagate the grant downstream.
 */
export const recordMergeTailRequeue = async (
  tx: DbTx,
  input: { taskId: string; runId: string; recoverySourceRunId?: string },
): Promise<void> => {
  await writeMarker(tx, input.taskId, "requeue", {
    actorType: "control-plane",
    body: `Merge-tail target requeued with one budget grant (Run ${input.runId})`,
    metadata: {
      runId: input.runId,
      ...(input.recoverySourceRunId === undefined
        ? {}
        : { recoverySourceRunId: input.recoverySourceRunId }),
    },
  });
};

export type MergeTailRequeueContext = { recoverySourceRunId: string | null };

export const mergeTailRequeueContextForRun = async (
  tx: DbTx,
  input: { taskId: string; runId: string },
): Promise<MergeTailRequeueContext | null> => {
  const row = await tx.taskActivity.findFirst({
    where: {
      taskId: input.taskId,
      actorType: "control-plane",
      AND: [
        { metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.requeue } },
        { metadata: { path: ["schemaVersion"], equals: MERGE_TAIL_SCHEMA_VERSION } },
        { metadata: { path: ["runId"], equals: input.runId } },
      ],
    },
    select: { metadata: true },
  });
  const metadata = asJsonObject(row?.metadata);
  if (metadata?.kind !== MERGE_TAIL_KIND.requeue
    || metadata.schemaVersion !== MERGE_TAIL_SCHEMA_VERSION
    || metadata.runId !== input.runId) return null;
  return {
    recoverySourceRunId: typeof metadata.recoverySourceRunId === "string"
      ? metadata.recoverySourceRunId
      : null,
  };
};

/**
 * Qualifies the durable authority for a Documentation-to-Regression grant.
 * Activity metadata authored by agents or operators is never control-plane
 * authority, and an exact Run binding avoids propagating a prior requeue.
 */
type RegressionTaskIdentity = {
  id: string;
  templateStep?: {
    stepIndex?: number;
    outputKind: string;
    taskTemplate?: { name: string };
  } | null | undefined;
};

export type RegressionVerdictQualification =
  | { status: "ok"; verdict: RegressionVerdict; headSha: string }
  | { status: "refused"; reason: string };

/**
 * Read and qualify the one Regression artifact that can control this Run.
 * Completion supplies its reported head; reconciliation may fall back to the
 * output's authored commit because no completion payload exists after a hard
 * lease loss. A persisted Run head, when present, always remains authoritative.
 */
export const regressionVerdictForRun = async (
  tx: DbTx,
  input: {
    task: RegressionTaskIdentity;
    runId: string;
    runHeadSha: string | null;
    allowPersistedHeadWhenUnreported?: boolean;
  },
): Promise<RegressionVerdictQualification> => {
  const output = await tx.taskStepOutput.findUnique({ where: { taskId: input.task.id } });
  const exactHead = input.runHeadSha
    ?? (input.allowPersistedHeadWhenUnreported ? output?.commitSha ?? null : null);
  const canonicalRefusal = canonicalOutputRefusal(input.task.templateStep, output, input.runId, exactHead);
  if (canonicalRefusal) return { status: "refused", reason: canonicalRefusal };
  if (!output) return { status: "refused", reason: "missing regression output" };
  if (output.runId !== input.runId) {
    return { status: "refused", reason: `regression output belongs to prior Run ${output.runId ?? "none"}, not current Run ${input.runId}` };
  }
  if (input.task.templateStep && output.kind !== input.task.templateStep.outputKind) {
    return { status: "refused", reason: `task output kind ${output.kind} does not match Regression kind ${input.task.templateStep.outputKind}` };
  }
  if (!exactHead || output.commitSha !== exactHead) {
    return {
      status: "refused",
      reason: `stale regression evidence: output ${output.commitSha ?? "missing"}, run ${exactHead ?? "missing"}`,
    };
  }
  const parsed = parseRegressionVerdict(output.body, output.kind);
  if (parsed.status === "invalid") return { status: "refused", reason: parsed.reason };
  if (parsed.verdict.headSha !== exactHead) {
    return {
      status: "refused",
      reason: `stale regression evidence: verdict ${parsed.verdict.headSha}, output ${output.commitSha}, run ${exactHead}`,
    };
  }
  return { status: "ok", verdict: parsed.verdict, headSha: exactHead };
};

/**
 * The notice the tail writes when it stops, keyed by task and reason.
 *
 * Stopping twice for the same reason is a legitimate event: an operator retry
 * re-queues the run, the claim path judges the same handoff invalid again, and
 * the stop path runs again. Under `create` that repeat raised P2002 inside the
 * caller's transaction, which rolled the whole stop back -- and in the claim
 * path took every other queued run's claim down with it. The notice is a
 * digest, not a log: one row per (task, reason) is the intended state, so a
 * repeat leaves the existing row alone.
 */
export const openMergeTailStopNotice = async (
  tx: DbTx,
  input: { taskId: string; agentId: string; sessionId?: string; reason: string },
): Promise<void> => {
  const dedupeKey = `merge-tail-stop:${input.taskId}:${createHash("sha256").update(input.reason).digest("hex")}`;
  await tx.inboxMessage.upsert({ where: { dedupeKey }, create: {
    from: "AGENT",
    agentId: input.agentId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    taskId: input.taskId,
    kind: "TEXT",
    body: `Autonomous merge tail stopped: ${input.reason}`,
    dedupeKey,
  }, update: {} });
};

/**
 * The audit trail a merge leaves when its diff moved defence-list paths.
 *
 * The merge is not held for it: the message records what moved and why the path
 * is on the list, so the change is reviewable after the fact rather than
 * blocking beforehand. Keyed by readiness task and exact head, and upserted for
 * the same reason the stop notice is — a readiness tick that re-evaluates the
 * same head must not raise P2002 inside its caller's transaction.
 */
export const openDefenseAuditNotice = async (
  tx: DbTx,
  input: {
    readinessTaskId: string;
    headSha: string;
    baseSha: string;
    triggers: Array<{ path: string; reason: string }>;
  },
): Promise<void> => {
  const dedupeKey = `defense-audit:${input.readinessTaskId}:${input.headSha}`;
  const body = [
    "Merge proceeded with defense-list changes",
    `Exact range ${input.baseSha}..${input.headSha}.`,
    input.triggers.map((trigger) => `- ${trigger.path} (${trigger.reason})`).join("\n"),
  ].join("\n\n");
  await tx.inboxMessage.upsert({ where: { dedupeKey }, create: {
    from: "AGENT",
    taskId: input.readinessTaskId,
    kind: "TEXT",
    body,
    dedupeKey,
  }, update: {} });
};

export const baseDriftRecoveryContext = async (
  tx: DbTx,
  regressionTaskId: string,
  recoveryRunId?: string,
  sourceStopId?: string,
): Promise<RecoveryContext | null> => {
  const row = await tx.mergeRecoveryAttempt.findFirst({
    where: {
      regressionTaskId,
      status: { in: [MergeRecoveryStatus.REPAIRING, MergeRecoveryStatus.AWAITING_AUTHORIZATION] },
      ...(recoveryRunId ? { recoveryRunId } : {}),
      ...(sourceStopId ? { sourceStopId } : {}),
    },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  return recoveryContext(row);
};

/** The name every binding-mismatch reason carries, so one grep finds the state
 *  on a Task, on a Run, in an activity feed and in a completion response. */
export const MERGE_TAIL_REPAIR_BINDING_MISMATCH = "merge-tail-repair-binding-mismatch";

/** The TaskActivity kind that makes two overlapping merge-tail mechanisms
 *  visible on the Regression task without reading the API journal. */
export const MERGE_TAIL_REPAIR_BINDING_MISMATCH_KIND = "mergeTailRepair.bindingMismatch";

/**
 * A repair the platform cannot settle: the chain's recovery aggregate does not
 * name the Run being repaired. It carries the three ids that identify the
 * overlap — the recovery, the Run it is bound to, and the Run repaired — plus
 * the recovery context needed to park the tail, when the aggregate still has a
 * complete one.
 */
export type RepairBindingMismatch = {
  reason: string;
  recoveryId: string;
  /** The Run the recovery is bound to: the aggregate's `recoveryRunId` column,
   *  which is the value this invariant compares. */
  boundRecoveryRunId: string | null;
  /** The Run the recovery was opened from: the aggregate's own
   *  `boundSourceRunId` column. This invariant does not compare it, and it
   *  holds a different Run — it is recorded so one activity names both
   *  mechanisms' Runs, and so a reader joining against the column of that name
   *  gets the column's own value. */
  boundSourceRunId: string | null;
  repairedRunId: string;
  /** Present only for a complete aggregate that may still be blocked for
   *  operator reentry; a mismatch found on an incomplete or already-terminal
   *  aggregate carries none and stops at the notice. */
  blockable: RecoveryContext | null;
};

/** Whether a genuine repair completion belongs to an active recovery. No
 * aggregate means this is an ordinary merge-tail repair. Once an aggregate
 * exists, incomplete or stale identity is a state the platform produced and
 * must classify: it used to throw a bare `Error` out of `completeRun`'s
 * transaction, which answered the runner 500 and stranded a repair that had
 * already committed its work. */
export type RepairRecoveryBinding =
  | { case: "ordinary" }
  | { case: "recovery"; recoverySourceRunId: string }
  | { case: "mismatch"; mismatch: RepairBindingMismatch };

const latestRecoveryAttempt = (
  tx: DbTx,
  regressionTaskId: string,
): Promise<MergeRecoveryAttempt | null> => tx.mergeRecoveryAttempt.findFirst({
  where: { regressionTaskId },
  orderBy: [{ attempt: "desc" }, { id: "desc" }],
});

const bindingMismatch = (
  row: MergeRecoveryAttempt,
  repairedRunId: string,
  reason: string,
): RepairBindingMismatch => {
  const recovery = recoveryContext(row);
  return {
    reason: `${MERGE_TAIL_REPAIR_BINDING_MISMATCH}: ${reason}`,
    recoveryId: row.id,
    boundRecoveryRunId: row.recoveryRunId,
    boundSourceRunId: row.boundSourceRunId,
    repairedRunId,
    blockable: recovery
      && mergeRecoveryTransitionAllowed(row.status, MergeRecoveryStatus.BLOCKED_DOWNSTREAM)
      ? recovery
      : null,
  };
};

export const activeRepairRecoverySourceRun = async (
  tx: DbTx,
  input: { regressionTaskId: string; sourceRunId: string },
): Promise<RepairRecoveryBinding> => {
  const row = await latestRecoveryAttempt(tx, input.regressionTaskId);
  if (!row) return { case: "ordinary" };
  const recovery = recoveryContext(row);
  if (row.status !== MergeRecoveryStatus.REPAIRING || !recovery) {
    return {
      case: "mismatch",
      mismatch: bindingMismatch(
        row,
        input.sourceRunId,
        `merge recovery ${row.id} is ${row.status} with ${recovery ? "complete" : "incomplete"} identity,`
          + ` not a REPAIRING aggregate that can settle repaired Run ${input.sourceRunId}`,
      ),
    };
  }
  if (recovery.recoveryRunId !== input.sourceRunId) {
    return {
      case: "mismatch",
      mismatch: bindingMismatch(
        row,
        input.sourceRunId,
        `merge recovery ${row.id} is bound to recovery Run ${recovery.recoveryRunId},`
          + ` not to repaired Run ${input.sourceRunId}`,
      ),
    };
  }
  return { case: "recovery", recoverySourceRunId: recovery.recoveryRunId };
};

/**
 * The same question asked when a repair is opened rather than when it settles.
 *
 * Only the binding is checked here, not the aggregate's phase: the operator
 * reentry route creates its repair while the aggregate is still
 * `BLOCKED_DOWNSTREAM` and moves it to `REPAIRING` afterwards, so requiring the
 * settlement phase would refuse the one repair that is legitimately bound.
 */
export const repairBindingMismatchAtOpen = async (
  tx: DbTx,
  input: { regressionTaskId: string; sourceRunId: string },
): Promise<RepairBindingMismatch | null> => {
  const row = await latestRecoveryAttempt(tx, input.regressionTaskId);
  if (!row || row.recoveryRunId === input.sourceRunId) return null;
  return bindingMismatch(
    row,
    input.sourceRunId,
    `merge recovery ${row.id} is bound to recovery Run ${row.recoveryRunId ?? "(none)"},`
      + ` not to the Run ${input.sourceRunId} this repair would repair`,
  );
};

/** Record the overlap on the Regression task, carrying all three ids. */
export const recordRepairBindingMismatch = async (
  tx: DbTx,
  input: {
    regressionTaskId: string;
    mismatch: RepairBindingMismatch;
    phase: "open" | "settlement";
    repairTaskId?: string;
  },
): Promise<void> => {
  await tx.taskActivity.create({ data: {
    taskId: input.regressionTaskId,
    actorType: "control-plane",
    body: input.phase === "open"
      ? `Merge-tail repair refused at open: ${input.mismatch.reason}`
      : `Merge-tail repair completion rejected: ${input.mismatch.reason}`,
    metadata: {
      kind: MERGE_TAIL_REPAIR_BINDING_MISMATCH_KIND,
      schemaVersion: MERGE_TAIL_SCHEMA_VERSION,
      phase: input.phase,
      reason: input.mismatch.reason,
      recoveryId: input.mismatch.recoveryId,
      boundRecoveryRunId: input.mismatch.boundRecoveryRunId,
      boundSourceRunId: input.mismatch.boundSourceRunId,
      repairedRunId: input.mismatch.repairedRunId,
      ...(input.repairTaskId ? { repairTaskId: input.repairTaskId } : {}),
    },
  } });
};

/**
 * Settle a repair completion the platform cannot bind.
 *
 * The repair's own work is committed and its `repairResult` marker is already
 * written; what cannot happen is the recovery-bound activation of the merge-tail
 * target. So the repair Task parks with the named reason rather than being
 * retried or counted as an external failure, the overlap is recorded on the
 * Regression task, and — when the aggregate can still take it — the recovery is
 * parked `BLOCKED_DOWNSTREAM`, which is the state `POST
 * /tasks/:taskId/merge-tail/repair` reopens with a correctly bound repair card.
 */
export const stopUnboundRepair = async (
  tx: DbTx,
  input: {
    runId: string;
    repairTaskId: string;
    repairTaskStatus?: TaskStatus;
    regressionTaskId: string;
    /** The Documentation Step `settleMergeTailCompletion` already re-opened for
     *  this repair, when the repair target's chain owns one. */
    documentationTaskId?: string | null;
    mismatch: RepairBindingMismatch;
    run: { agentId: string; sessionId: string; completedAt: Date };
  },
): Promise<void> => {
  // The Run stays terminal — its work is real and published — and carries why
  // its completion was rejected, so the reason survives on the row a runner and
  // an operator both read.
  await tx.run.update({
    where: { id: input.runId },
    data: { failureReason: input.mismatch.reason },
  });
  await tx.task.updateMany({
    where: {
      id: input.repairTaskId,
      ...(input.repairTaskStatus ? { status: input.repairTaskStatus } : {}),
    },
    data: { status: TaskStatus.REVIEW, failureReason: input.mismatch.reason },
  });
  // The rejected repair does not get to leave its chain's Documentation Step
  // re-opened: `settleMergeTailCompletion` put it back to TODO for a repair the
  // platform is now refusing to settle.
  if (input.documentationTaskId && input.documentationTaskId !== input.regressionTaskId) {
    await tx.task.update({
      where: { id: input.documentationTaskId },
      data: { status: TaskStatus.REVIEW, failureReason: input.mismatch.reason },
    });
  }
  await recordRepairBindingMismatch(tx, {
    regressionTaskId: input.regressionTaskId,
    mismatch: input.mismatch,
    phase: "settlement",
    repairTaskId: input.repairTaskId,
  });
  // Park the tail only when this repair is the last thing running on it. A
  // mismatch is usually a newer recovery that took the chain over while the
  // repair ran, and that mechanism owns its own live Run: blocking it would
  // stop a healthy recovery, and it would also withhold the documented exit,
  // because the reentry route refuses `merge_tail_repair_active_run` while any
  // tail task still has an active Run. The stop notice is written either way,
  // so the overlap always reaches an operator.
  const blockable = input.mismatch.blockable;
  const tailTaskIds = blockable
    ? [blockable.regressionTaskId, blockable.readinessTaskId, blockable.integratorTaskId]
    : [input.regressionTaskId];
  const tailHasActiveRun = await tx.run.count({
    where: { taskId: { in: tailTaskIds }, status: { in: ACTIVE_RUN_STATUSES } },
  }) > 0;
  if (blockable && !tailHasActiveRun) {
    await blockDownstream(tx, {
      recovery: blockable,
      phase: "regression",
      reason: input.mismatch.reason,
      at: input.run.completedAt,
    });
    return;
  }
  if (!tailHasActiveRun) {
    await tx.task.update({
      where: { id: input.regressionTaskId },
      data: { status: TaskStatus.REVIEW, failureReason: input.mismatch.reason },
    });
  }
  await openMergeTailStopNotice(tx, {
    taskId: input.regressionTaskId,
    agentId: input.run.agentId,
    sessionId: input.run.sessionId,
    reason: input.mismatch.reason,
  });
};

type RecoveryStopData = Prisma.MergeRecoveryAttemptUpdateManyMutationInput;

export type StopMergeTailInput =
  | {
    phase: "regression";
    regressionTaskId: string;
    reason: string;
    at: Date;
    recovery: RecoveryContext | null;
    agentId: string;
    sessionId?: string;
  }
  | {
    phase: "readiness";
    readinessTaskId: string;
    regressionTaskId: string;
    reason: string;
    at: Date;
    recovery: RecoveryContext | null;
  }
  | {
    phase: "recovery-validation" | "recovery-exhausted";
    aggregateId: string;
    integratorTaskId: string;
    sourceStopId: string;
    reason: string;
    at: Date;
    attempt: number;
    /** Set when a retry class crossed its own ceiling rather than the
     *  candidate being ineligible; it names the settle and its refusal. */
    retryClass?: RetryClass;
    revalidations?: number;
    recoveryData: RecoveryStopData;
    markerMetadata: Record<string, unknown>;
  }
  | {
    phase: "repair";
    regressionTaskId: string;
    repairTaskId: string;
    repairKind: string | null;
    startHeadSha: string | null;
    targetHeadSha: string | null;
    resolvedHeadSha: string | null;
    reason: string;
    at: Date;
    agentId: string;
    sessionId?: string;
  };

export type StopMergeTailResult = { leaseOutcome: LeaseOutcome };

type ReadinessStopMergeTailInput = Extract<StopMergeTailInput, { phase: "readiness" }>;
type CompletionOwnedStopMergeTailInput = Exclude<StopMergeTailInput, ReadinessStopMergeTailInput>;

const stopNotice = async (
  tx: DbTx,
  input: { taskId: string; body: string; dedupeKey: string; agentId?: string; sessionId?: string; reopen?: boolean },
): Promise<void> => {
  await tx.inboxMessage.upsert({ where: { dedupeKey: input.dedupeKey }, create: {
    from: "AGENT",
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    taskId: input.taskId,
    kind: "TEXT",
    body: input.body,
    dedupeKey: input.dedupeKey,
  }, update: input.reopen ? { status: "OPEN", answeredAt: null, body: input.body } : {} });
};

/**
 * Persist one merge-tail stop. Readiness is the only phase that returns a
 * Lease target because its worker must release after commit; Run completion
 * owns Lease settlement for regression and repair, while recovery owns none.
 */
export function stopMergeTail(
  tx: DbTx,
  input: ReadinessStopMergeTailInput,
): Promise<StopMergeTailResult>;
export function stopMergeTail(
  tx: DbTx,
  input: CompletionOwnedStopMergeTailInput,
): Promise<void>;
export async function stopMergeTail(
  tx: DbTx,
  input: StopMergeTailInput,
): Promise<StopMergeTailResult | void> {
  if (input.phase === "regression" || input.phase === "readiness") {
    const recovery = input.recovery;
    const body = recovery
      ? `Automatic base-drift recovery ${recovery.attempt} stopped at ${input.phase}: ${input.reason}`
      : input.phase === "readiness"
        ? `Autonomous merge readiness stopped: ${input.reason}`
        : `Autonomous merge tail stopped: ${input.reason}`;
    if (recovery) {
      await blockDownstream(tx, { recovery, phase: input.phase, reason: input.reason, at: input.at });
    } else if (input.phase === "readiness") {
      await tx.task.updateMany({
        where: { id: { in: [input.readinessTaskId, input.regressionTaskId] } },
        data: { status: TaskStatus.REVIEW, failureReason: input.reason },
      });
    } else {
      await tx.task.update({
        where: { id: input.regressionTaskId },
        data: { status: TaskStatus.REVIEW, failureReason: input.reason },
      });
    }
    if (!recovery && input.phase === "regression") {
      await writeMarker(tx, input.regressionTaskId, "regression", {
        actorType: "control-plane",
        body: `Regression did not advance: ${input.reason}`,
        metadata: { state: "stopped", reason: input.reason },
      });
      await openMergeTailStopNotice(tx, {
        taskId: input.regressionTaskId,
        agentId: input.agentId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        reason: input.reason,
      });
    }
    if (input.phase === "readiness") {
      await writeMarker(tx, input.regressionTaskId, "readiness", {
        actorType: "control-plane",
        body: `Merge readiness stopped at regression: ${input.reason}`,
        metadata: { state: "stopped", reason: input.reason },
      });
      if (!recovery) {
        const dedupeKey = `merge-readiness-stop:${input.readinessTaskId}:${createHash("sha256").update(input.reason).digest("hex")}`;
        await stopNotice(tx, { taskId: input.regressionTaskId, body, dedupeKey,
          reopen: input.reason.startsWith(`${MERGE_EXECUTOR_OFFLINE_REASON}:`) });
      }
    }
    if (input.phase === "readiness") {
      return { leaseOutcome: { kind: "stop", taskId: input.regressionTaskId } };
    }
    return;
  }

  if (input.phase === "repair") {
    await tx.task.update({
      where: { id: input.regressionTaskId },
      data: { status: TaskStatus.REVIEW, failureReason: input.reason },
    });
    await writeMarker(tx, input.regressionTaskId, "repairResult", {
      actorType: "control-plane",
      body: `Automatic ${input.repairKind} attempt failed: ${input.startHeadSha} -> ${input.resolvedHeadSha ?? "no-delivered-head"}`,
      metadata: {
        repairKind: input.repairKind,
        repairTaskId: input.repairTaskId,
        startHeadSha: input.startHeadSha,
        targetHeadSha: input.targetHeadSha,
        resolvedHeadSha: input.resolvedHeadSha,
        state: "failed",
      },
    });
    await openMergeTailStopNotice(tx, {
      taskId: input.regressionTaskId,
      agentId: input.agentId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      reason: input.reason,
    });
    return;
  }

  const state = input.retryClass
    ? recoveryClassSettleState(input.retryClass)
    : input.phase === "recovery-validation" ? "ineligible" : "exhausted";
  await exhaust(tx, {
    aggregateId: input.aggregateId,
    integratorTaskId: input.integratorTaskId,
    sourceStopId: input.sourceStopId,
    reason: input.reason,
    at: input.at,
    attempt: input.attempt,
    state,
    ...(input.revalidations ? { revalidations: input.revalidations } : {}),
    recoveryData: input.recoveryData,
    markerMetadata: input.markerMetadata,
  });
}

type MergeTailCompletionTask = {
  id: string;
  documentationTaskId?: string | null;
  templateStep?: {
    stepIndex: number;
    outputKind: string;
    taskTemplate?: { name: string } | null;
  } | null;
};

export type MergeTailCompletionResult = {
  handled: boolean;
  leaseOutcome: "continue" | "stop";
};

/**
 * Settle the merge-tail state owned by one terminal Run completion. The caller
 * invokes this only for a successful Run or a failure that did not create a
 * retry; ordinary task completion and follow-up activation remain its work.
 */
export const settleMergeTailCompletion = async (
  tx: DbTx,
  input: {
    task: MergeTailCompletionTask;
    run: { agentId: string; sessionId: string; completedAt: Date };
    body: { headSha?: string | null };
    markers: Marker[];
    succeeded: boolean;
  },
): Promise<MergeTailCompletionResult> => {
  const repairMarker = latestMarker(input.markers, "repairAttempt");
  const repairCompletion = Boolean(repairMarker?.regressionTaskId);
  const terminalFailureStopsLease = isIntegratorStep(input.task.templateStep)
    || isRegressionVerificationOutputKind(input.task.templateStep?.outputKind)
    || repairCompletion;

  if (!input.succeeded) {
    if (repairMarker?.regressionTaskId) {
      const reason = `${repairMarker.repairKind} repair ${input.task.id} failed without closing the repair at ${repairMarker.headSha}`;
      await stopMergeTail(tx, {
        phase: "repair",
        regressionTaskId: repairMarker.regressionTaskId,
        repairTaskId: input.task.id,
        repairKind: repairMarker.repairKind,
        startHeadSha: repairMarker.headSha,
        targetHeadSha: repairMarker.baseHeadSha,
        resolvedHeadSha: input.body.headSha ?? null,
        reason,
        at: input.run.completedAt,
        agentId: input.run.agentId,
        sessionId: input.run.sessionId,
      });
    }
    return {
      handled: repairCompletion,
      leaseOutcome: terminalFailureStopsLease ? "stop" : "continue",
    };
  }

  if (!repairMarker?.regressionTaskId) {
    return {
      handled: false,
      leaseOutcome: isIntegratorStep(input.task.templateStep) ? "stop" : "continue",
    };
  }

  const repairOutput = await tx.taskStepOutput.findUnique({
    where: { taskId: input.task.id },
    select: { body: true },
  });
  let repairUnable = false;
  let reportedUnable = false;
  let resolvedHeadSha = input.body.headSha ?? null;
  if (repairMarker.repairKind === "refresh-conflict") {
    const parsedResolver = parseResolverResult(repairOutput?.body);
    const expectedStart = repairMarker.headSha;
    const expectedTarget = repairMarker.baseHeadSha;
    const bindingError: { reason: string; key: string } | null = parsedResolver.status === "invalid"
      ? { reason: parsedResolver.reason, key: parsedResolver.key }
      : parsedResolver.result.startHeadSha !== expectedStart
        ? { reason: "merge-resolver-opus-medium output is bound to a stale start head", key: "startHeadSha" }
        : parsedResolver.result.targetHeadSha !== expectedTarget
          ? { reason: "merge-resolver-opus-medium output is bound to a stale target head", key: "targetHeadSha" }
          : parsedResolver.result.outcome === "resolved" && parsedResolver.result.resolvedHeadSha !== input.body.headSha
            ? { reason: "merge-resolver-opus-medium output resolved head does not match the delivered run head", key: "resolvedHeadSha" }
            : null;
    if (bindingError) {
      repairUnable = true;
      const reason = `refresh-conflict repair ${input.task.id} returned invalid output: ${bindingError.reason}`;
      await tx.task.update({ where: { id: input.task.id }, data: { status: TaskStatus.DONE, failureReason: reason } });
      await tx.task.update({ where: { id: repairMarker.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
      // The rejection is recorded on the repair task too: the resolver's own
      // card is where an operator looks, and the key names the field that
      // failed so nobody has to read the parser to find out.
      await writeMarker(tx, input.task.id, "repairResult", {
        actorType: "control-plane",
        body: `Resolver output rejected on ${bindingError.key}: ${bindingError.reason}`,
        metadata: {
          repairKind: "refresh-conflict",
          repairTaskId: input.task.id,
          regressionTaskId: repairMarker.regressionTaskId,
          startHeadSha: expectedStart,
          targetHeadSha: expectedTarget,
          resolvedHeadSha: input.body.headSha ?? null,
          state: "invalid-output",
          reason: bindingError.reason,
          rejectedKey: bindingError.key,
        },
      });
      await writeMarker(tx, repairMarker.regressionTaskId, "repairResult", {
        actorType: "control-plane",
        body: `Automatic refresh-conflict attempt stopped: ${reason}`,
        metadata: {
          repairKind: "refresh-conflict",
          repairTaskId: input.task.id,
          startHeadSha: expectedStart,
          targetHeadSha: expectedTarget,
          resolvedHeadSha: input.body.headSha ?? null,
          state: "invalid-output",
          reason: bindingError.reason,
          rejectedKey: bindingError.key,
        },
      });
      await openMergeTailStopNotice(tx, {
        taskId: repairMarker.regressionTaskId,
        agentId: input.run.agentId,
        sessionId: input.run.sessionId,
        reason,
      });
    } else if (parsedResolver.status === "ok") {
      reportedUnable = parsedResolver.result.outcome === "unable";
      resolvedHeadSha = parsedResolver.result.outcome === "resolved" ? parsedResolver.result.resolvedHeadSha : null;
    }
  }

  // gate-fix and review-fix agents have no JSON wire contract; their
  // successful delivered head is the completion evidence.
  if (reportedUnable) {
    repairUnable = true;
    const reason = `${String(repairMarker.repairKind)} repair ${input.task.id} reported unable at ${String(repairMarker.headSha)}`;
    await tx.task.update({ where: { id: input.task.id }, data: { status: TaskStatus.DONE, failureReason: reason } });
    await tx.task.update({ where: { id: repairMarker.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
    await openMergeTailStopNotice(tx, {
      taskId: repairMarker.regressionTaskId,
      agentId: input.run.agentId,
      sessionId: input.run.sessionId,
      reason,
    });
  } else if (!repairUnable) {
    await writeMarker(tx, repairMarker.regressionTaskId, "repairResult", {
      actorType: "control-plane",
      body: `Automatic ${String(repairMarker.repairKind)} attempt completed: ${String(repairMarker.headSha)} -> ${input.body.headSha ?? "missing-head"}`,
      metadata: {
        repairKind: repairMarker.repairKind,
        repairTaskId: input.task.id,
        startHeadSha: repairMarker.headSha,
        targetHeadSha: repairMarker.baseHeadSha,
        resolvedHeadSha,
      },
    });
    if (input.task.documentationTaskId) {
      await tx.task.update({
        where: { id: input.task.documentationTaskId },
        data: {
          status: TaskStatus.TODO,
          failureReason: `documentation invalidated by ${String(repairMarker.repairKind)} repair ${input.task.id}`,
        },
      });
    }
  }

  return {
    handled: repairUnable,
    leaseOutcome: repairUnable ? "stop" : "continue",
  };
};

export const createMergeTailRepairTask = async (
  tx: DbTx,
  input: {
    regressionTask: { id: string; projectId: string; repoId: string | null; templateId: string | null; chainId: string | null; chainIndex: number | null; targetBranch: string | null };
    sourceRun: { id: string; branch: string | null };
    assignee: MergeTailRepairAssignee;
    repairKind: "refresh-conflict" | "gate-fix" | "review-fix";
    headSha: string;
    baseHeadSha: string;
    summary: string;
    gateFailureExcerpt?: string;
    now: Date;
  },
): Promise<{ taskId: string } | { refusal: string; bindingMismatch?: RepairBindingMismatch }> => {
  const { regressionTask } = input;
  if (
    !regressionTask.repoId || !regressionTask.chainId || regressionTask.chainIndex === null
    || !regressionTask.templateId || !input.sourceRun.branch
  ) {
    return { refusal: "repair task cannot resolve its chain position, repository, and shared branch" };
  }
  // Checked here rather than only at settlement. A repair whose recovery names
  // another Run cannot be reported when it finishes, and the agent it is handed
  // to commits its work before finding that out, so the refusal belongs at the
  // moment the card would be created.
  const mismatch = await repairBindingMismatchAtOpen(tx, {
    regressionTaskId: regressionTask.id,
    sourceRunId: input.sourceRun.id,
  });
  if (mismatch) {
    await recordRepairBindingMismatch(tx, {
      regressionTaskId: regressionTask.id,
      mismatch,
      phase: "open",
    });
    return { refusal: mismatch.reason, bindingMismatch: mismatch };
  }
  // Addressed by id or by canonical role, never by the editable name: an
  // operator may rename the canonical resolver, and the repair still belongs
  // to that role's Agent (R9).
  const agentLabel = input.assignee.kind === "agent" ? input.assignee.label : input.assignee.canonicalRole;
  const agent = input.assignee.kind === "agent"
    ? await tx.agent.findFirst({
      where: { id: input.assignee.agentId, projectId: regressionTask.projectId, archivedAt: null },
      select: { id: true },
    })
    : await findCanonicalAgent(tx, {
      projectId: regressionTask.projectId,
      canonicalRole: input.assignee.canonicalRole,
      activeOnly: true,
    });
  if (!agent) return { refusal: `required repair agent ${agentLabel} is absent or archived` };
  const grant = await tx.agentRepoAccess.findFirst({
    where: { projectId: regressionTask.projectId, agentId: agent.id, repoId: regressionTask.repoId },
  });
  if (!grant) return { refusal: `required repair agent ${agentLabel} has no repository grant` };

  // A repair task is deliberately chain-detached, so the claim path's own
  // prior-output lookup (which keys off chainId and chainIndex) never fires for
  // it. Without this the repair agent sees only the verdict summary and no
  // Feature brief, acceptance criteria, or review reports, and the narrowest
  // reading of that summary is the whole job it can do. Same query, ordering,
  // and rendering as a chain step's, filtered to the kinds each repair reads:
  // intent and handoffs for every kind, the review reports only for the
  // review-fix that must trace their finding ids. Planning-stage and
  // documentation outputs repair nothing and stay out.
  const repairPriorOutputKinds = input.repairKind === "review-fix"
    ? ["spec", "implementation", "review-findings", "sol-findings", "blind-findings", "fixed-implementation"]
    : input.repairKind === "gate-fix"
      ? ["spec", "implementation", "fixed-implementation"]
      : ["spec", "implementation"];
  const priorOutputs = await tx.taskStepOutput.findMany({
    where: { task: {
      projectId: regressionTask.projectId,
      chainId: regressionTask.chainId,
      chainIndex: { lt: regressionTask.chainIndex },
    }, kind: { in: repairPriorOutputKinds } },
    select: { kind: true, body: true, task: { select: { name: true, chainIndex: true } } },
    orderBy: { task: { chainIndex: "asc" } },
  });
  const chainContext = priorOutputs.length > 0
    ? [
      "Persisted outputs from prior template steps:",
      ...priorOutputs.map((output) => `## ${output.task.name} (${output.kind})\n${output.body}`),
    ].join("\n\n")
    : null;
  const prompt = [
    ...(input.repairKind === "refresh-conflict"
      ? [
        `Resolve the refresh conflict between chain head ${input.headSha} and target head ${input.baseHeadSha}.`,
        input.summary,
        `Re-run the merge, preserve both intents under the ${MERGE_RESOLVER_ROLE} role contract, commit the resolution, and persist the role's versioned JSON bound to start ${input.headSha} and target ${input.baseHeadSha}.`,
      ]
      : [
        `Repair the autonomous merge tail failure at ${input.headSha} against target ${input.baseHeadSha}.`,
        input.summary,
        ...(input.repairKind === "gate-fix" && input.gateFailureExcerpt !== undefined
          ? ["Gate failure excerpt", input.gateFailureExcerpt]
          : []),
        "Make exactly the changes needed to close this failure, run affected suites, commit, and persist the result as task output. Before changing any shared type, schema, or route contract, enumerate its callers across every workspace, including apps/web, and update or test each one in the same change.",
      ]),
    ...(chainContext ? [chainContext] : []),
  ].join("\n\n");
  const task = await tx.task.create({ data: {
    projectId: regressionTask.projectId,
    repoId: regressionTask.repoId,
    name: `Autonomous merge tail: ${input.repairKind}`,
    description: prompt,
    assigneeType: "AGENT",
    assigneeAgentId: agent.id,
    approvalGate: false,
    opensPullRequest: false,
    status: TaskStatus.TODO,
    targetBranch: input.sourceRun.branch,
    // Two attempts, not one. A repair that delivered its commit and then lost
    // the provider stream on the way out completes as a retryable failure; at
    // a budget of one there is no second Run to re-report it, so
    // `run-completion.ts` reaches `stopMergeTail` and the whole tail stops for
    // a transport blip. This is the per-card Run budget and is unrelated to
    // MAX_MERGE_TAIL_REPAIR_ATTEMPTS, which bounds how many repair cards the
    // tail opens.
    maxSessionsPerTask: 2,
  } });
  // The repair card's own intent, not an ordinary enqueue followed by a
  // correction: `resolveRunBranches` reads the head off the Task's targetBranch
  // above, so the Run is born publishing onto the chain head it repairs.
  const opened = await openRun(tx, task.id, { kind: "merge-tail-repair", readyAt: input.now });
  if (!opened.ok) throw errorForOpenRunRefusal(opened.refusal);
  await writeMarker(tx, regressionTask.id, "repairAttempt", {
    actorType: "control-plane",
    body: `Automatic ${input.repairKind} attempt queued at chain head ${input.headSha} against ${input.baseHeadSha}`,
    metadata: {
      repairKind: input.repairKind,
      repairTaskId: task.id,
      sourceRunId: input.sourceRun.id,
      headSha: input.headSha,
      baseHeadSha: input.baseHeadSha,
    },
  });
  await writeMarker(tx, task.id, "repairAttempt", {
    actorType: "control-plane",
    body: `Automatic ${input.repairKind} attempt for regression task ${regressionTask.id}`,
    metadata: {
      repairKind: input.repairKind,
      regressionTaskId: regressionTask.id,
      sourceRunId: input.sourceRun.id,
      headSha: input.headSha,
      baseHeadSha: input.baseHeadSha,
    },
  });
  await tx.task.update({
    where: { id: regressionTask.id },
    data: { status: TaskStatus.REVIEW, failureReason: `${input.repairKind}: automatic repair ${task.id} queued at ${input.headSha}` },
  });
  return { taskId: task.id };
};

/** Resolves the implementation repair assignee shared by automatic repair and
 * operator reentry. Keeping this lookup in one place prevents the two repair
 * entrypoints from drifting when a template binds its fixed implementation
 * step to a non-default Agent.
 *
 * A chain with no fixed-implementation step — a retired generation, or a clone
 * that dropped it — is answered `unstaffed`. There is no canonical fallback:
 * staffing the repair with an Agent nobody put on this chain is exactly the
 * silent substitution the caller must refuse to make. */
export const mergeTailRepairAssignee = async (
  tx: DbTx,
  input: {
    projectId: string;
    chainId: string | null;
    templateId: string | null;
    repairKind: "refresh-conflict" | "gate-fix" | "review-fix";
  },
): Promise<MergeTailRepairAssignee | MergeTailRepairUnstaffed> => {
  if (input.repairKind === "refresh-conflict") return { kind: "role", canonicalRole: MERGE_RESOLVER_ROLE };
  const fixTask = await tx.task.findFirst({
    where: {
      projectId: input.projectId,
      chainId: input.chainId,
      templateId: input.templateId,
      templateStep: { outputKind: "fixed-implementation" },
    },
    select: { id: true, assigneeAgent: { select: { id: true, name: true } } },
  });
  const bound = fixTask?.assigneeAgent;
  // The chain already staffed this step, so its Agent is addressed by id: a
  // staffing profile may have put any Agent there, canonical or not.
  return bound
    ? { kind: "agent", agentId: bound.id, label: bound.name }
    : {
      kind: "unstaffed",
      reason: fixTask
        ? `chain ${input.chainId ?? "(none)"} fixed-implementation task ${fixTask.id} staffs no Agent for the ${input.repairKind} repair`
        : `chain ${input.chainId ?? "(none)"} has no fixed-implementation step to staff the ${input.repairKind} repair`,
    };
};

export const handleRegressionCompletion = async (
  tx: DbTx,
  input: {
    task: { id: string; projectId: string; repoId: string | null; templateId: string | null; chainId: string | null; chainIndex: number | null; targetBranch: string | null; templateStep?: RegressionTaskIdentity["templateStep"] };
    run: { id: string; agentId: string; branch: string | null; headSha: string | null; sessionId: string };
    qualifiedVerdict?: RegressionVerdict;
    /** A merge-train gate-fix is bound to the train prefix rather than an
     *  active base-drift aggregate. The train worker has already serialized
     *  that decision under its Merge Lease, so it may explicitly route this
     *  named synthetic verdict through the ordinary repair path. */
    mergeTrainFailure?: { trainTaskId: string; predecessorOid: string };
    now: Date;
  },
): Promise<"advance" | "handled"> => {
  const recovery = input.mergeTrainFailure
    ? null
    : await baseDriftRecoveryContext(tx, input.task.id, input.run.id);
  if (input.mergeTrainFailure && (!input.qualifiedVerdict
    || input.qualifiedVerdict.outcome !== "gate-fail"
    || input.qualifiedVerdict.baseHeadSha !== input.mergeTrainFailure.predecessorOid)) {
    throw new Error(`Merge train ${input.mergeTrainFailure.trainTaskId} supplied an invalid gate-fix verdict binding`);
  }
  const stop = async (reason: string): Promise<"handled"> => {
    await stopMergeTail(tx, {
      phase: "regression",
      regressionTaskId: input.task.id,
      reason,
      at: input.now,
      recovery,
      agentId: input.run.agentId,
      sessionId: input.run.sessionId,
    });
    return "handled";
  };
  let verdict = input.qualifiedVerdict;
  if (!verdict) {
    const qualified = await regressionVerdictForRun(tx, {
      task: input.task,
      runId: input.run.id,
      runHeadSha: input.run.headSha,
    });
    if (qualified.status === "refused") return stop(qualified.reason);
    verdict = qualified.verdict;
  }
  const recordVerdict = () => writeMarker(tx, input.task.id, "regression", {
    actorType: "control-plane",
    body: `Regression ${verdict.outcome} recorded for chain head ${verdict.headSha} against target ${verdict.baseHeadSha}`,
    metadata: { ...verdict },
  });
  if (verdict.outcome === "pass") {
    await recordVerdict();
    if (recovery) {
      await awaitAuthorization(tx, recovery);
    }
    return "advance";
  }

  if (recovery) {
    await recordVerdict();
    await stopMergeTail(tx, {
      phase: "regression",
      regressionTaskId: input.task.id,
      recovery,
      agentId: input.run.agentId,
      sessionId: input.run.sessionId,
      at: input.now,
      reason: truncateFailureReason(
        verdict.outcome === "refresh-conflict"
          ? `refresh conflict at ${verdict.headSha} against ${verdict.baseHeadSha}: ${verdict.summary}`
          : verdict.outcome === "review-fail"
            ? `semantic regression FAIL at ${verdict.headSha} against ${verdict.baseHeadSha}: ${verdict.summary}`
            : `merge gate FAIL at ${verdict.headSha} against ${verdict.baseHeadSha}: ${verdict.summary}`,
        FAILURE_REASON_LIMIT,
      ),
    });
    return "handled";
  }

  // The whole history, not the recent-state window: the automatic attempt
  // budget per repair kind is the rule, and an attempt pushed past the window
  // by later activity would license an extra one.
  const attempts = await readMarkerHistory(tx, input.task.id);
  const repairKind = verdict.outcome === "refresh-conflict"
    ? "refresh-conflict"
    : verdict.outcome === "review-fail" ? "review-fix" : "gate-fix";
  const matchingAttempt = attempts.find((marker) => (
    marker.kind === "repairAttempt"
    && marker.repairKind === repairKind
    && marker.headSha === verdict.headSha
    && marker.baseHeadSha === verdict.baseHeadSha
    && marker.raw.sourceRunId === input.run.id
  ));
  // A source verdict is consumed when its repair attempt is opened. The later
  // repairResult closes that attempt; it does not make the old source Run a
  // new verdict capable of opening another repair.
  if (matchingAttempt) return "handled";
  await recordVerdict();
  const priorAttempts = attempts.filter((marker) => (
    marker.kind === "repairAttempt"
    && marker.repairKind === repairKind
    && (repairKind !== "refresh-conflict" || marker.headSha === verdict.headSha)
  )).length;
  // A refresh conflict is a merge of two fixed trees: a second resolver run on
  // the same head has nothing new to work with. A semantic or gate FAIL does —
  // the first repair moved the tree, and the verdict it now fails on is a
  // different one — so those get further attempts, up to the limit, before
  // the tail stops.
  const attemptLimit = repairKind === "refresh-conflict" ? 1 : MAX_MERGE_TAIL_REPAIR_ATTEMPTS;
  if (priorAttempts >= attemptLimit) {
    return stop(repairKind === "refresh-conflict"
      ? `second refresh conflict on chain head ${verdict.headSha}`
      : repairKind === "review-fix"
        ? `semantic regression FAIL on chain head ${verdict.headSha} after ${priorAttempts} automatic repair attempts`
        : `merge gate FAIL on chain head ${verdict.headSha} after ${priorAttempts} automatic repair attempts`);
  }
  const assignee = await mergeTailRepairAssignee(tx, { ...input.task, repairKind });
  if (assignee.kind === "unstaffed") return stop(assignee.reason);
  const repair = await createMergeTailRepairTask(tx, {
    regressionTask: input.task,
    sourceRun: input.run,
    assignee,
    repairKind,
    headSha: verdict.headSha,
    baseHeadSha: verdict.baseHeadSha,
    summary: verdict.summary,
    ...(verdict.outcome === "gate-fail"
      && "gateFailureExcerpt" in verdict
      && typeof verdict.gateFailureExcerpt === "string"
      ? { gateFailureExcerpt: verdict.gateFailureExcerpt }
      : {}),
    now: input.now,
  });
  if ("refusal" in repair) return stop(repair.refusal);
  return "handled";
};
