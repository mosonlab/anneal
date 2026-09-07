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
  writeMarker,
  type PrismaClient,
  type TrainAuthorization,
  type MergeTrainRecord,
  parseMergeTrainMarker,
} from "@anneal/db";
import type { PullRequestReader } from "./github-read.js";
import { evaluateReadiness, READINESS_READ_BUDGET_MS, type ReadinessDecision } from "./readiness-decision.js";
import type { WithMergeLease, ReleaseMergeLease, HeldLeaseOutcome } from "./merge-lease.js";
import type { ReadinessSettlement } from "./readiness-settlement.js";
import type { ClaimedReadiness, ReadinessCandidate, ReadinessRead, ReadinessTickResult } from "./merge-readiness-worker.js";
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
  candidates(db: PrismaClient, pageSize: number): AsyncGenerator<ReadinessCandidate>;
  read(db: PrismaClient, task: ReadinessCandidate, now: Date): Promise<ReadinessRead>;
  authorize(read: ClaimedReadiness, decision: Extract<ReadinessDecision, { kind: "authorize" }>, train: TrainAuthorization): ReadinessSettlement;
  single(db: PrismaClient, read: ClaimedReadiness, decision: ReadinessDecision, result: ReadinessTickResult,
    release: ReleaseMergeLease, lease: WithMergeLease, reader: PullRequestReader): Promise<void>;
};

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 100_000 } as const;

/** This short-lived mutex fences stale API ticks across external lease calls.
 * It is distinct from the candidate chain locks acquired by settlement. */
const tryRepositoryMutex = async (tx: Prisma.TransactionClient, repoId: string): Promise<boolean> => {
  const [row] = await tx.$queryRaw<Array<{ held: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${`anneal:merge-train:${repoId}`}, 0)) AS held
  `;
  return row?.held === true;
};

/** Preserve the owning Task on callback failure so release transport failures
 * enter the existing durable deferral path. The repository mutex remains held
 * through release, preventing an old tick from releasing a newer train held
 * under the same first-candidate Chain identity. */
const withTrainLease = async <T>(
  db: PrismaClient, lease: WithMergeLease, target: { projectId: string; chainId: string },
  regressionTaskId: string, trainTaskId: string, repoId: string,
  fn: () => Promise<{ value: T; leaseOutcome: HeldLeaseOutcome }>,
): Promise<void> => {
  await db.$transaction(async (mutexTx) => {
    if (!await tryRepositoryMutex(mutexTx, repoId)) return;
    // Use a fresh read after acquisition, not the outer transaction's snapshot.
    const marker = await readLatestMarker(db, trainTaskId, "train", "control-plane");
    if (marker?.state !== "queued" && marker?.state !== "acquiring") return;
    let failed = false;
    let failure: unknown;
    await lease(target, async () => {
      try { return await fn(); }
      catch (error: unknown) {
        failed = true;
        failure = error;
        return { value: undefined, leaseOutcome: { kind: "stop", taskId: regressionTaskId } };
      }
    }, db);
    if (failed) throw failure;
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

type PendingTrain = TrainBinding & {
  taskId: string;
  state: "acquiring" | "queued";
  regressionTaskId: string;
  projectId: string;
  repoId: string;
};

export const pendingMergeTrains = async (db: PrismaClient | Prisma.TransactionClient): Promise<PendingTrain[]> => {
  const tasks = await db.task.findMany({ where: {
    chainId: null,
    activity: { some: { actorType: "control-plane", metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.train } } },
  }, select: { id: true, projectId: true, repoId: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const pending: PendingTrain[] = [];
  for (const task of tasks) {
    const marker = await readLatestMarker(db, task.id, "train", "control-plane");
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
  await tx.task.update({ where: { id: train.taskId }, data: {
    description: `${mergeTrainTaskDescription(train)}\n\nSettlement:\n${summary}`,
    ...(state === "aborted" ? { status: TaskStatus.REVIEW, failureReason: summary } : {}),
  } });
  // Persist release intent *with* settlement. A restart in the post-commit
  // release window is repaired by the existing deferred-release reconciler.
  await recordLeaseDeferral(tx, { target: { projectId: train.projectId, chainId: train.candidates[0]!.chainId },
    taskId: train.regressionTaskId, failureDetail: `Merge train ${train.taskId} ${state}; lease release pending`, at: now });
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
  db: PrismaClient, train: PendingTrain, reason: string, now: Date, stoppedRead?: ReadyRead,
): Promise<boolean> => db.$transaction(async (tx) => {
  await lockCandidates(tx, train.candidates);
  const current = await readLatestMarker(tx, train.taskId, "train", "control-plane");
  if (current?.state !== "queued" && current?.state !== "acquiring") return false;
  for (const [index, candidate] of train.candidates.entries()) {
    if (stoppedRead?.readiness.id === candidate.taskId) {
      await stopMergeTail(tx, { phase: "readiness", readinessTaskId: candidate.taskId,
        regressionTaskId: stoppedRead.regression.id, reason, recovery: stoppedRead.recovery, at: now });
      await tx.task.update({ where: { id: candidate.taskId }, data: { readinessClaimToken: null, readinessClaimExpiresAt: null } });
    } else {
      await tx.task.updateMany({ where: { id: candidate.taskId, status: { in: [TaskStatus.TODO, TaskStatus.DOING] } },
        data: { status: TaskStatus.TODO, readinessClaimToken: null, readinessClaimExpiresAt: null, failureReason: null } });
      await noticeMergeTrainAbort(tx, { readinessTaskId: candidate.taskId, trainTaskId: train.taskId, reason, now });
    }
    await candidateSettlementMarker(tx, train, index + 1, "aborted", reason);
  }
  await finishTrainMarker(tx, train, "aborted", reason, now);
  return true;
}, serializable);

const enqueueReservedTrain = async (
  db: PrismaClient, reader: PullRequestReader, train: PendingTrain, now: Date, hooks: TrainHooks,
): Promise<"waiting" | "finished"> => {
  const reads: ReadyRead[] = [];
  try {
    for (const candidate of train.candidates) {
      const readiness = await db.task.findUnique({ where: { id: candidate.taskId }, include: {
        templateStep: { include: { taskTemplate: { select: { name: true } } } }, repo: true,
      } });
      if (!readiness || readiness.projectId !== train.projectId || readiness.repoId !== train.repoId
        || readiness.chainId !== candidate.chainId || !isMergeReadinessStep(readiness.templateStep)
        || await excludedRecovery(db, candidate.taskId)) throw new Error(`Merge train reservation candidate ${candidate.taskId} is no longer eligible`);
      const read = await hooks.read(db, readiness, now);
      if (!read.claimed) {
        if (read.input.stage === "claim-lost") return "waiting";
        throw new Error(`Merge train reservation candidate ${candidate.taskId} lost its Regression evidence`);
      }
      if (read.input.stage !== "ready") {
        await releaseClaim(db, read);
        throw new Error(`Merge train reservation candidate ${candidate.taskId} has invalid evidence`);
      }
      reads.push(read as ReadyRead);
      if (read.input.regression.headSha !== candidate.headSha || read.regression.runs[0]?.branch !== candidate.branch) {
        throw new Error(`Merge train reservation candidate ${candidate.taskId} binding changed`);
      }
    }
    await db.$transaction(async (tx) => {
      await lockCandidates(tx, train.candidates);
      await tx.$queryRaw`SELECT "id" FROM "Repo" WHERE "id" = ${train.repoId} FOR UPDATE`;
      if ((await readLatestMarker(tx, train.taskId, "train", "control-plane"))?.state !== "acquiring") return;
      const unresolved = await tx.mergeLeaseEvent.findFirst({ where: {
        state: { in: [MergeLeaseEventState.RELEASE_DEFERRED, MergeLeaseEventState.HANDOFF_PENDING] },
        owningTask: { repoId: train.repoId },
      }, select: { id: true } });
      if (unresolved) throw new Error("Merge train reservation has unresolved lease cleanup");
      for (const read of reads) {
        if (!await evidenceStillMatches(tx, read)) throw new Error(`Merge train reservation evidence changed for ${read.readiness.id}`);
      }
      if (await liveBase(reader, reads[0]!) !== train.baseSha) throw new Error("Merge train base moved before enqueue");
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
  let gateRefusalRead: ReadyRead | undefined;
  try {
    for (const candidate of train.candidates) {
      const readiness = await db.task.findUnique({ where: { id: candidate.taskId }, include: {
        templateStep: { include: { taskTemplate: { select: { name: true } } } }, repo: true,
      } });
      if (!readiness || readiness.projectId !== train.projectId || readiness.repoId !== train.repoId
        || readiness.chainId !== candidate.chainId || !isMergeReadinessStep(readiness.templateStep)
        || await excludedRecovery(db, candidate.taskId)) throw new Error(`Merge train candidate ${candidate.taskId} is no longer eligible`);
      const read = await hooks.read(db, readiness, now);
      if (!read.claimed) {
        if (read.input.stage === "claim-lost") return "waiting";
        throw new Error(`Merge train candidate ${candidate.taskId} no longer has completed Regression`);
      }
      result.claimed += 1;
      if (read.input.stage !== "ready") {
        await releaseClaim(db, read);
        throw new Error(`Merge train candidate ${candidate.taskId} no longer has valid Regression evidence`);
      }
      const ready = read as ReadyRead;
      reads.push(ready);
      if (ready.input.regression.headSha !== candidate.headSha) throw new Error(`Merge train candidate ${candidate.taskId} evidence head changed`);
    }
    const record = parsed.record;
    const bindingFailure = trainRecordBindingFailure(record, train, await liveBase(reader, reads[0]!));
    if (bindingFailure) throw new Error(bindingFailure);
    const decisions: Array<Extract<ReadinessDecision, { kind: "authorize" }>> = [];
    for (const read of reads) {
      const decision = await evaluateReadiness(reader, { ...read.input,
        regression: { ...read.input.regression, baseHeadSha: record.baseSha },
        train: { baseSha: record.baseSha, candidateHeadSha: read.input.regression.headSha },
      });
      if (decision.kind !== "authorize") {
        throw new Error(`Merge train second read refused ${read.readiness.id}: ${decision.kind}${"reason" in decision ? `: ${decision.reason}` : "evidence" in decision ? `: ${decision.evidence}` : ""}`);
      }
      decisions.push(decision);
    }
    for (const read of reads) {
      if (!await read.claim.renew()) throw new Error(`Merge train candidate ${read.readiness.id} claim lost before settlement`);
    }
    const counts = await db.$transaction(async (tx) => {
      await lockCandidates(tx, train.candidates);
      if ((await readLatestMarker(tx, train.taskId, "train", "control-plane"))?.state !== "queued") return { authorized: 0, stopped: 0 };
      for (const read of reads) {
        if (!await evidenceStillMatches(tx, read)) throw new Error(`Merge train candidate ${read.readiness.id} evidence changed during settlement`);
      }
      if (await liveBase(reader, reads[0]!) !== record.baseSha) throw new Error("Merge train base moved before authorization");
      const passing = record.prefixes[record.contiguousPassCount - 1];
      const summaries: string[] = [];
      let failed = false;
      let stopped = 0;
      for (const [index, read] of reads.entries()) {
        const prefix = record.prefixes[index];
        let settlement = "ready";
        if (index < record.contiguousPassCount && passing && prefix) {
          const authorization = hooks.authorize(read, decisions[index]!, {
            publishHead: passing.prefixOid, predecessorOid: prefix.predecessorOid,
            ref: passing.ref, position: index + 1, trainTaskId: train.taskId,
          });
          const applied = await authorization.body(tx, read.claim).catch((error: unknown) => {
            if (error instanceof MergeGateAuthorizationError) gateRefusalRead = read;
            throw error;
          });
          if (!applied.value.applied) throw new Error(`Merge train readiness claim lost for ${read.readiness.id}`);
          // The train owns the one lease until every authorization is durable;
          // per-chain executor handoffs deliberately do not retain this lease.
          settlement = "authorized";
        } else {
          const blocked = record.blocked.find((candidate) => candidate.taskId === read.readiness.id);
          const firstFail = prefix?.verdict === "fail" && !failed;
          if (firstFail) failed = true;
          settlement = blocked ? "blocked" : firstFail ? "repairing" : "ready";
          const transition = await read.claim.settle(tx, { kind: "finish", at: now, apply: async (client) => {
            if (blocked || firstFail) {
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
        const verdict = prefix?.verdict ?? (record.blocked.some((entry) => entry.taskId === read.readiness.id) ? "blocked" : "skipped");
        await candidateSettlementMarker(tx, train, index + 1, settlement,
          record.blocked.find((entry) => entry.taskId === read.readiness.id)?.reason,
          { verdict, ...(prefix ? { predecessorOid: prefix.predecessorOid } : {}) });
        summaries.push(`${index + 1}. ${read.readiness.id}: ${verdict} → ${settlement}`);
      }
      await finishTrainMarker(tx, train, "settled", summaries.join("\n"), now);
      return { authorized: record.contiguousPassCount, stopped };
    }, serializable);
    result.authorized += counts.authorized;
    result.stopped += counts.stopped;
    return "finished";
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    const aborted = await abortTrain(db, train, reason, now, gateRefusalRead);
    if (aborted && gateRefusalRead) result.stopped += 1;
    return "finished";
  } finally {
    for (const read of reads) await releaseClaim(db, read);
  }
};

export const mergeTrainReadinessTick = async (
  db: PrismaClient, reader: PullRequestReader, now: Date, width: number,
  release: ReleaseMergeLease, lease: WithMergeLease, hooks: TrainHooks,
  existingPending?: PendingTrain[],
): Promise<ReadinessTickResult> => {
  const result: ReadinessTickResult = { claimed: 0, authorized: 0, requeued: 0, stopped: 0 };
  const pending = existingPending ?? await pendingMergeTrains(db);
  const unresolvedLeases = await db.mergeLeaseEvent.findMany({
    where: { state: { in: [MergeLeaseEventState.RELEASE_DEFERRED, MergeLeaseEventState.HANDOFF_PENDING] } },
    select: { state: true, owningTask: { select: { id: true, repoId: true } } },
  });
  const busyRepos = new Set([...pending.map((train) => train.repoId),
    ...unresolvedLeases.flatMap((event) => event.owningTask.repoId ? [event.owningTask.repoId] : [])]);
  for (const train of pending) {
    const target = { projectId: train.projectId, chainId: train.candidates[0]!.chainId };
    await withTrainLease(db, lease, target, train.regressionTaskId, train.taskId, train.repoId, async () => {
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
  try {
    for await (const candidate of hooks.candidates(db, 100)) {
      if (!isMergeReadinessStep(candidate.templateStep)) continue;
      if ((candidate.repoId && busyRepos.has(candidate.repoId)) || await excludedRecovery(db, candidate.id)) continue;
      const read = await hooks.read(db, candidate, now);
      if (!read.claimed) continue;
      result.claimed += 1;
      if (read.input.stage !== "ready" || !candidate.repoId || !read.input.target.resolved) {
        await single(read, await evaluateReadiness(reader, read.input));
        continue;
      }
      const group = groups.get(candidate.repoId) ?? [];
      group.push(read as ReadyRead);
      groups.set(candidate.repoId, group);
    }
    for (const group of groups.values()) {
      group.sort((left, right) => left.regression.stepOutput!.updatedAt.getTime() - right.regression.stepOutput!.updatedAt.getTime()
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
      if (width === 0) {
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
            state: { in: [MergeLeaseEventState.RELEASE_DEFERRED, MergeLeaseEventState.HANDOFF_PENDING] },
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
        await withTrainLease(db, lease, target, first.regression.id, train.taskId, train.repoId, async () => {
          const outcome = await enqueueReservedTrain(db, reader, train, now, hooks);
          return { value: outcome, leaseOutcome: outcome === "waiting" ? { kind: "continue" } : { kind: "stop", taskId: first.regression.id } };
        });
      }
    }
  } finally {
    for (const group of groups.values()) for (const read of group) await releaseClaim(db, read);
  }
  return result;
};
