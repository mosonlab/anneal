# Anneal Developer Preview — quickstart

> **Correction (2026-08-19).** The install sequence shipped with `v0.1.0`
> omitted the required runtime build and did not state several prerequisites
> that can make a literal fresh install fail. This correction adds the build,
> PostgreSQL readiness wait, service order, setup recovery, filesystem and port
> constraints, repository/CLI preflights, and foreground-service lifecycle. The
> release tag remains immutable; use this corrected page when installing it.

> **One verified path, one shape of install.** This page is the supported
> sequence for macOS on Apple Silicon and Linux, run by the machine's own operator, on
> loopback, against repositories you are willing to have an agent write to.
> macOS on Intel is expected to work but is not yet release-verified; Windows is
> unsupported.
> [`support-matrix.md`](support-matrix.md) states what is supported
> and on what evidence; anything not in it is not supported.

This is the exact sequence for bringing up the Developer Preview on the one
platform it targets. It is written to be followed literally: every command is
the command, in the order it must run, and where a step can refuse, this page
says what the refusal looks like and what it means.

**Read this first.** The Developer Preview is for evaluating Anneal on a
machine you own, with repositories you are willing to have an agent write to. It
is not a production install. Nothing here is packaged, notarized, or
self-updating, and there is no upgrade path between preview builds other than a
fresh install.

## What you need

| Requirement | Exact expectation |
| --- | --- |
| Machine | The verified path uses an Apple Silicon Mac running macOS, or Linux (Ubuntu 24.04 LTS, x86_64). Keep the checkout, `~/.agentos/control-plane`, and runner workspaces on a local APFS or HFS+ volume on macOS, or ext4, XFS or Btrfs on Linux. NFS, SMB/CIFS, FUSE, unknown filesystem types, and symlinked control-state path components are refused. macOS on Intel is expected to work but is not yet release-verified; Windows is unsupported. |
| Node.js | Use `22.17.0`, recorded in `.nvmrc`. Installation is enforced at `^20.19.0 \|\| ^22.13.0 \|\| >=24`, the range shared by the locked toolchain; Node 22.12.x and 23 are refused. |
| npm | 10.9.2 or newer, the npm generation floor recorded for this release. Use it with Node.js 22.17.0. |
| Docker | Docker Desktop must be running, with Docker Compose available. The supported local shape needs loopback ports `5432`, `3000`, and `5173` free. |
| Git | Any recent version, with `user.name` and `user.email` configured for the runner account. The source must be a working clone. |
| Codex CLI | The official Codex CLI, already installed **and already signed in**, under the same user account that will run the Anneal runner. The runner does not inherit your interactive shell's `PATH`; see the preflight below. |
| GitHub CLI | Optional for branch-only delivery and the deterministic smoke task. `gh` is required for automatic pull-request creation and must be authenticated as the runner account. If a run must open a pull request and `gh` cannot record one, Anneal preserves the pushed branch and fails the run for retry. Manual PR instructions are reserved for non-GitHub remotes, where automatic creation is impossible by design. |
| GitHub read token | A read-only token exported as `GITHUB_READ_TOKEN` while running setup. Every API process requires it at startup; setup copies it into the mode-0600 `.env` and never prints it. |

Anneal orchestrates a coding CLI you already have. It bundles no subscription
and resells no capacity: your provider account, its plan limits, its rate
limits, and its availability remain yours.

Claude Code and Pi are optional. The preview installs
one starter agent and that agent runs on Codex, so Codex is the only backend
this quickstart requires — a machine with no Claude CLI on it is a complete
installation.

## The sequence

### 1. Clone the release source

```sh
git clone https://github.com/mosonlab/anneal.git
cd anneal
git checkout v0.9.0
```

Check out the exact tag or commit the release names. A branch tip is not a
release.

**It has to be a clone.** GitHub also generates source `.zip` and `.tar.gz`
archives for the release, but they are not an install medium. They carry no
`.git`, and parts of this repository read the checkout's Git history rather than
just its files:

- `npm run snapshot:scan`, the check that the published file set is the one the
  manifest allows, resolves `git rev-parse HEAD` and reads that commit's tree
  with `git ls-tree`. Outside a repository it does not degrade; it fails.
- The migration preflight in step 6 checks its release attestation against the
  checkout's history when there is one, and falls back to a content-only check
  when there is not. An unpacked archive silently gets the weaker of the two.

Unpacking an archive and running the sequence gets you a worse install with no
message saying so, which is the reason this step is written as an instruction
rather than a suggestion.

### 2. Install dependencies

```sh
npm ci
```

`npm ci` installs exactly what `package-lock.json` records. It must be allowed
to run the lockfile's lifecycle scripts: this repository's `postinstall`
generates the Prisma client, and without it nothing that touches the database
can even start. **`--ignore-scripts` is not supported** — an install done that
way looks successful and then fails later, somewhere unrelated.

The immutable `v0.1.0` tag's lockfile resolves packages through
`registry.npmmirror.com`; that third-party host is therefore part of the tag's
install dependency and trust boundary. If it is unreachable or disallowed in
your environment, `npm ci` will not complete. The maintained branch has moved
its lockfile URLs to the official npm registry, but the release tag is not
rewritten.

### 3. Generate local configuration

```sh
printf 'GitHub read token: '
IFS= read -r -s GITHUB_READ_TOKEN
printf '\n'
export GITHUB_READ_TOKEN
npm run setup:local
unset GITHUB_READ_TOKEN
```

This writes `.env` once, at mode `0600`, containing values it generates: a
stable random `RUNNER_ID`, distinct random operator and runner tokens, a
session-cookie secret, a base64-encoded 32-byte encryption key, and one database
password written identically into `POSTGRES_PASSWORD` and `DATABASE_URL`. It
also copies the operator-provided `GITHUB_READ_TOKEN`; it cannot generate that
credential, and refuses without it.

The create form prints a class — `configuration-created`,
`configuration-valid`, or `configuration-raced` — and never a value. It refuses
to rewrite an invalid existing `.env`. For a pre-existing local file,
`npm run setup:local -- --upgrade` preserves every assignment, adds only missing
keys that are safe to generate locally, and reports changed key names plus
remaining value-free reason codes. It never rotates weak or placeholder
credentials automatically, and there is no overwrite or rotation flag.
`.env.example` documents the keys; it is not a file to copy.

The generated `RUNNER_ID` is stable for this installation. Preserve it across
restarts and configuration upgrades: changing it prevents the new process from
reclaiming workspaces left by the prior identity.

By default, Files Root is `~/Documents/agentos`. On Macs with iCloud Desktop &
Documents enabled, agent writes may be uploaded and dataless placeholders may
fail to read. Set an absolute `FILES_ROOT` outside synced folders if that matters.
With the shipped same-user runner, Filesystem Grants authorize and audit
Anneal's Files API; they do not stop the coding CLI from accessing files the
runner's user account itself can access.

If setup is interrupted, first make sure no other setup process is running, then
inspect for abandoned credential files without printing their contents:

```sh
find . -maxdepth 1 -type f -name '.env.setup-local.*' -print
```

These files may contain a complete generated credential set. Git ignores them,
but setup deliberately cannot delete them automatically because it cannot tell
an abandoned file from one owned by a concurrent setup process.

| Setup class | Meaning and recovery |
| --- | --- |
| `configuration-invalid` | The existing `.env` is missing or has an unsafe key, is not a regular file, or is not mode `0600`. Setup will not repair it. On a disposable first install, move it aside and rerun; never paste its contents into an issue. |
| `configuration-unsupported-node` | The current Node.js version is outside the top-level accepted range. Switch to `.nvmrc`'s version. |
| `configuration-unsupported-filesystem` | The checkout filesystem cannot provide the durable same-directory link and directory-fsync operations setup requires. Move the clone to a supported local filesystem. |
| `configuration-entropy-unusable` | Secure generated values could not be produced. Stop; do not substitute hand-written weak values. |
| `configuration-raced` | Another setup process published `.env` first. Inspect that file's ownership and mode; do not overwrite it. |
| `configuration-upgraded` | `--upgrade` added missing safe-to-generate keys and no named repair remains. Existing assignments were preserved. |
| `configuration-upgraded-needs-action` | `--upgrade` added safe keys, but its value-free `remaining:` reasons still require human repair. |
| `configuration-upgrade-needs-action` | `--upgrade` changed nothing because the remaining problems cannot be repaired safely without a human choice. |

Every setup failure report should contain only the class and exit code, never the
contents of `.env`.

### 4. Build the runtime artifacts

```sh
npm run build
```

This step is required. The public checkout does not ship `packages/*/dist`.
The API and runner resolve workspace packages through `dist/*.js`, and Codex
sessions launch `packages/runner/dist/mcp-server.js`. Do not start services until
this command succeeds.

### 5. Start PostgreSQL

```sh
docker compose up -d --wait --wait-timeout 60 postgres
```

The service publishes on `127.0.0.1:5432` only. The wait is required: `running`
does not mean PostgreSQL is ready to accept the release migration, and the
60-second bound makes a failed health check return control instead of waiting
forever. If Compose cannot bind the port, stop the existing service on 5432; do
not point Anneal at an unknown PostgreSQL instance.

### 6. Create the schema

```sh
npm run db:migrate:release -- --fresh
```

This is the release-facing migration path, and the only one this page uses. It
proves the target is this checkout's own Compose database, proves that database
is empty, proves the checkout's migration set is the recorded release candidate,
and then hands the migration to the composed command that runs the migration
preflight before deploying anything. It has no `--force`, no `--skip-preflight`
and no `--no-preflight`; those spellings are recognised only so that trying one
tells you it was considered and refused.

If it stops, it prints one line per condition, in the form
`STOP release-migrate <condition>: <reason>` or `STOP preflight <condition>:
<detail>`. [`migration-and-recovery.md`](migration-and-recovery.md)
lists every condition and what it means.

The command holds an exclusive maintenance lock from before it first looks at the
schema through the emptiness census, the migration-set check, the preflight, the
deploy and the drift check, so nothing else can migrate the same database
underneath it.

**Do not work around a refusal by taking the preflight out of the command.** A
release path that deploys without it is not this release path, and
`npm run db:migrate` is a development command that will rewrite migration
history — it is not a faster version of this step.

### 7. Preflight the repository and CLIs

The repository named in the wizard must already contain its declared default
branch and at least one seed commit. The runner must be able to clone and push
without a prompt, and the runner account needs a Git author identity:

```sh
git config --get user.name
git config --get user.email
GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code --heads \
  <REMOTE> refs/heads/main
command -v codex
codex --version
codex login status
```

Replace `<REMOTE>` and `main` with the values you will enter. Verify
the values before opening the wizard. On Install, Anneal repeats the identity
and exact-branch checks, fetches that branch into a temporary bare repository,
and runs `git push --dry-run` before opening the installation transaction. A
missing identity, unreachable remote, absent branch, interactive credential
prompt, or refused write leaves the database untouched. Anneal sets
`GIT_TERMINAL_PROMPT=0`; shell-only authentication such as an inherited
`SSH_AUTH_SOCK` is not passed into its controlled Git environment.

The runner's default `PATH` is
`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` on macOS and
`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` on Linux. If
`command -v codex` is outside it, set `CODEX_BINARY` to the absolute executable
path or set `RUNNER_PATH` in `.env`.

The starter agent uses `gpt-5.6-sol:medium`. A green startup preflight proves
that the Codex CLI exists, exposes the `exec`/resume flags and stdin/JSON
protocol Anneal uses, and reports a signed-in session. Its capability report is
bound to that starter model; version 0.153.4 is the recorded compatible CLI. The
preflight does not spend a model turn, so the deterministic smoke task remains
the first entitlement and end-to-end model-access check.

### 8. Start the services

Use three terminals from the repository root, in this order. First start the API
and wait until it reports that it is listening on `127.0.0.1:3000`:

```sh
npm run dev:api
```

Then start the runner. It reports CLI preflight results to the API during
startup. If the API is still coming up, each preflight report retries at most
five times with bounded backoff; a persistent outage or deterministic refusal
still exits the runner.

```sh
npm run dev:runner
```

Finally start the web console:

```sh
npm run dev:web
```

The API listens on `127.0.0.1:3000` and refuses to start on any other host. The
web console is served at `http://127.0.0.1:5173`.

The Inbox service (`npm run dev:inbox`) is optional and is not part of this
sequence. No launchd definition is shipped or supported in this preview. Remote
access, the Feishu integration, and internal task-chain templates are also
outside this sequence.

### 9. Open the console and install

Open `http://127.0.0.1:5173`.

On a database with no projects in it, the console opens a five-screen wizard and
nothing else — no dashboard behind it, no partially configured application. It
asks for a project name, shows you what an installation will create, asks for a
repository and its remote, shows the starter agent, and then asks you to confirm.

The wizard states plainly what it is about to create, and the fourth and fifth
screens are the point of it rather than decoration:

- the environment it creates is honestly `OPEN` — no network restriction is
  enforced;
- the starter agent runs on this machine with **your own user's authority** and
  **no application sandbox**;
- no Filesystem Grant is created by default;
- the repository grant is `GIT_WRITE`, so the agent can push to the repository
  you name;
- a remote URL that carries a password or token is refused outright, in the
  browser and again on the server.

You have to acknowledge that explicitly, and the server independently refuses an
installation whose acknowledgement is false — so skipping the wizard is not a
way around the disclosure.

Install writes everything in one transaction: project, environment, starter
agent, repository, and the access grant, or none of them. Submitting twice
creates one installation.

### 10. Run the deterministic smoke task

Use a repository you can throw away, on a branch you can throw away.

The exact task is frozen in
[`fixtures/oss-b0-smoke-task.json`](fixtures/oss-b0-smoke-task.json). Create it
from the console's blank-task form with those exact values — in particular
**Open a pull request: off**, which the form sends explicitly rather than
leaving to a default.

What counts as a pass, and nothing weaker:

- the run pushes the branch `agentos/<created-task-id>/run-1`;
- that branch's parent is the seed commit the disposable repository already had;
- its tree differs from the parent by exactly one added file, `agentos-smoke.txt`,
  whose entire contents are the UTF-8 bytes `OSS-B0 v0.1.0 smoke` and one
  newline;
- the commit subject is exactly `oss-b0: add deterministic smoke marker`;
- delivery reports the push as successful and reports **no** pull request URL.

Anything else is a failure, including a run that hits the 15-minute wall clock
or the 5-minute stall timeout, a tree that differs by anything else, and a
delivery that opens a pull request.

## Operating the preview

This preview ships no supported daemon or service-manager installation. The API, web
console, and runner are foreground development processes and stop when their
terminals close. After a reboot, start PostgreSQL and wait for readiness, then
start API, runner, and web in that order.

To stop safely, stop the runner first and allow its current task to finish, then
stop the API and web processes. Use `docker compose stop postgres` to stop
PostgreSQL while preserving its data. Do not run `docker compose down -v` unless
you intentionally want to delete the database.

## When something refuses

The preview is built to refuse rather than to half-work, so a refusal is usually
telling you something specific.

| What you see | What it means |
| --- | --- |
| The console shows one blocking screen saying local configuration was refused | The API answered 401 or 403. `.env` and the running API disagree about the operator token. Regenerating configuration is a recovery, not a retry — see §3. |
| The console says the control plane did not answer | `npm run dev:api` is not running, or not on `127.0.0.1:3000`. |
| The wizard's Install button is inactive and the Codex step says the CLI was not found | The runner reported that `codex --version` did not answer. Check the platform default `PATH` described in step 7, then set `CODEX_BINARY` or `RUNNER_PATH` and restart the runner. |
| The wizard says Codex is not signed in | Run `codex login` yourself, in a terminal, then restart the runner. Nothing in Anneal runs it for you or stores what it produces. |
| The wizard says it is waiting for the local runner | Nothing has reported yet, or the last report is more than a minute old. Start `npm run dev:runner`; the screen updates on its own. This is not a failure and does not mean anything is missing. |
| `STOP release-migrate …` or `STOP preflight …` | See [`migration-and-recovery.md`](migration-and-recovery.md), which lists every condition. |
| `Anneal API startup configuration refused: <reasons>`, exit code 78 | The API read its environment and refused before doing anything at all — no socket bound, no database touched. Exit 78 is `EX_CONFIG`: restarting it changes nothing until a value does. The reasons are stable codes plus a variable name and never a value; see below. |

### Startup configuration refusals

The API checks its own configuration before its first act, and prints one line
naming what is wrong. On a fresh install that followed step 3 this does not
happen, because `npm run setup:local` writes a complete configuration. It happens
when a `.env` was written by hand, copied from `.env.example`, or carried over
from an older checkout whose checks were weaker.

| Reason | What to do |
| --- | --- |
| `missing:AGENTOS_SECRET_ENCRYPTION_KEY` | The file predates the encrypted-secrets store. Add the key as 32 random bytes in base64: `AGENTOS_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)`. Do not invent a shorter one — the value is parsed strictly and must decode to exactly 32 bytes. |
| `missing:GITHUB_READ_TOKEN` / `placeholder-value:GITHUB_READ_TOKEN` | Supply the required read-only GitHub token. The API does not start without it, even when merge automation is unused. |
| `encryption-key-not-base64:…` / `encryption-key-not-32-bytes:…` | The key is present but malformed. Node's base64 decoder discards characters outside the alphabet, so a padded or prefixed key can look right and decode to the wrong bytes; regenerate it with the command above. Note that replacing this key while encrypted rows exist destroys them unrecoverably. |
| `placeholder-value:POSTGRES_PASSWORD` or `placeholder-value:DATABASE_URL_PASSWORD` | The database password is one of the well-known defaults this repository's Compose file falls back to (`agentos`, `postgres`, `password`, `secret`) or a `CHANGE_ME`-style sentinel — on a port published on this machine. Choose a real one. |
| `database-credentials-disagree:POSTGRES_PASSWORD` (or `_USER`, `_DB`) | `.env` gives Compose one value and `DATABASE_URL` another. Exactly one of them is what the database actually has, and which one is not knowable from here. Make them identical. |
| `secret-too-short:…` | Under 24 characters. The generator mints 32 random bytes; match it. |
| `operator-runner-token-identical` | One value was pasted twice. Two principals sharing a token means the runner holds operator authority, which no amount of entropy fixes. |
| `api-host-not-loopback:API_HOST` | The Developer Preview listens on `127.0.0.1` and nothing else. |
| `database-url-schema-unnamed:DATABASE_URL` | The URL names no `?schema=`. The release migration path refuses such a URL later; the API refuses it now, which is the cheaper place to find out. |

A real example, in the order it actually happens. An `.env` carried over from an
older install refuses with `missing:AGENTOS_SECRET_ENCRYPTION_KEY,
placeholder-value:POSTGRES_PASSWORD, placeholder-value:DATABASE_URL_PASSWORD`.
Adding the encryption key and choosing a strong password only in `DATABASE_URL`
then produces `database-credentials-disagree:POSTGRES_PASSWORD`, because Compose
reads `POSTGRES_PASSWORD` from the same file. The complete fix is all three at
once: add the key, choose one strong password, and write that same password into
both `POSTGRES_PASSWORD` and the credentials in `DATABASE_URL`.

One trap this refusal cannot warn you about: PostgreSQL reads `POSTGRES_PASSWORD`
only when it initialises an empty data directory. Changing it in `.env` does not
change the password of a database that already exists — the container comes up
with the old one and the new URL is rejected at connect time. On a database whose
contents you do not need, `docker compose down -v` and start again. On one you do
need, change the role's password in the running database first, then make `.env`
match it.

## What this preview does not do

- It does not sandbox the agent. The provider adapters run with non-interactive
  permission-bypass flags, and Anneal grants are a control-plane authorization
  and audit boundary, not host containment. See
  [`security.md`](security.md).
- It does not enforce network isolation, and it does not claim to.
- It is loopback-only. Exposing any of these services beyond `127.0.0.1` is
  unsupported.
- It has no down migration and no supported restore path. See
  [`migration-and-recovery.md`](migration-and-recovery.md).
