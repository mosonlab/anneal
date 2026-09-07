Runs: a task's spend cap is enforced before a new attempt is queued, or the field is removed

Goal: `Task.spendCap` either stops new attempts once the task's accumulated usage cost reaches it, with a loud refusal, or the column and its projections are removed; the board no longer shows a limit that nothing enforces.

Background: `Task.spendCap` (`packages/db/prisma/schema.prisma`, `Decimal(12,2)`) is copied onto Goal and Run projections and displayed in the web console, but no code path compares it against `usageCost` before queueing a Run; it is a displayed limit with no decision point. Attempt budgets (`maxSessionsPerTask`, `budgetGrants`, and the lease-loss refund bound introduced by the previous chain) count attempts, not money. Cost per Run is available as `runs[].session.usageCost`.

Changes:
1. Decide and implement enforcement: in the single budget decision point in `packages/db/src/run-open.ts` used by every replacement intent, compute the task's accumulated `usageCost` across its Runs and refuse to queue a new attempt when `spendCap` is set and the total is at or above it, with refusal reason `spend-cap-exhausted`; the task moves to REVIEW with a `TaskActivity` naming the cap and the total. `PATCH /tasks/:id` raising or clearing `spendCap` followed by retry proceeds.
2. Define the cost basis in one place (which cost fields count, currency, whether in-flight Run cost counts once it is reported) and document it in `docs/operator-api.md` next to the `spendCap` field.
3. Show the accumulated cost against the cap on the board task payload where `spendCap` is already projected.
4. If during implementation the cost basis cannot be defined mechanically (for example cost arrives too late to gate the next attempt), instead remove `spendCap` from the schema (expand-contract migration: stop writing, drop column), API, and web, and record that decision in the operator API handbook. Exactly one of items 1-3 or item 4 is delivered; the chain's PR states which.

Out of scope: attempt-count budgets, refund classes, cost aggregation changes in `costs.ts`, Goal-level spend semantics beyond keeping projections compiling.

Constraints: no silent enforcement: a refusal always writes an activity; the migration, if any, is additive first. dbtests run only on the merge gate.

Acceptance: `npm run test -w @anneal/db` and `-w @anneal/api` green; if enforced: a dbtest queues a Run whose task has `spendCap` 1.00 and accumulated cost 1.50 and asserts refusal `spend-cap-exhausted` plus REVIEW and the activity; raising the cap and retrying queues; the board payload carries the accumulated cost. If removed: `git grep spendCap origin/main` after merge returns nothing outside the migration, and the handbook records the removal.

Route: implementation=senior-dev-opus-medium - operator chose Claude capacity; the decision point is fixed by the previous chain and the acceptance is mechanical either way
