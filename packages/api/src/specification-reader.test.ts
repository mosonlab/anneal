import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createMirrorGitCommand,
  createMirrorBackedSpecificationReader,
  repoMirrorPath,
  type MirrorGitResult,
} from "./specification-reader.js";
import { specificationDigest, verifyPreparedSpecification } from "./specification-fidelity.js";

const path = ".chain/feat/spec/spec.md";
const repository = "acme/repo";
const remoteUrl = "git@github.com:acme/repo.git";
const bytes = new TextEncoder().encode("the local specification\n");
const objectId = (type: "blob" | "commit", content: Uint8Array): string => createHash("sha1")
  .update(new TextEncoder().encode(`${type} ${content.length}\0`))
  .update(content)
  .digest("hex");
const blobId = objectId("blob", bytes);
const commitBytes = new TextEncoder().encode(`tree ${"c".repeat(40)}\n\nfixture commit\n`);
const commit = objectId("commit", commitBytes);
const execFileAsync = promisify(execFile);

const result = (
  stdout: Uint8Array | string = "",
  code: number | null = 0,
  signal: NodeJS.Signals | null = null,
): MirrorGitResult => ({
  code,
  signal,
  stdout: typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout,
  stderr: code === 0 ? "" : "git failed",
});

const mirrorGit = (calls: string[][]): ((mirror: string, args: readonly string[], signal: AbortSignal, input?: Uint8Array) => Promise<MirrorGitResult>) => (
  async (_mirror, args, _signal, input) => {
    calls.push([...args, ...(input ? [`input:${new TextDecoder().decode(input)}`] : [])]);
    if (args[0] === "rev-parse") return result("true\n");
    if (args[0] === "cat-file" && args[1] === "--batch-check=%(objectname) %(objecttype)") {
      return result(`${commit} commit\n${blobId} blob\n`);
    }
    if (args[0] === "cat-file" && args[1] === "commit") return result(commitBytes);
    if (args[0] === "cat-file" && args[1] === "blob") return result(bytes);
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  }
);

test("serves the pinned file from the exact runner mirror key before GitHub", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-"));
  try {
    const mirror = repoMirrorPath(root, remoteUrl);
    await mkdir(mirror, { recursive: true });
    const calls: string[][] = [];
    let githubCalls = 0;
    const reader = createMirrorBackedSpecificationReader({
      readFileAtCommit: async () => {
        githubCalls += 1;
        return new TextEncoder().encode("from GitHub");
      },
    }, { mirrorRoot: root, runGit: mirrorGit(calls) });

    const actual = await reader.readFileAtCommit(repository, path, commit, new AbortController().signal, remoteUrl);

    assert.deepEqual(actual, bytes);
    assert.equal(githubCalls, 0);
    assert.equal(calls.some((call) => call[0] === "cat-file" && call[1] === "blob"), true);

    const verification = {
      key: "same-verification",
      repository,
      remoteUrl,
      path,
      implementationHeadSha: commit,
      authoritativeDigest: specificationDigest(bytes),
      currentBrief: { kind: "not-compared" as const },
    };
    const githubVerdict = await verifyPreparedSpecification(
      verification,
      { readFileAtCommit: async () => bytes },
      new AbortController().signal,
    );
    const mirrorVerdict = await verifyPreparedSpecification(
      verification,
      reader,
      new AbortController().signal,
    );
    assert.equal(mirrorVerdict, githubVerdict);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads exact bytes from a real bare mirror at the pinned commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-real-"));
  const seed = join(root, "seed");
  const mirrorRoot = join(root, "mirrors");
  const mirror = repoMirrorPath(mirrorRoot, remoteUrl);
  try {
    await mkdir(join(seed, ".chain/feat/spec"), { recursive: true });
    await writeFile(join(seed, path), bytes);
    await execFileAsync("git", ["init", "-b", "main"], { cwd: seed });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: seed });
    await execFileAsync("git", ["config", "user.name", "Specification Reader Test"], { cwd: seed });
    await execFileAsync("git", ["add", path], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "materialize specification"], { cwd: seed });
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: seed });
    await mkdir(mirrorRoot, { recursive: true });
    await execFileAsync("git", ["clone", "--mirror", seed, mirror]);
    await execFileAsync("git", ["--git-dir", mirror, "config", "remote.origin.url", remoteUrl]);

    const reader = createMirrorBackedSpecificationReader(
      { readFileAtCommit: async () => bytes },
      { mirrorRoot, runAsPrefix: [] },
    );
    const actual = await reader.readFileAtCommit(
      repository,
      path,
      head.trim(),
      new AbortController().signal,
      remoteUrl,
    );
    assert.deepEqual([...actual], [...bytes]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacement refs cannot change the pinned bytes accepted from a real mirror", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-replace-"));
  const seed = join(root, "seed");
  const mirrorRoot = join(root, "mirrors");
  const mirror = repoMirrorPath(mirrorRoot, remoteUrl);
  try {
    await mkdir(join(seed, ".chain/feat/spec"), { recursive: true });
    await writeFile(join(seed, path), bytes);
    await execFileAsync("git", ["init", "-b", "main"], { cwd: seed });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: seed });
    await execFileAsync("git", ["config", "user.name", "Specification Reader Test"], { cwd: seed });
    await execFileAsync("git", ["add", path], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "authoritative specification"], { cwd: seed });
    const { stdout: original } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: seed });

    await writeFile(join(seed, path), "replacement content\n");
    await execFileAsync("git", ["add", path], { cwd: seed });
    const { stdout: replacementTree } = await execFileAsync("git", ["write-tree"], { cwd: seed });
    const { stdout: replacement } = await execFileAsync(
      "git",
      ["commit-tree", replacementTree.trim(), "-m", "hostile replacement"],
      { cwd: seed },
    );

    await mkdir(mirrorRoot, { recursive: true });
    await execFileAsync("git", ["clone", "--mirror", seed, mirror]);
    await execFileAsync("git", ["--git-dir", mirror, "config", "remote.origin.url", remoteUrl]);
    await execFileAsync("git", ["--git-dir", mirror, "replace", original.trim(), replacement.trim()]);

    const reader = createMirrorBackedSpecificationReader(
      { readFileAtCommit: async () => bytes },
      { mirrorRoot, runAsPrefix: [] },
    );
    const verification = {
      key: "replacement-verification",
      repository,
      remoteUrl,
      path,
      implementationHeadSha: original.trim(),
      authoritativeDigest: specificationDigest(bytes),
      currentBrief: { kind: "not-compared" as const },
    };

    assert.equal(
      await verifyPreparedSpecification(verification, reader, new AbortController().signal),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an empty blob served by the mirror instead of falling back", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-empty-"));
  try {
    const mirror = repoMirrorPath(root, remoteUrl);
    await mkdir(mirror, { recursive: true });
    let githubCalls = 0;
    const empty = new Uint8Array();
    const reader = createMirrorBackedSpecificationReader({
      readFileAtCommit: async () => {
        githubCalls += 1;
        return new TextEncoder().encode("GitHub fallback");
      },
    }, { mirrorRoot: root, runGit: async (_mirror, args) => {
      if (args[0] === "rev-parse") return result("true\n");
      if (args[0] === "cat-file" && args[1] === "--batch-check=%(objectname) %(objecttype)") {
        return result(`${commit} commit\n${objectId("blob", empty)} blob\n`);
      }
      if (args[0] === "cat-file" && args[1] === "commit") return result(commitBytes);
      if (args[0] === "cat-file" && args[1] === "blob") return result(empty);
      throw new Error("unexpected git call");
    } });

    assert.deepEqual(
      await reader.readFileAtCommit(repository, path, commit, new AbortController().signal, remoteUrl),
      empty,
    );
    assert.equal(githubCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to GitHub when the exact mirror is absent or lacks the pinned object", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-miss-"));
  try {
    let githubCalls = 0;
    const github = {
      readFileAtCommit: async () => {
        githubCalls += 1;
        return new TextEncoder().encode("from GitHub");
      },
    };
    const absent = createMirrorBackedSpecificationReader(github, {
      mirrorRoot: root,
      runGit: async () => result("", 128),
    });
    assert.deepEqual(
      await absent.readFileAtCommit(repository, path, commit, new AbortController().signal, remoteUrl),
      new TextEncoder().encode("from GitHub"),
    );

    const mirror = repoMirrorPath(root, remoteUrl);
    await mkdir(mirror, { recursive: true });
    const missingObject = async (_mirror: string, args: readonly string[]): Promise<MirrorGitResult> => {
      if (args[0] === "rev-parse") return result("true\n");
      if (args[0] === "cat-file") return result(`${commit} missing\n${commit}:${path} missing\n`);
      throw new Error("unexpected git call");
    };
    const withMissingObject = createMirrorBackedSpecificationReader(github, { mirrorRoot: root, runGit: missingObject });
    assert.deepEqual(
      await withMissingObject.readFileAtCommit(repository, path, commit, new AbortController().signal, remoteUrl),
      new TextEncoder().encode("from GitHub"),
    );
    assert.equal(githubCalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to GitHub when mirror metadata or local git is unreadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-corrupt-"));
  try {
    const mirror = repoMirrorPath(root, remoteUrl);
    await writeFile(mirror, "not a directory");
    let githubCalls = 0;
    const reader = createMirrorBackedSpecificationReader({
      readFileAtCommit: async () => {
        githubCalls += 1;
        return new TextEncoder().encode("from GitHub");
      },
    }, {
      mirrorRoot: root,
      runGit: async () => { throw new Error("corrupt mirror"); },
    });

    assert.deepEqual(
      await reader.readFileAtCommit(repository, path, commit, new AbortController().signal, remoteUrl),
      new TextEncoder().encode("from GitHub"),
    );
    assert.equal(githubCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a signal-killed blob read falls back instead of accepting partial bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-signaled-"));
  try {
    let githubCalls = 0;
    const reader = createMirrorBackedSpecificationReader({
      readFileAtCommit: async () => {
        githubCalls += 1;
        return bytes;
      },
    }, { mirrorRoot: root, runGit: async (_mirror, args) => {
      if (args[0] === "rev-parse") return result("true\n");
      if (args[0] === "cat-file" && args[1] === "--batch-check=%(objectname) %(objecttype)") {
        return result(`${commit} commit\n${blobId} blob\n`);
      }
      if (args[0] === "cat-file" && args[1] === "commit") return result(commitBytes);
      if (args[0] === "cat-file" && args[1] === "blob") {
        return result(bytes.slice(0, 8), null, "SIGKILL");
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    } });

    assert.deepEqual(
      await reader.readFileAtCommit(repository, path, commit, new AbortController().signal, remoteUrl),
      bytes,
    );
    assert.equal(githubCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the run-as subprocess receives only the controlled git environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-env-"));
  const helper = join(root, "prefix.mjs");
  const previousSecret = process.env.API_ONLY_SENTINEL;
  try {
    await writeFile(helper, `
      const leaked = process.env.API_ONLY_SENTINEL ?? "absent";
      process.stdout.write(JSON.stringify({ leaked, home: process.env.HOME, argv: process.argv.slice(2) }));
    `);
    process.env.API_ONLY_SENTINEL = "must-not-cross-runner-boundary";
    const runGit = createMirrorGitCommand([process.execPath, helper], "/runner-controlled-home");
    const command = await runGit(root, ["rev-parse", "--is-bare-repository"], new AbortController().signal);
    const observed = JSON.parse(new TextDecoder().decode(command.stdout)) as {
      leaked: string;
      home: string;
      argv: string[];
    };
    assert.equal(observed.leaked, "absent");
    assert.equal(observed.home, "/runner-controlled-home");
    assert.deepEqual(observed.argv, ["git", "--no-replace-objects", "rev-parse", "--is-bare-repository"]);
  } finally {
    if (previousSecret === undefined) delete process.env.API_ONLY_SENTINEL;
    else process.env.API_ONLY_SENTINEL = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting mirror git kills a run-as process group and settles promptly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-abort-"));
  const helper = join(root, "ignore-term.mjs");
  const ready = join(root, "ready");
  try {
    await writeFile(helper, `
      const { writeFileSync } = await import("node:fs");
      process.on("SIGTERM", () => {});
      writeFileSync(process.argv.at(-1), "ready");
      setInterval(() => {}, 10_000);
    `);
    const controller = new AbortController();
    const runGit = createMirrorGitCommand([process.execPath, helper], root);
    const running = runGit(root, ["status", ready], controller.signal);
    for (;;) {
      try {
        await access(ready);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const started = Date.now();
    controller.abort();
    await assert.rejects(running, (error: unknown) => error instanceof Error && error.name === "AbortError");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 900, `SIGKILL escalation settled too early after ${elapsed}ms`);
    // The floor above is the property: the escalation waited its grace instead
    // of firing early. This ceiling only catches an escalation that never
    // lands, so it is sized for the loaded gate worker rather than an idle host
    // (CONTRIBUTING.md, "Test timing on the gate worker"): signalling, SIGKILL
    // and reaping a real node child all queue behind that host's load.
    assert.ok(elapsed < 30_000, `SIGKILL escalation took ${elapsed}ms`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production defaults target the explicitly wired runner mirror root", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-api-spec-reader-default-root-"));
  const mirrorRoot = join(root, "runner-home", ".agentos", "repo-mirrors");
  const previousRoot = process.env.RUNNER_REPO_MIRROR_ROOT;
  try {
    process.env.RUNNER_REPO_MIRROR_ROOT = mirrorRoot;
    let probedMirror = "";
    const reader = createMirrorBackedSpecificationReader(
      { readFileAtCommit: async () => bytes },
      { runGit: async (mirror) => {
        probedMirror = mirror;
        return result("", 128);
      } },
    );
    assert.deepEqual(
      await reader.readFileAtCommit(repository, path, commit, new AbortController().signal, remoteUrl),
      bytes,
    );
    assert.equal(probedMirror, repoMirrorPath(mirrorRoot, remoteUrl));
  } finally {
    if (previousRoot === undefined) delete process.env.RUNNER_REPO_MIRROR_ROOT;
    else process.env.RUNNER_REPO_MIRROR_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
