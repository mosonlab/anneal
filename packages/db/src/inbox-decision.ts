import {
  AssigneeType,
  InboxDeliveryStatus,
  InboxKind,
  InboxSender,
  InboxStatus,
  Prisma,
  type PrismaClient,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
} from "@prisma/client";

import { activateChainSuccessor } from "./chain-activation.js";
import { lockChainRows, lockTaskRow } from "./locks.js";
import { produceMergeAuthorization } from "./merge-authorization.js";
import { MERGE_INTEGRATOR_KIND } from "./merge-integrator.js";
import { applyStopAnswer, parseStopQuestionKey, recoverRefreshRequestedConfirmationCard } from "./merge-integrator-db.js";
import {
  isGatedMergeReadinessTask,
  rejectMergeReadinessGate,
  releaseMergeReadinessGate,
} from "./merge-gate.js";
import { isMergeReadinessStep } from "./merge-tail.js";
import {
  ArchivedTaskError,
  WorkflowRefusalError,
  enqueueTaskRunInternal,
  errorForOpenRunRefusal,
  parksInsteadOfRaising,
  recordRunBirthRefusal,
} from "./run-open.js";

type Tx = Prisma.TransactionClient;


export type InboxDecisionInput = {
  inboxMessageId: string;
  externalEventId: string;
  decision: string;
  actorOpenId?: string | null;
  externalMessageId?: string | null;
  allowFreeText?: boolean;
  /** Optional operator note for an approval-gate decision. The HTTP route
   * trims and bounds this value; keeping it optional here preserves the
   * Feishu and existing decision callers. */
  note?: string;
};

export type InboxDecisionResult = {
  duplicate: boolean;
  resumed: boolean;
  gateAction?: "approved" | "rejected";
  messageId?: string;
};

/** Metadata marker consumed by the claim lane for rejection feedback. Keep
 * this separate from the generic operator-note marker: gate feedback must not
 * be dropped by the generic 4,000-character operator-note budget. */
export const APPROVAL_GATE_FEEDBACK_METADATA_FIELD = "approvalGateFeedback";
export const APPROVAL_GATE_NOTE_METADATA_FIELD = "note";
export const MAX_APPROVAL_GATE_NOTE_CHARS = 8_000;

const APPROVAL_GATE_APPROVED_BODY = "Approval gate approved";
const APPROVAL_GATE_REJECTED_BODY = "Approval gate rejected; step queued again";
const GATE_NOTE_LABEL = "Operator feedback on previous attempt";

const gateReplyBody = (decision: string, note: string | null): string => note === null
  ? decision
  : `${decision}\n\n${GATE_NOTE_LABEL}:\n${note}`;

const gateActivityBody = (base: string, note: string | null): string => note === null
  ? base
  : `${base}\n${GATE_NOTE_LABEL}:\n${note}`;

/** Shared transaction body for Feishu and Web decisions. OPEN is the cross-channel compare-and-set. */
export const applyInboxDecisionTx = async (
  tx: Tx,
  input: InboxDecisionInput,
  now = new Date(),
): Promise<InboxDecisionResult> => {
  const question = await tx.inboxMessage.findUnique({
    where: { id: input.inboxMessageId },
    include: {
      session: { include: { run: true } },
      gateTask: {
        include: {
          templateStep: { select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } } },
        },
      },
      thread: true,
    },
  });
  if (!question?.session?.run) {
    throw new WorkflowRefusalError("inbox-question-not-found", "No matching Inbox question");
  }
  const gateDecision = Boolean(question.gateTaskId);
  if (gateDecision && input.decision !== "approve" && input.decision !== "reject") {
    throw new WorkflowRefusalError(
      "approval-gate-decision-invalid",
      "Approval gate decision must be approve or reject",
    );
  }
  if (!gateDecision && question.kind === InboxKind.MULTIPLE_CHOICE && !input.allowFreeText) {
    const choices = Array.isArray(question.choices) ? question.choices : [];
    const matchesChoice = choices.some((choice) => (
      typeof choice === "object" && choice !== null && "id" in choice && choice.id === input.decision
    ));
    if (!matchesChoice) {
      throw new WorkflowRefusalError("inbox-choice-mismatch", "Decision must match an Inbox choice id");
    }
  }
  if (!gateDecision && input.note !== undefined) {
    throw new WorkflowRefusalError(
      "invalid-request",
      "A decision note is only supported for an approval-gate card",
    );
  }
  // The web route rejects this before entering the transaction for a clearer
  // 400, but a shared DB caller must not accidentally attach a gate note to a
  // resumable question. There is no InboxMessage note column, so only the
  // gate branch below is allowed to serialize `note` onto its HUMAN reply.
  const gateNote = gateDecision ? input.note?.trim() || null : null;
  if (gateDecision && input.note !== undefined && (gateNote === null || gateNote.length > MAX_APPROVAL_GATE_NOTE_CHARS)) {
    throw new WorkflowRefusalError(
      "invalid-request",
      "Approval gate note must be between 1 and 8000 characters",
    );
  }
  // §D-P7. A stop question is answered long after its run ended, so it cannot
  // travel the WAITING_INBOX path — and it is not a gate card either, because a
  // gate card would trip the gate CAS at PATCH time. It is its own thing, bound
  // to the stop it answers by a server-written dedupeKey.
  const stopBinding = gateDecision ? null : parseStopQuestionKey(question.dedupeKey);
  if (!gateDecision && !stopBinding && question.session.run.status !== RunStatus.WAITING_INBOX) {
    throw new WorkflowRefusalError("inbox-run-not-waiting", "No matching waiting Inbox question");
  }
  if (stopBinding) {
    const claimedStop = await tx.inboxMessage.updateMany({
      where: { id: question.id, status: InboxStatus.OPEN },
      data: { status: InboxStatus.ANSWERED, selectedChoiceId: input.decision, answeredAt: now },
    });
    if (claimedStop.count !== 1) {
      // A replay is the supported repair for the legacy state where the first
      // transaction durably recorded refresh-requested but returned without a
      // confirmation card. Re-read the append-only disposition under the
      // integrator Task mutex; every other duplicate remains a no-op.
      if (question.status === InboxStatus.ANSWERED && question.selectedChoiceId === input.decision && question.taskId) {
        await recoverRefreshRequestedConfirmationCard(tx, question.taskId, now);
      }
      return { duplicate: true, resumed: false };
    }
    await tx.inboxMessage.create({ data: {
      from: InboxSender.HUMAN,
      agentId: question.agentId,
      sessionId: question.sessionId,
      taskId: question.taskId,
      threadId: question.threadId,
      replyToMessageId: question.id,
      kind: "TEXT",
      body: input.decision,
      selectedChoiceId: input.decision,
      status: InboxStatus.CLOSED,
      dedupeKey: `decision:${input.externalEventId}:reply`,
      externalMessageId: input.externalMessageId ?? null,
      deliveryStatus: InboxDeliveryStatus.DELIVERED,
      deliveredAt: now,
    } });
    await tx.inboxDecision.create({ data: {
      inboxMessageId: question.id,
      runId: question.session.run.id,
      externalEventId: input.externalEventId,
      decision: input.decision,
      actorOpenId: input.actorOpenId ?? null,
    } });
    await applyStopAnswer(tx, {
      question: {
        id: question.id, taskId: question.taskId, dedupeKey: question.dedupeKey,
        agentId: question.agentId, sessionId: question.sessionId,
      },
      choice: input.decision,
      now,
    });
    return { duplicate: false, resumed: false, messageId: question.id };
  }
  // A HUMAN gate or server-owned readiness rejection can queue the executable
  // predecessor. Ordinary AGENT gates remain executable themselves. A chained
  // decision takes the complete chain mutex before any Task-row mutation; this
  // is the same order used by completion and manual start/retry.
  let rejectionTarget: { id: string; name: string } | null = null;
  if (gateDecision && question.gateTask?.chainId) {
    await lockChainRows(tx, {
      projectId: question.gateTask.projectId,
      chainId: question.gateTask.chainId,
    });
  }
  // A confirmation card created for a stopped integrator is bound to the same
  // readiness task as the initial gate. Its durable evidence-request purpose,
  // rather than the task's persistent approvalGate flag, decides which
  // disposition owns the answer.
  const confirmationRequest = gateDecision && question.gateTask
    && isGatedMergeReadinessTask(question.gateTask)
    ? await tx.taskActivity.findFirst({
      where: {
        taskId: question.gateTask.id,
        AND: [
          { metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.evidenceRequest } },
          { metadata: { path: ["cardId"], equals: question.id } },
          { metadata: { path: ["purpose"], equals: "confirmation" } },
        ],
      },
      select: { id: true },
    })
    : null;
  const initialMergeGate = isGatedMergeReadinessTask(question.gateTask)
    && confirmationRequest === null;
  if (gateDecision && question.gateTask && input.decision === "reject"
    && !initialMergeGate) {
    const readiness = isMergeReadinessStep(question.gateTask.templateStep);
    rejectionTarget = question.gateTask.assigneeType === AssigneeType.AGENT && !readiness
      ? question.gateTask
      : question.gateTask.chainId && question.gateTask.chainLayer !== null
        ? await tx.task.findFirst({
          where: {
            projectId: question.gateTask.projectId,
            chainId: question.gateTask.chainId,
            chainLayer: { lt: question.gateTask.chainLayer },
            assigneeType: AssigneeType.AGENT,
            assigneeAgentId: { not: null },
            repoId: { not: null },
          },
          orderBy: [{ chainLayer: "desc" }, { chainIndex: "desc" }, { id: "desc" }],
        })
        : null;
    if (!rejectionTarget && question.gateTask.chainId && question.gateTask.chainIndex !== null) {
      rejectionTarget = await tx.task.findFirst({
        where: {
          projectId: question.gateTask.projectId,
          chainId: question.gateTask.chainId,
          chainIndex: { lt: question.gateTask.chainIndex },
          assigneeType: AssigneeType.AGENT,
          assigneeAgentId: { not: null },
          repoId: { not: null },
        },
        orderBy: { chainIndex: "desc" },
      });
    }
    if (!rejectionTarget) {
      throw new WorkflowRefusalError(
        "approval-gate-rejection-target-missing",
        "Approval gate has no executable previous task to reject to",
      );
    }
  }
  const lockedRejectionTarget = rejectionTarget && rejectionTarget.id !== question.gateTaskId
    ? await lockTaskRow(tx, rejectionTarget.id)
    : null;
  // PATCH DONE takes the gate Task mutex before closing OPEN cards. Take the
  // same mutex before this path's OPEN claim so PATCH and Inbox decisions have
  // one winner instead of both advancing the chain.
  const lockedGateTask = gateDecision && question.gateTask
    ? await lockTaskRow(tx, question.gateTask.id)
    : null;
  const claimed = await tx.inboxMessage.updateMany({
    where: { id: question.id, status: InboxStatus.OPEN },
    data: { status: InboxStatus.ANSWERED, selectedChoiceId: input.decision, answeredAt: now },
  });
  if (claimed.count !== 1) return { duplicate: true, resumed: false };
  if (gateDecision) {
    // gateTaskId, not an individual card id, is the decision identity. Old or
    // duplicated cards are allowed by the schema, so the winning card consumes
    // every sibling OPEN state while the gate Task mutex is held. A later click
    // on any sibling then loses the selected-card OPEN claim above.
    await tx.inboxMessage.updateMany({
      where: { gateTaskId: question.gateTaskId, status: InboxStatus.OPEN, id: { not: question.id } },
      data: { status: InboxStatus.CLOSED },
    });
  }
  const reply = await tx.inboxMessage.create({ data: {
    from: InboxSender.HUMAN,
    agentId: question.agentId,
    sessionId: question.sessionId,
    taskId: question.taskId,
    goalId: question.goalId,
    threadId: question.threadId,
    replyToMessageId: question.id,
    kind: "TEXT",
    body: gateDecision ? gateReplyBody(input.decision, gateNote) : input.decision,
    selectedChoiceId: input.decision,
    status: InboxStatus.CLOSED,
    dedupeKey: `decision:${input.externalEventId}:reply`,
    externalMessageId: input.externalMessageId ?? null,
    deliveryStatus: InboxDeliveryStatus.DELIVERED,
    deliveredAt: now,
  } });
  const decisionRow = await tx.inboxDecision.create({ data: {
    inboxMessageId: question.id,
    runId: question.session.run.id,
    externalEventId: input.externalEventId,
    decision: input.decision,
    actorOpenId: input.actorOpenId ?? null,
  } });

  if (gateDecision && question.gateTask) {
    if (input.decision === "approve") {
      if (initialMergeGate) {
        await tx.taskActivity.create({ data: {
          taskId: question.gateTask.id,
          actorType: "operator",
          body: "Approval gate approved",
        } });
        // The authorization is intentionally produced before releasing the
        // readiness task. A missing, malformed, or unattested card rolls the
        // whole decision back and leaves it OPEN for a fresh decision.
        const authorization = await produceMergeAuthorization(tx, {
          card: { id: question.id, body: question.body, gateTaskId: question.gateTaskId },
          inboxDecisionId: decisionRow.id,
          channel: "inbox",
        }, now);
        if (!authorization || authorization.purpose !== "gate") {
          throw new WorkflowRefusalError(
            "conflict",
            "Merge readiness approval did not produce a gate authorization",
          );
        }
        await releaseMergeReadinessGate(tx, {
          task: question.gateTask,
          sourceRunId: question.session.run.id,
        });
        return { duplicate: false, resumed: false, gateAction: "approved", messageId: reply.id };
      }
      await tx.task.update({ where: { id: question.gateTask.id }, data: { status: TaskStatus.DONE, failureReason: null } });
      await tx.taskActivity.create({ data: {
        taskId: question.gateTask.id,
        actorType: "operator",
        body: gateActivityBody(APPROVAL_GATE_APPROVED_BODY, gateNote),
        ...(gateNote === null ? {} : { metadata: {
          [APPROVAL_GATE_NOTE_METADATA_FIELD]: gateNote,
        } }),
      } });
      // §D-P3 Phase C, in the same transaction as the decision row it binds to.
      // A refusal here throws and rolls the whole approval back.
      const authorization = await produceMergeAuthorization(tx, {
        card: { id: question.id, body: question.body, gateTaskId: question.gateTaskId },
        inboxDecisionId: decisionRow.id,
        channel: "inbox",
      }, now);
      // A confirmation card's run is created by produceMergeAuthorization at the
      // raised ceiling; activating the successor again would enqueue a second
      // run at the original one.
      if (authorization?.purpose !== "confirmation") {
        await activateChainSuccessor(tx, question.gateTask, {
          sourceRunId: question.session.run.id,
          chatId: question.thread?.externalChatId ?? null,
          onRefusal: "raise",
        }, now);
      }
      return { duplicate: false, resumed: false, gateAction: "approved", messageId: reply.id };
    }
    if (initialMergeGate) {
      await rejectMergeReadinessGate(tx, {
        task: question.gateTask,
        choice: input.decision,
      });
      return { duplicate: false, resumed: false, gateAction: "rejected", messageId: reply.id };
    }
    // Refusing by throwing rolls the whole transaction back, which leaves the
    // decision OPEN — the human unarchives the step and decides again, instead
    // of the gate silently closing onto a run the runner will never claim.
    const redo = rejectionTarget!;
    const lockedRedo = redo.id === question.gateTask.id
      ? lockedGateTask
      : lockedRejectionTarget;
    if (lockedRedo?.archivedAt) {
      throw new ArchivedTaskError(redo.id, redo.name);
    }
    await tx.task.update({ where: { id: redo.id }, data: { status: TaskStatus.TODO, failureReason: null } });
    if (redo.id !== question.gateTask.id) {
      await tx.task.update({ where: { id: question.gateTask.id }, data: { status: TaskStatus.TODO } });
    }
    await tx.taskActivity.create({ data: {
      taskId: redo.id,
      actorType: "operator",
      body: gateActivityBody(APPROVAL_GATE_REJECTED_BODY, gateNote),
      ...(gateNote === null ? {} : { metadata: {
        [APPROVAL_GATE_FEEDBACK_METADATA_FIELD]: true,
        [APPROVAL_GATE_NOTE_METADATA_FIELD]: gateNote,
      } }),
    } });
    // The rejection above is already written. A raised refusal would roll it
    // back, so a spend cap parks the redo target instead of discarding the
    // human's decision — the REVIEW naming the cap is what they act on.
    const redoOpened = await enqueueTaskRunInternal(tx, redo.id, now, null);
    if (!redoOpened.ok) {
      if (!parksInsteadOfRaising(redoOpened.refusal)) throw errorForOpenRunRefusal(redoOpened.refusal);
      await recordRunBirthRefusal(tx, redo.id, redoOpened.refusal);
    }
    return { duplicate: false, resumed: false, gateAction: "rejected", messageId: reply.id };
  }

  const queued = await tx.run.updateMany({
    where: { id: question.session.run.id, status: RunStatus.WAITING_INBOX },
    data: { status: RunStatus.QUEUED, readyAt: now, runnerId: null, fencingToken: null, leaseExpiresAt: null },
  });
  if (queued.count !== 1) {
    throw new WorkflowRefusalError("conflict", "Waiting Run changed while applying Inbox decision");
  }
  await tx.session.update({ where: { id: question.session.id }, data: {
    executionStatus: SessionExecutionStatus.REQUESTED,
    waitingOnMessageId: null,
    resumeInput: input.decision,
    resumeAttempt: { increment: 1 },
  } });
  return { duplicate: false, resumed: true, messageId: reply.id };
};

export const applyInboxDecision = async (
  db: PrismaClient,
  input: InboxDecisionInput,
  now = new Date(),
): Promise<InboxDecisionResult> => db.$transaction(
  (tx) => applyInboxDecisionTx(tx, input, now),
  // PostgreSQL re-checks the OPEN predicate after a concurrent row lock is
  // released, so the loser observes count=0 instead of a serialization error.
  { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
);
