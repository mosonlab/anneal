import {
  AssigneeType,
  ChainControlState,
  Prisma,
  RunStatus,
  TaskStatus,
} from "@prisma/client";

import {
  ACTIVE_RUN_STATUSES,
  activateChainSuccessor,
} from "./chain-activation.js";
import { heldBeforeFirstLayer } from "./chain-hold.js";
import { compare, denseOrdinals, layerOf } from "./chain-order.js";
import { enqueueTaskRunInternal, errorForOpenRunRefusal } from "./run-open.js";
import { lockAgentRepoGrant, lockChainRows, lockChainStructure } from "./locks.js";
import { markerFromMetadata } from "./merge-tail-markers.js";
import {
  pendingIntegratorAuthorization,
  replayPendingIntegratorAuthorization,
} from "./merge-recovery-intent.js";
import { stepRole } from "./step-role.js";

type ChainControlDb = Pick<Prisma.TransactionClient, "chainControl">;

export type ChainControlRefusal = {
  reason: "not-found" | "conflict";
  message: string;
  detail?: Readonly<Record<string, string>>;
};

type ChainControlProjectionInput = {
  projectId: string;
  chainId: string;
  state: ChainControlState;
  heldLayer: number | null;
  heldExecutionLayer: number | null;
  heldAt: Date | null;
  holdRequestId: string | null;
  holdReason: string | null;
  releasedAt: Date | null;
  releaseRequestId: string | null;
  holdGeneration: number;
};

export type ChainControlAddress = {
  projectId: string;
  chainId: string;
  taskId: string;
};

export type ChainResumeRow = {
  id: string;
  projectId: string;
  name: string;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer: number | null;
  status: TaskStatus;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  repoId: string | null;
};

type ResumeFirstLayerTask = {
  id: string;
  projectId: string;
  name: string;
  status: TaskStatus;
  archivedAt: Date | null;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  repoId: string | null;
  maxSessionsPerTask: number;
  dispatchAfterTaskId: string | null;
  dispatchAfter: { status: TaskStatus } | null;
  assigneeAgent: { name: string; archivedAt: Date | null } | null;
  repo: { name: string } | null;
  templateStep: {
    stepIndex: number;
    outputKind: string;
    taskTemplate: { name: string } | null;
  } | null;
};

/**
 * Everything `resumeFirstLayerRefusal` reads beyond the Task row itself. Shared
 * with the held merge-integrator replay so both admissions ask the same
 * questions of the same columns.
 */
const RESUME_ADMISSION_INCLUDE = {
  assigneeAgent: { select: { name: true, archivedAt: true } },
  repo: { select: { name: true } },
  dispatchAfter: { select: { status: true } },
  templateStep: {
    select: {
      stepIndex: true,
      outputKind: true,
      taskTemplate: { select: { name: true } },
    },
  },
} as const;

/**
 * Resume of a held-before-first-layer Chain is the same operator admission as
 * POST /tasks/:taskId/start. Keep this check in the database mutation because
 * the API route cannot participate in the Chain mutex or the release CAS.
 * `openRun` repeats its own birth-time guards after the release; this helper
 * covers the Start-only status, budget, and repository-grant checklist before
 * changing the control authority.
 */
const resumeFirstLayerRefusal = async (
  tx: Prisma.TransactionClient,
  task: ResumeFirstLayerTask,
): Promise<ChainControlRefusal | null> => {
  if (task.archivedAt !== null) return refusal("conflict", "Cannot start an archived task");
  if (task.status === TaskStatus.DONE) return refusal("conflict", "Task is already done");
  if (task.assigneeType !== AssigneeType.AGENT) return refusal("conflict", "Human steps cannot be started");
  if (task.templateStep !== null && stepRole(task.templateStep) === "readiness") {
    return refusal("conflict", "Merge readiness is server-owned and cannot be started as a model run");
  }
  if (task.status !== TaskStatus.TODO && task.status !== TaskStatus.BACKLOG) {
    return refusal("conflict", "Only Todo and Backlog steps can be started");
  }
  if (task.repoId === null || task.repo === null) return refusal("conflict", "This task has no repository");
  if (task.assigneeAgentId === null || task.assigneeAgent === null) return refusal("conflict", "This task has no assignee");
  if (task.maxSessionsPerTask <= 0) return refusal("conflict", "Run budget exhausted");
  if (!await lockAgentRepoGrant(tx, {
    projectId: task.projectId,
    agentId: task.assigneeAgentId,
    repoId: task.repoId,
  })) return refusal("conflict", "Assignee has no grant for this Repo");
  if (task.assigneeAgent.archivedAt !== null) {
    return refusal(
      "conflict",
      `Task ${task.name} assignee ${task.assigneeAgent.name} is archived; unarchive the agent to queue this step`,
    );
  }
  return null;
};

const chainLayerOf = (
  task: Pick<ChainResumeRow, "chainLayer" | "chainIndex">,
): number | null => layerOf({ layer: task.chainLayer, index: task.chainIndex });

const chainOrder = (left: ChainResumeRow, right: ChainResumeRow): number => compare(
  { layer: left.chainLayer, index: left.chainIndex, id: left.id },
  { layer: right.chainLayer, index: right.chainIndex, id: right.id },
);

/**
 * Resume anchors ordinary successor activation at the highest complete layer,
 * but only after the layer pinned by Hold is complete.
 */
export const resumeActivationAnchor = (
  rows: readonly ChainResumeRow[],
  heldLayer: number | null,
): ChainResumeRow | null => {
  if (heldLayer === null) return null;
  const layers = [...new Set(rows.map(chainLayerOf).filter((layer): layer is number => layer !== null))];
  const heldRows = rows.filter((row) => chainLayerOf(row) === heldLayer);
  if (heldRows.length === 0 || !heldRows.every((row) => row.status === TaskStatus.DONE)) return null;
  const completeLayer = layers
    .filter((layer) => rows.some((row) => chainLayerOf(row) === layer)
      && rows.filter((row) => chainLayerOf(row) === layer).every((row) => row.status === TaskStatus.DONE))
    .sort((left, right) => right - left)[0];
  if (completeLayer === undefined) return null;
  return rows
    .filter((row) => chainLayerOf(row) === completeLayer)
    .sort(chainOrder)[0] ?? null;
};

export const resumeActivationNeedsSourceRun = (
  rows: readonly ChainResumeRow[],
  anchor: ChainResumeRow,
): boolean => {
  const anchorLayer = chainLayerOf(anchor);
  if (anchorLayer === null) return false;
  const nextLayer = [...new Set(rows.map(chainLayerOf).filter((layer): layer is number => layer !== null))]
    .filter((layer) => layer > anchorLayer
      && rows.some((row) => chainLayerOf(row) === layer && row.status !== TaskStatus.DONE))
    .sort((left, right) => left - right)[0];
  if (nextLayer === undefined) return false;
  return rows
    // Activation handles an operator-parked successor before assignee shape.
    .filter((row) => chainLayerOf(row) === nextLayer
      && row.status !== TaskStatus.DONE
      && row.status !== TaskStatus.BACKLOG)
    .some((row) => row.assigneeType !== AssigneeType.AGENT
      || row.assigneeAgentId === null
      || row.repoId === null);
};

/** The Chain read contract exposes operator facts, not internal CAS metadata. */
export const chainControlReadProjection = (control: ChainControlProjectionInput) => ({
  state: control.state === ChainControlState.HELD ? "held" as const : "released" as const,
  heldLayer: control.heldLayer,
  heldAt: control.heldAt,
  holdRequestId: control.holdRequestId,
  holdReason: control.holdReason,
  releasedAt: control.releasedAt,
});

/** Mutation responses retain transition metadata needed by idempotent clients. */
export const chainControlMutationProjection = (control: ChainControlProjectionInput) => ({
  projectId: control.projectId,
  chainId: control.chainId,
  state: control.state === ChainControlState.HELD ? "held" as const : "released" as const,
  heldLayer: control.heldLayer,
  heldAt: control.heldAt,
  holdRequestId: control.holdRequestId,
  holdReason: control.holdReason,
  releasedAt: control.releasedAt,
  releaseRequestId: control.releaseRequestId,
  holdGeneration: control.holdGeneration,
});

const refusal = (
  reason: ChainControlRefusal["reason"],
  message: string,
  detail?: ChainControlRefusal["detail"],
): ChainControlRefusal => detail === undefined ? { reason, message } : { reason, message, detail };

export type ChainControlKey = {
  projectId: string;
  chainId: string;
};

/**
 * The one shared read of the persisted Chain hold authority. Every requested
 * key receives a value: an absent row and a RELEASED row both become the same
 * not-held snapshot, while a HELD row retains the layer and audit facts needed
 * by admission, activation and claim callers. The map is keyed by the same
 * project/Chain pair used by Chain progress readers because chainId alone is
 * only project-local identity.
 */
export type ChainControlSnapshot = {
  projectId: string;
  chainId: string;
  state: ChainControlState;
  held: boolean;
  heldLayer: number | null;
  heldExecutionLayer: number | null;
  heldAt: Date | null;
  holdRequestId: string | null;
  holdReason: string | null;
  releasedAt: Date | null;
  releaseRequestId: string | null;
  holdGeneration: number;
};

export const chainControlKey = ({ projectId, chainId }: ChainControlKey): string => `${projectId}:${chainId}`;

const notHeld = ({ projectId, chainId }: ChainControlKey): ChainControlSnapshot => ({
  projectId,
  chainId,
  state: ChainControlState.RELEASED,
  held: false,
  heldLayer: null,
  heldExecutionLayer: null,
  heldAt: null,
  holdRequestId: null,
  holdReason: null,
  releasedAt: null,
  releaseRequestId: null,
  holdGeneration: 0,
});

const snapshot = (row: {
  projectId: string;
  chainId: string;
  state: ChainControlState;
  heldLayer: number | null;
  heldExecutionLayer: number | null;
  heldAt: Date | null;
  holdRequestId: string | null;
  holdReason: string | null;
  releasedAt: Date | null;
  releaseRequestId: string | null;
  holdGeneration: number;
}): ChainControlSnapshot => ({
  projectId: row.projectId,
  chainId: row.chainId,
  state: row.state,
  held: row.state === ChainControlState.HELD,
  heldLayer: row.heldLayer,
  heldExecutionLayer: row.heldExecutionLayer,
  heldAt: row.heldAt,
  holdRequestId: row.holdRequestId,
  holdReason: row.holdReason,
  releasedAt: row.releasedAt,
  releaseRequestId: row.releaseRequestId,
  holdGeneration: row.holdGeneration,
});

export const readChainControls = async (
  tx: ChainControlDb,
  keys: readonly ChainControlKey[],
): Promise<Map<string, ChainControlSnapshot>> => {
  const unique = [...new Map(keys.map((key) => [chainControlKey(key), key])).values()];
  if (unique.length === 0) return new Map();
  const rows = await tx.chainControl.findMany({
    where: { OR: unique },
    select: {
      projectId: true,
      chainId: true,
      state: true,
      heldLayer: true,
      heldExecutionLayer: true,
      heldAt: true,
      holdRequestId: true,
      holdReason: true,
      releasedAt: true,
      releaseRequestId: true,
      holdGeneration: true,
    },
  });
  const byKey = new Map(rows.map((row) => [chainControlKey(row), snapshot(row)]));
  return new Map(unique.map((key) => [chainControlKey(key), byKey.get(chainControlKey(key)) ?? notHeld(key)]));
};

export const readChainControl = async (
  tx: ChainControlDb,
  key: ChainControlKey,
): Promise<ChainControlSnapshot> => (
  (await readChainControls(tx, [key])).get(chainControlKey(key)) ?? notHeld(key)
);

export const readChainControlRecord = async (
  tx: ChainControlDb,
  key: ChainControlKey,
): Promise<ChainControlProjectionInput | null> => tx.chainControl.findUnique({
  where: { projectId_chainId: key },
  select: {
    projectId: true,
    chainId: true,
    state: true,
    heldLayer: true,
    heldExecutionLayer: true,
    heldAt: true,
    holdRequestId: true,
    holdReason: true,
    releasedAt: true,
    releaseRequestId: true,
    holdGeneration: true,
  },
});

export type HoldChainResult = {
  control: ReturnType<typeof chainControlMutationProjection>;
  duplicate: boolean;
};

export const holdChain = async (
  tx: Prisma.TransactionClient,
  input: ChainControlAddress & { requestId: string; reason?: string | null | undefined },
): Promise<HoldChainResult | ChainControlRefusal> => {
  await lockChainStructure(tx, input);
  await lockChainRows(tx, input);
  const chainRows = await tx.task.findMany({
    where: { projectId: input.projectId, chainId: input.chainId },
    select: { id: true, status: true, chainIndex: true, chainLayer: true },
  });
  if (!chainRows.some((row) => row.id === input.taskId)) return refusal("not-found", "Task not found");

  const existing = await tx.chainControl.findUnique({
    where: { projectId_chainId: { projectId: input.projectId, chainId: input.chainId } },
  });
  // Event history is the durable idempotency ledger. A delayed accepted Hold
  // remains a no-op after Resume has replaced the mutable state.
  const priorRequest = existing === null ? null : await tx.chainControlEvent.findUnique({
    where: {
      chainControlId_kind_requestId: {
        chainControlId: existing.id,
        kind: ChainControlState.HELD,
        requestId: input.requestId,
      },
    },
  });
  if (priorRequest || existing?.state === ChainControlState.HELD) {
    if (!existing) throw new Error("Chain control event exists without its authority");
    return { control: chainControlMutationProjection(existing), duplicate: true };
  }

  // Hold is a barrier after the highest layer that has already been admitted,
  // not before the next unfinished layer. A TODO row is inert until its first
  // Run is born; every other status (including DONE) is an admitted row, and a
  // terminal Run is evidence of admission even if the Task was returned to
  // TODO. The zero sentinel is the durable "before the first layer" barrier.
  const runTaskIds = chainRows.map((row) => row.id);
  const runRows = runTaskIds.length === 0
    ? []
    : await tx.run.findMany({
      where: { taskId: { in: runTaskIds } },
      select: { taskId: true },
    });
  const admittedTaskIds = new Set([
    ...chainRows.filter((row) => row.status !== TaskStatus.TODO).map((row) => row.id),
    ...runRows.map((row) => row.taskId),
  ]);
  const heldExecutionLayer = chainRows
    .filter((row) => admittedTaskIds.has(row.id))
    .map(chainLayerOf)
    .filter((layer): layer is number => layer !== null)
    .sort((left, right) => right - left)[0] ?? null;
  const ordinals = denseOrdinals(chainRows.map((row) => ({ layer: row.chainLayer, index: row.chainIndex })));
  const heldLayer = heldExecutionLayer === null ? 0 : ordinals.get(heldExecutionLayer);
  if (heldLayer === undefined) throw new Error(`Admitted Chain layer ${heldExecutionLayer} has no ordinal`);
  if (chainRows.every((row) => row.status === TaskStatus.DONE)) {
    return refusal("conflict", "Cannot hold a completed Chain; there is nothing left to hold");
  }

  const now = new Date();
  const holdGeneration = (existing?.holdGeneration ?? 0) + 1;
  const held = existing
    ? await tx.chainControl.update({
      where: { id: existing.id },
      data: {
        state: ChainControlState.HELD,
        heldLayer,
        heldExecutionLayer,
        heldAt: now,
        holdRequestId: input.requestId,
        holdReason: input.reason ?? null,
        releasedAt: null,
        releaseRequestId: null,
        holdGeneration,
      },
    })
    : await tx.chainControl.create({
      data: {
        projectId: input.projectId,
        chainId: input.chainId,
        state: ChainControlState.HELD,
        heldLayer,
        heldExecutionLayer,
        heldAt: now,
        holdRequestId: input.requestId,
        holdReason: input.reason ?? null,
        holdGeneration,
      },
    });
  await tx.chainControlEvent.create({
    data: {
      chainControlId: held.id,
      kind: ChainControlState.HELD,
      layer: heldLayer,
      actorType: "operator",
      actorId: null,
      requestId: input.requestId,
      reason: input.reason ?? null,
      createdAt: now,
      holdGeneration,
    },
  });
  return { control: chainControlMutationProjection(held), duplicate: false };
};

/**
 * Replay the merge-integrator authorization this Hold refused, if there is one.
 *
 * The admission is the checklist `POST /tasks/:taskId/start` applies, run here
 * because Resume owns the Chain mutex the route cannot enter. A refusal leaves
 * the pending authorization recorded for a later Resume rather than spending it
 * or blocking the release the operator asked for.
 */
const replayHeldIntegratorAuthorization = async (
  tx: Prisma.TransactionClient,
  address: ChainControlAddress,
  now: Date,
) => {
  const pending = await pendingIntegratorAuthorization(tx, {
    projectId: address.projectId,
    chainId: address.chainId,
  });
  if (!pending) return null;
  const integrator = await tx.task.findUnique({
    where: { id: pending.integratorTaskId },
    include: RESUME_ADMISSION_INCLUDE,
  });
  const admissionRefusal = integrator === null
    ? `Merge integrator task ${pending.integratorTaskId} no longer exists`
    : (await resumeFirstLayerRefusal(tx, integrator))?.message ?? null;
  if (admissionRefusal === null) return replayPendingIntegratorAuthorization(tx, pending, now);
  await tx.taskActivity.create({ data: {
    taskId: pending.integratorTaskId,
    actorType: "control-plane",
    body: `Chain resumed but the held recovery authorization was not replayed: ${admissionRefusal}`,
    metadata: {
      kind: "chainControl.integratorAuthorizationNotAdmitted",
      schemaVersion: 1,
      aggregateId: pending.id,
      authorizationActivityId: pending.pendingAuthorizationId,
      reason: admissionRefusal,
    },
  } });
  return null;
};

export type ResumeChainResult = {
  control: ReturnType<typeof chainControlMutationProjection> | null;
  duplicate: boolean;
  nextTaskId: string | null;
  gated: boolean;
  /** The merge-integrator Run this Resume replayed for a held base-drift
   *  recovery, when there was one waiting. */
  replayedIntegratorRunId?: string;
};

export const resumeChain = async (
  tx: Prisma.TransactionClient,
  input: ChainControlAddress & { requestId: string },
  now: Date,
): Promise<ResumeChainResult | ChainControlRefusal> => {
  await lockChainStructure(tx, input);
  await lockChainRows(tx, input);
  const chainRows = await tx.task.findMany({
    where: { projectId: input.projectId, chainId: input.chainId },
    select: {
      id: true,
      projectId: true,
      name: true,
      chainId: true,
      chainIndex: true,
      chainLayer: true,
      status: true,
      assigneeType: true,
      assigneeAgentId: true,
      repoId: true,
    },
  });
  if (!chainRows.some((row) => row.id === input.taskId)) return refusal("not-found", "Task not found");

  const existing = await tx.chainControl.findUnique({
    where: { projectId_chainId: { projectId: input.projectId, chainId: input.chainId } },
  });
  if (!existing) return { control: null, duplicate: true, nextTaskId: null, gated: false };

  const priorRequest = await tx.chainControlEvent.findUnique({
    where: {
      chainControlId_kind_requestId: {
        chainControlId: existing.id,
        kind: ChainControlState.RELEASED,
        requestId: input.requestId,
      },
    },
  });
  if (priorRequest || existing.state !== ChainControlState.HELD) {
    return {
      control: chainControlMutationProjection(existing),
      duplicate: true,
      nextTaskId: null,
      gated: false,
    };
  }
  if (existing.heldLayer === null) throw new Error("Held Chain control is missing its held layer");

  let firstLayerTasks: ResumeFirstLayerTask[] = [];
  let activateFirstLayer = false;
  const beforeFirstLayer = heldBeforeFirstLayer(existing);
  if (beforeFirstLayer) {
    const firstExecutionLayer = chainRows
      .map(chainLayerOf)
      .filter((layer): layer is number => layer !== null)
      .sort((left, right) => left - right)[0];
    if (firstExecutionLayer === undefined) {
      return refusal("conflict", "Cannot resume Chain before its first layer; execution metadata is missing");
    }
    const firstLayerRows = chainRows
      .filter((row) => chainLayerOf(row) === firstExecutionLayer)
      .sort(chainOrder);
    const loaded = await tx.task.findMany({
      where: { id: { in: firstLayerRows.map((row) => row.id) } },
      include: RESUME_ADMISSION_INCLUDE,
    });
    const loadedById = new Map(loaded.map((task) => [task.id, task]));
    firstLayerTasks = firstLayerRows.map((row) => {
      const task = loadedById.get(row.id);
      if (!task) throw new Error(`Chain first layer task ${row.id} disappeared while resuming`);
      return task;
    });

    // A held-before-first Chain that is bound to an unfinished predecessor is
    // released but deliberately not started. The predecessor's terminal
    // completion owns the later bound dispatch. Likewise, any existing Run
    // means another admission already won and Resume must not mint a second.
    const predecessorDone = firstLayerTasks.every((task) => task.dispatchAfterTaskId === null
      || task.dispatchAfter?.status === TaskStatus.DONE);
    const firstLayerRunCount = await tx.run.count({ where: { taskId: { in: firstLayerRows.map((row) => row.id) } } });
    if (predecessorDone && firstLayerRunCount === 0) {
      for (const task of firstLayerTasks) {
        const startRefusal = await resumeFirstLayerRefusal(tx, task);
        if (startRefusal) return startRefusal;
      }
      activateFirstLayer = true;
    }
  }

  const anchor = beforeFirstLayer
    ? null
    : resumeActivationAnchor(chainRows, existing.heldExecutionLayer ?? existing.heldLayer);
  const anchorLayer = anchor === null ? null : chainLayerOf(anchor);
  const sourceRun = anchorLayer === null
    ? null
    : await tx.run.findFirst({
      where: {
        taskId: { in: chainRows.filter((row) => chainLayerOf(row) === anchorLayer).map((row) => row.id) },
        status: RunStatus.SUCCEEDED,
        session: { isNot: null },
      },
      orderBy: [{ endedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
  if (anchor !== null && sourceRun === null && resumeActivationNeedsSourceRun(chainRows, anchor)) {
    return refusal("conflict", "Cannot resume an approval layer without a succeeded source Run session");
  }

  const rawTx = tx as Prisma.TransactionClient & { $executeRawUnsafe?: (query: string) => Promise<number> };
  const hasSavepoint = activateFirstLayer && typeof rawTx.$executeRawUnsafe === "function";
  const savepoint = "chain_resume_first_layer";
  // A first-layer admission refusal after release must roll back the release
  // and its event. Production Prisma transactions support savepoints; the
  // fallback throws so a mocked transaction cannot silently commit a partial
  // Resume.
  if (hasSavepoint) await rawTx.$executeRawUnsafe!(`SAVEPOINT ${savepoint}`);

  // The state and generation predicate is the compare-and-set authority even
  // though the Chain mutex is the ordinary serializer.
  const releasedCount = await tx.chainControl.updateMany({
    where: {
      id: existing.id,
      state: ChainControlState.HELD,
      holdGeneration: existing.holdGeneration,
    },
    data: {
      state: ChainControlState.RELEASED,
      releasedAt: now,
      releaseRequestId: input.requestId,
    },
  });
  if (releasedCount.count !== 1) {
    const current = await tx.chainControl.findUniqueOrThrow({ where: { id: existing.id } });
    return {
      control: chainControlMutationProjection(current),
      duplicate: true,
      nextTaskId: null,
      gated: false,
    };
  }
  const released = await tx.chainControl.findUniqueOrThrow({ where: { id: existing.id } });
  await tx.chainControlEvent.create({
    data: {
      chainControlId: released.id,
      kind: ChainControlState.RELEASED,
      layer: existing.heldLayer,
      actorType: "operator",
      actorId: null,
      requestId: input.requestId,
      reason: null,
      createdAt: now,
      holdGeneration: existing.holdGeneration,
    },
  });

  if (activateFirstLayer && firstLayerTasks.length > 0) {
    for (const task of firstLayerTasks) {
      const opened = await enqueueTaskRunInternal(tx, task.id, now, null);
      if (!opened.ok) {
        if (hasSavepoint) {
          await rawTx.$executeRawUnsafe!(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await rawTx.$executeRawUnsafe!(`RELEASE SAVEPOINT ${savepoint}`);
          return refusal("conflict", opened.refusal.message);
        }
        throw errorForOpenRunRefusal(opened.refusal);
      }
      if (task.status === TaskStatus.BACKLOG) {
        await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.TODO } });
      }
      await tx.taskActivity.create({ data: {
        taskId: task.id,
        actorType: "control-plane",
        body: "Chain resumed; first step queued",
      } });
    }
    if (hasSavepoint) await rawTx.$executeRawUnsafe!(`RELEASE SAVEPOINT ${savepoint}`);
    return {
      control: chainControlMutationProjection(released),
      duplicate: false,
      nextTaskId: firstLayerTasks[0]!.id,
      gated: false,
    };
  }

  // A base-drift recovery whose authorization landed under this Hold left the
  // integrator Run birth on the aggregate. It is replayed before ordinary
  // activation, because the integrator's unresolved stop refuses an ordinary
  // enqueue: the replayed authorization is the only birth intent that may open
  // this Run, and once it has, activation reads the successor as already active
  // instead of parking it on the stop it cannot answer.
  const replayed = await replayHeldIntegratorAuthorization(tx, input, now);

  const activated = anchor
    ? await activateChainSuccessor(tx, anchor, { sourceRunId: sourceRun?.id ?? null }, now)
    : { nextTaskId: null, gated: false };
  return {
    control: chainControlMutationProjection(released),
    duplicate: false,
    nextTaskId: activated.nextTaskId ?? replayed?.integratorTaskId ?? null,
    gated: activated.gated,
    ...(replayed ? { replayedIntegratorRunId: replayed.runId } : {}),
  };
};

const addressedTaskBelongsToChain = async (
  tx: Prisma.TransactionClient,
  input: ChainControlAddress,
): Promise<boolean | null> => {
  const task = await tx.task.findUnique({
    where: { id: input.taskId },
    select: { id: true, projectId: true, chainId: true },
  });
  if (!task) return null;
  if (task.projectId !== input.projectId) return false;
  if (task.chainId !== null) return task.chainId === input.chainId;

  const markerRows = await tx.taskActivity.findMany({
    where: {
      taskId: task.id,
      actorType: "control-plane",
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  for (const row of markerRows) {
    const marker = markerFromMetadata(row.metadata);
    if (marker?.kind !== "repairAttempt" || !marker.regressionTaskId || !marker.repairKind) continue;
    const regression = await tx.task.findFirst({
      where: {
        id: marker.regressionTaskId,
        projectId: input.projectId,
        chainId: input.chainId,
      },
      select: { id: true },
    });
    if (regression) return true;
  }
  return false;
};

const readRepairTaskIds = async (
  tx: Prisma.TransactionClient,
  input: { projectId: string; chainTaskIds: string[] },
): Promise<string[]> => {
  if (input.chainTaskIds.length === 0) return [];
  const markerRows = await tx.taskActivity.findMany({
    where: {
      taskId: { in: input.chainTaskIds },
      actorType: "control-plane",
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const candidateIds = [...new Set(markerRows.flatMap((row) => {
    const marker = markerFromMetadata(row.metadata);
    return marker?.kind === "repairAttempt" && marker.repairKind && marker.repairTaskId
      ? [marker.repairTaskId]
      : [];
  }))];
  if (candidateIds.length === 0) return [];
  const repairs = await tx.task.findMany({
    where: { id: { in: candidateIds }, projectId: input.projectId, chainId: null },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return repairs.map((task) => task.id);
};

const lockTaskRowsById = async (
  tx: Prisma.TransactionClient,
  taskIds: string[],
): Promise<string[]> => {
  if (taskIds.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task"
    WHERE "id" = ANY(${taskIds})
    ORDER BY "id" FOR UPDATE
  `;
  return rows.map((row) => row.id);
};

const activeRunRefusal = (chainId: string): ChainControlRefusal => refusal(
  "conflict",
  `Cannot delete Chain ${chainId}; a member has an active run`,
  { code: "chain_delete_active_run", chainId },
);

export const chainRunHistoryRefusal = (chainId: string): ChainControlRefusal => refusal(
  "conflict",
  `Cannot delete Chain ${chainId}; a member has run history`,
  { code: "chain_delete_run_history", chainId },
);

export type DeleteChainResult = { deleted: number };

export const deleteChain = async (
  tx: Prisma.TransactionClient,
  input: ChainControlAddress,
): Promise<DeleteChainResult | ChainControlRefusal> => {
  await lockChainStructure(tx, input);
  const belongs = await addressedTaskBelongsToChain(tx, input);
  if (belongs === null) return refusal("not-found", "Task not found");
  if (!belongs) return refusal("conflict", "Task does not belong to a Chain");

  const chainTaskIds = await lockChainRows(tx, input);
  const repairTaskIds = await readRepairTaskIds(tx, {
    projectId: input.projectId,
    chainTaskIds,
  });
  const taskIds = [...new Set([...chainTaskIds, ...repairTaskIds])];
  // Refuse before taking a detached repair lock behind completion, which owns
  // the task and may be waiting for this Chain lock.
  const active = await tx.run.count({
    where: { taskId: { in: taskIds }, status: { in: ACTIVE_RUN_STATUSES } },
  });
  if (active > 0) return activeRunRefusal(input.chainId);

  const lockedRepairIds = await lockTaskRowsById(tx, repairTaskIds);
  const survivingTaskIds = [...new Set([...chainTaskIds, ...lockedRepairIds])];
  const activeAfterLock = await tx.run.count({
    where: { taskId: { in: survivingTaskIds }, status: { in: ACTIVE_RUN_STATUSES } },
  });
  if (activeAfterLock > 0) return activeRunRefusal(input.chainId);

  const runHistory = await tx.run.count({ where: { taskId: { in: survivingTaskIds } } });
  if (runHistory > 0) return chainRunHistoryRefusal(input.chainId);

  await tx.task.deleteMany({ where: { id: { in: survivingTaskIds } } });
  return { deleted: survivingTaskIds.length };
};
