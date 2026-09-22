import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  loadAgentSources,
  loadAllTemplateStepSources,
  NetworkingMode,
  PR_TEMPLATE_NAME,
  type PrismaClient,
  type Project,
  type TemplateStepSource,
} from "@anneal/db";

import {
  PROJECT_BOOTSTRAP_ROLE_NAMES,
  type ProjectBootstrapLoaders,
} from "./project-bootstrap.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
const OPERATOR = "operator-project-bootstrap-token";
const priorOperatorToken = process.env.OPERATOR_TOKEN;

before(() => {
  process.env.OPERATOR_TOKEN = OPERATOR;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
});

const body = (slug = "workflow-project"): { name: string; slug: string; yamlDocument: string } => ({
  name: "Workflow Project",
  slug,
  yamlDocument: "",
});

const call = async (
  method: string,
  path: string,
  requestBody?: unknown,
  database: PrismaClient = db,
  options: { projectBootstrapLoaders?: Partial<ProjectBootstrapLoaders> } = {},
): Promise<{ status: number; body: any }> => {
  const response = await createApp(database, options).request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

const canonicalSources = async (): Promise<{
  roles: Awaited<ReturnType<typeof loadAgentSources>>;
  templateSteps: TemplateStepSource[];
}> => {
  const [roles, templates] = await Promise.all([loadAgentSources(), loadAllTemplateStepSources()]);
  return { roles, templateSteps: templates.get(PR_TEMPLATE_NAME)! };
};

const bindFailureAfterAgents = (real: PrismaClient): PrismaClient => {
  const bind = (target: object, property: string | symbol): unknown => {
    const value = (target as Record<string | symbol, unknown>)[property];
    return typeof value === "function" ? value.bind(target) : value;
  };
  return new Proxy(real, {
    get(target, property) {
      if (property !== "$transaction") return bind(target, property);
      return (run: (tx: unknown) => unknown, options: unknown) => real.$transaction((tx) => run(new Proxy(tx, {
        get(txTarget, txProperty) {
          if (txProperty !== "taskTemplate") return bind(txTarget, txProperty);
          const taskTemplate = bind(txTarget, txProperty) as { create: (...args: unknown[]) => unknown };
          return new Proxy(taskTemplate, {
            get(templateTarget, templateProperty) {
              if (templateProperty === "create") return () => { throw new Error("injected project bootstrap failure"); };
              return bind(templateTarget, templateProperty);
            },
          });
        },
      })) as never, options as never);
    },
  }) as PrismaClient;
};

type BootstrapAgentResponse = {
  name: string;
  environmentId: string;
  title: string;
  model: string;
  runnerPreference: string;
  inboxAccess: boolean;
  foundationalPrompt: string;
  rolePrompt: string;
  disabledTools: string[];
};

type BootstrapTemplateResponse = {
  name: string;
  variables: string[];
  steps: Array<{
    name: string;
    stepIndex: number;
    layer: number;
    assigneeAgent: { name: string } | null;
    approvalGate: boolean;
    outputKind: string;
    priorOutputKinds: string[];
    attachmentsFromPrevious: boolean;
    opensPullRequest: boolean;
    requiresCommit: boolean;
    baseFromStepIndex: number | null;
    spawnPolicy: unknown;
  }>;
};

test("POST /projects creates the workflow-ready Project shape", async () => {
  const created = await call("POST", "/projects", body());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body as Project;

  const environmentResponse = await call("GET", `/projects/${project.id}/environments`);
  assert.equal(environmentResponse.status, 200, JSON.stringify(environmentResponse.body));
  const environment = environmentResponse.body as Array<{
    id: string;
    name: string;
    networking: NetworkingMode;
    allowedHosts: string[];
  }>;
  assert.equal(environment.length, 1);
  assert.deepEqual(environment.map(({ name, networking, allowedHosts }) => ({ name, networking, allowedHosts })), [{
    name: "local",
    networking: NetworkingMode.OPEN,
    allowedHosts: [],
  }]);

  const [{ roles, templateSteps }] = await Promise.all([canonicalSources()]);
  const expectedRoles = new Map(roles.roles
    .filter(({ name }) => (PROJECT_BOOTSTRAP_ROLE_NAMES as readonly string[]).includes(name))
    .map((role) => [role.name, role]));
  const agentResponse = await call("GET", `/projects/${project.id}/agents`);
  assert.equal(agentResponse.status, 200, JSON.stringify(agentResponse.body));
  const agents = (agentResponse.body as BootstrapAgentResponse[])
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(agents.map(({ name }) => name), [...PROJECT_BOOTSTRAP_ROLE_NAMES].sort());
  for (const agent of agents) {
    const role = expectedRoles.get(agent.name)!;
    assert.equal(agent.environmentId, environment[0]!.id);
    assert.deepEqual({
      title: agent.title,
      model: agent.model,
      runnerPreference: agent.runnerPreference,
      inboxAccess: agent.inboxAccess,
      foundationalPrompt: agent.foundationalPrompt,
      rolePrompt: agent.rolePrompt,
      disabledTools: agent.disabledTools,
    }, {
      title: role.title,
      model: role.model,
      runnerPreference: role.runnerPreference,
      inboxAccess: role.inboxAccess,
      foundationalPrompt: roles.foundationalPrompt,
      rolePrompt: role.rolePrompt,
      disabledTools: [],
    });
  }

  const templateResponse = await call("GET", `/projects/${project.id}/task-templates`);
  assert.equal(templateResponse.status, 200, JSON.stringify(templateResponse.body));
  const templates = templateResponse.body as BootstrapTemplateResponse[];
  assert.equal(templates.length, 1);
  const template = templates[0]!;
  assert.equal(template.name, PR_TEMPLATE_NAME);
  assert.deepEqual(template.variables, ["branchName"]);
  assert.deepEqual(template.steps.map(({ name, stepIndex, layer, assigneeAgent, approvalGate, outputKind,
    priorOutputKinds, attachmentsFromPrevious, opensPullRequest, requiresCommit, baseFromStepIndex, spawnPolicy }) => ({
    name, stepIndex, layer, agent: assigneeAgent?.name ?? null, approvalGate, outputKind,
    priorOutputKinds, attachmentsFromPrevious, opensPullRequest, requiresCommit, baseFromStepIndex, spawnPolicy,
  })), templateSteps.map(({ name, stepIndex, layer, agentName, approvalGate, outputKind, priorOutputKinds,
    attachmentsFromPrevious, opensPullRequest, requiresCommit, baseFromStepIndex, spawnPolicy }) => ({
    name, stepIndex, layer, agent: agentName, approvalGate, outputKind, priorOutputKinds,
    attachmentsFromPrevious, opensPullRequest, requiresCommit, baseFromStepIndex, spawnPolicy,
  })));
});

test("duplicate and concurrent slugs leave exactly one complete installation", async () => {
  const first = await call("POST", "/projects", body("same-slug"));
  assert.equal(first.status, 201);
  const countsBefore = await Promise.all([
    db.project.count(), db.environment.count(), db.agent.count(), db.taskTemplate.count(),
  ]);
  const duplicate = await call("POST", "/projects", body("same-slug"));
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.code, "project-slug-taken");
  assert.deepEqual(await Promise.all([
    db.project.count(), db.environment.count(), db.agent.count(), db.taskTemplate.count(),
  ]), countsBefore);

  await resetTestDb(db);
  const results = await Promise.all([
    call("POST", "/projects", body("racing-slug")),
    call("POST", "/projects", body("racing-slug")),
  ]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [201, 409]);
  assert.equal(await db.project.count({ where: { slug: "racing-slug" } }), 1);
  assert.equal(await db.environment.count(), 1);
  assert.equal(await db.agent.count(), 4);
  assert.equal(await db.taskTemplate.count(), 1);
});

test("a failure after Agents are written rolls back the complete bootstrap", async () => {
  const failed = await call("POST", "/projects", body("rollback-project"), bindFailureAfterAgents(db));
  assert.equal(failed.status, 500);
  assert.equal(await db.project.count({ where: { slug: "rollback-project" } }), 0);
  assert.equal(await db.environment.count(), 0);
  assert.equal(await db.agent.count(), 0);
  assert.equal(await db.taskTemplate.count(), 0);
});

test("role and template source failures happen before any Project row is written", async () => {
  const actualRoles = await loadAgentSources();
  const actualTemplates = await loadAllTemplateStepSources();
  const cases: Array<{ slug: string; loaders: Partial<ProjectBootstrapLoaders> }> = [
    {
      slug: "role-loader-failure",
      loaders: { loadAgentSources: async () => { throw new Error("role loader failed"); } },
    },
    {
      slug: "template-loader-failure",
      loaders: { loadAllTemplateStepSources: async () => { throw new Error("template loader failed"); } },
    },
    {
      slug: "role-missing",
      loaders: {
        loadAgentSources: async () => ({
          ...actualRoles,
          roles: actualRoles.roles.filter(({ name }) => name !== "senior-dev-opus-medium"),
        }),
      },
    },
    {
      slug: "template-missing",
      loaders: {
        loadAllTemplateStepSources: async () => {
          const missing = new Map(actualTemplates);
          missing.delete(PR_TEMPLATE_NAME);
          return missing;
        },
      },
    },
  ];
  for (const { slug, loaders } of cases) {
    const failed = await call("POST", "/projects", body(slug), db, { projectBootstrapLoaders: loaders });
    assert.ok(failed.status >= 500, `${slug}: ${failed.status}`);
    assert.equal(await db.project.count({ where: { slug } }), 0, slug);
  }
});

test("POST /projects installs one default staffing profile per installed template", async () => {
  const created = await call("POST", "/projects", body("staffing-bootstrap"));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const project = created.body as Project;

  const templates = await db.taskTemplate.findMany({ where: { projectId: project.id }, select: { id: true } });
  const profiles = await db.staffingProfile.findMany({
    where: { projectId: project.id },
    include: { entries: { orderBy: { outputKind: "asc" } } },
  });
  assert.deepEqual(
    profiles.map(({ taskTemplateId, name, isDefault }) => ({ taskTemplateId, name, isDefault })),
    templates.map(({ id }) => ({ taskTemplateId: id, name: "Default", isDefault: true })),
  );

  // The initial profile is the canonical plan: each step's own binding, and
  // every optional step kept.
  const steps = await db.taskTemplateStep.findMany({
    where: { taskTemplateId: profiles[0]!.taskTemplateId },
    orderBy: { outputKind: "asc" },
    select: { outputKind: true, assigneeAgentId: true, optional: true },
  });
  assert.ok(steps.length > 0);
  assert.deepEqual(
    profiles[0]!.entries.map(({ outputKind, assigneeAgentId, include }) => ({ outputKind, assigneeAgentId, include })),
    steps.map((step) => ({
      outputKind: step.outputKind,
      assigneeAgentId: step.assigneeAgentId,
      include: step.optional ? true : null,
    })),
  );
});
