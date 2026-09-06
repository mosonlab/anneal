#!/usr/bin/env bash
#
# Frozen-record check (CONTRIBUTING.md "Records that do not change"). Two mechanical rules, and one
# statement of what is deliberately not mechanical.
#
#   1. Append-only directories. docs/reviews, docs/merge-notes, docs/briefs and
#      docs/plans/archive hold dated records of finished work. Once a file there
#      is on main it is history: a branch may add files, but may not modify or
#      delete one. Every file a branch adds there must carry a YYYY-MM-DD-
#      basename prefix, which is the half of the convention the first version of
#      this script wrote down in CONTRIBUTING.md and then never checked.
#
#      One rename is allowed: a byte-identical rename inside the same frozen
#      directory to a dated name. That is the only way a record merged under a
#      wrong name can be corrected without rewriting history, and it destroys
#      nothing — the content is unchanged and stays in the same directory. A
#      rename that also edits the file is not a rename here (100% similarity is
#      required), so it arrives as a delete plus an add and is refused.
#
#   2. Supersession markers. A doc replaced elsewhere carries a leading
#      "> Superseded by <path> (YYYY-MM-DD)" line. Wherever a line beginning
#      "> Superseded by " appears in a tracked *.md file, it must be the first
#      line of that file, in exactly that shape, naming a path this commit
#      tracks, dated plausibly, and appearing once.
#
#      What this cannot decide is whether a doc that *should* be marked is:
#      nothing in a diff says "this document stopped being authority". So the
#      gate enforces the marker's form, never its presence. CONTRIBUTING.md
#      says the same thing; do not quote this script as enforcing more than that.
#
# Baseline. The rules are about what is already on main, so the answer depends
# entirely on which commit "main" is. In order:
#
#   --master <oid> (or AGENTOS_MASTER_OID) — the authoritative baseline, bound by
#     the caller. This is what the gate always passes: merge-gate.sh takes the
#     oid from its own caller or asks origin, and run-gate.sh carries it onto a
#     worker that cannot ask anyone. A ref is a cache; an oid is a decision.
#   otherwise refs/remotes/origin/main and refs/heads/main, for a human
#     running this by hand — and it says on stderr that the answer is only as
#     fresh as the last fetch and is not gate authority. A stale baseline
#     turns a modification of a frozen file into an addition and waves it
#     through, so the older ref is never silently preferred: when the two
#     disagree, the one that is a descendant of the other wins (a later
#     baseline can only refuse more), and when they have diverged the check
#     refuses to guess. Neither ref can be proved fresh from inside this
#     repository; that is what --master is for.
#
# Compares HEAD against its merge-base with that baseline. Gating main itself
# makes the diff empty and passes trivially.
#
# Runs inside the merge gate, reads only git, writes nothing.

set -euo pipefail

FROZEN_RECORD_DIRECTORIES=(docs/reviews docs/merge-notes docs/briefs docs/plans/archive)

MASTER_OID="${AGENTOS_MASTER_OID:-}"

die() { printf 'check-frozen-docs: %s\n' "$1" >&2; exit 1; }

usage() {
  printf 'usage: check-frozen-docs.sh [--master <40-hex oid>]\n' >&2
  exit "${1:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --master)
      [ $# -ge 2 ] || die "--master needs an object id"
      MASTER_OID="$2"; shift ;;
    --master=*) MASTER_OID="${1#--master=}" ;;
    -h|--help) usage 0 ;;
    *) printf 'check-frozen-docs: unknown argument %s\n' "$1" >&2; usage ;;
  esac
  shift
done

# --- baseline ---------------------------------------------------------------

baseline_oid=""
baseline_source=""

if [ -n "${MASTER_OID}" ]; then
  case "${MASTER_OID}" in
    *[!0-9a-fA-F]*) die "--master needs a hexadecimal object id, got: ${MASTER_OID}" ;;
  esac
  [ "${#MASTER_OID}" -eq 40 ] || die "--master needs a full 40-character object id, got: ${MASTER_OID}"
  MASTER_OID="$(printf '%s' "${MASTER_OID}" | tr '[:upper:]' '[:lower:]')"
  git cat-file -e "${MASTER_OID}^{commit}" 2>/dev/null \
    || die "the authoritative baseline ${MASTER_OID} is not a commit in this repository"
  baseline_oid="${MASTER_OID}"
  baseline_source="authoritative oid"
else
  origin_oid="$(git rev-parse --verify --quiet "refs/remotes/origin/main^{commit}" || true)"
  local_oid="$(git rev-parse --verify --quiet "refs/heads/main^{commit}" || true)"
  if [ -n "${origin_oid}" ] && [ -n "${local_oid}" ] && [ "${origin_oid}" != "${local_oid}" ]; then
    # Disagreement is the interesting case, because the older ref is the one
    # that turns a modification of a frozen file into an addition and lets it
    # through. When one ref is an ancestor of the other the answer is not a
    # preference: the descendant is the later main, and a later baseline can
    # only ever refuse more, so it is taken. A stale local main — the normal
    # state of a checkout that works on branches — is therefore not an error.
    # Divergence is different: neither ref is a version of the other, nothing
    # here can say which is authority, and the check refuses.
    if git merge-base --is-ancestor "${origin_oid}" "${local_oid}"; then
      baseline_oid="${local_oid}"; baseline_source="heads/main, ahead of origin/main"
    elif git merge-base --is-ancestor "${local_oid}" "${origin_oid}"; then
      baseline_oid="${origin_oid}"; baseline_source="remotes/origin/main, ahead of main"
    else
      printf 'check-frozen-docs: the two main refs have diverged, so which one is authority is unknown:\n' >&2
      printf '  refs/remotes/origin/main %s\n' "${origin_oid}" >&2
      printf '  refs/heads/main          %s\n' "${local_oid}" >&2
      die "refusing to pick one; reconcile them, or pass --master <oid>"
    fi
  elif [ -n "${origin_oid}" ]; then
    baseline_oid="${origin_oid}"; baseline_source="remotes/origin/main"
  elif [ -n "${local_oid}" ]; then
    baseline_oid="${local_oid}"; baseline_source="heads/main"
  else
    die "no main ref to compare against; pass --master <oid>"
  fi
fi

if [ -z "${MASTER_OID}" ]; then
  # Said out loud every time, because the failure it warns about is silent: a ref
  # is only as fresh as the last fetch, and a baseline that is behind reads a
  # modified frozen record as a new file. The gate never sees this line —
  # merge-gate.sh always passes --master — and a human running this by hand
  # should know which of the two answers they are getting.
  printf 'check-frozen-docs: no --master given; using %s at %.12s, which is only as fresh as the last fetch and is not gate authority\n' \
    "${baseline_source}" "${baseline_oid}" >&2
fi

base="$(git merge-base HEAD "${baseline_oid}")" \
  || die "no merge-base between HEAD and ${baseline_source} ${baseline_oid}"

# --- helpers ----------------------------------------------------------------

violations=""
violation() { violations="${violations}${violations:+$'\n'}  $1"; }

# The frozen directory a path lives in, or nothing.
frozen_root_of() {
  local path="$1" root
  for root in "${FROZEN_RECORD_DIRECTORIES[@]}"; do
    case "${path}" in "${root}"/*) printf '%s' "${root}"; return 0 ;; esac
  done
  return 1
}

# Not a calendar, a plausibility check: it rejects 2026-13-40 and 0000-00-00,
# which is what a typo looks like, and does not try to know about February.
plausible_date() {
  local y="$1" m="$2" d="$3"
  [ "$((10#${y}))" -ge 2000 ] && [ "$((10#${y}))" -le 2999 ] || return 1
  [ "$((10#${m}))" -ge 1 ] && [ "$((10#${m}))" -le 12 ] || return 1
  [ "$((10#${d}))" -ge 1 ] && [ "$((10#${d}))" -le 31 ] || return 1
}

dated_basename() {
  local name="${1##*/}"
  [[ "${name}" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})- ]] || return 1
  plausible_date "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
}

added=0
check_added() {
  local path="$1"
  added=$((added + 1))
  dated_basename "${path}" \
    || violation "new record is not named YYYY-MM-DD-…: ${path}"
}

# --- rule 1: the frozen directories are append-only -------------------------

# -z because a path is bytes, not a line, and rename detection at 100% because
# only a byte-identical rename is a rename for this purpose. -l0 lifts the rename
# limit: a diff large enough to hit the default would silently stop pairing
# renames and report the allowed one as a deletion. Paths outside the four
# directories are not in the diff at all, so a plan moved in from docs/plans/
# arrives here as an addition, which is what it is.
#
# Written to a file and checked, rather than read from `< <(git diff ...)`: a
# process substitution's exit status is not the shell's, so a git that failed
# would reach the loop as an empty diff and this check would report that nothing
# was touched. NUL-separated output cannot survive a command substitution
# either, which is why this is a file and not a variable.
DIFF_OUTPUT="$(mktemp "${TMPDIR:-/tmp}/agentos-frozen-docs.XXXXXXXX")" \
  || die "could not create a temporary file for the diff"
trap 'rm -f -- "${DIFF_OUTPUT}"' EXIT

git diff --find-renames=100% -l0 --name-status -z "${base}" HEAD -- "${FROZEN_RECORD_DIRECTORIES[@]}" > "${DIFF_OUTPUT}" \
  || die "git diff against ${base} failed; the append-only rule was not established"

while IFS= read -r -d '' code; do
  old=""; new=""; path=""
  case "${code}" in
    R*|C*)
      IFS= read -r -d '' old || die "truncated diff output while reading a rename source"
      IFS= read -r -d '' new || die "truncated diff output while reading a rename destination"
      ;;
    *)
      IFS= read -r -d '' path || die "truncated diff output while reading a path"
      ;;
  esac

  case "${code}" in
    A)
      check_added "${path}" ;;
    R100)
      source_root="$(frozen_root_of "${old}" || true)"
      if [ -z "${source_root}" ]; then
        # Moved in from outside: an addition here, and nothing frozen was lost.
        check_added "${new}"
      elif [ "$(frozen_root_of "${new}" || true)" != "${source_root}" ]; then
        violation "a merged record was moved between frozen directories: ${old} -> ${new}"
      elif ! dated_basename "${new}"; then
        violation "a record was renamed but still is not named YYYY-MM-DD-…: ${old} -> ${new}"
      fi
      ;;
    M|T)
      violation "frozen record modified: ${path}" ;;
    D)
      violation "frozen record deleted: ${path}" ;;
    *)
      violation "unexpected diff status ${code}: ${path:-${old} -> ${new}}" ;;
  esac
done < "${DIFF_OUTPUT}"

# --- rule 2: supersession markers are well formed ---------------------------

markers=0
# git grep exits 1 for "nothing matched" and 2 for "it went wrong", and the
# difference is the difference between "no doc claims to be superseded" and
# "this check did not run".
marker_files="$(git grep -I -l -e '^> Superseded by ' HEAD -- '*.md')" || case $? in
  1) marker_files="" ;;
  *) die "git grep for supersession markers failed; the marker rule was not established" ;;
esac
while IFS= read -r entry; do
  [ -n "${entry}" ] || continue
  path="${entry#HEAD:}"
  markers=$((markers + 1))
  content="$(git show "HEAD:${path}")"
  first="${content%%$'\n'*}"
  count="$(printf '%s\n' "${content}" | grep -c '^> Superseded by ' || true)"
  [[ "${count}" =~ ^[0-9]+$ ]] || die "could not count the supersession markers in ${path}"

  if [ "${count}" -ne 1 ]; then
    violation "${count} supersession markers in one file; a doc is superseded once: ${path}"
    continue
  fi
  if [[ ! "${first}" =~ ^\>\ Superseded\ by\ ([^[:space:]\(\)]+)\ \(([0-9]{4})-([0-9]{2})-([0-9]{2})\)$ ]]; then
    violation "supersession marker must be the first line and read exactly '> Superseded by <path> (YYYY-MM-DD)': ${path}"
    continue
  fi
  target="${BASH_REMATCH[1]}"
  if ! plausible_date "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"; then
    violation "supersession marker carries an impossible date: ${path}"
    continue
  fi
  if [ "${target}" = "${path}" ]; then
    violation "supersession marker points at its own file: ${path}"
    continue
  fi
  git cat-file -e "HEAD:${target}" 2>/dev/null \
    || violation "supersession marker names a path this commit does not track: ${path} -> ${target}"
done <<< "${marker_files}"

# --- verdict ----------------------------------------------------------------

if [ -n "${violations}" ]; then
  printf 'frozen records (CONTRIBUTING.md "Records that do not change"), against merge-base %.12s of %s:\n%s\n' \
    "${base}" "${baseline_source}" "${violations}" >&2
  exit 1
fi

printf 'frozen records intact since merge-base %.12s (%s): %s record(s) added, %s supersession marker(s) well formed\n' \
  "${base}" "${baseline_source}" "${added}" "${markers}"
