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

## Amendment: supersession of a re-authorized stop

After a human answers a stop `re-authorize` (`refresh-requested`), a Merge
readiness re-verification that completes after that answer and binds a
control-plane `mechanical` authorization to its exact head supersedes the stop.
`activateChainSuccessor`, reached from readiness settlement and from Chain
resume, opens the integrator Run through the Run-birth `stopBypass`, closes the
stop's confirmation cards and `integrator-stopped` refusal notice, and writes a
`mergeIntegrator.stopSuperseded` activity. Platform retries of that Run
(lease loss, claim invalidation) inherit the same admission. A click on a card
closed this way is refused with an explanation.

This does not reopen the "uncertain merge outcomes still stop for an operator"
boundary:

- The human already made the decision. `re-authorize` is the operator's answer
  that the stop may resume on fresh evidence; supersession writes no operator
  answer or stop disposition and only replaces the confirmation card that would
  have shown that same evidence.
- Readiness re-reads the pull request, head, base and checks under the Merge
  Lease, so no other merge path acts on the same target in between.
- Only a readiness `mechanical` authorization created after the `re-authorize`
  answer qualifies; the authorization the stopped Run consumed is older and
  never does. Readiness issues it only when the pull request's current head and
  base equal the head-bound Regression PASS evidence and the head is ahead of
  or identical to that base.
- The backstop for a merge that actually landed is the merge executor: it reads
  the pull request before merging and settles an already-`MERGED` one instead
  of merging again. A landed merge therefore cannot be re-merged.

Stops without a `re-authorize` answer, and stops whose answer postdates the
latest mechanical authorization, keep the human confirmation path unchanged.
