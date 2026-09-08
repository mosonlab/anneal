import { resolve } from "node:path";

import {
  ACTIVE_RUN_STATUSES,
  basePublishedStamp,
  CleanupStatus, FailureClass, refundForLostRun, reopenRefundedRun, resolveRunBranches,
  runOwnedHead, RunStatus,
  SessionExecutionStatus, type Prisma, type PrismaClient,
} from "@anneal/db";

import { lockTaskMutationRows } from "./task-write.js";

/**
 * Workspace GC ownership (issue #115).
 *
 * The control plane used to delete run workspaces itself — `reconcileWorkspaces`
 * walked a root read from its *own* environment and `rm -rf`'d every directory
 * its database could not account for. That is the one destructive operation in
 * the system with no ownership check, and on 2026-08-17/18 a database/root
 * mismatch turned it into two production workspace wipes.
 *
 * The structural fix is that the API never touches the filesystem. It publishes
 * an *intent* — "run X's workspace may be reclaimed" — and the runner that owns
 * the root, which is the process that provisioned the directory in the first
 * place, does the deleting inside its own root and reports back.
 *
 * The exchange is driven by the runner's inventory rather than by a scan here,
 * for two reasons: the API has no business reading that directory, and the
 * inventory bounds the worklist to directories that actually exist.
 */

export const terminalRunStatuses = [
  RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.TIMED_OUT, RunStatus.CANCELLED, RunStatus.LOST,
] as const;

/**
 * Statuses whose workspace is still in use and must never be offered. This is
 * the control plane's live-run definition, not a second one: QUEUED is a run
 * answered but not re-claimed, and WAITING_INBOX is the suspended run whose
 * workspace an earlier sweep deleted out from under a resume — exactly the runs
 * `ACTIVE_RUN_STATUSES` exists to protect. The predicate below tests the
 * terminal side so an unlisted status keeps its directory; the reclaim tests
 * assert every status here individually.
 */
export const workspaceKeepStatuses: readonly RunStatus[] = ACTIVE_RUN_STATUSES;

/** How many still-open intents one exchange may ask a runner to settle. */
const settlementPageSize = 500;

export type ReclaimInventory = {
  runnerId: string;
  /**
   * The root the caller says it owns. Telemetry and a consistency check only —
   * it carries no authority. See `ownedByCaller`.
   */
  workspaceRoot: string;
  /** Directory names directly under that root. */
  directories: string[];
};

export type ReclaimOffer = {
  runId: string;
  /**
   * The path the *control plane* recorded for this run, not one derived from
   * anything the caller said. The runner compares it against the path it
   * derives from its own configuration, so the two sides have to agree from
   * independent sources before anything is unlinked. Null for a run lost in the
   * clone window, before /start persisted a path.
   */
  workspacePath: string | null;
  /** Null is an ordinary checkout. A SHA forbids salvage publication. */
  pinnedBaseSha: string | null;
  taskId?: string | null;
  runNumber?: number;
  baseSha?: string | null;
  pushedBranch?: string | null;
};

export type ReclaimPlan = {
  /** Directories present in the inventory that the owner may remove. */
  reclaim: ReclaimOffer[];
  /**
   * Intents still open for directories the inventory did *not* list. The runner
   * removes before it can report, so a crash or a failed report between the two
   * leaves an intent no later inventory can ever mention again. These are how
   * that converges: the owner confirms the directory is gone and settles the
   * intent, rather than leaving it open forever.
   */
  verify: ReclaimOffer[];
  /** Directories deliberately kept, with the reason, so the runner can log them. */
  keep: Array<{ directory: string; reason: ReclaimKeepReason }>;
};

export type ReclaimKeepReason =
  | "unknown-run"
  | "active-run"
  | "retained-failure"
  | "foreign-runner"
  | "noncanonical-workspace-path"
  | "intent-closed";

/**
 * `REMOVED` covers "gone now", including a directory that had already vanished:
 * the runner removes with force, so the distinction is invisible to it and
 * carries no information the control plane could act on.
 */
export type ReclaimOutcome = "REMOVED" | "REFUSED" | "FAILED";

export type ReclaimReport = {
  runnerId: string;
  /** Telemetry for the audit record. Authority comes from `runnerId` alone. */
  workspaceRoot: string;
  results: Array<{
    runId: string;
    outcome: ReclaimOutcome;
    failureReason?: string | null | undefined;
  }>;
};

const audit = (event: string, detail: Record<string, unknown>): void => {
  console.warn(JSON.stringify({ audit: "workspace-reclaim", event, ...detail }));
};

type ReclaimCandidate = {
  id: string;
  taskId: string | null;
  runNumber: number;
  baseSha: string | null;
  pushedBranch: string | null;
  targetBranch: string | null;
  task: { templateStep: { baseFromStepIndex: number | null } | null } | null;
  runnerId: string | null;
  workspacePath: string | null;
  status: RunStatus;
  workspaceRetained: boolean;
  endedAt: Date | null;
  workspaceReclaimAt: Date | null;
  workspaceReclaimedAt: Date | null;
};

/**
 * The whole of the ownership rule: the runner the control plane recorded when
 * it claimed the run, and nothing else.
 *
 * Earlier drafts also accepted a null `runnerId` and a recorded `workspacePath`
 * lying under the root the caller declared. Both were wrong in the same way.
 * `RUNNER_TOKEN` authenticates a runner *class*, not a runner (auth.ts), so
 * `runnerId` is the only identity in the exchange — and a rule that lets a
 * caller reach a run by describing its own root turns that identity back into a
 * shared bearer credential plus a self-reported path. Two daemons sharing a
 * root, or one whose id changed across a restart, could then take each other's
 * runs. Structural ownership means only the creator disposes.
 *
 * The cost is that a workspace whose runner never comes back under the same id
 * is nobody's to reclaim. That is deliberate, and it is why `RUNNER_ID` should
 * be set to a stable value (.env.example); the leftovers are handled out of
 * band by `scripts/os-isolation/reclaim-orphan-workspaces.sh`, which is
 * explicit, operator-run and audited, rather than by an implicit fallback here.
 */
const ownedByCaller = (run: { runnerId: string | null }, runnerId: string): boolean => run.runnerId === runnerId;

const isTerminal = (status: RunStatus): boolean =>
  terminalRunStatuses.includes(status as typeof terminalRunStatuses[number]);

/**
 * Applies the retention policy to the caller's inventory and publishes an
 * intent for everything reclaimable. Deletes nothing, and never reads the
 * filesystem.
 *
 * `failedRetentionCount` keeps the newest N retained failures, matching the
 * contract the old sweep offered: retention is ranked over the directories that
 * actually exist, which is exactly what the inventory is.
 */
export const publishReclaimIntents = async (
  db: PrismaClient,
  inventory: ReclaimInventory,
  failedRetentionCount: number,
  now = new Date(),
): Promise<ReclaimPlan> => {
  const root = resolve(inventory.workspaceRoot);
  const directories = [...new Set(inventory.directories)];
  const runs = directories.length === 0 ? [] : await db.run.findMany({
    where: { id: { in: directories } },
    select: {
      id: true, taskId: true, runNumber: true, baseSha: true, pushedBranch: true, targetBranch: true,
      task: { select: { templateStep: { select: { baseFromStepIndex: true } } } },
      runnerId: true, workspacePath: true, status: true,
      workspaceRetained: true, endedAt: true, workspaceReclaimAt: true, workspaceReclaimedAt: true,
    },
  }) as ReclaimCandidate[];
  const byId = new Map(runs.map((run) => [run.id, run] as const));
  // Ranked across the retained failures present in this inventory, newest
  // first; a run that never ended sorts first because its endedAt is the one
  // thing still being written.
  const retainedRank = runs
    .filter((run) => run.workspaceRetained && isTerminal(run.status) && ownedByCaller(run, inventory.runnerId))
    .sort((left, right) => {
      if (left.endedAt === null && right.endedAt === null) return left.id.localeCompare(right.id);
      if (left.endedAt === null) return -1;
      if (right.endedAt === null) return 1;
      return right.endedAt.getTime() - left.endedAt.getTime();
    });
  const stillRetained = new Set(retainedRank.slice(0, Math.max(0, failedRetentionCount)).map(({ id }) => id));

  const reclaim: ReclaimOffer[] = [];
  const keep: ReclaimPlan["keep"] = [];
  const publish: string[] = [];
  const unretain: string[] = [];
  for (const directory of directories) {
    const run = byId.get(directory);
    // Fail closed. A directory this database has never heard of is evidence of
    // a database/root mismatch — the 2026-08-18 incident — and the answer is to
    // report it, never to authorize its removal.
    if (!run) {
      keep.push({ directory, reason: "unknown-run" });
      continue;
    }
    if (!ownedByCaller(run, inventory.runnerId)) {
      keep.push({ directory, reason: "foreign-runner" });
      continue;
    }
    // Only a terminal run's directory is disposable. The two lists partition
    // today's statuses, so this is `workspaceKeepStatuses` restated — but the
    // test is written on the terminal side deliberately, because a status added
    // later must default to "keep" rather than to "delete".
    if (!isTerminal(run.status)) {
      keep.push({ directory, reason: "active-run" });
      continue;
    }
    if (stillRetained.has(run.id)) {
      keep.push({ directory, reason: "retained-failure" });
      continue;
    }
    // The owner already answered for this run — it removed the directory or
    // refused the path. A directory that survives a closed intent is an anomaly
    // for an operator to look at, not something to offer again in a loop that
    // would repeat the same answer every poll.
    if (run.workspaceReclaimedAt) {
      keep.push({ directory, reason: "intent-closed" });
      audit("keep-closed-intent", { root, runId: run.id, reclaimedAt: run.workspaceReclaimedAt.toISOString() });
      continue;
    }
    // A workspacePath that disagrees with the run's canonical directory is a
    // provisioning anomaly. Offering it anyway would authorize deleting a
    // directory the control plane does not believe belongs to this run, so the
    // disagreement keeps it instead.
    if (run.workspacePath && resolve(run.workspacePath) !== resolve(root, run.id)) {
      keep.push({ directory, reason: "noncanonical-workspace-path" });
      audit("keep-noncanonical-workspace-path", { root, runId: run.id, workspacePath: run.workspacePath });
      continue;
    }
    reclaim.push({
      runId: run.id,
      workspacePath: run.workspacePath,
      pinnedBaseSha: run.task?.templateStep?.baseFromStepIndex == null ? null : run.targetBranch,
      taskId: run.taskId,
      runNumber: run.runNumber,
      baseSha: run.baseSha,
      pushedBranch: run.pushedBranch,
    });
    if (!run.workspaceReclaimAt) publish.push(run.id);
    if (run.workspaceRetained) unretain.push(run.id);
  }
  if (publish.length > 0) {
    await db.run.updateMany({
      where: { id: { in: publish }, workspaceReclaimAt: null },
      data: { workspaceReclaimAt: now },
    });
  }
  // Retention expiring is the control plane's decision, and it is recorded when
  // the intent is published rather than when the runner answers: the flag is
  // what the operator reads to know a workspace is still being held.
  if (unretain.length > 0) {
    await db.run.updateMany({ where: { id: { in: unretain } }, data: { workspaceRetained: false } });
  }
  // Everything this caller still owes an answer for, whose directory it did not
  // list. Ordered oldest first so a backlog drains in the order it accumulated.
  const verify = (await db.run.findMany({
    where: {
      runnerId: inventory.runnerId,
      workspaceReclaimAt: { not: null },
      workspaceReclaimedAt: null,
      id: { notIn: directories },
    },
    select: {
      id: true, workspacePath: true, targetBranch: true,
      task: { select: { templateStep: { select: { baseFromStepIndex: true } } } },
    },
    orderBy: { workspaceReclaimAt: "asc" },
    take: settlementPageSize,
  })).map((run) => ({
    runId: run.id,
    workspacePath: run.workspacePath,
    pinnedBaseSha: run.task?.templateStep?.baseFromStepIndex == null ? null : run.targetBranch,
  }));
  for (const { directory, reason } of keep) {
    if (reason === "unknown-run") audit("keep-unknown-directory", { root, directory, caller: inventory.runnerId });
  }
  audit("plan", {
    root, caller: inventory.runnerId, scanned: directories.length,
    offered: reclaim.length, toVerify: verify.length, kept: keep.length,
  });
  return { reclaim, verify, keep };
};

type ApplyResult = "closed" | "failed" | "ignored";

/**
 * Records one outcome, monotonically.
 *
 * Every write for a result happens in one transaction gated by the same
 * compare-and-set — the intent is published and *not yet closed* — so the
 * terminal state is decided by whichever report closes it first, never by
 * whichever arrives last. That matters because reports are retried and sweeps
 * can overlap: without it, a stale `FAILED` landing after a `REMOVED` rolled a
 * succeeded cleanup back to failed, and a crash between the two writes left a
 * closed intent with a cleanup status that never caught up.
 */
const applyOutcome = async (
  db: PrismaClient,
  report: ReclaimReport,
  result: ReclaimReport["results"][number],
  now: Date,
): Promise<ApplyResult> => db.$transaction(async (tx) => {
  const run = await tx.run.findUnique({
    where: { id: result.runId },
    select: {
      id: true,
      runnerId: true, status: true, workspaceReclaimAt: true, workspaceReclaimedAt: true,
    },
  });
  // Only an intent this API published, for a finished run, reported by the
  // runner that owns it, and not already answered for.
  if (!run || !run.workspaceReclaimAt || run.workspaceReclaimedAt || !isTerminal(run.status)) return "ignored";
  if (!ownedByCaller(run, report.runnerId)) {
    audit("report-foreign-runner", { runId: run.id, owner: run.runnerId, caller: report.runnerId });
    return "ignored";
  }
  if (result.outcome === "FAILED") {
    // A failure leaves the intent open — an `rm` that failed can succeed next
    // time — but it still takes the CAS, so it cannot overwrite a cleanup a
    // concurrent report already settled.
    const bumped = await tx.run.updateMany({
      where: { id: run.id, workspaceReclaimAt: { not: null }, workspaceReclaimedAt: null },
      data: { workspaceReclaimAttempts: { increment: 1 } },
    });
    if (bumped.count !== 1) return "ignored";
    await tx.session.updateMany({
      where: { runId: run.id },
      data: {
        cleanupStatus: CleanupStatus.FAILED,
        cleanupEndedAt: now,
        cleanupFailureReason: result.failureReason ?? "Workspace reclaim failed",
      },
    });
    audit("reclaim-failed", { runId: run.id, caller: report.runnerId, error: result.failureReason ?? null });
    return "failed";
  }
  const closed = await tx.run.updateMany({
    where: { id: run.id, workspaceReclaimAt: { not: null }, workspaceReclaimedAt: null },
    data: {
      workspaceReclaimedAt: now,
      // A refusal is not evidence the workspace is gone, so it must not clear
      // the flag that says one is being held.
      ...(result.outcome === "REMOVED" ? { workspaceRetained: false } : {}),
    },
  });
  if (closed.count !== 1) return "ignored";
  await tx.session.updateMany({
    where: { runId: run.id },
    data: result.outcome === "REMOVED"
      ? { cleanupStatus: CleanupStatus.SUCCEEDED, cleanupEndedAt: now, cleanupFailureReason: null }
      : {
        cleanupStatus: CleanupStatus.FAILED,
        cleanupEndedAt: now,
        cleanupFailureReason: result.failureReason ?? "Runner refused to reclaim the workspace",
      },
  });
  if (result.outcome === "REFUSED") {
    // Closed on purpose: the runner declined the path on its own root check,
    // and re-offering it would only repeat the refusal every poll. It stays
    // visible as a failed cleanup for an operator.
    audit("reclaim-refused", { runId: run.id, caller: report.runnerId, error: result.failureReason ?? null });
  }
  return "closed";
});

export const recordReclaimOutcomes = async (
  db: PrismaClient,
  report: ReclaimReport,
  now = new Date(),
): Promise<{ closed: number; failed: number; ignored: number }> => {
  const tally = { closed: 0, failed: 0, ignored: 0 };
  for (const result of report.results) {
    tally[await applyOutcome(db, report, result, now)] += 1;
  }
  if (tally.closed > 0 || tally.failed > 0 || tally.ignored > 0) {
    audit("reclaimed", { caller: report.runnerId, root: report.workspaceRoot, ...tally });
  }
  return tally;
};

/** A retained/lost workspace can outlive its run lease. The owning runner uses
 * this narrow ACK after pushing the deterministic salvage ref and before it
 * deletes the directory; unlike run publication it is authorized by the open
 * reclaim intent and recorded runner ownership, not by an expired fence. */
export type ReplacementRepair = "none" | "repaired" | "requeued" | "already-started";

export const acknowledgeReclaimSalvage = async (
  db: PrismaClient,
  input: { runnerId: string; runId: string; pushedBranch: string },
  repairReplacement: (
    tx: Prisma.TransactionClient,
    run: { taskId: string; runNumber: number; branch: string | null; targetBranch: string | null },
  ) => Promise<ReplacementRepair> = repairReplacementAfterSalvage,
): Promise<false | ReplacementRepair> => {
  return db.$transaction(async (tx) => {
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: {
        id: true, runnerId: true, taskId: true, runNumber: true, status: true,
        workspaceReclaimAt: true, workspaceReclaimedAt: true, pushedBranch: true, branch: true,
        targetBranch: true, baseSha: true, basePublishedAt: true,
      },
    });
    const expected = run?.taskId ? runOwnedHead(run.taskId, run.runNumber) : null;
    if (!run || !ownedByCaller(run, input.runnerId) || !isTerminal(run.status)
      || !run.workspaceReclaimAt || run.workspaceReclaimedAt
      || input.pushedBranch !== expected
      || (run.pushedBranch !== null && run.pushedBranch !== input.pushedBranch)) return false;
    const updated = await tx.run.updateMany({
      where: {
        id: run.id,
        runnerId: input.runnerId,
        workspaceReclaimAt: { not: null },
        workspaceReclaimedAt: null,
        OR: [{ pushedBranch: null }, { pushedBranch: input.pushedBranch }],
      },
      // A salvage commit descends from the base this Run was provisioned at,
      // so publishing it publishes that base too.
      data: { pushedBranch: input.pushedBranch, basePublishedAt: basePublishedStamp(run, new Date()) },
    });
    if (updated.count !== 1 || !run.taskId) return false;
    const repair = await repairReplacement(tx, {
      taskId: run.taskId,
      runNumber: run.runNumber,
      branch: run.branch,
      targetBranch: run.targetBranch,
    });
    if (repair === "already-started") {
      const replacement = await tx.run.findFirst({
        where: { taskId: run.taskId, runNumber: run.runNumber + 1 },
        select: { runNumber: true, status: true, baseSha: true },
      });
      if (replacement) {
        await tx.taskActivity.create({ data: {
          taskId: run.taskId,
          actorType: "control-plane",
          body: replacement.baseSha === null
            ? `Salvage branch ${input.pushedBranch} from LOST Run ${run.runNumber} was not consumed by replacement Run ${replacement.runNumber} (${replacement.status}), which has no recorded baseSha`
            : `Salvage branch ${input.pushedBranch} from LOST Run ${run.runNumber} was not consumed by replacement Run ${replacement.runNumber} (${replacement.status}) from baseSha ${replacement.baseSha}`,
        } });
      }
    }
    return repair;
  });
};

/** Recomputes the immediate replacement after a late salvage publication.
 * A claimed row has not crossed /start yet, but reusing its id would let the old
 * runner clean the same directory a new runner is provisioning. Terminate that
 * row while preserving its cleanup ownership, refund the platform-caused
 * attempt, and enqueue a fresh row with a distinct workspace id. */
export const repairReplacementAfterSalvage = async (
  tx: Prisma.TransactionClient,
  run: { taskId: string; runNumber: number; branch: string | null; targetBranch: string | null },
): Promise<ReplacementRepair> => {
  // Salvage can arrive after Hold has committed but before this replacement
  // reaches /start. Join the same Task/Chain mutex as every other Run producer,
  // before observing it: otherwise this transaction can observe RELEASED,
  // wait on the Task foreign key, and commit a later-layer Run after Hold
  // returns.
  if (!await lockTaskMutationRows(tx, run.taskId)) return "already-started";
  const replacement = await tx.run.findFirst({
    where: { taskId: run.taskId, runNumber: run.runNumber + 1 },
    select: { id: true, runNumber: true, status: true, startedAt: true, leaseLossRefunds: true, maxRunsPerTask: true, budgetGrants: true },
  });
  if (!replacement) return "none";
  if (replacement.status === RunStatus.CLAIMED && replacement.startedAt === null) {
    const revokedAt = new Date();
    // Invalidating the stale claim is not optional — its clone base is wrong —
    // but the attempt it refunds is, and it is the same bounded refund the
    // lease-loss path spends. `openRun` below refuses once the bound is
    // reached, so recording a grant here that nothing may use would leave the
    // operator's own retry holding an attempt this transaction just refused.
    // Bind the grant to the same latest Run that openRun will check below.
    const refund = await refundForLostRun(tx, {
      taskId: run.taskId, run: replacement, reason: "claim-invalidated",
    });
    const revoked = await tx.run.updateMany({
      where: { id: replacement.id, status: RunStatus.CLAIMED, startedAt: null },
      data: {
        status: RunStatus.CANCELLED,
        endedAt: revokedAt,
        leaseExpiresAt: null,
        sessionTokenRevokedAt: revokedAt,
        failureClass: FailureClass.CANCELLED_OR_TIMED_OUT,
        failureReason: "Claim invalidated before start because late salvage changed its clone base",
        retryable: true,
        ...refund.budget,
      },
    });
    if (revoked.count !== 1) return "already-started";
    await tx.session.updateMany({
      where: { runId: replacement.id },
      data: {
        executionStatus: SessionExecutionStatus.CANCELLED,
        endedAt: revokedAt,
        failureReason: "Claim invalidated before start because late salvage changed its clone base",
      },
    });
    // Named rather than `enqueue`: this replacement exists because the platform
    // invalidated a claim, so it is one of the refunds the bound counts.
    const reopened = await reopenRefundedRun(tx, {
      taskId: run.taskId,
      refund,
      readyAt: revokedAt,
      now: revokedAt,
      activityPrefix: "Late-salvage replacement was revoked and not requeued",
    });
    // The stale clone was revoked either way. When no replacement follows, Hold
    // still owns when one may run.
    return reopened.kind === "reopened" ? "requeued" : "repaired";
  } else if (replacement.status !== RunStatus.QUEUED) {
    return "already-started";
  }
  const task = await tx.task.findUnique({
    where: { id: run.taskId },
    include: { repo: true, templateStep: true },
  });
  if (!task?.repo) return "already-started";
  // A late salvage moves only the publication evidence the *base* resolves
  // against, so only the base is repaired here. The replacement's head was
  // decided at its own birth by `resolveRunBranches` and stays that Run's:
  // re-deciding it from the salvaged Run would hand a replacement the ref its
  // predecessor owns. The `enqueue` arm is what asks for the base under current
  // evidence rather than the replacement's birth snapshot, which is exactly
  // what a moved base means; the head that arm returns is discarded.
  const { targetBranch } = await resolveRunBranches(tx, { ...task, repo: task.repo }, {
    intent: "enqueue",
    runNumber: run.runNumber + 1,
    prior: { branch: run.branch, targetBranch: run.targetBranch, runNumber: run.runNumber },
  });
  const repaired = await tx.run.updateMany({
    where: { id: replacement.id, status: RunStatus.QUEUED },
    data: { targetBranch },
  });
  return repaired.count === 1 ? "repaired" : "already-started";
};

/** How many published intents are still waiting for their owner to act. */
export const openReclaimIntentCount = async (db: PrismaClient): Promise<number> => db.run.count({
  where: { workspaceReclaimAt: { not: null }, workspaceReclaimedAt: null },
});
