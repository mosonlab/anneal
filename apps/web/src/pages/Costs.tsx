import { type ReactNode, useMemo, useState } from "react";

import { formatDateTime, formatT, titleCase, usageMoney } from "../lib/format";
import { useLocalStorage, useMediaQuery, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { fatal } from "../lib/poll-state";
import { useProjectScope } from "../lib/project";
import type { Agent, CostsReport } from "../lib/types";
import { Link } from "../lib/router";
import { IconRefresh } from "../components/icons";
import {
  HINT, PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW_WRAP,
  STACK, TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  AgentChip, Card, EmptyState, ErrorNotice, MetricFigure, Page, Segmented,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

/** The windows `GET /projects/:projectId/costs` accepts. The control plane
 *  refuses anything else, so the page offers exactly these. One day is the
 *  operator's "what am I spending right now" window and is labelled Today. */
export const COSTS_RANGES = [1, 7, 30, 90] as const;
export type CostsRange = typeof COSTS_RANGES[number];

/** The timezone every window bound and daily bucket is computed in. The control
 *  plane has no default: a day boundary the operator did not pick would file
 *  their evening's spend under the wrong date, so the browser states its own. */
export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A cost dashboard is a page an operator returns to; the window they chose last
 *  time is the one they meant. */
const RANGE_KEY = "agentos.costs.days";

/** Hand-tuned categorical slots defined in `styles.css`. Further series use
 *  deterministic golden-angle hues instead of folding or cycling identity. */
export const SERIES_SLOTS = 6;

export const seriesColor = (rank: number): string =>
  rank < SERIES_SLOTS
    ? `var(--series-${rank + 1})`
    : `hsl(${((rank * 137.45) % 360).toFixed(1)} 64% 43%)`;

/**
 * The series the chart draws, in stacking order.
 *
 * Every agent remains its own series. `byAgent` is already sorted by total
 * spend, giving both stacking and deterministic styling one stable order.
 */
export const chartSeries = (byAgent: CostsReport["byAgent"]): string[] =>
  byAgent.map((entry) => entry.agent);

/* ---------------------------------------------------------------- additive API view */

export type CostsPageChain = CostsReport["chains"][number];
export type CostsPageReport = CostsReport;
type CostsPageWaste = CostsReport["waste"];

export type CostsChainSort = "lead" | "cost";

const chainCostNumber = (value: string | null): number =>
  value === null || !Number.isFinite(Number(value)) ? Number.NEGATIVE_INFINITY : Number(value);

const descending = (left: number, right: number): number => {
  if (left === right) return 0;
  if (left === Number.NEGATIVE_INFINITY) return 1;
  if (right === Number.NEGATIVE_INFINITY) return -1;
  return right - left;
};

/** The default answers "which chains took longest?"; cost is an explicit sort. */
export const sortCostChains = (
  chains: readonly CostsPageChain[],
  sort: CostsChainSort = "lead",
): CostsPageChain[] => [...chains].sort((left, right) => {
  const primary = sort === "cost"
    ? descending(chainCostNumber(left.costUsd), chainCostNumber(right.costUsd))
    : descending(left.leadMinutes, right.leadMinutes);
  if (primary !== 0) return primary;
  const secondary = sort === "cost"
    ? descending(left.leadMinutes, right.leadMinutes)
    : descending(chainCostNumber(left.costUsd), chainCostNumber(right.costUsd));
  if (secondary !== 0) return secondary;
  return (left.chainName ?? left.chainId).localeCompare(right.chainName ?? right.chainId)
    || left.chainId.localeCompare(right.chainId);
});

const minutes = (value: number): string => {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toFixed(1).replace(/\.0$/u, "")}m`;
};

const busyPercentage = (value: number): string => Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";

/* ------------------------------------------------------------------- chart */

/* Geometry is in viewBox units and the SVG scales uniformly, so these are
 * proportions rather than pixels — including `fontSize`, which is why the shape
 * of the box decides whether the axis is legible. 1200x240 is close to the
 * rendered box on a full-width page, which keeps the type in the chart near the
 * type around it. */
export type ChartGeometry = {
  width: number; height: number;
  padLeft: number; padRight: number; padTop: number; padBottom: number;
  /** At a seven-day window a column would otherwise be 160 units wide, which
   *  reads as a block diagram rather than a bar chart. */
  maxBar: number;
  fontSize: number;
};

export const WIDE_CHART: ChartGeometry = {
  width: 1200, height: 240, padLeft: 62, padRight: 10, padTop: 12, padBottom: 24,
  maxBar: 52, fontSize: 13,
};

/**
 * The same chart on a phone, where the card is about 306px wide.
 *
 * Reusing `WIDE_CHART` there scaled a unit to a quarter of a CSS pixel: the
 * plot came out 61px tall and both axes rendered at 3.3px, which is a picture of
 * a chart rather than a chart. A viewBox 400 units wide puts a unit at about
 * 0.77px, so `fontSize: 15` lands near the 11.5px the hints around it use, and
 * `padLeft: 82` is the gutter `$1234.56` needs at that size.
 */
export const PHONE_CHART: ChartGeometry = {
  width: 400, height: 340, padLeft: 82, padRight: 6, padTop: 10, padBottom: 30,
  maxBar: 26, fontSize: 15,
};

/** A surface-coloured gap between stacked fills, so two adjacent segments read
 *  as two values and not one. */
const SEGMENT_GAP = 2;
const CORNER = 4;

export type ChartSegment = {
  key: string;
  agent: string;
  date: string;
  usd: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The top of its column, and so the end that carries the rounded corners. */
  capped: boolean;
};

/** Turns the daily buckets into positioned segments. Pure, so the geometry is
 *  testable without a DOM. */
export const chartSegments = (
  daily: CostsReport["daily"],
  order: readonly string[],
  max: number,
  geometry: ChartGeometry = WIDE_CHART,
): ChartSegment[] => {
  if (daily.length === 0 || max <= 0) return [];
  const plotWidth = geometry.width - geometry.padLeft - geometry.padRight;
  const plotHeight = geometry.height - geometry.padTop - geometry.padBottom;
  const column = plotWidth / daily.length;
  const barWidth = Math.min(geometry.maxBar, column * 0.72);
  const segments: ChartSegment[] = [];
  daily.forEach((bucket, index) => {
    const x = geometry.padLeft + column * index + (column - barWidth) / 2;
    // Stacked from the baseline up, in the legend's order, so a given agent sits
    // at the same height in every column and the shape is comparable across days.
    const stacked = order
      .map((agent) => ({ agent, usd: Number(bucket.byAgent[agent] ?? 0) }))
      .filter((entry) => entry.usd > 0);
    let baseline = geometry.padTop + plotHeight;
    stacked.forEach((entry, position) => {
      const full = (entry.usd / max) * plotHeight;
      // The gap comes out of the segment, never out of the value it encodes: a
      // sliver thinner than the gap keeps its full height instead of vanishing.
      const hasSegmentAbove = position < stacked.length - 1;
      const height = hasSegmentAbove && full > SEGMENT_GAP * 2 ? full - SEGMENT_GAP : full;
      segments.push({
        key: `${bucket.date}:${entry.agent}`,
        agent: entry.agent,
        date: bucket.date,
        usd: entry.usd,
        x,
        y: baseline - height,
        width: barWidth,
        height,
        capped: position === stacked.length - 1,
      });
      baseline -= full;
    });
  });
  return segments;
};

/** A rounded-top, square-bottom bar. Rounding both ends would lift the fill off
 *  the baseline it is measured from. */
const segmentPath = (segment: ChartSegment): string => {
  const radius = Math.min(CORNER, segment.width / 2, segment.height);
  const { x, y, width, height } = segment;
  if (!segment.capped || radius <= 0) return `M${x} ${y}h${width}v${height}h${-width}Z`;
  return `M${x} ${y + radius}a${radius} ${radius} 0 0 1 ${radius} ${-radius}`
    + `h${width - radius * 2}a${radius} ${radius} 0 0 1 ${radius} ${radius}`
    + `v${height - radius}h${-width}Z`;
};

/** First, middle and last only: ninety dates along this axis collide into a
 *  grey smear that says less than three legible ones. */
export const axisDates = (daily: CostsReport["daily"]): number[] => {
  if (daily.length === 0) return [];
  if (daily.length <= 2) return daily.map((_, index) => index);
  return [...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])];
};

export const DailySpendChart = ({ daily, order, colors, geometry = WIDE_CHART }: {
  daily: CostsReport["daily"];
  order: readonly string[];
  colors: (agent: string) => string;
  /** `PHONE_CHART` below 900px. A prop rather than a media query inside this
   *  component, so the geometry stays testable without a matchMedia. */
  geometry?: ChartGeometry;
}): ReactNode => {
  const t = useT();
  const totals = daily.map((bucket) => Object.values(bucket.byAgent).reduce((sum, usd) => sum + Number(usd), 0));
  const max = Math.max(0, ...totals);
  const segments = chartSegments(daily, order, max, geometry);
  const plotWidth = geometry.width - geometry.padLeft - geometry.padRight;
  const column = daily.length === 0 ? 0 : plotWidth / daily.length;
  const baseline = geometry.height - geometry.padBottom;
  if (segments.length === 0) return <EmptyState>{t("costs.chart.empty")}</EmptyState>;
  return (
    <svg
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      className="h-auto w-full"
      role="img"
      aria-label={t("costs.chart.aria", { amount: usageMoney(max), n: daily.length })}
    >
      {/* Recessive: the grid states the scale and then gets out of the way.
          `--border-soft` is very nearly `--card` in the dark theme, so a scale
          line drawn in it would simply not exist there; `--border` is the
          quietest token still visible against both surfaces. */}
      <line x1={geometry.padLeft} y1={geometry.padTop} x2={geometry.width - geometry.padRight} y2={geometry.padTop}
        stroke="var(--border)" strokeWidth="1" />
      <line x1={geometry.padLeft} y1={baseline} x2={geometry.width - geometry.padRight} y2={baseline}
        stroke="var(--border)" strokeWidth="1.5" />
      <text x={geometry.padLeft - 8} y={geometry.padTop + 4} textAnchor="end" fontSize={geometry.fontSize} fill="var(--faint)">
        {usageMoney(max)}
      </text>
      <text x={geometry.padLeft - 8} y={baseline} textAnchor="end" fontSize={geometry.fontSize} fill="var(--faint)">0</text>
      {segments.map((segment) => (
        <path key={segment.key} d={segmentPath(segment)} fill={colors(segment.agent)}>
          <title>{t("costs.chart.tooltip", {
            agent: segment.agent,
            date: segment.date,
            amount: usageMoney(segment.usd),
          })}</title>
        </path>
      ))}
      {axisDates(daily).map((index) => (
        <text
          key={daily[index]?.date ?? index}
          x={geometry.padLeft + column * (index + 0.5)}
          y={geometry.height - 6}
          textAnchor={index === 0 ? "start" : index === daily.length - 1 ? "end" : "middle"}
          fontSize={geometry.fontSize}
          fill="var(--faint)"
        >
          {daily[index]?.date ?? ""}
        </text>
      ))}
    </svg>
  );
};

/** The legend names each series with the same roster-backed chip the table
 *  below uses, so one agent reads as one thing on both. `agents` is what the
 *  roster answered; a series with no row there keeps its recorded slug. */
export const ChartLegend = ({ order, colors, agents }: {
  order: readonly string[];
  colors: (agent: string) => string;
  agents?: ReadonlyMap<string, Agent>;
}): ReactNode => {
  return (
    <div className={`${ROW_WRAP} mt-[12px]`}>
      {order.map((agent) => (
        <span key={agent} className="inline-flex items-center gap-[6px] text-[11.5px] text-muted-foreground">
          <span className="size-[9px] rounded-[2px]" style={{ background: colors(agent) }} aria-hidden="true" />
          <AgentChip agent={agents?.get(agent) ?? null} name={agent} />
        </span>
      ))}
    </div>
  );
};

/* ---------------------------------------------------------------- by model */

/** A percentage as one decimal, or an em dash when the figure does not exist.
 *  A missing rate is not a zero rate, and rendering it as `0%` would claim a
 *  measurement nobody took. */
export const percent = (value: number | null): string => (value === null ? "—" : `${value.toFixed(1)}%`);

/** Share of the window's total spend, computed from the wire amounts rather than
 *  from the rounded strings the table shows. `null` when there is no total to
 *  take a share of. */
export const sharePct = (part: string, whole: string): number | null => {
  const total = Number(whole);
  if (!Number.isFinite(total) || total <= 0) return null;
  return (Number(part) / total) * 100;
};

/** Spend a run did not buy, as a share of that agent's spend. `null` when the
 *  agent has no priced spend at all: a rate over nothing is not zero waste. */
export const wasteShare = (entry: CostsReport["byAgent"][number]): number | null =>
  sharePct(entry.wastedUsd, entry.usd);

/** One horizontal bar over the model keys. It answers "what is this window
 *  mostly?" before the reader parses a single number, which is the one question
 *  a table of six models answers slowly. */
export const ModelBar = ({ byModel, totalUsd, colors }: {
  byModel: CostsReport["byModel"];
  totalUsd: string;
  colors: (model: string) => string;
}): ReactNode => {
  const t = useT();
  const segments = byModel
    .map((entry) => ({ model: entry.model, usd: entry.usd, share: sharePct(entry.usd, totalUsd) }))
    .filter((entry): entry is { model: string; usd: string; share: number } =>
      entry.share !== null && entry.share > 0);
  if (segments.length === 0) return null;
  return (
    <div
      className="mb-[14px] flex h-[10px] w-full overflow-hidden rounded-full bg-secondary"
      role="img"
      aria-label={t("costs.byModel.aria", { n: byModel.length, amount: usageMoney(totalUsd) })}
    >
      {segments.map((segment) => (
        <span
          key={segment.model}
          className="h-full"
          style={{ width: `${segment.share}%`, background: colors(segment.model) }}
          title={t("costs.byModel.tooltip", {
            model: segment.model,
            amount: usageMoney(segment.usd),
            share: percent(segment.share),
          })}
        />
      ))}
    </div>
  );
};

/* --------------------------------------------------------------- waste */

/** The single waste number remains in the summary row; this card explains the
 *  two populations underneath it without changing the existing headline. */
export const WasteBreakdown = ({ waste }: { waste: CostsPageWaste }): ReactNode => {
  const t = useT();
  return (
    <Card title={t("costs.waste.title")}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-[16px]">
        <MetricFigure label={t("costs.waste.operatorCancelled")} value={usageMoney(waste.operatorCancelledUsd)} />
        <MetricFigure label={t("costs.waste.failed")} value={usageMoney(waste.failedUsd)} />
      </div>
      <details open={waste.byFailureClass.length > 0} className="mt-[16px] border-t border-[color:var(--border-soft)] pt-[12px]">
        <summary className="cursor-pointer text-[12px] text-secondary-foreground">
          {t("costs.waste.failedClasses", { n: waste.byFailureClass.length })}
        </summary>
        {waste.byFailureClass.length === 0
          ? <div className={`${HINT} mt-[9px]`}>{t("costs.waste.noFailures")}</div>
          : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("costs.waste.failureClass")}</TableHead>
                    <TableHead className={TABLE_TIGHT}>{t("costs.waste.runs")}</TableHead>
                    <TableHead className={TABLE_TIGHT}>{t("costs.waste.cost")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {waste.byFailureClass.map((failure) => (
                    <TableRow key={failure.failureClass}>
                      <TableCell className={TABLE_NAME}>{failure.failureClass}</TableCell>
                      <TableCell className={TABLE_TIGHT}>{failure.runs}</TableCell>
                      <TableCell className={TABLE_TIGHT}>{usageMoney(failure.usd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
      </details>
    </Card>
  );
};

/* --------------------------------------------------------------- chains */

const chainTaskHref = (chain: CostsPageChain): string =>
  `/tasks/${encodeURIComponent(chain.detailTaskId)}`;

const ChainName = ({ chain }: { chain: CostsPageChain }): ReactNode => {
  const name = chain.chainName ?? chain.chainId.slice(0, 8);
  return <Link to={chainTaskHref(chain)}>{name}</Link>;
};

/** Inline role chips keep the per-role spend visible without making each row
 *  another interaction. Unknown cost runs are called out separately from the
 *  priced role amounts, so a partial total is never presented as complete. */
export const ChainRoleCosts = ({ chain }: { chain: CostsPageChain }): ReactNode => {
  const t = useT();
  const roles = Object.entries(chain.costByRole).sort(([left], [right]) => left.localeCompare(right));
  return (
    <div className="flex min-w-[180px] flex-wrap gap-x-[10px] gap-y-[4px]">
      {roles.length === 0 ? <span className="text-muted-foreground">—</span> : null}
      {roles.map(([role, usd]) => (
        <span key={role} className="inline-flex gap-[4px] text-[11.5px]">
          <span className="text-muted-foreground">{titleCase(role)}:</span>
          <span>{usageMoney(usd)}</span>
        </span>
      ))}
      {chain.costUnavailableRuns > 0 ? (
        <span className={TABLE_SUB}>{t("costs.chains.unpriced", { n: chain.costUnavailableRuns })}</span>
      ) : null}
    </div>
  );
};

const repairSummary = (chain: CostsPageChain, t: ReturnType<typeof useT>): ReactNode => {
  const repairs = [
    ["gate-fix", chain.repairs.gateFix],
    ["refresh-conflict", chain.repairs.refreshConflict],
    ["review-fix", chain.repairs.reviewFix],
  ] as const;
  const present = repairs.filter(([, count]) => count > 0);
  return present.length === 0
    ? <span className="text-muted-foreground">{t("costs.chains.noRepairs")}</span>
    : <span className="flex flex-wrap gap-x-[7px] gap-y-[3px]">{present.map(([kind, count]) => <span key={kind}>{kind} ×{count}</span>)}</span>;
};

/** Costs rows are server-projected in one response; the browser only sorts and
 *  renders them, keeping the selected window and refresh behavior unchanged. */
export const ChainsTable = ({ chains }: { chains: readonly CostsPageChain[] }): ReactNode => {
  const t = useT();
  const [sort, setSort] = useState<CostsChainSort>("lead");
  const ordered = useMemo(() => sortCostChains(chains, sort), [chains, sort]);
  if (chains.length === 0) return <EmptyState>{t("costs.chains.empty")}</EmptyState>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("costs.chains.chain")}</TableHead>
          <TableHead className={TABLE_TIGHT}>{t("costs.chains.tasks")}</TableHead>
          <TableHead className={TABLE_TIGHT} aria-sort={sort === "lead" ? "descending" : "none"}>
            <button type="button" className="text-left hover:text-foreground" onClick={() => setSort("lead")}>
              {t("costs.chains.lead")}
            </button>
          </TableHead>
          <TableHead className={TABLE_TIGHT}>{t("costs.chains.busy")}</TableHead>
          <TableHead className={TABLE_TIGHT}>{t("costs.chains.busyPct")}</TableHead>
          <TableHead>{t("costs.chains.repairs")}</TableHead>
          <TableHead className={TABLE_TIGHT} aria-sort={sort === "cost" ? "descending" : "none"}>
            <button type="button" className="text-left hover:text-foreground" onClick={() => setSort("cost")}>
              {t("costs.chains.cost")}
            </button>
          </TableHead>
          <TableHead>{t("costs.chains.costByRole")}</TableHead>
          <TableHead>{t("costs.chains.longestGap")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.map((chain) => (
          <TableRow key={chain.chainId}>
            <TableCell className={TABLE_NAME}><ChainName chain={chain} /></TableCell>
            <TableCell className={TABLE_TIGHT}>{chain.taskCount}</TableCell>
            <TableCell className={TABLE_TIGHT}>{minutes(chain.leadMinutes)}</TableCell>
            <TableCell className={TABLE_TIGHT}>{minutes(chain.busyMinutes)}</TableCell>
            <TableCell className={TABLE_TIGHT}>{busyPercentage(chain.busyPct)}</TableCell>
            <TableCell>{repairSummary(chain, t)}</TableCell>
            <TableCell className={TABLE_TIGHT}>
              {chain.costUsd === null ? "—" : usageMoney(chain.costUsd)}
              {chain.costUnavailableRuns > 0
                ? <span className={TABLE_SUB}>{t("costs.chains.unpriced", { n: chain.costUnavailableRuns })}</span>
                : null}
            </TableCell>
            <TableCell><ChainRoleCosts chain={chain} /></TableCell>
            <TableCell>
              {minutes(chain.longestGap.minutes)}
              {chain.longestGap.beforeTaskName
                ? <span className={TABLE_SUB}>{t("costs.chains.before", { task: chain.longestGap.beforeTaskName })}</span>
                : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

/* -------------------------------------------------------------------- page */

const parseRange = (value: string): CostsRange =>
  COSTS_RANGES.find((days) => String(days) === value) ?? 30;

/** The dashboard proper: the chart and the runs behind it on the left, the two
 *  breakdowns that explain them on the right. One column below 1100px, where
 *  two would leave neither wide enough to read. */
export const COSTS_COLUMNS = "grid grid-cols-[minmax(0,1fr)] items-start gap-[16px] [@media(min-width:1100px)]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]";
/** One row rather than a wall of tiles: four figures that are read together and
 *  compared against each other, not four independent headlines. */
export const COSTS_SUMMARY = "grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-[18px] rounded-xl border border-border bg-card px-[20px] py-[14px]";

export const CostsPage = (): ReactNode => {
  const { projectId, project } = useProjectScope();
  const [stored, setStored] = useLocalStorage(RANGE_KEY, "30");
  const days = parseRange(stored);
  const t = useT();
  // The control plane computes every day boundary in the timezone it is given
  // and refuses the request without one, so the browser's zone travels with the
  // window rather than being guessed at the other end.
  const timeZone = browserTimeZone();
  const narrow = useMediaQuery("(max-width: 900px)");
  const path = projectId === ""
    ? null
    : `/projects/${encodeURIComponent(projectId)}/costs?days=${days}&tz=${encodeURIComponent(timeZone)}`;
  // Settled spend over whole days does not move at the board's cadence, and a
  // 30-day aggregate is not free to compute. A minute is well inside the time an
  // operator would take to notice a run finished.
  const costs = usePoll<CostsPageReport>(path, 60_000);
  /* The report names an Agent by the `Agent.name` its Runs carried, which is a
   * slug and says nothing about what that Agent runs *now*. The roster supplies
   * the current configuration for the chip; the Run's own model stays in the
   * run-model card, where it is a fact about spend rather than about setup. */
  const roster = usePoll<Agent[]>(projectId === "" ? null : `/projects/${encodeURIComponent(projectId)}/agents`, 300_000);
  const agentsByName = useMemo(
    () => new Map((roster.data ?? []).map((agent) => [agent.name, agent])),
    [roster.data],
  );

  const report = costs.data;
  /* Identity is assigned once, by total spend across the window, and every
   * surface on the page reads the same map — so narrowing the range repaints
   * nothing that survived it for a reason other than its own rank changing. */
  const order = useMemo(() => chartSeries(report?.byAgent ?? []), [report]);
  const colors = useMemo(() => {
    const assigned = new Map(order.map((agent, rank) => [agent, seriesColor(rank)]));
    return (agent: string): string => assigned.get(agent) ?? "var(--series-other)";
  }, [order]);
  /* The model breakdown is its own categorical dimension, so it gets its own
   * assignment over the same palette: a model and an agent that happen to share
   * a rank are two different facts, in two different cards. */
  const modelColors = useMemo(() => {
    const assigned = new Map((report?.byModel ?? []).map((entry, rank) => [entry.model, seriesColor(rank)]));
    return (model: string): string => assigned.get(model) ?? "var(--series-other)";
  }, [report]);
  const daily = report?.daily ?? [];

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("costs.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>
            {t("costs.head.subtitle", { project: project?.name ?? t("tasks.head.thisProject") })}
          </div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Segmented
            options={COSTS_RANGES.map((value) => ({
              value: String(value),
              label: value === 1 ? t("costs.range.today") : t("costs.range", { n: value }),
            }))}
            value={String(days)}
            onChange={setStored}
          />
          <Button type="button" variant="legacy" size="legacy" onClick={costs.reload}>
            <IconRefresh />{t("common.refresh")}
          </Button>
        </div>
      </div>

      <div className={STACK}>
        {fatal(costs.error, report)
          ? <ErrorNotice message={`${costs.error!.status} ${costs.error!.message}`} onRetry={costs.reload} />
          : null}

        {report === null ? null : (
          <>
            {/* Wasted spend sits beside the total deliberately: the pair is the
                page's headline, and a total nobody can compare against the part
                of it that bought nothing is a number without a verdict. */}
            <div className={COSTS_SUMMARY}>
              <MetricFigure label={t("costs.metric.total")} value={usageMoney(report.totalUsd)} />
              <MetricFigure label={t("costs.metric.runs")} value={report.runCount} />
              <MetricFigure
                label={t("costs.metric.avg")}
                value={report.runCount === report.costUnavailableRuns ? "—" : usageMoney(report.avgUsd)}
              />
              <MetricFigure label={t("costs.metric.wasted")} value={usageMoney(report.wastedUsd)} />
            </div>
            {/* Neither number is decoration. An estimated share says part of the
                total is the control plane's own pricing, and an unavailable
                count says the total is missing runs outright — without them the
                tiles read as a complete ledger. */}
            <div className={HINT}>
              {Number(report.estimatedUsd) > 0
                ? `${t("costs.hint.estimated", { amount: usageMoney(report.estimatedUsd) })} `
                : ""}
              {report.costUnavailableRuns > 0
                ? t("costs.hint.unavailable", { n: report.costUnavailableRuns })
                : t("costs.hint.complete")}
            </div>

            <WasteBreakdown waste={report.waste} />

            <div className={COSTS_COLUMNS}>
              <div className={STACK}>
                <Card title={t("costs.chart.title")}>
                  <DailySpendChart daily={daily} order={order} colors={colors} geometry={narrow ? PHONE_CHART : WIDE_CHART} />
                  {order.length > 1 ? <ChartLegend order={order} colors={colors} agents={agentsByName} /> : null}
                </Card>

                <Card title={t("costs.chains.title")} flush>
                  <ChainsTable chains={report.chains} />
                </Card>

                <Card title={t("costs.topRuns.title")} flush>
                  {report.topRuns.length === 0
                    ? <EmptyState>{t("costs.topRuns.empty")}</EmptyState>
                    : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>{t("costs.topRuns.task")}</TableHead>
                              <TableHead>{t("costs.topRuns.agent")}</TableHead>
                              <TableHead>{t("costs.runModel")}</TableHead>
                              <TableHead className={TABLE_TIGHT}>{t("costs.topRuns.started")}</TableHead>
                              <TableHead className={TABLE_TIGHT}>{t("costs.topRuns.cost")}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {report.topRuns.map((run) => (
                              <TableRow key={run.runId}>
                                <TableCell className={TABLE_NAME}>
                                  {/* Task names run long enough to push the four
                                      columns after them past the table's width. The
                                      bound goes on a block inside the cell, not the
                                      cell: an auto-layout table treats a `<td>`
                                      max-width as advice and widens the column
                                      anyway. `TableCell` is `whitespace-nowrap`, so
                                      the block has to re-enable wrapping or the
                                      bound clips nothing. */}
                                  <div className="max-w-[420px] whitespace-normal">
                                    {run.taskName ?? t("costs.topRuns.noTask")}
                                    <span className={TABLE_SUB}>{run.runId}</span>
                                  </div>
                                </TableCell>
                                {/* Two different facts, side by side: the chip is
                                    the Agent as it is configured now, and the
                                    column beside it is the model this run
                                    actually executed with. */}
                                <TableCell>
                                  <AgentChip agent={agentsByName.get(run.agent) ?? null} name={run.agent} />
                                  <span className={TABLE_SUB}>{run.agent}</span>
                                </TableCell>
                                <TableCell>{run.model}</TableCell>
                                <TableCell className={TABLE_TIGHT}>{formatDateTime(run.startedAt)}</TableCell>
                                <TableCell className={TABLE_TIGHT}>
                                  {run.estimated
                                    ? formatT("format.usageCost.estimated", { amount: usageMoney(run.usd) })
                                    : usageMoney(run.usd)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                </Card>
              </div>
              <div className={STACK}>
                <Card title={t("costs.byAgent.title")} flush>
                  {report.byAgent.length === 0
                    ? <EmptyState>{t("costs.byAgent.empty")}</EmptyState>
                    : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>{t("costs.byAgent.agent")}</TableHead>
                              <TableHead className={TABLE_TIGHT}>{t("costs.byAgent.spend")}</TableHead>
                              <TableHead className={TABLE_TIGHT}>{t("costs.byAgent.runs")}</TableHead>
                              <TableHead className={TABLE_TIGHT}>{t("costs.byAgent.avg")}</TableHead>
                              <TableHead className={TABLE_TIGHT}>{t("costs.byAgent.cache")}</TableHead>
                              <TableHead className={TABLE_TIGHT}>{t("costs.byAgent.uncached")}</TableHead>
                              <TableHead className={TABLE_TIGHT}>{t("costs.byAgent.waste")}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {report.byAgent.map((entry) => (
                              <TableRow key={entry.agent}>
                                <TableCell className={TABLE_NAME}>
                                  <span className="inline-flex max-w-full items-center gap-[7px]">
                                    <span className="size-[9px] flex-none rounded-[2px]" style={{ background: colors(entry.agent) }} aria-hidden="true" />
                                    <AgentChip agent={agentsByName.get(entry.agent) ?? null} name={entry.agent} />
                                  </span>
                                  <span className={TABLE_SUB}>{entry.agent}</span>
                                  {entry.costUnavailableRuns > 0
                                    ? <span className={TABLE_SUB}>{t("costs.byAgent.unavailable", { n: entry.costUnavailableRuns })}</span>
                                    : null}
                                </TableCell>
                                <TableCell className={TABLE_TIGHT}>
                                  {entry.runs === entry.costUnavailableRuns ? "—" : usageMoney(entry.usd)}
                                </TableCell>
                                <TableCell className={TABLE_TIGHT}>{entry.runs}</TableCell>
                                <TableCell className={TABLE_TIGHT}>
                                  {entry.runs === entry.costUnavailableRuns ? "—" : usageMoney(entry.avgUsd)}
                                </TableCell>
                                {/* An em dash, never 0%: a cache nobody measured
                                    and a cache nobody hit look nothing alike,
                                    and neither does an agent with no priced
                                    spend to have wasted. */}
                                <TableCell className={TABLE_TIGHT}>
                                  {percent(entry.cachePct)}
                                  {entry.cacheUnknownRuns === 0
                                    ? null
                                    : <span className={TABLE_SUB}>{t("costs.byAgent.cacheUnknown", { n: entry.cacheUnknownRuns })}</span>}
                                </TableCell>
                                <TableCell className={TABLE_TIGHT}>
                                  {entry.uncachedInputUsd === null
                                    ? "—"
                                    : usageMoney(entry.uncachedInputUsd)}
                                </TableCell>
                                <TableCell className={TABLE_TIGHT}>{percent(wasteShare(entry))}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                </Card>

                <Card title={t("costs.byModel.title")}>
                  {report.byModel.length === 0
                    ? <EmptyState>{t("costs.byModel.empty")}</EmptyState>
                    : (
                        <>
                          <div className={`${HINT} mb-[10px]`}>{t("costs.runModel.hint")}</div>
                          <ModelBar byModel={report.byModel} totalUsd={report.totalUsd} colors={modelColors} />
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>{t("costs.runModel")}</TableHead>
                                <TableHead className={TABLE_TIGHT}>{t("costs.byModel.spend")}</TableHead>
                                <TableHead className={TABLE_TIGHT}>{t("costs.byModel.share")}</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {report.byModel.map((entry) => (
                                <TableRow key={entry.model}>
                                  {/* The model string is the wire value, provider prefix and
                                      effort suffix included: two entries that differ only by
                                      effort are two different prices, and shortening them here
                                      would merge them on screen. */}
                                  <TableCell className={TABLE_NAME}>
                                    <div className="max-w-[260px] whitespace-normal [overflow-wrap:anywhere]">
                                      <span className="inline-flex items-center gap-[7px]">
                                        <span className="size-[9px] rounded-[2px]" style={{ background: modelColors(entry.model) }} aria-hidden="true" />
                                        {entry.model}
                                      </span>
                                      {entry.costUnavailableRuns > 0
                                        ? <span className={TABLE_SUB}>{t("costs.byModel.unavailable", { n: entry.costUnavailableRuns })}</span>
                                        : null}
                                    </div>
                                  </TableCell>
                                  <TableCell className={TABLE_TIGHT}>
                                    {entry.runs === entry.costUnavailableRuns ? "—" : usageMoney(entry.usd)}
                                  </TableCell>
                                  <TableCell className={TABLE_TIGHT}>{percent(sharePct(entry.usd, report.totalUsd))}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </>
                      )}
                </Card>
              </div>
            </div>
          </>
        )}
      </div>
    </Page>
  );
};
