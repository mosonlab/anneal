import {
  attemptRunBirth,
  closeIntegratorQuestions,
  enqueueTaskRunInternal,
  errorForOpenRunRefusal,
  MERGE_RECOVERY_CLASS_SETTLE,
  MERGE_RECOVERY_RETRY_CLASS_ENUM,
  parksInsteadOfRaising,
  recordRunBirthRefusal,
  MergeRecoveryRefusalCode,
  MergeRecoveryStatus,
  openRun,
  runBirthRefusalMetadata,
  Prisma,
  TaskStatus,
  recordReadinessRequeue,
  transitionMergeRecovery,
  writeMarker,
  type MergeRecoveryAttempt,
  type MergeRecoveryClassSettleState,
  type MergeRecoveryTransitionData,
  type RecoveryContext,
} from "@anneal/db";

import {
  formatElapsed,
  type RetryBudgetDecision,
  type RetryClass,
} from "./base-drift-recovery-decision.js";

type RetryBudgetRetry = Extract<RetryBudgetDecision, { kind: "retry" }>;
type RetryBudgetCeiling = Extract<RetryBudgetDecision, { kind: "ineligible" }>;

type DbTx = Prisma.TransactionClient;

export type RecoveryValidationIdentity = {
  sourceRunId: string;
  authorizationActivityId: string;
  readinessTaskId: string;
  regressionTaskId: string;
  repository: string;
  prNumber: number;
  targetBranch: string;
  authorizedHeadSha: string;
  authorizedBaseSha: string;
  observedBaseSha: string;
};

type RecoveryValidationData = {
  boundSourceRunId: string;
  authorizationActivityId: string;
  readinessTaskId: string;
  regressionTaskId: string;
  repository: string;
  prNumber: number;
  targetBranch: string;
  authorizedHeadSha: string;
  authorizedBaseSha: string;
  observedBaseSha: string;
};

const validationData = (identity: RecoveryValidationIdentity): RecoveryValidationData => ({
  boundSourceRunId: identity.sourceRunId,
  authorizationActivityId: identity.authorizationActivityId,
  readinessTaskId: identity.readinessTaskId,
  regressionTaskId: identity.regressionTaskId,
  repository: identity.repository,
  prNumber: identity.prNumber,
  targetBranch: identity.targetBranch,
  authorizedHeadSha: identity.authorizedHeadSha,
  authorizedBaseSha: identity.authorizedBaseSha,
  observedBaseSha: identity.observedBaseSha,
});

const fillValidationIdentity = async (
  tx: DbTx,
  attempt: MergeRecoveryAttempt,
  identity: RecoveryValidationIdentity,
): Promise<MergeRecoveryAttempt> => {
  const supplied = validationData(identity);
  const missing: Partial<RecoveryValidationData> = {};
  for (const key of Object.keys(supplied) as Array<keyof RecoveryValidationData>) {
    const current = attempt[key];
    if (current !== null && current !== supplied[key]) {
      throw new Error(`Merge recovery ${attempt.id} ${key} conflicts with the validated tail identity`);
    }
    if (current === null) Object.assign(missing, { [key]: supplied[key] });
  }
  return Object.keys(missing).length === 0
    ? attempt
    : tx.mergeRecoveryAttempt.update({ where: { id: attempt.id }, data: missing });
};

export const recoveryIsReopenableLegacyRefusal = (attempt: MergeRecoveryAttempt): boolean => (
  (attempt.status === MergeRecoveryStatus.FAILED
    && attempt.refusalCode === MergeRecoveryRefusalCode.PRE_INTENT
    && attempt.boundSourceRunId === null
    && attempt.authorizationActivityId === null
    && attempt.recoveryRunId === null)
  || (attempt.status === MergeRecoveryStatus.FAILED
    && attempt.refusalCode === MergeRecoveryRefusalCode.TARGET_BRANCH_MISMATCH
    && attempt.boundSourceRunId === null
    && attempt.authorizationActivityId === null
    && attempt.recoveryRunId === null
    && attempt.readinessTaskId === null
    && attempt.regressionTaskId === null
    && attempt.repository === null
    && attempt.prNumber === null
    && attempt.targetBranch === null
    && attempt.authorizedHeadSha === null
    && attempt.authorizedBaseSha === null
    && attempt.observedBaseSha === null
    && attempt.currentBaseSha === null)
);

/** Opens the initial VALIDATING state or the two explicitly supported legacy reopen shapes. */
export const ensureRecoveryValidation = async (
  tx: DbTx,
  input: {
    integratorTaskId: string;
    sourceStopId: string;
    identity?: RecoveryValidationIdentity;
  },
): Promise<MergeRecoveryAttempt> => {
  const existing = await tx.mergeRecoveryAttempt.findFirst({
    where: { integratorTaskId: input.integratorTaskId, sourceStopId: input.sourceStopId },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  if (existing) {
    if (existing.status === MergeRecoveryStatus.VALIDATING && input.identity) {
      return fillValidationIdentity(tx, existing, input.identity);
    }
    if (!input.identity || !recoveryIsReopenableLegacyRefusal(existing)) return existing;
    const reopened = await transitionMergeRecovery(tx, existing.id, MergeRecoveryStatus.VALIDATING, {
      failureReason: null,
      refusalCode: null,
      endedAt: null,
      ...validationData(input.identity),
    });
    await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", {
      actorType: "control-plane",
      body: `Automatic pre-merge base-drift validation reopened legacy refusal for stop ${input.sourceStopId}`,
      metadata: {
        state: "legacy-validation-reopened",
        aggregateId: existing.id,
        sourceStopId: input.sourceStopId,
      },
    });
    return reopened;
  }
  const latest = await tx.mergeRecoveryAttempt.aggregate({
    where: { integratorTaskId: input.integratorTaskId },
    _max: { attempt: true },
  });
  return tx.mergeRecoveryAttempt.create({ data: {
    integratorTaskId: input.integratorTaskId,
    sourceStopId: input.sourceStopId,
    attempt: (latest._max.attempt ?? 0) + 1,
    status: MergeRecoveryStatus.VALIDATING,
    ...(input.identity ? validationData(input.identity) : {}),
  } });
};

type RecoveryRepairIdentity = Omit<RecoveryContext, "currentBaseSha" | "recoveryRunId">;

const requireRecoveryRepairIdentity = async (
  tx: DbTx,
  aggregateId: string,
): Promise<RecoveryRepairIdentity> => {
  const aggregate = await tx.mergeRecoveryAttempt.findUnique({ where: { id: aggregateId } });
  if (!aggregate?.boundSourceRunId || !aggregate.authorizationActivityId
    || !aggregate.readinessTaskId || !aggregate.regressionTaskId || !aggregate.repository
    || aggregate.prNumber === null || !aggregate.targetBranch || !aggregate.authorizedHeadSha
    || !aggregate.authorizedBaseSha || !aggregate.observedBaseSha) {
    throw new Error(`Merge recovery aggregate ${aggregateId} has incomplete tail identity`);
  }
  return {
    aggregateId: aggregate.id,
    attempt: aggregate.attempt,
    sourceStopId: aggregate.sourceStopId,
    sourceRunId: aggregate.boundSourceRunId,
    authorizationActivityId: aggregate.authorizationActivityId,
    repository: aggregate.repository,
    prNumber: aggregate.prNumber,
    targetBranch: aggregate.targetBranch,
    authorizedHeadSha: aggregate.authorizedHeadSha,
    authorizedBaseSha: aggregate.authorizedBaseSha,
    observedBaseSha: aggregate.observedBaseSha,
    readinessTaskId: aggregate.readinessTaskId,
    regressionTaskId: aggregate.regressionTaskId,
    integratorTaskId: aggregate.integratorTaskId,
  };
};

const stopNotice = async (
  tx: DbTx,
  input: { taskId: string; body: string; dedupeKey: string },
): Promise<void> => {
  await tx.inboxMessage.upsert({ where: { dedupeKey: input.dedupeKey }, create: {
    from: "AGENT",
    taskId: input.taskId,
    kind: "TEXT",
    body: input.body,
    dedupeKey: input.dedupeKey,
  }, update: {} });
};

/** Readiness checks its drift ceiling before calling; persist any Run-birth refusal. */
export const requeueMergeTailRun = async (tx: DbTx, taskId: string, now: Date, readinessBaseDrift: boolean) => {
  const attempt = await attemptRunBirth(tx, (client) => openRun(client, taskId, {
    kind: "merge-tail-requeue", readyAt: now, budgetGrant: 1, ...(readinessBaseDrift ? { readinessBaseDrift: true } : {}),
  }));
  if (attempt.outcome === "refused") {
    const { refusal } = attempt;
    if (refusal.disposition !== "held") {
      await tx.task.update({
        where: { id: taskId },
        data: { status: TaskStatus.REVIEW, failureReason: refusal.message },
      });
    }
    await tx.taskActivity.create({ data: {
      taskId, actorType: "control-plane",
      body: `Merge-tail target was not queued: ${refusal.message}`,
      metadata: runBirthRefusalMetadata(refusal),
    } });
  }
  return attempt;
};

export const enterRepair = async (
  tx: DbTx,
  input: {
    aggregateId: string;
    currentBaseSha: string;
    now: Date;
    readinessRequeue?: { staleBaseSha: string; reason: string; baseDrift: boolean };
    /**
     * A one-shot grant for a re-run the branch did not earn. An operator rerun
     * of a host-caused gate FAIL is platform compensation, exactly like the
     * readiness requeue below: without it the queued Run can be born past
     * `maxSessionsPerTask` — `enqueue` does not refuse there — and the runner
     * kills it at claim as `budget-exhausted` after the route answered 200.
     */
    budgetGrant?: 1;
  },
): Promise<{ recoveryRunId: string } | null> => {
  const context = await requireRecoveryRepairIdentity(tx, input.aggregateId);
  const aggregate = await tx.mergeRecoveryAttempt.findUniqueOrThrow({
    where: { id: input.aggregateId },
    select: { status: true },
  });
  const requeue = input.readinessRequeue;
  if ((aggregate.status === MergeRecoveryStatus.AWAITING_AUTHORIZATION) !== Boolean(requeue)) {
    throw new Error(`Merge recovery ${input.aggregateId} repair intent does not match ${aggregate.status}`);
  }

  if (!requeue) {
    await closeIntegratorQuestions(tx, context.integratorTaskId);
    await tx.taskStepOutput.deleteMany({
      where: { taskId: { in: [context.regressionTaskId, context.readinessTaskId] } },
    });
  }
  await tx.task.update({
    where: { id: context.regressionTaskId },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  await tx.task.update({
    where: { id: context.readinessTaskId },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  if (!requeue) {
    await tx.task.update({
      where: { id: context.integratorTaskId },
      data: {
        status: TaskStatus.REVIEW,
        failureReason: `Automatic base-drift recovery ${String(context.attempt)} queued from stop ${context.sourceStopId}`,
      },
    });
  }
  const attempt = requeue ? await requeueMergeTailRun(tx, context.regressionTaskId, input.now, requeue.baseDrift) : null;
  if (attempt && attempt.outcome !== "opened") {
    if (attempt.outcome === "refused" && attempt.refusal.disposition !== "held") {
      await transitionMergeRecovery(tx, input.aggregateId, MergeRecoveryStatus.BLOCKED_DOWNSTREAM, {
        failureReason: attempt.refusal.message, endedAt: input.now,
      });
      for (const taskId of [context.readinessTaskId, context.integratorTaskId]) {
        await tx.task.update({ where: { id: taskId }, data: {
          status: TaskStatus.REVIEW, failureReason: attempt.refusal.message,
        } });
      }
    }
    return null;
  }
  let run = attempt?.run ?? null;
  if (!run) {
    // Not `enqueueTaskRun`: a raised refusal aborts this transaction, and a
    // spend cap must leave the regression task parked with the cap that
    // refused it. Every other refusal keeps raising.
    const opened = await enqueueTaskRunInternal(
      tx,
      context.regressionTaskId,
      input.now,
      null,
      input.budgetGrant === 1 ? { budgetGrant: 1 } : {},
    );
    if (!opened.ok) {
      if (!parksInsteadOfRaising(opened.refusal)) throw errorForOpenRunRefusal(opened.refusal);
      await recordRunBirthRefusal(tx, context.regressionTaskId, opened.refusal);
      await transitionMergeRecovery(tx, input.aggregateId, MergeRecoveryStatus.BLOCKED_DOWNSTREAM, {
        failureReason: opened.refusal.message, endedAt: input.now,
      });
      return null;
    }
    run = opened.run;
  }
  await transitionMergeRecovery(tx, input.aggregateId, MergeRecoveryStatus.REPAIRING, {
    recoveryRunId: run.id,
    currentBaseSha: input.currentBaseSha,
    failureReason: null,
    endedAt: null,
  });

  const body = requeue
    ? `Automatic base-drift recovery ${String(context.attempt)} context carried through readiness requeue`
    : `Automatic base-drift recovery ${String(context.attempt)} parked stop ${context.sourceStopId} and queued fresh regression`;
  const metadata = {
    ...context,
    currentBaseSha: input.currentBaseSha,
    recoveryRunId: run.id,
    state: requeue ? "readiness-requeued" : "queued",
  };
  if (requeue) {
    const requeueMetadata = {
      ...context,
      currentBaseSha: input.currentBaseSha,
      recoveryRunId: run.id,
    } as Prisma.InputJsonObject;
    await tx.taskActivity.createMany({ data: [
      { taskId: context.integratorTaskId, actorType: "control-plane", body, metadata: requeueMetadata },
      { taskId: context.regressionTaskId, actorType: "control-plane", body, metadata: requeueMetadata },
    ] });
    await writeMarker(tx, context.regressionTaskId, "readiness", {
      actorType: "control-plane",
      body: `Merge readiness returned to regression: ${requeue.reason}; ${requeue.staleBaseSha} -> ${input.currentBaseSha}`,
      metadata: {
        state: "requeued-regression",
        reason: requeue.reason,
        staleBaseSha: requeue.staleBaseSha,
        currentBaseSha: input.currentBaseSha,
      },
    });
    // The counter shares this transaction with the grant it counts, so a
    // rolled-back settlement leaves neither behind.
    await recordReadinessRequeue(tx, {
      readinessTaskId: context.readinessTaskId,
      regressionTaskId: context.regressionTaskId,
      recoveryAggregateId: context.aggregateId,
      staleBaseSha: requeue.staleBaseSha,
      currentBaseSha: input.currentBaseSha,
      budgetGrant: 1,
      reason: requeue.reason,
    });
  } else {
    await writeMarker(tx, context.integratorTaskId, "baseDriftRecovery", {
      actorType: "control-plane",
      body,
      metadata,
    });
    await writeMarker(tx, context.regressionTaskId, "baseDriftRecovery", {
      actorType: "control-plane",
      body: `Automatic base-drift recovery ${String(context.attempt)} verifies ${context.authorizedHeadSha} against current base ${input.currentBaseSha}`,
      metadata,
    });
  }
  return { recoveryRunId: run.id };
};

export const awaitAuthorization = async (
  tx: DbTx,
  recovery: RecoveryContext,
): Promise<void> => {
  await transitionMergeRecovery(
    tx,
    recovery.aggregateId,
    MergeRecoveryStatus.AWAITING_AUTHORIZATION,
    { failureReason: null },
  );
};

export const blockDownstream = async (
  tx: DbTx,
  input: {
    recovery: RecoveryContext;
    phase: "regression" | "readiness";
    reason: string;
    at: Date;
  },
): Promise<void> => {
  const { recovery } = input;
  const body = `Automatic base-drift recovery ${String(recovery.attempt)} stopped at ${input.phase}: ${input.reason}`;
  await transitionMergeRecovery(tx, recovery.aggregateId, MergeRecoveryStatus.BLOCKED_DOWNSTREAM, {
    failureReason: input.reason,
    endedAt: input.at,
  });
  await tx.task.update({
    where: { id: recovery.regressionTaskId },
    data: {
      status: TaskStatus.REVIEW,
      failureReason: input.phase === "regression" ? body : input.reason,
    },
  });
  await tx.task.update({
    where: { id: recovery.readinessTaskId },
    data: {
      status: TaskStatus.REVIEW,
      failureReason: input.phase === "regression" ? body : input.reason,
    },
  });
  await tx.task.update({
    where: { id: recovery.integratorTaskId },
    data: { status: TaskStatus.REVIEW, failureReason: body },
  });
  const dedupeKey = `merge-base-drift-recovery-tail-stop:${recovery.sourceStopId}:${input.phase}:${recovery.recoveryRunId}`;
  const metadata = { ...recovery, state: "tail-stopped", phase: input.phase, reason: input.reason, dedupeKey };
  for (const taskId of [recovery.integratorTaskId, recovery.regressionTaskId]) {
    await writeMarker(tx, taskId, "baseDriftRecovery", { actorType: "control-plane", body, metadata });
  }
  await stopNotice(tx, { taskId: recovery.regressionTaskId, body, dedupeKey });
};

export const reopenAfterHeadAdoption = async (
  tx: DbTx,
  input: { recovery: RecoveryContext; expectedFailureReason: string },
): Promise<boolean> => {
  const transitioned = await transitionMergeRecovery(tx, input.recovery.aggregateId, MergeRecoveryStatus.REPAIRING, {
    failureReason: null,
    endedAt: null,
  }, {
    status: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
    failureReason: input.expectedFailureReason,
    boundSourceRunId: input.recovery.sourceRunId,
    authorizationActivityId: input.recovery.authorizationActivityId,
    recoveryRunId: input.recovery.recoveryRunId,
    readinessTaskId: input.recovery.readinessTaskId,
    regressionTaskId: input.recovery.regressionTaskId,
    repository: input.recovery.repository,
    prNumber: input.recovery.prNumber,
    targetBranch: input.recovery.targetBranch,
    authorizedHeadSha: input.recovery.authorizedHeadSha,
    authorizedBaseSha: input.recovery.authorizedBaseSha,
    observedBaseSha: input.recovery.observedBaseSha,
    currentBaseSha: input.recovery.currentBaseSha,
  });
  if (!transitioned) return false;
  await tx.taskStepOutput.deleteMany({ where: { taskId: input.recovery.readinessTaskId } });
  await tx.task.update({
    where: { id: input.recovery.regressionTaskId },
    data: { status: TaskStatus.DONE, failureReason: null },
  });
  await tx.task.update({
    where: { id: input.recovery.readinessTaskId },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  await tx.task.update({
    where: { id: input.recovery.integratorTaskId },
    data: {
      status: TaskStatus.REVIEW,
      failureReason: `Automatic base-drift recovery ${String(input.recovery.attempt)} resumed after verified regression head adoption`,
    },
  });
  const body = `Automatic base-drift recovery ${String(input.recovery.attempt)} reopened the verified Regression result for fresh readiness authorization`;
  const metadata = {
    aggregateId: input.recovery.aggregateId,
    sourceStopId: input.recovery.sourceStopId,
    recoveryRunId: input.recovery.recoveryRunId,
    state: "reopened-head-adoption",
  };
  for (const taskId of [input.recovery.integratorTaskId, input.recovery.regressionTaskId]) {
    await writeMarker(tx, taskId, "baseDriftRecovery", { actorType: "control-plane", body, metadata });
  }
  return true;
};

/**
 * The state name a settle records, and the family its stop notice dedupes on.
 * A class ceiling takes its name from the same entry that owns its durable
 * refusal code, so the two cannot drift apart.
 */
export const recoveryClassSettleState = (retryClass: RetryClass): MergeRecoveryClassSettleState => (
  MERGE_RECOVERY_CLASS_SETTLE[MERGE_RECOVERY_RETRY_CLASS_ENUM[retryClass]].state
);

export type RecoverySettleState = "ineligible" | "exhausted" | MergeRecoveryClassSettleState;

/**
 * A recovery's terminal settle. `revalidations` generations the stop notice
 * and the operator question: after a `re-validate`, the same class can settle
 * again, and reusing the first key would deduplicate that second ceiling into
 * silence.
 */
export const exhaust = async (
  tx: DbTx,
  input: {
    aggregateId: string;
    integratorTaskId: string;
    sourceStopId: string;
    reason: string;
    at: Date;
    attempt: number;
    state: RecoverySettleState;
    revalidations?: number;
    recoveryData: MergeRecoveryTransitionData;
    markerMetadata: Record<string, unknown>;
  },
): Promise<void> => {
  await transitionMergeRecovery(tx, input.aggregateId, MergeRecoveryStatus.FAILED, {
    ...input.recoveryData,
    failureReason: input.reason,
    endedAt: input.at,
  });
  const body = input.state === "ineligible"
    ? `Automatic pre-merge base-drift recovery refused: ${input.reason}`
    : input.state === "exhausted"
      ? `Automatic pre-merge base-drift recovery exhausted at attempt ${String(input.attempt)}`
      : `Automatic pre-merge base-drift recovery settled on ${input.state}: ${input.reason}`;
  await tx.task.update({ where: { id: input.integratorTaskId }, data: {
    status: TaskStatus.REVIEW,
    failureReason: input.state === "ineligible"
      ? `Automatic base-drift recovery refused: ${input.reason}`
      : input.reason,
  } });
  await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", {
    actorType: "control-plane",
    body,
    metadata: {
      state: input.state,
      ...input.markerMetadata,
      integratorTaskId: input.integratorTaskId,
      sourceStopId: input.sourceStopId,
      reason: input.reason,
    },
  });
  const generation = input.revalidations ? `:r${String(input.revalidations)}` : "";
  const dedupeKey = `merge-base-drift-recovery:${input.state}:${input.sourceStopId}${generation}`;
  await stopNotice(tx, {
    taskId: input.integratorTaskId,
    body: `Automatic pre-merge base-drift recovery ${input.state} for stop ${input.sourceStopId}: ${input.reason}. No regression run or re-authorization was created.`,
    dedupeKey,
  });
};

type RetryCounterFields = {
  attempts: "waitingAttempts" | "transportAttempts" | "validationAttempts";
  firstAt: "waitingFirstAt" | "transportFirstAt" | "validationFirstAt";
};

const RETRY_COUNTER_FIELDS: Record<RetryClass, RetryCounterFields> = {
  waiting: { attempts: "waitingAttempts", firstAt: "waitingFirstAt" },
  transport: { attempts: "transportAttempts", firstAt: "transportFirstAt" },
  validation: { attempts: "validationAttempts", firstAt: "validationFirstAt" },
};

/**
 * Records one deferred classification against its own class, holds the next
 * tick until the backoff expires, and states the whole accounting in the
 * recovery activity: which class, its counter, how long that class has been
 * failing, and when the recovery is eligible again. A class transition is
 * named explicitly, because "waiting turned into transport" is exactly what an
 * operator reading a stalled recovery needs to see.
 */
export const recordRecoveryRetry = async (
  tx: DbTx,
  input: {
    attempt: MergeRecoveryAttempt;
    integratorTaskId: string;
    sourceStopId: string;
    decision: RetryBudgetRetry;
    maxValidationAttempts: number;
  },
): Promise<MergeRecoveryAttempt> => {
  const { decision } = input;
  const fields = RETRY_COUNTER_FIELDS[decision.retryClass];
  const previousClass = input.attempt.lastRetryClass;
  const nextClass = MERGE_RECOVERY_RETRY_CLASS_ENUM[decision.retryClass];
  const updated = await tx.mergeRecoveryAttempt.update({
    where: { id: input.attempt.id },
    data: {
      [fields.attempts]: decision.classAttempt,
      [fields.firstAt]: decision.firstFailedAt,
      nextEligibleAt: decision.nextEligibleAt,
      lastRetryClass: nextClass,
      failureReason: decision.reason,
    },
  });
  const budget = decision.retryClass === "validation"
    ? `${String(decision.classAttempt)}/${String(input.maxValidationAttempts)}`
    : String(decision.classAttempt);
  const classChanged = previousClass !== null && previousClass !== nextClass;
  await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", {
    actorType: "control-plane",
    body: `Automatic pre-merge base-drift classification deferred as ${decision.retryClass}`
      + ` (attempt ${budget}, ${formatElapsed(decision.elapsedMs)} in class,`
      + ` ${decision.nextEligibleAt ? `next eligible ${decision.nextEligibleAt.toISOString()}` : "eligible now"})`
      + `: ${decision.reason}`,
    metadata: {
      state: "classification-retry",
      integratorTaskId: input.integratorTaskId,
      sourceStopId: input.sourceStopId,
      retryClass: decision.retryClass,
      previousRetryClass: previousClass,
      classChanged,
      classAttempt: decision.classAttempt,
      classElapsedMs: decision.elapsedMs,
      nextEligibleAt: decision.nextEligibleAt?.toISOString() ?? null,
      waitingAttempts: updated.waitingAttempts,
      transportAttempts: updated.transportAttempts,
      validationAttempts: updated.validationAttempts,
      maxValidationAttempts: input.maxValidationAttempts,
      reason: decision.reason,
    },
  });
  return updated;
};

/**
 * The failure that crossed a class ceiling, persisted before the settle that
 * it caused. Without this the terminal failure would be the one classification
 * never written down, and the refusal text ("30 classification failures") would
 * outrun the counter the attempt actually carries. The backoff is cleared: a
 * settled attempt has no next tick to hold.
 */
export const recordRecoveryClassCeiling = async (
  tx: DbTx,
  input: { attempt: MergeRecoveryAttempt; decision: RetryBudgetCeiling },
): Promise<MergeRecoveryAttempt> => {
  const { decision } = input;
  const fields = RETRY_COUNTER_FIELDS[decision.retryClass];
  return tx.mergeRecoveryAttempt.update({
    where: { id: input.attempt.id },
    data: {
      [fields.attempts]: decision.classAttempt,
      [fields.firstAt]: decision.firstFailedAt,
      nextEligibleAt: null,
      lastRetryClass: MERGE_RECOVERY_RETRY_CLASS_ENUM[decision.retryClass],
    },
  });
};

/** The counters a settle states, so its activity and the attempt agree. */
export const recoveryClassCounters = (attempt: MergeRecoveryAttempt): Record<string, unknown> => ({
  waitingAttempts: attempt.waitingAttempts,
  transportAttempts: attempt.transportAttempts,
  validationAttempts: attempt.validationAttempts,
  nextEligibleAt: attempt.nextEligibleAt?.toISOString() ?? null,
});

export const retireLegacyRefusal = async (
  tx: DbTx,
  input: {
    aggregateId: string;
    integratorTaskId: string;
    sourceStopId: string;
    priorReason: string | null;
    reason: string;
    at: Date;
  },
): Promise<void> => {
  const retiredReason = `Historical base-drift recovery refusal retired after current validation: ${input.reason}`;
  await tx.mergeRecoveryAttempt.update({
    where: { id: input.aggregateId },
    data: { failureReason: retiredReason, refusalCode: null, endedAt: input.at },
  });
  await tx.task.update({ where: { id: input.integratorTaskId }, data: {
    status: TaskStatus.REVIEW,
    failureReason: `Automatic base-drift recovery refused: ${input.reason}`,
  } });
  await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", {
    actorType: "control-plane",
    body: retiredReason,
    metadata: {
      state: "legacy-refusal-retired",
      integratorTaskId: input.integratorTaskId,
      sourceStopId: input.sourceStopId,
      priorReason: input.priorReason,
      reason: input.reason,
    },
  });
};

export const RECOVERY_HEAD_ADOPTION_CONFLICT_MESSAGE =
  "Recovery authorization could not adopt the verified regression head";

export const adoptRecoveryHead = async (
  tx: DbTx,
  input: {
    recovery: RecoveryContext;
    currentBaseSha: string;
    authorizedHeadSha: string;
  },
): Promise<void> => {
  const adopted = await tx.mergeRecoveryAttempt.updateMany({
    where: {
      id: input.recovery.aggregateId,
      status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
      recoveryRunId: input.recovery.recoveryRunId,
      currentBaseSha: input.recovery.currentBaseSha,
      authorizedHeadSha: input.recovery.authorizedHeadSha,
    },
    data: {
      currentBaseSha: input.currentBaseSha,
      authorizedHeadSha: input.authorizedHeadSha,
    },
  });
  if (adopted.count !== 1) {
    throw new Error(RECOVERY_HEAD_ADOPTION_CONFLICT_MESSAGE);
  }
};
