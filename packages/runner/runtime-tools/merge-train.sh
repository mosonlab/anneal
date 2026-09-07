#!/usr/bin/env bash
# Build and gate a bounded, ordered merge train in the current Run workspace.
# The implementation lives beside this wrapper so the runtime-tool bundle can
# copy the pair without bringing the repository's host workflow into a Run.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" \
  || { printf 'merge-train: cannot resolve runtime-tool directory\n' >&2; exit 1; }
exec node "$SCRIPT_DIR/merge-train.mjs" "$@"
