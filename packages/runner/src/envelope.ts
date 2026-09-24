import {
  FAILURE_ENVELOPE_VERSION,
  truncateEvidence,
  type FailureClass,
  type FailureEnvelope,
  type FailurePhase,
} from "@anneal/db";

import type { ExitEvidence } from "./adapters.js";
import type { DeliveryFailure } from "./delivery.js";
import { isCommandTimeout } from "./exec.js";
import { isTransientNetworkError } from "./network-retry.js";
import { isRemoteBranchDiverged } from "./remote-branch.js";

export {
  type FailureEnvelope,
  type FailurePhase,
  truncateEvidence as summarizeEvidence,
} from "@anneal/db";

/**
 * What this module does *not* do is decide anything. It reports facts: which
 * phase the run was in, what exited with what, which channel each piece of text
 * came off, and whether the runner's own typed `CommandTimeoutError` fired. The
 * API classifies. `adapters.classifyError` still runs and its verdict still
 * rides along as `runnerClass`, but only as a first guess to be recorded — the
 * regex sweep that produced it is precisely what misread an agent's stdout as
 * an auth failure.
 */
export const buildFailureEnvelope = (input: {
  phase: FailurePhase;
  evidence: ExitEvidence;
  /** True only if the agent process ran and reported its own exit. False for
   *  provisioning, preflight and any exception thrown by runner code. */
  agentExited: boolean;
  runnerClass?: FailureClass | null;
  /** Overrides the evidence's own reason, for a kill the runner ordered (a
   *  budget gate) where the CLI never got to say why it died. */
  terminationReason?: string | null;
  /** The error that ended the phase, when there is one. Read by *type* only —
   *  `CommandTimeoutError` and the transient-network predicate — so the CLI's
   *  unrelated "preflight timed out after 30 seconds" text can never be
   *  mistaken for this runner's own command timeout. */
  error?: unknown;
}): FailureEnvelope => {
  const timeout = isCommandTimeout(input.error) ? input.error : null;
  const remoteBranchDiverged = isRemoteBranchDiverged(input.error);
  return {
    version: FAILURE_ENVELOPE_VERSION,
    phase: input.phase,
    runnerClass: input.runnerClass ?? null,
    exitCode: input.evidence.exitCode,
    signal: input.evidence.signal,
    terminationReason: input.terminationReason ?? input.evidence.terminationReason,
    terminalEventSeen: input.evidence.terminalEventSeen,
    terminalSuccess: input.evidence.terminalSuccess,
    agentExited: input.agentExited,
    providerError: truncateEvidence(input.evidence.providerError),
    stderrSummary: truncateEvidence(input.evidence.stderr),
    stdoutSummary: truncateEvidence(input.evidence.stdout),
    timedOut: timeout !== null,
    // A verified divergence is deterministic whatever words its evidence
    // (commit subjects, git output) happens to contain.
    transient: !remoteBranchDiverged
      && (timeout !== null || (input.error !== undefined && isTransientNetworkError(input.error))),
    remoteBranchDiverged,
    timeoutMs: timeout?.timeoutMs ?? null,
  };
};

/**
 * The envelope for an exception that escaped `executeClaim`'s try block.
 *
 * Its own function for the same reason `completionEnvelope` is: the production
 * catch and the test that proves what the API receives share one
 * implementation, so a test cannot assert a shape the runner never sends. The
 * previous #113 regression test hand-wrote `terminationReason: null` for a
 * clone failure and passed while the real path — which stamps `"runner
 * exception"` on every escaped error — was classified CANCELLED_OR_TIMED_OUT
 * and never retried.
 *
 * `agentExited: false` whatever the phase: control reached the catch because
 * runner code threw, so the agent never got to report its own verdict. `error`
 * travels by reference, not stringified, so `CommandTimeoutError` and the
 * transient-network predicate see a type rather than a phrase.
 */
export const runnerExceptionEnvelope = (input: {
  phase: FailurePhase;
  evidence: ExitEvidence;
  runnerClass?: FailureClass | null;
  error: unknown;
}): FailureEnvelope => buildFailureEnvelope({
  phase: input.phase,
  evidence: input.evidence,
  agentExited: false,
  runnerClass: input.runnerClass ?? null,
  terminationReason: RUNNER_EXCEPTION_REASON,
  error: input.error,
});

/** What the runner records as the reason a run ended when its own code threw.
 *  Exported so the runner, its tests and the API fixtures name it once. */
export const RUNNER_EXCEPTION_REASON = "runner exception";

/**
 * The envelope for a run that reached terminal completion, built from whichever
 * phase actually failed.
 *
 * This exists as its own function so the production path and the test that
 * proves it share one implementation: `delivery.test.ts` drives a real
 * `deliverWorkspace` against a hung `git push` and feeds the real
 * `DeliveryResult` through here, so the envelope it asserts is the one a runner
 * would send — not a hand-written shape that happens to agree.
 */
export const completionEnvelope = (input: {
  /** Whether the agent process itself succeeded. When it did and the run still
   *  failed, the failure is delivery's. */
  executionSucceeded: boolean;
  evidence: ExitEvidence;
  deliveryFailure?: DeliveryFailure | undefined;
  runnerClass?: FailureClass | null;
  terminationReason?: string | null;
}): FailureEnvelope => {
  const failure = input.executionSucceeded ? input.deliveryFailure : undefined;
  return buildFailureEnvelope({
    phase: input.executionSucceeded ? "DELIVER" : "EXECUTE",
    // A delivery failure's evidence is the delivery command's, not the agent's.
    // The agent's stderr belongs to a process that *succeeded*; classifying a
    // hung `git push` off it is how a CommandTimeoutError reached the API as an
    // ordinary TASK_FAILED. stdout is dropped rather than carried over for the
    // same reason — it is the agent's work product and says nothing about the
    // push. It is not lost: the completion payload reports it as `output`.
    evidence: failure
      ? { ...input.evidence, providerError: null, stderr: failure.message, stdout: "" }
      : input.evidence,
    agentExited: true,
    runnerClass: input.runnerClass ?? null,
    terminationReason: input.terminationReason ?? input.evidence.terminationReason,
    // By reference, so `isCommandTimeout` sees a type and not a phrase.
    ...(failure ? { error: failure.error } : {}),
  });
};
