import {
  ACTIVE_RUN_STATUSES,
  BASE_DRIFT_RETRY_BACKOFF_CAP_MS,
  BASE_DRIFT_RETRY_BACKOFF_START_MS,
  BASE_DRIFT_TRANSPORT_CEILING_MS,
  BASE_DRIFT_VALIDATION_MIN_ELAPSED_MS,
  BASE_DRIFT_WAITING_CEILING_MS,
  BASE_DRIFT_CLASS_CEILING_CHOICES,
  INTEGRATOR_OUTPUT_KIND,
  MAX_BASE_DRIFT_VALIDATION_ATTEMPTS,
  MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES,
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
  openStopQuestion,
  parseMergeResult,
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

import type { PullRequestReader, PullRequestSnapshot } from "./github-read.js";
import {
  classifyCandidate,
  classifyDurable,
  classifyFresh,
  classifyRetryBudget,
  recoveryDeferred,
  type DurableCandidateFacts,
  type Ineligible,
  type RecoveryCandidate,
  type RecoveryIdentity,
  type Retry,
  type RetryBudgetPolicy,
  type RetryClass,
} from "./base-drift-recovery-decision.js";
import { stopMergeTail } from "./merge-tail-actions.js";
import {
  ensureRecoveryValidation,
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
  if (stop.condition !== "base-drift") return facts;
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
type RecoverySettleCard = { revalidations: number; ceiling: boolean };

/**
 * The operator card a settled recovery leaves behind. An ordinary refusal
 * offers abandoning only; a retry class that crossed its own ceiling also
 * offers `re-validate`.
 */
const openRecoveryQuestion = async (
  tx: Prisma.TransactionClient,
  integratorTaskId: string,
  stopId: string,
  card: RecoverySettleCard,
): Promise<void> => {
  const [task, stop] = await Promise.all([
    tx.task.findUnique({ where: { id: integratorTaskId }, select: { assigneeAgentId: true } }),
    latestRecordedStop(tx, integratorTaskId),
  ]);
  if (!task?.assigneeAgentId || stop?.stopId !== stopId) {
    throw new Error(`Cannot open the settled base-drift question for unresolved stop ${stopId}`);
  }
  const session = stop.sourceRunId
    ? await tx.session.findUnique({ where: { runId: stop.sourceRunId }, select: { id: true } })
    : null;
  await openStopQuestion(tx, {
    integratorTaskId,
    stopId,
    condition: "base-drift",
    evidence: stop.evidence,
    agentId: task.assigneeAgentId,
    sessionId: session?.id ?? null,
    generation: card.revalidations,
    ...(card.ceiling ? { choices: BASE_DRIFT_CLASS_CEILING_CHOICES } : {}),
  });
};

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

const queueRecovery = async (
  db: PrismaClient,
  expected: RecoveryCandidate,
  currentBaseSha: string,
  now: Date,
): Promise<QueueRecoveryResult> => db.$transaction(async (tx) => {
  if (!await lockRecoveryChain(tx, expected.integratorTaskId)) return { kind: "skip" };
  const aggregate = await ensureRecoveryValidation(tx, {
    integratorTaskId: expected.integratorTaskId,
    sourceStopId: expected.stopId,
    identity: expected,
  });
  const candidateFacts = await readCandidateFacts(tx, expected.integratorTaskId);

  // A recovery spends an attempt only once it owns a fresh regression Run.
  // Validation refusals remain visible aggregate rows but do not consume the
  // two executor-drift attempts. Historical TaskActivity rows are deliberately
  // ignored: the migration has no backfill, so absence here means zero.
  const attempts = await tx.mergeRecoveryAttempt.count({ where: {
    id: { not: aggregate.id },
    integratorTaskId: expected.integratorTaskId,
    repository: expected.repository,
    prNumber: expected.prNumber,
    targetBranch: expected.targetBranch,
    recoveryRunId: { not: null },
  } });
  const decision = classifyDurable({
    expected,
    candidateDecision: classifyCandidate(candidateFacts),
    aggregateValidating: aggregate.status === MergeRecoveryStatus.VALIDATING,
    recoveryCount: attempts,
    maxRecoveries: MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES,
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
      });
      return { kind: "exhausted" };
    case "queue":
      break;
  }

  await enterRepair(tx, { aggregateId: aggregate.id, currentBaseSha, now });
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

const addTickDelta = (result: BaseDriftRecoveryTickResult, delta: RecoveryTickDelta): void => {
  result.recovered += delta.recovered;
  result.exhausted += delta.exhausted;
  result.ineligible += delta.ineligible;
};

export const baseDriftRecoveryTick = async (
  db: PrismaClient,
  reader: PullRequestReader,
  now = new Date(),
  limit = 5,
): Promise<BaseDriftRecoveryTickResult> => {
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
          if (reader.compareCommits && snapshot.baseSha) {
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
      const outcome = await queueRecovery(db, candidate, fresh.currentBaseSha, now);
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
