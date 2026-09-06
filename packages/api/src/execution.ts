import { randomUUID } from "node:crypto";

import { FailureClass, type FailureEnvelope, type Prisma } from "@anneal/db";

export const makeFencingToken = (runId: string, generation: number): string =>
  `${generation}:${runId}:${randomUUID()}`;

const retryableFailureClasses: readonly FailureClass[] = [
  FailureClass.RATE_LIMITED,
  FailureClass.TRANSIENT_PROVIDER,
  FailureClass.PROTOCOL_ERROR,
];

export const failureIsRetryable = (failureClass: FailureClass): boolean => retryableFailureClasses.includes(failureClass);

export const retryDelayMs = (runNumber: number, failureClass: FailureClass): number => {
  const base = failureClass === FailureClass.RATE_LIMITED ? 60_000 : 30_000;
  return Math.min(base * (2 ** Math.max(0, runNumber - 1)), 15 * 60_000);
};

/**
 * When a replacement for a Run the platform lost may be claimed.
 *
 * The completion path has always spaced its retries; a lease-loss replacement
 * was queued at `readyAt: now`, so a runner host that is down, wedged or out of
 * disk got its replacement back at full speed and burned the task's refunds in
 * seconds. The schedule is the completion path's, read off the refunds already
 * granted rather than the run number, because that count is what this delay is
 * a function of: the nth refund waits as long as the nth retry would.
 */
export const leaseLossRetryDelayMs = (leaseLossRefunds: number): number =>
  retryDelayMs(Math.max(0, leaseLossRefunds) + 1, FailureClass.TRANSIENT_PROVIDER);

export const jsonValue = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

const replaceNul = (value: string): string => value.replaceAll("\u0000", "\\u0000");

/** PostgreSQL text and jsonb reject literal U+0000. Keep event data readable and
 * deterministic while preserving every non-NUL character and JSON shape. */
export const normalizeSessionEventValue = (value: unknown): unknown => {
  if (typeof value === "string") return replaceNul(value);
  if (Array.isArray(value)) return value.map(normalizeSessionEventValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    const usedKeys = new Set(entries.flatMap(([key]) => key.includes("\u0000") ? [] : [key]));
    return Object.fromEntries(entries.map(([key, nested]) => {
      if (!key.includes("\u0000")) return [key, normalizeSessionEventValue(nested)];

      let normalizedKey = replaceNul(key);
      while (usedKeys.has(normalizedKey)) normalizedKey += "\\u0000";
      usedKeys.add(normalizedKey);
      return [normalizedKey, normalizeSessionEventValue(nested)];
    }));
  }
  return value;
};

// --- Failure classification ------------------------------------------------
//
// The API is the only authority here. It used to share the job with the runner:
// the runner regex-grepped `stderr + stdout` and sent a `failureClass` plus a
// `retryable` flag, and the route's `body.retryable ?? failureIsRetryable(...)`
// meant the runner's answer always won — the whitelist above was dead code, and
// a runner on the far side of an untrusted boundary could declare any failure
// retryable and spend a task's whole run budget on it. Worse, the grep read the
// agent's own stdout, so a task about rate limiting failed as RATE_LIMITED and
// a task editing auth code failed as AUTH_REQUIRED.
//
// `classifyEnvelope` takes the runner's structured report of *facts* and
// decides all three questions the control plane actually cares about: what
// class, whether to retry, and whether the attempt spends the budget.

/** Auth vocabulary of the agent CLIs. Read off the provider error and stderr
 *  only — never stdout, which is where the agent's own work appears. */
const CLI_AUTH_PATTERN = /authentication_failed|\b401\b|Missing authentication|No API key found|not logged in|not-authenticated:\s*the CLI's own login check did not pass/iu;

/** Auth vocabulary of `git push` and `gh`, which is a different one. `\bauth\w*`
 *  would swallow "Author identity unknown" — git's error for a missing
 *  user.email, a config problem and not a credential one — so the terms are
 *  spelled out. */
const GIT_AUTH_PATTERN = /authentication|authorization|unauthorized|credential|permission denied|\b401\b|\b403\b/iu;

const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|usage.?limit|quota/iu;

/** The provider's own words for "try again", read off the structured provider
 *  error only — the same channel and the same terms adapters.ts checked first. */
const PROVIDER_RETRY_PATTERN = /connection lost|server_error/iu;

const PROVIDER_OUTAGE_PATTERN = /provider outage|\b(?:(?:API\s+)?Error|failed with|HTTP(?:\s+response)?|status(?:\s+code)?)\s*[:=]?\s*5\d\d\b/iu;

const PROVIDER_TRY_AGAIN_PATTERN = /try again later/iu;

/** A provider refusing the request because the model pool has no room right
 *  now: Codex's "Selected model is at capacity. Please try a different model."
 *  and Claude's equivalent capacity wording. Nothing about the task caused it
 *  and nothing about the task can avoid it — the same prompt on the same model
 *  succeeds once the pool frees up — so it belongs with the transport/outage
 *  phrases, on the verdict channels only. */
const PROVIDER_CAPACITY_PATTERN = /\bmodel\s+is\s+(?:currently\s+)?at capacity\b/iu;

/**
 * Ported from `packages/runner/src/network-retry.ts` (`TRANSIENT_NETWORK_PATTERNS`
 * and `DETERMINISTIC_ACCESS_PATTERNS`), which `adapters.ts classifyError` called
 * through `isTransientNetworkError`.
 *
 * Moving the authority here without moving this vocabulary would have been a
 * silent regression rather than a relocation: an agent whose stderr said only
 * `ECONNRESET` was TRANSIENT_PROVIDER and retryable before, and would have
 * become TASK_FAILED and final — spending an attempt and then refusing the
 * retry that used to be allowed.
 *
 * The deterministic list is a veto, not a class. It is what stops
 * "authentication failed, connection reset" from being retried into a lockout,
 * and it has to travel with the transient list to mean anything.
 *
 * One semantic *is* deliberately dropped: the runner fed this predicate
 * `stderr + stdout`. Here it sees the verdict channels only. That is the defect
 * this ticket exists to fix, not an oversight — an agent writing a network
 * retry loop has every one of these tokens in its stdout.
 */
const TRANSIENT_NETWORK_PATTERNS = [
  /fetch failed/i,
  /SSL_ERROR_SYSCALL/i,
  /unexpected EOF/i,
  /\bPost\s+"[^\"]+"\s*:\s*EOF\b/i,
  /our servers are currently overloaded/i,
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

export const transientNetworkText = (text: string): boolean => {
  if (DETERMINISTIC_ACCESS_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return TRANSIENT_NETWORK_PATTERNS.some((pattern) => pattern.test(text));
};

const envelopeVerdictText = (envelope: FailureEnvelope): string =>
  `${envelope.providerError ?? ""}\n${envelope.stderrSummary ?? ""}`;

const transientProviderText = (envelope: FailureEnvelope): boolean => {
  const verdict = envelopeVerdictText(envelope);
  return transientNetworkText(verdict)
  || PROVIDER_OUTAGE_PATTERN.test(verdict)
  || PROVIDER_CAPACITY_PATTERN.test(verdict)
  // This generic provider prompt is authoritative only on the structured
  // provider channel. Agent stderr can contain the same words from any tool
  // the task invoked and must not decide a budget refund by itself.
  || PROVIDER_TRY_AGAIN_PATTERN.test(envelope.providerError ?? "");
};

/**
 * Whether a TRANSIENT_PROVIDER verdict was reached from one of the external
 * transport/outage phrases, rather than from a typed runner marker. The
 * completion path uses this evidence to cap the new EXECUTE-phase refunds;
 * keeping it as a helper leaves the completion wire verdict unchanged.
 */
export const isTextMatchedTransientProviderFailure = (
  envelope: FailureEnvelope,
  failureClass: FailureClass,
): boolean => failureClass === FailureClass.TRANSIENT_PROVIDER
  && transientProviderText(envelope);

const TOOL_FAILURE_PATTERN = /"isError"\s*:\s*true|"command_execution"[\s\S]{0,500}"status"\s*:\s*"failed"/u;
const DEPENDENCY_PROVISIONING_MANIFEST_MISSING = "dependency-provisioning-manifest-missing";

const dependencyProvisioningManifestMissing = (envelope: FailureEnvelope): boolean =>
  envelope.phase === "PROVISION"
  && !envelope.agentExited
  && envelope.stderrSummary === DEPENDENCY_PROVISIONING_MANIFEST_MISSING;

const authPatternFor = (phase: FailureEnvelope["phase"]): RegExp =>
  phase === "DELIVER" ? GIT_AUTH_PATTERN : CLI_AUTH_PATTERN;

const envelopeFailureClass = (envelope: FailureEnvelope): FailureClass => {
  // The one runner verdict still honoured, and only because it is the single
  // class that can neither create a retry nor raise the ceiling: a runner that
  // lies here can only cost itself a run.
  if (envelope.runnerClass === FailureClass.BUDGET_EXCEEDED) return FailureClass.BUDGET_EXCEEDED;
  // Delivery itself proves this class by comparing the captured repository
  // HEAD with the workspace's starting commit. Provider output cannot express
  // that repository fact, so preserve the runner's typed observation.
  if (envelope.phase === "DELIVER" && envelope.runnerClass === FailureClass.NO_CHANGES_PRODUCED) {
    return FailureClass.NO_CHANGES_PRODUCED;
  }
  // This is a repository/runner contract violation observed before an agent
  // starts, not the runner's advisory classification. The exact named
  // condition is carried on the structured stderr evidence channel so it
  // survives the completion trust boundary without trusting runnerClass.
  if (dependencyProvisioningManifestMissing(envelope)) return FailureClass.PROTOCOL_ERROR;
  // A termination reason is an account of how *an agent session* was stopped:
  // a walltime kill, a stall kill, a cancel. `agentExited` is what says there
  // was a session at all, and without one this field is the runner narrating
  // its own crash — `runner.ts`'s catch-all stamps every escaped exception
  // `"runner exception"`, so reading it as a deliberate termination made every
  // real clone failure CANCELLED_OR_TIMED_OUT, a class no whitelist retries.
  // That is the production path issue #113 is about: the refund happened, and
  // then the run sat in REVIEW waiting for a human because a lost TLS
  // connection had been recorded as a cancellation.
  //
  // The string is still kept on the envelope. It is evidence of what the
  // runner did; it is just not evidence that a session was terminated.
  if (envelope.agentExited && envelope.terminationReason?.trim()) return FailureClass.CANCELLED_OR_TIMED_OUT;
  if (envelope.exitCode === 127) return FailureClass.BINARY_NOT_FOUND;
  // The verdict channels. `stdoutSummary` is deliberately absent: it is
  // evidence, kept for the operator and for #114, and never a verdict.
  const verdict = envelopeVerdictText(envelope);
  // Auth outranks transience. A provider error that names an auth failure must
  // not be retried into a lockout just because the same message also mentions a
  // dropped connection.
  if (authPatternFor(envelope.phase).test(verdict)) return FailureClass.AUTH_REQUIRED;
  // Typed markers outrank text. `timedOut` is set from the runner's own
  // `CommandTimeoutError` and `transient` from its typed network predicate;
  // both are things the runner observed, not phrases it matched.
  if (envelope.timedOut || envelope.transient) return FailureClass.TRANSIENT_PROVIDER;
  // Ahead of the rate-limit rule, exactly as in adapters.ts: a provider that
  // says "connection lost" and mentions a 429 in the same breath is a dropped
  // connection, and backing off for the rate-limit interval would be wrong.
  if (PROVIDER_RETRY_PATTERN.test(envelope.providerError ?? "")) return FailureClass.TRANSIENT_PROVIDER;
  if (RATE_LIMIT_PATTERN.test(verdict)) return FailureClass.RATE_LIMITED;
  if (transientProviderText(envelope)) return FailureClass.TRANSIENT_PROVIDER;
  // The one place stdout is consulted, and it is safe precisely because
  // TOOL_FAILED is neither retryable nor external: a false positive here can
  // only change the label an operator reads, never the budget or the retry
  // decision. Auth and rate limits can do both, which is why they may not.
  if (TOOL_FAILURE_PATTERN.test(`${verdict}\n${envelope.stdoutSummary ?? ""}`)) return FailureClass.TOOL_FAILED;
  // "Exited zero but never said it finished" is a statement about the *agent
  // process*, so it may only be read in the phase where that process is what
  // failed. In DELIVER the failure is the push, and the agent's own clean exit
  // has already been accepted — reading it here is what forced the runner to
  // overwrite `terminalEventSeen`/`terminalSuccess` on a mechanically settled
  // or post-delivery-disconnect run before handing the envelope over.
  if (envelope.phase === "EXECUTE" && envelope.exitCode === 0
    && (!envelope.terminalEventSeen || !envelope.terminalSuccess)) {
    return FailureClass.PROTOCOL_ERROR;
  }
  return FailureClass.TASK_FAILED;
};

const envelopeExternalFailure = (envelope: FailureEnvelope, failureClass: FailureClass): boolean => {
  // Never: raising the ceiling for exceeding the ceiling is an unbounded loop.
  if (failureClass === FailureClass.BUDGET_EXCEEDED) return false;
  // The runner observed that the agent left HEAD unchanged. This is an agent
  // outcome reported during delivery, not a delivery-plumbing failure.
  if (failureClass === FailureClass.NO_CHANGES_PRODUCED) return false;
  // The runner's own plumbing failed, so the agent never got to decide
  // anything. This replaces trusting the runner's `externalFailure` claim with
  // two facts it reports and the API can reason about.
  if (!envelope.agentExited) return true;
  // Textual transport/outage evidence is an environment failure even when an
  // agent process exited cleanly in EXECUTE. Typed transience alone is not
  // enough here: it may describe a runner-side timeout or another condition
  // whose refund policy remains phase-bound.
  if (isTextMatchedTransientProviderFailure(envelope, failureClass)) return true;
  // EXECUTE is the only phase that is the agent's own work. PROVISION (clone,
  // workspace, preflight), DELIVER and COMPLETE are all this runner's plumbing,
  // and a task must not pay a session for them — issue #113's case is a `git
  // clone` that lost its TLS connection in under a second, twice, and cost two
  // of five sessions before the agent had been started at all.
  //
  // Known trust boundary, stated rather than hidden: `phase` is the runner's
  // own account of where it was. A runner that reported PROVISION for every
  // failure would never spend budget, and — since it also chooses `transient` —
  // could keep a task retrying indefinitely. The runner is a trusted,
  // single-tenant component today, so this is accepted; it is the reason the
  // classes a runner *asserts* (`runnerClass`) are still ignored here, and it
  // is what would have to change first if runners were ever hosted apart from
  // the control plane.
  if (envelope.phase !== "EXECUTE") return true;
  if (failureClass === FailureClass.BINARY_NOT_FOUND) return true;
  if (failureClass === FailureClass.AUTH_REQUIRED) return true;
  // A signal nobody in the session asked for: budget kills carry a
  // terminationReason and land as CANCELLED_OR_TIMED_OUT, so anything else was
  // shot from outside.
  if (envelope.signal && failureClass !== FailureClass.CANCELLED_OR_TIMED_OUT) return true;
  return false;
};

export type EnvelopeVerdict = {
  failureClass: FailureClass;
  retryable: boolean;
  /** The environment failed, not the agent: the attempt must not spend budget. */
  externalFailure: boolean;
};

export const classifyEnvelope = (envelope: FailureEnvelope): EnvelopeVerdict => {
  const failureClass = envelopeFailureClass(envelope);
  return {
    failureClass,
    // Derived, never taken from the runner: this is the whitelist finally doing
    // its job.
    retryable: dependencyProvisioningManifestMissing(envelope) ? false : failureIsRetryable(failureClass),
    externalFailure: envelopeExternalFailure(envelope, failureClass),
  };
};
