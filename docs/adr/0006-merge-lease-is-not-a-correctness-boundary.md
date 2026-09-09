# Merge lease is not a correctness boundary

Status: Accepted (2026-09-08)

## Context

The Merge Lease coordinates the final merge window; it is not the proof of
exact-head correctness. That correctness is established by Merge readiness
base and head re-validation, ancestry checks, and executor pre-merge
re-verification. Treating the Lease as the correctness line would invite
widening its scope.

## Decision

### K2. lease-is-not-a-correctness-boundary

**Decision:** The Merge Lease buys “do not burn a gate,” not exact-head
correctness.

**Why:** Correctness is owned by Merge readiness base and head re-validation,
ancestry checks, and executor pre-merge re-verification; treating the Lease as
the correctness line invites widening its scope.

### K3. finalize-fetches-base-after-gate

**Decision:** Regression `finalize` re-fetches the base after the Merge gate
and accepts the rare discarded verdict.

**Why:** Measured over days, the post-gate fetch caught mid-gate base drifts
nine times for every verdict it discarded, and discards are absorbed by
auto-requeue.

### K4. shared-refund-counter

**Decision:** `Task.leaseLossRefunds` is one capped counter shared by runner
Lease loss, external-failure refunds, and Merge readiness base-drift requeue.

**Why:** Lease contention and transport deferral deliberately do not charge
it; they extend the wait so `main` can move.

## Consequences

Base drift during review is normal and costs one Regression re-run. If
discards ever matter, change the reaction—hand the case to Merge readiness
rather than dying—rather than the order, because the verdict is already bound
to the base head. “Refunds exhausted” usually means an earlier external
failure plus repeated base drift.
