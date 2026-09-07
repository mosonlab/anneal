#!/usr/bin/env bash
#
# Run one merge gate in the first usable slot: explicitly enabled local slots,
# then the primary worker, then the fallback worker. The local machine is used
# only with explicit opt-in. Runs ON THE LOCAL MACHINE:
#
#   @SCRIPT_DIR@/gate-dispatch.sh <oid>
#   @SCRIPT_DIR@/gate-dispatch.sh <oid> --master <oid>
#   @SCRIPT_DIR@/gate-dispatch.sh <oid> --allow-local
#   @SCRIPT_DIR@/gate-dispatch.sh <oid> --server <one-server>
#
# The slot model rations measured host capacity, not arbitrary processes. An
# explicitly configured primary worker contributes AGENTOS_GATE_PRIMARY_SLOTS
# slots (1 or 2, two when unset), which must be the same number as that worker's
# own ~/gate/worker-capacity, and an explicitly configured fallback worker
# contributes one. The explicit --server form remains one slot. With no remote
# configured, --allow-local selects a local-only dispatch. The local machine
# contributes the configured number of slots only when --allow-local (or
# AGENTOS_GATE_ALLOW_LOCAL=1) says this invocation may spend its resources, and
# those slots are tried before remotes.
#
# The accounting is one lock file per configured slot under the runner account's
# cache: AGENTOS_RUNNER_HOME/.cache/gate-dispatch/ in a Run, otherwise
# ${XDG_CACHE_HOME:-~/.cache}/gate-dispatch/. It is outside any repository because
# the slots belong to the account, not to a checkout. lib.sh holds the locking
# itself and says why it is shaped the way it is. Sessions of one account contend
# for the same slots. A direct merge-gate.sh is invisible to this accounting. A
# direct remote-gate.sh bypasses the local accounting too, but run-gate.sh
# enforces the worker's configured capacity with worker-wide execution locks
# held for the real process lifetime.
#
# The optional local slots are only eligible when this worktree is already the
# thing a local gate would test: HEAD at the requested commit and the tree clean.
# Otherwise merge-gate.sh would refuse anyway, so the dispatch goes straight to
# the worker, which can gate any pushed oid without a local checkout.
#
# A remote attempt pushes first, always. The dispatcher fixes the candidate and
# baseline oids before taking a slot; mirror-push.sh transports exactly those
# objects under immutable cache refs and never mirrors the checkout's ref set.
#
# A PASS, FAIL or NOT AUTHORITATIVE result stops dispatch. A remote FAIL includes
# run-gate.sh's bounded per-failing-step worker-log excerpt, which is transported
# verbatim with the proof line. A local or remote attempt that produces no
# verdict is retired for this invocation and the same candidate and baseline are
# tried on the next machine. No intermediate GATE NOT RUN line is printed on
# stdout, so a successful fallback still has one unambiguous verdict line.
#
# When every usable slot is taken, this blocks and re-polls — the caller wanted a
# verdict, not an errand. --timeout-minutes bounds a queue that is not moving,
# not the wait itself: every poll reads which pid holds each busy slot, and a
# slot that changes hands is a gate that ended and a place in the queue this
# dispatch just moved up. Each such turnover restarts the timeout. A deep queue
# of ordinary gates therefore waits its turn instead of being cut off mid-queue,
# while a queue where nothing finishes for --timeout-minutes is still reported as
# systemically full — which is the only case the caller can act on.
#
# Exit codes. A verdict and the absence of a verdict are different answers and
# never share a code: the gate's own codes pass through unchanged. SSH failure
# on one worker is consumed by fallback; if every configured worker produces no
# verdict, this script returns 76. An automation may read 1 as FAIL only because
# nothing else here can produce it.
#
#   0  PASS                 75  every eligible slot stayed busy, and none of them
#                               changed hands for the whole timeout
#   1  FAIL                 76  nothing ran: a precondition, the mirror push or
#   2  usage error              a slot lock failed, so no verdict was formed
#   3  NOT AUTHORITATIVE
#
# 75 and 76 are not FAILs and must never be read as one.
#
# At timeout, 76 means a tried lock was broken or a worker produced no verdict;
# otherwise 75 means the eligible slots stayed busy and none of them changed
# hands. Fallback is not eligible while a healthy primary is busy and its grace
# has not elapsed. A timeout shorter than the grace can therefore return 75
# without probing fallback; use a longer timeout or shorter grace to allow
# fallback on a later dispatch.
# A slot whose lock is broken is never counted as busy.
set -uo pipefail

# No EXIT_FAIL here on purpose: this script transports verdicts and forms none,
# so the only 1 a caller can ever see from it is one the gate itself produced.
EXIT_USAGE=2
EXIT_NO_SLOT=75
MAX_LOCAL_SLOT_COUNT=1024

PRIMARY_SERVER="${AGENTOS_GATE_PRIMARY_SERVER:-}"
FALLBACK_SERVER="${AGENTOS_GATE_FALLBACK_SERVER:-}"
SINGLE_SERVER=0
if [ -n "${AGENTOS_GATE_SERVER:-}" ]; then
  PRIMARY_SERVER="$AGENTOS_GATE_SERVER"
  FALLBACK_SERVER=""
  SINGLE_SERVER=1
fi
ALLOW_LOCAL="${AGENTOS_GATE_ALLOW_LOCAL:-0}"
PRIMARY_SLOT_COUNT="${AGENTOS_GATE_PRIMARY_SLOTS-2}"
LOCAL_SLOT_COUNT="${AGENTOS_GATE_LOCAL_SLOTS-1}"
POLL_SECONDS="${GATE_DISPATCH_POLL_SECONDS:-30}"
TIMEOUT_MINUTES="${GATE_DISPATCH_TIMEOUT_MINUTES:-60}"
FALLBACK_AFTER_MINUTES="${GATE_DISPATCH_FALLBACK_AFTER_MINUTES:-6}"
if [ -n "${AGENTOS_RUNNER_HOME:-}" ]; then
  SLOT_ROOT="${AGENTOS_RUNNER_HOME}/.cache/gate-dispatch"
  SLOT_ROOT_SOURCE="AGENTOS_RUNNER_HOME"
elif [ -n "${XDG_CACHE_HOME:-}" ]; then
  SLOT_ROOT="${XDG_CACHE_HOME}/gate-dispatch"
  SLOT_ROOT_SOURCE="XDG_CACHE_HOME"
else
  SLOT_ROOT="$HOME/.cache/gate-dispatch"
  SLOT_ROOT_SOURCE="HOME"
fi

OID=""
MASTER_OID=""
DEFAULT_REF=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  awk 'NR > 1 && /^#/ { sub(/^#+ ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" \
    | sed "s|@SCRIPT_DIR@|${SCRIPT_DIR}|g"
  exit "${1:-0}"
}

die() { printf 'gate-dispatch: %s\n' "$1" >&2; exit "${2:-$EXIT_USAGE}"; }

read_origin_head() {
  local attempt output
  for attempt in 1 2 3; do
    if output="$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" ls-remote --symref origin HEAD 2>/dev/null)"; then
      printf '%s\n' "$output"
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      printf 'gate-dispatch: origin HEAD read failed; retrying attempt=%s/3\n' "$((attempt + 1))" >&2
      sleep 1
    fi
  done
  return 1
}

fetch_origin_ref() {
  local ref="$1" attempt
  for attempt in 1 2 3; do
    if GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" fetch --no-tags --no-write-fetch-head origin "$ref" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      printf 'gate-dispatch: origin ref fetch failed; retrying attempt=%s/3\n' "$((attempt + 1))" >&2
      sleep 1
    fi
  done
  return 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --master)
      [ $# -ge 2 ] || die "--master needs an object id"
      MASTER_OID="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"; shift ;;
    --master=*) MASTER_OID="$(printf '%s' "${1#--master=}" | tr '[:upper:]' '[:lower:]')" ;;
    --server)
      [ $# -ge 2 ] || die "--server needs a value"
      PRIMARY_SERVER="$2"; FALLBACK_SERVER=""; SINGLE_SERVER=1; shift ;;
    --server=*) PRIMARY_SERVER="${1#--server=}"; FALLBACK_SERVER=""; SINGLE_SERVER=1 ;;
    --primary-server)
      [ $# -ge 2 ] || die "--primary-server needs a value"
      PRIMARY_SERVER="$2"; shift ;;
    --primary-server=*) PRIMARY_SERVER="${1#--primary-server=}" ;;
    --fallback-server)
      [ $# -ge 2 ] || die "--fallback-server needs a value"
      FALLBACK_SERVER="$2"; shift ;;
    --fallback-server=*) FALLBACK_SERVER="${1#--fallback-server=}" ;;
    --allow-local) ALLOW_LOCAL=1 ;;
    --timeout-minutes)
      [ $# -ge 2 ] || die "--timeout-minutes needs a number"
      TIMEOUT_MINUTES="$2"; shift ;;
    --timeout-minutes=*) TIMEOUT_MINUTES="${1#--timeout-minutes=}" ;;
    -h|--help) usage 0 ;;
    -*) printf 'gate-dispatch: unknown argument %s\n\n' "$1" >&2; usage "$EXIT_USAGE" ;;
    *)
      [ -z "$OID" ] || die "more than one commit given: $OID and $1"
      OID="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" ;;
  esac
  shift
done

# The primary worker's capacity is stated twice — here and in its own
# ~/gate/worker-capacity — and a dispatcher counting more slots than the worker
# will run only produces an ssh session waiting on the worker's execution lock.
# So the count is configuration, not a constant, and a value the worker could
# never match is refused instead of being read as the default two.
case "$PRIMARY_SLOT_COUNT" in
  1|2) ;;
  *) die "AGENTOS_GATE_PRIMARY_SLOTS must be 1 or 2, got: $PRIMARY_SLOT_COUNT" ;;
esac

if [ -z "$PRIMARY_SERVER" ]; then
  PRIMARY_SLOTS=()
elif [ "$SINGLE_SERVER" -eq 1 ] || [ "$PRIMARY_SLOT_COUNT" -eq 1 ]; then
  PRIMARY_SLOTS=(remote-1)
else
  PRIMARY_SLOTS=(remote-1 remote-1-2)
fi

case "$TIMEOUT_MINUTES" in ''|*[!0-9]*) die "--timeout-minutes needs a number, got: $TIMEOUT_MINUTES" ;; esac
case "$FALLBACK_AFTER_MINUTES" in ''|*[!0-9]*) die "GATE_DISPATCH_FALLBACK_AFTER_MINUTES needs a number, got: $FALLBACK_AFTER_MINUTES" ;; esac
# Bound seconds to a signed 32-bit integer before doing shell arithmetic.
# Strip leading zeros first so decimal padding cannot overflow or imply octal.
FALLBACK_AFTER_MINUTES="$(printf '%s\n' "$FALLBACK_AFTER_MINUTES" | sed 's/^0*//')"
FALLBACK_AFTER_MINUTES="${FALLBACK_AFTER_MINUTES:-0}"
if [ "${#FALLBACK_AFTER_MINUTES}" -gt 8 ] \
  || { [ "${#FALLBACK_AFTER_MINUTES}" -eq 8 ] && [ "$FALLBACK_AFTER_MINUTES" -gt 35791394 ]; }; then
  die "GATE_DISPATCH_FALLBACK_AFTER_MINUTES needs a number no greater than 35791394, got: $FALLBACK_AFTER_MINUTES"
fi
case "$POLL_SECONDS" in ''|*[!0-9]*|0) die "GATE_DISPATCH_POLL_SECONDS needs a positive number, got: $POLL_SECONDS" ;; esac
case "$LOCAL_SLOT_COUNT" in
  ''|*[!0-9]*) die "AGENTOS_GATE_LOCAL_SLOTS needs a positive number, got: $LOCAL_SLOT_COUNT" ;;
esac
case "$LOCAL_SLOT_COUNT" in
  *[1-9]*) ;;
  *) die "AGENTOS_GATE_LOCAL_SLOTS needs a positive number, got: $LOCAL_SLOT_COUNT" ;;
esac
LOCAL_SLOT_COUNT_NUM="$(printf '%s\n' "$LOCAL_SLOT_COUNT" | sed 's/^0*//')"
if [ "${#LOCAL_SLOT_COUNT_NUM}" -gt 4 ] \
  || { [ "${#LOCAL_SLOT_COUNT_NUM}" -eq 4 ] && [ "$LOCAL_SLOT_COUNT_NUM" -gt "$MAX_LOCAL_SLOT_COUNT" ]; }; then
  die "AGENTOS_GATE_LOCAL_SLOTS needs a positive number no greater than ${MAX_LOCAL_SLOT_COUNT}, got: $LOCAL_SLOT_COUNT"
fi
case "$ALLOW_LOCAL" in 0|1) ;; *) die "AGENTOS_GATE_ALLOW_LOCAL must be 0 or 1, got: $ALLOW_LOCAL" ;; esac

LOCAL_SLOTS=()
if [ "$ALLOW_LOCAL" -eq 1 ]; then
  for ((local_slot_index = 1; local_slot_index <= LOCAL_SLOT_COUNT_NUM; local_slot_index++)); do
    LOCAL_SLOTS+=("local-${local_slot_index}")
  done
fi

# Sourced before the first check that reports a code: the slot locks, the values
# that reach a remote shell and the verdict's codes all live here, and this
# script transports verdicts rather than forming them, so every failure of its
# own is GATE_EXIT_NO_VERDICT.
# shellcheck source=packages/runner/runtime-tools/gate-worker/lib.sh
. "${SCRIPT_DIR}/lib.sh"

if [ -z "${AGENTOS_WORKSPACE_PATH:-}" ]; then
  die "AGENTOS_WORKSPACE_PATH is required" "$GATE_EXIT_NO_VERDICT"
fi
[ -d "$AGENTOS_WORKSPACE_PATH" ] \
  || die "AGENTOS_WORKSPACE_PATH is not a directory: $AGENTOS_WORKSPACE_PATH" "$GATE_EXIT_NO_VERDICT"
REPO_ROOT="$(CDPATH= cd -- "$AGENTOS_WORKSPACE_PATH" && pwd -P)" \
  || die "cannot enter AGENTOS_WORKSPACE_PATH: $AGENTOS_WORKSPACE_PATH" "$GATE_EXIT_NO_VERDICT"
export AGENTOS_WORKSPACE_PATH="$REPO_ROOT"

[ -f "${REPO_ROOT}/scripts/merge-gate.sh" ] \
  || die "${REPO_ROOT} has no scripts/merge-gate.sh; nothing to dispatch and no verdict exists" "$GATE_EXIT_NO_VERDICT"

[ -n "$PRIMARY_SERVER" ] || [ -z "$FALLBACK_SERVER" ] \
  || die "a fallback worker requires a primary worker" "$EXIT_USAGE"
if [ -z "$PRIMARY_SERVER" ] && [ "$ALLOW_LOCAL" -ne 1 ]; then
  die "no gate capacity configured; set AGENTOS_GATE_SERVER, configure a primary worker, pass --server, or opt in with --allow-local" "$GATE_EXIT_NO_VERDICT"
fi

# Validated here as well as inside the scripts that send it: this one decides
# which of them to call, and a destination it cannot vouch for is a dispatch
# that should not start rather than one that fails halfway through a push.
if [ -n "$PRIMARY_SERVER" ]; then
  gate_valid_server "$PRIMARY_SERVER" >/dev/null \
    || die "not a usable primary ssh destination: ${PRIMARY_SERVER}" "$EXIT_USAGE"
fi
if [ -n "$FALLBACK_SERVER" ]; then
  gate_valid_server "$FALLBACK_SERVER" >/dev/null \
    || die "not a usable fallback ssh destination: ${FALLBACK_SERVER}" "$EXIT_USAGE"
  [ "$PRIMARY_SERVER" != "$FALLBACK_SERVER" ] \
    || die "primary and fallback name the same ssh destination: ${PRIMARY_SERVER}" "$EXIT_USAGE"
fi

if [ -z "$OID" ]; then
  OID="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$OID" ] || die "no commit given and ${REPO_ROOT} has no resolvable HEAD"
  printf 'gate-dispatch: no commit given, using the local HEAD\n' >&2
fi
case "$OID" in *[!0-9a-f]*) die "not a full object id: $OID" ;; esac
[ "${#OID}" -eq 40 ] || die "not a full 40-character object id: $OID"
if [ -n "$MASTER_OID" ]; then
  case "$MASTER_OID" in *[!0-9a-f]*) die "not a full object id: $MASTER_OID" ;; esac
  [ "${#MASTER_OID}" -eq 40 ] || die "not a full 40-character object id: $MASTER_OID"
fi

git -C "$REPO_ROOT" cat-file -e "${OID}^{commit}" 2>/dev/null \
  || die "candidate ${OID} is not in ${REPO_ROOT}; nothing ran and no verdict exists" "$GATE_EXIT_NO_VERDICT"

# Freeze the integration baseline before slot selection. Without an explicit
# --master, origin's HEAD is the authority: fetch its branch without creating a
# local tracking ref, then read HEAD again and accept only the exact oid now
# advertised. If the branch moved beyond the fetched object, this dispatch stops
# loudly and can be retried; it never substitutes a stale local ref.
if [ -z "$MASTER_OID" ]; then
  symref="$(read_origin_head)" \
    || die "could not read HEAD from origin; pass --master <oid> to state the baseline" "$GATE_EXIT_NO_VERDICT"
  DEFAULT_REF="$(printf '%s\n' "$symref" | awk '$1 == "ref:" && $3 == "HEAD" {print $2; exit}')"
  [ -n "$DEFAULT_REF" ] \
    || die "origin did not name its default branch; pass --master <oid> to state the baseline" "$GATE_EXIT_NO_VERDICT"
  gate_valid_ref "$DEFAULT_REF" >/dev/null \
    || die "origin named a default branch this dispatcher will not fetch: ${DEFAULT_REF}" "$GATE_EXIT_NO_VERDICT"
  fetch_origin_ref "$DEFAULT_REF" \
    || die "could not refresh ${DEFAULT_REF} from origin; nothing ran and no verdict exists" "$GATE_EXIT_NO_VERDICT"
  refreshed="$(read_origin_head)" \
    || die "could not re-read HEAD from origin after refresh; nothing ran and no verdict exists" "$GATE_EXIT_NO_VERDICT"
  refreshed_ref="$(printf '%s\n' "$refreshed" | awk '$1 == "ref:" && $3 == "HEAD" {print $2; exit}')"
  MASTER_OID="$(printf '%s\n' "$refreshed" | awk '$2 == "HEAD" {print $1; exit}')"
  [ "$refreshed_ref" = "$DEFAULT_REF" ] \
    || die "origin changed its default branch during refresh (${DEFAULT_REF} -> ${refreshed_ref:-unknown}); retry dispatch" "$GATE_EXIT_NO_VERDICT"
  case "$MASTER_OID" in *[!0-9a-f]* | "") die "origin answered with no full baseline oid for ${DEFAULT_REF}" "$GATE_EXIT_NO_VERDICT" ;; esac
  [ "${#MASTER_OID}" -eq 40 ] \
    || die "origin answered with a short baseline oid for ${DEFAULT_REF}: ${MASTER_OID}" "$GATE_EXIT_NO_VERDICT"
fi
git -C "$REPO_ROOT" cat-file -e "${MASTER_OID}^{commit}" 2>/dev/null \
  || die "baseline ${MASTER_OID} is not in ${REPO_ROOT}; refresh the integration branch and retry" "$GATE_EXIT_NO_VERDICT"

# --- slots -------------------------------------------------------------------

HELD_SLOT=""

# 0 taken, 1 busy, 2 the lock is unusable. The distinction is the whole point:
# see the exit-code note in the header.
try_slot() {
  local outcome=0
  gate_slot_try "$SLOT_ROOT" "$1" || outcome=$?
  if [ "$outcome" -eq 0 ]; then
    HELD_SLOT="$1"
    return 0
  fi
  return "$outcome"
}

release_slot() {
  [ -n "$HELD_SLOT" ] || return 0
  gate_slot_release "$SLOT_ROOT" "$HELD_SLOT" || true
  HELD_SLOT=""
}

cleanup() {
  local status=$?
  trap - EXIT
  release_slot
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The local slot only helps when a local gate could actually run: merge-gate.sh
# refuses a worktree that is not exactly the requested commit, clean. Deciding
# that here keeps an ineligible dispatch from occupying the local slot just to
# hear the refusal.
local_eligible() {
  [ "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)" = "$OID" ] || return 1
  [ -z "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]
}

mkdir -p "$SLOT_ROOT" || die "could not create ${SLOT_ROOT}" "$GATE_EXIT_NO_VERDICT"

printf 'gate-dispatch: %s' "$OID" >&2
if [ -n "$PRIMARY_SERVER" ]; then
  printf ', primary %s(%s)' "$PRIMARY_SERVER" "${#PRIMARY_SLOTS[@]}" >&2
else
  printf ', no remote worker' >&2
fi
[ -n "$FALLBACK_SERVER" ] && printf ', fallback %s(1)' "$FALLBACK_SERVER" >&2
[ "$ALLOW_LOCAL" -eq 1 ] && printf ', local(%s, explicit)' "$LOCAL_SLOT_COUNT_NUM" >&2
printf ', poll %ss, timeout %smin, slot root %s (from %s)\n' \
  "$POLL_SECONDS" "$TIMEOUT_MINUTES" "$SLOT_ROOT" "$SLOT_ROOT_SOURCE" >&2
printf 'gate-dispatch: baseline %s%s\n' "$MASTER_OID" "${DEFAULT_REF:+ (${DEFAULT_REF})}" >&2

# --- dispatch ----------------------------------------------------------------

LOCAL_OUTPUT=""
LOCAL_STATUS="$GATE_EXIT_NO_VERDICT"
run_local() {
  printf 'gate-dispatch: running in the local slot\n' >&2
  LOCAL_OUTPUT="$(cd "$REPO_ROOT" && bash scripts/merge-gate.sh --expect-head "$OID" --master "$MASTER_OID")"
  LOCAL_STATUS=$?
}

REMOTE_OUTPUT=""
REMOTE_STATUS="$GATE_EXIT_NO_VERDICT"
PRIMARY_CAPACITY_WARNED=0
run_remote() {
  local label="$1" server="$2" worker_capacity=""
  printf 'gate-dispatch: running on %s (%s)\n' "$label" "$server" >&2
  # The push and the gate share the slot: a push racing another dispatch's gate
  # is safe (the worker's worktrees are per-run and detached), but the slot is
  # what meters how much of the worker one dispatch may occupy, and the push is
  # part of the occupancy.
  #
  # A push that fails is not a gate that failed. Nothing was run on the worker,
  # so there is no verdict to report and 76 says exactly that; returning the
  # gate's FAIL code here would have dressed a transport or mirror problem up as
  # a judgement about the commit.
  AGENTOS_GATE_SERVER='' bash "${SCRIPT_DIR}/mirror-push.sh" "$server" \
    --candidate "$OID" --baseline "$MASTER_OID" >&2 || {
    printf 'gate-dispatch: mirror-push failed; no gate was run and no verdict exists\n' >&2
    REMOTE_OUTPUT=""
    REMOTE_STATUS="$GATE_EXIT_NO_VERDICT"
    return 0
  }
  REMOTE_OUTPUT="$(AGENTOS_GATE_SERVER='' bash "${SCRIPT_DIR}/remote-gate.sh" "$server" "$OID" --master "$MASTER_OID")"
  REMOTE_STATUS=$?

  # The dispatcher's primary slot count and the worker's own worker-capacity are
  # two copies of one number kept in two places, and drift between them has no
  # symptom of its own: the extra dispatch simply waits on the worker's execution
  # lock until somebody wonders why an ssh session is doing nothing. The worker
  # states its capacity in the output already transported here, so say it once
  # where both numbers are known. Nothing acts on it; a worker that says nothing
  # is an older worker or an attempt that never arrived, and is not news.
  if [ "$label" = primary ] && [ "$PRIMARY_CAPACITY_WARNED" -eq 0 ]; then
    worker_capacity="$(printf '%s\n' "$REMOTE_OUTPUT" \
      | sed -n 's/.*run-gate: worker capacity \([0-9][0-9]*\).*/\1/p' | head -n 1)"
    if [ -n "$worker_capacity" ] && [ "$worker_capacity" -ne "${#PRIMARY_SLOTS[@]}" ] 2>/dev/null; then
      PRIMARY_CAPACITY_WARNED=1
      printf 'gate-dispatch: warning — the primary worker reports worker-capacity %s but this dispatcher configures %s primary slot(s); one of the two is wrong\n' \
        "$worker_capacity" "${#PRIMARY_SLOTS[@]}" >&2
    fi
  fi
  return 0
}

no_verdict() {
  printf 'gate-dispatch: %s\n' "$1" >&2
  printf 'GATE NOT RUN: %s\n' "$2"
  exit "$GATE_EXIT_NO_VERDICT"
}

WAIT_STARTED="$(date +%s)"
# The timeout measures stagnation, not patience: it runs from the last time the
# queue was seen to move, which at the start is the moment the wait began.
DEADLINE=$(( WAIT_STARTED + TIMEOUT_MINUTES * 60 ))
# Turnover restarts the stagnation timeout, but taking a slot is an unordered
# race for a hard link, not a place in a line: a dispatch whose poll always
# lands after someone else's can watch the queue move and never be admitted. The
# wait therefore also has an absolute ceiling of twice the stagnation timeout,
# which covers a queue several times deeper than the one that broke (about ten
# gates at 5-8 minutes) and still ends in the capacity signal instead of waiting
# out the caller's whole budget with nothing to show for it.
MAX_WAIT_MINUTES=$(( TIMEOUT_MINUTES * 2 ))
HARD_DEADLINE=$(( WAIT_STARTED + MAX_WAIT_MINUTES * 60 ))
# The pids seen holding each busy slot on the previous poll, as `slot:pid`
# words. Only slots present in both polls are compared: a slot that appears
# (fallback becoming eligible when its grace elapses) or disappears from the
# observation is a change in what this dispatch is allowed to look at, not a
# gate that ended.
PREV_HOLDERS=""
FIRST=1
# Survives the rounds: once a slot's lock has been seen broken, a later 75 would
# be a lie even if that round happened to find only busy slots.
BROKEN_EVER=""
UNAVAILABLE_EVER=""
LOCAL_DISABLED=0
PRIMARY_DISABLED=0
FALLBACK_DISABLED=0
FALLBACK_ANNOUNCED=0
if [ -z "$PRIMARY_SERVER" ] && ! local_eligible; then
  no_verdict \
    "explicitly enabled local slot is ineligible (worktree not clean at ${OID:0:12})" \
    "the explicitly enabled local gate is ineligible"
fi
while :; do
  # Per round, because "busy" is a fact with a shelf life. round_busy counts the
  # slots that could have been taken and were not; round_broken the ones whose
  # lock could not be operated. Waiting is only justified while round_busy > 0:
  # a busy slot frees when its gate ends, a broken one does not free at all.
  primary_busy=0
  fallback_held=0
  primary_fully_busy=0
  round_busy=0
  round_broken=""
  round_holders=""

  # The local machine is never used automatically. Opting in makes its slots
  # the first capacity tried for this invocation only.
  if [ "$ALLOW_LOCAL" -eq 1 ] && [ "$LOCAL_DISABLED" -eq 0 ] && local_eligible; then
    for local_slot in "${LOCAL_SLOTS[@]}"; do
      outcome=0
      try_slot "$local_slot" || outcome=$?
      case "$outcome" in
        0)
          run_local
          if gate_verdict_is_judgement "$LOCAL_STATUS"; then
            [ -n "$LOCAL_OUTPUT" ] && printf '%s\n' "$LOCAL_OUTPUT"
            exit "$LOCAL_STATUS"
          fi
          printf 'gate-dispatch: local produced no verdict (exit %s); retiring local capacity and trying remaining capacity\n' "$LOCAL_STATUS" >&2
          [ -n "$LOCAL_OUTPUT" ] && printf 'gate-dispatch: local said: %s\n' "$LOCAL_OUTPUT" >&2
          release_slot
          LOCAL_DISABLED=1
          UNAVAILABLE_EVER="${UNAVAILABLE_EVER} local"
          break
          ;;
        1)
          round_busy=$(( round_busy + 1 ))
          round_holders="${round_holders} ${local_slot}:$(gate_slot_holder "$SLOT_ROOT" "$local_slot")"
          ;;
        *) round_broken="${round_broken} ${local_slot}" ;;
      esac
    done
  fi

  if [ -n "$PRIMARY_SERVER" ] && [ "$PRIMARY_DISABLED" -eq 0 ]; then
    for primary_slot in "${PRIMARY_SLOTS[@]}"; do
      outcome=0
      try_slot "$primary_slot" || outcome=$?
      case "$outcome" in
        0)
          run_remote primary "$PRIMARY_SERVER"
          if gate_verdict_is_judgement "$REMOTE_STATUS"; then
            [ -n "$REMOTE_OUTPUT" ] && printf '%s\n' "$REMOTE_OUTPUT"
            exit "$REMOTE_STATUS"
          fi
          printf 'gate-dispatch: primary produced no verdict (exit %s); trying fallback capacity\n' "$REMOTE_STATUS" >&2
          [ -n "$REMOTE_OUTPUT" ] && printf 'gate-dispatch: primary said: %s\n' "$REMOTE_OUTPUT" >&2
          release_slot
          PRIMARY_DISABLED=1
          UNAVAILABLE_EVER="${UNAVAILABLE_EVER} primary"
          break
          ;;
        1)
          round_busy=$(( round_busy + 1 )); primary_busy=$(( primary_busy + 1 ))
          round_holders="${round_holders} ${primary_slot}:$(gate_slot_holder "$SLOT_ROOT" "$primary_slot")"
          ;;
        *) round_broken="${round_broken} ${primary_slot}" ;;
      esac
    done
  fi

  if [ "$primary_busy" -eq "${#PRIMARY_SLOTS[@]}" ]; then
    primary_fully_busy=1
  fi
  if [ -n "$FALLBACK_SERVER" ] && [ "$FALLBACK_DISABLED" -eq 0 ]; then
    waited_seconds=$(( $(date +%s) - WAIT_STARTED ))
    if [ "$primary_fully_busy" -eq 1 ] \
      && [ "$waited_seconds" -lt "$(( FALLBACK_AFTER_MINUTES * 60 ))" ]; then
      fallback_held=1
    fi
  fi

  outcome=0
  if [ -n "$FALLBACK_SERVER" ] && [ "$FALLBACK_DISABLED" -eq 0 ] && [ "$fallback_held" -eq 0 ]; then
    if [ "$primary_fully_busy" -eq 1 ] && [ "$FALLBACK_ANNOUNCED" -eq 0 ]; then
      printf 'gate-dispatch: trying fallback capacity (fallback after %s min; waited %s min)\n' \
        "$FALLBACK_AFTER_MINUTES" "$(( waited_seconds / 60 ))" >&2
      FALLBACK_ANNOUNCED=1
    fi
    try_slot remote-2 || outcome=$?
    case "$outcome" in
      0)
        run_remote fallback "$FALLBACK_SERVER"
        if gate_verdict_is_judgement "$REMOTE_STATUS"; then
          [ -n "$REMOTE_OUTPUT" ] && printf '%s\n' "$REMOTE_OUTPUT"
          exit "$REMOTE_STATUS"
        fi
        printf 'gate-dispatch: fallback produced no verdict (exit %s)\n' "$REMOTE_STATUS" >&2
        [ -n "$REMOTE_OUTPUT" ] && printf 'gate-dispatch: fallback said: %s\n' "$REMOTE_OUTPUT" >&2
        release_slot
        FALLBACK_DISABLED=1
        UNAVAILABLE_EVER="${UNAVAILABLE_EVER} remote-2"
        ;;
      1)
        round_busy=$(( round_busy + 1 ))
        round_holders="${round_holders} remote-2:$(gate_slot_holder "$SLOT_ROOT" remote-2)"
        ;;
      *) round_broken="${round_broken} remote-2" ;;
    esac
  fi

  # Union, not concatenation: a slot that is broken stays broken every round, and
  # an hour of polling would otherwise build a message naming it 120 times.
  for slot in $round_broken; do
    case " ${BROKEN_EVER} " in
      *" ${slot} "*) ;;
      *) BROKEN_EVER="${BROKEN_EVER} ${slot}" ;;
    esac
  done

  # Nothing to wait for: every slot this dispatch could have used has a lock that
  # does not work. Polling would only repeat the same failure until the timeout
  # and then report a full queue that never existed.
  if [ "$round_busy" -eq 0 ] && { [ -n "$round_broken" ] || [ -n "$UNAVAILABLE_EVER" ]; }; then
    no_verdict \
      "no remaining worker could produce a verdict; unavailable:${UNAVAILABLE_EVER:- none}; broken:${round_broken:- none}" \
      "no configured worker produced a verdict"
  fi

  # Turnover: a slot this dispatch was already watching is now held by a
  # different pid, so a gate that was holding a slot ended and the queue is
  # moving. That is the queue the caller asked to wait in, so the stagnation
  # timeout starts again from here, up to the absolute ceiling. Slots that were
  # not in the previous observation are not compared: their absence was this
  # dispatcher's own rule, not a busy gate.
  now="$(date +%s)"
  turned_over=""
  for entry in $round_holders; do
    slot="${entry%%:*}"
    case " ${PREV_HOLDERS} " in
      *" ${entry} "*) ;;
      *" ${slot}:"*) turned_over="${turned_over} ${slot}" ;;
    esac
  done
  PREV_HOLDERS="$round_holders"
  if [ -n "$turned_over" ]; then
    if [ "$DEADLINE" -lt "$HARD_DEADLINE" ]; then
      DEADLINE=$(( now + TIMEOUT_MINUTES * 60 ))
      [ "$DEADLINE" -gt "$HARD_DEADLINE" ] && DEADLINE="$HARD_DEADLINE"
    fi
    printf 'gate-dispatch: the queue moved (slot%s changed hands); waited %s min, waiting until %s\n' \
      "$turned_over" "$(( (now - WAIT_STARTED) / 60 ))" \
      "$(date -r "$DEADLINE" '+%H:%M:%S' 2>/dev/null || date -d "@${DEADLINE}" '+%H:%M:%S')" >&2
  fi
  if [ "$now" -ge "$DEADLINE" ]; then
    waited_minutes=$(( (now - WAIT_STARTED) / 60 ))
    # A slot seen broken at any point during the wait means the timeout is not
    # the whole story, and 75 — "the queue stayed full" — would send the caller
    # to re-dispatch into the same broken lock.
    if [ -n "$BROKEN_EVER$UNAVAILABLE_EVER" ]; then
      no_verdict \
        "waited ${waited_minutes} minutes with slots busy and none of them coming free for this dispatch; unavailable:${UNAVAILABLE_EVER:- none}; broken:${BROKEN_EVER:- none}" \
        "no configured worker produced a verdict"
    fi
    if [ "$now" -ge "$HARD_DEADLINE" ]; then
      printf 'gate-dispatch: no slot came free for this dispatch in %s minutes, the ceiling on a wait even in a moving queue; nothing ran and no verdict exists\n' \
        "$MAX_WAIT_MINUTES" >&2
    else
      printf 'gate-dispatch: no slot freed up or changed hands in %s minutes (waited %s min in total); nothing ran and no verdict exists\n' \
        "$TIMEOUT_MINUTES" "$waited_minutes" >&2
    fi
    printf 'GATE DISPATCH: NO SLOT\n'
    exit "$EXIT_NO_SLOT"
  fi
  log_wait="$FIRST"
  if [ "$FIRST" -eq 1 ]; then
    FIRST=0
    if [ "$ALLOW_LOCAL" -eq 1 ] && ! local_eligible; then
      printf 'gate-dispatch: explicitly enabled local slot is ineligible (worktree not clean at %s)\n' "${OID:0:12}" >&2
    fi
    if [ -n "$round_broken" ]; then
      printf 'gate-dispatch: the locks of%s are unusable; waiting on the %s slot(s) that are merely busy\n' \
        "$round_broken" "$round_busy" >&2
    fi
  fi
  if [ "$log_wait" -eq 1 ]; then
    fallback_wait=""
    if [ "$fallback_held" -eq 1 ]; then
      fallback_wait="; fallback after ${FALLBACK_AFTER_MINUTES} min; waited $(( waited_seconds / 60 )) min"
    fi
    printf 'gate-dispatch: %s slot(s) busy, polling every %ss until %s unless a slot changes hands%s\n' \
      "$round_busy" "$POLL_SECONDS" \
      "$(date -r "$DEADLINE" '+%H:%M:%S' 2>/dev/null || date -d "@${DEADLINE}" '+%H:%M:%S')" "$fallback_wait" >&2
  fi
  sleep "$POLL_SECONDS"
done
