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
  `code-reviewer-opus-high`, and `senior-dev-astra-low`) bound to that Environment, and
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
  and an unpriced-run count. The `unassigned` role is used when persisted step
  metadata cannot classify priced spend. Unknown cache splits are counted and
  excluded from cache metrics; unpriced chain runs never receive a fabricated
  cost.

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
  chain root's activity metadata records `staffingProfileId` and
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
- One predecessor task accepts several bound successor chains: binding a
  second chain to a predecessor that already has one is accepted, and the
  predecessor records one `Chain <id> bound to predecessor <name>` activity per
  binding. The binding stays one-way and one hop deep. An `afterTaskId` binding
  is released only by `DELETE /tasks/:taskId/chain` on that bound chain, which
  leaves the predecessor's other successors bound; archiving a bound chain does
  not release it.

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
Agent that is being archived in a concurrent transaction. Repository grants are
*not* checked here: a profile is a plan, and a grant is checked when a chain is
actually created.

Validation refusals, in the order they are applied per entry:
`staffing_profile_entry_duplicate` (the same output kind twice in one request),
`staffing_profile_unknown_output_kind` (the template has no step producing it),
`staffing_profile_include_not_optional` (an include flag on a step the template
does not mark optional), `staffing_profile_step_not_agent` (staffing a `HUMAN`
step), `staffing_profile_step_control_plane` (staffing a step whose
`executionOwner` is `control-plane`, which the control plane runs and no Agent
executes; the message names the step to remove, and an entry with
`assigneeAgentId: null` for it stays allowed),
`staffing_profile_agent_not_found` (no such Agent in this project),
`staffing_profile_agent_archived`, `staffing_profile_integrator_binding` (the
merge-execution step binds only `merge-integrator`, and `merge-integrator` binds
nothing else), and `staffing_profile_compound_implementation` (the compound
implementation root requires an assignee whose effective runner is Codex and
whose model is a `gpt-*` one). `staffing_profile_step_control_plane` returns `400 Bad Request` with the same
`{ error, code, outputKind }` body shape as `staffing_profile_step_not_agent`.
The other eight return `422 Unprocessable Content`.

A profile saved before `staffing_profile_step_control_plane` existed is not
migrated: it keeps its stored entry until the next write, which is refused with
that code naming the step to remove. Reset writes the canonical plan, which
states no assignee for a control-plane step.

Warnings do not block a write. `same_agent_implements_and_reviews` reports that
one Agent both implements and reviews under the saved plan.

### GET `/projects/:projectId/task-templates/:templateId/staffing-profiles`

- Required path parameters: `projectId`, `templateId`.
- Returns `200 OK` with the template's profiles, the default first and the rest
  by name, each with its ordered `entries`.
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
- Optional JSON field: `isDefault`. The first profile of a template is always
  its default regardless of this field; setting it on a later profile clears
  the previous default in the same transaction.
- Returns `201 Created` with `{ "profile": <profile>, "warnings": [...] }`.
- Refusals: `404 Not Found` with code `staffing_profile_template_not_found`;
  `409 Conflict` with code `staffing_profile_name_taken` when the template
  already has a profile with that name; and the `400` and `422` validation codes above.

```sh
curl -X POST "$BASE_URL/projects/$PROJECT_ID/task-templates/$TEMPLATE_ID/staffing-profiles" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Fast lane","entries":[{"outputKind":"implementation","assigneeAgentId":"'$AGENT_ID'"},{"outputKind":"blind-findings","include":false}]}'
```

### PUT `/staffing-profiles/:profileId`

- Required path parameter: `profileId`.
- Required JSON fields: `name` and `entries`. The entry list replaces the
  stored one whole; an omitted output kind loses its opinion rather than
  keeping the previous one, except that every optional step of the template is
  still stored with a boolean `include`, defaulting to `true`.
- Default membership is not part of this body; `PATCH` owns that transition.
- Returns `200 OK` with `{ "profile": <profile>, "warnings": [...] }`.
- Refusals: `404 Not Found` with code `staffing_profile_not_found`;
  `409 Conflict` with code `staffing_profile_name_taken`; and the `400` and `422`
  validation codes above.

```sh
curl -X PUT "$BASE_URL/staffing-profiles/$PROFILE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Fast lane","entries":[{"outputKind":"implementation","assigneeAgentId":"'$AGENT_ID'"}]}'
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
- Replaces the profile's entries with the template's canonical plan: every
  step's own `assigneeAgentId`, and every optional step included.
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

### GET `/tasks`

- Required parameters: none.
- Optional query: `projectId`; `archived` (`false`, `true`, or `all`, default
  `false`); `view` (`full` or `board`, default `full`); `enrich` (`true` or
  `false`, default `true`).

The `board` view is a compact card projection. It includes `createdAt` for
stable queue ordering, `assigneeType` so a human-owned task can be
distinguished from an agent task whose agent assignment is missing, and
`budgetRemaining`, the same run-budget verdict `GET /tasks/:taskId` and
`GET /tasks/:taskId/startability` report.
For a Chain member, the first emitted member also carries the
`chainAggregate` projection. Its `activation.state` is one of
`parked-unactivated`, `waiting-on-predecessor`, `running`, `idle`, `held`, or
`settled`; `held` is a derived aggregate state, not a persisted Task status.
The aggregate's `activation.hold` is either `null` or
`{heldLayer, heldAt, holdReason}`, where `heldLayer` is the dense one-based
ordinal of the highest execution layer admitted when the Chain was held (or
`0` before the first layer), `heldAt` is an ISO timestamp, and
`holdReason` is the optional operator reason. It is non-null whenever the
Chain's persisted `ChainControl.state` is `HELD`.

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
  raise `maxSessionsPerTask` through `PATCH /tasks/:taskId` to lift it.
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
  - `metrics.termination` carries the Session's own account of how the run
    ended: `reason`, `exitCode` and `signal`.

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
  detached repair task assigned to the Chain's fixed-implementation agent,
  writes the corresponding `repairAttempt` marker, transitions the aggregate
  to `REPAIRING`, clears `failureReason`, and records the operator activity on
  the regression task. It never writes a `repairResult`; the genuine repair
  completion does that.
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
  - `merge_tail_repair_unstaffed`: the Chain has no fixed-implementation step or that step staffs no Agent,
    so no Agent it staffed owns this repair. Nothing is substituted for the
    missing step.
  - `merge_tail_repair_creation_failed`: the fixed-implementation agent is
    unavailable, lacks the repository grant, or the detached repair task cannot
    resolve the Chain repository, position, and shared branch.

```sh
curl -X POST "$BASE_URL/tasks/$REGRESSION_TASK_ID/merge-tail/repair" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"requestId":"reenter-recovery-repair-001","reason":"Fix the regression found during base-drift recovery"}'
```

### Recovering a merge tail stopped after its repair budget

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

#### Re-entering after a base-drift recovery FAIL

If a semantic (`review-fail`) or merge-gate (`gate-fail`) regression FAIL
occurs inside base-drift recovery, the merge tail is parked in
`BLOCKED_DOWNSTREAM` with the recovery attempt's `recoveryRunId`. After
confirming the failing output and stop notice, call
`POST /tasks/:taskId/merge-tail/repair` on the regression task before
considering a successor Chain. The route re-enters the ordinary `review-fix`
or `gate-fix` round against the recorded head and base, charges the Chain's
existing repair budget, and moves the aggregate to `REPAIRING`. Once that
repair genuinely completes, the regression is rerun with the recovery context:
a PASS proceeds to `awaitAuthorization`; another FAIL parks the tail in
`BLOCKED_DOWNSTREAM` again and can be re-entered with this route while budget
remains. A refresh-conflict verdict keeps its existing recovery stop and is
not re-entered by this route.

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

- Required path parameter: `taskId`.
- Required JSON: at least one task field, `status`, or `failureReason`.
  Patchable task fields are `name`, `description`, `workingDirectory`, `repoId`,
  `targetBranch`, `assigneeType`, `assigneeAgentId`, `approvalGate`,
  `opensPullRequest`, `maxDurationMin`, `stallTimeoutMin`,
  `maxSessionsPerTask`, `scheduleKind`, `runAt`, `cron`, and `timezone`.
  `status` is a task status (`BACKLOG`, `TODO`, `DOING`, `REVIEW`, `DONE`);
  `failureReason` may be `null`.
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
- A `maxSessionsPerTask` or `description` change is recorded as an operator
  TaskActivity naming the budget's previous and new value, or stating that the
  prompt was edited. The prompt text itself is not copied into the activity.
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

- Required path parameter: `taskId`.
- Required JSON fields: `kind`, `body`.
- Optional JSON fields: `fencingToken`, `metadata`, `commitSha`.

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
exactly `implementation`, `sol-findings`, `blind-findings`, and
`fixed-implementation`, in chain order. Malformed, foreign-chain, out-of-order
or missing evidence makes the handoff `incomplete` rather than being silently
omitted or guessed, and delivery fails instead of publishing. This projection
does not widen prompt `priorOutputs`, expose sibling evidence to a blind
review, or derive text from provider output, activity prose, or repository
contents. Its source is persisted task output and its authentication is the
claimed session/run identity.
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

The machine-only `POST /runner/tasks/claim` request may include the optional
`servedKinds` array of exact `RunnerKind` names. Omitting `servedKinds` means
the runner serves every kind; when it is declared, the control plane offers
that claim agent Runs only for the listed kinds. Mechanical claims are
unaffected, and an unknown kind is refused with `400 Bad Request`.

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
- Optional query: `projectId`, `limit` (1–200, default `50`), and `before` (an
  ISO date cursor).

```sh
curl "$BASE_URL/sessions?projectId=$PROJECT_ID&limit=50" -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### GET `/sessions/:sessionId`

- Required path parameter: `sessionId`.

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
