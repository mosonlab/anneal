Merge tail: a repair Run that fails before producing a result uses the repair Task's remaining session budget before the tail stops

Goal: when an automatic merge-tail repair Run (refresh-conflict, review-fix, gate-fix) fails with `failureClass=task-failed` and no repair result was recorded, and the repair Task still has session budget (`maxSessionsPerTask` 2, one Run used), the platform queues the second Run itself instead of stopping the merge tail into REVIEW.

Background: on 2026-09-07 13:15-13:22Z chain 2e621a8a's automatic refresh-conflict repair `cmtr9jmih05o5dbcn4u7zfg81` (merge-resolver-luna-max on vm-runner-5) resolved both conflicting files and was running its verification commands when the codex CLI process exited non-zero (stderr: `failed to refresh available models: timeout waiting for child process to exit`, the only such failure on the VM in 24 hours). `packages/api/src/run-completion.ts` recorded `Run 1 external failure was not eligible for a budget refund`, `settleMergeTailCompletion` in `packages/api/src/merge-tail-actions.ts:729-744` called `stopMergeTail` with `refresh-conflict repair ... failed without closing the repair at 4158ae8e`, and the Regression step moved to REVIEW. The repair Task had `maxSessionsPerTask: 2` (set on 2026-09-02 precisely so a second Run exists), so an operator `POST /tasks/:taskId/retry` was accepted at 13:36Z and Run 2 queued from the clean start head. That retry is the only thing the platform could not do for itself: nothing about the failure needed a human judgement.

Changes:
1. In the repair completion path, when `succeeded` is false, no repair result marker was written for this Run, and the repair Task's completed-Run count is below `maxSessionsPerTask`, queue the next Run of the repair Task (same head/base pair, same branch pinning) and write a TaskActivity `merge-tail repair Run N failed before a result; Run N+1 queued` instead of calling `stopMergeTail`. The Regression step's failureReason stays the existing `... automatic repair <id> queued at <head>` text.
2. When the budget is exhausted, behaviour is unchanged: `stopMergeTail` with the existing `failed without closing the repair` reason.
3. `docs/operator-api.md` merge-tail section: state that a repair Run failure consumes one session of the repair Task's budget and the second Run is automatic; the operator retry remains the exit once the budget is spent.

Out of scope: raising `maxSessionsPerTask` or `MAX_MERGE_TAIL_REPAIR_ATTEMPTS`; classifying codex CLI startup errors; salvage-branch adoption (the second Run starts from the recorded start head, not from the WIP salvage push, because a partially resolved tree makes the resolver produce no-changes).

Constraints: the requeue must not count against `leaseLossRefunds` or the per-kind repair attempt cap (it is the same attempt, second session); no new configuration.

Acceptance: a dbtest completes a refresh-conflict repair Run as failed with no result while `maxSessionsPerTask` is 2 and asserts a second QUEUED Run exists for the repair Task, the Regression step is not moved to REVIEW, and the activity is written; a second dbtest fails Run 2 the same way and asserts `stopMergeTail` runs with the existing reason; the operator handbook snapshot test passes.

Route: implementation=senior-dev-astra-medium - it changes when the merge tail stops; a wrong budget check would either loop repairs or keep stopping tails that could self-heal
