import {
  ACTIVE_RUN_STATUSES,
  attemptRunBirth,
  InboxDeliveryStatus,
  InboxStatus,
  BASE_DRIFT_RETRY_BACKOFF_CAP_MS,
  BASE_DRIFT_RETRY_BACKOFF_START_MS,
  BASE_DRIFT_TRANSPORT_CEILING_MS,
  BASE_DRIFT_VALIDATION_MIN_ELAPSED_MS,
  BASE_DRIFT_WAITING_CEILING_MS,
  INTEGRATOR_OUTPUT_KIND,
  MAX_BASE_DRIFT_VALIDATION_ATTEMPTS,
  MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES,
  MAX_AUTOMATIC_CI_FAILURE_RECOVERIES,
  MERGE_TAIL_KIND,
  MERGE_RECOVERY_CLASS_REFUSAL_CODE,
  MERGE_RECOVERY_RETRY_CLASS_ENUM,
  MergeRecoveryStatus,
  MERGE_INTEGRATOR_KIND,
  Prisma,
  TaskStatus,
  asJsonObject,
  isMergeReadinessStep,
  latestRecordedStop,
  lockChainRows,
  openDeferredBaseDriftQuestion,
  pendingIntegratorAuthorization,
  parseRecoverableMergeEvidence,
  isCiFailureRecoveryStop,
  replayHeldIntegratorAuthorization,
  recordLeaseHandoff,
  writeMarker,
  parseMergeResult,
  readLatestMarker,
  recordIntegratorStop,
  requireDefaultFeishuThread,
  openRun,
  refundForLostRun,
  reopenRefundedRun,
  carryMergeRecoveryRun,
  mergeRecoveryCarryReadiness,
  recoveryContext,
  transitionMergeRecovery,
  REGRESSION_VERIFICATION_OUTPUT_KINDS,
  resolveChainTarget,
  selectAuthorization,
  taskIsIntegratorStep,
  type CardRow,
  type CandidateActivity,
  type DecisionRow,
  type PrismaClient,
  type MergeRecoveryAttempt,
} from "@anneal/db";

import { withMergeLease, type WithMergeLease } from "./merge-lease.js";

import { GitHubReadError, type PullRequestReader, type PullRequestSnapshot } from "./github-read.js";
import { redactCiLog } from "./ci-log-redaction.js";
import {
  classifyCandidate,
  classifyDurable,
  classifyFresh,
  classifyRetryBudget,
  recoveryDeferred,
  type DurableCandidateFacts,
  type FreshDecision,
  type Ineligible,
  type RecoveryCandidate,
  type RecoveryIdentity,
  type Retry,
  type RetryBudgetPolicy,
  type RetryClass,
} from "./base-drift-recovery-decision.js";
import { regressionVerdictForRun, stopMergeTail } from "./merge-tail-actions.js";
import { classifyHeadCheckFailures, type FailedHeadCheck } from "./ci-failure-recovery.js";
import {
  ensureRecoveryValidation,
  blockDownstream,
  enterRepair,
  recordRecoveryClassCeiling,
  recordRecoveryRetry,
  recoveryClassCounters,
  recoveryIsReopenableLegacyRefusal,
  retireLegacyRefusal,
} from "./merge-tail-state.js";

type DbReader = PrismaClient | Prisma.TransactionClient;

/**
 * The one retry policy this worker classifies against. It is stated here, next
 * to the tick that applies it, and its numbers live in `@anneal/db` beside the
 * recovery budget they belong to.
 */
const RETRY_BUDGET_POLICY: RetryBudgetPolicy = {
  maxValidationAttempts: MAX_BASE_DRIFT_VALIDATION_ATTEMPTS,
  validationMinElapsedMs: BASE_DRIFT_VALIDATION_MIN_ELAPSED_MS,
  waitingCeilingMs: BASE_DRIFT_WAITING_CEILING_MS,
  transportCeilingMs: BASE_DRIFT_TRANSPORT_CEILING_MS,
  backoffStartMs: BASE_DRIFT_RETRY_BACKOFF_START_MS,
  backoffCapMs: BASE_DRIFT_RETRY_BACKOFF_CAP_MS,
};

export const baseDriftRecoveryPollIntervalMs = (): number => {
  const raw = Number(process.env.MERGE_BASE_DRIFT_RECOVERY_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 250 ? Math.floor(raw) : 2_000;
};

const recoveryAttemptFor = async (
  db: DbReader,
  integratorTaskId: string,
  sourceStopId: string,
): Promise<MergeRecoveryAttempt | null> => db.mergeRecoveryAttempt.findFirst({
  where: { integratorTaskId, sourceStopId },
  orderBy: [{ attempt: "desc" }, { id: "desc" }],
});

/**
 * Base-drift recovery mutates the three merge-tail Steps together, so it uses
 * the same ordered, whole-Chain mutex as every other chained-task writer.
 * Chain identity is immutable after dispatch and can select that mutex before
 * any mutable state is read.
 */
const lockRecoveryChain = async (
  tx: Prisma.TransactionClient,
  integratorTaskId: string,
): Promise<boolean> => {
  const identity = await tx.task.findUnique({
    where: { id: integratorTaskId },
    select: { projectId: true, chainId: true },
  });
  const chainId = identity?.chainId;
  if (!identity || !chainId) return false;
  const taskIds = await lockChainRows(tx, { projectId: identity.projectId, chainId });
  return taskIds.includes(integratorTaskId);
};

export const readCandidateFacts = async (
  db: DbReader,
  integratorTaskId: string,
): Promise<DurableCandidateFacts> => {
  const task = await db.task.findUnique({
    where: { id: integratorTaskId },
    include: { templateStep: { include: { taskTemplate: { select: { name: true } } } }, repo: true },
  });
  const facts: DurableCandidateFacts = {
    task: task ? {
      id: task.id,
      chainId: task.chainId,
      chainIndex: task.chainIndex,
      repoId: task.repoId,
      repositoryPresent: task.repo !== null,
      status: task.status,
      isIntegratorStep: taskIsIntegratorStep(task),
    } : null,
    stop: null,
    existingAttempt: null,
    sourceRun: null,
    activeRunCount: null,
    output: null,
    readiness: null,
    regression: null,
    authorizationSelection: null,
    intents: null,
    target: null,
    firstRunTargetRef: null,
  };
  if (!task || !facts.task?.isIntegratorStep) return facts;
  const stop = await latestRecordedStop(db as Prisma.TransactionClient, task.id);
  if (!stop) return facts;
  facts.stop = {
    stopId: stop.stopId,
    condition: stop.condition,
    evidence: stop.evidence,
    sourceRunId: stop.sourceRunId,
  };
  if (stop.condition !== "base-drift"
    && !parseRecoverableMergeEvidence(stop.condition, stop.evidence)
    && !isCiFailureRecoveryStop(stop.condition, stop.evidence)) return facts;
  const existingAttempt = await recoveryAttemptFor(db, task.id, stop.stopId);
  facts.existingAttempt = existingAttempt ? {
    status: existingAttempt.status,
    reopenableLegacyRefusal: recoveryIsReopenableLegacyRefusal(existingAttempt),
    nextEligibleAt: existingAttempt.nextEligibleAt,
  } : null;
  if (!task.chainId || task.chainIndex === null || !task.repoId || !task.repo) return facts;

  const [sourceRun, activeRunCount, output, readiness, regression, intentRows, target, firstRun] = await Promise.all([
    stop.sourceRunId ? db.run.findUnique({
      where: { id: stop.sourceRunId },
      include: { session: { select: { id: true } } },
    }) : null,
    db.run.count({
      where: { task: { projectId: task.projectId, chainId: task.chainId }, status: { in: ACTIVE_RUN_STATUSES } },
    }),
    db.taskStepOutput.findUnique({ where: { taskId: task.id } }),
    db.task.findFirst({
      where: { projectId: task.projectId, chainId: task.chainId, chainIndex: task.chainIndex - 1 },
      include: { templateStep: { include: { taskTemplate: { select: { name: true } } } }, stepOutput: true },
    }),
    db.task.findFirst({
      where: {
        projectId: task.projectId,
        chainId: task.chainId,
        templateStep: { outputKind: { in: [...REGRESSION_VERIFICATION_OUTPUT_KINDS] } },
      },
    }),
    db.taskActivity.findMany({
      where: { taskId: task.id, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.intent } },
      orderBy: { createdAt: "asc" }, select: { metadata: true },
    }),
    resolveChainTarget(db as Prisma.TransactionClient, task),
    db.run.findFirst({
      where: { task: { projectId: task.projectId, chainId: task.chainId, chainIndex: { not: null } } },
      orderBy: [{ task: { chainIndex: "asc" } }, { runNumber: "asc" }], select: { targetBranch: true },
    }),
  ]);
  facts.sourceRun = sourceRun ? {
    id: sourceRun.id,
    taskId: sourceRun.taskId,
    status: sourceRun.status,
    hasSession: sourceRun.session !== null,
  } : null;
  facts.activeRunCount = activeRunCount;
  if (output && parseMergeResult(output).outcome === "deferred") {
    facts.stop = null;
    return facts;
  }
  if (output) {
    const result = parseMergeResult(output);
    facts.output = {
      runId: output.runId,
      kind: output.kind,
      outcome: result.outcome,
      condition: result.outcome === "stopped" ? result.condition : null,
      evidence: result.outcome === "stopped" ? result.evidence : null,
    };
  }
  facts.readiness = readiness ? {
    id: readiness.id,
    status: readiness.status,
    isReadinessStep: isMergeReadinessStep(readiness.templateStep),
    outputCommitSha: readiness.stepOutput?.commitSha ?? null,
  } : null;
  facts.regression = regression ? { id: regression.id, status: regression.status } : null;
  facts.intents = intentRows
    .map((row) => asJsonObject(row.metadata))
    .filter((metadata): metadata is NonNullable<typeof metadata> => metadata !== null);
  facts.target = target.resolved
    ? { resolved: true, repository: target.repository, prNumber: target.prNumber }
    : { resolved: false, unresolvable: target.unresolvable };
  facts.firstRunTargetRef = firstRun?.targetBranch ?? null;

  if (!readiness) return facts;

  const activities = await db.taskActivity.findMany({
    where: { taskId: readiness.id }, orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, actorType: true, metadata: true },
  });
  const cards = await db.inboxMessage.findMany({
    where: { gateTaskId: readiness.id },
    select: { id: true, gateTaskId: true, status: true, selectedChoiceId: true, body: true },
  });
  const decisions = await db.inboxDecision.findMany({
    where: { inboxMessageId: { in: cards.map((card) => card.id) } },
    select: { id: true, decision: true, createdAt: true, inboxMessageId: true },
  });
  const selection = selectAuthorization(
    activities as CandidateActivity[], decisions as DecisionRow[], cards as CardRow[], readiness.id,
  );
  facts.authorizationSelection = {
    authorization: selection.authorization ? {
      activityId: selection.authorization.activityId,
      repository: selection.authorization.repository,
      prNumber: selection.authorization.prNumber,
      headSha: selection.authorization.headSha,
      baseSha: selection.authorization.baseSha,
      baseRef: selection.authorization.baseRef,
    } : null,
    refusal: selection.refusal,
  };
  return facts;
};

/**
 * What a settle needs to reach the operator: the resume generation this
 * attempt has already spent, and whether a class ceiling makes `re-validate`
 * offerable. Every settle carries the generation, not only the ceilings — a
 * recovery an operator resumed can settle again, and the answered first card
 * would otherwise deduplicate the second settle into a task with no open
 * question and no way out.
 */
const openRecoveryQuestion = openDeferredBaseDriftQuestion;

/** A settle a retry class owns: the class, and the instant the classification
 *  that ended it was taken at. */
type RetryClassCeiling = { retryClass: RetryClass; at: Date };

const settleIneligibleLocked = async (
  tx: Prisma.TransactionClient,
  integratorTaskId: string,
  stopId: string,
  reason: string,
  identity?: Partial<RecoveryIdentity>,
  ceiling?: RetryClassCeiling,
): Promise<void> => {
  const attempt = await ensureRecoveryValidation(tx, { integratorTaskId, sourceStopId: stopId });
  await stopMergeTail(tx, {
    phase: "recovery-validation",
    aggregateId: attempt.id,
    integratorTaskId,
    sourceStopId: stopId,
    reason,
    at: ceiling?.at ?? new Date(),
    attempt: attempt.attempt,
    revalidations: attempt.revalidations,
    ...(ceiling ? { retryClass: ceiling.retryClass } : {}),
    recoveryData: {
      ...(ceiling
        ? { refusalCode: MERGE_RECOVERY_CLASS_REFUSAL_CODE[MERGE_RECOVERY_RETRY_CLASS_ENUM[ceiling.retryClass]] }
        : {}),
      ...(identity?.repository ? { repository: identity.repository } : {}),
      ...(identity?.prNumber ? { prNumber: identity.prNumber } : {}),
      ...(identity?.targetBranch ? { targetBranch: identity.targetBranch } : {}),
      ...(identity?.authorizedHeadSha ? { authorizedHeadSha: identity.authorizedHeadSha } : {}),
      ...(identity?.authorizedBaseSha ? { authorizedBaseSha: identity.authorizedBaseSha } : {}),
      ...(identity?.observedBaseSha ? { observedBaseSha: identity.observedBaseSha } : {}),
    },
    markerMetadata: {
      ...identity,
      ...recoveryClassCounters(attempt),
      ...(ceiling ? { retryClass: ceiling.retryClass } : {}),
    },
  });
  await openRecoveryQuestion(tx, integratorTaskId, stopId, {
    revalidations: attempt.revalidations,
    ceiling: ceiling !== undefined,
    reason,
  });
};

const settleIneligible = async (
  db: PrismaClient,
  integratorTaskId: string,
  stopId: string,
  reason: string,
  identity?: Partial<RecoveryIdentity>,
): Promise<boolean> => db.$transaction(async (tx) => {
  if (!await lockRecoveryChain(tx, integratorTaskId)) return false;
  const currentStop = await latestRecordedStop(tx, integratorTaskId);
  if (currentStop?.stopId !== stopId) return false;
  const currentTask = await tx.task.findUnique({ where: { id: integratorTaskId }, select: { status: true } });
  if (currentTask?.status !== TaskStatus.REVIEW) return false;
  const existing = await recoveryAttemptFor(tx, integratorTaskId, stopId);
  if (existing && existing.status !== MergeRecoveryStatus.VALIDATING) {
    if (!recoveryIsReopenableLegacyRefusal(existing)) return false;
    await retireLegacyRefusal(tx, {
      aggregateId: existing.id,
      integratorTaskId,
      sourceStopId: stopId,
      priorReason: existing.failureReason,
      reason,
      at: new Date(),
    });
    await openRecoveryQuestion(tx, integratorTaskId, stopId, {
      revalidations: existing.revalidations,
      ceiling: false,
      reason,
    });
    return true;
  }
  await settleIneligibleLocked(tx, integratorTaskId, stopId, reason, identity);
  return true;
});

/**
 * The worker's one retry-accounting transaction: classify this tick's failure
 * against its own class, then either hold the recovery on its backoff or
 * settle it on that class's ceiling. The tick calls it for every retry; the
 * recovery dbtests drive it directly to reach classes no live GitHub can
 * produce on demand.
 */
export const recordRecoveryClassificationRetry = async (
  db: PrismaClient,
  integratorTaskId: string,
  stopId: string,
  retry: Retry,
  now: Date,
): Promise<"retryable" | "ineligible" | "skipped"> => db.$transaction(async (tx) => {
  if (!await lockRecoveryChain(tx, integratorTaskId)) return "skipped";
  const currentStop = await latestRecordedStop(tx, integratorTaskId);
  if (currentStop?.stopId !== stopId) return "skipped";
  const attempt = await ensureRecoveryValidation(tx, { integratorTaskId, sourceStopId: stopId });
  if (attempt.status !== MergeRecoveryStatus.VALIDATING) return "skipped";
  const decision = classifyRetryBudget({
    reason: retry.reason,
    retryClass: retry.retryClass,
    now,
    attempts: {
      waiting: attempt.waitingAttempts,
      transport: attempt.transportAttempts,
      validation: attempt.validationAttempts,
    },
    firstFailedAt: {
      waiting: attempt.waitingFirstAt,
      transport: attempt.transportFirstAt,
      validation: attempt.validationFirstAt,
    },
    policy: RETRY_BUDGET_POLICY,
  });
  switch (decision.kind) {
    case "ineligible":
      // The failure that crossed the ceiling is accounted before the settle it
      // caused, so the refusal text and the stored counters state the same
      // number of failures.
      await recordRecoveryClassCeiling(tx, { attempt, decision });
      await settleIneligibleLocked(
        tx, integratorTaskId, stopId, decision.reason, undefined,
        { retryClass: decision.retryClass, at: now },
      );
      return "ineligible";
    case "retry":
      break;
  }
  await recordRecoveryRetry(tx, {
    attempt,
    integratorTaskId,
    sourceStopId: stopId,
    decision,
    maxValidationAttempts: RETRY_BUDGET_POLICY.maxValidationAttempts,
  });
  return "retryable";
});

type QueueRecoveryResult =
  | { kind: "recovered" }
  | { kind: "exhausted" }
  | { kind: "skip" }
  | { kind: "ineligible"; reason: string }
  | Retry;

type CiFailureEvidence = {
  fingerprint: string;
  failures: Array<{ name: string; conclusion: string; log: string }>;
};

const readCiFailureEvidence = async (
  reader: PullRequestReader,
  snapshot: PullRequestSnapshot,
  candidate: RecoveryCandidate,
): Promise<CiFailureEvidence> => {
  const classified = classifyHeadCheckFailures(snapshot, candidate.authorizedHeadSha);
  if (classified.kind !== "failed") {
    throw new Error(classified.kind === "none"
      ? "no terminal failed check remains on the authorized PR head"
      : classified.reason);
  }
  if (classified.checks.length > 8) throw new Error("more than eight failed checks require unavailable bounded log evidence");
  if (!reader.readActionsFailureLog) throw new Error("GitHub Actions job log reader is unavailable");
  const failures = await Promise.all(classified.checks.map(async (check: FailedHeadCheck) => {
    if (check.kind !== "CheckRun") throw new Error(`status context ${check.name} has no GitHub Actions job log`);
    const log = await reader.readActionsFailureLog!(candidate.repository, candidate.authorizedHeadSha,
      { name: check.name, detailsUrl: check.detailsUrl }, AbortSignal.timeout(8_000));
    return { name: check.name, conclusion: check.conclusion, log: redactCiLog(log) };
  }));
  return { fingerprint: classified.fingerprint, failures };
};

// Node fetch wraps both socket failures and invalid-port failures as
// TypeError("fetch failed"); only recognized network/Undici causes are retryable.
const retryableFetchErrorCodes = new Set([
  "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "EHOSTDOWN", "EHOSTUNREACH",
  "ENETDOWN", "ENETUNREACH", "ENOTFOUND", "EPIPE", "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
]);

const hasRetryableFetchCause = (error: TypeError): boolean => {
  let cause: unknown = (error as TypeError & { cause?: unknown }).cause;
  for (let depth = 0; depth < 5 && typeof cause === "object" && cause !== null; depth += 1) {
    const causeError = cause as { code?: unknown; cause?: unknown };
    if (typeof causeError.code === "string" && retryableFetchErrorCodes.has(causeError.code)) return true;
    cause = causeError.cause;
  }
  return false;
};

const retryableCiLogError = (error: unknown): boolean =>
  (error instanceof GitHubReadError && (error.kind === "transport" || error.kind === "timeout"))
  || (error instanceof TypeError && hasRetryableFetchCause(error))
  || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));

const describeCiLogError = (error: unknown): string => error instanceof TypeError
  ? `${error.name}: ${error.message}`
  : error instanceof Error ? error.message : String(error);

const queueRecovery = async (
  db: PrismaClient,
  expected: RecoveryCandidate,
  currentBaseSha: string,
  now: Date,
  ciEvidence?: CiFailureEvidence,
): Promise<QueueRecoveryResult> => db.$transaction(async (tx) => {
  if (!await lockRecoveryChain(tx, expected.integratorTaskId)) return { kind: "skip" };
  const aggregate = await ensureRecoveryValidation(tx, {
    integratorTaskId: expected.integratorTaskId,
    sourceStopId: expected.stopId,
    identity: expected,
  });
  const candidateFacts = await readCandidateFacts(tx, expected.integratorTaskId);
  if (candidateFacts.task?.chainId && await tx.chainControl.count({ where: {
    projectId: (await tx.task.findUniqueOrThrow({ where: { id: expected.integratorTaskId }, select: { projectId: true } })).projectId,
    chainId: candidateFacts.task.chainId, state: "HELD",
  } })) return { kind: "skip" };

  // A recovery spends an attempt only once it owns a fresh regression Run.
  // Validation refusals remain visible aggregate rows but do not consume the
  // two executor-drift attempts. Historical TaskActivity rows are deliberately
  // ignored: the migration has no backfill, so absence here means zero.
  //
  // The unit is the stop, not the row: automatic validation opens exactly one
  // row per source stop, while an operator rerun
  // (`POST /tasks/:taskId/merge-tail/rerun`) opens a further row for a stop
  // already counted here. Counting rows would let a rerun of a host-caused
  // gate FAIL spend an automatic recovery the branch never used.
  // External integrator replays are separate execution charges, so keep those
  // in the shared allowance while collapsing operator-rerun rows to one
  // automatic recovery charge per prior source stop.
  const ciHistory = expected.recoveryKind === "ci-failure"
    ? await tx.taskActivity.findMany({ where: {
      taskId: expected.integratorTaskId,
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: "mergeTail.ciFailureRecovery" },
    }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { metadata: true } })
    : [];
  const attempts = expected.recoveryKind === "ci-failure"
    ? await ciRecoveryAllowanceSpent(tx, expected.integratorTaskId, ciHistory)
    : await recoveryAllowanceSpent(tx, aggregate, { excludeSourceStopId: expected.stopId });
  const decision = classifyDurable({
    expected,
    candidateDecision: classifyCandidate(candidateFacts),
    aggregateValidating: aggregate.status === MergeRecoveryStatus.VALIDATING,
    recoveryCount: attempts,
    maxRecoveries: expected.recoveryKind === "ci-failure"
      ? MAX_AUTOMATIC_CI_FAILURE_RECOVERIES : MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES,
    currentBaseSha,
  });
  switch (decision.kind) {
    case "skip":
      return { kind: "skip" };
    case "retry":
      return { kind: "retry", retryClass: decision.retryClass, reason: decision.reason };
    case "ineligible":
      return { kind: "ineligible", reason: decision.reason };
    case "exhausted":
      break;
    case "queue":
      break;
  }
  const attempt = aggregate.attempt;
  const common = {
    sourceStopId: expected.stopId,
    sourceRunId: expected.sourceRunId,
    integratorTaskId: expected.integratorTaskId,
    authorizationActivityId: expected.authorizationActivityId,
    repository: expected.repository,
    prNumber: expected.prNumber,
    targetBranch: expected.targetBranch,
    authorizedHeadSha: expected.authorizedHeadSha,
    authorizedBaseSha: expected.authorizedBaseSha,
    observedBaseSha: expected.observedBaseSha,
    currentBaseSha,
    attempt,
    readinessTaskId: expected.readinessTaskId,
    regressionTaskId: expected.regressionTaskId,
  };
  if (expected.recoveryKind === "ci-failure" && decision.kind === "queue") {
    if (!ciEvidence || ciEvidence.failures.length === 0) {
      return { kind: "ineligible", reason: "CI failure evidence or job logs are unavailable" };
    }
    const previous = asJsonObject(ciHistory[0]?.metadata);
    if (previous?.headSha === expected.authorizedHeadSha
      && previous.fingerprint === ciEvidence.fingerprint) {
      await stopMergeTail(tx, {
        phase: "recovery-exhausted", aggregateId: aggregate.id,
        integratorTaskId: expected.integratorTaskId, sourceStopId: expected.stopId,
        reason: `CI checks ${ciEvidence.failures.map((failure) => failure.name).join(", ")} are unchanged and the Chain head has no code change`,
        at: now, attempt, revalidations: aggregate.revalidations,
        recoveryData: { boundSourceRunId: expected.sourceRunId,
          authorizationActivityId: expected.authorizationActivityId,
          readinessTaskId: expected.readinessTaskId, regressionTaskId: expected.regressionTaskId,
          repository: expected.repository, prNumber: expected.prNumber, targetBranch: expected.targetBranch,
          authorizedHeadSha: expected.authorizedHeadSha, authorizedBaseSha: expected.authorizedBaseSha,
          observedBaseSha: expected.observedBaseSha, currentBaseSha },
        markerMetadata: { ...common, reason: "ci-no-progress", fingerprint: ciEvidence.fingerprint },
      });
      await openRecoveryQuestion(tx, expected.integratorTaskId, expected.stopId, {
        revalidations: aggregate.revalidations, ceiling: false,
        reason: "CI checks are unchanged and the Chain head has no code change",
      });
      return { kind: "exhausted" };
    }
  }
  switch (decision.kind) {
    case "exhausted":
      await stopMergeTail(tx, {
        phase: "recovery-exhausted",
        aggregateId: aggregate.id,
        integratorTaskId: expected.integratorTaskId,
        sourceStopId: expected.stopId,
        reason: decision.reason,
        at: now,
        attempt,
        recoveryData: {
          boundSourceRunId: expected.sourceRunId,
          authorizationActivityId: expected.authorizationActivityId,
          readinessTaskId: expected.readinessTaskId,
          regressionTaskId: expected.regressionTaskId,
          repository: expected.repository,
          prNumber: expected.prNumber,
          targetBranch: expected.targetBranch,
          authorizedHeadSha: expected.authorizedHeadSha,
          authorizedBaseSha: expected.authorizedBaseSha,
          observedBaseSha: expected.observedBaseSha,
          currentBaseSha,
        },
        revalidations: aggregate.revalidations,
        markerMetadata: { ...common, ...recoveryClassCounters(aggregate) },
      });
      await openRecoveryQuestion(tx, expected.integratorTaskId, expected.stopId, {
        revalidations: aggregate.revalidations,
        ceiling: false,
        reason: decision.reason,
      });
      return { kind: "exhausted" };
    case "queue":
      break;
  }

  const queued = await enterRepair(tx, { aggregateId: aggregate.id, currentBaseSha, now,
    automaticDisposition: { condition: candidateFacts.stop?.condition ?? "base-drift",
      ordinal: attempts + 1,
      remaining: (expected.recoveryKind === "ci-failure"
        ? MAX_AUTOMATIC_CI_FAILURE_RECOVERIES : MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES) - attempts - 1,
      ...(ciEvidence ? { ciFailures: ciEvidence.failures } : {}) } });
  if (!queued) return { kind: "ineligible", reason: "CI recovery Regression Run birth was refused" };
  if (ciEvidence) {
    await tx.taskActivity.create({ data: {
      taskId: expected.integratorTaskId, actorType: "control-plane",
      body: `Automatic CI failure recovery for ${candidateFacts.stop?.condition}: ${ciEvidence.failures.map((failure) => failure.name).join(", ")}; attempt ${attempts + 1}/${MAX_AUTOMATIC_CI_FAILURE_RECOVERIES}, remaining ${MAX_AUTOMATIC_CI_FAILURE_RECOVERIES - attempts - 1}`,
      metadata: { kind: "mergeTail.ciFailureRecovery", condition: candidateFacts.stop?.condition ?? null,
        stopId: expected.stopId, headSha: expected.authorizedHeadSha,
        fingerprint: ciEvidence.fingerprint, checkNames: ciEvidence.failures.map((failure) => failure.name),
        ordinal: attempts + 1, remaining: MAX_AUTOMATIC_CI_FAILURE_RECOVERIES - attempts - 1,
        recoveryRunId: queued.recoveryRunId },
    } });
  }
  return { kind: "recovered" };
});

type RecoveryTickDelta = { recovered: number; exhausted: number; ineligible: number };

type RecoverySettlementTask = {
  id: string;
  identity?: Partial<RecoveryIdentity>;
};

type RecoverySettlementDecision = Retry | Ineligible | QueueRecoveryResult;

const settleRecovery = async (
  db: PrismaClient,
  task: RecoverySettlementTask,
  stopId: string,
  decision: RecoverySettlementDecision,
  now: Date,
): Promise<RecoveryTickDelta> => {
  const tickDelta: RecoveryTickDelta = { recovered: 0, exhausted: 0, ineligible: 0 };
  switch (decision.kind) {
    case "skip":
      return tickDelta;
    case "recovered":
      return { ...tickDelta, recovered: 1 };
    case "exhausted":
      return { ...tickDelta, exhausted: 1 };
    case "retry": {
      const outcome = await recordRecoveryClassificationRetry(db, task.id, stopId, decision, now);
      return outcome === "ineligible" ? { ...tickDelta, ineligible: 1 } : tickDelta;
    }
    case "ineligible": {
      const settled = await settleIneligible(db, task.id, stopId, decision.reason, task.identity);
      return settled ? { ...tickDelta, ineligible: 1 } : tickDelta;
    }
  }
};

export type BaseDriftRecoveryTickResult = { examined: number; recovered: number; exhausted: number; ineligible: number };

const MERGEABILITY_WAIT_CEILING_MS = BASE_DRIFT_WAITING_CEILING_MS;

const settleMergeabilityWaitStop = async (
  db: PrismaClient,
  input: { taskId: string; sourceRunId: string; condition: "unresolved-mergeability" | "api-error";
    reason: string; now: Date },
): Promise<void> => {
  await db.$transaction(async (tx) => {
    if (!await lockRecoveryChain(tx, input.taskId)) return;
    const marker = await readLatestMarker(tx, input.taskId, "mergeabilityWait");
    if (marker?.state !== "deferred" || marker.raw.sourceRunId !== input.sourceRunId) return;
    const firstDeferredAt = typeof marker.raw.firstDeferredAt === "string" ? marker.raw.firstDeferredAt : null;
    const elapsedMs = firstDeferredAt ? input.now.getTime() - Date.parse(firstDeferredAt) : null;
    const evidence = JSON.stringify({ reason: input.reason, observed: marker.raw.observed ?? null,
      elapsedMs, sourceRunId: input.sourceRunId });
    await recordIntegratorStop(tx, { integratorTaskId: input.taskId,
      condition: input.condition, evidence, sourceRunId: input.sourceRunId });
    await writeMarker(tx, input.taskId, "mergeabilityWait", "stopped", {
      actorType: "control-plane",
      body: `Mergeability wait stopped: ${input.reason}; waited ${elapsedMs ?? "unknown"}ms`,
      metadata: { condition: input.condition, sourceRunId: input.sourceRunId,
        observed: marker.raw.observed ?? null, elapsedMs,
        ordinal: marker.raw.ordinal ?? null, remainingMs: 0 },
    });
  });
};

const retryMergeabilityTransport = async (
  db: PrismaClient,
  taskId: string,
  marker: NonNullable<Awaited<ReturnType<typeof readLatestMarker>>>,
  sourceRunId: string,
  reason: string,
  now: Date,
): Promise<void> => {
  const firstFailedAt = typeof marker.raw.transportFirstAt === "string"
    ? Date.parse(marker.raw.transportFirstAt) : now.getTime();
  const attempt = typeof marker.raw.transportAttempts === "number" ? marker.raw.transportAttempts + 1 : 1;
  if (!Number.isFinite(firstFailedAt) || attempt >= 30 || now.getTime() - firstFailedAt >= BASE_DRIFT_TRANSPORT_CEILING_MS) {
    await settleMergeabilityWaitStop(db, { taskId, sourceRunId, condition: "api-error",
      reason: `${reason}; transport retry ceiling exhausted after ${attempt} attempts`, now });
    return;
  }
  const backoffMs = Math.min(BASE_DRIFT_RETRY_BACKOFF_CAP_MS,
    BASE_DRIFT_RETRY_BACKOFF_START_MS * 2 ** Math.min(attempt - 1, 10));
  await writeMarker(db, taskId, "mergeabilityWait", "deferred", {
    actorType: "control-plane", body: `${reason}; transport retry ${attempt}/30 in ${backoffMs}ms`,
    metadata: { ...marker.raw, transportFirstAt: new Date(firstFailedAt).toISOString(),
      transportAttempts: attempt, nextEligibleAt: new Date(now.getTime() + backoffMs).toISOString(),
      remainingTransportAttempts: 30 - attempt,
      remainingTransportMs: BASE_DRIFT_TRANSPORT_CEILING_MS - (now.getTime() - firstFailedAt) },
  });
};

export const pendingMergeabilityTick = async (
  db: PrismaClient,
  now = new Date(),
  limit = 5,
  leased: WithMergeLease = withMergeLease,
): Promise<number> => {
  let queued = 0;
  let examined = 0;
  const candidates = await db.$queryRaw<Array<{ taskId: string }>>(Prisma.sql`
    SELECT task.id AS "taskId"
    FROM "Task" AS task
    JOIN "TaskTemplateStep" AS step ON step.id = task."templateStepId"
    JOIN LATERAL (
      SELECT activity.metadata
      FROM "TaskActivity" AS activity
      WHERE activity."taskId" = task.id
        AND activity."actorType" = 'control-plane'
        AND activity.metadata->>'kind' = 'mergeTail.mergeabilityWait'
      ORDER BY activity."createdAt" DESC, activity.id DESC
      LIMIT 1
    ) AS wait_marker ON true
    WHERE task.status::text = 'review'
      AND task."chainId" IS NOT NULL
      AND step."outputKind" = ${INTEGRATOR_OUTPUT_KIND}
      AND wait_marker.metadata->>'state' = 'deferred'
      AND COALESCE(wait_marker.metadata->>'nextEligibleAt', '') <= ${now.toISOString()}
      AND NOT EXISTS (SELECT 1 FROM "ChainControl" AS control
        WHERE control."projectId" = task."projectId" AND control."chainId" = task."chainId"
          AND control.state::text = 'held')
      AND (COALESCE(wait_marker.metadata->>'firstDeferredAt', '') <= ${new Date(now.getTime() - MERGEABILITY_WAIT_CEILING_MS).toISOString()}
        OR NOT EXISTS (SELECT 1 FROM "MergeLeaseEvent" AS lease_event
          WHERE lease_event."projectId" = task."projectId" AND lease_event."chainId" = task."chainId"
            AND lease_event.state::text IN ('handoff-pending', 'release-deferred')))
    ORDER BY wait_marker.metadata->>'nextEligibleAt' ASC, task.id ASC
    LIMIT ${Math.max(limit * 20, 100)}
  `);
  for (const row of candidates) {
      if (examined >= limit) break;
      try {
        const task = await db.task.findUnique({ where: { id: row.taskId },
          select: { id: true, projectId: true, chainId: true, status: true } });
        if (!task?.chainId || task.status !== TaskStatus.REVIEW) continue;
        const marker = await readLatestMarker(db, task.id, "mergeabilityWait");
        if (marker?.state !== "deferred") continue;
        const disposition = await processPendingMergeability(db,
          { id: task.id, projectId: task.projectId, chainId: task.chainId }, marker, now, leased);
        if (disposition.attempted) examined += 1;
        queued += disposition.queued;
      } catch (error: unknown) {
        const reason = `automatic mergeability recheck failed for ${row.taskId}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(reason);
        try {
          let sourceRunId: string | null = null;
          try {
            const marker = await readLatestMarker(db, row.taskId, "mergeabilityWait");
            sourceRunId = marker?.state === "deferred" && typeof marker.raw.sourceRunId === "string"
              ? marker.raw.sourceRunId : null;
          } catch (readError: unknown) {
            console.error(reason, readError);
          }
          if (sourceRunId) {
            await settleMergeabilityWaitStop(db, { taskId: row.taskId, sourceRunId,
              condition: "api-error", reason, now });
          } else {
            await db.$transaction(async (tx) => {
              const thread = await requireDefaultFeishuThread(tx);
              const dedupeKey = `mergeability-wait-error:${row.taskId}`;
              await tx.task.update({ where: { id: row.taskId }, data: {
                status: TaskStatus.REVIEW, failureReason: reason,
              } });
              const existing = await tx.inboxMessage.findUnique({ where: { dedupeKey }, select: { status: true } });
              const reopened = existing?.status === InboxStatus.CLOSED
                ? await tx.inboxMessage.updateMany({
                  where: { dedupeKey, status: InboxStatus.CLOSED },
                  data: {
                    status: InboxStatus.OPEN,
                    answeredAt: null,
                    body: reason,
                    threadId: thread.id,
                    deliveryStatus: InboxDeliveryStatus.PENDING,
                    deliveredAt: null,
                    nextDeliveryAt: now,
                  },
                })
                : null;
              if (reopened?.count !== 1) {
                await tx.inboxMessage.upsert({
                  where: { dedupeKey },
                  create: { from: "AGENT", taskId: row.taskId, threadId: thread.id, kind: "TEXT", body: reason, dedupeKey },
                  update: { status: InboxStatus.OPEN, answeredAt: null, body: reason, threadId: thread.id },
                });
              }
              await writeMarker(tx, row.taskId, "mergeabilityWait", "stopped", {
                actorType: "control-plane", body: reason,
                metadata: { condition: "api-error", sourceRunId: null, remainingMs: 0 },
              });
            });
          }
        } catch (recordError: unknown) { console.error(reason, recordError); }
      }
  }
  return queued;
};

const processPendingMergeability = async (
  db: PrismaClient,
  task: { id: string; projectId: string; chainId: string },
  marker: NonNullable<Awaited<ReturnType<typeof readLatestMarker>>>,
  now: Date,
  leased: WithMergeLease,
): Promise<{ attempted: boolean; queued: number }> => {
    const skipped = { attempted: false, queued: 0 };
    const sourceRunId = typeof marker.raw.sourceRunId === "string" ? marker.raw.sourceRunId : null;
    if (!sourceRunId) {
      throw new Error(`Mergeability wait on ${task.id} has no source Run`);
    }
    const firstAt = typeof marker.raw.firstDeferredAt === "string" ? Date.parse(marker.raw.firstDeferredAt) : Number.NaN;
    const eligibleAt = typeof marker.raw.nextEligibleAt === "string" ? Date.parse(marker.raw.nextEligibleAt) : Number.NaN;
    if (!Number.isFinite(firstAt) || !Number.isFinite(eligibleAt)) {
      await settleMergeabilityWaitStop(db, { taskId: task.id, sourceRunId, condition: "api-error",
        reason: "mergeability wait budget marker is invalid", now });
      return skipped;
    }
    const target = { projectId: task.projectId, chainId: task.chainId };
    const control = await db.chainControl.findUnique({ where: { projectId_chainId: target },
      select: { state: true, heldAt: true, releasedAt: true } });
    if (control?.state === "HELD") return skipped;
    const ceilingAt = firstAt + MERGEABILITY_WAIT_CEILING_MS;
    const heldThroughCeiling = control?.state === "RELEASED" && !!control.heldAt && !!control.releasedAt
      && control.heldAt.getTime() <= ceilingAt && control.releasedAt.getTime() >= ceilingAt;
    const finalAttempt = heldThroughCeiling && now.getTime() >= ceilingAt && marker.raw.finalAttempt !== true;
    if (now.getTime() >= ceilingAt && !finalAttempt) {
      await settleMergeabilityWaitStop(db, { taskId: task.id, sourceRunId,
        condition: "unresolved-mergeability", reason: "six-hour mergeability wait ceiling exhausted", now });
      return skipped;
    }
    const transportFirstAt = typeof marker.raw.transportFirstAt === "string"
      ? Date.parse(marker.raw.transportFirstAt) : Number.NaN;
    if (Number.isFinite(transportFirstAt)
      && now.getTime() - transportFirstAt >= BASE_DRIFT_TRANSPORT_CEILING_MS) {
      await settleMergeabilityWaitStop(db, { taskId: task.id, sourceRunId, condition: "api-error",
        reason: "merge lease transport retry ceiling exhausted after 30 minutes", now });
      return skipped;
    }
    if (eligibleAt > now.getTime() && !finalAttempt) return skipped;
    if (await db.mergeLeaseEvent.count({ where: { ...target, state: { in: ["HANDOFF_PENDING", "RELEASE_DEFERRED"] } } })) return skipped;
    try {
      const result = await leased(target, async () => {
        const runId = await db.$transaction(async (tx) => {
          if (!await lockRecoveryChain(tx, task.id)) return null;
          const current = await readLatestMarker(tx, task.id, "mergeabilityWait");
          if (current?.state !== "deferred" || current.raw.sourceRunId !== sourceRunId) return null;
          const [output, source, active] = await Promise.all([
            tx.taskStepOutput.findUnique({ where: { taskId: task.id } }),
            tx.run.findUnique({ where: { id: sourceRunId } }),
            tx.run.count({ where: { task: target, status: { in: ACTIVE_RUN_STATUSES } } }),
          ]);
          if (active !== 0) return null;
          if (!source || source.taskId !== task.id || source.status !== "SUCCEEDED"
            || output?.runId !== sourceRunId || parseMergeResult(output).outcome !== "deferred") {
            throw new Error("deferred mergeability source Run or output is no longer valid");
          }
          const sourceStopId = typeof current.raw.sourceStopId === "string" ? current.raw.sourceStopId : null;
          const opened = await openRun(tx, task.id, { kind: "integrator-deferred", readyAt: now,
            sourceRunId, sourceStopId });
          if (!opened.ok && opened.refusal.code === "chain-held") return null;
          if (!opened.ok) throw new Error(`deferred mergeability Run birth refused: ${opened.refusal.message}`);
          await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.TODO, failureReason: null } });
          await recordLeaseHandoff(tx, { target, toRunId: opened.run.id, at: now });
          await writeMarker(tx, task.id, "mergeabilityWait", "queued", {
            actorType: "control-plane",
            body: `Pending mergeability recheck ${current.raw.ordinal ?? "?"} queued as Run ${opened.run.id}`,
            metadata: { sourceRunId, sourceStopId, nextRunId: opened.run.id,
              ordinal: current.raw.ordinal ?? null, firstDeferredAt: current.raw.firstDeferredAt ?? null,
              finalAttempt,
              observed: current.raw.observed ?? null,
              elapsedMs: now.getTime() - firstAt,
              remainingMs: MERGEABILITY_WAIT_CEILING_MS - (now.getTime() - firstAt) },
          });
          return opened.run.id;
        });
        return { leaseOutcome: runId ? { kind: "continue" as const }
          : { kind: "stop" as const, taskId: task.id }, value: runId };
      }, db);
      if (result.outcome === "ran" && result.value) return { attempted: true, queued: 1 };
      else if (result.outcome === "unreachable") {
        await retryMergeabilityTransport(db, task.id, marker, sourceRunId, `merge lease unavailable: ${result.detail}`, now);
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("chain-held")) return skipped;
      await settleMergeabilityWaitStop(db, { taskId: task.id, sourceRunId, condition: "api-error",
        reason: `automatic mergeability recheck failed: ${error instanceof Error ? error.message : String(error)}`, now });
    }
    return { attempted: true, queued: 0 };
};

const addTickDelta = (result: BaseDriftRecoveryTickResult, delta: RecoveryTickDelta): void => {
  result.recovered += delta.recovered;
  result.exhausted += delta.exhausted;
  result.ineligible += delta.ineligible;
};

/** CI recovery births and their external replays share one allowance. The
 * activity is the automatic-birth authority, so extra aggregate rows created
 * by an operator rerun do not spend the automatic budget by themselves. */
const ciRecoveryAllowanceSpent = async (
  tx: Prisma.TransactionClient,
  integratorTaskId: string,
  history?: Array<{ metadata: Prisma.JsonValue }>,
  knownStopIds?: ReadonlySet<string>,
): Promise<number> => {
  const ciRows = history ?? await tx.taskActivity.findMany({ where: {
    taskId: integratorTaskId,
    actorType: "control-plane",
    metadata: { path: ["kind"], equals: "mergeTail.ciFailureRecovery" },
  }, select: { metadata: true } });
  const ciStopIds = knownStopIds ?? new Set(ciRows.map((row) => asJsonObject(row.metadata)?.stopId)
    .filter((value): value is string => typeof value === "string"));
  const attempts = await tx.mergeRecoveryAttempt.findMany({ where: {
    integratorTaskId,
    sourceStopId: { in: [...ciStopIds] },
  }, select: { externalReplayCount: true } });
  return ciRows.length + attempts.reduce((total, attempt) => total + attempt.externalReplayCount, 0);
};

/** Recovery Runs and external replays spend one shared allowance across stops. */
export const recoveryAllowanceSpent = async (
  tx: Prisma.TransactionClient,
  identity: MergeRecoveryAttempt,
  options: { excludeSourceStopId?: string } = {},
): Promise<number> => {
  const ciRows = await tx.taskActivity.findMany({ where: {
    taskId: identity.integratorTaskId,
    actorType: "control-plane",
    metadata: { path: ["kind"], equals: "mergeTail.ciFailureRecovery" },
  }, select: { metadata: true } });
  const ciStopIds = new Set(ciRows.map((row) => asJsonObject(row.metadata)?.stopId)
    .filter((value): value is string => typeof value === "string"));
  const rows = await tx.mergeRecoveryAttempt.findMany({ where: {
    integratorTaskId: identity.integratorTaskId, repository: identity.repository,
    prNumber: identity.prNumber, targetBranch: identity.targetBranch,
    ...(options.excludeSourceStopId ? { sourceStopId: { not: options.excludeSourceStopId } } : {}),
  }, select: { sourceStopId: true, recoveryRunId: true, externalReplayCount: true } });
  const baseRows = rows.filter((row) => !ciStopIds.has(row.sourceStopId));
  const spentStops = new Set(baseRows.filter((row) => row.recoveryRunId !== null).map((row) => row.sourceStopId));
  return spentStops.size + baseRows.reduce((total, row) => total + row.externalReplayCount, 0);
};

const recoveryRegressionAllowance = async (
  tx: Prisma.TransactionClient,
  identity: MergeRecoveryAttempt,
): Promise<{ spent: number; ceiling: number }> => {
  const ciRows = await tx.taskActivity.findMany({ where: {
    taskId: identity.integratorTaskId,
    actorType: "control-plane",
    metadata: { path: ["kind"], equals: "mergeTail.ciFailureRecovery" },
  }, select: { metadata: true } });
  const ciStopIds = new Set(ciRows.map((row) => asJsonObject(row.metadata)?.stopId)
    .filter((value): value is string => typeof value === "string"));
  if (!ciStopIds.has(identity.sourceStopId)) {
    return {
      spent: await recoveryAllowanceSpent(tx, identity),
      ceiling: MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES,
    };
  }
  return {
    spent: await ciRecoveryAllowanceSpent(tx, identity.integratorTaskId, ciRows, ciStopIds),
    ceiling: MAX_AUTOMATIC_CI_FAILURE_RECOVERIES,
  };
};

export type RecoveryRegressionReplayResult = {
  examined: number;
  replayed: number;
  blocked: number;
};

/**
 * Reconcile recovery-bound Regression Runs that ended before producing a
 * usable result. Completion deliberately leaves these Runs to this worker:
 * the worker can enforce the recovery allowance, respect Hold, carry the
 * Run-bound context, and repair historical REPAIRING rows created before this
 * exit existed. Every decision is repeated under the full Chain mutex, so an
 * operator action or another tick can win, but never alongside this one.
 */
export const replayFailedRecoveryRegressions = async (
  db: PrismaClient,
  now = new Date(),
  limit = 5,
): Promise<RecoveryRegressionReplayResult> => {
  const result: RecoveryRegressionReplayResult = { examined: 0, replayed: 0, blocked: 0 };
  const pageSize = Math.max(limit * 4, 20);
  let cursor: string | undefined;
  while (result.replayed + result.blocked < limit) {
    const rows = await db.mergeRecoveryAttempt.findMany({
      where: {
        status: MergeRecoveryStatus.REPAIRING,
        recoveryRunId: { not: null },
        regressionTaskId: { not: null },
      },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const row of rows) {
      if (result.replayed + result.blocked >= limit) break;
      const runId = row.recoveryRunId;
      if (!runId) continue;
      const observedRun = await db.run.findUnique({ where: { id: runId }, select: { status: true } });
      if (!observedRun || observedRun.status === "SUCCEEDED" || ACTIVE_RUN_STATUSES.includes(observedRun.status)) continue;
      result.examined += 1;
      let outcome: "replayed" | "blocked" | "skipped";
      try {
        outcome = await db.$transaction(async (tx): Promise<"replayed" | "blocked" | "skipped"> => {
      if (!await lockRecoveryChain(tx, row.integratorTaskId)) return "skipped";
      const latest = await tx.mergeRecoveryAttempt.findFirst({
        where: { regressionTaskId: row.regressionTaskId },
        orderBy: [{ attempt: "desc" }, { id: "desc" }],
      });
      if (!latest || latest.id !== row.id || latest.status !== MergeRecoveryStatus.REPAIRING
        || latest.recoveryRunId !== runId || !latest.regressionTaskId) return "skipped";
      const integrator = await tx.task.findUnique({
        where: { id: latest.integratorTaskId },
        select: { projectId: true, chainId: true, status: true, archivedAt: true },
      });
      if (!integrator?.chainId) return "skipped";
      const chain = { projectId: integrator.projectId, chainId: integrator.chainId };
      if (integrator.status !== TaskStatus.REVIEW || integrator.archivedAt
        || await tx.task.count({ where: { ...chain, archivedAt: { not: null } } })) return "skipped";
      const integratorOutput = await tx.taskStepOutput.findUnique({
        where: { taskId: latest.integratorTaskId },
        select: { kind: true, body: true },
      });
      if (integratorOutput && parseMergeResult(integratorOutput).outcome === "merged") return "skipped";
      if (await tx.chainControl.count({ where: { ...chain, state: "HELD" } })) return "skipped";
      if (await tx.run.count({ where: { task: chain, status: { in: ACTIVE_RUN_STATUSES } } })) return "skipped";
      const [failedRun, newestRun, regressionTask, repairOwner] = await Promise.all([
        tx.run.findUnique({
          where: { id: runId },
          select: {
            id: true, taskId: true, status: true, runNumber: true, retryAt: true,
            maxRunsPerTask: true, budgetGrants: true, leaseLossRefunds: true,
            failureReason: true, headSha: true,
          },
        }),
        tx.run.findFirst({
          where: { taskId: latest.regressionTaskId },
          orderBy: { runNumber: "desc" },
          select: { id: true },
        }),
        tx.task.findUnique({
          where: { id: latest.regressionTaskId },
          select: {
            id: true,
            templateStep: { select: {
              stepIndex: true,
              outputKind: true,
              taskTemplate: { select: { name: true } },
            } },
          },
        }),
        tx.taskActivity.findFirst({ where: {
          taskId: latest.regressionTaskId,
          actorType: "control-plane",
          AND: [
            { metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.repairAttempt } },
            { metadata: { path: ["sourceRunId"], equals: runId } },
          ],
        }, select: { id: true } }),
      ]);
      if (!failedRun || failedRun.taskId !== latest.regressionTaskId
        || failedRun.status === "SUCCEEDED" || ACTIVE_RUN_STATUSES.includes(failedRun.status)) return "skipped";
      if (repairOwner) return "skipped";
      if (regressionTask) {
        const qualified = await regressionVerdictForRun(tx, {
          task: regressionTask,
          runId: failedRun.id,
          runHeadSha: failedRun.headSha,
          allowPersistedHeadWhenUnreported: true,
        });
        if (qualified.status === "ok"
          && qualified.verdict.outcome !== "pass"
          && qualified.verdict.outcome !== "semantic-pass") return "skipped";
      }
      const recovery = recoveryContext(latest);
      if (!recovery) {
        const reason = `Merge recovery ${latest.id} has incomplete context for failed Regression Run ${runId}`;
        await transitionMergeRecovery(tx, latest.id, MergeRecoveryStatus.BLOCKED_DOWNSTREAM, {
          failureReason: reason,
          endedAt: now,
        });
        for (const taskId of [latest.regressionTaskId, latest.readinessTaskId, latest.integratorTaskId]) {
          if (taskId) await tx.task.update({ where: { id: taskId }, data: {
            status: TaskStatus.REVIEW,
            failureReason: reason,
          } });
        }
        await openRecoveryQuestion(tx, latest.integratorTaskId, latest.sourceStopId, {
          revalidations: latest.revalidations, ceiling: false, reason,
        });
        return "blocked";
      }
      if (newestRun?.id !== failedRun.id) {
        const reason = `Recovery Regression binding is stale: newer unbound Run ${newestRun?.id ?? "unknown"} exists after failed Run ${failedRun.id}`;
        await blockDownstream(tx, { recovery, phase: "regression", reason, at: now });
        await openRecoveryQuestion(tx, latest.integratorTaskId, latest.sourceStopId, {
          revalidations: latest.revalidations, ceiling: false, reason,
        });
        return "blocked";
      }
      const externalRefund = await tx.taskActivity.findFirst({
        where: {
          taskId: latest.regressionTaskId,
          actorType: "control-plane",
          AND: [{ metadata: { path: ["runId"], equals: failedRun.id } }],
          OR: [
            { metadata: { path: ["kind"], equals: "externalFailureRefund.granted" } },
            { metadata: { path: ["kind"], equals: "externalFailureRefund.refused" } },
          ],
        },
        select: { id: true },
      });
      const platformLossReason = failedRun.status === "LOST" ? "lease-loss"
        : failedRun.status === "CANCELLED"
          && failedRun.failureReason === "Claim invalidated before start because late salvage changed its clone base"
          ? "claim-invalidated"
          : null;
      const allowance = await recoveryRegressionAllowance(tx, latest);
      if ((externalRefund || platformLossReason) && allowance.spent < allowance.ceiling) {
        const carry = await mergeRecoveryCarryReadiness(tx, {
          regressionTaskId: latest.regressionTaskId,
          recoveryRunId: failedRun.id,
        });
        if (carry.kind !== "ready") {
          const reason = carry.kind === "invalid" ? carry.reason
            : `Merge recovery ${latest.id} lost ownership of failed Regression Run ${failedRun.id}`;
          await blockDownstream(tx, { recovery, phase: "regression", reason, at: now });
          await openRecoveryQuestion(tx, latest.integratorTaskId, latest.sourceStopId, {
            revalidations: latest.revalidations, ceiling: false, reason,
          });
          return "blocked";
        }
        let replayRun: { id: string; runNumber: number };
        if (platformLossReason) {
          const refund = await refundForLostRun(tx, {
            taskId: latest.regressionTaskId,
            run: failedRun,
            reason: platformLossReason,
          });
          const reopened = await reopenRefundedRun(tx, {
            taskId: latest.regressionTaskId,
            refund,
            readyAt: failedRun.retryAt ?? now,
            now,
            activityPrefix: `Recovery Regression Run ${failedRun.runNumber} platform-loss replacement refused`,
          });
          if (reopened.kind !== "reopened") {
            const reason = reopened.kind === "exhausted"
              ? `Recovery Regression platform-loss refund exhausted at Run ceiling ${reopened.ceiling}`
              : reopened.kind === "recovery-invalid" ? reopened.reason
                : `Recovery Regression platform-loss replacement refused: ${reopened.refusal.message}`;
            await blockDownstream(tx, { recovery, phase: "regression", reason, at: now });
            await openRecoveryQuestion(tx, latest.integratorTaskId, latest.sourceStopId, {
              revalidations: latest.revalidations, ceiling: false, reason,
            });
            return "blocked";
          }
          replayRun = reopened.run;
        } else {
          const attempt = await attemptRunBirth(tx, (client) => openRun(client, latest.regressionTaskId!, {
            kind: "retry-after-completion",
            sourceRunId: failedRun.id,
            sourceMaxRunsPerTask: failedRun.maxRunsPerTask,
            sourceBudgetGrants: failedRun.budgetGrants,
            budgetGrant: 0,
            readyAt: failedRun.retryAt ?? now,
          }));
          if (attempt.outcome === "already-queued") return "skipped";
          if (attempt.outcome === "refused") {
            const reason = `Recovery Regression replay refused: ${attempt.refusal.message}`;
            await blockDownstream(tx, { recovery, phase: "regression", reason, at: now });
            await openRecoveryQuestion(tx, latest.integratorTaskId, latest.sourceStopId, {
              revalidations: latest.revalidations, ceiling: false, reason,
            });
            return "blocked";
          }
          replayRun = attempt.run;
          await carryMergeRecoveryRun(tx, {
            regressionTaskId: latest.regressionTaskId,
            previousRecoveryRunId: failedRun.id,
            recoveryRunId: replayRun.id,
            preserveClaimContext: true,
          });
        }
        await tx.mergeRecoveryAttempt.update({
          where: { id: latest.id },
          data: { externalReplayCount: { increment: 1 } },
        });
        await tx.task.update({
          where: { id: latest.regressionTaskId },
          data: { status: TaskStatus.TODO, failureReason: null },
        });
        await tx.taskActivity.create({ data: {
          taskId: latest.regressionTaskId,
          actorType: "control-plane",
          body: `Recovery Regression Run ${failedRun.runNumber} failed externally; Run ${replayRun.runNumber} queued with recovery context`,
          metadata: {
            kind: "mergeTail.recoveryRegressionReplay",
            aggregateId: latest.id,
            failedRunId: failedRun.id,
            recoveryRunId: replayRun.id,
            ordinal: allowance.spent + 1,
            remaining: allowance.ceiling - allowance.spent - 1,
          },
        } });
        return "replayed";
      }
      const reason = externalRefund || platformLossReason
        ? `Automatic recovery allowance exhausted after ${String(allowance.spent)} recoveries and external replays`
        : `Recovery Regression Run ${failedRun.runNumber} failed without an external failure classification: ${failedRun.failureReason ?? "execution failed"}`;
      await blockDownstream(tx, { recovery, phase: "regression", reason, at: now });
      await openRecoveryQuestion(tx, latest.integratorTaskId, latest.sourceStopId, {
        revalidations: latest.revalidations, ceiling: false, reason,
      });
      return "blocked";
        });
      } catch (error: unknown) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        try {
          await db.taskActivity.create({ data: {
            taskId: row.regressionTaskId!,
            actorType: "control-plane",
            body: `Recovery Regression replay skipped after an isolated row failure: ${reason}`,
            metadata: {
              kind: "mergeTail.recoveryRegressionReplayError",
              aggregateId: row.id,
              recoveryRunId: runId,
              reason,
            },
          } });
        } catch {
          // The row failure and its audit failure are isolated from the rest of
          // the tick. A later tick can retry after the underlying state heals.
        }
        continue;
      }
      if (outcome === "replayed") result.replayed += 1;
      if (outcome === "blocked") result.blocked += 1;
    }
    if (rows.length < pageSize || result.replayed + result.blocked >= limit) break;
    cursor = rows.at(-1)?.id;
    if (!cursor) break;
  }
  return result;
};

/** Resume releases the Hold; this worker consumes the aggregate intent under a
 * fresh Lease. An unresolved old handoff fences the post-completion release. */
export const replayRecoveryAuthorizations = async (
  db: PrismaClient, reader: PullRequestReader, now: Date, limit: number,
  leased: WithMergeLease = withMergeLease,
): Promise<void> => {
  const pendingRows = await db.mergeRecoveryAttempt.findMany({
    where: { status: MergeRecoveryStatus.AWAITING_AUTHORIZATION, pendingAuthorizationId: { not: null },
      OR: [{ nextEligibleAt: null }, { nextEligibleAt: { lte: now } }] },
    include: { integratorTask: { select: { projectId: true, chainId: true } } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: limit,
  });
  for (const row of pendingRows) {
    const chainId = row.integratorTask.chainId;
    if (!chainId) continue;
    const target = { projectId: row.integratorTask.projectId, chainId };
    const unresolved = () => db.mergeLeaseEvent.count({ where: { ...target,
      state: { in: ["HANDOFF_PENDING", "RELEASE_DEFERRED"] } } });
    if (await unresolved()) continue;
    if (await db.chainControl.count({ where: { ...target, state: "HELD" } })) continue;
    // Reserve this aggregate before external Lease operations. Concurrent ticks
    // cannot acquire the same Chain Lease and then release one another's work.
    // The reservation expires after the bounded network calls if a worker dies.
    const reservedUntil = new Date(Date.now() + 5 * 60_000);
    const reserved = await db.mergeRecoveryAttempt.updateMany({ where: {
      id: row.id, pendingAuthorizationId: row.pendingAuthorizationId,
      status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
      OR: [{ nextEligibleAt: null }, { nextEligibleAt: { lte: now } }],
    }, data: { nextEligibleAt: reservedUntil } });
    if (reserved.count !== 1) continue;
    try {
      await leased(target, async () => {
        // Another worker may have handed off between the scan and acquisition.
        // Its live successor owns this same Chain Lease; never release it here.
        if (await unresolved()) return { leaseOutcome: { kind: "continue" }, value: null };
        const facts = await readCandidateFacts(db, row.integratorTaskId);
        const auth = facts.authorizationSelection?.authorization;
        let snapshot: PullRequestSnapshot | null = null;
        let baseRecovery: FreshDecision | null = null;
        if (auth && auth.activityId === row.pendingAuthorizationId) {
          try {
            const signal = AbortSignal.timeout(8_000);
            snapshot = await reader.readPullRequest(auth.repository, auth.prNumber, auth.baseRef, signal);
            if (snapshot.baseSha && snapshot.baseSha !== auth.baseSha
              && row.boundSourceRunId && row.readinessTaskId && row.regressionTaskId) {
              const authorizedAdvance = reader.compareCommits
                ? await reader.compareCommits(auth.repository, auth.baseSha, snapshot.baseSha, signal)
                : null;
              baseRecovery = classifyFresh({ kind: "snapshot", snapshot,
                candidate: {
                  recoveryKind: facts.stop && isCiFailureRecoveryStop(facts.stop.condition, facts.stop.evidence)
                    ? "ci-failure" : "base-drift",
                  integratorTaskId: row.integratorTaskId, stopId: row.sourceStopId,
                  sourceRunId: row.boundSourceRunId, readinessTaskId: row.readinessTaskId,
                  regressionTaskId: row.regressionTaskId, authorizationActivityId: auth.activityId,
                  repository: auth.repository, prNumber: auth.prNumber, targetBranch: auth.baseRef,
                  authorizedHeadSha: auth.headSha, authorizedBaseSha: auth.baseSha,
                  observedBaseSha: snapshot.baseSha,
                },
                comparisonAvailable: reader.compareCommits !== undefined,
                authorizedAdvance, observedAdvance: null,
              });
              if (baseRecovery.kind === "retry") {
                return { leaseOutcome: { kind: "stop", taskId: row.integratorTaskId }, value: null };
              }
            }
          } catch {
            // A failed fresh read leaves the same intent pending, without spending
            // an execution allowance or manufacturing a deterministic refusal.
            return { leaseOutcome: { kind: "stop", taskId: row.integratorTaskId }, value: null };
          }
        }
        const retain = await db.$transaction(async (tx) => {
          if (!await lockRecoveryChain(tx, row.integratorTaskId)) return false;
          const pending = await pendingIntegratorAuthorization(tx, target);
          if (!pending || pending.id !== row.id || pending.pendingAuthorizationId !== row.pendingAuthorizationId
            || pending.nextEligibleAt?.getTime() !== reservedUntil.getTime()) {
            return (await tx.mergeLeaseEvent.count({ where: { ...target, state: "HANDOFF_PENDING" } })) > 0;
          }
          if (await tx.run.count({ where: { task: target, status: { in: ACTIVE_RUN_STATUSES } } })) {
            return (await tx.mergeLeaseEvent.count({ where: { ...target, state: "HANDOFF_PENDING" } })) > 0;
          }
          const freshFacts = await readCandidateFacts(tx, row.integratorTaskId);
          const freshAuth = freshFacts.authorizationSelection?.authorization;
          const valid = auth && freshAuth?.activityId === auth.activityId
            && !freshFacts.authorizationSelection?.refusal && snapshot
            && freshFacts.stop?.stopId === pending.sourceStopId
            && freshFacts.target?.resolved
            && freshFacts.target.repository === auth.repository && freshFacts.target.prNumber === auth.prNumber
            && freshFacts.firstRunTargetRef === auth.baseRef
            && freshFacts.readiness?.outputCommitSha === auth.headSha
            && (snapshot.baseSha === auth.baseSha || baseRecovery?.kind === "queue")
            && snapshot.repository === auth.repository && snapshot.number === auth.prNumber
            && snapshot.baseRefName === auth.baseRef && snapshot.headRefOid === auth.headSha
            && snapshot.state === "OPEN" && !snapshot.merged && !snapshot.isDraft
            && snapshot.mergeStateStatus !== "BLOCKED" && snapshot.baseSha;
          const spent = await recoveryAllowanceSpent(tx, pending);
          const moved = valid && snapshot!.baseSha !== auth!.baseSha;
          const exhausted = (pending.pendingFailureRunId !== null || moved)
            && spent >= MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES;
          if (!valid || exhausted) {
            const reason = exhausted ? "Automatic recovery allowance exhausted" : "Pending authorization is no longer current";
            await tx.task.update({ where: { id: pending.integratorTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
            await tx.mergeRecoveryAttempt.update({ where: { id: pending.id }, data: {
              pendingAuthorizationId: null, pendingFailureRunId: null,
              status: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
              failureReason: reason,
              endedAt: now,
            } });
            // The execution allowance cannot be reset by class re-validation.
            await openRecoveryQuestion(tx, pending.integratorTaskId, pending.sourceStopId, {
              revalidations: pending.revalidations, ceiling: false,
            });
            await writeMarker(tx, pending.integratorTaskId, "baseDriftRecovery", "question-opened", {
              actorType: "control-plane", body: exhausted ? "Automatic recovery allowance exhausted" : "Pending authorization refused",
              metadata: { aggregateId: pending.id, spent },
            });
            return false;
          }
          if (moved) {
            // A fresh aggregate preserves the prior recovery Run and replay counts.
            // enterRepair is the ordinary regression recovery birth path.
            const latest = await tx.mergeRecoveryAttempt.aggregate({ where: { integratorTaskId: pending.integratorTaskId }, _max: { attempt: true } });
            const next = await tx.mergeRecoveryAttempt.create({ data: {
              integratorTaskId: pending.integratorTaskId, sourceStopId: pending.sourceStopId,
              attempt: (latest._max.attempt ?? 0) + 1,
              boundSourceRunId: pending.boundSourceRunId, authorizationActivityId: auth!.activityId,
              readinessTaskId: pending.readinessTaskId, regressionTaskId: pending.regressionTaskId,
              repository: auth!.repository, prNumber: auth!.prNumber, targetBranch: auth!.baseRef,
              authorizedHeadSha: auth!.headSha, authorizedBaseSha: auth!.baseSha,
              observedBaseSha: snapshot!.baseSha, revalidations: pending.revalidations,
            } });
            await enterRepair(tx, { aggregateId: next.id, currentBaseSha: snapshot!.baseSha!, now });
            await tx.mergeRecoveryAttempt.update({ where: { id: pending.id }, data: {
              pendingAuthorizationId: null, pendingFailureRunId: null,
            } });
            return false;
          }
          const replayed = await replayHeldIntegratorAuthorization(tx, {
            ...target, taskId: pending.integratorTaskId,
          }, now);
          if (!replayed) return false;
          await recordLeaseHandoff(tx, { target, toRunId: replayed.runId, at: now });
          return true;
        });
        return { leaseOutcome: retain ? { kind: "continue" } : { kind: "stop", taskId: row.integratorTaskId }, value: null };
      }, db);
    } finally {
      await db.mergeRecoveryAttempt.updateMany({ where: { id: row.id, nextEligibleAt: reservedUntil },
        data: { nextEligibleAt: null } });
    }
  }
};

export const baseDriftRecoveryTick = async (
  db: PrismaClient,
  reader: PullRequestReader,
  now = new Date(),
  limit = 5,
  leased: WithMergeLease = withMergeLease,
): Promise<BaseDriftRecoveryTickResult> => {
  await pendingMergeabilityTick(db, now, limit, leased);
  await replayFailedRecoveryRegressions(db, now, limit);
  await replayRecoveryAuthorizations(db, reader, now, limit, leased);
  const result: BaseDriftRecoveryTickResult = { examined: 0, recovered: 0, exhausted: 0, ineligible: 0 };
  const where: Prisma.TaskWhereInput = {
    status: TaskStatus.REVIEW,
    templateStep: { outputKind: INTEGRATOR_OUTPUT_KIND },
  };
  const pageSize = Math.max(limit * 10, 50);
  let cursor: string | null = null;
  while (result.examined < limit) {
    const tasks: Array<{ id: string }> = await db.task.findMany({
      where,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true },
    });
    if (tasks.length === 0) break;
    for (const task of tasks) {
      cursor = task.id;
      if (result.examined >= limit) break;
      const candidateFacts = await readCandidateFacts(db, task.id);
      if (candidateFacts.task?.chainId) {
        const identity = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { projectId: true } });
        if (await db.chainControl.count({ where: {
          projectId: identity.projectId, chainId: candidateFacts.task.chainId, state: "HELD",
        } })) continue;
      }
      // A held backoff costs one durable read and nothing else: no GitHub call,
      // no spent attempt, and no place in this tick's examined budget.
      if (recoveryDeferred(candidateFacts, now)) continue;
      const candidateDecision = classifyCandidate(candidateFacts);
      switch (candidateDecision.kind) {
        case "skip":
          continue;
        case "retry":
        case "ineligible":
          result.examined += 1;
          addTickDelta(result, await settleRecovery(db, task, candidateDecision.stopId, candidateDecision, now));
          continue;
        case "inspect":
          result.examined += 1;
          break;
      }
      const candidate = candidateDecision.candidate;
      const settlementTask = { id: task.id, identity: candidate };
      const validation = await db.$transaction(async (tx) => {
        if (!await lockRecoveryChain(tx, candidate.integratorTaskId)) return false;
        const attempt = await ensureRecoveryValidation(tx, {
          integratorTaskId: candidate.integratorTaskId,
          sourceStopId: candidate.stopId,
          identity: candidate,
        });
        return attempt.status === MergeRecoveryStatus.VALIDATING;
      });
      if (!validation) continue;
      let snapshot: PullRequestSnapshot;
      let authorizedAdvance: { status: string; behindBy: number } | null = null;
      let observedAdvance: { status: string; behindBy: number } | null = null;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
          snapshot = await reader.readPullRequest(candidate.repository, candidate.prNumber, candidate.targetBranch, controller.signal);
          if (reader.compareCommits && snapshot.baseSha
            && snapshot.baseSha !== candidate.authorizedBaseSha) {
            authorizedAdvance = await reader.compareCommits(
              candidate.repository, candidate.authorizedBaseSha, snapshot.baseSha, controller.signal,
            );
            if (authorizedAdvance.status === "ahead" && authorizedAdvance.behindBy === 0
              && candidate.observedBaseSha !== snapshot.baseSha) {
              observedAdvance = await reader.compareCommits(
                candidate.repository, candidate.observedBaseSha, snapshot.baseSha, controller.signal,
              );
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (error: unknown) {
        const decision = classifyFresh({
          kind: "reader-failure",
          reason: `fresh server-side repository read failed (${error instanceof Error ? error.name : "unknown error"})`,
        });
        addTickDelta(result, await settleRecovery(db, settlementTask, candidate.stopId, decision, now));
        continue;
      }
      const fresh = classifyFresh({
        kind: "snapshot",
        candidate,
        snapshot,
        comparisonAvailable: reader.compareCommits !== undefined,
        authorizedAdvance,
        observedAdvance,
      });
      switch (fresh.kind) {
        case "retry":
        case "ineligible":
          addTickDelta(result, await settleRecovery(db, settlementTask, candidate.stopId, fresh, now));
          continue;
        case "queue":
          break;
      }
      let ciEvidence: CiFailureEvidence | undefined;
      if (candidate.recoveryKind === "ci-failure") {
        try {
          ciEvidence = await readCiFailureEvidence(reader, snapshot, candidate);
        } catch (error: unknown) {
          const reason = `CI failure evidence or logs unavailable: ${redactCiLog(describeCiLogError(error))}`;
          const decision: Retry | Ineligible = retryableCiLogError(error)
            ? { kind: "retry", retryClass: "transport", reason }
            : { kind: "ineligible", reason };
          addTickDelta(result, await settleRecovery(db, settlementTask, candidate.stopId, decision, now));
          continue;
        }
      }
      let outcome: QueueRecoveryResult;
      try {
        outcome = await queueRecovery(db, candidate, fresh.currentBaseSha, now, ciEvidence);
      } catch (error: unknown) {
        outcome = { kind: "ineligible",
          reason: `automatic merge recovery failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      addTickDelta(result, await settleRecovery(db, settlementTask, candidate.stopId, outcome, now));
    }
    if (tasks.length < pageSize) break;
  }
  return result;
};

export const startBaseDriftRecoveryWorker = (
  db: PrismaClient,
  reader: PullRequestReader,
): ReturnType<typeof setInterval> => {
  let inFlight = false;
  const run = (): void => {
    if (inFlight) return;
    inFlight = true;
    void baseDriftRecoveryTick(db, reader)
      .catch((error: unknown) => console.error("Base-drift recovery tick failed", error))
      .finally(() => { inFlight = false; });
  };
  run();
  const timer = setInterval(run, baseDriftRecoveryPollIntervalMs());
  timer.unref?.();
  return timer;
};
