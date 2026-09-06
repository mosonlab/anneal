#!/usr/bin/env node

import * as nodeFs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_TOOL_FILES, expectedDirectoryEntries } from "../../../scripts/deploy/runtime-tool-inventory.mjs";

/**
 * The inventory itself is declared in `scripts/deploy/`, the one directory
 * every release builder has always copied into an artifact, so the release
 * verifier can read it without importing across into this package. This module
 * re-exports it, keeping the build's import surface unchanged.
 */
export { RUNTIME_TOOL_FILES, expectedDirectoryEntries } from "../../../scripts/deploy/runtime-tool-inventory.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(scriptDirectory, "../../..");
const defaultPackageRoot = resolve(scriptDirectory, "..");

const failure = (detail, cause) => {
  const error = new Error(`runner-runtime-tools: ${detail}`);
  if (cause !== undefined) error.cause = cause;
  throw error;
};

const regularFile = (filesystem, path, label) => {
  let status;
  try {
    status = filesystem.lstatSync(path);
  } catch (error) {
    failure(`${label}-missing`, error);
  }
  if (status.isSymbolicLink() || !status.isFile()) failure(`${label}-not-a-regular-file`);
  return status;
};

const directory = (filesystem, path, label) => {
  let status;
  try {
    status = filesystem.lstatSync(path);
  } catch (error) {
    failure(`${label}-missing`, error);
  }
  if (status.isSymbolicLink() || !status.isDirectory()) failure(`${label}-not-a-directory`);
  return status;
};

const assertGeneratedTree = (filesystem, outputRoot, sourceRoot) => {
  directory(filesystem, outputRoot, "generated-root");

  for (const [relativeDirectory, names] of expectedDirectoryEntries()) {
    const current = relativeDirectory === "" ? outputRoot : join(outputRoot, relativeDirectory);
    if (relativeDirectory !== "") directory(filesystem, current, `generated-${relativeDirectory}`);
    const entries = filesystem.readdirSync(current, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort();
    const expected = [...names].sort();
    if (JSON.stringify(entries) !== JSON.stringify(expected)) {
      failure(`generated-tree-inventory-mismatch:${relativeDirectory || "."}`);
    }
  }

  for (const { source, destination } of RUNTIME_TOOL_FILES) {
    const sourcePath = resolve(sourceRoot, source);
    const destinationPath = join(outputRoot, destination);
    regularFile(filesystem, destinationPath, `generated-file:${destination}`);
    const sourceBytes = filesystem.readFileSync(sourcePath);
    const destinationBytes = filesystem.readFileSync(destinationPath);
    if (!sourceBytes.equals(destinationBytes)) failure(`byte-mismatch:${destination}`);
  }
};

const replaceGeneratedTree = (filesystem, stageRoot, outputRoot) => {
  const backupRoot = `${outputRoot}.previous-${process.pid}-${Date.now()}`;
  let movedExisting = false;
  let installed = false;
  try {
    if (filesystem.existsSync(outputRoot)) {
      directory(filesystem, outputRoot, "generated-destination");
      filesystem.renameSync(outputRoot, backupRoot);
      movedExisting = true;
    }
    filesystem.renameSync(stageRoot, outputRoot);
    installed = true;
    if (movedExisting) filesystem.rmSync(backupRoot, { recursive: true, force: true });
  } catch (error) {
    if (installed && filesystem.existsSync(outputRoot)) {
      try { filesystem.rmSync(outputRoot, { recursive: true, force: true }); } catch { /* preserve original failure */ }
    }
    if (movedExisting && filesystem.existsSync(backupRoot) && !filesystem.existsSync(outputRoot)) {
      try { filesystem.renameSync(backupRoot, outputRoot); } catch { /* preserve original failure */ }
    }
    throw error;
  }
};

/**
 * Rebuild the release-local runtime tool tree from the canonical repository
 * files.  `filesystem` is injectable so the build contract can exercise copy
 * and byte-integrity failures without relying on host permissions.
 */
export const buildRuntimeTools = ({
  repositoryRoot = defaultRepositoryRoot,
  packageRoot = defaultPackageRoot,
  filesystem = nodeFs,
} = {}) => {
  const sourceRoot = resolve(repositoryRoot);
  const outputRoot = resolve(packageRoot, "dist/runtime-tools");
  const distRoot = dirname(outputRoot);

  // Check every source before moving an existing output. A broken checkout
  // therefore cannot erase the last usable generated tree.
  const sourceStats = new Map();
  for (const { source } of RUNTIME_TOOL_FILES) {
    const sourcePath = resolve(sourceRoot, source);
    sourceStats.set(source, regularFile(filesystem, sourcePath, `source:${source}`));
  }

  filesystem.mkdirSync(distRoot, { recursive: true, mode: 0o755 });
  let stageRoot;
  try {
    stageRoot = filesystem.mkdtempSync(join(distRoot, ".runtime-tools-stage-"));
    for (const relativeDirectory of expectedDirectoryEntries().keys()) {
      if (relativeDirectory) filesystem.mkdirSync(join(stageRoot, relativeDirectory), { recursive: true, mode: 0o755 });
    }
    for (const { source, destination } of RUNTIME_TOOL_FILES) {
      const sourcePath = resolve(sourceRoot, source);
      const destinationPath = join(stageRoot, destination);
      try {
        filesystem.writeFileSync(destinationPath, filesystem.readFileSync(sourcePath));
        // Preserve the source mode so generated scripts remain useful when
        // inspected directly;
        // per-Run materialization applies its stricter 0500 mode later.
        filesystem.chmodSync(destinationPath, sourceStats.get(source).mode & 0o777);
      } catch (error) {
        failure(`copy-failed:${destination}`, error);
      }
    }

    assertGeneratedTree(filesystem, stageRoot, sourceRoot);
    replaceGeneratedTree(filesystem, stageRoot, outputRoot);
    stageRoot = undefined;
    // Verify the installed tree too. This catches a filesystem that accepted
    // the rename but changed bytes or entries while installing it.
    assertGeneratedTree(filesystem, outputRoot, sourceRoot);
  } finally {
    if (stageRoot !== undefined && filesystem.existsSync(stageRoot)) {
      filesystem.rmSync(stageRoot, { recursive: true, force: true });
    }
  }

  return Object.freeze({
    outputRoot,
    files: Object.freeze(RUNTIME_TOOL_FILES.map(({ destination }) => join(outputRoot, destination))),
  });
};

const isEntryPoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntryPoint) {
  try {
    const result = buildRuntimeTools();
    process.stdout.write(`runner runtime tools: ${result.files.length} files -> ${result.outputRoot}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
