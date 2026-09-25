/**
 * The on-disk store of published dependency trees.
 *
 * Its vocabulary is keys, entries, bytes and usage. It knows nothing about npm,
 * run workspaces, RunnerConfig or command execution: an entry is an immutable
 * directory of target trees named by a 64-hex key, an entry records when it was
 * last used, and the population of entries is held under a byte budget.
 *
 * Everything here is reachable from a bare temporary directory, which is what
 * makes lock, usage, accounting, admission and eviction testable on their own.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, statfs,
  unlink, writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { flock } from "fs-ext";

import { DEPENDENCY_CACHE_BYTE_BUDGET } from "./dependency-cache-budget.js";

export { DEPENDENCY_CACHE_BYTE_BUDGET };

export const CACHE_ENTRY_FORMAT = "agentos-runner-dependency-cache-v2";
const METADATA_FILE = "metadata.json";
const TREE_DIRECTORY = "trees";
const ENTRIES_DIRECTORY = "entries";
const USAGE_DIRECTORY = "usage";
const ACCOUNTING_DIRECTORY = "accounting";
const TRASH_DIRECTORY = "trash";
const LOCK_FILE = "lock";
const MAINTENANCE_LOCK_FILE = "maintenance.lock";
const PRESSURE_FILE = "pressure.json";
const MAX_METADATA_BYTES = 128 * 1024 * 1024;
const CACHE_KEY = /^[a-f0-9]{64}$/u;

// Target confinement is lexical: a target path is relative and free of "..",
// so whether a recorded symlink escapes depends on the target's depth and the
// link's own "..", never on where the tree will actually be restored. Entry
// validation therefore applies the rule against this nominal root and does not
// need a run workspace at all.
const NOMINAL_RESTORE_ROOT = "/dependency-cache-restore-root";

export class DependencyCacheIntegrityError extends Error {
  constructor(readonly condition: string) {
    super(`Dependency cache integrity refusal: ${condition}`);
    this.name = "DependencyCacheIntegrityError";
  }
}

export class DependencyCacheBudgetError extends Error {
  constructor(readonly condition: string) {
    super(`Dependency cache byte budget refusal: ${condition}`);
    this.name = "DependencyCacheBudgetError";
  }
}

export type DependencyCacheToolchain = {
  node: string;
  npm: string;
  operatingSystem: string;
  architecture: string;
};

export type CacheEntryInput = { path: string; sha256: string } | { path: string; absent: true };

export type CacheEntryTreeNode =
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "file"; mode: number; sha256: string }
  | { path: string; kind: "symlink"; target: string };

export type CacheEntryTarget = { path: string; present: boolean; tree: CacheEntryTreeNode[] };

export type CacheEntryDocument = {
  format: typeof CACHE_ENTRY_FORMAT;
  key: string;
  toolchain: DependencyCacheToolchain;
  inputs: CacheEntryInput[];
  targets: CacheEntryTarget[];
};

/** Everything an entry must match to be usable, minus the trees themselves. */
export type CacheEntryExpectation = {
  key: string;
  toolchain: DependencyCacheToolchain;
  inputs: CacheEntryInput[];
  targetPaths: string[];
};

export type CacheEntryPublication = "published" | "converged" | "refused" | "skipped";

export type CacheMaintenanceResult = "maintained" | "busy";

export type CacheStoreEvent = {
  event: "integrity-refusal" | "eviction" | "maintenance";
  key?: string;
  condition?: string;
  phase?: "account" | "detach" | "delete" | "lock";
  outcome?: "started" | "completed" | "busy" | "aborted";
  bytes?: number;
  elapsedMs?: number;
};

export type CacheStoreReport = (event: CacheStoreEvent) => void;

export type DependencyCacheRetentionSize = { key: string; bytes: number; usedMs: number };

/**
 * The least-recently-used keys whose removal brings the population inside the
 * budget.
 */
export const selectDependencyCacheEvictions = (
  entries: readonly DependencyCacheRetentionSize[],
  budget = DEPENDENCY_CACHE_BYTE_BUDGET,
): string[] => {
  if (!Number.isFinite(budget) || budget < 0) throw new Error("Dependency cache byte budget is invalid");
  for (const entry of entries) {
    if (!Number.isFinite(entry.bytes) || entry.bytes < 0) throw new Error("Dependency cache entry size is invalid");
    if (!Number.isFinite(entry.usedMs)) throw new Error("Dependency cache usage time is invalid");
  }
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const victims: string[] = [];
  const ordered = [...entries].sort((left, right) => left.usedMs - right.usedMs || left.key.localeCompare(right.key));
  for (const entry of ordered) {
    if (total <= budget) break;
    total -= entry.bytes;
    victims.push(entry.key);
  }
  return victims;
};

const insideOrEqual = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const sha256 = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const isBestEffortWriteError = (error: unknown): boolean =>
  ["ENOSPC", "EDQUOT", "EIO", "EACCES", "EPERM", "EROFS"].includes(errorCode(error) ?? "");

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

const readManagedFile = async (path: string, maxBytes: number, condition: string): Promise<string | null> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw new DependencyCacheIntegrityError(`${condition}-unreadable:${errorCode(error) ?? "unknown"}`);
  });
  if (handle === null) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new DependencyCacheIntegrityError(condition);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new DependencyCacheIntegrityError(condition);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
};

/**
 * The store holds npm dependency trees, so a target is a `node_modules`
 * directory somewhere at or below `root`. This is the one place that rule and
 * the confinement rule are written.
 */
export const assertCacheTargetPath = (root: string, target: string): string => {
  if (target !== "node_modules" && !target.endsWith("/node_modules")) {
    throw new Error(`Invalid dependency target: ${target}`);
  }
  const absolute = resolve(root, target);
  if (!insideOrEqual(root, absolute)) throw new Error(`Dependency target escaped the run workspace: ${target}`);
  return absolute;
};

const treeManifest = async (
  treeRoot: string,
  root: string,
  mappedRoot: string,
  requireImmutable: boolean,
): Promise<CacheEntryTreeNode[]> => {
  const manifest: CacheEntryTreeNode[] = [];
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    const mapped = resolve(mappedRoot, relative(treeRoot, path));
    if (!insideOrEqual(root, mapped)) throw new DependencyCacheIntegrityError("tree-path-escape");
    const manifestPath = relative(treeRoot, path).split(sep).join("/") || ".";
    if (info.isSymbolicLink()) {
      const link = await readlink(path);
      if (isAbsolute(link) || !insideOrEqual(root, resolve(dirname(mapped), link))) {
        throw new DependencyCacheIntegrityError("symlink-escape");
      }
      manifest.push({ path: manifestPath, kind: "symlink", target: link });
      return;
    }
    if (requireImmutable && (info.mode & 0o222) !== 0) {
      throw new DependencyCacheIntegrityError("writable-entry");
    }
    if (info.isDirectory()) {
      if (requireImmutable && (info.mode & 0o005) !== 0o005) {
        throw new DependencyCacheIntegrityError("entry-not-readable");
      }
      manifest.push({ path: manifestPath, kind: "directory", mode: info.mode & 0o111 });
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
      return;
    }
    if (!info.isFile()) throw new DependencyCacheIntegrityError("special-file");
    if (requireImmutable && (info.mode & 0o004) === 0) throw new DependencyCacheIntegrityError("entry-not-readable");
    manifest.push({ path: manifestPath, kind: "file", mode: info.mode & 0o111, sha256: sha256(await readFile(path)) });
  };
  await visit(treeRoot);
  return manifest;
};

/**
 * Describe the target trees living under `root` right now. This is what a
 * caller publishes, and what it compares a restored workspace against.
 */
export const describeTargetTrees = async (root: string, targets: string[]): Promise<CacheEntryTarget[]> => {
  const manifest: CacheEntryTarget[] = [];
  for (const target of targets) {
    const absolute = assertCacheTargetPath(root, target);
    const kind = await pathKind(absolute);
    if (kind === "symlink") throw new Error(`Dependency target is a symlink: ${target}`);
    if (kind !== "missing" && kind !== "directory") throw new Error(`Dependency target is not a directory: ${target}`);
    const tree = kind === "directory" ? await treeManifest(absolute, root, absolute, false) : [];
    manifest.push({ path: target, present: kind === "directory", tree });
  }
  return manifest;
};

const documentShape = (value: unknown): value is CacheEntryDocument => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Partial<CacheEntryDocument>;
  if (metadata.format !== CACHE_ENTRY_FORMAT || typeof metadata.key !== "string") return false;
  if (metadata.toolchain === null || typeof metadata.toolchain !== "object" || Array.isArray(metadata.toolchain)) return false;
  const toolchain = metadata.toolchain as Partial<DependencyCacheToolchain>;
  if (!sameJson(Object.keys(toolchain).sort(), ["architecture", "node", "npm", "operatingSystem"])) return false;
  if (![toolchain.node, toolchain.npm, toolchain.operatingSystem, toolchain.architecture]
    .every((coordinate) => typeof coordinate === "string" && coordinate.length > 0)) return false;
  if (!Array.isArray(metadata.inputs) || !Array.isArray(metadata.targets) || metadata.targets.length === 0) return false;
  return metadata.inputs.every((input) => {
    if (input === null || typeof input !== "object" || typeof (input as CacheEntryInput).path !== "string") return false;
    const fields = Object.keys(input).sort();
    return (sameJson(fields, ["path", "sha256"]) && /^[a-f0-9]{64}$/u.test(String((input as { sha256?: unknown }).sha256)))
      || (sameJson(fields, ["absent", "path"]) && (input as { absent?: unknown }).absent === true);
  })
    && metadata.targets.every((target) => target !== null && typeof target === "object"
      && typeof (target as CacheEntryTarget).path === "string"
      && typeof (target as CacheEntryTarget).present === "boolean"
      && Array.isArray((target as CacheEntryTarget).tree)
      && sameJson(Object.keys(target).sort(), ["path", "present", "tree"])
      && (target as CacheEntryTarget).tree.every((entry) => {
        if (entry === null || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.kind !== "string") return false;
        if (entry.kind === "directory") {
          return Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o111
            && sameJson(Object.keys(entry).sort(), ["kind", "mode", "path"]);
        }
        if (entry.kind === "file") {
          return Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o111
            && /^[a-f0-9]{64}$/u.test(entry.sha256)
            && sameJson(Object.keys(entry).sort(), ["kind", "mode", "path", "sha256"]);
        }
        return entry.kind === "symlink" && typeof entry.target === "string"
          && sameJson(Object.keys(entry).sort(), ["kind", "path", "target"]);
      }));
};

const readDocument = async (entry: string): Promise<CacheEntryDocument> => {
  const path = join(entry, METADATA_FILE);
  const info = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") throw new DependencyCacheIntegrityError("metadata-missing");
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_METADATA_BYTES) {
    throw new DependencyCacheIntegrityError("metadata-malformed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    throw new DependencyCacheIntegrityError(`metadata-unreadable:${errorCode(error) ?? "invalid-json"}`);
  }
  if (!documentShape(parsed)) throw new DependencyCacheIntegrityError("metadata-malformed");
  return parsed;
};

const validateTreeLayout = async (trees: string, targets: CacheEntryTarget[]): Promise<void> => {
  const present = new Set(targets.filter(({ present }) => present).map(({ path }) => path));
  const prefixes = new Set<string>();
  for (const target of present) {
    let parent = posix.dirname(target);
    while (parent !== ".") {
      prefixes.add(parent);
      parent = posix.dirname(parent);
    }
  }
  const walk = async (directory: string, relativeDirectory = ""): Promise<void> => {
    if (((await lstat(directory)).mode & 0o222) !== 0) throw new DependencyCacheIntegrityError("writable-entry");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (present.has(path)) continue;
      if (!prefixes.has(path) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new DependencyCacheIntegrityError("unexpected-tree-content");
      }
      await walk(join(directory, entry.name), path);
    }
  };
  await walk(trees);
};

const validateImmutableEntryContents = async (entry: string, document: CacheEntryDocument): Promise<void> => {
  const trees = join(entry, TREE_DIRECTORY);
  if (await pathKind(trees) !== "directory") throw new DependencyCacheIntegrityError("tree-root-missing");
  const entryNames = (await readdir(entry)).sort();
  if (!sameJson(entryNames, [METADATA_FILE, TREE_DIRECTORY].sort())) {
    throw new DependencyCacheIntegrityError("unexpected-entry-content");
  }
  await validateTreeLayout(trees, document.targets);
  for (const target of document.targets) {
    const cached = resolve(trees, target.path);
    if (!insideOrEqual(trees, cached)) throw new DependencyCacheIntegrityError("target-path-escape");
    const kind = await pathKind(cached);
    if (target.present && kind !== "directory") throw new DependencyCacheIntegrityError("target-tree-missing");
    if (!target.present && kind !== "missing") throw new DependencyCacheIntegrityError("unexpected-target-tree");
    if (target.present) {
      const actualTree = await treeManifest(
        cached, NOMINAL_RESTORE_ROOT, assertCacheTargetPath(NOMINAL_RESTORE_ROOT, target.path), true,
      );
      if (!sameJson(actualTree, target.tree)) throw new DependencyCacheIntegrityError("tree-manifest-mismatch");
    } else if (target.tree.length !== 0) {
      throw new DependencyCacheIntegrityError("target-manifest-mismatch");
    }
  }
  await treeManifest(join(entry, METADATA_FILE), NOMINAL_RESTORE_ROOT, NOMINAL_RESTORE_ROOT, true);
  const entryInfo = await lstat(entry);
  const treesInfo = await lstat(trees);
  // The entry root is a runner-owned envelope. Owner write is required on
  // Darwin to move it across directories; group/world write is still unsafe,
  // while metadata and every tree node remain strictly immutable.
  if ((entryInfo.mode & 0o022) !== 0 || (treesInfo.mode & 0o222) !== 0) {
    throw new DependencyCacheIntegrityError("writable-entry");
  }
};

const validateEntry = async (entry: string, expected: CacheEntryExpectation): Promise<CacheEntryDocument> => {
  if (await pathKind(entry) !== "directory") throw new DependencyCacheIntegrityError("entry-not-directory");
  const document = await readDocument(entry);
  if (document.key !== expected.key) throw new DependencyCacheIntegrityError("key-mismatch");
  if (!sameJson(document.toolchain, expected.toolchain)) throw new DependencyCacheIntegrityError("toolchain-mismatch");
  if (!sameJson(document.inputs, expected.inputs)) throw new DependencyCacheIntegrityError("input-manifest-mismatch");
  if (!sameJson(document.targets.map(({ path }) => path), expected.targetPaths)) {
    throw new DependencyCacheIntegrityError("target-manifest-mismatch");
  }
  await validateImmutableEntryContents(entry, document);
  return document;
};

const makeImmutable = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) for (const child of await readdir(path)) await makeImmutable(join(path, child));
  await chmod(path, info.isDirectory() ? 0o555 : 0o444 | (info.mode & 0o111));
};

const allocatedBytes = (info: { blocks: number }): bigint => {
  if (!Number.isSafeInteger(info.blocks) || info.blocks < 0) {
    throw new DependencyCacheIntegrityError("invalid-allocated-size");
  }
  return BigInt(info.blocks) * 512n;
};

// Cache entries are immutable after publication. Walk them without following
// symlinks so accounting cannot escape the entry root. A symlink is itself an
// inode and therefore contributes its own allocated blocks. Its lexical target
// must remain below the entry root; validateEntry additionally checks the
// target against the tree layout before a selected entry is restored.
const accountCacheEntry = async (entry: string, containmentRoot = entry): Promise<bigint> => {
  const root = resolve(containmentRoot);
  const start = resolve(entry);
  if (!insideOrEqual(root, start)) throw new DependencyCacheIntegrityError("entry-path-escape");
  const rootInfo = await lstat(start).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") throw new DependencyCacheIntegrityError("entry-not-directory");
    throw error;
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new DependencyCacheIntegrityError(rootInfo.isSymbolicLink() ? "unsafe-retention-entry" : "entry-not-directory");
  }
  const visitedInodes = new Set<string>();
  const visit = async (path: string): Promise<bigint> => {
    let info;
    try {
      info = await lstat(path);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") throw new DependencyCacheIntegrityError("entry-disappeared");
      throw error;
    }
    const inode = `${String(info.dev)}:${String(info.ino)}`;
    if (info.ino !== 0 && visitedInodes.has(inode)) return 0n;
    if (info.ino !== 0) visitedInodes.add(inode);
    const ownBytes = allocatedBytes(info);
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target) || !insideOrEqual(root, resolve(dirname(path), target))) {
        throw new DependencyCacheIntegrityError("symlink-escape");
      }
      return ownBytes;
    }
    if (info.isFile()) return ownBytes;
    if (!info.isDirectory()) throw new DependencyCacheIntegrityError("special-file");
    let total = ownBytes;
    for (const child of await readdir(path)) {
      const childPath = join(path, child);
      if (!insideOrEqual(root, childPath)) throw new DependencyCacheIntegrityError("entry-path-escape");
      total += await visit(childPath);
    }
    return total;
  };
  return visit(start);
};

// Trash and crash-left publication stages are owned discardable trees, not
// entries. Count their inodes without following links or requiring a complete,
// immutable entry shape so interrupted deletion remains recoverable.
const accountDiscardableTree = async (path: string): Promise<bigint> => {
  const root = resolve(path);
  const visit = async (candidate: string): Promise<bigint> => {
    const info = await lstat(candidate);
    let total = allocatedBytes(info);
    if (!info.isDirectory() || info.isSymbolicLink()) return total;
    for (const child of await readdir(candidate)) {
      const childPath = join(candidate, child);
      if (!insideOrEqual(root, childPath)) throw new DependencyCacheIntegrityError("entry-path-escape");
      total += await visit(childPath);
    }
    return total;
  };
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DependencyCacheIntegrityError("unsafe-trash-entry");
  return visit(root);
};

const removeDiscardableTree = async (path: string, checkAbort: () => void): Promise<void> => {
  const root = resolve(path);
  const visit = async (candidate: string): Promise<void> => {
    checkAbort();
    const info = await lstat(candidate).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (info === null) return;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      await unlink(candidate);
      return;
    }
    await chmod(candidate, 0o700);
    for (const child of await readdir(candidate)) {
      const childPath = join(candidate, child);
      if (!insideOrEqual(root, childPath)) throw new DependencyCacheIntegrityError("entry-path-escape");
      await visit(childPath);
    }
    checkAbort();
    await rmdir(candidate);
  };
  await visit(root);
};

/** Allocated bytes an entry directory occupies, symlink inodes included. */
export const accountDependencyCacheEntryBytes = async (entry: string): Promise<bigint> => {
  let bytes: bigint;
  try {
    bytes = await accountCacheEntry(entry);
  } catch (error: unknown) {
    if (error instanceof DependencyCacheIntegrityError) throw error;
    throw new DependencyCacheIntegrityError(`size-walk-failed:${errorCode(error) ?? "unknown"}`);
  }
  return bytes;
};

const flockAsync = (fd: number, operation: "sh" | "ex" | "exnb" | "un"): Promise<void> => new Promise((accept, reject) => {
  flock(fd, operation, (error) => error ? reject(error) : accept());
});

type EntryIdentity = { dev: string; ino: string };

type MetadataIdentity = EntryIdentity & { size: number; mtimeMs: number; ctimeMs: number };

type RetentionEntry = {
  key: string;
  path: string;
  usedMs: number;
  bytes: bigint;
  identity: EntryIdentity;
  metadataIdentity: MetadataIdentity | null;
};

type SizeRecord = {
  format: "agentos-runner-dependency-cache-size-v1";
  name: string;
  key: string;
  bytes: number;
  identity: EntryIdentity;
  metadataIdentity: MetadataIdentity | null;
};

const totalRetentionBytes = (entries: RetentionEntry[]): bigint =>
  entries.reduce((total, entry) => total + entry.bytes, 0n);

const asRetentionIntegrityError = (error: unknown): DependencyCacheIntegrityError =>
  error instanceof DependencyCacheIntegrityError
    ? error
    : new DependencyCacheIntegrityError(`retention-walk-failed:${errorCode(error) ?? "unknown"}`);

const snapshotTarget = async (source: string, destination: string): Promise<void> => {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
};

/**
 * A cache root, opened.
 *
 * Every operation is named by a key. Publication and restore run under the
 * shared root lock; maintenance only tries the exclusive root lock long enough
 * to detach settled victims, then deletes them outside that lock.
 */
export type CacheEntryStore = {
  /** The resolved root. Entries, usage markers and the lock live under it. */
  readonly root: string;
  entryPath: (key: string) => string;
  /** Where a published target tree lives inside its entry. */
  targetSourcePath: (key: string, targetPath: string) => string;
  hasEntry: (key: string) => Promise<boolean>;
  /** Run `work` while maintenance cannot detach an entry. */
  withSharedLock: <T>(work: () => Promise<T>) => Promise<T>;
  /** Refuse a usage marker that is not a plain file before it is trusted. */
  validateUseMarker: (key: string) => Promise<void>;
  recordUse: (key: string) => Promise<boolean>;
  /** Validate the entry under `expected.key` against `expected` and return it. */
  readEntry: (expected: CacheEntryExpectation) => Promise<CacheEntryDocument>;
  /** Snapshot `targets` out of `source` into a new immutable entry. */
  publishEntry: (
    expected: CacheEntryExpectation, targets: CacheEntryTarget[], source: string, budget?: number,
  ) => Promise<CacheEntryPublication>;
  /** Account legacy entries and detach LRU victims without waiting for active readers. */
  maintainByteBudget: (
    report: CacheStoreReport, budget?: number, options?: { signal?: AbortSignal },
  ) => Promise<CacheMaintenanceResult>;
};

export type CacheEntryStoreOptions = {
  /** Overrides slow trash deletion for deterministic tests. */
  deleteTrash?: (path: string) => Promise<void>;
  /** Wraps one stage detach for deterministic fault injection. */
  moveStageToTrash?: (move: () => Promise<void>) => Promise<void>;
  /** Wraps one usage-marker write for deterministic fault injection. */
  writeUseMarker?: (write: () => Promise<void>) => Promise<void>;
};

/**
 * Create the cache root layout and return the store bound to it.
 *
 * `disjointFrom` is a resolved real path the root may neither contain nor live
 * inside: a cache that overlaps the trees it caches cannot be immutable. The
 * comparison is lexical, so an unresolved path would not be recognised.
 */
export const openCacheEntryStore = async (
  configuredRoot: string,
  disjointFrom: string,
  options: CacheEntryStoreOptions = {},
): Promise<CacheEntryStore> => {
  const requestedRoot = resolve(configuredRoot);
  await mkdir(requestedRoot, { recursive: true, mode: 0o711 });
  if ((await lstat(requestedRoot)).isSymbolicLink()) throw new Error("Dependency cache root is a symlink");
  const root = await realpath(requestedRoot);
  if (insideOrEqual(root, disjointFrom) || insideOrEqual(disjointFrom, root)) {
    throw new Error("Dependency cache root overlaps the run workspace");
  }
  await chmod(root, 0o711);
  const entriesRoot = join(root, ENTRIES_DIRECTORY);
  await mkdir(entriesRoot, { recursive: true, mode: 0o711 });
  if ((await lstat(entriesRoot)).isSymbolicLink()) throw new Error("Dependency cache entries root is a symlink");
  await chmod(entriesRoot, 0o711);
  const usageRoot = join(root, USAGE_DIRECTORY);
  await mkdir(usageRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(usageRoot)).isSymbolicLink()) throw new Error("Dependency cache usage root is a symlink");
  await chmod(usageRoot, 0o700);
  const accountingRoot = join(root, ACCOUNTING_DIRECTORY);
  const trashRoot = join(root, TRASH_DIRECTORY);
  for (const directory of [accountingRoot, trashRoot]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Dependency cache managed directory is a symlink");
    await chmod(directory, 0o700);
  }

  const entryPath = (key: string): string => {
    const entry = resolve(entriesRoot, key);
    if (!insideOrEqual(root, entry)) throw new Error("Dependency cache entry escaped its root");
    return entry;
  };

  const openLock = async (name = LOCK_FILE) => {
    const path = join(root, name);
    const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      throw new Error("Dependency cache lock is not a file");
    }
    return handle;
  };

  const tryExclusiveLock = async (name: string) => {
    const handle = await openLock(name);
    try {
      await flockAsync(handle.fd, "exnb");
      return handle;
    } catch (error: unknown) {
      await handle.close();
      if (["EAGAIN", "EWOULDBLOCK"].includes(errorCode(error) ?? "")) return null;
      throw error;
    }
  };

  const withSharedLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const handle = await openLock();
    try {
      await flockAsync(handle.fd, "sh");
      try {
        return await work();
      } finally {
        await flockAsync(handle.fd, "un");
      }
    } finally {
      await handle.close();
    }
  };

  const recordUse = async (key: string): Promise<boolean> => {
    if (!CACHE_KEY.test(key)) throw new Error("Dependency cache usage key is invalid");
    const marker = join(usageRoot, key);
    let handle;
    try {
      handle = await open(marker, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    } catch (error: unknown) {
      const current = await lstat(marker).catch(() => null);
      if (current?.isSymbolicLink() || (current !== null && !current.isFile())) {
        throw new DependencyCacheIntegrityError("unsafe-usage-marker");
      }
      if (isBestEffortWriteError(error)) return false;
      throw new DependencyCacheIntegrityError(`usage-marker-unwritable:${errorCode(error) ?? "unknown"}`);
    }
    let succeeded = true;
    let failure: unknown;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new DependencyCacheIntegrityError("unsafe-usage-marker");
      const write = async (): Promise<void> => {
        await handle.truncate(0);
        await handle.writeFile(`${new Date().toISOString()}\n`);
      };
      if (options.writeUseMarker) await options.writeUseMarker(write);
      else await write();
    } catch (error: unknown) {
      if (isBestEffortWriteError(error)) succeeded = false;
      else failure = error instanceof DependencyCacheIntegrityError
        ? error
        : new DependencyCacheIntegrityError(`usage-marker-unwritable:${errorCode(error) ?? "unknown"}`);
    }
    try {
      await handle.close();
    } catch (error: unknown) {
      if (isBestEffortWriteError(error)) succeeded = false;
      else if (failure === undefined) {
        failure = new DependencyCacheIntegrityError(`usage-marker-unwritable:${errorCode(error) ?? "unknown"}`);
      }
    }
    if (failure !== undefined) throw failure;
    return succeeded;
  };

  const validateUseMarker = async (key: string): Promise<void> => {
    const marker = join(usageRoot, key);
    const info = await lstat(marker).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw new DependencyCacheIntegrityError(`usage-marker-unreadable:${errorCode(error) ?? "unknown"}`);
    });
    if (info?.isSymbolicLink() || (info !== null && !info.isFile())) {
      throw new DependencyCacheIntegrityError("unsafe-usage-marker");
    }
  };

  const sizeRecordPath = (name: string): string => {
    if (basename(name) !== name || name.length === 0) throw new DependencyCacheIntegrityError("unsafe-size-record-name");
    return join(accountingRoot, `${name}.json`);
  };

  const entryIdentity = (info: { dev: bigint | number; ino: bigint | number }): EntryIdentity =>
    ({ dev: String(info.dev), ino: String(info.ino) });

  const metadataIdentity = async (path: string): Promise<MetadataIdentity | null> => {
    const metadata = join(path, METADATA_FILE);
    const info = await lstat(metadata).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (info === null) return null;
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o222) !== 0) {
      throw new DependencyCacheIntegrityError("unsafe-size-record-metadata");
    }
    return { ...entryIdentity(info), size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  };

  const writeSizeRecord = async (record: SizeRecord): Promise<void> => {
    const destination = sizeRecordPath(record.name);
    if (await pathKind(destination) === "symlink") throw new DependencyCacheIntegrityError("unsafe-size-record");
    const temporary = join(accountingRoot, `.tmp-${process.pid}-${randomUUID()}`);
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`);
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  };

  const readSizeRecord = async (
    name: string, path: string, key?: string, verifyMetadata = true,
  ): Promise<SizeRecord | null> => {
    const recordPath = sizeRecordPath(name);
    const content = await readManagedFile(recordPath, 64 * 1024, "unsafe-size-record");
    if (content === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new DependencyCacheIntegrityError("malformed-size-record");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DependencyCacheIntegrityError("malformed-size-record");
    }
    const record = parsed as Partial<SizeRecord>;
    if (record.format !== "agentos-runner-dependency-cache-size-v1"
      || record.name !== name || typeof record.key !== "string" || (key !== undefined && record.key !== key)
      || !Number.isSafeInteger(record.bytes) || Number(record.bytes) < 0
      || record.identity === null || record.identity === undefined || typeof record.identity !== "object"
      || Array.isArray(record.identity) || typeof record.identity.dev !== "string" || typeof record.identity.ino !== "string"
      || (record.metadataIdentity !== null && (record.metadataIdentity === undefined
        || typeof record.metadataIdentity !== "object" || Array.isArray(record.metadataIdentity)
        || typeof record.metadataIdentity.dev !== "string" || typeof record.metadataIdentity.ino !== "string"
        || !Number.isSafeInteger(record.metadataIdentity.size) || !Number.isFinite(record.metadataIdentity.mtimeMs)
        || !Number.isFinite(record.metadataIdentity.ctimeMs)))) {
      throw new DependencyCacheIntegrityError("malformed-size-record");
    }
    const targetInfo = await lstat(path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (targetInfo === null || targetInfo.isSymbolicLink() || !targetInfo.isDirectory()
      || !sameJson(entryIdentity(targetInfo), record.identity)) {
      throw new DependencyCacheIntegrityError("stale-size-record");
    }
    if (verifyMetadata && (targetInfo.mode & 0o022) !== 0) {
      throw new DependencyCacheIntegrityError("writable-accounted-entry");
    }
    if (verifyMetadata && !sameJson(record.metadataIdentity, await metadataIdentity(path))) {
      throw new DependencyCacheIntegrityError("stale-size-record");
    }
    return record as SizeRecord;
  };

  const writePressure = async (requestedBytes: bigint): Promise<void> => {
    const numeric = Number(requestedBytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : requestedBytes);
    let previous = 0;
    try {
      const pressurePath = join(root, PRESSURE_FILE);
      const content = await readManagedFile(pressurePath, 64 * 1024, "unsafe-pressure-record");
      if (content !== null) {
        const value: unknown = JSON.parse(content);
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new DependencyCacheIntegrityError("malformed-pressure-record");
        }
        const record = value as { requestedBytes?: unknown };
        if (!Number.isSafeInteger(record.requestedBytes) || Number(record.requestedBytes) < 0) {
          throw new DependencyCacheIntegrityError("malformed-pressure-record");
        }
        previous = Number(record.requestedBytes);
      }
    } catch (error: unknown) {
      if (error instanceof DependencyCacheIntegrityError) throw error;
      throw new DependencyCacheIntegrityError("malformed-pressure-record");
    }
    const temporary = join(root, `.pressure-${process.pid}-${randomUUID()}`);
    const handle = await open(
      temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify({ requestedBytes: Math.max(previous, numeric) })}\n`);
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, join(root, PRESSURE_FILE));
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  };

  const readPressure = async (): Promise<bigint> => {
    try {
      const content = await readManagedFile(join(root, PRESSURE_FILE), 64 * 1024, "unsafe-pressure-record");
      if (content === null) return 0n;
      const value: unknown = JSON.parse(content);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new DependencyCacheIntegrityError("malformed-pressure-record");
      }
      const record = value as { requestedBytes?: unknown };
      if (!Number.isSafeInteger(record.requestedBytes) || Number(record.requestedBytes) < 0) {
        throw new DependencyCacheIntegrityError("malformed-pressure-record");
      }
      return BigInt(Number(record.requestedBytes));
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return 0n;
      if (error instanceof DependencyCacheIntegrityError) throw error;
      throw new DependencyCacheIntegrityError("malformed-pressure-record");
    }
  };

  const accountedPopulationBytes = async (): Promise<bigint | null> => {
    let total = 0n;
    for (const name of await readdir(entriesRoot)) {
      if (!CACHE_KEY.test(name)) return null;
      const record = await readSizeRecord(name, join(entriesRoot, name), name);
      if (record === null) return null;
      total += BigInt(record.bytes);
    }
    for (const name of await readdir(trashRoot)) {
      const record = await readSizeRecord(name, join(trashRoot, name), undefined, false);
      if (record === null) return null;
      total += BigInt(record.bytes);
    }
    return total;
  };

  const sizeRecordFor = async (
    name: string, key: string, path: string, bytes: bigint, includeMetadata = true,
  ): Promise<SizeRecord> => {
    if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new DependencyCacheIntegrityError("allocated-size-overflow");
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new DependencyCacheIntegrityError("unsafe-retention-entry");
    return {
      format: "agentos-runner-dependency-cache-size-v1",
      name,
      key,
      bytes: Number(bytes),
      identity: entryIdentity(info),
      metadataIdentity: includeMetadata ? await metadataIdentity(path) : null,
    };
  };

  const detachStage = async (staging: string, key: string, bytes?: bigint): Promise<void> => {
    if (await pathKind(staging) === "missing") return;
    const name = `.trash-${key}-${randomUUID()}`;
    const destination = join(trashRoot, name);
    const move = async (): Promise<void> => {
      await chmod(staging, 0o755);
      await rename(staging, destination);
    };
    if (options.moveStageToTrash) await options.moveStageToTrash(move);
    else await move();
    if (bytes !== undefined) await writeSizeRecord(await sizeRecordFor(name, key, destination, bytes, false));
  };

  const publishEntry = async (
    expected: CacheEntryExpectation, targets: CacheEntryTarget[], source: string,
    budget = DEPENDENCY_CACHE_BYTE_BUDGET,
  ): Promise<CacheEntryPublication> => {
    if (!Number.isSafeInteger(budget) || budget < 0) throw new DependencyCacheBudgetError("invalid-byte-budget");
    if (!CACHE_KEY.test(expected.key)) throw new Error("Dependency cache publication key is invalid");
    if (!sameJson(targets.map(({ path }) => path), expected.targetPaths)) {
      throw new Error("Published dependency targets do not match the expected target paths");
    }
    const entry = entryPath(expected.key);
    if (await pathKind(entry) !== "missing") {
      try {
        await validateEntry(entry, expected);
        return "converged";
      } catch (error: unknown) {
        if (error instanceof DependencyCacheIntegrityError) return "refused";
        throw error;
      }
    }
    const maintenance = await tryExclusiveLock(MAINTENANCE_LOCK_FILE);
    if (maintenance === null) return "skipped";
    let staging: string | undefined;
    let stagingBytes: bigint | undefined;
    let estimatedBytes = 0n;
    try {
      for (const target of targets) {
        if (target.present) estimatedBytes += await accountCacheEntry(assertCacheTargetPath(source, target.path), source);
      }
      let population: bigint | null;
      try {
        population = await accountedPopulationBytes();
      } catch (error: unknown) {
        if (!(error instanceof DependencyCacheIntegrityError)) throw error;
        population = null;
      }
      const budgetBytes = BigInt(budget);
      const fileSystem = await statfs(root, { bigint: true });
      const availableBytes = fileSystem.bavail * fileSystem.bsize;
      if (estimatedBytes > budgetBytes) return "skipped";
      if (population === null || population + estimatedBytes > budgetBytes || estimatedBytes > availableBytes) {
        await writePressure(estimatedBytes).catch(() => undefined);
        return "skipped";
      }
      const document: CacheEntryDocument = {
        format: CACHE_ENTRY_FORMAT,
        key: expected.key,
        toolchain: expected.toolchain,
        inputs: expected.inputs,
        targets,
      };
      staging = await mkdtemp(join(entriesRoot, `.stage-${expected.key.slice(0, 16)}-`));
      if (!insideOrEqual(root, await realpath(staging))) throw new Error("Dependency cache staging escaped its root");
      await mkdir(join(staging, TREE_DIRECTORY));
      for (const target of document.targets) {
        if (target.present) {
          await snapshotTarget(
            assertCacheTargetPath(source, target.path), resolve(staging, TREE_DIRECTORY, target.path),
          );
        }
      }
      await writeFile(join(staging, METADATA_FILE), `${JSON.stringify(document)}\n`, { mode: 0o400 });
      await makeImmutable(staging);
      await chmod(staging, 0o755);
      await validateEntry(staging, expected);
      stagingBytes = await accountCacheEntry(staging);
      if (stagingBytes > budgetBytes || population + stagingBytes > budgetBytes) {
        if (stagingBytes <= budgetBytes) await writePressure(stagingBytes).catch(() => undefined);
        try {
          await detachStage(staging, expected.key, stagingBytes);
          staging = undefined;
        } catch {
          // The orphan remains under entries or trash for background maintenance.
        }
        return "skipped";
      }
      try {
        await rename(staging, entry);
      } catch (error: unknown) {
        // Darwin reports EACCES rather than EEXIST when the winning directory is
        // already immutable. The destination's independently verified state,
        // not the platform-specific errno, decides whether this was a safe race.
        if (await pathKind(entry) === "missing") throw error;
        try {
          await validateEntry(entry, expected);
          try {
            await detachStage(staging, expected.key, stagingBytes);
            staging = undefined;
          } catch {
            // Convergence succeeded; cleanup remains background maintenance work.
          }
          return "converged";
        } catch (validationError: unknown) {
          if (validationError instanceof DependencyCacheIntegrityError) return "refused";
          throw validationError;
        }
      }
      staging = undefined;
      try {
        await writeSizeRecord(await sizeRecordFor(expected.key, expected.key, entry, stagingBytes));
      } catch {
        // The immutable entry is safe but legacy until maintenance accounts it.
        return "skipped";
      }
      return "published";
    } catch (error: unknown) {
      if (!isBestEffortWriteError(error)) throw error;
      await writePressure(estimatedBytes).catch(() => undefined);
      return "skipped";
    } finally {
      if (staging !== undefined) await detachStage(staging, expected.key, stagingBytes).catch(() => undefined);
      await flockAsync(maintenance.fd, "un").catch(() => undefined);
      await maintenance.close().catch(() => undefined);
    }
  };

  const inspectRetentionEntry = async (key: string, path: string): Promise<void> => {
    const document = await readDocument(path);
    if (document.key !== key) throw new DependencyCacheIntegrityError("key-mismatch");
    await validateImmutableEntryContents(path, document);
  };
  const maintainByteBudget = async (
    report: CacheStoreReport,
    budget = DEPENDENCY_CACHE_BYTE_BUDGET,
    maintenanceOptions: { signal?: AbortSignal } = {},
  ): Promise<CacheMaintenanceResult> => {
    if (!Number.isSafeInteger(budget) || budget < 0) throw new DependencyCacheBudgetError("invalid-byte-budget");
    const started = Date.now();
    const maintenance = await tryExclusiveLock(MAINTENANCE_LOCK_FILE);
    if (maintenance === null) {
      report({ event: "maintenance", phase: "lock", outcome: "busy", elapsedMs: Date.now() - started });
      return "busy";
    }
    const checkAbort = (): void => maintenanceOptions.signal?.throwIfAborted();
    try {
      const accountStarted = Date.now();
      report({ event: "maintenance", phase: "account", outcome: "started" });
      const entries: RetentionEntry[] = [];
      const stages: RetentionEntry[] = [];
      const trash: RetentionEntry[] = [];
      for (const name of await readdir(entriesRoot)) {
        checkAbort();
        const path = join(entriesRoot, name);
        try {
          const info = await lstat(path);
          if (info.isSymbolicLink() || !info.isDirectory()) throw new DependencyCacheIntegrityError("unsafe-retention-entry");
          if (CACHE_KEY.test(name)) {
            await validateUseMarker(name);
            let bytes: bigint;
            const existing = await readSizeRecord(name, path, name);
            if (existing === null) {
              await inspectRetentionEntry(name, path);
              bytes = await accountCacheEntry(path);
              await writeSizeRecord(await sizeRecordFor(name, name, path, bytes));
            } else {
              bytes = BigInt(existing.bytes);
            }
            const marker = await lstat(join(usageRoot, name)).catch((error: unknown) => {
              if (errorCode(error) === "ENOENT") return null;
              throw error;
            });
            const usedMs = Number(marker?.mtimeMs ?? info.mtimeMs);
            if (!Number.isFinite(usedMs)) throw new DependencyCacheIntegrityError("invalid-usage-marker-time");
            const retained = {
              key: name, path, usedMs, bytes, identity: entryIdentity(info), metadataIdentity: await metadataIdentity(path),
            };
            entries.push(retained);
          } else if (name.startsWith(".stage-")) {
            const bytes = await accountDiscardableTree(path);
            stages.push({
              key: "", path, usedMs: info.mtimeMs, bytes,
              identity: entryIdentity(info), metadataIdentity: null,
            });
          }
        } catch (error: unknown) {
          const condition = asRetentionIntegrityError(error).condition;
          report({ event: "integrity-refusal", ...(CACHE_KEY.test(name) ? { key: name.slice(0, 16) } : {}), condition });
        }
      }
      for (const name of await readdir(trashRoot)) {
        checkAbort();
        const path = join(trashRoot, name);
        try {
          const info = await lstat(path);
          if (info.isSymbolicLink() || !info.isDirectory()) throw new DependencyCacheIntegrityError("unsafe-trash-entry");
          const key = name.startsWith(".trash-") && CACHE_KEY.test(name.slice(7, 71)) ? name.slice(7, 71) : "";
          let existing: SizeRecord | null = null;
          try {
            existing = await readSizeRecord(name, path, undefined, false);
          } catch (error: unknown) {
            report({ event: "integrity-refusal", condition: asRetentionIntegrityError(error).condition });
            await rm(sizeRecordPath(name), { force: true });
          }
          const bytes = existing === null ? await accountDiscardableTree(path) : BigInt(existing.bytes);
          trash.push({
            key, path, usedMs: info.mtimeMs, bytes,
            identity: entryIdentity(info), metadataIdentity: null,
          });
          if (existing === null) await writeSizeRecord(await sizeRecordFor(name, key, path, bytes, false));
        } catch (error: unknown) {
          report({ event: "integrity-refusal", condition: asRetentionIntegrityError(error).condition });
        }
      }
      report({
        event: "maintenance", phase: "account", outcome: "completed",
        bytes: Number(totalRetentionBytes([...entries, ...stages, ...trash])), elapsedMs: Date.now() - accountStarted,
      });

      let pressure = 0n;
      try {
        pressure = await readPressure();
      } catch (error: unknown) {
        report({ event: "integrity-refusal", condition: asRetentionIntegrityError(error).condition });
      }
      const target = BigInt(budget) - (pressure > BigInt(budget) ? BigInt(budget) : pressure);
      const plannedVictimKeys = selectDependencyCacheEvictions(entries.map(({ key, bytes, usedMs }) => ({
        key, bytes: Number(bytes), usedMs,
      })), Number(target));
      const entriesByKey = new Map(entries.map((entry) => [entry.key, entry] as const));

      const deleteCandidates = async (
        candidates: Array<{ name: string; path: string; key: string; bytes: bigint }>,
      ): Promise<void> => {
        for (const candidate of candidates) {
          checkAbort();
          const deleteStarted = Date.now();
          try {
            report({ event: "maintenance", phase: "delete", outcome: "started", bytes: Number(candidate.bytes) });
            if (options.deleteTrash) {
              await options.deleteTrash(candidate.path);
            } else {
              await removeDiscardableTree(candidate.path, checkAbort);
            }
            if (await pathKind(candidate.path) !== "missing") throw new Error("trash remained after deletion");
            await rm(sizeRecordPath(candidate.name), { force: true });
            report({
              event: "maintenance", phase: "delete", outcome: "completed", bytes: Number(candidate.bytes),
              elapsedMs: Date.now() - deleteStarted,
            });
          } catch (error: unknown) {
            if (maintenanceOptions.signal?.aborted) throw error;
            report({ event: "integrity-refusal", condition: `trash-delete-failed:${errorCode(error) ?? "unknown"}` });
          }
        }
      };
      await deleteCandidates(trash.map((entry) => ({
        name: basename(entry.path), path: entry.path, key: entry.key, bytes: entry.bytes,
      })));

      if (stages.length === 0 && plannedVictimKeys.length === 0) {
        await rm(join(root, PRESSURE_FILE), { force: true });
        return "maintained";
      }
      const detachStarted = Date.now();
      const rootLock = await tryExclusiveLock(LOCK_FILE);
      if (rootLock === null) {
        report({ event: "maintenance", phase: "lock", outcome: "busy", elapsedMs: Date.now() - detachStarted });
        return "busy";
      }
      const detached: Array<{ name: string; path: string; key: string; bytes: bigint }> = [];
      let retainPressure = false;
      try {
        checkAbort();
        const toDetach = [...stages];
        // Recheck only the planned victims. A refreshed marker defers that
        // eviction and keeps pressure for the next pass rather than extending
        // the root lock to recalculate the whole LRU population.
        for (const key of plannedVictimKeys) {
          const entry = entriesByKey.get(key);
          if (entry === undefined) continue;
          const marker = join(usageRoot, entry.key);
          const markerInfo = await lstat(marker).catch((error: unknown) => {
            if (errorCode(error) === "ENOENT") return null;
            throw error;
          });
          if (markerInfo?.isSymbolicLink() || (markerInfo !== null && !markerInfo.isFile())) {
            report({ event: "integrity-refusal", key: entry.key.slice(0, 16), condition: "unsafe-usage-marker" });
            retainPressure = true;
            continue;
          }
          const currentUsedMs = Number(markerInfo?.mtimeMs ?? entry.usedMs);
          if (currentUsedMs !== entry.usedMs) {
            retainPressure = true;
            continue;
          }
          toDetach.push(entry);
        }
        for (const candidate of toDetach) {
          checkAbort();
          const current = await lstat(candidate.path).catch((error: unknown) => {
            if (errorCode(error) === "ENOENT") return null;
            throw error;
          });
          if (current === null || !sameJson(entryIdentity(current), candidate.identity)) continue;
          const name = `.trash-${candidate.key || "stage"}-${randomUUID()}`;
          const destination = join(trashRoot, name);
          await chmod(candidate.path, 0o755);
          await rename(candidate.path, destination);
          await writeSizeRecord({
            format: "agentos-runner-dependency-cache-size-v1",
            name,
            key: candidate.key,
            bytes: Number(candidate.bytes),
            identity: candidate.identity,
            metadataIdentity: candidate.metadataIdentity,
          });
          if (candidate.key) {
            await validateUseMarker(candidate.key);
            await rm(join(usageRoot, candidate.key), { force: true });
            await rm(sizeRecordPath(candidate.key), { force: true });
            report({ event: "eviction", key: candidate.key.slice(0, 16), condition: "byte-budget" });
          }
          detached.push({ name, path: destination, key: candidate.key, bytes: candidate.bytes });
        }
      } finally {
        await flockAsync(rootLock.fd, "un").catch(() => undefined);
        await rootLock.close();
      }
      report({ event: "maintenance", phase: "detach", outcome: "completed", elapsedMs: Date.now() - detachStarted });

      await deleteCandidates(detached);
      if (retainPressure) await writePressure(0n).catch(() => undefined);
      else await rm(join(root, PRESSURE_FILE), { force: true });
      return "maintained";
    } catch (error: unknown) {
      if (maintenanceOptions.signal?.aborted) {
        report({ event: "maintenance", phase: "delete", outcome: "aborted" });
      }
      throw error;
    } finally {
      await flockAsync(maintenance.fd, "un").catch(() => undefined);
      await maintenance.close();
    }
  };

  return {
    root,
    entryPath,
    targetSourcePath: (key: string, targetPath: string) =>
      assertCacheTargetPath(join(entryPath(key), TREE_DIRECTORY), targetPath),
    hasEntry: async (key: string): Promise<boolean> => await pathKind(entryPath(key)) !== "missing",
    withSharedLock,
    validateUseMarker,
    recordUse,
    readEntry: (expected: CacheEntryExpectation) => validateEntry(entryPath(expected.key), expected),
    publishEntry,
    maintainByteBudget,
  };
};
