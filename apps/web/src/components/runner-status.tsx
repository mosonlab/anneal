import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { usePoll, type Poll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { timeAgo } from "../lib/format";
import type { Health, RunnersResponse } from "../lib/types";
import { cn } from "../lib/utils";
import { Link } from "../lib/router";
import { DOT, DOT_TONE, RUNNER_ROW, RUNNER_ROW_COMPACT, RUNNER_STATE } from "./ui";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";

type RunnersContextValue = { runners: Poll<RunnersResponse>; health: Poll<Health>; freshnessNow: number };
const idlePoll = <T,>(): Poll<T> => ({ data: null, error: null, loading: false, lastSuccessAt: null, reload: () => undefined });
const IDLE_CONTEXT: RunnersContextValue = { runners: idlePoll<RunnersResponse>(), health: idlePoll<Health>(), freshnessNow: 0 };
const RunnersContext = createContext<RunnersContextValue>(IDLE_CONTEXT);

/**
 * A clock that ticks exactly when a report stops being fresh.
 *
 * Freshness is a property of *now*, not of the last render, so anything that
 * decides on it needs a reason to re-render at the boundary. This ticks at
 * `checkedAt + 60,001 ms` and again whenever the tab becomes visible, which is
 * the case that matters: `usePoll` does not poll a hidden tab, so a report can
 * quietly age past its limit while nothing is asking.
 *
 * The tick re-arms itself against the deadline rather than firing once. A timer
 * is scheduled on the event loop's clock, which is not `Date.now()`, so it can
 * run a millisecond before the deadline it was given; a single-shot tick that
 * lands early reads the report as still fresh and leaves nothing behind to
 * correct it, which is the whole failure this clock exists to prevent. Re-arming
 * costs one extra timer in that case and stops as soon as the deadline is past.
 */
export const useFreshnessClock = (checkedAt: string | undefined): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const checkedAtMs = checkedAt === undefined ? Number.NaN : Date.parse(checkedAt);
    let timer = 0;
    const refresh = (): void => {
      setNow(Date.now());
      window.clearTimeout(timer);
      const remaining = Number.isFinite(checkedAtMs) ? checkedAtMs + 60_001 - Date.now() : 0;
      if (remaining > 0) timer = window.setTimeout(refresh, remaining);
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.clearTimeout(timer);
    };
  }, [checkedAt]);
  return now;
};

export const RunnersProvider = ({ children }: { children: ReactNode }): ReactNode => {
  const runners = usePoll<RunnersResponse>("/runners", 30_000);
  const health = usePoll<Health>("/health", 10_000);
  const freshnessNow = useFreshnessClock(runners.data?.checkedAt);
  return <RunnersContext.Provider value={{ runners, health, freshnessNow }}>{children}</RunnersContext.Provider>;
};

export const useRunners = (): RunnersContextValue => useContext(RunnersContext);

export type RunnerSummary = {
  state: "running" | "busy" | "offline" | "neverSeen" | "unknown";
  tone: "green" | "amber" | "grey";
};

export const runnerSummary = (payload: RunnersResponse | null, now: Date): RunnerSummary => {
  if (!payload || !Number.isFinite(Date.parse(payload.checkedAt)) || now.getTime() - Date.parse(payload.checkedAt) > 60_000) {
    return { state: "unknown", tone: "grey" };
  }
  if (payload.daemons.length === 0) return { state: "neverSeen", tone: "grey" };
  const online = payload.daemons.filter((daemon) => daemon.online);
  if (online.length === 0) return { state: "offline", tone: "grey" };
  // Amber is the shell's one readiness colour, and from plan Step 6 it means the
  // backend this preview requires. It used to mean "any backend's circuit is
  // open", which painted the whole application amber for the *target* v0.1
  // machine — Codex healthy, no Claude, no Pi — and told an operator that a
  // complete installation was in trouble. The optional backends' circuits are
  // still real and still reported in Settings; they are not this signal.
  const codex = payload.backends.find((backend) => backend.runner === "CODEX");
  const codexTrouble = codex?.circuitOpen === true || codex?.lastPreflightOk === false;
  return {
    state: online.some((daemon) => daemon.busy) ? "busy" : "running",
    tone: codexTrouble ? "amber" : "green",
  };
};

/**
 * The one backend v0.1 actually requires.
 *
 * Codex is the only readiness gate this preview has (plan Step 6): the starter
 * agent it installs runs on Codex, and Claude and Pi are optional backends whose
 * absence is not an installation failure. So this selector answers one question
 * — may an installation be completed and will a run have somewhere to go — and
 * it answers it about CODEX alone.
 *
 * The states are distinguished because the operator's next action differs.
 * "Missing" is a CLI that never answered `--version`, and the answer is to
 * install it; "unauthenticated" is a CLI that answered `--version` and then
 * failed `codex login status`, and the answer is `codex login`, which nothing
 * here automates. "Pending" is not a failure at all: nobody has reported yet, or
 * what was reported is too old to stand behind, and telling an operator to
 * reinstall a working CLI because a daemon has not heartbeated is worse than
 * telling them to wait.
 *
 * Freshness is measured on the *report*, not on the preflight: the daemon runs
 * its preflight once at startup, so an installation that has been up all day has
 * an old `lastPreflightAt` and a perfectly good Codex. What would make that
 * verdict wrong — an operator logging out — reaches the same record by another
 * route, because a run that fails authentication clears `lastPreflightOk` and
 * eventually opens the circuit.
 */
export type CodexReadiness = {
  state: "ready" | "missing" | "unauthenticated" | "blocked" | "pending";
  /** The CLI version the control plane recorded, when the record is one this
   *  selector understands. Never a message: what the backend reported about its
   *  own failure is the CLI's own output, and this type is rendered. */
  cliVersion: string | null;
};

/** A timestamp the browser can stand behind: present, parseable, and not from
 *  the future — a clock ahead of this one is a report this code cannot age. */
const asInstant = (value: string | null | undefined, now: Date): number | null => {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at - now.getTime() > 60_000) return null;
  return at;
};

export const codexReady = (payload: RunnersResponse | null, now: Date): CodexReadiness => {
  const pending: CodexReadiness = { state: "pending", cliVersion: null };
  if (!payload || !Array.isArray(payload.daemons) || !Array.isArray(payload.backends)) return pending;
  const checkedAt = asInstant(payload.checkedAt, now);
  if (checkedAt === null || now.getTime() - checkedAt > 60_000) return pending;
  // No daemon, or none online: the preflight record may say anything, but there
  // is nothing running to honour it.
  if (!payload.daemons.some((daemon) => daemon.online === true)) return pending;
  const codex = payload.backends.find((backend) => backend?.runner === "CODEX") ?? null;
  if (codex === null || asInstant(codex.lastPreflightAt, now) === null) return pending;
  if (codex.lastPreflightOk === false) {
    // The adapter reports the version it read before it checked the login, so a
    // version here means the binary answered and the authentication did not.
    return { state: typeof codex.cliVersion === "string" ? "unauthenticated" : "missing", cliVersion: codex.cliVersion ?? null };
  }
  // A passing preflight with an open circuit is a backend the control plane is
  // refusing to dispatch to, whatever the last check said.
  if (codex.circuitOpen === true) return { state: "blocked", cliVersion: codex.cliVersion ?? null };
  // Everything from here is the positive verdict, so it is stated as a complete
  // tuple rather than as the absence of a negative one. A record missing a
  // field, carrying the wrong type, or contradicting itself is a shape this
  // browser does not understand — possibly an older or newer control plane —
  // and the only safe reading of a shape you do not understand is that you do
  // not know yet.
  if (codex.lastPreflightOk !== true || codex.circuitOpen !== false || typeof codex.cliVersion !== "string") return pending;
  return { state: "ready", cliVersion: codex.cliVersion };
};

/**
 * A circuit reason, read as a class rather than as prose.
 *
 * The control plane writes this field from a fixed set — the runner's own
 * preflight classes and one string the API authors itself — precisely so that
 * no CLI's output ends up in telemetry. This browser does not have to trust
 * that: it matches the class and renders its own dictionary entry, so a daemon
 * from an older build that still posts raw stdout renders as "Circuit open" and
 * nothing else. Text nobody bounded is text this component will not print.
 */
const REASON_KEYS: Record<string, string> = {
  "cli-missing": "runner.reason.cliMissing",
  "not-authenticated": "runner.reason.notAuthenticated",
  "unsupported-model": "runner.reason.unsupportedModel",
  "Repeated authentication failures": "runner.reason.authFailures",
};

export const circuitReasonKey = (reason: string | null | undefined): string =>
  (typeof reason === "string" ? REASON_KEYS[reason.split(":")[0] ?? ""] : undefined) ?? "runner.circuitOpen";

const diskLabel = (bytes: number | null): string => bytes === null ? "—" : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const runnerDot = (tone: RunnerSummary["tone"]): string | undefined => tone === "green" ? DOT_TONE.on : tone === "amber" ? DOT_TONE.amber : undefined;

export const RunnerStateIndicator = ({ state, tone }: { state: RunnerSummary["state"]; tone: RunnerSummary["tone"] }): ReactNode => {
  const t = useT();
  return (
    <span data-runner-state={state} className="inline-flex items-center gap-[7px]">
      <span className={cn(DOT, runnerDot(tone))} />
      <span>{t(`runner.state.${state}`)}</span>
    </span>
  );
};

export const RunnerStatusDetails = ({ payload, healthProblem = false, runnersProblem = false }: {
  payload: RunnersResponse | null;
  healthProblem?: boolean;
  runnersProblem?: boolean;
}): ReactNode => {
  const t = useT();
  const daemons = [...(payload?.daemons ?? [])].sort((left, right) => left.runnerId.localeCompare(right.runnerId));
  const backends = [...(payload?.backends ?? [])].sort((left, right) => left.runner.localeCompare(right.runner));
  return (
    <div className="grid gap-[12px] text-[11.5px] leading-[1.45]">
      <div>
        <div className="text-[13px] font-bold text-foreground">{t("runner.title")}</div>
        <div className="mt-[2px] text-muted-foreground">{t("runner.onlineCount", { n: payload?.online ?? 0, m: payload?.total ?? 0 })}</div>
      </div>
      {healthProblem ? <div className="text-destructive">{t("runner.healthProblem")}</div> : null}
      {runnersProblem ? <div className="text-destructive">{t("runner.dataProblem")}</div> : null}
      {daemons.length === 0 ? <div className="text-muted-foreground">{t("runner.neverSeenDetail")}</div> : daemons.map((daemon) => (
        <div key={daemon.runnerId} className="grid gap-[3px] border-t border-border pt-[9px]">
          <div className="flex items-center gap-[7px] font-bold text-foreground">
            <span className="min-w-0 overflow-hidden text-ellipsis">{daemon.runnerId}</span>
            {daemon.busy ? <span className="rounded-md bg-accent px-[5px] py-[1px] text-[10px] font-normal">{t("runner.state.busy")}</span> : null}
          </div>
          <div>{t("runner.lastHeartbeat", { at: timeAgo(daemon.lastSeenAt) })}</div>
          <div>{t("runner.daemonVersion", { version: daemon.daemonVersion ?? "—" })}</div>
          <div className={cn(daemon.diskFreeBytes !== null && daemon.diskFreeBytes < 2 * 1024 ** 3 && "text-destructive")}>{t("runner.diskFree", { amount: diskLabel(daemon.diskFreeBytes) })}</div>
        </div>
      ))}
      <div className="grid gap-[3px] border-t border-border pt-[9px]">
        {backends.map((backend) => (
          <div key={backend.runner}>
            <div>{t("runner.cliVersion", { runner: t(`runner.cli.${backend.runner}`), version: backend.cliVersion ?? "—" })}</div>
            {backend.circuitOpen ? <div className="text-[color:var(--status-amber-fg)]">{t(circuitReasonKey(backend.circuitReason))}</div> : null}
          </div>
        ))}
      </div>
      <div className="border-t border-border pt-[9px] text-[color:var(--faint)]">{t("runner.refreshes")}</div>
    </div>
  );
};

/**
 * The readiness verdict, in the one place both readers of it can share.
 *
 * The wizard blocks on this and Settings reports it, and they must not describe
 * the same state in two vocabularies: an operator who reads "not signed in" on
 * one screen and "install the CLI" on the other has been told to do the wrong
 * thing on one of them.
 *
 * Every word here comes from the dictionary. Nothing the backend reported about
 * itself is rendered — a failed preflight's message is whatever the CLI printed
 * on the way down, and this component appears on the first screen a new operator
 * sees and in every screenshot they send.
 */
export const CodexReadinessNotice = ({ readiness }: { readiness: CodexReadiness }): ReactNode => {
  const t = useT();
  return (
    <div data-codex-state={readiness.state} className="grid gap-[4px]">
      <div className="flex items-center gap-[7px] font-bold">
        <span className={cn(DOT, readiness.state === "ready" ? DOT_TONE.on : readiness.state === "pending" ? undefined : DOT_TONE.amber)} />
        <span>{t(`codex.state.${readiness.state}`)}</span>
      </div>
      <div className="text-muted-foreground">{t(`codex.guidance.${readiness.state}`)}</div>
    </div>
  );
};

/**
 * The sidebar's runner row is a link to Settings with a hover preview, not a
 * hover-only button: hover is the one gesture a phone does not have, and a
 * button that opened nothing on click gave a touch operator a row they could
 * see and never act on. Settings carries the full daemon report, so the link is
 * the same information at a slower pace. `compact` is the phone top-bar form —
 * dot and state word only; `className` restyles the row for the phone sheet.
 */
export const RunnerRow = ({ compact = false, className, onNavigate }: {
  compact?: boolean;
  className?: string;
  onNavigate?: () => void;
}): ReactNode => {
  const { runners, health, freshnessNow } = useRunners();
  const t = useT();
  const summary = runners.error ? { state: "unknown", tone: "grey" } as const : runnerSummary(runners.data, new Date(freshnessNow));
  const state = t(`runner.state.${summary.state}`);
  const link = (
    <Link to="/settings" className={cn(compact ? RUNNER_ROW_COMPACT : RUNNER_ROW, className)} {...(compact ? { title: `${t("runner.row")}: ${state}` } : {})} {...(onNavigate === undefined ? {} : { onClick: onNavigate })}>
      <span className={cn(DOT, runnerDot(summary.tone))} />
      {compact ? null : t("runner.row")}
      <span className={cn(RUNNER_STATE, compact && "ml-0")}>{state}</span>
    </Link>
  );
  if (compact || className !== undefined) return link;
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>{link}</HoverCardTrigger>
      <HoverCardContent side="right" align="end" sideOffset={8} className="w-[290px] rounded-lg p-[14px] font-mono">
        <RunnerStatusDetails
          payload={runners.data}
          healthProblem={health.error !== null || (health.data !== null && health.data.status !== "ok")}
          runnersProblem={runners.error !== null}
        />
      </HoverCardContent>
    </HoverCard>
  );
};
