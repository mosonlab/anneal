import { type ReactNode, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { agentOptionLabel } from "../lib/models";
import { fatal } from "../lib/poll-state";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import { cn } from "../lib/utils";
import type {
  Agent, StaffingProfile, StaffingProfileEntryInput, StaffingProfileResponse, StaffingProfileWarning,
  TaskTemplate, TaskTemplateStep,
} from "../lib/types";
import { IconArrowLeft, IconPlus, IconWorkflows } from "../components/icons";
import {
  BACK_LINK, DETAIL_HEAD, DETAIL_HEAD_H1, FIELD_ROW, HINT, PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1,
  PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW, ROW_WRAP, STACK, TABLE_NAME, TABLE_SUB,
  Card, EmptyState, ErrorNotice, Field, InfoNotice, Modal, Page, Pill, Toggle,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

/**
 * Workflows: the task templates of a project, and the staffing profiles that
 * decide who runs each of a template's steps.
 *
 * Three routes, one file, because they are one surface read top to bottom:
 * `/workflows` lists the templates, `/workflows/:templateId` lists that
 * template's profiles, and `/workflows/:templateId/profiles/:profileId` is the
 * editor for one of them. The control plane owns the rules (docs/operator-api.md
 * "Staffing profiles"); this page owns only the draft an operator is holding and
 * the exact `PUT` body it turns into.
 */

/* ------------------------------------------------------------------ shared */

/** An agent an operator may staff a step with. The merge-execution sentinel
 *  answers `assignable: false` and archived agents are refused by the writer,
 *  so neither belongs in the picker. */
export const staffableAgents = (agents: Agent[]): Agent[] =>
  agents.filter((agent) => agent.archivedAt === null && agent.assignable !== false);

/** The name a duplicate takes. A profile name is unique within its template, so
 *  one fixed `"<name> copy"` is a 409 the second time the command is used; this
 *  walks past the copies already made, the way the Agents page does. */
export const availableProfileName = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  let candidate = `${base} 2`;
  for (let ordinal = 3; taken.has(candidate); ordinal += 1) candidate = `${base} ${ordinal}`;
  return candidate;
};

/** The `id` a step's Agent picker carries, so its `<label>` can name it: an
 *  output kind is unique within a template, and the editor renders one. */
const stepControlId = (outputKind: string): string => `staffing-step-${outputKind}`;
const PROFILE_NAME_ID = "staffing-profile-name";
const NEW_PROFILE_NAME_ID = "new-staffing-profile-name";

type DraftEntry = { assigneeAgentId: string; include: boolean };
export const IMPLEMENTATION_TIERS = ["default", "frontend", "hard", "hazard"] as const;
export type ImplementationTier = typeof IMPLEMENTATION_TIERS[number];
export type StaffingTierSlots = Record<ImplementationTier, string | null>;

type Draft = { name: string; entries: Record<string, DraftEntry>; tiers: StaffingTierSlots };

const emptyTierSlots = (): StaffingTierSlots => ({
  default: null,
  frontend: null,
  hard: null,
  hazard: null,
});

/** The profile as the editor holds it: one row per template step, keyed by the
 *  step's own output kind, with the profile's opinion or the empty one. */
export const draftOf = (template: TaskTemplate, profile: StaffingProfile): Draft => ({
  name: profile.name,
  entries: Object.fromEntries(template.steps.map((step) => {
    const held = profile.entries.find((entry) => entry.outputKind === step.outputKind);
    return [step.outputKind, { assigneeAgentId: held?.assigneeAgentId ?? "", include: held?.include ?? true }];
  })),
  tiers: profile.tiers,
});

/**
 * The entry list a save sends.
 *
 * A `PUT` replaces the stored entries whole, so an omitted output kind loses its
 * opinion rather than keeping the previous one — which is exactly what a row the
 * operator left on its canonical binding means. `include` is sent only where the
 * template marks the step optional; anywhere else the writer refuses it.
 */
export const entriesOf = (template: TaskTemplate, draft: Draft): StaffingProfileEntryInput[] =>
  template.steps.flatMap((step) => {
    // Preserve legacy assignments so the writer refuses them visibly. Only an
    // explicit reset may replace them with the canonical null plan.
    const held = draft.entries[step.outputKind];
    const assigneeAgentId = held?.assigneeAgentId ?? "";
    const include = step.optional ? held?.include ?? true : null;
    if (assigneeAgentId === "" && include !== false) return [];
    return [{
      outputKind: step.outputKind,
      assigneeAgentId: assigneeAgentId === "" ? null : assigneeAgentId,
      include,
    }];
  });

const tiersOf = (draft: Draft): StaffingTierSlots => ({
  default: draft.tiers.default,
  frontend: draft.tiers.frontend,
  hard: draft.tiers.hard,
  hazard: draft.tiers.hazard,
});

const seedOf = (profile: StaffingProfile): string =>
  JSON.stringify({ name: profile.name, entries: profile.entries, tiers: profile.tiers });

/* ------------------------------------------------------------ template list */

/** The rows the list may render. A read that landed with something else is a
 *  failure the operator must see: rendering the readable part of an unknown
 *  shape would silently claim the project has fewer templates than it has. */
// The list does not consume the nested agent payload; leave it unknown instead
// of claiming this boundary validates the detail page's full Agent contract.
type ListedTemplate = Omit<TaskTemplate, "steps"> & {
  steps: (Omit<TaskTemplateStep, "assigneeAgent"> & { assigneeAgent: unknown })[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isListedStep = (value: unknown): value is ListedTemplate["steps"][number] =>
  isRecord(value)
  && ["id", "name", "prompt", "outputKind"].every((key) => typeof value[key] === "string")
  && Number.isInteger(value.stepIndex)
  && (value.assigneeType === "AGENT" || value.assigneeType === "HUMAN")
  && typeof value.approvalGate === "boolean"
  && typeof value.optional === "boolean"
  && isStrings(value.priorOutputKinds)
  && (value.baseFromStepIndex === null || Number.isInteger(value.baseFromStepIndex))
  && (value.runner === null || value.runner === "CLAUDE" || value.runner === "CODEX" || value.runner === "PI")
  && (value.assigneeAgentId === null || typeof value.assigneeAgentId === "string")
  && (value.assigneeAgent === null || isRecord(value.assigneeAgent))
  // Who runs a step is the API's answer, never a guess from its kind or name,
  // so a row without it is a shape the console cannot staff from.
  && (value.executionOwner === "agent" || value.executionOwner === "human"
    || value.executionOwner === "control-plane" || value.executionOwner === "merge-executor");
const isTemplateList = (value: unknown): value is ListedTemplate[] =>
  Array.isArray(value) && value.every((row: unknown) =>
    isRecord(row)
    && typeof row.id === "string"
    && typeof row.projectId === "string"
    && typeof row.name === "string"
    && typeof row.description === "string"
    && typeof row.retired === "boolean"
    && isStrings(row.variables)
    && Array.isArray(row.steps) && row.steps.every(isListedStep));

/** Current templates first and by name, retired generations after them in the
 *  order the control plane listed them. Retirement is the API's `retired`
 *  field and never a guess from the name: the console does not own that rule. */
const partitionTemplates = (templates: ListedTemplate[]): { current: ListedTemplate[]; retired: ListedTemplate[] } => ({
  current: templates.filter((template) => !template.retired)
    .sort((left, right) => left.name.localeCompare(right.name)),
  retired: templates.filter((template) => template.retired),
});

const TemplateRow = ({ template }: { template: ListedTemplate }): ReactNode => {
  const t = useT();
  return (
    <TableRow data-template-row={template.id} className="cursor-pointer" onClick={(event) => {
      if (!event.defaultPrevented) navigate(`/workflows/${template.id}`);
    }}>
      <TableCell className={TABLE_NAME}>
        <Link to={`/workflows/${template.id}`}>{template.name}</Link>
        <span className={cn(TABLE_SUB, "block max-w-[420px] overflow-hidden text-ellipsis")}>{template.description}</span>
      </TableCell>
      <TableCell>{t("workflows.template.steps", { n: template.steps.length })}</TableCell>
    </TableRow>
  );
};

export const WorkflowsPage = (): ReactNode => {
  const { projectId } = useProjectScope();
  const { data, loading, error, reload, lastSuccessAt } = usePoll<unknown>(
    projectId === "" ? null : `/projects/${projectId}/task-templates`, 30_000,
  );
  /* Collapsed on every visit by design: the group is history, and the three
     canonical chains are what an operator came for. */
  const [showRetired, setShowRetired] = useState(false);
  const t = useT();

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;
  const valid = isTemplateList(data);
  const malformed = lastSuccessAt !== null && !valid;
  const { current, retired } = partitionTemplates(valid ? data : []);

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("workflows.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("workflows.head.subtitle")}</div>
        </div>
      </div>

      <div className={STACK}>
        {fatal(error, data) ? <ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} /> : null}
        {malformed ? <ErrorNotice message={t("workflows.error.shape")} onRetry={reload} /> : null}
        {malformed ? null : (
          <Card flush>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("workflows.table.template")}</TableHead>
                  <TableHead>{t("workflows.table.steps")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {current.map((template) => <TemplateRow key={template.id} template={template} />)}
                {retired.length === 0 ? null : (
                  <TableRow>
                    <TableCell colSpan={2} className="p-0">
                      <button type="button" data-retired-toggle aria-expanded={showRetired}
                        className="w-full px-[14px] py-[10px] text-left text-[color:var(--muted)] hover:text-foreground"
                        onClick={() => setShowRetired(!showRetired)}>
                        {t("workflows.retired.group", { n: retired.length })}
                      </button>
                    </TableCell>
                  </TableRow>
                )}
                {showRetired ? retired.map((template) => <TemplateRow key={template.id} template={template} />) : null}
              </TableBody>
            </Table>
            {current.length === 0 && retired.length === 0 ? (
              <EmptyState>
                <span className="mb-[10px] inline-flex text-[color:var(--faint)]"><IconWorkflows /></span>
                <div>{t(loading ? "common.loading" : "workflows.templates.empty")}</div>
              </EmptyState>
            ) : null}
          </Card>
        )}
      </div>
    </Page>
  );
};

/* ------------------------------------------------------------- profile list */

const NewProfile = ({ onClose, onCreate, pending }: {
  onClose: () => void;
  onCreate: (name: string) => void;
  pending: boolean;
}): ReactNode => {
  const [name, setName] = useState("");
  const t = useT();
  return (
    <Modal title={t("workflows.profiles.create")} onClose={onClose} footer={
      <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || name.trim() === ""}
        onClick={() => onCreate(name.trim())}>
        {t("workflows.profiles.create")}
      </Button>
    }>
      <Field label={t("workflows.profile.name")} htmlFor={NEW_PROFILE_NAME_ID}>
        <Input id={NEW_PROFILE_NAME_ID} type="text" value={name} autoFocus onChange={(event) => setName(event.target.value)}
          placeholder={t("workflows.profile.name.placeholder")} />
      </Field>
    </Modal>
  );
};

/** One profile in the list, with the four whole-profile commands. Delete is a
 *  disabled button rather than a hidden one when the profile is the default and
 *  the template has others: the control plane answers 409 there, and an operator
 *  needs to see why the command is unavailable. */
export const ProfileCard = ({ templateId, profile, undeletable, pending, onSetDefault, onDuplicate, onReset, onDelete }: {
  templateId: string;
  profile: StaffingProfile;
  undeletable: boolean;
  pending: boolean;
  onSetDefault: () => void;
  onDuplicate: () => void;
  onReset: () => void;
  onDelete: () => void;
}): ReactNode => {
  const t = useT();
  return (
    <Card>
      <div className={cn(STACK, "gap-[12px]")}>
        <div className={ROW_WRAP}>
          <Link to={`/workflows/${templateId}/profiles/${profile.id}`} className={TABLE_NAME}>{profile.name}</Link>
          {profile.isDefault ? <Pill tone="green">{t("workflows.profile.default")}</Pill> : null}
          <span className={HINT}>{t("workflows.profile.entries", { n: profile.entries.length })}</span>
          <span className={HINT}>{formatDate(profile.updatedAt)}</span>
        </div>
        <div className={ROW_WRAP}>
          <Button type="button" variant="legacy" size="legacySmall" disabled={pending || profile.isDefault} onClick={onSetDefault}>
            {t("workflows.profile.setDefault")}
          </Button>
          <Button type="button" variant="legacy" size="legacySmall" disabled={pending} onClick={onDuplicate}>
            {t("workflows.profile.duplicate")}
          </Button>
          <Button type="button" variant="legacy" size="legacySmall" disabled={pending} onClick={onReset}>
            {t("workflows.profile.reset")}
          </Button>
          <Button type="button" variant="legacy" size="legacySmall" disabled={pending || undeletable}
            title={undeletable ? t("workflows.profile.delete.refused") : undefined} onClick={onDelete}>
            {t("common.delete")}
          </Button>
        </div>
        {undeletable ? <div className={HINT}>{t("workflows.profile.delete.refused")}</div> : null}
      </div>
    </Card>
  );
};

export const WorkflowDetailPage = ({ templateId }: { templateId: string }): ReactNode => {
  const { projectId } = useProjectScope();
  const templates = usePoll<TaskTemplate[]>(projectId === "" ? null : `/projects/${projectId}/task-templates`, 30_000);
  const profilesPath = projectId === "" ? null : `/projects/${projectId}/task-templates/${templateId}/staffing-profiles`;
  const profiles = usePoll<StaffingProfile[]>(profilesPath, 10_000);
  const { pending, error: actionError, run } = useAction();
  const [creating, setCreating] = useState(false);
  const t = useT();

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  const template = (templates.data ?? []).find((candidate) => candidate.id === templateId) ?? null;
  const held = profiles.data ?? [];
  const profilesFailed = fatal(profiles.error, profiles.data);

  const create = (name: string): void => {
    void run(async () => {
      const created = await api.post<StaffingProfileResponse>(profilesPath!, {
        name,
        entries: [],
        tiers: emptyTierSlots(),
      });
      setCreating(false);
      profiles.reload();
      navigate(`/workflows/${templateId}/profiles/${created.profile.id}`);
    });
  };
  const duplicate = (profile: StaffingProfile): void => {
    void run(async () => {
      await api.post<StaffingProfileResponse>(profilesPath!, {
        name: availableProfileName(
          t("workflows.profile.copyName", { name: profile.name }),
          new Set(held.map((candidate) => candidate.name)),
        ),
        entries: profile.entries,
        tiers: profile.tiers,
      });
      profiles.reload();
    });
  };
  const setDefault = (profile: StaffingProfile): void => {
    void run(async () => { await api.patch(`/staffing-profiles/${profile.id}`, { isDefault: true }); profiles.reload(); });
  };
  const reset = (profile: StaffingProfile): void => {
    void run(async () => { await api.post(`/staffing-profiles/${profile.id}/reset`); profiles.reload(); });
  };
  const remove = (profile: StaffingProfile): void => {
    if (!window.confirm(t("workflows.profile.confirmDelete", { name: profile.name }))) return;
    void run(async () => { await api.delete(`/staffing-profiles/${profile.id}`); profiles.reload(); });
  };

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to="/workflows" className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{template?.name ?? t("common.loading")}</h1>
        <span className="flex-1" />
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacyPrimary" size="legacy" onClick={() => setCreating(true)}>
            <IconPlus />{t("workflows.profiles.create")}
          </Button>
        </div>
      </div>

      <div className={STACK}>
        {profilesFailed
          ? <ErrorNotice message={t("workflows.error.profiles", { reason: `${profiles.error!.status} ${profiles.error!.message}` })}
              onRetry={profiles.reload} />
          : null}
        {fatal(templates.error, templates.data)
          ? <ErrorNotice message={t("workflows.error.templates", { reason: `${templates.error!.status} ${templates.error!.message}` })}
              onRetry={templates.reload} />
          : null}
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        {/* Three states, not two. A failed read knows of no profile and an
            unfinished one knows of none yet; neither is the template that has
            none, and only the last of them may claim instantiation falls back to
            the canonical bindings. */}
        {profilesFailed ? null : held.length === 0 ? (
          <Card>
            <EmptyState>
              {profiles.data === null ? <div>{t("common.loading")}</div> : (
                <>
                  <div>{t("workflows.profiles.empty")}</div>
                  <div className={cn(HINT, "mt-[6px]")}>{t("workflows.profiles.empty.hint")}</div>
                </>
              )}
            </EmptyState>
          </Card>
        ) : held.map((profile) => (
          <ProfileCard key={profile.id} templateId={templateId} profile={profile} pending={pending}
            undeletable={profile.isDefault && held.length > 1}
            onSetDefault={() => setDefault(profile)} onDuplicate={() => duplicate(profile)}
            onReset={() => reset(profile)} onDelete={() => remove(profile)} />
        ))}
      </div>

      {creating ? <NewProfile pending={pending} onClose={() => setCreating(false)} onCreate={create} /> : null}
    </Page>
  );
};

/* ------------------------------------------------------------------ editor */

const StepRow = ({ step, agents, entry, onChange }: {
  step: TaskTemplateStep;
  agents: Agent[];
  entry: DraftEntry;
  onChange: (next: DraftEntry) => void;
}): ReactNode => {
  const t = useT();
  const canonical = step.assigneeAgent === null
    ? t("workflows.editor.canonical.none")
    : t("workflows.editor.canonical", { name: step.assigneeAgent.title });
  return (
    <div data-output-kind={step.outputKind} className="border-t border-[color:var(--border-soft)] py-[14px] first:border-t-0 first:pt-0">
      <div className={cn(ROW_WRAP, "mb-[10px]")}>
        <span className="text-foreground">{step.name}</span>
        <span className={HINT}>{t("workflows.editor.step", { index: step.stepIndex, kind: step.outputKind })}</span>
        {step.optional ? <Pill tone="grey">{t("workflows.editor.optional")}</Pill> : null}
      </div>
      {step.executionOwner === "control-plane" ? (
        <div className={HINT}>{t("workflows.editor.controlPlane")}</div>
      ) : step.assigneeType === "AGENT" ? (
        <div className={FIELD_ROW}>
          <Field label={t("workflows.editor.agent")} htmlFor={stepControlId(step.outputKind)}>
            <Select id={stepControlId(step.outputKind)} value={entry.assigneeAgentId}
              onChange={(event) => onChange({ ...entry, assigneeAgentId: event.target.value })}>
              <option value="">{canonical}</option>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agentOptionLabel(agent)}</option>)}
            </Select>
          </Field>
          {step.optional ? (
            <div className={cn(ROW, "pt-[22px]")}>
              <Toggle on={entry.include} onChange={(next) => onChange({ ...entry, include: next })}
                label={t("workflows.editor.include.aria", { name: step.name })} />
              <div>
                <div>{t("workflows.editor.include")}</div>
                <div className={HINT}>{t("workflows.editor.include.hint")}</div>
              </div>
            </div>
          ) : null}
        </div>
      ) : <div className={HINT}>{t("workflows.editor.human")}</div>}
    </div>
  );
};

const tierLabelKeys: Record<ImplementationTier, string> = {
  default: "workflows.editor.tier.default",
  frontend: "workflows.editor.tier.frontend",
  hard: "workflows.editor.tier.hard",
  hazard: "workflows.editor.tier.hazard",
};

const tierControlId = (tier: ImplementationTier): string => `staffing-tier-${tier}`;

const TierSlots = ({ slots, agents, onChange }: {
  slots: StaffingTierSlots;
  agents: Agent[];
  onChange: (tier: ImplementationTier, agentId: string | null) => void;
}): ReactNode => {
  const t = useT();
  return (
    <section data-tier-slots className="min-w-0 rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--surface-input)] p-[14px]">
      <div className="mb-[5px] text-[13px] text-foreground">{t("workflows.editor.tiers.title")}</div>
      <div className={cn(HINT, "mb-[14px]")}>{t("workflows.editor.tiers.hint")}</div>
      <div className="grid gap-[12px]">
        {IMPLEMENTATION_TIERS.map((tier) => (
          <Field key={tier} label={t(tierLabelKeys[tier])} htmlFor={tierControlId(tier)}>
            <Select
              id={tierControlId(tier)}
              data-implementation-tier={tier}
              value={slots[tier] ?? ""}
              onChange={(event) => onChange(tier, event.target.value === "" ? null : event.target.value)}
            >
              <option value="">{t("workflows.editor.tier.empty")}</option>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agentOptionLabel(agent)}</option>)}
            </Select>
          </Field>
        ))}
      </div>
    </section>
  );
};

/**
 * The editor's draft is local and reseeds from the poll only while no write is
 * in flight, the way `AgentToolsCard` does: a 10-second poll landing mid-edit
 * would otherwise throw away whatever the operator had typed since it started.
 */
export const StaffingProfileEditor = ({ template, profile, agents, onSaved }: {
  template: TaskTemplate;
  profile: StaffingProfile;
  agents: Agent[];
  onSaved: () => void;
}): ReactNode => {
  const incoming = seedOf(profile);
  const lastSeed = useRef(incoming);
  const [draft, setDraft] = useState<Draft>(() => draftOf(template, profile));
  const [warnings, setWarnings] = useState<StaffingProfileWarning[]>([]);
  const { pending, error, run } = useAction();
  const t = useT();
  const staffable = staffableAgents(agents);

  useEffect(() => {
    if (pending || incoming === lastSeed.current) return;
    lastSeed.current = incoming;
    setDraft(draftOf(template, profile));
  }, [incoming, pending, profile, template]);

  const save = (): void => {
    void run(async () => {
      const answer = await api.put<StaffingProfileResponse>(`/staffing-profiles/${profile.id}`, {
        name: draft.name.trim(),
        entries: entriesOf(template, draft),
        tiers: tiersOf(draft),
      });
      setWarnings(answer.warnings);
      onSaved();
    });
  };

  return (
    <div className={STACK}>
      {error === null ? null : <ErrorNotice message={error} />}
      {warnings.map((warning) => <InfoNotice key={warning.code} message={warning.message} />)}

      <Card title={t("workflows.editor.title")} extra={
        <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || draft.name.trim() === ""} onClick={save}>
          {t("workflows.editor.save")}
        </Button>
      }>
        <div className={cn(STACK, "mb-[16px]")}>
          <Field label={t("workflows.profile.name")} htmlFor={PROFILE_NAME_ID}>
            <Input id={PROFILE_NAME_ID} type="text" value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
        </div>
        <div className="grid items-start gap-[24px] [@media(min-width:901px)]:grid-cols-[minmax(210px,280px)_minmax(0,1fr)]">
          <TierSlots slots={draft.tiers} agents={staffable}
            onChange={(tier, agentId) => setDraft({ ...draft, tiers: { ...draft.tiers, [tier]: agentId } })} />
          <div>
            {template.steps.map((step) => (
              <StepRow key={step.outputKind} step={step} agents={staffable}
                entry={draft.entries[step.outputKind] ?? { assigneeAgentId: "", include: true }}
                onChange={(next) => setDraft({ ...draft, entries: { ...draft.entries, [step.outputKind]: next } })} />
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
};

export const StaffingProfilePage = ({ templateId, profileId }: { templateId: string; profileId: string }): ReactNode => {
  const { projectId } = useProjectScope();
  const templates = usePoll<TaskTemplate[]>(projectId === "" ? null : `/projects/${projectId}/task-templates`, 30_000);
  const profilesPath = projectId === "" ? null : `/projects/${projectId}/task-templates/${templateId}/staffing-profiles`;
  const profiles = usePoll<StaffingProfile[]>(profilesPath, 10_000);
  const agents = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 30_000);
  const t = useT();

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  const template = (templates.data ?? []).find((candidate) => candidate.id === templateId) ?? null;
  const profile = (profiles.data ?? []).find((candidate) => candidate.id === profileId) ?? null;

  if (fatal(profiles.error, profiles.data)) {
    return (
      <Page>
        <ErrorNotice message={t("workflows.error.profiles", { reason: `${profiles.error!.status} ${profiles.error!.message}` })}
          onRetry={profiles.reload} />
      </Page>
    );
  }
  if (fatal(templates.error, templates.data)) {
    return (
      <Page>
        <ErrorNotice message={t("workflows.error.templates", { reason: `${templates.error!.status} ${templates.error!.message}` })}
          onRetry={templates.reload} />
      </Page>
    );
  }
  /* A read that landed and does not carry this row is an answer, not a wait: the
     profile was deleted from another window, or the link is stale. Holding
     "Loading" forever would tell the operator to keep waiting for it. */
  if (profiles.data !== null && profile === null) {
    return <Page><ErrorNotice message={t("workflows.profile.missing")} onRetry={profiles.reload} /></Page>;
  }
  if (templates.data !== null && template === null) {
    return <Page><ErrorNotice message={t("workflows.template.missing")} onRetry={templates.reload} /></Page>;
  }
  if (template === null || profile === null) return <Page><EmptyState>{t("common.loading")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to={`/workflows/${templateId}`} className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{profile.name}</h1>
        {profile.isDefault ? <Pill tone="green">{t("workflows.profile.default")}</Pill> : null}
        <span className={HINT}>{template.name}</span>
      </div>
      {/* An unread roster renders an empty picker, which reads exactly like a
          project with no agents; the failure says so instead. */}
      {agents.error === null ? null : (
        <ErrorNotice message={t("workflows.error.agents", { reason: `${agents.error.status} ${agents.error.message}` })}
          onRetry={agents.reload} />
      )}
      <StaffingProfileEditor template={template} profile={profile} agents={agents.data ?? []} onSaved={profiles.reload} />
    </Page>
  );
};
