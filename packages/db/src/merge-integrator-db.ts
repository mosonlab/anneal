/**
 * Merge Integrator v1.1 — the database-touching half of the shared module.
 *
 * Separate from `merge-integrator.ts` so that file stays pure and importable
 * from anywhere. Everything here takes a transaction client and performs *no*
 * network I/O: §D-P3's whole point is that reads of GitHub happen outside every
 * transaction, so a function in this file that called out would defeat it.
 */

import { randomUUID } from "node:crypto";

import {
  InboxDeliveryStatus,
  InboxSender,
  InboxStatus,
  Prisma,
  RunStatus,
  TaskStatus,
} from "@prisma/client";

import {
  EVIDENCE_PLACEHOLDER_BODY,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_STEP_INDEX,
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  FOLLOW_UP_CHOICES,
  BASE_DRIFT_CLASS_CEILING_CHOICES,
  STOP_CHOICES,
  type Disposition,
  type IntegratorStepShape,
  type StopChoice,
  type StopCondition,
  dispositionFor,
  followUpDispositionFor,
  githubRepositoryFromRemote,
  integratorBindingRefusal,
  stopChoicePayload,
  isCanonicalIntegratorStep,
  isIntegratorStep,
  isStopCondition,
  isTerminalDisposition,
  parseStopAnswerMetadata,
} from "./merge-integrator.js";
import { revalidateAfterClassCeiling } from "./merge-recovery-revalidate.js";

type Tx = Prisma.TransactionClient;

/** How long a Phase-A card is withheld from the outbox while Phase B fills it. */
export const evidenceDeadlineMs = (): number => {
  const raw = Number(process.env.EVIDENCE_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

// ---------------------------------------------------------------------------
// Locating the integrator step of a chain
// ---------------------------------------------------------------------------

const INTEGRATOR_INCLUDE = { templateStep: { include: { taskTemplate: { select: { name: true } } } } } as const;

export type IntegratorTask = Prisma.TaskGetPayload<{ include: typeof INTEGRATOR_INCLUDE }>;

/** True when this task row owns the Chain's integrator role. */
export const taskIsIntegratorStep = (task: IntegratorTask | null | undefined): boolean =>
  isIntegratorStep(task?.templateStep ?? null);

export const loadIntegratorTask = async (tx: Tx, taskId: string): Promise<IntegratorTask | null> =>
  tx.task.findUnique({ where: { id: taskId }, include: INTEGRATOR_INCLUDE });

/** The Chain's integrator task, or null when the Chain has no mechanical continuation. */
export const findChainIntegratorTask = async (
  tx: Tx,
  projectId: string,
  chainId: string | null,
): Promise<IntegratorTask | null> => {
  if (!chainId) return null;
  const candidates = await tx.task.findMany({
    where: { projectId, chainId },
    include: INTEGRATOR_INCLUDE,
    orderBy: { chainIndex: "asc" },
  });
  return candidates.find((task) => taskIsIntegratorStep(task)) ?? null;
};

/**
 * Does the successor of this gate task run mechanically? This is what turns the
 * two-phase evidence protocol on: an ordinary gate without that successor is
 * byte-for-byte unchanged.
 */
export const gateFeedsIntegratorStep = async (
  tx: Tx,
  gateTask: { projectId: string; chainId: string | null; chainIndex: number | null },
): Promise<IntegratorTask | null> => {
  if (!gateTask.chainId || gateTask.chainIndex === null) return null;
  const successor = await tx.task.findFirst({
    where: { projectId: gateTask.projectId, chainId: gateTask.chainId, chainIndex: { gt: gateTask.chainIndex } },
    include: INTEGRATOR_INCLUDE,
    orderBy: { chainIndex: "asc" },
  });
  return taskIsIntegratorStep(successor) ? successor : null;
};

// ---------------------------------------------------------------------------
// §D-P8 rule 3 — the chain target identity
// ---------------------------------------------------------------------------

export type ChainTarget =
  | { resolved: true; repository: string; prNumber: number; observed: number[]; correctionActivityId: string | null }
  | { resolved: false; unresolvable: "none" | "ambiguous" | "repository"; observed: number[] };

export type TargetCorrection = { activityId: string; prNumber: number; createdAt: Date };

/**
 * Every distinct non-null `Run.pullRequestNumber` this chain's own runs
 * recorded. Immutable history, so a client cannot move it — which is exactly
 * why MF-8 needed a separate, authenticated correction record rather than a
 * re-authorization.
 */
export const observedChainPullRequests = async (
  tx: Tx,
  projectId: string,
  chainId: string,
): Promise<number[]> => {
  const rows = await tx.run.findMany({
    where: { task: { projectId, chainId }, pullRequestNumber: { not: null } },
    select: { pullRequestNumber: true },
    distinct: ["pullRequestNumber"],
  });
  return [...new Set(rows.map((row) => row.pullRequestNumber!))].sort((left, right) => left - right);
};

export const latestTargetCorrection = async (
  tx: Tx,
  integratorTaskId: string,
): Promise<TargetCorrection | null> => {
  const rows = await tx.taskActivity.findMany({
    where: { taskId: integratorTaskId },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, metadata: true },
  });
  for (const row of rows) {
    const metadata = asRecord(row.metadata);
    if (metadata?.kind !== MERGE_INTEGRATOR_KIND.targetCorrection) continue;
    if (typeof metadata.prNumber !== "number") continue;
    return { activityId: row.id, prNumber: metadata.prNumber, createdAt: row.createdAt };
  }
  return null;
};

/**
 * Resolution rule (§D-P8 rule 3): exactly one observed value wins outright;
 * otherwise a correction may select among the observed set; anything else is
 * unresolvable. A correction whose PR has since left the observed set is
 * ignored rather than honoured, so a correction can never introduce a foreign
 * pull request.
 */
export const resolveChainTarget = async (
  tx: Tx,
  task: { projectId: string; chainId: string | null; repoId: string | null },
): Promise<ChainTarget> => {
  if (!task.chainId) return { resolved: false, unresolvable: "none", observed: [] };
  const observed = await observedChainPullRequests(tx, task.projectId, task.chainId);
  const repo = task.repoId ? await tx.repo.findUnique({ where: { id: task.repoId }, select: { remoteUrl: true } }) : null;
  const repository = repo ? githubRepositoryFromRemote(repo.remoteUrl) : null;
  if (!repository) return { resolved: false, unresolvable: "repository", observed };
  if (observed.length === 1) {
    return { resolved: true, repository, prNumber: observed[0]!, observed, correctionActivityId: null };
  }
  const integrator = await findChainIntegratorTask(tx, task.projectId, task.chainId);
  const correction = integrator ? await latestTargetCorrection(tx, integrator.id) : null;
  if (correction && observed.includes(correction.prNumber)) {
    return {
      resolved: true,
      repository,
      prNumber: correction.prNumber,
      observed,
      correctionActivityId: correction.activityId,
    };
  }
  return { resolved: false, unresolvable: observed.length === 0 ? "none" : "ambiguous", observed };
};

// ---------------------------------------------------------------------------
// §D-P7 — the stop state, keyed on terminal dispositions
// ---------------------------------------------------------------------------

export type RecordedStop = {
  stopId: string;
  condition: StopCondition;
  evidence: string;
  sourceRunId: string | null;
  createdAt: Date;
};

/**
 * One validity predicate for durable stopped-result history and stop landing.
 * Activity ingestion may accept arbitrary progress metadata, but an entry only
 * becomes guard-visible merge state when it satisfies the versioned result
 * contract in full. Keeping evidence and source ownership strict here prevents
 * a malformed SESSION activity from becoming a stop that ingestion correctly
 * declined to land.
 */
export type StoppedResultMetadata = {
  condition: StopCondition;
  evidence: string;
  sourceRunId: string | null;
};

export const parseStoppedResultMetadata = (value: unknown): StoppedResultMetadata | null => {
  const metadata = asRecord(value);
  if (
    metadata?.kind !== MERGE_INTEGRATOR_KIND.result
    || metadata.schemaVersion !== MERGE_INTEGRATOR_SCHEMA_VERSION
    || metadata.outcome !== "stopped"
    || !isStopCondition(metadata.condition)
    || typeof metadata.evidence !== "string"
    || !(metadata.sourceRunId === undefined
      || metadata.sourceRunId === null
      || typeof metadata.sourceRunId === "string")
  ) return null;
  return {
    condition: metadata.condition,
    evidence: metadata.evidence,
    sourceRunId: typeof metadata.sourceRunId === "string" ? metadata.sourceRunId : null,
  };
};

const RESULT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const ACTIVE_SOURCE_RUN_STATUSES = new Set<RunStatus>([
  RunStatus.QUEUED,
  RunStatus.CLAIMED,
  RunStatus.PROVISIONING,
  RunStatus.RUNNING,
  RunStatus.WAITING_INBOX,
]);

const isMergedResultMetadata = (value: unknown): boolean => {
  const metadata = asRecord(value);
  return metadata?.kind === MERGE_INTEGRATOR_KIND.result
    && metadata.schemaVersion === MERGE_INTEGRATOR_SCHEMA_VERSION
    && metadata.outcome === "merged"
    && typeof metadata.sourceRunId === "string"
    && typeof metadata.mergeCommitSha === "string"
    && RESULT_SHA_PATTERN.test(metadata.mergeCommitSha);
};

/**
 * The latest entry of the append-only `mergeIntegrator.result` history, but
 * only when it is a stop. Reading the history rather than the replaceable
 * `TaskStepOutput` is what stops a re-authorized run from erasing the stop the
 * guard is keyed on (Y1).
 */
export const latestRecordedStop = async (tx: Tx, integratorTaskId: string): Promise<RecordedStop | null> => {
  const rows = await tx.taskActivity.findMany({
    where: { taskId: integratorTaskId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true, metadata: true },
  });
  for (const row of rows) {
    const metadata = asRecord(row.metadata);
    if (metadata?.kind !== MERGE_INTEGRATOR_KIND.result) continue;
    const stopped = parseStoppedResultMetadata(row.metadata);
    if (stopped) return { stopId: row.id, ...stopped, createdAt: row.createdAt };
    // A valid merged result intentionally terminates an older stop. Malformed
    // rows have no authority and cannot erase the latest valid state.
    if (isMergedResultMetadata(row.metadata)) return null;
  }
  return null;
};

export const stopAnswerDispositions = async (
  tx: Tx,
  integratorTaskId: string,
  stopId: string,
): Promise<Disposition[]> => {
  const rows = await tx.taskActivity.findMany({
    where: { taskId: integratorTaskId },
    orderBy: { createdAt: "asc" },
    select: { metadata: true },
  });
  const found: Disposition[] = [];
  for (const row of rows) {
    const answer = parseStopAnswerMetadata(row.metadata);
    if (answer && answer.stopId === stopId) found.push(answer.disposition);
  }
  return found;
};

export type StopState = { stop: RecordedStop; dispositions: Disposition[] } | null;

/**
 * The one predicate every generic route composes (Step 5). It is a function of
 * the task row and its template step rather than of a route name, so a route
 * added later inherits the guard instead of quietly bypassing it.
 */
export const stopStateFor = async (tx: Tx, taskId: string): Promise<StopState> => {
  const task = await loadIntegratorTask(tx, taskId);
  if (!taskIsIntegratorStep(task)) return null;
  const stop = await latestRecordedStop(tx, taskId);
  if (!stop) return null;
  const dispositions = await stopAnswerDispositions(tx, taskId, stop.stopId);
  if (dispositions.some((disposition) => isTerminalDisposition(disposition))) return null;
  return { stop, dispositions };
};

export const stopStateRefusal = (state: NonNullable<StopState>): string =>
  `Merge integrator stopped on ${state.stop.condition}; answer the stop question before changing this task`;

// ---------------------------------------------------------------------------
// §D-P3 Phase A — request evidence and open a placeholder card
// ---------------------------------------------------------------------------

export type EvidencePurpose = "gate" | "confirmation";

export type EvidenceRequestResult = { cardId: string; nonce: string; activityId: string };

/**
 * Phase A. A pure database write in whichever process happens to be running:
 * `gateQuestion` runs inside `applyInboxDecisionTx` in the @anneal/inbox
 * process, which can reach neither the API's GitHub client nor its
 * configuration — MF-3's topology finding, which applies to the initial gate
 * exactly as it does to a renewal.
 *
 * The card is born OPEN with a placeholder body and a `nextDeliveryAt` in the
 * future, so the inbox outbox (`delivery.ts`, which selects `nextDeliveryAt <=
 * now`) cannot ship a card that says nothing yet.
 */
export const requestMergeEvidence = async (
  tx: Tx,
  input: {
    gateTaskId: string;
    integratorTaskId: string;
    sourceRunId: string;
    agentId: string;
    sessionId: string;
    threadId?: string | null;
    purpose: EvidencePurpose;
    repository: string;
    prNumber: number;
    dedupeKey: string;
  },
  now = new Date(),
): Promise<EvidenceRequestResult> => {
  const nonce = randomUUID();
  const card = await tx.inboxMessage.create({ data: {
    from: InboxSender.AGENT,
    agentId: input.agentId,
    sessionId: input.sessionId,
    taskId: input.gateTaskId,
    gateTaskId: input.gateTaskId,
    threadId: input.threadId ?? null,
    kind: "MULTIPLE_CHOICE",
    body: EVIDENCE_PLACEHOLDER_BODY,
    choices: [{ id: "approve", label: "批准并合并" }, { id: "reject", label: "打回上一步" }],
    dedupeKey: input.dedupeKey,
    deliveryStatus: InboxDeliveryStatus.PENDING,
    nextDeliveryAt: new Date(now.getTime() + evidenceDeadlineMs()),
  } });
  const activity = await tx.taskActivity.create({ data: {
    taskId: input.gateTaskId,
    // Not client-producible: POST /tasks/:taskId/activity forces "operator" and
    // the fenced session write stamps the principal kind. Only server-internal
    // code writes control-plane rows.
    actorType: "control-plane",
    body: `Merge evidence requested for PR #${input.prNumber} (${input.purpose})`,
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.evidenceRequest,
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      nonce,
      gateTaskId: input.gateTaskId,
      integratorTaskId: input.integratorTaskId,
      repository: input.repository,
      prNumber: input.prNumber,
      cardId: card.id,
      purpose: input.purpose,
      requestedAt: now.toISOString(),
      sourceRunId: input.sourceRunId,
    },
  } });
  return { cardId: card.id, nonce, activityId: activity.id };
};

export type PendingEvidenceRequest = {
  activityId: string;
  gateTaskId: string;
  integratorTaskId: string;
  cardId: string;
  nonce: string;
  repository: string;
  prNumber: number;
  purpose: EvidencePurpose;
};

export const parseEvidenceRequest = (
  row: { id: string; taskId: string; metadata: Prisma.JsonValue | null },
): PendingEvidenceRequest | null => {
  const metadata = asRecord(row.metadata);
  if (metadata?.kind !== MERGE_INTEGRATOR_KIND.evidenceRequest) return null;
  if (metadata.schemaVersion !== MERGE_INTEGRATOR_SCHEMA_VERSION) return null;
  const { nonce, cardId, repository, prNumber, purpose, integratorTaskId } = metadata;
  if (typeof nonce !== "string" || typeof cardId !== "string" || typeof repository !== "string") return null;
  if (typeof prNumber !== "number" || typeof integratorTaskId !== "string") return null;
  if (purpose !== "gate" && purpose !== "confirmation") return null;
  return {
    activityId: row.id,
    gateTaskId: row.taskId,
    integratorTaskId,
    cardId,
    nonce,
    repository,
    prNumber,
    purpose,
  };
};

/** The evidence request whose nonce a filled card carries. Resolves a card's purpose durably. */
export const findEvidenceRequestByNonce = async (
  tx: Tx,
  gateTaskId: string,
  nonce: string,
): Promise<PendingEvidenceRequest | null> => {
  const rows = await tx.taskActivity.findMany({
    where: { taskId: gateTaskId },
    orderBy: { createdAt: "desc" },
    select: { id: true, taskId: true, metadata: true },
  });
  for (const row of rows) {
    const request = parseEvidenceRequest(row);
    if (request?.nonce === nonce) return request;
  }
  return null;
};

/** Marks every still-OPEN question on the integrator task closed. Used when a disposition is terminal. */
export const closeIntegratorQuestions = async (tx: Tx, integratorTaskId: string): Promise<void> => {
  await tx.inboxMessage.updateMany({
    where: { taskId: integratorTaskId, status: InboxStatus.OPEN },
    data: { status: InboxStatus.CLOSED },
  });
};

/**
 * Shared terminal settlement for an operator-closing merge integrator. Both a
 * stopped merge answer and a merge-gate rejection use this disposition: all
 * integrator questions close, an explicit merge-result account is persisted,
 * and the mechanical task becomes terminal without opening another Run.
 */
export const settleIntegratorTerminal = async (
  tx: Tx,
  input: { integratorTaskId: string; outputBody: string; activityBody: string },
): Promise<void> => {
  await closeIntegratorQuestions(tx, input.integratorTaskId);
  await tx.taskStepOutput.upsert({
    where: { taskId: input.integratorTaskId },
    create: { taskId: input.integratorTaskId, kind: INTEGRATOR_OUTPUT_KIND, body: input.outputBody },
    update: { body: input.outputBody },
  });
  await tx.task.update({
    where: { id: input.integratorTaskId },
    data: { status: TaskStatus.DONE, failureReason: null },
  });
  await tx.taskActivity.create({ data: {
    taskId: input.integratorTaskId,
    actorType: "control-plane",
    body: input.activityBody,
  } });
};

// ---------------------------------------------------------------------------
// §D-P7 — stop questions, follow-ups, and the answer transaction
// ---------------------------------------------------------------------------

/**
 * A stop question is identified by the `mergeIntegrator.result` activity that
 * recorded the stop. `InboxMessage` has no metadata column, so the binding
 * rides in `dedupeKey` — a server-written column with a unique constraint,
 * which additionally makes opening the same stop's question twice impossible
 * rather than merely unlikely.
 */
export const STOP_QUESTION_PREFIX = "merge-stop";
export const FOLLOW_UP_QUESTION_PREFIX = "merge-stop-followup";

/**
 * A stop asks its question once. A base-drift recovery an operator resumed with
 * `re-validate` can settle again, so its later questions carry a generation
 * suffix; generation zero keeps the historical key exactly. Stop ids are cuids
 * and never contain a colon, so the binding is the segment after the prefix.
 */
export const stopQuestionKey = (stopId: string, generation = 0): string => (
  generation > 0 ? `${STOP_QUESTION_PREFIX}:${stopId}:r${String(generation)}` : `${STOP_QUESTION_PREFIX}:${stopId}`
);
export const followUpQuestionKey = (stopId: string): string => `${FOLLOW_UP_QUESTION_PREFIX}:${stopId}`;

export type StopQuestionBinding = { stopId: string; followUp: boolean };

export const parseStopQuestionKey = (dedupeKey: string | null | undefined): StopQuestionBinding | null => {
  if (!dedupeKey) return null;
  if (dedupeKey.startsWith(`${FOLLOW_UP_QUESTION_PREFIX}:`)) {
    return { stopId: dedupeKey.slice(FOLLOW_UP_QUESTION_PREFIX.length + 1), followUp: true };
  }
  if (dedupeKey.startsWith(`${STOP_QUESTION_PREFIX}:`)) {
    const [stopId] = dedupeKey.slice(STOP_QUESTION_PREFIX.length + 1).split(":");
    return stopId ? { stopId, followUp: false } : null;
  }
  return null;
};

const stopQuestionBody = (condition: StopCondition, evidence: string, followUp: boolean): string => [
  followUp ? `合并事故待结案：${condition}` : `机械合并已停止：${condition}`,
  "",
  evidence.trim() || "（执行器未记录额外证据）",
  "",
  followUp
    ? "这一步仍未结案。接受他人已完成的合并，或放弃本链。"
    : "在你回答之前，这个任务不会重试、不会推进，也不会被改状态。",
].join("\n");

/**
 * Opens the question a recorded stop lands in. Returns null when one already
 * exists for this stop, which is what makes a replayed completion idempotent.
 */
export const openStopQuestion = async (
  tx: Tx,
  input: {
    integratorTaskId: string;
    stopId: string;
    condition: StopCondition;
    evidence: string;
    agentId: string;
    sessionId: string | null;
    followUp?: boolean;
    /** The offering this settle opens, when it is wider than the condition's default. */
    choices?: StopChoice[];
    generation?: number;
  },
): Promise<{ id: string } | null> => {
  const followUp = input.followUp ?? false;
  const dedupeKey = followUp
    ? followUpQuestionKey(input.stopId)
    : stopQuestionKey(input.stopId, input.generation ?? 0);
  const existing = await tx.inboxMessage.findFirst({ where: { dedupeKey } });
  if (existing) return null;
  const choices = followUp ? FOLLOW_UP_CHOICES : input.choices ?? STOP_CHOICES[input.condition];
  const card = await tx.inboxMessage.create({ data: {
    from: InboxSender.AGENT,
    agentId: input.agentId,
    sessionId: input.sessionId,
    taskId: input.integratorTaskId,
    kind: "MULTIPLE_CHOICE",
    body: stopQuestionBody(input.condition, input.evidence, followUp),
    choices: stopChoicePayload(choices),
    dedupeKey,
  } });
  return { id: card.id };
};

type StopResultActivity = {
  id: string;
  taskId: string;
  createdAt: Date;
  actorType: string;
  actorId: string | null;
  metadata: Prisma.JsonValue | null;
};

/**
 * The newest valid result activity for one source Run. Malformed rows and
 * results owned by another Run have no authority over this Run's completion;
 * a valid merged result for the same Run intentionally terminates its stop.
 */
const latestValidResultActivity = async (
  tx: Tx,
  integratorTaskId: string,
  sourceRunId: string,
): Promise<StopResultActivity | null> => {
  const rows = await tx.taskActivity.findMany({
    where: { taskId: integratorTaskId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, taskId: true, createdAt: true, actorType: true, actorId: true, metadata: true },
  });
  for (const row of rows) {
    const stopped = parseStoppedResultMetadata(row.metadata);
    if (stopped?.sourceRunId === sourceRunId) return row;
    const metadata = asRecord(row.metadata);
    if (isMergedResultMetadata(row.metadata) && metadata?.sourceRunId === sourceRunId) return null;
  }
  return null;
};

/**
 * Resolve the identities attached to a stop question. A source Run is the
 * durable owner of the Agent and Session, not caller-supplied strings. New
 * production writers stamp the source Run. For historical source-less rows,
 * repair uses the newest Session-bearing Run on the same Task rather than an
 * identity guessed by its caller.
 */
const stopQuestionIdentity = async (
  tx: Tx,
  task: IntegratorTask,
  stop: { sourceRunId: string | null },
): Promise<{ agentId: string; sessionId: string }> => {
  const select = { taskId: true, agentId: true, session: { select: { id: true } } } as const;
  const sourceRun = stop.sourceRunId
    ? await tx.run.findUnique({ where: { id: stop.sourceRunId }, select })
    : await tx.run.findFirst({
        where: { taskId: task.id, session: { isNot: null } },
        orderBy: [{ runNumber: "desc" }, { createdAt: "desc" }],
        select,
      });
  if (!sourceRun) {
    throw new Error(`Merge stop on task ${task.id} has no durable Session-bearing Run identity`);
  }
  if (sourceRun.taskId !== task.id) {
    throw new Error(`Merge stop ${stop.sourceRunId} is not owned by integrator task ${task.id}`);
  }
  if (!sourceRun.session) {
    throw new Error(`Merge stop source Run ${stop.sourceRunId} has no Session identity`);
  }
  return { agentId: sourceRun.agentId, sessionId: sourceRun.session.id };
};

/** The single deferred base-drift question surface, with durable Run identity. */
export const openDeferredBaseDriftQuestion = async (
  tx: Tx,
  integratorTaskId: string,
  stopId: string,
  card: { revalidations: number; ceiling: boolean },
) => {
  const task = await loadIntegratorTask(tx, integratorTaskId);
  const stop = await latestRecordedStop(tx, integratorTaskId);
  if (!task || stop?.stopId !== stopId || stop.condition !== "base-drift") {
    throw new Error(`Cannot open the settled base-drift question for unresolved stop ${stopId}`);
  }
  const identity = await stopQuestionIdentity(tx, task, stop);
  return openStopQuestion(tx, {
    integratorTaskId, stopId, condition: "base-drift", evidence: stop.evidence,
    ...identity, generation: card.revalidations,
    ...(card.ceiling ? { choices: BASE_DRIFT_CLASS_CEILING_CHOICES } : {}),
  });
};

export type IntegratorStopLandingInput = {
  integratorTaskId: string;
  /** Existing append-only result activity to adopt. */
  resultActivityId?: string | null;
  /** Required only when creating a result activity. */
  condition?: StopCondition;
  evidence?: string;
  sourceRunId?: string | null;
};

export type IntegratorStopLandingResult = {
  stopId: string;
  /** Non-null only when this call inserted the question. */
  questionId: string | null;
  /** True when this call created the result activity rather than adopting one. */
  resultCreated: boolean;
  /** True when this is the ordinary canonical base-drift worker handoff. */
  questionDeferred: boolean;
};

/**
 * Land one stopped `mergeIntegrator.result` under the integrator Task mutex.
 *
 * The caller supplies a transaction client, and this function takes the Task
 * row lock before reading or writing anything else. It accepts either the
 * exact append-only activity already written by a fenced Session or no activity
 * (in which case it adopts the newest same-Run stopped result, or creates the
 * control-plane result). The activity's condition/evidence/sourceRunId remain
 * authoritative; only the new-result branch uses the input payload.
 *
 * For a canonical ordinary `base-drift`, the Task transition still lands here,
 * but the question remains deferred to the existing recovery worker. Every
 * other condition gets its condition-specific question before this transaction
 * may commit. Consequently an Inbox failure rolls back a newly-created result
 * and the REVIEW transition together with the caller's transaction.
 */
export const landIntegratorStop = async (
  tx: Tx,
  input: IntegratorStopLandingInput,
): Promise<IntegratorStopLandingResult> => {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task" WHERE "id" = ${input.integratorTaskId} FOR UPDATE
  `;
  if (!locked[0]) throw new Error(`Merge integrator task ${input.integratorTaskId} no longer exists`);
  const task = await loadIntegratorTask(tx, input.integratorTaskId);
  if (!task || !taskIsIntegratorStep(task)) {
    throw new Error(`Task ${input.integratorTaskId} is not a merge integrator step`);
  }

  let activity: StopResultActivity | null = null;
  let resultCreated = false;
  if (input.resultActivityId) {
    activity = await tx.taskActivity.findUnique({
      where: { id: input.resultActivityId },
      select: { id: true, taskId: true, createdAt: true, actorType: true, actorId: true, metadata: true },
    });
    if (!activity) throw new Error(`Merge stop result activity ${input.resultActivityId} no longer exists`);
    if (activity.taskId !== task.id) {
      throw new Error(`Merge stop result activity ${input.resultActivityId} belongs to another task`);
    }
  } else if (input.sourceRunId) {
    const latest = await latestValidResultActivity(tx, task.id, input.sourceRunId);
    const parsed = latest ? parseStoppedResultMetadata(latest.metadata) : null;
    if (latest && parsed?.sourceRunId === input.sourceRunId) activity = latest;
  }

  if (!activity) {
    if (!isStopCondition(input.condition)) {
      throw new Error(`Cannot record merge stop without a known condition for task ${task.id}`);
    }
    if (typeof input.evidence !== "string") {
      throw new Error(`Cannot record merge stop ${input.condition} without evidence`);
    }
    if (!input.sourceRunId) {
      throw new Error(`Cannot record merge stop ${input.condition} without a source Run`);
    }
    const sourceRunId = input.sourceRunId;
    const created = await tx.taskActivity.create({ data: {
      taskId: task.id,
      actorType: "control-plane",
      body: `Mechanical merge stopped: ${input.condition}`,
      metadata: {
        kind: MERGE_INTEGRATOR_KIND.result,
        schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
        outcome: "stopped",
        condition: input.condition,
        evidence: input.evidence,
        sourceRunId,
      },
    } });
    activity = {
      id: created.id,
      taskId: task.id,
      createdAt: created.createdAt,
      actorType: created.actorType,
      actorId: created.actorId,
      metadata: created.metadata,
    };
    resultCreated = true;
  }

  const stopped = parseStoppedResultMetadata(activity.metadata);
  if (!stopped) {
    throw new Error(`Merge result activity ${activity.id} is not a valid stopped result`);
  }
  // A terminal answer is the state-machine's durable idempotency marker. A
  // replay must not reopen the Task or manufacture a second question after
  // the operator has already closed this stop.
  const dispositions = await stopAnswerDispositions(tx, task.id, activity.id);
  if (dispositions.some((disposition) => isTerminalDisposition(disposition))) {
    return {
      stopId: activity.id,
      questionId: null,
      resultCreated,
      questionDeferred: stopped.condition === "base-drift" && isCanonicalIntegratorStep(task.templateStep),
    };
  }
  const questionDeferred = stopped.condition === "base-drift" && isCanonicalIntegratorStep(task.templateStep);
  const sourceRunIsActive = questionDeferred && stopped.sourceRunId
    ? await tx.run.findUnique({ where: { id: stopped.sourceRunId }, select: { taskId: true, status: true } })
      .then((sourceRun) => {
        if (!sourceRun) throw new Error(`Merge stop source Run ${stopped.sourceRunId} no longer exists`);
        if (sourceRun.taskId !== task.id) {
          throw new Error(`Merge stop ${stopped.sourceRunId} is not owned by integrator task ${task.id}`);
        }
        return ACTIVE_SOURCE_RUN_STATUSES.has(sourceRun.status);
      })
    : false;
  if (!sourceRunIsActive) {
    await tx.task.update({
      where: { id: task.id },
      data: { status: TaskStatus.REVIEW, failureReason: `Mechanical merge stopped: ${stopped.condition}` },
    });
  }

  const question = questionDeferred ? null : await (async () => {
    const identity = await stopQuestionIdentity(tx, task, stopped);
    return openStopQuestion(tx, {
      integratorTaskId: task.id,
      stopId: activity.id,
      condition: stopped.condition,
      evidence: stopped.evidence,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
    });
  })();
  return {
    stopId: activity.id,
    questionId: question?.id ?? null,
    resultCreated,
    questionDeferred,
  };
};

export type StopAnswerOutcome = {
  disposition: Disposition;
  condition: StopCondition;
  stopId: string;
  integratorTaskId: string;
  followUpQuestionId?: string | null;
  confirmationCardId?: string | null;
};

/**
 * §D-P7's answer transaction. Every exit from a stop runs through here, and the
 * guard downstream keys on the *disposition* this writes rather than on the
 * answer merely existing — which is the whole of C3: `flag-incident` records an
 * answer and still leaves the chain guarded.
 */
export const applyStopAnswer = async (
  tx: Tx,
  input: {
    question: { id: string; taskId: string | null; dedupeKey: string | null; agentId: string | null; sessionId: string | null };
    choice: string;
    now?: Date;
  },
): Promise<StopAnswerOutcome | null> => {
  const binding = parseStopQuestionKey(input.question.dedupeKey);
  if (!binding || !input.question.taskId) return null;
  const now = input.now ?? new Date();
  const task = await loadIntegratorTask(tx, input.question.taskId);
  if (!task || !taskIsIntegratorStep(task)) return null;
  const stop = await tx.taskActivity.findUnique({ where: { id: binding.stopId }, select: { metadata: true } });
  const stopMetadata = asRecord(stop?.metadata);
  const condition = stopMetadata?.condition;
  if (!isStopCondition(condition)) return null;
  const disposition = binding.followUp
    ? followUpDispositionFor(input.choice)
    : dispositionFor(condition, input.choice);
  if (!disposition) throw new Error(`Choice ${input.choice} is not offered for stop condition ${condition}`);

  await tx.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "operator",
    body: `Merge stop ${condition} answered: ${input.choice}`,
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.stopAnswer,
      schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
      stopId: binding.stopId,
      condition,
      choice: input.choice,
      disposition,
      followUp: binding.followUp,
      answeredAt: now.toISOString(),
    },
  } });

  const outcome: StopAnswerOutcome = {
    disposition, condition, stopId: binding.stopId, integratorTaskId: task.id,
    followUpQuestionId: null, confirmationCardId: null,
  };

  if (disposition === "nonterminal") {
    // C3's resolution: the incident stays open, and the later exits the SPEC
    // promised are actually offered rather than merely described.
    const followUp = await openStopQuestion(tx, {
      integratorTaskId: task.id,
      stopId: binding.stopId,
      condition,
      evidence: `已标记为事故（${condition}）。本链仍未结案。`,
      agentId: input.question.agentId ?? task.assigneeAgentId!,
      sessionId: input.question.sessionId,
      followUp: true,
    });
    outcome.followUpQuestionId = followUp?.id ?? null;
    return outcome;
  }

  if (disposition === "refresh-requested") {
    // Evidence precedes judgment (C2): this creates no run and writes no
    // authorization. It asks for a card the human will read and then approve.
    outcome.confirmationCardId = await requestConfirmationCard(tx, task, binding.stopId, now);
    return outcome;
  }

  if (disposition === "repair-requested") {
    // Nothing further until POST /tasks/:taskId/merge-target lands a correction.
    return outcome;
  }

  if (disposition === "revalidation-requested") {
    // The class ceiling's resume: reset the exhausted class and hand the
    // recovery back to the worker. Nothing merges, and no other class moves.
    await revalidateAfterClassCeiling(tx, { integratorTaskId: task.id, sourceStopId: binding.stopId });
    return outcome;
  }

  const abandoned = disposition === "terminal-abandoned";
  const body = abandoned
    ? `Chain abandoned after merge stop ${condition}. No merge was performed by this contract.`
    : `Merge stop ${condition} closed by operator decision: ${input.choice}.`;
  await settleIntegratorTerminal(tx, {
    integratorTaskId: task.id,
    outputBody: body,
    activityBody: abandoned
      ? `Chain abandoned; step ${INTEGRATOR_STEP_INDEX} closed without a merge (${condition})`
      : `Chain complete; step ${INTEGRATOR_STEP_INDEX} closed by operator decision (${condition})`,
  });
  return outcome;
};

/** Refusals raised while resolving the gate, target, or source of confirmation evidence. */
export class MergeConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeConfirmationError";
  }
}

export const isMergeConfirmationError = (error: unknown): error is MergeConfirmationError =>
  error instanceof Error && error.name === "MergeConfirmationError";

/**
 * The confirmation card a renewal or repair asks for. The card is bound to the
 * immediate same-chain predecessor that feeds the integrator, while its agent,
 * Session and source Run come from the newest eligible same-chain predecessor.
 * Keeping those identities separate lets server-owned readiness steps share the
 * normal authorization path without pretending they executed an agent Run.
 */
export const requestConfirmationCard = async (
  tx: Tx,
  integratorTask: IntegratorTask,
  stopId: string,
  now = new Date(),
): Promise<string> => {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task" WHERE "id" = ${integratorTask.id} FOR UPDATE
  `;
  if (!locked[0]) throw new MergeConfirmationError(`Merge integrator task ${integratorTask.id} no longer exists`);
  return ensureConfirmationCard(tx, integratorTask, stopId, now);
};

const confirmationKey = (integratorTaskId: string, stopId: string): string =>
  `confirmation:${integratorTaskId}:${stopId}`;

/**
 * The integrator Task mutex serializes the initial request and every replay or
 * control-plane repair. The Inbox card's unique dedupe key is the durable backstop;
 * taking the lock also lets every successful caller return the winner instead
 * of surfacing a uniqueness race.
 */
const ensureConfirmationCard = async (
  tx: Tx,
  integratorTask: IntegratorTask,
  stopId: string,
  now: Date,
): Promise<string> => {
  if (!integratorTask.chainId || integratorTask.chainIndex === null) {
    throw new MergeConfirmationError(
      `Merge integrator task ${integratorTask.id} has no chain identity for confirmation evidence`,
    );
  }
  const dedupeKey = confirmationKey(integratorTask.id, stopId);
  const existing = await tx.inboxMessage.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing) return existing.id;

  const target = await resolveChainTarget(tx, integratorTask);
  if (!target.resolved) {
    throw new MergeConfirmationError(
      `Merge confirmation target for task ${integratorTask.id} is ${target.unresolvable}; refusing unrelated evidence`,
    );
  }
  const predecessors = await tx.task.findMany({
    where: {
      projectId: integratorTask.projectId,
      chainId: integratorTask.chainId,
      chainIndex: { lt: integratorTask.chainIndex },
    },
    include: {
      templateStep: { include: { taskTemplate: { select: { name: true } } } },
      runs: {
        where: { session: { isNot: null } },
        include: { session: { select: { id: true } } },
        orderBy: [{ runNumber: "desc" }, { createdAt: "desc" }],
        take: 1,
      },
    },
    orderBy: { chainIndex: "desc" },
  });
  const gate = predecessors[0];
  if (!gate) {
    throw new MergeConfirmationError(
      `Merge confirmation for task ${integratorTask.id} has no immediate same-chain predecessor`,
    );
  }
  const sourceTask = predecessors.find(
    (candidate) => !taskIsIntegratorStep(candidate) && candidate.runs[0]?.session,
  );
  const source = sourceTask?.runs[0];
  if (!sourceTask || !source?.session) {
    throw new MergeConfirmationError(
      `Merge confirmation for task ${integratorTask.id} has no preceding same-chain Run with a Session`,
    );
  }
  const requested = await requestMergeEvidence(tx, {
    gateTaskId: gate.id,
    integratorTaskId: integratorTask.id,
    sourceRunId: source.id,
    agentId: source.agentId,
    sessionId: source.session.id,
    purpose: "confirmation",
    repository: target.repository,
    prNumber: target.prNumber,
    dedupeKey,
  }, now);
  return requested.cardId;
};

/**
 * Repairs the historical state in which the append-only stop answer says
 * refresh-requested but its Phase-A confirmation request is absent. This is
 * deliberately a no-op for every other stop disposition and for a request
 * that already exists.
 */
export const recoverRefreshRequestedConfirmationCard = async (
  tx: Tx,
  integratorTaskId: string,
  now = new Date(),
): Promise<string | null> => {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task" WHERE "id" = ${integratorTaskId} FOR UPDATE
  `;
  if (!locked[0]) throw new Error(`Merge integrator task ${integratorTaskId} no longer exists`);
  const task = await loadIntegratorTask(tx, integratorTaskId);
  if (!task || !taskIsIntegratorStep(task)) {
    throw new Error(`Task ${integratorTaskId} is not a merge integrator step`);
  }
  const state = await stopStateFor(tx, integratorTaskId);
  if (!state || !state.dispositions.includes("refresh-requested")) return null;
  return ensureConfirmationCard(tx, task, state.stop.stopId, now);
};

/**
 * Records a stop the executor reported and lands the control-plane stop state.
 * Ordinary base drift is left for the server recovery worker; every other stop
 * opens the evidence-backed question its condition supports.
 */
export const recordIntegratorStop = async (
  tx: Tx,
  input: {
    integratorTaskId: string;
    condition: StopCondition;
    evidence: string;
    sourceRunId: string;
  },
): Promise<{ stopId: string; questionId: string | null }> => {
  const landed = await landIntegratorStop(tx, input);
  return { stopId: landed.stopId, questionId: landed.questionId };
};

// ---------------------------------------------------------------------------
// §D-P4 — the binding invariant, enforced at every surface that binds an Agent
// to a step
// ---------------------------------------------------------------------------

/**
 * Thrown rather than returned, because the callers that need this most are the
 * ones inside a transaction (`enqueueTaskRun`, template instantiation): a
 * returned refusal there is a value someone can forget to check, and a forgotten
 * check here means the sentinel Agent becomes dispatchable as a model agent.
 */
export class IntegratorBindingError extends Error {
  constructor(readonly refusal: string) {
    super(refusal);
    this.name = "IntegratorBindingError";
  }
}

export const isIntegratorBindingError = (error: unknown): error is IntegratorBindingError =>
  error instanceof Error && error.name === "IntegratorBindingError";

type BindingSubject = {
  assigneeAgentId?: string | null;
  assigneeAgentName?: string | null;
  templateStepId?: string | null;
  templateStep?: { stepIndex: number; outputKind: string; taskTemplate?: { name: string } | null } | null;
};

/**
 * Resolve whatever the caller has — ids, rows, or a mix — into the (agent name,
 * template step) pair the pure predicate needs, then apply it. Reads only; the
 * caller decides whether to refuse with a 400 or to throw.
 */
export const integratorBindingRefusalFor = async (
  tx: Tx,
  subject: BindingSubject,
): Promise<string | null> => {
  const agentName = subject.assigneeAgentName !== undefined
    ? subject.assigneeAgentName
    : subject.assigneeAgentId
      ? (await tx.agent.findUnique({ where: { id: subject.assigneeAgentId }, select: { name: true } }))?.name ?? null
      : null;
  const step = subject.templateStep !== undefined
    ? subject.templateStep
    : subject.templateStepId
      ? await tx.taskTemplateStep.findUnique({
        where: { id: subject.templateStepId },
        select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
      })
      : null;
  return integratorBindingRefusal(agentName, step);
};

/**
 * What the claim route hands the caller, and what the ordinary runner refuses.
 * Derived from the template step alone: nothing a client sends participates.
 */
export type ExecutionMode = "mechanical" | "agent";

export const executionModeFor = (step: IntegratorStepShape): ExecutionMode =>
  isIntegratorStep(step) ? "mechanical" : "agent";

/**
 * The runner ids permitted to claim integrator runs — and, symmetrically,
 * permitted to claim nothing else. Empty by default, so an unconfigured
 * deployment hands out no integrator run at all rather than handing one to the
 * ordinary runner.
 */
export const mergeExecutorRunnerIds = (raw = process.env.MERGE_EXECUTOR_RUNNER_IDS): string[] =>
  (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);

export const isMergeExecutorRunnerId = (runnerId: string, allowlist = mergeExecutorRunnerIds()): boolean =>
  allowlist.includes(runnerId);

/**
 * The authenticated class of a caller on the runner protocol. This is derived
 * from the bearer the caller presented, never from anything in a request body:
 * `runnerId` is a self-reported label and carries no authority.
 */
export type ClaimantClass = "merge-executor" | "runner";

/**
 * §D-P1 rule 3, as one predicate both directions of the rule share. A claim is
 * offered a candidate only when the candidate's execution mode and the claiming
 * principal's class agree; either mismatch skips the candidate rather than
 * rejecting the claim, so an ordinary runner polling while an integrator run
 * waits simply sees nothing.
 *
 * The principal decides. The `MERGE_EXECUTOR_RUNNER_IDS` allowlist is kept as a
 * second, independent condition on mechanical work — an executor credential
 * carried into a process that the deployment has not published as an executor
 * still takes no integrator run — and, in the other direction, an id the
 * deployment *has* published may not be borrowed by an ordinary runner. With
 * the allowlist empty (the shipped default) no integrator run is claimable by
 * anyone, whatever credential is presented.
 */
export const claimantMayTake = (
  mode: ExecutionMode,
  claimant: ClaimantClass,
  runnerId: string,
  allowlist = mergeExecutorRunnerIds(),
): boolean => {
  if ((mode === "mechanical") !== (claimant === "merge-executor")) return false;
  return (mode === "mechanical") === isMergeExecutorRunnerId(runnerId, allowlist);
};

/**
 * Why a caller may not act on a run of this execution mode, or `null` when it
 * may. Shared by every runner-protocol route that finishes mechanical work, so
 * that "the executor claimed it" and "the executor completed it" are the same
 * fact about the same credential rather than two independent string checks.
 */
export const mechanicalPrincipalRefusal = (
  mode: ExecutionMode,
  claimant: ClaimantClass,
  runnerId: string,
  allowlist = mergeExecutorRunnerIds(),
): string | null => {
  if (mode === "mechanical" && claimant !== "merge-executor") {
    return "A mechanical run may only be acted on by the merge-executor principal";
  }
  if (mode !== "mechanical" && claimant === "merge-executor") {
    return "The merge-executor principal may only act on mechanical runs";
  }
  if (mode === "mechanical" && !isMergeExecutorRunnerId(runnerId, allowlist)) {
    return "Runner id is not an allowlisted merge executor";
  }
  return null;
};
