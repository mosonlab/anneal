import type { FailureClass } from "@prisma/client";

/**
 * The structured account a runner gives of a failed run.
 *
 * It exists because failure classification used to be a regex sweep over
 * `stderr + stdout` inside the runner (`adapters.ts classifyError`), and the
 * control plane then believed whatever verdict came back — including
 * `retryable`, which made the API's own retry whitelist dead code. Two things
 * went wrong with that:
 *
 *  - stdout is the agent's *working output*. A task that edits auth code
 *    contains "401" and "not logged in" as content, and a task that writes rate
 *    limiting contains "rate limit". Run cmsy26f2s0ibqmpmx8t6gyltg was declared
 *    AUTH_REQUIRED off a literal 401 in the code it was writing.
 *  - a retryable misverdict spends the task's run budget on retries that cannot
 *    succeed, and nothing about the decision was written down afterwards.
 *
 * So the runner now reports *facts* — which phase it was in, what exited with
 * what, which channel each piece of text came off, and whether its own typed
 * `CommandTimeoutError` fired — and the API alone turns those into a
 * `FailureClass`. The envelope is persisted on `Run.failureEnvelope`, which is
 * also the groundwork the failure-evidence work (#114) builds on: every field
 * here is already the truncated, channel-separated form that evidence storage
 * wants, so growing it later means adding rows of detail, not reinterpreting
 * what is here.
 */
export type FailureEnvelope = {
  /** Bumped when the meaning of a field changes. An API that does not
   *  recognise the version ignores the envelope and falls back to the legacy
   *  completion fields rather than guessing. */
  version: number;
  phase: FailurePhase;
  /** The runner's own first guess. Advisory: the API classifies from the facts
   *  below and honours this for exactly one class (see `classifyEnvelope`). */
  runnerClass: FailureClass | null;
  exitCode: number | null;
  signal: string | null;
  terminationReason: string | null;
  terminalEventSeen: boolean;
  terminalSuccess: boolean;
  /** True only when the agent process itself ran and reported its own exit.
   *  False when the runner's own plumbing failed around it — provisioning,
   *  preflight, an exception in runner code. This is the fact that decides
   *  whether an attempt spends the task's budget, and it replaces trusting the
   *  runner's `externalFailure` claim. */
  agentExited: boolean;
  /** Verdict channels: the CLI's structured error object and its stderr. */
  providerError: string | null;
  stderrSummary: string | null;
  /** Evidence only. Never a verdict channel for auth, rate limits or transience
   *  — that is the whole point of separating it out. */
  stdoutSummary: string | null;
  /** Set from the runner's typed `CommandTimeoutError`, never from matching the
   *  word "timeout" in text: the CLI preflight emits its own unrelated
   *  "preflight timed out after 15 seconds" for a missing binary. */
  timedOut: boolean;
  /** Set from the runner's typed transient-network predicate. */
  transient: boolean;
  /** Set from the runner's typed `RemoteBranchDivergedError`: the runner read
   *  the remote branch and found commits this Run's head lacks, either when a
   *  DELIVER push was refused or when PROVISION could not merge them into the
   *  base. Never set from git's rejection wording. */
  remoteBranchDiverged: boolean;
  timeoutMs: number | null;
};

export const FAILURE_ENVELOPE_VERSION = 1;

export const failurePhases = ["PROVISION", "EXECUTE", "DELIVER", "COMPLETE"] as const;

/**
 * Where the run was when it failed.
 *
 *  - `PROVISION` — workspace clone, agent scratch, CLI preflight.
 *  - `EXECUTE` — the agent process was running its task.
 *  - `DELIVER` — the agent was done; commit, push, pull request, cleanup.
 *  - `COMPLETE` — after delivery, reporting the terminal result.
 *
 * Only `EXECUTE` is the agent's own work. Everything else is the runner's
 * plumbing, which is why the phase is load-bearing for budget accounting.
 */
export type FailurePhase = (typeof failurePhases)[number];

/** What both sides truncate free text to. The tail is kept: a CLI's verdict is
 *  the last thing it prints, and a head-truncated stderr is a progress log. */
export const FAILURE_EVIDENCE_LIMIT = 4_000;

export const truncateEvidence = (
  value: string | null | undefined,
  limit: number = FAILURE_EVIDENCE_LIMIT,
): string | null => {
  const text = value?.trim();
  if (!text) return null;
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `…[${dropped} earlier characters truncated]\n${text.slice(text.length - limit)}`;
};
