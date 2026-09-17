#!/usr/bin/env bash

# The host fast path intentionally precedes argument validation and uses only
# shell builtins. A host invocation must pay no process-startup cost beyond the
# shell npm already launched.
if [[ -z "${AGENTOS_RUN_ID:-}" ]]; then
  exit 0
fi

if [[ "${AGENTOS_RUN_SCOPE_BYPASS:-}" == "regression-verification" ]]; then
  # shellcheck source=packages/runner/runtime-tools/gate-worker/lib.sh
  . "${BASH_SOURCE[0]%/*}/../packages/runner/runtime-tools/gate-worker/lib.sh"
  if agentos_regression_bypass_is_authenticated; then
    exit 0
  fi
  agentos_regression_bypass_audit_refusal
fi

script="${1:-unknown}"
workspace_script="$script"
if [[ "$script" == "lint:biome" || "$script" == "lint:types" ]]; then
  workspace_script="lint"
fi
printf 'run-scope-guard: %s refused for Run %s: inside an Anneal Run, verify only the affected workspace using npm run %s -w <workspace> and named test files; the Regression step owns repository-wide proof and the Merge Gate.\n' \
  "${script}" "${AGENTOS_RUN_ID}" "${workspace_script}" >&2
exit 78
