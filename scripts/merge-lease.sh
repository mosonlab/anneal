#!/usr/bin/env bash
#
# Serialize the final merge window through one ref on origin:
#
#   scripts/merge-lease.sh acquire --reason "Merge PR #123" --task task-id
#   scripts/merge-lease.sh status
#   scripts/merge-lease.sh release --task task-id
#   scripts/merge-lease.sh steal --reason "Recover abandoned merge" [--human]
#
# Writing code and pushing a feature branch do not need this lease. Hold it only
# while integrating the latest main, proving the exact candidate, and advancing
# main. There is deliberately no heartbeat: a steal waits 45 minutes unless the
# caller passes --human, which is the operator saying so in the argv rather than
# a property of the terminal they happen to be typing into. Release removes only
# a lease you hold; breaking somebody else's lease requires steal. Acquire and
# release need --task because the default holder is user@host, which every agent
# window on one machine shares: without a task only the machine is identified,
# so one window would release another window's lease. Use --force to fall back
# to the holder check when the acquiring task id is genuinely unknown.
set -uo pipefail

LEASE_REF="refs/merge-lease/holder"
POLL_SECONDS="${MERGE_LEASE_POLL_SECONDS:-30}"
TIMEOUT_MINUTES="${MERGE_LEASE_TIMEOUT_MINUTES:-60}"
STALE_SECONDS=$((45 * 60))
EXIT_TIMEOUT=75

COMMAND="${1:-}"
[ $# -eq 0 ] || shift
REASON=""
TASK=""
HUMAN=0
FORCE=0
HOLDER="${MERGE_LEASE_HOLDER:-}"

usage() {
  sed -n '2,18p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'
  exit "${1:-0}"
}

die() {
  printf 'merge-lease: %s\n' "$1" >&2
  exit "${2:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --reason)
      [ $# -ge 2 ] || die "--reason needs a value" 2
      REASON="$2"
      shift ;;
    --reason=*) REASON="${1#--reason=}" ;;
    --task)
      [ $# -ge 2 ] || die "--task needs a value" 2
      TASK="$2"
      shift ;;
    --task=*) TASK="${1#--task=}" ;;
    --holder)
      [ $# -ge 2 ] || die "--holder needs a value" 2
      HOLDER="$2"
      shift ;;
    --holder=*) HOLDER="${1#--holder=}" ;;
    --poll-seconds)
      [ $# -ge 2 ] || die "--poll-seconds needs a number" 2
      POLL_SECONDS="$2"
      shift ;;
    --poll-seconds=*) POLL_SECONDS="${1#--poll-seconds=}" ;;
    --timeout-minutes)
      [ $# -ge 2 ] || die "--timeout-minutes needs a number" 2
      TIMEOUT_MINUTES="$2"
      shift ;;
    --timeout-minutes=*) TIMEOUT_MINUTES="${1#--timeout-minutes=}" ;;
    --human) HUMAN=1 ;;
    --force) FORCE=1 ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
  shift
done

case "$COMMAND" in
  acquire|release|status|steal) ;;
  -h|--help) usage 0 ;;
  "") usage 2 ;;
  *) die "unknown command: $COMMAND" 2 ;;
esac
case "$POLL_SECONDS" in ''|*[!0-9]*|0) die "--poll-seconds needs a positive number, got: $POLL_SECONDS" 2 ;; esac
case "$TIMEOUT_MINUTES" in ''|*[!0-9]*) die "--timeout-minutes needs a number, got: $TIMEOUT_MINUTES" 2 ;; esac
case "$HUMAN" in 0|1) ;; *) die "--human is invalid" 2 ;; esac
case "$FORCE" in 0|1) ;; *) die "--force is invalid" 2 ;; esac
if [ "$COMMAND" = "acquire" ] || [ "$COMMAND" = "steal" ]; then
  [ -n "$REASON" ] || die "$COMMAND requires --reason" 2
fi
if [ "$COMMAND" = "acquire" ] && [ -z "$TASK" ]; then
  die "acquire requires --task" 2
fi
if [ "$COMMAND" != "steal" ] && [ "$HUMAN" -eq 1 ]; then
  die "--human is valid only with steal" 2
fi
if [ "$COMMAND" != "release" ] && [ "$FORCE" -eq 1 ]; then
  die "--force is valid only with release" 2
fi
if [ "$COMMAND" = "release" ] && [ -z "$TASK" ] && [ "$FORCE" -ne 1 ]; then
  die "release requires --task; pass --force to release by holder instead" 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [ -n "${AGENTOS_REPOSITORY_ROOT:-}" ]; then
  REPO_ROOT="$(cd "${AGENTOS_REPOSITORY_ROOT}" && pwd -P)" \
    || die "${AGENTOS_REPOSITORY_ROOT} is not an accessible repository root"
else
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
fi
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 \
  || die "${REPO_ROOT} is not a git repository"
git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1 \
  || die "${REPO_ROOT} has no origin remote"

if [ -z "$HOLDER" ]; then
  holder_user="$(id -un 2>/dev/null)" || die "could not determine the current user"
  holder_host="$(hostname -s 2>/dev/null || hostname 2>/dev/null)" \
    || die "could not determine the current host"
  HOLDER="${holder_user}@${holder_host}"
fi

GIT_ATTEMPTS=6

# The transient half of packages/runner/src/network-retry.ts, in the vocabulary
# git writes. Only a match is retried: an authentication failure, an absent ref
# or an unreadable remote is the remote's answer, and spending the backoff
# budget on it only delays a failure the operator still has to read.
GIT_TRANSIENT_RE='SSL_ERROR_SYSCALL|SSL_connect|unexpected EOF|early EOF|RPC failed|Connection (reset|refused|timed out)|Operation timed out|Failed to connect|Could not resolve host|Recv failure|ECONNRESET|ETIMEDOUT|EAI_AGAIN|HTTP( response)? 5[0-9][0-9]'

# Exponential backoff with full jitter, capped per attempt, matching the clone
# profile in network-retry.ts and the fetch budget in
# packages/runner/runtime-tools/regression-verification.sh. This host reaches
# GitHub through a proxy whose 443 exit drops for seconds at a time: 24 probes
# on 2026-09-02 failed 5 times in clusters up to 5 consecutive failures, so the
# previous budget (3 attempts, 1s apart, ~3s total) fell inside a single drop as
# a matter of course rather than as an edge case. Waiting up to 1s,2s,4s,8s,8s
# (~23s worst case) rides one out. Release is what makes the budget worth
# spending: a failed status, acquire or steal changes nothing and can simply be
# rerun, while a failed release strands the lease on origin until the 45-minute
# machine steal threshold expires.
git_backoff() {
  local ceiling=$(( 1 << (($1 < 4 ? $1 : 4) - 1) ))
  sleep "$(awk -v ceiling="$ceiling" 'BEGIN { srand(); printf "%.2f", rand() * ceiling }')"
}

RETRY_OUTPUT=""
retry_git() {
  local label="$1" attempt status
  shift
  for attempt in $(seq 1 "$GIT_ATTEMPTS"); do
    RETRY_OUTPUT="$(GIT_TERMINAL_PROMPT=0 "$@" 2>&1)"
    status=$?
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$attempt" -lt "$GIT_ATTEMPTS" ] && [[ "$RETRY_OUTPUT" =~ $GIT_TRANSIENT_RE ]]; then
      printf 'merge-lease: %s failed; retrying attempt=%s/%s\n' \
        "$label" "$((attempt + 1))" "$GIT_ATTEMPTS" >&2
      git_backoff "$attempt"
      continue
    fi
    break
  done
  [ -z "$RETRY_OUTPUT" ] || printf '%s\n' "$RETRY_OUTPUT" >&2
  return "$status"
}

REMOTE_SHA=""
read_remote_sha() {
  retry_git "origin lease read" git -C "$REPO_ROOT" ls-remote --refs origin "$LEASE_REF" \
    || return 1
  REMOTE_SHA="$(printf '%s\n' "$RETRY_OUTPUT" | awk -v ref="$LEASE_REF" '$2 == ref {print $1; exit}')"
  if [ -n "$REMOTE_SHA" ]; then
    case "$REMOTE_SHA" in *[!0-9a-f]*) return 1 ;; esac
    [ "${#REMOTE_SHA}" -eq 40 ] || return 1
  fi
}

LEASE_JSON=""
LEASE_HOLDER=""
LEASE_TASK=""
LEASE_ACQUIRED_AT=""
LEASE_ACQUIRED_EPOCH=""
LEASE_REASON=""
LEASE_TOKEN=""
LEASE_PRETTY=""
# The only place that has the lease blob in its hand, and therefore the only
# place that knows the lease is JSON. It validates and explodes the blob in one
# parse; every command below reads shell variables. Seven node invocations used
# to restate the same stdin-collecting preamble to pull out one field each, and
# the same field read in three of them was one rule stated three times.
load_lease() {
  local fields status
  LEASE_JSON=""
  LEASE_HOLDER=""
  LEASE_TASK=""
  LEASE_ACQUIRED_AT=""
  LEASE_ACQUIRED_EPOCH=""
  LEASE_REASON=""
  LEASE_TOKEN=""
  LEASE_PRETTY=""
  read_remote_sha || die "could not read ${LEASE_REF} from origin"
  [ -n "$REMOTE_SHA" ] || return 0
  if ! git -C "$REPO_ROOT" cat-file -e "${REMOTE_SHA}^{blob}" 2>/dev/null; then
    retry_git "origin lease fetch" git -C "$REPO_ROOT" fetch --no-tags --no-write-fetch-head origin "$LEASE_REF" \
      || die "could not fetch ${LEASE_REF} from origin"
  fi
  LEASE_JSON="$(git -C "$REPO_ROOT" cat-file blob "$REMOTE_SHA" 2>/dev/null)" \
    || die "origin lease ${REMOTE_SHA} is not a readable blob"
  fields="$(mktemp "${TMPDIR:-/tmp}/merge-lease.XXXXXX")" \
    || die "could not create a temporary file for the lease fields"
  # NUL separates the records because --reason carries whatever the caller gave
  # it, newlines included, and the pretty form is newline-formatted by
  # construction. A command substitution would drop the NULs, so this goes
  # through a file that also keeps node's exit status readable.
  printf '%s' "$LEASE_JSON" | node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      let lease;
      try { lease = JSON.parse(body); } catch { process.exit(1); }
      if (!lease || typeof lease !== "object" || Array.isArray(lease)
          || typeof lease.holder !== "string" || lease.holder.length === 0
          || typeof lease.acquiredAt !== "string" || Number.isNaN(Date.parse(lease.acquiredAt))
          || typeof lease.reason !== "string" || lease.reason.length === 0) process.exit(1);
      const optional = (value) => (typeof value === "string" ? value : "");
      process.stdout.write([
        lease.holder,
        optional(lease.task),
        lease.acquiredAt,
        String(Math.floor(Date.parse(lease.acquiredAt) / 1000)),
        lease.reason,
        optional(lease.token),
        JSON.stringify(lease, null, 2),
      ].join("\u0000") + "\u0000");
    });
  ' >"$fields"
  status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$fields"
    die "origin lease ${REMOTE_SHA} contains invalid JSON"
  fi
  {
    IFS= read -r -d '' LEASE_HOLDER
    IFS= read -r -d '' LEASE_TASK
    IFS= read -r -d '' LEASE_ACQUIRED_AT
    IFS= read -r -d '' LEASE_ACQUIRED_EPOCH
    IFS= read -r -d '' LEASE_REASON
    IFS= read -r -d '' LEASE_TOKEN
    IFS= read -r -d '' LEASE_PRETTY
  } <"$fields"
  rm -f "$fields"
}

NEW_SHA=""
make_lease_blob() {
  local stolen_json="${1:-}" acquired_at token
  acquired_at="$(node -e 'process.stdout.write(new Date().toISOString())')" \
    || die "could not create an acquisition timestamp"
  # A bare UUID matches GitHub's legacy npm-token detector and makes the lease
  # ref impossible to create when Push Protection is enabled. Keep the same
  # 128 bits of uniqueness without embedding a UUID-shaped substring.
  token="$(node -e 'process.stdout.write(`merge-lease-v1-${require("node:crypto").randomBytes(16).toString("hex")}`)')" \
    || die "could not create a lease token"
  NEW_SHA="$(node -e '
    const [holder, task, acquiredAt, reason, token, stolen] = process.argv.slice(1);
    const lease = { holder, acquiredAt, reason, token };
    if (task) lease.task = task;
    const withoutHistoricalTokens = (value) => {
      if (Array.isArray(value)) return value.map(withoutHistoricalTokens);
      if (typeof value !== "object" || value === null) return value;
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key.toLowerCase() !== "token")
        .map(([key, nested]) => [key, withoutHistoricalTokens(nested)]));
    };
    if (stolen) lease.stolenFrom = withoutHistoricalTokens(JSON.parse(stolen));
    process.stdout.write(JSON.stringify(lease) + "\n");
  ' "$HOLDER" "$TASK" "$acquired_at" "$REASON" "$token" "$stolen_json" \
    | git -C "$REPO_ROOT" hash-object -w --stdin)" \
    || die "could not create the lease object"
}

# Return 0 when this object owns the ref, 1 when another holder won, and 2 for
# an operational failure. A unique token makes an ambiguous successful push
# distinguishable from somebody else's lease.
try_create_lease() {
  local attempt status push_output
  for attempt in $(seq 1 "$GIT_ATTEMPTS"); do
    push_output="$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" push --porcelain origin "${NEW_SHA}:${LEASE_REF}" 2>&1)"
    status=$?
    read_remote_sha || return 2
    if [ "$REMOTE_SHA" = "$NEW_SHA" ]; then
      return 0
    fi
    if [ -n "$REMOTE_SHA" ]; then
      return 1
    fi
    if [ "$status" -eq 0 ]; then
      printf 'merge-lease: push reported success but %s is absent\n' "$LEASE_REF" >&2
      return 2
    fi
    if [ "$attempt" -lt "$GIT_ATTEMPTS" ] && [[ "$push_output" =~ $GIT_TRANSIENT_RE ]]; then
      printf 'merge-lease: lease create push failed; retrying attempt=%s/%s\n' \
        "$((attempt + 1))" "$GIT_ATTEMPTS" >&2
      git_backoff "$attempt"
      continue
    fi
    break
  done
  [ -z "$push_output" ] || printf '%s\n' "$push_output" >&2
  return 2
}

replace_lease() {
  local observed_sha="$1" attempt status push_output
  for attempt in $(seq 1 "$GIT_ATTEMPTS"); do
    push_output="$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" push --porcelain \
      --force-with-lease="${LEASE_REF}:${observed_sha}" origin "${NEW_SHA}:${LEASE_REF}" 2>&1)"
    status=$?
    read_remote_sha || die "could not verify ${LEASE_REF} after the steal push"
    [ "$REMOTE_SHA" = "$NEW_SHA" ] && return 0
    if [ "$REMOTE_SHA" != "$observed_sha" ]; then
      die "lease changed while steal was in progress; compare-and-swap refused"
    fi
    if [ "$status" -eq 0 ]; then
      die "steal push reported success but the observed lease did not change"
    fi
    if [ "$attempt" -lt "$GIT_ATTEMPTS" ] && [[ "$push_output" =~ $GIT_TRANSIENT_RE ]]; then
      printf 'merge-lease: lease steal push failed; retrying attempt=%s/%s\n' \
        "$((attempt + 1))" "$GIT_ATTEMPTS" >&2
      git_backoff "$attempt"
      continue
    fi
    break
  done
  [ -z "$push_output" ] || printf '%s\n' "$push_output" >&2
  die "could not steal the lease"
}

delete_lease() {
  local observed_sha="$1" attempt status push_output
  for attempt in $(seq 1 "$GIT_ATTEMPTS"); do
    push_output="$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" push --porcelain \
      --force-with-lease="${LEASE_REF}:${observed_sha}" origin ":${LEASE_REF}" 2>&1)"
    status=$?
    read_remote_sha || die "could not verify ${LEASE_REF} after the release push"
    [ -z "$REMOTE_SHA" ] && return 0
    if [ "$REMOTE_SHA" != "$observed_sha" ]; then
      die "lease changed while release was in progress; compare-and-swap refused"
    fi
    if [ "$status" -eq 0 ]; then
      die "release push reported success but the observed lease remains"
    fi
    if [ "$attempt" -lt "$GIT_ATTEMPTS" ] && [[ "$push_output" =~ $GIT_TRANSIENT_RE ]]; then
      printf 'merge-lease: lease release push failed; retrying attempt=%s/%s\n' \
        "$((attempt + 1))" "$GIT_ATTEMPTS" >&2
      git_backoff "$attempt"
      continue
    fi
    break
  done
  [ -z "$push_output" ] || printf '%s\n' "$push_output" >&2
  die "could not release the lease"
}

# One release, two readers. The operator reads the prose; the merge tail, in
# packages/api/src/merge-lease.ts, reads the MERGE LEASE line beside it, because
# released, not-held, skipped and refused used to be indistinguishable to it --
# three of them exit 0, and a lease left standing for another task looked exactly
# like a lease it had freed. Both lines are printed here so neither can drift
# from the other. The prose is contract: scripts/merge-lease.test.mjs asserts it,
# and refused still leaves through die, so its exit code is unchanged too.
release_outcome() {
  case "$1" in
    released)
      printf 'merge-lease: released %s (%s)\nMERGE LEASE: released %s %s %s\n' \
        "$LEASE_REF" "$2" "$LEASE_REF" "$2" "$LEASE_ACQUIRED_AT" ;;
    not-held)
      printf 'merge-lease: no lease held\nMERGE LEASE: not-held\n' ;;
    skipped)
      printf 'merge-lease: release skipped; %s is held for task %s, not %s\nMERGE LEASE: skipped %s\n' \
        "$LEASE_REF" "$2" "$3" "$2" ;;
    refused)
      printf 'MERGE LEASE: refused %s\n' "$2" >&2
      die "release refused: ${LEASE_REF} is held by ${2}, not ${HOLDER}; use steal to break it" ;;
    *) die "unknown release outcome: $1" ;;
  esac
}

# The holder in one line, for a reader that is not a person. `status` prints the
# pretty blob for the operator and `acquire` prints prose about waiting; neither
# says who holds the lease in a form the control plane can parse, which is why a
# contended readiness tick used to report nothing but the fact of contention.
# The fields come from load_lease rather than from the raw blob so the line is
# single-line JSON whatever formatting the blob on origin happens to carry.
holder_machine_line() {
  local rendered
  rendered="$(node -e '
    const [holder, task, acquiredAt, reason, sha] = process.argv.slice(1);
    const lease = { holder, acquiredAt, reason, sha };
    if (task) lease.task = task;
    process.stdout.write(JSON.stringify(lease));
  ' "$LEASE_HOLDER" "$LEASE_TASK" "$LEASE_ACQUIRED_AT" "$LEASE_REASON" "$REMOTE_SHA")" \
    || return 1
  printf 'MERGE LEASE HOLDER: %s\n' "$rendered" >&2
}

case "$COMMAND" in
  status)
    load_lease
    if [ -z "$REMOTE_SHA" ]; then
      printf 'merge-lease: no lease held\n'
      printf 'MERGE LEASE HOLDER: none\n' >&2
    else
      # stdout stays the lease blob and nothing else: `status | jq` is how an
      # operator reads it. The machine line goes to stderr beside it.
      printf '%s\n' "$LEASE_PRETTY"
      holder_machine_line || die "could not render the lease holder line"
    fi
    ;;
  acquire)
    deadline=$(( $(date +%s) + TIMEOUT_MINUTES * 60 ))
    while :; do
      # Re-stamp before every attempt. acquiredAt is what the 45-minute machine
      # steal threshold measures, so a blob built once at the top of the queue
      # would hand the winner a protection window already shortened by however
      # long it waited -- and past 45 minutes of queueing, a lease stealable the
      # instant it is won.
      make_lease_blob
      create_status=0
      try_create_lease || create_status=$?
      case "$create_status" in
        0)
          printf 'merge-lease: acquired %s (%s)\n' "$LEASE_REF" "$NEW_SHA"
          exit 0 ;;
        1)
          load_lease
          if [ -n "$TASK" ] && [ -n "$REMOTE_SHA" ]; then
            if [ "$LEASE_TASK" = "$TASK" ]; then
              printf 'merge-lease: already held for task %s (%s)\n' "$TASK" "$REMOTE_SHA"
              exit 0
            fi
          fi ;;
        *) die "could not create ${LEASE_REF}" ;;
      esac
      if [ "$(date +%s)" -ge "$deadline" ]; then
        printf 'merge-lease: timed out waiting for %s after %s minute(s)\n' "$LEASE_REF" "$TIMEOUT_MINUTES" >&2
        # Name the holder on the way out. Contention is the one acquire outcome
        # an operator cannot act on without knowing who is holding the lease.
        [ -z "$LEASE_JSON" ] || holder_machine_line || true
        exit "$EXIT_TIMEOUT"
      fi
      printf 'merge-lease: held by %s; polling again in %ss\n' "$REMOTE_SHA" "$POLL_SECONDS" >&2
      sleep "$POLL_SECONDS"
    done
    ;;
  release)
    load_lease
    if [ -z "$REMOTE_SHA" ]; then
      release_outcome not-held
      exit 0
    fi
    released_sha="$REMOTE_SHA"
    if [ -n "$TASK" ]; then
      if [ "$LEASE_TASK" != "$TASK" ]; then
        release_outcome skipped "${LEASE_TASK:-<none>}" "$TASK"
        exit 0
      fi
    else
      # --force only: the holder is user@host, which does not distinguish two
      # windows on one machine. The check still refuses another machine's lease.
      if [ "$LEASE_HOLDER" != "$HOLDER" ]; then
        release_outcome refused "$LEASE_HOLDER"
      fi
    fi
    delete_lease "$released_sha"
    release_outcome released "$released_sha"
    ;;
  steal)
    load_lease
    if [ -z "$REMOTE_SHA" ]; then
      make_lease_blob
      steal_create_status=0
      try_create_lease || steal_create_status=$?
      [ "$steal_create_status" -eq 0 ] \
        || die "lease appeared while steal was creating it; retry explicitly"
      printf 'merge-lease: acquired unheld %s (%s)\n' "$LEASE_REF" "$NEW_SHA"
      exit 0
    fi
    observed_sha="$REMOTE_SHA"
    observed_json="$LEASE_JSON"
    # Only --human waives the threshold. A terminal on any standard stream used
    # to stand in for a person, which made the 45-minute rule depend on how the
    # caller was launched rather than on what it claimed to be: an operator who
    # ran this interactively bypassed the machine rule without ever saying so,
    # and the same command in a pipeline did not. The flag is the claim.
    if [ "$HUMAN" -ne 1 ]; then
      age_seconds=$(( $(date +%s) - LEASE_ACQUIRED_EPOCH ))
      if [ "$age_seconds" -le "$STALE_SECONDS" ]; then
        die "machine steal refused: lease age ${age_seconds}s has not exceeded ${STALE_SECONDS}s; $(( STALE_SECONDS - age_seconds ))s remain, or pass --human to steal now"
      fi
    fi
    printf 'merge-lease: stealing lease from %s\n' "$observed_json" >&2
    make_lease_blob "$observed_json"
    replace_lease "$observed_sha"
    printf 'merge-lease: stole %s (%s)\n' "$LEASE_REF" "$NEW_SHA"
    ;;
esac
