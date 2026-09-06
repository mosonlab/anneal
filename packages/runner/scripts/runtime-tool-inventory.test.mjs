import assert from "node:assert/strict";
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
