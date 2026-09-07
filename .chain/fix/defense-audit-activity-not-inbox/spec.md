Merge readiness: the defense-list audit is a TaskActivity on the readiness Step, not an Inbox message

Goal: a merge whose diff touches a defense-list path leaves its audit on the readiness Step's activity log and nothing in the operator Inbox.

Background: since ADR 0001 retired the blind review of defense-list diffs, `openDefenseAuditNotice` (`packages/api/src/merge-tail-actions.ts` ~223, called from `merge-readiness-worker.ts` ~1058 right after authorization) upserts an Inbox message `Merge proceeded with defense-list changes` keyed `defense-audit:<readinessTaskId>:<headSha>`. Nearly every platform PR touches a defense-list path (merge-tail-machinery files), so on 2026-09-07 the Inbox held 122 such open messages out of 660, all informational and none actionable; the operator closed them by hand and ruled that this audit is activity, not a message.

Changes:
1. `openDefenseAuditNotice` writes a control-plane TaskActivity on the readiness Step instead of an Inbox row: body `Merge proceeded with defense-list changes` plus the exact range and the `path (reason)` lines as today; metadata carries `headSha`, `baseSha` and the `triggers` array. It stays idempotent per `(readinessTaskId, headSha)`: a readiness tick that re-evaluates the same head writes no second activity (use the existing marker lookup pattern on the readiness task, not a new dedupe column).
2. No Inbox message is created for the audit. Existing rows are left untouched (already closed).
3. `docs/adr/0001-merge-lease-hold-window.md` (the "audit-only ... writes one inbox message" sentence), any `docs/operator-api.md` text that describes the notice, and `CHANGELOG.md` say the audit is a TaskActivity on the readiness Step.
4. `merge-tail-readiness.dbtest.ts` (~481) and `merge-tail-actions.test.ts` (~473) assert the activity and its metadata instead of the Inbox row.

Out of scope: the defense list itself and its reasons; any blocking or review behavior on defense-list diffs; other Inbox message kinds (stop notices, executor-offline notices stay as they are); web UI changes.

Constraints: authorization and merge execution ordering are unchanged; the activity is written inside the same transaction that records the authorization, as the Inbox upsert is today.

Acceptance: a dbtest authorizing a head that touches a defense-list path finds one TaskActivity on the readiness Step naming the triggered paths and zero `InboxMessage` rows with a `defense-audit:` dedupeKey; re-running readiness on the same head leaves exactly one such activity; `npm run lint`, the API unit suite, and `npm run test:snapshot-scan` pass.

Route: implementation=senior-dev-astra-medium - operator choice (Astra capacity is ample and the change sits on the merge readiness authorization path, where a wrong transaction boundary can drop an authorization)
