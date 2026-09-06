## Goal

`POST /inbox/messages/:messageId/supersede` no longer exists; an Inbox message reaches `CLOSED` through `POST /inbox/messages/:messageId/close` and the task-archive stop-notice closer only.

## Background

Survey candidate SIM-API-006 (records audit 2026-09-04), operator ruling 2026-09-06: the operator has never called supersede by curl. The route at `packages/api/src/routes/inbox.ts` (around line 320) and `supersedeTaskInboxMessage` in `packages/api/src/inbox.ts` (lines ~56-130, with the `SupersedeInboxMessageResult` refusal ladder) write the same terminal `InboxStatus.CLOSED` as close, under a different precondition set, and have no caller: the console calls only close, decision and reply (`apps/web/src/pages/Inbox.tsx`), the runner session-tool contract exposes only `/session/runs/:runId/inbox/questions`, and Feishu card actions route through decision and reply. The archive handler (`packages/api/src/routes/tasks.ts` ~682-730) already closes open merge-tail stop notices on archive and is not to be widened.

Route: implementation=senior-dev-astra-medium - public route removal over persisted Inbox state whose helper runs a locked CAS transaction; the review tail must confirm the archive closer's scope is unchanged

## Changes

1. Delete the `POST /inbox/messages/:messageId/supersede` route registration and handler from `packages/api/src/routes/inbox.ts`.
2. Delete `supersedeTaskInboxMessage`, `SupersedeInboxMessageResult` and any helper used only by them from `packages/api/src/inbox.ts`.
3. Delete `packages/api/src/inbox-superseded-close.test.ts`; remove supersede cases from `packages/api/src/routes/inbox.test.ts` and `packages/api/src/inbox-project-scope.dbtest.ts` without weakening the close, decision and reply coverage in those files.
4. Remove the route from the pinned inventory in `packages/api/src/app-routes.test.ts`.
5. Remove the handbook section for the route from `docs/operator-api.md`; add one bullet under `## Unreleased` in `CHANGELOG.md` stating the route is removed and that close is the only closure transition.

## Out of scope

- `POST /tasks/:taskId/archive` and its stop-notice closer: behaviour and scope unchanged.
- The `/environments/:environmentId` verbs and `GET /agents/:agentId/secret-grants` mentioned in the same survey record (separate decisions; secret-grant routes are protected).
- Any change to `InboxStatus`, the Inbox schema, or the console.

## Constraints

- No other Inbox transition gains a new precondition or loses one.
- Fail loud: the removed path returns the router's ordinary 404, not a stub.

## Acceptance

- `git grep -n "supersede" packages apps docs scripts` returns nothing except the CHANGELOG entry and historical release notes.
- `npm run test -w @anneal/api` passes (inbox route tests, app-routes inventory); `node --test scripts/operator-api-docs.test.mjs` passes.
- `npm run lint`, `npm run typecheck`, `npm run test:snapshot-scan` pass.
- The diff touches only `packages/api/src`, `docs/operator-api.md` and `CHANGELOG.md`.