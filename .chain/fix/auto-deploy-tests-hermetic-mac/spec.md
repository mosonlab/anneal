## Goal

`npm run test:auto-deploy` on a developer Mac fails only for real regressions, not for the machine's own launchd state or a missing `systemctl`.

## Background

Every lane of deepening round 6 (2026-09-04) that ran `npm run test:auto-deploy` on the Mac reported the same two failures and had to argue in its PR body that they were pre-existing:

1. `scripts/deploy/systemd-installer.test.mjs` line 438, "default Darwin render, manifest entries, and plan stdout match 9a52c6ad bytes": the darwin plan reads the real `~/Library/LaunchAgents/com.agentos.api.plist` of the developer machine and its stdout diverges from the pinned bytes whenever that machine has the services installed.
2. `scripts/deploy/systemd-installer.test.mjs` line 2132, "runner auto-deploy stage one prints a stage-two command carrying the role": fails with `systemd-command-unavailable:systemctl` thrown from `scripts/deploy/install-launchd.mjs` line 866, because the test exercises the linux arm on a host without systemd.

The gate worker (Linux, no launchd state) is green on both, so the suite is correct there; the cost is paid on every Mac verification by every implementer, and it hides a real darwin regression behind an expected failure.

## Changes

1. The darwin plan test derives its home directory from a temporary root (the installer already takes the launchd agents directory from configuration or `HOME`; whichever it reads, the test pins it to a temp directory) so the real `~/Library/LaunchAgents` is never read. The pinned `darwin-9a52c6ad-baseline.json` bytes stay byte-identical.
2. The stage-one test either injects the systemctl path the installer resolves (`install-launchd.mjs` line 860 resolves a configured path with `accessSync`) with a stub executable under a temp directory, or skips with `t.skip("systemctl not on this host")` when neither a configured nor a PATH `systemctl` exists. Skipping is only acceptable if the same test remains a hard failure on Linux; a stub is preferred.
3. `npm run test:auto-deploy` on macOS with the services installed reports 0 failures.

## Out of scope

- Any change to the installers' behavior, the sudoers rendering, the systemd unit templates, or `launchd-service-wrapper.unprefixed.mjs` (sha256-pinned).
- Rewriting the 9a52c6ad baseline.
- Other suites' host dependencies.

## Constraints

- The linux arm must still fail loudly when `systemctl` is configured but not executable (`systemd-command-unavailable` stays).
- No environment-variable escape hatch that disables assertions.

## Acceptance

- On a Mac with `com.agentos.*` LaunchAgents installed: `RUNNER_WORKSPACE_ROOT=$(mktemp -d) npm run test:auto-deploy` reports fail 0.
- On the gate worker: the same suite has the same pass count as before this change (no test removed; at most one becomes a stub-driven test).
- `npm run lint` and `npm run typecheck` pass.
