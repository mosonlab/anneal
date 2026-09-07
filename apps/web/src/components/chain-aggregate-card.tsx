import type { ReactNode } from "react";

import { type ChainControlAction, chainAggregateFigures, chainControlAction, chainStepPosition } from "../lib/chain-aggregate";
import { claimRefusalBadge } from "../lib/board";
import { spanMs, timeAgo, usageCostAmount } from "../lib/format";
import type { BoardTask, ChainAggregate, ChainAggregateState } from "../lib/types";
import { navigate } from "../lib/router";
import { BoardCardShell, CardPullRequest } from "./board-card-shell";
import { IconLock } from "./icons";
import { RunLine } from "./run-line";
import { CardBadgeRow } from "./task-card";
import { Pill, type RowMenuEntry } from "./ui";
import { Button } from "./ui/button";
import { useT, type Translate } from "../lib/i18n";

export type ChainAggregateActions = {
  onActivate: (taskId: string) => void;
  /** Hold and resume address any member of the chain. The board projection
   *  supplies the first primary Step as `activation.taskId`, which keeps the
   *  action independent of whichever frontier happens to be visible. */
  onHold: (taskId: string) => void;
  onResume: (taskId: string) => void;
  onFilter: (aggregate: ChainAggregate) => void;
  onArchive: (aggregate: ChainAggregate) => void;
};

/** Every state that still names itself on the card. `running` is absent by
 *  design: the run line's amber dot already says the chain is running, and the
 *  pill beside it was the same fact a second time. */
const STATE_TONE: Record<Exclude<ChainAggregateState, "running">, "green" | "amber" | "grey"> = {
  "parked-unactivated": "grey",
  "waiting-on-predecessor": "amber",
  held: "amber",
  idle: "grey",
  settled: "green",
};

const chainName = (aggregate: ChainAggregate): string => aggregate.chainName ?? aggregate.chainId.slice(0, 8);

const routeFor = (representativeTaskId: string): string => `/tasks/${representativeTaskId}`;

const menu = (
  aggregate: ChainAggregate,
  representativeTaskId: string,
  actions: ChainAggregateActions,
  t: Translate,
  controlAction: ChainControlAction | null,
): RowMenuEntry[] => {
  const state = aggregate.activation.state;
  return [
    { label: t("tasks.aggregate.menu.open"), onSelect: () => navigate(routeFor(representativeTaskId)) },
    ...(controlAction?.kind === "activate"
      ? [{ label: t("tasks.aggregate.menu.activate"), onSelect: () => actions.onActivate(controlAction.taskId) }]
      : []),
    ...(controlAction?.kind === "hold"
      ? [{ label: t("tasks.aggregate.menu.hold"), onSelect: () => actions.onHold(controlAction.taskId) }]
      : []),
    ...(controlAction?.kind === "resume"
      ? [{ label: t("tasks.aggregate.menu.resume"), onSelect: () => actions.onResume(controlAction.taskId) }]
      : []),
    { label: t("tasks.aggregate.menu.filter"), onSelect: () => actions.onFilter(aggregate) },
    ...(state === "settled"
      ? [{ label: t("tasks.aggregate.menu.archive"), onSelect: () => actions.onArchive(aggregate) }]
      : []),
  ];
};

export const ChainAggregateCard = ({ aggregate, members = [], representativeTaskId, actions }: {
  aggregate: ChainAggregate;
  members?: readonly BoardTask[];
  representativeTaskId?: string;
  actions?: ChainAggregateActions | undefined;
}): ReactNode => {
  const t = useT();
  const representative = representativeTaskId ?? aggregate.frontier.taskId;
  const title = chainName(aggregate);
  const position = chainStepPosition(aggregate, members);
  const state = aggregate.activation.state;
  const predecessor = aggregate.activation.predecessor;
  const hold = aggregate.activation.hold;
  const activeRepair = aggregate.activeRepair;
  // The aggregate shows the frontier Run first and an active repair second.
  // Surface the first visible Run's refusal in the shared anomaly row; a
  // repair-only aggregate still gets the signal, while two simultaneous
  // refusals do not duplicate one badge kind on the collapsed card.
  const claimRefusal = claimRefusalBadge(aggregate.frontier.latestRun)
    ?? claimRefusalBadge(activeRepair?.latestRun);
  // Chain members are collapsed into one visible board card. Preserve the
  // salvage signal by counting the member-level projection entries rather than
  // making the aggregate contract duplicate per-task evidence.
  const strandedSalvageCount = members.reduce(
    (count, member) => count + member.strandedSalvageBranches.length,
    0,
  );
  // Cost, lead time and repair rounds come from one derivation, so the footer
  // and the figures row cannot read the chain two different ways.
  const figures = chainAggregateFigures(aggregate, members);
  const cost = usageCostAmount(figures.cost);
  const handlers: ChainAggregateActions = actions ?? {
    onActivate: () => undefined,
    onHold: () => undefined,
    onResume: () => undefined,
    onFilter: () => undefined,
    onArchive: () => undefined,
  };
  const controlAction = chainControlAction(aggregate.activation);
  const holdPill = state === "running" && hold !== null
    ? <Pill tone="amber" data-chain-hold-state="pending">{t("tasks.aggregate.state.stopsAfter")}</Pill>
    : state === "held" && hold !== null
      ? <Pill tone="amber" data-chain-hold-state="held">
          {hold.heldLayer === 0
            ? t("tasks.aggregate.state.held")
            : t("tasks.aggregate.state.heldAfter", { n: hold.heldLayer })}
        </Pill>
      : null;
  // A null lead time is unknown — no run has started — and says nothing rather
  // than "0s". Zero repairs is the ordinary case, so the pill appears only
  // when there is a round to report [A8].
  const leadTime = figures.leadTimeMs === null
    ? null
    : <span data-chain-lead-time="" title={t("tasks.aggregate.leadTime.title")}>
        {t("tasks.aggregate.leadTime", { duration: spanMs(figures.leadTimeMs) })}
      </span>;
  const repairRounds = figures.repairRounds === 0
    ? null
    : <span data-chain-repair-rounds="">
        <Pill tone="amber">{t("tasks.aggregate.repairRounds", { n: figures.repairRounds })}</Pill>
      </span>;
  const metaRows: ReactNode[] = [
      ...(strandedSalvageCount === 0 ? [] : [<span data-card-stranded-salvage="">
        <Pill tone="amber">{t("tasks.card.strandedSalvage", { n: strandedSalvageCount })}</Pill>
      </span>]),
      // Position and the step it names are one fact, so they are one line. The
      // filtering the frontier row used to offer lives in the row menu, which is
      // where the card's other actions already are.
      <span data-chain-progress="" className="contents">
        <span data-chain-frontier="" className="min-w-0 [overflow-wrap:anywhere]">
          {t("tasks.aggregate.progress", { current: position, total: aggregate.stepCount })}
          {" · "}
          {aggregate.frontier.title}
        </span>
        {holdPill ?? (state === "running" ? null : <Pill tone={STATE_TONE[state]}>{t(`tasks.aggregate.state.${state}`)}</Pill>)}
      </span>,
      ...(aggregate.frontier.latestRun === null ? [] : [
        <RunLine run={aggregate.frontier.latestRun} mergeOutcome={aggregate.frontier.mergeOutcome} elapsed="line" showModel />,
      ]),
      ...(activeRepair?.latestRun === null || activeRepair?.latestRun === undefined ? [] : [
        <span data-chain-repair="" className="contents">
          <span>{activeRepair.repairKind}</span>
          <span aria-hidden="true"> · </span>
          <RunLine run={activeRepair.latestRun} elapsed="line" showModel />
        </span>,
      ]),
      ...(claimRefusal === null ? [] : [<CardBadgeRow badges={[claimRefusal]} />]),
      ...(leadTime === null && repairRounds === null ? [] : [
        <span data-chain-figures="" className="contents">
          {leadTime}
          {repairRounds}
        </span>,
      ]),
      ...(controlAction?.kind === "activate" ? [
          <Button type="button" variant="legacyPrimary" size="legacySmall" onClick={(event) => { event.stopPropagation(); handlers.onActivate(controlAction.taskId); }}>
            {t("tasks.aggregate.activate")}
          </Button>,
      ] : state === "waiting-on-predecessor" && predecessor !== null ? [
        <span data-chain-locked="" className="contents text-[color:var(--status-amber-fg)]">
          <IconLock /> <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{t("tasks.aggregate.waitingOn", { name: predecessor.taskName })}</span>
        </span>,
      ] : []),
      ...(state === "held" && hold?.holdReason !== null && hold?.holdReason !== undefined ? [
        <span data-chain-hold-reason="" className="text-[color:var(--status-amber-fg)] [overflow-wrap:anywhere]">
          {t("chain.holdReason", { reason: hold.holdReason })}
        </span>,
      ] : []),
      ...(controlAction?.kind === "hold" ? [
        <Button
          type="button"
          variant="legacy"
          size="legacySmall"
          data-chain-hold=""
          onClick={(event) => { event.stopPropagation(); handlers.onHold(controlAction.taskId); }}
        >
          {t("tasks.aggregate.hold")}
        </Button>,
      ] : []),
      ...(controlAction?.kind === "resume" ? [
        <Button
          type="button"
          variant="legacyPrimary"
          size="legacySmall"
          data-chain-resume=""
          onClick={(event) => { event.stopPropagation(); handlers.onResume(controlAction.taskId); }}
        >
          {t("tasks.aggregate.resume")}
        </Button>,
      ] : []),
  ];
  return <BoardCardShell
    cardId={`chain:${aggregate.chainId}`}
    chainId={aggregate.chainId}
    route={routeFor(representative)}
    title={title}
    menuItems={menu(aggregate, representative, handlers, t, controlAction)}
    menuLabel={t("tasks.aggregate.actionsFor", { name: title })}
    metaRows={metaRows}
    failure={aggregate.frontier.failureReason === null
      ? undefined
      : <span data-chain-failure="">{aggregate.frontier.failureReason}</span>}
    footer={<>
      <CardPullRequest url={aggregate.frontier.latestRun?.pullRequestUrl} />
      <span className="flex-1" />
      <span className="whitespace-nowrap">
        {cost === null ? null : `${cost} · `}{timeAgo(aggregate.createdAt)}
      </span>
    </>}
  />;
};
