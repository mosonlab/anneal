import { Prisma, TaskStatus } from "@prisma/client";

import { requireGateAttestation } from "./gate-attestation.js";
import {
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  type AuthorizationPayload,
  type DecisionChannel,
  authorizationMetadata,
  parseEvidence,
} from "./merge-integrator.js";
import { findEvidenceRequestByNonce, gateFeedsIntegratorStep } from "./merge-integrator-db.js";
import { errorForOpenRunRefusal, openRun, parksInsteadOfRaising, recordRunBirthRefusal } from "./run-open.js";

type Tx = Prisma.TransactionClient;


/**
 * Refusals this function raises. They roll the approval transaction back, which
 * leaves the card OPEN — the human tries again once the worker has filled it,
 * rather than the gate silently closing onto an authorization nobody judged.
 */
export class MergeEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeEvidenceError";
  }
}

export const isMergeEvidenceError = (error: unknown): error is MergeEvidenceError =>
  error instanceof Error && error.name === "MergeEvidenceError";

export type MergeAuthorizationResult = {
  activityId: string;
  purpose: "gate" | "confirmation";
  payload: AuthorizationPayload;
};

/**
 * §D-P3 Phase C, shared verbatim by the Inbox channel and the PATCH channel.
 *
 * The whole security argument sits in one line below: the payload is built from
 * `card.body`, which `gateQuestion` and the evidence worker are the only writers
 * of. "Presented equals recorded" is therefore true *by identity* rather than by
 * comparison — there is no second source for the head, base or checks that could
 * disagree with what the human read.
 *
 * It performs no network I/O and reads no field that was not already persisted,
 * so it runs unchanged in the @anneal/inbox process and inside the API's PATCH
 * transaction, and it holds no lock across a remote call.
 */
export const produceMergeAuthorization = async (
  tx: Tx,
  input: {
    card: { id: string; body: string; gateTaskId: string | null };
    inboxDecisionId: string;
    channel: DecisionChannel;
  },
  now = new Date(),
): Promise<MergeAuthorizationResult | null> => {
  const gateTaskId = input.card.gateTaskId;
  if (!gateTaskId) return null;
  const gateTask = await tx.task.findUnique({
    where: { id: gateTaskId },
    select: { id: true, projectId: true, chainId: true, chainIndex: true },
  });
  if (!gateTask) return null;
  const integrator = await gateFeedsIntegratorStep(tx, gateTask);
  // Not an integrator gate: an ordinary approval without a mechanical successor, untouched.
  if (!integrator) return null;

  const block = parseEvidence(input.card.body);
  if (block.status === "absent") {
    throw new MergeEvidenceError("Merge evidence has not been read yet; wait for the card to fill before approving");
  }
  if (block.status === "unavailable") {
    throw new MergeEvidenceError("Merge evidence could not be read; re-request evidence before approving");
  }
  if (block.status === "unparseable") {
    throw new MergeEvidenceError(`Merge evidence block is malformed (${block.reason}); approval refused`);
  }

  const request = await findEvidenceRequestByNonce(tx, gateTaskId, block.evidence.nonce);
  const purpose = request?.purpose ?? "gate";
  const payload: AuthorizationPayload = {
    ...block.evidence,
    issuedAt: now.toISOString(),
    decision: { channel: input.channel, inboxDecisionId: input.inboxDecisionId, inboxMessageId: input.card.id },
  };
  // The evidence block says what the head *is*; it says nothing about whether the
  // merge gate ever signed it. Without this the Inbox and PATCH channels could
  // authorize a merge at a commit no gate ran against — the mechanical channel
  // reads the Regression verdict, these two never did.
  const attested = await requireGateAttestation(tx, {
    chainId: gateTask.chainId,
    headSha: payload.headSha,
  });
  if (!attested.satisfied) {
    throw new MergeEvidenceError(`${attested.reason}; approval refused`);
  }

  const activity = await tx.taskActivity.create({ data: {
    taskId: gateTaskId,
    actorType: "operator",
    body: `Merge authorized for PR #${payload.prNumber} at ${payload.headSha} onto ${payload.baseRef} (${payload.baseSha})`,
    metadata: authorizationMetadata(payload) as Prisma.InputJsonObject,
  } });

  if (purpose === "confirmation") {
    // A renewal. The successor is already active, so activateChainSuccessor
    // would produce a run at the original ceiling that runner.ts then refuses
    // at claim. This is the only writer of a ceiling above the task's original.
    const opened = await openRun(tx, integrator.id, { kind: "integrator-authorized", readyAt: now });
    if (!opened.ok) {
      // A spend cap is parked, not raised. Raising rolls this transaction back
      // and with it the authorization the human just gave, leaving nothing to
      // say why no merge run appeared; parking keeps the authorization on the
      // record and puts the integrator in REVIEW naming the cap, which is the
      // operator's cue to raise it and retry.
      if (!parksInsteadOfRaising(opened.refusal)) throw errorForOpenRunRefusal(opened.refusal);
      await recordRunBirthRefusal(tx, integrator.id, opened.refusal);
      return { activityId: activity.id, purpose, payload };
    }
    await tx.task.updateMany({
      where: { id: integrator.id, status: { in: [TaskStatus.REVIEW, TaskStatus.TODO, TaskStatus.DOING] } },
      data: { status: TaskStatus.TODO, failureReason: null },
    });
    await tx.taskActivity.create({ data: {
      taskId: integrator.id,
      actorType: "control-plane",
      body: "Renewed authorization approved; mechanical merge run queued",
      metadata: {
        kind: MERGE_INTEGRATOR_KIND.evidenceRequest,
        schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
        resolved: true,
        authorizationActivityId: activity.id,
      },
    } });
  }
  return { activityId: activity.id, purpose, payload };
};
