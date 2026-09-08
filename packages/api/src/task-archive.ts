import { ACTIVE_RUN_STATUSES, InboxStatus, lockChainRows, Prisma, TaskStatus } from "@anneal/db";

import { readChainRepairTaskIds } from "./board.js";
import type { Refusal } from "./refusal.js";
import { isLiveStatus, lockTask, lockTaskMutationRows, reactivationBlocked } from "./task-write.js";

/**
 * The Task ids one archive decision covers: every row whose `archivedAt` this
 * request flips, already locked and already checked.
 */
export type ArchiveSet = { ids: string[] };

/** The archive-done sweep's answer: the set it may archive, and how many
 * locked candidates an active Run kept out of it. */
export type DoneArchiveSet = ArchiveSet & { skipped: number };

const STOP_NOTICE_DEDUPE_PREFIX = "merge-tail-stop:";

/** Archival moves a Chain as one card, so the set is the whole Chain, not the
 * row the operator pressed. A task outside a Chain is its own set. */
const chainMemberIds = async (
  tx: Prisma.TransactionClient,
  locked: { id: string; projectId: string; chainId: string | null },
): Promise<string[]> => (
  locked.chainId === null
    ? [locked.id]
    : (await tx.task.findMany({
      where: { projectId: locked.projectId, chainId: locked.chainId },
      select: { id: true },
    })).map((task) => task.id)
);

const activeRunTaskIds = async (
  tx: Prisma.TransactionClient,
  taskIds: string[],
): Promise<string[]> => {
  if (taskIds.length === 0) return [];
  const busy = await tx.run.findMany({
    where: { taskId: { in: taskIds }, status: { in: ACTIVE_RUN_STATUSES } },
    select: { taskId: true },
    distinct: ["taskId"],
  });
  return busy.flatMap((run) => run.taskId === null ? [] : [run.taskId]);
};

/** Locks a whole candidate set in one deterministic statement and re-checks
 * the shared DONE/archive predicate after any concurrent writer releases it. */
export const lockDoneTasks = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  taskIds: string[],
  doneBefore?: Date,
): Promise<string[]> => {
  if (taskIds.length === 0) return [];
  const completionPredicate = doneBefore === undefined
    ? Prisma.empty
    : Prisma.sql`AND "doneAt" <= ${doneBefore}`;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task"
    WHERE "id" = ANY(${taskIds})
      AND "archivedAt" IS NULL
      AND "projectId" = ${projectId}
      AND "status" = 'done'::"TaskStatus"
      ${completionPredicate}
    ORDER BY "id" FOR UPDATE
  `;
  return rows.map((row) => row.id);
};

/** Splits candidates from rows whose active Run still makes archival unsafe. */
export const partitionArchivable = (
  candidateIds: string[],
  busyIds: string[],
): { archive: string[]; skipped: number } => {
  const busy = new Set(busyIds);
  const archive = candidateIds.filter((taskId) => !busy.has(taskId));
  return { archive, skipped: candidateIds.length - archive.length };
};

/**
 * The set a single-task archive request must move, or the refusal that stops
 * it. Everything the decision needs is read under the lock order this function
 * owns: detached repair Tasks first, then the Chain rows, then the repair
 * markers again.
 *
 * Detached repair completion takes its own Task lock before the primary Chain
 * lock. Joining that order is what lets a completion that already owns the
 * repair row emit its notice before archive closes notices, while an archive
 * that wins refuses the still-active repair Run. Chain identity and repair
 * markers are immutable, but repairs are resolved again after the Chain lock to
 * catch one created between the two reads.
 *
 * Repair Tasks are part of the refusal set and not of the archived set: an
 * active repair Run blocks the archive, but the detached row is not a card the
 * operator archived.
 */
export const archiveSet = async (
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<ArchiveSet | Refusal> => {
  const identity = await tx.task.findUnique({
    where: { id: taskId },
    select: { projectId: true, chainId: true },
  });
  if (!identity) return { reason: "not-found", message: "Task not found" };
  if (identity.chainId !== null) {
    const unlockedChainTaskIds = (await tx.task.findMany({
      where: { projectId: identity.projectId, chainId: identity.chainId },
      select: { id: true },
    })).map((task) => task.id);
    const unlockedRepairTaskIds = await readChainRepairTaskIds(tx, {
      projectId: identity.projectId,
      chainTaskIds: unlockedChainTaskIds,
    });
    for (const repairTaskId of unlockedRepairTaskIds) {
      if (!await lockTask(tx, repairTaskId)) {
        throw new Error(`Chain repair task ${repairTaskId} disappeared while archive acquired its lock`);
      }
    }
  }
  const locked = await lockTaskMutationRows(tx, taskId);
  if (!locked) return { reason: "not-found", message: "Task not found" };
  const taskIds = await chainMemberIds(tx, locked);
  const repairTaskIds = locked.chainId === null
    ? []
    : await readChainRepairTaskIds(tx, { projectId: locked.projectId, chainTaskIds: taskIds });
  const busy = await activeRunTaskIds(tx, [...new Set([...taskIds, ...repairTaskIds])]);
  if (busy.length > 0) {
    return { reason: "conflict", message: "Cannot archive a task with an active run" };
  }
  const tasks = await tx.task.findMany({
    where: { id: { in: taskIds } },
    select: { id: true, status: true, archivedAt: true },
  });
  const reviewIds = tasks.filter((task) => task.status === TaskStatus.REVIEW).map((task) => task.id);
  if (reviewIds.length > 0) {
    const open = await tx.inboxMessage.count({
      where: { gateTaskId: { in: reviewIds }, status: InboxStatus.OPEN },
    });
    if (open > 0) return { reason: "conflict", message: "Decide the approval gate in the Inbox first" };
  }
  return { ids: tasks.filter((task) => task.archivedAt === null).map((task) => task.id) };
};

/**
 * The symmetric read for unarchive. Unarchiving cannot race a Run into
 * existence, but `archivedAt` is the other half of what makes a task live, so
 * restoring a TODO|DOING|REVIEW row *is* a reactivation and joins the same
 * protocol: Task row first, Agent row second, decided on the state this
 * transaction holds.
 *
 * Restoring DONE or BACKLOG history stays unconditional. Neither is claimed by
 * a runner or shown as work in progress, so an archived assignee cannot strand
 * them — and refusing them would make an agent's archival delete the operator's
 * ability to read their own history back onto the board.
 */
export const unarchiveSet = async (
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<ArchiveSet | Refusal> => {
  const locked = await lockTaskMutationRows(tx, taskId);
  if (!locked) return { reason: "not-found", message: "Task not found" };
  const taskIds = await chainMemberIds(tx, locked);
  const tasks = await tx.task.findMany({
    where: { id: { in: taskIds } },
    select: { id: true, status: true, archivedAt: true, projectId: true, assigneeAgentId: true },
  });
  const reactivating = tasks
    .filter((task) => task.archivedAt !== null && isLiveStatus(task.status))
    .sort((left, right) => (
      (left.assigneeAgentId ?? "").localeCompare(right.assigneeAgentId ?? "")
      || left.id.localeCompare(right.id)
    ));
  for (const task of reactivating) {
    const blocked = await reactivationBlocked(tx, task);
    if (blocked) return { reason: "conflict", message: blocked };
  }
  return { ids: tasks.filter((task) => task.archivedAt !== null).map((task) => task.id) };
};

/**
 * The project-wide sweep's set: every finished task the operator asked to clear
 * away, locked, minus the ones an active Run holds.
 *
 * Locking happens before the Runs are read, so a retry cannot slip a run in
 * between the selection and the write. Ids that vanished, moved out of `Done`
 * or were archived in between simply do not come back from the lock and count
 * as neither archived nor skipped.
 */
export const doneArchiveSet = async (
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<DoneArchiveSet> => {
  const candidates = await tx.task.findMany({
    where: { projectId, status: TaskStatus.DONE, archivedAt: null },
    select: { id: true, chainId: true },
  });
  const chainIds = [...new Set(candidates.flatMap((task) => task.chainId ? [task.chainId] : []))].sort();
  for (const chainId of chainIds) await lockChainRows(tx, { projectId, chainId });
  const standaloneIds = candidates.filter((task) => !task.chainId).map((task) => task.id);
  const lockedStandaloneIds = await lockDoneTasks(tx, projectId, standaloneIds);
  const chainedIds = candidates.filter((task) => task.chainId).map((task) => task.id);
  const stillDoneChained = chainedIds.length === 0 ? [] : await tx.task.findMany({
    where: { id: { in: chainedIds }, projectId, status: TaskStatus.DONE, archivedAt: null },
    select: { id: true },
  });
  const lockedIds = [...lockedStandaloneIds, ...stillDoneChained.map(({ id }) => id)];
  const { archive, skipped } = partitionArchivable(lockedIds, await activeRunTaskIds(tx, lockedIds));
  return { ids: archive, skipped };
};

/**
 * Closes the merge-tail stop notices the archived Tasks own.
 *
 * Stop notices are owned by the task archive lifecycle: an OPEN notice on an
 * archived Task is a question about work the operator has already put away.
 * The query is restricted to the Tasks this call actually archived, so
 * re-running an archive over historical rows cannot become a backfill.
 */
const closeStopNotices = async (
  tx: Prisma.TransactionClient,
  ids: string[],
  now: Date,
): Promise<void> => {
  const stopNotices = await tx.inboxMessage.findMany({
    where: {
      taskId: { in: ids },
      status: InboxStatus.OPEN,
      dedupeKey: { startsWith: STOP_NOTICE_DEDUPE_PREFIX },
    },
    select: { id: true, taskId: true },
    orderBy: [{ taskId: "asc" }, { id: "asc" }],
  });
  if (stopNotices.length === 0) return;
  const stopNoticeIds = stopNotices.map((notice) => notice.id);
  const closed = await tx.inboxMessage.updateMany({
    where: {
      id: { in: stopNoticeIds },
      taskId: { in: ids },
      status: InboxStatus.OPEN,
      dedupeKey: { startsWith: STOP_NOTICE_DEDUPE_PREFIX },
    },
    data: { status: InboxStatus.CLOSED, answeredAt: now },
  });
  if (closed.count !== stopNotices.length) {
    // Inbox close is a compare-and-set that does not take the Task mutex. A
    // concurrent operator close is already the desired final state; only an
    // initially selected notice that remains OPEN is an inconsistency worth
    // rolling the archive back for.
    const remainingOpen = await tx.inboxMessage.findMany({
      where: { id: { in: stopNoticeIds }, status: InboxStatus.OPEN },
      select: { id: true },
    });
    if (remainingOpen.length > 0) {
      throw new Error(
        `Archive found ${stopNotices.length} OPEN merge-tail stop notices but ${remainingOpen.length} remained OPEN`,
      );
    }
  }
  const closedByTask = new Map<string, string[]>();
  for (const notice of stopNotices) {
    if (notice.taskId === null) {
      throw new Error(`Merge-tail stop notice ${notice.id} has no task binding`);
    }
    const noticeIds = closedByTask.get(notice.taskId) ?? [];
    noticeIds.push(notice.id);
    closedByTask.set(notice.taskId, noticeIds);
  }
  await tx.taskActivity.createMany({ data: [...closedByTask].map(([closedTaskId, messageIds]) => ({
    taskId: closedTaskId,
    actorType: "control-plane",
    body: `Closed merge-tail stop notices: ${messageIds.join(", ")}`,
    metadata: { inboxMessageIds: messageIds },
  })) });
};

/** Archives a set the caller has already locked and decided on: the
 * `archivedAt` flip, one activity row per Task, and the stop-notice closure
 * that an archived Task's Inbox questions are entitled to. */
export const applyArchive = async (
  tx: Prisma.TransactionClient,
  ids: string[],
  now: Date,
): Promise<void> => {
  if (ids.length === 0) return;
  await tx.task.updateMany({ where: { id: { in: ids } }, data: { archivedAt: now } });
  await tx.taskActivity.createMany({ data: ids.map((taskId) => ({
    taskId, actorType: "operator", body: "Task archived",
  })) });
  await closeStopNotices(tx, ids, now);
};

/** The symmetric flip. Notices are not reopened: an archive answered them, and
 * the merge tail emits a fresh one if the state that raised them returns. */
export const applyUnarchive = async (
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<void> => {
  if (ids.length === 0) return;
  await tx.task.updateMany({ where: { id: { in: ids } }, data: { archivedAt: null } });
  await tx.taskActivity.createMany({ data: ids.map((taskId) => ({
    taskId, actorType: "operator", body: "Task unarchived",
  })) });
};
