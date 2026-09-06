## Goal

`packages/api/src/chain-activation-barrier.dbtest.ts` passes or fails on the barrier behaviour alone, never on whether a deliberately paused transaction outlives Prisma's default 5-second interactive-transaction budget under host scheduling delay.

## Background

Issue #430 (split from #334). The fixture wraps `PrismaClient.$transaction` through `instrumentTransactions` and pauses a transaction right after the Chain row lock resolves, so that a second activation attempt can be shown to wait on the barrier rather than double-run. The wrapper forwards the caller's `options` unchanged and the production call sites it exercises (`chain-activation.ts`) pass no `timeout`/`maxWait`, so the paused transaction runs on Prisma's defaults: `maxWait` 2 s, `timeout` 5 s. On a loaded gate worker the pause plus scheduling delay can exceed that budget, and the fixture then fails for a reason that is not the barrier. The expiry has not been reproduced, but the dependency is real and the gate's determinism fixes for the same class of problem (#355, #356, #384) set the pattern: the fixture, not production code, owns the budget it needs.

## Changes

1. In `chain-activation-barrier.dbtest.ts`, the instrumented `$transaction` wrapper supplies an explicit interactive-transaction budget for the paused transaction (a `maxWait` and `timeout` wide enough that the deliberate pause plus a heavily loaded host cannot exhaust it, on the order of the widest budgets already used in `packages/api/src/*.dbtest.ts`, for example `maxWait: 5_000, timeout: 30_000`), merging over whatever options the production call site passed so that a production-supplied value is never silently overridden.
2. Each test in the file that relies on the pause declares its own `node:test` `timeout` at least as wide as the transaction budget it depends on, so a genuine hang is reported by the test runner rather than by Prisma's budget expiry.
3. No production transaction budget changes: `chain-activation.ts` and every other non-test caller of `$transaction` keep the options they have today.

## Out of scope

- Any change under `packages/api/src/chain-activation.ts`, `packages/db`, or `packages/db/prisma`.
- Any other `.dbtest.ts` file, including the barrier-adjacent `claim-activation-isolation.dbtest.ts` and `dispatch-activation.dbtest.ts`.
- Making the pause shorter or removing the pause; the pause is what proves the barrier.
- Global Prisma transaction defaults, test-runner concurrency settings, or the gate's node test width (#368).

## Constraints

- The fixture must still fail when the barrier is broken (a second activation completing while the first transaction holds the Chain row lock); do not widen the budget by removing the assertion that the second attempt waited.
- The wrapper must keep forwarding every option the production call site passes; the budget is added, not substituted.
- Fail loud: no try/catch that turns a budget expiry into a pass.

## Acceptance

- `node --conditions=development --import tsx --test packages/api/src/chain-activation-barrier.dbtest.ts` passes against a scratch PostgreSQL (the merge gate's database suite runs it).
- `grep -n "timeout" packages/api/src/chain-activation-barrier.dbtest.ts` shows an explicit interactive-transaction `timeout`/`maxWait` in the instrumented wrapper and a `node:test` `timeout` option on each pause-dependent test.
- `git diff --stat` for the merged change touches only `packages/api/src/chain-activation-barrier.dbtest.ts`.
- `npm run lint` and `npm run typecheck` are clean.
- The PR body references issue #430 with a closing keyword.