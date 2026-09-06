#!/usr/bin/env bash
#
# Provision a merge-gate worker (issue #132). Runs ON THE SERVER.
#
#   scp scripts/gate-worker/provision.sh <server>:/tmp/
#   ssh <server> 'bash /tmp/provision.sh'            # dry run, prints the plan
#   ssh <server> 'bash /tmp/provision.sh --apply'    # do it
#
# What this machine is: a compute worker that checks a commit out of a bare
# mirror and runs scripts/merge-gate.sh against it. It never runs an Anneal
# runner or an agent session — the execution plane stays on the local machine.
# This script installs a toolchain and a directory layout and nothing else: no
# service, no queue, no daemon and no clone of a GitHub remote.
#
# The mirror's lack of a remote is enforced here and in mirror-push.sh. What is
# deliberately NOT claimed: this box is not made
# network-isolated. Nothing here denies it a route to GitHub or anywhere else,
# and the repository does not guarantee one is denied (the operator's ruling,
# 2026-08-20). The gate's own flow never needs GitHub — the mirror arrives over
# ssh from the local machine and nothing fetches from a remote — but a candidate
# commit's build and test scripts run on this box, so what they can reach is
# whatever this box's network policy allows. Blocking GitHub alone would not
# change that, since every other host would remain reachable. Deterministic
# inputs come from the exact pushed objects and a mirror with no remote; merge
# authority remains on the calling machine.
#
# Idempotent by construction: every step reads the current state first and prints
# "ok" for what already matches, so re-running after a partial failure is safe
# and is the supported way to converge a half-provisioned box.
#
# Ubuntu only, and that is checked rather than assumed: the package names, the
# apt invocations and the systemd unit names below are Debian-family specifics,
# and a script that "mostly works" on another distribution would leave a worker
# whose failures look like gate failures.
set -uo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    -h|--help) sed -n '2,36p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

# The exact interpreter .nvmrc names, not the wider compatibility range in
# package.json. This script is copied to and run on a worker before that worker
# has a repository checkout, so the default is repeated here and a repository
# test requires it to equal `v$(cat .nvmrc)`. An explicit override is for a
# deliberate comparison run; its verdict is evidence from a different
# toolchain and must be reported as such.
GATE_NODE_VERSION="${GATE_NODE_VERSION:-v22.17.0}"
GATE_HOME="${GATE_HOME:-$HOME/gate}"
NODE_PREFIX="${NODE_PREFIX:-/opt/node}"
# The gate starts its own throwaway PostgreSQL; pre-pulling it here means the
# first gate run does not pay for the pull, and a pull that is going to fail
# (mirror unreachable, image renamed) fails during provisioning where it reads
# as a provisioning problem rather than as a FAIL against somebody's commit.
POSTGRES_IMAGE="${AGENTOS_GATE_POSTGRES_IMAGE:-postgres:16-alpine}"

# Mainland-China mirrors. The point is not speed: the direct sources are not
# reliably reachable from this network at all, so an unmirrored install does not
# run slowly, it hangs.
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
NODE_MIRROR="${NODE_MIRROR:-https://cdn.npmmirror.com/binaries/node}"
DOCKER_REGISTRY_MIRRORS="${DOCKER_REGISTRY_MIRRORS:-https://docker.m.daocloud.io,https://dockerproxy.net}"

failures=0
note() { printf '  %s\n' "$*"; }
ok()   { printf '  ok      %s\n' "$*"; }
plan() { printf '  PLAN    %s\n' "$*"; }
# "ok" for something this run performed. Under --dry-run nothing was performed, so
# it stays silent: a plan that reports success is a plan nobody reads twice.
did()  { [ "$APPLY" = 1 ] && printf '  ok      %s\n' "$*"; return 0; }
fail() { printf '  FAIL    %s\n' "$*"; failures=$((failures + 1)); }
step() { printf '\n== %s\n' "$*"; }

# Everything that mutates the host goes through here, so a dry run cannot change
# anything and the plan it prints is the literal command list.
run() {
  if [ "$APPLY" = 1 ]; then
    "$@"
  else
    plan "$*"
  fi
}

# Same, for the handful of steps that need a shell (redirection, pipes).
run_sh() {
  if [ "$APPLY" = 1 ]; then
    sh -c "$1"
  else
    plan "sh -c $1"
  fi
}

SUDO=""
if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

# Package installs and /etc writes need root. A worker account that cannot reach
# root can still be provisioned — by the operator running this himself — so this
# is a hard stop only under --apply, and only once something actually needs
# installing.
sudo_run() {
  if [ "$APPLY" = 1 ]; then
    if [ -z "$SUDO" ] && [ "$(id -u)" != 0 ]; then
      fail "this step needs root and neither root nor sudo is available: $*"
      return 1
    fi
    $SUDO "$@"
  else
    plan "${SUDO:+sudo }$*"
  fi
}

# --- preflight --------------------------------------------------------------

step "Preflight"

if [ ! -r /etc/os-release ]; then
  echo "no /etc/os-release: this script provisions Ubuntu only" >&2
  exit 64
fi
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "this script provisions Ubuntu only, found ID=${ID:-unknown} (${PRETTY_NAME:-unknown})" >&2
  echo "its package names and unit names are Debian-family specifics; port it deliberately, do not force it" >&2
  exit 64
fi
ok "Ubuntu ${VERSION_ID:-unknown} (${PRETTY_NAME:-unknown})"

case "$(uname -m)" in
  x86_64)  NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo "unsupported architecture $(uname -m): no pinned Node build for it" >&2; exit 64 ;;
esac
ok "architecture $(uname -m) -> node ${NODE_ARCH} build"

if [ "$APPLY" = 1 ]; then
  note "applying"
else
  note "dry run — nothing below will be changed; re-run with --apply"
fi

# --- packages ---------------------------------------------------------------

step "Base packages"
missing_pkgs=""
for pkg in git curl ca-certificates xz-utils util-linux jq python3 build-essential libatomic1; do
  if dpkg -s "$pkg" >/dev/null 2>&1; then
    ok "$pkg"
  else
    missing_pkgs="${missing_pkgs} ${pkg}"
  fi
done
if [ -n "$missing_pkgs" ]; then
  # One update + one install for everything missing: apt-get update is the slow
  # part and repeating it per package turns a 20-second step into a minute.
  sudo_run apt-get update || fail "apt-get update failed"
  # shellcheck disable=SC2086
  sudo_run apt-get install -y $missing_pkgs || fail "could not install:${missing_pkgs}"
fi

# VMware's guest time plugin and Ubuntu's NTP service must not both discipline
# CLOCK_REALTIME. Under sustained gate load the two sources can step the clock
# backwards, making freshly-created database rows appear to come from the
# future. Keep VMware's periodic synchronization off and let Ubuntu own the
# clock. This is a no-op on physical, cloud and non-VMware workers.
step "Clock discipline"
if command -v vmware-toolbox-cmd >/dev/null 2>&1; then
  vmware_timesync="$(vmware-toolbox-cmd timesync status 2>&1 || true)"
  if [ "$vmware_timesync" = "Disabled" ]; then
    ok "VMware time synchronization disabled"
  else
    sudo_run vmware-toolbox-cmd timesync disable || fail "could not disable VMware time synchronization"
    did "disabled VMware time synchronization"
  fi
  if [ "$(timedatectl show -p NTP --value 2>/dev/null)" = "yes" ]; then
    ok "Ubuntu NTP enabled"
  else
    sudo_run timedatectl set-ntp true || fail "could not enable Ubuntu NTP"
    did "enabled Ubuntu NTP"
  fi
else
  ok "not a VMware guest"
fi

# Several gate fixtures create commits in temporary repositories. A fresh cloud
# image has no Git identity, so those fixtures fail before testing anything. Do
# not overwrite an operator identity that is already complete; provide a stable
# synthetic one only when either half is absent.
step "Git fixture identity"
if command -v git >/dev/null 2>&1 \
  && [ -n "$(git config --global user.name 2>/dev/null)" ] \
  && [ -n "$(git config --global user.email 2>/dev/null)" ]; then
  ok "$(git config --global user.name) <$(git config --global user.email)>"
else
  run git config --global user.name "Anneal Gate Worker"
  run git config --global user.email "gate-worker@example.invalid"
  did "configured the synthetic Git fixture identity"
fi

step "Docker"
if command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version 2>/dev/null | sed 's/^Docker version //')"
else
  # docker.io from the Ubuntu archive rather than Docker's own apt repository:
  # download.docker.com is exactly the kind of host this network cannot be relied
  # on to reach, and the gate only needs "run a postgres container", which the
  # distribution package does.
  sudo_run apt-get update || fail "apt-get update failed"
  sudo_run apt-get install -y docker.io || fail "could not install docker.io"
fi

# Registry mirrors, written only when absent: an existing daemon.json may carry
# settings this script knows nothing about, and silently rewriting it is how a
# provisioning run breaks the box it was supposed to converge.
if [ -f /etc/docker/daemon.json ]; then
  if grep -q 'registry-mirrors' /etc/docker/daemon.json 2>/dev/null; then
    # Present, but "configured" is not "working": this box arrived with mirrors
    # from a previous tenant that answered TLS and then never served a layer, and
    # the pull below sat there for fifteen minutes without failing. Whether these
    # mirrors are usable is decided by the timed pull at the end of this step, not
    # by the config file existing.
    note "/etc/docker/daemon.json already sets registry-mirrors; the pull below is what proves they work"
  else
    fail "/etc/docker/daemon.json exists without registry-mirrors; add ${DOCKER_REGISTRY_MIRRORS} by hand — this script will not rewrite a config it did not write"
  fi
else
  mirrors_json="$(printf '%s' "$DOCKER_REGISTRY_MIRRORS" | awk -F, '{for (i = 1; i <= NF; i++) printf "%s\"%s\"", (i > 1 ? ", " : ""), $i}')"
  sudo_run mkdir -p /etc/docker
  run_sh "printf '{\n  \"registry-mirrors\": [%s]\n}\n' '${mirrors_json}' | ${SUDO:+sudo }tee /etc/docker/daemon.json >/dev/null"
  sudo_run systemctl restart docker || fail "could not restart docker after writing daemon.json"
  did "wrote /etc/docker/daemon.json with ${DOCKER_REGISTRY_MIRRORS}"
fi

sudo_run systemctl enable --now docker || fail "could not enable the docker service"

# The gate calls plain `docker run`; requiring sudo for it would mean either a
# sudoers grant or a gate running as root, and neither is worth it on a box whose
# only job is to build and test.
if id -nG "$(id -un)" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
  ok "$(id -un) is in the docker group"
else
  sudo_run usermod -aG docker "$(id -un)" || fail "could not add $(id -un) to the docker group"
  note "group membership only takes effect in a new session: log out and back in, then re-run this script"
fi

# This pull is the load-bearing check of the whole mirror configuration, so it
# gets a deadline. A mainland box pointed at a mirror that has quietly stopped
# serving layers does not fail, it hangs — and a provisioning step that hangs is
# worse than one that fails, because the hang reappears later as a gate that
# never returns a verdict.
PULL_TIMEOUT="${PULL_TIMEOUT:-300}"
if [ "$APPLY" = 1 ] && docker info >/dev/null 2>&1; then
  if docker image inspect "$POSTGRES_IMAGE" >/dev/null 2>&1; then
    ok "$POSTGRES_IMAGE already pulled"
  elif timeout "$PULL_TIMEOUT" docker pull "$POSTGRES_IMAGE"; then
    ok "pulled $POSTGRES_IMAGE"
  else
    fail "could not pull $POSTGRES_IMAGE within ${PULL_TIMEOUT}s. The mirrors in /etc/docker/daemon.json are not serving layers; replace them and re-run. Check one by hand with: timeout 150 docker pull <mirror>/library/${POSTGRES_IMAGE}"
  fi
else
  plan "timeout ${PULL_TIMEOUT} docker pull $POSTGRES_IMAGE"
fi

# --- node -------------------------------------------------------------------

step "Node ${GATE_NODE_VERSION} (pinned)"
current_node=""
if command -v node >/dev/null 2>&1; then
  current_node="$(node -v 2>/dev/null || true)"
fi

if [ "$current_node" = "$GATE_NODE_VERSION" ]; then
  ok "node ${current_node}"
else
  [ -n "$current_node" ] && note "node ${current_node} is installed but the gate is pinned to ${GATE_NODE_VERSION}"
  tarball="node-${GATE_NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  url="${NODE_MIRROR}/${GATE_NODE_VERSION}/${tarball}"
  # The official tarball through the npmmirror binary mirror, not NodeSource:
  # this pins one exact build rather than "whatever the 26.x apt repo has today",
  # and it is a single HTTP GET against a host this network can actually reach.
  sudo_run mkdir -p "$NODE_PREFIX"
  run_sh "curl -fsSL '${url}' | ${SUDO:+sudo }tar -xJ -C '${NODE_PREFIX}' --strip-components=1" \
    || fail "could not install node from ${url}"
  sudo_run ln -sfn "$NODE_PREFIX/bin/node" /usr/local/bin/node
  sudo_run ln -sfn "$NODE_PREFIX/bin/npm" /usr/local/bin/npm
  sudo_run ln -sfn "$NODE_PREFIX/bin/npx" /usr/local/bin/npx
  did "installed node ${GATE_NODE_VERSION} to ${NODE_PREFIX}"
fi

step "npm registry"
# A user-level .npmrc rather than a global one keeps the worker's registry
# selection visible and easy to change without rewriting system configuration.
if [ -f "$HOME/.npmrc" ] && grep -q "registry=${NPM_REGISTRY}" "$HOME/.npmrc" 2>/dev/null; then
  ok "~/.npmrc points at ${NPM_REGISTRY}"
else
  run_sh "printf 'registry=%s\n' '${NPM_REGISTRY}' >> \"\$HOME/.npmrc\""
  did "appended registry=${NPM_REGISTRY} to ~/.npmrc"
fi
# --- layout -----------------------------------------------------------------

# Only the root. Each repository's mirror, worktrees, logs and run-gate.sh live
# under ${GATE_HOME}/<repo>/ and are created by the first mirror-push.sh from
# the local machine, so this box knows nothing about which repositories it will
# gate — the toolchain is worker-wide, the repositories arrive by push.
step "Gate layout under ${GATE_HOME}"
run mkdir -p "$GATE_HOME"

# How much of this host one gate may size itself for, written down rather than
# inferred. The default is the worker's capacity — the value run-gate.sh used
# before this file existed — so provisioning a worker again never changes the
# sizing it already has. The case that needs a larger number is a worker that
# shares its machine with runners: one gate at a time, and not the whole box.
# The runbook says so; this file is where that decision goes. Never overwritten,
# because it is an operator's acceptance, not a fact about the box.
#
# And never written at all on a box that has not stated a capacity yet. Writing
# a snapshot of an absent capacity froze the share at 1, and the runbook's own
# order provisions before the capacity-two acceptance sets `worker-capacity`:
# raising the capacity afterwards would then have left two concurrent gates each
# sized for the whole machine. An absent file already means "the capacity" to
# run-gate.sh, and that default keeps tracking a capacity stated later.
host_share_file="${GATE_HOME}/host-share"
worker_capacity_file="${GATE_HOME}/worker-capacity"
default_host_share="$(tr -d '[:space:]' < "$worker_capacity_file" 2>/dev/null || true)"
# Padding is not a different number: `00` is a zero, and a share of zero would
# divide this host by nothing.
default_host_share="$(printf '%s\n' "$default_host_share" | sed 's/^0*//')"
case "$default_host_share" in
  ''|*[!0-9]*) default_host_share="" ;;
esac
if [ -f "$host_share_file" ]; then
  ok "host share $(tr -d '[:space:]' < "$host_share_file" 2>/dev/null) in ${host_share_file}"
elif [ -n "$default_host_share" ]; then
  run_sh "printf '%s\n' '${default_host_share}' > '${host_share_file}'"
  did "wrote ${host_share_file} (a gate takes 1/${default_host_share} of this host)"
else
  ok "no ${host_share_file}; a gate takes 1/(worker capacity) of this host until one is written"
fi

repo_dirs="$(find "$GATE_HOME" -mindepth 2 -maxdepth 2 -type d -name mirror.git 2>/dev/null)"
if [ -n "$repo_dirs" ]; then
  while IFS= read -r mirror; do
    # "git succeeded and printed nothing", not "the output was empty": those
    # differ exactly when git failed, and a guard that cannot tell them apart
    # reports a mirror it never managed to read as clean. There is no `pipefail`
    # covering the old `git remote | grep -q .`, which is why this reads the
    # exit status directly.
    if ! mirror_remotes="$(git -C "$mirror" remote 2>&1)"; then
      fail "could not read the remotes of ${mirror}: ${mirror_remotes}"
    elif [ -n "$mirror_remotes" ]; then
      fail "${mirror} has a remote configured (${mirror_remotes}); the worker fetches from nowhere — remove it"
    else
      ok "$mirror (no remote)"
    fi
  done <<EOF2
$repo_dirs
EOF2
else
  note "no repository mirrors yet — run packages/runner/runtime-tools/gate-worker/mirror-push.sh from the local machine"
fi

# --- verdict ----------------------------------------------------------------

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf 'PROVISION: FAIL (%s problem(s) above)\n' "$failures"
  exit 1
fi
if [ "$APPLY" = 1 ]; then
  printf 'PROVISION: OK\n'
  printf 'Next, from the local machine: packages/runner/runtime-tools/gate-worker/gate-dispatch.sh <candidate-oid>\n'
else
  printf 'PROVISION: DRY RUN OK — re-run with --apply\n'
fi
