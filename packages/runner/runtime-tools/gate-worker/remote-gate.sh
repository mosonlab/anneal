#!/usr/bin/env bash
#
# Gate a commit on one remote worker and bring the verdict home. Runs ON THE
# LOCAL MACHINE (issue #132):
#
#   @SCRIPT_DIR@/remote-gate.sh <server>                  # gate local HEAD
#   @SCRIPT_DIR@/remote-gate.sh <server> <oid>            # gate that commit
#   @SCRIPT_DIR@/remote-gate.sh <server> <oid> --verbose  # stream the log
#   @SCRIPT_DIR@/remote-gate.sh <server> <oid> --fetch-log # scp the log back
#   @SCRIPT_DIR@/remote-gate.sh <server> <oid> --master <oid> # state the baseline
#   AGENTOS_GATE_SERVER=<server> @SCRIPT_DIR@/remote-gate.sh <oid>
#
# The gate's frozen-record rules are statements about what is already on the
# default branch, so a verdict has to name the baseline it was formed against.
# That oid is resolved here, on the machine that can actually ask — `git
# ls-remote --symref origin HEAD`, which names origin's default branch and its
# head in one answer, or --master to state it — and passed to the worker, whose
# mirror does not fetch and could otherwise only offer a ref of unknown age. If
# this repository cannot resolve the oid origin just named, neither can
# the mirror, and the fix is an exact candidate/baseline mirror-push.
#
# The worker hosts one directory per repository under ~/gate/<repo>, keyed by
# the origin repository's name; this script derives the same name mirror-push.sh
# does and asks that directory's own run-gate.sh.
#
# One synchronous ssh call. No service, no queue, no polling: the gate is a few
# minutes on an idle worker and longer on a busy one, and this command blocks
# for exactly that long, which is the whole reason it needs no state on either
# side. `docs/runbooks/gate-worker.md` carries the measured numbers.
#
# What comes back on stdout is merge-gate.sh's own verdict line — MERGE GATE:
# PASS <oid> / FAIL (<step>) / NOT AUTHORITATIVE — the bounded failure excerpt
# emitted by run-gate.sh for FAILs, and the path of the full log on the worker.
# The exit code is the worker's, unchanged:
#
#   0  PASS                 2  usage error
#   1  FAIL                 3  NOT AUTHORITATIVE
#   76  nothing ran: a precondition failed here or on the worker, so no verdict
#       was formed. Not a FAIL. The line on stdout is GATE NOT RUN: <reason>.
#   255 ssh transport failure — no verdict was produced either; this is not a
#       FAIL, and it is the one code that must never be read as one. Re-run it.
#
# A FAIL is a statement about the commit. Everything that stops this script
# before the worker forms one — an unreadable origin, a baseline this checkout
# does not have, a repository name that cannot be sent — exits 76 rather than 1,
# because an automation reading exit codes must be able to tell a judgement from
# an errand.
#
# What a remote PASS is worth (state this honestly wherever it is quoted):
#
#   It is evidence, not authority. The merge still happens on the local machine
#   and still binds an exact head. A worker that has been tampered with can forge
#   a PASS but cannot perform the caller's merge. The worker is trusted compute:
#   candidate code can reach its network and anything available to its account,
#   including credentials if the operator placed them there. The gate mirror has
#   no remote and receives exact objects from the caller; this repository claims
#   neither credential nor network isolation. Release-grade merges are
#   spot-checked locally. docs/runbooks/gate-worker.md states the boundary.
#
# The commit must already be in the worker's mirror. The worker never fetches, so
# push first: @SCRIPT_DIR@/mirror-push.sh <server> --candidate <oid>
# --baseline <baseline-oid>. Routine callers use gate-dispatch.sh, which freezes
# and transports both before invoking this script.
set -uo pipefail

SERVER="${AGENTOS_GATE_SERVER:-}"
GATE_HOME="${GATE_HOME:-gate}"   # relative to the remote account's $HOME
SSH_PORT=""
OID=""
MASTER_OID=""
VERBOSE=0
FETCH_LOG=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=packages/runner/runtime-tools/gate-worker/lib.sh
. "${SCRIPT_DIR}/lib.sh" || exit 76
gate_require_run_authority

# 2, not sysexits' 64: this script's exit codes are the gate's table, and the
# table has one row for a usage error. Two numbers for one meaning is how a
# caller ends up with a case it does not handle.
EXIT_USAGE=2

usage() {
  sed -n '2,65p' "$0" \
    | sed 's/^#\{1,2\} \{0,1\}//' \
    | sed "s|@SCRIPT_DIR@|${SCRIPT_DIR}|g"
  exit "${1:-0}"
}

no_verdict() {
  printf 'remote-gate: %s\n' "$1" >&2
  printf 'GATE NOT RUN: %s\n' "$1"
  exit "$GATE_EXIT_NO_VERDICT"
}

die() { printf 'remote-gate: %s\n' "$1" >&2; exit "${2:-$EXIT_USAGE}"; }

# A positional argument is an oid if it looks like one and a server otherwise, so
# that both `remote-gate.sh gate-worker` and `remote-gate.sh gate-worker <oid>`
# read naturally and neither can be silently taken for the other.
looks_like_oid() {
  case "$1" in
    *[!0-9a-fA-F]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || die "--port needs a number" "$EXIT_USAGE"
      SSH_PORT="$2"; shift ;;
    --port=*) SSH_PORT="${1#--port=}" ;;
    --gate-home)
      [ $# -ge 2 ] || die "--gate-home needs a path" "$EXIT_USAGE"
      GATE_HOME="$2"; shift ;;
    --gate-home=*) GATE_HOME="${1#--gate-home=}" ;;
    --verbose|-v) VERBOSE=1 ;;
    --fetch-log) FETCH_LOG=1 ;;
    --master)
      [ $# -ge 2 ] || die "--master needs an object id" "$EXIT_USAGE"
      MASTER_OID="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"; shift ;;
    --master=*) MASTER_OID="$(printf '%s' "${1#--master=}" | tr '[:upper:]' '[:lower:]')" ;;
    -h|--help) usage 0 ;;
    -*) printf 'remote-gate: unknown argument %s\n\n' "$1" >&2; usage "$EXIT_USAGE" ;;
    *)
      # Server first, then commit. A first argument that already looks like an oid
      # is taken as one so that AGENTOS_GATE_SERVER users can pass just the commit;
      # anything after the server is a commit even when malformed, so a truncated
      # oid is reported as a bad oid rather than as a second server.
      if [ -z "$SERVER" ] && ! looks_like_oid "$1"; then
        SERVER="$1"
      elif [ -z "$OID" ]; then
        OID="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
      else
        die "unexpected extra argument: $1" "$EXIT_USAGE"
      fi
      ;;
  esac
  shift
done

[ -n "$SERVER" ] || { printf 'remote-gate: no server given\n\n' >&2; usage "$EXIT_USAGE"; }
if [ -n "$SSH_PORT" ]; then
  case "$SSH_PORT" in
    ''|*[!0-9]*) die "--port needs a number, got: $SSH_PORT" "$EXIT_USAGE" ;;
  esac
fi

if [ -z "${AGENTOS_WORKSPACE_PATH:-}" ]; then
  no_verdict "AGENTOS_WORKSPACE_PATH is required"
fi
[ -d "$AGENTOS_WORKSPACE_PATH" ] \
  || no_verdict "AGENTOS_WORKSPACE_PATH is not a directory: $AGENTOS_WORKSPACE_PATH"
REPO_ROOT="$(CDPATH= cd -- "$AGENTOS_WORKSPACE_PATH" && pwd -P)" \
  || no_verdict "cannot enter AGENTOS_WORKSPACE_PATH: $AGENTOS_WORKSPACE_PATH"
export AGENTOS_WORKSPACE_PATH="$REPO_ROOT"

# Nothing here forms a verdict, so nothing here may exit 1: a precondition that
# fails means no gate ran, and lib.sh's GATE_EXIT_NO_VERDICT is the code for
# that. Everything below that ends up inside the ssh command string is checked
# here, before anything is sent. lib.sh says what each of these accepts and why.
gate_valid_server "$SERVER" >/dev/null \
  || die "not a usable ssh destination: ${SERVER}" "$EXIT_USAGE"
gate_valid_home "$GATE_HOME" >/dev/null \
  || die "not a usable gate home: ${GATE_HOME} (relative path, [A-Za-z0-9._-] segments, no . or ..)" "$EXIT_USAGE"
REPO_NAME="$(gate_repo_name "$REPO_ROOT")" \
  || no_verdict "could not derive a safe repository name for ${REPO_ROOT}"
REPO_HOME="${GATE_HOME}/${REPO_NAME}"

# Default to this checkout's HEAD, resolved here rather than on the worker: the
# worker must never be the thing that decides which commit a verdict is about,
# because "gate my current work" and "gate whatever the mirror's HEAD happens to
# be" are different questions and only the first one is ever meant.
if [ -z "$OID" ]; then
  OID="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$OID" ] || die "no commit given and ${REPO_ROOT} has no resolvable HEAD" "$EXIT_USAGE"
  printf 'remote-gate: no commit given, using the local HEAD\n' >&2
fi

case "$OID" in
  *[!0-9a-f]*) die "not a full object id: $OID" "$EXIT_USAGE" ;;
esac
[ "${#OID}" -eq 40 ] || die "not a full 40-character object id: $OID" "$EXIT_USAGE"

# Local sanity, not a substitute for the worker's own check: an oid this machine
# cannot resolve was certainly never pushed, and catching that here costs nothing
# and saves an ssh round trip plus a confusing remote failure. A worktree of the
# same repository may legitimately not have it, hence the warning rather than the
# refusal.
if ! git -C "$REPO_ROOT" cat-file -e "${OID}^{commit}" 2>/dev/null; then
  printf 'remote-gate: warning — %s is not in %s; if the worker rejects it, push first\n' \
    "$OID" "$REPO_ROOT" >&2
fi

# Which commit the default branch is at, established before anything is sent.
# Asked of origin rather than read from a local remote-tracking ref: the ref is
# a cache of an answer someone once got, and if it is stale the gate's
# append-only check reads a modified frozen record as a new file and passes it.
# The symref form answers "which branch" and "at what commit" in one call, so
# the name and the oid cannot come from two different moments.
if [ -z "$MASTER_OID" ]; then
  # GIT_TERMINAL_PROMPT=0 so an expired credential fails here instead of hanging
  # on a password prompt in the middle of a scripted merge.
  symref="$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" ls-remote --symref origin HEAD 2>/dev/null)" \
    || no_verdict "could not read HEAD from origin; pass --master <oid> to state it"
  MASTER_OID="$(printf '%s\n' "$symref" | awk '$2 == "HEAD" {print $1; exit}')"
  [ -n "$MASTER_OID" ] \
    || no_verdict "origin did not answer with a default-branch head; pass --master <oid> to state it"
fi
case "$MASTER_OID" in
  *[!0-9a-f]* | "") die "not a full object id for master: ${MASTER_OID:-<empty>}" "$EXIT_USAGE" ;;
esac
[ "${#MASTER_OID}" -eq 40 ] || die "not a full 40-character object id for master: $MASTER_OID" "$EXIT_USAGE"
# If this repository cannot resolve it, the mirror it feeds certainly cannot.
if ! git -C "$REPO_ROOT" cat-file -e "${MASTER_OID}^{commit}" 2>/dev/null; then
  no_verdict "baseline ${MASTER_OID} is not in ${REPO_ROOT}; run: git fetch origin, then mirror-push.sh"
fi

# Expanded as ${arr[@]+"${arr[@]}"} at every use site: bash 3.2, which is what
# /bin/bash still is on macOS, treats an empty array as unset under `set -u`
# and aborts. The + form expands to nothing when the array is empty.
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
[ -n "$SSH_PORT" ] && SSH_OPTS+=(-p "$SSH_PORT")
SCP_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
[ -n "$SSH_PORT" ] && SCP_OPTS+=(-P "$SSH_PORT")

printf 'remote-gate: %s on %s%s\n' "$OID" "$SERVER" "${SSH_PORT:+ (port ${SSH_PORT})}" >&2
printf 'remote-gate: baseline %s\n' "$MASTER_OID" >&2
printf 'remote-gate: a full gate is a few minutes on an idle worker; this blocks until it finishes\n' >&2

REMOTE_VERBOSE=""
[ "$VERBOSE" -eq 1 ] && REMOTE_VERBOSE=" --verbose"

# Output goes to a file rather than a command substitution so that --verbose can
# stream: a $(...) capture would hold the whole build's output and print it all
# at the end, which is the opposite of what asking for the log means.
CAPTURE="$(mktemp "${TMPDIR:-/tmp}/agentos-remote-gate.XXXXXXXX")" \
  || no_verdict "could not create a temporary file for the worker's output"
trap 'rm -f -- "$CAPTURE"' EXIT

# -n so the remote command cannot consume this script's stdin, and no -t: a tty
# would let the remote side interleave and colour its output. The stream carries
# the machine-readable verdict plus the worker's bounded FAIL excerpt. Both oids
# were validated as 40 hex characters above, so they carry nothing a remote shell
# could act on.
if [ "$VERBOSE" -eq 1 ]; then
  ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} -n "$SERVER" \
    "cd ${REPO_HOME} && ./run-gate.sh ${OID} --master ${MASTER_OID}${REMOTE_VERBOSE}" 2>&1 | tee "$CAPTURE"
  status=${PIPESTATUS[0]}
else
  ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} -n "$SERVER" \
    "cd ${REPO_HOME} && ./run-gate.sh ${OID} --master ${MASTER_OID}${REMOTE_VERBOSE}" > "$CAPTURE" 2>&1
  status=$?
  cat "$CAPTURE"
fi

if [ "$status" -eq 255 ]; then
  # ssh's own failure code. A dropped connection produced no verdict, and reading
  # it as a FAIL would be the worst possible error in this direction: it would
  # block a merge on a network hiccup and, worse, teach people to ignore FAILs.
  printf '\nremote-gate: ssh failed (exit 255) — no verdict was produced. This is NOT a FAIL; re-run it.\n' >&2
  exit 255
fi

REMOTE_LOG="$(sed -n 's/^run-gate: log //p' "$CAPTURE" | tail -1)"

if [ "$FETCH_LOG" -eq 1 ] && [ -n "$REMOTE_LOG" ]; then
  local_log="${TMPDIR:-/tmp}/agentos-remote-gate-${OID:0:12}.log"
  if scp ${SCP_OPTS[@]+"${SCP_OPTS[@]}"} -q "${SERVER}:${REMOTE_LOG}" "$local_log" 2>/dev/null; then
    printf 'remote-gate: log copied to %s\n' "$local_log" >&2
  else
    printf 'remote-gate: could not copy %s from %s\n' "$REMOTE_LOG" "$SERVER" >&2
  fi
elif [ -n "$REMOTE_LOG" ]; then
  printf 'remote-gate: full log stays on the worker; fetch it with\n' >&2
  printf '  scp %s%s:%s .\n' "${SSH_PORT:+-P ${SSH_PORT} }" "$SERVER" "$REMOTE_LOG" >&2
fi

# Whatever the worker decided, unchanged. This wrapper transports a verdict; it
# never forms one, so there is no branch here that can turn a FAIL into a PASS.
exit "$status"
