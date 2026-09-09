import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { firstLine, formatDateTime, formatT, restLines, timeAgo } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useT, useTNodes } from "../lib/i18n";
import { projectScopedPath, useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import { cn } from "../lib/utils";
import { type DeployNotice, isNotice, latestDeploy, needsReply } from "../lib/inbox";
import type { Agent, InboxMessage, TaskStepOutput } from "../lib/types";
import { IconArrowLeft, IconQuestion, IconRobot, IconUser } from "../components/icons";
import {
  BACK_LINK, DETAIL_HEAD, LONG_TEXT, MSG_CARD, MSG_HEAD, MSG_TIME, PAGE_HEAD, PAGE_HEAD_H1,
  PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW, ROW_WRAP, STACK, STAT_PILL, TOOLBAR,
  AgentChip, Card, EmptyState, ErrorNotice, InboxPill, Markdown, Page, Pill, Segmented,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { TaskOutput } from "./TaskDetail";

/** Both stacked lists — inbox rows and decision choices — are the same grid. */
const LIST = "grid grid-cols-[minmax(0,1fr)] gap-[10px]";

/** `.inboxItem` and `.choice` stay raw `<button>`s: they are full-width cards
 *  that happen to be clickable, not `.btn`s, so they take no Button variant
 *  (plan §2.5) and never had a box-shadow. A notice row carries its own Dismiss
 *  `.btn`, and a button cannot nest in a button, so the card frame is a plain
 *  container and the row's own hit area is the `<button>` inside it. */
const INBOX_ITEM = "flex w-full gap-[14px] rounded-xl border border-border bg-card px-[16px] py-[13px] text-left hover:border-[color:var(--border-hover)]";
const INBOX_ITEM_HIT = "flex min-w-0 flex-1 cursor-pointer gap-[14px] text-left";

const CHOICE = "flex w-full items-start gap-[11px] rounded-lg border border-border bg-secondary px-[14px] py-[12px] text-left text-foreground hover:border-[color:var(--primary-soft)]";

/** The one line reporting where production is. A successful deploy is archived
 *  on write — no push, no badge — so without this strip the operator would have
 *  no answer to "did it ship, and when". */
const DEPLOY_STRIP = "flex items-center gap-[8px] rounded-xl border px-[16px] py-[11px] text-[12.5px]";

/** `.msgCard + .msgCard { margin-top: 12px }` — every card but the first; here
 *  every child of the container is a card, so the sibling combinator is exact. */
const MSG_LIST = "[&>*+*]:mt-[12px]";

/** The roster by id, so a sender is named by the same chip the rest of the
 *  console names an Agent with — title plus the model it currently runs. */
const useAgentsById = (): Map<string, Agent> => {
  const { projectId } = useProjectScope();
  const { data } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 30_000);
  return new Map((data ?? []).map((agent) => [agent.id, agent]));
};

/* Pure and called from two components, so it reads the locale through `formatT`
 * — the WI-4 seam — rather than taking a `Translate` parameter (same rule as
 * WI-6's helpers). The agent's own title is API data and stays untranslated. */
const senderName = (message: InboxMessage, agents: Map<string, Agent>): string =>
  // Unmatched inbound Feishu text lands here as a HUMAN message with no agent.
  message.from === "HUMAN" ? formatT("inbox.sender.you")
    : message.agentId === null ? formatT("inbox.sender.system")
      : agents.get(message.agentId)?.title ?? formatT("inbox.sender.agent");

/** An agent-authored message whose Agent is still in the roster gets the chip;
 *  a human, a system notice, or an Agent since deleted keeps the plain line. */
const Sender = ({ message, agents }: { message: InboxMessage; agents: Map<string, Agent> }): ReactNode => {
  const agent = message.from === "HUMAN" || message.agentId === null ? undefined : agents.get(message.agentId);
  if (agent !== undefined) return <AgentChip agent={agent} />;
  return (
    <>
      {message.from === "HUMAN" || message.agentId === null ? <IconUser /> : <IconRobot />}
      <span className="text-foreground">{senderName(message, agents)}</span>
    </>
  );
};

const DEPLOY_TONE: Record<DeployNotice["outcome"], string> = {
  success: "border-border bg-card text-muted-foreground",
  failure: "border-[color:var(--status-amber-line)] bg-[color-mix(in_srgb,var(--status-amber-fg)_5%,transparent)] text-[color:var(--status-amber-fg)]",
};

const DeployStrip = ({ deploy }: { deploy: DeployNotice }): ReactNode => {
  const t = useT();
  return (
    <div className={cn(DEPLOY_STRIP, DEPLOY_TONE[deploy.outcome])}>
      {/* A hostname is a machine identifier, not prose: it stays out of the
        * translated sentence and out of the message the operator reads aloud.
        * Records written before hosts were named simply have none to show. */}
      {deploy.host === null ? null : <span className="flex-none opacity-70">{deploy.host}</span>}
      <span>
        {deploy.outcome === "success"
          ? t("inbox.deploy.success", { revision: deploy.revision, when: timeAgo(deploy.at) })
          : t("inbox.deploy.failure", { revision: deploy.revision, when: timeAgo(deploy.at), reason: deploy.reason })}
      </span>
    </div>
  );
};

type InboxFilter = "active" | "notices" | "answered";

const LANE: Record<InboxFilter, (message: InboxMessage) => boolean> = {
  active: needsReply,
  notices: isNotice,
  answered: (message) => message.status !== "OPEN",
};

const EMPTY: Record<InboxFilter, string> = {
  active: "inbox.empty.active",
  notices: "inbox.empty.notices",
  answered: "inbox.empty.answered",
};

export const InboxPage = (): ReactNode => {
  const { projectId } = useProjectScope();
  const messagesPath = projectScopedPath("/inbox/messages", projectId);
  const { data, loading, error, reload } = usePoll<InboxMessage[]>(messagesPath);
  const agents = useAgentsById();
  const [filter, setFilter] = useState<InboxFilter>("active");
  const { pending, error: actionError, run } = useAction();
  const t = useT();
  const all = data ?? [];
  const messages = all.filter(LANE[filter]);
  const deploy = latestDeploy(all);
  const noticeCount = all.filter(LANE.notices).length;

  const dismiss = (messageId: string): void => {
    void run(async () => {
      await api.post(`/inbox/messages/${messageId}/close`, { requestId: `${messageId}:close` });
      reload();
    });
  };

  return (
    <Page>
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("inbox.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("inbox.head.subtitle")}</div>
        </div>
      </div>

      {/* Reference puts the Active/Archived switch on the left under the title
          (inboxes-list-t0885.jpg), not in the header action slot. Notices sit
          between them: open, but nobody is blocked on them. */}
      <div className={TOOLBAR}>
        <Segmented
          accent
          value={filter}
          onChange={setFilter}
          options={[
            { value: "active", label: t("inbox.filter.active") },
            { value: "notices", label: noticeCount === 0 ? t("inbox.filter.notices") : `${t("inbox.filter.notices")} ${noticeCount}` },
            { value: "answered", label: t("inbox.filter.answered") },
          ]}
        />
      </div>

      <div className={STACK}>
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        {deploy === null ? null : <DeployStrip deploy={deploy} />}
        <div className={LIST}>
          {messages.map((message) => (
            <div className={INBOX_ITEM} key={message.id}>
              <button type="button" className={INBOX_ITEM_HIT} onClick={() => navigate(`/inbox/${message.id}`)}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-[8px] text-[12.5px] font-bold text-foreground">
                    <Sender message={message} agents={agents} />
                    {message.status === "OPEN" ? <InboxPill status={message.status} /> : null}
                    {message.gateTaskId === null ? null : <Pill tone="violet">{t("inbox.approvalGate")}</Pill>}
                  </div>
                  <div className="mt-[5px] flex items-center gap-[8px] text-[13px] text-foreground">
                    {message.status === "OPEN" ? <span className="size-[7px] flex-none rounded-full bg-primary" /> : null}
                    {firstLine(message.body)}
                  </div>
                  <div className="mt-[4px] overflow-hidden text-[12px] text-ellipsis whitespace-nowrap text-muted-foreground">{restLines(message.body) || "—"}</div>
                </div>
                <div className="flex-none text-right text-[11.5px] text-muted-foreground">
                  {timeAgo(message.createdAt)}
                  <div className="mt-[5px] text-[color:var(--faint)]">{message.channel.toLowerCase()} · {message.deliveryStatus.toLowerCase()}</div>
                </div>
              </button>
              {filter === "notices"
                ? <Button type="button" variant="legacy" size="legacySmall" className="flex-none self-center shadow-none" disabled={pending} onClick={() => dismiss(message.id)}>{t("inbox.dismiss")}</Button>
                : null}
            </div>
          ))}
        </div>
        {messages.length === 0 ? <EmptyState>{t(loading ? "common.loading" : EMPTY[filter])}</EmptyState> : null}
      </div>
    </Page>
  );
};

export const InboxThreadPage = ({ messageId }: { messageId: string }): ReactNode => {
  const { projectId } = useProjectScope();
  const messagesPath = projectScopedPath("/inbox/messages", projectId);
  const { data, error, reload } = usePoll<InboxMessage[]>(messagesPath);
  const agents = useAgentsById();
  const [reply, setReply] = useState("");
  const { pending, error: actionError, run } = useAction();
  const t = useT();
  const tn = useTNodes();
  // Resolved before the early returns below because it feeds a hook: `usePoll`
  // must be called on every render, and it takes `null` while the card (or its
  // artifact) is unknown.
  const message = (data ?? []).find((candidate) => candidate.id === messageId) ?? null;
  // The card body carries only a truncated preview — it has to fit in a Feishu
  // card. The board is not bound by that, so an approval gate shows the
  // producing step's output in full, from the same endpoint the Tasks page uses.
  const artifactTaskId = message?.artifactTaskId ?? null;
  const artifact = usePoll<TaskStepOutput>(artifactTaskId === null ? null : `/tasks/${artifactTaskId}/output`, 10_000);

  if (error !== null && data === null) {
    return <Page><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></Page>;
  }
  if (!message) {
    return (
      <Page>
        <div className={DETAIL_HEAD}><Link to="/inbox" className={BACK_LINK}><IconArrowLeft />{t("inbox.back")}</Link></div>
        <EmptyState>{tn("inbox.notFound", { route: <code>GET /inbox/messages</code> })}</EmptyState>
      </Page>
    );
  }

  // Both channels post to the same endpoint; requestId makes double clicks and a
  // Feishu tap racing the web button idempotent (DECISIONS #16).
  const decide = (decision: string): void => {
    const request: { decision: string; requestId: string; note?: string } = {
      decision,
      requestId: `${message.id}:${decision}`,
    };
    const note = reply.trim();
    if (message.gateTaskId !== null && note !== "") request.note = note;
    void run(async () => {
      await api.post(`/inbox/messages/${message.id}/decision`, request);
      setReply("");
      reload();
    });
  };

  const sendReply = (): void => {
    const body = reply.trim();
    if (body === "") return;
    void run(async () => {
      await api.post(`/inbox/messages/${message.id}/reply`, { body, requestId: `${message.id}:reply:${Date.now()}` });
      setReply("");
      reload();
    });
  };

  const closeNotification = (): void => {
    void run(async () => {
      await api.post(`/inbox/messages/${message.id}/close`, { requestId: `${message.id}:close` });
      reload();
    });
  };

  const choices = message.choices ?? [];
  const open = message.status === "OPEN";
  const detachedNotification = isNotice(message);
  const freeTextReply = message.acceptsFreeText && message.gateTaskId === null ? (
    <>
      {/* `shadow-none` and `placeholder:text-foreground/50` for the reason
          spelled out at Projects.tsx: this was a raw <textarea> before the
          batch, so it carried no shadow and took Tailwind preflight's
          `currentColor` at 50% for the placeholder, not the primitive's
          pinned `text-muted-foreground`. */}
      <Textarea rows={5} className="shadow-none placeholder:text-foreground/50" value={reply} onChange={(event) => setReply(event.target.value)} placeholder={t("inbox.reply.placeholder")} />
      <div className={ROW}><span className="flex-1" /><Button type="button" variant="legacyPrimary" size="legacy" className="shadow-none" disabled={pending || reply.trim() === ""} onClick={sendReply}>{t("inbox.reply.send")}</Button></div>
    </>
  ) : null;
  const gateNote = message.acceptsFreeText && message.gateTaskId !== null ? (
    <Textarea rows={5} className="shadow-none placeholder:text-foreground/50" value={reply} onChange={(event) => setReply(event.target.value)} placeholder={t("inbox.gateNote.placeholder")} />
  ) : null;

  return (
    <Page>
      <div className={DETAIL_HEAD}>
        <Link to="/inbox" className={BACK_LINK}><IconArrowLeft />{t("inbox.back")}</Link>
        <span className="flex-1" />
        <span className="text-[11.5px] text-muted-foreground">{t("inbox.updated", { when: timeAgo(message.answeredAt ?? message.createdAt) })}</span>
      </div>

      <div className={STACK}>
        {/* The subject is the first line of a message body, so it is arbitrary
            text: an auto-deploy notice carries two 40-character shas, which in a
            non-wrapping row pushed the status pill off the right of a phone and
            gave the document a horizontal scroll. The title breaks inside a word
            and the pills fall to their own line. */}
        <div className={cn(ROW, "[@media(max-width:900px)]:flex-wrap")}>
          <h1 className="min-w-0 text-[18px] [overflow-wrap:anywhere]">{firstLine(message.body)}</h1>
          <InboxPill status={message.status} />
          {message.gateTaskId === null ? null : <Pill tone="violet">{t("inbox.approvalGate")}</Pill>}
        </div>

        <div className={ROW_WRAP}>
          {message.taskId === null ? null : <Link to={`/tasks/${message.taskId}`} className={STAT_PILL}>{t("inbox.stat.task", { id: message.taskId.slice(-6) })}</Link>}
          {artifactTaskId === null ? null : <Link to={`/tasks/${artifactTaskId}`} className={STAT_PILL}>{t("inbox.stat.artifactTask", { id: artifactTaskId.slice(-6) })}</Link>}
          {message.goalId === null ? null : <Link to={`/goals/${message.goalId}`} className={STAT_PILL}>{t("inbox.stat.goal", { id: message.goalId.slice(-6) })}</Link>}
          <span className={STAT_PILL}>{message.channel.toLowerCase()} · {message.deliveryStatus.toLowerCase()}</span>
          {message.deliveryAttempts > 0 ? <span className={STAT_PILL}>{t("inbox.stat.attempts", { n: message.deliveryAttempts })}</span> : null}
        </div>

        {message.lastDeliveryError === null ? null : <ErrorNotice message={t("inbox.deliveryError", { error: message.lastDeliveryError })} />}

        <div className={MSG_LIST}>
          <div className={MSG_CARD}>
            <div className={MSG_HEAD}>
              <Sender message={message} agents={agents} />
              <span className={MSG_TIME}>{formatDateTime(message.createdAt)}</span>
            </div>
            <Markdown text={message.body} />
          </div>

          {artifactTaskId === null ? null : <TaskOutput poll={artifact} />}

          {(message.replies ?? []).map((replyMessage) => (
            <div className={cn(MSG_CARD, "ml-[40px] bg-secondary")} key={replyMessage.id}>
              <div className={MSG_HEAD}>
                <IconUser />
                <span className="text-foreground">{t("inbox.sender.youWeb")}</span>
                <span className={MSG_TIME}>{formatDateTime(replyMessage.createdAt)}</span>
              </div>
              <Markdown text={replyMessage.body} />
            </div>
          ))}
          {(message.replies ?? []).length === 0 ? (message.decisions ?? []).map((decision) => (
            <div className={cn(MSG_CARD, "ml-[40px] bg-secondary")} key={decision.id}>
              <div className={MSG_HEAD}>
                <IconUser />
                <span className="text-foreground">{decision.actorOpenId === "web-operator" ? t("inbox.sender.youWeb") : decision.actorOpenId ?? t("inbox.sender.operator")}</span>
                <span className={MSG_TIME}>{formatDateTime(decision.createdAt)}</span>
              </div>
              <div className={LONG_TEXT}>{decision.decision}</div>
            </div>
          )) : null}
        </div>

        {actionError === null ? null : <ErrorNotice message={actionError} />}

        {open ? (
          <Card>
            <div className={STACK}>
              <div className="flex items-center gap-[10px] rounded-lg border border-[color:var(--status-amber-line)] bg-[color-mix(in_srgb,var(--status-amber-fg)_5%,transparent)] px-[14px] py-[11px] text-[12.5px] text-[color:var(--status-amber-fg)]"><IconQuestion />{t(detachedNotification ? "inbox.notification" : "inbox.waiting")}</div>
              {detachedNotification ? (
                <div className={ROW}><span className="flex-1" /><Button type="button" variant="legacyPrimary" size="legacy" className="shadow-none" disabled={pending} onClick={closeNotification}>{t("inbox.close")}</Button></div>
              ) : message.gateTaskId !== null ? (
                <>
                  <div className={ROW}>
                    <Button type="button" variant="legacyPrimary" size="legacy" className="shadow-none" disabled={pending} onClick={() => decide("approve")}>{t("inbox.approve")}</Button>
                    <Button type="button" variant="legacyDanger" size="legacy" className="shadow-none" disabled={pending} onClick={() => decide("reject")}>{t("inbox.reject")}</Button>
                  </div>
                  {gateNote}
                </>
              ) : choices.length > 0 ? (
                <div className={LIST}>
                  {choices.map((option) => (
                    <button type="button" key={option.id} className={CHOICE} disabled={pending} onClick={() => decide(option.id)}>
                      <span className="mt-[2px] size-[15px] flex-none rounded-full border border-[color:var(--radio-border)]" />
                      <span className="flex-1 text-[12.5px]">{option.label}<span className="mt-[3px] block">{option.id}</span></span>
                    </button>
                  ))}
                  {freeTextReply}
                </div>
              ) : (
                freeTextReply
              )}
            </div>
          </Card>
        ) : (
          <Card>
            <div className="text-muted-foreground">
              {t("inbox.answered", { when: timeAgo(message.answeredAt) })}
              {message.selectedChoiceId === null ? "" : t("inbox.selectedChoice", { id: message.selectedChoiceId })}
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
};
