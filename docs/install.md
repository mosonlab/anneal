# Installation notes and verification

This file holds the detail that used to live in the README. The authoritative
installation sequence is
[`docs/release/developer-preview.md`](release/developer-preview.md).

## Start locally

Follow the [Developer Preview quickstart](release/developer-preview.md) for its
prerequisites and complete, literal local installation sequence.

Once the installation is running, follow [Add a project](runbooks/add-a-project.md)
to add a GitHub repository and run A1's pull-request workflow.

The sections below cover the installation notes that are unique to this
document: experimental second-machine runners, repository mirror pre-seeding,
project onboarding, advanced delivery infrastructure, the templates release
demo, and verification.

## Runners on a second machine (experimental)

One installation can run its control plane on one machine and some runners on
another, for example Codex on Linux and Claude Code on a Mac. This shape is
experimental: it works, and nothing in Anneal is designed around it.

- The API listens on loopback only, by design. On the runner machine, forward
  that loopback with `ssh -L 3000:127.0.0.1:3000 <control-plane-host>` and keep
  `RUNNER_API_URL=http://127.0.0.1:3000`; the runner refuses any other origin.
- Give every runner its own `RUNNER_ID` and the installation's `RUNNER_TOKEN`.
  Each machine keeps its own repository mirrors and workspaces; nothing is
  shared over the network, and delivery is a Git push from the runner machine.
- Each machine signs in to the provider CLIs its runners use, and its runners
  set `RUNNER_SERVED_KINDS` to those kinds so a runner never claims work for a
  CLI that machine does not have.
- The tunnel's authentication, liveness and reconnection are yours. It adds no
  identity to Anneal, so the support matrix's remote-access row still stands.

## Pre-seed a repository mirror

Runners keep one bare mirror per remote repository under
`RUNNER_REPO_MIRROR_ROOT`. When that variable is unset, the mirror root is
`~/.agentos/repo-mirrors` (in the home of the runner account). A mirror
directory is named exactly `sha256(remoteUrl).git`: `remoteUrl` is the exact
remote URL string passed to the runner, hashed byte-for-byte without URL
normalization, and the lowercase hexadecimal SHA-256 digest is followed by
`.git`.

On a host whose runners have not started yet, pre-seed the mirror before
starting them. Run the procedure while logged in as the runner account; the
mirror root and everything below it must be owned by that account so the runner
can acquire its process-owned lock. Set `runner_home` to that account's actual
home rather than relying on the invoking shell's `$HOME`, choose the same remote
URL and mirror root, then run `git clone --mirror` directly into the computed
directory:

```sh
runner_home='/path/to/runner/home' # Replace with the runner account's actual home.
mirror_root="${RUNNER_REPO_MIRROR_ROOT:-$runner_home/.agentos/repo-mirrors}"
remote_url='https://github.com/example/project.git'
if command -v shasum >/dev/null 2>&1; then
  digest="$(printf %s "$remote_url" | shasum -a 256 | awk '{print $1}')"
else
  digest="$(printf %s "$remote_url" | sha256sum | awk '{print $1}')"
fi
mirror_dir="$mirror_root/$digest.git"
mkdir -p "$mirror_root"
git clone --mirror "$remote_url" "$mirror_dir"
git --git-dir="$mirror_dir" config --unset-all remote.origin.fetch
git --git-dir="$mirror_dir" config --add remote.origin.fetch '+refs/heads/*:refs/heads/*'
git --git-dir="$mirror_dir" config uploadpack.allowAnySHA1InWant true
git --git-dir="$mirror_dir" for-each-ref --format='%(refname)' |
while IFS= read -r ref; do
  case "$ref" in
    refs/heads/*|refs/tags/*) ;;
    *) git --git-dir="$mirror_dir" update-ref -d "$ref" ;;
  esac
done
```

`git clone --mirror` initially copies every advertised ref, including GitHub's
`refs/pull/*`. The configuration and cleanup above make the seed match the
runner's heads-and-tags mirror contract, so pull-request history is not retained
and later refreshes fetch only `refs/heads/*` plus tags.

Alternatively, copy the complete mirror directory with the matching digest
name from an existing host into the same mirror root, preserving or correcting
ownership for the runner account. Pre-seeding a host while its runners are
running is unsupported: stop all runners first because the mirror lock protocol
is process-owned.

## Project onboarding

The canonical Tier 0 and Tier 1 onboarding contract — including canonical
prompt synchronization, project-scoped installation and verification,
and full-tail readiness — lives in the
[Tier 0 / Tier 1 onboarding runbook](runbooks/add-a-project.md).
Follow that runbook after completing the installation sequence above.
An Agent or task template whose name is a canonical name is rewritten to the
canonical text on every deploy; a project that needs a different prompt uses a
different name.

## Advanced delivery infrastructure

Direct and Full Assurance are self-hosted workflows, not facilities the
Quickstart creates. Their operator supplies and configures every additional
dependency: the Codex, Claude Code and Pi CLIs and model entitlement required by
the selected roles; authenticated `gh` for GitHub pull-request creation;
SSH-reachable gate workers configured for single-server or primary/fallback
operation; and a private GitHub App plus the isolated `@anneal/merge-executor`
service for the mechanical merge. The public
[`gate-worker`](runbooks/gate-worker.md) and
[`merge-executor`](runbooks/merge-executor.md) runbooks document those two
services. Anneal bundles no host, credential, provider account or GitHub App,
and a missing prerequisite stops the chain rather than authorizing a weaker
merge. The merge executor has a
maintainer-verified Linux systemd profile and an unverified macOS LaunchDaemon profile;
the support matrix is authoritative.

When the control plane and runners are on separate hosts, install the second,
runner-only host with `AGENTOS_DEPLOY_ROLE=runner`, a nonempty host-specific
`AGENTOS_RUNNER_ID_PREFIX`, the loopback tunnel origin in `RUNNER_API_URL`, and
`OPERATOR_TOKEN` for the runner registry verification. Leave the control-plane
host at the default role; the runner host follows the control plane's deployed
build and verifies its runners against that build. See the
[Runner-only host](runbooks/quiet-window-auto-deploy.md#runner-only-host)
section of the quiet-window auto-deploy runbook for the service and phase
boundaries.

Read [`docs/release/security.md`](release/security.md)
before pointing this at anything, and
[`docs/release/migration-and-recovery.md`](release/migration-and-recovery.md)
before putting data in it.

`npm run db:migrate` is `prisma migrate dev`, and it is **development only**. It
is documented in `CONTRIBUTING.md`, not as an installation command. The guarded
release path above runs `npm run db:migrate:release -- --fresh`, which takes an
exclusive maintenance lock before it inspects schema state and holds it through
the guarded migration. `--existing` separately implements the verified-bundle
consumer, but this repository does not ship the backup producer needed to
create a conforming bundle. The supported release
workflow therefore remains fresh-only; `--existing` does not emit a synthetic
"interface unavailable" refusal and must not be treated as an end-to-end
supported migration path. The exact implemented sequence and refusal conditions
are in the release quickstart and migration guide. Packaging, notarization and
auto-update are not in this release candidate.

`npm run setup:local` writes `.env` once, at mode 0600, with distinct random
operator and runner tokens, a session-cookie secret, a base64 32-byte encryption
key, and one database password written identically into `POSTGRES_PASSWORD` and
`DATABASE_URL`. It also copies the required, operator-provided
`GITHUB_READ_TOKEN`; it never generates or prints that credential. Its
`--upgrade` form
preserves every assignment and adds only missing safe-to-generate keys; it never
rotates weak credentials automatically. There is no overwrite or rotation flag.
`.env.example` documents the keys; it is not a file to copy.

To provision the fail-closed merge executor, first read its
[operator runbook](runbooks/merge-executor.md), then run the repeatable
human-owned capture wizard from the repository root:

```sh
bash scripts/setup-merge-executor.sh
```

The wizard registers no App and performs no administrator action itself. It
captures the installation-local private GitHub App configuration, validates the
dedicated OS-user/key boundary without reading key bytes, and leaves explicit
root-owned service adoption to the matching runbook profile.

## Templates release demo

`npm run demo:templates -- preflight|setup|instantiate|capture|verify|reset`
drives the retained OSS-C release-demo protocol over the current canonical
twelve-node Full Assurance template. It records exact-commit chain evidence but
does not independently inspect the target diff or command output. The demo's
limits and exact commands are in
[`docs/demos/templates-release-demo.md`](demos/templates-release-demo.md). The
current Direct and Full Assurance graphs are documented in
[`agents/README.md`](../agents/README.md). A rehearsal or one provider run proves
neither universal provider compatibility nor a fresh install.

## Verification

The repository defines these checks, in this order:

```sh
npm run db:validate
npm run typecheck
npm run lint
npm run build
npm test
docker compose config --quiet
npm run test:snapshot-scan
npm run snapshot:scan
```

Root `npm test` delegates to `npm run test --workspaces --if-present` and never
reaches `scripts/`, which is why the `scripts/`-level checks are named separately
above.

`npm test` runs every workspace's unit tests and needs no database and no
running service. It requires installed dependencies and a generated Prisma
client, but no prior build. Until the Merge Gate's build has run, the web CSS
and bundle artifact assertions report `Merge Gate build required` skips while
their source and fixture assertions continue to run.

`npm run test:db` is separate on purpose and is **not** part of `npm test`. It
runs the API's database tests against a live PostgreSQL that the caller
supplies, through `TEST_DATABASE_URL` and `TEST_DATABASE_MAINTENANCE_URL`,
against a scratch database — never a database holding anything you want to keep.
Folding it into `npm test` would make the default check for a fresh clone fail
for a missing service rather than for a defect.

Those tests run several files at once, each against a database of its own: the
runner migrates one template and hands every file a `CREATE DATABASE ...
TEMPLATE` copy of it, plus its own subdirectory of `RUNNER_WORKSPACE_ROOT`,
`CONTROL_PLANE_STATE_DIR` and `FILES_ROOT`. The one shared schema is what used to
force the files into a queue, and separate databases also separate what a schema
never could — advisory locks are per database. Handing out databases needs
`AGENTOS_ALLOW_SCRATCH_DATABASES=1`, the opt-in the scratch-database manager
already requires; without it the run stays serial on the single shared schema,
exactly as before. `AGENTOS_DBTEST_CONCURRENCY` sets how many files run at once
(default: cores-1, at most four — a test file is not one process, and past four
of them a laptop is oversubscribed rather than busy) and
`AGENTOS_DBTEST_PROVISION=0` turns the per-file databases off. Every exit drops
what it created: a failure, a Ctrl-C, a failure while the databases are still
being handed out. A run that cannot drop one says so and fails, rather than
reporting the green tests it also had. Only a run killed outright can leave
`agentos_cp_a_*` databases behind, and the next run reclaims those before it
starts — by name, and only where the process that created it is gone and nothing
is connected to it.

`npm run snapshot:scan` reads the tracked worktree and requires it to match
`HEAD`; it fails closed on a dirty tree rather than attributing the change to
the reported commit.

The snapshot commands are documented in
[`docs/public-snapshot.md`](public-snapshot.md). A green scan is a scoped
release gate, not proof that pattern matching can find every possible secret.

`npm run lint` is a deliberately small gate, and `scripts/merge-gate.sh` runs it:
Biome checks an opt-in list of safety rules (`biome.jsonc`, each entry carrying
the reason it is there), and typescript-eslint checks the single type-aware rule
`no-floating-promises`, plus the one syntactic selector that closes that rule's
unavoidable `node:test` blind spot (`eslint.config.mjs`). It does not check
formatting, and running it never rewrites a file.
