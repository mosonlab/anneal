import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const deployRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Module edges come from a real parse, not a pattern match. A hand-rolled
 * regular expression misses valid spellings - `import{x}from"..."` with no
 * spaces, a comment between the keyword and the specifier, a second
 * declaration on one line - and a missed edge is an escape the check would
 * pass. A parse error is a violation too, for the same fail-loud reason.
 */
const parseModule = (path, source) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);

const staticImportSpecifiers = (sourceFile) => {
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    const moduleSpecifier = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
      ? statement.moduleSpecifier
      : undefined;
    if (moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)) specifiers.push(moduleSpecifier.text);
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
    const sourceFile = parseModule(importer, source);
    const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
    if (parseDiagnostics.length > 0) {
      const detail = ts.flattenDiagnosticMessageText(parseDiagnostics[0].messageText, "; ");
      return { importer, specifier: "", detail: `unparsable-${detail}` };
    }
    for (const specifier of staticImportSpecifiers(sourceFile)) {
      // `isBuiltin` already accepts both the bare and the `node:` spelling, so it
      // decides alone: trusting the `node:` prefix would skip `node:not-a-builtin`,
      // an edge that resolves nowhere, instead of reporting it.
      if (isBuiltin(specifier)) continue;
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

// The spellings below are all valid ESM that a line-anchored pattern match
// misses. Each one is the shape of the edge that broke deployment, so each one
// must still be reported with its importer and specifier.
test("an unspaced import declaration is reported", () => {
  const root = fixture({
    "release-artifact.mjs": 'import{helper}from"./helper.mjs";\nexport const verify = helper;\n',
    "helper.mjs": 'import{RUNTIME_TOOL_FILES}from"../../packages/runner/scripts/build-runtime-tools.mjs";\n'
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unspaced export-from declaration is reported", () => {
  const root = fixture({
    "release-artifact.mjs": 'export{RUNTIME_TOOL_FILES}from"../../packages/runner/scripts/build-runtime-tools.mjs";\n',
  });
  try {
    const violation = escapingImport({ entryPath: join(root, "release-artifact.mjs"), root });
    assert.equal(violation?.specifier, "../../packages/runner/scripts/build-runtime-tools.mjs");
    assert.equal(violation?.detail, "outside-root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a comment between the keyword and the specifier does not hide the edge", () => {
  const root = fixture({
    "release-artifact.mjs": 'import/* legal separator */"../../outside.mjs";\nexport const verify = null;\n',
  });
  try {
    const violation = escapingImport({ entryPath: join(root, "release-artifact.mjs"), root });
    assert.equal(violation?.specifier, "../../outside.mjs");
    assert.equal(violation?.detail, "outside-root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second declaration on the same line is walked too", () => {
  const root = fixture({
    "release-artifact.mjs": 'import "./inside.mjs"; import "../../outside.mjs";\nexport const verify = null;\n',
    "inside.mjs": "export const inside = true;\n",
  });
  try {
    const violation = escapingImport({ entryPath: join(root, "release-artifact.mjs"), root });
    assert.equal(violation?.specifier, "../../outside.mjs");
    assert.equal(violation?.detail, "outside-root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a specifier mentioned in a comment or a string is not an edge", () => {
  const root = fixture({
    "release-artifact.mjs": '// import "../../packages/runner/scripts/build-runtime-tools.mjs";\n'
      + 'export const note = \'import "../../outside.mjs";\';\n',
  });
  try {
    assert.equal(escapingImport({ entryPath: join(root, "release-artifact.mjs"), root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a module the parser cannot read is a violation rather than an empty graph", () => {
  const root = fixture({ "release-artifact.mjs": 'import { helper } from "./helper.mjs"\n{{{\n' });
  try {
    const violation = escapingImport({ entryPath: join(root, "release-artifact.mjs"), root });
    assert.equal(violation?.importer, join(root, "release-artifact.mjs"));
    assert.match(violation?.detail ?? "", /^unparsable-/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a node: specifier that is not a builtin is a violation rather than a skipped edge", () => {
  const root = fixture({
    "release-artifact.mjs": 'import { helper } from "./helper.mjs";\nexport const verify = helper;\n',
    "helper.mjs": 'import "node:not-a-builtin";\nexport const helper = null;\n',
  });
  try {
    const violation = escapingImport({ entryPath: join(root, "release-artifact.mjs"), root });
    assert.deepEqual(
      { importer: violation?.importer, specifier: violation?.specifier, detail: violation?.detail },
      { importer: join(root, "helper.mjs"), specifier: "node:not-a-builtin", detail: "not-a-relative-module" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
