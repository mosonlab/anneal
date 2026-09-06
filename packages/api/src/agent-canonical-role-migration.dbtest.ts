/**
 * The canonical-role upgrade against real migration history.
 *
 * The release renames every canonical Agent in place — `senior-dev` becomes
 * `senior-dev-astra-medium` — so the one thing this has to prove is that nothing
 * moved but the two name columns: ids are preserved, and every Task, Session and
 * template step still points at the same row. Backfill is checked in the same
 * pass because the two are one statement's worth of SQL apart: an inventory row
 * gains its `canonicalRole`, an operator's own Agent does not, and the single
 * `runtimeConfigCustomized` flag becomes the per-field list.
 *
 * Modelled on optional-steps-migration.dbtest.ts: real history is deployed up to
 * this migration, rows are written through raw SQL under the old shape, and only
 * then is the migration applied.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@anneal/db";

import { testDatabaseUrl } from "./testdb.js";

const migrationUnderTest = "20260905120000_staffing_profiles";
const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));

const execute = (url: string, sql: string): void => {
  execFileSync("npx", ["prisma", "db", "execute", "--url", url, "--stdin"], {
    cwd: dbDirectory,
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  });
};

const deploy = (url: string, schemaPath: string): void => {
  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", schemaPath], {
    cwd: dbDirectory,
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["ignore", "pipe", "pipe"],
  });
};

/** A scratch schema carrying migration history up to, but excluding, the target. */
const stageHistory = (label: string): { url: string; schema: string; staging: string; stagedPrisma: string } => {
  const base = new URL(testDatabaseUrl);
  const sourceSchema = base.searchParams.get("schema");
  assert.ok(sourceSchema && sourceSchema !== "public", "the test URL must use a dedicated schema");
  const schema = `${label}_${process.pid}_${Date.now().toString(36)}`;
  base.searchParams.set("schema", schema);
  const url = base.toString();
  const staging = mkdtempSync(join(tmpdir(), `agentos-${label}.`));
  const stagedPrisma = join(staging, "prisma");
  execute(url, `DROP SCHEMA IF EXISTS "${schema}" CASCADE; CREATE SCHEMA "${schema}";`);
  cpSync(join(dbDirectory, "prisma"), stagedPrisma, { recursive: true });
  const stagedMigrations = join(stagedPrisma, "migrations");
  for (const migration of readdirSync(stagedMigrations, { withFileTypes: true })) {
    if (migration.isDirectory() && migration.name >= migrationUnderTest) {
      rmSync(join(stagedMigrations, migration.name), { recursive: true, force: true });
    }
  }
  deploy(url, join(stagedPrisma, "schema.prisma"));
  return { url, schema, staging, stagedPrisma };
};

const applyTarget = (staged: { url: string; stagedPrisma: string }): void => {
  cpSync(
    join(dbDirectory, "prisma", "migrations", migrationUnderTest),
    join(staged.stagedPrisma, "migrations", migrationUnderTest),
    { recursive: true },
  );
  deploy(staged.url, join(staged.stagedPrisma, "schema.prisma"));
};

const cleanUp = (staged: { url: string; schema: string; staging: string }): void => {
  try { execute(staged.url, `DROP SCHEMA IF EXISTS "${staged.schema}" CASCADE;`); } catch { /* best-effort scratch cleanup */ }
  rmSync(staged.staging, { recursive: true, force: true });
};

const projectFixture = (prefix: string): string => `
  INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
  VALUES ('${prefix}-project', 'Canonical role project', '${prefix}-project', NOW());
  INSERT INTO "Environment" ("id", "projectId", "name", "allowedHosts", "updatedAt")
  VALUES ('${prefix}-environment', '${prefix}-project', 'local', '{}', NOW());
`;

const agentFixture = (prefix: string, id: string, name: string, customized: boolean): string => `
  INSERT INTO "Agent" (
    "id", "projectId", "environmentId", "name", "title", "model",
    "runtimeConfigCustomized", "foundationalPrompt", "rolePrompt", "updatedAt"
  ) VALUES (
    '${id}', '${prefix}-project', '${prefix}-environment', '${name}', '${name} title', 'gpt-5.6-sol:high',
    ${customized ? "true" : "false"}, 'foundation', 'role', NOW()
  );
`;

test("the canonical-role migration renames in place, preserves references, and backfills both columns", async () => {
  const prefix = "canonical-role";
  const staged = stageHistory("agent_canonical_role_upgrade");
  const db = new PrismaClient({ datasources: { db: { url: staged.url } } });
  try {
    execute(staged.url, [
      projectFixture(prefix),
      agentFixture(prefix, `${prefix}-senior-dev`, "senior-dev", true),
      agentFixture(prefix, `${prefix}-reviewer`, "review-coordinator-sol", false),
      agentFixture(prefix, `${prefix}-operator`, "our-own-agent", false),
      `
        INSERT INTO "TaskTemplate" ("id", "projectId", "name", "description", "variables", "updatedAt")
        VALUES ('${prefix}-template', '${prefix}-project', 'Template', 'canonical role test', '{}', NOW());
        INSERT INTO "TaskTemplateStep" ("id", "taskTemplateId", "stepIndex", "name", "assigneeType", "assigneeAgentId", "prompt", "layer")
        VALUES ('${prefix}-step', '${prefix}-template', 1, 'Implementation', 'agent'::"AssigneeType", '${prefix}-senior-dev', 'prompt', 1);
        INSERT INTO "Task" ("id", "projectId", "name", "description", "status", "assigneeType", "assigneeAgentId", "templateId", "templateStepId", "updatedAt")
        VALUES ('${prefix}-task', '${prefix}-project', 'Implementation', 'canonical role test', 'todo'::"TaskStatus", 'agent'::"AssigneeType", '${prefix}-senior-dev', '${prefix}-template', '${prefix}-step', NOW());
        INSERT INTO "Run" ("id", "projectId", "agentId", "taskId", "runNumber", "dedupeKey", "runner", "model", "updatedAt")
        VALUES ('${prefix}-run', '${prefix}-project', '${prefix}-senior-dev', '${prefix}-task', 1, '${prefix}-dedupe', 'codex'::"RunnerKind", 'gpt-5.6-sol:high', NOW());
        INSERT INTO "Session" ("id", "runId", "projectId", "agentId", "taskId", "runner")
        VALUES ('${prefix}-session', '${prefix}-run', '${prefix}-project', '${prefix}-senior-dev', '${prefix}-task', 'codex'::"RunnerKind");
      `,
    ].join("\n"));

    const taskBefore = await db.task.findUniqueOrThrow({ where: { id: `${prefix}-task` } });
    // Read the historical row without asking the current client for later columns.
    const runBefore = await db.$queryRaw`SELECT * FROM "Run" WHERE "id" = ${`${prefix}-run`}`;
    const sessionBefore = await db.session.findUniqueOrThrow({ where: { id: `${prefix}-session` } });

    applyTarget(staged);

    const renamed = await db.agent.findUniqueOrThrow({ where: { id: `${prefix}-senior-dev` } });
    assert.deepEqual(
      { name: renamed.name, canonicalRole: renamed.canonicalRole, customizedFields: renamed.customizedFields },
      {
        name: "senior-dev-astra-medium",
        canonicalRole: "senior-dev-astra-medium",
        customizedFields: ["model", "runnerPreference"],
      },
    );
    const reviewer = await db.agent.findUniqueOrThrow({ where: { id: `${prefix}-reviewer` } });
    assert.deepEqual(
      { name: reviewer.name, canonicalRole: reviewer.canonicalRole, customizedFields: reviewer.customizedFields },
      { name: "code-reviewer-sol-high", canonicalRole: "code-reviewer-sol-high", customizedFields: [] },
    );
    // An Agent nobody installed from `agents/` stays exactly as the operator made it.
    const operator = await db.agent.findUniqueOrThrow({ where: { id: `${prefix}-operator` } });
    assert.deepEqual(
      { name: operator.name, canonicalRole: operator.canonicalRole, customizedFields: operator.customizedFields },
      { name: "our-own-agent", canonicalRole: null, customizedFields: [] },
    );

    assert.deepEqual(await db.task.findUniqueOrThrow({ where: { id: `${prefix}-task` } }), taskBefore);
    assert.deepEqual(await db.$queryRaw`SELECT * FROM "Run" WHERE "id" = ${`${prefix}-run`}`, runBefore);
    assert.deepEqual(await db.session.findUniqueOrThrow({ where: { id: `${prefix}-session` } }), sessionBefore);
    assert.equal(
      (await db.taskTemplateStep.findUniqueOrThrow({ where: { id: `${prefix}-step` } })).assigneeAgentId,
      `${prefix}-senior-dev`,
    );
  } finally {
    await db.$disconnect();
    cleanUp(staged);
  }
});

test("the canonical-role migration refuses a project whose new slug is already taken", async () => {
  const prefix = "slug-collision";
  const staged = stageHistory("agent_canonical_role_collision");
  const db = new PrismaClient({ datasources: { db: { url: staged.url } } });
  try {
    execute(staged.url, [
      projectFixture(prefix),
      agentFixture(prefix, `${prefix}-senior-dev`, "senior-dev", false),
      // The operator already used the slug the rename wants. Skipping the rename
      // would leave `canonicalRole` naming a role file this row is not named
      // after, so the upgrade stops instead.
      agentFixture(prefix, `${prefix}-taken`, "senior-dev-astra-medium", false),
    ].join("\n"));

    assert.throws(() => applyTarget(staged), (error: unknown) => {
      const output = `${(error as { stdout?: Buffer }).stdout ?? ""}${(error as { stderr?: Buffer }).stderr ?? ""}`;
      assert.match(output, /senior-dev-astra-medium is already taken/u);
      return true;
    });
    const untouched = await db.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT "name" FROM "Agent" WHERE "id" = '${prefix}-senior-dev'`,
    );
    assert.deepEqual(untouched, [{ name: "senior-dev" }]);
  } finally {
    await db.$disconnect();
    cleanUp(staged);
  }
});
