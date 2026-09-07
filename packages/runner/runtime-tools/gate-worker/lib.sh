# Shared by merge-gate.sh, run-gate.sh and the local-side gate-worker scripts
# (mirror-push.sh, remote-gate.sh, gate-dispatch.sh). Not executable on its own;
# source it.
#
# Three things live here: the values that travel into a remote shell command
# string, the slot locks that ration how many gates run at once, and the gate's
# verdict — the exit codes, the four lines and the reader that recovers one from
# a log. All three are places where being approximately right is the same as
# being wrong.
#
# run-gate.sh runs on the worker, where this file sits beside it because
# mirror-push.sh installs the pair. Nothing here may assume a repository
# checkout around it.

# --- values that reach a remote shell ---------------------------------------
#
# The trust boundary is here, not at the ssh call. Every one of these values is
# interpolated into a command string that a remote login shell parses, so each
# is validated against an allowlist and refused — never quoted, never escaped —
# when it falls outside. The two oids are validated by their callers as 40
# lowercase hex characters, which is the same discipline stated once per script.

# The repository's identity on the worker is the origin repository's name, not
# the checkout's directory name: two worktrees of one repository must land in
# one mirror, and renaming a local directory must not orphan the mirror it has
# been pushing to. A checkout with no origin falls back to its directory name,
# which is the best identity it has.
gate_repo_name() {
  local root="$1" url="" name=""
  url="$(git -C "$root" remote get-url origin 2>/dev/null || true)"
  if [ -n "$url" ]; then
    name="${url%/}"
    name="${name%.git}"
    name="${name##*/}"
    name="${name##*:}"
  else
    name="$(basename "$(cd "$root" && pwd -P)")"
  fi
  # The name becomes a path segment on the worker and travels through an ssh
  # command line, so anything outside this character set is refused, not quoted.
  # `.` and `..` pass that character test and are still not names: `.` collapses
  # a repository's directory back onto the gate root itself, folding every
  # repository's mirror, worktrees and harness together, and `..` walks out of
  # the gate root entirely. A leading `-` would be read as an option by whatever
  # the path is handed to.
  case "$name" in
    ''|.|..|-*|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  printf '%s' "$name"
}

# The gate root on the worker, relative to the remote account's $HOME, from
# --gate-home or $GATE_HOME. It is interpolated into ssh command strings that a
# remote login shell parses, so a value carrying a space, a `;`, a `$(...)` or a
# quote is remote shell syntax, not a path. Slash-separated segments of the same
# character set as a repository name, no absolute path, no `.` or `..` segment,
# no leading `-`.
gate_valid_home() {
  local home="$1" rest="" segment=""
  case "$home" in
    ''|/*|-*) return 1 ;;
  esac
  rest="$home"
  while [ -n "$rest" ]; do
    segment="${rest%%/*}"
    if [ "$segment" = "$rest" ]; then
      rest=""
    else
      rest="${rest#*/}"
      # `a//b` and a trailing slash both produce an empty segment; refuse rather
      # than normalise, because the caller wrote something they did not mean.
      [ -n "$rest" ] || return 1
    fi
    case "$segment" in
      ''|.|..|-*|*[!A-Za-z0-9._-]*) return 1 ;;
    esac
  done
  printf '%s' "$home"
}

# The ssh destination. It is an argv element rather than command-string text, so
# it cannot become remote shell syntax, but it is also pasted into the
# scp-style `host:path` address git and scp are handed, where a stray `:` splits
# the address somewhere nobody meant. A Host alias or user@host, and nothing
# with a character that has a meaning in that address.
gate_valid_server() {
  local server="$1"
  case "$server" in
    ''|-*|*[!A-Za-z0-9._@-]*) return 1 ;;
  esac
  printf '%s' "$server"
}

# A branch ref read back from origin's HEAD symref before it is named in a
# remote command string. Origin is not this machine, so what it answers is
# input, not fact.
gate_valid_ref() {
  local ref="$1" rest="" segment=""
  case "$ref" in
    refs/heads/?*) ;;
    *) return 1 ;;
  esac
  rest="${ref#refs/heads/}"
  while [ -n "$rest" ]; do
    segment="${rest%%/*}"
    if [ "$segment" = "$rest" ]; then
      rest=""
    else
      rest="${rest#*/}"
      [ -n "$rest" ] || return 1
    fi
    case "$segment" in
      ''|.|..|-*|*[!A-Za-z0-9._-]*) return 1 ;;
    esac
  done
  printf '%s' "$ref"
}

# --- slot locks --------------------------------------------------------------
#
# One lock per slot, under a root outside any repository, because the slots
# belong to the machines rather than to a checkout.
#
# The lock is a FILE created with `ln`, not a directory created with `mkdir`.
# link(2) is the only atomic create-or-fail that also carries the holder's
# identity: the pid is written to the staged file before that file has the
# lock's name, so the instant the lock exists it already names its owner. A
# directory cannot do that. `mkdir` creates it empty and its pid file appears a
# moment later, and inside that window another dispatcher reads "no pid",
# concludes the lock was abandoned, deletes it and creates its own — after which
# both run a gate in one slot and the capacity limit is gone. Removing that
# window is the whole reason for this shape.
#
# Reclaiming a lock whose holder died is the other half, and deleting it is not
# how: two dispatchers that both see the holder dead would both delete and both
# create. Instead the lock is hard-linked to a witness name derived from the
# dead pid. `ln` fails with EEXIST, so exactly one of them wins the right to
# reclaim that pid's lock; the winner confirms the witness still names the pid
# it judged dead — proving the lock was not replaced underneath it — and then
# replaces the lock with `mv`, a rename, so the lock is never absent and no
# third dispatcher can put a claim into a gap. A lock whose pid is still alive
# is left alone even though pids are recycled: waiting out a slot that was
# really free is the only direction this check is allowed to be wrong in.

# Three outcomes, not two. "Somebody is running a gate in this slot" and "this
# slot's lock cannot be operated" are different facts and the caller acts on
# them differently: the first is worth waiting out, the second never resolves on
# its own. Collapsing them is how a read-only cache directory turned into
# "every slot busy" and a 75 that said the queue was full when nothing had ever
# been able to take a lock.
GATE_SLOT_HELD=0
GATE_SLOT_BUSY=1
GATE_SLOT_BROKEN=2

gate_slot_path() { printf '%s/%s.slot' "$1" "$2"; }

# Who holds this slot right now, as the pid the lock names, or nothing when the
# lock is absent or unreadable. It is an observation and never a decision: a
# waiting dispatcher compares it across polls to tell a queue that is moving
# from one that is stuck, and only gate_slot_try may act on a slot.
gate_slot_holder() {
  local holder
  holder="$(cat "$(gate_slot_path "$1" "$2")" 2>/dev/null || true)"
  case "$holder" in
    ''|*[!0-9]*) return 0 ;;
  esac
  printf '%s' "$holder"
}

# 0 held, 1 busy, 2 broken. Every non-zero return prints its reason on stderr
# except the ordinary one, which is that another dispatcher holds the slot.
gate_slot_try() {
  local root="$1" slot="$2"
  local lock staged holder witness observed
  lock="$(gate_slot_path "$root" "$slot")"

  # A lock directory left by the pre-#132 dispatcher, which this shape cannot
  # see and which an older dispatcher may still be holding. Refusing is the only
  # safe reading: the two implementations do not exclude each other, so treating
  # it as absent is how one physical slot becomes two concurrent gates.
  # Broken rather than busy: an old dispatcher may or may not be holding it, and
  # this implementation cannot tell which. "I cannot determine whether this slot
  # is occupied" is a mechanism failure that a person has to clear, not a queue
  # to wait in.
  if [ -d "${root}/${slot}.lock" ]; then
    printf 'gate-slot: %s/%s.lock is an old-format slot lock; clear it once no old gate-dispatch.sh is running\n' \
      "$root" "$slot" >&2
    return "$GATE_SLOT_BROKEN"
  fi

  staged="${root}/.staged.${slot}.$$.${RANDOM}"
  if ! printf '%s\n' "$$" > "$staged" 2>/dev/null; then
    # A slot root that cannot be written to — read-only, full, wrong owner — is
    # not a busy slot. Nothing will free up, so saying "busy" here is what makes
    # a dispatcher poll for an hour and then report a full queue.
    printf 'gate-slot: could not write a lock under %s; the slot root is not usable\n' "$root" >&2
    rm -f -- "$staged" 2>/dev/null || true
    return "$GATE_SLOT_BROKEN"
  fi

  if ln "$staged" "$lock" 2>/dev/null; then
    rm -f -- "$staged"
    return 0
  fi

  # Occupied — or freed between the attempt and this line, in which case there
  # is nothing to diagnose and the next poll will take it.
  if [ ! -e "$lock" ]; then
    rm -f -- "$staged"
    return "$GATE_SLOT_BUSY"
  fi

  holder="$(cat "$lock" 2>/dev/null || true)"
  case "$holder" in
    ''|*[!0-9]*)
      # Never reclaimed. A lock that names no pid is not evidence that nobody
      # holds it; it is evidence that something wrote a file this script did
      # not. Blocking the slot until a person looks is the side to be wrong on.
      printf 'gate-slot: %s names no pid (%s); refusing to reclaim it — clear it by hand once no gate is running\n' \
        "$lock" "${holder:-empty}" >&2
      rm -f -- "$staged"
      return "$GATE_SLOT_BROKEN" ;;
  esac

  if kill -0 "$holder" 2>/dev/null; then
    rm -f -- "$staged"
    return "$GATE_SLOT_BUSY"
  fi

  witness="${root}/.reclaim.${slot}.${holder}"
  if ! ln "$lock" "$witness" 2>/dev/null; then
    # Busy, not broken: winning this link is how one of two dispatchers becomes
    # the reclaimer, so losing it means another one is mid-reclaim on this slot
    # right now. It is contention, and it clears in the time two syscalls take.
    printf 'gate-slot: another dispatcher is reclaiming %s; if that never completes, clear %s\n' \
      "$lock" "$witness" >&2
    rm -f -- "$staged"
    return "$GATE_SLOT_BUSY"
  fi
  observed="$(cat "$witness" 2>/dev/null || true)"
  if [ "$observed" != "$holder" ]; then
    # The lock was replaced between reading it and linking it, so what got
    # linked is somebody's live claim. Nothing was modified: drop the witness
    # and lose the round.
    rm -f -- "$witness" "$staged"
    return "$GATE_SLOT_BUSY"
  fi
  if ! mv -f -- "$staged" "$lock" 2>/dev/null; then
    printf 'gate-slot: could not replace the stale lock %s\n' "$lock" >&2
    rm -f -- "$witness" "$staged"
    return "$GATE_SLOT_BROKEN"
  fi
  rm -f -- "$witness"
  printf 'gate-slot: reclaimed slot %s (pid %s is gone)\n' "$slot" "$holder" >&2
  return 0
}

# Only ever removes a lock this process still owns. A lock naming somebody else
# was reclaimed while this process was not looking, and removing it would free a
# slot its new holder is running a gate in.
gate_slot_release() {
  local root="$1" slot="$2" lock holder
  lock="$(gate_slot_path "$root" "$slot")"
  holder="$(cat "$lock" 2>/dev/null || true)"
  if [ "$holder" = "$$" ]; then
    rm -f -- "$lock"
    return 0
  fi
  printf 'gate-slot: not releasing slot %s, it is now held by pid %s\n' "$slot" "${holder:-nobody}" >&2
  return 1
}

# --- the verdict -------------------------------------------------------------
#
# The gate's verdict crosses four processes — merge-gate.sh forms it,
# run-gate.sh reads it back off a log on the worker, remote-gate.sh carries it
# over ssh, gate-dispatch.sh decides from it — and before this section existed
# each hop re-encoded it from prose. That is how run-gate.sh came to grep for
# `MERGE GATE: ` alone: it could not match the `GATE NOT RUN:` line merge-gate.sh
# prints when a run is stopped, so the gate's own reason was replaced with a
# reconstructed one that said no line had been printed, and the signal exit code
# the runbook promises was replaced with 76. One writer and one reader of the
# wire format is the fix; the format itself is unchanged and is public API.
#
# AGENTS.md requires the literal string `MERGE GATE: PASS <oid>` for a merge,
# two agent prompt templates read these lines, and docs/runbooks/gate-worker.md
# publishes the codes to operators. Nothing here may change a byte of either
# without changing those first.

# The four codes a gate run can end on. A verdict and the absence of a verdict
# never share a code: 1 is the only one that says the commit was judged and did
# not pass. 2 (usage) belongs to each script's own argument parsing, not to the
# gate, so it is deliberately absent.
GATE_EXIT_PASS=0
GATE_EXIT_FAIL=1
GATE_EXIT_NOT_AUTHORITATIVE=3
GATE_EXIT_NO_VERDICT=76

# The colour escapes live here rather than at the call sites: they are part of
# how the line is written, and a caller that restates them is a second writer of
# the format. gate_verdict_read strips them again on the way back.
gate_verdict_pass() { printf '\033[32mMERGE GATE: PASS %s\033[0m\n' "$1"; }
gate_verdict_fail() { printf '\033[31mMERGE GATE: FAIL (%s)\033[0m\n' "$1"; }
gate_verdict_not_authoritative() { printf '\033[33mMERGE GATE: NOT AUTHORITATIVE (%s)\033[0m\n' "$1"; }
gate_verdict_not_run() { printf '\033[33mGATE NOT RUN: %s\033[0m\n' "$1"; }

# The last verdict line of any of the four shapes, colour stripped; empty when
# the log holds none, which is what a gate killed by a signal it cannot trap
# leaves behind. All four shapes, not just the three that start `MERGE GATE: `:
# a stopped run's reason is the one the caller most needs and the one that was
# being discarded.
#
# The escape is a literal built with $'' rather than sed's \x1b, which only GNU
# sed understands: on BSD sed the pattern silently matches nothing and every
# colour code survives into whatever the line is pasted into.
gate_verdict_read() {
  local log="$1" esc
  esc=$'\033'
  grep -a -e 'MERGE GATE: ' -e 'GATE NOT RUN: ' "$log" 2>/dev/null \
    | tail -1 \
    | sed "s/${esc}\[[0-9;]*m//g"
}

# Did this exit code carry a judgement about the commit? The dispatcher decides
# whether to report a result or try other capacity on exactly this question, and
# answering it by restating 0|1|3 is how a fourth code would one day be added to
# the table and to only some of the places that read it.
gate_verdict_is_judgement() {
  case "$1" in
    "$GATE_EXIT_PASS" | "$GATE_EXIT_FAIL" | "$GATE_EXIT_NOT_AUTHORITATIVE") return 0 ;;
    *) return 1 ;;
  esac
}
