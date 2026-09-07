import {
  activateChainSuccessor,
  AssigneeType,
  COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE,
  COMPOUND_IMPLEMENTATION_ASSIGNEE_MESSAGE,
  compoundImplementationAssigneeValid,
  gateSlotOf,
  gateToggleActivity,
  gateToggleRefusal,
  InboxStatus,
  integratorBindingRefusalFor,
  isGatedMergeReadinessTask,
  MERGE_INTEGRATOR_KIND,
  Prisma,
  type PrismaClient,
  produceMergeAuthorization,
  recordMergeEvidenceRefusal,
  rejectMergeReadinessGate,
  releaseMergeReadinessGate,
  ScheduleKind,
  stopStateFor,
  stopStateRefusal,
  type Task,
  TaskStatus,
  usd,
} from "@anneal/db";
import { compare } from "@anneal/db/chain-order";
import { z } from "zod";

import { blockingPredecessor } from "./chain.js";
import { FAILURE_REASON_LIMIT, failureReasonText } from "./failure-reason.js";
import type { Refusal } from "./refusal.js";
import { validateSchedule } from "./scheduler.js";
import { BRIEF_EDIT_ACTIVITY_NOTE, legacyBriefMigration, patchesBriefInPlace, rewriteBrief } from "./task-brief.js";
import { taskMoveAuthority } from "./task-move-authority.js";
import {
  hasActiveRun,
  isLiveStatus,
  type LockedTask,
  reactivationBlocked,
  type TaskActivityInput,
  writeTask,
  type TaskWritePlan,
  type TaskWriteRefusal,
} from "./task-write.js";
import { withoutUndefined } from "./without-undefined.js";

const id = z.string().min(1);
const taskFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string(),
  workingDirectory: z.string().trim().min(1).nullable(),
  repoId: id.nullable(),
  targetBranch: z.string().trim().min(1).nullable(),
  assigneeType: z.nativeEnum(AssigneeType),
  assigneeAgentId: id.nullable(),
  approvalGate: z.boolean(),
  opensPullRequest: z.boolean(),
  maxDurationMin: z.number().int().min(1).max(24 * 60),
  stallTimeoutMin: z.number().int().min(1).max(24 * 60),
  maxSessionsPerTask: z.number().int().min(1).max(100),
  scheduleKind: z.nativeEnum(ScheduleKind),
  runAt: z.coerce.date().nullable(),
  cron: z.string().trim().min(9).max(100).nullable(),
  timezone: z.string().trim().min(1).max(64).nullable(),
};
const taskCreateStatus = z.nativeEnum(TaskStatus).refine(
  (status) => status === TaskStatus.BACKLOG || status === TaskStatus.TODO,
  "Task creation status must be BACKLOG or TODO",
);

/** Exported for `smoke-fixture.test.ts`: the published release fixture and this
 *  schema have to agree about `opensPullRequest`, and the only way to assert
 *  that is to parse the fixture with the schema the route actually uses. */
export const taskInput = z.object({
  ...taskFields,
  status: taskCreateStatus.default(TaskStatus.TODO),
  description: taskFields.description.default(""),
  workingDirectory: taskFields.workingDirectory.default(null),
  repoId: taskFields.repoId.default(null),
  targetBranch: taskFields.targetBranch.default(null),
  assigneeType: taskFields.assigneeType.default(AssigneeType.AGENT),
  assigneeAgentId: taskFields.assigneeAgentId.default(null),
  approvalGate: taskFields.approvalGate.default(false),
  opensPullRequest: taskFields.opensPullRequest.default(true),
  maxDurationMin: taskFields.maxDurationMin.default(240),
  stallTimeoutMin: taskFields.stallTimeoutMin.default(10),
  maxSessionsPerTask: taskFields.maxSessionsPerTask.default(5),
  scheduleKind: taskFields.scheduleKind.default(ScheduleKind.NOW),
  runAt: taskFields.runAt.default(null),
  cron: taskFields.cron.default(null),
  timezone: taskFields.timezone.default(null),
  chainId: z.string().trim().min(1).max(100).optional(),
  chainIndex: z.number().int().min(0).optional(),
}).strict().superRefine((value, context) => {
  if ((value.chainId === undefined) !== (value.chainIndex === undefined)) {
    context.addIssue({ code: "custom", message: "chainId and chainIndex must be provided together" });
  }
});

// `failureReason` is patchable but not creatable: a task is never born with a
// failure, and an operator whose task carries a stale one needs a way to clear
// it — an explicit null — without inventing a run.
// `spendCap` is patchable but not creatable, like `failureReason`: a task is
// born with the cap its project or template gave it, and the operator action
// this route exists for is raising or clearing a cap that has already refused
// an attempt. Null clears it.
// `dispatchAfterTaskId` is patchable but not creatable either: a chain's
// binding is written by instantiation, and this route only re-points or
// releases the one an unstarted chain already carries. `null` unbinds.
export const taskPatch = z.object(taskFields).partial().extend({
  // Bounded to the `Decimal(12,2)` column, like every other numeric task field:
  // an out-of-range cap is a refusal, not a Postgres overflow surfacing as 500.
  spendCap: z.number().nonnegative().max(9_999_999_999.99).nullable().optional(),
  status: z.nativeEnum(TaskStatus).optional(),
  failureReason: failureReasonText(FAILURE_REASON_LIMIT).nullable().optional(),
  dispatchAfterTaskId: id.nullable().optional(),
}).refine((value) => Object.keys(value).length > 0);

export type TaskPatchInput = z.infer<typeof taskPatch>;

export type TaskPatchRefusal = Refusal;

export type TaskPatchResult = { task: Task } | TaskPatchRefusal;

/**
 * The trail a plain field edit leaves. `writeTask` records status moves and gate
 * toggles and nothing else, so before this a task's Run budget could go from 5
 * to 50 without a single row saying who did it or when — and that is a spending
 * decision. The prompt edit is recorded by name only; the text itself is on the
 * task.
 */
export const fieldEditActivity = (
  locked: { maxSessionsPerTask: number; spendCap: Prisma.Decimal | null },
  body: TaskPatchInput,
): TaskActivityInput | null => {
  // Rendered by the cost basis's own formatter so the trail agrees with the
  // refusal it answers. Required, not optional: see `LockedTask.spendCap`.
  const cap = (value: Prisma.Decimal | number | null | undefined): string =>
    value === null || value === undefined ? "none" : `$${usd(value)}`;
  const notes = [
    body.maxSessionsPerTask !== undefined && body.maxSessionsPerTask !== locked.maxSessionsPerTask
      ? `Run budget: ${locked.maxSessionsPerTask} → ${body.maxSessionsPerTask}`
      : null,
    // A cap edit is the operator answer to `spend-cap-exhausted`, so it leaves
    // the same trail the Run budget does.
    body.spendCap !== undefined && cap(body.spendCap) !== cap(locked.spendCap)
      ? `Spend cap: ${cap(locked.spendCap)} → ${cap(body.spendCap)}`
      : null,
    body.description !== undefined ? BRIEF_EDIT_ACTIVITY_NOTE : null,
  ].filter((note): note is string => note !== null);
  return notes.length === 0 ? null : { actorType: "operator", body: notes.join("; ") };
};

export const taskStatusChangedActivity = (
  previousStatus: TaskStatus,
  status: TaskStatus,
): TaskActivityInput => ({
  actorType: "operator",
  body: `Status changed: ${previousStatus} → ${status}`,
});

/** What the status write plans under the lock: a refusal this action owns, a
 *  replay of an already-decided gate, or the write itself. */
type StatusWritePlan =
  | Refusal
  | { replay: true }
  | {
    gate: GateWinner;
    previousStatus: TaskStatus;
    mergeGateApproval: boolean;
    mergeGateRejection: boolean;
  };

type GateWinner = {
  card: { id: string; body: string; gateTaskId: string | null; sessionId: string | null };
  runId: string;
} | null;

/** The approval-gate check is deliberately evaluated by every locked write
 * path. The unlocked task read is only a fast route input snapshot; status and
 * template-step identity are authoritative after `writeTask` takes the Task
 * (or whole Chain) mutex. */
type GatePatchPlan = {
  refusal: Refusal | null;
  activity: TaskActivityInput | null;
};

/** A refusal from `writeTask` in this action's terms: the task is gone, the
 *  assignee the request named may not be written onto it, or the task is busy.
 *
 *  The busy case is a `conflict` and not an `invalid-request`: nothing about
 *  the request is malformed, and the identical body succeeds once the Run this
 *  task is executing reaches a terminal status. All four PATCH branches route
 *  their `writeTask` refusal through here, so the 409 covers the generic
 *  `assigneeAgentId: null` path as well as the named-assignee ones. */
const taskWriteRefusal = (refusal: TaskWriteRefusal): Refusal => {
  switch (refusal.kind) {
    case "absent":
      return { reason: "not-found", message: "Task not found" };
    case "assignment-active-run":
      return { reason: "conflict", message: refusal.reason };
    case "assignment-blocked":
      return { reason: "invalid-request", message: refusal.reason };
  }
};

const gatePatchPlan = (
  locked: {
    chainId: string | null;
    status: TaskStatus;
    approvalGate: boolean;
    templateStep: Parameters<typeof gateSlotOf>[0];
  },
  requested: boolean | undefined,
): GatePatchPlan => {
  const changed = requested !== undefined && requested !== locked.approvalGate;
  if (!changed || locked.chainId === null) return { refusal: null, activity: null };
  const slot = gateSlotOf(locked.templateStep);
  if (slot === null) {
    return {
      refusal: { reason: "conflict", message: gateToggleRefusal(null, locked.status) },
      activity: null,
    };
  }
  if (locked.status !== TaskStatus.TODO) {
    return {
      refusal: { reason: "conflict", message: gateToggleRefusal(slot, locked.status) },
      activity: null,
    };
  }
  return {
    refusal: null,
    activity: { actorType: "operator", body: gateToggleActivity(slot, requested) },
  };
};

/**
 * Re-pointing or releasing the dispatch binding of a chain that has not run.
 *
 * The binding is the chain's admission condition, so it may only move while
 * nothing has been spent on it: the first step of a chain none of whose steps
 * has a Run. Everything else — a standalone task, a later step, a chain with
 * so much as one terminal Run — keeps the binding it was instantiated with and
 * is refused as a conflict, because the request is well formed and it is the
 * chain's state that says no.
 *
 * The predecessor is validated the way instantiation validates `afterTaskId`,
 * minus the rules that only make sense before the chain exists: it must be a
 * live task of this project, outside the chain being bound, and itself a chain
 * task — only `activateChainSuccessor` dispatches a bound successor and it runs
 * solely for a predecessor with a `chainId`, so binding onto a standalone task
 * would strand the chain exactly the way this endpoint exists to undo. A
 * predecessor that is already DONE is accepted and resolves the binding
 * immediately; it does not start the chain, because only a completion
 * dispatches a bound successor.
 *
 * `locked` comes from `writeTask`, so this chain's rows and the Run count over
 * them are serialized by the chain mutex. The predecessor is not: it belongs to
 * another chain, and taking its rows here would invert the predecessor -> successor
 * lock order `activateChainSuccessor` uses and deadlock against a concurrent
 * completion. An archive of the predecessor that commits between this read and
 * the write therefore wins, and the operator re-issues the PATCH — the chain has
 * no Run, so its binding is still mutable.
 *
 * The binding activity takes the single activity slot `TaskWritePlan` allows, so
 * a request that also toggles the gate or edits a field records the binding
 * change only; `docs/operator-api.md` states that precedence.
 */
const bindingPatchPlan = async (
  tx: Prisma.TransactionClient,
  locked: LockedTask,
  requested: string | null | undefined,
): Promise<GatePatchPlan> => {
  // Idempotent: restating the binding a task already has is not a change, and
  // is accepted even on a chain that has started.
  if (requested === undefined || requested === locked.dispatchAfterTaskId) {
    return { refusal: null, activity: null };
  }
  const immutable = (message: string): GatePatchPlan => ({
    refusal: {
      reason: "chain_binding_immutable_after_start",
      message,
      detail: { code: "chain_binding_immutable_after_start" },
    },
    activity: null,
  });
  if (locked.chainId === null) {
    return immutable(`Task ${locked.id} is not a Chain task, so it carries no chain binding`);
  }
  const chainId = locked.chainId;
  const chainRows = await tx.task.findMany({
    where: { projectId: locked.projectId, chainId },
    select: { id: true, chainLayer: true, chainIndex: true },
  });
  // Sorted with the shared execution comparator, not by SQL: a row whose layer
  // is still null sorts by its chainIndex here, where NULLS LAST would put it
  // behind every layered row and pick the wrong first step.
  chainRows.sort((left, right) => compare(
    { layer: left.chainLayer, index: left.chainIndex, id: left.id },
    { layer: right.chainLayer, index: right.chainIndex, id: right.id },
  ));
  if (chainRows[0]?.id !== locked.id) {
    return immutable(`Task ${locked.id} is not the first step of Chain ${chainId}, which is where the binding lives`);
  }
  if (await tx.run.count({ where: { task: { projectId: locked.projectId, chainId } } }) > 0) {
    return immutable(`Chain ${chainId} has already started; its binding is immutable`);
  }
  if (requested !== null) {
    const invalid = (message: string): GatePatchPlan => ({
      refusal: {
        reason: "chain_binding_target_invalid",
        message,
        detail: { code: "chain_binding_target_invalid" },
      },
      activity: null,
    });
    const target = await tx.task.findFirst({
      where: { id: requested, projectId: locked.projectId },
      select: { id: true, name: true, chainId: true, archivedAt: true },
    });
    if (!target) return invalid(`Predecessor task ${requested} was not found in this project`);
    if (target.archivedAt) return invalid(`Predecessor task ${target.name} (${target.id}) is archived`);
    if (target.id === locked.id || target.chainId === chainId) {
      return invalid(`Predecessor task ${target.name} (${target.id}) belongs to Chain ${chainId} itself`);
    }
    if (target.chainId === null) {
      return invalid(`Predecessor task ${target.name} (${target.id}) is not a Chain task, so its completion would never dispatch Chain ${chainId}`);
    }
  }
  return {
    refusal: null,
    activity: {
      actorType: "operator",
      body: `Chain binding changed by operator request: predecessor ${locked.dispatchAfterTaskId ?? "none"} → ${requested ?? "none"}`,
      metadata: {
        chainId,
        previousDispatchAfterTaskId: locked.dispatchAfterTaskId,
        dispatchAfterTaskId: requested,
      },
    },
  };
};

/**
 * Patch a task. The action owns its preflight refusals and all four of its
 * transactions, including their isolation level; the caller supplies a parsed
 * patch and maps the returned refusal onto a response.
 *
 * The four transactions stay four. Three of them are guarded by different
 * conditions and fire on different requests, so merging them would change
 * which writes happen together.
 */
export const patchTask = async (
  db: PrismaClient,
  taskId: string,
  body: TaskPatchInput,
): Promise<TaskPatchResult> => {
  const before = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  // Held for the whole route: whichever of the three write paths below runs
  // re-reads this assignee under the Agent-row mutex before it commits.
  const assignee = body.assigneeAgentId
    ? await db.agent.findFirst({ where: { id: body.assigneeAgentId, projectId: before.projectId } })
    : null;
  const effectiveAgentId = body.assigneeAgentId === undefined ? before.assigneeAgentId : body.assigneeAgentId;
  const effectiveAssigneeType = body.assigneeType ?? before.assigneeType;
  if (before.archivedAt === null
    && (body.assigneeType !== undefined || body.assigneeAgentId !== undefined)) {
    const [effectiveAgent, templateStep] = await Promise.all([
      effectiveAgentId
        ? db.agent.findFirst({ where: { id: effectiveAgentId, projectId: before.projectId } })
        : null,
      before.templateStepId
        ? db.taskTemplateStep.findUnique({
          where: { id: before.templateStepId },
          select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
        })
        : null,
    ]);
    if (!compoundImplementationAssigneeValid(
      before.projectId,
      effectiveAssigneeType,
      effectiveAgent,
      templateStep,
    )) {
      return {
        reason: "compound-implementation-assignee",
        message: COMPOUND_IMPLEMENTATION_ASSIGNEE_MESSAGE,
        detail: { code: COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE },
      };
    }
  }
  if (body.assigneeAgentId) {
    if (!assignee) return { reason: "invalid-request", message: "Assignee does not belong to this project" };
    if (assignee.archivedAt) return { reason: "invalid-request", message: `Assignee ${assignee.name} is archived` };
  }
  if (body.repoId) {
    const repo = await db.repo.findFirst({ where: { id: body.repoId, projectId: before.projectId } });
    if (!repo) return { reason: "invalid-request", message: "Repo does not belong to this project" };
  }
  const effectiveRepoId = body.repoId === undefined ? before.repoId : body.repoId;
  if (effectiveAgentId && effectiveRepoId) {
    const access = await db.agentRepoAccess.findFirst({
      where: { agentId: effectiveAgentId, repoId: effectiveRepoId, projectId: before.projectId },
    });
    if (!access) return { reason: "invalid-request", message: "Assignee has no grant for this Repo" };
  }
  // §D-P4 on reassignment. `templateStepId` is not a patchable field, so the
  // step half of the pair cannot move under this check; the assignee half is
  // exactly what this route can move, in either direction — an ordinary task
  // onto the sentinel, or the integrator step off it onto a model agent.
  const reassignmentRefusal = await integratorBindingRefusalFor(db, {
    assigneeAgentName: effectiveAgentId
      ? (await db.agent.findUnique({ where: { id: effectiveAgentId }, select: { name: true } }))?.name ?? null
      : null,
    templateStepId: before.templateStepId,
  });
  if (reassignmentRefusal) return { reason: "invalid-request", message: reassignmentRefusal };
  const scheduleTouched = body.scheduleKind !== undefined || body.runAt !== undefined || body.cron !== undefined || body.timezone !== undefined;
  const atExecutorTouched = before.scheduleKind === ScheduleKind.AT
    && (body.assigneeType !== undefined || body.assigneeAgentId !== undefined || body.repoId !== undefined);
  let schedule;
  if (scheduleTouched || atExecutorTouched) {
    try {
      schedule = validateSchedule({
        scheduleKind: body.scheduleKind ?? before.scheduleKind ?? ScheduleKind.NOW,
        runAt: body.runAt === undefined ? before.runAt ?? null : body.runAt,
        cron: body.cron === undefined ? before.cron ?? null : body.cron,
        timezone: body.timezone === undefined ? before.timezone ?? null : body.timezone,
        assigneeType: effectiveAssigneeType,
        assigneeAgentId: effectiveAgentId,
        repoId: effectiveRepoId,
      });
    } catch (error: unknown) {
      return { reason: "invalid-request", message: error instanceof Error ? error.message : "Invalid schedule" };
    }
  }
  let patch = body;
  if (body.description !== undefined
    && before.templateId != null
    && before.chainId != null) {
    const templateStep = before.templateStepId
      ? await db.taskTemplateStep.findUnique({
        where: { id: before.templateStepId },
        select: { outputKind: true, priorOutputKinds: true },
      })
      : null;
    if (!templateStep) {
      return { reason: "invalid-request", message: "Cannot rewrite task brief: template Step metadata is missing" };
    }
    if (patchesBriefInPlace(before, templateStep.outputKind)) {
      const rewritten = rewriteBrief(before.description, body.description, legacyBriefMigration(templateStep));
      if (typeof rewritten !== "string") {
        return {
          reason: "invalid-request",
          message: `Cannot rewrite task brief: ${rewritten.unparseable}`,
        };
      }
      patch = { ...body, description: rewritten };
    }
  }
  const updateData = {
    ...withoutUndefined(patch),
    ...(scheduleTouched ? schedule : {}),
  } as Prisma.TaskUncheckedUpdateInput;
  /** The three non-status write paths plan the same thing: the two guarded
   *  fields first, then the plain field edit they share. */
  const fieldWritePlan = async (
    tx: Prisma.TransactionClient,
    locked: LockedTask,
  ): Promise<TaskWritePlan<Refusal | null>> => {
    const bindingPatch = await bindingPatchPlan(tx, locked, body.dispatchAfterTaskId);
    if (bindingPatch.refusal) return { update: null, activity: null, value: bindingPatch.refusal };
    const gatePatch = gatePatchPlan(locked, body.approvalGate);
    if (gatePatch.refusal) return { update: null, activity: null, value: gatePatch.refusal };
    return {
      update: updateData,
      activity: bindingPatch.activity ?? gatePatch.activity ?? fieldEditActivity(locked, body),
      value: null,
    };
  };
  // A status write joins the Task-row mutex, like start / retry / archive /
  // the scheduler's claims. Two reasons, both proven by regression tests:
  //
  //  - Parking in Backlog must be atomic with `Start now`. Counting active
  //    runs outside a transaction and writing later loses the race, and the
  //    loss does not "resolve on completion": the runner claims only
  //    `TODO|DOING`, so a QUEUED run left on a BACKLOG task is never claimed
  //    and never completes.
  //  - Without the lock a status write can land *after* `archive-done`
  //    committed and drag an archived task back onto a board that does not
  //    show it — a guard set in which one writer ignores `archivedAt`
  //    excludes nothing.
  //
  // One rule, no exceptions: an archived task's status is frozen until it is
  // unarchived, whether or not the transition also advances a chain. Splitting
  // that by `advances` would let an archived chained task be marked DONE while
  // an archived standalone one could not.
  //
  // Every request that names a status takes this path, not only the ones that
  // look like a change against the unlocked `before` read. `before` is stale
  // by definition, so "status: TODO on a task that is already TODO" can land
  // on a row another writer has since parked or archived — and outside the
  // transaction it wrote that TODO back with no lock and no guard at all.
  if (body.status !== undefined) {
    const nextStatus = body.status;
    const written = await db.$transaction(async (tx) => {
      const result = await writeTask<StatusWritePlan>(tx, taskId, async (locked) => {
        const refuse = (message: string) => ({
          update: null,
          activity: null,
          value: { reason: "conflict" as const, message },
        });
        const bindingPatch = await bindingPatchPlan(tx, locked, body.dispatchAfterTaskId);
        if (bindingPatch.refusal) {
          return { update: null, activity: null, value: bindingPatch.refusal };
        }
        const gatePatch = gatePatchPlan(locked, body.approvalGate);
        if (gatePatch.refusal) {
          return { update: null, activity: null, value: gatePatch.refusal };
        }
        // These reads stay inside the Task/Chain mutex. Board projection can
        // answer from its snapshot, but PATCH revalidates the two dynamic
        // residues (`active-run`, `stop-state`) at the write's serialization
        // point before the shared move authority accepts a target.
        const statusChanged = nextStatus !== locked.status;
        const reactivationRefusal = body.assigneeAgentId === undefined
          && !isLiveStatus(locked.status)
          && isLiveStatus(nextStatus)
          ? await reactivationBlocked(tx, locked)
          : null;
        const activeRun = (nextStatus === TaskStatus.BACKLOG && statusChanged)
          || nextStatus === TaskStatus.DONE
          ? await hasActiveRun(tx, taskId)
          : false;
        const stopped = statusChanged ? await stopStateFor(tx, taskId) : null;
        let gate: GateWinner = null;
        let mergeGateApproval = false;
        let mergeGateRejection = false;
        const mergeGateRejectionRequested = nextStatus === TaskStatus.TODO
          && locked.status === TaskStatus.REVIEW
          && isGatedMergeReadinessTask(locked);
        if (nextStatus === TaskStatus.DONE || mergeGateRejectionRequested) {
          // A Human approval has one durable decision identity on both API
          // channels. The earliest OPEN card is the deterministic winner; the
          // gate Task lock the module took makes this selection and the Inbox
          // route's OPEN claim one compare-and-set rather than two competing
          // decisions. Selecting is a read; the CAS that writes it runs below,
          // once the module has accepted the status write — a refusal after
          // the CAS would commit a decision the request was refused.
          const winningGateCard = await tx.inboxMessage.findFirst({
            where: { gateTaskId: taskId, status: InboxStatus.OPEN },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, body: true, gateTaskId: true, sessionId: true },
          });
          if (winningGateCard) {
            const session = winningGateCard.sessionId
              ? await tx.session.findUnique({ where: { id: winningGateCard.sessionId }, select: { runId: true } })
              : null;
            if (!session?.runId) {
              return refuse("Gate card has no session run to bind a decision to");
            }
            gate = { card: winningGateCard, runId: session.runId };
            const confirmationRequest = isGatedMergeReadinessTask(locked)
              ? await tx.taskActivity.findFirst({
                where: {
                  taskId,
                  AND: [
                    { metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.evidenceRequest } },
                    { metadata: { path: ["cardId"], equals: winningGateCard.id } },
                    { metadata: { path: ["purpose"], equals: "confirmation" } },
                  ],
                },
                select: { id: true },
              })
              : null;
            mergeGateApproval = nextStatus === TaskStatus.DONE
              && isGatedMergeReadinessTask(locked)
              && confirmationRequest === null;
            mergeGateRejection = mergeGateRejectionRequested;
          } else {
            // A gate exists but none is OPEN only after another channel won or
            // this request is a replay. Only replay the same durable decision:
            // an answered rejection must not turn a stale DONE request into a
            // successful approval response after the rejection requeued work.
            const decidedGate = await tx.inboxMessage.findFirst({
              where: { gateTaskId: taskId, status: InboxStatus.ANSWERED },
              orderBy: [{ answeredAt: "asc" }, { id: "asc" }],
              select: { selectedChoiceId: true },
            });
            const requestedDecision = mergeGateRejectionRequested ? "reject" : "approve";
            if (decidedGate?.selectedChoiceId === requestedDecision) {
              return { update: null, activity: null, value: { replay: true as const } };
            }
            if (decidedGate) {
              return refuse(`Approval gate already has a durable ${decidedGate.selectedChoiceId ?? "unknown"} decision`);
            }
          }
        }
        let chainPredecessor: { name: string } | null = null;
        if (nextStatus === TaskStatus.DONE && locked.chainId) {
          const chainRows = await tx.task.findMany({
            where: {
              projectId: locked.projectId,
              chainId: locked.chainId,
            },
            orderBy: [{ chainLayer: "asc" }, { chainIndex: "asc" }, { id: "asc" }],
            select: { id: true, name: true, status: true, chainIndex: true, chainLayer: true },
          });
          chainPredecessor = blockingPredecessor(chainRows, taskId);
        }
        const authority = taskMoveAuthority({
          name: before.name,
          status: locked.status,
          assigneeType: locked.assigneeType,
          chainId: locked.chainId,
          archivedAt: locked.archivedAt,
          dispatchAfterTaskId: locked.dispatchAfterTaskId,
          dispatchAfter: locked.dispatchAfter,
          reactivationRefusal,
          activeRun,
          stopStateRefusal: stopped === null ? null : stopStateRefusal(stopped),
          chainPredecessor,
          mergeGateApproval,
          mergeGateRejection,
        });
        const moveRefusal = authority.refusals.find(({ status }) => status === nextStatus);
        if (moveRefusal) return refuse(moveRefusal.message);
        const unresolved = authority.deferred.find(({ status }) => status === nextStatus);
        if (unresolved) {
          throw new Error(`PATCH move authority left ${unresolved.residue} unresolved under the Task mutex`);
        }
        return {
          // Merge-gate decisions are commands, not ordinary status writes.
          // The shared dispositions below own the resulting task states.
          update: mergeGateApproval || mergeGateRejection
            ? (() => {
              const { status: _status, ...withoutStatus } = updateData;
              return withoutStatus;
            })()
            : updateData,
          activity: mergeGateApproval
            ? { actorType: "operator", body: "Approval gate approved" }
            : mergeGateRejection
              ? null
              : bindingPatch.activity ?? gatePatch.activity ?? (statusChanged
              ? taskStatusChangedActivity(locked.status, nextStatus)
              : null),
          value: {
            gate,
            previousStatus: locked.status,
            mergeGateApproval,
            mergeGateRejection,
          },
        };
      });
      if (!result.ok) return taskWriteRefusal(result.refusal);
      const plan = result.value;
      if ("message" in plan) return plan;
      // The replay branch wrote nothing, so what the caller gets back is the
      // row the gate was already decided on.
      if ("replay" in plan) return { task: await tx.task.findUniqueOrThrow({ where: { id: taskId } }) };
      const updated = result.written!;
      let finalTask = updated;
      // This OPEN row is the gate-decision CAS. It deliberately depends on
      // neither templateId nor approvalGate: gate creation records the
      // relationship in gateTaskId, and that is the only authority here.
      const gateDecision = plan.gate
        ? plan.mergeGateRejection
          ? "reject" as const
          : nextStatus === TaskStatus.DONE
            ? "approve" as const
            : null
        : null;
      // DONE has always consumed any OPEN Human-task gate, even when a legacy
      // or non-template card was not materialized as a decision object above.
      // Merge rejection is the additional TODO command that needs the same
      // sibling-card cleanup.
      if (nextStatus === TaskStatus.DONE || gateDecision !== null) {
        if (plan.gate) {
          await tx.inboxMessage.update({
            where: { id: plan.gate.card.id },
            data: { status: InboxStatus.ANSWERED, selectedChoiceId: gateDecision, answeredAt: new Date() },
          });
        }
        await tx.inboxMessage.updateMany({
          where: { gateTaskId: taskId, status: InboxStatus.OPEN },
          data: { status: InboxStatus.CLOSED },
        });
      }
      let authorization: Awaited<ReturnType<typeof produceMergeAuthorization>> = null;
      if (plan.gate && gateDecision !== null) {
        const decisionRow = await tx.inboxDecision.create({ data: {
          inboxMessageId: plan.gate.card.id,
          runId: plan.gate.runId,
          externalEventId: `patch:${taskId}:${result.activityId ?? plan.gate.card.id}`,
          decision: gateDecision,
          actorOpenId: "patch-operator",
        } });
        if (gateDecision === "approve") {
          authorization = await produceMergeAuthorization(tx, {
            card: plan.gate.card,
            inboxDecisionId: decisionRow.id,
            channel: "patch",
          }, new Date());
        }
      }
      if (plan.mergeGateApproval) {
        if (!plan.gate || authorization?.purpose !== "gate") {
          throw new Error("Merge readiness approval did not produce a gate authorization");
        }
        await releaseMergeReadinessGate(tx, {
          task: {
            id: updated.id,
            projectId: updated.projectId,
            chainId: updated.chainId,
            chainIndex: updated.chainIndex,
            approvalGate: result.task.approvalGate,
            templateStep: result.task.templateStep,
          },
          sourceRunId: plan.gate.runId,
        });
        finalTask = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      } else if (plan.mergeGateRejection) {
        if (!plan.gate) {
          throw new Error("Merge readiness rejection did not claim an open gate card");
        }
        await rejectMergeReadinessGate(tx, {
          task: {
            id: updated.id,
            projectId: updated.projectId,
            chainId: updated.chainId,
            chainIndex: updated.chainIndex,
            approvalGate: result.task.approvalGate,
            templateStep: result.task.templateStep,
          },
          choice: "reject",
        });
        finalTask = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      } else if (plan.previousStatus !== TaskStatus.DONE
        && nextStatus === TaskStatus.DONE
        && Boolean(updated.chainId)
        && authorization?.purpose !== "confirmation") {
        await activateChainSuccessor(tx, updated, { sourceRunId: null }, new Date());
      }
      return { task: finalTask };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }).catch(async (error: unknown) => {
      await recordMergeEvidenceRefusal(db, error);
      throw error;
    });
    if ("message" in written) return written;
    return { task: written.task };
  }
  if (body.opensPullRequest !== undefined) {
    // The flag defines the next Run snapshot. PATCH must therefore share the
    // same Task-row serialization point as completion retries and lost-lease
    // requeues; otherwise a request that commits first can still be missed by
    // a creator holding a stale task relation.
    const updated = await db.$transaction(
      async (tx) => writeTask(tx, taskId, (locked) => fieldWritePlan(tx, locked)),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    if (!updated.ok) {
      return taskWriteRefusal(updated.refusal);
    }
    if (updated.value !== null) return updated.value;
    return { task: updated.written! };
  }
  // A plain field edit that hands the task to an agent is still an assignment
  // writer, so it joins the same protocol: Task row first, Agent row second.
  if (assignee) {
    const written = await db.$transaction(
      async (tx) => writeTask(tx, taskId, (locked) => fieldWritePlan(tx, locked)),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    if (!written.ok) {
      return taskWriteRefusal(written.refusal);
    }
    if (written.value !== null) return written.value;
    return { task: written.written! };
  }
  const written = await db.$transaction(
    async (tx) => writeTask(tx, taskId, (locked) => fieldWritePlan(tx, locked)),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  if (!written.ok) {
    return taskWriteRefusal(written.refusal);
  }
  if (written.value !== null) return written.value;
  return { task: written.written! };
};
