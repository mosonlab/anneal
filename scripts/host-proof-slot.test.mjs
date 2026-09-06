import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = join(repositoryRoot, "scripts", "host-proof-slot.sh");

const platformLock = process.platform === "darwin"
  ? { executable: "/usr/bin/lockf", args: ["-s", "-t", "0", "9"] }
  : process.platform === "linux"
    ? { executable: "/usr/bin/flock", args: ["-x", "-n", "-E", "75", "9"] }
    : null;

const platformName = process.platform === "darwin"
  ? "Darwin"
  : process.platform === "linux"
    ? "Linux"
    : null;

const testRoot = mkdtempSync(join(tmpdir(), "host-proof-slot-test."));
after(() => rmSync(testRoot, { recursive: true, force: true }));

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// The predicates below wait on a detached bash wrapper plus the node child it
// admits to write a marker. Bounded so a wrapper that never admits fails here
// rather than hanging the suite, and sized for
// the loaded gate worker (load1 20-55 observed, where a node or bash+git start alone can exceed 10s), not for an idle host.
const waitFor = async (predicate, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await delay(10);
  }
};

const cleanEnvironment = (overrides = {}) => {
  const environment = { ...process.env, NO_COLOR: "1" };
  delete environment.AGENTOS_RUN_ID;
  delete environment.AGENTOS_RUN_SCOPE_BYPASS;
  delete environment.AGENTOS_HOST_PROOF_SLOT_DIR;
  delete environment.AGENTOS_HOST_PROOF_SLOTS;
  return { ...environment, ...overrides };
};

const makeSlotDirectory = (count) => {
  const directory = join(testRoot, `slots-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(directory, { mode: 0o755 });
  for (let slot = 1; slot <= count; slot += 1) {
    writeFileSync(join(directory, `slot-${slot}.lock`), "", { mode: 0o666 });
  }
  return directory;
};

const makeCallerFixture = (name) => {
  const directory = mkdtempSync(join(tmpdir(), "host-proof-caller."));
  const script = join(directory, name);
  writeFileSync(script, "#!/usr/bin/env bash\nbash \"$@\" &\nchild=$!\nwait \"$child\"\nstatus=$?\nexit \"$status\"\n", { mode: 0o755 });
  chmodSync(script, 0o755);
  return { directory, script };
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// A child that publishes its admission as a marker file and then holds it,
// either for a fixed duration or — when a release path is given — until the test
// creates that file. The release form turns an overlap between concurrently
// admitted children into a condition the wrapper produced, instead of a window
// the test guessed: on the loaded gate worker (load1 20-55 observed, where a node or bash+git start alone can exceed 10s)
// a fixed window is a race the test loses rather than a property it checks.
// The hold is still bounded, so a release that never arrives ends the child and
// fails the overlap assertion instead of hanging the suite.
const MARKER_HOLD_LIMIT_MS = 120_000;

const commandThatMarksActive = [
  "const fs = require('node:fs');",
  "const marker = process.argv[1];",
  "const duration = Number(process.argv[2]);",
  "const status = Number(process.argv[3]);",
  "const release = process.argv[4];",
  `const limit = Date.now() + ${MARKER_HOLD_LIMIT_MS};`,
  "fs.writeFileSync(marker, 'active');",
  "const finish = () => { try { fs.unlinkSync(marker); } catch {} process.exit(status); };",
  "const holdUntilReleased = () => {",
  "  if (fs.existsSync(release) || Date.now() >= limit) finish();",
  "  else setTimeout(holdUntilReleased, 10);",
  "};",
  "if (release === '') setTimeout(finish, duration); else holdUntilReleased();",
].join(" ");

const markerCommand = (marker, duration = 100, status = 0, release = "") => [
  process.execPath,
  "-e",
  commandThatMarksActive,
  marker,
  String(duration),
  String(status),
  release,
];

const spawnWrapper = ({
  slotDirectory,
  slotCount,
  runId = "run-test",
  workspace = "@anneal/test",
  command,
  bypass,
  callerScript,
  toolsDirectory,
  detached = false,
}) => {
  const invocation = callerScript === undefined
    ? [wrapper, "test", workspace, "--", ...command]
    : [callerScript, wrapper, "test", workspace, "--", ...command];
  const child = spawn("bash", invocation, {
    cwd: repositoryRoot,
    detached,
    env: cleanEnvironment({
      AGENTOS_RUN_ID: runId,
      AGENTOS_HOST_PROOF_SLOT_DIR: slotDirectory,
      AGENTOS_HOST_PROOF_SLOTS: String(slotCount),
      ...(toolsDirectory === undefined ? {} : { AGENTOS_TOOLS: toolsDirectory }),
      ...(bypass === undefined ? {} : { AGENTOS_RUN_SCOPE_BYPASS: bypass }),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const promise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, promise, get closed() { return child.exitCode !== null || child.signalCode !== null; } };
};

test("the host fast path execs the child without touching a missing slot path", async () => {
  const missing = join(testRoot, "must-not-be-created");
  const marker = join(testRoot, "host-fast-path.marker");
  const command = [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ok')", marker];

  const host = spawn("bash", [wrapper, "build", "@anneal/test", "--", ...command], {
    cwd: repositoryRoot,
    env: cleanEnvironment({
      AGENTOS_HOST_PROOF_SLOT_DIR: missing,
      AGENTOS_HOST_PROOF_SLOTS: "not-a-count",
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let hostStdout = "";
  let hostStderr = "";
  host.stdout.setEncoding("utf8");
  host.stderr.setEncoding("utf8");
  host.stdout.on("data", (chunk) => { hostStdout += chunk; });
  host.stderr.on("data", (chunk) => { hostStderr += chunk; });
  const hostResult = await new Promise((resolve, reject) => {
    host.once("error", reject);
    host.once("close", (status, signal) => resolve({ status, signal }));
  });
  assert.equal(hostResult.status, 0);
  assert.equal(hostStdout, "");
  assert.equal(hostStderr, "");
  assert.equal(existsSync(marker), true);
  assert.equal(existsSync(missing), false);
});

test("the host fast path executes only builtins before exec", async () => {
  const missing = join(testRoot, "must-not-be-probed");
  const traceFastPath = async (environment) => {
    const child = spawn("bash", ["-x", wrapper, "build", "@anneal/test", "--", process.execPath, "-e", "process.exit(0)"], {
      cwd: repositoryRoot,
      env: cleanEnvironment({
        AGENTOS_HOST_PROOF_SLOT_DIR: missing,
        AGENTOS_HOST_PROOF_SLOTS: "not-a-count",
        ...environment,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let trace = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { trace += chunk; });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, signal }));
    });
    assert.deepEqual(result, { status: 0, signal: null });
    assert.equal(trace.includes(missing), false, "the fast path inspected the sentinel slot path");
    assert.match(trace, /^\+ \[\[ .* \]\]\n(?:\+ \[\[ .* \]\]\n)?\+ host_proof_slot_exec_child .*\n\+ shift 3\n\+ exec /u);
    assert.equal(existsSync(missing), false);
  };

  await traceFastPath({});
});

test("a forged Regression bypass takes the slot path and audits the caller command line", async (t) => {
  const caller = makeCallerFixture("forged-host-proof-bypass-caller.sh");
  t.after(() => rmSync(caller.directory, { recursive: true, force: true }));
  const missing = join(testRoot, "forged-bypass-slot-directory");
  const marker = join(testRoot, "forged-bypass-child.marker");
  t.after(() => rmSync(marker, { force: true }));

  const result = await spawnWrapper({
    slotDirectory: missing,
    slotCount: 1,
    runId: "run-forged-host-proof-bypass",
    bypass: "regression-verification",
    callerScript: caller.script,
    toolsDirectory: caller.directory,
    command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
  }).promise;
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    new RegExp(`host-proof-slot: test for workspace @anneal/test in Run run-forged-host-proof-bypass cannot admit: slot directory ${escapeRegExp(missing)} is not a non-symlink directory`, "u"),
  );
  assert.ok(
    result.stderr.split("\n").some((line) => line.includes(caller.script)),
    `forged bypass audit did not include caller command line: ${result.stderr}`,
  );
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(missing), false);
});

test("host-proof-slot accepts the bypass only for a regression-verification.sh ancestor under AGENTOS_TOOLS", async (t) => {
  const caller = makeCallerFixture("regression-verification.sh");
  t.after(() => rmSync(caller.directory, { recursive: true, force: true }));
  const missing = join(testRoot, "legitimate-bypass-slot-directory");
  const marker = join(testRoot, "legitimate-bypass-child.marker");
  t.after(() => rmSync(marker, { force: true }));
  const command = [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ok')", marker];

  const result = await spawnWrapper({
    slotDirectory: missing,
    slotCount: "also-not-a-count",
    runId: "run-legitimate-host-proof-bypass",
    bypass: "regression-verification",
    callerScript: caller.script,
    toolsDirectory: caller.directory,
    command,
  }).promise;
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(existsSync(marker), true);
  assert.equal(existsSync(missing), false);
});

test("a Run with absent, empty, or wrong bypass does not skip admission", async () => {
  const missing = join(testRoot, "ordinary-run-must-not-create");
  const marker = join(testRoot, "ordinary-run.marker");
  const command = [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker];

  for (const bypass of [undefined, "", "regression", "regression-verification "]) {
    rmSync(marker, { force: true });
    const result = await spawnWrapper({
      slotDirectory: missing,
      slotCount: 1,
      runId: "run-not-bypassed",
      bypass,
      command,
    }).promise;
    assert.notEqual(result.status, 0, `bypass ${String(bypass)} unexpectedly ran`);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `host-proof-slot: test for workspace @anneal/test in Run run-not-bypassed cannot admit: slot directory ${missing} is not a non-symlink directory\n`,
    );
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(missing), false);
  }
});

test("an ordinary Run rejects a slot count above the runner maximum", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const result = await spawnWrapper({
    slotDirectory,
    slotCount: 1025,
    runId: "run-too-many-slots",
    command: [process.execPath, "-e", "process.exit(0)"],
  }).promise;
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "host-proof-slot: test for workspace @anneal/test in Run run-too-many-slots cannot admit: AGENTOS_HOST_PROOF_SLOTS must be a positive integer no greater than 1024\n",
  );
});

test("the platform lock tool reports contention as exactly 75", { skip: platformLock === null }, () => {
  const slotDirectory = makeSlotDirectory(1);
  const slot = join(slotDirectory, "slot-1.lock");
  const first = openSync(slot, "r");
  const second = openSync(slot, "r");
  const stdioFor = (fd) => ["ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", fd];
  try {
    assert.equal(spawnSync(platformLock.executable, platformLock.args, { stdio: stdioFor(first) }).status, 0);
    assert.equal(spawnSync(platformLock.executable, platformLock.args, { stdio: stdioFor(second) }).status, 75);
  } finally {
    closeSync(first);
    closeSync(second);
  }
});

test("platform selection uses the host kernel rather than an inherited OSTYPE", { skip: platformName === null }, () => {
  const forgedOsType = process.platform === "darwin" ? "linux-gnu" : "darwin99";
  const sourceHarness = ['. "$1"', "host_proof_slot_set_platform", 'printf "%s\\n" "$HOST_PROOF_SLOT_PLATFORM"'].join("; ");
  const result = spawnSync("bash", ["-c", sourceHarness, "source-host-proof-slot", wrapper], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: cleanEnvironment({ AGENTOS_RUN_ID: "run-platform-kernel", OSTYPE: forgedOsType }),
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${platformName}\n`);
  assert.equal(result.stderr, "");
});

test("the selected platform lock tool is required by name", () => {
  const slotDirectory = makeSlotDirectory(1);
  const missingTool = join(testRoot, "missing-lock-tool");
  const sourceHarness = [
    '. "$1"',
    'HOST_PROOF_SLOT_TEST_LOCK_TOOL="$3"',
    'host_proof_slot_select_lock_tool() { HOST_PROOF_SLOT_LOCK_TOOL="$HOST_PROOF_SLOT_TEST_LOCK_TOOL"; HOST_PROOF_SLOT_LOCK_ARGS=(); }',
    'host_proof_slot_main test @anneal/missing-tool -- "$2" -e "process.exit(0)"',
  ].join("; ");
  const result = spawnSync("bash", ["-c", sourceHarness, "source-host-proof-slot", wrapper, process.execPath, missingTool], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: cleanEnvironment({
      AGENTOS_RUN_ID: "run-missing-tool",
      AGENTOS_HOST_PROOF_SLOT_DIR: slotDirectory,
      AGENTOS_HOST_PROOF_SLOTS: "1",
    }),
  });
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    `host-proof-slot: test for workspace @anneal/missing-tool in Run run-missing-tool cannot admit: ${missingTool} is not executable\n`,
  );
});

test("an unrecognised platform is refused by name", () => {
  const slotDirectory = makeSlotDirectory(1);
  const sourceHarness = [
    '. "$1"',
    "host_proof_slot_set_platform() { HOST_PROOF_SLOT_PLATFORM=Plan9; }",
    'host_proof_slot_main test @anneal/unknown-platform -- "$2" -e "process.exit(0)"',
  ].join("; ");
  const result = spawnSync("bash", ["-c", sourceHarness, "source-host-proof-slot", wrapper, process.execPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: cleanEnvironment({
      AGENTOS_RUN_ID: "run-unknown-platform",
      AGENTOS_HOST_PROOF_SLOT_DIR: slotDirectory,
      AGENTOS_HOST_PROOF_SLOTS: "1",
    }),
  });
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "host-proof-slot: test for workspace @anneal/unknown-platform in Run run-unknown-platform cannot admit: platform Plan9 is not supported\n",
  );
});

test("the acquired slot spans the child and preserves every child status, including 75", async () => {
  const slotDirectory = makeSlotDirectory(1);
  for (const status of [0, 37, 75]) {
    const result = await spawnWrapper({
      slotDirectory,
      slotCount: 1,
      runId: `run-status-${status}`,
      command: [process.execPath, "-e", `process.exit(${status})`],
    }).promise;
    assert.equal(result.status, status);
    assert.equal(result.signal, null);
  }
});

test("a signal-terminated child terminates the wrapper by the same signal and releases the slot", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const result = await spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-signal",
    command: ["/bin/sh", "-c", "kill -TERM $$"],
  }).promise;
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGTERM");

  const successor = await spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-after-signal",
    command: [process.execPath, "-e", "process.exit(0)"],
  }).promise;
  assert.equal(successor.status, 0);
});

test("a background grandchild cannot inherit and pin the acquired slot", async () => {
  // The property is that the successor was not blocked by the orphan's hold, so
  // what has to be true is a gap between the two, not a small absolute number.
  // Widening the gap rather than the ceiling is what makes this survive
  // the loaded gate worker (load1 20-55 observed, where a node or bash+git start alone can exceed 10s): the successor's
  // own node start can eat a bare one-second ceiling on its own. The ceiling
  // stays far below the hold, so a retained slot descriptor still fails here,
  // and both stay bounded.
  const orphanHoldSeconds = 30;
  const successorCeilingMs = 15_000;
  const slotDirectory = makeSlotDirectory(1);
  const orphaning = await spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-orphaning",
    command: ["/bin/sh", "-c", `/bin/sleep ${orphanHoldSeconds} </dev/null >/dev/null 2>&1 &`],
  }).promise;
  assert.equal(orphaning.status, 0);

  const startedAt = Date.now();
  const successor = await spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-after-orphan",
    command: [process.execPath, "-e", "process.exit(0)"],
  }).promise;
  assert.equal(successor.status, 0);
  assert.ok(
    Date.now() - startedAt < successorCeilingMs,
    "an orphaned descendant retained the slot descriptor",
  );
});

test("N+1 Runs share N slots while retaining each command's exit status", async () => {
  const slotCount = 2;
  const slotDirectory = makeSlotDirectory(slotCount);
  const activeDirectory = join(testRoot, "active-concurrency");
  mkdirSync(activeDirectory);
  const release = join(testRoot, "release-concurrency");
  const statuses = [0, 17, 23];
  const jobs = statuses.map((status, index) => spawnWrapper({
    slotDirectory,
    slotCount,
    runId: `run-concurrent-${index}`,
    workspace: `@anneal/workspace-${index}`,
    command: markerCommand(join(activeDirectory, `child-${index}`), 0, status, release),
  }));

  let maximumActive = 0;
  while (jobs.some((job) => !job.closed)) {
    maximumActive = Math.max(maximumActive, readdirSync(activeDirectory).length);
    // Every admitted child holds its marker until this file appears, so the
    // overlap the assertion below reads is one the wrapper actually produced.
    // Releasing only once the slot count is reached also lets the third Run in:
    // it needs one of the two slots back.
    if (maximumActive >= slotCount && !existsSync(release)) writeFileSync(release, "");
    await delay(10);
  }
  const results = await Promise.all(jobs.map((job) => job.promise));
  maximumActive = Math.max(maximumActive, readdirSync(activeDirectory).length);
  assert.equal(maximumActive, slotCount);
  assert.deepEqual(results.map((result) => result.status), statuses);
  assert.deepEqual(results.map((result) => result.stdout), ["", "", ""]);
  assert.deepEqual(results.map((result) => result.stderr), ["", "", ""]);
});

test("two simultaneous admissions never coexist in a one-slot directory", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const activeDirectory = join(testRoot, "exclusive-concurrency");
  mkdirSync(activeDirectory);
  const jobs = [0, 1].map((index) => spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: `run-exclusive-${index}`,
    command: markerCommand(join(activeDirectory, `child-${index}`), 300),
  }));

  let maximumActive = 0;
  while (jobs.some((job) => !job.closed)) {
    maximumActive = Math.max(maximumActive, readdirSync(activeDirectory).length);
    await delay(10);
  }
  const results = await Promise.all(jobs.map((job) => job.promise));
  assert.equal(maximumActive, 1);
  assert.deepEqual(results.map((result) => result.status), [0, 0]);
});

test("a source-only clock and wait seam reaches the 1,200-second timeout without running the child", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const holderMarker = join(testRoot, "timeout-holder");
  const childMarker = join(testRoot, "timeout-child");
  const holder = spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-timeout-holder",
    command: markerCommand(holderMarker, 10_000),
    detached: true,
  });
  await waitFor(() => existsSync(holderMarker));

  const sourceHarness = [
    '. "$1"',
    "fake_now=0",
    "host_proof_slot_set_now() { HOST_PROOF_SLOT_NOW=$fake_now; }",
    "host_proof_slot_wait() { fake_now=1200; }",
    'host_proof_slot_main test @anneal/timeout -- "$2" "$3" "$4" "$5"',
  ].join("; ");
  const timeout = spawn("bash", ["-c", sourceHarness, "source-host-proof-slot", wrapper, process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", childMarker], {
    cwd: repositoryRoot,
    env: cleanEnvironment({
      AGENTOS_RUN_ID: "run-timeout",
      AGENTOS_HOST_PROOF_SLOT_DIR: slotDirectory,
      AGENTOS_HOST_PROOF_SLOTS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  timeout.stdout.setEncoding("utf8");
  timeout.stderr.setEncoding("utf8");
  timeout.stdout.on("data", (chunk) => { stdout += chunk; });
  timeout.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    timeout.once("error", reject);
    timeout.once("close", (status, signal) => resolve({ status, signal }));
  });

  assert.equal(result.status, 75);
  assert.equal(result.signal, null);
  assert.equal(stdout, "");
  assert.equal(
    stderr,
    `host-proof-slot: test for workspace @anneal/timeout in Run run-timeout timed out after 1200s waiting in ${slotDirectory}\n`,
  );
  assert.equal(existsSync(childMarker), false);

  process.kill(-holder.child.pid, "SIGTERM");
  await holder.promise;
});

test("a wait of 60 seconds or more is reported once while waiting and again on admission", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const holderMarker = join(testRoot, "wait-report-holder");
  const childMarker = join(testRoot, "wait-report-child");
  const holder = spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-wait-report-holder",
    command: markerCommand(holderMarker, 10_000),
    detached: true,
  });
  await waitFor(() => existsSync(holderMarker));

  // First wait: 61 s elapsed, holder still live, so the next scan fails and
  // reports the wait once. Second wait: 122 s elapsed and the holder is gone,
  // so the next scan admits and reports the total.
  const sourceHarness = [
    '. "$1"',
    "fake_now=0",
    "fake_waits=0",
    'holder_pid="$6"',
    "host_proof_slot_set_now() { HOST_PROOF_SLOT_NOW=$fake_now; }",
    "host_proof_slot_wait() { fake_waits=$((fake_waits + 1)); fake_now=$((fake_now + 61)); if (( fake_waits == 2 )); then kill -TERM -- \"-$holder_pid\"; /bin/sleep 0.5; fi; }",
    'host_proof_slot_main test @anneal/wait-report -- "$2" "$3" "$4" "$5"',
  ].join("; ");
  const waiter = spawn("bash", ["-c", sourceHarness, "source-host-proof-slot", wrapper, process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", childMarker, String(holder.child.pid)], {
    cwd: repositoryRoot,
    env: cleanEnvironment({
      AGENTOS_RUN_ID: "run-wait-report",
      AGENTOS_HOST_PROOF_SLOT_DIR: slotDirectory,
      AGENTOS_HOST_PROOF_SLOTS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  waiter.stdout.setEncoding("utf8");
  waiter.stderr.setEncoding("utf8");
  waiter.stdout.on("data", (chunk) => { stdout += chunk; });
  waiter.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    waiter.once("error", reject);
    waiter.once("close", (status, signal) => resolve({ status, signal }));
  });
  await holder.promise;

  assert.deepEqual(result, { status: 0, signal: null });
  assert.equal(stdout, "");
  assert.equal(
    stderr,
    `host-proof-slot: test for workspace @anneal/wait-report in Run run-wait-report has waited 61s for a slot in ${slotDirectory}\n`
    + `host-proof-slot: test for workspace @anneal/wait-report in Run run-wait-report admitted after 122s waiting in ${slotDirectory}\n`,
  );
  assert.equal(readFileSync(childMarker, "utf8"), "ran");
});

test("the source-only clock seam enforces the timeout while scanning slots", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const childMarker = join(testRoot, "inner-timeout-child");
  const sourceHarness = [
    '. "$1"',
    "fake_calls=0",
    "host_proof_slot_set_now() { fake_calls=$((fake_calls + 1)); if (( fake_calls >= 3 )); then HOST_PROOF_SLOT_NOW=1200; else HOST_PROOF_SLOT_NOW=0; fi; }",
    'host_proof_slot_main test @anneal/inner-timeout -- "$2" "$3" "$4" "$5"',
  ].join("; ");
  const timeout = spawn("bash", ["-c", sourceHarness, "source-host-proof-slot", wrapper, process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", childMarker], {
    cwd: repositoryRoot,
    env: cleanEnvironment({
      AGENTOS_RUN_ID: "run-inner-timeout",
      AGENTOS_HOST_PROOF_SLOT_DIR: slotDirectory,
      AGENTOS_HOST_PROOF_SLOTS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  timeout.stdout.setEncoding("utf8");
  timeout.stderr.setEncoding("utf8");
  timeout.stdout.on("data", (chunk) => { stdout += chunk; });
  timeout.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    timeout.once("error", reject);
    timeout.once("close", (status, signal) => resolve({ status, signal }));
  });

  assert.deepEqual(result, { status: 75, signal: null });
  assert.equal(stdout, "");
  assert.equal(
    stderr,
    `host-proof-slot: test for workspace @anneal/inner-timeout in Run run-inner-timeout timed out after 1200s waiting in ${slotDirectory}\n`,
  );
  assert.equal(existsSync(childMarker), false);
});

test("a killed holder releases its descriptor, while a live holder is never reclaimed", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const holderMarker = join(testRoot, "stale-holder");
  const waiterMarker = join(testRoot, "stale-waiter");
  const holder = spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-live-holder",
    command: markerCommand(holderMarker, 10_000),
    detached: true,
  });
  await waitFor(() => existsSync(holderMarker));

  const waiter = spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-waiter",
    command: markerCommand(waiterMarker, 50),
  });
  await delay(300);
  assert.equal(waiter.closed, false, "a live holder was reclaimed");
  assert.equal(existsSync(waiterMarker), false);

  process.kill(-holder.child.pid, "SIGTERM");
  await holder.promise;
  const waiterResult = await waiter.promise;
  assert.equal(waiterResult.status, 0);
  assert.equal(waiterResult.stdout, "");
  assert.equal(waiterResult.stderr, "");
});

const RUN_TEST_CONCURRENCY_CAP = "${AGENTOS_RUN_ID:+--test-concurrency=2}";

test("the Run-only test concurrency cap expands under a Run and vanishes on the host fast path", async () => {
  const command = ["/bin/sh", "-c", `printf '%s\\n' --test ${RUN_TEST_CONCURRENCY_CAP} src/*.test.ts`];
  const slotDirectory = makeSlotDirectory(1);
  const run = await spawnWrapper({ slotDirectory, slotCount: 1, command }).promise;
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "--test\n--test-concurrency=2\nsrc/*.test.ts\n");

  const host = spawn("bash", [wrapper, "test", "@anneal/test", "--", ...command], {
    cwd: repositoryRoot,
    env: cleanEnvironment({}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  host.stdout.setEncoding("utf8");
  host.stdout.on("data", (chunk) => { stdout += chunk; });
  const status = await new Promise((resolve) => host.once("close", resolve));
  assert.equal(status, 0);
  assert.equal(stdout, "--test\nsrc/*.test.ts\n");
});

test("all workspace proof manifests are wrapped exactly once without changing commands or lifecycle hooks", () => {
  const expected = {
    "apps/web/package.json": {
      name: "@anneal/web",
      scripts: {
        build: "/bin/sh -c 'tsc -b && vite build'",
        typecheck: "tsc -b --pretty false",
        lint: "/bin/sh -c 'biome lint . && eslint .'",
        test: "/bin/sh -c 'TSX_TSCONFIG_PATH=tsconfig.app.json node --conditions=development --import tsx --test ${AGENTOS_RUN_ID:+--test-concurrency=2} \"src/**/*.test.ts\" \"src/**/*.test.tsx\"'",
      },
      hooks: {},
    },
    "packages/api/package.json": {
      name: "@anneal/api",
      scripts: {
        build: "/bin/sh -c 'tsc -p tsconfig.json && node ../build-info/stamp.mjs dist'",
        typecheck: "tsc -p tsconfig.json --noEmit",
        lint: "/bin/sh -c 'biome lint . && eslint .'",
        test: "node --conditions=development --import tsx --test ${AGENTOS_RUN_ID:+--test-concurrency=2} src/*.test.ts src/routes/*.test.ts src/files/*.test.ts",
        "test:db": "node --conditions=development --import tsx scripts/dbtest.mjs",
      },
      hooks: {},
    },
    "packages/build-info/package.json": {
      name: "@anneal/build-info",
      scripts: {
        lint: "/bin/sh -c 'biome lint . && eslint .'",
        test: "node --conditions=development --test ${AGENTOS_RUN_ID:+--test-concurrency=2} *.test.mjs",
      },
      hooks: {},
    },
    "packages/db/package.json": {
      name: "@anneal/db",
      scripts: {
        build: "tsc -p tsconfig.json",
        typecheck: "/bin/sh -c 'tsc -p tsconfig.json --noEmit && npm run typecheck:cli'",
        lint: "/bin/sh -c 'biome lint . && eslint .'",
        test: "node --conditions=development --import tsx --test ${AGENTOS_RUN_ID:+--test-concurrency=2} prisma/*.test.ts src/*.test.ts",
        "test:db": "node --conditions=development --import tsx --test --test-concurrency=1 src/*.dbtest.ts",
      },
      hooks: {},
    },
    "packages/github-client/package.json": {
      name: "@anneal/github-client",
      scripts: {
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        lint: "/bin/sh -c 'biome lint . && eslint .'",
        test: "node --conditions=development --import tsx --test ${AGENTOS_RUN_ID:+--test-concurrency=2} src/*.test.ts",
      },
      hooks: {},
    },
    "packages/inbox/package.json": {
      name: "@anneal/inbox",
      scripts: {
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        lint: "/bin/sh -c 'biome lint . && eslint .'",
        test: "node --conditions=development --import tsx --test ${AGENTOS_RUN_ID:+--test-concurrency=2} src/*.test.ts",
      },
      hooks: {},
    },
    "packages/merge-executor/package.json": {
      name: "@anneal/merge-executor",
      scripts: {
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        lint: "/bin/sh -c 'biome lint . && eslint .'",
        test: "node --conditions=development --import tsx --test ${AGENTOS_RUN_ID:+--test-concurrency=2} src/*.test.ts",
      },
      hooks: {},
    },
    "packages/runner/package.json": {
      name: "@anneal/runner",
      scripts: {
        build: "/bin/sh -c 'tsc -p tsconfig.json && node scripts/build-runtime-tools.mjs && node ../build-info/stamp.mjs dist'",
        typecheck: "tsc -p tsconfig.json --noEmit",
        lint: "/bin/sh -c 'biome lint . && eslint .'",
        test: "node --conditions=development --import tsx --test ${AGENTOS_RUN_ID:+--test-concurrency=2} src/*.test.ts src/adapters/*.test.ts scripts/*.test.mjs",
      },
      hooks: {},
    },
  };

  const proofNames = new Set(["build", "typecheck", "lint", "test", "test:db"]);
  let wrappedCount = 0;
  for (const [relativePath, contract] of Object.entries(expected)) {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, relativePath), "utf8"));
    assert.equal(manifest.name, contract.name);
    assert.equal("lint" in manifest.scripts, true, `${contract.name} is missing lint`);
    if ("start" in manifest.scripts) {
      assert.doesNotMatch(
        manifest.scripts.start,
        /--conditions(?:=|\s+)development/u,
        `${contract.name} production start selected development exports`,
      );
    }
    assert.deepEqual(
      Object.keys(manifest.scripts).filter((name) => proofNames.has(name)).sort(),
      Object.keys(contract.scripts).sort(),
      `${contract.name} changed the exact proof-script surface`,
    );
    for (const [scriptName, innerCommand] of Object.entries(contract.scripts)) {
      const prefix = `bash ../../scripts/host-proof-slot.sh ${scriptName} ${contract.name} -- `;
      assert.equal(manifest.scripts[scriptName], `${prefix}${innerCommand}`);
      assert.equal(manifest.scripts[scriptName].split("scripts/host-proof-slot.sh").length - 1, 1);
      assert.equal(
        manifest.scripts[scriptName].split(RUN_TEST_CONCURRENCY_CAP).length - 1,
        scriptName === "test" ? 1 : 0,
        `${contract.name} ${scriptName} must carry the Run-only test concurrency cap exactly when it is the unit test script`,
      );
      wrappedCount += 1;
    }
    for (const [hookName, command] of Object.entries(contract.hooks)) {
      assert.equal(manifest.scripts[hookName], command, `${contract.name} changed ${hookName}`);
      assert.equal(manifest.scripts[hookName].includes("host-proof-slot.sh"), false);
    }
  }
  assert.equal(wrappedCount, 32);
});

test("Runner child fixtures keep their audited development-condition counts", () => {
  const audits = [
    {
      path: "packages/runner/src/regression-verification-script.test.ts",
      execPathReferences: 1,
      developmentConditions: 0,
      childMarker: "REGRESSION_FIXTURE_NODE: process.execPath",
    },
    {
      path: "packages/runner/src/adapters.test.ts",
      execPathReferences: 7,
      developmentConditions: 0,
      childMarker: 'runAsPrefix: [process.execPath, "-e", stubScript]',
    },
    {
      path: "packages/runner/src/run-output.test.ts",
      execPathReferences: 1,
      developmentConditions: 1,
      childMarker: "pathToFileURL(fileURLToPath(new URL(\"./mcp-server.ts\", import.meta.url))).href",
    },
  ];

  for (const audit of audits) {
    const source = readFileSync(join(repositoryRoot, audit.path), "utf8");
    assert.equal(
      source.match(/process\.execPath/gu)?.length ?? 0,
      audit.execPathReferences,
      `${audit.path} added or removed a Node child; audit its transitive graph and select development exports if it reaches repository source`,
    );
    assert.match(source, new RegExp(audit.childMarker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.equal(
      source.match(/--conditions=development/gu)?.length ?? 0,
      audit.developmentConditions,
      `${audit.path} changed the audited child condition count`,
    );
  }
});
