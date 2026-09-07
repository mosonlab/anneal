import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  hasSessionListFilters, SESSION_RUNNER_FILTERS, SESSION_STATUS_FILTERS,
  type SessionStatusFilter,
} from "@anneal/db/session-filter-contract";

import { api } from "../lib/api";
import { compact, compactTokens, durationWithInboxWait, formatDate, formatDateTime, formatT, money, repoWebUrl, timeAgo } from "../lib/format";
import { POLL_MS, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { mergeBadge } from "../lib/merge-outcome";
import { fatal } from "../lib/poll-state";
import { Link, navigate, replace, useQuery } from "../lib/router";
import { useProjectScope } from "../lib/project";
import {
  clampLines, projectStream, RESUME_MARKER_TEXT, TEXT_NODE_MAX_LINES, TOOL_OUTPUT_MAX_LINES,
  type StreamNode, type ToolCall,
} from "../lib/session-stream";
import {
  ALL_SESSION_FILTER, groupSessionsByDay, isLiveStatus,
  isSessionUnseen, markSessionOpened, readSessionSeenState, readSessionSelection,
  SESSION_DAY_PAGE_SIZE, SESSION_RANGE_PRESETS, SESSIONS_ROUTE, sessionAgentOptions, sessionDayLabelKind,
  sessionListPath, sessionSelectionFilters, sessionsFilterHref,
  type SessionDayGroup, type SessionFilterOption, type SessionListSelection, type SessionRangePreset,
  type SessionSeenState,
} from "../lib/session-list";
import { useEventStream } from "../lib/use-event-stream";
import type { Agent, MergeOutcome, RunnerKind, Session, SessionEvent, SessionExecutionStatus } from "../lib/types";
import {
  IconArrowLeft, IconChevron, IconRefresh, IconToolDefault, IconToolEdit, IconToolRead, IconToolRun, IconToolSearch,
  IconToolWeb,
} from "../components/icons";
import {
  BACK_LINK, CODE_BLOCK, COUNT, DETAIL_HEAD, DETAIL_HEAD_H1, DOT, DOT_TONE, HINT, MSG_CARD, MSG_HEAD, MSG_TIME,
  PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW, STACK,
  STAT_PILL, STAT_PILLS,
  AgentChip, Card, EmptyState, ErrorNotice, KeyValue, MarkdownClamp, Page, Pill, Segmented,
  type AgentChipAgent, type PillTone,
} from "../components/ui";
import { ModelLabel } from "../components/model-picker";
import { Button } from "../components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/ui/hover-card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { cn } from "../lib/utils";

/** `.eventLog` is the scroll container and `.eventRow` is the row grid — two
 *  different boxes, not one. Moved here verbatim from TaskDetail: this page is
 *  now the product's only raw event table. */
const EVENT_LOG = "max-h-[420px] overflow-auto rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--code-background)]";
const EVENT_ROW = "grid grid-cols-[46px_92px_1fr] gap-[10px] border-b border-[color:var(--event-line)] px-[12px] py-[7px] text-[11.5px] last:border-b-0";

const PAGE_SIZE = 50;
const BLOCK_MAX = 8_000;
/** Auto-scroll only when the reader is already at the bottom (assumption A3). */
const NEAR_BOTTOM_PX = 100;

/** §4.1.1. Reuses the existing tone vocabulary; no new tones. */
export const sessionPill = (
  status: SessionExecutionStatus,
  mergeOutcome?: MergeOutcome | null | undefined,
): { tone: PillTone; label: string } => {
  // §SF-1 first, and only for a mechanical merge that stopped: this session's
  // run ended SUCCEEDED and the sessions list would otherwise read Done.
  const badge = mergeBadge(mergeOutcome);
  if (badge) return { tone: badge.tone, label: formatT(badge.key) };
  if (status === "REQUESTED" || status === "PROVISIONING") return { tone: "grey", label: formatT("sessions.pill.queued") };
  if (status === "RUNNING") return { tone: "green", label: formatT("sessions.pill.running") };
  if (status === "WAITING_INBOX") return { tone: "amber", label: formatT("sessions.pill.waiting") };
  if (status === "SUCCEEDED") return { tone: "green", label: formatT("sessions.pill.done") };
  if (status === "CANCELLED") return { tone: "grey", label: formatT("sessions.pill.cancelled") };
  // The remaining three — FAILED, TIMED_OUT, LOST — read exactly as the shared
  // per-enum status table already spells them.
  return { tone: "red", label: formatT(`status.session.${status}`) };
};

/** The stat bar's own lifecycle slot: `● Live` while the session runs, and on a
 *  terminal session the same slot reads Done or Failed. The header's status pill
 *  is a different element and does not satisfy this. */
export const lifecycleStat = (
  status: SessionExecutionStatus,
  mergeOutcome?: MergeOutcome | null | undefined,
): { label: string; tone: "green" | "amber" | "red" } => {
  // The stat's two tones become three for the same §SF-1 reason: a stopped
  // merge is neither Done nor Failed, and calling it either of them is a lie.
  const badge = mergeBadge(mergeOutcome);
  if (badge) return { label: formatT(badge.key), tone: badge.tone };
  return isLiveStatus(status) ? { label: formatT("sessions.lifecycle.live"), tone: "green" }
    : status === "SUCCEEDED" ? { label: formatT("sessions.lifecycle.done"), tone: "green" }
      : { label: formatT("sessions.lifecycle.failed"), tone: "red" };
};

/** `Files touched` shows `(0)` whenever path extraction found nothing. For
 *  CLAUDE that means the session really touched no file — the mapping is
 *  verified against real captured stdout. For every other runner the argument
 *  keys are inferred (plan §11-G1/G2), so a zero is as likely to be a gap in the
 *  mapping as a fact about the session, and saying so is the honest rendering. */
export const fileTrackingHint = (runner: RunnerKind, fileCount: number, toolCalls: number): string | null =>
  runner !== "CLAUDE" && fileCount === 0 && toolCalls > 0
    ? formatT("sessions.files.hint", { runner })
    : null;

/** The notice is unconditional for `WAITING_INBOX`; only the link is conditional.
 *  A session parked before its message id lands is exactly the state where an
 *  operator most needs to be told why nothing is happening. */
export const WaitingNotice = ({ status, messageId }: { status: SessionExecutionStatus; messageId: string | null }): ReactNode => {
  const t = useT();
  if (status !== "WAITING_INBOX") return null;
  const text = t("sessions.waiting");
  return (
    <div className={ROW}>
      {messageId === null ? <span>{text}</span> : <Link to={`/inbox/${messageId}`}>{text} ↗</Link>}
    </div>
  );
};

/** The chip's subject for a session row: who ran it, and the model that run
 *  carried. `run` is absent on the session rows nested inside a Run, so the chip
 *  degrades to the title rather than inventing a model. */
export const sessionChipAgent = (session: Session): AgentChipAgent | null => {
  if (!session.agent) return null;
  const model = session.run?.model;
  return model === undefined ? session.agent : { ...session.agent, model };
};

const resultWord = (session: Session): string =>
  formatT(isLiveStatus(session.executionStatus) ? "sessions.result.inProgress"
    : session.executionStatus === "SUCCEEDED" ? "sessions.result.success" : "sessions.result.failed");

const SessionStatusPill = ({ status, mergeOutcome }: { status: SessionExecutionStatus; mergeOutcome?: MergeOutcome | null | undefined }): ReactNode => {
  const { tone, label } = sessionPill(status, mergeOutcome);
  return <Pill tone={tone}>{label}</Pill>;
};

/* -------------------------------------------------------------- the list */

const SESSION_ROW = "flex min-w-0 items-center gap-[12px] border-b border-[color:var(--border-soft)] px-[20px] py-[13px] last:border-b-0 hover:bg-secondary";
const SESSION_TITLE = "min-w-0 flex-1 rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-[color:var(--ring)]";
const SESSION_DAY_HEADING = "flex items-baseline gap-[9px] border-b border-[color:var(--border-soft)] bg-secondary/45 px-[20px] py-[10px]";
const SESSION_DAY_ROWS = "divide-y divide-[color:var(--border-soft)]";

const sessionDotTone = (tone: PillTone): string | undefined => {
  if (tone === "green") return DOT_TONE.green;
  if (tone === "amber") return DOT_TONE.amber;
  if (tone === "red") return DOT_TONE.red;
  // The existing dot vocabulary intentionally has no coloured grey state;
  // leaving the base DOT class in place preserves its faint/inert appearance.
  return undefined;
};

/** The row's chain, as the filter that finds the rest of it. A chained task
 *  whose name the server could not derive still links: the id is what narrows
 *  the list, and the word Chain says what the link does. */
export const SessionChainLink = ({ task }: { task: Session["task"] }): ReactNode => {
  const t = useT();
  const chainId = task?.chainId ?? null;
  if (chainId === null) return null;
  return (
    <Link
      to={sessionsFilterHref({ chainId })}
      className="max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap rounded-sm hover:underline"
      title={t("sessions.row.chainFilter")}
    >
      <span data-session-chain={chainId}>{task?.chainName ?? t("sessions.row.chain")}</span>
    </Link>
  );
};

const SessionHoverCard = ({ session, unseen }: { session: Session; unseen: boolean }): ReactNode => {
  const t = useT();
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <div data-session-title tabIndex={0} className={SESSION_TITLE}>
          <div className={cn(
            "overflow-hidden text-ellipsis whitespace-nowrap text-foreground hover:underline",
            unseen ? "font-bold" : "font-normal",
          )}>
            {session.task
              ? <Link to={`/tasks/${session.task.id}`}>{session.task.name}</Link>
              : session.goal
                ? <Link to={`/goals/${session.goal.id}`}>{session.goal.title}</Link>
                : session.id}
          </div>
          <div className="mt-[3px] flex items-center gap-[8px] text-[11.5px] text-muted-foreground">
            {/* The chip carries the model this session actually executed, which
                the row's own Run snapshot already holds. The roster's current
                configuration is a different fact and belongs on the Agent. */}
            <AgentChip agent={sessionChipAgent(session)} name={session.agentId} />
            <SessionChainLink task={session.task} />
          </div>
        </div>
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" sideOffset={8} className="w-[320px] rounded-lg p-[14px]">
        <KeyValue columns={2} items={[
          { k: t("sessions.detail.started"), v: formatDateTime(session.startedAt ?? session.requestedAt) },
          { k: t("sessions.detail.duration"), v: durationWithInboxWait(
            session.startedAt,
            session.endedAt,
            session.executionStatus === "WAITING_INBOX" || session.resumeAttempt > 0,
          ) },
          { k: t("sessions.hover.runner"), v: session.runner },
          { k: t("sessions.hover.result"), v: resultWord(session) },
          { k: t("sessions.detail.run"), v: session.run ? `#${session.run.runNumber}` : "—" },
          ...(session.failureReason
            ? [{ k: t("sessions.row.failureReason"), v: <span className="text-[color:var(--destructive-fg)] [overflow-wrap:anywhere]">{compact(session.failureReason, 200)}</span> }]
            : []),
        ]} />
      </HoverCardContent>
    </HoverCard>
  );
};

export const SessionRow = ({ session, unseen = false }: { session: Session; unseen?: boolean }): ReactNode => {
  const { tone } = sessionPill(session.executionStatus, session.mergeOutcome);
  return (
    <div
      data-session-row
      className={cn(SESSION_ROW, "cursor-pointer")}
      // Link calls preventDefault and navigates but does not stop propagation,
      // so without this guard clicking the Task cell would open the session.
      onClick={(event) => { if (!event.defaultPrevented) navigate(`/sessions/${session.id}`); }}
    >
      <span aria-hidden="true" data-session-status className={cn(DOT, sessionDotTone(tone))} />
      <SessionHoverCard session={session} unseen={unseen} />
      {unseen ? <span aria-hidden="true" data-session-unseen className={cn(DOT, DOT_TONE.green)} /> : null}
      <span data-session-time className="shrink-0 text-[11.5px] text-muted-foreground">
        {timeAgo(session.startedAt ?? session.requestedAt)}
      </span>
    </div>
  );
};

const SessionDayGroupView = ({
  group,
  expanded,
  onToggle,
  seenState,
}: {
  group: SessionDayGroup;
  expanded: boolean;
  onToggle: () => void;
  seenState: SessionSeenState | null;
}): ReactNode => {
  const t = useT();
  const kind = sessionDayLabelKind(group.key);
  const heading = kind === "today"
    ? t("sessions.day.today")
    : kind === "yesterday"
      ? t("sessions.day.yesterday")
      : formatDate(group.at);
  const remaining = Math.max(0, group.sessions.length - SESSION_DAY_PAGE_SIZE);
  const visible = expanded ? group.sessions : group.sessions.slice(0, SESSION_DAY_PAGE_SIZE);
  return (
    <section data-session-day={group.key}>
      <div className={SESSION_DAY_HEADING}>
        <h2 className="text-[12.5px] font-bold text-foreground">{heading}</h2>
        <span data-session-day-count className="text-[11.5px] text-muted-foreground">
          {t("sessions.day.count", { n: group.sessions.length })}
        </span>
      </div>
      <div className={SESSION_DAY_ROWS}>
        {visible.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            unseen={seenState !== null && isSessionUnseen(session, seenState)}
          />
        ))}
      </div>
      {remaining > 0 ? (
        <div className="border-t border-[color:var(--border-soft)] px-[20px] py-[9px]">
          <button
            type="button"
            data-session-day-toggle
            className="border-0 bg-transparent p-0 text-[12px] text-primary hover:underline"
            onClick={onToggle}
          >
            {t(expanded ? "sessions.day.collapse" : "sessions.day.expand", expanded ? undefined : { n: remaining })}
          </button>
        </div>
      ) : null}
    </section>
  );
};

/** Long enough that typing a word costs one request rather than five, short
 *  enough that the list answers while the operator is still looking at the box. */
const SESSION_SEARCH_DEBOUNCE_MS = 300;

/** The roster only changes when an operator edits it, so it is read rarely and
 *  reused as the Agent filter's stable vocabulary. */
const ROSTER_POLL_MS = 300_000;

const FILTER_FIELD = "flex items-center gap-[6px] text-[12px] text-secondary-foreground";

export const SessionFilterBar = ({ selection, agentOptions, searchText, onSearchText, onSelect, onClear }: {
  selection: SessionListSelection;
  agentOptions: SessionFilterOption[];
  searchText: string;
  onSearchText: (value: string) => void;
  onSelect: (patch: Partial<SessionListSelection>) => void;
  onClear: () => void;
}): ReactNode => {
  const t = useT();
  const statusLabels: Record<SessionStatusFilter, string> = {
    live: t("sessions.filter.live"),
    done: t("sessions.filter.done"),
    failed: t("sessions.filter.failed"),
    cancelled: t("sessions.filter.cancelled"),
  };
  const rangeLabels: Record<SessionRangePreset, string> = {
    all: t("sessions.range.all"),
    today: t("sessions.range.today"),
    "7d": t("sessions.range.days7"),
    "30d": t("sessions.range.days30"),
    custom: t("sessions.range.custom"),
  };
  return (
    <div data-session-filters className="flex flex-wrap items-center gap-[10px]">
      <label className={FILTER_FIELD}>
        <span>{t("sessions.filter.search")}</span>
        <Input
          type="search"
          aria-label={t("sessions.filter.search")}
          data-session-filter-search
          className="w-[190px]"
          placeholder={t("sessions.filter.searchPlaceholder")}
          value={searchText}
          onChange={(event) => onSearchText(event.target.value)}
        />
      </label>
      <label className={FILTER_FIELD}>
        <span>{t("sessions.filter.agent")}</span>
        <Select
          aria-label={t("sessions.filter.agent")}
          data-session-filter-agent
          className="w-[150px]"
          value={selection.agentId ?? ALL_SESSION_FILTER}
          onChange={(event) => onSelect({ agentId: event.target.value === ALL_SESSION_FILTER ? null : event.target.value })}
        >
          {agentOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </label>
      <label className={FILTER_FIELD}>
        <span>{t("sessions.filter.status")}</span>
        <Select
          aria-label={t("sessions.filter.status")}
          data-session-filter-status
          className="w-[130px]"
          value={selection.status ?? ALL_SESSION_FILTER}
          onChange={(event) => onSelect({
            status: event.target.value === ALL_SESSION_FILTER ? null : event.target.value as SessionStatusFilter,
          })}
        >
          <option value={ALL_SESSION_FILTER}>{t("sessions.filter.all")}</option>
          {SESSION_STATUS_FILTERS.map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}
        </Select>
      </label>
      <label className={FILTER_FIELD}>
        <span>{t("sessions.filter.runner")}</span>
        <Select
          aria-label={t("sessions.filter.runner")}
          data-session-filter-runner
          className="w-[130px]"
          value={selection.runner ?? ALL_SESSION_FILTER}
          onChange={(event) => onSelect({
            runner: event.target.value === ALL_SESSION_FILTER ? null : event.target.value as RunnerKind,
          })}
        >
          <option value={ALL_SESSION_FILTER}>{t("sessions.filter.all")}</option>
          {SESSION_RUNNER_FILTERS.map((value) => <option key={value} value={value}>{t(`runner.cli.${value}`)}</option>)}
        </Select>
      </label>
      <label className={FILTER_FIELD}>
        <span>{t("sessions.filter.range")}</span>
        <Select
          aria-label={t("sessions.filter.range")}
          data-session-filter-range
          className="w-[130px]"
          value={selection.range}
          onChange={(event) => onSelect({ range: event.target.value as SessionRangePreset })}
        >
          {SESSION_RANGE_PRESETS.map((value) => <option key={value} value={value}>{rangeLabels[value]}</option>)}
        </Select>
      </label>
      {selection.range === "custom" ? (
        <>
          <label className={FILTER_FIELD}>
            <span>{t("sessions.filter.since")}</span>
            <Input
              type="date"
              aria-label={t("sessions.filter.since")}
              data-session-filter-since
              className="w-[150px]"
              value={selection.since ?? ""}
              onChange={(event) => onSelect({ since: event.target.value === "" ? null : event.target.value })}
            />
          </label>
          <label className={FILTER_FIELD}>
            <span>{t("sessions.filter.until")}</span>
            <Input
              type="date"
              aria-label={t("sessions.filter.until")}
              data-session-filter-until
              className="w-[150px]"
              value={selection.until ?? ""}
              onChange={(event) => onSelect({ until: event.target.value === "" ? null : event.target.value })}
            />
          </label>
        </>
      ) : null}
      {!hasSessionListFilters(sessionSelectionFilters(selection, new Date())) ? null : (
        <Button type="button" variant="legacy" size="legacy" data-session-filter-clear onClick={onClear}>
          {t("sessions.filter.clear")}
        </Button>
      )}
    </div>
  );
};

export const SessionsPage = (): ReactNode => {
  const { projectId, project } = useProjectScope();
  // The hash carries the filters: a narrowed view can be shared, survives a
  // reload, and is what a chain chip or the task page links to. Reading the
  // selection from it rather than from state keeps those three the same path.
  const search = useQuery().toString();
  const selection = useMemo(() => readSessionSelection(new URLSearchParams(search)), [search]);
  // Today advances at local midnight; rolling ranges advance hourly. Polls
  // between those boundaries retain their path and accumulated history.
  const [windowClock, setWindowClock] = useState(() => new Date());
  useEffect(() => {
    if (!["today", "7d", "30d"].includes(selection.range)) return;
    const now = new Date();
    const next = selection.range === "today"
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
      : (Math.floor(now.getTime() / 3_600_000) + 1) * 3_600_000;
    const timer = setTimeout(() => setWindowClock(new Date()), Math.max(1, next - now.getTime()));
    return () => clearTimeout(timer);
  }, [selection.range, windowClock]);
  const filters = useMemo(() => sessionSelectionFilters(selection, new Date()), [selection, windowClock]);
  const path = projectId === "" ? null : sessionListPath(projectId, PAGE_SIZE, filters);
  const requestGeneration = useRef({ path, generation: 0 });
  if (requestGeneration.current.path !== path) {
    requestGeneration.current = { path, generation: requestGeneration.current.generation + 1 };
  }
  const head = usePoll<Session[]>(path, POLL_MS);
  // The Agent choices come from the project roster, not from the rows on
  // screen: narrowing to one Agent must not leave that Agent as the only one
  // left to choose.
  const roster = usePoll<Agent[]>(projectId === "" ? null : `/projects/${encodeURIComponent(projectId)}/agents`, ROSTER_POLL_MS);
  // Older pages are history: fetched imperatively, never polled, and dropped
  // whenever the request changes. usePoll replaces its data on every response,
  // so the live head cannot also hold them.
  const [older, setOlder] = useState<Session[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());
  const [seenSnapshot, setSeenSnapshot] = useState<{ projectId: string; state: SessionSeenState } | null>(() => (
    projectId === "" ? null : { projectId, state: readSessionSeenState(projectId) }
  ));
  const [searchText, setSearchText] = useState(selection.q ?? "");
  const t = useT();

  const select = useCallback((patch: Partial<SessionListSelection>): void => {
    // `replace`, not `navigate`: the URL describes which slice of the history
    // is on screen, and stepping through filters must not cost a press of Back
    // each to leave the page.
    replace(sessionsFilterHref({ ...selection, ...patch }));
  }, [selection]);

  const seenProjectAtMount = useRef(projectId);
  useEffect(() => {
    const previous = seenProjectAtMount.current;
    seenProjectAtMount.current = projectId;
    if (projectId === "") {
      setSeenSnapshot(null);
      return;
    }
    if (previous === projectId) return;
    setSeenSnapshot({ projectId, state: readSessionSeenState(projectId) });
    // A different project is different work: it inherits neither the filters
    // nor the link that named them. The scope resolving from empty to the
    // selected project is not a change of project, so arriving on a shared
    // filtered URL still lands filtered.
    if (previous !== "") replace(SESSIONS_ROUTE);
  }, [projectId]);

  // Every filter change is a new first page. The cursor, the pages already
  // fetched under the previous filters and the per-day expansions all belong to
  // the request that produced them.
  useEffect(() => {
    setOlder([]);
    setLoadingMore(false);
    setExhausted(false);
    setMoreError(null);
    setExpandedDays(new Set());
  }, [path]);

  // The box is typed into locally and reaches the URL — and so the server —
  // only once the operator pauses. A change from anywhere else (Clear, a shared
  // link, a project switch) is followed back into the box.
  useEffect(() => { setSearchText(selection.q ?? ""); }, [selection.q]);
  useEffect(() => {
    const next = searchText.trim();
    if (next === (selection.q ?? "")) return;
    const timer = setTimeout(() => select({ q: next.length === 0 ? null : next }), SESSION_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText, selection.q, select]);

  const sessions = useMemo(() => {
    const byId = new Map<string, Session>();
    for (const session of [...(head.data ?? []), ...older]) if (!byId.has(session.id)) byId.set(session.id, session);
    return [...byId.values()].sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  }, [head.data, older]);

  const dayGroups = useMemo(() => groupSessionsByDay(sessions), [sessions]);
  const agentOptions = useMemo(
    () => sessionAgentOptions(sessions, roster.data ?? [], t("sessions.filter.all")),
    [sessions, roster.data, t],
  );
  const filtersActive = hasSessionListFilters(filters);
  const seenState = seenSnapshot?.projectId === projectId ? seenSnapshot.state : null;

  const toggleDay = (key: string): void => {
    setExpandedDays((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const loadMore = async (): Promise<void> => {
    const oldest = sessions.at(-1);
    if (!oldest) return;
    const generation = requestGeneration.current.generation;
    setLoadingMore(true);
    setMoreError(null);
    try {
      // The same filters as the head, so paging continues through the narrowed
      // history rather than reopening the whole of it.
      const page = await api.get<Session[]>(sessionListPath(projectId, PAGE_SIZE, filters, oldest.requestedAt));
      if (generation !== requestGeneration.current.generation) return;
      setOlder((current) => [...current, ...page]);
      if (page.length < PAGE_SIZE) setExhausted(true);
    } catch (error) {
      // Surfaced beside the button, which stays enabled as the retry. Without
      // this the failure is an unhandled rejection and the operator sees nothing.
      if (generation !== requestGeneration.current.generation) return;
      const failure = error as { status?: number; message?: string };
      setMoreError(failure.status === undefined ? String(failure.message ?? error) : `${failure.status} ${failure.message}`);
    } finally {
      if (generation === requestGeneration.current.generation) setLoadingMore(false);
    }
  };

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("sessions.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("sessions.head.subtitle", { project: project?.name ?? t("tasks.head.thisProject") })}</div>
        </div>
        <div className={cn(PAGE_ACTIONS, "flex-wrap justify-end")}>
          <Button type="button" variant="legacy" size="legacy" onClick={head.reload}><IconRefresh />{t("common.refresh")}</Button>
        </div>
      </div>

      <div className={STACK}>
        <SessionFilterBar
          selection={selection}
          agentOptions={agentOptions}
          searchText={searchText}
          onSearchText={setSearchText}
          onSelect={select}
          onClear={() => replace(SESSIONS_ROUTE)}
        />
        {fatal(head.error, head.data)
          ? <ErrorNotice message={`${head.error!.status} ${head.error!.code ?? ""} ${head.error!.message}`} onRetry={head.reload} />
          : null}
        <Card flush>
          <div data-session-list>
            {dayGroups.map((group) => (
              <SessionDayGroupView
                key={group.key}
                group={group}
                expanded={expandedDays.has(group.key)}
                seenState={seenState}
                onToggle={() => toggleDay(group.key)}
              />
            ))}
          </div>
          {dayGroups.length === 0
            ? <EmptyState>{t(head.loading ? "common.loading" : filtersActive ? "sessions.empty.filtered" : "sessions.empty")}</EmptyState>
            : null}
        </Card>
        {sessions.length >= PAGE_SIZE && !exhausted ? (
          <div className={ROW}>
            <Button type="button" variant="legacy" size="legacy" disabled={loadingMore} onClick={() => void loadMore()}>
              {t(loadingMore ? "common.loading" : "sessions.loadMore")}
            </Button>
            {moreError === null ? null : <ErrorNotice message={moreError} />}
          </div>
        ) : null}
      </div>
    </Page>
  );
};

/* ------------------------------------------------------------ the detail */

export const truncateBlock = (text: string): string =>
  text.length <= BLOCK_MAX
    ? text
    : `${text.slice(0, BLOCK_MAX)}\n${formatT("sessions.truncated", { n: text.length - BLOCK_MAX })}`;

const TOOL_STATE_TONE: Record<string, string> = {
  running: "text-[color:var(--status-amber-fg)]",
  incomplete: "text-[color:var(--status-amber-fg)]",
  error: "text-[color:var(--destructive-fg)]",
  ok: "text-muted-foreground",
};

type ToolKind = "read" | "edit" | "search" | "run" | "web" | "default";

const TOOL_KIND_ICONS: Record<ToolKind, () => ReactNode> = {
  read: IconToolRead,
  edit: IconToolEdit,
  search: IconToolSearch,
  run: IconToolRun,
  web: IconToolWeb,
  default: IconToolDefault,
};

const toolKind = (name: string): ToolKind => {
  const lower = name.toLowerCase();
  if (/read|cat|view|open/u.test(lower)) return "read";
  if (/edit|write|patch|replace|delete/u.test(lower)) return "edit";
  if (/search|grep|glob|find/u.test(lower)) return "search";
  if (/run|bash|shell|exec|command|terminal/u.test(lower)) return "run";
  if (/web|http|fetch|browser|url/u.test(lower)) return "web";
  return "default";
};

const jsonBlock = (value: unknown): string => JSON.stringify(value ?? null, null, 2) ?? "—";

/** Apply the line budget before the existing byte backstop. The line notice is
 *  appended after the byte truncator so both notices remain visible when a
 *  single capped line is also over the character budget. */
const cappedBlock = (
  text: string,
  t: ReturnType<typeof useT>,
): string => {
  const lineClamp = clampLines(text, TOOL_OUTPUT_MAX_LINES);
  const byteClamp = truncateBlock(lineClamp.text);
  return lineClamp.dropped === 0
    ? byteClamp
    : `${byteClamp}\n${t("sessions.tool.linesWithheld", { n: lineClamp.dropped })}`;
};

const ToolCallLine = ({ call }: { call: ToolCall }): ReactNode => {
  const [open, setOpen] = useState(false);
  const t = useT();
  const kind = toolKind(call.name);
  const Icon = TOOL_KIND_ICONS[kind];
  const failedSummary = call.result?.split(/\r?\n/u)[0]?.trim() ?? "";
  const summary = call.state === "error" ? (failedSummary || call.primaryArg || "") : call.primaryArg ?? "";
  return (
    <div className="border-b border-[color:var(--border-soft)] last:border-b-0">
      <button
        type="button"
        data-tool-line={call.id}
        aria-expanded={open}
        className="flex w-full items-center gap-[8px] border-0 bg-transparent px-[14px] py-[9px] text-left text-[12px]"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="text-muted-foreground" data-tool-kind={kind}><Icon /></span>
        <span className="text-foreground">{call.name}</span>
        <span className={cn(
          "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap",
          call.state === "error" ? "text-[color:var(--destructive-fg)]" : "text-muted-foreground",
        )}>{summary}</span>
        <span className={cn("text-[11.5px]", TOOL_STATE_TONE[call.state] ?? "text-muted-foreground")}>{t(`sessions.tool.state.${call.state}`)}</span>
        <span className={MSG_TIME}>{formatDateTime(call.at)}</span>
      </button>
      {open ? (
        <div className="grid gap-[10px] px-[14px] pb-[12px]">
          {call.filePath === null ? null : (
            <div className="text-[12px] text-secondary-foreground [overflow-wrap:anywhere]">{call.filePath}</div>
          )}
          <div>
            <div className="mb-[5px] text-[11.5px] text-muted-foreground">{t("sessions.tool.arguments")}</div>
            <div className={CODE_BLOCK}>{cappedBlock(jsonBlock(call.args), t)}</div>
          </div>
          <div>
            <div className="mb-[5px] text-[11.5px] text-muted-foreground">{t("sessions.tool.result")}</div>
            <div className={CODE_BLOCK}>{cappedBlock(call.result === null ? "—" : call.result, t)}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export const ToolGroup = ({ node }: { node: Extract<StreamNode, { kind: "tools" }> }): ReactNode => {
  const t = useT();
  return (
    <div className="rounded-lg border border-[color:var(--border-soft)] bg-card">
      <div className="px-[14px] pt-[10px] text-[11.5px] text-muted-foreground">{t("sessions.tool.group")}</div>
      <div className="mt-[3px]">
        {node.calls.map((call) => <ToolCallLine key={call.id} call={call} />)}
      </div>
    </div>
  );
};

const TextNodeBody = ({ text }: { text: string }): ReactNode => {
  return <MarkdownClamp text={text} lines={TEXT_NODE_MAX_LINES} maxHeightClass="max-h-[300px]" />;
};

export const StreamNodeView = ({ node }: { node: StreamNode }): ReactNode => {
  const t = useT();
  if (node.kind === "tools") return <ToolGroup node={node} />;
  if (node.kind === "marker") {
    return node.variant === "error"
      ? <ErrorNotice message={node.text} />
      : <div className="text-[12px] text-muted-foreground">{t(RESUME_MARKER_TEXT)}</div>;
  }
  if (node.kind === "input") {
    return (
      <div className={MSG_CARD}>
        <div className={MSG_HEAD}>
          <span className="text-foreground">{t("sessions.stream.operator")}</span>
          <span className={MSG_TIME}>{formatDateTime(node.at)}</span>
        </div>
        <TextNodeBody text={node.text} />
      </div>
    );
  }
  return (
    <div className={MSG_CARD}>
      <div className={MSG_HEAD}>
        <span className="text-foreground">{t(node.final ? "sessions.stream.result" : "sessions.stream.agent")}</span>
        <span className={MSG_TIME}>{formatDateTime(node.at)}</span>
      </div>
      <TextNodeBody text={node.text} />
    </div>
  );
};

type DebugFilter = "all" | "provider" | "runner";

export const DebugEvents = ({ events }: { events: SessionEvent[] }): ReactNode => {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<DebugFilter>("all");
  const t = useT();
  // SessionEventSource is RUNNER | CLAUDE | CODEX | PI — "provider" means
  // "not RUNNER"; there is no literal provider value.
  const rows = events.filter((event) =>
    filter === "all" || (filter === "runner" ? event.source === "RUNNER" : event.source !== "RUNNER"));
  return (
    <Card
      title={<button type="button" className="flex items-center gap-[8px] border-0 bg-transparent p-0 text-[13.5px] [@media(max-width:900px)]:min-h-[44px]" onClick={() => setOpen(!open)}>
        <span className="text-muted-foreground"><IconChevron open={open} /></span>{t("sessions.debug.title")}
      </button>}
      extra={<span className={COUNT}>{events.length}</span>}
    >
      {open ? (
        <div className={STACK}>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[{ value: "all", label: t("sessions.debug.filter.all") }, { value: "provider", label: t("sessions.debug.filter.provider") }, { value: "runner", label: t("sessions.debug.filter.runner") }]}
          />
          {rows.length === 0 ? <EmptyState>{t("sessions.debug.empty")}</EmptyState> : (
            <div className={EVENT_LOG}>
              {rows.map((event) => (
                <div className={EVENT_ROW} key={event.id}>
                  <span className="text-[color:var(--faint)]">#{event.seq}</span>
                  <span className="overflow-hidden text-ellipsis text-primary">{event.type}</span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground" title={compact(event.payload, 2_000)}>{compact(event.payload)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
};

export const FilesTouched = ({ files, hint }: { files: Array<{ path: string; count: number }>; hint: string | null }): ReactNode => {
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <Card
      title={<button type="button" className="flex items-center gap-[8px] border-0 bg-transparent p-0 text-[13.5px] [@media(max-width:900px)]:min-h-[44px]" onClick={() => setOpen(!open)}>
        <span className="text-muted-foreground"><IconChevron open={open} /></span>{t("sessions.files.title")}
      </button>}
      extra={<span className={COUNT}>{files.length}</span>}
    >
      {open ? (
        <div className={STACK}>
          {hint === null ? null : <div className={HINT}>{hint}</div>}
          {files.length === 0 ? <EmptyState>{t("sessions.files.empty")}</EmptyState> : (
            <div className="[&>*+*]:mt-[6px]">
              {files.map((file) => (
                <div className={ROW} key={file.path}>
                  <span className="min-w-0 flex-1 text-[12px] text-secondary-foreground [overflow-wrap:anywhere]">{file.path}</span>
                  <span className={COUNT}>{file.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
};

export const SessionDetailPage = ({ sessionId }: { sessionId: string }): ReactNode => {
  // Plain POLL_MS for the whole life of the page, terminal or not: it is one
  // small request on a page the operator is actively looking at, and late
  // metadata (endedAt, terminationReason, the backfilled token columns) must
  // not sit stale. Only the event stream stops.
  const { data: session, error, reload } = usePoll<Session>(`/sessions/${sessionId}`, POLL_MS);
  const t = useT();
  const terminal = session ? !isLiveStatus(session.executionStatus) : false;
  const stream = useEventStream(session?.runId ?? null, terminal);

  // The list is unmounted by hash navigation, so the detail page is the one
  // place that can acknowledge an open. Including terminal in the dependency
  // list acknowledges the same Session again when it finishes while watched.
  useEffect(() => {
    if (session === null || session.id !== sessionId) return;
    markSessionOpened(session.projectId, session.id);
  }, [session?.id, session?.projectId, sessionId, terminal]);

  const scroller = useRef<HTMLDivElement | null>(null);
  const [unseen, setUnseen] = useState(0);
  const lastNodeRevisions = useRef(new Map<string, string>());
  /** The initial drain is history, not news, and it arrives over several pages.
   *  Without this the page opens claiming every event is new (seen in the
   *  browser against a real 771-event session: the stream rendered `98 new ↓`
   *  before the operator had done anything). */
  const primed = useRef(false);
  const drained = useRef(false);

  useEffect(() => {
    lastNodeRevisions.current = new Map();
    primed.current = false;
    drained.current = false;
    setUnseen(0);
  }, [sessionId]);

  // Keyed on the event count and the runner, not on array identity, so an empty
  // poll does not re-normalize 20 000 events.
  const runner = session?.runner ?? "CLAUDE";
  const { nodes, files, counts } = useMemo(
    () => projectStream(stream.events, runner, terminal),
    [stream.events.length, runner, terminal],
  );

  const scrollToBottom = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    setUnseen(0);
  }, []);

  useEffect(() => {
    const current = new Map(nodes.map((node) => [node.id, JSON.stringify(node)]));
    const added = [...current].reduce(
      (count, [id, revision]) => count + (lastNodeRevisions.current.get(id) === revision ? 0 : 1),
      0,
    );
    lastNodeRevisions.current = current;
    if (added <= 0) return;
    const node = scroller.current;
    if (!node) return;
    if (!primed.current) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= NEAR_BOTTOM_PX;
    if (atBottom) scrollToBottom();
    else setUnseen((current) => current + added);
  }, [nodes, scrollToBottom]);

  // The drain is over on the `loading` true → false *transition*, not on a bare
  // `loading === false`: the hook starts with `loading` false while `runId` is
  // still null, so testing the value alone primes before a single event has
  // arrived. Declared after the effect above so the last history page still
  // counts as history. A live session then jumps to the newest output; a
  // finished one stays at the beginning to be read.
  useEffect(() => {
    if (stream.loading) { drained.current = true; return; }
    if (!drained.current || primed.current) return;
    primed.current = true;
    if (!terminal) scrollToBottom();
  }, [stream.loading, terminal, scrollToBottom]);

  if (error !== null && session === null) {
    return <Page><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></Page>;
  }
  if (!session) return <Page><EmptyState>{t("common.loading")}</EmptyState></Page>;

  const lifecycle = lifecycleStat(session.executionStatus, session.mergeOutcome);
  const repoUrl = repoWebUrl(session.run?.repo?.remoteUrl);
  const branch = session.run?.branch ?? null;
  const plus = stream.capped ? "+" : "";
  const fileHint = fileTrackingHint(runner, files.length, counts.toolCalls);

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to="/sessions" className={BACK_LINK}><IconArrowLeft /></Link>
        {/* The heading already names the Agent, so the header's missing half is
            the runtime: the model and effort this run executed with, in the same
            grey model pill the Agent detail header carries. */}
        <h1 className={DETAIL_HEAD_H1}>{session.agent?.title ?? session.agentId}</h1>
        {session.run?.model === undefined ? null : <Pill tone="grey"><ModelLabel model={session.run.model} /></Pill>}
        <SessionStatusPill status={session.executionStatus} mergeOutcome={session.mergeOutcome} />
        <Pill tone="grey">{session.runner}</Pill>
        <span className="flex-1" />
        <Button type="button" variant="legacy" size="legacy" onClick={() => { reload(); stream.reload(); }}><IconRefresh />{t("common.refresh")}</Button>
      </div>

      <div className={STACK}>
        {session.failureReason === null ? null : <ErrorNotice message={session.failureReason} />}
        <WaitingNotice status={session.executionStatus} messageId={session.waitingOnMessageId} />

        <div className={STAT_PILLS}>
          <span className={STAT_PILL}>
            <span className={cn(DOT, DOT_TONE[lifecycle.tone])} />
            {lifecycle.label}
          </span>
          <span className={STAT_PILL}>{t("sessions.stat.messages", { n: `${counts.messages}${plus}` })}</span>
          <span className={STAT_PILL}>{t("sessions.stat.toolCalls", { n: `${counts.toolCalls}${plus}` })}</span>
          <span className={STAT_PILL}>{t("sessions.stat.files", { n: `${counts.files}${plus}` })}</span>
          {session.totalTokens === null ? null : <span className={STAT_PILL}>{t("sessions.stat.tokens", { n: compactTokens(session.totalTokens) })}</span>}
          {session.costUsd === null ? null : <span className={STAT_PILL}>{money(session.costUsd)}</span>}
        </div>

        <Card title={t("sessions.detail.title")}>
          <KeyValue columns={3} items={[
            { k: t("sessions.detail.task"), v: session.task ? <Link to={`/tasks/${session.task.id}`}>{session.task.name}</Link> : session.goal ? <Link to={`/goals/${session.goal.id}`}>{session.goal.title}</Link> : "—" },
            { k: t("sessions.detail.run"), v: session.run ? (session.task ? <Link to={`/tasks/${session.task.id}`}>#{session.run.runNumber}</Link> : `#${session.run.runNumber}`) : "—" },
            { k: t("sessions.detail.model"), v: session.run?.model ?? "—" },
            { k: t("sessions.detail.started"), v: formatDateTime(session.startedAt ?? session.requestedAt) },
            { k: t("sessions.detail.duration"), v: durationWithInboxWait(
              session.startedAt,
              session.endedAt,
              session.executionStatus === "WAITING_INBOX" || session.resumeAttempt > 0,
            ) },
            {
              k: t("sessions.detail.branch"),
              v: branch === null ? "—" : repoUrl === null
                ? branch
                : <a href={`${repoUrl}/tree/${branch}`} target="_blank" rel="noreferrer">{branch}</a>,
            },
            { k: t("sessions.detail.workspace"), v: <span className="text-[11.5px]">{session.run?.workspacePath ?? "—"}</span> },
            { k: t("sessions.detail.termination"), v: session.terminationReason ?? "—" },
            ...(session.resumeAttempt > 0 ? [{ k: t("sessions.detail.resumeAttempts"), v: `${session.resumeAttempt}` }] : []),
          ]} />
        </Card>

        <Card title={t("sessions.stream.title")} extra={<span className={COUNT}>{nodes.length}{plus}</span>}>
          <div className={STACK}>
            {stream.capped ? (
              <div className={HINT}>{t("sessions.stream.capped", { shown: stream.events.length, total: stream.total })}</div>
            ) : null}
            {stream.error === null ? null : <ErrorNotice message={`${stream.error.status} ${stream.error.message}`} onRetry={stream.reload} />}
            {nodes.length === 0 ? <EmptyState>{t(stream.loading ? "sessions.stream.loading" : "sessions.stream.empty")}</EmptyState> : (
              <div ref={scroller} className="max-h-[720px] overflow-auto [&>*+*]:mt-[12px]">
                {nodes.map((node) => <StreamNodeView key={`${node.kind}-${node.id}`} node={node} />)}
              </div>
            )}
            {unseen > 0 ? (
              <button type="button" className="self-start border-0 bg-transparent p-0 text-[12px] text-primary" onClick={scrollToBottom}>
                {t("sessions.stream.new", { n: unseen })}
              </button>
            ) : null}
          </div>
        </Card>

        <FilesTouched files={files} hint={fileHint} />
        <DebugEvents events={stream.events} />
      </div>
    </Page>
  );
};
