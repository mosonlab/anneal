## Goal

The Sessions event stream parses only the envelope the API returns, and the Costs, Sessions and Agents pages interpret a 404 through the console's single poll-state rule instead of an "endpoint not implemented yet" notice.

## Background

Survey candidates SIM-WEB-002 and SIM-WEB-004, operator rulings 2026-09-06: the web bundle and the API always ship in one release bundle, so a mixed-revision deployment is not a supported state; the "paste an Environment ID" fallback on the Agents page is not a supported operator path. Today `toEnvelope` in `apps/web/src/lib/use-event-stream.ts` (~37-42) accepts a bare `SessionEvent[]` shape that no route has returned since v0.1.0 (`packages/api/src/routes/session.ts` ~617-628 always returns `{events, nextAfterSeq, hasMore, total}`), and `ApiError.missingEndpoint` (`apps/web/src/lib/api.ts` ~60-63), `Poll.missing` (`apps/web/src/lib/hooks.ts` ~14, ~124, ~129) and `GapNotice` (`apps/web/src/components/ui.tsx` ~331-341) turn a 404 on three existing routes into a build-order message that is now always wrong.

## Changes

1. In `use-event-stream.ts`: remove `toEnvelope`'s `Array.isArray` branch, type the `fetchPage` response as `EventPage` with a validating parse of the envelope, and drop `nextAfterSeq` from the client-side `EventPage` type; keep the `held`-based dedup in `absorb` with its comment rewritten so it no longer cites the old shape.
2. Delete the "old-shape response returned twice" test and the bare-array half of the `toEnvelope` test in `apps/web/src/tests/event-stream.test.tsx`; update the `page()` helper there and the envelope fixtures in `apps/web/src/tests/sessions.test.tsx` so they no longer carry `nextAfterSeq`.
3. Remove `ApiError.missingEndpoint`, `Poll.missing` (both return sites in `hooks.ts`) and `GapNotice`; keep the `NOTICE` base that `InfoNotice` shares.
4. Costs, Sessions and Agents interpret 404 through `poll-state.fatal` like every other page; on Agents, delete the paste-an-Environment-ID fallback and its hint copy.
5. Remove `notice.gap`, `costs.gap.what`, `sessions.gap.what` and `agents.field.environment.hint.missing` from both locale dictionaries; the i18n key-set equality test stays green.

## Out of scope

- The API response of `GET /runs/:runId/events` and its `nextAfterSeq` field (server wire shape unchanged; `docs/operator-api.md` untouched).
- Any other page's error handling or any change to `poll-state` semantics.

## Constraints

- No new fallback paths; an unexpected response shape fails the parse loudly.
- Behaviour on a real 404 (stopped control plane, deleted project) is the same as on every other page.

## Acceptance

- `git grep -n "missingEndpoint\|GapNotice\|nextAfterSeq\|toEnvelope" apps/web` returns nothing (`nextAfterSeq` may remain only in `packages/api`).
- `npm run test -w @anneal/web`, `npm run typecheck -w @anneal/web`, `npm run lint` pass; `npm run test -w @anneal/api -- session.test.ts` is unchanged.
- The diff touches only `apps/web`.