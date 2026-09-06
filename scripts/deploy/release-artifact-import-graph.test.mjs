import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const deployRoot = dirname(fileURLToPath(import.meta.url));

// Statement-anchored: a specifier only counts when `import` or `export` opens
// the line, which keeps a mention inside a comment or a string out of the
// graph. A clause may still span lines, so the pre-`from` run matches newlines.
const IMPORT_PATTERNS = Object.freeze([
  /^\s*import\s+(?:[^'";]*?\bfrom\s*)?["'](?<specifier>[^"']*)["']/gmu,
  /^\s*export\s+[^'";]*?\bfrom\s*["'](?<specifier>[^"']*)["']/gmu,
]);

const staticImportSpecifiers = (source) => {
  const specifiers = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) specifiers.push(match.groups.specifier);
  }
  return specifiers;
};

const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`);

/**
 * Walk the transitive static import graph of `entryPath` and report the first
 * edge whose specifier is neither a Node builtin nor a module inside `root`.
 * An unresolvable specifier is a violation too: a check that skipped what it
 * could not resolve would pass the very import that broke deployment.
 */
const escapingImport = ({ entryPath, root }) => {
  const visited = new Set();
  const queue = [resolve(entryPath)];
  while (queue.length > 0) {
    const importer = queue.shift();
    if (visited.has(importer)) continue;
    visited.add(importer);
    let source;
    try {
      source = readFileSync(importer, "utf8");
    } catch (error) {
      return { importer, specifier: "", detail: `unreadable-${error?.code ?? "error"}` };
    }
    for (const specifier of staticImportSpecifiers(source)) {
      if (specifier.startsWith("node:") || isBuiltin(specifier)) continue;
      if (!specifier.startsWith(".")) {
        return { importer, specifier, detail: "not-a-relative-module" };
      }
      const resolved = resolve(dirname(importer), specifier);
      if (!inside(root, resolved)) return { importer, specifier, detail: "outside-root" };
      try {
        readFileSync(resolved);
      } catch (error) {
        return { importer, specifier, detail: `unresolvable-${error?.code ?? "error"}` };
      }
      queue.push(resolved);
    }
  }
  return null;
};

const assertImportGraphStaysInside = ({ entryPath, root, label }) => {
  const violation = escapingImport({ entryPath, root });
  if (violation === null) return;
  const importer = relative(root, violation.importer) || violation.importer;
  assert.fail(
    `${label}: ${importer} imports "${violation.specifier}" (${violation.detail}). `
    + "The release verifier's module graph may only reach Node builtins and modules "
    + "inside scripts/deploy/, because an older builder decides which files exist in "
    + "the artifact it produced.",
  );
};

const fixture = (files) => {
  const root = mkdtempSync(join(tmpdir(), "agentos-verifier-graph-"));
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return root;
};

test("the release verifier's import graph reaches only Node builtins and scripts/deploy", () => {
  assertImportGraphStaysInside({
    entryPath: join(deployRoot, "release-artifact.mjs"),
    root: deployRoot,
    label: "release-artifact.mjs import graph escapes scripts/deploy/",
  });
});

test("a transitive import of a module outside the root is reported with importer and specifier", () => {
  const root = fixture({
    "release-artifact.mjs": 'import { helper } from "./helper.mjs";\nexport const verify = helper;\n',
    "helper.mjs": 'import { RUNTIME_TOOL_FILES } from "../../packages/runner/scripts/build-runtime-tools.mjs";\n'
      + "export const helper = () => RUNTIME_TOOL_FILES;\n",
  });
  try {
    const violation = escapingImport({ entryPath: join(root, "release-artifact.mjs"), root });
    assert.deepEqual(
      { importer: violation?.importer, specifier: violation?.specifier, detail: violation?.detail },
      {
        importer: join(root, "helper.mjs"),
        specifier: "../../packages/runner/scripts/build-runtime-tools.mjs",
        detail: "outside-root",
      },
    );
    assert.throws(
      () => assertImportGraphStaysInside({ entryPath: join(root, "release-artifact.mjs"), root, label: "escaped" }),
      /helper\.mjs imports "\.\.\/\.\.\/packages\/runner\/scripts\/build-runtime-tools\.mjs"/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare package specifier and an unresolvable relative specifier are both violations", () => {
  const bare = fixture({ "release-artifact.mjs": 'import { z } from "zod";\nexport const verify = z;\n' });
  const missing = fixture({ "release-artifact.mjs": 'import "./gone.mjs";\nexport const verify = null;\n' });
  try {
    assert.equal(escapingImport({ entryPath: join(bare, "release-artifact.mjs"), root: bare })?.detail, "not-a-relative-module");
    const unresolvable = escapingImport({ entryPath: join(missing, "release-artifact.mjs"), root: missing });
    assert.equal(unresolvable?.specifier, "./gone.mjs");
    assert.equal(unresolvable?.detail, "unresolvable-ENOENT");
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("a graph of Node builtins and sibling modules has no violation", () => {
  const root = fixture({
    "release-artifact.mjs": 'import { join } from "node:path";\nimport { helper } from "./nested/helper.mjs";\n'
      + "export const verify = () => helper(join);\n",
    "nested/helper.mjs": 'import { readFileSync } from "fs";\nexport const helper = (join) => readFileSync(join(".", "."));\n',
  });
  try {
    assert.equal(escapingImport({ entryPath: join(root, "release-artifact.mjs"), root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
