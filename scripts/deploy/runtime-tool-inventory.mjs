/**
 * The runtime-tool inventory, declared once for both readers: the runner build
 * that produces `packages/runner/dist/runtime-tools`, and the release-artifact
 * verifier that checks the tree an artifact ships.
 *
 * It lives under `scripts/deploy/` and imports nothing, not even a Node
 * builtin, because the verifier's module graph must load out of an artifact
 * built by any older release (see `loadTargetVerifier` in
 * `release-artifact.mjs`). Keep it a pure declaration with no filesystem
 * access.
 */

/**
 * These are the only scripts that cross from the repository into an Anneal
 * Run.  Keep the source paths explicit: a broad copy would make an unrelated
 * gate-worker helper part of the runner's release contract by accident.
 */
export const RUNTIME_TOOL_FILES = Object.freeze([
  Object.freeze({ source: "packages/runner/runtime-tools/git-credential-runner.sh", destination: "git-credential-runner.sh" }),
  Object.freeze({ source: "packages/runner/runtime-tools/regression-verification.sh", destination: "regression-verification.sh" }),
  Object.freeze({ source: "packages/runner/runtime-tools/gate-worker/gate-dispatch.sh", destination: "gate-worker/gate-dispatch.sh" }),
  Object.freeze({ source: "packages/runner/runtime-tools/gate-worker/lib.sh", destination: "gate-worker/lib.sh" }),
  Object.freeze({ source: "packages/runner/runtime-tools/gate-worker/mirror-push.sh", destination: "gate-worker/mirror-push.sh" }),
  Object.freeze({ source: "packages/runner/runtime-tools/gate-worker/remote-gate.sh", destination: "gate-worker/remote-gate.sh" }),
  Object.freeze({ source: "packages/runner/runtime-tools/gate-worker/run-gate.sh", destination: "gate-worker/run-gate.sh" }),
]);

// Destination components declare the subdirectory layout (including gate-worker).
// Both build and deployment compare this derived inventory with independent reads.
export const expectedDirectoryEntries = () => {
  const entries = new Map([["", new Set()]]);
  for (const { destination } of RUNTIME_TOOL_FILES) {
    const components = destination.split("/");
    let directory = "";
    for (const [index, name] of components.entries()) {
      entries.get(directory).add(name);
      if (index < components.length - 1) {
        directory = directory ? `${directory}/${name}` : name;
        if (!entries.has(directory)) entries.set(directory, new Set());
      }
    }
  }
  return entries;
};
