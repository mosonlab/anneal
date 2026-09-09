# Data-model designs

## R13 data-model-additions

### Decision

These additions are refused: a `kind` column on `TaskActivity` or a dedicated
merge-tail table, a version column on `TaskTemplate`, splitting `RunStatus`,
an accepted range in the executor claim contract, `take` limits on the board
and costs JSON queries, removing the executor's `checkCancellation` or legacy
constants, and per-project quotas.

### Why

Sampled structural root cause fell below the bar for a new column; no template
row could be deleted under versioning; strict equality in the claim contract is
a deliberate defence and a range would not address the `missing` case; `take`
would drop markers; the executor code is live at runtime.

### What exists instead

Existing shapes.

### Revisit when

No condition recorded.

## R14 session-event-age-pruning

### Decision

`SessionEvent` rows are not pruned by age.

### Why

Retention is bounded by a cap on volume per run, and age is not the pressure.

### What exists instead

The cap.

### Revisit when

No condition recorded.

## R15 canonical-managed-flag

### Decision

No `canonicalManaged` flag and no digest registry for canonical sync.

### Why

A canonical's name already makes it canonically managed; a flag adds a second
source of truth for the same fact.

### What exists instead

The name-based rule.

### Revisit when

No condition recorded.
