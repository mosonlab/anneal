# Zero human gates by default

Status: Accepted (2026-09-08)

## Context

Gates were removed deliberately after they cost more than they caught. The
last two Steps of every Chain are the autonomous merge tail itself; deleting
them would leave nobody to merge. The specification agreed before a Chain
starts remains its single human control point, while projects may open the
specification and Merge gate positions when they need that control.

## Decision

### K1. zero-human-gates-by-default

**Decision:** Templates ship every Step with `approvalGate: false`. The single
human control point is the specification agreed before the Chain starts. The
specification and Merge gate positions are openable per project.

**Why:** Gates were removed deliberately after they cost more than they
caught. The last two Steps of every Chain are the autonomous merge tail
itself, so deleting them leaves nobody to merge.

## Consequences

Step counts are canon: 12 compound and 7 direct. A project that wants a gate
configures it rather than editing a template.
