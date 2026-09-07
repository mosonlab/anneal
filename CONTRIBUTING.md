# Contributing

## The current state of contributions

Anneal v0.8.0 is a Developer Preview. **We are not yet accepting outside pull
requests.** Contributions currently take the form of:

- Bug reports with the release tag or commit, platform, command, and exact
  error. See the [support matrix](docs/release/support-matrix.md).
- Documentation corrections naming the file, line, and discrepancy.
- Private security reports through [SECURITY.md](SECURITY.md), never public issues.

This file will announce when outside pull requests open and describe the process.

## If you are working in a fork

The following rules apply to every repository change, including forks.

### The gate

`scripts/merge-gate.sh` is the only CI. It pins candidate and baseline, checks
frozen records and its profile classifier, then selects proof from that diff:

- `docs-only`: content-only edits to an explicit prose allowlist; checks diff
  hygiene, the closed public snapshot, and final HEAD/worktree drift.
- `full`: additions, deletions, renames, mode changes, runtime-coupled docs, code,
  config, or unknown paths. Runs clean `npm ci` with database client generation,
  database CLI typecheck, repository lint and build, unit tests, gate-schema
  migration, database tests, and final drift verification.

The gate selects the profile; callers cannot request the cheaper one. Parallel
execution does not omit checks; a group passes only when every member passes.
Run one gate per worktree; a verdict belongs only to the exact commit it names.

```sh
scripts/merge-gate.sh --expect-head <oid>
```

Inside an Anneal Run (`AGENTOS_RUN_ID` set), run affected workspace checks and
named test files, such as `npm run lint -w <workspace>`. Regression owns
repository-wide proof. Root `build`, `lint`, `typecheck`, `test`, `test:db`, and
`merge-gate` scripts refuse with exit **78**; direct gate invocation returns
`GATE NOT RUN:` and **76**. Runs have no scratch PostgreSQL. Database tests are
merge gate evidence: never attempt them inside a Run, including named files,
or report their absence as a gap. `test:db -w @anneal/api` also exits **78**.
A replay dbtest for a one-shot data migration is retired in the first release
after the migration shipped.

Run workspace verification shares a host proof-slot pool (default 3;
`AGENTOS_HOST_PROOF_SLOTS` accepts 1–1024). Waits of at least 60 seconds are
reported while waiting and on admission; a 20-minute timeout exits **75**.
Run workspace tests use `--test-concurrency=2`. Regression and host commands
bypass proof slots; host tests retain Node's default concurrency.

The local gate is available to every clone. Remote workers require explicitly
configured operator infrastructure; the repository provides no host or credentials.
One check outside the gate remains a developer responsibility:
`npm run verify:compose-binding`.

### Delivering to main

Only maintainers with write authority to the target `origin` may advance it.
Work in your own branch and isolated worktree; keep the shared checkout on
`main` without feature commits or branch switches. Prefer native worktree
support, otherwise use `git worktree add "$(mktemp -d)/checkout" <branch>`.
Stage only your changes and remove the worktree after merge.

Push the feature branch and open its PR before dispatching the gate. GitHub
recognizes an existing PR as merged after fast-forward publication, but refuses
to create one after `main` already contains its head.

For one candidate:

1. Acquire `scripts/merge-lease.sh` before proving the final integrated head;
   hold the lease through publication. Pass `--task <id>` to both `acquire` and
   `release` so windows sharing `user@host` cannot release each other's lease.
   Implementation, feature push, and PR creation need no lease.
2. Require `MERGE GATE: PASS <oid>` for that exact integrated head. If other
   gates may run and remote capacity is configured, use
   `AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" packages/runner/runtime-tools/gate-worker/gate-dispatch.sh <oid>`;
   otherwise run the local gate. Read the [worker runbook](docs/runbooks/gate-worker.md)
   before operating a remote worker.
3. Publish the proved head, then release your lease.

When two or three host PRs are ready together, feature windows push, open PRs,
and hand one coordinator ordered `(PR number, exact head OID)` tuples. They
neither acquire the lease nor advance `main`. The coordinator reads the worker
runbook and uses the authenticated `gh` CLI to verify exact PR state for one
cumulative batch:

```sh
scripts/merge-train.mjs \
  --task <coordinator-id> \
  [--lease-wait-minutes <n>] \
  --candidate <pr>:<40-character-head> \
  --candidate <pr>:<40-character-head> \
  [--candidate <pr>:<40-character-head>]
```

The train gates nested merge prefixes concurrently, then acquires the lease to
publish the longest contiguous PASS prefix. Conflicts stop at the preceding
prefix; the coordinator does not resolve them. Stale `main` publishes nothing.
After partial publication, rerun the command: it skips heads already in live
`main` and rebuilds the remaining prefixes.

The train acquires the lease only after its gates pass, waiting up to ten
minutes by default when another window holds it. Set `--lease-wait-minutes <n>`
to a non-negative integer to change that bound; zero makes acquisition
immediate. If the wait expires, the train returns `lease-contended` with the
elapsed wait in `leaseWaitedMs`. After acquisition, unchanged `main` lets the
already-gated prefixes publish without rerunning gates; moved `main` returns
`stale-base` and publishes nothing.

Chain publication follows the control-plane merge train when the API's
`MERGE_TRAIN_WIDTH` is greater than zero. Merge readiness groups up to that
width of ready candidates per Repo in FIFO order, acquires one Merge Lease
under the first candidate's Chain target, and hands the detached `merge-train`
Task a cumulative candidate list. The train authorizes the longest contiguous
passing prefix, after which merge execution publishes the prefixes. A single
non-drifted candidate continues through the single-candidate path; unset or
`0` keeps the existing Chain delivery behavior. Base drift under enabled train
readiness does not trigger a per-Chain Regression re-run: the train's Merge
gate and readiness second read check the cumulative prefixes before
authorization.

Do not pre-acquire under the train's task id: it widens the lease hold across
gating instead of publication only. Never pre-acquire with another task's id
or steal a lease another window holds.

Changes to delivery authority, merge train, lease, dispatcher, or gate use the
existing single-candidate path. New delivery machinery cannot authorize its own
first publication.

### Testing red lines

- Set `export RUNNER_WORKSPACE_ROOT=$(mktemp -d)` before tests. Also pin `home`
  in hand-built `RunnerConfig` objects to a temporary directory: runner tests
  provision real workspaces and persistent repository mirrors.
- Database tests destroy their targets. Use a throwaway PostgreSQL for
  `TEST_DATABASE_URL` and `TEST_DATABASE_MAINTENANCE_URL`, with a distinct
  non-`public` `?schema=` per worktree. Set `AGENTOS_ALLOW_SCRATCH_DATABASES=1`
  and a password of at least 24 characters; tests spawning the API inherit it
  as `POSTGRES_PASSWORD` and enforce the startup password check.
- Do not commit during a database suite: `build-provenance.dbtest.ts` requires
  the build stamp to match the worktree commit.
- Edit canonical templates in `agents/templates/` and deliver through a PR;
  the closed sync contract still applies. Operators may edit unused,
  non-canonical clones through the [API](docs/operator-api.md).
- A checkout named by a loaded service is an appliance checkout. Follow the
  [deployment ownership contract](docs/runbooks/quiet-window-auto-deploy.md)
  and develop in a separate worktree.

Fresh-worktree typechecks, unit tests, and focused API database tests need
`npm install` and `npm run db:generate`, but no prior workspace build.
Workflows executing built artifacts run after the Merge Gate's full build.

### Development database bootstrap

`npm run db:migrate` runs `prisma migrate dev`, bypasses release preflight, and
may rewrite development migration history. Use it only on disposable developer
databases, never for installation or upgrades. The release install command is
`npm run db:migrate:release -- --fresh`.
The release-cut commit (`chore(release): prepare`) updates
`RELEASE_CANDIDATE_MIGRATIONS`; ordinary migration additions leave it unchanged.
A migration timestamped before the recorded terminal but merged after the cut
is the exception: its merge must update the pin. See the pin contract in
[release-migrate.ts](packages/db/src/release-migrate.ts).

### The public surface is closed by default

Every tracked file must be classified in `public-snapshot.json`. Add published
files with a purpose or excluded files with a reason; an unclassified path
fails the scan. `npm run snapshot:scan` requires a clean worktree matching `HEAD`.

### Records that do not change

Finished records under `docs/reviews/`, `docs/merge-notes/`, `docs/briefs/`, and
`docs/plans/archive/` are append-only history, not current authority. They live
in private operator documentation and are not contribution prerequisites.
The gate's `scripts/check-frozen-docs.sh` would enforce these directories if
present and validates `> Superseded by ` markers in all tracked Markdown.

### Style

Match surrounding code. Comments explain reasons and failed alternatives;
understand the failure a comment guards before removing it.
