## Goal

On `AGENTOS_DEPLOY_ROLE=runner`, `scripts/deploy/quiet-window-deploy.mjs` starts without `GITHUB_READ_TOKEN`, `DATABASE_URL` or `FEISHU_DEFAULT_CHAT_ID` in `shared/.env`, and refuses when `OPERATOR_TOKEN` is missing; the control-plane role keeps its current three-key check.

## Background

Issue #509. `loadSharedEnvironment` in `scripts/deploy/quiet-window-deploy.mjs` (around lines 323-328) fails with `environment-unreadable` unless all three keys are present, regardless of role. The runner role omits backup, guarded migration, Prisma client generation and canonical prompt sync, and takes its target from the control plane's `GET /version` (`scripts/deploy/runner-role-target.mjs`, `requireRunnerDeployPreflight`), so none of the three is read on that path. Observed on 2026-09-06 while converting the maintainer's Mac to the runner role: `STOP environment-unreadable detail=GITHUB_READ_TOKEN-missing` on a host whose `.env` had every runner key; worked around by copying the control plane's token onto the runner host.

## Changes

1. `loadSharedEnvironment` takes the deploy role: for `runner` it requires `OPERATOR_TOKEN` and `RUNNER_TOKEN` and accepts `RUNNER_API_URL` when set (validated by `controlPlaneApiBaseUrl`); for `control-plane` the current `DATABASE_URL`, `FEISHU_DEFAULT_CHAT_ID`, `GITHUB_READ_TOKEN` check is unchanged. Refusal codes keep the `environment-unreadable` form with the missing key named.
2. `docs/runbooks/quiet-window-auto-deploy.md` "Preconditions" lists the per-role key sets (this chain edits only that bullet list; a concurrent chain reorders the document, so keep the edit to the Preconditions section).
3. Tests in `scripts/deploy/quiet-window-deploy.test.mjs`: the runner role refuses `OPERATOR_TOKEN`-missing and accepts a `.env` without `GITHUB_READ_TOKEN`; the control-plane role still refuses each of its three.

## Out of scope

- `requireRunnerDeployPreflight`, the installers, the launchd or systemd definitions, and any phase logic.
- The first-tick chicken-and-egg noted in the issue (a host converted to the runner role must first be activated on a release that carries the role); that is a runbook sentence for the other docs chain, not code.

## Constraints

- Fail loud with the key name; no defaults substituted for a missing key.

## Acceptance

- `node --test scripts/deploy/quiet-window-deploy.test.mjs` passes with the three new cases; `npm run test:auto-deploy` passes.
- `npm run lint`, `npm run test:release-docs` pass.
- The PR closes #509.