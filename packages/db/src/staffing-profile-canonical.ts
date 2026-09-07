import type { Prisma } from "@prisma/client";

import { DIRECT_TEMPLATE_NAME, PR_TEMPLATE_NAME } from "./agent-contract.js";
import { STAFFING_PROFILE_TIERS, type StaffingProfileTiers } from "./console-contract.js";
import { findCanonicalAgent } from "./canonical-agent-lookup.js";
import { INTEGRATOR_TEMPLATE_NAME } from "./merge-integrator.js";
import { isMergeReadinessStep } from "./merge-tail.js";

/** The canonical Agent that owns residual merge-tail repairs by default. */
export const MERGE_TAIL_REPAIR_AGENT_ROLE = "senior-dev-luna-max" as const;

/** The active templates whose canonical Default profile carries the repair slot. */
export const MERGE_TAIL_REPAIR_PROFILE_TEMPLATE_NAMES = [
  INTEGRATOR_TEMPLATE_NAME,
  DIRECT_TEMPLATE_NAME,
  PR_TEMPLATE_NAME,
] as const;

export type MergeTailRepairProfileTemplateName =
  (typeof MERGE_TAIL_REPAIR_PROFILE_TEMPLATE_NAMES)[number];

/** The source-owned profile name installed for a canonical template. */
export const CANONICAL_STAFFING_PROFILE_NAME = "Default" as const;

/** The tier keys persisted by every staffing profile. Keep this list ordered
 * for stable API payloads and deterministic writes. */
export { STAFFING_PROFILE_TIERS } from "./console-contract.js";
export type StaffingProfileTierKey = (typeof STAFFING_PROFILE_TIERS)[number];

/** Canonical Agent role installed for each implementation tier. */
export const CANONICAL_STAFFING_TIER_ROLES: Readonly<Record<StaffingProfileTierKey, string>> = {
  default: "senior-dev-luna-max",
  frontend: "frontend-dev-opus-medium",
  hard: "senior-dev-astra-low",
  hazard: "senior-dev-astra-medium",
};

/** Resolve every tier from the same active canonical roster for reset and install. */
export const canonicalTierSlots = async (
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<StaffingProfileTiers> => {
  const slots = {} as StaffingProfileTiers;
  for (const tier of STAFFING_PROFILE_TIERS) {
    const agent = await findCanonicalAgent(tx, {
      projectId, canonicalRole: CANONICAL_STAFFING_TIER_ROLES[tier], activeOnly: true,
    });
    slots[tier] = agent?.id ?? null;
  }
  return slots;
};

/** Canonical profile entries share the platform's merge-readiness predicate. */
export const canonicalStaffingEntries = (
  steps: readonly { stepIndex: number; outputKind: string; assigneeAgentId: string | null; optional: boolean }[],
): { outputKind: string; assigneeAgentId: string | null; include: boolean | null }[] => steps.map((step) => ({
  outputKind: step.outputKind,
  assigneeAgentId: isMergeReadinessStep(step) ? null : step.assigneeAgentId,
  include: step.optional ? true : null,
}));

/**
 * Resolve the source-owned repair slot for a template. Custom and retired
 * template names intentionally return null; their profiles retain the
 * operator's choice or the ordinary fixed-implementation fallback.
 */
export const canonicalMergeTailRepairAgentRole = (
  templateName: string,
): typeof MERGE_TAIL_REPAIR_AGENT_ROLE | null => (
  (MERGE_TAIL_REPAIR_PROFILE_TEMPLATE_NAMES as readonly string[]).includes(templateName)
    ? MERGE_TAIL_REPAIR_AGENT_ROLE
    : null
);

/**
 * Install the three canonical Default profiles on a fresh seeded project.
 * Existing profiles are left alone so a seed rerun cannot erase operator
 * staffing decisions. The caller owns the surrounding transaction.
 */
export const installCanonicalDefaultStaffingProfiles = async (
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<number> => {
  const templates = await tx.taskTemplate.findMany({
    where: {
      projectId,
      name: { in: [...MERGE_TAIL_REPAIR_PROFILE_TEMPLATE_NAMES] },
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      steps: {
        orderBy: { outputKind: "asc" },
        select: { stepIndex: true, outputKind: true, assigneeAgentId: true, optional: true },
      },
    },
  });
  if (templates.length === 0) return 0;

  const agent = await findCanonicalAgent(tx, {
    projectId,
    canonicalRole: MERGE_TAIL_REPAIR_AGENT_ROLE,
    activeOnly: true,
  });
  // Ordinary canonical sync can inspect a legacy template before the special
  // role inventory has been installed in that Project. Leave it profile-less
  // for this pass; full installation calls again after installing the role.
  if (!agent) return 0;

  const tierSlots = await canonicalTierSlots(tx, projectId);

  let created = 0;
  for (const template of templates) {
    // A template with any profile is operator-owned. Recreating a missing
    // Default row would silently change which plan instantiation selects.
    const existing = await tx.staffingProfile.count({ where: { taskTemplateId: template.id } });
    if (existing > 0) continue;

    await tx.staffingProfile.create({
      data: {
        id: `staffing_${template.id}`,
        projectId,
        taskTemplateId: template.id,
        name: CANONICAL_STAFFING_PROFILE_NAME,
        isDefault: true,
        mergeTailRepairAgentId: agent.id,
        entries: {
          create: canonicalStaffingEntries(template.steps),
        },
        tiers: {
          create: STAFFING_PROFILE_TIERS.flatMap((tier) => {
            const agentId = tierSlots[tier];
            return agentId === null ? [] : [{ tier, agentId }];
          }),
        },
      },
    });
    created += 1;
  }
  return created;
};
