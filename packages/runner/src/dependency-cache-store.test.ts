import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEPENDENCY_CACHE_BYTE_BUDGET, accountDependencyCacheEntryBytes, describeTargetTrees, openCacheEntryStore,
  selectDependencyCacheEvictions,
  type CacheEntryExpectation, type CacheEntryInput, type CacheEntryStore, type CacheEntryStoreOptions,
  type CacheStoreEvent,
  type DependencyCacheToolchain,
} from "./dependency-cache-store.js";

// The store's whole point is that keys, entries, bytes and usage are reachable
// from a bare temporary directory: nothing below builds an npm workspace, runs
// a command, or constructs a RunnerConfig.

const TOOLCHAIN: DependencyCacheToolchain = {
  node: "v24.0.0",
  npm: "11.0.0",
  operatingSystem: "darwin",
  architecture: "arm64",
};

const INPUTS: CacheEntryInput[] = [
  { path: "package.json", sha256: "a".repeat(64) },
  { path: "packages/db/prisma/schema.prisma", absent: true },
];

const TARGET_PATHS = ["node_modules", "packages/db/node_modules"];

const key = (index: number): string => index.toString(16).padStart(64, "0");

const expectation = (entryKey: string): CacheEntryExpectation =>
  ({ key: entryKey, toolchain: TOOLCHAIN, inputs: INPUTS, targetPaths: TARGET_PATHS });

const makeImmutable = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) for (const child of await readdir(path)) await makeImmutable(join(path, child));
  await chmod(path, info.isDirectory() ? 0o555 : 0o444 | (info.mode & 0o111));
};

const makeWritable = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  await chmod(path, info.mode | 0o700);
  if (info.isDirectory()) for (const child of await readdir(path)) await makeWritable(join(path, child));
};

const cleanupRoot = async (root: string): Promise<void> => {
  await makeWritable(root).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
};

const openStore = (root: string, options?: CacheEntryStoreOptions): Promise<CacheEntryStore> =>
  openCacheEntryStore(join(root, "cache"), join(root, "sources"), options);

/** A plain directory holding the two target trees a publication snapshots. */
const sourceTree = async (root: string, name: string, content: string): Promise<string> => {
  const source = join(root, "sources", name);
  await mkdir(join(source, "node_modules/package-a"), { recursive: true });
  await mkdir(join(source, "packages/db/node_modules/package-b"), { recursive: true });
  await writeFile(join(source, "node_modules/package-a/index.js"), content);
  await writeFile(join(source, "packages/db/node_modules/package-b/index.js"), content);
  return source;
};

const publish = async (
  store: CacheEntryStore,
  root: string,
  entryKey: string,
  content = `content for ${entryKey.slice(56)}\n`,
  decorate: (source: string) => Promise<void> = async () => undefined,
): Promise<CacheEntryExpectation> => {
  const source = await sourceTree(root, entryKey.slice(56), content);
  await decorate(source);
  const targets = await describeTargetTrees(source, TARGET_PATHS);
  const expected = expectation(entryKey);
  assert.equal(await store.publishEntry(expected, targets, source), "published");
  await store.recordUse(entryKey);
  return expected;
};

const usageMarker = (store: CacheEntryStore, entryKey: string): string => join(store.root, "usage", entryKey);

/** An independent allocated-size walk, so accounting is checked against a second reading. */
const accountedBytes = async (path: string): Promise<bigint> => {
  const info = await lstat(path);
  if (info.isDirectory()) {
    let total = BigInt(info.blocks) * 512n;
    for (const child of await readdir(path)) total += await accountedBytes(join(path, child));
    return total;
  }
  return BigInt(info.blocks) * 512n;
};

const orderUsage = async (store: CacheEntryStore, keys: string[]): Promise<void> => {
  for (const [index, entryKey] of keys.entries()) {
    const when = new Date(1_000 * (index + 1));
    await utimes(usageMarker(store, entryKey), when, when);
  }
};

test("a cache root refuses a layout it cannot own", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-layout-"));
  try {
    const realRoot = await realpath(root);
    await assert.rejects(
      openCacheEntryStore(join(root, "cache"), join(realRoot, "cache/entries")),
      /overlaps/u,
      "a root that contains the trees it caches cannot be immutable",
    );
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), join(root, "linked-cache"));
    await assert.rejects(openCacheEntryStore(join(root, "linked-cache"), join(root, "sources")), /symlink/u);

    const store = await openStore(root);
    assert.deepEqual((await readdir(store.root)).sort(), ["accounting", "entries", "trash", "usage"]);
    assert.equal((await lstat(join(store.root, "usage"))).mode & 0o777, 0o700);
  } finally {
    await cleanupRoot(root);
  }
});

test("a published entry is immutable, reads back, and refuses a different expectation", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-publish-"));
  try {
    const store = await openStore(root);
    assert.equal(await store.hasEntry(key(1)), false);
    const expected = await publish(store, root, key(1), "published tree\n");
    assert.equal(await store.hasEntry(key(1)), true);

    const entry = store.entryPath(key(1));
    assert.equal((await lstat(entry)).mode & 0o777, 0o755, "the entry envelope remains runner-movable");
    assert.equal((await lstat(join(entry, "trees"))).mode & 0o222, 0, "published trees carry no writable bit");
    assert.equal(
      await readFile(join(store.targetSourcePath(key(1), "node_modules"), "package-a/index.js"), "utf8"),
      "published tree\n",
    );

    const document = await store.readEntry(expected);
    assert.equal(document.key, key(1));
    assert.deepEqual(document.targets.map(({ path }) => path), TARGET_PATHS);
    assert.equal(document.targets.every(({ present }) => present), true);

    const second = await sourceTree(root, "second", "published tree\n");
    assert.equal(
      await store.publishEntry(expected, await describeTargetTrees(second, TARGET_PATHS), second),
      "converged",
      "a second publication of the same key converges on the entry already there",
    );

    await assert.rejects(
      store.readEntry({ ...expected, toolchain: { ...TOOLCHAIN, node: "v22.0.0" } }),
      /toolchain-mismatch/u,
    );
    await assert.rejects(store.readEntry(expectation(key(2))), /entry-not-directory/u);
  } finally {
    await cleanupRoot(root);
  }
});

test("usage markers are written per key and refused when they are not plain files", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-usage-"));
  try {
    const store = await openStore(root);
    await store.validateUseMarker(key(1));

    await store.recordUse(key(1));
    const marker = usageMarker(store, key(1));
    assert.equal((await lstat(marker)).isFile(), true);
    const first = await readFile(marker, "utf8");
    assert.match(first, /^\d{4}-\d{2}-\d{2}T/u);
    await utimes(marker, new Date(1_000), new Date(1_000));
    await store.recordUse(key(1));
    assert.ok((await lstat(marker)).mtimeMs > 1_000, "recording use refreshes the marker");
    await store.validateUseMarker(key(1));

    await rm(marker);
    await mkdir(join(root, "marker-target"));
    await symlink(join(root, "marker-target"), marker);
    await assert.rejects(store.validateUseMarker(key(1)), /unsafe-usage-marker/u);
    await rm(marker);
    await mkdir(marker);
    await assert.rejects(store.validateUseMarker(key(1)), /unsafe-usage-marker/u);

    await assert.rejects(store.recordUse("not-a-cache-key"), /usage key is invalid/u);
  } finally {
    await cleanupRoot(root);
  }
});

test("byte-budget eviction takes the least recently used keys", () => {
  const gibibyte = 1024 ** 3;
  const budget = 16 * gibibyte;
  const belowBudget = Array.from({ length: 40 }, (_, index) => ({
    key: key(index), bytes: 256 * 1024 ** 2, usedMs: index + 1,
  }));
  assert.equal(
    belowBudget.reduce((total, entry) => total + entry.bytes, 0) < DEPENDENCY_CACHE_BYTE_BUDGET,
    true,
    "the synthetic population is below the fixed budget",
  );
  assert.deepEqual(
    selectDependencyCacheEvictions(belowBudget, DEPENDENCY_CACHE_BYTE_BUDGET),
    [],
    "entry count does not trigger retention",
  );

  const entries = [
    { key: key(100), bytes: 4 * gibibyte, usedMs: 1 },
    { key: key(101), bytes: 7 * gibibyte, usedMs: 2 },
    { key: key(102), bytes: 6 * gibibyte, usedMs: 3 },
    { key: key(103), bytes: 5 * gibibyte, usedMs: 4 },
  ];
  const victims = selectDependencyCacheEvictions(entries, budget);
  assert.deepEqual(victims, [key(100), key(101)], "multiple oldest entries are evicted in one pass");
  assert.ok(entries.filter(({ key: candidate }) => !victims.includes(candidate))
    .reduce((total, entry) => total + entry.bytes, 0) <= budget);

  const exact = [
    { key: key(110), bytes: 8 * gibibyte, usedMs: 1 },
    { key: key(111), bytes: 8 * gibibyte, usedMs: 2 },
  ];
  assert.deepEqual(
    selectDependencyCacheEvictions(exact, budget),
    [],
    "exactly the budget is retained",
  );

  const refreshable = [
    { key: key(120), bytes: 6 * gibibyte, usedMs: 1 },
    { key: key(121), bytes: 7 * gibibyte, usedMs: 2 },
    { key: key(122), bytes: 5 * gibibyte, usedMs: 3 },
  ];
  assert.deepEqual(selectDependencyCacheEvictions(refreshable, budget), [key(120)]);
  refreshable[0]!.usedMs = 10;
  assert.deepEqual(
    selectDependencyCacheEvictions(refreshable, budget),
    [key(121)],
    "refreshing the oldest usage marker changes the victim",
  );

  assert.deepEqual(
    selectDependencyCacheEvictions([{ key: key(130), bytes: budget + 1, usedMs: 1 }], budget),
    [key(130)],
  );
});

test("legacy entries are measured only by maintenance and publication stays conservative", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-legacy-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    await rm(join(store.root, `accounting/${key(1)}.json`));
    const second = await sourceTree(root, "legacy-second", "second\n");
    assert.equal(await store.publishEntry(expectation(key(2)), await describeTargetTrees(second, TARGET_PATHS), second), "skipped");

    await store.maintainByteBudget(() => undefined);
    assert.equal(await store.publishEntry(expectation(key(2)), await describeTargetTrees(second, TARGET_PATHS), second), "published");
  } finally {
    await cleanupRoot(root);
  }
});

test("slow trash deletion does not hold the root lock or block another reader", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-delete-lock-"));
  let deletionStarted!: () => void;
  const deleting = new Promise<void>((resolve) => { deletionStarted = resolve; });
  let releaseDeletion!: () => void;
  const deletionHeld = new Promise<void>((resolve) => { releaseDeletion = resolve; });
  try {
    const store = await openStore(root, { deleteTrash: async (path) => {
      deletionStarted();
      await deletionHeld;
      await makeWritable(path);
      await rm(path, { recursive: true, force: true });
    } });
    await publish(store, root, key(1));
    await publish(store, root, key(2));
    await orderUsage(store, [key(1), key(2)]);
    const size = await accountDependencyCacheEntryBytes(store.entryPath(key(2)));
    const maintenance = store.maintainByteBudget(() => undefined, Number(size));
    await deleting;

    await store.withSharedLock(async () => {
      assert.equal((await lstat(store.entryPath(key(2)))).isDirectory(), true);
    });
    releaseDeletion();
    assert.equal(await maintenance, "maintained");
    await assert.rejects(lstat(store.entryPath(key(1))), /ENOENT/u);
  } finally {
    releaseDeletion?.();
    await cleanupRoot(root);
  }
});

test("maintenance backs off while a shared owner is active and never detaches its entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-active-reader-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    let entered!: () => void;
    const sharedEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const shared = store.withSharedLock(async () => { entered(); await held; });
    await sharedEntered;
    assert.equal(await store.maintainByteBudget(() => undefined, 0), "busy");
    assert.equal((await lstat(store.entryPath(key(1)))).isDirectory(), true);
    release();
    await shared;
  } finally {
    await cleanupRoot(root);
  }
});

test("maintenance refreshes LRU markers after acquiring the root lock", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-lru-refresh-"));
  let deletionStarted!: () => void;
  const deleting = new Promise<void>((resolve) => { deletionStarted = resolve; });
  let releaseDeletion!: () => void;
  const deletionHeld = new Promise<void>((resolve) => { releaseDeletion = resolve; });
  try {
    const initial = await openStore(root, { deleteTrash: async () => { throw new Error("leave crash trash"); } });
    for (const entryKey of [key(1), key(2), key(3)]) await publish(initial, root, entryKey);
    await orderUsage(initial, [key(1), key(2), key(3)]);
    const size = await accountDependencyCacheEntryBytes(initial.entryPath(key(1)));
    await initial.maintainByteBudget(() => undefined, Number(size * 2n));

    const store = await openStore(root, { deleteTrash: async (path) => {
      deletionStarted();
      await deletionHeld;
      await makeWritable(path);
      await rm(path, { recursive: true, force: true });
    } });
    await orderUsage(store, [key(2), key(3)]);
    const maintenance = store.maintainByteBudget(() => undefined, Number(size));
    await deleting;
    await store.recordUse(key(2));
    releaseDeletion();
    await maintenance;

    assert.equal((await lstat(store.entryPath(key(2)))).isDirectory(), true, "the just-hit entry remains");
    await assert.rejects(lstat(store.entryPath(key(3))), /ENOENT/u, "the stale snapshot is not used for eviction");
  } finally {
    releaseDeletion?.();
    await cleanupRoot(root);
  }
});

test("a competing publication observes the real maintenance flock and skips", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-flock-"));
  let deletionStarted!: () => void;
  const deleting = new Promise<void>((resolve) => { deletionStarted = resolve; });
  let releaseDeletion!: () => void;
  const deletionHeld = new Promise<void>((resolve) => { releaseDeletion = resolve; });
  try {
    const cleaner = await openStore(root, { deleteTrash: async (path) => {
      deletionStarted(); await deletionHeld; await makeWritable(path); await rm(path, { recursive: true, force: true });
    } });
    await publish(cleaner, root, key(1));
    const size = await accountDependencyCacheEntryBytes(cleaner.entryPath(key(1)));
    const maintenance = cleaner.maintainByteBudget(() => undefined, 0);
    await deleting;
    const publisher = await openStore(root);
    const source = await sourceTree(root, "contended", "contended\n");
    assert.equal(await publisher.publishEntry(
      expectation(key(2)), await describeTargetTrees(source, TARGET_PATHS), source, Number(size * 4n),
    ), "skipped");
    releaseDeletion();
    await maintenance;
  } finally {
    releaseDeletion?.();
    await cleanupRoot(root);
  }
});

test("crash trash and orphan stages are recovered by a later maintenance pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-crash-trash-"));
  try {
    const failing = await openStore(root, { deleteTrash: async () => { throw new Error("simulated crash"); } });
    await publish(failing, root, key(1));
    await failing.maintainByteBudget(() => undefined, 0);
    assert.ok((await readdir(join(failing.root, "trash"))).length > 0);
    const stage = join(failing.root, "entries/.stage-orphaned");
    await mkdir(stage);
    await writeFile(join(stage, "partial"), "partial\n");

    const recovered = await openStore(root);
    await recovered.maintainByteBudget(() => undefined);
    assert.deepEqual(await readdir(join(recovered.root, "trash")), []);
    await assert.rejects(lstat(stage), /ENOENT/u);
  } finally {
    await cleanupRoot(root);
  }
});

test("capacity skips do not create stages and pressure lets maintenance reclaim headroom", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-pressure-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    const size = await accountDependencyCacheEntryBytes(store.entryPath(key(1)));
    const source = await sourceTree(root, "pressure", "pressure\n");
    const targets = await describeTargetTrees(source, TARGET_PATHS);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(await store.publishEntry(expectation(key(2)), targets, source, Number(size)), "skipped");
    }
    assert.deepEqual(await readdir(join(store.root, "entries")), [key(1)]);
    assert.deepEqual(await readdir(join(store.root, "trash")), []);

    await store.maintainByteBudget(() => undefined, Number(size));
    assert.equal(await store.publishEntry(expectation(key(2)), targets, source, Number(size)), "published");
  } finally {
    await cleanupRoot(root);
  }
});

test("oversized publications skip without pressuring maintenance to evict usable entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-oversized-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    const retainedBytes = await accountDependencyCacheEntryBytes(store.entryPath(key(1)));
    const source = await sourceTree(root, "oversized", "oversized\n");
    assert.equal(await store.publishEntry(
      expectation(key(2)), await describeTargetTrees(source, TARGET_PATHS), source, 1,
    ), "skipped");
    await assert.rejects(lstat(join(store.root, "pressure.json")), /ENOENT/u);

    await store.maintainByteBudget(() => undefined, Number(retainedBytes));
    assert.equal((await lstat(store.entryPath(key(1)))).isDirectory(), true);
  } finally {
    await cleanupRoot(root);
  }
});

test("unsafe accounting and pressure paths fail closed without following symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-unsafe-accounting-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    const sentinel = join(root, "sentinel");
    await writeFile(sentinel, "preserved\n");
    const record = join(store.root, `accounting/${key(1)}.json`);
    await rm(record);
    await symlink(sentinel, record);
    const source = await sourceTree(root, "unsafe", "unsafe\n");
    assert.equal(await store.publishEntry(
      expectation(key(2)), await describeTargetTrees(source, TARGET_PATHS), source,
    ), "skipped");

    await rm(join(store.root, "pressure.json"));
    await symlink(sentinel, join(store.root, "pressure.json"));
    const events: CacheStoreEvent[] = [];
    assert.equal(await store.maintainByteBudget((event) => events.push(event)), "maintained");
    assert.equal(await readFile(sentinel, "utf8"), "preserved\n");
    assert.ok(events.some(({ event }) => event === "integrity-refusal"));
    assert.equal((await store.readEntry(expectation(key(1)))).key, key(1));
  } finally {
    await cleanupRoot(root);
  }
});

test("maintenance resumes deletion of writable partial trash after a crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-partial-trash-"));
  try {
    const interrupted = await openStore(root, { deleteTrash: async (path) => {
      await makeWritable(path);
      await rm(join(path, "metadata.json"), { force: true });
      throw new Error("simulated mid-delete crash");
    } });
    await publish(interrupted, root, key(1));
    await interrupted.maintainByteBudget(() => undefined, 0);
    assert.ok((await readdir(join(interrupted.root, "trash"))).length > 0);

    const recovered = await openStore(root);
    assert.equal(await recovered.maintainByteBudget(() => undefined), "maintained");
    assert.deepEqual(await readdir(join(recovered.root, "trash")), []);
  } finally {
    await cleanupRoot(root);
  }
});

test("an aborted maintenance pass leaves entries attached for a later pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-abort-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    const controller = new AbortController();
    controller.abort();
    const events: CacheStoreEvent[] = [];
    await assert.rejects(
      store.maintainByteBudget((event) => events.push(event), 0, { signal: controller.signal }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal((await lstat(store.entryPath(key(1)))).isDirectory(), true);
    assert.ok(events.some(({ event, outcome }) => event === "maintenance" && outcome === "aborted"));
  } finally {
    await cleanupRoot(root);
  }
});

test("allocated-byte accounting includes metadata, trees, and safe symlink inodes without following links", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-accounting-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1), "accounted tree\n", async (source) => {
      await symlink("index.js", join(source, "node_modules/package-a/safe-link.js"));
    });
    const entry = store.entryPath(key(1));

    const expected = await accountedBytes(entry);
    assert.equal(await accountDependencyCacheEntryBytes(entry), expected, "the walk counts every lstat inode");
    assert.ok(await accountedBytes(join(entry, "metadata.json")) > 0n, "metadata contributes to accounted bytes");
    assert.ok(await accountedBytes(join(entry, "trees")) > 0n, "complete trees contribute to accounted bytes");
    const link = join(store.targetSourcePath(key(1), "node_modules"), "package-a/safe-link.js");
    const linkInfo = await lstat(link);
    assert.equal(linkInfo.isSymbolicLink(), true);
    assert.equal(expected >= BigInt(linkInfo.blocks) * 512n, true, "the symlink inode is counted");
  } finally {
    await cleanupRoot(root);
  }
});

test("allocated-byte accounting rejects special files instead of treating them as cache misses", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-special-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    const entry = store.entryPath(key(1));
    await makeWritable(entry);
    execFileSync("mkfifo", [join(store.targetSourcePath(key(1), "node_modules"), "package-a/special")]);
    await makeImmutable(entry);

    await assert.rejects(accountDependencyCacheEntryBytes(entry), /special-file/u);
  } finally {
    await cleanupRoot(root);
  }
});
