import type { Prisma, Run } from "@prisma/client";

import {
  openRun,
  settleRunBirthRefusal,
  type OpenRunIntent,
  type OpenRunRefusal,
} from "./run-open.js";

type Tx = Prisma.TransactionClient;

/** Newly refundable provider-transport and Regression target-fetch failures
 * are bounded so a persistently broken external dependency cannot create an
 * unbounded retry loop. Existing plumbing refunds remain outside this cap. */
export const EXTERNAL_FAILURE_REFUND_CAP = 3;

/**
 * How many attempts one task may have refunded because the *platform* lost the
 * Run: a lease declared LOST by reconciliation, a claim invalidated by a late
 * salvage, a merge-tail requeue.
 *
 * These refunds raise the ceiling they are measured against. `maxRunsPerTask`
 * and `budgetGrants` both grow by one with every refund, so `runNumber <
 * runBudgetCeiling(...)` is true forever in a pure lease-loss sequence and a
 * task that never runs a single agent attempt can requeue itself without end.
 * The count of refunds is therefore kept apart from the budget it produced,
 * and it is the only thing this bound reads.
 *
 * Matches `EXTERNAL_FAILURE_REFUND_CAP` in size and in reason, and bounds a
 * different class: that one bounds a provider or fetch that keeps failing, this
 * one bounds a runner that keeps disappearing.
 */
export const LEASE_LOSS_REFUND_CAP = 3;
export const LEASE_LOSS_REFUND_EXHAUSTED_PREFIX = "Lease-loss refunds exhausted";

/**
 * The ceiling a task's next attempt is measured against.
 *
 * `Task.maxSessionsPerTask` is the configured budget: how many attempts the
 * agent's own work is allowed to cost, and an operator may change it at any
 * time through `PATCH /tasks/:id`. `Run.budgetGrants` is what has been granted
 * on top of it — one per attempt refunded as an external failure, plus any a
 * human re-authorized — and it is carried forward onto every run a task
 * creates, so the largest value across a task's runs is the running total.
 *
 * The two must stay separate. `Run.maxRunsPerTask` is the *sum* of the two as
 * of the moment it was written, and a sum cannot be un-added: reading a
 * historical `maxRunsPerTask` as though it were a grant meant a task whose
 * budget an operator had just lowered from 5 to 2 still got five attempts,
 * because two ordinary EXECUTE failures had left `5` on their rows and nothing
 * could tell that 5 apart from a refund.
 *
 * Every budget gate has to read this. Two of them did not (issue #113): `POST
 * /tasks/:id/start` and `startable` counted run rows against
 * `Task.maxSessionsPerTask` alone and could not see the refunds, so a task
 * whose only failures were sub-second clone errors reported "Run budget
 * exhausted" to the operator while the operator-retry route, reading the very
 * same refund one route away, would have let it run. A ceiling only half the
 * system honours is not a ceiling.
 */
export const runBudgetCeiling = (
  maxSessionsPerTask: number,
  budgetGrants: number | null | undefined,
): number => maxSessionsPerTask + Math.max(0, budgetGrants ?? 0);

/**
 * The running total of grants a task carries. Grants are carried forward onto
 * every Run a task creates, so the highest value across its rows is that total
 * under any ordering. `null` when the task has no Run to read it from.
 */
export const highestBudgetGrants = (
  grants: readonly (number | null | undefined)[],
): number | null => (grants.length === 0
  ? null
  : grants.reduce<number>((highest, grant) => Math.max(highest, grant ?? 0), 0));

/** Whether a task with these run facts may still start another attempt. The
 *  one budget verdict every read surface and the start guard share. */
export const budgetRemaining = (
  maxSessionsPerTask: number,
  facts: { total: number; budgetGrants?: number | null },
): boolean => facts.total < runBudgetCeiling(maxSessionsPerTask, facts.budgetGrants);

/** Whether a task carrying `leaseLossRefunds` may still be refunded once more. */
export const leaseLossRefundAvailable = (leaseLossRefunds: number | null | undefined): boolean =>
  Math.max(0, leaseLossRefunds ?? 0) < LEASE_LOSS_REFUND_CAP;

/**
 * Why the platform is paying for an attempt the task did not spend.
 *
 * `lease-loss` and `claim-invalidated` are the two platform-loss classes
 * `LEASE_LOSS_REFUND_CAP` bounds; `external-failure` is the separate class
 * `EXTERNAL_FAILURE_REFUND_CAP` bounds at run completion.
 */
export type RunRefundReason = "lease-loss" | "claim-invalidated" | "external-failure";

/** Why a refund was not granted. */
export type RunRefundRefusal =
  | "not-latest-run"
  | "refunds-exhausted"
  | "failure-not-external"
  | "mechanical-step"
  | "failure-not-refundable";

/** The durable narration a refused or granted external-failure refund leaves. */
export type RunRefundActivity = {
  body: string;
  metadata: {
    kind: "externalFailureRefund.granted" | "externalFailureRefund.refused";
    schemaVersion: 1;
    policy: "capped" | "uncapped";
    granted: boolean;
    cap: number;
    capReached: boolean;
  };
};

/** The budget columns the refunded Run's terminal row carries, and against
 *  which its `runNumber` is measured. Unchanged when nothing was granted. */
export type RunRefundBudget = { maxRunsPerTask: number; budgetGrants: number };

export type RunRefundDecision = {
  reason: RunRefundReason;
  budget: RunRefundBudget;
  activity: RunRefundActivity | null;
} & (
  | { grant: true }
  | { grant: false; why: RunRefundRefusal }
);

export type RunRefundRequest =
  | {
    reason: "lease-loss" | "claim-invalidated";
    /** The Run the platform lost. A grant is bound to it, so it must still be
     *  the task's latest Run when the replacement is born. */
    run: {
      id: string;
      leaseLossRefunds?: number | null;
      maxRunsPerTask: number;
      budgetGrants: number;
    };
    latestRunId: string | null;
  }
  | {
    reason: "external-failure";
    run: { runNumber: number; maxRunsPerTask: number; budgetGrants: number };
    /** Whether the failure envelope named a cause outside the agent's work. */
    external: boolean;
    /** Whether this failure class is eligible for a refund at all. */
    refundable: boolean;
    /** Mechanical steps are never refunded: their budget is the gate's. */
    mechanical: boolean;
    /** Whether this refund is counted against `EXTERNAL_FAILURE_REFUND_CAP`.
     *  Legacy plumbing refunds are not. */
    capped: boolean;
    /** Grants already emitted with the capped policy. */
    priorCappedRefunds: number;
  };

const refundActivity = (
  body: string,
  policy: RunRefundActivity["metadata"]["policy"],
  granted: boolean,
  capReached: boolean,
): RunRefundActivity => ({
  body,
  metadata: {
    kind: granted ? "externalFailureRefund.granted" : "externalFailureRefund.refused",
    schemaVersion: 1,
    policy,
    granted,
    cap: EXTERNAL_FAILURE_REFUND_CAP,
    capReached,
  },
});

const externalFailureDecision = (
  request: Extract<RunRefundRequest, { reason: "external-failure" }>,
): RunRefundDecision => {
  const { run, external, refundable, mechanical, capped, priorCappedRefunds } = request;
  const unchanged: RunRefundBudget = {
    maxRunsPerTask: run.maxRunsPerTask,
    budgetGrants: run.budgetGrants,
  };
  const refused = (why: RunRefundRefusal, activity: RunRefundActivity | null): RunRefundDecision => ({
    reason: "external-failure", grant: false, why, budget: unchanged, activity,
  });
  if (!external) return refused("failure-not-external", null);
  const policy = capped ? "capped" : "uncapped";
  if (mechanical) {
    return refused("mechanical-step", refundActivity(
      `Run ${run.runNumber} external failure was not refunded because the step is mechanical`,
      policy,
      false,
      false,
    ));
  }
  if (!refundable) {
    return refused("failure-not-refundable", refundActivity(
      `Run ${run.runNumber} external failure was not eligible for a budget refund`,
      policy,
      false,
      false,
    ));
  }
  if (capped && priorCappedRefunds >= EXTERNAL_FAILURE_REFUND_CAP) {
    return refused("refunds-exhausted", refundActivity(
      `Run ${run.runNumber} external-failure refund cap was reached (${EXTERNAL_FAILURE_REFUND_CAP})`,
      policy,
      false,
      true,
    ));
  }
  const ordinal = capped ? priorCappedRefunds + 1 : null;
  return {
    reason: "external-failure",
    grant: true,
    budget: {
      maxRunsPerTask: runBudgetCeiling(run.maxRunsPerTask, 1),
      budgetGrants: run.budgetGrants + 1,
    },
    activity: refundActivity(
      capped
        ? `Run ${run.runNumber} received external-failure budget refund ${ordinal} of ${EXTERNAL_FAILURE_REFUND_CAP}`
        : `Run ${run.runNumber} received an external-failure budget refund`,
      policy,
      true,
      false,
    ),
  };
};

/**
 * The one place a refund is decided, for every class that can grant one.
 *
 * Refunds raise the ceiling they are measured against, so the answer states
 * both halves together: whether the grant happened, and the budget columns the
 * refunded Run's terminal row must carry. A caller that is refused still writes
 * the returned budget: it is that Run's unchanged pair, so the same two fields
 * are written on every path and cannot drift.
 */
export const refundDecision = (request: RunRefundRequest): RunRefundDecision => {
  if (request.reason === "external-failure") return externalFailureDecision(request);
  const { run, latestRunId, reason } = request;
  const bound = run.id === latestRunId;
  const available = leaseLossRefundAvailable(run.leaseLossRefunds);
  if (!bound || !available) {
    return {
      reason,
      grant: false,
      why: bound ? "refunds-exhausted" : "not-latest-run",
      budget: { maxRunsPerTask: run.maxRunsPerTask, budgetGrants: run.budgetGrants },
      activity: null,
    };
  }
  return {
    reason,
    grant: true,
    budget: { maxRunsPerTask: run.maxRunsPerTask + 1, budgetGrants: run.budgetGrants + 1 },
    activity: null,
  };
};

/** A decided platform-loss refund, and the replacement birth that spends it. */
export type LostRunRefund = {
  reason: "lease-loss" | "claim-invalidated";
  granted: boolean;
  why: RunRefundRefusal | null;
  /** The Run the grant is bound to. */
  sourceRunId: string;
  runNumber: number;
  /** Write these onto the lost Run's terminal row, whatever shape that write
   *  takes. `maxRunsPerTask` is also the ceiling this Run is measured against. */
  budget: RunRefundBudget;
  /** The birth intent that spends this refund, with the source budget already
   *  stated. `openRun` derives the replacement's columns from it, so they match
   *  `budget` without either side restating the arithmetic. */
  intent: (readyAt: Date) => OpenRunIntent;
};

/**
 * Decide the refund for a Run the platform lost, binding the grant to the
 * task's latest Run.
 *
 * A grant left on an older row is a grant `openRun` will reject as
 * `source-run-stale` while the operator's own retry happily spends it, so the
 * binding is read here, once, rather than at every terminal write.
 */
export const refundForLostRun = async (
  tx: Tx,
  input: {
    taskId: string | null;
    run: {
      id: string;
      runNumber: number;
      leaseLossRefunds?: number | null;
      maxRunsPerTask: number;
      budgetGrants: number;
    };
    reason: "lease-loss" | "claim-invalidated";
  },
): Promise<LostRunRefund> => {
  const { taskId, run, reason } = input;
  const latest = taskId
    ? await tx.run.findFirst({
      where: { taskId }, orderBy: { runNumber: "desc" }, select: { id: true },
    })
    : null;
  const decided = refundDecision({ reason, run, latestRunId: latest?.id ?? null });
  return {
    reason,
    granted: decided.grant,
    why: decided.grant ? null : decided.why,
    sourceRunId: run.id,
    runNumber: run.runNumber,
    budget: decided.budget,
    intent: (readyAt: Date): OpenRunIntent => (reason === "lease-loss"
      ? {
        kind: "retry-after-lease-loss",
        sourceRunId: run.id,
        sourceMaxRunsPerTask: run.maxRunsPerTask,
        sourceBudgetGrants: run.budgetGrants,
        readyAt,
      }
      : { kind: "claim-invalidated", sourceRunId: run.id, readyAt }),
  };
};

export type RefundedReopen =
  | { kind: "reopened"; run: Run }
  | { kind: "exhausted"; ceiling: number }
  | { kind: "refused"; refusal: OpenRunRefusal };

/**
 * Open the replacement a platform-loss refund paid for, or settle why none
 * follows.
 *
 * `exhausted` is the refunded Run that has already reached the ceiling its own
 * refund raised: no birth is attempted, and the caller narrates the dead end to
 * the operator. `refused` is a birth `openRun` declined — the bound spent, the
 * chain held, the task archived — already parked durably here, because a
 * refusal that raised instead would roll back the terminal write beside it.
 */
export const reopenRefundedRun = async (
  tx: Tx,
  input: {
    taskId: string;
    refund: LostRunRefund;
    /** When the replacement may run. The platform-loss classes space their
     *  replacements by the refunds already granted; the schedule is the
     *  caller's, the ordering is this module's. */
    readyAt: Date;
    now: Date;
    activityPrefix: string;
  },
): Promise<RefundedReopen> => {
  const { taskId, refund, readyAt, now, activityPrefix } = input;
  if (refund.granted && refund.runNumber >= refund.budget.maxRunsPerTask) {
    return { kind: "exhausted", ceiling: refund.budget.maxRunsPerTask };
  }
  const opened = await openRun(tx, taskId, refund.intent(readyAt));
  if (opened.ok) return { kind: "reopened", run: opened.run };
  const settlement = await settleRunBirthRefusal(tx, {
    taskId,
    refusal: opened.refusal,
    mode: "park",
    now,
    origin: { kind: "automatic", activityPrefix },
  });
  if (settlement.kind === "raise") throw settlement.error;
  return { kind: "refused", refusal: opened.refusal };
};
