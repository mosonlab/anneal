## Goal

The merge gate's database suite no longer replays data migrations that every existing installation has already applied; the assertions in those files that state a current-schema invariant survive in a current-schema test.

## Background

Survey candidate SIM-API-005 and the replay half of SIM-API-003, operator ruling 2026-09-06 (defense theme D4) with this retention rule: **a replay dbtest for a one-shot data migration is retired in the first release after the migration shipped.** Anneal previews have no in-place upgrade path; every installation is either the maintainer's production database, where the migration has run, or a fresh install, where the data branch is a no-op. So the replay proves nothing that can still happen, while each file stages a truncated copy of `packages/db/prisma/migrations`, runs `prisma migrate deploy` to a pinned `targetMigration`, and re-executes committed SQL on every gate.

Files in scope (verifier-corrected list): the four suites that pin `targetMigration` (`packages/api/src/native-implementation-subagents-upgrade.dbtest.ts`, `optional-steps-migration.dbtest.ts`, `prior-outputs-upgrade.dbtest.ts`, `project-gate-defaults-migration.dbtest.ts`) plus `goal-execution-upgrade.dbtest.ts` and `packages/api/src/goal-execution-fixture.ts` if nothing else imports it after the deletion. Explicitly kept: `session-cache-backfill.dbtest.ts` (only coverage of the shipped `db:backfill-session-cache` CLI), `chain-control-execution-boundary-migration.dbtest.ts` (asserts live behaviour), `preflight-goal-execution*.dbtest.ts` (cover the release migration path), `verify-goal-execution.dbtest.ts` and `export-goal-lineage.dbtest.ts` (cover kept operator CLIs), and `migration.dbtest.ts`.

## Changes

1. Read each in-scope file individually. Delete the one-shot replay (staged migration copy, `targetMigration` pin, legacy-row insertion, re-executed SQL). Any assertion that states a constraint the current schema still enforces moves into `packages/api/src/migration.dbtest.ts` or the nearest current-schema test, asserting against the fully migrated schema.
2. Delete `goal-execution-fixture.ts` only if `git grep goal-execution-fixture packages` returns nothing after step 1; otherwise leave it and say so in the PR body.
3. State the retention rule in one sentence in `CONTRIBUTING.md`'s testing section, next to the existing rule that whole database suites are merge-gate evidence.

## Out of scope

- `packages/db/prisma/**`: no migration, schema or migration-history change of any kind.
- The kept files listed above; `db:*` scripts; any change to how the gate runs the database suite.

## Constraints

- No bulk deletion: the PR body lists, per file, which assertions were retired as replay and which were preserved as live invariants and where they now live.
- The staged-migration helper shared by these files is deleted only when no kept file imports it.

## Acceptance

- `grep -ln "targetMigration" packages/api/src/*.dbtest.ts` returns exactly `packages/api/src/agent-canonical-role-migration.dbtest.ts` and `packages/api/src/staffing-profiles-migration.dbtest.ts`. These staffing-profile suites are outside the enumerated retirement scope; shipment of their `20260905120000_staffing_profiles` migration is not established by this task. Keep their replay visible under its original identifier rather than claiming it was retired.
- All five enumerated replay suites are absent; the retained preflight fixture has no `applyKernelMigration` replay member. This check is scoped to this retirement, not a claim that all staged-history testing in the repository is gone.
- `npm run lint`, `npm run typecheck` pass; the chain's Regression step (merge gate database suite) passes.
- CONTRIBUTING.md carries the retention rule once.
