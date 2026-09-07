# Quiet-window auto-deploy

> This runbook's production profile is Linux systemd on the control-plane
> host. The macOS launchd profile is for a runner-only Mac and, historically,
> the former appliance; the macOS control-plane profile is maintainer-unverified.
> It is published for auditability and reproducibility; it is outside the
> Developer Preview Quickstart, the supported installation shape, and a
> production-support commitment.

The job advances the release named by `current` to an exact target commit from
`main`. On the Linux systemd control-plane host it manages the generated
`<label>.service` units for the API, Inbox, configured runners (10 by default),
and web (13 units at the default count); on a macOS control-plane host, the
corresponding launchd labels are `com.agentos.api`, `com.agentos.inbox`,
configured runner labels (10 by default), and `com.agentos.web` (13 labels at
the default count). Linux and macOS use the same generated inventory. The
macOS control-plane profile is maintainer-unverified; a macOS runner-only host
uses launchd only for its configured runner labels. The release may contain
the resident merge-executor runtime, but that service is outside this
activation set; on Linux its root-owned runtime follows the release through
`agentos-merge-executor-follower.timer`. An Anneal Run workspace is never
deployed.

## Runner-only host

The maintainer's Mac is this runner-only profile: its six Claude runners follow
the control plane's deployed build (PR #462).

Set `AGENTOS_DEPLOY_ROLE=runner` while rendering a separate runner host's
service and auto-deploy definitions. The unset value, or explicit
`control-plane`, is the host role for the API, Inbox, web, database, and
canonical prompts. The install manifest records the role; stage two refuses a
manifest whose recorded role differs from the configured role.

A runner host installs only the configured runner services: Linux systemd
`<label>.service` units or macOS launchd `com.agentos.runner` labels,
controlled by `AGENTOS_RUNNER_COUNT` and `AGENTOS_RUNNER_ID_PREFIX`. Its prefix
is required, host-specific, and disjoint from the control-plane host's runner
IDs; an empty or invalid prefix fails preflight. It never installs, restarts,
or verifies the control-plane API, Inbox, or web services: Linux systemd
`<label>.service` units or macOS launchd `com.agentos.api`,
`com.agentos.inbox`, and `com.agentos.web`. Its deployment phases omit `backup`,
`guarded-migration`,
`generate-prisma-client`, `canonical-prompt-sync`, and
`verify-runtime-prisma-client`, so it does not change the control-plane
database or canonical prompts.

Before building, the runner reads the control plane's clean, stamped API
commit from `GET /version`. `RUNNER_API_URL` must be exactly a numeric-loopback
HTTP origin such as `http://127.0.0.1:<port>` (normally a tunnel), and
`OPERATOR_TOKEN` is required for the operator-only `GET /runners` check. The
reported commit must be present in the source remote. After building and
acquiring the deploy barrier, the runner reads `/version` again and refuses to
publish if the control plane advanced. An unreachable or dirty control-plane
build, an unreadable source remote, or an unavailable commit stops preflight.

Quiet-window blockers on this host are active agent Runs whose `runnerId` is in
this host's generated inventory. After restart, every local runner must be online,
register again with a newer observation, and report the deployed build commit
through `GET /runners`. A missing, stale, offline, or mismatched registration
fails verification; the job points `current` back to `previous`, restarts the
local runners, and succeeds in recovery only after they all report the
previous release's commit.

Every host with local runners in its inventory runs that registration check,
including the control-plane VM, which reads its own loopback API at
`http://127.0.0.1:${API_PORT}` (default port 3000) with the `OPERATOR_TOKEN`
from the deployment's `.env`. A control-plane host with local runners and no
`OPERATOR_TOKEN` fails preflight; the check is never skipped.

## Automatic deploy cadence

The scheduler still wakes the auto-deploy job every five minutes. A wake-up is
only a tick: on the control-plane role, when `origin/main` has moved beyond the
deployed release, the job also checks the time of the last successful automatic
deploy recorded in `.agentos-deploy/auto-deploy-state.json` as
`lastSuccessfulAutomaticDeployAt`. `AUTO_DEPLOY_MIN_INTERVAL_MINUTES` in
`shared/.env` sets the minimum interval and defaults to **240 minutes (four
hours)**. Both host roles read the same non-negative whole-minute setting; a
runner-only host retains its existing `/version` follow behavior. The cadence
floor applies to control-plane automatic deploys, on Linux or macOS. For an
on-demand invocation of the existing script, pass `--now` to bypass
coalescing; the quiet window and deploy barrier still apply. Manual deploys
do not advance the automatic success timestamp.

If the interval has elapsed, the tick enters the normal artifact, quiet-window,
and activation path. A tick may deploy earlier when its first quiet-window
query is already open (`blockers=0`); this natural quiet window is the one
early-deploy exception to the interval floor. When the control-plane `main`
target has moved but the interval has not elapsed and blockers remain, the tick does no build, wait, or
dispatch drain. It logs
`NOOP coalescing next-eligible=<time>` and exits; `next-eligible` is the last
successful automatic deploy time plus the configured interval. A host with no
recorded successful automatic deploy is eligible for its first attempt.

For control-plane deploys, the wait budget and its dispatch drain are entered
only after the interval is eligible. A natural quiet window found at tick time
proceeds without either one. If blockers appear or the barrier is contended
before that early window is secured, the tick coalesces instead of waiting.
The success timestamp is written after verification, notification, and resource
cleanup succeed, while the deploy process lock is still held. Failed attempts
and coalesced ticks do not advance it. If recording the timestamp fails after
a successful deploy, the job logs `cadence-marker-unrecorded` and retains its
success verdict; the interval cannot be enforced from an unrecorded success.

## Runtime layout

```text
releases/<commit>-<digest>/   immutable, verified runtime artifacts
shared/.env                   mode-0600 operator configuration
shared/{files,runs,dependency-cache,repo-mirrors,state}/ mutable operator data
shared/bin/                   stable service wrapper
current -> releases/...       activation authority
previous -> releases/...      pointer rollback target
```

Artifacts contain the compiled applications and dependency graph, Prisma
schema and maintenance sources, generated client, native and web/runner
assets, deployment scripts, build stamps, and canonical agent sources. The
verifier checks every Prisma maintenance import rooted at `packages/db/src`.
Secret-shaped paths are excluded and recorded in the builder log and release
manifest; artifacts contain no `.env`, credentials, or mutable operator state.

The source checkout is inspection state. Services and auto-deploy run through
`current`; deployment does not read, fast-forward, clean, or publish files
from the source checkout. Develop in an independent clone or worktree.

On Linux systemd, the generated web `<label>.service` serves `apps/web/dist`
with Vite preview at `http://127.0.0.1:4173`; on a macOS control-plane host,
the launchd label `com.agentos.web` serves the same path. Use the numeric
loopback address; the credential-bearing proxy rejects other origins.

## Preconditions

For unprivileged Linux systemd and macOS launchd stages, use the account that
owns the service definitions; never run those stages as `root`. Linux systemd
stage two is the explicit root-only exception described below. Require:

- `current` and `previous` are relative symlinks to direct children of
  `releases/`;
- `shared/.env` is mode 0600. Both roles require `DATABASE_URL` for
  quiet-window queries and the deploy barrier, and `FEISHU_DEFAULT_CHAT_ID`
  for deploy notifications; these two values may also be inherited from the
  deploy job's environment. Control-plane additionally requires
  `GITHUB_READ_TOKEN` in the file. Runner additionally requires `OPERATOR_TOKEN`
  and `RUNNER_TOKEN` in the file, but does not require `GITHUB_READ_TOKEN`.
  Optional `RUNNER_API_URL` may be set in the file or inherited and is validated
  by `controlPlaneApiBaseUrl`. The file also contains the five absolute
  persistent paths beneath `shared/`:
  `FILES_ROOT`, `RUNNER_WORKSPACE_ROOT`, `RUNNER_DEPENDENCY_CACHE_ROOT`,
  `RUNNER_REPO_MIRROR_ROOT`, and `CONTROL_PLANE_STATE_DIR`;
- every configured service definition, whether a Linux systemd `<label>.service`
  unit or a macOS launchd label, uses
  `shared/bin/agentos-service-wrapper.mjs`;
- the control-plane PostgreSQL container and its `pg_dump` binary are running
  when container backup mode is selected; and
- the source remote is readable and the Node, npm CLI, Git, and Docker paths
  recorded in the auto-deploy definition are absolute and executable.

Legacy mutable-data roots are not deleted or synchronized during deployment;
retiring one is a separate operator decision.

## Build a release artifact explicitly

The builder and activator are separate. The builder alone clones the exact
target into a disposable build directory, installs the lockfile, builds,
assembles, hashes, makes read-only, probes, and verifies the release. A failed
build never enters the quiet-window phase.

Auto-deploy invokes the builder as its first ledger-backed phase and records
`ARTIFACT_PREPARED` only after independently verifying the builder receipt. For
an operator build before `--dry-run`, use the same explicit toolchain contract
and a full commit:

```sh
export AGENTOS_REPOSITORY_ROOT="$PWD"
export DEPLOY_SOURCE_REMOTE="$(git remote get-url origin)"
export DEPLOY_GIT_BINARY="$(command -v git)"
export DEPLOY_NODE_BINARY="$(command -v node)"
export DEPLOY_NPM_BINARY="$(command -v npm)"
target="$(git ls-remote --exit-code "$DEPLOY_SOURCE_REMOTE" refs/heads/main | awk '{print $1}')"
"$DEPLOY_NODE_BINARY" current/scripts/deploy/build-release-artifact.mjs "$target"
```

The final line is `RELEASE-ARTIFACT` followed by release name, commit, digest,
and the number of source clone attempts. A network-shaped clone failure (TLS
handshake, connection reset, unresolved host) is retried up to three times with
backoff; any other clone failure, and an exhausted retry, fail as
`release-artifact-source-unavailable` with no change to escalation. Only the
`git clone` invocation is retried; a lazy blob fetch during checkout still
escalates on failure. The existing overall build deadline still applies.
An existing exact artifact is reverified and reused. Missing output, wrong
stamps, excluded secret-shaped paths, ambiguous identities, and digest drift
are named failures; the activator has no fallback for them.

## Read-only verification

For control-plane container backup mode, define the backup contract without
printing secrets:

```sh
DEPLOY_DOCKER_BINARY="$(command -v docker)"
test -n "$DEPLOY_DOCKER_BINARY"
export DEPLOY_PG_DUMP_MODE=container
export DEPLOY_DOCKER_BINARY
export DEPLOY_PG_DUMP_CONTAINER=agentos-postgres-1
export DEPLOY_CONTAINER_PG_DUMP_BINARY=/usr/local/bin/pg_dump
```

Then run:

```sh
node current/scripts/deploy/quiet-window-deploy.mjs --dry-run
```

Dry-run reads the target, blocking Runs, artifact, services, and (on the
control-plane role) backup readiness. It takes no deploy lock and does not
build, back up, migrate, synchronize, activate, write Inbox rows, or restart
services. It reports the current and target commits, quiet-window state,
artifact readiness, service readiness, backup readiness, and each role's
activation steps as `mutation=skipped`. `claimed`, `provisioning`, and
`running` block; `queued` and `waiting-inbox` do not. A non-zero dry-run stops
the procedure until its named artifact or precondition is repaired.

## Linux systemd

Set `AGENTOS_SERVICE_PLATFORM=linux` to select system-level systemd units. The
resolver accepts only `darwin` or `linux`; an unsupported value fails instead
of selecting the macOS profile. Rendering and staging are unprivileged.
Copying into `/etc/systemd/system`, changing systemd state, and installing the
control grant are root-only stage-two operations. The merge executor remains a
separate hand-installed service and is not generated, enabled, restarted, or
rolled back here.

### Two-stage install

Set `SERVICE_USER` to an existing non-root Linux service account. `--service-user`
is required on Linux and is validated before rendering; an unknown account or
`root` is refused. Keep the staging directory operator-owned under the
existing `.agentos-deploy/` install root.

First plan, then render both installer manifests as the operator. The
control-plane example below uses host `pg_dump`; set its absolute path in
`DEPLOY_PG_DUMP_BINARY` first. For a runner-only host, omit that export and the
backup options, retaining the runner role and prefix environment.

```sh
export AGENTOS_SERVICE_PLATFORM=linux
export SERVICE_USER="${SERVICE_USER:?set an existing non-root service account}"
export DEPLOY_PG_DUMP_BINARY="${DEPLOY_PG_DUMP_BINARY:?set an absolute pg_dump path}"

scripts/os-isolation/patch-runner-plists.sh --dry-run
scripts/os-isolation/patch-runner-plists.sh --apply

node scripts/deploy/install-launchd-services.mjs \
  --service-user "$SERVICE_USER" \
  --replace-existing
node scripts/deploy/install-launchd-services.mjs \
  --service-user "$SERVICE_USER" \
  --replace-existing --apply

node scripts/deploy/install-launchd.mjs \
  --service-user "$SERVICE_USER" \
  --pg-dump-mode host \
  --pg-dump-binary "$DEPLOY_PG_DUMP_BINARY"
node scripts/deploy/install-launchd.mjs \
  --service-user "$SERVICE_USER" \
  --pg-dump-mode host \
  --pg-dump-binary "$DEPLOY_PG_DUMP_BINARY" \
  --apply
```

The plan prints `PLAN platform=linux`, the unit directory, count-derived unit
total, staging path, and `PLAN no files or systemd state changed`. Stage-one
apply writes only staged service units, the auto-deploy oneshot and timer,
os-isolation drop-ins, the stable wrapper, and digest/backup manifests below
`.agentos-deploy/`. It does not write `/etc`, call `systemctl`, or require
privilege. Each installer prints the exact root command for stage two; run
that printed command with `--install-units` rather than constructing a path.

Stage two verifies the installed operator-owned wrapper and copies staged system-owned files
to `/etc/systemd/system` as `root:root` mode 0644. It validates the rendered
units, checks `/etc/sudoers.d/anneal-service-control` with `visudo -c`, runs
`systemctl daemon-reload`, and enables the generated inventory. The sudoers
grant is generated from the control adapter and names only generated units,
`/bin/systemctl`, and `restart`, `is-active`, and `show -p ExecStart --value`.
It grants neither `enable`, `disable`, nor `daemon-reload`; those remain in
the root install stage. Control calls use `sudo -n`; denial is a deployment
failure.

Before replacing an existing system file, stage two records its bytes,
ownership, mode, and enabled/active state in a root-owned mode-0600
transaction record. The unprivileged manifest cannot rewrite that record. A
successful revert consumes and removes it after the final `daemon-reload`.

The service manifest has the stable wrapper as its first entry and one entry
per generated service. The auto-deploy manifest is separate: a `Type=oneshot`
service and timer on Linux, or one plist on macOS. The Linux oneshot is
installed but never enabled or started directly; `enable --now` applies to the
timer only, so installation cannot trigger an immediate deployment.

### Runner count, accounts, and logs

`AGENTOS_RUNNER_COUNT` defaults to 10 and accepts integers 1 through 64. In
control-plane inventory order, the labels are API, Inbox, runner 1 as
`com.agentos.runner`, runners 2 through the configured count, then web; Linux
systemd installs each as `<label>.service` and macOS launchd uses the label
directly. A runner-only inventory contains only the runner labels.

The os-isolation account pool uses `ACCOUNT_COUNT` (default 8) and maps runner
`i` to account `((i - 1) % ACCOUNT_COUNT) + 1`. Each account has its own mode-700
home and Git/CLI state; credentials are not copied or shared. At the default
count there are 13 long-running control-plane services; at count 16 there are
19. Stage two runs `systemctl enable --now <label>.service` for each long-lived
service and `systemctl enable --now com.agentos.auto-deploy.timer`; it never
enables or starts `com.agentos.auto-deploy.service` directly.

Linux output is in the systemd journal. Inspect a service with:

```sh
journalctl --no-pager -u <label>.service
```

The auto-deploy oneshot is inspected through its journal unit; deployment code
does not parse per-service log files on Linux.

### Activation and rollback

After `current` points to the verified release, the Linux control adapter
checks each generated label in inventory order:

```sh
sudo -n /bin/systemctl restart <label>.service
sudo -n /bin/systemctl is-active <label>.service
sudo -n /bin/systemctl show -p ExecStart --value <label>.service
```

`is-active` must return `active`; `ExecStart` must contain both the stable
wrapper path and the label. HTTP readiness, release identity, and the deploy
barrier checks are the same as on macOS
([Install service wrappers](#install-service-wrappers) below). If activation verification fails,
atomically point `current` to `previous`, then repeat restart, active, and
wrapper-boundary checks for the prior release. The auto-deploy oneshot is not
restarted; its timer remains the scheduler.

To undo service installation, first run the unprivileged wrapper-revert stage;
it restores only the operator-owned wrapper and prints the exact root command
for system-owned files:

```sh
node scripts/deploy/install-launchd-services.mjs \
  --service-user "$SERVICE_USER" --revert --apply
```

Run the printed `--install-units --revert` command, then use the auto-deploy
installer's `--install-units --revert` mode for its oneshot and timer. Recorded
manifests are authoritative: digest drift refuses the revert without changing
anything; otherwise every recorded file is restored or removed, removed units
receive `systemctl disable --now`, and the process finishes with
`systemctl daemon-reload`. This restores system-unit files, timer, staged
drop-ins, wrapper, and generated control grant to their recorded pre-install
state.

## Install service wrappers

This section applies to the macOS launchd profile; the Linux systemd procedure
is in [Linux systemd](#linux-systemd) above.

The wrapper migration must finish before pointer activation. On macOS, plan
then apply the complete generated service inventory:

```sh
node scripts/deploy/install-launchd-services.mjs --replace-existing
node scripts/deploy/install-launchd-services.mjs --replace-existing --apply
```

For `AGENTOS_DEPLOY_ROLE=runner`, the plan prints one
`PLAN runner-path-source=<label>=<.env|rendered|plist-inline>` line per runner
definition. `.env` means `shared/.env` defines `RUNNER_PATH` and the definition
leaves it out so that value reaches the runner; `rendered` means the installer
wrote a value containing the directories of the provider CLIs it resolved
(`CLAUDE_BINARY` and `CODEX_BINARY`, otherwise `claude` and `codex` on the
installing user's PATH); `plist-inline` means a migrated definition keeps its
own `RUNNER_PATH`, which defeats `shared/.env` — remove it from that plist and
plan again. A provider CLI absent from this host is named by a
`PLAN runner-provider-cli-missing=<name>` line; that runner cannot serve it.
When a configured `CLAUDE_BINARY`/`CODEX_BINARY` does not resolve, or neither
CLI resolves, the installer refuses with
`STOP runner-provider-cli-unresolved:<names>`; install the CLI, correct the
configured path, or set `RUNNER_PATH` in `shared/.env` and plan again.

The installer records original definitions and manifests, creates
`shared/bin/agentos-service-wrapper.mjs`, and writes wrapper-based plists. Its
apply path may `bootout` retired labels and `kickstart` changed owned labels;
if a label must be reloaded manually, let its graceful predecessor disappear
before bootstrapping the same label. Require every inventory label to be
running, each log to identify the same `current` release, `/health` to pass,
and `/version` to report the exact current commit.

## Install auto-deploy

This section applies to the macOS launchd profile; the Linux systemd procedure
is in [Linux systemd](#linux-systemd) above.

If an existing macOS definition has a different log path, explicitly unload
and remove it before installing the new definition. Plan, then apply:

```sh
node scripts/deploy/install-launchd.mjs \
  --pg-dump-mode container \
  --docker-binary "$DEPLOY_DOCKER_BINARY" \
  --pg-dump-container agentos-postgres-1 \
  --container-pg-dump-binary /usr/local/bin/pg_dump

node scripts/deploy/install-launchd.mjs \
  --pg-dump-mode container \
  --docker-binary "$DEPLOY_DOCKER_BINARY" \
  --pg-dump-container agentos-postgres-1 \
  --container-pg-dump-binary /usr/local/bin/pg_dump \
  --apply
launchctl print "gui/$(id -u)/com.agentos.auto-deploy"
```

The macOS plist runs `current/scripts/deploy/quiet-window-deploy.mjs` with the
source remote and absolute toolchain recorded, logs under
`~/Library/Logs/Anneal`, runs at load, and wakes every five minutes. Each wake
on the control-plane role is subject to the [automatic deploy cadence](#automatic-deploy-cadence), so
the timer is not a promise to build or deploy every five minutes. The
installer refuses to overwrite a different existing definition. A runner-only
host does not need database backup arguments because its backup phase is
omitted; it still reads `AUTO_DEPLOY_MIN_INTERVAL_MINUTES` from
`shared/.env`.

## Activation sequence

For an eligible target commit, the job records `STARTED`, invokes the explicit
builder, and performs this order. Linux systemd services are `<label>.service`
units; macOS launchd services are labels. On the control-plane role, the first
target is the `main` head read at the tick. After the quiet window and
exclusive deploy barrier are obtained, the control plane reads `origin/main`
again. If it has advanced, it logs `target-advanced from=<old> to=<new>`,
builds and verifies an artifact for the new head, and uses that head for every
remaining phase. The stale tick target is never published. A runner-only host
continues to take its target from the control plane's `/version` and performs
the existing post-barrier `/version` check described in [Runner-only host](#runner-only-host).

1. After `ARTIFACT_PREPARED`, verify release name, exact commit stamp, manifest
   inventory, content digest, excluded-path record, and read-only permissions;
   record `ARTIFACT_VERIFIED`. A missing artifact or digest mismatch records
   `FAILED` before quiet-window acquisition.
2. Query for zero blockers, acquire the exclusive PostgreSQL deploy barrier,
   and query again. Hold the barrier through activation, verification, or
   recovery. On the control-plane role, re-read `origin/main` after the quiet
   window/barrier is obtained; if it differs from the target read at the tick,
   emit `target-advanced from=<old> to=<new>` and rebuild and verify the
   artifact for the new target before continuing. A runner-only host keeps its
   control-plane `/version` target check.
3. Copy the verified release to a disposable writable operation workspace. It
   is not a Git checkout and is never published.
4. Prove every configured Linux systemd `<label>.service` unit or macOS launchd
   label is running through the stable wrapper and still identifies the old
   `current` release.
5. On the control-plane role, stream a custom-format `pg_dump` to a mode-0600
   temporary host file, fsync it, and rename it only after a successful,
   non-empty result; record `BACKED_UP`.
6. On the control-plane role, run guarded migration preflight and Prisma
   migration from the operation workspace using `shared/.env`; copy no
   environment file into any workspace. Record `SCHEMA_ADVANCED` with
   migration tails.
7. On the control-plane role, regenerate and verify the operation workspace
   Prisma Client, then run canonical prompt sync. Structural drift is a
   terminal refusal.
8. Recheck the barrier and blocking statuses, then reverify the immutable
   artifact. On a runner host, also read the control plane's `/version` and
   require the same target commit immediately before publication.
9. Atomically update `previous` and `current`, durably record `ACTIVATED`, and
   restart every configured Linux systemd `<label>.service` unit or macOS
   launchd label.
10. Require all configured Linux systemd `<label>.service` units or macOS
    launchd labels running. On the control plane, require both `/health`
    success with `/version` reporting the exact clean target commit and every
    local runner registration; the API probe never substitutes for the runner
    check. On a runner host, require every local registration online, newer
    than its pre-restart observation, and on that commit. Require the whole
    criterion to hold continuously for the observation window (see below)
    before recording `VERIFIED` and `SUCCEEDED`, then write the success Inbox
    record.

Artifact construction, including a refreshed target's rebuild, uses the
disposable builder directory. Service activation uses the verified release
directory selected by the pointer and never mutates the source checkout.

### Post-restart observation window

A deploy is green only when every part of the readiness criterion stays green.
After the first all-green sample, verification keeps sampling every unit's
`is-active`, the control-plane API probe, and the local runner registrations,
once a second, for a minimum observation window of **20 seconds** by default.
Set `AGENTOS_DEPLOY_OBSERVATION_WINDOW_MS` in the deployment environment to
override it with an integer from 0 through 300000 (five minutes). Any sample that regresses inside the window fails the deploy with
`observation-window-regressed-<reason>`, naming the failing unit or the
unregistered runner id, and escalates through the normal escalation path; the
deploy never self-heals. The overall verification timeout is the upper bound
and equals the window plus thirty seconds (50 seconds at the default window).
Raising the window raises the phase’s maximum duration by the same amount.

The `VERIFIED` ledger entry records what the check actually proved:
`service_verification.units_checked`, `service_verification.runners_registered`,
`service_verification.observation_window_ms`, and
`service_verification.observed_for_ms`.

### Quiet-window wait budget and alert

Step 2 of the activation sequence polls for zero blocking agent Runs every
`QUIET_WINDOW_POLL_SECONDS` (60 by default) and has no deadline: the deploy
waits until the platform is quiet for agent work. Mechanical merge execution
and readiness evaluation are not blockers. The wait is measured, and crossing
a budget tells the operator without changing when the deploy proceeds.

On the control-plane role, this step is reached after the cadence gate admits
an interval-eligible attempt. A tick that is coalesced exits before the wait, and a tick whose first
query finds a natural quiet window proceeds early without opening the wait
budget or a dispatch drain.

The budget is **45 minutes** by default. Override it by setting
`QUIET_WINDOW_WAIT_BUDGET_MINUTES` in **`shared/.env`** on the deploying host,
which the deploy loads into its environment before any phase runs. The
installer-generated launchd plist and systemd unit carry a closed environment
block and do not name this key, and the scheduled job inherits nothing from an
operator shell, so `shared/.env` is the only location that reaches the deploy.
The value is an integer from 1 through 1440; an out-of-range or non-integer
value refuses the deploy with `environment-invalid` before the release
artifact is built, leaving nothing to roll back.

On crossing the budget the deploy, still waiting:

- appends a `QUIET_WINDOW_WAIT_EXCEEDED` entry to the ledger, carrying
  `quiet_window_wait_seconds`, `quiet_window_wait_polls`,
  `quiet_window_wait_peak_blocking_runs`, the target commit, and
  `quiet_window_blocking_runs_by_runner` — the blocking Run count keyed by the
  runner that owns each Run;
- sends one informational Inbox notice with the text
  `自动部署等待超时，已开始排空派发`. This is the normal notification that a
  dispatch drain has begun, not a deploy failure; the failure kind remains for
  real deployment failures. The notice is scoped to the deployment attempt,
  so a later attempt with the same revisions and the same timing raises its
  own message rather than reusing this one.

It also opens a **dispatch drain**: one `DispatchDrain` row naming this host,
its deploy role and the two commits. While that row is unexpired, the control
plane refuses only claims that would start an agent session. The claim route
decides this from the candidate Run's template Step kind, not from runner
identity: agent Runs such as `implementation` receive `409 Conflict` with code
`dispatch-draining`, while mechanical merge execution (`merge-result`) and
readiness evaluation (`merge-authorization`) continue to be admitted. The
mechanical flow remains safe because the deploy barrier is the exclusive half
taken when the deploy actually starts. Already claimed Runs are never
interrupted, no chain is held, and runners keep polling and reporting
themselves, so `GET /runners` shows them online with `dispatchDrain` set rather
than lost. The quiet-window `blockingRuns` count continues to include active
agent Runs only; mechanical merge/readiness work does not make the deploy wait.

The deploy deletes the row on every exit path it has — success, failure,
escalation and interruption — and a delete that fails is logged as
`STOP dispatch-drain-delete-failed` and written to the escalation record.
`expiresAt` is the fail-safe for a deploy process that dies mid-wait: the claim
route treats an expired row as absent, so the fleet resumes by itself **120
minutes** after the deploy last reported itself even if nothing deleted it. A
wait that is still running pushes that deadline out on each hourly alert, so the
bound measures silence rather than capping how long one wait may drain
dispatch. Override it with `DISPATCH_DRAIN_DEADLINE_MINUTES` in
**`shared/.env`** (an integer from 1 through 1440, validated like the wait
budget above). A deploy that finds its quiet window inside the budget opens no
drain at all.

The drain's own lines name the row, so an operator reading the log can match a
refused claim to the deploy that caused it, to each renewal, and to the moment
it ended:

```
HOLD dispatch-draining id=cmt0drain0001 expires=2026-09-07T04:00:00.000Z
PASS dispatch-drain-cleared id=cmt0drain0001 rows=1
```

Mechanical merge execution and readiness evaluation continue while the drain
is open. Ordinary agent runners log `Runner claim drain refusal ended` and
claims answer `204` once the deploy holds the deploy barrier, while
`dispatchDrain` stays set in `GET /runners` until the release has landed and
the deploy deletes its row. If a deploy process was killed before it could
delete its row and the fleet must claim again before the deadline, delete that
one row by the id in its `HOLD dispatch-draining` line:
`DELETE FROM "DispatchDrain" WHERE id = '<id>';`.

No escalation marker is written for the wait itself, so no `--clear-escalation`
is needed and the next scheduled deploy is not blocked by the alert. A wait
that stays blocked re-alerts at most once per hour; an alert that fails to
reach the Inbox does not consume that hour and is retried on the next poll.
Delivery runs beside the polling loop, so a stalled notifier never delays
acquiring the window. A wait that crosses the budget and then finds its window
on the next poll still alerts and still records its event.

The control-plane quiet-window query is **database-wide for active agent Runs**:
it counts every `claimed`, `provisioning`, or `running` agent Run in the
platform database, including Runs on runner-only hosts that this deploy does
not touch. Mechanical merge/readiness work is admitted during a drain and does
not enter this blocker count. A control-plane deploy therefore waits for the
Mac runners' agent Runs as well as its own, which is what
`quiet_window_blocking_runs_by_runner` makes visible. Only the runner role
scopes the query to its own local runner ids.

Every `HOLD quiet-window` line names both facts:

```
HOLD quiet-window blockers=4 elapsed=2700s statuses=running,claimed
HOLD quiet-window blockers=0 elapsed=180s deploy-barrier-contended
HOLD quiet-window-wait-exceeded still-waiting-elapsed-2700s-budget-2700s blockers=4
```

#### Reading wait durations from the ledger

Every attempt that acquired a quiet window records the completed wait on its
ledger entries, whatever the attempt's outcome:
`quiet_window_wait_seconds`, `quiet_window_wait_polls`, and
`quiet_window_wait_peak_blocking_runs`. Read the distribution across retained
deployments (14 by default) from the host:

```sh
jq -r '[.deployment_id, .state, .quiet_window_wait_seconds] | @tsv' \
  .agentos-deploy/deployments/*/state.json
```

A `null` wait means the attempt never reached the quiet-window phase. Use the
per-event file when the crossing itself matters:

```sh
jq -r 'select(.phase == "QUIET_WINDOW_WAIT_EXCEEDED")
  | [.timestamp, .quiet_window_wait_seconds, (.quiet_window_blocking_runs_by_runner | tostring)] | @tsv' \
  .agentos-deploy/deployments/*/events.jsonl
```

### Step deadlines and barrier watchdog

Each command-backed phase has its own deadline: artifact build, migration
preflight, migration, Prisma Client generation, prompt sync, backup, and
service control are budgeted independently. A deadline sends `SIGTERM`, then
`SIGKILL` if needed, and becomes a `DeployFailure`.

The deploy barrier has an independent watchdog beginning at acquisition. Its
control-plane budget includes the post-barrier target read and possible artifact
rebuild; the runner-role budget is unchanged. It covers hangs outside a child command; expiry is logged, written to
`.agentos-deploy/escalated.json`, and sent to the operator Inbox through the
same escalation path as other failures.

Ordinary timeout failure exits the deployment and releases the session-scoped
barrier automatically. Before publication, `current` stays active. After
publication, recovery restores the prior pointer and services; database
migrations are never rolled back.

Migration deploy timeout is the exception. The child is terminated and the
failure is written to `escalated.json` and notified, while the deploy process
keeps the same database session and barrier. Current services stay running;
new Runs cannot be claimed, and activation and restart do not proceed. The
barrier is not a service stop, so do not restart services onto a possibly
half-applied schema.

After repairing the cause, run the existing `--clear-escalation` operation.
The held process observes the cleared marker, releases its barrier, and exits
non-zero. Wait for that old process to exit normally. On Linux systemd, leave
scheduling to the timer described above; on macOS launchd, only then kick the
scheduled job with the retry command below.

This hold instruction is for the macOS launchd profile. While the log says
`HOLD deploy-barrier migration-timeout`, do not boot out, kickstart, or kill
`com.agentos.auto-deploy`, and do not log out or reboot the
host. The process deliberately refuses `SIGTERM`; `--clear-escalation` is the
only safe way to end the hold after the operator has established that the
schema is safe.

#### Timeout or hang evidence

Linux systemd output is in the journal described above. The following evidence
is for the macOS launchd profile:

Start with `~/Library/Logs/Anneal/auto-deploy.log`, identify the stalled child
PID, and capture its stack before changing process state:

```sh
sample <pid> 10 -file ~/Library/Logs/Anneal/auto-deploy-<pid>.sample.txt
```

At the same time record machine load, I/O, and competing process inventory,
including merge-gate workers and `packages/db` test processes:

```sh
uptime
top -l 1 -stats pid,ppid,command,cpu,mem,state,time,threads
ps -axo pid,ppid,lstart,state,%cpu,%mem,command
iostat -w 1 -c 3
```

Preserve these outputs with the auto-deploy log timestamps. Use the process
stack, host load, I/O state, and concurrent-task evidence to choose the next
diagnostic action.

If restart or health verification fails after pointer activation, atomically
point `current` back to `previous`, record the rollback outcome, and restart
the prior release. The rollback proves the same combined criterion: units
running, wrapper binding and prior API identity intact, and every local runner
re-registered on the previous commit, held for the same observation window. A
runner that does not come back fails the rollback with
`previous-service-verification-failed` naming that runner id. Do not roll back
database migrations, check out source, or fall back to a partial directory.

After success or a no-op, retention keeps the newest three immutable releases
while protecting both pointer targets, the newest 14 database dumps, one dump
per UTC day for 30 days, and the newest 14 deployment ledgers. Locks,
escalation state, operation workspaces, and unrecognized entries are not
retention candidates.

Apply retention explicitly with:

```sh
node current/scripts/deploy/quiet-window-deploy.mjs --prune-history
```

## Failure and escalation

These escalation rules cover Linux systemd units and macOS launchd labels;
platform-specific commands are identified below.

Remote-main reads use a bounded retry budget with backoff; each retry and
outcome is visible in the deploy log. A successful retry continues without an
escalation.

An existing escalation may be retried unattended only for
`remote-main-unreadable`, `remote-main-read-timeout`,
`control-plane-version-unreachable`, `control-plane-commit-unavailable`,
`source-remote-unreadable`, `source-remote-read-timeout`,
`quiet-window-query-failed`, or `deploy-barrier-unavailable`. The reason
`release-artifact-build-failed` is retryable-transient only when its detail
matches one of these source clone/fetch transport failures:
`gnutls_handshake() failed`, `SSL_ERROR_SYSCALL`, `could not fetch … from
promisor remote`, or `read timeout` (case-insensitive). The detail must contain
the builder's terminal `DeployFailure: release-artifact-source-unavailable:
exit-128` header and a matching final `fatal:` diagnostic before that exception
(allowing Node's throw-site display). This identifies the source clone or
checkout's promisor fetch; earlier recovered transport errors, terminal
compile/dependency failures, and ambiguous output do not qualify. The allowlist is explicit
and fail-closed: compile, test, missing-dependency, unknown, and every other
build detail remains commit-scoped when the marker names a full target commit.
Environment, authentication, malformed remote state, artifact, verification,
and filesystem-state failures stay operator-latched.

The initial escalation is attempt 1. Later eligible failures atomically
replace the marker with an incremented count. Retryable-transient markers at
attempts 1 through 4 still admit on the next tick without a backoff. At
attempt 5, the marker carries a `retryAfter` timestamp and waits five minutes
before its next admission. If that retry fails, later retries wait 10, 20, 40,
and then 60 minutes; 60 minutes is the cap for all subsequent attempts. The
marker is the single source of truth for this schedule. A legacy capped marker
without `retryAfter` derives its first deadline from `escalatedAt` plus the
delay for its attempt count. At rollout, a pre-existing capped marker whose
computed deadline has already passed admits one immediate retry on the first
tick; operators should not expect a fresh five-minute wait after installation.
While the deadline is in the future, the tick
stays stopped and logs:

```text
STOP escalation-active scope=retryable-transient retry-after=<ISO> remaining-wait-seconds=<n> path=<path>
```

When `retryAfter` has expired, the tick admits a normal full attempt. Admission
does not clear the marker: only a successful full deployment, or proof that
the target is already deployed, followed by a successful recovery
notification removes `.agentos-deploy/escalated.json` and logs
`SELF-CLEAR escalation reason=<reason> attempts=<n>`. If the attempt fails, it
replaces the marker with the incremented count and the next backoff. If the
recovery notification fails, the marker remains. Confirm the SELF-CLEAR entry
and closed recovery notification before dismissing the original failure.

`host-scoped` markers retain their operator-action requirement and continue to
stop every later tick until the named cause is repaired and an operator runs
`--clear-escalation`. A `commit-scoped` marker blocks its recorded commit; if
`origin/main` advances, the supersession rules below allow a newer target to
proceed while the marker remains as history. If the recorded commit is still
the target, it continues to stop that attempt until the cause is repaired and
an operator runs `--clear-escalation`.

### Escalation classes

Every marker falls into exactly one of three classes, decided by its recorded
target commit `to` first and its `reason` second:

- **retryable-transient** — a reason on the allowlist above, on a marker whose
  `to` is a full commit oid or the literal `unknown` the deploy records when it
  failed before determining a target. A `release-artifact-build-failed`
  marker qualifies only for the source clone/fetch transport details listed
  above; every other build detail is commit-scoped only when the marker names a
  full target commit. The retry deadline and self-clear rules in this section
  own a qualifying marker end to end; the commit main points at does not change
  its answer, in either direction. A transport-detail build failure at the cap
  therefore blocks newer commits until `retryAfter`, potentially for 60 minutes;
  `--clear-escalation` is the operator override when deployment must not wait.
  A transient-looking reason on a marker with
  any other `to` (missing, or neither a full commit oid nor `unknown`) is
  host-scoped instead: it spends no retry attempt and blocks every deploy.
- **commit-scoped** — any other reason on a marker whose `to` is a full commit
  oid: the failure was determined by that commit (its non-transport artifact
  build, its migration, or its verification). It blocks that commit and only
  that commit.
- **host-scoped** — a reason naming host state rather than the commit, or any
  marker whose `to` is missing or is neither a commit oid nor `unknown`,
  whatever its reason. It blocks every deploy.
  The set is `database-backup-failed`, `database-backup-timeout`,
  `release-directory-assembly-failed`, `deployment-ledger-write-failed`,
  `operation-workspace-preparation-failed`, `release-pointer-activation-failed`,
  `release-pointer-rollback-failed`,
  `release-pointer-rollback-unavailable`,
  `previous-service-verification-failed`, `previous-service-restore-failed`,
  `previous-service-restore-timeout`, `service-wrapper-verification-failed`,
  `service-control-denied`, `service-control-failed:<verb>:<unit>`,
  `stale-deploy-owner-recovered`,
  `deploy-interrupted`, `environment-unreadable`, `environment-invalid`,
  `workspace-layout-invalid`, `escalation-state-unreadable`,
  `escalation-state-changed`, and `unexpected-error` — defined next to the
  retryable allowlist in `scripts/deploy/quiet-window-deploy.mjs`.

A marker carrying `activationOutcomeProven: false` is always host-scoped,
regardless of reason or retry eligibility: activation or recovery did not prove
the serving state. This fact also protects runner hosts without a migration.

### Supersession by a newer commit

When a commit-scoped marker is latched and `origin/main` has moved to a
different commit, the tick reads the new target and proceeds with it regardless
of the cadence floor, logging

```text
SUPERSEDE escalation reason=<reason> failed-commit=<oid> target=<oid>
```

The marker is never deleted by this logic: it stays on disk as history until an
operator runs `--clear-escalation`. The supersession is an additive ledger
fact instead — every event of the superseding deployment, and its `state.json`,
carry it. Later attempts that bypass the same retained latch also record this
provenance until the marker is replaced or explicitly cleared.

```json
"superseded_escalation": {
  "failed_commit": "<the commit that latched>",
  "reason": "<why it latched>",
  "escalated_at": "<when it latched>"
}
```

The commit that latched is never attempted again on its own: while `origin/main`
still points at it the tick stops with
`STOP escalation-active commit-unchanged commit=<oid>` and exit 2. If the new
commit fails too, it latches against its own oid under the same rules. A target
read that fails while a commit-scoped marker is latched also stops with
`STOP escalation-active target-unreadable reason=<reason>`, leaving the marker
untouched: an unreadable remote cannot prove main moved.

For any host-scoped escalation or a commit-scoped escalation whose commit is
still the target,
inspect the ledger, logs, pointer identities, service states, and Inbox record;
repair the named cause, build and verify the artifact again, and rerun
`--dry-run`.

Only then clear and retry. Run this from the deployment root, the directory
holding `current/` and `.agentos-deploy/`. The marker is resolved from
`AGENTOS_REPOSITORY_ROOT`; without it the command looks under
`current/.agentos-deploy/`, deletes nothing, and prints
`NO-ESCALATION-TO-CLEAR path=...`. Check the printed path before assuming the
escalation is gone.

The first command below clears the marker for either profile. On Linux systemd,
leave scheduling to the timer described above; on macOS launchd, then kick the
auto-deploy label:

```sh
AGENTOS_REPOSITORY_ROOT="$PWD" \
  node current/scripts/deploy/quiet-window-deploy.mjs --clear-escalation
launchctl kickstart -k "gui/$(id -u)/com.agentos.auto-deploy"
```

On the macOS launchd profile, the second command is valid only after a
migration-timeout hold has ended as described above; it does not apply to
Linux systemd.

### Canonical prompt sync refused by an archived Agent

`reason=canonical-prompt-sync-refused` with the detail
`Agent <name> (<id>) is archived; sync will not resurrect it` means a role
that main now treats as canonical shares its name with an Agent the operator
archived earlier in that project. Sync refuses by design: resurrecting an
archived Agent would silently bring back its old prompt, model, and grants.

Repair through the operator API, not SQL. Rename the archived Agent out of
the way so that sync creates the canonical one fresh from its source role:

```sh
curl -X PATCH "$BASE_URL/agents/$AGENT_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"<name>-legacy-<yyyymmdd>"}'
```

If that PATCH answers `Model <m> requires <runner>, but this Agent stores
<other>`, the archived row carries a model/runner pair the current catalog
rejects; include a matching `runnerPreference` in the same request. Do not
unarchive instead: an archived row whose `title` or runtime configuration
drifted from the canonical Markdown is refused again one step later as
`differs from canonical Markdown structure`. Then clear the escalation as
above; the next tick creates the Agent, logs `createdAgents` for the project,
and continues to publication. Signals before activation enter the normal `FAILED` path and
remove the operation workspace. Signals after activation perform pointer
recovery before releasing the barrier. An uncatchable stale process owner is
reclaimed once and escalated instead of starting an unrecorded second
deployment.
