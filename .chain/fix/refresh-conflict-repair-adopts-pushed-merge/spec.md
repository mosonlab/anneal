Merge tail: a refresh-conflict repair whose merge is on the branch is not voided by a malformed result output

Goal: when the merge resolver has pushed a resolved merge commit to the Chain branch, the merge tail uses it; a bad result payload costs one repository read, not the whole repair and the Chain's automatic exit.

Background: on 2026-09-07 06:53-06:59Z chain a4b6c22e's automatic refresh-conflict repair `cmtqvwueh0s4mdb0i4irk4qco` resolved `packages/runner/src/merge-train-script.test.ts`, committed and pushed `6d8df91d` to `fix/readiness-authorization-requires-executor-online`, reported runner typecheck and 17/17 suite green in its TaskActivity, and was then settled `refresh-conflict repair … returned invalid output: … resolved output is malformed or has no resolved head`. The Regression task parked in REVIEW; `POST /tasks/:id/retry` opened a Run that stopped at claim with `regression repair handoff is invalid: no successful refresh-conflict result binds 66ca8885… to 65b1e099…`; `merge-tail/repair` answered `not_blocked`. The branch head was correct the whole time. Delivery was manual (PR #560). Today's settlement (`packages/api/src/merge-tail-actions.ts` ~759-806) already records the rejection with `state: "invalid-output"`, the `reason` and the `rejectedKey` on both the repair task and the Regression task; what is missing is any use of the pushed merge.

Changes:
1. When a refresh-conflict repair Run completes and `parseResolverResult` reports the output invalid, or the parsed `resolvedHeadSha` is missing, the merge tail reads the Chain branch head from the repository before failing: if that head is a descendant of the repair's starting head (`repairMarker.headSha`) and of the target base (`repairMarker.baseHeadSha`), it is adopted as the resolved head and a TaskActivity names the fallback and the rejected key; otherwise the repair fails exactly as today. The existing refusals for a stale `startHeadSha` or `targetHeadSha` and for an explicit `unable` outcome are unchanged; a repository read failure during the fallback is recorded and the repair fails as today, never adopted.
2. `docs/operator-api.md` merge-tail repair section documents the fallback and its activity.

Out of scope: the resolver prompt; review-fix and gate-fix repairs; the handoff-invalid retry refusal (correct once no result exists); the persisted-verdict precedence (separate card).

Constraints: the adopted head is verified by ancestry against both expected shas, never by trusting Run text; no new configuration.

Acceptance: a dbtest completes a refresh-conflict repair with an invalid output while the branch head is a valid descendant of both shas and asserts the recovery proceeds with that head and writes the activity; a dbtest with no pushed commit asserts the existing refusal; a dbtest with a pushed head that is not a descendant of the target base asserts the refusal; `npm run test -w @anneal/api` green; `npm run lint` clean.

Route: implementation=senior-dev-astra-medium - it changes what the merge tail accepts as a resolved head; a wrong ancestry check would merge the wrong tree
