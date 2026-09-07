Web: a merge run refused for a contract-version mismatch says so on the board

Goal: a Merge execution run whose claim the API keeps refusing because the executor's completion-contract version differs from the API's shows that refusal on its board card instead of a bare queued phase.

Background: `packages/api/src/run-claim.ts` calls `mechanicalContractMismatch`
(`packages/db/src/claim-contract.ts`) when a mechanical claimant's
`contractVersion` differs from `RUN_COMPLETION_CONTRACT_VERSION`. The claim is
refused, one control-plane `TaskActivity` per version pair is recorded with
`metadata.code = MECHANICAL_CONTRACT_MISMATCH_CODE`, `executorVersion` and
`apiVersion`, and one inbox alert is opened. The Run stays QUEUED. The board
projection (`packages/api/src/board.ts`, latest-run select) carries nothing
about the refusal, so the card reads "run 1 · merge-integrator · queued"
indefinitely; on 2026-09-06 nine chains showed exactly that for 77 minutes
although the alert had been delivered to Feishu at 02:25Z. The predecessor
chain "Web: board cards show the run's current phase, time in phase, and
anomaly badges" adds `phase`, `phaseSince` and the anomaly badge row to task
cards and the mobile list; this chain adds the refusal on top of that shape and
extends the aggregate card with the same anomaly badge.

Depends on: Web: board cards show the run's current phase, time in phase, and anomaly badges (chain 0c5514b5) — this chain reads the phase projection and badge row that chain merges.

Changes:
1. The board projection adds to each task's latest run an optional
   `claimRefusal` object `{ code, executorVersion, apiVersion, since }`,
   present only when the run is QUEUED and a control-plane `TaskActivity` with
   `metadata.code = MECHANICAL_CONTRACT_MISMATCH_CODE` exists for the task with
   `createdAt` at or after the run's `createdAt`; `since` is that activity's
   `createdAt`; `executorVersion` is null when the executor sent none. The
   field is absent otherwise. It is computed in the same query pass as the
   rest of the projection; no request per card.
2. Task cards, aggregate cards and the mobile task list render, for a run that
   carries `claimRefusal`, a red badge in the existing anomaly badge row
   reading "executor v<executorVersion> ≠ API v<apiVersion>" (with
   "executor unversioned" when `executorVersion` is null), localized in `en`
   and `zh`. The phase label stays queued. The badge follows the existing
   badge rule: it never renders on absent inputs.

Out of scope: other causes of a long queue (no executor process, an unknown
runner id, a rejected token); the inbox alert and Feishu delivery; executor or
deployment behaviour; Task detail; the Run status enum; persisted schema.

Constraints: no migration; no additional request per card; the projection
payload grows only by the field named above; existing projection and card
tests pass unchanged apart from fixtures that gain the new field.

Acceptance:
1. Board projection tests: a QUEUED mechanical run with a mismatch activity at
   or after its `createdAt` yields `claimRefusal` with that code, both
   versions and `since`; a mismatch activity older than the run yields no
   field; a CLAIMED run with a mismatch activity yields no field.
2. Web tests: the badge renders with the versions text for a run carrying
   `claimRefusal`, renders "executor unversioned" for a null executor version,
   and is absent when the field is absent, on the task card, the aggregate
   card and the mobile list; both locale files carry the keys.
3. `npm run test -w @anneal/api` and `npm run test -w @anneal/web` are green.

Route: implementation=senior-dev-luna-max - default: adds a field and reuses existing badges with mechanical acceptance; crossing API and Web alone does not warrant escalation
