// Fixtures for the slot locks in the runner-owned lib.sh and for the exit
// codes the runner-owned gate-dispatch.sh reports.
//
// Two things are under test and both are mechanisms, not text.
//
// The first is the per-slot capacity invariant: one holder for each named slot,
// never two holders in one slot. That is a concurrency property, so the cases
// here run real concurrent processes against a real lock root. The bug they
// exist for is specific — a slot lock
// that is created before it names its owner has a window in which a second
// dispatcher reads "no owner", calls the lock abandoned and takes the slot its
// owner is gating in — and `refuses a lock that names no pid` reproduces
// exactly that window as a state on disk, deterministically, with no timing to
// lose.
//
// The second is that a slot which is busy and a slot whose lock cannot be
// operated are different answers. `gate_slot_try` returns 1 for the first and 2
// for the second, and the dispatcher spends a timeout waiting only on the
// first: a lock nobody can take does not free up, and reporting it as a full
// queue sent operators to wait for a slot that was never going to open.
//
// The third is that a verdict and the absence of a verdict never share an exit
// code. Those cases run the dispatcher itself against a throwaway repository
// whose merge-gate.sh, mirror-push.sh and remote-gate.sh are stubs, because
// what is being proved is which code comes back from which failure, and a real
// gate would take minutes to prove one bit of it.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureEnv } from "./gate-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeGateWorker = join(here, "..", "..", "packages", "runner", "runtime-tools", "gate-worker");
const libPath = join(runtimeGateWorker, "lib.sh");
const dispatchPath = join(runtimeGateWorker, "gate-dispatch.sh");

const test = (name, body) => nodeTest(name, { concurrency: true }, body);

// What the gate reads out of the environment, and which of it a fixture may
// inherit, is one question with one answer; it used to be 26 identical lines
// here and 26 more in the sibling fixture file, and one of the three commits
// that edited them landed in only one of the two.
const FIXTURE_ENV = fixtureEnv("gate-dispatch-fixture");

const scratch = (t) => {
  const root = mkdtempSync(join(tmpdir(), "gate-dispatch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

// One bash process, lib.sh sourced, whatever the case wants to say afterwards.
const runBash = (script, options = {}) =>
  spawnSync("bash", ["-c", `set -uo pipefail\n. "${libPath}"\n${script}`], {
    encoding: "utf8",
    ...options,
  });

const slotRoot = (t) => {
  const root = join(scratch(t), "slots");
  mkdirSync(root, { recursive: true });
  return root;
};

const lockFile = (root, slot) => join(root, `${slot}.slot`);

// --- the capacity invariant --------------------------------------------------

test("one claimer takes the slot and names itself in it", (t) => {
  const root = slotRoot(t);
  const result = runBash(`gate_slot_try "${root}" local && cat "${root}/local.slot"`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+$/);
});

test("a slot held by a live pid is refused", (t) => {
  const root = slotRoot(t);
  // This test process is alive by construction, so the lock it writes is a
  // holder that `kill -0` will find.
  writeFileSync(lockFile(root, "local"), `${process.pid}\n`);
  const result = runBash(`gate_slot_try "${root}" local`);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(lockFile(root, "local"), "utf8").trim(), String(process.pid));
});

test("the holder of a slot is readable without touching the lock", (t) => {
  // What a waiting dispatcher compares across polls to tell a moving queue from
  // a stuck one. It observes and never acts: the lock must come back untouched.
  const root = slotRoot(t);
  writeFileSync(lockFile(root, "remote-1"), `${process.pid}\n`);
  const result = runBash(`gate_slot_holder "${root}" remote-1`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, String(process.pid));
  assert.equal(readFileSync(lockFile(root, "remote-1"), "utf8").trim(), String(process.pid));
});

test("a free slot and a lock that names no pid have no holder", (t) => {
  // Nothing, not an error and not a made-up value: "no holder" is the answer
  // for a slot nobody is gating in and for a lock this script did not write,
  // and gate_slot_try is the only reader allowed to act on either.
  const root = slotRoot(t);
  writeFileSync(lockFile(root, "remote-2"), "held by somebody\n");
  for (const slot of ["remote-1", "remote-2"]) {
    const result = runBash(`gate_slot_holder "${root}" ${slot}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
});

test("refuses a lock that names no pid rather than reclaiming it", (t) => {
  // The regression. A lock created before its owner was written names nobody,
  // and the whole failure was reading that as "abandoned": two dispatchers then
  // ran one slot. An empty lock is now blocking and loud, never reclaimed.
  const root = slotRoot(t);
  writeFileSync(lockFile(root, "remote-1"), "");
  const result = runBash(`gate_slot_try "${root}" remote-1`);
  // 2, not 1: nobody can take this slot and no amount of waiting changes that.
  assert.equal(result.status, 2);
  assert.match(result.stderr, /names no pid/);
  assert.ok(readFileSync(lockFile(root, "remote-1"), "utf8") === "");
});

test("refuses a lock whose contents are not a pid", (t) => {
  const root = slotRoot(t);
  writeFileSync(lockFile(root, "remote-1"), "held by somebody\n");
  const result = runBash(`gate_slot_try "${root}" remote-1`);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /names no pid/);
});

test("refuses an old-format lock directory instead of ignoring it", (t) => {
  // The pre-#132 dispatcher held a directory. The two shapes do not exclude
  // each other, so a lock directory this implementation cannot see is how three
  // slots would become six during a changeover.
  const root = slotRoot(t);
  mkdirSync(join(root, "local.lock"));
  const result = runBash(`gate_slot_try "${root}" local`);
  // Broken rather than busy: this implementation cannot tell whether an old
  // dispatcher is holding it, and "cannot tell" is not something to wait out.
  assert.equal(result.status, 2);
  assert.match(result.stderr, /old-format slot lock/);
});

test("reclaims a slot whose holder is gone", (t) => {
  const root = slotRoot(t);
  // A pid that has certainly exited: spawn one and wait for it.
  const dead = spawnSync("bash", ["-c", 'echo $$'], { encoding: "utf8" });
  const deadPid = dead.stdout.trim();
  writeFileSync(lockFile(root, "local"), `${deadPid}\n`);
  const result = runBash(`gate_slot_try "${root}" local && cat "${root}/local.slot"`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /reclaimed slot local/);
  assert.notEqual(result.stdout.trim(), deadPid);
});

test("a reclaim already in flight is refused, not raced", (t) => {
  const root = slotRoot(t);
  const dead = spawnSync("bash", ["-c", 'echo $$'], { encoding: "utf8" });
  const deadPid = dead.stdout.trim();
  writeFileSync(lockFile(root, "local"), `${deadPid}\n`);
  // The witness link is what makes exactly one of two dispatchers the reclaimer.
  // Holding it stands in for the other dispatcher being mid-reclaim.
  writeFileSync(join(root, `.reclaim.local.${deadPid}`), `${deadPid}\n`);
  const result = runBash(`gate_slot_try "${root}" local`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /another dispatcher is reclaiming/);
});

test("release removes only a lock this process owns", (t) => {
  const root = slotRoot(t);
  const result = runBash(
    `gate_slot_try "${root}" local && gate_slot_release "${root}" local && test ! -e "${root}/local.slot"`,
  );
  assert.equal(result.status, 0, result.stderr);
});

test("release leaves a lock that names somebody else", (t) => {
  const root = slotRoot(t);
  writeFileSync(lockFile(root, "local"), `${process.pid}\n`);
  const result = runBash(`gate_slot_release "${root}" local`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not releasing slot local/);
  assert.equal(readFileSync(lockFile(root, "local"), "utf8").trim(), String(process.pid));
});

test("a slot root that cannot be written to is broken, not busy", (t) => {
  // The regression. A read-only cache directory used to return 1 — the same
  // answer as "somebody is running a gate" — and the dispatcher then polled a
  // slot that could never be taken until its timeout and reported a full queue.
  const root = slotRoot(t);
  chmodSync(root, 0o555);
  // Restored inline rather than in an after hook: the hook that removes the
  // scratch directory was registered first and would run against a directory
  // nothing is allowed to delete from.
  const result = runBash(`gate_slot_try "${root}" local`);
  chmodSync(root, 0o755);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not write a lock under/);
});

test("busy and broken are different return values, not different messages", (t) => {
  // Stated as one assertion because everything downstream depends on it: the
  // dispatcher branches on the number, never on the text.
  const root = slotRoot(t);
  writeFileSync(lockFile(root, "local"), `${process.pid}\n`);
  writeFileSync(lockFile(root, "remote-1"), "not a pid\n");
  const busy = runBash(`gate_slot_try "${root}" local`);
  const broken = runBash(`gate_slot_try "${root}" remote-1`);
  assert.equal(busy.status, 1);
  assert.equal(broken.status, 2);
});

test("sixteen concurrent claimers on one slot produce exactly one holder", (t) => {
  const root = slotRoot(t);
  const winners = join(root, "winners");
  // Each claimer appends only if it took the slot. A single `>>` of a short
  // line is atomic enough for a count, and the count is the whole assertion:
  // the old shape produced more than one here.
  // The winner stays alive after taking the slot. A claimer that exits at once
  // leaves a lock naming a dead pid, which the next claimer is *right* to
  // reclaim — that is a lock working, not a lock failing, and a fixture that
  // does not hold the slot open would be measuring the wrong thing.
  const claimer = `
    . "${libPath}"
    if gate_slot_try "${root}" local; then
      printf '%s\\n' "$$" >> "${winners}"
      sleep 2
    fi
  `;
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -uo pipefail
       : > "${winners}"
       for i in $(seq 1 16); do
         bash -c '${claimer.replace(/'/g, "'\\''")}' &
       done
       wait`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const held = readFileSync(winners, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(held.length, 1, `expected one holder, got ${held.length}: ${held.join(",")}`);
});

test("eight concurrent claimers across two slots produce exactly two holders", (t) => {
  const root = slotRoot(t);
  const winners = join(root, "winners");
  const claimer = `
    . "${libPath}"
    for slot in remote-1 local; do
      if gate_slot_try "${root}" "$slot"; then
        printf '%s %s\\n' "$slot" "$$" >> "${winners}"
        sleep 2
        break
      fi
    done
  `;
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -uo pipefail
       : > "${winners}"
       for i in $(seq 1 8); do
         bash -c '${claimer.replace(/'/g, "'\\''")}' &
       done
       wait`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const held = readFileSync(winners, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(held.length, 2, `expected two holders, got ${held.length}: ${held.join(" | ")}`);
  assert.equal(new Set(held.map((line) => line.split(" ")[0])).size, 2);
});

test("a killed holder's lock is released by the signal traps", (t) => {
  const root = slotRoot(t);
  const started = join(root, "started");
  const holder = spawnSync(
    "bash",
    [
      "-c",
      `set -uo pipefail
       . "${libPath}"
       HELD=""
       cleanup() { s=$?; trap - EXIT; [ -n "$HELD" ] && gate_slot_release "${root}" "$HELD"; exit $s; }
       trap cleanup EXIT
       trap 'exit 143' TERM
       gate_slot_try "${root}" local && HELD=local
       : > "${started}"
       sleep 20 &
       wait $!`,
    ],
    { encoding: "utf8", timeout: 3000, killSignal: "SIGTERM" },
  );
  // spawnSync's own timeout is the kill: the point is that the trap ran.
  assert.ok(holder.signal === "SIGTERM" || holder.status !== null);
  const result = runBash(`test ! -e "${root}/local.slot"`);
  assert.equal(result.status, 0, `the lock survived a TERM'd holder`);
});

// --- the exit-code contract --------------------------------------------------

// A repository the dispatcher will accept: it has scripts/merge-gate.sh, a
// clean tree and a resolvable HEAD, so the local slot is eligible. The three
// runtime-tool siblings the dispatcher shells out to are stubs; lib.sh and
// gate-dispatch.sh are the real ones.
const fixtureRepo = (t, { mergeGate, mirrorPush, remoteGate }) => {
  const root = scratch(t);
  const fixtureTools = join(root, "packages", "runner", "runtime-tools", "gate-worker");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(fixtureTools, { recursive: true });
  const put = (path, body) => {
    writeFileSync(join(root, path), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(root, path), 0o755);
  };
  put("scripts/merge-gate.sh", mergeGate ?? 'printf "MERGE GATE: PASS stub\\n"; exit 0');
  put("packages/runner/runtime-tools/gate-worker/mirror-push.sh", mirrorPush ?? 'printf "MIRROR PUSH: OK\\n"; exit 0');
  put("packages/runner/runtime-tools/gate-worker/remote-gate.sh", remoteGate ?? 'printf "MERGE GATE: PASS stub\\n"; exit 0');
  cpSync(libPath, join(fixtureTools, "lib.sh"));
  cpSync(dispatchPath, join(fixtureTools, "gate-dispatch.sh"));
  chmodSync(join(fixtureTools, "gate-dispatch.sh"), 0o755);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: FIXTURE_ENV });
  execFileSync("git", ["add", "-A"], { cwd: root, env: FIXTURE_ENV });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root, env: FIXTURE_ENV });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    env: FIXTURE_ENV,
    encoding: "utf8",
  }).trim();
  const originRoot = scratch(t);
  const origin = join(originRoot, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin], { env: FIXTURE_ENV });
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"], { env: FIXTURE_ENV });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: root, env: FIXTURE_ENV });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: root, env: FIXTURE_ENV });
  return { root, head };
};

const externalTooling = (t, { mirrorPush, remoteGate }) => {
  const root = scratch(t);
  const worker = join(root, "gate-worker");
  mkdirSync(worker);
  cpSync(libPath, join(worker, "lib.sh"));
  cpSync(dispatchPath, join(worker, "gate-dispatch.sh"));
  chmodSync(join(worker, "gate-dispatch.sh"), 0o755);
  const put = (name, body) => {
    writeFileSync(join(worker, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(worker, name), 0o755);
  };
  put("mirror-push.sh", mirrorPush ?? 'printf "MIRROR PUSH: OK external\\n"; exit 0');
  put("remote-gate.sh", remoteGate ?? 'printf "MERGE GATE: PASS external\\n"; exit 0');
  return { root, script: join(worker, "gate-dispatch.sh") };
};

// No fixture may block. The dispatcher's default patience is an hour, which is
// right for an operator waiting on a real queue and absurd inside a test, and a
// spawnSync with no timeout promotes that wait into a suite that never returns
// — the shape a leaked AGENTOS_GATE_SERVER produced here. Every dispatcher run
// therefore goes through this helper and carries both bounds: the dispatcher
// gives up first, so the failure is a readable 75 rather than a kill, and the
// timeout is the backstop for a dispatcher that never gets that far. Cases that
// are about the wait itself pass their own --timeout-minutes, which wins.
const DISPATCH_KILL_MS = 120_000;

const dispatchInvocation = (repo, cache, args, env = {}, { cwd = repo.root, script = join(repo.root, "packages/runner/runtime-tools/gate-worker/gate-dispatch.sh") } = {}) => ({
  command: "bash",
  args: [script, ...args],
  options: {
    cwd,
    encoding: "utf8",
    env: {
      ...FIXTURE_ENV,
      AGENTOS_WORKSPACE_PATH: repo.root,
      XDG_CACHE_HOME: cache,
      GATE_DISPATCH_POLL_SECONDS: "1",
      GATE_DISPATCH_TIMEOUT_MINUTES: "1",
      AGENTOS_GATE_PRIMARY_SERVER: "primary",
      AGENTOS_GATE_FALLBACK_SERVER: "fallback",
      ...env,
    },
  },
});

const runDispatch = (repo, cache, args, env = {}, options = {}) => {
  const invocation = dispatchInvocation(repo, cache, args, env, options);
  return spawnSync(invocation.command, invocation.args, {
    ...invocation.options,
    timeout: DISPATCH_KILL_MS,
  });
};

const startDispatch = (repo, cache, args, env = {}, options = {}) => {
  const invocation = dispatchInvocation(repo, cache, args, env, options);
  const child = spawn(invocation.command, invocation.args, invocation.options);
  const run = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    run.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    run.stderr += chunk;
  });
  run.done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout: run.stdout, stderr: run.stderr }));
  });
  return run;
};

const waitFor = async (condition, message, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
};

const startupLineFor = (stderr, path) =>
  stderr.split(/\r?\n/u).find((line) => line.includes(path));

// A cache root with the named slots already taken, so a case states its queue
// as a precondition instead of racing one into place.
const busyCache = (t, busySlots = []) => {
  const cache = join(scratch(t), "cache");
  const slots = join(cache, "gate-dispatch");
  mkdirSync(slots, { recursive: true });
  for (const slot of busySlots) writeFileSync(join(slots, `${slot}.slot`), `${process.pid}\n`);
  return cache;
};

const dispatch = (t, repo, args, env = {}, busySlots = []) =>
  runDispatch(repo, busyCache(t, busySlots), args, env);

test("the dispatcher uses the named checkout when launched outside it", (t) => {
  const calls = join(scratch(t), "external-tooling-calls.log");
  writeFileSync(calls, "");
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "MERGE GATE: PASS local-outside %s\\n" "$(git rev-parse --show-toplevel)"; exit 0',
  });
  const tooling = externalTooling(t, {
    mirrorPush: 'printf "mirror:%s:%s\\n" "$AGENTOS_WORKSPACE_PATH" "$(git -C "$AGENTOS_WORKSPACE_PATH" rev-parse --show-toplevel)" >> "$GATE_FIXTURE_CALLS"; printf "MIRROR PUSH: OK outside\\n"; exit 0',
    remoteGate: 'printf "remote:%s:%s\\n" "$AGENTOS_WORKSPACE_PATH" "$(git -C "$AGENTOS_WORKSPACE_PATH" rev-parse --show-toplevel)" >> "$GATE_FIXTURE_CALLS"; printf "MERGE GATE: PASS remote-outside\\n"; exit 0',
  });
  const outside = scratch(t);

  const local = runDispatch(
    repo,
    busyCache(t),
    [repo.head, "--allow-local"],
    {
      AGENTOS_GATE_PRIMARY_SERVER: "",
      AGENTOS_GATE_FALLBACK_SERVER: "",
    },
    { cwd: outside, script: tooling.script },
  );
  assert.equal(local.status, 0, local.stdout + local.stderr);
  assert.ok(local.stdout.includes(`MERGE GATE: PASS local-outside ${realpathSync(repo.root)}`), local.stdout);

  writeFileSync(join(repo.root, "outside-dirty.txt"), "dirty\n");
  const remote = runDispatch(
    repo,
    busyCache(t),
    [repo.head],
    { GATE_FIXTURE_CALLS: calls },
    { cwd: outside, script: tooling.script },
  );
  assert.equal(remote.status, 0, remote.stdout + remote.stderr);
  assert.match(remote.stdout, /MERGE GATE: PASS remote-outside/u);
  assert.match(remote.stderr, /running on primary/u);
  const canonical = realpathSync(repo.root);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
    `mirror:${canonical}:${canonical}`,
    `remote:${canonical}:${canonical}`,
  ]);
});

test("the repository-path dispatcher invocation retains its result", (t) => {
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "MERGE GATE: PASS repository-path\\n"; exit 0',
  });
  const result = dispatch(t, repo, [repo.head, "--allow-local"], {
    AGENTOS_GATE_PRIMARY_SERVER: "",
    AGENTOS_GATE_FALLBACK_SERVER: "",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS repository-path/u);
});

test("an absent or invalid workspace path fails before any gate-worker child", (t) => {
  const calls = join(scratch(t), "calls.log");
  writeFileSync(calls, "");
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "merge-gate\\n" >> "$GATE_FIXTURE_CALLS"; exit 0',
    mirrorPush: 'printf "mirror-push\\n" >> "$GATE_FIXTURE_CALLS"; exit 0',
    remoteGate: 'printf "remote-gate\\n" >> "$GATE_FIXTURE_CALLS"; exit 0',
  });
  const outside = scratch(t);
  const cases = [
    { name: "unset", env: { AGENTOS_WORKSPACE_PATH: undefined } },
    { name: "empty", env: { AGENTOS_WORKSPACE_PATH: "" } },
    { name: "missing", env: { AGENTOS_WORKSPACE_PATH: join(outside, "missing") } },
  ];
  for (const { name, env } of cases) {
    const result = runDispatch(
      repo,
      busyCache(t),
      [repo.head, "--allow-local"],
      {
        ...env,
        AGENTOS_GATE_PRIMARY_SERVER: "",
        AGENTOS_GATE_FALLBACK_SERVER: "",
        GATE_FIXTURE_CALLS: calls,
      },
      { cwd: outside },
    );
    assert.equal(result.status, 76, `${name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /AGENTOS_WORKSPACE_PATH/u, name);
    assert.doesNotMatch(result.stdout + result.stderr, /MERGE GATE|MIRROR PUSH|remote-gate/u, name);
  }
  assert.equal(readFileSync(calls, "utf8"), "");
});

test("an unconfigured dispatcher refuses instead of guessing a private topology", (t) => {
  const repo = fixtureRepo(t, {});
  const result = dispatch(t, repo, [repo.head], {
    AGENTOS_GATE_PRIMARY_SERVER: "",
    AGENTOS_GATE_FALLBACK_SERVER: "",
  });
  assert.equal(result.status, 76, result.stderr);
  assert.match(result.stderr, /no gate capacity configured/u);
  assert.doesNotMatch(result.stdout + result.stderr, /ci-desktop-worker|agentos-gate/u);
});

test("an unconfigured dispatcher runs local-only after explicit opt-in", (t) => {
  const repo = fixtureRepo(t, {
    mergeGate:
      'test "$AGENTOS_RUN_ID" = local-regression-run && test "$AGENTOS_RUN_SCOPE_BYPASS" = regression-verification && printf "MERGE GATE: PASS local-only\\n"',
  });
  const result = dispatch(t, repo, [repo.head, "--allow-local"], {
    AGENTOS_GATE_PRIMARY_SERVER: "",
    AGENTOS_GATE_FALLBACK_SERVER: "",
    AGENTOS_RUN_ID: "local-regression-run",
    AGENTOS_RUN_SCOPE_BYPASS: "regression-verification",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS local-only/u);
  assert.match(result.stderr, /no remote worker, local\(1, explicit\)/u);
});

test("local capacity is named local-1 through local-N and an extra dispatch waits", async (t) => {
  for (const configured of [undefined, 1, 2, 3]) {
    const count = configured ?? 1;
    const calls = join(scratch(t), `local-calls-${count}.log`);
    const release = join(scratch(t), `local-release-${count}`);
    writeFileSync(calls, "");
    const repo = fixtureRepo(t, {
      mergeGate: `
        printf '%s\\n' "$$" >> "$GATE_FIXTURE_CALLS"
        while [ ! -e "$GATE_FIXTURE_RELEASE" ]; do sleep 0.05; done
        printf 'MERGE GATE: PASS local-capacity-%s\\n' "$$"
        exit 0
      `,
      mirrorPush: 'printf "REMOTE MUST NOT RUN\\n"; exit 1',
      remoteGate: 'printf "REMOTE MUST NOT RUN\\n"; exit 1',
    });
    const cache = busyCache(t);
    const localEnv = {
      AGENTOS_GATE_PRIMARY_SERVER: "",
      AGENTOS_GATE_FALLBACK_SERVER: "",
      AGENTOS_GATE_ALLOW_LOCAL: "1",
      GATE_FIXTURE_CALLS: calls,
      GATE_FIXTURE_RELEASE: release,
    };
    if (configured !== undefined) localEnv.AGENTOS_GATE_LOCAL_SLOTS = String(configured);
    const args = [repo.head, "--master", repo.head, "--allow-local"];
    const active = [];
    const start = () => {
      const run = startDispatch(repo, cache, args, localEnv);
      active.push(run);
      return run;
    };

    try {
      for (let i = 0; i < count; i += 1) start();
      await waitFor(
        () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length === count,
        `expected ${count} local gates to be running`,
      );

      const slotEntries = readdirSync(join(cache, "gate-dispatch"))
        .filter((entry) => entry.endsWith(".slot"))
        .sort();
      assert.deepEqual(slotEntries, Array.from({ length: count }, (_, i) => `local-${i + 1}.slot`));
      assert.ok(!slotEntries.includes("local.slot"));
      assert.ok(!slotEntries.includes(`local-${count + 1}.slot`));
      for (const run of active) assert.equal(run.child.exitCode, null);

      const extra = start();
      await waitFor(
        () => extra.stderr.includes(`${count} slot(s) busy`),
        `the local-${count + 1} dispatch did not report a busy queue`,
      );
      assert.equal(extra.child.exitCode, null);
      assert.equal(readdirSync(join(cache, "gate-dispatch")).filter((entry) => entry.endsWith(".slot")).length, count);
      assert.ok(!readdirSync(join(cache, "gate-dispatch")).includes(`local-${count + 1}.slot`));
      assert.match(active[0].stderr, new RegExp(`local\\(${count}, explicit\\)`));
      assert.match(extra.stderr, new RegExp(`local\\(${count}, explicit\\)`));

      writeFileSync(release, "release\\n");
      const results = await Promise.all(active.map((run) => run.done));
      for (const result of results) {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /MERGE GATE: PASS local-capacity/u);
        assert.doesNotMatch(result.stdout + result.stderr, /REMOTE MUST NOT RUN/u);
      }
    } finally {
      writeFileSync(release, "release\\n");
      for (const run of active) {
        if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGTERM");
      }
      await Promise.allSettled(active.map((run) => run.done));
    }
  }
});

test("local slots are shared by sessions of one runner account", async (t) => {
  const calls = join(scratch(t), "account-slot-calls.log");
  const release = join(scratch(t), "account-slot-release");
  writeFileSync(calls, "");
  const repo = fixtureRepo(t, {
    mergeGate: `
      printf '%s\\n' "$$" >> "$GATE_FIXTURE_CALLS"
      while [ ! -e "$GATE_FIXTURE_RELEASE" ]; do sleep 0.05; done
      printf 'MERGE GATE: PASS account-slot-%s\\n' "$$"
      exit 0
    `,
    mirrorPush: 'printf "REMOTE MUST NOT RUN\\n"; exit 1',
    remoteGate: 'printf "REMOTE MUST NOT RUN\\n"; exit 1',
  });
  const runnerHome = join(scratch(t), "runner-home");
  const homeOne = join(scratch(t), "home-one");
  const homeTwo = join(scratch(t), "home-two");
  const cacheOne = join(scratch(t), "cache-one");
  const cacheTwo = join(scratch(t), "cache-two");
  mkdirSync(runnerHome, { recursive: true });
  mkdirSync(homeOne, { recursive: true });
  mkdirSync(homeTwo, { recursive: true });
  const args = [repo.head, "--master", repo.head, "--allow-local"];
  const envFor = (home) => ({
    AGENTOS_GATE_PRIMARY_SERVER: "",
    AGENTOS_GATE_FALLBACK_SERVER: "",
    AGENTOS_GATE_LOCAL_SLOTS: "1",
    AGENTOS_RUNNER_HOME: runnerHome,
    // Give the two sessions distinct legacy roots as well. With the account
    // root unset, the old implementation would therefore give each process
    // an independent local slot despite their different HOME values.
    XDG_CACHE_HOME: undefined,
    HOME: home,
    GATE_FIXTURE_CALLS: calls,
    GATE_FIXTURE_RELEASE: release,
  });
  const sharedSlots = join(runnerHome, ".cache", "gate-dispatch");
  const active = [];
  let second;

  try {
    const first = startDispatch(repo, cacheOne, args, envFor(homeOne));
    active.push(first);
    await waitFor(
      () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length === 1,
      "the first local gate did not start",
    );
    await waitFor(
      () => existsSync(join(sharedSlots, "local-1.slot")),
      "the first local gate did not hold the runner-account slot",
    );

    const firstRootLine = startupLineFor(first.stderr, sharedSlots);
    assert.ok(firstRootLine, first.stderr);
    assert.match(firstRootLine, /AGENTOS_RUNNER_HOME/u);

    second = startDispatch(repo, cacheTwo, args, envFor(homeTwo));
    active.push(second);
    await waitFor(
      () => second.stderr.includes("1 slot(s) busy"),
      "the second session did not wait for the runner-account slot",
    );
    assert.equal(second.child.exitCode, null);
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length, 1);
    assert.ok(existsSync(join(sharedSlots, "local-1.slot")));

    writeFileSync(release, "release\n");
    const results = await Promise.all(active.map((run) => run.done));
    for (const result of results) {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /MERGE GATE: PASS account-slot/u);
      assert.doesNotMatch(result.stdout + result.stderr, /REMOTE MUST NOT RUN/u);
    }
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length, 2);
  } finally {
    writeFileSync(release, "release\n");
    for (const run of active) {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGTERM");
    }
    await Promise.allSettled(active.map((run) => run.done));
  }
});

test("without a runner account home, local slots remain under HOME", (t) => {
  const repo = fixtureRepo(t, {});
  const home = join(scratch(t), "legacy-home");
  mkdirSync(home, { recursive: true });
  const result = dispatch(t, repo, [repo.head, "--master", repo.head, "--allow-local"], {
    AGENTOS_RUNNER_HOME: undefined,
    XDG_CACHE_HOME: undefined,
    HOME: home,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const homeSlots = join(home, ".cache", "gate-dispatch");
  const rootLine = startupLineFor(result.stderr, homeSlots);
  assert.ok(rootLine, result.stderr);
  assert.match(rootLine, /\(from HOME\)/u);
  assert.ok(existsSync(homeSlots));
});

test("an invalid local slot count is a usage error before any lock is touched", (t) => {
  const repo = fixtureRepo(t, {});
  for (const value of ["", "0", "-1", "not-a-number", "1025", "9223372036854775808"]) {
    const cache = busyCache(t);
    const result = runDispatch(repo, cache, [repo.head, "--master", repo.head, "--allow-local"], {
      AGENTOS_GATE_PRIMARY_SERVER: "",
      AGENTOS_GATE_FALLBACK_SERVER: "",
      AGENTOS_GATE_LOCAL_SLOTS: value,
    });
    assert.equal(result.status, 2, `${value}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, new RegExp(`AGENTOS_GATE_LOCAL_SLOTS.*${value.replaceAll("-", "\\-")}`));
    assert.deepEqual(
      readdirSync(join(cache, "gate-dispatch")).filter((entry) => entry.endsWith(".slot")),
      [],
      `${value}: a slot lock was created before validation`,
    );
  }
});

test("the first startup line reports enabled local capacity and omits disabled local capacity", (t) => {
  const repo = fixtureRepo(t, {});
  const cases = [
    {
      args: [repo.head, "--master", repo.head, "--allow-local"],
      env: { AGENTOS_GATE_LOCAL_SLOTS: "2" },
      expected: /local\(2, explicit\)/u,
    },
    {
      args: [repo.head, "--master", repo.head, "--allow-local"],
      env: { AGENTOS_GATE_LOCAL_SLOTS: undefined },
      expected: /local\(1, explicit\)/u,
    },
    {
      args: [repo.head, "--master", repo.head],
      env: { AGENTOS_GATE_ALLOW_LOCAL: undefined, AGENTOS_GATE_LOCAL_SLOTS: undefined },
      expected: null,
    },
  ];
  for (const fixture of cases) {
    const result = dispatch(t, repo, fixture.args, fixture.env);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const firstLine = result.stderr.split(/\r?\n/u)[0];
    assert.match(firstLine, /^gate-dispatch: /u);
    if (fixture.expected) assert.match(firstLine, fixture.expected);
    else assert.doesNotMatch(firstLine, /local\(/u);
  }
});

test("the startup line normalizes a local slot count with leading zeroes", (t) => {
  const repo = fixtureRepo(t, {});
  const result = dispatch(t, repo, [repo.head, "--master", repo.head, "--allow-local"], {
    AGENTOS_GATE_LOCAL_SLOTS: "02",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr.split(/\r?\n/u)[0], /local\(2, explicit\)/u);
});

test("eligible local capacity runs before a configured remote worker", (t) => {
  const calls = join(scratch(t), "order.log");
  writeFileSync(calls, "");
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "local\\n" >> "$GATE_FIXTURE_CALLS"; printf "MERGE GATE: PASS local-first\\n"; exit 0',
    mirrorPush: 'printf "mirror\\n" >> "$GATE_FIXTURE_CALLS"; exit 1',
    remoteGate: 'printf "remote\\n" >> "$GATE_FIXTURE_CALLS"; exit 1',
  });
  const result = dispatch(t, repo, [repo.head, "--server", "primary", "--allow-local"], {
    AGENTOS_GATE_LOCAL_SLOTS: "2",
    GATE_FIXTURE_CALLS: calls,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS local-first/u);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["local"]);
  assert.match(result.stderr, /local\(2, explicit\)/u);
  assert.doesNotMatch(result.stderr, /running on primary/u);
});

test("an ineligible local machine falls through to the remote worker", (t) => {
  const calls = join(scratch(t), "order.log");
  writeFileSync(calls, "");
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "local\\n" >> "$GATE_FIXTURE_CALLS"; exit 1',
    mirrorPush: 'printf "mirror\\n" >> "$GATE_FIXTURE_CALLS"; printf "MIRROR PUSH: OK\\n"; exit 0',
    remoteGate: 'printf "remote\\n" >> "$GATE_FIXTURE_CALLS"; printf "MERGE GATE: PASS remote-after-ineligible-local\\n"; exit 0',
  });
  writeFileSync(join(repo.root, "dirty.txt"), "dirty\\n");
  const result = dispatch(t, repo, [repo.head, "--server", "primary", "--allow-local"], {
    AGENTOS_GATE_LOCAL_SLOTS: "2",
    GATE_FIXTURE_CALLS: calls,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS remote-after-ineligible-local/u);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["mirror", "remote"]);
  assert.match(result.stderr, /running on primary/u);
});

test("a local no-verdict retires local capacity and falls through to the remote worker", (t) => {
  const calls = join(scratch(t), "order.log");
  writeFileSync(calls, "");
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "local\\n" >> "$GATE_FIXTURE_CALLS"; printf "GATE NOT RUN: local unavailable\\n"; exit 76',
    mirrorPush: 'printf "mirror\\n" >> "$GATE_FIXTURE_CALLS"; printf "MIRROR PUSH: OK\\n"; exit 0',
    remoteGate:
      'printf "remote\\n" >> "$GATE_FIXTURE_CALLS"; printf "MERGE GATE: PASS remote-after-local-no-verdict\\n"; exit 0',
  });
  const result = dispatch(t, repo, [repo.head, "--server", "primary", "--allow-local"], {
    AGENTOS_GATE_LOCAL_SLOTS: "2",
    GATE_FIXTURE_CALLS: calls,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS remote-after-local-no-verdict/u);
  assert.doesNotMatch(result.stdout, /GATE NOT RUN: local unavailable/u);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["local", "mirror", "remote"]);
  assert.match(
    result.stderr,
    /local produced no verdict \(exit 76\); retiring local capacity and trying remaining capacity/u,
  );
  assert.match(result.stderr, /local said: GATE NOT RUN: local unavailable/u);
});

test("a fallback without a primary is a usage error", (t) => {
  const repo = fixtureRepo(t, {});
  const result = dispatch(t, repo, [repo.head], {
    AGENTOS_GATE_PRIMARY_SERVER: "",
    AGENTOS_GATE_FALLBACK_SERVER: "fallback",
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /fallback worker requires a primary worker/u);
});

test("an explicitly enabled local PASS comes back as 0 with the gate's own verdict line", (t) => {
  const repo = fixtureRepo(t, {});
  const result = dispatch(t, repo, [repo.head, "--server", "primary", "--allow-local"], {}, ["remote-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS/);
});

test("an explicitly enabled local FAIL comes back as 1, unchanged", (t) => {
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "MERGE GATE: FAIL (stub)\\n"; exit 1',
  });
  const result = dispatch(t, repo, [repo.head, "--server", "primary", "--allow-local"], {}, ["remote-1"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MERGE GATE: FAIL/);
});

test("NOT AUTHORITATIVE keeps its own code", (t) => {
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "MERGE GATE: NOT AUTHORITATIVE\\n"; exit 3',
  });
  const result = dispatch(t, repo, [repo.head, "--server", "primary", "--allow-local"], {}, ["remote-1"]);
  assert.equal(result.status, 3);
});

test("a failed mirror push is 76 and not a FAIL", (t) => {
  // The regression: this used to exit 1 while printing "no gate was run", so an
  // automation reading the exit code could not tell a transport problem from a
  // judgement about the commit.
  const repo = fixtureRepo(t, {
    mirrorPush: 'printf "mirror-push: broken\\n" >&2; exit 1',
  });
  // Dirty the tree so the local slot is ineligible and the dispatch must go
  // remote, which is the path the push is on.
  writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 76, result.stderr);
  assert.match(result.stdout, /^GATE NOT RUN: /m);
  assert.doesNotMatch(result.stdout, /MERGE GATE: FAIL/);
});

test("local capacity is not used without the explicit opt-in", (t) => {
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "UNEXPECTED LOCAL\\n"; exit 1',
    remoteGate: 'printf "MERGE GATE: PASS remote-without-local-opt-in\\n"; exit 0',
  });
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote-without-local-opt-in/);
  assert.doesNotMatch(result.stdout, /UNEXPECTED LOCAL/);
  assert.match(result.stderr, /running on primary/);
});

test("local capacity is used when it is explicitly opted in", (t) => {
  const repo = fixtureRepo(t, {
    mergeGate: 'printf "MERGE GATE: PASS explicit-local\\n"; exit 0',
    remoteGate: 'printf "REMOTE SHOULD NOT RUN\\n"; exit 1',
  });
  const result = dispatch(t, repo, [repo.head, "--server", "primary", "--allow-local"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /explicit-local/);
  assert.doesNotMatch(result.stdout, /REMOTE SHOULD NOT RUN/);
  assert.match(result.stderr, /local slot/);
});

test("the remote path's exit code is passed through unchanged", (t) => {
  const repo = fixtureRepo(t, {
    remoteGate: 'printf "GATE NOT RUN: stub precondition\\n"; exit 76',
  });
  writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
  const result = dispatch(t, repo, [repo.head, "--server", "primary"]);
  assert.equal(result.status, 76, result.stderr);
  assert.match(result.stdout, /GATE NOT RUN/);
});

test("the remote path receives the exact candidate and frozen baseline", (t) => {
  const repo = fixtureRepo(t, {
    mirrorPush: 'printf "mirror args: %s\\n" "$*" >&2',
    remoteGate: 'printf "remote args: %s\\n" "$*" >&2; printf "MERGE GATE: PASS stub\\n"',
  });
  writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`mirror args: .*--candidate ${repo.head} --baseline ${repo.head}`));
  assert.match(result.stderr, new RegExp(`remote args: .*${repo.head} --master ${repo.head}`));
});

// The dispatcher's slot count and the worker's worker-capacity are one number
// stored twice, and drift between them is otherwise invisible: the surplus
// dispatch waits on the worker's execution lock with nothing to show for it.
// run-gate.sh states the worker's number in output remote-gate.sh already
// transports back, so the dispatcher can compare the two without a second ssh.
// What is under test is that the comparison stays a remark: the verdict, the
// exit code and stdout are what they would have been either way.
test("a primary worker whose capacity differs from the configured slots is called out", (t) => {
  const repo = fixtureRepo(t, {
    remoteGate: "printf 'run-gate: worker capacity 1, host share 2\\n'; printf 'MERGE GATE: PASS stub\\n'; exit 0",
  });
  // The default fixture environment configures a primary and a fallback, which
  // is the two-slot primary; the worker above claims one.
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // stdout is the worker's own output, transported verbatim as before.
  assert.equal(result.stdout.trim(), "run-gate: worker capacity 1, host share 2\nMERGE GATE: PASS stub");
  assert.match(
    result.stderr,
    /warning — the primary worker reports worker-capacity 1 but this dispatcher configures 2 primary slot\(s\)/u,
  );
});

test("a primary worker whose capacity matches the configured slots is not remarked on", (t) => {
  const repo = fixtureRepo(t, {
    remoteGate: "printf 'run-gate: worker capacity 1, host share 2\\n'; printf 'MERGE GATE: PASS stub\\n'; exit 0",
  });
  // --server is the one-slot form, so the worker's one is the same number.
  const result = dispatch(t, repo, [repo.head, "--server", "primary"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), "run-gate: worker capacity 1, host share 2\nMERGE GATE: PASS stub");
  assert.doesNotMatch(result.stderr, /worker-capacity/u);
});

test("a primary worker that states no capacity is silence, not a complaint", (t) => {
  // An older worker, or an attempt that never reached one. Neither is evidence
  // of drift, and a warning about the missing line would be noise on every
  // dispatch until the worker is upgraded.
  const repo = fixtureRepo(t, {
    remoteGate: "printf 'MERGE GATE: PASS stub\\n'; exit 0",
  });
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), "MERGE GATE: PASS stub");
  assert.doesNotMatch(result.stderr, /worker-capacity/u);
});

test("origin HEAD discovery retries transient git failures before dispatch", (t) => {
  const repo = fixtureRepo(t, {});
  const shim = scratch(t);
  const counter = join(shim, "ls-remote-count");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const gitShim = join(shim, "git");
  writeFileSync(gitShim, `#!/usr/bin/env bash
if [ "$1" = "-C" ] && [ "$3" = "ls-remote" ]; then
  count=0
  [ ! -f "$GATE_GIT_COUNTER" ] || count="$(cat "$GATE_GIT_COUNTER")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$GATE_GIT_COUNTER"
  [ "$count" -gt 2 ] || exit 1
fi
exec "$REAL_GIT" "$@"
`);
  chmodSync(gitShim, 0o755);
  const result = dispatch(t, repo, [repo.head], {
    PATH: `${shim}:${process.env.PATH}`,
    REAL_GIT: realGit,
    GATE_GIT_COUNTER: counter,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(counter, "utf8").trim(), "4");
  assert.match(result.stderr, /origin HEAD read failed; retrying attempt=2\/3/u);
  assert.match(result.stderr, /origin HEAD read failed; retrying attempt=3\/3/u);
});

test("origin default-ref fetch retries transient git failures before dispatch", (t) => {
  const repo = fixtureRepo(t, {});
  const shim = scratch(t);
  const counter = join(shim, "fetch-count");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const gitShim = join(shim, "git");
  writeFileSync(gitShim, `#!/usr/bin/env bash
if [ "$1" = "-C" ] && [ "$3" = "fetch" ]; then
  count=0
  [ ! -f "$GATE_FETCH_COUNTER" ] || count="$(cat "$GATE_FETCH_COUNTER")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$GATE_FETCH_COUNTER"
  [ "$count" -gt 2 ] || exit 1
fi
exec "$REAL_GIT" "$@"
`);
  chmodSync(gitShim, 0o755);
  const result = dispatch(t, repo, [repo.head], {
    PATH: `${shim}:${process.env.PATH}`,
    REAL_GIT: realGit,
    GATE_FETCH_COUNTER: counter,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(counter, "utf8").trim(), "3");
  assert.match(result.stderr, /origin ref fetch failed; retrying attempt=2\/3/u);
  assert.match(result.stderr, /origin ref fetch failed; retrying attempt=3\/3/u);
});

test("a configured single server is consumed by the dispatcher before child tools", (t) => {
  const repo = fixtureRepo(t, {
    mirrorPush: 'test -z "${AGENTOS_GATE_SERVER:-}"; test "$1" = single-worker; printf "MIRROR PUSH: OK\\n"',
    remoteGate: 'test -z "${AGENTOS_GATE_SERVER:-}"; test "$1" = single-worker; printf "MERGE GATE: PASS single-server\\n"',
  });
  const result = dispatch(t, repo, [repo.head], { AGENTOS_GATE_SERVER: "single-worker" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS single-server/u);
  assert.match(result.stderr, /primary single-worker\(1\)/u);
  assert.doesNotMatch(result.stderr, /fallback/u);
});

test("an ssh transport failure retries the exact gate on the fallback", (t) => {
  const repo = fixtureRepo(t, {
    remoteGate:
      'if [ "$1" = primary ]; then printf "GATE NOT RUN: ssh dropped\\n"; exit 255; fi; printf "MERGE GATE: PASS fallback\\n"',
  });
  writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^MERGE GATE: PASS fallback$/m);
  assert.doesNotMatch(result.stdout, /GATE NOT RUN/);
  assert.match(result.stderr, /trying fallback capacity/);
  assert.match(result.stderr, /running on fallback/);
});

test("a worker whose docker daemon is down sends the gate to the fallback", (t) => {
  // The shape the gate's own preflight now produces, carried the whole way. A
  // host with no reachable daemon judged nothing, so 76 and the `GATE NOT RUN:`
  // line are what merge-gate.sh reports; the dispatcher must read that as
  // capacity that could not run rather than as a verdict, and take the same
  // commit to the fallback worker. While the preflight exited 1 the dispatcher
  // stopped here and published `MERGE GATE: FAIL (docker preflight)` — a
  // judgement about a commit that no gate had run a step against.
  const repo = fixtureRepo(t, {
    remoteGate:
      'if [ "$1" = primary ]; then printf "GATE NOT RUN: the docker daemon on this host is not reachable\\n"; exit 76; fi;'
      + ' printf "MERGE GATE: PASS fallback-after-docker-preflight\\n"',
  });
  writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^MERGE GATE: PASS fallback-after-docker-preflight$/m);
  assert.doesNotMatch(result.stdout, /MERGE GATE: FAIL/u);
  assert.match(result.stderr, /primary produced no verdict \(exit 76\); trying fallback capacity/u);
  assert.match(result.stderr, /primary said: GATE NOT RUN: the docker daemon on this host is not reachable/u);
});

test("a primary FAIL is final and never falls back", (t) => {
  const repo = fixtureRepo(t, {
    remoteGate:
      'if [ "$1" = primary ]; then printf "MERGE GATE: FAIL (candidate)\\n"; exit 1; fi; printf "FALLBACK SHOULD NOT RUN\\n"',
  });
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /MERGE GATE: FAIL/);
  assert.doesNotMatch(result.stdout + result.stderr, /FALLBACK SHOULD NOT RUN/);
});

test("every slot busy times out at 75 with no verdict", (t) => {
  const repo = fixtureRepo(t, {});
  const cache = busyCache(t, ["remote-1", "remote-1-2", "remote-2"]);
  const result = runDispatch(repo, cache, [repo.head, "--timeout-minutes", "0"]);
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stdout, /GATE DISPATCH: NO SLOT/);
  assert.doesNotMatch(result.stdout, /MERGE GATE/);
});

test("locks that cannot be operated are 76 at once, not 75 after the timeout", (t) => {
  // The regression, and the reason 75 and 76 exist separately. Every slot lock
  // here is unusable — the slot root is read-only — and the old helper answered
  // "busy" for that, so the dispatcher polled until its timeout and then said
  // GATE DISPATCH: NO SLOT, which told the operator to come back later for a
  // slot that was never going to open. There is nothing to wait for, so this
  // must come back immediately and say what to clear.
  const repo = fixtureRepo(t, {});
  const cache = busyCache(t);
  const slots = join(cache, "gate-dispatch");
  chmodSync(slots, 0o555);
  const started = Date.now();
  // One minute: long enough that polling would be unmistakable in the elapsed
  // time, short enough that a regression here fails the suite instead of
  // hanging it.
  const result = runDispatch(repo, cache, [repo.head, "--timeout-minutes", "1"]);
  chmodSync(slots, 0o755);
  assert.equal(result.status, 76, result.stderr);
  assert.match(result.stdout, /^GATE NOT RUN: /m);
  assert.doesNotMatch(result.stdout, /GATE DISPATCH: NO SLOT/);
  assert.doesNotMatch(result.stdout, /MERGE GATE/);
  // It did not wait: a --timeout-minutes 1 run that returns in seconds is the
  // observable difference between "nothing can be locked" and "everything is
  // busy".
  assert.ok(Date.now() - started < 20_000, "it polled instead of answering at once");
});

test("one busy desktop slot uses the second desktop slot before fallback", (t) => {
  const repo = fixtureRepo(t, {});
  const result = runDispatch(repo, busyCache(t, ["remote-1"]), [repo.head]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS/);
  assert.match(result.stderr, /running on primary/);
  assert.doesNotMatch(result.stderr, /running on fallback/);
});

test("two busy desktop slots spill onto the fallback without using the Mac", (t) => {
  const repo = fixtureRepo(t, {});
  const result = runDispatch(repo, busyCache(t, ["remote-1", "remote-1-2"]), [repo.head], {
    GATE_DISPATCH_FALLBACK_AFTER_MINUTES: "0",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS/);
  assert.match(result.stderr, /running on fallback/);
  assert.doesNotMatch(result.stderr, /local slot/);
});

// Only the clock and sleep are replaced; slot locking and dispatch remain real.
const dispatchClock = (t) => {
  const shim = scratch(t);
  const clock = join(shim, "clock");
  writeFileSync(clock, "1000");
  const realDate = execFileSync("which", ["date"], { encoding: "utf8" }).trim();
  writeFileSync(join(shim, "date"), `#!/usr/bin/env bash
if [ "$1" = "+%s" ]; then cat "$TEST_CLOCK"; else exec "$TEST_REAL_DATE" "$@"; fi
`);
  writeFileSync(join(shim, "sleep"), `#!/usr/bin/env bash
printf '%s' "$(( $(cat "$TEST_CLOCK") + 60 ))" > "$TEST_CLOCK"
`);
  chmodSync(join(shim, "date"), 0o755);
  chmodSync(join(shim, "sleep"), 0o755);
  return {
    clock,
    env: { PATH: `${shim}:${process.env.PATH}`, TEST_CLOCK: clock, TEST_REAL_DATE: realDate },
  };
};

test("fallback is held during the default grace period", (t) => {
  const repo = fixtureRepo(t, {});
  const { env, clock } = dispatchClock(t);
  const result = runDispatch(repo, busyCache(t, ["remote-1", "remote-1-2"]),
    [repo.head, "--timeout-minutes", "1"], env);
  assert.equal(result.status, 75, result.stderr);
  assert.doesNotMatch(result.stderr, /running on fallback/u);
  assert.match(result.stderr, /fallback after 6 min; waited 0/u);
  assert.equal(readFileSync(clock, "utf8"), "1060");
});

test("fallback is tried at the default grace boundary after polling primary", (t) => {
  const repo = fixtureRepo(t, {});
  const { env, clock } = dispatchClock(t);
  const result = runDispatch(repo, busyCache(t, ["remote-1", "remote-1-2"]),
    [repo.head, "--timeout-minutes", "10"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /trying fallback.*fallback after 6 min; waited 6/u);
  assert.match(result.stderr, /running on fallback/u);
  assert.equal(readFileSync(clock, "utf8"), "1360");
});

test("busy fallback logs each grace transition only once", (t) => {
  const repo = fixtureRepo(t, {});
  const { env, clock } = dispatchClock(t);
  const result = runDispatch(repo, busyCache(t, ["remote-1", "remote-1-2", "remote-2"]),
    [repo.head, "--timeout-minutes", "10"], env);
  assert.equal(result.status, 75, result.stderr);
  assert.equal((result.stderr.match(/polling every/gu) ?? []).length, 1);
  assert.equal((result.stderr.match(/trying fallback capacity/gu) ?? []).length, 1);
  assert.match(result.stderr, /fallback after 6 min; waited 6/u);
  assert.equal(readFileSync(clock, "utf8"), "1600");
});

test("empty fallback grace uses the default", (t) => {
  const repo = fixtureRepo(t, {});
  const { env, clock } = dispatchClock(t);
  const result = runDispatch(repo, busyCache(t, ["remote-1", "remote-1-2"]),
    [repo.head, "--timeout-minutes", "10"], { ...env, GATE_DISPATCH_FALLBACK_AFTER_MINUTES: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /fallback after 6 min; waited 6/u);
  assert.equal(readFileSync(clock, "utf8"), "1360");
});

test("a primary slot freed during grace handles the gate before fallback", (t) => {
  const repo = fixtureRepo(t, {});
  const cache = busyCache(t, ["remote-1", "remote-1-2"]);
  const { env, clock } = dispatchClock(t);
  writeFileSync(join(dirname(clock), "sleep"), `#!/usr/bin/env bash
printf '1060' > "$TEST_CLOCK"
rm "$TEST_PRIMARY_SLOT"
`);
  const result = runDispatch(repo, cache, [repo.head], {
    ...env,
    TEST_PRIMARY_SLOT: join(cache, "gate-dispatch", "remote-1-2.slot"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /running on primary/u);
  assert.doesNotMatch(result.stderr, /running on fallback/u);
  assert.equal(readFileSync(clock, "utf8"), "1060");
});

test("a slot that changes hands restarts the timeout instead of ending the wait", (t) => {
  // The 2026-09-06 production shape: many runners behind one slot, each gate
  // 5-8 minutes, and a fixed wall that cut the tail of the queue off mid-wait
  // so it re-dispatched at the back. Turnover is the queue moving, and a
  // dispatch that is moving up the queue keeps its place.
  const repo = fixtureRepo(t, {});
  const cache = busyCache(t, ["remote-1", "remote-1-2"]);
  // A real live pid, because a lock naming a dead one is reclaimed rather than
  // waited on, and the point here is a slot that stays busy under a new owner.
  const successor = spawn("sleep", ["300"]);
  t.after(() => successor.kill());
  const { env, clock } = dispatchClock(t);
  writeFileSync(join(dirname(clock), "sleep"), `#!/usr/bin/env bash
printf '%s' "$(( $(cat "$TEST_CLOCK") + 60 ))" > "$TEST_CLOCK"
if [ ! -e "$TEST_TURNOVER" ]; then
  printf '%s\n' "$TEST_SUCCESSOR" > "$TEST_SLOT"
  : > "$TEST_TURNOVER"
fi
`);
  const result = runDispatch(repo, cache, [repo.head, "--timeout-minutes", "2"], {
    ...env,
    TEST_SLOT: join(cache, "gate-dispatch", "remote-1.slot"),
    TEST_SUCCESSOR: String(successor.pid),
    TEST_TURNOVER: join(cache, "turned-over"),
  });
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /the queue moved \(slot remote-1 changed hands\)/u);
  // 1000 start, turnover observed at 1060, so the two-minute stagnation timeout
  // runs from there and the wait ends at 1180 — a minute past the fixed wall
  // the old dispatcher would have hit at 1120.
  assert.equal(readFileSync(clock, "utf8"), "1180");
  assert.match(result.stderr, /no slot freed up or changed hands in 2 minutes/u);
});

test("a configured grace period controls the fallback boundary", (t) => {
  const repo = fixtureRepo(t, {});
  const { env, clock } = dispatchClock(t);
  const result = runDispatch(repo, busyCache(t, ["remote-1", "remote-1-2"]),
    [repo.head, "--timeout-minutes", "10"], { ...env, GATE_DISPATCH_FALLBACK_AFTER_MINUTES: "02" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /trying fallback.*fallback after 2 min; waited 2/u);
  assert.equal(readFileSync(clock, "utf8"), "1120");
});

test("zero grace tries fallback immediately", (t) => {
  const repo = fixtureRepo(t, {});
  const { env, clock } = dispatchClock(t);
  const result = runDispatch(repo, busyCache(t, ["remote-1", "remote-1-2"]), [repo.head],
    { ...env, GATE_DISPATCH_FALLBACK_AFTER_MINUTES: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /running on fallback/u);
  assert.equal(readFileSync(clock, "utf8"), "1000");
});

test("single-server mode remains unaffected by fallback grace", (t) => {
  const repo = fixtureRepo(t, {});
  const { env, clock } = dispatchClock(t);
  const result = runDispatch(repo, busyCache(t, ["remote-1"]),
    [repo.head, "--server", "single-worker", "--timeout-minutes", "1"], env);
  assert.equal(result.status, 75, result.stderr);
  assert.doesNotMatch(result.stderr, /fallback/u);
  assert.equal(readFileSync(clock, "utf8"), "1060");
});

test("a broken primary slot bypasses the busy-primary grace period", (t) => {
  const repo = fixtureRepo(t, {});
  const cache = busyCache(t, ["remote-1"]);
  mkdirSync(join(cache, "gate-dispatch", "remote-1-2.lock"));
  const result = runDispatch(repo, cache, [repo.head]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /running on fallback/u);
});

test("invalid fallback grace fails before any slot is tried", (t) => {
  const repo = fixtureRepo(t, {});
  for (const value of ["-1", "1.5", "no", "9999999999999999999", "35791395"]) {
    const result = dispatch(t, repo, [repo.head], { GATE_DISPATCH_FALLBACK_AFTER_MINUTES: value });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /GATE_DISPATCH_FALLBACK_AFTER_MINUTES needs/u);
    assert.doesNotMatch(result.stderr, /running on/u);
  }
});

test("busy plus broken waits out the timeout and then reports 76, not 75", (t) => {
  // The mixed case. One slot is genuinely busy, so waiting is justified and the
  // dispatch must not give up early — but when the wait ends empty, the answer
  // is not "the queue was full": one of the three slots was never available to
  // anybody, and 75 would send the operator to re-dispatch into the same broken
  // locks. Nothing may be taken here either, so the capacity limit holds.
  const repo = fixtureRepo(t, {});
  const cache = busyCache(t, ["remote-1", "remote-1-2"]);
  const slots = join(cache, "gate-dispatch");
  mkdirSync(join(slots, "remote-2.lock"));
  const result = runDispatch(repo, cache, [repo.head, "--timeout-minutes", "0"], {
    GATE_DISPATCH_FALLBACK_AFTER_MINUTES: "0",
  });
  assert.equal(result.status, 76, result.stderr);
  assert.match(result.stdout, /^GATE NOT RUN: /m);
  assert.doesNotMatch(result.stdout, /GATE DISPATCH: NO SLOT/);
  assert.equal(readFileSync(join(slots, "remote-1.slot"), "utf8").trim(), String(process.pid));
});

test("remote processes that die without a verdict exhaust fallback as 76", (t) => {
  const repo = fixtureRepo(t, { remoteGate: "exit 137" });
  const result = dispatch(t, repo, [repo.head]);
  assert.equal(result.status, 76);
  assert.doesNotMatch(result.stdout, /MERGE GATE/);
  assert.match(result.stdout, /^GATE NOT RUN:/m);
});

test("the dispatcher releases its slot when the gate ends", (t) => {
  const repo = fixtureRepo(t, {});
  const cache = busyCache(t);
  const result = runDispatch(repo, cache, [repo.head]);
  assert.equal(result.status, 0, result.stderr);
  const check = spawnSync("test", ["-e", join(cache, "gate-dispatch", "remote-1.slot")]);
  assert.notEqual(check.status, 0, "the remote slot was not released");
});

test("a destination that is not an ssh destination is refused before anything is sent", (t) => {
  const repo = fixtureRepo(t, {});
  const result = dispatch(t, repo, [repo.head, "--server", "host; rm -rf /"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not a usable primary ssh destination/);
});

test("documented gate-worker invocations name their checkout explicitly", () => {
  const workspacePrefix = 'AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)"';
  const commandPath = "packages/runner/runtime-tools/(?:gate-worker/)?(?:gate-dispatch|mirror-push|remote-gate|regression-verification)\\.sh";
  const files = [
    join(here, "..", "..", "docs", "runbooks", "gate-worker.md"),
    join(here, "..", "..", "CONTRIBUTING.md"),
  ];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const codeBlocks = [...source.matchAll(/```sh\n([\s\S]*?)```/gu)].map((match) => match[1]);
    const inlineCommands = [
      ...source.matchAll(/`([^`]*(?:scripts\/|packages\/runner\/runtime-tools\/)[^`]+)`/gu),
    ].map((match) => match[1]);
    const commands = [...codeBlocks, ...inlineCommands]
      .flatMap((block) => block.replace(/\\\r?\n[ \t]*/gu, " ").split(/\r?\n/gu))
      .filter((line) => new RegExp(commandPath, "u").test(line));

    assert.ok(commands.length > 0, `${file} has no documented gate-worker invocations`);
    for (const command of commands) {
      assert.ok(command.trim().startsWith(workspacePrefix), command);
    }
  }
});
