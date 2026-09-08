import {
  executionModeFor,
  isRegressionVerificationOutputKind,
  leaseLossRefundDecision,
  lockTaskRow,
  openRun,
  settleRunBirthRefusal,
  RunStatus,
  TaskStatus,
  type PrismaClient,
} from "@anneal/db";

import {
  commitWithLeaseOutcomes,
  deferredLeaseReleases,
  LeaseOutcomePostCommitError,
  leaseHandoffsWithoutConsumer,
  releaseMergeLease,
  type LeaseOutcome,
  type LeaseOutcomePostCommitFailure,
  type ReleaseMergeLease,
} from "./merge-lease.js";
import {
  COMPLETION_REJECTION_ACTIVITY_KIND,
  parseCompletionRejection,
} from "./completion-rejection.js";
import { handleRegressionCompletion, regressionVerdictForRun } from "./merge-tail-actions.js";
import { leaseLossRetryDelayMs } from "./execution.js";
import { openReclaimIntentCount } from "./workspace-reclaim.js";
import { terminalizeRun } from "./run-terminal.js";

const activeStatuses = [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING] as const;
const archivedNoticePageSize = 100;
export const archivedNoticeSweepIntervalMs = 60_000;

export class ReconciliationMaintenanceError extends Error {
  readonly reconciledAt: Date;
  readonly failures: LeaseOutcomePostCommitFailure[];

  constructor(reconciledAt: Date, cause: LeaseOutcomePostCommitError) {
    super("Run reconciliation committed, but Merge Lease maintenance failed");
    this.name = "ReconciliationMaintenanceError";
    this.reconciledAt = reconciledAt;
    this.failures = cause.failures;
    this.cause = cause;
  }
}

export const noteArchivedQueuedRuns = async (
  db: PrismaClient,
  options: { agentId?: string } = {},
): Promise<number> => {
  let cursor: string | undefined;
  let inserted = 0;
  do {
    const stalled = await db.run.findMany({
      where: {
        status: RunStatus.QUEUED,
        taskId: { not: null },
        agent: { archivedAt: { not: null } },
        ...(options.agentId ? { agentId: options.agentId } : {}),
      },
      select: {
        id: true,
        taskId: true,
        runNumber: true,
        agent: { select: { name: true, archivedAt: true } },
      },
      orderBy: { id: "asc" },
      take: archivedNoticePageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const rows = stalled.flatMap((run) => run.taskId && run.agent.archivedAt ? [{
      id: `archived-skip:${run.id}:${run.agent.archivedAt.toISOString()}`,
      taskId: run.taskId,
      actorType: "control-plane",
      body: `Assignee ${run.agent.name} is archived; run ${run.runNumber} stays queued and is not claimed until the agent is unarchived`,
    }] : []);
    if (rows.length > 0) {
      inserted += (await db.taskActivity.createMany({ data: rows, skipDuplicates: true })).count;
    }
    if (stalled.length < archivedNoticePageSize) break;
    cursor = stalled.at(-1)?.id;
  } while (cursor);
  return inserted;
};

export const createArchivedRunNoticeScheduler = (
  db: PrismaClient,
  intervalMs = archivedNoticeSweepIntervalMs,
): ((now?: Date) => Promise<number>) => {
  let nextSweepAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<number> | null = null;
  return async (now = new Date()) => {
    if (inFlight) return inFlight;
    if (now.getTime() < nextSweepAt) return 0;
    nextSweepAt = now.getTime() + intervalMs;
    inFlight = noteArchivedQueuedRuns(db);
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
};

export const reconcileDatabaseRuns = async (
  db: PrismaClient,
  now = new Date(),
  releaseChainLease: ReleaseMergeLease = releaseMergeLease,
): Promise<number> => {
  const [candidates, expiredInboxRuns] = await Promise.all([
    db.run.findMany({
      where: {
        status: { in: [...activeStatuses] },
        OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }],
      },
      select: {
        heartbeatAt: true,
        leaseExpiresAt: true,
        cancelRequestId: true,
        cancelReason: true,
        cancelRequestedAt: true,
        id: true,
        projectId: true,
        taskId: true,
        goalId: true,
        agentId: true,
        repoId: true,
        runNumber: true,
        runner: true,
        model: true,
        codexServiceTier: true,
        subagentModel: true,
        subagentMaxConcurrent: true,
        targetBranch: true,
        branch: true,
        promptHash: true,
        maxDurationMin: true,
        stallTimeoutMin: true,
        maxRunsPerTask: true,
        budgetGrants: true,
        leaseLossRefunds: true,
        headSha: true,
        session: { select: { id: true } },
        task: {
          select: {
            id: true,
            projectId: true,
            repoId: true,
            templateId: true,
            chainId: true,
            chainIndex: true,
            targetBranch: true,
            templateStep: {
              select: {
                stepIndex: true,
                outputKind: true,
                taskTemplate: { select: { name: true } },
              },
            },
          },
        },
      },
    }),
    db.run.findMany({
      where: {
        status: RunStatus.WAITING_INBOX,
        session: { is: { resumableUntil: { lt: now } } },
      },
      select: {
        id: true,
        taskId: true,
        session: { select: { id: true, waitingOnMessageId: true } },
      },
    }),
  ]);
  // An api restart outlives a lease (60s) but not a heartbeat cycle. A run whose
  // runner is still checking in is alive — it renews its own lease on the next
  // heartbeat — so only silence beyond the stall timeout counts as death.
  const orphans = candidates.filter((run) => run.cancelRequestedAt !== null || !(
    run.heartbeatAt && now.getTime() - run.heartbeatAt.getTime() < run.stallTimeoutMin * 60_000
  ));
  const reconciliation = await commitWithLeaseOutcomes(db, async (tx) => {
    const strandedHandoffs = await leaseHandoffsWithoutConsumer(tx, now);
    const deferredReleases = await deferredLeaseReleases(tx, now);
    if (orphans.length === 0 && expiredInboxRuns.length === 0
      && strandedHandoffs.length === 0 && deferredReleases.length === 0) {
      return { value: { count: 0 }, leaseOutcomes: [] };
    }
    const leaseOutcomes: LeaseOutcome[] = [];
    for (const run of orphans) {
      const leaseLossReason = !run.leaseExpiresAt
        ? "Platform lease missing during startup reconciliation; runner heartbeat authority was lost"
        : run.heartbeatAt === null
          ? `Platform lease expired at ${run.leaseExpiresAt.toISOString()} without a recorded runner heartbeat`
          : `Runner heartbeat starved after ${run.heartbeatAt.toISOString()}; platform lease expired at ${run.leaseExpiresAt.toISOString()}`;
      // Run is the authority for cancellation, fencing, and terminalization.
      // Re-read it under its mutex before Task: the candidate list is only a
      // hint and may predate a cancellation that committed while this sweep
      // was starting.
      await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${run.id} FOR UPDATE`;
      const current = await tx.run.findFirst({
        where: {
          id: run.id,
          status: { in: [...activeStatuses] },
          OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }],
        },
        select: {
          cancelRequestId: true,
          cancelReason: true,
          cancelRequestedAt: true,
          headSha: true,
        },
      });
      if (!current) continue;
      if (current.cancelRequestId && current.cancelRequestedAt) {
        const terminal = await terminalizeRun(tx, {
          runId: run.id,
          at: now,
          outcome: {
            kind: "cancelled",
            requestId: current.cancelRequestId,
            cleanupConfirmed: false,
            activity: "runner-lost",
          },
        });
        if (terminal === null || "message" in terminal) continue;
        leaseOutcomes.push(terminal.leaseOutcome);
        continue;
      }
      // Order PATCH and retry creation through the same Task-row mutex. The
      // task is re-read after this lock before opensPullRequest is snapshotted.
      if (run.taskId) await lockTaskRow(tx, run.taskId);
      const completionRejectionActivities = run.taskId
        && executionModeFor(run.task?.templateStep ?? null) === "mechanical"
        ? await tx.taskActivity.findMany({
            where: {
              taskId: run.taskId,
              metadata: { path: ["kind"], equals: COMPLETION_REJECTION_ACTIVITY_KIND },
            },
            select: { id: true, metadata: true },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          })
        : [];
      const parsedCompletionRejections = completionRejectionActivities.map((activity) => ({
        activityId: activity.id,
        parsed: parseCompletionRejection(activity.metadata, run.id),
      }));
      const completionRejection = parsedCompletionRejections.find(({ parsed }) => parsed.status === "ok")
        ?? parsedCompletionRejections.find(({ parsed }) => parsed.status === "malformed")
        ?? null;
      const durableRegressionVerdict = run.task?.templateId
        && isRegressionVerificationOutputKind(run.task.templateStep?.outputKind)
        ? await regressionVerdictForRun(tx, {
            task: run.task,
            runId: run.id,
            runHeadSha: current.headSha,
            allowPersistedHeadWhenUnreported: true,
          })
        : null;
      const durableNegativeRegressionVerdict = durableRegressionVerdict?.status === "ok"
        && durableRegressionVerdict.verdict.outcome !== "pass"
        ? durableRegressionVerdict.verdict
        : null;
      // Losing a lease is an external failure: it buys an attempt, never spends one.
      // A lost lease refunds the already-authorized Run; it does not recompute
      // from a task budget that may have changed while the Run was in flight.
      //
      // Bounded, though. `openRun` refuses the replacement once this task's
      // platform refunds are spent, and a refund nobody may use is not recorded
      // here either: leaving the grant on the LOST row would hand the operator's
      // own retry the very attempt the bound just refused, and the operator's
      // way out is to raise `maxSessionsPerTask` deliberately.
      // The candidate predates the Task lock. A newer Run must not leave this
      // older row holding a grant that birth will reject as source-run-stale.
      const latest = run.taskId ? await tx.run.findFirst({
        where: { taskId: run.taskId }, orderBy: { runNumber: "desc" }, select: { id: true },
      }) : null;
      const { refundAvailable, maxRunsPerTask: budgetCeiling, budgetGrants } = leaseLossRefundDecision(run, latest?.id ?? null);
      const rejectionFailureReason = completionRejection?.parsed.status === "ok"
        ? `Mechanical completion rejected with HTTP ${completionRejection.parsed.rejection.status}: ${completionRejection.parsed.rejection.responseBody}`
        : completionRejection?.parsed.status === "malformed"
          ? `Mechanical completion rejection record ${completionRejection.activityId} for Run ${run.id} could not be parsed`
          : null;
      const lost = await terminalizeRun(tx, {
        runId: run.id,
        at: now,
        outcome: {
          kind: "lost",
          where: {
            id: run.id,
            cancelRequestedAt: null,
            status: { in: [...activeStatuses] },
            OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }],
          },
          reason: rejectionFailureReason ?? leaseLossReason,
          maxRunsPerTask: budgetCeiling,
          budgetGrants,
        },
      });
      if (lost === null || "message" in lost) continue;
      if (!run.taskId) continue;
      if (completionRejection) {
        leaseOutcomes.push({ kind: "stop", taskId: run.taskId });
        await tx.task.update({
          where: { id: run.taskId },
          data: { status: TaskStatus.REVIEW, failureReason: rejectionFailureReason },
        });
        await tx.taskActivity.create({
          data: {
            taskId: run.taskId,
            actorType: "control-plane",
            body: completionRejection.parsed.status === "ok"
              ? `Run ${run.runNumber} lost after its completion was rejected (${completionRejection.parsed.rejection.status}); automatic retry refused, operator action required`
              : `Run ${run.runNumber} lost after its completion rejection record could not be parsed; automatic retry refused, operator action required`,
          },
        });
        continue;
      }
      if (durableNegativeRegressionVerdict && run.task && run.session) {
        await handleRegressionCompletion(tx, {
          task: run.task,
          run: {
            id: run.id,
            agentId: run.agentId,
            branch: run.branch,
            headSha: durableNegativeRegressionVerdict.headSha,
            sessionId: run.session.id,
          },
          qualifiedVerdict: durableNegativeRegressionVerdict,
          now,
        });
        leaseOutcomes.push({ kind: "stop", taskId: run.taskId });
        await tx.taskActivity.create({
          data: {
            taskId: run.taskId,
            actorType: "control-plane",
            body: `Run ${run.runNumber} lost after publishing a negative Regression verdict; repair queued`,
          },
        });
        continue;
      }
      if (!refundAvailable || run.runNumber < budgetCeiling) {
        const opened = await openRun(tx, run.taskId, {
          kind: "retry-after-lease-loss",
          sourceRunId: run.id,
          sourceMaxRunsPerTask: run.maxRunsPerTask,
          sourceBudgetGrants: run.budgetGrants,
          // Spaced by the refunds already granted, not queued at `now`: a host
          // that keeps losing runs is given time to come back before the next
          // attempt is spent on it.
          readyAt: new Date(now.getTime() + leaseLossRetryDelayMs(run.leaseLossRefunds)),
        });
        if (opened.ok) {
          await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DOING, failureReason: null } });
          await tx.taskActivity.create({
            data: { taskId: run.taskId, actorType: "control-plane", body: `Run ${run.runNumber} lost; retry ${opened.run.runNumber} queued` },
          });
        } else {
          const settlement = await settleRunBirthRefusal(tx, {
            taskId: run.taskId, refusal: opened.refusal, mode: "park", now,
            origin: { kind: "automatic", activityPrefix: `Run ${run.runNumber} lost; automatic retry refused` },
          });
          if (settlement.kind === "raise") throw settlement.error;
          leaseOutcomes.push({ kind: "stop", taskId: run.taskId });
        }
      } else {
        // Budget exhausted: no retry follows, so this lost run is the chain's
        // last word and its lease has no successor to hand itself to.
        leaseOutcomes.push({ kind: "stop", taskId: run.taskId });
        await tx.task.update({
          where: { id: run.taskId },
          data: { status: TaskStatus.REVIEW, failureReason: `Maximum ${budgetCeiling} runs reached after lease loss` },
        });
        await tx.inboxMessage.create({
          data: {
            from: "AGENT",
            taskId: run.taskId,
            kind: "TEXT",
            body: "Run budget exhausted after lease loss; operator action required.",
          },
        });
      }
    }
    for (const run of expiredInboxRuns) {
      const expired = await terminalizeRun(tx, {
        runId: run.id,
        at: now,
        outcome: {
          kind: "timed-out",
          sessionId: run.session?.id ?? null,
          waitingOnMessageId: run.session?.waitingOnMessageId ?? null,
          taskId: run.taskId,
          reason: "Inbox response window expired",
        },
      });
      if (expired === null || "message" in expired) continue;
    }
    for (const handoff of strandedHandoffs) {
      leaseOutcomes.push({
        kind: "stop",
        taskId: handoff.taskId,
        releasedHandoff: {
          eventId: handoff.eventId,
          toRunId: handoff.toRunId,
          target: handoff.target,
          at: now,
        },
      });
    }
    for (const deferred of deferredReleases) {
      leaseOutcomes.push({
        kind: "stop",
        taskId: deferred.taskId,
        deferredRelease: { eventId: deferred.eventId, target: deferred.target, at: now },
      });
    }
    return {
      value: {
        count: orphans.length + expiredInboxRuns.length + strandedHandoffs.length + deferredReleases.length,
      },
      leaseOutcomes,
    };
  }, { release: releaseChainLease }).catch((error: unknown) => {
    if (error instanceof LeaseOutcomePostCommitError) {
      throw new ReconciliationMaintenanceError(now, error);
    }
    throw error;
  });
  return reconciliation.count;
};

/**
 * Startup reconciliation is now database work only.
 *
 * The root-wide filesystem sweep that used to live here is gone: workspace
 * disposal belongs to the runner that provisioned the directory (issue #115),
 * and the API publishes reclaim intents through /runner/workspaces/reclaimable
 * instead. `openReclaimIntents` is reported so an operator can see at a glance
 * whether anything is waiting on a runner that is not answering — with no
 * runner asking, workspaces leak, and leaking is the direction this side of
 * the boundary is allowed to fail in.
 */
/** A count that failed to be read is not a count of zero.
 *
 *  Both of these were `.catch(() => 0)`, which let a failed query render as
 *  `0 archived-run notices` in the startup line — the shape a healthy, idle
 *  control plane has. The 2026-09-01 credential drift was invisible partly for
 *  that reason: the numbers a reader would have checked were manufactured by
 *  the catch, not read from the schema. `null` keeps startup non-fatal (these
 *  are advisory counts; `reconcileDatabaseRuns` above already throws when the
 *  schema is unreachable) while refusing to state a number nobody read. */
export type StartupReconciliation = {
  runs: number;
  openReclaimIntents: number | null;
  archivedNotices: number | null;
};

export const reconcileAtStartup = async (
  db: PrismaClient,
): Promise<StartupReconciliation> => ({
  runs: await reconcileDatabaseRuns(db),
  openReclaimIntents: await openReclaimIntentCount(db).catch((error: unknown) => {
    console.error("Open reclaim intent count failed", error);
    return null;
  }),
  archivedNotices: await noteArchivedQueuedRuns(db).catch((error: unknown) => {
    console.error("Archived-run startup notice failed", error);
    return null;
  }),
});
