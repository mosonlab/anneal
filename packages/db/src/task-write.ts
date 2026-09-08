import {
  AssigneeType,
  Prisma,
  type Task,
  TaskStatus,
} from "@prisma/client";

import { ACTIVE_RUN_STATUSES } from "./board-contract.js";
import { LIVE_TASK_STATUSES } from "./chain-activation.js";
import { lockAgentRow, lockChainRows } from "./locks.js";
import { compoundImplementationAssigneeValid, CompoundImplementationAssigneeError, isCompoundImplementationStep } from "./run-open.js";

export type LockedTask = {
  id: string;
  status: TaskStatus;
  archivedAt: Date | null;
  projectId: string;
  chainId: string | null;
  approvalGate: boolean;
  dispatchAfterTaskId: string | null;
  dispatchAfter: { name: string; status: TaskStatus } | null;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  /** Read under the lock so a budget-change activity states the value the write
   *  actually replaced, not one a concurrent patch has already moved. The spend
   *  cap is read for the same reason and is not optional: a missing select must
   *  fail the typecheck rather than degrade a cap edit's trail to "none". */
  maxSessionsPerTask: number;
  spendCap: Prisma.Decimal | null;
  templateStep: {
    stepIndex: number;
    outputKind: string;
    taskTemplate: { name: string };
  } | null;
};

export const lockedTaskSelect = {
  id: true,
  status: true,
  archivedAt: true,
  projectId: true,
  chainId: true,
  approvalGate: true,
  maxSessionsPerTask: true,
  spendCap: true,
  dispatchAfterTaskId: true,
  dispatchAfter: { select: { name: true, status: true } },
  assigneeType: true,
  assigneeAgentId: true,
  templateStep: {
    select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
  },
} satisfies Prisma.TaskSelect;

/**
 * The exclusion protocol every writer that can give a task a run shares.
 *
 * Start, retry, archive, archive-done and the AT fire all answer "may this task
 * gain a run right now?" in different transactions. Reading `runs` and then
 * writing is not atomic under ReadCommitted: PostgreSQL re-checks a predicate on
 * the *locked row* after a blocking write commits, but a subquery over another
 * table is re-evaluated against the statement's original snapshot. So the Task
 * row is the mutex — every writer takes it before it reads anything else.
 *
 * `fireCronTask` is already compliant: its claim is a single-statement CAS on
 * the Task row, whose predicate does get re-checked.
 */
export const lockTask = async (tx: Prisma.TransactionClient, taskId: string): Promise<LockedTask | null> => {
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
  `;
  if (!locked) return null;
  // Read the typed row only after the lock is held. $queryRaw hands back raw
  // PostgreSQL enum labels ('backlog'), not Prisma's member names, so comparing
  // its status against TaskStatus.BACKLOG silently never matches — and the lock
  // is exactly what makes this second read consistent for the rest of the
  // transaction.
  return tx.task.findUniqueOrThrow({
    where: { id: taskId },
    select: lockedTaskSelect,
  });
};

/**
 * The mutation entry point for a task whose chain identity is not already
 * known under a lock. Chain identity itself is immutable after dispatch, so an
 * unlocked identity read can safely choose the mutex without first taking one
 * Task row and later expanding to its siblings.
 */
export const lockTaskMutationRows = async (
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<LockedTask | null> => {
  const identity = await tx.task.findUnique({
    where: { id: taskId },
    select: { projectId: true, chainId: true },
  });
  if (!identity) return null;
  if (!identity.chainId) return lockTask(tx, taskId);
  await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });
  return tx.task.findUnique({ where: { id: taskId }, select: lockedTaskSelect });
};

/**
 * The assignment half of the Agent-row exclusion protocol: the 400 message if
 * this agent may not be written onto a task right now, or null.
 *
 * Callers check the assignee once before the transaction to answer fast; this
 * re-read under `lockAgentRow` is the one that decides. Without it the check
 * and the write straddle a concurrent archive, and the task — or the run
 * created with it — belongs to an agent the runner will never claim for.
 */
const assignmentBlocked = async (
  tx: Prisma.TransactionClient,
  assignee: { id: string; name: string } | null,
): Promise<string | null> => {
  if (!assignee) return null;
  const locked = await lockAgentRow(tx, assignee.id);
  if (!locked) return "Assignee does not belong to this project";
  return locked.archivedAt ? `Assignee ${assignee.name} is archived` : null;
};

/** Rechecks the compound binding after the Task lock and under the Agent lock.
 * The unlocked route check gives a fast refusal; this one decides against
 * concurrent archive or persisted-state corruption before the write commits. */
const assertCompoundImplementationAssignment = async (
  tx: Prisma.TransactionClient,
  task: LockedTask,
  assigneeType: AssigneeType,
  assigneeAgentId: string | null,
): Promise<void> => {
  if (task.archivedAt !== null || !isCompoundImplementationStep(task.templateStep)) return;
  const agent = assigneeAgentId ? await lockAgentRow(tx, assigneeAgentId) : null;
  if (!compoundImplementationAssigneeValid(task.projectId, assigneeType, agent, task.templateStep)) {
    throw new CompoundImplementationAssigneeError();
  }
};

/**
 * §R5. The assignment freeze: a task whose work is already in flight may not
 * change hands.
 *
 * A Run snapshots the Agent it opened with — runner, model, service tier,
 * prompt and tool grants — so moving the assignee out from under a live Run
 * leaves a Run executing as one Agent while the board, the cost attribution and
 * every later retry read another. The guard is per *task*, not per chain: a
 * sibling step's Run says nothing about this one.
 *
 * `ACTIVE_RUN_STATUSES` is the same set the claim query and `startable` read,
 * so QUEUED and WAITING_INBOX count — a queued Run is already promised to its
 * Agent, and one waiting on an inbox answer will resume into its snapshot.
 * Terminal Runs are history and freeze nothing, which is what keeps "retry
 * after a failure with a different agent" working.
 *
 * Called with the Task rows already locked and before the Agent row is taken,
 * which keeps the one global lock order and makes the Run read decide at the
 * same serialization point as run creation: `reconcile` and `openRun` take this
 * same Task row, so one of the two observes the other's committed effect.
 *
 * The comparison is against the *locked* row, so a request that restates the
 * assignment a task already has is not a change and is not refused.
 */
const reassignmentBlocked = async (
  tx: Prisma.TransactionClient,
  locked: LockedTask,
  assigneeType: AssigneeType | undefined,
  assigneeAgentId: string | null | undefined,
): Promise<string | null> => {
  const nextType = assigneeType ?? locked.assigneeType;
  const nextAgentId = assigneeAgentId === undefined ? locked.assigneeAgentId : assigneeAgentId;
  if (nextType === locked.assigneeType && nextAgentId === locked.assigneeAgentId) return null;
  const active = await tx.run.findFirst({
    where: { taskId: locked.id, status: { in: ACTIVE_RUN_STATUSES } },
    orderBy: [{ runNumber: "desc" }, { id: "desc" }],
    select: { runNumber: true, status: true },
  });
  if (!active) return null;
  return `Cannot change the assignee while run ${active.runNumber} is ${active.status}; stop or finish it first`;
};

export type TaskWriteRefusal =
  | { kind: "absent" }
  | { kind: "assignment-blocked"; reason: string }
  /** §R5. The task is executing right now, so its assignment is frozen. A
   *  conflict, not a bad request: the same write is accepted once the Run ends. */
  | { kind: "assignment-active-run"; reason: string };

/** The activity the write is accountable for. `taskId` is the module's to fill:
 *  it is the row the lock was taken on, not something a caller restates. */
export type TaskActivityInput = Omit<Prisma.TaskActivityUncheckedCreateInput, "taskId">;

/**
 * What the caller wants the locked task to become. `update: null` is a caller
 * that decided, under the lock, not to write — the transaction still commits
 * whatever it did before, exactly as an early `return` from its callback did.
 */
export type TaskWritePlan<T> = {
  update: Prisma.TaskUncheckedUpdateInput | null;
  activity: TaskActivityInput | null;
  value: T;
};

export type TaskWriteResult<T> =
  | {
    ok: true;
    /** The row as it was under the lock, before the update. */
    task: LockedTask;
    /** The updated row, or null when the plan wrote nothing. */
    written: Task | null;
    /** The id of the activity the plan asked for, for callers that reference it. */
    activityId: string | null;
    /**
     * The lock this write took covers a whole chain, not one row. A candidate
     * scan must end its transaction here: taking another candidate's Run next
     * could wait on a sibling Run whose claimant already waits for this chain
     * mutex.
     */
    chainLocked: boolean;
    value: T;
  }
  | { ok: false; refusal: TaskWriteRefusal };

/** Prisma accepts both `field: value` and `field: { set: value }`; the guards
 *  below read the intent out of either shape. */
const plannedScalar = <V>(value: unknown): V | undefined => {
  if (value === undefined) return undefined;
  if (value !== null && typeof value === "object" && "set" in (value as object)) {
    return (value as { set: V }).set;
  }
  return value as V;
};

/**
 * The one way to write a task under its own mutex.
 *
 * It owns the three rules a caller used to restate: the lock is taken here and
 * everything the caller does happens inside the same transaction; the Agent row
 * is locked after the Task rows, never before; and a chained write expands the
 * lock to the whole chain, which `chainLocked` reports rather than leaving each
 * caller to rediscover from `chainId`.
 *
 * `change` computes the write, it does not perform one. The assignment guards
 * decide from the update it returns, so a callback that wrote first would have
 * its writes committed by a refusal that is supposed to leave the row alone.
 */
export const writeTask = async <T>(
  tx: Prisma.TransactionClient,
  taskId: string,
  change: (locked: LockedTask) => Promise<TaskWritePlan<T>>,
  options?: { lockScope: "task" },
): Promise<TaskWriteResult<T>> => {
  // Run-birth settlement may already own one Task and its Agent. Expanding
  // to sibling Tasks here would invert their lock order. Its status-only park
  // retains the birth's Task mutex; ordinary mutations keep the full Chain.
  const locked = options?.lockScope === "task"
    ? await lockTask(tx, taskId) : await lockTaskMutationRows(tx, taskId);
  if (!locked) return { ok: false, refusal: { kind: "absent" } };
  const plan = await change(locked);
  if (options?.lockScope === "task" && plan.update
    && Object.keys(plan.update).some((key) => !["status", "failureReason", "runAt"].includes(key))) {
    throw new Error("Task-only writes are restricted to refusal parking fields");
  }
  if (plan.update) {
    const assigneeType = plannedScalar<AssigneeType>(plan.update.assigneeType);
    const assigneeAgentId = plannedScalar<string | null>(plan.update.assigneeAgentId);
    // Task rows first, then the Agent row — the one global lock order.
    if (assigneeType !== undefined || assigneeAgentId !== undefined) {
      const activeRunReason = await reassignmentBlocked(tx, locked, assigneeType, assigneeAgentId);
      if (activeRunReason) {
        return { ok: false, refusal: { kind: "assignment-active-run", reason: activeRunReason } };
      }
      await assertCompoundImplementationAssignment(
        tx,
        locked,
        assigneeType ?? locked.assigneeType,
        assigneeAgentId === undefined ? locked.assigneeAgentId : assigneeAgentId,
      );
      // The named assignee is re-read against the locked task's project, so the
      // project check and the archive check decide on the same row the write
      // lands on rather than on a pre-transaction read.
      const assignee = assigneeAgentId
        ? await tx.agent.findFirst({
          where: { id: assigneeAgentId, projectId: locked.projectId },
          select: { id: true, name: true },
        })
        : null;
      if (assigneeAgentId && !assignee) {
        return { ok: false, refusal: { kind: "assignment-blocked", reason: "Assignee does not belong to this project" } };
      }
      const reason = await assignmentBlocked(tx, assignee);
      if (reason) return { ok: false, refusal: { kind: "assignment-blocked", reason } };
    }
  }
  const written = plan.update
    ? await tx.task.update({ where: { id: taskId }, data: plan.update })
    : null;
  const activity = plan.activity
    ? await tx.taskActivity.create({ data: { taskId, ...plan.activity } })
    : null;
  return {
    ok: true,
    task: locked,
    written,
    activityId: activity?.id ?? null,
    chainLocked: options?.lockScope !== "task" && locked.chainId !== null,
    value: plan.value,
  };
};

/** Live means exactly what blocks an agent's archival: the same
 *  `LIVE_TASK_STATUSES` `agentArchiveBlocker` reads, so the two halves of the
 *  protocol cannot drift into disagreeing about which tasks count. Everything
 *  else — DONE and BACKLOG — is history or a parking bay, which is why moving
 *  out of it is the moment the assignee has to be re-validated. */
export const isLiveStatus = (status: TaskStatus): boolean => LIVE_TASK_STATUSES.includes(status);

export const hasActiveRun = async (tx: Prisma.TransactionClient, taskId: string): Promise<boolean> => (
  await tx.run.count({ where: { taskId, status: { in: ACTIVE_RUN_STATUSES } } })
) > 0;

/**
 * The reactivation half of the same protocol: the message if this *stored*
 * assignee may not own a live task right now, or null.
 *
 * `assignmentBlocked` only ever sees an assignee the request named, so a
 * request that carries no `assigneeAgentId` — a status-only promotion out of
 * Backlog, an unarchive — used to skip the Agent row entirely and hand a live
 * task back to an archived agent. The runner claims only unarchived TODO|DOING
 * tasks whose agent is unarchived, so that task is not "assigned": it is stuck,
 * on a board that shows it as work in progress.
 *
 * Called with the Task row already locked, so the order stays the one global
 * order: Task row first, Agent row second. The name is read outside the Agent
 * lock because it only decorates the message; `lockAgentRow` is what decides.
 */
export const reactivationBlocked = async (
  tx: Prisma.TransactionClient,
  task: { projectId: string; assigneeAgentId: string | null },
): Promise<string | null> => {
  // A human step or an unassigned one has no agent to be archived, so it
  // reactivates exactly as it did before this guard existed.
  if (task.assigneeAgentId === null) return null;
  const assignee = await tx.agent.findFirst({
    where: { id: task.assigneeAgentId, projectId: task.projectId },
    select: { id: true, name: true },
  });
  if (!assignee) return "Assignee does not belong to this project";
  const locked = await lockAgentRow(tx, assignee.id);
  if (!locked) return "Assignee does not belong to this project";
  // The sentence names the two ways out, because the operator who pressed this
  // did not name the assignee in the request and cannot see it in the error.
  return locked.archivedAt
    ? `Assignee ${assignee.name} is archived; unarchive the agent or reassign this task first`
    : null;
};
