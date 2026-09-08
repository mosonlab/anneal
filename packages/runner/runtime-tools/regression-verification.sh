#!/usr/bin/env bash
# Token-free mechanical half of canonical regression verification.
#
# The model invokes `prepare`, performs the semantic recheck unless prepare
# reuses an exact-head verdict, then invokes `finalize` (or `review-fail
# <summary>`). This script owns every git/network,
# gate, verdict transcription, and the local Runner handoff. The Runner owns
# the fenced control-plane write outside the Agent sandbox. Merge readiness owns
# the short merge-lease window after a durable exact-head PASS exists, so lease
# transport failures never consume a semantic-verification Run.

set -u
set -o pipefail

EXIT_SEMANTIC_STALE=77
OUTPUT_KIND="regression-verification-v2"
SHA_RE='^[0-9a-f]{40}$'

die() { printf 'regression-verification: %s\n' "$1" >&2; exit "${2:-1}"; }

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || die "$name is required"
}

for required in AGENTOS_RUN_ID AGENTOS_WORKSPACE_PATH AGENTOS_PULL_REQUEST_BASE; do
  require_env "$required"
done

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" \
  || die "cannot resolve the regression tooling directory"
cd "$AGENTOS_WORKSPACE_PATH" || die "cannot enter AGENTOS_WORKSPACE_PATH"
git check-ref-format --branch "$AGENTOS_PULL_REQUEST_BASE" >/dev/null 2>&1 \
  || die "AGENTOS_PULL_REQUEST_BASE is not a valid branch"

STATE_FILE="${AGENTOS_REGRESSION_STATE:-$AGENTOS_WORKSPACE_PATH/.git/agentos-regression-state}"
OUTPUT_FILE="$AGENTOS_WORKSPACE_PATH/.agentos/regression-output.json"
GATE_DISPATCH="${REGRESSION_GATE_DISPATCH:-$SCRIPT_DIR/gate-worker/gate-dispatch.sh}"
GATE_LOG=""
# shellcheck source=packages/runner/runtime-tools/gate-worker/lib.sh
. "$SCRIPT_DIR/gate-worker/lib.sh"

cleanup() {
  [ -z "$GATE_LOG" ] || rm -f -- "$GATE_LOG"
}
trap cleanup EXIT

valid_sha() { [[ "$1" =~ $SHA_RE ]]; }

head_sha() {
  local head
  head="$(git rev-parse HEAD)" || return 1
  valid_sha "$head" || return 1
  printf '%s' "$head"
}

FETCH_ATTEMPTS=6

# Kept in parity with db's transport vocabulary by transport-vocabulary.test.ts.
FETCH_TRANSIENT_RE='fetch failed|SSL_ERROR_SYSCALL|SSL_connect|unexpected EOF|early EOF|(^|[^A-Za-z0-9_])Post[[:space:]]+"[^"]+"[[:space:]]*:[[:space:]]*EOF([^A-Za-z0-9_]|$)|our servers are currently overloaded|(^|[^A-Za-z0-9_])model[[:space:]]+is[[:space:]]+(currently[[:space:]]+)?at capacity([^A-Za-z0-9_]|$)|connection (reset|closed|timed out|lost|aborted|refused)|RPC failed|Operation timed out|Failed to connect|Could not resolve host|Recv failure|socket hang ?up|HTTP( response)?[[:space:]]*(408|425|429|5[0-9][0-9])|status( code)?[[:space:]]*(408|425|429|5[0-9][0-9])|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout|ECONNABORTED|ECONNRESET|EHOSTUNREACH|ENETDOWN|ENETRESET|ENETUNREACH|EPIPE|ETIMEDOUT|EAI_AGAIN|ETIMEOUT'
FETCH_ACCESS_REFUSAL_RE='authentication failed|could not read Username|permission denied|forbidden|HTTP( response)?[[:space:]]*(401|403)|status( code)?[[:space:]]*(401|403)|bad credentials|authorization failed|(^|[^A-Za-z0-9_])unauthorized([^A-Za-z0-9_]|$)|invalid credentials|requested URL returned error:[[:space:]]*(401|403)([^A-Za-z0-9_]|$)|resource not accessible'

fetch_is_transient() (
  shopt -s nocasematch
  [[ ! "$1" =~ $FETCH_ACCESS_REFUSAL_RE && "$1" =~ $FETCH_TRANSIENT_RE ]]
)

# Exponential backoff with full jitter, capped per attempt, matching the clone
# profile in network-retry.ts. This host reaches GitHub through a proxy whose
# 443 exit drops for seconds at a time; on 2026-09-02 the previous budget
# (3 attempts, 1s apart) was exhausted inside one such drop twice in a row and
# burned both Runs of a regression step before any verification began. Waiting
# up to 1s,2s,4s,8s,8s (~23s worst case) rides out a second-scale drop while
# staying far inside the step's stall timeout.
fetch_backoff() {
  local ceiling=$(( 1 << (($1 < 4 ? $1 : 4) - 1) ))
  sleep "$(awk -v ceiling="$ceiling" 'BEGIN { srand(); printf "%.2f", rand() * ceiling }')"
}

persist_block_record() {
  local stderr_line="$1" output_dir temporary
  output_dir="$(dirname "$OUTPUT_FILE")"
  if [ -L "$output_dir" ]; then
    die "refusing symlinked regression output directory"
  fi
  umask 077
  mkdir -p -- "$output_dir" || die "cannot create regression output directory"
  [ -d "$output_dir" ] || die "regression output directory is not a directory"
  temporary="$(mktemp "${OUTPUT_FILE}.XXXXXXXX")" \
    || die "cannot create regression block record"
  printf '%s\0%s\0%s' "$AGENTOS_RUN_ID" "$OUTPUT_KIND" "$stderr_line" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
const [runId, kind, stderr] = input.split("\0");
process.stdout.write(JSON.stringify({ schemaVersion: 1, runId, kind, reason: "target-fetch-failed", stderr }));
});
' > "$temporary" || { rm -f -- "$temporary"; die "cannot encode regression block record"; }
  chmod 600 "$temporary" || { rm -f -- "$temporary"; die "cannot protect regression block record"; }
  mv -f -- "$temporary" "$OUTPUT_FILE" \
    || { rm -f -- "$temporary"; die "cannot publish regression block record"; }
}

persist_target_fetch_block() {
  local error="$1" stderr_line
  stderr_line="$(printf '%s\n' "$error" | tail -n 1)"
  persist_block_record "$stderr_line"
}

fetch_base() {
  local attempt error status
  for attempt in $(seq 1 "$FETCH_ATTEMPTS"); do
    status=0
    error="$(GIT_TERMINAL_PROMPT=0 git fetch --no-tags origin "refs/heads/$AGENTOS_PULL_REQUEST_BASE" \
      2>&1 >/dev/null)" || status=$?
    if [ "$status" -eq 0 ]; then
      local fetched
      status=0
      fetched="$(git rev-parse FETCH_HEAD 2>&1)" || status=$?
      if [ "$status" -ne 0 ]; then
        persist_target_fetch_block "$fetched"
        printf 'regression-verification: cannot read fetched target (exit %s): %s\n' \
          "$status" "$fetched" >&2
        return 1
      fi
      if ! valid_sha "$fetched"; then
        error="fetched target is not an object id: $fetched"
        persist_target_fetch_block "$error"
        printf 'regression-verification: %s\n' "$error" >&2
        return 1
      fi
      printf '%s' "$fetched"
      return 0
    fi
    if ! fetch_is_transient "$error"; then
      persist_target_fetch_block "$error"
      printf 'regression-verification: target fetch failed (exit %s): %s\n' "$status" "$error" >&2
      return 1
    fi
    [ "$attempt" -lt "$FETCH_ATTEMPTS" ] || break
    printf 'regression-verification: target fetch failed; retrying attempt=%s/%s\n' \
      "$((attempt + 1))" "$FETCH_ATTEMPTS" >&2
    fetch_backoff "$attempt"
  done
  persist_target_fetch_block "$error"
  printf 'regression-verification: target fetch failed after %s attempts: %s\n' \
    "$FETCH_ATTEMPTS" "$error" >&2
  return 1
}

write_state() {
  local verified_head="$1" base_head="$2" semantic_verdict="${3:-}" semantic_source_run_id="${4:-}"
  valid_sha "$verified_head" && valid_sha "$base_head" || die "refusing malformed regression state"
  if [ "$semantic_verdict" = "reused" ]; then
    [ -n "$semantic_source_run_id" ] || die "refusing reused regression state without a source Run"
    [[ ! "$semantic_source_run_id" =~ [[:space:]] ]] \
      || die "refusing reused regression state with a malformed source Run id"
  fi
  umask 077
  printf 'verifiedHeadSha=%s\nbaseHeadSha=%s\n' "$verified_head" "$base_head" > "$STATE_FILE"
  if [ "$semantic_verdict" = "reused" ] && [ -n "$semantic_source_run_id" ]; then
    printf 'semanticVerdict=reused\nsemanticSourceRunId=%s\n' "$semantic_source_run_id" >> "$STATE_FILE"
  fi
}

read_state() {
  local has_semantic_verdict=0 has_semantic_source=0
  [ -f "$STATE_FILE" ] || die "prepare has not recorded regression state"
  VERIFIED_HEAD_SHA="$(sed -n 's/^verifiedHeadSha=//p' "$STATE_FILE")"
  BASE_HEAD_SHA="$(sed -n 's/^baseHeadSha=//p' "$STATE_FILE")"
  valid_sha "$VERIFIED_HEAD_SHA" && valid_sha "$BASE_HEAD_SHA" \
    || die "recorded regression state is malformed"
  grep -q '^semanticVerdict=' "$STATE_FILE" && has_semantic_verdict=1
  grep -q '^semanticSourceRunId=' "$STATE_FILE" && has_semantic_source=1
  SEMANTIC_VERDICT="$(sed -n 's/^semanticVerdict=//p' "$STATE_FILE")"
  SEMANTIC_SOURCE_RUN_ID="$(sed -n 's/^semanticSourceRunId=//p' "$STATE_FILE")"
  # A state file with no reuse markers is the normal fresh-review state. A
  # partial marker is different: silently clearing it here could let finalize
  # publish reused work as fresh after the model had already skipped review.
  if [ "$has_semantic_verdict" -eq 0 ] && [ "$has_semantic_source" -eq 0 ]; then
    SEMANTIC_VERDICT=""
    SEMANTIC_SOURCE_RUN_ID=""
  elif [ "$SEMANTIC_VERDICT" != "reused" ] || [ -z "$SEMANTIC_SOURCE_RUN_ID" ]; then
    die "recorded regression reuse state is malformed"
  elif [[ "$SEMANTIC_SOURCE_RUN_ID" =~ [[:space:]] ]]; then
    die "recorded regression reuse source Run id is malformed"
  fi
}

clear_reuse_state() {
  # Keep the exact prepared-head binding so a later finalize still refuses a
  # workspace that moved, while removing the only marker that could authorize
  # a reused semantic verdict.
  write_state "$VERIFIED_HEAD_SHA" "$BASE_HEAD_SHA"
  SEMANTIC_VERDICT=""
  SEMANTIC_SOURCE_RUN_ID=""
}

json_verdict() {
  node -e '
const [outcome, headSha, baseHeadSha, proofOrSummary, gateFailureExcerpt, semanticVerdict, semanticSourceRunId] = process.argv.slice(1);
const semantic = semanticVerdict === "reused" && typeof semanticSourceRunId === "string" && semanticSourceRunId.length > 0
  ? { semanticVerdict: "reused", semanticSourceRunId }
  : {};
const value = outcome === "pass"
  ? { schemaVersion: 2, outcome, headSha, baseHeadSha, gateVerdict: "PASS", gateProof: proofOrSummary }
  : outcome === "gate-fail"
    ? { schemaVersion: 2, outcome, headSha, baseHeadSha, gateVerdict: "FAIL", gateProof: proofOrSummary, summary: proofOrSummary.slice("MERGE GATE: FAIL (".length, -1), gateFailureExcerpt }
    : { schemaVersion: 2, outcome, headSha, baseHeadSha, summary: proofOrSummary };
process.stdout.write(JSON.stringify({ ...value, ...semantic }));
' "$1" "$2" "$3" "$4" "${5:-}" "${6:-}" "${7:-}"
}

# Decide semantic reuse from the immutable recovery snapshot handed to this
# Run. The prior output is persisted control-plane evidence; transcript text is
# deliberately not consulted. Compare the incoming head before target refresh;
# write_state separately binds finalization to the refreshed head.
recovery_reuse_source() {
  local incoming_head="$1" context="${AGENTOS_REGRESSION_RECOVERY_CONTEXT:-}" source
  [ -n "$context" ] || return 0
  source="$(printf '%s' "$context" | INCOMING_HEAD_SHA="$incoming_head" node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const SHA = /^[0-9a-f]{40}$/u;
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  const context = (() => { try { return object(JSON.parse(input)); } catch { return null; } })();
  const prior = object(context?.priorOutput);
  if (!context || !prior) return;
  if (context.state !== "queued" || context.recoveryRunId !== process.env.AGENTOS_RUN_ID) return;
  if (typeof context.currentBaseSha !== "string" || !SHA.test(context.currentBaseSha)) return;
  if (typeof context.authorizedHeadSha !== "string" || !SHA.test(context.authorizedHeadSha)) return;
  if (context.authorizedHeadSha !== process.env.INCOMING_HEAD_SHA) return;
  if (typeof prior.runId !== "string" || prior.runId.length === 0 || prior.runId === process.env.AGENTOS_RUN_ID) return;
  if (prior.kind !== "regression-verification-v2") return;
  if (typeof prior.commitSha !== "string" || !SHA.test(prior.commitSha)) return;
  if (typeof prior.body !== "string") return;
  let verdict;
  try { verdict = object(JSON.parse(prior.body)); } catch { return; }
  if (!verdict || verdict.schemaVersion !== 2) return;
  // `pass` and `gate-fail` are the legacy persisted spellings for a semantic
  // PASS. A semantic review-fail or refresh-conflict is never reusable, even
  // when its head happens to match the recovery authorization.
  if (verdict.outcome !== "pass" && verdict.outcome !== "gate-fail") return;
  if (typeof verdict.headSha !== "string" || !SHA.test(verdict.headSha)) return;
  if (typeof verdict.baseHeadSha !== "string" || !SHA.test(verdict.baseHeadSha)) return;
  if (verdict.outcome === "pass") {
    if (verdict.gateVerdict !== "PASS") return;
    if (verdict.gateProof !== `MERGE GATE: PASS ${verdict.headSha}`) return;
  } else {
    if (verdict.gateVerdict !== "FAIL") return;
    if (typeof verdict.summary !== "string" || verdict.summary.length === 0) return;
    if (typeof verdict.gateProof !== "string" || !/^MERGE GATE: FAIL \(.+\)$/u.test(verdict.gateProof)) return;
    if (Object.hasOwn(verdict, "gateFailureExcerpt") && typeof verdict.gateFailureExcerpt !== "string") return;
  }
  const hasReuseField = Object.hasOwn(verdict, "semanticVerdict") || Object.hasOwn(verdict, "semanticSourceRunId");
  if (hasReuseField) {
    if (verdict.semanticVerdict !== "reused" || typeof verdict.semanticSourceRunId !== "string"
      || verdict.semanticSourceRunId.length === 0 || /[\s]/u.test(verdict.semanticSourceRunId)) return;
  }
  if (prior.commitSha !== verdict.headSha || verdict.headSha !== process.env.INCOMING_HEAD_SHA) return;
  if (/[\s]/u.test(prior.runId)) return;
  process.stdout.write(prior.runId);
});
')" || source=""
  [ -n "$source" ] || return 0
  printf '%s' "$source"
}

# Pull only the useful part of a failed worker log into the durable verdict. The
# worker normally forwards the last 200 lines, so this must stay bounded even if
# a test prints an unbounded amount of output. Keeping the extraction here (next
# to json_verdict) also means the gate proof and PASS/FAIL decision remain owned
# by the existing mechanical path.
extract_gate_log_excerpt() {
  local mode="$1" log="$2" summary="${3:-}"
  node - "$mode" "$log" "$summary" <<'NODE'
const { createReadStream, readFileSync } = require("node:fs");
const { createInterface } = require("node:readline");

const [mode, logPath, summary] = process.argv.slice(2);
const MAX_LINES = 40;
const MAX_BYTES = 4000;

const byteLength = (value) => Buffer.byteLength(value, "utf8");
const truncateUtf8 = (value, limit) => {
  if (byteLength(value) <= limit) return value;
  let end = limit;
  const bytes = Buffer.from(value);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
};

const takeBounded = (lines, lineLimit, byteBudget) => {
  const taken = [];
  let bytes = 0;
  for (const line of lines) {
    if (taken.length >= lineLimit) break;
    const separator = taken.length > 0 ? 1 : 0;
    const remaining = byteBudget - bytes - separator;
    if (remaining <= 0) break;
    const fitted = truncateUtf8(line, remaining);
    if (fitted === "" && line !== "") break;
    taken.push(fitted);
    bytes += separator + byteLength(fitted);
    if (fitted !== line) break;
  }
  return { lines: taken, bytes };
};

const splitStages = (value) => {
  const stages = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")" && depth > 0) depth -= 1;
    else if (character === "," && depth === 0) {
      const stage = value.slice(start, index).trim();
      if (stage) stages.push(stage);
      start = index + 1;
    }
  }
  const finalStage = value.slice(start).trim();
  if (finalStage) stages.push(finalStage);
  return stages;
};

const stages = splitStages(summary);
const fallbackStages = stages.length > 0 ? stages : [summary.trim() || "gate"];
const stripAnsi = (line) => line.replace(/\u001b\[[0-9;]*m/gu, "");
const records = [];
const recordsByLine = new Map();
const repositoryFailures = [];
const repositoryFailuresByLine = new Set();
const stageOutput = new Set();
const pendingContexts = [];
let currentStage = null;
let failureOpen = false;
let failureAge = 0;

const stageForLine = (visible) => {
  const heading = visible.match(/^\s*---\s+(.+?)\s+---\s*$/u)?.[1];
  if (heading && stages.includes(heading)) return heading;
  return stages.find((stage) => visible.includes(stage)) ?? null;
};

const addRecord = (line, index, stage) => {
  if (stage) stageOutput.add(stage);
  else if (stages.length === 1) stageOutput.add(stages[0]);
  const existing = recordsByLine.get(line);
  if (existing) {
    if (stage) existing.stages.add(stage);
    return;
  }
  // The output can use at most forty unique records. Continue streaming after
  // this cap only to learn which failed stages had attributable output.
  if (records.length >= MAX_LINES) return;
  const record = { line, index, stages: new Set() };
  if (stage) record.stages.add(stage);
  recordsByLine.set(line, record);
  records.push(record);
};

const addRepositoryFailure = (line, index, stage) => {
  if (stage) stageOutput.add(stage);
  else if (stages.length === 1) stageOutput.add(stages[0]);
  if (repositoryFailuresByLine.has(line)) return;
  repositoryFailuresByLine.add(line);
  repositoryFailures.push({ line, index });
};

const readLog = async () => {
  let index = 0;
  const lines = createInterface({ input: createReadStream(logPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
  const visible = stripAnsi(line);
  const lineStage = stageForLine(visible);
  if (lineStage) currentStage = lineStage;

  const isSubtestContext = /^\s*#\s*Subtest\b/u.test(visible);
  // Node's TAP reporter uses `# Subtest`, while the default reporter prints
  // `test at ...`/`location: ...` and a marked failure. Accept either shape so
  // a file path is retained even when the worker forwards only a short tail.
  const isFileContext = /(?:\b(?:test|spec|dbtest)\.[cm]?[jt]sx?(?::\d+(?::\d+)?)?\b|\S+\.py::\S+)/u.test(visible);
  const isPytestNonFailureResult = /\S+\.py::\S+.*\b(?:PASSED|SKIPPED|XFAIL|XPASS)\b/u.test(visible);
  if ((isSubtestContext || isFileContext) && !isPytestNonFailureResult) {
    pendingContexts.push({ line: visible, index, stage: currentStage });
    if (pendingContexts.length > 12) pendingContexts.shift();
  }

  const isNotOk = /\bnot ok\b/u.test(visible);
  const isPytestFailure = /^\s*(?:FAILED|ERROR)\s+\S+\.py::/u.test(visible);
  const isRepositoryFailure = /^[A-Z][A-Z0-9-]*: (?:UNMET|FAIL|FAILED|ERROR)\b/u.test(visible);
  const isFailureMarker = /^\s*[✖×]\s+(?!failing tests?:)/u.test(visible);
  const isAssertion = /\bAssertionError\b/u.test(visible);
  const isError = /\bError:/u.test(visible);
  const isPytestAssertion = /^E {3}/u.test(visible);
  const isPytestFailureSection = /^\s*_{4,}.+_{4,}\s*$/u.test(visible);
  if (isPytestFailureSection) {
    failureOpen = true;
    failureAge = 0;
  }
  if (isNotOk || isFailureMarker || isPytestFailure || isRepositoryFailure) {
    const failureStage = currentStage;
    for (const context of pendingContexts) {
      if (context.stage === failureStage || !context.stage || !failureStage) {
        addRecord(context.line, context.index, failureStage);
      }
    }
    pendingContexts.length = 0;
    if (isRepositoryFailure) addRepositoryFailure(visible, index, failureStage);
    else addRecord(visible, index, failureStage);
    failureOpen = true;
    failureAge = 0;
  } else if (isAssertion || (failureOpen && (isError || isPytestAssertion))) {
    addRecord(visible, index, currentStage);
  }

  if (failureOpen) {
    failureAge += 1;
    // Error details are adjacent to the not ok block in node:test output. This
    // bound prevents an unrelated later Error line from being attributed to it.
    if (failureAge > 32 || /^\s*(?:---|==)\s+/u.test(visible)) failureOpen = false;
  }

  // A passing TAP/default-reporter result and a completed TAP block cannot be
  // the file context for a later failure.
  if (/^\s*(?:ok\b|[✔✓]\s+|#\s+(?:tests|pass|fail|duration)|1\.\.)/u.test(visible)) {
    pendingContexts.length = 0;
  }
  index += 1;
  }
};

const main = async () => {
if (mode === "no-verdict") {
  const lines = readFileSync(logPath, "utf8").split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const selected = takeBounded(lines.reverse(), 60, MAX_BYTES);
  process.stdout.write(selected.lines.reverse().join("\n"));
  return;
}
if (mode !== "failure") throw new Error(`unknown gate log extraction mode: ${mode}`);
await readLog();

records.sort((left, right) => left.index - right.index);
repositoryFailures.sort((left, right) => left.index - right.index);
for (const record of records) {
  for (const stage of record.stages) stageOutput.add(stage);
}

const missingStages = fallbackStages.filter((stage) => !stageOutput.has(stage));
const fallbackLines = missingStages.map((stage) => `${stage}: no per-test output in gate log`);

// Reserve room for repository verdicts and notices before taking ordinary log
// lines. Otherwise forty noisy test lines could crowd out either durable fact.
const reservedLines = [...repositoryFailures.map((record) => record.line), ...fallbackLines];
const boundedReserved = takeBounded(reservedLines, MAX_LINES, MAX_BYTES);

const candidateLimit = Math.max(0, MAX_LINES - boundedReserved.lines.length);
const candidateBudget = Math.max(
  0,
  MAX_BYTES - boundedReserved.bytes - (boundedReserved.lines.length > 0 ? 1 : 0),
);
const selected = takeBounded(records.map((record) => record.line), candidateLimit, candidateBudget);

process.stdout.write([...selected.lines, ...boundedReserved.lines].join("\n"));
};

main().catch((error) => {
  process.stderr.write(`gate failure excerpt extraction failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
NODE
}

extract_gate_failure_excerpt() {
  extract_gate_log_excerpt failure "$1" "$2"
}

# Keep a no-verdict dispatch diagnostic visible in the Run output without
# turning it into durable verdict evidence. The tail uses the same UTF-8-safe
# truncation as the failure excerpt above, but prioritizes the latest lines so
# the final dispatch reason survives a noisy earlier attempt.
extract_gate_no_verdict_tail() {
  extract_gate_log_excerpt no-verdict "$1"
}

print_gate_no_verdict_tail() {
  local log="$1" attempts="$2" status="$3" tail
  printf 'REGRESSION FINALIZE: gate dispatch log tail (attempts=%s, last exit status=%s)\n' "$attempts" "$status"
  if ! tail="$(extract_gate_no_verdict_tail "$log")"; then
    printf 'regression-verification: warning: could not extract no-verdict gate log tail\n' >&2
    return 0
  fi
  [ -z "$tail" ] || printf '%s\n' "$tail"
}

persist_output() {
  local verdict="$1" commit_sha="$2" output_dir temporary
  output_dir="$(dirname "$OUTPUT_FILE")"
  if [ -L "$output_dir" ]; then
    die "refusing symlinked regression output directory"
  fi
  umask 077
  mkdir -p -- "$output_dir" || die "cannot create regression output directory"
  [ -d "$output_dir" ] || die "regression output directory is not a directory"
  temporary="$(mktemp "${OUTPUT_FILE}.XXXXXXXX")" \
    || die "cannot create regression output handoff"
  printf '%s\0%s\0%s\0%s' "$AGENTOS_RUN_ID" "$OUTPUT_KIND" "$verdict" "$commit_sha" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
const [runId, kind, body, commitSha] = input.split("\0");
process.stdout.write(JSON.stringify({ schemaVersion: 1, runId, kind, body, commitSha }));
});
' > "$temporary" || { rm -f -- "$temporary"; die "cannot encode regression output handoff"; }
  chmod 600 "$temporary" || { rm -f -- "$temporary"; die "cannot protect regression output handoff"; }
  mv -f -- "$temporary" "$OUTPUT_FILE" \
    || { rm -f -- "$temporary"; die "cannot publish regression output handoff"; }
}

persist_refresh_conflict() {
  local pre_head="$1" target_head="$2" conflicts="$3" verdict display_mode
  valid_sha "$pre_head" && valid_sha "$target_head" \
    || die "refusing malformed refresh-conflict verdict"
  [ -n "$conflicts" ] || die "refusing refresh-conflict verdict without unmerged paths"
  verdict="$(json_verdict refresh-conflict "$pre_head" "$target_head" "$conflicts")"
  persist_output "$verdict" "$pre_head"
  display_mode="$(printf '%s' "$MODE" | tr '[:lower:]' '[:upper:]')"
  printf 'REGRESSION %s: refresh-conflict %s\n' "$display_mode" "$conflicts"
}

# The workspace installed its dependencies, and with them generated the Prisma
# client, before this session started. A refresh that carries a schema change
# therefore leaves a client the merged tree no longer matches, and the first
# typecheck the semantic recheck runs reads that staleness as a defect in the
# code under verification: on 2026-09-06 a refreshed `MergeLeaseEventState.CONTENDED`
# failed `typecheck -w @anneal/web` and spent a whole verification Run on a
# finding about generated output nobody had written. Regenerate here, where the
# tree moved, so the recheck reads the merged tree and nothing else.
regenerate_prisma_client() {
  local pre_head="$1" post_head="$2" changed output
  changed="$(git diff --name-only "$pre_head" "$post_head" -- '*.prisma')" \
    || die "cannot inspect the refreshed Prisma schema"
  [ -n "$changed" ] || return 0
  output="$(npm run db:generate 2>&1)" \
    || { printf '%s\n' "$output" >&2; die "cannot regenerate the Prisma client for the refreshed tree"; }
}

refresh_onto_target() {
  local target_head="$1" pre_head post_head conflicts merge_output merge_status
  valid_sha "$target_head" || die "refusing to merge malformed target head: $target_head"
  pre_head="$(head_sha)" || die "cannot resolve a valid workspace HEAD"
  merge_output="$(git merge --no-edit "$target_head" 2>&1)"
  merge_status=$?
  if [ "$merge_status" -eq 0 ]; then
    post_head="$(head_sha)" || die "cannot resolve the refreshed workspace HEAD"
    regenerate_prisma_client "$pre_head" "$post_head"
    return 0
  fi
  conflicts="$(git diff --name-only --diff-filter=U | paste -sd, -)"
  git merge --abort >/dev/null 2>&1 || true
  if [ -n "$conflicts" ]; then
    persist_refresh_conflict "$pre_head" "$target_head" "$conflicts"
    return 2
  fi
  [ -z "$merge_output" ] || printf '%s\n' "$merge_output" >&2
  die "target refresh merge failed without conflicts (exit $merge_status)"
}

prepare() {
  local base_head result prepared_head incoming_head output_dir reuse_source
  output_dir="$(dirname "$OUTPUT_FILE")"
  [ ! -L "$output_dir" ] || die "refusing symlinked regression output directory"
  rm -f -- "$OUTPUT_FILE" || die "cannot clear stale regression output handoff"
  incoming_head="$(head_sha)" || die "cannot resolve incoming workspace HEAD"
  base_head="$(fetch_base)" || die "cannot refresh target head"
  refresh_onto_target "$base_head"
  result=$?
  [ "$result" -eq 0 ] || return 0
  prepared_head="$(head_sha)" || die "cannot resolve prepared workspace HEAD"
  reuse_source="$(recovery_reuse_source "$incoming_head")"
  if [ -n "$reuse_source" ]; then
    write_state "$prepared_head" "$base_head" reused "$reuse_source"
    printf 'REGRESSION PREPARE: semantic-reused %s from %s\n' "$prepared_head" "$reuse_source"
  else
    write_state "$prepared_head" "$base_head"
    printf 'REGRESSION PREPARE: ready %s %s\n' "$prepared_head" "$base_head"
  fi
}

semantic_stale() {
  local target_head="$1" result refreshed_head
  # A base move invalidates the prepare-time semantic reuse authorization even
  # when refreshing the workspace later reports a conflict. Do not leave a
  # skipped-review marker available to a subsequent finalize invocation.
  [ "${SEMANTIC_VERDICT:-}" = "reused" ] && clear_reuse_state
  refresh_onto_target "$target_head"
  result=$?
  [ "$result" -eq 0 ] || return 0
  refreshed_head="$(head_sha)" || die "cannot resolve refreshed workspace HEAD"
  write_state "$refreshed_head" "$target_head"
  printf 'REGRESSION FINALIZE: semantic-stale %s %s\n' "$refreshed_head" "$target_head"
  return "$EXIT_SEMANTIC_STALE"
}

review_fail() {
  local summary="$1" current verdict
  [ -n "$summary" ] || die "review-fail requires a non-empty summary"
  read_state
  current="$(head_sha)" || die "cannot resolve review-fail workspace HEAD"
  [ "$current" = "$VERIFIED_HEAD_SHA" ] || die "workspace HEAD changed after prepare; rerun prepare and semantic verification"
  # The model has now supplied a negative semantic verdict. Clear any
  # prepare-time reuse marker before publishing it so a later accidental
  # finalize cannot resurrect the skipped review as a PASS.
  write_state "$current" "$BASE_HEAD_SHA"
  verdict="$(json_verdict review-fail "$current" "$BASE_HEAD_SHA" "$summary")"
  persist_output "$verdict" "$current"
  printf 'REGRESSION REVIEW-FAIL: persisted %s\n' "$current"
}

finalize() {
  local current latest gate_log gate_status gate_proof gate_failure_summary gate_failure_excerpt attempt verdict
  read_state
  current="$(head_sha)" || die "cannot resolve finalize workspace HEAD"
  if [ "$current" != "$VERIFIED_HEAD_SHA" ]; then
    [ "$SEMANTIC_VERDICT" = "reused" ] && clear_reuse_state
    die "workspace HEAD changed after semantic verification"
  fi

  # Most drift is discovered and integrated before acquire, so no other chain
  # queues behind a tree that still needs another model pass.
  latest="$(fetch_base)" || die "cannot refresh target head"
  if [ "$latest" != "$BASE_HEAD_SHA" ]; then
    semantic_stale "$latest"
    return $?
  fi

  current="$(head_sha)" || die "cannot resolve gated workspace HEAD"
  gate_log="$(mktemp "${TMPDIR:-/tmp}/regression-gate.XXXXXX")" \
    || die "cannot create gate output file"
  GATE_LOG="$gate_log"
  gate_status=76
  for attempt in 1 2 3; do
    : > "$gate_log"
    gate_status=0
    AGENTOS_RUN_SCOPE_BYPASS=regression-verification \
      "$GATE_DISPATCH" "$current" --master "$BASE_HEAD_SHA" > "$gate_log" 2>&1 \
      || gate_status=$?
    case "$gate_status" in
      75|76)
        [ "$attempt" -lt 3 ] && continue
        ;;
      *) break ;;
    esac
  done
  gate_proof="$(gate_verdict_read "$gate_log")" || gate_proof=""

  # Gate execution may be long. Do not publish evidence against a base that
  # moved while it ran; readiness performs the final check again under Lease.
  latest="$(fetch_base)" || die "cannot refresh target head after gate"
  if [ "$latest" != "$BASE_HEAD_SHA" ]; then
    semantic_stale "$latest"
    return $?
  fi

  case "$gate_proof" in
    "MERGE GATE: PASS $current")
      verdict="$(json_verdict pass "$current" "$BASE_HEAD_SHA" "$gate_proof" "" "$SEMANTIC_VERDICT" "$SEMANTIC_SOURCE_RUN_ID")"
      persist_output "$verdict" "$current"
      printf 'REGRESSION FINALIZE: pass %s\n' "$current"
      ;;
    'MERGE GATE: FAIL ('*')')
      gate_failure_summary="${gate_proof#MERGE GATE: FAIL (}"
      gate_failure_summary="${gate_failure_summary%)}"
      gate_failure_excerpt="$(extract_gate_failure_excerpt "$gate_log" "$gate_failure_summary")" \
        || die "could not extract gate failure excerpt from gate log"
      verdict="$(json_verdict gate-fail "$current" "$BASE_HEAD_SHA" "$gate_proof" "$gate_failure_excerpt" "$SEMANTIC_VERDICT" "$SEMANTIC_SOURCE_RUN_ID")"
      persist_output "$verdict" "$current"
      printf 'REGRESSION FINALIZE: gate-fail %s\n' "$current"
      ;;
    *)
      print_gate_no_verdict_tail "$gate_log" "$attempt" "$gate_status"
      die "gate dispatch produced no admissible PASS/FAIL verdict after $attempt attempt(s) (exit $gate_status)"
      ;;
  esac
}

MODE="${1:-}"
case "$MODE" in
  prepare)
    [ "$#" -eq 1 ] || die "usage: $0 prepare"
    prepare
    ;;
  finalize)
    [ "$#" -eq 1 ] || die "usage: $0 finalize"
    finalize
    ;;
  review-fail)
    [ "$#" -eq 2 ] || die "usage: $0 review-fail <summary>"
    review_fail "$2"
    ;;
  *) die "usage: $0 prepare | finalize | review-fail <summary>" ;;
esac
