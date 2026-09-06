import { Prisma } from "@prisma/client";

import { type CostableRun, runSessionUsageCost } from "./cost.js";

/**
 * The cost basis `Task.spendCap` is measured against, defined once, here.
 *
 * - *Which amounts count*: every Run of the task, priced by
 *   `runSessionUsageCost` — the provider-reported `Session.costUsd` when it
 *   exists, otherwise the read-time token estimate. Nothing else is a cost:
 *   attempts, refunds and grants are attempt budgets and are bounded
 *   elsewhere.
 * - *Currency*: USD, the only currency `Session.costUsd` and the price table
 *   are expressed in. No conversion happens anywhere in this repository.
 * - *An unpriced Run*: contributes zero. A NULL `costUsd` with no tokens means
 *   the amount was never captured, not that it was large; charging a guess
 *   would refuse attempts an operator never paid for. This is deliberately the
 *   permissive side, and it is why the refusal is loud when it does fire.
 * - *An in-flight Run*: counts as soon as its cost is reported. Session usage
 *   is written onto the row during and at the end of the Run, so whatever has
 *   been reported by the moment the next attempt is decided is included; a cap
 *   therefore stops the attempt *after* the one that crossed it, never the one
 *   that is running.
 *
 * The comparison is `spent >= cap`: a cap is the amount the task may spend, so
 * reaching it exactly leaves nothing for another attempt.
 */
export const taskSpendUsd = (runs: readonly CostableRun[]): Prisma.Decimal =>
  runs.reduce((total, run) => {
    const cost = runSessionUsageCost(run);
    return cost === null || cost.costUsd === null ? total : total.plus(cost.costUsd);
  }, new Prisma.Decimal(0));

export const spendCapExhausted = (
  spendCap: Prisma.Decimal | null,
  spentUsd: Prisma.Decimal,
): boolean => spendCap !== null && spentUsd.greaterThanOrEqualTo(spendCap);

/** What a payload shows an operator about a cap: the limit, what the basis
 *  above has already spent against it, and whether it now refuses attempts.
 *  Null when the task has no cap, so nothing is displayed that nothing bounds. */
export type SpendCapUsage<DecimalValue = Prisma.Decimal> = {
  capUsd: DecimalValue;
  spentUsd: DecimalValue;
  exhausted: boolean;
};

export const spendCapUsage = (
  spendCap: Prisma.Decimal | null,
  runs: readonly CostableRun[],
): SpendCapUsage | null => {
  if (spendCap === null) return null;
  const spentUsd = taskSpendUsd(runs);
  return { capUsd: spendCap, spentUsd, exhausted: spendCapExhausted(spendCap, spentUsd) };
};
