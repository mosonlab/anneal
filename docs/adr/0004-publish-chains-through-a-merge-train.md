---
status: accepted
date: 2026-09-07
---

# Publish ready Chains through a merge train

## Decision

When `MERGE_TRAIN_WIDTH` is greater than zero, Merge readiness may authorize
several ready Chains for one repository from one cumulative merge train. The
value is an API startup setting from `0` through `3`; it is `0` when unset, so
the existing single-candidate tail remains the default. A value greater than
zero bounds the number of candidates in one train.

On each readiness tick, the control plane groups candidates by Repo and reads
the live default-branch head. A candidate is eligible when its Chain's
Regression verification has a valid exact-head `regression-verification-v2`
PASS bound to `(headSha, baseHeadSha)`, and its recovery aggregate is neither
`REPAIRING` nor `BLOCKED_DOWNSTREAM`. Eligible candidates are ordered FIFO by
the time their Regression evidence was persisted. A train is formed when at
least one eligible candidate's evidence base has drifted from the live head or
when at least two eligible candidates are ready. One non-drifted candidate
continues through the existing single-candidate path.

The train is represented by one detached platform Task with kind
`merge-train`. It is an `AGENT` Task, has `maxSessionsPerTask: 1`, and is
staffed by the Agent bound to the first candidate Chain's Regression
verification Step. Its description gives the session one action: run
`"${AGENTOS_TOOLS}/merge-train.sh"` with the candidate list in the claim
metadata, then finish. The claim records `baseSha`, `width`, and the ordered
`candidates` entries (`taskId`, `chainId`, `headSha`, and `branch`). The task
does no implementation or semantic work.

Every candidate readiness Task receives a `mergeTail.train` marker naming the
train Task and its one-based position. The detached Task is shown on the board
with its candidate list; after settlement its description also shows the
recorded verdict for each position. Each candidate readiness Task receives one
activity entry naming the train Task, position, and settlement. A failed,
blocked, or aborted train writes the existing stop notice once per affected
candidate, so a failure is visible on both the board and Inbox.

## Lease window

Merge readiness acquires the repository's global Merge Lease for the train
under the first candidate's Chain lease target before the detached Task is
enqueued. A failed acquire defers the tick using the same behavior as
`withMergeLease`; it does not start a second train. While the Lease is held,
single-candidate readiness for that repository is deferred. The Lease remains
held across the train Run, record validation, the second-read checks, and the
serializable settlement and authorization transactions. It is released after
the last authorization is written or on every failure path. Merge executor's
publication of the authorized prefix happens after that handoff and is outside
this Lease, as it is for the single-candidate path.

If the train Run ends without a stored `merge-train-v1` record, or the Run is
lost, the control plane releases the Lease, writes a `mergeTail.train` marker
with `state: "aborted"` and the named reason on every candidate, and returns
the candidates to `ready` for a later tick. The detached Task is not retried.
The deferred-release handling also applies after a process restart, so a lost
train cannot retain the repository Lease.

## Authorization contract

After the runtime tool stores its record, readiness parses it with
`parseMergeTrainRecord`. Authorization is allowed only when the record's
`baseSha` equals the live default-branch head and every record
`candidateHeadSha` equals the corresponding Chain's evidence `headSha`.
Readiness then performs the existing second-read discipline once per candidate
with the train base, still under the Lease. A stale base or mismatched
candidate head fails closed: no candidate is authorized and the Lease is
released.

For positions `1` through `contiguousPassCount`, readiness writes
`merge-authorization` outputs in order and hands each one to merge execution.
Each output carries a `train` object whose `publishHead` is the cumulative
prefix OID at the passing position, `predecessorOid` is that candidate's own
prefix predecessor, `ref` is `refs/anneal/train/<publishHead>`, `position` is
the one-based candidate position, and `trainTaskId` identifies the detached
Task. The existing per-candidate Approval gate still applies before its
authorization is written.

All state changes use the same serializable transactions and Chain locks as
the existing merge tail. The record's base and candidate heads are checked
again at authorization time; a train never authorizes evidence for an old live
head.

## Settlement

The runtime record's first non-passing prefix determines the downstream
settlement. Only the longest contiguous PASS prefix is authorized.

| Record position or event | Settlement |
| --- | --- |
| `pass` within `contiguousPassCount` | Authorize the candidate in order with its `train` object. |
| First `fail` prefix | Enter the existing `gate-fix` repair path through `enterRepair`, with `headSha` set to the candidate head and `baseHeadSha` set to that prefix's predecessor OID; charge the existing repair budget. |
| `no-verdict` prefix | Return that candidate to `ready` unchanged for a later train. |
| Every `skipped` candidate | Return the candidate to `ready` unchanged for a later train. |
| `blocked` candidate | Enter the existing refresh-conflict recovery stop with the recorded reason. |
| Missing record or lost train Run | Abort the train, release the Lease, mark every candidate `aborted`, and return the candidates to `ready`. |

None of these train settlements invokes `requeueRegressionSettlement` for
base drift. In particular, a gate-fix repair uses the cumulative prefix's
predecessor as its base and retains the existing repair budget and task shape.

## Semantic verification trade-off

Regression's original evidence still includes semantic verification. With the
train enabled, a base move does not start a per-Chain Regression re-run. The
runtime tool gates the cumulative prefixes, and readiness performs the
mechanical second-read checks against the live train base before it writes an
authorization. This deliberately trades repeating semantic verification after
every base move for one shared Merge gate and one Lease window. Operators that
need the existing per-Chain drift recovery can set `MERGE_TRAIN_WIDTH=0`.

## Consequences

- A base move invalidates one shared train record rather than authorizing any
  stale candidate; a stale record authorizes nothing and releases the Lease.
- Two or three ready candidates can share cumulative prefix construction and
  Merge gate work, while publication remains serialized by merge execution.
- A failure at one prefix prevents later prefixes from crossing it. Later
  candidates are either returned to `ready`, stopped with their recorded
  reason, or repaired according to the settlement table; no path silently
  retries a train.
- The train Task is detached from every Chain, but each readiness marker and
  activity retains the Chain and position identity needed for board and Inbox
  recovery.

## Related authority

- [ADR 0002: Coordinate concurrent host deliveries with cumulative merge prefixes](0002-coordinate-main-delivery-with-merge-trains.md)
- [ADR 0003: Acquire the merge lease in readiness](0003-acquire-merge-lease-in-readiness.md)
- [`docs/operator-api.md`](../../docs/operator-api.md), "Merge-train readiness"
- [`packages/runner/runtime-tools/merge-train.sh`](../../packages/runner/runtime-tools/merge-train.sh)
- [`packages/db/src/merge-tail.ts`](../../packages/db/src/merge-tail.ts)
