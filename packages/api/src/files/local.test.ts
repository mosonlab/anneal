import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { assertContainedTarget, createLocalFileStore, resolveContained } from "./local.js";
import { HardLinkError, InvalidPathError, NotFoundError, SymlinkError } from "./store.js";

const withRoot = async (run: (root: string, outside: string) => Promise<void>): Promise<void> => {
  const base = await mkdtemp(join(tmpdir(), "agentos-files-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  try {
    await run(root, outside);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
};

test("probe 1: plain and symlinked roots both support ordinary IO", async () => withRoot(async (root) => {
  const plain = await createLocalFileStore(root);
  await plain.write("plain.txt", Buffer.from("plain"));
  assert.equal((await plain.read("plain.txt")).toString(), "plain");
  const link = `${root}-link`;
  await symlink(root, link, "dir");
  const linked = await createLocalFileStore(link);
  await linked.write("linked.txt", Buffer.from("linked"));
  assert.equal((await linked.read("linked.txt")).toString(), "linked");
  assert.deepEqual((await linked.list("")).map(({ path }) => path).sort(), ["linked.txt", "plain.txt"]);
}));

test("probe 2: read refuses a final symlink to an outside file", async () => withRoot(async (root, outside) => {
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "SECRET");
  await symlink(secret, join(root, "leak.txt"));
  const store = await createLocalFileStore(root);
  // The message a session sees must name the path root-relative: it used to embed the
  // absolute Files Root, and app.ts returns error.message verbatim to the agent.
  await assert.rejects(store.read("leak.txt"), (error: Error) => {
    assert.equal(error instanceof SymlinkError, true);
    assert.equal(error.message, "Symlink refused: leak.txt");
    return true;
  });
}));

test("probe 3: write refuses a final symlink and preserves the outside file", async () => withRoot(async (root, outside) => {
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "SECRET");
  await symlink(secret, join(root, "leak.txt"));
  const store = await createLocalFileStore(root);
  await assert.rejects(store.write("leak.txt", Buffer.from("PWN")), (error: Error) => {
    assert.equal(error instanceof SymlinkError, true);
    assert.equal(error.message, "Symlink refused: leak.txt");
    return true;
  });
  assert.equal(await readFile(secret, "utf8"), "SECRET");
}));

test("probe 4: list omits directory symlinks and never exposes outside entries", async () => withRoot(async (root, outside) => {
  await writeFile(join(outside, "SECRET"), "secret");
  await writeFile(join(root, "visible.txt"), "ok");
  await symlink(outside, join(root, "escape"), "dir");
  const listed = await (await createLocalFileStore(root)).list("");
  assert.deepEqual(listed.map(({ path }) => path), ["visible.txt"]);
  assert.equal(listed.some(({ path }) => path.includes("SECRET")), false);
}));

test("probe 5: stat refuses a symlink instead of following its metadata", async () => withRoot(async (root, outside) => {
  const target = join(outside, "large.txt");
  await writeFile(target, "outside metadata");
  await symlink(target, join(root, "link.txt"));
  await assert.rejects((await createLocalFileStore(root)).stat("link.txt"), SymlinkError);
}));

test("probe 6: every operation refuses an intermediate directory symlink", async () => withRoot(async (root, outside) => {
  await writeFile(join(outside, "file.txt"), "SECRET");
  await symlink(outside, join(root, "link"), "dir");
  const store = await createLocalFileStore(root);
  await store.write("safe.txt", Buffer.from("safe"));
  const attempts = [
    () => store.read("link/file.txt"),
    () => store.write("link/new.txt", Buffer.from("bad")),
    () => store.list("link/sub"),
    () => store.stat("link/file.txt"),
    () => store.delete("link/file.txt"),
  ];
  for (const attempt of attempts) await assert.rejects(attempt(), SymlinkError);
}));

test("probe 7: a multi-hop inside-to-inside-to-outside symlink is refused", async () => withRoot(async (root, outside) => {
  await mkdir(join(root, "a"));
  await writeFile(join(outside, "secret.txt"), "SECRET");
  await symlink("../../outside", join(root, "a", "b"), "dir");
  await assert.rejects((await createLocalFileStore(root)).read("a/b/secret.txt"), SymlinkError);
}));

test("probe 8: deleting a symlink removes only the link", async () => withRoot(async (root, outside) => {
  const target = join(outside, "keep.txt");
  await writeFile(target, "KEEP");
  await symlink(target, join(root, "link.txt"));
  await (await createLocalFileStore(root)).delete("link.txt");
  assert.equal(await readFile(target, "utf8"), "KEEP");
  await assert.rejects(lstat(join(root, "link.txt")), { code: "ENOENT" });
}));

test("probe 9: a deterministic final-component swap is caught by read open", async () => withRoot(async (root, outside) => {
  const store = await createLocalFileStore(root);
  await store.write("x.txt", Buffer.from("inside"));
  assert.equal((await store.stat("x.txt"))?.kind, "file");
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "SECRET");
  await rm(join(root, "x.txt"));
  await symlink(secret, join(root, "x.txt"));
  await assert.rejects(store.read("x.txt"), SymlinkError);
}));

test("probe 10: pre-planted intermediate symlinks are refused — post-walk swaps are a KNOWN OPEN GAP", async () => withRoot(async (root, outside) => {
  // This covers the planted case only. The post-walk swap is NOT covered and NOT closed:
  // probe 24 wins it in milliseconds. Do not read this pass as containment against an
  // attacker with concurrent write access inside the root.
  await symlink(outside, join(root, "planted"), "dir");
  await assert.rejects((await createLocalFileStore(root)).read("planted/x"), SymlinkError);
}));

test(
  "probe 24: KNOWN OPEN GAP — a post-walk directory swap reads outside the root",
  { skip: process.env.AGENTOS_RACE_PROBE === "1" ? false : "opt-in: AGENTOS_RACE_PROBE=1 runs the post-walk swap race" },
  async () => withRoot(async (root, outside) => {
    // Executable evidence for the gap the threat model declares. Opt-in because it is a
    // race: it asserts the gap is still open, so it will fail the day fd-relative
    // traversal closes it, which is the moment the threat model needs rewriting.
    await writeFile(join(outside, "secret.txt"), "OUTSIDE-SECRET");
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a", "secret.txt"), "INSIDE");
    await symlink(outside, join(root, ".decoy"), "dir");
    const store = await createLocalFileStore(root);
    const [real, decoy, swapped] = [join(root, ".real"), join(root, ".decoy"), join(root, "a")];

    let stop = false;
    let flips = 0;
    const attacker = (async () => {
      while (!stop) {
        try { await rename(swapped, real); await rename(decoy, swapped); flips += 1; } catch { /* lost the step */ }
        try { await rename(swapped, decoy); await rename(real, swapped); flips += 1; } catch { /* lost the step */ }
      }
    })();

    let [attempts, penetrated, rejected, benign] = [0, 0, 0, 0];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && penetrated === 0) {
      attempts += 1;
      try {
        if ((await store.read("a/secret.txt")).toString().includes("OUTSIDE")) penetrated += 1;
        else benign += 1;
      } catch { rejected += 1; }
    }
    stop = true;
    await attacker;

    console.log(`probe 24: attempts=${attempts} flips=${flips} penetrated=${penetrated} rejected=${rejected} benign=${benign}`);
    assert.equal(penetrated > 0, true, "post-walk swap did not win here; if it is genuinely closed now, update the threat model in local.ts");
  }),
);

test("probe 11: write lazily creates mode-0750 parents but refuses a symlink parent", async () => withRoot(async (root, outside) => {
  const store = await createLocalFileStore(root);
  await store.write("x/y/z.txt", Buffer.from("ok"));
  assert.equal((await lstat(join(root, "x"))).mode & 0o777, 0o750);
  assert.equal((await lstat(join(root, "x", "y"))).mode & 0o777, 0o750);
  await symlink(outside, join(root, "bad"), "dir");
  await assert.rejects(store.write("bad/z.txt", Buffer.from("bad")), SymlinkError);
}));

test("probe 12: Windows drive shapes are invalid and a backslash name round-trips", async () => withRoot(async (root) => {
  const store = await createLocalFileStore(root);
  for (const path of ["C:\\evil", "C:evil"]) await assert.rejects(store.read(path), InvalidPathError);
  // A backslash is a legal POSIX filename character. It is contained like any other
  // single segment, and every store method must agree about it -- list() used to return
  // names that read/stat/delete then refused.
  await store.write("report\\draft.txt", Buffer.from("draft"));
  assert.deepEqual((await store.list("")).map(({ path }) => path), ["report\\draft.txt"]);
  assert.equal((await store.read("report\\draft.txt")).toString(), "draft");
  assert.equal((await store.stat("report\\draft.txt"))?.kind, "file");
  await store.delete("report\\draft.txt");
  assert.deepEqual(await store.list(""), []);
}));

test("probe 13: NUL is rejected before any filesystem syscall", async () => withRoot(async (root) => {
  await assert.rejects((await createLocalFileStore(root)).read("a\0b"), InvalidPathError);
}));

test("probe 14: encoded traversal text is literal and once-decoded traversal is rejected", async () => withRoot(async (root, outside) => {
  const store = await createLocalFileStore(root);
  await store.write("%2e%2e%2f", Buffer.from("literal one"));
  await store.write("%2E%2E", Buffer.from("literal two"));
  await assert.rejects(store.write("../escape", Buffer.from("bad")), InvalidPathError);
  assert.equal(await readFile(join(root, "%2e%2e%2f"), "utf8"), "literal one");
  assert.deepEqual(await readdir(outside), []);
}));

test("probe 15: traversal, absolute paths, and outside-directory links touch no sentinel", async () => withRoot(async (root, outside) => {
  const sentinel = join(outside, "outside.txt");
  await writeFile(sentinel, "SAFE");
  const store = await createLocalFileStore(root);
  await assert.rejects(store.read("../outside.txt"), InvalidPathError);
  await assert.rejects(store.write("../outside.txt", Buffer.from("bad")), InvalidPathError);
  await assert.rejects(store.read("/etc/passwd"), InvalidPathError);
  await symlink(outside, join(root, "ssh"), "dir");
  await assert.rejects(store.read("ssh/outside.txt"), SymlinkError);
  assert.equal(await readFile(sentinel, "utf8"), "SAFE");
}));

test("probe 16: sibling-root shapes are rejected at the lexical layer, before containment", async () => withRoot(async (root) => {
  // These inputs never reach the store's root-prefix assertion: the absolute form is
  // rejected by normalizeRelPath's leading-slash guard and the relative form by its ".."
  // guard. The assertion itself is pinned by probes 20 and 21, not here.
  const store = await createLocalFileStore(root);
  await assert.rejects(store.read(`${root}-evil/x`), /Absolute paths are not allowed/u);
  await assert.rejects(store.read(`../${basename(root)}-evil/x`), /Path escapes the Files Root/u);
}));

test("probe 17: all seven FileStore methods round-trip within the root", async () => withRoot(async (root) => {
  const store = await createLocalFileStore(root);
  const written = await store.write("a/b.txt", Buffer.from("hello"));
  assert.equal(written.path, "a/b.txt");
  assert.equal((await store.list("a")).at(0)?.path, "a/b.txt");
  assert.equal((await store.stat("a/b.txt"))?.kind, "file");
  assert.equal((await store.stat("a"))?.kind, "dir");
  assert.equal(await store.stat("missing"), null);
  await store.write("nonempty/file", Buffer.from("x"));
  await assert.rejects(store.delete("nonempty"));
}));

test("probe 18: missing directory lists as NotFound while a virgin root lists empty", async () => withRoot(async (root) => {
  const store = await createLocalFileStore(root);
  assert.deepEqual(await store.list(""), []);
  await assert.rejects(store.list("missing"), NotFoundError);
}));

test("probe 19: traversal normalizing inside is accepted and traversal escaping is rejected", async () => withRoot(async (root) => {
  const store = await createLocalFileStore(root);
  await store.write("a/../b.txt", Buffer.from("inside"));
  assert.equal(await readFile(join(root, "b.txt"), "utf8"), "inside");
  await assert.rejects(store.write("a/../../b.txt", Buffer.from("outside")), InvalidPathError);
}));

test("probe 23: a hardlink to an outside file is refused on read and never written through", async () => withRoot(async (root, outside) => {
  // O_NOFOLLOW says nothing about hardlinks and lstat reports one as an ordinary file,
  // so this escape is persistent rather than a race. Reads refuse the shared inode;
  // writes land on a private new inode, leaving the outside file untouched.
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "TOP-SECRET");
  await link(secret, join(root, "innocent.txt"));
  await mkdir(join(root, "nested"));
  await link(secret, join(root, "nested", "innocent.txt"));
  const store = await createLocalFileStore(root);
  await assert.rejects(store.read("innocent.txt"), HardLinkError);
  await assert.rejects(store.read("nested/innocent.txt"), HardLinkError);
  await store.write("innocent.txt", Buffer.from("OVERWRITTEN"));
  assert.equal(await readFile(secret, "utf8"), "TOP-SECRET");
  assert.equal((await store.read("innocent.txt")).toString(), "OVERWRITTEN");
}));

test("probe 22: entries() exposes the symlinks list() hides, without following them", async () => withRoot(async (root, outside) => {
  await writeFile(join(outside, "secret.txt"), "SECRET");
  const store = await createLocalFileStore(root);
  await store.write("tree/real.txt", Buffer.from("real"));
  await symlink(join(outside, "secret.txt"), join(root, "tree", "link"));
  await symlink(outside, join(root, "tree", "dirlink"), "dir");
  assert.deepEqual((await store.list("tree")).map(({ path }) => path), ["tree/real.txt"]);
  assert.deepEqual((await store.entries("tree")).sort((a, b) => a.path.localeCompare(b.path)), [
    { path: "tree/dirlink", kind: "symlink" },
    { path: "tree/link", kind: "symlink" },
    { path: "tree/real.txt", kind: "file" },
  ]);
  for (const entry of await store.entries("tree")) await store.delete(entry.path);
  await store.delete("tree");
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "SECRET");
  assert.deepEqual(await readdir(outside), ["secret.txt"]);
}));

test("probe 20: the containment assertion itself rejects every escaping resolved target", () => {
  // Deleting the assertion, or weakening it to a bare startsWith(canonicalRoot), turns
  // this red. No other test in the repository fails on either mutation.
  const root = "/srv/files-root";
  assert.equal(assertContainedTarget(root, ""), root);
  assert.equal(assertContainedTarget(root, "a/b.txt"), join(root, "a/b.txt"));
  for (const escaping of ["../outside/secret", "/etc/passwd", `${root}-evil/x`, `${root}x`]) {
    assert.throws(() => assertContainedTarget(root, escaping), InvalidPathError);
  }
});

test("probe 21: resolveContained applies the containment assertion to its own output", async () => {
  // A root that is not already canonical (trailing separator) resolves to targets that
  // are not under `root + sep`. Removing the assertion from resolveContained makes this
  // fall through to the segment walk and fail with a different error, so this pins the
  // call site as probe 20 pins the predicate.
  await assert.rejects(
    resolveContained("/srv/files-root/", "a/b.txt", "existing"),
    /Resolved path escapes the Files Root/u,
  );
});
