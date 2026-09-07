/**
 * Browser-safe serialized contracts for the operator console's Inbox, Goal,
 * Session-event, Task-template, system and first-run installation reads.
 *
 * The same rules as `board-contract.ts` apply. Prisma is imported as types
 * only, so a browser consumer receives no generated client code while a
 * persisted enum widening becomes a compile-time change at this seam. A type
 * here is the view the console may rely on, not a transcript of the row: a
 * route may send more fields than the contract names, and `satisfies` on the
 * route proves that everything named is present with the type named. The
 * `DateTime` parameter is the ISO string produced on the HTTP wire, and a
 * server projection instantiates it with `Date` before JSON serialization.
 *
 * Fields the API computes rather than reads are declared here, next to the
 * persisted ones, so the console's use of them is bound to the route that
 * produces them instead of to a comment.
 */

import type {
  AssigneeType as PrismaAssigneeType,
  InboxChannel as PrismaInboxChannel,
  InboxDeliveryStatus as PrismaInboxDeliveryStatus,
  InboxKind as PrismaInboxKind,
  InboxSender as PrismaInboxSender,
  InboxStatus as PrismaInboxStatus,
  NetworkingMode as PrismaNetworkingMode,
  RepoPermission as PrismaRepoPermission,
  RunnerKind as PrismaRunnerKind,
  RunnerPreference as PrismaRunnerPreference,
  SessionEventSource as PrismaSessionEventSource,
} from "@prisma/client";

import type { ExecutionOwner } from "./board-contract.js";
import type { Agent, GoalStatus } from "./wire-contract.js";

export type SessionEventSource = PrismaSessionEventSource;
export type InboxSender = PrismaInboxSender;
export type InboxChannel = PrismaInboxChannel;

/** One line of a Session's transcript. `payload` is `unknown` on purpose: its
 *  shape is the runner adapter's, and `session-stream.ts` in the console is the
 *  one module allowed to interpret it. */
export type SessionEvent<DateTime = string> = {
  id: string;
  sessionId: string;
  runId: string;
  seq: number;
  at: DateTime;
  source: SessionEventSource;
  type: string;
  toolCallId: string | null;
  payload: unknown;
};

export type TaskTemplateStep<DateTime = string> = {
  id: string;
  stepIndex: number;
  name: string;
  assigneeType: PrismaAssigneeType;
  prompt: string;
  approvalGate: boolean;
  optional: boolean;
  outputKind: string;
  priorOutputKinds: string[];
  baseFromStepIndex: number | null;
  runner: PrismaRunnerKind | null;
  assigneeAgentId: string | null;
  assigneeAgent: Agent<DateTime> | null;
  /** Who executes this step, computed by the API from the step itself. The
   *  console never derives it from an output kind or a step name: a
   *  `control-plane` step is run by the server and cannot be staffed at all,
   *  whatever Agent its row binds so the task has an assignee. */
  executionOwner: ExecutionOwner;
};

export type TaskTemplate<DateTime = string> = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  variables: string[];
  /** Whether this row is a retired canonical generation, kept only so the
   *  chains instantiated under it keep their history. Derived by the reader
   *  from the row's name, never stored; a current canonical template and an
   *  operator's own clone are both false. */
  retired: boolean;
  steps: TaskTemplateStep<DateTime>[];
};

/**
 * One profile opinion about one template step.
 *
 * `outputKind` is the exact kind the step declares, never a normalised one:
 * `foo` and `foo-v2` are separate steps in a custom graph and therefore
 * separate entries. `assigneeAgentId` null means the profile has no opinion
 * and the canonical step binding stands. `include` is meaningful only for a
 * step the template marks optional and is null everywhere else; a stored
 * profile carries a boolean for every optional step of its template, because a
 * profile is the whole plan for the optional steps rather than the part an
 * operator happened to type (R3).
 */
export type StaffingProfileEntry = {
  outputKind: string;
  assigneeAgentId: string | null;
  include: boolean | null;
};

export type StaffingProfileTier = "default" | "frontend" | "hard" | "hazard";

/** Agent IDs selected for the four implementation tiers. A null value leaves
 * that tier unstaffed; the implementation step then keeps its current Agent. */
export type StaffingProfileTiers = Record<StaffingProfileTier, string | null>;

/** A named staffing plan for one TaskTemplate. Exactly one profile of a
 *  template is its default; a template may also have none, in which case
 *  instantiation uses the canonical step bindings. */
export type StaffingProfile<DateTime = string> = {
  id: string;
  projectId: string;
  taskTemplateId: string;
  name: string;
  isDefault: boolean;
  /** Agent used for review-fix and gate-fix merge-tail repair cards. `null`
   * means those repairs fall back to the chain's fixed-implementation Agent. */
  mergeTailRepairAgentId: string | null;
  tiers: StaffingProfileTiers;
  createdAt: DateTime;
  updatedAt: DateTime;
  entries: StaffingProfileEntry[];
};

/** The entry shape a write accepts. Both opinion fields are optional so a
 *  caller can name a step without staffing it, or staff it without touching
 *  the include flag. An omitted `include` on an optional step is stored as
 *  `true` — the step is kept — and an optional step no entry names is stored
 *  the same way; stating `include` on a step the template does not mark
 *  optional is refused. */
export type StaffingProfileEntryInput = {
  outputKind: string;
  assigneeAgentId?: string | null;
  include?: boolean | null;
};

/** Tier values accepted by profile create and replace. Missing keys preserve
 * an existing slot on replacement and mean an empty slot on creation. */
export type StaffingProfileTiersInput = {
  [Tier in StaffingProfileTier]?: string | null | undefined;
};

/** `POST …/staffing-profiles`. `isDefault` defaults to false unless the
 *  template has no profile yet, where the first one is always the default. */
export type StaffingProfileCreateInput = {
  name: string;
  entries: StaffingProfileEntryInput[];
  tiers?: StaffingProfileTiersInput | undefined;
  isDefault?: boolean;
  mergeTailRepairAgentId?: string | null;
  /** Optional repository context used to validate a non-null repair slot. */
  repoId?: string;
};

/** `PUT /staffing-profiles/:profileId`: a whole-profile replacement. Default
 *  membership is not part of it; `PATCH` owns that transition. */
export type StaffingProfileReplaceInput = {
  name: string;
  entries: StaffingProfileEntryInput[];
  tiers?: StaffingProfileTiersInput | undefined;
  /** Omission preserves the current slot; `null` explicitly clears it. */
  mergeTailRepairAgentId?: string | null;
  /** Optional repository context used to validate a non-null repair slot. */
  repoId?: string;
};

/** `PATCH /staffing-profiles/:profileId`. Only promotion is expressible:
 *  clearing the default would leave a template with none. */
export type StaffingProfileDefaultInput = {
  isDefault: true;
};

/** `POST /staffing-profiles/:profileId/reset`. Empty bodies keep the
 * historical reset behavior; `repoId` disambiguates grant validation in a
 * project with more than one Repo. */
export type StaffingProfileResetInput = {
  repoId?: string;
};

/** Warnings describe the plan being saved and never block the write. Entries
 *  dropped by a step-graph replacement are reported by that route instead, in
 *  its own authoring warning shape. */
export type StaffingProfileWarningCode = "same_agent_implements_and_reviews" | "merge_tail_repair_agent_unavailable" | "merge_tail_repair_repo_unresolved";

export type StaffingProfileWarning = {
  code: StaffingProfileWarningCode;
  message: string;
};

/** Every write route answers with the saved profile and the warnings the
 *  save produced; a warning never blocks the write. */
export type StaffingProfileResponse<DateTime = string> = {
  profile: StaffingProfile<DateTime>;
  warnings: StaffingProfileWarning[];
};

export type InboxChoice = { id: string; label: string };

export type InboxDecision<DateTime = string> = {
  id: string;
  inboxMessageId: string;
  runId: string;
  externalEventId: string;
  decision: string;
  actorOpenId: string | null;
  createdAt: DateTime;
};

/**
 * An operator answer already recorded under a card.
 *
 * A reply is returned as the persisted row it is: the API derives
 * `acceptsFreeText`, `dismissible` and `artifactTaskId` for the card the
 * operator acts on, never for the answers underneath it. The console renders a
 * reply as author, time and body, and this contract says so.
 */
export type InboxReply<DateTime = string> = {
  id: string;
  from: InboxSender;
  body: string;
  createdAt: DateTime;
};

export type InboxMessage<DateTime = string> = {
  id: string;
  from: InboxSender;
  agentId: string | null;
  sessionId: string | null;
  taskId: string | null;
  goalId: string | null;
  gateTaskId: string | null;
  /** Derived by the API: this open card has a consumer for operator text. */
  acceptsFreeText: boolean;
  /** Derived by the API: no decision is owed on this card and no suspended run
   *  resumes on it, so the operator may archive it outright. */
  dismissible: boolean;
  /** Approval gates only: the task whose step output the gate is asking about,
   *  derived by the API from the card's session. `null` on non-gate cards. */
  artifactTaskId: string | null;
  threadId: string | null;
  replyToMessageId: string | null;
  kind: PrismaInboxKind;
  body: string;
  /** Narrowed from the persisted `Json` column by the route that reads it, so a
   *  malformed row fails there rather than rendering an empty choice list. */
  choices: InboxChoice[] | null;
  selectedChoiceId: string | null;
  status: PrismaInboxStatus;
  channel: InboxChannel;
  deliveryStatus: PrismaInboxDeliveryStatus;
  deliveryAttempts: number;
  lastDeliveryError: string | null;
  createdAt: DateTime;
  answeredAt: DateTime | null;
  decisions?: InboxDecision<DateTime>[];
  replies?: InboxReply<DateTime>[];
};

/** `GET /inbox/messages/summary`: the sidebar badge's whole payload.
 *
 *  The badge used to be a by-product of `GET /inbox/messages`, which every page
 *  polled every 5s for the complete message history — 490 KB and 231 messages
 *  to render one number. The count is the same one `needsReply` computes card by
 *  card; the API applies that rule server-side. */
export type InboxSummary = {
  needsReply: number;
};

export type Goal<DateTime = string, DecimalValue = string> = {
  id: string;
  projectId: string;
  title: string;
  spec: string;
  dodApproved: boolean;
  /** The deliberately narrow console spelling; see `GoalStatus` in
   *  `wire-contract.ts`. The goals routes narrow the persisted column to it. */
  status: GoalStatus;
  spendCap: DecimalValue | null;
  spendUsd: DecimalValue;
  maxDurationMin: number | null;
  stallTimeoutMin: number;
  stuckThreshold: number;
  runnerPreference: PrismaRunnerPreference;
  sharedFolderPath: string | null;
  startedAt: DateTime | null;
  endedAt: DateTime | null;
  createdAt: DateTime;
  updatedAt: DateTime;
  definitionOfDone?: GoalDefinitionItem[];
  progressLog?: GoalProgressEntry<DateTime>[];
};

export type GoalDefinitionItem = {
  id: string;
  goalId: string;
  itemIndex: number;
  text: string;
  done: boolean;
};

export type GoalProgressEntry<DateTime = string> = {
  id: string;
  goalId: string;
  sessionId: string | null;
  body: string;
  createdAt: DateTime;
};

export type Health = { status: string; database: string; checkedAt: string };

/**
 * `GET /version`: the product build identity of the control plane answering
 * this page — what an operator quotes in a report. Distinct from the runner
 * daemon and CLI versions, which describe machines and backends, not the build.
 */
export type VersionInfo = {
  service: string;
  version: string | null;
  buildSha: string;
  commit: string | null;
  dirty: boolean;
  stamped: boolean;
  builtAt: string | null;
};

/** Timestamps here are ISO strings in both directions: `/runners` serializes
 *  the daemon registry and the backend health rows before it answers. */
export type DaemonStatus = {
  runnerId: string;
  lastSeenAt: string;
  online: boolean;
  busy: boolean;
  activeRuns: number;
  daemonVersion: string | null;
  diskFreeBytes: number | null;
  pollIntervalMs: number | null;
  workspaceRoot: string | null;
};

export type BackendStatus = {
  runner: PrismaRunnerKind;
  cliVersion: string | null;
  authMode: string | null;
  lastPreflightAt: string | null;
  lastPreflightOk: boolean | null;
  circuitOpen: boolean | null;
  circuitReason: string | null;
};

/** The dispatch drain in force when `/runners` answered, if any. Timestamps
 *  are ISO strings, like every other timestamp on this response. */
export type DispatchDrainStatus = {
  reason: string;
  startedAt: string;
  expiresAt: string;
};

export type RunnersResponse = {
  checkedAt: string;
  online: number;
  total: number;
  daemons: DaemonStatus[];
  backends: BackendStatus[];
  /** Null when dispatch is admitting Runs. A non-null value is why every
   *  daemon below is idle: they are being refused, not dead. */
  dispatchDrain: DispatchDrainStatus | null;
};

/**
 * What the confirmation screen must say, as facts rather than prose, so the
 * wizard cannot soften them into a claim the runtime does not honour. Every
 * value is a statement about this build's actual behaviour, which is why each
 * one is a literal and not its widened type.
 */
export type OnboardingDisclosure = {
  environmentNetworking: "OPEN";
  filesystemGrantCreated: false;
  repoPermission: Extract<PrismaRepoPermission, "GIT_WRITE">;
  codexSandbox: "none";
  runsWithHostUserAuthority: true;
  /** A statement about the supported v0.1 deployment, not about what this
   *  process binds to: the transport seam itself is Step 2's, and saying
   *  "loopbackOnly: true" here would read as an enforcement claim the
   *  installation module does not make. */
  supportedScope: "loopback-only";
  embeddedRemoteCredentialsRejected: true;
};

/**
 * The first-run installation contract (`GET`/`POST /onboarding`).
 *
 * Deliberately narrow: the control plane returns public identities and nothing
 * else — no prompt, no remote URL, no internal column — so that everything the
 * wizard holds is safe in a browser, a screenshot and release evidence.
 */
export type OnboardingStatus = {
  complete: boolean;
  project: { id: string; name: string; slug: string } | null;
  /** `null` when the control plane cannot read its own starter source. Never a
   *  reason to withhold `complete`, and never a reason to block an install. */
  starter: { name: string; title: string; model: string; runnerPreference: PrismaRunnerPreference } | null;
  disclosure: OnboardingDisclosure;
};

export type OnboardingInstallation = {
  complete: true;
  project: { id: string; name: string; slug: string };
  environment: { id: string; name: string; networking: PrismaNetworkingMode; allowedHosts: string[] };
  agent: { id: string; name: string; title: string; model: string; runnerPreference: PrismaRunnerPreference };
  repo: { id: string; name: string; defaultBranch: string; mountPath: string };
  access: { agentId: string; repoId: string; permissions: PrismaRepoPermission; mountPath: string };
};
