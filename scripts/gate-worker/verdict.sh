# The gate's verdict: how a merge gate run ends, and which last line it ends
# with. Sourced by merge-gate.sh and by scripts/merge-gate-parallel.test.mjs.
# Not executable on its own.
#
# What the caller owes this file. It must have sourced lib.sh (for the
# gate_verdict_* emitters and the GATE_EXIT_* codes) and step-engine.sh (for
# gate_steps_stop_running, gate_steps_report and gate_steps_outcome). It must
# define `discard_gate_tmp` and `release_lock`, the two teardown steps whose
# failures become part of the verdict, and it must have set KEEP_POSTGRES,
# POSTGRES_STARTED, CONTAINER and GATED_HEAD before the traps installed here
# can fire.
#
# Sourcing this file installs the EXIT, INT and TERM traps. That is the point of
# it: the verdict is only correct if it is the same one however the run ends.

cleanup() {
  local status=$?
  trap - EXIT
  local cleanup_error=""

  # Before anything below is torn down, not after.
  gate_steps_stop_running

  discard_gate_tmp || cleanup_error="the temporary directory could not be removed"
  release_lock || cleanup_error="${cleanup_error:+${cleanup_error}; }the merge gate lock could not be released"

  if [ "${KEEP_POSTGRES}" -eq 1 ]; then
    printf '\n   postgres container %s left running (--keep-postgres)\n' "${CONTAINER}"
  elif [ "${POSTGRES_STARTED}" -eq 1 ]; then
    # A gate that promises "deleted when this script exits" has to notice when
    # that promise is not kept; an executor can only see the exit code.
    if ! docker rm -f "${CONTAINER}" >/dev/null 2>&1; then
      cleanup_error="${cleanup_error:+${cleanup_error}; }postgres container ${CONTAINER} could not be removed"
    fi
  fi

  printf '\n'
  gate_steps_report

  # What this run learned, asked once. Which of a failure, a stop and a signal
  # outranks which is the step engine's rule and is stated there; this reads
  # the answer and picks the line that carries it.
  local outcome; outcome="$(gate_steps_outcome)"
  case "${outcome}" in
    'no-verdict '*)
      outcome="${outcome#no-verdict }"
      printf '\n'
      printf 'Nothing judged %s. Re-run the gate; this is not a FAIL.\n' "${GATED_HEAD:-this commit}"
      gate_verdict_not_run "${outcome#* }${cleanup_error:+; ${cleanup_error}}"
      exit "${outcome%% *}"
      ;;
    'fail '*)
      printf '\n'
      gate_verdict_fail "${outcome#fail }"
      exit "${GATE_EXIT_FAIL}"
      ;;
  esac

  # No step failed and none was stopped, and the script still ended non-zero:
  # something outside the plan did, and the gate has no name for it.
  if [ "${status}" -ne 0 ]; then
    printf '\n'
    gate_verdict_fail "unknown"
    exit "${GATE_EXIT_FAIL}"
  fi
  # Every step passed and the host then failed to finish tearing the run down:
  # a container that would not delete, a lock that would not release. That is a
  # fact about the host, not about the commit, so it is not a FAIL — nothing
  # here judged the commit and did not pass. It is not a PASS either, because
  # the gate promises the container is gone and the worktree is free and this
  # run cannot say so. NOT AUTHORITATIVE is the code that already means exactly
  # that: every step passed, and this run may still not authorise a merge.
  #
  # A cleanup failure after a step failed is a different case and stays a FAIL:
  # that run did judge the commit, and the `fail` branch above has already
  # reported that judgement naming the step it is about.
  if [ -n "${cleanup_error}" ]; then
    printf '\n'
    printf 'Every step passed, but this run could not finish tearing itself down and must not authorise a merge.\n'
    gate_verdict_not_authoritative "cleanup: ${cleanup_error}"
    exit "${GATE_EXIT_NOT_AUTHORITATIVE}"
  fi
  if [ "${KEEP_POSTGRES}" -eq 1 ]; then
    printf '\n'
    printf 'Every step passed, but this run left a container behind and must not authorise a merge.\n'
    gate_verdict_not_authoritative '--keep-postgres'
    exit "${GATE_EXIT_NOT_AUTHORITATIVE}"
  fi
  printf '\n'
  # What this PASS does NOT cover, stated here rather than left to be inferred
  # from a skipped test buried in the suite output. Both need live credentials
  # and neither can run inside a hermetic gate, so a green gate is silent about
  # them and must not be read as endorsing them.
  printf 'Not covered by this gate: the \xc2\xa7D-P6 GraphQL schema gate against the live GitHub schema\n'
  printf '  (npm run schema-gate -w @anneal/merge-executor, needs GITHUB_SCHEMA_GATE_TOKEN; it fails without one),\n'
  printf '  and the Step 9/10 [real] direction harnesses, which need a scratch repository and a\n'
  printf '  non-production deployment. Run those separately before a release.\n'
  gate_verdict_pass "${GATED_HEAD}"
  exit 0
}
trap cleanup EXIT
# Ctrl-C and `kill` have to run cleanup too, or an interrupted gate leaves its lock
# and its container behind and the next run in this worktree has to reclaim both.
# Exiting from the handler is what routes the signal through the EXIT trap.
#
# What the handler records is the other half of it. A gate that is stopped mid
# step arrives at cleanup with a non-zero status and a FAILED_STEP naming the
# step it was in, which is indistinguishable from that step having failed. It
# did not fail; it never finished. Naming the signal here is what lets the EXIT
# trap say so.
interrupted() {
  gate_steps_note_signal "$1" "$2"
  exit "$2"
}
trap 'interrupted INT 130' INT
trap 'interrupted TERM 143' TERM
