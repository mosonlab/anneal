import { type ReactNode, memo, useEffect, useState } from "react";

import { chainPositionMarker } from "../lib/chain";
import { duration, formatT, money, timeAgo, usageCostAmount, usageCostLabel } from "../lib/format";
import {
  type CardBadge, STALLED_AFTER_MS, cardBadges, chainBinding, chainBindingLabel, retryable, runLiveness, scheduleLabel,
  statusLabel,
} from "../lib/board";
import { type Translate, useT } from "../lib/i18n";
import type { BoardLatestRun, BoardTask, TaskStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { BoardCardShell, CardPullRequest } from "./board-card-shell";
import { IconRobot, IconUser } from "./icons";
import { RunLine } from "./run-line";
import { Pill, type PillTone, ROW, type RowMenuEntry } from "./ui";

const TASK_PILL = "py-0";

/**
 * The assignee, one line, with the rest of the name a keypress away.
 *
 * 59 of the live board's 112 cards truncated this name with no way to see the
 * whole of it — `title` alone is a hover affordance, which is no affordance at
 * all on a touch screen or from the keyboard. A button is the honest element:
 * it is what says "there is more here, and you can ask for it".
 */
const Assignee = ({ name, label }: { name: string; label: string }): ReactNode => {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      title={name}
      aria-expanded={open}
      aria-label={label}
      className={cn(
        "min-w-0 rounded-sm border-0 bg-transparent p-0 text-left text-inherit hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-[color:var(--ring)]",
        open ? "[overflow-wrap:anywhere] whitespace-normal" : "overflow-hidden text-ellipsis whitespace-nowrap",
      )}
      onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
    >
      {name}
    </button>
  );
};

export type CardActions = {
  onMove: (task: BoardTask, status: TaskStatus) => void;
  onRetry: (task: BoardTask) => void;
  onArchive: (task: BoardTask) => void;
  onDelete: (task: BoardTask) => void;
  onCopyError: (task: BoardTask) => void;
  onFilterChain: (task: BoardTask) => void;
};

export type CardProps = {
  task: BoardTask;
  actions: CardActions;
  /** Desktop only. Touch has the menu's `Move to` instead: HTML5 drag does not
   *  exist on touch, and a card that looks draggable and is not is worse than
   *  one that does not. */
  draggable?: boolean;
};

export const cardTitle = (task: BoardTask): string => {
  return task.displayName;
};

/** What the card's model line says. The line sits under the run line, so it is
 *  the run's claimed model; a task with no run has only the assignee's
 *  configured model to show. */
export const cardModel = (task: BoardTask): string | null =>
  task.latestRun?.model ?? task.assigneeAgent?.model ?? null;

const cardModelFast = (task: BoardTask, model: string): string => {
  const tier = task.latestRun?.codexServiceTier;
  return tier === "FAST" ? `${model} · fast` : model;
};

export const cardTime = (task: BoardTask, now = Date.now()): string => {
  const run = task.latestRun;
  if (!run) return timeAgo(task.updatedAt);
  // A live run says so with the run line's amber dot; the footer is left with
  // what the dot cannot say, which is where the run is and how long it has been
  // there. An Inbox wait has no recorded start, so it is named and not timed:
  // null is unknown, never a zero.
  if (runLiveness(run).live) {
    const phase = formatT(`tasks.phase.${run.phase}`);
    return run.phaseSince === null ? phase : `${phase} · ${duration(run.phaseSince, null, now)}`;
  }
  if (run.startedAt !== null && run.endedAt !== null) {
    return `${duration(run.startedAt, run.endedAt)} · ${timeAgo(task.updatedAt)}`;
  }
  return timeAgo(task.updatedAt);
};

/**
 * The card's one clock, ticking only while the newest run is live.
 *
 * One instant for the whole card rather than a clock in the footer text alone:
 * the badges read the same `now` — silence since the last progress event, a
 * live executing phase against the baseline — and a stall is precisely the
 * case where the polled row stops changing, so a memoized card that only
 * re-derived them on new props would never show the one badge that matters.
 * Re-armed on the phase start, so the clock restarts with the phase. Memoized
 * inactive cards never wake: nothing about a finished run moves with the time
 * of day.
 */
const useLiveNow = (run: BoardLatestRun | null): number => {
  const live = run !== null && runLiveness(run).live;
  const since = run?.phaseSince ?? null;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live, since]);
  return now;
};

/** What each badge says, and the tone it says it in: amber where a runner is
 *  still owed something, grey for the inert count of attempts. */
const badgeCopy = (badge: CardBadge, t: Translate): { tone: PillTone; label: string; title: string } => {
  switch (badge.kind) {
    case "stalled":
      return {
        tone: "amber",
        label: t("tasks.badge.stalled"),
        title: t("tasks.badge.stalled.title", { minutes: STALLED_AFTER_MS / 60_000 }),
      };
    case "over-baseline":
      return {
        tone: "amber",
        label: t("tasks.badge.overBaseline"),
        title: t("tasks.badge.overBaseline.title", { metric: t(`tasks.badge.metric.${badge.metric}`), n: badge.sampleSize }),
      };
    case "retries":
      return {
        tone: "grey",
        label: t("tasks.badge.retries", { n: badge.n, max: badge.max }),
        title: t("tasks.badge.retries.title", { n: badge.n, max: badge.max }),
      };
  }
};

const menu = (task: BoardTask, actions: CardActions, t: Translate): RowMenuEntry[] => {
  const targets = task.moveTargets;
  return [
  ...(retryable(task, task.latestRun) ? [{ label: t("common.retry"), onSelect: () => actions.onRetry(task) }] : []),
  // Only where there is an error to copy, and it copies the whole of it — the
  // card shows three lines and hover-to-expand a 2KB log is not an answer.
  ...(task.failureReason === null ? [] : [{ label: t("tasks.menu.copyError"), onSelect: () => actions.onCopyError(task) }]),
  { label: t("tasks.menu.archive"), onSelect: () => actions.onArchive(task) },
  { label: t("common.delete"), danger: true, onSelect: () => actions.onDelete(task) },
  // The keyboard's and touch's replacement for the drag (K15/K16).
  ...(targets.length === 0 ? [] : [{ kind: "heading" as const, label: t("tasks.menu.moveTo") }]),
  ...targets.map((target) => ({
    label: statusLabel(target.status),
    onSelect: () => actions.onMove(task, target.status),
  })),
  ];
};

const TaskCardBody = ({ task, actions, draggable = false }: CardProps): ReactNode => {
  const t = useT();
  const strandedSalvageBranches = task.strandedSalvageBranches;
  const assignee = task.assigneeAgent?.title ?? null;
  const schedule = scheduleLabel(task);
  const hasScheduleRow = schedule !== null || task.approvalGate || task.source === "CRON" || task.source === "WEBHOOK";
  const model = cardModel(task);
  const modelLine = model === null ? null : cardModelFast(task, model);
  // The footer owns this card's clock and names the phase beside it, so the run
  // line (`elapsed="caller"`) never renders one and never repeats the phase
  // word above it.
  const now = useLiveNow(task.latestRun);
  const badges = cardBadges(task, now);
  const taskCostLabel = usageCostLabel(task.taskCost);
  const hasTokenFallback = task.taskCost !== null && task.taskCost.costUsd === null;
  // The task's own total where there is one, and the newest run's spend where
  // the task cost is only a token count.
  const costAmount = usageCostAmount(task.taskCost)
    ?? (task.latestRun?.costUsd ? money(task.latestRun.costUsd) : null);
  const title = cardTitle(task);
  const chain = chainBinding(task);
  const chainLabel = chain === null ? null : chainBindingLabel(chain);
  const repair = task.repairOf ?? null;
  const metaRows: ReactNode[] = [
    ...(strandedSalvageBranches.length === 0 ? [] : [<span data-card-stranded-salvage="">
      <Pill tone="amber" className={TASK_PILL}>{t("tasks.card.strandedSalvage", { n: strandedSalvageBranches.length })}</Pill>
    </span>]),
    ...(hasScheduleRow ? [<span data-card-schedule="" className="contents">
        {/* Two lines, not one ellipsized one. Measured in a 170px content box:
            "Waiting for previous step" came out as "Waiting for previous st…"
            and a cron's prose as "At 09:00 AM, only on M…". This line is the
            answer to "what starts this task" — an answer cut off two characters
            from the end is not a shorter answer, it is no answer.
            A plain `NOW` task has no row at all; approval and source pills keep
            this shared row when they carry the card's only information. */}
        {schedule === null ? null : <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{schedule}</span>}
        {task.approvalGate ? <Pill tone="amber" className={TASK_PILL}>{t("tasks.pill.approval")}</Pill> : null}
        {/* MANUAL renders nothing: most tasks are manual, and a pill on every
            card would be noise rather than provenance ([A8]). */}
        {task.source === "CRON" ? <Pill tone="grey" className={TASK_PILL}>{t("tasks.pill.cron")}</Pill> : task.source === "WEBHOOK" ? <Pill tone="accent" className={TASK_PILL}>{t("tasks.pill.webhook")}</Pill> : null}
      </span>] : []),
    ...(task.blockedOn ? [<span data-card-blocked-on="" className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
      {t("tasks.card.blockedOn", { name: task.blockedOn.taskName })}
    </span>] : []),
    // A detached merge-tail repair still carries a Chain binding, so this row
    // follows the binding rather than the persisted chain columns.
    ...(chainLabel === null ? [] : [
        <span className="contents">
          <button
            type="button"
            className="max-w-full overflow-hidden text-ellipsis rounded-full border border-border bg-secondary px-[7px] py-[1px] text-secondary-foreground hover:text-foreground"
            title={chainLabel}
            aria-label={t("tasks.card.filterChain", { name: chainLabel })}
            onClick={(event) => { event.stopPropagation(); actions.onFilterChain(task); }}
          >
            {chainLabel}
          </button>
          {/* Which repair this is, in the chain's own row: a repair card carries
              no step ordinal, and the kind is the only thing that distinguishes
              two repairs of the same chain. */}
          {repair === null
            ? null
            : <Pill tone="amber" className={TASK_PILL}>{t("tasks.pill.repair", { kind: repair.repairKind })}</Pill>}
          {/* The board needs only the task's ordinal. Execution layers are a
              scheduling concept rendered by the chain detail page. */}
          <span>{chainPositionMarker(task.chainProgress)}</span>
        </span>,
    ]),
    ...(task.latestRun === null ? [] : [
      <RunLine run={task.latestRun} mergeOutcome={task.mergeOutcome} elapsed="caller" />,
    ]),
    // What is wrong with the newest run, where anything is. Nothing renders on
    // unknown data: `cardBadges` owns which absences are unknown rather than
    // fine, and the hover text names the figure each badge was read against.
    ...(badges.length === 0 ? [] : [
      <span data-card-badges="" className="contents">
        {badges.map((badge) => {
          const copy = badgeCopy(badge, t);
          return (
            <span key={badge.kind} data-card-badge={badge.kind} title={copy.title}>
              <Pill tone={copy.tone} className={TASK_PILL}>{copy.label}</Pill>
            </span>
          );
        })}
      </span>,
    ]),
    /* A readiness Step that was sent back to Regression looks, from the rest of
       the merge-tail line, like any other rerun. The pill is what says the
       reruns were the base moving under an authorized candidate, and how many
       extra attempts that cost. It is its own row rather than part of the run
       line because the readiness Step is settled by the control plane and
       usually has no Run of its own to sit beside. Only that Step ever counts a
       requeue, so a zero renders nothing rather than a pill on every card
       ([A8]). */
    ...(task.readinessRequeues === 0 ? [] : [
      <span data-card-readiness-requeues="">
        <Pill tone="amber" className={TASK_PILL}>
          {t("tasks.pill.readinessRequeue", { n: task.readinessRequeues, grants: task.readinessGrants })}
        </Pill>
      </span>,
    ]),
    ...(modelLine === null ? [] : [<span className="min-w-0 [overflow-wrap:anywhere]" aria-label={t("tasks.card.model", { model: modelLine })}>
      {modelLine}
    </span>]),
  ];
  const footer = <>
      {/* Human ownership is complete without an agent name. A missing agent on
          an AGENT task is different: it is a misconfiguration worth naming. */}
      <span
        data-card-assignee={task.assigneeType === "HUMAN" ? "human" : assignee === null ? "unassigned-agent" : "agent"}
        className={cn(ROW, "min-w-0 gap-[6px]")}
      >
        {task.assigneeType === "HUMAN"
          ? <IconUser />
          : assignee === null
            ? <><IconRobot /><span>{t("ui.chip.unassigned")}</span></>
            : <><IconRobot /><Assignee name={assignee} label={t("tasks.card.assignee", { name: assignee })} /></>}
      </span>
      <CardPullRequest url={task.latestRun?.pullRequestUrl} />
      <span className="flex-1" />
      <span className="whitespace-nowrap">
        {costAmount === null ? null : `${costAmount} · `}
        {cardTime(task, now)}
      </span>
  </>;
  const after = hasTokenFallback ? (
      <div data-task-cost-fallback="" className="mt-[6px] max-w-full whitespace-normal text-[11.5px] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]">
        {taskCostLabel}
      </div>
    ) : null;
  return <BoardCardShell
    cardId={task.id}
    route={`/tasks/${task.id}`}
    title={title}
    menuItems={menu(task, actions, t)}
    menuLabel={t("tasks.card.actionsFor", { name: task.name })}
    metaRows={metaRows}
    failure={task.failureReason ?? undefined}
    footer={footer}
    after={after}
    dragId={draggable ? task.id : undefined}
  />;
};

/** A card re-renders only when its own row changed.
 *
 *  This is half of the fix; it is inert without the other half. `usePoll` drops
 *  an unchanged response — by validator now, and by body text as a fallback —
 *  and `TasksPage` keeps the previous object for a row whose serialization did
 *  not change, so an unchanged card's `task` prop keeps its identity across a
 *  poll and this comparison short-circuits. The actions object is memoized at
 *  the page for the same reason. */
export const TaskCard = memo(TaskCardBody);
TaskCard.displayName = "TaskCard";
