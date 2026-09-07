/**
 * The payload `POST /runner/tasks/claim` hands a claiming process.
 *
 * This is the widest cross-process boundary in the system: the API composes
 * the payload from database rows, and two independent processes decode it —
 * the runner (`packages/runner`) and the merge executor
 * (`packages/merge-executor`). Declaring it once here is what keeps the
 * producer and the consumers from drifting. `claimRun` returns this type, so
 * a projection that stops producing a field fails to compile, and the runner
 * aliases it, so a consumer that reads a field the server never sends fails
 * to compile too.
 *
 * It also owns the one decision the same two processes make about each other:
 * whether a mechanical claim's build is compatible with this one, and what the
 * control plane answers, records and alerts when it is not. That decision's
 * strings used to be constants here while its comparison, its wire shape and
 * its dedupe keys were assembled in three other files across two packages; a
 * version bump now changes this file alone.
 *
 * Prisma is imported as types only: persisted enum widening becomes a
 * compile-time change at this seam without pulling generated client code into
 * a consumer. Unlike `wire-contract.ts` and `board-contract.ts` this contract
 * takes no `DateTime` parameter, because the claim carries no timestamp and
 * no Decimal — every value below is already a JSON scalar.
 */

import type {
  CodexServiceTier,
  DependencyProvisioning,
  RunnerKind,
  RunStatus,
} from "@prisma/client";

import type { ExecutionMode } from "./merge-integrator-db.js";
import type { RegressionRepairHandoff } from "./merge-tail.js";

/**
 * The version shared by the mechanical claim and completion request contracts.
 *
 * The merge executor is released independently from the API, so any change to
 * the completion input shape must bump this value. The API refuses a
 * mechanical claim whose caller does not send this exact version rather than
 * allowing the two separately built processes to drift silently.
 */
export const RUN_COMPLETION_CONTRACT_VERSION = 2;

/** Stable refusal discriminator shared by the API and mechanical executor. */
export const MECHANICAL_CONTRACT_MISMATCH_CODE = "mechanical_contract_mismatch";

/**
 * Stable Inbox dedupe-key prefix for every mechanical contract mismatch alert.
 *
 * Exported because the claim transaction takes its advisory lock on this
 * prefix and closes every OPEN alert under it once a compatible executor
 * claims. The per-version-pair prefix that decides whether a *new* alert is
 * opened is built by `mechanicalContractMismatch` below.
 */
export const MECHANICAL_CONTRACT_MISMATCH_DEDUPE_KEY_PREFIX =
  "merge-executor-completion-contract-mismatch:";

/** Stable Inbox body prefix for mechanical completion contract mismatch alerts. */
const MECHANICAL_CONTRACT_MISMATCH_ALERT_BODY_PREFIX =
  "merge executor completion contract mismatch:";

/** The step identity a runner needs: title the delivery, and decide provisioning. */
export type ClaimTemplateStep = {
  name: string;
  /**
   * The persisted dependency-provisioning decision for this template step.
   * Required for every non-null template step, so a runner cannot silently
   * reinterpret a missing field as either policy.
   */
  provisionDependencies: boolean;
  /** A non-null column with a database default. */
  outputKind: string;
  /** The chain's own name, which delivery titles the pull request after; the
   * template relation is mandatory. */
  taskTemplate: { name: string };
};

export type ClaimTask = {
  id: string;
  chainId: string | null;
  chainIndex: number | null;
  /** The chain layer the claimed step sits on, which the API's parallel-review
   * tests read to prove a review frontier claimed both of its siblings. */
  chainLayer: number | null;
  name: string;
  description: string;
  repoId: string | null;
  targetBranch: string | null;
  maxDurationMin: number;
  stallTimeoutMin: number;
  maxSessionsPerTask: number;
  templateStep: ClaimTemplateStep | null;
};

export type ClaimAgent = {
  id: string;
  name: string;
  model: string;
  foundationalPrompt: string;
  rolePrompt: string;
  /** Denied tools, not allowed ones. Empty means no restriction. */
  disabledTools: string[];
};

export type ClaimRepo = {
  id: string;
  remoteUrl: string;
  defaultBranch: string;
  mountPath: string;
  dependencyProvisioning: DependencyProvisioning;
};

export type ClaimRun = {
  id: string;
  /**
   * The claimed Run's task, which the API's own tests read to tell two
   * concurrent claims apart. The column is nullable, but a claim is only ever
   * composed from a Run joined to its task, so the projection sends that task's
   * id and no consumer has to assert it.
   */
  taskId: string;
  runNumber: number;
  /**
   * Whether this run may open a pull request.
   *
   * It lives on `run` and deliberately NOT on `task`: the run carries the
   * snapshot taken when it was created, so an operator's PATCH of the task
   * cannot change a run that is already queued. The claim reads the live task
   * row, so reading it from `task` would break that contract — omitting it
   * there makes doing so a compile error.
   */
  opensPullRequest: boolean;
  /** Whether this Run must advance the workspace commit before delivery. */
  requiresCommit: boolean;
  /**
   * The integration branch selected by the chain's first run. A later chain
   * run targets the shared head, so its own `targetBranch` cannot tell
   * delivery which integration line the chain started from.
   */
  pullRequestBase: string;
  maxDurationMin: number;
  stallTimeoutMin: number;
  maxRunsPerTask: number;
  model: string;
  codexServiceTier: CodexServiceTier;
  subagentModel: string | null;
  subagentMaxConcurrent: number | null;
  targetBranch: string | null;
  /**
   * Whether `targetBranch` was selected from durable `Run.pushedBranch`
   * evidence. When true, provisioning must not replace it with an older
   * declared head.
   */
  targetBranchPublished: boolean;
  /**
   * Exact commit selected by `baseFromStepIndex`. Null means ordinary branch
   * provisioning; a value means fetch-only detached provisioning.
   */
  pinnedBaseSha: string | null;
  /** Immutable review range exposed without revealing predecessor outputs. */
  implementationBaseSha: string | null;
  implementationHeadSha: string | null;
  promptHash: string | null;
  workspacePath: string | null;
  /**
   * The head this Run publishes, decided once at Run birth by
   * `resolveRunBranches` (`run-open.ts`) and never derived by a consumer: a
   * runner that invented its own name put two processes in disagreement about
   * which ref a retry owns.
   *
   * Null only for a Run whose Task has no Repo, which publishes nothing.
   * Provisioning refuses a claim that reaches it without a head.
   */
  branch: string | null;
  baseSha: string | null;
};

/** An output produced by an earlier step of the same chain. */
export type ClaimPriorOutput = {
  kind: string;
  body: string;
  task: { name: string; chainIndex: number | null };
};

/** Immediate prior attempt evidence for a fresh provider Session. */
export type ClaimPreviousRunHandoff = {
  schemaVersion: 1;
  previousRunId: string;
  status: RunStatus;
  failureReason: string | null;
  retryReason:
    | "approval-rejected-without-feedback"
    | "approval-rejected-with-feedback"
    | "automatic-retry"
    | "operator-retry"
    | "retry";
  output: { runId: string; kind: string; body: string; commitSha: string | null } | null;
  /** Present only when the previous attempt ended in a WIP salvage push, which
   *  is the commit this Run is starting on. `parentSha` is the commit that
   *  salvage was made on top of, so a step whose contract is bound to a
   *  particular head can decide whether the salvaged work belongs to it
   *  instead of stopping to ask a human. */
  salvage: { commitSha: string; parentSha: string } | null;
};

/** Server-parsed authority for runner-owned direct-chain workspace bootstrap. */
export type ClaimSpecificationMaterialization = {
  kind: "direct-implementation";
  path: string;
  body: string;
};

export type ClaimContract = {
  /**
   * Server-computed from the claimed task's template step (§D-P1 rule 4).
   * Required, not optional, so a runner build that predates this field fails
   * to compile rather than reading `undefined` as "ordinary" — the one
   * reading that would put a merge step in front of a model CLI.
   *
   * The ordinary runner refuses `"mechanical"` outright. It is claimed by
   * `@anneal/merge-executor`, a different process under a different OS user.
   */
  executionMode: ExecutionMode;
  specificationMaterialization: ClaimSpecificationMaterialization | null;
  task: ClaimTask;
  agent: ClaimAgent;
  repo: ClaimRepo;
  run: ClaimRun;
  session: { id: string };
  runner: RunnerKind;
  fencingToken: string;
  sessionToken: string;
  secrets: Record<string, string>;
  priorOutputs: ClaimPriorOutput[];
  /** Direct operator comments eligible for claim-time prompt delivery. */
  operatorNotes: string[];
  /**
   * The latest approval-gate rejection note for this attempt, delivered
   * separately from the bounded generic operator-note lane. Absent, rather
   * than null, when the claim carries no rejection.
   */
  operatorFeedback?: string | null;
  previousRunHandoff: ClaimPreviousRunHandoff | null;
  /**
   * A control-plane selected, exact-head handoff for a fresh Regression Run.
   * It carries only durable verdict/repair evidence, never provider history.
   */
  regressionRepairHandoff: RegressionRepairHandoff | null;
  resume: { providerConversationId: string; input: string } | null;
  nextEventSeq: number;
};

/** The refusal `claimRun` reports instead of a claim, rendered as a 409. */
export type ClaimRefusal = ClaimRefused | MechanicalContractMismatchRefusal | DispatchDrainingRefusal;

/** A refusal that carries no evidence beyond its reason. */
export type ClaimRefused = {
  error: string;
  reason: string;
};

/** Stable refusal discriminator for every claim refused by a dispatch drain. */
export const DISPATCH_DRAINING_CODE = "dispatch-draining";

/**
 * The refusal every claim gets while an auto-deploy's dispatch drain is in
 * force. It is a statement about the platform, not about any candidate: no
 * Run is read, no Task is parked, and no budget is consumed, so a runner that
 * keeps polling through the drain loses nothing but the poll.
 *
 * `code` repeats `reason` for the same reason the mismatch refusal does: the
 * runner branches on the `code` field of the parsed body.
 */
export type DispatchDrainingRefusal = {
  error: string;
  reason: typeof DISPATCH_DRAINING_CODE;
  code: typeof DISPATCH_DRAINING_CODE;
  /** When the drain stops being honoured even if nothing deletes it. */
  expiresAt: string;
};

/** The wire form of one in-force dispatch drain, composed once for every claim. */
export const dispatchDrainingRefusal = (drain: {
  reason: string;
  expiresAt: Date;
}): DispatchDrainingRefusal => ({
  error: `Dispatch is draining for a pending deploy (${drain.reason})`,
  reason: DISPATCH_DRAINING_CODE,
  code: DISPATCH_DRAINING_CODE,
  expiresAt: drain.expiresAt.toISOString(),
});

/**
 * The refusal a mechanical claim gets when the two independently released
 * processes disagree about the completion contract.
 *
 * Every field here is on the wire: the route answers 409 with `{ error,
 * ...rest }` of this value and adds nothing, so this type *is* the response
 * body the merge executor decodes. `code` repeats `reason` because the
 * released executor branches on `code`; changing which field carries the
 * discriminator would go unrecognised by exactly the build this refusal
 * exists to stop.
 */
export type MechanicalContractMismatchRefusal = {
  error: string;
  reason: typeof MECHANICAL_CONTRACT_MISMATCH_CODE;
  code: typeof MECHANICAL_CONTRACT_MISMATCH_CODE;
  expectedVersion: number;
  /** Null means the mechanical executor omitted its version. */
  receivedVersion: number | null;
};

/**
 * Everything the control plane says and records about one incompatible
 * mechanical claim: what it answers, what it writes on the Task, and what it
 * raises for an operator. The caller performs the writes; it composes no
 * string of its own.
 */
export type MechanicalContractMismatch = {
  refusal: MechanicalContractMismatchRefusal;
  /**
   * The Task record. `metadata` is also the dedupe predicate: one record per
   * (code, apiVersion, executorVersion) triple, so a poll every few seconds
   * does not fill the Task feed.
   */
  activity: {
    body: string;
    metadata: {
      code: typeof MECHANICAL_CONTRACT_MISMATCH_CODE;
      executorVersion: number | null;
      apiVersion: number;
    };
  };
  /**
   * The operator alert. A new one is opened only when no OPEN alert starts
   * with `dedupeKeyPrefix`, which names this exact version pair; `dedupeKey`
   * makes the row itself unique.
   */
  alert: { body: string; dedupeKey: string; dedupeKeyPrefix: string };
};

/**
 * Decide whether a mechanical claim is compatible with this build.
 *
 * Null means compatible. Anything else — the version comparison, the refusal
 * on the wire, the recorded fact, the alert text and both dedupe keys — is
 * this module's, so a version bump changes one file rather than four.
 */
export const mechanicalContractMismatch = (input: {
  /** The version the executor sent; null when it sent none. */
  receivedVersion: number | null;
  taskId: string;
  now: Date;
}): MechanicalContractMismatch | null => {
  if (input.receivedVersion === RUN_COMPLETION_CONTRACT_VERSION) return null;
  const displayedVersion = input.receivedVersion ?? "missing";
  const versions = `executor version ${displayedVersion}; API version ${RUN_COMPLETION_CONTRACT_VERSION}`;
  const message = `Mechanical completion contract mismatch: ${versions}`;
  const dedupeKeyPrefix =
    `${MECHANICAL_CONTRACT_MISMATCH_DEDUPE_KEY_PREFIX}${RUN_COMPLETION_CONTRACT_VERSION}:${displayedVersion}:`;
  return {
    refusal: {
      error: message,
      reason: MECHANICAL_CONTRACT_MISMATCH_CODE,
      code: MECHANICAL_CONTRACT_MISMATCH_CODE,
      expectedVersion: RUN_COMPLETION_CONTRACT_VERSION,
      receivedVersion: input.receivedVersion,
    },
    activity: {
      body: message,
      metadata: {
        code: MECHANICAL_CONTRACT_MISMATCH_CODE,
        executorVersion: input.receivedVersion,
        apiVersion: RUN_COMPLETION_CONTRACT_VERSION,
      },
    },
    alert: {
      body: `${MECHANICAL_CONTRACT_MISMATCH_ALERT_BODY_PREFIX} ${versions}; task ${input.taskId}`,
      dedupeKey: `${dedupeKeyPrefix}${input.now.toISOString()}`,
      dedupeKeyPrefix,
    },
  };
};

/**
 * The claim fields the merge executor reads, projected from `ClaimContract`
 * rather than restated: a projection that stops producing one of them fails to
 * compile in the executor instead of arriving there as `undefined`.
 */
export type MechanicalClaim =
  & Pick<ClaimContract, "executionMode" | "fencingToken" | "sessionToken">
  & { task: Pick<ClaimTask, "chainIndex">; run: Pick<ClaimRun, "id"> };
