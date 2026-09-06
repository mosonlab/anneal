## Goal

No `scripts/**/*.test.mjs` is executed by nothing; the `test:gate-worker` alias and the gate's inline list cannot drift apart silently; `check-frozen-docs.sh` and the gate profile classifier cite real documents and share one directory list.

## Background

Survey candidates SIM-OPS-004, SIM-OPS-007, SIM-OPS-003 and SIM-DOCS-007, operator ruling 2026-09-06 (defense theme D2): wire in rather than delete; keep the frozen-record check including its supersession-marker rule. Facts: `scripts/setup-local.test.mjs`, `scripts/verify-secret-hygiene.test.mjs`, `scripts/compose-binding.test.mjs`, `scripts/repo-contract-merge-gate.test.mjs` and `scripts/merge-lease-adapter.test.mjs` appear in no merge-gate step (`scripts/merge-gate.sh`) and only in root aliases nothing invokes. `test:gate-worker` in the root `package.json` names a file list that `merge-gate.sh` (~1171) restates inline, and the two differ (3 files vs 5). `scripts/check-frozen-docs.sh` (~3) and `merge-gate.sh` (~53) cite an `AGENTS.md "Frozen records"` section that does not exist (the owner is CONTRIBUTING.md "Records that do not change"), the script's ref-guessing fallback names `master`, and `scripts/merge-gate-profile.mjs` (~15-20) holds a second copy of the `FROZEN_RECORD_DIRECTORIES` list.

Route: implementation=senior-dev-astra-medium - edits scripts/merge-gate.sh and gate-worker evidence lists on the defense list; group membership and concurrency are what the gate's parallel-group rewrite exists to protect

## Changes

1. Add the five unexecuted suites to one install-free parallel group in `scripts/merge-gate.sh`, respecting the group concurrency invariant documented in that file; `scripts/merge-gate-parallel.test.mjs` proves the group shape.
2. `test:gate-worker` and the gate's inline gate-worker list agree: derive one from the other or add a fixture in `scripts/gate-worker/gate-worker.test.mjs` that fails when the two lists differ.
3. `check-frozen-docs.sh` header, its failure output and `merge-gate.sh` cite `CONTRIBUTING.md` "Records that do not change"; the ref fallback names `main` or states that a hand run requires `--master`; `merge-gate-profile.mjs` and `check-frozen-docs.sh` share one `FROZEN_RECORD_DIRECTORIES` source or a test proves the two lists are equal. Rule 2 (supersession marker) stays as is.

## Out of scope

- Running `scripts/merge-gate.sh` or any gate-worker script inside the Run (forbidden); gate evidence comes from the chain's Regression step.
- Deleting any test file or root alias; changing what any existing gate step checks.
- `public-snapshot.json`.

## Constraints

- Gate wall-time: the added suites are install-free; record the Regression step's reported wall time for the changed group in the PR body.
- Group edits must keep the concurrency invariant merge-gate.sh documents; no suite that provisions PostgreSQL joins an install-free group.

## Acceptance

- A script or test enumerates every `scripts/**/*.test.mjs` and asserts each is named by a merge-gate step; it passes.
- `npm run test:gate-worker`, `node --test scripts/merge-gate-parallel.test.mjs scripts/merge-gate-profile.test.mjs`, `npm run test:frozen-docs`, `npm run lint` pass.
- `git grep -n "Frozen records" scripts` returns nothing; `git grep -n "master" scripts/check-frozen-docs.sh` returns only the `--master` option handling.
- The chain's Regression step (the merge gate on the worker) passes with the new group.