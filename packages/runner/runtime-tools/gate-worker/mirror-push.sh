#!/usr/bin/env bash
#
# Push this repository into the gate worker's bare mirror. Runs ON THE LOCAL
# MACHINE (issue #132):
#
#   @SCRIPT_DIR@/mirror-push.sh <server> --candidate <oid> --baseline <oid>
#   @SCRIPT_DIR@/mirror-push.sh <server> --candidate <oid> --baseline <oid> --dry-run
#
# <server> is anything ssh accepts: a Host alias from ~/.ssh/config (preferred —
# it keeps the address, the user, the port and the key in one place that is not
# this repository) or user@host. Add --port for a one-off.
#
# The worker hosts one mirror per repository, under ~/gate/<repo>/, where <repo>
# is the origin repository's name. The mirror is created on first push; the
# worker-wide toolchain is provision.sh's job, a repository arriving is this
# script's. Everything about one repository — mirror, worktrees, logs, harness —
# lives under its own directory, so a second project can be gated on the same
# worker without either seeing the other.
#
# This is the only path by which code reaches the worker's gate mirror. The
# mirror has no remote configured, so no repository content arrives there
# except by this push, and the mirror cannot fetch. That
# is a statement about how code gets in, not about what the worker's network can
# reach: the gate executes the candidate commit's own code, and nothing here
# constrains what that code connects to. docs/runbooks/gate-worker.md states the
# boundary.
#
# Three things are pushed:
#
#   1. the exact candidate object, retained at refs/gate/candidates/<oid>;
#   2. the exact baseline object, retained at refs/gate/baselines/<oid>;
#   3. @SCRIPT_DIR@/lib.sh and @SCRIPT_DIR@/run-gate.sh, installed
#      at ~/gate/<repo>/, so the harness on the worker is the one in this
#      checkout. run-gate.sh sources lib.sh for the verdict's exit codes and its
#      reader, so the pair travels together and lib.sh lands first: the name
#      run-gate.sh must never refer to a harness whose lib.sh is not beside it.
#      Each install is a copy to a temporary name in that directory followed by a
#      rename, so a file a gate reads is always whole even if two pushes race.
#
# The caller resolves both oids before taking a worker slot. This script refuses
# an oid the checkout cannot resolve, pushes only those two immutable cache refs,
# and reads both refs back exactly. It never treats this checkout's ref namespace
# as authority and never deletes a worker ref. A detached or single-branch clone
# is therefore a complete transport source as long as it contains the requested
# candidate and the caller refreshed the requested baseline object.
#
# The transport copies no credential. The push is git-over-ssh; the ssh key stays
# on this machine and is used for authentication, never copied.
#
# <server>, --gate-home and the repository name all become part of a command
# string a remote login shell parses. Each is validated against an allowlist in
# lib.sh before anything is sent, and refused rather than quoted when it falls
# outside; the values are a trust boundary, not a formatting problem.
set -uo pipefail

SERVER="${AGENTOS_GATE_SERVER:-}"
GATE_HOME="${GATE_HOME:-gate}"   # relative to the remote account's $HOME
SSH_PORT=""
DRY_RUN=0
CANDIDATE_OID=""
BASELINE_OID=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=packages/runner/runtime-tools/gate-worker/lib.sh
. "${SCRIPT_DIR}/lib.sh" || exit 76
gate_require_run_authority

usage() {
  sed -n '2,58p' "$0" \
    | sed 's/^#\{1,2\} \{0,1\}//' \
    | sed "s|@SCRIPT_DIR@|${SCRIPT_DIR}|g"
  exit "${1:-0}"
}

die() { printf 'mirror-push: %s\n' "$1" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || die "--port needs a number" 64
      SSH_PORT="$2"; shift ;;
    --port=*) SSH_PORT="${1#--port=}" ;;
    --gate-home)
      [ $# -ge 2 ] || die "--gate-home needs a path" 64
      GATE_HOME="$2"; shift ;;
    --gate-home=*) GATE_HOME="${1#--gate-home=}" ;;
    --candidate)
      [ $# -ge 2 ] || die "--candidate needs an object id" 64
      CANDIDATE_OID="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"; shift ;;
    --candidate=*) CANDIDATE_OID="$(printf '%s' "${1#--candidate=}" | tr '[:upper:]' '[:lower:]')" ;;
    --baseline)
      [ $# -ge 2 ] || die "--baseline needs an object id" 64
      BASELINE_OID="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"; shift ;;
    --baseline=*) BASELINE_OID="$(printf '%s' "${1#--baseline=}" | tr '[:upper:]' '[:lower:]')" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage 0 ;;
    -*) printf 'mirror-push: unknown argument %s\n\n' "$1" >&2; usage 64 ;;
    *)
      [ -z "$SERVER" ] || die "more than one server given: $SERVER and $1" 64
      SERVER="$1" ;;
  esac
  shift
done

[ -n "$SERVER" ] || { printf 'mirror-push: no server given\n\n' >&2; usage 64; }
[ -n "$CANDIDATE_OID" ] || die "--candidate is required" 64
[ -n "$BASELINE_OID" ] || die "--baseline is required" 64
for named_oid in "candidate:${CANDIDATE_OID}" "baseline:${BASELINE_OID}"; do
  oid_name="${named_oid%%:*}"
  oid_value="${named_oid#*:}"
  case "$oid_value" in *[!0-9a-f]*) die "not a full object id for ${oid_name}: ${oid_value}" 64 ;; esac
  [ "${#oid_value}" -eq 40 ] || die "not a full 40-character object id for ${oid_name}: ${oid_value}" 64
done
case "$SERVER" in
  -*) die "server looks like an option: $SERVER" 64 ;;
esac
if [ -n "$SSH_PORT" ]; then
  case "$SSH_PORT" in
    ''|*[!0-9]*) die "--port needs a number, got: $SSH_PORT" 64 ;;
  esac
fi

[ -n "${AGENTOS_WORKSPACE_PATH:-}" ] \
  || die "AGENTOS_WORKSPACE_PATH is required"
[ -d "$AGENTOS_WORKSPACE_PATH" ] \
  || die "AGENTOS_WORKSPACE_PATH is not a directory: $AGENTOS_WORKSPACE_PATH"
REPO_ROOT="$(CDPATH= cd -- "$AGENTOS_WORKSPACE_PATH" && pwd -P)" \
  || die "cannot enter AGENTOS_WORKSPACE_PATH: $AGENTOS_WORKSPACE_PATH"
export AGENTOS_WORKSPACE_PATH="$REPO_ROOT"
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 \
  || die "${REPO_ROOT} is not a git repository"
# The gate contract: what run-gate.sh executes inside the checked-out commit.
# A repository without it has nothing for the worker to run.
[ -f "${REPO_ROOT}/scripts/merge-gate.sh" ] \
  || die "${REPO_ROOT} has no scripts/merge-gate.sh; the worker gates repositories that ship their own gate"
git -C "$REPO_ROOT" cat-file -e "${CANDIDATE_OID}^{commit}" 2>/dev/null \
  || die "candidate ${CANDIDATE_OID} is not in ${REPO_ROOT}"
git -C "$REPO_ROOT" cat-file -e "${BASELINE_OID}^{commit}" 2>/dev/null \
  || die "baseline ${BASELINE_OID} is not in ${REPO_ROOT}; refresh it before pushing"

# Checked before anything is sent: each of these is interpolated into a command
# string the remote login shell parses. lib.sh says what each one accepts.
gate_valid_server "$SERVER" >/dev/null \
  || die "not a usable ssh destination: ${SERVER}" 64
gate_valid_home "$GATE_HOME" >/dev/null \
  || die "not a usable gate home: ${GATE_HOME} (relative path, [A-Za-z0-9._-] segments, no . or ..)" 64
REPO_NAME="$(gate_repo_name "$REPO_ROOT")" \
  || die "could not derive a safe repository name for ${REPO_ROOT}"
REPO_HOME="${GATE_HOME}/${REPO_NAME}"

# Expanded as ${arr[@]+"${arr[@]}"} at every use site: bash 3.2, which is what
# /bin/bash still is on macOS, treats an empty array as unset under `set -u`
# and aborts. The + form expands to nothing when the array is empty.
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
SCP_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
if [ -n "$SSH_PORT" ]; then
  SSH_OPTS+=(-p "$SSH_PORT")
  SCP_OPTS+=(-P "$SSH_PORT")
fi
# git has no --port: the scp-style address form used below cannot carry one, and
# the ssh:// form that can does not expand ~ in the path. Passing the port and
# fixed liveness options through GIT_SSH_COMMAND keeps the address form that
# works.
GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3"
[ -n "$SSH_PORT" ] && GIT_SSH_COMMAND="${GIT_SSH_COMMAND} -p ${SSH_PORT}"
export GIT_SSH_COMMAND

# A path relative to the remote $HOME, expanded by the remote login shell rather
# than written as ~ inside a URL: git's ssh:// URLs do not expand a tilde, and
# `ssh://host/~/gate/...` silently means a literal "~" directory on some
# servers. The scp:-style address form below leaves the expansion to the shell,
# which is the behaviour this wants.
REMOTE_MIRROR="${SERVER}:${REPO_HOME}/mirror.git"
CANDIDATE_REF="refs/gate/candidates/${CANDIDATE_OID}"
BASELINE_REF="refs/gate/baselines/${BASELINE_OID}"

printf '== Gate worker mirror push\n'
printf '   repository: %s (%s)\n' "$REPO_ROOT" "$REPO_NAME"
printf '   server:     %s%s\n' "$SERVER" "${SSH_PORT:+ (port ${SSH_PORT})}"
printf '   mirror:     %s\n' "$REMOTE_MIRROR"
printf '   candidate:  %s\n' "$CANDIDATE_OID"
printf '   baseline:   %s\n' "$BASELINE_OID"

# First push of a repository creates its mirror; anything else standing at that
# path is refused rather than pushed into. `git init` on an existing bare
# repository is a no-op, so this is convergent, but a non-bare directory there
# is somebody's working state and not this script's to overwrite.
MIRROR_EXISTS=0
if ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" "test -e ${REPO_HOME}/mirror.git" 2>/dev/null; then
  MIRROR_EXISTS=1
  ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
      "test \"\$(git -C ${REPO_HOME}/mirror.git rev-parse --is-bare-repository 2>/dev/null)\" = true" 2>/dev/null \
    || die "${REPO_HOME}/mirror.git on ${SERVER} exists but is not a bare repository; refusing to push into it"
elif [ "$DRY_RUN" -eq 1 ]; then
  printf '   would create the bare mirror %s\n' "$REMOTE_MIRROR"
else
  ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
      "mkdir -p ${REPO_HOME} && git init --bare -q ${REPO_HOME}/mirror.git" \
    || die "could not create ${REPO_HOME}/mirror.git on ${SERVER}"
  printf '   created the bare mirror\n'
fi

# A mirror that has acquired a remote is a mirror that could fetch, and "the
# mirror fetches from nowhere" is a property this script gets to keep true on
# every push, not only at creation.
#
# The question asked is "does `git remote` succeed and print nothing", not "is
# the output empty": those differ exactly when git itself failed, and a guard
# that cannot tell them apart reports a mirror it never managed to inspect as
# clean. `git remote` on a readable repository exits 0 with no output, so a
# non-zero exit here — git's or ssh's — is a mirror whose remotes are unknown,
# and unknown is refused.
if [ "$DRY_RUN" -eq 0 ]; then
  if ! mirror_remotes="$(ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
      "git -C ${REPO_HOME}/mirror.git remote" 2>/dev/null)"; then
    die "could not read the remotes of ${REPO_HOME}/mirror.git on ${SERVER}; refusing to push into a mirror this check could not inspect"
  fi
  if [ -n "$mirror_remotes" ]; then
    die "${REPO_HOME}/mirror.git has a remote configured (${mirror_remotes}); the worker fetches from nowhere — remove it"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n== Dry run: exact cache refs that would be pushed\n'
  if [ "$MIRROR_EXISTS" -eq 1 ]; then
    git -C "$REPO_ROOT" push --atomic --dry-run "$REMOTE_MIRROR" \
      "${CANDIDATE_OID}:${CANDIDATE_REF}" \
      "${BASELINE_OID}:${BASELINE_REF}" || die "dry-run push failed"
  else
    printf '   would push %s to %s\n' "$CANDIDATE_REF" "$REMOTE_MIRROR"
    printf '   would push %s to %s\n' "$BASELINE_REF" "$REMOTE_MIRROR"
  fi
  printf '\n   would also install %s/lib.sh then %s/run-gate.sh\n   under %s (copy to a temporary name in the same directory, then rename into\n   place)\n' "$SCRIPT_DIR" "$SCRIPT_DIR" "${SERVER}:${REPO_HOME}"
  printf '\nMIRROR PUSH: DRY RUN OK\n'
  exit 0
fi

printf '\n== Pushing exact candidate and baseline refs\n'
push_status=0
for push_attempt in 1 2 3; do
  push_status=0
  git -C "$REPO_ROOT" push --atomic "$REMOTE_MIRROR" \
    "${CANDIDATE_OID}:${CANDIDATE_REF}" \
    "${BASELINE_OID}:${BASELINE_REF}" || push_status=$?
  [ "$push_status" -ne 0 ] || break
  if [ "$push_attempt" -lt 3 ]; then
    printf 'mirror-push: exact-ref push failed; retrying attempt=%s/3\n' "$((push_attempt + 1))" >&2
    sleep 1
  fi
done
if [ "$push_status" -ne 0 ]; then
  # Two dispatches for the same oids can both advertise an absent immutable ref,
  # then race to create it. The loser may be rejected even though the exact
  # requested state is now present. Accept only an exact two-ref readback; any
  # transport error or different value remains the original loud push failure.
  candidate_after_race="$(ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
    "git -C ${REPO_HOME}/mirror.git rev-parse ${CANDIDATE_REF}^{commit}" 2>/dev/null || true)"
  baseline_after_race="$(ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
    "git -C ${REPO_HOME}/mirror.git rev-parse ${BASELINE_REF}^{commit}" 2>/dev/null || true)"
  if [ "$candidate_after_race" = "$CANDIDATE_OID" ] && [ "$baseline_after_race" = "$BASELINE_OID" ]; then
    printf '   concurrent push already installed both exact refs\n'
  else
    die "the exact-ref push failed"
  fi
fi

printf '\n== Installing the gate harness\n'
# scp truncates its target and then streams into it, so copying straight onto
# ${REPO_HOME}/run-gate.sh leaves a window in which the harness on the worker is
# a half-written file. Two mirror-pushes racing each other widens that window
# into interleaved writes, and a gate that starts during it reads whatever
# happens to be there — which has already corrupted the worker's run-gate.sh
# once. So the copy lands on a name nobody else uses and a rename moves it into
# place: rename(2) within one directory is atomic, and a reader either gets the
# whole old file or the whole new one, never a mixture. A concurrent install only
# decides which complete harness is available to the next invocation; a gate
# already executing keeps the inode it opened.
# lib.sh before run-gate.sh, because run-gate.sh sources it: the order is what
# keeps the installed harness runnable at every instant of an install rather
# than only at the end of one.
for harness_file in lib.sh run-gate.sh; do
  harness_tmp_name="${harness_file}.tmp.$$.${RANDOM}"
  remote_harness_tmp="${SERVER}:${REPO_HOME}/${harness_tmp_name}"

  remove_harness_tmp() {
    ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
      "rm -f ${REPO_HOME}/${harness_tmp_name}" >/dev/null 2>&1 || true
  }

  scp ${SCP_OPTS[@]+"${SCP_OPTS[@]}"} -q "${SCRIPT_DIR}/${harness_file}" "$remote_harness_tmp" || {
    remove_harness_tmp
    die "could not copy ${harness_file} to ${remote_harness_tmp}"
  }
  # chmod before the rename, so the file is never in place without its mode: the
  # name ${REPO_HOME}/${harness_file} only ever refers to a complete file.
  ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
      "chmod 755 ${REPO_HOME}/${harness_tmp_name} && mv -f ${REPO_HOME}/${harness_tmp_name} ${REPO_HOME}/${harness_file}" || {
    remove_harness_tmp
    die "could not install ${REPO_HOME}/${harness_file} atomically"
  }
  printf '   %s\n' "${SERVER}:${REPO_HOME}/${harness_file}"
done

# Read the refs back rather than trusting the push. Object existence alone would
# not prove that the immutable cache name carries the oid it claims to name.
printf '\n== Verifying exact cache refs\n'
for named_ref in "candidate:${CANDIDATE_OID}:${CANDIDATE_REF}" "baseline:${BASELINE_OID}:${BASELINE_REF}"; do
  ref_kind="${named_ref%%:*}"
  ref_rest="${named_ref#*:}"
  expected_oid="${ref_rest%%:*}"
  cache_ref="${ref_rest#*:}"
  actual_oid="$(ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$SERVER" \
    "git -C ${REPO_HOME}/mirror.git rev-parse ${cache_ref}^{commit}" 2>/dev/null)" \
    || die "could not read back ${cache_ref} from ${REMOTE_MIRROR}"
  [ "$actual_oid" = "$expected_oid" ] \
    || die "${ref_kind} ref ${cache_ref} read back as ${actual_oid}, expected ${expected_oid}"
  printf '   %s %s\n' "$cache_ref" "$actual_oid"
done

printf '\nMIRROR PUSH: OK\n'
printf 'Next: %s/remote-gate.sh %s %s --master %s\n' "$SCRIPT_DIR" "$SERVER" "$CANDIDATE_OID" "$BASELINE_OID"
