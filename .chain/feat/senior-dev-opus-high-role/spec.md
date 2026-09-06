Agents: senior-dev-opus-high is a canonical role and the brief template lists both Opus high routes

The senior developer role exists at Claude Opus 5 high as a canonical Agent installed by deploy sync, and docs/BRIEF-TEMPLATE.md names senior-dev-opus-high and frontend-dev-opus-high as operator-chosen implementation routes.

Background: canonical Agents are Markdown files under agents/roles/ (frontmatter name, title, model, runner, inboxAccess, collaborators; prompt body) validated by packages/db/src/agent-contract.ts and installed or adopted per project by canonical sync. senior-dev-opus-medium.md is the same senior-developer prompt as senior-dev-astra-medium.md at claude-opus-5:medium. The production project agentos-example holds a hand-made Agent named senior-dev-opus-high (claude-opus-5:high, canonicalRole null) that chains have used since 2026-09-05; packages/db/src/canonical-agent-lookup.ts adopts a same-named null-canonicalRole row when no role row exists. The preceding chain "Agents: frontend-dev-opus-high is a canonical role" adds frontend-dev-opus-high.md and moves the canonical count assertion in packages/db/src/verify-agent-template.dbtest.ts to 20. At the current HEAD, docs/BRIEF-TEMPLATE.md Routing lists six routes and names frontend-dev-opus-high but not senior-dev-opus-high; docs/governance/task-routing-v1.md Implementation assignee routing names senior-dev-opus-medium and frontend-dev-opus-high but not senior-dev-opus-high.

Changes:
1. agents/roles/senior-dev-opus-high.md exists with name senior-dev-opus-high, title "Senior Dev", model claude-opus-5:high, and every other frontmatter field and the prompt body identical to senior-dev-opus-medium.md.
2. The canonical count assertion in verify-agent-template.dbtest.ts reads 21 active agents; any other test or fixture enumerating canonical roles by count or name is updated.
3. docs/BRIEF-TEMPLATE.md Routing adds one bullet for senior-dev-opus-high (same prompt as senior-dev-opus-medium on Claude Opus 5 high, operator-chosen, never a default, reason on the same line) and states that frontend-dev-opus-high is the operator-chosen high variant of the frontend route; docs/governance/task-routing-v1.md Implementation assignee routing names senior-dev-opus-high in the same sentence that names senior-dev-opus-medium.
4. agents/README.md is updated only if it enumerates roles or counts.

Out of scope: prompt changes to any role; staffing profiles; template default bindings; removing or renaming the existing project-level senior-dev-opus-high row (sync adopts it by name); the dispatch skill's routing table outside this repository.

Constraints: senior-dev-opus-high.md and senior-dev-opus-medium.md differ only in the name and model lines. No default binding changes.

Acceptance: `npm run test -w @anneal/db` unit suites are green and the verify-agent-template dbtest expectation reads 21 active agents; a test asserts the two senior-dev Opus role files are byte-identical outside the name and model lines; `npm run lint`, `npm run typecheck` and `npm run test:snapshot-scan` are green; docs/BRIEF-TEMPLATE.md and docs/governance/task-routing-v1.md name senior-dev-opus-high.

Depends on: Agents: frontend-dev-opus-high is a canonical role - both edit the same count assertion and the same Routing section

Route: implementation=senior-dev-opus-medium - operator chose Claude capacity; mechanical role addition
