Deploy: an escalation latches the failing commit and a newer main commit is still attempted

Goal: a deployment escalation blocks redeploying the commit that failed, and does not block deploying a newer main commit unless the escalation reason is one that must stop all deploys.

Background: `scripts/deploy/quiet-window-lib.mjs` `decideInvocation` (`:105-113`) calls `checkEscalation()` before `readRemoteMain()`, and `checkExistingEscalation` (`scripts/deploy/quiet-window-escalation.mjs:26-28`) decides only from `reason ∈ retryableReasons` and `attempts < cap`; the marker records the target commit in `to` but the decision never reads it. The retryable allowlist (`quiet-window-deploy.mjs:109-118`) covers external transient causes; every commit-determined failure latches the whole job until an operator runs `--clear-escalation`, so a fix commit pushed to main cannot deploy itself. Argo CD's auto-sync semantics are the reference: the same revision is not retried, a new revision is attempted. `selfClearEscalation` already exists (`quiet-window-escalation.mjs:61-107`).

Changes:
1. Read the escalation marker's `to` (failed target commit) in the invocation decision. If origin/main now points at a different commit, and the marker's reason is a commit-scoped failure class (build failure, verification/readiness failure, migration failure for that commit), proceed with the new commit and record in the ledger that the previous escalation was superseded by the new target (the marker is retained for history, not cleared silently).
2. Keep a small set of host-scoped reasons that block every deploy regardless of commit (disk full, backup failure, a release directory left half-activated / activation unproven, unknown target); define the set explicitly in one place next to the retryable allowlist, with a comment per reason.
3. A new commit that fails with the same commit-scoped reason latches again against its own oid; no automatic retry of a commit that already failed.
4. Document the three classes (retryable-transient, commit-scoped, host-scoped) and the supersede behaviour in `docs/runbooks/quiet-window-auto-deploy.md`, including the ledger entry an operator will see.

Out of scope: readiness verification (D-02, separate card), the quiet-window wait deadline (D-04), operator rollback CLI (D-01), self-healing of any escalation, changes to the retryable allowlist membership.

Constraints: no marker is deleted by this logic; supersession is an additive ledger fact. A marker whose `to` is missing or malformed is treated as host-scoped (blocking). Behaviour on both systemd and launchd hosts is identical.

Acceptance: `npm run test:auto-deploy` green; fixtures cover: commit-scoped marker for oid A and main at B proceeds and writes a supersede ledger entry; same oid A does not proceed; host-scoped marker blocks even when main moved; malformed `to` blocks; retryable marker under cap keeps existing behaviour. The runbook lists the three classes.

Route: implementation=senior-dev-opus-medium - operator chose Claude capacity; the rule is specified per class and every branch is fixture-testable