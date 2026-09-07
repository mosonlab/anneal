# Runbook — merge-gate workers and the gate dispatcher

> **Audience and support status.** Remote gate workers are optional,
> operator-provided infrastructure. They are not created by the Quickstart or
> bundled with an Anneal installation. Public operators may provision their own
> SSH-reachable Ubuntu workers and configure them explicitly. The local
> `scripts/merge-gate.sh` path requires no remote worker. The remote-worker
> profile is maintainer-verified on Ubuntu 24.04; see the support matrix.

A merge gate selects its own profile from the exact baseline-to-candidate diff.
Content-only modifications to the gate's explicit prose allowlist use the
install-free `docs-only` profile; callers cannot request it. Every structural,
runtime-coupled, executable, configuration, or unknown change uses the full
profile.

A full profile is `npm ci` with Prisma generation in postinstall, the database
CLI typecheck, lint, a whole-workspace compile, unit tests, a throwaway
PostgreSQL, and the database tests from both packages. It runs as three
concurrent groups rather than one serial chain, in the only order their real
dependencies allow: dependencies alongside the install-free suites, then
everything that needs `node_modules` but not `dist/`, then the three proof waves
together. PostgreSQL starts before the first group so its initdb overlaps work.
Concurrency changes latency, never the question the gate asks — every step still
runs, with the same command, and a group passes only when all of its members do.

An interrupted gate stops its members before it tears anything down. Members run
as process-group leaders (`scripts/gate-worker/step-engine.sh`), and `cleanup`
in `scripts/gate-worker/verdict.sh` signals each group, gives it five seconds,
then kills it — all before it removes `GATE_TMP`, releases the worktree lock and
deletes the container. Signalling the gate process alone would leave a build
still writing `dist/` while the next gate takes the lock this one just released,
so do not remove the `set -m` around the spawn in `step-engine.sh`: it is what
makes the whole tree reachable rather than just the member's own shell.

How wide each group runs is derived from a stated share of the host, not from
the core count. `run-gate.sh` exports `AGENTOS_GATE_HOST_SHARE` as the worker's
`host-share` setting, which defaults to its slot count, so on the two-slot
desktop each gate sizes itself for half the machine and two concurrent gates
still add up to one host. A gate invoked by hand states no share and takes half
the machine. Do not restore a per-phase fan-out in
`run-gate.sh`: `7886fad` set `AGENTOS_DBTEST_CONCURRENCY` there, `merge-gate.sh`
recomputed that same variable moments later, and the bound silently never took
effect while both logs claimed it had.

Measured on the 14-vCPU, 20 GiB desktop worker at capacity two, 2026-08-30.
A single full gate is about **172 seconds** end to end with a build-cache miss —
which is every ordinary new commit. Two overlapping full gates take about **262
seconds each**, which is still 24% more throughput than running them serially,
and neither leaks a container, scratch database, worktree or lock. On the
4-vCPU fallback worker at capacity one a full gate is about **384 seconds**. The
install-free `docs-only` profile still takes about 4 seconds.

These numbers replace the 2026-08-25 baseline (122 seconds single, 175 each
concurrent, 252 on the fallback) and the gap is corpus growth, not regression:
the database pool went from 65 files to 78 and the schema from about 30
migrations to 43 over those five days. The fallback worker moved the most in
absolute terms because it has 4 cores against 14, and every wave there scales at
roughly that ratio — build 2.2x, database 2.3x, lint 2.7x, unit 3.6x. A fallback
number that drifts *away* from its core-count ratio is the one worth
investigating; one that tracks it is just a smaller machine doing more work.

Within a gate the proof waves are still the whole cost: 120 seconds for the
database tests and 42 for the unit tests when a gate runs alone, 188 and 79 when
two gates overlap, against 36 for lint and 38 for a cold build. Widening the
database lanes does not move it — 4, 6 and 8 lanes all landed within 3 seconds
of each other over one fixed commit — because the waves saturate PostgreSQL and
the CPU share together rather than running out of lanes. `NODE_COMPILE_CACHE`
was measured and rejected: 80 seconds cold against 82 warm, for 77 MiB of cache.
That tuning direction is closed: the ceiling is work-bound, and the measurements
behind it are recorded in operator records outside this repository. The lane
widths stay overridable (`AGENTOS_GATE_UNIT_LANES`, `AGENTOS_GATE_DB_LANES`); a
gate never chooses them itself.

`packages/db` and `packages/api` hand their database files to one pool rather
than two waves. Dividing lanes between a five-file wave and a forty-two-file one
is a guess about a ratio nothing maintains, and on the four-core fallback worker
the guess starved the small wave to a single lane and 201 seconds. One pool
balances itself and migrates the template once.

`provision.sh` is in `scripts/gate-worker/`; the other five ship from
`packages/runner/runtime-tools/gate-worker/`:

| File | Runs on | What it does |
| --- | --- | --- |
| `provision.sh` | the server | Installs the pinned toolchain and creates `~/gate/`. Idempotent, dry-run by default. |
| `mirror-push.sh` | the local machine | Pushes one exact candidate and one exact baseline into immutable `refs/gate/.../<oid>` cache refs, creating `~/gate/<repo>/mirror.git` on first push, and installs `run-gate.sh` beside it. |
| `run-gate.sh` | the server | Holds one configured worker-wide execution slot, checks one oid out of its repository's mirror and runs `scripts/merge-gate.sh --expect-head <oid> --master <baseline-oid>` against it. |
| `remote-gate.sh` | the local machine | One synchronous `ssh` call; returns a bounded per-failing-step worker-log excerpt on FAIL, followed by the verdict line, and the exit code. |
| `gate-dispatch.sh` | the local machine | Freezes the candidate and integration baseline, then tries eligible local slots before the primary and fallback workers. Local execution is explicit only. |
| `lib.sh` | both | Shared input validation and atomic pid-slot locking. |

The worker hosts one directory per repository, keyed by the origin repository's
name: `~/gate/<repo>/{mirror.git,worktrees,logs,run-gate.sh}`. The toolchain is
worker-wide and provision.sh's job; a repository's directory is created by its
first `mirror-push.sh`. A repository qualifies by shipping its own
`scripts/merge-gate.sh` — the gate that judges a commit is the gate that commit
ships.

## The slot model

A full gate can consume a host. The dispatcher cannot know the
candidate-selected profile before running it, so it rations fixed, measured
host capacity rather than trying to resize from live CPU or memory readings.
An explicitly configured primary worker contributes two slots and an explicitly
configured fallback contributes one. The explicit `--server` form contributes
one dispatcher slot. The local machine contributes no automatic capacity; it
adds `AGENTOS_GATE_LOCAL_SLOTS` slots only for an invocation that passes
`--allow-local` or sets `AGENTOS_GATE_ALLOW_LOCAL=1`. The count defaults to one
when `AGENTOS_GATE_LOCAL_SLOTS` is unset and is capped at 1024; configured slots
are named `local-1` through `local-N` (there is no bare `local` slot). Each
dispatch round tries eligible local slots before the remote workers. With no
remote configured, that explicit opt-in selects a local-only dispatch; with
neither remote capacity nor local opt-in the dispatcher returns `76` instead of
guessing a host.

`gate-dispatch.sh` is the way to run a gate when anything else might also be
running one; set `AGENTOS_WORKSPACE_PATH` to the checkout explicitly:

```sh
AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" AGENTOS_GATE_SERVER=primary-worker packages/runner/runtime-tools/gate-worker/gate-dispatch.sh <oid>
```

- The candidate is the exact requested `<oid>`. Unless `--master <oid>` is
  supplied, the dispatcher fetches origin's current default branch without
  creating a local tracking ref, re-reads `origin HEAD`, and freezes that exact
  oid as the baseline before taking a slot.
- When local dispatch is enabled, the dispatcher considers `local-1` through
  `local-N` first. A local slot is eligible only when this worktree is clean at
  `<oid>`; it runs `scripts/merge-gate.sh` directly in the workspace. A local
  `PASS`, `FAIL`, or `NOT AUTHORITATIVE` result is final. If the local gate
  produces no verdict, its capacity is retired for the invocation and the
  dispatcher continues to the configured remote workers.
- If local execution is ineligible or every local slot is busy or broken, the
  primary worker is tried. It runs `mirror-push.sh` before `remote-gate.sh`,
  pushing only the frozen candidate and baseline under oid-named cache refs. The
  local checkout may be detached or single-branch; its incomplete ref namespace
  is never mirrored and cannot delete worker refs.
- If the primary is offline, its mirror push fails, its SSH connection drops,
  or no usable primary slot can accept the gate because a primary slot is
  unavailable, the fallback receives the same frozen candidate and baseline
  immediately. A real `PASS`, `FAIL`, or `NOT AUTHORITATIVE` result is final;
  only absence of a verdict falls through to another machine. SSH connection
  setup is bounded at 10 seconds, and a dead established connection is
  detected by keepalives instead of waiting on the operating-system TCP
  timeout.
- When every primary slot is healthy but busy, the dispatcher waits for
  `GATE_DISPATCH_FALLBACK_AFTER_MINUTES` minutes before trying the fallback
  (default `6`, also used for an empty value; it accepts an integer from `0`
  through `35791394`, and `0` tries the fallback
  immediately). It keeps polling the primary during that grace period, so a
  primary slot that frees up handles the gate before the slower fallback is
  used. A broken or unavailable primary slot does not count as busy. A timeout
  shorter than the grace can return `75` without probing fallback; increase
  the timeout or reduce the grace if fallback must be eligible before timeout.
- All usable slots busy: the dispatcher blocks and re-polls (default every 30s —
  `GATE_DISPATCH_POLL_SECONDS`). `GATE_DISPATCH_TIMEOUT_MINUTES` (default 60)
  bounds a queue that is *not moving*, not the wait itself. Every poll reads the
  pid each busy slot's lock names; when a slot this dispatch was already
  watching changes hands, a gate that was holding a slot ended, the queue is
  moving, and the timeout starts again from that moment
  (`gate-dispatch: the queue moved (slot <slot> changed hands)`). A queue deeper
  than the timeout divided by a gate's duration therefore keeps waiting instead
  of being cut off mid-queue — which is what made 16 runners sharing one slot
  burn a full wait and re-queue at the back. The wait still has an absolute
  ceiling of twice the timeout, because acquiring a slot is a race rather than a
  place in a line: a dispatch that keeps losing that race would otherwise watch
  the queue move forever.
  A queue where nothing finishes for the whole timeout, and a moving queue that
  never lets this dispatch in before the ceiling, both exit **75** with
  `GATE DISPATCH: NO SLOT`: nothing ran, no verdict exists, and re-dispatching is
  the recovery. The stderr line above it says which of the two happened — a
  stalled gate is a hung-gate question, a queue that moves without admitting this
  dispatch is a capacity question, and neither is a code question. A slot that appears in the
  observation only because its own rule let it (the fallback at the end of its
  grace) is not turnover, so the grace never extends the timeout.
- A slot whose lock cannot be *operated* — a read-only slot root, a lock left by
  the pre-#132 dispatcher, a lock naming no pid — is not busy and is never waited
  on. The dispatcher keeps using whatever slots still work; if none do it exits
  **76** immediately with `GATE NOT RUN:` naming the slots to clear, and if it
  waited on a busy slot and the wait ran out with a broken lock still around it
  exits 76 rather than 75. Waiting for a lock nobody can take is waiting for
  nothing, and reporting it as a full queue hides what to fix.

The dispatcher accounts for `remote-1`, `remote-1-2`, `remote-2`, and, when
local dispatch is enabled, `local-1` through `local-N` in the slot directory
described below, outside any repository. A direct `merge-gate.sh` bypasses that
accounting. A direct `remote-gate.sh` bypasses the local lock too, but it cannot
exceed worker capacity: every installed `run-gate.sh` contends for the
worker-wide `~/gate/.full-gate.lock` and, only on a capacity-two host,
`~/gate/.full-gate-2.lock`. Each is held with `flock` for the real process
lifetime. If an SSH connection drops while its remote process survives, that
process keeps its worker slot and a later invocation waits instead of exceeding
the configured capacity.

That wait is bounded. `run-gate.sh` gives up after `SLOT_WAIT_MINUTES` (default
20) with `GATE NOT RUN: worker slot wait exceeded <n> minutes` and exit `76`, so
the dispatcher takes the same commit to its fallback worker. The bound exists
because the dispatcher's own `--timeout-minutes` cannot interrupt an attempt
that has already reached the worker: a dispatcher counting two slots on a worker
whose `worker-capacity` says one produced an ssh session that simply never
returned. The dispatcher also reads the capacity the worker states in its own
output and logs `gate-dispatch: warning — the primary worker reports
worker-capacity N but this dispatcher configures M primary slot(s)` when they
disagree. That warning changes nothing on its own; it names the drift.

Local slots are accounted per runner account: the account that owns
`AGENTOS_RUNNER_HOME` owns the shared slot directory at
`$AGENTOS_RUNNER_HOME/.cache/gate-dispatch/`. On a host with one account and
many runners, `RUNNER_GATE_LOCAL_SLOTS` is the host ceiling. On a host with one
account per runner, it is a per-runner ceiling and the host ceiling is the sum
of those per-runner counts. Outside a runner, `AGENTOS_RUNNER_HOME` is unset and
the slot directory continues to resolve to
`${XDG_CACHE_HOME:-$HOME/.cache}/gate-dispatch/` as before.

A lock is a file created with `ln`, holding the pid of the dispatcher that owns
it. That shape is deliberate and `packages/runner/runtime-tools/gate-worker/lib.sh` explains it:
`link(2)` is the one atomic create-or-fail that also carries its payload, so a
slot lock names its owner from the instant it exists. A lock *directory* with a
pid file written a moment later has a window in which it names nobody, and a
second dispatcher reading that window calls the lock abandoned, deletes it, and
takes the slot its owner is already gating in — one slot silently becoming two
gates. Reclaiming a lock whose pid is gone is done by hard-linking it
to a witness name first, so of two dispatchers that both see the holder dead
exactly one may act; a lock whose pid is still alive is never touched, and a
lock that names no pid at all is never reclaimed automatically — it blocks the
slot and says so, because a file this script did not write is not evidence that
nobody is running a gate.

## Exit codes

One rule: **a verdict and the absence of a verdict never share a code.**
`gate-dispatch.sh` and `remote-gate.sh` transport verdicts and never form one,
so neither can produce a `1` of its own.

The codes below `128` and the four lines that carry them are defined once, in
`packages/runner/runtime-tools/gate-worker/lib.sh`, which every script in the chain sources —
`merge-gate.sh` emits through it and `run-gate.sh` reads the log back through
it. That file is the place to look when a code or a line is in question, and the
only place to change one. `lib.sh` is installed on the worker beside
`run-gate.sh` by `mirror-push.sh`, so the harness and the format it speaks
always arrive together.

| Code | Means | Is it a verdict? |
| --- | --- | --- |
| `0` | `MERGE GATE: PASS <oid>` | yes |
| `1` | `MERGE GATE: FAIL (<step>)` | yes |
| `2` | usage error | no gate ran |
| `3` | `MERGE GATE: NOT AUTHORITATIVE` — the run was asked to leave state behind (`--keep-postgres`), or every step passed and the host then failed to finish tearing the run down (`cleanup: ...`) | yes |
| `75` | `GATE DISPATCH: NO SLOT` — every slot stayed busy and either none of them changed hands for the whole timeout or none came free for this dispatch before the ceiling of twice the timeout | no gate ran |
| `76` | `GATE NOT RUN: <reason>` — no configured worker produced a verdict, or a precondition failed: a mirror push failed, a slot lock could not be operated, origin was unreadable, the baseline is absent, the toolchain is incomplete, **the docker preflight found no `docker` or no reachable daemon**, **the wait for a worker execution slot exceeded `SLOT_WAIT_MINUTES`**, a step was stopped from outside before it could be judged, or `merge-gate.sh` died without printing a verdict | no gate ran |
| `130` / `143` | interrupted — `merge-gate.sh` prints `GATE NOT RUN: <reason>` and exits under the signal that stopped it | no gate ran |
| `128+N` | the gate process died on signal N without a verdict; `137` is `SIGKILL`, which is almost always the OOM killer | no gate ran |
| `255` | ssh transport failure from direct `remote-gate.sh`; the dispatcher consumes this and tries its fallback | no gate ran |

**`1` is the only code that means the commit was judged and did not pass.**
`75`, `76`, `128+N` and `255` are errands, not judgements: re-dispatch after
fixing what the message names. An automation that treats them as FAIL blocks
merges on network weather and, worse, teaches people to ignore FAILs.

That line is drawn by who the failure is about, not by where it happened. A
missing `--expect-head` match, a dirty worktree, a baseline that is not in the
repository: those are about this commit and this invocation, so they are `1`.
A host with no `docker` binary or no reachable daemon is about the machine, so
it is `76` and the dispatcher takes the same commit to its next worker — the
preflight reported `1` until 2026-09-06, and a dispatcher that read it as a
judgement published `MERGE GATE: FAIL (docker preflight)` for a commit no gate
had run a step against. A cleanup that fails after every step passed is the
same kind of fact about the host, but the run did test the commit and cannot
promise its container is gone, so it is `3`: not a FAIL, and not authority for
a merge either.

`75` and `76` are not interchangeable. `75` means at least one slot existed that
could have been taken and stayed busy: either nothing changed hands for a whole
timeout — a queue that stopped moving — or the queue kept moving without this
dispatch ever winning a slot before the ceiling. Either way re-dispatching later
is the fix. `76` means the slot lock itself could not be
operated (a read-only cache directory, a lock left by the pre-#132 dispatcher, a
lock naming no pid): waiting changes nothing, and the message names what to
clear. A slot whose lock is broken is never counted as busy, so a run that sees
nothing but broken locks reports `76` at once instead of polling out the timeout
and claiming the queue was full.

Every code below `128` carries a matching stdout line, so a caller may read
either: the verdict is the last line starting `MERGE GATE:` or `GATE NOT RUN:`,
and everything that ran no gate
starts `GATE NOT RUN:` or `GATE DISPATCH:`. The exception is a gate killed by a
signal it cannot handle. `merge-gate.sh` traps `INT` and `TERM` and prints
`GATE NOT RUN: <reason>` through its `EXIT` trap, so `130` and `143` still say
what happened — and say it as the absence of a verdict, because a gate that was
stopped mid-step judged nothing about the commit it was stopped on. `SIGKILL`
cannot be trapped: a gate the OOM killer takes produces `137` and **no stdout
line at all**. Read a missing verdict line as "no verdict", never as a pass —
`128+N` with silence is the one case where the code is the only evidence.

## Operating boundaries

- **No execution plane on the server.** No Anneal runner, no agent session, no
  Anthropic API call. The server builds and tests; it never acts.
- **Credentials are permitted.** Credentials do not block provisioning or gate
  execution. The normal gate path does not require GitHub or agent credentials,
  but a trusted operator VM may carry them. Candidate build and test code runs
  with the worker account's effective environment and permissions, so only
  place credentials there when that trust is intended.
- **The gate mirror has no remote.** Code reaches it by exact SSH push from the
  calling machine. `provision.sh` and `mirror-push.sh` refuse a mirror with a
  configured remote, including when the remote list cannot be read. This is an
  input-determinism rule: a worker cannot silently fetch a different candidate
  or baseline from the ones the dispatcher froze.

  **The worker is not network-isolated, and this repository does not claim it
  is** (the operator's ruling, 2026-08-20). The gate's normal flow never needs GitHub —
  the mirror arrives over SSH, nothing fetches — but nothing here denies the
  host a route to GitHub or anywhere else, and no firewall rule is required
  before a box may gate. That was weighed and declined: the gate executes the
  candidate commit's own build and test scripts, so blocking GitHub alone would
  leave every other host reachable and buy little, at the cost of maintaining
  deny rules against addresses that move. The exact pushed inputs and the
  caller's merge authority remain the relevant boundaries.
- **Local production is untouched by any of this.** `localhost:5432`,
  `localhost:3000`, `~/.agentos/` and launchd are not in this picture at all.

## What a remote PASS is worth

State this honestly wherever a remote verdict is quoted.

A remote PASS is **evidence, not authority**. The merge still happens on the
local machine and still binds an exact head. A worker can produce false
evidence if it is compromised, and candidate code can access whatever the
worker account can access; this design treats the worker as trusted compute and
does not claim credential or network isolation.

The hedge against a forged PASS is **spot-checking**: for release-grade merges,
re-run the gate locally and compare. That is a deliberate trade — one gate's
worth of local compute occasionally, instead of on every gate.

Three properties keep the evidence honest even when the worker is trusted:

- `run-gate.sh` runs `merge-gate.sh --expect-head <oid>`, so a checkout that is
  not the requested commit produces a FAIL rather than a verdict about the
  wrong tree.
- A verdict also names the baseline it was formed against, and prints it in the
  preflight. The gate's frozen-record rules (`scripts/check-frozen-docs.sh`)
  ask what is already on the default branch, and the worker mirror does not
  fetch it. So
  `gate-dispatch.sh` asks origin — `git ls-remote --symref origin HEAD`, which
  names the default branch and its head in one answer. It makes at most three
  short attempts for a transient read failure, then still stops with no verdict
  if origin remains unreadable. After a successful read it fetches that branch,
  re-reads the answer, and passes the resulting oid through both transport hops
  as `--master`. `mirror-push.sh` pushes the candidate and baseline atomically
  into separate oid-named cache refs and reads both refs back exactly before the
  harness can run. `run-gate.sh` verifies both objects and hands the stated
  baseline to `merge-gate.sh`.
- A direct `remote-gate.sh` invocation does not transport objects. Its candidate
  and baseline must already have been pushed explicitly; routine callers use
  `gate-dispatch.sh`, which couples the exact transport and gate invocation.
- The gate is run **from inside the checked-out commit**, so the gate that
  judges a commit is the gate that commit ships. A PR that weakens
  `merge-gate.sh` is gated by its own weakened gate — which is true of the
  local gate too, and is why changes to `scripts/merge-gate.sh` get read, not
  just gated.

## First deployment

Each worker needs an SSH-reachable Ubuntu account that can `sudo`, plus a
`Host` entry in `~/.ssh/config` on the local machine. The repository provides no
default destination. Configure `AGENTOS_GATE_SERVER` for one worker, configure
`AGENTOS_GATE_PRIMARY_SERVER` and optionally
`AGENTOS_GATE_FALLBACK_SERVER` for a two-host topology, or pass
`--server <alias>` for one invocation. In two-host mode, a healthy primary
whose slots are all busy gets a six-minute fallback grace period by default;
set `GATE_DISPATCH_FALLBACK_AFTER_MINUTES` to a non-negative integer to change
it, or to `0` for the immediate fallback behavior. An unavailable primary is
not counted as busy, so its fallback remains immediate.

Agent sessions receive an operator-selected gate topology when their runner
daemon is configured with `RUNNER_GATE_SERVER=<ssh-alias>`. The runner validates
that destination. Without a fallback, it exposes it to the session as
`AGENTOS_GATE_SERVER`, which puts `gate-dispatch.sh` into its existing
single-server mode with one remote slot. When
`RUNNER_GATE_FALLBACK_SERVER=<ssh-alias>` is also configured, the fallback must
be a different destination; the runner exposes the pair as
`AGENTOS_GATE_PRIMARY_SERVER` and `AGENTOS_GATE_FALLBACK_SERVER` and does not
set `AGENTOS_GATE_SERVER`. This gives the primary two remote slots
(`remote-1`, `remote-1-2`) and the fallback one (`remote-2`), tried in that
order before polling. To contribute local capacity, also set
`RUNNER_GATE_LOCAL_SLOTS=<positive integer, at most 1024>` on the runner. The
runner then enables local dispatch and passes the count as
`AGENTOS_GATE_LOCAL_SLOTS`; local slots are tried before the configured remote
topology. Task secrets cannot override any runner-owned gate variable. If
`RUNNER_GATE_LOCAL_SLOTS` is unset, the session gets no local capacity. An unset
`RUNNER_GATE_SERVER`
provides no remote capacity to a canonical regression step, but a configured
local count can still provide an explicit local-only path.

For a host running multiple runners, the first deployment should prefer a
remote worker configured with `RUNNER_GATE_SERVER` over local capacity. This
keeps the gate workload on the explicitly provisioned worker and avoids
mistaking per-account local capacity for a host-wide limit when runner accounts
are split across the host.

```
Host primary-worker
  HostName <ip>
  User <user>
  Port <port>
  IdentityFile ~/.ssh/<key>

Host fallback-worker
  HostName <ip>
  User <user>
  Port <port>
  IdentityFile ~/.ssh/<key>
```

**1. Provision (server).** Dry run first; it changes nothing and prints the
plan.

```sh
scp scripts/gate-worker/provision.sh primary-worker:/tmp/
ssh primary-worker 'bash /tmp/provision.sh'
ssh primary-worker 'bash /tmp/provision.sh --apply'
```

It pins Node to the version in `.nvmrc` (`v22.17.0`; a repository test keeps the
standalone script's repeated default synchronized), installs Docker with
registry mirrors, the native Node build dependencies, `jq` (the gate's tests
invoke it directly, and `run-gate.sh` refuses to return a verdict without it),
and a Git fixture identity when the account has none; it points npm at
`registry.npmmirror.com`, pre-pulls `postgres:16-alpine`, and creates `~/gate/`.
On a VMware guest it also disables VMware's time synchronization and enables
Ubuntu NTP. Two independent time disciplines caused the guest wall clock to
step backwards under sustained load; database ordering and ready-time tests
then failed even with only one gate running.

If it adds the account to the `docker` group, **log out and back in and re-run
it** — group membership does not apply to the session that granted it, and the
re-run is what confirms `docker info` works.

It does **not** check or install any egress rule: the worker is not
network-isolated by design (see the operating boundaries), so there is no
firewall step between provisioning and the first gate.

An absent `~/gate/worker-capacity` means one whole-GATE slot. Capacity two is a
deliberate host acceptance, not an automatic core-count rule. Temporarily set
the file to the exact value `2` for step 5 and retain it only if that acceptance
passes. `run-gate.sh` refuses every other value and never creates a third slot.
Removing the file returns the worker to one slot.

`~/gate/host-share` is the other half of that decision and a different question:
capacity is how many gates run at once, share is how much of the machine each
one sizes itself for. An absent file means the worker's capacity, which is what
`run-gate.sh` used before the file existed, so an existing worker's sizing is
unchanged and a capacity raised later still halves the machine by itself.
`provision.sh` writes the file only on a worker that has already stated a
capacity, and never overwrites one; on a fresh box it deliberately leaves the
file absent rather than freezing a share the operator has not chosen.
**A worker that shares its host with runners must set it to at least `2`**:
`gate-self` runs one gate at a time beside sixteen runners, and at capacity one
an unstated share handed that gate the whole machine.

The share must be **at least the capacity**, because that is the arithmetic of
`N` concurrent gates adding up to one host: `run-gate.sh` refuses a share below
the capacity with `GATE NOT RUN` rather than over-subscribing the box, so
`worker-capacity=2` with `host-share=1` never runs. Above that floor any whole
number is accepted — raise the share when the box is shared, not when a single
gate feels slow.

**2. Push the exact gate inputs (local).** The first push creates
`~/gate/<repo>/mirror.git` and installs `run-gate.sh` beside it.

```sh
AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" packages/runner/runtime-tools/gate-worker/mirror-push.sh primary-worker --candidate <candidate-oid> --baseline <baseline-oid> --dry-run
AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" packages/runner/runtime-tools/gate-worker/mirror-push.sh primary-worker --candidate <candidate-oid> --baseline <baseline-oid>
```

Both oids must resolve in the local object database. Routine use does not ask an
operator to prepare that state: `gate-dispatch.sh` refreshes and freezes the
origin baseline before it calls `mirror-push.sh`.

**3. Gate a commit (local).**

```sh
AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" \
AGENTOS_GATE_PRIMARY_SERVER=primary-worker \
  AGENTOS_GATE_FALLBACK_SERVER=fallback-worker \
  packages/runner/runtime-tools/gate-worker/gate-dispatch.sh <oid>                          # primary, then fallback
AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" packages/runner/runtime-tools/gate-worker/gate-dispatch.sh <oid> --server primary-worker    # one worker
AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" packages/runner/runtime-tools/gate-worker/gate-dispatch.sh <oid> --allow-local              # local only with no remote configured
AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" packages/runner/runtime-tools/gate-worker/remote-gate.sh primary-worker <oid>                # one worker directly
AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" packages/runner/runtime-tools/gate-worker/remote-gate.sh primary-worker <oid> --verbose      # stream it
AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" packages/runner/runtime-tools/gate-worker/remote-gate.sh primary-worker <oid> --fetch-log    # copy the log back
AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" packages/runner/runtime-tools/gate-worker/remote-gate.sh primary-worker <oid> --master <oid> # state the baseline
```

`--master` is only needed when origin cannot be read (no network, expired
credential) or when the baseline is deliberately not origin's current head;
otherwise `remote-gate.sh` asks origin itself.

Exit codes are the table under "Exit codes" above. The short version: `1` is
the only code that means the commit was judged and did not pass; `75`, `76` and
`255` all mean no gate ran.

**4. Acceptance: the double-run.** Gate the *same* commit locally and remotely
and compare the two verdict lines.

```sh
git rev-parse HEAD                                       # <oid>
bash scripts/merge-gate.sh --expect-head <oid>           # local
AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" packages/runner/runtime-tools/gate-worker/remote-gate.sh primary-worker <oid>    # remote
```

Both must end in `MERGE GATE: PASS <oid>` naming the same oid. Record both
lines in the PR.

**5. Capacity-two acceptance.** This is required only for a host proposed for
two slots. Use one fixed full-profile commit and a warm build cache. Record
three single runs, then five rounds with two `remote-gate.sh` processes started
together. Set `~/gate/host-share` to at least `2` for the acceptance and keep it
there while the capacity is two — a share below the capacity is refused, and a
share equal to it is what makes two overlapping gates add up to one host. Sample host CPU, memory availability and memory pressure during each
round. Keep `worker-capacity=2` only when all ten overlapping gates pass, none
times out or leaks a database/worktree, there is no OOM or sustained memory
pressure, and the median two-gate batch finishes at least 15 percent sooner
than running two median single gates serially. Otherwise remove the capacity
file; one slot remains the supported result rather than a degraded fallback.

The 12-vCPU, 20-GiB desktop VM passed this acceptance on 2026-08-24 at commit
`7886fad3ee03380672832166337c804726b5aec9`, after VMware time synchronization
was disabled and Ubuntu NTP was the sole time discipline. Three warm single
runs took 241, 240 and 240 seconds (median 240). Five two-gate batches took
270, 270, 270, 271 and 270 seconds (median 270); all ten overlapping gates
passed. The median batch was 43.8 percent faster than two median single gates
run serially. Peak CPU reached 100 percent, peak used memory was 5.50 GiB, at
least 13.37 GiB remained available, and there was no OOM, sustained memory
pressure, leaked container, database, worktree or held slot. The retained
desktop setting is therefore `worker-capacity=2`; the four-vCPU fallback stays
at its default capacity of one.

## Routine use

```sh
AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" AGENTOS_GATE_SERVER=primary-worker packages/runner/runtime-tools/gate-worker/gate-dispatch.sh <oid>
```

That is the whole routine: the dispatcher refreshes the baseline, tries an
eligible local slot when local dispatch is enabled, and pushes the two exact
gate inputs only before a remote run. The call is synchronous and holds the
terminal for the whole gate.
There is no queue file and no daemon by design: the state a queue would need is
exactly the state that makes a worker something to operate rather than
something to use, and the callers — agent sessions blocking on their own
merges — are the backpressure. When all usable local and remote slots are
occupied, every later caller waits and re-polls; requests are not pinned to a
machine and strict FIFO order is not promised. The first waiter to acquire
whichever usable local or remote slot frees runs there.

The database step runs one file per lane, each with a database of its own and
its own subdirectory of the roots the gate exports. The lane count is not read
from the CPU count here: `run-gate.sh` exports only `AGENTOS_GATE_HOST_SHARE`,
the worker's `host-share` setting, and `merge-gate.sh` derives every parallel
width in the run from `availableParallelism() / AGENTOS_GATE_HOST_SHARE`. That
setting defaults to the worker's capacity, so on the 14-vCPU desktop worker a
capacity-two gate gets 7 unit and 7 database lanes and two of them add up to the
host, while a hand-run gate with no stated share defaults to half the host. A
worker whose host also runs runners states a larger share than its capacity and
gets correspondingly fewer lanes. Deriving every width from the one number is
what keeps that invariant true; do not fix a width independently of the share.
`AGENTOS_DBTEST_CONCURRENCY` lowers the file concurrency on other paths and
`AGENTOS_DBTEST_PROVISION=0` puts the step back on one shared schema, serial.

## Troubleshooting

**`commit <oid> is not in the mirror`** — the mirror is behind. Run
`AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" packages/runner/runtime-tools/gate-worker/mirror-push.sh <server> --candidate <oid> --baseline <baseline-oid>` and retry
(the dispatcher does this itself). The worker has no way to fetch what it was
not given.

**`no mirror at ...`** — that repository has never been pushed from this
machine. `mirror-push.sh` creates it.

**`another merge gate is running in ... (pid N)`** — the per-worktree lock.
Each remote run gets a unique worktree, so this can only mean a previous run in
*this* directory was killed rather than exited. `run-gate.sh` sweeps worktrees
older than `STALE_WORKTREE_MINUTES` (default 180) at the start of every run and
prunes the mirror's registrations, so the reclaim is automatic. Age alone does
not decide: a worktree whose creating pid is still alive is left where it is
however old it is, because a gate waiting on a hung registry or a stalled pull
is slow, not abandoned, and deleting its tree would turn one box's
infrastructure problem into somebody else's FAIL. Intervene only if you need the
disk back sooner:

```sh
ssh fallback-worker 'ls -la ~/gate/<repo>/worktrees'
ssh fallback-worker 'rm -rf ~/gate/<repo>/worktrees/gate-<oid>-<stamp>-<pid> && git -C ~/gate/<repo>/mirror.git worktree prune'
```

**A PostgreSQL container is still running long after its gate ended** — that is
the case `run-gate.sh` reaps at the start of every run, and it should not need
you. `merge-gate.sh` labels each container with the pid of the gate that started
it and the worktree that gate ran in, and its EXIT trap deletes it; an OOM kill,
a SIGKILL or a power cut skips the trap, and `--rm` only deletes a container
that stops. The next run on that worker removes such a container when **both**
the pid is gone and the worktree is gone, and logs the removal with both. It
leaves alone — and says so — a container whose gate is still running, one whose
worktree is still on disk, and one carrying no gate labels at all, because
deleting the database out from under a running gate is the one failure this must
never have. An unlabelled container is therefore yours to remove by hand.

The reaper runs on gate workers only, after the worktree sweep in the same run,
so a container whose gate the kernel killed is removed by the run that reclaims
its worktree. A gate that ran in the dispatcher's **local slot** is never
reaped: it runs in the persistent checkout rather than a throwaway worktree, so
the worktree the label names never disappears and the reaper — which only ever
runs on a worker — never sees it. On the dispatching machine, remove such a
container by hand with the same two commands, without the `ssh`:

```sh
docker ps --filter name=agentos-merge-gate- --format "{{.Names}}\t{{.RunningFor}}"
docker rm -f <name>
```

**`GATE DISPATCH: NO SLOT` keeps recurring** — the configured slots are
systemically full. Read the stderr line above it: `no slot freed up or changed
hands` means no gate finished in a whole timeout, a stalled queue rather than a
deep one, so check the workers for a gate that is not progressing; `no slot came
free for this dispatch` means the queue was moving the whole time and never had
room for this one, which is capacity. If the gates are moving and this
still recurs, it is a capacity signal, not an error to retry harder: either
stagger the merges, or repeat the same-commit overlap acceptance before changing
host capacity.

**`GATE NOT RUN: no configured worker produced a verdict`** with a stderr line
naming `broken:` slots or `the locks of <slots> are unusable` — the named slots
have a lock this dispatcher cannot operate, so nothing was gated and nothing
will be until they are cleared. Look in the slot directory named by the dispatcher's
startup line (see the accounting-unit paragraph above): a `<slot>.lock`
*directory* is a leftover from the pre-#132 dispatcher and can go once no old
`gate-dispatch.sh` is running; a `<slot>.slot` file that does not contain a pid
was not written by this script and is cleared by hand, again only once no gate
is running; and a message about not being able to write a lock means the slot
directory itself is read-only or full. Re-dispatch after clearing.

**`docker: permission denied` / `the docker daemon on this host is not
reachable`** — the account is not in the `docker` group yet, or its session
predates the change. Log out, log back in, re-run `provision.sh`. The gate
reports this as `GATE NOT RUN:` and `76`, never as a FAIL: the daemon says
nothing about the commit, so the dispatcher takes the same commit to its next
worker rather than publishing a verdict no step formed.

**A pull or an `npm ci` hangs** — a registry mirror has stopped serving. Check
`/etc/docker/daemon.json` (`registry-mirrors`) and `~/.npmrc` (`registry`). The
direct sources are not reliably reachable from this network, so an unmirrored
install does not run slowly, it hangs.

This is not hypothetical and it does not announce itself. The first deployment
inherited two mirrors from the box's previous tenant that completed a TLS
handshake, answered `/v2/` with the normal `401`, and then served no layers at
all: `docker pull` sat for fifteen minutes with an empty `overlay2` and never
errored. Two lessons are now built in — `provision.sh` gives the pre-pull a
`PULL_TIMEOUT` (default 300s) so a dead mirror fails instead of hanging, and a
mirror's presence in `daemon.json` is never treated as evidence it works; only
a completed pull is.

To find a mirror that actually serves, pull through a fully-qualified one,
which bypasses the daemon's mirror list entirely:

```sh
ssh fallback-worker 'timeout 150 docker pull dockerproxy.net/library/postgres:16-alpine'
```

Then either point `daemon.json` at the one that worked and restart docker, or
retag what you pulled under the canonical name the gate asks for:

```sh
ssh fallback-worker 'docker tag dockerproxy.net/library/postgres:16-alpine postgres:16-alpine'
```

`docker info | grep -A3 "Registry Mirrors"` confirms what the daemon is
actually using, which is not always what the file says if it was edited without
a restart.

**Remote FAIL, local PASS, same commit** — do not merge on the strength of the
local PASS alone. Fetch the remote log (`--fetch-log`) and read the failing
step first; the interesting cases are real (a platform-dependent test, a Node
minor difference, a timing-sensitive dbtest), and a divergence here is exactly
what a second machine is for.

**Timing assertions fail intermittently on a VMware guest** — check both time
disciplines before changing tests. `vmware-toolbox-cmd timesync status` must say
`Disabled`, while `timedatectl show -p NTP -p NTPSynchronized` must report both
as `yes`. Re-run `provision.sh --apply` to converge that state. Do not leave
VMware periodic synchronization and Ubuntu NTP enabled together.

**Reading logs.** They stay on the worker at
`~/gate/<repo>/logs/<stamp>-<oid>-<pid>.log`, one per run, and are never pruned
automatically — a log is small and the reason a verdict happened is worth
keeping. Trim them by hand when the disk asks:

```sh
ssh fallback-worker 'ls -lt ~/gate/<repo>/logs | head'
ssh fallback-worker 'find ~/gate/*/logs -name "*.log" -mtime +30 -delete'
```

## Changing the pinned Node version

The source of truth is `.nvmrc`; `provision.sh` repeats it because that
standalone script reaches a new worker before any repository checkout does. A
test requires the two values to match. Bump both in one change, re-run
`provision.sh --apply`, and re-do the double-run from step 4. An explicit
`GATE_NODE_VERSION` override is a comparison run whose different interpreter
must be reported with its verdict.

## Undoing it

The local machine carries only the slot lock files in the directory named by the
dispatcher's startup line; they are inert when nothing runs. To return a
capacity-two worker to one slot, remove `~/gate/worker-capacity` after its gates
finish; `~/gate/host-share` is independent of it and keeps whatever share the
operator stated. To retire one repository from the worker, delete `~/gate/<repo>` on it;
to decommission the worker, delete `~/gate`.
Gating locally is, and remains, `bash scripts/merge-gate.sh`.
