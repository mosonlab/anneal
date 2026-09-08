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
import { observeEpisode } from "./merge-tail-episode.js";
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
    closeEpisode(tx: Prisma.TransactionClient, read: ClaimedReadiness): Promise<void>;
  };
  candidates(db: PrismaClient, pageSize: number): AsyncGenerator<ReadinessCandidate>;
  discover(db: PrismaClient, task: ReadinessCandidate, now: Date): Promise<ReadinessDiscovery>;
  read(db: PrismaClient, task: ReadinessCandidate, now: Date): Promise<ReadinessRead>;
  refuse(read: ClaimedReadiness, decision: Extract<ReadinessDecision, { kind: "stop" | "requeue-regression" }>): ReadinessSettlement;
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

/** Project the repository observation onto the train and its candidate Tasks. */
const observeTrainLease = async (
  tx: Prisma.TransactionClient, train: PendingTrain,
  answer: "contended" | "unreachable" | "resolved", now: Date, detail?: string,
): Promise<void> => {
  for (const taskId of [train.taskId, ...train.candidates.map((candidate) => candidate.taskId)]) {
    await observeEpisode(tx, { taskId, family: "train-lease-contention", answer, now, ...(detail === undefined ? {} : { detail }) });
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
  // The advisory lock provides exclusion here. Settlement commits through
  // separate transactions while this one stays open, so later contention
  // projections must see those commits (including their updated Task rows).
  // A serializable snapshot can fail those writes with a concurrent update.
  await db.$transaction(async (mutexTx) => {
    if (!await tryRepositoryMutex(mutexTx, train.repoId)) return;
    // Use a fresh read after acquisition, not the outer transaction's snapshot.
    const marker = await readLatestMarker(db, train.taskId, "train");
    if (marker?.state !== "queued" && marker?.state !== "acquiring") return;
    let failed = false;
    let failure: unknown;
    const leased = await lease(target, async () => {
      try {
        // Commit the activity FK locks before settlement takes Task row locks
        // in its own transaction; both still run inside the held Lease window.
        await db.$transaction(async (episodeTx) => {
          await lockCandidates(episodeTx, train.candidates);
          await observeTrainLease(episodeTx, train, "resolved", now);
        }, serializable);
        return await fn();
      }
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
      await observeTrainLease(mutexTx, train, "contended", now, holderDetail(leased.holder));
      return;
    }
    if (leased.outcome === "unreachable") {
      await observeTrainLease(mutexTx, train, "unreachable", now, leased.detail);
      return;
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 300_000 });
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
      // Keep the diagnostic on the affected card without allowing corrupt
      // ownership to stop readiness for every repository. Do not invent a
      // lease holder or a release obligation from metadata we cannot trust.
      const body = `Merge train ${task.id} has malformed durable ownership metadata; ownership requires operator repair`;
      if (!await db.taskActivity.findFirst({ where: { taskId: task.id, actorType: "control-plane", body } })) {
        await db.taskActivity.create({ data: { taskId: task.id, actorType: "control-plane", body } });
      }
      continue;
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
  await writeMarker(tx, train.taskId, "train", state, { actorType: "control-plane", body: summary,
    metadata: { trainTaskId: train.taskId, regressionTaskId: train.regressionTaskId,
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
  await writeMarker(tx, candidate.taskId, "train", settlement === "aborted" ? "aborted" : "settled", {
    actorType: "control-plane",
    body: `Merge train ${train.taskId}, position ${position}: ${settlement}${reason ? `; ${reason}` : ""}`,
    metadata: { trainTaskId: train.taskId, position,
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
 * operator authorization bound to its original Regression evidence. The train
 * supplies the new publication base; it does not replace the operator's binding.
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
        headSha: read.input.regression.headSha, baseSha: read.input.regression.baseHeadSha });
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
    for (const read of reads) {
      const decision = await evaluateReadiness(reader, { ...read.input,
        regression: { ...read.input.regression, baseHeadSha: record.baseSha },
        train: { baseSha: record.baseSha, candidateHeadSha: read.input.regression.headSha },
      });
      // Base movement invalidates the cumulative record, not the candidate's
      // Regression. Candidate-local refusals must settle below so an old PASS
      // cannot form the same failing train again on the next tick.
      if (decision.kind === "requeue-regression" && decision.condition === "train-base-stale") {
        throw new Error(`Merge train second read refused ${read.readiness.id}: ${decision.kind}: ${decision.reason}`);
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
      const passingRefusal = decisions.slice(0, record.contiguousPassCount)
        .find((decision) => decision.kind !== "authorize");
      if (passingRefusal) {
        const refusedRead = reads[decisions.indexOf(passingRefusal)]!;
        const reason = `Merge train second read refused ${refusedRead.readiness.id}: ${passingRefusal.kind}${"reason" in passingRefusal ? `: ${passingRefusal.reason}` : "evidence" in passingRefusal ? `: ${passingRefusal.evidence}` : ""}`;
        let stopped = 0;
        let requeued = 0;
        for (const [index, read] of reads.entries()) {
          const decision = decisions[index]!;
          if (decision.kind === "stop" || decision.kind === "requeue-regression") {
            // Invoke only the settlement body: this transaction already owns
            // candidate locks and the train owns the one external Merge Lease.
            const applied = await hooks.refuse(read, decision).body(tx, read.claim);
            if (!applied.value.applied) throw new Error(`Merge train readiness claim lost for ${read.readiness.id}`);
            if (decision.kind === "stop" || applied.value.stopped) stopped += 1;
            else requeued += 1;
          } else {
            const applied = await read.claim.settle(tx, { kind: "finish", at: now, apply: async (client) => {
              await client.task.update({ where: { id: read.readiness.id }, data: { status: TaskStatus.TODO, failureReason: null } });
              return { value: undefined, ownership: "released" };
            } });
            if (!applied.settled) throw new Error(`Merge train readiness claim lost for ${read.readiness.id}`);
          }
          await noticeMergeTrainAbort(tx, { readinessTaskId: read.readiness.id, trainTaskId: train.taskId, reason, now });
          await candidateSettlementMarker(tx, train, index + 1, "aborted", reason);
        }
        await finishTrainMarker(tx, train, "aborted", reason, now);
        return { authorized: 0, stopped, requeued };
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
      for (const read of reads) await hooks.executor.closeEpisode(tx, read);
      const passing = record.prefixes[authorizedCount - 1];
      const summaries: string[] = [];
      let failed = false;
      let stopped = 0;
      let requeued = 0;
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
        } else if (decision?.kind === "stop" || decision?.kind === "requeue-regression") {
          const applied = await hooks.refuse(read, decision).body(tx, read.claim);
          if (!applied.value.applied) throw new Error(`Merge train readiness claim lost for ${read.readiness.id}`);
          settlement = decision.kind === "stop" || applied.value.stopped ? "stopped" : "requeued";
          if (settlement === "stopped") stopped += 1;
          else requeued += 1;
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
      return { authorized: authorizedCount, stopped, requeued };
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
        // REVIEW candidates must reach read(): an executor-offline ceiling
        // parked their recovery in BLOCKED_DOWNSTREAM, which read can re-arm.
        if (candidate.repoId && busyRepos.has(candidate.repoId)) continue;
        if (candidate.status !== TaskStatus.REVIEW && await excludedRecovery(db, candidate.id)) continue;
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
        // Formation depends on all eligible peers, before width and claim
        // budget bound membership. Even a width-one prefix is still a train.
        if (group.length === 1 && first.input.regression.baseHeadSha === baseSha) {
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
      if (candidate.repoId && busyRepos.has(candidate.repoId)) continue;
      // Keep the same re-arm path while draining trains after width is disabled.
      if (candidate.status !== TaskStatus.REVIEW && await excludedRecovery(db, candidate.id)) continue;
      const read = await hooks.read(db, candidate, now);
      if (!read.claimed) continue;
      result.claimed += 1;
      claimed.push(read);
      await single(read, await evaluateReadiness(reader, read.input));
    }
  } finally {
    for (const read of claimed) await releaseClaim(db, read);
  }
  return result;
};
