# 0005 - Zero human gates by default

Status: Accepted (2026-09-08)

## Context

Chain templates combine specification, implementation, and an autonomous
merge tail. Projects can differ in where they need human approval, so template
defaults and project configuration need a clear boundary.

## Decision

### K1 `zero-human-gates-by-default`

Templates ship every Step with `approvalGate: false`. The single
human control point is the specification agreed before the Chain starts. The
specification and Merge gate positions are openable per project.

**Why:** Gates were removed deliberately after they cost more than they
caught. The last two Steps of every Chain are the autonomous merge tail
itself, so deleting them leaves nobody to merge.

#### Revisit when

No condition recorded.

## Consequences

Step counts are canon: 12 compound and 7 direct. A project that wants a gate
configures it rather than editing a template.
