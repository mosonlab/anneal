## Goal

`docs/runbooks/quiet-window-auto-deploy.md` reads as a runbook whose production profile is Linux systemd, with the macOS launchd profile documented as the secondary, maintainer-unverified one, matching what `docs/release/support-matrix.md` and `docs/runbooks/merge-executor.md` already state.

## Background

Since the 2026-09-04 cutover the control plane, API, web console, PostgreSQL and the merge executor run on an Ubuntu host as systemd units (support matrix rows for Linux and the self-hosted merge executor, PR #480 and #483). The Mac remains a permanent runner-only host with six launchd Claude runners. The runbook still opens with "the maintainer's macOS appliance and Linux systemd deployment profiles", describes the control-plane host in terms of `com.agentos.api`, `com.agentos.inbox` and `com.agentos.web` launchd labels, puts the launchd install commands first under "Install service wrappers" and "Install auto-deploy", and reaches "Linux systemd" only as a later section. A reader following the document as written installs the profile nobody runs in production.

## Changes

1. The intro blockquote and the opening paragraphs state that the production profile is Linux systemd on the control-plane host, that macOS launchd is the profile for a runner-only Mac (and, historically, the former appliance), and that the macOS control-plane profile is maintainer-unverified; keep the existing sentence that the runbook is outside the Quickstart and the support commitment.
2. The "Runtime layout", "Preconditions", "Read-only verification", "Activation sequence", "Step deadlines and barrier watchdog", and "Failure and escalation" sections name the systemd unit form first and the launchd label form second wherever both exist; where a paragraph only makes sense for one platform, say which.
3. The Linux systemd material ("Linux systemd", "Two-stage install", "Runner count, accounts, and logs", "Activation and rollback") moves ahead of "Install service wrappers" and "Install auto-deploy", and those two launchd sections are retitled or introduced so a reader sees they apply to macOS.
4. The "Runner-only host" section says explicitly that the maintainer's Mac is this profile (six Claude runners following the control plane's deployed build, PR #462).
5. Every command, path, environment variable, deadline, exit code and refusal in the document is preserved verbatim; every existing heading text is preserved (headings may move, not be renamed) so that operator records and scripts that cite section titles keep resolving.

## Out of scope

- Any file other than `docs/runbooks/quiet-window-auto-deploy.md`.
- Any change to `scripts/deploy/*`, service inventories, manifests, or the installers the runbook describes.
- `docs/runbooks/merge-executor.md`, `docs/install.md`, `docs/release/support-matrix.md` (already aligned), and the root `CLAUDE.md`.
- Operator-side records and memories outside the repository.
- The frozen unprefixed launchd wrapper (separate Backlog card).

## Constraints

- Documentation only; the diff must be reviewable as reordering and reframing, not as new procedure. Do not invent commands or claims not already in the file or in the support matrix.
- Keep the document's ownership and activation contract intact: the sections a deployer must read before touching deployment directories remain present and complete.

## Acceptance

- `git diff --stat` for the merged change touches only `docs/runbooks/quiet-window-auto-deploy.md`.
- Line 3 of the file no longer opens with the macOS appliance as the first-named profile; grep for "macOS appliance" in the intro blockquote returns nothing, and the intro names Linux systemd as the production profile.
- `grep -n "^## \|^### " docs/runbooks/quiet-window-auto-deploy.md` lists the same set of heading strings as before the change (order may differ), and "## Linux systemd" appears before "## Install service wrappers".
- Every fenced command block present before the change is present after it, byte-identical (compare the set of fenced blocks).
- `npm run lint`, `npm run test:snapshot-scan`, `npm run test:release-docs`, and `node --test scripts/merge-gate-profile.test.mjs` pass.