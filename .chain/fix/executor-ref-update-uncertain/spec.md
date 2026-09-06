Merge executor: a ref update with a lost response is confirmed by read-back, never recorded as refused

Goal: when the executor's fast-forward ref update to the target branch gets no HTTP response, the outcome is recorded as uncertain and resolved by reading the branch back, so an already-landed merge is never reclassified as base-drift.

Background: `packages/merge-executor/src/github.ts:197` wraps `NO_RESPONSE` (network loss) and HTTP 4xx into the same `{error}` shape, and `:492` maps that to `ref-update-refused`. `decision-table.ts:477` treats only `unknown` as a lost-outcome; `confirmed-write.ts:142` therefore takes the refused path (no retry, correct) and reads back the PR. If the read-back lands inside the projection window the code itself documents at `decision-table.ts:564-565` (ref already updated, PR still OPEN), `:524-529` reclassifies from the snapshot, whose `baseRefOid` is now our own merge commit, and `classifyPreMerge:598` reports `base-drift`. No double merge can occur (`classify.ts:19-23`), but the result is a misnamed stop, an automatic base-drift recovery of a merged PR, and a `changed-underneath-me` stop on the next authorization. Separately, `restJson` (`:427`) degrades deterministic GitHub rejections into lost outcomes although `classify.ts:103-108` already computes the right class.

Changes:
1. In `github.ts`, distinguish transport-level loss (no response, timeout, connection reset) from a GitHub refusal; return a distinct `ref-update-uncertain` outcome for the former, keeping `ref-update-refused` for real 4xx/GraphQL refusals.
2. In `decision-table.ts`, treat `ref-update-uncertain` like `unknown`: confirm by reading the target ref and the PR; if the ref now equals the merge commit we built, classify as merged (write `mergeIntegrator.result` accordingly); if it does not, fall through to the existing refused handling. Never reclassify from a snapshot taken inside the projection window without first comparing the ref oid.
3. Fix `restJson` so a deterministic rejection keeps the class `classify.ts:103-108` computes instead of being downgraded to lost.
4. Add decision-table tests with a recording fake: no-response on ref update followed by read-back showing our merge commit yields a merged result; no-response followed by read-back showing a different oid yields the refused path; a 422 keeps its deterministic class.

Out of scope: removing the unreachable `MergeResponse` variants (C-05, separate card), the claim-contract version gate, required-checks rule semantics (C N-1), branch-protection pagination, installation-id scoping, the merge-train publication chain (230ca924, held), any change to `packages/db/src/merge-integrator.ts` parsers.

Constraints: "undefined is never a pass" — every new branch either merges under re-verified authorization or records a named stop; idempotency via the intent record is unchanged; no new GitHub write is introduced on the uncertain path (read-back only).

Acceptance: `npm run test -w @anneal/merge-executor` green including the four new cases; `npm run typecheck -w @anneal/merge-executor` green; `docs/runbooks/merge-executor.md` stop-condition table lists `ref-update-uncertain` and how it resolves.

Route: implementation=senior-dev-opus-high - post-merge outcome classification sits on the double-merge boundary of the executor; the projection-window race cannot be witnessed by fixtures against a live GitHub