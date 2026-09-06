import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyDiff, FAST_DOCUMENTS, FROZEN_RECORD_DIRECTORIES } from "./merge-gate-profile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const frozenCheckerPath = join(here, "check-frozen-docs.sh");

const changes = (...entries) => Buffer.from(`${entries.flat().join("\0")}\0`);

test("the frozen directory allowlists stay equal", () => {
  const source = readFileSync(frozenCheckerPath, "utf8");
  const match = source.match(/^FROZEN_RECORD_DIRECTORIES=\(([^)]*)\)$/mu);
  assert.ok(match, "check-frozen-docs.sh must declare FROZEN_RECORD_DIRECTORIES");
  const checkerDirectories = match[1].trim().split(/\s+/u).map((directory) => `${directory}/`);
  assert.deepEqual(checkerDirectories, FROZEN_RECORD_DIRECTORIES);
});

test("modified allowlisted prose selects docs-only", () => {
  assert.equal(classifyDiff({ nameStatus: changes("M", "AGENTS.md") }), "docs-only");
  for (const path of [
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "docs/BRIEF-TEMPLATE.md",
    "docs/public-snapshot.md",
  ]) {
    assert.equal(classifyDiff({ nameStatus: changes("M", path) }), "docs-only", path);
  }
  assert.equal(
    classifyDiff({
      nameStatus: changes(
        "M", "docs/governance/task-routing-v1.md",
        "M", "docs/public-snapshot.md",
      ),
    }),
    "docs-only",
  );
  assert.equal(
    classifyDiff({ nameStatus: changes("M", "docs/reviews/2026-08-23-review.md") }),
    "docs-only",
  );
});

test("runtime-coupled documentation selects the full gate", () => {
  for (const path of [
    "README.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "docs/release/v0.2.0-release-notes.md",
    "docs/demos/templates-release-demo.md",
    "docs/runbooks/merge-executor.md",
    "docs/runbooks/quiet-window-auto-deploy.md",
    // Not prose the gate may skip its suites for: two fixture files read this
    // runbook and assert against its text, so editing it can fail the suite
    // that a docs-only profile would not have run.
    "docs/runbooks/gate-worker.md",
    "agents/roles/senior-dev-astra-medium.md",
  ]) {
    assert.equal(classifyDiff({ nameStatus: changes("M", path) }), "full", path);
  }
});

test("code, configuration, and gate changes select the full gate", () => {
  for (const path of [
    "package.json",
    "public-snapshot.json",
    "scripts/merge-gate.sh",
    "scripts/merge-gate-profile.mjs",
    "packages/api/src/app.ts",
  ]) {
    assert.equal(classifyDiff({ nameStatus: changes("M", path) }), "full", path);
  }
});

test("structural changes and empty ranges select the full gate", () => {
  assert.equal(classifyDiff({ nameStatus: Buffer.alloc(0) }), "full");
  assert.equal(classifyDiff({ nameStatus: changes("A", "AGENTS.md") }), "full");
  assert.equal(classifyDiff({ nameStatus: changes("D", "AGENTS.md") }), "full");
  assert.equal(
    classifyDiff({ nameStatus: changes("R100", "AGENTS.md", "docs/AGENTS.md") }),
    "full",
  );
  assert.equal(
    classifyDiff({ nameStatus: changes("M", "AGENTS.md"), summary: " mode change 100644 => 100755 AGENTS.md\n" }),
    "full",
  );
});

test("one non-prose path makes a mixed diff full", () => {
  assert.equal(
    classifyDiff({ nameStatus: changes("M", "AGENTS.md", "M", "packages/api/src/app.ts") }),
    "full",
  );
});

// --- the allowlist is still a list of documents no suite reads ---------------

// The membership rule, held mechanically. A document a fixture opens by path is
// an input to that fixture: editing it can fail the suite, so a profile that
// skips the suite lets the breakage surface in the next full gate of an
// unrelated commit — a gate for somebody else's branch reporting a failure that
// is not in it. docs/runbooks/gate-worker.md was on the allowlist while
// gate-worker.test.mjs and gate-dispatch.test.mjs both read it, and nothing
// would have said so.
const SUITE_ROOTS = [
  { root: join(repoRoot, "scripts"), matches: (name) => name.endsWith(".test.mjs") },
  { root: join(repoRoot, "packages"), matches: (name) => /\.test\.[cm]?[jt]sx?$/u.test(name) },
];
const NOT_SOURCE = new Set(["node_modules", "dist", "generated", ".git"]);

const suiteFiles = (dir, matches, found = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!NOT_SOURCE.has(entry.name)) suiteFiles(join(dir, entry.name), matches, found);
    } else if (entry.isFile() && matches(entry.name)) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
};

// Follow file-reader arguments and their local bindings. Tokenizing keeps
// fixture strings (which may themselves contain example code) opaque, and
// only joins path segments inside join/resolve calls, never inside arrays.
const referencedDocuments = (file, source = readFileSync(file, "utf8")) => {
  const tokens = [...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/gu)]
    .map(([token]) => token).filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  const closing = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
  const endOf = (start) => {
    const stack = [];
    for (let i = start; i < tokens.length; i++) {
      const token = tokens[i];
      if (!stack.length && [",", ";", ")", "]", "}"].includes(token)) return i;
      if (closing.has(token)) stack.push(closing.get(token));
      else if (token === stack.at(-1)) stack.pop();
    }
    return tokens.length;
  };
  const scopes = [];
  const scopeStack = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "}") scopeStack.pop();
    scopes[i] = [...scopeStack];
    if (tokens[i] === "{") scopeStack.push(i);
  }
  const bindings = new Map();
  for (let i = 0; i < tokens.length; i++) {
    if (["const", "let", "var"].includes(tokens[i]) && ["=", "of"].includes(tokens[i + 2])) {
      const name = tokens[i + 1];
      const values = bindings.get(name) ?? [];
      const value = tokens.slice(i + 3, endOf(i + 3));
      if (value.some((token, index) => token === "function" || (token === "=" && value[index + 1] === ">"))) continue;
      values.push({ value, start: i + 3, scope: scopes[i], declaration: i });
      bindings.set(name, values);
    }
  }
  const paths = new Set();
  const follow = (expression, start, seen = new Set()) => {
    // Consecutive literal segments are joined only within path construction.
    const text = expression.join(" ").replace(/\b(?:join|resolve)\s*\(([^()]*)\)/gu,
      (_, args) => args.replace(/(["'])\s*,\s*\1/gu, "/"));
    for (const match of text.matchAll(/["'`]([^"'`\n]*\.md)["'`]/gu)) {
      for (const base of [dirname(file), repoRoot]) {
        const path = relative(repoRoot, resolve(base, match[1]));
        if (!path.startsWith("..")) paths.add(path);
      }
    }
    for (let offset = 0; offset < expression.length; offset++) {
      const candidates = bindings.get(expression[offset]) ?? [];
      const scope = scopes[start + offset];
      const binding = candidates.filter((candidate) => candidate.declaration < start + offset
        && candidate.scope.every((part, index) => scope[index] === part))
        .sort((a, b) => b.scope.length - a.scope.length || b.declaration - a.declaration)[0];
      if (!binding || seen.has(binding)) continue;
      seen.add(binding);
      follow(binding.value, binding.start, seen);
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    if (["readFileSync", "readFile", "createReadStream"].includes(tokens[i]) && tokens[i + 1] === "(") {
      follow(tokens.slice(i + 2, endOf(i + 2)), i + 2);
    }
  }
  return [...paths];
};

test("document guard follows root-anchored reads and path variables", (t) => {
  const root = mkdtempSync(join(tmpdir(), "document-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "guard-fixture.test.mjs");
  for (const source of [
    'readFileSync(join(repoRoot, "SECURITY.md"), "utf8");',
    'const doc = resolve(repoRoot, "SECURITY.md"); readFile(doc);',
    'const docs = ["AGENTS.md", "SECURITY.md"]; for (const doc of docs) { createReadStream(doc); }',
  ]) {
    writeFileSync(file, source);
    assert.ok(referencedDocuments(file).includes("SECURITY.md"), source);
  }
  assert.deepEqual(referencedDocuments(file, 'classifyDiff({ nameStatus: changes("M", "SECURITY.md") });'), []);
  assert.deepEqual(referencedDocuments(file,
    '{ const path = "SECURITY.md"; } { const path = "package.json"; readFileSync(path); }'), []);
  for (const name of ["gate-worker", "gate-dispatch"]) {
    assert.ok(referencedDocuments(join(here, "gate-worker", `${name}.test.mjs`))
      .includes("docs/runbooks/gate-worker.md"));
  }
});

test("no allowlisted document is read by a suite the docs-only profile skips", () => {
  const offences = [];
  for (const { root, matches } of SUITE_ROOTS) {
    for (const file of suiteFiles(root, matches)) {
      for (const document of referencedDocuments(file)) {
        if (FAST_DOCUMENTS.has(document)) {
          offences.push(`${relative(repoRoot, file)} reads ${document}`);
        }
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    "a document on the docs-only allowlist is fixture input; remove it from FAST_DOCUMENTS",
  );
});
