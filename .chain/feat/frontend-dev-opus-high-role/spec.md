Agents: frontend-dev-opus-high is a canonical role

The frontend developer role exists at Claude Opus 5 high as a canonical Agent that deploy sync installs in every project, alongside frontend-dev-opus-medium.

Background: canonical Agents are declared as Markdown files under agents/roles/ with frontmatter (name, title, model, runner, inboxAccess, collaborators) and a prompt body; packages/db/src/agent-contract.ts validates them against the model catalog in packages/db/src/model-routing.ts, and canonical sync installs or adopts the Agent row per project. agents/roles/frontend-dev-opus-medium.md is the only frontend role today (title "Frontend Dev", claude-opus-5:medium, runner claude, inboxAccess false). senior-dev-opus-medium.md shows the precedent of a same-prompt role at a different model. packages/db/src/verify-agent-template.dbtest.ts asserts the exact canonical count in its success sentence ("19 active agents and 24 steps across 3 templates"), so adding a role without updating it fails the merge gate. docs/BRIEF-TEMPLATE.md (Routing) and docs/governance/task-routing-v1.md (Implementation assignee routing) name frontend-dev-opus-medium as the frontend route. The production project agentos-example already holds a hand-made Agent named frontend-dev-opus-high with canonicalRole null; packages/db/src/canonical-agent-lookup.ts adopts a same-named row with null canonicalRole when no role row exists, and chain 0c5514b5's implementation step is bound to that row.

Changes:
1. agents/roles/frontend-dev-opus-high.md exists with name frontend-dev-opus-high, title "Frontend Dev", model claude-opus-5:high, runner claude, inboxAccess false, collaborators [], and a prompt body identical to frontend-dev-opus-medium.md.
2. The canonical count assertion in verify-agent-template.dbtest.ts and any other test or fixture that enumerates canonical roles by count or by name is updated so the suites pass with the new role.
3. docs/BRIEF-TEMPLATE.md Routing lists frontend-dev-opus-high beside frontend-dev-opus-medium as the frontend route when the operator names it for harder frontend work; docs/governance/task-routing-v1.md Implementation assignee routing says the same in one sentence. Neither becomes a default.
4. agents/README.md is updated only if it enumerates roles or role counts; otherwise it is untouched.

Out of scope: any prompt change to either frontend role; senior-dev-opus-high (it stays a project-level Agent); staffing profiles; template step bindings; renaming or removing the existing project-level frontend-dev-opus-high row (canonical sync adopts it by name).

Constraints: the two frontend role files differ only in name and model; a test or a diff in Acceptance proves it. No default binding changes.

Acceptance: `npm run test -w @anneal/db` unit suites are green, including agent-sources and agent-contract tests, and the verify-agent-template dbtest expectation reads 20 active agents; a test asserts that frontend-dev-opus-high.md and frontend-dev-opus-medium.md are byte-identical outside the name and model frontmatter lines; `npm run lint` and `npm run typecheck` are green; the two docs name the new route.

Route: implementation=senior-dev-opus-medium - operator chose Claude capacity; mechanical role addition
