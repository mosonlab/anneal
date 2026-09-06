import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import type { RunnerConfig } from "./config.js";
import {
  CACHE_ENTRY_FORMAT, DependencyCacheIntegrityError, assertCacheTargetPath, describeTargetTrees, openCacheEntryStore,
  type CacheEntryDocument, type CacheEntryExpectation, type CacheEntryInput, type CacheEntryStore,
  type CacheEntryTarget, type DependencyCacheToolchain,
} from "./dependency-cache-store.js";
import { commandRunnerIn, type CommandRunner } from "./exec.js";
import {
  NPM_INSTALL_COMMAND_TIMEOUT_MS, NPM_INSTALL_OPERATION_BUDGET_MS, runWithNetworkRetry, type RetryOptions,
} from "./network-retry.js";

const NPM_PROBE_TIMEOUT_MS = 10_000;

type DependencyProject = {
  inputs: CacheEntryInput[];
  targets: string[];
  nativeWorkspaces: string[];
  inputMissCondition?: string;
};

export type DependencyCacheProgress = {
  event: "hit" | "miss" | "publication" | "integrity-refusal" | "eviction" | "phase" | "elapsed";
  key?: string;
  condition?: string;
  elapsedMs?: number;
  phase?: "identity" | "validate" | "restore" | "rebuild" | "install" | "publish" | "retention";
};

export type DependencyCacheOptions = {
  cacheRoot?: string;
  toolchain?: DependencyCacheToolchain;
  installRetryOptions?: RetryOptions;
  report?: (progress: DependencyCacheProgress) => void;
};

export type DependencyCacheResult = {
  status: "restored" | "installed";
  key?: string;
  condition?: string;
};

// A required input is missing, so the workspace has no cache identity. The
// targets ride along because the caller's only remaining move is to install
// them uncached.
export class DependencyCacheInputMissError extends Error {
  constructor(readonly condition: string, readonly targets: string[]) {
    super(`Dependency cache miss: ${condition}`);
    this.name = "DependencyCacheInputMissError";
  }
}

/**
 * NPM_CI cannot be honoured without a root package manifest. This is a
 * repository-policy failure, not an optional cache miss: installing nothing
 * would let the provider start with an incomplete workspace.
 */
export const DEPENDENCY_PROVISIONING_MANIFEST_MISSING = "dependency-provisioning-manifest-missing" as const;

export class DependencyProvisioningManifestMissingError extends Error {
  readonly condition = DEPENDENCY_PROVISIONING_MANIFEST_MISSING;

  constructor() {
    super(DEPENDENCY_PROVISIONING_MANIFEST_MISSING);
    this.name = "DependencyProvisioningManifestMissingError";
  }
}

// Raised while reading one input, before the target list exists.
class DependencyInputMissSignal extends Error {
  constructor(readonly condition: string) {
    super(`Dependency cache miss: ${condition}`);
    this.name = "DependencyInputMissSignal";
  }
}

const insideOrEqual = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const sha256 = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

const progressReporter = (progress: DependencyCacheProgress): void => {
  console.log(JSON.stringify({ audit: "dependency-cache", ...progress }));
};

const timed = async <T>(
  phase: NonNullable<DependencyCacheProgress["phase"]>,
  report: (progress: DependencyCacheProgress) => void,
  work: () => Promise<T>,
): Promise<T> => {
  const started = Date.now();
  try {
    return await work();
  } finally {
    report({ event: "phase", phase, elapsedMs: Date.now() - started });
  }
};

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const pathKind = async (path: string): Promise<"missing" | "directory" | "file" | "symlink" | "other"> => {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "other";
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
};

const readInput = async (workspace: string, path: string, required: boolean): Promise<CacheEntryInput> => {
  const absolute = resolve(workspace, path);
  if (!insideOrEqual(workspace, absolute)) throw new Error(`Ambiguous dependency input: ${path}`);
  const kind = await pathKind(absolute);
  if (kind === "missing") {
    if (required) throw new DependencyInputMissSignal(`required-input-missing:${path}`);
    return { path, absent: true };
  }
  if (kind !== "file") throw new Error(`Ambiguous dependency input: ${path} is ${kind}`);
  try {
    return { path, sha256: sha256(await readFile(absolute)) };
  } catch (error: unknown) {
    throw new Error(`Unreadable dependency input: ${path}`, { cause: error });
  }
};

const parseJsonObject = (content: string, label: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error: unknown) {
    throw new Error(`Ambiguous dependency input: ${label} is not valid JSON`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Ambiguous dependency input: ${label} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
};

const readJsonObject = async (workspace: string, path: string): Promise<Record<string, unknown>> => {
  const input = await readInput(workspace, path, true);
  if (!("sha256" in input)) throw new Error(`Required dependency input unexpectedly absent: ${path}`);
  return parseJsonObject(await readFile(resolve(workspace, path), "utf8"), path);
};

const workspacePatterns = (rootPackage: Record<string, unknown>): string[] => {
  const declaration = rootPackage.workspaces;
  const patterns = Array.isArray(declaration)
    ? declaration
    : declaration !== null && typeof declaration === "object" && Array.isArray((declaration as { packages?: unknown }).packages)
      ? (declaration as { packages: unknown[] }).packages
      : declaration === undefined ? [] : null;
  if (patterns === null || patterns.some((entry) => typeof entry !== "string")) {
    throw new Error("Ambiguous dependency input: package.json workspaces declaration");
  }
  return patterns as string[];
};

const validateWorkspacePattern = (pattern: string): string[] => {
  if (pattern === "" || pattern.includes("\\") || pattern.startsWith("/") || pattern.endsWith("/")) {
    throw new Error(`Ambiguous workspace pattern: ${pattern}`);
  }
  const segments = pattern.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Ambiguous workspace pattern: ${pattern}`);
  }
  const stars = segments.filter((segment) => segment.includes("*"));
  if (stars.length > 1 || (stars.length === 1 && (segments.at(-1) !== "*" || stars[0] !== "*"))) {
    throw new Error(`Ambiguous workspace pattern: ${pattern}`);
  }
  return segments;
};

const ensureRealDirectory = async (root: string, relativePath: string, label: string): Promise<void> => {
  const absolute = resolve(root, relativePath);
  if (!insideOrEqual(root, absolute)) throw new Error(`${label} escaped its controlled root`);
  const kind = await pathKind(absolute);
  if (kind !== "directory") throw new Error(`${label} is ${kind}`);
  const resolved = await realpath(absolute);
  if (resolved !== absolute) throw new Error(`${label} contains a symlink`);
};

const declaredWorkspaceDirectories = async (
  workspace: string,
  rootPackage: Record<string, unknown>,
): Promise<string[]> => {
  const directories = new Set<string>();
  for (const pattern of workspacePatterns(rootPackage)) {
    const segments = validateWorkspacePattern(pattern);
    if (segments.at(-1) !== "*") {
      const relativePath = posix.join(...segments);
      await ensureRealDirectory(workspace, relativePath, `Workspace package ${relativePath}`);
      directories.add(relativePath);
      continue;
    }
    const parent = posix.join(...segments.slice(0, -1));
    await ensureRealDirectory(workspace, parent, `Workspace parent ${parent}`);
    const children = await readdir(resolve(workspace, parent), { withFileTypes: true });
    for (const child of children) {
      if (child.isSymbolicLink()) throw new Error(`Ambiguous workspace package: ${posix.join(parent, child.name)} is a symlink`);
      if (!child.isDirectory()) continue;
      const relativePath = posix.join(parent, child.name);
      const manifestKind = await pathKind(resolve(workspace, relativePath, "package.json"));
      if (manifestKind === "missing") continue;
      if (manifestKind !== "file") throw new Error(`Ambiguous dependency input: ${relativePath}/package.json is ${manifestKind}`);
      directories.add(relativePath);
    }
  }
  return [...directories].sort();
};

type PackageDefinition = {
  directory: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  name?: string;
};

const INSTALL_LIFECYCLE_SCRIPTS = [
  "preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare",
] as const;

const packageScripts = (pkg: PackageDefinition): Record<string, string> => {
  const scripts = pkg.manifest.scripts;
  if (scripts === undefined) return {};
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new Error(`Ambiguous dependency input: ${pkg.manifestPath} scripts`);
  }
  const result: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") throw new Error(`Ambiguous dependency input: ${pkg.manifestPath} script ${name}`);
    result[name] = command;
  }
  return result;
};

const repositoryPath = (workspace: string, directory: string, referenced: string): string => {
  const unquoted = referenced.replace(/^["']|["']$/gu, "");
  if (unquoted === "" || unquoted.includes("\\") || unquoted.includes("$") || isAbsolute(unquoted)) {
    throw new Error(`Ambiguous Prisma schema input: ${referenced}`);
  }
  const absolute = resolve(workspace, directory, unquoted);
  if (!insideOrEqual(workspace, absolute)) throw new Error(`Prisma schema input escaped the run workspace: ${referenced}`);
  return relative(workspace, absolute).split(sep).join("/");
};

const lifecycleSchemaInputs = async (
  workspace: string,
  packages: PackageDefinition[],
): Promise<Array<{ path: string; required: boolean }>> => {
  const byName = new Map(packages.flatMap((pkg) => pkg.name ? [[pkg.name, pkg] as const] : []));
  const queue: Array<{ pkg: PackageDefinition; name: string }> = packages.flatMap((pkg) => {
    const scripts = packageScripts(pkg);
    return INSTALL_LIFECYCLE_SCRIPTS.filter((name) => scripts[name] !== undefined).map((name) => ({ pkg, name }));
  });
  const visited = new Set<string>();
  const schemas = new Map<string, boolean>();
  const addSchema = (path: string, required: boolean): void => {
    schemas.set(path, required || schemas.get(path) === true);
  };

  while (queue.length > 0) {
    const current = queue.shift()!;
    const visitKey = `${current.pkg.manifestPath}:${current.name}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    const command = packageScripts(current.pkg)[current.name];
    if (command === undefined) throw new Error(`Ambiguous lifecycle script reference: ${visitKey}`);

    const explicit = [...command.matchAll(/--schema(?:=|\s+)([^\s;&|]+)/gu)];
    for (const match of explicit) addSchema(repositoryPath(workspace, current.pkg.directory, match[1]!), true);

    if (/\bprisma\s+(?:generate|migrate|db|validate|format)\b/u.test(command) && explicit.length === 0) {
      const prisma = current.pkg.manifest.prisma;
      const configuredSchema = prisma !== null && typeof prisma === "object" && !Array.isArray(prisma)
        ? (prisma as { schema?: unknown }).schema
        : undefined;
      if (configuredSchema !== undefined && typeof configuredSchema !== "string") {
        throw new Error(`Ambiguous dependency input: ${current.pkg.manifestPath} prisma.schema`);
      }
      if (typeof configuredSchema === "string") {
        addSchema(repositoryPath(workspace, current.pkg.directory, configuredSchema), true);
      } else {
        const defaults = ["prisma/schema.prisma", "schema.prisma"]
          .map((path) => repositoryPath(workspace, current.pkg.directory, path));
        const present: string[] = [];
        for (const path of defaults) if (await pathKind(resolve(workspace, path)) !== "missing") present.push(path);
        if (present.length > 1) throw new Error(`Ambiguous Prisma schema input for ${current.pkg.manifestPath}`);
        if (present.length === 1) addSchema(present[0]!, true);
        else addSchema(defaults[0]!, true);
      }
    }

    for (const match of command.matchAll(/\bnpm\s+run(?:-script)?\s+([^\s;&|]+)([^;&|]*)/gu)) {
      const referencedName = match[1]!;
      const workspaceMatch = /(?:^|\s)(?:-w|--workspace)(?:=|\s+)([^\s;&|]+)/u.exec(match[2] ?? "");
      const referencedPackage = workspaceMatch ? byName.get(workspaceMatch[1]!) : current.pkg;
      if (!referencedPackage) throw new Error(`Ambiguous lifecycle workspace reference: ${workspaceMatch?.[1]}`);
      queue.push({ pkg: referencedPackage, name: referencedName });
    }
  }
  if (schemas.size === 0) return [{ path: "<lifecycle-prisma-schema>", required: false }];
  return [...schemas].map(([path, required]) => ({ path, required })).sort((left, right) => left.path.localeCompare(right.path, "en"));
};

const inspectDependencyProject = async (workspacePath: string): Promise<DependencyProject | null> => {
  const requestedWorkspace = resolve(workspacePath);
  if (await pathKind(requestedWorkspace) !== "directory") throw new Error("Run workspace is not a real directory");
  if ((await lstat(requestedWorkspace)).isSymbolicLink()) throw new Error("Run workspace is a symlink");
  const workspace = await realpath(requestedWorkspace);
  const rootManifestKind = await pathKind(join(workspace, "package.json"));
  if (rootManifestKind === "missing") return null;
  if (rootManifestKind !== "file") throw new Error(`Ambiguous dependency input: package.json is ${rootManifestKind}`);

  const rootPackage = await readJsonObject(workspace, "package.json");
  const packageDirectories = await declaredWorkspaceDirectories(workspace, rootPackage);
  const packages: PackageDefinition[] = [{
    directory: "", manifestPath: "package.json", manifest: rootPackage,
    ...(typeof rootPackage.name === "string" ? { name: rootPackage.name } : {}),
  }];
  for (const directory of packageDirectories) {
    const manifestPath = `${directory}/package.json`;
    const manifest = await readJsonObject(workspace, manifestPath);
    packages.push({
      directory, manifestPath, manifest,
      ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
    });
  }
  const requiredPaths = ["package.json", "package-lock.json", ...packageDirectories.map((path) => `${path}/package.json`)];
  const optionalPaths = [".npmrc", ...packageDirectories.map((path) => `${path}/.npmrc`)];
  const schemaInputs = await lifecycleSchemaInputs(workspace, packages);
  const nativeWorkspaces: string[] = [];
  for (const pkg of packages) {
    const bindingPath = posix.join(pkg.directory, "binding.gyp");
    const kind = await pathKind(resolve(workspace, bindingPath));
    if (kind === "missing") continue;
    if (kind !== "file") throw new Error(`Ambiguous native workspace input: ${bindingPath} is ${kind}`);
    if (!pkg.name) throw new Error(`Native workspace ${pkg.manifestPath} has no package name`);
    nativeWorkspaces.push(pkg.name);
  }
  const inputs: CacheEntryInput[] = [];
  let inputMissCondition: string | undefined;
  for (const { path, required } of [
    ...requiredPaths.map((path) => ({ path, required: true })),
    ...optionalPaths.map((path) => ({ path, required: false })),
    ...schemaInputs,
  ]) {
    try {
      inputs.push(await readInput(workspace, path, required));
    } catch (error: unknown) {
      if (!(error instanceof DependencyInputMissSignal)) throw error;
      inputMissCondition ??= error.condition;
    }
  }
  const lockInput = inputs.find(({ path }) => path === "package-lock.json");
  if (lockInput && "sha256" in lockInput) {
    parseJsonObject(await readFile(join(workspace, "package-lock.json"), "utf8"), "package-lock.json");
  }
  inputs.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    inputs,
    targets: ["node_modules", ...packageDirectories.map((path) => `${path}/node_modules`)],
    nativeWorkspaces,
    ...(inputMissCondition ? { inputMissCondition } : {}),
  };
};

const validatedToolchain = (toolchain: DependencyCacheToolchain): DependencyCacheToolchain => {
  for (const [name, value] of Object.entries(toolchain)) {
    if (value.trim() !== value || value === "" || /[\r\n]/u.test(value)) {
      throw new Error(`Ambiguous dependency toolchain value: ${name}`);
    }
  }
  return toolchain;
};

const currentToolchain = async (run: CommandRunner): Promise<DependencyCacheToolchain> => {
  const childCoordinates = parseJsonObject(await run(
    "node",
    ["--input-type=commonjs", "-e", "process.stdout.write(JSON.stringify({node:process.version,operatingSystem:process.platform,architecture:process.arch}))"],
    { timeoutMs: NPM_PROBE_TIMEOUT_MS },
  ), "child Node toolchain");
  const coordinate = (name: "node" | "operatingSystem" | "architecture"): string => {
    const value = childCoordinates[name];
    if (typeof value !== "string") throw new Error(`Ambiguous dependency toolchain value: ${name}`);
    return value;
  };
  return validatedToolchain({
    node: coordinate("node"),
    npm: (await run("npm", ["--version"], { timeoutMs: NPM_PROBE_TIMEOUT_MS })).trim(),
    operatingSystem: coordinate("operatingSystem"),
    architecture: coordinate("architecture"),
  });
};

const NPM_SECRET_CONFIG_KEY = /(?:^|[:/_-])(?:_?auth(?:token)?|token|password|username|email|proxy|cert|key)(?:$|[:/_-])/iu;

const canonicalValue = (value: unknown, key = ""): unknown => {
  if (typeof value === "string" && /registry$/iu.test(key)) {
    try {
      const registry = new URL(value);
      registry.username = "";
      registry.password = "";
      return registry.toString();
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !NPM_SECRET_CONFIG_KEY.test(key))
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([nestedKey, nested]) => [nestedKey, canonicalValue(nested, nestedKey)]));
  }
  return value;
};

const effectiveNpmConfigInput = async (run: CommandRunner): Promise<CacheEntryInput> => {
  const raw = await run("npm", ["config", "ls", "--json"], { timeoutMs: NPM_PROBE_TIMEOUT_MS });
  const parsed = parseJsonObject(raw, "effective npm configuration");
  const filtered = canonicalValue(parsed);
  return { path: "<effective-npm-config>", sha256: sha256(`${JSON.stringify(filtered)}\n`) };
};

export type DependencyCacheIdentity = {
  key: string;
  toolchain: DependencyCacheToolchain;
  inputs: CacheEntryInput[];
  targets: string[];
  nativeWorkspaces: string[];
};

// The single definition of dependency cache identity. Every input the key
// covers is gathered here: the workspace files, the effective npm
// configuration, and the toolchain. No caller can key a run on a smaller input
// set than the one this module tests.
export const deriveDependencyCacheKey = async (
  workspacePath: string,
  run: CommandRunner,
  options: { toolchain?: DependencyCacheToolchain } = {},
): Promise<DependencyCacheIdentity | null> => {
  const project = await inspectDependencyProject(workspacePath);
  if (project === null) return null;
  if (project.inputMissCondition) throw new DependencyCacheInputMissError(project.inputMissCondition, project.targets);
  const workspace = await realpath(resolve(workspacePath));
  const inWorkspace = commandRunnerIn(run, workspace);
  const { inputs, targets, nativeWorkspaces } = project;
  inputs.push(await effectiveNpmConfigInput(inWorkspace));
  inputs.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const toolchain = options.toolchain ?? await currentToolchain(inWorkspace);
  const key = sha256(`${JSON.stringify({ format: CACHE_ENTRY_FORMAT, toolchain: validatedToolchain(toolchain), inputs })}\n`);
  return { key, toolchain, inputs, targets, nativeWorkspaces };
};

const clearTargets = async (
  run: CommandRunner,
  workspace: string,
  targets: string[],
): Promise<void> => {
  const existing: Array<{ absolute: string; target: string }> = [];
  for (const target of targets) {
    const absolute = assertCacheTargetPath(workspace, target);
    await ensureRealDirectory(workspace, posix.dirname(target), `Dependency target parent ${posix.dirname(target)}`);
    const kind = await pathKind(absolute);
    if (kind === "symlink") throw new Error(`Dependency target is a symlink: ${target}`);
    if (kind !== "missing" && kind !== "directory") throw new Error(`Dependency target is not a directory: ${target}`);
    if (kind === "directory") existing.push({ absolute, target });
  }
  for (const { absolute, target } of existing) {
    await run("/bin/rm", ["-rf", "--", absolute]);
    if (await pathKind(absolute) !== "missing") throw new Error(`Dependency target could not be cleared: ${target}`);
  }
};

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

// npm ci is the only producer of these trees, so the root target must exist
// afterwards. An install that leaves it missing is a failed install, not an
// entry worth publishing.
const installedTargetTrees = async (workspace: string, targets: string[]): Promise<CacheEntryTarget[]> => {
  const manifest = await describeTargetTrees(workspace, targets);
  if (!manifest[0]?.present || manifest[0].path !== "node_modules") {
    throw new Error("npm ci did not produce the root node_modules target");
  }
  return manifest;
};

export const restoreCopyArguments = (
  source: string,
  destination: string,
  operatingSystem: NodeJS.Platform = platform(),
): string[] => {
  if (operatingSystem === "darwin") return ["-c", "-R", source, destination];
  if (operatingSystem === "linux") return ["-a", "--reflink=auto", source, destination];
  throw new Error(`unsupported dependency-cache platform: ${operatingSystem}`);
};

const restoreEntry = async (
  run: CommandRunner,
  store: CacheEntryStore,
  document: CacheEntryDocument,
  workspace: string,
): Promise<void> => {
  await clearTargets(run, workspace, document.targets.map(({ path }) => path));
  try {
    for (const target of document.targets) {
      if (!target.present) continue;
      const source = store.targetSourcePath(document.key, target.path);
      const destination = assertCacheTargetPath(workspace, target.path);
      await run("/bin/cp", restoreCopyArguments(source, destination));
      await run("/bin/chmod", ["-R", "u+w", destination]);
    }
    const restored = await describeTargetTrees(workspace, document.targets.map(({ path }) => path));
    if (!sameJson(restored, document.targets)) throw new Error("Restored dependency target manifest differs from the cache entry");
  } catch (error: unknown) {
    await clearTargets(run, workspace, document.targets.map(({ path }) => path)).catch(() => undefined);
    throw error;
  }
};

const installDependencies = async (
  run: CommandRunner,
  workspace: string,
  targets: string[],
  retryOptions: RetryOptions = {},
): Promise<CacheEntryTarget[]> => {
  const args = ["ci", "--prefer-offline", "--no-audit", "--no-fund"];
  try {
    await runWithNetworkRetry("npm", args, async ({ timeoutMs }) => {
      await clearTargets(run, workspace, targets);
      return run("npm", args, { timeoutMs });
    }, {
      commandTimeoutMs: NPM_INSTALL_COMMAND_TIMEOUT_MS,
      budgetMs: NPM_INSTALL_OPERATION_BUDGET_MS,
      ...retryOptions,
    });
    return await installedTargetTrees(workspace, targets);
  } catch (error: unknown) {
    await clearTargets(run, workspace, targets).catch(() => undefined);
    throw error;
  }
};

const rebuildNativeWorkspaces = async (
  run: CommandRunner,
  nativeWorkspaces: string[],
): Promise<void> => {
  for (const name of nativeWorkspaces) {
    await run(
      "npm",
      ["rebuild", "-w", name, "--no-audit", "--no-fund"],
      { timeoutMs: NPM_INSTALL_COMMAND_TIMEOUT_MS },
    );
  }
};

/**
 * Install the workspace's dependencies under the repository's NPM_CI policy.
 *
 * Whether a Run provisions at all is decided when its claim is admitted
 * (`dependency-provisioning.ts`); reaching here means the answer was yes.
 */
export const materializeWorkspaceDependencies = async (
  config: Pick<RunnerConfig, "workspaceRoot" | "dependencyCacheRoot">,
  workspacePath: string,
  run: CommandRunner,
  options: DependencyCacheOptions = {},
): Promise<DependencyCacheResult> => {
  const started = Date.now();
  const report = options.report ?? progressReporter;
  const requestedWorkspace = resolve(workspacePath);
  if (await pathKind(requestedWorkspace) !== "directory" || (await lstat(requestedWorkspace)).isSymbolicLink()) {
    throw new Error("Run workspace is not a real directory");
  }
  const workspace = await realpath(requestedWorkspace);
  const inWorkspace = commandRunnerIn(run, workspace);
  try {
    let identity: DependencyCacheIdentity | null;
    try {
      identity = await timed("identity", report, () => deriveDependencyCacheKey(workspace, inWorkspace, options));
    } catch (error: unknown) {
      if (!(error instanceof DependencyCacheInputMissError)) throw error;
      report({ event: "miss", condition: error.condition });
      await timed("install", report, () => installDependencies(
        inWorkspace, workspace, error.targets, options.installRetryOptions,
      ));
      return { status: "installed", condition: error.condition };
    }
    if (identity === null) {
      const error = new DependencyProvisioningManifestMissingError();
      report({ event: "miss", condition: error.condition });
      throw error;
    }
    const { key, toolchain, inputs, targets: targetPaths, nativeWorkspaces } = identity;
    const store = await openCacheEntryStore(
      options.cacheRoot ?? config.dependencyCacheRoot ?? join(dirname(resolve(config.workspaceRoot)), "dependency-cache"),
      workspace,
    );
    const expected: CacheEntryExpectation = { key, toolchain, inputs, targetPaths };
    const locked = await store.withSharedLock(async () => {
      try {
        await store.validateUseMarker(key);
      } catch (error: unknown) {
        if (!(error instanceof DependencyCacheIntegrityError)) throw error;
        report({ event: "integrity-refusal", key: key.slice(0, 16), condition: error.condition });
        throw error;
      }
      if (await store.hasEntry(key)) {
        try {
          const document = await timed("validate", report, () => store.readEntry(expected));
          await timed("restore", report, () => restoreEntry(inWorkspace, store, document, workspace));
          await timed("rebuild", report, () => rebuildNativeWorkspaces(inWorkspace, nativeWorkspaces));
          await store.recordUse(key);
          return {
            result: { status: "restored", key } as DependencyCacheResult,
            usableKey: key,
            newlyPublishedKey: undefined,
            successEvent: { event: "hit", key: key.slice(0, 16) } as DependencyCacheProgress,
          };
        } catch (error: unknown) {
          if (!(error instanceof DependencyCacheIntegrityError)) throw error;
          report({ event: "integrity-refusal", key: key.slice(0, 16), condition: error.condition });
          throw error;
        }
      } else {
        report({ event: "miss", key: key.slice(0, 16), condition: "entry-missing" });
      }

      const targets = await timed("install", report, () => installDependencies(
        inWorkspace, workspace, targetPaths, options.installRetryOptions,
      ));
      const publication = await timed("publish", report, () => store.publishEntry(expected, targets, workspace));
      if (publication === "refused") {
        const integrityError = new DependencyCacheIntegrityError("concurrent-entry-invalid");
        report({ event: "integrity-refusal", key: key.slice(0, 16), condition: integrityError.condition });
        throw integrityError;
      }
      try {
        await store.recordUse(key);
      } catch (error: unknown) {
        if (!(error instanceof DependencyCacheIntegrityError)) throw error;
        report({ event: "integrity-refusal", key: key.slice(0, 16), condition: error.condition });
        throw error;
      }
      return {
        result: { status: "installed", key } as DependencyCacheResult,
        usableKey: key,
        newlyPublishedKey: publication === "published" ? key : undefined,
        successEvent: {
          event: "publication", key: key.slice(0, 16), condition: publication,
        } as DependencyCacheProgress,
      };
    });
    // Only a publication can grow the population, so only a publication pays
    // for the exclusive byte-budget walk. A hit that also sized the cache would
    // convoy every concurrent restore behind one full inode walk per runner.
    if (locked.newlyPublishedKey !== undefined) {
      await timed("retention", report, () => store.enforceByteBudget(
        locked.usableKey,
        locked.newlyPublishedKey,
        report,
      ));
    }
    report(locked.successEvent);
    return locked.result;
  } finally {
    report({ event: "elapsed", elapsedMs: Date.now() - started });
  }
};
