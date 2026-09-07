/**
 * Staffing profiles: named, per-template plans for who runs each step and
 * which optional steps a chain keeps.
 *
 * A profile is an opinion layered over a template graph, never a copy of it.
 * Entries key on the step's *exact* `outputKind`, because that is the only key
 * that survives step reordering and still distinguishes `foo` from `foo-v2` in
 * a custom graph. A step the profile does not name keeps its canonical binding,
 * so a template with no profile at all instantiates exactly as it did before
 * profiles existed.
 *
 * Every write takes the Agent-row mutex (`lockAgentRows`) that archive and
 * instantiation take, after the template row. This keeps the identity and
 * lifecycle checks ordered with other writers; a later archive is handled by
 * the merge-tail fallback for the repair slot.
 */

import {
  AssigneeType,
  CANONICAL_STAFFING_TIER_ROLES,
  catalogRunnerForModel,
  canonicalMergeTailRepairAgentRole,
  canonicalStaffingEntries,
  CANONICAL_STAFFING_PROFILE_NAME,
  findCanonicalAgent,
  integratorBindingRefusal,
  isCompoundImplementationStep,
  lockAgentRepoGrant,
  lockAgentRows,
  lockTemplateRow,
  Prisma,
  RunnerKind,
  RunnerPreference,
  STAFFING_PROFILE_TIERS,
  runnerFor,
  stepRole,
  type PrismaClient,
} from "@anneal/db";
import type {
  StaffingProfile as StaffingProfileContract,
  StaffingProfileEntry as StaffingProfileEntryContract,
  StaffingProfileTier,
  StaffingProfileTiers,
  StaffingProfileTiersInput,
  StaffingProfileWarning,
} from "@anneal/db/console-contract";

import { templateStepExecutionOwner } from "./chain-execution-owner.js";
import { StaffingProfileRefusal } from "./staffing-profile-errors.js";
import { serializable } from "./transaction.js";

type Tx = Prisma.TransactionClient;

/** The name a bootstrap- or clone-installed profile is created under. */
export const DEFAULT_STAFFING_PROFILE_NAME = CANONICAL_STAFFING_PROFILE_NAME;
export { canonicalStaffingEntries } from "@anneal/db";

export type StaffingProfileEntryInput = {
  outputKind: string;
  assigneeAgentId?: string | null | undefined;
  include?: boolean | null | undefined;
};

export type CreateStaffingProfileInput = {
  name: string;
  entries: StaffingProfileEntryInput[];
  tiers?: StaffingProfileTiersInput | undefined;
  isDefault?: boolean | undefined;
  mergeTailRepairAgentId?: string | null | undefined;
  repoId?: string | undefined;
};

export type ReplaceStaffingProfileInput = {
  name: string;
  entries: StaffingProfileEntryInput[];
  tiers?: StaffingProfileTiersInput | undefined;
  mergeTailRepairAgentId?: string | null | undefined;
  repoId?: string | undefined;
};

export type StaffingProfileResult = {
  profile: StaffingProfileContract<Date>;
  warnings: StaffingProfileWarning[];
};

const refuse = (
  code: ConstructorParameters<typeof StaffingProfileRefusal>[0],
  message: string,
  outputKind?: string,
): StaffingProfileRefusal => new StaffingProfileRefusal(code, message, outputKind);

const profileSelect = {
  id: true,
  projectId: true,
  taskTemplateId: true,
  name: true,
  isDefault: true,
  mergeTailRepairAgentId: true,
  createdAt: true,
  updatedAt: true,
  entries: {
    select: { outputKind: true, assigneeAgentId: true, include: true },
    orderBy: { outputKind: "asc" },
  },
  tiers: {
    select: { tier: true, agentId: true },
    orderBy: { tier: "asc" },
  },
} as const satisfies Prisma.StaffingProfileSelect;

type ProfileTierRow = { tier: string; agentId: string };
type ProfileQueryRow = Prisma.StaffingProfileGetPayload<{ select: typeof profileSelect }>;

const emptyTierSlots = (): StaffingProfileTiers => ({
  default: null,
  frontend: null,
  hard: null,
  hazard: null,
});

const tierSlotsFromRows = (rows: readonly ProfileTierRow[]): StaffingProfileTiers => {
  const slots = emptyTierSlots();
  for (const row of rows) {
    if ((STAFFING_PROFILE_TIERS as readonly string[]).includes(row.tier)) {
      slots[row.tier as StaffingProfileTier] = row.agentId;
    }
  }
  return slots;
};

const profileContract = (row: ProfileQueryRow): StaffingProfileContract<Date> => ({
  id: row.id,
  projectId: row.projectId,
  taskTemplateId: row.taskTemplateId,
  name: row.name,
  isDefault: row.isDefault,
  mergeTailRepairAgentId: row.mergeTailRepairAgentId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  entries: row.entries,
  tiers: tierSlotsFromRows(row.tiers),
});

const readProfile = async (tx: Tx, profileId: string): Promise<StaffingProfileContract<Date>> => {
  const row = await tx.staffingProfile.findUniqueOrThrow({ where: { id: profileId }, select: profileSelect });
  return profileContract(row);
};

/**
 * Validate the profile-level repair slot with the same ownership and lifecycle
 * rules as an entry. Repository access is checked against an explicit or
 * unambiguous repository context when a new slot is written; a profile has no
 * repository of its own and may serve chains instantiated against different
 * Repos.
 */
export const mergeTailRepairAgentRefusal = (
  agentId: string | null,
  agents: ReadonlyMap<string, ValidationAgent>,
  context: { projectId: string },
): StaffingProfileRefusal | null => {
  if (agentId === null) return null;
  const agent = agents.get(agentId);
  if (!agent || agent.projectId !== context.projectId) {
    return refuse(
      "staffing_profile_agent_not_found",
      `Merge-tail repair Agent ${agentId} was not found in this project`,
    );
  }
  if (agent.archivedAt !== null) {
    return refuse(
      "staffing_profile_agent_archived",
      `Merge-tail repair Agent ${agent.name} is archived`,
    );
  }
  const bindingRefusal = integratorBindingRefusal(agent.name, null);
  if (bindingRefusal) return refuse("staffing_profile_integrator_binding", bindingRefusal);
  return null;
};

const validateMergeTailRepairAgent = (
  agentId: string | null,
  agents: ReadonlyMap<string, ValidationAgent>,
  context: { projectId: string },
): void => {
  const refusal = mergeTailRepairAgentRefusal(agentId, agents, context);
  if (refusal) throw refusal;
};

type ProfileRepo = { id: string; name: string };

/** Resolve the repository against which a profile-level repair slot is saved.
 * A profile has no repository of its own: an explicit context wins, then a
 * template webhook Repo, then the only Repo in the project. Multiple or zero
 * candidates are refused so a write cannot claim a grant was checked against
 * an arbitrary Repo. */
const profileRepoFor = async (
  tx: Tx,
  input: { projectId: string; taskTemplateId: string; repoId?: string },
): Promise<ProfileRepo> => {
  if (input.repoId !== undefined) {
    const repo = await tx.repo.findFirst({
      where: { id: input.repoId, projectId: input.projectId },
      select: { id: true, name: true },
    });
    if (!repo) {
      throw refuse(
        "staffing_profile_repo_not_found",
        `Repo ${input.repoId} is not in project ${input.projectId}`,
      );
    }
    return repo;
  }

  const template = await tx.taskTemplate.findUnique({
    where: { id: input.taskTemplateId },
    select: { webhookRepoId: true },
  });
  if (template?.webhookRepoId !== null && template?.webhookRepoId !== undefined) {
    const repo = await tx.repo.findFirst({
      where: { id: template.webhookRepoId, projectId: input.projectId },
      select: { id: true, name: true },
    });
    if (!repo) {
      throw refuse(
        "staffing_profile_repo_not_found",
        `Template ${input.taskTemplateId} webhook Repo ${template.webhookRepoId} is not in project ${input.projectId}`,
      );
    }
    return repo;
  }

  const repos = await tx.repo.findMany({
    where: { projectId: input.projectId },
    orderBy: { id: "asc" },
    select: { id: true, name: true },
  });
  if (repos.length === 1) return repos[0]!;
  throw refuse(
    "staffing_profile_repo_required",
    repos.length === 0
      ? `Project ${input.projectId} has no Repo to validate the merge-tail repair Agent grant against`
      : `Project ${input.projectId} has multiple Repos; supply repoId to validate the merge-tail repair Agent grant`,
  );
};

const validateMergeTailRepairGrant = async (
  tx: Tx,
  agentId: string,
  repo: ProfileRepo,
  projectId: string,
): Promise<void> => {
  if (!await lockAgentRepoGrant(tx, { projectId, agentId, repoId: repo.id })) {
    throw refuse(
      "staffing_profile_missing_repo_grant",
      `Merge-tail repair Agent ${agentId} has no grant for Repo ${repo.name}`,
    );
  }
};

/** Explicit writes are strict; reset can restore entries despite unavailable defaults. */
const resolveRepairSlot = async (
  tx: Tx,
  input: {
    projectId: string; taskTemplateId: string; agentId: string | null;
    repoId: string | undefined; agents: ReadonlyMap<string, ValidationAgent>;
    resetWarnings?: StaffingProfileWarning[];
  },
): Promise<string | null> => {
  try {
    validateMergeTailRepairAgent(input.agentId, input.agents, input);
  } catch (error) {
    if (!input.resetWarnings || !(error instanceof StaffingProfileRefusal)
      || !["staffing_profile_agent_not_found", "staffing_profile_agent_archived"].includes(error.code)) throw error;
    input.resetWarnings.push({ code: "merge_tail_repair_agent_unavailable",
      message: `${error.message}; reset leaves the repair slot empty` });
    return null;
  }
  if (input.agentId === null) return null;
  let repo: ProfileRepo;
  try {
    repo = await profileRepoFor(tx, {
      projectId: input.projectId, taskTemplateId: input.taskTemplateId,
      ...(input.repoId === undefined ? {} : { repoId: input.repoId }),
    });
  } catch (error) {
    if (!input.resetWarnings || !(error instanceof StaffingProfileRefusal)
      || error.code !== "staffing_profile_repo_required") throw error;
    input.resetWarnings.push({ code: "merge_tail_repair_repo_unresolved",
      message: `${error.message}; reset restored the canonical slot without checking its Repo grant` });
    return input.agentId;
  }
  await validateMergeTailRepairGrant(tx, input.agentId, repo, input.projectId);
  return input.agentId;
};

/** The template graph facts a profile is validated against. */
type ValidationStep = {
  stepIndex: number;
  name: string;
  outputKind: string;
  optional: boolean;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  runner: RunnerKind | null;
};

type ValidationAgent = {
  id: string;
  name: string;
  projectId: string;
  archivedAt: Date | null;
  model: string;
  runnerPreference: RunnerPreference;
};

/**
 * R14 as a capability predicate rather than a name: the compound
 * implementation root is the one step whose subprocess protocol only the Codex
 * CLI speaks, so what it requires of an assignee is a Codex runner and a
 * `gpt-*` model — not one particular agent slug.
 */
export const compoundImplementationCapable = (
  agent: Pick<ValidationAgent, "model" | "runnerPreference">,
  step: Pick<ValidationStep, "runner">,
): boolean => {
  const runner = step.runner ?? runnerFor(agent.runnerPreference, agent.model);
  return runner === RunnerKind.CODEX && catalogRunnerForModel(agent.model) === RunnerPreference.CODEX;
};

/**
 * Whether the control plane, rather than any Agent, executes this step. The
 * same predicate the read routes answer `executionOwner: "control-plane"` from,
 * so the console and the writer cannot disagree about which rows are staffable.
 */
const isControlPlaneStep = (step: Pick<ValidationStep, "stepIndex" | "outputKind" | "assigneeType">): boolean =>
  templateStepExecutionOwner(step) === "control-plane";

/**
 * Whether one step may be staffed by one Agent, and why not.
 *
 * Stated once because two callers ask it: a profile write, which refuses, and
 * the step-graph replacement sweep, which drops the opinion the new graph
 * invalidated. `null` assignee means the profile states no opinion and the
 * step's own binding stands, which is always allowed.
 */
export const staffingAssigneeRefusal = (
  assigneeAgentId: string | null,
  step: ValidationStep,
  agents: ReadonlyMap<string, ValidationAgent>,
  context: { projectId: string; templateName: string },
): StaffingProfileRefusal | null => {
  if (assigneeAgentId === null) return null;
  // The control plane executes this step; its row binds an Agent only because a
  // task row needs an assignee, and staffing it would change nothing. Refused
  // rather than ignored, so an operator who saved one learns of it here instead
  // of going on believing that Agent runs the step. A null entry stays allowed:
  // it states no opinion, and the row's own binding stands either way.
  if (isControlPlaneStep(step)) {
    return refuse(
      "staffing_profile_step_control_plane",
      `Step ${step.name} (${step.outputKind}) is executed by the control plane and staffs no agent; remove its entry from this profile`,
      step.outputKind,
    );
  }
  if (step.assigneeType !== AssigneeType.AGENT) {
    return refuse(
      "staffing_profile_step_not_agent",
      `Step ${step.name} (${step.outputKind}) has assigneeType ${step.assigneeType}; only AGENT steps may be staffed`,
      step.outputKind,
    );
  }
  const agent = agents.get(assigneeAgentId);
  if (!agent || agent.projectId !== context.projectId) {
    return refuse(
      "staffing_profile_agent_not_found",
      `Agent ${assigneeAgentId} for output kind ${step.outputKind} was not found in this project`,
      step.outputKind,
    );
  }
  if (agent.archivedAt !== null) {
    return refuse(
      "staffing_profile_agent_archived",
      `Agent ${agent.name} for output kind ${step.outputKind} is archived`,
      step.outputKind,
    );
  }
  // Two-sided, as the platform predicate defines it: the sentinel binds
  // only a merge-execution step, and a merge-execution step binds only the
  // sentinel. Checked for every step the profile takes responsibility for,
  // so neither half can be introduced one entry at a time.
  const bindingRefusal = integratorBindingRefusal(agent.name, {
    stepIndex: step.stepIndex,
    outputKind: step.outputKind,
    taskTemplateName: context.templateName,
  });
  if (bindingRefusal) {
    return refuse(
      "staffing_profile_integrator_binding",
      `Step ${step.name} (${step.outputKind}): ${bindingRefusal}`,
      step.outputKind,
    );
  }
  const compoundRoot = isCompoundImplementationStep({
    stepIndex: step.stepIndex,
    outputKind: step.outputKind,
    taskTemplate: { name: context.templateName },
  });
  if (compoundRoot && !compoundImplementationCapable(agent, step)) {
    return refuse(
      "staffing_profile_compound_implementation",
      `Step ${step.name} (${step.outputKind}) is the compound implementation root and requires a Codex runner with a gpt-* model; ${agent.name} runs ${agent.model}`,
      step.outputKind,
    );
  }
  return null;
};

/**
 * Validate one profile's entries against a template graph and the Agent rows
 * already read under the Agent mutex. Pure: it opens no transaction and reads
 * nothing, so the caller decides what is locked before it runs.
 *
 * The first failing rule is the only refusal, in the fixed order below.
 */
export const validateStaffingEntries = (
  entries: readonly StaffingProfileEntryInput[],
  steps: readonly ValidationStep[],
  agents: ReadonlyMap<string, ValidationAgent>,
  context: { projectId: string; templateName: string },
): { entries: StaffingProfileEntryContract[]; warnings: StaffingProfileWarning[] } => {
  const stepsByKind = new Map(steps.map((step) => [step.outputKind, step]));
  const seen = new Set<string>();
  const normalized: StaffingProfileEntryContract[] = [];

  for (const entry of entries) {
    if (seen.has(entry.outputKind)) {
      throw refuse(
        "staffing_profile_entry_duplicate",
        `Staffing profile names output kind ${entry.outputKind} more than once`,
        entry.outputKind,
      );
    }
    seen.add(entry.outputKind);

    const step = stepsByKind.get(entry.outputKind);
    if (!step) {
      throw refuse(
        "staffing_profile_unknown_output_kind",
        `Template ${context.templateName} has no step producing output kind ${entry.outputKind}`,
        entry.outputKind,
      );
    }
    const assigneeAgentId = entry.assigneeAgentId ?? null;
    // R3: a stored profile carries a boolean for every optional step and null
    // for every other one. An entry that states no opinion about an optional
    // step means "keep it", which is what instantiation does with no entry at
    // all; stating one about a step the template does not mark optional is a
    // refusal, because there is nothing for the flag to decide.
    if (entry.include !== undefined && entry.include !== null && !step.optional) {
      throw refuse(
        "staffing_profile_include_not_optional",
        `Step ${step.name} (${entry.outputKind}) is not optional, so it cannot carry an include flag`,
        entry.outputKind,
      );
    }
    const include = step.optional ? entry.include ?? true : null;
    const assigneeRefusal = staffingAssigneeRefusal(assigneeAgentId, step, agents, context);
    if (assigneeRefusal) throw assigneeRefusal;
    normalized.push({ outputKind: entry.outputKind, assigneeAgentId, include });
  }

  // Every optional step the caller did not name gets its default opinion here,
  // so the saved profile is the whole plan rather than the part that was typed.
  for (const step of steps) {
    if (!step.optional || seen.has(step.outputKind)) continue;
    normalized.push({ outputKind: step.outputKind, assigneeAgentId: null, include: true });
  }

  // A warning describes the plan being saved and never blocks it.
  const warnings: StaffingProfileWarning[] = [];
  const effective = new Map<string, string | null>(steps.map((step) => [step.outputKind, step.assigneeAgentId]));
  for (const entry of normalized) {
    if (entry.assigneeAgentId !== null) effective.set(entry.outputKind, entry.assigneeAgentId);
  }
  const agentsFor = (roles: ReadonlySet<string>): Set<string> => new Set(
    steps
      .filter((step) => {
        const role = stepRole({ outputKind: step.outputKind });
        return role !== null && roles.has(role);
      })
      .flatMap((step) => {
        const agentId = effective.get(step.outputKind) ?? null;
        return agentId === null ? [] : [agentId];
      }),
  );
  const implementers = agentsFor(new Set(["implementation", "fixed-implementation"]));
  const reviewers = agentsFor(new Set(["plan-review", "review-findings", "blind-findings"]));
  if ([...reviewers].some((agentId) => implementers.has(agentId))) {
    warnings.push({
      code: "same_agent_implements_and_reviews",
      message: "One Agent implements and reviews under this staffing profile",
    });
  }
  return { entries: normalized, warnings };
};

const stepSelect = {
  stepIndex: true,
  name: true,
  outputKind: true,
  optional: true,
  assigneeType: true,
  assigneeAgentId: true,
  runner: true,
} as const satisfies Prisma.TaskTemplateStepSelect;

const agentSelect = {
  id: true,
  name: true,
  projectId: true,
  archivedAt: true,
  model: true,
  runnerPreference: true,
} as const satisfies Prisma.AgentSelect;

const readSteps = async (tx: Tx, taskTemplateId: string): Promise<ValidationStep[]> =>
  tx.taskTemplateStep.findMany({
    where: { taskTemplateId },
    orderBy: { stepIndex: "asc" },
    select: stepSelect,
  });

/**
 * Takes the two mutexes a profile write shares with the rest of the platform,
 * in the platform's lock order: the template row (shared with authoring and
 * instantiation), then the Agent rows (shared with archive).
 *
 * `lockAgentRows` returns only identity fields, so the model and runner
 * preference the capability predicate needs are re-read under the lock it took.
 */
const lockedAgents = async (
  tx: Tx,
  agentIds: readonly string[],
): Promise<Map<string, ValidationAgent>> => {
  const unique = [...new Set(agentIds)].sort();
  if (unique.length === 0) return new Map();
  await lockAgentRows(tx, unique);
  const rows = await tx.agent.findMany({ where: { id: { in: unique } }, select: agentSelect });
  return new Map(rows.map((row) => [row.id, row]));
};

const requireTemplate = async (
  tx: Tx,
  projectId: string,
  templateId: string,
): Promise<{ id: string; name: string }> => {
  const locked = await lockTemplateRow(tx, templateId);
  if (!locked || locked.projectId !== projectId) {
    throw refuse(
      "staffing_profile_template_not_found",
      `Template ${templateId} is not in project ${projectId}`,
    );
  }
  return { id: locked.id, name: locked.name };
};

const requireProfile = async (
  tx: Tx,
  profileId: string,
): Promise<{
  id: string;
  projectId: string;
  taskTemplateId: string;
  name: string;
  isDefault: boolean;
  mergeTailRepairAgentId: string | null;
  tiers: StaffingProfileTiers;
}> => {
  const profile = await tx.staffingProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      projectId: true,
      taskTemplateId: true,
      name: true,
      isDefault: true,
      mergeTailRepairAgentId: true,
      tiers: {
        select: { tier: true, agentId: true },
        orderBy: { tier: "asc" },
      },
    },
  });
  if (!profile) throw refuse("staffing_profile_not_found", `Staffing profile ${profileId} was not found`);
  return {
    ...profile,
    tiers: tierSlotsFromRows(profile.tiers),
  };
};

const assertNameFree = async (
  tx: Tx,
  taskTemplateId: string,
  name: string,
  exceptProfileId?: string,
): Promise<void> => {
  const existing = await tx.staffingProfile.findUnique({
    where: { taskTemplateId_name: { taskTemplateId, name } },
    select: { id: true },
  });
  if (existing && existing.id !== exceptProfileId) {
    throw refuse(
      "staffing_profile_name_taken",
      `Staffing profile name ${name} is already used by this template`,
    );
  }
};

/** Promote one profile and demote every sibling in the same statement pair. */
const promoteDefault = async (tx: Tx, profile: { id: string; taskTemplateId: string }): Promise<void> => {
  await tx.staffingProfile.updateMany({
    where: { taskTemplateId: profile.taskTemplateId, id: { not: profile.id }, isDefault: true },
    data: { isDefault: false },
  });
  await tx.staffingProfile.update({ where: { id: profile.id }, data: { isDefault: true } });
};

const writeEntries = async (
  tx: Tx,
  profileId: string,
  entries: readonly StaffingProfileEntryContract[],
): Promise<void> => {
  await tx.staffingProfileEntry.deleteMany({ where: { profileId } });
  if (entries.length === 0) return;
  await tx.staffingProfileEntry.createMany({
    data: entries.map((entry) => ({ profileId, ...entry })),
  });
};

const writeTierSlots = async (
  tx: Tx,
  profileId: string,
  slots: StaffingProfileTiers,
): Promise<void> => {
  await tx.staffingProfileTier.deleteMany({ where: { profileId } });
  const data = STAFFING_PROFILE_TIERS.flatMap((tier) => {
    const agentId = slots[tier];
    return agentId === null ? [] : [{ profileId, tier, agentId }];
  });
  if (data.length > 0) await tx.staffingProfileTier.createMany({ data });
};

const mergeTierSlots = (
  base: StaffingProfileTiers,
  input: StaffingProfileTiersInput | undefined,
): StaffingProfileTiers => {
  const slots = { ...base };
  if (input === undefined) return slots;
  for (const tier of STAFFING_PROFILE_TIERS) {
    if (Object.prototype.hasOwnProperty.call(input, tier)) slots[tier] = input[tier] ?? null;
  }
  return slots;
};

const validateTierSlots = (
  slots: StaffingProfileTiers,
  agents: ReadonlyMap<string, ValidationAgent>,
  context: { projectId: string },
): void => {
  for (const tier of STAFFING_PROFILE_TIERS) {
    const agentId = slots[tier];
    if (agentId === null) continue;
    const agent = agents.get(agentId);
    if (!agent || agent.projectId !== context.projectId) {
      throw refuse(
        "staffing_profile_agent_not_found",
        `Agent ${agentId} for ${tier} implementation tier was not found in this project`,
      );
    }
    if (agent.archivedAt !== null) {
      throw refuse(
        "staffing_profile_agent_archived",
        `Agent ${agent.name} for ${tier} implementation tier is archived`,
      );
    }
  }
};

export const listStaffingProfiles = async (
  db: PrismaClient,
  projectId: string,
  templateId: string,
): Promise<StaffingProfileContract<Date>[]> => {
  const template = await db.taskTemplate.findFirst({
    where: { id: templateId, projectId },
    select: { id: true },
  });
  if (!template) {
    throw refuse(
      "staffing_profile_template_not_found",
      `Template ${templateId} is not in project ${projectId}`,
    );
  }
  const profiles = await db.staffingProfile.findMany({
    where: { taskTemplateId: templateId },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: profileSelect,
  });
  return profiles.map(profileContract);
};

export const createStaffingProfile = async (
  db: PrismaClient,
  projectId: string,
  templateId: string,
  input: CreateStaffingProfileInput,
): Promise<StaffingProfileResult> => serializable(db, async (tx) => {
  const template = await requireTemplate(tx, projectId, templateId);
  const name = input.name.trim();
  await assertNameFree(tx, template.id, name);
  const steps = await readSteps(tx, template.id);
  const tierSlots = mergeTierSlots(emptyTierSlots(), input.tiers);
  const agents = await lockedAgents(tx, [
    ...input.entries.flatMap((entry) => entry.assigneeAgentId ? [entry.assigneeAgentId] : []),
    ...(input.mergeTailRepairAgentId ? [input.mergeTailRepairAgentId] : []),
    ...STAFFING_PROFILE_TIERS.flatMap((tier) => tierSlots[tier] === null ? [] : [tierSlots[tier]!]),
  ]);
  const repairAgentId = await resolveRepairSlot(tx, {
    projectId, taskTemplateId: template.id, agentId: input.mergeTailRepairAgentId ?? null,
    repoId: input.repoId, agents,
  });
  const validated = validateStaffingEntries(input.entries, steps, agents, {
    projectId,
    templateName: template.name,
  });
  validateTierSlots(tierSlots, agents, { projectId });

  // The first profile of a template is always its default: a template with
  // profiles but no default would silently instantiate from canonical.
  const siblingCount = await tx.staffingProfile.count({ where: { taskTemplateId: template.id } });
  const created = await tx.staffingProfile.create({
    data: {
      projectId,
      taskTemplateId: template.id,
      name,
      isDefault: false,
      mergeTailRepairAgentId: repairAgentId,
    },
    select: { id: true, taskTemplateId: true },
  });
  await writeEntries(tx, created.id, validated.entries);
  await writeTierSlots(tx, created.id, tierSlots);
  if (siblingCount === 0 || (input.isDefault ?? false)) await promoteDefault(tx, created);
  return { profile: await readProfile(tx, created.id), warnings: validated.warnings };
});

export const replaceStaffingProfile = async (
  db: PrismaClient,
  profileId: string,
  input: ReplaceStaffingProfileInput,
): Promise<StaffingProfileResult> => serializable(db, async (tx) => {
  const existing = await requireProfile(tx, profileId);
  const template = await requireTemplate(tx, existing.projectId, existing.taskTemplateId);
  const name = input.name.trim();
  await assertNameFree(tx, template.id, name, existing.id);
  const steps = await readSteps(tx, template.id);
  const tierSlots = mergeTierSlots(existing.tiers, input.tiers);
  const requestedRepairAgentId = input.mergeTailRepairAgentId === undefined
    ? existing.mergeTailRepairAgentId ?? null
    : input.mergeTailRepairAgentId;
  const agents = await lockedAgents(tx, [
    ...input.entries.flatMap((entry) => entry.assigneeAgentId ? [entry.assigneeAgentId] : []),
    ...(requestedRepairAgentId ? [requestedRepairAgentId] : []),
    ...STAFFING_PROFILE_TIERS.flatMap((tier) => tierSlots[tier] === null ? [] : [tierSlots[tier]!]),
  ]);
  if (input.mergeTailRepairAgentId !== undefined) {
    await resolveRepairSlot(tx, {
      projectId: existing.projectId, taskTemplateId: template.id,
      agentId: input.mergeTailRepairAgentId, repoId: input.repoId, agents,
    });
  }
  const validated = validateStaffingEntries(input.entries, steps, agents, {
    projectId: existing.projectId,
    templateName: template.name,
  });
  validateTierSlots(tierSlots, agents, { projectId: existing.projectId });
  await tx.staffingProfile.update({
    where: { id: existing.id },
    data: { name, mergeTailRepairAgentId: requestedRepairAgentId },
  });
  await writeEntries(tx, existing.id, validated.entries);
  await writeTierSlots(tx, existing.id, tierSlots);
  return { profile: await readProfile(tx, existing.id), warnings: validated.warnings };
});

/** Reset one profile's entries to the template's canonical bindings. */
export const resetStaffingProfile = async (
  db: PrismaClient,
  profileId: string,
  repoId?: string,
): Promise<StaffingProfileResult> => serializable(db, async (tx) => {
  const existing = await requireProfile(tx, profileId);
  const template = await requireTemplate(tx, existing.projectId, existing.taskTemplateId);
  const steps = await readSteps(tx, template.id);
  const entries = canonicalStaffingEntries(steps);
  const resetRepairRole = canonicalMergeTailRepairAgentRole(template.name);
  const defaultRepairAgent = resetRepairRole === null ? null : await findCanonicalAgent(tx, {
    projectId: existing.projectId,
    canonicalRole: resetRepairRole,
    activeOnly: false,
  });
  const tierSlots = emptyTierSlots();
  for (const tier of STAFFING_PROFILE_TIERS) {
    const canonical = await findCanonicalAgent(tx, {
      projectId: existing.projectId,
      canonicalRole: CANONICAL_STAFFING_TIER_ROLES[tier],
      activeOnly: true,
    });
    if (canonical) tierSlots[tier] = canonical.id;
  }
  const resetWarnings: StaffingProfileWarning[] = [];
  if (resetRepairRole !== null && defaultRepairAgent === null) {
    resetWarnings.push({ code: "merge_tail_repair_agent_unavailable",
      message: `Canonical merge-tail repair Agent ${resetRepairRole} is missing; reset leaves the slot empty` });
  }
  const agents = await lockedAgents(tx, [
    ...entries.flatMap((entry) => entry.assigneeAgentId ? [entry.assigneeAgentId] : []),
    ...(defaultRepairAgent ? [defaultRepairAgent.id] : []),
    ...STAFFING_PROFILE_TIERS.flatMap((tier) => tierSlots[tier] === null ? [] : [tierSlots[tier]!]),
  ]);
  validateTierSlots(tierSlots, agents, { projectId: existing.projectId });
  const repairAgentId = await resolveRepairSlot(tx, {
    projectId: existing.projectId, taskTemplateId: template.id,
    agentId: defaultRepairAgent?.id ?? null, repoId, agents, resetWarnings,
  });
  // An unavailable canonical repair Agent may also own implementation steps.
  // Leave those profile overrides empty, just like the repair slot, rather
  // than rejecting reset while validating the template's archived binding.
  if (defaultRepairAgent && repairAgentId === null) {
    for (const entry of entries) {
      if (entry.assigneeAgentId === defaultRepairAgent.id) entry.assigneeAgentId = null;
    }
  }
  const validated = validateStaffingEntries(entries, steps, agents, {
    projectId: existing.projectId,
    templateName: template.name,
  });
  await writeEntries(tx, existing.id, validated.entries);
  await writeTierSlots(tx, existing.id, tierSlots);
  await tx.staffingProfile.update({
    where: { id: existing.id },
    data: { mergeTailRepairAgentId: repairAgentId },
  });
  return { profile: await readProfile(tx, existing.id), warnings: [...validated.warnings, ...resetWarnings] };
});

export const setStaffingProfileDefault = async (
  db: PrismaClient,
  profileId: string,
): Promise<StaffingProfileContract<Date>> => serializable(db, async (tx) => {
  const existing = await requireProfile(tx, profileId);
  await requireTemplate(tx, existing.projectId, existing.taskTemplateId);
  await promoteDefault(tx, existing);
  return readProfile(tx, existing.id);
});

export const deleteStaffingProfile = async (
  db: PrismaClient,
  profileId: string,
): Promise<void> => serializable(db, async (tx) => {
  const existing = await requireProfile(tx, profileId);
  await requireTemplate(tx, existing.projectId, existing.taskTemplateId);
  const siblingCount = await tx.staffingProfile.count({
    where: { taskTemplateId: existing.taskTemplateId, id: { not: existing.id } },
  });
  // Deleting the last profile is allowed and instantiation falls back to the
  // canonical bindings. Deleting the default while alternatives remain is not:
  // it would leave the template with profiles and no default.
  if (existing.isDefault && siblingCount > 0) {
    throw refuse(
      "staffing_profile_default_delete_refused",
      `Staffing profile ${existing.name} is this template's default; make another profile the default before deleting it`,
    );
  }
  await tx.staffingProfile.delete({ where: { id: existing.id } });
});

/**
 * Every profile that names one Agent. Read inside the caller's transaction,
 * which must already hold that Agent's row mutex, so archive can refuse with
 * the exact list rather than a count that may already be stale (R6).
 */
export const profilesReferencingAgent = async (
  tx: Tx,
  agentId: string,
): Promise<Array<{ id: string; name: string; taskTemplateId: string }>> => {
  const entries = await tx.staffingProfileEntry.findMany({
    where: { assigneeAgentId: agentId },
    select: { profile: { select: { id: true, name: true, taskTemplateId: true } } },
    orderBy: [{ profileId: "asc" }, { outputKind: "asc" }],
  });
  const tierEntries = await tx.staffingProfileTier.findMany({
    where: { agentId },
    select: { profile: { select: { id: true, name: true, taskTemplateId: true } } },
    orderBy: [{ profileId: "asc" }, { tier: "asc" }],
  });
  const byId = new Map([...entries, ...tierEntries].map(({ profile }) => [profile.id, profile]));
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
};

/**
 * Install the "Default" profile for a template that has none, from its own
 * step bindings. Used by project bootstrap and by template clone; both already
 * hold their own transaction, so this takes no lock of its own.
 */
export const installDefaultStaffingProfile = async (
  tx: Tx,
  input: { projectId: string; taskTemplateId: string },
): Promise<void> => {
  const existing = await tx.staffingProfile.count({ where: { taskTemplateId: input.taskTemplateId } });
  if (existing > 0) return;
  const steps = await readSteps(tx, input.taskTemplateId);
  const sourceTemplate = await tx.taskTemplate.findUnique({
    where: { id: input.taskTemplateId },
    select: { name: true },
  });
  const repairRole = sourceTemplate === null
    ? null
    : canonicalMergeTailRepairAgentRole(sourceTemplate.name);
  const defaultRepairAgent = repairRole === null ? null : await findCanonicalAgent(tx, {
    projectId: input.projectId,
    canonicalRole: repairRole,
    activeOnly: true,
  });
  const tierSlots = emptyTierSlots();
  for (const tier of STAFFING_PROFILE_TIERS) {
    const canonical = await findCanonicalAgent(tx, {
      projectId: input.projectId,
      canonicalRole: CANONICAL_STAFFING_TIER_ROLES[tier],
      activeOnly: true,
    });
    if (canonical) tierSlots[tier] = canonical.id;
  }
  const profile = await tx.staffingProfile.create({
    data: {
      projectId: input.projectId,
      taskTemplateId: input.taskTemplateId,
      name: DEFAULT_STAFFING_PROFILE_NAME,
      isDefault: true,
      mergeTailRepairAgentId: repairRole === null ? null : defaultRepairAgent?.id ?? null,
    },
    select: { id: true },
  });
  await writeEntries(tx, profile.id, canonicalStaffingEntries(steps));
  await writeTierSlots(tx, profile.id, tierSlots);
};


/**
 * Copy every profile of one template onto another, preserving names, default
 * membership and entries. Both templates are assumed to have the same output
 * kinds, which is what a clone guarantees.
 */
export const copyStaffingProfiles = async (
  tx: Tx,
  input: { projectId: string; fromTaskTemplateId: string; toTaskTemplateId: string },
): Promise<void> => {
  const sources = await tx.staffingProfile.findMany({
    where: { taskTemplateId: input.fromTaskTemplateId },
    orderBy: { name: "asc" },
    select: profileSelect,
  });
  for (const source of sources) {
    const created = await tx.staffingProfile.create({
      data: {
        projectId: input.projectId,
        taskTemplateId: input.toTaskTemplateId,
        name: source.name,
        isDefault: source.isDefault,
        mergeTailRepairAgentId: source.mergeTailRepairAgentId,
      },
      select: { id: true },
    });
    await writeEntries(tx, created.id, source.entries);
    await writeTierSlots(tx, created.id, tierSlotsFromRows(source.tiers));
  }
};

/**
 * One opinion a step-graph replacement could not keep.
 *
 * `entry-dropped` names an entry whose output kind the new graph does not
 * produce; `assignee-dropped` names an entry the new graph keeps but whose
 * Agent it no longer allows there — the step became `HUMAN`, or the binding
 * now violates the integrator or compound-root rule. Both are reported rather
 * than refused: the operator is rewriting their own graph, and a saved profile
 * that no chain can instantiate is worse than a visible gap.
 */
export type StaffingProfileRemapLoss = {
  kind: "entry-dropped" | "assignee-dropped";
  profileName: string;
  outputKind: string;
  reason: string;
};

/**
 * Remap every profile of a template after its step graph was replaced.
 *
 * Entries survive by exact output kind only — a replacement is an operator
 * rewriting the graph, not a protocol version moving underneath it — and an
 * entry with no surviving step is dropped rather than reassigned.
 *
 * What survives is then validated against the new graph exactly as a profile
 * write would be, and every optional step ends with a boolean `include` (R3).
 * Without that, a replacement that turned a step HUMAN, or changed the
 * compound implementation root, left the template's default profile saved but
 * uninstantiable, and the operator only learned of it at the next chain.
 */
export const remapStaffingProfiles = async (
  tx: Tx,
  input: { projectId: string; taskTemplateId: string; templateName: string; steps: readonly ValidationStep[] },
): Promise<StaffingProfileRemapLoss[]> => {
  const stepsByKind = new Map(input.steps.map((step) => [step.outputKind, step]));
  const profiles = await tx.staffingProfile.findMany({
    where: { taskTemplateId: input.taskTemplateId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      entries: {
        select: { outputKind: true, assigneeAgentId: true, include: true },
        orderBy: { outputKind: "asc" },
      },
    },
  });
  const assigneeIds = [...new Set(profiles.flatMap((profile) => profile.entries.flatMap((entry) => (
    entry.assigneeAgentId === null ? [] : [entry.assigneeAgentId]
  ))))].sort();
  const agents = new Map((assigneeIds.length === 0
    ? []
    : await tx.agent.findMany({ where: { id: { in: assigneeIds } }, select: agentSelect })
  ).map((agent) => [agent.id, agent]));

  const losses: StaffingProfileRemapLoss[] = [];
  for (const profile of profiles) {
    const entries: StaffingProfileEntryContract[] = [];
    for (const entry of profile.entries) {
      const step = stepsByKind.get(entry.outputKind);
      if (!step) {
        losses.push({
          kind: "entry-dropped",
          profileName: profile.name,
          outputKind: entry.outputKind,
          reason: "the replacement graph has no step producing it",
        });
        continue;
      }
      const refusal = staffingAssigneeRefusal(entry.assigneeAgentId, step, agents, {
        projectId: input.projectId,
        templateName: input.templateName,
      });
      if (refusal) {
        losses.push({
          kind: "assignee-dropped",
          profileName: profile.name,
          outputKind: entry.outputKind,
          reason: refusal.message,
        });
      }
      entries.push({
        outputKind: entry.outputKind,
        assigneeAgentId: refusal ? null : entry.assigneeAgentId,
        include: step.optional ? entry.include ?? true : null,
      });
    }
    const named = new Set(entries.map((entry) => entry.outputKind));
    for (const step of input.steps) {
      if (!step.optional || named.has(step.outputKind)) continue;
      entries.push({ outputKind: step.outputKind, assigneeAgentId: null, include: true });
    }
    await writeEntries(tx, profile.id, entries);
  }
  return losses;
};
