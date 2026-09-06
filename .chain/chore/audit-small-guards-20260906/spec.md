Platform: five small guards from the 2026-09-06 design audit are closed

Goal: five independently verified small defects are fixed in one chain: status-list parity on the web, the evidence worker's re-entrancy guard, the dead template-identity branch in step-role, the executor runbook's merge-queue boundary, and the rollover blocker message.

Background: each item was confirmed against origin/main e46e4716 by an adversarial second pass and a cross-vendor review; they share no files with any other in-flight chain.
(a) `apps/web/src/lib/board.ts:265-267` declares `ACTIVE_RUN_STATUSES` with `as const satisfies readonly RunStatus[]`, which checks each literal but not set equality with the server's list in `packages/db/src/chain-activation.ts:63-69`; `packages/api/src/workspace-reclaim.ts:29` carries a third copy. Adding an active RunStatus would silently miss all three. The correct shape exists at `packages/db/src/board-contract.ts:46-57` (`ChainControlStateCoverage`) and `apps/web/src/components/run-line.tsx:25-28` (`Record<RunStatus, …>`, compile error on omission).
(b) `packages/api/src/merge-evidence-worker.ts:226-233` is the only api worker whose `setInterval` tick has no in-flight guard; `scheduler.ts:537`, `merge-readiness-worker.ts:852-855`, `merge-base-drift-worker.ts:601-608` all have one. With a 2 s interval and up to 3×8 s GitHub reads, slow ticks overlap.
(c) `packages/db/src/step-role.ts:50-55` resolves a step role through a retired template marker; the only production caller `canonical-output-schema.ts:188-195` deliberately passes only `outputKind`, so the branch is unreachable, and it is the sole cause of the ESM import cycle `step-role.ts` ↔ `canonical-template-transition.ts`. `delivery.ts:284` and `gate-slot.test.ts:6-8` still pass the `taskTemplate` fields, so the field must stay.
(d) A target branch with a repository-level GitHub merge queue makes `deferred-merge-machinery` permanently non-actionable (`packages/merge-executor/src/decision-table.ts:162-167` reads `repository.mergeQueue`, disarm at `:222-229` is PR-level only) and `re-authorize` loops; `docs/runbooks/merge-executor.md` does not state the boundary.
(e) `packages/db/src/canonical-template-installation.ts:238-243` refuses a rollover when an unarchived, non-DONE, chain-less task exists, and the thrown error does not name the task, so the operator cannot find what to archive.

Changes:
1. Replace the three active-status lists with one exhaustive coverage shape: keep the server list in `chain-activation.ts` as the source, make `workspace-reclaim.ts` import it, and in `apps/web/src/lib/board.ts` derive `ACTIVE_RUN_STATUSES` from a `Record<RunStatus, boolean>` (or the `board-contract.ts` coverage pattern) so omission is a compile error. If web cannot import from `@anneal/db` (sealed: no Prisma-free home), add a unit test in `apps/web/src/tests` that asserts the web set equals the server set via the wire contract.
2. Add an `inFlight` guard to `merge-evidence-worker.ts` in the same shape as `merge-readiness-worker.ts:852-855`, cleared in `finally`; keep the existing read deadline.
3. Delete the retired-marker template-identity branch in `step-role.ts:50-55` and its tests (`step-role.test.ts:38-46`); keep the `taskTemplate`/`taskTemplateName` fields on `TemplateStepLike`. The import cycle between `step-role.ts` and `canonical-template-transition.ts` must be gone.
4. Add to `docs/runbooks/merge-executor.md` a short "Not supported" note: a target branch with a repository-level merge queue enabled cannot be landed by the executor; the operator must disable the queue or the chain stops with `deferred-merge-machinery`.
5. Include each blocking task's id and name in the rollover refusal error thrown at `canonical-template-installation.ts:242` and in the sync report line.

Out of scope: any behaviour change to what the evidence worker fetches; making the executor support merge queues; changing rollover blocker semantics; retention or payload caps; anything under `scripts/`.

Constraints: no migration; each item independently revertible; no new dependency between `apps/web` and `@anneal/db`.

Acceptance: `npm run test -w @anneal/db`, `-w @anneal/api`, `-w @anneal/web` green; `npm run lint` green; a test proves web/server active-status parity; a test proves a second evidence tick while one is in flight is skipped; `npx madge --circular packages/db/src/step-role.ts` (or an equivalent import-cycle check in the existing test suite) reports no cycle; the runbook contains the merge-queue note; a dbtest asserts the rollover refusal message contains the blocking task id.

Route: implementation=senior-dev-opus-medium - operator chose Claude capacity; five mechanical items with grep- and test-checkable acceptance