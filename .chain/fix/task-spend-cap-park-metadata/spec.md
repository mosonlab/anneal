Runs: the spend-cap park carries its cap detail without reshaping every other Run-birth refusal activity

Goal: continue the delivered branch `fix/task-spend-cap-enforced-or-removed` and close the single defect that stopped it: the shared Run-birth refusal metadata helper now spreads every refusal's `detail` into the TaskActivity metadata, which changes the recorded shape of refusals that are not spend caps and breaks the merge gate's database tests on `origin/main`.

Background: chain `321bf1b7` delivered `fix/task-spend-cap-enforced-or-removed` at `66de128e5ff6d33a68171506317c5bf9c046ce3e` and stopped on 2026-09-07 at `merge gate FAIL at 66de128e… against d1608e64…: database tests (db + api)` with its `review-fix` repair budget (2/2) exhausted. Semantic regression verification at that head passed; every adopted finding, including BSC-07 (the spend-cap park must carry the formatted `spendCapUsd` and `spentUsd` the handbook promises), is resolved. The gate failure is the branch's own: `packages/db/src/run-open.ts` gained `runBirthRefusalMetadata = (refusal) => ({ ...refusal.detail, refusal: refusal.code })`, and every writer that used to record `{ refusal: refusal.code }` (`packages/api/src/merge-tail-state.ts:207`, `reconcile.ts:372`, `run-completion.ts:424`, `scheduler.ts:190/196/256`, `workspace-reclaim.ts:541`, `packages/db/src/chain-activation.ts:376/861` on `origin/main`) now calls it. Three database tests on `origin/main` assert the old exact shape with `assert.deepEqual` and fail once a refusal carries any `detail`: `packages/api/src/chain.dbtest.ts:753` (`{ refusal: "compound-implementation-assignee" }`, the test the gate excerpt names), `packages/api/src/admission-refusal.dbtest.ts:319` (`{ refusal: "assignee-archived" }`) and `:375` (`{ refusal: "integrator-binding-invalid" }`). Database tests run only on the merge gate, so the branch's green unit suites did not catch this.

Changes:
1. Merge `origin/fix/task-spend-cap-enforced-or-removed` at `66de128e5ff6d33a68171506317c5bf9c046ce3e` into this chain's branch as the first commit. Resolve conflicts with `origin/main` only; introduce no behaviour change in this commit.
2. `runBirthRefusalMetadata` records `{ refusal: <code> }` for every refusal except `spend-cap-exhausted`, exactly as each writer recorded before the delivered branch; only the spend-cap refusal adds its detail (`spendCapUsd`, `spentUsd`, `runs`) beside `refusal`. The helper stays the single place that decides the shape; no writer reconstructs metadata by hand. Scheduler activities keep their `recurringTaskId` and `copyTaskId` keys as on `origin/main`.
3. The three `origin/main` assertions named in Background are left unchanged and pass. The delivered branch's own tests that assert the spend-cap park metadata (`packages/api/src/task-spend-cap.dbtest.ts`, `packages/db/src/open-run.test.ts`) still pass; where the branch added a test asserting that a non-spend-cap refusal carries `detail` in its activity metadata, that assertion is inverted to the exact `{ refusal: <code> }` shape.
4. If the delivered branch's handbook text next to `spendCap` in `docs/operator-api.md` states or implies that every Run-birth refusal activity carries the refusal's detail, correct it to say only the spend-cap park does. Do not restate what is already correct.

Out of scope: everything the delivered branch already implements and its reviews accepted — the spend-cap decision point in `run-open.ts`, `parksInsteadOfRaising` and `recordRunBirthRefusal`, the cost basis in `spend-cap.ts`, the board projection of accumulated cost, and the handbook section that documents the cap. Attempt-count budgets, refund classes, `costs.ts` aggregation, Goal-level spend semantics.

Constraints: the metadata shape is defined once and shared; no refusal loses the activity it writes today; no new configuration surface; dbtests run only on the merge gate, so do not attempt `test:db` inside the Run and do not report its absence as a gap.

Acceptance: the chain branch contains `66de128e5ff6d33a68171506317c5bf9c046ce3e` as an ancestor. `npm run test -w @anneal/db` and `npm run test -w @anneal/api` are green. A `packages/db` unit test asserts `runBirthRefusalMetadata` returns exactly `{ refusal: <code> }` for a non-spend-cap refusal and `{ refusal: "spend-cap-exhausted", spendCapUsd, spentUsd, runs }` for the spend-cap refusal. `packages/api/src/chain.dbtest.ts:753`, `packages/api/src/admission-refusal.dbtest.ts:319` and `:375` are unchanged. The previous brief's acceptance criteria are carried unchanged and still hold: `npm run test -w @anneal/db` and `-w @anneal/api` green; a dbtest queues a Run whose task has `spendCap` 1.00 and accumulated cost 1.50 and asserts refusal `spend-cap-exhausted` plus REVIEW and the activity; raising the cap and retrying queues; the board payload carries the accumulated cost.

Route: implementation=senior-dev-opus-medium - operator chose Claude capacity; the defect is a single metadata-shape regression with mechanical acceptance

Reference — the previous chain's brief, verbatim:

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
