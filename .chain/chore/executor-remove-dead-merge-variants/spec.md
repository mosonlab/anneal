Merge executor: unreachable merge-response variants are removed and deterministic rejections keep their class

Goal: the decision table contains only branches the current fast-forward publication path can reach, its tests exercise real outcomes, and a deterministic GitHub rejection is recorded under the class already computed for it.

Background: since the executor switched from the pull-request merge API to building its own merge commit and fast-forwarding the target ref, the `MergeResponse` variants `head-moved`, `not-mergeable`, `forbidden`, `not-found`, `unprocessable` have no producer (`packages/merge-executor/src/github.ts`), the corresponding branches in `decision-table.ts` are dead, their comments still describe the old PUT /merge and 405 / expected-head CAS behaviour, and `fake-pr-surface.ts` is referenced only by tests (`isolation.test.ts:31` excludes it), so those tests pass without exercising production code. Separately `restJson` (`github.ts:427`) collapses a deterministic rejection into a lost outcome although `classify.ts:103-108` already computed the right class. The previous chain on this branch introduced `ref-update-uncertain`; this chain removes the dead paths around it.

Changes:
1. Remove the five unreachable `MergeResponse` variants, the decision-table branches that consume them, and the comments describing the retired PUT path; update the stop-condition names list in `docs/runbooks/merge-executor.md` accordingly (only names that had no producer are removed; every stop still producible keeps its name).
2. Delete `fake-pr-surface.ts` and rewrite the affected tests against the recording fake `Deps` used by the rest of the decision-table suite, asserting real outcomes of the fast-forward path.
3. Make `restJson` return the class computed by `classify.ts` for deterministic rejections instead of a lost outcome; add a test for a 422 and a 403 keeping their class.
4. Add a test that enumerates every `MergeResponse` variant and asserts each has at least one producer in `github.ts` (a closed-set guard so dead variants cannot reappear).

Out of scope: the claim-contract version gate, required-checks rule semantics, branch-protection pagination, installation-id scoping, merge-train publication (held chain 230ca924), any `packages/db` parser.

Constraints: no behaviour change for reachable outcomes; "undefined is never a pass" holds; the runbook table and the code stay in one-to-one correspondence.

Acceptance: `npm run test -w @anneal/merge-executor` and `npm run typecheck -w @anneal/merge-executor` green; `git grep -E 'head-moved|not-mergeable' origin/main -- packages/merge-executor` after merge returns nothing; `fake-pr-surface.ts` is gone; the producer guard test passes; the runbook lists only producible stops.

Route: implementation=senior-dev-opus-medium - operator chose Claude capacity; deletion of provably unreachable code with a closed-set guard and grep-checkable acceptance
