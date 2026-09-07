import { isDeterministicRefusal } from "@anneal/github-client";

import { isCommandTimeout, KILL_OVERHEAD_MS } from "./exec.js";

const TRANSIENT_NETWORK_PATTERNS = [
  /fetch failed/i,
  /SSL_ERROR_SYSCALL/i,
  /unexpected EOF/i,
  /connection (?:reset|closed|timed out|lost)/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /HTTP(?: response)?\s*5\d\d/i,
  /status(?: code)?\s*5\d\d/i,
  /502 Bad Gateway/i,
  /503 Service Unavailable/i,
  /504 Gateway Timeout/i,
] as const;

const DETERMINISTIC_ACCESS_PATTERNS = [
  /authentication failed/i,
  /could not read Username/i,
  /permission denied/i,
  /forbidden/i,
  /HTTP(?: response)?\s*(?:401|403)/i,
  /status(?: code)?\s*(?:401|403)/i,
  /bad credentials/i,
] as const;

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Git reports some access refusals without the HTTP/status prefixes used by
 * the shared GitHub write classifier. Keep those common forms in the push
 * veto, while leaving isTransientNetworkError's agent-process vocabulary
 * untouched. */
const GIT_ACCESS_REFUSAL_PATTERNS = [
  /authorization failed/iu,
  /\bunauthorized\b/iu,
  /invalid credentials/iu,
  /requested URL returned error:\s*(?:401|403)\b/iu,
] as const;

const isDeterministicPushRefusal = (error: unknown): boolean =>
  isDeterministicRefusal(error)
  || GIT_ACCESS_REFUSAL_PATTERNS.some((pattern) => pattern.test(messageOf(error)));

export const isTransientNetworkError = (error: unknown): boolean => {
  // Our own per-command timeout is recognised by type, never by its wording.
  // adapters.ts hands this predicate raw CLI stderr, which already contains an
  // unrelated "preflight timed out after 30 seconds" for a missing/broken
  // binary; a text token would silently reclassify that as a network blip and
  // make a deterministic failure retryable.
  if (isCommandTimeout(error)) return true;
  const message = messageOf(error);
  if (DETERMINISTIC_ACCESS_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return TRANSIENT_NETWORK_PATTERNS.some((pattern) => pattern.test(message));
};

export type RetryOptions = {
  attempts?: number;
  wait?: (attempt: number) => Promise<void>;
  /** Absolute deadline (epoch ms) inherited from an enclosing retried
   *  operation, so a nested probe cannot spend budget its caller already
   *  promised to the lease. Omitted means "start a fresh budget". */
  deadline?: number;
  /** Injectable clock; tests drive the budget without sleeping. */
  now?: () => number;
  /** Per-command ceiling override for a call site with a different lease
   *  exposure than delivery's (see the clone profile below). */
  commandTimeoutMs?: number;
  /** Whole-operation budget override, paired with commandTimeoutMs. */
  budgetMs?: number;
};

/** What the retry loop hands each attempt. `timeoutMs` goes straight to
 *  exec.ts; `deadline` is for nested retried calls made inside the attempt. */
export type AttemptBudget = {
  timeoutMs?: number | undefined;
  deadline?: number | undefined;
};

// Exponential backoff with full jitter, capped per attempt. The previous
// budget (3 attempts x attempt*250ms ≈ 750ms total) was calibrated for a
// dropped packet, not an outage: on 2026-08-17 two clone attempts exhausted
// it in 0.93s and 0.51s inside the same multi-second connectivity drop, each
// burning a task session before any work started. Six attempts waiting up to
// 1s,2s,4s,8s,8s (jittered, ~23s worst-case wait total) ride out
// second-scale drops while staying well inside the 60s run lease — a retry
// loop that outlives the lease would hand the run to reconciliation as LOST
// while the clone is still retrying. Longer outages are the lease-loss
// path's job, not this loop's. These waits are only half the budget: a
// command that hangs instead of failing spends nothing here and everything in
// its own timeout, which is why the loop below is bounded by a deadline
// rather than by this attempt count alone.
export const transientBackoff = async (attempt: number): Promise<void> => {
  const ceiling = Math.min(8_000, 1_000 * 2 ** (attempt - 1));
  await new Promise<void>((resolve) => setTimeout(resolve, Math.random() * ceiling));
};

/** The send ceiling every delivery network operation shares, including the
 *  confirmed-write loop that creates pull requests. See the backoff note above
 *  for why the deadline, not this number, is what actually bounds the loop. */
export const NETWORK_ATTEMPTS = 6;

/**
 * Delivery profile — the tight one, and the default.
 *
 * Delivery is the phase the 60s run lease actually squeezes. lease.ts renews
 * the lease across it and caps it with a single shared deadline (see
 * deliveryDeadline below); these two constants are what one *operation* inside
 * that phase may spend — command timeouts, kill escalation, backoff — when it
 * is the only thing running against the whole 35s phase budget:
 *
 *   attempt 1  timeout min(20s, 35s - 0s - 4s) = 20s, costs <= 24s  -> t=24s
 *   backoff    jittered ceiling 1s                                  -> t<=25s
 *   attempt 2  timeout min(20s, 10s - 4s)      =  6s, costs <= 10s  -> t<=35s
 *   remaining budget < 5s + 4s, so no attempt 3 and no further backoff: the
 *   loop rethrows the timeout at t <= 35s, inside the lease.
 *
 * The fast-failing case (a refused connection, PR #109's scenario) is paced by
 * the jittered waits instead: 6 attempts, <= 1+2+4+8+8 = 23s. Both land inside
 * the budget. The attempt count is therefore no longer what bounds the loop — the
 * deadline is, so changing either constant re-derives the attempt count on its
 * own.
 *
 * 20s is deliberately tight for a *push*, and it can only be as generous as
 * the lease allows. That is the trade this issue accepts: a push slower than
 * 20s was already racing reconciliation, and failing it fast and transiently
 * is cheaper than being declared LOST. The push runs first in delivery, so it
 * has first claim on the shared budget. When a run must open a pull request,
 * the `gh` calls after it fail delivery while leaving the published branch in
 * place for the retry.
 *
 * NETWORK_OPERATION_BUDGET_MS is only the fallback for a caller that supplies
 * no phase deadline. Delivery always supplies one.
 */
export const NETWORK_COMMAND_TIMEOUT_MS = 20_000;
export const NETWORK_OPERATION_BUDGET_MS = 45_000;

/**
 * Clone profile — provisioning, where the lease is not the binding constraint.
 *
 * runner.ts keeps a heartbeat running for the whole of provisionWorkspace, so
 * a slow clone renews the lease instead of losing it, and killing a large but
 * healthy clone at the delivery ceiling would break working runs to fix a
 * failure mode they do not have. What provisioning genuinely lacks is any
 * *other* bound: no budget gate runs before the agent starts, so a clone that
 * hangs holds the claim until a human notices.
 *
 *   attempt 1  timeout min(120s, 300s - 4s) = 120s, costs <= 124s -> t=124s
 *   attempt 2  timeout 120s                        costs <= 124s -> t<=249s
 *   attempt 3  timeout min(120s, 49s - 4s)  =  45s, costs <=  49s -> t<=300s
 *
 * So a hung clone costs at most 5 minutes instead of forever, while a clone
 * that is merely slow gets two full minutes per attempt.
 */
export const CLONE_COMMAND_TIMEOUT_MS = 120_000;
export const CLONE_OPERATION_BUDGET_MS = 300_000;

/**
 * First-clone profile — a cold mirror transfers the whole repository and
 * cannot resume safely after a retry. Give that one fetch a long, single
 * attempt ceiling instead of restarting a partial transfer from zero.
 */
export const CLONE_CREATION_TIMEOUT_MS = 1_800_000;

/** Dependency installation is substantially heavier than cloning this
 * repository, but it still needs a finite process-group ceiling. The runner
 * heartbeat remains active throughout provisioning, so this bound protects
 * against a wedged registry or install hook rather than the delivery lease. */
export const NPM_INSTALL_COMMAND_TIMEOUT_MS = 600_000;
export const NPM_INSTALL_OPERATION_BUDGET_MS = 1_800_000;

/**
 * Reserved out of the lease for everything in the delivery phase that is not a
 * network command, worst case, with a 60s lease and a 10s API ceiling:
 *
 *   9s  the one floored attempt the loop may start with almost no budget left
 *       (MIN_ATTEMPT_TIMEOUT_MS + kill overhead)
 *  10s  the terminal completion write (RUNNER_API_TIMEOUT_MS; the API only
 *       accepts it while the lease is live)
 *   6s  what is left for workspace cleanup, which is local disk work and is
 *       covered by the delivery heartbeat anyway
 */
export const DELIVERY_LEASE_RESERVE_MS = 25_000;

/** Floor for the budget. Two cases reach it: a deployment configured with a
 *  very short lease, and a delivery whose opening renewal failed so the last
 *  known-good renewal is already old. In both, publishing the run's work is
 *  worth more than the bound — the branch on the remote is what reconciliation
 *  reads back — so delivery gets a small *bounded* attempt rather than none. */
export const MIN_DELIVERY_BUDGET_MS = 10_000;

/**
 * The one deadline the whole delivery phase shares — push, the gh probe, PR
 * lookup, PR creation, its idempotency probe and the confirming lookup.
 *
 * Two things make this necessary. Per-*operation* budgets do not compose: four
 * sequential operations each opening a fresh budget is three lease-lengths.
 * And the phase does not start with a fresh lease — the run-loop heartbeat
 * fires every leaseSeconds/2, so by the time the agent exits the last renewal
 * can already be half a lease old.
 *
 * `leaseRenewedAtMs` must be the moment the renewing request was *sent*, not
 * the moment its response arrived. The server stamps `leaseExpiresAt = S + lease`
 * at its own S, which is at or after the send; measuring from the response
 * instead silently borrows the round-trip time from the reserve, and a slow
 * response would make this arithmetic claim budget the lease does not have.
 *
 * With a 60s lease: 35s of network work, 44s worst case including the floored
 * attempt, and >=16s for cleanup and the terminal completion call.
 */
export const deliveryDeadline = (leaseRenewedAtMs: number, leaseSeconds: number, nowMs: number): number => Math.max(
  leaseRenewedAtMs + (leaseSeconds * 1_000 - DELIVERY_LEASE_RESERVE_MS),
  nowMs + MIN_DELIVERY_BUDGET_MS,
);

/** Thrown when a retried operation is asked to start after its deadline.
 *  Deliberately *not* classified transient: retrying an exhausted budget can
 *  only overrun it further, and the loop's own guard would reject the next
 *  attempt anyway. */
export class DeadlineExceededError extends Error {
  constructor(deadline: number) {
    super(`network operation budget exhausted before the attempt could start (deadline ${deadline})`);
    this.name = "DeadlineExceededError";
  }
}

/** Below this there is no point starting another attempt: a network command
 *  that has not connected in 5s under an outage will not in 2s either, and a
 *  truncated timeout would just manufacture a second timeout error. It is also
 *  the one documented way a phase may overrun its deadline — by at most this
 *  plus the kill overhead, once. */
export const MIN_ATTEMPT_TIMEOUT_MS = 5_000;

/** Run an external network operation with a bounded retry budget. Each attempt
 * receives the per-command timeout it must not exceed, plus the shared
 * deadline any nested retried call must inherit. */
const retryNetworkOperation = async <T>(
  operation: (budget: AttemptBudget) => Promise<T>,
  options: RetryOptions = {},
  shouldRetry: (error: unknown) => boolean,
): Promise<T> => {
  const attempts = options.attempts ?? NETWORK_ATTEMPTS;
  const wait = options.wait ?? transientBackoff;
  const now = options.now ?? (() => Date.now());
  const ceiling = options.commandTimeoutMs ?? NETWORK_COMMAND_TIMEOUT_MS;
  const deadline = options.deadline ?? now() + (options.budgetMs ?? NETWORK_OPERATION_BUDGET_MS);
  const remaining = (): number => deadline - now();
  let attempt = 1;
  for (;;) {
    // An attempt started past the deadline is pure overrun: it cannot help and
    // its floored timeout would stack on top of the budget the caller already
    // promised the lease. This is what stops a nested probe from adding a
    // second overshoot to the one its caller just spent.
    if (remaining() <= 0) throw new DeadlineExceededError(deadline);
    const timeoutMs = Math.max(MIN_ATTEMPT_TIMEOUT_MS, Math.min(ceiling, remaining() - KILL_OVERHEAD_MS));
    try {
      return await operation({ timeoutMs, deadline });
    } catch (error: unknown) {
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      // Checked on both sides of the wait: before, so an exhausted budget is
      // not spent sleeping for an attempt that will never run; after, because
      // the wait itself is budget.
      if (remaining() < MIN_ATTEMPT_TIMEOUT_MS + KILL_OVERHEAD_MS) throw error;
      await wait(attempt);
      if (remaining() < MIN_ATTEMPT_TIMEOUT_MS + KILL_OVERHEAD_MS) throw error;
      attempt += 1;
    }
  }
};

/** Retry only failures classified as transient. This is the policy for clone,
 * fetch, ls-remote, npm and GitHub read operations; their existing phrase
 * vocabulary remains unchanged. */
export const retryTransientNetwork = async <T>(
  operation: (budget: AttemptBudget) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => retryNetworkOperation(operation, options, isTransientNetworkError);

/** Git ref updates are idempotent: repeating the same push converges on the
 * same remote ref even when the first response was lost. Their retry policy is
 * therefore veto based: only a deterministic refusal stops the loop, while an
 * otherwise unknown transport or command error gets the existing bounded
 * retry budget. */
const retryPush = async <T>(
  operation: (budget: AttemptBudget) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => retryNetworkOperation(operation, options, (error) => !isDeterministicPushRefusal(error));

/** `gh --version` is a liveness probe for a local binary, not a network call,
 *  so it is not retried — but it still runs inside the delivery phase, and an
 *  uncapped probe would be a hole in the phase bound wide enough to lose a run
 *  through. */
export const GH_PROBE_TIMEOUT_MS = 10_000;

/** Reading the current commit is a local repository query. It should finish
 *  promptly, but still needs a ceiling because it runs inside delivery's
 *  lease-bound phase. */
export const WORKSPACE_HEAD_TIMEOUT_MS = 5_000;

/** The ceiling for a command that is not on the retry allowlist but still runs
 *  inside a deadline-bounded phase. Same clamp the retry loop applies, minus
 *  the retrying. */
export const boundedTimeout = (options: RetryOptions, ceiling: number): number => {
  if (options.deadline === undefined) return ceiling;
  const now = options.now ?? (() => Date.now());
  return Math.max(MIN_ATTEMPT_TIMEOUT_MS, Math.min(ceiling, options.deadline - now() - KILL_OVERHEAD_MS));
};

/**
 * Whether the shared phase deadline still has room to start something that
 * needs `required` milliseconds. A caller with no deadline (a test, a
 * non-delivery path) always has room.
 *
 * `required` defaults to the same floor the retry loop applies between its own
 * attempts: a command started with less than one minimum attempt plus its kill
 * overhead cannot finish inside the deadline, and `boundedTimeout` would floor
 * its timeout back up to MIN_ATTEMPT_TIMEOUT_MS anyway — so a bare `> 0` test
 * would let 1ms of remaining budget buy a five-second `gh pr create` that
 * overruns the lease. The confirmed-write loop consults this before every send,
 * so an exhausted budget stops it between a read-back and a resend rather than
 * mid-command.
 */
export const budgetRemains = (
  options: RetryOptions,
  required: number = MIN_ATTEMPT_TIMEOUT_MS + KILL_OVERHEAD_MS,
): boolean => {
  if (options.deadline === undefined) return true;
  const now = options.now ?? (() => Date.now());
  return options.deadline - now() >= required;
};

const RETRIED_GIT_OPERATIONS = new Set(["clone", "fetch", "push", "ls-remote"]);

/**
 * Central command policy for delivery network calls. Keeping the allowlist
 * here prevents a later `git fetch` path from accidentally bypassing the same
 * reliability contract while ordinary command failures remain single-shot.
 *
 * Everything on this list is either a read or a write whose repetition is a
 * no-op: a second `git push` of the same ref pushes nothing, a second
 * `gh pr list` lists the same rows, and dependency-cache.ts clears every
 * declared target before each `npm ci` attempt. No *creating* GitHub write is
 * on it, and
 * `gh pr create` was taken off it by #139. A loop that resends on an error
 * alone cannot tell a lost response from a failed one, and for a creating write
 * that difference is a duplicate object — those go through
 * `@anneal/github-client`'s confirmedWrite, which resends only after a
 * read-back has positively found nothing.
 */
export const runWithNetworkRetry = async <T>(
  executable: string,
  args: readonly string[],
  operation: (budget: AttemptBudget) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const retryableCommand = (executable === "git" && RETRIED_GIT_OPERATIONS.has(args[0] ?? ""))
    || (executable === "gh" && args[0] === "pr" && args[1] === "list")
    || (executable === "npm" && args[0] === "ci");
  // The allowlist decides the timeout as well as the retry: a local `git
  // commit` or `git checkout` of a huge tree is slow, not hung, and killing it
  // at 20s would turn a working run into a failed one. Only a command that
  // talks to the network can stop making progress without ever returning.
  if (!retryableCommand) return operation({});
  return executable === "git" && args[0] === "push"
    ? retryPush(operation, options)
    : retryTransientNetwork(operation, options);
};
