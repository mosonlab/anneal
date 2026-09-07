import { Prisma, type PrismaClient, TaskStatus } from "@prisma/client";

import { requireGateAttestation } from "./gate-attestation.js";
import {
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  type AuthorizationPayload,
  type DecisionChannel,
  authorizationMetadata,
  parseEvidence,
} from "./merge-integrator.js";
import {
  findEvidenceRequestByNonce,
  gateFeedsIntegratorStep,
  mergeExecutorRunnerIds,
  mergeExecutorsBlockingAuthorization,
  type MergeExecutorLivenessReader,
} from "./merge-integrator-db.js";
import { MERGE_TAIL_KIND } from "./merge-tail.js";
import { errorForOpenRunRefusal, openRun, parksInsteadOfRaising, recordRunBirthRefusal } from "./run-open.js";

type Tx = Prisma.TransactionClient;


/**
 * Refusals this function raises. They roll the approval transaction back, which
 * leaves the card OPEN — the human tries again once the worker has filled it,
 * rather than the gate silently closing onto an authorization nobody judged.
 */
export class MergeEvidenceError extends Error {
  constructor(message: string, readonly refusalActivity?: { taskId: string; metadata: Prisma.InputJsonObject }) {
    super(message);
    this.name = "MergeEvidenceError";
  }
}

export const isMergeEvidenceError = (error: unknown): error is MergeEvidenceError =>
  error instanceof Error && error.name === "MergeEvidenceError";

/** The named refusal for an attestation taken against another base. */
export const GATE_ATTESTATION_BASE_MISMATCH = "gate-attestation-base-mismatch";

/** These names are shared with readiness's requeue marker. */
export const MERGE_EXECUTOR_OFFLINE_STATE = "requeued-executor-offline";
export const MERGE_EXECUTOR_OFFLINE_REASON = "merge-executor-offline";

/** Persist only after the caller's approval transaction has rolled back. */
export const recordMergeEvidenceRefusal = async (db: PrismaClient, error: unknown): Promise<void> => {
  if (!isMergeEvidenceError(error) || !error.refusalActivity) return;
  await db.taskActivity.create({ data: {
    ...error.refusalActivity,
    actorType: "control-plane",
    body: error.message,
  } });
};

export type MergeAuthorizationResult = {
  activityId: string;
  purpose: "gate" | "confirmation";
  payload: AuthorizationPayload;
};

const executorOfflineDetail = (executorRunnerIds: readonly string[]): string =>
  `${MERGE_EXECUTOR_OFFLINE_REASON}: no merge executor in ${executorRunnerIds.join(", ")} is online`;

type OfflineMarker = { createdAt: Date; metadata: Prisma.JsonValue };

const openOfflineEpisodeStart = (marker: OfflineMarker | null, now: Date): Date => {
  if (!marker) return now;
  const metadata = marker.metadata as { episodeStartedAt?: unknown; episodeClosed?: unknown } | null;
  if (metadata?.episodeClosed === true) return now;
  if (typeof metadata?.episodeStartedAt !== "string") return marker.createdAt;
  const started = new Date(metadata.episodeStartedAt);
  return Number.isNaN(started.getTime()) ? marker.createdAt : started;
};

/**
 * A confirmation approval is a renewal of the mechanical Run. When the
 * allowlisted executor fleet is offline, preserve the OPEN card by refusing
 * the transaction and carry the same readiness marker outside its rollback.
 * The next operator attempt can then use the evidence already on the card
 * once a live executor is observed.
 */
const executorOfflineRefusal = async (
  tx: Tx,
  readinessTaskId: string,
  executorRunnerIds: readonly string[],
  now: Date,
): Promise<MergeEvidenceError> => {
  const marker = await tx.taskActivity.findFirst({
    where: {
      taskId: readinessTaskId,
      metadata: { path: ["state"], equals: MERGE_EXECUTOR_OFFLINE_STATE },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true, metadata: true },
  });
  const episodeStartedAt = openOfflineEpisodeStart(marker, now);
  return new MergeEvidenceError(
    `Merge readiness withheld its authorization: ${executorOfflineDetail(executorRunnerIds)}`,
    {
      taskId: readinessTaskId,
      metadata: {
        kind: MERGE_TAIL_KIND.readiness,
        state: MERGE_EXECUTOR_OFFLINE_STATE,
        reason: MERGE_EXECUTOR_OFFLINE_REASON,
        executorRunnerIds: [...executorRunnerIds],
        episodeStartedAt: episodeStartedAt.toISOString(),
      },
    },
  );
};

/** Close the readiness outage episode in the same transaction as the live
 * operator renewal. The readiness worker cannot own this transition because
 * the confirmation card completes the readiness Task before this approval. */
const closeExecutorOfflineEpisode = async (tx: Tx, readinessTaskId: string): Promise<void> => {
  const marker = await tx.taskActivity.findFirst({
    where: {
      taskId: readinessTaskId,
      metadata: { path: ["state"], equals: MERGE_EXECUTOR_OFFLINE_STATE },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, metadata: true },
  });
  if (!marker) return;
  const metadata = marker.metadata as { episodeClosed?: unknown } | null;
  if (metadata?.episodeClosed === true) return;
  const updatedMetadata = (marker.metadata ?? {}) as Prisma.JsonObject;
  await tx.taskActivity.update({
    where: { id: marker.id },
    data: { metadata: { ...updatedMetadata, episodeClosed: true } },
  });
  await tx.taskActivity.create({ data: {
    taskId: readinessTaskId,
    actorType: "control-plane",
    body: "Merge readiness executor-offline episode ended: executor observed online during operator renewal",
    metadata: {
      kind: MERGE_TAIL_KIND.readiness,
      state: "executor-offline-closed",
      observation: "executor observed online during operator renewal",
    },
  } });
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
    /** Shared daemon observation used only for confirmation renewals. */
    executorLiveness?: MergeExecutorLivenessReader;
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
  // The gate signs a head *against a base*: the same tree merged onto a base
  // that has moved is a different merge, and the row records which base was
  // verified. `satisfied` alone would let an authorization inherit a signature
  // taken against another base, which is the one thing the mechanical channel
  // never does.
  if (attested.attestation && attested.attestation.baseHeadSha !== payload.baseSha) {
    throw new MergeEvidenceError(
      `${GATE_ATTESTATION_BASE_MISMATCH}: the gate signed ${payload.headSha} onto base `
      + `${attested.attestation.baseHeadSha}, but this authorization names base ${payload.baseSha}; approval refused`,
      { taskId: gateTaskId, metadata: {
        kind: GATE_ATTESTATION_BASE_MISMATCH,
        headSha: payload.headSha,
        attestedBaseSha: attested.attestation.baseHeadSha,
        authorizationBaseSha: payload.baseSha,
        channel: input.channel,
        inboxMessageId: input.card.id,
      } },
    );
  }

  if (purpose === "confirmation") {
    // A configured executor fleet with no observation is offline by default.
    // Callers must supply the shared daemon snapshot; an omitted reader must
    // never turn a renewal into an authorization written against a dead fleet.
    const allowlist = mergeExecutorRunnerIds();
    const blocked = mergeExecutorsBlockingAuthorization(input.executorLiveness?.() ?? [], allowlist);
    if (blocked.length > 0) throw await executorOfflineRefusal(tx, gateTaskId, blocked, now);
    await closeExecutorOfflineEpisode(tx, gateTaskId);
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
