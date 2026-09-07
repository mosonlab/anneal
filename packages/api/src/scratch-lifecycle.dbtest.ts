import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@anneal/db";

import { derivedMaintenanceUrl, provisioningAvailable } from "./dbtest-plan.js";
import { ScratchDatabaseManager, scratchNameOwnerPid } from "./testdb.js";

/**
 * What happens to a scratch database when a run does not end the way it meant
 * to (issue #161 review).
 *
 * The ten green parallel runs behind this change say what cleanup does when
 * everything works, which is the case that was never in doubt. These are the
 * other ways out: a migration that fails after the database exists, a run
 * killed outright, and a database that looks abandoned but is not. Each one is
 * checked against the server rather than against a fake, because "the database
 * is gone" is a fact about PostgreSQL.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const runner = join(packageRoot, "scripts", "dbtest.mjs");

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  TEST_DATABASE_MAINTENANCE_URL:
    process.env.TEST_DATABASE_MAINTENANCE_URL ?? derivedMaintenanceUrl(process.env.TEST_DATABASE_URL ?? ""),
};

// Without the scratch opt-in there is no server this may create databases on,
// which is the same condition under which the runner stays serial.
const skip = provisioningAvailable(process.env) ? false : "needs AGENTOS_ALLOW_SCRATCH_DATABASES=1";

const maintenanceUrl = environment.TEST_DATABASE_MAINTENANCE_URL ?? "";

const maintenance = (): PrismaClient => new PrismaClient({
  datasources: { db: { url: maintenanceUrl } },
});

const scratchNames = async (client: PrismaClient): Promise<string[]> => {
  const rows = await client.$queryRawUnsafe<Array<{ datname: string }>>(
    "SELECT datname FROM pg_database WHERE datname LIKE 'agentos\\_cp\\_a\\_%' ORDER BY datname",
  );
  return rows.map(({ datname }) => datname);
};

/**
 * The scratch databases one run made.
 *
 * Every scratch name carries the pid of the process that asked for it, and that
 * is what makes "this run left nothing behind" answerable at all on a server
 * other runs are using at the same time. The parallelism this change introduces
 * puts sibling files on that server concurrently — service-maintenance-lock
 * takes a scratch database of its own — so the whole server's list is a
 * question about everyone, and the pid narrows it to the run under test without
 * excusing a single database of that run's own.
 */
const scratchNamesOwnedBy = async (client: PrismaClient, pid: number): Promise<string[]> =>
  (await scratchNames(client)).filter((name) => scratchNameOwnerPid(name) === pid);

/** The database a test file was handed, by name. */
const databaseName = (url: string): string => new URL(url).pathname.slice(1);

/** A pid nothing on this host is using, so a database named after it is an orphan. */
const deadPid = (): number => {
  for (let candidate = 60_000; candidate < 65_000; candidate += 1) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no free pid to name an orphan after");
};

/**
 * Sweeps until the named databases are gone, or gives up.
 *
 * One sweep is not an answer about a connection that has just closed: the
 * backend is in pg_stat_activity until PostgreSQL reaps it, and a database with
 * a backend is deliberately left alone. The sweep is meant to be run again —
 * every run starts with one — so a test of it waits the same way.
 */
const reclaimUntil = async (
  manager: ScratchDatabaseManager,
  names: string[],
  timeoutMs = 30_000,
): Promise<Set<string>> => {
  const reclaimed = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const name of (await manager.reclaimOrphans()).reclaimed) reclaimed.add(name);
    if (names.every((name) => reclaimed.has(name)) || Date.now() >= deadline) return reclaimed;
    await setTimeout(250);
  }
};

const temporaryDirectory = (t: { after: (fn: () => void) => void }, prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test("SCRATCH-CREATE-FAILURE takes its half-made database with it", { skip }, async (t) => {
  const manager = new ScratchDatabaseManager(environment);
  const client = maintenance();
  t.after(async () => {
    await manager.disconnect();
    await client.$disconnect();
  });

  // `CREATE DATABASE` succeeds and the migration that follows does not, which
  // is the window where the caller has not been told a name yet and so cannot
  // clean up on its own behalf.
  const binaries = temporaryDirectory(t, "agentos-scratch-npx-");
  const fakeNpx = join(binaries, "npx");
  writeFileSync(fakeNpx, "#!/bin/sh\necho 'migrate refused' >&2\nexit 1\n");
  chmodSync(fakeNpx, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binaries}:${originalPath ?? ""}`;

  try {
    await assert.rejects(manager.createMigrated("failedmigrate"));
  } finally {
    process.env.PATH = originalPath;
  }

  assert.deepEqual(
    (await scratchNamesOwnedBy(client, process.pid)).filter((name) => name.includes("failedmigrate")),
    [],
    "the database whose migration failed is still on the server",
  );
  assert.equal(manager.live.size, 0);
});

test("SCRATCH-RECLAIM collects what a killed run left, and nothing else", { skip }, async (t) => {
  const manager = new ScratchDatabaseManager(environment);
  const client = maintenance();
  const orphan = `agentos_cp_a_orphan_${deadPid()}_${"ab".repeat(6)}`;
  const inUse = `agentos_cp_a_inuse_${deadPid()}_${"cd".repeat(6)}`;
  const running = `agentos_cp_a_running_${process.pid}_${"ef".repeat(6)}`;
  const connection = new PrismaClient({
    datasources: { db: { url: new URL(`/${inUse}`, environment.TEST_DATABASE_URL).toString() } },
  });
  t.after(async () => {
    await connection.$disconnect();
    for (const name of [orphan, inUse, running]) {
      await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
    }
    await manager.disconnect();
    await client.$disconnect();
  });

  for (const name of [orphan, inUse, running]) {
    await client.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  }
  await connection.$queryRawUnsafe("SELECT 1");

  const first = await manager.reclaimOrphans();

  assert.ok(first.reclaimed.includes(orphan), "a database from a dead process was left on the server");
  // The two negatives are the whole safety of sweeping by name: a run that is
  // still going has a live pid, and a database being used has a backend.
  assert.ok(!first.reclaimed.includes(running), "a live process's database was dropped underneath it");
  assert.ok(!first.reclaimed.includes(inUse), "a database with an open connection was dropped");

  await connection.$disconnect();
  const second = await reclaimUntil(manager, [inUse]);
  assert.ok(second.has(inUse), "the database stayed unswept after its connection closed");
});

/** Runs the real runner over throwaway test files and reports what it printed. */
const runRunner = (
  t: { after: (fn: () => void) => void },
  { report, killOn }: { report?: string; killOn?: RegExp } = {},
): Promise<{ code: number | null; output: string; roots: string; pid: number }> => {
  const workspace = temporaryDirectory(t, "agentos-scratch-e2e-");
  const roots = join(workspace, "roots");
  const files = ["one", "two"].map((name) => {
    const file = join(workspace, `${name}.dbtest.ts`);
    writeFileSync(file, [
      'import { appendFileSync } from "node:fs";',
      'import test from "node:test";',
      `test("FIXTURE ${name} reports what it was handed", () => {`,
      "  const report = process.env.AGENTOS_DBTEST_FIXTURE_REPORT;",
      "  if (!report) return;",
      "  appendFileSync(report, `${JSON.stringify({",
      `    file: ${JSON.stringify(name)},`,
      "    databaseUrl: process.env.TEST_DATABASE_URL,",
      "    databaseUrlAlias: process.env.DATABASE_URL,",
      "    workspaceRoot: process.env.RUNNER_WORKSPACE_ROOT,",
      "    controlPlaneStateDir: process.env.CONTROL_PLANE_STATE_DIR,",
      "    filesRoot: process.env.FILES_ROOT,",
      "  })}\\n`);",
      "});",
    ].join("\n"));
    return file;
  });

  const childEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    AGENTOS_DBTEST_CONCURRENCY: "2",
    AGENTOS_DBTEST_FIXTURE_REPORT: report ?? "",
    RUNNER_WORKSPACE_ROOT: join(roots, "workspaces"),
    CONTROL_PLANE_STATE_DIR: join(roots, "state"),
    FILES_ROOT: join(roots, "files"),
  };
  // This file received both from the runner that is running it; the runner
  // being started here plans for its own files and must not inherit ours.
  delete childEnvironment.AGENTOS_DBTEST_PLAN;
  delete childEnvironment.AGENTOS_DBTEST_PREMIGRATED;
  // node:test marks its own children, and refuses to run files inside one; the
  // runner started here is a new run, not a nested one.
  delete childEnvironment.NODE_TEST_CONTEXT;
  // What these two tests are about is the path that hands out databases. The
  // caller may have turned that off for the suite this file is part of — a
  // caller that runs the suite against one shared schema does exactly that —
  // and inheriting it would leave the tests asserting isolation against a run
  // that was asked not to isolate.
  delete childEnvironment.AGENTOS_DBTEST_PROVISION;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", runner, ...files], {
      cwd: packageRoot,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { pid } = child;
    // The runner names every database it creates after itself, so without this
    // there is no way to tell its leftovers from a sibling file's.
    if (pid === undefined) {
      reject(new Error("the runner under test did not start"));
      return;
    }
    let output = "";
    const watch = (chunk: Buffer): void => {
      output += chunk.toString();
      // Killed only once the databases certainly exist, which is what makes the
      // leftovers this asserts on real rather than incidental.
      if (killOn?.test(output)) child.kill("SIGKILL");
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output, roots, pid }));
  });
};

test("SCRATCH-RUNNER-ISOLATION gives each file its own database and roots, and leaves none behind", { skip }, async (t) => {
  const client = maintenance();
  t.after(async () => { await client.$disconnect(); });
  const reportDirectory = temporaryDirectory(t, "agentos-scratch-report-");
  const report = join(reportDirectory, "report.jsonl");
  writeFileSync(report, "");

  const { code, output, pid } = await runRunner(t, { report });

  assert.equal(code, 0, output);
  const raw = readFileSync(report, "utf8").trim();
  assert.notEqual(raw, "", `no test file reported its environment; the run printed:\n${output}`);
  const seen = raw.split("\n").map((line) => JSON.parse(line));
  assert.equal(seen.length, 2, output);
  for (const field of ["databaseUrl", "workspaceRoot", "controlPlaneStateDir", "filesRoot"]) {
    const values = seen.map((entry) => entry[field]);
    assert.equal(new Set(values).size, 2, `both files were handed the same ${field}`);
    for (const value of values) assert.ok(value, `${field} reached the test file empty`);
  }
  for (const entry of seen) {
    assert.equal(entry.databaseUrlAlias, entry.databaseUrl, "DATABASE_URL did not follow TEST_DATABASE_URL");
  }
  // Named after the run, so the sweep below is asking about the databases this
  // run really made — the template it migrated included — and not about an
  // empty set that would pass whatever the runner had done.
  for (const entry of seen) {
    assert.equal(
      scratchNameOwnerPid(databaseName(entry.databaseUrl)),
      pid,
      `${entry.file} was handed ${databaseName(entry.databaseUrl)}, which is not named after this run`,
    );
  }
  assert.deepEqual(
    await scratchNamesOwnedBy(client, pid),
    [],
    "the run left scratch databases of its own on the server",
  );
});

test("SCRATCH-RUNNER-KILLED leaves databases, and the next run reclaims them", { skip }, async (t) => {
  const client = maintenance();
  const manager = new ScratchDatabaseManager(environment);
  t.after(async () => {
    await manager.disconnect();
    await client.$disconnect();
  });
  // SIGKILL is the one exit no process can clean up after, which is why the
  // sweep exists at all.
  const { output, pid } = await runRunner(t, { killOn: /cloned 2 times/u });

  const leftBehind = await scratchNamesOwnedBy(client, pid);
  assert.ok(leftBehind.length > 0, `nothing was left to reclaim; the run printed:\n${output}`);

  const reclaimed = await reclaimUntil(manager, leftBehind);

  for (const name of leftBehind) {
    assert.ok(reclaimed.has(name), `${name} survived the sweep`);
  }
  assert.deepEqual(await scratchNamesOwnedBy(client, pid), [], "the killed run still has databases on the server");
});
