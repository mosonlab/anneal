import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyDiff, FAST_DOCUMENTS } from "./merge-gate-profile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const changes = (...entries) => Buffer.from(`${entries.flat().join("\0")}\0`);

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

// A path spelled `join(here, "..", "..", "docs", "runbooks", "gate-worker.md")`
// is the same reference as one spelled in a single literal, so the segment
// separators are collapsed back into slashes before the literals are read out.
// Resolved against the file that names it, never against the repository root:
// `"AGENTS.md"` in a fixture that classifies diff entries names a diff entry,
// while `"../../docs/runbooks/gate-worker.md"` names this repository's copy of
// the file, and only the second is a document that fixture reads.
const referencedDocuments = (file) => {
  const source = readFileSync(file, "utf8").replace(/(["'])\s*,\s*\1/gu, "/");
  return [...source.matchAll(/["'`]([^"'`\n]*\.md)["'`]/gu)]
    .map((match) => resolve(dirname(file), match[1]))
    .filter((path) => !relative(repoRoot, path).startsWith(".."))
    .map((path) => relative(repoRoot, path));
};

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
