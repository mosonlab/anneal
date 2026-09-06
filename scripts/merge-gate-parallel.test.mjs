// Fixtures for parallel_steps and for the verdict cleanup prints, both in
// scripts/merge-gate.sh.
//
// The gate runs its steps in concurrent groups, and a parallel group is where
// the two properties a verdict depends on are normally lost: that every failure
// is reported, and that the report says which step each result belongs to. Both
// are invisible on a green run, so they are tested here rather than inferred
// from gates that happened to pass.
//
// The third property is that a run which was stopped does not report a verdict.
// A gate killed mid-step used to print MERGE GATE: FAIL naming whichever step it
// was in, so a reviewer reading that line recorded a judgement about the commit
// that nothing had formed. Nothing about it is visible on a green run either.
//
// Every fixture here sources a file the gate itself sources, and runs it for
// real. Re-typing one into a fixture would test a copy, and the copy is the one
// thing that cannot drift into disagreeing with the gate while still passing.
// All three used to be sliced out of merge-gate.sh by string offsets, which
// needed a guard assertion apiece to notice when the slicing stopped matching
// and silently failed to notice when a slice still matched the wrong text; a
// file the gate sources needs neither.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

// Sourced by the harnesses below rather than restated in them. The verdict's
// exit codes and the four lines that carry them live in one file, and a fixture
// that re-typed them would keep passing while the gate's real output changed
// underneath it — which is the whole reason the module exists.
const libPath = fileURLToPath(new URL("../packages/runner/runtime-tools/gate-worker/lib.sh", import.meta.url));
// The engine itself. What a step is, what a group of them is, and what the run
// learned are all behind this one interface, so a fixture declares its inputs
// and nothing else.
const enginePath = fileURLToPath(new URL("./gate-worker/step-engine.sh", import.meta.url));
// How much of the host the gate may use: one stated share, every width derived
// from it, and the refusals that guard both.
const hostSizingPath = fileURLToPath(new URL("./gate-worker/host-sizing.sh", import.meta.url));
// How a run ends and which last line it ends with: cleanup, the signal handler,
// and the traps that route every ending through the same accounting.
const verdictPath = fileURLToPath(new URL("./gate-worker/verdict.sh", import.meta.url));

const test = (name, body) => nodeTest(name, { concurrency: true }, body);

// The two helpers host-sizing.sh is owed. `note` is the gate's log format, not
// the sizing's, so the fixture supplies a silent one and reads the derived
// values back itself.
const runHostSizing = (hostShare) => {
  const env = { ...process.env };
  if (hostShare === undefined) delete env.AGENTOS_GATE_HOST_SHARE;
  else env.AGENTOS_GATE_HOST_SHARE = hostShare;
  const harness = `
die() { printf '%s\\n' "$*" >&2; exit 1; }
note() { :; }
. ${JSON.stringify(hostSizingPath)}
printf 'GATE_HOST_SHARE=%s\\nGATE_CPUS=%s\\n' "$GATE_HOST_SHARE" "$GATE_CPUS"
`;
  return spawnSync("bash", ["-c", harness], { encoding: "utf8", env });
};

test("HOST-SHARE defaults to half the host while explicit and invalid values keep their precedence", () => {
  const cores = availableParallelism();

  const defaultShare = runHostSizing(undefined);
  assert.equal(defaultShare.status, 0, defaultShare.stderr);
  assert.equal(
    defaultShare.stdout,
    `GATE_HOST_SHARE=2\nGATE_CPUS=${Math.max(1, Math.floor(cores / 2))}\n`,
  );

  const wholeHost = runHostSizing("1");
  assert.equal(wholeHost.status, 0, wholeHost.stderr);
  assert.equal(wholeHost.stdout, `GATE_HOST_SHARE=1\nGATE_CPUS=${cores}\n`);

  const invalid = runHostSizing("3");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /AGENTOS_GATE_HOST_SHARE must be 1 or 2, got 3/);
});

// Enough of the gate for the engine to run: the two output helpers it owes the
// engine, the temp root it writes member logs into, and the working directory
// it runs members in. Nothing here stands in for the behaviour being tested.
const ENGINE = `
set -uo pipefail
say() { printf '\\n== %s\\n' "$1"; }
note() { printf '   %s\\n' "$1"; }
. ${JSON.stringify(libPath)}
. ${JSON.stringify(enginePath)}
gate_steps_begin
`;

const HARNESS = `${ENGINE}
GATE_TMP="$1"
REPO_ROOT="$2"
`;

// Runs one group and reports what the gate would have: the exit status, the
// replayed output, the step report lines, and the failed-step string that
// becomes `MERGE GATE: FAIL (...)`.
const runGroup = (members) => {
  const root = mkdtempSync(join(tmpdir(), "merge-gate-parallel."));
  try {
    const script = join(root, "harness.sh");
    writeFileSync(
      script,
      `${HARNESS}\nparallel_steps ${members}\nstatus=$?\n` +
        `printf 'REPORT-BEGIN\\n'\n` +
        `for line in "\${STEP_REPORT[@]:-}"; do printf '%s\\n' "$line"; done\n` +
        `printf 'REPORT-END\\n'\n` +
        `printf 'FAILED_STEP=%s\\n' "$FAILED_STEP"\n` +
        `printf 'NO_VERDICT=%s\\n' "$NO_VERDICT_REASON"\n` +
        `exit "$status"\n`,
    );
    const result = spawnSync("bash", [script, root, root], { encoding: "utf8" });
    const stdout = result.stdout ?? "";
    const report = stdout
      .slice(stdout.indexOf("REPORT-BEGIN") + "REPORT-BEGIN\n".length, stdout.indexOf("REPORT-END"))
      .split("\n")
      .filter((line) => line.trim() !== "");
    const failedStep = /^FAILED_STEP=(.*)$/m.exec(stdout)?.[1] ?? "";
    const noVerdict = /^NO_VERDICT=(.*)$/m.exec(stdout)?.[1] ?? "";
    return { status: result.status, stdout, stderr: result.stderr ?? "", report, failedStep, noVerdict };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("PARALLEL-ALL every member runs, and the group passes when they all do", () => {
  const run = runGroup(
    `"a group" "first" sh -c 'echo ran-first' :: "second" sh -c 'echo ran-second' :: "third" sh -c 'echo ran-third'`,
  );
  assert.equal(run.status, 0);
  assert.match(run.stdout, /ran-first/);
  assert.match(run.stdout, /ran-second/);
  assert.match(run.stdout, /ran-third/);
  assert.equal(run.report.length, 3);
  for (const line of run.report) assert.match(line, /^ok /);
  assert.equal(run.failedStep, "");
});

test("PARALLEL-ORDER replays member output in submission order, not completion order", () => {
  // The first member is deliberately the slowest, so completion order is the
  // reverse of submission order and an unbuffered group would prove it.
  const run = runGroup(
    `"a group" "slow" sh -c 'sleep 1; echo from-slow' :: "quick" sh -c 'echo from-quick'`,
  );
  assert.equal(run.status, 0);
  const slowHeading = run.stdout.indexOf("--- slow ---");
  const quickHeading = run.stdout.indexOf("--- quick ---");
  assert.ok(slowHeading !== -1 && quickHeading !== -1, "both members should be replayed under their labels");
  assert.ok(slowHeading < quickHeading, "submission order should survive completion order");
  // Each member's output belongs under its own heading, not merged into one stream.
  assert.ok(run.stdout.indexOf("from-slow") > slowHeading);
  assert.ok(run.stdout.indexOf("from-slow") < quickHeading);
});

test("PARALLEL-FAIL-ALL names every failing member, not only the first", () => {
  const run = runGroup(
    `"a group" "good" true :: "bad one" false :: "bad two" sh -c 'exit 3'`,
  );
  assert.equal(run.status, 1);
  // The whole point of running these together: one gate reports both problems.
  assert.equal(run.failedStep, "bad one, bad two");
  assert.equal(run.report.filter((line) => line.startsWith("FAIL")).length, 2);
  assert.equal(run.report.filter((line) => line.startsWith("ok")).length, 1);
});

test("PARALLEL-FAIL-ONE names the single failing member", () => {
  const run = runGroup(`"a group" "good" true :: "bad" false`);
  assert.equal(run.status, 1);
  assert.equal(run.failedStep, "bad");
});

test("PARALLEL-DURATION charges each member for its own time, not the wait before it", () => {
  // The quick member is submitted second. Timed from the parent, it would be
  // charged for the slow member's three seconds too, because the parent waits
  // in submission order.
  const run = runGroup(
    `"a group" "slow" sh -c 'sleep 3' :: "quick" sh -c 'true'`,
  );
  assert.equal(run.status, 0);
  const quick = run.report.find((line) => line.includes("quick"));
  assert.ok(quick, "the quick member should appear in the report");
  const seconds = Number(/(\d+)s$/.exec(quick.trim())?.[1]);
  assert.ok(Number.isInteger(seconds), `expected a duration, got ${quick}`);
  assert.ok(seconds <= 1, `the quick member should not be charged for the slow one: ${quick}`);
});

test("PARALLEL-STOPPED a member killed from outside is not a FAIL", () => {
  // The incident this exists for: an operator killed the process tree of a gate
  // that had deadlocked, and the gate reported MERGE GATE: FAIL naming the
  // group. Nothing in that group judged the commit — it was stopped — and a
  // reviewer who copies that line records a verdict that was never formed.
  const run = runGroup(`"a group" "good" true :: "killed" sh -c 'kill -TERM $$; sleep 30'`);
  assert.equal(run.status, 1);
  assert.equal(run.failedStep, "killed");
  assert.match(run.noVerdict, /^killed was stopped before it could be judged$/);
  assert.equal(run.report.filter((line) => line.startsWith("STOP")).length, 1);
  assert.equal(run.report.filter((line) => line.startsWith("FAIL")).length, 0);
});

test("PARALLEL-STOPPED a member that crashed on its own is still a FAIL", () => {
  // The boundary. SIGSEGV is the code under test behaving badly, not an
  // operator stopping the run, and treating it as "no verdict" would let a real
  // failure be re-dispatched as an errand until somebody read the log.
  const run = runGroup(`"a group" "crashed" sh -c 'kill -SEGV $$; sleep 30'`);
  assert.equal(run.status, 1);
  assert.equal(run.failedStep, "crashed");
  assert.equal(run.noVerdict, "");
  assert.equal(run.report.filter((line) => line.startsWith("FAIL")).length, 1);
});

test("PARALLEL-STOPPED a real failure outranks a member that was stopped", () => {
  // The gate did learn something about the commit, so the run has a verdict and
  // the stopped member does not erase it.
  const run = runGroup(
    `"a group" "bad" false :: "killed" sh -c 'kill -TERM $$; sleep 30'`,
  );
  assert.equal(run.status, 1);
  assert.equal(run.failedStep, "bad");
  assert.equal(run.noVerdict, "");
});

test("PARALLEL-USAGE refuses a member with no command", () => {
  const run = runGroup(`"a group" "label only"`);
  assert.notEqual(run.status, 0);
  // Usage errors go to stderr, where every other refusal in the gate puts them.
  assert.match(run.stderr, /names no command/);
});

// --- what the run learned ---------------------------------------------------

// gate_steps_outcome is the one place the engine's precedence rule is written:
// a failure the run observed outranks a signal that arrived afterwards, and
// only a run that learned nothing reports the absence of a verdict. Until it
// existed the rule could only be observed through the line cleanup printed,
// which is why the same `if` had to be repeated in cleanup and in the signal
// handler and why one of the two was wrong.
const runOutcome = (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "merge-gate-outcome."));
  try {
    const script = join(root, "outcome.sh");
    writeFileSync(script, `${HARNESS}\n${scenario}\ngate_steps_outcome\n`);
    const result = spawnSync("bash", [script, root, root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return (result.stdout ?? "").trim().split("\n").at(-1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("OUTCOME a run in which nothing failed is a pass", () => {
  assert.equal(runOutcome(`step "fine" true`), "pass");
});

test("OUTCOME a step that failed on its own names itself", () => {
  assert.equal(runOutcome(`step "bad" false || :`), "fail bad");
});

test("OUTCOME a step stopped from outside is no verdict, with the code that says so", () => {
  assert.equal(
    runOutcome(`step "killed" sh -c 'kill -TERM $$; sleep 30' || :`),
    "no-verdict 76 killed was stopped before it could be judged",
  );
});

test("OUTCOME a signal after a real failure does not unmake the failure", () => {
  // The rule, asked directly rather than through the printed line. The signal
  // is recorded either way; which one outranks is answered here and only here.
  assert.equal(
    runOutcome(`step "bad" false || :\ngate_steps_note_signal TERM 143`),
    "fail bad",
  );
});

test("OUTCOME a signal with nothing learned is no verdict under the signal's own code", () => {
  assert.equal(
    runOutcome(`FAILED_STEP="the suites"\ngate_steps_note_signal TERM 143`),
    "no-verdict 143 the gate was stopped by SIGTERM during the suites",
  );
});

// --- the verdict cleanup prints ---------------------------------------------

// cleanup() and the signal handlers, run for real against stubbed teardown. The
// question these answer is only ever "which last line, and which code", so the
// container, the lock and the temp directory are stubs; nothing they do changes
// the answer.
const VERDICT_HARNESS = `${ENGINE}
discard_gate_tmp() { :; }
release_lock() { :; }
KEEP_POSTGRES=0
POSTGRES_STARTED=0
CONTAINER=stub
GATED_HEAD=abc123
. ${JSON.stringify(verdictPath)}
`;

const runVerdict = (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "merge-gate-verdict."));
  try {
    const script = join(root, "verdict.sh");
    writeFileSync(script, `${VERDICT_HARNESS}\n${scenario}\n`);
    const result = spawnSync("bash", [script], { encoding: "utf8" });
    assert.match(stripVTControlCharacters(result.stdout ?? "").trim().split("\n").at(-1) ?? "", /^(?:MERGE GATE:|GATE NOT RUN:)/);
    return { status: result.status, stdout: result.stdout ?? "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("VERDICT an interrupted gate reports the absence of a verdict, not a FAIL", () => {
  // The defect in full: the signal arrives while a step is in flight, so
  // cleanup sees a non-zero status and a FAILED_STEP naming that step, which
  // reads exactly like the step having failed. It did not fail. It never
  // finished, and 143 is the code that says so.
  const run = runVerdict(`FAILED_STEP="the suites"\nkill -TERM $$\nsleep 30`);
  assert.equal(run.status, 143);
  assert.match(run.stdout, /GATE NOT RUN: the gate was stopped by SIGTERM during the suites/);
  assert.doesNotMatch(run.stdout, /MERGE GATE: FAIL/);
  assert.doesNotMatch(run.stdout, /MERGE GATE: PASS/);
});

test("VERDICT a stopped step exits 76, the code that means no gate judged this", () => {
  const run = runVerdict(
    `NO_VERDICT_REASON="the suites was stopped before it could be judged"\n` +
      `FAILED_STEP="the suites"\nexit 1`,
  );
  assert.equal(run.status, 76);
  assert.match(run.stdout, /GATE NOT RUN: the suites was stopped before it could be judged/);
  assert.doesNotMatch(run.stdout, /MERGE GATE: FAIL/);
});

test("VERDICT a step that really failed is still a FAIL naming it", () => {
  // The direction this must not be wrong in: nothing above may turn a judgement
  // the gate did form into an errand.
  const run = runVerdict(`FAILED_STEP="a step"\nexit 1`);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /MERGE GATE: FAIL \(a step\)/);
  assert.doesNotMatch(run.stdout, /GATE NOT RUN/);
});

test("VERDICT a cleanup that failed after every step passed is not a FAIL", () => {
  // The container would not delete, or the lock would not release. That is the
  // host failing to finish tearing this run down, and it says nothing about the
  // commit: reporting FAIL here hands a reviewer a judgement no step formed.
  // It is not a PASS either — the gate promises the container is gone — so it
  // is the code that already means "every step passed and this may still not
  // authorise a merge".
  const run = runVerdict(`release_lock() { return 1; }\nexit 0`);
  assert.equal(run.status, 3);
  assert.match(run.stdout, /MERGE GATE: NOT AUTHORITATIVE \(cleanup: the merge gate lock could not be released\)/);
  assert.doesNotMatch(run.stdout, /MERGE GATE: FAIL/);
  assert.doesNotMatch(run.stdout, /MERGE GATE: PASS/);
});

test("VERDICT container cleanup failure and intentional retention end with their verdict", () => {
  const failed = runVerdict(`POSTGRES_STARTED=1\ndocker() { return 1; }\nexit 0`);
  assert.equal(failed.status, 3);
  assert.match(failed.stdout, /NOT AUTHORITATIVE \(cleanup: postgres container stub could not be removed\)/);
  const kept = runVerdict(`KEEP_POSTGRES=1\nexit 0`);
  assert.equal(kept.status, 3);
  assert.match(kept.stdout, /NOT AUTHORITATIVE \(--keep-postgres\)/);
});

test("VERDICT a cleanup that failed after a step failed is still that step's FAIL", () => {
  // The boundary. This run did judge the commit, and nothing about the teardown
  // afterwards may turn that judgement into an errand.
  const run = runVerdict(`release_lock() { return 1; }\nFAILED_STEP="a step"\nexit 1`);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /MERGE GATE: FAIL \(a step\)/);
  assert.doesNotMatch(run.stdout, /NOT AUTHORITATIVE/);
});

test("VERDICT a clean run still passes and still names its commit", () => {
  const run = runVerdict(`exit 0`);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /MERGE GATE: PASS abc123/);
  assert.doesNotMatch(run.stdout, /GATE NOT RUN/);
});

// A group and the verdict together, which is the only way to observe what a
// signal arriving mid-group actually prints. Both files are the gate's own;
// cleanup's teardown is stubbed for the same reason as above.
const COMBINED_HARNESS = `${HARNESS}
discard_gate_tmp() { :; }
release_lock() { :; }
KEEP_POSTGRES=0
POSTGRES_STARTED=0
CONTAINER=stub
GATED_HEAD=abc123
. ${JSON.stringify(verdictPath)}
`;

// Runs a group, waits until the member that is meant to block has reported its
// pid, then signals the harness the way an operator kills a hung gate.
const interruptGroup = async (members) => {
  const root = mkdtempSync(join(tmpdir(), "merge-gate-interrupted-group."));
  try {
    const memberPidFile = join(root, "member.pid");
    const script = join(root, "harness.sh");
    writeFileSync(script, `${COMBINED_HARNESS}\n${members(JSON.stringify(memberPidFile))}\n`);
    const harness = spawn("bash", [script, root, root]);
    let stdout = "";
    harness.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    harness.stderr.on("data", () => {});

    const deadline = Date.now() + 15_000;
    let memberPid = "";
    while (Date.now() < deadline) {
      try {
        memberPid = readFileSync(memberPidFile, "utf8").trim();
        if (memberPid !== "") break;
      } catch {
        // Not written yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.notEqual(memberPid, "", "the blocking member never reported its pid");

    harness.kill("SIGTERM");
    const status = await new Promise((resolve) => harness.on("exit", (code, signal) => resolve(code ?? signal)));
    return { status, stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("VERDICT the incident shape: a group stopped mid-flight prints no verdict", async () => {
  // What the 2026-08-25 gate should have printed. Its group was stuck, the
  // operator killed it, and it answered MERGE GATE: FAIL naming the group.
  const run = await interruptGroup(
    (pidFile) => `parallel_steps "the suites" "stuck" sh -c 'printf %s "$$" > "$0"; exec sleep 30' ${pidFile}`,
  );
  assert.equal(run.status, 143);
  assert.match(run.stdout, /GATE NOT RUN: the gate was stopped by SIGTERM during the suites/);
  assert.doesNotMatch(run.stdout, /MERGE GATE: FAIL/);
});

test("VERDICT a failure seen before the signal survives it", async () => {
  // The other direction, and the reason the failure is recorded as each member
  // is reaped rather than in the group's closing accounting: that accounting
  // never runs when a later member is still blocked. Without it the gate would
  // answer "no verdict" about a commit one of its steps had already failed.
  const run = await interruptGroup(
    (pidFile) =>
      `parallel_steps "the suites" "bad" sh -c 'exit 1' :: "stuck" sh -c 'printf %s "$$" > "$0"; exec sleep 30' ${pidFile}`,
  );
  assert.equal(run.status, 1);
  assert.match(run.stdout, /MERGE GATE: FAIL \(bad\)/);
  assert.doesNotMatch(run.stdout, /GATE NOT RUN/);
});

test("PARALLEL-INTERRUPT stops members still running before the gate tears down", async () => {
  // The danger a signal creates is not a slow exit, it is a fast one: cleanup
  // removes GATE_TMP, releases the worktree lock and deletes the postgres
  // container, and a member that outlived all three keeps writing into a
  // checkout the next gate has already claimed.
  const root = mkdtempSync(join(tmpdir(), "merge-gate-interrupt."));
  try {
    const memberPidFile = join(root, "member.pid");
    const script = join(root, "harness.sh");
    writeFileSync(
      script,
      `${HARNESS}\n` +
        `trap 'gate_steps_stop_running; exit 143' TERM\n` +
        `parallel_steps "a group" "long" sh -c 'printf %s "$$" > "$0"; exec sleep 30' ${JSON.stringify(memberPidFile)}\n`,
    );
    const harness = spawn("bash", [script, root, root], { stdio: "ignore" });

    // The member has to have reported its own pid before the signal, or the
    // test would pass by racing rather than by stopping anything.
    const deadline = Date.now() + 15_000;
    let memberPid = "";
    while (Date.now() < deadline) {
      try {
        memberPid = readFileSync(memberPidFile, "utf8").trim();
        if (memberPid !== "") break;
      } catch {
        // Not written yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.notEqual(memberPid, "", "the member never reported its pid");
    assert.doesNotThrow(() => process.kill(Number(memberPid), 0), "the member should be running before the signal");

    harness.kill("SIGTERM");
    await new Promise((resolve) => harness.on("exit", resolve));

    // Checked after the harness has exited: that is the moment cleanup would
    // have finished deleting everything the member is still writing to.
    let alive = true;
    try {
      process.kill(Number(memberPid), 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `member ${memberPid} outlived the gate that started it`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PARALLEL-INTERRUPT stops the members before cleanup removes what they use", () => {
  // Order, not just presence. Signalling the members after GATE_TMP is gone
  // and the lock is released closes nothing.
  const source = readFileSync(verdictPath, "utf8");
  const cleanup = source.slice(source.indexOf("cleanup() {"));
  const stop = cleanup.indexOf("gate_steps_stop_running");
  const discard = cleanup.indexOf("discard_gate_tmp");
  const release = cleanup.indexOf("release_lock");
  assert.ok(stop !== -1, "cleanup no longer stops in-flight members");
  assert.ok(stop < discard, "cleanup removes GATE_TMP before stopping the members writing into it");
  assert.ok(stop < release, "cleanup releases the worktree lock before the members using it have stopped");
});

test("PARALLEL-ARGUMENTS passes arguments through without re-splitting them", () => {
  // %q round-tripping is what lets a member carry a quoted argument. A member
  // whose argument contains a space must arrive as one argument.
  const run = runGroup(
    `"a group" "spaced" sh -c 'printf "%s\\n" "$0"' "one two three"`,
  );
  assert.equal(run.status, 0);
  assert.match(run.stdout, /one two three/);
});
