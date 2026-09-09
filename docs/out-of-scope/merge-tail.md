# Merge-tail designs

## merge-queue

### Decision

A bisecting merge queue is not built.

### Why

After ADR-0003 the lease covers only the final re-check plus the merge, held
for well under two minutes, and refresh conflicts are rare, so a queue would
buy nothing; when the recorded revisit threshold was later met, the existing
merge train (ADR-0002, ADR-0004) was wired to chains instead.

### What exists instead

The merge train with the executor publishing under its own identity and a
two-parent check; after base drift only the gate re-runs, not semantic review.

### Revisit when

The merge train cannot keep main moving under the observed chain concurrency.

## short-timeout-lease-requeue

### Decision

Regression does not replace its blocking lease acquire with a short timeout
that ends the run and asks the control plane to requeue.

### Why

A requeue is a whole regression round including semantic review, traded against
minutes of waiting; a ref lock has no queue fairness so waiters starve; unplaced
runs consume the task's session budget; and a new "unfinished but not failed"
terminal state forces every run-completion branch to re-answer whether to
release the lock.

### What exists instead

Blocking acquire.

### Revisit when

Lease waiting develops a long tail.

## runs-release-or-steal-lease

### Decision

A run never releases or steals the merge lease; acquire and release both carry
the owning task.

### Why

A model once executed half of the mutual-exclusion protocol in one shell line,
releasing the lock after a failed push and reporting the wrong exit status,
which invalidated another chain's long hold.

### What exists instead

The control plane owns the lease; push and lease operations are separate
statements each checking their own exit code; `--force` is the only holder-check
bypass.

### Revisit when

No condition recorded.
