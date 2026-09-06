## Goal

In two-host mode, `gate-dispatch.sh` keeps polling the primary worker's slots for a configurable grace period (default 6 minutes) before it tries the fallback slot, so a slow fallback worker receives gates only when the primary queue is genuinely long.

## Background

Two-host mode (`AGENTOS_GATE_PRIMARY_SERVER` + `AGENTOS_GATE_FALLBACK_SERVER`) tries the primary's two slots and then, in the same round, the fallback slot `remote-2`, then sleeps `GATE_DISPATCH_POLL_SECONDS` (30) and repeats until `GATE_DISPATCH_TIMEOUT_MINUTES` (60). The production fallback (`agentos-gate`, 4 vCPU / 3.7 GB) takes about 17 minutes per gate against about 5 on the primary (measured 2026-09-06 on main 44e9b326). With immediate fallback, a gate arriving while both primary slots are busy goes to the slow worker even though a primary slot frees within at most one gate duration; waiting is faster unless several gates are already queued. The dispatcher cannot see queue depth, so elapsed waiting time stands in for it. Operator ruling 2026-09-06: wait first, fall back late.

Route: implementation=senior-dev-astra-medium - changes merge-gate dispatch ordering in a defense-list script; a wrong timer means gates silently never reach the fallback or reach it immediately

## Changes

1. Add `GATE_DISPATCH_FALLBACK_AFTER_MINUTES` (default `6`, non-negative integer, `0` restores today's immediate fallback) next to the existing `GATE_DISPATCH_POLL_SECONDS` and `GATE_DISPATCH_TIMEOUT_MINUTES` in `packages/runner/runtime-tools/gate-worker/gate-dispatch.sh`, validated like `--timeout-minutes`.
2. In the dispatch loop, the fallback slot is attempted only once the invocation has been waiting for at least that many minutes with every primary slot busy (measured from the first round, the same clock as `DEADLINE`); a broken or unavailable primary slot does not count as busy, and the existing `FALLBACK_DISABLED` and `UNAVAILABLE_EVER` semantics are unchanged.
3. The wait log line states why the fallback was not tried yet (`fallback after <n> min; waited <m>`), and the line that finally tries it says so.
4. `scripts/gate-worker/gate-dispatch.test.mjs`: cases for fallback held during the grace period, fallback tried after it, `0` meaning immediate, and single-server mode unaffected. `docs/runbooks/gate-worker.md` documents the variable in the two-host topology paragraph.

## Out of scope

- Slot counts, single-server mode, local slots, `remote-gate.sh`, `mirror-push.sh`, `run-gate.sh`, `scripts/merge-gate.sh`, and any runner-side variable (the runner change is a separate chain, `feat/runner-gate-fallback-server`).
- Running any gate or gate-worker script inside the Run.

## Constraints

- Default behaviour changes only for two-host mode with a busy primary; every existing test in `gate-dispatch.test.mjs` passes unchanged except where it asserted immediate fallback, which is updated to set the variable to `0`.
- Fail loud on an invalid value at startup, before any slot is tried.

## Acceptance

- `node --test scripts/gate-worker/gate-dispatch.test.mjs` passes with the four new cases; `npm run test:gate-worker` and `npm run lint` pass.
- `git grep -n GATE_DISPATCH_FALLBACK_AFTER_MINUTES` shows gate-dispatch.sh, its test, and docs/runbooks/gate-worker.md only.