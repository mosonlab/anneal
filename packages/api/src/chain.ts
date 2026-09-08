import {
  ACTIVE_RUN_STATUSES,
  AssigneeType,
  chainControlKey,
  readChainControlRecord,
  readChainControls,
  resumeActivationAnchor,
  resumeActivationNeedsSourceRun,
  type ChainControlSnapshot,
  isMergeReadinessStep,
  lockAgentRepoGrant,
  Prisma,
  type PrismaClient,
  budgetRemaining,
  highestBudgetGrants,
  TaskStatus,
} from "@anneal/db";
import { heldPredicate } from "@anneal/db/chain-hold";
import { compare, denseOrdinals, layerOf } from "@anneal/db/chain-order";

export { resumeActivationAnchor, resumeActivationNeedsSourceRun };

import type { Refusal } from "./refusal.js";

/**
 * The chain columns every consumer of this module needs, as a plain object.
 *
 * Deliberately not a Prisma payload type: `GET /tasks`, `GET /tasks/:id/chain`
 * and `GET /triggers/:id/fires` all assemble progress from differently-shaped
 * queries, and keeping the signature structural is what lets one implementation
 * serve all three — and be unit-tested without a database.
 */
export type ChainRow = {
  id: string;
  projectId: string;
  chainId: string | null;
  chainIndex: number | null;
  /** Stored execution layer. During the expand phase this may still be null
   *  on legacy fixtures; progress falls back to chainIndex for those rows. */
  chainLayer: number | null;
  name: string;
  status: TaskStatus;
  archivedAt: Date | null;
  templateStep: { name: string; stepIndex?: number; outputKind?: string } | null;
  /** A bound first task carries the predecessor id. The predecessor relation
   * is fetched only by the chain-detail route when that id is present; making
   * both fields optional keeps legacy board/progress callers unchanged. */
  dispatchAfterTaskId?: string | null;
  dispatchAfter?: Pick<DispatchPredecessor, "status"> | null;
};

export type DispatchPredecessor = {
  id: string;
  name: string;
  status: TaskStatus;
};

export type ChainProgress = {
  chainId: string;
  done: number;
  total: number;
  activeStepName: string;
  activeStatus: string;
  /** Dense one-based ordinal of the active stored layer. */
  currentLayer: number;
  /** Number of distinct execution layers in the chain. */
  layerCount: number;
};

/** The step's own name when it came from a template, else the task's. */
export const stepName = (row: Pick<ChainRow, "name" | "templateStep">): string => row.templateStep?.name ?? row.name;

const byChainIndex = (left: ChainRow, right: ChainRow): number => (left.chainIndex ?? 0) - (right.chainIndex ?? 0);

const chainLayerOf = <T extends { chainLayer?: number | null; chainIndex: number | null }>(row: T): number | null => layerOf({
  layer: row.chainLayer === undefined ? null : row.chainLayer,
  index: row.chainIndex,
});

const byExecutionPosition = <T extends { chainLayer?: number | null; chainIndex: number | null; id: string }>(
  left: T,
  right: T,
): number => compare(
  { layer: left.chainLayer === undefined ? null : left.chainLayer, index: left.chainIndex, id: left.id },
  { layer: right.chainLayer === undefined ? null : right.chainLayer, index: right.chainIndex, id: right.id },
);

/**
 * `n/m` plus the step the chain is currently sitting on.
 *
 * `total` is the row count, not `max(chainIndex) + 1`: a template with sparse
 * step indices would otherwise read "step 9 of 3". Archived rows count toward
 * both numbers — a step that was done and then archived is still done.
 */
export const chainProgress = (rows: ChainRow[]): Omit<ChainProgress, "chainId"> | null => {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort(byExecutionPosition);
  const done = ordered.filter((row) => row.status === TaskStatus.DONE).length;
  const active = ordered.find((row) => row.status !== TaskStatus.DONE) ?? ordered[ordered.length - 1]!;
  // The expand migration backfills every legacy row, but keeping the
  // chainIndex fallback makes progress safe for rows read while that migration
  // is staged. Stored layers may be sparse, zero-based, or one-based; the board
  // presents their dense rank instead. A malformed row missing both fields is
  // one final unknown layer rather than a layer invented from arrival order.
  const denseLayer = denseOrdinals(ordered.map((row) => ({ layer: row.chainLayer, index: row.chainIndex })));
  const activeLayer = layerOf(
    { layer: active.chainLayer, index: active.chainIndex },
    { missing: "last" },
  );
  const currentLayer = denseLayer.get(activeLayer);
  if (currentLayer === undefined) throw new Error(`Active Chain row ${active.id} has no dense layer ordinal`);
  return {
    done,
    total: ordered.length,
    activeStepName: stepName(active),
    activeStatus: active.status.toLowerCase(),
    currentLayer,
    layerCount: denseLayer.size,
  };
};

/**
 * `GET /tasks` is callable globally, with no projectId (the Projects page does
 * exactly that), and `chainId` is unique per project only by convention — no
 * constraint enforces it. Keying by the pair is what stops a task reading a
 * chain that belongs to another project.
 */
export const chainKey = chainControlKey;

export const chainProgressByChain = (rows: ChainRow[]): Map<string, ChainProgress> => {
  const groups = new Map<string, ChainRow[]>();
  for (const row of rows) {
    if (!row.chainId) continue;
    const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  const progress = new Map<string, ChainProgress>();
  for (const [key, group] of groups) {
    const computed = chainProgress(group);
    if (computed) progress.set(key, { chainId: group[0]!.chainId!, ...computed });
  }
  return progress;
};

/** 1-based ordinal within the chain, by chainIndex ascending. Not chainIndex
 *  itself, which is sparse whenever a template skips step numbers. */
export const positions = (rows: ChainRow[]): Map<string, number> => {
  const ordered = [...rows].sort(byChainIndex);
  return new Map(ordered.map((row, index) => [row.id, index + 1]));
};

/** What the route knows about a task's runs, in the facts `startable` needs.
 *  `total` is a count, not the latest run number: `Run` is genuinely one-to-many
 *  and a task at its ceiling whose last run is terminal must not look startable. */
export type RunFacts = {
  total: number;
  active: boolean;
  /** The highest `budgetGrants` any of the task's runs carries: attempts granted
   *  on top of the configured budget, refunds and human re-authorizations alike.
   *  Deliberately not `maxRunsPerTask`, which is the two added together and so
   *  cannot tell a refund from a budget an operator has since lowered. Null (or
   *  absent) means nothing granted, which is also what a caller that does not
   *  supply it gets — and that direction fails closed. */
  budgetGrants?: number | null;
};

export type StartableRow = {
  status: TaskStatus;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  repoId: string | null;
  archivedAt: Date | null;
  assigneeAgent: { archivedAt: Date | null } | null;
  /** The exact AgentRepoAccess row exists at decision time. */
  hasRepoGrant: boolean;
  /** Optional binding facts. Omitted means this is a historical/unbound row. */
  dispatchAfterTaskId?: string | null;
  dispatchAfter?: Pick<DispatchPredecessor, "status"> | null;
};

export type StartabilityChecklist = {
  repoBound: boolean;
  agentAssignee: boolean;
  repoAccessGrant: boolean;
  budgetRemaining: boolean;
  noActiveRun: boolean;
  predecessorsDone: boolean;
};

export type TaskStartability = {
  startable: boolean;
  checklist: StartabilityChecklist;
};

/** A binding is resolved only after its predecessor is durably DONE. A caller
 * that knows a row is bound but did not load the relation fails closed. */
export const dispatchBindingResolved = (
  row: Pick<StartableRow, "dispatchAfterTaskId" | "dispatchAfter">,
): boolean => row.dispatchAfterTaskId == null || row.dispatchAfter?.status === TaskStatus.DONE;

/** One verdict shared by every read surface and the authoritative start guard.
 *  The checklist is intentionally the operator-configurable subset requested by
 *  the board contract; task archive/status and archived-agent guards still
 *  participate in `startable` without pretending to be configuration items. */
export const taskStartability = (
  row: StartableRow,
  facts: RunFacts,
  maxSessionsPerTask: number,
  predecessorsDone: boolean,
): TaskStartability => {
  const bindingResolved = dispatchBindingResolved(row);
  const checklist = {
    repoBound: row.repoId !== null,
    agentAssignee: row.assigneeType === AssigneeType.AGENT && row.assigneeAgentId !== null,
    repoAccessGrant: row.hasRepoGrant,
    budgetRemaining: budgetRemaining(maxSessionsPerTask, facts),
    noActiveRun: !facts.active,
    predecessorsDone: predecessorsDone && bindingResolved,
  };
  return {
    checklist,
    startable: Object.values(checklist).every(Boolean)
      && row.assigneeAgent?.archivedAt !== undefined
      && row.assigneeAgent?.archivedAt === null
      && row.archivedAt === null
      && (row.status === TaskStatus.TODO || row.status === TaskStatus.BACKLOG),
  };
};

/** The first unfinished surviving row before target, or null when the ordered
 * prefix is complete. This is the predecessor named by the 409 response. */
export const blockingPredecessor = <T extends Pick<ChainRow, "chainIndex" | "id" | "name" | "status"> & { chainLayer?: number | null }>(
  rows: T[],
  targetId: string,
): T | null => {
  const ordered = [...rows].sort(byExecutionPosition);
  const target = ordered.find((item) => item.id === targetId);
  if (!target) return null;
  const targetLayer = chainLayerOf(target);
  return ordered.find((item) => {
    const itemLayer = chainLayerOf(item);
    return itemLayer !== null && targetLayer !== null
      ? itemLayer < targetLayer && item.status !== TaskStatus.DONE
      : item.id !== target.id && item.status !== TaskStatus.DONE;
  }) ?? null;
};

/** One grouped run query → per-task facts. Constant in task count, which is what
 *  makes "no N+1" a property of this function rather than a rule three routes
 *  have to remember. */
export const runFactsByTask = (
  // `taskId` is nullable in Prisma's groupBy output even though Run.taskId is
  // not; rows without one are skipped rather than cast away.
  rows: Array<{
    taskId: string | null;
    status: string;
    _count: { _all: number };
    _max?: { budgetGrants: number | null };
  }>,
  activeStatuses: readonly string[],
): Map<string, RunFacts> => {
  const facts = new Map<string, RunFacts>();
  for (const row of rows) {
    if (row.taskId === null) continue;
    const current = facts.get(row.taskId) ?? { total: 0, active: false, budgetGrants: null };
    facts.set(row.taskId, {
      total: current.total + row._count._all,
      active: current.active || activeStatuses.includes(row.status),
      // A max across the status groups, not the newest run's value: the groupBy
      // is unordered, and grants only ever grow, so the two agree.
      budgetGrants: highestBudgetGrants([current.budgetGrants, row._max?.budgetGrants]) || null,
    });
  }
  return facts;
};

const admissionTaskInclude = {
  assigneeAgent: { select: { id: true, name: true, title: true, archivedAt: true } },
  repo: { select: { id: true, name: true, defaultBranch: true } },
  dispatchAfter: { select: { id: true, name: true, status: true } },
  templateStep: {
    select: {
      stepIndex: true,
      outputKind: true,
      taskTemplate: { select: { name: true } },
    },
  },
} as const satisfies Prisma.TaskInclude;

export type StepAdmissionTask = Prisma.TaskGetPayload<{ include: typeof admissionTaskInclude }>;

export type FoundStepAdmission = {
  task: StepAdmissionTask;
  facts: RunFacts;
  verdict: TaskStartability;
  blocker: { id: string; name: string } | null;
  /** A Chain control refusal is separate because Retry has terminal-state
   * rules that deliberately differ from Start's ordinary status ladder. */
  holdRefusal: Refusal | null;
  refusal: Refusal | null;
};

export type StepAdmission =
  | FoundStepAdmission
  | {
    task: null;
    facts: null;
    verdict: null;
    blocker: null;
    refusal: Refusal;
  };

type ReadStepAdmissionOptions = {
  locked: boolean;
  /**
   * A caller that already read the controls in the same transaction can pass
   * them here. The chain-detail route uses this to project the same authority
   * row it used for admission without issuing a second ChainControl query.
   */
  controls?: ReadonlyMap<string, ChainControlSnapshot | undefined>;
};

const grantKey = (input: { projectId: string; agentId: string; repoId: string }): string => (
  `${input.projectId}:${input.agentId}:${input.repoId}`
);

/**
 * The Chain hold is a control barrier, not another startability checklist
 * item. Keep its refusal pure and separate so every admission consumer can
 * use the same layer comparison while Retry can consume only this refusal and
 * retain its legitimate terminal/status rules.
 *
 * `chainLayer` is authoritative for expanded rows; the chainIndex fallback is
 * required for rows read during the nullable expand migration and for legacy
 * unit fixtures. A released or absent control is exactly the unheld state.
 */
export const refusalForHeldChainStep = (
  task: Pick<StepAdmissionTask, "projectId" | "chainId" | "chainIndex" | "chainLayer" | "name">,
  control: ChainControlSnapshot | null | undefined,
): Refusal | null => {
  if (!control || !heldPredicate({
    projectId: task.projectId,
    chainId: task.chainId,
    layer: task.chainLayer,
    index: task.chainIndex,
  }, control)) return null;
  const taskLayer = chainLayerOf(task);
  // A held control is only valid with a persisted layer, but fail closed if a
  // malformed legacy row reaches admission: an unknown layer must not bypass
  // an active Chain barrier.
  if (control.heldLayer === 0) {
    return { reason: "conflict", message: `Cannot start ${task.name}; Chain is held before its first layer` };
  }
  if (taskLayer === null || control.heldLayer === null) {
    return { reason: "conflict", message: `Cannot start ${task.name}; Chain is held` };
  }
  return {
    reason: "conflict",
    message: `Cannot start ${task.name}; Chain is held after layer ${control.heldLayer}`,
  };
};

const refusalForStepAdmission = (
  task: StepAdmissionTask,
  verdict: TaskStartability,
  blocker: { id: string; name: string } | null,
  holdRefusal: Refusal | null,
): Refusal | null => {
  if (holdRefusal) return holdRefusal;
  if (!verdict.checklist.predecessorsDone) {
    if (blocker) {
      return { reason: "conflict", message: `Cannot start ${task.name}; predecessor ${blocker.name} is not done` };
    }
    const predecessorName = task.dispatchAfter?.name ?? task.dispatchAfterTaskId;
    return {
      reason: "conflict",
      message: `Cannot start ${task.name}; bound predecessor ${predecessorName ?? "unknown"} is not done`,
    };
  }
  if (task.archivedAt !== null) return { reason: "conflict", message: "Cannot start an archived task" };
  if (task.status === TaskStatus.DONE) return { reason: "conflict", message: "Task is already done" };
  if (task.assigneeType !== AssigneeType.AGENT) {
    return { reason: "conflict", message: "Human steps cannot be started" };
  }
  if (isMergeReadinessStep(task.templateStep)) {
    return { reason: "conflict", message: "Merge readiness is server-owned and cannot be started as a model run" };
  }
  if (!verdict.checklist.noActiveRun) {
    return { reason: "conflict", message: "Task already has an active run" };
  }
  if (!verdict.checklist.budgetRemaining) return { reason: "conflict", message: "Run budget exhausted" };
  if (task.status !== TaskStatus.TODO && task.status !== TaskStatus.BACKLOG) {
    return { reason: "conflict", message: "Only Todo and Backlog steps can be started" };
  }
  if (!verdict.checklist.repoBound) return { reason: "invalid-request", message: "This task has no repository" };
  if (!verdict.checklist.agentAssignee) return { reason: "invalid-request", message: "This task has no assignee" };
  if (!verdict.checklist.repoAccessGrant) {
    return { reason: "invalid-request", message: "Assignee has no grant for this Repo" };
  }
  if (task.assigneeAgent?.archivedAt) {
    return {
      reason: "archived-assignee",
      message: `Task ${task.name} assignee ${task.assigneeAgent.name} is archived; unarchive the agent to queue this step`,
    };
  }
  if (!verdict.startable) return { reason: "conflict", message: "This step cannot be started" };
  return null;
};

/**
 * Reads every fact that decides whether a Step may start and names the first
 * refusal from the same checklist. Mutation callers hold the Task/Chain mutex
 * before requesting `locked`; that mode also holds the exact Repo grant through
 * Run creation, while read callers use an ordinary grant read.
 */
export const readStepAdmissions = async (
  tx: Prisma.TransactionClient,
  taskIds: string[],
  options: ReadStepAdmissionOptions,
): Promise<Map<string, FoundStepAdmission>> => {
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return new Map();
  if (options.locked && ids.length !== 1) {
    throw new Error("Locked Step admission reads exactly one Step");
  }
  const tasks = await tx.task.findMany({ where: { id: { in: ids } }, include: admissionTaskInclude });
  const grantInputs = tasks.flatMap((task) => (
    task.assigneeAgentId !== null && task.repoId !== null
      ? [{ projectId: task.projectId, agentId: task.assigneeAgentId, repoId: task.repoId }]
      : []
  ));
  // A partial legacy identity still belongs to its persisted Chain control.
  // Key on chainId alone so a null chainIndex cannot bypass a held barrier;
  // refusalForHeldChainStep will fail closed when no execution layer exists.
  const chainInputs = [...new Map(tasks.flatMap((task) => (
    task.chainId !== null
      ? [[chainKey({ projectId: task.projectId, chainId: task.chainId }), {
        projectId: task.projectId,
        chainId: task.chainId,
      }] as const]
      : []
  ))).values()];
  const [runGroups, chainRows, controls, grantRows] = await Promise.all([
    tx.run.groupBy({
      by: ["taskId", "status"],
      where: { taskId: { in: ids } },
      _count: { _all: true },
      _max: { budgetGrants: true },
    }),
    chainInputs.length > 0
      ? tx.task.findMany({
        where: { OR: chainInputs },
        select: { id: true, projectId: true, chainId: true, name: true, status: true, chainIndex: true, chainLayer: true },
      })
      : [],
    // Keep control reads in the same batch as the existing admission facts.
    // `readChainControls` returns absent rows as not-held snapshots and issues
    // one OR query for all Chain keys, never one lookup per Task. A chain-detail
    // caller may provide its already-read control map so the projection and
    // admission share one authority query and one transaction snapshot.
    options.controls ?? readChainControls(tx, chainInputs),
    grantInputs.length === 0
      ? []
      : options.locked
        ? Promise.all(grantInputs.map(async (input) => (
          await lockAgentRepoGrant(tx, input) ? input : null
        ))).then((rows) => rows.filter((row): row is (typeof grantInputs)[number] => row !== null))
        : tx.agentRepoAccess.findMany({
          where: { OR: grantInputs },
          select: { projectId: true, agentId: true, repoId: true },
        }),
  ]);
  const factsByTask = runFactsByTask(runGroups, ACTIVE_RUN_STATUSES);
  const granted = new Set(grantRows.map(grantKey));
  const rowsByChain = new Map<string, Array<(typeof chainRows)[number]>>();
  for (const row of chainRows) {
    if (row.chainId === null) continue;
    const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
    const rows = rowsByChain.get(key);
    if (rows) rows.push(row); else rowsByChain.set(key, [row]);
  }
  return new Map(tasks.map((task): [string, FoundStepAdmission] => {
    const facts = factsByTask.get(task.id) ?? { total: 0, active: false, budgetGrants: null };
    const hasRepoGrant = task.assigneeAgentId !== null && task.repoId !== null
      && granted.has(grantKey({ projectId: task.projectId, agentId: task.assigneeAgentId, repoId: task.repoId }));
    const chain = task.chainId !== null
      ? rowsByChain.get(chainKey({ projectId: task.projectId, chainId: task.chainId })) ?? []
      : [];
    const control = task.chainId !== null
      ? controls.get(chainKey({ projectId: task.projectId, chainId: task.chainId }))
      : undefined;
    const blocker = blockingPredecessor(chain, task.id);
    const baseVerdict = taskStartability(
      { ...task, hasRepoGrant },
      facts,
      task.maxSessionsPerTask,
      blocker === null,
    );
    const holdRefusal = refusalForHeldChainStep(task, control);
    const refused = refusalForStepAdmission(task, baseVerdict, blocker, holdRefusal);
    return [task.id, {
      task,
      facts,
      verdict: { ...baseVerdict, startable: baseVerdict.startable && refused === null },
      blocker: blocker ? { id: blocker.id, name: blocker.name } : null,
      holdRefusal,
      refusal: refused,
    }];
  }));
};

export const readStepAdmission = async (
  tx: Prisma.TransactionClient,
  taskId: string,
  options: ReadStepAdmissionOptions,
): Promise<StepAdmission> => (
  await readStepAdmissions(tx, [taskId], options)
).get(taskId) ?? {
  task: null,
  facts: null,
  verdict: null,
  blocker: null,
  refusal: { reason: "not-found", message: "Task not found" },
};

/** The `ChainStep.agent` projection, in one place the contract's shape and the
 *  query's select cannot drift apart. */
export const chainStepAgent = (row: {
  assigneeAgent: { id: string; title: string; name: string; model: string } | null;
}): { id: string; title: string; name: string; model: string } | null => (
  row.assigneeAgent === null
    ? null
    : {
      id: row.assigneeAgent.id,
      title: row.assigneeAgent.title,
      name: row.assigneeAgent.name,
      model: row.assigneeAgent.model,
    }
);

/**
 * §R5, read side: may this step's assignee be changed right now?
 *
 * The same fact the write guard in `task-write.ts` decides on — no Run of this
 * task in `ACTIVE_RUN_STATUSES` — projected from the admission facts the chain
 * route already reads, so the console never offers a reassignment the PATCH
 * would answer with a 409. A step whose admission facts are missing fails
 * closed: an unknown Run state must not read as "safe to reassign".
 */
export const chainStepReassignable = (admission: FoundStepAdmission | undefined): boolean => (
  admission !== undefined && !admission.facts.active
);

const chainDetailInclude = {
  assigneeAgent: { select: { id: true, title: true, name: true, model: true, archivedAt: true } },
  templateStep: {
    select: {
      name: true,
      stepIndex: true,
      outputKind: true,
      taskTemplate: { select: { name: true } },
    },
  },
  runs: { orderBy: { runNumber: "desc" as const }, take: 1 },
} as const satisfies Prisma.TaskInclude;

export type ChainDetailRead =
  | { kind: "not-found" }
  | { kind: "chainless" }
  | {
    kind: "chain";
    chainId: string;
    rows: Array<Prisma.TaskGetPayload<{ include: typeof chainDetailInclude }> & {
      dispatchAfter: DispatchPredecessor | null;
    }>;
    firstTaskId: string | null;
    dispatchAfter: DispatchPredecessor | null;
    admissions: Map<string, FoundStepAdmission>;
    control: Awaited<ReturnType<typeof readChainControlRecord>>;
    recoveryRow: Awaited<ReturnType<PrismaClient["mergeRecoveryAttempt"]["findFirst"]>>;
  };

/** All database reads behind GET Chain, leaving only HTTP projection in app. */
export const readChainDetail = async (
  db: PrismaClient,
  taskId: string,
): Promise<ChainDetailRead> => {
  const subject = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, chainId: true, chainIndex: true },
  });
  if (!subject) return { kind: "not-found" };
  if (!subject.chainId) return { kind: "chainless" };

  // A malformed null-index row remains its own one-row Chain instead of
  // shifting the positions of valid rows that happen to share its chainId.
  const storedRows = subject.chainIndex === null
    ? [await db.task.findUniqueOrThrow({ where: { id: taskId }, include: chainDetailInclude })]
    : await db.task.findMany({
      where: { projectId: subject.projectId, chainId: subject.chainId, chainIndex: { not: null } },
      orderBy: { chainIndex: "asc" },
      include: chainDetailInclude,
    });
  const firstTask = [...storedRows].sort(byExecutionPosition)[0] ?? null;
  const dispatchAfterTaskId = firstTask?.dispatchAfterTaskId ?? null;
  const dispatchAfter = dispatchAfterTaskId === null
    ? null
    : await db.task.findFirst({
      where: { id: dispatchAfterTaskId, projectId: subject.projectId },
      select: { id: true, name: true, status: true },
    });
  const rows = storedRows.map((row) => ({
    ...row,
    dispatchAfter: row.id === firstTask?.id ? dispatchAfter : null,
  }));
  const chainId = subject.chainId;
  const [chainRead, recoveryRow] = await Promise.all([
    db.$transaction(async (tx) => {
      const control = await readChainControlRecord(tx, { projectId: subject.projectId, chainId });
      const controls: ReadonlyMap<string, ChainControlSnapshot> = control === null
        ? new Map()
        : new Map([[chainKey(control), { ...control, held: control.state === "HELD" }]]);
      const admissions = await readStepAdmissions(tx, rows.map((row) => row.id), { locked: false, controls });
      return { admissions, control };
    }),
    db.mergeRecoveryAttempt.findFirst({
      where: { integratorTask: { projectId: subject.projectId, chainId } },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    }),
  ]);
  return {
    kind: "chain",
    chainId,
    rows,
    firstTaskId: firstTask?.id ?? null,
    dispatchAfter,
    admissions: chainRead.admissions,
    control: chainRead.control,
    recoveryRow,
  };
};
