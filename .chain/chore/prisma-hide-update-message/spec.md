## Goal

Every Prisma CLI invocation made by the deploy scripts and the release migration path runs with `PRISMA_HIDE_UPDATE_MESSAGE=1`, so the auto-deploy error log carries only real errors.

## Background

Each control-plane deploy that migrates or regenerates the Prisma client prints Prisma's "update available" box (`npm i --save-dev prisma@latest ...`) to stderr, which lands in `~/Library/Logs/Anneal/auto-deploy.error.log` on macOS and the journal on Linux, on every tick that runs those phases. The banner is advisory and the deploy pins its own toolchain; the noise hides genuine stderr. Prisma honours `PRISMA_HIDE_UPDATE_MESSAGE=1` in the child environment.

## Changes

1. The deploy scripts set `PRISMA_HIDE_UPDATE_MESSAGE=1` in the environment of every child process that runs a `prisma` command (guarded migration, migrate status, client generation, drift check) in `scripts/deploy/*.mjs`, and `packages/db/prisma/release-migrate.ts` does the same for the commands it composes.
2. One test per site asserts the variable is present in the spawned environment (extend the existing spawn-recording tests rather than adding a new harness).

## Out of scope

- Upgrading Prisma; any change to which Prisma commands run or their order; `packages/db/prisma/migrations/**`.

## Constraints

- The variable is added, never substituted for other environment the child already receives.

## Acceptance

- `git grep -n PRISMA_HIDE_UPDATE_MESSAGE scripts/deploy packages/db` shows every prisma spawn site covered.
- `npm run test:auto-deploy`, `node --conditions=development --import tsx --test packages/db/src/release-migrate.test.ts`, `npm run lint`, `npm run typecheck` pass.