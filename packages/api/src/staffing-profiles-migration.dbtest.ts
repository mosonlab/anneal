import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@anneal/db";

import { testDatabaseUrl } from "./testdb.js";

const targetMigration = "20260905120000_staffing_profiles";
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

test("the staffing-profiles migration backfills one default profile per template and retires the project switch", async () => {
  const base = new URL(testDatabaseUrl);
  const sourceSchema = base.searchParams.get("schema");
  assert.ok(sourceSchema && sourceSchema !== "public", "the test URL must use a dedicated schema");
  const schema = `staffing_profiles_upgrade_${process.pid}_${Date.now().toString(36)}`;
  base.searchParams.set("schema", schema);
  const url = base.toString();
  const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
  const staging = mkdtempSync(join(tmpdir(), "agentos-staffing-profiles-migration."));
  const stagedPrisma = join(staging, "prisma");
  const db = new PrismaClient({ datasources: { db: { url } } });

  try {
    execute(url, `DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE; CREATE SCHEMA ${quotedSchema};`);
    cpSync(join(dbDirectory, "prisma"), stagedPrisma, { recursive: true });
    const stagedMigrations = join(stagedPrisma, "migrations");
    for (const migration of readdirSync(stagedMigrations, { withFileTypes: true })) {
      if (migration.isDirectory() && migration.name >= targetMigration) {
        rmSync(join(stagedMigrations, migration.name), { recursive: true, force: true });
      }
    }
    // Deploy the real migration history immediately before this feature, so
    // the rows below are written exactly as an upgrading installation holds
    // them — including the `skipOptionalSteps` column this migration drops.
    deploy(url, join(stagedPrisma, "schema.prisma"));

    execute(url, `
      INSERT INTO "Project" ("id", "name", "slug", "skipOptionalSteps", "updatedAt")
      VALUES
        ('project-staffing-keep', 'Keeps optional steps', 'staffing-keep', false, NOW()),
        ('project-staffing-skip', 'Skips optional steps', 'staffing-skip', true, NOW());
      INSERT INTO "Environment" ("id", "projectId", "name", "allowedHosts", "updatedAt")
      VALUES
        ('environment-staffing-keep', 'project-staffing-keep', 'local', '{}', NOW()),
        ('environment-staffing-skip', 'project-staffing-skip', 'local', '{}', NOW());
      INSERT INTO "Agent" ("id", "projectId", "environmentId", "name", "title", "model", "foundationalPrompt", "rolePrompt", "updatedAt")
      VALUES
        ('agent-staffing-implementer', 'project-staffing-keep', 'environment-staffing-keep', 'senior-dev-astra-medium', 'Senior Dev', 'gpt-5.6-astra:medium', 'foundation', 'role', NOW()),
        ('agent-staffing-reviewer', 'project-staffing-keep', 'environment-staffing-keep', 'code-reviewer-sol-high', 'Code Reviewer', 'gpt-5.6-sol:high', 'foundation', 'role', NOW()),
        ('agent-staffing-skipper', 'project-staffing-skip', 'environment-staffing-skip', 'senior-dev-astra-medium', 'Senior Dev', 'gpt-5.6-astra:medium', 'foundation', 'role', NOW());
      INSERT INTO "TaskTemplate" ("id", "projectId", "name", "description", "variables", "updatedAt")
      VALUES
        ('template-staffing-keep', 'project-staffing-keep', 'keep-workflow', 'migration test', '{}', NOW()),
        ('template-staffing-skip', 'project-staffing-skip', 'skip-workflow', 'migration test', '{}', NOW());
      INSERT INTO "TaskTemplateStep" ("id", "taskTemplateId", "assigneeAgentId", "stepIndex", "name", "assigneeType", "prompt", "outputKind", "optional", "layer")
      VALUES
        ('step-keep-implementation', 'template-staffing-keep', 'agent-staffing-implementer', 1, 'Implementation', 'agent'::"AssigneeType", 'do it', 'implementation', false, 1),
        ('step-keep-blind', 'template-staffing-keep', 'agent-staffing-reviewer', 2, 'Blind review', 'agent'::"AssigneeType", 'review it', 'blind-findings', true, 2),
        ('step-keep-human', 'template-staffing-keep', NULL, 3, 'Handoff', 'human'::"AssigneeType", 'hand it over', 'handoff', false, 3),
        ('step-skip-implementation', 'template-staffing-skip', 'agent-staffing-skipper', 1, 'Implementation', 'agent'::"AssigneeType", 'do it', 'implementation', false, 1),
        ('step-skip-blind', 'template-staffing-skip', 'agent-staffing-skipper', 2, 'Blind review', 'agent'::"AssigneeType", 'review it', 'blind-findings', true, 2);
      INSERT INTO "Task" ("id", "projectId", "templateId", "templateStepId", "assigneeAgentId", "name", "description", "status", "approvalGate", "chainId", "chainIndex", "chainLayer", "updatedAt")
      VALUES
        ('task-staffing-first', 'project-staffing-keep', 'template-staffing-keep', 'step-keep-implementation', 'agent-staffing-implementer', 'First', 'migration test', 'done'::"TaskStatus", false, 'chain-staffing', 1, 1, NOW()),
        ('task-staffing-second', 'project-staffing-keep', 'template-staffing-keep', 'step-keep-blind', 'agent-staffing-reviewer', 'Second', 'migration test', 'todo'::"TaskStatus", true, 'chain-staffing', 2, 2, NOW());
    `);

    const readTasks = async (): Promise<unknown[]> => db.$queryRawUnsafe(
      `SELECT row_to_json(task) AS row FROM "Task" AS task ORDER BY "id"`,
    );
    const beforeTasks = await readTasks();

    cpSync(join(dbDirectory, "prisma", "migrations", targetMigration), join(stagedMigrations, targetMigration), { recursive: true });
    deploy(url, join(stagedPrisma, "schema.prisma"));

    const profiles = await db.staffingProfile.findMany({
      orderBy: { taskTemplateId: "asc" },
      include: { entries: { orderBy: { outputKind: "asc" } } },
    });
    assert.deepEqual(
      profiles.map(({ id, projectId, taskTemplateId, name, isDefault }) => ({
        id, projectId, taskTemplateId, name, isDefault,
      })),
      [
        {
          id: "staffing_template-staffing-keep",
          projectId: "project-staffing-keep",
          taskTemplateId: "template-staffing-keep",
          name: "Default",
          isDefault: true,
        },
        {
          id: "staffing_template-staffing-skip",
          projectId: "project-staffing-skip",
          taskTemplateId: "template-staffing-skip",
          name: "Default",
          isDefault: true,
        },
      ],
    );

    // Entries key on the exact output kind, carry each step's own assignee,
    // and leave `include` null on every step the template does not mark
    // optional. The project that skipped optional steps keeps skipping them.
    assert.deepEqual(
      profiles[0]!.entries.map(({ outputKind, assigneeAgentId, include }) => ({ outputKind, assigneeAgentId, include })),
      [
        { outputKind: "blind-findings", assigneeAgentId: "agent-staffing-reviewer", include: true },
        { outputKind: "handoff", assigneeAgentId: null, include: null },
        { outputKind: "implementation", assigneeAgentId: "agent-staffing-implementer", include: null },
      ],
    );
    assert.deepEqual(
      profiles[1]!.entries.map(({ outputKind, assigneeAgentId, include }) => ({ outputKind, assigneeAgentId, include })),
      [
        { outputKind: "blind-findings", assigneeAgentId: "agent-staffing-skipper", include: false },
        { outputKind: "implementation", assigneeAgentId: "agent-staffing-skipper", include: null },
      ],
    );

    const remainingColumns = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = '${schema}' AND table_name = 'Project' AND column_name = 'skipOptionalSteps'`,
    );
    assert.deepEqual(remainingColumns, [], "the retired project switch must be dropped");

    assert.deepEqual(await readTasks(), beforeTasks, "pre-existing Task rows must be untouched");
  } finally {
    await db.$disconnect();
    try { execute(url, `DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE;`); } catch { /* best-effort scratch cleanup */ }
    rmSync(staging, { recursive: true, force: true });
  }
});
