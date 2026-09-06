import {
  AssigneeType,
  InboxStatus,
  MergeRecoveryRefusalCode,
  MergeRecoveryStatus,
  Prisma,
  TaskStatus,
} from "@prisma/client";

import { ACTIVE_RUN_STATUSES } from "./board-contract.js";
import { readChainControl } from "./chain-control.js";
import { heldPredicate } from "./chain-hold.js";
import { compare, layerOf } from "./chain-order.js";
import { lockAgentRepoGrant, lockChainRows } from "./locks.js";
import { parseAuthorizationMetadata } from "./merge-integrator.js";
import { stopStateFor } from "./merge-integrator-db.js";
import {
  carryMergeRecoveryRun,
  isMergeReadinessStep,
  isRegressionVerificationOutputKind,
  MERGE_TAIL_KIND,
  transitionMergeRecovery,
} from "./merge-tail.js";
import {
  attemptRunBirth,
  CompoundImplementationAssigneeError,
  errorForOpenRunRefusal,
  isWorkflowRefusalError,
  type IntegratorStopBypass,
  WorkflowRefusalError,
  enqueueTaskRunInternal,
  gateQuestion,
  isCompoundImplementationStep,
} from "./run-open.js";

type Tx = Prisma.TransactionClient;


type ChainTask = {
  id: string;
  projectId: string;
  name: string;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer?: number | null;
};

type ChainSuccessor = Prisma.TaskGetPayload<{ include: { runs: true; assigneeAgent: true } }>;
// ChainSuccessor.runs is always fetched filtered to ACTIVE_RUN_STATUSES: it exists
// only to answer "is any run still alive?" for the guards below.

export { ACTIVE_RUN_STATUSES } from "./board-contract.js";

/**
 * "This task is a live reference to its assignee." Every status here is one the
 * control plane can still turn into a run without an operator reassigning the
 * task: TODO covers a queued step, a scheduled definition and a parked future
 * chain step; DOING covers the step currently executing; REVIEW covers a step
 * whose approval gate can still be rejected, which queues the producing step
 * again. DONE is terminal history and BACKLOG is where an operator explicitly
 * parks work, so neither blocks.
 */
export const LIVE_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.TODO,
  TaskStatus.DOING,
  TaskStatus.REVIEW,
];

/**
 * Why this agent may not be archived right now, or null.
 *
 * Read under `lockAgentRow`, so it is the fail-closed half of the protocol: a
 * writer that already created a live reference holds the lock until it commits,
 * and archive then sees that reference instead of stranding it. Runs come first
 * because a queued run for an archived agent is exactly the row nothing ever
 * claims; a live task is the same stall one step earlier — nothing has enqueued
 * its run yet, so no run exists to be found, and archiving now strands the task
 * the moment anything tries to.
 *
 * Archived history is untouched — DONE tasks, BACKLOG tasks and terminal runs
 * never block, so retiring an agent whose work is finished or explicitly parked
 * stays a one-click operation.
 */
export const agentArchiveBlocker = async (tx: Tx, agentId: string): Promise<string | null> => {
  const run = await tx.run.findFirst({
    where: { agentId, status: { in: ACTIVE_RUN_STATUSES } },
    orderBy: { runNumber: "asc" },
    select: { runNumber: true, status: true, task: { select: { name: true } } },
  });
  if (run) {
    const where = run.task ? ` on ${run.task.name}` : "";
    return `Cannot archive an agent with a ${run.status} run${where}; finish or cancel run ${run.runNumber} first`;
  }
  const task = await tx.task.findFirst({
    where: { assigneeAgentId: agentId, archivedAt: null, status: { in: LIVE_TASK_STATUSES } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { name: true, status: true },
  });
  // The status is named because the four exits differ by it, and the operator
  // has to pick one: an executing task is finished or cancelled, a queued one is
  // parked in Backlog or archived, a reviewed one is decided, and any of them
  // can instead be handed to another agent.
  if (task) {
    return `Cannot archive an agent assigned to ${task.status} task ${task.name}; finish, park, archive, or reassign that task first`;
  }
  return null;
};

type BoundDispatchMetadata = {
  predecessorTaskId: string;
  predecessorChainId: string;
  successorTaskId: string;
  successorChainId: string;
};

const boundDispatchMetadata = (
  predecessor: ChainTask,
  successor: ChainTask,
): BoundDispatchMetadata => ({
  predecessorTaskId: predecessor.id,
  predecessorChainId: predecessor.chainId!,
  successorTaskId: successor.id,
  successorChainId: successor.chainId!,
});

/**
 * Records the two sides of a binding decision together. The pointer remains
 * on the successor task forever; these rows are the durable audit trail for
 * both a successful dispatch and a fail-closed refusal.
 */
const boundDispatchActivities = async (
  tx: Tx,
  predecessor: ChainTask,
  successor: ChainTask,
  input: {
    successorBody: string;
    predecessorBody: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> => {
  const metadata = {
    ...boundDispatchMetadata(predecessor, successor),
    ...input.metadata,
  };
  await tx.taskActivity.create({
    data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: input.successorBody,
      metadata,
    },
  });
  await tx.taskActivity.create({
    data: {
      taskId: predecessor.id,
      actorType: "control-plane",
      body: input.predecessorBody,
      metadata,
    },
  });
};

const parkBoundSuccessor = async (
  tx: Tx,
  predecessor: ChainTask,
  successor: ChainSuccessor,
  reason: string,
  metadata: Record<string, unknown> = {},
): Promise<void> => {
  await tx.task.update({
    where: { id: successor.id },
    data: { status: TaskStatus.REVIEW, failureReason: reason },
  });
  await boundDispatchActivities(tx, predecessor, successor, {
    successorBody: `Bound predecessor completed; successor parked in REVIEW: ${reason}`,
    predecessorBody: `Bound chain dispatch refused; successor parked in REVIEW: ${reason}`,
    metadata: { state: "parked", failureReason: reason, ...metadata },
  });
};

const boundSuccessorQueuedActivity = async (
  tx: Tx,
  predecessor: ChainTask,
  successor: ChainSuccessor,
  state: "queued" | "already-queued",
  runId: string | null,
): Promise<void> => {
  await boundDispatchActivities(tx, predecessor, successor, {
    successorBody: state === "queued"
      ? "Bound predecessor completed; first step queued"
      : "Bound predecessor completed; successor already queued",
    predecessorBody: state === "queued"
      ? "Bound chain dispatched"
      : "Bound chain dispatch observed an already queued successor",
    metadata: { state, runId },
  });
};

type BoundSuccessor = Prisma.TaskGetPayload<{
  include: { runs: true; assigneeAgent: true; repo: true };
}>;

/**
 * Resolves one successor bound to a completed predecessor. The caller already
 * owns the predecessor chain mutex; this function acquires the successor chain
 * mutex second and never the other way around. That order is total because a
 * binding can only point at a chain that pre-dates its own. A predecessor may
 * have several bound successors; each is dispatched by its own call, so one
 * successor's outcome never changes another's.
 */
const dispatchBoundSuccessor = async (
  tx: Tx,
  predecessor: ChainSuccessor,
  successorId: string,
  now: Date,
  predecessorTerminal: boolean,
): Promise<void> => {
  const successorIdentity = await tx.task.findUnique({
    where: { id: successorId },
    select: { projectId: true, chainId: true },
  });
  if (!successorIdentity?.chainId) {
    // The binding shape check makes this unreachable for persisted rows. Keep
    // the refusal explicit if a legacy or hand-written fixture violates it.
    throw new Error(`Bound successor ${successorId} has no chain identity`);
  }
  await lockChainRows(tx, {
    projectId: successorIdentity.projectId,
    chainId: successorIdentity.chainId,
  });
  // The successor Chain owns its own hold barrier. Read it only after taking
  // that Chain's row lock, matching the same-chain activation path, so a
  // completion and an operator Hold have one serialized outcome.
  const successorControl = await readChainControl(tx, {
    projectId: successorIdentity.projectId,
    chainId: successorIdentity.chainId,
  });
  const successor = await tx.task.findUnique({
    where: { id: successorId },
    include: {
      runs: {
        where: { status: { in: ACTIVE_RUN_STATUSES } },
        orderBy: { runNumber: "desc" },
      },
      assigneeAgent: true,
      repo: true,
    },
  }) as BoundSuccessor | null;
  // The binding foreign key and the successor chain mutex make disappearance
  // an integrity violation rather than a caller-recoverable refusal.
  if (!successor) throw new Error(`Bound successor ${successorId} disappeared while dispatching`);

  if (!predecessorTerminal) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      "bound predecessor is no longer terminal; successor was not queued",
      { predecessorTerminal: false },
    );
    return;
  }

  if (successorControl.held) {
    await tx.taskActivity.create({ data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: successorControl.heldLayer === 0
        ? "Bound predecessor completed; successor activation withheld because Chain is held before its first layer"
        : successorControl.heldLayer === null
          ? "Bound predecessor completed; successor activation withheld because Chain is held"
          : `Bound predecessor completed; successor activation withheld because Chain is held after layer ${String(successorControl.heldLayer)}`,
      metadata: {
        kind: "chainControl.activationWithheld",
        schemaVersion: 1,
        heldLayer: successorControl.heldLayer,
        nextLayer: chainLayerOf(successor),
      },
    } });
    return;
  }

  // A second completion/replay can arrive after the first transaction has
  // committed its Run. Treat that as an idempotent observation, not as a
  // refusal that would overwrite the successfully queued task with REVIEW.
  if (successor.runs.length > 0) {
    await boundSuccessorQueuedActivity(tx, predecessor, successor, "already-queued", successor.runs[0]!.id);
    return;
  }
  if (successor.archivedAt) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      `successor ${successor.name} is archived; unarchive the task and retry dispatch`,
    );
    return;
  }
  if (successor.status === TaskStatus.DONE) {
    await boundSuccessorQueuedActivity(tx, predecessor, successor, "already-queued", null);
    return;
  }
  if (successor.status !== TaskStatus.TODO) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      `successor ${successor.name} is ${successor.status}; it was not queued`,
    );
    return;
  }
  if (successor.assigneeType !== AssigneeType.AGENT || !successor.assigneeAgentId || !successor.assigneeAgent || !successor.repoId || !successor.repo) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      `successor ${successor.name} cannot be queued without an agent and repo`,
    );
    return;
  }
  if (successor.assigneeAgent.archivedAt) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      `assignee ${successor.assigneeAgent.name} is archived; unarchive the agent and retry dispatch`,
    );
    return;
  }
  if (!await lockAgentRepoGrant(tx, {
    projectId: successor.projectId,
    agentId: successor.assigneeAgentId,
    repoId: successor.repoId,
  })) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      `repository-grant-missing: assignee ${successor.assigneeAgent.name} has no grant for Repo ${successor.repo.name}; restore the grant and retry dispatch`,
    );
    return;
  }

  const stopped = await stopStateFor(tx, successor.id);
  if (stopped) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      `merge integrator stopped on ${stopped.stop.condition}; predecessor success preserved and successor not activated`,
      { condition: stopped.stop.condition, sourceStopId: stopped.stop.stopId },
    );
    return;
  }

  const attempt = await attemptRunBirth(tx, (tx) => enqueueTaskRunInternal(tx, successor.id, now, null));
  if (attempt.outcome === "already-queued") {
    await boundSuccessorQueuedActivity(tx, predecessor, successor, "already-queued", null);
    return;
  }
  if (attempt.outcome === "refused") {
    const refusal = attempt.refusal;
    switch (refusal.disposition) {
      case "held":
        await tx.taskActivity.create({ data: {
          taskId: successor.id,
          actorType: "control-plane",
          body: `Bound predecessor completed; ${refusal.message}`,
        } });
        return;
      // A bound dispatch owns no stop record of its own, so a stop reads here
      // exactly as any other fault: the successor is parked for an operator.
      case "stopped":
      case "fault":
        await parkBoundSuccessor(tx, predecessor, successor, refusal.message, {
          refusal: refusal.code,
        });
        return;
      default: {
        const unhandled: never = refusal.disposition;
        return unhandled;
      }
    }
  }
  await boundSuccessorQueuedActivity(tx, predecessor, successor, "queued", attempt.run.id);
};

/**
 * Why this successor must not be claimed, or null if it may be.
 *
 * Both answers are an operator's explicit intent: an archived task is retired
 * and a Backlog task is parked, so a predecessor completing does not get to
 * drag either back into execution.
 *
 * A REVIEW successor is deliberately absent. It used to sit here as a
 * fall-through, which is how a chain could stop for hours with nothing but an
 * activity row to say so; `resumeParkedSuccessor` now owns that case.
 */
const parkedReason = (successor: { status: TaskStatus; archivedAt?: Date | null }): string | null => {
  if (successor.archivedAt) return "successor is archived and was not queued";
  if (successor.status === TaskStatus.BACKLOG) return "successor is parked in Backlog — use Start now";
  return null;
};

/** Activity kind recording one automatic recovery of a REVIEW successor. */
export const CHAIN_AUTO_RESUME_KIND = "chainDispatch.autoResume";

/**
 * How many times a chain may return the same successor to TODO by itself.
 *
 * The recovery exists because a REVIEW successor at dispatch time is a stalled
 * chain, not a decision anyone made. The ceiling exists because a step that
 * keeps landing back in REVIEW is failing for a reason no requeue fixes, and
 * spinning on it is worse than stopping and saying so.
 *
 * Five, not three: a merge-readiness step is legitimately parked and re-queued
 * once per automatic repair round, and the tail allows three of those, so a
 * lower ceiling would stop a converging chain rather than a thrashing one.
 */
export const MAX_AUTOMATIC_SUCCESSOR_RESUMES = 5;

/**
 * Returns a stalled REVIEW successor to the queue, or stops the chain when it
 * has already been returned too many times.
 *
 * `true` means the caller may go on to dispatch it; `false` means this
 * successor is parked for a human and the caller must skip it.
 */
const resumeParkedSuccessor = async (
  tx: Tx,
  predecessor: ChainTask,
  successor: ChainSuccessor,
): Promise<boolean> => {
  const priorResumes = await tx.taskActivity.count({
    where: {
      taskId: successor.id,
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: CHAIN_AUTO_RESUME_KIND },
    },
  });
  const attempt = priorResumes + 1;
  if (attempt > MAX_AUTOMATIC_SUCCESSOR_RESUMES) {
    const reason = `successor returned to REVIEW after ${String(MAX_AUTOMATIC_SUCCESSOR_RESUMES)} automatic resumes; chain stopped for an operator`;
    await tx.task.update({
      where: { id: successor.id },
      data: { status: TaskStatus.REVIEW, failureReason: reason },
    });
    await tx.taskActivity.create({ data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: `Predecessor layer completed; ${reason}`,
      metadata: {
        kind: CHAIN_AUTO_RESUME_KIND,
        schemaVersion: 1,
        state: "exhausted",
        attempt,
        predecessorTaskId: predecessor.id,
      },
    } });
    await tx.inboxMessage.upsert({
      where: { dedupeKey: `chain-successor-auto-resume-exhausted:${successor.id}` },
      create: {
        from: "AGENT",
        taskId: successor.id,
        kind: "TEXT",
        body: `Chain step ${successor.name} was automatically resumed ${String(MAX_AUTOMATIC_SUCCESSOR_RESUMES)} times and is back in REVIEW; the chain is stopped and needs an operator.`,
        dedupeKey: `chain-successor-auto-resume-exhausted:${successor.id}`,
      },
      update: {},
    });
    return false;
  }
  await tx.task.update({
    where: { id: successor.id },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  await tx.taskActivity.create({ data: {
    taskId: successor.id,
    actorType: "control-plane",
    body: `Predecessor layer completed; successor was stalled in REVIEW and was automatically returned to the queue (resume ${String(attempt)} of ${String(MAX_AUTOMATIC_SUCCESSOR_RESUMES)})`,
    metadata: {
      kind: CHAIN_AUTO_RESUME_KIND,
      schemaVersion: 1,
      state: "resumed",
      attempt,
      predecessorTaskId: predecessor.id,
    },
  } });
  return true;
};

type ChainSuccessorOptions = {
  sourceRunId?: string | null;
  chatId?: string | null;
  /**
   * What a `fault` refusal does. `park` leaves the successor in REVIEW for an
   * operator; `raise` throws the refusal's own error so the caller's whole
   * transaction rolls back, which is what an Inbox gate approval needs — the
   * decision stays open instead of committing onto a chain that cannot advance.
   */
  onRefusal?: "park" | "raise";
  /** The Documentation -> Regression hop after a merge-tail repair. */
  mergeTailRequeue?: boolean;
  /** The recovery Regression Run whose genuine repair caused that hop. */
  mergeTailRecoverySourceRunId?: string;
};

const parkStoppedIntegratorSuccessor = async (
  tx: Tx,
  predecessor: ChainTask,
  successor: ChainSuccessor,
  stopped: NonNullable<Awaited<ReturnType<typeof stopStateFor>>>,
  sourceRunId: string | null,
): Promise<{ nextTaskId: string; gated: false }> => {
  await tx.task.update({
    where: { id: successor.id },
    data: {
      status: TaskStatus.REVIEW,
      failureReason: `Merge integrator stopped on ${stopped.stop.condition}; predecessor success preserved and successor not activated`,
    },
  });
  await tx.taskActivity.create({
    data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: `Predecessor ${predecessor.name} completed successfully and was preserved; successor not activated because merge integrator stopped on ${stopped.stop.condition}`,
      metadata: {
        condition: stopped.stop.condition,
        sourceRunId,
        sourceStopId: stopped.stop.stopId,
      },
    },
  });
  return { nextTaskId: successor.id, gated: false };
};

const chainLayerOf = (task: { chainLayer?: number | null; chainIndex: number | null }): number | null => layerOf({
  layer: task.chainLayer === undefined ? null : task.chainLayer,
  index: task.chainIndex,
});

const layerOrder = (
  left: { chainLayer?: number | null; chainIndex: number | null; id: string },
  right: { chainLayer?: number | null; chainIndex: number | null; id: string },
): number => compare(
  { layer: left.chainLayer === undefined ? null : left.chainLayer, index: left.chainIndex, id: left.id },
  { layer: right.chainLayer === undefined ? null : right.chainLayer, index: right.chainIndex, id: right.id },
);

/**
 * Activates the next execution layer under a full-chain mutex. The rows are
 * re-read after the lock so a completion in one review sibling cannot observe
 * a stale incomplete layer or enqueue the join twice.
 */
const activateChainSuccessorInternal = async (
  tx: Tx,
  task: ChainTask,
  options: ChainSuccessorOptions,
  now: Date,
  stopBypass: IntegratorStopBypass | null,
  chainRowsLocked = false,
): Promise<{ nextTaskId: string | null; gated: boolean }> => {
  if (!task.chainId || task.chainIndex === null) {
    if (task.chainId) {
      await tx.taskActivity.create({ data: {
        taskId: task.id,
        actorType: "control-plane",
        body: "Chain row missing chain identity; auto-advance skipped",
      } });
    }
    return { nextTaskId: null, gated: false };
  }

  if (!chainRowsLocked) {
    await lockChainRows(tx, { projectId: task.projectId, chainId: task.chainId });
  }
  const chainRows: ChainSuccessor[] = await tx.task.findMany({
    where: { projectId: task.projectId, chainId: task.chainId },
    include: {
      runs: { where: { status: { in: ACTIVE_RUN_STATUSES } }, orderBy: { runNumber: "desc" }, take: 1 },
      assigneeAgent: true,
    },
  });
  chainRows.sort(layerOrder);
  const current = chainRows.find((row) => row.id === task.id);
  const currentLayer = current ? chainLayerOf(current) : chainLayerOf(task);
  if (!current || currentLayer === null) {
    await tx.taskActivity.create({ data: {
      taskId: task.id,
      actorType: "control-plane",
      body: "Chain row missing execution layer; auto-advance skipped",
    } });
    return { nextTaskId: null, gated: false };
  }

  const currentRows = chainRows.filter((row) => chainLayerOf(row) === currentLayer);
  // The full-chain lock is already held here. Read the persisted control only
  // after taking it so a completion and an operator Hold have one defined
  // winner, rather than allowing a stale pre-lock read to leak activation.
  const chainControl = await readChainControl(tx, {
    projectId: task.projectId,
    chainId: task.chainId,
  });
  // A predecessor accepts several bound successors. Dispatching them in id
  // order gives every completion the same total order over successor chain
  // mutexes, so two completions can never take two successor locks crosswise.
  const boundSuccessors = current.status === TaskStatus.DONE
    ? await tx.task.findMany({
      where: { dispatchAfterTaskId: current.id },
      select: { id: true },
      orderBy: { id: "asc" },
    })
    : [];
  const dispatchBoundSuccessors = async (predecessorTerminal: boolean): Promise<void> => {
    for (const successor of boundSuccessors) {
      await dispatchBoundSuccessor(tx, current, successor.id, now, predecessorTerminal);
    }
  };
  if (!currentRows.every((row) => row.status === TaskStatus.DONE)) {
    // The first review completion exits here while its blind sibling is still
    // unfinished; the second completion owns the join.
    await dispatchBoundSuccessors(false);
    return { nextTaskId: null, gated: false };
  }
  // A legacy chain can contain a historical DONE gap (for example an operator
  // completed a step before deleting its run). Treat fully completed layers as
  // history and select the first higher layer that still has work. This keeps
  // the one-node-per-layer migration linear without recursively re-entering the
  // activation routine.
  const nextLayer = [...new Set(chainRows.map(chainLayerOf).filter((value): value is number => value !== null))]
    .filter((value) => value > currentLayer)
    .sort((left, right) => left - right)
    .find((value) => chainRows.some((row) => chainLayerOf(row) === value && row.status !== TaskStatus.DONE));
  const missingSuccessorLayer = nextLayer === undefined
    && chainRows.some((row) => chainLayerOf(row) === null && row.status !== TaskStatus.DONE);
  const withholdSuccessorActivation = async (withheldLayer: number | null) => {
    await tx.taskActivity.create({ data: {
      taskId: current.id,
      actorType: "control-plane",
      body: chainControl.heldLayer === 0
        ? "Predecessor layer completed; successor activation withheld because Chain is held before its first layer"
        : chainControl.heldLayer === null
          ? "Predecessor layer completed; successor activation withheld because Chain is held"
          : `Predecessor layer completed; successor activation withheld because Chain is held after layer ${String(chainControl.heldLayer)}`,
      metadata: {
        kind: "chainControl.activationWithheld",
        schemaVersion: 1,
        heldLayer: chainControl.heldLayer,
        nextLayer: withheldLayer,
      },
    } });
    return { nextTaskId: null, gated: false };
  };
  if (missingSuccessorLayer && heldPredicate({
    projectId: task.projectId,
    chainId: task.chainId,
    layer: null,
    index: null,
  }, chainControl)) {
    if (current.archivedAt === null) await dispatchBoundSuccessors(false);
    return withholdSuccessorActivation(null);
  }
  if (nextLayer === undefined) {
    const predecessorComplete = chainRows.every((row) => row.status === TaskStatus.DONE);
    if (boundSuccessors.length === 0 || predecessorComplete) {
      await tx.taskActivity.create({ data: { taskId: current.id, actorType: "control-plane", body: "Chain complete" } });
    }
    // Archiving a predecessor does not resolve its binding. Production routes
    // cannot complete an archived task, but retaining this check also keeps
    // legacy/directly-seeded rows inert instead of dispatching from archived
    // history when an activation replay is attempted.
    if (current.archivedAt === null) await dispatchBoundSuccessors(predecessorComplete);
    return { nextTaskId: null, gated: false };
  }

  // A binding to a non-terminal layer is rejected at instantiation time. If a
  // legacy row or direct fixture nevertheless carries one, park it while the
  // predecessor Chain still has work. Bound dispatch belongs to the
  // successor's Chain, so a hold here must not change that outcome.
  await dispatchBoundSuccessors(false);

  if (heldPredicate({
    projectId: task.projectId,
    chainId: task.chainId,
    layer: nextLayer,
    index: null,
  }, chainControl)) {
    return withholdSuccessorActivation(nextLayer);
  }

  const nextRows = chainRows.filter((row) => chainLayerOf(row) === nextLayer).sort(layerOrder);
  if (nextRows.some((row) => row.approvalGate) && nextRows.length > 1) {
    throw new WorkflowRefusalError("invalid-request", `Approval gate is not allowed in multi-node chain layer ${nextLayer}`);
  }
  if (nextRows.some((row) => row.approvalGate
      && (row.assigneeType !== AssigneeType.AGENT || !row.assigneeAgentId || !row.repoId))
    && (currentRows.length !== 1
      || currentRows[0]!.assigneeType !== AssigneeType.AGENT
      || !currentRows[0]!.assigneeAgentId
      || !currentRows[0]!.repoId)) {
    throw new WorkflowRefusalError("invalid-request", "Server-owned approval gate must follow one executable predecessor");
  }

  let firstNextTaskId: string | null = null;
  let gated = false;
  for (const successor of nextRows) {
    firstNextTaskId ??= successor.id;
    if (successor.status === TaskStatus.DONE) continue;
    if (successor.runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
      await tx.taskActivity.create({ data: {
        taskId: successor.id,
        actorType: "control-plane",
        body: "Predecessor layer completed; successor already active",
      } });
      continue;
    }
    const parked = parkedReason(successor);
    if (parked) {
      await tx.taskActivity.create({ data: {
        taskId: successor.id,
        actorType: "control-plane",
        body: `Predecessor layer completed; ${parked}`,
      } });
      continue;
    }
    // A REVIEW successor at dispatch time is normally a stalled chain rather
    // than a decision anyone made, so it is returned to the queue under a
    // bounded ceiling. An approval-gated REVIEW is the deliberate exception
    // only while its durable Inbox decision is still OPEN. A readiness hard
    // stop also parks the task in REVIEW, but its prior card is already
    // answered; that state must resume and open fresh evidence instead of
    // silently dead-ending the tail.
    if (successor.status === TaskStatus.REVIEW && successor.approvalGate) {
      const openGate = await tx.inboxMessage.findFirst({
        where: { gateTaskId: successor.id, status: InboxStatus.OPEN },
        select: { id: true },
      });
      if (openGate) {
        await tx.taskActivity.create({ data: {
          taskId: successor.id,
          actorType: "control-plane",
          body: "Predecessor layer completed; approval gate remains open",
        } });
        continue;
      }
    }
    if (successor.status === TaskStatus.REVIEW && !await resumeParkedSuccessor(tx, current, successor)) continue;

    const successorStep = successor.templateStepId
      ? await tx.taskTemplateStep.findUnique({
        where: { id: successor.templateStepId },
        select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
      })
      : null;
    const compoundImplementation = isCompoundImplementationStep(successorStep);
    if (isMergeReadinessStep(successorStep)) {
      // A gated server-owned readiness step has no Run of its own, so its gate
      // must open at activation while the completing Regression Run still
      // supplies the session and pull-request identity. Keep the task in
      // REVIEW before creating the card in this same transaction; readiness
      // claiming only considers TODO/DOING, so the worker cannot race the
      // operator while the evidence card is being prepared.
      if (successor.approvalGate && options.sourceRunId) {
        await tx.task.update({
          where: { id: successor.id },
          data: { status: TaskStatus.REVIEW, failureReason: null },
        });
        await gateQuestion(tx, successor.id, options.sourceRunId, options.chatId ?? null);
        gated = true;
        continue;
      }
      await tx.taskActivity.create({ data: {
        taskId: successor.id,
        actorType: "control-plane",
        body: "Predecessor layer completed; server-side merge readiness queued",
        metadata: {
          kind: MERGE_TAIL_KIND.readiness,
          schemaVersion: 1,
          state: "queued",
          sourceRunId: options.sourceRunId ?? null,
        },
      } });
      continue;
    }

    if (!compoundImplementation
      && (successor.assigneeType !== AssigneeType.AGENT || !successor.assigneeAgentId || !successor.repoId)) {
      if (options.sourceRunId) {
        await tx.task.update({ where: { id: successor.id }, data: { status: TaskStatus.REVIEW } });
        await gateQuestion(tx, successor.id, options.sourceRunId, options.chatId ?? null);
        gated = true;
      } else {
        await tx.taskActivity.create({ data: {
          taskId: successor.id,
          actorType: "control-plane",
          body: "Predecessor layer completed; successor awaits operator",
        } });
      }
      continue;
    }

    const attempt = await attemptRunBirth(tx, (tx) => enqueueTaskRunInternal(
      tx,
      successor.id,
      now,
      stopBypass,
      options.mergeTailRequeue && isRegressionVerificationOutputKind(successorStep?.outputKind)
        ? { budgetGrant: 1, repairCompleted: true }
        : {},
    ));
    if (attempt.outcome === "already-queued") continue;
    if (attempt.outcome === "refused") {
      const refusal = attempt.refusal;
      switch (refusal.disposition) {
        case "held":
          await tx.taskActivity.create({ data: {
            taskId: successor.id,
            actorType: "control-plane",
            body: `Predecessor layer completed; ${refusal.message}`,
          } });
          continue;
        case "stopped": {
          const stoppedAfterRollback = await stopStateFor(tx, successor.id);
          if (stoppedAfterRollback) {
            await parkStoppedIntegratorSuccessor(
              tx,
              current,
              successor,
              stoppedAfterRollback,
              options.sourceRunId ?? null,
            );
            continue;
          }
          throw errorForOpenRunRefusal(refusal);
        }
        case "fault":
          if (options.onRefusal === "raise") {
            // A compound implementation step is bound to one Agent by
            // construction, so a refusal carrying no error of its own is that
            // invariant failing. The operator's answer is the compound-assignee
            // refusal rather than a bare invalid-request.
            const error = errorForOpenRunRefusal(refusal);
            throw compoundImplementation && isWorkflowRefusalError(error)
              ? new CompoundImplementationAssigneeError()
              : error;
          }
          break;
        default: {
          const unhandled: never = refusal.disposition;
          return unhandled;
        }
      }
      await tx.task.update({
        where: { id: successor.id },
        data: { status: TaskStatus.REVIEW, failureReason: refusal.message },
      });
      await tx.taskActivity.create({ data: {
        taskId: successor.id,
        actorType: "control-plane",
        body: `Predecessor layer completed but Run birth was refused: ${refusal.message}`,
        metadata: { refusal: refusal.code },
      } });
      continue;
    }
    if (options.mergeTailRequeue
      && options.mergeTailRecoverySourceRunId !== undefined
      && isRegressionVerificationOutputKind(successorStep?.outputKind)) {
      await carryMergeRecoveryRun(tx, {
        regressionTaskId: successor.id,
        recoveryRunId: attempt.run.id,
        previousRecoveryRunId: options.mergeTailRecoverySourceRunId,
      });
    }
    await tx.taskActivity.create({ data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: "Predecessor layer completed; step queued",
    } });
  }
  return { nextTaskId: firstNextTaskId, gated };
};

export const activateChainSuccessor = async (
  tx: Tx,
  task: ChainTask,
  options: ChainSuccessorOptions = {},
  now = new Date(),
): Promise<{ nextTaskId: string | null; gated: boolean }> =>
  activateChainSuccessorInternal(tx, task, options, now, null);

export type RecoveryIntegratorActivationResult =
  | { outcome: "activated"; nextTaskId: string | null; gated: boolean }
  | {
    outcome: "refused";
    refusalCode: typeof MergeRecoveryRefusalCode.ACTIVATION_AUTHORIZATION_STALE;
  };

/**
 * The only automatic exit through an unresolved integrator stop. The caller is
 * the server-owned readiness worker, but authority comes from durable rows: an
 * exact queued recovery bound to the latest stop and a fresh mechanical
 * authorization for that recovery's current base. Generic activation and
 * enqueue APIs never receive the resulting one-stop bypass.
 */
export const activateRecoveryIntegratorSuccessor = async (
  tx: Tx,
  input: {
    readinessTaskId: string;
    integratorTaskId: string;
    sourceStopId: string;
    recoveryRunId: string;
    authorizationActivityId: string;
  },
  now = new Date(),
): Promise<RecoveryIntegratorActivationResult> => {
  // Every failure below checks authority written by control-plane workers after
  // their candidate was selected. The recoverable exact-head mismatch is a
  // typed refusal; every other mismatch is an internal invariant and remains a
  // deliberate 500 rather than an operator input error.
  const identity = await tx.task.findUnique({
    where: { id: input.readinessTaskId },
    select: { projectId: true, chainId: true },
  });
  if (!identity?.chainId) {
    throw new Error("Recovery activation requires a chained merge-readiness step");
  }
  // Recovery follows the same mutation protocol as every other chain writer:
  // resolve identity without a row lock, acquire the full chain mutex, then
  // re-read every authority fact before changing the integrator task.
  await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });
  const [readiness, stopped, recovery, authorization, output] = await Promise.all([
    tx.task.findUnique({
      where: { id: input.readinessTaskId },
      include: { templateStep: { include: { taskTemplate: { select: { name: true } } } } },
    }),
    stopStateFor(tx, input.integratorTaskId),
    tx.mergeRecoveryAttempt.findFirst({
      where: {
        integratorTaskId: input.integratorTaskId,
        sourceStopId: input.sourceStopId,
        recoveryRunId: input.recoveryRunId,
        status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
      },
      orderBy: [{ attempt: "desc" }, { id: "desc" }],
    }),
    tx.taskActivity.findUnique({
      where: { id: input.authorizationActivityId },
      select: { id: true, taskId: true, actorType: true, metadata: true },
    }),
    tx.taskStepOutput.findUnique({
      where: { taskId: input.readinessTaskId },
      select: { kind: true, body: true, commitSha: true },
    }),
  ]);
  if (!readiness || readiness.status !== TaskStatus.DONE || !isMergeReadinessStep(readiness.templateStep)) {
    throw new Error("Recovery activation requires a completed server-owned merge-readiness step");
  }
  if (!stopped || stopped.stop.stopId !== input.sourceStopId) {
    throw new Error("Recovery activation is not bound to the current unresolved integrator stop");
  }
  if (!recovery || recovery.readinessTaskId !== input.readinessTaskId) {
    throw new Error("Recovery activation has no matching canonical recovery aggregate");
  }

  const parsedAuthorization = parseAuthorizationMetadata(authorization?.metadata);
  const authorizationMetadataValue = authorization?.metadata as Record<string, unknown> | null | undefined;
  if (!authorization
    || authorization.taskId !== input.readinessTaskId
    || authorization.actorType !== "control-plane"
    || parsedAuthorization.status !== "ok"
    || authorizationMetadataValue?.recoverySourceStopId !== input.sourceStopId) {
    throw new Error("Recovery activation requires a control-plane authorization bound to its source stop");
  }
  const payload = parsedAuthorization.payload;
  if (!recovery.repository || recovery.prNumber === null || !recovery.targetBranch
    || !recovery.authorizedHeadSha || !recovery.currentBaseSha
    || payload.repository !== recovery.repository
    || payload.prNumber !== recovery.prNumber
    || payload.baseRef !== recovery.targetBranch
    || payload.headSha !== recovery.authorizedHeadSha
    || payload.baseSha !== recovery.currentBaseSha
    || payload.decision.channel !== "mechanical") {
    return {
      outcome: "refused",
      refusalCode: MergeRecoveryRefusalCode.ACTIVATION_AUTHORIZATION_STALE,
    };
  }

  let outputBinding: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(output?.body ?? "null") as unknown;
    outputBinding = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    outputBinding = null;
  }
  if (output?.kind !== "merge-authorization"
    || output.commitSha !== payload.headSha
    || outputBinding?.authorizationActivityId !== authorization.id
    || outputBinding?.headSha !== payload.headSha) {
    throw new Error("Recovery activation readiness output does not select the fresh authorization");
  }

  // REVIEW normally parks a successor for an operator. This path is the one
  // validated automatic exit from an integrator stop, so make the task
  // runnable only after every recovery/authorization fence above succeeds.
  // The enclosing transaction rolls this change back if enqueueing fails.
  await tx.task.update({
    where: { id: input.integratorTaskId },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  const activated = await activateChainSuccessorInternal(
    tx,
    readiness,
    {},
    now,
    { integratorTaskId: input.integratorTaskId, sourceStopId: input.sourceStopId },
    true,
  );
  if (activated.nextTaskId !== input.integratorTaskId) {
    throw new Error("Recovery activation did not resolve the expected merge-integrator successor");
  }
  await transitionMergeRecovery(tx, recovery.id, MergeRecoveryStatus.SUCCEEDED, {
    authorizationActivityId: authorization.id,
    failureReason: null,
    refusalCode: null,
    endedAt: now,
  });
  return { outcome: "activated", ...activated };
};

/** Marks a completed template task done and activates exactly one successor or gate. */
export const advanceTemplateTask = async (
  tx: Tx,
  taskId: string,
  sourceRunId: string,
  chatId: string | null,
  now = new Date(),
  expectedStatus?: TaskStatus,
  options: Pick<ChainSuccessorOptions, "mergeTailRequeue" | "mergeTailRecoverySourceRunId"> = {},
): Promise<{ gated: boolean; nextTaskId: string | null }> => {
  const task = await tx.task.findUniqueOrThrow({
    where: { id: taskId },
  });
  if (!task.templateId) return { gated: false, nextTaskId: null };
  // The completion transaction may arrive here after locking the Run, but it
  // must acquire the complete chain before changing even the producing Task.
  // Otherwise this update would hold one Task row and activateChainSuccessor
  // would later expand the lock to siblings, inverting the full-chain mutex.
  if (task.chainId) {
    await lockChainRows(tx, { projectId: task.projectId, chainId: task.chainId });
  }
  if (task.approvalGate) {
    if (task.chainId) {
      const layer = chainLayerOf(task);
      const siblingCount = layer === null ? 0 : await tx.task.count({
        where: {
          projectId: task.projectId,
          chainId: task.chainId,
          ...(task.chainLayer !== null && task.chainLayer !== undefined
            ? { chainLayer: task.chainLayer }
            : { chainIndex: task.chainIndex }),
        },
      });
      if (siblingCount > 1) {
        throw new WorkflowRefusalError("invalid-request", "Approval gate is not allowed in a multi-node chain layer");
      }
    }
    if (expectedStatus) {
      const claimed = await tx.task.updateMany({ where: { id: task.id, status: expectedStatus }, data: { status: TaskStatus.REVIEW } });
      if (claimed.count !== 1) return { gated: false, nextTaskId: null };
    } else {
      await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.REVIEW } });
    }
    await gateQuestion(tx, task.id, sourceRunId, chatId);
    return { gated: true, nextTaskId: null };
  }
  if (expectedStatus) {
    const claimed = await tx.task.updateMany({ where: { id: task.id, status: expectedStatus }, data: { status: TaskStatus.DONE, failureReason: null } });
    if (claimed.count !== 1) return { gated: false, nextTaskId: null };
  } else {
    await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.DONE, failureReason: null } });
  }
  return activateChainSuccessor(tx, task, { sourceRunId, chatId, ...options }, now);
};
