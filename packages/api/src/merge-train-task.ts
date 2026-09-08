import {
  errorForOpenRunRefusal,
  MERGE_TAIL_SCHEMA_VERSION,
  openRun,
  readLatestMarker,
  parseMergeTrainMarker,
  Prisma,
  TaskStatus,
  type MergeTrainCandidate,
  type MergeTrainWidth,
  writeMarker,
} from "@anneal/db";

type DbTx = Prisma.TransactionClient;

/** The control-plane input used to create one detached merge-train card. */
export type MergeTrainTaskInput = {
  /** The Regression verification Task that staffed the first candidate. */
  regressionTaskId: string;
  baseSha: string;
  width: number;
  candidates: readonly MergeTrainCandidate[];
  now: Date;
};

export type MergeTrainTaskResult = { taskId: string };

const SHA = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const validBranch = (value: string): boolean => value.length > 0 && !/\s/u.test(value)
  && [...value].every((character) => character.charCodeAt(0) > 0x20 && character.charCodeAt(0) !== 0x7f);

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

/**
 * Render the detached card's complete runtime instruction. The JSON is
 * repeated in a bounded code block so the board remains useful after the
 * Run settles, while the command remains executable by the Runner exactly as
 * the task contract requires.
 */
export const mergeTrainTaskDescription = (input: {
  baseSha: string;
  width: number;
  candidates: readonly MergeTrainCandidate[];
}): string => {
  const payload = {
    schemaVersion: MERGE_TAIL_SCHEMA_VERSION,
    baseSha: input.baseSha,
    width: input.width,
    candidates: input.candidates,
  };
  const encoded = JSON.stringify(payload);
  return [
    "This is a detached merge-train task.",
    "Run only the exact command below, then finish. Do not edit files or perform any other work.",
    `printf '%s' ${shellQuote(encoded)} | \"\${AGENTOS_TOOLS}/merge-train.sh\"`,
    "",
    "Merge-train input:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
};

const invalid = (detail: string): never => {
  throw new Error(`Cannot create merge-train task: ${detail}`);
};

const validateInput = (input: MergeTrainTaskInput): MergeTrainWidth => {
  if (!SHA.test(input.baseSha)) invalid("baseSha is not a lowercase 40-character commit SHA");
  if (!Number.isInteger(input.width) || input.width < 1 || input.width > 3) {
    invalid("width must be an integer from 1 through 3");
  }
  if (!Array.isArray(input.candidates) || input.candidates.length === 0 || input.candidates.length > input.width) {
    invalid("candidates must be a non-empty list no wider than width");
  }
  const taskIds = new Set<string>();
  const chainIds = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate || typeof candidate !== "object"
      || typeof candidate.taskId !== "string" || candidate.taskId.trim().length === 0
      || taskIds.has(candidate.taskId)
      || !UUID.test(candidate.chainId)
      || chainIds.has(candidate.chainId)
      || !SHA.test(candidate.headSha)
      || typeof candidate.branch !== "string" || !validBranch(candidate.branch)) {
      invalid("candidates contain a duplicate or malformed task, chain, head, or branch binding");
    }
    taskIds.add(candidate.taskId);
    chainIds.add(candidate.chainId);
  }
  return input.width as MergeTrainWidth;
};

/**
 * Persist a chain-detached reservation before external lease acquisition.
 * The caller owns the repository and candidate chain locks; this function
 * performs every task, Run, and marker write in that caller's transaction.
 */
export const reserveMergeTrainTask = async (
  tx: DbTx,
  input: MergeTrainTaskInput,
): Promise<MergeTrainTaskResult> => {
  const width = validateInput(input);
  const first = input.candidates[0]!;

  const regressionTask = await tx.task.findUnique({
    where: { id: input.regressionTaskId },
    include: { repo: true, assigneeAgent: true },
  });
  if (!regressionTask) {
    throw new Error(`Cannot create merge-train task: Regression Task ${input.regressionTaskId} is absent`);
  }
  const repo = regressionTask.repo;
  const agent = regressionTask.assigneeAgent;
  const { projectId, repoId, chainId, assigneeAgentId } = regressionTask;
  if (!repoId || !repo || !chainId) {
    throw new Error(`Cannot create merge-train task: Regression Task ${input.regressionTaskId} has no repository or chain binding`);
  }
  if (!assigneeAgentId || !agent) {
    throw new Error(`Cannot create merge-train task: Regression Task ${input.regressionTaskId} has no Agent assignee`);
  }
  if (first.chainId !== chainId) {
    invalid("the first candidate is not on the Regression Task's chain");
  }

  // Check the first readiness identity inside the same transaction. The
  // remaining candidate chain ids are part of the evidence binding and are
  // validated by the readiness settlement before authorization.
  const firstReadiness = await tx.task.findUnique({
    where: { id: first.taskId },
    select: { id: true, projectId: true, repoId: true, chainId: true },
  });
  if (!firstReadiness
    || firstReadiness.projectId !== projectId
    || firstReadiness.repoId !== repoId
    || firstReadiness.chainId !== chainId) {
    throw new Error("Cannot create merge-train task: the first candidate readiness Task is not bound to the Regression Task");
  }

  const description = mergeTrainTaskDescription({
    baseSha: input.baseSha,
    width,
    candidates: input.candidates,
  });
  const task = await tx.task.create({ data: {
    projectId,
    repoId,
    name: `Merge train: ${input.candidates.length} candidate${input.candidates.length === 1 ? "" : "s"}`,
    description,
    assigneeType: "AGENT",
    assigneeAgentId,
    approvalGate: false,
    opensPullRequest: false,
    status: TaskStatus.REVIEW,
    targetBranch: repo.defaultBranch,
    maxSessionsPerTask: 1,
  } });

  const markerMetadata = {
    trainTaskId: task.id,
    regressionTaskId: input.regressionTaskId,
    baseSha: input.baseSha,
    width,
    candidates: [...input.candidates],
  };
  await writeMarker(tx, task.id, "train", "acquiring", {
    actorType: "control-plane",
    body: `Merge train reserved with ${input.candidates.length} candidate${input.candidates.length === 1 ? "" : "s"}`,
    metadata: markerMetadata,
  });
  for (const [index, candidate] of input.candidates.entries()) {
    await writeMarker(tx, candidate.taskId, "train", "acquiring", {
      actorType: "control-plane",
      body: `Merge train ${task.id} reserved at position ${index + 1}`,
      metadata: { trainTaskId: task.id, position: index + 1 },
    });
  }
  return { taskId: task.id };
};

/** Enqueue only after the reservation's external merge lease is held. */
export const enqueueMergeTrainTask = async (
  tx: DbTx, taskId: string, now: Date,
): Promise<{ runId: string }> => {
  const marker = await readLatestMarker(tx, taskId, "train");
  const parsed = parseMergeTrainMarker(marker?.raw);
  if (parsed.status !== "ok" || parsed.marker.state !== "acquiring" || !parsed.marker.candidates) {
    throw new Error(`Merge train ${taskId} has no acquiring reservation`);
  }
  await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.TODO, failureReason: null } });
  const opened = await openRun(tx, taskId, { kind: "task-created", readyAt: now });
  if (!opened.ok) throw errorForOpenRunRefusal(opened.refusal);
  await writeMarker(tx, taskId, "train", "queued", { actorType: "control-plane",
    body: "Merge lease acquired; train Run queued", metadata: { ...parsed.marker.raw } });
  for (const [index, candidate] of parsed.marker.candidates.entries()) {
    await writeMarker(tx, candidate.taskId, "train", "queued", { actorType: "control-plane",
      body: `Merge train ${taskId} queued at position ${index + 1}`,
      metadata: { trainTaskId: taskId, position: index + 1 } });
  }
  return { runId: opened.run.id };
};
