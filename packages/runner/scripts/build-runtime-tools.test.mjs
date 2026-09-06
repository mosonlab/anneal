import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildRuntimeTools, RUNTIME_TOOL_FILES, expectedDirectoryEntries } from "./build-runtime-tools.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-runner-runtime-tools-"));
  const repositoryRoot = join(root, "checkout");
  const packageRoot = join(root, "packages", "runner");
  for (const { source } of RUNTIME_TOOL_FILES) {
    const path = join(repositoryRoot, source);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `canonical:${source}\n`);
  }
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repositoryRoot, packageRoot, outputRoot: join(packageRoot, "dist/runtime-tools") };
};

const inventory = (root) => {
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path, relative);
      else files.push(relative);
    }
  };
  visit(root);
  return files.sort();
};

test("buildRuntimeTools preserves each source runtime-tool's exact bytes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-runner-target-runtime-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, "packages", "runner");
  const { outputRoot } = buildRuntimeTools({ packageRoot });

  assert.deepEqual(
    inventory(outputRoot),
    RUNTIME_TOOL_FILES.map(({ destination }) => destination).sort(),
  );
  for (const { source, destination } of RUNTIME_TOOL_FILES) {
    assert.deepEqual(
      readFileSync(join(outputRoot, destination)),
      readFileSync(join(repositoryRoot, source)),
      destination,
    );
  }
});

test("bundled runtime tools do not emit the retired scripts/gate-worker path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-runner-harness-runtime-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { outputRoot } = buildRuntimeTools({ packageRoot: join(root, "packages", "runner") });

  for (const { destination } of RUNTIME_TOOL_FILES) {
    assert.doesNotMatch(readFileSync(join(outputRoot, destination), "utf8"), /scripts\/gate-worker\//u);
  }
});

test("buildRuntimeTools creates the exact byte-identical tree and purges stale files", (t) => {
  const context = fixture(t);
  const first = buildRuntimeTools(context);
  assert.equal(first.outputRoot, context.outputRoot);
  assert.deepEqual(inventory(context.outputRoot), [
    "gate-worker/gate-dispatch.sh",
    "gate-worker/lib.sh",
    "gate-worker/mirror-push.sh",
    "gate-worker/remote-gate.sh",
    "gate-worker/run-gate.sh",
    "git-credential-runner.sh",
    "regression-verification.sh",
  ]);
  for (const { source, destination } of RUNTIME_TOOL_FILES) {
    const expected = readFileSync(join(context.repositoryRoot, source), "utf8");
    assert.equal(readFileSync(join(context.outputRoot, destination), "utf8"), expected);
  }

  writeFileSync(join(context.outputRoot, "stale-file"), "must be removed\n");
  mkdirSync(join(context.outputRoot, "stale-directory"));
  writeFileSync(join(context.outputRoot, "stale-directory", "nested"), "must be removed\n");
  buildRuntimeTools(context);
  assert.equal(existsSync(join(context.outputRoot, "stale-file")), false);
  assert.equal(existsSync(join(context.outputRoot, "stale-directory")), false);
});

test("buildRuntimeTools resolves sources from the repository root, not cwd", (t) => {
  const context = fixture(t);
  const previous = process.cwd();
  process.chdir(context.root);
  try {
    buildRuntimeTools(context);
  } finally {
    process.chdir(previous);
  }
  assert.equal(existsSync(join(context.outputRoot, "regression-verification.sh")), true);
});

test("buildRuntimeTools refuses a missing or non-regular source before replacing output", (t) => {
  const context = fixture(t);
  buildRuntimeTools(context);
  const existing = readFileSync(join(context.outputRoot, "regression-verification.sh"));
  rmSync(join(context.repositoryRoot, "packages/runner/runtime-tools/regression-verification.sh"));
  assert.throws(
    () => buildRuntimeTools(context),
    /runner-runtime-tools: source:packages\/runner\/runtime-tools\/regression-verification\.sh-missing/u,
  );
  assert.deepEqual(readFileSync(join(context.outputRoot, "regression-verification.sh")), existing);

  writeFileSync(join(context.repositoryRoot, "packages/runner/runtime-tools/regression-verification.sh"), "restored\n");
  rmSync(join(context.repositoryRoot, "packages/runner/runtime-tools/regression-verification.sh"));
  // A symlink is not a canonical regular source, even when its target exists.
  nodeFs.symlinkSync(
    join(context.repositoryRoot, "packages/runner/runtime-tools/gate-worker/lib.sh"),
    join(context.repositoryRoot, "packages/runner/runtime-tools/regression-verification.sh"),
  );
  assert.throws(
    () => buildRuntimeTools(context),
    /runner-runtime-tools: source:packages\/runner\/runtime-tools\/regression-verification\.sh-not-a-regular-file/u,
  );
});

test("buildRuntimeTools turns copy and byte-integrity failures into build failures", (t) => {
  const context = fixture(t);
  const copyFailureFilesystem = {
    ...nodeFs,
    writeFileSync: () => { throw new Error("injected copy failure"); },
  };
  assert.throws(
    () => buildRuntimeTools({ ...context, filesystem: copyFailureFilesystem }),
    // The first tool copied, whichever it is: the assertion is that a copy
    // failure surfaces as a build failure, not that a given file leads.
    new RegExp(`runner-runtime-tools: copy-failed:${RUNTIME_TOOL_FILES[0].destination.replace(".", "\\.")}`, "u"),
  );

  const byteMismatchFilesystem = {
    ...nodeFs,
    writeFileSync: (destination, bytes) => {
      nodeFs.writeFileSync(destination, bytes);
      nodeFs.writeFileSync(destination, "tampered\n");
    },
  };
  assert.throws(
    () => buildRuntimeTools({ ...context, filesystem: byteMismatchFilesystem }),
    new RegExp(`runner-runtime-tools: byte-mismatch:${RUNTIME_TOOL_FILES[0].destination.replace(".", "\\.")}`, "u"),
  );
  assert.equal(existsSync(context.outputRoot), false);
});

test("generated scripts retain their source modes while the tree remains regular files", (t) => {
  const context = fixture(t);
  chmodSync(join(context.repositoryRoot, "packages/runner/runtime-tools/regression-verification.sh"), 0o751);
  buildRuntimeTools(context);
  assert.equal(lstatSync(join(context.outputRoot, "regression-verification.sh")).mode & 0o777, 0o751);
  for (const path of inventory(context.outputRoot)) {
    assert.equal(lstatSync(join(context.outputRoot, path)).isFile(), true);
  }
});

test("buildRuntimeTools derives new nested directories from manifest destinations", async (t) => {
  const context = fixture(t);
  const scriptPath = join(context.root, "build-runtime-tools.mjs");
  const destination = "additional/nested/tool.sh";
  const source = RUNTIME_TOOL_FILES[0].source;
  const script = readFileSync(new URL("./build-runtime-tools.mjs", import.meta.url), "utf8");
  writeFileSync(scriptPath, script.replace(
    "export const RUNTIME_TOOL_FILES = Object.freeze([",
    `export const RUNTIME_TOOL_FILES = Object.freeze([\n  Object.freeze(${JSON.stringify({ source, destination })}),`,
  ));
  const target = await import(pathToFileURL(scriptPath).href);
  target.buildRuntimeTools(context);
  assert.deepEqual(inventory(context.outputRoot), [
    ...RUNTIME_TOOL_FILES.map(({ destination }) => destination),
    destination,
  ].sort());
  assert.deepEqual(
    readFileSync(join(context.outputRoot, destination)),
    readFileSync(join(context.repositoryRoot, source)),
  );
});

test("directory inventory readers cannot widen later build allowlists", (t) => {
  const context = fixture(t);
  const entries = expectedDirectoryEntries();
  entries.get("").add("unexpected.sh");
  entries.set("unexpected-directory", new Set());
  assert.equal(expectedDirectoryEntries().get("").has("unexpected.sh"), false);
  assert.equal(expectedDirectoryEntries().has("unexpected-directory"), false);
  const filesystem = {
    ...nodeFs,
    readdirSync: (path, options) => [
      ...nodeFs.readdirSync(path, options),
      { name: "unexpected.sh" },
    ],
  };
  assert.throws(() => buildRuntimeTools({ ...context, filesystem }), /generated-tree-inventory-mismatch/u);
});
