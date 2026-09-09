# 0010 - Cross-family review before dispatch

Status: Accepted (2026-09-08)

## Context

A multi-agent audit produces a lead list for investigation, not an
implementation specification. Before a lead list can drive cards and Chains,
its causal conclusions need an independent read by a different model family.

## Decision

### K15 `cross-family-review-before-dispatch`

Conclusions from a multi-agent audit receive one read-only review by a model of
a different family before any card is dispatched. Audit output is a lead list,
not an implementation specification, and failure-class Chains are split one
per Chain.

**Why:** Eight studies plus eight verifications from one model family still
missed causal chains that minutes of code reading overturned, and one outside
review caught them all.

#### Revisit when

No condition recorded.

## Consequences

- Dispatch waits for the cross-family review.
- The audit does not itself authorize implementation or define a Slice.
- Each failure class gets its own Chain.
