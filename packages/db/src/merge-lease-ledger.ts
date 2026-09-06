import {
  MergeLeaseEventState,
  RunStatus,
  type MergeLeaseEvent,
  type Prisma,
} from "@prisma/client";

import { writeMarker } from "./merge-tail-markers.js";

type Tx = Prisma.TransactionClient;

export type MergeLeaseLedgerTarget = {
  projectId: string;
  chainId: string;
};

export type HandoffLeaseEvent = {
  eventId: string;
  target: MergeLeaseLedgerTarget;
  taskId: string;
  toRunId: string;
};

export type DeferredLeaseEvent = {
  eventId: string;
  target: MergeLeaseLedgerTarget;
  taskId: string;
};

const OPEN_STATES = [
  MergeLeaseEventState.HANDOFF_PENDING,
  MergeLeaseEventState.RELEASE_DEFERRED,
] as const;

const PAGE_LIMIT = 100;

const targetWhere = (target: MergeLeaseLedgerTarget) => ({
  projectId: target.projectId,
  chainId: target.chainId,
});

const writeOpenProjection = async (tx: Tx, event: MergeLeaseEvent): Promise<void> => {
  if (event.state === MergeLeaseEventState.HANDOFF_PENDING) {
    if (!event.handedOffRunId || !event.handedOffAt) {
      throw new Error(`Merge Lease handoff event ${event.id} has an invalid shape`);
    }
    await writeMarker(tx, event.owningTaskId, "leaseHandoff", {
      actorType: "control-plane",
      body: `Chain Lease handed to queued Run ${event.handedOffRunId}`,
      metadata: {
        ledgerId: event.id,
        state: "pending",
        chainId: event.chainId,
        toRunId: event.handedOffRunId,
        handedOffAt: event.handedOffAt.toISOString(),
      },
    });
    return;
  }
  if (event.state !== MergeLeaseEventState.RELEASE_DEFERRED || !event.deferredAt || !event.failureDetail) {
    throw new Error(`Merge Lease deferral event ${event.id} has an invalid shape`);
  }
  await writeMarker(tx, event.owningTaskId, "leaseRelease", {
    actorType: "control-plane",
    body: `Merge Lease release deferred for chain ${event.chainId}: ${event.failureDetail}`,
    metadata: {
      ledgerId: event.id,
      state: "release-deferred",
      projectId: event.projectId,
      chainId: event.chainId,
      taskId: event.owningTaskId,
      failureDetail: event.failureDetail,
      deferredAt: event.deferredAt.toISOString(),
    },
  });
};

const writeTerminalProjection = async (tx: Tx, event: MergeLeaseEvent): Promise<void> => {
  if (!event.settledAt) throw new Error(`Terminal Merge Lease event ${event.id} has no settlement time`);
  const state = event.state === MergeLeaseEventState.RELEASED ? "released" : "invalid";
  if (event.handedOffRunId) {
    await writeMarker(tx, event.owningTaskId, "leaseHandoff", {
      actorType: "control-plane",
      body: state === "released"
        ? `Queued Run ${event.handedOffRunId} did not consume its Chain Lease handoff`
        : `Invalid Chain Lease handoff for queued Run ${event.handedOffRunId}: ${event.failureDetail ?? "invalid target"}`,
      metadata: {
        ledgerId: event.id,
        state,
        chainId: event.chainId,
        toRunId: event.handedOffRunId,
        ...(state === "released"
          ? { releasedAt: event.settledAt.toISOString() }
          : { invalidAt: event.settledAt.toISOString(), reason: event.failureDetail ?? "invalid target" }),
      },
    });
    return;
  }
  if (event.deferredAt) {
    await writeMarker(tx, event.owningTaskId, "leaseRelease", {
      actorType: "control-plane",
      body: state === "released"
        ? `Deferred Merge Lease release completed for chain ${event.chainId}`
        : `Deferred Merge Lease release invalid for chain ${event.chainId}: ${event.failureDetail ?? "invalid target"}`,
      metadata: {
        ledgerId: event.id,
        state,
        projectId: event.projectId,
        chainId: event.chainId,
        taskId: event.owningTaskId,
        ...(state === "released"
          ? { releasedAt: event.settledAt.toISOString() }
          : { invalidAt: event.settledAt.toISOString(), reason: event.failureDetail ?? "invalid target" }),
      },
    });
  }
};

export const recordLeaseHandoff = async (
  tx: Tx,
  input: { target: MergeLeaseLedgerTarget; toRunId: string; at: Date },
): Promise<{ event: MergeLeaseEvent; recorded: boolean }> => {
  const run = await tx.run.findUnique({
    where: { id: input.toRunId },
    select: { projectId: true, taskId: true },
  });
  if (!run?.taskId) throw new Error(`Lease handoff target Run ${input.toRunId} has no Task`);
  if (run.projectId !== input.target.projectId) {
    throw new Error(`Lease handoff target Run ${input.toRunId} belongs to another project`);
  }
  const created = await tx.mergeLeaseEvent.createMany({
    data: [{
      ...input.target,
      state: MergeLeaseEventState.HANDOFF_PENDING,
      owningTaskId: run.taskId,
      handedOffRunId: input.toRunId,
      handedOffAt: input.at,
    }],
    skipDuplicates: true,
  });
  const event = await tx.mergeLeaseEvent.findUnique({
    where: { projectId_chainId_handedOffRunId: { ...input.target, handedOffRunId: input.toRunId } },
  });
  if (!event) {
    throw new Error(`Merge Lease ${input.target.chainId} already has another unresolved event`);
  }
  if (created.count === 1) await writeOpenProjection(tx, event);
  return { event, recorded: created.count === 1 };
};

export const recordLeaseDeferral = async (
  tx: Tx,
  input: { target: MergeLeaseLedgerTarget; taskId: string; failureDetail: string; at: Date },
): Promise<{ event: MergeLeaseEvent; recorded: boolean }> => {
  const task = await tx.task.findUnique({
    where: { id: input.taskId },
    select: { projectId: true, chainId: true },
  });
  if (!task || task.projectId !== input.target.projectId || task.chainId !== input.target.chainId) {
    throw new Error(`Cannot defer Merge Lease release for Task ${input.taskId}: target validation failed`);
  }
  const created = await tx.mergeLeaseEvent.createMany({
    data: [{
      ...input.target,
      state: MergeLeaseEventState.RELEASE_DEFERRED,
      owningTaskId: input.taskId,
      deferredAt: input.at,
      failureDetail: input.failureDetail,
    }],
    skipDuplicates: true,
  });
  const event = await tx.mergeLeaseEvent.findFirst({
    where: { ...targetWhere(input.target), state: { in: [...OPEN_STATES] } },
  });
  if (!event || event.state !== MergeLeaseEventState.RELEASE_DEFERRED || event.owningTaskId !== input.taskId) {
    throw new Error(`Merge Lease ${input.target.chainId} already has another unresolved event`);
  }
  if (created.count === 1) await writeOpenProjection(tx, event);
  return { event, recorded: created.count === 1 };
};

export type LeaseContentionHolder = {
  holder: string;
  task: string | null;
  reason: string | null;
  acquiredAt: Date | null;
};

/**
 * Record that a chain could not take the lease because somebody else held it.
 *
 * Unlike a handoff or a deferred release this is not an open lifecycle: the
 * chain never held this lease, so there is nothing to settle later. The row is
 * created settled, at the moment the contention was alerted, and carries the
 * holder that was in the way. `leaseSha` stays null so it can never collide
 * with the released event for that holder's own lease blob, which is also what
 * lets one chain record more than one contention episode.
 */
export const recordLeaseContention = async (
  tx: Tx,
  input: {
    target: MergeLeaseLedgerTarget;
    taskId: string;
    holder: LeaseContentionHolder | null;
    detail: string;
    at: Date;
  },
): Promise<MergeLeaseEvent> => {
  const task = await tx.task.findUnique({
    where: { id: input.taskId },
    select: { projectId: true, chainId: true },
  });
  if (!task || task.projectId !== input.target.projectId || task.chainId !== input.target.chainId) {
    throw new Error(`Cannot record Merge Lease contention for Task ${input.taskId}: target validation failed`);
  }
  return tx.mergeLeaseEvent.create({
    data: {
      ...input.target,
      state: MergeLeaseEventState.CONTENDED,
      owningTaskId: input.taskId,
      settledAt: input.at,
      failureDetail: input.detail,
      ...(input.holder?.acquiredAt ? { acquiredAt: input.holder.acquiredAt } : {}),
    },
  });
};

export function listUnresolvedLeaseEvents(
  tx: Tx,
  input: { kind: "handoff"; staleBefore: Date },
): Promise<HandoffLeaseEvent[]>;
export function listUnresolvedLeaseEvents(
  tx: Tx,
  input: { kind: "deferral"; staleBefore: Date },
): Promise<DeferredLeaseEvent[]>;
export async function listUnresolvedLeaseEvents(
  tx: Tx,
  input: { kind: "handoff" | "deferral"; staleBefore: Date },
): Promise<HandoffLeaseEvent[] | DeferredLeaseEvent[]> {
  if (input.kind === "handoff") {
    const events = await tx.mergeLeaseEvent.findMany({
      where: {
        state: MergeLeaseEventState.HANDOFF_PENDING,
        handedOffAt: { lt: input.staleBefore },
        handedOffRun: { is: {
          status: RunStatus.QUEUED,
          claimedAt: null,
          startedAt: null,
          createdAt: { lt: input.staleBefore },
          readyAt: { lt: input.staleBefore },
        } },
      },
      orderBy: [{ handedOffAt: "asc" }, { id: "asc" }],
      take: PAGE_LIMIT,
    });
    return events.map((event) => {
      if (!event.handedOffRunId) throw new Error(`Merge Lease handoff event ${event.id} has no Run`);
      return {
        eventId: event.id,
        target: { projectId: event.projectId, chainId: event.chainId },
        taskId: event.owningTaskId,
        toRunId: event.handedOffRunId,
      };
    });
  }
  const events = await tx.mergeLeaseEvent.findMany({
    where: {
      state: MergeLeaseEventState.RELEASE_DEFERRED,
      deferredAt: { lt: input.staleBefore },
    },
    orderBy: [{ deferredAt: "asc" }, { id: "asc" }],
    take: PAGE_LIMIT,
  });
  return events.map((event) => ({
    eventId: event.id,
    target: { projectId: event.projectId, chainId: event.chainId },
    taskId: event.owningTaskId,
  }));
}

export type LeaseSettlementEvidence = {
  ref: string;
  sha: string;
  acquiredAt: Date;
  heldForSeconds: number;
};

export type SettleLeaseEventInput = {
  eventId: string;
  state: "released" | "invalid";
  at: Date;
  failureDetail?: string;
  evidence?: LeaseSettlementEvidence;
  projectionTaskId?: string;
} | {
  target: MergeLeaseLedgerTarget;
  taskId: string;
  state: "released";
  at: Date;
  evidence: LeaseSettlementEvidence;
};

const terminalState = (state: SettleLeaseEventInput["state"]): MergeLeaseEventState => (
  state === "released" ? MergeLeaseEventState.RELEASED : MergeLeaseEventState.INVALID
);

const writeHoldProjection = async (
  tx: Tx,
  taskId: string,
  event: MergeLeaseEvent,
  evidence: LeaseSettlementEvidence,
): Promise<void> => {
  await writeMarker(tx, taskId, "leaseHold", {
    actorType: "control-plane",
    body: `Chain Lease released after ${evidence.heldForSeconds} seconds`,
    metadata: {
      ledgerId: event.id,
      chainId: event.chainId,
      leaseRef: evidence.ref,
      leaseSha: evidence.sha,
      acquiredAt: evidence.acquiredAt.toISOString(),
      releasedAt: event.settledAt?.toISOString(),
      heldForSeconds: evidence.heldForSeconds,
    },
  });
};

const settleById = async (
  tx: Tx,
  input: Extract<SettleLeaseEventInput, { eventId: string }>,
): Promise<{ event: MergeLeaseEvent; settled: boolean }> => {
  const state = terminalState(input.state);
  const settled = await tx.mergeLeaseEvent.updateMany({
    where: { id: input.eventId, state: { in: [...OPEN_STATES] } },
    data: {
      state,
      settledAt: input.at,
      ...(input.failureDetail === undefined ? {} : { failureDetail: input.failureDetail }),
      ...(input.evidence === undefined ? {} : {
        leaseRef: input.evidence.ref,
        leaseSha: input.evidence.sha,
        acquiredAt: input.evidence.acquiredAt,
      }),
    },
  });
  const event = await tx.mergeLeaseEvent.findUniqueOrThrow({ where: { id: input.eventId } });
  if (settled.count === 0 && event.state !== state) {
    throw new Error(`Merge Lease event ${event.id} is already ${event.state}`);
  }
  if (settled.count === 1) {
    await writeTerminalProjection(tx, event);
    if (input.evidence) {
      await writeHoldProjection(tx, input.projectionTaskId ?? event.owningTaskId, event, input.evidence);
    }
  }
  return { event, settled: settled.count === 1 };
};

export const settleLeaseEvent = async (
  tx: Tx,
  input: SettleLeaseEventInput,
): Promise<{ event: MergeLeaseEvent; settled: boolean }> => {
  if ("eventId" in input) return settleById(tx, input);
  const replay = await tx.mergeLeaseEvent.findUnique({
    where: { projectId_chainId_leaseSha: { ...input.target, leaseSha: input.evidence.sha } },
  });
  if (replay) return { event: replay, settled: false };

  const open = await tx.mergeLeaseEvent.findFirst({
    where: { ...targetWhere(input.target), state: { in: [...OPEN_STATES] } },
  });
  if (open) {
    return settleById(tx, {
      eventId: open.id,
      state: "released",
      at: input.at,
      evidence: input.evidence,
      projectionTaskId: input.taskId,
    });
  }

  const created = await tx.mergeLeaseEvent.createMany({
    data: [{
      ...input.target,
      state: MergeLeaseEventState.RELEASED,
      owningTaskId: input.taskId,
      settledAt: input.at,
      leaseRef: input.evidence.ref,
      leaseSha: input.evidence.sha,
      acquiredAt: input.evidence.acquiredAt,
    }],
    skipDuplicates: true,
  });
  const event = await tx.mergeLeaseEvent.findUniqueOrThrow({
    where: { projectId_chainId_leaseSha: { ...input.target, leaseSha: input.evidence.sha } },
  });
  if (created.count === 1) await writeHoldProjection(tx, input.taskId, event, input.evidence);
  return { event, settled: created.count === 1 };
};
