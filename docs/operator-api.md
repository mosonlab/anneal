# Operator API handbook

## Conventions

The operator drives Anneal through this HTTP API. Unless a route is marked
**Public** or **Webhook**, send `Authorization: Bearer $OPERATOR_TOKEN`.
Examples use `$BASE_URL` (for example, `http://127.0.0.1:3000`) and placeholder
IDs such as `$PROJECT_ID`; replace them with values from your installation.
JSON request bodies require `Content-Type: application/json`.

Malformed JSON request bodies return `400 Bad Request` with code `invalid-json`
and message `Request body must be valid JSON` on every JSON route. Empty bodies
receive the same refusal when a route requires a JSON body; the manual-fire
route is the exception because it intentionally treats an empty body as an
empty object. A syntactically valid body that fails its route schema still
returns the usual `400 Bad Request` validation response.

The route list and input requirements below use the same method and path
spelling as the route definitions in `packages/api/src/app.ts` and
`packages/api/src/routes/`. Fields called
“optional (default …)” are filled by the API when omitted. A body described as
“at least one” is validated by a patch schema and must contain one or more of
the named fields. This route list is coverage-tested against those API route
source files; missing or stale entries fail
`scripts/operator-api-docs.test.mjs`.

The polled collection routes `GET /projects`, `GET /projects/:projectId/agents`,
`GET /projects/:projectId/repos`, `GET /tasks`, `GET /inbox/messages`, and
`GET /inbox/messages/summary` return an `ETag`. Send it back in
`If-None-Match`; unchanged data returns `304 Not Modified` with an empty body.

## Service, status, and onboarding

### GET `/` — Public

- Required parameters: none.

```sh
curl "$BASE_URL/"
```

### GET `/health` — Public

- Required parameters: none.

```sh
curl "$BASE_URL/health"
```

### GET `/version` — Public

- Required parameters: none.

```sh
curl "$BASE_URL/version"
```

### GET `/runners`

- Required parameters: none.
- `dispatchDrain` is `null` when no unexpired dispatch drain exists, and
  otherwise `{reason, startedAt, expiresAt}`: the platform-wide drain an
  auto-deploy opens when its quiet-window wait outlives its budget. `reason`
  names the waiting host, its deploy role, and the two commits. While it is
  present, only claims that would start an agent session are refused; the
  mechanical merge and readiness flow continues. The daemons below remain
  online and report themselves rather than being treated as lost. An expired
  drain reads as `null` here and is ignored by the claim route, whether or not
  its row was deleted.

The auto-deploy scheduler wakes every five minutes on both host profiles, but
each wake is only a tick. On the control-plane role, when `main` has moved, the
tick consults the last successful automatic deploy recorded under
`.agentos-deploy/auto-deploy-state.json`. Both host roles read
`AUTO_DEPLOY_MIN_INTERVAL_MINUTES` from that host's `shared/.env` (default
**240 minutes**); runner-only deployment retains its existing `/version`
follow behavior. If main has changed but the interval has not elapsed
and blockers remain, the tick coalesces, logs
`NOOP coalescing next-eligible=<time>`, and does not enter the wait budget or
open a dispatch drain. A quiet window already open at tick time (`blockers=0`)
is an early natural-quiet exception to the interval floor. Once the quiet
window and deploy barrier are obtained, a control-plane auto-deploy re-reads
`origin/main`; if it advanced beyond the tick target, it logs
`target-advanced from=<old> to=<new>` and builds the artifact for the new head
before publication. Runner-only deployment keeps its target from the control
plane's `/version` contract. See the [quiet-window auto-deploy runbook](runbooks/quiet-window-auto-deploy.md#automatic-deploy-cadence)
for the operator procedure.

```sh
curl "$BASE_URL/runners" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/onboarding`

- Required parameters: none.

```sh
curl "$BASE_URL/onboarding" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/onboarding`

- Required JSON fields: `project.name`, `repo.name`, `repo.remoteUrl`,
  `acknowledgedHostExecution` (must be `true`).
- Optional JSON fields: `project.slug` (derived from the name),
  `repo.defaultBranch` (default `main`), and `repo.mountPath` (the starter
  mount path, which must be `repo`).

```sh
curl -X POST "$BASE_URL/onboarding" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"project":{"name":"Demo"},"repo":{"name":"demo","remoteUrl":"https://github.com/acme/demo.git"},"acknowledgedHostExecution":true}'
```

### Merge-train readiness configuration

The API reads `MERGE_TRAIN_WIDTH` at startup. It accepts an integer from `0`
through `3`; when it is unset, the effective value is `0`. `0` leaves Merge
readiness on its existing single-candidate path. Values `1`, `2`, and `3`
enable cumulative train readiness and bound each train to that many
candidates. A non-integer or a value outside `0` through `3` is a startup
configuration refusal naming `MERGE_TRAIN_WIDTH`; the API does not start, and
the readiness worker uses the width the startup verdict validated rather than
re-reading the environment. Restart the API after changing the setting.

## Files

These routes address the configured Files Root. A missing query parameter means
the Files Root itself (`dir`, `path`, and `recursive` each have route-level
defaults).

### GET `/files`

- Required parameters: none.
- Optional query: `dir`.

```sh
curl "$BASE_URL/files?dir=docs" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/files/content`

- Required parameters: none.
- Optional query: `path`.

```sh
curl "$BASE_URL/files/content?path=README.md" -H "Authorization: Bearer $OPERATOR_TOKEN" -o README.md
```

### PUT `/files/content`

Writing a file creates any missing parent directories within the Files Root.

- Required parameters: raw request body containing the file bytes.
- Optional query: `path` (empty path targets the Files Root and is normally
  rejected by the underlying file operation).

```sh
curl -X PUT "$BASE_URL/files/content?path=notes/today.md" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" --data-binary @notes/today.md
```

### DELETE `/files`

- Required parameters: none.
- Optional query: `path`, `recursive` (`true` enables recursive deletion).

```sh
curl -X DELETE "$BASE_URL/files?path=archive/draft.md" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## Projects and environments

### GET `/projects`

- Required parameters: none.

```sh
curl "$BASE_URL/projects" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects`

- Required JSON fields: `name`, `slug` (lowercase hyphenated form).
- Optional JSON field: `yamlDocument` (default `""`).
- A successful request creates the Project and, in the same transaction, one
  `local` Environment with `networking` `OPEN` and `allowedHosts` `[]`, four
  Agents (`senior-dev-luna-max`, `code-reviewer-sol-high`,
  `code-reviewer-opus-medium`, and `senior-dev-astra-low`) bound to that Environment, and
  the canonical `pr-engineer-workflow` TaskTemplate with its four steps.
  The returned Project read shape includes `specGateDefault` and
  `mergeGateDefault`, both `false` for a newly created project.
- A duplicate slug returns `409 Conflict` with code `project-slug-taken`.

```sh
curl -X POST "$BASE_URL/projects" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Demo","slug":"demo"}'
```

### GET `/projects/:projectId`

- Required path parameter: `projectId`.
- The Project read shape includes the independent boolean fields
  `specGateDefault` and `mergeGateDefault`. Both are `false` for a newly created
  project and are returned by this route, `GET /projects`, and the project PATCH
  response.

```sh
curl "$BASE_URL/projects/$PROJECT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PATCH `/projects/:projectId`

- Required path parameter: `projectId`.
- Required JSON: at least one of `name`, `slug`, `yamlDocument`,
  `specGateDefault`, or `mergeGateDefault`.
- `specGateDefault` and `mergeGateDefault` are optional booleans. Omission
  preserves the stored value, and changing one does not change the other. The
  response is the complete Project read shape, including both settings.
- The request schema is strict: a body carrying any other key, including the
  retired `skipOptionalSteps` switch, returns `400 Bad Request` and writes
  nothing. Optional-step omission is now a staffing decision made per
  instantiation.

```sh
curl -X PATCH "$BASE_URL/projects/$PROJECT_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"mergeGateDefault":true}'
```

### DELETE `/projects/:projectId`

- Required path parameter: `projectId`.
- Deletes the Project and every row the Project owns—agents, repos, templates, staffing
  profiles, tasks, runs, sessions, goals, inbox items, chain controls, and merge
  leases—in one database transaction. On success, the route returns `204 No
  Content` with an empty body.
- If no Project has that id, the route returns `404 Not Found` with exactly:

  ```json
  { "error": "Project not found" }
  ```

```sh
curl -X DELETE "$BASE_URL/projects/$PROJECT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/projects/:projectId/costs`

- Required path parameter: `projectId`.
- Required query parameter: `tz` (recognized IANA timezone).
- Optional query parameter: `days` (`1`, `7`, `30`, or `90`; default `30`).
- The response retains the aggregate totals, daily series, model totals, agent
  totals, and top runs. Agent rows additionally report cached-read percentage,
  unknown-split run count, and known uncached-input tokens and spend.
- Model totals retain each Run's root model, including native-child Runs whose
  unsplit token usage is estimated at that root model's rates.
- `waste` partitions `wastedUsd` exactly into operator-cancelled and failed
  spend; failed spend is further partitioned by failure class.
- `chains` contains terminal chains whose last run ended in the window, with
  lead/busy time, repair counts, longest idle gap, priced spend by step role,
  and an unpriced-run count. Each chain row also carries `readinessRequeues`
  and `readinessGrants`: how many times merge readiness returned that chain's
  candidate to Regression because its base moved before authorization, and how
  many extra Run attempts those requeues granted. The grants funded Runs that
  are already inside `costUsd`; the two counts make that share attributable.
  The `unassigned` role is used when persisted step
  metadata cannot classify priced spend. Unknown cache splits are counted and
  excluded from cache metrics; unpriced chain runs never receive a fabricated
  cost.
- For Claude, `total_cost_usd` and `modelUsage` are cumulative within one
  provider process and `session_id`. The latest usable totals in that group
  count once, including repeated task-notification results. Each persisted
  `PROCESS_STARTED` starts a separate accounting group: resume retains the
  provider `session_id` but resets its counters, so process totals are added.
  Different provider session ids within a process are also added. The top-level
  `usage` block remains per invocation. Historical events before the first
  recorded process start form an initial group; missing boundaries cannot be
  reconstructed from counter values alone. Recomputing stored events uses the
  same rules and is idempotent. A process with no final result adds no usage.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/costs?days=1&tz=America%2FLos_Angeles" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/projects/:projectId/environments`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/environments" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/environments`

- Required path parameter: `projectId`.
- Required JSON field: `name`.
- Optional JSON fields: `networking` (`OPEN` or `LIMITED`, default `LIMITED`),
  `allowedHosts` (default `[]`).

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/environments" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"local"}'
```

### GET `/environments/:environmentId`

- Required path parameter: `environmentId`.

```sh
curl "$BASE_URL/environments/$ENVIRONMENT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PATCH `/environments/:environmentId`

- Required path parameter: `environmentId`.
- Required JSON: at least one of `name`, `networking`, `allowedHosts`.

```sh
curl -X PATCH "$BASE_URL/environments/$ENVIRONMENT_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"networking":"LIMITED","allowedHosts":["api.example.com"]}'
```

### DELETE `/environments/:environmentId`

- Required path parameter: `environmentId`.

```sh
curl -X DELETE "$BASE_URL/environments/$ENVIRONMENT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## Secrets

Secret values are accepted only on create/update and are not returned by the
read routes. `purpose` is one of `MCP`, `REPO`, `ENV`, or `WEBHOOK`.

### GET `/secrets`

- Required parameters: none.

```sh
curl "$BASE_URL/secrets" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/secrets`

- Required JSON fields: `name`, `purpose`, `value`.
- Optional JSON field: `description` (default `null`).

```sh
curl -X POST "$BASE_URL/secrets" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"GitHub token\",\"purpose\":\"REPO\",\"value\":\"$REPO_TOKEN\"}"
```

### GET `/secrets/:secretId`

- Required path parameter: `secretId`.

```sh
curl "$BASE_URL/secrets/$SECRET_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PATCH `/secrets/:secretId`

- Required path parameter: `secretId`.
- Required JSON: at least one of `name`, `purpose`, `description`, `value`.

```sh
curl -X PATCH "$BASE_URL/secrets/$SECRET_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d "{\"value\":\"$NEW_REPO_TOKEN\"}"
```

### DELETE `/secrets/:secretId`

- Required path parameter: `secretId`.

```sh
curl -X DELETE "$BASE_URL/secrets/$SECRET_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## Agents and capabilities

Every Agent response carries three fields beyond its stored columns and prompts:

- `canonicalRole` — the `agents/roles/<role>.md` file this Agent was installed
  from, or `null` for one you created. It is the Agent's canonical identity:
  seeding, canonical prompt sync and role binding all match on it, so renaming an
  Agent never detaches it from its role.
- `customizedFields` — the fields you edited (`name`, `title`, `model`,
  `runnerPreference`). Canonical sync adopts every field that is not listed and
  leaves the listed ones alone. Prompts are never listed: they always follow
  canonical.
- `assignable` — `false` only for the mechanical merge sentinel
  `merge-integrator`, which exists so the merge step can carry a Run but is not
  an Agent you may assign. Agent pickers filter on it.

### GET `/projects/:projectId/agents`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/agents" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/agents`

- Required path parameter: `projectId`.
- Required JSON fields: `environmentId`, `name`, `title`, `model`, `rolePrompt`.
- Optional JSON fields: `foundationalPrompt`, `codexServiceTier` (`DEFAULT` or
  `FAST`, default `DEFAULT`), `runnerPreference` (`CLAUDE`, `CODEX`, `PI`,
  `AUTO`, or `INHERIT`, default `INHERIT`), `inboxAccess` (default `false`),
  `disabledTools` (default `[]`).

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/agents" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"environmentId":"'$ENVIRONMENT_ID'","name":"builder","title":"Builder","model":"gpt-5","rolePrompt":"Implement the assigned work."}'
```

### GET `/agents/:agentId`

- Required path parameter: `agentId`.

```sh
curl "$BASE_URL/agents/$AGENT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PATCH `/agents/:agentId`

- Required path parameter: `agentId`.
- Required JSON: at least one agent field (`environmentId`, `name`, `title`,
  `model`, `codexServiceTier`, `foundationalPrompt`, `rolePrompt`,
  `runnerPreference`, `inboxAccess`, or `disabledTools`).
- Editing `name`, `title`, `model` or `runnerPreference` to a different value adds
  that field to `customizedFields`, so canonical sync stops rewriting it.
  Submitting the value the Agent already has marks nothing.
- Refused with 400 when the Agent is bound to a compound implementation root and
  the patch would leave it on a non-Codex runner or a non-`gpt-*` model: that step
  drives subagents and only a Codex `gpt-*` runtime can run it. The refusal follows
  the binding, not the Agent's name — an Agent that binds no such step may take any
  runtime the catalog allows.
- Refused with 400 when it would rename `merge-integrator`, the mechanical merge
  sentinel the platform identifies by name.

```sh
curl -X PATCH "$BASE_URL/agents/$AGENT_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Senior builder"}'
```

### POST `/agents/:agentId/reset-runtime-config`

- Required path parameter: `agentId`.
- Required JSON: none. The agent must carry a `canonicalRole` whose role source
  exists, and must not be archived. The source is found by `canonicalRole`, so a
  renamed Agent still resets to the role it was installed from. The canonical
  role's `model` and `runnerPreference` are applied immediately and removed from
  `customizedFields`, so both become eligible for future canonical runtime
  updates; an edited `name` or `title` stays customized. A stored non-default
  `codexServiceTier` must also be valid for the canonical model and runner; if
  reset refuses that combination, first PATCH `codexServiceTier` to `DEFAULT`,
  then retry the reset.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/reset-runtime-config" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### DELETE `/agents/:agentId`

- Required path parameter: `agentId`.
- Returns `204 No Content` when no Task, Run, Session, or staffing profile
  references the Agent.
- The delete never cascades through history. When references remain, the route
  returns `409 Conflict` with this body shape; `staffingProfiles` counts
  distinct profiles referenced through an entry, tier, or merge-tail repair
  Agent, and every count is returned even when it is zero:

  ```json
  {
    "error": "<message>",
    "code": "agent_referenced",
    "references": {
      "tasks": 0,
      "runs": 1,
      "sessions": 0,
      "staffingProfiles": 0
    }
  }
  ```

  A refusal leaves the Agent and all of its history unchanged. If no Agent has
  that id, the route returns `404 Not Found` with exactly:

  ```json
  { "error": "Agent not found" }
  ```

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/archive`

- Required path parameter: `agentId`.
- Refused with 409 when the Agent still holds live task or run references, and
  when any staffing profile entry names it; the refusal lists the profiles, which
  you edit before retrying.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/archive" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/unarchive`

- Required path parameter: `agentId`.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/unarchive" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/duplicate`

- Required path parameter: `agentId`.
- Required JSON field: `name`, the copy's Agent name; it must be free in the
  project. Unknown fields are rejected with `400 Bad Request`.
- Copies the setup, not the history: prompts, `model`, `runnerPreference`,
  `codexServiceTier`, `disabledTools`, `environmentId`, `inboxAccess`, the
  collaborators this Agent may talk to, and its repository, skill, MCP, secret and
  filesystem grants (with fresh grant ids). Tasks, template steps, sessions, runs,
  inbox history and other Agents' collaborations with this one are not copied.
- The copy is your Agent, not the role: `canonicalRole` is `null` and
  `customizedFields` empty, so canonical sync never rewrites it.
- Refused with 409 when `name` is taken in the project, and when the source is
  `merge-integrator`: one mechanical merge sentinel is the whole contract.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/duplicate" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"senior-dev-luna-max-experiment"}'
```

### GET `/agents/:agentId/secret-grants`

- Required path parameter: `agentId`.

```sh
curl "$BASE_URL/agents/$AGENT_ID/secret-grants" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/secret-grants`

- Required path parameter: `agentId`.
- Required JSON fields: `secretId`, `envVar` (an environment-variable name).

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/secret-grants" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"secretId":"'$SECRET_ID'","envVar":"GITHUB_TOKEN"}'
```

### DELETE `/agents/:agentId/secret-grants/:secretId/:envVar`

- Required path parameters: `agentId`, `secretId`, `envVar`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID/secret-grants/$SECRET_ID/GITHUB_TOKEN" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/agents/:agentId/filesystem-grants`

- Required path parameter: `agentId`.

```sh
curl "$BASE_URL/agents/$AGENT_ID/filesystem-grants" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/filesystem-grants`

- Required path parameter: `agentId`.
- Required JSON field: `folderPath` (use `""` for the whole Files Root).
- At least one of `canRead`, `canWrite`, `canDelete` must be `true`; each
  defaults to `false`.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/filesystem-grants" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"folderPath":"repo","canRead":true,"canWrite":true}'
```

### PATCH `/agents/:agentId/filesystem-grants/:grantId`

- Required path parameters: `agentId`, `grantId`.
- Required JSON: at least one of `folderPath`, `canRead`, `canWrite`,
  `canDelete`.

```sh
curl -X PATCH "$BASE_URL/agents/$AGENT_ID/filesystem-grants/$GRANT_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"canWrite":false}'
```

### DELETE `/agents/:agentId/filesystem-grants/:grantId`

- Required path parameters: `agentId`, `grantId`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID/filesystem-grants/$GRANT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/collaborators`

- Required path parameter: `agentId`.
- Required JSON field: `allowedAgentId`.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/collaborators" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"allowedAgentId":"'$COLLABORATOR_AGENT_ID'"}'
```

### DELETE `/agents/:agentId/collaborators/:allowedAgentId`

- Required path parameters: `agentId`, `allowedAgentId`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID/collaborators/$COLLABORATOR_AGENT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/projects/:projectId/skills`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/skills" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/skills`

- Required path parameter: `projectId`.
- Required JSON fields: `name`, `slug`, `kind` (`PROMPT` or `FILE`).
- Optional JSON fields: `body` and `filePath` (default `null`); `PROMPT`
  requires `body`, while `FILE` requires `filePath`.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/skills" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Review checklist","slug":"review-checklist","kind":"PROMPT","body":"Check the acceptance criteria."}'
```

### POST `/agents/:agentId/skills`

- Required path parameter: `agentId`.
- Required JSON field: `skillId`.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/skills" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"skillId":"'$SKILL_ID'"}'
```

### DELETE `/agents/:agentId/skills/:skillId`

- Required path parameters: `agentId`, `skillId`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID/skills/$SKILL_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## MCP connections

### GET `/projects/:projectId/mcp-connections`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/mcp-connections" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/mcp-connections`

- Required path parameter: `projectId`.
- Required JSON fields: `name`, `transport`.
- Optional JSON fields: `config` (record, default `{}`), `allowedOperations`
  (array, default `[]`), `credentialSecretId` (default `null`).

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/mcp-connections" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Docs MCP","transport":"stdio","config":{"command":"docs-mcp"}}'
```

### POST `/agents/:agentId/mcp-connections`

- Required path parameter: `agentId`.
- Required JSON field: `mcpConnectionId`.

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/mcp-connections" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"mcpConnectionId":"'$MCP_CONNECTION_ID'"}'
```

### DELETE `/agents/:agentId/mcp-connections/:connectionId`

- Required path parameters: `agentId`, `connectionId`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID/mcp-connections/$MCP_CONNECTION_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## Repositories

### GET `/projects/:projectId/repos`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/repos" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/repos`

- Required path parameter: `projectId`.
- Required JSON fields: `name`, `remoteUrl`, and `dependencyProvisioning`.
- Optional JSON fields: `mountPath` (default `repo`), `defaultBranch`
  (default `main`), `credentialSecretId` (default `null`), and `grantAgents`
  (default `false`).
- `dependencyProvisioning` must be exactly `NONE` or `NPM_CI`; it declares
  whether the runner provisions the repository's Node dependencies. Missing or
  unknown values return `400 Bad Request` with exactly:

  ```json
  { "error": "Repository dependency provisioning is invalid", "code": "repository-dependency-provisioning-invalid" }
  ```
- `remoteUrl` is validated as the raw submitted string before any trim or
  transform. The onboarding remote policy accepts HTTPS without userinfo,
  `ssh://` and scp-like SSH remotes with no account or the `git` account, and
  local `file:///` remotes. It rejects whitespace, control characters,
  query/fragment data, option-like values, unsupported schemes or SSH
  accounts, missing hosts or paths, and values over the maximum length. This
  ordinary Repo route deliberately applies onboarding's SSH-account
  restriction too.
- `defaultBranch` is defaulted to `main` and must pass the API's
  `isValidBranchName` policy. A rejected remote returns `400 Bad Request`
  with exactly:

  ```json
  { "error": "Repository remote is invalid", "code": "repository-remote-invalid", "reason": "<parseRepoRemote rejection reason>" }
  ```

  A rejected branch returns `400 Bad Request` with exactly:

  ```json
  { "error": "Repository default branch is invalid", "code": "repository-default-branch-invalid" }
  ```

  Neither refusal echoes the rejected value, opens the Repo/grant transaction,
  or invokes repository preflight. A duplicate `(projectId, name)` returns
  `409 Conflict` with exactly `{ "error": "Unique constraint violated" }`.
- After validation and before the database transaction opens, the route runs
  repository preflight against
  `{ remoteUrl, defaultBranch, dependencyProvisioning }`. The preflight uses
  the API host's ambient Git identity and credentials for its identity,
  remote/default-branch, fetch, and dry-run-push checks; it never receives,
  reads, or decrypts `credentialSecretId` (that field's existing Secret
  existence/enabled validation is unchanged). A preflight refusal returns
  `422 Unprocessable Entity` with exactly:

  ```json
  { "error": "Repository preflight failed", "code": "repository-preflight-failed", "reason": "<existing failure reason>" }
  ```

  The possible reasons are `git-unavailable`, `git-identity-missing`,
  `remote-unreachable`, `default-branch-missing`, `push-not-authorized`, and
  `command-timeout`. When `dependencyProvisioning` is `NPM_CI`, preflight also
  requires a regular root `package-lock.json` in the exact fetched default
  branch commit. A missing or non-regular lockfile returns `422 Unprocessable
  Entity` with exactly:

  ```json
  { "error": "Repository preflight failed", "code": "repository-package-lock-missing", "remedy": "Commit package-lock.json at the repository root on the default branch, or choose dependencyProvisioning NONE." }
  ```

  When `dependencyProvisioning` is `NONE`, a regular root
  `package-lock.json` in the exact fetched default branch commit contradicts
  that declaration. This returns `400 Bad Request` with exactly:

  ```json
  { "error": "Repository dependency provisioning contradicts lockfile", "code": "repository-dependency-provisioning-contradicts-lockfile", "remedy": "Choose dependencyProvisioning NPM_CI for repositories with a root package-lock.json." }
  ```

  These two dependency-policy refusals apply to both this route and
  `PATCH /repos/:repoId`; other failures use the existing error path. Preflight
  is never skipped as a success fallback.
- With `grantAgents: false` or when omitted, a successful request returns
  `201 Created` with the created Repo row itself (the existing response
  shape), and creates no grants. With `grantAgents: true`, the same transaction
  creates one `GIT_WRITE` `AgentRepoAccess` for every active Project Agent
  (`archivedAt: null`) except `INTEGRATOR_AGENT_NAME`; each grant uses the
  created Repo's `mountPath`. The response is `201 Created` with exactly
  `{ "repo": <created Repo row>, "grants": <created access rows> }`. Any
  Repo or grant write failure rolls back the Repo and all grants.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/repos" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"demo","remoteUrl":"https://github.com/acme/demo.git","dependencyProvisioning":"NPM_CI"}'
```

### PATCH `/repos/:repoId`

- Required path parameter: `repoId`.
- Required JSON: at least one of `name`, `remoteUrl`, `mountPath`,
  `defaultBranch`, `credentialSecretId`, or `dependencyProvisioning`.
- `dependencyProvisioning` is optional and patchable. When supplied, it must
  be exactly `NONE` or `NPM_CI`; omission preserves the stored value. An
  unknown value returns `400 Bad Request` with exactly:

  ```json
  { "error": "Repository dependency provisioning is invalid", "code": "repository-dependency-provisioning-invalid" }
  ```

- When `dependencyProvisioning` is supplied, the route runs repository
  preflight before writing the Repo row. It uses the stored `remoteUrl` and
  `defaultBranch`, except that either value supplied in the same patch is used
  for preflight. A preflight refusal leaves the Repo unchanged. For
  a missing Repo, the route returns `404 Not Found` with exactly:

  ```json
  { "error": "Resource not found" }
  ```

  A patched `remoteUrl` is checked without first trimming the submitted value.
  An invalid remote returns `400 Bad Request` with exactly:

  ```json
  { "error": "Repository remote is invalid", "code": "repository-remote-invalid", "reason": "<parseRepoRemote rejection reason>" }
  ```

  An invalid patched or stored default branch returns `400 Bad Request` with
  exactly:

  ```json
  { "error": "Repository default branch is invalid", "code": "repository-default-branch-invalid" }
  ```

  Other preflight failures return `422 Unprocessable Entity` with exactly:

  ```json
  { "error": "Repository preflight failed", "code": "repository-preflight-failed", "reason": "<existing failure reason>" }
  ```

  The possible reasons are `git-unavailable`, `git-identity-missing`,
  `remote-unreachable`, `default-branch-missing`, `push-not-authorized`, and
  `command-timeout`. For
  `NPM_CI`, a missing or non-regular root `package-lock.json` in the exact
  fetched default branch commit returns `422 Unprocessable Entity` with
  exactly:

  ```json
  { "error": "Repository preflight failed", "code": "repository-package-lock-missing", "remedy": "Commit package-lock.json at the repository root on the default branch, or choose dependencyProvisioning NONE." }
  ```

  For `NONE`, a regular root `package-lock.json` in that commit contradicts
  the declaration and returns `400 Bad Request` with exactly:

  ```json
  { "error": "Repository dependency provisioning contradicts lockfile", "code": "repository-dependency-provisioning-contradicts-lockfile", "remedy": "Choose dependencyProvisioning NPM_CI for repositories with a root package-lock.json." }
  ```

```sh
curl -X PATCH "$BASE_URL/repos/$REPO_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"defaultBranch":"main"}'
```

### DELETE `/repos/:repoId`

- Required path parameter: `repoId`.
- Returns `204 No Content` when no Task, Run, or webhook-bound TaskTemplate
  references the Repo.
- The delete never cascades through history. When references remain, the route
  returns `409 Conflict` with this body shape; each count is the number of
  referencing rows for that kind, including zero:

  ```json
  {
    "error": "<message>",
    "code": "repo_referenced",
    "references": {
      "tasks": 1,
      "runs": 0,
      "templates": 0
    }
  }
  ```

  A refusal leaves the Repo and all of its history unchanged. If no Repo has
  that id, the route returns `404 Not Found` with exactly:

  ```json
  { "error": "Repo not found" }
  ```

```sh
curl -X DELETE "$BASE_URL/repos/$REPO_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/agents/:agentId/repos/:repoId/access`

- Required path parameters: `agentId`, `repoId`.
- Optional JSON fields: `permissions` (`GIT_READ` or `GIT_WRITE`, default
  `GIT_WRITE`), `mountPath` (default `repo`).

```sh
curl -X POST "$BASE_URL/agents/$AGENT_ID/repos/$REPO_ID/access" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"permissions":"GIT_WRITE","mountPath":"repo"}'
```

### DELETE `/agents/:agentId/repos/:repoId/access`

- Required path parameters: `agentId`, `repoId`.

```sh
curl -X DELETE "$BASE_URL/agents/$AGENT_ID/repos/$REPO_ID/access" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## Goals

### GET `/projects/:projectId/goals`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/goals" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/goals`

- Required path parameter: `projectId`.
- Required JSON field: `title`.
- Optional JSON fields: `spec` (default `""`), `spendCap` (default `null`),
  `maxDurationMin` (default `240`), `stallTimeoutMin` (default `10`),
  `maxSessionsPerTask` (default `3`), `stuckThreshold` (default `19`),
  `runnerPreference` (`CLAUDE`, `CODEX`, `PI`, `AUTO`, or `INHERIT`, default
  `AUTO`), `sharedFolderPath` (default `null`), and `definitionOfDone` (array
  of `{text}` objects, default `[]`).

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/goals" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Ship the release","definitionOfDone":[{"text":"All acceptance tests pass"}]}'
```

### GET `/goals/:goalId`

- Required path parameter: `goalId`.

```sh
curl "$BASE_URL/goals/$GOAL_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PATCH `/goals/:goalId`

- Required path parameter: `goalId`.
- Required JSON: at least one of `title`, `spec`, `spendCap`, `maxDurationMin`,
  `stallTimeoutMin`, `maxSessionsPerTask`, `stuckThreshold`,
  `runnerPreference`, `sharedFolderPath`.

```sh
curl -X PATCH "$BASE_URL/goals/$GOAL_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"spendCap":25}'
```

### DELETE `/goals/:goalId`

- Required path parameter: `goalId`.

```sh
curl -X DELETE "$BASE_URL/goals/$GOAL_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/goals/:goalId/approve-dod`

- Required path parameter: `goalId`.

```sh
curl -X POST "$BASE_URL/goals/$GOAL_ID/approve-dod" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/goals/:goalId/pause`

- Required path parameter: `goalId`.

```sh
curl -X POST "$BASE_URL/goals/$GOAL_ID/pause" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/goals/:goalId/definition-of-done`

- Required path parameter: `goalId`.

```sh
curl "$BASE_URL/goals/$GOAL_ID/definition-of-done" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/goals/:goalId/definition-of-done`

- Required path parameter: `goalId`.
- Required JSON field: `text`.

```sh
curl -X POST "$BASE_URL/goals/$GOAL_ID/definition-of-done" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"The release is documented"}'
```

### PATCH `/goals/:goalId/definition-of-done/:itemId`

- Required path parameters: `goalId`, `itemId`.
- Required JSON: at least one of `text`, `done`.

```sh
curl -X PATCH "$BASE_URL/goals/$GOAL_ID/definition-of-done/$DOD_ITEM_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"done":true}'
```

### DELETE `/goals/:goalId/definition-of-done/:itemId`

- Required path parameters: `goalId`, `itemId`.

```sh
curl -X DELETE "$BASE_URL/goals/$GOAL_ID/definition-of-done/$DOD_ITEM_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/goals/:goalId/progress-log`

- Required path parameter: `goalId`.

```sh
curl "$BASE_URL/goals/$GOAL_ID/progress-log" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/goals/:goalId/progress-log`

- Required path parameter: `goalId`.
- Required JSON field: `body`.
- Optional JSON fields: `sessionId` (nullable) and `metadata` (record).

```sh
curl -X POST "$BASE_URL/goals/$GOAL_ID/progress-log" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"The implementation is ready for review"}'
```

## Task templates

Templates can be cloned under a new project-local name, read, patched for
webhook configuration, or instantiated. Cloning copies the description,
variables, and complete Step graph, but clears webhook configuration; Tasks
and trigger fires are never copied.

### Canonical `pr-engineer-workflow` pull-request handover

The current canonical `pr-engineer-workflow` is a four-step, GitHub pull-request
workflow. Its handover rules are exact-name scoped: custom and retired
templates, and direct or compound workflows, retain their own delivery
behavior.

The implementation Run leaves `.chain/<branchName>/spec.md` in the reviewed
implementation commit. Both review Runs read that pinned specification before
the final step. `Apply review fixes` uses the two review reports, adopts any
requested fixes, removes the complete tracked `.chain/` directory, and commits
the removal together with those fixes on top of the reviewed history. It then
persists `fixed-implementation`; delivery refuses to publish while any tracked
`.chain/` entry remains. The implementation commit remains immutable and
reviewable, while the cleanup commit is the human-mergeable head. A retry after
a successful push and failed pull-request edit may begin at that already-clean
commit and must preserve it without creating another cleanup commit. The final
Task output, completion head, pushed head, and pull-request head identify that
same cleanup commit; delivery uses the ordinary non-force branch push.

The pull-request body is one deterministic Markdown document with exactly these
five sections, in order; no provider-generated or activity-log prose is added:

- `Goal` is exactly the first line of the Task description.
- `Summary` uses the implementation output's `summary`; after review it also
  lists every adopted `closedFindings.codeEvidence` fix, or says that no
  review-driven code change was required when the adopted set is empty.
- `Verification` renders the implementation and fixed-step `testsRun` entries
  verbatim. Each entry includes the exact command and its observed exit/result
  summary. An empty reported list says `No commands reported in the task
  output.`; a section not reached yet says exactly `Not available at this step.`.
  Delivery never invents `PASS`.
- `Review outcomes` initially says `Not available at this step.`. The final
  body reports every code review and blind code review finding with its
  existing id, severity, and title, then its final disposition and reason,
  closed evidence when present, and the fixed output's `residualRisks`.
- `Anneal` contains the current Task id and non-null Chain id.

Step 1 uses this body when it creates a pull request, and edits an already-open
pull request on the shared head to the same initial body. After the final
cleanup push, delivery looks up the open pull request, edits it with the
complete post-review body, and reads the body back exactly. A missing or
malformed canonical output, absent Chain id or final pull request, failed edit,
unreadable read-back, body mismatch, failed cleanup, or retained tracked
`.chain/` content is a delivery failure.

### `merge-authorization` output

The `merge-authorization` step records its authorization object in the task
activity metadata. Its existing fields retain their current meanings. An
ordinary single-candidate authorization omits `train` and keeps the existing
shape and behavior. A train authorization may include this optional object:

```json
{
  "train": {
    "publishHead": "<40-hex prefix SHA>",
    "predecessorOid": "<40-hex predecessor SHA>",
    "ref": "refs/anneal/train/<publishHead>",
    "position": 1,
    "trainTaskId": "<train task id>"
  }
}
```

`publishHead` and `predecessorOid` are 40-hex commit SHAs, `ref` must be
exactly `refs/anneal/train/<publishHead>`, and `position` is a positive,
1-based integer. `trainTaskId` identifies the control-plane train task. The
control plane supplies this object; it is consumed by the merge executor when
it publishes and replays a cumulative prefix.

When `MERGE_TRAIN_WIDTH` is enabled, `publishHead` is the final contiguous
passing prefix OID at `contiguousPassCount` for every authorized candidate,
and `predecessorOid` is that candidate's own prefix predecessor. Only the
longest contiguous passing prefix is authorized. The per-candidate Approval
gate still applies before each output is written; the executor publishes the
authorized prefix after readiness releases the Lease.

### GET `/projects/:projectId/task-templates`

- Required path parameter: `projectId`.
- Rows are ordered by `createdAt` ascending.
- Every row carries `retired`: true when the row is a retired canonical
  generation, which canonical sync renamed to
  `<name>-legacy-<marker>-<id>` so the chains instantiated under it keep their
  history. A current canonical template and an operator's own clone are both
  false. The field is derived from the row's name at read time and never
  stored.
- Every step carries `executionOwner`, one of `agent`, `human`,
  `control-plane`, or `merge-executor`, computed by the API from the step
  itself. It is the same rule chain rows answer with, and it is the only field
  that says who runs a step: a `control-plane` step (the merge-readiness step)
  and a `merge-executor` step both bind an Agent so their task rows have an
  assignee, and neither is executed by that Agent. Staffing surfaces read this
  field rather than matching output kinds or step names.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/task-templates" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/task-templates/:templateId/clone`

- Required path parameters: `projectId`, `templateId`.
- Required JSON field: `name` (trimmed, non-empty, and at most 200 characters).
- Optional JSON field: `description` (at most 50,000 characters); when omitted,
  the source description is copied.
- Returns `201 Created` with the cloned template and its ordered Steps.
- Refusals: `404 Not Found` with code `template_not_in_project` when the source
  is not in the addressed project; `409 Conflict` with code
  `template_name_taken` when the name is already used in the project; and
  `409 Conflict` with code `template_name_reserved` when the name is a current
  or registered-legacy canonical identity.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/task-templates/$TEMPLATE_ID/clone" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"custom-review-workflow","description":"A project-specific workflow"}'
```

### PUT `/projects/:projectId/task-templates/:templateId/steps`

- Required path parameters: `projectId`, `templateId`.
- Required JSON field: `steps`, an array of at most 64 Steps. Each Step
  requires `name`, `assigneeType`, `assigneeAgentId`, `prompt`,
  `approvalGate`, `optional`, `attachmentsFromPrevious`, `priorOutputKinds`,
  `spawnPolicy`, `runner`, `outputKind`, `opensPullRequest`,
  `requiresCommit`, `baseFromStepIndex`, and `layer`; `stepIndex` is
  assigned densely from array order. `baseFromStepIndex` is a 1-based
  position in the submitted array and may be `null`.
- The request and every nested Step are strict: unknown fields, including a
  caller-supplied `stepIndex`, are rejected with `400 Bad Request`.
- Returns `200 OK` with `{ template, warnings }`. `template` is the
  resulting template read projection and `warnings` is the complete warning
  array for that graph. Warnings are not persisted.
- Refusals: `404 Not Found` with `template_not_in_project` when the
  addressed template is absent from the project; `409 Conflict` with
  `template_canonical` for current or registered-legacy canonical identity,
  or `template_in_use` when any Task references the template or one of its
  Steps. The `template_in_use` recovery is to clone again.
- An empty array answers `422 Unprocessable Entity` with
  `graph_empty`. Other graph validator refusals use `422` with their stable
  code and optional `stepIndex`: `first_step_not_agent`,
  `first_layer_not_single`, `layer_order_invalid`, and `base_step_invalid` are
  the ordering and base-reference checks. Output wiring also refuses
  `prior_kind_unproduced`, `output_kind_duplicate`, and `prior_kind_duplicate`.
  Optional-step validation refuses `first_step_optional`,
  `base_step_optional`, `gate_slot_step_optional`, and
  `optional_step_precedes_merge_tail`, each identifying the offending
  `stepIndex`.
  Gate and assignee checks refuse `approval_gate_in_parallel_layer`,
  `assignee_invalid`, and `integrator_binding_invalid`. Agent assignments must
  name an existing, non-archived Agent in the addressed project. Repo grants
  are not checked while authoring; the instantiation route checks the grant
  against its selected Repo. Warning codes are
  `no_review_step`, `same_agent_implements_and_reviews`,
  `pull_request_without_regression`, `staffing_profile_entry_dropped`, and
  `staffing_profile_assignee_dropped`; warnings are non-blocking, describe the
  complete resulting graph, and are ephemeral (they are not persisted or
  returned by template reads).
- This template's staffing profiles are remapped onto the replacement graph in
  the same transaction. An entry survives by exact `outputKind`; one whose kind
  the new graph does not produce is dropped
  (`staffing_profile_entry_dropped`). A surviving entry is then revalidated
  against the new step, and an Agent the new graph no longer allows there — the
  step became `HUMAN`, or the binding would violate the merge-execution or
  compound-implementation rule — is cleared
  (`staffing_profile_assignee_dropped`). Both are reported rather than refused,
  so a replacement never leaves a saved profile no chain can instantiate.

```sh
curl -X PUT "$BASE_URL/projects/$PROJECT_ID/task-templates/$TEMPLATE_ID/steps" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"steps":[{"name":"Implement","assigneeType":"AGENT","assigneeAgentId":"'$AGENT_ID'","prompt":"Implement the change","approvalGate":false,"optional":false,"attachmentsFromPrevious":false,"priorOutputKinds":[],"spawnPolicy":null,"runner":"CODEX","outputKind":"implementation","opensPullRequest":true,"requiresCommit":true,"baseFromStepIndex":null,"layer":1}]}'
```

### GET `/task-templates/:templateId`

- Required path parameter: `templateId`.
- Carries the same derived `retired` field and the same per-step
  `executionOwner` field as `GET /projects/:projectId/task-templates`.

```sh
curl "$BASE_URL/task-templates/$TEMPLATE_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PATCH `/task-templates/:templateId`

- Required path parameter: `templateId`.
- Required JSON: at least one of `webhookSecretId`, `webhookRepoId`,
  `webhookPayloadMapping`, `webhookReplayWindowSec`.
- `webhookPayloadMapping` is either `null` or `{map?, defaults?}`;
  `webhookReplayWindowSec` is `0`–`86400` or `null`.

```sh
curl -X PATCH "$BASE_URL/task-templates/$TEMPLATE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"webhookReplayWindowSec":300}'
```

### POST `/projects/:projectId/task-templates/:templateId/instantiate`

- Required path parameters: `projectId`, `templateId`.
- Required JSON fields: `repoId`, `variables` (string-to-string record; values
  must not be blank), and `name` (the chain's title; constraints and refusal
  codes below).
- Optional JSON fields: `autoStart` (default `false`), `afterTaskId`,
  `description`, `stepOverrides` (map of positive step indexes to a strict
  object carrying `assigneeAgentId`, `include`, or both — at least one),
  `staffingProfileId`, and `gates` (a strict object with optional boolean
  fields `spec` and `merge`). `afterTaskId` cannot be combined with
  `autoStart:true`.
- A missing, blank, or whitespace-only `name` returns `400 Bad Request` with
  code `instantiate_name_required`. A name longer than 120 characters after
  trimming or containing a line break returns `400 Bad Request` with code
  `instantiate_name_invalid`. Both refusals happen before task creation; the
  API does not derive a name from the description or template.
- For the specification slot and merge readiness slot, the created task's
  `approvalGate` resolves in exactly this order: the corresponding dispatch
  override (`gates.spec` or `gates.merge`), then the project's corresponding
  default (`specGateDefault` or `mergeGateDefault`), then the template step's
  frontmatter `approvalGate`. An explicitly supplied `false` is an override.
  Every other step keeps its template frontmatter value. The resolved values
  are persisted on the created tasks; later project-default changes do not
  change an existing Chain.
- Each step's assignee resolves in exactly this order: the `stepOverrides`
  entry for that step index, then the selected staffing profile's entry for the
  step's exact `outputKind`, then the template step's own `assigneeAgentId`.
  Whether a step the template marks `optional` is instantiated resolves in the
  same order: the override's `include`, then the profile entry's `include`,
  then inclusion. An `include` naming a step the template does not mark
  optional returns `400 Bad Request` with code
  `step_override_include_not_optional`.
- The staffing profile is selected by `staffingProfileId`, by a
  `Staffing: <profile name>` line in `description`, or, when neither is given,
  by the template's default profile. A template with no profiles is staffed
  entirely from its canonical bindings. An id that is not a profile of this
  template and a name no profile of this template has both return
  `400 Bad Request` with code `staffing_profile_not_found`; a `Staffing`-shaped
  line that does not match the grammar returns
  `staffing_profile_line_malformed`; an id and a line selecting different
  profiles returns `staffing_profile_conflicts_with_selection`. A profile whose
  agent is archived, belongs to another project, is missing, binds a non-agent
  step, violates the integrator or compound-implementation binding, or lacks a
  grant for the addressed Repo is refused under its own code
  (`staffing_profile_agent_archived`, `staffing_profile_agent_foreign`,
  `staffing_profile_agent_not_found`, `staffing_profile_step_not_agent`,
  `staffing_profile_integrator_binding`,
  `staffing_profile_compound_implementation`,
  `staffing_profile_missing_repo_grant`), never under the template's.
- An omitted optional step is resolved once, at instantiation: the chain has no
  task for it and no later change to any profile alters an existing Chain. The
  chain root's first TaskActivity metadata records `staffingProfileId` and
  `staffingProfileName` when a profile was used. Retained steps keep their
  template `stepIndex`, so the resulting Chain's `chainIndex` values may be
  sparse. If no instantiable step remains, the request is refused with
  `400 Bad Request` and code `template_has_no_instantiable_steps`.
- A supplied `gates.spec` for a template without a specification step returns
  `400 Bad Request` with code `gates_spec_step_absent`; a supplied `gates.merge`
  for a template without a merge readiness step returns `400 Bad Request` with
  code `gates_merge_step_absent`. Each error message names the missing slot and
  template. If both supplied keys address missing slots, the specification
  refusal is reported first. No task is created for either refusal. Unknown
  fields inside `gates` are rejected by the strict request schema.
- Implementation route grammar, escalation, and `stepOverrides` interaction
  are owned by [Implementation assignee routing](governance/task-routing-v1.md#implementation-assignee-routing).
  Route-related refusal codes are `implementation_route_malformed`,
  `implementation_route_template_unsupported`,
  `implementation_route_conflicts_with_step_override`, and
  `implementation_route_agent_renamed`; `step_override_agent_not_found` is
  returned when the routed Agent name cannot be resolved in the project.
  The routed implementation Agent requires a `GIT_WRITE` grant on the Chain
  Repo, using the same check as judged-tier staffing; a missing or read-only
  grant returns `step_override_missing_repo_grant`.
- One predecessor task accepts several bound successor chains: binding a
  second chain to a predecessor that already has one is accepted, and the
  predecessor records one `Chain <id> bound to predecessor <name>` activity per
  binding. The binding stays one-way and one hop deep. An `afterTaskId` binding
  is released by `DELETE /tasks/:taskId/chain` on that bound chain, which
  leaves the predecessor's other successors bound, or — while that chain has no
  Run — by `PATCH /tasks/:taskId` with `dispatchAfterTaskId` on its first step,
  which re-points the binding at another task or releases it with `null`.
  Archiving releases no binding by itself: neither archiving a bound chain nor
  archiving the predecessor it waits for, and an archived predecessor never
  becomes `DONE`, so re-pointing or releasing the binding is how such a chain
  is recovered.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/task-templates/$TEMPLATE_ID/instantiate" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"repoId":"'$REPO_ID'","variables":{"branchName":"feature/demo"},"name":"Demo delivery","gates":{"spec":true,"merge":false},"autoStart":true}'
```

## Staffing profiles

A staffing profile is a named plan for one TaskTemplate: who runs each step,
and which of that template's optional steps a chain instantiated from it keeps.
Profiles hang off the template, not the project, so one project may keep
several plans for the same graph. Exactly one profile of a template is its
default; a template may also have none, in which case instantiation uses the
step rows' own bindings.

Entries key on the step's exact `outputKind`. `foo` and `foo-v2` are different
steps of a custom graph and therefore different entries; nothing is normalised
on this surface. `assigneeAgentId` null means the profile has no opinion and
the canonical binding stands.

A profile also carries a `tiers` object with exactly four independent,
nullable Agent slots: `{ "default": <agentId|null>, "frontend":
<agentId|null>, "hard": <agentId|null>, "hazard": <agentId|null> }`. These
keys are tier names, not `outputKind` values: an entry whose output kind is
`default`, `frontend`, `hard`, or `hazard` remains a step entry and is never
read as a tier slot. The revalidation step judges a direct chain's tier, and a
Route line or explicit implementation `stepOverrides` assignee overrides that
judgement. When there is no override and the implementation has no Run, the
selected profile's slot supplies its Agent; an empty slot leaves the current
Agent in place. The resolved Agent must hold the chain Repo's `GIT_WRITE`
grant, and no tier falls through to another slot.

A profile also carries the nullable `mergeTailRepairAgentId` Agent slot. This
profile-level slot staffs detached `review-fix` and `gate-fix` merge-tail repair
cards independently of the `fixed-implementation` step entry. `null` leaves
the slot empty, and the field is included in profile reads. `refresh-conflict`
continues to use `MERGE_RESOLVER_ROLE`.

`include` is the profile's decision about an optional step, and a stored
profile always carries a boolean for every step the template marks `optional`
and `null` for every other step. A write may omit the flag, or the entry
altogether: an optional step nobody stated an opinion about is stored as
`include: true`, the same step the chain would run. Stating `include` on a step
the template does not mark optional is refused. Create, replace, reset, a step
graph replacement and a canonical rollover all leave the profile in this form,
so a step that becomes optional gains the default opinion and one that stops
being optional loses its flag.

Every write takes the template row mutex and then the Agent-row mutex that
archive and chain instantiation take, so a profile cannot be saved against an
Agent that is being archived in a concurrent transaction. Step entries remain
a plan and their Repository grants are checked when a chain is actually
created. A non-null `mergeTailRepairAgentId` slot is checked when it is explicitly
set: it must name an unarchived `AGENT` in the profile's project and hold a
grant for the resolved Repo. Repo resolution uses an explicit `repoId` in that
request, then the template's webhook Repo, then the project's sole Repo. A
foreign Repo or a Repo that is not in the project returns
`staffing_profile_repo_not_found`; no Repo or multiple project Repos without an
explicit `repoId` returns `staffing_profile_repo_required`; a missing Agent
grant returns `staffing_profile_missing_repo_grant`. A foreign, archived,
non-Agent, or ungranted slot is refused rather than silently substituted;
the mechanical merge-integrator is refused with `staffing_profile_integrator_binding`;
`null` clears it.

Validation refusals for step entries, in the order they are applied per entry:
`staffing_profile_entry_duplicate` (the same output kind twice in one request),
`staffing_profile_unknown_output_kind` (the template has no step producing it),
`staffing_profile_include_not_optional` (an include flag on a step the template
does not mark optional), `staffing_profile_step_not_agent` (staffing a `HUMAN`
step), `staffing_profile_step_control_plane` (staffing a step whose
`executionOwner` is `control-plane`, which the control plane runs and no Agent
executes; the message names the step to remove, and an entry with
`assigneeAgentId: null` for it stays allowed),
`staffing_profile_agent_not_found` (no such Agent in this project),
`staffing_profile_agent_archived`, `staffing_profile_repo_not_found`,
`staffing_profile_repo_required`, and `staffing_profile_missing_repo_grant`
(the merge-tail slot's Repo context and grant checks),
`staffing_profile_integrator_binding` (the merge-execution step binds only
`merge-integrator`, and `merge-integrator` binds nothing else), and
`staffing_profile_compound_implementation` (the compound implementation root
requires an assignee whose effective runner is Codex and whose model is a
`gpt-*` one). `staffing_profile_step_control_plane` returns `400 Bad Request`
with the same `{ error, code, outputKind }` body shape as
`staffing_profile_step_not_agent`. All other listed validation refusals return
`422 Unprocessable Content`.

A profile saved before `staffing_profile_step_control_plane` existed is not
migrated: it keeps its stored entry until the next write, which is refused with
that code naming the step to remove. Reset writes the canonical plan, which
states no assignee for a control-plane step.

Warnings do not block a write. `same_agent_implements_and_reviews` reports that
one Agent both implements and reviews under the saved plan.

### GET `/projects/:projectId/task-templates/:templateId/staffing-profiles`

- Required path parameters: `projectId`, `templateId`.
- Returns `200 OK` with the template's profiles, the default first and the rest
  by name, each with its ordered `entries`, its `tiers` object, and nullable
  `mergeTailRepairAgentId`. `tiers` always has the four keys `default`,
  `frontend`, `hard`, and `hazard`; each value is an Agent id or `null`.
- Refusal: `404 Not Found` with code `staffing_profile_template_not_found` when
  the template is not in the addressed project.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/task-templates/$TEMPLATE_ID/staffing-profiles" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/task-templates/:templateId/staffing-profiles`

- Required path parameters: `projectId`, `templateId`.
- Required JSON fields: `name` (trimmed, non-empty, at most 200 characters;
  the same bound the `Staffing:` brief line accepts) and `entries` (at most 64,
  each `{ "outputKind", "assigneeAgentId"?, "include"? }`). The saved entry list
  is the submitted one plus an `include: true` entry for every optional step it
  did not name.
- Optional JSON fields: `isDefault`, `tiers`, `mergeTailRepairAgentId`
  (nullable), and `repoId`. `tiers`, when supplied, is an object whose keys
  are any subset of `default`, `frontend`, `hard`, and `hazard`, with each value
  an Agent id or `null`; omitted tier keys are initially empty. Unknown tier
  keys are refused. Each non-null tier Agent must be an unarchived Agent in the
  profile's project. The first profile of a template is always its default
  regardless of `isDefault`; setting it on a later profile clears the previous
  default in the same transaction. A non-null merge-tail slot is validated
  against the Repo selected by `repoId`, the template webhook Repo, or the
  project's sole Repo, in that order.
- Returns `201 Created` with `{ "profile": <profile>, "warnings": [...] }`.
- Refusals: `404 Not Found` with code `staffing_profile_template_not_found`;
  `409 Conflict` with code `staffing_profile_name_taken` when the template
  already has a profile with that name; and the `400` and `422` validation codes above.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/task-templates/$TEMPLATE_ID/staffing-profiles" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Fast lane","entries":[{"outputKind":"implementation","assigneeAgentId":"'$AGENT_ID'"},{"outputKind":"blind-findings","include":false}],"tiers":{"default":"'$AGENT_ID'","frontend":null,"hard":null,"hazard":"'$HAZARD_AGENT_ID'"},"mergeTailRepairAgentId":"'$REPAIR_AGENT_ID'","repoId":"'$REPO_ID'"}'
```

### PUT `/staffing-profiles/:profileId`

- Required path parameter: `profileId`.
- Required JSON fields: `name` and `entries`. The entry list replaces the
  stored one whole; an omitted output kind loses its opinion rather than
  keeping the previous one, except that every optional step of the template is
  still stored with a boolean `include`, defaulting to `true`.
- Optional JSON field `tiers` updates the named tier slots when supplied. Its
  keys are any subset of `default`, `frontend`, `hard`, and `hazard`, each with
  an Agent id or `null`; unknown keys are refused. Omitting `tiers` preserves
  every stored tier slot, and omitting a key inside `tiers` preserves that slot.
- Other optional JSON fields: `mergeTailRepairAgentId`, a nullable Agent id for the
  detached `review-fix` and `gate-fix` repair cards, and `repoId`, the optional
  Repo context used to validate a non-null slot. Omitting
  `mergeTailRepairAgentId` preserves the stored slot, even if its Agent has since
  been archived, and does not require a new
  `repoId`; sending `null` clears the slot. When a non-null slot is sent, Repo
  selection is `repoId`, then the template webhook Repo, then the project's
  sole Repo.
- Default membership is not part of this body; `PATCH` owns that transition.
- Returns `200 OK` with `{ "profile": <profile>, "warnings": [...] }`.
- Refusals: `404 Not Found` with code `staffing_profile_not_found`;
  `409 Conflict` with code `staffing_profile_name_taken`; and the `400` and `422`
  validation codes above.

```sh
curl -X PUT "$BASE_URL/staffing-profiles/$PROFILE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Fast lane","entries":[{"outputKind":"implementation","assigneeAgentId":"'$AGENT_ID'"}],"tiers":{"default":"'$AGENT_ID'","frontend":null,"hard":null,"hazard":"'$HAZARD_AGENT_ID'"},"mergeTailRepairAgentId":"'$REPAIR_AGENT_ID'","repoId":"'$REPO_ID'"}'
```

### PATCH `/staffing-profiles/:profileId`

- Required path parameter: `profileId`.
- Required JSON field: `isDefault`, which must be exactly `true`. Clearing the
  default is not expressible: a template with profiles and no default has no
  answer for instantiation.
- Promotes this profile and demotes the previous default atomically.
- Returns `200 OK` with the promoted profile.
- Refusal: `404 Not Found` with code `staffing_profile_not_found`.

```sh
curl -X PATCH "$BASE_URL/staffing-profiles/$PROFILE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"isDefault":true}'
```

### DELETE `/staffing-profiles/:profileId`

- Required path parameter: `profileId`.
- Returns `204 No Content`. Deleting a template's last profile is allowed;
  instantiation then falls back to the template's own step bindings.
- Refusals: `404 Not Found` with code `staffing_profile_not_found`; and
  `409 Conflict` with code `staffing_profile_default_delete_refused` when the
  addressed profile is the default and the template has other profiles.

```sh
curl -X DELETE "$BASE_URL/staffing-profiles/$PROFILE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/staffing-profiles/:profileId/reset`

- Required path parameter: `profileId`.
- Optional JSON body: `repoId`, used as the Repo context when the canonical
  merge-tail repair slot is non-null. An empty body remains valid for the
  historical reset behavior; without `repoId`, the template webhook Repo or
  the project's sole Repo is selected. If neither resolves a Repo, reset succeeds
  with `merge_tail_repair_repo_unresolved` in `warnings` and skips the canonical
  slot's grant check. An explicit foreign Repo or missing grant still refuses.
- Replaces the profile's entries with the template's canonical plan: every
  step's own `assigneeAgentId`, and every optional step included. It also
  restores the canonical `tiers` object and canonical
  `mergeTailRepairAgentId`; the active direct, PR, and compound canonical
  profiles set `tiers.default` to `senior-dev-luna-max`,
  `tiers.frontend` to `frontend-dev-opus-medium`, `tiers.hard` to
  `senior-dev-sol-high`, and `tiers.hazard` to `senior-dev-astra-medium`, and
  set the repair slot to `senior-dev-luna-max`.
- If the canonical repair Agent is missing or archived, reset restores the step
  entries, clears the repair slot, and returns a `merge_tail_repair_agent_unavailable`
  warning. Profile entry overrides pointing to that unavailable canonical Agent
  are also cleared to null; template step bindings remain unchanged. Explicit
  create/PUT assignments still refuse unavailable Agents.
- Returns `200 OK` with `{ "profile": <profile>, "warnings": [...] }`.
- Refusal: `404 Not Found` with code `staffing_profile_not_found`.

```sh
curl -X POST "$BASE_URL/staffing-profiles/$PROFILE_ID/reset" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

## Triggers and automations

Triggers are webhook-configured task templates. The operator routes inspect,
pause, enable, and manually fire them.

### GET `/projects/:projectId/triggers`

- Required path parameter: `projectId`.

```sh
curl "$BASE_URL/projects/$PROJECT_ID/triggers" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/triggers/:templateId`

- Required path parameter: `templateId`.

```sh
curl "$BASE_URL/triggers/$TEMPLATE_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/triggers/:templateId/fires`

- Required path parameter: `templateId`.
- Optional query: `take` (clamped to `1`–`100`, default `20`).

```sh
curl "$BASE_URL/triggers/$TEMPLATE_ID/fires?take=20" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/triggers/:templateId/pause`

- Required path parameter: `templateId`.

```sh
curl -X POST "$BASE_URL/triggers/$TEMPLATE_ID/pause" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/triggers/:templateId/enable`

- Required path parameter: `templateId`.

```sh
curl -X POST "$BASE_URL/triggers/$TEMPLATE_ID/enable" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/task-templates/:templateId/fire`

- Required path parameter: `templateId`.
- Optional JSON body: `variables` (string-to-string record). An empty body is
  accepted; configured defaults resolve omitted variables.
- Each fire gives the instantiated chain an explicit name made from the
  trigger's template name and fire identifier, so fired chains remain
  distinguishable from one another and never use the bare template name.

```sh
curl -X POST "$BASE_URL/task-templates/$TEMPLATE_ID/fire" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"variables":{"branchName":"feature/manual-fire"}}'
```

### POST `/hooks/templates/:templateId` — Webhook

- Required path parameter: `templateId`.
- Required header: `X-Anneal-Webhook-Secret`.
- Required body: a JSON object. `X-Anneal-Delivery-Id` is optional and is used
  for replay deduplication when the trigger has a replay window.
- This public delivery route does not use the operator bearer token.

```sh
curl -X POST "$BASE_URL/hooks/templates/$TEMPLATE_ID" \
  -H "X-Anneal-Webhook-Secret: $WEBHOOK_SECRET" -H "Content-Type: application/json" \
  -d '{"branchName":"feature/webhook"}'
```

## Tasks

Task creation defaults to an agent task scheduled `NOW`; an agent task must
also have a project-local `assigneeAgentId` and `repoId`, and the assignee must
have access to that repository. `scheduleKind` is `NOW`, `AT`, or `CRON`:
`AT` requires `runAt` and an agent/repository; `CRON` requires `cron` (five
fields, no macros) and computes the next `runAt`; `timezone` is an optional IANA
timezone. The task body also supports `status` (`TODO` or `BACKLOG` at
creation), `approvalGate`, `opensPullRequest`,
`maxDurationMin`, `stallTimeoutMin`, `maxSessionsPerTask`, `workingDirectory`,
`targetBranch`, and paired `chainId`/`chainIndex` fields.

### Merge-train readiness

The worker first reserves a detached train in `REVIEW` with a `mergeTail.train`
marker in `acquiring` state and no Run. This has no Approval gate. It enqueues
the sole Run and changes the markers to `queued` only under the Merge Lease.
Reservations and queued trains drain even after the width is changed to zero.
A terminal train settlement records one deferred-release obligation in the same
transaction as its terminal marker. A confirmed release settles that obligation;
restart reconciliation consumes it if the process exits before release, without
replaying authorization or releasing a newer lease generation.

When `MERGE_TRAIN_WIDTH` is greater than zero, Merge readiness collects ready
Chain candidates per Repo. A candidate must have a valid exact-head
`regression-verification-v2` PASS bound to its `(headSha, baseHeadSha)`, and
its recovery aggregate must not be `REPAIRING` or `BLOCKED_DOWNSTREAM`.
Candidates are ordered FIFO by the time their Regression evidence was
persisted. The control plane forms a train when at least one candidate's
evidence base differs from the live default-branch head or at least two
candidates are ready. A single candidate whose evidence is not drifted keeps
the ordinary single-candidate authorization path.

The control plane represents a train with one detached platform Task of kind
`merge-train`. This Task has `assigneeType: AGENT`,
`maxSessionsPerTask: 1`, and the Agent bound to the first candidate Chain's
Regression verification Step. Its description instructs the session only to
run `"${AGENTOS_TOOLS}/merge-train.sh"` and finish. The task claim metadata
contains the tool's input, including the live `baseSha`, configured `width`,
and ordered `candidates` with each candidate's `taskId`, `chainId`, `headSha`,
and `branch`:

```json
{
  "baseSha": "<live default-branch head>",
  "width": 2,
  "candidates": [
    { "taskId": "<readiness task>", "chainId": "<chain id>", "headSha": "<candidate head>", "branch": "<chain branch>" },
    { "taskId": "<readiness task>", "chainId": "<chain id>", "headSha": "<candidate head>", "branch": "<chain branch>" }
  ]
}
```

Each candidate readiness Task carries a `mergeTail.train` marker naming the
detached train Task and the candidate's one-based `position`. If the train is
aborted, the marker records `state: "aborted"` and the named `reason` for
every candidate. The train card lists the candidates and, after settlement,
the record's verdict for each position. The readiness Task activity log gets
one entry naming the train Task, position, and settlement.

The train obtains the repository Merge Lease under the first candidate's Chain
lease target before its Task is enqueued and keeps it through record
validation, the second-read checks, and authorization settlement. A failed
acquire defers the tick and is named: a contended or unreachable acquisition
writes a `mergeTail.leaseContention` marker on the train Task and one activity
entry per candidate. While a train holds the Lease, single-candidate readiness
for that Repo is deferred; an unresolved deferred release excludes the Repo
from forming a *new* train only, and its candidates continue on the
single-candidate path. A routine `HANDOFF_PENDING` event does not block new
train formation. The Lease is released after the last
authorization or on every failure path. Merge executor publication occurs
after the handoff and is outside this Lease. A train Run that is lost or ends
without a stored `merge-train-v1` record releases the Lease, marks the train
aborted, and returns its candidates to `ready`; the detached Task is not
retried.

Before authorizing, readiness parses `merge-train-v1`, requires its `baseSha`
to equal the live default-branch head and every `candidateHeadSha` to equal
the corresponding Chain's evidence head. It then repeats the existing
second-read discipline once per candidate with the train base, still under
the Lease. A stale base or mismatched candidate head authorizes nothing and
releases the Lease. Positions `1` through `contiguousPassCount` are authorized
in order with the `train` object described under `merge-authorization`. The
per-candidate Approval gate is refused per candidate: an unapproved candidate
stops on its own gate refusal, only the positions before it are authorized
against the truncated prefix, and the positions after it return to `ready`.
The operator authorization remains bound to the candidate's original Regression
evidence head and base and current gate request. The train separately verifies
the live publication base, so drift alone does not invalidate that approval.
Train authorization also checks the runner registry inside the settlement
transaction. When all configured merge executors are offline, no candidate is
authorized: every candidate returns to `ready` with the existing
`requeued-executor-offline` activity and its `mergeTail.train` settlement, and
the Lease is released. A later tick may form a new train. The same bounded
per-Step offline episode described below applies across these trains; reaching
the ceiling stops the candidate with `merge-executor-offline` and an inbox notice.
A settled train card closes as `DONE`; only an aborted train stays in `REVIEW`
with its named reason.

Train settlement does not start a per-Chain base-drift Regression re-run. The
first failing prefix enters the existing gate-fix repair path with the
candidate head and its predecessor prefix OID as `baseHeadSha`; the existing
shared Regression completion and repair-task handler preserves the repair
budget and task shape. A `no-verdict` prefix and every `skipped` candidate
return to `ready` unchanged; and a `blocked` candidate enters the existing
refresh-conflict recovery stop with the recorded reason. A `fail`, `blocked`,
or aborted train writes one existing Inbox stop notice for each affected
candidate. Initial Regression semantic verification remains part of the
candidate evidence, but it is deliberately not repeated after a base move
while train readiness is enabled; the cumulative Merge gate and readiness
second read provide the train's fresh checks.

### GET `/tasks`

- Required parameters: none.
- Optional query: `projectId`; `archived` (`false`, `true`, or `all`, default
  `false`); `view` (`full` or `board`, default `full`); `enrich` (`true` or
  `false`, default `true`).

The `board` view is a compact card projection. It includes `createdAt` for
stable queue ordering, `assigneeType` so a human-owned task can be
distinguished from an agent task whose agent assignment is missing, and
`budgetRemaining`, the same run-budget verdict `GET /tasks/:taskId` and
`GET /tasks/:taskId/startability` report. It also includes
`leaseLossRefunds`: how many attempts the platform has refunded this task
because it lost a Run — a lease declared LOST by reconciliation, a claim
invalidated by a late salvage publication, a merge-tail requeue — as opposed to
attempts its agent spent. It is bounded at three per task; at the bound the
platform stops requeueing and parks the task for an operator, so a card showing
`3` is one loss away from `REVIEW`. See "Lost-Run reconciliation" below.
It also includes `spendCapUsage`: `null` on a task with no
`spendCap`, and otherwise `{capUsd, spentUsd, exhausted}` — the cap, what the
task's Runs have already spent against it, and whether the cap now refuses a
new attempt. See "Task spend cap" below for what counts as spend.

Every card also carries `baseline`, the same per-template-step cost and
duration baseline `GET /tasks/:taskId` documents, or `null` for a card with no
template step or too little history.
Each card's `latestRun` reports where that Run is now, so a card can be read
without opening the task. `phase` is one of `queued`, `provisioning`,
`executing`, `waiting-inbox`, `cleanup`, or `finished`, computed from the same
boundaries `metrics.phases` measures between: `queued` from the Run's
`readyAt`, `provisioning` from the Session's `provisionedAt`, `executing` from
its `startedAt`, `cleanup` while `cleanupStartedAt` is set and
`cleanupEndedAt` is not, and `finished` once the Session ended or the Run
reached a terminal status. The current runner does not write
`cleanupStartedAt`, so `cleanup` is currently unreachable in normal execution;
the projection supports that milestone when recorded. `phaseSince` is the ISO instant the Run entered that
phase. For `waiting-inbox` it is the creation time of the exact question
referenced by `Session.waitingOnMessageId`, resolved in one batched lookup for
the page; a missing question leaves it `null`. Historical total Inbox wait
remains unknown because resume boundaries are not recorded. `lastProgressEventAt` is the last
progress the owning runner reported for the Run — the signal its stall timeout
is measured from — or `null` when none was reported. `maxRunsPerTask` is the
attempt ceiling snapshotted at Run birth, which is what a card's retry count is
read against rather than the task's configured budget of the moment. Baselines
for the whole page are answered by one grouped query, so the board's query count does not grow with the number of cards. Rows
of the `full` view carry the same `baseline` field on the same terms, read by
the same single grouped query.

For a Chain member, the first emitted member also carries the
`chainAggregate` projection. Its `firstRunStartedAt` is the earliest non-null
`Run.startedAt` across the complete primary-Step run history, including failed
attempts and archived primary Steps, or `null` before any primary Run starts.
The browser uses this origin for Chain lead time so a retry cannot shorten it;
the server computes it from existing full-chain reads without per-card requests.
Its `activation.state` is one of
`parked-unactivated`, `waiting-on-predecessor`, `running`, `idle`, `held`, or
`settled`; `held` is a derived aggregate state, not a persisted Task status.
The aggregate's `activation.hold` is either `null` or
`{heldLayer, heldAt, holdReason}`, where `heldLayer` is the dense one-based
ordinal of the highest execution layer admitted when the Chain was held (or
`0` before the first layer), `heldAt` is an ISO timestamp, and
`holdReason` is the optional operator reason. It is non-null whenever the
Chain's persisted `ChainControl.state` is `HELD`.

Every card carries `readinessRequeues` and `readinessGrants`. They are non-zero
only on a Chain's merge-readiness Step (`outputKind: merge-authorization`), and
report how many times readiness returned the candidate to Regression because
its base moved before authorization and how many extra Run attempts those
requeues granted. Both are derived from the Step's
`mergeReadiness.requeue` activities, described under `GET
/tasks/:taskId/activity`.

An active member keeps `activation.state` as `running` even when
`activation.hold` is non-null: the hold lets the current Run finish and starts
nothing after that layer. Once no member is active, a held Chain reports
`activation.state: "held"`; its `activation.taskId` is the first primary
member, which is the task to address with `chain/resume`. The aggregate's
derived `status` continues to determine its board column, so a held Chain whose
held layer has finished appears in Todo.

```sh
curl "$BASE_URL/tasks?projectId=$PROJECT_ID&view=full&archived=false" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/tasks`

- Required path parameter: `projectId`.
- Required JSON field: `name`.
- Optional JSON fields and defaults: `description` (`""`),
  `workingDirectory` (`null`), `repoId` (`null`), `targetBranch` (`null`),
  `assigneeType` (`AGENT`), `assigneeAgentId` (`null`), `approvalGate`
  (`false`), `opensPullRequest` (`true`), `maxDurationMin` (`240`),
  `stallTimeoutMin` (`10`), `maxSessionsPerTask` (`5`), `scheduleKind`
  (`NOW`), `runAt` (`null`), `cron` (`null`), `timezone` (`null`), and `status`
  (`TODO`). At creation, `status` may be `TODO` or `BACKLOG`; `DOING`,
  `REVIEW`, and `DONE` are rejected rather than normalized.
  `chainId` and `chainIndex` are optional but must be supplied together.
  For the default `AGENT` type, `repoId` and `assigneeAgentId` are required by
  the route's project/access checks.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/tasks" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Run checks","repoId":"'$REPO_ID'","assigneeAgentId":"'$AGENT_ID'","scheduleKind":"NOW"}'
```

### GET `/tasks/:taskId`

- Required path parameter: `taskId`.
- Each returned Run's `session.latestAgentMessage` is either `null` when the
  session has no non-empty qualifying text event, or `{body, at}` containing the
  newest qualifying event's plain-text body and timestamp. Only the Run holding
  the task's newest session is projected; every older Run reports `null`
  regardless of its own events. Which events qualify depends on the runner:
  `MODEL_DELTA` and `FINAL_OUTPUT` for `CLAUDE` and `CODEX`, `MODEL_COMPLETED`
  for `PI`. This is a derived read from the session event stream.
- Each returned Run includes the report-only `worktreeContainmentViolations`
  fact: absolute worktree paths from that Run's checkout found outside its run
  workspace, or `null` when no observation was reported.
- `budgetRemaining` is the same verdict `GET /tasks/:taskId/startability`
  reports in its checklist: whether the task's configured budget plus the
  grants its Runs carry still leaves an attempt. `POST /tasks/:taskId/retry`
  refuses with `409 Conflict` and `Run budget exhausted` when it is `false`;
  raise `maxSessionsPerTask` through `PATCH /tasks/:taskId` to lift it. It is a
  separate verdict from the board's `leaseLossRefunds`: a task can have budget
  left and still be out of platform refunds.
- `spendCap` is the task's own spend limit in USD, a `Decimal(12,2)` or
  `null`, and `taskCost` is the read-time cost of its Runs. Enforcement and the
  cost basis are described under "Task spend cap".

- `editableBrief` is the prompt text a caller may rewrite through `PATCH
  /tasks/:taskId` with `description`, already extracted: the brief alone for a
  Chain step that authors one, the whole stored description for an ordinary
  task, and `null` for a readiness or integrator step, whose prompt the
  platform owns, or for a description whose brief fence cannot be parsed.
- Each returned Run carries `metrics`: read-time diagnostics derived from the
  Run row, its Session row and that session's tool events. Nothing in it is
  persisted, and `null` always means *unknown* — never zero, and never safe to
  render as zero.
  - `metrics.phases` splits the run's wall clock in milliseconds:
    `queuedMs` (Run `readyAt` to Session `provisionedAt`), `provisioningMs`
    (`provisionedAt` to `startedAt`), `executingMs` (`startedAt` to `endedAt`,
    or to now while the run is still executing), `inboxWaitMs` and `cleanupMs`
    (`cleanupStartedAt` to `cleanupEndedAt`). Each is `null` when either
    bounding timestamp is missing. `inboxWaitMs` is `0` only when the session
    demonstrably never waited on the Inbox; when a wait is known to have
    happened — the session is `WAITING_INBOX`, or it resumed at least once —
    the stored data marks that it happened without bounding it, so the value is
    `null` rather than a guess.
  - `metrics.tokens` reports the canonical input split, where `input` already
    includes both cache subsets: `input`, `cachedRead`, `cacheWrite`,
    `uncachedInput`, `output` and `cacheHitRatio` (`cachedRead / input`, a
    fraction in `[0, 1]`). `uncachedInput` and `cacheHitRatio` are `null` when
    a component is missing or the split is internally inconsistent; the raw
    reported columns still appear. A valid zero-input split yields
    `uncachedInput = 0` and `cacheHitRatio = null`.
  - `metrics.tools` reports `calls`, `failed`, `unclassified`, `totalToolMs`
    and `byName` (the five busiest tool names, most calls
    first, each with `calls` and `failed`). Calls are paired by `toolCallId`.
    A completion whose payload states no readable outcome counts in
    `unclassified` and never as a success. A start with no completion, or a
    completion with no start, still counts in `calls` with an unknown duration
    which makes `totalToolMs` a lower bound. Unpaired starts do not count in
    `unclassified`. Missing IDs never establish a pairing. `totalToolMs` is the
    union of paired intervals, so parallel calls count wall time only once.
    One query across all run sessions selects only tool start/completion events,
    projecting names and outcome markers into `payload` in SQL; tool output
    bodies are never loaded for metrics. Provider discriminators and outcome
    marker types must match: Claude `tool_result.is_error`, PI
    `tool_execution_end.isError`, and Codex `command_execution.exit_code`
    (numeric, with any non-null item-level `error` taking precedence as failure).
    A Codex status alone cannot establish an outcome.
  - `metrics.modelActiveMs` is `executingMs` less tool time and Inbox wait,
    clamped at `0`, and `null` when `executingMs` is unknown. An unknown
    subtrahend is subtracted as `0`, which can only overstate the remainder:
    `metrics.modelActiveIsUpperBound` is `true` in exactly that case.
  - `metrics.outputTokensPerSecond` is `output / (modelActiveMs / 1000)`. It is
    an **effective session-average rate** over model-active time — not a
    provider peak rate — and is `null` when `output` is unknown or
    `modelActiveMs` is unknown or `0`. When `modelActiveIsUpperBound` is true,
    the duration is an upper bound (≤) and this rate is a lower bound (≥).
  - `metrics.ttft` reports provider-boundary time-to-first-token over the
    session's persisted model-completion events as `{p50Ms, p90Ms, samples}`.
    Percentiles use the continuous sample distribution and `samples` counts
    completion events carrying a numeric `anneal.ttftMs` value. It is `null`
    when no completion event has a measurement, including every run recorded
    before TTFT persistence was deployed. A CLI transcript exposing only a
    completed message (as in the captured Codex output) has no first-chunk
    measurement; its completion time is not substituted for TTFT.
  - `metrics.termination` carries the Session's own account of how the run
    ended: `reason`, `exitCode` and `signal`.
  - `metrics.vsBaseline` measures the run against the task-level `baseline`
    below: `costRatio` is the session's reported cost over the baseline cost
    p50, and `durationRatio` is `metrics.phases.executingMs` over the baseline
    duration p50. Each is `null` whenever the baseline metric or the run's own
    value is unknown; above `1` means dearer or slower than usual. Both use the
    raw values published beside them, so a ratio and its figures cannot
    disagree. `durationRatio` is also `null` while the session has not ended:
    the executing phase of a live run is measured to now, and the baseline is
    built from completed runs only.
- The response carries a task-level `baseline`: what this task's template step
  usually costs and how long it usually takes, over the **terminally
  successful** (`SUCCEEDED`) runs of the same `templateStepId` in the same
  project. It is
  `{sampleSize, costUsd: {sampleSize, p50, p90} | null, durationMs: {sampleSize, p50, p90} | null}`.
  `costUsd` is in USD over the runs whose session reported a cost; `durationMs`
  is in milliseconds over the runs whose session has both `startedAt` and
  `endedAt`, so the two samples can differ in size and each reports its own.
  A metric with fewer than five samples is `null`, and `baseline` itself is
  `null` when neither metric survives — including on a task with no
  `templateStepId`. `null` always means insufficient history, never `0`.

```sh
curl "$BASE_URL/tasks/$TASK_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/tasks/:taskId/startability`

- Required path parameter: `taskId`.

```sh
curl "$BASE_URL/tasks/$TASK_ID/startability" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/tasks/:taskId/chain`

- Required path parameter: `taskId`.
- The response includes a Chain-level `control` object. It contains the
  current `state`, held layer (`heldLayer`), `heldAt`, optional hold reason
  (`holdReason`), the request identifier (`holdRequestId`) that accepted the
  hold, and `releasedAt` when the hold was last released. `control` is `null`
  for a Chain that has never been held;
  after a release it reports the released state and its last-release facts.
  Each Step also carries `holdRefusal`: the API's hold-specific refusal message
  when the persisted barrier prevents that Step from starting, otherwise
  `null`. The UI uses this field with `startable` and `startAction`; it does not
  recompute the held-layer barrier.
- Each Step's `agent` object carries `id`, `title`, the Agent's `name` (its
  slug) and `model` (the stored `model:effort` string), or is `null` for a Step
  with no Agent assignee. Each Step also carries `reassignable`: whether
  `PATCH /tasks/:taskId` would accept an assignee change right now, which is
  true exactly when the Step's task has no Run in an active status.

```sh
curl "$BASE_URL/tasks/$TASK_ID/chain" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### DELETE `/tasks/:taskId/chain`

- Required path parameter: `taskId`, naming either a direct Chain member or a
  detached merge-tail repair task bound to the Chain by its repair marker.
- Deletes every Task in the project-scoped Chain, including its marker-bound
  repair tasks, atomically. When the deleted Chain was bound by `afterTaskId`,
  this releases that binding only; every other chain bound to the same
  predecessor stays bound.
- Refusals: `404 Not Found` when the Task does not exist; `409 Conflict` when
  the Task belongs to no Chain, any Chain member has an active Run, or a member
  has retained Run/Session history. Active Run and retained-history refusals
  return codes `chain_delete_active_run` and `chain_delete_run_history`,
  respectively, and change nothing.

```sh
curl -X DELETE "$BASE_URL/tasks/$TASK_ID/chain" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/chain/hold`

- Required path parameter: `taskId`.
- Required JSON field: `requestId`.
- Optional JSON field: `reason` (the operator's explanation for holding the
  Chain).
- The hold barrier is layer-granular and never cancels an active Run. The
  API records `heldLayer` as the dense one-based ordinal of the highest
  execution layer already admitted:
  any member whose status is not `TODO`, or any member with at least one Run,
  admits its layer. If no layer has been admitted, `heldLayer` is `0`; the
  `ChainControlEvent.layer` for the Hold is also `0`. A zero-layer hold
  refuses every layer, and a later start/claim refusal says
  `Chain is held before its first layer`.
- A repeated Hold while the Chain is already held is a successful idempotent
  no-op: it reports the existing hold and makes no transition or audit event.
- When a predecessor completes, a bound successor that is held before that
  activation is not queued. The successor task remains `TODO` without a Run
  and receives a `TaskActivity` whose metadata has
  `kind: "chainControl.activationWithheld"`; resuming that successor Chain
  owns the later activation.
- Refusals: `404 Not Found` when the Task does not exist; `409 Conflict`
  when the Task belongs to no Chain or every Task in the Chain is already
  `DONE` (there is nothing left to hold).

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/chain/hold" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"hold-001","reason":"Review the current layer first"}'
```

### POST `/tasks/:taskId/chain/resume`

- Required path parameter: `taskId`.
- Required JSON field: `requestId`.
- Resume releases a held Chain and activates the currently eligible layer at
  most once. It never revives a cancelled Run or reuses its provider
  conversation.
- When the released hold has `heldLayer: 0`, Resume activates the Chain's
  actual first execution layer (including every member of a parallel layer)
  when that layer has no Run and its tasks are unbound (`dispatchAfterTaskId`
  is absent) or their bound predecessors are `DONE`. This supports sparse,
  zero-based, and one-based stored layers, uses the same repository, agent,
  and startability admission as `POST /tasks/:taskId/start`, and returns the
  first activated task's id in `nextTaskId`. If a bound predecessor is not
  `DONE`, Resume still releases the control but activates nothing
  (`nextTaskId: null`); completion of that predecessor later queues the
  successor through the normal unheld path. For `heldLayer >= 1`, the existing
  resume activation-anchor behavior is unchanged.
- Resume on a Chain that is not held is a successful idempotent no-op: it
  makes no transition, audit event, or activation.
- Resume releases a held recovery authorization for replay by the base-drift
  worker. The aggregate keeps the pending `integrator-authorized` intent until
  the worker validates its authorization against the current base, acquires the
  merge Lease, applies the same admission as `POST /tasks/:taskId/start`, and
  records the new Run's durable handoff. Only that birth moves the aggregate to
  `succeeded`; `authorization-replayed` TaskActivity records it. A second Resume
  opens nothing. Contention or an admission refusal keeps the intent pending;
  after the obstruction is repaired, a later worker tick can consume it even
  though the Chain control is already released. Admission refusals are recorded
  in the integrator task's activity.
- Refusals: `404 Not Found` when the Task does not exist; `409 Conflict`
  when the Task belongs to no Chain.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/chain/resume" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"resume-001"}'
```

### POST `/tasks/:taskId/merge-tail/repair`

- Required path parameter: `taskId`, naming the Chain's Regression
  verification task.
- Required JSON field: `requestId` (a non-empty operator request identifier).
- Optional JSON field: `reason` (the operator's explanation for re-entering
  repair).
- The request is accepted only for the latest `MergeRecoveryAttempt` bound to
  this regression task when its aggregate is `BLOCKED_DOWNSTREAM`, its
  `refusalCode` is `null`, and its `regressionTaskId` equals `taskId`. The
  stored `TaskStepOutput` must be produced by that attempt's `recoveryRunId`
  and carry a `review-fail` or `gate-fail` verdict. The regression, merge
  readiness, and integrator tasks must all be in `REVIEW`, with no active Run
  on any of them.
- On success, the API returns `200 OK` with the repair result, including the
  created detached `repairTaskId`, `repairKind` (`review-fix` or `gate-fix`),
  verdict `headSha`, and `baseHeadSha`. The same `requestId` is idempotent: a
  replay returns the original `200` result and creates no task, marker, or
  activity. A request whose recovery `sourceRunId` already has a matching
  `repairAttempt` marker is refused as already open.
- The accepted operation is one serializable transaction under the Chain lock.
  It charges the existing automatic repair budget, creates the ordinary
  detached repair task, writes the corresponding `repairAttempt` marker,
  transitions the aggregate to `REPAIRING`, clears `failureReason`, and
  records the operator activity on the regression task. It never writes a
  `repairResult`; the genuine repair completion does that.
- For `review-fix` and `gate-fix`, the repair Agent is resolved from the
  profile selected when the Chain was instantiated. The lookup uses the Chain
  root's first TaskActivity metadata `staffingProfileId`; when that metadata
  is absent (including a Chain created before staffing profiles or one that
  recorded none), it uses the template's default profile. A recorded profile
  id is never replaced by another profile if that row no longer resolves. A
  non-null profile `mergeTailRepairAgentId` wins. An empty slot falls back to
  the Chain's `fixed-implementation` Agent. If the selected slot Agent has
  since been archived, the same fixed-implementation fallback is used and a
  `TaskActivity` records why. Operator reentry through this route uses this
  same lookup, so it agrees with automatic repair creation. `refresh-conflict`
  remains staffed by `MERGE_RESOLVER_ROLE`, and repair cards that already
  exist keep their assignee.
- Refusals are `409 Conflict` JSON responses with a typed `code` and no side
  effect:

  - `merge_tail_repair_not_blocked`: the task has no matching latest recovery
    attempt in `BLOCKED_DOWNSTREAM`, including an aggregate already in
    `REPAIRING` with no open repair task or an aggregate missing required
    recovery identity.
  - `merge_tail_repair_verdict_missing`: the stored output is absent, is a
    pass/unsupported verdict, or was produced by a Run other than
    `recoveryRunId`.
  - `merge_tail_repair_active_run`: the regression, readiness, or integrator
    task has an active Run.
  - `merge_tail_repair_refusal_pending`: the recovery attempt still has a
    non-null `refusalCode`.
  - `merge_tail_repair_budget_exhausted`: the existing repair-attempt count for
    this repair kind has reached `MAX_MERGE_TAIL_REPAIR_ATTEMPTS`.
  - `merge_tail_repair_already_open`: a repair attempt for this recovery
    `sourceRunId` is already present. This takes precedence over the aggregate
    having already moved to `REPAIRING`.
  - `merge_tail_repair_unstaffed`: the profile slot is empty and the Chain has
    no fixed-implementation Agent to use as the fallback, so no Agent can be
    resolved for this repair. Nothing is substituted for the missing binding.
  - `merge_tail_repair_creation_failed`: the resolved repair Agent is
    unavailable, lacks the repository grant, or the detached repair task cannot
    resolve the Chain repository, position, and shared branch.

  This route also carries `merge_tail_repair_binding_mismatch`, but a request
  cannot provoke it: the route repairs the recovery's own `recoveryRunId`, so
  the repair it creates is bound by construction. The code exists so the repair
  creation both entrypoints share fails loud and classified — rather than
  creating an unsettleable repair — if this route ever stops deriving its source
  Run from the aggregate. The automatic tail is the reachable open-time refusal
  site.

```sh
curl -X POST "$BASE_URL/tasks/$REGRESSION_TASK_ID/merge-tail/repair" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"reenter-recovery-repair-001","reason":"Fix the regression found during base-drift recovery"}'
```

#### Automatic refresh-conflict repair settlement

An automatic `refresh-conflict` repair normally supplies a `resolvedHeadSha`
from the resolver's versioned output. If that output is malformed or a
resolved output is missing `resolvedHeadSha`, settlement reads the current
Chain branch head from the repository once before deciding whether to refuse
the repair. The merge tail adopts that head only when repository ancestry
checks verify that it is a descendant of
both the repair marker's `headSha` (the starting head) and `baseHeadSha` (the
target base). It then continues recovery with that verified head, preserving
a resolved merge commit that the resolver pushed even when its result payload
was malformed.

Adoption rebinds the repair Run's `headSha` and the repair task's
`TaskStepOutput.commitSha` to the repository-verified head. The Regression
handoff requires both durable bindings to match the resolved head. Existing
output text is preserved; if no output exists, settlement creates an empty
body using the repair Step's output kind (or `result` for a detached repair).
These bindings record control-plane repository evidence, not a new runner
publication report.

The repository reads share a 20-second deadline within a completion
transaction budget of 60 seconds, leaving time to persist a timeout refusal
and its activity. Completion holds the Run row lock while checking ancestry.

The fallback is recorded as a `TaskActivity` on the repair task. The
activity names the fallback, the rejected result key (for example `body` or
`resolvedHeadSha`), and the adopted head. Inspect it with
`GET /tasks/:taskId/activity`. When the fallback cannot adopt a head, the
`repairResult` history continues to carry the invalid-output reason and
`rejectedKey` on the repair and Regression tasks.

If the repository read fails, the read error is recorded and the repair fails
as the existing invalid-output path does. A branch head that is not descended
from both expected heads is also refused; no unverified head is adopted. The
existing refusals for stale `startHeadSha` or `targetHeadSha` bindings and for
an explicit resolver `unable` outcome are unchanged.

### POST `/tasks/:taskId/merge-tail/rerun`

- Required path parameter: `taskId`, naming the Chain's Regression
  verification task.
- Required JSON field: `requestId` (a non-empty operator request identifier).
- Optional JSON field: `reason` (why the gate FAIL is not the branch's).
- Use this route instead of `POST /tasks/:taskId/merge-tail/repair` when the
  recovery's merge gate FAIL was caused by the host and not by the branch — a
  test that timed out under host load, a gate worker that ran out of memory —
  so there is nothing for a `gate-fix` repair to fix. Use the repair route when
  the verdict names a real defect, and for every `review-fail` verdict. Confirm
  the failing test is outside the branch's change set before re-running: this
  route re-runs the same head against the same base and will reproduce a
  genuine failure.
- The request is accepted only for the latest `MergeRecoveryAttempt` bound to
  this regression task when its aggregate is `BLOCKED_DOWNSTREAM`, its
  `refusalCode` is `null`, and its `regressionTaskId` equals `taskId`. The
  stored `TaskStepOutput` must be produced by that attempt's `recoveryRunId`
  and carry a `gate-fail` verdict. The regression, merge readiness, and
  integrator tasks must all be in `REVIEW`, with no active Run on any of them.
- The accepted operation is one serializable transaction under the Chain lock.
  It creates a new recovery attempt row for the same source stop at
  `attempt + 1`, bound to the same authorized head, base, PR, and readiness and
  integrator tasks; queues a fresh Regression Run through the ordinary recovery
  path; clears the regression and readiness `failureReason`; and records the
  operator activity, its `reason`, and the new attempt number on the regression
  task. It creates no repair task, charges no repair budget, and leaves the
  `repairAttempt` markers the repair budget counts untouched. It spends none of
  the two automatic base-drift recovery attempts either: those are counted per
  recovery source stop, and a rerun re-runs a stop that is already counted. The
  queued Run carries a one-time budget grant, so a rerun does not consume one of
  the Regression task's `maxSessionsPerTask` attempts.
- On success, the API returns `200 OK` with `aggregateId` (the new attempt),
  `attempt`, `recoveryRunId` (the queued Regression Run), and the verdict
  `headSha` and `baseHeadSha`. The same `requestId` is idempotent: a replay
  returns the original `200` result and creates no attempt, Run, or activity.
- Refusals are `409 Conflict` JSON responses with a typed `code` and no side
  effect:

  - `merge_tail_rerun_not_blocked`: the task has no matching latest recovery
    attempt in `BLOCKED_DOWNSTREAM` with complete recovery identity and a null
    `refusalCode`, or its regression, readiness, or integrator task is not in
    `REVIEW`.
  - `merge_tail_rerun_verdict_not_gate_fail`: the recovery Run owns no readable
    verdict, or its verdict is `review-fail`, `refresh-conflict`, or `pass`.
    Those are the branch's own results: use the repair route for a `review-fail`
    verdict, and neither route for a refresh conflict, which needs a resolver
    result.
  - `merge_tail_rerun_active_run`: the regression, readiness, or integrator
    task has an active Run.
  - `merge_tail_rerun_budget_exhausted`: this recovery source stop has already
    been re-run `MAX_MERGE_TAIL_OPERATOR_RERUNS` times. A gate that fails three
    times on the same head is not a host failure; carry the branch forward with
    [Recovering a merge tail stopped after its repair
    budget](#recovering-a-merge-tail-stopped-after-its-repair-budget).

```sh
curl -X POST "$BASE_URL/tasks/$REGRESSION_TASK_ID/merge-tail/rerun" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"rerun-recovery-gate-001","reason":"The failing test is outside this branch and timed out under host load"}'
```

### Regression semantic verdict reuse during base-drift recovery

A fresh Regression Run opened by base-drift recovery receives
`regressionRecoveryContext` in its runner claim: `state: "queued"`,
`currentBaseSha`, `authorizedHeadSha`, `recoveryRunId`, and `priorOutput` (the
latest persisted regression output snapshotted before recovery clears it, or
`null`). The snapshot carries the prior `runId`, `kind`, `body`, and `commitSha`.

`regression-verification.sh prepare` decides once from that snapshot. It reuses
semantic PASS only when the incoming head, before target refresh, matches both
the authorized recovery head and the prior output's exact head, and the latest
output is valid v2 evidence of semantic success (`pass` or `gate-fail`). A different head, a latest `review-fail` or
`refresh-conflict`, or missing or invalid evidence requires the normal semantic
recheck. A reused verdict skips that recheck; `finalize` still runs the Merge
gate. The persisted v2 result adds `semanticVerdict: "reused"` and
`semanticSourceRunId` naming the prior Run. Finalization remains bound to the
refreshed head; a later base move invalidates reuse. First regressions and
changed incoming heads retain semantic verification.

### Regression verdict precedence after an external Run failure

A Regression verification Run can persist its `regression-verification-v2`
output and then fail for an external reason: for example, a task-failed Git
operation during target refresh or WIP salvage, or a provider stream failure.
Completion qualifies the persisted semantic result before deciding whether to
retry or settle the Task as an ordinary external failure. This ordering
preserves the result the Run already authored.
Only persisted v2 `review-fail` and `refresh-conflict` results receive this new
external-failure precedence; `gate-fail` and a Run with no such output
keep the existing external-failure path, including the legacy protocol-error
handling.

The persisted result is control-plane evidence only when all of these bindings
hold:

- the `TaskStepOutput` belongs to the same Run (`runId`),
- its body is valid `regression-verification-v2` JSON and its authored commit
  is present, and
- the verdict's `headSha`, the output's `commitSha`, and the Run's exact head
  agree.

When completion has no `headSha`, this external-failure path uses the output's
authored `commitSha` as the persisted head for validation. A repair then binds
to that head, so the operator does not need to carry the branch forward manually. A result from another Run, a
malformed body, a missing authored commit, or a mismatched head is refused and
does not control the Chain. Run text and `TaskActivity` rows never synthesize a
verdict.

For a validated negative result, the merge tail uses the persisted semantic
outcome even though the Run itself records an external failure. `review-fail`
queues the normal `review-fix` repair and `refresh-conflict` queues the
`refresh-conflict` repair, both against the persisted head and its recorded
base. The external failure remains visible as a diagnostic
`TaskActivity` on the Regression task; inspect it with
`GET /tasks/:taskId/activity`. It is diagnostic history, not a replacement for
the persisted verdict and not another source of semantic authority.

Inside a base-drift recovery Run, the same validation and precedence apply,
but the settlement is the recovery stop carrying the persisted verdict's
reason. It does not open an automatic repair from the failed Run. The recovery
attempt and its existing Regression, Merge readiness, and merge-integrator
tasks remain in the documented recovery-stop state, so the recovery ceiling
and `POST /tasks/:taskId/merge-tail/repair` re-entry rules continue to apply.

A persisted `pass` is excluded from this failed-completion rule. An external
failure after a PASS never advances the Chain or creates a repair on the basis
of that PASS. Advancement uses the ordinary successful-completion path, with
the exact head named by completion and a persisted gate verdict for that same
head.

### Settling a chain whose repair cannot bind

Two merge-tail mechanisms can overlap on one Chain: a base-drift recovery
aggregate bound to its own recovery Run, and an ordinary `gate-fix` or
`review-fix` repair opened against a different Regression Run. A repair whose
Chain recovery names another Run can never be settled, so the platform refuses
it rather than handing an agent work it cannot report.

- At open, both repair entrypoints refuse. The automatic tail parks the
  regression task in `REVIEW` with a `failureReason` beginning
  `merge-tail-repair-binding-mismatch:` and writes the ordinary
  `Autonomous merge tail stopped:` Inbox notice; `POST
  /tasks/:taskId/merge-tail/repair` answers `409 Conflict` with code
  `merge_tail_repair_binding_mismatch`. No repair task is created either way.
- At settlement — a repair opened before the overlap appeared, or one whose
  aggregate moved while it ran — the completion is rejected rather than failing
  the Run. `POST /runner/runs/:runId/complete` answers `409 Conflict` with the
  same reason and a `recoveryId`, `boundRecoveryRunId`, `boundSourceRunId` and
  `repairedRunId`. This
  is not an internal error and not an external Run failure: the Run stays
  terminal and carries the reason in its `failureReason`, the repair task parks
  in `REVIEW` with it, and the repair's own commit stays on the shared branch.
- Either way the overlap is recorded as a control-plane TaskActivity on the
  regression task whose `metadata.kind` is `mergeTailRepair.bindingMismatch`,
  carrying `recoveryId`, `boundRecoveryRunId`, `boundSourceRunId`,
  `repairedRunId` and `phase` (`open` or `settlement`). `boundRecoveryRunId` is
  the Run the recovery is bound to — the aggregate's `recoveryRunId`, the value
  the invariant compares — while `boundSourceRunId` is the aggregate's column of
  that name, the Run the recovery was opened from. Read it with `GET
  /tasks/:taskId/activity`; it names both mechanisms without reading the API
  journal.

The exit is the reentry route, not another Run of the stranded repair.
`PATCH /tasks/:taskId` can move the parked repair task's status, but that
settles nothing: it does not rebind the recovery, reopen the tail, or produce a
Run that can settle it, and re-running the stranded card reproduces the same
unbindable completion. `POST /tasks/:taskId/merge-tail/repair` instead opens a
*new* repair card bound to the recovery's own `recoveryRunId`, with its own Run
budget — so it works even when the stranded repair task's `maxSessionsPerTask`
is already spent, and nothing needs `PATCH /tasks/:taskId` to raise a budget.

1. Read the binding-mismatch activity and the parked repair task, and confirm
   which mechanism owns the Chain.

   ```sh
   curl "$BASE_URL/tasks/$REGRESSION_TASK_ID/activity" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" | \
     jq '[.[] | select(.metadata.kind == "mergeTailRepair.bindingMismatch")]'
   ```

2. A settlement rejection parks the recovery in `BLOCKED_DOWNSTREAM` with the
   regression, readiness, and integrator tasks in `REVIEW`, which is exactly
   the state the reentry route reopens. Call it on the regression task; it
   charges the existing repair budget and opens a correctly bound repair.

   The rejection parks that state only when no tail task still has an active
   Run. When the recovery that took the Chain over is still running, the
   rejection records the activity and the notice and leaves that recovery
   alone — it is the mechanism that owns the Chain, and it settles the tail on
   its own. Nothing further is needed unless it, too, stops.

   ```sh
   curl -X POST "$BASE_URL/tasks/$REGRESSION_TASK_ID/merge-tail/repair" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
     -d '{"requestId":"settle-unbindable-repair-001","reason":"Recovery and gate-fix repair overlapped on this chain"}'
   ```

3. If that route refuses — `merge_tail_repair_not_blocked` for a terminal or
   incomplete aggregate, `merge_tail_repair_verdict_missing` when the stored
   regression output is no longer the recovery Run's, or
   `merge_tail_repair_budget_exhausted` — the Chain has no automatic exit left.
   Carry the delivered branch forward with steps (b) to (e) of
   [Recovering a merge tail stopped after its repair
   budget](#recovering-a-merge-tail-stopped-after-its-repair-budget); the
   repair's commit is already published on the shared branch, so its work is
   preserved by the successor Chain's first Change.

Whether a Chain should be allowed to run base-drift recovery and a gate-fix
repair at the same time is not decided here. This refusal names the overlap and
stops before spending a Run on work the platform would not accept.

### Readiness evaluation exceptions

An exception thrown while the merge readiness worker evaluates a Chain — a
killed child process, a killed worker, a service restart mid-tick — is not a
verdict. The worker returns the readiness task to `TODO` and evaluates it again
on a later tick, writing one `TaskActivity` on the Regression verification task,
where the readiness requeue and stop rows already land, whose `metadata.state`
is `requeued-exception` and whose body reads
`Merge readiness requeued after evaluation exception <n> of <limit>: readiness
evaluation exception: <message>`. The Regression evidence and its Run are left
alone, no stop notice is written, and the merge lease is released exactly as an
ordinary readiness requeue releases it.

The retry is bounded by `MERGE_READINESS_EXCEPTION_REQUEUE_LIMIT` (default 3),
read once per worker tick; a value that is not a non-negative integer fails the
API service at startup. Once that many exception requeues have been spent on the
same readiness task within the same recovery attempt, the next exception stops
the tail as before with `failureReason`
`readiness evaluation failed after <n> exception requeues: <message>`. Outside a
base-drift recovery that stop parks the regression and readiness tasks in
`REVIEW` and writes the matching `Autonomous merge readiness stopped:` Inbox
notice; inside one it takes the recovery stop path instead — the recovery
attempt becomes `BLOCKED_DOWNSTREAM`, the integrator task is parked as well, and
the notice reads `Automatic base-drift recovery <n> stopped at readiness:
<reason>`.

Three readiness failures are not exception requeues and stop the tail on their
first occurrence. A deliberate refusal — a recovery head-adoption refusal —
carries a refusal code and stops with `readiness evaluation failed: <message>`.
A missing, mismatched, or ambiguous operator authorization on a gated readiness
step is a fail-closed gate decision, not a transient fault, and stops with that
same reason. A GitHub read that fails for any reason other than a timeout or a
transport error (those are deferred to the next tick) is a
`readiness-read-failed` decision, and stops with that same `readiness evaluation
failed: <message>` reason and no refusal code.

### Recovering a merge tail stopped after its repair budget

An automatic merge-tail repair Run (`refresh-conflict`, `review-fix`, or
`gate-fix`) that fails before recording its result consumes one session
of that detached repair Task's `maxSessionsPerTask` budget. For a
`task-failed` Run, when another session remains, the platform queues the next
Run of the same repair Task automatically against the recorded start head and
base pair with the same branch pinning. It records a TaskActivity reading
`merge-tail repair Run N failed before a result; Run N+1 queued`; the
Regression step stays in the repair loop. This is the same repair attempt, so
the requeue spends neither `leaseLossRefunds` nor another per-kind automatic
repair attempt.

When the repair Task has spent its session budget, the platform keeps the
existing stop behavior: `stopMergeTail` parks the Regression verification task
in `REVIEW` with the existing `... repair ... failed without closing the
repair ...` reason and writes the stop notice. The operator's
`POST /tasks/:taskId/retry` remains the exit after that budget is spent; raising
`maxSessionsPerTask` through `PATCH /tasks/:taskId` is required first when the
retry would otherwise be refused for an exhausted Run budget.

When a regression verdict fails after the automatic repair budget is exhausted,
the Regression verification task remains parked in `REVIEW`, and a stop notice
is written to the Inbox. Its `failureReason` is exactly one of these shapes:

- `semantic regression FAIL on chain head <sha> after N automatic repair attempts`
- `merge gate FAIL on chain head <sha> after N automatic repair attempts`
- `chain <chainId> has no fixed-implementation step to staff the <review-fix|gate-fix> repair`
- `chain <chainId> fixed-implementation task <taskId> staffs no Agent for the <review-fix|gate-fix> repair`

The last two shapes are not repair ceilings. For the missing-step shape, the Chain's template has no
fixed-implementation step, so no Agent it staffed owns the repair. The tail
stops and writes the stop notice rather than assigning the work to a canonical
role nobody configured for this Chain. Instantiate the Chain from a template
that has the step, or carry the branch forward as below. For the unbound-task
shape, the step exists but its named task staffs no Agent; instantiate with an
Agent bound to that step, or carry the branch forward as below.

For a repair ceiling stop,
`POST /tasks/:taskId/retry` on the regression task opens a Run whose
`regression-repair-handoff` claim fails at claim time as `handoff-invalid` with
`regression repair handoff is invalid: no successful review-fix result binds <head> to <base>`
for a semantic regression stop, or
`regression repair handoff is invalid: no successful gate-fix result binds <head> to <base>`
for a merge gate stop. A `PATCH /tasks/:taskId` request that supplies `status`
is refused with `Chain task statuses are controlled by chain execution`. Both
refusals are expected behaviour; do not use them to reopen the old Chain.

#### Base-drift classification retry classes and `re-validate`

Automatic pre-merge base-drift recovery accounts a classification tick that did
not conclude against one of three classes, and only one of them is budgeted by
count:

- `waiting` — the Chain's own Run is still active, so the recovery is not
  classified yet. Bounded by six hours since the first wait, never by count.
- `transport` — the server-side repository read failed. Bounded by thirty
  minutes since the first failed read, never by count.
- `validation` — a classification ran against real facts and could not
  conclude. Bounded by both `MAX_BASE_DRIFT_VALIDATION_ATTEMPTS` (30) failures
  and thirty minutes since the first of them, so a burst inside one incident
  cannot exhaust it.

`waiting` and `transport` hold the next tick on a per-attempt backoff that
doubles from the worker's two-second tick to a sixty-second cap, stored on the
attempt as `nextEligibleAt`; `validation` takes no hold and stays eligible at
the next tick. Each deferral writes a `baseDriftRecovery` activity in state
`classification-retry` naming the class, its counter, the elapsed time in that
class, and the next eligible time (`null` for `validation`); a class change is
recorded there as well.

A read that reached the repository and returned no usable ancestry comparison
is `transport`, not `validation`: the candidate was never classified, so its
counted budget does not pay for the upstream's silence.

Crossing a ceiling settles the attempt as `FAILED` with a `refusalCode` naming
the class, and the `failureReason` states the class and the elapsed time. The
settle records the failure that crossed the ceiling before it settles, so the
attempt's counters and the refusal text state the same number of failures, and
the settle activity carries all three counters:

- `waiting-ceiling` — `waiting-ceiling reached: the chain stayed active for <elapsed> (limit 6h00m); last classification: <reason>`
- `transport-ceiling` — `transport-ceiling reached: repository reads failed for <elapsed> (limit 30m); last read failure: <reason>`
- `validation-budget` — `validation-budget exhausted: <n> classification failures over <elapsed> (limit 30 attempts spanning 30m); last classification: <reason>`

A class-ceiling settle opens a stop question offering `re-validate` alongside
`abandon`, and writes a stop notice keyed
`merge-base-drift-recovery:<state>:<stopId>` (with an `:r<n>` suffix after the
n-th `re-validate`). Every base-drift recovery settle — a class ceiling, an
ordinary ineligibility, or the automatic recovery limit — carries that same
`:r<n>` generation on its stop question key `merge-stop:<stopId>:r<n>`, so a
recovery that settles again after a `re-validate` always opens a fresh,
answerable card instead of deduplicating against the answered one. Answer it
through
`POST /inbox/messages/:messageId/decision` with `decision: "re-validate"`. That
answer resets the counters of the settled class and no other, clears the
backoff and the refusal, returns the attempt to `VALIDATING`, and records a
`class-revalidated` activity. The recovery resumes on the same attempt; no
successor Chain is required. Every other base-drift refusal keeps its
abandon-only card, because there is no class counter for `re-validate` to
reset.

#### When the merge-integrator Run itself fails after recovery

A canonical integrator step defers its `base-drift` question to the recovery
worker, so while that stop stands there is no card to answer and both
`POST /tasks/:taskId/retry` and `POST /tasks/:taskId/start` answer
`Merge integrator stopped on base-drift; answer the stop question before
starting another run`. The completion that records a failed integrator Run
therefore decides the exit, with no operator input:

- An **external failure** — transport, credential-mint transport or API 5xx —
  records a pending authorization on the recovery aggregate. After the failed
  Run's Lease release finishes, the recovery worker reads the current base.
  If the authorized base is current, it acquires a new Lease and replays the
  bound `integrator-authorized` intent with a durable handoff. Otherwise it
  queues fresh base-drift recovery without a stale integrator Run. Recovery
  Runs and external replays share the automatic recovery ceiling (2) across
  stops for the same integrator, repository, PR and target. A Hold or admission
  refusal preserves the pending intent without opening an abandon-only card.
- **Anything else** is a deterministic refusal — the merge API answered
  forbidden, unprocessable or not-found — and stops. The question the canonical
  stop deferred is opened on the same `merge-stop:<stopId>` key family the
  recovery worker uses, so an operator has something to answer; the activity is
  in state `question-opened`. The same happens once the re-queue ceiling is
  spent; this execution allowance has no class counter to reset, so its card
  offers abandon only.

In both cases the merge Lease handed to that Run is released by this same
completion, because the Run ended without completing its merge. See
[Merge lease](#merge-lease).

#### Re-entering after a base-drift recovery FAIL

If a semantic (`review-fail`) or merge-gate (`gate-fail`) regression FAIL
occurs inside base-drift recovery, the merge tail is parked in
`BLOCKED_DOWNSTREAM` with the recovery attempt's `recoveryRunId`. After
confirming the failing output and stop notice, call
`POST /tasks/:taskId/merge-tail/repair` on the regression task before
considering a successor Chain. The repair route re-enters the ordinary
`review-fix` or `gate-fix` round against the recorded head and base, charges
the Chain's existing repair budget, and moves the aggregate to `REPAIRING`.
Once that repair genuinely completes, the regression is rerun with the recovery
context: a PASS proceeds to `awaitAuthorization`; another FAIL parks the tail in
`BLOCKED_DOWNSTREAM` again and can be re-entered with the repair route while
budget remains. A refresh-conflict verdict keeps its existing recovery stop and
is not re-entered by either route.

For a `gate-fail` verdict whose failure is the host's and not the branch's — a
test outside the change set that timed out under load — call
`POST /tasks/:taskId/merge-tail/rerun` instead: it re-runs the recovery without
opening a repair card for a defect that does not exist.

Carry the delivered branch forward in this order. The brief used in step (c)
must follow [Continuing from a delivered branch](BRIEF-TEMPLATE.md#continuing-from-a-delivered-branch).

1. (a) Read the regression task output and the stop notice, and confirm that
   the last verdict identifies a real defect. Find the notice by listing the
   project's Inbox and selecting the message for the regression task whose
   body starts with `Autonomous merge tail stopped:`.

   ```sh
   curl "$BASE_URL/tasks/$REGRESSION_TASK_ID/output" -H "Authorization: Bearer $OPERATOR_TOKEN"
   STOP_NOTICE_ID=$(curl "$BASE_URL/inbox/messages?projectId=$PROJECT_ID" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" | \
     jq -r --arg taskId "$REGRESSION_TASK_ID" \
       '.[] | select(.taskId == $taskId and (.body | startswith("Autonomous merge tail stopped:"))) | .id' | head -n 1)
   curl "$BASE_URL/inbox/messages/$STOP_NOTICE_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
   ```

2. (b) Hold the old Chain from any of its tasks, giving a `reason` that names
   the successor Chain you plan to create (for example, by its planned
   branch).

   ```sh
   curl -X POST "$BASE_URL/tasks/$OLD_CHAIN_TASK_ID/chain/hold" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
     -d '{"requestId":"hold-merge-tail-repair-budget-exit","reason":"Continue in successor chain for branch '$NEW_BRANCH_NAME'"}'
   ```

3. (c) Instantiate a new direct Chain on the same repository with a fresh
   `branchName`. Set `description` to the new brief following the linked
   pattern, with its first Change merging the delivered branch. Set
   `SUCCESSOR_NAME` to an operator-chosen, one-line successor title of at most
   120 characters.

   ```sh
   SUCCESSOR_BODY=$(jq -n \
     --arg repoId "$REPO_ID" \
     --arg branchName "$NEW_BRANCH_NAME" \
     --arg name "$SUCCESSOR_NAME" \
     --arg description "$SUCCESSOR_BRIEF" \
     '{repoId: $repoId, variables: {branchName: $branchName}, name: $name, description: $description, autoStart: true}')
   curl -X POST "$BASE_URL/projects/$PROJECT_ID/task-templates/$DIRECT_CHAIN_TEMPLATE_ID/instantiate" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
     -d "$SUCCESSOR_BODY"
   ```

4. (d) Archive every task in the old Chain. `GET /tasks/:taskId/chain` returns
   the primary Chain rows but omits its chain-detached merge-tail repair tasks.
   Find those tasks with `GET /tasks?view=board`: their `repairOf.chainId`
   contains the Chain binding derived from the same repair markers that
   `DELETE /tasks/:taskId/chain` covers. Archive both sets of task IDs; for the
   tasks each call newly archives, this closes OPEN notices in the
   `merge-tail-stop:` key family. Other stop-notice families are unchanged.

   ```sh
   OLD_CHAIN=$(curl "$BASE_URL/tasks/$OLD_CHAIN_TASK_ID/chain" \
     -H "Authorization: Bearer $OPERATOR_TOKEN")
   OLD_CHAIN_ID=$(printf '%s' "$OLD_CHAIN" | jq -r '.chainId')
   OLD_TASK_IDS=$(printf '%s' "$OLD_CHAIN" | jq -r '.steps[].taskId')
   REPAIR_TASK_IDS=$(curl "$BASE_URL/tasks?projectId=$PROJECT_ID&view=board&archived=false" \
     -H "Authorization: Bearer $OPERATOR_TOKEN" | \
     jq -r --arg chainId "$OLD_CHAIN_ID" \
       '.[] | select(.repairOf.chainId? == $chainId) | .id')
   printf '%s\n%s\n' "$OLD_TASK_IDS" "$REPAIR_TASK_IDS" | sed '/^$/d' | sort -u | while read -r TASK_ID; do
     curl -X POST "$BASE_URL/tasks/$TASK_ID/archive" -H "Authorization: Bearer $OPERATOR_TOKEN"
   done
   ```

5. (e) Never edit database rows to reopen the loop. Use the API only to inspect
   the old Chain after the handoff; there is no supported database recovery.

   ```sh
   curl "$BASE_URL/tasks/$OLD_CHAIN_TASK_ID/chain" -H "Authorization: Bearer $OPERATOR_TOKEN"
   ```

### PATCH `/tasks/:taskId`

Approving merge evidence with a base different from the persisted gate
attestation returns `409 Conflict` with `gate-attestation-base-mismatch`.
The approval card stays open, no authorization is written, and a durable
TaskActivity records both bases and the refusal on the readiness task. Inbox
approval and evidence renewal preserve the same refusal evidence.

- Required path parameter: `taskId`.
- Required JSON: at least one task field, `status`, or `failureReason`.
  Patchable task fields are `name`, `description`, `workingDirectory`, `repoId`,
  `targetBranch`, `assigneeType`, `assigneeAgentId`, `approvalGate`,
  `opensPullRequest`, `maxDurationMin`, `stallTimeoutMin`,
  `maxSessionsPerTask`, `scheduleKind`, `runAt`, `cron`, and `timezone`.
  `status` is a task status (`BACKLOG`, `TODO`, `DOING`, `REVIEW`, `DONE`);
  `failureReason` may be `null`. `spendCap` is patchable but not creatable: a
  non-negative number sets the task's spend limit in USD and `null` clears it.
  Raising or clearing it is the way out of a `spend-cap-exhausted` refusal —
  the next `POST /tasks/:taskId/retry` is measured against the new value.
  `dispatchAfterTaskId` is the Chain binding and may be a task id or `null`.
- For a Chain task, `approvalGate` can change only when the task's template
  step is one of the two configurable slots — the specification step or merge
  readiness step — and the stored task status is `TODO`. The accepted value is
  persisted and recorded as an operator TaskActivity. A non-slot Chain task
  returns `409 Conflict` with a conflict reason stating that only the
  specification and merge readiness steps carry a configurable gate. A slot
  task whose status is `DOING`, `REVIEW`, or `DONE` returns `409 Conflict` with
  a conflict reason naming that actual state (for example, that the gate can
  change only while `TODO` and is already `DOING`). The status is checked at
  the write boundary, so a slot that leaves `TODO` concurrently is refused.
  This relaxes the previous blanket refusal that approval gates on dispatched
  Chain tasks are controlled by the Chain. Standalone tasks retain their
  existing `approvalGate` PATCH behavior.
- `dispatchAfterTaskId` re-points or releases the Chain binding of a Chain that
  has not run, so an operator whose predecessor was archived or replaced does
  not have to delete the Chain and instantiate it again. It is accepted only on
  the first step of a Chain none of whose steps has a Run; a later step, a
  standalone task, or a Chain with so much as one terminal Run returns
  `409 Conflict` with code `chain_binding_immutable_after_start`. A non-null
  value must name a Chain task of the same project that is not archived and does
  not belong to the Chain being bound; an archived, foreign, standalone, or
  same-chain target — including the task itself — returns `400 Bad Request` with
  code `chain_binding_target_invalid`. A standalone predecessor is refused
  because only a Chain task's completion dispatches a bound successor, so such a
  binding would never resolve. Binding onto a task that is already `DONE` is
  accepted and resolves the binding immediately, which makes the first step
  startable under the ordinary start guard; `null` releases the binding the
  same way. Neither starts the Chain: only a predecessor's completion
  dispatches a bound successor. A successful change writes one operator
  TaskActivity on the first step naming the previous and new predecessor ids.
  Restating the binding a Chain already carries is accepted, writes no
  activity, and returns the current task, even after the Chain has started. A
  request that changes the binding together with `approvalGate`, a Run budget,
  or a status commits every field but records the binding activity only, because
  one PATCH writes one activity row. The named predecessor is read without its
  own lock, so a concurrent archive of it can win the race; the Chain still has
  no Run, so re-issuing the PATCH with another predecessor is the remedy.
- On a Chain step that carries a feature brief, `description` is the brief
  alone. A task with both a `templateId` and a `chainId` whose Step authors a
  brief — every step role except readiness and integrator — keeps its stored
  step prompt and trailing reminders, and the route reframes the submitted text
  as the brief between `<!-- agentos:task-brief:v1 length=<characters> -->` and
  `<!-- /agentos:task-brief:v1 -->`, counting the length itself. Send the brief
  body only: a whole description, prompt and fence included, is not refused but
  becomes the brief inside a second fence, so read the task back and confirm it
  carries one. `GET /tasks/:taskId` reports the already-extracted text as
  `editableBrief`, so a caller need not parse the fence to send the right half
  back. A stored description the route cannot parse, or a Chain step whose
  template Step metadata is missing, refuses with `400 Bad Request` and
  `Cannot rewrite task brief: <reason>`. Every other task stores `description`
  verbatim.
- A `maxSessionsPerTask`, `spendCap` or `description` change is recorded as an
  operator TaskActivity naming the budget's or cap's previous and new value —
  both read under the write's own lock, so the stated previous value is the one
  the write replaced — or stating that the prompt was edited. Clearing a cap is
  such a change and is recorded as `Spend cap: $<previous> → none`. `spendCap`
  accepts `0` through `9999999999.99`, the range of its `Decimal(12,2)` column,
  or `null` to clear it; anything else refuses with `400 Bad Request`. The
  prompt text itself is not copied into the activity.
- Amending a brief after the implementation Step has materialized the
  Specification of record into `.chain/<branchName>/spec.md` does not stop the
  Chain, as long as that Step's Run was claimed by a version that records what
  it was handed. A review claim checks the file against the brief the
  implementer was handed — recorded as a digest when its Run was claimed — so a
  faithful materialization still passes, and every later review Run's prompt
  carries one line naming the amended task and the time it was amended. The
  route never rewrites `spec.md` on the branch: the file remains the
  pre-amendment text, and the amended text stays on the task that was patched.
  A `spec.md` that differs from what the implementer was handed is still refused
  with `spec-transcription-mismatch` and parks the review task, whether or not
  the brief was amended; that refusal also states whether the current brief
  still matches the materialized specification, which is how tampering on the
  branch is told apart from an amendment nobody transcribed.
- A Chain whose implementation Run was claimed before that digest existed, and
  one whose implementation output was written by hand through
  `PUT /tasks/:taskId/output`, records no digest: its review claims still
  compare `spec.md` against the brief as it reads now, so amending that brief
  still refuses the claim with `spec-transcription-mismatch` and parks the
  review task, and the refusal carries no clause about the brief's standing.
  Recovery is unchanged: rewrite `spec.md` on the branch to the amended text,
  `PUT` the implementation output's `headSha`, and restart each review Step.
- A change to `assigneeType` or `assigneeAgentId`, including clearing the
  assignee to `null`, is refused with `409 Conflict` while the task has a Run in
  an active status (`QUEUED`, `RUNNING`, or `WAITING_INBOX`); the message names
  the run number and its status. The guard is per task, not per Chain, and a
  request that restates the assignment the task already has is not a change. A
  task whose Runs are all terminal accepts the reassignment, and the next retry
  opens its Run with the new Agent's runner, model, and service tier.
- The compound implementation step accepts any active, in-project Agent whose
  Run would reach the Codex CLI on a `gpt-*` model. Any other assignee is
  refused with `409 Conflict`, code
  `COMPOUND_IMPLEMENTATION_ASSIGNEE_INVALID`. The Agent's name is not part of
  this rule.

```sh
curl -X PATCH "$BASE_URL/tasks/$TASK_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"approvalGate":true}'
```

### DELETE `/tasks/:taskId`

- Required path parameter: `taskId`.
- Chain members, including detached repair tasks resolved through their repair
  markers, cannot be deleted individually. The route returns `400 Bad Request`
  with code `chain_task_delete_required`, names the Chain, and directs callers
  to `DELETE /tasks/:taskId/chain`.

```sh
curl -X DELETE "$BASE_URL/tasks/$TASK_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/retry`

- Required path parameter: `taskId`.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/retry" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/start`

- Required path parameter: `taskId`.
- Refusals: `409 Conflict` when the task is the first step of a chain bound by
  `afterTaskId` and the predecessor task is not `DONE`. Each chain bound to a
  predecessor is admitted on its own: once the predecessor is `DONE` every one
  of them becomes startable, and starting one does not start or refuse another.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/start" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/archive`

- Required path parameter: `taskId`.
- If the task belongs to a Chain, archives every task in that Chain atomically.
- On tasks this call newly archives, OPEN notices whose dedupe key starts with
  `merge-tail-stop:` are closed atomically; other Inbox messages are unchanged.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/archive" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/unarchive`

- Required path parameter: `taskId`.
- If the task belongs to a Chain, unarchives every task in that Chain atomically.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/unarchive" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/projects/:projectId/tasks/archive-done`

- Required path parameter: `projectId`.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/tasks/archive-done" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/schedule/pause`

- Required path parameter: `taskId`.
- The task must have `scheduleKind: CRON`; no body is required.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/schedule/pause" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/schedule/resume`

- Required path parameter: `taskId`.
- The task must have `scheduleKind: CRON`; no body is required.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/schedule/resume" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/tasks/:taskId/recurring-fires`

- Required path parameter: `taskId`.
- Optional query: `take` (clamped to `1`–`50`, default `5`).

```sh
curl "$BASE_URL/tasks/$TASK_ID/recurring-fires?take=10" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/tasks/:taskId/activity`

- Required path parameter: `taskId`.
- Control-plane rows carry a `metadata.kind`. On a merge-readiness Step,
  `mergeReadiness.requeue` records one pre-authorization requeue: readiness
  returned the chain's candidate to Regression because the pull request's base
  moved under the authorized head. Its metadata carries `ordinal` (one-based,
  oldest first within the chain), `staleBaseSha` and `currentBaseSha` (the base
  it moved from and to), `budgetGrant` (extra Run attempts the settlement
  granted, which fund the replacement Regression Run), `regressionTaskId`, and
  `reason`. The row is written in the settlement's own transaction, so the
  counts and the grants cannot disagree. `readinessRequeues` and
  `readinessGrants` on the board card and on a costs chain row are folds over
  these rows: over control-plane rows of this kind that carry a numeric
  `ordinal`, and over those only. The next requeue's `ordinal` is drawn from
  exactly that row set, so a row the two views cannot count never shifts the
  numbering: a row of this kind posted by any other actor through
  `POST /tasks/:taskId/activity` is an ordinary note, and neither it nor an
  unnumbered row is counted or consumes an `ordinal`.

For a candidate readiness Task, train settlement adds one control-plane
activity entry naming the detached `merge-train` Task, the candidate's
one-based position, and its settlement. The candidate's separate
`mergeTail.train` marker carries the train Task id and position; an aborted
train marker also carries `state: "aborted"` and its reason. These entries are
the per-Chain audit of a train and do not represent a per-Chain base-drift
Regression re-run while `MERGE_TRAIN_WIDTH` is enabled.

When a merge proceeds after its diff touches a defense-list path, the
readiness Step receives one control-plane activity whose body starts with
`Merge proceeded with defense-list changes`, followed by the exact
`baseSha..headSha` range and one `path (reason)` line for each trigger. Its
metadata has kind `mergeTail.defenseAudit` and `schemaVersion: 1`, and carries
`headSha`, `baseSha`, and the `triggers` array. The activity is idempotent for `(readinessTaskId, headSha)`,
and this audit creates no Inbox message; existing rows are left untouched.

```sh
curl "$BASE_URL/tasks/$TASK_ID/activity" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/tasks/:taskId/activity`

- Required path parameter: `taskId`.
- Required JSON field: `body`.
- Optional JSON fields: `actorType` (default `operator`; the operator route
  records the actor as operator), `actorId`, and `metadata`.
- The route records a direct operator note. Notes posted after the task is
  created can reach its first Run if it has not been claimed yet; thereafter,
  notes written after the previous Run are appended to the next Run's prompt
  under `Operator notes`. At most the 10 newest whole notes and 4,000 characters
  are delivered. A note does not reach a Run that is already in flight, and
  canonical `blind-findings` steps receive no activity notes.

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/activity" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"Please preserve the existing public API."}'
```

### GET `/tasks/:taskId/output`

- Required path parameter: `taskId`.

```sh
curl "$BASE_URL/tasks/$TASK_ID/output" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### PUT `/tasks/:taskId/output`

Historical review reports remain immutable once persisted, including archived
Tasks with the retired review kind. Replacing one returns `409 Conflict` and
leaves the stored report unchanged. New writes using the retired kind are
refused with `unknown-kind`; session persistence and Run completion also refuse
that contract before writing output or advancing the Chain.

- Required path parameter: `taskId`.
- Required JSON fields: `kind`, `body`.
- Optional JSON fields: `fencingToken`, `metadata`, `commitSha`.
- On current Direct Steps, when `kind` is `revalidation`, `body` must be the canonical version-2
  revalidation object, including `schemaVersion`, `headSha`, `outcome`,
  `summary`, `changedReferences`, and a `route` object with one of the four
  tiers (`default`, `frontend`, `hard`, or `hazard`) and a non-empty reason.
  Version-1 bodies, missing routes, unknown tiers, and empty reasons are
  rejected; the output kind and body schema must agree. Retired Direct Chains
  from before judged implementation routing retain their version-1 contract
  without a route, selected by the persisted template generation. Their output
  preserves the implementation assignee. The same rule applies to session output.
- For a direct Chain's Route-less implementation Task with no Run, storing a
  valid version-2 revalidation output applies the selected staffing profile's tier slot
  to that Task in the same transaction. A Route line or explicit implementation
  `stepOverrides` assignee wins and is recorded as an override; an empty slot,
  an existing Run, or a missing Repo `GIT_WRITE` grant is recorded in the Task's
  activity and does not silently select another tier. Other output kinds retain
  their existing storage behavior.

```sh
curl -X PUT "$BASE_URL/tasks/$TASK_ID/output" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"report","body":"Checks passed."}'
```

### POST `/tasks/:taskId/merge-target`

- Required path parameter: `taskId`.
- Required JSON field: `prNumber` (positive integer).

```sh
curl -X POST "$BASE_URL/tasks/$TASK_ID/merge-target" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"prNumber":42}'
```

## Merge lease

### GET `/merge-lease`

- Required parameters: none.

```sh
curl "$BASE_URL/merge-lease" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

A merge Lease handed to a queued merge-integrator Run is released by that Run's
own completion whenever it ends without merging and leaves no ordinary retry
Run. The same path records the failure and settles its `HANDOFF_PENDING`
`MergeLeaseEvent` as `RELEASED`, with TaskActivity stating that the Run ended
without merging. An ordinary retry retains the Lease and transfers the durable
handoff to its successor Run. Recovery replays wait for the old release to
settle, then acquire a new Lease before their Run becomes claimable. If the
completion release fails, it records a deferred release for reconciliation; the
pending recovery waits until that release settles.

Operator-scoped and read-only; runner, merge-executor and session credentials
are refused with 403 before origin or the ledger is read. It runs
`scripts/merge-lease.sh status`, which writes nothing to
origin, and reads the merge Lease ledger. It never acquires, releases or steals:
breaking a lease is a human decision made at the script with
`scripts/merge-lease.sh steal --human --reason "..."`, which is also the only
way to skip the 45-minute machine threshold.

When `MERGE_TRAIN_WIDTH` is enabled, a train holder is the detached
`merge-train` Task. Merge readiness acquires that repository Lease before the
train Task is enqueued and keeps it through the train's record validation,
second-read checks, and authorization settlement. The Lease is released after
the last authorization or on every failure and abort path; merge executor's
publication is outside this window. A lost train Run or a Run without a stored
`merge-train-v1` record aborts the train, releases the Lease, and returns its
candidates to `ready` for a later tick.

Response fields:

- `checkedAt` — when the API finished reading origin. `ageSeconds` is measured
  from this same instant, so neither under-reports the time the read took.
- `holder` — the lease standing on `refs/merge-lease/holder`, or `null` when no
  lease is held. It carries `holder` (`user@host`), `task`, `reason`,
  `acquiredAt`, `ageSeconds` (whole seconds from `acquiredAt` to `checkedAt`,
  `null` when `acquiredAt` is not a time), and `sha` (the lease blob on origin).
  `task`, `reason` and `sha` may be `null`.
- `unavailable` — why the holder could not be read, or `null`. `holder` and
  `unavailable` are never both set; the ledger is still returned when origin
  could not be reached, because that history is what an operator needs when the
  remote is the broken part.
- `events` — the 20 most recent `MergeLeaseEvent` rows, newest first. `state` is
  one of `HANDOFF_PENDING`, `RELEASE_DEFERRED`, `CONTENDED`, `RELEASED`, or
  `INVALID`. A `CONTENDED` row is an observation rather than a lifecycle: a
  chain that could not take the lease for longer than
  `MERGE_LEASE_CONTENTION_ALERT_MINUTES` (default 30), recorded with the holder
  that was in the way in `failureDetail`, that holder's `acquiredAt`, and
  `settledAt` at the moment it was alerted. Each uninterrupted episode of
  contention is recorded and alerted once; a tick that takes the lease, cannot
  reach origin, or settles before reaching for the lease ends the episode, and
  the next contention starts a new window. Contention is never stolen
  automatically.

```json
{
  "checkedAt": "2026-09-06T12:00:00.000Z",
  "holder": {
    "holder": "runner@executor",
    "task": "chain-42",
    "reason": "chain merge tail chain-42",
    "acquiredAt": "2026-09-06T11:00:00.000Z",
    "ageSeconds": 3600,
    "sha": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c"
  },
  "unavailable": null,
  "events": []
}
```

### Readiness authorization and merge executor liveness

Every readiness tick reads `executorsBlockingAuthorization(daemons)`, whatever
its decision kind, against the runner ids in `MERGE_EXECUTOR_RUNNER_IDS` and
the same daemon liveness `GET /runners` reports. An authorization is written
only while at least one configured executor is `online`; the check is repeated
after Merge Lease acquisition, before the authorization is settled. If every
configured executor is offline, nothing is authorized. A single candidate
checked before acquisition takes no Merge Lease; a check after acquisition,
including train settlement, releases the held Lease.

An online observation closes an open per-Step executor-offline episode even
when that tick's decision is `skip` or another non-`authorize` result. The
worker records a TaskActivity naming the observation, and the close is fenced
by the readiness claim, so a tick that loses its claim cannot close the
episode. The exception stop path closes the episode under the same claim. When
an `authorize` decision is blocked because every configured executor is
offline, readiness settles as a requeue of itself, leaving the Regression
evidence and its Run untouched, and writes a TaskActivity on the readiness
task with `metadata.state =
"requeued-executor-offline"`, `metadata.reason = "merge-executor-offline"` and
the executor runner ids it checked. The next tick asks again.
An offline observation does not change the ordinary outcome of `skip` or
`defer` decisions.

The executor-offline requeue (`metadata.state = "requeued-executor-offline"`)
is its own settlement: it requeues only readiness, opens no new Run, and
spends neither the `leaseLossRefunds` cap nor a Regression repair budget.

The executor-offline wait is bounded by the 15 minutes after which the registry forgets a
daemon altogether, and it is measured per outage: the wait starts at the first
skipped authorization of the outage the chain is currently in, not at the first
one this task ever recorded. An outage ends when readiness observes it ending --
the next tick that finds an executor online, settles the Step some other way, or
stops at the ceiling -- and never merely because time passed between two skipped
authorizations, so `MERGE_READINESS_POLL_INTERVAL_MS` cannot lengthen or reset
the wait. An executor still offline at the ceiling stops the tail like any
other readiness stop: the Regression and readiness tasks move to `REVIEW`
with a `failureReason` naming `merge-executor-offline` and the runner ids. A
later readiness tick that observes an allowed executor online automatically
re-arms that ceiling stop: it returns readiness from `REVIEW` to `TODO` and
restores the parked Regression to `DONE` with its existing evidence,
records the exit as a TaskActivity, and closes the current `merge-readiness-stop:`
Inbox notice (and any legacy `merge-tail-stop:` notice). The worker on that same tick
follows the ordinary authorization path against the current base. The re-arm
itself opens no new Regression Run and never bypasses
the exact `(headSha, baseHeadSha)` check; existing base-drift requeue handling
applies if the base has moved.

As a manual fallback to automatic re-arm, an operator who will not wait for
the executor to return can call `POST /tasks/:taskId/retry` on the Regression
task (the readiness task has no Run to retry). That call opens a new
Regression Run at full rerun cost.

The operator's evidence-renewal path applies the same executor allowlist check
before writing its `purpose: "confirmation"` authorization. During an outage
it writes no authorization and defers with the same marker,
`metadata.state = "requeued-executor-offline"` and
`metadata.reason = "merge-executor-offline"`; renewal can proceed after a
later liveness observation finds an allowed executor online. Episode closure
remains owned by the readiness worker under its claim.

The separate Inbox process reads `GET /runners` before its decision transaction.
It requires `OPERATOR_TOKEN` and uses `RUNNER_API_URL` (default
`http://127.0.0.1:3000`), validated as an exact numeric IPv4 loopback HTTP
origin with an explicit port and no userinfo, path, query, or fragment.
`MERGE_EXECUTOR_API_URL` is not used by Inbox. Redirects are refused and the
request has a two-second timeout. Missing credentials, a refused destination,
HTTP errors, an unreachable API, and malformed responses are logged and refuse
renewal while leaving its card open. These unreadable observations carry
`observation: "unreadable"` and a diagnostic `cause` in the refusal TaskActivity
with state `requeued-executor-unobservable`; they do not open or close an outage
episode. An omitted reader similarly refuses with cause `no-reader`.

An empty allowlist is unchanged behaviour: with `MERGE_EXECUTOR_RUNNER_IDS`
unset no executor is named, the check is skipped, and readiness authorizes as
before. An executor that is offline stops new authorizations by itself; drain
by holding chains, not by stopping the executor.

### Readiness base-drift requeues

When a Regression PASS was valid for its exact `(headSha, baseHeadSha)` and the
control plane's remote read finds that the default branch moved before
authorization, readiness returns the candidate to Regression and grants the
replacement Run. This readiness base-drift requeue does not increment
`leaseLossRefunds`: the agent did not lose its Run lease, and the requeue is
bounded independently. This exemption applies only to `base-advanced` and
`train-base-stale`. Readiness requeues for `stale-head` or `ancestry-refused`
still spend the shared three-refund cap, as do lease-loss, late-salvage, and
other ordinary merge-tail replacement births; completed-repair grants remain
the existing separate exemption. Provider-transport and Regression target-fetch
failures remain on `EXTERNAL_FAILURE_REFUND_CAP`.

Outside a base-drift recovery, the readiness task has a fixed ceiling of three
requeues, `READINESS_BASE_DRIFT_REQUEUE_LIMIT`. This is a platform constant,
not an environment setting. When the ceiling is reached, readiness makes no
further Run birth, parks the Regression and readiness tasks in `REVIEW`, and
records the named stop reason
`readiness-base-drift-requeue-limit: <count> requeues reached ceiling <limit>`.
Only base-drift requeues outside a recovery spend this standalone ceiling;
other requeue classes and requeues belonging to past recovery attempts do not.

Inside a base-drift recovery, the requeues use the recovery aggregate's
existing `MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES` ceiling of two instead of the
per-readiness-task ceiling. Once it is reached, readiness parks the recovery
tail (including its integrator) and records
`base-drift-recovery-requeue-limit: <count> requeues reached ceiling <limit>`;
the aggregate is `BLOCKED_DOWNSTREAM` and the tail tasks are in `REVIEW`.

## Inbox

### GET `/inbox/messages`

- Required parameters: none.
- Optional query parameter: `projectId`.
- With `projectId`, the list includes messages whose Agent, Task, Goal, or
  Session belongs to that Project, plus global messages whose
  `agentId`, `taskId`, `goalId`, and `sessionId` are all `null` (including
  history whose nullable relation was removed; all four relation ids are
  `null` for these global rows). It retains top-level-message
  behavior. With no `projectId`, the list remains unfiltered by Project.
- Each Inbox message object includes the server-computed boolean
  `acceptsFreeText`; the single-message route below returns the same field.
  It is `true` only for an open agent-authored `TEXT` or `MULTIPLE_CHOICE`
  question with a session waiting on it, and for an open approval-gate card.
  It is `false` for stop questions, closed or answered cards, human replies,
  and detached notifications. Clients should use this field rather than
  re-deriving the rule.

```sh
curl "$BASE_URL/inbox/messages?projectId=$PROJECT_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/inbox/messages/summary`

- Required parameters: none.
- Optional query parameter: `projectId`.
- With `projectId`, the summary applies its existing open, top-level,
  needs-reply rule to the same Project-plus-global scope as the list: a
  related Agent, Task, Goal, or Session belongs to that Project, or all four
  relation ids are `null`. With no `projectId`, it remains unfiltered by
  Project. The response is `{ "needsReply": number }`.

```sh
curl "$BASE_URL/inbox/messages/summary" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/inbox/messages/:messageId`

- Required path parameter: `messageId`.

```sh
curl "$BASE_URL/inbox/messages/$MESSAGE_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/inbox/messages/:messageId/decision`

- Required path parameter: `messageId`.
- Required JSON fields: `decision`, `requestId`.
- Optional JSON field: `note` (a string trimmed by the API; when supplied it
  must contain 1–8000 characters after trimming).
- For an approval-gate card, `decision` must be exactly `approve` or `reject`.
  A supplied `note` is stored on the human reply and in the task activity for
  the gate outcome; on rejection it is also passed to the requeued step as
  operator feedback. The note never changes the recorded decision.
- Supplying `note` for a non-gate card returns `400 Bad Request` with a named
  refusal reason; submit free text for those cards through `/reply` instead.
  Blank or overlong notes likewise return `400 Bad Request` rather than being
  silently discarded.

```sh
curl -X POST "$BASE_URL/inbox/messages/$MESSAGE_ID/decision" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"decision":"approve","requestId":"decision-001"}'
```

An approval rejection can include operator feedback in the same request:

```sh
curl -X POST "$BASE_URL/inbox/messages/$MESSAGE_ID/decision" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"decision":"reject","note":"Refresh the error handling before resubmitting.","requestId":"decision-002"}'
```

### POST `/inbox/messages/:messageId/reply`

- Required path parameter: `messageId`.
- Required JSON fields: `body`, `requestId`.

```sh
curl -X POST "$BASE_URL/inbox/messages/$MESSAGE_ID/reply" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"body":"Use the existing deployment target.","requestId":"reply-001"}'
```

### POST `/inbox/messages/:messageId/close`

- Required path parameter: `messageId`.
- Required JSON field: `requestId`.

```sh
curl -X POST "$BASE_URL/inbox/messages/$MESSAGE_ID/close" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"close-001"}'
```

## Sessions and runs

The operator can list and inspect sessions, cancel runs, and page through run
events. The `/session/runs/...` routes used by an authenticated live agent
session and the `/runner/...` machine protocol are intentionally not listed:
the authentication middleware denies those prefixes to the operator principal.
The two revalidation routes below are session-only capabilities; they are
listed here so their authorization boundary is explicit even though operators
cannot call them directly. Authorization is keyed on the template step, not on
the executing Agent: the caller must be the live Run of the bound direct
chain's revalidation step (`direct-engineer-workflow` step 1, output kind
`revalidation`), whichever Agent a staffing profile put there.

The machine-only `/session/runs/:runId/status` projection is run-bound and is
not an operator read route. Its `task.outputEvidence` is the server's decided
answer about this Run's deliverables, and the runner reads it rather than
re-deciding anything. It has two parts.

`outputEvidence.satisfaction` names whether the deliverable this Run's Step
requires exists: `delivered` (this Run persisted it; carries the output `kind`
and `commitSha`), `not-required`, `satisfied-by-prior-run` (an immutable
findings artifact an earlier Run authored, which this Run may not replace), or
`absent` (with the required `outputKind` and whether asking the agent again can
still produce it).

`outputEvidence.prHandoff` names the canonical PR handoff this delivery may
publish: `not-a-pr-delivery`, `complete` with the ordered `outputs`, or
`incomplete` with the reason it was refused. Each entry contains the Task id,
chain index, output kind, body, and commit SHA, and is accepted only when its
`projectId` and `chainId` match the claimed Run. The implementation delivery
receives only its current `implementation` entry; the final delivery receives
exactly `implementation`, `review-findings`, `blind-findings`, and
`fixed-implementation`, in chain order. Malformed, foreign-chain, out-of-order
or missing evidence makes the handoff `incomplete` rather than being silently
omitted or guessed, and delivery fails instead of publishing. This projection
does not widen prompt `priorOutputs`, expose sibling evidence to a blind
review, or derive text from provider output, activity prose, or repository
contents. Its source is persisted task output and its authentication is the
claimed session/run identity.

Output kinds name Step deliverables, not execution models. Execution uses
`review-findings`; `sol-findings` is no longer accepted for Step roles, repair
evidence, or PR handoff. Historical Chains retain that original kind: Task
detail reads (`GET /tasks/:id`), outputs, and report text return it verbatim.
Template adoption and rollover still upgrade older installations. Changing the
assigned Agent or its model never renames a Step output or rewrites an
immutable report.

The machine-only `POST /runner/runs/:runId/events` append is bounded on both
sides, and the two bounds are designed against each other. The API reads at most
1 MiB + 64 KiB of request body — the batch cap plus envelope allowance — and
refuses a larger one with `413` and `code: "EVENTS_REQUEST_TOO_LARGE"` before
parsing it. It then refuses any single event whose `payload` exceeds 256 KiB of
JSON with `413`, `code: "EVENT_PAYLOAD_TOO_LARGE"`, and the `eventIndex`, `seq`,
`payloadBytes` and `limitBytes` of the offending event. The index is the point:
the runner removes events from its queue only once they are accepted, so a
batch-wide refusal would leave an unacceptable event at the head of an ordered
queue forever, while a named one costs exactly that event. On receiving it the
runner drops that event, records an `EVENT_REJECTED` event in its place, and
resends the rest of the batch. A `413` that names *no* index cannot be resolved
by losing one event, so the runner answers it by sending less: it halves its
batch budget for the rest of the Run and retries, down to a floor of one event,
and only then drops that single event as impossible. That keeps an intermediary
with a smaller body limit, or a peer carrying the previous cap, from wedging a
queue that only advances on success. `providerConversationId` is capped at 512
characters, refused with `400` above it and never sent above it, because it is
the one envelope field a provider grows and the body cap is sized as the batch
cap plus a fixed envelope allowance.

A runner does not normally reach either refusal. It truncates any payload above
the same 256 KiB cap itself, replacing it with `{ truncated: true,
originalBytes, limitBytes, preview }`, and forms batches by bytes as well as by
count (at most 250 events or 1 MiB). Both caps live in
`@anneal/db/session-event-limits`, so the two processes cannot be sized against
stale copies of each other; a 413 in practice means a rolling deployment in
which the two sides disagree.

The runner's undelivered queue for one Run is bounded at 32 MiB and 20 000
events. When it is full the queue drops the oldest liveness events —
`MODEL_DELTA`, `PROVIDER_RAW`, `PROVIDER_STATUS`, `STDERR`, `TOOL_PROGRESS` and
`TOOL_COMPLETED` — and records one `EVENTS_DROPPED` event carrying the count,
bytes, and sequence range lost. Tool output is droppable because a tool result
carries a file read or a command's stdout and is the largest event a Run
produces. Lifecycle, terminal and error events — including `TOOL_STARTED`,
`TOOL_FAILED`, `ADAPTER_ERROR` and `FINAL_OUTPUT` — survive while anything else
can be given up, and are never dropped. They are not exempt from the bound
either, because a provider drives some of them too — one `ADAPTER_ERROR` per
unparsable line, a `TOOL_STARTED` per call. A queue with nothing droppable left
reduces the oldest of them to a `{ truncated: true, reason: "queue-bound",
originalBytes, queueMaxBytes }` marker — distinct from the per-event cap's
marker above, which names the cap it hit — keeping its sequence number, type and
time, at about a hundred bytes an event instead of the 256 KiB cap a payload may
reach. `providerEventId` and `toolCallId` go with the payload: they are detail
too, and no cap covers what a provider puts in them. Once every entry not in
flight is such a marker, the two oldest adjacent markers merge into one
`EVENTS_COALESCED` event carrying their summed counts and the inclusive sequence
range they span, plus the `droppedEvents` and `rejectedEvents` totals of any
`EVENTS_DROPPED` or `EVENT_REJECTED` record absorbed, whose losses are in no
other event. Merging repeats until both bounds hold again, and the record of a
drop is opened inside that accounting rather than appended past it. So the
queue holds its bounds under any traffic mix, and what a protected event gives
up under pressure is its detail, never its account: each one is still counted,
in aggregate, in a marker the control plane receives. The batch in flight is the
one exemption — it is never dropped from, never merged, and never released by
position, so a provider streaming during an append cannot cost an event that the
request did not carry, and the bound it suspends holds again as soon as the
request settles. Each heartbeat carries the
current queue size as `eventQueueBytes`; the field is observability only and the
API neither acts on it nor persists it.

The machine-only `POST /runner/runs/:runId/complete` completion payload and
`POST /runner/runs/:runId/cancel/acknowledge` cancellation acknowledgement
accept the optional `worktreeContainmentViolations` array: absolute worktree
paths registered by the Run's checkout that lie outside its run workspace. The
field is report-only; omitted or empty means no observation and never changes
the Run outcome. A late cancellation acknowledgement backfills this evidence
when reconciliation terminalized the Run first.

That completion payload also accepts the optional `salvageParentSha`: the first
parent of the WIP salvage commit a failed Run pushed, which `headSha` names. It
is persisted on the Run and handed, with the salvage commit itself, to the next
Run of the same task as the `salvage` member of its claim's
`previousRunHandoff`, so a step bound to a particular head can recognise the
salvaged work of its own prior attempt. Claim evidence follows the prior same-task
publication matching the Run's resolved target ref, including when an intervening
Run was cancelled without publishing. A different target ref does not receive
that salvage evidence. Runs that did not salvage omit `salvageParentSha`.

Before a review or fix candidate is claimed, the control plane re-reads the
specification from the repository. A read that fails transiently defers the
queued Run at 15s, 30s, then 60s instead of failing it, and the deferral window
depends on what failed. A window whose every failure was a per-attempt deadline
hit — a read that is slow, not broken — is extended to a ceiling of 1800000ms
(30 minutes); any other transient failure in the window keeps the ordinary
budget of 300000ms (5 minutes) and its `spec-transcription-unreadable` parking
reason, whose message names the window the episode actually ran alongside that
budget. Only a per-attempt deadline that this read observed counts as a deadline
hit; an abort raised by the repository reader itself is an ordinary transient.
The first deferral that outlives the 5-minute budget opens exactly one
deduplicated Inbox notice per Task, and none of the later ones do. That notice
is deduplicated for the Task's lifetime and is never reopened, so a Task that
meets this condition again after an operator retry raises no second notice;
parking still announces itself once per Run. At the
30-minute ceiling the Task is parked in Backlog with the distinct reason
`spec-read-deadline-exceeded`, whose message names the deadline, the number of
deferred attempts, and the elapsed window rather than reporting the
specification as unreadable. Both ceilings are source constants, not
configuration.

The machine-only `POST /runner/tasks/claim` request may include the optional
`servedKinds` array of exact `RunnerKind` names. Omitting `servedKinds` means
the runner serves every kind; when it is declared, the control plane offers
that claim agent Runs only for the listed kinds. Mechanical claims are
unaffected, and an unknown kind is refused with `400 Bad Request`.

While a dispatch drain is in force, `POST /runner/tasks/claim` refuses only a
candidate agent Run whose template Step would start an agent session. The
refusal is `409 Conflict`, with code and reason `dispatch-draining`, and carries
the drain's `expiresAt`. The scope is decided from the Run's persisted template
Step kind, not from runner identity: an `implementation` or other agent Step
is refused, while mechanical merge execution (`merge-result`) and readiness
evaluation (`merge-authorization`) remain admitted. The deploy barrier is the
exclusive half that protects the release once deployment starts. An already
claimed Run is never interrupted. A refused claim creates no session, claims
no Run, parks no Task, and consumes neither `maxSessionsPerTask` nor any
transient budget, so a runner that keeps polling through the drain loses only
the poll. Drain refusal precedes repository-grant handling, so a revoked Repo
grant cannot cause a drained agent claim to park its Task. The claim still
records the runner's telemetry, so `GET /runners` reports it online throughout. A drain whose `expiresAt` has passed is treated
as absent and admits claims again.

The machine-only `POST /runner/tasks/claim` request used by the merge executor
also carries the required `contractVersion` field. It is the completion
contract version exported by `@anneal/db`; the mechanical executor and API
must agree on this value. A mechanical claim with an omitted or mismatched
`contractVersion` is refused with `409 Conflict`, code
`mechanical_contract_mismatch`, and a message naming both the executor's
version and the API's version. The refusal claims or creates no Run and writes
one TaskActivity on the Task that would have been claimed, recording both
versions so the board shows why the step did not move. This version check is
fail-closed; ordinary agent claims are unaffected. The refusal also opens one
deduplicated operator Inbox alert per API/executor version pair while that
pair remains mismatched. Its body starts with `merge executor completion
contract mismatch:` and names the executor version, API version, and refused
Task. A later matching mechanical claim closes all open mismatch alerts.

### GET `/sessions`

- Required parameters: none.
- Optional scope: `projectId`, `limit` (1–200, default `50`), and `before` (an
  ISO date cursor, exclusive, on `requestedAt`).
- Optional filters: `status`, `agentId`, `runner`, `taskId`, `chainId`,
  `since`, `until`, and `q`.

Every named filter narrows the list further: the filters combine with each
other, with `projectId`, and with the `before` cursor by AND, and `limit` still
caps the page. `since` and `until` are ISO timestamps read against
`requestedAt`, inclusive at both ends, and share that column with the cursor.
`agentId`, `taskId` and `chainId` are exact ids; `chainId` matches the chain of
the session's Task. `runner` is an exact `RunnerKind`.

`status` is a lifecycle bucket, not a persisted execution status. It accepts
`live` (`REQUESTED`, `PROVISIONING`, `RUNNING`, `WAITING_INBOX`), `done`
(`SUCCEEDED`), `failed` (`FAILED`, `TIMED_OUT`, `LOST`), and `cancelled`
(`CANCELLED`). Every execution status belongs to exactly one bucket.

`q` is a case-insensitive substring search over human-authored text only: the
Task name, the Run branch, and the session's `failureReason`. A row matching
any of the three is returned. It never searches ids or event payloads, so an id
is addressed through `taskId`, `chainId` or `agentId` rather than through `q`. `%`, `_`, and backslash are matched literally.

`since` and `until` require a valid ISO calendar timestamp with time and a
`Z` or numeric timezone offset; parseable prose and overflowing dates refuse.

A request naming no filter answers exactly what it answered before the filters
existed. A present-but-unusable filter is refused rather than ignored, so a
narrowed list never silently widens; a present-but-empty value (`status=`) is
unusable for the same reason. Each refusal is `400 Bad Request` with a body
carrying `error` and `code`: `session-filter-status-invalid`,
`session-filter-agent-id-invalid`, `session-filter-runner-invalid`,
`session-filter-task-id-invalid`, `session-filter-chain-id-invalid`,
`session-filter-since-invalid`, `session-filter-until-invalid`, and
`session-filter-q-invalid`. An unparseable `before` remains tolerated: the
cursor is dropped, and the request is not refused.

Each returned session carries its Task as `{ id, name, chainId, chainName }`.
`chainId` is the persisted chain and is what `chainId` filters on; `chainName`
is display-only and is `null` whenever the returned rows cannot prove a name.

```sh
curl "$BASE_URL/sessions?projectId=$PROJECT_ID&status=failed&runner=CODEX&since=2026-08-01T00:00:00Z&q=gate&limit=50" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/sessions/:sessionId`

- Required path parameter: `sessionId`.
- The returned session carries `metrics` for its Run. It has the same shape
  and null semantics as the per-Run `metrics` documented under
  [GET `/tasks/:taskId`](#get-taskstaskid), including `ttft` and `vsBaseline`; see that definition for
  the field meanings. The response also carries the same task-level `baseline`
  used by that definition so the shared diagnostics block can show its
  percentiles. The `/sessions` list does not compute or return these derived
  fields.

```sh
curl "$BASE_URL/sessions/$SESSION_ID" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### POST `/runs/:runId/cancel`

- Required path parameter: `runId`.
- Required JSON fields: `requestId`, `reason`.
- Optional JSON field: `parkTask` (default `false`).

```sh
curl -X POST "$BASE_URL/runs/$RUN_ID/cancel" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"cancel-001","reason":"Operator requested stop","parkTask":true}'
```

### PATCH `/session/runs/:runId/task`

- Session bearer authentication must name the same `runId` as the path.
- Required JSON fields: `fencingToken`, `description`.
- Only the bound chain's revalidation-step Run may call this route, whichever
  Agent staffs that step. The implementation task is derived server-side; no
  task ID or chain ID is accepted. The fenced write replaces the brief while
  preserving the platform-authored prompt and output instructions. The server rejects changes
  to Goal, Changes-item intent, Out of scope, Constraints, Acceptance, Route,
  or the section structure; only Background and code-shaped descriptive
  references inside Changes may drift with the tree.

### POST `/session/runs/:runId/revalidation/cancel`

- Session bearer authentication must name the same `runId` as the path.
- Required JSON field: `fencingToken`.
- Only the bound chain's revalidation-step Run may call this route, whichever
  Agent staffs that step, and only after the same Run's premise-collapse Inbox
  question has an answered `cancel-chain` decision. It records cancellation
  intent for the current Run, parks every unfinished task in the bound chain,
  and revokes the session token; the owning runner then performs provider
  cleanup and terminalization. A retry
  with the same session token and fencing token replays the committed result
  without repeating chain or activity mutations; the revoked token remains
  unauthorized for every other session route.

### GET `/runs/:runId/events`

- Required path parameter: `runId`.
- Optional query: `afterSeq` and `limit` (1–2000, default `500`).

```sh
curl "$BASE_URL/runs/$RUN_ID/events?afterSeq=0&limit=500" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### Run failure classes and retries

The API classifies the runner's failure envelope by phase. `EXECUTE` is the
agent's own process: its existing termination, exit and provider-text rules
decide the failure class. `PROVISION`, `DELIVER` and `COMPLETE` are the runner's
plumbing and default to `TRANSIENT_PROVIDER`, retryable and external, even
when the transport error's wording is unknown. Deterministic refusals take
precedence: authentication failures, 401/403 and permission denial produce
`AUTH_REQUIRED` with no automatic retry. The existing `BUDGET_EXCEEDED`,
`NO_CHANGES_PRODUCED` and missing dependency-provisioning manifest refusals
also retain their handling. Exit code 127 remains `BINARY_NOT_FOUND` in every
phase, with no automatic retry. Other advisory `runnerClass` values do not decide
the API's verdict.

Plumbing transient failures receive an attempt refund under
`EXTERNAL_FAILURE_REFUND_CAP`; automatic retry remains bounded by the resulting
`maxRunsPerTask`. No new refund counter or configuration is involved.

During `DELIVER`, the branch-push loop retries any failure except a
deterministic access refusal, using its existing backoff, attempt limit and
Lease-bounded deadline. Each retry re-pushes the same commit without starting
another agent session. If that local retry budget is exhausted, the runner
reports the delivery failure to the API, which applies the classification,
refund and retry-Run rules above. An API-level retry starts the Step again.
This includes Regression: even with a persisted PASS or gate-fail verdict,
a transient delivery failure queues another Run that reruns the merge gate,
under the same caps. A durable verdict alone does not advance a failed Run.

### Task spend cap

`Task.spendCap` is a per-task limit in USD, or `null` for no limit. It is
enforced at the single place a Run comes into existence, so every intent that
would queue a new attempt — an operator retry, a chain enqueue, a merge-tail
requeue or repair, a claim-invalidation replacement, and both automatic
after-completion and after-lease-loss retries — is measured against it. When
the cap is set and the task's accumulated spend is at or above it, no Run is
opened: the Task moves to `REVIEW` with a `failureReason` beginning
`Spend cap $<cap> reached`, and a TaskActivity carrying
`metadata.refusal = "spend-cap-exhausted"` alongside the `spendCapUsd` and
`spentUsd` the refusal measured. That park is the caller's write and
is made on a path that commits, so it survives on every intent above: the
callers that raise other Run-birth refusals out of their transaction park this
one instead, because rolling it back would delete the record naming the cap the
operator has to raise. Callers surface the refusal as a `409 Conflict`. Recover
by raising or clearing `spendCap` through `PATCH /tasks/:taskId` and calling
`POST /tasks/:taskId/retry`; the retry is measured against the new value.

The cap, the total and every rendering of either are money with cents
(`$1.00`, not `$1`) — the `failureReason`, the activity's `spendCapUsd` and
`spentUsd` metadata, the board's `spendCapUsage`, and the operator activity a
cap edit leaves, all from one formatter beside the basis below.

The cost basis is defined once, in `packages/db/src/spend-cap.ts`:

- Every Run of the task counts, priced the same way `taskCost` is: the
  provider-reported `Session.costUsd` when there is one, otherwise the
  read-time token estimate at the Run's own model.
- The currency is USD. Nothing in the platform converts currencies.
- A Run whose cost was never captured contributes nothing. A missing amount is
  unknown, not large, and charging a guess would refuse attempts nobody paid
  for.
- An in-flight Run counts as soon as its cost is reported. Session usage is
  written while the Run executes and at its end, so whatever has been reported
  by the moment the next attempt is decided is included. A cap therefore stops
  the attempt *after* the one that crossed it, never the one that is running.
- The comparison is `spent >= cap`: reaching the cap exactly leaves nothing for
  another attempt. A cap of `0` refuses every attempt.
- `Task.spendCapApplicable` is not part of the decision: a cap is in force
  whenever it is set. That column, and `Run.spendCap` and
  `Run.spendCapApplicable` beside it, are written by nothing an operator can
  reach and read by nothing; they are dead and can be dropped by a change that
  owns the migration.

`GET /tasks?view=board` projects `spendCapUsage`, and `GET /tasks/:taskId`
returns `spendCap` beside `taskCost`, so the limit is never displayed without
the number it is measured against.

### Lost-Run reconciliation

When lease reconciliation loses a mechanical Run, a durable completion-rejection
TaskActivity for that exact Run makes the loss terminal: automatic retry is
refused, the Run's `failureReason` includes the rejection's HTTP status and
response body, and the Task moves to `REVIEW` with an activity stating that the
completion was rejected and operator action is required. The lost-lease budget
refund is preserved. After fixing the cause of the rejected completion, recover
by calling `POST /tasks/:taskId/retry`; the new Run does not require increasing
`maxSessionsPerTask`. Mechanical Runs without that rejection record and agent
Runs continue through the normal lost-Run retry path.

#### Lease-loss retry refused

That retry path is bounded and spaced. Each lost lease refunds the attempt it
cost, and each refund raises the ceiling it is measured against, so the run
budget alone can never end a pure lease-loss sequence. A task may therefore have
at most three attempts refunded this way — counted on the Run as
`leaseLossRefunds`, projected on the board card of the same name, and shared
with the other platform-caused refunds: a late-salvage claim invalidation and
ordinary merge-tail replacement births, excluding `repairCompleted` completed-
repair grants. A readiness base-drift requeue is exempt only for the
`base-advanced` and `train-base-stale` conditions, when a Regression PASS was
valid at its exact base; see [Readiness base-drift requeues](#readiness-base-drift-requeues).
Provider-transport and Regression target-fetch failures use the separate
`EXTERNAL_FAILURE_REFUND_CAP` and do not spend `leaseLossRefunds`. Each
replacement created by this lease-loss path is queued with the completion
path's exponential delay derived from that count (30s, then 60s, then 120s)
rather than immediately, so a runner host that is down is given time to come
back.

At the bound nothing is requeued: the Task moves to `REVIEW` with
`failureReason` beginning `Lease-loss retry refused: Lease-loss refunds
exhausted`, an Inbox message, and a TaskActivity carrying
`metadata.refusal = "lease-loss-refunds-exhausted"`. The refused refund is not
granted, so the Task's recorded budget is what it was before the loss. Recover
by raising `maxSessionsPerTask` through `PATCH /tasks/:taskId` and calling
`POST /tasks/:taskId/retry`. When the refused task is a Chain Regression task,
that operator retry resets its `leaseLossRefunds` to `0` and records a
TaskActivity naming the reset in the same retry transaction; this is the
recovery for the documented lease-loss refusal. The retry is not itself a
platform refund, and a later lease loss on the retried Run is measured against
the fresh cap. A late-salvage claim invalidation at the bound behaves the same:
the stale claim is still revoked, because its clone base is wrong, but nothing
replaces it and the Task is parked with the same reason.

Readiness base-drift requeues have their own ceilings and stop reasons; they do
not park by exhausting this shared lease-loss bound. Ordinary merge-tail births
still spend `leaseLossRefunds`, except for `repairCompleted` grants and the two
readiness base-drift conditions in
[Readiness base-drift requeues](#readiness-base-drift-requeues).
The refund reason is preserved even when the ordinary run budget is also
exhausted.
