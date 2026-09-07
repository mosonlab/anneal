# How much of this host the merge gate may use. Sourced by merge-gate.sh and by
# scripts/merge-gate-parallel.test.mjs. Not executable on its own.
#
# What the caller owes this file: `die` and `note`. Everything here either
# derives a width or refuses one, so a caller that cannot refuse cannot use it.

# run-gate.sh states the worker's host share, so a worker that says two gives
# each gate half the machine. Every parallel width below is derived from this
# one number instead of each phase reading the CPU count for itself: N
# concurrent gates then add up to one host, rather than each sizing itself for a
# whole machine it does not have. An absent variable means half the host because
# the shared runner host is where it is unset; a gate worker always exports its
# own share.
#
# Any share of one or more, not just one or two: the share is now the worker's
# own `host-share` setting rather than a restatement of its slot count, and a
# gate worker that shares its host with sixteen runners divides the machine by
# more than the gates it runs at once. What the value must be is a whole number
# the host can be divided by; what it must not be is a fraction, a zero or a
# word, all of which would silently size a gate for a machine nobody has.
GATE_HOST_SHARE_STATED="${AGENTOS_GATE_HOST_SHARE:-2}"
GATE_HOST_SHARE="${GATE_HOST_SHARE_STATED}"
case "${GATE_HOST_SHARE}" in
  *[!0-9]*|'') die "AGENTOS_GATE_HOST_SHARE must be a whole number of shares, at least 1, got ${GATE_HOST_SHARE_STATED}" ;;
esac
# Decimal padding is not a different number. A bare `0` was refused and `00` was
# not, and `00` reaches the division below as `Number("00")`, which is a zero
# that produces `Infinity` lanes and kills the gate with the FAIL code over
# nothing but a worker's own setting file.
GATE_HOST_SHARE="$(printf '%s\n' "${GATE_HOST_SHARE}" | sed 's/^0*//')"
[[ -n "${GATE_HOST_SHARE}" ]] \
  || die "AGENTOS_GATE_HOST_SHARE must be a whole number of shares, at least 1, got ${GATE_HOST_SHARE_STATED}"
GATE_CPUS="$(node -e 'const { availableParallelism } = require("node:os");
process.stdout.write(String(Math.max(1, Math.floor(availableParallelism() / Number(process.argv[1])))));' \
  "${GATE_HOST_SHARE}")" || die "could not size this gate against the host"
[[ "${GATE_CPUS}" =~ ^[1-9][0-9]*$ ]] || die "could not size this gate against the host: got '${GATE_CPUS}'"

# The proof waves run together, and they are not contending for one resource.
# The unit wave is processor-bound and ends when the slowest workspace ends. The
# database waves spend most of their wall clock waiting on PostgreSQL, so lanes
# beyond the core count are deliberate oversubscription of something already
# idle, not a claim the machine has more processors than it has.
#
# These were serial until now, and the comment that serialised them cited a
# 4 GiB worker where running them together turned passing suites into timeouts.
# That was a memory ceiling, which is exactly why these widths come from a
# stated share of a measured host instead of from a raw core count.
#
# Each is overridable so that scripts/gate-worker/bench-dbtest-concurrency.sh
# can alternate arms over one fixed commit. A gate never chooses them itself.
GATE_UNIT_LANES="${AGENTOS_GATE_UNIT_LANES:-${GATE_CPUS}}"
GATE_DB_LANES="${AGENTOS_GATE_DB_LANES:-$(( GATE_CPUS < 2 ? 2 : GATE_CPUS ))}"
for lane_setting in GATE_UNIT_LANES GATE_DB_LANES; do
  [[ "${!lane_setting}" =~ ^[1-9][0-9]*$ ]] \
    || die "${lane_setting} must be a positive integer, got '${!lane_setting}'"
done
note "host share: 1/${GATE_HOST_SHARE} of $(node -e 'process.stdout.write(String(require("node:os").availableParallelism()))') cores = ${GATE_CPUS}"
note "lanes:      unit ${GATE_UNIT_LANES}, database ${GATE_DB_LANES}"
