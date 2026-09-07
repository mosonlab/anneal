import { AssigneeType, CodexServiceTier, PrismaClient } from "@prisma/client";

import { DIRECT_TEMPLATE_NAME, PR_TEMPLATE_NAME } from "../src/agent-contract.js";
import { loadAgentSources } from "../src/agent-sources.js";
import { findCanonicalAgent } from "../src/canonical-agent-lookup.js";
import {
  applyCanonicalInstallation,
  planCanonicalInstallation,
  type CanonicalInstallationRow,
} from "../src/canonical-template-installation.js";
import { installCanonicalDefaultStaffingProfiles } from "../src/staffing-profile-canonical.js";
import {
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_TEMPLATE_NAME,
} from "../src/merge-integrator.js";
import {
  legacyHumanTwelveStepTemplateName,
  legacyNineStepTemplateName,
  legacyRegressionFirstThirteenStepTemplateName,
  legacyTenStepTemplateName,
  legacyHumanSixStepTemplateName,
} from "../src/canonical-template-transition.js";
import { loadAllTemplateStepSources } from "../src/template-sources.js";

// The loader this seed used to carry moved to `packages/db/src/agent-sources.ts`
// so that OSS-B0's first-run onboarding can read the same `agents/` contract
// without running this seed, which creates the internal multi-role
// installation. Nothing this file seeds changed with the move.
const prisma = new PrismaClient();

// Canonical roles, not names: an operator may rename an Agent, and a historical
// template is still the template these roles bound.
const HISTORICAL_NINE_STEP_CONTRACT = [
  [1, "spec-opus-high", AssigneeType.AGENT, "spec", true],
  [2, "plan-fable-medium", AssigneeType.AGENT, "plan", false],
  [3, "review-coordinator-astra-medium", AssigneeType.AGENT, "plan-review", false],
  [4, "plan-reviser-opus-high", AssigneeType.AGENT, "revised-plan", true],
  [5, "plan-executor-astra-medium", AssigneeType.AGENT, "implementation", false],
  [6, "review-coordinator-astra-medium", AssigneeType.AGENT, "code-review", false],
  [7, "senior-dev-astra-medium", AssigneeType.AGENT, "fixed-implementation", false],
  [8, "librarian-luna-xhigh", AssigneeType.AGENT, "documentation", false],
  [9, null, AssigneeType.HUMAN, "approval", true],
] as const;

type HistoricalSeedTemplate = Readonly<{
  id: string;
  steps: readonly {
    stepIndex: number;
    assigneeType: AssigneeType;
    approvalGate: boolean;
    outputKind: string;
    assigneeAgent: { name: string; canonicalRole: string | null } | null;
  }[];
}>;

/** The role a step binds, falling back to the slug for an operator-made Agent. */
const stepRoleName = (step: HistoricalSeedTemplate["steps"][number] | undefined): string | null =>
  step?.assigneeAgent ? step.assigneeAgent.canonicalRole ?? step.assigneeAgent.name : null;

const historicalSeedLegacyName = (
  templateName: "compound-engineer-workflow" | "direct-engineer-workflow" | typeof PR_TEMPLATE_NAME,
  existing: HistoricalSeedTemplate,
): string | null => {
  if (templateName === PR_TEMPLATE_NAME) return null;
  if (templateName === "direct-engineer-workflow") {
    return existing.steps.length === 6
      && existing.steps[5]?.assigneeType === AssigneeType.HUMAN
      && existing.steps[5]?.outputKind === "approval"
      ? legacyHumanSixStepTemplateName(existing.id)
      : null;
  }

  const historicalIntegrator = existing.steps.find((step) => step.stepIndex === 10);
  const isHistoricalNineStepTemplate = existing.steps.length === HISTORICAL_NINE_STEP_CONTRACT.length
    && HISTORICAL_NINE_STEP_CONTRACT.every(([stepIndex, agentName, assigneeType, outputKind, approvalGate], index) => {
      const step = existing.steps[index];
      return step?.stepIndex === stepIndex
        && stepRoleName(step) === agentName
        && step.assigneeType === assigneeType
        && step.outputKind === outputKind
        && step.approvalGate === approvalGate;
    });
  const isHistoricalTenStepTemplate = existing.steps.length === 10
    && existing.steps.every((step, index) => step.stepIndex === index + 1)
    && historicalIntegrator?.outputKind === INTEGRATOR_OUTPUT_KIND
    && stepRoleName(historicalIntegrator) === INTEGRATOR_AGENT_NAME;
  const isHistoricalHumanTwelveStepTemplate = existing.steps.length === 12
    && existing.steps[10]?.assigneeType === AssigneeType.HUMAN
    && existing.steps[10]?.outputKind === "approval"
    && stepRoleName(existing.steps[11]) === INTEGRATOR_AGENT_NAME
    && existing.steps[11]?.outputKind === INTEGRATOR_OUTPUT_KIND;
  const isRegressionFirstThirteenStepTemplate = existing.steps.length === 13
    && existing.steps.every((step, index) => step.stepIndex === index + 1)
    && stepRoleName(existing.steps[9]) === "regression-verifier-luna-xhigh"
    && existing.steps[9]?.outputKind === "regression-verification"
    && stepRoleName(existing.steps[10]) === "librarian-luna-xhigh"
    && existing.steps[10]?.outputKind === "documentation"
    && existing.steps[11]?.outputKind === "merge-authorization"
    && stepRoleName(existing.steps[12]) === INTEGRATOR_AGENT_NAME
    && existing.steps[12]?.outputKind === INTEGRATOR_OUTPUT_KIND;

  if (isHistoricalHumanTwelveStepTemplate) return legacyHumanTwelveStepTemplateName(existing.id);
  if (isRegressionFirstThirteenStepTemplate) return legacyRegressionFirstThirteenStepTemplateName(existing.id);
  if (isHistoricalNineStepTemplate) return legacyNineStepTemplateName(existing.id);
  if (isHistoricalTenStepTemplate) return legacyTenStepTemplateName(existing.id);
  return null;
};

const main = async (): Promise<void> => {
  const [sources, templateStepsByName] = await Promise.all([loadAgentSources(), loadAllTemplateStepSources()]);
  const project = await prisma.project.upsert({
    where: { slug: "agentos-example" },
    update: {},
    create: {
      name: "Anneal Example",
      slug: "agentos-example",
      yamlDocument: "# Managed by Anneal; YAML sync arrives after v1.\n",
    },
  });

  const environment = await prisma.environment.upsert({
    where: { projectId_name: { projectId: project.id, name: "local" } },
    update: {},
    create: {
      projectId: project.id,
      name: "local",
      networking: "OPEN",
      allowedHosts: [],
    },
  });

  for (const role of sources.roles) {
    // Canonical identity is `canonicalRole`, not `name`: the operator may rename
    // an Agent, and the seed still has to find the row it installed. A row that
    // predates the column is adopted by name once, on this pass.
    const existing = await findCanonicalAgent(prisma, {
      projectId: project.id,
      canonicalRole: role.canonicalRole,
      activeOnly: false,
    });
    const customized = new Set(existing?.customizedFields ?? []);
    const canonical = <T>(field: string, value: T): { [key: string]: T } | Record<string, never> => (
      customized.has(field) ? {} : { [field]: value }
    );
    if (existing) {
      await prisma.agent.update({
        where: { id: existing.id },
        data: {
          canonicalRole: role.canonicalRole,
          environmentId: environment.id,
          ...canonical("name", role.name),
          ...canonical("title", role.title),
          ...canonical("model", role.model),
          ...canonical("runnerPreference", role.runnerPreference),
          inboxAccess: role.inboxAccess,
          foundationalPrompt: sources.foundationalPrompt,
          rolePrompt: role.rolePrompt,
        },
      });
      continue;
    }
    await prisma.agent.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        canonicalRole: role.canonicalRole,
        name: role.name,
        title: role.title,
        model: role.model,
        customizedFields: [],
        codexServiceTier: CodexServiceTier.DEFAULT,
        runnerPreference: role.runnerPreference,
        inboxAccess: role.inboxAccess,
        foundationalPrompt: sources.foundationalPrompt,
        rolePrompt: role.rolePrompt,
      },
    });
  }

  const projectAgents = await prisma.agent.findMany({ where: { projectId: project.id } });
  const agentByRole = new Map(projectAgents.flatMap((agent) => (
    agent.canonicalRole === null ? [] : [[agent.canonicalRole, agent] as const]
  )));
  const seededAgentIds = sources.roles.map((role) => {
    const agent = agentByRole.get(role.canonicalRole);
    if (!agent) throw new Error(`Missing seeded agent ${role.canonicalRole}`);
    return agent.id;
  });
  // The agents/ contract no longer seeds skills; this clears links a prior
  // seed created, so a re-seeded installation matches the contract.
  await prisma.agentSkill.deleteMany({ where: { agentId: { in: seededAgentIds } } });
  await prisma.agentCollaboration.deleteMany({ where: { agentId: { in: seededAgentIds } } });
  for (const role of sources.roles) {
    const agent = agentByRole.get(role.canonicalRole)!;
    // Frontmatter collaborators name role files, so they resolve by canonical
    // identity too: a renamed Agent keeps the edges its role declares.
    for (const collaboratorName of role.collaborators) {
      const collaborator = agentByRole.get(collaboratorName);
      if (!collaborator || !seededAgentIds.includes(collaborator.id)) {
        throw new Error(`Agent ${role.canonicalRole} references unknown collaborator ${collaboratorName}`);
      }
      await prisma.agentCollaboration.create({
        data: { agentId: agent.id, allowedAgentId: collaborator.id, projectId: project.id },
      });
    }
  }
  const canonicalNames = [INTEGRATOR_TEMPLATE_NAME, DIRECT_TEMPLATE_NAME, PR_TEMPLATE_NAME] as const;
  await prisma.$transaction(async (tx) => {
    const installationRows: CanonicalInstallationRow[] = [];
    for (const templateName of canonicalNames) {
      const existing = await tx.taskTemplate.findUnique({
        where: { projectId_name: { projectId: project.id, name: templateName } },
        include: {
          steps: {
            include: { assigneeAgent: { select: { name: true, canonicalRole: true } } },
            orderBy: { stepIndex: "asc" },
          },
        },
      });
      if (!existing) continue;
      installationRows.push({
        ...existing,
        name: templateName,
        steps: existing.steps as unknown as CanonicalInstallationRow["steps"],
        legacyNameOverride: historicalSeedLegacyName(templateName, existing),
      });
    }

    const plan = planCanonicalInstallation(installationRows, templateStepsByName, [project.id]);
    await applyCanonicalInstallation(
      tx,
      plan,
      templateStepsByName,
      { synchronizeCurrent: true },
    );
    await installCanonicalDefaultStaffingProfiles(tx, project.id);
    const templates = await tx.taskTemplate.findMany({
      where: { projectId: project.id, name: { in: [...canonicalNames] } },
    });
    if (templates.length !== canonicalNames.length) {
      throw new Error(`Canonical installation produced ${templates.length} of ${canonicalNames.length} templates`);
    }
  }, { timeout: 30_000 });

  console.log(`Seeded ${project.name} from agents/ with ${sources.roles.length} agents, the twelve-step feature template, the eight-step bound-capable direct template, and the four-step ${PR_TEMPLATE_NAME} pull-request template.`);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
