import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexServiceTier,
  Prisma,
  RunnerPreference,
  loadAgentSources,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "../test-app.js";
import {
  preflightRepository,
  RepositoryPreflightError,
  type RepositoryPreflightCommand,
} from "../onboarding-preflight.js";
import { lockedAgent, untouchableDatabase, withTokens } from "./test-support.js";

test("filesystem grant CRUD accepts root/canonical paths and rejects non-canonical paths", async () => {
  await withTokens(async () => {
    const saved: string[] = [];
    const database = {
      filesystemGrant: {
        upsert: async ({ create }: { create: { folderPath: string } }) => { saved.push(create.folderPath); return create; },
        findFirst: async () => ({ id: "grant-1", agentId: "agent-1" }),
        findMany: async () => saved.map((folderPath, index) => ({ id: `grant-${index}`, folderPath })),
        update: async ({ data }: { data: { folderPath?: string } }) => { if (data.folderPath !== undefined) saved.push(data.folderPath); return data; },
      },
    } as unknown as PrismaClient;
    const app = createApp(database);
    const request = (folderPath: string) => app.request("/agents/agent-1/filesystem-grants", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath, canRead: true }),
    });
    assert.equal((await request("")).status, 201);
    for (const path of ["/abs", "a/../b", "a/"]) assert.equal((await request(path)).status, 400, path);
    assert.equal((await request("  _global  ")).status, 201);
    // Whitespace-only must not trim down to the whole-Files-Root sentinel.
    for (const blank of [" ", "   ", "\t\n "]) assert.equal((await request(blank)).status, 400, JSON.stringify(blank));
    const patchResponse = await app.request("/agents/agent-1/filesystem-grants/grant-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath: "patched", canWrite: true }),
    });
    assert.equal(patchResponse.status, 200);
    assert.deepEqual(saved, ["", "_global", "patched"]);
  });
});

test("agent archive and unarchive are idempotent and preserve the original archive timestamp", async () => {
  await withTokens(async () => {
    let archivedAt: Date | null = null;
    const updates: Array<Date | null> = [];
    const noticeIds = new Set<string>();
    const agentRow = () => ({ id: "agent-1", name: "Agent", archivedAt });
    const agentClient = {
      findUnique: async () => agentRow(),
      findUniqueOrThrow: async () => agentRow(),
      update: async ({ data }: { data: { archivedAt: Date | null } }) => {
        archivedAt = data.archivedAt;
        updates.push(archivedAt);
        return agentRow();
      },
    };
    const database = {
      agent: agentClient,
      // Archive now runs under the Agent-row mutex and fails closed on live
      // references, so the transaction client answers the lock and both
      // reference reads. Nothing is queued or in flight here.
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [{ id: "agent-1", archivedAt }],
        agent: agentClient,
        // The completion route reads the run's step binding before the
      // transaction, to bind a mechanical completion to the merge-executor
      // principal (§D-P1 rule 3). An ordinary run has no template step.
      run: { findFirst: async () => null, findUnique: async () => ({ runnerId: "runner-1", task: { templateStep: null } }) },
        task: { findFirst: async () => null },
        // R6: archive also reads the staffing profiles naming this Agent. No
        // profile names it here, so the archive proceeds.
        staffingProfileEntry: { findMany: async () => [] },
        staffingProfileTier: { findMany: async () => [] },
      }),
      run: {
        findMany: async () => archivedAt ? [{
          id: "run-queued", taskId: "task-1", runNumber: 1,
          agent: { name: "Agent", archivedAt },
        }] : [],
      },
      taskActivity: {
        createMany: async ({ data }: { data: Array<{ id: string }> }) => {
          let count = 0;
          for (const row of data) {
            if (noticeIds.has(row.id)) continue;
            noticeIds.add(row.id);
            count += 1;
          }
          return { count };
        },
      },
    } as unknown as PrismaClient;
    const app = createApp(database);
    const request = (path: string) => app.request(path, {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token" },
    });

    const archived = await request("/agents/agent-1/archive");
    assert.equal(archived.status, 200);
    assert.ok(updates[0] instanceof Date);
    const originalTimestamp = archivedAt;
    assert.equal((await request("/agents/agent-1/archive")).status, 200);
    assert.equal(archivedAt, originalTimestamp);
    assert.equal(updates.length, 1);
    assert.equal(noticeIds.size, 1);
    assert.match([...noticeIds][0]!, /^archived-skip:run-queued:/);

    const unarchived = await request("/agents/agent-1/unarchive");
    assert.equal(unarchived.status, 200);
    assert.equal(archivedAt, null);
    assert.equal((await request("/agents/agent-1/unarchive")).status, 200);
    assert.deepEqual(updates, [originalTimestamp, null]);
  });
});

test("archiving an agent fails closed on a live run or any live task", async () => {
  await withTokens(async () => {
    // Both references are the same defect one step apart: a run queued for an
    // archived agent is filtered out of every claim, so it never runs and its
    // task never completes. Refusing the archive keeps the operator's options.
    // A task reference does not need a run to be live — TODO and REVIEW rows
    // are exactly the ones no run exists for yet, and archiving under them is
    // what strands the step that would have created it.
    const cases = [
      {
        run: { runNumber: 2, status: "QUEUED", task: { name: "Ship it" } },
        task: null,
        expected: "Cannot archive an agent with a QUEUED run on Ship it; finish or cancel run 2 first",
      },
      {
        run: null,
        task: { name: "Ship it", status: "DOING" },
        expected: "Cannot archive an agent assigned to DOING task Ship it; finish, park, archive, or reassign that task first",
      },
      {
        run: null,
        task: { name: "Tomorrow's sweep", status: "TODO" },
        expected: "Cannot archive an agent assigned to TODO task Tomorrow's sweep; finish, park, archive, or reassign that task first",
      },
      {
        run: null,
        task: { name: "Awaiting the gate", status: "REVIEW" },
        expected: "Cannot archive an agent assigned to REVIEW task Awaiting the gate; finish, park, archive, or reassign that task first",
      },
    ];
    for (const { run, task, expected } of cases) {
      let updates = 0;
      const database = {
        agent: {
          findUniqueOrThrow: async () => ({ id: "agent-1", name: "Agent", archivedAt: null }),
          update: async () => { updates += 1; return {}; },
        },
        $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
          $queryRaw: async () => [{ id: "agent-1", archivedAt: null }],
          agent: {
            findUnique: async () => ({ id: "agent-1", name: "Agent", archivedAt: null }),
            findUniqueOrThrow: async () => ({ id: "agent-1", name: "Agent", archivedAt: null }),
            update: async () => { updates += 1; return {}; },
          },
          run: { findFirst: async () => run },
          task: { findFirst: async () => task },
        }),
      } as unknown as PrismaClient;
      const response = await createApp(database).request("/agents/agent-1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token" },
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: expected });
      assert.equal(updates, 0, "a refused archive writes nothing");
    }
  });
});

test("archive and unarchive return 404 for a missing agent", async () => {
  await withTokens(async () => {
    const database = {
      agent: { findUnique: async () => null },
      // No row to lock is the archive route's 404.
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [],
      }),
    } as unknown as PrismaClient;
    const app = createApp(database);
    for (const action of ["archive", "unarchive"]) {
      const response = await app.request(`/agents/missing/${action}`, {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token" },
      });
      assert.equal(response.status, 404);
    }
  });
});

type AgentDeleteReferences = {
  tasks: number;
  runs: number;
  sessions: number;
  staffingProfiles: number;
};

const agentDeleteDatabase = (
  references: AgentDeleteReferences = { tasks: 0, runs: 0, sessions: 0, staffingProfiles: 0 },
  exists = true,
): { database: PrismaClient; deleted: boolean } => {
  let deleted = false;
  const tx = {
    $queryRaw: async () => (exists ? [{ id: "agent-1" }] : []),
    agent: {
      findUnique: async () => (exists ? { id: "agent-1" } : null),
      delete: async () => { deleted = true; return {}; },
    },
    task: { count: async () => references.tasks },
    run: { count: async () => references.runs },
    session: { count: async () => references.sessions },
    staffingProfile: { count: async () => references.staffingProfiles },
  };
  return {
    database: {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient,
    get deleted() { return deleted; },
  };
};

test("deleting an agent with references returns typed counts and preserves the row", async () => {
  await withTokens(async () => {
    const fixture = agentDeleteDatabase({ tasks: 2, runs: 1, sessions: 1, staffingProfiles: 3 });
    const response = await createApp(fixture.database).request("/agents/agent-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Agent has task, run, session, or staffing profile references; remove them before deleting it",
      code: "agent_referenced",
      references: { tasks: 2, runs: 1, sessions: 1, staffingProfiles: 3 },
    });
    assert.equal(fixture.deleted, false);
  });
});

test("deleting an unknown agent returns 404", async () => {
  await withTokens(async () => {
    const fixture = agentDeleteDatabase(undefined, false);
    const response = await createApp(fixture.database).request("/agents/missing-agent", {
      method: "DELETE",
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Agent not found" });
    assert.equal(fixture.deleted, false);
  });
});

test("deleting a history-free agent still returns 204", async () => {
  await withTokens(async () => {
    const fixture = agentDeleteDatabase();
    const response = await createApp(fixture.database).request("/agents/agent-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 204);
    assert.equal(fixture.deleted, true);
  });
});

test("Agent API refuses Fast for a non-Codex model", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/projects/project-1/agents", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        environmentId: "environment-1",
        name: "claude-fast",
        title: "Claude Fast",
        model: "claude-opus-5:medium",
        rolePrompt: "work",
        runnerPreference: "CLAUDE",
        codexServiceTier: "FAST",
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Fast service tier requires a Codex gpt-* model or a PI openai-codex/* model",
    });
  });
});

/**
 * The compound implementation root is now a capability, not a name (R14). These
 * cases pin what that means for PATCH: the binding decides the runtime refusal,
 * the sentinel keeps its name, an unbound Agent may take any runtime the catalog
 * allows, and each edit marks only the fields it changed.
 */
const patchAgentDatabase = (
  agent: Record<string, unknown> | null,
  options: { compoundStep?: boolean } = {},
): { database: PrismaClient; updates: Array<Record<string, unknown>> } => {
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => (agent ? [{ id: agent.id }] : []),
    agent: {
      findUnique: async () => agent,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { ...agent, ...data };
      },
    },
    taskTemplateStep: {
      findMany: async () => (options.compoundStep
        ? [{ stepIndex: 5, outputKind: "implementation", taskTemplate: { name: "compound-engineer-workflow" } }]
        : []),
    },
  };
  return {
    updates,
    database: {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient,
  };
};

const executorRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => lockedAgent({
  id: "agent-executor",
  projectId: "project-1",
  environmentId: "environment-1",
  name: "plan-executor-astra-low",
  canonicalRole: "plan-executor-astra-low",
  customizedFields: [],
  title: "Plan Executor",
  model: "gpt-5.6-sol:high",
  runnerPreference: RunnerPreference.CODEX,
  foundationalPrompt: "foundation",
  rolePrompt: "role",
  ...overrides,
})!;

test("Agent API refuses a non-Codex runtime for an Agent bound to a compound implementation root", async () => {
  await withTokens(async () => {
    const executor = executorRow();
    const { database, updates } = patchAgentDatabase(executor, { compoundStep: true });
    const response = await createApp(database).request(`/agents/${executor.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "An Agent bound to a compound implementation root requires a Codex gpt-* model",
    });
    assert.deepEqual(updates, []);
  });
});

test("Agent API allows the same runtime edit for an Agent that binds no compound implementation root", async () => {
  await withTokens(async () => {
    const executor = executorRow({ id: "agent-unbound", name: "senior-dev-astra-medium", canonicalRole: "senior-dev-astra-medium" });
    const { database, updates } = patchAgentDatabase(executor);
    const response = await createApp(database).request(`/agents/${executor.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(updates, [{
      model: "claude-opus-5:medium",
      runnerPreference: RunnerPreference.CLAUDE,
      customizedFields: ["model", "runnerPreference"],
    }]);
  });
});

test("Agent API refuses renaming the mechanical merge sentinel and allows renaming any other Agent", async () => {
  await withTokens(async () => {
    const sentinel = executorRow({ id: "agent-sentinel", name: "merge-integrator", canonicalRole: "merge-integrator" });
    const refused = patchAgentDatabase(sentinel);
    const response = await createApp(refused.database).request(`/agents/${sentinel.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed-sentinel" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "merge-integrator is the mechanical merge sentinel and its name cannot be changed",
    });
    assert.deepEqual(refused.updates, []);

    // The executor's canonical identity is its role, so its slug is the operator's.
    const executor = executorRow();
    const allowed = patchAgentDatabase(executor, { compoundStep: true });
    const renamed = await createApp(allowed.database).request(`/agents/${executor.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "our-plan-executor" }),
    });
    assert.equal(renamed.status, 200);
    assert.deepEqual(allowed.updates, [{ name: "our-plan-executor", customizedFields: ["name"] }]);
  });
});

test("Agent API marks only the fields an edit actually changes", async () => {
  await withTokens(async () => {
    const executor = executorRow({ customizedFields: ["model"] });
    const { database, updates } = patchAgentDatabase(executor, { compoundStep: true });
    const response = await createApp(database).request(`/agents/${executor.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Renamed title",
        model: executor.model,
        runnerPreference: executor.runnerPreference,
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(updates, [{
      title: "Renamed title",
      model: "gpt-5.6-sol:high",
      runnerPreference: RunnerPreference.CODEX,
      customizedFields: ["model", "title"],
    }]);
  });
});

test("reset-runtime-config restores canonical runtime values and refuses invalid reset targets", async () => {
  await withTokens(async () => {
    const roles = (await loadAgentSources()).roles;
    const canonicalRole = roles.find(({ canonicalRole: role }) => role === "default");
    const nonCodexRole = roles.find(({ runnerPreference }) => runnerPreference === RunnerPreference.CLAUDE);
    assert.ok(canonicalRole);
    assert.ok(nonCodexRole);
    const updates: Array<Record<string, unknown>> = [];
    // Renamed by the operator, and still the `default` role: the reset finds its
    // source by canonicalRole, not by the name on the row.
    const canonical = lockedAgent({
      id: "agent-default",
      name: "our-default",
      canonicalRole: "default",
      customizedFields: ["name", "model", "runnerPreference"],
      model: "custom-model",
      runnerPreference: RunnerPreference.CLAUDE,
      runtimeConfigDriftNoticeFingerprint: "stale-fingerprint",
    });
    const tx = {
      $queryRaw: async (_strings: unknown, agentId: string) => agentId === "missing" ? [] : [{ id: agentId }],
      taskTemplateStep: { findMany: async () => [] },
      agent: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (where.id === "agent-custom") return lockedAgent({
            id: "agent-custom",
            name: "operator-agent",
            canonicalRole: null,
            customizedFields: [],
            model: "custom-model",
            runnerPreference: RunnerPreference.CLAUDE,
          });
          if (where.id === "agent-archived") return lockedAgent({
            id: "agent-archived",
            name: "default",
            canonicalRole: "default",
            customizedFields: [],
            archivedAt: new Date(),
            model: canonical!.model,
            runnerPreference: canonical!.runnerPreference,
          });
          if (where.id === "agent-fast-tier") return lockedAgent({
            id: "agent-fast-tier",
            name: nonCodexRole.name,
            canonicalRole: nonCodexRole.canonicalRole,
            customizedFields: ["model", "runnerPreference"],
            model: "gpt-5.6-sol:high",
            runnerPreference: RunnerPreference.CODEX,
            codexServiceTier: CodexServiceTier.FAST,
          });
          if (where.id === canonical!.id) return canonical;
          return null;
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return { ...canonical, ...data };
        },
      },
    };
    const database = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const app = createApp(database);
    const request = (agentId: string) => app.request(`/agents/${agentId}/reset-runtime-config`, {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token" },
    });

    assert.equal((await request("missing")).status, 404);
    assert.equal((await request("agent-custom")).status, 400);
    assert.equal((await request("agent-archived")).status, 409);
    const tierRefusal = await request("agent-fast-tier");
    assert.equal(tierRefusal.status, 400);
    assert.deepEqual(await tierRefusal.json(), {
      error: "Fast service tier requires a Codex gpt-* model or a PI openai-codex/* model",
    });
    const reset = await request(canonical!.id);
    assert.equal(reset.status, 200);
    // The reset clears only what it restored: the operator's rename survives it.
    assert.deepEqual(updates, [{
      model: canonicalRole.model,
      runnerPreference: canonicalRole.runnerPreference,
      customizedFields: ["name"],
      runtimeConfigDriftNoticeFingerprint: null,
    }]);
  });
});

test("POST repo validates the raw remote and branch before preflight or database access", async () => {
  await withTokens(async () => {
    let preflightCalls = 0;
    const app = createApp(untouchableDatabase(), {
      repositoryPreflight: async () => { preflightCalls += 1; },
    });
    const request = (body: Record<string, unknown>) => app.request("/projects/project-1/repos", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const base = { name: "app", defaultBranch: "main", dependencyProvisioning: "NONE" };
    for (const [remoteUrl, reason] of [
      [" https://github.com/owner/repo.git", "whitespace"],
      ["https://github.com/owner/repo.git\n", "control-characters"],
      ["https://token@github.com/owner/repo.git", "embedded-credentials"],
      ["deploy@git.example.com:owner/repo.git", "unsupported-ssh-account"],
    ] as const) {
      const response = await request({ ...base, remoteUrl });
      assert.equal(response.status, 400);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), {
        error: "Repository remote is invalid",
        code: "repository-remote-invalid",
        reason,
      });
      assert.equal(text.includes(JSON.stringify(remoteUrl).slice(1, -1)), false);
    }
    const invalidBranch = await request({ ...base, remoteUrl: "https://github.com/owner/repo.git", defaultBranch: "bad branch" });
    assert.equal(invalidBranch.status, 400);
    assert.deepEqual(await invalidBranch.json(), {
      error: "Repository default branch is invalid",
      code: "repository-default-branch-invalid",
    });
    assert.equal(preflightCalls, 0);
  });
});

test("Repo dependency provisioning is required on POST and exact on invalid PATCH", async () => {
  await withTokens(async () => {
    let preflightCalls = 0;
    const app = createApp(untouchableDatabase(), {
      repositoryPreflight: async () => { preflightCalls += 1; },
    });
    const request = (method: "POST" | "PATCH", path: string, body: Record<string, unknown>) => app.request(path, {
      method,
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const invalid = {
      error: "Repository dependency provisioning is invalid",
      code: "repository-dependency-provisioning-invalid",
    };
    for (const body of [
      { name: "missing", remoteUrl: "https://github.com/owner/repo.git" },
      { name: "unknown", remoteUrl: "https://github.com/owner/repo.git", dependencyProvisioning: "YARN" },
    ]) {
      const response = await request("POST", "/projects/project-1/repos", body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), invalid);
    }
    const patch = await request("PATCH", "/repos/repo-1", { dependencyProvisioning: "YARN" });
    assert.equal(patch.status, 400);
    assert.deepEqual(await patch.json(), invalid);
    assert.equal(preflightCalls, 0);
  });
});

test("Repo dependency provisioning round-trips through GET and PATCH", async () => {
  await withTokens(async () => {
    let stored: "NONE" | "NPM_CI" = "NONE";
    const row = () => ({
      id: "repo-1", projectId: "project-1", credentialSecretId: null, name: "app",
      remoteUrl: "https://github.com/owner/repo.git", mountPath: "repo", defaultBranch: "main",
      dependencyProvisioning: stored, createdAt: new Date(0), updatedAt: new Date(0),
    });
    const database = {
      repo: {
        findMany: async () => [row()],
        findUnique: async () => row(),
        update: async ({ data }: { data: { dependencyProvisioning?: "NONE" | "NPM_CI" } }) => {
          if (data.dependencyProvisioning !== undefined) stored = data.dependencyProvisioning;
          return row();
        },
      },
    } as unknown as PrismaClient;
    const app = createApp(database);
    const headers = { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" };
    const listed = await app.request("/projects/project-1/repos", { headers });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json() as Array<Record<string, unknown>>)[0]?.dependencyProvisioning, "NONE");
    const patched = await app.request("/repos/repo-1", {
      method: "PATCH", headers, body: JSON.stringify({ dependencyProvisioning: "NPM_CI" }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json() as Record<string, unknown>).dependencyProvisioning, "NPM_CI");
    const omitted = await app.request("/repos/repo-1", {
      method: "PATCH", headers, body: JSON.stringify({ name: "renamed" }),
    });
    assert.equal(omitted.status, 200);
    assert.equal((await omitted.json() as Record<string, unknown>).dependencyProvisioning, "NPM_CI");
    const patchedNone = await app.request("/repos/repo-1", {
      method: "PATCH", headers, body: JSON.stringify({ dependencyProvisioning: "NONE" }),
    });
    assert.equal(patchedNone.status, 200);
    assert.equal((await patchedNone.json() as Record<string, unknown>).dependencyProvisioning, "NONE");
    const listedAfterPatch = await app.request("/projects/project-1/repos", { headers });
    assert.equal(listedAfterPatch.status, 200);
    assert.equal((await listedAfterPatch.json() as Array<Record<string, unknown>>)[0]?.dependencyProvisioning, "NONE");
  });
});

test("PATCH repo preflights stored and patched repository identity before writing", async () => {
  await withTokens(async () => {
    const events: string[] = [];
    const preflightInputs: Array<{ remoteUrl: string; defaultBranch: string; dependencyProvisioning: "NONE" | "NPM_CI" }> = [];
    const database = {
      repo: {
        findUnique: async () => ({ remoteUrl: "https://github.com/owner/stored.git", defaultBranch: "main" }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          events.push("update");
          return {
            id: "repo-1", projectId: "project-1", credentialSecretId: null, name: "app",
            remoteUrl: data.remoteUrl ?? "https://github.com/owner/stored.git",
            mountPath: "repo", defaultBranch: data.defaultBranch ?? "main",
            dependencyProvisioning: data.dependencyProvisioning ?? "NONE",
            createdAt: new Date(0), updatedAt: new Date(0),
          };
        },
      },
    } as unknown as PrismaClient;
    const app = createApp(database, {
      repositoryPreflight: async (input) => {
        events.push("preflight");
        preflightInputs.push(input);
      },
    });
    const response = await app.request("/repos/repo-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ dependencyProvisioning: "NPM_CI", remoteUrl: "https://github.com/owner/patched.git", defaultBranch: "release/v1" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(preflightInputs, [{
      remoteUrl: "https://github.com/owner/patched.git",
      defaultBranch: "release/v1",
      dependencyProvisioning: "NPM_CI",
    }]);
    assert.deepEqual(events, ["preflight", "update"]);

    const storedValues: Array<{ remoteUrl: string; defaultBranch: string }> = [];
    const storedApp = createApp({
      repo: {
        findUnique: async () => ({ remoteUrl: "https://github.com/owner/stored.git", defaultBranch: "main" }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          storedValues.push({
            remoteUrl: String(data.remoteUrl ?? "https://github.com/owner/stored.git"),
            defaultBranch: String(data.defaultBranch ?? "main"),
          });
          return data;
        },
      },
    } as unknown as PrismaClient, {
      repositoryPreflight: async (input) => {
        preflightInputs.push(input);
      },
    });
    const storedResponse = await storedApp.request("/repos/repo-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ dependencyProvisioning: "NONE" }),
    });
    assert.equal(storedResponse.status, 200);
    assert.deepEqual(preflightInputs.at(-1), {
      remoteUrl: "https://github.com/owner/stored.git",
      defaultBranch: "main",
      dependencyProvisioning: "NONE",
    });
    assert.deepEqual(storedValues, [{
      remoteUrl: "https://github.com/owner/stored.git",
      defaultBranch: "main",
    }]);
  });
});

test("PATCH repo applies remote policy to the raw value before preflight or writing", async () => {
  await withTokens(async () => {
    let preflights = 0;
    let updates = 0;
    const app = createApp({
      repo: {
        findUnique: async () => ({ remoteUrl: "https://github.com/owner/stored.git", defaultBranch: "main" }),
        update: async () => { updates += 1; return {}; },
      },
    } as unknown as PrismaClient, {
      repositoryPreflight: async () => { preflights += 1; },
    });

    const response = await app.request("/repos/repo-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ dependencyProvisioning: "NPM_CI", remoteUrl: "  https://github.com/owner/patched.git" }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Repository remote is invalid",
      code: "repository-remote-invalid",
      reason: "whitespace",
    });
    assert.equal(preflights, 0);
    assert.equal(updates, 0);
  });
});

test("PATCH repo uses the standard not-found refusal before dependency preflight", async () => {
  await withTokens(async () => {
    const app = createApp({
      repo: { findUnique: async () => null },
    } as unknown as PrismaClient, {
      repositoryPreflight: async () => { throw new Error("must not preflight a missing Repo"); },
    });
    const response = await app.request("/repos/missing", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ dependencyProvisioning: "NONE" }),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Resource not found" });
  });
});

test("PATCH repo refuses a preflight failure before writing", async () => {
  await withTokens(async () => {
    let updates = 0;
    const database = {
      repo: {
        findUnique: async () => ({ remoteUrl: "https://github.com/owner/repo.git", defaultBranch: "main" }),
        update: async () => {
          updates += 1;
          throw new Error("preflight refusal must prevent update");
        },
      },
    } as unknown as PrismaClient;
    const app = createApp(database, {
      repositoryPreflight: async () => { throw new RepositoryPreflightError("remote-unreachable"); },
    });
    const response = await app.request("/repos/repo-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ dependencyProvisioning: "NPM_CI" }),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: "Repository preflight failed",
      code: "repository-preflight-failed",
      reason: "remote-unreachable",
    });
    assert.equal(updates, 0);
  });
});

test("POST repo preflights the exact remote and defaulted branch before its transaction", async () => {
  await withTokens(async () => {
    const preflightInputs: Array<{ remoteUrl: string; defaultBranch: string; dependencyProvisioning: "NONE" | "NPM_CI" }> = [];
    let transactions = 0;
    const database = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => {
        transactions += 1;
        return operation({
          repo: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "repo-1", ...data }) },
        });
      },
    } as unknown as PrismaClient;
    const app = createApp(database, {
      repositoryPreflight: async (input) => { preflightInputs.push(input); },
    });
    const request = (remoteUrl: string, defaultBranch?: string) => app.request("/projects/project-1/repos", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: `app-${preflightInputs.length}`, remoteUrl, dependencyProvisioning: "NONE", ...(defaultBranch === undefined ? {} : { defaultBranch }) }),
    });
    for (const [remoteUrl, defaultBranch] of [
      ["https://github.com/owner/repo.git", "main"],
      ["git@github.com:owner/repo.git", "release/v1"],
      ["file:///path/to/repo.git", "main"],
    ] as const) {
      const response = await request(remoteUrl, defaultBranch);
      assert.equal(response.status, 201);
      const repo = await response.json() as Record<string, unknown>;
      assert.equal(repo.remoteUrl, remoteUrl);
      assert.equal(repo.defaultBranch, defaultBranch);
      assert.equal(repo.dependencyProvisioning, "NONE");
      assert.equal("grantAgents" in repo, false);
    }
    const defaulted = await request("https://github.com/owner/other.git");
    assert.equal(defaulted.status, 201);
    assert.deepEqual(preflightInputs, [
      { remoteUrl: "https://github.com/owner/repo.git", defaultBranch: "main", dependencyProvisioning: "NONE" },
      { remoteUrl: "git@github.com:owner/repo.git", defaultBranch: "release/v1", dependencyProvisioning: "NONE" },
      { remoteUrl: "file:///path/to/repo.git", defaultBranch: "main", dependencyProvisioning: "NONE" },
      { remoteUrl: "https://github.com/owner/other.git", defaultBranch: "main", dependencyProvisioning: "NONE" },
    ]);
    assert.equal(transactions, 4);
  });
});

test("POST repo refuses an unavailable credential Secret before preflight", async () => {
  await withTokens(async () => {
    let preflightCalls = 0;
    const database = {
      secret: { findFirst: async () => null },
    } as unknown as PrismaClient;
    const app = createApp(database, {
      repositoryPreflight: async () => { preflightCalls += 1; },
    });
    const response = await app.request("/projects/project-1/repos", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "app",
        remoteUrl: "https://github.com/owner/repo.git",
        credentialSecretId: "secret-1",
        dependencyProvisioning: "NONE",
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Repo credential secret is unavailable" });
    assert.equal(preflightCalls, 0);
  });
});

test("POST repo maps every preflight failure to the exact refusal and writes nothing", async () => {
  await withTokens(async () => {
    let transactions = 0;
    const database = {
      $transaction: async () => { transactions += 1; throw new Error("transaction should not open"); },
    } as unknown as PrismaClient;
    for (const reason of [
      "git-unavailable",
      "git-identity-missing",
      "remote-unreachable",
      "default-branch-missing",
      "push-not-authorized",
      "command-timeout",
    ] as const) {
      const app = createApp(database, {
        repositoryPreflight: async () => { throw new RepositoryPreflightError(reason); },
      });
      const response = await app.request("/projects/project-1/repos", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: `app-${reason}`, remoteUrl: "https://github.com/owner/repo.git", defaultBranch: "main", dependencyProvisioning: "NONE" }),
      });
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), {
        error: "Repository preflight failed",
        code: "repository-preflight-failed",
        reason,
      });
    }
    assert.equal(transactions, 0);
  });
});

test("POST repo maps a missing NPM_CI lockfile to the exact remedy and writes nothing", async () => {
  await withTokens(async () => {
    let transactions = 0;
    const database = {
      $transaction: async () => { transactions += 1; throw new Error("transaction should not open"); },
    } as unknown as PrismaClient;
    const app = createApp(database, {
      repositoryPreflight: async () => { throw new RepositoryPreflightError("package-lock-missing"); },
    });
    const response = await app.request("/projects/project-1/repos", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "app", remoteUrl: "https://github.com/owner/repo.git", defaultBranch: "main",
        dependencyProvisioning: "NPM_CI",
      }),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: "Repository preflight failed",
      code: "repository-package-lock-missing",
      remedy: "Commit package-lock.json at the repository root on the default branch, or choose dependencyProvisioning NONE.",
    });
    assert.equal(transactions, 0);
  });
});

test("POST repo runs successful dependency-policy preflights through to creation", async () => {
  await withTokens(async () => {
    const remoteUrl = "https://github.com/owner/repo.git";
    for (const dependencyProvisioning of ["NONE", "NPM_CI"] as const) {
      const calls: Array<{ args: string[]; cwd: string }> = [];
      const run: RepositoryPreflightCommand = async (_executable, args, cwd) => {
        calls.push({ args, cwd });
        if (args[0] === "config") return { code: 0, stdout: "configured\n" };
        if (args[0] === "ls-remote") return { code: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n` };
        if (args[0] === "ls-tree") {
          return {
            code: 0,
            stdout: dependencyProvisioning === "NPM_CI"
              ? `100644 blob ${"b".repeat(40)}\tpackage-lock.json\0`
              : "",
          };
        }
        return { code: 0, stdout: "" };
      };
      const created: Array<Record<string, unknown>> = [];
      const database = {
        $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
          repo: { create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: `repo-${dependencyProvisioning}`, ...data };
            created.push(row);
            return row;
          } },
        }),
      } as unknown as PrismaClient;
      const app = createApp(database, {
        repositoryPreflight: (input) => preflightRepository(input, run),
      });

      const response = await app.request("/projects/project-1/repos", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: `app-${dependencyProvisioning}`, remoteUrl, dependencyProvisioning }),
      });

      assert.equal(response.status, 201);
      assert.equal((await response.json() as Record<string, unknown>).dependencyProvisioning, dependencyProvisioning);
      assert.equal(created[0]?.dependencyProvisioning, dependencyProvisioning);
      assert.deepEqual(calls.map(({ args }) => args[0]), dependencyProvisioning === "NPM_CI"
        ? ["config", "config", "ls-remote", "init", "fetch", "ls-tree", "push"]
        : ["config", "config", "ls-remote", "init", "fetch", "ls-tree", "push"]);
      assert.equal(calls.filter(({ args }) => args[0] === "fetch").length, 1);
      const lockfileProbes = calls.filter(({ args }) => args[0] === "ls-tree");
      assert.equal(lockfileProbes.length, 1);
      assert.notEqual(lockfileProbes[0]?.cwd, process.cwd(), "ls-tree must inspect the fetched scratch repository");
      const pushes = calls.filter(({ args }) => args[0] === "push");
      assert.equal(pushes.length, 1);
      assert.deepEqual(pushes[0]?.args.slice(0, 3), ["push", "--dry-run", remoteUrl]);
    }
  });
});

test("POST repo optionally grants every active non-integrator Agent atomically", async () => {
  await withTokens(async () => {
    const agents = [
      { id: "agent-1", name: "senior-dev-astra-medium", archivedAt: null },
      { id: "agent-2", name: "code-reviewer-sol-high", archivedAt: null },
      { id: "agent-3", name: "archived", archivedAt: new Date() },
      { id: "agent-4", name: "merge-integrator", archivedAt: null },
    ];
    const createdGrants: Array<Record<string, unknown>> = [];
    let transactionCalls = 0;
    let agentQueries = 0;
    const database = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => {
        transactionCalls += 1;
        return operation({
          repo: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "repo-1", ...data }) },
          agent: { findMany: async ({ where }: { where: Record<string, unknown> }) => {
            agentQueries += 1;
            assert.deepEqual(where, { projectId: "project-1", archivedAt: null, name: { not: "merge-integrator" } });
            return agents.filter((agent) => agent.archivedAt === null && agent.name !== "merge-integrator");
          } },
          agentRepoAccess: { create: async ({ data }: { data: Record<string, unknown> }) => {
            createdGrants.push(data);
            return data;
          } },
        });
      },
    } as unknown as PrismaClient;
    const app = createApp(database, { repositoryPreflight: async () => {} });
    const response = await app.request("/projects/project-1/repos", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "app",
        remoteUrl: "https://github.com/owner/repo.git",
        mountPath: "custom-repo",
        dependencyProvisioning: "NONE",
        grantAgents: true,
      }),
    });
    assert.equal(response.status, 201);
    const payload = await response.json() as { repo: Record<string, unknown>; grants: Array<Record<string, unknown>> };
    assert.equal(payload.repo.mountPath, "custom-repo");
    assert.equal(payload.repo.dependencyProvisioning, "NONE");
    assert.deepEqual(payload.grants, createdGrants);
    assert.deepEqual(payload.grants.map(({ agentId, permissions, mountPath }) => ({ agentId, permissions, mountPath })), [
      { agentId: "agent-1", permissions: "GIT_WRITE", mountPath: "custom-repo" },
      { agentId: "agent-2", permissions: "GIT_WRITE", mountPath: "custom-repo" },
    ]);
    assert.equal(transactionCalls, 1);
    assert.equal(agentQueries, 1);
  });
});

test("POST repo without grantAgents retains a bare Repo response and creates no grants", async () => {
  await withTokens(async () => {
    let agentQueries = 0;
    const database = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
        repo: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "repo-1", ...data }) },
        agent: { findMany: async () => { agentQueries += 1; return []; } },
        agentRepoAccess: { create: async () => { throw new Error("grant should not be written"); } },
      }),
    } as unknown as PrismaClient;
    const app = createApp(database, { repositoryPreflight: async () => {} });
    for (const grantAgents of [undefined, false]) {
      const response = await app.request("/projects/project-1/repos", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: `app-${String(grantAgents)}`, remoteUrl: "https://github.com/owner/repo.git", dependencyProvisioning: "NONE", ...(grantAgents === undefined ? {} : { grantAgents }) }),
      });
      assert.equal(response.status, 201);
      const repo = await response.json() as Record<string, unknown>;
      assert.equal(repo.id, "repo-1");
      assert.equal(repo.dependencyProvisioning, "NONE");
      assert.equal("repo" in repo, false);
      assert.equal("grants" in repo, false);
    }
    assert.equal(agentQueries, 0);
  });
});

test("POST repo preserves the duplicate-name refusal and PATCH keeps its trim behavior", async () => {
  await withTokens(async () => {
    let preflightCalls = 0;
    const database = {
      $transaction: async () => {
        throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6.19.0" });
      },
      repo: {
        update: async ({ data }: { data: Record<string, unknown> }) => ({ id: "repo-1", ...data }),
      },
    } as unknown as PrismaClient;
    const app = createApp(database, { repositoryPreflight: async () => { preflightCalls += 1; } });
    const duplicate = await app.request("/projects/project-1/repos", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "app", remoteUrl: "https://github.com/owner/repo.git", dependencyProvisioning: "NONE" }),
    });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: "Unique constraint violated" });

    const patched = await app.request("/repos/repo-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ remoteUrl: "  https://github.com/owner/repo.git  " }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json() as { remoteUrl: string }).remoteUrl, "https://github.com/owner/repo.git");
    assert.equal(preflightCalls, 1, "PATCH must not invoke the POST preflight operation");
  });
});
