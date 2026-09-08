import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { planEnvironmentVariable } from "./dbtest-plan.js";
import { runDbtest, type RunTestsOptions, type ScratchManagerLike } from "./dbtest-runner.js";
import { fixtureDatabaseUrl } from "./dbtest-url-fixture.js";
import { formatTimingLine, timingHistoryEnvironmentVariable, timingsEnvironmentVariable } from "./dbtest-timings.js";

const dbtestScript = fileURLToPath(new URL("../scripts/dbtest.mjs", import.meta.url));
const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const testProcess = fileURLToPath(new URL("../scripts/dbtest-process.mjs", import.meta.url));

test("DBTEST-PROCESS preserves queue order, isolates files, and propagates failures", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agentos-dbtest-order-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = join(directory, "z-first.mjs");
  const second = join(directory, "a-second.mjs");
  writeFileSync(first, 'import test from "node:test"; globalThis.leaked = true; test("first", () => console.log("ORDER=first"));');
  writeFileSync(second, 'import test from "node:test"; import assert from "node:assert/strict"; test("second", () => { console.log("ORDER=second"); assert.equal(globalThis.leaked, undefined); });');
  const environment = { ...process.env, NODE_TEST_CONTEXT: undefined, AGENTOS_DBTEST_PLAN: undefined, NODE_OPTIONS: undefined };
  const invoke = (files: string[]) => spawnSync(process.execPath, [testProcess, "1", ...files], {
    encoding: "utf8", env: environment,
  });
  const passed = invoke([first, second]);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.deepEqual(passed.stdout.match(/ORDER=\w+/gu), ["ORDER=first", "ORDER=second"]);
  writeFileSync(second, 'import test from "node:test"; test("fails", () => { throw new Error("intentional-fixture-failure"); });');
  const failed = invoke([first, second]);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /intentional-fixture-failure/u);
  assert.equal(invoke([join(directory, "missing.mjs")]).status, 1);
});

test("DBTEST-PROCESS aborts its live file child before returning a signal status", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agentos-dbtest-signal-"));
  const ready = join(directory, "ready");
  const entry = join(directory, "pending.mjs");
  writeFileSync(entry, `import { writeFileSync } from "node:fs"; import test from "node:test";
    test("pending", async () => { writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      await new Promise(() => { setInterval(() => {}, 1000); }); });`);
  const child = spawn(process.execPath, [testProcess, "1", entry], {
    stdio: "ignore", env: { ...process.env, NODE_TEST_CONTEXT: undefined, AGENTOS_DBTEST_PLAN: undefined },
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  t.after(() => { child.kill("SIGKILL"); rmSync(directory, { recursive: true, force: true }); });
  // A loaded worker can delay child startup; wait for its actual ready signal.
  const deadline = Date.now() + 30_000;
  while (!existsSync(ready) && Date.now() < deadline) await delay(20);
  assert.ok(existsSync(ready), "file child never became ready");
  const filePid = Number(readFileSync(ready, "utf8"));
  child.kill("SIGTERM");
  assert.equal(await closed, 143);
  assert.throws(() => process.kill(filePid, 0), /ESRCH/u, "coordinator left its file child alive");
});

/**
 * The manager's own contract, in memory: a database exists from the moment
 * CREATE returns, a creation that fails afterwards takes its database with it,
 * and dropAll() reports what would not go. The tests below are about what the
 * runner does with that contract on each way out of a run.
 */
class FakeManager implements ScratchManagerLike {
  readonly databases = new Set<string>();
  readonly dropped: string[] = [];
  undroppable = new Set<string>();
  migrationFailure: Error | null = null;
  cloneFailure: Error | null = null;
  orphans: string[] = [];
  disconnected = false;
  onCreate: (() => void) | null = null;
  onClone: (() => void) | null = null;
  private counter = 0;

  readonly maintenance = {
    $queryRawUnsafe: async <T,>(): Promise<T> => [{ max_connections: 100 }] as T,
  };

  async reclaimOrphans(): Promise<{ reclaimed: string[]; skipped: string[] }> {
    const reclaimed = this.orphans;
    this.orphans = [];
    return { reclaimed, skipped: [] };
  }

  private allocate(label: string): { name: string; url: string } {
    this.counter += 1;
    const name = `agentos_cp_a_${label}_4242_${String(this.counter).padStart(12, "0")}`;
    this.databases.add(name);
    return { name, url: fixtureDatabaseUrl("scratch", "secret", `127.0.0.1:55432/${name}?schema=agentos`) };
  }

  async createMigrated(label = "source"): Promise<{ name: string; url: string }> {
    const created = this.allocate(label);
    this.onCreate?.();
    if (this.migrationFailure) {
      this.databases.delete(created.name);
      throw this.migrationFailure;
    }
    return created;
  }

  async clone(_sourceName: string, label = "copy"): Promise<{ name: string; url: string }> {
    this.onClone?.();
    if (this.cloneFailure) throw this.cloneFailure;
    return this.allocate(label);
  }

  async dropAll(): Promise<Array<{ name: string; error: Error }>> {
    const failures: Array<{ name: string; error: Error }> = [];
    for (const name of [...this.databases].reverse()) {
      if (this.undroppable.has(name)) {
        failures.push({ name, error: new Error("scratch-drop-refused") });
        continue;
      }
      this.databases.delete(name);
      this.dropped.push(name);
    }
    return failures;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

class FakeSignals {
  readonly handlers = new Map<NodeJS.Signals, Set<() => void>>();

  on(signal: NodeJS.Signals, handler: () => void): void {
    const existing = this.handlers.get(signal) ?? new Set();
    existing.add(handler);
    this.handlers.set(signal, existing);
  }

  off(signal: NodeJS.Signals, handler: () => void): void {
    this.handlers.get(signal)?.delete(handler);
  }

  emit(signal: NodeJS.Signals): void {
    for (const handler of this.handlers.get(signal) ?? []) handler();
  }

  get installed(): number {
    return [...this.handlers.values()].reduce((total, set) => total + set.size, 0);
  }
}

interface Harness {
  manager: FakeManager;
  signals: FakeSignals;
  environment: NodeJS.ProcessEnv;
  files: string[];
  logs: string[];
  roots: string;
  calls: RunTestsOptions[];
}

const harness = (t: { after: (fn: () => void) => void }, fileNames = ["alpha.dbtest.ts", "beta.dbtest.ts"]): Harness => {
  const roots = mkdtempSync(join(tmpdir(), "agentos-dbtest-runner-test-"));
  t.after(() => rmSync(roots, { recursive: true, force: true }));
  return {
    manager: new FakeManager(),
    signals: new FakeSignals(),
    environment: {
      RUNNER_WORKSPACE_ROOT: join(roots, "workspaces"),
      CONTROL_PLANE_STATE_DIR: join(roots, "state"),
      FILES_ROOT: join(roots, "files"),
      AGENTOS_DBTEST_CONCURRENCY: "2",
    },
    files: fileNames.map((name) => join(roots, name)),
    logs: [],
    roots,
    calls: [],
  };
};

const run = async (h: Harness, runTests: (options: RunTestsOptions) => Promise<number>): Promise<number> =>
  runDbtest({
    environment: h.environment,
    concurrency: 2,
    files: h.files,
    manager: h.manager,
    runTests: async (options) => {
      h.calls.push(options);
      return runTests(options);
    },
    log: (message) => h.logs.push(message),
    signals: h.signals,
  });

test("DBTEST-RUNNER-SOURCE-CONDITION gives its node:test child exactly one development condition", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agentos-dbtest-child-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entry = join(directory, "child.mjs");
  writeFileSync(entry, [
    'import test from "node:test";',
    'test("reports exec argv", () => {',
    '  process.stdout.write(`DBTEST_CHILD_ARGV=${JSON.stringify(process.execArgv)}\\n`);',
    "});",
  ].join("\n"));

  const result = spawnSync(process.execPath, ["--import", "tsx", dbtestScript, entry], {
    cwd: apiRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTOS_DBTEST_PROVISION: "0",
      AGENTOS_RUN_ID: undefined,
      AGENTOS_RUN_SCOPE_BYPASS: undefined,
      NODE_TEST_CONTEXT: undefined,
      NODE_OPTIONS: undefined,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const match = /^DBTEST_CHILD_ARGV=(\[[^\n]*\])$/mu.exec(result.stdout);
  assert.ok(match, `node:test child did not report its argv:\n${result.stdout}`);
  const childArgv = JSON.parse(match[1] as string) as string[];
  assert.equal(
    childArgv.filter((argument) => argument === "--conditions=development").length,
    1,
    JSON.stringify(childArgv),
  );
});

test("DBTEST-RUN-ISOLATION gives every file its own database and its own three roots", async (t) => {
  const h = harness(t);
  let plan: { files: Record<string, Record<string, string>> } = { files: {} };
  const code = await run(h, async ({ environment }) => {
    plan = JSON.parse(readFileSync(environment[planEnvironmentVariable] as string, "utf8"));
    return 0;
  });

  assert.equal(code, 0);
  const assignments = h.files.map((file) => {
    const assignment = plan.files[file];
    assert.ok(assignment, `no assignment for ${file}`);
    return assignment;
  });
  for (const field of ["databaseUrl", "workspaceRoot", "controlPlaneStateDir", "filesRoot"]) {
    const values = assignments.map((assignment) => assignment[field]);
    assert.equal(new Set(values).size, values.length, `${field} was shared between files`);
    for (const value of values) assert.ok(value, `${field} was not assigned`);
  }
  for (const assignment of assignments) {
    for (const field of ["workspaceRoot", "controlPlaneStateDir", "filesRoot"]) {
      assert.ok(existsSync(assignment[field] as string), `${field} was planned but not created`);
    }
  }
});

test("DBTEST-HISTORY is advisory, withheld from children, and saved only after a clean wave", async (t) => {
  const h = harness(t);
  const directory = mkdtempSync(join(tmpdir(), "agentos-dbtest-history-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const history = join(directory, "history.jsonl");
  const previous = h.files.map((file, index) => formatTimingLine({ file, ms: index + 1 })).join("");
  writeFileSync(history, previous);
  h.environment[timingHistoryEnvironmentVariable] = history;
  const invoke = (status: number) => run(h, async ({ files, environment }) => {
    assert.deepEqual(files, [...h.files].reverse());
    assert.equal(environment[timingHistoryEnvironmentVariable], undefined);
    writeFileSync(environment[timingsEnvironmentVariable]!, files.map((file) => formatTimingLine({ file, ms: 5 })).join(""));
    return status;
  });
  assert.equal(await invoke(1), 1);
  assert.equal(readFileSync(history, "utf8"), previous);
  assert.equal(await invoke(0), 0);
  assert.notEqual(readFileSync(history, "utf8"), previous);
});

test("DBTEST-RUN-CLEANUP drops every database it made, and takes the plan with it", async (t) => {
  const h = harness(t);
  let planPath = "";
  const code = await run(h, async ({ environment }) => {
    planPath = environment[planEnvironmentVariable] as string;
    return 0;
  });

  assert.equal(code, 0);
  assert.equal(h.manager.databases.size, 0);
  assert.equal(h.manager.dropped.length, 3); // one template, two clones
  assert.equal(h.manager.disconnected, true);
  assert.equal(existsSync(planPath), false);
  assert.equal(h.signals.installed, 0, "signal handlers outlived the run");
});

test("DBTEST-RUN-CLEANUP survives failing tests without changing their verdict", async (t) => {
  const h = harness(t);
  const code = await run(h, async () => 1);

  assert.equal(code, 1);
  assert.equal(h.manager.databases.size, 0);
  assert.equal(h.manager.disconnected, true);
});

test("DBTEST-RUN-CLEANUP runs when provisioning fails, and the failure is what surfaces", async (t) => {
  const h = harness(t);
  h.manager.cloneFailure = new Error("scratch-template-has-active-connections");

  await assert.rejects(run(h, async () => 0), /scratch-template-has-active-connections/u);
  // The template existed before the clone failed; nothing may outlive the run.
  assert.equal(h.manager.databases.size, 0);
  assert.equal(h.manager.disconnected, true);
  assert.equal(h.calls.length, 0, "tests ran despite provisioning failing");
});

test("DBTEST-RUN-CLEANUP leaves nothing behind when the template migration fails", async (t) => {
  const h = harness(t);
  h.manager.migrationFailure = new Error("Command failed: npx prisma migrate deploy");

  await assert.rejects(run(h, async () => 0), /migrate deploy/u);
  assert.equal(h.manager.databases.size, 0);
  assert.equal(h.calls.length, 0);
});

test("DBTEST-RUN-SIGNAL during provisioning stops before the tests and still cleans up", async (t) => {
  const h = harness(t);
  // The signal lands while the template is being migrated — the window the
  // runner used to spend with no handler installed at all.
  h.manager.onCreate = () => h.signals.emit("SIGINT");

  const code = await run(h, async () => 0);

  assert.equal(code, 130, "an interrupted run must not look like a passing one");
  assert.equal(h.calls.length, 0, "tests started after the interrupt");
  assert.equal(h.manager.databases.size, 0);
  assert.equal(h.manager.disconnected, true);
  assert.equal(h.signals.installed, 0);
});

test("DBTEST-RUN-SIGNAL during a clone stops between clones and drops what exists", async (t) => {
  const h = harness(t);
  let clones = 0;
  h.manager.onClone = () => {
    clones += 1;
    if (clones === 1) h.signals.emit("SIGTERM");
  };

  const code = await run(h, async () => 0);

  assert.equal(code, 143);
  assert.equal(clones, 1, "cloning continued past the signal");
  assert.equal(h.manager.databases.size, 0);
});

test("DBTEST-RUN-SIGNAL during the tests reaches the child instead of killing the runner", async (t) => {
  const h = harness(t);
  const code = await run(h, async ({ signal }) => {
    assert.equal(signal.aborted, false);
    h.signals.emit("SIGINT");
    assert.equal(signal.aborted, true, "the child was never told");
    return 130;
  });

  assert.equal(code, 130);
  assert.equal(h.manager.databases.size, 0);
});

test("DBTEST-RUN-LEAK is red even when every test passed", async (t) => {
  const h = harness(t);
  const code = await run(h, async () => {
    h.manager.undroppable = new Set([[...h.manager.databases][1] as string]);
    return 0;
  });

  assert.notEqual(code, 0, "a run that leaked a database reported success");
  assert.equal(h.manager.databases.size, 1);
  assert.ok(h.logs.some((line) => line.includes("could not drop")), "the leak was not named");
  assert.ok(h.logs.some((line) => line.includes("left behind")), "the leak was not summarised");
  assert.equal(h.manager.disconnected, true);
});

test("DBTEST-RUN-RECLAIM says what a previous run left behind", async (t) => {
  const h = harness(t);
  h.manager.orphans = ["agentos_cp_a_chain_991_abcdefabcdef"];

  const code = await run(h, async () => 0);

  assert.equal(code, 0);
  assert.ok(h.logs.some((line) => line.includes("reclaimed 1 database")), h.logs.join("\n"));
});
