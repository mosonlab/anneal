/**
 * Browser-safe serialized contracts for the Tasks board and Chain detail.
 *
 * Prisma is imported as types only: browser consumers receive no generated
 * client code, while persisted enum widening becomes a compile-time change at
 * this seam. String-literal unions that are not persisted remain local to the
 * contract, and the default `DateTime` parameter is the ISO string produced on
 * the HTTP wire. Server projections may instantiate the same contract with
 * `Date` before JSON serialization.
 */

import type {
  AssigneeType as PrismaAssigneeType,
  ChainControlState as PrismaChainControlState,
  CleanupStatus as PrismaCleanupStatus,
  CodexServiceTier as PrismaCodexServiceTier,
  FailureClass as PrismaFailureClass,
  MergeRecoveryStatus as PrismaMergeRecoveryStatus,
  PushStatus as PrismaPushStatus,
  RunStatus as PrismaRunStatus,
  RunnerKind as PrismaRunnerKind,
  ScheduleKind as PrismaScheduleKind,
  SessionExecutionStatus as PrismaSessionExecutionStatus,
  TaskSource as PrismaTaskSource,
  TaskStatus as PrismaTaskStatus,
  TriggerFireSource as PrismaTriggerFireSource,
} from "@prisma/client";

import type { Agent, Repo } from "./wire-contract.js";
import type { GateSlot } from "./gate-slot.js";

export type TaskStatus = PrismaTaskStatus;
export type TaskSource = PrismaTaskSource;
export type AssigneeType = PrismaAssigneeType;
export type ScheduleKind = PrismaScheduleKind;
export type RunStatus = PrismaRunStatus;
/** Runs that still own live work, including resumable Inbox waits. This is
 * shared by server guards and the board; every persisted status needs an answer. */
export const RUN_STATUS_IS_ACTIVE = {
  QUEUED: true,
  CLAIMED: true,
  PROVISIONING: true,
  RUNNING: true,
  WAITING_INBOX: true,
  SUCCEEDED: false,
  FAILED: false,
  TIMED_OUT: false,
  CANCELLED: false,
  LOST: false,
} satisfies Record<RunStatus, boolean>;

export const ACTIVE_RUN_STATUSES: RunStatus[] = (Object.keys(RUN_STATUS_IS_ACTIVE) as RunStatus[])
  .filter((status) => RUN_STATUS_IS_ACTIVE[status]);

export type RunnerKind = PrismaRunnerKind;
export type CodexServiceTier = PrismaCodexServiceTier;
export type SessionExecutionStatus = PrismaSessionExecutionStatus;
export type CleanupStatus = PrismaCleanupStatus;
export type FailureClass = PrismaFailureClass;
export type PushStatus = PrismaPushStatus;
export type MergeRecoveryStatus = PrismaMergeRecoveryStatus;
export type TriggerFireSource = PrismaTriggerFireSource;

type KnownChainControlState = "HELD" | "RELEASED";
type ChainControlStateCoverage =
  Exclude<PrismaChainControlState, KnownChainControlState> extends never
    ? Exclude<KnownChainControlState, PrismaChainControlState> extends never
      ? unknown
      : never
    : never;

/** Chain control is serialized as lower-case operator state. Keeping the
 * known persisted set explicit makes a Prisma addition or removal fail at this
 * seam until its wire spelling and projection are deliberately handled. */
export type ChainControlState = PrismaChainControlState & ChainControlStateCoverage;

export type ExecutionOwner = "agent" | "human" | "control-plane" | "merge-executor";

export type BoardMoveTarget = { status: TaskStatus; via: "patch" | "start" };
export type TaskMoveTarget = BoardMoveTarget;

export type UsageCost = {
  /** A serialized Decimal, or null when cost is unavailable. */
  costUsd: string | null;
  estimated: boolean;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  /** Null means cachedInputTokens may still be the legacy combined read/write
   * value; otherwise cachedInputTokens is cache reads only. */
  cacheCreationInputTokens: number | null;
  outputTokens: number | null;
};

/** A local calendar day in the costs window and its spend by agent. */
export type CostsDailyBucket<DecimalValue = string> = {
  date: string;
  byAgent: Record<string, DecimalValue>;
};

export type CostsAgentTotal<DecimalValue = string> = {
  agent: string;
  usd: DecimalValue;
  runs: number;
  costUnavailableRuns: number;
  avgUsd: DecimalValue;
  /** Cached-read share of this agent's input tokens, 0-100, or null when no
   * run has a complete cache read/write split. */
  cachePct: number | null;
  /** Runs excluded from cache metrics because their read/write split is
   * unknown. Unknown is deliberately not folded into either token total. */
  cacheUnknownRuns: number;
  /** Uncached input tokens from runs with a complete cache split. */
  uncachedInputTokens: number;
  /** Uncached input spend at the model table rate, or null when a contributing
   * model has no repository price. */
  uncachedInputUsd: DecimalValue | null;
  wastedUsd: DecimalValue;
};

export type CostsModelTotal<DecimalValue = string> = {
  model: string;
  usd: DecimalValue;
  runs: number;
  costUnavailableRuns: number;
};

export type CostsTopRun<DateTime = string, DecimalValue = string> = {
  runId: string;
  taskName: string | null;
  agent: string;
  model: string;
  usd: DecimalValue;
  estimated: boolean;
  startedAt: DateTime;
};

export type CostsWaste<DecimalValue = string> = {
  totalUsd: DecimalValue;
  operatorCancelledUsd: DecimalValue;
  failedUsd: DecimalValue;
  byFailureClass: Array<{
    failureClass: string;
    usd: DecimalValue;
    runs: number;
  }>;
};

export type CostsChain<DecimalValue = string> = {
  chainId: string;
  /** First primary task, used by the web client to open the existing chain
   * detail route. */
  detailTaskId: string;
  chainName: string | null;
  taskCount: number;
  leadMinutes: number;
  busyMinutes: number;
  busyPct: number;
  repairs: {
    gateFix: number;
    refreshConflict: number;
    reviewFix: number;
  };
  /** Pre-authorization merge-readiness requeues across the chain, and the extra
   *  Run attempts they granted. The grants fund paid Runs already counted in
   *  `costUsd`; these two make that share attributable. */
  readinessRequeues: number;
  readinessGrants: number;
  /** Priced spend only, or null when every run is unpriced. Unpriced runs are
   * represented by costUnavailableRuns rather than fabricated as zero. */
  costUsd: DecimalValue | null;
  /** Exact partition of priced spend. Registered step roles and repair are
   * seeded even when represented only by unpriced runs; `unassigned` surfaces
   * priced tasks whose persisted output kind has no registered StepRole. */
  costByRole: Record<string, DecimalValue>;
  costUnavailableRuns: number;
  longestGap: {
    minutes: number;
    beforeTaskName: string | null;
  };
};

/** `GET /projects/:projectId/costs` and its native API projection.
 *
 * `DateTime` and `DecimalValue` default to their JSON wire forms. API-side
 * projections can instantiate them with `Date` and `Prisma.Decimal`; Hono's
 * JSON serialization then produces the browser-facing default shape without
 * giving the web app a second hand-maintained copy of this contract.
 */
export type CostsReport<DateTime = string, DecimalValue = string> = {
  days: number;
  /** Inclusive lower bound of the whole-day window. */
  since: DateTime;
  totalUsd: DecimalValue;
  /** The part of `totalUsd` priced by repository rates rather than a provider. */
  estimatedUsd: DecimalValue;
  /** Settled runs that started inside the window, priced or not. */
  runCount: number;
  /** Runs whose cost could not be established; they contribute to no total. */
  costUnavailableRuns: number;
  /** Mean over runs that have a cost, not over all settled runs. */
  avgUsd: DecimalValue;
  /** Priced spend of settled runs that did not succeed. */
  wastedUsd: DecimalValue;
  waste: CostsWaste<DecimalValue>;
  chains: CostsChain<DecimalValue>[];
  daily: CostsDailyBucket<DecimalValue>[];
  byAgent: CostsAgentTotal<DecimalValue>[];
  byModel: CostsModelTotal<DecimalValue>[];
  topRuns: CostsTopRun<DateTime, DecimalValue>[];
};

/** The server's parse of a persisted `merge-result`; post-merge conditions set
 * `incident` so run-centric clients distinguish them from pre-merge stops. */
export type MergeOutcome = {
  outcome: "merged" | "stopped" | "malformed";
  condition: string | null;
  incident: boolean;
};

export type MergeRecovery<DateTime = string> = {
  id: string;
  attempt: number;
  status: MergeRecoveryStatus;
  phase: "validation" | "repair" | "authorization-wait" | "downstream-stop" | "succeeded" | "actual-failure";
  sourceStopId: string;
  boundSourceRunId: string | null;
  recoveryRunId: string | null;
  failureReason: string | null;
  updatedAt: DateTime;
};

export type LatestAgentMessage<DateTime = string> = {
  body: string;
  at: DateTime;
};

/** A serialized Session as returned by the operator session routes. */
export type Session<DateTime = string, DecimalValue = string> = {
  id: string;
  runId: string;
  /** §SF-1. Null unless this session's own run recorded a `merge-result`. */
  mergeOutcome?: MergeOutcome | null;
  projectId: string;
  agentId: string;
  taskId: string | null;
  goalId: string | null;
  runner: RunnerKind;
  executionStatus: SessionExecutionStatus;
  cleanupStatus: CleanupStatus;
  providerConversationId: string | null;
  waitingOnMessageId: string | null;
  resumeAttempt: number;
  requestedAt: DateTime;
  startedAt: DateTime | null;
  endedAt: DateTime | null;
  terminationReason: string | null;
  exitCode: number | null;
  costUsd: DecimalValue | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  usageCost?: UsageCost | null;
  /** The newest reader-visible agent-authored message, when projected by a
   *  task detail read. Other session projections may omit this derived field. */
  latestAgentMessage?: LatestAgentMessage<DateTime> | null;
  failureReason: string | null;
  /** Relations GET /sessions and GET /sessions/:id include; absent on the
   *  session rows nested inside a Run. `run.repo` is a nullable relation, and
   *  its remoteUrl is what makes the Branch field a link. */
  agent?: { id: string; title: string } | null;
  /** `chainId` is the persisted chain the task belongs to, and what the
   *  Sessions list filters on. `chainName` is display-only and derived from the
   *  rows in the same response, so it is null whenever those rows cannot prove
   *  a name — the id is what addresses the chain either way. */
  task?: { id: string; name: string; chainId: string | null; chainName: string | null } | null;
  goal?: { id: string; title: string } | null;
  run?: {
    id: string;
    runNumber: number;
    model: string;
    branch: string | null;
    pullRequestUrl: string | null;
    workspacePath: string | null;
    repo?: { id: string; name: string; remoteUrl: string } | null;
  } | null;
};

/* Per-run diagnostics derived at read time from the Run row, its Session row
 * and that session's tool events. Nothing here is persisted, and `null` always
 * means "unknown": it is never rendered as zero. */

/** Millisecond wall-clock split of a run. Each value is null when either
 *  bounding timestamp is missing. `executingMs` is measured to now while the
 *  run is still executing. */
export type RunPhaseMetrics = {
  /** Run.readyAt to Session.provisionedAt. */
  queuedMs: number | null;
  /** Session.provisionedAt to Session.startedAt. */
  provisioningMs: number | null;
  /** Session.startedAt to Session.endedAt, or to now while the run is live. */
  executingMs: number | null;
  /** Time the session spent waiting on Inbox replies. The stored data marks
   *  that a wait happened without bounding it, so this is 0 only when the
   *  session demonstrably never waited, and null whenever a wait is known to
   *  be included in `executingMs` but cannot be measured. */
  inboxWaitMs: number | null;
  /** Session.cleanupStartedAt to Session.cleanupEndedAt. */
  cleanupMs: number | null;
};

/** The canonical input-token split, where `input` already includes both cache
 *  subsets. `uncachedInput` and `cacheHitRatio` are null when the split is
 *  internally inconsistent or any component is unknown. */
export type RunTokenMetrics = {
  input: number | null;
  cachedRead: number | null;
  cacheWrite: number | null;
  uncachedInput: number | null;
  output: number | null;
  /** cachedRead / input, in [0, 1]. */
  cacheHitRatio: number | null;
};

export type RunToolNameMetrics = {
  name: string;
  calls: number;
  failed: number;
};

/** Tool behaviour paired by toolCallId. A completion whose payload cannot be
 *  read as success or failure counts in `unclassified` rather than as a
 *  success. */
export type RunToolMetrics = {
  calls: number;
  failed: number;
  unclassified: number;
  /** Union of paired call intervals: overlapping tools count wall time once.
   *  A lower bound when any calls have unknown duration. */
  totalToolMs: number;
  /** The five tool names with the most calls, most calls first. */
  byName: RunToolNameMetrics[];
};

export type RunTerminationMetrics = {
  reason: string | null;
  exitCode: number | null;
  signal: string | null;
};

/** One percentile pair over completed runs of the same template step, with the
 *  number of runs that produced it. */
export type RunBaselineMetric = {
  sampleSize: number;
  p50: number;
  p90: number;
};

/** What one template step's runs usually cost and how long they usually take,
 *  within one project. A null member means insufficient history — never 0, and
 *  no caller may render it as one. Each metric carries its own sample size
 *  because a run can report a duration without reporting a cost. */
export type RunBaseline = {
  /** Terminally successful runs of this step in this project, whatever they
   *  reported. It is the population the two metrics draw their samples from. */
  sampleSize: number;
  /** Percentiles in USD over the runs whose session reported a cost. */
  costUsd: RunBaselineMetric | null;
  /** Percentiles in milliseconds over the runs whose session has both
   *  `startedAt` and `endedAt`. */
  durationMs: RunBaselineMetric | null;
};

/** One run measured against its step's baseline: the run's own value divided by
 *  the baseline p50. Null whenever the baseline metric or the run's own value is
 *  unknown. Above 1 is slower or dearer than usual. */
export type RunVsBaseline = {
  costRatio: number | null;
  /** Null until the session has ended: an unfinished executing phase is not a
   *  duration the completed runs in the baseline can be compared with. */
  durationRatio: number | null;
};

export type RunMetrics = {
  phases: RunPhaseMetrics;
  tokens: RunTokenMetrics;
  tools: RunToolMetrics;
  /** executingMs minus tool time and Inbox wait, clamped at 0. Null when
   *  `executingMs` is unknown. */
  modelActiveMs: number | null;
  /** True when an unknown subtrahend was treated as 0, so `modelActiveMs` is
   *  an upper bound and the derived output rate is a lower bound. */
  modelActiveIsUpperBound: boolean;
  /** output / (modelActiveMs / 1000): an effective session-average rate over
   *  model-active time, never a provider peak rate. Null when `output` is
   *  unknown or `modelActiveMs` is unknown or 0. */
  outputTokensPerSecond: number | null;
  termination: RunTerminationMetrics;
  /** This run against the baseline of its task's template step. Both ratios are
   *  null when the task has no template step, when its history is too short, or
   *  when this run reported no value of its own. */
  vsBaseline: RunVsBaseline;
};

/** A serialized Run as embedded by Task detail responses. */
export type Run<DateTime = string, DecimalValue = string> = {
  id: string;
  projectId: string;
  taskId: string | null;
  goalId: string | null;
  agentId: string;
  repoId: string | null;
  runNumber: number;
  status: RunStatus;
  runner: RunnerKind;
  runnerId: string | null;
  model: string;
  codexServiceTier: CodexServiceTier;
  subagentModel: string | null;
  subagentMaxConcurrent: number | null;
  leaseGeneration: number;
  cancelRequestId: string | null;
  cancelReason: string | null;
  cancelRequestedAt: DateTime | null;
  cancelAcknowledgedAt: DateTime | null;
  workspacePath: string | null;
  workspaceRetained: boolean;
  targetBranch: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  pushStatus: PushStatus;
  pullRequestUrl: string | null;
  maxDurationMin: number;
  stallTimeoutMin: number;
  maxRunsPerTask: number;
  failureClass: FailureClass | null;
  failureReason: string | null;
  retryable: boolean | null;
  retryAt: DateTime | null;
  terminationReason: string | null;
  queuedAt: DateTime;
  claimedAt: DateTime | null;
  startedAt: DateTime | null;
  endedAt: DateTime | null;
  session?: Session<DateTime, DecimalValue> | null;
  /** Null on every run that did not record a `merge-result` — which is every
   *  run but the mechanical executor's. */
  mergeOutcome?: MergeOutcome | null;
  mergeRecovery?: MergeRecovery<DateTime> | null;
  /** Read-time diagnostics. Task detail attaches it to every run; other run
   *  projections omit it. */
  metrics?: RunMetrics | null;
};

export type ChainProgress = {
  chainId: string;
  done: number;
  total: number;
  activeStepName: string;
  activeStatus: string;
  /** Dense one-based ordinal of the active stored execution layer. */
  currentLayer: number;
  /** Number of distinct execution layers in the chain. */
  layerCount: number;
  /** This task's one-based ordinal within its Chain. */
  position: number | null;
};

export type BoardLatestRun<DateTime = string> = {
  id: string;
  runNumber: number;
  status: RunStatus;
  /** The model snapshot taken when the Run was claimed. */
  model: string;
  /** The Codex service tier snapshot taken when the Run was claimed. */
  codexServiceTier: CodexServiceTier;
  /** A serialized Decimal, or null when cost is unavailable. */
  costUsd: string | null;
  startedAt: DateTime | null;
  endedAt: DateTime | null;
  /** The pull request the Run published, or null when it opened none. Cards
   *  link it; nothing on the board derives anything else from it. */
  pullRequestUrl: string | null;
};

/** A durable salvage ref from a LOST Run that a later Run did not consume. */
export type StrandedSalvageBranch = {
  branch: string;
  lostRunNumber: number;
};

export type RepairBinding = {
  chainId: string;
  chainName: string | null;
  repairKind: string;
};

export type ChainAggregateState =
  | "parked-unactivated"
  | "waiting-on-predecessor"
  | "running"
  | "held"
  | "idle"
  | "settled";
export type BoardChainActivationState = ChainAggregateState;

export type ChainFrontier<DateTime = string> = {
  taskId: string;
  title: string;
  status: TaskStatus;
  latestRun: BoardLatestRun<DateTime> | null;
  mergeOutcome: MergeOutcome | null;
  failureReason: string | null;
  /** Dense one-based position among primary Steps; omitted for a repair. */
  position?: number | null;
};

export type ChainActiveRepair<DateTime = string> = {
  repairKind: string;
  latestRun: BoardLatestRun<DateTime>;
};

export type ChainAggregate<DateTime = string> = {
  chainId: string;
  chainName: string | null;
  /** Number of primary Chain Steps. Detached repairs never inflate this. */
  stepCount: number;
  /** Status counts for every primary-Step status. */
  statusCounts: Record<TaskStatus, number>;
  /** The Step the aggregate card opens: the frontier, which is what the
   * operator came to read. Always equal to `frontier.taskId`. */
  detailTaskId: string;
  /** Derived board column; this is not a persisted Task status. */
  status: TaskStatus;
  frontier: ChainFrontier<DateTime>;
  activeRepair: ChainActiveRepair<DateTime> | null;
  activation: {
    state: ChainAggregateState;
    predecessor: { taskId: string; taskName: string } | null;
    taskId: string | null;
    /** Persisted ChainControl facts when the chain is currently held. */
    hold: {
      heldLayer: number;
      heldAt: DateTime;
      holdReason: string | null;
    } | null;
  };
  totalCost: UsageCost | null;
  createdAt: DateTime;
  updatedAt: DateTime;
};

export type BoardCard<DateTime = string> = {
  id: string;
  name: string;
  displayName: string;
  status: TaskStatus;
  moveTargets: BoardMoveTarget[];
  assigneeType: AssigneeType;
  failureReason: string | null;
  scheduleKind: ScheduleKind;
  runAt: DateTime | null;
  cron: string | null;
  timezone: string | null;
  approvalGate: boolean;
  templateId: string | null;
  source: TaskSource;
  chainId: string | null;
  chainIndex: number | null;
  chainName: string | null;
  blockedOn: { taskId: string; taskName: string } | null;
  createdAt: DateTime;
  updatedAt: DateTime;
  assigneeAgent: { id: string; title: string; model: string } | null;
  chainProgress: ChainProgress | null;
  latestRun: BoardLatestRun<DateTime> | null;
  strandedSalvageBranches: StrandedSalvageBranch[];
  taskCost: UsageCost | null;
  mergeOutcome: MergeOutcome | null;
  repairOf: RepairBinding | null;
  /** The server's own budget verdict, so the board's retry affordance and the
   *  detail page's cannot state the rule differently. Computed by
   *  `taskStartability`, which is the only thing that reads a task's configured
   *  budget together with the grants its runs carry. */
  budgetRemaining: boolean;
  /** How many attempts this task has had refunded because the platform lost a
   *  Run — lease loss, an invalidated claim, a merge-tail requeue — as opposed
   *  to attempts its agent spent. Bounded by `LEASE_LOSS_REFUND_CAP`; at the
   *  bound the platform stops requeueing and parks the task for an operator,
   *  so this is the number that says whether that is about to happen. */
  leaseLossRefunds: number;
  /** Carried once by one visible member of each Chain; null otherwise. */
  chainAggregate: ChainAggregate<DateTime> | null;
  /** What this card's template step usually costs and how long it usually
   *  takes, over the project's completed runs. Null on a task with no template
   *  step and on a step with too little history. */
  baseline: RunBaseline | null;
  /** How many times merge readiness returned this Step's chain to Regression
   *  because the base moved before authorization, and how many extra Run
   *  attempts those requeues granted. Both are zero on every Step that is not
   *  the chain's readiness Step, which never records a requeue. */
  readinessRequeues: number;
  readinessGrants: number;
};

/** The browser-facing name retained by the web app's existing consumers. */
export type BoardTask = BoardCard<string>;

export type ChainStep<DateTime = string> = {
  taskId: string;
  position: number;
  chainIndex: number | null;
  layer: number | null;
  name: string;
  stepName: string;
  status: TaskStatus;
  approvalGate: boolean;
  gateSlot: GateSlot | null;
  assigneeType: AssigneeType;
  executionOwner: ExecutionOwner;
  /** `name` is the Agent's slug and `model` its stored `model:effort` string:
   *  the console names a step's staffing by role and shows what it costs to
   *  run, and neither is derivable from `title` alone. */
  agent: { id: string; title: string; name: string; model: string } | null;
  archivedAt: DateTime | null;
  failureReason: string | null;
  latestRun: { id: string; status: RunStatus; runNumber: number } | null;
  /** Whether this step's assignee may be changed right now: true exactly when
   *  the task has no Run in an active status. Deliberately not `executionOwner`
   *  — a human or control-plane step with no Run is reassignable, and an agent
   *  step whose Run is QUEUED is not. */
  reassignable: boolean;
  startable: boolean;
  startAction: "start" | "recover" | null;
  holdRefusal: string | null;
  blockedOn: { taskId: string; name: string; status: TaskStatus } | null;
  currentExecution: boolean;
  mergeRecovery: MergeRecovery<DateTime> | null;
};

export type ChainControl<DateTime = string> = {
  state: Lowercase<ChainControlState>;
  heldLayer: number | null;
  heldAt: DateTime | null;
  holdRequestId: string | null;
  holdReason: string | null;
  releasedAt: DateTime | null;
};

export type Chain<DateTime = string> = {
  chainId: string | null;
  total: number;
  done: number;
  steps: ChainStep<DateTime>[];
  control: ChainControl<DateTime> | null;
};

/** A webhook-configured template. `repo` is nullable: a trigger is defined by
 * its secret, so one without a repository is listed and un-fireable rather
 * than hidden. */
export type Trigger<DateTime = string> = {
  id: string;
  name: string;
  description: string;
  repo: { id: string; name: string } | null;
  stepCount: number;
  paused: boolean;
  secretDisabled: boolean;
  lastFiredAt: DateTime | null;
  fireCount: number;
};

export type TriggerDetail<DateTime = string> = {
  id: string;
  name: string;
  description: string;
  projectId: string;
  endpointPath: string;
  secretName: string | null;
  secretDisabled: boolean;
  repo: { id: string; name: string } | null;
  variables: string[];
  mapping: Record<string, string>;
  defaults: Record<string, unknown>;
  replayWindowSec: number | null;
  paused: boolean;
  stepCount: number;
  fireCount: number;
  lastFiredAt: DateTime | null;
  canFire: boolean;
  cannotFireReason: string | null;
};

export type TriggerFire<DateTime = string> = {
  id: string;
  createdAt: DateTime;
  source: TriggerFireSource;
  chainId: string | null;
  firstTask: { id: string; name: string } | null;
  /** Trigger history projects chain-wide progress, not one task's position. */
  progress: Omit<ChainProgress, "position"> | null;
};

/** One fired copy of a recurring definition, newest first. */
export type RecurringFire<DateTime = string> = {
  taskId: string;
  name: string;
  createdAt: DateTime;
  status: TaskStatus;
  latestRun: {
    id: string;
    status: RunStatus;
    runNumber: number;
    session: { id: string; costUsd: string | null } | null;
  } | null;
};

/**
 * Fields shared by the serialized full-list and detail Task projections.
 *
 * `DateTime` and `DecimalValue` let API projections keep their native Prisma
 * values until Hono serializes them. Relations use the shared operator
 * contracts so their wire shape has one authoritative definition.
 */
type TaskBase<DateTime, DecimalValue> = {
  id: string;
  projectId: string;
  assigneeAgentId: string | null;
  repoId: string | null;
  templateId: string | null;
  templateStepId: string | null;
  name: string;
  description: string;
  workingDirectory: string | null;
  targetBranch: string | null;
  failureReason: string | null;
  status: TaskStatus;
  assigneeType: AssigneeType;
  executionOwner: ExecutionOwner;
  approvalGate: boolean;
  scheduleKind: ScheduleKind;
  // `runAt === null` on a live CRON definition is the scheduler quarantine
  // marker, not an absence.
  runAt: DateTime | null;
  cron: string | null;
  timezone: string | null;
  maxDurationMin: number;
  stallTimeoutMin: number;
  maxSessionsPerTask: number;
  createdAt: DateTime;
  updatedAt: DateTime;
  assigneeAgent: Agent<DateTime> | null;
  repo: Repo<DateTime> | null;
  runs: Run<DateTime, DecimalValue>[];
  strandedSalvageBranches: StrandedSalvageBranch[];
  chainId: string | null;
  chainIndex: number | null;
  source: TaskSource;
  archivedAt: DateTime | null;
  schedulePausedAt: DateTime | null;
  recurringSourceTaskId: string | null;
  templateStep: {
    name: string;
    stepIndex: number;
    outputKind: string;
    taskTemplate: { name: string };
  } | null;
};

/** `GET /tasks` full-list projection, including list-only enrichment. */
export type TaskList<DateTime = string, DecimalValue = string> = TaskBase<DateTime, DecimalValue> & {
  chainProgress: ChainProgress | null;
  /** See `BoardCard.baseline`. The full list answers the whole page with the
   *  same single grouped query the board uses. */
  baseline: RunBaseline | null;
  recurringLastFiredAt: DateTime | null;
  recurringFireCount: number;
};

/** `GET /tasks/:taskId` projection, including detail-only operator fields. */
export type TaskDetail<DateTime = string, DecimalValue = string> = TaskBase<DateTime, DecimalValue> & {
  moveTargets: TaskMoveTarget[];
  taskCost: UsageCost | null;
  /** The task's own latest merge-result projection. */
  mergeOutcome: MergeOutcome | null;
  mergeRecovery: MergeRecovery<DateTime> | null;
  /** See `BoardCard.budgetRemaining`. */
  budgetRemaining: boolean;
  /** See `BoardCard.baseline`. Every run's `metrics.vsBaseline` is measured
   *  against this same object, so the two can never disagree. */
  baseline: RunBaseline | null;
  /** The prompt text an operator may rewrite, or null when this task has none.
   *  A template Step sends its brief — the fenced section `PATCH /tasks/:id`
   *  rewrites in place, leaving the platform-authored prompt and suffix alone —
   *  and an ordinary task sends its whole description, which the same patch
   *  replaces outright. Platform-authored Steps and an unreadable brief fence
   *  send null: there is nothing an operator owns to edit. */
  editableBrief: string | null;
};

/** HTTP envelope for `GET /tasks/:taskId/startability`. */
export type TaskStartability = {
  startable: boolean;
  checklist: {
    repoBound: boolean;
    agentAssignee: boolean;
    repoAccessGrant: boolean;
    budgetRemaining: boolean;
    noActiveRun: boolean;
    predecessorsDone: boolean;
  };
  task: {
    id: string;
    name: string;
    agent: { id: string; title: string } | null;
    repo: { id: string; name: string } | null;
    targetBranch: string | null;
  };
};

/** A TaskActivity row; commitSha was never a persisted/API activity field. */
export type TaskActivity<DateTime = string> = {
  id: string;
  taskId: string;
  actorType: string;
  actorId: string | null;
  body: string;
  metadata: unknown;
  createdAt: DateTime;
};

/** A TaskStepOutput row as emitted by GET/PUT output routes. */
export type TaskStepOutput<DateTime = string> = {
  id: string;
  taskId: string;
  runId: string | null;
  kind: string;
  body: string;
  metadata: unknown;
  commitSha: string | null;
  createdAt: DateTime;
  updatedAt: DateTime;
};
