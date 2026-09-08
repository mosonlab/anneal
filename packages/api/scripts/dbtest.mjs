// The database-test runner: `npm run test:db -w @anneal/api`.
//
// node:test already runs each *.dbtest.ts in its own process, so the only thing
// that ever forced them into a queue was the schema they shared:
// `--test-concurrency=1` was the lock. This removes the sharing instead of the
// parallelism. It migrates ONE template database, gives every file a
// `CREATE DATABASE ... TEMPLATE` copy of it plus private roots on disk, and
// then lets node:test run several files at once.
//
// Two costs disappear together. Files stop waiting for each other, and the
// per-file `DROP SCHEMA` + `prisma migrate deploy` — two `npx` spawns each,
// paid twenty-seven times — becomes one migrate and twenty-seven server-side
// file copies.
//
// This file is the process: the arguments, the child, and the signals. The
// order those happen in, and the cleanup that order buys, is
// src/dbtest-runner.ts, where it can be tested without a PostgreSQL.
//
// If the caller has not opted into scratch databases
// (AGENTOS_ALLOW_SCRATCH_DATABASES=1), there is nothing safe to hand out, so
// the run stays serial on the single shared schema exactly as before.
//
//   AGENTOS_DBTEST_CONCURRENCY=3   how many files at once (default: cores-1, max 4)
//   AGENTOS_DBTEST_PROVISION=0     keep the shared schema; forces serial
//   npm run test:db -w @anneal/api -- src/chain.dbtest.ts   run a subset

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism, constants } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  derivedMaintenanceUrl,
  provisioningAvailable,
  provisioningRequested,
} from "../src/dbtest-plan.ts";
import { runDbtest } from "../src/dbtest-runner.ts";
import { dbtestInvocationDecision } from "../src/dbtest-scope.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceDirectory = join(packageRoot, "src");
const testProcess = join(packageRoot, "scripts", "dbtest-process.mjs");

const say = (message) => process.stdout.write(`dbtest: ${message}\n`);

const testFiles = () => {
  const requested = process.argv.slice(2);
  if (requested.length > 0) return requested.map((file) => resolve(process.cwd(), file));
  return readdirSync(sourceDirectory)
    .filter((entry) => entry.endsWith(".dbtest.ts"))
    .sort()
    .map((entry) => join(sourceDirectory, entry));
};

/**
 * Starts node:test and resolves with the code its process ended on.
 *
 * A signal the runner caught is forwarded here rather than allowed to kill this
 * process outright: the children have to hear it, and the cleanup that follows
 * them has to run.
 */
const runNodeTest = ({ files, concurrency, environment, signal }) => new Promise((resolveRun) => {
  const args = ["--conditions=development", "--import", "tsx"];
  args.push(testProcess, String(concurrency), ...files);
  const child = spawn(process.execPath, args, {
    cwd: packageRoot, stdio: "inherit",
    // A DB harness can itself be exercised by a node:test file. The coordinator
    // is a new runner, not a recursive call in that test's child process.
    env: { ...environment, NODE_TEST_CONTEXT: undefined },
  });
  const forward = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", forward, { once: true });
  const done = (code) => {
    signal?.removeEventListener("abort", forward);
    resolveRun(code);
  };
  child.on("exit", (code, signalName) => {
    done(signalName ? 128 + (constants.signals[signalName] ?? 15) : code ?? 1);
  });
  child.on("error", (error) => {
    say(`could not start node:test: ${error.message}`);
    done(1);
  });
});

const main = async () => {
  const requested = process.argv.slice(2);
  const decision = dbtestInvocationDecision({
    args: requested,
    environment: process.env,
    cpuCount: availableParallelism(),
  });
  if (decision.exitCode !== null) {
    process.stderr.write(`${decision.refusal}\n`);
    process.exitCode = decision.exitCode;
    return;
  }
  if (decision.capLog) say(decision.capLog);

  const files = testFiles();
  if (files.length === 0) throw new Error("no *.dbtest.ts files to run");

  if (!provisioningRequested(process.env) || !provisioningAvailable(process.env)) {
    const why = provisioningRequested(process.env)
      ? "AGENTOS_ALLOW_SCRATCH_DATABASES=1 and TEST_DATABASE_URL are what let each file own a database"
      : "AGENTOS_DBTEST_PROVISION=0";
    say(`${files.length} files, serial on the shared schema (${why})`);
    // Nothing is provisioned on this path, so there is nothing to clean up and
    // no reason to stand between the child and a Ctrl-C.
    process.exitCode = await runNodeTest({ files, concurrency: 1, environment: process.env });
    return;
  }

  const environment = {
    ...process.env,
    TEST_DATABASE_MAINTENANCE_URL:
      process.env.TEST_DATABASE_MAINTENANCE_URL ?? derivedMaintenanceUrl(process.env.TEST_DATABASE_URL),
  };
  // Imported here, not at the top: the module resolves TEST_DATABASE_URL when it
  // loads, and the branch above is the one that may run without it.
  const { ScratchDatabaseManager } = await import("../src/testdb.ts");
  process.exitCode = await runDbtest({
    environment,
    concurrency: decision.concurrency,
    files,
    manager: new ScratchDatabaseManager(environment),
    runTests: runNodeTest,
    log: say,
  });
};

await main();
