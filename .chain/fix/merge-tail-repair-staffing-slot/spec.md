Merge tail: review-fix and gate-fix repair cards are staffed from a profile slot that defaults to luna max, not by copying the fix step

Goal: the operator can put the fix step on one Agent and the residual merge-tail repairs on another; with no explicit choice, review-fix and gate-fix cards run on `senior-dev-luna-max` while the chain's Apply review fixes step stays on `senior-dev-astra-low`.

Background: `mergeTailRepairAssignee` (`packages/api/src/merge-tail-actions.ts` ~1020-1050) staffs `review-fix` and `gate-fix` cards by copying the chain's `fixed-implementation` step Agent; `refresh-conflict` takes `MERGE_RESOLVER_ROLE`. Moson's 2026-09-07 rulings: the fix step is `senior-dev-astra-low` (it closes findings on the first pass, and a dirty fix costs a regression rerun plus a repair card); the three merge-tail repair kinds target `gpt-5.6-luna:max`. The resolver was re-pointed by PATCHing the Agent row (`merge-resolver-luna-max`, effective since 12:20Z), but review-fix and gate-fix cannot be separated from the fix step without code: the 12:51Z review-fix card on chain b93ab0f9 ran on `senior-dev-astra-low`. This card is Change 8 of the parked tier-judging chain a8734271, carved out so it lands now; that chain's brief marks Change 8 as delivered here.

Changes:
1. A staffing profile carries an optional merge-tail repair Agent slot beside its per-step entries (one nullable Agent reference on the profile; validated like an entry: same project, not archived, holds a grant for the addressed Repo, an AGENT). `PUT /staffing-profiles/:id` accepts it; `reset` fills it with `senior-dev-luna-max`; `GET` returns it.
2. `mergeTailRepairAssignee` staffs `review-fix` and `gate-fix` from that slot of the profile the chain was instantiated with (the chain root's recorded `staffingProfileId`; when a chain predates profiles or recorded none, the template's default profile), and falls back to the chain's fixed-implementation Agent only when the slot is empty. `refresh-conflict` keeps `MERGE_RESOLVER_ROLE`. Operator reentry (`merge-tail/repair`) uses the same lookup, so automatic and operator-driven repairs never drift.
3. Fill the slot on the three active production profiles' canonical definitions (direct, pr, compound) with `senior-dev-luna-max` so `reset` and a fresh install agree; the deploy-time sync adopts it.
4. `docs/operator-api.md` staffing profiles and merge-tail repair sections document the slot, the lookup order and the fallback; CHANGELOG entry.

Out of scope: judging the implementation tier (chain a8734271 keeps Changes 1-7 and 9); the fix step's own Agent; `MAX_MERGE_TAIL_REPAIR_ATTEMPTS`; refresh-conflict staffing.

Constraints: no silent substitution — a slot naming an archived or foreign Agent is refused at PUT time, and a chain whose resolved slot Agent has since been archived falls back to the fixed-implementation Agent with a TaskActivity naming why; existing repair cards are untouched; no new environment variable.

Acceptance: dbtests: a review-fix and a gate-fix card take the profile's slot Agent; with the slot empty they take the fixed-implementation Agent; a chain with no recorded profile takes the template default profile's slot; refresh-conflict still takes the resolver role; operator reentry resolves identically; `reset` yields `senior-dev-luna-max`; `PUT` with an archived Agent is refused. `npm run test -w @anneal/api` and `-w @anneal/db` green; `npm run lint` clean; `scripts/operator-api-docs.test.mjs` passes.

Route: implementation=senior-dev-astra-medium - it changes merge-tail role binding and profile validation; a wrong lookup staffs repairs with an Agent nobody put on the chain, which the acceptance suite cannot witness end to end
