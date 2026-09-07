# Feature brief template

A direct chain carries no spec or plan phase: the brief passed as the
`description` at template instantiation is the specification of record. Every
step of the chain reads it — the implementer builds from it, reviewers judge
the diff against it, the fix step treats it as the boundary. Write it with the
seven sections below, in this order.

## Sections

### Title

The title is the Backlog card's name and the chain's name. Write one line of at
most 120 characters, shaped `<Area>: <what exists after the chain>`. Name the
outcome that exists after the chain; do not name a step, template, or tier.

Examples:

- `API: Chain names are required`
- `Web: Task details stay task-scoped`
- `Release: Pull request delivery is ready`

### Goal

One sentence: what exists after this chain that does not exist today. No
implementation detail.

### Background

Why this work is needed and what root cause it addresses. State the current
behavior and the mechanism behind it, naming the actual code concepts
(models, functions, invariants) so the implementer can anchor the brief to the
repository without guessing.

If the card will be dispatched after another card through an `afterTaskId`
binding or a serial line declared in a wave plan, state the premises in
Background and Changes as of the moment that predecessor has merged, name the
predecessor by card or branch, and do not use "until X lands", "until it lands",
or "X has not landed" language about it.

### Changes

A numbered list. Each item must be independently checkable against the diff:
a reviewer should be able to tick it off or flag it missing. Name concrete
fields, routes, and validation points. If an item has a non-obvious rule
inside it (ordering, one-cut migration, a validation edge), state the rule in
the item itself.

### Out of scope

Explicit negative list. Name the adjacent work this chain must not touch,
including things a capable implementer would be tempted to fix in passing.
Reviewers and the fix step enforce this list as a hard boundary; an unlisted
temptation is an invitation.

### Constraints

Behavioral rules that hold across all items: failure semantics (fail loud, no
silent fallback), compatibility requirements, invariants that must survive
the change. Omit the section only when the Changes items already carry every
rule.

### Acceptance

Mechanically checkable criteria: migrations apply, named validations reject
named bad inputs, named suites are green, observable properties hold. Each
criterion should be verifiable without judgment calls. This section is what
"done" means; if a criterion cannot be checked mechanically, rewrite it until
it can.

## Discipline

- Changes and Acceptance must cover each other: every change has at least one
  acceptance criterion that would catch its absence, and no criterion tests
  something outside the listed changes.
- Out of scope is mandatory, even when it feels obvious.
- The brief states requirements and boundaries, not implementation steps.
  Environment rules and role behavior live in the agent prompts; code facts
  live in the repository. Do not restate either.

## Routing

The implementation Revalidate specification Step judges one of four tiers from
the brief and the repository. The default is the answer unless the judge can
name the specific criterion that applies; it records the tier and reason in
the revalidation output, and the selected staffing profile supplies the Agent
for that tier. The tier criteria and their not-a-reason lists are:

- **default** — everything else. Acceptance that existing tests or grep can
  check stays here whatever it touches. It is not a reason to leave `default`
  that the change crosses packages, touches web files, touches many files,
  lands in a sensitive directory, or was once called out by an audit report as
  needing a stronger model. Its canonical Agent today is
  `senior-dev-luna-max`.
- **frontend** — the deliverable is a new page, a page redesign, or a new
  interaction or visual scheme. Adding a field, wiring data, or changing copy
  on an existing component is not a reason to choose it. Its canonical Agent
  today is `frontend-dev-opus-medium`.
- **hard** — a behavior that neither the brief nor an existing test pins down
  has to be defined by the implementer, and getting it wrong would not show in
  review or regression; for example, keeping an untested semantic intact
  across several providers' event handling. A large change, a change that
  spans modules, or a change that needs a lot of reading is not a reason to
  choose it. Its canonical Agent today is `senior-dev-astra-low`.
- **hazard** — the failure the acceptance suite cannot witness: concurrency,
  transaction boundaries, lock or lease windows, or cross-module contract
  migrations; or the change alters what the merge gate, merge automation, a
  migration, or authorization does. Merely touching those files without
  changing their behavior is not a reason to choose it. Its canonical Agent
  today is `senior-dev-astra-medium`.

These tier criteria and not-a-reason lists are the text of record.

The [Implementation assignee routing](governance/task-routing-v1.md#implementation-assignee-routing)
section owns the judged tier, its criteria and not-a-reason lists, the tier
slot lookup, exact `Route:` grammar, refusal codes, and `stepOverrides`
interaction. The judged tier is the default path. A `Route:` line or explicit
implementation `stepOverrides` assignee is the operator override and wins the
judged tier; use it when the operator has a specific Agent to override the
judge, with the optional suffix recording the reason. A tier slot that is
empty or lacks the Repo's `GIT_WRITE` grant is never silently replaced by
another tier.

Tier answers how hard the diff is; chain shape answers how settled the spec
is — a brief that cannot reach mechanical Acceptance is compound-shaped
regardless of tier.

## Skeleton

```
<Title — one line, at most 120 characters, shaped `<Area>: <what exists after the chain>`.>

<Goal — one sentence.>

Background: <current behavior, mechanism, root cause.>

Changes:
1. <Checkable item.>
2. <Checkable item.>

Out of scope: <explicit negative list.>

Constraints: <cross-cutting behavioral rules, if not already in Changes.>

Acceptance: <mechanical criteria, covering every change.>
```

### Continuing from a delivered branch

When a new direct chain continues a delivered branch, see the operator
handbook's [recovery procedure](operator-api.md#recovering-a-merge-tail-stopped-after-its-repair-budget)
for the required hold and archive order. The brief must follow these rules:

1. Change 1 is a plain merge of `origin/<old branch>` at a pinned commit sha.
2. The remaining Changes cover only the defect that stopped the previous chain.
3. Append the previous brief verbatim under a `Reference` heading so reviewers
   can judge the merged diff against it.
4. Acceptance must include “the chain branch contains <sha> as an ancestor”
   and must include the previous brief's acceptance criteria unchanged.
