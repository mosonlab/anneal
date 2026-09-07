Web: board cards show the run's current phase, time in phase, and anomaly badges

A board card answers which phase a task is in, how long it has been there, and whether anything is abnormal, without opening the task.

Background: apps/web/src/components/task-card.tsx shows one elapsed clock derived from runLiveness in apps/web/src/lib/board.ts and a RunLine (components/run-line.tsx); apps/web/src/components/chain-aggregate-card.tsx shows the frontier task's run line. The board projection in packages/api/src/board.ts carries, per task, at most one latest run with session timestamps and cost, and after the chain "API: task detail and the board carry a per-template-step baseline" a `baseline` object. The chain "Web: Task detail shows per-run diagnostics" introduced phase arithmetic in packages/api/src/run-metrics.ts. Costs (packages/api/src/costs.ts) already computes chain cost, lead time and repair counts for the Costs page. On the board today a card that has sat in provisioning for ten minutes looks exactly like one that has been executing for ten minutes, and a run three times over its usual cost looks like any other.

Changes:
1. The board projection exposes, on each task's latest run, `phase` (one of queued, provisioning, executing, waiting-inbox, cleanup, finished), `phaseSince` (ISO timestamp), and `lastProgressEventAt`, computed server-side by a helper shared with run-metrics.ts so the two never disagree.
2. task-card.tsx replaces the single elapsed clock on a live run with the phase label and the time spent in that phase; finished runs keep the current duration and time-ago rendering.
3. Anomaly badges render only when their condition is true and its inputs are known: `stalled` when the run is executing and now minus lastProgressEventAt exceeds a constant named in board.ts (default 5 minutes); `over baseline` when the run's cost or executing duration exceeds twice the baseline p50, only when the baseline is non-null; `retries` showing n/max when the task has two or more runs. Each badge has hover text stating its threshold. No badge appears on unknown data.
4. chain-aggregate-card.tsx shows the chain's cumulative cost, lead time since the chain's first run started, and repair rounds, computed from data already present in the full board rows through apps/web/src/lib/chain-aggregate.ts; no per-card request is made.
5. apps/web/src/components/mobile-task-list.tsx shows the same phase label; badges on mobile follow the same conditions.
6. All strings are in apps/web/src/locales/en.ts and zh.ts. docs/operator-api.md documents the new fields on the board projection of GET `/tasks`.

Out of scope: TaskDetail; the Costs page; the semantics of metrics or baselines; new polling endpoints or per-card fetches; board column semantics and card movement rules; archived view.

Constraints: no additional request per card. Badges never render on null inputs. The board payload grows only by the phase fields listed in change 1, `latestRun.maxRunsPerTask` for the retry denominator, and `chainAggregate.firstRunStartedAt` for lead time. `firstRunStartedAt` is the earliest non-null `Run.startedAt` across complete primary-Step run history, computed server-side from the existing full-chain reads and consumed by `chain-aggregate.ts`; it is null if no primary Run has started. Existing card layouts for finished tasks are unchanged except for the added aggregate figures.

Acceptance: board projection tests prove phase and phaseSince for each phase and a live-run case; web tests prove each badge appears under its condition and is absent when inputs are null (including null baseline), the phase label and time in phase render for a live run, and the aggregate card shows cost, lead time and repair rounds from fixture rows; existing card tests are updated rather than deleted; `npm run lint`, `npm run typecheck`, `npm run test -w @anneal/api` and `npm run test -w @anneal/web` are green; docs/operator-api.md documents the fields.

Depends on: API: task detail and the board carry a per-template-step baseline - consumes `baseline` on board rows and the shared phase helper

Route: implementation=frontend-dev-opus-high - operator chose Opus high for this board surface

Review-fix decision: the operator explicitly authorized these two additional fields via Anneal Inbox (`authorize-fields`), resolving SPEC-002 and SPEC-003 / BR-4 without per-card requests.
