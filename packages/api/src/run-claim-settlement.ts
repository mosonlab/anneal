import { FailureClass, type Prisma, RunStatus, TaskStatus } from "@anneal/db";
import type { ClaimRefusal } from "@anneal/db/claim-contract";

import { openMergeTailStopNotice } from "./merge-tail-actions.js";
import { type SpecificationRefusal, SPEC_TRANSCRIPTION_REFUSAL_REASON } from "./specification-fidelity.js";
import { writeTask } from "./task-write.js";

export const SKIP = { outcome: "skip" } as const;
export const HALT = { outcome: "halt" } as const;
export type CandidateDecision = typeof SKIP | typeof HALT | ClaimRefusal;

export type QueuedCandidateCondition =
  | { kind: "repository-grant-missing" }
  | { kind: "prior-output-missing"; missingKinds: string[] }
  | { kind: "candidate-activation-failed"; reason: string; metadata: Record<string, unknown> }
  | { kind: "regression-repair-handoff-invalid"; reason: string; previousRunId: string; metadata: Record<string, unknown> }
  | { kind: "review-claim-refused"; refusal: SpecificationRefusal }
  | { kind: "spec-transcription-refused"; refusal: SpecificationRefusal; implementationHeadSha: string }
  | { kind: "specification-read-exhausted"; refusal: SpecificationRefusal; metadata: Record<string, unknown> };

type Settlement = {
  parkTo: "BACKLOG" | "REVIEW";
  inbox: boolean;
  failureReason: string;
  activityBody: string;
  inboxBody?: string;
  metadata: Record<string, unknown>;
  refusal?: ClaimRefusal;
};

export const queuedCandidateSettlement = (condition: QueuedCandidateCondition): Settlement => {
  switch (condition.kind) {
    case "repository-grant-missing":
      return {
        parkTo: "BACKLOG",
        inbox: true,
        failureReason: "repository-grant-missing: restore the agent Repo grant, then retry this run",
        activityBody: "Queued run stopped because its repository grant is missing; restore the grant and retry",
        inboxBody: "Queued run stopped and the task was parked in Backlog because its repository grant is missing; restore the grant and retry",
        metadata: { condition: condition.kind },
      };
    case "prior-output-missing": {
      const reason = `Prior output claim refused: missing declared output kind${condition.missingKinds.length === 1 ? "" : "s"}: ${condition.missingKinds.join(", ")}`;
      return {
        parkTo: "BACKLOG", inbox: true, failureReason: reason,
        activityBody: `Prior output claim stopped: ${reason}`,
        inboxBody: `Prior output claim failed and the task was parked in Backlog: ${reason}`,
        metadata: { condition: condition.kind, missingKinds: condition.missingKinds },
        refusal: { error: reason, reason: condition.kind },
      };
    }
    case "candidate-activation-failed":
      return {
        parkTo: "BACKLOG", inbox: true, failureReason: condition.reason,
        activityBody: `Queued run activation failed: ${condition.reason}`,
        inboxBody: `Queued run activation failed and the task was parked in Backlog: ${condition.reason}`,
        metadata: { condition: condition.kind, ...condition.metadata },
      };
    case "regression-repair-handoff-invalid":
      return {
        parkTo: "REVIEW", inbox: true, failureReason: condition.reason,
        activityBody: `Fresh Regression Run stopped: ${condition.reason}`,
        inboxBody: `Autonomous merge tail stopped: ${condition.reason}`,
        // The repair-result marker remains authored by the claim's handoff reader.
        metadata: condition.metadata,
      };
    case "review-claim-refused":
    case "spec-transcription-refused":
    case "specification-read-exhausted": {
      const { refusal } = condition;
      const exhausted = condition.kind === "specification-read-exhausted";
      return {
        parkTo: "BACKLOG", inbox: true, failureReason: refusal.message,
        activityBody: exhausted
          ? `Review claim stopped after its transient specification-read budget was exhausted: ${refusal.message}`
          : `Review claim stopped: ${refusal.message}`,
        inboxBody: exhausted
          ? `Review claim failed and the task was parked in Backlog after its transient specification-read budget was exhausted: ${refusal.message}`
          : `Review claim failed and the task was parked in Backlog: ${refusal.message}`,
        metadata: {
          condition: refusal.reason,
          classification: refusal.classification,
          ...(condition.kind === "spec-transcription-refused" ? { implementationHeadSha: condition.implementationHeadSha } : {}),
          ...(exhausted ? condition.metadata : {}),
        },
        ...(condition.kind === "spec-transcription-refused" && refusal.reason === SPEC_TRANSCRIPTION_REFUSAL_REASON
          ? { refusal: { error: refusal.message, reason: refusal.reason } } : {}),
      };
    }
  }
};

export const settleQueuedCandidate = async (
  tx: Prisma.TransactionClient,
  candidate: { id: string; leaseGeneration: number; agentId: string; task: { id: string } | null },
  condition: QueuedCandidateCondition,
  now: Date,
): Promise<CandidateDecision> => {
  if (!candidate.task) throw new Error(`Queued candidate ${candidate.id} has no task to park`);
  const settlement = queuedCandidateSettlement(condition);
  const stopped = await tx.run.updateMany({
    where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
    data: {
      status: RunStatus.FAILED,
      failureClass: FailureClass.TASK_FAILED,
      failureReason: settlement.failureReason,
      retryable: false,
      endedAt: now,
    },
  });
  if (stopped.count !== 1) return SKIP;
  const parked = await writeTask(tx, candidate.task.id, async () => ({
    update: { status: TaskStatus[settlement.parkTo], failureReason: settlement.failureReason },
    activity: {
      actorType: "control-plane",
      body: settlement.activityBody,
      metadata: { runId: candidate.id, ...settlement.metadata },
    },
    value: null,
  }));
  if (!parked.ok) throw new Error(`Queued candidate ${candidate.id} could not park its task: ${parked.refusal.kind}`);
  if (settlement.inbox) {
    if (condition.kind === "regression-repair-handoff-invalid") {
      const sourceSession = await tx.session.findUnique({
        where: { runId: condition.previousRunId }, select: { id: true },
      });
      await openMergeTailStopNotice(tx, {
        taskId: candidate.task.id, agentId: candidate.agentId,
        ...(sourceSession ? { sessionId: sourceSession.id } : {}),
        reason: settlement.failureReason,
      });
    } else {
      if (!settlement.inboxBody) throw new Error(`Queued candidate ${candidate.id} has no Inbox notice body`);
      const dedupeKey = `${settlement.metadata.condition}:${candidate.id}`;
      await tx.inboxMessage.upsert({
        where: { dedupeKey },
        create: {
          from: "AGENT", agentId: candidate.agentId, taskId: candidate.task.id,
          kind: "TEXT", body: settlement.inboxBody, dedupeKey,
        },
        update: {},
      });
    }
  }
  // Refusals already end the claim and preserve its wire contract. Otherwise a
  // chain lock must halt: another candidate may hold a sibling Run while waiting
  // for this chain mutex. Continuing the scan would invert that lock order.
  return settlement.refusal ?? (parked.chainLocked ? HALT : SKIP);
};
