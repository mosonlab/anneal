# agents/ — Canonical prompts

Source-of-truth files for canonical agent prompts and initial runtime defaults, the mechanical merge sentinel, and task-template step prompts. The seed script imports these into the `Agent`, join, and `TaskTemplateStep` tables; `packages/db/prisma/seed.ts` is the consumer. Models and runners changed by the operator in the console are persisted runtime overrides and are not replaced by seed or canonical prompt sync. Skills remain an API-managed concept (`Skill` / `AgentSkill`), but no canonical skill is seeded from this directory.

The chain prompts with an upstream counterpart in [mattpocock/skills](https://github.com/mattpocock/skills) do carry that text verbatim, wrapped in paragraphs written here for this platform's contracts; the notice is in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

Keep the [Spec Writer](roles/spec-opus-high.md) and
[Plan](templates/compound-engineer-workflow/02-plan.md) guidance aligned with the
upstream baseline recorded in that notice. Update their imported text only
through upstream synchronization, preserving Anneal's surrounding authority and
output contracts.

## Canonical synchronization and verification

The canonical synchronization, project-scoped installation and verification,
and full-tail readiness contract are maintained in the
[Tier 0 / Tier 1 onboarding runbook](../docs/runbooks/add-a-project.md).
Follow its Tier 1 checklist when onboarding another Project.

For an already-seeded canonical project, `senior-dev-opus-high` and
`frontend-dev-opus-high` rely on adoption of pre-existing active project Agent
rows by name when their `canonicalRole` is null. Neither role is in
`SPECIAL_CANONICAL_AGENTS` in `packages/db/prisma/sync-canonical-prompts.ts`, so
ordinary canonical sync does not recreate a missing or archived row for these
roles and refuses an incomplete canonical inventory. Fresh seeds install both
roles from the source inventory.

## Changing a canonical prompt

Editing any file under `templates/`, or changing a canonical template's
structure, retires the generation every deployment is running. Canonical sync
installs the source tree's prompts, and the rows it finds carry whatever
generation the last deploy installed; it can only replace them when the
registry says which retired generation they are.
Three edits belong in the same change.

1. Edit the Markdown, or make the structural source change.
2. Re-pin the source generation. `npm run db:template-digest` prints one digest
   per template; copy the changed one into
   `CANONICAL_SOURCE_PROMPT_GENERATIONS` in
   `packages/db/src/canonical-template-transition.ts`. A shape-only change,
   such as renaming a step while leaving every prompt file untouched, keeps
   the existing digest exactly; run the command to verify that fact and do not
   invent or replace the digest.
3. Publish the new generation and register the one it replaces. For a
   prompt-only change, append the new digest to
   `PUBLISHED_PROMPT_GENERATIONS` in
   `packages/db/src/canonical-published-generations.ts` — append, never rewrite
   the last element, which names a generation already deployed — and add an
   entry to the retired-generation registry in
   `canonical-template-transition.ts` carrying a marker that names what
   changed, the shape those rows hold, and `promptDigest` set to the digest the
   published list held before this change. For a shape-only change, annotate
   the outgoing published entry with `retiredByShape` set to its marker, add
   the retired-generation entry without `promptDigest`, and append the same
   unchanged digest as the new last entry. That duplicate digest is
   intentional: the structural marker distinguishes the two generations.
   Never rewrite a published digest in place or invent one.

`packages/db/src/canonical-published-generations.test.ts` refuses in the merge
gate until all three are done, so a generation nothing can transition from
stops the change rather than the deploy that installs it.

## Layout

- `foundational.md` — the shared foundational prompt. Body maps to `Agent.foundationalPrompt` for every agent.
- `roles/<name>.md` — one file per agent. Frontmatter maps to `Agent` columns and join tables; markdown body maps to `Agent.rolePrompt`.
- `templates/<template-name>/<NN>-<slug>.md` — one file per canonical workflow step. Frontmatter maps to structural `TaskTemplateStep` fields; markdown body maps to `TaskTemplateStep.prompt`.

An Agent or task template whose name is a canonical name is rewritten to the canonical text on every deploy; a project that needs a different prompt uses a different name.

## Role frontmatter

```yaml
name: plan-fable-medium   # Agent.name (unique per project), role-model-effort
title: Planner            # Agent.title, the role only
model: claude-fable-5:medium # Agent.model, including its default reasoning effort
runner: claude               # Agent.runnerPreference (claude | codex | pi)
inboxAccess: true         # Agent.inboxAccess
collaborators: []         # AgentCollaboration rows, by agent name
```

A canonical role's `name` is the slug `role-model-effort` — the model short name
(`astra`, `luna`, `sol`, `opus`, `fable`) and its reasoning effort — so two roles
that do the same job on different models coexist without collision; `default` and
`merge-integrator` are the two exceptions. `title` names the role only and never
the model or the effort.

## Template step frontmatter

```yaml
stepIndex: 5
layer: 5
agent: plan-executor-astra-low # Agent.name, or null for a human step
approvalGate: false
optional: false
outputKind: implementation
priorOutputKinds: []         # Prior TaskStepOutput kinds required by this prompt
attachmentsFromPrevious: true
opensPullRequest: true
requiresCommit: true          # false when a valid Step outcome may leave HEAD unchanged
provisionDependencies: true   # false only when this step must skip workspace dependency materialization
baseFromStepIndex: null                # null or a step in a strictly earlier layer
spawnPolicy: null                      # null or an inline JSON object
```

The implementation step's JSON output carries `baseSha`, and that field is
informational only. The platform pins the range every review, fix, and
regression step sees from its own records: the head is the commit the output is
bound to, and the base is the earliest Run of the implementation Task that
recorded a provisioning `baseSha`. A body `baseSha` that disagrees with that
record is persisted and reported in the task activity log; it never moves the
reviewed range, and it is never the reason a claim fails.

`packages/db/src/template-sources.ts` is the live authority for each
template's file count, contiguous indexes, layer vector, and accepted
structural keys; equal layer values are parallel siblings and the following
layer is their join. Step display names remain seed-owned presentation
metadata; all execution structure and prompt text live in the Markdown
sources.

The operator procedure for changing a template, including its shape, is
maintained outside this repository. There is no authoring API for the canonical
templates: the source here is the record, canonical sync's closed contract
decides what may replace what, and a change reaches production as an ordinary
pull request through the merge gate. The template-authoring routes in
`docs/operator-api.md` rewrite a clone's step graph and refuse a canonical
template with `template_canonical`.

Exact canonical model and runner defaults live in the role frontmatter; `packages/db/src/agent-sources.ts` is the loader consumed by the seed, canonical sync, onboarding, and contract checks. A task template binds roles, while each Agent owns its runtime runner, model, and reasoning effort: canonical values apply to new or uncustomized Agents, and an operator edit sets an explicit runtime override. Template steps normally leave `runner` unset so the Agent configuration remains the single runtime authority. `inboxAccess` is least-privilege — granted only where the role contract requires talking to the human; the role frontmatter is the live roster.

Approval is task metadata, not an Agent personality. Roles read the current
task's `approvalGate`; they do not hard-code a pause or send a second Inbox
question to simulate one. Only two structural slots are configurable: the
specification slot (`stepRole: spec`, the `outputKind: spec` step) and the merge
slot (the merge readiness step recognised by `isMergeReadinessStep`, with
`stepRole: readiness`). For either slot, the exact resolution order is the
dispatch override (`gates.spec` or `gates.merge`), then the project default
(`specGateDefault` or `mergeGateDefault`), then the template frontmatter
`approvalGate`; every other step keeps its frontmatter value. The Full
Assurance template's gate placement and shorter-route rules live only in the
routing contract.

The seed installs three templates over these roles: the twelve-step Full
Assurance chain, the eight-step bound-capable direct chain
(`direct-engineer-workflow`) — revalidation for bound briefs, implementation by
`senior-dev-luna-max` from the task brief, parallel code review and blind code
review siblings whose findings the fix step (`senior-dev-astra-low`, the senior
developer prompt at Astra low) adjudicates itself, exact-head regression,
server-side readiness, and mechanical merge — and the four-step pull-request
chain (`pr-engineer-workflow`), which runs implementation, code review and blind
code review, and review-fix application before ending at an open pull request with
no regression or merge step. Unbound direct instantiation omits the
revalidation row and retains the historical seven-step prompts. All three step
contracts live in their Markdown directories under `templates/`.

Provider-specific or temporary roles are not canonical defaults unless the
cross-provider review contract explicitly requires separate identities.
`senior-dev-sol-high`, `senior-dev-opus-medium` and `senior-dev-opus-high` are
canonical rather than experiments
because they are the explicit implementation tiers named by the
implementation-assignee routing rules in `docs/governance/task-routing-v1.md`:
the Sol fallback when the Astra model is unavailable, and the Claude
Opus 5 medium and high routes an operator names to spend Claude capacity.
`senior-dev-astra-low` is canonical because every template binds it to the
review-fix step and the `hard` implementation tier. Keep
experiments out of `roles/`; create them as local overlays and archive them
when no longer needed so a seed cannot silently turn an experiment into a
release default. Implementation-assignee escalation follows the
implementation-assignee routing rules in
`docs/governance/task-routing-v1.md`.

Each review and regression role states its own duty in its role file; read
`roles/` rather than a summary here. Superseded roles and template rows —
including the archived `review-adjudicator-opus` node and renamed
`regression-verification` v1 rows — remain database history so chains
instantiated under them keep the prompts and assignees they were dispatched
with; archived roles are never assigned to new tasks or templates.

New canonical Chains use the model-neutral `review-findings` output kind.
The `pre-model-neutral-review-output` rollover retains old template, Step, Task,
and output rows with their original `sol-findings` kind; only the new
template receives remapped staffing profile entries. Execution support for that
kind is retired: it is no longer recognized for Step roles, repair evidence,
or PR handoff. Template adoption and rollover still upgrade older installations.
Historical Tasks, Runs, outputs, and reports retain their original kind and text.
