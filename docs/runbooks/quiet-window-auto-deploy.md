# Quiet-window auto-deploy

> This runbook covers the maintainer's macOS appliance and Linux systemd
> deployment profiles. It is published for auditability and reproducibility;
> it is outside the Developer Preview Quickstart, the supported installation
> shape, and a production-support commitment.

The job advances the release named by `current` to an exact target commit from
`main`. On the control-plane host it manages `com.agentos.api`,
`com.agentos.inbox`, the configured runner labels (10 by default), and
`com.agentos.web` (13 labels at the default count). Linux uses the same
generated inventory. The release may contain the resident merge-executor
runtime, but that service is outside this activation set. An Anneal Run
workspace is never deployed.

## Runner-only host

Set `AGENTOS_DEPLOY_ROLE=runner` while rendering a separate runner host's
service and auto-deploy definitions. The unset value, or explicit
`control-plane`, is the host role for the API, Inbox, web, database, and
canonical prompts. The install manifest records the role; stage two refuses a
manifest whose recorded role differs from the configured role.

A runner host installs only the configured `com.agentos.runner` labels,
controlled by `AGENTOS_RUNNER_COUNT` and `AGENTOS_RUNNER_ID_PREFIX`. Its prefix
is required, host-specific, and disjoint from the control-plane host's runner
IDs; an empty or invalid prefix fails preflight. It never installs, restarts,
or verifies `com.agentos.api`, `com.agentos.inbox`, or `com.agentos.web`. Its
deployment phases omit `backup`, `guarded-migration`,
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

Quiet-window blockers on this host are active Runs whose `runnerId` is in this
host's generated inventory. After restart, every local runner must be online,
register again with a newer observation, and report the deployed build commit
through `GET /runners`. A missing, stale, offline, or mismatched registration
fails verification; the job points `current` back to `previous`, restarts the
local runners, and succeeds in recovery only after they all report the
previous release's commit.

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

`com.agentos.web` serves `apps/web/dist` with Vite preview at
`http://127.0.0.1:4173`. Use the numeric loopback address; the
credential-bearing proxy rejects other origins.

## Preconditions

For macOS and unprivileged Linux stages, use the account that owns the service
definitions; never run those stages as `root`. Linux stage two is the explicit
root-only exception described below. Require:

- `current` and `previous` are relative symlinks to direct children of
  `releases/`;
- `shared/.env` is mode 0600 and contains the keys for the deployed role:
  control-plane requires `DATABASE_URL`, `FEISHU_DEFAULT_CHAT_ID`, and
  `GITHUB_READ_TOKEN` (the latter must be in the file); runner requires
  `OPERATOR_TOKEN` and `RUNNER_TOKEN`, with optional `RUNNER_API_URL` validated
  by `controlPlaneApiBaseUrl`. It also contains the five absolute persistent
  paths beneath `shared/`:
  `FILES_ROOT`, `RUNNER_WORKSPACE_ROOT`, `RUNNER_DEPENDENCY_CACHE_ROOT`,
  `RUNNER_REPO_MIRROR_ROOT`, and `CONTROL_PLANE_STATE_DIR`;
- every configured service definition uses
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

## Install service wrappers

The wrapper migration must finish before pointer activation. On macOS, plan
then apply the complete generated service inventory:

```sh
node scripts/deploy/install-launchd-services.mjs --replace-existing
node scripts/deploy/install-launchd-services.mjs --replace-existing --apply
```

The installer records original definitions and manifests, creates
`shared/bin/agentos-service-wrapper.mjs`, and writes wrapper-based plists. Its
apply path may `bootout` retired labels and `kickstart` changed owned labels;
if a label must be reloaded manually, let its graceful predecessor disappear
before bootstrapping the same label. Require every inventory label to be
running, each log to identify the same `current` release, `/health` to pass,
and `/version` to report the exact current commit.

## Install auto-deploy

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
`~/Library/Logs/Anneal`, runs at load, and repeats every five minutes. The
installer refuses to overwrite a different existing definition. A runner-only
host does not need database backup arguments because its backup phase is
omitted.

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
per generated service. The auto-deploy manifest is separate: one plist on
macOS, or a `Type=oneshot` service and timer on Linux. The Linux oneshot is
installed but never enabled or started directly; `enable --now` applies to the
timer only, so installation cannot trigger an immediate deployment.

### Runner count, accounts, and logs

`AGENTOS_RUNNER_COUNT` defaults to 10 and accepts integers 1 through 64. In
control-plane inventory order, labels are API, Inbox, runner 1 as
`com.agentos.runner`, runners 2 through the configured count, then web. A
runner-only inventory contains only the runner labels.

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
barrier checks are the same as on macOS. If activation verification fails,
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

## Activation sequence

For a new target commit, the job records `STARTED`, invokes the explicit
builder, and performs this order:

1. After `ARTIFACT_PREPARED`, verify release name, exact commit stamp, manifest
   inventory, content digest, excluded-path record, and read-only permissions;
   record `ARTIFACT_VERIFIED`. A missing artifact or digest mismatch records
   `FAILED` before quiet-window acquisition.
2. Query for zero blockers, acquire the exclusive PostgreSQL deploy barrier,
   and query again. Hold the barrier through activation, verification, or
   recovery.
3. Copy the verified release to a disposable writable operation workspace. It
   is not a Git checkout and is never published.
4. Prove every configured service is running through the stable wrapper and
   still identifies the old `current` release.
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
   restart every configured label.
10. Require all labels running. On the control plane, require `/health` success
    and `/version` reporting the exact clean target commit. On a runner host,
    require every local registration online, newer than its pre-restart
    observation, and on that commit. Record `VERIFIED` and `SUCCEEDED`, then
    write the success Inbox record.

The sequence has no install, compile, source-checkout mutation, or
multi-directory publication. The activation unit is the verified release
directory selected by the pointer.

### Step deadlines and barrier watchdog

Each command-backed phase has its own deadline: artifact build, migration
preflight, migration, Prisma Client generation, prompt sync, backup, and
service control are budgeted independently. A deadline sends `SIGTERM`, then
`SIGKILL` if needed, and becomes a `DeployFailure`.

The deploy barrier has an independent watchdog beginning at acquisition. It
covers hangs outside a child command; expiry is logged, written to
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
non-zero. Wait for that old process to exit normally; only then kick the
scheduled job with the retry command below.

While the log says `HOLD deploy-barrier migration-timeout`, do not boot out,
kickstart, or kill `com.agentos.auto-deploy`, and do not log out or reboot the
host. The process deliberately refuses `SIGTERM`; `--clear-escalation` is the
only safe way to end the hold after the operator has established that the
schema is safe.

#### Timeout or hang evidence

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
the prior release. Do not roll back database migrations, check out source, or
fall back to a partial directory.

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

Remote-main reads use a bounded retry budget with backoff; each retry and
outcome is visible in the deploy log. A successful retry continues without an
escalation.

An existing escalation may be retried unattended only for
`remote-main-unreadable`, `remote-main-read-timeout`,
`control-plane-version-unreachable`, `control-plane-commit-unavailable`,
`source-remote-unreadable`, `source-remote-read-timeout`,
`quiet-window-query-failed`, or `deploy-barrier-unavailable`. Environment,
authentication, malformed remote state, build, artifact, verification, and
filesystem-state failures stay operator-latched.

The initial escalation is attempt 1. Later eligible failures atomically
replace the marker with an incremented count. Attempts below the fixed cap of
5 may run again; attempt 5 blocks later ticks like a permanent escalation.
Admission alone never clears a marker. A full successful deployment, or proof
that the target is already deployed, must complete before the job reports
recovery, removes `.agentos-deploy/escalated.json`, and logs
`SELF-CLEAR escalation reason=<reason> attempts=<n>`. If the recovery
notification fails, the marker remains. Confirm the SELF-CLEAR entry and
closed recovery notification before dismissing the original failure.

For any non-allowlisted escalation or an eligible escalation at the cap,
inspect the ledger, logs, pointer identities, service states, and Inbox record;
repair the named cause, build and verify the artifact again, and rerun
`--dry-run`.

Only then clear and retry. Run this from the deployment root, the directory
holding `current/` and `.agentos-deploy/`. The marker is resolved from
`AGENTOS_REPOSITORY_ROOT`; without it the command looks under
`current/.agentos-deploy/`, deletes nothing, and prints
`NO-ESCALATION-TO-CLEAR path=...`. Check the printed path before assuming the
escalation is gone.

```sh
AGENTOS_REPOSITORY_ROOT="$PWD" \
  node current/scripts/deploy/quiet-window-deploy.mjs --clear-escalation
launchctl kickstart -k "gui/$(id -u)/com.agentos.auto-deploy"
```

The second command is valid only after a migration-timeout hold has ended as
described above.

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
