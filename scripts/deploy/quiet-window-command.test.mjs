import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { runDeployCommand } from "./quiet-window-command.mjs";
import { DeployFailure } from "./quiet-window-lib.mjs";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// Reaping a signalled descendant is the kernel's work plus a scheduler slice.
// Bounded so a survivor still fails the assertion below rather than hanging the
// suite, but sized for the loaded gate worker (load1 20-55 observed, where a node or bash+git start alone can exceed 10s), not for an idle host.
const waitForDeath = async (pid) => {
  for (let waited = 0; waited < 10_000; waited += 20) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

test("deploy command returns captured output before its step deadline", async () => {
  const result = await runDeployCommand("/bin/sh", ["-c", "printf ok; printf warning >&2"], {
    cwd: process.cwd(),
    env,
    capture: true,
    timeoutMs: 1_000,
    timeoutReason: "fixture-timeout",
  });
  assert.deepEqual(result, { code: 0, signal: null, stdout: "ok", stderr: "warning" });
});

test("deploy command requires an explicit step budget and timeout reason", () => {
  assert.throws(() => runDeployCommand("/bin/true", [], {}), /deploy-command-timeout-required/u);
  assert.throws(
    () => runDeployCommand("/bin/true", [], { timeoutMs: 1 }),
    /deploy-command-timeout-reason-required/u,
  );
});

test("timeout sends TERM then KILL and rejects with the step-specific DeployFailure", async () => {
  const started = performance.now();
  const terminations = [];
  const error = await runDeployCommand("/bin/sh", ["-c", "trap '' TERM; exec sleep 30"], {
    cwd: process.cwd(),
    env,
    timeoutMs: 40,
    timeoutReason: "fixture-step-timeout",
    killGraceMs: 50,
    onTermination: (failure, signal) => { terminations.push({ reason: failure.reason, signal }); },
  }).then(() => null, (reason) => reason);
  const elapsed = performance.now() - started;
  assert.ok(error instanceof DeployFailure);
  assert.equal(error.reason, "fixture-step-timeout");
  assert.equal(error.detail, "program-sh-timeout-40ms");
  assert.ok(elapsed >= 80, `expected the TERM grace to elapse, took ${elapsed}ms`);
  assert.ok(elapsed < 500, `expected KILL to settle promptly, took ${elapsed}ms`);
  assert.deepEqual(terminations, [{ reason: "fixture-step-timeout", signal: "SIGTERM" }]);
});

test("timeout kills descendants even when the process-group leader exits first", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anneal-deploy-command-"));
  const pidFile = join(directory, "descendant.pid");
  try {
    const script = `( trap '' TERM; exec sleep 30 ) >/dev/null 2>&1 </dev/null & echo $! > "$1"; wait`;
    const error = await runDeployCommand("/bin/sh", ["-c", script, "fixture", pidFile], {
      cwd: directory,
      env,
      // Not a deadline under test: this is the race budget for /bin/sh to fork
      // the descendant and write its pid before the timeout path is exercised.
      // Bounded so the timeout still fires and the case still runs, but sized for
      // the loaded gate worker (load1 20-55 observed, where a node or bash+git start alone can exceed 10s), not for an idle host.
      timeoutMs: 5_000,
      timeoutReason: "fixture-tree-timeout",
      killGraceMs: 50,
    }).then(() => null, (reason) => reason);
    assert.ok(error instanceof DeployFailure);
    assert.equal(error.reason, "fixture-tree-timeout");
    const descendant = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    assert.equal(await waitForDeath(descendant), true, "timed-out descendant survived the process-group kill");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
