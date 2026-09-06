## Goal

`RUNTIME_TOOL_FILES` in `packages/runner/scripts/build-runtime-tools.mjs` is the only hand-maintained list of files that cross from the repository into a Run; the other three copies are derived from it or proven equal by a test.

## Background

Survey candidate SIM-RUNNER-004, operator ruling 2026-09-06 (defense theme D3). Four independently edited lists encode one fact: `RUNTIME_TOOL_FILES` (~12-20) and `expectedDirectoryEntries` (~54-57) in `build-runtime-tools.mjs`, `runtimeToolPaths` in `packages/runner/src/runtime-tools.ts` (~25-33, whose comment says it "must stay equal to the release bundle manifest" but nothing enforces it), and the list plus per-directory Set in `scripts/deploy/release-artifact.mjs` (~19-31). The `gate-worker` subdirectory special case is repeated in all of them. The failure already happened once: "fix(runner): bundle the remote gate" added a file present in git and absent from the bundle, the direction no build step catches.

Route: implementation=senior-dev-astra-medium - the inventory is the containment allowlist for what crosses into a Run and release-artifact.mjs is deployment-owned verification

## Changes

1. `expectedDirectoryEntries` is computed from `RUNTIME_TOOL_FILES` inside `build-runtime-tools.mjs`; `assertGeneratedTree` keeps comparing against an independent `readdir`.
2. `scripts/deploy/release-artifact.mjs` imports the manifest (or a JSON export of it generated at build time) instead of restating the list and the per-directory Set.
3. A test asserts `runtimeToolPaths` equals the manifest's destinations, so a file present in git but absent from the bundle, or the reverse, fails the runner unit suite.
4. The `gate-worker` subdirectory rule is stated once, next to the manifest.

## Out of scope

- Changing which files are in the inventory; `public-snapshot.json`; `packages/runner/runtime-tools/**` contents.
- `scripts/deploy/install-launchd*.mjs` and the launchd wrapper (a concurrent chain owns them).

## Constraints

- A source path that does not exist must still fail the build loudly.
- Deployment-owned verification keeps failing closed on a missing or extra file in the deployed tree.

## Acceptance

- `git grep -n "gate-worker" packages/runner/scripts packages/runner/src/runtime-tools.ts scripts/deploy/release-artifact.mjs` shows the subdirectory rule in one place plus derivations.
- `npm run test -w @anneal/runner` (build-runtime-tools.test.mjs, workspace.test.ts and the new equality test), `node --test scripts/deploy/release-directory.test.mjs scripts/deploy/release-snapshot.test.mjs scripts/deploy/quiet-window-deploy.test.mjs`, `npm run lint`, `npm run typecheck` pass.
- Temporarily adding a file to `RUNTIME_TOOL_FILES` without adding it to `runtimeToolPaths` makes the new test fail (demonstrated in the PR body, then reverted).