import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@anneal/db";

import { preMigratedEnvironmentVariable } from "./dbtest-plan.js";

// Database tests exercise delivery routing without depending on the host's
// Feishu credentials or destination. Production writers still require the
// real setting through requireDefaultFeishuThread.
process.env.FEISHU_DEFAULT_CHAT_ID ??= "anneal-dbtest-default-chat";

export interface ScratchDatabaseConfig {
  sourceUrl: URL;
  maintenanceUrl: URL;
  schema: string | null;
  redactedServer: string;
}

const databaseName = (url: URL): string => decodeURIComponent(url.pathname.slice(1));
const sameServer = (left: URL, right: URL): boolean => (
  left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port
);

export const validateScratchDatabaseEnvironment = (
  environment: NodeJS.ProcessEnv,
): ScratchDatabaseConfig => {
  if (environment.AGENTOS_ALLOW_SCRATCH_DATABASES !== "1") throw new Error("scratch-database-opt-in-required");
  if (!environment.TEST_DATABASE_URL) throw new Error("scratch-test-database-url-required");
  if (!environment.TEST_DATABASE_MAINTENANCE_URL) throw new Error("scratch-maintenance-url-required");
  const sourceUrl = new URL(environment.TEST_DATABASE_URL);
  const maintenanceUrl = new URL(environment.TEST_DATABASE_MAINTENANCE_URL);
  if (!sourceUrl.protocol.startsWith("postgres") || !maintenanceUrl.protocol.startsWith("postgres")) {
    throw new Error("scratch-database-postgresql-required");
  }
  const sourceName = databaseName(sourceUrl);
  const maintenanceName = databaseName(maintenanceUrl);
  if (!sourceName || !maintenanceName || sourceName === "agentos" || maintenanceName === "agentos") {
    throw new Error("scratch-default-agentos-database-refused");
  }
  if (sourceName === maintenanceName) throw new Error("scratch-source-maintenance-must-differ");
  if (!sameServer(sourceUrl, maintenanceUrl)) throw new Error("scratch-database-server-mismatch");
  if (sourceUrl.username !== maintenanceUrl.username) throw new Error("scratch-database-role-mismatch");
  return {
    sourceUrl,
    maintenanceUrl,
    schema: sourceUrl.searchParams.get("schema"),
    redactedServer: `${sourceUrl.hostname}:${sourceUrl.port || "5432"}/${maintenanceName}`,
  };
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

export interface ConnectionWaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
}

/**
 * Waits for a database to have no backends at all, which is what
 * `CREATE DATABASE ... TEMPLATE` requires of its source.
 *
 * The connection this waits out is usually one that has already been closed:
 * `prisma migrate deploy` exits, and its backend is still in pg_stat_activity
 * for the moment it takes PostgreSQL to reap it. Asking once turns that moment
 * into an intermittent failure of whatever ran next, and the busier the host
 * the likelier it is — so ask again, briefly, and only then refuse. Refusing
 * still means what it meant: something is genuinely using the template.
 */
export const awaitNoConnections = async (
  count: () => Promise<bigint>,
  { timeoutMs = 10_000, intervalMs = 50, now = Date.now, wait = sleep }: ConnectionWaitOptions = {},
): Promise<void> => {
  const deadline = now() + timeoutMs;
  for (;;) {
    if ((await count()) === 0n) return;
    if (now() >= deadline) throw new Error("scratch-template-has-active-connections");
    await wait(intervalMs);
  }
};

const scratchNamePattern = /^agentos_cp_a_[a-z0-9_]{8,48}$/u;

export interface ScratchDatabasePreflight {
  redactedServer: string;
  maintenanceDatabase: string;
  schema: string | null;
  role: string;
  roleCanCreateDatabase: boolean;
}

/**
 * The process that created a scratch database, read back out of its name.
 *
 * `allocateName` puts the creator's pid in there precisely so an abandoned
 * database can be told from one a running process is still using. Returns null
 * for any name this manager did not shape, which is what keeps a sweep from
 * touching a database that merely starts with the same letters.
 */
export const scratchNameOwnerPid = (name: string): number | null => {
  if (!scratchNamePattern.test(name)) return null;
  const parts = name.split("_");
  if (parts.length < 6) return null;
  const pid = Number(parts.at(-2));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means a process with that pid exists and is not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export interface ScratchReclamation {
  reclaimed: string[];
  skipped: string[];
}

export interface DropFailure {
  name: string;
  error: Error;
}

export class ScratchDatabaseManager {
  readonly config: ScratchDatabaseConfig;
  readonly allowedNames = new Set<string>();
  /** Databases that exist because this manager created them, in creation order. */
  readonly live = new Set<string>();
  readonly maintenance: PrismaClient;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.config = validateScratchDatabaseEnvironment(environment);
    this.maintenance = new PrismaClient({ datasources: { db: { url: this.config.maintenanceUrl.toString() } } });
  }

  async preflight(): Promise<ScratchDatabasePreflight> {
    const [maintenanceIdentity] = await this.maintenance.$queryRawUnsafe<Array<{ role: string; rolcreatedb: boolean }>>(
      "SELECT current_user AS role, rolcreatedb FROM pg_roles WHERE rolname = current_user",
    );
    const source = new PrismaClient({ datasources: { db: { url: this.config.sourceUrl.toString() } } });
    try {
      const [sourceIdentity] = await source.$queryRawUnsafe<Array<{ role: string }>>("SELECT current_user AS role");
      if (!maintenanceIdentity || !sourceIdentity || maintenanceIdentity.role !== sourceIdentity.role) {
        throw new Error("scratch-database-effective-role-mismatch");
      }
    } finally {
      await source.$disconnect();
    }
    if (!maintenanceIdentity.rolcreatedb) throw new Error("scratch-database-role-missing-createdb");
    return {
      redactedServer: this.config.redactedServer,
      maintenanceDatabase: databaseName(this.config.maintenanceUrl),
      schema: this.config.schema,
      role: maintenanceIdentity.role,
      roleCanCreateDatabase: maintenanceIdentity.rolcreatedb,
    };
  }

  private allocateName(label: string): string {
    const normalized = label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_").slice(0, 12);
    const name = `agentos_cp_a_${normalized}_${process.pid}_${randomBytes(6).toString("hex")}`;
    if (!scratchNamePattern.test(name)) throw new Error("scratch-database-generated-name-invalid");
    if (this.allowedNames.has(name)) throw new Error("scratch-database-generated-name-collision");
    this.allowedNames.add(name);
    return name;
  }

  private derivedUrl(name: string): string {
    if (!this.allowedNames.has(name)) throw new Error("scratch-database-name-not-allowlisted");
    const url = new URL(this.config.sourceUrl);
    url.pathname = `/${name}`;
    return url.toString();
  }

  async createMigrated(label = "source"): Promise<{ name: string; url: string }> {
    await this.preflight();
    const name = this.allocateName(label);
    const existing = await this.maintenance.$queryRawUnsafe<Array<{ exists: boolean }>>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      name,
    );
    if (existing[0]?.exists) throw new Error("scratch-database-target-already-exists");
    await this.maintenance.$executeRawUnsafe(`CREATE DATABASE ${quoteIdentifier(name)}`);
    this.live.add(name);
    const url = this.derivedUrl(name);
    const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));
    try {
      execFileSync("npx", ["prisma", "migrate", "deploy"], {
        cwd: dbDirectory,
        env: { ...process.env, DATABASE_URL: url },
        stdio: "inherit",
      });
    } catch (error) {
      // The caller never learned this name, so it is the only thing that can
      // drop it. A drop that fails leaves the name in `live` on purpose:
      // dropAll() tries again, and a sweep will reclaim it after that.
      await this.drop(name).catch(() => undefined);
      throw error;
    }
    return { name, url };
  }

  async clone(sourceName: string, label = "copy", wait: ConnectionWaitOptions = {}): Promise<{ name: string; url: string }> {
    if (!this.allowedNames.has(sourceName)) throw new Error("scratch-template-name-not-allowlisted");
    await awaitNoConnections(async () => {
      const active = await this.maintenance.$queryRawUnsafe<Array<{ count: bigint }>>(
        "SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE datname = $1",
        sourceName,
      );
      return active[0]?.count ?? 0n;
    }, wait);
    const name = this.allocateName(label);
    if (name === sourceName) throw new Error("scratch-source-target-must-differ");
    const existing = await this.maintenance.$queryRawUnsafe<Array<{ exists: boolean }>>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      name,
    );
    if (existing[0]?.exists) throw new Error("scratch-database-target-already-exists");
    await this.maintenance.$executeRawUnsafe(`CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE ${quoteIdentifier(sourceName)}`);
    this.live.add(name);
    return { name, url: this.derivedUrl(name) };
  }

  async drop(name: string): Promise<void> {
    if (!this.allowedNames.has(name)) throw new Error("scratch-drop-name-not-allowlisted");
    if (!scratchNamePattern.test(name)) throw new Error("scratch-drop-name-invalid");
    await this.maintenance.$queryRawUnsafe(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      name,
    );
    await this.maintenance.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
    this.allowedNames.delete(name);
    this.live.delete(name);
  }

  /**
   * Drops every database this manager still has, newest first, and reports what
   * would not go.
   *
   * Newest first because a clone holding its template open is the one ordering
   * that fails, and reporting rather than throwing because the caller has a
   * result to deliver as well: a run that leaked a database has not succeeded,
   * whatever its tests said, and the caller is the one that can say so.
   */
  async dropAll(): Promise<DropFailure[]> {
    const failures: DropFailure[] = [];
    for (const name of [...this.live].reverse()) {
      try {
        await this.drop(name);
      } catch (error) {
        failures.push({ name, error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
    return failures;
  }

  /**
   * Drops scratch databases left behind by a process that is gone.
   *
   * SIGKILL, a power cut and a crashed host all end a run without giving it the
   * chance to clean up, so reliable cleanup on the way out cannot be the whole
   * answer — something has to collect what an unreliable exit left. Two facts
   * make that safe to do automatically: the name carries the pid of the process
   * that created it, and a database in use has a backend attached to it. A
   * database whose creator is still running, or that anything is connected to,
   * is left exactly where it is.
   *
   * The pid is read on this host, which is the host the scratch server is for —
   * the harness requires the test and maintenance URLs to name one server, and
   * both the gate's throwaway container and a developer's scratch container are
   * local to the run that uses them.
   */
  async reclaimOrphans(
    { isAlive = processIsAlive }: { isAlive?: (pid: number) => boolean } = {},
  ): Promise<ScratchReclamation> {
    const rows = await this.maintenance.$queryRawUnsafe<Array<{ datname: string }>>(
      `SELECT d.datname FROM pg_database d
       WHERE d.datname LIKE 'agentos\_cp\_a\_%'
         AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
    );
    const reclaimed: string[] = [];
    const skipped: string[] = [];
    for (const { datname } of rows) {
      const pid = scratchNameOwnerPid(datname);
      if (pid === null || isAlive(pid)) {
        skipped.push(datname);
        continue;
      }
      try {
        await this.maintenance.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(datname)}`);
        reclaimed.push(datname);
      } catch {
        // Something connected between the query and the drop; it is not an
        // orphan after all, and the next run will look again.
        skipped.push(datname);
      }
    }
    return { reclaimed, skipped };
  }

  async disconnect(): Promise<void> {
    await this.maintenance.$disconnect();
  }
}

if (!process.env.TEST_DATABASE_URL) throw new Error("scratch-test-database-url-required");
export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const parsedTestDatabaseUrl = new URL(testDatabaseUrl);
export const testDatabaseSchema = parsedTestDatabaseUrl.searchParams.get("schema") ?? "public";

if (testDatabaseSchema === "public") {
  throw new Error("TEST_DATABASE_URL must name a dedicated non-public schema because the DB harness resets it");
}

let migrationsApplied = false;

/**
 * A database the runner created from an already-migrated template carries every
 * migration and no rows, which is precisely what resetSchema() produces — so
 * running it again would pay two `npx prisma` spawns per file to reach the
 * state the file is already in.
 */
const preMigrated = process.env[preMigratedEnvironmentVariable] === "1";

/**
 * Drops and re-applies the dedicated test schema.
 *
 * This is what `prisma migrate reset` did, spelled out: drop the schema named in
 * TEST_DATABASE_URL, recreate it, then `migrate deploy`. It is written this way
 * because `migrate reset` refuses to run under an AI coding agent, which would
 * otherwise make every *.dbtest.ts unrunnable in an agent session. `deploy` is
 * non-interactive, needs no shadow database, and applies exactly the committed
 * migration folders — so this is the same reset with one fewer dependency.
 *
 * The blast radius is bounded above: the module refuses a `public` schema, so
 * the only thing this can drop is a schema created for these tests.
 */
const resetSchema = (): void => {
  const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));
  const quoted = `"${testDatabaseSchema.replaceAll('"', '""')}"`;
  execSync(
    `npx prisma db execute --url ${JSON.stringify(testDatabaseUrl)} --stdin`,
    {
      cwd: dbDirectory,
      input: `DROP SCHEMA IF EXISTS ${quoted} CASCADE; CREATE SCHEMA ${quoted};`,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  execSync("npx prisma migrate deploy", {
    cwd: dbDirectory,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: "inherit",
  });
};

export const setupTestDb = (): PrismaClient => {
  if (!migrationsApplied && !preMigrated) {
    resetSchema();
    migrationsApplied = true;
  }
  return new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
};

export const resetTestDb = async (db: PrismaClient): Promise<void> => {
  const url = new URL(testDatabaseUrl);
  const schema = url.searchParams.get("schema") ?? "public";
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = ${schema} AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const quoted = tables.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
};
