The implementation step of a direct chain is staffed by a tier judged by the Spec Revalidator from the brief and the tree, unless the brief names a route itself.

Background

Today the implementation Agent of a direct chain is fixed at instantiation. `parseImplementationRoute` (`packages/api/src/templates.ts`) reads an optional `Route: implementation=<agent> - <reason>` line from the brief; without it the step takes the template's default staffing profile entry for `implementation`. Nothing on the chain judges difficulty: the operator writing the card has to, and most cards carry no Route line, so every brief lands on the same Agent regardless of what it changes.

The chain already has a step positioned to judge: step 1 "Revalidate specification" (`agents/templates/direct-engineer-workflow/01-revalidate.md`, canonical Agent `spec-revalidator-luna-xhigh`) reads the implementation brief, inspects the repository at HEAD, and holds a minimal task-PATCH authorization to the implementation task. Its output is validated by the `revalidation` schema in `packages/db/src/canonical-output-schema.ts` (`schemaVersion`, `headSha`, `outcome`, `summary`, `changedReferences`). The step is conditional: `chain-step-omission.ts` omits it for chains bound to a predecessor, and the pr and compound templates do not carry it.

Staffing profiles (`StaffingProfile` / `StaffingProfileEntry`, keyed by exact `outputKind`) hold one Agent per step. They have no notion of tiers, so a judged tier has nowhere to resolve to an Agent.

The operator's tier vocabulary, decided 2026-09-07 and tightened the same day: the default is the answer unless the judge can name the specific criterion below that applies, and each tier lists what is explicitly not a reason. Escalation is by hazard or by output kind, never by path.

- `default` — everything else. Acceptance that existing tests or grep can check stays here whatever it touches. Not a reason to leave it: the change crosses packages, touches web files, touches many files, lands in a sensitive directory, or an audit report once suggested a stronger model. Agent today: `senior-dev-luna-max`.
- `frontend` — the deliverable is a new page, a page redesign, or a new interaction or visual scheme. Not a reason: adding a field, wiring data, or changing copy on an existing component. Agent today: `frontend-dev-opus-medium`.
- `hard` — a behavior that neither the brief nor an existing test pins down has to be defined by the implementer, and getting it wrong would not show in review or regression; for example, keeping an untested semantic intact across several providers' event handling. Not a reason: the change is large, spans modules, or needs a lot of reading. Agent today: `senior-dev-astra-low`.
- `hazard` — the failure the acceptance suite cannot witness: concurrency, transaction boundaries, lock or lease windows, cross-module contract migrations; or the change alters what the merge gate, merge automation, a migration, or authorization does. Not a reason: merely touching those files without changing their behavior. Agent today: `senior-dev-astra-medium`.

Changes

1. Extend the `revalidation` output schema with a required `route` object: `{"tier":"default|frontend|hard|hazard","reason":"<the criterion that applies, or why none does>"}`. Bump `schemaVersion` to 2; a version-1 object is rejected by the schema with a loud validation error, not accepted with a default tier.
2. Extend the revalidate step prompt (`01-revalidate.md`) so the step judges the tier under the criteria above, naming which criterion applies and checking the not-a-reason list before leaving `default`,, from the brief and the tree it already inspects, and records `route` in its output. Keep the existing rule that the step never edits the brief's Route line.
3. Add tier slots to staffing profiles: a profile carries, besides its per-step entries, an optional Agent for each of `default`, `frontend`, `hard`, `hazard` under a key that cannot collide with an `outputKind` (for example a separate `StaffingProfileTier` row set keyed by `[profileId, tier]`). `GET`, `POST`, `PUT`, and `reset` on staffing profiles read and write these slots; `reset` fills them from the canonical Agents named in Background (`frontend-dev-opus-medium` for `frontend`). The web Workflows page shows and edits the four slots beside the step list.
4. When a `revalidation` output is stored for a chain whose implementation task has no run and no brief Route line, and the profile the chain was instantiated with resolves the judged tier to an Agent, set the implementation task's `assigneeAgentId` to that Agent inside the same transaction that stores the output, and record a `TaskActivity` on the implementation task naming the tier, the reason, and the previous and new Agents. The `hazard` tier is applied even when it resolves to the same Agent the step already has; the activity is still written.
5. Precedence is fixed: a brief Route line wins over the judged tier and the judged tier is recorded in the activity as overridden; an explicit `stepOverrides` assignee for the implementation step is treated the same as a Route line. If the tier resolves to no Agent (slot empty), the implementation task keeps its current Agent and the activity says the tier was unstaffed. If the implementation task already has a run when the output arrives, nothing is restaffed and the activity says so.
6. The restaffed Agent must hold the chain repo's `GIT_WRITE` grant, using the same check chain instantiation applies to a Route-line Agent; a tier that resolves to an ungranted Agent is refused the same way and the activity records the refusal.
7. Rewrite the "Implementation assignee routing" section of `docs/governance/task-routing-v1.md` and the Routing section of `docs/BRIEF-TEMPLATE.md` around the four tiers: the judged tier is the default path, the Route line is the operator override, and the tier criteria and not-a-reason lists above are the text of record. Update `docs/operator-api.md` for the staffing-profile payload change in the same change.
8. Merge-tail repair staffing: delivered separately on 2026-09-07 by the card "Merge tail: review-fix and gate-fix repair cards are staffed from a profile slot that defaults to luna max" (branch fix/merge-tail-repair-staffing-slot). Do not implement it here; if that branch has merged, keep its slot and lookup unchanged, and only ensure the tier-judging restaff of the implementation step leaves the profile's merge-tail repair slot untouched.
9. Align the five canonical role files with the Agents production already runs, renaming each file and its `name` per the `role-model-effort` slug rule and keeping every pinned test in step: `regression-verifier-luna-xhigh` → `regression-verifier-luna-max` (`gpt-5.6-luna:max`), `code-reviewer-opus-high` → `code-reviewer-opus-medium` (`claude-opus-5:medium`), `merge-resolver-opus-medium` → `merge-resolver-luna-max` (`gpt-5.6-luna:max`, runner codex), `plan-reviser-opus-high` → `plan-reviser-opus-medium` (`claude-opus-5:medium`), `plan-executor-astra-medium` → `plan-executor-astra-low` (`gpt-6-astra:low`). `MERGE_RESOLVER_ROLE` in `merge-tail-actions.ts` follows the rename, as does every compound-template step file and test that names the two plan roles.

Out of scope

- Judging tiers on the pr or compound templates, or adding a revalidation step to them.
- Re-judging after the implementation step has started, or on merge-tail repair cards.
- Choosing a provider from quota or price; the tier→Agent mapping is operator configuration in the profile.
- Changing which Agent each tier maps to beyond the canonical defaults named in Background; production profiles are operator data.
- Changing the fix step, review steps, regression step, or `MAX_MERGE_TAIL_REPAIR_ATTEMPTS`; changing how `refresh-conflict` is staffed.
- Any change to the Route line grammar or its refusal codes.

Constraints

- Fail loud: a revalidation output without a valid `route` fails the step; a tier that cannot be staffed never silently falls back to another tier.
- The restaff and the output store are one transaction; a chain never observes an output without its restaff decision.
- Canonical sync must adopt the renamed roles on the existing production Agents through their `canonicalRole` column without creating duplicates; the five Agents keep their ids.
- Keep the simplest schema that meets these items; no per-project tier configuration outside the profile.

Acceptance

- `canonical-output-schema` tests: a `revalidation` object with `schemaVersion: 2` and each of the four tiers parses; one without `route`, with an unknown tier, with an empty reason, or with `schemaVersion: 1` is rejected.
- Staffing-profile route tests: `GET` returns the four tier slots; `PUT` and `POST` store them; `reset` fills them with the canonical tier Agents; an `outputKind` entry named like a tier is not confused with a slot.
- Merge-tail tests: a review-fix and a gate-fix card take the profile's `mergeTailRepair` Agent; with the slot empty they take the fixed-implementation Agent; refresh-conflict still takes the resolver role.
- Chain tests, one per case: judged `hard` and judged `frontend` on a Route-less chain each restaff the implementation task and writes the activity; judged tier with a Route line leaves the Agent and records the override; empty slot leaves the Agent and records unstaffed; implementation already running leaves the Agent; ungranted Agent is refused and recorded.
- `agent-contract.test`, `verify-agent-template.dbtest`, `canonical-template-registry.test`, `merge-integrator-seed.dbtest`, `merge-tail-repair.dbtest`, and `scripts/operator-api-docs.test.mjs` pass with the five renamed roles; the canonical Agent count is unchanged.
- `npm run lint` and `npm run test:snapshot-scan` are green; the operator API handbook documents the tier slots.

Route: implementation=senior-dev-astra-medium - the change restaffs a chain step transactionally and alters merge-tail role binding; a wrong restaff or a duplicated Agent from sync is not something the acceptance suite witnesses end to end