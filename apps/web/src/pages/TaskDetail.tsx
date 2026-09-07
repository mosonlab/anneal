import { type ReactNode, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { compactTokens, durationWithInboxWait, formatDateTime, percent, pullRequestLabel, repoWebUrl, sha, timeAgo, titleCase, usageCostLabel } from "../lib/format";
import { useAction, usePoll, type Poll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { Link } from "../lib/router";
import { fatal } from "../lib/poll-state";
import { isRegressionStep } from "../lib/repair-subtimeline";
import { sessionsFilterHref } from "../lib/session-list";
import { partitionTaskPrompt } from "../lib/task-prompt";
import type { Agent, Chain, ChainStep, Run, RunBaseline, TaskActivity, TaskDetail, TaskStartability, TaskStepOutput, TaskStatus } from "../lib/types";
import { supportsCodexServiceTier } from "../lib/models";
import { cn } from "../lib/utils";
import { IconArchive, IconArrowLeft, IconChevron, IconRefresh, IconSend } from "../components/icons";
import { ChainList, ReassignSelect } from "../components/chain-list";
import { RunLine } from "../components/run-line";
import { RunDiagnostics } from "../components/run-diagnostics";
import {
  BACK_LINK, COUNT, DETAIL_HEAD, DETAIL_HEAD_H1, MSG_CARD, MSG_HEAD, MSG_TIME, ROW, STACK,
  STAT_PILL, STAT_PILLS, TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  AgentChip, Card, EmptyState, ErrorNotice, KeyValue, Markdown, MarkdownClamp, Page, Pill, RunPill, TaskPill, Toggle,
} from "../components/ui";
import { retryShape, runLiveness } from "../lib/board";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

/** The raw event table used to live here. It now lives on the session page
 *  (`pages/Sessions.tsx`) so the product has exactly one of them; the run row
 *  links there instead (plan WI-8, open question A1). */

const ExternalLink = ({ href, children }: { href: string; children: ReactNode }): ReactNode => (
  <a href={href} target="_blank" rel="noreferrer">{children}</a>
);

/** `null` whenever the remote is not a GitHub repo we can address, which is the
 *  caller's signal to render plain text rather than a link that 404s. */
export const branchUrl = (remoteUrl: string | null | undefined, branch: string | null | undefined): string | null => {
  const base = repoWebUrl(remoteUrl);
  if (base === null || !branch) return null;
  return `${base}/tree/${branch}`;
};

const BranchCell = ({ remoteUrl, branch }: { remoteUrl: string | null | undefined; branch: string | null | undefined }): ReactNode => {
  if (!branch) return <>—</>;
  const href = branchUrl(remoteUrl, branch);
  // The row toggles on click; opening the branch must not also expand it.
  return href === null ? <>{branch}</> : (
    <a href={href} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{branch}</a>
  );
};

const SessionCell = ({ session }: { session: Run["session"] }): ReactNode => {
  const t = useT();
  if (!session) return <>—</>;
  // The row toggles on click; opening the session must not also expand it.
  return (
    <span onClick={(event) => event.stopPropagation()}>
      <Link to={`/sessions/${session.id}`}>{t("taskDetail.run.openSession")}</Link>
    </span>
  );
};

/** The operator's answer to "what is the run doing now?" The message remains
 * plain text even when it contains markdown-looking characters; agent text is
 * data, not an instruction to build another document here. */
export const NowBlock = ({ run }: { run: Run }): ReactNode => {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const message = run.session?.latestAgentMessage ?? null;
  const body = message?.body ?? t("taskDetail.now.noMessage");

  return (
    <div data-task-now="">
      <Card title={t("taskDetail.now.title")}>
        <div className="grid gap-[12px]">
          <RunLine run={run} mergeOutcome={run.mergeOutcome} elapsed="line" showModel />
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-[10px]">
            {message === null ? (
              <span className="min-w-0 [overflow-wrap:anywhere] text-secondary-foreground">{body}</span>
            ) : (
              <button
                type="button"
                aria-expanded={expanded}
                title={t(expanded ? "taskDetail.now.collapse" : "taskDetail.now.expand")}
                className={cn(
                  "min-w-0 border-0 bg-transparent p-0 text-left text-secondary-foreground hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-[color:var(--ring)]",
                  expanded ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere]",
                )}
                onClick={() => setExpanded((current) => !current)}
              >
                {body}
              </button>
            )}
            {message === null ? null : <span className="ml-auto whitespace-nowrap text-right text-[11.5px] text-muted-foreground">{timeAgo(message.at)}</span>}
          </div>
          {run.session === null || run.session === undefined ? null : (
            <Link to={`/sessions/${run.session.id}`}>{t("taskDetail.run.openSession")}</Link>
          )}
        </div>
      </Card>
    </div>
  );
};

/** Hidden once it has nothing left to say: every item satisfied on a task that
 *  has already run is a card of green ticks nobody reads. A task with no run
 *  keeps it, because that is when startability is still a question. */
export const StartabilityChecklist = ({ verdict, hasRuns }: { verdict: TaskStartability; hasRuns: boolean }): ReactNode => {
  const t = useT();
  const items = [
    ["repoBound", "taskDetail.startability.repoBound"],
    ["agentAssignee", "taskDetail.startability.agentAssignee"],
    ["repoAccessGrant", "taskDetail.startability.repoAccessGrant"],
    ["budgetRemaining", "taskDetail.startability.budgetRemaining"],
    ["noActiveRun", "taskDetail.startability.noActiveRun"],
    ["predecessorsDone", "taskDetail.startability.predecessorsDone"],
  ] as const;
  if (hasRuns && items.every(([key]) => verdict.checklist[key])) return null;
  return (
    <div className="mt-[16px] border-t border-[color:var(--border-soft)] pt-[14px]">
      <div className="mb-[9px] text-[12px] font-bold text-foreground">{t("taskDetail.startability.title")}</div>
      <ul className="grid gap-[7px] sm:grid-cols-2">
        {items.map(([key, label]) => (
          <li key={key} className="flex items-center justify-between gap-[12px] text-[11.5px]">
            <span>{t(label)}</span>
            <span className={verdict.checklist[key] ? "text-[color:var(--status-green-fg)]" : "text-[color:var(--destructive-fg)]"}>
              {t(verdict.checklist[key] ? "taskDetail.startability.satisfied" : "taskDetail.startability.missing")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};


export const RunRow = ({ run, remoteUrl, baseline, expanded, onToggle }: { run: Run; remoteUrl: string | null | undefined; baseline: RunBaseline | null | undefined; expanded: boolean; onToggle: () => void }): ReactNode => {
  const t = useT();
  const tierApplies = supportsCodexServiceTier(run.runner, run.model);
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className={TABLE_TIGHT}><span className="text-muted-foreground"><IconChevron open={expanded} /></span></TableCell>
        <TableCell className={TABLE_NAME}>#{run.runNumber}<span className={TABLE_SUB}>{run.runner.toLowerCase()} · {run.model}{tierApplies ? ` · ${t(`serviceTier.${run.codexServiceTier}`)}` : ""}</span></TableCell>
        <TableCell><RunPill status={run.status} mergeOutcome={run.mergeOutcome} /></TableCell>
        <TableCell><SessionCell session={run.session} /></TableCell>
        <TableCell>{formatDateTime(run.startedAt ?? run.queuedAt)}</TableCell>
        <TableCell>{durationWithInboxWait(
          run.startedAt,
          run.endedAt,
          run.session?.executionStatus === "WAITING_INBOX" || (run.session?.resumeAttempt ?? 0) > 0,
        )}</TableCell>
        {/* No size class: this cell carried `.small` before the batch, but
            `.table td { font-size: 12.5px }` outranks `.small` on specificity, so
            11.5px never reached it. The four `.small` spans that survive as
            `text-[11.5px]` all sit in KeyValue lists, outside any table. */}
        <TableCell>{sha(run.baseSha)} → {sha(run.headSha)}</TableCell>
        <TableCell>{usageCostLabel(run.session?.usageCost)}</TableCell>
        <TableCell>{compactTokens(run.session?.totalTokens ?? null)}</TableCell>
        <TableCell>{run.failureClass === null ? "—" : <Pill tone="red">{t(`status.failure.${run.failureClass}`)}</Pill>}</TableCell>
        {/* Last: the widest cell in the row, and the one an operator reads least
            often. Anything after it pushes the columns that matter off-screen. */}
        <TableCell><BranchCell remoteUrl={remoteUrl} branch={run.branch ?? run.targetBranch} /></TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={11} className="bg-[color:var(--surface-run-detail)]">
            <div className={STACK}>
              <KeyValue columns={3} items={[
                { k: t("taskDetail.run.id"), v: <span className="text-[11.5px]">{run.id}</span> },
                { k: t("taskDetail.run.runnerInstance"), v: run.runnerId ?? "—" },
                { k: t("taskDetail.run.serviceTier"), v: tierApplies
                  ? <Pill tone={run.codexServiceTier === "FAST" ? "green" : "grey"}>{t(`serviceTier.${run.codexServiceTier}`)}</Pill>
                  : "—" },
                { k: t("taskDetail.run.nativeSubagents"), v: run.subagentModel && run.subagentMaxConcurrent
                  ? `${run.subagentModel} · max ${run.subagentMaxConcurrent}`
                  : "—" },
                { k: t("taskDetail.run.leaseGeneration"), v: `${run.leaseGeneration}` },
                { k: t("taskDetail.run.workspace"), v: <span className="text-[11.5px]">{run.workspacePath ?? "—"}{run.workspaceRetained ? ` ${t("taskDetail.run.retained")}` : ""}</span> },
                { k: t("taskDetail.run.budget"), v: t("taskDetail.run.budgetValue", { wall: run.maxDurationMin, stall: run.stallTimeoutMin, runs: run.maxRunsPerTask }) },
                // `pushStatus` is an open string on the wire, not a closed union, so
                // it stays a technical identifier (spec §4.3.7's carve-out).
                { k: t("taskDetail.run.push"), v: run.pushStatus.toLowerCase().replace(/_/g, " ") },
                // The task Details card sources its anchor from the newest run
                // alone, so without this entry an earlier run's PR — a retry, a
                // review run, a run that failed after pushing — is reachable from
                // nowhere. Distinct from `Push`, which is the status and not a link.
                { k: t("taskDetail.run.pullRequest"), v: run.pullRequestUrl === null ? "—"
                  : <ExternalLink href={run.pullRequestUrl}>{pullRequestLabel(run.pullRequestUrl)}</ExternalLink> },
                { k: t("taskDetail.run.sessionStatus"), v: run.session ? t(`status.session.${run.session.executionStatus}`) : "—" },
                { k: t("taskDetail.run.resumeAttempts"), v: `${run.session?.resumeAttempt ?? 0}` },
                // Termination moved into the diagnostics block below, which
                // states it alongside the exit code and signal it belongs with.
              ]} />
              <RunDiagnostics metrics={run.metrics} baseline={baseline} costUsd={run.session?.costUsd} runTerminationReason={run.terminationReason} />
              {run.failureReason === null ? null : <ErrorNotice message={run.failureReason} />}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
};

export const Activity = ({ taskId, poll }: { taskId: string; poll: Poll<TaskActivity[]> }): ReactNode => {
  const { data, error: pollError, loading, reload } = poll;
  const [comment, setComment] = useState("");
  const { pending, error, run } = useAction();
  const t = useT();
  const items = data ?? [];

  const send = async (): Promise<void> => {
    if (comment.trim().length === 0) return;
    const ok = await run(() => api.post(`/tasks/${taskId}/activity`, { actorType: "operator", body: comment }));
    if (ok) { setComment(""); reload(); }
  };

  return (
    <Card title={t("taskDetail.activity.title")} extra={<span className={COUNT}>{items.length}</span>}>
      <div className={STACK}>
        {loading && data === null ? <EmptyState>{t("taskDetail.activity.loading")}</EmptyState>
          : pollError && data === null ? <ErrorNotice message={pollError.message} onRetry={reload} />
            : items.length === 0 ? <EmptyState>{t("taskDetail.activity.empty")}</EmptyState> : (
          <div className="[&>*+*]:mt-[12px]">
            {items.map((item) => (
              <div className={MSG_CARD} key={item.id}>
                <div className={MSG_HEAD}>
                  <span className="text-foreground">{titleCase(item.actorType)}</span>
                  {item.actorId === null ? null : <span className="text-[11.5px] text-[color:var(--faint)]">{item.actorId}</span>}
                  <span className={MSG_TIME}>{formatDateTime(item.createdAt)}</span>
                </div>
                <Markdown text={item.body} />
              </div>
            ))}
          </div>
        )}
        {pollError === null || data === null ? null : <ErrorNotice message={pollError.message} onRetry={reload} />}
        {error === null ? null : <ErrorNotice message={error} />}
        <div className={ROW}>
          <Input type="text" value={comment} placeholder={t("taskDetail.activity.placeholder")} onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void send(); }} />
          <Button type="button" variant="legacy" size="legacy" disabled={pending || comment.trim().length === 0} onClick={() => void send()}>
            <IconSend />{t("taskDetail.activity.send")}
          </Button>
        </div>
      </div>
    </Card>
  );
};

/** The step output is markdown, so it cannot use `ShowMore`'s line clamp — that
 *  clamp needs a single text node. A height clamp plus the same control does the
 *  same job over rendered blocks. Whitespace-only bodies get the Prompt card's
 *  empty state rather than an empty box (spec §6). */
export const StepOutput = ({ output }: { output: TaskStepOutput }): ReactNode => {
  const t = useT();
  const empty = output.body.trim().length === 0;
  return (
    <Card title={t("taskDetail.output.title")} extra={<Pill tone="grey">{output.kind}</Pill>}>
      {empty ? <EmptyState>{t("taskDetail.output.empty")}</EmptyState> : (
        <MarkdownClamp text={output.body} lines={10} maxHeightClass="max-h-[420px]" />
      )}
      <div className="mt-2.5">{t("taskDetail.output.updated", { at: timeAgo(output.updatedAt) })}</div>
    </Card>
  );
};

export const TaskOutput = ({ poll }: { poll: ReturnType<typeof usePoll<TaskStepOutput>> }): ReactNode => {
  const t = useT();
  // A 404 is authoritative absence for this resource, even after a prior 200.
  // Keep last-good data for transient failures and version-skew responses such
  // as 405/501, but never let a deleted output remain visible as truth.
  if (poll.error?.status === 404) {
    return <Card title={t("taskDetail.output.title")}><EmptyState>{t("taskDetail.output.empty")}</EmptyState></Card>;
  }
  if (poll.data) {
    return <><StepOutput output={poll.data} />{poll.error ? <ErrorNotice message={poll.error.message} onRetry={poll.reload} /> : null}</>;
  }
  return (
    <Card title={t("taskDetail.output.title")}>
      {poll.loading ? <EmptyState>{t("taskDetail.output.loading")}</EmptyState>
        : poll.error ? <ErrorNotice message={poll.error.message} onRetry={poll.reload} />
            : <EmptyState>{t("taskDetail.output.empty")}</EmptyState>}
    </Card>
  );
};

/**
 * The prompt, read-only until an operator asks to edit it.
 *
 * Read-only is the default because this text is what the next run executes and
 * it is long: an always-live textarea is a mis-click away from rewriting the
 * work, and it would bury the rest of the page.
 *
 * `editableBrief` is the operator's half — a template Step's brief, or an
 * ordinary task's whole description — and `null` means the platform authored
 * all of it and there is nothing here to edit. The server decides which,
 * because the patch that receives the text decides the same way.
 */
export const TaskPrompt = ({ description, editableBrief, pending, onSave }: {
  description: string;
  editableBrief: string | null;
  pending: boolean;
  onSave: (brief: string) => void;
}): ReactNode => {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const parts = partitionTaskPrompt(description);
  const editing = draft !== null;
  return (
    <Card
      title={t("taskDetail.prompt.title")}
      extra={editableBrief === null || editing ? null : (
        <Button type="button" variant="legacy" size="legacySmall" disabled={pending}
          onClick={() => setDraft(editableBrief)}>{t("taskDetail.prompt.edit")}</Button>
      )}
    >
      <div className={STACK}>
        {editing ? (
          <>
            <Textarea rows={14} value={draft} disabled={pending} aria-label={t("taskDetail.prompt.edit")}
              onChange={(event) => setDraft(event.target.value)} />
            <p className="text-[11.5px] text-muted-foreground">
              {t(description === editableBrief ? "taskDetail.prompt.editWhole" : "taskDetail.prompt.editBrief")}
            </p>
            <div className={ROW}>
              <Button type="button" variant="legacy" size="legacy" disabled={pending || draft === editableBrief}
                onClick={() => { onSave(draft); setDraft(null); }}>{t("common.save")}</Button>
              <Button type="button" variant="legacy" size="legacy" disabled={pending}
                onClick={() => setDraft(null)}>{t("common.cancel")}</Button>
            </div>
          </>
        ) : (
          <>
            {parts.responsibility.length === 0
              ? <EmptyState>{t("taskDetail.prompt.empty")}</EmptyState>
              : <Markdown text={parts.responsibility} />}
            {parts.productContract === null ? null : (
              <details>
                <summary className="cursor-pointer text-muted-foreground">{t("taskDetail.prompt.productContract")}</summary>
                <div className="mt-2.5"><Markdown text={parts.productContract} /></div>
              </details>
            )}
            <p className="text-[11.5px] text-muted-foreground">{t("taskDetail.prompt.effective")}</p>
          </>
        )}
      </div>
    </Card>
  );
};

/**
 * The task's configured run budget, editable in place.
 *
 * This is the operator's only way past an exhausted budget, so it sits in the
 * always-visible half of the details card rather than behind the configuration
 * toggle. The count beside it is attempts already spent; the grants a run
 * carries are not added in here, because only the server reads those — the
 * retry control's own state is what reports the effective ceiling.
 */
const RunBudgetField = ({ used, limit, pending, onCommit }: {
  used: number;
  limit: number;
  pending: boolean;
  onCommit: (limit: number) => void;
}): ReactNode => {
  const t = useT();
  const [draft, setDraft] = useState(String(limit));
  useEffect(() => { setDraft(String(limit)); }, [limit]);
  // Out-of-range text snaps back to the value in force rather than travelling to
  // a route that would reject it; `taskFields.maxSessionsPerTask` owns 1..100.
  const commit = (): void => {
    const next = Number(draft);
    if (!Number.isInteger(next) || next < 1 || next > 100) setDraft(String(limit));
    else if (next !== limit) onCommit(next);
  };
  return (
    <span className={ROW}>
      <Input type="number" min={1} max={100} className="w-[76px]" value={draft} disabled={pending}
        aria-label={t("taskDetail.details.runBudget")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      <span className="text-[11.5px] text-muted-foreground">{t("taskDetail.details.runBudgetUsed", { n: used })}</span>
    </span>
  );
};

/** A salvage ref remains useful to an operator even though the replacement
 * Run was already started from its old base. The projection sends an empty
 * list for ordinary Tasks, so the surface disappears entirely in that case. */
export type StrandedSalvageBranch = { branch: string; lostRunNumber: number };

export const StrandedSalvageList = ({
  branches,
  remoteUrl,
}: {
  branches: StrandedSalvageBranch[];
  remoteUrl: string | null | undefined;
}): ReactNode => {
  const t = useT();
  if (branches.length === 0) return null;
  return (
    <Card title={t("taskDetail.salvage.title")} extra={<span className={COUNT}>{branches.length}</span>}>
      <div data-task-stranded-salvage="" className="grid gap-[10px]">
        {branches.map(({ branch, lostRunNumber }) => {
          const href = branchUrl(remoteUrl, branch);
          return (
            <div key={`${branch}-${lostRunNumber}`} className="flex min-w-0 flex-wrap items-baseline gap-x-[10px] gap-y-[3px]">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {href === null ? branch : <ExternalLink href={href}>{branch}</ExternalLink>}
              </span>
              <span className="text-[11.5px] text-muted-foreground">{t("taskDetail.salvage.lostRun", { n: lostRunNumber })}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

const TaskDetailResource = ({ taskId }: { taskId: string }): ReactNode => {
  const { data: task, error, reload } = usePoll<TaskDetail>(`/tasks/${taskId}`);
  const output = usePoll<TaskStepOutput>(`/tasks/${taskId}/output`, 10_000);
  const startability = usePoll<TaskStartability>(`/tasks/${taskId}/startability`);
  const activity = usePoll<TaskActivity[]>(`/tasks/${taskId}/activity`);
  // No new cadence: the chain rides the page's default poll.
  const chain = usePoll<Chain>(`/tasks/${taskId}/chain`);
  // Repair markers are already exposed by the existing activity read. Poll the
  // Regression task only after the chain identifies it; a chain without a
  // Regression node remains completely idle on this auxiliary path.
  const regressionTaskId = chain.data?.steps.find(isRegressionStep)?.taskId ?? null;
  const auxiliaryRepairActivities = usePoll<TaskActivity[]>(
    regressionTaskId === null || regressionTaskId === taskId ? null : `/tasks/${regressionTaskId}/activity`,
  );
  const repairActivities = regressionTaskId === taskId ? activity : auxiliaryRepairActivities;
  // Staffing choices change on the Agents page, not here, so this rides the
  // slowest cadence on the page: it exists to fill one picker.
  const agents = usePoll<Agent[]>(task === null ? null : `/projects/${task.projectId}/agents`, 30_000);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Deliberately not persisted: the collapsed default is the point.
  const [configurationShown, setConfigurationShown] = useState(false);
  const chainControlInFlight = useRef(false);
  const { pending, error: actionError, run } = useAction();
  const t = useT();

  // `usePoll` keeps the last good data on error, which is right for a blip and
  // wrong for a deletion — `fatal` is what makes a 404 authoritative. The chain
  // poll deliberately has no error branch of its own: its 404 can also mean
  // "this task never had a chain", and it must not paper over a live task.
  if (fatal(error, task)) {
    return <Page><ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} /></Page>;
  }
  if (!task) return <Page data-task-id={taskId}><EmptyState>{t("common.loading")}</EmptyState></Page>;

  const patch = (body: Record<string, unknown>): void => {
    void run(async () => { await api.patch(`/tasks/${taskId}`, body); reload(); });
  };
  const moveStatus = (status: TaskStatus): void => {
    void run(async () => {
      const target = task.moveTargets.find((candidate) => candidate.status === status);
      if (!target) throw new Error(`Task ${task.id} does not expose ${status} as an operator move target`);
      if (target.via === "start") await api.post(`/tasks/${taskId}/start`, {});
      else await api.patch(`/tasks/${taskId}`, { status });
      reload();
      startability.reload();
    });
  };
  const retry = (): void => {
    void run(async () => { await api.post(`/tasks/${taskId}/retry`, {}); reload(); });
  };
  const cancelCurrentRun = (parkTask: boolean): void => {
    if (!newest) return;
    const reason = window.prompt(t(parkTask ? "taskDetail.stop.prompt" : "taskDetail.cancel.prompt"));
    if (!reason?.trim()) return;
    void run(async () => {
      await api.post(`/runs/${newest.id}/cancel`, {
        requestId: crypto.randomUUID(),
        reason: reason.trim(),
        parkTask,
      });
      reload();
    });
  };
  const startStep = (step: ChainStep): void => {
    void run(async () => { await api.post(`/tasks/${step.taskId}/start`, {}); reload(); chain.reload(); });
  };
  const toggleGate = (gateTaskId: string, next: boolean): void => {
    void run(async () => {
      await api.patch(`/tasks/${gateTaskId}`, { approvalGate: next });
      reload();
      chain.reload();
    });
  };
  const controlChain = (): void => {
    const current = chain.data;
    if (current === null || current === undefined || current.chainId === null || chainControlInFlight.current) return;
    const held = current.control?.state === "held";
    chainControlInFlight.current = true;
    void run(async () => {
      try {
        await api.post(`/tasks/${taskId}/chain/${held ? "resume" : "hold"}`, { requestId: crypto.randomUUID() });
        chain.reload();
      } finally {
        chainControlInFlight.current = false;
      }
    });
  };
  /** Restaffing, for this Task or for any Step of its Chain. The route is the
   *  authority: it answers 409 while a Run is live, and that refusal reaches the
   *  operator through the page's existing action-error notice. */
  const reassign = (targetTaskId: string, assigneeAgentId: string): Promise<boolean> => run(async () => {
    await api.patch(`/tasks/${targetTaskId}`, { assigneeAgentId });
    reload();
    chain.reload();
    startability.reload();
  });
  const setArchived = (archived: boolean): void => {
    void run(async () => {
      await api.post(`/tasks/${taskId}/${archived ? "archive" : "unarchive"}`, {});
      reload();
      chain.reload();
    });
  };
  const runs = task.runs;
  // `—`, never `0`: a task whose sessions all predate the usage columns has an
  // unknown token count, not a zero one (spec §4.6.5).
  const counted = runs.map((item) => item.session?.totalTokens).filter((value): value is number => typeof value === "number");
  const totalTokens = counted.length === 0 ? null : counted.reduce((sum, value) => sum + value, 0);
  // `app.ts` orders runs `runNumber desc`, so the newest run is the head.
  const newest = runs[0];
  const retryState = retryShape(task, newest);
  const newestIsActive = task.executionOwner === "agent" && newest !== undefined
    && runLiveness(newest).live;
  const newestIsCancelling = newestIsActive && newest.cancelRequestedAt !== null && newest.cancelAcknowledgedAt === null;
  const newestBranch = newest?.branch ?? newest?.targetBranch ?? null;
  const newestBranchUrl = branchUrl(task.repo?.remoteUrl, newestBranch);
  const newestCacheHit = percent(newest?.metrics?.tokens.cacheHitRatio);
  const pullRequestUrl = newest?.pullRequestUrl ?? null;
  const strandedSalvageBranches = task.strandedSalvageBranches;
  // `ChainStep.reassignable` is the server's own answer, so a Task inside a
  // Chain reads it rather than recomputing it. A Task outside one has no Step to
  // read, and the projection carries no equivalent field, so the page derives
  // the same rule from the runs it already holds: `runLiveness` is the console's
  // copy of `ACTIVE_RUN_STATUSES` (packages/db/src/chain-activation.ts), applied
  // across every run rather than the newest, which is how the server counts.
  const chainStep = chain.data?.steps.find((step) => step.taskId === taskId) ?? null;
  const reassignable = chainStep?.reassignable ?? !runs.some((item) => runLiveness(item).live);
  const executionOwner = task.executionOwner === "agent"
    ? task.assigneeAgent
      ? <Link to={`/agents/${task.assigneeAgent.id}`}><AgentChip agent={task.assigneeAgent} /></Link>
      : t("executionOwner.unassigned")
    : t(`executionOwner.${task.executionOwner}`);

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to="/tasks" className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{task.name}</h1>
        <TaskPill status={task.status} />
        {task.mergeRecovery === null || task.mergeRecovery === undefined ? null : (
          <Pill tone={task.mergeRecovery.phase === "actual-failure" || task.mergeRecovery.phase === "downstream-stop"
            ? "red"
            : task.mergeRecovery.phase === "succeeded" ? "green" : "amber"}>
            {t(`taskDetail.recovery.${task.mergeRecovery.phase}`, { n: task.mergeRecovery.attempt })}
          </Pill>
        )}
        {task.templateId === null ? null : <Pill tone="violet">{t("tasks.pill.template")}</Pill>}
        {task.archivedAt === null ? null : <Pill tone="grey">{t("chain.archived")}</Pill>}
        <span className="flex-1" />
        {/* `disabled:opacity-100 disabled:cursor-default`: the retired sheet had no
            `select:disabled` rule at all, so this control rendered at full opacity
            with the UA cursor while a patch was in flight. The primitive dims to
            50% and shows `not-allowed` (ui/select.tsx:21). */}
        {task.moveTargets.length > 0 ? (
          <Select className="w-[130px] disabled:opacity-100 disabled:cursor-default" value={task.status} disabled={pending} onChange={(event) => moveStatus(event.target.value as TaskStatus)}>
            <option value={task.status}>{t(`status.task.${task.status}`)}</option>
            {task.moveTargets.map(({ status }) => <option key={status} value={status}>{t(`status.task.${status}`)}</option>)}
          </Select>
        ) : task.chainId === null ? null : <span className="text-[11.5px] text-muted-foreground">{t("taskDetail.chainStatusReadonly")}</span>}
        {retryState === "available" ? (
          <Button type="button" variant="legacy" size="legacy" disabled={pending} onClick={retry}><IconRefresh />{t("common.retry")}</Button>
        ) : retryState === "budget-exhausted" ? (
          // Shown disabled rather than hidden: the budget field below lifts this
          // exact refusal, and a control that vanishes never says where to go.
          <Button type="button" variant="legacy" size="legacy" disabled title={t("taskDetail.retry.budgetExhausted")}>
            <IconRefresh />{t("common.retry")}
          </Button>
        ) : null}
        {newestIsActive ? (
          <Button type="button" variant="legacy" size="legacy" disabled={pending || newestIsCancelling} onClick={() => cancelCurrentRun(false)}>
            {t(newestIsCancelling ? "taskDetail.cancel.cancelling" : "taskDetail.cancel.action")}
          </Button>
        ) : null}
        {newestIsActive ? (
          <Button type="button" variant="legacy" size="legacy" disabled={pending || newestIsCancelling} onClick={() => cancelCurrentRun(true)}>
            {t("taskDetail.stop.action")}
          </Button>
        ) : null}
        <Button type="button" variant="legacy" size="legacy" disabled={pending} onClick={() => setArchived(task.archivedAt === null)}>
          <IconArchive />{t(task.archivedAt === null
            ? task.chainId === null ? "tasks.menu.archive" : "tasks.aggregate.menu.archive"
            : task.chainId === null ? "archived.menu.unarchive" : "archived.menu.unarchiveChain")}
        </Button>
        <Button type="button" variant="legacy" size="legacy" onClick={reload}><IconRefresh />{t("common.refresh")}</Button>
      </div>

      <div className={STACK}>
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        {error === null ? null : <ErrorNotice message={error.message} onRetry={reload} />}
        {task.failureReason === null ? null : (
          <ErrorNotice message={
            <span className={ROW}>
              <span>{task.failureReason}</span>
              <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" disabled={pending}
                onClick={() => patch({ failureReason: null })}>{t("taskDetail.failureReason.clear")}</Button>
            </span>
          } />
        )}

        <div className={STAT_PILLS}>
          <span className={STAT_PILL}>{t("taskDetail.stats.runs", { n: runs.length })}</span>
          <span className={STAT_PILL}>{t("taskDetail.stats.spend", { amount: usageCostLabel(task.taskCost) })}</span>
          {/* The cache hit is the newest run's, not the task's: the ratios of
              runs with different context sizes do not average into a number
              that means anything. Unknown drops the clause rather than
              claiming 0%. */}
          <span className={STAT_PILL}>{newestCacheHit === null
            ? t("taskDetail.stats.tokens", { n: compactTokens(totalTokens) })
            : t("taskDetail.stats.tokensWithCacheHit", { n: compactTokens(totalTokens), ratio: newestCacheHit })}</span>
          <span className={STAT_PILL}>{t("taskDetail.stats.wallClock", { n: task.maxDurationMin })}</span>
          <span className={STAT_PILL}>{t("taskDetail.stats.stall", { n: task.stallTimeoutMin })}</span>
          <span className={STAT_PILL}>{t("taskDetail.stats.maxRuns", { n: task.maxSessionsPerTask })}</span>
        </div>

        {newest === undefined ? null : <NowBlock run={newest} />}

        <Card title={t("taskDetail.details.title")}>
          {/* Only these move while a task runs. Everything else was fixed at
              creation and sits behind the toggle below. The run budget is here
              rather than behind that toggle because it is what an operator
              reaches for when a task has stopped being able to retry. */}
          <KeyValue items={[
            { k: t("taskDetail.details.executionOwner"), v: executionOwner },
            // Only an agent-owned Task has an assignee to change: a human Task's
            // owner is a person, and the merge tail's Tasks are bound to the
            // mechanical sentinel the route refuses to reassign anyway.
            ...(task.executionOwner === "agent" ? [{
              k: t("taskDetail.reassign.label"),
              v: (
                <ReassignSelect
                  agents={agents.data ?? []}
                  current={task.assigneeAgent}
                  reassignable={reassignable}
                  pending={pending}
                  label={t("taskDetail.reassign.label")}
                  lockedHint={t("taskDetail.reassign.locked")}
                  onReassign={(assigneeAgentId) => reassign(taskId, assigneeAgentId)}
                />
              ),
            }] : []),
            {
              k: t("taskDetail.details.branch"),
              v: newestBranch === null ? "—"
                : newestBranchUrl === null ? newestBranch
                  : <ExternalLink href={newestBranchUrl}>{newestBranch}</ExternalLink>,
            },
            {
              k: t("taskDetail.details.pullRequest"),
              v: pullRequestUrl === null ? "—"
                : <ExternalLink href={pullRequestUrl}>{pullRequestLabel(pullRequestUrl)}</ExternalLink>,
            },
            {
              k: t("taskDetail.details.runBudget"),
              v: <RunBudgetField used={runs.length} limit={task.maxSessionsPerTask} pending={pending}
                onCommit={(maxSessionsPerTask) => patch({ maxSessionsPerTask })} />,
            },
          ]} />
          {configurationShown ? (
            <div className="mt-[16px]">
              <KeyValue items={[
                { k: t("taskDetail.details.repo"), v: task.repo ? `${task.repo.name} · ${task.repo.remoteUrl}` : "—" },
                { k: t("taskDetail.details.targetBranch"), v: task.targetBranch ?? task.repo?.defaultBranch ?? "—" },
                { k: t("taskDetail.details.schedule"), v: t(`taskDetail.details.scheduleKind.${task.scheduleKind}`) },
                { k: t("taskDetail.details.workingDirectory"), v: task.workingDirectory ?? "—" },
                {
                  k: t("taskDetail.details.approval"),
                  v: task.chainId === null ? (
                    <span className={ROW}>
                      <Toggle on={task.approvalGate} onChange={(next) => patch({ approvalGate: next })} label={t("taskDetail.details.approval")} />
                      <span className="text-[11.5px] text-muted-foreground">{t(task.approvalGate ? "taskDetail.details.approvalOn" : "taskDetail.details.approvalOff")}</span>
                    </span>
                  ) : t(task.approvalGate ? "taskDetail.details.approvalOn" : "taskDetail.details.approvalOff"),
                },
                { k: t("taskDetail.details.created"), v: formatDateTime(task.createdAt) },
              ]} />
            </div>
          ) : null}
          <div className="mt-[16px]">
            <Button type="button" variant="legacy" size="legacy" aria-expanded={configurationShown}
              onClick={() => setConfigurationShown(!configurationShown)}>
              {t(configurationShown ? "taskDetail.details.hideConfiguration" : "taskDetail.details.showConfiguration")}
            </Button>
          </div>
          {startability.data
            ? <StartabilityChecklist verdict={startability.data} hasRuns={runs.length > 0} />
            : startability.error
              ? <ErrorNotice message={startability.error.message} onRetry={startability.reload} />
              : <EmptyState>{t("common.loading")}</EmptyState>}
        </Card>

        <StrandedSalvageList branches={strandedSalvageBranches} remoteUrl={task.repo?.remoteUrl} />

        <Card
          title={t("taskDetail.runs.title")}
          extra={
            <span className={ROW}>
              <span className={COUNT}>{runs.length}</span>
              {/* The chain, when there is one: a step's runs are rarely the
                  whole story, and the sibling steps' sessions are what an
                  operator reading this table goes looking for next. */}
              <Link
                to={sessionsFilterHref(task.chainId === null ? { taskId: task.id } : { chainId: task.chainId })}
                className="text-[12px] text-primary hover:underline"
              >
                <span data-task-sessions-link>{t("taskDetail.runs.viewSessions")}</span>
              </Link>
            </span>
          }
          flush
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>{t("taskDetail.runs.table.run")}</TableHead><TableHead>{t("taskDetail.runs.table.status")}</TableHead><TableHead>{t("taskDetail.runs.table.session")}</TableHead><TableHead>{t("taskDetail.runs.table.started")}</TableHead><TableHead>{t("taskDetail.runs.table.duration")}</TableHead>
                <TableHead>base → head</TableHead><TableHead>{t("taskDetail.runs.table.cost")}</TableHead><TableHead>{t("taskDetail.runs.table.tokens")}</TableHead><TableHead>{t("taskDetail.runs.table.failureClass")}</TableHead><TableHead>{t("taskDetail.runs.table.branch")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((item) => (
                <RunRow key={item.id} run={item} remoteUrl={task.repo?.remoteUrl} baseline={task.baseline} expanded={expanded === item.id}
                  onToggle={() => setExpanded(expanded === item.id ? null : item.id)} />
              ))}
            </TableBody>
          </Table>
          {runs.length === 0 ? <EmptyState>{t("taskDetail.runs.empty")}</EmptyState> : null}
        </Card>

        {task.chainId === null ? null
          : chain.data && chain.data.chainId !== null
            ? <ChainList chain={chain.data} taskId={taskId} pending={pending} regressionTaskId={regressionTaskId}
                repairActivities={repairActivities.data} repairActivitiesLoading={repairActivities.loading}
                repairActivitiesError={repairActivities.error?.message ?? null} onReloadRepairActivities={repairActivities.reload}
                onStart={startStep} onControl={controlChain} onToggleGate={toggleGate}
                agents={agents.data ?? []} onReassign={reassign} />
            : chain.loading ? <Card title={t("chain.title")}><EmptyState>{t("chain.loading")}</EmptyState></Card>
              : <Card title={t("chain.title")}><ErrorNotice message={chain.error?.message ?? t("chain.error")} onRetry={chain.reload} /></Card>}

        <TaskPrompt description={task.description} editableBrief={task.editableBrief} pending={pending}
          onSave={(brief) => patch({ description: brief })} />

        <TaskOutput poll={output} />

        <Activity taskId={taskId} poll={activity} />
      </div>
    </Page>
  );
};

/** Keying here protects direct mounts as well as App's route boundary. */
export const TaskDetailPage = ({ taskId }: { taskId: string }): ReactNode => (
  <TaskDetailResource key={taskId} taskId={taskId} />
);
