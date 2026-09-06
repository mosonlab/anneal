# 0001 - Narrow the merge lease hold window

Status: superseded by ADR-0003 (2026-08-28)

## Amendment (2026-08-26): the independent review and the release-authority check are retired

Two layers the original analysis covered no longer exist in the merge tail.
The decision below is kept; the incident timeline, the call-site inventory and
the findings that produced it are kept in operator documentation outside the
repository, as history rather than current protocol.

Retired:

- **The independent blind review of defense-list diffs.** Gone with it:
  `createReviewObligation`, the review obligation markers and the
  `INDEPENDENT_REVIEW_OPEN_PREFIX` park and handback, the review completion
  path, the three blocking rounds (`MAX_BLOCKING_REVIEW_ROUNDS`), and the
  review-driven follow-up cards. Defense-list detection survives but is
  audit-only: when a diff touches a defense-list path, merge readiness writes
  one inbox message on the readiness task naming the triggered paths and
  reasons, and the merge proceeds unblocked. Nothing in the tail blocks on a
  review any more. (This is unrelated to the in-chain review template steps
  `code-review-sol` and `code-review-opus-blind`, which are unchanged.)
- **The release-authority Ed25519 signing layer.** Gone with it: the authority
  key material, the signing and verification module, the `db:authority-check`
  npm script the regression step ran before the gate, the migration preflight's
  `authority` condition, the authority-resign worker, and the
  `authority-resign` regression verdict.

What that retires in this record:

- R1's first bullet ("when readiness parks on an open review obligation, it
  releases") has no subject: readiness never parks on a review. The rest of R1
  stands and is in force - readiness acquires the Lease, once and without
  polling, immediately before it writes an authorization, and re-affirms its
  claim inside the authorization transaction.
- R2 item 2's ordering no longer includes a release-authority check; the acquire
  moves to immediately before gate dispatch, after semantic verification.
- The first consequence below (base drift during an independent review becoming
  an ordinary path) does not apply. Drift is still handled by the same requeue,
  but the review is no longer a window in which it happens.
- The "move the review" / "run the review concurrently" alternatives are
  historical only; there is nothing left to move or parallelise.

Unaffected and still current: the Lease itself and its hold window, gate
attestation, the merge gate's build, lint, and test steps, and the `pass`,
`gate-fail`, and `refresh-conflict` regression verdicts with their gateProof
binding. R3 stands, and the retirements only shorten the holds it asks to be
re-measured.

## Context

`scripts/merge-lease.sh` serialises the final merge window on `main` through one
ref on `origin`. The segment that must be held is `fix the baseline -> run the
gate -> merge`; nothing else in the tail produces or consumes the gate proof.

On 2026-08-26 two delivery lines ran concurrently and the lease became the
throughput bottleneck. One chain held it for 62 minutes and merged nothing:
most of that was semantic verification and an independent review, neither of
which touches the proof. The other chain's regression run released the lease
itself, from a shell line whose push had already failed, so its merge later
landed under the first chain's hold and voided that chain's baseline. Acquire
was a sentence in the regression prompt; release was control-plane code at
nine call sites. The measured timeline, the call-site inventory and findings
A-E (review inside the lock, ordering, the stray release, thresholds, semantic
verification inside the lock) are kept in operator documentation outside the
repository.

## Decision

The defect the findings share is an asymmetry: **release is entirely
code and acquire is entirely a prompt.** Nine control-plane call sites give the
lease back; one model, following a sentence in a template, takes it. A mutual
exclusion protocol half-executed by something that does not have to follow the
protocol produces exactly the stray release observed - a release nobody asked
for, issued after the push on the same shell line had already failed, with no
exit code checked.

Closing the asymmetry completely would mean the control plane acquiring for the
regression run. That is worse, not better: the control plane cannot see inside a
run, so a lease taken for the run covers the whole run, including semantic
verification (39 minutes in the observed incident). Correct granularity there
needs the regression step split in two, which is a template shape change. So
the asymmetry closes at the one point where the lock is actually load-bearing.

### R1. The control plane takes the lease where the lock is load-bearing

The segment that has to be serialised is the one `CONTRIBUTING.md` ("Delivering
to main") describes and no larger: from the base an authorization pins to the
merge that consumes it. That segment is entirely inside the control plane, and
it is about twenty seconds long. So:

- When readiness parks on an open review obligation, it releases. The review
  reads a diff on GitHub; it neither produces nor consumes the proof.
  (Retired 2026-08-26 with the independent review itself - see the amendment.)
- Before it writes an authorization, readiness acquires - one attempt, never a
  poll, since a tick cannot block on a lock another line may hold for minutes.
  `merge-lease.sh acquire --timeout-minutes 0` already exits 75 on contention,
  so `scripts/merge-lease.sh` is not touched. A tick that cannot take the lease
  leaves its step claimed; the claim expires after
  `READINESS_CLAIM_LEASE_MS` and a later tick tries again, which rate-limits the
  retry to roughly the script's own poll interval for free.
- Because the acquire is a network round trip spent inside the claim's lease,
  the authorization transaction re-affirms the claim before it writes anything.
  Without that, a worker that lost its step while acquiring could queue a second
  merge execution.

Acquire is idempotent for one task id, so in the ordinary case - no drift, no
stray release - readiness's acquire finds the lease already held for the same
chain and changes nothing.

This also closes the stray release's blast radius: with readiness taking the
lease before the only action that consumes the proof, a stray agent-side release
costs a re-acquire instead of an unleased merge.

Scope: `packages/api/src/merge-lease.ts` and
`packages/api/src/merge-readiness-worker.ts`. This is a merge automation path on
the defense list; it was authorized explicitly on 2026-08-26.

### R2. Not a project of its own; rides the next template rollover

1. State the release contract in both regression prompts: the control plane owns
   release; the run never calls `release` or `steal`. (Fixes the stray release
   at the source.)
2. Move the acquire from "before the first fetch" to immediately before gate
   dispatch, after semantic verification passes, and add a post-acquire re-check
   that the base head has not moved since the refresh - re-fetch and re-merge if
   it has. (Takes semantic verification out of the lock. The release-authority
   check that used to sit between the two was retired on 2026-08-26.)
3. Amend `AGENTS.md:101` in the same change, since (2) contradicts its current
   wording for the chain tail.

Implemented by the `regression-verification-v2` template rollover. The output
kind is the structural generation marker: renamed v1 rows preserve their
frozen prompts and schema, while new canonical rows require schema version 2
and the narrowed lease protocol above.

### R3. Revisit `STALE_SECONDS` and the acquire timeout after R1

With R1 and R2 the tail's hold drops to roughly gate plus authorization plus
merge. Re-derive the thresholds from measured holds then; changing them now
would only paper over the review and the semantic verification sitting inside
the lock.

#### Amendment (2026-09-06): the threshold applies unless the caller says `--human`

`STALE_SECONDS` is still 45 minutes. What changed is who it applies to.
`merge-lease.sh steal` used to treat a terminal on any standard stream as a
human and skip the threshold, so whether the machine rule applied depended on
how the command was launched rather than on what the caller claimed: an
operator stealing interactively bypassed it without ever saying so, and the
same command in a pipeline did not. Only `--human` waives it now, and a refusal
prints how much of the window is left.

The measurements R3 asks for now exist on both sides of the lease: chain-tail
holds were already recorded as `MergeLeaseEvent.heldForSeconds`, `merge-train`
reports `leaseHeldForSeconds` on its own release through the same adapter, and a
chain shut out of the lease for longer than
`MERGE_LEASE_CONTENTION_ALERT_MINUTES` (default 30) is recorded as a `contended`
event and alerted once to the operator. Nothing steals automatically, so the
thresholds can be re-derived from recorded holds rather than from the queueing
they cause.

## Alternatives considered

- **Do nothing; raise the thresholds (R3 alone).** Cheapest, changes no
  behaviour, and leaves the queueing exactly as observed. Rejected as a
  standalone answer: it treats the symptom.
- **Move the independent review before the gate.** Not possible. The review
  reviews `baseSha..headSha` on the refreshed head, which does not exist until
  the refresh, and its value is that it is bound to the exact head that will be
  merged.
- **Run the review concurrently with the gate.** Attractive on wall clock - the
  tail becomes `max(review, gate)` instead of the sum - but it requires the
  control plane to learn the refreshed head before the regression run finishes,
  which today it only learns from the run's final output. Larger change, and
  orthogonal to the lease: it shortens the tail without narrowing the lock.
  Worth reconsidering after R1.
- **Fix the stray release with a prompt-only edit.** Blocked by the frozen-prompt
  rule: once a task has been created from a step, canonical sync refuses to
  change that step's prompt, so a prompt rewrite must ride a template rollover.
  R1 defuses it instead, and R2 fixes it properly at the next rollover.
- **Give the control plane the acquire as well, for the regression run.** The
  symmetric-looking answer, and the wrong one: it widens the lock to the whole
  run rather than narrowing it, because the control plane cannot see the point
  inside the run where the base gets pinned.

## Consequences

- Base drift during an independent review becomes likely rather than rare, so
  the requeue path in `merge-readiness-worker.ts` moves from a rarely-exercised
  safety net to an ordinary path. It costs the drifting chain one full
  regression run, semantic verification included. (Retired 2026-08-26: with no
  review in the tail, this window is gone. The requeue path is unchanged and
  still the safety net for drift from any other cause.)
- The exact-head correctness argument is unchanged: it never rested on the
  lease. R1 removes an efficiency guarantee over one segment, not a safety one.
- Concurrent delivery lines stop paying each other's agent-session time. Under
  the observed incident, `65d229d6` would have acquired at about 12:11:48
  instead of 12:20:05, and `ff7a6904`'s wasted 44-minute hold would not have
  happened at all, because `af3c73f5` would have had to acquire before merging
  PR #138.
- New v2 chains keep semantic verification outside the lock. Renamed v1 chains
  retain their original protocol as immutable execution history.

## Related authority

- [ADR 0003: Acquire the merge lease in readiness](0003-acquire-merge-lease-in-readiness.md), which supersedes this record
- [ADR 0002: Coordinate concurrent host deliveries with cumulative merge prefixes](0002-coordinate-main-delivery-with-merge-trains.md)
