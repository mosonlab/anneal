import {
  ACTIVE_RUN_STATUSES,
  MERGE_TAIL_KIND,
  MERGE_TRAIN_OUTPUT_KIND,
  MergeRecoveryStatus,
  MergeLeaseEventState,
  MergeGateAuthorizationError,
  Prisma,
  TaskStatus,
  RunStatus,
  readLatestMarker,
  isMergeReadinessStep,
  parseMergeTrainRecord,
  parseRegressionVerdict,
  recordLeaseDeferral,
  isGatedMergeReadinessTask,
  requireMergeGateAuthorization,
  writeMarker,
  type PrismaClient,
  type TrainAuthorization,
  type MergeTrainRecord,
  parseMergeTrainMarker,
} from "@anneal/db";
import type { PullRequestReader } from "./github-read.js";
import { evaluateReadiness, READINESS_READ_BUDGET_MS, type ReadinessDecision } from "./readiness-decision.js";
import type { WithMergeLease, ReleaseMergeLease, HeldLeaseOutcome } from "./merge-lease.js";
import type { MergeLeaseHolder } from "../../../scripts/merge-lease-adapter.mjs";
import type { ReadinessSettlement } from "./readiness-settlement.js";
import type { ClaimedReadiness, ReadinessCandidate, ReadinessDiscovery, ReadinessRead, ReadinessTickResult } from "./merge-readiness-worker.js";
import { reserveMergeTrainTask, enqueueMergeTrainTask, mergeTrainTaskDescription } from "./merge-train-task.js";
import { stopMergeTail } from "./merge-tail-actions.js";
import { noticeMergeTrainAbort, settleMergeTrainFailure } from "./merge-train-repair.js";
import { lockTaskMutationRows } from "./task-write.js";


type TrainCandidateBinding = { taskId: string; chainId: string; headSha: string; branch: string };
type TrainBinding = { baseSha: string; width: number; candidates: TrainCandidateBinding[] };

/** The record parser proves internal consistency; this binds it to our queued work. */
export const trainRecordBindingFailure = (
  record: MergeTrainRecord,
  intent: TrainBinding,
  liveBaseSha: string,
): string | null => {
  if (record.baseSha !== liveBaseSha) return "merge train record has a stale live base";
  if (record.baseSha !== intent.baseSha || record.width !== intent.width) return "merge train record differs from its queued base or width";
  const entries: Array<{ taskId: string; chainId?: string; headSha?: string }> = [
    ...record.prefixes.map((prefix) => ({ taskId: prefix.taskId, chainId: prefix.chainId, headSha: prefix.candidateHeadSha })),
    ...record.blocked.map((blocked) => ({ taskId: blocked.taskId, chainId: blocked.chainId, headSha: blocked.candidateHeadSha })),
    ...record.skipped.map((taskId) => ({ taskId })),
  ];
  if (entries.length !== intent.candidates.length) return "merge train record candidate list is incomplete";
  const seen = new Set<string>();
  for (const [position, entry] of entries.entries()) {
    const expected = intent.candidates[position]!;
    if (seen.has(entry.taskId) || entry.taskId !== expected.taskId
      || (entry.chainId !== undefined && (entry.chainId !== expected.chainId || entry.headSha !== expected.headSha))) {
      return `merge train record candidate binding differs at position ${position + 1}`;
    }
    seen.add(entry.taskId);
  }
  return null;
};

type ReadyRead = ClaimedReadiness & { input: Extract<ClaimedReadiness["input"], { stage: "ready" }> };
type TrainHooks = {
  executor: {
    blocking(): string[];
    settleOffline(tx: Prisma.TransactionClient, read: ClaimedReadiness, executorRunnerIds: string[]): Promise<"ready" | "stopped">;
    closeEpisode(tx: Prisma.TransactionClient, taskId: string): Promise<void>;
  };
  candidates(db: PrismaClient, pageSize: number): AsyncGenerator<ReadinessCandidate>;
  discover(db: PrismaClient, task: ReadinessCandidate, now: Date): Promise<ReadinessDiscovery>;
  read(db: PrismaClient, task: ReadinessCandidate, now: Date): Promise<ReadinessRead>;
  authorize(read: ClaimedReadiness, decision: Extract<ReadinessDecision, { kind: "authorize" }>, train: TrainAuthorization): ReadinessSettlement;
  single(db: PrismaClient, read: ClaimedReadiness, decision: ReadinessDecision, result: ReadinessTickResult,
    release: ReleaseMergeLease, lease: WithMergeLease, reader: PullRequestReader): Promise<void>;
};

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 100_000 } as const;

type PendingTrain = TrainBinding & {
  taskId: string;
  state: "acquiring" | "queued";
  regressionTaskId: string;
  projectId: string;
  repoId: string;
};

/** This short-lived mutex fences stale API ticks across external lease calls.
 * It is distinct from the candidate chain locks acquired by settlement. */
const tryRepositoryMutex = async (tx: Prisma.TransactionClient, repoId: string): Promise<boolean> => {
  const [row] = await tx.$queryRaw<Array<{ held: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${`anneal:merge-train:${repoId}`}, 0)) AS held
  `;
  return row?.held === true;
};

/**
 * Record an acquisition this tick could not make. Contention is ordinary and a
 * train simply waits, but the specification requires every failure to be named
 * and visible rather than silently retried, so the episode is durable state on
 * the train card and on each candidate. The write is skipped while the same
 * episode continues so a poll interval cannot flood the board.
 */
const noteTrainLeaseUnavailable = async (
  tx: Prisma.TransactionClient, train: PendingTrain,
  state: "contended" | "unreachable", detail: string, now: Date,
): Promise<void> => {
  const open = await readLatestMarker(tx, train.taskId, "leaseContention");
  const body = state === "contended"
    ? `Merge train ${train.taskId} is waiting for the repository merge Lease: ${detail}`
    : `Merge train ${train.taskId} could not reach the merge Lease: ${detail}`;
  const firstContendedAt = open && open.state !== "resolved" && typeof open.raw.firstContendedAt === "string"
    ? open.raw.firstContendedAt
    : now.toISOString();
  if (!(open?.state === state && open.raw.detail === detail)) {
    await writeMarker(tx, train.taskId, "leaseContention", { actorType: "control-plane", body,
      metadata: { state, trainTaskId: train.taskId, detail, firstContendedAt, firstObservedAt: firstContendedAt } });
  }
  for (const candidate of train.candidates) {
    const candidateOpen = await readLatestMarker(tx, candidate.taskId, "leaseContention");
    // An already-alerted chain episode remains the authoritative projection;
    // the train's episode will still be visible on its own card.
    if (candidateOpen?.state === "alerted") continue;
    if (candidateOpen?.state === state && candidateOpen.raw.detail === detail) continue;
    const candidateFirstContendedAt = candidateOpen && candidateOpen.state !== "resolved"
      && typeof candidateOpen.raw.firstContendedAt === "string"
      ? candidateOpen.raw.firstContendedAt
      : now.toISOString();
    await writeMarker(tx, candidate.taskId, "leaseContention", { actorType: "control-plane", body,
      metadata: { state, trainTaskId: train.taskId, detail, firstContendedAt: candidateFirstContendedAt } });
  }
};

/** Any answer other than another refusal ends the episode. */
const clearTrainLeaseUnavailable = async (
  tx: Prisma.TransactionClient, train: PendingTrain, now: Date,
): Promise<void> => {
  const open = await readLatestMarker(tx, train.taskId, "leaseContention");
  if (open && open.state !== "resolved") {
    await writeMarker(tx, train.taskId, "leaseContention", { actorType: "control-plane",
      body: `Merge train ${train.taskId} took the repository merge Lease`,
      metadata: { state: "resolved", trainTaskId: train.taskId, resolvedAt: now.toISOString() } });
  }
  for (const candidate of train.candidates) {
    const candidateOpen = await readLatestMarker(tx, candidate.taskId, "leaseContention");
    if (!candidateOpen || candidateOpen.state === "resolved") continue;
    await writeMarker(tx, candidate.taskId, "leaseContention", { actorType: "control-plane",
      body: `Merge train ${train.taskId} took the repository merge Lease`,
      metadata: { state: "resolved", trainTaskId: train.taskId, resolvedAt: now.toISOString(),
        ...(typeof candidateOpen.raw.firstContendedAt === "string"
          ? { firstContendedAt: candidateOpen.raw.firstContendedAt } : {}) } });
  }
};

const holderDetail = (holder: MergeLeaseHolder | null | undefined): string => holder
  ? `held by ${holder.holder}${holder.task ? ` (task ${holder.task})` : ""} since ${holder.acquiredAt}`
  : "held by a holder the lease script could not name";

/** Preserve the owning Task on callback failure so release transport failures
 * enter the existing durable deferral path. The repository mutex remains held
 * through release, preventing an old tick from releasing a newer train held
 * under the same first-candidate Chain identity. */
const withTrainLease = async <T>(
  db: PrismaClient, lease: WithMergeLease, target: { projectId: string; chainId: string },
  train: PendingTrain, now: Date,
  fn: () => Promise<{ value: T; leaseOutcome: HeldLeaseOutcome }>,
): Promise<void> => {
  await db.$transaction(async (mutexTx) => {
    if (!await tryRepositoryMutex(mutexTx, train.repoId)) return;
    // Use a fresh read after acquisition, not the outer transaction's snapshot.
    const marker = await readLatestMarker(db, train.taskId, "train");
    if (marker?.state !== "queued" && marker?.state !== "acquiring") return;
    let failed = false;
    let failure: unknown;
    const leased = await lease(target, async () => {
      try { return await fn(); }
      catch (error: unknown) {
        failed = true;
        failure = error;
        return { value: undefined, leaseOutcome: { kind: "stop", taskId: train.regressionTaskId } };
      }
    }, db);
    if (failed) throw failure;
    // An acquisition that never ran the callback leaves the train exactly as it
    // was; it is deferred to a later tick, but never without a record.
    if (leased.outcome === "contended") {
      await noteTrainLeaseUnavailable(mutexTx, train, "contended", holderDetail(leased.holder), now);
      return;
    }
    if (leased.outcome === "unreachable") {
      await noteTrainLeaseUnavailable(mutexTx, train, "unreachable", leased.detail, now);
      return;
    }
    await clearTrainLeaseUnavailable(mutexTx, train, now);
  }, { ...serializable, timeout: 300_000 });
};

const lockCandidates = async (tx: Prisma.TransactionClient, candidates: TrainCandidateBinding[]): Promise<void> => {
  // All train writers take chain locks in the same order, independent of FIFO.
  for (const candidate of [...candidates].sort((a, b) => a.chainId.localeCompare(b.chainId))) {
    if (!await lockTaskMutationRows(tx, candidate.taskId)) throw new Error(`Merge train candidate ${candidate.taskId} is missing`);
  }
};

const liveBase = async (reader: PullRequestReader, read: ReadyRead): Promise<string> => {
  if (!read.input.target.resolved) throw new Error("Merge train pull request target is unresolved");
  const snapshot = await reader.readPullRequest(read.input.target.repository, read.input.target.prNumber,
    read.input.defaultBranch, AbortSignal.timeout(READINESS_READ_BUDGET_MS));
  if (!snapshot.baseSha || snapshot.baseRefName !== read.input.defaultBranch) throw new Error("Merge train live default branch is unavailable");
  return snapshot.baseSha;
};

const excludedRecovery = async (db: PrismaClient | Prisma.TransactionClient, taskId: string): Promise<boolean> => Boolean(
  await db.mergeRecoveryAttempt.findFirst({ where: {
    readinessTaskId: taskId,
    status: { in: [MergeRecoveryStatus.REPAIRING, MergeRecoveryStatus.BLOCKED_DOWNSTREAM] },
  }, select: { id: true } }),
);

const releaseClaim = async (db: PrismaClient, read: ClaimedReadiness): Promise<void> => {
  await db.$transaction((tx) => read.claim.settle(tx, { kind: "finish", at: new Date(), apply: async (client) => {
    await client.task.update({ where: { id: read.readiness.id }, data: { status: TaskStatus.TODO } });
    return { value: undefined, ownership: "released" };
  } }), serializable);
};

const evidenceStillMatches = async (tx: Prisma.TransactionClient, read: ReadyRead): Promise<boolean> => {
  const regression = await tx.task.findUnique({ where: { id: read.regression.id }, include: { stepOutput: true } });
  const output = regression?.stepOutput;
  const verdict = parseRegressionVerdict(output?.body ?? "", output?.kind ?? "");
  return regression?.status === TaskStatus.DONE && verdict.status === "ok" && verdict.verdict.outcome === "pass"
    && verdict.verdict.headSha === read.input.regression.headSha && output?.commitSha === verdict.verdict.headSha
    && output.id === read.regression.stepOutput?.id && output.updatedAt.getTime() === read.regression.stepOutput.updatedAt.getTime()
    && !await excludedRecovery(tx, read.readiness.id);
};

export const pendingMergeTrains = async (db: PrismaClient | Prisma.TransactionClient): Promise<PendingTrain[]> => {
  const tasks = await db.task.findMany({ where: {
    chainId: null,
    activity: { some: { actorType: "control-plane", metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.train } } },
    // Train cards are never retried. Exclude terminal histories in the query
    // so an off-by-default worker does not reread every historical train.
    NOT: { activity: { some: {
      actorType: "control-plane", metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.train },
      OR: [{ metadata: { path: ["state"], equals: "settled" } }, { metadata: { path: ["state"], equals: "aborted" } }],
    } } },
  }, select: { id: true, projectId: true, repoId: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const pending: PendingTrain[] = [];
  for (const task of tasks) {
    const marker = await readLatestMarker(db, task.id, "train");
    if (marker?.state !== "queued" && marker?.state !== "acquiring") continue;
    const parsed = parseMergeTrainMarker(marker.raw);
    if (parsed.status !== "ok" || parsed.marker.trainTaskId !== task.id || !task.repoId || !parsed.marker.regressionTaskId
      || !parsed.marker.baseSha || !parsed.marker.width || !parsed.marker.candidates) {
      throw new Error(`Merge train ${task.id} has malformed durable ownership metadata`);
    }
    pending.push({ taskId: task.id, state: marker.state, projectId: task.projectId, repoId: task.repoId,
      regressionTaskId: parsed.marker.regressionTaskId, baseSha: parsed.marker.baseSha, width: parsed.marker.width,
      candidates: parsed.marker.candidates });
  }
  return pending;
};

const finishTrainMarker = async (
  tx: Prisma.TransactionClient,
  train: PendingTrain,
  state: "settled" | "aborted",
  summary: string,
  now: Date,
): Promise<void> => {
  await writeMarker(tx, train.taskId, "train", { actorType: "control-plane", body: summary,
    metadata: { state, trainTaskId: train.taskId, regressionTaskId: train.regressionTaskId,
      baseSha: train.baseSha, width: train.width, candidates: train.candidates, reason: summary } });
  // The terminal state and the release obligation commit together. If the
  // process exits after this transaction but before the external release,
  // reconciliation can retry this exact holder without replaying the train.
  await recordLeaseDeferral(tx, {
    target: { projectId: train.projectId, chainId: train.candidates[0]!.chainId },
    taskId: train.regressionTaskId,
    failureDetail: `Merge train ${train.taskId} reached ${state}; lease release awaits confirmation`,
    at: now,
  });
  // A settled train is finished automation, not review work: closing it here
  // keeps a completed card off the operator's board, while an aborted train
  // keeps its diagnostic REVIEW state and reason.
  await tx.task.update({ where: { id: train.taskId }, data: {
    description: `${mergeTrainTaskDescription(train)}\n\nSettlement:\n${summary}`,
    ...(state === "aborted"
      ? { status: TaskStatus.REVIEW, failureReason: summary }
      : { status: TaskStatus.DONE, failureReason: null }),
  } });
};

const candidateSettlementMarker = async (
  tx: Prisma.TransactionClient, train: PendingTrain, position: number, settlement: string, reason?: string,
  details: { verdict?: string; predecessorOid?: string } = {},
): Promise<void> => {
  const candidate = train.candidates[position - 1]!;
  await writeMarker(tx, candidate.taskId, "train", { actorType: "control-plane",
    body: `Merge train ${train.taskId}, position ${position}: ${settlement}${reason ? `; ${reason}` : ""}`,
    metadata: { state: settlement === "aborted" ? "aborted" : "settled", trainTaskId: train.taskId, position,
      settlement: details.verdict ?? settlement, outcome: settlement,
      ...(details.predecessorOid ? { predecessorOid: details.predecessorOid } : {}), ...(reason ? { reason } : {}) } });
};

const abortTrain = async (
  db: PrismaClient, train: PendingTrain, reason: string, now: Date,
): Promise<boolean> => db.$transaction(async (tx) => {
  await lockCandidates(tx, train.candidates);
  const current = await readLatestMarker(tx, train.taskId, "train");
  if (current?.state !== "queued" && current?.state !== "acquiring") return false;
  for (const [index, candidate] of train.candidates.entries()) {
    await tx.task.updateMany({ where: { id: candidate.taskId, status: { in: [TaskStatus.TODO, TaskStatus.DOING] } },
      data: { status: TaskStatus.TODO, readinessClaimToken: null, readinessClaimExpiresAt: null, failureReason: null } });
    await noticeMergeTrainAbort(tx, { readinessTaskId: candidate.taskId, trainTaskId: train.taskId, reason, now });
    await candidateSettlementMarker(tx, train, index + 1, "aborted", reason);
  }
  await finishTrainMarker(tx, train, "aborted", reason, now);
  return true;
}, serializable);

/**
 * Read and claim one candidate for a train phase. Both the enqueue and the
 * settlement phase apply exactly this eligibility rule; keeping it in one place
 * is what stops the two from drifting apart. `phase` supplies only the wording
 * of the refusal.
 */
type CandidateReadResult =
  | { kind: "ready"; read: ReadyRead }
  | { kind: "claim-lost" }
  | { kind: "ineligible"; reason: string };

const readEligibleCandidate = async (
  db: PrismaClient, train: PendingTrain, candidate: TrainCandidateBinding,
  now: Date, hooks: TrainHooks, phase: string,
): Promise<CandidateReadResult> => {
  const refused = (detail: string): CandidateReadResult => (
    { kind: "ineligible", reason: `Merge train ${phase} candidate ${candidate.taskId} ${detail}` }
  );
  const readiness = await db.task.findUnique({ where: { id: candidate.taskId }, include: {
    templateStep: { include: { taskTemplate: { select: { name: true } } } }, repo: true,
  } });
  if (!readiness || readiness.projectId !== train.projectId || readiness.repoId !== train.repoId
    || readiness.chainId !== candidate.chainId || !isMergeReadinessStep(readiness.templateStep)
    || await excludedRecovery(db, candidate.taskId)) return refused("is no longer eligible");
  const read = await hooks.read(db, readiness, now);
  if (!read.claimed) {
    if (read.input.stage === "claim-lost") return { kind: "claim-lost" };
    return refused("no longer has completed Regression evidence");
  }
  if (read.input.stage !== "ready") {
    await releaseClaim(db, read);
    return refused("no longer has valid Regression evidence");
  }
  const ready = read as ReadyRead;
  if (ready.input.regression.headSha !== candidate.headSha
    || ready.regression.runs[0]?.branch !== candidate.branch) {
    return refused("binding changed");
  }
  return { kind: "ready", read: ready };
};

const enqueueReservedTrain = async (
  db: PrismaClient, reader: PullRequestReader, train: PendingTrain, now: Date, hooks: TrainHooks,
): Promise<"waiting" | "finished"> => {
  const reads: ReadyRead[] = [];
  try {
    for (const candidate of train.candidates) {
      const eligible = await readEligibleCandidate(db, train, candidate, now, hooks, "reservation");
      if (eligible.kind === "claim-lost") return "waiting";
      if (eligible.kind === "ineligible") throw new Error(eligible.reason);
      reads.push(eligible.read);
    }
    // The remote read stays outside the transaction: holding the repository row
    // and every candidate chain lock across a 20-second GitHub call would block
    // unrelated writers for no added guarantee, since the live base can move
    // the instant after it is read either way.
    if (await liveBase(reader, reads[0]!) !== train.baseSha) throw new Error("Merge train base moved before enqueue");
    await db.$transaction(async (tx) => {
      await lockCandidates(tx, train.candidates);
      await tx.$queryRaw`SELECT "id" FROM "Repo" WHERE "id" = ${train.repoId} FOR UPDATE`;
      if ((await readLatestMarker(tx, train.taskId, "train"))?.state !== "acquiring") return;
      const unresolved = await tx.mergeLeaseEvent.findFirst({ where: {
        state: MergeLeaseEventState.RELEASE_DEFERRED,
        owningTask: { repoId: train.repoId },
      }, select: { id: true } });
      if (unresolved) throw new Error("Merge train reservation has unresolved lease cleanup");
      for (const read of reads) {
        if (!await evidenceStillMatches(tx, read)) throw new Error(`Merge train reservation evidence changed for ${read.readiness.id}`);
      }
      await enqueueMergeTrainTask(tx, train.taskId, now);
      for (const read of reads) {
        const settled = await read.claim.settle(tx, { kind: "finish", at: now, apply: async (client) => {
          await client.task.update({ where: { id: read.readiness.id }, data: { status: TaskStatus.TODO, failureReason: null } });
          return { value: undefined, ownership: "released" };
        } });
        if (!settled.settled) throw new Error(`Merge train reservation claim lost for ${read.readiness.id}`);
      }
    }, serializable);
    return "waiting";
  } catch (error: unknown) {
    await abortTrain(db, train, error instanceof Error ? error.message : String(error), now);
    return "finished";
  } finally {
    for (const read of reads) await releaseClaim(db, read);
  }
};

/**
 * The first candidate inside the passing prefix whose Approval gate has no
 * operator authorization bound to the head and base this settlement verified.
 * Read-only: it asks the same question `authorizeReadinessSettlement` asks, so
 * the answer can truncate the prefix before any authorization is written.
 */
const firstGateRefusal = async (
  tx: Prisma.TransactionClient, reads: ReadyRead[],
  decisions: ReadinessDecision[], passCount: number,
): Promise<{ index: number; reason: string } | null> => {
  for (let index = 0; index < Math.min(passCount, reads.length); index += 1) {
    const read = reads[index]!;
    const current = await tx.task.findUniqueOrThrow({ where: { id: read.readiness.id }, select: {
      approvalGate: true,
      templateStep: { select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } } },
    } });
    if (!isGatedMergeReadinessTask(current)) continue;
    const decision = decisions[index];
    if (!decision || decision.kind !== "authorize") {
      throw new Error(`Merge train second read refused passing candidate ${read.readiness.id}: ${decision?.kind ?? "missing decision"}`);
    }
    try {
      await requireMergeGateAuthorization(tx, { taskId: read.readiness.id,
        headSha: decision.evidence.headSha, baseSha: decision.evidence.baseSha });
    } catch (error: unknown) {
      if (!(error instanceof MergeGateAuthorizationError)) throw error;
      return { index, reason: error.message };
    }
  }
  return null;
};

const settleTrain = async (
  db: PrismaClient, reader: PullRequestReader, train: PendingTrain, now: Date,
  hooks: TrainHooks, result: ReadinessTickResult,
): Promise<"waiting" | "finished"> => {
  const task = await db.task.findUnique({ where: { id: train.taskId }, include: {
    stepOutput: true, runs: { orderBy: { runNumber: "desc" }, take: 1 },
  } });
  const run = task?.runs[0];
  const output = task?.stepOutput;
  let failure: string | null = null;
  if (run?.status === RunStatus.LOST || run?.status === RunStatus.CANCELLED || task?.archivedAt) {
    failure = task?.archivedAt ? "Merge train task was archived" : `Merge train Run ${run!.id} ended ${run!.status}`;
  } else if (!output) {
    if (run && ACTIVE_RUN_STATUSES.includes(run.status) && task?.status !== TaskStatus.REVIEW) return "waiting";
    failure = run ? `Merge train Run ${run.id} ended ${run.status} without a merge-train-v1 record`
      : "Merge train Run was lost or never opened";
  } else if (output.kind !== MERGE_TRAIN_OUTPUT_KIND || output.runId !== run?.id) {
    failure = "Merge train output kind or Run binding is invalid";
  }
  const parsed = parseMergeTrainRecord(output?.body);
  if (!failure && parsed.status === "invalid") failure = parsed.reason;
  if (failure || parsed.status !== "ok") {
    await abortTrain(db, train, failure ?? "Invalid merge train output", now);
    return "finished";
  }

  const reads: ReadyRead[] = [];
  try {
    for (const candidate of train.candidates) {
      const eligible = await readEligibleCandidate(db, train, candidate, now, hooks, "settlement");
      if (eligible.kind === "claim-lost") return "waiting";
      if (eligible.kind === "ineligible") throw new Error(eligible.reason);
      result.claimed += 1;
      reads.push(eligible.read);
    }
    const record = parsed.record;
    const bindingFailure = trainRecordBindingFailure(record, train, await liveBase(reader, reads[0]!));
    if (bindingFailure) throw new Error(bindingFailure);
    const decisions: ReadinessDecision[] = [];
    for (const [index, read] of reads.entries()) {
      const decision = await evaluateReadiness(reader, { ...read.input,
        regression: { ...read.input.regression, baseHeadSha: record.baseSha },
        train: { baseSha: record.baseSha, candidateHeadSha: read.input.regression.headSha },
      });
      // A refusal in the gated cumulative prefix invalidates that prefix and
      // aborts the train. A trailing candidate is not part of the published
      // prefix: leave it ready for the next train and preserve the passing
      // prefix that was already recorded by the runtime.
      if (decision.kind !== "authorize" && index < record.contiguousPassCount) {
        throw new Error(`Merge train second read refused ${read.readiness.id}: ${decision.kind}${"reason" in decision ? `: ${decision.reason}` : "evidence" in decision ? `: ${decision.evidence}` : ""}`);
      }
      decisions.push(decision);
    }
    for (const read of reads) {
      if (!await read.claim.renew()) throw new Error(`Merge train candidate ${read.readiness.id} claim lost before settlement`);
    }
    const counts = await db.$transaction(async (tx) => {
      await lockCandidates(tx, train.candidates);
      if ((await readLatestMarker(tx, train.taskId, "train"))?.state !== "queued") return { authorized: 0, stopped: 0, requeued: 0 };
      for (const read of reads) {
        if (!await evidenceStillMatches(tx, read)) throw new Error(`Merge train candidate ${read.readiness.id} evidence changed during settlement`);
      }
      // The approval gate applies per candidate, so one unapproved candidate
      // truncates the prefix here instead of discarding the whole train: the
      // positions before it are authorized against the shorter prefix, it stops
      // on its own refusal, and the positions after it return to `ready`. The
      // check is read-only and runs before the first authorization write so a
      // refusal cannot roll back a peer's settled authorization.
      const gateRefusal = await firstGateRefusal(tx, reads, decisions, record.contiguousPassCount);
      const authorizedCount = gateRefusal ? gateRefusal.index : record.contiguousPassCount;
      // This is the last shared authorization check, inside the candidate
      // transaction and under the train Lease. An outage returns the whole
      // train to readiness without losing the per-Step offline episode.
      const blockedExecutors = hooks.executor.blocking();
      if (blockedExecutors.length > 0) {
        const summaries: string[] = [];
        let stopped = 0;
        for (const [index, read] of reads.entries()) {
          const settlement = await hooks.executor.settleOffline(tx, read, blockedExecutors);
          if (settlement === "stopped") stopped += 1;
          const reason = `merge-executor-offline: no merge executor in ${blockedExecutors.join(", ")} is online`;
          const prefix = record.prefixes[index];
          const verdict = prefix?.verdict
            ?? (record.blocked.some((entry) => entry.taskId === read.readiness.id) ? "blocked" : "skipped");
          await candidateSettlementMarker(tx, train, index + 1, settlement, reason,
            { verdict, ...(prefix ? { predecessorOid: prefix.predecessorOid } : {}) });
          summaries.push(`${index + 1}. ${read.readiness.id}: ${verdict} → ${settlement}; ${reason}`);
        }
        await finishTrainMarker(tx, train, "settled", summaries.join("\n"), now);
        return { authorized: 0, stopped, requeued: reads.length - stopped };
      }
      for (const read of reads) await hooks.executor.closeEpisode(tx, read.readiness.id);
      const passing = record.prefixes[authorizedCount - 1];
      const summaries: string[] = [];
      let failed = false;
      let stopped = 0;
      for (const [index, read] of reads.entries()) {
        const prefix = record.prefixes[index];
        let settlement = "ready";
        const decision = decisions[index];
        const refused = !decision || decision.kind !== "authorize";
        const refusalReason = refused
          ? `Merge train second read returned ${decision?.kind ?? "no decision"}${decision && "reason" in decision ? `: ${decision.reason}` : decision && "evidence" in decision ? `: ${decision.evidence}` : ""}`
          : undefined;
        if (index < authorizedCount && passing && prefix) {
          if (!decision || decision.kind !== "authorize") {
            throw new Error(`Merge train second read refused passing candidate ${read.readiness.id}: ${decision?.kind ?? "missing decision"}`);
          }
          const authorization = hooks.authorize(read, decision, {
            publishHead: passing.prefixOid, predecessorOid: prefix.predecessorOid,
            ref: passing.ref, position: index + 1, trainTaskId: train.taskId,
          });
          const applied = await authorization.body(tx, read.claim);
          if (!applied.value.applied) throw new Error(`Merge train readiness claim lost for ${read.readiness.id}`);
          // The train owns the one lease until every authorization is durable;
          // per-chain executor handoffs deliberately do not retain this lease.
          settlement = "authorized";
        } else if (gateRefusal && index === gateRefusal.index) {
          settlement = "stopped";
          const transition = await read.claim.settle(tx, { kind: "finish", at: now, apply: async (client) => {
            await stopMergeTail(client, { phase: "readiness", readinessTaskId: read.readiness.id,
              regressionTaskId: read.regression.id, reason: gateRefusal.reason, recovery: read.recovery, at: now });
            return { value: undefined, ownership: "released" };
          } });
          if (!transition.settled) throw new Error(`Merge train readiness claim lost for ${read.readiness.id}`);
          stopped += 1;
          await candidateSettlementMarker(tx, train, index + 1, settlement, gateRefusal.reason,
            { verdict: prefix?.verdict ?? "skipped", ...(prefix ? { predecessorOid: prefix.predecessorOid } : {}) });
          summaries.push(`${index + 1}. ${read.readiness.id}: ${prefix?.verdict ?? "skipped"} → ${settlement}`);
          continue;
        } else {
          // A gate refusal truncates the published prefix at its position, so
          // every later prefix was gated against a predecessor this settlement
          // no longer publishes: its verdict says nothing about the candidate
          // and returns it to `ready` rather than charging a repair budget.
          const truncated = gateRefusal !== null && index > gateRefusal.index;
          const blocked = refused || truncated
            ? undefined
            : record.blocked.find((candidate) => candidate.taskId === read.readiness.id);
          const firstFail = !refused && !truncated && prefix?.verdict === "fail" && !failed;
          if (firstFail) failed = true;
          settlement = refused ? "ready" : blocked ? "blocked" : firstFail ? "repairing" : "ready";
          const transition = await read.claim.settle(tx, { kind: "finish", at: now, apply: async (client) => {
            if (!refused && (blocked || firstFail)) {
              const failureSettlement = await settleMergeTrainFailure(client, {
                readinessTaskId: read.readiness.id, regressionTaskId: read.regression.id,
                headSha: read.input.regression.headSha, predecessorOid: prefix?.predecessorOid ?? record.prefixes.at(-1)?.prefixOid ?? record.baseSha,
                trainTaskId: train.taskId, now,
                ...(blocked ? { kind: "blocked" as const, reason: blocked.reason }
                  : { kind: "fail" as const, gateExcerpt: prefix!.gateExcerpt }),
              });
              settlement = failureSettlement.kind === "repair-opened" ? "repairing" : "blocked";
              if (failureSettlement.kind === "stopped") stopped += 1;
            } else {
              await client.task.update({ where: { id: read.readiness.id }, data: { status: TaskStatus.TODO, failureReason: null } });
            }
            return { value: undefined, ownership: "released" };
          } });
          if (!transition.settled) throw new Error(`Merge train readiness claim lost for ${read.readiness.id}`);
        }
        const verdict = decision && decision.kind !== "authorize"
          ? "no-verdict"
          : prefix?.verdict ?? (record.blocked.some((entry) => entry.taskId === read.readiness.id) ? "blocked" : "skipped");
        await candidateSettlementMarker(tx, train, index + 1, settlement,
          decision && decision.kind !== "authorize"
            ? refusalReason
            : record.blocked.find((entry) => entry.taskId === read.readiness.id)?.reason,
          { verdict, ...(prefix ? { predecessorOid: prefix.predecessorOid } : {}) });
        summaries.push(`${index + 1}. ${read.readiness.id}: ${verdict} → ${settlement}`);
      }
      await finishTrainMarker(tx, train, "settled", summaries.join("\n"), now);
      return { authorized: authorizedCount, stopped, requeued: 0 };
    }, serializable);
    result.authorized += counts.authorized;
    result.stopped += counts.stopped;
    result.requeued += counts.requeued;
    return "finished";
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    await abortTrain(db, train, reason, now);
    return "finished";
  } finally {
    for (const read of reads) await releaseClaim(db, read);
  }
};

export const mergeTrainReadinessTick = async (
  db: PrismaClient, reader: PullRequestReader, now: Date, budget: { width: number; limit: number },
  release: ReleaseMergeLease, lease: WithMergeLease, hooks: TrainHooks,
  existingPending?: PendingTrain[],
): Promise<ReadinessTickResult> => {
  const { width, limit } = budget;
  const result: ReadinessTickResult = { claimed: 0, authorized: 0, requeued: 0, stopped: 0 };
  const pending = existingPending ?? await pendingMergeTrains(db);
  const unresolvedLeases = await db.mergeLeaseEvent.findMany({
    where: { state: width > 0
      ? MergeLeaseEventState.RELEASE_DEFERRED
      : { in: [MergeLeaseEventState.RELEASE_DEFERRED, MergeLeaseEventState.HANDOFF_PENDING] } },
    select: { state: true, owningTask: { select: { id: true, repoId: true } } },
  });
  // A deferred release represents unresolved cleanup from an earlier holder and
  // fences a new generation. A routine HANDOFF_PENDING event is not a train
  // formation precondition; it is settled by its queued Run consumer.
  const busyRepos = new Set(pending.map((train) => train.repoId));
  const unresolvedLeaseRepos = new Set(
    unresolvedLeases.flatMap((event) => event.owningTask.repoId ? [event.owningTask.repoId] : []),
  );
  for (const train of pending) {
    const target = { projectId: train.projectId, chainId: train.candidates[0]!.chainId };
    await withTrainLease(db, lease, target, train, now, async () => {
      const releaseWasDeferred = unresolvedLeases.some((event) => event.state === MergeLeaseEventState.RELEASE_DEFERRED
        && event.owningTask.id === train.regressionTaskId);
      let outcome: "waiting" | "finished";
      if (releaseWasDeferred) {
        await abortTrain(db, train, "Previous merge train lease release was deferred", now);
        outcome = "finished";
      } else outcome = train.state === "acquiring"
        ? await enqueueReservedTrain(db, reader, train, now, hooks)
        : await settleTrain(db, reader, train, now, hooks, result);
      return { value: outcome, leaseOutcome: outcome === "waiting" ? { kind: "continue" } : { kind: "stop", taskId: train.regressionTaskId } };
    });
  }

  const single = async (read: ClaimedReadiness, decision: ReadinessDecision): Promise<void> => {
    if (!read.readiness.repoId) {
      await hooks.single(db, read, decision, result, release, lease, reader);
      return;
    }
    await db.$transaction(async (mutexTx) => {
      if (!await tryRepositoryMutex(mutexTx, read.readiness.repoId!)) return;
      if ((await pendingMergeTrains(db)).some((train) => train.repoId === read.readiness.repoId)) return;
      await hooks.single(db, read, decision, result, release, lease, reader);
    }, { ...serializable, timeout: 300_000 });
  };
  const groups = new Map<string, ReadyRead[]>();
  // Every claim this tick takes is released here, including the ones handed to
  // `single`, whose repository-mutex and pending-train arms return without
  // settling. A claim left behind parks its candidate for the claim lease.
  const claimed: ClaimedReadiness[] = [];
  try {
    if (width > 0) {
      type DiscoveredCandidate = { candidate: ReadinessCandidate; discovery: ReadinessDiscovery };
      const groups = new Map<string, DiscoveredCandidate[]>();
      const fallback: DiscoveredCandidate[] = [];
      for await (const candidate of hooks.candidates(db, Math.max(limit * 20, 100))) {
        if (!isMergeReadinessStep(candidate.templateStep)) continue;
        if ((candidate.repoId && busyRepos.has(candidate.repoId)) || await excludedRecovery(db, candidate.id)) continue;
        const discovery = await hooks.discover(db, candidate, now);
        const entry = { candidate, discovery };
        if (discovery.input.stage === "ready" && candidate.repoId && discovery.input.target.resolved) {
          const group = groups.get(candidate.repoId) ?? [];
          group.push(entry);
          groups.set(candidate.repoId, group);
        } else {
          fallback.push(entry);
        }
      }

      // Discovery is deliberately unbounded by the mutation budget. The
      // generator still pages, but every ready PASS is present before any
      // repository chooses its FIFO prefix.
      const orderedGroups = [...groups.entries()].map(([repoId, group]) => {
        group.sort((left, right) => left.discovery.evidenceCreatedAt!.getTime() - right.discovery.evidenceCreatedAt!.getTime()
          || left.candidate.id.localeCompare(right.candidate.id));
        return { repoId, group };
      }).sort((left, right) => left.group[0]!.discovery.evidenceCreatedAt!.getTime()
        - right.group[0]!.discovery.evidenceCreatedAt!.getTime() || left.repoId.localeCompare(right.repoId));
      const claimedCandidate = async (candidate: ReadinessCandidate): Promise<ClaimedReadiness | null> => {
        if (result.claimed >= limit) return null;
        const read = await hooks.read(db, candidate, now);
        if (!read.claimed) return null;
        result.claimed += 1;
        claimed.push(read);
        return read;
      };

      for (const { repoId, group } of orderedGroups) {
        if (result.claimed >= limit) break;
        const selectedEntries = group.slice(0, Math.min(width, limit - result.claimed));
        const selected: ReadyRead[] = [];
        for (const entry of selectedEntries) {
          const read = await claimedCandidate(entry.candidate);
          if (!read) continue;
          if (read.input.stage !== "ready" || !read.readiness.repoId || !read.input.target.resolved) {
            await single(read, await evaluateReadiness(reader, read.input));
            continue;
          }
          selected.push(read as ReadyRead);
        }
        if (selected.length === 0) continue;

        const first = selected[0]!;
        let baseSha: string;
        try { baseSha = await liveBase(reader, first); }
        catch (error: unknown) {
          await db.$transaction((tx) => first.claim.settle(tx, { kind: "keep", apply: async (client) => client.taskActivity.create({ data: {
            taskId: first.readiness.id, actorType: "control-plane",
            body: `Merge train formation deferred: ${error instanceof Error ? error.message : String(error)}`,
          } }) }), serializable);
          continue;
        }
        if (unresolvedLeaseRepos.has(repoId)) {
          for (const read of selected) await single(read, await evaluateReadiness(reader, read.input));
          continue;
        }
        if (selected.length === 1 && first.input.regression.baseHeadSha === baseSha) {
          await single(first, await evaluateReadiness(reader, first.input));
          continue;
        }
        const candidates = selected.map((read) => ({ taskId: read.readiness.id, chainId: read.readiness.chainId!,
          headSha: read.input.regression.headSha, branch: read.regression.runs[0]?.branch ?? "" }));
        if (candidates.some((candidate) => !candidate.chainId || !candidate.branch)) {
          for (const read of selected) await single(read, {
            kind: "stop", condition: "merge-train-branch-unavailable", evidence: "Merge train candidate chain branch is unavailable",
          });
          continue;
        }
        let claimsHeld = true;
        for (const read of selected) if (!await read.claim.renew()) claimsHeld = false;
        if (!claimsHeld) continue;
        const target = { projectId: first.readiness.projectId, chainId: candidates[0]!.chainId };
        let reservation: PendingTrain | null = null;
        try {
          reservation = await db.$transaction(async (tx) => {
            if (!await tryRepositoryMutex(tx, repoId)) return null;
            await lockCandidates(tx, candidates);
            await tx.$queryRaw`SELECT "id" FROM "Repo" WHERE "id" = ${repoId} FOR UPDATE`;
            if ((await pendingMergeTrains(tx)).some((train) => train.repoId === repoId)) return null;
            const unresolved = await tx.mergeLeaseEvent.findFirst({ where: {
              state: MergeLeaseEventState.RELEASE_DEFERRED,
              owningTask: { repoId },
            }, select: { id: true } });
            if (unresolved) return null;
            for (const read of selected) {
              if (!await evidenceStillMatches(tx, read)) throw new Error(`Merge train candidate ${read.readiness.id} changed before reservation`);
              const held = await read.claim.settle(tx, { kind: "keep", apply: async () => true });
              if (!held.settled) throw new Error(`Merge train candidate ${read.readiness.id} claim lost before reservation`);
            }
            const task = await reserveMergeTrainTask(tx, {
              regressionTaskId: first.regression.id, baseSha, width, candidates, now,
            });
            for (const read of selected) {
              const transitioned = await read.claim.settle(tx, { kind: "finish", at: now, apply: async (client) => {
                await client.task.update({ where: { id: read.readiness.id }, data: { status: TaskStatus.TODO, failureReason: null } });
                return { value: undefined, ownership: "released" };
              } });
              if (!transitioned.settled) throw new Error(`Merge train candidate ${read.readiness.id} claim lost at reservation`);
            }
            return { taskId: task.taskId, state: "acquiring" as const, regressionTaskId: first.regression.id,
              projectId: first.readiness.projectId, repoId, baseSha, width, candidates };
          }, serializable);
        } catch (error: unknown) {
          const reason = `Merge train reservation failed: ${error instanceof Error ? error.message : String(error)}`;
          for (const read of selected) await single(read, {
            kind: "stop", condition: "merge-train-reservation-failed", evidence: reason,
          });
        }
        if (reservation) {
          const train = reservation;
          await withTrainLease(db, lease, target, train, now, async () => {
            const outcome = await enqueueReservedTrain(db, reader, train, now, hooks);
            return { value: outcome, leaseOutcome: outcome === "waiting" ? { kind: "continue" } : { kind: "stop", taskId: first.regression.id } };
          });
        }
      }

      // Non-ready candidates still receive the existing single-candidate
      // handling, but only after ready evidence has had the opportunity to form
      // its FIFO train. This keeps the claim budget from hiding a later peer.
      for (const { candidate } of fallback) {
        if (result.claimed >= limit) break;
        const read = await claimedCandidate(candidate);
        if (!read) continue;
        await single(read, await evaluateReadiness(reader, read.input));
      }
      return result;
    }
    for await (const candidate of hooks.candidates(db, Math.max(limit * 20, 100))) {
      // The caller's claim budget bounds this loop exactly as it bounds the
      // single-candidate tick; a formed train is bounded by `width` instead.
      if (result.claimed >= limit) break;
      if (!isMergeReadinessStep(candidate.templateStep)) continue;
      if ((candidate.repoId && busyRepos.has(candidate.repoId)) || await excludedRecovery(db, candidate.id)) continue;
      const read = await hooks.read(db, candidate, now);
      if (!read.claimed) continue;
      result.claimed += 1;
      claimed.push(read);
      if (read.input.stage !== "ready" || !candidate.repoId || !read.input.target.resolved) {
        await single(read, await evaluateReadiness(reader, read.input));
        continue;
      }
      const group = groups.get(candidate.repoId) ?? [];
      group.push(read as ReadyRead);
      groups.set(candidate.repoId, group);
    }
    for (const [repoId, group] of groups) {
      // FIFO by when the Regression evidence was persisted, which is the row's
      // creation: `updatedAt` moves on any later re-upsert of the same verdict.
      group.sort((left, right) => left.regression.stepOutput!.createdAt.getTime() - right.regression.stepOutput!.createdAt.getTime()
        || left.readiness.id.localeCompare(right.readiness.id));
      const first = group[0]!;
      let baseSha: string;
      try { baseSha = await liveBase(reader, first); }
      catch (error: unknown) {
        // Remote read failures are named even though no train/lease exists yet.
        await db.$transaction((tx) => first.claim.settle(tx, { kind: "keep", apply: async (client) => client.taskActivity.create({ data: {
          taskId: first.readiness.id, actorType: "control-plane",
          body: `Merge train formation deferred: ${error instanceof Error ? error.message : String(error)}`,
        } }) }), serializable);
        continue;
      }
      if (width === 0 || unresolvedLeaseRepos.has(repoId)) {
        for (const read of group) await single(read, await evaluateReadiness(reader, read.input));
        continue;
      }
      if (group.length === 1 && first.input.regression.baseHeadSha === baseSha) {
        await single(first, await evaluateReadiness(reader, first.input));
        continue;
      }
      const selected = group.slice(0, width);
      const candidates = selected.map((read) => ({ taskId: read.readiness.id, chainId: read.readiness.chainId!,
        headSha: read.input.regression.headSha, branch: read.regression.runs[0]?.branch ?? "" }));
      if (candidates.some((candidate) => !candidate.chainId || !candidate.branch)) {
        for (const read of selected) await single(read, {
          kind: "stop", condition: "merge-train-branch-unavailable", evidence: "Merge train candidate chain branch is unavailable",
        });
        continue;
      }
      let claimsHeld = true;
      for (const read of selected) if (!await read.claim.renew()) claimsHeld = false;
      if (!claimsHeld) continue;
      const target = { projectId: first.readiness.projectId, chainId: candidates[0]!.chainId };
      let reservation: PendingTrain | null = null;
      try {
        reservation = await db.$transaction(async (tx) => {
          if (!await tryRepositoryMutex(tx, first.readiness.repoId!)) return null;
          await lockCandidates(tx, candidates);
          await tx.$queryRaw`SELECT "id" FROM "Repo" WHERE "id" = ${first.readiness.repoId} FOR UPDATE`;
          if ((await pendingMergeTrains(tx)).some((train) => train.repoId === first.readiness.repoId)) return null;
          const unresolved = await tx.mergeLeaseEvent.findFirst({ where: {
            state: MergeLeaseEventState.RELEASE_DEFERRED,
            owningTask: { repoId: first.readiness.repoId },
          }, select: { id: true } });
          if (unresolved) return null;
          for (const read of selected) {
            if (!await evidenceStillMatches(tx, read)) throw new Error(`Merge train candidate ${read.readiness.id} changed before reservation`);
            const held = await read.claim.settle(tx, { kind: "keep", apply: async () => true });
            if (!held.settled) throw new Error(`Merge train candidate ${read.readiness.id} claim lost before reservation`);
          }
          const task = await reserveMergeTrainTask(tx, {
            regressionTaskId: first.regression.id, baseSha, width, candidates, now,
          });
          for (const read of selected) {
            const transitioned = await read.claim.settle(tx, { kind: "finish", at: now, apply: async (client) => {
              await client.task.update({ where: { id: read.readiness.id }, data: { status: TaskStatus.TODO, failureReason: null } });
              return { value: undefined, ownership: "released" };
            } });
            if (!transitioned.settled) throw new Error(`Merge train candidate ${read.readiness.id} claim lost at reservation`);
          }
          return { taskId: task.taskId, state: "acquiring" as const, regressionTaskId: first.regression.id,
            projectId: first.readiness.projectId, repoId: first.readiness.repoId!, baseSha, width, candidates };
        }, serializable);
      } catch (error: unknown) {
        const reason = `Merge train reservation failed: ${error instanceof Error ? error.message : String(error)}`;
        for (const read of selected) await single(read, {
          kind: "stop", condition: "merge-train-reservation-failed", evidence: reason,
        });
      }
      if (reservation) {
        const train = reservation;
        await withTrainLease(db, lease, target, train, now, async () => {
          const outcome = await enqueueReservedTrain(db, reader, train, now, hooks);
          return { value: outcome, leaseOutcome: outcome === "waiting" ? { kind: "continue" } : { kind: "stop", taskId: first.regression.id } };
        });
      }
    }
  } finally {
    for (const read of claimed) await releaseClaim(db, read);
  }
  return result;
};
