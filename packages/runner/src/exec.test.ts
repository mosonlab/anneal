import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  bindCommandRunner, commandRunnerIn, CommandTimeoutError, KILL_GRACE_MS, platformCommitArgs, runCommand,
} from "./exec.js";
import { isTransientNetworkError } from "./network-retry.js";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

test("platformCommitArgs centralizes the runner commit identity and optional pathspec", () => {
  assert.deepEqual(platformCommitArgs("Materialize direct-chain specification", ".chain/feature/spec.md"), [
    "-c", "user.name=Anneal Runner",
    "-c", "user.email=runner@agentos.local",
    "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "--no-verify", "-m", "Materialize direct-chain specification", "--", ".chain/feature/spec.md",
  ]);
  assert.deepEqual(platformCommitArgs("WIP salvage"), [
    "-c", "user.name=Anneal Runner",
    "-c", "user.email=runner@agentos.local",
    "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "--no-verify", "-m", "WIP salvage",
  ]);
});

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Bounded so a descendant that is never reaped fails the test instead of
 *  hanging the gate, but sized for the loaded gate worker rather than an idle
 *  laptop (CONTRIBUTING.md, "Test timing"): signal delivery, reaping and the
 *  poll's own scheduling all queue behind the load. The loop
 *  returns the moment the pid is gone, so a green run never pays this. */
const DESCENDANT_DEATH_BUDGET_MS = 30_000;

const waitForDeath = async (pid: number): Promise<boolean> => {
  for (let waited = 0; waited < DESCENDANT_DEATH_BUDGET_MS; waited += 25) {
    if (!alive(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

test("a hung command is timed out and its whole process group dies with it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-exec-timeout-"));
  try {
    const pidFile = join(directory, "child.pid");
    // The background `sleep` stands in for the helpers a real `git clone`
    // forks (git-remote-https, ssh): killing only the direct child would leave
    // it running inside a workspace the runner is about to delete.
    const script = `sleep 30 & echo $! > ${pidFile}; wait`;
    const error = await runCommand([], "/bin/sh", ["-c", script], directory, env, { timeoutMs: 300 })
      .then(() => null, (reason: unknown) => reason);
    assert.ok(error instanceof Error);
    assert.match(error.message, /timed out after 300ms/);
    // The whole point of the wording: a hung command must re-enter the
    // existing transient retry path instead of failing the run outright.
    assert.equal(isTransientNetworkError(error), true);
    const descendant = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    assert.ok(Number.isInteger(descendant));
    assert.equal(await waitForDeath(descendant), true, "descendant of the timed-out command was orphaned");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a command that ignores SIGTERM is escalated to SIGKILL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-exec-sigkill-"));
  try {
    // `exec` keeps the ignored SIGTERM disposition across the exec, so the
    // entire group survives the polite signal and only SIGKILL ends it.
    // The timeout implementation uses Node's monotonic timers. Measure it with
    // the same kind of clock: VM wall-clock synchronisation may move Date.now()
    // backwards while the SIGTERM grace is elapsing.
    const started = performance.now();
    const error = await runCommand([], "/bin/sh", ["-c", "trap '' TERM; exec sleep 30"], directory, env, { timeoutMs: 300 })
      .then(() => null, (reason: unknown) => reason);
    const elapsed = performance.now() - started;
    assert.ok(error instanceof Error);
    assert.match(error.message, /timed out after 300ms/);
    assert.ok(elapsed >= 300 + KILL_GRACE_MS, `expected the SIGTERM grace to elapse, took ${elapsed}ms`);
    // The floor above and the CommandTimeoutError match are the property. This
    // ceiling only catches a SIGKILL that never lands, so it gets the same
    // loaded-worker slack as DESCENDANT_DEATH_BUDGET_MS above rather than a
    // small multiple of the grace, which measures the host.
    assert.ok(
      elapsed < 300 + KILL_GRACE_MS + DESCENDANT_DEATH_BUDGET_MS,
      `expected SIGKILL to end it, took ${elapsed}ms`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a command without a timeout is never killed for being slow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-exec-untimed-"));
  try {
    const output = await runCommand([], "/bin/sh", ["-c", "sleep 0.4; echo finished"], directory, env);
    assert.equal(output, "finished");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an ordinary failure keeps the message shape delivery classifies on", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-exec-failure-"));
  try {
    const error = await runCommand([], "/bin/sh", ["-c", "echo 'remote: Permission denied' >&2; exit 128"], directory, env, { timeoutMs: 5_000 })
      .then(() => null, (reason: unknown) => reason);
    assert.ok(error instanceof Error);
    assert.equal(error.message, "/bin/sh failed (128): remote: Permission denied");
    assert.equal(isTransientNetworkError(error), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a descendant that ignores SIGTERM is killed even when the group leader exits first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-exec-orphan-"));
  try {
    const pidFile = join(directory, "descendant.pid");
    // The branch a naive "clear every timer once the promise settles" misses:
    // the leader obeys SIGTERM and exits, the descendant ignores it *and* has
    // redirected the inherited pipes, so the direct child's `close` fires
    // first. If that cancelled the pending group SIGKILL, the descendant would
    // outlive the runner's workspace.
    const script = `( trap '' TERM; exec sleep 30 ) >/dev/null 2>&1 </dev/null & echo $! > ${pidFile}; wait`;
    const error = await runCommand([], "/bin/sh", ["-c", script], directory, env, { timeoutMs: 300 })
      .then(() => null, (reason: unknown) => reason);
    assert.ok(error instanceof Error);
    assert.match(error.message, /timed out after 300ms/);
    const descendant = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    assert.ok(Number.isInteger(descendant));
    assert.equal(await waitForDeath(descendant), true, "SIGTERM-ignoring descendant survived the group kill");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the runner's own CLI preflight timeout is not mistaken for a network timeout", async () => {
  // adapters.ts:capture emits this exact string for a local binary that never
  // answers `--version`. It predates this module and means "the CLI is broken",
  // not "the network blinked"; a text-matching classifier would make a missing
  // binary look retryable.
  assert.equal(isTransientNetworkError("preflight timed out after 30 seconds"), false);
  assert.equal(isTransientNetworkError(new Error("claude failed (1): \npreflight timed out after 30 seconds")), false);
  // Ours is recognised by type, not by wording.
  assert.equal(isTransientNetworkError(new CommandTimeoutError("git", ["push"], 20_000)), true);
});

test("fetch transport failures are classified as transient", () => {
  assert.equal(isTransientNetworkError(new TypeError("fetch failed")), true);
});

test("a bound runner carries the run-as prefix, its directory and its environment into every call", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentos-bound-runner-")));
  try {
    const nested = join(root, "nested");
    await mkdir(nested);
    const log = join(root, "launcher.log");
    const launcher = join(root, "launcher.sh");
    // Records the two prefix arguments it was handed, then becomes the command.
    // A call that bypassed the prefix would leave the log one entry short.
    await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$1" "$2" >> ${log}\nshift 2\nexec "$@"\n`);
    await chmod(launcher, 0o755);
    const probe = ["-c", 'printf "%s|%s|%s" "$(pwd -P)" "$MARK" "${EXTRA-}"'];
    const run = bindCommandRunner([launcher, "--account", "agent-runner"], root, { ...env, MARK: "bound" });

    assert.equal(await run("/bin/sh", probe), `${root}|bound|`);
    // The per-call directory covers a command that belongs in a subdirectory;
    // the per-call environment covers addressing git by GIT_DIR.
    assert.equal(await run("/bin/sh", probe, { cwd: nested }), `${nested}|bound|`);
    assert.equal(await run("/bin/sh", probe, { env: { EXTRA: "merged" } }), `${root}|bound|merged`);

    const inNested = commandRunnerIn(run, nested);
    assert.equal(await inNested("/bin/sh", probe), `${nested}|bound|`);
    assert.equal(await inNested("/bin/sh", probe, { cwd: root }), `${root}|bound|`);

    assert.deepEqual(
      (await readFile(log, "utf8")).trimEnd().split("\n"),
      Array.from({ length: 5 }, () => ["--account", "agent-runner"]).flat(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
