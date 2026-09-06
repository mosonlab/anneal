/**
 * The inventory of scripts that cross from the release bundle into a Run's
 * scratch tools directory.
 *
 * It lives apart from both consumers because they would otherwise import each
 * other: `workspace.ts` materializes exactly these paths, and `adapters.ts`
 * pins one of them into a session's git configuration.
 */

/**
 * The credential helper the agent adapters pin into a session's git config.
 * Naming it here keeps the pinned path provably one of the materialized tools:
 * a helper the materialization never copies makes every authenticated fetch in
 * a session fail with git's non-interactive credential error, and a public
 * remote hides that for as long as the helper is never consulted.
 */
export const gitCredentialHelperTool = "git-credential-runner.sh";

/**
 * The exact inventory a Run receives. It must stay equal to the release bundle
 * manifest in `packages/runner/scripts/build-runtime-tools.mjs`: the
 * materialization copies, verifies and mode-checks precisely these paths and
 * rejects any other entry at the destination.
 */
export const runtimeToolPaths = Object.freeze([
  gitCredentialHelperTool,
  "merge-train.sh",
  "merge-train.mjs",
  "regression-verification.sh",
  "gate-worker/gate-dispatch.sh",
  "gate-worker/lib.sh",
  "gate-worker/mirror-push.sh",
  "gate-worker/remote-gate.sh",
  "gate-worker/run-gate.sh",
]);
