Sessions: server-side filters and search find any run without paging

An operator on the Sessions page can narrow the list by status, agent, runner, task or chain, date range and free text, with the server applying the filters across the whole history instead of the client filtering the fifty rows it has loaded.

Background: GET /sessions (packages/api/src/routes/session.ts, ~line 581) accepts only projectId, limit and a `before` cursor and returns the newest sessions with `sessionInclude` (run, task, agent and related fields). apps/web/src/pages/Sessions.tsx loads pages of fifty, groups them by day (apps/web/src/lib/session-list.ts filterAndGroupSessions) and offers two client-side selects, Agent and Status, with the hint "Filters apply to loaded Sessions only". There is no text search and no way to reach a run by its task, chain, branch or date except by pressing Load more until it appears. The task detail page has no link to the sessions of its chain.

Changes:
1. GET /sessions accepts optional query parameters `status` (one of live, done, failed, cancelled, mapped server-side to the execution and result statuses the web's session-list.ts already uses), `agentId`, `runner` (a RunnerKind value), `taskId`, `chainId`, `since` and `until` (ISO timestamps on requestedAt), and `q` (case-insensitive substring match against the task name, the run's branch and the session's failureReason). Filters combine with AND and with the existing `before` cursor and `limit`. An unparseable timestamp or an unknown enum value returns 400 with a named code rather than being dropped silently. The status mapping lives in one shared module used by both the API and the web.
2. The web page's Agent and Status selects query the server; the "loaded only" hint is removed. The page adds a Runner select, a date range (with Today, 7 days, 30 days and custom), and a search box that applies `q` after a short debounce. Changing any filter resets the cursor and reloads the first page; Load more continues under the same filters. Filters are reflected in the URL hash query so a filtered view can be shared or reloaded.
3. Each session row that belongs to a chain shows the chain name as a filter link that sets `chainId`; the task name is a link to the task detail page.
4. The task detail page's run table gains a "View sessions" link that opens the Sessions page filtered to that task's chain (or to the task when it has no chain).
5. The list route uses the existing indexes where they apply and adds an index only if a database-backed test shows the filtered query would otherwise sequentially scan Session; any added index is a migration.
6. docs/operator-api.md documents the new GET /sessions parameters, their refusal codes and the status mapping.

Out of scope: run diagnostics on the Sessions page (a following chain); changing the day grouping, the seen-state tracking, the live stream or debug event panels; full-text search across event payloads or transcripts; sorting by cost or duration; the Inbox and Costs pages.

Constraints: the filter contract is one shared definition; the web never re-implements the status mapping. A request with no filters behaves exactly as today. `q` never matches on ids or on event payloads. Refusals are explicit 400s with codes; no filter is silently ignored.

Acceptance: route tests prove each filter alone and in combination narrows results, that `before` paging works under a filter, that `q` matches task name, branch and failureReason case-insensitively, and that a bad `since` or unknown `status` returns 400 with its code; web tests prove that changing a filter reloads from the server with the expected query, that the hint no longer renders, that the URL hash carries the filters and restores them on load, and that the chain and task links set the filter or navigate; `npm run lint`, `npm run typecheck`, `npm run test -w @anneal/api` and `npm run test -w @anneal/web` are green; docs/operator-api.md documents the parameters.

Route: implementation=senior-dev-opus-high - operator chose Claude capacity; cursor paging combined with server-side filters and URL state needs judgement beyond mechanical acceptance
