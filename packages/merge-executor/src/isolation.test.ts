/**
 * The structural guarantees of §D-P1, asserted rather than intended.
 *
 * These are the tests that stop the package from drifting back into the shape
 * the review rejected: a credential-holding process that also spawns model CLIs,
 * provisions workspaces, or pushes branches.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MUTATING_OPERATIONS } from "./github.js";

const sourceRoot = dirname(fileURLToPath(import.meta.url));

/** Line and block comments removed, so an assertion about code is about code. */
const stripComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//gu, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

/** Shipped source only. The test files are excluded because this very file has
 *  to name the forbidden identifiers in order to forbid them. */
const sourceFiles = async (): Promise<string[]> => {
  const entries = await readdir(sourceRoot);
  return entries
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => join(sourceRoot, entry));
};

/** The module graph actually reachable from the daemon entry point, resolved by
 *  following relative imports. Package-level dependencies are a weaker claim:
 *  what matters is what this process can load. */
const reachableGraph = async (entry: string): Promise<{ files: string[]; externals: Set<string> }> => {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gu)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/u, ".ts")));
      } else {
        externals.add(specifier);
      }
    }
    for (const match of source.matchAll(/import\s+"([^"]+)"/gu)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier.replace(/\.js$/u, ".ts")));
      else externals.add(specifier);
    }
  }
  return { files: [...seen], externals };
};

test("no source file in this package can spawn a child process", async () => {
  // A spawned child gets an environment and an argv, and both are `ps`-visible
  // surfaces. The executor's whole custody claim is that the token appears in
  // neither, which is only true while this package spawns nothing.
  const forbidden = /\b(?:child_process|spawnSync|spawn|execFile|execSync|\bexec\(|fork\()/u;
  for (const file of await sourceFiles()) {
    const source = await readFile(file, "utf8");
    const offending = stripComments(source)
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => forbidden.test(line));
    assert.deepEqual(offending, [], `${file} references child-process execution`);
  }
});

test("nor can the shared GitHub client the executor now loads", async () => {
  // §D-P1's custody claim is about the *process*, not about this directory, and
  // as of #139 the process also loads @anneal/github-client. A package that
  // spawned anything would put the merge token in a child environment through
  // an import the tests above cannot see, so the same assertion is made here
  // against that package's shipped source. It is credential-free and its
  // transport is injected, which is what keeps this true.
  const shared = resolve(sourceRoot, "..", "..", "github-client", "src");
  const entries = (await readdir(shared)).filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"));
  assert.ok(entries.length > 0, `found no sources under ${shared}, so this assertion proved nothing`);
  const forbidden = /\b(?:child_process|spawnSync|spawn|execFile|execSync|\bexec\(|fork\()/u;
  for (const entry of entries) {
    const offending = stripComments(await readFile(join(shared, entry), "utf8"))
      .split("\n")
      .filter((line) => forbidden.test(line));
    assert.deepEqual(offending, [], `github-client/${entry} references child-process execution`);
  }
});

test("the daemon's reachable module graph contains no adapter, workspace, delivery or Prisma code", async () => {
  const { files, externals } = await reachableGraph(join(sourceRoot, "index.ts"));
  const forbiddenExternals = ["@prisma/client", "@anneal/db", "@anneal/runner", "@anneal/api", "@anneal/inbox"];
  for (const specifier of externals) {
    // The one permitted `@anneal/db` entry point is its PURE record-convention
    // subpath, which imports nothing at all — not the package index, which would
    // pull in Prisma and every control-plane query.
    if (specifier === "@anneal/db/merge-integrator") continue;
    // `@anneal/github-client` is permitted and is not on the list: it has no
    // runtime dependencies, holds no credential, and spawns nothing — the test
    // above asserts the last of those against its actual source.
    if (specifier === "@anneal/github-client") continue;
    assert.equal(forbiddenExternals.includes(specifier), false, `the executor must not import ${specifier}`);
  }
  for (const file of files) {
    for (const banned of ["adapters", "workspace", "delivery", "prompt", "mcp-server"]) {
      assert.equal(file.includes(`/${banned}`), false, `${file} is reachable from the executor`);
    }
  }
});

test("the only mutating operations are the sanitized merge construction and the two disarms", async () => {
  assert.deepEqual([...MUTATING_OPERATIONS], [
    "createSanitizedTree",
    "createMergeCommit",
    "updateBaseRef",
    "disablePullRequestAutoMerge",
    "dequeuePullRequest",
  ]);
  const github = await readFile(join(sourceRoot, "github.ts"), "utf8");
  // Comments are stripped first: prose explaining that we never send `--admin`
  // is not a code path that sends it, and a test that cannot tell the two apart
  // would push the explanation out of the file instead of the behaviour.
  const code = stripComments(github);
  for (const bypass of ["admin", "bypass", "enablePullRequestAutoMerge", "enqueuePullRequest", "mergePullRequest(input"]) {
    assert.equal(code.toLowerCase().includes(bypass.toLowerCase()), false, `github.ts constructs a ${bypass} request`);
  }
  assert.match(code, /path: "\.chain"/u);
  assert.match(code, /force: false/u);
  assert.equal([...github.matchAll(/method: "PUT"/gu)].length, 0);
  assert.equal([...github.matchAll(/beforeOid/gu)].length >= 1, true);
  assert.equal([...github.matchAll(/^mutation|`mutation\(/gmu)].length, 3);
});

/**
 * A closed set: every `MergeResponse` variant is produced somewhere in
 * `github.ts`.
 *
 * The executor no longer merges through the pull-request merge API; it builds
 * the merge commit and fast-forwards the target ref. That switch silently
 * orphaned the variants only the old path could return, and the decision table
 * went on branching on outcomes nothing could produce — branches asserted
 * against a fake and never against production code. A variant with no producer
 * is dead weight the decision table cannot be trusted to describe, so it is a
 * failure here rather than a discovery later.
 */
test("every MergeResponse variant has a producer in github.ts", async () => {
  const source = await readFile(join(sourceRoot, "github.ts"), "utf8");
  const union = /export type MergeResponse =\n((?:\s*(?:\||\/|\*).*\n)*?)[^\n]*;\n/u.exec(source);
  assert.ok(union, "MergeResponse union not found in github.ts");
  const declaration = source.slice(union.index, union.index + union[0].length);
  const variants = [...declaration.matchAll(/status: "([a-z-]+)"/gu)].map((match) => match[1]!);
  assert.ok(variants.length > 0, "no MergeResponse variants parsed");

  // Everything outside the declaration is where a producer must live.
  const producers = source.slice(0, union.index) + source.slice(union.index + union[0].length);
  for (const variant of variants) {
    assert.ok(
      producers.includes(`status: "${variant}"`),
      `MergeResponse variant "${variant}" has no producer in github.ts`,
    );
  }
});
