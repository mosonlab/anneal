Deploy: a quiet-window wait that exceeds its budget alerts the operator and is recorded in the ledger

Goal: when the auto-deploy waits for a quiet window longer than a configured budget, the operator receives one escalation-style alert and the ledger records the wait, while the deploy keeps waiting; the wait distribution becomes measurable.

Background: `scripts/deploy/quiet-window-deploy.mjs` waits for the DB barrier in a `while (true)` loop with no deadline; the watchdog in `scripts/deploy/quiet-window-deadlines.mjs:106-143` starts only after the barrier is acquired; the only output is one HOLD line per poll (`quiet-window-deploy.mjs:540-547`, default 60 s) in the journal; the artifact is already built before the wait (`deploy-phases.mjs:16-21`) so the ledger sits at `ARTIFACT_PREPARED`; the systemd oneshot has no `TimeoutStartSec`. The control-plane quiet-window query is database-wide (`:703-729`), so a VM control-plane deploy waits for the Mac runners' Runs too (22 runners today). Under sustained chain load the deploy can lag indefinitely with no alert. Argo CD sync windows and Spinnaker execution windows always end; unattended-upgrades logs and mails when a window is missed.

Changes:
1. Add a configurable wait budget (default 45 minutes, environment-overridable) for the pre-barrier quiet-window wait. On crossing it, write one ledger event (`QUIET_WINDOW_WAIT_EXCEEDED` with elapsed seconds, target commit, and the count of blocking Runs by runner id) and send one operator notification through the existing escalation notifier path without creating an escalation marker; keep waiting. Do not repeat the alert more than once per hour.
2. Record every completed wait in the ledger entry for the attempt (`quietWindowWaitSeconds`, number of polls, peak blocking Run count) so the distribution can be read from the ledger afterwards.
3. Include in each HOLD log line the elapsed wait and the blocking Run count, not only that it is holding.
4. Document the budget, the alert, and how to read wait durations from the ledger in `docs/runbooks/quiet-window-auto-deploy.md`; state explicitly that the control-plane wait is database-wide and includes runner-only hosts.

Out of scope: any drain or admission change before the barrier, narrowing the quiet-window query scope, escalation classes (previous chain), readiness verification (previous chain), rollback CLI.

Constraints: no behaviour change to when the deploy proceeds; the alert is informational and idempotent per attempt; ledger schema additions are additive.

Acceptance: `npm run test:auto-deploy` green; fixtures cover: a wait crossing the budget writes exactly one ledger event and one notification, a second crossing within the hour does not re-notify, a wait under budget writes only the completed-wait fields; the HOLD line format includes elapsed seconds and the blocking count; the runbook section exists.

Route: implementation=senior-dev-opus-medium - operator chose Claude capacity; additive measurement with no change to deploy decisions, fully fixture-testable
