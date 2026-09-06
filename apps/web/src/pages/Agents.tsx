import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { contentRevision, formatDate, formatDateTime, titleCase } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { fatal } from "../lib/poll-state";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import type { Agent, CodexServiceTier, Environment, FilesystemGrant, MCPConnection, RepoPermission, RunnerPreference, Skill, Repo } from "../lib/types";
import { IconArrowLeft, IconPlus, IconRobot } from "../components/icons";
import { ModelLabel, ModelPicker, modelForSave } from "../components/model-picker";
import {
  modelChipLabel, runnerFor, runnerForModel, slugForModel, SLUG_EXEMPT_AGENT_NAMES,
  supportsCodexServiceTier, validateModelPair,
} from "../lib/models";
import { isEnforced, TOOL_KEYS, TOOL_LABEL_KEYS, type ToolKey } from "../lib/tools";
import { cn } from "../lib/utils";
import {
  BACK_LINK, CODE_BLOCK, COUNT, DETAIL_HEAD, DETAIL_HEAD_H1, FIELD, FIELD_LABEL, FIELD_ROW, HINT,
  PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW, ROW_WRAP, STACK,
  TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  AgentChip, Card, Check, EmptyState, ErrorNotice, Field, FullPanel, KeyValue, Page, Pill,
  RowMenu, Segmented, Tabs, Toggle,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";

export const NewAgent = ({ projectId, onClose, onCreated, initial }: {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
  /** Deterministic starting values for focused form tests; production omits it. */
  initial?: Partial<{ name: string; title: string; model: string; environmentId: string; runnerPreference: RunnerPreference; codexServiceTier: CodexServiceTier; rolePrompt: string }>;
}): ReactNode => {
  const environments = usePoll<Environment[]>(`/projects/${projectId}/environments`, 30_000);
  const [form, setForm] = useState({
    name: initial?.name ?? "", title: initial?.title ?? "", model: initial?.model ?? "claude-opus-5:medium", environmentId: initial?.environmentId ?? "",
    runnerPreference: initial?.runnerPreference ?? "CLAUDE" as RunnerPreference, inboxAccess: false,
    codexServiceTier: initial?.codexServiceTier ?? "DEFAULT" as CodexServiceTier,
    rolePrompt: initial?.rolePrompt ?? "",
  });
  const { pending, error, run } = useAction();
  const t = useT();

  useEffect(() => {
    const first = environments.data?.[0];
    if (first && form.environmentId === "") setForm((current) => ({ ...current, environmentId: first.id }));
  }, [environments.data, form.environmentId]);

  const submit = async (): Promise<void> => {
    const ok = await run(() => api.post<Agent>(`/projects/${projectId}/agents`, {
      ...form,
      model: modelForSave(form.model),
      runnerPreference: runnerForModel(form.model) ?? form.runnerPreference,
    }));
    if (ok) { onCreated(); onClose(); }
  };

  return (
    <FullPanel title={t("agents.new.title")} onClose={onClose} actions={
      <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || form.name.trim() === "" || form.environmentId.trim() === "" || validateModelPair(form.model, form.runnerPreference) !== null}
        onClick={() => void submit()}>{t("agents.new.create")}</Button>
    }>
      {error === null ? null : <ErrorNotice message={error} />}
      {fatal(environments.error, environments.data)
        ? <ErrorNotice message={`${environments.error!.status} ${environments.error!.message}`} onRetry={environments.reload} />
        : null}
      <Card title={t("agents.tab.setup")}>
        <div className={STACK}>
          <div className={FIELD_ROW}>
            <Field label={t("agents.field.name.label")} hint={t("agents.field.name.hint")}>
              <Input type="text" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="senior-dev-astra-medium" />
            </Field>
            <Field label={t("agents.field.title")}>
              <Input type="text" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder={t("agents.field.title.placeholder")} />
            </Field>
          </div>
          <ModelPicker model={form.model} runnerPreference={form.runnerPreference} onChange={(next) => setForm({
            ...form,
            ...next,
            codexServiceTier: supportsCodexServiceTier(next.runnerPreference, next.model) ? form.codexServiceTier : "DEFAULT",
          })} />
          <Field label={t("agents.field.codexServiceTier")} hint={t(supportsCodexServiceTier(form.runnerPreference, form.model)
            ? "agents.serviceTier.hint"
            : "agents.serviceTier.unavailable")}>
            <Select disabled={!supportsCodexServiceTier(form.runnerPreference, form.model)} value={form.codexServiceTier}
              onChange={(event) => setForm({ ...form, codexServiceTier: event.target.value as CodexServiceTier })}>
              <option value="DEFAULT">{t("serviceTier.DEFAULT")}</option>
              <option value="FAST">{t("serviceTier.FAST")}</option>
            </Select>
          </Field>
          <div><Link to="/settings" className="text-[var(--accent)] hover:underline">{t("agents.model.settingsHint")}</Link></div>
          <Field label={t("agents.field.environment.label")} hint={t("agents.field.environment.hint")}>
            <Select value={form.environmentId} onChange={(event) => setForm({ ...form, environmentId: event.target.value })}>
              {(environments.data ?? []).map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
            </Select>
          </Field>
          <div className={ROW}>
            <Toggle on={form.inboxAccess} onChange={(next) => setForm({ ...form, inboxAccess: next })} label={t("agents.inbox.label")} />
            <div>
              <div>{t("agents.inbox.label")}</div>
              <div>{t("agents.inbox.hint.new")}</div>
            </div>
          </div>
        </div>
      </Card>
      <Card title={t("agents.tab.prompt")}>
        <Field label={t("agents.field.rolePrompt")}>
          <Textarea rows={10} value={form.rolePrompt} onChange={(event) => setForm({ ...form, rolePrompt: event.target.value })}
            placeholder={t("agents.field.rolePrompt.placeholder")} />
        </Field>
      </Card>
    </FullPanel>
  );
};

/* ------------------------------------------------------- roster and naming */

export type AgentTitleGroup = { title: string; agents: Agent[] };

/**
 * The roster read as jobs rather than as slugs: one group per title, in the
 * order the list already sorts, with each title's model variants under it.
 *
 * Four Agents titled "Senior Dev" differ only by model and effort, and a flat
 * list of `senior-dev-*` slugs made that difference the first thing an operator
 * had to decode. The group header carries the job; the rows carry the runtime.
 */
export const groupAgentsByTitle = (agents: readonly Agent[]): AgentTitleGroup[] => {
  const groups = new Map<string, AgentTitleGroup>();
  for (const agent of agents) {
    const group = groups.get(agent.title);
    if (group) group.agents.push(agent);
    else groups.set(agent.title, { title: agent.title, agents: [agent] });
  }
  return [...groups.values()];
};

/** An Agent no operator may assign: the mechanical merge sentinel. It stays in
 *  the roster — it is a real Agent that spends and runs — and out of pickers. */
export const isMechanicalAgent = (agent: Pick<Agent, "assignable">): boolean => agent.assignable === false;

/** The first name in `base`, `base-copy`, `base-copy-2`, … that the project has
 *  not taken. Names are unique per project, so a duplicate offered under a taken
 *  name would be refused with 409 before the operator saw the form. */
export const availableAgentName = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  let candidate = `${base}-copy`;
  for (let ordinal = 2; taken.has(candidate); ordinal += 1) candidate = `${base}-copy-${ordinal}`;
  return candidate;
};

/** What the duplicate prompt starts from: the slug this Agent's own model and
 *  effort imply (R10), made free of collisions. The source's name is always one
 *  of them, so an unchanged runtime yields `<slug>-copy`. */
export const duplicateNameSuggestion = (agent: Agent, siblings: readonly Agent[]): string =>
  availableAgentName(
    slugForModel(agent.name, agent.model) ?? agent.name,
    new Set(siblings.map((sibling) => sibling.name)),
  );

/** Row menu and detail page share one duplicate action: same prompt, same body,
 *  and the same jump to the copy, which is the only way to see what was made. */
const useDuplicateAgent = (siblings: readonly Agent[]): {
  error: string | null;
  duplicate: (agent: Agent) => void;
} => {
  const { error, run } = useAction();
  const t = useT();
  const duplicate = (agent: Agent): void => {
    const chosen = window.prompt(t("agents.duplicate.prompt", { name: agent.name }), duplicateNameSuggestion(agent, siblings));
    if (chosen === null) return;
    const name = chosen.trim();
    if (name === "") return;
    void run(async () => {
      const copy = await api.post<Agent>(`/agents/${agent.id}/duplicate`, { name });
      navigate(`/agents/${copy.id}`);
    });
  };
  return { error, duplicate };
};

export type AgentsListTab = "active" | "archived";

export const filterAgentsByTab = (agents: readonly Agent[], tab: AgentsListTab): Agent[] =>
  agents.filter((agent) => tab === "archived" ? agent.archivedAt !== null : agent.archivedAt === null);

export const AgentsListTabs = ({ value, onChange }: {
  value: AgentsListTab;
  onChange: (value: AgentsListTab) => void;
}): ReactNode => {
  const t = useT();
  return <Segmented options={[
    { value: "active", label: t("agents.segmented.yours") },
    { value: "archived", label: t("tasks.tab.archived") },
  ]} value={value} onChange={onChange} />;
};

export const AgentsPage = (): ReactNode => {
  const { projectId, project } = useProjectScope();
  const { data, loading, error, reload } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 5_000);
  const [creating, setCreating] = useState(false);
  const [listTab, setListTab] = useState<AgentsListTab>("active");
  const { error: actionError, run } = useAction();
  const { error: duplicateError, duplicate } = useDuplicateAgent(data ?? []);
  const t = useT();
  const groups = groupAgentsByTitle(filterAgentsByTab(data ?? [], listTab));
  const shown = groups.reduce((count, group) => count + group.agents.length, 0);

  const remove = (agent: Agent): void => {
    if (!window.confirm(t("agents.confirm.delete", { name: agent.name }))) return;
    void run(async () => { await api.delete(`/agents/${agent.id}`); reload(); });
  };
  const toggleArchived = (agent: Agent): void => {
    const action = agent.archivedAt ? "unarchive" : "archive";
    void run(async () => { await api.post(`/agents/${agent.id}/${action}`); reload(); });
  };

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("agents.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("agents.head.subtitle", { project: project?.name ?? t("agents.head.thisProject") })}</div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacyPrimary" size="legacy" onClick={() => setCreating(true)}><IconPlus />{t("agents.create")}</Button>
        </div>
      </div>

      <AgentsListTabs value={listTab} onChange={setListTab} />

      <div className={cn(STACK, "mt-4")}>
        {fatal(error, data) ? <ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} /> : null}
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        {duplicateError === null ? null : <ErrorNotice message={duplicateError} />}
        <Card flush>
          <Table>
            <TableHeader><TableRow><TableHead>{t("agents.table.agent")}</TableHead><TableHead>{t("agents.field.runner")}</TableHead><TableHead>{t("agents.table.inbox")}</TableHead><TableHead>{t("common.updated")}</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.title}>
                  {/* One header per title, spanning the row: the group is the job,
                      and its variants below differ only in the chip's runtime. */}
                  <TableRow data-agent-group={group.title}>
                    <TableCell colSpan={5} className={cn(TABLE_NAME, "bg-secondary")}>
                      <span className={ROW}>{group.title}<span className={COUNT}>{group.agents.length}</span></span>
                    </TableCell>
                  </TableRow>
                  {group.agents.map((agent) => (
                    <TableRow key={agent.id} className="cursor-pointer" onClick={() => navigate(`/agents/${agent.id}`)}>
                      <TableCell className={TABLE_NAME}>
                        {/* Model and effort only: the header above already said
                            which job these rows are variants of, and repeating
                            the title on every one of them is what made the two
                            Senior Dev rows read as duplicates. */}
                        <span className={ROW_WRAP}>
                          <Pill tone="grey">{modelChipLabel(agent.model)}</Pill>
                          {agent.archivedAt ? <Pill tone="grey">{t("tasks.tab.archived")}</Pill> : null}
                          {isMechanicalAgent(agent) ? <Pill tone="grey">{t("agents.pill.mechanical")}</Pill> : null}
                        </span>
                      </TableCell>
                      <TableCell>{t(`runner.preference.${agent.runnerPreference}`)}</TableCell>
                      <TableCell>{agent.inboxAccess ? <Pill tone="green">{t("agents.inbox.on")}</Pill> : <Pill tone="grey">{t("agents.inbox.off")}</Pill>}</TableCell>
                      <TableCell>{formatDate(agent.updatedAt)}</TableCell>
                      <TableCell className={TABLE_TIGHT}><RowMenu items={[
                        ...(isMechanicalAgent(agent) ? [] : [{ label: t("agents.duplicate.action"), onSelect: () => duplicate(agent) }]),
                        { label: t(agent.archivedAt ? "archived.menu.unarchive" : "tasks.menu.archive"), onSelect: () => toggleArchived(agent) },
                        { label: t("common.delete"), danger: true, onSelect: () => remove(agent) },
                      ]} /></TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
          {shown === 0 ? <EmptyState>{t(loading ? "common.loading" : listTab === "archived" ? "archived.empty" : "agents.empty")}</EmptyState> : null}
        </Card>
      </div>

      {creating ? <NewAgent projectId={projectId} onClose={() => setCreating(false)} onCreated={reload} /> : null}
    </Page>
  );
};

type AgentTab = "setup" | "prompt" | "capabilities" | "collaborators";

const RepoAccessRow = ({ agent, repo, granted, onDone }: {
  agent: Agent;
  repo: Repo;
  granted: { permissions: RepoPermission; mountPath: string } | null;
  onDone: () => void;
}): ReactNode => {
  const [permissions, setPermissions] = useState<RepoPermission>(granted?.permissions ?? "GIT_WRITE");
  const [mountPath, setMountPath] = useState(granted?.mountPath ?? repo.mountPath);
  const { pending, error, run } = useAction();
  const t = useT();
  const grant = (): void => {
    void run(async () => {
      await api.post(`/agents/${agent.id}/repos/${repo.id}/access`, { permissions, mountPath });
      onDone();
    });
  };
  return (
    <div className={cn(STACK, "border-t border-[var(--border-soft)] pt-3.5")}>
      <div className={ROW}>
        <div className="min-w-0 flex-1">
          <div className="text-foreground">{repo.name}</div>
          <div>{t("agents.repo.default", { remote: repo.remoteUrl, branch: repo.defaultBranch })}</div>
        </div>
        {granted ? <Pill tone="green">{t("agents.repo.granted")}</Pill> : null}
      </div>
      <div className={FIELD_ROW}>
        <Field label={t("agents.repo.permission")}>
          <Select value={permissions} onChange={(event) => setPermissions(event.target.value as RepoPermission)}>
            <option value="GIT_READ">git-read</option>
            <option value="GIT_WRITE">git-write</option>
          </Select>
        </Field>
        <Field label={t("agents.repo.mountPath")}>
          <Input type="text" value={mountPath} onChange={(event) => setMountPath(event.target.value)} />
        </Field>
        <div className={FIELD}>
          <label className={FIELD_LABEL}>&nbsp;</label>
          <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending} onClick={grant}>{t("agents.repo.grant")}</Button>
        </div>
      </div>
      {error === null ? null : <ErrorNotice message={error} />}
    </div>
  );
};

export const BindingToggle = ({ on, label, add, remove, onDone }: {
  on: boolean;
  label: string;
  add: () => Promise<unknown>;
  remove: () => Promise<unknown>;
  onDone: () => void;
}): ReactNode => {
  const { pending, error, run } = useAction();
  const change = (next: boolean): void => {
    void run(async () => {
      if (next) await add();
      else await remove();
      onDone();
    });
  };
  /* The wrapper is a `ROW`, not a bare block, for the same reason the other four
   * `Toggle` call sites are: inside a block container the switch is an inline-flex
   * box whose baseline is now its thumb's bottom margin edge — 3px above the root's
   * bottom border edge, because of the `border-[3px]` that reproduces the legacy
   * knob inset (ui.tsx:280). Baseline alignment then drops the whole switch by
   * exactly 3.00 px, which is the drift the batch-1 screenshot re-shoot measured on
   * `agents-toggle-*`. As a flex item the switch is blockified and no baseline
   * applies. The 3px border itself is correct and stays. */
  return <div className={ROW}>{error === null ? null : <ErrorNotice message={error} />}<Toggle on={on} onChange={change} disabled={pending} label={label} /></div>;
};

const toolSet = (raw: string[] | undefined): Set<ToolKey> => new Set((raw ?? []).filter((key): key is ToolKey => (TOOL_KEYS as readonly string[]).includes(key)));
const toolArray = (set: Set<ToolKey>): ToolKey[] => TOOL_KEYS.filter((key) => set.has(key));
const applyToolIntent = (set: Set<ToolKey>, key: ToolKey, enabled: boolean): Set<ToolKey> => {
  const next = new Set(set);
  if (enabled) next.delete(key);
  else next.add(key);
  return next;
};

export const AgentToolsCard = ({ agent, onSaved }: { agent: Agent; onSaved: () => void }): ReactNode => {
  const incoming = toolArray(toolSet(agent.disabledTools)).join(",");
  const lastSeed = useRef(incoming);
  const [denied, setDenied] = useState<Set<ToolKey>>(() => toolSet(agent.disabledTools));
  const deniedRef = useRef(denied);
  const confirmedRef = useRef(toolSet(agent.disabledTools));
  const intents = useRef<Array<{ id: number; key: ToolKey; enabled: boolean }>>([]);
  const nextIntentId = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const queued = useRef(0);
  const [pendingWrites, setPendingWrites] = useState(0);
  const [writeError, setWriteError] = useState<string | null>(null);
  const t = useT();
  const runner = runnerFor(agent.runnerPreference, agent.model);
  const heuristic = agent.runnerPreference === "INHERIT" || agent.runnerPreference === "AUTO";

  useEffect(() => {
    if (pendingWrites !== 0 || incoming === lastSeed.current) return;
    const next = toolSet(agent.disabledTools);
    lastSeed.current = incoming;
    confirmedRef.current = next;
    deniedRef.current = next;
    setDenied(next);
  }, [agent.disabledTools, incoming, pendingWrites]);

  const change = (key: ToolKey, enabled: boolean): void => {
    const next = applyToolIntent(deniedRef.current, key, enabled);
    deniedRef.current = next;
    setDenied(next);
    setWriteError(null);
    nextIntentId.current += 1;
    const intent = { id: nextIntentId.current, key, enabled };
    intents.current.push(intent);
    queued.current += 1;
    setPendingWrites(queued.current);
    const request = chain.current.then(async () => {
      const confirmed = applyToolIntent(confirmedRef.current, intent.key, intent.enabled);
      const body = toolArray(confirmed);
      await api.patch(`/agents/${agent.id}`, { disabledTools: body });
      confirmedRef.current = confirmed;
    });
    chain.current = request.catch(() => undefined);
    void request.catch((reason: unknown) => {
      setWriteError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      intents.current = intents.current.filter((queuedIntent) => queuedIntent.id !== intent.id);
      const optimistic = intents.current.reduce(
        (current, queuedIntent) => applyToolIntent(current, queuedIntent.key, queuedIntent.enabled),
        confirmedRef.current,
      );
      deniedRef.current = optimistic;
      setDenied(optimistic);
      queued.current -= 1;
      setPendingWrites(queued.current);
      if (queued.current === 0) onSaved();
    });
  };

  return (
    <div data-agent-tools="">
    <Card title={t("agents.tools.title")} extra={<span className={COUNT}>{TOOL_KEYS.length - denied.size}/{TOOL_KEYS.length}</span>}>
      <div className={cn(STACK, "mb-3.5")}>
        <div>{t(heuristic ? "agents.tools.resolvesHeuristic" : "agents.tools.resolves", { runner: runner.toLowerCase() })}</div>
        {runner === "CODEX" ? <div className="text-destructive">{t("agents.tools.codexNotice")}</div> : null}
        {denied.size === TOOL_KEYS.length ? <div className="text-destructive">{t("agents.tools.none")}</div> : null}
        {writeError === null ? null : <ErrorNotice message={writeError} />}
      </div>
      {TOOL_KEYS.map((key) => {
        const enforced = isEnforced(runner, key);
        const piDefaultOff = runner === "PI" && (key === "GLOB" || key === "GREP");
        return (
          <div key={key} className={cn(ROW, "border-t border-[var(--border-soft)] py-2.5")}>
            <Toggle on={!denied.has(key)} onChange={(next) => change(key, next)} label={t("agents.tools.toggle", { tool: t(TOOL_LABEL_KEYS[key]) })} />
            <div className="flex-1 text-foreground" {...(piDefaultOff ? { title: t("agents.tools.piDefaultOff") } : {})}>{t(TOOL_LABEL_KEYS[key])}</div>
            {enforced ? null : <Pill tone="grey">{t("agents.tools.notEnforced", { runner: runner.toLowerCase() })}</Pill>}
          </div>
        );
      })}
      {pendingWrites > 0 ? <div className="mt-2.5 text-[11.5px] text-[color:var(--faint)]">{t("common.saving")}</div> : null}
    </Card>
    </div>
  );
};

const FilesystemGrantRow = ({ agentId, grant, onDone }: { agentId: string; grant: FilesystemGrant; onDone: () => void }): ReactNode => {
  const { pending, error, run } = useAction();
  const t = useT();
  const patch = (key: "canRead" | "canWrite" | "canDelete", value: boolean): void => {
    void run(async () => {
      await api.patch(`/agents/${agentId}/filesystem-grants/${grant.id}`, {
        canRead: grant.canRead, canWrite: grant.canWrite, canDelete: grant.canDelete, [key]: value,
      });
      onDone();
    });
  };
  const remove = (): void => {
    void run(async () => {
      await api.delete(`/agents/${agentId}/filesystem-grants/${grant.id}`);
      onDone();
    });
  };
  return (
    <TableRow>
      <TableCell className={TABLE_NAME}>{grant.folderPath}{error === null ? null : <span className={TABLE_SUB}>{error}</span>}</TableCell>
      <TableCell><Check on={grant.canRead} onChange={(value) => patch("canRead", value)} disabled={pending} label={t("agents.fs.read", { path: grant.folderPath })} /></TableCell>
      <TableCell><Check on={grant.canWrite} onChange={(value) => patch("canWrite", value)} disabled={pending} label={t("agents.fs.write", { path: grant.folderPath })} /></TableCell>
      <TableCell><Check on={grant.canDelete} onChange={(value) => patch("canDelete", value)} disabled={pending} label={t("agents.fs.delete", { path: grant.folderPath })} /></TableCell>
      <TableCell className={TABLE_TIGHT}><RowMenu items={[{ label: t("agents.fs.remove"), danger: true, onSelect: remove }]} /></TableCell>
    </TableRow>
  );
};

const NewFilesystemGrant = ({ agentId, onDone }: { agentId: string; onDone: () => void }): ReactNode => {
  const [folderPath, setFolderPath] = useState("");
  const [permissions, setPermissions] = useState({ canRead: true, canWrite: false, canDelete: false });
  const { pending, error, run } = useAction();
  const t = useT();
  const submit = async (): Promise<void> => {
    const ok = await run(() => api.post(`/agents/${agentId}/filesystem-grants`, { folderPath, ...permissions }));
    if (ok) { setFolderPath(""); setPermissions({ canRead: true, canWrite: false, canDelete: false }); onDone(); }
  };
  const any = permissions.canRead || permissions.canWrite || permissions.canDelete;
  return (
    <div className={cn(STACK, "mb-3.5")}>
      {error === null ? null : <ErrorNotice message={error} />}
      <div className={FIELD_ROW}>
        <Field label={t("agents.fs.folderPath")}><Input type="text" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="/absolute/path" /></Field>
        <Field label={t("agents.fs.permissions")}>
          <div className={cn(ROW, "min-h-[34px]")}>
            {(["canRead", "canWrite", "canDelete"] as const).map((key) => (
              <span className={ROW} key={key}><Check on={permissions[key]} onChange={(value) => setPermissions({ ...permissions, [key]: value })} label={t(`agents.fs.${key}`)} />{t(`agents.fs.${key}`)}</span>
            ))}
          </div>
        </Field>
        <div className={FIELD}><label className={FIELD_LABEL}>&nbsp;</label><Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || folderPath.trim() === "" || !any} onClick={() => void submit()}>{t("agents.fs.grant")}</Button></div>
      </div>
    </div>
  );
};

const CapabilitiesTab = ({ agent, projectId, onSaved }: { agent: Agent; projectId: string; onSaved: () => void }): ReactNode => {
  const repos = usePoll<Repo[]>(`/projects/${projectId}/repos`, 10_000);
  const skills = usePoll<Skill[]>(`/projects/${projectId}/skills`, 30_000);
  const connections = usePoll<MCPConnection[]>(`/projects/${projectId}/mcp-connections`, 30_000);
  const grantedRepos = agent.repoAccess ?? null;
  const t = useT();

  return (
    <div className={STACK}>
      <AgentToolsCard agent={agent} onSaved={onSaved} />
      <Card title={t("agents.cap.repos")} extra={<span className={COUNT}>{(repos.data ?? []).length}</span>}>
        {(repos.data ?? []).length === 0
          ? <EmptyState>{t("connections.repos.empty")}</EmptyState>
          : (repos.data ?? []).map((repo) => (
            <RepoAccessRow key={repo.id} agent={agent} repo={repo} onDone={onSaved}
              granted={grantedRepos?.find((access) => access.repoId === repo.id) ?? null} />
          ))}
      </Card>

      <Card title={t("agents.cap.skills")} extra={<span className={COUNT}>{(skills.data ?? []).length}</span>}>
        {(skills.data ?? []).length === 0
          ? <EmptyState>{t("agents.cap.skills.empty")}</EmptyState>
          : (skills.data ?? []).map((skill) => {
            const mounted = (agent.skills ?? []).some((entry) => entry.skillId === skill.id);
            return (
              <div key={skill.id} className={cn(ROW, "border-t border-[var(--border-soft)] py-2.5")}>
                <div className="flex-1">
                  <div className="text-foreground">{skill.name}</div>
                  <div>{skill.kind.toLowerCase()} · {skill.slug}</div>
                </div>
                <BindingToggle on={mounted} label={t("agents.cap.mount", { name: skill.name })}
                  add={() => api.post(`/agents/${agent.id}/skills`, { skillId: skill.id })}
                  remove={() => api.delete(`/agents/${agent.id}/skills/${skill.id}`)} onDone={onSaved} />
              </div>
            );
          })}
      </Card>

      <Card title={t("connections.mcp.title")} extra={<span className={COUNT}>{(connections.data ?? []).length}</span>}>
        {(connections.data ?? []).length === 0 ? <EmptyState>{t("agents.cap.mcp.empty")}</EmptyState> : (connections.data ?? []).map((connection) => {
          const bound = (agent.mcpConnections ?? []).some((entry) => entry.mcpConnectionId === connection.id);
          return (
            <div key={connection.id} className={cn(ROW, "border-t border-[var(--border-soft)] py-2.5")}>
              <div className="flex-1">
                <div className="text-foreground">{connection.name}</div>
                <div>{connection.transport}</div>
              </div>
              <BindingToggle on={bound} label={t("agents.cap.bind", { name: connection.name })}
                add={() => api.post(`/agents/${agent.id}/mcp-connections`, { mcpConnectionId: connection.id })}
                remove={() => api.delete(`/agents/${agent.id}/mcp-connections/${connection.id}`)} onDone={onSaved} />
            </div>
          );
        })}
      </Card>

      <Card title={t("secrets.head.title")} extra={<span className={COUNT}>{(agent.secretGrants ?? []).length}</span>}>
        {(agent.secretGrants ?? []).length === 0
          ? <EmptyState>{t("agents.cap.secrets.empty")}</EmptyState>
          : (agent.secretGrants ?? []).map((grant) => (
            <div key={`${grant.secretId}:${grant.envVar}`} className={cn(ROW, "border-t border-[var(--border-soft)] py-2.5")}>
              <div className="flex-1"><div className="text-foreground">{grant.secret?.name ?? grant.secretId}</div><div>{grant.envVar}</div></div>
            </div>
          ))}
      </Card>

      <Card title={t("agents.cap.filesystem")} extra={<span className={COUNT}>{(agent.filesystemGrants ?? []).length}</span>}>
        <NewFilesystemGrant agentId={agent.id} onDone={onSaved} />
        <Table>
          <TableHeader><TableRow><TableHead>{t("agents.fs.folder")}</TableHead><TableHead>{t("agents.fs.canRead")}</TableHead><TableHead>{t("agents.fs.canWrite")}</TableHead><TableHead>{t("agents.fs.canDelete")}</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {(agent.filesystemGrants ?? []).map((grant) => (
              <FilesystemGrantRow key={grant.id} agentId={agent.id} grant={grant} onDone={onSaved} />
            ))}
          </TableBody>
        </Table>
        {(agent.filesystemGrants ?? []).length === 0 ? <EmptyState>{t("agents.cap.filesystem.empty")}</EmptyState> : null}
      </Card>
    </div>
  );
};

export const AgentDetailPage = ({ agentId }: { agentId: string }): ReactNode => {
  const { data: agent, error, reload } = usePoll<Agent>(`/agents/${agentId}`, 5_000);
  const [tab, setTab] = useState<AgentTab>("setup");
  const [draft, setDraft] = useState<Agent | null>(null);
  const { pending, error: actionError, run } = useAction();
  const t = useT();
  const projectId = agent?.projectId ?? "";
  const { data: siblings } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 15_000);
  const { error: duplicateError, duplicate } = useDuplicateAgent(siblings ?? []);

  if (fatal(error, agent)) {
    return <Page><ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} /></Page>;
  }
  if (!agent) return <Page><EmptyState>{t("common.loading")}</EmptyState></Page>;

  const view = draft ?? agent;
  /** The name the current model and effort imply (R10), offered rather than
   *  applied: the slug is the operator's identifier, and a rename that happened
   *  behind a model change would be a surprise. Null when there is nothing to
   *  offer — the name already is the slug, the model names no short name, or the
   *  role is one whose name never carries a model. */
  /* The exemption is a property of the role, not of the current name: `default`
     renamed by an operator is still the starter Agent whose name names no model,
     and an Agent that merely happens to be called `default` is not. Only these
     two roles are exempt (R10); every other Agent, canonical or not, is offered
     its regenerated slug and may take or refuse it. */
  const nameIsPinned = SLUG_EXEMPT_AGENT_NAMES.includes(agent.canonicalRole ?? agent.name);
  const suggestedSlug = ((): string | null => {
    if (draft === null || nameIsPinned) return null;
    const slug = slugForModel(view.name, view.model);
    return slug === null || slug === view.name ? null : slug;
  })();
  const patch = (changes: Partial<Agent>): void => {
    const next = { ...view, ...changes };
    setDraft({
      ...next,
      codexServiceTier: supportsCodexServiceTier(next.runnerPreference, next.model) ? next.codexServiceTier : "DEFAULT",
    });
  };
  const save = async (): Promise<void> => {
    if (!draft) return;
    const ok = await run(() => api.patch(`/agents/${agentId}`, {
      name: draft.name, title: draft.title, model: modelForSave(draft.model),
      runnerPreference: runnerForModel(draft.model) ?? draft.runnerPreference, inboxAccess: draft.inboxAccess,
      codexServiceTier: draft.codexServiceTier,
      rolePrompt: draft.rolePrompt,
    }));
    if (ok) { setDraft(null); reload(); }
  };
  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to="/agents" className={BACK_LINK}><IconArrowLeft /></Link>
        <span className="text-[var(--status-violet-fg)]"><IconRobot /></span>
        <h1 className={DETAIL_HEAD_H1}>{view.title}</h1>
        <Pill tone="grey"><ModelLabel model={view.model} /></Pill>
        <Pill tone="violet">{t("agents.runnerPill", { runner: t(`runner.preference.${view.runnerPreference}`) })}</Pill>
        {supportsCodexServiceTier(view.runnerPreference, view.model)
          ? <Pill tone={view.codexServiceTier === "FAST" ? "green" : "grey"}>{t(`serviceTier.${view.codexServiceTier}`)}</Pill>
          : null}
        {isMechanicalAgent(view) ? <Pill tone="grey">{t("agents.pill.mechanical")}</Pill> : null}
        <span className="flex-1" />
        {draft === null && !isMechanicalAgent(view)
          ? <Button type="button" variant="legacy" size="legacy" onClick={() => duplicate(agent)}>{t("agents.duplicate.action")}</Button>
          : null}
        {draft === null
          ? <Button type="button" variant="legacy" size="legacy" onClick={() => setDraft(agent)}>{t("common.edit")}</Button>
          : (
            <>
              <Button type="button" variant="legacy" size="legacy" onClick={() => setDraft(null)}>{t("common.cancel")}</Button>
              <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || validateModelPair(view.model, view.runnerPreference) !== null} onClick={() => void save()}>{t("common.save")}</Button>
            </>
          )}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "setup", label: t("agents.tab.setup") },
          { value: "prompt", label: t("agents.tab.prompt") },
          { value: "capabilities", label: t("agents.tab.capabilities") },
          { value: "collaborators", label: t("agents.tab.collaborators") },
        ]}
      />

      <div className={STACK}>
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        {duplicateError === null ? null : <ErrorNotice message={duplicateError} />}

        {tab === "setup" ? (
          <Card title={t("projects.details.title")}>
            {draft === null ? (
              <KeyValue items={[
                { k: t("agents.field.name.label"), v: (
                  /* The slug lives here rather than in the list: it is the name
                     YAML and the CLI use, so it has to be copyable exactly. */
                  <span className={ROW_WRAP}>
                    <span className="[overflow-wrap:anywhere]">{view.name}</span>
                    <Button type="button" variant="legacy" size="legacySmall" className="shadow-none"
                      onClick={() => { void navigator.clipboard?.writeText(view.name); }}>{t("agents.name.copy")}</Button>
                  </span>
                ) },
                { k: t("agents.field.title"), v: view.title },
                ...(view.canonicalRole === null ? [] : [{
                  k: t("agents.canonical.label"),
                  v: view.customizedFields.length === 0
                    ? view.canonicalRole
                    : t("agents.canonical.customized", { role: view.canonicalRole, fields: view.customizedFields.join(", ") }),
                }]),
                { k: t("agents.field.model"), v: <ModelLabel model={view.model} /> },
                { k: t("agents.field.runnerPreference"), v: t(`runner.preference.${view.runnerPreference}`) },
                { k: t("agents.field.codexServiceTier"), v: supportsCodexServiceTier(view.runnerPreference, view.model)
                  ? t(`serviceTier.${view.codexServiceTier}`)
                  : t("agents.serviceTier.unavailableValue") },
                { k: t("agents.field.environment"), v: <span className="text-[11.5px]">{view.environmentId}</span> },
                { k: t("agents.inbox.label"), v: t(view.inboxAccess ? "agents.inbox.on" : "agents.inbox.off") },
                { k: t("common.created"), v: formatDateTime(view.createdAt) },
                { k: t("common.updated"), v: formatDateTime(view.updatedAt) },
              ]} />
            ) : (
              <div className={STACK}>
                <div className={FIELD_ROW}>
                  <Field label={t("agents.field.name.label")}><Input type="text" value={view.name}
                    onChange={(event) => patch({ name: event.target.value })} /></Field>
                  <Field label={t("agents.field.title")}><Input type="text" value={view.title} onChange={(event) => patch({ title: event.target.value })} /></Field>
                </div>
                <ModelPicker model={view.model} runnerPreference={view.runnerPreference} onChange={patch} />
                {suggestedSlug === null ? null : (
                  <div className={ROW_WRAP} data-agent-slug-suggestion={suggestedSlug}>
                    <Button type="button" variant="legacy" size="legacySmall" className="shadow-none"
                      onClick={() => patch({ name: suggestedSlug })}>{t("agents.slug.rename", { slug: suggestedSlug })}</Button>
                    <span className={HINT}>{t("agents.slug.hint")}</span>
                  </div>
                )}
                {view.canonicalRole === null ? null : <div className={HINT}>{t("agents.canonical.hint", { role: view.canonicalRole })}</div>}
                <Field label={t("agents.field.codexServiceTier")} hint={t(supportsCodexServiceTier(view.runnerPreference, view.model)
                  ? "agents.serviceTier.hint"
                  : "agents.serviceTier.unavailable")}>
                  <Select disabled={!supportsCodexServiceTier(view.runnerPreference, view.model)} value={view.codexServiceTier}
                    onChange={(event) => patch({ codexServiceTier: event.target.value as CodexServiceTier })}>
                    <option value="DEFAULT">{t("serviceTier.DEFAULT")}</option>
                    <option value="FAST">{t("serviceTier.FAST")}</option>
                  </Select>
                </Field>
                {/* The platform pins the native children by the *step* the run
                    executes (`nativeImplementationSubagentRunConfig`), so this
                    note follows the canonical role and not a name the operator
                    is free to change. */}
                {(view.canonicalRole ?? view.name) === "plan-executor-astra-medium" ? <div>{t("agents.executioner.outerHint")}</div> : null}
                <div><Link to="/settings" className="text-[var(--accent)] hover:underline">{t("agents.model.settingsHint")}</Link></div>
                <div className={ROW}>
                  <Toggle on={view.inboxAccess} onChange={(next) => patch({ inboxAccess: next })} label={t("agents.inbox.label")} />
                  <div>
                    <div>{t("agents.inbox.label")}</div>
                    <div>{t("agents.inbox.hint.detail")}</div>
                  </div>
                </div>
              </div>
            )}
          </Card>
        ) : null}

        {tab === "prompt" ? (
          <>
            <Card title={t("agents.foundation.title")} extra={(
              <span className={ROW}>
                <span title={t("agents.foundation.revisionTitle")}><Pill tone="grey">{t("agents.foundation.revisionPrefix")} {contentRevision(view.foundationalPrompt)}</Pill></span>
                <Pill tone="grey">{t("agents.foundation.readOnly")}</Pill>
              </span>
            )}>
              <div className={CODE_BLOCK}>{view.foundationalPrompt}</div>
              <div className="mt-2.5">{t("agents.foundation.sitsAbove")}</div>
              <div className="mt-1 text-[11.5px] text-[color:var(--faint)]">{t("agents.foundation.hint")}</div>
              <div className="mt-1 text-[11.5px] text-[color:var(--faint)]">
                {t("agents.foundation.edit")}
              </div>
            </Card>
            <Card title={t("agents.field.rolePrompt")}>
              {draft === null
                ? <div className={CODE_BLOCK}>{view.rolePrompt}</div>
                : <Textarea rows={18} value={view.rolePrompt} onChange={(event) => patch({ rolePrompt: event.target.value })} />}
            </Card>
          </>
        ) : null}

        {tab === "capabilities" ? <CapabilitiesTab agent={agent} projectId={projectId} onSaved={reload} /> : null}

        {tab === "collaborators" ? (
          <Card title={t("agents.tab.collaborators")}>
            <div className="mb-3">{t("agents.collaborators.hint")}</div>
            <div className="mt-3">
              {/* A picker, so the mechanical sentinel is not in it: no Agent may
                  spawn it, and `POST /projects/:id/tasks` refuses it anyway. */}
              {(siblings ?? []).filter((candidate) => candidate.id !== agent.id && !isMechanicalAgent(candidate)).map((candidate) => (
                <div key={candidate.id} className={cn(ROW, "border-t border-[var(--border-soft)] py-2.5")}>
                  <div className="flex-1">
                    <div className="text-foreground"><AgentChip agent={candidate} /></div>
                    <div>{titleCase(candidate.name)}</div>
                  </div>
                  <BindingToggle on={(agent.collaborators ?? []).some((entry) => entry.allowedAgentId === candidate.id)} label={t("agents.collaborators.allow", { name: candidate.name })}
                    add={() => api.post(`/agents/${agent.id}/collaborators`, { allowedAgentId: candidate.id })}
                    remove={() => api.delete(`/agents/${agent.id}/collaborators/${candidate.id}`)} onDone={reload} />
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </Page>
  );
};
