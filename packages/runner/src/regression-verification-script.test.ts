import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../runtime-tools/regression-verification.sh");
const workerLib = resolve(dirname(script), "gate-worker/lib.sh");
const SHA = /^[0-9a-f]{40}$/u;

type Fixture = {
  root: string;
  work: string;
  origin: string;
  baseSha: string;
  branchSha: string;
  env: NodeJS.ProcessEnv;
  output: string;
  leaseLog: string;
  gateLog: string;
  argvLog: string;
  fetchLog: string;
  npmLog: string;
};

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "regression-fixture",
    GIT_AUTHOR_EMAIL: "regression@example.invalid",
    GIT_COMMITTER_NAME: "regression-fixture",
    GIT_COMMITTER_EMAIL: "regression@example.invalid",
  },
}).trim();

const executable = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
};

const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "agentos-regression-script-"));
  const seed = join(root, "seed");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  writeFileSync(join(seed, "base.txt"), "base\n");
  git(seed, "add", "base.txt");
  git(seed, "commit", "-m", "base");
  git(seed, "init", "--bare", origin);
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "main");
  const baseSha = git(seed, "rev-parse", "HEAD");
  git(seed, "switch", "-c", "feature");
  writeFileSync(join(seed, "feature.txt"), "feature\n");
  git(seed, "add", "feature.txt");
  git(seed, "commit", "-m", "feature");
  git(seed, "push", "origin", "feature");
  const branchSha = git(seed, "rev-parse", "HEAD");
  git(root, "clone", "--branch", "feature", origin, work);
  writeFileSync(join(work, ".git", "info", "exclude"), "\n/.agentos/\n", { flag: "a" });

  const bin = join(root, "bin");
  const output = join(work, ".agentos", "regression-output.json");
  const leaseLog = join(root, "lease.log");
  const gateLog = join(root, "gate.log");
  const argvLog = join(root, "argv.log");
  const fetchLog = join(root, "fetch.log");
  const npmLog = join(root, "npm.log");
  for (const path of [leaseLog, gateLog, argvLog, fetchLog, npmLog]) writeFileSync(path, "");
  // Pass-through unless a test asks for failures, so every other case still
  // reaches real git. `git fetch` is the only reachable transient network call
  // in this script, and it is what the retry budget exists for.
  executable(join(bin, "git"), `#!/bin/sh
if [ "$1" = "fetch" ] && [ "${"$"}{REGRESSION_FIXTURE_FETCH_FAILURES:-0}" -gt 0 ]; then
  attempt="$(wc -l < "$REGRESSION_FIXTURE_FETCH_LOG" | tr -d ' ')"
  attempt=$((attempt + 1))
  printf '%s\\n' "$attempt" >> "$REGRESSION_FIXTURE_FETCH_LOG"
  if [ "$attempt" -le "$REGRESSION_FIXTURE_FETCH_FAILURES" ]; then
    printf 'fatal: unable to access: LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443\\n' >&2
    exit 128
  fi
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "FETCH_HEAD" ]; then
  if [ "${"$"}{REGRESSION_FIXTURE_FETCH_HEAD_FAILURE:-0}" -eq 1 ]; then
    printf 'fatal: ambiguous argument FETCH_HEAD: unknown revision\n' >&2
    exit 128
  fi
  if [ "${"$"}{REGRESSION_FIXTURE_FETCH_HEAD_MALFORMED:-0}" -eq 1 ]; then
    printf 'not-an-object-id\n'
    exit 0
  fi
fi
exec "$REGRESSION_FIXTURE_GIT" "$@"
`);
  executable(join(bin, "node"), `#!/bin/sh
printf 'node %s\\n' "$*" >> "$REGRESSION_FIXTURE_ARGV_LOG"
exec "$REGRESSION_FIXTURE_NODE" "$@"
`);
  executable(join(bin, "npm"), `#!/bin/sh
printf '%s\\n' "$*" >> "$REGRESSION_FIXTURE_NPM_LOG"
exit "${"$"}{REGRESSION_FIXTURE_NPM_EXIT:-0}"
`);
  executable(join(bin, "merge-lease"), `#!/bin/sh
printf '%s\\n' "$*" >> "$REGRESSION_FIXTURE_LEASE_LOG"
exit "${"$"}{REGRESSION_FIXTURE_LEASE_EXIT:-0}"
`);
  executable(join(bin, "gate-dispatch"), `#!/bin/sh
if [ "${"$"}{AGENTOS_RUN_SCOPE_BYPASS:-}" != "regression-verification" ]; then
  printf 'missing regression scope bypass\n' >&2
  exit 99
fi
printf '%s\\n' "$*" >> "$REGRESSION_FIXTURE_GATE_LOG"
[ -z "${"$"}{REGRESSION_FIXTURE_GATE_NOISE:-}" ] || printf '%s\\n' "$REGRESSION_FIXTURE_GATE_NOISE"
printf '%s\\n' "${"$"}{REGRESSION_FIXTURE_GATE_PROOF:-MERGE GATE: PASS $1}"
exit "${"$"}{REGRESSION_FIXTURE_GATE_EXIT:-0}"
`);
  const inheritedEnvironment = { ...process.env };
  delete inheritedEnvironment.AGENTOS_SESSION_TOKEN;
  delete inheritedEnvironment.AGENTOS_FENCING_TOKEN;
  for (const name of Object.keys(inheritedEnvironment)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/u.test(name)) delete inheritedEnvironment[name];
  }
  return {
    root, work, origin, baseSha, branchSha, output, leaseLog, gateLog, argvLog, fetchLog, npmLog,
    env: {
      ...inheritedEnvironment,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AGENTOS_RUN_ID: "run-1",
      AGENTOS_WORKSPACE_PATH: work,
      AGENTOS_CHAIN_ID: "chain-1",
      AGENTOS_PULL_REQUEST_BASE: "main",
      REGRESSION_MERGE_LEASE: join(bin, "merge-lease"),
      REGRESSION_GATE_DISPATCH: join(bin, "gate-dispatch"),
      REGRESSION_FIXTURE_LEASE_LOG: leaseLog,
      REGRESSION_FIXTURE_GATE_LOG: gateLog,
      REGRESSION_FIXTURE_ARGV_LOG: argvLog,
      REGRESSION_FIXTURE_FETCH_LOG: fetchLog,
      REGRESSION_FIXTURE_NPM_LOG: npmLog,
      REGRESSION_FIXTURE_GIT: execFileSync("/usr/bin/env", ["sh", "-c", "command -v git"], { encoding: "utf8" }).trim(),
      REGRESSION_FIXTURE_NODE: process.execPath,
      GIT_AUTHOR_NAME: "regression-fixture",
      GIT_AUTHOR_EMAIL: "regression@example.invalid",
      GIT_COMMITTER_NAME: "regression-fixture",
      GIT_COMMITTER_EMAIL: "regression@example.invalid",
    },
  };
};

const runScript = (seeded: Fixture, scriptPath: string, cwd: string, ...args: string[]) => spawnSync("bash", [scriptPath, ...args], {
  cwd,
  env: seeded.env,
  encoding: "utf8",
});

const run = (seeded: Fixture, ...args: string[]) => runScript(seeded, script, seeded.work, ...args);

type Handoff = {
  schemaVersion: number;
  runId: string;
  kind: string;
  body: string;
  commitSha: string;
};

const handoff = (seeded: Fixture): Handoff =>
  JSON.parse(readFileSync(seeded.output, "utf8")) as Handoff;

const adjacentTooling = (seeded: Fixture): { root: string; dispatchLog: string } => {
  const root = join(seeded.root, "runtime-tools");
  const worker = join(root, "gate-worker");
  const dispatchLog = join(seeded.root, "adjacent-dispatch.log");
  mkdirSync(worker, { recursive: true });
  cpSync(script, join(root, "regression-verification.sh"));
  cpSync(workerLib, join(worker, "lib.sh"));
  executable(join(worker, "gate-dispatch.sh"), `#!/usr/bin/env bash
set -u
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${"$"}{BASH_SOURCE[0]}")" && pwd -P)"
. "$SCRIPT_DIR/lib.sh"
declare -F gate_verdict_read >/dev/null || exit 19
printf 'adjacent-dispatch\\n' >> "$REGRESSION_FIXTURE_ADJACENT_DISPATCH_LOG"
printf 'MERGE GATE: PASS %s\\n' "$1"
`);
  return { root, dispatchLog };
};

test("the script uses adjacent tooling when copied outside the checkout", () => {
  const seeded = fixture();
  const tooling = adjacentTooling(seeded);
  delete seeded.env.REGRESSION_GATE_DISPATCH;
  seeded.env.REGRESSION_FIXTURE_ADJACENT_DISPATCH_LOG = tooling.dispatchLog;

  const prepared = runScript(seeded, "./regression-verification.sh", tooling.root, "prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /^REGRESSION PREPARE: ready [0-9a-f]{40} [0-9a-f]{40}\n$/u);

  const finalized = runScript(seeded, "./regression-verification.sh", tooling.root, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.match(finalized.stdout, /^REGRESSION FINALIZE: pass [0-9a-f]{40}\n$/u);
  assert.equal(readFileSync(tooling.dispatchLog, "utf8"), "adjacent-dispatch\n");
  assert.equal(JSON.parse(handoff(seeded).body).outcome, "pass");
});

test("the repository-path command still uses its adjacent gate worker", () => {
  const seeded = fixture();
  const prepared = run(seeded, "prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.match(finalized.stdout, /^REGRESSION FINALIZE: pass [0-9a-f]{40}\n$/u);
  assert.match(readFileSync(seeded.gateLog, "utf8"), /^[0-9a-f]{40} --master [0-9a-f]{40}\n$/u);
  assert.equal(JSON.parse(handoff(seeded).body).outcome, "pass");
});

test("prepare refreshes before semantic review without acquiring the merge lease", () => {
  const seeded = fixture();
  const prepared = run(seeded, "prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /^REGRESSION PREPARE: ready [0-9a-f]{40} [0-9a-f]{40}\n$/u);
  assert.equal(git(seeded.work, "merge-base", "--is-ancestor", seeded.baseSha, "HEAD"), "");
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "", "prepare held no lease");
  assert.equal(existsSync(seeded.output), false, "prepare emitted no final output");
});

// The workspace generated its Prisma client at provisioning, before the refresh
// merge moved the tree. Without regeneration the first typecheck of the recheck
// reports the stale client as a defect in the code being verified.
const advanceBase = (seeded: Fixture, file: string, content: string): void => {
  const main = join(seeded.root, `main-${file.replace(/[^a-z0-9]+/giu, "-")}`);
  git(seeded.root, "clone", "--branch", "main", seeded.origin, main);
  mkdirSync(dirname(join(main, file)), { recursive: true });
  writeFileSync(join(main, file), content);
  git(main, "add", file);
  git(main, "commit", "-m", `advance ${file}`);
  git(main, "push", "origin", "main");
};

test("prepare regenerates the Prisma client when the refresh changes a schema", () => {
  const seeded = fixture();
  advanceBase(seeded, "packages/db/prisma/schema.prisma", "// refreshed schema\n");
  const prepared = run(seeded, "prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /^REGRESSION PREPARE: ready [0-9a-f]{40} [0-9a-f]{40}\n$/u);
  assert.equal(readFileSync(seeded.npmLog, "utf8"), "run db:generate\n");
});

test("prepare leaves the Prisma client alone when the refresh changes no schema", () => {
  const seeded = fixture();
  advanceBase(seeded, "drift.txt", "drift\n");
  const prepared = run(seeded, "prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(readFileSync(seeded.npmLog, "utf8"), "");
});

test("prepare fails loudly when the refreshed Prisma client cannot be regenerated", () => {
  const seeded = fixture();
  advanceBase(seeded, "packages/db/prisma/schema.prisma", "// refreshed schema\n");
  seeded.env.REGRESSION_FIXTURE_NPM_EXIT = "1";
  const prepared = run(seeded, "prepare");
  assert.equal(prepared.status, 1);
  assert.match(prepared.stderr, /cannot regenerate the Prisma client for the refreshed tree/u);
  assert.equal(existsSync(seeded.output), false, "a broken workspace publishes no verdict");
});

test("a semantic-stale refresh regenerates the Prisma client for the newer target", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  advanceBase(seeded, "packages/db/prisma/schema.prisma", "// later schema\n");
  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 77, finalized.stderr);
  assert.match(finalized.stdout, /^REGRESSION FINALIZE: semantic-stale /u);
  assert.equal(readFileSync(seeded.npmLog, "utf8"), "run db:generate\n");
});

test("finalize publishes the dispatch PASS handoff before readiness acquires the lease", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_NOISE = "verbose gate detail that stays platform-side";
  seeded.env.REGRESSION_FIXTURE_LEASE_EXIT = "99";
  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  const headSha = git(seeded.work, "rev-parse", "HEAD");
  assert.match(headSha, SHA);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "", "Regression never touches the merge lease");
  assert.equal(readFileSync(seeded.gateLog, "utf8").trim(), `${headSha} --master ${seeded.baseSha}`);
  const published = handoff(seeded);
  const verdict = JSON.parse(published.body) as Record<string, unknown>;
  assert.deepEqual(verdict, {
    schemaVersion: 2,
    outcome: "pass",
    headSha,
    baseHeadSha: seeded.baseSha,
    gateVerdict: "PASS",
    gateProof: `MERGE GATE: PASS ${headSha}`,
  });
  assert.deepEqual(published, {
    schemaVersion: 1,
    runId: "run-1",
    kind: "regression-verification-v2",
    body: JSON.stringify(verdict),
    commitSha: headSha,
  });
  assert.equal(statSync(seeded.output).mode & 0o077, 0, "handoff is private to the Run user");
  assert.equal(finalized.stdout, `REGRESSION FINALIZE: pass ${headSha}\n`);
  assert.doesNotMatch(finalized.stdout, /verbose gate detail/u);
});

test("the mechanical handoff requires no session or fencing credentials", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  assert.equal(run(seeded, "review-fail", "review summary").status, 0);
  const argv = readFileSync(seeded.argvLog, "utf8");
  assert.doesNotMatch(argv, /session-token|fence-1/u);
  assert.equal(seeded.env.AGENTOS_SESSION_TOKEN, undefined);
  assert.equal(seeded.env.AGENTOS_FENCING_TOKEN, undefined);
});

test("an unreachable target fails prepare and finalize with a block record", () => {
  const prepareFixture = fixture();
  git(prepareFixture.work, "remote", "set-url", "origin", join(prepareFixture.root, "missing.git"));
  const prepared = run(prepareFixture, "prepare");
  assert.notEqual(prepared.status, 0);
  assert.match(prepared.stderr, /target fetch failed \(exit \d+\): .*does not appear to be a git repository/su);
  assert.doesNotMatch(prepared.stderr, /retrying attempt/u);
  assert.doesNotMatch(prepared.stdout, /refresh-conflict/u);
  assert.equal(existsSync(prepareFixture.output), true);

  const finalizeFixture = fixture();
  assert.equal(run(finalizeFixture, "prepare").status, 0);
  git(finalizeFixture.work, "remote", "set-url", "origin", join(finalizeFixture.root, "missing.git"));
  const finalized = run(finalizeFixture, "finalize");
  assert.notEqual(finalized.status, 0);
  assert.match(finalized.stderr, /target fetch failed \(exit \d+\): .*does not appear to be a git repository/su);
  assert.doesNotMatch(finalized.stdout, /refresh-conflict/u);
  assert.equal(existsSync(finalizeFixture.output), true);
});

test("a transient target fetch failure is retried instead of failing the Run", () => {
  const seeded = fixture();
  seeded.env.REGRESSION_FIXTURE_FETCH_FAILURES = "3";
  const prepared = run(seeded, "prepare");
  assert.equal(prepared.status, 0);
  assert.match(prepared.stdout, /REGRESSION PREPARE: ready/u);
  assert.match(prepared.stderr, /retrying attempt=4\/6/u);
  assert.equal(readFileSync(seeded.fetchLog, "utf8").trim().split("\n").length, 4);
});

test("a target fetch failure leaves a machine-readable block record", () => {
  const seeded = fixture();
  seeded.env.REGRESSION_FIXTURE_FETCH_FAILURES = "6";
  const prepared = run(seeded, "prepare");
  assert.notEqual(prepared.status, 0);
  assert.match(prepared.stderr, /target fetch failed after 6 attempts: .*SSL_ERROR_SYSCALL/u);
  assert.equal(existsSync(seeded.output), true);
  const block = JSON.parse(readFileSync(seeded.output, "utf8")) as Record<string, unknown>;
  assert.equal(block.schemaVersion, 1);
  assert.equal(block.runId, "run-1");
  assert.equal(block.kind, "regression-verification-v2");
  assert.equal(block.reason, "target-fetch-failed");
  assert.equal(
    block.stderr,
    "fatal: unable to access: LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
  );
});

test("an unreadable fetched target leaves a machine-readable block record", () => {
  const seeded = fixture();
  seeded.env.REGRESSION_FIXTURE_FETCH_HEAD_FAILURE = "1";

  const prepared = run(seeded, "prepare");

  assert.notEqual(prepared.status, 0);
  assert.match(prepared.stderr, /cannot read fetched target \(exit 128\): .*unknown revision/u);
  const block = JSON.parse(readFileSync(seeded.output, "utf8")) as Record<string, unknown>;
  assert.equal(block.reason, "target-fetch-failed");
  assert.equal(block.stderr, "fatal: ambiguous argument FETCH_HEAD: unknown revision");
});

test("a malformed fetched target leaves a machine-readable block record", () => {
  const seeded = fixture();
  seeded.env.REGRESSION_FIXTURE_FETCH_HEAD_MALFORMED = "1";

  const prepared = run(seeded, "prepare");

  assert.notEqual(prepared.status, 0);
  assert.match(prepared.stderr, /fetched target is not an object id: not-an-object-id/u);
  const block = JSON.parse(readFileSync(seeded.output, "utf8")) as Record<string, unknown>;
  assert.equal(block.reason, "target-fetch-failed");
  assert.equal(block.stderr, "fetched target is not an object id: not-an-object-id");
});

test("a successful target fetch leaves no block record", () => {
  const seeded = fixture();

  const prepared = run(seeded, "prepare");

  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(existsSync(seeded.output), false);
});

test("finalize refreshes drift outside the lease and requires semantic recheck", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  const main = join(seeded.root, "main");
  git(seeded.root, "clone", "--branch", "main", seeded.origin, main);
  writeFileSync(join(main, "drift.txt"), "drift\n");
  git(main, "add", "drift.txt");
  git(main, "commit", "-m", "drift");
  git(main, "push", "origin", "main");

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 77, finalized.stderr);
  assert.match(finalized.stdout, /^REGRESSION FINALIZE: semantic-stale /u);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "", "drift was detected before acquire");
  assert.equal(readFileSync(seeded.gateLog, "utf8"), "");
  assert.equal(existsSync(seeded.output), false);
  assert.equal(readFileSync(join(seeded.work, "drift.txt"), "utf8"), "drift\n");
});

test("finalize refuses a PASS when the target moves during the gate", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  const main = join(seeded.root, "main-during-gate");
  git(seeded.root, "clone", "--branch", "main", seeded.origin, main);
  const driftGate = join(seeded.root, "bin", "drift-gate");
  executable(driftGate, `#!/bin/sh
printf 'drift during gate\n' > '${main}/during-gate.txt'
git -C '${main}' add during-gate.txt
git -C '${main}' commit -m 'drift during gate' >/dev/null
git -C '${main}' push origin main >/dev/null
printf 'MERGE GATE: PASS %s\n' "$1"
`);
  seeded.env.REGRESSION_GATE_DISPATCH = driftGate;

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 77, finalized.stderr);
  assert.match(finalized.stdout, /^REGRESSION FINALIZE: semantic-stale /u);
  assert.equal(existsSync(seeded.output), false);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  assert.equal(readFileSync(join(seeded.work, "during-gate.txt"), "utf8"), "drift during gate\n");
});

test("review-fail is emitted mechanically without acquiring or dispatching", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  const failed = run(seeded, "review-fail", "RF-2 remains open");
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  assert.equal(readFileSync(seeded.gateLog, "utf8"), "");
  const verdict = JSON.parse(handoff(seeded).body) as Record<string, unknown>;
  assert.equal(verdict.outcome, "review-fail");
  assert.equal(verdict.summary, "RF-2 remains open");
  assert.equal(verdict.baseHeadSha, seeded.baseSha);
});

test("gate FAIL preserves its proof without touching the merge lease", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF = "MERGE GATE: FAIL (runner package tests)";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "1";
  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  assert.deepEqual(JSON.parse(handoff(seeded).body), {
    schemaVersion: 2,
    outcome: "gate-fail",
    headSha: git(seeded.work, "rev-parse", "HEAD"),
    baseHeadSha: seeded.baseSha,
    gateVerdict: "FAIL",
    gateProof: "MERGE GATE: FAIL (runner package tests)",
    summary: "runner package tests",
    gateFailureExcerpt: "runner package tests: no per-test output in gate log",
  });
});

test("gate FAIL records pytest node ids, assertion details, and repository verdicts", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_NOISE = [
    "=================================== FAILURES ===================================",
    "_________________________________ test_alpha __________________________________",
    ">       assert actual == expected",
    "E   assert actual == expected",
    "__________________________________ test_beta __________________________________",
    "E   RuntimeError: business rule unmet",
    "=========================== short test summary info ============================",
    "FAILED tests/test_alpha.py::test_alpha - assert actual == expected",
    "FAILED tests/test_beta.py::test_beta - business rule unmet",
    "PYTEST-REGRESSION: UNMET business failure",
  ].join("\n");
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF = "MERGE GATE: FAIL (python tests)";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "1";

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  const verdict = JSON.parse(handoff(seeded).body) as Record<string, unknown>;
  const excerpt = verdict.gateFailureExcerpt;
  assert.equal(typeof excerpt, "string");
  if (typeof excerpt !== "string") throw new Error("gate failure excerpt was not persisted as a string");
  assert.match(excerpt, /tests\/test_alpha\.py::test_alpha/u);
  assert.match(excerpt, /tests\/test_beta\.py::test_beta/u);
  assert.match(excerpt, /E   assert actual == expected/u);
  assert.match(excerpt, /PYTEST-REGRESSION: UNMET business failure/u);
  assert.doesNotMatch(excerpt, /python tests: no per-test output in gate log/u);
});

test("gate FAIL preserves a terminal repository verdict after forty pytest failures", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_NOISE = [
    "=========================== short test summary info ============================",
    ...Array.from(
      { length: 45 },
      (_, index) => `FAILED tests/test_module_${index}.py::test_case_${index} - assertion failed`,
    ),
    "PYTEST-REGRESSION: UNMET business failures=45 unknown=0",
  ].join("\n");
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF = "MERGE GATE: FAIL (python tests)";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "1";

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  const verdict = JSON.parse(handoff(seeded).body) as Record<string, unknown>;
  const excerpt = verdict.gateFailureExcerpt;
  assert.equal(typeof excerpt, "string");
  if (typeof excerpt !== "string") throw new Error("gate failure excerpt was not persisted as a string");
  assert.match(excerpt, /PYTEST-REGRESSION: UNMET business failures=45 unknown=0/u);
  assert.ok(excerpt.split("\n").length <= 40, "failure excerpt exceeded its line cap");
  assert.ok(Buffer.byteLength(excerpt, "utf8") <= 4000, "failure excerpt exceeded its byte cap");
});

test("gate FAIL omits passing pytest node ids from failure context", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_NOISE = [
    "== python tests",
    ...Array.from(
      { length: 20 },
      (_, index) => `tests/test_module_${index}.py::test_case_${index} PASSED [${index + 1}%]`,
    ),
    "FAILED tests/test_failure.py::test_failure - assert false",
  ].join("\n");
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF = "MERGE GATE: FAIL (python tests)";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "1";

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  const verdict = JSON.parse(handoff(seeded).body) as Record<string, unknown>;
  const excerpt = verdict.gateFailureExcerpt;
  assert.equal(typeof excerpt, "string");
  if (typeof excerpt !== "string") throw new Error("gate failure excerpt was not persisted as a string");
  assert.match(excerpt, /FAILED tests\/test_failure\.py::test_failure/u);
  assert.doesNotMatch(excerpt, /\bPASSED\b/u);
});

test("gate FAIL extracts a node:test subtest, not ok, and assertion block", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_NOISE = [
    "== unit tests (all workspaces)",
    "# Subtest: packages/example.test.ts",
    "    not ok 1 - broken assertion",
    "      AssertionError: broken assertion",
  ].join("\n");
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF = "MERGE GATE: FAIL (unit tests (all workspaces))";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "1";

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  const verdict = JSON.parse(handoff(seeded).body) as Record<string, unknown>;
  assert.equal(
    verdict.gateFailureExcerpt,
    [
      "# Subtest: packages/example.test.ts",
      "    not ok 1 - broken assertion",
      "      AssertionError: broken assertion",
    ].join("\n"),
  );
});

test("gate FAIL records bounded node:test failures and missing-stage output", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  const noisyFailures = [
    "== unit tests (all workspaces)",
    "# Subtest: packages/passing.test.ts",
    "    ok 1 - passing assertion in passing.test.ts",
    "# Subtest: packages/first.test.ts",
    "    not ok 1 - first assertion in first.test.ts",
    "      \u001b[31mAssertionError: first assertion in first.test.ts\u001b[0m",
    "# Subtest: packages/second.test.ts",
    "    not ok 1 - first assertion in second.test.ts",
    "      Error: first assertion in second.test.ts",
    ...Array.from({ length: 45 }, (_, index) => `    not ok ${index + 2} - noisy assertion ${index + 1}`),
    "--- database tests (db + api) ---",
  ];
  seeded.env.REGRESSION_FIXTURE_GATE_NOISE = noisyFailures.join("\n");
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF =
    "MERGE GATE: FAIL (unit tests (all workspaces), database tests (db + api))";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "1";

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  const verdict = JSON.parse(handoff(seeded).body) as Record<string, unknown>;
  const excerpt = verdict.gateFailureExcerpt;
  assert.equal(typeof excerpt, "string");
  if (typeof excerpt !== "string") throw new Error("gate failure excerpt was not persisted as a string");
  assert.match(excerpt, /packages\/first\.test\.ts/u);
  assert.match(excerpt, /first assertion in first\.test\.ts/u);
  assert.match(excerpt, /packages\/second\.test\.ts/u);
  assert.match(excerpt, /first assertion in second\.test\.ts/u);
  assert.doesNotMatch(excerpt, /passing\.test\.ts/u);
  assert.equal(excerpt.includes("\u001b"), false);
  assert.match(excerpt, /database tests \(db \+ api\): no per-test output in gate log/u);
  assert.ok(excerpt.split("\n").length <= 40, "failure excerpt exceeded its line cap");
  assert.ok(Buffer.byteLength(excerpt, "utf8") <= 4000, "failure excerpt exceeded its byte cap");
});

test("gate FAIL persists assertions from a forwarded nested-workspace excerpt", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_NOISE = [
    "run-gate: failure excerpt (last 200 lines per failing step)",
    "--- unit tests (all workspaces) ---",
    "# Subtest: packages/workspace-one/src/nested-failure.test.ts",
    "    not ok 1 - nested workspace assertion",
    "      AssertionError: nested workspace assertion",
    ...Array.from(
      { length: 197 },
      (_, index) => `ok ${index + 1} - trailing workspace passing output ${String(index).padStart(3, "0")}`,
    ),
  ].join("\n");
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF = "MERGE GATE: FAIL (unit tests (all workspaces))";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "1";

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  const verdict = JSON.parse(handoff(seeded).body) as Record<string, unknown>;
  const excerpt = verdict.gateFailureExcerpt;
  assert.equal(typeof excerpt, "string");
  if (typeof excerpt !== "string") throw new Error("gate failure excerpt was not persisted as a string");
  assert.match(excerpt, /packages\/workspace-one\/src\/nested-failure\.test\.ts/u);
  assert.match(excerpt, /AssertionError: nested workspace assertion/u);
  assert.doesNotMatch(excerpt, /unit tests \(all workspaces\): no per-test output in gate log/u);
});

test("gate FAIL keeps missing-stage notices when forwarded output starts mid-stage", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_NOISE = [
    "    not ok 1 - packages/api/src/late.test.ts",
    "      AssertionError: late failure",
  ].join("\n");
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF =
    "MERGE GATE: FAIL (unit tests (all workspaces), database tests (db + api))";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "1";

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 0, finalized.stderr);
  const verdict = JSON.parse(handoff(seeded).body) as Record<string, unknown>;
  const excerpt = verdict.gateFailureExcerpt;
  assert.equal(typeof excerpt, "string");
  if (typeof excerpt !== "string") throw new Error("gate failure excerpt was not persisted as a string");
  assert.match(excerpt, /packages\/api\/src\/late\.test\.ts/u);
  assert.match(excerpt, /unit tests \(all workspaces\): no per-test output in gate log/u);
  assert.match(excerpt, /database tests \(db \+ api\): no per-test output in gate log/u);
});

test("prepare emits refresh-conflict mechanically and leaves a deliverable workspace", () => {
  const seeded = fixture();
  const main = join(seeded.root, "main-conflict");
  git(seeded.root, "clone", "--branch", "main", seeded.origin, main);
  writeFileSync(join(main, "base.txt"), "main change\n");
  git(main, "add", "base.txt");
  git(main, "commit", "-m", "main conflict");
  git(main, "push", "origin", "main");
  writeFileSync(join(seeded.work, "base.txt"), "feature change\n");
  git(seeded.work, "add", "base.txt");
  git(seeded.work, "commit", "-m", "feature conflict");
  const preRefreshHead = git(seeded.work, "rev-parse", "HEAD");

  const prepared = run(seeded, "prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /REGRESSION PREPARE: refresh-conflict base\.txt/u);
  assert.equal(git(seeded.work, "rev-parse", "HEAD"), preRefreshHead);
  assert.equal(git(seeded.work, "status", "--porcelain"), "");
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  const verdict = JSON.parse(handoff(seeded).body) as Record<string, unknown>;
  assert.equal(verdict.outcome, "refresh-conflict");
  assert.equal(verdict.headSha, preRefreshHead);
  assert.equal(verdict.summary, "base.txt");
});

test("a non-conflict merge failure aborts loudly without persisting output", () => {
  const seeded = fixture();
  const main = join(seeded.root, "main-hook-failure");
  git(seeded.root, "clone", "--branch", "main", seeded.origin, main);
  writeFileSync(join(main, "drift.txt"), "drift\n");
  git(main, "add", "drift.txt");
  git(main, "commit", "-m", "drift");
  git(main, "push", "origin", "main");
  executable(join(seeded.work, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nprintf 'fixture hook refused merge\\n' >&2\nexit 1\n");

  const prepared = run(seeded, "prepare");
  assert.notEqual(prepared.status, 0);
  assert.match(prepared.stderr, /fixture hook refused merge/u);
  assert.match(prepared.stderr, /merge failed without conflicts/u);
  assert.equal(existsSync(seeded.output), false);
  assert.equal(git(seeded.work, "status", "--porcelain"), "");
});

test("a gate without a verdict dies loudly without publishing a handoff or taking a lease", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF = "gate exited before verdict";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "143";

  const finalized = run(seeded, "finalize");
  assert.notEqual(finalized.status, 0);
  assert.match(finalized.stderr, /no admissible PASS\/FAIL verdict after 1 attempt\(s\) \(exit 143\)/u);
  assert.match(finalized.stdout, /REGRESSION FINALIZE: gate dispatch log tail \(attempts=1, last exit status=143\)/u);
  assert.match(finalized.stdout, /gate exited before verdict/u);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  assert.equal(existsSync(seeded.output), false);
});

test("a retried no-verdict gate prints the bounded tail without publishing a handoff", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  const attemptsLog = join(seeded.root, "no-verdict-attempts.log");
  const noVerdictGate = join(seeded.root, "bin", "no-verdict-gate");
  writeFileSync(attemptsLog, "");
  executable(noVerdictGate, `#!/bin/sh
attempt="$(wc -l < '${attemptsLog}' | tr -d ' ')"
attempt=$((attempt + 1))
printf '%s\\n' "$attempt" >> '${attemptsLog}'
if [ "$attempt" -lt 3 ]; then
  printf 'stub no-verdict output %s\\n' "$attempt"
else
  line=1
  while [ "$line" -le 70 ]; do
    printf 'noise-%02d ' "$line"
    column=1
    while [ "$column" -le 30 ]; do
      printf '界'
      column=$((column + 1))
    done
    printf '\\n'
    line=$((line + 1))
  done
  printf '\\nstub distinguishing output after blank line!\\nstub no-verdict output 3\\n'
fi
exit 76
`);
  seeded.env.REGRESSION_GATE_DISPATCH = noVerdictGate;

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 1);
  const heading = "REGRESSION FINALIZE: gate dispatch log tail (attempts=3, last exit status=76)";
  const headingIndex = finalized.stdout.indexOf(`${heading}\n`);
  assert.notEqual(headingIndex, -1, finalized.stdout);
  const printedTail = finalized.stdout.slice(headingIndex + heading.length + 1, -1);
  assert.ok(printedTail.split("\n").length <= 60, printedTail);
  assert.ok(Buffer.byteLength(printedTail, "utf8") <= 4000, printedTail);
  assert.doesNotMatch(printedTail, /\uFFFD/u);
  const truncatedFirstLine = printedTail.split("\n")[0] ?? "";
  assert.match(truncatedFirstLine, /^noise-\d+ 界+$/u);
  assert.ok(Buffer.byteLength(truncatedFirstLine, "utf8") < 99, truncatedFirstLine);
  assert.match(printedTail, /\n\nstub distinguishing output after blank line!\n/u);
  assert.match(printedTail, /stub no-verdict output 3/u);
  assert.doesNotMatch(printedTail, /^(?:MERGE GATE:|GATE NOT RUN:)/mu);
  assert.match(finalized.stderr, /no admissible PASS\/FAIL verdict after 3 attempt\(s\) \(exit 76\)/u);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  assert.equal(existsSync(seeded.output), false);
});

test("a failed no-verdict tail extractor preserves the primary diagnostic", () => {
  const seeded = fixture();
  assert.equal(run(seeded, "prepare").status, 0);
  seeded.env.REGRESSION_FIXTURE_GATE_PROOF = "gate exited before verdict";
  seeded.env.REGRESSION_FIXTURE_GATE_EXIT = "143";
  executable(join(dirname(seeded.env.REGRESSION_GATE_DISPATCH!), "node"), `#!/bin/sh
if [ "$1" = "-" ] && [ "$2" = "no-verdict" ]; then
  printf 'fixture extractor failure\\n' >&2
  exit 19
fi
exec "$REGRESSION_FIXTURE_NODE" "$@"
`);

  const finalized = run(seeded, "finalize");
  assert.equal(finalized.status, 1);
  assert.match(finalized.stdout, /REGRESSION FINALIZE: gate dispatch log tail \(attempts=1, last exit status=143\)/u);
  assert.match(finalized.stderr, /warning: could not extract no-verdict gate log tail/u);
  assert.match(finalized.stderr, /no admissible PASS\/FAIL verdict after 1 attempt\(s\) \(exit 143\)/u);
  assert.equal(readFileSync(seeded.leaseLog, "utf8"), "");
  assert.equal(existsSync(seeded.output), false);
});
