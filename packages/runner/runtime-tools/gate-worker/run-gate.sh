#!/usr/bin/env bash
#
# Run one merge gate against one commit. Runs ON THE SERVER, invoked over SSH by
# packages/runner/runtime-tools/gate-worker/remote-gate.sh. It lives in one repository's directory on
# the worker — ~/gate/<repo>/ — next to that repository's mirror, worktrees and
# logs, and operates on those and nothing else:
#
#   cd ~/gate/<repo> && ./run-gate.sh <oid>
#   cd ~/gate/<repo> && ./run-gate.sh <oid> --master <master-oid>
#   cd ~/gate/<repo> && ./run-gate.sh <oid> --master <master-oid> --verbose
#
# --master carries the authoritative master oid, which the frozen-record rules
# are evaluated against. remote-gate.sh reads it from origin on the local
# machine and passes it here, because this box's mirror has no remote to fetch
# through. When it is given, it
# is verified to be resolvable in the mirror before the gate starts.
#
# The supported remote path always supplies it: gate-dispatch.sh freezes the
# baseline, mirror-push.sh transports that exact object, and remote-gate.sh
# passes the oid here. The parser remains usable for a direct diagnostic
# invocation without it, but that path has only merge-gate.sh's ordinary local
# no-origin rules and is not the dispatch contract.
#
# This file is installed by mirror-push.sh from the local repository, not by
# provision.sh. That is deliberate: the harness that decides what a verdict means
# should be the copy the operator holds, not one that lives only on the worker
# and could have been edited there.
#
# Shape: check the requested oid out of the mirror into a private throwaway
# worktree, run scripts/merge-gate.sh --expect-head <oid> inside it, keep the full
# log on this host, and print the verdict on stdout. Everything else — progress,
# npm noise, docker noise — goes to the log. A FAIL also forwards a bounded tail
# for each failing step so the local dispatcher can record useful test evidence
# from every failure; anyone debugging can still scp the full log.
#
# Exit codes are merge-gate.sh's, passed through unchanged, plus one this
# harness adds for everything that stops it before merge-gate.sh forms a verdict.
# They are defined once, in lib.sh, which is installed beside this script:
#
#   0  PASS               2  usage error (this script or merge-gate.sh)
#   1  FAIL               3  NOT AUTHORITATIVE
#   76 nothing ran — no mirror, the commit is not in the mirror or a missing
#      tool. The line on stdout is
#      GATE NOT RUN: <reason>, and it is not a FAIL. Only merge-gate.sh's own
#      judgement about the commit exits 1, so a caller reading exit codes can
#      tell a verdict from an errand.
#
# The worktree is per-run and unique. The worker contributes one execution slot
# by default, or two when its worker-capacity file contains 2. Each slot is a
# worker-wide flock held by the real process for its entire run, so repositories
# share the same fixed capacity and a dropped ssh connection cannot release a
# slot while its remote gate process survives. Waiting for one of those slots is
# bounded: after SLOT_WAIT_MINUTES this exits 76 rather than holding the caller's
# ssh session open for as long as the queue stays full.
#
# How much of the host one gate sizes itself for is the worker's own host-share
# file, next to worker-capacity, and defaults to the capacity. They are different
# questions: a worker that shares its machine with runners runs one gate at a
# time and still must not hand that gate the whole box.
#
# Every run reclaims what earlier gates abandoned: first their worktrees, then
# the PostgreSQL containers of gates that died without running their own
# cleanup, and only those it can prove are dead.
#
# Stateless: nothing is remembered between runs except the mirror and the logs.
# Re-running the same oid after a dropped connection is the supported recovery,
# not a special case.
set -uo pipefail

# The verdict's exit codes and the reader that recovers one from a log. lib.sh
# is installed beside this script by mirror-push.sh, from the operator's
# checkout, for the same reason this script is: the harness that decides what a
# verdict means must be the copy the operator holds. It is sourced from this
# script's own directory rather than from $GATE_HOME, which an environment may
# point elsewhere.
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=packages/runner/runtime-tools/gate-worker/lib.sh
. "${HARNESS_DIR}/lib.sh"

# 2 is this script's own argument parsing, not the gate's, so it stays here.
EXIT_USAGE=2

# The directory this script was installed into by mirror-push.sh, which is the
# repository's own directory on the worker. Deriving it from the script's path
# rather than a fixed ~/gate is what lets several repositories share one worker
# without any of them naming the others.
GATE_HOME="${GATE_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)}"
MIRROR_DIR="$GATE_HOME/mirror.git"
WORKTREES_DIR="$GATE_HOME/worktrees"
LOGS_DIR="$GATE_HOME/logs"
# How long an abandoned worktree is left alone before the sweep reclaims it.
# Comfortably longer than a gate takes, short enough that a killed run does not
# hold its disk for a day. Age alone never decides: the sweep also refuses to
# touch a worktree whose creating process is still alive, which is what keeps a
# gate that is merely slow — a hung registry, a stalled pull — from having its
# tree deleted underneath it by the next run.
STALE_WORKTREE_MINUTES="${STALE_WORKTREE_MINUTES:-180}"
case "$STALE_WORKTREE_MINUTES" in
  ''|*[!0-9]*) printf 'run-gate: STALE_WORKTREE_MINUTES must be a whole number of minutes, got: %s\n' \
                 "$STALE_WORKTREE_MINUTES" >&2; exit 2 ;;
esac

# How long this run waits for a worker execution slot before giving up. An
# unbounded wait is what a configuration drift turns into a hang: the dispatcher
# counts two slots on a worker whose worker-capacity file says one, hands this
# script the extra dispatch, and the caller's ssh session then sits in the slot
# loop for as long as the queue stays full — gate-dispatch.sh's own
# --timeout-minutes cannot interrupt an attempt that has already reached the
# worker. Twenty minutes is comfortably longer than a full gate on any
# configured worker, and giving up as "nothing ran" is what lets the dispatcher
# take the same commit to its fallback worker instead.
SLOT_WAIT_MINUTES="${SLOT_WAIT_MINUTES:-20}"
case "$SLOT_WAIT_MINUTES" in
  ''|*[!0-9]*) printf 'run-gate: SLOT_WAIT_MINUTES must be a whole number of minutes, got: %s\n' \
                 "$SLOT_WAIT_MINUTES" >&2; exit 2 ;;
esac
# Decimal padding is not a different number, and bash arithmetic disagrees: it
# reads a leading zero as octal, so `08` would abort the deadline expression
# below with a fatal error — an exit 1 the dispatcher reads as a FAIL about the
# commit, from worker state alone. Stripping the padding here is what
# gate-dispatch.sh already does with its own minutes setting.
SLOT_WAIT_MINUTES="$(printf '%s\n' "$SLOT_WAIT_MINUTES" | sed 's/^0*//')"
SLOT_WAIT_MINUTES="${SLOT_WAIT_MINUTES:-0}"

VERBOSE=0
OID=""
MASTER_OID=""

die_usage() {
  printf 'run-gate: %s\n' "$1" >&2
  printf 'usage: run-gate.sh <40-hex-oid> [--master <40-hex-oid>] [--verbose]\n' >&2
  exit "$EXIT_USAGE"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --verbose|-v) VERBOSE=1 ;;
    --master)
      [ $# -ge 2 ] || die_usage "--master needs an object id"
      MASTER_OID="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"; shift ;;
    --master=*) MASTER_OID="$(printf '%s' "${1#--master=}" | tr '[:upper:]' '[:lower:]')" ;;
    -h|--help) sed -n '2,67p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    -*) die_usage "unknown argument $1" ;;
    *)
      [ -z "$OID" ] || die_usage "more than one commit given: $OID and $1"
      OID="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
      ;;
  esac
  shift
done

# A full 40-character object id and nothing else. An abbreviation or a branch name
# would let the meaning of a verdict drift between the moment the caller asked and
# the moment the gate resolved it, and merge-gate.sh --expect-head refuses anything
# shorter anyway. Validating here also means the value is never a shell surprise.
[ -n "$OID" ] || die_usage "no commit given"
case "$OID" in
  *[!0-9a-f]* | "") die_usage "not a full object id: $OID" ;;
esac
[ "${#OID}" -eq 40 ] || die_usage "not a full 40-character object id: $OID"

# Same rules for the master oid when one is given: a branch name or an
# abbreviation would put the meaning of the verdict back in the hands of
# whatever this box happens to have.
if [ -n "$MASTER_OID" ]; then
  case "$MASTER_OID" in
    *[!0-9a-f]*) die_usage "not a full object id: $MASTER_OID" ;;
  esac
  [ "${#MASTER_OID}" -eq 40 ] || die_usage "not a full 40-character object id: $MASTER_OID"
fi

# --- preconditions ----------------------------------------------------------

# A verdict about the commit. Reserved for the one precondition that is a
# property of the commit rather than of this box.
fail_out() {
  printf 'run-gate: %s\n' "$1" >&2
  printf 'MERGE GATE: FAIL (%s)\n' "$1"
  exit "$GATE_EXIT_FAIL"
}

# Everything that stops the harness before merge-gate.sh runs. The state of this
# box, of its mirror and of its toolchain says nothing about the commit, so it
# must not be reported in the same words or the same code as a judgement.
no_verdict() {
  printf 'run-gate: %s\n' "$1" >&2
  printf 'GATE NOT RUN: %s\n' "$1"
  exit "$GATE_EXIT_NO_VERDICT"
}

[ -d "$MIRROR_DIR" ] || no_verdict "no mirror at ${MIRROR_DIR}; run packages/runner/runtime-tools/gate-worker/mirror-push.sh from the local machine first"
command -v git >/dev/null 2>&1 || no_verdict "git is not installed on the worker"
command -v node >/dev/null 2>&1 || no_verdict "node is not installed on the worker"
command -v flock >/dev/null 2>&1 || no_verdict "flock is not installed on the worker"
command -v jq >/dev/null 2>&1 || no_verdict "jq is not installed on the worker"
# Docker is deliberately not pre-checked here. merge-gate.sh requires it too, and
# does so after the frozen-record rules, which need neither a daemon nor an
# install: a documentation branch that rewrites history should be told that,
# not told about a daemon it never needed. One ordering, defined in one place.

# The commit has to already be in the mirror. The worker never fetches because
# its mirror has no remote, so "unknown commit" always
# means the local machine has not pushed it yet, and saying so precisely is the
# difference between a one-command fix and a debugging session.
if ! git -C "$MIRROR_DIR" cat-file -e "${OID}^{commit}" 2>/dev/null; then
  no_verdict "commit ${OID} is not in the mirror; run packages/runner/runtime-tools/gate-worker/mirror-push.sh from the local machine"
fi

# The same is true of the master the caller bound the verdict to: an oid this
# mirror cannot resolve would make the gate's own baseline unresolvable, and the
# honest answer is that the mirror is behind the machine that asked.
if [ -n "$MASTER_OID" ] && ! git -C "$MIRROR_DIR" cat-file -e "${MASTER_OID}^{commit}" 2>/dev/null; then
  no_verdict "master ${MASTER_OID} is not in the mirror; run packages/runner/runtime-tools/gate-worker/mirror-push.sh from the local machine"
fi

mkdir -p "$WORKTREES_DIR" "$LOGS_DIR" || no_verdict "could not create the gate directories under ${GATE_HOME}"

# The repository directory is one level below the worker root installed by
# mirror-push.sh.
WORKER_ROOT="$(dirname "$GATE_HOME")"

# Both worker settings are one file apiece beside the mirror, and both are read
# the same way: absent means the stated default, a symlink or an unreadable file
# is worker state this script must not guess at, and what the file says is
# checked by the caller because the two settings accept different values. Said
# once, because a second copy of this shape is how the two validations came to
# disagree. WORKER_SETTING carries the value out: no_verdict inside a command
# substitution would exit the subshell and leave this run going.
WORKER_SETTING=""
read_worker_setting() {
  local path="$1" label="$2"
  WORKER_SETTING="$3"
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -f "$path" ] && [ ! -L "$path" ] || no_verdict "${label} at ${path} is not a regular file"
    WORKER_SETTING="$(cat "$path" 2>/dev/null)" || no_verdict "could not read ${label} at ${path}"
  fi
}

# Capacity is host state, not repository state: an absent file means one slot,
# while the only larger supported value is the measured desktop capacity of two.
# There is no load-sensitive resizing and no third slot.
WORKER_CAPACITY_FILE="${WORKER_ROOT}/worker-capacity"
read_worker_setting "$WORKER_CAPACITY_FILE" "worker capacity" 1
WORKER_CAPACITY="$WORKER_SETTING"
case "$WORKER_CAPACITY" in
  1|2) ;;
  *) no_verdict "worker capacity at ${WORKER_CAPACITY_FILE} must be exactly 1 or 2" ;;
esac

# How much of this host one gate may size itself for. It is worker state like
# the capacity beside it and a different question from it: capacity is how many
# gates may run at once, share is how much of the machine each of them takes.
# On a worker that is also this host's runner box the two differ — one gate at a
# time, and not the whole box — which is exactly the case that made the share a
# setting instead of a restatement of the capacity. An absent file means the
# capacity, which is the value this script passed before the file existed, so an
# installed worker's sizing is unchanged until an operator states otherwise.
WORKER_HOST_SHARE_FILE="${WORKER_ROOT}/host-share"
read_worker_setting "$WORKER_HOST_SHARE_FILE" "host share" "$WORKER_CAPACITY"
WORKER_HOST_SHARE="$WORKER_SETTING"
case "$WORKER_HOST_SHARE" in
  ''|*[!0-9]*) no_verdict "host share at ${WORKER_HOST_SHARE_FILE} must be a whole number of shares, at least 1" ;;
esac
# `00` is a zero however it is spelled, and `007` is seven. Stripping decimal
# padding before the comparison is what makes the refusal below mean what its
# message says: the bare `0` pattern this replaces let every padded zero
# through, to be divided by inside merge-gate.sh and die there as a FAIL.
WORKER_HOST_SHARE="$(printf '%s\n' "$WORKER_HOST_SHARE" | sed 's/^0*//')"
[ -n "$WORKER_HOST_SHARE" ] \
  || no_verdict "host share at ${WORKER_HOST_SHARE_FILE} must be a whole number of shares, at least 1"

# The invariant the share exists to keep: this worker runs WORKER_CAPACITY gates
# at once and each of them sizes itself for 1/WORKER_HOST_SHARE of the machine,
# so a share below the capacity is a configuration under which the concurrent
# gates add up to more than one host. That combination is not a smaller machine,
# it is an over-subscribed one — the memory ceiling the sizing exists to respect
# — so it is refused here rather than sized around.
[ "$WORKER_HOST_SHARE" -ge "$WORKER_CAPACITY" ] \
  || no_verdict "host share ${WORKER_HOST_SHARE} at ${WORKER_HOST_SHARE_FILE} is below the worker capacity ${WORKER_CAPACITY}; ${WORKER_CAPACITY} concurrent gates would each size for 1/${WORKER_HOST_SHARE} of this host"

# A gate runs many phases in parallel and every one of them has to fit inside
# the share of the host this worker states. State the share once; the gate
# sizes each phase from it. Naming a single phase's fan-out here instead is what
# 7886fad did, and merge-gate.sh recomputed that exact variable a moment later,
# so the bound never took effect: a two-slot worker ran eight database files at
# once while this script's own line claimed two.
export AGENTOS_GATE_HOST_SHARE="$WORKER_HOST_SHARE"

# Both numbers, out loud, on the stream remote-gate.sh carries back to the
# machine that dispatched this run. The dispatcher counts this worker's slots
# from its own configuration and has no other way to see that the two disagree;
# the way that disagreement used to show up was an ssh session that never
# returned.
printf 'run-gate: worker capacity %s, host share %s\n' "$WORKER_CAPACITY" "$WORKER_HOST_SHARE" >&2

# --- reclaim the databases of gates that died -------------------------------

# merge-gate.sh starts one detached PostgreSQL container per run, with a tmpfs
# data directory of up to 3 GiB, and deletes it in the EXIT trap the gate's own
# verdict.sh installs. A trap does not run when the kernel kills the
# process: an OOM kill, a SIGKILL or a power cut leaves the container running,
# and `--rm` deletes a container that stops rather than stopping one. Nothing
# else removed them, so they accumulated — two had been up for a fortnight when
# they were removed by hand on 2026-09-06.
#
# Ownership decides, never age. Every gate labels its container with its own pid
# and the worktree it ran in, and a container is removed only when that pid is
# not alive AND that worktree is gone: a live pid is a gate that is merely slow,
# and a worktree still on disk is a run this box cannot prove has ended. A
# container this scheme cannot attribute — an older gate's, or one somebody
# started by hand — is left alone and said out loud, because the one failure
# this must never have is deleting the database out from under a running gate.
GATE_CONTAINER_PREFIX="agentos-merge-gate-"
reap_orphaned_gate_databases() {
  local names name labels pid worktree
  # Docker is deliberately not a precondition of this script; merge-gate.sh
  # owns that check and its ordering. A worker without it simply has no gate
  # containers to reap.
  command -v docker >/dev/null 2>&1 || return 0
  names="$(docker ps -a --filter "name=${GATE_CONTAINER_PREFIX}" --format '{{.Names}}' 2>/dev/null)" || {
    printf 'run-gate: could not list gate containers; leaving them alone\n' >&2
    return 0
  }
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    # The filter is docker's substring match; this is the actual rule. A name
    # this scheme did not produce is not this script's to remove.
    case "$name" in
      "${GATE_CONTAINER_PREFIX}"*) ;;
      *) continue ;;
    esac
    # `with` rather than `index` alone: a container with no labels at all has a
    # nil map, which `index` renders as the literal text `<no value>` and would
    # make an unattributable container look like it named a worktree.
    labels="$(docker inspect --format '{{with index .Config.Labels "agentos.merge-gate.pid"}}{{.}}{{end}}
{{with index .Config.Labels "agentos.merge-gate.worktree"}}{{.}}{{end}}' "$name" 2>/dev/null)" || labels=""
    pid="$(printf '%s\n' "$labels" | sed -n '1p')"
    worktree="$(printf '%s\n' "$labels" | sed -n '2p')"
    case "$pid" in
      ''|*[!0-9]*) pid="" ;;
    esac
    if [ -z "$pid" ] || [ -z "$worktree" ]; then
      printf 'run-gate: leaving container %s alone; it names no gate this script can check\n' "$name" >&2
      continue
    fi
    if kill -0 "$pid" 2>/dev/null; then
      printf 'run-gate: leaving container %s alone, its gate (pid %s) is still running\n' "$name" "$pid" >&2
      continue
    fi
    if [ -d "$worktree" ]; then
      printf 'run-gate: leaving container %s alone; its gate (pid %s) is gone but its worktree %s is not\n' \
        "$name" "$pid" "$worktree" >&2
      continue
    fi
    printf 'run-gate: removing orphaned container %s (dead pid %s, worktree %s is gone)\n' \
      "$name" "$pid" "$worktree" >&2
    docker rm -f "$name" >/dev/null 2>&1 \
      || printf 'run-gate: could not remove container %s\n' "$name" >&2
  done <<EOF
$names
EOF
}

# Slot one retains the original lock path, so a rollout beside an older
# run-gate.sh still counts the old process. Slot two has one additional lock
# file. Polling both non-blockingly is what lets whichever slot frees first run
# the waiter without a queue daemon or mutable scheduler state.
#
# The wait is bounded. A worker whose capacity is lower than the number of slots
# the dispatcher believes it has cannot free one, and an unbounded loop turned
# that drift into an ssh session that hung until somebody noticed. Giving up as
# "nothing ran" hands the dispatcher a code it already understands, so it takes
# the commit to its fallback worker.
WORKER_SLOT=""
SLOT_WAIT_DEADLINE=$(( $(date +%s) + SLOT_WAIT_MINUTES * 60 ))
printf 'run-gate: waiting for one of %s worker slot(s)\n' "$WORKER_CAPACITY" >&2
while [ -z "$WORKER_SLOT" ]; do
  for slot in $(seq 1 "$WORKER_CAPACITY"); do
    if [ "$slot" -eq 1 ]; then
      candidate_lock="${WORKER_ROOT}/.full-gate.lock"
    else
      candidate_lock="${WORKER_ROOT}/.full-gate-${slot}.lock"
    fi
    exec 9>"$candidate_lock" \
      || no_verdict "could not open worker slot ${slot} at ${candidate_lock}"
    if flock -n 9; then
      WORKER_SLOT="$slot"
      break
    fi
    exec 9>&-
  done
  if [ -z "$WORKER_SLOT" ]; then
    if [ "$(date +%s)" -ge "$SLOT_WAIT_DEADLINE" ]; then
      no_verdict "worker slot wait exceeded ${SLOT_WAIT_MINUTES} minutes"
    fi
    sleep 1
  fi
done
printf 'run-gate: acquired worker slot %s/%s\n' "$WORKER_SLOT" "$WORKER_CAPACITY" >&2

# --- reclaim what earlier runs abandoned ------------------------------------

# Only ever directories this script's own naming scheme created, under the
# worktrees root, older than the window above. A killed gate leaves a worktree, a
# registration in the mirror, and possibly a #131 lock inside it; all three go
# together, so removing the directory and pruning the registration is the whole
# reclaim. Failures here are noted and not fatal: a stale directory wastes disk,
# it does not make this run's verdict wrong.
#
# Age is necessary and not sufficient. The name a worktree was created with ends
# in the pid of the run that created it, and a pid that still answers `kill -0`
# is a gate that is still going — slowly, because the runbook's own worst case
# is a registry or a pull that hangs. Deleting that tree would not produce a
# false PASS, it would produce a false FAIL in a run that was doing nothing
# wrong, and it would do it to a *different* dispatch than the one asking. So a
# live pid keeps its worktree however old it is, and only a pid that is gone —
# or a name this scheme did not produce — is swept.
sweep_stale_worktrees() {
  local dir base pid
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    base="${dir##*/}"
    pid="${base##*-}"
    case "$pid" in
      ''|*[!0-9]*) pid="" ;;
    esac
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      printf 'run-gate: leaving %s alone, its gate (pid %s) is still running\n' "$dir" "$pid" >&2
      continue
    fi
    printf 'run-gate: reclaiming abandoned worktree %s\n' "$dir" >&2
    rm -rf -- "$dir" || printf 'run-gate: could not remove %s\n' "$dir" >&2
  done <<EOF
$(find "$WORKTREES_DIR" -mindepth 1 -maxdepth 1 -type d -name 'gate-*' -mmin "+${STALE_WORKTREE_MINUTES}" 2>/dev/null)
EOF
  git -C "$MIRROR_DIR" worktree prune 2>/dev/null || true
}
sweep_stale_worktrees

# After the sweep, not before it: the reaper removes a container only when its
# gate's worktree is gone, and the sweep above is what reclaims the worktree of
# a gate the kernel killed. Ordered the other way round, the run that finally
# deleted the tree could not delete the matching container, and a 3 GiB tmpfs
# waited for a further dispatch that an idle worker may never get.
reap_orphaned_gate_databases

# --- run --------------------------------------------------------------------

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKTREE="${WORKTREES_DIR}/gate-${OID}-${STAMP}-$$"
LOG="${LOGS_DIR}/${STAMP}-${OID}-$$.log"
WORKTREE_CREATED=0

# Only ever removes the directory this run created, matched against the name it
# was created with. A cleanup routine that trusts a variable is how a scratch run
# reaches a real tree — the same rule scripts/merge-gate.sh applies to its own
# temp directory.
cleanup() {
  local status=$?
  trap - EXIT
  if [ "$WORKTREE_CREATED" -eq 1 ]; then
    case "$WORKTREE" in
      "${WORKTREES_DIR}"/gate-*)
        rm -rf -- "$WORKTREE" 2>/dev/null || printf 'run-gate: could not remove %s\n' "$WORKTREE" >&2
        git -C "$MIRROR_DIR" worktree prune 2>/dev/null || true
        ;;
      *)
        printf 'run-gate: refusing to remove unexpected path %s\n' "$WORKTREE" >&2
        ;;
    esac
  fi
  exit "$status"
}
trap cleanup EXIT
# An interrupted run must clean up too, or its worktree sits until the sweep
# above reclaims it. Exiting from the handler is what routes the signal through
# the EXIT trap.
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'run-gate: %s\n' "$OID" > "$LOG" 2>/dev/null \
  || no_verdict "could not write the log at ${LOG}"
{
  printf 'run-gate: worker %s\n' "$(uname -srm)"
  printf 'run-gate: node %s, npm %s\n' "$(node -v 2>/dev/null)" "$(npm -v 2>/dev/null)"
  printf 'run-gate: started %s\n' "$STAMP"
  printf 'run-gate: capacity %s, this gate gets 1/%s of the host\n' \
    "$WORKER_CAPACITY" "$WORKER_HOST_SHARE"
  printf 'run-gate: worktree %s\n\n' "$WORKTREE"
} >> "$LOG"

# --detach: the gate is a statement about a commit, not about a branch, and a
# detached checkout is the only state where HEAD cannot be moved by a later push
# into the mirror while the gate is running.
if ! git -C "$MIRROR_DIR" worktree add --detach --quiet "$WORKTREE" "$OID" >> "$LOG" 2>&1; then
  printf 'run-gate: could not check %s out of the mirror; see %s\n' "$OID" "$LOG" >&2
  printf 'GATE NOT RUN: could not check out %s on the worker\n' "$OID"
  printf 'run-gate: log %s\n' "$LOG"
  exit "$GATE_EXIT_NO_VERDICT"
fi
WORKTREE_CREATED=1

[ -f "${WORKTREE}/scripts/merge-gate.sh" ] || {
  printf 'MERGE GATE: FAIL (commit %s has no scripts/merge-gate.sh)\n' "$OID"
  printf 'run-gate: log %s\n' "$LOG"
  exit "$GATE_EXIT_FAIL"
}

# The gate is run from inside the checked-out commit, so the gate that judges a
# commit is the gate that commit ships. --expect-head makes the checkout and the
# request prove each other: if the mirror handed back anything but the requested
# commit, the gate refuses instead of quietly judging the wrong tree.
GATE_ARGS=(--expect-head "$OID")
[ -n "$MASTER_OID" ] && GATE_ARGS+=(--master "$MASTER_OID")

if [ "$VERBOSE" -eq 1 ]; then
  ( cd "$WORKTREE" && bash scripts/merge-gate.sh "${GATE_ARGS[@]}" ) 2>&1 | tee -a "$LOG"
  status=${PIPESTATUS[0]}
else
  ( cd "$WORKTREE" && bash scripts/merge-gate.sh "${GATE_ARGS[@]}" ) >> "$LOG" 2>&1
  status=$?
fi

# The verdict merge-gate.sh printed, verbatim, rather than one reconstructed from
# the exit code: the caller should see the gate's own words, including the oid a
# PASS names and the reason a stopped run gives. gate_verdict_read knows all four
# shapes and strips the colour, because this line is read over ssh and often
# pasted into a PR.
verdict="$(gate_verdict_read "$LOG")"
if [ -z "$verdict" ]; then
  # merge-gate.sh ran and printed no verdict at all, which means it died rather
  # than decided — SIGKILL, out of memory, a crash the EXIT trap never survived.
  # That is not a FAIL: calling it one would put a judgement about the commit on
  # the record that nothing actually formed. The log is where the reason is.
  #
  # Only this branch may rewrite the status. A run that was stopped by a signal
  # it could trap printed its own GATE NOT RUN line and reaches the caller under
  # the signal that stopped it, which is what docs/runbooks/gate-worker.md
  # promises; folding that into 76 here discarded both the gate's reason and its
  # code.
  verdict="GATE NOT RUN: the gate produced no verdict line (exit ${status}); read the log"
  status="$GATE_EXIT_NO_VERDICT"
fi

forward_failure_excerpt() {
  node - "$1" "$2" <<'NODE'
const { createReadStream } = require("node:fs");
const { createInterface } = require("node:readline");

const [logPath, verdict] = process.argv.slice(2);
const MAX_LINES_PER_STAGE = 200;
const MAX_BYTES = 65536;
const prefix = "MERGE GATE: FAIL (";

const splitStages = (value) => {
  const stages = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")" && depth > 0) depth -= 1;
    else if (character === "," && depth === 0) {
      const stage = value.slice(start, index).trim();
      if (stage) stages.push(stage);
      start = index + 1;
    }
  }
  const finalStage = value.slice(start).trim();
  if (finalStage) stages.push(finalStage);
  return stages;
};

const summary = verdict.slice(prefix.length, -1);
const stages = splitStages(summary);
const gateStages = new Set(stages);
const rings = new Map(stages.map((stage) => [stage, []]));
const globalRing = [];
const stripAnsi = (line) => line.replace(/\u001b\[[0-9;]*m/gu, "");
const appendGlobal = (line) => {
  globalRing.push({ line, priority: 0 });
  if (globalRing.length > MAX_LINES_PER_STAGE) globalRing.shift();
};

// A failing assertion is more useful to an automatic repair than the passing
// output that happened to be printed after it. Keep the ordinary ring shape,
// but evict the oldest least-useful line when it reaches its cap. Context is
// promoted only when a nearby failure marker confirms that it belongs to the
// failure, so a noisy passing workspace cannot consume the evidence budget.
const appendStage = (ring, line) => {
  const entry = { line, priority: 0 };
  ring.push(entry);
  return entry;
};

const trimStage = (ring) => {
  if (ring.length <= MAX_LINES_PER_STAGE) return;

  let evict = 0;
  for (let index = 1; index < ring.length; index += 1) {
    if (ring[index].priority < ring[evict].priority) evict = index;
  }
  ring.splice(evict, 1);
};

const promote = (entry, priority) => {
  if (entry !== null && entry.priority < priority) entry.priority = priority;
};
const demote = (entry) => {
  if (entry !== null && entry.priority < 2) entry.priority = 0;
};

// Parallel member headings and the nested headings printed by those members
// use the same syntax. The step report at the end of a real gate log is the
// authority that distinguishes them, so learn its stage labels before
// attributing any output.
const readGateStages = async () => {
  const lines = createInterface({ input: createReadStream(logPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const rawLine of lines) {
    const line = stripAnsi(rawLine);
    const reportLabel = line.match(/^\s*(?:ok|FAIL|STOP)\s{2,}(.+?)\s*$/u)?.[1];
    if (reportLabel === undefined) continue;
    gateStages.add(reportLabel.replace(/\s+(?:\?|\d+)s$/u, "").trimEnd());
  }
};

const readLog = async () => {
  let currentStage = null;
  let pendingContexts = [];
  let failureOpen = false;
  let failureAge = 0;
  const resetFailureEvidence = () => {
    pendingContexts = [];
    failureOpen = false;
    failureAge = 0;
  };

  const lines = createInterface({ input: createReadStream(logPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const rawLine of lines) {
    const line = stripAnsi(rawLine);
    const parallelHeading = line.match(/^\s*---\s+(.+?)\s+---\s*$/u)?.[1];
    const serialHeading = line.match(/^\s*==\s+(.+?)\s*$/u)?.[1];
    if (serialHeading !== undefined) {
      currentStage = stages.includes(serialHeading) ? serialHeading : null;
      resetFailureEvidence();
      continue;
    }
    if (parallelHeading !== undefined) {
      // Only a gate step begins or ends stage attribution. Workspace, lint and
      // build replay headings remain inside their enclosing parallel step.
      if (gateStages.has(parallelHeading)) {
        currentStage = stages.includes(parallelHeading) ? parallelHeading : null;
      }
      resetFailureEvidence();
      continue;
    }
    if (/^\s*(?:MERGE GATE:|GATE NOT RUN:)/u.test(line)) continue;
    appendGlobal(line);
    const stageRing = currentStage === null ? null : rings.get(currentStage);
    const entry = stageRing === null ? null : appendStage(stageRing, line);

    const isSubtestContext = /^\s*#\s*Subtest\b/u.test(line);
    const isFileContext = /\b(?:test|spec|dbtest)\.[cm]?[jt]sx?(?::\d+(?::\d+)?)?\b/u.test(line);
    if (isSubtestContext || isFileContext) {
      // Keep a short pending queue, matching the dispatcher extractor's
      // context window. Pending entries are cheap to discard if a passing
      // result closes the block before a failure marker arrives.
      promote(entry, 1);
      pendingContexts.push(entry);
      if (pendingContexts.length > 12) demote(pendingContexts.shift());
    }

    const isNotOk = /\bnot ok\b/u.test(line);
    const isFailureMarker = /^\s*[✖×]\s+(?!failing tests?:)/u.test(line);
    const isAssertion = /\bAssertionError\b/u.test(line);
    const isError = /\bError:/u.test(line);
    if (isNotOk || isFailureMarker) {
      for (const context of pendingContexts) promote(context, 2);
      pendingContexts = [];
      promote(entry, 3);
      failureOpen = true;
      failureAge = 0;
    } else if (isAssertion || (failureOpen && isError)) {
      promote(entry, 3);
    }

    if (failureOpen) {
      failureAge += 1;
      if (failureAge > 32) failureOpen = false;
    }

    // A passing result closes a pending context; it cannot describe a later
    // failure in the same workspace's output.
    if (/^\s*(?:ok\b|[✔✓]\s+|#\s+(?:tests|pass|fail|duration)|1\.\.)/u.test(line)) {
      for (const context of pendingContexts) demote(context);
      pendingContexts = [];
    }
    if (stageRing !== null) trimStage(stageRing);
  }
};

const byteLength = (value) => Buffer.byteLength(value, "utf8");
const truncateTailUtf8 = (value, limit) => {
  const buffer = Buffer.from(value);
  if (buffer.length <= limit) return value;
  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
};
const truncateHeadUtf8 = (value, limit) => {
  const buffer = Buffer.from(value);
  if (buffer.length <= limit) return value;
  let end = limit;
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
};

const renderSection = (stage, sourceLines, budget) => {
  const heading = `--- ${stage} ---`;
  const selected = new Map();
  let bytes = byteLength(heading);
  const select = (index, truncate) => {
    if (selected.has(index)) return;
    const line = sourceLines[index].line;
    const remaining = budget - bytes - 1;
    if (remaining <= 0) return;
    if (byteLength(line) > remaining) {
      if (truncate !== null) {
        const shortened = truncate(line, remaining);
        selected.set(index, shortened);
        bytes += 1 + byteLength(shortened);
      }
      return;
    }
    selected.set(index, line);
    bytes += 1 + byteLength(line);
  };

  // Confirmed failure lines and their context spend the unchanged byte budget
  // first. Recent ordinary output fills whatever remains, and sorting the
  // selected indexes restores the original log order.
  for (const priority of [3, 2]) {
    for (let index = 0; index < sourceLines.length; index += 1) {
      if (sourceLines[index].priority === priority) select(index, truncateHeadUtf8);
    }
  }
  for (let index = sourceLines.length - 1; index >= 0; index -= 1) {
    select(index, selected.size === 0 ? truncateTailUtf8 : null);
  }
  const selectedLines = [...selected.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, line]) => line);
  return [heading, ...selectedLines].join("\n");
};

const main = async () => {
  await readGateStages();
  await readLog();
  const outputStages = stages.length > 0 ? stages : [summary.trim() || "gate"];
  if (stages.length === 0) rings.set(outputStages[0], globalRing);
  if (stages.length === 1 && rings.get(stages[0]).length === 0) rings.set(stages[0], globalRing);
  const sectionBudget = Math.floor((MAX_BYTES - Math.max(0, outputStages.length - 1)) / outputStages.length);
  const sections = outputStages.map((stage) => renderSection(stage, rings.get(stage) ?? [], sectionBudget));
  process.stdout.write(sections.join("\n"));
};

main().catch((error) => {
  process.stderr.write(`run-gate: could not forward failure excerpt: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
NODE
}

# The default path above keeps the gate's noisy output on the worker, which is
# why a remote FAIL used to carry only its stage name back to the dispatcher.
# Forward each failing step's tail for a repair description. Per-step line caps
# preserve every failure, and the shared byte cap keeps pathological output from
# becoming an unbounded transport. Emit the final verdict after the excerpt so
# every consumer still sees the proof line last.
case "$verdict" in
  'MERGE GATE: FAIL ('*')')
    printf 'run-gate: failure excerpt (last 200 lines per failing step)\n'
    forward_failure_excerpt "$LOG" "$verdict" || true
    printf '\n'
    ;;
esac

printf '%s\n' "$verdict"
printf 'run-gate: log %s\n' "$LOG"
exit "$status"
