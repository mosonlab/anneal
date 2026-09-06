## Goal

`scripts/deploy/launchd-service-wrapper.unprefixed.mjs` no longer exists, and an unprefixed Darwin install renders its wrapper from `scripts/deploy/launchd-service-wrapper.mjs` like every other install.

## Background

PR #454 namespaced runner identities with `AGENTOS_RUNNER_ID_PREFIX` and kept a byte-frozen copy of the pre-prefix wrapper, `launchd-service-wrapper.unprefixed.mjs`, which `install-launchd.mjs` selects through `serviceWrapperSource` whenever the prefix is empty. Its only purpose was to keep the maintainer's then-production unprefixed Mac install byte-identical while the prefix landed. On 2026-09-06 that Mac was migrated to the runner-only profile with `AGENTOS_RUNNER_ID_PREFIX=mac-`, so no installation renders through the frozen copy any more, and the repository carries two 460-to-508-line wrappers that must be kept in lockstep by hand.

Route: implementation=senior-dev-astra-medium - deploy installer plus fixture regeneration across two platforms; the review tail must judge fixture diffs, not just tests.

## Changes

1. Delete `scripts/deploy/launchd-service-wrapper.unprefixed.mjs`, the `UNPREFIXED_SERVICE_WRAPPER_SOURCE` constant, and the empty-prefix branch of `serviceWrapperSource` in `scripts/deploy/install-launchd.mjs`, so the single wrapper is selected for every prefix including the empty one.
2. Remove the unprefixed-wrapper SHA freeze and any test that asserts the unprefixed render matches the pre-#454 bytes (`scripts/deploy/launchd-service-wrapper.test.mjs`, `install-launchd*.test.mjs`, auto-deploy suite fixtures); replace it with the assertion that an empty-prefix render produces the same labels and `RUNNER_ID`s as before (`com.agentos.runner`, `com.agentos.runner-2`…; `runner-1`, `runner-2`…), i.e. identity is preserved even though the wrapper bytes change.
3. Regenerate the Darwin baseline fixtures under `scripts/deploy/fixtures/` from the single wrapper, using the repository's documented regeneration procedure; every regenerated fixture diff must be explainable as the wrapper-file change alone.
4. `public-snapshot.json`: remove the entry for the deleted file if one exists.

## Out of scope

- Any change to the prefix-aware wrapper's behaviour, the Linux systemd path, `service-inventory.mjs`, or runner identity rules.
- Any change to the installed state on the maintainer's hosts; this chain changes the repository only.
- `docs/runbooks/quiet-window-auto-deploy.md` (a separate chain is rewriting it).

## Constraints

- An empty-prefix Darwin render must keep the pre-existing labels and `RUNNER_ID`s exactly; a changed identity is a defect, not a fixture update.
- No fixture may be edited by hand; regenerate and commit.
- Fail loud: no fallback to a missing wrapper path.

## Acceptance

- `git ls-files scripts/deploy | grep unprefixed` prints nothing; `grep -rn "unprefixed\|UNPREFIXED" scripts/ packages/` prints nothing outside the CHANGELOG.
- `npm run test:auto-deploy` passes on the merge gate's Linux worker, and the hermetic developer-Mac form from PR #497 passes when run on macOS.
- `node --test scripts/deploy/launchd-service-wrapper.test.mjs scripts/deploy/service-inventory.test.mjs` passes.
- `npm run lint`, `npm run typecheck`, `npm run test:snapshot-scan` pass.
- The PR body lists every regenerated fixture and states that the empty-prefix labels and ids are unchanged.