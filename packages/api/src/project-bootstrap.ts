import {
  applyCanonicalInstallation,
  loadAgentSources,
  loadTemplateStepSources,
  NetworkingMode,
  planCanonicalInstallation,
  Prisma,
  PR_TEMPLATE_NAME,
  type AgentSources,
  type CanonicalTemplateName,
  type Project,
  type PrismaClient,
  type TemplateStepSource,
} from "@anneal/db";
import { z } from "zod";

import { installDefaultStaffingProfile } from "./staffing-profiles.js";

/** The public fields accepted by `POST /projects`. */
export const projectFields = {
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  yamlDocument: z.string(),
};

export const projectInput = z.object({
  ...projectFields,
  yamlDocument: projectFields.yamlDocument.default(""),
});

export type ProjectInput = z.infer<typeof projectInput>;

/** The exact role set the canonical PR workflow is allowed to install. */
export const PROJECT_BOOTSTRAP_ROLE_NAMES = [
  "senior-dev-luna-max",
  "code-reviewer-sol-high",
  "code-reviewer-opus-medium",
  "senior-dev-astra-low",
] as const;

export type ProjectBootstrapRoleLoader = () => Promise<AgentSources>;
export type ProjectBootstrapTemplateLoader = () => Promise<
  ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>
>;

/** Source capabilities are explicit so route tests can replace filesystem
 * reads without replacing the database operation itself. */
export type ProjectBootstrapLoaders = Readonly<{
  loadAgentSources: ProjectBootstrapRoleLoader;
  loadAllTemplateStepSources: ProjectBootstrapTemplateLoader;
}>;

export const defaultProjectBootstrapLoaders: ProjectBootstrapLoaders = {
  loadAgentSources,
  loadAllTemplateStepSources: async () => new Map([
    [PR_TEMPLATE_NAME, await loadTemplateStepSources(PR_TEMPLATE_NAME)],
  ]),
};

export const PROJECT_SLUG_TAKEN = "project-slug-taken" as const;
export const PROJECT_SLUG_TAKEN_MESSAGE = "Project slug is already taken";

export type CreateProjectResult =
  | { ok: true; project: Project }
  | { ok: false; code: typeof PROJECT_SLUG_TAKEN; message: typeof PROJECT_SLUG_TAKEN_MESSAGE };

const isProjectSlugTaken = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034");

const requireRoleSources = (
  sources: AgentSources,
  requiredRoleNames: readonly string[],
): Map<string, AgentSources["roles"][number]> => {
  // Keyed by canonical role, not by name: `name` is operator-editable, and the
  // roster this installs is stated in role slugs.
  const rolesByName = new Map(sources.roles.map((role) => [role.canonicalRole, role]));
  for (const roleName of requiredRoleNames) {
    if (!rolesByName.has(roleName)) {
      throw new Error(`Canonical role ${roleName} was not found`);
    }
  }
  return rolesByName;
};

const requireTemplateSource = (
  sources: ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>,
): readonly TemplateStepSource[] => {
  const steps = sources.get(PR_TEMPLATE_NAME);
  if (!steps) throw new Error(`Canonical template source ${PR_TEMPLATE_NAME} was not found`);
  return steps;
};

const requireTemplateRoleNames = (steps: readonly TemplateStepSource[]): readonly string[] => {
  const roleNames = [...new Set(steps.flatMap((step) => step.agentName === null ? [] : [step.agentName]))];
  const expected = new Set<string>(PROJECT_BOOTSTRAP_ROLE_NAMES);
  const missing = PROJECT_BOOTSTRAP_ROLE_NAMES.filter((name) => !roleNames.includes(name));
  const unexpected = roleNames.filter((name) => !expected.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Canonical template ${PR_TEMPLATE_NAME} role set must be exactly ${PROJECT_BOOTSTRAP_ROLE_NAMES.join(", ")}; `
      + `missing ${missing.join(", ") || "none"}; unexpected ${unexpected.join(", ") || "none"}`,
    );
  }
  return roleNames;
};

/**
 * Create a Project with the roles and pull-request workflow it needs to be
 * immediately usable. Filesystem-backed source loading and all source shape
 * checks happen before the transaction opens; the Project, Environment,
 * Agents, and canonical template are one atomic Serializable write.
 */
export const createProjectBootstrap = async (
  db: PrismaClient,
  input: ProjectInput,
  loaders: Partial<ProjectBootstrapLoaders> = {},
): Promise<CreateProjectResult> => {
  // Keep validation pure and before any source I/O or database access. Parsing
  // here as well as at the route boundary makes direct operation callers safe.
  const parsedInput = projectInput.parse(input);
  const sourceLoaders: ProjectBootstrapLoaders = {
    ...defaultProjectBootstrapLoaders,
    ...loaders,
  };
  const [agentSources, allTemplateSources] = await Promise.all([
    sourceLoaders.loadAgentSources(),
    sourceLoaders.loadAllTemplateStepSources(),
  ]);
  const templateSteps = requireTemplateSource(allTemplateSources);
  const roleNames = requireTemplateRoleNames(templateSteps);
  const rolesByName = requireRoleSources(agentSources, roleNames);
  // The operation owns only the PR workflow, so the installer receives only
  // that template even when an injected loader returns a wider source map.
  const templateSources = new Map<CanonicalTemplateName, readonly TemplateStepSource[]>([
    [PR_TEMPLATE_NAME, templateSteps],
  ]);

  try {
    const project = await db.$transaction(async (tx) => {
      const createdProject = await tx.project.create({ data: parsedInput });
      const environment = await tx.environment.create({
        data: {
          projectId: createdProject.id,
          name: "local",
          networking: NetworkingMode.OPEN,
          allowedHosts: [],
        },
      });

      for (const roleName of roleNames) {
        const role = rolesByName.get(roleName)!;
        await tx.agent.create({
          data: {
            projectId: createdProject.id,
            environmentId: environment.id,
            name: role.name,
            canonicalRole: role.canonicalRole,
            title: role.title,
            model: role.model,
            runnerPreference: role.runnerPreference,
            inboxAccess: role.inboxAccess,
            foundationalPrompt: agentSources.foundationalPrompt,
            rolePrompt: role.rolePrompt,
            disabledTools: [],
          },
        });
      }

      const plan = planCanonicalInstallation([], templateSources, [createdProject.id]);
      await applyCanonicalInstallation(tx, plan, templateSources);
      // Every installed template gets its initial "Default" staffing profile
      // from the bindings just written, so a fresh project instantiates from a
      // profile rather than from the template rows directly.
      const installed = await tx.taskTemplate.findMany({
        where: { projectId: createdProject.id },
        orderBy: { name: "asc" },
        select: { id: true },
      });
      for (const template of installed) {
        await installDefaultStaffingProfile(tx, {
          projectId: createdProject.id,
          taskTemplateId: template.id,
        });
      }
      return createdProject;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ok: true, project };
  } catch (error: unknown) {
    // Do not retry: this operation intentionally exposes the first conflict to
    // the route as the stable slug-taken response, preserving rollback semantics
    // for every other transaction failure.
    if (isProjectSlugTaken(error)) {
      return { ok: false, code: PROJECT_SLUG_TAKEN, message: PROJECT_SLUG_TAKEN_MESSAGE };
    }
    throw error;
  }
};
