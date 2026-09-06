import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { RUNTIME_TOOL_FILES } from "./build-runtime-tools.mjs";
import { runtimeToolPaths } from "../src/runtime-tools.ts";

test("runtime tool paths equal the release bundle manifest destinations", () => {
  assert.deepEqual(
    runtimeToolPaths,
    RUNTIME_TOOL_FILES.map(({ destination }) => destination),
    "Run materialization must use every destination in the release bundle manifest",
  );
});

test("repository runtime tool files equal the manifest sources", () => {
  const root = new URL("../runtime-tools/", import.meta.url);
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(fileURLToPath(root), join(entry.parentPath, entry.name)))
    .sort();
  assert.deepEqual(
    files,
    RUNTIME_TOOL_FILES.map(({ source }) => source.replace("packages/runner/runtime-tools/", "")).sort(),
    "Every repository runtime tool must be explicitly bundled",
  );
});
