Merge lease: a contended lease is visible and alerted, and stealing requires an explicit human flag

Goal: when chains cannot acquire the merge lease because a holder left a stale ref, the platform records and alerts the contention instead of retrying silently, and `merge-lease.sh steal` treats a caller as human only when told so explicitly.

Background: the merge lease is one ref on origin (`refs/merge-lease/holder`, `scripts/merge-lease.sh`) with no heartbeat; a machine may steal after 45 minutes, a human immediately. The platform adapter (`scripts/merge-lease-adapter.mjs:19-33,104-118`) only acquires and releases; nothing on the platform side ever calls `steal`, so a lease left by a process killed after acquire blocks every other chain's readiness with `contended` (`packages/api/src/merge-lease.ts:524-527`) until an operator notices. `contended` is not logged, counted, or shown on the board, and there is no HTTP route exposing lease state. `merge-lease.sh:471-480` treats any TTY on a standard stream as a human and skips the 45-minute threshold, so an operator running it interactively bypasses the machine rule without asking. Hold durations are already recorded on release (`merge-lease-hold.ts`, `MergeLeaseEvent.heldForSeconds`); train-side holds (`scripts/merge-train.mjs`) are not.

Changes:
1. Count consecutive `contended` results per chain in the readiness worker; on the first contention write a `TaskActivity` naming the current holder (reason, task, acquiredAt from the lease blob), and after a configurable threshold (default 30 minutes of continuous contention) send one operator alert through the existing notification path and add a `MergeLeaseEvent` row of a new `contended` state. Do not steal automatically.
2. Add a read-only `GET /merge-lease` route returning the current holder (or none), its age, and the last 20 `MergeLeaseEvent` rows; document it in `docs/operator-api.md`.
3. In `merge-lease.sh`, remove the TTY heuristic: `steal` applies the 45-minute threshold unless `--human` is passed; interactive use without the flag prints the remaining time and exits non-zero. Update the usage text and `docs/adr/0001-merge-lease-hold-window.md`'s note about the threshold source.
4. Make `scripts/merge-train.mjs` record its own hold duration on release through the same adapter path so train and chain-tail holds are comparable.

Out of scope: adding a heartbeat to the lease, changing `STALE_SECONDS` or the timeout, automatic steal, changes to readiness ordering or requeue budgets (separate card), merge-train publication semantics (held chains).

Constraints: no lease semantics change: acquire, release and steal behave as before except for the explicit human flag; the alert is one per contention episode; the new route is read-only and operator-scoped.

Acceptance: `npm run test -w @anneal/api` green and `node --test scripts/merge-lease.test.mjs scripts/merge-lease-adapter.test.mjs scripts/merge-train.test.mjs` green; dbtests cover: contention writes the activity on first occurrence, alerts once after the threshold, and records the event row; the route returns holder and events; a fixture shows `steal` under 45 minutes without `--human` refuses even with a TTY, and with `--human` proceeds; the train records `heldForSeconds`. Handbook and ADR updated.

Route: implementation=senior-dev-opus-medium - operator chose Claude capacity; observability and an explicit flag, no change to lock semantics