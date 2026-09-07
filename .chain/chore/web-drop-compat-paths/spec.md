Web: the console trusts the current API shapes and drops the pre-route compatibility paths

Goal: the web console no longer carries the bare-array event-stream branch or the "endpoint not implemented yet" degradation path; a 404 means a missing resource everywhere.

Background: web and API ship in one immutable release bundle, so the console never runs against an older API. (1) `apps/web/src/lib/use-event-stream.ts:37-42` `toEnvelope` still accepts a bare `SessionEvent[]` from a route shape retired since v0.1.0; the current route (`packages/api/src/routes/session.ts:617-628`) always returns `{events, nextAfterSeq, hasMore, total}`; `nextAfterSeq` is typed and written but never read (`absorb` tracks the last event's seq); two tests exist only for the retired shape (`apps/web/src/tests/event-stream.test.tsx:25` bare-array half, `:157`). (2) `ApiError.missingEndpoint` (`apps/web/src/lib/api.ts:60-63`), `Poll.missing` (`lib/hooks.ts:14,124,129`), `GapNotice` (`components/ui.tsx:331-341`) and the paste-an-Environment-ID fallback (`pages/Agents.tsx:90-91`) guard three endpoints that all exist and are documented (`GET /projects/:projectId/costs`, `GET /sessions`, `GET /projects/:projectId/environments`); `Poll.missing` treats 404 as "route missing" while `lib/poll-state.ts` `fatal()` treats 404 as "resource deleted", two contradicting rules for one status code. The operator approved removing both paths on 2026-09-06.

Changes:
1. Make `toEnvelope` accept only the envelope shape (a non-envelope body is a loud client error, not a silent filter); remove `nextAfterSeq` from the client type and adapter; delete the two retired-shape tests and keep the envelope tests.
2. Remove `ApiError.missingEndpoint`, `Poll.missing`, `GapNotice`, the `notice.gap` / `costs.gap.what` / `sessions.gap.what` / `agents.field.environment.hint.missing` copy keys in both locales, and the paste-an-ID fallback in `pages/Agents.tsx`; the three consumers render the normal loading/error states. 404 handling is the `poll-state.ts` `fatal()` rule everywhere.
3. Add one test asserting a 404 from `GET /sessions` surfaces as the standard error state, not a gap notice.

Out of scope: any API route, the Sessions or Costs page features under other chains (run-metrics wave is held), locale keys unrelated to the gap notice, the `Environments` create/list calls.

Constraints: no dead locale keys left (`npm run test -w @anneal/web` includes the locale parity test); no silent fallback replaces the removed one.

Acceptance: `npm run test -w @anneal/web`, `npm run typecheck -w @anneal/web`, `npm run lint` green; `git grep -E 'missingEndpoint|GapNotice|nextAfterSeq|Poll\.missing' origin/main -- apps/web` returns nothing after merge.