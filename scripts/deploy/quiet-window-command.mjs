import { spawn } from "node:child_process";
import { basename } from "node:path";

import { DeployFailure } from "./quiet-window-lib.mjs";

export const COMMAND_KILL_GRACE_MS = 2_000;

/** Every reader of a deploy subprocess's output parses English: the remote-main
 * reader's transport and auth patterns, the escalation classifier's `fatal: `
 * source-transport allowlist, and the builder's own clone retry. A host whose
 * git is translated — macOS resolves an unset `LANG` through `AppleLanguages`,
 * so a launchd job on a non-English desktop is translated by default — answers
 * every one of those with a silent no, and a transient clone failure latches
 * the pipeline for an operator instead of retrying itself. Pin the child to the
 * locale those patterns are written against. `C` is deliberate rather than
 * `LC_MESSAGES=C`: gettext ignores `LANGUAGE` only when `LC_ALL` is `C`. */
export const deployChildEnvironment = (env = process.env) => ({ ...env, LC_ALL: "C" });

const timeoutFailure = (program, timeoutMs, reason) => new DeployFailure(
  reason,
  `program-${basename(program)}-timeout-${timeoutMs}ms`,
);

/** Run one deploy subprocess inside a bounded lifetime. The child leads a
 * process group so a timed-out npm/Prisma parent cannot leave helpers behind. */
export const runDeployCommand = (program, args, {
  cwd,
  env,
  capture = false,
  timeoutMs,
  timeoutReason,
  signal,
  abortFailure,
  abortSignal = () => "SIGTERM",
  allowAfterAbort = false,
  killGraceMs = COMMAND_KILL_GRACE_MS,
  onTermination = () => undefined,
} = {}) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("deploy-command-timeout-required");
  }
  if (typeof timeoutReason !== "string" || timeoutReason === "") {
    throw new TypeError("deploy-command-timeout-reason-required");
  }
  if (!allowAfterAbort && signal?.aborted) {
    throw abortFailure?.() ?? new DeployFailure("deploy-interrupted", "aborted-before-spawn");
  }

  return new Promise((accept, reject) => {
    const child = spawn(program, args, {
      cwd,
      env: deployChildEnvironment(env),
      shell: false,
      detached: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let settled = false;
    let terminationFailure = null;
    let childClosed = false;
    let killSent = false;
    let stdout = "";
    let stderr = "";
    const settleTimers = [];
    const signalGroup = (childSignal) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, childSignal); } catch { /* already gone */ }
    };
    const cleanUp = () => {
      if (!allowAfterAbort) signal?.removeEventListener("abort", onAbort);
      for (const timer of settleTimers) clearTimeout(timer);
    };
    const settle = (action) => {
      if (settled) return;
      settled = true;
      cleanUp();
      action();
    };
    const terminateGroup = (failure, initialSignal) => {
      if (terminationFailure !== null) return;
      terminationFailure = failure;
      onTermination(failure, initialSignal);
      signalGroup(initialSignal);
      // The group kill deliberately happens even if the leader closes during
      // the grace. A pipe-detached descendant may still be alive.
      setTimeout(() => {
        killSent = true;
        signalGroup("SIGKILL");
        if (childClosed) settle(() => reject(terminationFailure));
      }, killGraceMs);
      // Last resort: a process in uninterruptible sleep may never close.
      settleTimers.push(setTimeout(
        () => settle(() => reject(terminationFailure)),
        2 * killGraceMs,
      ));
    };
    const onAbort = () => {
      terminateGroup(
        abortFailure?.() ?? new DeployFailure("deploy-interrupted", "aborted"),
        abortSignal(),
      );
    };

    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    if (!allowAfterAbort) signal?.addEventListener("abort", onAbort, { once: true });

    settleTimers.push(setTimeout(() => {
      terminateGroup(timeoutFailure(program, timeoutMs, timeoutReason), "SIGTERM");
    }, timeoutMs));

    child.once("error", (error) => settle(() => reject(
      terminationFailure ?? error,
    )));
    child.once("close", (code, childSignal) => {
      if (terminationFailure === null) {
        settle(() => accept({ code: code ?? 1, signal: childSignal, stdout, stderr }));
        return;
      }
      childClosed = true;
      if (killSent) settle(() => reject(terminationFailure));
    });
  });
};
