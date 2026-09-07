import type { FailureClass } from "@prisma/client";

import type { FailureEnvelope } from "./failure-envelope.js";

/**
 * What a Run ended as, decided once by the runner and read once by the control
 * plane.
 *
 * Before this, the same sentence was assembled twice. The runner derived it
 * from thirteen mutable locals in `executeClaim` and encoded it as loose wire
 * fields; `completeRun` took those fields apart and re-derived the same
 * predicate from `exitCode`/`signal`/`terminalEventSeen`/`terminalSuccess`.
 * Two byte-identical copies of that predicate lived on opposite sides of the
 * seam, and the runner kept them in agreement by *rewriting its own exit
 * evidence*: a mechanically settled Regression or a tolerated post-delivery
 * disconnect had `exitCode: 0, terminalEventSeen: true, terminalSuccess: true`
 * stamped over the process's real exit so the control plane's copy would
 * return the answer the runner had already reached, and a later terminal
 * protocol failure stamped `terminalSuccess: false` back off it.
 *
 * The cases below are what those rewrites were spelling. Each one is a
 * situation an operator can name, and each carries exactly the evidence its
 * verdict needs. Exit evidence goes back to being what the process reported.
 *
 * The three success cases are separate because *why* a Run was allowed to
 * succeed is the fact the forging destroyed: `succeeded` is an agent that
 * exited cleanly, `regression-mechanically-settled` is a fenced mechanical
 * handoff standing in for a provider that never said so, and
 * `delivered-then-disconnected` is a provider that dropped after its output
 * was already durable on the server.
 */
export type RunOutcome =
  /** The agent process exited cleanly and delivery, if any, published. */
  | { case: "succeeded" }
  /**
   * Regression persisted a validated, fenced mechanical verdict for this Run
   * and the provider did not explicitly reject the session. The handoff is the
   * step's terminal product; transport loss after it is not a failure.
   */
  | { case: "regression-mechanically-settled" }
  /**
   * The provider stream dropped without a terminal event, and the server's own
   * copy of this Run's required output matches the delivered head. The output
   * identity alone is the authority.
   */
  | { case: "delivered-then-disconnected" }
  /** A budget gate stopped the Run. `gate` is the gate that fired, not prose. */
  | { case: "budget-exhausted"; gate: BudgetGate; reason: string }
  /**
   * The Run finished but the deliverable its step requires is not there: an
   * absent mechanical handoff, a remediation that did not persist, a canonical
   * PR evidence handoff that failed, an executor that died mid-contract. The
   * work can be attempted again.
   */
  | { case: "required-output-unsatisfied"; reason: string }
  /**
   * A contract between the runner and the control plane was violated, or the
   * control plane could not say whether the required output exists. Retrying
   * would repeat the violation or re-ask a question that did not answer.
   */
  | { case: "terminal-protocol-failure"; reason: string }
  /**
   * The agent, the provider or the runner's own plumbing failed. The envelope
   * is the structured account of *facts*; the control plane alone turns it
   * into a class, a retry decision and a budget decision.
   */
  | { case: "provider-failure"; reason: string; envelope: FailureEnvelope };

/** The budget gates `evaluateBudget` can refuse a Run on. */
export const budgetGates = ["max-runs", "walltime", "stall"] as const;

export type BudgetGate = (typeof budgetGates)[number];

export type AgentExitEvidence = {
  exitCode: number | null;
  signal?: string | null;
  terminalEventSeen: boolean;
  terminalSuccess: boolean;
  terminationReason?: string | null;
};

/**
 * How the agent process itself ended, decided once from its own exit record.
 *
 * This is the extension of the outcome above to the record the outcome is
 * derived from. It replaces `agentExecutionSucceeded` — itself the one copy of
 * what used to be `adapterExecutionSucceeded` in the runner and
 * `completionSucceeded` in the API — because that predicate was only the first
 * of four readings of the same five fields. The others were written
 * independently, in three modules: the Codex adapter's in-Run resume
 * qualification, the runner's post-delivery disconnect tolerance, and the
 * runner's "did the provider explicitly reject this session" test. One repair
 * to the shared question reached one of them at a time — a regex tightened in
 * the adapter, a field typed in the runner, clauses reordered at a call site —
 * for one question about one record.
 *
 * The cases partition the record, so each reading is one case and no reader
 * restates a field. Only the runner asks; the control plane reads the outcome
 * instead. It lives here because it is the predicate whose duplication the
 * outcome exists to end, and a second copy appearing anywhere is the
 * regression to catch.
 */
export type AgentExitVerdict =
  /**
   * The agent emitted a terminal event reporting failure. That rejection is
   * the agent's own and stands whatever the process then did.
   */
  | { case: "refused" }
  /** The agent reported success, nothing stopped the child, and it exited 0. */
  | { case: "succeeded" }
  /**
   * The agent reported success and its process disagreed: a signal, a
   * runner-ordered termination, or a non-zero exit. No caller reads this case;
   * it exists so that `succeeded` needs no further qualification from the
   * readers, which is the duplication this verdict ends.
   */
  | { case: "contradicted" }
  /** The runner or the OS ended the child before the agent said anything. */
  | { case: "stopped" }
  /**
   * The child ended without a terminal event and without being stopped: the
   * provider stream is simply gone. `cleanExit` is the process having exited
   * 0 — the shape a dropped connection takes when the CLI still shut itself
   * down in order. Whether such a drop can be continued is a judgement about
   * the provider, not about this record, and stays with the adapter that owns
   * the provider.
   */
  | { case: "dropped"; cleanExit: boolean };

export const agentExitVerdict = (evidence: AgentExitEvidence): AgentExitVerdict => {
  const stopped = Boolean(evidence.signal) || Boolean(evidence.terminationReason);
  if (evidence.terminalEventSeen) {
    if (!evidence.terminalSuccess) return { case: "refused" };
    return stopped || evidence.exitCode !== 0 ? { case: "contradicted" } : { case: "succeeded" };
  }
  if (stopped) return { case: "stopped" };
  return { case: "dropped", cleanExit: evidence.exitCode === 0 };
};

export type RunOutcomeVerdict = {
  succeeded: boolean;
  /** Null exactly when `succeeded`. */
  failureClass: FailureClass | null;
  retryable: boolean;
  /** The environment failed, not the agent: the attempt must not spend budget. */
  externalFailure: boolean;
  /** Null exactly when `succeeded`. */
  failureReason: string | null;
  /** A time-based budget gate stopped the Run, so it is TIMED_OUT and not FAILED. */
  timedOut: boolean;
};

/**
 * The verdict the control plane acts on, read off the outcome.
 *
 * `classifyEnvelope` is a parameter rather than an import because envelope
 * classification is the control plane's authority and its vocabulary must not
 * become reachable from a runner: this module is on both sides of the seam,
 * and the classifier is on one.
 */
export const runOutcomeVerdict = (
  outcome: RunOutcome,
  classifyEnvelope: (envelope: FailureEnvelope) => {
    failureClass: FailureClass;
    retryable: boolean;
    externalFailure: boolean;
  },
): RunOutcomeVerdict => {
  const succeeded: RunOutcomeVerdict = {
    succeeded: true,
    failureClass: null,
    retryable: false,
    externalFailure: false,
    failureReason: null,
    timedOut: false,
  };
  switch (outcome.case) {
    case "succeeded":
    case "regression-mechanically-settled":
    case "delivered-then-disconnected":
      return succeeded;
    case "budget-exhausted":
      return {
        succeeded: false,
        failureClass: "BUDGET_EXCEEDED",
        // Raising the ceiling for exceeding the ceiling is an unbounded loop,
        // and so is retrying into it.
        retryable: false,
        externalFailure: false,
        failureReason: outcome.reason,
        timedOut: outcome.gate !== "max-runs",
      };
    case "required-output-unsatisfied":
      return {
        succeeded: false,
        failureClass: "PROTOCOL_ERROR",
        retryable: true,
        // The agent's own attempt produced nothing, so it spends the attempt.
        externalFailure: false,
        failureReason: outcome.reason,
        timedOut: false,
      };
    case "terminal-protocol-failure":
      return {
        succeeded: false,
        failureClass: "PROTOCOL_ERROR",
        retryable: false,
        externalFailure: false,
        failureReason: outcome.reason,
        timedOut: false,
      };
    case "provider-failure": {
      const verdict = classifyEnvelope(outcome.envelope);
      return {
        succeeded: false,
        failureClass: verdict.failureClass,
        retryable: verdict.retryable,
        externalFailure: verdict.externalFailure,
        failureReason: outcome.reason,
        timedOut: false,
      };
    }
  }
};
