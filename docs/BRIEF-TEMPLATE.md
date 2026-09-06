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

Implementation has six routes:

- **senior-dev-luna-max** (template default): a brief with mechanical Acceptance
  is work that tier finishes under the chain's review and regression tail.
- **senior-dev-astra-medium**, with the reason on the same line, for an
  owner-defined hazard. A senior-dev-astra-medium route without a reason is a
  brief defect.
- **senior-dev-sol-high**, with the reason on the same line, only when the
  Astra model is unavailable for that work. It is never a default.
- **senior-dev-opus-medium**, with the reason on the same line, when the operator
  chooses to spend Claude capacity on that work instead of Codex capacity.
  It is the same senior-developer prompt on Claude Opus 5 medium; it is
  never a default, and the chain keeps its code review and blind code review
  steps unchanged.
- **frontend-dev-opus-medium** for the frontend scope defined in
  [Implementation assignee routing](governance/task-routing-v1.md#implementation-assignee-routing).
- **frontend-dev-opus-high** for that same frontend scope when the operator names
  it because the frontend work is harder. It is the same frontend-developer
  prompt on Claude Opus 5 high; it is never a default.

The [Implementation assignee routing](governance/task-routing-v1.md#implementation-assignee-routing)
section owns the default, hazard escalation, exact `Route:` grammar, refusal
codes, and `stepOverrides` interaction. Follow that section when selecting a
route or writing the route line.

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
