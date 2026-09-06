DB: the completed one-shot backfill and audit CLIs and their root aliases are retired

Goal: the database package ships only commands that a current deployment can need; the five completed one-shot backfill/audit CLIs, their supporting modules, and the root package.json pass-through aliases are gone.

Background: `packages/db/prisma/backfill-session-usage.ts`, `backfill-session-cache.ts`, `backfill-merge-stop-questions.ts`, `backfill-task-source.ts`, `audit-post-delivery-disconnect.ts` and their modules `packages/db/src/session-cache-backfill.ts`, `merge-stop-question-backfill.ts`, `post-delivery-disconnect-audit.ts`, `task-source.ts`, plus the backfill half of `usage.ts` (`backfillSessionUsage`, `runBackfillSessionUsageCli`, `BackfillSessionUsageResult`, `usage.ts:671-754`) are one-shot data migrations or incident audits whose triggering migrations are long applied (20260816180100, 20260831010000) and whose incident root cause is fixed. No API route, worker, runner path, deploy script or gate step invokes them; the only non-test references are the entry scripts themselves and `packages/api/src/migration.dbtest.ts:13,234`. Root `package.json` forwards them as `db:backfill-*`, `db:audit-post-delivery-disconnect`, `db:export-goal-lineage`, `db:verify-goal-execution`. The operator ruled on 2026-09-06 that upgrades from pre-backfill versions need not be supported. `recomputeSessionUsage` in `usage.ts` IS production (via `packages/api/src/run-lifecycle.ts`) and must stay.

Changes:
1. Delete the five CLI entry scripts and the four supporting modules; remove the backfill half of `usage.ts` while keeping `recomputeSessionUsage` and everything `run-lifecycle.ts` imports; remove their tests.
2. Remove the matching `db:*` scripts from `packages/db/package.json` and the root `package.json` aliases listed above (`db:export-goal-lineage` and `db:verify-goal-execution` only if their workspace scripts have no remaining caller; otherwise leave them and say so in the PR).
3. Update `packages/api/src/migration.dbtest.ts` so it no longer imports the removed CLIs; update `docs/install.md` references to the backfill commands; add a CHANGELOG Removed line.

Out of scope: any migration file, `recomputeSessionUsage`, the cache-cost fail-closed aggregation in `costs.ts`, Goal schema.

Constraints: `npm run typecheck:cli -w @anneal/db` must stay green; no migration is added or edited.

Acceptance: `npm run test -w @anneal/db` and `-w @anneal/api` green; `npm run typecheck:cli`; `git grep -E 'backfill-session|backfill-merge-stop|backfill-task-source|audit-post-delivery-disconnect|runBackfillSessionUsageCli' origin/main -- ':!CHANGELOG.md' ':!packages/db/prisma/migrations'` returns nothing after merge; `docs/install.md` no longer lists the removed commands.