Merge readiness: pre-authorization requeues are counted and shown per chain

Goal: an operator can see, per chain and on the board, how many times readiness has requeued a candidate before authorization and how many budget grants that cost, without changing how readiness behaves.

Background: readiness requeues a candidate whose base moved before authorization (`packages/api/src/merge-readiness-worker.ts:292-345`, settlement in `merge-tail-state.ts:231-235`), each successful settlement granting one extra attempt (`budgetGrant: 1`, `:328`) that funds a paid Run; there is no cap or counter on this path, candidates are scanned oldest-first (`:218-225`) but the count of requeues per chain is not recorded or displayed. Zuul's dependent pipeline and GitHub's merge queue expose position and re-test counts; the 2026-09-06 audit asked for measurement before any throttling.

Changes:
1. Record on each requeue settlement a `TaskActivity` with `kind: "mergeReadiness.requeue"` carrying the requeue ordinal for the chain, the base sha moved from/to, and the grant issued.
2. Add to the board task payload for the readiness step: `readinessRequeues` (count) and `readinessGrants` (sum), computed from those activities; project them in `board-contract.ts` and render them on the task card's merge-tail line in `apps/web`.
3. Add the same two numbers to the chain-level cost view in `packages/api/src/costs.ts` so requeue-driven spend is attributable.
4. Document the activity kind and the two fields in `docs/operator-api.md`.

Out of scope: any cap, ordering change, FIFO enforcement, or backoff on requeues; the base-drift recovery path (separate chain); merge-train readiness (held chain 8b144122).

Constraints: purely additive; no change to settlement decisions; activity written inside the same transaction as the settlement so counts cannot drift from grants.

Acceptance: `npm run test -w @anneal/api` and `-w @anneal/web` green; dbtests cover: two requeues produce two activities with ordinals 1 and 2 and the board payload shows `readinessRequeues: 2`, `readinessGrants: 2`; the costs view sums them per chain; the web card renders the fields; handbook updated.

Route: implementation=senior-dev-opus-medium - operator chose Claude capacity; additive counters with dbtest-checkable acceptance
