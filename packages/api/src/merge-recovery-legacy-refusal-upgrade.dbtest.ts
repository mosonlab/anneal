import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type MergeRecoveryAttempt,
  PrismaClient,
} from "@anneal/db";

import {
  dbDirectory,
  migrationHarnessEnabled,
  migrationQuery,
} from "./chain-layer-migration-fixture.js";
import { recoveryIsReopenableLegacyRefusal } from "./merge-tail-state.js";
import { splitSqlStatements } from "./sql-statements.js";
import { testDatabaseUrl } from "./testdb.js";

const legacyRefusalCodeMigration = "20260830090000_merge_recovery_legacy_refusal_code";
const legacyRefusalBackfillMigration = "20260830100000_merge_recovery_legacy_refusal_backfill";

interface LegacyRefusalMigrationFixture {
  url: string;
  execute(sql: string): Promise<void>;
  applyMigrations(): void;
  applyRemainingMigrations(): void;
  cleanup(): Promise<void>;
}

const stageBeforeLegacyRefusalMigrations = async (): Promise<LegacyRefusalMigrationFixture> => {
  const base = new URL(testDatabaseUrl);
  const sourceSchema = base.searchParams.get("schema");
  if (!sourceSchema || sourceSchema === "public") {
    throw new Error("legacy-refusal migration fixture refuses public schema");
  }
  const schema = `agentos_legacy_refusal_${process.pid}_${Date.now().toString(36)}`;
  base.searchParams.set("schema", schema);
  const url = base.toString();
  const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
  const client = new PrismaClient({ datasources: { db: { url } } });
  const execute = async (sql: string): Promise<void> => {
    for (const statement of splitSqlStatements(sql)) await client.$executeRawUnsafe(statement);
  };

  await execute(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE; CREATE SCHEMA ${quotedSchema};`);
  const staging = mkdtempSync(join(tmpdir(), "legacy-refusal-migration-fixture."));
  cpSync(join(dbDirectory, "prisma"), join(staging, "prisma"), { recursive: true });
  for (const entry of readdirSync(join(staging, "prisma", "migrations"), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name >= legacyRefusalCodeMigration) {
      rmSync(join(staging, "prisma", "migrations", entry.name), { recursive: true, force: true });
    }
  }

  const deploy = (): void => {
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", join(staging, "prisma", "schema.prisma")], {
      cwd: dbDirectory,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  deploy();

  return {
    url,
    execute,
    applyMigrations: () => {
      for (const migration of [legacyRefusalCodeMigration, legacyRefusalBackfillMigration]) {
        cpSync(
          join(dbDirectory, "prisma", "migrations", migration),
          join(staging, "prisma", "migrations", migration),
          { recursive: true },
        );
      }
      deploy();
    },
    // The staged schema stops at the backfill, so it is only readable through
    // raw SQL that names its own columns. The generated Prisma client selects
    // every column the current schema declares, including the ones later
    // migrations add to "MergeRecoveryAttempt", so a typed read needs the whole
    // committed history. Restore it once the boundary assertions are done.
    applyRemainingMigrations: () => {
      cpSync(
        join(dbDirectory, "prisma", "migrations"),
        join(staging, "prisma", "migrations"),
        { recursive: true },
      );
      deploy();
    },
    cleanup: async (): Promise<void> => {
      rmSync(staging, { recursive: true, force: true });
      try {
        await execute(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE;`);
      } finally {
        await client.$disconnect();
      }
    },
  };
};

test("legacy refusal upgrade backfills only the two exact historical refusal shapes", {
  skip: !migrationHarnessEnabled,
}, async () => {
  const fixture = await stageBeforeLegacyRefusalMigrations();
  try {
    await fixture.execute(`
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
      VALUES ('legacy-refusal-project', 'legacy-refusal-project', 'legacy-refusal-project', NOW());
      INSERT INTO "Task" ("id", "projectId", "name", "description", "updatedAt")
      VALUES ('legacy-refusal-integrator', 'legacy-refusal-project', 'integrator', 'integrator', NOW());
      INSERT INTO "MergeRecoveryAttempt" (
        "id", "integratorTaskId", "sourceStopId", "attempt", "status", "failureReason", "refusalCode", "updatedAt"
      ) VALUES
        (
          'already-coded', 'legacy-refusal-integrator', 'stop-coded', 1, 'failed',
          'source executor run does not have exactly one server-bound merge intent',
          'head-adoption-conflict'::"MergeRecoveryRefusalCode", NOW()
        ),
        (
          'pre-intent', 'legacy-refusal-integrator', 'stop-pre-intent', 1, 'failed',
          'source executor run does not have exactly one server-bound merge intent', NULL, NOW()
        ),
        (
          'target-branch', 'legacy-refusal-integrator', 'stop-target-branch', 1, 'failed',
          'authorized target ref differs from the chain target branch', NULL, NOW()
        ),
        (
          'unrelated', 'legacy-refusal-integrator', 'stop-unrelated', 1, 'failed',
          'operator-facing wording that is not a legacy sentinel', NULL, NOW()
        );
    `);

    fixture.applyMigrations();

    assert.deepEqual(
      await migrationQuery<{ id: string; refusalCode: string | null; failureReason: string }>(fixture, `
        SELECT "id", "refusalCode"::text AS "refusalCode", "failureReason"
        FROM "MergeRecoveryAttempt"
        WHERE "id" IN ('already-coded', 'pre-intent', 'target-branch', 'unrelated')
        ORDER BY "id"
      `),
      [
        {
          id: "already-coded",
          refusalCode: "head-adoption-conflict",
          failureReason: "source executor run does not have exactly one server-bound merge intent",
        },
        {
          id: "pre-intent",
          refusalCode: "pre-intent",
          failureReason: "source executor run does not have exactly one server-bound merge intent",
        },
        {
          id: "target-branch",
          refusalCode: "target-branch-mismatch",
          failureReason: "authorized target ref differs from the chain target branch",
        },
        {
          id: "unrelated",
          refusalCode: null,
          failureReason: "operator-facing wording that is not a legacy sentinel",
        },
      ],
    );

    fixture.applyRemainingMigrations();

    const client = new PrismaClient({ datasources: { db: { url: fixture.url } } });
    try {
      const attempts = await client.mergeRecoveryAttempt.findMany({
        where: { id: { in: ["already-coded", "pre-intent", "target-branch", "unrelated"] } },
        orderBy: { id: "asc" },
      });
      assert.deepEqual(
        attempts.map((attempt: MergeRecoveryAttempt) => [
          attempt.id,
          recoveryIsReopenableLegacyRefusal(attempt),
        ]),
        [
          ["already-coded", false],
          ["pre-intent", true],
          ["target-branch", true],
          ["unrelated", false],
        ],
      );
    } finally {
      await client.$disconnect();
    }
  } finally {
    await fixture.cleanup();
  }
});
