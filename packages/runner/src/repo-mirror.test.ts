import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { RunnerConfig } from "./config.js";
import type { DependencyProvisioningDecision } from "./dependency-provisioning.js";
import { bindCommandRunner, CommandTimeoutError, isCommandTimeout, KILL_OVERHEAD_MS, type CommandRunner } from "./exec.js";
import { CLONE_COMMAND_TIMEOUT_MS, CLONE_CREATION_TIMEOUT_MS, CLONE_OPERATION_BUDGET_MS } from "./network-retry.js";
import {
  mirrorRevisionsPresent, repoMirrorPath, RepoMirrorError, withRepoMirror,
  type RepoMirrorProgress,
} from "./repo-mirror.js";
import { provisionWorkspace, workspaceEnvironment, type WorkspaceProvisionClaim } from "./workspace.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

type Fixture = { root: string; remote: string; seed: string; config: RunnerConfig; mirrorRoot: string; mirror: string };

const fixture = async (label: string): Promise<Fixture> => {
  // realpath: macOS resolves the temp root through /var -> /private/var, and the
  // mirror root is resolved before anything is created under it.
  const root = await realpath(await mkdtemp(join(tmpdir(), `agentos-repo-mirror-${label}-`)));
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--initial-branch=main", seed);
  git(seed, "config", "user.name", "Anneal Test");
  git(seed, "config", "user.email", "runner@example.invalid");
  await writeFile(join(seed, "tree.txt"), "base\n");
  git(seed, "add", "tree.txt");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  const mirrorRoot = join(root, "mirrors");
  const config = {
    workspaceRoot: join(root, "workspaces"),
    repoMirrorRoot: mirrorRoot,
    // The mirror lives in the task account's home; here the fixture is it.
    home: root,
    runnerId: "runner-under-test",
    runAsPrefix: [],
    path: process.env.PATH ?? "/usr/bin:/bin",
    gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
  } as unknown as RunnerConfig;
  return { root, remote, seed, config, mirrorRoot, mirror: repoMirrorPath(mirrorRoot, remote) };
};

/** Mirror behaviour is what these tests provision for; no Run installs here. */
const NO_DEPENDENCIES = {
  provision: false,
  evidence: "Dependency provisioning skipped: Repo.dependencyProvisioning=NONE",
} as const satisfies DependencyProvisioningDecision;

const claimFor = (remote: string, id: string): WorkspaceProvisionClaim => ({
  executionMode: "agent",
  runner: "CODEX",
  specificationMaterialization: null,
  task: { id: `task-${id}`, chainId: null, chainIndex: null, templateStep: null },
  repo: { remoteUrl: remote, defaultBranch: "main" },
  run: {
    id: `run-${id}`,
    runNumber: 1,
    targetBranch: "main",
    targetBranchPublished: false,
    pinnedBaseSha: null,
    implementationBaseSha: null,
    implementationHeadSha: null,
    branch: "main",
  },
});

/** The production runner, bound the way provisioning binds it. */
const bound = (config: RunnerConfig, cwd: string): CommandRunner =>
  bindCommandRunner(config.runAsPrefix, cwd, workspaceEnvironment(config));

/** The production runner, with every argv it is handed recorded. */
const recorded = (
  calls: { args: string[]; cwd: string }[],
  config: RunnerConfig,
  cwd: string,
): CommandRunner => {
  const run = bound(config, cwd);
  return async (executable, args, options) => {
    calls.push({ args: [...args], cwd: options?.cwd ?? cwd });
    return run(executable, args, options);
  };
};


const silent = (): ((progress: RepoMirrorProgress) => void) => (): void => undefined;

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const escapedRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

test("the second run reuses the machine's mirror and fetches only what changed", async () => {
  const { root, remote, seed, config, mirror } = await fixture("reuse");
  try {
    await provisionWorkspace(config, claimFor(remote, "one"), NO_DEPENDENCIES, { mirrorOptions: { report: silent() } });
    const created = (await stat(mirror)).birthtimeMs;

    await writeFile(join(seed, "tree.txt"), "second\n");
    git(seed, "commit", "-am", "second");
    git(seed, "push", "origin", "main");
    const head = git(seed, "rev-parse", "HEAD");

    const calls: { args: string[]; cwd: string }[] = [];
    const workspace = await provisionWorkspace(
      config,
      claimFor(remote, "two"),
      NO_DEPENDENCIES,
      { run: recorded(calls, config, resolve(config.workspaceRoot)), mirrorOptions: { report: silent() } },
    );

    // Same mirror directory, not a rebuilt one, and the run sees the commit
    // pushed after it was created — so the refresh really did reach the remote.
    assert.equal((await stat(mirror)).birthtimeMs, created);
    assert.equal(workspace.baseSha, head);
    assert.equal(await readFile(join(workspace.path, "tree.txt"), "utf8"), "second\n");

    // Nothing in the run touched the remote except the mirror's own fetch.
    const remoteReaders = calls.filter(({ args }) => args.includes(remote));
    assert.deepEqual(remoteReaders.map(({ args }) => args[0]), ["remote"]);
    const clone = calls.find(({ args }) => args[0] === "clone");
    assert.equal(clone?.args.at(-2), mirror);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a slow cold mirror clone gets its own ceiling and reports creating before created", async () => {
  const { root, remote, config, mirror } = await fixture("cold-slow");
  const progress: RepoMirrorProgress[] = [];
  let clock = 0;
  let fetchCalls = 0;
  let fetchTimeout: number | undefined;
  const production = bound(config, root);
  const run: CommandRunner = async (executable, args, options) => {
    if (executable === "git" && args[0] === "fetch") {
      fetchCalls += 1;
      fetchTimeout = options?.timeoutMs;
      // This is deliberately just beyond the warm-mirror budget. The fake
      // command returns successfully, so no wall-clock sleep or retry is
      // needed to exercise the cold-clone profile.
      clock += CLONE_OPERATION_BUDGET_MS + 1;
      return "";
    }
    return production(executable, args, options);
  };

  try {
    const result = await withRepoMirror(
      config,
      remote,
      run,
      {
        fetchRetryOptions: { now: () => clock, wait: async () => undefined },
        report: (event) => progress.push(event),
      },
      async (path) => path,
    );

    assert.equal(result, mirror);
    assert.equal(fetchCalls, 1, "a clone cannot retry from zero bytes");
    assert.ok(fetchTimeout !== undefined);
    assert.ok(fetchTimeout > CLONE_OPERATION_BUDGET_MS, "creation must outlive the refresh budget");
    assert.ok(fetchTimeout <= CLONE_CREATION_TIMEOUT_MS);
    assert.ok(CLONE_CREATION_TIMEOUT_MS >= 30 * 60 * 1_000, "the creation ceiling must be at least thirty minutes");
    assert.deepEqual(
      progress
        .filter(({ event }) => String(event) === "creating" || event === "created")
        .map(({ event, mirror: path }) => [event, path]),
      [["creating", mirror], ["created", mirror]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a warm mirror keeps the refresh budget, timeout message, and retry profile", async () => {
  const { root, remote, config } = await fixture("warm-timeout");
  try {
    await withRepoMirror(config, remote, bound(config, root), { report: silent() }, async (path) => path);

    const progress: RepoMirrorProgress[] = [];
    const timeouts: number[] = [];
    let clock = 0;
    const production = bound(config, root);
    const run: CommandRunner = async (executable, args, options) => {
      if (executable === "git" && args[0] === "fetch") {
        const timeout = options?.timeoutMs;
        assert.ok(timeout !== undefined);
        timeouts.push(timeout);
        clock += timeout + KILL_OVERHEAD_MS;
        throw new CommandTimeoutError(executable, args, timeout);
      }
      return production(executable, args, options);
    };

    const failure = await withRepoMirror(
      config,
      remote,
      run,
      {
        fetchRetryOptions: { now: () => clock, wait: async () => undefined },
        report: (event) => progress.push(event),
      },
      async () => "unreachable",
    ).then(() => null, (error: unknown) => error);

    assert.ok(failure instanceof Error);
    assert.match(failure.message, /timed out after/u);
    assert.equal(timeouts[0], CLONE_COMMAND_TIMEOUT_MS);
    assert.ok(timeouts.length > 1, "the existing refresh retry profile remains active");
    assert.ok(timeouts.every((timeout) => timeout <= CLONE_COMMAND_TIMEOUT_MS));
    assert.equal(clock, CLONE_OPERATION_BUDGET_MS);
    assert.equal(progress.some(({ event }) => String(event) === "creating"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cold clone that reaches its ceiling fails once with a first-clone message", async () => {
  const { root, remote, config, mirror } = await fixture("cold-timeout");
  let clock = 0;
  let fetchCalls = 0;
  let fetchTimeout: number | undefined;
  const production = bound(config, root);
  const run: CommandRunner = async (executable, args, options) => {
    if (executable === "git" && args[0] === "fetch") {
      fetchCalls += 1;
      fetchTimeout = options?.timeoutMs;
      assert.ok(fetchTimeout !== undefined);
      clock += fetchTimeout + KILL_OVERHEAD_MS;
      throw new CommandTimeoutError(executable, args, fetchTimeout);
    }
    return production(executable, args, options);
  };

  try {
    const failure = await withRepoMirror(
      config,
      remote,
      run,
      { fetchRetryOptions: { now: () => clock, wait: async () => undefined }, report: silent() },
      async () => "unreachable",
    ).then(() => null, (error: unknown) => error);

    assert.equal(fetchCalls, 1, "a failed first clone must not restart from zero");
    assert.ok(fetchTimeout !== undefined);
    assert.ok(fetchTimeout > CLONE_OPERATION_BUDGET_MS);
    assert.ok(failure instanceof Error);
    assert.equal(isCommandTimeout(failure), true, "the first-clone timeout must remain retryable infrastructure");
    assert.match(failure.message, new RegExp(escapedRegExp(mirror), "u"));
    assert.match(failure.message, /first[- ]clone|first clone|initial clone/u);
    const ceiling = CLONE_CREATION_TIMEOUT_MS.toLocaleString("en-US");
    assert.ok(
      failure.message.includes(String(CLONE_CREATION_TIMEOUT_MS))
        || failure.message.includes(ceiling)
        || failure.message.includes(`${CLONE_CREATION_TIMEOUT_MS / 60_000} minute`),
      "the first-clone timeout must name its creation ceiling",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the mirror carries branches and tags but not the remote's other refs", async () => {
  const { root, remote, seed, config, mirror } = await fixture("refspec");
  try {
    git(seed, "tag", "v1");
    git(seed, "push", "origin", "v1");
    // GitHub advertises refs/pull/*; no run has ever needed it and mirroring it
    // would make every fetch pay for the repository's whole review history.
    git(seed, "push", "origin", "HEAD:refs/pull/7/head");

    await provisionWorkspace(config, claimFor(remote, "refspec"), NO_DEPENDENCIES, { mirrorOptions: { report: silent() } });

    const refs = git(mirror, "for-each-ref", "--format=%(refname)").split("\n");
    assert.equal(refs.includes("refs/heads/main"), true);
    assert.equal(refs.includes("refs/tags/v1"), true);
    assert.equal(refs.includes("refs/pull/7/head"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mirror pointing at a different remote is refused instead of quietly re-cloning", async () => {
  const { root, remote, config, mirror } = await fixture("mismatch");
  try {
    await provisionWorkspace(config, claimFor(remote, "first"), NO_DEPENDENCIES, { mirrorOptions: { report: silent() } });
    git(mirror, "remote", "set-url", "origin", "https://github.com/acme/somewhere-else.git");

    const failure = await provisionWorkspace(
      config,
      claimFor(remote, "second"),
      NO_DEPENDENCIES,
      { mirrorOptions: { report: silent() } },
    ).then(() => null, (error: unknown) => error);
    assert.equal(failure instanceof RepoMirrorError, true);
    assert.equal((failure as RepoMirrorError).condition, "remote-url-mismatch");
    assert.match((failure as RepoMirrorError).message, /refuses to fall back to a full remote clone/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mirror that is not a readable git repository is refused, not rebuilt", async () => {
  const { root, remote, config, mirror } = await fixture("corrupt");
  try {
    await mkdir(mirror, { recursive: true });
    await writeFile(join(mirror, "not-a-repository"), "\n");

    const failure = await provisionWorkspace(
      config,
      claimFor(remote, "corrupt"),
      NO_DEPENDENCIES,
      { mirrorOptions: { report: silent() } },
    ).then(() => null, (error: unknown) => error);
    assert.equal(failure instanceof RepoMirrorError, true);
    assert.equal((failure as RepoMirrorError).condition, "not-a-readable-git-repository");
    // The refusal leaves the evidence in place for whoever has to look at it.
    assert.equal((await stat(join(mirror, "not-a-repository"))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a held lock is waited for, and one left behind by a dead holder is stolen", async () => {
  const { root, remote, config, mirror } = await fixture("lock");
  try {
    const lock = `${mirror}.lock`;
    await mkdir(join(root, "mirrors"), { recursive: true });
    await mkdir(lock);

    const refused = await withRepoMirror(
      config, remote, bound(config, root),
      { lockWaitMs: 10, lockPollMs: 1, report: silent() },
      async () => "unreachable",
    ).then(() => null, (error: unknown) => error);
    assert.match((refused as Error).message, /waiting for the runner repository mirror lock/u);

    // Backdated past the staleness threshold. A live holder touches its own
    // lock every heartbeat, so only a dead one can get this old.
    const stale = new Date(Date.now() - 3_600_000);
    await utimes(lock, stale, stale);
    let steals = 0;
    const taken = await withRepoMirror(
      config, remote, bound(config, root),
      {
        lockWaitMs: 10,
        lockPollMs: 1,
        report: (progress) => { if (progress.event === "lock-steal") steals += 1; },
      },
      async (path) => path,
    );
    assert.equal(taken, mirror);
    assert.equal(steals, 1);
    // Released on the way out, or the next run on this machine would wait ten
    // minutes for a mirror nobody is holding.
    await assert.rejects(stat(lock));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live heartbeating holder can cross the creation ceiling before releasing the lock", { timeout: 30_000 }, async () => {
  const { root, remote, config, mirror } = await fixture("lock-live");
  const holderReady = deferred<void>();
  const holderRelease = deferred<void>();
  const holder = withRepoMirror(
    config,
    remote,
    bound(config, root),
    { lockHeartbeatMs: 1, report: silent() },
    async () => {
      holderReady.resolve();
      await holderRelease.promise;
      return "holder";
    },
  );

  let clock = 0;
  let released = false;
  const waitClocks: number[] = [];
  const progress: RepoMirrorProgress[] = [];
  try {
    await holderReady.promise;
    const result = await withRepoMirror(
      config,
      remote,
      bound(config, root),
      {
        // Deliberately leave lockWaitMs at its default. The synthetic waiter
        // crosses the entire first-clone ceiling before releasing the holder.
        lockPollMs: 1,
        now: () => clock,
        sleep: async () => {
          // Keep the lock held at the ceiling and through the first acquisition
          // attempt beyond it, then let the holder finish its release. The
          // clock stops there so the fake wait cannot overshoot the default
          // lock wait while the real holder's cleanup gets a chance to run.
          if (waitClocks.length === 0) {
            clock = CLONE_CREATION_TIMEOUT_MS;
          } else if (waitClocks.length === 1) {
            clock = CLONE_CREATION_TIMEOUT_MS + 1_000;
          } else if (released === false) {
            released = true;
            holderRelease.resolve();
            await holder;
          }
          waitClocks.push(clock);
          await new Promise<void>((resolve) => { setImmediate(resolve); });
        },
        report: (event) => progress.push(event),
      },
      async (path) => path,
    );

    assert.equal(result, mirror);
    assert.deepEqual(
      waitClocks,
      [CLONE_CREATION_TIMEOUT_MS, CLONE_CREATION_TIMEOUT_MS + 1_000, CLONE_CREATION_TIMEOUT_MS + 1_000],
      "the waiter must cover the ceiling and first poll beyond it before releasing the live holder",
    );
    assert.equal(clock, CLONE_CREATION_TIMEOUT_MS + 1_000, "the synthetic clock must stay inside the default lock wait");
    assert.equal(progress.some(({ event }) => event === "lock-steal"), false, "a live holder must not be stolen");
  } finally {
    holderRelease.resolve();
    await holder.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a file where the lock directory belongs is stolen rather than waited on", async () => {
  const { root, remote, config, mirror } = await fixture("lock-file");
  try {
    // What a heartbeat that raced its own release leaves behind. No mkdir can
    // ever acquire it, so waiting out the stale window would wedge the machine
    // for nothing.
    await mkdir(join(root, "mirrors"), { recursive: true });
    await writeFile(`${mirror}.lock`, "");
    const taken = await withRepoMirror(
      config, remote, bound(config, root),
      { lockWaitMs: 10, lockPollMs: 1, report: silent() },
      async (path) => path,
    );
    assert.equal(taken, mirror);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a holder that was taken over does not delete its successor's lock", async () => {
  const { root, remote, config, mirror } = await fixture("release");
  const lock = `${mirror}.lock`;
  try {
    await withRepoMirror(config, remote, bound(config, root), { report: silent() }, async () => {
      // What a stale takeover looks like from inside the declared-dead holder:
      // its lock is gone and someone else's is at the path.
      await rm(lock, { recursive: true, force: true });
      await mkdir(lock);
      await writeFile(join(lock, "owner"), "successor\n");
      return null;
    });
    assert.equal((await readFile(join(lock, "owner"), "utf8")).trim(), "successor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the mirror is private to the account that runs the tasks", async () => {
  const { root, remote, config, mirror, mirrorRoot } = await fixture("private");
  const previous = process.umask(0o022);
  try {
    await provisionWorkspace(config, claimFor(remote, "private"), NO_DEPENDENCIES, { mirrorOptions: { report: silent() } });
    // The mirror carries the same history as the run workspace and lives in the
    // task account's own home. Nothing outside that account has business
    // reading it, and a permissive umask must not decide otherwise.
    assert.equal((await stat(mirrorRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(mirror)).isDirectory(), true);
  } finally {
    process.umask(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("every mirror command runs through the run-as prefix, so the account with the credentials fetches", async () => {
  const { root, remote, config, mirrorRoot } = await fixture("run-as");
  try {
    const log = join(root, "prefix.log");
    const launcher = join(root, "run-as.sh");
    // Stands in for `sudo -u agentrunner`: same uid, but it records the argv it
    // was handed. The mirror lives in a launched account's 0700 home, which the
    // daemon's own uid cannot even enter — so anything the daemon did directly
    // would fail in a real OS-isolated deployment.
    await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexec "$@"\n`, { mode: 0o755 });
    const isolated = { ...config, runAsPrefix: [launcher] } as RunnerConfig;
    await mkdir(config.workspaceRoot, { recursive: true });

    await provisionWorkspace(isolated, claimFor(remote, "run-as"), NO_DEPENDENCIES, { mirrorOptions: { report: silent() } });

    const argv = await readFile(log, "utf8");
    assert.match(argv, /git init --bare/u);
    assert.match(argv, /git fetch --prune/u);
    assert.match(argv, /git clone --branch/u);
    // The mirror root, the lock and the staging directory are created by the
    // same account, not by node's fs as the daemon.
    assert.equal(argv.includes(`/bin/sh -c`), true);
    assert.equal(argv.includes(mirrorRoot), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mirror root reached through a symlinked ancestor still counts as inside the workspace root", async () => {
  const { root, remote, config } = await fixture("overlap");
  try {
    // Nothing textual connects these two paths; the link is what puts the
    // mirror inside the tree the runner reclaims between runs.
    await mkdir(config.workspaceRoot, { recursive: true });
    await symlink(config.workspaceRoot, join(root, "alias"));
    const overlapping = { ...config, repoMirrorRoot: join(root, "alias", "mirrors") } as RunnerConfig;

    await assert.rejects(
      withRepoMirror(overlapping, remote, bound(overlapping, root), { report: silent() }, async () => undefined),
      /overlaps the workspace root/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staging the sweep could not remove is reported rather than swallowed", async () => {
  const { root, remote, config, mirrorRoot } = await fixture("staging");
  const stranded = join(mirrorRoot, ".stage-abandoned");
  try {
    await mkdir(mirrorRoot, { recursive: true });
    // What a process killed between mktemp and mv leaves behind, aged past the
    // sweep's threshold and made unremovable the way a restrictive ACL or a
    // read-only filesystem would: rm cannot descend into it to empty it.
    await mkdir(stranded, { recursive: true });
    await writeFile(join(stranded, "HEAD"), "ref: refs/heads/main\n");
    const aged = new Date(Date.now() - 3_600_000);
    await utimes(stranded, aged, aged);
    await chmod(stranded, 0o000);

    const progress: RepoMirrorProgress[] = [];
    await withRepoMirror(
      config, remote, bound(config, root),
      { report: (event) => progress.push(event) },
      async () => undefined,
    );

    // The run still succeeds — a leaked copy is not a reason to refuse work —
    // but it names what is now occupying the disk instead of exiting 0 over it.
    assert.deepEqual(
      progress.filter((event) => event.event === "staging-retained").map((event) => event.mirror),
      [stranded],
    );
  } finally {
    await chmod(stranded, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("mirror git runs are addressed by GIT_DIR, never by entering the mirror the daemon cannot", async () => {
  const { root, remote, config, mirror } = await fixture("git-dir");
  const runs: { args: string[]; cwd: string; gitDir: string | undefined }[] = [];
  const passthrough = bound(config, root);
  const observed: CommandRunner = (executable, args, options) => {
    if (executable === "git") runs.push({ args: [...args], cwd: options?.cwd ?? root, gitDir: options?.env?.GIT_DIR });
    return passthrough(executable, args, options);
  };
  try {
    await withRepoMirror(config, remote, observed, { report: silent() }, async () => undefined);

    const bare = runs.filter((run) => run.args[0] === "fetch" || run.args[0] === "config");
    assert.equal(bare.length > 0, true);
    for (const run of bare) {
      // GIT_DIR, because node chdirs into cwd as the daemon's own uid before
      // the run-as prefix executes, and a task account's home is 0700.
      assert.equal(typeof run.gitDir, "string");
      assert.equal(run.cwd.startsWith(mirror), false);
      assert.equal(run.cwd, root);
      // The subcommand stays at argv[0] so network-retry's allowlist, and the
      // timeout riding on it, still match.
      assert.equal(run.args[0] === "fetch" || run.args[0] === "config", true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("object presence is read from cat-file's own answer, never from an exit code", async () => {
  const { root, remote, seed, config } = await fixture("objects");
  try {
    const present = git(seed, "rev-parse", "HEAD");
    const absent = "0".repeat(40);
    const answers = await withRepoMirror(
      config, remote, bound(config, root), { report: silent() },
      (mirror) => mirrorRevisionsPresent(bound(config, root), mirror, [present, absent]),
    );
    assert.equal(answers.get(present), true);
    assert.equal(answers.get(absent), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the documented pre-seed naming rule matches repoMirrorPath", async () => {
  const remoteUrl = "https://github.com/acme/word-factory.git";
  const mirrorRoot = "/srv/agentos/shared/repo-mirrors";
  const installDocument = await readFile(new URL("../../../docs/install.md", import.meta.url), "utf8");
  assert.match(installDocument, /Pre-seed a repository mirror/u);
  assert.match(installDocument, /sha256\(remoteUrl\)\.git/u);
  assert.match(installDocument, /RUNNER_REPO_MIRROR_ROOT/u);
  assert.match(installDocument, /runner account/u);
  assert.match(installDocument, /refs\/heads/u);
  assert.match(installDocument, /refs\/pull/u);

  const documentedDirectory = `${createHash("sha256").update(remoteUrl).digest("hex")}.git`;
  assert.equal(repoMirrorPath(mirrorRoot, remoteUrl), join(mirrorRoot, documentedDirectory));
});
