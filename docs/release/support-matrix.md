# Anneal — what is supported, and on what evidence

This is the authoritative support statement for the Developer Preview. Anything
not named here is not supported, and "not named" is not the same as "probably
fine".

Every row carries the evidence behind it, because a support claim without one is
a hope. The status is recorded against the commit this document ships in.

## The labels

| Label | What it means |
| --- | --- |
| **Verified** | Exercised runtime or repository evidence exists for the stated path, at the release commit. |
| **Maintainer-verified** | A maintainer exercised the path on the named platform. Independent reproduction on a machine that never held an install is not part of the evidence. |
| **Experimental** | Implemented enough to evaluate, with no support commitment. It may change or be removed in a patch release. |
| **Pending** | Required evidence has not been completed. Do not infer support from code that exists. |
| **Unverified** | No qualifying evidence has been recorded. Not a claim that it fails; a statement that nobody has checked. |
| **Unsupported** | Outside the supported target. Reports about it will be closed as such. |

A merge is not evidence, and neither is a passing unit test for a path a person
has never walked.

## Platform

| Platform | Status | Evidence boundary |
| --- | --- | --- |
| macOS on Apple Silicon | **Target platform** | The install shape is in [`developer-preview.md`](developer-preview.md). |
| macOS on Intel | **Unverified** | The portable design and locked `darwin-x64` dependencies make this path expected to work, but nothing has been run there. |
| Linux | **Maintainer-verified** | Ubuntu 24.04 LTS on x86_64, Node.js 26.8.1, Codex CLI 0.153.4: the maintainer's own installation runs the API, web console, PostgreSQL, release migrations, sixteen Codex and Pi runners and the merge executor there. At the v0.8.0 and v0.9.0 cuts the maintainer also walked the [quickstart](developer-preview.md) on a separate Ubuntu 22.04 x86_64 host that had never held an install (Node.js 26.5.0, 4 vCPU, 4 GB): clone, `npm ci`, `setup:local`, build, PostgreSQL, the fresh release migration and starting the API, runner and web console all succeeded as written; the install wizard and smoke task were not run there because that host has no Codex sign-in. Other distributions are **Unverified**. |
| Windows | **Unsupported** | The runner relies on POSIX process-group, path and command behaviour. This is a design position, not a gap waiting to be filled. |

## Runtime prerequisites

| Requirement | Status | Evidence boundary |
| --- | --- | --- |
| Node.js `22.17.0` | **Target version** | Recorded in `.nvmrc` and used by the corrected install instructions. The maintainer's Linux installation runs 26.8.1, inside the enforced range below. |
| Node.js `^20.19.0 \|\| ^22.13.0 \|\| >=24` | **Enforced** | Root engines, `engine-strict`, setup validation, the lockfile, and the Linux compatibility matrix carry the range required by the locked toolchain. Node 22.12.x and 23 are refused. |
| npm 10.9.2 or newer | **Verified** | The npm generation floor recorded for this release. Use it with Node.js 22.17.0. |
| Docker with Docker Compose | **Verified** | For the PostgreSQL service `docker-compose.yml` defines, published on `127.0.0.1:5432` only. |
| Git | **Required, not optional** | The release install path is a `git clone`. See "Obtaining the source" below. |
| PostgreSQL 16 | **Verified** | As started by this repository's Compose file. Other servers and other majors are **Unverified**. |

## Obtaining the source

| Method | Status | Evidence boundary |
| --- | --- | --- |
| `git clone` of the published repository, then `git checkout <tag>` | **Supported** | The only supported medium. Several release-path checks read the checkout's Git history and tracked-file list. |
| GitHub-generated source `.zip` / `.tar.gz` | **Unsupported as an install medium** | They carry no `.git`. `npm run snapshot:scan` invokes `git rev-parse HEAD` and `git ls-tree` and fails outright without a repository; the migration preflight's authority check drops to its content-only binding, losing the commit, tree and ancestry checks. They are GitHub-generated source snapshots, not a supported install path or a repository-published checksum artifact. |

## Provider runtimes

Anneal orchestrates coding CLIs already installed and signed in on your machine.
It bundles no subscription, resells no capacity, never logs you into a provider
and never reads a credential store. Provider accounts, authentication,
subscriptions, usage allowances, rate limits, models and provider-side
availability remain yours. Nothing in this table is a compatibility promise by
the CLI vendor.

| Provider runtime | Status | Evidence boundary |
| --- | --- | --- |
| Codex CLI | **Verified adapter; model access Maintainer-verified** | Startup preflight checks the installed version, the exact `exec`/resume flags and stdin/JSON protocol Anneal uses, and login status; its capability report is bound to the starter model `gpt-5.6-sol:medium`. OpenAI publishes no minimum CLI semver for this combination, so compatibility is capability-based rather than an invented version floor; 0.153.4 is the last version recorded as compatible. Model access is maintainer-verified rather than smoke-tested: every canonical role runs on Codex in this release, and the maintainer's own installation runs Codex chains through plan, implementation, review and merge daily. Independent reproduction on a machine that never held an install is not part of the evidence. |
| Claude Code | **Verified** / **Maintainer-verified** | Adapter and runtime are verified. Claude Pro/Max subscription authentication is maintainer-verified on macOS Apple Silicon. |
| Pi | **Verified** | Adapter/runtime and subscription authentication path are verified. Pi authenticates through the Codex login. |

## Feature surface

| Feature | Status | Evidence boundary |
| --- | --- | --- |
| Task creation, task detail, runs, sessions and the archive | **Verified** | Console and API paths with workspace tests. |
| The five-screen installation wizard and one-transaction install | **Verified** | Server-side refusal of a false acknowledgement is independent of the browser. |
| Local runner: fenced lease, per-run workspace, run branch | **Verified** | Wall-clock and stall bounds apply to every run. |
| Git delivery: branch push | **Verified** | Requires non-interactive clone/push authentication and a configured Git author identity for the runner account. |
| Automatic GitHub pull request | **Optional** | Requires the `gh` CLI installed and authenticated as the runner account. A run required to open a pull request fails after preserving its pushed branch when `gh` cannot record one; a non-GitHub remote instead returns manual PR instructions because automatic creation is impossible by design. |
| Local repository merge gate | **Maintainer-verified** | `scripts/merge-gate.sh` judges one exact clean commit and provisions its own throwaway PostgreSQL. It needs Docker and the repository toolchain, but no remote gate worker. |
| Remote gate-worker profile | **Maintainer-verified** | The maintainer dispatches every merge gate to an Ubuntu 24.04 worker over SSH through the published provisioning and dispatch path. It requires operator-owned SSH-reachable Ubuntu capacity configured explicitly; the repository provides no worker, hostname, credential or automatic topology. |
| Direct workflow | **Maintainer-verified** | The canonical workflow additionally requires its configured Codex, Claude Code and Pi roles, authenticated GitHub PR delivery, an operator-provided gate worker, read-only GitHub evidence credentials and the self-hosted merge executor. None is silently substituted when absent. |
| Full Assurance workflow | **Maintainer-verified** | The canonical workflow has the same advanced delivery prerequisites as Direct plus its planning roles. Provider accounts, model entitlement and every delivery service are supplied by the operator. |
| Autonomous merge tail | **Maintainer-verified** | The maintainer's installation merges its chains this way daily. Public self-hosting requires an installation-local private GitHub App and an isolated `@anneal/merge-executor`; the Quickstart does not configure either. Missing evidence, authority or executor identity stops the chain. |
| Self-hosted merge executor | **Maintainer-verified** | The maintainer runs the executor as the runbook's systemd unit on Ubuntu 24.04 with a dedicated service identity. The macOS LaunchDaemon profile is a documented procedure that nobody has run: **Unverified**. |
| Quiet-window appliance deployment | **Unsupported** | The maintainer appliance profile is published for auditability and reproducibility. It is not the Developer Preview installation shape or a production-support commitment. |
| Repository and filesystem grants | **Verified as a control-plane boundary** | They authorize and audit Anneal's own APIs. They are not host containment, and the repository access level does not gate delivery's push. |
| Stored secrets (AES-256-GCM) | **Verified** | Neither plaintext nor ciphertext appears in the API's secret representations. There is no rotation command. |
| Scheduling, webhook triggers, automations | **Verified** | |
| Blocking human questions through the Inbox | **Verified** | The Inbox *service* (`npm run dev:inbox`) is optional and outside the quickstart sequence. |
| English and Chinese console | **Verified** | |
| Goals | **Pending** | A Goal, its definition of done, its progress log and its limits are stored and editable. No execution model is wired: nothing schedules work from a Goal, nothing measures its spend, and nothing stops it on spend, time or stall. The console shows no spend figure and no stopped state because the server has no writer for either. |
| Repository command-line interface | **Retired** | This release ships no repository CLI. v0.1.0 and v0.2.0 contained a help-only interface; v0.3.0 retires it rather than carrying it forward without operational command families. |
| Feishu / Lark integration | **Experimental** | A maintainer's own integration, published because it is in the tree rather than because it is offered. Not part of the quickstart sequence and not part of the committed surface. |
| launchd service definitions | **Unsupported** | Outside the supported install shape. |
| Runners on a second machine | **Experimental** | The runner machine forwards the control plane's loopback port over its own SSH tunnel; see [`install.md`](../install.md). The maintainer runs Claude Code runners this way. The tunnel adds no identity, so the row below stands. |
| Remote access of any kind | **Unsupported** | There is no remote authentication design — no login, no per-user identity, no session model for anyone but the machine's own operator. A tunnel or a reverse proxy does not add one. |

## Data and operations

| Operation | Status | Evidence boundary |
| --- | --- | --- |
| Fresh install migration | **Verified** | `npm run db:migrate:release -- --fresh` proves its target, emptiness and migration set, then runs behind its preflight. |
| Migrating an existing installation | **Unsupported end to end; consumer implemented** | `--existing` validates a verified bundle and can continue through the guarded migration sequence, but this repository ships no backup producer or supported runbook that creates that bundle. The mode does not emit an `interface unavailable` condition; executable consumer code alone is not release evidence. |
| Upgrading between preview builds | **Unsupported** | There is no upgrade path other than a fresh install. Nothing is packaged, notarized or self-updating. |
| Down migration | **Does not exist** | No command in this repository reverses an applied migration. Rolling back code does not roll back the database. |
| Restore | **Unsupported** | Restoring over a database something is still using is not a supported operation of this release. |
| Production use | **Unsupported** | Not "discouraged" — outside what this release covers, with no evidence behind it. |

[`migration-and-recovery.md`](migration-and-recovery.md) is the
long form of this section, including every refusal condition.

## Known limitations that are not defects

These are documented positions, not open bugs. Reports about them will be closed
with a pointer here.

- **Not a sandbox.** The provider adapters launch the coding CLI with
  non-interactive permission-bypass flags; with the shipped same-user default the
  agent runs with your own user's authority.
- **No enforced network isolation.** A fresh installation's environment is
  labelled open because it is.
- **Loopback only.**
- **The repository access level does not gate delivery's push.** Treat any
  repository you register as writable by the agent.
- **The Files path walk can be raced** by an adversary who can already write
  inside the Files Root. Closing it needs a native helper; until then the backstop
  is deployment, and the API refuses to boot when the Files Root overlaps the run
  workspace root.
- **Runner separation is partial.** A dedicated account separates runners from
  each other; one runner's account still owns every workspace it created.
- **The unguarded migration bypass is procedural.** Nothing prevents running
  `prisma migrate dev` or `prisma migrate deploy` by hand with no preflight.
- **No secret rotation command.** Rotating the secret encryption key while
  encrypted rows exist destroys them unrecoverably.

[`security.md`](security.md) states each boundary and where it
stops.
