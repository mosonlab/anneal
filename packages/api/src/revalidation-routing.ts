import { lockAgentRepoGrant, lockAgentRow, lockChainRows, Prisma, RepoPermission } from "@anneal/db";
import { legacyBriefMigration, readBrief } from "./task-brief.js";
import { parseImplementationRoute } from "./templates.js";

type JudgedRoute = { tier: "default" | "frontend" | "hard" | "hazard"; reason: string };
const object = (value: Prisma.JsonValue | null | undefined): Prisma.JsonObject | null => (
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : null
);

/** Called only for validated canonical revalidation output, in its storage transaction. */
export const applyRevalidationRoute = async (
  tx: Prisma.TransactionClient,
  revalidationTaskId: string,
  route: JudgedRoute,
): Promise<void> => {
  const source = await tx.task.findUnique({
    where: { id: revalidationTaskId },
    select: { projectId: true, chainId: true, templateId: true },
  });
  if (!source?.chainId || !source.templateId) return;
  // Run birth and task mutations share these locks. Read the implementation's
  // runs and assignee only after acquiring them, so a concurrent start cannot
  // snapshot one Agent while this transaction assigns another.
  await lockChainRows(tx, { projectId: source.projectId, chainId: source.chainId });
  const implementation = await tx.task.findFirst({
    where: { projectId: source.projectId, chainId: source.chainId, templateId: source.templateId, templateStep: { outputKind: "implementation" } },
    select: {
      id: true, repoId: true, description: true, assigneeAgentId: true,
      assigneeAgent: { select: { id: true, name: true } },
      templateStep: { select: { priorOutputKinds: true } },
      runs: { select: { id: true }, take: 1 },
    },
  });
  if (!implementation) return;
  const previous = implementation.assigneeAgent;
  const root = await tx.task.findFirst({
    where: { projectId: source.projectId, chainId: source.chainId, templateId: source.templateId },
    orderBy: { chainIndex: "asc" }, select: { id: true },
  });
  const provenance = root ? await tx.taskActivity.findFirst({
    where: { taskId: root.id, body: { startsWith: "Template instantiated" } },
    orderBy: { createdAt: "asc" }, select: { metadata: true },
  }) : null;
  const profileId = object(provenance?.metadata)?.staffingProfileId;
  const implementationProvenance = await tx.taskActivity.findFirst({
    where: { taskId: implementation.id, body: { startsWith: "Template instantiated" } },
    orderBy: { createdAt: "asc" }, select: { metadata: true },
  });
  const override = object(implementationProvenance?.metadata)?.implementationAssigneeOverride;
  const brief = readBrief(implementation.description, legacyBriefMigration(implementation.templateStep));
  let decision: "applied" | "overridden" | "unstaffed" | "already-running" | "refused";
  let detail: string;
  let next = previous;
  if (implementation.runs.length > 0) {
    decision = "already-running";
    detail = "implementation already has a Run; assignment unchanged";
  } else if (override === "stepOverrides" || override === "Route" || (!("unparseable" in brief) && parseImplementationRoute(brief.brief) !== null)) {
    decision = "overridden";
    detail = `judged tier overridden by ${override === "stepOverrides" ? "explicit stepOverrides assignee" : "brief Route line"}`;
  } else if ("unparseable" in brief) {
    decision = "refused";
    detail = `cannot establish Route precedence: ${brief.unparseable}`;
  } else {
    // Never substitute today's default profile for the profile this Chain used.
    const profile = typeof profileId === "string" ? await tx.staffingProfile.findFirst({
      where: { id: profileId, projectId: source.projectId, taskTemplateId: source.templateId },
      select: { tiers: { where: { tier: route.tier }, select: { agent: { select: { id: true, name: true } } } } },
    }) : null;
    const candidate = profile?.tiers[0]?.agent;
    if (!candidate) {
      decision = "unstaffed";
      detail = "judged tier was unstaffed in the Chain's recorded profile; assignment unchanged";
    } else {
      const agent = await lockAgentRow(tx, candidate.id);
      const grant = agent && !agent.archivedAt && agent.projectId === source.projectId && implementation.repoId
        ? await lockAgentRepoGrant(tx, { projectId: source.projectId, agentId: agent.id, repoId: implementation.repoId })
        : false;
      const writable = grant && await tx.agentRepoAccess.findFirst({
        where: { projectId: source.projectId, agentId: candidate.id, repoId: implementation.repoId!, permissions: RepoPermission.GIT_WRITE },
        select: { agentId: true },
      });
      if (!writable) {
        decision = "refused";
        detail = `judged Agent ${candidate.name} (${candidate.id}) refused: active project Agent with GIT_WRITE Repo grant required (step_override_missing_repo_grant)`;
      } else {
        decision = "applied";
        next = candidate;
        detail = "judged tier applied";
        await tx.task.update({ where: { id: implementation.id }, data: { assigneeAgentId: candidate.id } });
      }
    }
  }
  await tx.taskActivity.create({ data: {
    taskId: implementation.id,
    actorType: "control-plane",
    body: `Implementation tier ${route.tier}: ${route.reason}; ${detail}. Previous Agent: ${previous ? `${previous.name} (${previous.id})` : "none"}; new Agent: ${next ? `${next.name} (${next.id})` : "none"}.`,
    metadata: {
      kind: "revalidation.implementationRoute", tier: route.tier, reason: route.reason, decision,
      revalidationTaskId, staffingProfileId: typeof profileId === "string" ? profileId : null,
      previousAgentId: previous?.id ?? null, newAgentId: next?.id ?? null,
    },
  } });
};
