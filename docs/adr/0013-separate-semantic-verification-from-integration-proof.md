---
status: accepted
date: 2026-09-26
---

# Separate semantic verification from integration proof

## Context

Regression previously refreshed the candidate, verified fixes, and ran a full
Merge gate before readiness could place that same candidate in a train whose
every cumulative prefix runs another full gate. Base drift and repairs could
repeat model review even when trusted prior semantic evidence already existed.
Concurrent feature updates to shared product inventories also created avoidable
refresh conflicts. A green integration suite cannot establish that an adopted
review finding was resolved or that its rejection was justified.

## Decision

New canonical Regression Steps use `regression-verification-v3`. Their positive
outcome is `semantic-pass` bound to `headSha` and `baseHeadSha`, without a gate
proof. Regression verifies finding dispositions, the complete fix delta, and
callers affected by changed contracts. It runs focused checks and expands scope
when a shared contract, intersecting target change, or missing reviewed range
requires it. It does not repeat the initial implementation review by default.

Merge train owns the full integration gate on each cumulative publication
prefix. A semantic candidate requires a train even alone or with configured
`MERGE_TRAIN_WIDTH=0`; zero disables batching. Readiness must never authorize
`semantic-pass` through the old single-candidate gate path or fabricate a
GateAttestation for it. Human Approval remains attached to the candidate head
and semantic base; authorization additionally requires the actual prefix's
exact-head gate proof, current base/head checks, and existing Lease protocol.
An unapproved candidate truncates publication before its prefix.

This amends ADR-0004's prerequisite of an already-gated candidate and its
single-candidate fallback. The demonstrated duplicate full gates meet the need
to revisit that eligibility rule; the existing train is sufficient, with no new
queue, database table, or parallel authorization mechanism. It preserves R4 in
`docs/out-of-scope/merge-gate.md`: integration coverage is not reduced to an
impact guess. A width-three train still gates three prefixes, not one batch.

## Recovery and repair

| Trigger | Semantic work | Integration work |
| --- | --- | --- |
| First post-fix verification | Check all dispositions and the fix delta with affected contracts. | Gate the publication prefix. |
| Trusted same-incoming-head base recovery | Reuse persisted positive semantic evidence mechanically. | Gate the new prefix/base. |
| `review-fix` | Recheck triggering findings and the repair's affected contracts. | Gate the repaired prefix. |
| `gate-fix` | Reproduce the reported failure with focused checks; inspect changed behavior. | Rerun the full gate on the repaired prefix. |
| `refresh-conflict` | Check resolution and affected contracts. | Gate the resolved prefix. |
| External execution failure | Preserve prior evidence and bounded recovery ownership; no invented PASS. | Retry only through the existing bounded owner. |

The Runner's fixed `verify-reused` execution bypasses provider preflight/model
startup only for a fresh Run with a trusted queued recovery snapshot and exact
incoming-head bindings. No repair handoff, pending CI finding, semantic failure,
or malformed snapshot is reusable. The script repeats this check, prepares the
tree, and persists a current-Run handoff; a missing handoff fails the Run.
A clean target merge may change the prepared head; semantic reuse deliberately
retains ADR-0004's existing trade-off while fresh integration proof covers the
new tree. This is not a general semantic cache across arbitrary commits.

Repair attempt and external-failure budgets do not change. Fresh semantic
verification remains necessary after a content-changing repair; its scope is
the repair and affected contracts, not another review of unchanged features.
Known CI failures remain blocking findings until repaired.

## Compatibility and consequences

Canonical rollover retains used v2 templates, Tasks, Runs, and outputs under
ADR-0008. The script's output version is pinned from the claim. Existing v2
Steps retain their full-gate finalize contract; v2 parsers reject semantic-pass.
New templates alone start v3 Steps. This does not silently upgrade in-flight
Chains, change deployment activation, or widen the publication authority.

The v3 script freezes its prepared pair and does not fetch again after semantic
verification. Readiness and train settlement own live-base validation. This
supersedes ADR-0006 K3's historical post-gate-fetch statement for current tooling;
its correctness boundary remains readiness, ancestry, and executor checks.

This removes a redundant candidate gate and qualified recovery model startup,
not all reruns. Genuine findings, changed repairs, conflicts, failed integration,
and a moved publication base still require new evidence. Environment/bootstrap
contracts and distributed documentation edits should remove avoidable failures
at their source. Savings must be measured from completed Runs and gate logs;
no fixed latency improvement is promised.
