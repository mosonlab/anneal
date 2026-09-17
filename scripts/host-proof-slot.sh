#!/usr/bin/env bash

# A host invocation is deliberately handled before this file inspects any
# argument or environment value other than the two admission switches.  npm
# already started this shell, so this path must not add a process, a stat, or a
# lock-file touch before replacing it with the requested command.

host_proof_slot_exec_child() {
  # The public contract is <script> <workspace> -- <command> [args...].  The
  # contract is valid on the fast path; shift is a shell builtin and exec is a
  # shell builtin, so the wrapper contributes no observable output here.
  shift 3
  exec "$@"
}

if [[ -z "${AGENTOS_RUN_ID:-}" ]]; then
  host_proof_slot_exec_child "$@"
fi

if [[ "${AGENTOS_RUN_SCOPE_BYPASS:-}" == "regression-verification" ]]; then
  # shellcheck source=packages/runner/runtime-tools/gate-worker/lib.sh
  . "${BASH_SOURCE[0]%/*}/../packages/runner/runtime-tools/gate-worker/lib.sh"
  if agentos_regression_bypass_is_authenticated; then
    host_proof_slot_exec_child "$@"
  fi
  agentos_regression_bypass_audit_refusal
fi

# These two functions are intentionally small source seams.  Bash's SECONDS is
# monotonic for the life of this shell, so a wall-clock correction cannot
# extend admission beyond the production bound.  The standalone test sources
# this file and replaces both seams without adding a production environment
# switch or dependency.
host_proof_slot_set_now() {
  HOST_PROOF_SLOT_NOW=$SECONDS
}

host_proof_slot_wait() {
  /bin/sleep 1
}

host_proof_slot_invalid() {
  local reason="$1"
  printf 'host-proof-slot: %s for workspace %s in Run %s cannot admit: %s\n' \
    "${script_name:-}" "${workspace_name:-}" "${AGENTOS_RUN_ID:-}" "$reason" >&2
  return 64
}

host_proof_slot_set_platform() {
  if [[ ! -x /usr/bin/uname ]]; then
    host_proof_slot_invalid "/usr/bin/uname is not executable"
    return $?
  fi
  HOST_PROOF_SLOT_PLATFORM="$(/usr/bin/uname -s)" || {
    host_proof_slot_invalid "/usr/bin/uname could not identify the platform"
    return $?
  }
}

host_proof_slot_select_lock_tool() {
  host_proof_slot_set_platform || return $?
  case "$HOST_PROOF_SLOT_PLATFORM" in
    Darwin)
      HOST_PROOF_SLOT_LOCK_TOOL=/usr/bin/lockf
      HOST_PROOF_SLOT_LOCK_ARGS=(-s -t 0 9)
      ;;
    Linux)
      HOST_PROOF_SLOT_LOCK_TOOL=/usr/bin/flock
      HOST_PROOF_SLOT_LOCK_ARGS=(-x -n -E 75 9)
      ;;
    *)
      host_proof_slot_invalid "platform $HOST_PROOF_SLOT_PLATFORM is not supported"
      return $?
      ;;
  esac
}

host_proof_slot_lock_tool_is_executable() {
  [[ -x "$HOST_PROOF_SLOT_LOCK_TOOL" ]]
}

host_proof_slot_try() {
  local slot_file="$1"
  shift
  HOST_PROOF_SLOT_ACQUIRED=0

  # Read-only opening is intentional: it cannot create a missing file.  The
  # daemon creates all persistent files before any Run can reach this code.
  # The descriptor remains open in this shell after the lock tool exits, which keeps
  # the kernel lock held while the complete child command runs. It is closed in
  # the child so a descendant cannot outlive the wrapper and pin the slot.
  if ! exec 9<"$slot_file"; then
    return 74
  fi

  "$HOST_PROOF_SLOT_LOCK_TOOL" "${HOST_PROOF_SLOT_LOCK_ARGS[@]}"
  local lock_status=$?
  if (( lock_status != 0 )); then
    exec 9<&-
    return "$lock_status"
  fi

  HOST_PROOF_SLOT_ACQUIRED=1
  host_proof_slot_report_admission || { exec 9<&-; return $?; }
  "$@" 9<&-
  local child_status=$?
  exec 9<&-
  # Bash represents a signal-terminated foreground command as 128+signal. The
  # wrapper has already released the slot, so re-raise that signal here rather
  # than turning it into an ordinary numeric exit.
  if (( child_status > 128 && child_status <= 192 )); then
    kill "-$((child_status - 128))" "$$"
  fi
  return "$child_status"
}

# A wait of at least 60 seconds is reported once while it is still going and
# again when the slot is admitted, so a host can measure its queue from Run
# output; anything shorter stays silent.
HOST_PROOF_SLOT_REPORT_AFTER_SECONDS=60

host_proof_slot_report_admission() {
  host_proof_slot_set_now || return $?
  local waited=$((HOST_PROOF_SLOT_NOW - start_seconds))
  if (( waited >= HOST_PROOF_SLOT_REPORT_AFTER_SECONDS )); then
    printf 'host-proof-slot: %s for workspace %s in Run %s admitted after %ss waiting in %s\n' \
      "$script_name" "$workspace_name" "$AGENTOS_RUN_ID" "$waited" "$slot_directory" >&2
  fi
  return 0
}

host_proof_slot_report_wait() {
  if (( waiting_reported != 0 )); then
    return 0
  fi
  host_proof_slot_set_now || return $?
  local waited=$((HOST_PROOF_SLOT_NOW - start_seconds))
  if (( waited >= HOST_PROOF_SLOT_REPORT_AFTER_SECONDS )); then
    waiting_reported=1
    printf 'host-proof-slot: %s for workspace %s in Run %s has waited %ss for a slot in %s\n' \
      "$script_name" "$workspace_name" "$AGENTOS_RUN_ID" "$waited" "$slot_directory" >&2
  fi
  return 0
}

host_proof_slot_check_deadline() {
  host_proof_slot_set_now
  local now_status=$?
  if (( now_status != 0 )); then
    return "$now_status"
  fi
  if (( HOST_PROOF_SLOT_NOW - start_seconds >= 1200 )); then
    printf 'host-proof-slot: %s for workspace %s in Run %s timed out after 1200s waiting in %s\n' \
      "$script_name" "$workspace_name" "$AGENTOS_RUN_ID" "$slot_directory" >&2
    return 75
  fi
  return 0
}

host_proof_slot_main() {
  local script_name="${1:-}"
  local workspace_name="${2:-}"
  local slot_directory="${AGENTOS_HOST_PROOF_SLOT_DIR:-}"
  local slot_count_raw="${AGENTOS_HOST_PROOF_SLOTS:-}"

  # Validate the invocation before any filesystem or tool work.  This path is
  # only reached when host or authenticated Regression fast paths did not exec
  # their child above.
  if (( $# < 4 )) || [[ "$3" != "--" || -z "$script_name" || -z "$workspace_name" || -z "${4:-}" ]]; then
    host_proof_slot_invalid "expected <script> <workspace> -- <command> [args...]"
    return $?
  fi
  if [[ -z "$slot_directory" ]]; then
    host_proof_slot_invalid "AGENTOS_HOST_PROOF_SLOT_DIR is required"
    return $?
  fi
  if [[ -z "$slot_count_raw" ]]; then
    host_proof_slot_invalid "AGENTOS_HOST_PROOF_SLOTS is required"
    return $?
  fi
  if [[ ! "$slot_count_raw" =~ ^[0-9]+$ ]]; then
    host_proof_slot_invalid "AGENTOS_HOST_PROOF_SLOTS must be a positive integer no greater than 1024"
    return $?
  fi

  # Bash treats numbers with a leading zero as octal in arithmetic contexts;
  # normalize those zeros while preserving the same decimal contract as the
  # runner's positiveInteger parser.
  local slot_count="$slot_count_raw"
  while [[ "$slot_count" == 0* && ${#slot_count} -gt 1 ]]; do
    slot_count="${slot_count#0}"
  done
  if [[ "$slot_count" == "0" || ${#slot_count} -gt 4 ]] || ! (( 10#$slot_count > 0 && 10#$slot_count <= 1024 )); then
    host_proof_slot_invalid "AGENTOS_HOST_PROOF_SLOTS must be a positive integer no greater than 1024"
    return $?
  fi

  if [[ ! -d "$slot_directory" || -L "$slot_directory" ]]; then
    host_proof_slot_invalid "slot directory $slot_directory is not a non-symlink directory"
    return $?
  fi
  host_proof_slot_select_lock_tool || return $?
  if ! host_proof_slot_lock_tool_is_executable; then
    host_proof_slot_invalid "$HOST_PROOF_SLOT_LOCK_TOOL is not executable"
    return $?
  fi
  if [[ ! -x /bin/sleep ]]; then
    host_proof_slot_invalid "/bin/sleep is not executable"
    return $?
  fi

  local slot_number=1
  local slot_file
  while (( slot_number <= 10#$slot_count )); do
    slot_file="${slot_directory}/slot-${slot_number}.lock"
    if [[ ! -f "$slot_file" || -L "$slot_file" ]]; then
      host_proof_slot_invalid "slot file $slot_file is not a non-symlink regular file"
      return $?
    fi
    slot_number=$((slot_number + 1))
  done

  shift 3
  local command_status
  local now_status
  local start_seconds
  host_proof_slot_set_now
  now_status=$?
  if (( now_status != 0 )); then
    return "$now_status"
  fi
  start_seconds="$HOST_PROOF_SLOT_NOW"
  local waiting_reported=0

  while :; do
    host_proof_slot_check_deadline || return $?

    slot_number=1
    while (( slot_number <= 10#$slot_count )); do
      # Keep even a large scan inside the same bound; nonblocking acquisition
      # is fast, but elapsed time is authoritative rather than iteration count.
      host_proof_slot_check_deadline || return $?
      slot_file="${slot_directory}/slot-${slot_number}.lock"
      host_proof_slot_try "$slot_file" "$@"
      command_status=$?
      if (( HOST_PROOF_SLOT_ACQUIRED != 0 )); then
        return "$command_status"
      fi
      # The selected tool's contention status (75) means this candidate is held. Any other
      # status is a setup/lock failure and must not be mistaken for contention.
      if (( command_status != 75 )); then
        return "$command_status"
      fi
      slot_number=$((slot_number + 1))
    done

    host_proof_slot_report_wait || return $?
    host_proof_slot_wait
    now_status=$?
    if (( now_status != 0 )); then
      return "$now_status"
    fi
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  host_proof_slot_main "$@"
fi
