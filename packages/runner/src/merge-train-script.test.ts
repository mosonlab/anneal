import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseMergeTrainRecord } from "@anneal/db";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../runtime-tools/merge-train.sh");
const CHAIN_ID = "11111111-1111-4111-8111-111111111111";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "merge-train-fixture",
    GIT_AUTHOR_EMAIL: "merge-train@example.invalid",
    GIT_COMMITTER_NAME: "merge-train-fixture",
    GIT_COMMITTER_EMAIL: "merge-train@example.invalid",
  },
}).trim();

const executable = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

type Candidate = {
  taskId: string;
  chainId: string;
  headSha: string;
  branch: string;
};

type Fixture = {
  root: string;
  origin: string;
  workspace: string;
  baseSha: string;
  gateLog: string;
  gateScript: string;
  env: NodeJS.ProcessEnv;
  handoff: () => Record<string, unknown> | null;
  candidate: (taskId: string, branch: string, files: Record<string, string>, start?: string) => Candidate;
  ref: (oid: string) => string;
  cleanup: () => Promise<void>;
};

const makeFixture = async (): Promise<Fixture> => {
  const root = mkdtempSync(join(tmpdir(), "agentos-merge-train-runtime-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const workspace = join(root, "workspace");
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "init", "--initial-branch=main", seed);
  git(seed, "config", "user.name", "merge-train-fixture");
  git(seed, "config", "user.email", "merge-train@example.invalid");
  writeFileSync(join(seed, "base.txt"), "base\n");
  writeFileSync(join(seed, "shared.txt"), "base\n");
  mkdirSync(join(seed, ".chain"), { recursive: true });
  writeFileSync(join(seed, ".chain", "fixture.txt"), "private\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "main");
  const baseSha = git(seed, "rev-parse", "HEAD");
  git(root, "clone", "--branch", "main", origin, workspace);
  git(workspace, "config", "user.name", "merge-train-fixture");
  git(workspace, "config", "user.email", "merge-train@example.invalid");

  const gateLog = join(root, "gate.log");
  const gateScript = join(root, "bin", "gate-dispatch.sh");
  writeFileSync(gateLog, "");
  executable(gateScript, `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const [oid, flag, master] = process.argv.slice(2);
if (flag !== "--master") process.exit(97);
fs.appendFileSync(process.env.MERGE_TRAIN_FIXTURE_GATE_LOG, oid + " " + master + "\\n");
let index = 1;
try {
  index = Number(cp.execFileSync("git", ["rev-list", "--first-parent", "--count", process.env.MERGE_TRAIN_FIXTURE_BASE + ".." + oid], { encoding: "utf8" }).trim());
} catch {}
const behavior = process.env.MERGE_TRAIN_FIXTURE_GATE_BEHAVIOR || "pass";
if (behavior === "require-ref") {
  const ref = "refs/anneal/train/" + oid;
  const found = cp.execFileSync("git", ["ls-remote", "origin", "refs/anneal/train/*"], { encoding: "utf8" }).trim().split("\\n");
  if (found.length !== 3 || !found.includes(oid + "\\t" + ref)) process.exit(76);
}
if (behavior === "delayed-pass") {
  fs.appendFileSync(process.env.MERGE_TRAIN_FIXTURE_GATE_LOG, "start " + oid + "\\n");
  const deadline = Date.now() + 10000;
  const interval = setInterval(() => {
    const starts = fs.readFileSync(process.env.MERGE_TRAIN_FIXTURE_GATE_LOG, "utf8").split("\\n").filter(line => line.startsWith("start "));
    if (starts.length < 3) {
      if (Date.now() >= deadline) process.exit(97);
      return;
    }
    clearInterval(interval);
    fs.appendFileSync(process.env.MERGE_TRAIN_FIXTURE_GATE_LOG, "end " + oid + "\\n");
    console.log("MERGE GATE: PASS " + oid);
    process.exit(0);
  }, 10);
} else if (behavior === "busy-pass") {
  console.log("MERGE GATE: PASS " + oid);
  process.exit(75);
} else if (behavior === "split-pass") {
  process.stdout.write("MERGE GATE: PA");
  process.stderr.write("SS " + oid);
} else if (behavior === "no-verdict") {
  console.log("GATE NOT RUN: fixture no verdict " + index);
  process.exit(76);
} else if (behavior === "fail-index-2" && index === 2) {
  console.log("MERGE GATE: FAIL (fixture failure)");
  process.exit(1);
} else if (behavior === "noisy-fail" || behavior === "noisy-pass") {
  // The real gate is a shell script whose writes block until the reader drains.
  // This fixture writes far more than a pipe holds, so it must end by falling
  // off the bottom rather than through process.exit(): Node's stdout to a pipe
  // is asynchronous, and exiting discards the still-queued tail, which is
  // exactly the verdict line the tool classifies.
  console.log("run-gate: failure excerpt (last 200 lines per failing step)");
  for (let line = 0; line < 200; line += 1) console.log("noise ".repeat(12) + line);
  if (behavior === "noisy-pass") {
    console.log("MERGE GATE: PASS " + oid);
  } else {
    console.log("MERGE GATE: FAIL (fixture failure)");
    process.exitCode = 1;
  }
} else if (behavior === "block-cleanup") {
  fs.chmodSync(require("node:path").dirname(process.cwd()), 0o500);
  console.log("MERGE GATE: PASS " + oid);
  process.exit(0);
} else if (behavior === "wrong-pass") {
  console.log("MERGE GATE: PASS " + "0".repeat(40));
  process.exit(0);
} else if (behavior === "suffix-pass") {
  console.log("MERGE GATE: PASS " + oid + " suffix");
  process.exit(0);
} else {
  console.log("MERGE GATE: PASS " + oid);
}
`);

  const handoffPath = join(workspace, ".agentos", "merge-train-output.json");

  const candidate = (taskId: string, branch: string, files: Record<string, string>, start = baseSha): Candidate => {
    const checkout = join(root, `candidate-${branch.replaceAll("/", "-")}`);
    git(workspace, "worktree", "add", "-b", branch, checkout, start);
    for (const [name, contents] of Object.entries(files)) {
      const path = join(checkout, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    git(checkout, "add", ".");
    if (Object.keys(files).length > 0) git(checkout, "commit", "-m", `candidate ${taskId}`);
    const headSha = git(checkout, "rev-parse", "HEAD");
    git(checkout, "push", "origin", `${headSha}:refs/heads/${branch}`);
    git(workspace, "worktree", "remove", "--force", checkout);
    return { taskId, chainId: CHAIN_ID, headSha, branch };
  };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The mechanical handoff needs no session or fencing credentials, and the
    // gate is the one supported override rather than anything found on PATH.
    AGENTOS_API_URL: undefined,
    AGENTOS_SESSION_TOKEN: undefined,
    AGENTOS_FENCING_TOKEN: undefined,
    MERGE_TRAIN_GATE_DISPATCH: gateScript,
    AGENTOS_RUN_ID: "run-merge-train-fixture",
    AGENTOS_WORKSPACE_PATH: workspace,
    RUNNER_WORKSPACE_ROOT: join(root, "runner-workspaces"),
    MERGE_TRAIN_FIXTURE_GATE_LOG: gateLog,
    MERGE_TRAIN_FIXTURE_BASE: baseSha,
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  mkdirSync(env.RUNNER_WORKSPACE_ROOT!, { recursive: true });

  return {
    root,
    origin,
    workspace,
    baseSha,
    gateLog,
    gateScript,
    env,
    handoff: () => {
      try {
        statSync(handoffPath);
      } catch {
        return null;
      }
      return JSON.parse(readFileSync(handoffPath, "utf8")) as Record<string, unknown>;
    },
    candidate,
    ref: (oid) => `refs/anneal/train/${oid}`,
    cleanup: async () => {
      // A cleanup-failure fixture leaves a read-only scratch directory behind.
      try {
        execFileSync("chmod", ["-R", "u+rwX", root]);
      } catch {
        // Nothing to restore.
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
};

type ToolResult = { status: number | null; stdout: string; stderr: string };

const runTool = (fixture: Fixture, input: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): Promise<ToolResult> => new Promise((resolveRun) => {
  const child = spawn("bash", [script], {
    cwd: fixture.workspace,
    env: { ...fixture.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.on("close", (status) => resolveRun({
    status,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  }));
  child.stdin.end(`${JSON.stringify(input)}\n`);
});

const trainInput = (fixture: Fixture, candidates: Candidate[], width = candidates.length): Record<string, unknown> => ({
  schemaVersion: 1,
  baseSha: fixture.baseSha,
  width,
  candidates,
});

const recordOf = (result: ToolResult): Record<string, any> => {
  assert.equal(result.stderr, "", `unexpected stderr: ${result.stderr}`);
  assert.match(result.stdout, /^\{"schemaVersion":1,/u);
  return JSON.parse(result.stdout) as Record<string, any>;
};

test("runtime merge train builds and gates three cumulative prefixes", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      fixture.candidate("task-1", "chain-1", { "a.txt": "a\n", ".chain/private.txt": "candidate-private\n" }),
      fixture.candidate("task-2", "chain-2", { "b.txt": "b\n" }),
      fixture.candidate("task-3", "chain-3", { "c.txt": "c\n" }),
    ];
    const result = await runTool(fixture, trainInput(fixture, candidates));
    assert.equal(result.status, 0, result.stderr);
    const record = recordOf(result);
    assert.equal(parseMergeTrainRecord(JSON.stringify(record)).status, "ok");
    assert.equal(record.width, 3);
    assert.equal(record.prefixes.length, 3);
    assert.equal(record.contiguousPassCount, 3);
    assert.deepEqual(record.prefixes.map((prefix: any) => prefix.verdict), ["pass", "pass", "pass"]);
    assert.deepEqual(record.blocked, []);
    assert.deepEqual(record.skipped, []);
    const handoff = fixture.handoff();
    assert.ok(handoff, "the tool writes a mechanical output handoff");
    assert.equal(handoff.schemaVersion, 1);
    assert.equal(handoff.runId, "run-merge-train-fixture");
    assert.equal(handoff.kind, "merge-train-v1");
    assert.deepEqual(JSON.parse(handoff.body as string), record);
    assert.equal(handoff.commitSha, git(fixture.workspace, "rev-parse", "HEAD"));
    assert.equal(statSync(join(fixture.workspace, ".agentos", "merge-train-output.json")).mode & 0o777, 0o600);
    for (const prefix of record.prefixes) {
      assert.equal(git(fixture.workspace, "ls-remote", "origin", prefix.ref).split("\t")[0], prefix.prefixOid);
      const parents = git(fixture.workspace, "show", "-s", "--format=%P", prefix.prefixOid).split(" ");
      assert.deepEqual(parents, [prefix.predecessorOid, prefix.candidateHeadSha]);
      assert.equal(git(fixture.workspace, "ls-tree", "-r", "--name-only", prefix.prefixOid, "--", ".chain"), "");
    }
    const gates = readFileSync(fixture.gateLog, "utf8").trim().split("\n");
    assert.equal(gates.length, 3);
    assert.ok(gates.includes(`${record.prefixes[0].prefixOid} ${fixture.baseSha}`));
    assert.ok(gates.includes(`${record.prefixes[1].prefixOid} ${record.prefixes[0].prefixOid}`));
    assert.ok(gates.includes(`${record.prefixes[2].prefixOid} ${record.prefixes[1].prefixOid}`));
  } finally {
    await fixture.cleanup();
  }
});

test("a FAIL at prefix two leaves the contiguous pass count at one", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" }),
      fixture.candidate("task-2", "chain-2", { "b.txt": "b\n" }),
      fixture.candidate("task-3", "chain-3", { "c.txt": "c\n" }),
    ];
    const result = await runTool(fixture, trainInput(fixture, candidates), { MERGE_TRAIN_FIXTURE_GATE_BEHAVIOR: "fail-index-2" });
    assert.equal(result.status, 0, result.stderr);
    const record = recordOf(result);
    assert.deepEqual(record.prefixes.map((prefix: any) => prefix.verdict), ["pass", "fail", "pass"]);
    assert.equal(record.contiguousPassCount, 1);
    assert.match(record.prefixes[1].gateExcerpt, /MERGE GATE: FAIL \(fixture failure\)/u);
  } finally {
    await fixture.cleanup();
  }
});

test("a conflict blocks the candidate and skips all later candidates", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      fixture.candidate("task-1", "chain-1", { "shared.txt": "first\n" }),
      fixture.candidate("task-2", "chain-2", { "shared.txt": "second\n" }),
      fixture.candidate("task-3", "chain-3", { "later.txt": "later\n" }),
    ];
    const result = await runTool(fixture, trainInput(fixture, candidates));
    assert.equal(result.status, 0, result.stderr);
    const record = recordOf(result);
    assert.equal(record.prefixes.length, 1);
    assert.deepEqual(record.prefixes.map((prefix: any) => prefix.taskId), ["task-1"]);
    assert.deepEqual(record.blocked, [{
      taskId: "task-2",
      chainId: CHAIN_ID,
      candidateHeadSha: candidates[1]!.headSha,
      reason: "merge conflict",
    }]);
    assert.deepEqual(record.skipped, ["task-3"]);
    assert.equal(readFileSync(fixture.gateLog, "utf8").trim().split("\n").length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("an already-contained candidate is blocked and later candidates are skipped", async () => {
  const fixture = await makeFixture();
  try {
    const first = fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" });
    const contained = fixture.candidate("task-contained", "chain-contained", {}, fixture.baseSha);
    const later = fixture.candidate("task-3", "chain-3", { "c.txt": "c\n" });
    const result = await runTool(fixture, trainInput(fixture, [first, contained, later]));
    assert.equal(result.status, 0, result.stderr);
    const record = recordOf(result);
    assert.equal(record.prefixes.length, 1);
    assert.deepEqual(record.blocked, [{
      taskId: contained.taskId,
      chainId: CHAIN_ID,
      candidateHeadSha: contained.headSha,
      reason: "candidate is already contained by an earlier train prefix; rerun after that prefix publishes",
    }]);
    assert.deepEqual(record.skipped, [later.taskId]);
  } finally {
    await fixture.cleanup();
  }
});

test("a stale base is refused with exit two before any train ref is written", async () => {
  const fixture = await makeFixture();
  try {
    const candidate = fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" });
    const drift = join(fixture.root, "drift");
    git(fixture.root, "clone", "--branch", "main", fixture.origin, drift);
    writeFileSync(join(drift, "drift.txt"), "drift\n");
    git(drift, "add", "drift.txt");
    git(drift, "commit", "-m", "drift main");
    git(drift, "push", "origin", "main");
    const result = await runTool(fixture, trainInput(fixture, [candidate]));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /base-stale/u);
    assert.equal(git(fixture.origin, "for-each-ref", "refs/anneal/train/"), "");
    assert.equal(fixture.handoff(), null);
  } finally {
    await fixture.cleanup();
  }
});

test("a prefix with no verdict is retried three times and recorded as no-verdict", async () => {
  const fixture = await makeFixture();
  try {
    const candidate = fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" });
    const result = await runTool(fixture, trainInput(fixture, [candidate]), { MERGE_TRAIN_FIXTURE_GATE_BEHAVIOR: "no-verdict" });
    assert.equal(result.status, 0, result.stderr);
    const record = recordOf(result);
    assert.equal(record.prefixes[0].verdict, "no-verdict");
    assert.equal(record.contiguousPassCount, 0);
    assert.equal(readFileSync(fixture.gateLog, "utf8").trim().split("\n").length, 3);
  } finally {
    await fixture.cleanup();
  }
});

test("train refs are append-only when an existing ref has a different target", async () => {
  const fixture = await makeFixture();
  try {
    const candidate = fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" });
    const first = await runTool(fixture, trainInput(fixture, [candidate]));
    assert.equal(first.status, 0, first.stderr);
    const firstRecord = recordOf(first);
    const prefixOid = firstRecord.prefixes[0].prefixOid as string;
    const other = git(fixture.workspace, "rev-parse", fixture.baseSha);
    git(fixture.origin, "update-ref", fixture.ref(prefixOid), other);
    const second = await runTool(fixture, trainInput(fixture, [candidate]));
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /train-ref-append-only-conflict/u);
    assert.equal(git(fixture.workspace, "ls-remote", "origin", fixture.ref(prefixOid)).split("\t")[0], other);
  } finally {
    await fixture.cleanup();
  }
});

test("malformed candidate count is refused before any network output", async () => {
  const fixture = await makeFixture();
  try {
    const first = fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" });
    const second = fixture.candidate("task-2", "chain-2", { "b.txt": "b\n" });
    const result = await runTool(fixture, trainInput(fixture, [first, second], 1));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /candidate-count-exceeds-width/u);
    assert.equal(fixture.handoff(), null);
    assert.equal(git(fixture.origin, "for-each-ref", "refs/anneal/train/"), "");
  } finally {
    await fixture.cleanup();
  }
});

test("a candidate whose origin branch moved is refused with exit two", async () => {
  const fixture = await makeFixture();
  try {
    const candidate = fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" });
    const moved = join(fixture.root, "moved");
    git(fixture.root, "clone", "--branch", "chain-1", fixture.origin, moved);
    git(moved, "config", "user.name", "merge-train-fixture");
    git(moved, "config", "user.email", "merge-train@example.invalid");
    writeFileSync(join(moved, "moved.txt"), "moved\n");
    git(moved, "add", "moved.txt");
    git(moved, "commit", "-m", "move candidate");
    git(moved, "push", "origin", "HEAD:refs/heads/chain-1");
    const result = await runTool(fixture, trainInput(fixture, [candidate]));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /candidate-tip-mismatch/u);
    assert.equal(fixture.handoff(), null);
    assert.equal(git(fixture.origin, "for-each-ref", "refs/anneal/train/"), "");
  } finally {
    await fixture.cleanup();
  }
});

test("a PASS with the wrong OID or a suffix is never accepted", async () => {
  for (const behavior of ["wrong-pass", "suffix-pass", "split-pass", "busy-pass"]) {
    const fixture = await makeFixture();
    try {
      const candidate = fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" });
      const result = await runTool(fixture, trainInput(fixture, [candidate]), {
        MERGE_TRAIN_FIXTURE_GATE_BEHAVIOR: behavior,
      });
      assert.equal(result.status, 0, result.stderr);
      const record = recordOf(result);
      assert.equal(record.prefixes[0].verdict, "no-verdict");
      assert.equal(record.contiguousPassCount, 0);
      assert.equal(readFileSync(fixture.gateLog, "utf8").trim().split("\n").length, behavior === "busy-pass" ? 3 : 1);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("all prefix refs exist before concurrent gate dispatch begins", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" }),
      fixture.candidate("task-2", "chain-2", { "b.txt": "b\n" }),
      fixture.candidate("task-3", "chain-3", { "c.txt": "c\n" }),
    ];
    const result = await runTool(fixture, trainInput(fixture, candidates), {
      MERGE_TRAIN_FIXTURE_GATE_BEHAVIOR: "require-ref",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(recordOf(result).prefixes.map((prefix: any) => prefix.verdict), ["pass", "pass", "pass"]);
  } finally {
    await fixture.cleanup();
  }
});

test("built prefixes dispatch concurrently within the configured width", async () => {
  const fixture = await makeFixture();
  try {
    const candidates = [
      fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" }),
      fixture.candidate("task-2", "chain-2", { "b.txt": "b\n" }),
      fixture.candidate("task-3", "chain-3", { "c.txt": "c\n" }),
    ];
    const result = await runTool(fixture, trainInput(fixture, candidates), {
      MERGE_TRAIN_FIXTURE_GATE_BEHAVIOR: "delayed-pass",
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(fixture.gateLog, "utf8").trim().split("\n");
    const starts = lines.map((line, index) => line.startsWith("start ") ? index : -1).filter((index) => index >= 0);
    const firstEnd = lines.findIndex((line) => line.startsWith("end "));
    assert.equal(starts.length, 3);
    assert.ok(firstEnd > Math.max(...starts), "all gates should start before the first delayed gate ends");
  } finally {
    await fixture.cleanup();
  }
});

test("output persistence failure is a named failure and prints no successful record", async () => {
  const fixture = await makeFixture();
  try {
    const candidate = fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" });
    // An unwritable handoff target is the failure this tool can still name.
    mkdirSync(join(fixture.workspace, ".agentos", "merge-train-output.json"), { recursive: true });
    const result = await runTool(fixture, trainInput(fixture, [candidate]));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /output-persist-failed/u);
    assert.equal(result.stdout, "");
    assert.equal(git(fixture.workspace, "worktree", "list", "--porcelain").match(/^worktree /gmu)?.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a gate excerpt larger than the budget still carries its verdict line", async () => {
  for (const behavior of ["noisy-fail", "noisy-pass"]) {
    const fixture = await makeFixture();
    try {
      const candidate = fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" });
      const result = await runTool(fixture, trainInput(fixture, [candidate]), {
        MERGE_TRAIN_FIXTURE_GATE_BEHAVIOR: behavior,
      });
      assert.equal(result.status, 0, result.stderr);
      const record = recordOf(result);
      assert.equal(parseMergeTrainRecord(JSON.stringify(record)).status, "ok");
      const prefix = record.prefixes[0];
      assert.ok(Buffer.byteLength(prefix.gateExcerpt as string, "utf8") <= 4000);
      if (behavior === "noisy-fail") {
        assert.equal(prefix.verdict, "fail");
        assert.match(prefix.gateExcerpt, /MERGE GATE: FAIL \(fixture failure\)/u);
      } else {
        assert.equal(prefix.verdict, "pass");
        assert.ok((prefix.gateExcerpt as string).split("\n").includes(`MERGE GATE: PASS ${prefix.prefixOid}`));
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

test("a workspace cleanup failure is reported without discarding the persisted record", async () => {
  const fixture = await makeFixture();
  try {
    const candidate = fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" });
    const result = await runTool(fixture, trainInput(fixture, [candidate]), {
      MERGE_TRAIN_FIXTURE_GATE_BEHAVIOR: "block-cleanup",
    });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /workspace-cleanup-failed/u);
    const record = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(record.contiguousPassCount, 1);
    assert.deepEqual(JSON.parse(fixture.handoff()!.body as string), record);
  } finally {
    await fixture.cleanup();
  }
});

test("malformed Git branch names are refused with exit two before writes", async () => {
  const fixture = await makeFixture();
  try {
    const candidate = fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" });
    const result = await runTool(fixture, trainInput(fixture, [{ ...candidate, branch: "invalid.lock" }]));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /malformed-input/u);
    assert.equal(git(fixture.origin, "for-each-ref", "refs/anneal/train/"), "");
    assert.equal(fixture.handoff(), null);
  } finally {
    await fixture.cleanup();
  }
});

test("a rewound origin candidate tip is refused even with a newer cached tracking ref", async () => {
  const fixture = await makeFixture();
  try {
    const candidate = fixture.candidate("task-1", "chain-1", { "a.txt": "a\n" });
    git(fixture.origin, "update-ref", "refs/heads/chain-1", fixture.baseSha);
    const result = await runTool(fixture, trainInput(fixture, [candidate]));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /candidate-tip-mismatch/u);
    assert.equal(git(fixture.origin, "for-each-ref", "refs/anneal/train/"), "");
  } finally {
    await fixture.cleanup();
  }
});
