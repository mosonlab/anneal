## Goal

The five `goal-5a0-*` files under `scripts/`, the `test:dependency-gate` root script, their public-snapshot entries and the instructions that tell readers to run them are gone.

## Background

Survey candidate SIM-OPS-005, operator ruling 2026-09-06: the goal-5a0 authorization-marker design is retired, in line with the earlier blind-review and release-authority retirement. `scripts/goal-5a0-dependency-gate.sh`, `goal-5a0-evidence-destination.sh`, `goal-5a0-handoff-preimage.mjs` and their two `.test.mjs` files (781 lines) implement a supervisor for a plan no longer in the tree; the supervisor needs an operator-supplied `GATE_CHECKS` executable that does not exist, and nothing outside these files reads `evidence-preimage-b64`, `evidence-digest` or `HANDOFF_TASK_MISSING`. They survive through `npm run test:dependency-gate` (not run by the merge gate), five entries in `public-snapshot.json` (~147-151), matching lines in `scripts/public-snapshot-scan.test.mjs` (~370-374), and instructions in `CONTRIBUTING.md` (~56) and `docs/install.md` (~246, ~283-287).

Route: implementation=senior-dev-astra-medium - published-surface removal adjacent to merge-authorization evidence vocabulary, with doc-contract and snapshot-manifest edits that fail closed

## Changes

1. Delete the five `scripts/goal-5a0-*` files and the `test:dependency-gate` script from the root `package.json`.
2. Remove their five entries from `public-snapshot.json` and the matching expectations in `scripts/public-snapshot-scan.test.mjs`.
3. Remove the paragraphs in `CONTRIBUTING.md` and `docs/install.md` that instruct readers to run the harness; keep every string that `scripts/release-docs.test.mjs` pins on those files.
4. Add one bullet under `## Unreleased` in `CHANGELOG.md` stating the harness and its root script are removed.

## Out of scope

- Merge authorization, merge-evidence code, the merge executor, and `docs/release/v0.1.0-release-notes.md` (historical, immutable).
- Any other `scripts/` file or root script.

## Constraints

- `npm run snapshot:scan` must stay closed-scope green in the same commit; no manifest entry may be left pointing at a deleted path.

## Acceptance

- `git grep -n "goal-5a0\|dependency-gate\|handoff-preimage\|evidence-destination\|evidence-preimage-b64\|HANDOFF_TASK_MISSING" -- . ":(exclude).chain/**" ":(exclude)packages/db/prisma/migrations/20260818000000_goal_execution_safety_kernel/migration.sql"` returns only CHANGELOG.md and historical release notes. The chain specification is excluded because it records the retired names; the exact applied migration is excluded solely for its unchanged historical plan/spec provenance comments.
- `npm run test:snapshot-scan`, `npm run snapshot:scan`, `npm run test:release-docs`, `npm run test:frozen-docs`, `npm run lint` pass.