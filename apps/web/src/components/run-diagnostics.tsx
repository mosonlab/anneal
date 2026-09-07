import { type ReactNode } from "react";

import { UNKNOWN, compactTokens, durationMs, measured, percent, tokensPerSecond, usageMoney } from "../lib/format";
import { useT } from "../lib/i18n";
import type { RunBaseline, RunBaselineMetric, RunMetrics, RunPhaseMetrics } from "../lib/types";
import { HINT } from "./ui";

/* `dictionary` rather than `label`: the i18n sweep reads a `label` property as
 * user copy, and these are dictionary keys. */
const PHASES: ReadonlyArray<{ field: keyof RunPhaseMetrics; dictionary: string; color: string }> = [
  { field: "queuedMs", dictionary: "taskDetail.diagnostics.phase.queued", color: "var(--series-1)" },
  { field: "provisioningMs", dictionary: "taskDetail.diagnostics.phase.provisioning", color: "var(--series-2)" },
  { field: "executingMs", dictionary: "taskDetail.diagnostics.phase.executing", color: "var(--series-3)" },
  { field: "inboxWaitMs", dictionary: "taskDetail.diagnostics.phase.inboxWait", color: "var(--series-4)" },
  { field: "cleanupMs", dictionary: "taskDetail.diagnostics.phase.cleanup", color: "var(--series-5)" },
];

const Stat = ({ k, v }: { k: ReactNode; v: ReactNode }): ReactNode => (
  <span className="inline-flex items-baseline gap-[5px] whitespace-nowrap">
    <span className="text-muted-foreground">{k}</span>
    <span>{v}</span>
  </span>
);

const DiagnosticsRow = ({ k, children }: { k: string; children: ReactNode }): ReactNode => (
  <div className="grid gap-[5px]">
    <div className="text-[11.5px] text-muted-foreground">{k}</div>
    <div className="flex flex-wrap gap-x-[16px] gap-y-[5px] text-[12.5px]">{children}</div>
  </div>
);

/** Widths are proportional to the phases that were measured; an unmeasured one
 *  contributes no segment rather than a zero-width sliver, and its duration
 *  reads as the unknown marker in the legend below. `inboxWaitMs` is a subset
 *  of `executingMs` on the wire: subtract it from the executing segment,
 *  preserving the raw executing duration in the legend. */
const PhaseBar = ({ phases }: { phases: RunPhaseMetrics }): ReactNode => {
  const t = useT();
  const segmentMs = (field: keyof RunPhaseMetrics): number | null => {
    const value = phases[field];
    const wait = measured(phases.inboxWaitMs) && measured(phases.executingMs)
      ? Math.min(phases.inboxWaitMs, phases.executingMs) : 0;
    if (field === "inboxWaitMs") return wait;
    return field === "executingMs" && measured(value) ? value - wait : value;
  };
  const total = PHASES.reduce((sum, phase) => {
    const value = segmentMs(phase.field);
    return sum + (measured(value) && value > 0 ? value : 0);
  }, 0);
  return (
    <div className="grid gap-[7px]">
      <div className="flex h-[8px] overflow-hidden rounded-md bg-accent" data-run-phase-bar="">
        {total === 0 ? null : PHASES.map((phase) => {
          const value = segmentMs(phase.field);
          if (!measured(value) || value <= 0) return null;
          return (
            <span
              key={phase.field}
              title={t(phase.dictionary)}
              style={{ width: `${(value / total) * 100}%`, background: phase.color }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-[16px] gap-y-[5px] text-[12.5px]">
        {PHASES.map((phase) => (
          <span key={phase.field} className="inline-flex items-baseline gap-[5px] whitespace-nowrap">
            <span className="inline-block h-[8px] w-[8px] shrink-0 rounded-full" style={{ background: phase.color }} />
            <span className="text-muted-foreground">{t(phase.dictionary)}</span>
            <span>{durationMs(phases[phase.field])}{phase.field === "inboxWaitMs" && phases.inboxWaitMs === null
              ? ` · ${t("taskDetail.diagnostics.phase.inboxUnmeasured")}` : ""}</span>
          </span>
        ))}
      </div>
    </div>
  );
};

/** The per-run diagnostics shared by Task detail and the Sessions list. It
 *  carries session termination with a run-reason fallback for pre-session
 *  exits. */
export const RunDiagnostics = ({ metrics, baseline, costUsd, runTerminationReason }: {
  metrics: RunMetrics | null | undefined;
  /** What this run's template step usually costs and takes. Null or undefined
   *  means insufficient history, never 0. */
  baseline?: RunBaseline | null | undefined;
  /** The run session's own reported cost, the raw value the baseline ratio
   *  compares against. */
  costUsd?: string | null | undefined;
  runTerminationReason?: string | null | undefined;
}): ReactNode => {
  const t = useT();
  const title = <div className="text-[12px] font-bold text-muted-foreground">{t("taskDetail.diagnostics.title")}</div>;
  if (metrics === null || metrics === undefined) {
    return (
      <div data-run-diagnostics="" className="grid gap-[10px] border-t border-[color:var(--border-soft)] pt-[14px]">
        {title}
        <div className="text-[12.5px] text-muted-foreground">{t("taskDetail.diagnostics.empty")}</div>
      </div>
    );
  }
  const { phases, tokens, tools, termination, ttft } = metrics;
  // An upper-bound model-active duration gives a lower-bound output rate.
  const bounded = (text: string, bound: "upperBound" | "lowerBound"): string => metrics.modelActiveIsUpperBound && text !== UNKNOWN
    ? t(`taskDetail.diagnostics.rate.${bound}`, { value: text })
    : text;
  const rate = metrics.outputTokensPerSecond;
  // A null baseline metric is insufficient history, never 0: the group says so
  // rather than comparing this run against a number nobody measured. The run's
  // own reading stays out of that branch, so an absent baseline adds no unknown
  // markers to a block whose markers all mean "unmeasured reading".
  const comparison = (
    metric: RunBaselineMetric | null | undefined,
    label: string,
    own: string,
    ratio: number | null,
    format: (value: number) => string,
  ): ReactNode => (
    <span className="inline-flex flex-wrap items-baseline gap-x-[16px] gap-y-[5px]">
      {metric === null || metric === undefined ? (
        <Stat k={label} v={t("taskDetail.diagnostics.baseline.insufficient")} />
      ) : (
        <>
          <Stat k={label} v={own} />
          <Stat k={t("taskDetail.diagnostics.baseline.p50")} v={format(metric.p50)} />
          <Stat k={t("taskDetail.diagnostics.baseline.p90")} v={format(metric.p90)} />
          <Stat
            k={t("taskDetail.diagnostics.baseline.ratio")}
            v={measured(ratio) ? t("taskDetail.diagnostics.baseline.ratioValue", { value: ratio.toFixed(2) }) : UNKNOWN}
          />
        </>
      )}
    </span>
  );
  return (
    <div data-run-diagnostics="" className="grid gap-[12px] border-t border-[color:var(--border-soft)] pt-[14px]">
      {title}
      <div className="grid gap-[5px]">
        <div className="text-[11.5px] text-muted-foreground">{t("taskDetail.diagnostics.phases")}</div>
        <PhaseBar phases={phases} />
      </div>
      <DiagnosticsRow k={t("taskDetail.diagnostics.ttft.title")}>
        <Stat k={t("taskDetail.diagnostics.ttft.p50")} v={durationMs(ttft?.p50Ms)} />
        <Stat k={t("taskDetail.diagnostics.ttft.p90")} v={durationMs(ttft?.p90Ms)} />
        <Stat k={t("taskDetail.diagnostics.ttft.samples")} v={String(ttft?.samples ?? 0)} />
      </DiagnosticsRow>
      <DiagnosticsRow k={t("taskDetail.diagnostics.tokens.title")}>
        <Stat k={t("taskDetail.diagnostics.tokens.input")} v={compactTokens(tokens.input)} />
        <Stat k={t("taskDetail.diagnostics.tokens.cachedRead")} v={compactTokens(tokens.cachedRead)} />
        <Stat k={t("taskDetail.diagnostics.tokens.cacheWrite")} v={compactTokens(tokens.cacheWrite)} />
        <Stat k={t("taskDetail.diagnostics.tokens.output")} v={compactTokens(tokens.output)} />
        <Stat k={t("taskDetail.diagnostics.tokens.cacheHit")} v={percent(tokens.cacheHitRatio) ?? UNKNOWN} />
      </DiagnosticsRow>
      <DiagnosticsRow k={t("taskDetail.diagnostics.tools.title")}>
        <Stat k={t("taskDetail.diagnostics.tools.calls")} v={String(tools.calls)} />
        <Stat k={t("taskDetail.diagnostics.tools.failed")} v={String(tools.failed)} />
        <Stat k={t("taskDetail.diagnostics.tools.unclassified")} v={String(tools.unclassified)} />
        {tools.byName.map((entry) => (
          <Stat
            key={entry.name}
            k={entry.name}
            v={t("taskDetail.diagnostics.tools.entry", { calls: entry.calls, failed: entry.failed })}
          />
        ))}
      </DiagnosticsRow>
      <DiagnosticsRow k={t("taskDetail.diagnostics.baseline.title")}>
        {comparison(
          baseline?.costUsd,
          t("taskDetail.diagnostics.baseline.cost"),
          costUsd === null || costUsd === undefined ? UNKNOWN : usageMoney(costUsd),
          metrics.vsBaseline.costRatio,
          (value) => usageMoney(value),
        )}
        {comparison(
          baseline?.durationMs,
          t("taskDetail.diagnostics.baseline.duration"),
          durationMs(phases.executingMs),
          metrics.vsBaseline.durationRatio,
          (value) => durationMs(value),
        )}
      </DiagnosticsRow>
      <div className="grid gap-[5px]">
        <DiagnosticsRow k={t("taskDetail.diagnostics.rate.label")}>
          {/* Unkeyed: the row heading already names it, and a second "Rate"
              label beside "Effective output rate" reads as two numbers. */}
          <span className="whitespace-nowrap">
            {bounded(tokensPerSecond(rate), "lowerBound")}
          </span>
          <Stat k={t("taskDetail.diagnostics.modelActive")} v={bounded(durationMs(metrics.modelActiveMs), "upperBound")} />
        </DiagnosticsRow>
        <div className={HINT}>{t("taskDetail.diagnostics.rate.note")}</div>
      </div>
      <DiagnosticsRow k={t("taskDetail.diagnostics.termination.title")}>
        <Stat k={t("taskDetail.diagnostics.termination.reason")} v={termination.reason ?? runTerminationReason ?? UNKNOWN} />
        <Stat
          k={t("taskDetail.diagnostics.termination.exitCode")}
          v={measured(termination.exitCode) ? String(termination.exitCode) : UNKNOWN}
        />
        <Stat k={t("taskDetail.diagnostics.termination.signal")} v={termination.signal ?? UNKNOWN} />
      </DiagnosticsRow>
    </div>
  );
};
