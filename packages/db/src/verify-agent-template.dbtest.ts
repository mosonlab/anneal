/**
 * The canonical Agent/template verifier's complete and partial-project
 * contracts against PostgreSQL.
 *
 * Requires a scratch server. It creates and drops its own schema and never
 * touches an existing one.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { AssigneeType, CodexServiceTier, Prisma, PrismaClient, RunnerPreference } from "@prisma/client";

import { loadAgentSources, type RoleSource } from "./agent-sources.js";
import {
  applyCanonicalInstallation,
  planCanonicalInstallation,
  type CanonicalInstallationSources,
} from "./canonical-template-installation.js";
import { PR_TEMPLATE_NAME } from "./agent-contract.js";
import {
  LEGACY_ALL_PRIOR_OUTPUTS,
  canonicalTemplateSourceSpec,
  loadAllTemplateStepSources,
  templateMetadataDifferences,
} from "./template-sources.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");

const scratchServer = (): URL => {
  if (process.env["AGENTOS_ALLOW_SCRATCH_DATABASES"] !== "1") throw new Error("scratch-database-opt-in-required");
  const raw = process.env["TEST_DATABASE_URL"];
  if (!raw) throw new Error("scratch-test-database-url-required");
  const url = new URL(raw);
  if (!url.protocol.startsWith("postgres")) throw new Error("scratch-database-postgresql-required");
  if ((url.port || "5432") === "5432") throw new Error("scratch-database-refuses-port-5432");
  return url;
};

const server = scratchServer();
const schema = `verify_agent_template_${randomBytes(4).toString("hex")}`;
const databaseUrl = (() => {
  const url = new URL(server.href);
  url.searchParams.set("schema", schema);
  return url.href;
})();

type CommandResult = { status: number | null; output: string };

const command = (args: string[]): CommandResult => {
  const isTsxScript = args[0] === "tsx";
  const result = spawnSync(isTsxScript ? process.execPath : "npx", isTsxScript
    ? ["--import", "tsx", ...args.slice(1)]
    : args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const verify = (projectId?: string): CommandResult => command([
  "tsx",
  "prisma/verify-agent-template.ts",
  ...(projectId === undefined ? [] : ["--project", projectId]),
]);

let prisma: PrismaClient;
let agentSources: Awaited<ReturnType<typeof loadAgentSources>>;
let templateSources: Awaited<ReturnType<typeof loadAllTemplateStepSources>>;

const partialRoleNames = [
  "senior-dev-luna-max",
  "code-reviewer-sol-high",
  "code-reviewer-opus-medium",
  "senior-dev-astra-low",
] as const;

type ProjectFixture = {
  id: string;
  slug: string;
  environmentId: string;
  agents: Map<string, { id: string; source: RoleSource }>;
  templateId: string | null;
};

before(async () => {
  const migrated = command(["prisma", "migrate", "deploy"]);
  assert.equal(migrated.status, 0, migrated.output);
  const seeded = command(["tsx", "prisma/seed.ts"]);
  assert.equal(seeded.status, 0, seeded.output);
  agentSources = await loadAgentSources();
  templateSources = await loadAllTemplateStepSources();
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
});

after(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({ datasources: { db: { url: server.href } } });
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.$disconnect();
  }
});

const sourceRole = (name: string): RoleSource => {
  const role = agentSources.roles.find((candidate) => candidate.name === name);
  assert.ok(role, `role source must contain ${name}`);
  return role;
};

const createProject = async (options: {
  agents?: readonly string[];
  template?: boolean;
  noncanonicalInventory?: boolean;
  /** Install the agents with their `canonicalRole` recorded. Without it they
   *  carry the role only in their name, which is the pre-column shape the
   *  verifier still adopts. */
  identified?: boolean;
} = {}): Promise<ProjectFixture> => {
  const project = await prisma.project.create({
    data: {
      name: `Verifier fixture ${randomBytes(4).toString("hex")}`,
      slug: `verify-fixture-${randomBytes(4).toString("hex")}`,
    },
  });
  const environment = await prisma.environment.create({
    data: { projectId: project.id, name: "local", networking: "OPEN", allowedHosts: [] },
  });
  const agents = new Map<string, { id: string; source: RoleSource }>();
  for (const name of options.agents ?? []) {
    const source = sourceRole(name);
    const agent = await prisma.agent.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        ...(options.identified ? { canonicalRole: source.canonicalRole } : {}),
        name: source.name,
        title: source.title,
        model: source.model,
        runnerPreference: source.runnerPreference,
        inboxAccess: source.inboxAccess,
        foundationalPrompt: agentSources.foundationalPrompt,
        rolePrompt: source.rolePrompt,
        customizedFields: [],
        runtimeConfigDriftNoticeFingerprint: null,
        codexServiceTier: CodexServiceTier.DEFAULT,
        disabledTools: [],
        archivedAt: null,
      },
    });
    agents.set(name, { id: agent.id, source });
  }

  let templateId: string | null = null;
  if (options.template) {
    const sources: CanonicalInstallationSources = new Map([
      [PR_TEMPLATE_NAME, templateSources.get(PR_TEMPLATE_NAME)!],
    ]);
    const plan = planCanonicalInstallation([], sources, [project.id]);
    await prisma.$transaction(async (tx) => {
      await applyCanonicalInstallation(tx, plan, sources);
    });
    templateId = (await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: PR_TEMPLATE_NAME } },
      select: { id: true },
    })).id;
  }

  if (options.noncanonicalInventory) {
    await prisma.agent.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        name: "operator-local",
        title: "Operator local agent",
        model: "custom-operator-model",
        runnerPreference: RunnerPreference.AUTO,
        inboxAccess: false,
        foundationalPrompt: "operator foundational prompt",
        rolePrompt: "operator role prompt",
      },
    });
    await prisma.taskTemplate.create({
      data: {
        projectId: project.id,
        name: "operator-local-template",
        description: "operator-owned template",
        variables: ["operatorVariable"],
      },
    });
  }

  return { id: project.id, slug: project.slug, environmentId: environment.id, agents, templateId };
};

const deleteProject = async (fixture: ProjectFixture): Promise<void> => {
  await prisma.project.delete({ where: { id: fixture.id } });
};

const withProject = async <T>(
  options: Parameters<typeof createProject>[0],
  body: (fixture: ProjectFixture) => Promise<T>,
): Promise<T> => {
  const fixture = await createProject(options);
  try {
    return await body(fixture);
  } finally {
    await deleteProject(fixture);
  }
};

const projectErrorPattern = (fixture: ProjectFixture): RegExp => new RegExp(`Project ${fixture.slug}:`, "u");
const templateIdentifierPattern = (fixture: ProjectFixture): RegExp => new RegExp(
  `${PR_TEMPLATE_NAME} \\(${fixture.templateId}\\)`,
  "u",
);

test("--project verifies an A1-shaped partial inventory and a project with no canonical objects", async () => {
  await withProject({ agents: partialRoleNames, template: true }, async (fixture) => {
    const result = verify(fixture.id);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /4 active agents/u);
    assert.match(result.output, /4 steps across 1 templates/u);
  });

  await withProject({ noncanonicalInventory: true }, async (fixture) => {
    const result = verify(fixture.id);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /0 active agents/u);
    assert.match(result.output, /0 steps across 0 templates/u);
  });
});

test("--project ignores noncanonical inventory and skips compound/direct special checks", async () => {
  await withProject({ agents: partialRoleNames, template: true, noncanonicalInventory: true }, async (fixture) => {
    const result = verify(fixture.id);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /compound-engineer-workflow|direct-engineer-workflow/u);
  });
});

test("--project rejects every canonical Agent field drift with project and Agent identifiers", async () => {
  const mutations: ReadonlyArray<{
    name: string;
    apply: (fixture: ProjectFixture) => Promise<void>;
  }> = [
    {
      name: "title",
      apply: async (fixture) => {
        await prisma.agent.update({
          where: { id: fixture.agents.get("senior-dev-luna-max")!.id },
          data: { title: "drifted title" },
        });
      },
    },
    {
      name: "inboxAccess",
      apply: async (fixture) => {
        const agent = fixture.agents.get("senior-dev-luna-max")!;
        await prisma.agent.update({ where: { id: agent.id }, data: { inboxAccess: !agent.source.inboxAccess } });
      },
    },
    {
      name: "collaborators",
      apply: async (fixture) => {
        const agent = fixture.agents.get("senior-dev-luna-max")!;
        const allowed = fixture.agents.get("senior-dev-astra-low")!;
        await prisma.agentCollaboration.create({
          data: { agentId: agent.id, allowedAgentId: allowed.id, projectId: fixture.id },
        });
      },
    },
    {
      name: "foundationalPrompt",
      apply: async (fixture) => {
        await prisma.agent.update({
          where: { id: fixture.agents.get("senior-dev-luna-max")!.id },
          data: { foundationalPrompt: "drifted foundational prompt" },
        });
      },
    },
    {
      name: "rolePrompt",
      apply: async (fixture) => {
        await prisma.agent.update({
          where: { id: fixture.agents.get("senior-dev-luna-max")!.id },
          data: { rolePrompt: "drifted role prompt" },
        });
      },
    },
  ];

  for (const mutation of mutations) {
    await withProject({ agents: partialRoleNames }, async (fixture) => {
      const agent = fixture.agents.get("senior-dev-luna-max")!;
      await mutation.apply(fixture);
      const result = verify(fixture.id);
      assert.notEqual(result.status, 0, `${mutation.name}: ${result.output}`);
      assert.match(result.output, projectErrorPattern(fixture), mutation.name);
      assert.match(result.output, new RegExp(`senior-dev-luna-max \\(${agent.id}\\)`, "u"), mutation.name);
    });
  }
});

test("--project applies the canonical runtime override treatment", async () => {
  await withProject({ agents: partialRoleNames }, async (fixture) => {
    const agent = fixture.agents.get("senior-dev-luna-max")!;
    await prisma.agent.update({
      where: { id: agent.id },
      data: { model: "gpt-5.6-luna:high", runnerPreference: RunnerPreference.CODEX, customizedFields: ["model", "runnerPreference"] },
    });
    const compatible = verify(fixture.id);
    assert.equal(compatible.status, 0, compatible.output);
  });

  await withProject({ agents: partialRoleNames }, async (fixture) => {
    const agent = fixture.agents.get("senior-dev-luna-max")!;
    await prisma.agent.update({
      where: { id: agent.id },
      data: { model: "gpt-5.6-luna:high", runnerPreference: RunnerPreference.CODEX, customizedFields: [] },
    });
    const uncustomized = verify(fixture.id);
    assert.notEqual(uncustomized.status, 0, uncustomized.output);
    assert.match(uncustomized.output, projectErrorPattern(fixture));
    assert.match(uncustomized.output, new RegExp(`senior-dev-luna-max \\(${agent.id}\\)`, "u"));
  });

  await withProject({ agents: partialRoleNames }, async (fixture) => {
    const agent = fixture.agents.get("senior-dev-luna-max")!;
    await prisma.agent.update({
      where: { id: agent.id },
      data: { model: "gpt-5.6-luna:max", runnerPreference: RunnerPreference.CLAUDE, customizedFields: ["model", "runnerPreference"] },
    });
    const incompatible = verify(fixture.id);
    assert.notEqual(incompatible.status, 0, incompatible.output);
    assert.match(incompatible.output, projectErrorPattern(fixture));
    assert.match(incompatible.output, new RegExp(`senior-dev-luna-max \\(${agent.id}\\)`, "u"));
  });
});

test("--project rejects canonical template metadata drift with the template identifier", async () => {
  const mutations: ReadonlyArray<{
    name: string;
    apply: (templateId: string) => Promise<void>;
  }> = [
    { name: "description", apply: async (templateId) => {
      await prisma.taskTemplate.update({ where: { id: templateId }, data: { description: "drifted description" } });
    } },
    { name: "variables", apply: async (templateId) => {
      await prisma.taskTemplate.update({ where: { id: templateId }, data: { variables: ["driftedVariable"] } });
    } },
  ];

  for (const mutation of mutations) {
    await withProject({ agents: partialRoleNames, template: true }, async (fixture) => {
      await mutation.apply(fixture.templateId!);
      const result = verify(fixture.id);
      assert.notEqual(result.status, 0, `${mutation.name}: ${result.output}`);
      assert.match(result.output, projectErrorPattern(fixture), mutation.name);
      assert.match(result.output, templateIdentifierPattern(fixture), mutation.name);
    });
  }
});

test("the verifier's metadata seam detects a canonical template name mismatch", () => {
  assert.deepEqual(templateMetadataDifferences({
    name: "renamed-template",
    description: canonicalTemplateSourceSpec(PR_TEMPLATE_NAME).description,
    variables: ["branchName"],
  }, PR_TEMPLATE_NAME), ["name"]);
});

test("--project rejects both missing and extra canonical template steps", async () => {
  for (const mutation of ["missing", "extra"] as const) {
    await withProject({ agents: partialRoleNames, template: true }, async (fixture) => {
      const steps = await prisma.taskTemplateStep.findMany({
        where: { taskTemplateId: fixture.templateId! },
        orderBy: { stepIndex: "asc" },
      });
      const first = steps[0]!;
      if (mutation === "missing") {
        await prisma.taskTemplateStep.delete({ where: { id: first.id } });
      } else {
        await prisma.taskTemplateStep.create({ data: {
          taskTemplateId: fixture.templateId!,
          stepIndex: 99,
          name: first.name,
          layer: first.layer,
          assigneeAgentId: first.assigneeAgentId,
          assigneeType: first.assigneeType,
          runner: first.runner,
          approvalGate: first.approvalGate,
          outputKind: first.outputKind,
          prompt: first.prompt,
          opensPullRequest: first.opensPullRequest,
          requiresCommit: first.requiresCommit,
          attachmentsFromPrevious: first.attachmentsFromPrevious,
          priorOutputKinds: first.priorOutputKinds,
          baseFromStepIndex: first.baseFromStepIndex,
          ...(first.spawnPolicy === null ? {} : { spawnPolicy: first.spawnPolicy as Prisma.InputJsonValue }),
        } });
      }
      const result = verify(fixture.id);
      assert.notEqual(result.status, 0, `${mutation}: ${result.output}`);
      assert.match(result.output, projectErrorPattern(fixture), mutation);
      assert.match(result.output, templateIdentifierPattern(fixture), mutation);
      assert.match(result.output, /must contain 4 steps/u, mutation);
    });
  }
});

test("--project rejects every canonical template step field with template/step identifiers", async () => {
  const mutations: ReadonlyArray<{
    name: string;
    apply: (fixture: ProjectFixture, step: { id: string }) => Promise<void>;
  }> = [
    { name: "stepIndex", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { stepIndex: 99 } });
    } },
    { name: "name", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { name: "drifted step name" } });
    } },
    { name: "layer", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { layer: 99 } });
    } },
    { name: "agent", apply: async (fixture, step) => {
      await prisma.taskTemplateStep.update({
        where: { id: step.id },
        data: { assigneeAgentId: fixture.agents.get("senior-dev-astra-low")!.id },
      });
    } },
    { name: "assigneeType", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { assigneeType: AssigneeType.HUMAN } });
    } },
    { name: "runner", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { runner: "CODEX" } });
    } },
    { name: "approvalGate", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { approvalGate: true } });
    } },
    { name: "outputKind", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { outputKind: "drifted-output" } });
    } },
    { name: "prompt", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { prompt: "drifted step prompt" } });
    } },
    { name: "spawnPolicy", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { spawnPolicy: { drifted: true } } });
    } },
    { name: "opensPullRequest", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { opensPullRequest: false } });
    } },
    { name: "requiresCommit", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { requiresCommit: false } });
    } },
    { name: "attachmentsFromPrevious", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { attachmentsFromPrevious: true } });
    } },
    { name: "priorOutputKinds", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { priorOutputKinds: ["drifted-output"] } });
    } },
    { name: "baseFromStepIndex", apply: async (_fixture, step) => {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { baseFromStepIndex: 1 } });
    } },
  ];

  for (const mutation of mutations) {
    await withProject({ agents: partialRoleNames, template: true }, async (fixture) => {
      const template = await prisma.taskTemplate.findUniqueOrThrow({
        where: { id: fixture.templateId! },
        include: { steps: { orderBy: { stepIndex: "asc" } } },
      });
      const step = template.steps[0]!;
      await mutation.apply(fixture, step);
      const result = verify(fixture.id);
      assert.notEqual(result.status, 0, `${mutation.name}: ${result.output}`);
      assert.match(result.output, projectErrorPattern(fixture), mutation.name);
      assert.match(result.output, templateIdentifierPattern(fixture), mutation.name);
      assert.match(result.output, /pr-engineer-workflow step \d+ \([^)]+\)/u, mutation.name);
    });
  }
});

test("--project refuses the differences canonical sync would adopt", async () => {
  const mutations: ReadonlyArray<{ name: string; stepIndex: number; data: Prisma.TaskTemplateStepUpdateInput }> = [
    { name: "provisionDependencies", stepIndex: 2, data: { provisionDependencies: true } },
    { name: "priorOutputKinds", stepIndex: 3, data: { priorOutputKinds: [LEGACY_ALL_PRIOR_OUTPUTS] } },
  ];

  for (const mutation of mutations) {
    await withProject({ agents: partialRoleNames, template: true }, async (fixture) => {
      const step = await prisma.taskTemplateStep.findUniqueOrThrow({
        where: { taskTemplateId_stepIndex: { taskTemplateId: fixture.templateId!, stepIndex: mutation.stepIndex } },
      });
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: mutation.data });
      const result = verify(fixture.id);
      assert.notEqual(result.status, 0, `${mutation.name}: ${result.output}`);
      assert.match(result.output, projectErrorPattern(fixture), mutation.name);
      assert.match(result.output, templateIdentifierPattern(fixture), mutation.name);
      assert.match(
        result.output,
        new RegExp(`${PR_TEMPLATE_NAME} step ${mutation.stepIndex} \\([^)]+\\) differs from canonical Markdown structure: ${mutation.name}`, "u"),
        mutation.name,
      );
    });
  }
});

test("default verification keeps the complete-inventory requirement and success sentence", async () => {
  const verified = verify();
  assert.equal(verified.status, 0, verified.output);
  assert.match(verified.output, /Agent\/template contract verified for 21 active agents and 24 steps across 3 templates\./u);

  const canonical = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const customized = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonical.id, name: "default" } },
  });
  await prisma.agent.update({
    where: { id: customized.id },
    data: { model: "gpt-5.6-luna:high", runnerPreference: RunnerPreference.CODEX, customizedFields: ["model", "runnerPreference"] },
  });
  try {
    const compatible = verify();
    assert.equal(compatible.status, 0, compatible.output);
  } finally {
    await prisma.agent.update({
      where: { id: customized.id },
      data: {
        model: customized.model,
        runnerPreference: customized.runnerPreference,
        customizedFields: customized.customizedFields,
      },
    });
  }

  const missing = await prisma.agent.findUniqueOrThrow({ where: { projectId_name: { projectId: canonical.id, name: "default" } } });
  await prisma.agent.delete({ where: { id: missing.id } });
  try {
    const incomplete = verify();
    assert.notEqual(incomplete.status, 0, incomplete.output);
    assert.match(incomplete.output, /active agents differ from canonical contract/u);
  } finally {
    const seeded = command(["tsx", "prisma/seed.ts"]);
    assert.equal(seeded.status, 0, seeded.output);
  }

  const missingTemplate = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonical.id, name: PR_TEMPLATE_NAME } },
  });
  await prisma.taskTemplate.delete({ where: { id: missingTemplate.id } });
  try {
    const incomplete = verify();
    assert.notEqual(incomplete.status, 0, incomplete.output);
    assert.match(incomplete.output, /expected 3 canonical templates; found 2/u);
  } finally {
    const seeded = command(["tsx", "prisma/seed.ts"]);
    assert.equal(seeded.status, 0, seeded.output);
  }
});

test("default verification runs compound and direct special checks", async () => {
  const canonical = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const compound = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonical.id, name: "compound-engineer-workflow" } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const direct = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonical.id, name: "direct-engineer-workflow" } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const compoundIntegrator = compound.steps.at(-1)!;
  const directTail = direct.steps.at(-1)!;

  await prisma.taskTemplateStep.update({ where: { id: compoundIntegrator.id }, data: { approvalGate: true } });
  try {
    const refused = verify();
    assert.notEqual(refused.status, 0, refused.output);
    assert.match(refused.output, /compound-engineer-workflow/u);
    assert.match(refused.output, /approvalGate|approval gate/u);
  } finally {
    await prisma.taskTemplateStep.update({
      where: { id: compoundIntegrator.id },
      data: { approvalGate: false },
    });
  }

  await prisma.taskTemplateStep.update({ where: { id: directTail.id }, data: { approvalGate: true } });
  try {
    const refused = verify();
    assert.notEqual(refused.status, 0, refused.output);
    assert.match(refused.output, /direct-engineer-workflow/u);
    assert.match(refused.output, /merge execution|approvalGate|approval gate/u);
  } finally {
    await prisma.taskTemplateStep.update({
      where: { id: directTail.id },
      data: { approvalGate: false },
    });
  }
});

test("the compound implementation root is verified as a Codex gpt-* capability", async () => {
  const canonical = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const root = await prisma.taskTemplateStep.findFirstOrThrow({
    where: {
      taskTemplate: { projectId: canonical.id, name: "compound-engineer-workflow" },
      outputKind: "implementation",
    },
    select: { assigneeAgentId: true },
  });
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: root.assigneeAgentId! } });
  assert.equal(agent.runnerPreference, RunnerPreference.CODEX);
  assert.ok(agent.model.startsWith("gpt-"), agent.model);

  // An operator override is what the verifier tolerates elsewhere, so the
  // refusal has to come from the capability rule and not from runtime drift.
  await prisma.agent.update({
    where: { id: agent.id },
    data: {
      model: "claude-opus-5:medium",
      runnerPreference: RunnerPreference.CLAUDE,
      customizedFields: ["model", "runnerPreference"],
    },
  });
  try {
    const refused = verify();
    assert.notEqual(refused.status, 0, refused.output);
    assert.match(refused.output, /must bind a Codex gpt-\* Agent/u);
  } finally {
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        model: agent.model,
        runnerPreference: agent.runnerPreference,
        customizedFields: agent.customizedFields,
      },
    });
  }
  const restored = verify();
  assert.equal(restored.status, 0, restored.output);
});

test("unknown --project id refuses with only the requested id", async () => {
  const unknownId = `missing-project-${randomBytes(5).toString("hex")}`;
  const result = verify(unknownId);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, new RegExp(unknownId, "u"));
  assert.doesNotMatch(result.output, /Project [a-z0-9-]+:/u);
});

test("--project reads canonical identity from the role column, not the editable name", async () => {
  await withProject({ agents: partialRoleNames, identified: true }, async (fixture) => {
    const agent = fixture.agents.get("senior-dev-luna-max")!;
    // R9: name and title are the operator's once `customizedFields` claims
    // them, so a renamed and retitled Agent is still this role, verified.
    await prisma.agent.update({
      where: { id: agent.id },
      data: { name: "house-implementer", title: "House implementer", customizedFields: ["name", "title"] },
    });
    const renamed = verify(fixture.id);
    assert.equal(renamed.status, 0, renamed.output);
    assert.match(renamed.output, /4 active agents/u);

    // The freed slug may then be taken by an operator's own Agent. It is not
    // this role, and the verifier must keep reading the row that is.
    await prisma.agent.create({
      data: {
        projectId: fixture.id,
        environmentId: fixture.environmentId,
        name: "senior-dev-luna-max",
        title: "Operator local implementer",
        model: "custom-operator-model",
        runnerPreference: RunnerPreference.AUTO,
        inboxAccess: false,
        foundationalPrompt: "operator foundational prompt",
        rolePrompt: "operator role prompt",
      },
    });
    const squatted = verify(fixture.id);
    assert.equal(squatted.status, 0, squatted.output);
    assert.match(squatted.output, /4 active agents/u);

    // The customization mark is what makes it an override: withdraw it and the
    // same two fields are drift again, reported against the renamed row.
    await prisma.agent.update({ where: { id: agent.id }, data: { customizedFields: [] } });
    const unmarked = verify(fixture.id);
    assert.notEqual(unmarked.status, 0, unmarked.output);
    assert.match(unmarked.output, new RegExp(`house-implementer \\(${agent.id}\\)`, "u"));
    assert.match(unmarked.output, /name\/title differs from canonical defaults without an operator override/u);
  });
});

test("--project accepts a marked title customization on a legacy, unidentified row", async () => {
  await withProject({ agents: partialRoleNames }, async (fixture) => {
    const agent = fixture.agents.get("code-reviewer-sol-high")!;
    await prisma.agent.update({
      where: { id: agent.id },
      data: { title: "House reviewer", customizedFields: ["title"] },
    });
    const customized = verify(fixture.id);
    assert.equal(customized.status, 0, customized.output);
    assert.match(customized.output, /4 active agents/u);
  });
});
