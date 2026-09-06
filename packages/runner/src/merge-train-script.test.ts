import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type AddressInfo } from "node:net";
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
  outputRequests: Array<{ path: string; body: Record<string, unknown> }>;
  server: Server;
  candidate: (taskId: string, branch: string, files: Record<string, string>, start?: string) => Candidate;
  ref: (oid: string) => string;
  cleanup: () => Promise<void>;
};

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  return (server.address() as AddressInfo).port;
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
  const found = cp.execFileSync("git", ["ls-remote", "origin", ref], { encoding: "utf8" }).trim();
  if (!found.startsWith(oid + "\\t" + ref)) process.exit(76);
}
if (behavior === "delayed-pass") {
  fs.appendFileSync(process.env.MERGE_TRAIN_FIXTURE_GATE_LOG, "start " + oid + "\\n");
  setTimeout(() => {
    fs.appendFileSync(process.env.MERGE_TRAIN_FIXTURE_GATE_LOG, "end " + oid + "\\n");
    console.log("MERGE GATE: PASS " + oid);
    process.exit(0);
  }, 120);
} else if (behavior === "no-verdict") {
  console.log("GATE NOT RUN: fixture no verdict " + index);
  process.exit(76);
} else if (behavior === "fail-index-2" && index === 2) {
  console.log("MERGE GATE: FAIL (fixture failure)");
  process.exit(1);
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

  const outputRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      outputRequests.push({ path: request.url ?? "", body: JSON.parse(body) as Record<string, unknown> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}\n");
    });
  });
  const port = await listen(server);

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
    PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
    AGENTOS_API_URL: `http://127.0.0.1:${port}`,
    AGENTOS_RUN_ID: "run-merge-train-fixture",
    AGENTOS_SESSION_TOKEN: "session-merge-train-fixture",
    AGENTOS_FENCING_TOKEN: "fence-merge-train-fixture",
    AGENTOS_WORKSPACE_PATH: workspace,
    AGENTOS_PULL_REQUEST_BASE: "main",
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
    outputRequests,
    server,
    candidate,
    ref: (oid) => `refs/anneal/train/${oid}`,
    cleanup: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
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
    assert.equal(fixture.outputRequests.length, 1);
    assert.equal(fixture.outputRequests[0]!.path, "/session/runs/run-merge-train-fixture/output");
    assert.equal(fixture.outputRequests[0]!.body.kind, "merge-train-v1");
    assert.equal(fixture.outputRequests[0]!.body.commitSha, git(fixture.workspace, "rev-parse", "HEAD"));
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
    assert.equal(git(fixture.workspace, "ls-remote", "origin", "refs/anneal/train"), "");
    assert.equal(fixture.outputRequests.length, 0);
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
    assert.equal(fixture.outputRequests.length, 0);
    assert.equal(git(fixture.workspace, "ls-remote", "origin", "refs/anneal/train"), "");
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
    assert.equal(fixture.outputRequests.length, 0);
    assert.equal(git(fixture.workspace, "ls-remote", "origin", "refs/anneal/train"), "");
  } finally {
    await fixture.cleanup();
  }
});

test("a PASS with the wrong OID or a suffix is never accepted", async () => {
  for (const behavior of ["wrong-pass", "suffix-pass"]) {
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
