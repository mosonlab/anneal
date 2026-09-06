import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";

import { RUNTIME_TOOL_FILES, expectedDirectoryEntries } from "../../packages/runner/scripts/build-runtime-tools.mjs";

import {
  DEPLOY_OPTIONAL_ARTIFACT_PATHS,
  DEPLOY_REQUIRED_ARTIFACT_PATHS,
  deployReleaseArtifactPaths,
  workspaceDependencyPaths,
} from "./release-artifacts.mjs";
import { assembleReleaseDirectory, verifyReleaseDirectory } from "./release-directory.mjs";
import { DeployFailure } from "./quiet-window-lib.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const RELEASE = /^(?<commit>[0-9a-f]{40})-(?<digest>[0-9a-f]{64})$/u;
const RELEASE_ARTIFACT_SCRIPT = "scripts/deploy/release-artifact.mjs";
const RUNTIME_TOOL_ROOT = "packages/runner/dist/runtime-tools";

const CLONE_ATTEMPT_LIMIT = 3;
const CLONE_RETRY_DELAYS_MS = Object.freeze([2_000, 8_000]);
// GitHub from the deploy host is intermittently flaky. Retry only the
// transport shapes that a later attempt can plausibly clear.
const TRANSIENT_CLONE_STDERR = Object.freeze([
  /gnutls_handshake\(\) failed/iu,
  /\bTLS connection\b/iu,
  /connection reset by peer/iu,
  /could not resolve host/iu,
]);

const fail = (reason, detail) => {
  throw new DeployFailure(reason, detail);
};

const require = createRequire(import.meta.url);

const runtimeFailure = (detail) => fail("release-artifact-runtime-incomplete", detail);

const runtimeToolStatus = (releaseDirectory, relativePath) => {
  const path = join(releaseDirectory, relativePath);
  let status;
  try {
    status = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") runtimeFailure(`${relativePath}-missing`);
    runtimeFailure(`${relativePath}-unreadable`);
  }
  return { path, status };
};

const assertRuntimeToolDirectory = (releaseDirectory, relativePath) => {
  const { status } = runtimeToolStatus(releaseDirectory, relativePath);
  if (status.isSymbolicLink() || !status.isDirectory()) runtimeFailure(`${relativePath}-not-a-directory`);
  return status;
};

const assertRuntimeToolFile = (releaseDirectory, relativePath) => {
  const { status } = runtimeToolStatus(releaseDirectory, relativePath);
  if (status.isSymbolicLink() || !status.isFile()) runtimeFailure(`${relativePath}-not-a-regular-file`);
  return status;
};

const sortedEntryNames = (path) => readdirSync(path, { withFileTypes: true }).map(({ name }) => name).sort();

const assertRuntimeToolInventory = (releaseDirectory) => {
  const runtimeRoot = join(releaseDirectory, RUNTIME_TOOL_ROOT);
  assertRuntimeToolDirectory(releaseDirectory, RUNTIME_TOOL_ROOT);
  for (const [directory, expectedNames] of expectedDirectoryEntries()) {
    const relativeDirectory = directory ? `${RUNTIME_TOOL_ROOT}/${directory}` : RUNTIME_TOOL_ROOT;
    const directoryPath = join(releaseDirectory, relativeDirectory);
    if (directory) assertRuntimeToolDirectory(releaseDirectory, relativeDirectory);
    const observedNames = sortedEntryNames(directoryPath);
    const expected = [...expectedNames].sort();
    if (JSON.stringify(observedNames) !== JSON.stringify(expected)) {
      runtimeFailure(`${relativeDirectory}-inventory-mismatch`);
    }
  }
  for (const { destination } of RUNTIME_TOOL_FILES) {
    assertRuntimeToolFile(releaseDirectory, `${RUNTIME_TOOL_ROOT}/${destination}`);
  }

  // Runtime tools are runner-owned. Reject another runtime-tools component or
  // a symlink alias to the canonical tree, without treating an unrelated file
  // that happens to share a generic basename (such as lib.sh) as tooling.
  const canonicalRuntimeRoot = realpathSync(runtimeRoot);
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relativePath === RUNTIME_TOOL_ROOT) continue;
      if (relativePath.split("/").includes("runtime-tools")) runtimeFailure(`misplaced-${relativePath}`);
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = realpathSync(entryPath);
        if (resolved === canonicalRuntimeRoot || resolved.startsWith(`${canonicalRuntimeRoot}${sep}`)) {
          runtimeFailure(`misplaced-${relativePath}`);
        }
      }
      // Dependency trees are independent artifacts and cannot be a runner
      // bundle destination. Avoid turning their size or basenames into deploy
      // verification inputs.
      if (entry.isDirectory() && entry.name !== "node_modules") walk(entryPath, relativePath);
    }
  };
  walk(releaseDirectory, "");
  return Object.freeze({
    root: runtimeRoot,
    files: Object.freeze(RUNTIME_TOOL_FILES.map(({ destination }) => `${RUNTIME_TOOL_ROOT}/${destination}`)),
  });
};

const maintenanceSourceImports = (releaseDirectory) => {
  const prismaRoot = join(releaseDirectory, "packages/db/prisma");
  const sourceRoot = join(releaseDirectory, "packages/db/src");
  if (!existsSync(prismaRoot) || lstatSync(prismaRoot).isSymbolicLink() || !lstatSync(prismaRoot).isDirectory()) {
    fail("release-artifact-runtime-incomplete", "packages/db/prisma-missing");
  }
  if (!existsSync(sourceRoot) || lstatSync(sourceRoot).isSymbolicLink() || !lstatSync(sourceRoot).isDirectory()) {
    fail("release-artifact-runtime-incomplete", "packages/db/src-missing");
  }
  const imports = new Set();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(/\bfrom\s+["']\.\.\/src\/(?<module>[^"']+)\.js["']/gu)) {
          imports.add(match.groups.module);
        }
      }
    }
  };
  visit(prismaRoot);
  for (const imported of imports) {
    if (imported.split("/").some((component) => component === ".." || component === "")) {
      fail("release-artifact-runtime-incomplete", "packages/db/src-import-invalid");
    }
    const sourcePath = join(sourceRoot, `${imported}.ts`);
    if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
      fail("release-artifact-runtime-incomplete", `packages/db/src/${imported}.ts-missing`);
    }
  }
  return Object.freeze([...imports].sort());
};

const validatedReleaseArtifact = ({ deployRoot, revision, releaseName }) => {
  if (!SHA.test(revision ?? "")) fail("release-artifact-invalid", "target-commit-invalid");
  const identity = RELEASE.exec(releaseName ?? "")?.groups;
  if (!identity || identity.commit !== revision) fail("release-artifact-invalid", "release-name-target-mismatch");
  const releaseDirectory = join(deployRoot, "releases", releaseName);
  if (!existsSync(releaseDirectory)) fail("release-artifact-missing", releaseName);
  const status = lstatSync(releaseDirectory);
  if (status.isSymbolicLink() || !status.isDirectory()) fail("release-artifact-invalid", "release-path-not-directory");
  return Object.freeze({ deployRoot, revision, releaseName, releaseDirectory, digest: identity.digest });
};

const verifyReleaseIntegrity = ({ releaseDirectory, revision, digest }) => {
  try {
    return verifyReleaseDirectory({ releaseDirectory, revision, digest });
  } catch (error) {
    if (error instanceof DeployFailure && error.reason === "release-digest-mismatch") {
      fail("release-artifact-digest-mismatch", error.detail);
    }
    throw error;
  }
};

const verifyReleaseArtifactContents = (artifact) => {
  const verified = verifyReleaseIntegrity(artifact);
  const dbMaintenanceSourceImports = maintenanceSourceImports(verified.releaseDirectory);
  const runtimeTools = assertRuntimeToolInventory(verified.releaseDirectory);
  return Object.freeze({
    ...verified,
    releaseDirectoryIdentity: verified.releaseName,
    buildStamp: verified.apiBuildStamp,
    dbMaintenanceSourceImports,
    runtimeTools,
  });
};

const loadTargetVerifier = (root) => {
  const verifierPath = join(root, RELEASE_ARTIFACT_SCRIPT);
  let status;
  try {
    status = lstatSync(verifierPath);
  } catch (error) {
    if (error?.code === "ENOENT") fail("release-artifact-invalid", "target-verifier-missing");
    fail("release-artifact-invalid", `target-verifier-${error?.code ?? "unreadable"}`);
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    fail("release-artifact-invalid", "target-verifier-not-a-regular-file");
  }
  let targetModule;
  try {
    targetModule = require(verifierPath);
  } catch (error) {
    fail("release-artifact-invalid", `target-verifier-${error?.code ?? "unreadable"}`);
  }
  if (typeof targetModule?.verifyReleaseArtifact !== "function") {
    fail("release-artifact-invalid", "target-verifier-export-missing");
  }
  return targetModule.verifyReleaseArtifact;
};

const normalizeTargetVerifierFailure = (error) => {
  if (error instanceof DeployFailure) return error;
  if (error?.name === "DeployFailure" && typeof error.reason === "string") {
    return new DeployFailure(
      error.reason,
      typeof error.detail === "string" ? error.detail : String(error.detail ?? ""),
    );
  }
  return error;
};

/**
 * Verify an artifact with the verifier shipped by the artifact's target
 * commit. The deployed process starts from `current`, so its own module may
 * describe an older runtime-tool inventory. `useTargetVerifier: false` is an
 * internal handoff flag used by the target module to run its local verifier
 * after this loader has selected it.
 */
export const verifyReleaseArtifact = (options = {}) => {
  const validated = validatedReleaseArtifact(options);
  if (options.useTargetVerifier !== false) {
    // The target verifier is executable code inside the artifact on reuse and
    // activation paths. Authenticate the complete finalized tree before
    // importing that code so tampering cannot bypass the release boundary.
    verifyReleaseIntegrity(validated);
    const verifier = loadTargetVerifier(options.verifierRoot ?? validated.releaseDirectory);
    if (verifier !== verifyReleaseArtifact) {
      try {
        return verifier({
          deployRoot: validated.deployRoot,
          revision: validated.revision,
          releaseName: validated.releaseName,
          useTargetVerifier: false,
        });
      } catch (error) {
        throw normalizeTargetVerifierFailure(error);
      }
    }
  }
  return verifyReleaseArtifactContents(validated);
};

export const findReleaseArtifact = ({ deployRoot, revision }) => {
  if (!SHA.test(revision ?? "")) fail("release-artifact-invalid", "target-commit-invalid");
  const releasesRoot = join(deployRoot, "releases");
  if (!existsSync(releasesRoot)) fail("release-artifact-missing", revision);
  const matches = readdirSync(releasesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${revision}-`))
    .map((entry) => entry.name)
    .sort();
  if (matches.length === 0) fail("release-artifact-missing", revision);
  if (matches.length !== 1) fail("release-artifact-ambiguous", `target-${revision}-matches-${matches.length}`);
  return verifyReleaseArtifact({ deployRoot, revision, releaseName: matches[0] });
};

const run = (program, args, options = {}) => {
  const { reason, captureStderr, ...spawnOptions } = options;
  try {
    if (captureStderr) {
      const result = spawnSync(program, args, {
        stdio: ["inherit", "inherit", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
        ...spawnOptions,
      });
      if (result.error || result.status !== 0) throw result;
      if (result.stderr) process.stderr.write(result.stderr);
      return result.stdout;
    }
    return execFileSync(program, args, { stdio: "inherit", ...spawnOptions });
  } catch (error) {
    // Captured stderr still belongs in the operator's log; classification is a
    // second reader of it, not its owner.
    if (captureStderr && error?.stderr) process.stderr.write(error.stderr);
    const failure = new DeployFailure(
      reason ?? "release-artifact-build-failed",
      error?.status === undefined ? "command-failed" : `exit-${error.status}`,
    );
    failure.status = error?.status;
    failure.stderr = error?.stderr;
    throw failure;
  }
};

const isTransientCloneFailure = (error) => {
  if (error?.status !== 128) return false;
  const stderr = typeof error?.stderr === "string" ? error.stderr : error?.stderr?.toString("utf8") ?? "";
  return TRANSIENT_CLONE_STDERR.some((pattern) => pattern.test(stderr));
};

const sleepSync = (milliseconds) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

/** Clone the release source, retrying a network-shaped git failure. Returns
 * the number of attempts made; the last failure escalates unchanged. */
const cloneSource = ({ execute, gitBinary, sourceRemote, buildRoot, sleep }) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      execute(gitBinary, ["clone", "--no-checkout", "--filter=blob:none", sourceRemote, buildRoot], {
        reason: "release-artifact-source-unavailable",
        captureStderr: true,
      });
      return attempt;
    } catch (error) {
      if (attempt >= CLONE_ATTEMPT_LIMIT || !isTransientCloneFailure(error)) throw error;
      sleep(CLONE_RETRY_DELAYS_MS[attempt - 1]);
      // A failed clone can leave a partial tree behind, and git refuses a
      // non-empty destination.
      rmSync(buildRoot, { recursive: true, force: true });
      mkdirSync(buildRoot, { recursive: true, mode: 0o700 });
    }
  }
};

export const buildReleaseArtifact = ({
  deployRoot,
  revision,
  sourceRemote,
  gitBinary,
  nodeBinary,
  npmBinary,
  execute = run,
  sleep = sleepSync,
  assemble = assembleReleaseDirectory,
  verify = verifyReleaseArtifact,
  requiredPaths = DEPLOY_REQUIRED_ARTIFACT_PATHS,
  artifactPaths = deployReleaseArtifactPaths,
  optionalArtifactPaths = (root) => [...DEPLOY_OPTIONAL_ARTIFACT_PATHS, ...workspaceDependencyPaths(root)],
}) => {
  if (!SHA.test(revision ?? "")) fail("release-artifact-build-refused", "target-commit-invalid");
  if (typeof sourceRemote !== "string" || sourceRemote.length === 0) fail("release-artifact-build-refused", "source-remote-missing");
  try {
    return Object.freeze({ ...findReleaseArtifact({ deployRoot, revision }), cloneAttempts: 0 });
  } catch (error) {
    if (!(error instanceof DeployFailure) || error.reason !== "release-artifact-missing") throw error;
  }

  const stateRoot = join(deployRoot, ".agentos-deploy");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const buildRoot = mkdtempSync(join(stateRoot, "artifact-build-"));
  try {
    const cloneAttempts = cloneSource({ execute, gitBinary, sourceRemote, buildRoot, sleep });
    execute(gitBinary, ["-C", buildRoot, "checkout", "--detach", revision], {
      reason: "release-artifact-source-unavailable",
    });
    execute(nodeBinary, [npmBinary, "ci"], { cwd: buildRoot, reason: "release-artifact-dependencies-failed" });
    execute(nodeBinary, [npmBinary, "run", "build"], { cwd: buildRoot, reason: "release-artifact-build-failed" });
    for (const path of requiredPaths) {
      if (!existsSync(join(buildRoot, path))) fail("release-artifact-output-missing", path);
    }
    const result = assemble({
      stageRoot: buildRoot,
      deployRoot,
      revision,
      artifactPaths: artifactPaths(buildRoot),
      optionalArtifactPaths: optionalArtifactPaths(buildRoot),
      retention: false,
      probeImmutability: true,
    });
    return Object.freeze({
      ...verify({
        deployRoot,
        revision,
        releaseName: result.releaseName,
        verifierRoot: buildRoot,
      }),
      cloneAttempts,
    });
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }
};
