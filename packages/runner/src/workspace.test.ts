import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chown, chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { RunnerConfig } from "./config.js";
import type { DependencyProvisioningDecision } from "./dependency-provisioning.js";
import { CLONE_COMMAND_TIMEOUT_MS } from "./network-retry.js";
import { bindCommandRunner, runCommand, type CommandRunner } from "./exec.js";
import { repoMirrorPath, repoMirrorRoot } from "./repo-mirror.js";
import { runtimeToolPaths } from "./runtime-tools.js";
import {
  cleanupAgentScratch, materializeRuntimeTools, provisionAgentScratch, provisionSessionConfig, provisionWorkspace, sessionConfigBaselineRoot,
  workspaceEnvironment, writeSessionCredentials,
  type WorkspaceProvisionClaim,
} from "./workspace.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const canonicalRuntimeTools = runtimeToolPaths.map((relativePath) =>
  [relativePath, `../runtime-tools/${relativePath}`] as const);

const createRuntimeToolsFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "agentos-runtime-tools-source-"));
  await mkdir(join(root, "gate-worker"));
  const sourceRoot = dirname(fileURLToPath(import.meta.url));
  await Promise.all(canonicalRuntimeTools.map(async ([relativePath, sourcePath]) => {
    const target = join(root, relativePath);
    await copyFile(resolve(sourceRoot, sourcePath), target);
  }));
  return root;
};

const pathWithFailingCommand = async (root: string, command: "cp" | "chmod"): Promise<string> => {
  const bin = join(root, `${command}-fails`);
  await mkdir(bin);
  await writeFile(join(bin, command), `#!/bin/sh\n/bin/${command} "$@"\nexit 73\n`);
  await chmod(join(bin, command), 0o755);
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
};

const pathWithNoopCommand = async (root: string, command: "chmod"): Promise<string> => {
  const bin = join(root, `${command}-noops`);
  await mkdir(bin);
  await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, command), 0o755);
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
};

/**
 * Faking git means faking a repository, but the mirror's bookkeeping — its
 * root, its lock, its staging directory — is real filesystem work in a
 * temporary directory. These runners run that for real and answer only for
 * `git`, so the lock protocol under test is the production one.
 */
const realShell = async (
  run: CommandRunner, executable: string, args: readonly string[],
): Promise<string | null> => (executable === "/bin/sh" ? run(executable, args) : null);

/** The runner provisioning binds, reproduced so a fake can wrap it. */
const provisioningRun = (config: RunnerConfig): CommandRunner =>
  bindCommandRunner(config.runAsPrefix, resolve(config.workspaceRoot), workspaceEnvironment(config));

type WorkspaceClaimFixture = {
  task: Pick<WorkspaceProvisionClaim["task"], "id">
    & Partial<Pick<WorkspaceProvisionClaim["task"], "templateStep">>;
  repo: WorkspaceProvisionClaim["repo"];
  run: Pick<WorkspaceProvisionClaim["run"], "id" | "runNumber" | "targetBranch" | "branch">
    & Partial<Pick<
      WorkspaceProvisionClaim["run"],
      "targetBranchPublished" | "pinnedBaseSha" | "implementationBaseSha" | "implementationHeadSha"
    >>;
  specificationMaterialization?: WorkspaceProvisionClaim["specificationMaterialization"];
};

const workspaceClaim = (fixture: WorkspaceClaimFixture): WorkspaceProvisionClaim => ({
  executionMode: "agent",
  runner: "CODEX",
  specificationMaterialization: fixture.specificationMaterialization ?? null,
  task: { ...fixture.task, chainId: null, chainIndex: null, templateStep: fixture.task.templateStep ?? null },
  repo: fixture.repo,
  run: {
    targetBranchPublished: false,
    pinnedBaseSha: null,
    implementationBaseSha: null,
    implementationHeadSha: null,
    ...fixture.run,
  },
});

/**
 * The decision most of these tests provision under. It is made when the claim
 * is admitted, so provisioning takes it as an argument instead of re-reading
 * the template step or the repository policy.
 */
const NO_DEPENDENCIES = {
  provision: false,
  evidence: "Dependency provisioning skipped: Repo.dependencyProvisioning=NONE",
} as const satisfies DependencyProvisioningDecision;

const NO_DEPENDENCIES_FOR_REVIEW = {
  provision: false,
  evidence: "Dependency provisioning skipped: TaskTemplateStep.provisionDependencies=false",
} as const satisfies DependencyProvisioningDecision;

const seedPackageRemote = async (root: string): Promise<string> => {
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--initial-branch=main", seed);
  git(seed, "config", "user.name", "Anneal Test");
  git(seed, "config", "user.email", "runner@agentos.local");
  await mkdir(join(seed, "packages/tool"), { recursive: true });
  await writeFile(join(seed, "package.json"), JSON.stringify({
    name: "runner-dependency-fixture",
    version: "1.0.0",
    private: true,
    workspaces: ["packages/*"],
    dependencies: { "fixture-tool": "*" },
  }) + "\n");
  await writeFile(join(seed, "packages/tool/package.json"), JSON.stringify({
    name: "fixture-tool",
    version: "1.0.0",
    main: "index.cjs",
  }) + "\n");
  await writeFile(join(seed, "packages/tool/index.cjs"), "module.exports = 'dependency fixture';\n");
  await runCommand([], "npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], seed, process.env);
  git(seed, "add", ".");
  git(seed, "commit", "-m", "dependency fixture");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  return remote;
};

test("an explicit false template step skips all dependency inspection after checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-review-dependency-skip-"));
  try {
    const remote = await seedPackageRemote(root);
    const calls: string[] = [];
    const progress: unknown[] = [];
    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    const production = provisioningRun(config);
    const execute: CommandRunner = async (executable, args, options) => {
      calls.push(`${executable} ${args.join(" ")}`);
      return production(executable, args, options);
    };
    const workspace = await provisionWorkspace(config, workspaceClaim({
      task: {
        id: "task-review",
        templateStep: { name: "Code review", outputKind: "result", provisionDependencies: false, taskTemplate: { name: "review-workflow" } },
      },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: { id: "run-review", runNumber: 1, targetBranch: "main", branch: "main" },
    }), NO_DEPENDENCIES_FOR_REVIEW, {
      run: execute,
      dependencyCacheOptions: { cacheRoot: join(root, "dependency-cache"), report: (event) => progress.push(event) },
    });

    assert.equal(await stat(join(workspace.path, "package.json")).then((info) => info.isFile()), true);
    await assert.rejects(stat(join(workspace.path, "node_modules")), { code: "ENOENT" });
    await assert.rejects(stat(join(root, "dependency-cache")), { code: "ENOENT" });
    assert.deepEqual(progress, []);
    assert.equal(calls.some((call) => /(?:^|\s)(?:node|npm)(?:\s|$)/u.test(call)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit true template step keeps the repository dependency policy path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-review-dependency-allow-"));
  try {
    const remote = await seedPackageRemote(root);
    const progress: Array<{ event: string; phase?: string; condition?: string }> = [];
    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    const workspace = await provisionWorkspace(config, workspaceClaim({
      task: {
        id: "task-implementation",
        templateStep: { name: "Implementation", outputKind: "result", provisionDependencies: true, taskTemplate: { name: "implementation-workflow" } },
      },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: { id: "run-implementation", runNumber: 1, targetBranch: "main", branch: "main" },
    }), { provision: true }, {
      dependencyCacheOptions: {
        cacheRoot: join(root, "dependency-cache"),
        report: (event) => progress.push(event),
      },
    });

    assert.equal((await stat(join(workspace.path, "node_modules"))).isDirectory(), true);
    assert.equal(progress.some((event) => event.phase === "identity"), true);
    assert.equal(progress.some((event) => event.phase === "install" || event.event === "hit"), true);
  } finally {
    await runCommand([], "/bin/chmod", ["-R", "u+w", join(root, "dependency-cache")], root, process.env).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("provisioning refuses a claim that carries no publish head", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-no-head-"));
  try {
    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    // The head is decided once, at Run birth, by @anneal/db. A runner that
    // filled a missing one in was the second decider this seam removed, so its
    // absence is a fault to report rather than a name to invent.
    const claim = workspaceClaim({
      task: { id: "task-no-head" },
      repo: { remoteUrl: join(root, "origin.git"), defaultBranch: "main" },
      run: { id: "run-no-head", runNumber: 1, targetBranch: "main", branch: null },
    });

    await assert.rejects(
      provisionWorkspace(config, claim, NO_DEPENDENCIES),
      /carries no publish head/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a workspace cloned from its own published head still resolves the target branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-target-refspec-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    // Not `main`: the target branch comes from the run, and every project on
    // the platform names its baseline itself.
    const target = "trunk";
    git(root, "init", "--bare", `--initial-branch=${target}`, remote);
    git(root, "init", `--initial-branch=${target}`, seed);
    git(seed, "config", "user.name", "Anneal Test");
    git(seed, "config", "user.email", "runner@agentos.local");
    await writeFile(join(seed, "tree.txt"), "base\n");
    git(seed, "add", "tree.txt");
    git(seed, "commit", "-m", "base");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", target);
    const targetSha = git(seed, "rev-parse", "HEAD");
    const branch = "agentos/chain/target-refspec";
    git(seed, "switch", "-c", branch);
    await writeFile(join(seed, "tree.txt"), "published\n");
    git(seed, "commit", "-am", "published before ACK loss");
    git(seed, "push", "-u", "origin", branch);

    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    const claim = workspaceClaim({
      task: { id: "task-target-refspec" },
      repo: { remoteUrl: remote, defaultBranch: target },
      run: { id: "run-target-refspec", runNumber: 2, targetBranch: target, branch },
    });

    const workspace = await provisionWorkspace(config, claim, NO_DEPENDENCIES);
    assert.equal(git(workspace.path, "rev-parse", `origin/${target}`), targetSha);
    assert.deepEqual(
      git(workspace.path, "config", "--get-all", "remote.origin.fetch").split("\n"),
      [
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        `+refs/heads/${target}:refs/remotes/origin/${target}`,
      ],
    );

    // The refspec has to survive provisioning: an agent fetching the baseline
    // mid-run must move the remote-tracking ref, not just FETCH_HEAD.
    git(seed, "switch", target);
    await writeFile(join(seed, "tree.txt"), "advanced\n");
    git(seed, "commit", "-am", "advanced baseline");
    git(seed, "push", "origin", target);
    const advancedSha = git(seed, "rev-parse", "HEAD");
    git(workspace.path, "fetch", "origin", target);
    assert.equal(git(workspace.path, "rev-parse", `origin/${target}`), advancedSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisioning trusts an already-published intended head after its database ACK was lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-publication-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    git(root, "init", "--bare", remote);
    git(root, "init", "--initial-branch=main", seed);
    git(seed, "config", "user.name", "Anneal Test");
    git(seed, "config", "user.email", "runner@agentos.local");
    await writeFile(join(seed, "tree.txt"), "base\n");
    git(seed, "add", "tree.txt");
    git(seed, "commit", "-m", "base");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");
    git(seed, "switch", "-c", "agentos/chain/demo-deadbeef");
    await writeFile(join(seed, "tree.txt"), "published\n");
    git(seed, "commit", "-am", "published before ACK loss");
    git(seed, "push", "-u", "origin", "agentos/chain/demo-deadbeef");
    const publishedSha = git(seed, "rev-parse", "HEAD");

    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      // Never the real home: provisioning keeps its mirror there.
      home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    const claim = workspaceClaim({
      task: { id: "task-1" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: {
        id: "run-2",
        runNumber: 2,
        // Database evidence was lost, so the resolver selected main even
        // though the intended shared head is already durable on the remote.
        targetBranch: "main",
        branch: "agentos/chain/demo-deadbeef",
      },
    });

    const workspace = await provisionWorkspace(config, claim, NO_DEPENDENCIES);
    assert.equal(workspace.branch, "agentos/chain/demo-deadbeef");
    assert.equal(workspace.baseSha, publishedSha);
    assert.equal(await readFile(join(workspace.path, "tree.txt"), "utf8"), "published\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisioning commits the server-prepared direct specification before the agent starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-specification-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "init", "--initial-branch=main", seed);
    git(seed, "config", "user.name", "Anneal Test");
    git(seed, "config", "user.email", "runner@agentos.local");
    await writeFile(join(seed, "tree.txt"), "base\n");
    git(seed, "add", "tree.txt");
    git(seed, "commit", "-m", "base");
    const originalHead = git(seed, "rev-parse", "HEAD");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");

    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    const branch = "feature/platform-spec";
    const specificationPath = `.chain/${branch}/spec.md`;
    const claim = workspaceClaim({
      task: { id: "task-specification" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: {
        id: "run-specification",
        runNumber: 1,
        targetBranch: "main",
        branch,
      },
      specificationMaterialization: {
        kind: "direct-implementation",
        path: specificationPath,
        body: "authoritative brief",
      },
    });

    const workspace = await provisionWorkspace(config, claim, NO_DEPENDENCIES);
    assert.equal(await readFile(join(workspace.path, specificationPath), "utf8"), "authoritative brief");
    assert.equal(git(workspace.path, "status", "--porcelain"), "");
    assert.equal(workspace.baseSha, git(workspace.path, "rev-parse", "HEAD"));
    assert.equal(git(workspace.path, "rev-parse", "HEAD^"), originalHead);
    assert.equal(git(workspace.path, "show", `HEAD:${specificationPath}`), "authoritative brief");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepared specification refuses a repository symlink that would escape the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-specification-symlink-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    const escaped = join(root, "escaped");
    await mkdir(escaped);
    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "init", "--initial-branch=main", seed);
    git(seed, "config", "user.name", "Anneal Test");
    git(seed, "config", "user.email", "runner@agentos.local");
    await symlink(escaped, join(seed, ".chain"));
    git(seed, "add", ".chain");
    git(seed, "commit", "-m", "symlink fixture");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");

    const config = {
      workspaceRoot: join(root, "workspaces"), runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin", home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    const branch = "feature/platform-spec";
    const claim = workspaceClaim({
      task: { id: "task-specification-symlink" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: { id: "run-specification-symlink", runNumber: 1, targetBranch: "main", branch },
      specificationMaterialization: {
        kind: "direct-implementation",
        path: `.chain/${branch}/spec.md`,
        body: "must stay inside",
      },
    });

    await assert.rejects(provisionWorkspace(config, claim, NO_DEPENDENCIES), /Prepared specification parent .* is a symlink/u);
    await assert.rejects(readFile(join(escaped, branch, "spec.md")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a resolver-confirmed newer salvage base outranks an existing declared head", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-salvage-base-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "init", "--initial-branch=main", seed);
    git(seed, "config", "user.name", "Anneal Test");
    git(seed, "config", "user.email", "runner@agentos.local");
    await writeFile(join(seed, "tree.txt"), "base\n");
    git(seed, "add", "tree.txt");
    git(seed, "commit", "-m", "base");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");
    const declared = "agentos/chain/shared";
    git(seed, "switch", "-c", declared);
    await writeFile(join(seed, "tree.txt"), "older declared\n");
    git(seed, "commit", "-am", "declared");
    git(seed, "push", "origin", declared);
    const salvage = "agentos/task-1/run-2";
    await writeFile(join(seed, "tree.txt"), "newer salvage\n");
    git(seed, "commit", "-am", "salvage");
    git(seed, "push", "origin", `HEAD:${salvage}`);
    const salvageSha = git(seed, "rev-parse", "HEAD");
    const config = {
      workspaceRoot: join(root, "workspaces"), runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin", home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    const claim = workspaceClaim({
      task: { id: "task-1" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: {
        id: "run-3", runNumber: 3, targetBranch: salvage,
        targetBranchPublished: true, branch: declared,
      },
    });
    const workspace = await provisionWorkspace(config, claim, NO_DEPENDENCIES);
    assert.equal(workspace.branch, declared);
    assert.equal(workspace.baseSha, salvageSha);
    assert.equal(await readFile(join(workspace.path, "tree.txt"), "utf8"), "newer salvage\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pinned workspace fetches only the recorded commit and never creates the chain ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-pinned-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    git(root, "init", "--bare", remote);
    git(root, "init", "--initial-branch=main", seed);
    git(seed, "config", "user.name", "Anneal Test");
    git(seed, "config", "user.email", "runner@agentos.local");
    await writeFile(join(seed, "base.txt"), "review base\n");
    git(seed, "add", "base.txt");
    git(seed, "commit", "-m", "review base");
    const implementationBaseSha = git(seed, "rev-parse", "HEAD");
    await writeFile(join(seed, "implementation.txt"), "delivered\n");
    git(seed, "add", "implementation.txt");
    git(seed, "commit", "-m", "implementation");
    const pinnedBaseSha = git(seed, "rev-parse", "HEAD");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");
    const chainBranch = "agentos/chain/blind-demo";
    git(seed, "switch", "-c", chainBranch);
    await writeFile(join(seed, "successor-report.md"), "must stay unreachable\n");
    git(seed, "add", "successor-report.md");
    git(seed, "commit", "-m", "successor artifact");
    const successorSha = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "-u", "origin", chainBranch);

    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      // Never the real home: provisioning keeps its mirror there.
      home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    const claim = workspaceClaim({
      task: { id: "task-blind" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: {
        id: "run-blind",
        runNumber: 1,
        targetBranch: pinnedBaseSha,
        pinnedBaseSha,
        implementationBaseSha,
        implementationHeadSha: pinnedBaseSha,
        branch: chainBranch,
      },
    });

    const workspace = await provisionWorkspace(config, claim, NO_DEPENDENCIES);
    assert.equal(workspace.baseSha, pinnedBaseSha);
    assert.equal(git(workspace.path, "branch", "--show-current"), "");
    assert.equal(git(workspace.path, "for-each-ref", "--format=%(refname)"), "");
    assert.doesNotThrow(() => git(workspace.path, "cat-file", "-e", `${implementationBaseSha}^{commit}`));
    assert.equal(await readFile(join(workspace.path, "implementation.txt"), "utf8"), "delivered\n");
    await assert.rejects(readFile(join(workspace.path, "successor-report.md")), /ENOENT/u);
    assert.throws(
      () => git(workspace.path, "cat-file", "-e", `${successorSha}^{commit}`),
      /Command failed/u,
      "the successor commit must not exist in the pinned workspace's object database",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the mirror fetch retries two transient failures and succeeds on the third attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-retry-"));
  try {
    let fetchCalls = 0;
    let cloneCalls = 0;
    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      // Never the real home: provisioning keeps its mirror there.
      home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    const claim = workspaceClaim({
      task: { id: "task-retry" },
      repo: {
        remoteUrl: "https://github.com/acme/app.git",
        defaultBranch: "main",
      },
      run: { id: "run-retry", runNumber: 1, targetBranch: "main", branch: "main" },
    });
    const mirrorRoot = repoMirrorRoot(config);
    const mirror = repoMirrorPath(mirrorRoot, claim.repo.remoteUrl);
    await mkdir(mirrorRoot, { recursive: true });
    git(mirrorRoot, "init", "--bare", mirror);
    git(mirror, "remote", "add", "origin", claim.repo.remoteUrl);
    const production = provisioningRun(config);
    const fake: CommandRunner = async (executable, args) => {
      const shell = await realShell(production, executable, args);
      if (shell !== null) return shell;
      if (executable === "git" && args[0] === "fetch") {
        fetchCalls += 1;
        if (fetchCalls < 3) throw new Error("fatal: unable to access remote: ECONNRESET");
      }
      if (executable === "git" && args[0] === "clone") cloneCalls += 1;
      if (executable === "git" && args[0] === "for-each-ref") return args[2] ?? "";
      if (executable === "git" && args[0] === "config" && args[1] === "--get") return claim.repo.remoteUrl;
      if (executable === "git" && args[0] === "rev-parse" && args[1] === "--is-bare-repository") return "true";
      if (executable === "git" && args[0] === "rev-parse") return "base-sha";
      return "";
    };
    const workspace = await provisionWorkspace(config, claim, NO_DEPENDENCIES, {
      run: fake,
      retryOptions: { wait: async () => undefined },
    });
    // The retried operation is the warm mirror's incremental fetch. The clone
    // that follows reads local disk, so retrying it would only repeat a failure
    // that no amount of waiting can change.
    assert.equal(fetchCalls, 3);
    assert.equal(cloneCalls, 1);
    assert.equal(workspace.baseSha, "base-sha");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type RecordedCommand = { args: string[]; cwd: string; timeoutMs: number | undefined };

const recordingExecutor = (
  calls: RecordedCommand[],
  answer: (args: string[]) => string,
  config: RunnerConfig,
): CommandRunner => {
  const root = resolve(config.workspaceRoot);
  const production = provisioningRun(config);
  return async (executable, args, options) => {
    calls.push({ args: [...args], cwd: options?.cwd ?? root, timeoutMs: options?.timeoutMs });
    const shell = await realShell(production, executable, args);
    return shell ?? answer([...args]);
  };
};

test("the mirror's remote fetch carries a per-command ceiling while local git commands stay uncapped", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-timeout-"));
  try {
    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      // Never the real home: provisioning keeps its mirror there.
      home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    const claim = workspaceClaim({
      task: { id: "task-timeout" },
      repo: {
        remoteUrl: "https://github.com/acme/app.git",
        defaultBranch: "main",
      },
      run: { id: "run-timeout", runNumber: 1, targetBranch: "main", branch: "agentos/task-timeout/run-1" },
    });
    const calls: RecordedCommand[] = [];
    const mirrorRoot = repoMirrorRoot(config);
    const mirror = repoMirrorPath(mirrorRoot, claim.repo.remoteUrl);
    await mkdir(mirrorRoot, { recursive: true });
    git(mirrorRoot, "init", "--bare", mirror);
    git(mirror, "remote", "add", "origin", claim.repo.remoteUrl);
    // Only main is published: the intended head's probe finds nothing, exactly
    // as the `ls-remote` round trip it replaced used to report.
    const fake = recordingExecutor(calls, (args) => {
      if (args[0] === "config" && args[1] === "--get") return claim.repo.remoteUrl;
      if (args[0] === "rev-parse" && args[1] === "--is-bare-repository") return "true";
      if (args[0] === "for-each-ref") return args[2] === "refs/heads/main" ? "refs/heads/main" : "";
      if (args[0] === "rev-parse") return "base-sha";
      return "";
    }, config);
    await provisionWorkspace(config, claim, NO_DEPENDENCIES, {
      run: fake,
      retryOptions: { wait: async () => undefined },
    });
    const ceiling = (name: string): number | undefined => calls.find(({ args }) => args[0] === name)?.timeoutMs;
    // The only command still talking to GitHub is the mirror's fetch, and a
    // hung one is what nothing else bounds before the agent starts.
    assert.equal(ceiling("fetch"), CLONE_COMMAND_TIMEOUT_MS);
    // The clone now reads local disk. Capping it would kill a working run on a
    // large repository to protect against a network that is no longer in play.
    assert.equal(ceiling("clone"), undefined);
    assert.equal(ceiling("for-each-ref"), undefined);
    assert.equal(ceiling("rev-parse"), undefined);
    assert.equal(ceiling("switch"), undefined);
    const clone = calls.find(({ args }) => args[0] === "clone");
    const mirrors = join(root, ".agentos", "repo-mirrors");
    assert.equal(clone?.args.at(-2)?.startsWith(mirrors), true, "the clone source must be the mirror");
    // Delivery pushes to origin: the mirror must not survive as the run's
    // publication target.
    assert.deepEqual(
      calls.find(({ args }) => args[0] === "remote" && args[1] === "set-url")?.args,
      ["remote", "set-url", "origin", "https://github.com/acme/app.git"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the pinned range is fetched out of the mirror, and only the mirror's own fetch is capped", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-pinned-timeout-"));
  try {
    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      // Never the real home: provisioning keeps its mirror there.
      home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    const claim = workspaceClaim({
      task: { id: "task-pinned-timeout" },
      repo: {
        remoteUrl: "https://github.com/acme/app.git",
        defaultBranch: "main",
      },
      run: {
        id: "run-pinned-timeout",
        runNumber: 1,
        targetBranch: "main",
        branch: "agentos/task-pinned-timeout/run-1",
        pinnedBaseSha: "pinned-sha",
        implementationBaseSha: "impl-base-sha",
        implementationHeadSha: "pinned-sha",
      },
    });
    const calls: RecordedCommand[] = [];
    const mirrorRoot = repoMirrorRoot(config);
    const mirror = repoMirrorPath(mirrorRoot, claim.repo.remoteUrl);
    await mkdir(mirrorRoot, { recursive: true });
    git(mirrorRoot, "init", "--bare", mirror);
    git(mirror, "remote", "add", "origin", claim.repo.remoteUrl);
    const fake = recordingExecutor(calls, (args) => {
      if (args[0] === "config" && args[1] === "--get") return claim.repo.remoteUrl;
      if (args[0] === "rev-parse" && args[1] === "--is-bare-repository") return "true";
      if (args[0] === "cat-file") return "impl-base-sha commit\npinned-sha commit";
      if (args[0] === "rev-parse") return "pinned-sha";
      return "";
    }, config);
    await provisionWorkspace(config, claim, NO_DEPENDENCIES, {
      run: fake,
      retryOptions: { wait: async () => undefined },
    });
    const remoteFetch = calls.find(({ args }) => args[0] === "fetch" && args.includes("origin"));
    const rangeFetch = calls.find(({ args }) => args[0] === "fetch" && args.includes("pinned-sha"));
    assert.equal(remoteFetch?.timeoutMs, CLONE_COMMAND_TIMEOUT_MS);
    // Both endpoints were already in the mirror, so the range is assembled from
    // local disk: slow on a long history, but it cannot hang.
    assert.equal(rangeFetch?.timeoutMs, undefined);
    assert.equal(rangeFetch?.args[2]?.startsWith(join(root, ".agentos", "repo-mirrors")), true);
    assert.equal(calls.some(({ args }) => args[0] === "clone"), false);
    assert.equal(calls.find(({ args }) => args[0] === "init" && args.length === 1)?.timeoutMs, undefined);
    assert.equal(calls.find(({ args }) => args[0] === "checkout")?.timeoutMs, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session credentials are created through the run-as prefix, with the token off the command line", async () => {
  // Without this, the daemon's own uid writes into a tree owned by the launched
  // account: the mkdir fails outright, and if it did not, the 0600 file would
  // belong to a user the MCP server is not running as and could not read.
  const root = await mkdtemp(join(tmpdir(), "agentos-credentials-prefix-"));
  try {
    const workspacePath = join(root, "run-1");
    await mkdir(join(workspacePath, ".git", "info"), { recursive: true });
    const log = join(root, "prefix.log");
    const launcher = join(root, "run-as.sh");
    // Stands in for `sudo -u agentrunner`: same uid, but it records the argv it
    // was handed, which is what proves the write went through the prefix.
    await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexec "$@"\n`, { mode: 0o755 });
    const config = {
      apiUrl: "http://api.local",
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
      runAsPrefix: [launcher],
    } as unknown as RunnerConfig;
    const claim = {
      run: { id: "run-1" },
      sessionToken: "session-token-never-in-argv",
      fencingToken: "fencing-token-never-in-argv",
    };

    const path = await writeSessionCredentials(config, claim, { path: workspacePath, branch: "topic", baseSha: "base" });

    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      apiUrl: "http://api.local",
      runId: "run-1",
      sessionToken: "session-token-never-in-argv",
      fencingToken: "fencing-token-never-in-argv",
      workspacePath,
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(workspacePath, ".agentos"))).mode & 0o777, 0o700);
    assert.match(await readFile(join(workspacePath, ".git", "info", "exclude"), "utf8"), /\/\.agentos\//u);

    const argv = await readFile(log, "utf8");
    assert.match(argv, /mkdir -p/u, "the credentials directory must be created by the launched account");
    assert.ok(!argv.includes("session-token-never-in-argv"), "a token in argv is readable by every account through ps");
    assert.ok(!argv.includes("fencing-token-never-in-argv"), "a token in argv is readable by every account through ps");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the run-as prefix keeps the launcher's own login identity out of the launched account's environment", () => {
  const base = { path: "/bin", home: "/opt/agentos/accounts/_agentos1" };
  const launched = workspaceEnvironment({ ...base, runAsPrefix: ["sudo", "-u", "agentrunner"] });
  // USER=<daemon owner> alongside HOME=<launched account> sends the CLI's
  // Keychain and git identity lookups at an account it is not running as.
  assert.equal(launched.USER, undefined);
  assert.equal(launched.LOGNAME, undefined);
  assert.equal(launched.HOME, "/opt/agentos/accounts/_agentos1");
  assert.equal(workspaceEnvironment({ ...base, runAsPrefix: [] }).USER, process.env.USER);
});

test("workspace and Git commands receive the platform-owned proxy environment", () => {
  const proxyEnvironment = {
    HTTP_PROXY: "http://runner-proxy.invalid:7897",
    http_proxy: "http://runner-proxy.invalid:7897",
    HTTPS_PROXY: "http://runner-proxy.invalid:7897",
    https_proxy: "http://runner-proxy.invalid:7897",
    NO_PROXY: "localhost",
    no_proxy: "localhost",
  };
  const launched = workspaceEnvironment({
    path: "/bin", home: "/runner", runAsPrefix: [], proxyEnvironment,
  });
  for (const [name, value] of Object.entries(proxyEnvironment)) assert.equal(launched[name], value);
});

test("a run-as workspace is provisioned by the launched account and cannot be enumerated by its siblings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-prefix-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    git(root, "init", "--bare", remote);
    git(root, "init", "--initial-branch=main", seed);
    git(seed, "config", "user.name", "Anneal Test");
    git(seed, "config", "user.email", "runner@agentos.local");
    await writeFile(join(seed, "tree.txt"), "base\n");
    git(seed, "add", "tree.txt");
    git(seed, "commit", "-m", "base");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");

    const workspaceRoot = join(root, "runs");
    await mkdir(workspaceRoot);
    const log = join(root, "prefix.log");
    const launcher = join(root, "run-as.sh");
    await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexec "$@"\n`, { mode: 0o755 });
    const config = {
      workspaceRoot,
      runAsPrefix: [launcher],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: root,
      gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
    } as unknown as RunnerConfig;
    const claim = workspaceClaim({
      task: { id: "task-prefix" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: { id: "run-prefix", runNumber: 1, targetBranch: "main", branch: "main" },
    });

    const workspace = await provisionWorkspace(config, claim, NO_DEPENDENCIES);

    // Traverse but not list. It cannot be 0700: node chdirs into `cwd` as the
    // daemon's uid before exec, so the CLI's own spawn would fail with EACCES
    // against a directory only the launched account can enter.
    assert.equal((await stat(workspace.path)).mode & 0o777, 0o711);
    const argv = await readFile(log, "utf8");
    assert.match(argv, /git clone/u, "the clone must run as the launched account, or it owns nothing it later deletes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Chain and salvage runs execute checkouts pinned to bases that predate any
// given safety fix, so a run can still resolve the production workspace root
// from a stale default and sweep it (2026-08-18, twice, run
// cmsyab8e200p2mp76pfhxl5xe). The runner always runs current code, so it is
// the only place that can contain every base: it hands the session throwaway
// roots via the environment.
//
// Both prefixes are covered: with a run-as launcher the session principal has
// to create the directories itself, which is a different code path from the
// direct mkdir. `/usr/bin/env --` is a launcher that changes no identity, so
// the branch is exercised without the test needing to become another user.
for (const runAsPrefix of [[], ["/usr/bin/env", "--"]]) {
  const label = runAsPrefix.length > 0 ? "behind a run-as launcher" : "directly";
  test(`agent scratch gives a run disposable roots the control plane will accept, provisioned ${label}`, async () => {
    const config = {
      workspaceRoot: join(await mkdtemp(join(tmpdir(), "agentos-configured-root-")), "runs"),
      runAsPrefix,
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: process.env.HOME ?? tmpdir(),
    } as unknown as RunnerConfig;

    const scratch = await provisionAgentScratch(config);
    try {
      assert.notEqual(scratch.workspaceRoot, config.workspaceRoot);
      assert.equal(scratch.workspaceRoot.startsWith(`${scratch.base}${sep}`), true);
      assert.equal(scratch.stateDir.startsWith(`${scratch.base}${sep}`), true);
      // Siblings, never nested: the control plane refuses a state dir that
      // overlaps its workspace root.
      assert.equal(scratch.stateDir.startsWith(`${scratch.workspaceRoot}${sep}`), false);
      assert.equal(scratch.workspaceRoot.startsWith(`${scratch.stateDir}${sep}`), false);
      assert.equal(scratch.toolsDir, join(scratch.base, "tools"));
      assert.equal(scratch.toolsDir.startsWith(`${scratch.workspaceRoot}${sep}`), false);
      assert.equal(scratch.toolsDir.startsWith(`${scratch.stateDir}${sep}`), false);

      for (const directory of [scratch.workspaceRoot, scratch.stateDir]) {
        const info = await stat(directory);
        assert.equal(info.isDirectory(), true);
        // The control plane demands exactly 0700 on its state dir.
        assert.equal(info.mode & 0o777, 0o700);
      }

      // Aliased paths and symlinked components are both rejected by the control
      // plane; macOS puts os.tmpdir() under /var -> /private/var.
      assert.equal(await realpath(scratch.base), scratch.base);
      for (let cursor = scratch.stateDir; dirname(cursor) !== cursor; cursor = dirname(cursor)) {
        assert.equal((await lstat(cursor)).isSymbolicLink(), false, `${cursor} is a symlink`);
      }

      // Disposable: under the system temp dir, not the configured root.
      assert.equal(scratch.base.startsWith(`${await realpath(tmpdir())}${sep}`), true);
    } finally {
      await cleanupAgentScratch(config, scratch);
    }
    await assert.rejects(stat(scratch.base));
  });
}

test("run-as scratch commands start outside the target-owned base", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-run-as-scratch-owner-"));
  const log = join(root, "launcher.log");
  const launcher = join(root, "run-as.sh");
  await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$PWD" >> ${log}\nexec "$@"\n`, { mode: 0o755 });
  const config = {
    workspaceRoot: join(root, "workspaces"),
    runAsPrefix: [launcher],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home: root,
  } as unknown as RunnerConfig;

  const scratch = await provisionAgentScratch(config);
  const sourceRoot = await createRuntimeToolsFixture();
  try {
    await materializeRuntimeTools(config, scratch, { sourceRoot });
    const commandCwds = (await readFile(log, "utf8")).trim().split("\n");
    for (const cwd of commandCwds) {
      assert.equal(cwd, await realpath(tmpdir()), "the daemon must be able to enter cwd before the launcher changes uid");
    }
    await cleanupAgentScratch(config, scratch);
    await assert.rejects(stat(scratch.base), /ENOENT/u);
  } finally {
    await rm(scratch.base, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

for (const runAsPrefix of [[], ["/usr/bin/env", "--"]]) {
  const label = runAsPrefix.length > 0 ? "behind a run-as launcher" : "directly";
  test(`materializes the release-local runtime tools outside the checkout ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agentos-runtime-tools-"));
    const sourceRoot = await createRuntimeToolsFixture();
    const config = {
      workspaceRoot: join(root, "checkout-root"),
      runAsPrefix,
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: root,
    } as unknown as RunnerConfig;
    const scratch = await provisionAgentScratch(config);
    try {
      // The materializer writes only into the release-local scratch directory;
      // project checkout contents do not participate in this operation.
      const checkout = join(root, "checkout");
      await mkdir(checkout, { recursive: true });
      for (const [relativePath] of canonicalRuntimeTools) {
        const decoy = join(checkout, "packages", "runner", "runtime-tools", relativePath);
        await mkdir(dirname(decoy), { recursive: true });
        await writeFile(decoy, "checkout decoy must not be used\n");
      }
      await materializeRuntimeTools(config, scratch, { sourceRoot });

      assert.equal(scratch.toolsDir, join(scratch.base, "tools"));
      assert.equal(scratch.toolsDir.startsWith(`${checkout}${sep}`), false);
      assert.deepEqual(
        (await readdir(scratch.toolsDir)).sort(),
        ["gate-worker", "git-credential-runner.sh", "merge-train.mjs", "merge-train.sh", "regression-verification.sh"],
      );
      assert.deepEqual(
        (await readdir(join(scratch.toolsDir, "gate-worker"))).sort(),
        ["gate-dispatch.sh", "lib.sh", "mirror-push.sh", "remote-gate.sh", "run-gate.sh"],
      );
      for (const [relativePath] of canonicalRuntimeTools) {
        assert.deepEqual(
          await readFile(join(sourceRoot, relativePath)),
          await readFile(join(scratch.toolsDir, relativePath)),
          relativePath,
        );
        assert.equal((await stat(join(scratch.toolsDir, relativePath))).mode & 0o777, 0o500);
      }
      assert.equal((await stat(scratch.toolsDir)).mode & 0o777, 0o700);
      assert.equal((await stat(join(scratch.toolsDir, "gate-worker"))).mode & 0o777, 0o700);
    } finally {
      await cleanupAgentScratch(config, scratch);
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
    await assert.rejects(stat(scratch.toolsDir));
  });
}

test("runtime-tool materialization rejects collisions, absent sources, copy failures, and chmod failures", async () => {
  const cases: Array<{ name: string; prepare: (sourceRoot: string, scratch: Awaited<ReturnType<typeof provisionAgentScratch>>, root: string) => Promise<RunnerConfig> }> = [
    {
      name: "an existing destination",
      prepare: async (_sourceRoot, scratch) => {
        await mkdir(scratch.toolsDir);
        await writeFile(join(scratch.toolsDir, "sentinel"), "must remain untouched\n");
        return {
          workspaceRoot: scratch.base,
          runAsPrefix: [],
          path: process.env.PATH ?? "/usr/bin:/bin",
          home: scratch.base,
        } as unknown as RunnerConfig;
      },
    },
    {
      name: "a missing source file",
      prepare: async (sourceRoot, scratch) => {
        await rm(join(sourceRoot, "gate-worker", "lib.sh"));
        return {
          workspaceRoot: scratch.base,
          runAsPrefix: [],
          path: process.env.PATH ?? "/usr/bin:/bin",
          home: scratch.base,
        } as unknown as RunnerConfig;
      },
    },
    {
      name: "a wrong source file type",
      prepare: async (sourceRoot, scratch) => {
        await rm(join(sourceRoot, "gate-worker", "lib.sh"));
        await mkdir(join(sourceRoot, "gate-worker", "lib.sh"));
        return {
          workspaceRoot: scratch.base,
          runAsPrefix: [],
          path: process.env.PATH ?? "/usr/bin:/bin",
          home: scratch.base,
        } as unknown as RunnerConfig;
      },
    },
    {
      name: "a copy failure",
      prepare: async (_sourceRoot, scratch, root) => ({
        workspaceRoot: scratch.base,
        runAsPrefix: [],
        path: await pathWithFailingCommand(root, "cp"),
        home: scratch.base,
      } as unknown as RunnerConfig),
    },
    {
      name: "a chmod failure",
      prepare: async (_sourceRoot, scratch, root) => ({
        workspaceRoot: scratch.base,
        runAsPrefix: [],
        path: await pathWithFailingCommand(root, "chmod"),
        home: scratch.base,
      } as unknown as RunnerConfig),
    },
  ];

  for (const failureCase of cases) {
    const root = await mkdtemp(join(tmpdir(), "agentos-runtime-tools-failure-"));
    const sourceRoot = await createRuntimeToolsFixture();
    const baseConfig = {
      workspaceRoot: join(root, "checkout-root"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: root,
    } as unknown as RunnerConfig;
    const scratch = await provisionAgentScratch(baseConfig);
    try {
      const configured = await failureCase.prepare(sourceRoot, scratch, root);
      await assert.rejects(
        materializeRuntimeTools(configured, scratch, { sourceRoot }),
        /runtime tools materialization|failed|expected/u,
        failureCase.name,
      );
      if (failureCase.name === "an existing destination") {
        assert.equal(await readFile(join(scratch.toolsDir, "sentinel"), "utf8"), "must remain untouched\n");
      } else {
        await assert.rejects(stat(scratch.toolsDir), /ENOENT/u, failureCase.name);
      }
    } finally {
      await cleanupAgentScratch(baseConfig, scratch);
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("runtime-tool materialization never falls back to copies in the project checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-runtime-tools-no-fallback-"));
  const sourceRoot = await createRuntimeToolsFixture();
  const checkout = join(root, "checkout");
  const config = {
    workspaceRoot: checkout,
    runAsPrefix: [],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home: root,
  } as unknown as RunnerConfig;
  await mkdir(checkout);
  for (const [relativePath] of canonicalRuntimeTools) {
    const decoy = join(checkout, "packages", "runner", "runtime-tools", relativePath);
    await mkdir(dirname(decoy), { recursive: true });
    await writeFile(decoy, "checkout decoy must not be used\n");
  }
  const scratch = await provisionAgentScratch(config);
  try {
    await rm(join(sourceRoot, "gate-worker", "lib.sh"));
    await assert.rejects(
      materializeRuntimeTools(config, scratch, { sourceRoot }),
      /expected a regular file/u,
    );
    await assert.rejects(stat(scratch.toolsDir), /ENOENT/u);
  } finally {
    await cleanupAgentScratch(config, scratch);
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-tool materialization ignores unrelated release-source entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-runtime-tools-extra-source-"));
  const sourceRoot = await createRuntimeToolsFixture();
  const config = {
    workspaceRoot: join(root, "checkout"),
    runAsPrefix: [],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home: root,
  } as unknown as RunnerConfig;
  const scratch = await provisionAgentScratch(config);
  try {
    await writeFile(join(sourceRoot, ".incidental"), "not part of the bundle\n");
    await materializeRuntimeTools(config, scratch, { sourceRoot });
    assert.deepEqual((await readdir(scratch.toolsDir)).sort(), ["gate-worker", "git-credential-runner.sh", "merge-train.mjs", "merge-train.sh", "regression-verification.sh"]);
  } finally {
    await cleanupAgentScratch(config, scratch);
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-tool materialization reports an exact-mode mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-runtime-tools-mode-mismatch-"));
  const sourceRoot = await createRuntimeToolsFixture();
  const config = {
    workspaceRoot: join(root, "checkout"),
    runAsPrefix: [],
    path: await pathWithNoopCommand(root, "chmod"),
    home: root,
  } as unknown as RunnerConfig;
  const scratch = await provisionAgentScratch(config);
  try {
    await assert.rejects(
      materializeRuntimeTools(config, scratch, { sourceRoot }),
      /runtime tools materialization: unexpected mode on .*expected 500/u,
    );
    await assert.rejects(stat(scratch.toolsDir), /ENOENT/u);
  } finally {
    await cleanupAgentScratch(config, scratch);
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex session config contains only the platform baseline and host auth, then deletes on success", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-codex-config-"));
  const home = join(root, "runner-home");
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), '{"tokens":"host-only"}\n', { mode: 0o600 });
  const config = {
    workspaceRoot: join(root, "workspaces"),
    runAsPrefix: [],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home,
    sessionConfigBaselineRoot: sessionConfigBaselineRoot(),
  } as unknown as RunnerConfig;
  const scratch = await provisionAgentScratch(config, "session-codex-config");
  try {
    await provisionSessionConfig(config, "CODEX", scratch);
    assert.equal(await readFile(join(scratch.configRoot, "config.toml"), "utf8"), await readFile(join(sessionConfigBaselineRoot(), "codex", "config.toml"), "utf8"));
    assert.equal(await readFile(join(scratch.configRoot, "auth.json"), "utf8"), '{"tokens":"host-only"}\n');
    assert.deepEqual((await readdir(scratch.configRoot)).sort(), ["auth.json", "config.toml"]);
    assert.equal((await stat(scratch.configRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(join(scratch.configRoot, "auth.json"))).mode & 0o777, 0o600);
    assert.equal((await readdir(scratch.configRoot)).includes("AGENTS.md"), false);
    await cleanupAgentScratch(config, scratch);
    await assert.rejects(stat(scratch.configRoot), /ENOENT/u);
  } finally {
    await rm(scratch.configRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("PI session config contains only host auth and excludes hostile host settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-pi-config-"));
  const home = join(root, "runner-home");
  const hostAgentDir = join(home, ".pi", "agent");
  await mkdir(hostAgentDir, { recursive: true });
  await writeFile(join(hostAgentDir, "auth.json"), '{"openai-codex":{"type":"oauth"}}\n', { mode: 0o600 });
  await writeFile(join(hostAgentDir, "settings.json"), '{"shellCommandPrefix":"hostile","defaultTools":[]}\n');
  await mkdir(join(hostAgentDir, "extensions"));
  await writeFile(join(hostAgentDir, "extensions", "hostile.ts"), "throw new Error('loaded host extension');\n");
  const config = {
    workspaceRoot: join(root, "workspaces"),
    runAsPrefix: [],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home,
    sessionConfigBaselineRoot: sessionConfigBaselineRoot(),
  } as unknown as RunnerConfig;
  const scratch = await provisionAgentScratch(config, "session-pi-config");
  try {
    await provisionSessionConfig(config, "PI", scratch);
    assert.deepEqual(await readdir(scratch.configRoot), ["auth.json"]);
    assert.equal(await readFile(join(scratch.configRoot, "auth.json"), "utf8"), '{"openai-codex":{"type":"oauth"}}\n');
    assert.equal((await stat(scratch.configRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(join(scratch.configRoot, "auth.json"))).mode & 0o777, 0o600);
  } finally {
    await cleanupAgentScratch(config, scratch);
    await rm(root, { recursive: true, force: true });
  }
});

test("PI auth provisioning fails loudly without falling back to host settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-pi-config-failure-"));
  const home = join(root, "runner-home");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(join(home, ".pi", "agent", "settings.json"), '{"defaultProjectTrust":"always"}\n');
  const config = {
    workspaceRoot: join(root, "workspaces"),
    runAsPrefix: [],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home,
    sessionConfigBaselineRoot: sessionConfigBaselineRoot(),
  } as unknown as RunnerConfig;
  const scratch = await provisionAgentScratch(config, "session-pi-config-failure");
  try {
    await assert.rejects(provisionSessionConfig(config, "PI", scratch), (error: unknown) =>
      error instanceof Error
      && error.message.includes("Unable to establish PI authentication")
      && error.message.includes(scratch.configRoot));
    assert.deepEqual(await readdir(scratch.configRoot), []);
  } finally {
    await cleanupAgentScratch(config, scratch);
    await rm(root, { recursive: true, force: true });
  }
});

test("a distinct run-as uid owns and can use its runtime tools and Codex config root", {
  skip: typeof process.getuid !== "function" || process.getuid() !== 0
    ? "requires root to exercise a genuinely distinct uid"
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-codex-distinct-uid-"));
  const targetUser = "daemon";
  const targetUid = Number(execFileSync("id", ["-u", targetUser], { encoding: "utf8" }).trim());
  const targetGid = Number(execFileSync("id", ["-g", targetUser], { encoding: "utf8" }).trim());
  const home = join(root, "runner-home");
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), '{"tokens":"target-only"}\n', { mode: 0o600 });
  await chown(root, targetUid, targetGid);
  await chown(home, targetUid, targetGid);
  await chown(join(home, ".codex"), targetUid, targetGid);
  await chown(join(home, ".codex", "auth.json"), targetUid, targetGid);
  const config = {
    workspaceRoot: join(root, "workspaces"),
    runAsPrefix: ["/usr/bin/sudo", "-n", "-u", targetUser, "--"],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home,
    sessionConfigBaselineRoot: sessionConfigBaselineRoot(),
  } as unknown as RunnerConfig;
  const scratch = await provisionAgentScratch(config, "session-codex-distinct-uid");
  const configParent = dirname(scratch.configRoot);
  const sourceRoot = await createRuntimeToolsFixture();
  try {
    await chmod(sourceRoot, 0o755);
    await chmod(join(sourceRoot, "gate-worker"), 0o755);
    for (const [relativePath] of canonicalRuntimeTools) {
      await chmod(join(sourceRoot, relativePath), 0o644);
    }
    await materializeRuntimeTools(config, scratch, { sourceRoot });
    for (const directory of [scratch.toolsDir, join(scratch.toolsDir, "gate-worker")]) {
      const info = await stat(directory);
      assert.equal(info.uid, targetUid);
      assert.equal(info.mode & 0o777, 0o700);
    }
    for (const [relativePath] of canonicalRuntimeTools) {
      const materializedPath = join(scratch.toolsDir, relativePath);
      const info = await stat(materializedPath);
      assert.equal(info.uid, targetUid);
      assert.equal(info.mode & 0o777, 0o500);
      execFileSync("/usr/bin/sudo", ["-n", "-u", targetUser, "--", "/usr/bin/test", "-r", materializedPath]);
      execFileSync("/usr/bin/sudo", ["-n", "-u", targetUser, "--", "/usr/bin/test", "-x", materializedPath]);
    }
    await provisionSessionConfig(config, "CODEX", scratch);
    assert.equal((await stat(scratch.configRoot)).uid, targetUid);
    assert.equal((await stat(join(scratch.configRoot, "auth.json"))).uid, targetUid);
    assert.equal(execFileSync("/usr/bin/sudo", ["-n", "-u", targetUser, "--", "/bin/cat", join(scratch.configRoot, "auth.json")], { encoding: "utf8" }), '{"tokens":"target-only"}\n');
    await cleanupAgentScratch(config, scratch);
    for (const removed of [scratch.configRoot, configParent, scratch.workspaceRoot, scratch.stateDir, scratch.toolsDir, scratch.base]) {
      await assert.rejects(stat(removed), /ENOENT/u);
    }
  } finally {
    await rm(scratch.base, { recursive: true, force: true });
    await rm(configParent, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex auth provisioning fails loudly without touching the host config", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-codex-config-failure-"));
  const home = join(root, "runner-home");
  await mkdir(join(home, ".codex"), { recursive: true });
  const config = {
    workspaceRoot: join(root, "workspaces"),
    runAsPrefix: [],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home,
    sessionConfigBaselineRoot: sessionConfigBaselineRoot(),
  } as unknown as RunnerConfig;
  const scratch = await provisionAgentScratch(config, "session-codex-config-failure");
  try {
    await assert.rejects(provisionSessionConfig(config, "CODEX", scratch), (error: unknown) =>
      error instanceof Error
      && error.message.includes("Unable to establish Codex authentication")
      && error.message.includes(scratch.configRoot));
    assert.equal((await stat(scratch.configRoot)).isDirectory(), true);
    assert.equal(await readFile(join(scratch.configRoot, "config.toml"), "utf8"), await readFile(join(sessionConfigBaselineRoot(), "codex", "config.toml"), "utf8"));
  } finally {
    await cleanupAgentScratch(config, scratch, { retainConfigRoot: false });
    await rm(root, { recursive: true, force: true });
  }
});
