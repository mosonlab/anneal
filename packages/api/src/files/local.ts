/**
 * Threat model
 *
 * This store rejects every hostile path string an API caller can express and every
 * symlink at rest: intermediate components are walked with lstat, list/stat never
 * follow links, and final file opens use O_NOFOLLOW atomically. Logical and canonical
 * roots remain separate so legitimate symlinked roots (including /tmp and iCloud-
 * relocated Documents) work.
 *
 * Hardlinks are a second, distinct escape and O_NOFOLLOW does nothing about them: a
 * hardlink is an ordinary directory entry for an inode that may also live outside the
 * root, lstat reports it as a plain file, and there is no race to win -- the escape is
 * persistent. Reads therefore refuse a regular file whose fstat reports nlink > 1, and
 * writes land on a private new inode that is renamed over the target instead of
 * truncating whatever inode is already sitting there.
 *
 * KNOWN OPEN GAP: a post-walk swap of an already-checked intermediate directory by an
 * adversary with concurrent write access inside the Files Root. It is not theoretical --
 * probe 24 in local.test.ts wins it in milliseconds -- and pure Node has no openat/
 * fd-relative primitive with which to close it. Closing it needs fd-relative traversal
 * in a native helper (docs/BACKLOG-V2.md). Until then deployment must isolate the model
 * CLI under a principal that cannot traverse or write FILES_ROOT, and that backstop is
 * now checked at startup rather than assumed: assertFilesRootIsolated refuses to boot
 * when FILES_ROOT overlaps the run workspace root, and warnIfRunnerSharesPrincipal warns
 * when RUNNER_RUN_AS_PREFIX is empty (files/config.ts). The algorithm alone does not
 * claim absolute containment against an attacker who can already write inside the root.
 */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { filesystemKey, realpathNative } from "./alias.js";
import { normalizeRelPath } from "./paths.js";
import {
  DirectoryNotEmptyError,
  HardLinkError,
  InvalidPathError,
  IsADirectoryError,
  NotADirectoryError,
  NotFoundError,
  SymlinkError,
  type FileStat,
  type FileStore,
} from "./store.js";

export type ResolveMode = "existing" | "create-parents";
export type ContainedPath = { target: string; parent: string; name: string; normalized: string };

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const mapPathError = (error: unknown, path: string): never => {
  if (codeOf(error) === "ELOOP") throw new SymlinkError(`Symlink refused: ${path}`);
  if (codeOf(error) === "ENOENT") throw new NotFoundError(`Path not found: ${path}`);
  if (codeOf(error) === "ENOTDIR") throw new NotADirectoryError(`Not a directory: ${path}`);
  if (codeOf(error) === "ENOTEMPTY") throw new DirectoryNotEmptyError(`Directory is not empty: ${path}`);
  if (codeOf(error) === "EISDIR") throw new IsADirectoryError(`Path is a directory: ${path}`);
  throw error;
};

const lstatOrNull = async (path: string): Promise<Stats | null> => {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return null;
    throw error;
  }
};

const inspectDirectory = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new SymlinkError(`Symlink refused: ${path}`);
  if (!info.isDirectory()) throw new NotADirectoryError(`Not a directory: ${path}`);
};

/**
 * The store's last-line containment assertion: whatever the lexical layer produced, the
 * resolved target must be the canonical root itself or sit under `root + sep`. Exported
 * as a predicate because `resolveContained` can only ever feed it values normalizeRelPath
 * already accepted, so the assertion is unreachable from the store's public surface and
 * would otherwise be pinned by no test at all. `${root}-evil` is the shape a bare
 * `startsWith(canonicalRoot)` admits.
 */
export const assertContainedTarget = (canonicalRoot: string, normalized: string): string => {
  const target = normalized === "" ? canonicalRoot : resolve(canonicalRoot, normalized);
  if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${sep}`)) {
    throw new InvalidPathError(`Resolved path escapes the Files Root: ${normalized}`);
  }
  return target;
};

export const resolveContained = async (
  canonicalRoot: string,
  rel: string,
  mode: ResolveMode,
): Promise<ContainedPath> => {
  const normalized = normalizeRelPath(rel);
  const target = assertContainedTarget(canonicalRoot, normalized);

  const segments = normalized === "" ? [] : normalized.split("/");
  let parent = canonicalRoot;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    try {
      await inspectDirectory(parent);
    } catch (error: unknown) {
      if (codeOf(error) !== "ENOENT" || mode === "existing") mapPathError(error, rel);
      try {
        await mkdir(parent, { mode: 0o750 });
      } catch (mkdirError: unknown) {
        if (codeOf(mkdirError) !== "EEXIST") mapPathError(mkdirError, rel);
      }
      try {
        await inspectDirectory(parent);
      } catch (inspectError: unknown) {
        mapPathError(inspectError, rel);
      }
    }
  }
  return { target, parent, name: segments.at(-1) ?? "", normalized };
};

const fileStat = (path: string, kind: "file" | "dir", size: number, modifiedAt: Date): FileStat => ({
  path,
  kind,
  size,
  modifiedAt,
});

const requireNonRoot = (resolved: ContainedPath): void => {
  if (resolved.name === "") throw new InvalidPathError("This operation cannot target the Files Root");
};

export const createLocalFileStore = async (logicalRoot: string): Promise<FileStore> => {
  await mkdir(logicalRoot, { recursive: true, mode: 0o750 });
  // .native, not the JS implementation: it returns the on-disk spelling, which is what
  // grant keys are compared in.
  const canonicalRoot = await realpathNative(logicalRoot);
  const resolvePath = (rel: string, mode: ResolveMode): Promise<ContainedPath> =>
    resolveContained(canonicalRoot, rel, mode);

  return {
    async read(path) {
      const resolved = await resolvePath(path, "existing");
      requireNonRoot(resolved);
      let handle;
      try {
        handle = await open(resolved.target, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (info.isFile() && info.nlink > 1) {
          throw new HardLinkError(`Hard link refused: ${resolved.normalized}`);
        }
        return await handle.readFile();
      } catch (error: unknown) {
        return mapPathError(error, resolved.normalized);
      } finally {
        await handle?.close();
      }
    },

    async write(path, data) {
      const resolved = await resolvePath(path, "create-parents");
      requireNonRoot(resolved);
      const existing = await lstatOrNull(resolved.target);
      if (existing?.isSymbolicLink()) throw new SymlinkError(`Symlink refused: ${resolved.normalized}`);
      // Write into a private new inode and replace the directory entry, never into the
      // inode already sitting at the target: a hardlinked target would otherwise carry
      // the write straight through to whatever else links that inode, and a failed write
      // would leave the previous contents truncated.
      const temporary = join(resolved.parent, `.agentos-write-${randomUUID()}`);
      let handle;
      try {
        handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o640,
        );
        await handle.writeFile(data);
        const info = await handle.stat();
        await handle.close();
        handle = undefined;
        await rename(temporary, resolved.target);
        return fileStat(resolved.normalized, "file", info.size, info.mtime);
      } catch (error: unknown) {
        return mapPathError(error, resolved.normalized);
      } finally {
        await handle?.close();
        await unlink(temporary).catch(() => undefined);
      }
    },

    async stat(path) {
      const resolved = await resolvePath(path, "existing");
      try {
        const info = await lstat(resolved.target);
        if (info.isSymbolicLink()) throw new SymlinkError(`Symlink refused: ${path}`);
        return fileStat(resolved.normalized, info.isDirectory() ? "dir" : "file", info.size, info.mtime);
      } catch (error: unknown) {
        if (codeOf(error) === "ENOENT") return null;
        return mapPathError(error, path);
      }
    },

    async list(dir) {
      const resolved = await resolvePath(dir, "existing");
      try {
        await inspectDirectory(resolved.target);
        const entries = await readdir(resolved.target, { withFileTypes: true });
        const stats = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry) => {
          const childPath = join(resolved.target, entry.name);
          const info = await lstat(childPath);
          if (info.isSymbolicLink()) return null;
          const rel = resolved.normalized === "" ? entry.name : `${resolved.normalized}/${entry.name}`;
          return fileStat(rel, info.isDirectory() ? "dir" : "file", info.size, info.mtime);
        }));
        return stats.filter((stat): stat is FileStat => stat !== null);
      } catch (error: unknown) {
        return mapPathError(error, dir);
      }
    },

    async grantKey(normalized) {
      return filesystemKey(canonicalRoot, normalizeRelPath(normalized));
    },

    async entries(dir) {
      const resolved = await resolvePath(dir, "existing");
      try {
        await inspectDirectory(resolved.target);
        const found = await readdir(resolved.target, { withFileTypes: true });
        return await Promise.all(found.map(async (entry) => {
          const info = await lstat(join(resolved.target, entry.name));
          const rel = resolved.normalized === "" ? entry.name : `${resolved.normalized}/${entry.name}`;
          if (info.isSymbolicLink()) return { path: rel, kind: "symlink" as const };
          return { path: rel, kind: info.isDirectory() ? ("dir" as const) : ("file" as const) };
        }));
      } catch (error: unknown) {
        return mapPathError(error, dir);
      }
    },

    async delete(path) {
      const resolved = await resolvePath(path, "existing");
      requireNonRoot(resolved);
      try {
        const info = await lstat(resolved.target);
        if (info.isSymbolicLink() || !info.isDirectory()) await unlink(resolved.target);
        else await rmdir(resolved.target);
      } catch (error: unknown) {
        mapPathError(error, path);
      }
    },

  };
};
