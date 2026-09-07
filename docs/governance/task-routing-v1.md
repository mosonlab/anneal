# Task Routing Contract v1

Version: 1.11 (2026-09-07)

Status: Active

## Applies to

This contract governs the design, creation, dispatch, and routing of Anneal
tasks, task chains, and task templates. Every runnable task or chain has one
versioned Product Contract; a chain does not create a contract per step.

This is dispatch-time governance. Execution structure, step prompts, and model
or runner defaults remain in their canonical sources and are not copied here.

## Authority boundaries

The Product Contract fixes the task's boundaries and required evidence. The
dispatcher and execution chain choose implementation details only within those
boundaries; see [Minimum Product Contract](#minimum-product-contract) for the
required fields.

The human user holds dispatch authority. Work stays in the current session
unless the user explicitly requests a task chain. Complexity, risk, or an
available template may justify a recommendation, never chain creation or
dispatch.

Changing the objective, scope, acceptance criteria, required evidence,
authority, or risk boundary requires a new Product Contract version and
product-owner approval. A downshift of the selected route, effort, or
safeguards requires the same approval.

Model and effort routing follows the operator's current routing policy. Select
the implementation role and record the routing snapshot at dispatch. Rerouting
starts a new process and snapshot; an active Agent does not change model or
effort in-session. Model and effort belong in agent configuration, not task
prompts.

## Minimum Product Contract

A runnable task or chain records:

- Contract ID and version.
- Objective.
- In-scope and out-of-scope work.
- Acceptance criteria and required evidence.
- Risks, authority boundaries, and stopping conditions.
- Dependencies and prerequisites.
- The routing snapshot below.

SPEC and Plan are optional. The Product Contract is required.

## Task tiers

Current-session work is outside these tiers and needs no Product Contract. The
tiers apply only to a task chain the human user explicitly requests.

A change stays in the session when its diff can be named in one sentence
before it is written and its Acceptance is an existing named suite: a
constant, a threshold, prose, configuration, a rename, or a single-function
fix. The host window delivers it through the gate and the single-candidate
path in `CONTRIBUTING.md`. A change goes to a chain when writing it takes
implementation judgement the review steps must check, or when it alters what
the merge gate, merge automation, or a migration does.

Choose the shortest tier satisfying the Product Contract:

- Direct: no specification or plan; implementation starts from the task brief
  and proceeds through parallel reviews, a self-adjudicating fix step,
  regression, and the mechanical merge tail.
- Full Assurance: the full chain; its specification and plan stages own
  decomposition.

Direct is a formal chain route and still requires review and exact-head
mechanical authorization. Full Assurance is required when the Product Contract
calls for specification, planning, plan review, or revised-plan implementation
authorization.

Choose Direct when one implementation context window can deliver a brief with
enumerable change points. Write it from `docs/BRIEF-TEMPLATE.md`; the chain's
implementation `description` is the specification of record. Choose Full
Assurance when the work exceeds one implementation window or decomposes into
independently demonstrable slices. A surface too large for a brief to enumerate
belongs in Full Assurance, not in assignee escalation.

## Implementation assignee routing

A direct chain's Revalidate specification Step judges the implementation brief
and the repository at `HEAD` against the four tiers below. The default is the
answer unless the judge can name the specific criterion that applies. The
judge records the tier and the reason in the revalidation output, and the
selected staffing profile resolves that tier to an Agent. A tier slot is
operator configuration; an empty slot never falls through to another tier.

| Tier | Criterion | Not a reason to choose this tier | Canonical Agent today |
| --- | --- | --- | --- |
| `default` | Everything else. Acceptance that existing tests or grep can check stays here whatever it touches. | Crossing packages, touching web files, touching many files, landing in a sensitive directory, or an audit report once suggesting a stronger model. | `senior-dev-luna-max` |
| `frontend` | The deliverable is a new page, a page redesign, or a new interaction or visual scheme. | Adding a field, wiring data, or changing copy on an existing component. | `frontend-dev-opus-medium` |
| `hard` | A behavior that neither the brief nor an existing test pins down has to be defined by the implementer, and getting it wrong would not show in review or regression; for example, keeping an untested semantic intact across several providers' event handling. | The change is large, spans modules, or needs a lot of reading. | `senior-dev-astra-low` |
| `hazard` | The failure the acceptance suite cannot witness: concurrency, transaction boundaries, lock or lease windows, or cross-module contract migrations; or the change alters what the merge gate, merge automation, a migration, or authorization does. | Merely touching those files without changing their behavior. | `senior-dev-astra-medium` |

These tier criteria and not-a-reason lists are the text of record.

The tier is judged from the brief and tree, never from the path or file count.
The implementation step is restaffed from the selected profile's slot only
when it has no Route line or explicit implementation `stepOverrides` assignee,
has no Run, and the slot resolves to an Agent with the chain Repo's
`GIT_WRITE` grant. The revalidation output and that decision are stored in one
transaction. A Route line or explicit implementation `stepOverrides`
assignee is the operator override: it wins the judged tier, and the activity
record says that the tier was overridden. A running implementation keeps its
current Agent; an empty or ungranted tier slot is recorded as unstaffed or
refused and never silently replaced.

The Route line remains the operator override for a direct implementation. Its
grammar is exactly one of these line forms:

  `Route: implementation=<agent>`
  `Route: implementation=<agent> - <reason>`

The optional suffix uses the exact separator ` - `; `<agent>` is the Agent
name, at most 80 characters with no leading or trailing whitespace, and
`<reason>` is non-empty when the suffix is present. A `Route:`
near-miss on the direct template is refused with
`implementation_route_malformed`. A well-formed Route line on a template
that does not consume implementation routes is refused with
`implementation_route_template_unsupported`; the template's default is never
silently used. Other templates do not interpret malformed Route-looking prose.

The Route line and an explicit `stepOverrides` `assigneeAgentId` for the
implementation step are mutually exclusive; supplying both is refused with
`implementation_route_conflicts_with_step_override`. An include-only override
does not conflict, and a selected staffing profile does not conflict. The
routed implementation Agent must hold a `GIT_WRITE` grant on the Chain Repo,
using the same locked write-grant check as judged-tier staffing. Read-only
grants are refused with `step_override_missing_repo_grant`. Other existing
override checks still apply to the routed Agent; if its identity
changes before instantiation, `implementation_route_agent_renamed` is returned.

## Critical classification

Critical applies only when work touches persisted data or performs an
irreversible external action. It is a risk label, not a routing tier or model
route; it determines the slices and review attention owed to the work, while
model and effort remain with assigned roles.

Persisted data means runtime-created user or system data, including schema,
that must survive a version change. Structural risk means a change to a public
interface, persisted data, a component boundary, or a foundational dependency.

## Canonical execution graphs

Seeded templates under `agents/templates/` are the execution canon: their
Markdown owns step prompts, layer structure, blind-review isolation, and the
mechanical merge tail. `agents/README.md` owns the structural rules that bind
them. Model and runner defaults live in `agents/roles/` frontmatter;
`packages/db/src/agent-contract.ts` validates them against the model catalog in
`packages/db/src/model-routing.ts`.

Chains instantiated before a template change retain stored prompts,
assignments, and behavior. Canonical sync preserves superseded templates under
deterministic legacy identities; it does not rewrite instantiated work. A
rollover leaves each task's stored prompt unchanged.

## Human approval placement

`Task.approvalGate` is the sole runtime authority for an Agent step. A role
persists its output and finishes; the control plane moves a gated task to
REVIEW and an ungated task to DONE. An Agent may ask a blocking Product
Contract question, but does not create a second approval request for a
specification or plan artifact.

Both configurable gates default to off, so new projects and their chains stay
autonomous until an operator enables one. The only configurable slots are the
specification step (`outputKind: spec` in the Full Assurance/compound chain)
and the server-owned merge-readiness step recognized by
`isMergeReadinessStep` (step 11 in compound and step 7 in Direct). No other
step is a configurable gate slot.

Each project has independent boolean `specGateDefault` and `mergeGateDefault`,
both initially `false`. At dispatch, optional boolean `gates.spec` and
`gates.merge` override the corresponding project default for that chain only.
For either slot, resolution is exactly dispatch override, then project
default, then template frontmatter `approvalGate`. Every other step keeps its
frontmatter value. An operator may toggle a slot task's `approvalGate` after
dispatch only while it is `TODO`; a non-slot task or a slot in `DOING`,
`REVIEW`, or `DONE` is refused. Existing chains retain stored gate values.

Place the fewest gates that preserve human judgment:

- Add a specification gate only when the spec resolves product behavior,
  acceptance semantics, or a data-contract ambiguity left open by the approved
  Product Contract.
- Do not gate the plan step before independent review. When the Product
  Contract requires revised-plan implementation authorization in Full
  Assurance, put it after reviewed-plan closure at `revise-plan` in the
  template before instantiation. It is not a dispatch/TODO-configurable slot.
- Keep implementation, review, adjudication, repair, regression, and
  documentation automatic inside approved boundaries.

When merge-readiness is gated, regression completion opens the existing
integrator-feeding gate with regression evidence and server-read evidence
(pull-request head, base, and required-check conclusions) shown before
approval. Approval records exact-head operator authorization and releases the
readiness task to its ordinary server-owned readiness worker; it does not mark
readiness `DONE` or activate merge execution. That worker re-verifies
exact head, base, ancestry, defense, and lease before the sole integrator
authorization is produced. If head or base drifts, the tail stops without
merging; regression/readiness reopen with a fresh evidence card and the old
authorization is not reused. Rejecting the merge gate ends the chain terminal,
never activates merge execution, and leaves the pull request open and
unmerged. A specification-gate rejection keeps existing requeue behavior and
consumes normal `maxSessionsPerTask` budget.

Direct has no planning gates. Gate selection is recorded at dispatch; an active
Agent does not rewrite it.

## Per-chain routing snapshot

Record this block when creating or materially rerouting a chain:

```text
Routing Contract: v1.10
Tier: Direct
Implementation Agent: <project-agent-name>
Critical: no
Reason: Bounded change; Direct review and exact-head acceptance remain intact.
```

If risk or ambiguity increases, pause before the newly unsafe work and reroute.
If rerouting changes a Product Contract boundary, obtain product-owner
approval. New work uses the current routing contract; active work keeps its
recorded snapshot until explicitly rerouted.

## Backlog card lifecycle

A backlog card is a dispatch-ready brief awaiting a decision, not work of its
own. The board holds either the card or its chain, never both.

- Create it with `assigneeType: HUMAN` so no runner claims it. Its description
  is the brief from `docs/BRIEF-TEMPLATE.md`, plus the `Route:` line when the
  implementation assignee is non-default. The create API accepts an
  optional `status` of `BACKLOG` or `TODO` and defaults to `TODO`; pass `status: BACKLOG` to create
  a human Backlog card atomically, without a follow-up PATCH.
- Dispatch passes the card's name as instantiate `name` and the brief as
  instantiate `description`; the chain implementation task then owns the
  specification of record. Direct-template instantiation consumes and validates
  its `Route:` line. Chain ordering passes `afterTaskId` (the predecessor
  chain's final task) to the instantiate endpoint; the bound chain dispatches
  when the predecessor completes. `afterTaskId` cannot combine with
  `autoStart`. One predecessor task accepts several bound successor chains,
  so a wave that fans out from one delivered chain need not be serialised.
- Before every instantiation, classify the new chain against every in-flight
  or co-dispatched chain and select exactly one dependency outcome. Parallel is
  the default. Bind with `afterTaskId` only for a true dependency; serialize by
  choice only for heavy overlap or a concurrent migration.
  1. True dependency: this chain reads code the other merges, or the other
     must be deployed before this chain can be verified. Bind with
     `afterTaskId` and record `Depends on: <chain> — <what is consumed or why deploy-first>` in the instantiate description or card activity log. A
     mention of the other chain, a shared document, or an adjacent feature on
     the same surface is independent. Binding is one-way and one hop deep:
     the bound chain's first step refuses manual start until the predecessor
     is `DONE`, and only deleting that bound chain releases its own binding —
     the predecessor's other successors stay bound (see the instantiate route
     in `docs/operator-api.md`).
  2. Heavy overlap: no dependency, but both chains rewrite the same code area.
     Weigh expected refresh-conflict repair cost against serial wall-clock
     loss; either choice is valid, and a serial choice records its reason.
  3. Independent: dispatch in parallel with no justification. The merge tail
     and deploy quiet window already serialize delivery.
  Serialize an independent pair when a clean merge would still be semantically
  unsafe, including the same fail-closed enforcement path or behavior coupled
  across disjoint files (examples; not a closed list). Serialize every pair whose chains add a Prisma
  migration. `RELEASE_CANDIDATE_MIGRATIONS` normally changes only in the
  release-cut `chore(release): prepare` commit; adding a migration does not
  update it. The exception is a migration created before the recorded terminal
  but merged after the release cut: if its timestamp moves the terminal's
  recorded position, that merge must update the pin in
  `packages/db/src/release-migrate.ts`.
- Archive the card at instantiation. It remains recoverable in the Archived
  view; re-dispatching is a new decision, not revival of the card.

## Board column semantics

The [Backlog card lifecycle](#backlog-card-lifecycle) defines card creation,
dispatch, and archival. The board columns mean:

| Column | Meaning |
| --- | --- |
| Backlog | Un-instantiated intent being refined, awaiting a decision, or parked; it is not connected to execution. Prefix the title of an indefinitely parked HUMAN card with `Parked:`. |
| Todo | An instantiated chain or step whose specification of record is final, runnable or waiting for activation/dependency unlock. Un-instantiated intent enters Backlog; instantiated work enters Todo. |
| Doing | An AGENT task activated by the runner and in progress. |
| Review | An AGENT task paused for an approval/review gate or a run issue needing attention before continuation. |
| Done | A finished task or chain step. |

An operator can stop and park a running chain step, returning it to Backlog as
a parked step. Resume with **Start next step** or **Recover parked step**, not ordinary
card dispatch.

The operator owns Backlog and Todo transitions and marking HUMAN tasks Done.
The runner and chain scheduler own Doing, Review, and Done transitions for
AGENT tasks. In the usual flow, the operator moves finalized intent from
Backlog to Todo, then the runner advances each instantiated step through
Doing, Review, and Done.
