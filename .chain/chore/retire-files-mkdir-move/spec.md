Implement this task on chore/retire-files-mkdir-move directly from the feature brief below — a direct chain carries no spec or plan phase, so the brief is the specification of record. The platform materializes `.chain/chore/retire-files-mkdir-move/spec.md` as the specification of record; leave it untouched. The platform pins native child threads to Luna max and limits the session to eight concurrent children. Use them only when the brief contains independent, safely parallel work; group related change points instead of creating one child per item. In the controlled resource limit, fill as many slots as can execute safely in parallel. Give every concurrent writer its own branch and git worktree, and keep coupled work in your own context. When at least two child-writer branches need integration, start one long-lived merger after the first result is ready; integrate a sole child-writer branch yourself. The merger integrates completed branches in dependency-safe order, resolves only mechanical conflicts, reruns affected narrow tests, and reports semantic conflicts to you. Follow the platform-pinned Implementation proof boundary after integration. Give a failed child one bounded correction in the same thread, then take over its assignment yourself. A child must not perform irreversible external actions. Commit the result and persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Leave publication and pull-request creation to the platform. Complete when the brief's behavior is demonstrably delivered and tests are green at the recorded head.
<!-- agentos:task-brief:v1 length=2778 -->
## Goal

`POST /files/mkdir` and `POST /files/move` no longer exist, `FileStore.move` and its local implementation are gone, and the containment coverage for the remaining operations is unchanged.

## Background

Survey candidate SIM-API-004, operator ruling 2026-09-06 (defense theme D5): the operator does not call these routes by hand and no console file browser is planned. The routes live in `packages/api/src/routes/system.ts` (~129, ~140) over `FileStore.mkdir` / `FileStore.move` (`packages/api/src/files/store.ts`, implementations in `files/local.ts`); `mkdir` is also a member of `FileOperation` in `files/grants.ts`, which binds it into the grant capability model. The console has no file browser and the agent session-tool contract (`packages/runner/src/session-tool-contract.ts` ~286-304 and the pi extension) exposes only list, read, write and delete. `move` is the store's only two-path operation and carries symlink-escape containment reasoning for a call nothing makes. Depends on: the Inbox supersede chain, bound after it because both edit `docs/operator-api.md` and `packages/api/src/app-routes.test.ts`.

Route: implementation=senior-dev-luna-max - retirement of dead routes; surviving containment tests must stay byte-identical, which the acceptance checks mechanically

## Changes

1. Delete both routes from `routes/system.ts` and their entries in `packages/api/src/app-routes.test.ts` and `files/routes.test.ts`.
2. Delete `FileStore.move` from `store.ts` and `local.ts` with the move-specific containment tests in `files/local.test.ts`; every containment test for list, read, write and delete remains byte-identical.
3. `mkdir`: remove `FileStore.mkdir` and its route; remove `"mkdir"` from `FileOperation` only if no persisted grant or capability consumer needs the name — if a consumer exists, keep the member and say so in the PR body.
4. Remove both handbook sections from `docs/operator-api.md`; add one bullet under `## Unreleased` in `CHANGELOG.md`.

## Out of scope

- The four session-scoped file verbs, `files/grants.ts` semantics beyond the `mkdir` member, and Filesystem Grants administration in the console.
- Any change to the Files Root layout or `FILES_ROOT` handling.

## Constraints

- No containment test for a surviving operation is edited; the diff to `local.test.ts` is deletions of move/mkdir cases only.
- Fail loud: removed routes return the router's ordinary 404.

## Acceptance

- `git grep -n "files/mkdir\|files/move\|\.move(" packages apps docs` returns nothing except CHANGELOG.
- `npm run test -w @anneal/api` (files/local.test.ts, files/routes.test.ts, files/session-routes.test.ts, app-routes.test.ts), `node --test scripts/operator-api-docs.test.mjs`, `npm run lint`, `npm run typecheck` pass.
<!-- /agentos:task-brief:v1 -->
Persist the final implementation output for this step through the Anneal task output endpoint.