# 0006 - Merge lease is not a correctness boundary

Status: Accepted (2026-09-08)

## Context

Concurrent Chains can move the base while another Chain is under review or
running its Merge gate. The merge Lease, post-gate base fetch, and requeue
budget address different parts of that situation.

## Decision

### K2 `lease-is-not-a-correctness-boundary`

The Merge Lease buys "do not burn a gate", not exact-head
correctness.

**Why:** Correctness is owned by Merge readiness base and head re-validation,
ancestry checks, and executor pre-merge re-verification; treating the Lease as
the correctness line invites widening its scope.

#### Revisit when

No condition recorded.

### K3 `finalize-fetches-base-after-gate`

Regression `finalize` re-fetches the base after the Merge gate
and accepts the rare discarded verdict.

**Why:** Measured over days, the post-gate fetch caught mid-gate base drifts
nine times for every verdict it discarded, and discards are absorbed by
auto-requeue.

#### Revisit when

No condition recorded.

### K4 `shared-refund-counter`

`Task.leaseLossRefunds` is one capped counter shared by runner
Lease loss, external-failure refunds, and Merge readiness base-drift requeue.

**Why:** Lease contention and transport deferral deliberately do not charge
it; they extend the wait so `main` can move.

#### Revisit when

No condition recorded.

## Consequences

Base drift during review is normal and costs one Regression re-run. If
discards ever matter, change the reaction rather than the order: hand the case
to Merge readiness instead of dying. The verdict is already bound to the base
head.

"Refunds exhausted" usually means an earlier external failure plus repeated
base drift.
