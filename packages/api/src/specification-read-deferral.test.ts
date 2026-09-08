import assert from "node:assert/strict";
import { test } from "node:test";

import { specificationUnreadableRefusal, type SpecificationReadTransientCause } from "./specification-fidelity.js";
import {
  deferSpecificationRead,
  SPECIFICATION_READ_DEFERRAL_CONDITION,
  specificationReadDeferralHistoryQuery,
  type SpecificationReadDeferralRow,
  specificationReadEpisode,
} from "./specification-read-deferral.js";

const TASK_ID = "task-1";
const RUN_ID = "run-1";
const EPISODE_START = new Date("2026-09-07T12:00:00.000Z");
const MINUTE = 60_000;

const at = (offsetMs: number): Date => new Date(EPISODE_START.getTime() + offsetMs);

const refusalOf = (cause: SpecificationReadTransientCause, detail = "proxy flap") => (
  specificationUnreadableRefusal(detail, "transient", cause)
);

/** A row shaped exactly as `deferSpecificationRead` writes one. */
const rowAt = (
  offsetMs: number,
  cause: SpecificationReadTransientCause,
  detail = "proxy flap",
): SpecificationReadDeferralRow => ({
  createdAt: at(offsetMs),
  metadata: {
    condition: SPECIFICATION_READ_DEFERRAL_CONDITION,
    runId: RUN_ID,
    transientCause: cause,
    lastUnderlyingError: refusalOf(cause, detail).message,
    lastUnderlyingErrorDetail: detail,
  },
});

const episodeOf = (rows: readonly SpecificationReadDeferralRow[]) => specificationReadEpisode(rows);

const decide = (
  rows: readonly SpecificationReadDeferralRow[],
  elapsedMs: number,
  cause: SpecificationReadTransientCause,
  detail = "proxy flap",
) => deferSpecificationRead({
  now: at(elapsedMs),
  prior: episodeOf(rows),
  refusal: refusalOf(cause, detail),
  taskId: TASK_ID,
  runId: RUN_ID,
  implementationHeadSha: "head-sha",
});

type DeferralCase = {
  name: string;
  prior: readonly SpecificationReadDeferralRow[];
  elapsedMs: number;
  cause: SpecificationReadTransientCause;
  attempt: number;
  delayMs: number;
  nextAttemptOffsetMs: number;
  budgetMs: number;
  notified: boolean;
};

const timeouts = (count: number): SpecificationReadDeferralRow[] => (
  Array.from({ length: count }, (_, index) => rowAt(index * 15_000, "timeout"))
);
const transports = (count: number): SpecificationReadDeferralRow[] => (
  Array.from({ length: count }, (_, index) => rowAt(index * 15_000, "other"))
);

const DEFERRALS: DeferralCase[] = [
  {
    name: "a first transient failure starts the ordinary budget on the first rung",
    prior: [], elapsedMs: 0, cause: "other",
    attempt: 1, delayMs: 15_000, nextAttemptOffsetMs: 15_000, budgetMs: 5 * MINUTE, notified: false,
  },
  {
    name: "a first deadline hit starts the extended ceiling on the first rung",
    prior: [], elapsedMs: 0, cause: "timeout",
    attempt: 1, delayMs: 15_000, nextAttemptOffsetMs: 15_000, budgetMs: 30 * MINUTE, notified: false,
  },
  {
    name: "the second attempt takes the second rung",
    prior: transports(1), elapsedMs: 20_000, cause: "other",
    attempt: 2, delayMs: 30_000, nextAttemptOffsetMs: 50_000, budgetMs: 5 * MINUTE, notified: false,
  },
  {
    name: "the third attempt takes the last rung",
    prior: transports(2), elapsedMs: 60_000, cause: "other",
    attempt: 3, delayMs: 60_000, nextAttemptOffsetMs: 120_000, budgetMs: 5 * MINUTE, notified: false,
  },
  {
    name: "every attempt past the ladder keeps its last rung",
    prior: transports(4), elapsedMs: 2 * MINUTE, cause: "other",
    attempt: 5, delayMs: 60_000, nextAttemptOffsetMs: 3 * MINUTE, budgetMs: 5 * MINUTE, notified: false,
  },
  {
    name: "the next attempt clamps to the budget deadline instead of overshooting it",
    prior: transports(1), elapsedMs: 4 * MINUTE + 50_000, cause: "other",
    attempt: 2, delayMs: 30_000, nextAttemptOffsetMs: 5 * MINUTE, budgetMs: 5 * MINUTE, notified: false,
  },
  {
    name: "an all-deadline episode keeps deferring past the ordinary budget and announces the extension",
    prior: timeouts(2), elapsedMs: 6 * MINUTE, cause: "timeout",
    attempt: 3, delayMs: 60_000, nextAttemptOffsetMs: 6 * MINUTE + 60_000, budgetMs: 30 * MINUTE, notified: true,
  },
  {
    name: "an all-deadline episode inside the ordinary budget announces nothing",
    prior: timeouts(2), elapsedMs: 4 * MINUTE, cause: "timeout",
    attempt: 3, delayMs: 60_000, nextAttemptOffsetMs: 4 * MINUTE + 60_000, budgetMs: 30 * MINUTE, notified: false,
  },
  {
    name: "a deadline hit after a transport failure loses the extended ceiling for the whole episode",
    prior: [rowAt(0, "other"), rowAt(15_000, "timeout")], elapsedMs: 60_000, cause: "timeout",
    attempt: 3, delayMs: 60_000, nextAttemptOffsetMs: 2 * MINUTE, budgetMs: 5 * MINUTE, notified: false,
  },
];

for (const scenario of DEFERRALS) {
  test(scenario.name, () => {
    const decision = decide(scenario.prior, scenario.elapsedMs, scenario.cause);
    assert.equal(decision.action, "defer");
    if (decision.action !== "defer") return;
    assert.deepEqual(decision.nextAttemptAt, at(scenario.nextAttemptOffsetMs));
    const evidence = decision.evidence.metadata as Record<string, unknown>;
    assert.equal(evidence.attempt, scenario.attempt);
    assert.equal(evidence.delayMs, scenario.delayMs);
    assert.equal(evidence.budgetMs, scenario.budgetMs);
    assert.equal(evidence.transientCause, scenario.cause);
    assert.equal(evidence.condition, SPECIFICATION_READ_DEFERRAL_CONDITION);
    assert.equal(evidence.runId, RUN_ID);
    assert.equal(evidence.implementationHeadSha, "head-sha");
    assert.equal(evidence.nextAttemptAt, at(scenario.nextAttemptOffsetMs).toISOString());
    assert.equal(evidence.budgetStartedAt, EPISODE_START.toISOString());
    assert.equal(evidence.lastUnderlyingErrorDetail, "proxy flap");
    assert.equal(decision.notice === null, !scenario.notified);
    if (decision.notice) {
      assert.equal(decision.notice.dedupeKey, `specification-read-deadline-extended:${TASK_ID}`);
      assert.match(decision.notice.body, /extended past 300000ms to 1800000ms/u);
      assert.match(decision.notice.body, /Last underlying error: proxy flap/u);
    }
  });
}

test("the extension notice is keyed to the task, so a later deferral of the same episode repeats the key", () => {
  const first = decide(timeouts(2), 6 * MINUTE, "timeout");
  const second = decide(timeouts(3), 7 * MINUTE, "timeout");
  assert.equal(first.action === "defer" && first.notice?.dedupeKey, `specification-read-deadline-extended:${TASK_ID}`);
  assert.equal(second.action === "defer" && second.notice?.dedupeKey, `specification-read-deadline-extended:${TASK_ID}`);
});

test("a transport episode that reaches its budget exhausts on the ordinary budget", () => {
  const decision = decide(transports(2), 5 * MINUTE, "other", "proxy flap 7");
  assert.equal(decision.action, "exhaust");
  if (decision.action !== "exhaust") return;
  assert.equal(decision.refusal.reason, "spec-transcription-unreadable");
  assert.equal(decision.refusal.classification, "transient");
  assert.match(decision.refusal.message, /transient read deferral budget exhausted after 300000ms \(budget 300000ms\)/u);
  assert.match(decision.refusal.message, /last underlying error: proxy flap 7/u);
  const metadata = decision.metadata as Record<string, unknown>;
  assert.equal(metadata.exhaustedCondition, SPECIFICATION_READ_DEFERRAL_CONDITION);
  assert.equal(metadata.budgetMs, 5 * MINUTE);
  assert.equal(metadata.transientCause, "other");
  assert.equal(metadata.budgetStartedAt, EPISODE_START.toISOString());
  assert.equal(metadata.implementationHeadSha, "head-sha");
});

test("an all-deadline episode that reaches the ceiling exhausts naming the deadline, not an unreadable specification", () => {
  const decision = decide(timeouts(3), 30 * MINUTE, "timeout", "read exceeded the 1800ms server deadline");
  assert.equal(decision.action, "exhaust");
  if (decision.action !== "exhaust") return;
  assert.equal(decision.refusal.reason, "spec-read-deadline-exceeded");
  assert.match(
    decision.refusal.message,
    /deadline under host load on all 3 deferred attempts over 1800000ms \(deferral ceiling 1800000ms\)/u,
  );
  assert.equal(/unreadable/u.test(decision.refusal.message), false);
  assert.equal((decision.metadata as Record<string, unknown>).transientCause, "timeout");
});

test("one transport failure parks an extended all-deadline episode on the ordinary budget it already outran", () => {
  const decision = decide(timeouts(3), 12 * MINUTE, "other", "proxy flap after the extension");
  assert.equal(decision.action, "exhaust");
  if (decision.action !== "exhaust") return;
  assert.equal(decision.refusal.reason, "spec-transcription-unreadable");
  // The window named is the one the episode ran; the budget named is the one it parked on.
  assert.match(decision.refusal.message, /exhausted after 720000ms \(budget 300000ms\)/u);
  assert.match(decision.refusal.message, /last underlying error: proxy flap after the extension/u);
  assert.equal((decision.metadata as Record<string, unknown>).transientCause, "other");
});

test("before the read, an episode with budget left proceeds and an exhausted one parks on its persisted evidence", () => {
  const prior = episodeOf(transports(2));
  const proceed = deferSpecificationRead({
    now: at(4 * MINUTE), prior, refusal: null, taskId: TASK_ID, runId: RUN_ID, implementationHeadSha: "head-sha",
  });
  assert.equal(proceed.action, "proceed");
  const exhausted = deferSpecificationRead({
    now: at(5 * MINUTE), prior, refusal: null, taskId: TASK_ID, runId: RUN_ID, implementationHeadSha: "head-sha",
  });
  assert.equal(exhausted.action, "exhaust");
  if (exhausted.action !== "exhaust") return;
  assert.match(exhausted.refusal.message, /last underlying error: proxy flap$/u);
});

test("a Run that has never deferred has no episode and proceeds", () => {
  assert.equal(episodeOf([]), null);
  assert.equal(deferSpecificationRead({
    now: EPISODE_START, prior: null, refusal: null, taskId: TASK_ID, runId: RUN_ID, implementationHeadSha: "head-sha",
  }).action, "proceed");
});

test("a deferral row written before the cause was recorded keeps the ordinary budget", () => {
  const legacy: SpecificationReadDeferralRow = {
    createdAt: EPISODE_START,
    metadata: { condition: SPECIFICATION_READ_DEFERRAL_CONDITION, runId: RUN_ID, attempt: 1 },
  };
  const episode = episodeOf([legacy, rowAt(15_000, "timeout")]);
  assert.equal(episode?.allTimeouts, false);
  assert.equal(episode?.budgetMs, 5 * MINUTE);
});

test("a deferral row written before the detail was recorded reads its error out of the persisted message", () => {
  const legacy: SpecificationReadDeferralRow = {
    createdAt: EPISODE_START,
    metadata: {
      condition: SPECIFICATION_READ_DEFERRAL_CONDITION,
      runId: RUN_ID,
      lastUnderlyingError: "Spec transcription claim refused: spec-transcription-unreadable: proxy flap 3",
    },
  };
  assert.equal(episodeOf([legacy])?.lastUnderlyingError, "proxy flap 3");
  assert.equal(
    episodeOf([{ createdAt: EPISODE_START, metadata: { condition: SPECIFICATION_READ_DEFERRAL_CONDITION } }])
      ?.lastUnderlyingError,
    "repository content read failed",
  );
});

test("the history query reads one Run's rows from its latest claim onward, oldest first", () => {
  const claimed = new Date("2026-09-07T11:59:00.000Z");
  const query = specificationReadDeferralHistoryQuery({ taskId: TASK_ID, runId: RUN_ID, claimedAt: claimed });
  assert.deepEqual(query.where, {
    taskId: TASK_ID,
    createdAt: { gt: claimed },
    AND: [
      { metadata: { path: ["condition"], equals: SPECIFICATION_READ_DEFERRAL_CONDITION } },
      { metadata: { path: ["runId"], equals: RUN_ID } },
    ],
  });
  assert.deepEqual(query.orderBy, [{ createdAt: "asc" }, { id: "asc" }]);
  const unclaimed = specificationReadDeferralHistoryQuery({ taskId: TASK_ID, runId: RUN_ID, claimedAt: null });
  assert.equal("createdAt" in unclaimed.where, false);
});
