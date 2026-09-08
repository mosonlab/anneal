import { createHash } from "node:crypto";

import {
  ACTIVE_RUN_STATUSES,
  EMPTY_READINESS_REQUEUE_TOTALS,
  highestBudgetGrants,
  readChainControls,
  isIntegratorStep,
  markerFromMetadata,
  MERGE_READINESS_OUTPUT_KIND,
  MERGE_TAIL_KIND,
  projectMergeOutcome,
  readinessRequeueActivityWhere,
  readinessRequeueTotals,
  runOwnsMergeOutcome,
  runSessionUsageCost,
  spendCapUsage,
  usd,
  type SpendCapUsage,
  sumUsageCosts,
  TaskStatus,
  type AssigneeType,
  type ChainControlSnapshot,
  type Marker,
  type Prisma,
  type PrismaClient,
  type ReadinessRequeueTotals,
  type ScheduleKind,
  type SessionExecutionStatus,
  type TaskSource,
  type TaskStatus as TaskStatusType,
  type UsageCost,
} from "@anneal/db";
import type {
  BoardCard as BoardContractCard,
  BoardClaimRefusal as BoardContractClaimRefusal,
  RunBaseline as BoardContractRunBaseline,
  BoardChainActivationState as BoardContractChainActivationState,
  BoardLatestRun as BoardContractLatestRun,
  BoardMoveTarget as BoardContractMoveTarget,
  ChainAggregate as BoardContractChainAggregate,
  RepairBinding as BoardContractRepairBinding,
  RunStatus as BoardRunStatus,
  SpendCapUsageProjection,
  StrandedSalvageBranch as BoardContractStrandedSalvageBranch,
  TaskList as TaskListContract,
  UsageCost as BoardUsageCost,
} from "@anneal/db/board-contract";
import { MECHANICAL_CONTRACT_MISMATCH_CODE } from "@anneal/db/claim-contract";
import { compare } from "@anneal/db/chain-order";
import type { SerializesTo } from "@anneal/db/wire-serialization";

import { chainExecutionOwner } from "./chain-execution-owner.js";
import {
  blockingPredecessor,
  chainKey,
  chainProgressByChain,
  positions,
  taskStartability,
  type ChainProgress,
} from "./chain.js";
import { baselineKey, readRunBaselines } from "./run-baseline.js";
import { runPhase } from "./run-metrics.js";
import { taskMoveAuthority } from "./task-move-authority.js";

/**
 * The Tasks board's own wire shape.
 *
 * `GET /tasks` returns the whole Task row plus `assigneeAgent`, `repo` and the
 * latest `Run` *with its Session* — 1.58 MB for 112 cards, of which the board
 * renders about 5%. Every 2.5s poll downloaded, decoded and compared all of it.
 *
 * A projection rather than a second endpoint: the board's card is a *view* of
 * the same list the full response serves, and two routes would let the two
 * drift. `?view=board` is the caller saying which fields it will actually read.
 *
 * Every field here is consumed by the board surface: nearly all by `TaskCard`,
 * with `createdAt` used by `TasksPage` to order the Backlog queue and
 * `moveTargets` routing operator moves. Adding one is a deliberate act; the
 * point of the shape is that its cost is legible.
 */
export type BoardMoveTarget = BoardContractMoveTarget;
/** Compile-time proof that JSON serialization turns the native projection into
 * the exact shared browser contract, at every depth. `boardCard` returns this
 * type, so a projected key the contract does not name, or a `Date` the browser
 * reads as a `string`, fails where the projection is written. */
export type BoardCard = SerializesTo<BoardContractCard<Date>, BoardContractCard>;
export type BoardLatestRun = BoardContractLatestRun<Date>;
export type StrandedSalvageBranch = BoardContractStrandedSalvageBranch;
export type BoardChainActivationState = BoardContractChainActivationState;
export type RepairBinding = BoardContractRepairBinding;
export type BoardChainControl = Pick<ChainControlSnapshot, "state" | "held" | "heldLayer" | "heldAt" | "holdReason">;

/** The Prisma row shape `boardCard` needs — declared structurally so `readBoard`
 *  can select exactly these columns and nothing else. */
export type BoardRow = {
  id: string;
  projectId: string;
  name: string;
  status: TaskStatusType;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  repoId: string | null;
  archivedAt: Date | null;
  maxSessionsPerTask: number;
  spendCap: Prisma.Decimal | null;
  failureReason: string | null;
  scheduleKind: ScheduleKind;
  runAt: Date | null;
  cron: string | null;
  timezone: string | null;
  approvalGate: boolean;
  templateId: string | null;
  source: TaskSource;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer: number | null;
  dispatchAfterTaskId: string | null;
  /** The card's baseline population key. Not projected itself — it is what the
   *  one grouped baseline query for the page is keyed by. */
  templateStepId: string | null;
  createdAt: Date;
  updatedAt: Date;
  assigneeAgent: { id: string; name?: string; title: string; model: string; archivedAt: Date | null } | null;
  templateStep: {
    name: string;
    stepIndex?: number;
    outputKind?: string;
    taskTemplate?: { name: string };
  } | null;
  runs: Array<{
    id: string;
    runNumber: number;
    status: BoardRunStatus;
    model: string;
    codexServiceTier: BoardContractLatestRun["codexServiceTier"];
    subagentModel?: string | null;
    budgetGrants: number;
    leaseLossRefunds: number;
    /** Required, unlike `subagentModel`: this one reaches the board contract,
     *  where `BoardLatestRun.pullRequestUrl` is required. Optional here would
     *  let a select that forgets it type-check and project null, dropping the
     *  card's pull request link with no compile error. */
    pullRequestUrl: string | null;
    /** Salvage evidence is required so a select that forgets either column
     * cannot silently erase the operator-facing stranded-salvage signal. */
    pushedBranch: string | null;
    baseSha: string | null;
    /** Required, like `pullRequestUrl`: the phase a card names is computed from
     *  these four columns and the session timestamps below, so a select that
     *  forgets one has to fail to compile rather than project a run that is
     *  permanently queued. */
    readyAt: Date;
    /** Read only to qualify a claim-refusal activity; it never reaches the
     *  browser projection. Required so both selects must supply it. */
    createdAt: Date;
    /** Run start, retained across all attempts for the Chain lead-time origin. */
    startedAt: Date | null;
    endedAt: Date | null;
    lastProgressEventAt: Date | null;
    maxRunsPerTask: number;
    session: {
      nativeChildUsed: boolean;
      costUsd: NonNullable<Parameters<typeof runSessionUsageCost>[0]["session"]>["costUsd"];
      inputTokens: number | null;
      cachedInputTokens: number | null;
      cacheCreationInputTokens: number | null;
      outputTokens: number | null;
      waitingOnMessageId?: string | null;
      inboxWaitStartedAt?: Date | null;
      executionStatus: SessionExecutionStatus;
      provisionedAt: Date | null;
      startedAt: Date | null;
      endedAt: Date | null;
      cleanupStartedAt: Date | null;
      cleanupEndedAt: Date | null;
    } | null;
    /** Internal read-model annotation; `latestRunProjectionFromRun` emits it
     *  only on the latest queued Run. */
    claimRefusal?: BoardContractClaimRefusal<Date>;
  }>;
  stepOutput?: { kind: string; body: string; runId: string | null } | null;
};

/** The predecessor row resolved in one batch for the current board page. */
export type BoardBlockedOnTask = {
  id: string;
  name: string;
  status: TaskStatusType;
};

/** Decimal columns arrive as Prisma.Decimal; the web client reads them as the
 *  strings JSON already turns them into, so the projection states that. */
const decimal = (value: unknown): string | null =>
  (value === null || value === undefined ? null : String(value));

export type SerializedUsageCost = BoardUsageCost;

export const serializeUsageCost = (cost: UsageCost | null): SerializedUsageCost | null =>
  cost === null ? null : { ...cost, costUsd: decimal(cost.costUsd) };

/** Not `decimal()`: a cap and its spend are money from the `spend-cap.ts`
 *  basis, and that module owns the one rendering they all share with the
 *  refusal message, its metadata and the operator's cap-edit trail. */
export const serializeSpendCapUsage = (
  usage: SpendCapUsage | null,
): SpendCapUsageProjection | null => usage === null ? null : {
  capUsd: usd(usage.capUsd),
  spentUsd: usd(usage.spentUsd),
  exhausted: usage.exhausted,
};

type StrandedSalvageRun = Pick<BoardRow["runs"][number], "runNumber" | "status" | "pushedBranch" | "baseSha">;

/**
 * Derive durable salvage refs that were stranded by a later Run starting from
 * the LOST Run's original base. Run rows belong to one Task by construction;
 * `runNumber` is the persisted ordering that identifies a later attempt.
 *
 * A missing base SHA cannot establish the race, even when both rows happen to
 * be null, so both sides of the comparison must be populated. The result is
 * oldest-first to give operators a stable chronological list.
 */
export const strandedSalvageBranchesFromRuns = (
  runs: readonly StrandedSalvageRun[],
): StrandedSalvageBranch[] => runs
  .filter((run) => (
    run.status === "LOST"
    && typeof run.pushedBranch === "string"
    && run.pushedBranch.length > 0
    && typeof run.baseSha === "string"
    && run.baseSha.length > 0
    && runs.some((later) => (
      later.runNumber > run.runNumber
      && typeof later.baseSha === "string"
      && later.baseSha === run.baseSha
    ))
  ))
  .sort((left, right) => left.runNumber - right.runNumber)
  .map((run) => ({ branch: run.pushedBranch!, lostRunNumber: run.runNumber }));

type MoveProjectionFacts = {
  dispatchAfter?: BoardBlockedOnTask | null;
  chainPredecessor?: { name: string } | null;
  stopStateRefusal?: string | null;
};

/** Project operator destinations from the move authority shared with
 * `PATCH /tasks/:id`. A startable standalone Agent queue task may additionally
 * reach Doing through the start action; it is never represented as a PATCH. */
export const operatorMoveTargets = (
  task: Pick<BoardRow,
    | "name" | "status" | "assigneeType" | "chainId" | "archivedAt"
    | "dispatchAfterTaskId" | "assigneeAgentId" | "assigneeAgent" | "templateStep"
  >,
  startability: { startable: boolean; checklist: { predecessorsDone: boolean; noActiveRun: boolean } },
  projected: MoveProjectionFacts = {},
): BoardMoveTarget[] => {
  const dispatchAfter = projected.dispatchAfter !== undefined
    ? projected.dispatchAfter
    : task.dispatchAfterTaskId === null || startability.checklist.predecessorsDone
      ? null
      : { id: task.dispatchAfterTaskId, name: task.dispatchAfterTaskId, status: TaskStatus.TODO };
  const assigneeName = task.assigneeAgent?.name ?? task.assigneeAgent?.title ?? task.assigneeAgentId;
  const reactivationRefusal = task.assigneeAgentId === null
    ? null
    : task.assigneeAgent === null
      ? "Assignee does not belong to this project"
      : task.assigneeAgent.archivedAt === null
        ? null
        : `Assignee ${assigneeName} is archived; unarchive the agent or reassign this task first`;
  const templateStep = task.templateStep?.stepIndex === undefined
    || task.templateStep.outputKind === undefined
    || task.templateStep.taskTemplate === undefined
    ? null
    : {
        stepIndex: task.templateStep.stepIndex,
        outputKind: task.templateStep.outputKind,
        taskTemplate: task.templateStep.taskTemplate,
      };
  const stopStateRefusal = projected.stopStateRefusal !== undefined
    ? projected.stopStateRefusal
    : isIntegratorStep(templateStep) ? undefined : null;
  const chainPredecessor = projected.chainPredecessor !== undefined
    ? projected.chainPredecessor
    : task.chainId !== null && !startability.checklist.predecessorsDone
      ? { name: "an earlier Chain task" }
      : null;
  const authority = taskMoveAuthority({
    name: task.name,
    status: task.status,
    assigneeType: task.assigneeType,
    chainId: task.chainId,
    archivedAt: task.archivedAt,
    dispatchAfterTaskId: task.dispatchAfterTaskId,
    dispatchAfter,
    reactivationRefusal,
    activeRun: !startability.checklist.noActiveRun,
    stopStateRefusal,
    chainPredecessor,
  });
  const targets = authority.targets.map((status): BoardMoveTarget => ({ status, via: "patch" }));
  const startsStandaloneAgent = task.chainId === null
    && task.assigneeType === "AGENT"
    && (task.status === TaskStatus.BACKLOG || task.status === TaskStatus.TODO);
  if (startsStandaloneAgent && startability.startable) {
    targets.push({ status: TaskStatus.DOING, via: "start" });
  }
  return startability.checklist.predecessorsDone ? targets : [];
};

/** The fields of a primary step or detached repair needed by the aggregate. */
export type BoardChainMember = {
  id: string;
  projectId: string;
  name: string;
  displayName?: string;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer: number | null;
  status: TaskStatusType;
  failureReason: string | null;
  dispatchAfterTaskId: string | null;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  templateStep: { name: string } | null;
  /** Present only for detached merge-tail repairs; primary steps omit it. */
  repairKind?: string;
  runs: BoardRow["runs"];
  stepOutput?: BoardRow["stepOutput"];
};

const latestRunProjection = (runs: readonly BoardRow["runs"][number][] | null | undefined): BoardLatestRun | null => {
  const run = runs?.[0];
  return run === undefined ? null : latestRunProjectionFromRun(run);
};

const latestRunProjectionFromRun = (run: BoardRow["runs"][number]): BoardLatestRun => {
  // The one phase rule the detail page's diagnostics also go through, so a card
  // and the table behind it can never name different phases for one run.
  const phase = runPhase(run, run.session);
  return {
    id: run.id,
    runNumber: run.runNumber,
    status: run.status,
    model: run.model,
    codexServiceTier: run.codexServiceTier,
    costUsd: decimal(run.session?.costUsd),
    startedAt: run.session?.startedAt ?? null,
    endedAt: run.session?.endedAt ?? null,
    pullRequestUrl: run.pullRequestUrl ?? null,
    phase: phase.phase,
    phaseSince: phase.phaseSince,
    lastProgressEventAt: run.lastProgressEventAt,
    maxRunsPerTask: run.maxRunsPerTask,
    ...(run.status === "QUEUED" && run.claimRefusal !== undefined ? { claimRefusal: run.claimRefusal } : {}),
  };
};

/** Bind a merge result to the newest Run displayed beside it. */
const latestRunMergeOutcome = (
  runs: readonly Pick<BoardRow["runs"][number], "id">[] | null | undefined,
  stepOutput: BoardRow["stepOutput"],
): BoardCard["mergeOutcome"] => {
  const run = runs?.[0];
  return run !== undefined && runOwnsMergeOutcome(stepOutput, run.id, run.id)
    ? projectMergeOutcome(stepOutput)
    : null;
};

const memberUsageCost = (member: Pick<BoardChainMember, "runs">): UsageCost | null =>
  sumUsageCosts((member.runs ?? []).flatMap((run) => run.session === null ? [] : [runSessionUsageCost(run)!]));

const chainStatuses = (): Record<TaskStatusType, number> => ({
  [TaskStatus.BACKLOG]: 0,
  [TaskStatus.TODO]: 0,
  [TaskStatus.DOING]: 0,
  [TaskStatus.REVIEW]: 0,
  [TaskStatus.DONE]: 0,
});

const chainMemberOrder = (left: BoardChainMember, right: BoardChainMember): number => compare(
  { layer: left.chainLayer, index: left.chainIndex, id: left.id },
  { layer: right.chainLayer, index: right.chainIndex, id: right.id },
);

const memberTitle = (member: BoardChainMember): string => member.displayName
  ?? member.templateStep?.name
  ?? member.name;

const isActiveLatestRun = (member: Pick<BoardChainMember, "runs">): boolean => {
  const status = (member.runs ?? [])[0]?.status;
  return status !== undefined && ACTIVE_RUN_STATUSES.includes(status as (typeof ACTIVE_RUN_STATUSES)[number]);
};

type ActiveRepairMember = BoardChainMember & {
  repairKind: string;
  runs: [BoardRow["runs"][number], ...BoardRow["runs"][number][]];
};

const isActiveRepairMember = (member: BoardChainMember): member is ActiveRepairMember =>
  member.repairKind !== undefined && member.runs.length > 0 && isActiveLatestRun(member);

/**
 * Derive the single board card projection for one chain. `primaryMembers` are
 * the persisted chain rows and define step progress/frontier. `repairMembers`
 * are chain-detached merge-tail repairs: they affect placement and spend, but
 * never make a chain appear to have more primary steps than it does.
 */
export const chainAggregate = (
  chainId: string,
  chainName: string | null,
  primaryMembers: readonly BoardChainMember[],
  repairMembers: readonly BoardChainMember[],
  predecessorById: ReadonlyMap<string, BoardBlockedOnTask> = new Map(),
  control: BoardChainControl | null = null,
): BoardContractChainAggregate<Date> => {
  const primary = [...primaryMembers].sort(chainMemberOrder);
  const repairs = [...repairMembers].sort(chainMemberOrder);
  const members = [...primary, ...repairs];
  // A malformed response should never manufacture a member. A chain aggregate
  // is only built for a real primary or repair row, but keep this guard so the
  // pure helper remains honest when called directly.
  if (members.length === 0) throw new Error(`Cannot aggregate empty chain ${chainId}`);

  const stepStatusCounts = chainStatuses();
  for (const member of primary) stepStatusCounts[member.status] += 1;

  const unfinishedPrimary = primary.filter((member) => member.status !== TaskStatus.DONE);
  const unfinishedRepairs = repairs.filter((member) => member.status !== TaskStatus.DONE);
  // A repair is the frontier only after all primary steps have settled. Before
  // then the chain's own lowest unfinished layer is the operator's useful
  // frontier; repair state still participates in active/terminal placement.
  const frontierMember = unfinishedPrimary[0]
    ?? unfinishedRepairs[0]
    ?? primary[primary.length - 1]
    ?? repairs[repairs.length - 1]!;
  const active = members.some((member) => member.status === TaskStatus.DOING || isActiveLatestRun(member));
  const allDone = members.every((member) => member.status === TaskStatus.DONE);
  const columnStatus = active
    ? TaskStatus.DOING
    : allDone
      ? TaskStatus.DONE
      : frontierMember.status;

  const firstPrimary = primary[0];
  const waitingMember = primary.find((member) => {
    if (member.dispatchAfterTaskId === null) return false;
    const predecessor = predecessorById.get(member.dispatchAfterTaskId);
    return predecessor !== undefined && predecessor.status !== TaskStatus.DONE;
  });
  const predecessor = waitingMember?.dispatchAfterTaskId === null || waitingMember?.dispatchAfterTaskId === undefined
    ? null
    : predecessorById.get(waitingMember.dispatchAfterTaskId) ?? null;
  const hold = control?.held === true
    ? (() => {
        if (control.heldLayer === null || control.heldAt === null) {
          throw new Error(`Held Chain ${chainId} is missing its hold layer or timestamp`);
        }
        return {
          heldLayer: control.heldLayer,
          heldAt: control.heldAt,
          holdReason: control.holdReason,
        };
      })()
    : null;
  const activationState: BoardChainActivationState = active
    ? "running"
    : hold !== null
      ? "held"
      : waitingMember !== undefined
      ? "waiting-on-predecessor"
      : allDone
        ? "settled"
        : firstPrimary !== undefined
          && firstPrimary.status === TaskStatus.TODO
          && (firstPrimary.runs ?? []).length === 0
          && (firstPrimary.dispatchAfterTaskId === null
            || predecessorById.get(firstPrimary.dispatchAfterTaskId)?.status === TaskStatus.DONE)
          ? "parked-unactivated"
          : "idle";

  const totalCost = sumUsageCosts(members.flatMap((member) => {
    const cost = memberUsageCost(member);
    return cost === null ? [] : [cost];
  }));
  const createdAt = members.reduce((earliest, member) => (
    member.createdAt < earliest ? member.createdAt : earliest
  ), members[0]!.createdAt);
  const updatedAt = members.reduce((latest, member) => (
    member.updatedAt > latest ? member.updatedAt : latest
  ), members[0]!.updatedAt);

  const frontierPosition = primary.indexOf(frontierMember);
  const activeRepairMember = repairs.find(isActiveRepairMember);
  const activeRepair = activeRepairMember === undefined ? null : {
    repairKind: activeRepairMember.repairKind,
    latestRun: latestRunProjectionFromRun(activeRepairMember.runs[0]),
  };
  return {
    chainId,
    chainName,
    stepCount: primary.length,
    statusCounts: stepStatusCounts,
    detailTaskId: frontierMember.id,
    status: columnStatus,
    frontier: {
      taskId: frontierMember.id,
      title: memberTitle(frontierMember),
      status: frontierMember.status,
      latestRun: latestRunProjection(frontierMember.runs),
      mergeOutcome: latestRunMergeOutcome(frontierMember.runs, frontierMember.stepOutput),
      failureReason: frontierMember.failureReason,
      ...(frontierPosition >= 0 ? { position: frontierPosition + 1 } : {}),
    },
    activeRepair,
    activation: {
      state: activationState,
      predecessor: predecessor === null || predecessor.status === TaskStatus.DONE
        ? null
        : { taskId: predecessor.id, taskName: predecessor.name },
      taskId: firstPrimary?.id ?? null,
      hold,
    },
    totalCost: serializeUsageCost(totalCost),
    firstRunStartedAt: primary.flatMap((member) => member.runs ?? []).reduce<Date | null>(
      (first, run) => run.startedAt != null && (first === null || run.startedAt < first) ? run.startedAt : first,
      null,
    ),
    createdAt,
    updatedAt,
  } satisfies BoardContractChainAggregate<Date>;
};

/** The instantiated chain name is persisted as the prefix of every task name.
 * The template step is the lossless delimiter: only remove a suffix we can
 * prove was added by instantiation, never guess from punctuation in a manual
 * task name. */
export const taskChainName = (row: Pick<BoardRow, "name" | "chainId" | "templateStep">): string | null => {
  if (row.chainId === null || row.templateStep === null) return null;
  const suffix = `: ${row.templateStep.name}`;
  return row.name.endsWith(suffix) ? row.name.slice(0, -suffix.length) : null;
};

export type ChainDisplay = { chainName: string | null; displayName: string };

/**
 * Derives display-only chain identity once, on the server, for every card in a
 * response. Template-instantiated rows have an exact persisted suffix as proof.
 * Direct API chains need at least two rows and one `name: ` prefix carried by
 * every returned row; punctuation in one task name is never enough to guess.
 */
export const chainDisplayByTask = (rows: readonly Pick<BoardRow, "id" | "projectId" | "name" | "chainId" | "templateStep">[]): Map<string, ChainDisplay> => {
  const result = new Map<string, ChainDisplay>(rows.map((row) => [row.id, { chainName: null, displayName: row.name }]));
  const grouped = new Map<string, typeof rows[number][]>();
  for (const row of rows) {
    if (row.chainId === null) continue;
    const key = `${row.projectId}\u0000${row.chainId}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  for (const group of grouped.values()) {
    const exact = group.map(taskChainName);
    const exactName = exact[0] ?? null;
    let chainName: string | null = exactName !== null && exact.every((name) => name === exactName) ? exactName : null;
    if (chainName === null && group.length > 1) {
      const candidates = [...group[0]!.name.matchAll(/: /g)]
        .map((match) => group[0]!.name.slice(0, match.index))
        .filter((candidate) => candidate.length > 0);
      chainName = [...candidates].reverse().find((candidate) => group.every((row) => (
        row.name.startsWith(`${candidate}: `) && row.name.length > candidate.length + 2
      ))) ?? null;
    }
    if (chainName === null) continue;
    const prefix = `${chainName}: `;
    for (const row of group) {
      result.set(row.id, { chainName, displayName: row.name.slice(prefix.length) });
    }
  }
  return result;
};

export const boardCard = (
  row: BoardRow,
  chainProgress: (ChainProgress & { position: number | null }) | null,
  moveContext: {
    hasRepoGrant: boolean;
    chainPredecessorsDone: boolean;
    chainPredecessor?: { name: string } | null;
  },
  display: ChainDisplay = { chainName: taskChainName(row), displayName: row.name },
  predecessor: BoardBlockedOnTask | null = null,
  repairOf: RepairBinding | null = null,
  baseline: BoardContractRunBaseline | null = null,
  readiness: ReadinessRequeueTotals = EMPTY_READINESS_REQUEUE_TOTALS,
): BoardCard => {
  const taskCost = sumUsageCosts(row.runs.flatMap((item) => item.session === null
    ? []
    : [runSessionUsageCost(item)!]));
  const budgetGrants = highestBudgetGrants(row.runs.map((item) => item.budgetGrants));
  // Read the same way as the grants beside it — carried forward, so the newest
  // row is the running total and the highest is that total under any ordering.
  // Shown apart from `budgetRemaining` on purpose: a task can have budget left
  // and still be out of platform refunds, and the operator who is about to
  // raise `maxSessionsPerTask` is the one who needs to see which it is.
  const leaseLossRefunds = row.runs.reduce((highest, item) => Math.max(highest, item.leaseLossRefunds), 0);
  const startability = taskStartability({
    status: row.status,
    assigneeType: row.assigneeType,
    assigneeAgentId: row.assigneeAgentId,
    repoId: row.repoId,
    archivedAt: row.archivedAt,
    assigneeAgent: row.assigneeAgent === null ? null : { archivedAt: row.assigneeAgent.archivedAt },
    hasRepoGrant: moveContext.hasRepoGrant,
    dispatchAfterTaskId: row.dispatchAfterTaskId,
    dispatchAfter: predecessor === null ? null : { status: predecessor.status },
  }, {
    total: row.runs.length,
    active: row.runs.some((item) => ACTIVE_RUN_STATUSES.includes(item.status as (typeof ACTIVE_RUN_STATUSES)[number])),
    budgetGrants,
  }, row.maxSessionsPerTask, moveContext.chainPredecessorsDone);
  return {
    id: row.id,
    name: row.name,
    displayName: display.displayName,
    status: row.status,
    assigneeType: row.assigneeType,
    failureReason: row.failureReason,
    scheduleKind: row.scheduleKind,
    runAt: row.runAt,
    cron: row.cron,
    timezone: row.timezone,
    approvalGate: row.approvalGate,
    templateId: row.templateId,
    source: row.source,
    chainId: row.chainId,
    chainIndex: row.chainIndex,
    chainName: display.chainName,
    blockedOn: row.dispatchAfterTaskId !== null && predecessor !== null && predecessor.status !== TaskStatus.DONE
      ? { taskId: predecessor.id, taskName: predecessor.name }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    assigneeAgent: row.assigneeAgent === null
      ? null
      : { id: row.assigneeAgent.id, title: row.assigneeAgent.title, model: row.assigneeAgent.model },
    chainProgress,
    moveTargets: operatorMoveTargets(row, startability, {
      dispatchAfter: predecessor,
      chainPredecessor: moveContext.chainPredecessor ?? null,
    }),
    latestRun: latestRunProjection(row.runs),
    strandedSalvageBranches: strandedSalvageBranchesFromRuns(row.runs),
    taskCost: serializeUsageCost(taskCost),
    // The cap and its accumulated spend travel together: a limit without the
    // number it is measured against is what the board used to show.
    spendCapUsage: serializeSpendCapUsage(spendCapUsage(row.spendCap ?? null, row.runs)),
    // Bound to the run the card actually shows: a stop recorded by run 1 is not
    // run 2's outcome, and the card's only run line is the newest run's.
    mergeOutcome: latestRunMergeOutcome(row.runs, row.stepOutput),
    repairOf,
    budgetRemaining: startability.checklist.budgetRemaining,
    leaseLossRefunds,
    chainAggregate: null,
    baseline,
    // Only the readiness Step records requeues, so every other card carries the
    // empty totals rather than a nullable field the web would have to branch on.
    readinessRequeues: readiness.readinessRequeues,
    readinessGrants: readiness.readinessGrants,
  } satisfies BoardCard;
};

/**
 * The chain binding a `repairAttempt` marker carries, or null when the marker is
 * not the repair task's own side of one.
 *
 * The same kind is written on both sides of a repair: the regression task names
 * the repair task, and the repair task names the regression task. Only the
 * second names a chain this card can be put under, so a marker without a
 * `regressionTaskId` is not this card's binding rather than a broken one.
 */
export const repairBinding = (
  marker: Marker | null,
  chainOfRegressionTask: (regressionTaskId: string) => { chainId: string; chainName: string | null } | null,
): RepairBinding | null => {
  const regressionTaskId = marker?.regressionTaskId ?? null;
  const repairKind = marker?.repairKind ?? null;
  if (regressionTaskId === null || repairKind === null) return null;
  const chain = chainOfRegressionTask(regressionTaskId);
  return chain === null ? null : { chainId: chain.chainId, chainName: chain.chainName, repairKind };
};

export type RepairChainBinding = {
  projectId: string;
  chainId: string;
  repairKind: string;
};

export type RepairMarkerRow = { taskId: string; metadata: Prisma.JsonValue };
export type RepairBindingTask = { id: string; projectId: string; chainId: string | null };

/** Resolve newest-valid repair markers from already-loaded rows. Readers use
 * this one rule with different query scopes, so board and Costs cannot disagree
 * about whether a detached task belongs to a Chain. */
export const repairChainBindingsFromRows = (
  repairTasks: ReadonlyArray<{ id: string; projectId: string }>,
  markerRows: readonly RepairMarkerRow[],
  regressionTasks: readonly RepairBindingTask[],
): Map<string, RepairChainBinding> => {
  const projectByTask = new Map(repairTasks.map((task) => [task.id, task.projectId]));
  const regressionById = new Map(regressionTasks.map((task) => [task.id, task]));
  const bindingByRepair = new Map<string, RepairChainBinding>();
  for (const row of markerRows) {
    if (bindingByRepair.has(row.taskId)) continue;
    const marker = markerFromMetadata(row.metadata);
    const repairProjectId = projectByTask.get(row.taskId);
    if (!marker?.regressionTaskId || !marker.repairKind || repairProjectId === undefined) continue;
    const regression = regressionById.get(marker.regressionTaskId);
    if (!regression?.chainId || regression.projectId !== repairProjectId) continue;
    bindingByRepair.set(row.taskId, {
      projectId: regression.projectId,
      chainId: regression.chainId,
      repairKind: marker.repairKind,
    });
  }
  return bindingByRepair;
};

/**
 * Resolves detached repair tasks through their own newest valid marker. Board
 * projection and delete guards share this query so they cannot disagree about
 * whether a detached task is Chain-bound.
 */
export const readRepairChainByTask = async (
  db: PrismaClient | Prisma.TransactionClient,
  tasks: Array<{ id: string; projectId: string }>,
): Promise<Map<string, RepairChainBinding>> => {
  if (tasks.length === 0) return new Map();
  const projectByTask = new Map(tasks.map((task) => [task.id, task.projectId]));
  const markerRows = await db.taskActivity.findMany({
    where: {
      actorType: "control-plane",
      task: {
        id: { in: tasks.map((task) => task.id) },
        chainId: null,
      },
      metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.repairAttempt },
    },
    select: { taskId: true, metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const markers = markerRows.flatMap((row) => {
    const marker = markerFromMetadata(row.metadata);
    const repairProjectId = projectByTask.get(row.taskId);
    return marker && repairProjectId ? [{ taskId: row.taskId, projectId: repairProjectId, marker }] : [];
  });
  const regressionIds = [...new Set(markers.flatMap(({ marker }) => (
    marker.regressionTaskId ? [marker.regressionTaskId] : []
  )))];
  const regressions = regressionIds.length === 0 ? [] : await db.task.findMany({
    where: {
      id: { in: regressionIds },
      chainId: { not: null },
    },
    select: { id: true, projectId: true, chainId: true },
  });
  return repairChainBindingsFromRows(tasks, markerRows, regressions);
};

/** Follows the Chain-side markers to every detached repair Task they name. */
export const readChainRepairTaskIds = async (
  db: PrismaClient | Prisma.TransactionClient,
  input: { projectId: string; chainTaskIds: string[] },
): Promise<string[]> => {
  if (input.chainTaskIds.length === 0) return [];
  const markerRows = await db.taskActivity.findMany({
    where: {
      taskId: { in: input.chainTaskIds },
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.repairAttempt },
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const candidateIds = [...new Set(markerRows.flatMap((row) => {
    const marker = markerFromMetadata(row.metadata);
    return marker?.repairKind && marker.repairTaskId ? [marker.repairTaskId] : [];
  }))];
  if (candidateIds.length === 0) return [];
  const repairs = await db.task.findMany({
    where: { id: { in: candidateIds }, projectId: input.projectId, chainId: null },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return repairs.map((task) => task.id);
};

export type TaskReadScope = {
  projectId?: string;
  archived: "false" | "true" | "all";
};

type ChainProgressWire = ChainProgress & { position: number | null };

type ChainSubject = {
  id: string;
  projectId: string;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer: number | null;
  status: TaskStatusType;
  name: string;
  templateStep: { name: string } | null;
};

const taskWhere = (scope: TaskReadScope): Prisma.TaskWhereInput => ({
  ...(scope.projectId ? { projectId: scope.projectId } : {}),
  ...(scope.archived === "false" ? { archivedAt: null }
    : scope.archived === "true" ? { archivedAt: { not: null } }
    : {}),
});

const chainKeysOf = <Row extends { projectId: string; chainId: string | null }>(
  rows: readonly Row[],
  include: (row: Row) => boolean = () => true,
): Set<string> => new Set(rows.flatMap((row) => (
  row.chainId === null || !include(row)
    ? []
    : [chainKey({ projectId: row.projectId, chainId: row.chainId })]
)));

const taskOrderBy = [{ createdAt: "desc" as const }, { id: "asc" as const }];

/**
 * Resolve progress for every chain represented by one task-list page.
 *
 * Progress counts archived siblings even when the page does not show them, and
 * the project participates in every in-memory key because `chainId` alone is
 * not globally unique. An unenriched full list and a page with no indexed chain
 * rows both skip the lookup entirely.
 */
const chainProgressFromRows = (
  chainRows: readonly (ChainSubject & { archivedAt?: Date | null })[],
  enrich: boolean,
): ((task: ChainSubject) => ChainProgressWire | null) => {
  const normalizedRows = chainRows.map((row) => ({ ...row, archivedAt: row.archivedAt ?? null }));
  const progressByChain = chainProgressByChain(normalizedRows);
  const positionsByChain = new Map<string, Map<string, number>>();
  for (const row of normalizedRows) {
    if (row.chainId === null) continue;
    const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
    if (positionsByChain.has(key)) continue;
    positionsByChain.set(key, positions(normalizedRows.filter((candidate) => (
      candidate.chainId !== null && chainKey({ projectId: candidate.projectId, chainId: candidate.chainId }) === key
    ))));
  }
  return (task) => {
    if (!enrich || task.chainId === null) return null;
    // Match the chain-detail read model for a malformed one-row chain whose
    // identity survived but whose index did not.
    if (task.chainIndex === null) {
      return {
        chainId: task.chainId,
        done: task.status === TaskStatus.DONE ? 1 : 0,
        total: 1,
        activeStepName: task.templateStep?.name ?? task.name,
        activeStatus: task.status.toLowerCase(),
        currentLayer: 1,
        layerCount: 1,
        position: 1,
      };
    }
    const key = chainKey({ projectId: task.projectId, chainId: task.chainId });
    const progress = progressByChain.get(key) ?? null;
    return progress ? { ...progress, position: positionsByChain.get(key)?.get(task.id) ?? null } : null;
  };
};

const chainProgressLookup = async (
  db: PrismaClient,
  rows: readonly ChainSubject[],
  scope: TaskReadScope,
  enrich: boolean,
): Promise<(task: ChainSubject) => ChainProgressWire | null> => {
  const chainIds = !enrich ? [] : [...new Set(rows
    .filter((task) => task.chainIndex !== null)
    .map((task) => task.chainId)
    .filter((value): value is string => value !== null))];
  const chainRows = chainIds.length === 0 ? [] : await db.task.findMany({
    where: {
      chainId: { in: chainIds },
      chainIndex: { not: null },
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
    },
    select: {
      id: true, projectId: true, chainId: true, chainIndex: true, status: true,
      chainLayer: true, name: true, archivedAt: true, templateStep: { select: { name: true } },
    },
    orderBy: { chainIndex: "asc" },
  });
  return chainProgressFromRows(chainRows, enrich);
};

/**
 * Fetch the complete primary-step facts needed by the aggregate. The progress
 * lookup intentionally stays small for full task-list callers; board reads
 * additionally need frontier/run/cost and age facts, including archived chain
 * siblings that are not themselves visible cards.
 */
const boardChainRows = async (
  db: PrismaClient,
  rows: readonly Pick<BoardRow, "chainId">[],
  scope: TaskReadScope,
): Promise<BoardChainMember[]> => {
  const chainIds = [...new Set(rows
    .map((row) => row.chainId)
    .filter((value): value is string => value !== null))];
  if (chainIds.length === 0) return [];
  const chainRows = await db.task.findMany({
    where: {
      chainId: { in: chainIds },
      chainIndex: { not: null },
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
    },
    select: {
      id: true,
      name: true,
      projectId: true,
      chainId: true,
      chainIndex: true,
      chainLayer: true,
      status: true,
      failureReason: true,
      dispatchAfterTaskId: true,
      archivedAt: true,
      createdAt: true,
      updatedAt: true,
      templateStep: { select: { name: true } },
      stepOutput: { select: { kind: true, body: true, runId: true } },
      runs: {
        orderBy: { runNumber: "desc" },
        select: {
          id: true,
          runNumber: true,
          status: true,
          model: true,
          codexServiceTier: true,
          subagentModel: true,
          budgetGrants: true,
          leaseLossRefunds: true,
          pullRequestUrl: true,
          pushedBranch: true,
          baseSha: true,
          readyAt: true, createdAt: true, startedAt: true,
          endedAt: true,
          lastProgressEventAt: true,
          maxRunsPerTask: true,
          session: {
            select: {
              nativeChildUsed: true,
              costUsd: true,
              inputTokens: true,
              cachedInputTokens: true,
              cacheCreationInputTokens: true,
              outputTokens: true,
              waitingOnMessageId: true, executionStatus: true,
              provisionedAt: true,
              startedAt: true,
              endedAt: true,
              cleanupStartedAt: true,
              cleanupEndedAt: true,
            },
          },
        },
      },
    },
  });
  return chainRows as unknown as BoardChainMember[];
};

/**
 * The pre-authorization requeue totals of every readiness Step on this page.
 *
 * Merge readiness records one activity per requeue on its own Task, so the
 * count and the granted attempts are a fold over those rows. Steps of any other
 * output kind never record one and are not queried.
 */
const readReadinessRequeueTotals = async (
  db: PrismaClient,
  rows: readonly Pick<BoardRow, "id" | "templateStep">[],
): Promise<Map<string, ReadinessRequeueTotals>> => {
  const readinessTaskIds = rows
    .filter((row) => row.templateStep?.outputKind === MERGE_READINESS_OUTPUT_KIND)
    .map((row) => row.id);
  const totals = new Map<string, ReadinessRequeueTotals>();
  if (readinessTaskIds.length === 0) return totals;
  const activities = await db.taskActivity.findMany({
    where: readinessRequeueActivityWhere({ in: readinessTaskIds }),
    select: { taskId: true, metadata: true },
  });
  const byTask = new Map<string, { metadata: Prisma.JsonValue }[]>();
  for (const activity of activities) {
    const group = byTask.get(activity.taskId) ?? [];
    group.push({ metadata: activity.metadata });
    byTask.set(activity.taskId, group);
  }
  for (const taskId of readinessTaskIds) {
    totals.set(taskId, readinessRequeueTotals(byTask.get(taskId) ?? []));
  }
  return totals;
};

/** Read the mechanical claim refusals for all queued latest Runs on a page.
 *
 * The activity is a durable Task fact, while the refusal is only relevant to
 * the Run that was queued when it happened. Query the page's task IDs once,
 * then join and time-bound the rows in memory; Prisma cannot express a
 * different activity lower-bound timestamp for each task in one predicate.
 */
const readClaimRefusals = async (
  db: PrismaClient,
  rows: readonly Pick<BoardRow, "id" | "runs">[],
): Promise<Map<string, BoardContractClaimRefusal<Date>>> => {
  const runCreatedAtByTask = new Map<string, Date>();
  for (const row of rows) {
    const run = row.runs?.[0];
    if (run?.status !== "QUEUED") continue;
    if (!runCreatedAtByTask.has(row.id)) runCreatedAtByTask.set(row.id, run.createdAt);
  }
  if (runCreatedAtByTask.size === 0) return new Map();

  const activities = await db.taskActivity.findMany({
    where: {
      taskId: { in: [...runCreatedAtByTask.keys()] },
      actorType: "control-plane",
      metadata: { path: ["code"], equals: MECHANICAL_CONTRACT_MISMATCH_CODE },
    },
    select: { id: true, taskId: true, metadata: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const refusals = new Map<string, BoardContractClaimRefusal<Date>>();
  for (const activity of activities) {
    if (refusals.has(activity.taskId)) continue;
    const runCreatedAt = runCreatedAtByTask.get(activity.taskId);
    if (runCreatedAt === undefined || activity.createdAt < runCreatedAt) continue;
    const metadata = activity.metadata;
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    const raw = metadata as Record<string, unknown>;
    if (typeof raw.apiVersion !== "number"
      || (raw.executorVersion !== null
        && typeof raw.executorVersion !== "number")) continue;
    const executorVersion = raw.executorVersion === null ? null : raw.executorVersion as number;
    refusals.set(activity.taskId, {
      code: MECHANICAL_CONTRACT_MISMATCH_CODE,
      executorVersion,
      apiVersion: raw.apiVersion,
      since: activity.createdAt,
    });
  }
  return refusals;
};

/** Read the complete board card model, including every lookup needed to project it. */
export const readBoard = async (db: PrismaClient, scope: TaskReadScope): Promise<BoardCard[]> => {
  const rows: BoardRow[] = await db.task.findMany({
    where: taskWhere(scope),
    orderBy: taskOrderBy,
    select: {
      id: true, projectId: true, name: true, status: true, assigneeType: true,
      assigneeAgentId: true, repoId: true, archivedAt: true, maxSessionsPerTask: true, spendCap: true,
      failureReason: true,
      scheduleKind: true, runAt: true, cron: true, timezone: true, approvalGate: true,
      templateId: true, source: true, chainId: true, chainIndex: true, chainLayer: true, createdAt: true, updatedAt: true,
      dispatchAfterTaskId: true, templateStepId: true,
      assigneeAgent: { select: { id: true, name: true, title: true, model: true, archivedAt: true } },
      templateStep: {
        select: {
          name: true,
          stepIndex: true,
          outputKind: true,
          taskTemplate: { select: { name: true } },
        },
      },
      runs: {
        orderBy: { runNumber: "desc" },
        select: {
          id: true, runNumber: true, status: true, model: true, subagentModel: true, budgetGrants: true,
          leaseLossRefunds: true, codexServiceTier: true, pullRequestUrl: true, pushedBranch: true, baseSha: true,
          readyAt: true, createdAt: true, startedAt: true, endedAt: true, lastProgressEventAt: true, maxRunsPerTask: true,
          session: {
            select: {
              nativeChildUsed: true, costUsd: true, inputTokens: true, cachedInputTokens: true,
              cacheCreationInputTokens: true, outputTokens: true, waitingOnMessageId: true, executionStatus: true,
              provisionedAt: true, startedAt: true, endedAt: true,
              cleanupStartedAt: true, cleanupEndedAt: true,
            },
          },
        },
      },
      // §SF-1: a stopped mechanical merge is not a successful board outcome
      // merely because its protocol Run completed successfully.
      stepOutput: { select: { kind: true, body: true, runId: true } },
    },
  });
  let primaryRows = await boardChainRows(db, rows, scope);
  const detachedTasks = rows
    .filter((row) => row.chainId === null)
    .map((row) => ({ id: row.id, projectId: row.projectId }));
  const repairChainByTask = await readRepairChainByTask(db, detachedTasks);
  const repairByTask = new Map<string, RepairBinding>();
  const repairChainKeyByTask = new Map([...repairChainByTask].map(([taskId, binding]) => [
    taskId,
    chainKey(binding),
  ]));
  if (repairChainByTask.size > 0) {
    // A detached repair can be the only visible member. Resolve its regression
    // binding before finalizing the primary lookup so archived siblings still
    // contribute the real step count, progress, spend and chain-detail target.
    const loadedKeys = chainKeysOf(primaryRows);
    const missingChains = [...repairChainByTask.values()]
      .filter((binding) => !loadedKeys.has(chainKey(binding)));
    if (missingChains.length > 0) {
      const supplemental = await boardChainRows(db, missingChains, scope);
      const byId = new Map([...primaryRows, ...supplemental].map((row) => [row.id, row]));
      primaryRows = [...byId.values()];
    }
  }

  // The complete Chain lookup may have added archived or detached-regression
  // members, so enrich only after every member that can reach the aggregate is
  // present. This remains one page-wide activity query, never one per card.
  const claimRefusalByTask = await readClaimRefusals(db, [...rows, ...primaryRows]);
  for (const row of [...rows, ...primaryRows]) {
    const run = row.runs?.[0];
    const claimRefusal = claimRefusalByTask.get(row.id);
    if (run !== undefined && claimRefusal !== undefined) run.claimRefusal = claimRefusal;
  }

  // Resolve the current wait by its exact question ID, in one page-wide query.
  // Another message in the same Session must never reset this phase's clock.
  const sessions = [...rows, ...primaryRows].flatMap((row) => (row.runs ?? []).flatMap((run) =>
    run.session !== null && (run.status === "WAITING_INBOX" || run.session.executionStatus === "WAITING_INBOX")
      ? [run.session] : []));
  const questionIds = [...new Set(sessions.flatMap((session) => session.waitingOnMessageId ? [session.waitingOnMessageId] : []))];
  const questions = questionIds.length === 0 ? [] : await db.inboxMessage.findMany({
    where: { id: { in: questionIds } }, select: { id: true, createdAt: true },
  });
  const waitStarts = new Map(questions.map((question) => [question.id, question.createdAt]));
  for (const session of sessions) session.inboxWaitStartedAt = waitStarts.get(session.waitingOnMessageId ?? "") ?? null;

  // A detached repair may recover complete primary facts, but it cannot be the
  // sole visible owner of a fully archived Chain. Keep repair aggregation when
  // the page contains a primary row, or the complete lookup finds a live one.
  // Repair binding and aggregate ownership must be removed together: the web
  // groups every repairOf card with the Chain aggregate carried by that group.
  const aggregateOwnerKeys = new Set([
    ...chainKeysOf(rows),
    ...chainKeysOf(primaryRows, (row) => (row.archivedAt ?? null) === null),
  ]);
  for (const [taskId, key] of repairChainKeyByTask) {
    if (!aggregateOwnerKeys.has(key)) repairChainKeyByTask.delete(taskId);
  }

  // Visible primary rows also occur in the complete lookup. Deduplicate before
  // deriving direct-chain names so one punctuation-bearing row never looks like
  // corroborating evidence for itself.
  const displayInputs = [...new Map([...rows, ...primaryRows].map((row) => [row.id, row])).values()];
  const displayByTask = chainDisplayByTask(displayInputs);
  const progressFor = chainProgressFromRows(primaryRows, true);

  // ChainControl is the board's persisted hold authority. Read every control
  // row represented by this page in one query; missing rows are the initial
  // released state returned by readChainControls.
  const chainControlKeys = [...new Map([...rows, ...primaryRows]
    .flatMap((row) => row.chainId === null
      ? []
      : [{ projectId: row.projectId, chainId: row.chainId }])
    .map((key) => [chainKey(key), key] as const)).values()];
  const controls = chainControlKeys.length === 0
    ? new Map<string, BoardChainControl>()
    : await readChainControls(db, chainControlKeys);

  const predecessorIds = [...new Set([...rows, ...primaryRows]
    .map((row) => row.dispatchAfterTaskId)
    .filter((value): value is string => typeof value === "string" && value.length > 0))];
  const predecessorById = new Map<string, BoardBlockedOnTask>();
  if (predecessorIds.length > 0) {
    const predecessors = await db.task.findMany({
      where: { id: { in: predecessorIds } },
      select: { id: true, name: true, status: true },
    });
    for (const predecessor of predecessors) predecessorById.set(predecessor.id, predecessor);
  }

  // Requeue counters, read only for the Steps that can record one. Merge
  // readiness writes its requeue activity on the readiness Task, so the board
  // needs one query per page rather than a per-card scan.
  const readinessByTask = await readReadinessRequeueTotals(db, rows);

  const grantInputs = rows.flatMap((row) => (
    row.assigneeAgentId === null || row.repoId === null
      ? []
      : [{ projectId: row.projectId, agentId: row.assigneeAgentId, repoId: row.repoId }]
  ));
  const grantRows = grantInputs.length === 0 ? [] : await db.agentRepoAccess.findMany({
    where: { OR: grantInputs },
    select: { projectId: true, agentId: true, repoId: true },
  });
  const grantKey = (value: { projectId: string; agentId: string; repoId: string }): string =>
    `${value.projectId}\u0000${value.agentId}\u0000${value.repoId}`;
  const granted = new Set(grantRows.map(grantKey));

  if (repairChainByTask.size > 0) {
    const chainNameByKey = new Map<string, string | null>();
    for (const row of [...rows, ...primaryRows]) {
      if (row.chainId === null) continue;
      const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
      if (chainNameByKey.has(key)) continue;
      chainNameByKey.set(key, displayByTask.get(row.id)?.chainName ?? null);
    }
    for (const [taskId, binding] of repairChainByTask) {
      if (!repairChainKeyByTask.has(taskId)) continue;
      repairByTask.set(taskId, {
        chainId: binding.chainId,
        chainName: chainNameByKey.get(chainKey(binding)) ?? null,
        repairKind: binding.repairKind,
      });
    }
  }

  const membersByChain = new Map<string, { primary: BoardChainMember[]; repairs: BoardChainMember[]; chainName: string | null }>();
  const addChain = (key: string, chainName: string | null): { primary: BoardChainMember[]; repairs: BoardChainMember[]; chainName: string | null } => {
    const existing = membersByChain.get(key);
    if (existing !== undefined) {
      if (existing.chainName === null && chainName !== null) existing.chainName = chainName;
      return existing;
    }
    const created = { primary: [], repairs: [], chainName };
    membersByChain.set(key, created);
    return created;
  };
  const memberWithDisplay = (member: BoardChainMember): BoardChainMember => {
    const displayName = displayByTask.get(member.id)?.displayName;
    return displayName === undefined ? { ...member } : { ...member, displayName };
  };
  // Include the complete chain lookup first so archived siblings contribute to
  // progress, costs and terminal placement. Visible rows then fill malformed
  // one-row chains and retain the exact card-side run projection.
  for (const member of primaryRows) {
    if (member.chainId === null) continue;
    const key = chainKey({ projectId: member.projectId, chainId: member.chainId });
    const group = addChain(key, displayByTask.get(member.id)?.chainName ?? null);
    if (!group.primary.some((candidate) => candidate.id === member.id)) group.primary.push(memberWithDisplay(member));
  }
  for (const row of rows) {
    if (row.chainId !== null) {
      const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
      const group = addChain(key, displayByTask.get(row.id)?.chainName ?? null);
      const existingIndex = group.primary.findIndex((candidate) => candidate.id === row.id);
      if (existingIndex === -1) group.primary.push(memberWithDisplay(row));
      else group.primary[existingIndex] = memberWithDisplay(row);
      continue;
    }
    const key = repairChainKeyByTask.get(row.id);
    if (key === undefined) continue;
    const repair = repairByTask.get(row.id);
    const group = addChain(key, repair?.chainName ?? null);
    group.repairs.push(memberWithDisplay(repair === undefined ? row : { ...row, repairKind: repair.repairKind }));
  }
  const aggregateByChain = new Map<string, BoardContractChainAggregate<Date>>();
  for (const [key, group] of membersByChain) {
    const chainId = group.primary[0]?.chainId
      ?? (group.repairs[0] === undefined
        ? key.split("\u0000")[1]!
        : repairByTask.get(group.repairs[0].id)?.chainId ?? key.split("\u0000")[1]!);
    aggregateByChain.set(key, chainAggregate(
      chainId,
      group.chainName,
      group.primary,
      group.repairs,
      predecessorById,
      controls.get(key) ?? null,
    ));
  }

  // One grouped statement for every template step on the page, whatever the
  // page size: the board's query count must not grow with the number of cards.
  const baselines = await readRunBaselines(db, rows.flatMap((row) => (
    row.templateStepId === null
      ? []
      : [{ projectId: row.projectId, templateStepId: row.templateStepId }]
  )));

  const emittedAggregates = new Set<string>();
  return rows.map((row) => {
    const repairKey = row.chainId === null ? repairChainKeyByTask.get(row.id) : undefined;
    const key = row.chainId === null
      ? repairKey
      : chainKey({ projectId: row.projectId, chainId: row.chainId });
    let chainPredecessor: { name: string } | null = null;
    if (row.chainId !== null) {
      const chainGroup = membersByChain.get(chainKey({ projectId: row.projectId, chainId: row.chainId }));
      if (chainGroup === undefined) {
        throw new Error(`Board move target projection is missing Chain ${row.chainId}`);
      }
      chainPredecessor = blockingPredecessor(chainGroup.primary, row.id);
    }
    const card = boardCard(
      row,
      progressFor(row),
      {
        hasRepoGrant: row.assigneeAgentId !== null && row.repoId !== null && granted.has(grantKey({
          projectId: row.projectId,
          agentId: row.assigneeAgentId,
          repoId: row.repoId,
        })),
        chainPredecessorsDone: chainPredecessor === null,
        chainPredecessor,
      },
      displayByTask.get(row.id),
      row.dispatchAfterTaskId === null ? null : predecessorById.get(row.dispatchAfterTaskId) ?? null,
      repairByTask.get(row.id) ?? null,
      row.templateStepId === null
        ? null
        : baselines.get(baselineKey({ projectId: row.projectId, templateStepId: row.templateStepId })) ?? null,
      readinessByTask.get(row.id),
    );
    const aggregate = key === undefined || emittedAggregates.has(key)
      ? null
      : aggregateByChain.get(key) ?? null;
    if (aggregate !== null && key !== undefined) emittedAggregates.add(key);
    return { ...card, chainAggregate: aggregate };
  });
};

const taskListInclude = {
  assigneeAgent: true,
  repo: true,
  templateStep: {
    select: {
      name: true,
      stepIndex: true,
      outputKind: true,
      taskTemplate: { select: { name: true } },
    },
  },
  // Run.output is forensic bulk and no list caller reads it.
  runs: {
    orderBy: { runNumber: "desc" },
    take: 1,
    omit: { output: true },
    include: { session: true },
  },
} as const satisfies Prisma.TaskInclude;

export type TaskListRow = SerializesTo<TaskListContract<Date, Prisma.Decimal>, TaskListContract>;

/** Read the full task list and optionally attach its expensive enrichment. */
export const readTaskList = async (
  db: PrismaClient,
  scope: TaskReadScope,
  options: { enrich: boolean },
): Promise<TaskListRow[]> => {
  const tasks = await db.task.findMany({
    where: taskWhere(scope),
    orderBy: taskOrderBy,
    include: taskListInclude,
  });
  const salvageRuns = tasks.length === 0 ? [] : await db.run.findMany({
    where: { taskId: { in: tasks.map((task) => task.id) } },
    select: {
      taskId: true,
      runNumber: true,
      status: true,
      pushedBranch: true,
      baseSha: true,
    },
  });
  const salvageRunsByTask = new Map<string, typeof salvageRuns>();
  for (const run of salvageRuns) {
    if (run.taskId === null) continue;
    const grouped = salvageRunsByTask.get(run.taskId) ?? [];
    grouped.push(run);
    salvageRunsByTask.set(run.taskId, grouped);
  }
  const progressFor = await chainProgressLookup(db, tasks, scope, options.enrich);
  const cronIds = !options.enrich ? [] : tasks
    .filter((task) => task.scheduleKind === "CRON")
    .map((task) => task.id);
  const firedGroups = cronIds.length === 0 ? [] : await db.task.groupBy({
    by: ["recurringSourceTaskId"],
    where: { recurringSourceTaskId: { in: cronIds } },
    _max: { createdAt: true },
    _count: { _all: true },
  });
  const firedByDefinition = new Map(firedGroups.map((group) => [group.recurringSourceTaskId, group]));
  // One grouped statement for every template step in the list, whatever its
  // length: the same constraint the board read carries.
  const baselines = await readRunBaselines(db, tasks.flatMap((task) => (
    task.templateStepId === null
      ? []
      : [{ projectId: task.projectId, templateStepId: task.templateStepId }]
  )));

  return tasks.map((task) => ({
    ...task,
    baseline: task.templateStepId === null
      ? null
      : baselines.get(baselineKey({ projectId: task.projectId, templateStepId: task.templateStepId })) ?? null,
    strandedSalvageBranches: strandedSalvageBranchesFromRuns(salvageRunsByTask.get(task.id) ?? []),
    executionOwner: chainExecutionOwner(task),
    chainProgress: progressFor(task),
    recurringLastFiredAt: firedByDefinition.get(task.id)?._max.createdAt ?? null,
    recurringFireCount: firedByDefinition.get(task.id)?._count._all ?? 0,
  } satisfies TaskListRow));
};

/**
 * A weak ETag over the serialized body.
 *
 * Weak because it is a hash of the representation this process just produced,
 * not a durable resource version: two processes serializing the same rows agree,
 * and nothing downstream may treat it as a byte-range validator.
 *
 * The idle board is the case this exists for. Nothing changed for a minute means
 * 24 polls that each moved 1.58 MB; with a validator they move a header.
 */
export const etagFor = (body: string): string =>
  `W/"${createHash("sha1").update(body).digest("base64url")}"`;

/** RFC 9110 §13.1.2: `If-None-Match` is a list, and `*` matches any current
 *  representation. Compared verbatim otherwise — this route only ever mints weak
 *  tags, so there is no strong/weak normalisation to do. */
export const etagMatches = (header: string | undefined, tag: string): boolean => {
  if (header === undefined) return false;
  const candidates = header.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  return candidates.includes("*") || candidates.includes(tag);
};
