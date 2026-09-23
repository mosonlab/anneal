/**
 * §D-P3 Phase B — the bounded evidence worker.
 *
 * This is the whole answer to SF-2 and half the answer to MF-3/C2. The GitHub
 * read happens here: in the API process (which is where the read credential
 * lives), on its own interval beside `startScheduler`, under a strict
 * cancellable deadline, and with **no database transaction open**. Only the
 * short body CAS afterwards touches the database.
 *
 * The ordering is the contract: the evidence is read and rendered into a card
 * the human then sees, and only a later answer copies that stored snapshot.
 * Evidence precedes judgment, which is exactly what reading at answer time
 * could not give.
 */

import type { PrismaClient } from "@anneal/db";
import {
  ACTIVE_RUN_STATUSES,
  EVIDENCE_PLACEHOLDER_BODY,
  EVIDENCE_UNAVAILABLE_MARKER,
  InboxStatus,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  READINESS_BASE_DRIFT_REQUEUE_LIMIT,
  Prisma,
  TaskStatus,
  isMergeReadinessStep,
  lockChainRows,
  parseEvidence,
  readinessRequeueActivityWhere,
  readinessRequeueTotals,
  recordReadinessRequeue,
  writeMarker,
  type MergeEvidence,
  type PendingEvidenceRequest,
  parseEvidenceRequest,
  serializeEvidence,
} from "@anneal/db";

import { checkConclusionFor, GitHubReadError, type PullRequestReader, type PullRequestSnapshot } from "./github-read.js";
import { stopMergeTail } from "./merge-tail-actions.js";
import { requeueMergeTailRun } from "./merge-tail-state.js";

export const evidenceReadTimeoutMs = (): number => {
  const raw = Number(process.env.MERGE_EVIDENCE_READ_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 8_000;
};

export const evidenceAttempts = (): number => {
  const raw = Number(process.env.MERGE_EVIDENCE_ATTEMPTS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
};

export const evidencePollIntervalMs = (): number => {
  const raw = Number(process.env.MERGE_EVIDENCE_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 250 ? Math.floor(raw) : 2_000;
};

/**
 * Renders §11.1's snapshot into the immutable block the human reads and the
 * approval later copies. `requiredChecks` records the conclusion **for the
 * authorized head specifically**; an absent check is recorded as `ABSENT`
 * rather than omitted, because absence is a stop and an omission would read as
 * "no checks required".
 */
export const evidenceFromSnapshot = (
  snapshot: PullRequestSnapshot,
  nonce: string,
): MergeEvidence | { error: string } => {
  if (!snapshot.headRefOid) return { error: "pull request has no head oid" };
  if (!snapshot.baseRefName) return { error: "pull request has no base ref" };
  if (!snapshot.baseSha) return { error: "base ref has no target oid" };
  return {
    schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
    nonce,
    repository: snapshot.repository,
    prNumber: snapshot.number,
    headSha: snapshot.headRefOid,
    baseRef: snapshot.baseRefName,
    baseSha: snapshot.baseSha,
    mergeMethod: "merge",
    requiredChecks: snapshot.requiredCheckNames.map((name) => ({
      name,
      conclusion: checkConclusionFor(snapshot, name) ?? "ABSENT",
    })),
    readAt: snapshot.readAt,
  };
};

const humanReadable = (evidence: MergeEvidence, snapshot: PullRequestSnapshot): string => {
  const checks = evidence.requiredChecks.length === 0
    ? "（无必需检查）"
    : evidence.requiredChecks.map((check) => `  - ${check.name}: ${check.conclusion}`).join("\n");
  return [
    `审批闸门：合并 ${evidence.repository} PR #${evidence.prNumber}`,
    "",
    "批准即授权机械合并**这一个确切的提交**。合并前每项前提都会重新校验；任何漂移都会停下并重新请求授权。",
    "",
    `  仓库：${evidence.repository}`,
    `  Pull request：#${evidence.prNumber}`,
    `  Head SHA：${evidence.headSha}`,
    `  Base：${evidence.baseRef} @ ${evidence.baseSha}`,
    `  合并方式：${evidence.mergeMethod}`,
    `  可合并性：${snapshot.mergeable ?? "UNKNOWN"} / ${snapshot.mergeStateStatus ?? "UNKNOWN"}`,
    "  必需检查：",
    checks,
    `  证据读取时间：${evidence.readAt}`,
    "",
    serializeEvidence(evidence),
  ].join("\n");
};

const unavailableBody = (request: PendingEvidenceRequest, reason: string): string => [
  `审批闸门：合并 ${request.repository} PR #${request.prNumber}`,
  "",
  `无法读取合并证据（${EVIDENCE_UNAVAILABLE_MARKER}）：${reason}`,
  "",
  "在证据可读之前，这张卡片不能被批准。请修复读取凭据或网络后重新请求授权。",
].join("\n");

export type EvidenceTickResult = { claimed: number; filled: number; unavailable: number };

/**
 * One tick. Claims at most `limit` pending requests, and for each: reads GitHub
 * outside any transaction under an AbortController deadline, then CASes the
 * card body from the exact placeholder string to the rendered block.
 *
 * The CAS is what makes a filled card unfillable a second time, and what makes
 * a card another writer already touched safe to leave alone.
 */
export const evidenceTick = async (
  db: PrismaClient,
  reader: PullRequestReader,
  now = new Date(),
  limit = 5,
): Promise<EvidenceTickResult> => {
  const result: EvidenceTickResult = { claimed: 0, filled: 0, unavailable: 0 };
  // Candidate cards, not candidate activities: a card that is no longer OPEN or
  // no longer a placeholder has been answered, closed, or filled already.
  const placeholders = await db.inboxMessage.findMany({
    where: { status: InboxStatus.OPEN, body: EVIDENCE_PLACEHOLDER_BODY, gateTaskId: { not: null } },
    select: { id: true, gateTaskId: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  if (placeholders.length === 0) return result;

  for (const placeholder of placeholders) {
    const rows = await db.taskActivity.findMany({
      where: { taskId: placeholder.gateTaskId! },
      orderBy: { createdAt: "desc" },
      select: { id: true, taskId: true, metadata: true },
    });
    let request: PendingEvidenceRequest | null = null;
    for (const row of rows) {
      const parsed = parseEvidenceRequest(row);
      if (parsed?.cardId === placeholder.id) { request = parsed; break; }
    }
    if (!request) continue;
    result.claimed += 1;

    let filled = false;
    let lastError = "no attempt was made";
    // §11.1 needs a base ref up front, for `mergeQueue(branch:)` and
    // `ref(qualifiedName:)`. The chain's integration line is its first run's
    // targetBranch — the same durable value the claim route carries as
    // `pullRequestBase` — not the shared chain head every later run targets.
    const baseRef = await chainBaseRefFor(db, request);
    const attempts = evidenceAttempts();
    const deadline = evidenceReadTimeoutMs();
    for (let attempt = 1; attempt <= attempts && !filled; attempt += 1) {
      const controller = new AbortController();
      let deadlinePassed: () => void = () => {};
      const timer = setTimeout(() => { controller.abort(); deadlinePassed(); }, deadline);
      try {
        // No transaction is open for the duration of this call. That is the
        // property SF-2 asks for and the tests assert.
        //
        // The deadline is enforced here rather than delegated to the reader.
        // Aborting the signal only asks a cooperative reader to stop; racing
        // it is what makes the bound hold against one that does not, and the
        // bound is the point — a stalled read must never become a card the
        // human waits on indefinitely.
        const snapshot = await Promise.race([
          reader.readPullRequest(request.repository, request.prNumber, baseRef, controller.signal),
          new Promise<never>((_resolve, reject) => {
            deadlinePassed = () => { reject(new GitHubReadError(`merge evidence read exceeded ${deadline}ms`, "timeout")); };
          }),
        ]);
        const evidence = evidenceFromSnapshot(snapshot, request.nonce);
        if ("error" in evidence) { lastError = evidence.error; continue; }
        const written = await db.inboxMessage.updateMany({
          where: { id: request.cardId, status: InboxStatus.OPEN, body: EVIDENCE_PLACEHOLDER_BODY },
          data: { body: humanReadable(evidence, snapshot), nextDeliveryAt: now },
        });
        if (written.count === 1) { filled = true; result.filled += 1; }
        else { filled = true; }
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : "unknown read failure";
      } finally {
        clearTimeout(timer);
      }
    }

    if (!filled) {
      const written = await db.inboxMessage.updateMany({
        where: { id: request.cardId, status: InboxStatus.OPEN, body: EVIDENCE_PLACEHOLDER_BODY },
        data: { body: unavailableBody(request, lastError), nextDeliveryAt: now },
      });
      if (written.count === 1) result.unavailable += 1;
    }
  }
  return result;
};

export const refreshStaleMergeCardsTick = async (
  db: PrismaClient,
  reader: PullRequestReader,
  now = new Date(),
  limit = 5,
): Promise<{ checked: number; refreshed: number; exhausted: number }> => {
  const result = { checked: 0, refreshed: 0, exhausted: 0 };
  const cards = await db.inboxMessage.findMany({
    where: { status: InboxStatus.OPEN, gateTaskId: { not: null } },
    select: { id: true, gateTaskId: true, body: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const card of cards) {
    if (result.checked >= limit) break;
    if (!card.gateTaskId) continue;
    const parsed = parseEvidence(card.body);
    if (parsed.status !== "ok") continue;
    const evidence = parsed.evidence;
    const request = await db.taskActivity.findFirst({ where: {
      taskId: card.gateTaskId,
      AND: [
        { metadata: { path: ["kind"], equals: "mergeIntegrator.evidenceRequest" } },
        { metadata: { path: ["cardId"], equals: card.id } },
      ],
    }, select: { metadata: true } });
    const requestMetadata = request?.metadata && typeof request.metadata === "object"
      && !Array.isArray(request.metadata) ? request.metadata as Record<string, unknown> : null;
    if (requestMetadata?.nonce !== evidence.nonce) continue;
    const previous = await db.taskActivity.findFirst({ where: {
      taskId: card.gateTaskId,
      actorType: "control-plane",
      AND: [
        { metadata: { path: ["kind"], equals: "mergeTail.evidenceRefresh" } },
        { metadata: { path: ["cardId"], equals: card.id } },
      ],
    }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true, metadata: true } });
    const prior = previous?.metadata && typeof previous.metadata === "object"
      && !Array.isArray(previous.metadata) ? previous.metadata as Record<string, unknown> : null;
    if (prior?.state === "queued" || prior?.state === "ceiling" || prior?.state === "stopped") continue;
    if (previous && now.getTime() - previous.createdAt.getTime() < 60_000) continue;
    result.checked += 1;
    const gate = await db.task.findUnique({ where: { id: card.gateTaskId },
      include: { templateStep: { include: { taskTemplate: { select: { name: true } } } } } });
    if (!gate?.chainId || gate.chainIndex === null || !isMergeReadinessStep(gate.templateStep)) continue;
    const regression = await db.task.findFirst({ where: {
      projectId: gate.projectId, chainId: gate.chainId,
      chainIndex: gate.chainIndex - 1,
    }, select: { id: true } });
    if (!regression) continue;
    let snapshot: PullRequestSnapshot;
    try {
      snapshot = await reader.readPullRequest(evidence.repository, evidence.prNumber,
        evidence.baseRef, AbortSignal.timeout(evidenceReadTimeoutMs()));
      if (snapshot.repository !== evidence.repository || snapshot.number !== evidence.prNumber
        || snapshot.baseRefName !== evidence.baseRef || snapshot.headRefOid !== evidence.headSha
        || snapshot.state !== "OPEN" || snapshot.merged || snapshot.isDraft || !snapshot.baseSha) {
        throw new Error("approval evidence no longer identifies the same OPEN pull request and exact head");
      }
      if (snapshot.baseSha !== evidence.baseSha) {
        const ancestry = await reader.compareCommits?.(evidence.repository, evidence.baseSha,
          snapshot.baseSha, AbortSignal.timeout(evidenceReadTimeoutMs()));
        if (!ancestry || ancestry.status !== "ahead" || ancestry.behindBy !== 0) {
          throw new Error("target base changed without a verified forward advancement");
        }
      }
    } catch (error: unknown) {
      const reason = `approval evidence refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      await db.$transaction(async (tx) => {
        await lockChainRows(tx, { projectId: gate.projectId, chainId: gate.chainId! });
        const current = await tx.inboxMessage.findUnique({ where: { id: card.id }, select: { status: true } });
        if (current?.status !== InboxStatus.OPEN) return;
        await stopMergeTail(tx, { phase: "readiness", readinessTaskId: gate.id,
          regressionTaskId: regression.id, recovery: null, reason, at: now });
        await writeMarker(tx, gate.id, "evidenceRefresh", "stopped", {
          actorType: "control-plane", body: reason,
          metadata: { cardId: card.id, condition: "evidence-refresh-failed",
            staleBaseSha: evidence.baseSha, observedBaseSha: null },
        });
      });
      continue;
    }
    if (snapshot.baseSha === evidence.baseSha) {
      await db.taskActivity.create({ data: { taskId: gate.id, actorType: "control-plane",
        body: `OPEN merge card ${card.id} still matches target base ${evidence.baseSha}`,
        metadata: { kind: "mergeTail.evidenceRefresh", state: "checked", schemaVersion: 1,
          cardId: card.id, condition: "base-current", observedBaseSha: snapshot.baseSha } } });
      continue;
    }
    const currentBaseSha = snapshot.baseSha;
    let changed: "lost" | "busy" | "exhausted" | "refreshed";
    try {
      changed = await db.$transaction(async (tx) => {
      await lockChainRows(tx, { projectId: gate.projectId, chainId: gate.chainId! });
      const current = await tx.inboxMessage.findUnique({ where: { id: card.id }, select: { status: true, body: true } });
      if (current?.status !== InboxStatus.OPEN || current.body !== card.body) return "lost" as const;
      if (await tx.run.count({ where: { task: { projectId: gate.projectId, chainId: gate.chainId! },
        status: { in: ACTIVE_RUN_STATUSES } } })) return "busy" as const;
      const rows = await tx.taskActivity.findMany({
        where: readinessRequeueActivityWhere(gate.id), select: { metadata: true },
      });
      const spent = readinessRequeueTotals(rows.filter((row) => {
        const metadata = row.metadata as Record<string, unknown> | null;
        return metadata?.baseDrift === true && metadata.recoveryAggregateId === undefined;
      })).readinessRequeues;
      if (spent >= READINESS_BASE_DRIFT_REQUEUE_LIMIT) {
        await tx.inboxMessage.update({ where: { id: card.id }, data: {
          body: `${card.body}\n\n目标分支已前进；自动刷新已达 ${READINESS_BASE_DRIFT_REQUEUE_LIMIT} 次上限，请人工处理。`,
        } });
        await writeMarker(tx, gate.id, "evidenceRefresh", "ceiling", {
          actorType: "control-plane",
          body: `Stale merge card retained: automatic refresh budget ${spent}/${READINESS_BASE_DRIFT_REQUEUE_LIMIT} exhausted`,
          metadata: { cardId: card.id, condition: "base-drift", staleBaseSha: evidence.baseSha,
            currentBaseSha, ordinal: spent, remaining: 0 },
        });
        return "exhausted" as const;
      }
      await tx.task.update({ where: { id: regression.id }, data: { status: TaskStatus.TODO, failureReason: null } });
      await tx.task.update({ where: { id: gate.id }, data: { status: TaskStatus.TODO, failureReason: null } });
      const opened = await requeueMergeTailRun(tx, regression.id, now, true);
      if (opened.outcome !== "opened") throw new Error("stale approval evidence Regression Run birth refused");
      const closed = await tx.inboxMessage.updateMany({ where: { id: card.id, status: InboxStatus.OPEN },
        data: { status: InboxStatus.CLOSED,
          body: `${card.body}\n\n目标分支已前进，证据已刷新；新 Regression 将产生新审批卡。` } });
      if (closed.count !== 1) throw new Error("stale approval card changed during refresh");
      const requeue = await recordReadinessRequeue(tx, { readinessTaskId: gate.id,
        regressionTaskId: regression.id, staleBaseSha: evidence.baseSha, currentBaseSha: currentBaseSha!,
        budgetGrant: 1, baseDrift: true, reason: "OPEN approval evidence base became stale" });
      await writeMarker(tx, gate.id, "evidenceRefresh", "queued", {
        actorType: "control-plane",
        body: `Stale merge card ${card.id} closed; Regression Run ${opened.run.id} requeued`,
        metadata: { cardId: card.id, condition: "base-drift", staleBaseSha: evidence.baseSha,
          currentBaseSha, ordinal: requeue.ordinal,
          remaining: READINESS_BASE_DRIFT_REQUEUE_LIMIT - spent - 1,
          regressionRunId: opened.run.id },
      });
      return "refreshed" as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error: unknown) {
      const reason = `approval evidence refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      await db.$transaction(async (tx) => {
        await lockChainRows(tx, { projectId: gate.projectId, chainId: gate.chainId! });
        const current = await tx.inboxMessage.findUnique({ where: { id: card.id }, select: { status: true } });
        if (current?.status !== InboxStatus.OPEN) return;
        await stopMergeTail(tx, { phase: "readiness", readinessTaskId: gate.id,
          regressionTaskId: regression.id, recovery: null, reason, at: now });
        await writeMarker(tx, gate.id, "evidenceRefresh", "stopped", {
          actorType: "control-plane", body: reason,
          metadata: { cardId: card.id, condition: "evidence-refresh-failed",
            staleBaseSha: evidence.baseSha, observedBaseSha: currentBaseSha },
        });
      });
      continue;
    }
    if (changed === "refreshed") result.refreshed += 1;
    if (changed === "exhausted") result.exhausted += 1;
  }
  return result;
};

/**
 * The chain's integration line, resolved from durable rows rather than guessed:
 * the earliest run of the earliest chain step recorded the base the chain's PR
 * was opened against, which is what the claim route already carries as
 * `pullRequestBase`. The repo default is the fallback, matching
 * `resolveRunBranches` for a chain's first run.
 */
const chainBaseRefFor = async (db: PrismaClient, request: PendingEvidenceRequest): Promise<string> => {
  const gate = await db.task.findUnique({
    where: { id: request.gateTaskId },
    select: { projectId: true, chainId: true, repo: { select: { defaultBranch: true } } },
  });
  if (!gate?.chainId) return gate?.repo?.defaultBranch ?? "main";
  const first = await db.run.findFirst({
    where: { task: { projectId: gate.projectId, chainId: gate.chainId, chainIndex: { not: null } } },
    select: { targetBranch: true },
    orderBy: [{ task: { chainIndex: "asc" } }, { runNumber: "asc" }],
  });
  return first?.targetBranch ?? gate.repo?.defaultBranch ?? "main";
};

export const startEvidenceWorker = (
  db: PrismaClient,
  reader: PullRequestReader,
): ReturnType<typeof setInterval> | null => {
  const interval = evidencePollIntervalMs();
  // A tick reads GitHub for up to three requests under the read deadline, which
  // can outlast the poll interval. Without this guard the overlapping ticks
  // would re-fetch the same pending requests concurrently; the next tick simply
  // skips, because there is nothing a second concurrent pass can observe that
  // the one already running will not.
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void evidenceTick(db, reader)
      .then(() => refreshStaleMergeCardsTick(db, reader))
      .catch((error: unknown) => {
        console.error("Merge evidence tick failed", error);
      })
      .finally(() => {
        inFlight = false;
      });
  }, interval);
  timer.unref?.();
  return timer;
};
