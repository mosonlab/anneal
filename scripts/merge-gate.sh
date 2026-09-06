#!/usr/bin/env bash
#
# Anneal merge gate. Run this in the worktree you are about to merge.
#
#   bash scripts/merge-gate.sh                       # gate the current HEAD
#   bash scripts/merge-gate.sh --expect-head <oid>   # gate exactly that commit
#   npm run merge-gate -- --expect-head <oid>        # same, through npm
#   bash scripts/merge-gate.sh --master <oid>        # state the baseline commit
#   bash scripts/merge-gate.sh --keep-postgres       # diagnosis: never authoritative
#
# Exit codes are the verdict and nothing else returns 0:
#
#   0  PASS             every step passed, on a clean worktree, at one commit
#                       that did not move, and the throwaway database is gone
#   1  FAIL             a step failed, or a precondition about this commit or
#                       this invocation was missing, or the tree drifted
#   3  NOT AUTHORITATIVE the run was asked to leave state behind, or the host
#                       did not finish tearing the run down, so it may not be
#                       used to authorise a merge even if every step passed
#  76  GATE NOT RUN     a step was stopped from outside before it could be
#                       judged, or the host could not give the gate what it
#                       needs to run one at all (no docker daemon), so no
#                       verdict about this commit exists
# 130  GATE NOT RUN     the gate itself was interrupted (SIGINT), reported under
# 143                   the signal that stopped it (SIGTERM)
#
# 1 is the only code that says the commit was judged and did not pass. A run
# that was killed judged nothing, and must not hand its caller a FAIL: a
# reviewer who records that string records a judgement nothing made. The same
# rule covers the host the gate is standing on. A machine with no docker daemon
# says nothing about the commit either, so it is 76 and the dispatcher moves the
# work to a worker that can judge it, rather than 1 and a merge blocked on a
# daemon that was not running.
#
# The last line of output is one of MERGE GATE: PASS <oid> / FAIL / NOT
# AUTHORITATIVE, or GATE NOT RUN: <reason> when the run was stopped rather than
# finished. A PASS always names the commit it is a statement about.
#
# The gate owns its own throwaway PostgreSQL: it starts a container, binds it to
# a loopback ephemeral port, and deletes it on the way out. There is deliberately
# no flag to point it at an existing server, because the only way a test process
# reaches the production database is if something lets an operator aim it there.
#
# For the same reason every host path the suites could otherwise default to is
# replaced with a fresh mktemp directory, and the substitution is verified before
# a single dependency is installed. The 2026-08-18 incident was a dbtest with a
# correctly scoped scratch database that still swept the live workspace root, so
# a database-only guarantee is not the guarantee that was missing.
#
# A worktree can only host one gate at a time, so the run takes an exclusive lock
# on the worktree root before it writes anything. Two gates sharing a checkout
# share node_modules, dist/ and the prisma client, and `npm ci` deletes
# node_modules before it repopulates it: the 2026-08-17 incident was 33 gates in
# one worktree deleting each other's dependencies mid-run, which surfaced as a
# dbtest failure that had nothing to do with the code being gated. A gate that
# waited for the lock would be worse than useless — the queue would silently
# serialise runs whose commits have already moved on — so a live holder is an
# immediate FAIL naming the process that holds it.
#
# The frozen-record rules (CONTRIBUTING.md "Records that do not change") are checked immediately
# after the commit is pinned and before Docker is touched: they need nothing
# installed and nothing running, and a branch that rewrites history should hear
# that instead of a preflight failure about a daemon it never needed.
#
# Those rules are about what is already on the branch being merged into, so the
# gate has to know which commit that is, and it establishes that rather than
# assuming it, in this order: --master <oid>, AGENTOS_MASTER_OID, `git ls-remote
# --symref origin HEAD` when there is an origin to ask, and otherwise this
# repository's own refs for a locally inferable default branch. The supported
# gate-worker path always takes the first route: gate-dispatch supplies its
# frozen exact baseline because the worker cache intentionally has no remote and
# no mirrored branch namespace. The branch's name is otherwise read rather than
# written down here: this repository's is `main`.
# Whichever it is, the oid and where it came from are printed in the preflight
# and the frozen check is bound to it. When the two local refs disagree the
# descendant wins, because a later baseline can only ever refuse more.
#
# Anything the gate cannot establish is a FAIL, never a skip.
#
# The gate chooses its own proof profile from the exact baseline-to-candidate
# diff. A content-only modification to an explicit allowlist of prose files uses
# the docs-only profile: frozen-record enforcement, classifier fixtures, diff
# hygiene, the closed public-snapshot scan, and final HEAD/worktree drift. Adds,
# deletes, renames, mode changes, runtime-coupled documentation, code,
# configuration, and every unknown path use the full profile below. There is no
# flag that lets a caller request the cheaper profile.
#
# One content-addressed cache changes latency, never the question the gate asks.
# Every full run executes npm ci, including its lifecycle scripts and Prisma
# generation, under the environment being gated. The build snapshot key covers
# that dependency specification, the pinned git tree, and every environment
# input read by the web build. It contains only dist outputs from a
# successful full build, is published atomically, and is never executed in place.
# A miss is first captured in this run's private temp directory; it is not made
# globally visible until the final HEAD/worktree drift check passes. Thus outputs
# built from a mid-run edit can never be published under the pinned clean OID.
# On a hit outputs are copied into an empty destination with the platform's
# copy-on-write primitive when available, and the two dated provenance files are
# regenerated for this run. No test result or test verdict is cached: every
# lint, database-CLI typecheck, unit test, migration and database test still
# executes. Cache entries are write-once, and at most 32 valid entries are
# retained, including the entry serving the current run. A malformed entry
# falls back to the original slow command rather than being repaired or guessed at.
#
# The full profile runs as three concurrent groups rather than one serial chain.
# Concurrency changes latency, never the question the gate asks: every step that
# ran before still runs, with the same command, and a group passes only when all
# of its members do. The order is the only order their real dependencies allow —
# dependencies and the install-free suites, then everything that needs
# node_modules but not dist/, then the proof waves that read dist/ — and the
# throwaway PostgreSQL is started before the first group so its initdb overlaps
# work rather than blocking it.
#
# How wide each group runs is not read from the core count. run-gate.sh states
# what share of the worker this gate was given, and every fan-out below is
# derived from that one number, so two gates on a two-slot worker still add up
# to one machine. A gate invoked by hand states no share and takes half the host.
#
# A parallel group reports every member that failed, not the first one to fail,
# and replays each member's output under its own heading in submission order.
# Both properties are invisible on a run that passes, so they are held by
# fixtures in scripts/merge-gate-parallel.test.mjs, which this gate runs.

set -euo pipefail

KEEP_POSTGRES=0
EXPECT_HEAD=""
MASTER_OID="${AGENTOS_MASTER_OID:-}"
POSTGRES_IMAGE="${AGENTOS_GATE_POSTGRES_IMAGE:-postgres:16-alpine}"
CACHE_ROOT="${XDG_CACHE_HOME:-${HOME}/.cache}/agentos-merge-gate"
BUILD_CACHE_MAX_ENTRIES=32

usage() {
  # No gate ran, so the EXIT trap must not print a verdict.
  trap - EXIT
  sed -n '2,70p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --expect-head)
      [ $# -ge 2 ] || { printf 'merge-gate: --expect-head needs an object id\n' >&2; exit 2; }
      EXPECT_HEAD="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
      shift
      ;;
    --expect-head=*)
      EXPECT_HEAD="$(printf '%s' "${1#--expect-head=}" | tr '[:upper:]' '[:lower:]')"
      ;;
    --master)
      [ $# -ge 2 ] || { printf 'merge-gate: --master needs an object id\n' >&2; exit 2; }
      MASTER_OID="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
      shift
      ;;
    --master=*)
      MASTER_OID="$(printf '%s' "${1#--master=}" | tr '[:upper:]' '[:lower:]')"
      ;;
    --keep-postgres) KEEP_POSTGRES=1 ;;
    -h|--help) usage 0 ;;
    *) printf 'merge-gate: unknown argument %s\n\n' "$1" >&2; usage 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
# Two things come from here. Both of this gate's locks — the worktree it runs in
# and the build cache entry it publishes — are the tested atomic pid-lock
# primitive rather than a mkdir-then-pid lock, whose empty-owner window lets two
# concurrent gates both conclude the other's lock was abandoned. And the verdict
# this gate exists to produce —
# its exit codes and the four lines that carry them — is written by lib.sh's
# emit functions, because run-gate.sh reads those lines back and one format
# needs one writer.
# shellcheck source=packages/runner/runtime-tools/gate-worker/lib.sh
. "${REPO_ROOT}/packages/runner/runtime-tools/gate-worker/lib.sh"
if [[ -n "${AGENTOS_RUN_ID:-}" ]]; then
  regression_bypass_authenticated=0
  if [[ "${AGENTOS_RUN_SCOPE_BYPASS:-}" == "regression-verification" ]]; then
    # shellcheck source=scripts/run-scope-bypass.sh
    . "${SCRIPT_DIR}/run-scope-bypass.sh"
    if agentos_regression_bypass_is_authenticated; then
      regression_bypass_authenticated=1
    else
      agentos_regression_bypass_audit_refusal
    fi
  fi
  if (( regression_bypass_authenticated == 0 )); then
    gate_verdict_not_run "refused inside Anneal run ${AGENTOS_RUN_ID}"
    exit "${GATE_EXIT_NO_VERDICT}"
  fi
fi
# What it means to run a step, to run a group of them at once, and what this
# run's outcome is. It travels with the commit rather than being installed on
# the worker: run-gate.sh gates a worktree checked out of the mirror, so
# everything merge-gate.sh sources out of the repository tree is already there.
# shellcheck source=scripts/gate-worker/step-engine.sh
. "${SCRIPT_DIR}/gate-worker/step-engine.sh"
CONTAINER="agentos-merge-gate-$$"
# The lock lives in the worktree because the worktree is what is being contended:
# two checkouts of the same repository may gate at the same time, two gates in one
# checkout may not. Which lock it is, and why it is that one rather than a
# directory, is lib.sh's slot lock and is stated there.
LOCK_ROOT="${REPO_ROOT}"
LOCK_SLOT=".merge-gate"
LOCK_FILE="$(gate_slot_path "${LOCK_ROOT}" "${LOCK_SLOT}")"
LOCK_HELD=0
GATE_TMP=""
POSTGRES_STARTED=0
GATED_HEAD=""
GATE_PROFILE="full"
gate_steps_begin

# --- plumbing ---------------------------------------------------------------

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
note() { printf '   %s\n' "$1"; }
die() {
  printf '\n\033[31mmerge-gate: %s\033[0m\n' "$1" >&2
  FAILED_STEP="${FAILED_STEP:-preflight}"
  exit "${GATE_EXIT_FAIL}"
}

# The other half of `die`, and the line between them is who the failure is
# about. `die` is for the commit and the invocation — a dirty tree, an
# --expect-head that does not match, a baseline that is not in this repository —
# and those are judgements: this commit cannot be gated as asked, which is a
# FAIL. This one is for the host the gate is standing on. A machine with no
# docker daemon has said nothing about the commit, so the run reports the
# absence of a verdict under the same code as a step that was stopped from
# outside, and the dispatcher takes the work to capacity that can judge it.
# Recorded through the step engine's own state rather than exited directly, so
# the reason travels to the one place that prints the last line.
die_no_verdict() {
  printf '\n\033[33mmerge-gate: %s\033[0m\n' "$1" >&2
  NO_VERDICT_REASON="$1"
  NO_VERDICT_EXIT="${GATE_EXIT_NO_VERDICT}"
  exit "${GATE_EXIT_NO_VERDICT}"
}

# Only ever discards the directory this run created, identified by the prefix it
# was created with. A cleanup routine that trusts a variable is how a scratch run
# reaches a real tree.
discard_gate_tmp() {
  [ -n "${GATE_TMP}" ] || return 0
  case "${GATE_TMP}" in
    */agentos-merge-gate.????????)
      [ -d "${GATE_TMP}" ] || return 0
      # Deferred snapshots are deliberately read-only until publication. Restore
      # owner write permission only inside this run's validated temp root so the
      # normal cleanup can remove them after either PASS or FAIL.
      chmod -R u+w "${GATE_TMP}" || return 1
      rm -rf -- "${GATE_TMP}"
      ;;
    *)
      printf 'merge-gate: refusing to remove unexpected temp path %s\n' "${GATE_TMP}" >&2
      return 1
      ;;
  esac
}

# Same rule as discard_gate_tmp: only ever release a lock this run is holding.
# gate_slot_release re-reads the holder and refuses when it is somebody else, so
# a run that somehow lost the lock cannot free the slot another gate is standing
# in; its refusal is this run's cleanup failure and is reported as one.
release_lock() {
  [ "${LOCK_HELD}" -eq 1 ] || return 0
  gate_slot_release "${LOCK_ROOT}" "${LOCK_SLOT}" || return 1
  LOCK_HELD=0
}

# Acquire before the first write of any kind, through the same primitive the
# dispatcher rations its slots with. The lock is a file created with `ln` that
# already names its owner the instant it exists, which is what the mkdir lock
# this replaced could not do: mkdir creates the directory empty and writes the
# pid a moment later, and a second gate reading that window sees a lock naming
# nobody, calls it abandoned, and takes the worktree the first one is installing
# into. gate_slot_try reclaims a lock whose holder is gone and refuses one that
# names no pid, both for reasons stated where it is defined.
#
# A live holder is a FAIL and never a wait: this gate does not queue, because a
# queue silently serialises runs whose commits have already moved on.
acquire_lock() {
  local status=0
  gate_slot_try "${LOCK_ROOT}" "${LOCK_SLOT}" || status=$?
  case "${status}" in
    0)
      LOCK_HELD=1
      return 0
      ;;
    "${GATE_SLOT_BUSY}")
      die "another merge gate is running in ${REPO_ROOT} (pid $(cat "${LOCK_FILE}" 2>/dev/null || printf 'unknown')); this gate does not queue, rerun once that one has finished"
      ;;
    *)
      # Not busy: the lock itself cannot be operated, and the reason is already
      # on stderr. Waiting changes nothing, so this run stops the same way.
      die "the merge gate lock ${LOCK_FILE} could not be taken; clear it once no gate is running in ${REPO_ROOT}"
      ;;
  esac
}

# How this run ends, and the last line it ends with: cleanup, the signal
# handler, and the three traps that route every ending through the same
# accounting. Sourcing it installs those traps.
# shellcheck source=scripts/gate-worker/verdict.sh
. "${SCRIPT_DIR}/gate-worker/verdict.sh"

sha256() { shasum -a 256 | awk '{print $1}'; }

copy_cache_tree() {
  case "$(uname -s)" in
    Darwin) cp -c -R "$1" "$2" ;;
    Linux) cp -a --reflink=auto "$1" "$2" ;;
    *) cp -R -p "$1" "$2" ;;
  esac
}

cache_copy_description() {
  case "$(uname -s)" in
    Darwin) printf 'APFS clones' ;;
    Linux) printf 'reflink when supported, portable copy otherwise' ;;
    *) printf 'portable copies' ;;
  esac
}

# The build key names dependency inputs as well as hashing their bytes, so
# adding/removing a manifest or npm configuration file cannot collide with
# merely changing one.
dependency_state_key() {
  {
    printf 'format=build-dependency-state-v1\n'
    printf 'node=%s\nnpm=%s\nplatform=%s\n' \
      "$(node --version)" "$(npm --version)" "$(uname -sm)"
    git -C "${REPO_ROOT}" ls-files \
      'package.json' 'package-lock.json' 'apps/*/package.json' 'packages/*/package.json' \
      '.npmrc' 'apps/*/.npmrc' 'packages/*/.npmrc' 'packages/db/prisma/schema.prisma' \
      | LC_ALL=C sort | while IFS= read -r input; do
        printf 'file=%s\n' "${input}"
        printf 'sha256=%s\n' "$(sha256 < "${REPO_ROOT}/${input}")"
      done
    # npm configuration can change platform packages and lifecycle behaviour.
    # It is fed only into the digest; credentials are never printed or stored.
    npm config list --json
    env | LC_ALL=C sort | awk -F= '
      /^(CI|NODE_[^=]*|NPM_CONFIG_[^=]*|npm_config_[^=]*|PRISMA_[^=]*)=/ { print }
    '
  } | sha256
}

CACHE_WRITER_ROOT=""
CACHE_WRITER_SLOT=""

take_cache_writer_lock() {
  local entry="$1"
  CACHE_WRITER_ROOT="$(dirname "${entry}")"
  CACHE_WRITER_SLOT="$(basename "${entry}").writer"
  if gate_slot_try "${CACHE_WRITER_ROOT}" "${CACHE_WRITER_SLOT}"; then
    return 0
  fi
  CACHE_WRITER_ROOT=""
  CACHE_WRITER_SLOT=""
  return 1
}

release_cache_writer_lock() {
  [ -n "${CACHE_WRITER_ROOT}" ] && [ -n "${CACHE_WRITER_SLOT}" ] || return 0
  gate_slot_release "${CACHE_WRITER_ROOT}" "${CACHE_WRITER_SLOT}" || true
  CACHE_WRITER_ROOT=""
  CACHE_WRITER_SLOT=""
}

install_dependencies() {
  npm ci --prefer-offline --no-audit --no-fund || return 1
  verify_generated_prisma_client
}

verify_generated_prisma_client() {
  [ -f "${REPO_ROOT}/node_modules/.prisma/client/index.js" ] \
    && [ -f "${REPO_ROOT}/node_modules/.prisma/client/schema.prisma" ] \
    || { printf 'npm ci did not produce the generated Prisma client\n' >&2; return 1; }
}

esbuild_binary_key() {
  local path="${ESBUILD_BINARY_PATH-}" selected=""
  if [ "${ESBUILD_BINARY_PATH+x}" != x ]; then
    printf 'ESBUILD_BINARY_PATH.state=unset\n'
    return
  fi
  printf 'ESBUILD_BINARY_PATH.path=%s\n' "${path}"
  if [ -z "${path}" ]; then
    printf 'ESBUILD_BINARY_PATH.kind=empty\n'
    return
  fi
  selected="${path}"
  case "${path}" in
    */*) ;;
    *)
      selected="$(command -v -- "${path}" 2>/dev/null || true)"
      if [ -z "${selected}" ]; then
        printf 'ESBUILD_BINARY_PATH.kind=unresolved-command\n'
        return
      fi
      printf 'ESBUILD_BINARY_PATH.resolution=PATH\n'
      ;;
  esac
  if [ -L "${selected}" ]; then
    printf 'ESBUILD_BINARY_PATH.kind=symlink\n'
    printf 'ESBUILD_BINARY_PATH.link=%s\n' "$(readlink "${selected}")"
  elif [ -f "${selected}" ]; then
    printf 'ESBUILD_BINARY_PATH.kind=regular\n'
  elif [ -e "${selected}" ]; then
    printf 'ESBUILD_BINARY_PATH.kind=other\n'
    return
  else
    printf 'ESBUILD_BINARY_PATH.kind=missing\n'
    return
  fi
  if [ -f "${selected}" ]; then
    printf 'ESBUILD_BINARY_PATH.sha256=%s\n' "$(sha256 < "${selected}")"
    if [ -x "${selected}" ]; then
      printf 'ESBUILD_BINARY_PATH.executable=yes\n'
    else
      printf 'ESBUILD_BINARY_PATH.executable=no\n'
    fi
  else
    printf 'ESBUILD_BINARY_PATH.target=missing-or-nonregular\n'
  fi
}

BUILD_OUTPUTS=(
  packages/github-client/dist packages/db/dist packages/api/dist packages/runner/dist
  packages/inbox/dist packages/merge-executor/dist apps/web/dist
)

build_cache_key() {
  {
    printf 'commit=%s\ndependencies=%s\n' "${GATED_HEAD}" "$(dependency_state_key)"
    for name in NODE_ENV API_PORT WEB_API_URL OPERATOR_TOKEN; do
      printf '%s=%s\n' "${name}" "${!name-}"
    done
    esbuild_binary_key
    for input in .env .env.local .env.production .env.production.local; do
      printf 'file=%s\n' "${input}"
      if [ -f "${REPO_ROOT}/${input}" ]; then
        printf 'sha256=%s\n' "$(sha256 < "${REPO_ROOT}/${input}")"
      else
        printf 'absent\n'
      fi
    done
  } | sha256
}

build_cache_entry_valid() {
  local entry="$1" key="$2" output=""
  [ -d "${entry}" ] && [ ! -L "${entry}" ] \
    && [ -f "${entry}/READY" ] && [ ! -L "${entry}/READY" ] \
    && [ "$(cat "${entry}/READY" 2>/dev/null || true)" = "${key}" ] || return 1
  for output in "${BUILD_OUTPUTS[@]}"; do
    [ -d "${entry}/tree/${output}" ] && [ ! -L "${entry}/tree/${output}" ] || return 1
  done
}

prune_build_cache() {
  local protected_key="${1:-}" builds="${CACHE_ROOT}/builds"
  local candidate="" key="" keep_limit="${BUILD_CACHE_MAX_ENTRIES}"
  local valid_count=0 removed=0
  [ -d "${builds}" ] || return 0

  if [ -n "${protected_key}" ] \
    && build_cache_entry_valid "${builds}/${protected_key}" "${protected_key}"; then
    keep_limit=$((BUILD_CACHE_MAX_ENTRIES - 1))
  else
    protected_key=""
  fi

  # Final entries are immutable, hash-named directories. Sort those candidates
  # by publication mtime and leave writer locks, symlinks, and doubtful state
  # untouched. A concurrent reader whose old entry is pruned either finishes
  # its clone or takes the existing clean-build fallback.
  while IFS= read -r candidate; do
    [ -d "${candidate}" ] && [ ! -L "${candidate}" ] || continue
    key="${candidate##*/}"
    [ "${#key}" -eq 64 ] || continue
    case "${key}" in *[!0-9a-f]*) continue ;; esac
    [ "${key}" = "${protected_key}" ] && continue
    build_cache_entry_valid "${candidate}" "${key}" || continue
    valid_count=$((valid_count + 1))
    [ "${valid_count}" -le "${keep_limit}" ] && continue
    if chmod -R u+w "${candidate}" 2>/dev/null && rm -rf -- "${candidate}"; then
      removed=$((removed + 1))
    else
      note "build cache pruning could not remove ${key}; leaving it unused"
    fi
  done < <(LC_ALL=C ls -1dt -- "${builds}/"* 2>/dev/null || true)

  if [ "${removed}" -gt 0 ]; then
    note "build cache pruned: ${removed} old entries; retaining at most ${BUILD_CACHE_MAX_ENTRIES}"
  fi
  return 0
}

clear_build_outputs() {
  local output=""
  for output in "${BUILD_OUTPUTS[@]}"; do rm -rf -- "${REPO_ROOT}/${output}" || return 1; done
}

publish_build_snapshot() {
  local entry="$1" key="$2" source_tree="$3" staging="" output=""
  take_cache_writer_lock "${entry}" || return 0
  if build_cache_entry_valid "${entry}" "${key}" || [ -e "${entry}" ]; then
    release_cache_writer_lock
    return 0
  fi
  staging="$(mktemp -d "${CACHE_ROOT}/.build.${key}.XXXXXXXX")"
  mkdir -p "${staging}/tree"
  for output in "${BUILD_OUTPUTS[@]}"; do
    mkdir -p "${staging}/tree/$(dirname "${output}")"
    copy_cache_tree "${source_tree}/${output}" "${staging}/tree/${output}" || {
      rm -rf -- "${staging}"
      release_cache_writer_lock
      note "build snapshot could not be cloned; this run keeps fresh build output"
      return 0
    }
  done
  if ! printf '%s\n' "${key}" > "${staging}/READY" \
    || ! chmod -R a-w "${staging}/tree" "${staging}/READY" \
    || ! mv "${staging}" "${entry}" \
    || ! chmod a-w "${entry}"; then
    chmod -R u+w "${staging}" 2>/dev/null || true
    chmod -R u+w "${entry}" 2>/dev/null || true
    rm -rf -- "${staging}" "${entry}"
    release_cache_writer_lock
    note "build snapshot could not be published; this run keeps fresh build output"
    return 0
  fi
  release_cache_writer_lock
  note "build cache stored: ${key}"
}

prepare_deferred_build_snapshot() {
  local key="$1" output="" snapshot="${GATE_TMP}/deferred-build-snapshot"
  rm -rf -- "${snapshot}"
  mkdir -p "${snapshot}/tree" || return 1
  for output in "${BUILD_OUTPUTS[@]}"; do
    mkdir -p "${snapshot}/tree/$(dirname "${output}")" || return 1
    copy_cache_tree "${REPO_ROOT}/${output}" "${snapshot}/tree/${output}" || return 1
  done
  printf '%s\n' "${key}" > "${snapshot}/READY" || return 1
  chmod -R a-w "${snapshot}/tree" "${snapshot}/READY" || return 1
  # step() runs commands in a subshell. Persist the publication intent inside
  # this run's private temp root so the parent can read it after the drift check.
  printf '%s\n' "${key}" > "${GATE_TMP}/deferred-build-key" || return 1
}

record_release_build_key() {
  printf '%s\n' "$1" > "${GATE_TMP}/release-build-key"
}

# This is called only after verify_tree_did_not_drift succeeds. Until then the
# completed build exists solely under this gate run's private temporary root and
# no later run can observe it under the pinned-OID cache key.
publish_deferred_build_snapshot() {
  local entry="" key="" snapshot="${GATE_TMP}/deferred-build-snapshot"
  [ -f "${GATE_TMP}/deferred-build-key" ] && [ ! -L "${GATE_TMP}/deferred-build-key" ] || return 0
  key="$(cat "${GATE_TMP}/deferred-build-key" 2>/dev/null || true)"
  [ -n "${key}" ] && [ "$(cat "${snapshot}/READY" 2>/dev/null || true)" = "${key}" ] || {
    note "deferred build snapshot is incomplete; leaving the global cache untouched"
    return 0
  }
  entry="${CACHE_ROOT}/builds/${key}"
  publish_build_snapshot "${entry}" "${key}" "${snapshot}/tree" \
    || note "build cache publication failed; this run keeps fresh build output"
  prune_build_cache "${key}"
}

# The revision index is deployment acceleration, never merge authority. It is
# published only after the final drift proof and points at the bounded immutable
# build cache above, so it adds no second artifact copy or unbounded cache.
publish_release_snapshot() {
  local key=""
  [ -f "${GATE_TMP}/release-build-key" ] && [ ! -L "${GATE_TMP}/release-build-key" ] || return 0
  key="$(cat "${GATE_TMP}/release-build-key" 2>/dev/null || true)"
  [ -n "${key}" ] || return 0
  if node "${REPO_ROOT}/scripts/deploy/release-snapshot.mjs" publish "${GATED_HEAD}" "${CACHE_ROOT}" "${key}"; then
    note "release snapshot indexed: ${GATED_HEAD}"
  else
    note "release snapshot publication failed; deployment will build from source"
  fi
}

# The full build, one dependency layer at a time, each layer concurrently.
#
# `npm run build` chains every workspace with `&&`, which waits for all of them
# where it only has to wait for some. The layers come from scripts/build-layers.mjs,
# which derives them from the same root build script and the manifests npm
# itself resolves, so the set built here is the set that script names and the
# order respects every first-party dependency.
#
# A layer's members write to different dist/ trees and are replayed in order, so
# this reads like the serial build it replaces. Every failing workspace in a
# layer is named: they were built together and a rerun should not have to
# rediscover the second one.
run_layered_build() {
  local layer index name log failed=0
  local -a names=() logs=() pids=() statuses=()
  local plan
  plan="$(node scripts/build-layers.mjs)" || { printf 'could not determine the build layers\n' >&2; return 1; }
  [ -n "${plan}" ] || { printf 'the build layer plan is empty\n' >&2; return 1; }

  while IFS= read -r layer; do
    [ -n "${layer}" ] || continue
    names=(); logs=(); pids=(); statuses=()
    # shellcheck disable=SC2206 -- the plan is a space-separated workspace list this script produced
    names=(${layer})
    printf '\n   layer: %s\n' "${layer}"
    for ((index=0; index<${#names[@]}; index++)); do
      log="${GATE_TMP}/build-$(printf '%s' "${names[index]}" | tr -c '[:alnum:]' '-').log"
      logs[index]="${log}"
      (cd "${REPO_ROOT}" && npm run build -w "${names[index]}") >"${log}" 2>&1 &
      pids[index]=$!
    done
    for ((index=0; index<${#names[@]}; index++)); do
      if wait "${pids[index]}"; then statuses[index]=0; else statuses[index]=1; fi
    done
    for ((index=0; index<${#names[@]}; index++)); do
      printf '\n--- build %s ---\n' "${names[index]}"
      cat "${logs[index]}" 2>/dev/null || true
      [ "${statuses[index]}" -eq 0 ] || { printf 'build failed: %s\n' "${names[index]}" >&2; failed=1; }
    done
    # A later layer compiles against this one's dist/, so a broken layer must
    # not be built on top of.
    [ "${failed}" -eq 0 ] || return 1
  done <<< "${plan}"
  return 0
}

build_all() {
  local key entry output
  mkdir -p "${CACHE_ROOT}/builds" || return 1
  key="$(build_cache_key)" || return 1
  entry="${CACHE_ROOT}/builds/${key}"
  if build_cache_entry_valid "${entry}" "${key}"; then
    clear_build_outputs || return 1
    for output in "${BUILD_OUTPUTS[@]}"; do
      mkdir -p "${REPO_ROOT}/$(dirname "${output}")" || return 1
      copy_cache_tree "${entry}/tree/${output}" "${REPO_ROOT}/${output}" || {
        note "build cache clone failed at ${output}; falling back to a clean full build"
        clear_build_outputs || return 1
        run_layered_build || return 1
        return 0
      }
      chmod -R u+w "${REPO_ROOT}/${output}" || {
        note "build cache permissions could not be materialized at ${output}; falling back to a clean full build"
        clear_build_outputs || return 1
        run_layered_build || return 1
        return 0
      }
    done
    # These are intentionally time-varying. Recreate them rather than letting a
    # cached builtAt claim that this materialisation happened on an earlier run.
    (cd "${REPO_ROOT}/packages/api" && node ../build-info/stamp.mjs dist) || return 1
    (cd "${REPO_ROOT}/packages/runner" && node ../build-info/stamp.mjs dist) || return 1
    note "build cache hit: ${key} ($(cache_copy_description), provenance restamped)"
    record_release_build_key "${key}" || return 1
    prune_build_cache "${key}"
    return 0
  fi
  note "build cache miss: ${key}"
  clear_build_outputs || return 1
  run_layered_build || return 1
  if prepare_deferred_build_snapshot "${key}"; then
    record_release_build_key "${key}" || return 1
  else
    note "build snapshot could not be staged; this run keeps fresh build output"
  fi
  return 0
}

workspace_names_with_script() {
  node -e '
    const fs = require("node:fs");
    const script = process.argv[1];
    for (const parent of ["apps", "packages"]) {
      for (const child of fs.readdirSync(parent).sort()) {
        const file = `${parent}/${child}/package.json`;
        if (!fs.existsSync(file)) continue;
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        if (manifest.scripts?.[script]) process.stdout.write(`${manifest.name}\n`);
      }
    }
  ' "$1"
}

# Each workspace gets its own process and log. Unit suites write fixtures under
# mktemp and only read the completed dist tree, so they share no mutable output.
# Logs are replayed in stable workspace order.
run_workspace_script_parallel() {
  local script="$1" ignore_lifecycle="${2:-0}" workspace="" safe="" log=""
  local index=0 next_wait=0 failed=0 max_jobs="${3:-1}"
  local -a workspaces=() logs=() pids=() statuses=()
  note "workspace ${script}: at most ${max_jobs} concurrent jobs"
  while IFS= read -r workspace; do
    [ -n "${workspace}" ] || continue
    safe="$(printf '%s' "${workspace}" | tr '/@' '__')"
    log="${GATE_TMP}/parallel-${script}-${safe}.log"
    workspaces+=("${workspace}")
    logs+=("${log}")
    if [ "${ignore_lifecycle}" -eq 1 ]; then
      (cd "${REPO_ROOT}" && npm run --ignore-scripts "${script}" -w "${workspace}") >"${log}" 2>&1 &
    else
      (cd "${REPO_ROOT}" && npm run "${script}" -w "${workspace}") >"${log}" 2>&1 &
    fi
    pids+=("$!")
    if [ "$(( ${#pids[@]} - next_wait ))" -ge "${max_jobs}" ]; then
      if wait "${pids[next_wait]}"; then statuses[next_wait]=0; else statuses[next_wait]=1; fi
      next_wait=$((next_wait + 1))
    fi
  done < <(cd "${REPO_ROOT}" && workspace_names_with_script "${script}")
  [ "${#pids[@]}" -gt 0 ] || { printf 'no workspaces define %s\n' "${script}" >&2; return 1; }
  while [ "${next_wait}" -lt "${#pids[@]}" ]; do
    if wait "${pids[next_wait]}"; then statuses[next_wait]=0; else statuses[next_wait]=1; fi
    next_wait=$((next_wait + 1))
  done
  for ((index=0; index<${#pids[@]}; index++)); do
    [ "${statuses[index]}" -eq 0 ] || failed=1
    printf '\n--- %s: %s ---\n' "${script}" "${workspaces[index]}"
    cat "${logs[index]}" || failed=1
  done
  return "${failed}"
}

parallel_unit_tests() {
  # npm's current pretest hooks are only duplicate builds of workspaces already
  # covered by the immediately preceding full build. Prove that contract on
  # every run, then suppress only those redundant lifecycle hooks. If any hook
  # gains another responsibility, this check fails instead of skipping it.
  verify_build_only_lifecycle_hooks pretest || return 1
  run_workspace_script_parallel test 1 "${GATE_UNIT_LANES}"
}

verify_build_only_lifecycle_hooks() {
  local hook="$1"
  node -e '
    const fs = require("node:fs");
    const hook = process.argv[1];
    const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const built = new Set([...root.scripts.build.matchAll(/npm run build -w ([^ &]+)/g)].map((m) => m[1]));
    for (const parent of ["apps", "packages"]) for (const child of fs.readdirSync(parent).sort()) {
      const file = `${parent}/${child}/package.json`;
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      const lifecycle = manifest.scripts?.[hook];
      if (!lifecycle) continue;
      const commands = lifecycle.split("&&").map((part) => part.trim());
      for (const command of commands) {
        const match = /^npm run build -w ([^ ]+)$/.exec(command);
        if (!match || !built.has(match[1])) throw new Error(`${manifest.name} ${hook} is not covered by the full build: ${command}`);
      }
    }
  ' "${hook}"
}

# One database wave, not two.
#
# packages/db and packages/api hand their files to the same runner, against the
# same server, and each file already receives its own cloned database and its own
# private roots. Running them as two waves meant dividing the lanes between five
# files and forty-two, and any fixed division is a guess about a ratio nothing
# maintains. The guess failed on the four-core fallback worker: the five-file
# wave drew one lane and spent 201 seconds while the forty-two-file wave ran
# beside it on three.
#
# One pool balances itself, and it migrates the template once instead of twice.
# The Goal 5a0 preflight's first-run boundary still runs against this throwaway
# server — the only evidence that an empty target passes and a non-empty one
# still refuses — and node:test still names the file that failed.
run_database_tests() {
  verify_build_only_lifecycle_hooks pretest:db || return 1
  local suite_root="${GATE_TMP}/dbtest-roots"
  mkdir -p "${suite_root}/workspaces" "${suite_root}/state" "${suite_root}/files" || return 1
  AGENTOS_DBTEST_CONCURRENCY="${GATE_DB_LANES}" \
  RUNNER_WORKSPACE_ROOT="${suite_root}/workspaces" \
  CONTROL_PLANE_STATE_DIR="${suite_root}/state" \
  FILES_ROOT="${suite_root}/files" \
    node --import tsx packages/api/scripts/dbtest.mjs \
      packages/db/src/*.dbtest.ts packages/api/src/*.dbtest.ts
}

parallel_lint() {
  local biome="${GATE_TMP}/lint-biome.log" types="${GATE_TMP}/lint-types.log" biome_pid types_pid failed=0
  local eslint_node_options="${NODE_OPTIONS:+${NODE_OPTIONS} }--max-old-space-size=3584"
  (cd "${REPO_ROOT}" && npm run lint:biome) >"${biome}" 2>&1 & biome_pid=$!
  # Node 26 caps its heap near 1.8 GiB on the 4 GiB worker; the type-aware
  # project service now crosses that boundary before completing. Raise only
  # this process's ceiling. The option is a limit, not a reservation. 2560
  # was exceeded on 2026-09-05 (main already scavenged at ~2.5 GiB; the
  # staffing console tree pushed it over), so the limit is 3.5 GiB now.
  (cd "${REPO_ROOT}" && NODE_OPTIONS="${eslint_node_options}" npm run lint:types) >"${types}" 2>&1 & types_pid=$!
  wait "${biome_pid}" || failed=1
  wait "${types_pid}" || failed=1
  printf '\n--- biome ---\n'; cat "${biome}"
  printf '\n--- typescript-eslint ---\n'; cat "${types}"
  return "${failed}"
}

# True when either path is the other or contains it.
overlaps() {
  case "$1" in "$2"|"$2"/*) return 0 ;; esac
  case "$2" in "$1"|"$1"/*) return 0 ;; esac
  return 1
}

git_head() { git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null; }
git_dirt() { git -C "${REPO_ROOT}" status --porcelain 2>/dev/null; }

verify_candidate_diff() {
  git -C "${REPO_ROOT}" diff --check "${MASTER_OID}" "${GATED_HEAD}" --
}

# The verdict is about the commit the preflight pinned, so the last step proves
# nothing moved underneath it: no rebase, no stray edit, no build artefact that
# is not ignored. Otherwise a PASS could describe a tree that no longer exists.
verify_tree_did_not_drift() {
  local now dirt
  now="$(git_head)" || { printf 'could not re-read HEAD\n' >&2; return 1; }
  if [ "${now}" != "${GATED_HEAD}" ]; then
    printf 'HEAD moved from %s to %s while the gate was running\n' "${GATED_HEAD}" "${now}" >&2
    return 1
  fi
  dirt="$(git_dirt)"
  if [ -n "${dirt}" ]; then
    printf 'the working tree was modified while the gate was running:\n%s\n' "${dirt}" >&2
    return 1
  fi
  printf 'still at %s, working tree still clean\n' "${GATED_HEAD}"
}

# --- preflight --------------------------------------------------------------

say "Preflight"
[ -f "${REPO_ROOT}/package.json" ] || die "no package.json at ${REPO_ROOT}"
grep -q '"name": "anneal"' "${REPO_ROOT}/package.json" || die "${REPO_ROOT} is not the Anneal repository root"

# Taken here, ahead of every other precondition: the gate installs into this
# worktree's node_modules and builds into its dist/, so concurrency is the first
# thing that can invalidate a run, and it should be the verdict a second gate
# reports rather than whatever it happens to trip over next.
FAILED_STEP="worktree lock"
acquire_lock
FAILED_STEP=""
note "lock:       ${LOCK_FILE} (pid $$)"

git -C "${REPO_ROOT}" rev-parse --git-dir >/dev/null 2>&1 || die "${REPO_ROOT} is not a git worktree"

# A PASS is a statement about one commit, so the gate has to know which, and the
# tree it tests has to be that commit and nothing else. Uncommitted work — staged,
# unstaged or untracked — means the tested content is not what a merge would take.
GATED_HEAD="$(git_head)" || die "could not read HEAD"
[[ "${GATED_HEAD}" =~ ^[0-9a-f]{40}$ ]] || die "HEAD is not a full object id: ${GATED_HEAD}"

if [ -n "${EXPECT_HEAD}" ]; then
  [[ "${EXPECT_HEAD}" =~ ^[0-9a-f]{40}$ ]] \
    || die "--expect-head needs a full 40-character object id, got: ${EXPECT_HEAD}"
  [ "${EXPECT_HEAD}" = "${GATED_HEAD}" ] \
    || die "HEAD is ${GATED_HEAD} but --expect-head asked for ${EXPECT_HEAD}"
fi

PREFLIGHT_DIRT="$(git_dirt)" || die "could not read the working tree state"
if [ -n "${PREFLIGHT_DIRT}" ]; then
  printf '\n%s\n' "${PREFLIGHT_DIRT}" >&2
  die "the working tree is not clean; commit or stash the above before gating, because a merge would not take it"
fi

note "repository: ${REPO_ROOT}"
note "gating:     ${GATED_HEAD}${EXPECT_HEAD:+ (matches --expect-head)}"
note "worktree:   clean"

# --- the authoritative default branch ---------------------------------------

# Which commit the branch being merged into is, established rather than
# assumed — including which branch that is. This repository's default branch is
# `main` and the gate worker's mirror may carry another name, so the name is
# read from whoever is authoritative rather than written down here. A local
# remote-tracking ref is a cache of an answer someone once got; if it is stale,
# a frozen record the default branch already carries looks like a new file to
# the append-only check and the modification is waved through. So: what the
# caller stated, or else what origin says right now. Never a ref found lying
# around.
FAILED_STEP="authoritative default branch"
if [ -n "${MASTER_OID}" ]; then
  [[ "${MASTER_OID}" =~ ^[0-9a-f]{40}$ ]] \
    || die "--master needs a full 40-character object id, got: ${MASTER_OID}"
  MASTER_SOURCE="stated by the caller"
elif git -C "${REPO_ROOT}" remote get-url origin >/dev/null 2>&1; then
  # One question, two answers: `--symref ... HEAD` says which branch origin's
  # HEAD points at and what that branch is at, so the name and the oid cannot
  # come from two different moments.
  # GIT_TERMINAL_PROMPT=0: a gate must fail, not sit waiting for a password.
  symref="$(GIT_TERMINAL_PROMPT=0 git -C "${REPO_ROOT}" ls-remote --symref origin HEAD 2>/dev/null)" \
    || die "could not read HEAD from origin; pass --master <oid> to state it"
  DEFAULT_REF="$(printf '%s\n' "${symref}" | awk '$1 == "ref:" && $3 == "HEAD" {print $2; exit}')"
  [ -n "${DEFAULT_REF}" ] \
    || die "origin did not say which branch its HEAD points at; pass --master <oid> to state it"
  MASTER_OID="$(printf '%s\n' "${symref}" | awk '$2 == "HEAD" {print $1; exit}')"
  [[ "${MASTER_OID}" =~ ^[0-9a-f]{40}$ ]] \
    || die "origin answered with no usable oid for ${DEFAULT_REF}; pass --master <oid> to state it"
  MASTER_SOURCE="read from origin (${DEFAULT_REF})"
else
  # No remote to ask. On the gate worker that is not a broken checkout, it is
  # ordinarily means a standalone local clone. The supported gate-worker path
  # always passes its dispatcher-frozen baseline explicitly; its bare cache has
  # no remote and deliberately does not mirror a branch namespace. Any caller
  # reaching this fallback therefore gets only what this checkout's own refs can
  # establish, stated in the preflight rather than silently treated as current.
  #
  # Which of the two refs, when they disagree, is not a preference: the
  # descendant is the later master, and a later baseline can only ever refuse
  # more. A checkout whose local master trails its remote-tracking ref is the
  # ordinary case and must not be the stricter answer's loser.
  #
  # The name, with no origin to ask: `refs/remotes/origin/HEAD` where a clone
  # recorded it, and otherwise the one branch of the two conventional names
  # this repository actually has. Two candidates present is not a preference to
  # resolve quietly, and none is not a default to invent.
  default_branch=""
  default_ref="$(git -C "${REPO_ROOT}" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [ -n "${default_ref}" ]; then
    default_branch="${default_ref#refs/remotes/origin/}"
  else
    for candidate in main master; do
      if git -C "${REPO_ROOT}" rev-parse --verify --quiet "refs/heads/${candidate}^{commit}" >/dev/null \
        || git -C "${REPO_ROOT}" rev-parse --verify --quiet "refs/remotes/origin/${candidate}^{commit}" >/dev/null; then
        [ -z "${default_branch}" ] \
          || die "no origin remote to ask, and this repository has both main and master; pass --master <oid>"
        default_branch="${candidate}"
      fi
    done
  fi
  [ -n "${default_branch}" ] \
    || die "no origin remote to ask and no default branch in this repository; pass --master <oid>"

  origin_master="$(git -C "${REPO_ROOT}" rev-parse --verify --quiet "refs/remotes/origin/${default_branch}^{commit}" || true)"
  local_master="$(git -C "${REPO_ROOT}" rev-parse --verify --quiet "refs/heads/${default_branch}^{commit}" || true)"
  if [ -n "${origin_master}" ] && [ -n "${local_master}" ] && [ "${origin_master}" != "${local_master}" ]; then
    if git -C "${REPO_ROOT}" merge-base --is-ancestor "${origin_master}" "${local_master}"; then
      MASTER_OID="${local_master}"; MASTER_SOURCE="refs/heads/${default_branch}, ahead of origin/${default_branch}; no origin to ask"
    elif git -C "${REPO_ROOT}" merge-base --is-ancestor "${local_master}" "${origin_master}"; then
      MASTER_OID="${origin_master}"; MASTER_SOURCE="refs/remotes/origin/${default_branch}, ahead of ${default_branch}; no origin to ask"
    else
      die "no origin remote to ask, and this repository's two ${default_branch} refs have diverged (${origin_master} / ${local_master}); pass --master <oid>"
    fi
  elif [ -n "${origin_master}" ]; then
    MASTER_OID="${origin_master}"; MASTER_SOURCE="refs/remotes/origin/${default_branch}; no origin to ask"
  elif [ -n "${local_master}" ]; then
    MASTER_OID="${local_master}"; MASTER_SOURCE="refs/heads/${default_branch}; no origin to ask"
  else
    die "no origin remote to ask and no ${default_branch} ref in this repository; pass --master <oid>"
  fi
fi
git -C "${REPO_ROOT}" cat-file -e "${MASTER_OID}^{commit}" 2>/dev/null \
  || die "${MASTER_OID} is not in this repository; run: git fetch origin"
FAILED_STEP=""
note "baseline:   ${MASTER_OID} (${MASTER_SOURCE})"

# --- the record rules ------------------------------------------------------

# Cheapest first, and first for a reason beyond cost: these read git and nothing
# else, so they are the only steps that can run before the gate has a container,
# a node_modules or a database. A documentation branch that breaks the
# append-only rule fails here in a second, and says so even on a machine where
# Docker is not running.
step "frozen records append-only" bash scripts/check-frozen-docs.sh --master "${MASTER_OID}"
# The profile classifier can omit every expensive suite, so its fixtures run
# before the result is trusted on every profile.
step "merge-gate profile fixtures" node --test scripts/merge-gate-profile.test.mjs

profile_output=""
if profile_output="$(node scripts/merge-gate-profile.mjs "${MASTER_OID}" "${GATED_HEAD}")"; then
  case "${profile_output}" in
    docs-only|full) GATE_PROFILE="${profile_output}" ;;
    *) note "profile classifier returned '${profile_output}'; using full" ;;
  esac
else
  note "profile classifier could not decide; using full"
fi
note "profile:    ${GATE_PROFILE} (selected from the exact baseline-to-candidate diff)"

if [ "${GATE_PROFILE}" = "docs-only" ]; then
  step "candidate diff whitespace" verify_candidate_diff
  step "public snapshot closed-scope scan" node scripts/public-snapshot-scan.mjs
  step "verify the gated commit did not drift" verify_tree_did_not_drift
  exit 0
fi

# --- docker ----------------------------------------------------------------

# Last of the preconditions, not the first: it is the expensive one, and the
# checks above are the ones a documentation branch actually needs to hear about.
# run-gate.sh on the worker deliberately no longer pre-checks it either, so that
# the ordering here is the ordering everywhere.
#
# Neither of these is a statement about the commit, so neither is a FAIL. A host
# with no docker daemon judged nothing, and reporting 1 here is how a dispatcher
# came to record a verdict for a commit no gate had run: it reads 1 as a
# judgement and stops looking for capacity that could have produced one.
FAILED_STEP="docker preflight"
command -v docker >/dev/null 2>&1 \
  || die_no_verdict "docker is required and this host has none: the gate runs its own throwaway PostgreSQL"
docker info >/dev/null 2>&1 || die_no_verdict "the docker daemon on this host is not reachable"
FAILED_STEP=""

# --- how much of this host the gate may use ---------------------------------

# What the gate is allowed to size itself against, and every parallel width
# derived from that one number. The derivation and the refusals that guard it
# are a unit, so they live in a file the fixtures source and run for real.
# shellcheck source=scripts/gate-worker/host-sizing.sh
. "${SCRIPT_DIR}/gate-worker/host-sizing.sh"

# --- isolation --------------------------------------------------------------

say "Isolating every host path the suites could default to"
GATE_TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/agentos-merge-gate.XXXXXXXX")" && pwd -P)"
RUNNER_WORKSPACE_ROOT="${GATE_TMP}/workspace-root"
CONTROL_PLANE_STATE_DIR="${GATE_TMP}/control-plane-state"
FILES_ROOT="${GATE_TMP}/files-root"
mkdir -p "${RUNNER_WORKSPACE_ROOT}" "${CONTROL_PLANE_STATE_DIR}" "${FILES_ROOT}"
chmod 700 "${RUNNER_WORKSPACE_ROOT}" "${CONTROL_PLANE_STATE_DIR}" "${FILES_ROOT}"
export RUNNER_WORKSPACE_ROOT CONTROL_PLANE_STATE_DIR FILES_ROOT

# The paths the application resolves to when these variables are unset:
# ~/.agentos/runs, ~/.agentos/control-plane and ~/Documents/agentos. #108 made
# the application refuse the first two; a gate that trusts the code it is gating
# is not a gate, so the substitution is checked here as well.
PRODUCTION_ROOTS=("${HOME}/.agentos" "${HOME}/Documents/agentos" "${REPO_ROOT}")
for var in RUNNER_WORKSPACE_ROOT CONTROL_PLANE_STATE_DIR FILES_ROOT; do
  dir="${!var:-}"
  [ -n "${dir}" ] || die "${var} is unset"
  [ -d "${dir}" ] || die "${var}=${dir} is not a directory"
  [ -z "$(ls -A "${dir}")" ] || die "${var}=${dir} is not empty"
  case "${dir}" in "${GATE_TMP}"/*) ;; *) die "${var}=${dir} escaped ${GATE_TMP}" ;; esac
  for real in "${PRODUCTION_ROOTS[@]}"; do
    if overlaps "${dir}" "${real}"; then die "${var}=${dir} overlaps ${real}"; fi
  done
  note "${var}=${dir}"
done
# The API refuses to start when the Files Root overlaps the workspace root in
# either direction, and the ownership dbtest starts a real API.
if overlaps "${RUNNER_WORKSPACE_ROOT}" "${FILES_ROOT}"; then
  die "RUNNER_WORKSPACE_ROOT and FILES_ROOT overlap"
fi

# The same isolation for the variables that change what the suites do rather
# than where they write. AGENTOS_GATE_SERVER is the one that proved it matters:
# a session configured to reach a gate worker exports it, gate-dispatch.sh reads
# it as "one server, no fallback", and the gate-worker fixtures then wait out
# their dispatcher's timeout for a slot that cannot open — a host setting
# deciding the outcome of a test about topology. Everything this gate needs from
# that namespace has already been read into GATE_* and POSTGRES_IMAGE above, so
# unsetting the namespace here costs the gate nothing.
say "Isolating the host gate configuration the suites could inherit"
for var in $(compgen -e || true); do
  case "${var}" in
    AGENTOS_GATE_* | GATE_DISPATCH_*)
      unset "${var}"
      note "unset ${var}"
      ;;
  esac
done

# --- throwaway postgres -----------------------------------------------------

# This server is deleted when the script exits, so every guarantee it makes
# about surviving a crash is spent on nothing. The dbtests are ~80% of a gate
# and they are dominated by that spending: real Postgres, one shared server,
# serial. So the data directory is a tmpfs and the durability machinery is off.
#
# What this does NOT change is what the tests observe. fsync, synchronous_commit
# and full_page_writes decide when writes reach the disk, never what a
# transaction sees: isolation, constraints, locks, advisory locks, sequences and
# every query plan behave identically. The one property given up is that a
# gate whose machine loses power mid-run leaves a recoverable database — a
# database that is deleted seconds later either way.
#
# PGDATA is named explicitly even though it is the image default: the tmpfs is
# only worth anything if it is mounted exactly where the server writes, and if
# those two ever disagreed the mount would silently do nothing while still
# looking right here.
#
# The size is a ceiling, not a reservation — tmpfs pages are allocated as used,
# and a fresh cluster is ~45MB. max_wal_size is bounded to match: the default
# lets WAL grow to 1GB before forcing a checkpoint, which on a 4GB worker is the
# one way a data directory in RAM could run the machine out of it. Checkpoints
# are cheap here precisely because fsync is off.
#
# What the ceiling actually has to cover is not the cluster: the database wave
# gives every *.dbtest.ts file its own `CREATE DATABASE ... TEMPLATE` copy and
# creates all of them before the first test runs, so the data directory holds
# one physical copy per file for the whole wave. At 1024m that headroom ran out
# three files after the suite reached 62 — every splitting a test file for
# concurrency would have hit it, and it surfaces as `53100: could not extend
# file ... No space left on device` from whichever query happened to be running,
# which reads like a test failure and is not one. It is raised rather than
# reasoned about per file count, because the number of test files is not
# something a change to them should have to check against a constant here.
# Nothing is reserved by raising it: what a run actually writes is unchanged.
#
# Started here and waited for later. initdb takes a few seconds during which
# this gate has an npm ci and two install-free suites to be getting on with, and
# nothing between here and the wait touches the server. The wait is still its
# own step with its own verdict, so a server that never arrives fails as
# plainly as it did when the wait was on this line.
say "Starting a throwaway PostgreSQL (${POSTGRES_IMAGE}, tmpfs data directory, durability off)"
docker run -d --rm --name "${CONTAINER}" \
  -e POSTGRES_USER=agentos -e POSTGRES_PASSWORD=gate-scratch-fixture-password-000000 \
  -e POSTGRES_DB=agentos_gate \
  -e PGDATA=/var/lib/postgresql/data \
  --tmpfs /var/lib/postgresql/data:rw,size=3072m \
  -p 127.0.0.1::5432 "${POSTGRES_IMAGE}" \
  -c fsync=off \
  -c synchronous_commit=off \
  -c full_page_writes=off \
  -c max_connections=200 \
  -c max_wal_size=256MB >/dev/null \
  || die "could not start ${POSTGRES_IMAGE}"
POSTGRES_STARTED=1

PGPORT="$(docker port "${CONTAINER}" 5432/tcp | head -1 | sed 's/.*://')"
[ -n "${PGPORT}" ] || die "the container published no port"
# Self-check: 5432 is where docker-compose.yml puts the real local database.
[ "${PGPORT}" != "5432" ] || die "refusing a container published on 5432"

await_postgres() {
  local waited
  for waited in $(seq 1 90); do
    if docker exec "${CONTAINER}" pg_isready -U agentos -d agentos_gate -q >/dev/null 2>&1; then
      printf 'ready after at most %ss\n' "${waited}"
      return 0
    fi
    sleep 1
  done
  printf 'PostgreSQL did not become ready within 90s\n' >&2
  return 1
}
note "127.0.0.1:${PGPORT}, database agentos_gate, deleted when this script exits"

# The database is called agentos_gate rather than agentos, and the schema is a
# dedicated non-public one: the dbtest harness drops and re-applies whatever
# schema it is given, and the scratch-database manager refuses a source database
# named agentos.
# Not "agentos": startup-config.ts lists the compose default in WEAK_SECRET_VALUES,
# and spawn-type dbtests derive POSTGRES_PASSWORD from this URL, so a placeholder
# here makes the spawned API refuse to start. Fixture value, ≥24 chars on purpose.
export TEST_DATABASE_URL="postgresql://agentos:gate-scratch-fixture-password-000000@127.0.0.1:${PGPORT}/agentos_gate?schema=agentos_gate"
export TEST_DATABASE_MAINTENANCE_URL="postgresql://agentos:gate-scratch-fixture-password-000000@127.0.0.1:${PGPORT}/postgres"
# Pointing DATABASE_URL at the same throwaway server closes the last hole: a
# subprocess that reads it — including one that would otherwise pick it up from
# a repository .env — lands in the container, never on a real database.
export DATABASE_URL="${TEST_DATABASE_URL}"
# Lets control-plane-ownership.dbtest.ts run its real-process acceptance instead
# of skipping it. That test is the closest thing the suite has to a replay of the
# incident, so a gate that silently skips it is worth very little.
export AGENTOS_ALLOW_SCRATCH_DATABASES=1

# --- the full gate ----------------------------------------------------------

# `--prefer-offline` reuses the worker's own `~/.npm` content-addressed cache
# instead of re-asking the registry for metadata it already has; a tarball
# missing from the cache is still fetched. `--no-audit` and `--no-fund` drop two
# network round trips whose output nobody reads here. None of the three can
# change *which* versions land: `npm ci` installs the closed set in
# `package-lock.json` and fails rather than resolving anything, and a cached
# tarball is keyed by the integrity hash the lockfile records — a cache hit is
# therefore a hit on exactly the bytes the lockfile names. Every full run invokes
# npm ci so lifecycle scripts and Prisma generation run under this run's actual
# environment; only npm's tarball cache is reused.
# Three groups, in the only order their dependencies allow. What every step
# proves is unchanged; what changed is how many of them are in flight. The gate
# was an eighteen-step chain, and on a twelve-core worker that left most of the
# machine idle for most of a run.
#
# The install-free suites move here to sit alongside `npm ci`. They import
# nothing but `node:` builtins — that is the property that made them install-free
# in the first place — so `npm ci` emptying and refilling node_modules beside
# them cannot reach them, and the dependency install stops being a step nothing
# else overlaps.
#
# What they cover: the frozen-record checker, because PR #156 shipped one whose
# date-prefix rule was unreachable by construction and nothing ran to say so;
# the worker's slot locks, exit codes and remote-shell allowlists, because
# merge-gate.sh is this repository's only CI and a concurrency invariant nobody
# re-checks is one that decays; the grouping mechanism this plan is built on,
# whose failure reporting is invisible on every run that passes; and the build
# layering, where a layer ordered too early compiles a workspace against a
# sibling's stale dist/ and passes.
parallel_steps "dependencies and the install-free suites" \
  "npm ci" install_dependencies :: \
  "frozen-record checker fixtures" node --test scripts/check-frozen-docs.test.mjs :: \
  "operator API handbook coverage" node --test scripts/operator-api-docs.test.mjs :: \
  "host proof slot fixtures" node --test scripts/host-proof-slot.test.mjs :: \
  "delivery concurrency and gate worker fixtures" node --test scripts/gate-worker/gate-env.test.mjs scripts/gate-worker/gate-worker.test.mjs scripts/gate-worker/gate-dispatch.test.mjs scripts/merge-lease.test.mjs scripts/merge-train.test.mjs :: \
  "parallel-group fixtures" node --test scripts/merge-gate-parallel.test.mjs :: \
  "build layer fixtures" node --test scripts/build-layers.test.mjs

# The container has had that whole group to finish initdb in. This is still a
# step with its own verdict: a server that never arrives fails here and says so.
step "throwaway PostgreSQL is accepting connections" await_postgres

# Everything that needs dependencies but not build output. These were seven
# serial steps whose slowest two were the only ones doing real work; lint and
# build are now the width of the group rather than the sum of it.
#
# None of them reads dist/: they ran before the build when the gate was serial,
# and both linters exclude `**/dist/**` by configuration. The snapshot scan
# reads `git ls-tree`, not the worktree, so a build writing ignored output
# underneath it is not something it can observe.
#
# The lint gate (#143) is Biome's opt-in safety rules plus the one type-aware
# rule (no-floating-promises) through typescript-eslint. Both are npm
# dependencies and neither shells out, so the remote worker runs it unchanged.
# Formatting is deliberately not checked — see biome.jsonc.
#
# The migration needs the server and dependencies, not the build, so it belongs
# in this group too. prisma resolves its schema from the working directory,
# which is why it runs inside packages/db rather than at the repository root.
parallel_steps "static analysis, build, and the suites that need no build output" \
  "build (all workspaces)" build_all :: \
  "lint (biome + type-aware no-floating-promises)" parallel_lint :: \
  "quiet-window auto-deploy harness" npm run test:auto-deploy :: \
  "typecheck (database CLI)" npm run typecheck:cli :: \
  "run-scope guard fixtures" npm run test:run-scope-guard :: \
  "public snapshot scanner tests" npm run test:snapshot-scan :: \
  "public snapshot closed-scope scan" npm run snapshot:scan :: \
  "release documentation executable contract" npm run test:release-docs :: \
  "templates release-demo harness" npm run test:demo-templates :: \
  "migrate the gate schema" sh -c 'cd packages/db && npx prisma migrate deploy'

# The proof waves. apps/web's CSS regression test reads the built stylesheet out
# of apps/web/dist and the dbtests spawn the real API out of packages/api/dist,
# so this group is what the build above was blocking.
#
# Both packages' pretest:db hooks only rebuild subsets of the full build that
# just passed, so the shared DBTEST runner is invoked directly and each file
# still receives a cloned database and private host roots.
#
# These were serial, and the reason recorded here was that running them together
# "exceeded the machine budget" and turned passing suites into transaction and
# unit-test timeouts. That was measured on the four-core, 4 GiB fallback worker.
# The budget is now stated rather than assumed: each wave's fan-out is derived
# from the share of the host this gate was given, so two concurrent gates on a
# two-slot worker still add up to one machine. The unit wave is processor-bound;
# the database wave is mostly waiting on PostgreSQL. Overlapping them spends one
# wave's idle on the other's work.
parallel_steps "the proof waves" \
  "database tests (db + api)" run_database_tests :: \
  "unit tests (all workspaces)" parallel_unit_tests

step "verify the gated commit did not drift" verify_tree_did_not_drift
publish_deferred_build_snapshot
publish_release_snapshot
