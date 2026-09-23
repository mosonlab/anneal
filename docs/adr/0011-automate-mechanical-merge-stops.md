# 0011 - Automate mechanical merge stops

Status: Accepted (2026-09-23)

## Context

The autonomous merge tail has stopped for three facts that an operator only
checked mechanically: pending checks, a target-branch conflict after base
advancement, and an OPEN approval card whose base evidence became stale. The
result was an idle Chain despite no failed check or semantic decision.

ADR-0005 makes human gates opt-in. ADR-0006 keeps the Merge Lease separate from
exact-head correctness; this decision does not weaken that boundary. The
rejected Regression lease-requeue design in `docs/out-of-scope/merge-tail.md`
is different: pending mergeability retries the mechanical integrator, not a
completed Regression or its semantic work.

## Decision

### K13 `bounded-mechanical-merge-recovery`

- Pending required checks or `UNKNOWN` mergeability after the executor's poll
  budget, train pre-publication poll, or final pre-merge read yield a durable
  deferred result. The control plane releases the Merge
  Lease, waits with doubling backoff (2–60 seconds), then re-enters the same
  mechanical decision. Six hours total, including repeated deferrals, is the
  ceiling; only then does it open the existing stop question with elapsed time.
  A held Chain is excluded from the ceiling; if the hold spans the six-hour
  boundary, Resume grants one final mechanical determination before a stop.
- `CONFLICTING` or `DIRTY` with terminal checks enters the existing base-drift
  recovery even if the base is unchanged; if it has moved, forward advancement
  must still be verified. Recovery
  requeues Regression against the current target; `refresh-conflict` remains
  Regression's one-per-head repair path. The existing two automatic recovery
  attempts and retry-class ceilings apply. An ineligible or exhausted
  candidate receives the existing stop question.
- An evidence-backed OPEN Merge readiness Approval gate or post-stop
  confirmation card is refreshed when its recorded base SHA trails the
  verified current target head. The control plane atomically closes the old
  card and requeues Regression. At most three automatic base-drift requeues
  outside recovery are permitted; an active recovery aggregate uses its own
  two-requeue allowance instead. On exhaustion the card stays OPEN with the
  reason. An enabled project Approval gate still requires a human to approve
  the replacement card.
- OPEN evidence cards are read no more frequently than every five minutes
  while healthy; unchanged `checked` state does not append another activity.
  Timeout, 429, 5xx and Lease transport failures retry for at most 30 minutes
  or 30 attempts with the same bounded backoff. A held Chain waits for resume.
  A deterministic identity or ancestry mismatch stops immediately.

Each automatic disposition writes a control-plane TaskActivity with its
condition, observed values, attempt and remaining budget. It never writes an
operator answer or stop disposition. Chain-row locking and the OPEN-card
compare-and-swap make a concurrent human answer and automatic refresh
single-winner operations. A failed automatic operation opens the existing
stop path with its reason rather than retrying silently.

## Human boundary

Terminal failed checks and `UNSTABLE` with a failed check now follow the
bounded recovery in [ADR-0012](0012-recover-terminal-ci-check-failures.md).
`BLOCKED`, draft or non-OPEN pull requests, unverified ancestry, exhausted budgets, and uncertain
merge outcomes still stop for an operator. Exact-head merge, gate attestation,
and Run-birth guards are unchanged. Initial Approval gate rejection abandons
the Chain; rejection of a post-stop confirmation card requeues the preceding
executable Step instead. Automatic stale-evidence refresh is a third,
control-plane-owned action, not either human rejection.

Train post-publication read-back cannot defer: publication may already have
landed, so it must settle the observed merge or stop for operator investigation.
Same-base conflict recovery does not reread mergeability before its bounded Regression replay; a redundant replay can consume one of two attempts but cannot bypass merge checks. Non-train resends have no separate send-count cap: every resend locks the exact head, rechecks all merge conditions, and remains within the six-hour wait ceiling.
