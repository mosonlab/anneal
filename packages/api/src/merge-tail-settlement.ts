import {
  FailureClass, isIntegratorStep, isRegressionVerificationOutputKind,
  latestMarker, readMarkers, readMarkerHistory, readLatestMarker,
  REGRESSION_VERIFICATION_OUTPUT_KIND, stepRole,
  type Marker, type Prisma,
} from "@anneal/db";
import {
  activeRepairRecoverySourceRun, mergeTailRequeueContextForRun, regressionVerdictForRun,
  type MergeTailRequeueContext, type RegressionVerdictQualification, type RepairRecoveryBinding,
} from "./merge-tail-actions.js";
import { lockTaskMutationRows } from "./task-write.js";

type SettlementTask = {
  id: string;
  templateStep: { stepIndex: number; outputKind: string; taskTemplate: { name: string } } | null;
  templateId: string | null;
  chainId: string | null;
};
type SettlementInput = {
  run: { id: string; taskId: string | null; runNumber: number };
  task: SettlementTask | null;
  succeeded: boolean;
  external: boolean;
  retryable: boolean;
  failureClass: FailureClass | null;
  headSha: string | null;
  budgetCeiling: number;
};
type SettlementRows = {
  markers: Marker[];
  trainMarker: Marker | null;
  failedRepairHistory: Marker[];
  failedRepairOutput: { runId: string | null } | null;
  failedRegressionVerdict: RegressionVerdictQualification | null;
  requeueContext: MergeTailRequeueContext | null;
  documentationTaskId: string | null;
  documentationAbsence: string | null;
  repairBinding: RepairRecoveryBinding | null;
};

export const terminalFailureStopsLease = (
  step: Parameters<typeof isIntegratorStep>[0],
  repairCompletion: boolean,
): boolean => isIntegratorStep(step ?? null)
  || isRegressionVerificationOutputKind(step?.outputKind)
  || repairCompletion;

const regressionFailureFacts = (input: SettlementInput) => ({
  externalRegressionFailure: input.external
    && input.task?.templateStep?.outputKind === REGRESSION_VERIFICATION_OUTPUT_KIND,
  retryableProtocolRegressionFailure: input.failureClass === FailureClass.PROTOCOL_ERROR
    && input.retryable && isRegressionVerificationOutputKind(input.task?.templateStep?.outputKind),
});

const negativeRegressionFacts = (
  input: SettlementInput,
  failedRegressionVerdict: RegressionVerdictQualification | null,
) => {
  const { externalRegressionFailure, retryableProtocolRegressionFailure } = regressionFailureFacts(input);
  const durableNegativeRegressionVerdict = Boolean(!input.succeeded
    && failedRegressionVerdict?.status === "ok"
    && failedRegressionVerdict.verdict.outcome !== "pass"
    && ((retryableProtocolRegressionFailure && input.headSha === failedRegressionVerdict.headSha)
      || (externalRegressionFailure
        && (failedRegressionVerdict.verdict.outcome === "review-fail"
          || failedRegressionVerdict.verdict.outcome === "refresh-conflict"))));
  return {
    durableNegativeRegressionVerdict,
    completionHeadSha: durableNegativeRegressionVerdict && failedRegressionVerdict?.status === "ok"
      ? failedRegressionVerdict.headSha : input.headSha,
  };
};

/** Pure tail facts from the same rows the transactional read supplies. */
export const deriveMergeTailFacts = (input: SettlementInput & SettlementRows) => {
  const repairMarker = latestMarker(input.succeeded ? input.markers : [], "repairAttempt");
  const failedRepairMarker = latestMarker(input.failedRepairHistory, "repairAttempt");
  const repairCompletion = Boolean(latestMarker(input.markers, "repairAttempt")?.regressionTaskId);
  const unboundRepair = input.repairBinding?.case === "mismatch" && repairMarker?.regressionTaskId
    ? { regressionTaskId: repairMarker.regressionTaskId, mismatch: input.repairBinding.mismatch }
    : null;
  return {
    ...negativeRegressionFacts(input, input.failedRegressionVerdict),
    tailMarkers: input.markers,
    qualifiedRegressionVerdict: input.failedRegressionVerdict,
    mergeTrainSettled: Boolean(input.task && !input.task.templateId && !input.task.chainId
      && input.trainMarker?.raw.trainTaskId === input.task.id
      && (input.trainMarker.state === "settled" || input.trainMarker.state === "aborted")),
    mergeTailAuxiliary: Boolean(repairMarker?.regressionTaskId),
    auxiliaryTargetTaskId: repairMarker?.regressionTaskId
      ? input.documentationTaskId ?? repairMarker.regressionTaskId : null,
    documentationTaskId: input.documentationTaskId,
    repairDocumentationAbsence: input.documentationAbsence,
    repairBinding: input.repairBinding,
    unboundRepair,
    repairBindingRefusal: unboundRepair?.mismatch.reason ?? null,
    terminalFailureStopsLease: terminalFailureStopsLease(input.task?.templateStep, repairCompletion),
    regressionVerificationStep: isRegressionVerificationOutputKind(input.task?.templateStep?.outputKind),
    retryInheritsLease: isIntegratorStep(input.task?.templateStep ?? null)
      || isRegressionVerificationOutputKind(input.task?.templateStep?.outputKind),
    retryFailedRepair: Boolean(failedRepairMarker?.regressionTaskId
      && failedRepairMarker.headSha
      && ["refresh-conflict", "review-fix", "gate-fix"].includes(failedRepairMarker.repairKind ?? "")
      && input.failedRepairOutput?.runId !== input.run.id
      && !input.failedRepairHistory.some((marker) => marker.kind === "repairResult" && marker.raw.runId === input.run.id)),
    mergeTailSuccessorRequeue: input.requeueContext !== null,
    mergeTailRecoverySourceRunId: input.requeueContext?.recoverySourceRunId ?? null,
  };
};

export type MergeTailFacts = ReturnType<typeof deriveMergeTailFacts>;

/** Caller holds the fenced Run and its Task/Chain mutex. The repair target
 * mutex is acquired before reading that Chain's recovery aggregate. */
export const readMergeTailSettlement = async (
  tx: Prisma.TransactionClient,
  input: SettlementInput,
): Promise<MergeTailFacts> => {
  const { run, task, succeeded, retryable, failureClass, budgetCeiling } = input;
  // A negative Regression verdict survives a later external failure, including
  // delivery or salvage failure before completion can report a head. Keep the
  // existing retryable protocol-error case too. The canonical qualifier owns
  // Run identity, JSON validation and exact authored-head binding; only an
  // unreported head may fall back to persisted evidence. PASS stays excluded.
  // The legacy output kind deliberately keeps its existing failure path.
  const { externalRegressionFailure, retryableProtocolRegressionFailure } = regressionFailureFacts(input);
  const failedRegressionVerdict = !succeeded
    && (externalRegressionFailure || retryableProtocolRegressionFailure)
    && run.taskId && task
    ? await regressionVerdictForRun(tx, {
        task,
        runId: run.id,
        runHeadSha: input.headSha,
        allowPersistedHeadWhenUnreported: externalRegressionFailure,
      })
    : null;
  const { durableNegativeRegressionVerdict } = negativeRegressionFacts(input, failedRegressionVerdict);
  // Recent repair markers matter only for a standalone successful repair or
  // a failure that will settle the tail rather than retry.
  const failureIsFinal = !succeeded
    && (durableNegativeRegressionVerdict || !(retryable && run.runNumber < budgetCeiling));
  const documentationStepSucceeded = succeeded
    && Boolean(task?.templateStep && stepRole(task.templateStep) === "documentation");
  // Train settlement is read separately below from control-plane activity;
  // it does not widen repair marker reads for retryable detached failures.
  const tailMarkers = task && (failureIsFinal
    || (succeeded && !task.templateId && !task.chainId))
    ? await readMarkers(tx, task.id)
    : [];
  // A task-failed repair with no current-Run result spends its next ordinary
  // session before the tail stops. Use the immutable Run ceiling, just like
  // other completion retries; this grants neither a refund nor a new repair.
  const failedRepairHistory = !succeeded && failureClass === FailureClass.TASK_FAILED
    && run.taskId && run.runNumber < budgetCeiling
    ? await readMarkerHistory(tx, run.taskId)
    : [];
  const failedRepairMarker = latestMarker(failedRepairHistory, "repairAttempt");
  const failedRepairOutput = failedRepairMarker?.regressionTaskId && run.taskId
    ? await tx.taskStepOutput.findUnique({ where: { taskId: run.taskId }, select: { runId: true } })
    : null;
  const succeededMarkers = succeeded ? tailMarkers : [];
  const mergeTailRequeueContext = documentationStepSucceeded && task
    ? await mergeTailRequeueContextForRun(tx, { taskId: task.id, runId: run.id })
    : null;
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
  // A detached merge-train card the readiness tick has already settled. The
  // train session persists its record before `session.finish`, so settlement
  // commonly commits while this Run is still active; the card's terminal
  // state is the tick's, not this completion's, in either direction.
  // Agent activity can carry marker-shaped metadata but cannot settle a
  // train. Read the control plane's latest state independently of the recent
  // activity window so session chatter cannot hide an existing settlement.
  const trainMarker = task && !task.templateId && !task.chainId
    ? await readLatestMarker(tx, task.id, "train")
    : null;
  const auxiliaryTargetTaskId = repairMarker?.regressionTaskId
    ? repairDocumentationTask?.id ?? repairMarker.regressionTaskId
    : null;
  const repairSourceRunId = typeof repairMarker?.raw.sourceRunId === "string"
    ? repairMarker.raw.sourceRunId
    : null;
  if (auxiliaryTargetTaskId && auxiliaryTargetTaskId !== task?.id) {
    await lockTaskMutationRows(tx, auxiliaryTargetTaskId);
  }
  const repairBinding = repairMarker?.regressionTaskId && repairSourceRunId
    ? await activeRepairRecoverySourceRun(tx, {
        regressionTaskId: repairMarker.regressionTaskId,
        sourceRunId: repairSourceRunId,
      }) : null;
  return deriveMergeTailFacts({
    ...input, markers: tailMarkers, trainMarker, failedRepairHistory, failedRepairOutput,
    failedRegressionVerdict, requeueContext: mergeTailRequeueContext,
    documentationTaskId: repairDocumentationTask?.id ?? null,
    documentationAbsence: repairDocumentationAbsence, repairBinding,
  });
};
