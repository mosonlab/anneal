import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const referencePath = join(repositoryRoot, "docs", "repo-contract", "merge-gate.sh");
const source = readFileSync(referencePath, "utf8");
const commandMarker = "  npm test\n";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "repo-contract-gate-fixture",
  GIT_AUTHOR_EMAIL: "repo-contract-gate-fixture",
  GIT_COMMITTER_NAME: "repo-contract-gate-fixture",
  GIT_COMMITTER_EMAIL: "repo-contract-gate-fixture",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
for (const name of Object.keys(GIT_ENV)) {
  if (name.startsWith("AGENTOS_RUN_")) delete GIT_ENV[name];
}

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const write = (cwd, name, contents) => writeFileSync(join(cwd, name), contents);

const commit = (cwd, message) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

const fixture = (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "repo-contract-gate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q", "-b", "main");
  write(cwd, "tracked.txt", "base\n");
  const master = commit(cwd, "baseline");
  git(cwd, "checkout", "-q", "-b", "feature");
  write(cwd, "tracked.txt", "candidate\n");
  const head = commit(cwd, "candidate");
  return { cwd, master, head };
};

const installGate = (t, replacement) => {
  assert.equal(source.match(new RegExp(commandMarker, "g"))?.length, 1);
  const directory = mkdtempSync(join(tmpdir(), "repo-contract-gate-script-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "merge-gate.sh");
  writeFileSync(path, source.replace(commandMarker, () => `${replacement}\n`), { mode: 0o755 });
  return path;
};

const run = (t, fixtureData, replacement, args = [], overrides = {}) => {
  const script = installGate(t, replacement);
  const result = spawnSync("bash", [script, ...args], {
    cwd: fixtureData.cwd,
    env: { ...GIT_ENV, ...overrides },
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const runWithExternalSignal = async (t, fixtureData, signal, status) => {
  const ready = join(fixtureData.cwd, `ready-${signal}`);
  const replacement = [
    `trap 'sleep 0.1; printf "DUMMY LATE OUTPUT\\n"; exit ${status}' TERM`,
    `printf 'ready\\n' > "$GATE_FIXTURE_READY"`,
    "while :; do sleep 1; done",
  ].join("\n");
  const script = installGate(t, replacement);
  const child = spawn("bash", ["-c", 'exec "$@" 2>&1', "signal-gate", "bash", script, "--master", fixtureData.master], {
    cwd: fixtureData.cwd,
    env: { ...GIT_ENV, GATE_FIXTURE_READY: ready },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });

  // The readiness file comes from a real `bash merge-gate.sh` fixture, so this
  // covers a bash+git start rather than the signal under test. The deadline
  // stays bounded — a child that never becomes ready must fail here rather than
  // hang the suite — but it is sized for the loaded gate worker, not an idle
  // host (CONTRIBUTING.md, "Test timing on the gate worker").
  const readyDeadline = Date.now() + 60_000;
  while (!existsSync(ready) && Date.now() < readyDeadline) await delay(10);
  assert.equal(existsSync(ready), true, `repository command never became ready for ${signal}`);
  assert.equal(child.kill(signal), true, `could not send ${signal}`);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitStatus) => resolve({ status: exitStatus, output }));
  });
  return result;
};

const finalLine = (result) => {
  const lines = result.output.trimEnd().split(/\r?\n/u);
  const ansiEscape = String.fromCharCode(27);
  return lines.at(-1)?.replace(new RegExp(`${ansiEscape}\\[[0-9;]*m`, "gu"), "") ?? "";
};

const assertNoVerdict = (result) => {
  assert.doesNotMatch(result.output, /^(?:MERGE GATE|GATE NOT RUN):/mu);
};

test("a passing command with both pins emits the authoritative PASS wire line", (t) => {
  const data = fixture(t);
  const result = run(t, data, ":", ["--expect-head", data.head, "--master", data.master]);
  assert.equal(result.status, 0, result.output);
  assert.equal(finalLine(result), `MERGE GATE: PASS ${data.head}`);
});

test("a passing manual command without --master is not authoritative", (t) => {
  const data = fixture(t);
  const result = run(t, data, ":", ["--expect-head", data.head]);
  assert.equal(result.status, 3, result.output);
  assert.equal(finalLine(result), "MERGE GATE: NOT AUTHORITATIVE (master not stated)");
});

test("a command failure is a FAIL verdict with status one", (t) => {
  const data = fixture(t);
  const result = run(t, data, "exit 7", ["--expect-head", data.head, "--master", data.master]);
  assert.equal(result.status, 1, result.output);
  assert.equal(finalLine(result), "MERGE GATE: FAIL (the repository test command failed (exit 7))");
});

test("test commands stopped from outside retain no-verdict statuses", (t) => {
  const signals = [[129, "SIGHUP"], [131, "SIGQUIT"], [137, "SIGKILL"]];
  for (const [status, signal] of signals) {
    const data = fixture(t);
    const result = run(t, data, `exit ${status}`, ["--master", data.master]);
    assert.equal(result.status, status, result.output);
    assert.equal(finalLine(result), `GATE NOT RUN: the repository test command was stopped by ${signal}`);
  }
});

test("usage errors return two without any verdict and do not run the command", (t) => {
  const data = fixture(t);
  const witness = join(data.cwd, "command-ran");
  const replacement = `touch "$GATE_FIXTURE_WITNESS"`;
  const result = run(t, data, replacement, ["--expect-head"], { GATE_FIXTURE_WITNESS: witness });
  assert.equal(result.status, 2, result.output);
  assertNoVerdict(result);
  assert.equal(existsSync(witness), false);
});

test("an Anneal Run refuses before the repository command with code 76", (t) => {
  const data = fixture(t);
  const witness = join(data.cwd, "command-ran");
  const result = run(t, data, `touch "$GATE_FIXTURE_WITNESS"`, ["--master", data.master], {
    AGENTOS_RUN_ID: "fixture-run",
    GATE_FIXTURE_WITNESS: witness,
  });
  assert.equal(result.status, 76, result.output);
  assert.equal(finalLine(result), "GATE NOT RUN: refused inside Anneal run fixture-run");
  assert.equal(existsSync(witness), false);
});

test("an Anneal Run cannot bypass the reference gate with an environment value", (t) => {
  const data = fixture(t);
  const witness = join(data.cwd, "command-ran");
  const result = run(t, data, `touch "$GATE_FIXTURE_WITNESS"`, ["--master", data.master], {
    AGENTOS_RUN_ID: "forged-reference-run",
    AGENTOS_RUN_SCOPE_BYPASS: "regression-verification",
    GATE_FIXTURE_WITNESS: witness,
  });
  assert.equal(result.status, 76, result.output);
  assert.equal(finalLine(result), "GATE NOT RUN: refused inside Anneal run forged-reference-run");
  assert.equal(existsSync(witness), false);
});

test("a mismatched expect-head is a FAIL precondition", (t) => {
  const data = fixture(t);
  const mismatch = run(t, data, "touch should-not-run", ["--expect-head", "0".repeat(40), "--master", data.master]);
  assert.equal(mismatch.status, 1, mismatch.output);
  assert.equal(finalLine(mismatch), `MERGE GATE: FAIL (HEAD is ${data.head} but --expect-head asked for ${"0".repeat(40)})`);
});

test("malformed OID arguments are usage errors before refusal, Git preconditions, and the command", (t) => {
  const data = fixture(t);
  const nonGitCwd = mkdtempSync(join(tmpdir(), "repo-contract-gate-non-git-"));
  t.after(() => rmSync(nonGitCwd, { recursive: true, force: true }));
  const replacement = `touch "$GATE_FIXTURE_WITNESS"`;
  for (const [flag, message] of [
    ["--expect-head", "--expect-head must be a full 40-character object id"],
    ["--master", "--master must be a full 40-character object id"],
  ]) {
    for (const [context, fixtureData, overrides] of [
      ["repository", data, {}],
      ["Anneal run", data, { AGENTOS_RUN_ID: "fixture-run" }],
      ["non-Git directory", { cwd: nonGitCwd }, {}],
    ]) {
      const witness = join(fixtureData.cwd, `command-ran-${flag.slice(2)}-${context.replaceAll(" ", "-")}`);
      const result = run(t, fixtureData, replacement, [flag, "not-an-object-id"], {
        ...overrides,
        GATE_FIXTURE_WITNESS: witness,
      });
      assert.equal(result.status, 2, `${context}: ${result.output}`);
      assertNoVerdict(result);
      assert.match(result.output, new RegExp(`merge-gate: ${message}`, "u"));
      assert.match(result.output, /usage: /u);
      assert.equal(existsSync(witness), false);
    }
  }
});

test("a missing or non-ancestor master is rejected before the command", (t) => {
  const data = fixture(t);
  const missing = run(t, data, "touch should-not-run", ["--master", "f".repeat(40)]);
  assert.equal(missing.status, 1, missing.output);
  assert.equal(finalLine(missing), `MERGE GATE: FAIL (--master ${"f".repeat(40)} is not a commit in this repository)`);

  git(data.cwd, "checkout", "-q", "main");
  write(data.cwd, "other.txt", "unrelated\n");
  const other = commit(data.cwd, "unrelated");
  git(data.cwd, "checkout", "-q", "feature");
  const nonAncestor = run(t, data, "touch should-not-run", ["--master", other]);
  assert.equal(nonAncestor.status, 1, nonAncestor.output);
  assert.equal(finalLine(nonAncestor), `MERGE GATE: FAIL (--master ${other} is not an ancestor of ${data.head})`);
});

test("dirty-before, HEAD drift, and dirty-after are all FAIL verdicts", (t) => {
  const dirtyBefore = fixture(t);
  write(dirtyBefore.cwd, "tracked.txt", "edited before\n");
  const before = run(t, dirtyBefore, "touch should-not-run", ["--master", dirtyBefore.master]);
  assert.equal(before.status, 1, before.output);
  assert.equal(finalLine(before), "MERGE GATE: FAIL (working tree is not clean before the repository test command)");

  const headDrift = fixture(t);
  const drift = run(t, headDrift, "git commit --allow-empty -q -m drift", ["--master", headDrift.master]);
  assert.equal(drift.status, 1, drift.output);
  assert.match(finalLine(drift), new RegExp(`^MERGE GATE: FAIL \\(HEAD changed from ${headDrift.head} to [0-9a-f]{40} during the repository test command\\)$`, "u"));

  const dirtyAfter = fixture(t);
  const after = run(t, dirtyAfter, "touch dirty-after", ["--master", dirtyAfter.master]);
  assert.equal(after.status, 1, after.output);
  assert.equal(finalLine(after), "MERGE GATE: FAIL (working tree is not clean after the repository test command)");
});

test("external SIGINT and SIGTERM reap delayed command output before the final wire line", async (t) => {
  for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const data = fixture(t);
    const result = await runWithExternalSignal(t, data, signal, status);
    assert.equal(result.status, status, result.output);
    assert.match(result.output, /DUMMY LATE OUTPUT/u);
    assert.equal(finalLine(result), `GATE NOT RUN: the gate was stopped by ${signal} during the repository test command`);
  }
});
