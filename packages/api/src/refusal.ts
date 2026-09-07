import {
  isArchivedAssigneeError,
  isArchivedTaskError,
  isChainHeldError,
  isCompoundImplementationAssigneeError,
  isIntegratorStoppedError,
  isMergeConfirmationError,
  isMergeEvidenceError,
  isPinnedBaseCommitError,
  isWorkflowRefusalError,
  type WorkflowRefusalReason,
} from "@anneal/db";

import type { RefusalStatus } from "./refusal-status.js";
import {
  isTemplateInstantiationRefusal,
  templateInstantiationRefusalStatus,
  type TemplateInstantiationRefusalCode,
} from "./template-errors.js";
import {
  isTemplateAuthoringRefusal,
  templateAuthoringRefusalStatus,
  type TemplateAuthoringRefusalCode,
} from "./template-authoring-errors.js";

/**
 * The status family for each reason `@anneal/db` declares in
 * `WorkflowRefusalReason`. It is declared here rather than beside the union
 * because the HTTP contract belongs to this workspace; `satisfies` makes a
 * reason added there fail to compile until it has a family.
 */
const workflowRefusalStatus = {
  "invalid-request": 400,
  conflict: 409,
  "inbox-question-not-found": 409,
  "approval-gate-decision-invalid": 409,
  "inbox-choice-mismatch": 409,
  "inbox-run-not-waiting": 409,
  "approval-gate-rejection-target-missing": 409,
} as const satisfies Record<WorkflowRefusalReason, RefusalStatus>;

/** The refusals this module declares, each with its status family. */
const localRefusalStatus = {
  forbidden: 403,
  "not-found": 404,
  "compound-implementation-assignee": 409,
  "archived-assignee": 409,
  "archived-task": 409,
  "chain-held": 409,
  "integrator-stopped": 409,
  "pinned-base-commit": 409,
  "merge-evidence": 409,
  "merge-confirmation": 409,
  // A repair completion whose recovery names another Run. The state is one the
  // platform produced, so it answers a named conflict rather than a 500.
  "merge-tail-repair-unbound": 409,
  "event-payload-too-large": 413,
  "events-request-too-large": 413,
  // The two refusals of a chain-binding PATCH. Immutability is a conflict:
  // nothing about the request is malformed, the chain has simply started. An
  // unusable predecessor is a bad request, exactly as it is at instantiation.
  chain_binding_immutable_after_start: 409,
  chain_binding_target_invalid: 400,
} as const satisfies Record<string, RefusalStatus>;

export type RefusalReason = WorkflowRefusalReason | keyof typeof localRefusalStatus;

export type RefusalValue =
  | string
  | number
  | boolean
  | null
  | RefusalValue[]
  | { [key: string]: RefusalValue };

export type RefusalDetail = Readonly<Record<string, RefusalValue> & { error?: never }>;

export type Refusal = {
  reason: RefusalReason | TemplateInstantiationRefusalCode | TemplateAuthoringRefusalCode;
  message: string;
  detail?: RefusalDetail;
};

export type RefusalResponse = {
  body: Readonly<{ error: string } & Record<string, RefusalValue>>;
  status: RefusalStatus;
};

/**
 * Every refusal code that can reach a route, resolved to the family declared
 * beside it. The annotation is the exhaustiveness check: a code without a
 * declared family fails to compile here.
 */
const statusByReason: Record<Refusal["reason"], RefusalStatus> = {
  ...workflowRefusalStatus,
  ...localRefusalStatus,
  ...templateInstantiationRefusalStatus,
  ...templateAuthoringRefusalStatus,
};

export const refusalResponse = (refusal: Refusal): RefusalResponse => ({
  body: refusal.detail === undefined
    ? { error: refusal.message }
    : { error: refusal.message, ...refusal.detail },
  status: statusByReason[refusal.reason],
});

export const refusalFor = (error: unknown): Refusal | null => {
  if (isTemplateAuthoringRefusal(error)) {
    return {
      reason: error.code,
      message: error.message,
      detail: {
        code: error.code,
        ...(error.stepIndex === undefined ? {} : { stepIndex: error.stepIndex }),
      },
    };
  }
  if (isTemplateInstantiationRefusal(error)) {
    return {
      reason: error.code,
      message: error.message,
      detail: { code: error.code },
    };
  }
  if (isWorkflowRefusalError(error)) return { reason: error.reason, message: error.message };
  if (isCompoundImplementationAssigneeError(error)) {
    return {
      reason: "compound-implementation-assignee",
      message: error.message,
      detail: { code: error.code },
    };
  }
  if (isArchivedAssigneeError(error)) return { reason: "archived-assignee", message: error.message };
  if (isArchivedTaskError(error)) return { reason: "archived-task", message: error.message };
  if (isChainHeldError(error)) {
    return {
      reason: "chain-held",
      message: error.message,
      detail: {
        chainId: error.chainId,
        taskLayer: error.taskLayer,
        heldLayer: error.heldLayer,
      },
    };
  }
  if (isIntegratorStoppedError(error)) return { reason: "integrator-stopped", message: error.message };
  if (isPinnedBaseCommitError(error)) return { reason: "pinned-base-commit", message: error.message };
  if (isMergeEvidenceError(error)) return { reason: "merge-evidence", message: error.message };
  if (isMergeConfirmationError(error)) return { reason: "merge-confirmation", message: error.message };
  return null;
};
