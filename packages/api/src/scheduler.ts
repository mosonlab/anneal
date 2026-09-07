import {
  AssigneeType,
  ACTIVE_RUN_STATUSES,
  INTEGRATOR_AGENT_NAME,
  lockChainRows,
  lockChainStructure,
  openRun,
  runBirthRefusalMetadata,
  Prisma,
  type PrismaClient,
  ScheduleKind,
  type Task,
  TaskSource,
  TaskStatus,
} from "@anneal/db";
import { CronExpressionParser } from "cron-parser";

import { lockDoneTasks, partitionArchivable } from "./task-archive.js";

export const computeNextOccurrence = (cron: string, timezone: string | null, after: Date): Date => {
  const expression = cron.trim();
  if (expression.startsWith("@") || expression.split(/\s+/).length !== 5) {
    throw new Error("Cron expressions must use exactly five fields and may not use macros");
  }
  return CronExpressionParser.parse(expression, {
    currentDate: after,
    ...(timezone ? { tz: timezone } : {}),
  }).next().toDate();
};

export type ScheduleFields = {
  scheduleKind: ScheduleKind;
  runAt: Date | null;
  cron: string | null;
  timezone: string | null;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  repoId: string | null;
};

export const validateSchedule = (fields: ScheduleFields, now = new Date()): Pick<ScheduleFields, "scheduleKind" | "runAt" | "cron" | "timezone"> => {
  if (fields.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: fields.timezone }).format(now);
    } catch {
      throw new Error(`Invalid IANA timezone: ${fields.timezone}`);
    }
  }
  if (fields.scheduleKind === ScheduleKind.CRON) {
    if (!fields.cron) throw new Error("CRON tasks require cron");
    return { ...fields, runAt: computeNextOccurrence(fields.cron, fields.timezone, now) };
  }
  if (fields.scheduleKind === ScheduleKind.AT) {
    if (!fields.runAt) throw new Error("AT tasks require runAt");
    if (fields.assigneeType !== AssigneeType.AGENT || !fields.assigneeAgentId || !fields.repoId) {
      throw new Error("AT tasks require an agent assignee and Repo configuration");
    }
  }
  return { scheduleKind: fields.scheduleKind, runAt: fields.runAt, cron: fields.cron, timezone: fields.timezone };
};

const uniqueConflict = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

const quarantineTask = async (db: PrismaClient, task: Task, reason: unknown): Promise<boolean> => db.$transaction(async (tx) => {
  const claimed = await tx.task.updateMany({
    where: {
      id: task.id,
      scheduleKind: task.scheduleKind,
      status: task.status,
      cron: task.cron,
      timezone: task.timezone,
      runAt: task.runAt,
    },
    data: { runAt: null },
  });
  if (claimed.count !== 1) return false;
  await tx.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "scheduler",
    body: `Schedule quarantined: ${reason instanceof Error ? reason.message : String(reason)}`,
  } });
  console.warn("Scheduler quarantined task", { taskId: task.id, reason: reason instanceof Error ? reason.message : String(reason) });
  return true;
}, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

/**
 * §D-P4 at fire time. A scheduled or recurring definition may not be assigned to
 * the sentinel Agent: `POST /projects/:projectId/tasks` and `PATCH /tasks/:taskId`
 * already refuse it, so reaching here means the row predates that rule or was
 * written around it. The definition is quarantined rather than fired, because
 * firing it would either mint a mechanical run nothing may claim or — worse, if
 * the invariant were ever loosened downstream — hand the merge step to a model.
 */
const integratorAssigneeRefusal = async (db: PrismaClient, task: Task): Promise<string | null> => {
  if (!task.assigneeAgentId) return null;
  const agent = await db.agent.findUnique({ where: { id: task.assigneeAgentId }, select: { name: true } });
  return agent?.name === INTEGRATOR_AGENT_NAME
    ? `Agent ${INTEGRATOR_AGENT_NAME} may not be the assignee of a scheduled or recurring task`
    : null;
};

const fireLabel = (now: Date, timezone: string | null): string => new Intl.DateTimeFormat("en-CA", {
  dateStyle: "medium",
  timeStyle: "short",
  ...(timezone ? { timeZone: timezone } : {}),
}).format(now);

export const fireCronTask = async (
  db: PrismaClient,
  task: Task,
  now: Date,
  onQuarantined: () => void = () => {},
): Promise<boolean> => {
  let nextRunAt: Date;
  const sentinelRefusal = await integratorAssigneeRefusal(db, task);
  if (sentinelRefusal) {
    if (await quarantineTask(db, task, new Error(sentinelRefusal))) onQuarantined();
    return false;
  }
  try {
    if (!task.cron) throw new Error("CRON task is missing cron");
    nextRunAt = computeNextOccurrence(task.cron, task.timezone, now);
  } catch (error: unknown) {
    if (await quarantineTask(db, task, error)) onQuarantined();
    return false;
  }

  return db.$transaction(async (tx) => {
    const claimed = await tx.task.updateMany({
      // The poll below is only a hint — it is read outside any transaction and
      // is stale by the time this runs. This claim is a single-statement CAS on
      // the Task row, so its predicate *is* re-checked after a concurrent
      // writer's lock releases: a pause or an archive that lands between the
      // poll and here wins the race instead of firing one more copy.
      where: {
        id: task.id,
        scheduleKind: ScheduleKind.CRON,
        status: TaskStatus.TODO,
        runAt: task.runAt,
        schedulePausedAt: null,
        archivedAt: null,
      },
      data: { runAt: nextRunAt },
    });
    if (claimed.count !== 1) return false;
    const suffix = ` — ${fireLabel(now, task.timezone)}`;
    const copy = await tx.task.create({ data: {
      projectId: task.projectId,
      repoId: task.repoId,
      assigneeAgentId: task.assigneeAgentId,
      assigneeType: task.assigneeType,
      approvalGate: task.approvalGate,
      description: task.description,
      workingDirectory: task.workingDirectory,
      targetBranch: task.targetBranch,
      maxDurationMin: task.maxDurationMin,
      stallTimeoutMin: task.stallTimeoutMin,
      maxSessionsPerTask: task.maxSessionsPerTask,
      spendCap: task.spendCap,
      spendCapApplicable: task.spendCapApplicable,
      name: `${task.name.slice(0, Math.max(0, 200 - suffix.length))}${suffix}`,
      scheduleKind: ScheduleKind.NOW,
      runAt: null,
      cron: null,
      timezone: null,
      chainId: null,
      chainIndex: null,
      templateId: null,
      // The copy is CRON-sourced; the recurring definition itself stays MANUAL
      // — an operator made it by hand and it is still theirs.
      source: TaskSource.CRON,
      recurringSourceTaskId: task.id,
    } });
    if (copy.assigneeType === AssigneeType.AGENT && copy.assigneeAgentId && copy.repoId) {
      const opened = await openRun(tx, copy.id, { kind: "enqueue", readyAt: now });
      if (!opened.ok) {
        const refusal = opened.refusal;
        // Every disposition parks the copy. The copy is chainless and belongs
        // to no integrator, so `held` and `stopped` cannot reach here, and a
        // fired schedule that produced no Run is something an operator has to
        // see whatever refused it.
        await tx.task.update({
          where: { id: copy.id },
          data: { status: TaskStatus.REVIEW, failureReason: refusal.message },
        });
        await tx.taskActivity.createMany({ data: [
          {
            taskId: task.id,
            actorType: "scheduler",
            body: `Recurring schedule advanced without a Run: ${refusal.message}`,
            metadata: { ...runBirthRefusalMetadata(refusal), recurringTaskId: task.id, copyTaskId: copy.id },
          },
          {
            taskId: copy.id,
            actorType: "scheduler",
            body: `Created from recurring task ${task.id}; Run birth refused: ${refusal.message}`,
            metadata: { ...runBirthRefusalMetadata(refusal), recurringTaskId: task.id },
          },
        ] });
        return false;
      }
    }
    const metadata = { recurringTaskId: task.id, firedAt: now.toISOString() };
    await tx.taskActivity.createMany({ data: [
      { taskId: task.id, actorType: "scheduler", body: `Recurring task fired copy ${copy.id}`, metadata },
      { taskId: copy.id, actorType: "scheduler", body: `Created from recurring task ${task.id}`, metadata },
    ] });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
};

export const fireAtTask = async (db: PrismaClient, task: Task, now: Date): Promise<boolean> => {
  const sentinelRefusal = await integratorAssigneeRefusal(db, task);
  if (sentinelRefusal) {
    await quarantineTask(db, task, new Error(sentinelRefusal));
    return false;
  }
  try {
    return await db.$transaction(async (tx) => {
      // This path used to enqueue straight off the poll row, so a task archived
      // after the poll still fired. Lock the Task row and re-check, returning
      // false rather than throwing — the same shape as the unique-conflict path
      // below, so schedulerTick's atFired count stays honest.
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Task" WHERE "id" = ${task.id} FOR UPDATE
      `;
      if (!locked) return false;
      const current = await tx.task.findUniqueOrThrow({
        where: { id: task.id },
        select: {
          status: true,
          archivedAt: true,
          _count: { select: { runs: true } },
        },
      });
      if (current.archivedAt !== null || current.status !== TaskStatus.TODO) return false;
      // An AT task fires exactly once — the same predicate the poll uses. Before
      // the lock this was enforced only accidentally, by two racing callers
      // deriving the same runNumber and losing to the dedupe key; serialised,
      // the loser would otherwise observe run 1 and happily queue run 2.
      if (current._count.runs > 0) return false;
      const opened = await openRun(tx, task.id, { kind: "enqueue", readyAt: now });
      if (opened.ok) return true;
      const refusal = opened.refusal;
      switch (refusal.disposition) {
        case "held":
          // The schedule stays due. Nothing is wrong with it, and the next tick
          // after the hold releases fires it.
          return false;
        case "stopped":
        case "fault":
          await tx.task.update({ where: { id: task.id }, data: { runAt: null } });
          await tx.taskActivity.create({ data: {
            taskId: task.id,
            actorType: "scheduler",
            body: `Schedule quarantined after Run birth refusal: ${refusal.message}`,
            metadata: runBirthRefusalMetadata(refusal),
          } });
          return false;
        default: {
          const unhandled: never = refusal.disposition;
          return unhandled;
        }
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error: unknown) {
    // A held successor is intentionally left due: the scheduler must be able
    // to try it again after Resume releases the live Chain authority. The
    // shared Run-open seam has already rolled the transaction back, so this is
    // an ordinary no-fire result rather than a quarantinable schedule error.
    if (uniqueConflict(error)) return false;
    throw error;
  }
};

/** A DONE task is history after one bounded week, not an indefinitely growing
 * board column. `doneAt` is maintained by the database across every writer so
 * unrelated edits cannot restart this clock. */
export const DONE_TASK_ARCHIVE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DONE_TASK_ARCHIVE_BATCH_SIZE = 100;

type DoneTaskArchiveSweepResult = {
  candidates: number;
  archived: number;
  notArchived: number;
};

type DoneArchiveCandidate = {
  id: string;
  projectId: string;
  chainId: string | null;
};

type DoneArchiveChain = {
  projectId: string;
  chainId: string;
  candidateIds: string[];
};

const archiveTaskRows = async (
  tx: Prisma.TransactionClient,
  options: {
    taskIds: string[];
    projectId: string;
    cutoff: Date;
    archivedAt: Date;
  },
): Promise<number> => {
  const { taskIds, projectId, cutoff, archivedAt } = options;
  if (taskIds.length === 0) return 0;
  const activeRuns = await tx.run.findMany({
    where: { taskId: { in: taskIds }, status: { in: ACTIVE_RUN_STATUSES } },
    select: { taskId: true },
    distinct: ["taskId"],
  });
  const { archive: archivable } = partitionArchivable(
    taskIds,
    activeRuns.flatMap((run) => run.taskId ? [run.taskId] : []),
  );
  if (archivable.length === 0) return 0;
  const updated = await tx.task.updateMany({
    where: {
      id: { in: archivable },
      projectId,
      status: TaskStatus.DONE,
      archivedAt: null,
      doneAt: { lte: cutoff },
    },
    data: { archivedAt },
  });
  if (updated.count !== archivable.length) {
    throw new Error(`Done-task archive changed ${String(updated.count)} of ${String(archivable.length)} locked rows`);
  }
  if (updated.count > 0) {
    await tx.taskActivity.createMany({ data: archivable.map((taskId) => ({
      taskId,
      actorType: "scheduler",
      body: "Task automatically archived after 7 days in Done",
    })) });
  }
  return updated.count;
};

/** Archives stale DONE history from the scheduler's existing periodic tick.
 * Chained candidates are considered as a unit: every persisted member must be
 * DONE before one of its old members can be hidden, otherwise a live chain
 * would acquire a hole in its visible step history. */
export const archiveDoneTasks = async (
  db: PrismaClient,
  now = new Date(),
): Promise<DoneTaskArchiveSweepResult> => {
  const cutoff = new Date(now.getTime() - DONE_TASK_ARCHIVE_AGE_MS);
  // Exclude live chains before taking their writer locks. The same predicate
  // is checked again under each selected chain's locks below.
  const candidates = await db.$queryRaw<DoneArchiveCandidate[]>`
    SELECT candidate."id", candidate."projectId", candidate."chainId"
    FROM "Task" AS candidate
    WHERE candidate."status" = 'done'::"TaskStatus"
      AND candidate."archivedAt" IS NULL
      AND candidate."doneAt" <= ${cutoff}
      AND (
        candidate."chainId" IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "Task" AS sibling
          WHERE sibling."projectId" = candidate."projectId"
            AND sibling."chainId" = candidate."chainId"
            AND sibling."status" <> 'done'::"TaskStatus"
        )
      )
    ORDER BY candidate."doneAt", candidate."id"
    LIMIT ${DONE_TASK_ARCHIVE_BATCH_SIZE}
  `;
  if (candidates.length === 0) return { candidates: 0, archived: 0, notArchived: 0 };

  const standalone = new Map<string, DoneArchiveCandidate[]>();
  const chains = new Map<string, DoneArchiveChain>();
  for (const candidate of candidates) {
    if (candidate.chainId === null) {
      const group = standalone.get(candidate.projectId) ?? [];
      group.push(candidate);
      standalone.set(candidate.projectId, group);
      continue;
    }
    const key = JSON.stringify([candidate.projectId, candidate.chainId]);
    const group = chains.get(key) ?? { projectId: candidate.projectId, chainId: candidate.chainId, candidateIds: [] };
    group.candidateIds.push(candidate.id);
    chains.set(key, group);
  }

  let archived = 0;
  const failures: string[] = [];
  const transactionOptions = {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 2_000,
    timeout: 10_000,
  } as const;
  const orderedChains = [...chains.values()].sort((left, right) => (
    left.projectId.localeCompare(right.projectId) || left.chainId.localeCompare(right.chainId)
  ));
  for (const chain of orderedChains) {
    try {
      archived += await db.$transaction(async (tx) => {
        // Structural locks use the same order as chain append/delete routes.
        // Row locking then makes completion/start/archive races atomic.
        await lockChainStructure(tx, { projectId: chain.projectId, chainId: chain.chainId });
        await lockChainRows(tx, { projectId: chain.projectId, chainId: chain.chainId });
        const rows = await tx.task.findMany({
          where: { projectId: chain.projectId, chainId: chain.chainId },
          select: { id: true, status: true, archivedAt: true, doneAt: true },
        });
        // Empty chains are possible after a concurrent delete. No candidate can
        // be archived in that case, and all-DONE remains intentionally fail-closed
        // for malformed chains that contain a non-DONE member.
        if (rows.length === 0 || !rows.every((row) => row.status === TaskStatus.DONE)) return 0;
        const eligible = chain.candidateIds.filter((taskId) => rows.some((row) => (
          row.id === taskId
            && row.status === TaskStatus.DONE
            && row.archivedAt === null
            && row.doneAt !== null
            && row.doneAt <= cutoff
        )));
        return archiveTaskRows(tx, {
          taskIds: eligible,
          projectId: chain.projectId,
          cutoff,
          archivedAt: now,
        });
      }, transactionOptions);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`chain ${chain.projectId}/${chain.chainId}: ${reason}`);
      console.error("Scheduled DONE task archive unit failed", {
        kind: "chain", projectId: chain.projectId, chainId: chain.chainId, reason, error,
      });
    }
  }

  for (const projectId of [...standalone.keys()].sort()) {
    try {
      const projectCandidates = standalone.get(projectId)!;
      archived += await db.$transaction(async (tx) => {
        const locked = await lockDoneTasks(
          tx,
          projectId,
          projectCandidates.map((candidate) => candidate.id),
          cutoff,
        );
        return archiveTaskRows(tx, {
          taskIds: locked,
          projectId,
          cutoff,
          archivedAt: now,
        });
      }, transactionOptions);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`standalone project ${projectId}: ${reason}`);
      console.error("Scheduled DONE task archive unit failed", {
        kind: "standalone", projectId, reason, error,
      });
    }
  }

  if (failures.length > 0) {
    throw new Error(`Done-task archive sweep failed for ${String(failures.length)} bounded unit(s): ${failures.join("; ")}`);
  }
  return { candidates: candidates.length, archived, notArchived: candidates.length - archived };
};

export const schedulerTick = async (db: PrismaClient, now = new Date()): Promise<{ cronFired: number; atFired: number; quarantined: number }> => {
  const [cronTasks, atTasks] = await Promise.all([
    db.task.findMany({ where: {
      scheduleKind: ScheduleKind.CRON,
      status: TaskStatus.TODO,
      runAt: { lte: now },
      schedulePausedAt: null,
      archivedAt: null,
    } }),
    db.task.findMany({ where: {
      scheduleKind: ScheduleKind.AT,
      status: TaskStatus.TODO,
      runAt: { lte: now },
      // A cancelled predecessor is terminal and cannot be resumed. It does
      // not consume the AT definition's one fresh enqueue, while every other
      // prior Run status keeps the original one-shot behavior.
      runs: { none: {} },
      assigneeType: AssigneeType.AGENT,
      archivedAt: null,
    } }),
  ]);
  let cronFired = 0;
  let atFired = 0;
  let quarantined = 0;
  for (const task of cronTasks) {
    try {
      if (await fireCronTask(db, task, now, () => { quarantined += 1; })) cronFired += 1;
    } catch (error: unknown) {
      console.error("Scheduled CRON task fire failed", { taskId: task.id, error });
    }
  }
  for (const task of atTasks) {
    try {
      if (await fireAtTask(db, task, now)) atFired += 1;
    } catch (error: unknown) {
      console.error("Scheduled AT task fire failed", { taskId: task.id, error });
    }
  }
  try {
    const archived = await archiveDoneTasks(db, now);
    if (archived.candidates > 0) console.log("Scheduled DONE task archive sweep", archived);
  } catch (error: unknown) {
    // A failed sweep must stay visible in the service logs and is retried on
    // the next scheduler tick; silently abandoning old Done history would make
    // the bounded-age policy fail in exactly the way it was meant to prevent.
    console.error("Scheduled DONE task archive sweep failed", {
      reason: error instanceof Error ? error.message : String(error),
      error,
    });
  }
  return { cronFired, atFired, quarantined };
};

export const schedulerPollIntervalMs = (raw = process.env.SCHEDULER_POLL_INTERVAL_MS): number => {
  const fallback = 30_000;
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 0) {
    console.warn(`Invalid SCHEDULER_POLL_INTERVAL_MS=${JSON.stringify(raw)}; using ${fallback}ms`);
    return fallback;
  }
  return parsed;
};

export const startScheduler = (db: PrismaClient): ReturnType<typeof setInterval> | null => {
  const intervalMs = schedulerPollIntervalMs();
  if (intervalMs === 0) return null;
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    void schedulerTick(db)
      .then((result) => {
        if (result.cronFired || result.atFired || result.quarantined) console.log("Scheduler tick", result);
      })
      .catch((error: unknown) => console.error("Scheduler tick failed", error))
      .finally(() => { busy = false; });
  }, intervalMs);
};
