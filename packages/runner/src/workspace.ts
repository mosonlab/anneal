import { appendFile, chmod, lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ClaimedTask } from "./api.js";
import { RUNNER_DEFINITIONS } from "./adapters.js";
import { workspaceEnvironment } from "./adapters/environment.js";
import type { SessionConfigOptions } from "./adapters/session-config.js";
import { defaultSessionConfigBaselineRoot, type RunnerConfig, type RunnerKind } from "./config.js";
import { runtimeToolPaths } from "./runtime-tools.js";
import { materializeWorkspaceDependencies, type DependencyCacheOptions } from "./dependency-cache.js";
import type { DependencyProvisioningDecision } from "./dependency-provisioning.js";
import { bindCommandRunner, commandRunnerIn, platformCommitArgs, type CommandRunner } from "./exec.js";
import {
  configureWorkspaceGit, resolveRunnerGitIdentity, type GitProvenanceClaim,
} from "./git-provenance.js";
import { type RetryOptions } from "./network-retry.js";
import {
  ensureMirrorRevisions, mirrorHasBranch, withRepoMirror, type RepoMirrorOptions,
} from "./repo-mirror.js";

export { workspaceEnvironment } from "./adapters/environment.js";

export type Workspace = {
  path: string;
  branch: string;
  baseSha: string;
  /** Absolute hook directory activated only in the provider child environment. */
  commitHooksPath?: string;
  /** Present only for an object-id-only detached checkout. */
  pinnedBaseSha?: string;
};

const inside = (root: string, candidate: string): boolean => candidate.startsWith(`${root}${sep}`);

const assertMaterializationPathIsPlain = async (workspace: string, path: string): Promise<void> => {
  const parentParts = relative(workspace, dirname(path)).split(sep).filter(Boolean);
  let current = workspace;
  for (const part of parentParts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Prepared specification parent ${current} is a symlink`);
      if (!info.isDirectory()) throw new Error(`Prepared specification parent ${current} is not a directory`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Prepared specification target ${path} is not a regular file`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const materializePreparedSpecification = async (
  prepared: ClaimedTask["specificationMaterialization"],
  workspace: Workspace,
  run: CommandRunner,
): Promise<Workspace> => {
  if (!prepared) return workspace;
  if (workspace.pinnedBaseSha) throw new Error("Pinned review workspace cannot materialize a direct implementation specification");
  const expectedPath = `.chain/${workspace.branch}/spec.md`;
  if (prepared.kind !== "direct-implementation" || prepared.path !== expectedPath) {
    throw new Error(`Prepared specification path ${prepared.path} does not match claimed branch ${workspace.branch}`);
  }
  const absolutePath = resolve(workspace.path, prepared.path);
  if (!inside(workspace.path, absolutePath)) throw new Error("Prepared specification escaped the controlled workspace");
  await assertMaterializationPathIsPlain(workspace.path, absolutePath);

  await run(
    "/bin/sh",
    ["-c", 'umask 022; mkdir -p -- "$1"; cat > "$2"', "agentos-specification", dirname(absolutePath), absolutePath],
    { input: prepared.body },
  );
  await run("git", ["add", "-f", "--", prepared.path]);
  const status = await run("git", ["status", "--porcelain", "--", prepared.path]);
  if (!status) return workspace;
  await run("git", platformCommitArgs("Materialize direct-chain specification", prepared.path));
  return { ...workspace, baseSha: await run("git", ["rev-parse", "HEAD"]) };
};

export type WorkspaceProvisionClaim = GitProvenanceClaim & Pick<ClaimedTask, "specificationMaterialization"> & {
  task: GitProvenanceClaim["task"] & Pick<ClaimedTask["task"], "id">;
  repo: Pick<ClaimedTask["repo"], "remoteUrl" | "defaultBranch">;
  run: GitProvenanceClaim["run"] & Pick<
    ClaimedTask["run"],
    | "runNumber"
    | "targetBranch"
    | "targetBranchPublished"
    | "pinnedBaseSha"
    | "implementationBaseSha"
    | "implementationHeadSha"
    | "branch"
  >;
};

export type WorkspaceReuseClaim = GitProvenanceClaim & {
  run: GitProvenanceClaim["run"] & Pick<
    ClaimedTask["run"],
    "workspacePath" | "branch" | "baseSha" | "pinnedBaseSha"
  >;
};

export type ProvisionWorkspaceDependencies = {
  /** Bound to the workspace root; provisioning rebinds it to the run directory
   *  for the commands that belong there. */
  run?: CommandRunner;
  retryOptions?: RetryOptions;
  dependencyCacheOptions?: DependencyCacheOptions;
  mirrorOptions?: RepoMirrorOptions;
};

/** The runner's commands for one directory, under the run-as prefix and the
 *  provider child environment. See `CommandRunner` for why the prefix is bound
 *  here rather than threaded through every internal call. */
const workspaceCommands = (
  config: Pick<RunnerConfig, "runAsPrefix" | "path" | "home">,
  cwd: string,
): CommandRunner => bindCommandRunner(config.runAsPrefix, cwd, workspaceEnvironment(config));

export type AgentScratch = {
  /** The disposable directory both runner roots live in; removed when the run ends. */
  base: string;
  workspaceRoot: string;
  stateDir: string;
  /** The release-local regression tool bundle, outside every project checkout. */
  toolsDir: string;
  /** A per-session CLI config root; it is outside `base` so failures can retain it. */
  configRoot: string;
};

/** The immutable tool bundle shipped beside the compiled runner entrypoint. */
export const runtimeToolsSourceRoot = fileURLToPath(new URL("../dist/runtime-tools", import.meta.url));

/** Generate from the trusted runtime inventory; tests can supply a synthetic layout. */
export const runtimeToolsMaterializationScript = (toolPaths: readonly string[] = runtimeToolPaths): string => {
  // Insert each ancestor before its children so exclusive mkdir needs no -p.
  const toolDirs = new Set<string>();
  for (const path of toolPaths) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      toolDirs.add(parts.slice(0, depth).join("/"));
    }
  }
  return String.raw`
set -eu

source_root=$1
tools_root=$2

fail() {
  echo "runtime tools materialization: $*" >&2
  exit 1
}

require_directory() {
  [ -d "$1" ] && [ ! -L "$1" ] || fail "expected a regular directory: $1"
}

require_file() {
  [ -f "$1" ] && [ ! -L "$1" ] || fail "expected a regular file: $1"
}

tool_paths='${toolPaths.join("\n")}'
tool_dirs='${[...toolDirs].join("\n")}'

is_tool_path() {
  for tool_path in $tool_paths; do
    [ "$1" = "$tool_path" ] && return 0
  done
  return 1
}

is_tool_dir() {
  for tool_dir in $tool_dirs; do
    [ "$1" = "$tool_dir" ] && return 0
  done
  return 1
}

check_destination_entries() {
  for directory in . $tool_dirs; do
    for entry in "$tools_root/$directory"/* "$tools_root/$directory"/.[!.]* "$tools_root/$directory"/..?*; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      relative_path=$(basename "$entry")
      if [ "$directory" != . ]; then
        relative_path=$directory/$relative_path
      fi
      is_tool_dir "$relative_path" || is_tool_path "$relative_path" \
        || fail "unexpected materialized entry: $entry"
    done
  done
}

require_directory "$source_root"
for directory in $tool_dirs; do
  require_directory "$source_root/$directory"
done
for relative_path in $tool_paths; do
  require_file "$source_root/$relative_path"
done

# The destination is deliberately exclusive. Do not merge into a directory
# left by a previous run or follow a path supplied by a task.
created=0
cleanup() {
  if [ "$created" -eq 1 ]; then
    rm -rf "$tools_root"
  fi
}
trap cleanup EXIT HUP INT TERM

mkdir -m 700 "$tools_root"
created=1
for directory in $tool_dirs; do
  mkdir -m 700 "$tools_root/$directory"
done

for relative_path in $tool_paths; do
  cp "$source_root/$relative_path" "$tools_root/$relative_path"
  chmod 500 "$tools_root/$relative_path"
  cmp "$source_root/$relative_path" "$tools_root/$relative_path" >/dev/null
done

require_directory "$tools_root"
for directory in $tool_dirs; do
  require_directory "$tools_root/$directory"
done
for relative_path in $tool_paths; do
  require_file "$tools_root/$relative_path"
done
check_destination_entries

# mkdir/chmod above are the only writers. These checks make a successful
# command prove the exact access modes as well as the exact inventory.
mode() {
  if mode_value=$(stat -c '%a' "$1" 2>/dev/null); then
    printf '%s' "$mode_value"
  else
    stat -f '%Lp' "$1"
  fi
}
require_mode() {
  actual_mode=$(mode "$1")
  [ "$actual_mode" = "$2" ] \
    || fail "unexpected mode on $1: got $actual_mode, expected $2"
}
require_mode "$tools_root" 700
for directory in $tool_dirs; do
  require_mode "$tools_root/$directory" 700
done
for relative_path in $tool_paths; do
  require_mode "$tools_root/$relative_path" 500
done

created=0
trap - EXIT HUP INT TERM
`;
};

export type RuntimeToolsMaterializationOptions = {
  /** Override only for tests that construct a release fixture. */
  sourceRoot?: string;
};

export const sessionConfigBaselineRoot = defaultSessionConfigBaselineRoot;

const sessionConfigParent = async (): Promise<string> => {
  const parent = join(await realpath(tmpdir()), "agentos-session-config");
  await mkdir(parent, { recursive: true, mode: 0o711 });
  await chmod(parent, 0o711);
  return parent;
};

const sessionConfigPath = async (sessionId: string): Promise<string> => {
  if (!/^[A-Za-z0-9_-]+$/u.test(sessionId)) throw new Error(`Invalid session id for CLI config root: ${sessionId}`);
  return join(await sessionConfigParent(), sessionId, "config");
};

export const sessionConfigRootExists = async (scratch: AgentScratch): Promise<boolean> => {
  try {
    const info = await lstat(scratch.configRoot);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/**
 * A per-run disposable root for anything *inside* the run that resolves a
 * workspace root or a control-plane state dir from the environment.
 *
 * Both 2026-08-18 workspace-wipe incidents were replays of a bug that master
 * had already fixed: the runs executed checkouts pinned to older bases, whose
 * code still defaulted to the production ~/.agentos/runs and swept it. A
 * default lives in the checkout, which the runner cannot fix retroactively;
 * the environment lives in the runner, which always runs current code. So the
 * runner hands every session a throwaway root instead, and no base — however
 * old — can resolve its way back to production state.
 *
 * The runner-owned directories are siblings rather than nested: the control
 * plane refuses a state dir that overlaps its workspace root, and the tools
 * bundle must stay outside every project checkout. The base is realpath'd
 * because the control plane also refuses aliased paths and symlinked path
 * components (on macOS os.tmpdir() sits under /var -> /private/var).
 */
export const provisionAgentScratch = async (config: RunnerConfig, sessionId = `anonymous-${randomUUID()}`): Promise<AgentScratch> => {
  const temporaryRoot = await realpath(tmpdir());
  const run = workspaceCommands(config, temporaryRoot);
  const base = config.runAsPrefix.length > 0
    ? await realpath((await run(
      "/usr/bin/mktemp",
      ["-d", join(temporaryRoot, "agentos-run-scratch-XXXXXX")],
    )).trim())
    : await realpath(await mkdtemp(join(temporaryRoot, "agentos-run-scratch-")));
  const workspaceRoot = join(base, "workspaces");
  const stateDir = join(base, "control-plane");
  const toolsDir = join(base, "tools");
  // Deliberately name the root before it exists. If baseline or auth seeding
  // fails, the caller can report and retain the exact path it attempted.
  const configRoot = await sessionConfigPath(sessionId);
  if (config.runAsPrefix.length > 0) {
    // The session runs as another principal, so it creates and owns the 0700
    // base as well as both roots below it. No cross-account writable or
    // traversable scratch directory is left behind.
    try {
      await run("/bin/chmod", ["700", base]);
      // Node enters the bound directory before it execs the run-as launcher.
      // The daemon cannot enter the target principal's 0700 base, so this
      // runner stays bound to the shared temp root and lets the launched
      // principal mutate the absolute child paths.
      await run("/bin/mkdir", ["-m", "700", workspaceRoot, stateDir]);
    } catch (error: unknown) {
      await run("/bin/rm", ["-rf", "--", base]).catch(() => undefined);
      throw error;
    }
  } else {
    for (const directory of [workspaceRoot, stateDir]) {
      await mkdir(directory);
      // Exactly 0700, whatever the umask: the control plane rejects any other
      // mode on its state dir.
      await chmod(directory, 0o700);
    }
  }
  return { base, workspaceRoot, stateDir, toolsDir, configRoot };
};

/**
 * Copy the release-local regression bundle into the run's disposable scratch.
 *
 * The copy is intentionally one command rather than a collection of runner
 * writes. Under RUNNER_RUN_AS_PREFIX every write therefore runs as the
 * launched account, and a failed copy/chmod can remove only the destination it
 * created. The source is never inferred from the project checkout.
 */
export const materializeRuntimeTools = async (
  config: RunnerConfig,
  scratch: AgentScratch,
  options: RuntimeToolsMaterializationOptions = {},
): Promise<void> => {
  const sourceRoot = options.sourceRoot ?? runtimeToolsSourceRoot;
  // A prefixed command changes identity only after Node has entered the bound
  // directory. The target-owned 0700 base is therefore valid as an argument,
  // but not as the directory the daemon launches the command from.
  const commandCwd = config.runAsPrefix.length > 0 ? await realpath(tmpdir()) : scratch.base;
  await workspaceCommands(config, commandCwd)(
    "/bin/sh",
    ["-c", runtimeToolsMaterializationScript(), "agentos-runtime-tools", sourceRoot, scratch.toolsDir],
  );
};

export const cleanupAgentScratch = async (
  config: RunnerConfig,
  scratch: AgentScratch,
  options: { retainConfigRoot?: boolean } = {},
): Promise<void> => {
  const configParent = dirname(scratch.configRoot);
  if (config.runAsPrefix.length > 0) {
    const targetOwnedRoots = [
      scratch.workspaceRoot,
      scratch.stateDir,
      scratch.toolsDir,
      ...(options.retainConfigRoot ? [] : [scratch.configRoot]),
    ];
    await workspaceCommands(config, await realpath(tmpdir()))(
      "/bin/sh",
      [
        "-c",
        'for root do [ ! -e "$root" ] || rm -rf -- "$root"; done',
        "agentos-cleanup",
        ...targetOwnedRoots,
        scratch.base,
      ],
    );
    if (!options.retainConfigRoot) await rm(configParent, { recursive: true, force: true });
  } else {
    await Promise.all([
      rm(scratch.workspaceRoot, { recursive: true, force: true }),
      rm(scratch.stateDir, { recursive: true, force: true }),
      rm(scratch.toolsDir, { recursive: true, force: true }),
      ...(options.retainConfigRoot ? [] : [rm(scratch.configRoot, { recursive: true, force: true })]),
    ]);
    if (!options.retainConfigRoot) await rm(configParent, { recursive: true, force: true });
  }
  if (config.runAsPrefix.length === 0) await rm(scratch.base, { recursive: true, force: true });
};

export const provisionSessionConfig = async (
  config: RunnerConfig,
  runner: RunnerKind,
  scratch: AgentScratch,
  options: SessionConfigOptions = {},
): Promise<void> => RUNNER_DEFINITIONS[runner].provisionSessionConfig(config, scratch, options);

export const provisionWorkspace = async (
  config: RunnerConfig,
  claim: WorkspaceProvisionClaim,
  provisioning: DependencyProvisioningDecision,
  dependencies: ProvisionWorkspaceDependencies = {},
): Promise<Workspace> => {
  const retryOptions = dependencies.retryOptions ?? {};
  const dependencyCacheOptions = dependencies.dependencyCacheOptions ?? {};
  const mirrorOptions = dependencies.mirrorOptions ?? {};
  const root = resolve(config.workspaceRoot);
  const workspace = resolve(root, claim.run.id);
  if (!inside(root, workspace)) throw new Error("Resolved workspace escaped the controlled root");
  const run = dependencies.run ?? workspaceCommands(config, root);
  const inWorkspace = commandRunnerIn(run, workspace);
  if (config.runAsPrefix.length > 0) {
    const rootInfo = await stat(root);
    if (!rootInfo.isDirectory()) throw new Error("RUNNER_WORKSPACE_ROOT is not a directory");
    // 0711, created through the prefix so the launched account owns it.
    //
    // Not 0700: node applies a child's `cwd` by chdir-ing in the forked child
    // *before* exec, so it runs as the daemon's uid, not the launched one. A
    // 0700 run directory would make every later spawn that works inside the
    // workspace — the CLI itself, capture, delivery — fail with EACCES before
    // the prefix ever ran.
    //
    // What 0711 buys is that a sibling account cannot enumerate the tree. It
    // does not make the checkout secret: files git writes are world-readable
    // and the paths are guessable. The boundary that matters for #117 is the
    // sticky workspace root, which is what stops one account unlinking or
    // renaming another's run directory; the session token is protected by its
    // own 0600 mode, and CLI credentials by the per-account home.
    await run("/bin/sh", ["-c", 'mkdir "$1"; chmod 711 "$1"', "agentos-workspace", workspace]);
  } else {
    await mkdir(root, { recursive: true, mode: 0o750 });
    await mkdir(workspace, { recursive: false, mode: 0o750 });
  }
  try {
    const identity = await resolveRunnerGitIdentity(config, run);
    const target = claim.run.targetBranch ?? claim.repo.defaultBranch;
    // The control plane declares the head at Run birth (`resolveRunBranches` in
    // @anneal/db). A claim without one is a Run that cannot publish, and
    // inventing a name here is what let two processes disagree about which ref
    // a retry owns.
    const branch = claim.run.branch;
    if (branch === null) throw new Error(`Claimed run ${claim.run.id} carries no publish head`);
    const pinnedBaseSha = claim.run.pinnedBaseSha;
    // Dependencies are materialised after the mirror lock is released: `npm ci`
    // is bounded in half-hours, and holding a machine-wide lock across it would
    // serialise every other run on the host behind an install that never
    // touches the mirror.
    //
    // The mirror belongs to the account that runs the task, and `root` is what
    // the daemon can chdir into before the run-as prefix takes over.
    const provisioned = await withRepoMirror(
      config,
      claim.repo.remoteUrl,
      run,
      { fetchRetryOptions: retryOptions, ...mirrorOptions },
      async (mirror): Promise<Workspace> => {
        if (pinnedBaseSha) {
          const implementationBaseSha = claim.run.implementationBaseSha;
          if (!implementationBaseSha || claim.run.implementationHeadSha !== pinnedBaseSha) {
            throw new Error(`Pinned run ${claim.run.id} is missing its immutable implementation range`);
          }
          // A branch clone would advertise and fetch the shared chain ref before
          // a blind reviewer starts. Build an empty repository, fetch the
          // immutable implementation range endpoints by object id, and stay
          // detached at its head. With no fetch of the chain branch, successor
          // commits and their report artifacts are not reachable from this
          // object database — and fetching by object id keeps that true when the
          // source is the mirror, which does carry the chain ref: a fetch
          // transfers only what the requested objects reach, never the mirror's
          // other refs.
          //
          // What this has never been is a sandbox. The mirror sits in the
          // reviewer's own account home, and the reviewer could already fetch
          // the chain ref straight from GitHub: no runtime reads
          // Environment.networking, and a session is not isolated from other
          // processes of its own user (see api/src/onboarding.ts). The property
          // is that provisioning does not *hand* a blind reviewer its
          // predecessor's report, and that is what the object-id fetch keeps.
          await ensureMirrorRevisions(run, mirror, [implementationBaseSha, pinnedBaseSha], retryOptions);
          await inWorkspace("git", ["init"]);
          const commitHooksPath = await configureWorkspaceGit(claim, workspace, identity, inWorkspace);
          await inWorkspace("git", ["remote", "add", "origin", claim.repo.remoteUrl]);
          // Local transport: slow on a large range, but it cannot hang on a
          // network that is no longer in the path, so it carries no ceiling.
          await inWorkspace("git", ["fetch", "--no-tags", mirror, implementationBaseSha, pinnedBaseSha]);
          await inWorkspace("git", ["checkout", "--detach", pinnedBaseSha]);
          const baseSha = await inWorkspace("git", ["rev-parse", "HEAD"]);
          if (baseSha !== pinnedBaseSha) {
            throw new Error(`Pinned workspace resolved ${baseSha}, expected ${pinnedBaseSha}`);
          }
          return { path: workspace, branch, baseSha, pinnedBaseSha, ...(commitHooksPath ? { commitHooksPath } : {}) };
        }
        // The publication ACK is fenced and immediate, but no database protocol
        // can eliminate a crash between the remote accepting git push and that
        // ACK. When the run's intended head already exists remotely, clone that
        // durable truth instead of the stale fallback base. Derived chain heads
        // are unique per project+chain, so this cannot accidentally adopt
        // another chain.
        //
        // The mirror was pruned against the remote moments ago, so its refs are
        // the same answer `git ls-remote` used to make a round trip for.
        let cloneTarget = target;
        if (branch !== target && !claim.run.targetBranchPublished
          && await mirrorHasBranch(run, mirror, branch)) {
          cloneTarget = branch;
        }
        if (!await mirrorHasBranch(run, mirror, cloneTarget)) {
          // The mirror was pruned against the remote moments ago, so this is the
          // remote's answer, not a mirror fault: the branch the run was told to
          // start from does not exist.
          throw new Error(`Branch ${cloneTarget} is absent from ${claim.repo.remoteUrl}`);
        }
        // Local clone: git hardlinks the object database instead of copying it,
        // which is what turns a two-minute transfer into a disk operation. The
        // hardlinks survive the mirror repacking later, because unlinking a
        // packfile the workspace also links does not free it. Where the kernel
        // refuses the link — Linux protected_hardlinks, with the mirror owned by
        // the daemon and the clone running as another account — git copies the
        // file instead. That is still local disk, and still not the remote.
        await run("git", ["clone", "--branch", cloneTarget, "--single-branch", mirror, workspace]);
        const commitHooksPath = await configureWorkspaceGit(claim, workspace, identity, inWorkspace);
        // Delivery pushes to `origin`; the mirror is a provisioning detail and
        // must never become the run's publication target.
        await inWorkspace("git", ["remote", "set-url", "origin", claim.repo.remoteUrl]);
        // `clone --single-branch` writes one fetch refspec, covering only the
        // branch it cloned. When that branch is the run's own published head,
        // nothing in the workspace resolves `origin/<target>`: an agent asking
        // for the merge base against its baseline gets `unknown revision`, and
        // `git fetch origin <target>` cannot repair it because the refspec that
        // would create the remote-tracking ref is not there. Add it, then fill
        // it from the mirror so the ref exists before the agent starts.
        if (cloneTarget !== target) {
          const targetRefspec = `+refs/heads/${target}:refs/remotes/origin/${target}`;
          await inWorkspace("git", ["config", "--add", "remote.origin.fetch", targetRefspec]);
          await inWorkspace("git", ["fetch", "--no-tags", mirror, targetRefspec]);
        }
        const baseSha = await inWorkspace("git", ["rev-parse", "HEAD"]);
        if (branch !== cloneTarget) await inWorkspace("git", ["switch", "-c", branch]);
        return { path: workspace, branch, baseSha, ...(commitHooksPath ? { commitHooksPath } : {}) };
      },
    );
    const materialized = await materializePreparedSpecification(
      claim.specificationMaterialization,
      provisioned,
      inWorkspace,
    );
    // The decision was made when the claim was admitted; provisioning does not
    // re-read the template step or the repository policy.
    if (provisioning.provision) {
      await materializeWorkspaceDependencies(config, workspace, inWorkspace, dependencyCacheOptions);
    }
    return materialized;
  } catch (error: unknown) {
    await cleanupWorkspace(config, workspace).catch(() => undefined);
    throw error;
  }
};

export const reuseWorkspace = async (config: RunnerConfig, claim: WorkspaceReuseClaim): Promise<Workspace> => {
  if (!claim.run.workspacePath || !claim.run.branch || !claim.run.baseSha) throw new Error("Resumed Run is missing workspace metadata");
  const root = resolve(config.workspaceRoot);
  const workspace = resolve(claim.run.workspacePath);
  if (!inside(root, workspace)) throw new Error("Resumed workspace escaped the controlled root");
  const info = await stat(workspace);
  if (!info.isDirectory()) throw new Error("Resumed workspace is not a directory");
  const run = workspaceCommands(config, workspace);
  const identity = await resolveRunnerGitIdentity(config, run);
  const commitHooksPath = await configureWorkspaceGit(claim, workspace, identity, run);
  return {
    path: workspace,
    branch: claim.run.branch,
    baseSha: claim.run.baseSha,
    ...(claim.run.pinnedBaseSha ? { pinnedBaseSha: claim.run.pinnedBaseSha } : {}),
    ...(commitHooksPath ? { commitHooksPath } : {}),
  };
};

/**
 * Session credentials for the Anneal MCP server, written per claim because the
 * session token and fencing token are reissued on every claim.
 *
 * They live in a 0600 file rather than only in the child environment because
 * codex spawns MCP servers with a scrubbed environment. The file is inside the
 * throwaway workspace, so it dies with it; git is told to ignore it locally so
 * an agent running `git add -A` cannot commit it.
 */
export const writeSessionCredentials = async (
  config: Pick<RunnerConfig, "apiUrl" | "path" | "home" | "runAsPrefix">,
  claim: Pick<ClaimedTask, "sessionToken" | "fencingToken"> & { run: Pick<ClaimedTask["run"], "id"> },
  workspace: Workspace,
): Promise<string> => {
  const directory = join(workspace.path, ".agentos");
  const path = join(directory, "session.json");
  const exclude = join(workspace.path, ".git", "info", "exclude");
  const payload = JSON.stringify({
    apiUrl: config.apiUrl,
    runId: claim.run.id,
    sessionToken: claim.sessionToken,
    fencingToken: claim.fencingToken,
    workspacePath: workspace.path,
  });
  if (config.runAsPrefix.length > 0) {
    // Under a run-as prefix the workspace tree belongs to the launched account:
    // this uid can neither create the directory nor leave the MCP server a 0600
    // file it is able to read. Writing through the prefix is what makes the
    // file's owner and its reader the same account. `umask 077` closes the
    // window in which the token would exist under the default 0644.
    const run = workspaceCommands(config, workspace.path);
    await run("/bin/sh", ["-c", 'umask 077; mkdir -p "$1"; chmod 700 "$1"', "agentos-credentials", directory]);
    await run("/bin/sh", ["-c", 'umask 077; cat > "$1"; chmod 600 "$1"', "agentos-credentials", path], { input: payload });
    await run("/bin/sh", ["-c", 'cat >> "$1"', "agentos-credentials", exclude], { input: "\n/.agentos/\n" }).catch(() => undefined);
    return path;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, payload, { mode: 0o600 });
  await appendFile(exclude, "\n/.agentos/\n").catch(() => undefined);
  return path;
};

export const captureWorkspaceResult = async (
  config: RunnerConfig,
  workspace: Workspace,
): Promise<{ branch: string; baseSha: string; headSha: string }> => {
  const run = workspaceCommands(config, workspace.path);
  const branch = workspace.pinnedBaseSha
    ? workspace.branch
    : await run("git", ["branch", "--show-current"]);
  const headSha = await run("git", ["rev-parse", "HEAD"]);
  return { branch, baseSha: workspace.baseSha, headSha };
};

export type WorkspaceSnapshot = {
  headSha: string;
  status: string;
  trackedDiff: string;
  untrackedFiles: Array<{ path: string; objectId: string }>;
};

/** Capture enough of HEAD, the index and the working tree to prove that a
 * runner-owned continuation did not mutate the deliverable it was asked only
 * to describe. Untracked contents are hashed separately because `git diff`
 * does not include them. */
export const captureWorkspaceSnapshot = async (
  config: RunnerConfig,
  workspace: Workspace,
): Promise<WorkspaceSnapshot> => {
  const run = workspaceCommands(config, workspace.path);
  const [headSha, status, trackedDiff, untrackedOutput] = await Promise.all([
    run("git", ["rev-parse", "HEAD"]),
    run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    run("git", ["diff", "--binary", "HEAD", "--"]),
    run("git", ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  const untrackedPaths = untrackedOutput.split("\0").filter(Boolean);
  const untrackedFiles = await Promise.all(untrackedPaths.map(async (path) => ({
    path,
    objectId: await run("git", ["hash-object", "--", path]),
  })));
  return { headSha, status, trackedDiff, untrackedFiles };
};

export const cleanupWorkspace = async (
  config: RunnerConfig,
  workspacePath: string,
): Promise<void> => {
  const root = resolve(config.workspaceRoot);
  const workspace = resolve(workspacePath);
  if (!inside(root, workspace) || workspace === root) throw new Error("Refusing to clean a path outside the controlled workspace root");
  if (config.runAsPrefix.length > 0) {
    await workspaceCommands(config, root)("/bin/rm", ["-rf", "--", workspace]);
  } else {
    await rm(workspace, { recursive: true, force: true });
  }
};
