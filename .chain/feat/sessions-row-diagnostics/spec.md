Sessions: each row shows the run's diagnostics

A session row on the Sessions page expands to the same diagnostics the task detail page shows for that run, so an operator who spots a failed or slow run in the list reads its phases, token split, tool behaviour, effective output rate, TTFT and baseline comparison in place.

Background: the chain "Web: Task detail shows per-run diagnostics" added packages/api/src/run-metrics.ts and a `metrics` object per run on GET /tasks/:taskId, rendered as an expandable diagnostics block in apps/web/src/pages/TaskDetail.tsx; the chains "Runner: every model turn records time-to-first-token" and "API: task detail and the board carry a per-template-step baseline" extended that object with `ttft` and `vsBaseline`. GET /sessions and GET /sessions/:sessionId (packages/api/src/routes/session.ts) return Session rows through `sessionInclude` without metrics, and apps/web/src/pages/Sessions.tsx renders `SessionRow` entries that navigate to `SessionDetailPage`, whose details panel shows branch, duration, model, task and termination and whose stat pills show tokens, tool calls, files and messages.

Changes:
1. GET /sessions/:sessionId returns `metrics` computed by run-metrics.ts for that session's run, with the same shape and null semantics as the task detail route, including `ttft` and `vsBaseline`.
2. GET /sessions does not compute metrics for list rows; the list stays as cheap as today.
3. The Sessions page row's details panel gains the diagnostics block, rendered by the same component TaskDetail uses (extracted into apps/web/src/components if it is not already shared), loaded from GET /sessions/:sessionId when the row is expanded and shown with a loading state until it arrives.
4. docs/operator-api.md documents `metrics` on GET /sessions/:sessionId by reference to the GET /tasks/:taskId definition.

Out of scope: list filters and search (the preceding Sessions chain); metrics semantics; computing metrics in the list response; the live stream, debug and files panels; the Costs page.

Constraints: one diagnostics component serves both pages; no duplicated rendering logic. The list request's query count is unchanged.

Acceptance: a route test proves GET /sessions/:sessionId carries `metrics` with the same shape as the task detail route for the same run, and that GET /sessions rows carry none; a web test proves expanding a row fetches the session and renders the shared diagnostics component, including the null case; `npm run lint`, `npm run typecheck`, `npm run test -w @anneal/api` and `npm run test -w @anneal/web` are green; docs/operator-api.md documents the field.

Depends on: Runner: every model turn records time-to-first-token and task detail shows it - last chain of the serial line that builds the metrics object this page reuses

Route: implementation=senior-dev-luna-max - default: reuses existing diagnostics and wires a session response with mechanical acceptance; no new frontend design
