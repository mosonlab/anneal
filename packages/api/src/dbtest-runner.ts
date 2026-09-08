// What `npm run test:db` does once it has decided to give every test file a
// database of its own. The script that calls this (scripts/dbtest.mjs) owns the
// process and the child; this owns the order things happen in, which is where
// the cleanup guarantees live.
//
// The shape of the guarantee: nothing is created before something is watching
// for a signal, everything created is remembered at the moment it exists rather
// than when it is finished with, and the run's result is not green unless the
// cleanup was.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  connectionLimit,
  fileDirectoryName,
  fileLabel,
  isolatedRootVariables,
  perFileDatabaseUrl,
  planEnvironmentVariable,
  type DbtestAssignment,
  type DbtestPlan,
} from "./dbtest-plan.js";
import {
  formatTimingLine, formatTimingReport, orderByTimings, parseTimings,
  timingDisplayName, timingHistoryEnvironmentVariable, timingsEnvironmentVariable,
  type DbtestFileTiming,
} from "./dbtest-timings.js";

/** Just enough of ScratchDatabaseManager to run against, and to fake. */
export interface ScratchManagerLike {
  maintenance: {
    $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
  };
  reclaimOrphans(): Promise<{ reclaimed: string[]; skipped: string[] }>;
  createMigrated(label?: string): Promise<{ name: string; url: string }>;
  clone(sourceName: string, label?: string): Promise<{ name: string; url: string }>;
  dropAll(): Promise<Array<{ name: string; error: Error }>>;
  disconnect(): Promise<void>;
}

export interface RunTestsOptions {
  files: string[];
  concurrency: number;
  environment: NodeJS.ProcessEnv;
  /** Aborts when the runner is signalled, so the child can be signalled too. */
  signal: AbortSignal;
}

export interface SignalSource {
  on(signal: NodeJS.Signals, handler: () => void): unknown;
  off(signal: NodeJS.Signals, handler: () => void): unknown;
}

export interface DbtestRunOptions {
  environment: NodeJS.ProcessEnv;
  concurrency: number;
  files: string[];
  manager: ScratchManagerLike;
  runTests: (options: RunTestsOptions) => Promise<number>;
  log: (message: string) => void;
  signals?: SignalSource;
}

/** The signals a run has to survive as a clean exit rather than an abandoned one. */
export const handledSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/** What a shell reports for a process that died of a signal. */
export const signalExitCode = (signal: NodeJS.Signals): number => (signal === "SIGINT" ? 130 : 143);

/** The code a run that leaked a database gets when its tests all passed. */
export const cleanupFailureExitCode = 1;

/** Every path a test-file process could report as its own entry point. */
const planKeys = (file: string): string[] => {
  const resolved = resolve(file);
  try {
    const real = realpathSync(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
};

/** A per-file subdirectory of a root the caller exported, created up front. */
const isolatedRoot = (root: string, file: string): string => {
  const directory = join(root, fileDirectoryName(file));
  mkdirSync(directory, { recursive: true });
  return directory;
};

/**
 * Runs the database tests with one database per file, and cleans up after
 * itself on every way out of here: a normal finish, a failing test, a failure
 * while provisioning, and a signal at any point in either.
 *
 * Returns the exit code the run deserves. Cleanup that could not finish makes
 * that code nonzero even when every test passed — a database left on a shared
 * scratch server is a defect of this run, and this run is the only one that can
 * report it as one.
 */
export const runDbtest = async ({
  environment,
  concurrency,
  files,
  manager,
  runTests,
  log,
  signals = process,
}: DbtestRunOptions): Promise<number> => {
  const controller = new AbortController();
  let signalled: NodeJS.Signals | null = null;

  // Installed before anything is created. A signal that arrives while the
  // template is migrating has to reach the same cleanup as one that arrives
  // during the tests, and the only way to hold that is to be listening first.
  const handlers = handledSignals.map((signal): [NodeJS.Signals, () => void] => [
    signal,
    () => {
      signalled ??= signal;
      controller.abort();
    },
  ]);
  for (const [signal, handler] of handlers) signals.on(signal, handler);

  const planDirectory = mkdtempSync(join(tmpdir(), "agentos-dbtest-plan-"));
  const timingsPath = join(planDirectory, "timings.jsonl");
  const abandoned = (): number => signalExitCode(signalled ?? "SIGTERM");
  const historyPath = environment[timingHistoryEnvironmentVariable];
  let orderedFiles = files;
  if (historyPath) {
    try {
      const history = parseTimings(readFileSync(historyPath, "utf8"));
      if (history.unreadable > 0) log(`timing history: ignored ${history.unreadable} unreadable record(s)`);
      orderedFiles = orderByTimings(files, history.timings);
      const known = new Set(history.timings.map(({ file }) => timingDisplayName(file)));
      log(`timing history: longest first, ${files.filter((file) => known.has(timingDisplayName(file))).length}/${files.length} measured files`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      log(`timing history unavailable (${code ?? String(error)}); using discovery order`);
    }
  }

  const provisionAndRun = async (): Promise<number> => {
    const provisioningStarted = performance.now();
    const { reclaimed } = await manager.reclaimOrphans();
    if (reclaimed.length > 0) {
      log(`reclaimed ${reclaimed.length} database(s) from a run that never got to clean up`);
    }
    if (controller.signal.aborted) return abandoned();

    log(`${files.length} files, ${concurrency} at a time, one database each`);
    const template = await manager.createMigrated("template");

    // Asked rather than assumed: the ceiling every file's pool has to fit under
    // is the server's, and a server the caller pointed at may not be the
    // hundred-connection default.
    const ceiling = await manager.maintenance.$queryRawUnsafe<Array<{ max_connections: number }>>(
      "SELECT current_setting('max_connections')::int AS max_connections",
    );
    const maxConnections = ceiling[0]?.max_connections;
    // Guessing here would be guessing at the one number that decides whether
    // every file's pool fits, so refuse instead.
    if (maxConnections === undefined) throw new Error("dbtest-server-max-connections-unknown");
    const limit = connectionLimit(maxConnections, concurrency);

    const plan: DbtestPlan = { files: {} };
    for (const file of files) {
      if (controller.signal.aborted) return abandoned();
      const database = await manager.clone(template.name, fileLabel(file));
      const assignment: DbtestAssignment = { databaseUrl: perFileDatabaseUrl(database.url, limit) };
      for (const [field, variable] of Object.entries(isolatedRootVariables)) {
        const root = environment[variable];
        if (root) assignment[field as keyof typeof isolatedRootVariables] = isolatedRoot(root, file);
      }
      // Both spellings, because the child is told a path and reports the one
      // it was told: a checkout reached through a symlink resolves differently
      // on the two sides, and the preamble must not have to guess which.
      for (const key of planKeys(file)) plan.files[key] = assignment;
    }
    if (controller.signal.aborted) return abandoned();

    const planPath = join(planDirectory, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    log(`template ${template.name} cloned ${files.length} times, ${limit} connections each of ${maxConnections}`);
    log(`provisioning: ${((performance.now() - provisioningStarted) / 1000).toFixed(1)}s`);

    // Created empty rather than left to the first writer: an appending process
    // should not have to decide whether the file exists, and an empty file is
    // also the honest report for a run that was signalled before a file ended.
    writeFileSync(timingsPath, "");

    const testsStarted = performance.now();
    const status = await runTests({
      files: orderedFiles,
      concurrency,
      environment: {
        ...environment,
        [planEnvironmentVariable]: planPath,
        [timingsEnvironmentVariable]: timingsPath,
        // Nested harness fixtures must never publish over the real wave's history.
        [timingHistoryEnvironmentVariable]: undefined,
      },
      signal: controller.signal,
    });
    log(`test processes: ${((performance.now() - testsStarted) / 1000).toFixed(1)}s`);
    return status;
  };

  let exitCode: number | null = null;
  let failure: unknown = null;
  let measured: DbtestFileTiming[] = [];
  try {
    exitCode = await provisionAndRun();
  } catch (error) {
    failure = error;
  }

  for (const [signal, handler] of handlers) signals.off(signal, handler);
  // Read before the directory holding it goes, and reported even when the run
  // failed: a red wave is exactly when someone wants to know which file it was.
  try {
    const { timings, unreadable } = parseTimings(readFileSync(timingsPath, "utf8"));
    if (unreadable === 0) measured = timings;
    for (const line of formatTimingReport(timings, { unreadable })) log(line);
  } catch {
    // No timings file means the run never got as far as starting the tests.
  }
  rmSync(planDirectory, { recursive: true, force: true });
  const cleanupStarted = performance.now();
  const leaked = await manager.dropAll();
  for (const { name, error } of leaked) log(`could not drop ${name}: ${error.message}`);
  await manager.disconnect();
  log(`database cleanup: ${((performance.now() - cleanupStarted) / 1000).toFixed(1)}s`);

  // Atomically replace advisory scheduling data only after a complete clean
  // wave. A cache failure is reported, never promoted into verification proof.
  if (historyPath && failure === null && exitCode === 0 && leaked.length === 0
    && measured.length === files.length
    && files.every((file) => measured.some((entry) => resolve(entry.file) === resolve(file)))) {
    const temporary = `${historyPath}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(historyPath), { recursive: true });
      writeFileSync(temporary, measured.map(({ file, ms }) => formatTimingLine({ file: timingDisplayName(file), ms })).join(""));
      renameSync(temporary, historyPath);
    } catch (error) {
      log(`could not save timing history: ${String(error)}`);
    } finally {
      try { rmSync(temporary, { force: true }); }
      catch (error) { log(`could not remove temporary timing history: ${String(error)}`); }
    }
  }

  // The cleanup runs before this rethrow so that a failure while provisioning
  // still takes its databases with it; the failure itself is what the caller
  // hears about.
  if (failure !== null) throw failure;
  if (leaked.length > 0) {
    log(`${leaked.length} database(s) left behind; say so rather than pass, and the next run will reclaim them`);
    return exitCode === 0 || exitCode === null ? cleanupFailureExitCode : exitCode;
  }
  return exitCode ?? cleanupFailureExitCode;
};
