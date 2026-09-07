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
 * - *`Task.spendCapApplicable`*: not part of this decision. The flag is written
 *   by nothing but the recurring-copy carry in `scheduler.ts` and read by
 *   nothing, as are `Run.spendCap` and `Run.spendCapApplicable`; a cap is in
 *   force whenever it is set, because a set-but-inert limit is the defect this
 *   basis exists to close. Those three columns are dead and can be dropped by a
 *   change that owns the migration.
 *
 * The comparison is `spent >= cap`: a cap is the amount the task may spend, so
 * reaching it exactly leaves nothing for another attempt.
 *
 * *How an amount from this basis is rendered*: `usd` below, everywhere. The
 * column is `Decimal(12,2)` money, so cap and spend are shown with cents in the
 * refusal message, the activity metadata, the board projection and the
 * operator's cap-edit trail rather than in Decimal's unpadded `toString`.
 */
/** The one rendering of an amount from this basis. See the docblock above. */
export const usd = (value: Prisma.Decimal | number): string =>
  new Prisma.Decimal(value).toFixed(2);

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
export type SpendCapUsage = {
  capUsd: Prisma.Decimal;
  spentUsd: Prisma.Decimal;
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
