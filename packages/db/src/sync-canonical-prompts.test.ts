import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrismaClient } from "@prisma/client";

type SyncModule = {
  main: (database?: PrismaClient, installFullProjectId?: string | null) => Promise<void>;
  parseInstallFullProjectId: (args?: readonly string[]) => string | null;
  synchronizeAgents: (
    tx: unknown,
    project: unknown,
    requireCompleteInventory: boolean,
    sources: unknown,
    rolesByRole: ReadonlyMap<string, unknown>,
    roles: readonly string[],
    counters: Record<string, unknown>,
    runtimeConfigAdoptions: unknown[],
  ) => Promise<void>;
};

// Keep the acceptance test under src/ without pulling the prisma CLI entrypoint
// under src/'s TypeScript rootDir during the library typecheck.
const syncModulePath: string = "../prisma/sync-canonical-prompts.js";
const { main, parseInstallFullProjectId, synchronizeAgents } = await import(syncModulePath) as SyncModule;

const asPrisma = (value: unknown): PrismaClient => value as PrismaClient;

test("--install-full parsing accepts only the exact optional argument pair", () => {
  assert.equal(parseInstallFullProjectId([]), null);
  assert.equal(parseInstallFullProjectId(["--install-full", "project-1"]), "project-1");
  assert.throws(() => parseInstallFullProjectId(["--install-full"]), /requires exactly one Project id/u);
  assert.throws(() => parseInstallFullProjectId(["--install-full", "project-1", "extra"]), /requires exactly one Project id/u);
  assert.throws(() => parseInstallFullProjectId(["extra", "--install-full", "project-1"]), /Unknown argument extra/u);
});

test("an unknown full-install target is refused before a transaction opens", async () => {
  let transactions = 0;
  const database = asPrisma({
    project: { findMany: async () => [] },
    $transaction: async () => {
      transactions += 1;
      throw new Error("transaction-must-not-open");
    },
  });

  await assert.rejects(main(database, "missing-project"), /Project missing-project was not found/u);
  assert.equal(transactions, 0);
});

test("ordinary synchronization opens one 120-second transaction per discovered Project without an isolation override", async () => {
  let transactions = 0;
  let transactionOptions: unknown;
  const transactionClient = {
    project: { findUnique: async () => null },
  };
  const database = asPrisma({
    project: { findMany: async () => [{ id: "canonical-project", slug: "agentos-example" }] },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>, options: unknown) => {
      transactions += 1;
      transactionOptions = options;
      return callback(transactionClient);
    },
  });

  await assert.rejects(main(database, null), /Project agentos-example: Project was not found/u);
  assert.equal(transactions, 1);
  assert.deepEqual(transactionOptions, { timeout: 120_000 });
  assert.equal(Object.hasOwn(transactionOptions as object, "isolationLevel"), false);
});

test("full installation re-reads the target inside the transaction before any mutation", async () => {
  const events: string[] = [];
  const transactionClient = {
    project: {
      findUnique: async () => {
        events.push("tx.project.findUnique");
        return null;
      },
    },
  };
  const database = asPrisma({
    project: {
      findMany: async () => {
        events.push("outer.project.findMany");
        return [{ id: "deleted-project", slug: "agentos-example" }];
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      events.push("transaction");
      return callback(transactionClient);
    },
  });

  await assert.rejects(main(database, "deleted-project"), /Project deleted-project was not found/u);
  assert.deepEqual(events, ["outer.project.findMany", "transaction", "tx.project.findUnique"]);
});

for (const fixture of [
  { name: "zero Environments", environments: [] },
  { name: "multiple Environments", environments: [{ id: "environment-1", name: "one" }, { id: "environment-2", name: "two" }] },
] as const) {
  test(`full installation refuses ${fixture.name} before observing a mutation`, async () => {
    const events: string[] = [];
    const database = asPrisma({
      project: {
        findMany: async () => [{ id: "project-1", slug: "agentos-example" }],
      },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
        project: {
          findUnique: async () => {
            events.push("project-read");
            return { id: "project-1", slug: "agentos-example", environments: fixture.environments };
          },
        },
      }),
    });

    await assert.rejects(main(database, "project-1"), /Project agentos-example: Project has .*Environment/u);
    assert.deepEqual(events, ["project-read"]);
  });
}

test("full installation refuses an archived canonical Agent before observing a mutation", async () => {
  const events: string[] = [];
  const database = asPrisma({
    project: {
      findMany: async () => [{ id: "project-1", slug: "agentos-example" }],
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      project: {
        findUnique: async () => {
          events.push("project-read");
          return {
            id: "project-1",
            slug: "agentos-example",
            environments: [{ id: "environment-1", name: "local" }],
          };
        },
      },
      agent: {
        findFirst: async () => {
          events.push("archived-agent-read");
          return { id: "archived-agent-1", name: "senior-dev-astra-medium" };
        },
      },
    }),
  });

  await assert.rejects(main(database, "project-1"), /Project agentos-example: Agent senior-dev-astra-medium \(archived-agent-1\) is archived/u);
  assert.deepEqual(events, ["project-read", "archived-agent-read"]);
});

test("synchronizeAgents refuses incompatible runner adoption for customized model and records runtime drift cleanly", async () => {
  const project = { id: "project-1", slug: "agentos-example" };
  const role = {
    canonicalRole: "code-reviewer-sol-high",
    name: "code-reviewer-sol-high",
    title: "Code Reviewer",
    model: "openai-codex/gpt-5.6-sol:high",
    runnerPreference: "PI",
    inboxAccess: false,
    collaborators: [],
    rolePrompt: "canonical role prompt",
  };
  const sources = {
    foundationalPrompt: "canonical foundational prompt",
    roles: [role],
  };
  const agentRow = {
    id: "agent-1",
    projectId: project.id,
    canonicalRole: "code-reviewer-sol-high",
    name: "code-reviewer-astra-medium",
    archivedAt: null,
    title: "Code Reviewer",
    model: "gpt-6-astra:medium",
    customizedFields: ["model", "name"],
    runtimeConfigDriftNoticeFingerprint: "old-fingerprint",
    runnerPreference: "CODEX",
    inboxAccess: false,
    collaborators: [],
    foundationalPrompt: "canonical foundational prompt",
    rolePrompt: "canonical role prompt",
  };

  const updatedRecords: Array<{ where: unknown; data: unknown }> = [];
  const createdMessages: unknown[] = [];

  const tx = {
    agent: {
      findMany: async (args?: { select?: { id: boolean; name: boolean } }) => {
        if (args?.select?.id && args?.select?.name && Object.keys(args.select).length === 2) {
          return [{ id: agentRow.id, name: agentRow.name }];
        }
        return [agentRow];
      },
      updateMany: async (query: { where: unknown; data: unknown }) => {
        updatedRecords.push(query);
        const where = query.where as Record<string, unknown>;
        if (where.OR) return { count: 0 };
        return { count: 1 };
      },
    },
    inboxThread: {
      findFirst: async () => ({ id: "thread-1" }),
    },
    inboxMessage: {
      create: async (query: unknown) => {
        createdMessages.push(query);
        return { id: "msg-1" };
      },
    },
  };

  const counters: Record<string, unknown> = {
    assignedCanonicalRoles: 0,
    adoptedAgentDefaults: 0,
    adoptedAgentIdentity: 0,
    runtimeDriftNotices: 0,
    updatedRoles: { [role.canonicalRole]: 0 },
    updatedSteps: {},
  };
  const adoptions: unknown[] = [];

  const rolesByRole = new Map([[role.canonicalRole, role]]);
  await synchronizeAgents(
    tx,
    project,
    true,
    sources,
    rolesByRole,
    [role.canonicalRole],
    counters,
    adoptions,
  );

  assert.equal(adoptions.length, 0);
  assert.equal(counters.adoptedAgentDefaults, 0);
  assert.equal(counters.runtimeDriftNotices, 1);
  const runtimeAdoptionAttempt = updatedRecords.find((record) => {
    const data = record.data as Record<string, unknown>;
    return data.runnerPreference !== undefined || data.model !== undefined;
  });
  assert.equal(runtimeAdoptionAttempt, undefined, "Incompatible runnerPreference must not be adopted onto a customized model");

  const expectedFingerprint = JSON.stringify({
    canonical: { model: role.model, runnerPreference: role.runnerPreference },
    production: { model: agentRow.model, runnerPreference: agentRow.runnerPreference },
  });
  const driftUpdate = updatedRecords.find((record) => {
    const data = record.data as Record<string, unknown>;
    return data.runtimeConfigDriftNoticeFingerprint === expectedFingerprint;
  });
  assert.ok(driftUpdate, "Runtime drift notice fingerprint must be recorded");

  assert.equal(createdMessages.length, 1);
  const msg = createdMessages[0] as { data: { body: string } };
  assert.match(msg.data.body, /Canonical runtime drift detected/u);
  assert.match(msg.data.body, /Canonical: model=openai-codex\/gpt-5\.6-sol:high, runner=PI/u);
  assert.match(msg.data.body, /Production: model=gpt-6-astra:medium, runner=CODEX/u);
});

test("synchronizeAgents adopts compatible uncustomized runtime fields and syncs in-memory state", async () => {
  const project = { id: "project-1", slug: "agentos-example" };
  const role = {
    canonicalRole: "code-reviewer-sol-high",
    name: "code-reviewer-sol-high",
    title: "Code Reviewer",
    model: "openai-codex/gpt-5.6-sol:high",
    runnerPreference: "PI",
    inboxAccess: false,
    collaborators: [],
    rolePrompt: "canonical role prompt",
  };
  const sources = {
    foundationalPrompt: "canonical foundational prompt",
    roles: [role],
  };
  const agentRow = {
    id: "agent-1",
    projectId: project.id,
    canonicalRole: "code-reviewer-sol-high",
    name: "code-reviewer-sol-high",
    archivedAt: null,
    title: "Code Reviewer",
    model: "gpt-5.6-sol:high",
    customizedFields: [],
    runtimeConfigDriftNoticeFingerprint: "stale-drift",
    runnerPreference: "CODEX",
    inboxAccess: false,
    collaborators: [],
    foundationalPrompt: "canonical foundational prompt",
    rolePrompt: "canonical role prompt",
  };

  const updatedRecords: Array<{ where: unknown; data: unknown }> = [];
  const tx = {
    agent: {
      findMany: async (args?: { select?: { id: boolean; name: boolean } }) => {
        if (args?.select?.id && args?.select?.name && Object.keys(args.select).length === 2) {
          return [{ id: agentRow.id, name: agentRow.name }];
        }
        return [agentRow];
      },
      updateMany: async (query: { where: unknown; data: unknown }) => {
        updatedRecords.push(query);
        const where = query.where as Record<string, unknown>;
        if (where.OR) return { count: 0 };
        return { count: 1 };
      },
    },
  };

  const counters: Record<string, unknown> = {
    assignedCanonicalRoles: 0,
    adoptedAgentDefaults: 0,
    adoptedAgentIdentity: 0,
    runtimeDriftNotices: 0,
    updatedRoles: { [role.canonicalRole]: 0 },
    updatedSteps: {},
  };
  const adoptions: unknown[] = [];

  const rolesByRole = new Map([[role.canonicalRole, role]]);
  await synchronizeAgents(
    tx,
    project,
    true,
    sources,
    rolesByRole,
    [role.canonicalRole],
    counters,
    adoptions,
  );

  assert.equal(adoptions.length, 1);
  assert.equal(counters.adoptedAgentDefaults, 1);
  assert.equal(counters.runtimeDriftNotices, 0);

  const adoptionRecord = updatedRecords.find((record) => {
    const data = record.data as Record<string, unknown>;
    return data.runnerPreference === "PI" && data.model === "openai-codex/gpt-5.6-sol:high";
  });
  assert.ok(adoptionRecord, "Both compatible runtime fields must be adopted together");
  const data = adoptionRecord.data as Record<string, unknown>;
  assert.equal(data.runtimeConfigDriftNoticeFingerprint, null, "Fingerprint must be cleared when adopting defaults");
});
