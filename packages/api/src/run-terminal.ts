import {
  CleanupStatus,
  FailureClass,
  InboxStatus,
  lockRunRow,
  Prisma,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
} from "@anneal/db";

import { jsonValue } from "./execution.js";
import type { LeaseOutcome } from "./merge-lease.js";
import type { Refusal } from "./refusal.js";
import { activeRunStatuses } from "./run-fence.js";
import { lockTaskMutationRows } from "./task-write.js";

type CancelledOutcome = {
  kind: "cancelled";
  requestId: string;
  runnerId?: string;
  fencingToken?: string;
  actorId?: string;
  cleanupConfirmed: boolean;
  workspacePath?: string;
  branch?: string;
  baseSha?: string;
  worktreeContainmentViolations?: string[];
  activity: "acknowledged" | "runner-lost";
  reason?: string;
};

type LostOutcome = {
  kind: "lost";
  where: Prisma.RunWhereInput;
  reason: string;
  maxRunsPerTask: number;
  budgetGrants: number;
};

type TimedOutOutcome = {
  kind: "timed-out";
  sessionId: string | null;
  waitingOnMessageId: string | null;
  taskId: string | null;
  reason: string;
};

type CompletedOutcome = {
  kind: "completed";
  where: Prisma.RunWhereInput;
  status: typeof RunStatus.SUCCEEDED | typeof RunStatus.FAILED | typeof RunStatus.TIMED_OUT;
  run: Omit<Prisma.RunUpdateManyMutationInput, "status" | "endedAt" | "leaseExpiresAt" | "sessionTokenRevokedAt">;
  sessionId: string;
  session: Omit<Prisma.SessionUpdateManyMutationInput, "executionStatus" | "endedAt" | "cleanupEndedAt">;
};

export type TerminalOutcome =
  | CancelledOutcome
  | LostOutcome
  | TimedOutOutcome
  | CompletedOutcome;

export type TerminalResult = {
  runId: string;
  taskId: string | null;
  status: RunStatus;
  leaseOutcome: LeaseOutcome;
  cancellationState?: "acknowledged";
  requestId?: string;
};

export type TerminalFieldSet = {
  run: Prisma.RunUpdateManyMutationInput;
  session: Prisma.SessionUpdateManyMutationInput;
};

const refused = (reason: "not-found" | "conflict", message: string): Refusal => ({ reason, message });

/** The terminal field family is derived here once. Callers supply evidence and
 * policy inputs; they do not assemble partial Run and Session mirrors. */
export const terminalFieldsFor = (outcome: TerminalOutcome, at: Date): TerminalFieldSet => {
  switch (outcome.kind) {
    case "cancelled": {
      const reason = outcome.reason ?? "Cancelled by operator";
      return {
        run: {
          status: RunStatus.CANCELLED,
          endedAt: at,
          leaseExpiresAt: null,
          sessionTokenRevokedAt: at,
          ...(outcome.cleanupConfirmed ? { cancelAcknowledgedAt: at } : {}),
          failureClass: FailureClass.CANCELLED_OR_TIMED_OUT,
          failureReason: reason,
          terminationReason: reason,
          retryable: false,
          retryAt: null,
          workspaceRetained: true,
          ...(outcome.workspacePath === undefined ? {} : { workspacePath: outcome.workspacePath }),
          ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
          ...(outcome.baseSha === undefined ? {} : { baseSha: outcome.baseSha }),
          ...(outcome.worktreeContainmentViolations?.length
            ? { worktreeContainmentViolations: jsonValue(outcome.worktreeContainmentViolations) }
            : {}),
        },
        session: {
          executionStatus: SessionExecutionStatus.CANCELLED,
          cleanupStatus: CleanupStatus.RETAINED,
          endedAt: at,
          cleanupEndedAt: at,
          failureReason: reason,
          terminationReason: reason,
        },
      };
    }
    case "lost":
      return {
        run: {
          status: RunStatus.LOST,
          endedAt: at,
          leaseExpiresAt: null,
          sessionTokenRevokedAt: at,
          failureClass: FailureClass.CANCELLED_OR_TIMED_OUT,
          retryable: true,
          maxRunsPerTask: outcome.maxRunsPerTask,
          budgetGrants: outcome.budgetGrants,
          failureReason: outcome.reason,
        },
        session: {
          executionStatus: SessionExecutionStatus.LOST,
          cleanupStatus: CleanupStatus.PENDING,
          endedAt: at,
          failureReason: outcome.reason,
        },
      };
    case "timed-out":
      return {
        run: {
          status: RunStatus.TIMED_OUT,
          endedAt: at,
          retryable: false,
          failureClass: FailureClass.CANCELLED_OR_TIMED_OUT,
          failureReason: outcome.reason,
        },
        session: {
          executionStatus: SessionExecutionStatus.TIMED_OUT,
          cleanupStatus: CleanupStatus.RETAINED,
          endedAt: at,
          cleanupEndedAt: at,
          failureReason: outcome.reason,
        },
      };
    case "completed":
      return {
        run: {
          status: outcome.status,
          endedAt: at,
          leaseExpiresAt: null,
          sessionTokenRevokedAt: at,
          ...outcome.run,
        },
        session: {
          executionStatus: outcome.status === RunStatus.SUCCEEDED
            ? SessionExecutionStatus.SUCCEEDED
            : outcome.status === RunStatus.TIMED_OUT
              ? SessionExecutionStatus.TIMED_OUT
              : SessionExecutionStatus.FAILED,
          endedAt: at,
          cleanupEndedAt: at,
          ...outcome.session,
        },
      };
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
};

const cancelledReason = (cancelReason: string | null): string => cancelReason ?? "Cancelled by operator";

/** Terminalize a Run and its Session as one operation. The outcome union owns
 * the terminal field matrix; cancellation and Inbox timeout also keep their
 * Task, Inbox, activity, and Lease mirrors inside this module. */
export const terminalizeRun = async (
  tx: Prisma.TransactionClient,
  input: { runId: string; outcome: TerminalOutcome; at: Date },
): Promise<TerminalResult | Refusal | null> => {
  if (input.outcome.kind === "cancelled") {
    await lockRunRow(tx, input.runId);
    const run = await tx.run.findUnique({
      where: { id: input.runId },
      select: {
        id: true, taskId: true, runNumber: true, status: true, runnerId: true, fencingToken: true,
        cancelRequestId: true, cancelReason: true, cancelAcknowledgedAt: true,
        worktreeContainmentViolations: true,
        session: { select: { waitingOnMessageId: true } },
      },
    });
    if (!run) return refused("not-found", "Run not found");
    if (run.cancelRequestId !== input.outcome.requestId) {
      return refused("conflict", "Cancellation request does not match this Run");
    }
    if (input.outcome.runnerId !== undefined
      && (run.runnerId !== input.outcome.runnerId || run.fencingToken !== input.outcome.fencingToken)) {
      return refused("conflict", "Cancellation acknowledgement is not owned by this runner");
    }
    if (run.status === RunStatus.CANCELLED) {
      if (input.outcome.workspacePath !== undefined) await tx.run.updateMany({
        where: { id: run.id, workspacePath: null }, data: { workspacePath: input.outcome.workspacePath },
      });
      if (input.outcome.branch !== undefined) await tx.run.updateMany({
        where: { id: run.id, branch: null }, data: { branch: input.outcome.branch },
      });
      if (input.outcome.baseSha !== undefined) await tx.run.updateMany({
        where: { id: run.id, baseSha: null }, data: { baseSha: input.outcome.baseSha },
      });
      if (input.outcome.worktreeContainmentViolations?.length && run.worktreeContainmentViolations === null) {
        await tx.run.update({
          where: { id: run.id },
          data: { worktreeContainmentViolations: jsonValue(input.outcome.worktreeContainmentViolations) },
        });
      }
      if (!run.cancelAcknowledgedAt && input.outcome.cleanupConfirmed) {
        await tx.run.update({ where: { id: run.id }, data: { cancelAcknowledgedAt: input.at } });
        if (run.taskId) await tx.taskActivity.create({ data: {
          taskId: run.taskId,
          actorType: "runner",
          actorId: input.outcome.actorId ?? null,
          body: `Run ${run.runNumber} cancellation cleanup confirmed after terminalization`,
          metadata: { runId: run.id, requestId: input.outcome.requestId, status: RunStatus.CANCELLED },
        } });
      } else if (!run.cancelAcknowledgedAt) {
        return refused("conflict", "Cancellation cleanup has not been acknowledged by the runner");
      }
      return {
        runId: run.id,
        taskId: run.taskId,
        status: run.status,
        cancellationState: "acknowledged",
        requestId: input.outcome.requestId,
        leaseOutcome: { kind: "continue" },
      };
    }
    if (run.taskId) await lockTaskMutationRows(tx, run.taskId);
    const outcome = { ...input.outcome, reason: cancelledReason(run.cancelReason) };
    const fields = terminalFieldsFor(outcome, input.at);
    const settled = await tx.run.updateMany({
      where: {
        id: run.id,
        cancelRequestId: input.outcome.requestId,
        status: { in: [RunStatus.QUEUED, ...activeRunStatuses] },
        ...(input.outcome.runnerId === undefined
          ? {}
          : { runnerId: input.outcome.runnerId, fencingToken: input.outcome.fencingToken }),
      },
      data: fields.run,
    });
    if (settled.count !== 1) return refused("conflict", `Run is already ${run.status}`);
    await tx.session.updateMany({ where: { runId: run.id }, data: fields.session });
    if (run.session?.waitingOnMessageId) {
      await tx.inboxMessage.updateMany({
        where: { id: run.session.waitingOnMessageId, status: InboxStatus.OPEN },
        data: { status: InboxStatus.CLOSED },
      });
    }
    if (run.taskId) {
      const reason = cancelledReason(run.cancelReason);
      await tx.task.updateMany({
        where: { id: run.taskId, status: { in: [TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW] } },
        data: { status: TaskStatus.REVIEW, failureReason: reason },
      });
      await tx.taskActivity.create({ data: {
        taskId: run.taskId,
        actorType: input.outcome.actorId ? "runner" : "control-plane",
        actorId: input.outcome.actorId ?? null,
        body: input.outcome.activity === "runner-lost"
          ? `Run ${run.runNumber} cancellation terminalized after runner loss; process cleanup unconfirmed`
          : `Run ${run.runNumber} cancellation acknowledged; execution authority revoked and evidence retained`,
        metadata: input.outcome.activity === "runner-lost"
          ? {
              runId: run.id,
              requestId: input.outcome.requestId,
              status: RunStatus.CANCELLED,
              cleanupConfirmed: false,
            }
          : { runId: run.id, requestId: input.outcome.requestId, status: RunStatus.CANCELLED },
      } });
    }
    return {
      runId: run.id,
      taskId: run.taskId,
      status: RunStatus.CANCELLED,
      cancellationState: "acknowledged",
      requestId: input.outcome.requestId,
      leaseOutcome: { kind: "stop", taskId: run.taskId },
    };
  }

  const fields = terminalFieldsFor(input.outcome, input.at);
  const where = input.outcome.kind === "completed" || input.outcome.kind === "lost"
    ? input.outcome.where
    : input.outcome.kind === "timed-out"
      ? { id: input.runId, status: RunStatus.WAITING_INBOX }
      : { id: input.runId, status: RunStatus.CLAIMED, startedAt: null };
  const closed = await tx.run.updateMany({ where, data: fields.run });
  if (closed.count !== 1) return null;
  const sessionWhere = input.outcome.kind === "completed"
    ? { id: input.outcome.sessionId }
    : input.outcome.kind === "timed-out" && input.outcome.sessionId
      ? { id: input.outcome.sessionId, executionStatus: SessionExecutionStatus.WAITING_INBOX }
      : { runId: input.runId };
  if (input.outcome.kind === "completed") {
    await tx.session.update({ where: sessionWhere, data: fields.session });
  } else {
    await tx.session.updateMany({ where: sessionWhere, data: fields.session });
  }

  if (input.outcome.kind !== "timed-out") {
    return { runId: input.runId, taskId: null, status: fields.run.status as RunStatus, leaseOutcome: { kind: "continue" } };
  }
  if (input.outcome.waitingOnMessageId) {
    await tx.inboxMessage.updateMany({
      where: { id: input.outcome.waitingOnMessageId, status: InboxStatus.OPEN },
      data: { status: InboxStatus.CLOSED },
    });
  }
  if (input.outcome.taskId) {
    await tx.task.update({
      where: { id: input.outcome.taskId },
      data: { status: TaskStatus.REVIEW, failureReason: input.outcome.reason },
    });
    await tx.taskActivity.create({ data: {
      taskId: input.outcome.taskId,
      actorType: "control-plane",
      body: "Inbox response window expired; run moved to review",
    } });
  }
  return {
    runId: input.runId,
    taskId: input.outcome.taskId,
    status: RunStatus.TIMED_OUT,
    leaseOutcome: { kind: "continue" },
  };
};
