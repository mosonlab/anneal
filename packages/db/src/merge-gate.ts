import {
  Prisma,
  RunStatus,
  TaskStatus,
} from "@prisma/client";

import {
  gateFeedsIntegratorStep,
  parseEvidenceRequest,
  settleIntegratorTerminal,
} from "./merge-integrator-db.js";
import {
  MERGE_INTEGRATOR_KIND,
  parseAuthorizationMetadata,
  selectAuthorization,
} from "./merge-integrator.js";
import { isMergeReadinessStep, type MergeReadinessStepShape } from "./merge-tail.js";
import { writeMarker } from "./merge-tail-markers.js";

type Tx = Prisma.TransactionClient;

export type MergeGateTask = {
  id: string;
  projectId: string;
  chainId: string | null;
  chainIndex: number | null;
  approvalGate: boolean;
  templateStep: MergeReadinessStepShape;
};

/** A merge readiness task is the only task whose approval releases a worker. */
export const isGatedMergeReadinessTask = (
  task: Pick<MergeGateTask, "approvalGate" | "templateStep"> | null | undefined,
): boolean => Boolean(task?.approvalGate && isMergeReadinessStep(task.templateStep));

/**
 * The post-approval state is deliberately the same state as an ungated
 * readiness successor. The task remains worker-owned (TODO), and the marker
 * is the ordinary queued marker; no chain successor is activated here.
 */
export const releaseMergeReadinessGate = async (
  tx: Tx,
  input: { task: MergeGateTask; sourceRunId: string | null },
): Promise<void> => {
  if (!isGatedMergeReadinessTask(input.task)) {
    throw new Error(`Task ${input.task.id} is not a gated merge readiness step`);
  }
  await tx.task.update({
    where: { id: input.task.id },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  await writeMarker(tx, input.task.id, "readiness", "queued", {
    actorType: "control-plane",
    body: "Predecessor layer completed; server-side merge readiness queued",
    metadata: { sourceRunId: input.sourceRunId },
  });
};

/**
 * Close a rejected merge gate through the same terminal integrator settlement
 * used by an operator abandoning a stopped merge. No Run is opened and no
 * GitHub client is involved in this transaction.
 */
export const rejectMergeReadinessGate = async (
  tx: Tx,
  input: { task: MergeGateTask; choice: string },
): Promise<void> => {
  if (!isGatedMergeReadinessTask(input.task)) {
    throw new Error(`Task ${input.task.id} is not a gated merge readiness step`);
  }
  const integrator = await gateFeedsIntegratorStep(tx, input.task);
  if (!integrator) {
    throw new Error(`Gated merge readiness task ${input.task.id} has no merge execution successor`);
  }
  if (integrator.status === TaskStatus.DONE) {
    throw new Error(`Merge gate rejection found an already-terminal merge execution task ${integrator.id}`);
  }
  const activeRuns = await tx.run.count({
    where: {
      taskId: integrator.id,
      status: {
        in: [
          RunStatus.QUEUED,
          RunStatus.CLAIMED,
          RunStatus.PROVISIONING,
          RunStatus.RUNNING,
          RunStatus.WAITING_INBOX,
        ],
      },
    },
  });
  if (activeRuns > 0) {
    throw new Error(`Merge gate rejection found an active merge execution run for task ${integrator.id}`);
  }
  await settleIntegratorTerminal(tx, {
    integratorTaskId: integrator.id,
    outputBody: `Chain abandoned after merge gate rejection (${input.choice}). No merge was performed by this contract.`,
    activityBody: "Chain abandoned; merge execution closed without a merge (merge gate rejected)",
  });
  await tx.task.update({
    where: { id: input.task.id },
    data: { status: TaskStatus.DONE, failureReason: null },
  });
  await tx.taskActivity.create({ data: {
    taskId: input.task.id,
    actorType: "operator",
    body: `Approval gate rejected; merge chain abandoned by operator (${input.choice})`,
  } });
};

export class MergeGateAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeGateAuthorizationError";
  }
}

/**
 * Require the latest persisted operator authorization to name the exact head
 * and base the readiness worker just verified. Mechanical authorization is not
 * a substitute: it is produced only after this assertion and would otherwise
 * create a circular authorization path.
 */
export const requireMergeGateAuthorization = async (
  tx: Tx,
  input: { taskId: string; headSha: string; baseSha: string },
): Promise<void> => {
  const candidates = await tx.taskActivity.findMany({
    where: { taskId: input.taskId, actorType: "operator" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, taskId: true, createdAt: true, actorType: true, metadata: true },
  });
  const decisionIds = candidates.flatMap((candidate) => {
    const parsed = parseAuthorizationMetadata(candidate.metadata);
    return parsed.status === "ok" && parsed.payload.decision.channel !== "mechanical"
      ? [parsed.payload.decision.inboxDecisionId]
      : [];
  });
  const decisions = decisionIds.length === 0
    ? []
    : await tx.inboxDecision.findMany({
      where: { id: { in: [...new Set(decisionIds)] } },
      select: { id: true, decision: true, createdAt: true, inboxMessageId: true },
    });
  const cards = decisions.length === 0
    ? []
    : await tx.inboxMessage.findMany({
      where: { id: { in: [...new Set(decisions.map((decision) => decision.inboxMessageId))] } },
      select: { id: true, gateTaskId: true, status: true, selectedChoiceId: true, body: true },
    });
  const selected = selectAuthorization(candidates, decisions, cards, input.taskId);
  if (!selected.authorization) {
    const detail = selected.refusal === "malformed-near-match"
      ? "malformed or mismatched operator authorization"
      : selected.refusal === "ambiguous-tie"
        ? "ambiguous operator authorization"
        : "missing operator authorization";
    throw new MergeGateAuthorizationError(
      `Merge gate operator authorization is ${detail} for verified head ${input.headSha} and base ${input.baseSha}`,
    );
  }
  const gateRequestActivity = await tx.taskActivity.findFirst({
    where: {
      taskId: input.taskId,
      AND: [
        { metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.evidenceRequest } },
        { metadata: { path: ["purpose"], equals: "gate" } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, taskId: true, metadata: true },
  });
  const gateRequest = gateRequestActivity ? parseEvidenceRequest(gateRequestActivity) : null;
  if (!gateRequest
    || selected.authorization.decision.inboxMessageId !== gateRequest.cardId
    || selected.authorization.nonce !== gateRequest.nonce) {
    throw new MergeGateAuthorizationError(
      `Merge gate operator authorization does not match the current gate evidence request for verified head ${input.headSha} and base ${input.baseSha}`,
    );
  }
  if (selected.authorization.headSha !== input.headSha) {
    throw new MergeGateAuthorizationError(
      `Merge gate operator authorization head ${selected.authorization.headSha} does not match verified head ${input.headSha}`,
    );
  }
  if (selected.authorization.baseSha !== input.baseSha) {
    throw new MergeGateAuthorizationError(
      `Merge gate operator authorization base ${selected.authorization.baseSha} does not match verified base ${input.baseSha}`,
    );
  }
};
