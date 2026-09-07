API: task detail and the board carry a per-template-step baseline for cost and duration

A run can be compared with the median and p90 cost and duration of completed runs of the same template step in the same project, on both the task detail response and the board projection.

Background: chain tasks reference their TaskTemplateStep through Task.templateStepId, so every "Implementation" or "Code review" run of the same template shares a step id. Session stores costUsd, startedAt and endedAt; Run stores status. `readBoard` in `packages/api/src/board.ts` serves the `GET /tasks?view=board` card projection, with each row carrying `runs[].session`; GET /tasks/:taskId in packages/api/src/routes/tasks.ts returns every run, and the preceding chain "Web: Task detail shows per-run diagnostics" attached a `metrics` object to each run computed by packages/api/src/run-metrics.ts. Today the only comparison an operator can make is against memory: nothing states what this step usually costs or how long it usually takes, so "slow" and "expensive" remain impressions.

Changes:
1. A new module packages/api/src/run-baseline.ts computes baselines with one SQL statement (percentile_cont over the project's terminally successful runs, grouped by templateStepId, joined to their session): `sampleSize`, `costUsd.p50`, `costUsd.p90`, `durationMs.p50`, `durationMs.p90`. Cost percentiles use runs whose session costUsd is non-null; duration percentiles use runs whose session has both startedAt and endedAt; each metric reports its own sample size. The module defines "terminally successful" from the RunStatus enum and states the choice in a comment. A baseline is null when its sample size is below 5.
2. GET /tasks/:taskId adds a task-level `baseline` (null for a task without templateStepId or with insufficient samples) and, on every `runs[]` entry, `metrics.vsBaseline` with `costRatio` and `durationRatio` (the run's value divided by the p50), each null when the baseline or the run's own value is null.
3. The board projection (GET /tasks with view=full) adds `baseline` to every task row using one grouped query per request covering all templateStepIds on the page, not one query per task. The board contract type is updated.
4. apps/web/src/pages/TaskDetail.tsx shows, in the diagnostics block, the run's cost and executing duration beside the baseline p50 and p90 with the ratio, and shows "insufficient history" when the baseline is null; i18n strings in en.ts and zh.ts.
5. docs/operator-api.md documents `baseline` on GET `/tasks/:taskId` and on the board projection of GET `/tasks`, and `metrics.vsBaseline`.

Out of scope: board card rendering (a later chain consumes `baseline`); the Costs page; caching or materialising baselines in a table; database schema or migrations; changing the metrics semantics defined by the diagnostics chain; standalone tasks without a template step (they receive null).

Constraints: null means insufficient history, never 0. Percentiles are computed in SQL, not by loading rows into JavaScript. The board request's query count must not grow with the number of tasks on the page. Ratios are computed from the same raw values the diagnostics chain exposes, so the two never disagree.

Acceptance: a database-backed test seeds six successful runs of one template step and two of another and proves p50/p90 for the first, null for the second, and that a run with null cost is excluded from the cost sample but included in duration; a route test proves `baseline` and `metrics.vsBaseline` on GET /tasks/:taskId and null ratios when the baseline is null; a board projection test proves `baseline` on rows and that the query count is constant across page sizes; web tests render the comparison and the insufficient-history case; `npm run lint`, `npm run typecheck`, `npm run test -w @anneal/api` and `npm run test -w @anneal/web` are green; docs/operator-api.md documents the fields.

Depends on: Web: Task detail shows per-run diagnostics - extends the metrics object and the diagnostics block it introduced

Route: implementation=senior-dev-opus-medium - operator chose Claude capacity; read-only aggregation with mechanical acceptance
