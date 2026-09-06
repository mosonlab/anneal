import assert from "node:assert/strict";
import test from "node:test";

import * as runnerBuild from "../../packages/runner/scripts/build-runtime-tools.mjs";
import { RUNTIME_TOOL_FILES, expectedDirectoryEntries } from "./runtime-tool-inventory.mjs";

// The inventory moved from packages/runner/scripts into scripts/deploy so the
// release verifier can read it out of any artifact. Moving it must not change
// what the build writes or what the verifier expects, so the content is frozen
// here entry for entry and directory for directory.
const DECLARED_FILES = [
  { source: "packages/runner/runtime-tools/git-credential-runner.sh", destination: "git-credential-runner.sh" },
  { source: "packages/runner/runtime-tools/regression-verification.sh", destination: "regression-verification.sh" },
  { source: "packages/runner/runtime-tools/gate-worker/gate-dispatch.sh", destination: "gate-worker/gate-dispatch.sh" },
  { source: "packages/runner/runtime-tools/gate-worker/lib.sh", destination: "gate-worker/lib.sh" },
  { source: "packages/runner/runtime-tools/gate-worker/mirror-push.sh", destination: "gate-worker/mirror-push.sh" },
  { source: "packages/runner/runtime-tools/gate-worker/remote-gate.sh", destination: "gate-worker/remote-gate.sh" },
  { source: "packages/runner/runtime-tools/gate-worker/run-gate.sh", destination: "gate-worker/run-gate.sh" },
];

const DECLARED_DIRECTORY_ENTRIES = [
  ["", ["git-credential-runner.sh", "regression-verification.sh", "gate-worker"]],
  ["gate-worker", ["gate-dispatch.sh", "lib.sh", "mirror-push.sh", "remote-gate.sh", "run-gate.sh"]],
];

test("RUNTIME_TOOL_FILES is unchanged in content", () => {
  assert.deepEqual(RUNTIME_TOOL_FILES.map(({ source, destination }) => ({ source, destination })), DECLARED_FILES);
  assert.ok(Object.isFrozen(RUNTIME_TOOL_FILES));
  for (const entry of RUNTIME_TOOL_FILES) assert.ok(Object.isFrozen(entry));
});

test("expectedDirectoryEntries is unchanged in content", () => {
  assert.deepEqual(
    [...expectedDirectoryEntries()].map(([directory, names]) => [directory, [...names]]),
    DECLARED_DIRECTORY_ENTRIES,
  );
});

test("the runner build reads the same declaration rather than a second copy", () => {
  assert.equal(runnerBuild.RUNTIME_TOOL_FILES, RUNTIME_TOOL_FILES);
  assert.equal(runnerBuild.expectedDirectoryEntries, expectedDirectoryEntries);
});
