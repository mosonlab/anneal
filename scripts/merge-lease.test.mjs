// Fixtures for the global merge lease in scripts/merge-lease.sh.
//
// The lease is the origin-backed lock that serialises the merge window on main:
// mutual exclusion, release, status, the machine and human steal boundaries, and
// compare-and-swap under concurrent steal attempts. These cases use a local bare
// origin so they test Git's real ref-update behavior without reaching a hosted
// repository.
//
// This file is the lease's whole specification. It lived inside the gate
// dispatcher's fixtures until 2026-08-26, where the lease had no name of its own
// and the dispatcher — which does not call it — appeared to own it.
//
// The lines these cases match are a contract, not incidental text: the operator
// reads the prose and packages/api/src/merge-lease.ts reads the `MERGE LEASE:`
// line beside it. Both come out of one function in the script so they cannot
// disagree; a case that asserts one asserts the other.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mergeLeasePath = join(here, "merge-lease.sh");

const test = (name, body) => nodeTest(name, { concurrency: true }, body);

// The script reads its poll interval, its timeout and its holder out of the
// environment, so a session that exports any of them would run these cases
// against the host's settings instead of the ones each case declares. The
// host's Git identity is neutralised for the same reason.
const hostNeutralEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("MERGE_LEASE_")),
);

const FIXTURE_ENV = {
  ...hostNeutralEnv,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "merge-lease-fixture",
  GIT_AUTHOR_EMAIL: "merge-lease-fixture",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "merge-lease-fixture",
  GIT_COMMITTER_EMAIL: "merge-lease-fixture",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

const scratch = (t) => {
  const root = mkdtempSync(join(tmpdir(), "merge-lease-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};


const leaseFixture = (t) => {
  const parent = scratch(t);
  const origin = join(parent, "origin.git");
  const root = join(parent, "source");
  execFileSync("git", ["init", "-q", "--bare", origin], { env: FIXTURE_ENV });
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(mergeLeasePath, join(root, "scripts", "merge-lease.sh"));
  chmodSync(join(root, "scripts", "merge-lease.sh"), 0o755);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: FIXTURE_ENV });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: root, env: FIXTURE_ENV });
  return { root, origin };
};

const runLease = (fixture, args, holder = "machine@fixture", options = {}) =>
  spawnSync("bash", [join(fixture.root, "scripts", "merge-lease.sh"), ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    // merge-lease.sh does real git work against a real origin. Bounded so a
    // wedged lease still fails the case; the default matches the cases that
    // already opt in, and is sized for the loaded gate worker, not for an idle host (CONTRIBUTING.md, "Test timing on the gate worker").
    timeout: options.timeout ?? 60_000,
    env: { ...FIXTURE_ENV, MERGE_LEASE_HOLDER: holder, ...options.env },
  });

// A `git` that fails a chosen subcommand a chosen number of times and then
// stands aside. The retry budget is only observable through what git says, so
// the cases below drive the classifier with git's own transient and
// deterministic wording rather than with a flag on the script.
const gitShim = (t, fixture) => {
  const bin = join(dirname(fixture.root), `shim-${Math.random().toString(16).slice(2)}`);
  mkdirSync(bin, { recursive: true });
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = join(bin, "calls.log");
  writeFileSync(log, "");
  const shimPath = join(bin, "git");
  writeFileSync(shimPath, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "$LEASE_FIXTURE_SUBCOMMAND" ]; then
    attempt=$(( $(wc -l < "$LEASE_FIXTURE_LOG") + 1 ))
    printf '%s\\n' "$arg" >> "$LEASE_FIXTURE_LOG"
    if [ "$attempt" -le "$LEASE_FIXTURE_FAILURES" ]; then
      printf '%s\\n' "$LEASE_FIXTURE_ERROR" >&2
      exit 128
    fi
    break
  fi
done
exec "$LEASE_FIXTURE_GIT" "$@"
`);
  chmodSync(shimPath, 0o755);
  const realGit = execFileSync("/usr/bin/env", ["sh", "-c", "command -v git"], { encoding: "utf8" }).trim();
  return {
    log,
    calls: () => readFileSync(log, "utf8").split("\n").filter((line) => line !== "").length,
    env: (subcommand, failures, error) => ({
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      LEASE_FIXTURE_GIT: realGit,
      LEASE_FIXTURE_LOG: log,
      LEASE_FIXTURE_SUBCOMMAND: subcommand,
      LEASE_FIXTURE_FAILURES: String(failures),
      LEASE_FIXTURE_ERROR: error,
    }),
  };
};

const TRANSIENT_GIT_ERROR =
  "fatal: unable to access 'https://github.com/o/r.git/': LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443";
const DETERMINISTIC_GIT_ERROR =
  "fatal: Authentication failed for 'https://github.com/o/r.git/'";

const installLease = (fixture, lease) => {
  const body = `${JSON.stringify(lease)}\n`;
  const sha = execFileSync("git", ["-C", fixture.root, "hash-object", "-w", "--stdin"], {
    env: FIXTURE_ENV,
    encoding: "utf8",
    input: body,
  }).trim();
  execFileSync("git", ["-C", fixture.root, "push", "-q", "origin", `+${sha}:refs/merge-lease/holder`], {
    env: FIXTURE_ENV,
  });
  return { ...lease, sha };
};

const readLease = (fixture) => {
  const sha = execFileSync("git", ["--git-dir", fixture.origin, "rev-parse", "refs/merge-lease/holder"], {
    env: FIXTURE_ENV,
    encoding: "utf8",
  }).trim();
  const body = execFileSync("git", ["--git-dir", fixture.origin, "cat-file", "blob", sha], {
    env: FIXTURE_ENV,
    encoding: "utf8",
  });
  return { sha, lease: JSON.parse(body), text: body };
};

const runLeaseAsync = (fixture, args, holder, options = {}) =>
  new Promise((resolve) => {
    const child = spawn("bash", [join(fixture.root, "scripts", "merge-lease.sh"), ...args], {
      cwd: fixture.root,
      env: { ...FIXTURE_ENV, MERGE_LEASE_HOLDER: holder },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      options.onStderr?.(stderr);
    });
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });

test("merge lease acquire is mutually exclusive and release removes the lease", (t) => {
  const fixture = leaseFixture(t);
  const first = runLease(
    fixture,
    ["acquire", "--reason", "First merge", "--task", "chain-1"],
    "first@fixture",
  );
  assert.equal(first.status, 0, first.stdout + first.stderr);

  const second = runLease(
    fixture,
    ["acquire", "--reason", "Second merge", "--task", "chain-2", "--timeout-minutes", "0"],
    "second@fixture",
  );
  assert.equal(second.status, 75, second.stdout + second.stderr);
  // Contention names the holder on the way out: an operator or a readiness tick
  // that cannot take the lease can say whose lease is in the way.
  const contendedHolder = /^MERGE LEASE HOLDER: (.+)$/mu.exec(second.stderr);
  assert.ok(contendedHolder, second.stdout + second.stderr);
  const blocking = JSON.parse(contendedHolder[1]);
  assert.equal(blocking.holder, "first@fixture");
  assert.equal(blocking.task, "chain-1");
  assert.equal(blocking.reason, "First merge");
  assert.equal(blocking.sha, readLease(fixture).sha);
  assert.match(blocking.acquiredAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(readLease(fixture).lease.holder, "first@fixture");

  const released = runLease(fixture, ["release", "--force"], "first@fixture");
  assert.equal(released.status, 0, released.stdout + released.stderr);
  const status = runLease(fixture, ["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /no lease held/u);
});

test("merge lease acquire is reentrant only for the same task", (t) => {
  const fixture = leaseFixture(t);
  const first = runLease(
    fixture,
    ["acquire", "--reason", "First chain tail", "--task", "chain-42"],
    "first@fixture",
  );
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const original = readLease(fixture);

  const reentrant = runLease(
    fixture,
    ["acquire", "--reason", "Retried chain tail", "--task", "chain-42", "--timeout-minutes", "0"],
    "second@fixture",
  );
  assert.equal(reentrant.status, 0, reentrant.stdout + reentrant.stderr);
  assert.match(reentrant.stdout, /already held for task chain-42/u);
  assert.deepEqual(readLease(fixture), original, "reentry must not rewrite the lease object");

  const other = runLease(
    fixture,
    ["acquire", "--reason", "Other chain tail", "--task", "chain-43", "--timeout-minutes", "0"],
    "second@fixture",
  );
  assert.equal(other.status, 75, other.stdout + other.stderr);
  assert.deepEqual(readLease(fixture), original);
});

test("merge lease task release ignores holder identity and skips a different task", (t) => {
  const fixture = leaseFixture(t);
  const acquired = runLease(
    fixture,
    ["acquire", "--reason", "Chain tail", "--task", "chain-42"],
    "runner@fixture",
  );
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const original = readLease(fixture);

  const skipped = runLease(fixture, ["release", "--task", "chain-43"], "api@fixture");
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
  assert.match(skipped.stdout, /release skipped/u);
  assert.deepEqual(readLease(fixture), original);

  const released = runLease(fixture, ["release", "--task", "chain-42"], "api@fixture");
  assert.equal(released.status, 0, released.stdout + released.stderr);
  assert.ok(
    released.stdout.includes(`MERGE LEASE: released refs/merge-lease/holder ${original.sha} ${original.lease.acquiredAt}`),
    released.stdout,
  );
  assert.match(runLease(fixture, ["status"]).stdout, /no lease held/u);
});

test("merge lease release refuses a caller that does not hold the lease", (t) => {
  const fixture = leaseFixture(t);
  const held = {
    holder: "holder@fixture",
    acquiredAt: new Date().toISOString(),
    reason: "Active merge",
    token: "holder-token",
  };
  installLease(fixture, held);

  const refused = runLease(fixture, ["release", "--force"], "stranger@fixture");
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /held by holder@fixture, not stranger@fixture/u);
  assert.deepEqual(readLease(fixture).lease, held);

  const released = runLease(fixture, ["release", "--force"], "holder@fixture");
  assert.equal(released.status, 0, released.stdout + released.stderr);
  const status = runLease(fixture, ["status"]);
  assert.match(status.stdout, /no lease held/u);
});

test("merge lease acquire without --task is refused so every lease records its task", (t) => {
  const fixture = leaseFixture(t);
  const refused = runLease(fixture, ["acquire", "--reason", "Missing task"], "agent@mac");
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /acquire requires --task/u);
  assert.match(runLease(fixture, ["status"]).stdout, /no lease held/u);
});

test("merge lease release without --task is refused rather than freeing a sibling window", (t) => {
  const fixture = leaseFixture(t);
  // Both windows are the same user on the same machine, so the holder string is
  // identical and cannot tell them apart. Only the task id can.
  const acquired = runLease(
    fixture,
    ["acquire", "--reason", "Window A merge", "--task", "chain-42"],
    "agent@mac",
  );
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const original = readLease(fixture);

  const refused = runLease(fixture, ["release"], "agent@mac");
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /release requires --task/u);
  assert.deepEqual(readLease(fixture), original);
});

test("merge lease acquire restamps acquiredAt on every attempt while it queues", async (t) => {
  const fixture = leaseFixture(t);
  const blocking = {
    holder: "blocker@fixture",
    acquiredAt: new Date().toISOString(),
    reason: "Long merge",
    token: "blocker-token",
  };
  installLease(fixture, blocking);

  let observedPoll;
  const polled = new Promise((resolve) => { observedPoll = resolve; });
  const waiter = runLeaseAsync(
    fixture,
    ["acquire", "--reason", "Queued merge", "--task", "chain-99", "--poll-seconds", "1"],
    "waiter@fixture",
    {
      onStderr: (stderr) => {
        if (stderr.includes("polling again")) observedPoll();
      },
    },
  );
  // Release only after the first attempt has demonstrably lost. A wall-clock
  // delay races process scheduling when this fixture runs with the rest of the
  // gate suite under load.
  await polled;
  const queuedFor = Date.now();
  execFileSync("git", ["--git-dir", fixture.origin, "update-ref", "-d", "refs/merge-lease/holder"], {
    env: FIXTURE_ENV,
  });

  const result = await waiter;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const acquiredAt = Date.parse(readLease(fixture).lease.acquiredAt);
  assert.ok(
    acquiredAt >= queuedFor - 1000,
    `acquiredAt ${new Date(acquiredAt).toISOString()} must be stamped when the lease was won, not when queueing began`,
  );
});

test("merge lease status prints every field of the current holder", (t) => {
  const fixture = leaseFixture(t);
  const acquired = runLease(
    fixture,
    ["acquire", "--reason", "Inspect status", "--task", "task-42"],
    "status@fixture",
  );
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const secondRoot = join(dirname(fixture.root), "second-source");
  mkdirSync(join(secondRoot, "scripts"), { recursive: true });
  cpSync(mergeLeasePath, join(secondRoot, "scripts", "merge-lease.sh"));
  chmodSync(join(secondRoot, "scripts", "merge-lease.sh"), 0o755);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: secondRoot, env: FIXTURE_ENV });
  execFileSync("git", ["remote", "add", "origin", fixture.origin], { cwd: secondRoot, env: FIXTURE_ENV });
  const status = runLease({ root: secondRoot, origin: fixture.origin }, ["status"]);
  assert.equal(status.status, 0, status.stderr);
  // stdout is the blob and nothing else, so `status | jq` keeps working; the
  // machine line the control plane reads travels beside it on stderr.
  const lease = JSON.parse(status.stdout);
  assert.deepEqual(JSON.parse(/^MERGE LEASE HOLDER: (.+)$/mu.exec(status.stderr)[1]), {
    holder: "status@fixture",
    task: "task-42",
    acquiredAt: lease.acquiredAt,
    reason: "Inspect status",
    sha: readLease(fixture).sha,
  });
  assert.equal(lease.holder, "status@fixture");
  assert.equal(lease.task, "task-42");
  assert.equal(lease.reason, "Inspect status");
  assert.match(lease.acquiredAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(lease.token, /^merge-lease-v1-[0-9a-f]{32}$/u);
  assert.doesNotMatch(lease.token, /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/u);
});

test("machine steal is refused through 45 minutes and allowed only after it", (t) => {
  const fixture = leaseFixture(t);
  const recent = {
    holder: "recent@fixture",
    acquiredAt: new Date(Date.now() - 44 * 60 * 1000).toISOString(),
    reason: "Recent merge",
    token: "recent-token",
  };
  installLease(fixture, recent);
  const refused = runLease(fixture, ["steal", "--reason", "Machine recovery"], "machine@fixture");
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /has not exceeded 2700s/u);
  assert.equal(readLease(fixture).lease.holder, "recent@fixture");

  const stale = {
    ...recent,
    acquiredAt: new Date(Date.now() - 46 * 60 * 1000).toISOString(),
    token: "stale-token",
  };
  installLease(fixture, stale);
  const stolen = runLease(fixture, ["steal", "--reason", "Machine recovery"], "machine@fixture");
  assert.equal(stolen.status, 0, stolen.stdout + stolen.stderr);
  assert.match(stolen.stderr, /stealing lease from/u);
  const { lease: current, text } = readLease(fixture);
  assert.equal(current.holder, "machine@fixture");
  assert.deepEqual(current.stolenFrom, {
    holder: stale.holder,
    acquiredAt: stale.acquiredAt,
    reason: stale.reason,
  });
  assert.doesNotMatch(text, /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu);
});

// A pseudo-terminal on every standard stream, which is what the removed
// heuristic used to read as "a human is running this". `script(1)` cannot
// provide one here -- BSD script wants a terminal of its own to copy settings
// from, and a test runner has none -- so the pty comes from python's own
// openpty. python3 is present on the gate worker (scripts/gate-worker/
// provision.sh) and on macOS, and a missing one fails this case rather than
// quietly turning it into a run without a terminal, which is the one condition
// it exists to test. pty.spawn copies the child's output through the terminal,
// so stdout and stderr arrive merged.
const runOnTerminal = (fixture, command, holder) => {
  const result = spawnSync("python3", [
    "-c",
    [
      "import os, pty, sys",
      "status = pty.spawn(sys.argv[1:])",
      "sys.exit(os.waitstatus_to_exitcode(status))",
    ].join("\n"),
    ...command,
  ], {
    cwd: fixture.root,
    encoding: "utf8",
    timeout: 15_000,
    input: "",
    env: { ...FIXTURE_ENV, MERGE_LEASE_HOLDER: holder },
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const runLeaseOnTerminal = (fixture, args, holder) =>
  runOnTerminal(fixture, ["bash", join(fixture.root, "scripts", "merge-lease.sh"), ...args], holder);

test("usage prints the whole header comment, not a fixed range of it", (t) => {
  const fixture = leaseFixture(t);
  const printed = runLease(fixture, []);
  assert.notEqual(printed.status, 0, printed.stdout + printed.stderr);
  assert.match(printed.stdout, /steal --reason "Recover abandoned merge" \[--human\]/u);
  // The range used to be hard-coded, so growing the header truncated the text
  // mid-sentence. The last sentence, whole, is what proves it is all there.
  assert.match(
    printed.stdout.trimEnd(),
    /Use --force to fall back\nto the holder check when the acquiring task id is genuinely unknown\.$/u,
  );
  assert.doesNotMatch(printed.stdout, /^#/mu);
});

test("a terminal does not make a caller human: only --human waives the threshold", (t) => {
  const fixture = leaseFixture(t);
  // Prove the terminal before asserting what the script does in front of one.
  const probe = runOnTerminal(fixture, ["bash", "-c", "[ -t 0 ] && [ -t 1 ] && [ -t 2 ] && echo TERMINAL"]);
  assert.match(probe.output, /TERMINAL/u, probe.output);

  const fresh = {
    holder: "active@fixture",
    acquiredAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    reason: "Active merge",
    token: "active-token",
  };
  installLease(fixture, fresh);

  const refused = runLeaseOnTerminal(fixture, ["steal", "--reason", "Interactive recovery"], "operator@fixture");
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, /machine steal refused/u);
  // The refusal says how long is left rather than only that it refused.
  assert.match(refused.output, /has not exceeded 2700s; 2[0-9]{3}s remain, or pass --human to steal now/u);
  assert.equal(readLease(fixture).lease.holder, "active@fixture");

  const stolen = runLeaseOnTerminal(
    fixture,
    ["steal", "--human", "--reason", "Interactive recovery", "--task", "incident-9"],
    "operator@fixture",
  );
  assert.equal(stolen.status, 0, stolen.output);
  const current = readLease(fixture).lease;
  assert.equal(current.holder, "operator@fixture");
  assert.equal(current.task, "incident-9");
  assert.equal(current.stolenFrom.holder, "active@fixture");
});

test("an explicit human steal replaces a fresh lease immediately", (t) => {
  const fixture = leaseFixture(t);
  const original = {
    holder: "active@fixture",
    acquiredAt: new Date().toISOString(),
    reason: "Active merge",
    token: "active-token",
  };
  installLease(fixture, original);
  const stolen = runLease(
    fixture,
    ["steal", "--human", "--reason", "Human override", "--task", "incident-7"],
    "leo@fixture",
  );
  assert.equal(stolen.status, 0, stolen.stdout + stolen.stderr);
  const current = readLease(fixture).lease;
  assert.equal(current.holder, "leo@fixture");
  assert.equal(current.task, "incident-7");
  assert.deepEqual(current.stolenFrom, {
    holder: original.holder,
    acquiredAt: original.acquiredAt,
    reason: original.reason,
  });
});

test("two concurrent steals compare-and-swap the observed holder so exactly one wins", async (t) => {
  const fixture = leaseFixture(t);
  const original = {
    holder: "abandoned@fixture",
    acquiredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    reason: "Abandoned merge",
    token: "abandoned-token",
  };
  installLease(fixture, original);
  const hook = join(fixture.origin, "hooks", "pre-receive");
  writeFileSync(hook, "#!/usr/bin/env bash\nsleep 0.4\n");
  chmodSync(hook, 0o755);

  const results = await Promise.all([
    runLeaseAsync(fixture, ["steal", "--reason", "First recovery"], "first@fixture"),
    runLeaseAsync(fixture, ["steal", "--reason", "Second recovery"], "second@fixture"),
  ]);
  assert.equal(results.filter((result) => result.status === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.status === 1).length, 1, JSON.stringify(results));
  assert.match(results.find((result) => result.status === 1).stderr, /compare-and-swap refused/u);
  const current = readLease(fixture).lease;
  assert.ok(["first@fixture", "second@fixture"].includes(current.holder));
  assert.deepEqual(current.stolenFrom, {
    holder: original.holder,
    acquiredAt: original.acquiredAt,
    reason: original.reason,
  });
});

test("steal removes nested historical token fields before writing provenance", (t) => {
  const fixture = leaseFixture(t);
  const legacyUuid = "123e4567-e89b-12d3-a456-426614174000";
  installLease(fixture, {
    holder: "legacy@fixture",
    acquiredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    reason: "Legacy lease",
    token: legacyUuid,
    history: [{ token: legacyUuid, holder: "older@fixture" }],
  });
  const stolen = runLease(fixture, ["steal", "--reason", "Scope rename recovery"], "machine@fixture");
  assert.equal(stolen.status, 0, stolen.stdout + stolen.stderr);
  const { lease, text } = readLease(fixture);
  assert.deepEqual(lease.stolenFrom.history, [{ holder: "older@fixture" }]);
  assert.doesNotMatch(text, /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu);
});

// --- the release outcome, as the merge tail reads it -------------------------
//
// Four outcomes, three of which exit 0. packages/api/src/merge-lease.ts tells
// them apart by the MERGE LEASE line; an operator reads the prose above it.
// One case per shape, and each asserts both lines, because the point of
// printing them from one function is that they agree.

test("a release that frees the lease says released in both lines", (t) => {
  const fixture = leaseFixture(t);
  const acquired = runLease(
    fixture,
    ["acquire", "--reason", "Machine line", "--task", "chain-7"],
    "api@fixture",
  );
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const { sha, lease } = readLease(fixture);

  const released = runLease(fixture, ["release", "--task", "chain-7"], "api@fixture");
  assert.equal(released.status, 0, released.stdout + released.stderr);
  assert.match(released.stdout, new RegExp(`^merge-lease: released refs/merge-lease/holder \\(${sha}\\)$`, "mu"));
  assert.match(released.stdout, new RegExp(`^MERGE LEASE: released refs/merge-lease/holder ${sha} ${lease.acquiredAt}$`, "mu"));
});

test("a release with nothing to free says not-held in both lines", (t) => {
  const fixture = leaseFixture(t);
  const released = runLease(fixture, ["release", "--task", "chain-7"], "api@fixture");
  assert.equal(released.status, 0, released.stdout + released.stderr);
  assert.match(released.stdout, /^merge-lease: no lease held$/mu);
  assert.match(released.stdout, /^MERGE LEASE: not-held$/mu);
});

test("a release that leaves another task's lease standing says skipped in both lines", (t) => {
  const fixture = leaseFixture(t);
  const acquired = runLease(
    fixture,
    ["acquire", "--reason", "Someone else's merge", "--task", "chain-42"],
    "runner@fixture",
  );
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const original = readLease(fixture);

  // The defect this line exists for: exit 0 and a lease still held.
  const skipped = runLease(fixture, ["release", "--task", "chain-43"], "api@fixture");
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
  assert.match(
    skipped.stdout,
    /^merge-lease: release skipped; refs\/merge-lease\/holder is held for task chain-42, not chain-43$/mu,
  );
  assert.match(skipped.stdout, /^MERGE LEASE: skipped chain-42$/mu);
  assert.deepEqual(readLease(fixture), original);
});

test("a release refused on another machine's lease says refused in both lines", (t) => {
  const fixture = leaseFixture(t);
  const held = {
    holder: "holder@fixture",
    acquiredAt: new Date().toISOString(),
    reason: "Active merge",
    token: "holder-token",
  };
  installLease(fixture, held);

  const refused = runLease(fixture, ["release", "--force"], "stranger@fixture");
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(
    refused.stderr,
    /^merge-lease: release refused: refs\/merge-lease\/holder is held by holder@fixture, not stranger@fixture; use steal to break it$/mu,
  );
  assert.match(refused.stderr, /^MERGE LEASE: refused holder@fixture$/mu);
  assert.deepEqual(readLease(fixture).lease, held);
});

// --- the git network retry budget -------------------------------------------
//
// This host reaches origin through a proxy whose 443 exit drops for seconds at
// a time and in clusters, so the budget these cases pin is the one from
// packages/runner/src/network-retry.ts: six attempts with jittered exponential
// backoff, and only for the failures git writes transient words for. A release
// that loses its push strands the lease on origin for the full 45-minute machine
// steal threshold, which is what makes the budget worth spending.

test("a transient release push failure is retried instead of stranding the lease", (t) => {
  const fixture = leaseFixture(t);
  const acquired = runLease(
    fixture,
    ["acquire", "--reason", "Flaky exit", "--task", "chain-7"],
    "api@fixture",
  );
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const { sha } = readLease(fixture);

  const shim = gitShim(t, fixture);
  const released = runLease(fixture, ["release", "--task", "chain-7"], "api@fixture", {
    env: shim.env("push", 2, TRANSIENT_GIT_ERROR),
    timeout: 60_000,
  });
  assert.equal(released.status, 0, released.stdout + released.stderr);
  assert.match(released.stderr, /lease release push failed; retrying attempt=3\/6/u);
  assert.equal(shim.calls(), 3);
  assert.match(released.stdout, new RegExp(`^MERGE LEASE: released refs/merge-lease/holder ${sha} `, "mu"));
});

test("a deterministic git failure is not retried at all", (t) => {
  const fixture = leaseFixture(t);
  const shim = gitShim(t, fixture);
  const status = runLease(fixture, ["status"], "api@fixture", {
    env: shim.env("ls-remote", 6, DETERMINISTIC_GIT_ERROR),
    timeout: 60_000,
  });
  assert.notEqual(status.status, 0, status.stdout + status.stderr);
  assert.doesNotMatch(status.stderr, /retrying attempt/u);
  assert.match(status.stderr, /Authentication failed/u);
  assert.equal(shim.calls(), 1, "an authentication failure is the remote's answer, not a blip");
});

test("a transient failure that outlasts the budget reports git's own words", (t) => {
  const fixture = leaseFixture(t);
  const acquired = runLease(
    fixture,
    ["acquire", "--reason", "Sustained outage", "--task", "chain-9"],
    "api@fixture",
  );
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const original = readLease(fixture);

  const shim = gitShim(t, fixture);
  const released = runLease(fixture, ["release", "--task", "chain-9"], "api@fixture", {
    env: shim.env("push", 6, TRANSIENT_GIT_ERROR),
    timeout: 60_000,
  });
  assert.notEqual(released.status, 0, released.stdout + released.stderr);
  assert.match(released.stderr, /lease release push failed; retrying attempt=6\/6/u);
  assert.match(released.stderr, /SSL_ERROR_SYSCALL in connection to github.com:443/u);
  assert.match(released.stderr, /could not release the lease/u);
  assert.equal(shim.calls(), 6);
  assert.deepEqual(readLease(fixture), original, "a lost release must leave the lease intact");
});
