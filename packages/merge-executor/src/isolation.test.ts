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
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && entry !== "fake-pr-surface.ts")
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

test("the only mutating operations are the sanitized merge construction, train publication and disarms", async () => {
  assert.deepEqual([...MUTATING_OPERATIONS], [
    "createSanitizedTree",
    "createMergeCommit",
    "updateBaseRef",
    "publishTrain",
    "deleteTrainRef",
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

/** The `= ... ;` body of a top-level type alias, scanned rather than matched.
 *  A regex that stops at the first line ending in `;` truncates a variant
 *  written across several lines and silently shrinks the guarded set. */
const typeAliasBody = (source: string, start: number): { body: string; end: number } => {
  let index = source.indexOf("=", start) + 1;
  const bodyStart = index;
  let depth = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\"" || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) index += source[index] === "\\" ? 2 : 1;
    } else if ("{([".includes(char)) depth += 1;
    else if ("})]".includes(char)) depth -= 1;
    else if (char === ";" && depth === 0) return { body: source.slice(bodyStart, index), end: index + 1 };
    index += 1;
  }
  return assert.fail(`unterminated type alias at offset ${start}`);
};

/** Type text is not a producer. `ReadResult` declares `status: "api-error"`
 *  too, so a guard that searched the whole file would accept a variant that
 *  only a union declaration mentions. Comments are stripped for the same
 *  reason: prose naming an outcome does not construct it. */
const withoutTypeAliases = (source: string): string => {
  const pattern = /(?:^|\n)(?:export )?type [A-Za-z0-9_]+(?:<[^>]*>)? =/gu;
  let rest = "";
  let cursor = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const { end } = typeAliasBody(source, match.index);
    rest += source.slice(cursor, match.index);
    cursor = end;
    pattern.lastIndex = end;
  }
  return rest + source.slice(cursor);
};

/** The variants of a union alias, with the parse asserted total: every
 *  top-level alternative must yield exactly one status literal, so a shape the
 *  scanner does not understand fails loudly instead of dropping out of the set. */
const unionVariants = (source: string, name: string): string[] => {
  const start = source.indexOf(`export type ${name} =`);
  assert.notEqual(start, -1, `${name} union not found`);
  const { body } = typeAliasBody(source, start);
  const alternatives: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if ("{([".includes(char)) depth += 1;
    else if ("})]".includes(char)) depth -= 1;
    else if (char === "|" && depth === 0) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  alternatives.push(current);
  const variants = alternatives
    .filter((alternative) => alternative.trim().length > 0)
    .map((alternative) => {
      const literal = /status:\s*"([^"]+)"/u.exec(alternative);
      assert.ok(literal, `${name} alternative carries no status literal: ${alternative.trim()}`);
      return literal[1]!;
    });
  assert.ok(variants.length > 0, `no ${name} variants parsed`);
  return variants;
};

/** The `MergeResponse` variants nothing in the rest of the source constructs. */
const variantsWithoutProducer = (source: string): string[] => {
  const code = stripComments(source);
  const producers = withoutTypeAliases(code);
  return unionVariants(code, "MergeResponse")
    .filter((variant) => !producers.includes(`status: "${variant}"`));
};

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
  assert.deepEqual(variantsWithoutProducer(source), []);
});

/** The guard itself, held to the two ways a text search fakes a producer: a
 *  sibling union that declares the same status name, and a comment that names
 *  it. The multi-line variant is here because the scanner has to reach past it
 *  to the alternatives that follow. */
test("a variant only a declaration or a comment mentions has no producer", () => {
  const synthetic = [
    "export type ReadResult =",
    "  | { status: \"ok\" }",
    "  | { status: \"invented\"; reason: string };",
    "",
    "export type MergeResponse =",
    "  | { status: \"merged\"; sha: string }",
    "  /** Prose about status: \"commented\", which constructs nothing. */",
    "  | { status: \"commented\"; reason: string }",
    "  | {",
    "      status: \"invented\";",
    "      reason: string;",
    "    }",
    "  | { status: \"unknown\"; reason: string };",
    "",
    "const merged = (sha: string): MergeResponse => ({ status: \"merged\", sha });",
    "const stop = (reason: string): MergeResponse => ({ status: \"unknown\", reason });",
    "",
  ].join("\n");
  assert.deepEqual(variantsWithoutProducer(synthetic), ["commented", "invented"]);
});
