import { RUN_STATUS_IS_ACTIVE } from "@anneal/db/board-contract";
import { type ChainControlActionKind, chainControlAction } from "./chain-aggregate";
import { formatDateTime, formatT } from "./format";
import { cronProse } from "./schedule";
import type { BoardLatestRun, BoardTask, ChainAggregate, RunStatus, TaskStatus } from "./types";

/** The board's five columns, in the order they are read. Backlog is first: it is
 *  where work waits before it is queued, and the scheduler never picks anything
 *  out of it. */
export const COLUMNS: Array<{ status: TaskStatus; labelKey: string }> = [
  { status: "BACKLOG", labelKey: "tasks.column.BACKLOG" },
  { status: "TODO", labelKey: "tasks.column.TODO" },
  { status: "DOING", labelKey: "tasks.column.DOING" },
  { status: "REVIEW", labelKey: "tasks.column.REVIEW" },
  { status: "DONE", labelKey: "tasks.column.DONE" },
];

export const STATUSES: TaskStatus[] = COLUMNS.map((column) => column.status);

/** One page per status keeps mounted card and reconciliation work independent
 * of how much completed history the project retains. */
export const CARD_PAGE_SIZE = 20;

export const statusLabel = (status: TaskStatus): string =>
  formatT(COLUMNS.find((column) => column.status === status)?.labelKey ?? `status.task.${status}`);

/** A `?status=` value the board is willing to act on, or null. */
export const parseStatus = (raw: string | null | undefined): TaskStatus | null => {
  const upper = (raw ?? "").toUpperCase();
  return STATUSES.find((status) => status === upper) ?? null;
};

export type Counts = Record<TaskStatus, number>;
const DEFAULT_STATUS: TaskStatus = "TODO";

export const countByStatus = (tasks: readonly { status: TaskStatus }[]): Counts => {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Counts;
  for (const task of tasks) counts[task.status] += 1;
  return counts;
};

/**
 * Which tab a project's board opens on when nothing has been chosen yet.
 *
 * Todo first, because that is the queue an operator opens the board to look at.
 * Done is never reached by this function even when it holds 97 of 112 cards:
 * "most rows" is not "most interesting", and a board that opens on finished work
 * has answered a question nobody asked.
 */
export const defaultTab = (counts: Counts): TaskStatus => {
  if (counts.TODO > 0) return DEFAULT_STATUS;
  return STATUSES.filter((status) => status !== "DONE").find((status) => counts[status] > 0) ?? DEFAULT_STATUS;
};

/* ---------------------------------------------------------------- the chain */

export type ChainBinding = { id: string; name: string | null };

/**
 * Which chain a board card belongs to.
 *
 * Read through this rather than off `chainId`, because an autonomous merge-tail
 * repair task has no chain columns at all — it is created chain-detached so the
 * chain stays a static, linear, once-through structure — and the API resolves
 * its chain from the repair marker instead. Both answers are the same fact, and
 * the filter, the card badge and the page's filter control all have to give the
 * same one.
 */
export const chainBinding = (task: Pick<BoardTask, "chainId" | "chainName" | "repairOf">): ChainBinding | null => {
  if (task.chainId !== null) return { id: task.chainId, name: task.chainName };
  const repair = task.repairOf;
  return repair === null ? null : { id: repair.chainId, name: repair.chainName };
};

/** What the chain is called on screen: its name where the API could derive one,
 *  and a short form of its id where it could not. */
export const chainBindingLabel = (binding: ChainBinding): string => binding.name ?? binding.id.slice(0, 8);

/* --------------------------------------------------------------- projection */

export type TaskBoardEntry = { kind: "task"; id: string; status: TaskStatus; task: BoardTask };
export type ChainBoardEntry = {
  kind: "chain";
  id: string;
  status: TaskStatus;
  aggregate: ChainAggregate;
  /** Raw members are retained only for the chain filter and for resolving a
   * representative step when an older projection omitted its ordinal. */
  members: BoardTask[];
  representativeTaskId: string;
};
export type BoardEntry = TaskBoardEntry | ChainBoardEntry;

export const taskBoardEntry = (task: BoardTask): TaskBoardEntry => ({
  kind: "task", id: task.id, status: task.status, task,
});

export const isBoardEntry = (value: BoardEntry | BoardTask): value is BoardEntry =>
  "kind" in value && (value.kind === "task" || value.kind === "chain");

/** Collapse raw board rows into the entries both board shells render. Grouping
 * uses `chainBinding`, so chain-detached merge-tail repairs stay with their
 * chain even though they have no chain columns of their own. */
export const boardEntries = (tasks: readonly BoardTask[]): BoardEntry[] => {
  const order: Array<TaskBoardEntry | { kind: "chain-group"; id: string }> = [];
  const groups = new Map<string, { members: BoardTask[] }>();
  for (const task of tasks) {
    const binding = chainBinding(task);
    if (binding === null) {
      order.push(taskBoardEntry(task));
      continue;
    }
    const group = groups.get(binding.id);
    if (group) group.members.push(task);
    else {
      groups.set(binding.id, { members: [task] });
      order.push({ kind: "chain-group", id: binding.id });
    }
  }
  return order.map((item): BoardEntry => {
    if (item.kind !== "chain-group") return item;
    const group = groups.get(item.id)!;
    const { members } = group;
    const aggregate = members.find((member): member is BoardTask & { chainAggregate: ChainAggregate } => (
      member.chainAggregate !== null
    ))!.chainAggregate;
    const representativeTaskId = aggregate.detailTaskId;
    return {
      kind: "chain",
      id: `chain:${aggregate.chainId}`,
      status: aggregate.status,
      aggregate,
      members,
      representativeTaskId,
    };
  });
};

export const boardEntriesByStatus = (entries: readonly BoardEntry[]): Map<TaskStatus, BoardEntry[]> => {
  const groups = new Map<TaskStatus, BoardEntry[]>(COLUMNS.map((column) => [column.status, []]));
  for (const entry of entries) groups.get(entry.status)?.push(entry);
  for (const [status, rows] of groups) groups.set(status, orderColumn(rows));
  return groups;
};

/** One parked chain, as the Todo column's head action needs it: the name it is
 *  listed under, how many steps go with it, and the activation task the start
 *  request is sent to. */
export type ParkedChain = { chainId: string; name: string; stepCount: number; taskId: string };

/** A chain action target carries the first task address used by the chain
 * control routes. It intentionally has the same shape as `ParkedChain`: the
 * board can keep one small, named projection for both column-head waves. */
export type HoldableChain = ParkedChain;

/** Every chain in these entries whose admissible action is `kind`, in the order
 * they are read. Single-task cards are not chains and never appear. The rule
 * itself lives in `chain-aggregate.ts`, so a column head and the card it sits
 * above can never answer differently. */
const chainWave = (
  entries: readonly BoardEntry[],
  kind: ChainControlActionKind,
): ParkedChain[] =>
  entries.flatMap((entry) => {
    if (entry.kind !== "chain") return [];
    const { chainId, chainName, stepCount } = entry.aggregate;
    const action = chainControlAction(entry.aggregate.activation);
    if (action?.kind !== kind) return [];
    return [{ chainId, name: chainBindingLabel({ id: chainId, name: chainName }), stepCount, taskId: action.taskId }];
  });

/** The chains the Todo column head would activate: a `waiting-on-predecessor`
 * chain dispatches itself when its predecessor completes, so offering to start
 * it would be offering to do something the control plane already owns. */
export const parkedChains = (entries: readonly BoardEntry[]): ParkedChain[] =>
  chainWave(entries, "activate");

/** The chains the Doing column head can hold in one operator wave. A chain
 * already carrying a persisted hold is offered Resume instead, so the column
 * head never sends a second hold request to one. */
export const heldChains = (entries: readonly BoardEntry[]): HoldableChain[] =>
  chainWave(entries, "hold");

/* ------------------------------------------------------------- the schedule */

export type ScheduleSubject = Pick<
  BoardTask, "scheduleKind" | "runAt" | "cron" | "timezone" | "status" | "chainId" | "chainIndex" | "chainProgress"
>;
const WAITING_STATUSES = new Set<TaskStatus>(["TODO", "BACKLOG"]);

/**
 * Is this task's `runAt` a parking value rather than a schedule?
 *
 * A chain step past the first one is started by its execution layer becoming
 * eligible — the control plane enqueues that layer — so the clock is not what
 * will start it, whatever `runAt` says. Chains are in fact
 * created with `runAt` pushed far out (the live board's are all 2099-01-01)
 * precisely so the scheduler's `runAt <= now` sweep never picks them up.
 *
 * Derived from the chain columns, not from the sentinel date: a magic constant
 * would be a second, undocumented contract between whoever writes the chain and
 * this renderer, and would start lying the day someone parks a step at 2098.
 * The *first* step of a chain is excluded because the scheduler genuinely can
 * fire it, so its `runAt` is a real answer to "when does this run".
 */
export const chainParked = (task: ScheduleSubject): boolean =>
  task.scheduleKind === "AT"
  && task.chainId !== null
  && task.chainIndex !== null
  && task.chainProgress?.position !== 1;

/**
 * The one-line answer to "what starts this task", for the board card, or null
 * where there is no answer worth a row.
 *
 * Never the raw enum: `AT` lower-cased to a lone "at" is what 42 of the live
 * board's 112 cards showed, which reads as a rendering accident rather than a
 * schedule. And never the parking date either — 2099-01-01 is an implementation
 * detail of how chains are held back, not something an operator should have to
 * decode.
 *
 * `NOW` is null for the same reason `MANUAL` renders no provenance pill: it is
 * the default, true of nearly every card, so a row saying "Once" on all of them
 * is filler taking a line from the title. Every value that distinguishes one
 * card from the next — cron prose, a time, a chain's wait — still renders.
 */
export const scheduleLabel = (task: ScheduleSubject): string | null => {
  if (task.scheduleKind === "NOW") return null;
  if (task.scheduleKind === "CRON") return cronProse(task.cron, task.timezone);
  if (chainParked(task)) {
    // The same fact from two sides: a step that has not started is waiting, and
    // one that has is no longer waiting for anything.
    return WAITING_STATUSES.has(task.status)
      ? formatT("tasks.schedule.waitingForPrevious")
      : formatT("tasks.schedule.startedByChain");
  }
  return task.runAt === null
    ? formatT("tasks.schedule.notScheduled")
    : formatT("tasks.schedule.atTime", { time: formatDateTime(task.runAt) });
};

/**
 * The order one column's cards are read in: newest first, every column.
 *
 * `GET /tasks` answers newest-first (`createdAt desc`, ties by id ascending) and
 * every column reports what just happened, Backlog included — Backlog was read
 * oldest-first as a queue, which put the newest card where no other column keeps
 * it. A chain entry carries its own creation time, so the order is stated here
 * rather than inherited from the response; the sort is stable, which is what
 * leaves the API's tiebreak intact for cards created in the same instant.
 */
export const orderColumn = <T extends BoardTask | BoardEntry>(tasks: readonly T[]): T[] => {
  const createdAt = (entry: T): string => isBoardEntry(entry)
    ? entry.kind === "task" ? entry.task.createdAt : entry.aggregate.createdAt
    : entry.createdAt;
  return [...tasks].sort((left, right) => (
    createdAt(left) > createdAt(right) ? -1 : createdAt(left) < createdAt(right) ? 1 : 0
  ));
};

/* ------------------------------------------------------------- run liveness */

export { ACTIVE_RUN_STATUSES } from "@anneal/db/board-contract";

const isActiveRunStatus = (status: RunStatus): boolean => RUN_STATUS_IS_ACTIVE[status];

/** The run fields the rule reads. Both projections carry them, so a caller
 *  hands over whichever it holds: the board's `BoardLatestRun` or the detail
 *  page's `Run`. */
export type RunLivenessSubject = { status: RunStatus; startedAt: string | null };

/** Everything a card says about a run's liveness. */
export type RunLiveness = {
  /** The control plane still owns this run. Cancellation is offered on it, and
   *  a retry is not. */
  live: boolean;
  /** The instant an elapsed clock counts from, or null where no clock runs. A
   *  run that has not started has nothing to count from, and a terminal run's
   *  `startedAt` belongs to a duration that already ended. */
  elapsedSince: string | null;
  /** RUNNING is the one status word a clock replaces: the amber dot already
   *  says the run is live and the elapsed time says more than the word. Every
   *  other status still names itself, because nothing else beside the line
   *  distinguishes queued from waiting inbox. That is the rule where the line
   *  draws its own clock; the task card's footer names the phase instead, so
   *  its line drops the word for every live status (see `ElapsedOwner`). */
  statusSuppressed: boolean;
};

/**
 * The single answer to "is this run live, and whose clock shows".
 *
 * Stated once because the board card, the aggregate card and the detail page
 * all ask it: a CLAIMED run with a `startedAt` used to take an elapsed clock
 * from the aggregate card's run line and a `timeAgo` from the task card's
 * footer, which are two answers to one question about one run.
 */
export const runLiveness = (run: RunLivenessSubject): RunLiveness => {
  const live = isActiveRunStatus(run.status);
  const elapsedSince = live && run.startedAt !== null ? run.startedAt : null;
  return { live, elapsedSince, statusSuppressed: run.status === "RUNNING" && elapsedSince !== null };
};

/* ------------------------------------------------------------- the badges */

/**
 * How long a run may go without reporting progress before the card calls it
 * stalled. The card's own threshold, not the runner's: the runner measures its
 * `stallTimeoutMs` from the same `lastProgressEventAt`, so this sits below it
 * and names the run before the runner gives up on it.
 */
export const STALLED_AFTER_MS = 5 * 60_000;

/** Which baseline comparison the over-baseline badge fired on. */
export type OverBaselineMetric = "cost" | "duration" | "both";

/** One anomaly a card calls out on its newest run, with the figures its hover
 *  text names. */
export type CardBadge =
  | { kind: "stalled" }
  | { kind: "over-baseline"; metric: OverBaselineMetric; sampleSize: number }
  | { kind: "retries"; n: number; max: number };

const ms = (instant: string): number => new Date(instant).getTime();

/**
 * Twice the step's usual figure, on either metric that has both a baseline and
 * a reading. Null on either side is unknown and never compared.
 *
 * The executing time is compared live, which `run-metrics.ts` refuses to do
 * for its `durationRatio`: a ratio below one on an unfinished run would report
 * "not finished yet" as "faster than usual". The comparison here is only ever
 * read in the other direction — a run that has already passed twice the p50 of
 * completed runs is over it whatever it does next — so the live reading is
 * sound.
 */
const overBaseline = (task: Pick<BoardTask, "baseline">, run: BoardLatestRun, now: number): CardBadge | null => {
  const { baseline } = task;
  if (baseline === null) return null;
  const cost = baseline.costUsd !== null && run.costUsd !== null && Number(run.costUsd) > 2 * baseline.costUsd.p50;
  const duration = baseline.durationMs !== null && run.startedAt !== null
    && (run.endedAt === null ? now : ms(run.endedAt)) - ms(run.startedAt) > 2 * baseline.durationMs.p50;
  if (!cost && !duration) return null;
  return { kind: "over-baseline", metric: cost && duration ? "both" : cost ? "cost" : "duration", sampleSize: baseline.sampleSize };
};

/**
 * The anomaly badges a card shows for its newest run, in the order they read.
 *
 * `now` is a parameter so the two clocks here — silence since the last progress
 * event, and a live executing phase against the baseline — are stated against
 * one instant and can be tested at any. A run with nothing to compare against
 * gets no badge: the absence of a figure is unknown, not zero, and a badge on
 * unknown data would be an accusation.
 */
export const cardBadges = (task: Pick<BoardTask, "latestRun" | "baseline">, now: number): CardBadge[] => {
  const run = task.latestRun;
  if (run === null) return [];
  const stalled = run.phase === "executing" && run.lastProgressEventAt !== null
    && now - ms(run.lastProgressEventAt) > STALLED_AFTER_MS;
  const over = overBaseline(task, run, now);
  return [
    ...(stalled ? [{ kind: "stalled" } as const] : []),
    ...(over === null ? [] : [over]),
    // Run numbers are dense and one-based, so the newest run's number is how
    // many runs the task has had; a first run is not a retry.
    ...(run.runNumber >= 2 ? [{ kind: "retries", n: run.runNumber, max: run.maxRunsPerTask } as const] : []),
  ];
};

/* -------------------------------------------------------------- the actions */

/**
 * What the retry affordance may offer for this task.
 *
 * A retry only lands once the last run is terminal and the task still has run
 * budget; the API rejects the rest. `budget-exhausted` is separated from
 * `unavailable` because it is the one refusal the operator can lift — the
 * detail page shows it as a disabled control pointing at the budget field,
 * rather than as an enabled button the API answers with a 409.
 *
 * Takes the run separately because the two callers hold it differently — the
 * board card gets one projected `latestRun`, the detail page has the whole `runs`
 * array — and a rule the board and the detail page could state differently is a
 * rule the operator gets two answers from. `budgetRemaining` comes off the
 * projection for the same reason: only the server reads a task's configured
 * budget together with the grants its runs carry.
 */
export const retryShape = (
  task: { status: TaskStatus; failureReason: string | null; budgetRemaining: boolean },
  run: { status: RunStatus } | null | undefined,
): "available" | "budget-exhausted" | "unavailable" => {
  if (!run) return "unavailable";
  if (isActiveRunStatus(run.status)) return "unavailable";
  if (task.status !== "REVIEW" && task.failureReason === null && run.status === "SUCCEEDED") return "unavailable";
  return task.budgetRemaining ? "available" : "budget-exhausted";
};

export const retryable = (
  task: { status: TaskStatus; failureReason: string | null; budgetRemaining: boolean },
  run: { status: RunStatus } | null | undefined,
): boolean => retryShape(task, run) === "available";

/* -------------------------------------------------------------- persistence */

/** Per project, so switching projects never inherits another board's tab or
 *  horizontal position — the two boards are different work. */
export const tabKey = (projectId: string): string => `agentos.board.tab.${projectId}`;
export const scrollKey = (projectId: string): string => `agentos.board.scrollLeft.${projectId}`;

/**
 * Which card should hold focus after `moved` leaves the list it was in.
 *
 * Returns the card itself when it is still on screen (the desktop board, where a
 * move only changes column), the next card down when it is not, the one above
 * when it was last, and null when the list is now empty and the container has to
 * take the focus instead.
 */
export const focusAfterMove = (visible: readonly string[], moved: string, before: readonly string[]): string | null => {
  if (visible.includes(moved)) return moved;
  const index = before.indexOf(moved);
  if (index === -1) return visible[0] ?? null;
  const after = before.slice(index + 1).find((id) => visible.includes(id));
  if (after !== undefined) return after;
  const above = [...before.slice(0, index)].reverse().find((id) => visible.includes(id));
  return above ?? visible[0] ?? null;
};

/* ------------------------------------------------------ horizontal movement */

/** How far one `<`/`>` press moves the board: one column plus the gap, so a
 *  press always lands the next column against the same edge. */
export const columnStep = (board: { scrollWidth: number; clientWidth: number }, columns: number, gap: number): number =>
  (columns <= 0 ? board.clientWidth : (board.scrollWidth - gap * (columns - 1)) / columns + gap);

/** Clamp a target scroll position into the board's own range, so the buttons
 *  cannot leave it a fraction of a pixel short of an edge and stay enabled. */
export const clampScroll = (target: number, board: { scrollWidth: number; clientWidth: number }): number =>
  Math.max(0, Math.min(Math.round(target), Math.max(0, board.scrollWidth - board.clientWidth)));

/** A pixel of slack at each end. Chrome reports `scrollWidth`/`scrollLeft`
 *  fractionally at fractional zoom levels, and a board sitting 0.4px short of
 *  its end with an enabled `>` button that moves nothing is a broken control. */
const EDGE_SLACK = 1;

export type ScrollBox = { scrollLeft: number; scrollWidth: number; clientWidth: number };
export type Edges = { overflowing: boolean; atStart: boolean; atEnd: boolean };

/** What the two arrows and the two edge fades are both driven by. A board that
 *  does not overflow is at both ends at once, which is exactly the state that
 *  disables both arrows and draws neither fade. */
export const edgeState = (box: ScrollBox): Edges => {
  const furthest = Math.max(0, box.scrollWidth - box.clientWidth);
  return {
    overflowing: furthest > EDGE_SLACK,
    atStart: box.scrollLeft <= EDGE_SLACK,
    atEnd: box.scrollLeft >= furthest - EDGE_SLACK,
  };
};

export const sameEdges = (a: Edges, b: Edges): boolean =>
  a.overflowing === b.overflowing && a.atStart === b.atStart && a.atEnd === b.atEnd;

/** The remembered horizontal position, made safe to assign.
 *
 *  `storage` hands back whatever is in `localStorage`, which is whatever was
 *  there before this build — and a stale position from a wider viewport, or from
 *  a project with more columns of content, would otherwise leave the board
 *  scrolled past its own end on arrival. */
export const storedScroll = (raw: string | null | undefined, board: ScrollBox): number => {
  const value = Number(raw);
  return raw === null || raw === undefined || raw === "" || !Number.isFinite(value)
    ? 0
    : clampScroll(value, board);
};
