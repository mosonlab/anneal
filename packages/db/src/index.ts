import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  agentosPrisma?: PrismaClient;
};

export const prisma = globalForPrisma.agentosPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.agentosPrisma = prisma;
}

export * from "@prisma/client";
export * from "./chain-branch.js";
export * from "./run-head.js";
export * from "./agent-message.js";
export * from "./maintenance-lock.js";
export * from "./service-maintenance-lock.js";
export * from "./deploy-barrier.js";
export * from "./gate-attestation.js";
export * from "./merge-integrator.js";
export * from "./merge-integrator-db.js";
export * from "./merge-tail.js";
export * from "./gate-slot.js";
export * from "./merge-gate.js";
export * from "./gate-toggle.js";
export * from "./merge-tail-markers.js";
export * from "./readiness-requeue.js";
export * from "./merge-recovery-revalidate.js";
export * from "./merge-recovery-intent.js";
export * from "./merge-lease-ledger.js";
export {
  CHAIN_STRUCTURE_LOCK_CLASS,
  lockAgentRepoGrant,
  lockAgentRepoGrantForRevocation,
  lockAgentRow,
  lockAgentRows,
  lockChainRows,
  lockChainStructure,
  lockProjectGateDefaults,
  lockRunRow,
  lockTemplateRow,
  lockTemplateStepRows,
  lockTaskRow,
} from "./locks.js";
export {
  ArchivedAssigneeError,
  ArchivedTaskError,
  COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE,
  COMPOUND_IMPLEMENTATION_ASSIGNEE_MESSAGE,
  ChainHeldError,
  CompoundImplementationAssigneeError,
  type CompoundImplementationStepShape,
  type EnqueueTaskRunOptions,
  IntegratorStoppedError,
  NATIVE_IMPLEMENTATION_SUBAGENT_MAX_CONCURRENT,
  NATIVE_IMPLEMENTATION_SUBAGENT_MODEL,
  type OpenRunDisposition,
  type OpenRunIntent,
  type OpenRunRefusal,
  type OpenRunResult,
  PinnedBaseCommitError,
  type RunBirthAttempt,
  type RunBranchTask,
  WorkflowRefusalError,
  type WorkflowRefusalReason,
  attemptRunBirth,
  basePublishedStamp,
  codexGptCapability,
  compoundImplementationAssigneeValid,
  deriveRunConfig,
  enqueueTaskRun,
  enqueueTaskRunInternal,
  errorForOpenRunRefusal,
  parksInsteadOfRaising,
  recordRunBirthRefusal,
  runBirthRefusalMetadata,
  EXTERNAL_FAILURE_REFUND_CAP,
  gateQuestion,
  isArchivedAssigneeError,
  isArchivedTaskError,
  isChainHeldError,
  isCompoundImplementationAssigneeError,
  isCompoundImplementationStep,
  isDirectImplementationStep,
  isIntegratorStoppedError,
  isPinnedBaseCommitError,
  isWorkflowRefusalError,
  LEASE_LOSS_REFUND_CAP,
  LEASE_LOSS_REFUND_EXHAUSTED_PREFIX,
  leaseLossRefundAvailable,
  leaseLossRefundDecision,
  nativeImplementationSubagentRunConfig,
  openRun,
  pinnedImplementationRange,
  platformImplementationBaseSha,
  recordedImplementationBaseSha,
  resolveRequeueBase,
  resolveRunBranches,
  runBudgetCeiling,
  runnerFor,
} from "./run-open.js";
export {
  ACTIVE_RUN_STATUSES,
  CHAIN_AUTO_RESUME_KIND,
  LIVE_TASK_STATUSES,
  MAX_AUTOMATIC_SUCCESSOR_RESUMES,
  activateChainSuccessor,
  activateRecoveryIntegratorSuccessor,
  advanceTemplateTask,
  agentArchiveBlocker,
} from "./chain-activation.js";
export {
  GATE_ATTESTATION_BASE_MISMATCH,
  type MergeAuthorizationResult,
  MergeEvidenceError,
  isMergeEvidenceError,
  produceMergeAuthorization,
  recordMergeEvidenceRefusal,
} from "./merge-authorization.js";
export {
  APPROVAL_GATE_FEEDBACK_METADATA_FIELD,
  APPROVAL_GATE_NOTE_METADATA_FIELD,
  MAX_APPROVAL_GATE_NOTE_CHARS,
  type InboxDecisionInput,
  type InboxDecisionResult,
  applyInboxDecision,
  applyInboxDecisionTx,
} from "./inbox-decision.js";
export * from "./usage.js";
export * from "./cost.js";
export * from "./spend-cap.js";
export * from "./failure-envelope.js";
export * from "./run-outcome.js";
export * from "./run-output-evidence.js";
export * from "./provider-terminal.js";
export * from "./agent-sources.js";
export * from "./agent-contract.js";
export * from "./template-sources.js";
export * from "./canonical-agent-lookup.js";
export * from "./canonical-template-transition.js";
export * from "./canonical-template-installation.js";
export * from "./staffing-profile-canonical.js";
export * from "./canonical-output-schema.js";
export * from "./verify-starter-onboarding.js";
export * from "./chain-control.js";
