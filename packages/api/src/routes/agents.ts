import {
  ACTIVE_RUN_STATUSES,
  agentArchiveBlocker,
  catalogRunnerForModel,
  CodexServiceTier,
  INTEGRATOR_AGENT_NAME,
  isCompoundImplementationStep,
  loadAgentSources,
  lockAgentRepoGrantForRevocation,
  lockAgentRow,
  Prisma,
  RepoPermission,
  RunnerKind,
  runnerFor,
  RunnerPreference,
  SkillKind,
  TaskStatus,
} from "@anneal/db";
import type {
  Agent as AgentContract,
  AgentRepoAccess as AgentRepoAccessContract,
  DependencyProvisioning,
  FilesystemGrant as FilesystemGrantContract,
  MCPConnection as MCPConnectionContract,
  Repo as RepoContract,
  Skill as SkillContract,
} from "@anneal/db/wire-contract";
import type { Context } from "hono";
import { z } from "zod";

import { jsonValue } from "../execution.js";
import { filesRootGrantKey } from "../files/config.js";
import { isCanonicalRelPath, normalizeRelPath } from "../files/paths.js";
import { isValidBranchName, parseRepoRemote } from "../onboarding.js";
import { RepositoryPreflightError } from "../onboarding-preflight.js";
import { noteArchivedQueuedRuns } from "../reconcile.js";
import {
  AGENT_REFERENCED,
  REPO_REFERENCED,
  resourceDeleteRefusalStatusFor,
} from "../resource-delete-errors.js";
import { AGENT_REFERENCED_BY_STAFFING_PROFILES } from "../staffing-profile-errors.js";
import { profilesReferencingAgent } from "../staffing-profiles.js";
import { readCommitted, serializable } from "../transaction.js";
import { withoutUndefined } from "../without-undefined.js";
import {
  id,
  readJson,
  refusal,
  refusalJson,
  secretPublicSelect,
  validated,
} from "./support.js";
import type { RouteApp, RouteDeps } from "./support.js";

/**
 * The eight canonical tool keys. Mirrored by apps/web/src/lib/tools.ts (labels and
 * per-runner enforcement) and packages/runner/src/adapters.ts (CLI flag names).
 * The three lists cross workspaces and cannot import each other; each names the
 * other two so a change here is followed there.
 */
const TOOL_KEYS = ["BASH", "READ", "WRITE", "EDIT", "GLOB", "GREP", "WEB_FETCH", "WEB_SEARCH"] as const;
const agentFields = {
  environmentId: id,
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(120),
  codexServiceTier: z.nativeEnum(CodexServiceTier),
  foundationalPrompt: z.string().min(1),
  rolePrompt: z.string().min(1),
  runnerPreference: z.nativeEnum(RunnerPreference),
  inboxAccess: z.boolean(),
  // Denied set, not allowed set: omitting it keeps the column's empty default.
  disabledTools: z.array(z.enum(TOOL_KEYS)).max(TOOL_KEYS.length),
};
const agentInput = z.object({
  ...agentFields,
  foundationalPrompt: agentFields.foundationalPrompt.optional(),
  codexServiceTier: agentFields.codexServiceTier.default(CodexServiceTier.DEFAULT),
  runnerPreference: agentFields.runnerPreference.default(RunnerPreference.INHERIT),
  inboxAccess: agentFields.inboxAccess.default(false),
  // `.default([])` rather than `.optional()`: under exactOptionalPropertyTypes an
  // optional key would spread `undefined` into `agent.create`. The empty array is
  // byte-identical to the column default, so omission still means "no restriction".
  disabledTools: agentFields.disabledTools.default([]),
});
const agentPatch = z.object(agentFields).partial().refine((value) => Object.keys(value).length > 0);

/**
 * The fields canonical sync adopts until the operator edits them (R9). Prompts are
 * absent on purpose: they always follow canonical, so editing one marks nothing.
 */
const CUSTOMIZABLE_AGENT_FIELDS = ["name", "title", "model", "runnerPreference"] as const;

const codexServiceTierRefusal = (agent: {
  model: string;
  runnerPreference: RunnerPreference;
  codexServiceTier: CodexServiceTier;
}): string | null => {
  if (agent.codexServiceTier === CodexServiceTier.DEFAULT) return null;
  const model = agent.model.slice(0, agent.model.lastIndexOf(":") > 0 ? agent.model.lastIndexOf(":") : agent.model.length);
  const runner = runnerFor(agent.runnerPreference, agent.model);
  if (runner === RunnerKind.CODEX && model.startsWith("gpt-")) return null;
  if (runner === RunnerKind.PI && model.startsWith("openai-codex/")) return null;
  return "Fast service tier requires a Codex gpt-* model or a PI openai-codex/* model";
};

const runnerModelRefusal = (agent: { model: string; runnerPreference: RunnerPreference }): string | null => {
  const expected = catalogRunnerForModel(agent.model);
  if (!expected || agent.runnerPreference === RunnerPreference.AUTO || agent.runnerPreference === RunnerPreference.INHERIT
    || expected === agent.runnerPreference) return null;
  return `Model ${agent.model} requires ${expected}, but this Agent stores ${agent.runnerPreference}`;
};

/**
 * The compound implementation root is a capability requirement, not a name: the
 * step drives an entire plan through subagents and only a Codex `gpt-*` runtime
 * can. Which Agent holds it is now a staffing choice, so this refusal follows the
 * binding — an Agent bound to that step cannot be patched onto another runtime,
 * and one that is not may take any runtime it likes.
 */
const compoundImplementationRuntimeRefusal = (
  agent: { model: string; runnerPreference: RunnerPreference },
  bindsCompoundImplementationRoot: boolean,
): string | null => {
  if (!bindsCompoundImplementationRoot) return null;
  if (runnerFor(agent.runnerPreference, agent.model) === RunnerKind.CODEX
    && catalogRunnerForModel(agent.model) === RunnerPreference.CODEX) return null;
  return "An Agent bound to a compound implementation root requires a Codex gpt-* model";
};

const runtimeConfigRefusal = (agent: {
  model: string;
  runnerPreference: RunnerPreference;
  codexServiceTier: CodexServiceTier;
}): string | null => (
  runnerModelRefusal(agent)
  ?? codexServiceTierRefusal(agent)
);

/** Does this Agent hold a compound implementation root on any template step? */
const bindsCompoundImplementationRoot = async (
  tx: Prisma.TransactionClient,
  agentId: string,
): Promise<boolean> => (await tx.taskTemplateStep.findMany({
  where: { assigneeAgentId: agentId },
  select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
})).some((step) => isCompoundImplementationStep(step));

const isDependencyProvisioning = (value: unknown): value is DependencyProvisioning => (
  value === "NONE" || value === "NPM_CI"
);
const dependencyProvisioningInput = z.unknown().optional();
const dependencyProvisioningInvalid = {
  error: "Repository dependency provisioning is invalid",
  code: "repository-dependency-provisioning-invalid",
} as const;

const repositoryPreflightRefusal = (context: Context, error: unknown): Response | undefined => {
  if (!(error instanceof RepositoryPreflightError)) return undefined;
  if (error.reason === "package-lock-missing") {
    return context.json({
      error: "Repository preflight failed",
      code: "repository-package-lock-missing",
      remedy: "Commit package-lock.json at the repository root on the default branch, or choose dependencyProvisioning NONE.",
    }, 422);
  }
  if (error.reason === "dependency-provisioning-contradicts-lockfile") {
    return context.json({
      error: "Repository dependency provisioning contradicts lockfile",
      code: "repository-dependency-provisioning-contradicts-lockfile",
      remedy: "Choose dependencyProvisioning NPM_CI for repositories with a root package-lock.json.",
    }, 400);
  }
  return context.json({
    error: "Repository preflight failed",
    code: "repository-preflight-failed",
    reason: error.reason,
  }, 422);
};

const repoInput = z.object({
  name: z.string().trim().min(1).max(120),
  remoteUrl: z.string().trim().min(1),
  mountPath: z.string().trim().min(1).default("repo"),
  defaultBranch: z.string().trim().min(1).default("main"),
  credentialSecretId: id.nullable().default(null),
  dependencyProvisioning: dependencyProvisioningInput,
});
// Keep remoteUrl raw wherever repository policy runs. A leading newline or
// trailing tab is itself invalid input; trimming before parseRepoRemote would
// silently turn it into a different, accepted value.
const repoCreateInput = repoInput.extend({
  remoteUrl: z.string(),
  grantAgents: z.boolean().default(false),
});
const repoAccessInput = z.object({
  permissions: z.nativeEnum(RepoPermission).default(RepoPermission.GIT_WRITE),
  mountPath: z.string().trim().min(1).default("repo"),
});
const repoPatch = repoInput.partial().extend({
  remoteUrl: z.string().refine((value) => value.trim().length > 0).optional(),
}).refine((value) => Object.keys(value).length > 0);
const secretGrantInput = z.object({ secretId: id, envVar: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) });
const skillBindingInput = z.object({ skillId: id });
const mcpBindingInput = z.object({ mcpConnectionId: id });
const skillInput = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  kind: z.nativeEnum(SkillKind),
  body: z.string().nullable().default(null),
  filePath: z.string().trim().min(1).nullable().default(null),
}).superRefine((value, context) => {
  if (value.kind === SkillKind.PROMPT && value.body === null) context.addIssue({ code: "custom", message: "Prompt skills require body" });
  if (value.kind === SkillKind.FILE && value.filePath === null) context.addIssue({ code: "custom", message: "File skills require filePath" });
});
const mcpConnectionInput = z.object({
  name: z.string().trim().min(1).max(120),
  transport: z.string().trim().min(1).max(80),
  config: z.record(z.string(), z.unknown()).default({}),
  allowedOperations: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
  credentialSecretId: id.nullable().default(null),
});
const filesystemGrantFields = z.object({
  // "" is the sentinel for "the whole Files Root" (schema.prisma), so validation has to run
  // on the pre-trim value: a trailing `.trim()` before `.refine()` turns " " into ""
  // and hands a typo the entire root. Trimming still happens, but only for a real path.
  folderPath: z.string().max(4096).refine(
    (value) => (value.trim() === "" ? value === "" : isCanonicalRelPath(value.trim())),
    'folderPath must be "" (the whole Files Root) or a normalized Files-Root-relative POSIX path',
  ).transform((value) => value.trim()),
  canRead: z.boolean().default(false),
  canWrite: z.boolean().default(false),
  canDelete: z.boolean().default(false),
});
const filesystemGrantInput = filesystemGrantFields.refine(
  (value) => value.canRead || value.canWrite || value.canDelete,
  "At least one filesystem permission is required",
);
const filesystemGrantPatch = filesystemGrantFields.partial().refine((value) => Object.keys(value).length > 0);
const collaboratorInput = z.object({ allowedAgentId: id });

type AgentResponse = AgentContract<Date>;

/**
 * §D-P4. The sentinel Agent row exists so the merge step can carry a non-null
 * `Run.agentId`; it is not something an operator may assign. It is returned
 * rather than hidden so an operator can still see that it exists and read its
 * role prompt, but `assignable: false` is what the pickers filter on — and
 * `POST /projects/:projectId/tasks` refuses it regardless of any client.
 *
 * Sentinel identity is the canonical role: `merge-integrator` is the one slug the
 * rename table leaves alone, and a row that carries the role is the sentinel even
 * if its name was edited.
 */
const isMechanical = (agent: { name: string; canonicalRole: string | null }): boolean => (
  (agent.canonicalRole ?? agent.name) === INTEGRATOR_AGENT_NAME
);

const agentResponse = <T extends { name: string; canonicalRole: string | null }>(agent: T): T & {
  mechanical: boolean;
  assignable: boolean;
} => {
  const mechanical = isMechanical(agent);
  return { ...agent, mechanical, assignable: !mechanical };
};

type SkillResponse = SkillContract<Date>;
type MCPConnectionResponse = MCPConnectionContract<Date>;
type RepoResponse = RepoContract<Date>;

export const registerAgentsRoutes = (app: RouteApp, deps: RouteDeps): void => {
  const { db } = deps;

  app.get("/projects/:projectId/agents", async (context) => validated(context, (await db.agent.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })).map(agentResponse) satisfies AgentResponse[]));
  app.post("/projects/:projectId/agents", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, agentInput);
    const runtimeRefusal = runtimeConfigRefusal(body);
    if (runtimeRefusal) return context.json({ error: runtimeRefusal }, 400);
    const environment = await db.environment.findFirst({ where: { id: body.environmentId, projectId } });
    if (!environment) return context.json({ error: "Environment does not belong to this project" }, 400);
    const foundationalPrompt = body.foundationalPrompt ?? (await db.agent.findFirst({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: { foundationalPrompt: true },
    }))?.foundationalPrompt;
    if (foundationalPrompt === undefined) {
      return context.json({ error: "This project has no foundation yet. Run npm run db:seed." }, 400);
    }
    return context.json(agentResponse(await db.agent.create({
      data: { ...body, foundationalPrompt, projectId },
    })) satisfies AgentResponse, 201);
  });
  app.get("/agents/:agentId", async (context) => {
    const agent = await db.agent.findUnique({
      where: { id: id.parse(context.req.param("agentId")) },
      include: {
        environment: true,
        skills: { include: { skill: true } },
        mcpConnections: { include: { mcpConnection: true } },
        repoAccess: { include: { repo: true } },
        secretGrants: { include: { secret: { select: secretPublicSelect } } },
        filesystemGrants: true,
        collaborators: { include: { allowedAgent: true } },
      },
    });
    return agent ? context.json(agentResponse(agent) satisfies AgentResponse) : context.json({ error: "Agent not found" }, 404);
  });
  app.patch("/agents/:agentId", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const body = await readJson(context.req.raw, agentPatch);
    const result = await db.$transaction(async (tx) => {
      const before = await lockAgentRow(tx, agentId);
      if (!before) return refusal("not-found", "Agent not found");
      const patch = withoutUndefined(body);
      const merged = { ...before, ...patch };
      if (isMechanical(before) && merged.name !== before.name) {
        return refusal("invalid-request", `${INTEGRATOR_AGENT_NAME} is the mechanical merge sentinel and its name cannot be changed`);
      }
      const runtimeRefusal = runtimeConfigRefusal(merged)
        ?? compoundImplementationRuntimeRefusal(merged, await bindsCompoundImplementationRoot(tx, agentId));
      if (runtimeRefusal) return refusal("invalid-request", runtimeRefusal);
      if (body.environmentId) {
        const environment = await tx.environment.findFirst({ where: { id: body.environmentId, projectId: before.projectId } });
        if (!environment) return refusal("invalid-request", "Environment does not belong to this project");
      }
      // R9: an edited field stops following canonical. Only a field whose value
      // actually changes is marked, so re-submitting the canonical value in a form
      // does not pin it.
      const edited = CUSTOMIZABLE_AGENT_FIELDS.filter((field) => (
        body[field] !== undefined && body[field] !== before[field]
      ));
      const customizedFields = [...new Set([...before.customizedFields, ...edited])].sort();
      return { agent: await tx.agent.update({
        where: { id: agentId },
        data: {
          ...patch,
          ...(edited.length > 0 ? { customizedFields } : {}),
        } as Prisma.AgentUncheckedUpdateInput,
      }) };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(agentResponse(result.agent) satisfies AgentResponse);
  });
  app.post("/agents/:agentId/reset-runtime-config", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    // Load the complete role contract before opening the write transaction. A
    // missing or malformed source is a release error and must not turn into a
    // best-effort reset that guesses at the canonical values.
    const sources = await loadAgentSources();
    const rolesByRole = new Map(sources.roles.map((role) => [role.canonicalRole, role]));
    const result = await db.$transaction(async (tx) => {
      const before = await lockAgentRow(tx, agentId);
      if (!before) return refusal("not-found", "Agent not found");
      if (before.archivedAt) return refusal("conflict", "Cannot reset runtime configuration for an archived Agent");
      // The source is found by canonical role, not by name: an Agent the operator
      // renamed is still the role it was installed from, and that is the runtime
      // configuration a reset restores.
      const role = before.canonicalRole === null ? undefined : rolesByRole.get(before.canonicalRole);
      if (!role) return refusal("invalid-request", `Agent ${before.name} has no canonical role source`);
      const runtimeRefusal = runtimeConfigRefusal({
        model: role.model,
        runnerPreference: role.runnerPreference,
        codexServiceTier: before.codexServiceTier,
      }) ?? compoundImplementationRuntimeRefusal(
        { model: role.model, runnerPreference: role.runnerPreference },
        await bindsCompoundImplementationRoot(tx, agentId),
      );
      if (runtimeRefusal) return refusal("invalid-request", runtimeRefusal);
      return { agent: await tx.agent.update({
        where: { id: agentId },
        data: {
          model: role.model,
          runnerPreference: role.runnerPreference,
          // Only the fields this reset actually restores stop being customized.
          customizedFields: before.customizedFields.filter((field) => (
            field !== "model" && field !== "runnerPreference"
          )),
          runtimeConfigDriftNoticeFingerprint: null,
        },
      }) };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(agentResponse(result.agent) satisfies AgentResponse);
  });
  app.delete("/agents/:agentId", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const result = await serializable(db, async (tx) => {
      const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { id: true } });
      if (!agent) return refusal("not-found", "Agent not found");
      const [tasks, runs, sessions, staffingProfiles] = await Promise.all([
        tx.task.count({ where: { assigneeAgentId: agentId } }),
        tx.run.count({ where: { agentId } }),
        tx.session.count({ where: { agentId } }),
        tx.staffingProfile.count({ where: {
          OR: [
            { mergeTailRepairAgentId: agentId },
            { entries: { some: { assigneeAgentId: agentId } } },
            { tiers: { some: { agentId } } },
          ],
        } }),
      ]);
      const references = { tasks, runs, sessions, staffingProfiles };
      if (tasks > 0 || runs > 0 || sessions > 0 || staffingProfiles > 0) return { references };
      await tx.agent.delete({ where: { id: agentId } });
      return { deleted: true as const };
    });
    if ("message" in result) return refusalJson(context, result);
    if ("references" in result) {
      return context.json({
        error: "Agent has task, run, session, or staffing profile references; remove them before deleting it",
        code: AGENT_REFERENCED,
        references: result.references,
      }, resourceDeleteRefusalStatusFor(AGENT_REFERENCED));
    }
    return context.body(null, 204);
  });
  // Archive is one side of the Agent-row exclusion protocol (see lockAgentRow).
  // It takes the same mutex every assignment and run writer takes, and inside it
  // it fails closed: an agent with a live task or run reference stays unarchived
  // rather than stranding work nothing will ever claim. Re-archiving an already
  // archived agent stays idempotent and keeps the original timestamp.
  app.post("/agents/:agentId/archive", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const now = new Date();
    const result = await readCommitted(db, async (tx) => {
      const locked = await lockAgentRow(tx, agentId);
      if (!locked) return refusal("not-found", "Agent not found");
      const agent = await tx.agent.findUniqueOrThrow({ where: { id: agentId } });
      if (agent.archivedAt) return { agent };
      const blocker = await agentArchiveBlocker(tx, agentId);
      if (blocker) return refusal("conflict", blocker);
      // R6: a staffing profile that names this Agent is an operator decision,
      // not history. Archiving under it would silently re-staff every chain the
      // profile answers, so the refusal names the profiles to edit. Read under
      // the same Agent-row mutex a profile save takes, so the list cannot be
      // stale by the time it is answered.
      const staffing = await profilesReferencingAgent(tx, agentId);
      if (staffing.length > 0) return { staffingProfiles: staffing };
      return { agent: await tx.agent.update({ where: { id: agentId }, data: { archivedAt: now } }) };
    });
    if ("message" in result) return refusalJson(context, result);
    if ("staffingProfiles" in result) {
      return context.json({
        error: "Agent is named by a staffing profile; change those profiles before archiving it",
        code: AGENT_REFERENCED_BY_STAFFING_PROFILES,
        profiles: result.staffingProfiles,
      }, 409);
    }
    // Unchanged sweep: rows archived before this protocol existed — or queued by
    // a writer that committed first — still get their explanatory activity.
    await noteArchivedQueuedRuns(db, { agentId });
    return context.json(agentResponse(result.agent) satisfies AgentResponse);
  });
  app.post("/agents/:agentId/unarchive", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const agent = await db.agent.findUnique({ where: { id: agentId } });
    if (!agent) return context.json({ error: "Agent not found" }, 404);
    if (!agent.archivedAt) return context.json(agentResponse(agent) satisfies AgentResponse);
    return context.json(agentResponse(await db.agent.update({
      where: { id: agentId },
      data: { archivedAt: null },
    })) satisfies AgentResponse);
  });
  /**
   * Duplicate an Agent so two staffings of one role can coexist — the same job at
   * two models, say. The copy is a new Agent with the same setup: prompts, runtime,
   * tools, environment, and every grant and binding that describes what it may
   * reach. What it deliberately does not copy is history and inbound trust:
   * tasks, steps, sessions, runs and inbox belong to the original, and another
   * Agent's decision to allow this one as a collaborator is that Agent's to make.
   * It is a copy, not the canonical role, so `canonicalRole` is null and
   * `customizedFields` empty: canonical sync will never rewrite it.
   */
  app.post("/agents/:agentId/duplicate", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const body = await readJson(context.req.raw, z.object({ name: agentFields.name }).strict());
    const result = await db.$transaction(async (tx) => {
      const source = await tx.agent.findUnique({
        where: { id: agentId },
        include: {
          repoAccess: { select: { repoId: true, mountPath: true, permissions: true } },
          skills: { select: { skillId: true } },
          mcpConnections: { select: { mcpConnectionId: true } },
          secretGrants: { select: { secretId: true, envVar: true } },
          filesystemGrants: { select: { folderPath: true, canRead: true, canWrite: true, canDelete: true } },
          collaborators: { select: { allowedAgentId: true } },
        },
      });
      if (!source) return refusal("not-found", "Agent not found");
      if (isMechanical(source)) {
        return refusal("conflict", `${INTEGRATOR_AGENT_NAME} is the mechanical merge sentinel and cannot be duplicated`);
      }
      const taken = await tx.agent.findFirst({
        where: { projectId: source.projectId, name: body.name },
        select: { id: true },
      });
      if (taken) return refusal("conflict", `Agent ${body.name} already exists in this project`);
      const copy = await tx.agent.create({ data: {
        projectId: source.projectId,
        environmentId: source.environmentId,
        canonicalRole: null,
        customizedFields: [],
        name: body.name,
        title: source.title,
        model: source.model,
        codexServiceTier: source.codexServiceTier,
        foundationalPrompt: source.foundationalPrompt,
        rolePrompt: source.rolePrompt,
        runnerPreference: source.runnerPreference,
        inboxAccess: source.inboxAccess,
        disabledTools: source.disabledTools,
        archivedAt: null,
      } });
      // Join rows carry the new Agent id; `FilesystemGrant` has its own id, which
      // the database generates for the copy rather than reusing the source's.
      if (source.repoAccess.length > 0) {
        await tx.agentRepoAccess.createMany({ data: source.repoAccess.map((grant) => ({
          ...grant, agentId: copy.id, projectId: source.projectId,
        })) });
      }
      if (source.skills.length > 0) {
        await tx.agentSkill.createMany({ data: source.skills.map(({ skillId }) => ({
          agentId: copy.id, skillId, projectId: source.projectId,
        })) });
      }
      if (source.mcpConnections.length > 0) {
        await tx.agentMCPConnection.createMany({ data: source.mcpConnections.map(({ mcpConnectionId }) => ({
          agentId: copy.id, mcpConnectionId, projectId: source.projectId,
        })) });
      }
      if (source.secretGrants.length > 0) {
        await tx.agentSecretGrant.createMany({ data: source.secretGrants.map((grant) => ({
          ...grant, agentId: copy.id,
        })) });
      }
      if (source.filesystemGrants.length > 0) {
        await tx.filesystemGrant.createMany({ data: source.filesystemGrants.map((grant) => ({
          ...grant, agentId: copy.id,
        })) });
      }
      if (source.collaborators.length > 0) {
        await tx.agentCollaboration.createMany({ data: source.collaborators.map(({ allowedAgentId }) => ({
          agentId: copy.id, allowedAgentId, projectId: source.projectId,
        })) });
      }
      return { agent: copy };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(agentResponse(result.agent) satisfies AgentResponse, 201);
  });

  app.get("/agents/:agentId/secret-grants", async (context) => context.json(await db.agentSecretGrant.findMany({
    where: { agentId: id.parse(context.req.param("agentId")) },
    include: { secret: { select: secretPublicSelect } },
    orderBy: { envVar: "asc" },
  })));
  app.post("/agents/:agentId/secret-grants", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const body = await readJson(context.req.raw, secretGrantInput);
    if (["OPERATOR_TOKEN", "RUNNER_TOKEN", "AGENTOS_API_TOKEN", "AGENTOS_SESSION_TOKEN", "AGENTOS_FENCING_TOKEN"].includes(body.envVar)) {
      return context.json({ error: `Secret grant may not override reserved principal variable ${body.envVar}` }, 400);
    }
    const [agent, secret] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { id: true } }),
      db.secret.findFirst({ where: { id: body.secretId, disabledAt: null }, select: { id: true } }),
    ]);
    if (!agent || !secret) return context.json({ error: "Agent or available Secret not found" }, 404);
    return context.json(await db.agentSecretGrant.upsert({
      where: { agentId_envVar: { agentId, envVar: body.envVar } },
      create: { agentId, ...body },
      update: { secretId: body.secretId },
    }), 201);
  });
  app.delete("/agents/:agentId/secret-grants/:secretId/:envVar", async (context) => {
    await db.agentSecretGrant.delete({ where: { agentId_secretId_envVar: {
      agentId: id.parse(context.req.param("agentId")),
      secretId: id.parse(context.req.param("secretId")),
      envVar: z.string().min(1).parse(context.req.param("envVar")),
    } } });
    return context.body(null, 204);
  });

  app.get("/agents/:agentId/filesystem-grants", async (context) => context.json((await db.filesystemGrant.findMany({
    where: { agentId: id.parse(context.req.param("agentId")) }, orderBy: { folderPath: "asc" },
  })) satisfies FilesystemGrantContract[]));
  /**
   * Two spellings of one physical folder must not become two grants. On a case- and
   * normalization-insensitive volume `protected` and `Protected` are the same directory,
   * so a read-only grant on one plus a writable grant on the other is read-write on that
   * directory -- and the console renders the two rows identically, so nobody sees it.
   */
  const aliasingGrant = async (agentId: string, folderPath: string, exclude?: string): Promise<string | null> => {
    const key = await filesRootGrantKey(normalizeRelPath(folderPath));
    if (key === null) return null;
    const existing = await db.filesystemGrant.findMany({ where: { agentId } });
    for (const grant of existing) {
      if (grant.folderPath === folderPath || grant.id === exclude) continue;
      let other: string | null;
      try {
        other = await filesRootGrantKey(normalizeRelPath(grant.folderPath));
      } catch {
        continue;
      }
      if (other !== null && other === key) return grant.folderPath;
    }
    return null;
  };
  const aliasConflict = (context: Context, folderPath: string, existing: string): Response => context.json({
    error: `folderPath "${folderPath}" resolves to the same folder as the existing grant "${existing}"; edit that grant instead`,
  }, 409);

  app.post("/agents/:agentId/filesystem-grants", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const body = await readJson(context.req.raw, filesystemGrantInput);
    const aliased = await aliasingGrant(agentId, body.folderPath);
    if (aliased !== null) return aliasConflict(context, body.folderPath, aliased);
    return context.json((await db.filesystemGrant.upsert({
      where: { agentId_folderPath: { agentId, folderPath: body.folderPath } },
      create: { agentId, ...body },
      update: body,
    })) satisfies FilesystemGrantContract, 201);
  });
  app.patch("/agents/:agentId/filesystem-grants/:grantId", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const grantId = id.parse(context.req.param("grantId"));
    const existing = await db.filesystemGrant.findFirst({ where: { id: grantId, agentId } });
    if (!existing) return context.json({ error: "Filesystem grant not found" }, 404);
    const patch = await readJson(context.req.raw, filesystemGrantPatch);
    if (patch.folderPath !== undefined) {
      const aliased = await aliasingGrant(agentId, patch.folderPath, grantId);
      if (aliased !== null) return aliasConflict(context, patch.folderPath, aliased);
    }
    return context.json((await db.filesystemGrant.update({
      where: { id: grantId },
      data: withoutUndefined(patch) as Prisma.FilesystemGrantUncheckedUpdateInput,
    })) satisfies FilesystemGrantContract);
  });
  app.delete("/agents/:agentId/filesystem-grants/:grantId", async (context) => {
    const deleted = await db.filesystemGrant.deleteMany({ where: {
      id: id.parse(context.req.param("grantId")), agentId: id.parse(context.req.param("agentId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "Filesystem grant not found" }, 404);
  });

  app.post("/agents/:agentId/collaborators", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const { allowedAgentId } = await readJson(context.req.raw, collaboratorInput);
    if (agentId === allowedAgentId) return context.json({ error: "An agent cannot collaborate with itself" }, 400);
    const agents = await db.agent.findMany({ where: { id: { in: [agentId, allowedAgentId] } }, select: { id: true, projectId: true } });
    if (agents.length !== 2) return context.json({ error: "Agent or collaborator not found" }, 404);
    if (agents[0]!.projectId !== agents[1]!.projectId) return context.json({ error: "Collaborators belong to different projects" }, 400);
    return context.json(await db.agentCollaboration.upsert({
      where: { agentId_allowedAgentId: { agentId, allowedAgentId } },
      create: { agentId, allowedAgentId, projectId: agents[0]!.projectId }, update: {},
    }), 201);
  });
  app.delete("/agents/:agentId/collaborators/:allowedAgentId", async (context) => {
    const deleted = await db.agentCollaboration.deleteMany({ where: {
      agentId: id.parse(context.req.param("agentId")), allowedAgentId: id.parse(context.req.param("allowedAgentId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "Collaboration binding not found" }, 404);
  });

  app.get("/projects/:projectId/skills", async (context) => context.json((await db.skill.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    include: { agents: true },
    orderBy: { createdAt: "asc" },
  })) satisfies SkillResponse[]));
  app.post("/projects/:projectId/skills", async (context) => {
    const body = await readJson(context.req.raw, skillInput);
    return context.json((await db.skill.create({
      data: { projectId: id.parse(context.req.param("projectId")), ...body },
    })) satisfies SkillResponse, 201);
  });
  app.post("/agents/:agentId/skills", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const { skillId } = await readJson(context.req.raw, skillBindingInput);
    const [agent, skill] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { projectId: true } }),
      db.skill.findUnique({ where: { id: skillId }, select: { projectId: true } }),
    ]);
    if (!agent || !skill) return context.json({ error: "Agent or Skill not found" }, 404);
    if (agent.projectId !== skill.projectId) return context.json({ error: "Agent and Skill belong to different projects" }, 400);
    return context.json(await db.agentSkill.upsert({
      where: { agentId_skillId: { agentId, skillId } },
      create: { agentId, skillId, projectId: agent.projectId }, update: {},
    }), 201);
  });
  app.delete("/agents/:agentId/skills/:skillId", async (context) => {
    const deleted = await db.agentSkill.deleteMany({ where: {
      agentId: id.parse(context.req.param("agentId")), skillId: id.parse(context.req.param("skillId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "Skill binding not found" }, 404);
  });

  app.get("/projects/:projectId/mcp-connections", async (context) => context.json((await db.mCPConnection.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    include: { agents: true },
    orderBy: { createdAt: "asc" },
  })) satisfies MCPConnectionResponse[]));
  app.post("/projects/:projectId/mcp-connections", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, mcpConnectionInput);
    if (body.credentialSecretId) {
      const secret = await db.secret.findFirst({ where: { id: body.credentialSecretId, disabledAt: null } });
      if (!secret) return context.json({ error: "MCP credential secret is unavailable" }, 400);
    }
    return context.json((await db.mCPConnection.create({
      data: { ...body, config: jsonValue(body.config), projectId },
    })) satisfies MCPConnectionResponse, 201);
  });
  app.post("/agents/:agentId/mcp-connections", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const { mcpConnectionId } = await readJson(context.req.raw, mcpBindingInput);
    const [agent, connection] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { projectId: true } }),
      db.mCPConnection.findUnique({ where: { id: mcpConnectionId }, select: { projectId: true } }),
    ]);
    if (!agent || !connection) return context.json({ error: "Agent or MCP connection not found" }, 404);
    if (agent.projectId !== connection.projectId) return context.json({ error: "Agent and MCP connection belong to different projects" }, 400);
    return context.json(await db.agentMCPConnection.upsert({
      where: { agentId_mcpConnectionId: { agentId, mcpConnectionId } },
      create: { agentId, mcpConnectionId, projectId: agent.projectId }, update: {},
    }), 201);
  });
  app.delete("/agents/:agentId/mcp-connections/:connectionId", async (context) => {
    const deleted = await db.agentMCPConnection.deleteMany({ where: {
      agentId: id.parse(context.req.param("agentId")), mcpConnectionId: id.parse(context.req.param("connectionId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "MCP binding not found" }, 404);
  });

  app.get("/projects/:projectId/repos", async (context) => validated(context, (await db.repo.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })) satisfies RepoResponse[]));
  app.post("/projects/:projectId/repos", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, repoCreateInput);
    const dependencyProvisioning = body.dependencyProvisioning;
    if (!isDependencyProvisioning(dependencyProvisioning)) return context.json(dependencyProvisioningInvalid, 400);
    const remote = parseRepoRemote(body.remoteUrl);
    if (!remote.ok) {
      return context.json({
        error: "Repository remote is invalid",
        code: "repository-remote-invalid",
        reason: remote.reason,
      }, 400);
    }
    if (!isValidBranchName(body.defaultBranch)) {
      return context.json({
        error: "Repository default branch is invalid",
        code: "repository-default-branch-invalid",
      }, 400);
    }
    if (body.credentialSecretId) {
      const secret = await db.secret.findFirst({ where: { id: body.credentialSecretId, disabledAt: null } });
      if (!secret) return context.json({ error: "Repo credential secret is unavailable" }, 400);
    }
    try {
      await deps.repositoryPreflight({
        remoteUrl: remote.remoteUrl,
        defaultBranch: body.defaultBranch,
        dependencyProvisioning,
      });
    } catch (error: unknown) {
      const refusal = repositoryPreflightRefusal(context, error);
      if (refusal) return refusal;
      throw error;
    }
    const { grantAgents, ...repoFields } = body;
    const result = await readCommitted(db, async (tx) => {
      const repo = await tx.repo.create({
        data: { ...repoFields, dependencyProvisioning, projectId },
      });
      if (!grantAgents) return repo;
      const agents = await tx.agent.findMany({
        where: { projectId, archivedAt: null, name: { not: INTEGRATOR_AGENT_NAME } },
        orderBy: { id: "asc" },
      });
      const grants = [];
      for (const agent of agents) {
        grants.push(await tx.agentRepoAccess.create({
          data: {
            agentId: agent.id,
            repoId: repo.id,
            projectId,
            permissions: RepoPermission.GIT_WRITE,
            mountPath: repo.mountPath,
          },
        }));
      }
      return { repo, grants };
    });
    return context.json(result satisfies RepoResponse | { repo: RepoResponse; grants: AgentRepoAccessContract[] }, 201);
  });
  app.patch("/repos/:repoId", async (context) => {
    const submitted = await readJson(context.req.raw, repoPatch);
    const body = submitted.remoteUrl === undefined
      ? submitted
      : { ...submitted, remoteUrl: submitted.remoteUrl.trim() };
    if (body.dependencyProvisioning !== undefined && !isDependencyProvisioning(body.dependencyProvisioning)) {
      return context.json(dependencyProvisioningInvalid, 400);
    }
    const repoId = id.parse(context.req.param("repoId"));
    if (body.credentialSecretId) {
      const secret = await db.secret.findFirst({ where: { id: body.credentialSecretId, disabledAt: null } });
      if (!secret) return context.json({ error: "Repo credential secret is unavailable" }, 400);
    }
    if (body.dependencyProvisioning !== undefined) {
      const stored = await db.repo.findUnique({
        where: { id: repoId },
        select: { remoteUrl: true, defaultBranch: true },
      });
      if (!stored) return refusalJson(context, refusal("not-found", "Resource not found"));
      const remote = parseRepoRemote(submitted.remoteUrl ?? stored.remoteUrl);
      if (!remote.ok) {
        return context.json({
          error: "Repository remote is invalid",
          code: "repository-remote-invalid",
          reason: remote.reason,
        }, 400);
      }
      const defaultBranch = body.defaultBranch ?? stored.defaultBranch;
      if (!isValidBranchName(defaultBranch)) {
        return context.json({
          error: "Repository default branch is invalid",
          code: "repository-default-branch-invalid",
        }, 400);
      }
      try {
        await deps.repositoryPreflight({
          remoteUrl: remote.remoteUrl,
          defaultBranch,
          dependencyProvisioning: body.dependencyProvisioning,
        });
      } catch (error: unknown) {
        const refusal = repositoryPreflightRefusal(context, error);
        if (refusal) return refusal;
        throw error;
      }
    }
    return context.json((await db.repo.update({
      where: { id: repoId }, data: withoutUndefined(body),
    })) satisfies RepoResponse);
  });
  app.delete("/repos/:repoId", async (context) => {
    const repoId = id.parse(context.req.param("repoId"));
    const result = await serializable(db, async (tx) => {
      const repo = await tx.repo.findUnique({ where: { id: repoId }, select: { id: true } });
      if (!repo) return refusal("not-found", "Repo not found");
      const [tasks, runs, templates] = await Promise.all([
        tx.task.count({ where: { repoId } }),
        tx.run.count({ where: { repoId } }),
        tx.taskTemplate.count({ where: { webhookRepoId: repoId } }),
      ]);
      const references = { tasks, runs, templates };
      if (tasks > 0 || runs > 0 || templates > 0) return { references };
      await tx.repo.delete({ where: { id: repoId } });
      return { deleted: true as const };
    });
    if ("message" in result) return refusalJson(context, result);
    if ("references" in result) {
      return context.json({
        error: "Repo has task, run, or webhook template references; remove them before deleting it",
        code: REPO_REFERENCED,
        references: result.references,
      }, resourceDeleteRefusalStatusFor(REPO_REFERENCED));
    }
    return context.body(null, 204);
  });
  app.post("/agents/:agentId/repos/:repoId/access", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const repoId = id.parse(context.req.param("repoId"));
    const body = await readJson(context.req.raw, repoAccessInput);
    const [agent, repo] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { projectId: true } }),
      db.repo.findUnique({ where: { id: repoId }, select: { projectId: true } }),
    ]);
    if (!agent || !repo) return context.json({ error: "Agent or Repo not found" }, 404);
    if (agent.projectId !== repo.projectId) return context.json({ error: "Agent and Repo belong to different projects" }, 400);
    return context.json((await db.agentRepoAccess.upsert({
      where: { agentId_repoId: { agentId, repoId } },
      create: { agentId, repoId, projectId: agent.projectId, ...body },
      update: body,
    })) satisfies AgentRepoAccessContract, 201);
  });
  app.delete("/agents/:agentId/repos/:repoId/access", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const repoId = id.parse(context.req.param("repoId"));
    const grant = await db.agentRepoAccess.findUnique({
      where: { agentId_repoId: { agentId, repoId } }, select: { projectId: true },
    });
    if (!grant) return context.json({ error: "Repo access not found" }, 404);
    const result = await db.$transaction(async (tx) => {
      if (!await lockAgentRepoGrantForRevocation(tx, { projectId: grant.projectId, agentId, repoId })) {
        return refusal("not-found", "Repo access not found");
      }
      const active = await tx.run.count({ where: { agentId, repoId, status: { in: ACTIVE_RUN_STATUSES } } });
      if (active > 0) return refusal("conflict", "Cannot revoke repo access while the agent has an active run on this Repo");
      const dependentSteps = await tx.task.count({ where: {
        projectId: grant.projectId,
        repoId,
        assigneeAgentId: agentId,
        chainId: { not: null },
        archivedAt: null,
        status: { in: [TaskStatus.BACKLOG, TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW] },
      } });
      if (dependentSteps > 0) {
        return refusal("conflict", "Cannot revoke repo access while a nonterminal chain step depends on this grant");
      }
      await tx.agentRepoAccess.delete({ where: { agentId_repoId: { agentId, repoId } } });
      return { ok: true as const };
    });
    return "message" in result ? refusalJson(context, result) : context.body(null, 204);
  });
};
