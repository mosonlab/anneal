import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  INTEGRATOR_AGENT_NAME,
  RepoPermission,
  RunnerPreference,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { RepositoryPreflightError } from "./onboarding-preflight.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
const OPERATOR = "operator-repo-route-token";
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

const call = async (
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> => {
  const response = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

const repoBody = (name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  remoteUrl: "https://github.com/owner/repo.git",
  defaultBranch: "main",
  dependencyProvisioning: "NONE",
  ...overrides,
});

const createProject = async (slug: string): Promise<{ id: string; environmentId: string }> => {
  const project = await db.project.create({ data: { name: `Project ${slug}`, slug } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  return { id: project.id, environmentId: environment.id };
};

const createAgent = async (
  projectId: string,
  environmentId: string,
  name: string,
  archivedAt: Date | null = null,
) => db.agent.create({
  data: {
    projectId,
    environmentId,
    name,
    title: name,
    model: "gpt-5.6-sol:medium",
    runnerPreference: RunnerPreference.CODEX,
    foundationalPrompt: "foundation",
    rolePrompt: "role",
    archivedAt,
  },
});

test("POST repo validates raw remotes and branches before any write or preflight", async () => {
  const project = await createProject("repo-validation");
  let preflightCalls = 0;
  const app = createApp(db, { repositoryPreflight: async () => { preflightCalls += 1; } });
  for (const [remoteUrl, reason] of [
    [" https://github.com/owner/repo.git", "whitespace"],
    ["https://github.com/owner/repo.git\u0001", "control-characters"],
    ["https://token@github.com/owner/repo.git", "embedded-credentials"],
    ["deploy@git.example.com:owner/repo.git", "unsupported-ssh-account"],
  ] as const) {
    const refused = await call(app, "POST", `/projects/${project.id}/repos`, repoBody("invalid", { remoteUrl }));
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, {
      error: "Repository remote is invalid",
      code: "repository-remote-invalid",
      reason,
    });
    assert.equal(JSON.stringify(refused.body).includes(JSON.stringify(remoteUrl).slice(1, -1)), false);
  }
  const branch = await call(app, "POST", `/projects/${project.id}/repos`, repoBody("invalid-branch", { defaultBranch: "bad branch" }));
  assert.equal(branch.status, 400);
  assert.deepEqual(branch.body, {
    error: "Repository default branch is invalid",
    code: "repository-default-branch-invalid",
  });
  assert.equal(await db.repo.count(), 0);
  assert.equal(preflightCalls, 0);
});

test("POST repo preflights exact inputs and maps every preflight refusal", async () => {
  const project = await createProject("repo-preflight");
  const inputs: Array<{ remoteUrl: string; defaultBranch: string; dependencyProvisioning: "NONE" | "NPM_CI" }> = [];
  const app = createApp(db, { repositoryPreflight: async (input) => { inputs.push(input); } });
  for (const [remoteUrl, defaultBranch] of [
    ["https://github.com/owner/repo.git", "main"],
    ["git@github.com:owner/repo.git", "release/v1"],
    ["file:///path/to/repo.git", "main"],
  ] as const) {
    const created = await call(app, "POST", `/projects/${project.id}/repos`, repoBody(`valid-${inputs.length}`, { remoteUrl, defaultBranch }));
    assert.equal(created.status, 201);
    assert.equal(created.body.remoteUrl, remoteUrl);
    assert.equal(created.body.defaultBranch, defaultBranch);
  }
  const defaulted = await call(app, "POST", `/projects/${project.id}/repos`, repoBody("valid-default", {
    remoteUrl: "https://github.com/owner/other.git",
    defaultBranch: undefined,
  }));
  assert.equal(defaulted.status, 201);
  assert.deepEqual(inputs, [
    { remoteUrl: "https://github.com/owner/repo.git", defaultBranch: "main", dependencyProvisioning: "NONE" },
    { remoteUrl: "git@github.com:owner/repo.git", defaultBranch: "release/v1", dependencyProvisioning: "NONE" },
    { remoteUrl: "file:///path/to/repo.git", defaultBranch: "main", dependencyProvisioning: "NONE" },
    { remoteUrl: "https://github.com/owner/other.git", defaultBranch: "main", dependencyProvisioning: "NONE" },
  ]);

  for (const reason of [
    "git-unavailable",
    "git-identity-missing",
    "remote-unreachable",
    "default-branch-missing",
    "push-not-authorized",
    "command-timeout",
  ] as const) {
    const refusalApp = createApp(db, {
      repositoryPreflight: async () => { throw new RepositoryPreflightError(reason); },
    });
    const refused = await call(refusalApp, "POST", `/projects/${project.id}/repos`, repoBody(`refused-${reason}`));
    assert.equal(refused.status, 422);
    assert.deepEqual(refused.body, {
      error: "Repository preflight failed",
      code: "repository-preflight-failed",
      reason,
    });
  }
  assert.equal(await db.repo.count(), 4);
});

test("grantAgents filters archived and integrator Agents and preserves mountPath", async () => {
  const project = await createProject("repo-grants");
  for (const name of ["senior-dev-luna-max", "code-reviewer-sol-high", "code-reviewer-opus-medium", "senior-dev-astra-medium"]) {
    await createAgent(project.id, project.environmentId, name);
  }
  await createAgent(project.id, project.environmentId, "archived-agent", new Date());
  await createAgent(project.id, project.environmentId, INTEGRATOR_AGENT_NAME);
  const app = createApp(db, { repositoryPreflight: async () => {} });
  const created = await call(app, "POST", `/projects/${project.id}/repos`, repoBody("workflow-repo", {
    mountPath: "custom-repo",
    grantAgents: true,
  }));
  assert.equal(created.status, 201);
  assert.equal(created.body.repo.mountPath, "custom-repo");
  assert.equal(created.body.grants.length, 4);
  assert.deepEqual(created.body.grants.map(({ permissions, mountPath }: { permissions: string; mountPath: string }) => ({ permissions, mountPath })), [
    { permissions: RepoPermission.GIT_WRITE, mountPath: "custom-repo" },
    { permissions: RepoPermission.GIT_WRITE, mountPath: "custom-repo" },
    { permissions: RepoPermission.GIT_WRITE, mountPath: "custom-repo" },
    { permissions: RepoPermission.GIT_WRITE, mountPath: "custom-repo" },
  ]);
  assert.equal(await db.agentRepoAccess.count(), 4);
});

test("the A1 bootstrap template instantiates from the true-path Repo without separate grant calls", async () => {
  const app = createApp(db, { repositoryPreflight: async () => {} });
  const projectResult = await call(app, "POST", "/projects", {
    name: "Bootstrapped Project",
    slug: "bootstrapped-project",
  });
  assert.equal(projectResult.status, 201);
  const projectId = projectResult.body.id as string;
  const templates = await db.taskTemplate.findMany({ where: { projectId }, select: { id: true, name: true } });
  assert.deepEqual(templates.map(({ name }) => name), ["pr-engineer-workflow"]);
  const repoResult = await call(app, "POST", `/projects/${projectId}/repos`, repoBody("workflow-repo", { grantAgents: true }));
  assert.equal(repoResult.status, 201);
  assert.equal(repoResult.body.grants.length, 4);
  const instantiated = await call(app, "POST", `/projects/${projectId}/task-templates/${templates[0]!.id}/instantiate`, {
    repoId: repoResult.body.repo.id,
    variables: { branchName: "feature/repo-onboarding" },
    name: "repo onboarding",
  });
  assert.equal(instantiated.status, 201, JSON.stringify(instantiated.body));
  assert.equal(instantiated.body.tasks.length > 0, true);
});

test("grantAgents omitted and false return bare Repo rows without grants", async () => {
  const project = await createProject("repo-bare");
  await createAgent(project.id, project.environmentId, "worker");
  const app = createApp(db, { repositoryPreflight: async () => {} });
  for (const [name, extra] of [["omitted", {}], ["false", { grantAgents: false }]] as const) {
    const created = await call(app, "POST", `/projects/${project.id}/repos`, repoBody(name, extra));
    assert.equal(created.status, 201);
    assert.equal(typeof created.body.id, "string");
    assert.equal("repo" in created.body, false);
    assert.equal("grants" in created.body, false);
  }
  assert.equal(await db.agentRepoAccess.count(), 0);
});

test("Repo and every grant roll back together, while duplicate and PATCH contracts stay unchanged", async () => {
  const project = await createProject("repo-atomic");
  await createAgent(project.id, project.environmentId, "worker-a");
  await createAgent(project.id, project.environmentId, "worker-b");
  let writes = 0;
  const failingDb = new Proxy(db, {
    get(target, property) {
      if (property !== "$transaction") {
        const value = (target as unknown as Record<string | symbol, unknown>)[property];
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (operation: (client: unknown) => Promise<unknown>, options: unknown) => db.$transaction((tx) => {
        const agentRepoAccess = tx.agentRepoAccess;
        const wrapped = new Proxy(agentRepoAccess, {
          get(targetAccess, accessProperty) {
            if (accessProperty !== "create") {
              const value = (targetAccess as unknown as Record<string | symbol, unknown>)[accessProperty];
              return typeof value === "function" ? value.bind(targetAccess) : value;
            }
            return async (...args: unknown[]) => {
              writes += 1;
              if (writes === 2) throw new Error("injected grant failure");
              return targetAccess.create(args[0] as never);
            };
          },
        });
        return operation(new Proxy(tx, {
          get(targetTx, txProperty) {
            if (txProperty === "agentRepoAccess") return wrapped;
            const value = (targetTx as unknown as Record<string | symbol, unknown>)[txProperty];
            return typeof value === "function" ? value.bind(targetTx) : value;
          },
        }));
      }, options as never);
    },
  }) as PrismaClient;
  const failingApp = createApp(failingDb, { repositoryPreflight: async () => {} });
  const failed = await call(failingApp, "POST", `/projects/${project.id}/repos`, repoBody("rollback", { grantAgents: true }));
  assert.equal(failed.status, 500);
  assert.equal(await db.repo.count(), 0);
  assert.equal(await db.agentRepoAccess.count(), 0);

  const preflightInputs: Array<{ remoteUrl: string; defaultBranch: string; dependencyProvisioning: "NONE" | "NPM_CI" }> = [];
  const app = createApp(db, { repositoryPreflight: async (input) => { preflightInputs.push(input); } });
  const first = await call(app, "POST", `/projects/${project.id}/repos`, repoBody("duplicate"));
  assert.equal(first.status, 201);
  const duplicate = await call(app, "POST", `/projects/${project.id}/repos`, repoBody("duplicate"));
  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicate.body, { error: "Unique constraint violated" });
  const patched = await call(app, "PATCH", `/repos/${first.body.id}`, { remoteUrl: "  https://github.com/owner/repo.git  " });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.remoteUrl, "https://github.com/owner/repo.git");
  assert.equal(preflightInputs.length, 2, "PATCH must not invoke POST preflight");
});
