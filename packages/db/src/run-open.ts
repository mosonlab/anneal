import {
  AssigneeType,
  CodexServiceTier,
  InboxDeliveryStatus,
  InboxSender,
  Prisma,
  type Run,
  RunnerKind,
  RunnerPreference,
  RunStatus,
} from "@prisma/client";

import { catalogRunnerForModel, DIRECT_TEMPLATE_NAME } from "./agent-contract.js";
import { canonicalTemplateIdentity } from "./canonical-template-transition.js";
import { sharedChainBranch } from "./chain-branch.js";
import { readChainControl } from "./chain-control.js";
import { heldPredicate } from "./chain-hold.js";
import { layerOf } from "./chain-order.js";
import { lockAgentRow } from "./locks.js";
import { INTEGRATOR_TEMPLATE_NAME } from "./merge-integrator.js";
import {
  gateFeedsIntegratorStep,
  IntegratorBindingError,
  integratorBindingRefusalFor,
  requestMergeEvidence,
  resolveChainTarget,
  stopStateFor,
} from "./merge-integrator-db.js";
import { runnerFor } from "./model-routing.js";
import { runOwnedHead } from "./run-head.js";
import { stepRole } from "./step-role.js";

type Tx = Prisma.TransactionClient;

/** Newly refundable provider-transport and Regression target-fetch failures
 * are bounded so a persistently broken external dependency cannot create an
 * unbounded retry loop. Existing plumbing refunds remain outside this cap. */
export const EXTERNAL_FAILURE_REFUND_CAP = 3;

/**
 * How many attempts one task may have refunded because the *platform* lost the
 * Run: a lease declared LOST by reconciliation, a claim invalidated by a late
 * salvage, a merge-tail requeue.
 *
 * These refunds raise the ceiling they are measured against. `maxRunsPerTask`
 * and `budgetGrants` both grow by one with every refund, so `runNumber <
 * runBudgetCeiling(...)` is true forever in a pure lease-loss sequence and a
 * task that never runs a single agent attempt can requeue itself without end.
 * The count of refunds is therefore kept apart from the budget it produced,
 * and it is the only thing this bound reads.
 *
 * Matches `EXTERNAL_FAILURE_REFUND_CAP` in size and in reason, and bounds a
 * different class: that one bounds a provider or fetch that keeps failing, this
 * one bounds a runner that keeps disappearing.
 */
export const LEASE_LOSS_REFUND_CAP = 3;

/** Whether a task carrying `leaseLossRefunds` may still be refunded once more. */
export const leaseLossRefundAvailable = (leaseLossRefunds: number | null | undefined): boolean =>
  Math.max(0, leaseLossRefunds ?? 0) < LEASE_LOSS_REFUND_CAP;

/** The terminal grant and birth eligibility are one decision on an identified Run. */
export const leaseLossRefundDecision = (source: {
  id: string;
  leaseLossRefunds?: number | null;
  maxRunsPerTask: number;
  budgetGrants: number;
}, latestRunId: string | null) => {
  const refundAvailable = source.id === latestRunId && leaseLossRefundAvailable(source.leaseLossRefunds);
  return {
    sourceRunId: source.id,
    refundAvailable,
    maxRunsPerTask: source.maxRunsPerTask + (refundAvailable ? 1 : 0),
    budgetGrants: source.budgetGrants + (refundAvailable ? 1 : 0),
  };
};

/**
 * The ceiling a task's next attempt is measured against.
 *
 * `Task.maxSessionsPerTask` is the configured budget: how many attempts the
 * agent's own work is allowed to cost, and an operator may change it at any
 * time through `PATCH /tasks/:id`. `Run.budgetGrants` is what has been granted
 * on top of it — one per attempt refunded as an external failure, plus any a
 * human re-authorized — and it is carried forward onto every run a task
 * creates, so the largest value across a task's runs is the running total.
 *
 * The two must stay separate. `Run.maxRunsPerTask` is the *sum* of the two as
 * of the moment it was written, and a sum cannot be un-added: reading a
 * historical `maxRunsPerTask` as though it were a grant meant a task whose
 * budget an operator had just lowered from 5 to 2 still got five attempts,
 * because two ordinary EXECUTE failures had left `5` on their rows and nothing
 * could tell that 5 apart from a refund.
 *
 * Every budget gate has to read this. Two of them did not (issue #113): `POST
 * /tasks/:id/start` and `startable` counted run rows against
 * `Task.maxSessionsPerTask` alone and could not see the refunds, so a task
 * whose only failures were sub-second clone errors reported "Run budget
 * exhausted" to the operator while the operator-retry route, reading the very
 * same refund one route away, would have let it run. A ceiling only half the
 * system honours is not a ceiling.
 */
export const runBudgetCeiling = (
  maxSessionsPerTask: number,
  budgetGrants: number | null | undefined,
): number => maxSessionsPerTask + Math.max(0, budgetGrants ?? 0);

export type WorkflowRefusalReason =
  | "invalid-request"
  | "conflict"
  | "inbox-question-not-found"
  | "approval-gate-decision-invalid"
  | "inbox-choice-mismatch"
  | "inbox-run-not-waiting"
  | "approval-gate-rejection-target-missing";

/** A caller-reachable workflow refusal whose classification must not depend on its prose. */
export class WorkflowRefusalError extends Error {
  constructor(readonly reason: WorkflowRefusalReason, message: string) {
    super(message);
    this.name = "WorkflowRefusalError";
  }
}

export const isWorkflowRefusalError = (error: unknown): error is WorkflowRefusalError =>
  error instanceof Error && error.name === "WorkflowRefusalError";
export { runnerFor };

export const deriveRunConfig = (
  agent: {
    runnerPreference: RunnerPreference;
    model: string;
    codexServiceTier: CodexServiceTier;
  },
  templateStep: {
    runner: RunnerKind | null;
    stepIndex?: number;
    outputKind?: string;
    taskTemplate?: { name: string } | null;
  } | null,
): { runner: RunnerKind; model: string; codexServiceTier: CodexServiceTier } => {
  const compoundExecutioner = isCompoundImplementationStep(templateStep);
  const runner = templateStep?.runner ?? runnerFor(agent.runnerPreference, agent.model);
  if (compoundExecutioner
    && (runner !== RunnerKind.CODEX || catalogRunnerForModel(agent.model) !== RunnerPreference.CODEX)) {
    throw new WorkflowRefusalError("invalid-request", "Compound implementation root requires a Codex gpt-* model");
  }
  return {
    runner,
    model: agent.model,
    codexServiceTier: agent.codexServiceTier,
  };
};

export const COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE = "COMPOUND_IMPLEMENTATION_ASSIGNEE_INVALID";

/** One sentence for every site that refuses this binding, so the console and
 *  the three guards below cannot describe the same rule differently. */
export const COMPOUND_IMPLEMENTATION_ASSIGNEE_MESSAGE =
  "Compound implementation step requires an active in-project Agent on a Codex gpt-* model";

export type CompoundImplementationStepShape = {
  stepIndex?: number;
  outputKind?: string;
  taskTemplate?: { name: string } | null;
} | null;

export const isCompoundImplementationStep = (templateStep: CompoundImplementationStepShape): boolean =>
  templateStep?.taskTemplate?.name !== undefined
  && canonicalTemplateIdentity(templateStep.taskTemplate.name)?.canonicalName === INTEGRATOR_TEMPLATE_NAME
  && templateStep.outputKind !== undefined
  && stepRole({ outputKind: templateStep.outputKind }) === "implementation";

type CompoundImplementationAgent = {
  projectId: string;
  archivedAt: Date | null;
  model: string;
  runnerPreference: RunnerPreference;
} | null;

/**
 * Can this Agent's Run reach the Codex CLI on a `gpt-*` model?
 *
 * The two halves are the same pair `deriveRunConfig` re-checks before a
 * compound Run is created: `runnerFor` is the runtime authority for which CLI a
 * Run gets — a concrete preference wins, and AUTO/INHERIT defer to the model
 * name exactly as they will at Run open — while `catalogRunnerForModel` is the
 * `gpt-*` half, which is true only for a model whose name starts with `gpt-`.
 *
 * A template step that pins `runner` can only widen the first half, never
 * narrow it, so this predicate is at worst stricter than the Run it guards: it
 * cannot admit an assignment `deriveRunConfig` would later refuse.
 */
export const codexGptCapability = (agent: {
  model: string;
  runnerPreference: RunnerPreference;
}): boolean => runnerFor(agent.runnerPreference, agent.model) === RunnerKind.CODEX
  && catalogRunnerForModel(agent.model) === RunnerPreference.CODEX;

/**
 * §R14. The compound implementation root is bound by capability, not by name.
 *
 * A staffing profile may bind any Agent to any step, so a fixed Agent name is
 * no longer the invariant this step needs — what it needs is an in-project,
 * unarchived Agent that can actually execute a compound implementation Run.
 * Every site that used to compare against a fixed Agent name asks this
 * instead, and it is re-asked under the Agent-row lock at
 * instantiation, at assignment and at Run open.
 */
export const compoundImplementationAssigneeValid = (
  taskProjectId: string,
  assigneeType: AssigneeType,
  agent: CompoundImplementationAgent,
  templateStep: CompoundImplementationStepShape,
): boolean => !isCompoundImplementationStep(templateStep)
  || (assigneeType === AssigneeType.AGENT
    && agent !== null
    && agent.projectId === taskProjectId
    && agent.archivedAt === null
    && codexGptCapability(agent));

export class CompoundImplementationAssigneeError extends Error {
  readonly code = COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE;

  constructor() {
    super(COMPOUND_IMPLEMENTATION_ASSIGNEE_MESSAGE);
    this.name = "CompoundImplementationAssigneeError";
  }
}

export const isCompoundImplementationAssigneeError = (
  error: unknown,
): error is CompoundImplementationAssigneeError =>
  error instanceof Error && error.name === "CompoundImplementationAssigneeError";

export const NATIVE_IMPLEMENTATION_SUBAGENT_MODEL = "gpt-5.6-luna:max";
export const NATIVE_IMPLEMENTATION_SUBAGENT_MAX_CONCURRENT = 8;

export const isDirectImplementationStep = (templateStep: CompoundImplementationStepShape): boolean =>
  templateStep?.taskTemplate?.name !== undefined
  && canonicalTemplateIdentity(templateStep.taskTemplate.name)?.canonicalName === DIRECT_TEMPLATE_NAME
  && templateStep.outputKind !== undefined
  && stepRole({ outputKind: templateStep.outputKind }) === "implementation";

export const nativeImplementationSubagentRunConfig = (
  runner: RunnerKind,
  templateStep: CompoundImplementationStepShape,
): { subagentModel: string; subagentMaxConcurrent: number } | null => {
  if (runner !== RunnerKind.CODEX) return null;
  if (!isCompoundImplementationStep(templateStep) && !isDirectImplementationStep(templateStep)) return null;
  return {
    subagentModel: NATIVE_IMPLEMENTATION_SUBAGENT_MODEL,
    subagentMaxConcurrent: NATIVE_IMPLEMENTATION_SUBAGENT_MAX_CONCURRENT,
  };
};

export class ArchivedAssigneeError extends Error {
  constructor(readonly taskId: string, readonly taskName: string, readonly agentName: string) {
    super(`Task ${taskName} assignee ${agentName} is archived; unarchive the agent to queue this step`);
    this.name = "ArchivedAssigneeError";
  }
}

export const isArchivedAssigneeError = (error: unknown): error is ArchivedAssigneeError =>
  error instanceof Error && error.name === "ArchivedAssigneeError";

/** An archived Task must not gain a run. Thrown from `enqueueTaskRun` itself
 *  rather than from each caller: this function is the single place a Run comes
 *  into existence, so guarding here closes the class instead of one path. */
export class ArchivedTaskError extends Error {
  constructor(readonly taskId: string, readonly taskName: string) {
    super(`Task ${taskName} is archived; unarchive it before queueing a run`);
    this.name = "ArchivedTaskError";
  }
}

/** A run may not be created for an integrator step whose stop nobody has answered terminally. */
export class IntegratorStoppedError extends Error {
  constructor(readonly taskId: string, readonly condition: string) {
    super(`Merge integrator stopped on ${condition}; answer the stop question before starting another run`);
    this.name = "IntegratorStoppedError";
  }
}

/** A Run producer reached the single Run-birth seam while its Chain barrier
 * was still held above the Task's execution layer. The transaction caller may
 * safely roll this refusal back and retry after the operator releases it. */
export class ChainHeldError extends Error {
  constructor(
    readonly taskId: string,
    readonly chainId: string,
    readonly taskLayer: number | null,
    readonly heldLayer: number | null,
  ) {
    super(heldLayer === 0
      ? `Chain ${chainId} is held before its first layer; Task ${taskId} cannot queue a Run`
      : taskLayer === null || heldLayer === null
      ? `Chain ${chainId} is held; Task ${taskId} cannot queue a Run`
      : `Chain ${chainId} is held after layer ${heldLayer}; Task ${taskId} at layer ${taskLayer} cannot queue a Run`);
    this.name = "ChainHeldError";
  }
}

export const isChainHeldError = (error: unknown): error is ChainHeldError =>
  error instanceof Error && error.name === "ChainHeldError";

export const isIntegratorStoppedError = (error: unknown): error is IntegratorStoppedError =>
  error instanceof Error && error.name === "IntegratorStoppedError";

export const isArchivedTaskError = (error: unknown): error is ArchivedTaskError =>
  error instanceof Error && error.name === "ArchivedTaskError";

export class PinnedBaseCommitError extends Error {
  constructor(
    readonly taskId: string,
    readonly baseFromStepIndex: number,
    detail: string,
    /** Present only when the refusal is an unpublished base: the implementation
     *  Task whose Runs were read, and the base commit they recorded without
     *  ever publishing it (null when no Run recorded one at all). An operator
     *  reading the park needs both to tell this apart from a transport fault. */
    readonly unpublishedBase?: { implementationTaskId: string; baseSha: string | null },
  ) {
    super(`Pinned task ${taskId} cannot activate from step ${baseFromStepIndex}: ${detail}`);
    this.name = "PinnedBaseCommitError";
  }
}

export const isPinnedBaseCommitError = (error: unknown): error is PinnedBaseCommitError =>
  error instanceof Error && error.name === "PinnedBaseCommitError";

const IMPLEMENTATION_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

const implementationHeadFromOutput = (
  taskId: string,
  baseFromStepIndex: number,
  source: { kind: string; body: string; commitSha: string | null },
): string => {
  if (!source.commitSha) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced step has no recorded commitSha");
  }
  if (!IMPLEMENTATION_SHA.test(source.commitSha)) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced step has invalid commitSha");
  }
  if (source.kind !== "implementation") {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced step has no canonical implementation output");
  }
  let value: unknown;
  try {
    value = JSON.parse(source.body);
  } catch {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced implementation output is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced implementation output is not a JSON object");
  }
  const output = value as Record<string, unknown>;
  if (output.schemaVersion !== 1) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced implementation output has unsupported schemaVersion");
  }
  if (typeof output.headSha !== "string" || !IMPLEMENTATION_SHA.test(output.headSha)) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced implementation output has invalid headSha");
  }
  if (output.headSha !== source.commitSha) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced implementation output headSha does not match commitSha");
  }
  return output.headSha;
};

/** The marker written beside every `pushedBranch` ACK: a push of this Run's
 *  branch carries the commit it was provisioned at, so an acknowledged push is
 *  the moment its `baseSha` became fetchable from the remote. The first ACK
 *  wins — a second publication write never restamps it — and a Run that never
 *  recorded a base has nothing to mark. */
export const basePublishedStamp = (
  run: { baseSha: string | null; basePublishedAt: Date | null },
  now: Date,
): Date | null => run.basePublishedAt ?? (run.baseSha ? now : null);

/**
 * Which of an implementation Task's Runs may name the pinned base: one that
 * published the commit. A `baseSha` is recorded when the workspace is
 * provisioned, before anything is pushed, so a Run that dies first leaves a
 * base that lives in a discarded workspace and nowhere else — pinning to it
 * strands every dependent step on the runner with `upload-pack: not our ref`.
 * Rows written before `basePublishedAt` existed carry no marker, so the
 * evidence this repository already trusts answers for them: `pushedBranch`,
 * written from the ref actually handed to `git push` (see `resolveRunBranches`,
 * which reads it and nothing else). A Run that pushed and then died in `gh` is
 * recorded FAILED with the ref on the remote, so its outcome alone would strand
 * the range past its own commits. A succeeded Run also qualifies: a committing
 * step cannot succeed without publishing, and it is the only reading left for a
 * pre-marker row whose ACK predates `pushedBranch` being written at all.
 */
const publishedBaseFilter = {
  OR: [
    { basePublishedAt: { not: null } },
    { basePublishedAt: null, pushedBranch: { not: null } },
    { basePublishedAt: null, status: RunStatus.SUCCEEDED },
  ],
} satisfies Prisma.RunWhereInput;

/**
 * Where the implementation Task actually started, from the platform's own
 * record rather than a SHA an agent typed: the earliest Run of that Task that
 * published a provisioning `baseSha`, which is the chain's specification
 * commit. A later recovery Run starts at the prior head or at a salvaged WIP
 * commit, so only the earliest published base names the range every review
 * sibling and every later fix or regression step must see. Null when no Run
 * published one.
 */
export const platformImplementationBaseSha = async (tx: Tx, taskId: string): Promise<string | null> => {
  const run = await tx.run.findFirst({
    where: { taskId, baseSha: { not: null }, ...publishedBaseFilter },
    orderBy: { runNumber: "asc" },
    select: { baseSha: true },
  });
  return run?.baseSha ?? null;
};

/** The earliest base the implementation Task's Runs recorded, published or
 *  not. This names the offending commit when nothing is publishable, so a
 *  refusal can say which commit no Run put on the remote — never what a range
 *  is pinned to, and never what an authored body is checked against. */
export const recordedImplementationBaseSha = async (tx: Tx, taskId: string): Promise<string | null> => {
  const run = await tx.run.findFirst({
    where: { taskId, baseSha: { not: null } },
    orderBy: { runNumber: "asc" },
    select: { baseSha: true },
  });
  return run?.baseSha ?? null;
};

export const pinnedImplementationRange = async (
  tx: Tx,
  task: {
    id: string;
    projectId: string;
    templateId: string | null;
    chainId: string | null;
    templateStep?: { baseFromStepIndex: number | null } | null;
  },
): Promise<{ implementationBaseSha: string; implementationHeadSha: string } | null> => {
  const baseFromStepIndex = task.templateStep?.baseFromStepIndex;
  if (baseFromStepIndex === null || baseFromStepIndex === undefined) return null;
  if (!task.templateId || !task.chainId) {
    throw new PinnedBaseCommitError(task.id, baseFromStepIndex, "task is not an instantiated template chain step");
  }
  const source = await tx.taskStepOutput.findFirst({
    where: {
      task: {
        projectId: task.projectId,
        templateId: task.templateId,
        chainId: task.chainId,
        // baseFromStepIndex names the template Step. Conditional instantiation
        // may omit an earlier Step and densely number the materialized Tasks,
        // so Task.chainIndex is not an authority for this reference.
        templateStep: { stepIndex: baseFromStepIndex },
      },
    },
    select: { taskId: true, kind: true, body: true, commitSha: true },
  });
  if (!source) {
    throw new PinnedBaseCommitError(task.id, baseFromStepIndex, "referenced step has no canonical implementation output");
  }
  // The head is the commit the output is bound to, which persistence already
  // validated against the authored commit. The base is never read from the
  // body: a mistyped SHA there once sent every review sibling to a commit that
  // does not exist, so the range comes from the platform's own Run records and
  // fails loud when they hold none.
  const implementationHeadSha = implementationHeadFromOutput(task.id, baseFromStepIndex, source);
  const implementationBaseSha = await platformImplementationBaseSha(tx, source.taskId);
  if (!implementationBaseSha) {
    // The commit an unpublished Run recorded is named, not used: it is what
    // tells an operator that a dead Run's local base poisoned this chain
    // rather than that the runner lost its remote.
    const recorded = await recordedImplementationBaseSha(tx, source.taskId);
    throw new PinnedBaseCommitError(
      task.id,
      baseFromStepIndex,
      recorded
        ? `implementation task ${source.taskId} recorded baseSha ${recorded}, but no Run published a base`
        : `implementation task ${source.taskId} has no Run that published a baseSha`,
      { implementationTaskId: source.taskId, baseSha: recorded },
    );
  }
  if (!IMPLEMENTATION_SHA.test(implementationBaseSha)) {
    throw new PinnedBaseCommitError(
      task.id,
      baseFromStepIndex,
      `implementation task ${source.taskId} recorded an invalid Run baseSha`,
    );
  }
  return { implementationBaseSha, implementationHeadSha };
};

/** The shape the branch rules need once a Repo is known. Structural rather than
 *  a Prisma payload type so `openRun` can pass each intent's branch facts
 *  without coupling the resolver to its full Task query. */
export type RunBranchTask = {
  id: string;
  projectId: string;
  repoId: string | null;
  chainId: string | null;
  chainIndex: number | null;
  templateId: string | null;
  templateStep?: { baseFromStepIndex: number | null } | null;
  targetBranch: string | null;
  repo: { defaultBranch: string };
};

/** A Task at Run birth, whose Repo may still be absent. */
export type RunBirthTask = Omit<RunBranchTask, "repo"> & { repo: { defaultBranch: string } | null };

/** The Run being born, as `resolveRunBranches` needs to see it: which rule
 *  applies, which ref this Run would own, and what its predecessor carried. */
export type RunBirth = {
  intent: OpenRunIntent["kind"];
  runNumber: number;
  prior: { branch: string | null; targetBranch: string | null; runNumber: number } | null;
};

/**
 * Template step ① keeps the repository default in `targetBranch`, because that
 * is the base it must clone. The shared head is persisted on every later step,
 * so a deferred first start can recover the same branch an immediate start
 * uses without needing a placeholder Run at instantiation time.
 */
const templateChainBranch = async (tx: Tx, task: RunBranchTask): Promise<string | null> => {
  if (task.targetBranch && task.targetBranch !== task.repo.defaultBranch) return task.targetBranch;
  if (!task.chainId || !task.templateId) return null;
  const sibling = await tx.task.findFirst({
    where: {
      projectId: task.projectId,
      repoId: task.repoId,
      chainId: task.chainId,
      templateId: task.templateId,
      targetBranch: { not: task.repo.defaultBranch },
    },
    orderBy: { chainIndex: "asc" },
    select: { targetBranch: true },
  });
  return sibling?.targetBranch ?? null;
};

/**
 * The base a retry may inherit from its prior run, or null when nothing that run
 * left behind is known to exist on the remote.
 *
 * `prior.branch` is the *workspace* branch: the runner writes it back before any
 * push happens (workspace.ts, runner.ts), so a run whose push failed leaves a
 * `branch` that exists in no remote. Non-chain and template retries used to
 * inherit it as their base unconditionally, and `provisionWorkspace` clones the
 * base by name — so those retries died in `git clone` about two minutes in,
 * burning the whole run budget without ever starting the agent (issue #118: runs
 * cmsy9kg5j0001mp76wb95xiyu, cmsya108b00eqmp767igidbmb, cmsyaa0nk00oqmp760jc7693a).
 *
 * Only `pushedBranch` is evidence, for exactly the reasons spelled out on the
 * chain branch in `resolveRunBranches`: it is written from the ref actually
 * handed to `git push`, and `branch`/`pushStatus`/`status` each lie about it in
 * one direction or the other.
 */
const inheritedBase = async (
  tx: Tx,
  task: RunBranchTask,
  prior: { branch: string | null } | null,
): Promise<string | null> => {
  if (!task.repoId) return null;
  // Template steps of one chain share a branch, so the ref this retry wants may
  // have been published by a *sibling* step. This also applies to a successor's
  // first run: `prior` is null there, but the predecessor's salvage ref is the
  // newest durable tree the chain owns. Everything else asks about itself only.
  // A chainIndex-null row stays isolated from indexed siblings carrying the
  // same chainId (see resolveRunBranches).
  const chainScope = task.chainId && task.chainIndex !== null
    ? { projectId: task.projectId, chainId: task.chainId, chainIndex: { not: null } }
    : null;
  if (!prior && !chainScope) return null;
  const scope = chainScope
    ? chainScope
    : { id: task.id };
  // A non-chain retry first asks the narrow historical question: did this task
  // publish the workspace branch it is trying to continue? Chain retries skip
  // this shortcut because a newer sibling salvage must outrank an older head.
  if (!chainScope && prior?.branch) {
    const exact = await tx.run.findFirst({
      where: { repoId: task.repoId, pushedBranch: prior.branch, task: scope },
      select: { pushedBranch: true },
    });
    if (exact?.pushedBranch) return exact.pushedBranch;
  }
  // `createdAt`, not a per-task runNumber, orders publications across sibling
  // steps. Run rows are created serially along a chain; their updatedAt can move
  // later for cleanup bookkeeping and is therefore not publication ordering.
  // Scoped by repo: the same branch name on two remotes is two unrelated refs.
  const published = await tx.run.findFirst({
    where: { repoId: task.repoId, pushedBranch: { not: null }, task: scope },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { pushedBranch: true },
  });
  return published?.pushedBranch ?? null;
};

/**
 * The base for a requeue that must otherwise keep the failed run's *own* base
 * rather than the task's current one: the automatic retry inside the completion
 * transaction and the lost-lease requeue. Both deliberately snapshot the run
 * they are replacing, so an operator edit to `task.targetBranch` afterwards does
 * not silently retarget them — but neither may keep a base the remote does not
 * have, which is what made issue #118 self-sustaining.
 *
 * Publication evidence first (`inheritedBase`, including the WIP salvage the
 * completing run may have written moments ago in this same transaction), then
 * the snapshot — except when the snapshot *is* this run's own unpublished head.
 * That is the poisoned shape a pre-fix retry was created with: `branch` and
 * `targetBranch` both naming a ref no remote has. Copying it forward is how the
 * clone loop survived every retry, so that one case falls through to the task's
 * base, which only an operator ever writes.
 */
export const resolveRequeueBase = async (
  tx: Tx,
  task: RunBranchTask,
  run: { branch: string | null; targetBranch: string | null },
): Promise<string | null> => {
  const published = await inheritedBase(tx, task, { branch: run.branch });
  if (published) return published;
  if (run.branch !== null && run.targetBranch === run.branch) {
    return task.targetBranch ?? task.repo.defaultBranch;
  }
  return run.targetBranch;
};

/**
 * The head a retry keeps because the *Task* owns it — a shared chain head, or
 * the ref a merge-tail repair card was created to land on. Under this rule a
 * head minted for the previous Run belongs to that Run alone and is not carried
 * forward: the retry receives its own. Only the completion retry asks; the
 * lost-lease and ordinary-birth rules deliberately continue the predecessor's
 * declared head, and each says why where it does so.
 *
 * The comparison is against `runOwnedHead`, which this module is the only
 * producer of, so it reads back a decision made here rather than recognising
 * another package's naming convention.
 */
const taskOwnedHead = (
  taskId: string,
  prior: { branch: string | null; runNumber: number } | null | undefined,
): string | null => {
  if (!prior?.branch) return null;
  return prior.branch === runOwnedHead(taskId, prior.runNumber) ? null : prior.branch;
};

/**
 * The head a Chain or Template Step publishes on, and the base it clones. Null
 * head means no Chain, Template or repair rule names one, and the Run receives
 * the ref it owns (`resolveRunBranches`).
 *
 * Writes at most one TaskActivity row (see the chain branch below), so it takes
 * the caller's transaction.
 */
const chainDeclaredBranches = async (
  tx: Tx,
  task: RunBranchTask,
  prior: { branch: string | null } | null,
): Promise<{ branch: string | null; targetBranch: string }> => {
  const pinnedRange = await pinnedImplementationRange(tx, task);
  if (pinnedRange) {
    const chainBranch = task.targetBranch && task.targetBranch !== task.repo.defaultBranch
      ? task.targetBranch
      : null;
    return {
      branch: chainBranch ?? prior?.branch ?? null,
      targetBranch: pinnedRange.implementationHeadSha,
    };
  }
  // Template chains are frozen: nothing after this point runs for a template
  // task. Step ① keeps the repository default as its base while recovering the
  // shared head from a sibling task; later steps carry that head directly.
  // This is deliberately independent of a prior Run, because autoStart:false
  // materializes an inert chain whose first Run is created only by POST /start.
  if (task.templateId) {
    const chainBranch = await templateChainBranch(tx, task);
    return {
      // A prior Run carries the workspace branch the runner actually used. An
      // upgrade-state retry may therefore carry a per-run fallback here; when
      // the logical template head is recoverable, it must win so successors
      // clone the ref this retry publishes.
      branch: chainBranch ?? prior?.branch ?? null,
      targetBranch: (await inheritedBase(tx, task, prior)) ?? task.targetBranch ?? task.repo.defaultBranch,
    };
  }
  // A chainId with no index is a malformed one-row "chain" in the public API
  // and UI. It must remain isolated from indexed siblings that happen to carry
  // the same chainId (chain.dbtest.ts E1); treating it as an indexed chain here
  // would let it clone and publish those siblings' shared tree.
  if (!task.chainId || task.chainIndex === null) {
    return {
      // The head keeps the prior run's name even when the base falls back: the
      // name is this task's, and provisionWorkspace already handles a head that
      // does not exist on the remote (it clones the base and branches off it).
      branch: prior?.branch ?? null,
      targetBranch: (await inheritedBase(tx, task, prior)) ?? task.targetBranch ?? task.repo.defaultBranch,
    };
  }

  const shared = sharedChainBranch({ projectId: task.projectId, chainId: task.chainId });
  // "What is the newest ref any indexed step of this chain actually published
  // on this repo?" It may be the declared head or a per-run salvage ref.
  //
  // Read `pushedBranch` and nothing else. It is written only after `git push`
  // returns, with the ref that was actually given to it, on both delivery paths
  // (delivery.ts). Do not "simplify" this into `branch` + `pushStatus` +
  // `status`: those three lie in both directions, and each direction breaks a
  // chain in a way no retry clears.
  //   - `branch` + `pushStatus`: a *failed* run whose WIP salvage push succeeded
  //     records pushStatus SUCCEEDED with `branch` still set to the workspace
  //     branch — the shared branch — while deliverFailedWorkspace actually
  //     pushed `agentos/<taskId>/run-<n>` (delivery.ts; runner.ts spreads the
  //     workspace result first). The next step would clone a ref nobody created.
  //   - adding `status`/`pushStatus = SUCCEEDED` to compensate: a run that
  //     pushed the branch and then hit any `gh` error is recorded FAILED and
  //     non-retryable (delivery.ts's catch; runner.ts's `succeeded`) even though
  //     the ref exists. The next step would base on the default branch, recreate
  //     the shared name locally, and be rejected non-fast-forward. Wedged for
  //     good — no retry clears it.
  //
  // Scoped by repo (spec R2: the same name on two remotes is two unrelated
  // refs) and restricted to indexed tasks. A chainIndex-null row is the API's
  // isolated 1/1 malformed-chain case and must neither contribute nor consume
  // publication evidence for an indexed chain with the same chainId.
  const published = await inheritedBase(tx, task, prior);
  // `prior?.branch` is deliberately not consulted as publication evidence.
  // Only pushedBranch proves that a cloneable remote ref exists.
  const targetBranch = published ?? task.targetBranch ?? task.repo.defaultBranch;

  // targetBranch stays writable for chain steps but no longer routes them.
  // Silently ignoring an operator's value is a footgun, so say so once per run —
  // this is how the operator learns hand-repointing is unnecessary.
  if (task.targetBranch && task.targetBranch !== targetBranch) {
    await tx.taskActivity.create({ data: {
      taskId: task.id,
      actorType: "control-plane",
      body: `targetBranch '${task.targetBranch}' is not used for chain steps; this run is based on '${targetBranch}' and pushes to '${shared}'`,
    } });
  }
  return { branch: shared, targetBranch };
};

/**
 * Decides the publish target of a Run: the head it publishes (`branch`) and the
 * base it clones (`targetBranch`).
 *
 * This is the only place either is decided. Every `openRun` intent goes through
 * it, and a Run's head is written once, at its birth: nothing else writes
 * `Run.branch`. `repairReplacementAfterSalvage` re-runs it for a queued
 * replacement whose clone base moved and takes the base alone from the answer.
 * A caller that needs a different head adds its intent here; patching the row
 * after birth would put
 * the decision back in two places, which is how one Step ended up on a
 * different branch from the rest of its Chain.
 *
 * A Run whose Task has a Repo always leaves here with a head, so the runner
 * never invents one and `Run.branch` carries exactly one fact: the head the
 * control plane declared. When no Chain, Template or repair rule names a head,
 * it is the ref this Run owns (`runOwnedHead`).
 *
 * Writes at most one TaskActivity row (see `chainDeclaredBranches`), so it takes
 * the caller's transaction.
 */
export const resolveRunBranches = async (
  tx: Tx,
  task: RunBirthTask,
  birth: RunBirth,
): Promise<{ branch: string | null; targetBranch: string | null }> => {
  const { intent, prior } = birth;
  // A Task with no Repo publishes nothing, so there is no head to declare; it
  // carries its predecessor's columns forward untouched.
  if (!task.repo) {
    return { branch: prior?.branch ?? null, targetBranch: prior?.targetBranch ?? task.targetBranch };
  }
  const repoTask = { ...task, repo: task.repo };
  const declared = await declaredPublishTarget(tx, repoTask, intent, prior);
  return {
    branch: declared.branch ?? runOwnedHead(task.id, birth.runNumber),
    targetBranch: declared.targetBranch,
  };
};

/** The head each birth intent names, before the Run's own ref fills a null. */
const declaredPublishTarget = async (
  tx: Tx,
  task: RunBranchTask,
  intent: OpenRunIntent["kind"],
  prior: RunBirth["prior"],
): Promise<{ branch: string | null; targetBranch: string | null }> => {
  const requeueBase = async (): Promise<string | null> => (prior
    ? resolveRequeueBase(tx, task, prior)
    : task.targetBranch ?? task.repo.defaultBranch);
  switch (intent) {
    // A recovered human authorization renews the mechanical Run of a Step that
    // already sits on its Chain's head against the base it was authorized on.
    // It moves neither.
    case "integrator-authorized":
      return { branch: prior?.branch ?? null, targetBranch: prior?.targetBranch ?? task.targetBranch };
    // A merge-tail repair card is chain-detached on purpose, but its commits
    // have to land on the ref the tail is trying to merge. That ref is the
    // Task's own targetBranch, written when the card was created from the
    // source Run's head, so the card publishes onto its base.
    case "merge-tail-repair":
      return { branch: task.targetBranch, targetBranch: task.targetBranch };
    case "retry-after-completion":
      // A Chain or Template step's head belongs to the chain, so the chain rule
      // answers. A Template retry may carry a head its runner published under;
      // an indexed non-template sibling must not.
      if (task.chainId && (task.templateId || task.chainIndex !== null)) {
        return chainDeclaredBranches(tx, task, task.templateId ? { branch: prior?.branch ?? null } : null);
      }
      // Publication evidence answers the base. Only a head the Task owns
      // answers the publish target; the ref the previous Run owned does not,
      // so this Run receives its own.
      return { branch: taskOwnedHead(task.id, prior), targetBranch: await requeueBase() };
    case "retry-after-lease-loss":
      // A pinned Step keeps its immutable range; an indexed non-template
      // sibling re-derives the shared head from publication evidence alone.
      if (task.templateStep?.baseFromStepIndex != null) {
        return chainDeclaredBranches(tx, task, { branch: prior?.branch ?? null });
      }
      if (task.chainId && task.chainIndex !== null && !task.templateId) {
        return chainDeclaredBranches(tx, task, null);
      }
      // Unlike a completion retry, the replacement for a lost lease continues
      // the head its predecessor was told to publish: the lost Run may already
      // have pushed it, and nothing terminal was reported about it.
      return { branch: prior?.branch ?? null, targetBranch: await requeueBase() };
    // Every remaining intent is an ordinary birth with no snapshot of its own:
    // the Chain rule answers, and a Run outside a Chain receives the ref it
    // owns. Listed rather than defaulted so a new intent kind fails to compile
    // here instead of inheriting this rule by accident.
    case "enqueue":
    case "merge-tail-requeue":
    case "claim-invalidated":
    case "task-created":
    case "retry":
      return chainDeclaredBranches(tx, task, prior ? { branch: prior.branch } : null);
    default: {
      const unhandled: never = intent;
      throw new Error(`Unhandled Run birth intent: ${String(unhandled)}`);
    }
  }
};

export type IntegratorStopBypass = { integratorTaskId: string; sourceStopId: string };

export type OpenRunIntent =
  | { kind: "enqueue"; readyAt: Date; stopBypass?: IntegratorStopBypass | null }
  | { kind: "merge-tail-requeue"; readyAt: Date; budgetGrant: 1; repairCompleted?: true }
  /** The replacement for a claim a late salvage invalidated before it started.
   *  Its budget arithmetic is an ordinary enqueue's — the revoked claim already
   *  carries the refund — but it is a platform-caused refund, so it is named
   *  rather than borrowing `enqueue` and escaping the bound below. */
  | { kind: "claim-invalidated"; sourceRunId: string; readyAt: Date }
  /** The first Run of an automatic merge-tail repair card, which publishes onto
   *  the chain head it was created to repair rather than onto a ref of its own. */
  | { kind: "merge-tail-repair"; readyAt: Date }
  | { kind: "task-created"; readyAt: Date }
  | { kind: "retry"; readyAt: Date }
  | { kind: "integrator-authorized"; readyAt: Date }
  | {
    kind: "retry-after-completion";
    readyAt: Date;
    sourceRunId: string;
    sourceMaxRunsPerTask: number;
    sourceBudgetGrants: number;
    budgetGrant: 0 | 1;
  }
  | {
    kind: "retry-after-lease-loss";
    readyAt: Date;
    sourceRunId: string;
    sourceMaxRunsPerTask: number;
    sourceBudgetGrants: number;
  };

/**
 * What a caller has to do about a refused Run birth.
 *
 * Fifteen codes answer three questions, and no caller of `openRun` has ever
 * needed a finer answer than these:
 *
 * - `held`: a live Chain authority is withholding birth on purpose. The Task
 *   keeps its place and a later attempt succeeds once the hold is released, so
 *   a caller records the refusal and leaves the Task alone.
 * - `stopped`: an integrator stop condition refuses birth. The stop record is
 *   the operator's own instrument, so a caller that owns stop records parks the
 *   Task under the stop; any other caller treats it as a fault.
 * - `fault`: birth cannot succeed until an operator changes something. The Task
 *   must be surfaced, never left looking queued.
 */
export type OpenRunDisposition = "held" | "stopped" | "fault";

type OpenRunRefusalShape<Code extends string, Reason extends string> = {
  code: Code;
  reason: Reason;
  disposition: OpenRunDisposition;
  message: string;
  detail?: Readonly<Record<string, string | number | boolean | null>>;
  context?: Readonly<{
    taskId?: string;
    taskName?: string;
    chainId?: string;
    taskLayer?: number | null;
    heldLayer?: number | null;
    agentName?: string;
    condition?: string;
    code?: string;
  }>;
};

export type OpenRunRefusal =
  | OpenRunRefusalShape<"task-not-found", "not-found">
  | OpenRunRefusalShape<"task-assignee-type-invalid", "invalid-request">
  | OpenRunRefusalShape<"task-assignee-missing", "conflict">
  | OpenRunRefusalShape<"repo-required", "invalid-request">
  | OpenRunRefusalShape<"task-archived", "archived-task">
  | OpenRunRefusalShape<"integrator-stopped", "integrator-stopped">
  | OpenRunRefusalShape<"assignee-archived", "archived-assignee">
  | OpenRunRefusalShape<"compound-implementation-assignee", "compound-implementation-assignee">
  | OpenRunRefusalShape<"integrator-binding-invalid", "invalid-request">
  | OpenRunRefusalShape<"initial-run-already-exists", "conflict">
  | OpenRunRefusalShape<"prior-run-required", "conflict">
  | OpenRunRefusalShape<"source-run-stale", "conflict">
  | OpenRunRefusalShape<"task-not-integrator", "invalid-request">
  | OpenRunRefusalShape<"run-budget-exhausted", "conflict">
  | OpenRunRefusalShape<"lease-loss-refunds-exhausted", "conflict">
  | OpenRunRefusalShape<"chain-held", "chain-held">;

/**
 * The disposition each code carries. Declared beside the union so a new code
 * fails to compile until its handling is stated once, here, instead of being
 * added to every caller's roster.
 */
const dispositionByCode = {
  "task-not-found": "fault",
  "task-assignee-type-invalid": "fault",
  "task-assignee-missing": "fault",
  "repo-required": "fault",
  "task-archived": "fault",
  "integrator-stopped": "stopped",
  "assignee-archived": "fault",
  "compound-implementation-assignee": "fault",
  "integrator-binding-invalid": "fault",
  "initial-run-already-exists": "fault",
  "prior-run-required": "fault",
  "source-run-stale": "fault",
  "task-not-integrator": "fault",
  "run-budget-exhausted": "fault",
  "lease-loss-refunds-exhausted": "fault",
  "chain-held": "held",
} as const satisfies Record<OpenRunRefusal["code"], OpenRunDisposition>;

export type OpenRunResult =
  | { ok: true; run: Run }
  | { ok: false; refusal: OpenRunRefusal };

const openRunRefusal = <Code extends OpenRunRefusal["code"]>(
  code: Code,
  reason: Extract<OpenRunRefusal, { code: Code }>["reason"],
  message: string,
  detail?: OpenRunRefusal["detail"],
  context?: OpenRunRefusal["context"],
): OpenRunResult => {
  const refusal = {
    code,
    reason,
    disposition: dispositionByCode[code],
    message,
    ...(detail ? { detail } : {}),
    ...(context ? { context } : {}),
  } as Extract<OpenRunRefusal, { code: Code }>;
  return { ok: false, refusal };
};

const sourceRetryIntent = (
  intent: OpenRunIntent,
): intent is Extract<OpenRunIntent, { kind: "retry-after-completion" | "retry-after-lease-loss" }> =>
  intent.kind === "retry-after-completion" || intent.kind === "retry-after-lease-loss";

/**
 * The birth intents that exist because the platform lost a Run, each of which
 * raises the task's ceiling without an operator asking for it.
 *
 * `retry` is not one of them: an operator asking for another attempt is
 * measured against `runBudgetCeiling` and refused as `run-budget-exhausted`,
 * which is the path this bound deliberately leaves as the way out.
 * Completed merge-tail repairs are bounded by the repair-attempt limits and
 * grant fresh verification without spending a platform-loss refund.
 * `retry-after-completion` is not one either — a refunded external failure is
 * the separate class `EXTERNAL_FAILURE_REFUND_CAP` already bounds.
 */
const platformRefundIntent = (intent: OpenRunIntent): boolean =>
  intent.kind === "retry-after-lease-loss"
  || (intent.kind === "merge-tail-requeue" && !intent.repairCompleted)
  || intent.kind === "claim-invalidated";

/**
 * The only place a Run comes into existence.
 *
 * Every birth intent crosses the same task, stop-state, Agent-row, compound
 * assignee and integrator-binding guards. The discriminated intent owns the
 * few differences that are real domain rules: which prior configuration and
 * branch snapshot a retry preserves, and whether a human authorization may
 * grant enough budget for the next mechanical run.
 */
export const openRun = async (
  tx: Tx,
  taskId: string,
  intent: OpenRunIntent,
): Promise<OpenRunResult> => {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    include: {
      assigneeAgent: true,
      repo: true,
      templateStep: { include: { taskTemplate: { select: { name: true } } } },
      runs: { orderBy: { runNumber: "desc" }, take: 1 },
    },
  });
  if (!task) return openRunRefusal("task-not-found", "not-found", "Task not found");
  if (task.assigneeType !== AssigneeType.AGENT) {
    return openRunRefusal("task-assignee-type-invalid", "invalid-request", `Task ${task.id} cannot open a Run without an Agent assignee`);
  }
  if (!task.assigneeAgent) {
    return openRunRefusal("task-assignee-missing", "conflict", "Task assignee no longer exists; assign an agent before retrying");
  }
  if (!task.repo && (intent.kind === "enqueue"
    || intent.kind === "merge-tail-requeue"
    || intent.kind === "claim-invalidated"
    || intent.kind === "merge-tail-repair"
    || intent.kind === "task-created"
    || intent.kind === "integrator-authorized")) {
    return openRunRefusal("repo-required", "invalid-request", `Task ${task.id} cannot open a ${intent.kind} Run without a Repo`);
  }
  // Checked before the assignee, because an archived task is archived whoever
  // it is assigned to. The runner claims only `TODO|DOING` and unarchived tasks,
  // so a run queued here would never be claimed and never complete.
  if (task.archivedAt) {
    const message = intent.kind === "retry"
      ? "Cannot retry an archived task"
      : `Task ${task.name} is archived; unarchive it before queueing a run`;
    return openRunRefusal("task-archived", "archived-task", message, undefined, {
      taskId: task.id,
      taskName: task.name,
    });
  }
  // §D-P7, the last line of the exclusivity guard. `openRun` is the single
  // place a Run comes into existence, so a new birth intent inherits the
  // refusal by construction rather than by remembering to ask.
  const stopped = await stopStateFor(tx, task.id);
  const stopBypass = intent.kind === "enqueue" ? intent.stopBypass ?? null : null;
  // A recovered confirmation approval is itself the human-authorized exit
  // from this unresolved stop. Its named intent is the only path that may open
  // the renewed mechanical Run while the original stop remains in history.
  const humanReauthorization = intent.kind === "integrator-authorized";
  if (stopped && !humanReauthorization
    && (stopBypass?.integratorTaskId !== task.id || stopBypass.sourceStopId !== stopped.stop.stopId)) {
    return openRunRefusal(
      "integrator-stopped",
      "integrator-stopped",
      `Merge integrator stopped on ${stopped.stop.condition}; answer the stop question before starting another run`,
      undefined,
      { taskId: task.id, condition: stopped.stop.condition },
    );
  }
  // The assignee is re-read under the shared Agent-row mutex, not trusted from
  // the relation above: `openRun` is the single place a Run comes into
  // existence, so an archive committing in parallel has to lose here or be
  // refused for the Run this call is about to create.
  const lockedAgent = await lockAgentRow(tx, task.assigneeAgent.id);
  if (!lockedAgent || lockedAgent.archivedAt) {
    const message = intent.kind === "retry"
      ? `Assignee ${task.assigneeAgent.name} is archived; unarchive it to retry`
      : `Task ${task.name} assignee ${task.assigneeAgent.name} is archived; unarchive the agent to queue this step`;
    return openRunRefusal(
      "assignee-archived",
      "archived-assignee",
      message,
      undefined,
      { taskId: task.id, taskName: task.name, agentName: task.assigneeAgent.name },
    );
  }
  if (!compoundImplementationAssigneeValid(
    task.projectId,
    task.assigneeType,
    lockedAgent,
    task.templateStep,
  )) {
    return openRunRefusal(
      "compound-implementation-assignee",
      "compound-implementation-assignee",
      COMPOUND_IMPLEMENTATION_ASSIGNEE_MESSAGE,
      { code: COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE },
    );
  }
  // §D-P4, the last line of the binding invariant, for the same reason. The
  // Agent name comes from the locked re-read, never the stale task relation.
  const bindingRefusal = await integratorBindingRefusalFor(tx, {
    assigneeAgentName: lockedAgent.name,
    templateStep: task.templateStep,
  });
  if (bindingRefusal) {
    return openRunRefusal(
      "integrator-binding-invalid",
      "invalid-request",
      bindingRefusal,
      undefined,
      { code: "INTEGRATOR_BINDING_INVALID" },
    );
  }

  const prior = task.runs[0];
  if (intent.kind === "task-created" && prior) {
    return openRunRefusal("initial-run-already-exists", "conflict", `Task ${task.name} already has a Run`);
  }
  if ((intent.kind === "retry"
    || intent.kind === "integrator-authorized"
    || sourceRetryIntent(intent)) && !prior) {
    return openRunRefusal("prior-run-required", "conflict", `Task ${task.name} has no Run to continue`);
  }
  if ((sourceRetryIntent(intent) || intent.kind === "claim-invalidated") && prior?.id !== intent.sourceRunId) {
    return openRunRefusal("source-run-stale", "conflict", `Run ${intent.sourceRunId} is no longer the latest Run for task ${task.name}`);
  }
  if (intent.kind === "integrator-authorized" && (!task.templateStep || stepRole(task.templateStep) !== "integrator")) {
    return openRunRefusal("task-not-integrator", "invalid-request", `Task ${task.name} is not an integrator Step`);
  }

  const runNumber = (prior?.runNumber ?? 0) + 1;
  // The one place a platform-caused refund is decided, before any arm computes
  // the ceiling that refund would raise. Every intent that refunds crosses it,
  // so the bound cannot be escaped by arriving under a different intent kind —
  // which is exactly how lease loss, late-salvage claim invalidation and
  // merge-tail requeue escaped `run-budget-exhausted`, a refusal only `retry`
  // ever reached.
  const priorRefunds = prior?.leaseLossRefunds ?? 0;
  const refunding = platformRefundIntent(intent);
  if (refunding && prior && !leaseLossRefundDecision(prior, prior.id).refundAvailable) {
    return openRunRefusal(
      "lease-loss-refunds-exhausted",
      "conflict",
      `Lease-loss refunds exhausted after ${priorRefunds} platform-refunded attempts;`
        + " raise maxSessionsPerTask and retry",
      { leaseLossRefunds: priorRefunds, cap: LEASE_LOSS_REFUND_CAP },
      { taskId: task.id, taskName: task.name },
    );
  }
  const leaseLossRefunds = priorRefunds + (refunding ? 1 : 0);
  let budgetGrants = prior?.budgetGrants ?? 0;
  let maxRunsPerTask: number;
  if (intent.kind === "integrator-authorized") {
    budgetGrants = Math.max(budgetGrants, runNumber - task.maxSessionsPerTask);
    maxRunsPerTask = runBudgetCeiling(task.maxSessionsPerTask, budgetGrants);
  } else if (intent.kind === "merge-tail-requeue") {
    // A control-plane merge-tail refresh is not an agent failure. Carry the
    // grants already earned by the task and refund exactly this one requeue;
    // the running ceiling therefore follows the same derivation as every
    // other budget grant without introducing a merge-tail-specific cap.
    budgetGrants += intent.budgetGrant;
    maxRunsPerTask = runBudgetCeiling(task.maxSessionsPerTask, budgetGrants);
  } else if (intent.kind === "retry-after-completion") {
    budgetGrants = intent.sourceBudgetGrants + intent.budgetGrant;
    maxRunsPerTask = runBudgetCeiling(intent.sourceMaxRunsPerTask, intent.budgetGrant);
  } else if (intent.kind === "retry-after-lease-loss") {
    budgetGrants = intent.sourceBudgetGrants + 1;
    maxRunsPerTask = runBudgetCeiling(intent.sourceMaxRunsPerTask, 1);
  } else {
    maxRunsPerTask = runBudgetCeiling(task.maxSessionsPerTask, budgetGrants);
  }
  if (intent.kind === "retry" && prior && prior.runNumber >= maxRunsPerTask) {
    return openRunRefusal("run-budget-exhausted", "conflict", "Run budget exhausted");
  }

  // `chainLayer` is the post-expand authority, with `chainIndex` as the
  // compatibility fallback for legacy chain rows. Keep the read inside this
  // transaction and before any Run-birth work so a held successor produces no
  // Run or queue activity. The database prevents a HELD control without a
  // layer; malformed legacy Task rows still fail closed at this seam.
  const taskLayer = layerOf({ layer: task.chainLayer, index: task.chainIndex });
  if (task.chainId) {
    const control = await readChainControl(tx, { projectId: task.projectId, chainId: task.chainId });
    if (heldPredicate({
      projectId: task.projectId,
      chainId: task.chainId,
      layer: task.chainLayer,
      index: task.chainIndex,
    }, control)) {
      const message = control.heldLayer === 0
        ? `Chain ${task.chainId} is held before its first layer; Task ${task.id} cannot queue a Run`
        : taskLayer === null || control.heldLayer === null
        ? `Chain ${task.chainId} is held; Task ${task.id} cannot queue a Run`
        : `Chain ${task.chainId} is held after layer ${control.heldLayer}; Task ${task.id} at layer ${taskLayer} cannot queue a Run`;
      return openRunRefusal(
        "chain-held",
        "chain-held",
        message,
        { chainId: task.chainId, taskLayer, heldLayer: control.heldLayer },
        { taskId: task.id, chainId: task.chainId, taskLayer, heldLayer: control.heldLayer },
      );
    }
  }

  // Every intent asks the same module, so no arm can put a Step on a different
  // branch from the rest of its Chain, and no caller has to fill in a head.
  const branches = await resolveRunBranches(tx, task, {
    intent: intent.kind,
    runNumber,
    prior: prior ?? null,
  });

  // A salvaged publication can sit behind an intermediate cancelled Run, so
  // the latest Run alone is not the ownership proof. Bind the relaxation to
  // the persisted Task/repo/ref relation that resolved as this Run's base.
  // This is evaluated once, before Run birth; later salvage repair may not
  // rewrite a Run's snapshotted commit contract.
  const continuesOwnPublication = task.repoId && branches.targetBranch
    ? await tx.run.findFirst({
      where: {
        taskId: task.id,
        repoId: task.repoId,
        pushedBranch: branches.targetBranch,
      },
      select: { id: true },
    })
    : null;

  // An automatic retry normally re-runs the exact configuration that failed,
  // so a mid-Run agent edit cannot silently change what the next attempt is.
  // A *reassignment* is the one case where that would be wrong: the operator
  // moved this task to a different Agent precisely so the retry runs that
  // Agent's runner, model, service tier and native subagent configuration.
  // Preserving the prior snapshot there would open a Run billed to the new
  // Agent but executed as the old one.
  const preservedConfiguration = sourceRetryIntent(intent) && prior && prior.agentId === lockedAgent.id
    ? {
      runner: prior.runner,
      model: prior.model,
      codexServiceTier: prior.codexServiceTier,
      subagentModel: prior.subagentModel,
      subagentMaxConcurrent: prior.subagentMaxConcurrent,
    }
    : null;
  const configuration = intent.kind === "integrator-authorized"
    ? {
      runner: prior?.runner ?? RunnerKind.CLAUDE,
      model: lockedAgent.model,
    }
    : preservedConfiguration ?? (() => {
      const derived = deriveRunConfig(lockedAgent, task.templateStep);
      return {
        ...derived,
        ...nativeImplementationSubagentRunConfig(derived.runner, task.templateStep),
      };
    })();
  const preservesPriorTiming = intent.kind === "retry" || sourceRetryIntent(intent);

  const run = await tx.run.create({ data: {
    projectId: task.projectId,
    taskId: task.id,
    ...((intent.kind === "retry" || sourceRetryIntent(intent)) && prior?.goalId ? { goalId: prior.goalId } : {}),
    agentId: lockedAgent.id,
    repoId: task.repoId,
    runNumber,
    dedupeKey: `task:${task.id}:run:${runNumber}`,
    ...configuration,
    // An exact prompt does not exist until a runner dispatches one. The start
    // route fills this with the hash of those exact bytes, including resume
    // continuation input; a queued or failed-to-start Run stays null.
    promptHash: null,
    targetBranch: branches.targetBranch,
    branch: branches.branch,
    opensPullRequest: intent.kind === "integrator-authorized" ? false : task.opensPullRequest,
    // Canonical Steps own an explicit commit contract. A manual Task retains
    // the pre-contract delivery boundary: asking for a pull request requires a
    // commit, while branch-only work may complete through an external action or
    // durable prose without inventing a repository change.
    requiresCommit: continuesOwnPublication
      ? false
      : task.templateStep?.requiresCommit ?? task.opensPullRequest,
    maxDurationMin: preservesPriorTiming ? prior?.maxDurationMin ?? task.maxDurationMin : task.maxDurationMin,
    stallTimeoutMin: preservesPriorTiming ? prior?.stallTimeoutMin ?? task.stallTimeoutMin : task.stallTimeoutMin,
    // The configured budget plus the grants already earned, not the budget
    // alone. Automatic retries deliberately use the already-authorized source
    // ceiling as their base: a mid-Run task edit cannot retroactively revoke a
    // Run, while later operator actions recompute from the current task budget.
    maxRunsPerTask,
    budgetGrants,
    // Written only here, never by the terminalize path that records the refund
    // on the lost Run: two writers would count one refund twice, and this is
    // the row every later birth reads its predecessor's total from.
    leaseLossRefunds,
    readyAt: intent.readyAt,
  } });
  return { ok: true, run };
};

/** What one savepoint-guarded birth attempt did. */
export type RunBirthAttempt =
  | { outcome: "opened"; run: Run }
  | { outcome: "refused"; refusal: OpenRunRefusal }
  | { outcome: "already-queued" };

// Each attempt rolls back or releases before the caller does anything else, so
// one bounded literal serves every call site and no external identifier is ever
// interpolated into SQL.
const RUN_BIRTH_SAVEPOINT = "run_birth_attempt";

/**
 * Open a Run without forfeiting the transaction the caller still has to write
 * in.
 *
 * A refused birth and a lost dedupe race both leave PostgreSQL's transaction
 * unusable for the writes every caller makes next — park the Task, record the
 * refusal, advance the chain. Rolling back to a savepoint is the only way those
 * writes survive, so the savepoint belongs to the birth rather than to each
 * caller that has to remember it.
 *
 * `already-queued` is the dedupe key losing a race: another writer created the
 * same Run. Nothing is wrong with the Task, so it is not a refusal.
 */
export const attemptRunBirth = async (
  tx: Tx,
  open: (tx: Tx) => Promise<OpenRunResult>,
): Promise<RunBirthAttempt> => {
  const rawTx = tx as Tx & { $executeRawUnsafe?: (query: string) => Promise<number> };
  const executeRaw = typeof rawTx.$executeRawUnsafe === "function"
    ? rawTx.$executeRawUnsafe.bind(rawTx)
    : null;
  if (executeRaw) await executeRaw(`SAVEPOINT ${RUN_BIRTH_SAVEPOINT}`);
  const rollback = async (): Promise<void> => {
    if (!executeRaw) return;
    await executeRaw(`ROLLBACK TO SAVEPOINT ${RUN_BIRTH_SAVEPOINT}`);
    await executeRaw(`RELEASE SAVEPOINT ${RUN_BIRTH_SAVEPOINT}`);
  };
  let opened: OpenRunResult;
  try {
    opened = await open(tx);
  } catch (error: unknown) {
    await rollback();
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { outcome: "already-queued" };
    }
    throw error;
  }
  if (!opened.ok) {
    await rollback();
    return { outcome: "refused", refusal: opened.refusal };
  }
  if (executeRaw) await executeRaw(`RELEASE SAVEPOINT ${RUN_BIRTH_SAVEPOINT}`);
  return { outcome: "opened", run: opened.run };
};

export const errorForOpenRunRefusal = (refusal: OpenRunRefusal): Error => {
  if (refusal.reason === "archived-task") {
    return new ArchivedTaskError(
      String(refusal.context?.taskId ?? "unknown"),
      String(refusal.context?.taskName ?? "unknown"),
    );
  }
  if (refusal.reason === "archived-assignee") {
    return new ArchivedAssigneeError(
      String(refusal.context?.taskId ?? "unknown"),
      String(refusal.context?.taskName ?? "unknown"),
      String(refusal.context?.agentName ?? "unknown"),
    );
  }
  if (refusal.reason === "integrator-stopped") {
    return new IntegratorStoppedError(
      String(refusal.context?.taskId ?? "unknown"),
      String(refusal.context?.condition ?? "unknown"),
    );
  }
  if (refusal.reason === "chain-held") {
    const nullableLayer = (field: "taskLayer" | "heldLayer"): number | null => {
      const value = refusal.context?.[field];
      if (value === null) return null;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Chain hold refusal is missing numeric ${field}`);
      }
      return value;
    };
    return new ChainHeldError(
      String(refusal.context?.taskId ?? "unknown"),
      String(refusal.context?.chainId ?? "unknown"),
      nullableLayer("taskLayer"),
      nullableLayer("heldLayer"),
    );
  }
  if (refusal.reason === "compound-implementation-assignee") {
    return new CompoundImplementationAssigneeError();
  }
  if (refusal.context?.code === "INTEGRATOR_BINDING_INVALID") {
    return new IntegratorBindingError(refusal.message);
  }
  // A caller that raises a refusal instead of parking it must still answer with
  // the refusal's own family. Only `not-found` has none: a Task that vanished
  // between the caller's read and the birth is an invariant violation, and an
  // opaque error is the honest answer to it.
  if (refusal.reason === "invalid-request" || refusal.reason === "conflict") {
    return new WorkflowRefusalError(refusal.reason, refusal.message);
  }
  return new Error(refusal.message);
};

export const enqueueTaskRunInternal = async (
  tx: Tx,
  taskId: string,
  now: Date,
  stopBypass: IntegratorStopBypass | null,
  options: EnqueueTaskRunOptions = {},
): Promise<OpenRunResult> => openRun(tx, taskId, options.budgetGrant === 1
    ? {
      kind: "merge-tail-requeue", readyAt: now, budgetGrant: 1,
      ...(options.repairCompleted ? { repairCompleted: true } : {}),
    }
    : { kind: "enqueue", readyAt: now, stopBypass });

/**
 * The only enqueue option that may alter a task's budget. It is deliberately
 * a literal one-shot grant rather than a caller-supplied number: merge-tail
 * retries are platform compensation for a successful run, not agent failure,
 * and every other enqueue/retry path must retain its existing budget rule.
 */
export type EnqueueTaskRunOptions = { budgetGrant?: never } | { budgetGrant: 1; repairCompleted?: true };

export const enqueueTaskRun = async (
  tx: Tx,
  taskId: string,
  now = new Date(),
  options: EnqueueTaskRunOptions = {},
): Promise<Run> => {
  const opened = await enqueueTaskRunInternal(tx, taskId, now, null, options);
  if (!opened.ok) throw errorForOpenRunRefusal(opened.refusal);
  return opened.run;
};

// The card body is one string serving two readers. Feishu is the binding one:
// `cards.ts` caps the rendered body at 3 000 characters because Feishu rejects
// oversized cards, so the preview must leave room for the gate's own prose. The
// board no longer depends on this preview at all — it renders the producing
// step's full output beside the decision (`artifactTaskId`).
const GATE_OUTPUT_PREVIEW = 2_000;

const outputPreview = async (tx: Tx, taskId: string | null): Promise<string> => {
  if (!taskId) return "";
  const output = await tx.taskStepOutput.findUnique({ where: { taskId }, select: { kind: true, body: true } });
  if (!output) return "";
  const body = output.body.trim();
  const shown = body.length > GATE_OUTPUT_PREVIEW ? `${body.slice(0, GATE_OUTPUT_PREVIEW)}\n…（预览已截断，完整产物见 Inbox 页的产物卡片）` : body;
  return `\n\n产物（${output.kind}）：\n${shown}`;
};

export const gateQuestion = async (tx: Tx, gateTaskId: string, sourceRunId: string, chatId: string | null) => {
  const [task, run] = await Promise.all([
    tx.task.findUniqueOrThrow({ where: { id: gateTaskId } }),
    tx.run.findUniqueOrThrow({ where: { id: sourceRunId }, include: { session: true } }),
  ]);
  // A gate can only follow a completed Run, and every dispatched Run owns a
  // Session. Missing one means persisted control-plane state is corrupt.
  if (!run.session) throw new Error(`Run ${sourceRunId} has no session for approval gate`);
  const thread = chatId ? await tx.inboxThread.upsert({
    where: { channel_externalChatId_sessionId: { channel: "FEISHU", externalChatId: chatId, sessionId: run.session.id } },
    create: { channel: "FEISHU", externalChatId: chatId, sessionId: run.session.id, taskId: task.id },
    update: { taskId: task.id },
  }) : null;
  const delivery = run.pullRequestUrl
    ? `\n\nPull request: ${run.pullRequestUrl}`
    : run.deliveryInstructions ? `\n\n${run.deliveryInstructions}` : "";
  // §D-P3 Phase A. A gate whose successor executes mechanically opens a
  // placeholder card and asks the evidence worker to fill it, rather than
  // reading GitHub here: this function runs inside applyInboxDecisionTx in the
  // separate @anneal/inbox process, which can reach neither the API's GitHub
  // client nor its configuration (MF-3). The read also must not happen inside
  // this lock-holding transaction (SF-2). Chains without a mechanical successor never enter
  // this branch and are byte-for-byte unchanged.
  const integrator = await gateFeedsIntegratorStep(tx, task);
  if (integrator) {
    const target = await resolveChainTarget(tx, task);
    if (target.resolved) {
      const requested = await requestMergeEvidence(tx, {
        gateTaskId: task.id,
        integratorTaskId: integrator.id,
        sourceRunId,
        agentId: run.agentId,
        sessionId: run.session.id,
        threadId: thread?.id ?? null,
        purpose: "gate",
        repository: target.repository,
        prNumber: target.prNumber,
        dedupeKey: `gate:task:${task.id}:run:${sourceRunId}`,
      });
      return tx.inboxMessage.findUniqueOrThrow({ where: { id: requested.cardId } });
    }
    // An unresolvable target cannot produce an evidence card. The gate still
    // opens through the ordinary path so a human is not left with silence; the
    // approval simply produces no authorization, and step 12 later stops
    // target-unresolvable — fail closed, and the §D-P8 repair is the exit.
  }
  // The approver decides from the card; the produced artifact rides along so
  // they do not have to open the Tasks page for the common case.
  const preview = await outputPreview(tx, run.taskId);
  return tx.inboxMessage.create({ data: {
    from: InboxSender.AGENT,
    agentId: run.agentId,
    sessionId: run.session.id,
    taskId: task.id,
    gateTaskId: task.id,
    threadId: thread?.id ?? null,
    kind: "MULTIPLE_CHOICE",
    body: `审批闸门：${task.name}\n\n请确认本步骤产出。批准后继续；打回后重新执行产出步骤。${delivery}${preview}`,
    choices: [{ id: "approve", label: "批准并继续" }, { id: "reject", label: "打回上一步" }],
    dedupeKey: `gate:task:${task.id}:run:${sourceRunId}`,
    deliveryStatus: InboxDeliveryStatus.PENDING,
  } });
};
