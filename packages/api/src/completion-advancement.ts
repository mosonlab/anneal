import { TaskStatus } from "@anneal/db";

/**
 * What one completion means for its Task, decided as a named value before any
 * of the advancement writes happen.
 *
 * The facts are the ones `completeRun` has already read inside its
 * transaction: the outcome it classified, the Task's chain and template
 * identity, the merge-tail settlement it just performed, and the retry it just
 * opened or was refused. Nothing here reads the database, so every arm of the
 * ladder that used to be reachable only with a scratch PostgreSQL is a row in
 * a table.
 */
export type CompletionAdvancementFacts = {
  runNumber: number;
  succeeded: boolean;
  /** The Step is the integrator's: its own outcome branch already advanced or
   *  stopped the chain from the merge result the executor persisted. */
  mechanical: boolean;
  /** The Task row read with the fenced Run. `completeRun` throws before it
   *  decides anything when a Run names a task the include did not carry, so
   *  there is no absent-Task case to decide. */
  task: {
    templateId: string | null;
    chainId: string | null;
    approvalGate: boolean;
    regressionVerificationStep: boolean;
  };
  /** A failed completion that nevertheless published a qualified negative
   *  Regression verdict for this Run and head. */
  durableNegativeRegressionVerdict: boolean;
  /** Why the canonical deliverable this Run claims to have authored was
   *  refused, from `canonicalOutputRefusal`; the refusal itself has already
   *  parked the Task in REVIEW. */
  outputRefusal: string | null;
  /** The Task's own marker names the Regression it serves, so it is an
   *  automatic repair rather than a chain step. */
  mergeTailAuxiliary: boolean;
  /** `settleMergeTailCompletion` already decided this Task's next state. */
  mergeTailHandled: boolean;
  /** Why this repair completion cannot be settled: the chain's recovery
   *  aggregate does not name the Run the repair repaired. Set only for a
   *  successful repair completion, and never for an ordinary Step. */
  repairBindingRefusal: string | null;
  auxiliaryTargetTaskId: string | null;
  mergeTailRequeue: boolean;
  mergeTailRecoverySourceRunId: string | null;
  retryCreated: boolean;
  retryRefusalMessage: string | null;
  budgetExhausted: boolean;
  budgetCeiling: number;
  missingOutputReason: string | null;
  reportedFailureReason: string | null;
};

/**
 * One case per arm of the completion outcome ladder, named for what the
 * completion means rather than for the conditions that selected it. Each case
 * carries exactly what its writes need, so the apply step is a sequence of the
 * existing actions with no conditions of its own.
 */
export type CompletionAdvancement =
  /** The Run failed, but its negative Regression verdict is durable evidence:
   *  hand the chain to repair and stop the merge lease. */
  | { case: "repair-after-negative-regression" }
  /** The integrator Step's own branch advanced the chain or recorded a stop
   *  from the merge result; there is nothing left for the ladder to do. */
  | { case: "mechanical-merge-already-recorded" }
  /** The process succeeded without a canonical deliverable bound to this Run
   *  and head. The REVIEW park written by the refusal is terminal. */
  | { case: "stop-with-output-refusal"; reason: string }
  /** A Regression Step succeeded: its verdict decides whether the chain
   *  advances or the tail stops. */
  | { case: "settle-regression-verdict" }
  /** An ordinary canonical Step succeeded: advance the template Task. */
  | {
      case: "advance-template-step";
      mergeTailRequeue: boolean;
      mergeTailRecoverySourceRunId: string | null;
    }
  /** The merge tail already settled this Task's state. */
  | { case: "merge-tail-settled" }
  /** A gated chain step succeeded: park it in REVIEW and open the gate
   *  question. */
  | { case: "ask-approval-gate-question" }
  /** The repair succeeded but the platform cannot bind its completion to the
   *  chain's recovery: park the repair Task with the reason and reject the
   *  completion instead of activating a merge-tail target on a broken
   *  binding. */
  | { case: "reject-repair-binding"; reason: string }
  /** A chain step or automatic repair succeeded: mark it DONE and queue
   *  whatever it releases. */
  | {
      case: "complete-and-activate-successors";
      activateChainSuccessor: boolean;
      auxiliaryTargetTaskId: string | null;
    }
  /** Everything else: the Task carries the completion's own verdict, either
   *  waiting for the retry that was just opened or surfaced to an operator. */
  | {
      case: "park-task";
      status: Extract<TaskStatus, "DOING" | "REVIEW">;
      failureReason: string | null;
    };

const parkFailureReason = (facts: CompletionAdvancementFacts): string | null => {
  if (facts.succeeded) return null;
  if (facts.missingOutputReason) return facts.missingOutputReason;
  if (facts.budgetExhausted) return `Maximum ${facts.budgetCeiling} runs reached`;
  if (facts.retryRefusalMessage) return `Automatic retry refused: ${facts.retryRefusalMessage}`;
  return facts.reportedFailureReason ?? "Execution failed";
};

export const completionAdvancement = (facts: CompletionAdvancementFacts): CompletionAdvancement => {
  const { task } = facts;
  if (facts.durableNegativeRegressionVerdict && task.templateId) {
    return { case: "repair-after-negative-regression" };
  }
  if (facts.succeeded && facts.mechanical) return { case: "mechanical-merge-already-recorded" };
  if (facts.succeeded && task.templateId) {
    if (facts.outputRefusal) return { case: "stop-with-output-refusal", reason: facts.outputRefusal };
    if (task.regressionVerificationStep) return { case: "settle-regression-verdict" };
    return {
      case: "advance-template-step",
      mergeTailRequeue: facts.mergeTailRequeue,
      mergeTailRecoverySourceRunId: facts.mergeTailRecoverySourceRunId,
    };
  }
  if (facts.succeeded && (task.chainId || facts.mergeTailAuxiliary)) {
    if (facts.mergeTailHandled) return { case: "merge-tail-settled" };
    // Asked only of a repair the merge tail did not already settle: an unable
    // or invalid repair stopped the tail on its own terms and carries no
    // recovery onto a new Run, so its binding no longer decides anything.
    if (facts.repairBindingRefusal) {
      return { case: "reject-repair-binding", reason: facts.repairBindingRefusal };
    }
    if (task.approvalGate) return { case: "ask-approval-gate-question" };
    return {
      case: "complete-and-activate-successors",
      activateChainSuccessor: Boolean(task.chainId),
      auxiliaryTargetTaskId: facts.auxiliaryTargetTaskId,
    };
  }
  return {
    case: "park-task",
    status: facts.retryCreated ? TaskStatus.DOING : TaskStatus.REVIEW,
    failureReason: parkFailureReason(facts),
  };
};

/**
 * How the same decision reads on the Task's activity feed, or `null` when the
 * completion writes no runner activity at all — the integrator Step narrates
 * its own merge, and a second entry would claim the chain advanced twice.
 *
 * This is deliberately not derived from `CompletionAdvancement`: a canonical
 * output refusal on a chain step without a template still settles through the
 * merge tail, and the feed has always said so.
 */
export const completionActivityBody = (facts: CompletionAdvancementFacts): string | null => {
  if (facts.succeeded && facts.mechanical) return null;
  const run = `Run ${facts.runNumber}`;
  if (facts.durableNegativeRegressionVerdict) {
    return `${run} failed after publishing a negative Regression verdict; repair queued`;
  }
  if (facts.outputRefusal) return `${run} succeeded but canonical task output was refused`;
  if (facts.succeeded && facts.mergeTailAuxiliary && !facts.mergeTailHandled && facts.repairBindingRefusal) {
    return `${run} succeeded but its repair completion was rejected: ${facts.repairBindingRefusal}`;
  }
  if (facts.succeeded && (facts.task.templateId || facts.task.chainId || facts.mergeTailAuxiliary)) {
    return `${run} succeeded; chain advanced or awaiting approval`;
  }
  if (facts.succeeded) return `${run} succeeded; task moved to review`;
  if (facts.retryCreated) return `${run} failed; retry queued`;
  if (facts.retryRefusalMessage) {
    return `${run} failed; automatic retry refused: ${facts.retryRefusalMessage}`;
  }
  return `${run} failed; task moved to review`;
};
