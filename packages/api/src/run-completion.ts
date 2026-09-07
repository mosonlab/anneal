import {
  activateChainSuccessor,
  type ClaimantClass,
  ACTIVE_RUN_STATUSES,
  advanceTemplateTask,
  attemptRunBirth,
  basePublishedStamp,
  budgetGates,
  carryMergeRecoveryRun,
  CleanupStatus,
  decideRunOutputSatisfaction,
  executionModeFor,
  EXTERNAL_FAILURE_REFUND_CAP,
  FailureClass,
  failurePhases,
  gateQuestion,
  INTEGRATOR_OUTPUT_KIND,
  isIntegratorStep,
  isMergeReadinessStep,
  isRegressionVerificationOutputKind,
  latestMarker,
  lockChainRows,
  lockRunRow,
  MERGE_TAIL_KIND,
  mechanicalPrincipalRefusal,
  openRun,
  parseMergeResult,
  Prisma,
  type PrismaClient,
  PushStatus,
  readLatestMarker,
  readMarkers,
  recordIntegratorStop,
  REGRESSION_VERIFICATION_OUTPUT_KIND,
  runBudgetCeiling,
  type RunOutcome,
  runOutcomeVerdict,
  RunStatus,
  stepRole,
  TaskStatus,
} from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";
import { z } from "zod";

import {
  canonicalImplementationOutputRefusal,
  canonicalOutputRefusal,
  isCanonicalAgentStep,
  outputIsImmutableOncePersisted,
  requiredOutputKind,
} from "./canonical-task-output.js";
import {
  classifyEnvelope,
  isTextMatchedTransientProviderFailure,
  jsonValue,
  retryDelayMs,
} from "./execution.js";
import {
  completionActivityBody,
  completionAdvancement,
  type CompletionAdvancementFacts,
} from "./completion-advancement.js";
import {
  activeRepairRecoverySourceRun,
  handleRegressionCompletion,
  mergeTailRequeueContextForRun,
  recordMergeTailRequeue,
  regressionVerdictForRun,
  settleMergeTailCompletion,
  stopUnboundRepair,
} from "./merge-tail-actions.js";
import { explainFenceRefusal, fenceRefusalResponse, fencedRunWhere, type RunFence } from "./run-fence.js";
import { terminalizeRun } from "./run-terminal.js";
import {
  commitWithLeaseOutcome,
  type ReleaseMergeLease,
} from "./merge-lease.js";
import type { Refusal } from "./refusal.js";
import { FAILURE_REASON_LIMIT, failureReasonText } from "./failure-reason.js";
import { lockTask, lockTaskMutationRows } from "./task-write.js";

export const worktreeContainmentViolationsInput = z.array(z.string().min(1).max(4096)).max(5000);

// Mirrors packages/db/src/failure-envelope.ts, which is the canonical shape,
// and packages/runner/src/envelope.ts, which builds it. This schema is the seam
// that catches drift between the two.
//
// Every field is defaulted rather than required wherever a default is
// unambiguous, and the free-text limits are 16x what the runner truncates to:
// a rejected completion is not a rejected envelope, it is a run that never
// records a terminal state and is later reconciled as LOST.
const failureEnvelopeInput = z.object({
  version: z.number().int().positive(),
  phase: z.enum(failurePhases),
  runnerClass: z.nativeEnum(FailureClass).nullable().default(null),
  exitCode: z.number().int().nullable().default(null),
  signal: z.string().max(64).nullable().default(null),
  terminationReason: z.string().max(4000).nullable().default(null),
  terminalEventSeen: z.boolean().default(false),
  terminalSuccess: z.boolean().default(false),
  agentExited: z.boolean().default(false),
  providerError: z.string().max(64_000).nullable().default(null),
  stderrSummary: z.string().max(64_000).nullable().default(null),
  stdoutSummary: z.string().max(64_000).nullable().default(null),
  timedOut: z.boolean().default(false),
  transient: z.boolean().default(false),
  timeoutMs: z.number().int().nonnegative().nullable().default(null),
});

/**
 * What the Run ended as, decided once by the runner.
 *
 * The wire used to carry fragments of this verdict —
 * `terminalEventSeen`/`terminalSuccess` for the control plane to re-run the
 * runner's own success predicate on, plus `failureClass`, `retryable`,
 * `externalFailure` and `failureReason` for it to then ignore whenever an
 * envelope was present. One named case replaces all seven, and
 * `runOutcomeVerdict` is the only reader.
 */
const runOutcomeInput: z.ZodType<RunOutcome> = z.discriminatedUnion("case", [
  z.object({ case: z.literal("succeeded") }),
  z.object({ case: z.literal("regression-mechanically-settled") }),
  z.object({ case: z.literal("delivered-then-disconnected") }),
  z.object({
    case: z.literal("budget-exhausted"),
    gate: z.enum(budgetGates),
    reason: failureReasonText(FAILURE_REASON_LIMIT),
  }),
  z.object({
    case: z.literal("required-output-unsatisfied"),
    reason: failureReasonText(FAILURE_REASON_LIMIT),
  }),
  z.object({
    case: z.literal("terminal-protocol-failure"),
    reason: failureReasonText(FAILURE_REASON_LIMIT),
  }),
  z.object({
    case: z.literal("provider-failure"),
    reason: failureReasonText(FAILURE_REASON_LIMIT),
    envelope: failureEnvelopeInput,
  }),
]);

export const completionInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: z.string().min(1),
  outcome: runOutcomeInput,
  // Exit facts, kept as the process reported them. Nothing here is read as a
  // verdict: that is what `outcome` is for, and re-deriving success from these
  // is what made the runner rewrite them.
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
  terminationReason: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  // The ref the runner actually handed to `git push`, which is not always
  // `branch`: a WIP salvage pushes a per-run branch while `branch` still reports
  // the workspace's. It is the only publication evidence resolveRunBranches
  // trusts, so it must survive the trip verbatim.
  pushedBranch: z.string().nullable().optional(),
  baseSha: z.string().nullable().optional(),
  headSha: z.string().nullable().optional(),
  // The first parent of the salvage commit `headSha` names, sent only on the
  // salvage path. The next Run of the task is handed both, so a step bound to
  // a particular head can recognise its own salvaged attempt.
  salvageParentSha: z.string().nullable().optional(),
  output: z.string().max(500_000).nullable().optional(),
  pushStatus: z.nativeEnum(PushStatus).default(PushStatus.NOT_REQUESTED),
  pushRemote: z.string().nullable().optional(),
  pushError: z.string().max(4000).nullable().optional(),
  pullRequestUrl: z.string().nullable().optional(),
  pullRequestNumber: z.number().int().positive().nullable().optional(),
  deliveryInstructions: z.string().max(8000).nullable().optional(),
  cleanupStatus: z.nativeEnum(CleanupStatus),
  cleanupFailureReason: z.string().max(4000).nullable().optional(),
  workspaceRetained: z.boolean().default(false),
  // Report-only completion evidence. An omitted or empty list means that the
  // runner observed no worktree outside its run workspace; it never changes
  // terminal outcome classification.
  worktreeContainmentViolations: worktreeContainmentViolationsInput.optional(),
}).describe(`Run completion contract version ${RUN_COMPLETION_CONTRACT_VERSION}`);

export type CompletionInput = z.infer<typeof completionInput>;

const TARGET_FETCH_BLOCK_REASON = "target-fetch-failed";

type OutputFailurePolicyInput = {
  outputKind: string | null | undefined;
  outcome: RunOutcome;
};

/** Convert only Regression's machine-readable target-fetch block from an
 * absent-output agent failure into an external git failure. */
export const completionOutputFailurePolicy = ({
  outputKind,
  outcome,
}: OutputFailurePolicyInput): {
  externalFailure: boolean;
  cappedExternalFailure: boolean;
} => {
  const targetFetchFailed = outputKind === REGRESSION_VERIFICATION_OUTPUT_KIND
    && outcome.case === "required-output-unsatisfied"
    && outcome.reason.includes(TARGET_FETCH_BLOCK_REASON);
  return {
    externalFailure: targetFetchFailed,
    cappedExternalFailure: targetFetchFailed,
  };
};

type RefundDecisionInput = {
  runNumber: number;
  external: boolean;
  refundable: boolean;
  mechanical: boolean;
  capped: boolean;
  priorCappedRefunds: number;
};

type RefundActivity = {
  body: string;
  metadata: {
    kind: "externalFailureRefund.granted" | "externalFailureRefund.refused";
    schemaVersion: 1;
    policy: "capped" | "uncapped";
    granted: boolean;
    cap: number;
    capReached: boolean;
  };
};

export type ExternalFailureRefundDecision = {
  refunded: 0 | 1;
  capReached: boolean;
  activity: RefundActivity | null;
};

const refundActivity = (
  body: string,
  policy: RefundActivity["metadata"]["policy"],
  granted: boolean,
  capReached: boolean,
): RefundActivity => ({
  body,
  metadata: {
    kind: granted ? "externalFailureRefund.granted" : "externalFailureRefund.refused",
    schemaVersion: 1,
    policy,
    granted,
    cap: EXTERNAL_FAILURE_REFUND_CAP,
    capReached,
  },
});

export const completionBudgetAfterRefund = (
  maxRunsPerTask: number,
  budgetGrants: number,
  refunded: 0 | 1,
): { maxRunsPerTask: number; budgetGrants: number } => ({
  maxRunsPerTask: runBudgetCeiling(maxRunsPerTask, refunded),
  budgetGrants: budgetGrants + refunded,
});

/** Decide and narrate one budget refund. `priorCappedRefunds` counts only the
 * grants emitted with the capped policy; legacy plumbing refunds do not
 * consume this allowance. */
export const externalFailureRefundDecision = ({
  runNumber,
  external,
  refundable,
  mechanical,
  capped,
  priorCappedRefunds,
}: RefundDecisionInput): ExternalFailureRefundDecision => {
  if (!external) return { refunded: 0, capReached: false, activity: null };
  const policy = capped ? "capped" : "uncapped";
  if (mechanical) {
    return {
      refunded: 0,
      capReached: false,
      activity: refundActivity(
        `Run ${runNumber} external failure was not refunded because the step is mechanical`,
        policy,
        false,
        false,
      ),
    };
  }
  if (!refundable) {
    return {
      refunded: 0,
      capReached: false,
      activity: refundActivity(
        `Run ${runNumber} external failure was not eligible for a budget refund`,
        policy,
        false,
        false,
      ),
    };
  }
  if (capped && priorCappedRefunds >= EXTERNAL_FAILURE_REFUND_CAP) {
    return {
      refunded: 0,
      capReached: true,
      activity: refundActivity(
        `Run ${runNumber} external-failure refund cap was reached (${EXTERNAL_FAILURE_REFUND_CAP})`,
        policy,
        false,
        true,
      ),
    };
  }
  const ordinal = capped ? priorCappedRefunds + 1 : null;
  return {
    refunded: 1,
    capReached: false,
    activity: refundActivity(
      capped
        ? `Run ${runNumber} received external-failure budget refund ${ordinal} of ${EXTERNAL_FAILURE_REFUND_CAP}`
        : `Run ${runNumber} received an external-failure budget refund`,
      policy,
      true,
      false,
    ),
  };
};

const isDocumentationStep = (step: { outputKind: string } | null | undefined): boolean =>
  Boolean(step && stepRole(step) === "documentation");

/**
 * Metadata kind for a repair whose chain template owns no Documentation Step.
 * Deliberately not a `MERGE_TAIL_KIND` member: it narrates one completion and
 * is never read back as tail state.
 */
const MERGE_TAIL_DOCUMENTATION_ABSENT_KIND = "mergeTail.documentationStepAbsent";

/**
 * Merge-tail repair markers point at an existing canonical task rather than a
 * linked-list successor. Queue that explicit target under the same layer mutex
 * as ordinary chain activation; readiness remains server-owned and is only
 * marked queued for its worker.
 */
const activateMergeTailTarget = async (
  tx: Prisma.TransactionClient,
  taskId: string,
  now: Date,
  options: { recoverySourceRunId?: string } = {},
): Promise<void> => {
  if (!await lockTaskMutationRows(tx, taskId)) return;
  const target = await tx.task.findUnique({
    where: { id: taskId },
    include: {
      runs: { where: { status: { in: ACTIVE_RUN_STATUSES } }, take: 1 },
      assigneeAgent: { select: { name: true, archivedAt: true } },
      templateStep: { include: { taskTemplate: { select: { name: true } } } },
    },
  });
  if (!target || target.status === TaskStatus.DONE || target.runs.length > 0) return;
  if (target.archivedAt) {
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: "Merge-tail target is archived and was not queued",
    } });
    return;
  }
  if (isMergeReadinessStep(target.templateStep)) {
    // Readiness runs on the server worker, which only claims TODO/DOING.
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: "Merge-tail readiness target queued for server worker",
      metadata: { kind: MERGE_TAIL_KIND.readiness, schemaVersion: 1, state: "queued" },
    } });
    return;
  }
  if (target.assigneeAgent?.archivedAt) {
    const reason = `Assignee ${target.assigneeAgent.name} is archived; unarchive the agent and retry to queue this merge-tail target`;
    await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: `Merge-tail target not queued because assignee ${target.assigneeAgent.name} is archived`,
    } });
    return;
  }
  const claimed = await tx.task.updateMany({
    where: { id: taskId, status: { in: [TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW] } },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  if (claimed.count !== 1) return;
  const attempt = await attemptRunBirth(tx, (tx) => openRun(
    tx,
    taskId,
    { kind: "merge-tail-requeue", readyAt: now, budgetGrant: 1, repairCompleted: true },
  ));
  if (attempt.outcome === "already-queued") {
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: "Merge-tail target already has the run created by a concurrent activation",
    } });
    return;
  }
  if (attempt.outcome === "refused") {
    const refusal = attempt.refusal;
    switch (refusal.disposition) {
      case "held":
        await tx.taskActivity.create({ data: {
          taskId,
          actorType: "control-plane",
          body: `Merge-tail target remains queued because ${refusal.message}`,
        } });
        return;
      // A merge-tail target owns no stop record of its own, so a stop reads
      // here exactly as any other fault: the target is surfaced for an operator.
      case "stopped":
      case "fault":
        await tx.task.update({
          where: { id: taskId },
          data: { status: TaskStatus.REVIEW, failureReason: refusal.message },
        });
        await tx.taskActivity.create({ data: {
          taskId,
          actorType: "control-plane",
          body: `Merge-tail target was not queued: ${refusal.message}`,
          metadata: { refusal: refusal.code },
        } });
        return;
      default: {
        const unhandled: never = refusal.disposition;
        return unhandled;
      }
    }
  }
  if (isDocumentationStep(target.templateStep)) {
    await recordMergeTailRequeue(tx, {
      taskId,
      runId: attempt.run.id,
      ...options,
    });
  }
  if (isRegressionVerificationOutputKind(target.templateStep?.outputKind)
    && options.recoverySourceRunId !== undefined) {
    await carryMergeRecoveryRun(tx, {
      regressionTaskId: taskId,
      recoveryRunId: attempt.run.id,
      previousRecoveryRunId: options.recoverySourceRunId,
    });
  }
  await tx.taskActivity.create({ data: {
    taskId,
    actorType: "control-plane",
    body: "Merge-tail target queued",
  } });
};

/** What one completion did, and the object the route hands back verbatim. */
export type RunCompletion = {
  taskId: string | null;
  succeeded: boolean;
  retryCreated: boolean;
  failureClass: FailureClass | null;
};

/** Why a completion wrote nothing. Three distinct answers the route used to
 *  distinguish with an inline `null` plus a follow-up query of its own. */
export type CompleteRunRefusal = Refusal;

export type CompleteRunInput = {
  runId: string;
  body: CompletionInput;
  claimantClass: ClaimantClass;
};

type CompletionEvidenceStep = {
  outputKind: string;
  requiresCommit: boolean;
  taskTemplate?: { name: string };
};

type CompletionEvidenceRun = {
  id: string;
  runNumber: number;
  maxRunsPerTask: number;
  requiresCommit: boolean;
  opensPullRequest: boolean;
  baseSha: string | null;
  task: { templateStep: CompletionEvidenceStep | null } | null;
};

type CompletionEvidenceOutput = Parameters<typeof canonicalOutputRefusal>[1];

type CompletionEvidenceRequirement =
  | { kind: "canonical-implementation"; headSha: string }
  | { kind: "current-run-output"; outputKind: string }
  | null;

const completionEvidenceRequirement = (
  run: CompletionEvidenceRun,
  reportedSuccess: boolean,
  completionHeadSha: string | null,
): CompletionEvidenceRequirement => {
  if (!reportedSuccess) return null;
  // `requiresCommit` is the immutable Run-birth snapshot. Comparing it with
  // the configured contract distinguishes the own-publication relaxation from
  // Steps that were always non-committing, without re-deriving publication
  // ownership after birth.
  const configuredRequiresCommit = run.task?.templateStep?.requiresCommit ?? run.opensPullRequest;
  if (
    configuredRequiresCommit
    && !run.requiresCommit
    && run.baseSha !== null
    && completionHeadSha === run.baseSha
  ) {
    return { kind: "canonical-implementation", headSha: run.baseSha };
  }
  const requiredKind = requiredOutputKind(run.task?.templateStep);
  return requiredKind && run.runNumber < run.maxRunsPerTask
    ? { kind: "current-run-output", outputKind: requiredKind }
    : null;
};

export const completionEvidenceRefusal = (
  run: CompletionEvidenceRun,
  reportedSuccess: boolean,
  completionHeadSha: string | null,
  persistedOutput: CompletionEvidenceOutput,
): string | null => {
  const requirement = completionEvidenceRequirement(run, reportedSuccess, completionHeadSha);
  if (!requirement) return null;
  if (requirement.kind === "canonical-implementation") {
    return canonicalImplementationOutputRefusal(
      persistedOutput,
      run.id,
      requirement.headSha,
    );
  }
  // The same decision the session status route hands the runner, read here so
  // completion and the Run that asked cannot disagree about whether the
  // deliverable exists.
  const satisfaction = decideRunOutputSatisfaction(
    run.id,
    {
      outputKind: requirement.outputKind,
      immutableOncePersisted: outputIsImmutableOncePersisted(run.task?.templateStep),
      remediable: !isRegressionVerificationOutputKind(run.task?.templateStep?.outputKind),
    },
    persistedOutput,
  );
  return satisfaction.case === "absent"
    ? `missing ${satisfaction.outputKind} task output for current Run ${run.id}`
    : null;
};

/**
 * Complete a run: one ReadCommitted transaction of 33 writes, and the
 * pre-transaction principal read that refuses a mechanical completion from the
 * wrong bearer before anything is written.
 *
 * The isolation level is the action's, not the route's — ReadCommitted lets
 * successor CAS losers observe count=0 instead of surfacing a serialization
 * failure to runners, which is a statement about run completion rather than
 * about HTTP.
 *
 * The merge-lease release and the ownership assertion stay with the caller:
 * they are control-plane facts about the process, not about the run.
 */
export const completeRun = async (
  db: PrismaClient,
  { runId, body, claimantClass }: CompleteRunInput,
  releaseMergeLease?: ReleaseMergeLease,
): Promise<RunCompletion | CompleteRunRefusal> => {
  const now = new Date();
  const fence: RunFence = { runId, runnerId: body.runnerId, fencingToken: body.fencingToken, at: now };
  // §4.0. Completing a mechanical run is what makes the chain believe a merge
  // happened, so it is bound to the same independently authenticated
  // principal that was allowed to claim it — and, symmetrically, the executor
  // credential completes nothing else. Read before the transaction: the
  // step binding of a claimed run is immutable (§D-P4 refuses to move it), so
  // there is no state to lose by refusing here, and nothing has been written.
  const completing = await db.run.findUnique({
    where: { id: runId },
    select: { runnerId: true, task: { select: { templateStep: { select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } } } } } },
  });
  if (completing) {
    const refusal = mechanicalPrincipalRefusal(
      executionModeFor(completing.task?.templateStep ?? null),
      claimantClass,
      completing.runnerId ?? body.runnerId,
    );
    if (refusal) return { reason: "forbidden", message: refusal };
  }
  const result = await commitWithLeaseOutcome<RunCompletion | CompleteRunRefusal>(db, async (tx) => {
    // Run owns fencing, cancellation, and terminalization. Take that mutex
    // before Task so completion, cancellation, and canonical output writes
    // cannot deadlock by entering the same two rows in opposite orders.
    await lockRunRow(tx, runId);
    const run = await tx.run.findFirst({
      where: fencedRunWhere(fence),
      include: {
        // §D-P5. The step's template name is part of the step-12 identity, so
        // the completion route has to read it rather than the step alone.
        task: { include: { templateStep: { include: { taskTemplate: { select: { name: true } } } }, repo: { select: { defaultBranch: true } } } },
        session: true,
      },
    });
    if (!run?.session) return null;
    const mechanical = isIntegratorStep(run.task?.templateStep ?? null);
    // The runner decided this once, at the end of its own run, from facts it
    // alone held. Nothing below re-derives it from the exit evidence.
    const reported = runOutcomeVerdict(body.outcome, classifyEnvelope);
    // Mechanical output is the executor's durable account of whether it
    // merged. It may be committed immediately before a transport failure in
    // the separate completion request, so inspect it before classifying that
    // request as a protocol failure. Ownership is exact: an output from any
    // other Run (or an operator-created row without runId) is not evidence for
    // this completion and must retain fail-loud behavior.
    const persistedMechanicalOutput = mechanical && run.taskId
      ? await tx.taskStepOutput.findUnique({
          where: { taskId: run.taskId },
          select: { runId: true, kind: true, body: true },
        })
      : null;
    const persistedMechanicalOutcome = persistedMechanicalOutput?.runId === run.id
      && persistedMechanicalOutput.kind === INTEGRATOR_OUTPUT_KIND
      ? parseMergeResult(persistedMechanicalOutput)
      : null;
    const authoritativeMechanicalOutcome = !reported.succeeded
      && persistedMechanicalOutcome
      && persistedMechanicalOutcome.outcome !== "malformed"
      ? persistedMechanicalOutcome
      : null;
    // A step whose deliverable only its own agent can author is not done
    // because its session ended. An adapter reads the end of a turn as the end
    // of the session, so a step that parked on a background wait — a merge
    // lease, a gate verdict — settled SUCCEEDED with nothing persisted, and the
    // chain stopped at a fail-loud only an operator could clear. Deciding it
    // here, before the terminal status, makes the miss an ordinary retryable
    // failure that the retry path below re-queues inside the task's existing
    // budget.
    //
    // Two bounds keep this narrow. Only this run's own absence counts: an
    // output bound to this run belongs to `canonicalOutputRefusal`, the
    // authority on whether a persisted artifact counts, and a findings artifact
    // an earlier run persisted can never be replaced — a retry there would
    // author nothing and spend the budget proving it. And the diversion applies
    // only while an attempt is left: the ceiling is the run's own, because a
    // missing deliverable is never an external failure and so never refunds
    // one. Once the budget is spent the completion settles exactly as it did
    // before this — the terminal park naming the absent output, with the
    // chain-lease release, the merge-tail stop notice and the refusal activity
    // that park has always written.
    // A Run whose immutable commit snapshot differs from its configured
    // contract is an own-publication continuation. An unchanged completion of
    // that Run always requires canonical implementation evidence, including a
    // manual Task or a Task whose configured output kind is not implementation.
    // Ordinary canonical Steps retain their prior retry-ceiling semantics.
    const evidenceRequirement = completionEvidenceRequirement(
      run,
      reported.succeeded,
      body.headSha ?? null,
    );
    const outputTaskId = evidenceRequirement ? run.taskId : null;
    const persistedOutput = outputTaskId
      ? await tx.taskStepOutput.findUnique({ where: { taskId: outputTaskId } })
      : null;
    const missingOutputReason = completionEvidenceRefusal(
      run,
      reported.succeeded,
      body.headSha ?? null,
      persistedOutput,
    );
    const outputFailurePolicy = completionOutputFailurePolicy({
      outputKind: run.task?.templateStep?.outputKind,
      outcome: body.outcome,
    });
    // A valid, same-Run mechanical result is terminal protocol success even
    // when the later completion envelope says exit 1/PROTOCOL_ERROR. This is
    // deliberately narrower than trusting the envelope: malformed, foreign,
    // non-mechanical, or absent output remains a failure.
    const succeeded = (reported.succeeded || authoritativeMechanicalOutcome !== null) && !missingOutputReason;
    // The runner is on the untrusted side of this seam. It names *what the Run
    // ended as*; the class, the retry decision and the budget decision are read
    // off that name here — and for a provider failure, off the facts on its
    // envelope. The runner's own guess at a class never wins: before this,
    // `body.retryable ?? …` meant it always did, and the retry whitelist in
    // execution.ts was dead code, so a stdout-derived misverdict of
    // RATE_LIMITED spent the task's whole run budget on retries that could not
    // succeed.
    const failureClass = succeeded
      ? null
      : missingOutputReason
        ? FailureClass.PROTOCOL_ERROR
        : reported.failureClass;
    // `failureClass` is null exactly when the completion succeeded, so these
    // two follow it rather than re-testing `succeeded`.
    const retryable = missingOutputReason ? true : failureClass !== null && reported.retryable;
    // An external failure buys the task one more attempt rather than spending
    // one. Missing deliverables remain agent failures except for Regression's
    // machine-readable target-fetch block, where git failed before the script
    // could produce its mechanical handoff.
    const external = outputFailurePolicy.externalFailure
      || (missingOutputReason ? false : failureClass !== null && reported.externalFailure);
    const cappedExternalFailure = outputFailurePolicy.cappedExternalFailure
      || (body.outcome.case === "provider-failure"
        && body.outcome.envelope.phase === "EXECUTE"
        && failureClass !== null
        && isTextMatchedTransientProviderFailure(body.outcome.envelope, failureClass));
    const retryAt = failureClass && retryable ? new Date(now.getTime() + retryDelayMs(run.runNumber, failureClass)) : null;
    // A negative Regression verdict is durable control-plane evidence even
    // when the provider stream drops before its terminal event. Qualify this
    // exception at the same canonical boundary as an ordinary successful
    // completion: the output must belong to this Run, its JSON body and
    // authored commit must be valid, and the completion must name that exact
    // head. PASS is deliberately excluded; advancing after a failed transport
    // completion needs its own policy decision.
    const failedRegressionVerdict = !succeeded && failureClass === FailureClass.PROTOCOL_ERROR && retryable
      && run.taskId && run.task && isRegressionVerificationOutputKind(run.task.templateStep?.outputKind)
      ? await regressionVerdictForRun(tx, {
          task: run.task,
          runId: run.id,
          runHeadSha: body.headSha ?? null,
        })
      : null;
    const durableNegativeRegressionVerdict = Boolean(
      failedRegressionVerdict?.status === "ok"
      && failedRegressionVerdict.verdict.outcome !== "pass",
    );
    // Completion always mutates its Task, including terminal non-retryable
    // failures. Run is already locked above; acquire the Task/chain mutex now
    // before reading capped-refund history so two completion decisions cannot
    // grant the same final allowance.
    if (run.task) {
      if (run.task.chainId) {
        await lockChainRows(tx, { projectId: run.task.projectId, chainId: run.task.chainId });
      } else {
        await lockTask(tx, run.task.id);
      }
    }
    const priorCappedRefunds = cappedExternalFailure && external && !mechanical && run.taskId
      ? await tx.taskActivity.count({
          where: {
            taskId: run.taskId,
            AND: [
              { metadata: { path: ["kind"], equals: "externalFailureRefund.granted" } },
              { metadata: { path: ["policy"], equals: "capped" } },
            ],
          },
        })
      : 0;
    const refundDecision = externalFailureRefundDecision({
      runNumber: run.runNumber,
      external,
      refundable: failureClass !== FailureClass.NO_CHANGES_PRODUCED
        && failureClass !== FailureClass.BUDGET_EXCEEDED
        && failureClass !== FailureClass.TASK_FAILED,
      mechanical,
      capped: cappedExternalFailure,
      priorCappedRefunds,
    });
    // §D-P5 / MF-5. For the integrator step that compensation is switched off
    // entirely, so the answer transaction is the *only* writer of a ceiling
    // above the task's original. Otherwise a run authorized once could buy
    // itself unbounded further attempts by failing externally, and "only a
    // human re-authorization may exceed the ceiling" would be false in a
    // reachable interleaving rather than merely hard to reach. The failure
    // envelope's verdict decides *whether* the failure was external; it does
    // not get to raise the ceiling on this step either.
    const refunded = refundDecision.refunded;
    const completionBudget = completionBudgetAfterRefund(
      run.maxRunsPerTask,
      run.budgetGrants,
      refunded,
    );
    const budgetCeiling = completionBudget.maxRunsPerTask;
    // One marker read for both completion outcomes; this handler used to
    // declare `tailRows` twice and scan twice. The success path consults it
    // only for a standalone auxiliary task — an automatic repair, which is not
    // a chain step — while the failure path consults it only for a failure
    // that is not about to be retried, which is why the ceiling is computed
    // above the read.
    const failureIsFinal = !succeeded
      && (durableNegativeRegressionVerdict || !(retryable && run.runNumber < budgetCeiling));
    const documentationStepSucceeded = succeeded
      && isDocumentationStep(run.task?.templateStep);
    // A detached Task reads its markers in either outcome: besides the
    // auxiliary repair the success path consults, a merge-train card's own
    // control-plane marker decides whether its status is still this
    // completion's to write.
    const tailMarkers = run.task && (failureIsFinal
      || (!run.task.templateId && !run.task.chainId))
      ? await readMarkers(tx, run.task.id)
      : [];
    const succeededMarkers = succeeded ? tailMarkers : [];
    const mergeTailRequeueContext = documentationStepSucceeded && run.task
      ? await mergeTailRequeueContextForRun(tx, { taskId: run.task.id, runId: run.id })
      : null;
    const mergeTailSuccessorRequeue = mergeTailRequeueContext !== null;
    const repairMarker = latestMarker(succeededMarkers, "repairAttempt");
    const repairRegression = repairMarker?.regressionTaskId
      ? await tx.task.findUnique({
          where: { id: repairMarker.regressionTaskId },
          select: {
            projectId: true,
            chainId: true,
            templateId: true,
            templateStep: { select: { outputKind: true, taskTemplate: { select: { name: true } } } },
          },
        })
      : null;
    // A repair must put its chain's Documentation Step back before Regression.
    // The Step comes from the repair target's own persisted template rows, so a
    // chain minted from any generation is addressable — including a seed-era
    // row whose retired graph shape was never registered anywhere.
    const repairChain = repairRegression?.chainId && repairRegression.templateId
      && repairRegression.templateStep
      && stepRole(repairRegression.templateStep) === "regression"
      ? {
          projectId: repairRegression.projectId,
          chainId: repairRegression.chainId,
          templateId: repairRegression.templateId,
          templateName: repairRegression.templateStep.taskTemplate.name,
        }
      : null;
    const repairTemplateSteps = repairChain
      ? await tx.taskTemplateStep.findMany({
          where: { taskTemplateId: repairChain.templateId },
          orderBy: { stepIndex: "asc" },
          select: { id: true, outputKind: true },
        })
      : [];
    const repairDocumentationStep = repairTemplateSteps.find(
      (step) => stepRole(step) === "documentation",
    ) ?? null;
    const repairDocumentationTask = repairChain && repairDocumentationStep
      ? await tx.task.findFirst({
          where: {
            projectId: repairChain.projectId,
            chainId: repairChain.chainId,
            templateId: repairChain.templateId,
            templateStepId: repairDocumentationStep.id,
            archivedAt: null,
          },
          orderBy: { chainIndex: "desc" },
          select: { id: true },
        })
      : null;
    // A template that owns no Documentation Step is a fact about that chain, not
    // an accident of a missing graph shape: say so rather than skipping in silence.
    const repairDocumentationAbsence = repairChain && repairDocumentationStep === null
      ? repairChain.templateName
      : null;
    // An auxiliary task is one whose own marker names the Regression it serves.
    const mergeTailAuxiliary = Boolean(repairMarker?.regressionTaskId);
    // A detached merge-train card the readiness tick has already settled. The
    // train session persists its record before `session.finish`, so settlement
    // commonly commits while this Run is still active; the card's terminal
    // state is the tick's, not this completion's, in either direction.
    // Agent activity can carry marker-shaped metadata but cannot settle a
    // train. Read the control plane's latest state independently of the recent
    // activity window so session chatter cannot hide an existing settlement.
    const trainMarker = run.task && !run.task.templateId && !run.task.chainId
      ? await readLatestMarker(tx, run.task.id, "train", "control-plane")
      : null;
    const mergeTrainSettled = Boolean(run.task
      && trainMarker?.raw.trainTaskId === run.task.id
      && (trainMarker.state === "settled" || trainMarker.state === "aborted"));
    const auxiliaryTargetTaskId = repairMarker?.regressionTaskId
      ? repairDocumentationTask?.id ?? repairMarker.regressionTaskId
      : null;
    const repairSourceRunId = typeof repairMarker?.raw.sourceRunId === "string"
      ? repairMarker.raw.sourceRunId
      : null;
    // Preserve a failed completion's diagnostic reason even when a definitive
    // mechanical result overrides its protocol classification. Ordinary
    // reported success still carries no failure reason; an unbound repair's
    // reason is written onto the Run by the rejection itself, once the ladder
    // has decided that the mismatch is what settles this completion.
    const failureReason = succeeded && reported.succeeded
      ? null
      : missingOutputReason ?? reported.failureReason ?? "Execution failed";
    // The same refund, recorded apart from the ceiling it produced. The gates
    // an operator can reach read this rather than `maxRunsPerTask`, because
    // only this can still be told apart from the configured budget after that
    // budget changes. The in-flight ceiling stays derived from the run's own
    // row: a task's budget being edited mid-run must not retroactively refuse
    // an attempt already authorized.
    const budgetGrants = completionBudget.budgetGrants;
    let leaseOutcome: "continue" | "stop" = "continue";
    // Set only when the ladder rejects this completion for an unbound repair.
    let repairBindingRejection: CompleteRunRefusal | null = null;
    if (auxiliaryTargetTaskId && auxiliaryTargetTaskId !== run.task?.id) {
      await lockTaskMutationRows(tx, auxiliaryTargetTaskId);
    }
    // Which recovery, if any, this repair completion settles — read under the
    // repair target chain's mutex taken just above, because the recovery
    // aggregate is that chain's, and every other writer of it takes the same
    // lock. Decided before the terminal write, because a repair the platform
    // cannot bind is not an internal server error and must not escape this
    // transaction as one: the Run carries the reason, the repair Task parks,
    // and the completion answers a classified rejection.
    const repairRecoveryBinding = repairMarker?.regressionTaskId && repairSourceRunId
      ? await activeRepairRecoverySourceRun(tx, {
          regressionTaskId: repairMarker.regressionTaskId,
          sourceRunId: repairSourceRunId,
        })
      : null;
    const unboundRepair = repairRecoveryBinding?.case === "mismatch" && repairMarker?.regressionTaskId
      ? { regressionTaskId: repairMarker.regressionTaskId, mismatch: repairRecoveryBinding.mismatch }
      : null;
    if (run.task && typeof (tx.task as { findUnique?: unknown }).findUnique === "function") {
      await tx.task.findUnique({ where: { id: run.task.id }, select: { status: true } });
    }
    // Keep the status observed with the fenced Run as the compare-and-set
    // expectation. The locked re-read above supplies current chain state,
    // but adopting its newer status as the expectation would let completion
    // overwrite an operator decision that won while completion waited for
    // the mutex (for example DONE -> REVIEW on a successful standalone run).
    const completionTaskStatus = run.task?.status;
    const terminalStatus = succeeded
      ? RunStatus.SUCCEEDED
      // Which budget gate fired is a named case on the outcome now. It used to
      // be recovered by looking for "walltime" or "stall" inside prose the
      // runner had composed out of that same gate name.
      : reported.timedOut
        ? RunStatus.TIMED_OUT
        : RunStatus.FAILED;
    const terminal = await terminalizeRun(tx, {
      runId,
      at: now,
      outcome: {
        kind: "completed",
        // The terminal compare-and-set deliberately drops `runnerId`:
        // cancellation settlement races completion on this row and neither
        // may win twice. Same instant as the read above, which is what `at` on
        // the fence is for.
        where: fencedRunWhere({ runId, fencingToken: body.fencingToken, at: now }),
        status: terminalStatus,
        sessionId: run.session.id,
        run: {
        failureClass,
        failureReason,
        retryable,
        retryAt,
        // Stored whether or not this API understood it: an envelope from a
        // future runner is still the evidence of what happened, and the
        // reason a verdict can be re-decided later instead of re-run.
        failureEnvelope: body.outcome.case === "provider-failure" ? jsonValue(body.outcome.envelope) : Prisma.DbNull,
        // Kept on the run that produced it, whatever became of that run. The
        // same tail used to reach this route on every completion and be read
        // only by the step-output synthesis below, which runs for successful
        // template/chain/follow-up runs and nothing else — so a failure's own
        // account of itself died in this handler and the incident could only
        // be guessed at afterwards. A runner too old to send one leaves NULL,
        // exactly as before.
        output: body.output ?? null,
        terminationReason: body.terminationReason ?? null,
        branch: body.branch ?? run.branch,
        // Completion is a second publication write, never an eraser of the
        // immediate post-push ACK recorded on this run.
        pushedBranch: body.pushedBranch ?? run.pushedBranch,
        baseSha: body.baseSha ?? run.baseSha,
        // Second publication write, same rule as `pushedBranch` above: a
        // runner whose immediate ACK never arrived still reports its push
        // here, and that push carried this Run's base to the remote. Gated on
        // the same fact as the ACK writers — a `pushedBranch` on this row — and
        // never on `pushStatus`, which a completion may report NOT_REQUESTED
        // while carrying the ref that was pushed.
        basePublishedAt: (body.pushedBranch ?? run.pushedBranch)
          ? basePublishedStamp({ baseSha: body.baseSha ?? run.baseSha, basePublishedAt: run.basePublishedAt }, now)
          : run.basePublishedAt,
        headSha: body.headSha ?? null,
        salvageParentSha: body.salvageParentSha ?? null,
        pushStatus: body.pushStatus,
        pushRemote: body.pushRemote ?? null,
        pushError: body.pushError ?? null,
        pullRequestUrl: body.pullRequestUrl ?? null,
        pullRequestNumber: body.pullRequestNumber ?? null,
        deliveryInstructions: body.deliveryInstructions ?? null,
        workspaceRetained: body.workspaceRetained,
        // Report-only runner observation. Keep compliant and legacy
        // completions NULL so absence of an entry means no observation rather
        // than manufacturing a fact for a runner that did not send one.
        worktreeContainmentViolations: body.worktreeContainmentViolations?.length
          ? jsonValue(body.worktreeContainmentViolations)
          : Prisma.DbNull,
        maxRunsPerTask: budgetCeiling,
        budgetGrants,
        },
        session: {
        cleanupStatus: body.cleanupStatus,
        exitCode: body.exitCode,
        signal: body.signal ?? null,
        terminationReason: body.terminationReason ?? null,
        failureReason,
        cleanupFailureReason: body.cleanupFailureReason ?? null,
        },
      },
    });
    if (terminal === null || "message" in terminal) return null;
    let retryCreated = false;
    let retryRefusal: Refusal | null = null;
    if (!succeeded && retryable && !durableNegativeRegressionVerdict && run.task && run.runNumber < budgetCeiling) {
      const opened = await openRun(tx, run.task.id, {
        kind: "retry-after-completion",
        sourceRunId: run.id,
        sourceMaxRunsPerTask: run.maxRunsPerTask,
        sourceBudgetGrants: run.budgetGrants,
        budgetGrant: refunded,
        readyAt: retryAt ?? now,
      });
      if (opened.ok) retryCreated = true;
      else retryRefusal = opened.refusal;
    }
    if (run.taskId) {
      if (refundDecision.activity) {
        await tx.taskActivity.create({
          data: {
            taskId: run.taskId,
            actorType: "control-plane",
            body: refundDecision.activity.body,
            metadata: jsonValue({
              ...refundDecision.activity.metadata,
              runId: run.id,
              priorCappedRefunds,
              budgetGrantsBefore: run.budgetGrants,
              budgetGrantsAfter: budgetGrants,
            }),
          },
        });
      }
      const budgetExhausted = !succeeded && retryable && !durableNegativeRegressionVerdict
        && !retryCreated && !retryRefusal;
      let canonicalOutputFailure: string | null = null;
      // §4.0 outcome branching. The executor's own fenced write is the only
      // writer of a step-12 output: neither synthesis nor the metadata update
      // may touch it, because a synthesized body would read as a merge that
      // never happened.
      if (succeeded && mechanical && run.task) {
        // Reuse the ownership-checked output read performed before completion
        // classification. A foreign output is intentionally represented as a
        // malformed result so a retry cannot advance the chain on another
        // Run's merge.
        const outcome = persistedMechanicalOutcome ?? parseMergeResult(null);
        if (outcome.outcome === "merged") {
          await advanceTemplateTask(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null, now, completionTaskStatus);
        } else {
          await recordIntegratorStop(tx, {
            integratorTaskId: run.taskId,
            condition: outcome.outcome === "stopped" ? outcome.condition : "missing-or-malformed-result",
            evidence: outcome.outcome === "stopped" ? outcome.evidence : outcome.reason,
            sourceRunId: run.id,
          });
        }
        await tx.taskActivity.create({ data: {
          taskId: run.taskId,
          actorType: "runner",
          actorId: body.runnerId,
          body: outcome.outcome === "merged"
            ? `Run ${run.runNumber} merged the chain's pull request`
            : `Run ${run.runNumber} stopped before merging`,
          metadata: jsonValue({ exitCode: body.exitCode, mergeOutcome: outcome.outcome }),
        } });
      } else if (succeeded && run.task && (run.task.templateId || run.task.chainId || mergeTailAuxiliary)) {
        // Body, runId, metadata, and commit binding describe one act of
        // authorship and only move together through task_output. Completion
        // validates that immutable binding; it never restamps an authored
        // body or synthesizes a canonical step's deliverable.
        let existingOutput = await tx.taskStepOutput.findUnique({ where: { taskId: run.taskId } });
        const canonicalAgentStep = isCanonicalAgentStep(run.task.templateStep);
        const requiresExplicitOutput = requiredOutputKind(run.task.templateStep) !== null;
        if (!existingOutput && !requiresExplicitOutput) {
          await tx.taskStepOutput.create({ data: {
            taskId: run.taskId,
            runId: run.id,
            kind: run.task.templateStep?.outputKind ?? "result",
            body: body.output?.trim() || `Run ${run.runNumber} completed successfully.`,
            metadata: jsonValue({ branch: body.branch ?? run.branch, headSha: body.headSha }),
            commitSha: body.headSha ?? null,
          } });
        } else if (!canonicalAgentStep && existingOutput?.runId === run.id && body.headSha) {
          // Legacy and noncanonical steps retain their prose-compatible
          // completion-time binding. Canonical artifacts are immutable and
          // must already name the delivered head when authored.
          existingOutput = await tx.taskStepOutput.update({
            where: { id: existingOutput.id }, data: { commitSha: body.headSha },
          });
        }
        const outputRefusal = canonicalOutputRefusal(
          run.task.templateStep,
          existingOutput,
          run.id,
          body.headSha ?? null,
        );
        if (outputRefusal) {
          await tx.task.update({
            where: { id: run.taskId },
            data: { status: TaskStatus.REVIEW, failureReason: outputRefusal },
          });
          await tx.taskActivity.create({ data: {
            taskId: run.taskId,
            actorType: "control-plane",
            body: `Canonical task output refused: ${outputRefusal}`,
            metadata: {
              kind: "canonicalTaskOutput.refusal",
              schemaVersion: 1,
              runId: run.id,
              reason: outputRefusal,
            },
          } });
        } else if (
          existingOutput?.runId
          && existingOutput.runId !== run.id
          && outputIsImmutableOncePersisted(run.task.templateStep)
        ) {
          // Findings are immutable once authored. When a retry's completion
          // validates the prior Run's exact artifact, retain that row and
          // leave an explicit control-plane record of why this Run may still
          // advance the chain. The refusal helper above is the authority for
          // kind, head, and body validation; this branch only narrates its
          // successful prior-Run ownership exception.
          await tx.taskActivity.create({ data: {
            taskId: run.taskId,
            actorType: "control-plane",
            body: `Canonical task output satisfied by prior Run ${existingOutput.runId}`,
            metadata: {
              kind: "canonicalTaskOutput.priorRunSatisfied",
              schemaVersion: 1,
              runId: run.id,
              priorRunId: existingOutput.runId,
              outputKind: existingOutput.kind,
              commitSha: existingOutput.commitSha,
            },
          } });
        }
        canonicalOutputFailure = outputRefusal;
      }
      const mergeTailCompletion = run.task && (succeeded || !retryCreated)
        ? await settleMergeTailCompletion(tx, {
            task: {
              id: run.task.id,
              templateStep: run.task.templateStep,
              documentationTaskId: repairDocumentationTask?.id ?? null,
            },
            run: { agentId: run.agentId, sessionId: run.session.id, completedAt: now },
            body: { headSha: body.headSha ?? null },
            markers: tailMarkers,
            succeeded,
          })
        : { handled: false, leaseOutcome: "continue" as const };
      const regressionVerificationStep = isRegressionVerificationOutputKind(run.task?.templateStep?.outputKind);
      leaseOutcome = canonicalOutputFailure && regressionVerificationStep
        ? "stop"
        : mergeTailCompletion.leaseOutcome;
      // The Task row is included with the fenced Run, so a Run that names a
      // task always carries it. Every advancement below is about that Task.
      const completionTask = run.task;
      if (!completionTask) {
        throw new Error(`Run ${run.id} names task ${run.taskId} but no task row was read with it`);
      }
      // What this completion means for the Task, decided from facts already
      // read. The ladder this replaced fused the decision with its writes over
      // succeeded x mechanical x templateId x chainId x mergeTailAuxiliary, so
      // no arm could be read without a database; the writes below are now a
      // sequence of the existing actions with no conditions of their own.
      const advancementFacts: CompletionAdvancementFacts = {
        runNumber: run.runNumber,
        succeeded,
        mechanical,
        task: {
          templateId: completionTask.templateId,
          chainId: completionTask.chainId,
          approvalGate: completionTask.approvalGate,
          regressionVerificationStep,
        },
        durableNegativeRegressionVerdict,
        outputRefusal: canonicalOutputFailure,
        mergeTailAuxiliary,
        mergeTailHandled: mergeTailCompletion.handled,
        mergeTrainSettled,
        repairBindingRefusal: unboundRepair?.mismatch.reason ?? null,
        auxiliaryTargetTaskId,
        mergeTailRequeue: mergeTailSuccessorRequeue,
        mergeTailRecoverySourceRunId: mergeTailRequeueContext?.recoverySourceRunId ?? null,
        retryCreated,
        retryRefusalMessage: retryRefusal?.message ?? null,
        budgetExhausted,
        budgetCeiling,
        missingOutputReason,
        reportedFailureReason: reported.failureReason,
      };
      const advancement = completionAdvancement(advancementFacts);
      const regressionRun = {
        id: run.id,
        agentId: run.agentId,
        branch: body.branch ?? run.branch,
        headSha: body.headSha ?? null,
        sessionId: run.session.id,
      };
      switch (advancement.case) {
        case "repair-after-negative-regression":
          await handleRegressionCompletion(tx, {
            task: completionTask,
            run: regressionRun,
            ...(failedRegressionVerdict?.status === "ok"
              ? { qualifiedVerdict: failedRegressionVerdict.verdict }
              : {}),
            now,
          });
          leaseOutcome = "stop";
          break;
        // The mechanical branch above owns the step-12 advance and its stop;
        // the output refusal has already parked the Task in REVIEW; and a
        // settled merge tail has already written this Task's next state.
        case "mechanical-merge-already-recorded":
        case "stop-with-output-refusal":
        case "merge-tail-settled":
        // The merge train settlement wrote this detached card's terminal state
        // already; parking it here would undo it.
        case "merge-train-control-plane-settled":
          break;
        case "settle-regression-verdict": {
          const result = await handleRegressionCompletion(tx, {
            task: completionTask,
            run: regressionRun,
            now,
          });
          if (result === "advance") {
            await advanceTemplateTask(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null, now, completionTaskStatus);
          } else {
            leaseOutcome = "stop";
          }
          break;
        }
        case "advance-template-step":
          await advanceTemplateTask(
            tx,
            run.taskId,
            run.id,
            process.env.FEISHU_DEFAULT_CHAT_ID ?? null,
            now,
            completionTaskStatus,
            {
              mergeTailRequeue: advancement.mergeTailRequeue,
              ...(advancement.mergeTailRecoverySourceRunId
                ? { mergeTailRecoverySourceRunId: advancement.mergeTailRecoverySourceRunId }
                : {}),
            },
          );
          break;
        case "ask-approval-gate-question": {
          const claimed = await tx.task.updateMany({
            where: { id: run.taskId, status: completionTaskStatus! },
            data: { status: TaskStatus.REVIEW, failureReason: null },
          });
          if (claimed.count === 1) await gateQuestion(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null);
          break;
        }
        case "complete-and-activate-successors": {
          const completed = await tx.task.updateMany({
            where: { id: run.taskId, status: completionTaskStatus! }, data: { status: TaskStatus.DONE, failureReason: null },
          });
          if (completed.count === 1) {
            if (advancement.activateChainSuccessor) {
              await activateChainSuccessor(tx, completionTask, {
                sourceRunId: run.id,
                chatId: process.env.FEISHU_DEFAULT_CHAT_ID ?? null,
              }, now);
            }
            if (advancement.auxiliaryTargetTaskId) {
              if (repairDocumentationAbsence !== null) {
                await tx.taskActivity.create({ data: {
                  taskId: advancement.auxiliaryTargetTaskId,
                  actorType: "control-plane",
                  body: `Repair target template ${repairDocumentationAbsence} has no Documentation Step; the repair re-opens Regression directly`,
                  metadata: {
                    kind: MERGE_TAIL_DOCUMENTATION_ABSENT_KIND,
                    schemaVersion: 1,
                    templateName: repairDocumentationAbsence,
                  },
                } });
              }
              await activateMergeTailTarget(tx, advancement.auxiliaryTargetTaskId, now, {
                ...(repairRecoveryBinding?.case === "recovery"
                  ? { recoverySourceRunId: repairRecoveryBinding.recoverySourceRunId }
                  : {}),
              });
            }
          }
          break;
        }
        case "reject-repair-binding": {
          // The repair's own work is committed and its repairResult marker is
          // written; only the recovery-bound activation is impossible. Park the
          // repair Task with the reason, record the overlap on the Regression
          // task, and leave the tail in the state the operator reentry route
          // reopens. The completion answers a classified rejection below.
          if (!unboundRepair) {
            throw new Error(`Run ${run.id} rejected a repair binding it did not classify`);
          }
          await stopUnboundRepair(tx, {
            runId: run.id,
            repairTaskId: run.taskId,
            ...(completionTaskStatus ? { repairTaskStatus: completionTaskStatus } : {}),
            regressionTaskId: unboundRepair.regressionTaskId,
            documentationTaskId: repairDocumentationTask?.id ?? null,
            mismatch: unboundRepair.mismatch,
            run: { agentId: run.agentId, sessionId: run.session.id, completedAt: now },
          });
          repairBindingRejection = {
            reason: "merge-tail-repair-unbound",
            message: unboundRepair.mismatch.reason,
            detail: {
              recoveryId: unboundRepair.mismatch.recoveryId,
              boundRecoveryRunId: unboundRepair.mismatch.boundRecoveryRunId,
              boundSourceRunId: unboundRepair.mismatch.boundSourceRunId,
              repairedRunId: unboundRepair.mismatch.repairedRunId,
            },
          };
          leaseOutcome = "stop";
          break;
        }
        case "park-task":
          await tx.task.updateMany({
            where: { id: run.taskId, ...(completionTaskStatus ? { status: completionTaskStatus } : {}) },
            data: {
              status: advancement.status,
              // The fail-loud park keeps naming the absent deliverable once the
              // budget is spent; the budget itself is reported by the Inbox
              // message below.
              failureReason: advancement.failureReason,
            },
          });
          break;
        default: {
          const unhandled: never = advancement;
          throw new Error(`Run ${run.id} decided an unhandled completion advancement ${JSON.stringify(unhandled)}`);
        }
      }
      const activityBody = completionActivityBody(advancementFacts);
      if (activityBody) await tx.taskActivity.create({
        data: {
          taskId: run.taskId,
          actorType: "runner",
          actorId: body.runnerId,
          body: activityBody,
          metadata: jsonValue({ exitCode: body.exitCode, outcome: body.outcome.case, failureClass, pushStatus: body.pushStatus, pullRequestUrl: body.pullRequestUrl }),
        },
      });
      if (budgetExhausted) {
        await tx.inboxMessage.create({
          data: {
            from: "AGENT",
            sessionId: run.session.id,
            taskId: run.taskId,
            kind: "TEXT",
            body: `Run budget exhausted after ${budgetCeiling} attempts; operator action required.`,
          },
        });
      }
      if (retryRefusal) {
        await tx.inboxMessage.create({
          data: {
            from: "AGENT",
            sessionId: run.session.id,
            taskId: run.taskId,
            kind: "TEXT",
            body: `Automatic retry refused: ${retryRefusal.message}`,
          },
        });
      }
    }
    if (failureClass === FailureClass.AUTH_REQUIRED) {
      const state = await tx.runnerBackendState.upsert({
        where: { runner: run.runner },
        create: { runner: run.runner, consecutiveAuthFailures: 1, lastPreflightOk: false },
        update: { consecutiveAuthFailures: { increment: 1 }, lastPreflightOk: false },
      });
      if (state.consecutiveAuthFailures >= 2) {
        await tx.runnerBackendState.update({
          where: { runner: run.runner },
          data: { circuitOpen: true, circuitReason: "Repeated authentication failures", circuitOpenedAt: now },
        });
        await tx.inboxMessage.create({
          data: {
            from: "AGENT",
            sessionId: run.session.id,
            taskId: run.taskId,
            goalId: run.goalId,
            kind: "TEXT",
            body: `${run.runner.toLowerCase()} runner circuit opened after repeated authentication failures; login is required.`,
          },
        });
      }
    } else if (succeeded) {
      await tx.runnerBackendState.upsert({
        where: { runner: run.runner },
        create: { runner: run.runner, lastPreflightOk: true },
        update: { consecutiveAuthFailures: 0 },
      });
    }
    return {
      // A repair the platform cannot bind is not an internal server error and
      // not the runner's fault. Everything above is committed — the Run carries
      // the reason, the repair Task is parked, the overlap is recorded — and
      // the completion itself answers a named 409 rather than 500.
      value: repairBindingRejection
        ?? { taskId: run.taskId, succeeded, retryCreated, failureClass },
      leaseOutcome: leaseOutcome === "stop"
        ? { kind: "stop", taskId: run.taskId }
        : { kind: "continue" },
    };
  // ReadCommitted lets successor CAS losers observe count=0 instead of
  // surfacing a serialization failure to runners. Every task status write
  // above has its own status CAS so concurrent operator decisions win.
  }, {
    release: releaseMergeLease,
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  });
  // Why the transaction refused, answered here rather than by the caller: a
  // caller that had to re-query the run to tell "suspended for Inbox" from
  // "stale fence" would be re-deriving a distinction this action already made.
  if (!result) {
    const waiting = await db.run.findFirst({ where: { id: runId, status: RunStatus.WAITING_INBOX }, select: { id: true } });
    if (waiting) {
      return {
        reason: "conflict",
        message: "Run suspended for Inbox",
        detail: { code: "WAITING_INBOX" },
      };
    }
    const fenceRefusal = fenceRefusalResponse(await explainFenceRefusal(db, fence));
    return {
      reason: "conflict",
      message: fenceRefusal.error,
      detail: { reason: fenceRefusal.reason },
    };
  }
  return result;
};
