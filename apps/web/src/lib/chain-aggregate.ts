import { RUN_STATUS_IS_ACTIVE } from "@anneal/db/board-contract";

import type { BoardLatestRun, BoardTask, ChainAggregate, UsageCost } from "./types";

/**
 * The one place the client reads an operator-facing answer off a Chain
 * aggregate: which control action is admissible on it, which Step number its
 * card names, and what the chain has cost, how long it has run, and how many
 * repair rounds it took.
 *
 * "Can this Chain be held right now?" used to be answered twice — once by the
 * aggregate card, which read `activation.state`, and once by the Doing column
 * head, which read only `activation.hold`. The two rules disagreed for a
 * `settled` or `idle` Chain with a non-null `activation.taskId`: the column
 * swept it into the Hold-all wave while its own card offered no Hold button.
 * One module, one answer, three renders.
 */

export type ChainControlActionKind = "activate" | "hold" | "resume";

/** At most one action is admissible at a time: the states that admit Activate
 *  are disjoint from those that admit Hold or Resume, so the card, the column
 *  head and the page all decide from the same single answer. `taskId` is the
 *  activation Task every chain control route is addressed to; it names the
 *  first primary Step, which keeps the request independent of whichever
 *  frontier happens to be visible. */
export type ChainControlAction = { kind: ChainControlActionKind; taskId: string };

/**
 * The action an operator may take on this Chain, or `null` for none.
 *
 * The full matrix of `activation.state` by `activation.hold`:
 *
 * | state                  | hold null | hold set |
 * | ---------------------- | --------- | -------- |
 * | parked-unactivated     | activate  | none     |
 * | waiting-on-predecessor | hold      | none     |
 * | running                | hold      | resume   |
 * | held                   | none      | resume   |
 * | idle                   | none      | none     |
 * | settled                | none      | none     |
 *
 * Half of that matrix the board projection cannot produce: it derives `held`
 * from a persisted hold and `running` from an active member, so a non-null
 * `hold` never arrives on any other state. Those cells offer nothing rather
 * than guessing an action for a shape the projection forbids.
 *
 * `settled` matches the server, which refuses a Hold on a completed Chain
 * outright ("there is nothing left to hold"). `idle` is the narrower client
 * rule: the server would accept a Hold there, but an `idle` Chain has no
 * admitted layer in flight and no predecessor about to release it, and the
 * board offers Hold all on Doing only, which an `idle` aggregate never reaches.
 */
export const chainControlAction = (
  activation: ChainAggregate["activation"],
): ChainControlAction | null => {
  const { hold, state, taskId } = activation;
  if (taskId === null) return null;
  if (hold === null) {
    if (state === "parked-unactivated") return { kind: "activate", taskId };
    if (state === "waiting-on-predecessor" || state === "running") return { kind: "hold", taskId };
    return null;
  }
  // A hold on a Chain that is still running is a barrier after the current
  // layer, not a cancellation: the Run keeps going, so the only thing left to
  // offer is lifting the barrier.
  if (state === "held" || state === "running") return { kind: "resume", taskId };
  return null;
};

/**
 * The dense one-based Step number the aggregate card names, counting down three
 * sources in order of directness: the position the projection computed, the
 * position carried by the frontier member itself, and finally the count of
 * settled Steps. The last is a floor, not a measurement — a Chain whose
 * frontier is missing from the rendered members still says which Step it is on
 * rather than saying nothing.
 */
export const chainStepPosition = (
  aggregate: ChainAggregate,
  members: readonly BoardTask[],
): number => {
  const fromFrontier = aggregate.frontier.position;
  if (fromFrontier !== null && fromFrontier !== undefined) return fromFrontier;
  const frontier = members.find((member) => member.id === aggregate.frontier.taskId);
  const fromMember = frontier === undefined
    ? null
    : frontier.chainProgress?.position ?? (frontier.chainIndex === null ? null : Math.min(aggregate.stepCount, frontier.chainIndex + 1));
  if (fromMember !== null && fromMember !== undefined) return fromMember;
  const done = aggregate.statusCounts.DONE;
  return aggregate.stepCount === 0 ? 0 : Math.min(aggregate.stepCount, done + 1);
};

/** What a collapsed chain card answers without opening anything. `cost` and
 *  `leadTimeMs` are `null` when unknown; `repairRounds` is a count, so zero is
 *  a real answer there. */
export type ChainAggregateFigures = {
  cost: UsageCost | null;
  leadTimeMs: number | null;
  repairRounds: number;
};

/** Every run the board rows hold for this chain: each visible member's latest
 *  run, plus the frontier's and the active repair's, which the aggregate
 *  carries even when their own rows are off the page. */
const knownRuns = (aggregate: ChainAggregate, members: readonly BoardTask[]): BoardLatestRun[] =>
  [
    ...members.map((member) => member.latestRun),
    aggregate.frontier.latestRun,
    aggregate.activeRepair?.latestRun ?? null,
  ].filter((run): run is BoardLatestRun => run !== null && run !== undefined);

const epoch = (value: string): number => new Date(value).getTime();

/**
 * The three figures a chain card states, derived from what the page already
 * holds: no request is made for them.
 *
 * `cost` is the server's own total. It sums every member's runs across the
 * whole chain, whereas `members` are only the rows on this page, so re-summing
 * `taskCost` client-side would understate a chain whose members are not all
 * visible.
 *
 * `leadTimeMs` runs from the earliest known run start to the chain's most
 * recent known end, or to `now` while any known run is still active — a queued
 * frontier counts, since the chain is still going. Each row carries only its
 * *latest* run, so the start is the earliest the board can prove rather than
 * the chain's true first run: a Step that has been retried has forgotten when
 * its first attempt began. `null` when no run has started, and `null` again
 * when nothing is active and no end was ever recorded — an unmeasured span is
 * not a zero one.
 *
 * `repairRounds` counts the visible repair rows. A detached repair whose own
 * row is off the page still shows through `activeRepair`, which is the one
 * round the board can prove when it can see none.
 */
export const chainAggregateFigures = (
  aggregate: ChainAggregate,
  members: readonly BoardTask[],
  now = Date.now(),
): ChainAggregateFigures => {
  const runs = knownRuns(aggregate, members);
  const starts = runs.flatMap((run) => (run.startedAt === null ? [] : [epoch(run.startedAt)]));
  const ends = runs.flatMap((run) => (run.endedAt === null ? [] : [epoch(run.endedAt)]));
  const active = runs.some((run) => RUN_STATUS_IS_ACTIVE[run.status]);
  const end = active ? now : ends.length === 0 ? null : Math.max(...ends);
  const leadTimeMs = starts.length === 0 || end === null ? null : Math.max(0, end - Math.min(...starts));
  const visibleRepairs = members.filter((member) => member.repairOf !== null).length;
  const repairRounds = visibleRepairs === 0 && aggregate.activeRepair !== null ? 1 : visibleRepairs;
  return { cost: aggregate.totalCost, leadTimeMs, repairRounds };
};
