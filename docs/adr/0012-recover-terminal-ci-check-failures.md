# 0012 - Recover terminal CI check failures

Status: Accepted (2026-09-23)

## Context

ADR-0011 made pending checks and base drift mechanical recovery cases, but a
terminal failed PR-head check still left a Chain waiting for an operator to
reject a stop card and paste the failed job log. GitHub Free private repositories
may expose no required-check list even while Actions checks fail.

## Decision

### K16 `bounded-ci-check-recovery`

A canonical Merge integrator stop on `check-failure-or-absence`, or on
`non-clean-mergeability` with `UNSTABLE`, defers its initial stop card to the
control plane. The worker verifies the existing Run, authorization, PR identity,
OPEN and non-draft state, exact head, target ref and forward base ancestry. It
reads every context in the PR-head rollup, including non-required checks. A
completed CheckRun with `FAILURE`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, or
`STARTUP_FAILURE`, or a StatusContext with `FAILURE` or `ERROR`, is a terminal
failure. `SUCCESS`, `NEUTRAL`, and `SKIPPED` are not failures; unfinished checks
remain with the existing bounded pending-check deferral.

For each failed Actions check, the worker binds the job URL and job metadata to
the authorized head and reads a bounded failed-step log tail. It passes the
check names, conclusions, and log excerpts as blocking findings to a new
Regression Run on the same Chain branch. Regression routes the findings through
the existing `review-fix` or `gate-fix` repair task, then reruns Regression,
Merge readiness and Merge execution. The repair instruction names the CI
environment and requires diagnosis from the logs. A real environment limit may
be skipped only explicitly, with its reason printed; skipping or relaxing tests
to mask a difference is prohibited.

The CI recovery allowance is two successful Regression births per Chain,
cumulative across heads and separate from the base-drift allowance. Each birth
records a control-plane TaskActivity with condition, failed check names,
ordinal, and remaining allowance. A repeated identical failure set on the
unchanged head has no progress and stops before spending another birth.

The existing stop question and default Feishu thread receive the reason when
the allowance is exhausted, evidence or logs cannot be read completely, no
terminal failure remains, or the repair made no progress. More than 100 rollup
contexts or eight failed checks exceeds the bounded evidence read and stops.
Third-party StatusContexts have no Actions job log and therefore stop. `BLOCKED`,
draft or non-OPEN PRs, unverified ancestry, and uncertain merge outcomes retain
their human boundary. A held Chain waits for Resume. Chain-row locking and
stop identity checks serialize the automatic birth against a human answer.

Exact-head authorization, Merge gate attestation, Run-birth guards, and the
project's Approval gate remain in force. Every repaired head must pass the full
Merge gate and merge preconditions again before publication.

## Consequences

This adds a read-only Actions job-log capability to the API's GitHub reader. A
token without Actions read permission cannot supply repair evidence and causes
an explicit stop. No new repair channel or GitHub write authority is added.

ADR-0011's terminal-failed-check human boundary is superseded by this bounded
case; its other boundaries remain effective.
