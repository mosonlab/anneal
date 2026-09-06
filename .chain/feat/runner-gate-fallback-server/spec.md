## Goal

A runner configured with `RUNNER_GATE_SERVER=<primary>` and `RUNNER_GATE_FALLBACK_SERVER=<fallback>` gives its sessions `gate-dispatch.sh`'s existing two-host topology: two slots on the primary, one on the fallback, tried in that order, then polling. A runner with only `RUNNER_GATE_SERVER` keeps today's single-server mode unchanged.

## Background

`packages/runner/src/config.ts` (around line 145) reads one destination, `RUNNER_GATE_SERVER`, validated by `optionalSshDestination`, and `packages/runner/src/adapters.ts` (around line 158) exposes it to the session as `AGENTOS_GATE_SERVER`. `gate-dispatch.sh` (`packages/runner/runtime-tools/gate-worker/gate-dispatch.sh`, ~74-82 and ~174-180) treats `AGENTOS_GATE_SERVER` as single-server mode with exactly one remote slot, while `AGENTOS_GATE_PRIMARY_SERVER` plus `AGENTOS_GATE_FALLBACK_SERVER` select two-host mode with slots `remote-1`, `remote-1-2` on the primary and `remote-2` on the fallback. The dispatcher already implements the wanted order (primary slots, then fallback, then 30-second polling with a 60-minute bound); only the runner cannot express it. Production today: the VM's runners use `RUNNER_GATE_SERVER=gate-self` (one slot on the VM) and the second worker `agentos-gate` sits idle; SSH from the VM to it is already configured.

Route: implementation=senior-dev-astra-medium - changes how canonical regression sessions dispatch the merge gate; a wrong environment mapping silently changes gate capacity or routes gates to the wrong host

## Changes

1. `config.ts`: read `RUNNER_GATE_FALLBACK_SERVER` through the same `optionalSshDestination` validation; refuse it when `RUNNER_GATE_SERVER` is unset (`RUNNER_GATE_FALLBACK_SERVER requires RUNNER_GATE_SERVER`) and when both name the same destination.
2. `adapters.ts`: when a fallback is configured, expose `AGENTOS_GATE_PRIMARY_SERVER=<primary>` and `AGENTOS_GATE_FALLBACK_SERVER=<fallback>` to the session and do not set `AGENTOS_GATE_SERVER`; when no fallback is configured, expose `AGENTOS_GATE_SERVER` exactly as today. Task secrets cannot override any of the three, matching the existing rule for the runner-owned gate variables.
3. Tests in `packages/runner/src/config.test.ts` and the adapters tests: fallback accepted, fallback-without-primary refused, identical destinations refused, and the session environment for each of the two shapes.
4. `.env.example` and `docs/runbooks/gate-worker.md` ("Agent sessions receive ..." paragraph) document the new variable and the resulting slot counts (primary 2, fallback 1) in one place; `docs/install.md` needs no change unless it enumerates runner gate variables.

## Out of scope

- `gate-dispatch.sh`, slot counts, polling or timeout values, `mirror-push.sh`, `remote-gate.sh`, and every gate-worker script.
- Local slots (`RUNNER_GATE_LOCAL_SLOTS`) and their precedence.
- Any deployment change; the operator sets the variable on the production runner host after this merges.

## Constraints

- Single-server behaviour is byte-identical when the new variable is unset: the session environment for that shape must be unchanged in the adapters test.
- Fail loud on an invalid or inconsistent destination at runner startup, before any poll.

## Acceptance

- `npm run test -w @anneal/runner` passes with the new cases; `npm run lint`, `npm run typecheck` pass.
- `git grep -n RUNNER_GATE_FALLBACK_SERVER` shows config.ts, adapters.ts, their tests, `.env.example` and `docs/runbooks/gate-worker.md`, nothing else.
- The PR body states the post-merge operator step: on the runner host set `RUNNER_GATE_FALLBACK_SERVER=agentos-gate` next to `RUNNER_GATE_SERVER=gate-self`; it takes effect when the runners next restart.