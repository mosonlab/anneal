import {
  MergeRecoveryStatus,
  recoveryContext,
  transitionMergeRecovery,
  type Prisma,
  type RegressionVerdict,
  TaskStatus,
} from "@anneal/db";

import {
  handleRegressionCompletion,
  openMergeTailStopNotice,
  stopMergeTail,
} from "./merge-tail-actions.js";

type DbTx = Prisma.TransactionClient;

/** The failure arms a merge-train record can leave for one candidate. */
export type MergeTrainFailureInput = {
  regressionTaskId: string;
  readinessTaskId: string;
  headSha: string;
  predecessorOid: string;
  trainTaskId: string;
  now: Date;
} & (
  | Readonly<{ kind: "fail"; gateExcerpt: string }>
  | Readonly<{ kind: "blocked"; reason: string }>
);

export type MergeTrainCandidateSettlementResult =
  | Readonly<{ kind: "repair-opened"; repairTaskId: string }>
  | Readonly<{ kind: "stopped"; reason: string }>
  | Readonly<{ kind: "aborted"; reason: string }>;

export type MergeTrainRepairDependencies = {
  handleRegression: typeof handleRegressionCompletion;
  stopTail: typeof stopMergeTail;
  openStopNotice: typeof openMergeTailStopNotice;
  transitionRecovery: typeof transitionMergeRecovery;
};

const defaultDependencies: MergeTrainRepairDependencies = {
  handleRegression: handleRegressionCompletion,
  stopTail: stopMergeTail,
  openStopNotice: openMergeTailStopNotice,
  transitionRecovery: transitionMergeRecovery,
};

type TrainRegressionTask = {
  id: string;
  projectId: string;
  repoId: string | null;
  templateId: string | null;
  chainId: string | null;
  chainIndex: number | null;
  targetBranch: string | null;
  assigneeAgentId: string | null;
  templateStep: {
    stepIndex: number;
    outputKind: string;
    taskTemplate: { name: string } | null;
  } | null;
};

type TrainSourceRun = {
  id: string;
  taskId: string | null;
  agentId: string;
  branch: string | null;
  headSha: string | null;
  session: { id: string } | null;
};

const readActiveRecovery = async (
  tx: DbTx,
  regressionTaskId: string,
  sourceRunId: string | null,
) => {
  const row = await tx.mergeRecoveryAttempt.findFirst({
    where: {
      regressionTaskId,
      status: { in: [MergeRecoveryStatus.REPAIRING, MergeRecoveryStatus.AWAITING_AUTHORIZATION] },
      ...(sourceRunId ? { recoveryRunId: sourceRunId } : {}),
    },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  return { row, context: recoveryContext(row) };
};

const readRegressionTask = async (
  tx: DbTx,
  taskId: string,
): Promise<TrainRegressionTask> => tx.task.findUniqueOrThrow({
  where: { id: taskId },
  select: {
    id: true,
    projectId: true,
    repoId: true,
    templateId: true,
    chainId: true,
    chainIndex: true,
    targetBranch: true,
    assigneeAgentId: true,
    templateStep: {
      select: {
        stepIndex: true,
        outputKind: true,
        taskTemplate: { select: { name: true } },
      },
    },
  },
}) as unknown as Promise<TrainRegressionTask>;

/**
 * A train candidate is identified by the Regression task, while the source
 * Run is identified by the output that supplied its Regression evidence. This
 * keeps a repair bound to the exact evidence Run even when a later Run exists
 * on the task. The fallback is for older rows whose output did not retain a
 * Run id; a ready candidate still has a single latest terminal Run in that
 * shape.
 */
const readSourceRun = async (
  tx: DbTx,
  regressionTaskId: string,
): Promise<TrainSourceRun | null> => {
  const output = await tx.taskStepOutput.findUnique({
    where: { taskId: regressionTaskId },
    select: { runId: true },
  });
  const select = {
    id: true,
    taskId: true,
    agentId: true,
    branch: true,
    headSha: true,
    session: { select: { id: true } },
  } as const;
  if (output?.runId) {
    const source = await tx.run.findUnique({ where: { id: output.runId }, select });
    if (source?.taskId === regressionTaskId) return source as TrainSourceRun;
  }
  const source = await tx.run.findFirst({
    where: { taskId: regressionTaskId },
    select,
    orderBy: [{ runNumber: "desc" }, { id: "desc" }],
  });
  return source as TrainSourceRun | null;
};

const trainFailureReason = (input: MergeTrainFailureInput): string => input.kind === "fail"
  ? `Merge train ${input.trainTaskId} failed its cumulative gate at ${input.headSha} against prefix ${input.predecessorOid}`
  : `Merge train ${input.trainTaskId} was blocked: ${input.reason}`;

const repairAttemptWhere = (input: MergeTrainFailureInput, sourceRunId: string) => ({
  taskId: input.regressionTaskId,
  actorType: "control-plane" as const,
  AND: [
    { metadata: { path: ["kind"], equals: "mergeTail.repairAttempt" } },
    { metadata: { path: ["repairKind"], equals: "gate-fix" } },
    { metadata: { path: ["sourceRunId"], equals: sourceRunId } },
    { metadata: { path: ["headSha"], equals: input.headSha } },
    { metadata: { path: ["baseHeadSha"], equals: input.predecessorOid } },
  ],
});

/**
 * Settles one candidate outside a merge-train passing prefix.
 *
 * Gate failures are represented as the same negative Regression verdict the
 * ordinary merge-tail completion path receives. That lets the existing
 * attempt history, fixed-implementation staffing, chain-detached repair task,
 * and Run budget remain the authority. The only changed binding is the
 * cumulative train predecessor, which becomes the repair target base.
 *
 * A blocked candidate uses the existing readiness stop path, which parks both
 * tail tasks and upserts the normal stop notice. The train worker owns the
 * candidate readiness activity because it knows the position in the record;
 * this action deliberately does not add a second activity row.
 */
export const settleMergeTrainFailure = async (
  tx: DbTx,
  input: MergeTrainFailureInput,
  dependencies: MergeTrainRepairDependencies = defaultDependencies,
): Promise<MergeTrainCandidateSettlementResult> => {
  const regressionTask = await readRegressionTask(tx, input.regressionTaskId);
  const sourceRun = await readSourceRun(tx, input.regressionTaskId);
  // A blocked prefix has no source Run that can identify its recovery: the
  // runtime stopped before producing a Regression verdict. Resolve the
  // candidate's active aggregate by task alone so the readiness stop can move
  // that same recovery into BLOCKED_DOWNSTREAM.
  const activeRecovery = await readActiveRecovery(
    tx,
    input.regressionTaskId,
    input.kind === "blocked" ? null : sourceRun?.id ?? null,
  );
  const reason = trainFailureReason(input);

  if (input.kind === "blocked") {
    await dependencies.stopTail(tx, {
      phase: "readiness",
      readinessTaskId: input.readinessTaskId,
      regressionTaskId: input.regressionTaskId,
      reason,
      recovery: activeRecovery.context,
      at: input.now,
    });
    return { kind: "stopped", reason };
  }

  if (!sourceRun?.branch || !sourceRun.agentId) {
    const missing = `${reason}; source Regression Run is missing a branch, so the gate-fix repair could not be opened`;
    await dependencies.stopTail(tx, {
      phase: "readiness",
      readinessTaskId: input.readinessTaskId,
      regressionTaskId: input.regressionTaskId,
      reason: missing,
      recovery: activeRecovery.context,
      at: input.now,
    });
    return { kind: "stopped", reason: missing };
  }

  const verdict: RegressionVerdict = {
    schemaVersion: 1,
    outcome: "gate-fail",
    headSha: input.headSha,
    baseHeadSha: input.predecessorOid,
    gateVerdict: "FAIL",
    summary: `${reason}. Cumulative gate excerpt follows.`,
    gateFailureExcerpt: input.gateExcerpt,
  };
  // The completion path treats a matching repair marker as an already
  // consumed verdict. Capture that state before invoking it so a retry of the
  // same train does not reset readiness or create a second notice.
  const priorRepairAttempt = await tx.taskActivity.findFirst({
    where: repairAttemptWhere(input, sourceRun.id),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { metadata: true },
  });
  // `handleRegressionCompletion` accepts the canonical task identity shape,
  // whose optional task-template relation omits a null nested row. Prisma
  // selects nullable relations as `null`, so normalize that boundary here.
  const completionTask = regressionTask.templateStep === null
    ? { ...regressionTask, templateStep: undefined }
    : {
      ...regressionTask,
      templateStep: {
        stepIndex: regressionTask.templateStep.stepIndex,
        outputKind: regressionTask.templateStep.outputKind,
        ...(regressionTask.templateStep.taskTemplate
          ? { taskTemplate: regressionTask.templateStep.taskTemplate }
          : {}),
      },
    };
  const result = await dependencies.handleRegression(tx, {
    task: completionTask,
    run: {
      id: sourceRun.id,
      agentId: sourceRun.agentId,
      branch: sourceRun.branch,
      headSha: sourceRun.headSha ?? input.headSha,
      sessionId: sourceRun.session?.id ?? "",
    },
    qualifiedVerdict: verdict,
    mergeTrainFailure: {
      trainTaskId: input.trainTaskId,
      predecessorOid: input.predecessorOid,
    },
    now: input.now,
  });

  if (result === "advance") {
    const unexpected = `${reason}; the existing Regression repair path advanced unexpectedly`;
    await dependencies.stopTail(tx, {
      phase: "readiness",
      readinessTaskId: input.readinessTaskId,
      regressionTaskId: input.regressionTaskId,
      reason: unexpected,
      recovery: activeRecovery.context,
      at: input.now,
    });
    return { kind: "stopped", reason: unexpected };
  }

  // The existing handler returns `handled` for both a newly opened repair and
  // an already-consumed/ceiling outcome. Read its exact gate-fix marker to
  // distinguish those arms without reimplementing the repair budget.
  const repairMarker = await tx.taskActivity.findFirst({
    where: repairAttemptWhere(input, sourceRun.id),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { metadata: true },
  });
  const repairTaskId = repairMarker?.metadata && typeof repairMarker.metadata === "object"
    && !Array.isArray(repairMarker.metadata)
    && typeof (repairMarker.metadata as Record<string, unknown>).repairTaskId === "string"
    ? (repairMarker.metadata as Record<string, string>).repairTaskId
    : null;
  const newlyOpened = priorRepairAttempt === null && repairTaskId !== null;
  if (newlyOpened && repairTaskId) {
    if (activeRecovery.row && activeRecovery.context) {
      const transitioned = await dependencies.transitionRecovery(
        tx,
        activeRecovery.row.id,
        MergeRecoveryStatus.REPAIRING,
        {
          currentBaseSha: input.predecessorOid,
          failureReason: null,
          endedAt: null,
        },
        {
          status: activeRecovery.row.status,
          regressionTaskId: input.regressionTaskId,
          recoveryRunId: sourceRun.id,
        },
      );
      if (!transitioned) {
        throw new Error(`Merge train ${input.trainTaskId} could not move recovery ${activeRecovery.row.id} into REPAIRING`);
      }
    }
    // The train worker's readiness claim may have left this Task DOING while
    // it settled the detached train Run. Return it to the ordinary tail queue
    // beside the Regression REVIEW state created by the repair path.
    await tx.task.update({
      where: { id: input.readinessTaskId },
      data: {
        status: TaskStatus.TODO,
        failureReason: null,
        readinessClaimToken: null,
        readinessClaimExpiresAt: null,
      },
    });
    // A successful repair opening is a train failure even though the ordinary
    // handler only notifies when it has to stop. Upsert the stable train notice
    // exactly once; ceiling and staffing stops already wrote their own notice.
    await dependencies.openStopNotice(tx, {
      taskId: input.regressionTaskId,
      agentId: sourceRun.agentId,
      ...(sourceRun.session?.id ? { sessionId: sourceRun.session.id } : {}),
      reason,
    });
    return { kind: "repair-opened", repairTaskId };
  }
  return { kind: "stopped", reason };
};

/**
 * An aborted train has no Regression completion to route through. Keep this
 * notice separate so a lost Run can record one affected candidate at a time
 * while the worker returns each readiness task to TODO in its own settlement.
 */
export const noticeMergeTrainAbort = async (
  tx: DbTx,
  input: {
    readinessTaskId: string;
    trainTaskId: string;
    reason: string;
    now: Date;
  },
  dependencies: Pick<MergeTrainRepairDependencies, "openStopNotice"> = defaultDependencies,
): Promise<void> => {
  const readiness = await tx.task.findUniqueOrThrow({
    where: { id: input.readinessTaskId },
    select: { id: true, projectId: true, chainId: true, assigneeAgentId: true },
  });
  const regression = readiness.chainId
    ? await tx.task.findFirst({
      where: {
        projectId: readiness.projectId,
        chainId: readiness.chainId,
        templateStep: { outputKind: { in: ["regression-verification-v2", "regression-verification"] } },
      },
      select: { id: true, assigneeAgentId: true },
      orderBy: [{ chainIndex: "asc" }, { id: "asc" }],
    })
    : null;
  const taskId = regression?.id ?? readiness.id;
  const agentId = regression?.assigneeAgentId ?? readiness.assigneeAgentId;
  // A canonical chain always staffs both tail steps. If a malformed legacy
  // row does not, there is no Agent foreign key to attach; leave the durable
  // task/activity handling to the caller rather than inventing an identity.
  if (!agentId) return;
  await dependencies.openStopNotice(tx, {
    taskId,
    agentId,
    reason: `Merge train ${input.trainTaskId} aborted: ${input.reason}`,
  });
};
