// Fixtures for the gate worker's harness and for the values its local-side
// scripts are allowed to send.
//
// Three things are proved here, and each is something that has already been
// wrong once.
//
// 1. Credentials are not a worker precondition. Provisioning and gate execution
//    must not fail merely because the trusted operator VM carries credentials.
//
// 2. Repository names, gate homes, ssh destinations and ref names become part
//    of a command string a remote login shell parses. `.` and `..` were
//    accepted as repository names; `--gate-home` was not checked at all. These
//    are the allowlists, tested as allowlists: what is refused matters more
//    than what is accepted.
//
// 3. `run-gate.sh` must not report the worker's own state as a verdict about a
//    commit. A missing mirror or a commit that was never pushed is not something
//    the gate decided, and each is
//    checked to exit 76 with a GATE NOT RUN line rather than 1 with a
//    MERGE GATE: FAIL line.
//
// 4. What the worker's isolation is claimed to be. The operator's ruling of 2026-08-20
//    is that no network egress control is required: the deterministic boundary
//    is the exact pushed objects, no mirror remote and no merge authority; the box is NOT
//    network-isolated. The failure mode this guards is a document drifting back
//    into "the worker cannot reach GitHub", which would be an isolation claim
//    nothing enforces.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureEnv } from "./gate-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeTools = join(here, "..", "..", "packages", "runner", "runtime-tools");
const runtimeGateWorker = join(runtimeTools, "gate-worker");
const runnerToolNames = new Set(["lib.sh", "gate-dispatch.sh", "mirror-push.sh", "remote-gate.sh", "run-gate.sh"]);
const toolPath = (name) => join(runnerToolNames.has(name) ? runtimeGateWorker : here, name);
const libPath = toolPath("lib.sh");
const mergeGatePath = join(here, "..", "merge-gate.sh");
const runGatePath = toolPath("run-gate.sh");
const dispatchPath = toolPath("gate-dispatch.sh");
const mirrorPushPath = toolPath("mirror-push.sh");
const remoteGatePath = toolPath("remote-gate.sh");
const provisionPath = join(here, "provision.sh");
const runbookPath = join(here, "..", "..", "docs", "runbooks", "gate-worker.md");

const test = (name, body) => nodeTest(name, { concurrency: true }, body);

// What the gate reads out of the environment, and which of it a fixture may
// inherit, is one question with one answer; it used to be 26 identical lines
// here and 26 more in the sibling fixture file, and one of the three commits
// that edited them landed in only one of the two.
const FIXTURE_ENV = fixtureEnv("gate-worker-fixture");

const scratch = (t) => {
  const root = mkdtempSync(join(tmpdir(), "gate-worker-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: FIXTURE_ENV }).trim();

// --- worker provisioning contract -------------------------------------------

test("provisioning includes the native Node build/runtime dependencies and Git identity", () => {
  const source = readFileSync(provisionPath, "utf8");
  for (const pkg of ["jq", "python3", "build-essential", "libatomic1"]) {
    assert.match(source, new RegExp(`for pkg in [^\\n]*\\b${pkg}\\b`), `${pkg} is not provisioned`);
  }
  assert.match(source, /git config --global user\.name/);
  assert.match(source, /git config --global user\.email/);
  assert.match(source, /vmware-toolbox-cmd timesync disable/);
  assert.match(source, /timedatectl set-ntp true/);
  assert.doesNotMatch(source, /SECRET_VARS=/);
  assert.doesNotMatch(readFileSync(runGatePath, "utf8"), /SECRET_VARS=/);
});

// --- what may reach a remote shell -------------------------------------------

const lib = (call) =>
  spawnSync("bash", ["-c", `set -uo pipefail\n. "${libPath}"\n${call}`], { encoding: "utf8" });

const accepts = (fn, value) => lib(`${fn} '${value.replace(/'/g, "'\\''")}'`);

test("gate_valid_home refuses everything that is not a plain relative path", () => {
  for (const good of ["gate", "gate/nested", "srv.gates/agentos_1", "a-b/c.d"]) {
    assert.equal(accepts("gate_valid_home", good).status, 0, `rejected ${good}`);
  }
  for (const bad of [
    "",
    "/absolute",
    "-flag",
    "..",
    "../escape",
    "gate/..",
    "gate/../..",
    ".",
    "gate/./x",
    "gate//x",
    "gate/",
    "gate home",
    "gate;id",
    "gate$(id)",
    "gate`id`",
    'gate"x',
    "gate&&id",
    "gate|id",
    "gate\nid",
  ]) {
    assert.equal(accepts("gate_valid_home", bad).status, 1, `accepted ${JSON.stringify(bad)}`);
  }
});

test("gate_valid_server refuses everything that is not an ssh destination", () => {
  for (const good of ["agentos-gate", "user@host", "host.example.com", "u_1@10.0.0.1"]) {
    assert.equal(accepts("gate_valid_server", good).status, 0, `rejected ${good}`);
  }
  for (const bad of ["", "-oProxyCommand=id", "host;id", "host:path", "host $(id)", "host|id"]) {
    assert.equal(accepts("gate_valid_server", bad).status, 1, `accepted ${JSON.stringify(bad)}`);
  }
});

test("gate_valid_ref refuses anything that is not a plain branch ref", () => {
  for (const good of ["refs/heads/main", "refs/heads/release/v1.2", "refs/heads/a_b.c-d"]) {
    assert.equal(accepts("gate_valid_ref", good).status, 0, `rejected ${good}`);
  }
  for (const bad of [
    "",
    "main",
    "refs/heads/",
    "refs/tags/v1",
    "refs/heads/..",
    "refs/heads/a/../b",
    "refs/heads/a b",
    "refs/heads/a;id",
    "refs/heads/-x",
  ]) {
    assert.equal(accepts("gate_valid_ref", bad).status, 1, `accepted ${JSON.stringify(bad)}`);
  }
});

// gate_repo_name reads the name off origin's URL, so the cases are URLs.
const repoNameOf = (t, originUrl) => {
  const root = scratch(t);
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", originUrl);
  return spawnSync("bash", ["-c", `set -uo pipefail\n. "${libPath}"\ngate_repo_name "${root}"`], {
    encoding: "utf8",
  });
};

test("gate_repo_name takes an ordinary repository name off origin", (t) => {
  const result = repoNameOf(t, "https://github.com/mosonlab/agentos-public.git");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "agentos-public");
});

test("gate_repo_name refuses a name that is a path segment with a meaning", (t) => {
  // `https://host/..git` reduces to `.`, which would collapse a repository's
  // directory onto the gate root and fold every repository's mirror together.
  assert.equal(repoNameOf(t, "https://example.com/..git").status, 1);
  // `https://host/...git` reduces to `..`, which walks out of the gate root.
  assert.equal(repoNameOf(t, "https://example.com/...git").status, 1);
});

test("gate_repo_name refuses a name carrying remote shell syntax", (t) => {
  for (const url of [
    "https://example.com/a;id.git",
    "https://example.com/a b.git",
    "https://example.com/$(id).git",
    "https://example.com/-x.git",
  ]) {
    assert.equal(repoNameOf(t, url).status, 1, `accepted ${url}`);
  }
});

test("a first-deployment mirror dry-run describes creation without pushing into an absent mirror", (t) => {
  const root = scratch(t);
  const repo = join(root, "source");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "packages", "runner", "runtime-tools", "gate-worker"), { recursive: true });
  writeFileSync(join(repo, "scripts", "merge-gate.sh"), "#!/usr/bin/env bash\nexit 0\n");
  cpSync(mirrorPushPath, join(repo, "packages", "runner", "runtime-tools", "gate-worker", "mirror-push.sh"));
  cpSync(libPath, join(repo, "packages", "runner", "runtime-tools", "gate-worker", "lib.sh"));
  cpSync(runGatePath, join(repo, "packages", "runner", "runtime-tools", "gate-worker", "run-gate.sh"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", "https://example.invalid/mosonlab/agentos-public.git");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  const oid = git(repo, "rev-parse", "HEAD");

  const fakeHome = join(root, "worker-home");
  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "ssh"),
    `#!/usr/bin/env bash
set -uo pipefail
while [ $# -gt 0 ]; do
  case "$1" in
    -p|-o|-i|-F) shift 2 ;;
    -n|-T|-x) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || exit 2
shift
cd "$FAKE_SSH_HOME"
exec bash -c "$*"
`,
  );
  chmodSync(join(fakeBin, "ssh"), 0o755);

  const result = spawnSync(
    "bash",
    [join(repo, "packages", "runner", "runtime-tools", "gate-worker", "mirror-push.sh"), "fake", "--candidate", oid, "--baseline", oid, "--dry-run"],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...FIXTURE_ENV,
        AGENTOS_WORKSPACE_PATH: repo,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_SSH_HOME: fakeHome,
      },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /would create the bare mirror/);
  assert.match(result.stdout, /MIRROR PUSH: DRY RUN OK/);
  assert.equal(existsSync(join(fakeHome, "gate", "agentos-public", "mirror.git")), false);
});

test("mirror push retries two transient push failures before succeeding", (t) => {
  const root = scratch(t);
  const repo = join(root, "source");
  mkdirSync(join(repo, "scripts", "gate-worker"), { recursive: true });
  mkdirSync(join(repo, "packages", "runner", "runtime-tools", "gate-worker"), { recursive: true });
  writeFileSync(join(repo, "scripts", "merge-gate.sh"), "#!/usr/bin/env bash\nexit 0\n");
  for (const name of ["mirror-push.sh", "lib.sh"]) {
    cpSync(toolPath(name), join(repo, "packages", "runner", "runtime-tools", "gate-worker", name));
  }
  cpSync(runGatePath, join(repo, "packages", "runner", "runtime-tools", "gate-worker", "run-gate.sh"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", "https://example.invalid/mosonlab/retry.git");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  const oid = git(repo, "rev-parse", "HEAD");

  const fakeHome = join(root, "worker-home");
  const mirror = join(fakeHome, "gate", "retry", "mirror.git");
  mkdirSync(join(fakeHome, "gate", "retry"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", mirror], { env: FIXTURE_ENV });

  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "ssh"), `#!/usr/bin/env bash
set -uo pipefail
if [ "\${1:-}" = "-G" ]; then exit 1; fi
while [ $# -gt 0 ]; do
  case "$1" in
    -p|-o|-i|-F) shift 2 ;;
    -n|-T|-x) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || exit 2
shift
cd "$FAKE_SSH_HOME"
exec bash -c "$*"
`);
  writeFileSync(join(fakeBin, "scp"), `#!/usr/bin/env bash
set -uo pipefail
while [ $# -gt 0 ]; do
  case "$1" in
    -P|-o) shift 2 ;;
    -q) shift ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || exit 2
destination="\${2#*:}"
cp "$1" "$FAKE_SSH_HOME/$destination"
`);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const pushCounter = join(root, "push-count");
  writeFileSync(join(fakeBin, "git"), `#!/usr/bin/env bash
is_push=0
for argument in "$@"; do
  [ "$argument" = push ] && is_push=1
done
if [ "$is_push" -eq 1 ]; then
  count=0
  [ ! -f "$PUSH_COUNTER" ] || count="$(cat "$PUSH_COUNTER")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$PUSH_COUNTER"
  [ "$count" -gt 2 ] || exit 1
fi
exec "$REAL_GIT" "$@"
`);
  for (const name of ["ssh", "scp", "git"]) chmodSync(join(fakeBin, name), 0o755);

  const result = spawnSync(
    "bash",
    [join(repo, "packages", "runner", "runtime-tools", "gate-worker", "mirror-push.sh"), "fake", "--candidate", oid, "--baseline", oid],
    {
      cwd: repo,
      encoding: "utf8",
      // Three real git pushes through a shim. Bounded so a wedged push still
      // fails the case, at the same budget as this file's siblings and sized for
      // the loaded gate worker (load1 20-55 observed, where a node or bash+git start alone can exceed 10s), not for an idle host.
      timeout: 60_000,
      env: {
        ...FIXTURE_ENV,
        AGENTOS_WORKSPACE_PATH: repo,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_SSH_HOME: fakeHome,
        REAL_GIT: realGit,
        PUSH_COUNTER: pushCounter,
      },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(pushCounter, "utf8").trim(), "3");
  assert.match(result.stderr, /exact-ref push failed; retrying attempt=2\/3/u);
  assert.match(result.stderr, /exact-ref push failed; retrying attempt=3\/3/u);
  assert.equal(git(mirror, "rev-parse", `refs/gate/candidates/${oid}^{commit}`), oid);
  assert.equal(git(mirror, "rev-parse", `refs/gate/baselines/${oid}^{commit}`), oid);
});

// --- exact-ref transport -----------------------------------------------------

test("dispatch transports a detached candidate and current baseline without mirroring an incomplete ref namespace", (t) => {
  const root = scratch(t);
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin], { env: FIXTURE_ENV });
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"], { env: FIXTURE_ENV });

  const source = join(root, "source");
  mkdirSync(join(source, "scripts", "gate-worker"), { recursive: true });
  mkdirSync(join(source, "packages", "runner", "runtime-tools", "gate-worker"), { recursive: true });
  for (const name of ["gate-dispatch.sh", "mirror-push.sh", "remote-gate.sh", "lib.sh"]) {
    cpSync(toolPath(name), join(source, "packages", "runner", "runtime-tools", "gate-worker", name));
  }
  cpSync(runGatePath, join(source, "packages", "runner", "runtime-tools", "gate-worker", "run-gate.sh"));
  writeFileSync(
    join(source, "scripts", "merge-gate.sh"),
    '#!/usr/bin/env bash\nprintf "MERGE GATE: PASS %s\\n" "$(git rev-parse HEAD)"\n',
  );
  chmodSync(join(source, "scripts", "merge-gate.sh"), 0o755);
  git(source, "init", "-q", "-b", "main");
  git(source, "remote", "add", "origin", origin);
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  const oldMain = git(source, "rev-parse", "HEAD");
  git(source, "push", "-q", "origin", "main");

  git(source, "checkout", "-q", "-b", "feature");
  writeFileSync(join(source, "candidate.txt"), "candidate\n");
  git(source, "add", "candidate.txt");
  git(source, "commit", "-q", "-m", "candidate");
  const candidate = git(source, "rev-parse", "HEAD");
  git(source, "push", "-q", "origin", "feature");

  git(source, "checkout", "-q", "main");
  writeFileSync(join(source, "baseline.txt"), "current baseline\n");
  git(source, "add", "baseline.txt");
  git(source, "commit", "-q", "-m", "advance baseline");
  const baseline = git(source, "rev-parse", "HEAD");
  git(source, "push", "-q", "origin", "main");

  const checkout = join(root, "checkout");
  execFileSync("git", ["clone", "-q", "--single-branch", "--branch", "feature", origin, checkout], { env: FIXTURE_ENV });
  git(checkout, "checkout", "-q", "--detach", candidate);
  git(checkout, "branch", "-D", "feature");
  git(checkout, "update-ref", "-d", "refs/remotes/origin/feature");
  assert.equal(git(checkout, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"), "");

  const fakeHome = join(root, "worker-home");
  const mirror = join(fakeHome, "gate", "origin", "mirror.git");
  mkdirSync(join(fakeHome, "gate", "origin"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", mirror], { env: FIXTURE_ENV });
  execFileSync("git", ["-C", mirror, "symbolic-ref", "HEAD", "refs/heads/main"], { env: FIXTURE_ENV });
  git(source, "push", "-q", mirror, `${oldMain}:refs/heads/main`);

  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "ssh"), `#!/usr/bin/env bash
set -uo pipefail
if [ "\${1:-}" = "-G" ]; then exit 1; fi
while [ $# -gt 0 ]; do
  case "$1" in
    -p|-o|-i|-F) shift 2 ;;
    -n|-T|-x) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || exit 2
shift
cd "$FAKE_SSH_HOME"
exec bash -c "$*"
`);
  writeFileSync(join(fakeBin, "scp"), `#!/usr/bin/env bash
set -uo pipefail
while [ $# -gt 0 ]; do
  case "$1" in
    -P|-o) shift 2 ;;
    -q) shift ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || exit 2
destination="\${2#*:}"
cp "$1" "$FAKE_SSH_HOME/$destination"
`);
  chmodSync(join(fakeBin, "ssh"), 0o755);
  chmodSync(join(fakeBin, "scp"), 0o755);

  const cache = join(root, "cache");
  const result = spawnSync("bash", [join(checkout, "packages", "runner", "runtime-tools", "gate-worker", "gate-dispatch.sh"), candidate, "--server", "fake"], {
    cwd: checkout,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...FIXTURE_ENV,
      AGENTOS_WORKSPACE_PATH: checkout,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_SSH_HOME: fakeHome,
      XDG_CACHE_HOME: cache,
      OPERATOR_TOKEN: "",
      RUNNER_TOKEN: "",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`MERGE GATE: PASS ${candidate}`));
  assert.equal(git(mirror, "rev-parse", `refs/gate/candidates/${candidate}^{commit}`), candidate);
  assert.equal(git(mirror, "rev-parse", `refs/gate/baselines/${baseline}^{commit}`), baseline);
  assert.equal(git(mirror, "rev-parse", "refs/heads/main^{commit}"), oldMain, "transport rewrote or deleted the worker's main ref");
  assert.equal(git(mirror, "remote"), "", "the worker cache acquired a remote");
  assert.equal(readFileSync(join(fakeHome, "gate", "origin", "run-gate.sh"), "utf8"), readFileSync(runGatePath, "utf8"));
  // run-gate.sh sources lib.sh on the worker, so an install that ships one
  // without the other leaves a harness that cannot start.
  assert.equal(readFileSync(join(fakeHome, "gate", "origin", "lib.sh"), "utf8"), readFileSync(libPath, "utf8"));
});

// --- run-gate.sh: the worker's state is never a verdict ----------------------

// A gate home the way mirror-push.sh leaves one: run-gate.sh beside a bare
// mirror, deriving its own GATE_HOME from where it was installed.
const gateHome = (t, { verdict, workerRoot, name = "home" } = {}) => {
  const root = workerRoot ?? scratch(t);
  const work = join(root, `${name}-work`);
  const home = join(root, name);
  mkdirSync(join(work, "scripts"), { recursive: true });
  writeFileSync(
    join(work, "scripts", "merge-gate.sh"),
    `#!/usr/bin/env bash\n${verdict ?? 'printf "MERGE GATE: PASS fixture\\n"; exit 0'}\n`,
  );
  chmodSync(join(work, "scripts", "merge-gate.sh"), 0o755);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "fixture");
  const oid = git(work, "rev-parse", "HEAD");

  mkdirSync(home, { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", work, join(home, "mirror.git")], { env: FIXTURE_ENV });
  // Both files, because mirror-push.sh installs both: run-gate.sh sources lib.sh
  // for the verdict's codes and its reader, and a fixture that ships only the
  // harness would be testing a gate home no push ever produces.
  writeFileSync(join(home, "lib.sh"), readFileSync(libPath));
  writeFileSync(join(home, "run-gate.sh"), readFileSync(runGatePath));
  chmodSync(join(home, "run-gate.sh"), 0o755);
  return { root, home, oid };
};

const remoteDispatchFixture = (t) => {
  const root = scratch(t);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "scripts", "gate-worker"), { recursive: true });
  mkdirSync(join(repo, "packages", "runner", "runtime-tools", "gate-worker"), { recursive: true });
  const output = Array.from({ length: 205 }, (_, index) =>
    `printf 'fixture-output-${String(index).padStart(3, "0")}\\n'`,
  ).join("\n");
  writeFileSync(
    join(repo, "scripts", "merge-gate.sh"),
    `#!/usr/bin/env bash\n${output}\nprintf 'MERGE GATE: FAIL (fixture)\\n'\nexit 1\n`,
  );
  for (const name of ["gate-dispatch.sh", "mirror-push.sh", "remote-gate.sh", "lib.sh"]) {
    cpSync(toolPath(name), join(repo, "packages", "runner", "runtime-tools", "gate-worker", name));
  }
  cpSync(runGatePath, join(repo, "packages", "runner", "runtime-tools", "gate-worker", "run-gate.sh"));
  for (const name of ["gate-dispatch.sh", "mirror-push.sh", "remote-gate.sh"]) {
    chmodSync(join(repo, "packages", "runner", "runtime-tools", "gate-worker", name), 0o755);
  }
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  const oid = git(repo, "rev-parse", "HEAD");

  const fakeHome = join(root, "worker-home");
  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "ssh"), `#!/usr/bin/env bash
set -uo pipefail
if [ "\${1:-}" = "-G" ]; then exit 1; fi
while [ $# -gt 0 ]; do
  case "$1" in
    -p|-o|-i|-F) shift 2 ;;
    -n|-T|-x) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || exit 2
shift
cd "$FAKE_SSH_HOME"
exec bash -c "$*"
`);
  writeFileSync(join(fakeBin, "scp"), `#!/usr/bin/env bash
set -uo pipefail
while [ $# -gt 0 ]; do
  case "$1" in
    -P|-o) shift 2 ;;
    -q) shift ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || exit 2
destination="\${2#*:}"
mkdir -p "$(dirname "$FAKE_SSH_HOME/$destination")"
cp "$1" "$FAKE_SSH_HOME/$destination"
`);
  chmodSync(join(fakeBin, "ssh"), 0o755);
  chmodSync(join(fakeBin, "scp"), 0o755);
  return { root, repo, oid, fakeHome, fakeBin };
};

// Bounded like every other fixture that runs a real script: a harness that
// waits on something is a failing test, never a suite that stops returning.
const runGate = (home, args, env = {}) =>
  spawnSync("bash", [join(home, "run-gate.sh"), ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...FIXTURE_ENV, ...env },
  });

// A minimal clean checkout that reaches merge-gate.sh's first preflight after
// its Run-scope refusal. The invalid --expect-head keeps the accepted case
// cheap: it proves the caller passed the refusal without starting Docker or
// any repository proof command.
const mergeGateScopeFixture = (t) => {
  const root = scratch(t);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "scripts", "gate-worker"), { recursive: true });
  mkdirSync(join(repo, "packages", "runner", "runtime-tools", "gate-worker"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name": "anneal"}\n');
  cpSync(mergeGatePath, join(repo, "scripts", "merge-gate.sh"));
  cpSync(join(here, "..", "run-scope-bypass.sh"), join(repo, "scripts", "run-scope-bypass.sh"));
  for (const name of ["host-sizing.sh", "step-engine.sh", "verdict.sh"]) {
    cpSync(join(here, name), join(repo, "scripts", "gate-worker", name));
  }
  cpSync(libPath, join(repo, "packages", "runner", "runtime-tools", "gate-worker", "lib.sh"));
  chmodSync(join(repo, "scripts", "merge-gate.sh"), 0o755);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");

  const callers = join(root, "callers");
  const tools = join(root, "tools");
  mkdirSync(callers, { recursive: true });
  mkdirSync(tools, { recursive: true });
  const invoke = (path) => {
    writeFileSync(
      path,
      `#!/usr/bin/env bash\nset -u\nbash '${join(repo, "scripts", "merge-gate.sh")}' --expect-head not-a-full-object-id &\nchild_pid=$!\nwait "$child_pid"\nchild_status=$?\nexit "$child_status"\n`,
    );
    chmodSync(path, 0o755);
  };
  const forgedCaller = join(callers, "forged-caller.sh");
  const regressionTool = join(tools, "regression-verification.sh");
  invoke(forgedCaller);
  invoke(regressionTool);
  return { repo, forgedCaller, regressionTool, tools };
};

const runMergeGateScopeFixture = (fixture, caller, runId, { includeTools = true } = {}) => spawnSync(caller, [], {
  cwd: fixture.repo,
  encoding: "utf8",
  env: {
    ...FIXTURE_ENV,
    AGENTOS_RUN_ID: runId,
    AGENTOS_RUN_SCOPE_BYPASS: "regression-verification",
    ...(includeTools ? { AGENTOS_TOOLS: fixture.tools } : {}),
  },
});

const stripAnsi = (output) => {
  const ansiEscape = String.fromCharCode(27);
  return output.replaceAll(new RegExp(`${ansiEscape}\\[[0-9;]*m`, "gu"), "");
};

test("merge-gate refuses a forged bypass and audits the invoking command line", (t) => {
  const fixture = mergeGateScopeFixture(t);
  const result = runMergeGateScopeFixture(fixture, fixture.forgedCaller, "forged-gate-run");
  const output = `${result.stdout}${result.stderr}`;
  const plain = stripAnsi(output);
  assert.equal(result.status, 76, output);
  assert.match(plain, /^GATE NOT RUN: refused inside Anneal run forged-gate-run$/m);
  assert.match(output, /forged-caller\.sh/u, "the refusal did not record the caller command line");
});

test("merge-gate refuses and audits a forged bypass when AGENTOS_TOOLS is absent", (t) => {
  const fixture = mergeGateScopeFixture(t);
  const result = runMergeGateScopeFixture(
    fixture,
    fixture.forgedCaller,
    "missing-tools-gate-run",
    { includeTools: false },
  );
  const output = `${result.stdout}${result.stderr}`;
  const plain = stripAnsi(output);
  assert.equal(result.status, 76, output);
  assert.match(plain, /^GATE NOT RUN: refused inside Anneal run missing-tools-gate-run$/m);
  assert.match(output, /forged-caller\.sh/u, "the refusal did not record the caller command line");
});

test("merge-gate accepts the bypass only under the runner regression tool", (t) => {
  const fixture = mergeGateScopeFixture(t);
  const result = runMergeGateScopeFixture(fixture, fixture.regressionTool, "regression-gate-run");
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 76, output);
  assert.match(output, /--expect-head needs a full 40-character object id/u);
  assert.doesNotMatch(output, /^GATE NOT RUN: refused inside Anneal run regression-gate-run$/m);
});

// --- the host the gate is standing on ---------------------------------------

// A checkout complete enough for the real merge-gate.sh to reach its docker
// preflight: the two install-free steps that run before it, the classifier it
// asks for a profile, and the four files it sources. The profile fixtures step
// is a placeholder here — what these cases are about is which verdict the gate
// forms once it is standing in front of a host it cannot use, and running the
// real classifier fixtures would only add a second suite to every case.
const mergeGateHostFixture = (t) => {
  const root = scratch(t);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "scripts", "gate-worker"), { recursive: true });
  mkdirSync(join(repo, "packages", "runner", "runtime-tools", "gate-worker"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name": "anneal"}\n');
  // This repository's own ignore rules, not a fixture's: the gate takes the
  // worktree lock before it checks that the tree is clean, so a lock file the
  // rules do not cover fails every gate. Copying them is what makes that a
  // failure here rather than on the next branch.
  cpSync(join(here, "..", "..", ".gitignore"), join(repo, ".gitignore"));
  cpSync(mergeGatePath, join(repo, "scripts", "merge-gate.sh"));
  for (const name of ["check-frozen-docs.sh", "merge-gate-profile.mjs", "run-scope-bypass.sh"]) {
    cpSync(join(here, "..", name), join(repo, "scripts", name));
  }
  writeFileSync(
    join(repo, "scripts", "merge-gate-profile.test.mjs"),
    'import test from "node:test";\ntest("placeholder for the gate\'s profile fixtures step", () => {});\n',
  );
  for (const name of ["host-sizing.sh", "step-engine.sh", "verdict.sh"]) {
    cpSync(join(here, name), join(repo, "scripts", "gate-worker", name));
  }
  cpSync(libPath, join(repo, "packages", "runner", "runtime-tools", "gate-worker", "lib.sh"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  const oid = git(repo, "rev-parse", "HEAD");

  // A host whose docker daemon is not reachable. `reached` is what proves the
  // preflight got this far, and `hold` is how a case keeps one gate standing in
  // the preflight while another tries to take the worktree from under it.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const reached = join(root, "docker-info-callers");
  const hold = join(root, "release-docker-info");
  writeFileSync(
    join(bin, "docker"),
    "#!/usr/bin/env bash\n"
      + 'if [ "$1" = info ]; then\n'
      + '  printf "%s\\n" "$$" >> "$DOCKER_INFO_CALLERS"\n'
      + '  while [ -n "${DOCKER_INFO_HOLD:-}" ] && [ ! -e "$DOCKER_INFO_HOLD" ]; do sleep 0.05; done\n'
      + '  printf "Cannot connect to the Docker daemon\\n" >&2\n'
      + "  exit 1\n"
      + "fi\n"
      + "exit 0\n",
  );
  chmodSync(join(bin, "docker"), 0o755);

  const env = (extra = {}) => ({
    ...FIXTURE_ENV,
    PATH: `${bin}:${process.env.PATH}`,
    DOCKER_INFO_CALLERS: reached,
    ...extra,
  });
  const argv = [join(repo, "scripts", "merge-gate.sh"), "--expect-head", oid, "--master", oid];
  return { repo, oid, reached, hold, env, argv };
};

// Assert the actual final non-empty stdout line, including any advisories.
const lastVerdictLine = (output) => stripAnsi(output).trim().split("\n").at(-1) ?? "";

test("an unreachable docker daemon is GATE NOT RUN, not a FAIL about the commit", (t) => {
  // The defect this closes. The daemon being down says nothing about the
  // commit, and the gate used to answer `MERGE GATE: FAIL (docker preflight)`:
  // the dispatcher reads 1 as a judgement, stops looking for a worker that
  // could have judged it, and a reviewer records a verdict nothing formed.
  const fixture = mergeGateHostFixture(t);
  const result = spawnSync("bash", fixture.argv, {
    cwd: fixture.repo,
    encoding: "utf8",
    timeout: 120_000,
    env: fixture.env(),
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 76, output);
  assert.equal(lastVerdictLine(result.stdout), "GATE NOT RUN: the docker daemon on this host is not reachable");
  assert.doesNotMatch(stripAnsi(output), /MERGE GATE: FAIL/);
  assert.equal(readFileSync(fixture.reached, "utf8").trim().split("\n").length, 1);
});

test("a host with no docker binary at all is GATE NOT RUN as well", (t) => {
  const fixture = mergeGateHostFixture(t);
  const withoutDocker = join(fixture.repo, "..", "no-docker-bin");
  mkdirSync(withoutDocker);
  for (const name of ["bash", "git", "node", "cat", "rm", "mkdir", "ln", "mv", "date", "grep", "sed", "tr", "dirname", "mktemp", "sleep", "head", "wc", "sort", "cut", "uname", "getconf"]) {
    const located = spawnSync("bash", ["-c", 'command -v "$1"', "fixture", name], { encoding: "utf8" });
    assert.equal(located.status, 0, `locate ${name}`);
    symlinkSync(located.stdout.trim(), join(withoutDocker, name));
  }
  const result = spawnSync("bash", fixture.argv, {
    cwd: fixture.repo,
    encoding: "utf8",
    timeout: 120_000,
    env: fixture.env({ PATH: withoutDocker }),
  });
  assert.ifError(result.error);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 76, output);
  assert.match(lastVerdictLine(result.stdout), /^GATE NOT RUN: docker is required and this host has none/);
});

test("an unwritable worktree lock root yields no verdict", (t) => {
  const fixture = mergeGateHostFixture(t);
  chmodSync(fixture.repo, 0o555);
  let result;
  try {
    result = spawnSync("bash", fixture.argv, {
      cwd: fixture.repo, encoding: "utf8", env: fixture.env(), timeout: 120_000,
    });
  } finally {
    chmodSync(fixture.repo, 0o755);
  }
  assert.ifError(result.error);
  assert.equal(result.status, 76, `${result.stdout}${result.stderr}`);
  assert.match(lastVerdictLine(result.stdout), /^GATE NOT RUN:.*lock/);
});

test("an unusable old-format worktree lock yields no verdict and names both paths", (t) => {
  const fixture = mergeGateHostFixture(t);
  mkdirSync(join(fixture.repo, ".merge-gate.lock"));
  const result = spawnSync("bash", fixture.argv, {
    cwd: fixture.repo, encoding: "utf8", env: fixture.env(), timeout: 120_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 76, `${result.stdout}${result.stderr}`);
  assert.match(lastVerdictLine(result.stdout), /^GATE NOT RUN:.*\.merge-gate\.slot.*\.merge-gate\.lock/);
});

test("two gates racing for one worktree leave exactly one holder", async (t) => {
  // The lock's whole purpose, as a race rather than as a state on disk. Two
  // gates in one checkout share node_modules, dist/ and the prisma client, and
  // `npm ci` empties node_modules before it refills it: 33 gates in one
  // worktree deleting each other's dependencies is the incident. The lock this
  // replaced created its directory before it wrote the pid into it, so a gate
  // reading that window found a lock naming nobody, called it abandoned, and
  // took the worktree the other one was installing into.
  //
  // The winner is held inside `docker info`, so the loser meets a live holder
  // rather than a race this fixture would have to time.
  const fixture = mergeGateHostFixture(t);
  const run = () =>
    new Promise((resolve) => {
      const child = spawn("bash", fixture.argv, {
        cwd: fixture.repo,
        env: fixture.env({ DOCKER_INFO_HOLD: fixture.hold }),
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("exit", (code, signal) => resolve({ status: code ?? signal, output: stripAnsi(output) }));
    });

  const first = run();
  const second = run();
  // Whichever gate lost the lock exits at once; the winner is still in the
  // preflight. Releasing the hold only after that keeps the case deterministic.
  // The deadline is what turns "both gates took the lock" — the failure this
  // exists to catch — into a failing assertion rather than a suite that stops
  // returning.
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "neither gate refused", output: "" }), 60_000);
  });
  const loser = await Promise.race([first, second, deadline]);
  clearTimeout(timer);
  writeFileSync(fixture.hold, "");
  const [a, b] = await Promise.all([first, second]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [1, 76], `${a.output}\n---\n${b.output}`);
  assert.equal(loser.status, 1, loser.output);
  assert.match(
    loser.output,
    /another merge gate is running in .* \(pid \d+\)/u,
    "the refusal did not name the process holding the worktree",
  );
  assert.match(loser.output, /MERGE GATE: FAIL \(worktree lock\)/);
  // Exactly one gate got past the lock, which is the invariant: the loser never
  // reached the preflight step the winner was held in.
  assert.equal(readFileSync(fixture.reached, "utf8").trim().split("\n").length, 1);
});

test("a gate that passes is reported as the gate's own verdict", (t) => {
  const fixture = gateHome(t);
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS/);
});

test("a gate that fails is 1 and says MERGE GATE: FAIL", (t) => {
  const fixture = gateHome(t, {
    verdict:
      'printf "# Subtest: packages/fixture.test.ts\\nnot ok 1 - first assertion\\nMERGE GATE: FAIL (fixture)\\n"; exit 1',
  });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MERGE GATE: FAIL/);
  assert.match(result.stdout, /failure excerpt \(last 200 lines per failing step\)/);
  assert.match(result.stdout, /packages\/fixture\.test\.ts/);
  assert.match(result.stdout, /not ok 1 - first assertion/);
});

test("a gate FAIL forwards a bounded tail of the worker log", (t) => {
  const output = Array.from({ length: 205 }, (_, index) =>
    `printf 'fixture-output-${String(index).padStart(3, "0")}\\n'`,
  ).join("\n");
  const fixture = gateHome(t, {
    verdict: `${output}\nprintf 'MERGE GATE: FAIL (fixture)\\n'; exit 1`,
  });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 1, result.stdout + result.stderr);

  const marker = "run-gate: failure excerpt (last 200 lines per failing step)";
  const markerAt = result.stdout.indexOf(marker);
  const verdictAt = result.stdout.indexOf("MERGE GATE: FAIL", markerAt);
  assert.ok(markerAt >= 0, result.stdout);
  assert.ok(verdictAt > markerAt, result.stdout);
  const excerpt = result.stdout.slice(markerAt, verdictAt);
  const forwarded = excerpt.match(/fixture-output-\d{3}/g) ?? [];
  assert.ok(forwarded.length <= 200, `forwarded ${forwarded.length} lines`);
  assert.match(excerpt, /fixture-output-204/);
  assert.doesNotMatch(excerpt, /fixture-output-000/);
});

test("a gate FAIL forwards the last 200 lines of every failing step", (t) => {
  const laterOutput = Array.from({ length: 205 }, (_, index) =>
    `printf 'later-stage-output-${String(index).padStart(3, "0")}\\n'`,
  ).join("\n");
  const fixture = gateHome(t, {
    verdict: [
      "printf '%s\\n' '--- database tests (db + api) ---'",
      "printf '%s\\n' '# Subtest: packages/db/src/early.dbtest.ts'",
      "printf '%s\\n' 'not ok 1 - early database assertion'",
      "printf '%s\\n' 'AssertionError: early database assertion'",
      "printf '%s\\n' '--- unit tests (all workspaces) ---'",
      laterOutput,
      "printf '%s\\n' '# Subtest: packages/api/src/late.test.ts'",
      "printf '%s\\n' 'not ok 1 - late unit assertion'",
      "printf '%s\\n' 'AssertionError: late unit assertion'",
      "printf '%s\\n' 'MERGE GATE: FAIL (database tests (db + api), unit tests (all workspaces))'",
      "exit 1",
    ].join("\n"),
  });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /--- database tests \(db \+ api\) ---/u);
  assert.match(result.stdout, /packages\/db\/src\/early\.dbtest\.ts/u);
  assert.match(result.stdout, /early database assertion/u);
  assert.match(result.stdout, /--- unit tests \(all workspaces\) ---/u);
  assert.match(result.stdout, /packages\/api\/src\/late\.test\.ts/u);
  assert.match(result.stdout, /late unit assertion/u);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 66_000, "forwarded stdout exceeded its bounded envelope");
});

test("a failing workspace stage keeps nested assertion evidence ahead of passing output", (t) => {
  const workspaces = Array.from({ length: 8 }, (_, index) => `workspace-${index + 1}`);
  const workspaceBlocks = workspaces.flatMap((workspace, index) => {
    const lines = [`printf '%s\\n' '--- test: ${workspace} ---'`];
    if (index === 0) {
      lines.push(
        "printf '%s\\n' '# Subtest: packages/runner/src/first.test.ts'",
        "printf '%s\\n' 'not ok 1 - first workspace assertion'",
        "printf '%s\\n' 'AssertionError: first workspace assertion'",
      );
    }
    lines.push(
      ...Array.from(
        { length: 35 },
        (_, line) => `printf '%s\\n' 'ok ${line + 1} - ${workspace} passing ${String(line).padStart(3, "0")}'`,
      ),
    );
    return lines;
  });
  const fixture = gateHome(t, {
    verdict: [
      "printf '%s\\n' '--- unit tests (all workspaces) ---'",
      ...workspaceBlocks,
      "printf '%s\\n' '--- sibling parallel stage ---'",
      "printf '%s\\n' 'sibling-stage-only-output'",
      "printf '%s\\n' '   FAIL  unit tests (all workspaces)                 1s'",
      "printf '%s\\n' '   ok    sibling parallel stage                      1s'",
      "printf '%s\\n' 'MERGE GATE: FAIL (unit tests (all workspaces))'",
      "exit 1",
    ].join("\n"),
  });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 1, result.stdout + result.stderr);

  const marker = "run-gate: failure excerpt (last 200 lines per failing step)";
  const markerAt = result.stdout.indexOf(marker);
  const verdictAt = result.stdout.indexOf("MERGE GATE: FAIL", markerAt);
  assert.ok(markerAt >= 0, result.stdout);
  assert.ok(verdictAt > markerAt, result.stdout);
  const excerpt = result.stdout.slice(markerAt, verdictAt);
  assert.match(excerpt, /--- unit tests \(all workspaces\) ---/u);
  assert.match(excerpt, /# Subtest: packages\/runner\/src\/first\.test\.ts/u);
  assert.match(excerpt, /AssertionError: first workspace assertion/u);
  assert.doesNotMatch(excerpt, /sibling-stage-only-output/u);
  assert.doesNotMatch(excerpt, /workspace-1 passing 000/u);
});

test("a saturated stage admits late failure evidence before it trims", (t) => {
  const contextNoise = Array.from(
    { length: 240 },
    (_, index) => `printf '%s\\n' '# Subtest: packages/noise/src/context-${String(index).padStart(3, "0")}.test.ts'`,
  );
  const trailingOutput = Array.from(
    { length: 240 },
    (_, index) => `printf '%s\\n' 'ok ${index + 1} - trailing passing output ${String(index).padStart(3, "0")}'`,
  );
  const fixture = gateHome(t, {
    verdict: [
      "printf '%s\\n' '--- unit tests (all workspaces) ---'",
      ...contextNoise,
      "printf '%s\\n' '# Subtest: packages/runner/src/late-failure.test.ts'",
      "printf '%s\\n' 'not ok 99 - LATE FAILURE'",
      "printf '%s\\n' 'AssertionError: LATE FAILURE MESSAGE'",
      ...trailingOutput,
      "printf '%s\\n' '   FAIL  unit tests (all workspaces)                 1s'",
      "printf '%s\\n' 'MERGE GATE: FAIL (unit tests (all workspaces))'",
      "exit 1",
    ].join("\n"),
  });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /# Subtest: packages\/runner\/src\/late-failure\.test\.ts/u);
  assert.match(result.stdout, /not ok 99 - LATE FAILURE/u);
  assert.match(result.stdout, /AssertionError: LATE FAILURE MESSAGE/u);
});

test("failure evidence wins each stage byte budget", (t) => {
  const stages = [
    "database tests (db + api)",
    "lint (biome + type-aware no-floating-promises)",
    "unit tests (all workspaces)",
  ];
  const stageOutput = stages.flatMap((stage, stageIndex) => [
    `printf '%s\\n' '--- ${stage} ---'`,
    `printf '%s\\n' '# Subtest: packages/runner/src/budget-${stageIndex}.test.ts'`,
    `printf '%s\\n' 'not ok 1 - BUDGET ASSERTION ${stageIndex}'`,
    `printf '%s\\n' 'AssertionError: BUDGET ASSERTION ${stageIndex}'`,
    ...Array.from(
      { length: 120 },
      (_, line) =>
        `printf '%s\\n' 'ok ${line + 1} - stage ${stageIndex} trailing ${String(line).padStart(3, "0")} ${"x".repeat(280)}'`,
    ),
  ]);
  const fixture = gateHome(t, {
    verdict: [
      ...stageOutput,
      ...stages.map((stage) => `printf '%s\\n' '   FAIL  ${stage}                 1s'`),
      `printf '%s\\n' 'MERGE GATE: FAIL (${stages.join(", ")})'`,
      "exit 1",
    ].join("\n"),
  });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (let index = 0; index < stages.length; index += 1) {
    assert.match(result.stdout, new RegExp(`AssertionError: BUDGET ASSERTION ${index}`, "u"));
    assert.match(result.stdout, new RegExp(`budget-${index}\\.test\\.ts`, "u"));
  }
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 66_000, "forwarded stdout exceeded its bounded envelope");
});

test("nested lint headings remain inside their enclosing failing stage", (t) => {
  const fixture = gateHome(t, {
    verdict: [
      "printf '%s\\n' '--- lint (biome + type-aware no-floating-promises) ---'",
      "printf '%s\\n' '--- biome ---'",
      "printf '%s\\n' 'packages/runner/src/lint-failure.test.ts'",
      "printf '%s\\n' '✖ LINT FAILURE'",
      "printf '%s\\n' 'Error: LINT FAILURE'",
      "printf '%s\\n' '--- unit tests (all workspaces) ---'",
      "printf '%s\\n' '# Subtest: packages/runner/src/unit-failure.test.ts'",
      "printf '%s\\n' 'not ok 1 - UNIT FAILURE'",
      "printf '%s\\n' 'AssertionError: UNIT FAILURE'",
      "printf '%s\\n' '   FAIL  lint (biome + type-aware no-floating-promises)                 1s'",
      "printf '%s\\n' '   FAIL  unit tests (all workspaces)                 1s'",
      "printf '%s\\n' 'MERGE GATE: FAIL (lint (biome + type-aware no-floating-promises), unit tests (all workspaces))'",
      "exit 1",
    ].join("\n"),
  });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /packages\/runner\/src\/lint-failure\.test\.ts/u);
  assert.match(result.stdout, /✖ LINT FAILURE/u);
  assert.match(result.stdout, /AssertionError: UNIT FAILURE/u);
});

test("a remote FAIL tail reaches remote-gate and dispatcher stdout", (t) => {
  const fixture = remoteDispatchFixture(t);
  const result = spawnSync(
    "bash",
    [join(fixture.repo, "packages", "runner", "runtime-tools", "gate-worker", "gate-dispatch.sh"), fixture.oid, "--server", "fake", "--master", fixture.oid],
    {
      cwd: fixture.repo,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...FIXTURE_ENV,
        AGENTOS_WORKSPACE_PATH: fixture.repo,
        PATH: `${fixture.fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_SSH_HOME: fixture.fakeHome,
        XDG_CACHE_HOME: join(fixture.root, "cache"),
      },
    },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /run-gate: failure excerpt \(last 200 lines per failing step\)/);
  assert.match(result.stdout, /fixture-output-204/);
  assert.doesNotMatch(result.stdout, /fixture-output-000/);
  assert.match(result.stdout, /MERGE GATE: FAIL \(fixture\)/);
});

test("a credential in the trusted worker environment does not block the gate", (t) => {
  const fixture = gateHome(t);
  const result = runGate(fixture.home, [fixture.oid], { FEISHU_APP_SECRET: "x" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /MERGE GATE: PASS/);
});

test("a commit the mirror does not have is not a FAIL", (t) => {
  const fixture = gateHome(t);
  const absent = "0".repeat(40);
  const result = runGate(fixture.home, [absent]);
  assert.equal(result.status, 76, result.stdout + result.stderr);
  assert.match(result.stdout, /^GATE NOT RUN: /m);
  assert.doesNotMatch(result.stdout, /MERGE GATE/);
});

test("a missing mirror is not a FAIL", (t) => {
  const fixture = gateHome(t);
  rmSync(join(fixture.home, "mirror.git"), { recursive: true, force: true });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 76);
  assert.match(result.stdout, /^GATE NOT RUN: no mirror at /m);
});

test("a gate that dies without printing a verdict is not a FAIL", (t) => {
  // merge-gate.sh killed, or out of memory, or crashed inside a step. Nothing
  // judged the commit, so nothing may be recorded as a judgement of it.
  const fixture = gateHome(t, { verdict: 'printf "no verdict here\\n"; exit 137' });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 76);
  assert.match(result.stdout, /^GATE NOT RUN: the gate produced no verdict line/m);
});

test("a gate stopped by a signal keeps its own reason and its own exit code", (t) => {
  // The live defect, both halves. merge-gate.sh traps TERM, prints its own
  // GATE NOT RUN line through the EXIT trap and exits 143. run-gate.sh read the
  // log with a pattern that only matched `MERGE GATE: `, so it found nothing,
  // replaced the gate's reason with a statement that no line had been printed —
  // which was false — and rewrote 143 to 76, contradicting the runbook's promise
  // that 130 and 143 are reported under the signal that stopped them.
  const fixture = gateHome(t, {
    verdict:
      'printf "\\n\\033[33mGATE NOT RUN: the gate was stopped by SIGTERM during the suites\\033[0m\\n"; exit 143',
  });
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 143, result.stdout + result.stderr);
  assert.match(result.stdout, /^GATE NOT RUN: the gate was stopped by SIGTERM during the suites$/m);
  assert.doesNotMatch(result.stdout, /produced no verdict line/);
});

test("a malformed STALE_WORKTREE_MINUTES is refused rather than passed to find", (t) => {
  const fixture = gateHome(t);
  const result = runGate(fixture.home, [fixture.oid], { STALE_WORKTREE_MINUTES: "-1; id" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /STALE_WORKTREE_MINUTES/);
});

test("the default worker capacity serializes gates from different repositories", (t) => {
  const workerRoot = scratch(t);
  const starts = join(workerRoot, "starts");
  const release = join(workerRoot, "release");
  const verdict = `
    printf '%s\\n' "$$" >> "$WORKER_LOCK_STARTS"
    while [ ! -f "$WORKER_LOCK_RELEASE" ]; do sleep 0.05; done
    printf 'MERGE GATE: PASS fixture\\n'
  `;
  const first = gateHome(t, { verdict, workerRoot, name: "repo-a" });
  const second = gateHome(t, { verdict, workerRoot, name: "repo-b" });
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
        set -uo pipefail
        "$FIRST_HOME/run-gate.sh" "$FIRST_OID" > "$WORKER_ROOT/first.out" 2>&1 &
        first_pid=$!
        for _ in $(seq 1 600); do
          [ -s "$WORKER_LOCK_STARTS" ] && break
          sleep 0.05
        done
        [ -s "$WORKER_LOCK_STARTS" ] || exit 90

        "$SECOND_HOME/run-gate.sh" "$SECOND_OID" > "$WORKER_ROOT/second.out" 2>&1 &
        second_pid=$!
        sleep 0.3
        [ "$(wc -l < "$WORKER_LOCK_STARTS" | tr -d ' ')" = 1 ] || exit 91

        : > "$WORKER_LOCK_RELEASE"
        wait "$first_pid"
        wait "$second_pid"
        cat "$WORKER_ROOT/first.out" "$WORKER_ROOT/second.out"
      `,
    ],
    {
      encoding: "utf8",
      // The `seq` loop above is what waits for the spawned run-gate.sh children
      // to announce themselves; this only bounds a harness that wedges, so it
      // matches this file's siblings and is sized for
      // the loaded gate worker (load1 20-55 observed, where a node or bash+git start alone can exceed 10s), not for an idle host.
      timeout: 120_000,
      env: {
        ...FIXTURE_ENV,
        FIRST_HOME: first.home,
        FIRST_OID: first.oid,
        SECOND_HOME: second.home,
        SECOND_OID: second.oid,
        WORKER_ROOT: workerRoot,
        WORKER_LOCK_STARTS: starts,
        WORKER_LOCK_RELEASE: release,
      },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(starts, "utf8").trim().split("\n").length, 2);
  assert.equal((result.stdout.match(/MERGE GATE: PASS/g) ?? []).length, 2);
});

test("worker capacity two admits exactly two gates and keeps concurrent logs distinct", (t) => {
  const workerRoot = scratch(t);
  const starts = join(workerRoot, "starts");
  const hostShare = join(workerRoot, "host-share");
  const release = join(workerRoot, "release");
  const verdict = `
    printf '%s\n' "$$" >> "$WORKER_LOCK_STARTS"
    printf '%s\n' "\${AGENTOS_GATE_HOST_SHARE:-unset}" >> "$WORKER_HOST_SHARE"
    while [ ! -f "$WORKER_LOCK_RELEASE" ]; do sleep 0.05; done
    printf 'MERGE GATE: PASS fixture\n'
  `;
  const fixture = gateHome(t, { verdict, workerRoot });
  writeFileSync(join(workerRoot, "worker-capacity"), "2\n");
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
        set -uo pipefail
        for run in 1 2 3; do
          "$GATE_HOME/run-gate.sh" "$GATE_OID" > "$WORKER_ROOT/$run.out" 2>&1 &
          eval "pid_$run=$!"
        done
        for _ in $(seq 1 600); do
          [ -s "$WORKER_LOCK_STARTS" ] \
            && [ "$(wc -l < "$WORKER_LOCK_STARTS" | tr -d ' ')" -ge 2 ] \
            && break
          sleep 0.05
        done
        [ "$(wc -l < "$WORKER_LOCK_STARTS" | tr -d ' ')" = 2 ] || exit 90
        sleep 0.3
        [ "$(wc -l < "$WORKER_LOCK_STARTS" | tr -d ' ')" = 2 ] || exit 91

        : > "$WORKER_LOCK_RELEASE"
        wait "$pid_1"
        wait "$pid_2"
        wait "$pid_3"
        cat "$WORKER_ROOT/1.out" "$WORKER_ROOT/2.out" "$WORKER_ROOT/3.out"
      `,
    ],
    {
      encoding: "utf8",
      // The `seq` loop above is what waits for the spawned run-gate.sh children
      // to announce themselves; this only bounds a harness that wedges, so it
      // matches this file's siblings and is sized for
      // the loaded gate worker (load1 20-55 observed, where a node or bash+git start alone can exceed 10s), not for an idle host.
      timeout: 120_000,
      env: {
        ...FIXTURE_ENV,
        GATE_HOME: fixture.home,
        GATE_OID: fixture.oid,
        WORKER_ROOT: workerRoot,
        WORKER_LOCK_STARTS: starts,
        WORKER_HOST_SHARE: hostShare,
        WORKER_LOCK_RELEASE: release,
      },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(starts, "utf8").trim().split("\n").length, 3);
  // Every gate on a two-slot worker is told it has half the host. What it does
  // with that is merge-gate.sh's business; that this reaches it is this one's.
  assert.deepEqual(readFileSync(hostShare, "utf8").trim().split("\n"), ["2", "2", "2"]);
  assert.equal((result.stdout.match(/MERGE GATE: PASS/g) ?? []).length, 3);
  const logs = readdirSync(join(fixture.home, "logs")).filter((name) => name.endsWith(".log"));
  assert.equal(logs.length, 3, `concurrent runs shared a log: ${logs.join(", ")}`);
});

test("the share run-gate states is the one merge-gate sizes from, and nothing recomputes it", () => {
  // 7886fad exported AGENTOS_DBTEST_CONCURRENCY=2 here for a two-slot worker,
  // and merge-gate.sh recomputed that exact variable a few lines into its own
  // run. The bound never took effect: the worker ran eight database files at
  // once while run-gate.sh's log line still said two. Nothing failed, because
  // the fixture above only proved what run-gate.sh exported, never what
  // survived to the gate.
  //
  // The shape of that bug is two files computing one number. So: run-gate.sh
  // states the share and names no fan-out, and the gate reads the share and is
  // the only place that turns it into lanes. The gate is merge-gate.sh and the
  // sizing module it sources, read here as the one side they are.
  const runGate = readFileSync(runGatePath, "utf8");
  const mergeGate = [
    readFileSync(join(here, "..", "merge-gate.sh"), "utf8"),
    readFileSync(join(here, "host-sizing.sh"), "utf8"),
  ].join("\n");

  assert.match(runGate, /export AGENTOS_GATE_HOST_SHARE="\$WORKER_CAPACITY"/);
  assert.doesNotMatch(
    runGate,
    /AGENTOS_DBTEST_CONCURRENCY|AGENTOS_GATE_UNIT_LANES|AGENTOS_GATE_DB_LANES/,
    "run-gate.sh names a fan-out of its own; it may only state the share",
  );

  assert.match(mergeGate, /GATE_HOST_SHARE="\$\{AGENTOS_GATE_HOST_SHARE:-2\}"/);
  assert.doesNotMatch(
    mergeGate,
    /^\s*export\s+AGENTOS_GATE_HOST_SHARE/m,
    "the gate overwrites the share it was given instead of sizing from it",
  );
  // The database wave states its lane count at the point of use. An ambient
  // export is what let run-gate.sh's value silently become something else.
  assert.match(mergeGate, /AGENTOS_DBTEST_CONCURRENCY="\$\{GATE_DB_LANES\}"/);
  assert.doesNotMatch(
    mergeGate,
    /^\s*export\s+AGENTOS_DBTEST_CONCURRENCY/m,
    "the gate exports an ambient database fan-out instead of stating it where it is used",
  );
});

test("a worker capacity other than one or two is refused without a verdict", (t) => {
  const fixture = gateHome(t);
  writeFileSync(join(fixture.root, "worker-capacity"), "3\n");
  const result = runGate(fixture.home, [fixture.oid]);
  assert.equal(result.status, 76, result.stdout + result.stderr);
  assert.match(result.stdout, /^GATE NOT RUN: worker capacity .* must be exactly 1 or 2/m);
  assert.doesNotMatch(result.stdout, /MERGE GATE/);
});

// --- the stale-worktree sweep ------------------------------------------------

const abandonedWorktree = (home, pid) => {
  const dir = join(home, "worktrees", `gate-${"a".repeat(40)}-20260101T000000Z-${pid}`);
  mkdirSync(dir, { recursive: true });
  // Older than any sweep window: `find -mmin` reads the directory's own mtime.
  const longAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
  utimesSync(dir, longAgo, longAgo);
  return dir;
};

test("the sweep reclaims a worktree whose gate is gone", (t) => {
  const fixture = gateHome(t);
  const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
  const dir = abandonedWorktree(fixture.home, dead);
  const result = runGate(fixture.home, [fixture.oid], { STALE_WORKTREE_MINUTES: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(dir), false, "an abandoned worktree survived the sweep");
});

test("the sweep leaves a worktree whose gate is still running", (t) => {
  // The regression: age alone used to decide, so a gate stuck on a hung
  // registry for longer than the window had its tree deleted by the next run —
  // turning one box's infrastructure problem into a different dispatch's FAIL.
  const fixture = gateHome(t);
  const dir = abandonedWorktree(fixture.home, String(process.pid));
  const result = runGate(fixture.home, [fixture.oid], { STALE_WORKTREE_MINUTES: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(dir), true, "the sweep deleted a running gate's worktree");
  assert.match(result.stderr, /still running/);
});

// --- the scripts themselves --------------------------------------------------

test("every gate-worker script parses", () => {
  for (const name of [
    "provision.sh",
    "bench-postgres.sh",
    "bench-dbtest-concurrency.sh",
  ]) {
    const result = spawnSync("bash", ["-n", join(here, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
  for (const name of ["lib.sh", "gate-dispatch.sh", "mirror-push.sh", "remote-gate.sh", "run-gate.sh"]) {
    const result = spawnSync("bash", ["-n", join(runtimeGateWorker, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

// test:gate-worker is historical: it includes delivery concurrency suites too.
// Keep both halves in parity rather than narrowing the alias to its old name.
test("the gate-worker npm alias and delivery gate step run the same suites", () => {
  const rootPackage = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"));
  const alias = rootPackage.scripts?.["test:gate-worker"];
  assert.equal(typeof alias, "string", "package.json must define test:gate-worker");
  const aliasMatch = /^node --test\s+(.+)$/u.exec(alias);
  assert.ok(aliasMatch, `test:gate-worker must be a node --test command, got ${JSON.stringify(alias)}`);
  const aliasSuites = aliasMatch[1].trim().split(/\s+/u);

  const gate = readFileSync(mergeGatePath, "utf8");
  const gateMatch =
    /^\s+"delivery concurrency and gate worker fixtures"\s+node --test\s+([\s\S]*?)\s+::/mu.exec(gate);
  assert.ok(gateMatch, "merge-gate.sh must contain the delivery gate-worker step");
  const gateSuites = gateMatch[1].replace(/\\\s*\n/gu, " ").trim().split(/\s+/u);

  assert.deepEqual(aliasSuites, gateSuites, "test:gate-worker and the delivery gate step drifted apart");
});

test("the standalone worker provisioner pins the repository's .nvmrc version", () => {
  const nvmrc = readFileSync(join(here, "..", "..", ".nvmrc"), "utf8").trim();
  const provision = readFileSync(provisionPath, "utf8");
  const pinned = /^GATE_NODE_VERSION="\$\{GATE_NODE_VERSION:-v([^}]+)\}"$/mu.exec(provision)?.[1];
  assert.equal(pinned, nvmrc, "provision.sh drifted from .nvmrc");
});

test("a usage error is 2 everywhere the exit-code table applies", () => {
  // The table has one row for a usage error. remote-gate.sh documented 2 and
  // exited sysexits' 64 in every one of its argument checks, which is two
  // numbers for one meaning and a case a caller does not handle.
  const remoteGate = spawnSync("bash", [remoteGatePath, "--port"], {
    encoding: "utf8",
  });
  assert.equal(remoteGate.status, 2, remoteGate.stderr);
  const dispatch = spawnSync("bash", [dispatchPath, "--master"], {
    encoding: "utf8",
  });
  assert.equal(dispatch.status, 2, dispatch.stderr);
});

// --- the verdict --------------------------------------------------------------

// One shell, sourcing lib.sh, so a case observes the module the way a script
// does rather than by reading the file.
const verdict = (call) =>
  spawnSync("bash", ["-c", `set -uo pipefail\n. "${libPath}"\n${call}`], { encoding: "utf8" });

test("every script that names the gate's exit codes takes them from lib.sh", () => {
  // The seam, asserted as a seam. Four scripts declared `EXIT_NO_VERDICT=76`
  // literally, which is four places for one number to drift; what replaces that
  // grep is the property that made it unnecessary — each script sources the one
  // file that defines it, and none of them redeclares it.
  for (const name of ["run-gate.sh", "remote-gate.sh", "gate-dispatch.sh", "mirror-push.sh"]) {
    const source = readFileSync(toolPath(name), "utf8");
    assert.match(source, /^\. "\$\{(SCRIPT_DIR|HARNESS_DIR)\}\/lib\.sh"$/m, `${name} does not source lib.sh`);
    assert.doesNotMatch(source, /^EXIT_NO_VERDICT=/m, `${name} declares the no-verdict code again`);
  }
  const gate = readFileSync(join(here, "..", "merge-gate.sh"), "utf8");
  assert.match(gate, /^\. "\$\{REPO_ROOT\}\/packages\/runner\/runtime-tools\/gate-worker\/lib\.sh"$/m);
  assert.doesNotMatch(gate, /^EXIT_(FAIL|NOT_AUTHORITATIVE|NO_VERDICT)=/m);
});

test("every verdict shape survives the round trip out of lib.sh and back", (t) => {
  // Emit with the emit function, read back with the reader, and require the line
  // verbatim. The defect this replaces was a reader that knew three of the four
  // shapes, so the shape that carries a stopped run's reason is in this table
  // for the same reason the others are.
  const root = scratch(t);
  const cases = [
    { emit: "gate_verdict_pass 0123456789abcdef0123456789abcdef01234567",
      line: "MERGE GATE: PASS 0123456789abcdef0123456789abcdef01234567",
      status: 0 },
    { emit: "gate_verdict_fail 'unit tests'", line: "MERGE GATE: FAIL (unit tests)", status: 1 },
    { emit: "gate_verdict_not_authoritative '--keep-postgres'",
      line: "MERGE GATE: NOT AUTHORITATIVE (--keep-postgres)", status: 3 },
    { emit: "gate_verdict_not_run 'the gate was stopped by SIGTERM during the suites'",
      line: "GATE NOT RUN: the gate was stopped by SIGTERM during the suites", status: 76 },
  ];
  for (const [index, shape] of cases.entries()) {
    const log = join(root, `verdict-${index}.log`);
    const emitted = verdict(`${shape.emit} > "${log}"`);
    assert.equal(emitted.status, 0, emitted.stderr);
    // Colour is the emit function's business and must be gone by the time a
    // caller sees the line: it is read over ssh and pasted into a PR.
    assert.ok(readFileSync(log, "utf8").includes("\u001b["), `${shape.line} was emitted without colour`);
    const read = verdict(`gate_verdict_read "${log}"`);
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stdout, `${shape.line}\n`);

    const judged = verdict(`gate_verdict_is_judgement ${shape.status}`);
    assert.equal(judged.status, shape.status === 76 ? 1 : 0, `${shape.line} was classified wrong`);
  }

  // Nothing to read is not a verdict, and 2, 130, 143 and 137 are not judgements.
  const empty = join(root, "silent.log");
  writeFileSync(empty, "npm noise\nmore noise\n");
  assert.equal(verdict(`gate_verdict_read "${empty}"`).stdout, "");
  for (const code of [2, 75, 76, 130, 137, 143, 255]) {
    assert.equal(verdict(`gate_verdict_is_judgement ${code}`).status, 1, `${code} was read as a verdict`);
  }
});

test("the runbook's exit-code table is the table lib.sh defines", () => {
  // The contract is only useful if it is written down where an operator reads
  // it, so the runbook naming these codes is part of the fix and not commentary
  // on it. Asserted against lib.sh's values rather than against prose, so a code
  // that changes in one place fails here instead of drifting.
  const codes = verdict(
    'printf "%s %s %s %s\n" "$GATE_EXIT_PASS" "$GATE_EXIT_FAIL" "$GATE_EXIT_NOT_AUTHORITATIVE" "$GATE_EXIT_NO_VERDICT"',
  );
  assert.equal(codes.status, 0, codes.stderr);
  const [pass, fail, notAuthoritative, noVerdict] = codes.stdout.trim().split(" ");
  assert.deepEqual([pass, fail, notAuthoritative, noVerdict], ["0", "1", "3", "76"], "the public codes changed");

  const runbook = readFileSync(runbookPath, "utf8");
  for (const [code, line] of [
    [pass, "MERGE GATE: PASS <oid>"],
    [fail, "MERGE GATE: FAIL (<step>)"],
    [notAuthoritative, "MERGE GATE: NOT AUTHORITATIVE"],
    [noVerdict, "GATE NOT RUN: <reason>"],
  ]) {
    assert.match(
      runbook,
      new RegExp(`\\|\\s*\`${code}\`\\s*\\|[^|]*${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      `the runbook's row for ${code} does not carry ${line}`,
    );
  }
  assert.match(runbook, /`packages\/runner\/runtime-tools\/gate-worker\/lib\.sh`/);
  // 75 and 76 are only useful to an automation if the table says which is
  // which, and a gate the OOM killer takes is 128+N with no line at all — the
  // one case where a reader must not expect stdout to agree with the code.
  assert.match(runbook, /`75` and `76` are not interchangeable/);
  assert.match(runbook, /\|\s*`128\+N`\s*\|/);
  assert.match(runbook, /`137`/);
  // Which side of the judgement line a host failure falls on, in the table an
  // operator reads. The gate reports 76 for a docker preflight it could not
  // complete and 3 for a teardown that failed after every step passed, and a
  // runbook that still promised FAIL for either would send someone to look for
  // a defect in a commit nothing had judged.
  assert.match(
    runbook,
    new RegExp(`\\|\\s*\`${noVerdict}\`\\s*\\|[^|]*docker preflight[^|]*reachable daemon`, "u"),
    "the runbook's no-verdict row does not name the docker preflight",
  );
  assert.match(
    runbook,
    new RegExp(`\\|\\s*\`${notAuthoritative}\`\\s*\\|[^|]*cleanup`, "u"),
    "the runbook's not-authoritative row does not name a cleanup that failed after a pass",
  );
});

test("the isolation claim stays the one that is actually enforced", () => {
  // The operator's ruling, 2026-08-20: no egress control, so nothing here may probe a
  // route or make provisioning depend on one, and the runbook has to say plainly
  // that the box is not isolated. Exact inputs and the mirror's lack of a
  // remote stay fail-closed.
  const provision = readFileSync(provisionPath, "utf8");
  assert.doesNotMatch(provision, /\/dev\/tcp/, "provision.sh probes a route again");
  assert.doesNotMatch(provision, /GATE_GITHUB_HOSTS/, "the egress host list is back");

  const runbook = readFileSync(runbookPath, "utf8");
  assert.match(runbook, /not network-isolated/);
  assert.doesNotMatch(runbook, /^\s*ssh [^\n]*nft /m, "the runbook asks for a firewall rule again");

  // Credential presence is deliberately not a provisioning or runtime stop.
  assert.doesNotMatch(provision, /SECRET_VARS=/);
  assert.doesNotMatch(readFileSync(runGatePath, "utf8"), /SECRET_VARS=/);
  assert.match(runbook, /credentials do not block provisioning or gate\s+execution/i);

  // Exact pushed inputs and a mirror with no remote remain enforced.
  assert.match(
    readFileSync(mirrorPushPath, "utf8"),
    /refusing to push into a mirror this check could not inspect/,
  );
});
