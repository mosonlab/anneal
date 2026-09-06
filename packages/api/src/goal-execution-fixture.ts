import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@anneal/db";

import { splitSqlStatements } from "./sql-statements.js";
import { testDatabaseUrl } from "./testdb.js";

/**
 * A disposable database staged at the migration *before* the Goal 5a0 kernel.
 *
 * The preflight tests need a schema holding pre-kernel rows because the
 * preflight runs before the kernel migration. The dedicated test schema is
 * already fully migrated, so it cannot be used here.
 */

const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));
const kernelMigration = "20260818000000_goal_execution_safety_kernel";

interface PreKernelDatabase {
  url: string;
  schema: string;
  quoted: string;
  /** Runs SQL against the staged schema, over the fixture's own connection. */
  execute: (sql: string) => Promise<void>;
  /** Applies the kernel migration through the real `prisma migrate deploy`. */
  applyKernelMigration: () => void;
  cleanup: () => Promise<void>;
}

const stageAtPreviousMigration = async (label: string): Promise<PreKernelDatabase> => {
  const base = new URL(testDatabaseUrl);
  const schema = `${base.searchParams.get("schema") ?? "public"}_${label}`;
  if (schema.startsWith("public")) throw new Error("the pre-kernel fixture refuses to touch the public schema");
  base.searchParams.set("schema", schema);
  const url = base.toString();
  const quoted = `"${schema.replaceAll('"', '""')}"`;

  // One connection for the fixture's lifetime. `prisma db execute` accepts a
  // multi-statement block, which is why it was used, but it also pays about two
  // seconds of npx and engine startup per call and this fixture stages once per
  // case. The block is cut here instead — see `splitSqlStatements`.
  const client = new PrismaClient({ datasources: { db: { url } } });
  const execute = async (sql: string): Promise<void> => {
    for (const statement of splitSqlStatements(sql)) await client.$executeRawUnsafe(statement);
  };

  await execute(`DROP SCHEMA IF EXISTS ${quoted} CASCADE; CREATE SCHEMA ${quoted};`);
  const staging = mkdtempSync(join(tmpdir(), "goal5a0-fixture."));
  cpSync(join(dbDirectory, "prisma"), join(staging, "prisma"), { recursive: true });
  // This fixture is staged *before* the kernel. Remove the kernel and every
  // later migration, not just the named kernel directory: later migrations may
  // depend on constraints the pre-kernel schema intentionally does not have.
  for (const entry of readdirSync(join(staging, "prisma", "migrations"), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name >= kernelMigration) {
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
    schema,
    quoted,
    execute,
    applyKernelMigration: () => {
      cpSync(
        join(dbDirectory, "prisma", "migrations", kernelMigration),
        join(staging, "prisma", "migrations", kernelMigration),
        { recursive: true },
      );
      deploy();
    },
    cleanup: async (): Promise<void> => {
      rmSync(staging, { recursive: true, force: true });
      try {
        await execute(`DROP SCHEMA IF EXISTS ${quoted} CASCADE;`);
      } catch {
        // A test schema that will not drop must not fail the suite.
      } finally {
        await client.$disconnect();
      }
    },
  };
};

/** Pre-kernel history: a Task carried no Goal link, only its Runs did. */
const preKernelSeed = `
  INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
  VALUES ('p-up', 'upgrade', 'upgrade', NOW());
  INSERT INTO "Environment" ("id", "projectId", "name", "updatedAt")
  VALUES ('e-up', 'p-up', 'env', NOW());
  INSERT INTO "Agent" ("id", "projectId", "environmentId", "name", "title", "model",
                       "foundationalPrompt", "rolePrompt", "updatedAt")
  VALUES ('a-up', 'p-up', 'e-up', 'agent', 'Agent', 'claude', '', '', NOW());
  INSERT INTO "Goal" ("id", "projectId", "title", "spec", "updatedAt")
  VALUES ('g-up', 'p-up', 'Goal', 'a secret-looking spec string', NOW());
  INSERT INTO "Task" ("id", "projectId", "name", "description", "status", "createdAt", "updatedAt")
  VALUES ('t-old', 'p-up', 'first', 'a secret-looking description', 'done', '2026-08-01T00:00:00Z', NOW()),
         ('t-new', 'p-up', 'second', 'desc', 'done', '2026-08-02T00:00:00Z', NOW());
`;

export interface PreflightResult { code: number; stdout: string; stderr: string }

/**
 * The preflight as the operator runs it, against a database this harness
 * stages for each case.
 *
 * It lives here rather than in one test file because the preflight's cases are
 * split across two of them: every case restages the whole pre-kernel history,
 * which is a `prisma migrate deploy` replay each time, and node:test runs the
 * tests inside one file one after another. Two files run those replays at the
 * same time. `label` is what keeps their schemas apart when the two files
 * happen to share a database.
 */
export const preflightHarness = (label: string): {
  stage: (rows: string[]) => Promise<PreKernelDatabase>;
  runPreflight: (environment?: Record<string, string | undefined>) => PreflightResult;
  cleanup: () => Promise<void>;
} => {
  let fixture: PreKernelDatabase | undefined;
  return {
    stage: async (rows: string[]): Promise<PreKernelDatabase> => {
      await fixture?.cleanup();
      fixture = await stageAtPreviousMigration(label);
      await fixture.execute(preKernelSeed + rows.join("\n"));
      return fixture;
    },
    runPreflight: (environment: Record<string, string | undefined> = {}): PreflightResult => {
      if (!fixture) throw new Error("the preflight harness was run before anything was staged");
      const env = {
        ...process.env,
        DATABASE_URL: fixture.url,
        PATH: `${dbDirectory}/node_modules/.bin:${process.env.PATH ?? ""}`,
        ...environment,
      } as NodeJS.ProcessEnv;
      for (const [key, value] of Object.entries(environment)) if (value === undefined) delete env[key];
      try {
        // Run exactly as `npm run db:preflight-goal-execution` runs it: from the db
        // workspace, not from the repository root, so the script resolves its own
        // dependencies exactly as the wired script does.
        const stdout = execFileSync("npx", ["tsx", "prisma/preflight-goal-execution.ts"], {
          cwd: dbDirectory,
          env,
          encoding: "utf8",
        });
        return { code: 0, stdout, stderr: "" };
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return { code: failure.status ?? -1, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? "") };
      }
    },
    cleanup: async (): Promise<void> => { await fixture?.cleanup(); },
  };
};

export const preKernelRun = (
  id: string, taskId: string | null, goalId: string | null, runNumber: number, status = "succeeded",
): string => `
  INSERT INTO "Run" ("id", "projectId", "taskId", "agentId", "goalId", "runNumber", "dedupeKey",
                     "runner", "model", "promptHash", "status", "updatedAt")
  VALUES ('${id}', 'p-up', ${taskId === null ? "NULL" : `'${taskId}'`}, 'a-up',
          ${goalId === null ? "NULL" : `'${goalId}'`}, ${runNumber}, 'dedupe:${id}',
          'claude', 'claude', 'hash', '${status}', NOW());`;
