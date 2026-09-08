import type { Prisma } from "@anneal/db";

import {
  SPEC_TRANSCRIPTION_UNREADABLE_REASON,
  type SpecificationReadTransientCause,
  type SpecificationRefusal,
  specificationReadBudgetExhaustedRefusal,
  specificationReadDeadlineExceededRefusal,
} from "./specification-fidelity.js";

/**
 * How long a slow specification read may keep deferring a review claim, and
 * what durable evidence each deferral leaves.
 *
 * `specification-fidelity.ts` decides whether a read failure is transient and
 * which transient it is. This module owns everything the claim does with that
 * verdict over time: when an episode starts, how long it may run, when the next
 * attempt is eligible, when the episode is exhausted, and the shape of the
 * `TaskActivity.metadata` rows the episode is reconstructed from. `run-claim.ts`
 * asks one question and performs the writes the answer names; no arithmetic and
 * no evidence field lives on the call-site side.
 */

/** The condition every deferral row of an episode is stamped with. */
export const SPECIFICATION_READ_DEFERRAL_CONDITION = "specification-read-claim-deferred";
/** Any transient read failure other than a deadline hit keeps this budget. */
const SPECIFICATION_READ_DEFERRAL_BUDGET_MS = 5 * 60_000;
/**
 * The larger ceiling for a budget whose every failure was a deadline hit. Such
 * a read is slow, not broken: the observed host-load spikes that produced it
 * outlast five minutes but subside well inside half an hour. It is a constant,
 * not configuration, so the extended window stays bounded and a read that never
 * completes still ends in a loud, parked task.
 */
const SPECIFICATION_READ_TIMEOUT_DEFERRAL_CEILING_MS = 30 * 60_000;
const SPECIFICATION_READ_DEADLINE_EXTENDED_CONDITION = "specification-read-deadline-extended";
const SPECIFICATION_READ_DEFERRAL_DELAYS_MS = [15_000, 30_000, 60_000] as const;
/** The single mapping from "every failure was a deadline hit" to its ceiling. */
const budgetMsFor = (allTimeouts: boolean): number => (
  allTimeouts ? SPECIFICATION_READ_TIMEOUT_DEFERRAL_CEILING_MS : SPECIFICATION_READ_DEFERRAL_BUDGET_MS
);

const asRecord = (value: unknown): Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

/** Which Run's deferral episode to read, and where that episode starts. */
export type SpecificationReadDeferralEpisodeKey = {
  taskId: string;
  runId: string;
  /**
   * A resumed Run keeps its id, but every successful claim rewrites
   * `claimedAt`. Rows before it belong to an earlier claim episode.
   */
  claimedAt: Date | null;
};

/**
 * The `taskActivity.findMany` arguments that read one episode's evidence back,
 * oldest row first. The JSON-path query and the metadata it matches are the two
 * halves of one durable shape, so they are stated together here.
 */
export const specificationReadDeferralHistoryQuery = (key: SpecificationReadDeferralEpisodeKey) => ({
  where: {
    taskId: key.taskId,
    ...(key.claimedAt ? { createdAt: { gt: key.claimedAt } } : {}),
    AND: [
      { metadata: { path: ["condition"], equals: SPECIFICATION_READ_DEFERRAL_CONDITION } },
      { metadata: { path: ["runId"], equals: key.runId } },
    ],
  },
  select: { createdAt: true, metadata: true },
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
} satisfies Prisma.TaskActivityFindManyArgs);

export type SpecificationReadDeferralRow = { createdAt: Date; metadata: Prisma.JsonValue };

/** What the persisted rows of one episode say about it. */
export type SpecificationReadEpisode = {
  attemptCount: number;
  budgetStartedAt: Date;
  /** No failure of this episode was anything but a deadline hit. */
  allTimeouts: boolean;
  budgetMs: number;
  budgetDeadlineAt: Date;
  lastUnderlyingError: string;
};

/**
 * Reconstruct an episode from its deferral rows, oldest first. Returns null
 * when the Run has never deferred: the next transient failure starts a budget.
 *
 * This is the one place that tolerates rows written before an evidence field
 * existed. A row without `transientCause` reads as a non-timeout transient, so
 * an in-flight budget keeps its five-minute window rather than silently
 * inheriting the ceiling; a row without `lastUnderlyingErrorDetail` falls back
 * to the refusal message it did persist, with the refusal prefix stripped so
 * the exhaustion message does not nest two refusal sentences.
 */
export const specificationReadEpisode = (
  rows: readonly SpecificationReadDeferralRow[],
): SpecificationReadEpisode | null => {
  const budgetStartedAt = rows[0]?.createdAt;
  if (!budgetStartedAt) return null;
  const latestEvidence = asRecord(rows.at(-1)?.metadata);
  const persistedDetail = typeof latestEvidence.lastUnderlyingErrorDetail === "string"
    ? latestEvidence.lastUnderlyingErrorDetail
    : null;
  const persistedMessage = typeof latestEvidence.lastUnderlyingError === "string"
    ? latestEvidence.lastUnderlyingError
    : "repository content read failed";
  const messagePrefix = `Spec transcription claim refused: ${SPEC_TRANSCRIPTION_UNREADABLE_REASON}: `;
  const allTimeouts = rows.every((row) => asRecord(row.metadata).transientCause === "timeout");
  const budgetMs = budgetMsFor(allTimeouts);
  return {
    attemptCount: rows.length,
    budgetStartedAt,
    allTimeouts,
    budgetMs,
    budgetDeadlineAt: new Date(budgetStartedAt.getTime() + budgetMs),
    lastUnderlyingError: persistedDetail
      ?? (persistedMessage.startsWith(messagePrefix) ? persistedMessage.slice(messagePrefix.length) : persistedMessage),
  };
};

/** A `TaskActivity` row the caller writes verbatim. */
export type SpecificationReadDeferralEvidence = {
  body: string;
  metadata: Prisma.InputJsonObject;
};

/** The one Inbox notice an episode may raise, keyed so it is raised once. */
export type SpecificationReadDeferralNotice = {
  dedupeKey: string;
  body: string;
};

/** Everything a decided episode makes the caller write. */
export type SpecificationReadDeferralSettlement =
  | {
    action: "defer";
    /** What the Run's `readyAt` becomes. */
    nextAttemptAt: Date;
    evidence: SpecificationReadDeferralEvidence;
    notice: SpecificationReadDeferralNotice | null;
  }
  /** The episode is over: park the Run on this refusal with this evidence. */
  | { action: "exhaust"; refusal: SpecificationRefusal; metadata: Prisma.InputJsonObject };

/** The episode has budget left and nothing to record: claim as usual. */
export type SpecificationReadDeferralDecision = SpecificationReadDeferralSettlement | { action: "proceed" };

type ExhaustionInput = {
  now: Date;
  taskId: string;
  runId: string;
  implementationHeadSha: string;
};

const exhaust = (
  episode: SpecificationReadEpisode,
  input: ExhaustionInput,
): SpecificationReadDeferralSettlement => {
  // An episode extended for timeouts and then broken by one other transient
  // parks on the 5-minute budget but has already run longer than it, so the
  // window the refusal names is the observed one, not the budget constant.
  const elapsedMs = input.now.getTime() - episode.budgetStartedAt.getTime();
  const refusal = episode.allTimeouts
    ? specificationReadDeadlineExceededRefusal({
      attempts: episode.attemptCount,
      elapsedMs,
      ceilingMs: SPECIFICATION_READ_TIMEOUT_DEFERRAL_CEILING_MS,
      lastUnderlyingError: episode.lastUnderlyingError,
    })
    : specificationReadBudgetExhaustedRefusal({
      budgetMs: episode.budgetMs,
      elapsedMs,
      lastUnderlyingError: episode.lastUnderlyingError,
    });
  return {
    action: "exhaust",
    refusal,
    metadata: {
      classification: refusal.classification,
      exhaustedCondition: SPECIFICATION_READ_DEFERRAL_CONDITION,
      budgetStartedAt: episode.budgetStartedAt.toISOString(),
      budgetDeadlineAt: episode.budgetDeadlineAt.toISOString(),
      budgetMs: episode.budgetMs,
      transientCause: episode.allTimeouts ? "timeout" : "other",
      implementationHeadSha: input.implementationHeadSha,
      lastUnderlyingError: episode.lastUnderlyingError,
    },
  };
};

export type SpecificationReadDeferralInput = ExhaustionInput & {
  /** The episode this Run has already run, or null if it has never deferred. */
  prior: SpecificationReadEpisode | null;
  /**
   * The transient refusal this claim just saw, or null when the claim has not
   * read yet and only asks whether the episode already ran out of budget.
   */
  refusal: SpecificationRefusal | null;
};

/**
 * The whole deferral policy, as one question asked at both moments a claim
 * needs it: before the read, with `refusal: null`, and after a transient read
 * failure, with the refusal it produced.
 *
 * A budget that has already elapsed exhausts the episode without another read.
 * Otherwise the failure earns the next rung of the delay ladder, clamped to the
 * budget deadline so the last attempt still happens inside the window. One
 * non-timeout transient anywhere in the episode forfeits the extended ceiling
 * for the whole episode: only a purely slow read earns it.
 */
export function deferSpecificationRead(
  input: SpecificationReadDeferralInput & { refusal: SpecificationRefusal },
): SpecificationReadDeferralSettlement;
export function deferSpecificationRead(
  input: SpecificationReadDeferralInput,
): SpecificationReadDeferralDecision;
export function deferSpecificationRead(
  input: SpecificationReadDeferralInput,
): SpecificationReadDeferralDecision {
  const { now, prior, refusal } = input;
  if (!refusal) {
    if (prior && now.getTime() >= prior.budgetDeadlineAt.getTime()) return exhaust(prior, input);
    return { action: "proceed" };
  }
  const budgetStartedAt = prior?.budgetStartedAt ?? now;
  const transientCause: SpecificationReadTransientCause = refusal.transientCause === "timeout" ? "timeout" : "other";
  const allTimeouts = transientCause === "timeout" && (prior?.allTimeouts ?? true);
  const budgetMs = budgetMsFor(allTimeouts);
  const budgetDeadlineAt = new Date(budgetStartedAt.getTime() + budgetMs);
  if (now.getTime() >= budgetDeadlineAt.getTime()) {
    return exhaust({
      attemptCount: prior?.attemptCount ?? 0,
      budgetStartedAt,
      allTimeouts,
      budgetMs,
      budgetDeadlineAt,
      lastUnderlyingError: refusal.detail,
    }, input);
  }

  const attempt = (prior?.attemptCount ?? 0) + 1;
  const delayMs = SPECIFICATION_READ_DEFERRAL_DELAYS_MS[
    Math.min(attempt - 1, SPECIFICATION_READ_DEFERRAL_DELAYS_MS.length - 1)
  ]!;
  const nextAttemptAt = new Date(Math.min(now.getTime() + delayMs, budgetDeadlineAt.getTime()));
  // A sustained overload is worth exactly one notice per task: the first
  // deferral that outlives the ordinary budget, none of the ones after it.
  // The dedupe key is scoped to the Task, not to the Run's deferral episode,
  // so a task that hits this condition again after an operator retry stays
  // silent - the open notice already tells the operator this task is being
  // held by host load, and one row per episode is the noise this notice
  // exists to avoid. Parking still announces itself per Run.
  const extendedPastOrdinaryBudget = allTimeouts
    && now.getTime() >= budgetStartedAt.getTime() + SPECIFICATION_READ_DEFERRAL_BUDGET_MS;
  return {
    action: "defer",
    nextAttemptAt,
    evidence: {
      body: `Review claim deferred after transient specification read failure; attempt ${attempt} will be eligible at ${nextAttemptAt.toISOString()}`,
      metadata: {
        condition: SPECIFICATION_READ_DEFERRAL_CONDITION,
        classification: refusal.classification,
        runId: input.runId,
        attempt,
        delayMs,
        transientCause,
        budgetMs,
        budgetStartedAt: budgetStartedAt.toISOString(),
        budgetDeadlineAt: budgetDeadlineAt.toISOString(),
        nextAttemptAt: nextAttemptAt.toISOString(),
        implementationHeadSha: input.implementationHeadSha,
        lastUnderlyingError: refusal.message,
        lastUnderlyingErrorDetail: refusal.detail,
      },
    },
    notice: extendedPastOrdinaryBudget
      ? {
        dedupeKey: `${SPECIFICATION_READ_DEADLINE_EXTENDED_CONDITION}:${input.taskId}`,
        body: `Specification read keeps exceeding its deadline under host load; the claim deferral window was extended past `
          + `${SPECIFICATION_READ_DEFERRAL_BUDGET_MS}ms to ${SPECIFICATION_READ_TIMEOUT_DEFERRAL_CEILING_MS}ms. `
          + `The task stays queued and will be parked if the ceiling is reached. Last underlying error: ${refusal.detail}`,
      }
      : null,
  };
}
