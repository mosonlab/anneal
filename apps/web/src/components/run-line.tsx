import type { ReactNode } from "react";

import { splitModel } from "@anneal/db/model-routing";

import { duration } from "../lib/format";
import { useT } from "../lib/i18n";
import { mergeBadge } from "../lib/merge-outcome";
import { type RunLivenessSubject, runLiveness } from "../lib/board";
import type { CodexServiceTier, MergeOutcome, RunStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

export const DOT = "size-[7px] rounded-full bg-[color:var(--faint)]";
export const DOT_TONE = {
  on: "bg-[color:var(--status-green-fg)] shadow-[0_0_8px_color-mix(in_srgb,var(--status-green-fg)_55%,transparent)]",
  off: "bg-destructive",
  green: "bg-[color:var(--status-green-fg)]",
  amber: "bg-[color:var(--status-amber-fg)]",
  red: "bg-[color:var(--destructive-fg)]",
} as const;

type RunTone = "green" | "amber" | "red" | "grey" | "accent";
type RunPresentation = { tone: RunTone; key: string };

const PILL_TONE: Record<RunStatus, RunTone> = {
  QUEUED: "grey", CLAIMED: "amber", PROVISIONING: "amber", RUNNING: "amber", WAITING_INBOX: "accent",
  SUCCEEDED: "green", FAILED: "red", TIMED_OUT: "red", CANCELLED: "grey", LOST: "red",
};

const runPresentation = (
  status: RunStatus,
  mergeOutcome?: MergeOutcome | null | undefined,
): RunPresentation => {
  const badge = mergeBadge(mergeOutcome);
  return badge ?? { tone: PILL_TONE[status], key: `status.run.${status}` };
};

const dotTone = (status: RunStatus, mergeOutcome?: MergeOutcome | null | undefined): keyof typeof DOT_TONE => {
  const badge = mergeBadge(mergeOutcome);
  if (badge) return badge.tone;
  if (status === "SUCCEEDED") return "green";
  if (status === "FAILED" || status === "TIMED_OUT" || status === "LOST") return "red";
  return "amber";
};

/** Cards name the model, not the route that reached it: an `openai-codex/`
 *  prefix repeats what the model name already says, and the card has no room to
 *  say it twice. The detail page keeps the full identifier. */
const cardModelName = (model: string): string => model.slice(model.lastIndexOf("/") + 1);

/** Everything the line reads off a run. Both projections satisfy it, so the
 *  detail page hands over its `Run` and the board its `BoardLatestRun`. */
export type RunLineSubject = RunLivenessSubject & {
  runNumber: number;
  model: string;
  codexServiceTier: CodexServiceTier;
};

/** Which element draws the run's live state. `caller` is the task card, whose
 *  footer names the phase and counts time in it, so the line drops the status
 *  word for every live run rather than reading "Provisioning" above a footer
 *  saying "Provisioning · 20s". `line` draws its own clock and drops only the
 *  RUNNING word. Stated rather than defaulted, because the answer is never
 *  "nobody": a live run's word goes on the strength of a clock showing
 *  somewhere. */
export type ElapsedOwner = "line" | "caller";

/** The sole board rendering of a Run: number, dot tone, status word, and merge override. */
export const RunLine = ({
  run,
  mergeOutcome,
  elapsed: elapsedOwner,
  showModel = false,
}: {
  run: RunLineSubject;
  mergeOutcome?: MergeOutcome | null | undefined;
  elapsed: ElapsedOwner;
  /** Aggregate cards put the claimed model beside the run; task cards retain
   * their dedicated model row and leave this off. */
  showModel?: boolean;
}): ReactNode => {
  const t = useT();
  const liveness = runLiveness(run);
  const presentation = runPresentation(run.status, mergeOutcome);
  const elapsed = elapsedOwner === "line" && liveness.elapsedSince !== null
    ? duration(liveness.elapsedSince, null)
    : null;
  const model = showModel ? splitModel(run.model) : null;
  const badge = mergeBadge(mergeOutcome);
  const hideStatus = badge === null && (elapsedOwner === "caller" ? liveness.live : liveness.statusSuppressed);
  const runDetailParts = [
    ...(model === null ? [] : [
      cardModelName(model.model),
      ...(model.effort === null ? [] : [model.effort]),
      ...(run.codexServiceTier === "FAST" ? ["fast"] : []),
    ]),
    // `statusSuppressed` owns why RUNNING is the one word a clock replaces;
    // `ElapsedOwner` owns why a task card's line names no live status at all.
    ...(hideStatus ? [] : [t(presentation.key)]),
    ...(elapsed === null ? [] : [elapsed]),
  ];
  const runDetails = runDetailParts
    .map((part) => part.replaceAll(" ", "\u00a0"))
    .join(" · ");
  // The row's live values sit at the end of the details string, so truncating
  // it hid exactly what the row exists to show. Non-breaking spaces keep each
  // logical detail together so normal wrapping prefers the " · " separators;
  // [overflow-wrap:anywhere] catches a token wider than the column.
  return (
    <span data-run-line="" className="inline-flex min-w-0 flex-wrap items-center gap-x-[6px]">
      <span className="inline-flex flex-none items-center gap-[6px] whitespace-nowrap">
        <span className={cn(DOT, DOT_TONE[dotTone(run.status, mergeOutcome)])} />
        <span className="text-primary">{t("tasks.card.run", { n: run.runNumber })}</span>
      </span>
      {runDetails.length === 0 ? null : (
        <span data-run-line-details="" className="min-w-0 [overflow-wrap:anywhere] text-[color:var(--faint)]">
          {` · ${runDetails}`}
        </span>
      )}
    </span>
  );
};

/** The detail/list form crosses the same status-to-presentation seam as RunLine. */
export const RunPill = ({ status, mergeOutcome }: {
  status: RunStatus;
  mergeOutcome?: MergeOutcome | null | undefined;
}): ReactNode => {
  const t = useT();
  const presentation = runPresentation(status, mergeOutcome);
  return <Badge variant="outline" shape="pill" tone={presentation.tone}>{t(presentation.key)}</Badge>;
};
