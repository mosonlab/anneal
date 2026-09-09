# 0007 - One check instead of a mechanism

Status: Accepted (2026-09-08)

## Context

Reviews of recovery and ownership paths can propose additional state and
coordination. The decisions here set the scope of checks, automatic repair,
and pull request recovery.

## Decision

### K5 `one-check-instead-of-a-mechanism`

When a review proposes a mechanism, prefer a single check.

**Why:** A cross-review of one backlog wave leaned uniformly toward adding
mechanisms; every rejection in it rested on this principle, and post-merge
items were made checks rather than gates.

#### Revisit when

No condition recorded.

### K6 `repair-once-per-kind`

The merge tail auto-repairs each repair kind once; a second
same-kind failure halts for the operator.

**Why:** `packages/db/src/merge-tail.ts` caps attempts by repair-kind marker,
and the tail loops only on blocking findings (P2 is non-blocking).

#### Revisit when

No condition recorded.

### K7 `readiness-trusts-immutable-pr-history`

Merge readiness treats the recorded pull request number as
immutable authority and stops rather than re-creating a pull request.

**Why:** When a push lands but pull request creation is swallowed by network
jitter, guessing would create duplicates. Delivery's pull request lookup runs
before the `opensPullRequest` check, so a later run records the open number and
Merge readiness self-resolves.

#### Revisit when

No condition recorded.

## Consequences

R10 ([workspace reclaim](../out-of-scope/runner-isolation.md#r10-workspace-reclaim-mechanism)),
R11 ([run-scope bypass](../out-of-scope/runner-isolation.md#r11-run-scope-bypass-credential)),
and R15 ([canonical sync](../out-of-scope/data-model.md#r15-canonical-managed-flag))
follow from the single-check principle.

The merge tail auto-repairs each repair kind once; a second same-kind failure
leaves the decision with the operator. Recovery from a missing recorded pull
request is a manual pull request against the Chain branch, followed by a
retry.
