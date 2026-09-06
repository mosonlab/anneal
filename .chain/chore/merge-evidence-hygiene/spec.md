## Goal

The merge-tail and merge-integrator modules export only names something imports; step-role recognition has one representation (outputKind plus the canonical template registry).

## Background

Survey candidates SIM-LIBS-001, SIM-LIBS-004 and the zero-reference slice of SIM-LIBS-006, operator ruling 2026-09-06 (defense theme D1). After "refactor(chains): derive step roles from output kinds", ten ordinal constants in `packages/db/src/merge-tail.ts` (~15-22) and `packages/db/src/merge-integrator.ts` (~39-48) have zero references outside their defining line, while `INTEGRATOR_STEP_INDEX`, `DIRECT_INTEGRATOR_STEP_INDEX`, `LEGACY_INTEGRATOR_STEP_INDEX`, `LEGACY_DIRECT_INTEGRATOR_STEP_INDEX` and `INTEGRATOR_OUTPUT_KIND` have production and prisma-side consumers and stay. `packages/db/src/merge-integrator-db.ts` exports `INTEGRATOR_OUTPUT` (an alias of `INTEGRATOR_OUTPUT_KIND`), `inStopState` and `assertIntegratorBinding`, none referenced anywhere. Six further names are referenced nowhere, not even in their own file: `TEMPLATE_ROLLOVER_ACTIVE_RUN_STATUSES` (`packages/db/src/canonical-template-transition.ts` ~579), `RunOutcomeCase` (`packages/db/src/run-outcome.ts` ~69), `MergeIntegratorKind`, and `GitHubClient`, `MutatingOperation`, `AgentOsClient` in `packages/merge-executor/src`.

Route: implementation=senior-dev-astra-medium - merge-evidence defense path reachable from two @anneal/db package entrypoints and the merge-executor process; the survey's own consumer classification was wrong once, so every deletion must be re-proven

## Changes

1. Delete the ten zero-reference ordinal constants from `merge-tail.ts` and `merge-integrator.ts`, each only after `git grep -nw <NAME>` (dist excluded) returns solely its defining line; keep the five named survivors untouched.
2. Delete `INTEGRATOR_OUTPUT`, `inStopState` and `assertIntegratorBinding` from `merge-integrator-db.ts`; no call site changes.
3. Delete the six zero-reference names listed above, each after the same grep proof; a name that turns out to have a reference is left in place and named in the PR body.
4. Update any comment in these modules that still describes ordinal-based recognition so it points at `stepRole()` and `canonicalStepOrdinals`.

## Out of scope

- `INTEGRATOR_STEP_INDEX` family, `INTEGRATOR_OUTPUT_KIND`, the persisted output-kind string `merge-result`, and `packages/api/src/merge-integrator-fixture.ts`.
- The ~150 export-narrowing names from SIM-LIBS-006 (a separate decision); any `index.ts` subpath change.
- Any behaviour change in merge tail, merge lease or merge executor.

## Constraints

- Pure deletion: no renamed exports, no new re-exports.
- `packages/build-info/exports.test.mjs` (subpath contract) must pass unchanged.

## Acceptance

- `git grep -nw` for each deleted name returns nothing.
- `npm run typecheck && npm run lint` at root; `npm run test -w @anneal/db` (merge-integrator and merge-tail unit tests); `npm run typecheck -w @anneal/merge-executor && npm run test -w @anneal/merge-executor`; `npm run test -w @anneal/build-info` all pass.
- The PR body lists every deleted name with its grep proof line.