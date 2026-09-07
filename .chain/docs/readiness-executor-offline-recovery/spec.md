Docs: the executor-offline recovery names the Regression task and its rerun cost, and the spec deviation of PR #560 is recorded

Goal: an operator who reads the handbook after a `merge-executor-offline` stop takes an action that works.

Background: review finding 1 (summarized in this brief): `docs/operator-api.md` ~2978-2986 documents that an executor coming back can self-re-arm the stopped readiness tail, while the manual fallback `POST /tasks/:taskId/retry` applies to the Regression task because a readiness Step has no Run of its own (`packages/db/src/chain-activation.ts` ~772-779) and the route refuses a no-Run task with `Task has no run to retry` (`packages/api/src/routes/tasks.ts` ~608); applied to the Regression task instead it opens a full Regression rerun. Finding 5: spec §1 said to reuse `requeueRegressionSettlement`, but the current implementation uses `executorOfflineRequeueSettlement` (`packages/api/src/merge-readiness-worker.ts` ~555-588), which deliberately does not requeue Regression; correct, but undocumented.

Changes:
1. `docs/operator-api.md` readiness / "merge-executor-offline" recovery: state that retry applies to the Regression task, that it opens a new Regression Run at full cost, and that until the self re-arm card lands this is the only operator exit.
2. The same section records that the executor-offline requeue is its own settlement and does not spend the lease-loss refund cap nor a Regression repair budget.
3. `CHANGELOG.md` entry for the doc correction.

Out of scope: code changes (companion card readiness-executor-offline-episode-liveness); the handbook's lease-loss section (chain b9b6b7a8 owns it).

Acceptance: `npm run test:snapshot-scan` and `npm run lint` clean; the handbook sentence names the Regression task and the cost.
