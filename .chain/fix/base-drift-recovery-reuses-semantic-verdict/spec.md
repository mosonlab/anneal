Merge tail: base-drift recovery reuses the semantic verdict pinned to an unchanged head and reruns only the gate

Goal: when a chain's head is unchanged and only its base moved, automatic base-drift recovery does not ask the model to re-review the same diff; it reuses the semantic PASS already recorded for that head and spends the rerun on the merge gate alone.

Background: base-drift recovery (`packages/api/src/merge-tail-state.ts`, `enterRepair()` fresh-regression branch around `:230-330`, with the fresh Run opened via `enqueueTaskRunInternal` around `:299-305`) opens a full regression Run: `regression-verification.sh prepare` → model semantic recheck → `finalize` (gate). On 2026-09-06 twelve such reruns flipped a previously passing semantic verdict to FAIL on a diff that had not changed, each producing a `review-fix` repair card and a further regression round (report `records/anneal/reports/REPORT-merge-tail-throughput-20260907.md` §1.3, §2 step 5, R3). The merge-train design already rules that a drifted candidate reruns only the gate; this change brings that ruling to the existing recovery path so it applies before train lands and to chains that are not trained. The semantic verdict is already bound to an exact head sha (`VERIFIED_HEAD_SHA` checks in `packages/runner/runtime-tools/regression-verification.sh:510,520`).

Changes:
1. A regression Run opened by base-drift recovery carries the recovery context it already records (`state: "queued"`, `currentBaseSha`) into the Run so the runtime tool can see it is a recovery rerun and which head it is for.
2. In a recovery rerun whose head sha equals the head of the most recent regression output whose semantic verdict was PASS for this chain, `regression-verification.sh` skips the model semantic recheck: `prepare` records that the verdict is reused (head sha, the prior Run id) and `finalize` runs the gate exactly as today. The persisted v2 result names `semanticVerdict: reused` with the prior Run id so a reader can tell a reused verdict from a fresh one.
3. If the head sha differs from the last PASS head, or the last verdict for this head was not PASS, the rerun performs the semantic recheck as today. No verdict is ever reused across heads.
4. `docs/operator-api.md` regression section and the runbook text on base-drift recovery state the reuse rule and the result field. Only sentences that become inaccurate change.

Out of scope: merge-train itself; gate execution and its timing; the review-fix repair budget; readiness authorization rules; semantic verification on a first regression or after any head change.

Constraints: the reuse decision is made once, from persisted regression output, not from transcript text; the gate is never skipped; a reused verdict is always labelled as reused in the persisted result; dbtests run only on the merge gate.

Acceptance: `npm run test -w @anneal/api` and `-w @anneal/runner` green. A runner test drives `regression-verification.sh` with a recovery context and a prior PASS at the same head and shows the semantic step skipped, the gate run, and the v2 result labelled reused with the prior Run id; the same with a different head shows the semantic step run. An API dbtest shows a recovery-opened regression Run carrying the recovery context. Handbook updated in the same diff.

Route: implementation=senior-dev-astra-medium - the change spans the API recovery path and the runner tool contract, and the failure (a stale verdict reused across heads) cannot be witnessed by the acceptance suite alone

