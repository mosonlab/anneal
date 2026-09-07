import {
  CodexServiceTier,
  Prisma,
  PrismaClient,
  RepoPermission,
  RunnerPreference,
} from "@prisma/client";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { catalogRunnerForModel } from "../src/agent-contract.js";
import {
  adoptRenamedCanonicalRoles,
  loadAgentSources,
  roleSourceStructureDifferences,
  type AgentSources,
  type RoleSource,
} from "../src/agent-sources.js";
import { findCanonicalAgent } from "../src/canonical-agent-lookup.js";
import {
  canonicalStepAdoptions,
  canonicalStepDrift,
  REGRESSION_VERIFIER_AGENT_NAME,
  SPEC_REVALIDATOR_AGENT_NAME,
} from "../src/canonical-step-adoption.js";
import {
  canonicalSyncSummary,
  canonicalSyncSummaryLine,
  emptyCanonicalSyncCounters,
  recordRolePromptUpdate,
  recordStepPromptUpdate,
  type CanonicalSyncCounters,
  type CanonicalSyncProjectOutcome,
} from "../src/canonical-sync-report.js";
import {
  applyCanonicalInstallation,
  planCanonicalInstallation,
  type CanonicalInstallationAction,
  type CanonicalInstallationRow,
} from "../src/canonical-template-installation.js";
import {
  loadAllTemplateStepSources,
  type CanonicalTemplateName,
  type TemplateStepSource,
} from "../src/template-sources.js";
import { installCanonicalDefaultStaffingProfiles } from "../src/staffing-profile-canonical.js";

const SENIOR_DEV_SOL_ROLE = "senior-dev-sol-high";
const SENIOR_DEV_OPUS_ROLE = "senior-dev-opus-medium";
const SENIOR_DEV_ASTRA_LOW_ROLE = "senior-dev-astra-low";
const SENIOR_DEV_ROLE = "senior-dev-astra-medium";
const CODE_REVIEWER_SOL_ROLE = "code-reviewer-sol-high";

// Canonical roles added after the canonical project was seeded, so ordinary
// synchronization never creates them: each is created once from an active
// source Agent row (copying its environment, tools, and repo access). Both keys
// are canonical roles, not names: the row an operator renamed is still the row
// this list means.
const SPECIAL_CANONICAL_AGENTS: readonly {
  canonicalRole: string;
  source: string;
  permissions: RepoPermission | null;
}[] = [
  { canonicalRole: REGRESSION_VERIFIER_AGENT_NAME, source: CODE_REVIEWER_SOL_ROLE, permissions: null },
  { canonicalRole: SPEC_REVALIDATOR_AGENT_NAME, source: CODE_REVIEWER_SOL_ROLE, permissions: RepoPermission.GIT_READ },
  { canonicalRole: SENIOR_DEV_SOL_ROLE, source: SENIOR_DEV_ROLE, permissions: null },
  { canonicalRole: SENIOR_DEV_OPUS_ROLE, source: SENIOR_DEV_ROLE, permissions: null },
  { canonicalRole: SENIOR_DEV_ASTRA_LOW_ROLE, source: SENIOR_DEV_ROLE, permissions: null },
];

/** Agent columns canonical sync writes unless the operator edited them (R9). */
const ADOPTABLE_AGENT_FIELDS = ["name", "title", "model", "runnerPreference"] as const;
const RUNTIME_AGENT_FIELDS = ["model", "runnerPreference"] as const;

const runtimeConfigRefusal = (agent: { model: string; runnerPreference: RunnerPreference }): string | null => {
  const expected = catalogRunnerForModel(agent.model);
  if (!expected || agent.runnerPreference === RunnerPreference.AUTO || agent.runnerPreference === RunnerPreference.INHERIT
    || expected === agent.runnerPreference) return null;
  return `Model ${agent.model} requires ${expected}, but this Agent stores ${agent.runnerPreference}`;
};

type ProjectRow = { id: string; slug: string };

const sortedProjectRows = (rows: readonly ProjectRow[]): ProjectRow[] => [...rows].sort((left, right) => (
  left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0
));

const projectError = (project: ProjectRow, message: string): Error => new Error(`Project ${project.slug}: ${message}`);

/**
 * A persisted step's binding identity is `canonicalRole` when it has one, so
 * the column is selected wherever that identity is compared. Reading only
 * `name` reported every legitimately renamed canonical Agent as drift and made
 * each sync re-adopt a binding that never changed.
 */
const stepAgentIdentitySelect = { name: true, canonicalRole: true } as const;

const transitionStepInclude = {
  assigneeAgent: { select: stepAgentIdentitySelect },
  _count: { select: { tasks: true } },
} as const;

const readCanonicalTemplateRows = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  name: CanonicalTemplateName,
) => tx.taskTemplate.findMany({
  where: { projectId, name },
  include: { steps: { orderBy: { stepIndex: "asc" }, include: transitionStepInclude } },
});

const readCanonicalInstallationRows = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  templateSources: ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>,
): Promise<CanonicalInstallationRow[]> => {
  const installationRows: CanonicalInstallationRow[] = [];
  for (const templateName of templateSources.keys()) {
    const rows = await readCanonicalTemplateRows(tx, projectId, templateName);
    installationRows.push(...rows.map((row) => ({
      ...row,
      name: templateName,
      steps: row.steps as unknown as CanonicalInstallationRow["steps"],
    })));
  }
  return installationRows;
};

export const parseInstallFullProjectId = (args: readonly string[] = process.argv.slice(2)): string | null => {
  if (args.length === 0) return null;
  if (args[0] !== "--install-full") throw new Error(`Unknown argument ${args[0]}`);
  const projectId = args[1];
  if (args.length !== 2 || !projectId) {
    throw new Error("--install-full requires exactly one Project id");
  }
  return projectId;
};

type FullInstallTarget = ProjectRow & { environmentId: string };

const preflightFullInstallTarget = async (
  tx: Prisma.TransactionClient,
  requestedId: string,
  roles: readonly string[],
): Promise<FullInstallTarget> => {
  const target = await tx.project.findUnique({
    where: { id: requestedId },
    select: {
      id: true,
      slug: true,
      environments: { select: { id: true, name: true } },
    },
  });
  if (!target) throw new Error(`Project ${requestedId} was not found`);
  const project = { id: target.id, slug: target.slug };
  if (target.environments.length === 0) {
    throw projectError(project, `Project has no Environment; --install-full requires exactly one`);
  }
  if (target.environments.length !== 1) {
    throw projectError(project, `Project has ${target.environments.length} Environments; --install-full requires exactly one`);
  }
  const archived = await tx.agent.findFirst({
    where: { projectId: target.id, canonicalRole: { in: [...roles] }, archivedAt: { not: null } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  if (archived) {
    throw projectError(project, `Agent ${archived.name} (${archived.id}) is archived; --install-full will not resurrect it`);
  }
  return { ...project, environmentId: target.environments[0]!.id };
};

const createSpecialCanonicalAgent = async (
  tx: Prisma.TransactionClient,
  project: ProjectRow,
  sources: AgentSources,
  role: RoleSource,
  sourceRole: string,
  permissions: RepoPermission | null,
): Promise<{ created: boolean; grants: number }> => {
  const existing = await tx.agent.findFirst({
    where: { projectId: project.id, canonicalRole: role.canonicalRole },
    select: { id: true, archivedAt: true },
  });
  if (existing?.archivedAt) {
    throw projectError(project, `Agent ${role.canonicalRole} (${existing.id}) is archived; sync will not resurrect it`);
  }
  if (existing) return { created: false, grants: 0 };

  const source = await tx.agent.findFirst({
    where: { projectId: project.id, canonicalRole: sourceRole },
    select: {
      id: true,
      environmentId: true,
      disabledTools: true,
      archivedAt: true,
      repoAccess: { select: { projectId: true, repoId: true, mountPath: true, permissions: true } },
    },
  });
  if (!source || source.archivedAt) {
    throw projectError(project, `Cannot create ${role.canonicalRole}: active source Agent ${sourceRole} was not found`);
  }
  const created = await tx.agent.create({ data: {
    projectId: project.id,
    environmentId: source.environmentId,
    canonicalRole: role.canonicalRole,
    name: role.name,
    title: role.title,
    model: role.model,
    runnerPreference: role.runnerPreference,
    inboxAccess: role.inboxAccess,
    disabledTools: source.disabledTools,
    foundationalPrompt: sources.foundationalPrompt,
    rolePrompt: role.rolePrompt,
    customizedFields: [],
    runtimeConfigDriftNoticeFingerprint: null,
    codexServiceTier: CodexServiceTier.DEFAULT,
    archivedAt: null,
  } });
  const grants = source.repoAccess.length === 0
    ? 0
    : (await tx.agentRepoAccess.createMany({ data: source.repoAccess.map((grant) => ({
      ...grant,
      agentId: created.id,
      ...(permissions === null ? {} : { permissions }),
    })) })).count;
  return { created: true, grants };
};

const migrateSpecialCanonicalAgents = async (
  tx: Prisma.TransactionClient,
  canonicalProject: ProjectRow,
  sources: AgentSources,
  rolesByRole: ReadonlyMap<string, RoleSource>,
  counters: CanonicalSyncCounters,
): Promise<void> => {
  for (const special of SPECIAL_CANONICAL_AGENTS) {
    const role = rolesByRole.get(special.canonicalRole);
    if (!role) throw projectError(canonicalProject, `Canonical role ${special.canonicalRole} was not found`);
    const outcome = await createSpecialCanonicalAgent(
      tx,
      canonicalProject,
      sources,
      role,
      special.source,
      special.permissions,
    );
    if (outcome.created) counters.createdAgents += 1;
    if (outcome.grants > 0) counters.createdAgentRepoGrants += outcome.grants;
  }
};

const installMissingAgents = async (
  tx: Prisma.TransactionClient,
  target: FullInstallTarget,
  sources: AgentSources,
  rolesByRole: ReadonlyMap<string, RoleSource>,
  roles: readonly string[],
  counters: CanonicalSyncCounters,
): Promise<void> => {
  const existing = await tx.agent.findMany({
    where: { projectId: target.id, archivedAt: null, canonicalRole: { in: [...roles] } },
    select: { id: true, canonicalRole: true },
  });
  const existingRoles = new Set(existing.map(({ canonicalRole }) => canonicalRole));
  const createdRoles = new Set<string>();
  for (const canonicalRole of roles) {
    if (existingRoles.has(canonicalRole)) continue;
    const role = rolesByRole.get(canonicalRole);
    if (!role) throw projectError(target, `Canonical role ${canonicalRole} was not found in sources`);
    await tx.agent.create({ data: {
      projectId: target.id,
      environmentId: target.environmentId,
      canonicalRole: role.canonicalRole,
      name: role.name,
      title: role.title,
      model: role.model,
      runnerPreference: role.runnerPreference,
      inboxAccess: role.inboxAccess,
      foundationalPrompt: sources.foundationalPrompt,
      rolePrompt: role.rolePrompt,
      customizedFields: [],
      runtimeConfigDriftNoticeFingerprint: null,
      codexServiceTier: CodexServiceTier.DEFAULT,
      disabledTools: [],
      archivedAt: null,
    } });
    createdRoles.add(canonicalRole);
    counters.createdAgents += 1;
  }

  if (createdRoles.size === 0) return;
  const targetAgents = await tx.agent.findMany({
    where: { projectId: target.id, archivedAt: null, canonicalRole: { in: [...roles] } },
    select: { id: true, canonicalRole: true },
  });
  const agentByRole = new Map(targetAgents.flatMap((agent) => (
    agent.canonicalRole === null ? [] : [[agent.canonicalRole, agent.id] as const]
  )));
  for (const canonicalRole of createdRoles) {
    const role = rolesByRole.get(canonicalRole)!;
    const agentId = agentByRole.get(canonicalRole);
    if (!agentId) throw projectError(target, `Agent ${canonicalRole} was not found after installation`);
    for (const collaboratorName of role.collaborators) {
      const allowedAgentId = agentByRole.get(collaboratorName);
      if (!allowedAgentId) {
        throw projectError(target, `Agent ${canonicalRole} references unknown collaborator ${collaboratorName}`);
      }
      await tx.agentCollaboration.create({ data: {
        agentId,
        allowedAgentId,
        projectId: target.id,
      } });
    }
  }
};

const synchronizeAgents = async (
  tx: Prisma.TransactionClient,
  project: ProjectRow,
  requireCompleteInventory: boolean,
  sources: AgentSources,
  rolesByRole: ReadonlyMap<string, RoleSource>,
  roles: readonly string[],
  counters: CanonicalSyncCounters,
  runtimeConfigAdoptions: Array<{
    name: string;
    from: { model: string; runnerPreference: RunnerPreference };
    to: { model: string; runnerPreference: RunnerPreference };
  }>,
): Promise<void> => {
  const agentSelect = {
    id: true,
    projectId: true,
    canonicalRole: true,
    name: true,
    archivedAt: true,
    title: true,
    model: true,
    customizedFields: true,
    runtimeConfigDriftNoticeFingerprint: true,
    runnerPreference: true,
    inboxAccess: true,
    collaborators: { select: { allowedAgent: { select: { name: true } } } },
  } as const;
  // Rows are found by canonical role. A row installed before the column existed
  // carries the role in its name instead, and is adopted once here — unless the
  // role is already claimed, in which case the same-named row is an operator's
  // Agent that happens to collide and canonical sync leaves it alone.
  const canonicalAgentRows = await tx.agent.findMany({
    where: {
      projectId: project.id,
      OR: [{ canonicalRole: { in: [...roles] } }, { canonicalRole: null, name: { in: [...roles] } }],
    },
    select: agentSelect,
  });
  const claimedRoles = new Set(canonicalAgentRows.flatMap((agent) => (
    agent.canonicalRole === null ? [] : [agent.canonicalRole]
  )));
  const identifiedRows: (typeof canonicalAgentRows[number] & { canonicalRole: string })[] = [];
  for (const agent of canonicalAgentRows) {
    if (agent.canonicalRole !== null) {
      identifiedRows.push({ ...agent, canonicalRole: agent.canonicalRole });
      continue;
    }
    if (claimedRoles.has(agent.name)) continue;
    const claimed = await tx.agent.updateMany({
      where: { id: agent.id, canonicalRole: null },
      data: { canonicalRole: agent.name },
    });
    if (claimed.count !== 1) {
      throw projectError(project, `Agent ${agent.name} (${agent.id}) changed while its canonical role was being recorded`);
    }
    claimedRoles.add(agent.name);
    counters.assignedCanonicalRoles += 1;
    identifiedRows.push({ ...agent, canonicalRole: agent.name });
  }

  const presentAgents = identifiedRows.filter((agent) => agent.archivedAt === null);
  if (requireCompleteInventory) {
    const present = new Set(presentAgents.map(({ canonicalRole }) => canonicalRole));
    for (const canonicalRole of roles) {
      if (present.has(canonicalRole)) continue;
      const archived = identifiedRows.find((agent) => agent.canonicalRole === canonicalRole && agent.archivedAt !== null);
      if (archived) throw projectError(project, `Agent ${canonicalRole} (${archived.id}) is archived`);
      throw projectError(project, `Agent ${canonicalRole} was not found`);
    }
  }

  const namesInProject = new Map((await tx.agent.findMany({
    where: { projectId: project.id },
    select: { id: true, name: true },
  })).map(({ name, id }) => [name, id]));

  for (const agent of presentAgents) {
    const role = rolesByRole.get(agent.canonicalRole);
    if (!role) continue;
    // R9: prompts always follow canonical; name, title, model and runner follow it
    // until the operator edits that field. Everything else is still structure the
    // Markdown owns, and a difference there is a refusal rather than a write.
    const customized = new Set(agent.customizedFields);
    const differences = roleSourceStructureDifferences(agent, role);
    const adoptable = (field: string): boolean => (ADOPTABLE_AGENT_FIELDS as readonly string[]).includes(field);
    const structuralDifferences = differences.filter((difference) => !adoptable(difference));
    const adoptedDifferences = differences.filter((difference) => adoptable(difference) && !customized.has(difference));
    const runtimeDrift = differences.some((difference) => (
      (RUNTIME_AGENT_FIELDS as readonly string[]).includes(difference) && customized.has(difference)
    ));
    const runtimeRefusal = runtimeConfigRefusal(agent);
    if (structuralDifferences.length > 0) {
      throw projectError(project, `Agent ${agent.name} (${agent.id}) differs from canonical Markdown structure: ${structuralDifferences.join(", ")}`);
    }
    if (runtimeRefusal) {
      throw projectError(project, `Agent ${agent.name} (${agent.id}) has an invalid runtime configuration: ${runtimeRefusal}`);
    }
    if (adoptedDifferences.includes("name")) {
      const holder = namesInProject.get(role.name);
      if (holder !== undefined && holder !== agent.id) {
        throw projectError(project, `Agent ${agent.name} (${agent.id}) cannot adopt canonical name ${role.name}: Agent ${holder} already has it`);
      }
    }
    const adoptsRuntime = adoptedDifferences.some((difference) => (RUNTIME_AGENT_FIELDS as readonly string[]).includes(difference));
    if (adoptedDifferences.length > 0) {
      const adopted = await tx.agent.updateMany({
        where: {
          id: agent.id,
          name: agent.name,
          title: agent.title,
          model: agent.model,
          runnerPreference: agent.runnerPreference,
        },
        data: {
          ...(adoptedDifferences.includes("name") ? { name: role.name } : {}),
          ...(adoptedDifferences.includes("title") ? { title: role.title } : {}),
          ...(adoptedDifferences.includes("model") ? { model: role.model } : {}),
          ...(adoptedDifferences.includes("runnerPreference") ? { runnerPreference: role.runnerPreference } : {}),
          ...(adoptsRuntime ? { runtimeConfigDriftNoticeFingerprint: null } : {}),
        },
      });
      if (adopted.count !== 1) {
        throw projectError(project, `Agent ${agent.name} (${agent.id}) changed while its canonical configuration was being adopted`);
      }
      if (adoptedDifferences.includes("name")) {
        namesInProject.delete(agent.name);
        namesInProject.set(role.name, agent.id);
      }
      if (adoptsRuntime) {
        counters.adoptedAgentDefaults += 1;
        runtimeConfigAdoptions.push({
          name: agent.name,
          from: { model: agent.model, runnerPreference: agent.runnerPreference },
          to: { model: role.model, runnerPreference: role.runnerPreference },
        });
      }
      if (adoptedDifferences.some((difference) => difference === "name" || difference === "title")) {
        counters.adoptedAgentIdentity += 1;
      }
    }
    if (runtimeDrift) {
      const fingerprint = JSON.stringify({
        canonical: { model: role.model, runnerPreference: role.runnerPreference },
        production: { model: agent.model, runnerPreference: agent.runnerPreference },
      });
      if (agent.runtimeConfigDriftNoticeFingerprint !== fingerprint) {
        const claimed = await tx.agent.updateMany({
          where: {
            id: agent.id,
            model: agent.model,
            runnerPreference: agent.runnerPreference,
            runtimeConfigDriftNoticeFingerprint: agent.runtimeConfigDriftNoticeFingerprint,
          },
          data: { runtimeConfigDriftNoticeFingerprint: fingerprint },
        });
        if (claimed.count !== 1) {
          throw projectError(project, `Agent ${agent.name} (${agent.id}) changed while canonical runtime drift was being recorded`);
        }
        const chatId = process.env["FEISHU_DEFAULT_CHAT_ID"];
        const thread = chatId ? (
          await tx.inboxThread.findFirst({ where: { channel: "FEISHU", externalChatId: chatId, sessionId: null } })
          ?? await tx.inboxThread.create({ data: { channel: "FEISHU", externalChatId: chatId } }).catch(() => null)
        ) : null;
        await tx.inboxMessage.create({ data: {
          from: "AGENT",
          agentId: agent.id,
          kind: "TEXT",
          body: [
            "Canonical runtime drift detected",
            `Agent: ${agent.name} (${agent.canonicalRole})`,
            `Canonical: model=${role.model}, runner=${role.runnerPreference}`,
            `Production: model=${agent.model}, runner=${agent.runnerPreference}`,
            `customizedFields=${[...customized].sort().join(",")}`,
          ].join("\n"),
          ...(thread ? { threadId: thread.id } : {}),
        } });
        counters.runtimeDriftNotices += 1;
      }
    } else if (!adoptsRuntime && agent.runtimeConfigDriftNoticeFingerprint !== null) {
      await tx.agent.updateMany({
        where: {
          id: agent.id,
          model: agent.model,
          runnerPreference: agent.runnerPreference,
          runtimeConfigDriftNoticeFingerprint: agent.runtimeConfigDriftNoticeFingerprint,
        },
        data: { runtimeConfigDriftNoticeFingerprint: null },
      });
    }

    const promptUpdate = await tx.agent.updateMany({
      where: {
        id: agent.id,
        archivedAt: null,
        OR: [
          { foundationalPrompt: { not: sources.foundationalPrompt } },
          { rolePrompt: { not: role.rolePrompt } },
        ],
      },
      data: { foundationalPrompt: sources.foundationalPrompt, rolePrompt: role.rolePrompt },
    });
    if (promptUpdate.count > 0) recordRolePromptUpdate(counters, role.canonicalRole, promptUpdate.count);
  }
};

const syncCanonicalTemplates = async (
  tx: Prisma.TransactionClient,
  project: ProjectRow,
  templateSources: ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>,
  counters: CanonicalSyncCounters,
): Promise<void> => {
  for (const [templateName, steps] of templateSources) {
    const templates = await tx.taskTemplate.findMany({
      where: { projectId: project.id, name: templateName },
      select: { id: true, projectId: true },
    });
    for (const template of templates) {
      counters.templates += 1;
      const persistedSteps = await tx.taskTemplateStep.findMany({
        where: { taskTemplateId: template.id },
        select: {
          id: true,
          stepIndex: true,
          name: true,
          taskTemplateId: true,
          prompt: true,
          layer: true,
          assigneeAgentId: true,
          assigneeAgent: { select: stepAgentIdentitySelect },
          assigneeType: true,
          approvalGate: true,
          optional: true,
          outputKind: true,
          attachmentsFromPrevious: true,
          priorOutputKinds: true,
          opensPullRequest: true,
          requiresCommit: true,
          provisionDependencies: true,
          baseFromStepIndex: true,
          spawnPolicy: true,
          _count: { select: { tasks: true } },
        },
        orderBy: { stepIndex: "asc" },
      });
      if (persistedSteps.length !== steps.length) {
        throw projectError(project, `Template ${templateName} (${template.id}) has structural drift: expected ${steps.length} steps, found ${persistedSteps.length}`);
      }
      const persistedByIndex = new Map(persistedSteps.map((step) => [step.stepIndex, step]));
      for (const step of steps) {
        const persisted = persistedByIndex.get(step.stepIndex);
        if (!persisted) {
          const expectedIndexes = new Set(steps.map((source) => source.stepIndex));
          const unexpected = persistedSteps.find((candidate) => !expectedIndexes.has(candidate.stepIndex));
          if (unexpected) {
            throw projectError(
              project,
              `Template ${templateName} (${template.id}), ${templateName} step ${unexpected.stepIndex} (${unexpected.id}) has structural drift: expected canonical step ${step.stepIndex}`,
            );
          }
          throw projectError(project, `Template ${templateName} (${template.id}) step ${step.stepIndex} was not found`);
        }
        const drift = canonicalStepDrift(templateName, persisted, step, "adopt");
        if (drift.length > 0) {
          throw projectError(
            project,
            `Template ${templateName} (${template.id}), ${templateName} step ${step.stepIndex} (${persisted.id}) differs from canonical Markdown structure: ${drift.join(", ")}`,
          );
        }
        for (const adoption of canonicalStepAdoptions(templateName, persisted, step)) {
          if (adoption.refusesReferencedStep && persisted._count.tasks > 0) {
            throw projectError(
              project,
              `Template ${templateName} (${template.id}), ${templateName} step ${step.stepIndex} (${persisted.id}) is referenced by instantiated tasks; canonical sync will not mutate it`,
            );
          }
          if (adoption.write.kind === "bind-agent") {
            // `adoption.write.agentName` is the role file name, and `name` is
            // operator-editable, so the target is resolved by canonical role.
            const assignee = await findCanonicalAgent(tx, {
              projectId: template.projectId,
              canonicalRole: adoption.write.agentName,
              activeOnly: true,
            });
            if (!assignee) {
              throw projectError(
                project,
                `Template ${templateName} (${template.id}), ${templateName} step ${step.stepIndex} (${persisted.id}) cannot adopt ${adoption.write.agentName}: active target Agent was not found`,
              );
            }
            await tx.taskTemplateStep.update({ where: { id: persisted.id }, data: { assigneeAgentId: assignee.id } });
          } else {
            await tx.taskTemplateStep.update({ where: { id: persisted.id }, data: adoption.write.data });
          }
          counters[adoption.counter] += 1;
        }
        if (persisted._count.tasks > 0 && persisted.prompt !== step.prompt) {
          throw projectError(
            project,
            `Template ${templateName} (${template.id}), ${templateName} step ${step.stepIndex} (${persisted.id}) is referenced by instantiated tasks; canonical sync will not mutate its prompt`,
          );
        }
        if (persisted.prompt !== step.prompt) {
          await tx.taskTemplateStep.update({ where: { id: persisted.id }, data: { prompt: step.prompt } });
          recordStepPromptUpdate(counters, templateName, step.stepIndex, 1);
        }
      }
    }
  }
};

export const main = async (
  database?: PrismaClient,
  requestedInstallFullProjectId?: string | null,
): Promise<void> => {
  const installFullProjectId = requestedInstallFullProjectId === undefined
    ? parseInstallFullProjectId()
    : requestedInstallFullProjectId;
  const [templateSources, sources] = await Promise.all([loadAllTemplateStepSources(), loadAgentSources()]);
  const rolesByRole = new Map(sources.roles.map((role) => [role.canonicalRole, role]));
  const roleNames = [...rolesByRole.keys()];
  const reportKeys = { templateSteps: templateSources, roleNames };

  const prisma = database ?? new PrismaClient();
  const ownsPrisma = database === undefined;
  try {
    const projectRows = sortedProjectRows(await prisma.project.findMany({
      select: { id: true, slug: true },
      orderBy: { slug: "asc" },
    }));
    if (installFullProjectId !== null && !projectRows.some(({ id }) => id === installFullProjectId)) {
      throw new Error(`Project ${installFullProjectId} was not found`);
    }
    const canonicalProject = projectRows.find(({ slug }) => slug === "agentos-example");
    if (!canonicalProject) throw new Error("Canonical project agentos-example was not found");
    const orderedProjects = [
      canonicalProject,
      ...projectRows.filter(({ id }) => id !== canonicalProject.id),
    ];
    const outcomes: CanonicalSyncProjectOutcome[] = [];
    const runtimeConfigAdoptions: Array<{
      name: string;
      from: { model: string; runnerPreference: RunnerPreference };
      to: { model: string; runnerPreference: RunnerPreference };
    }> = [];

    for (const project of orderedProjects) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          // For a full installation, this must remain the first transaction
          // read so target deletion or Environment drift fails without writes.
          const fullInstallTarget = installFullProjectId === project.id
            ? await preflightFullInstallTarget(tx, project.id, roleNames)
            : null;
          if (!fullInstallTarget) {
            const present = await tx.project.findUnique({
              where: { id: project.id },
              select: { id: true },
            });
            if (!present) throw projectError(project, "Project was not found");
          }

          const projectCounters = emptyCanonicalSyncCounters(reportKeys);
          const transactionAdoptions: typeof runtimeConfigAdoptions = [];
          const staffingNotices: string[] = [];
          const installationRows = await readCanonicalInstallationRows(tx, project.id, templateSources);
          const installationPlan = planCanonicalInstallation(
            installationRows,
            templateSources,
            project.id === canonicalProject.id ? [project.id] : [],
          );
          const plannedRefusal = installationPlan.find((action): action is Extract<CanonicalInstallationAction, { kind: "refused" }> => action.kind === "refused");
          if (plannedRefusal) throw projectError(project, plannedRefusal.reason);
          for (const action of installationPlan) {
            if (action.kind === "create" || action.kind === "rollover") {
              projectCounters.createdCanonicalTemplates += 1;
            }
          }

          await adoptRenamedCanonicalRoles(tx, project.id, (message) => projectError(project, message));
          if (project.id === canonicalProject.id) {
            await migrateSpecialCanonicalAgents(tx, canonicalProject, sources, rolesByRole, projectCounters);
          }
          await synchronizeAgents(
            tx,
            project,
            project.id === canonicalProject.id,
            sources,
            rolesByRole,
            roleNames,
            projectCounters,
            transactionAdoptions,
          );

          const installation = await applyCanonicalInstallation(tx, installationPlan, templateSources, {
            projectLabel: () => project.slug,
          });
          staffingNotices.push(...installation.staffingNotices);
          await syncCanonicalTemplates(tx, project, templateSources, projectCounters);

          if (fullInstallTarget) {
            await installMissingAgents(tx, fullInstallTarget, sources, rolesByRole, roleNames, projectCounters);
            const postSyncRows = await readCanonicalInstallationRows(tx, project.id, templateSources);
            const fullInstallationPlan = planCanonicalInstallation(postSyncRows, templateSources, [project.id]);
            for (const action of fullInstallationPlan) {
              if (action.kind === "create" || action.kind === "rollover") {
                projectCounters.createdCanonicalTemplates += 1;
              }
            }
            const fullInstallation = await applyCanonicalInstallation(tx, fullInstallationPlan, templateSources, {
              projectLabel: () => project.slug,
            });
            staffingNotices.push(...fullInstallation.staffingNotices);
          }
          await installCanonicalDefaultStaffingProfiles(tx, project.id);
          return {
            counters: projectCounters,
            runtimeConfigAdoptions: transactionAdoptions,
            staffingNotices,
          };
        }, { timeout: 120_000 });
        outcomes.push({ kind: "synced", slug: project.slug, counters: result.counters });
        runtimeConfigAdoptions.push(...result.runtimeConfigAdoptions);
        for (const notice of result.staffingNotices) console.log(`Project ${project.slug}: ${notice}`);
      } catch (error) {
        if (project.id === canonicalProject.id || project.id === installFullProjectId) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const prefix = `Project ${project.slug}: `;
        const reason = message.startsWith(prefix) ? message.slice(prefix.length) : message;
        outcomes.push({ kind: "refused", slug: project.slug, reason: reason.replace(/\s+/gu, " ").trim() });
      }
    }

    for (const adoption of runtimeConfigAdoptions) {
      console.log(
        `Canonical runtime config adopted for Agent ${adoption.name}: `
        + `from model=${adoption.from.model}, runnerPreference=${adoption.from.runnerPreference} `
        + `to model=${adoption.to.model}, runnerPreference=${adoption.to.runnerPreference}`,
      );
    }
    const summary = canonicalSyncSummary(outcomes, reportKeys);
    for (const outcome of outcomes) {
      if (outcome.kind === "refused") console.log(`REFUSED ${outcome.slug}: ${outcome.reason}`);
      else console.log(`SYNCED ${outcome.slug}: ${JSON.stringify(summary.projects[outcome.slug])}`);
    }
    console.log(canonicalSyncSummaryLine(summary));
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
};

const invokedScript = process.argv[1];
if (invokedScript && fileURLToPath(import.meta.url) === resolve(invokedScript)) await main();
