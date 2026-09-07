import assert from "node:assert/strict";
import test from "node:test";

import { FAILURE_ENVELOPE_VERSION, FailureClass, type FailureEnvelope } from "@anneal/db";

import { classifyEnvelope, failureIsRetryable, isTextMatchedTransientProviderFailure } from "./execution.js";

const envelope = (overrides: Partial<FailureEnvelope> = {}): FailureEnvelope => ({
  version: FAILURE_ENVELOPE_VERSION,
  phase: "EXECUTE",
  runnerClass: null,
  exitCode: 1,
  signal: null,
  terminationReason: null,
  terminalEventSeen: true,
  terminalSuccess: false,
  agentExited: true,
  providerError: null,
  stderrSummary: null,
  stdoutSummary: null,
  timedOut: false,
  transient: false,
  timeoutMs: null,
  ...overrides,
});

test("the agent's own stdout is never a verdict, whatever the runner guessed", () => {
  // The shape of the 2026-08-17 misclassification: a task *about* rate limiting
  // fails, its stdout is full of the phrase, and the old runner-side grep read
  // stdout. Nothing on a verdict channel says anything happened to the
  // environment, so this is an ordinary failed attempt.
  const verdict = classifyEnvelope(envelope({
    runnerClass: FailureClass.RATE_LIMITED,
    stdoutSummary: "implemented the 429 rate limit backoff; quota headers parsed",
  }));
  assert.equal(verdict.failureClass, FailureClass.TASK_FAILED);
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.externalFailure, false);
});

test("delivery preserves the runner's no-changes-produced verdict", () => {
  const verdict = classifyEnvelope(envelope({
    phase: "DELIVER",
    runnerClass: FailureClass.NO_CHANGES_PRODUCED,
    exitCode: 0,
    terminalSuccess: true,
    stderrSummary: "no-changes-produced: the session ended cleanly without committing any change on feature/test",
  }));
  assert.equal(verdict.failureClass, FailureClass.NO_CHANGES_PRODUCED);
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.externalFailure, false);
});

test("the same wording on stderr is a verdict", () => {
  const verdict = classifyEnvelope(envelope({ stderrSummary: "HTTP 429: rate limit exceeded" }));
  assert.equal(verdict.failureClass, FailureClass.RATE_LIMITED);
  assert.equal(verdict.retryable, true);
});

test("auth in the agent's output is content; auth on the provider error is a verdict", () => {
  const content = classifyEnvelope(envelope({ stdoutSummary: "returns 401 when the caller is not logged in" }));
  assert.equal(content.failureClass, FailureClass.TASK_FAILED);
  assert.equal(content.externalFailure, false, "an ordinary failed attempt must spend the attempt");

  const real = classifyEnvelope(envelope({ providerError: "authentication_failed" }));
  assert.equal(real.failureClass, FailureClass.AUTH_REQUIRED);
  assert.equal(real.retryable, false);
  assert.equal(real.externalFailure, true, "the operator has to fix this; the task must not pay for it");
});

test("auth outranks transience so a lockout is not retried into", () => {
  const verdict = classifyEnvelope(envelope({ providerError: "connection lost after authentication_failed" }));
  assert.equal(verdict.failureClass, FailureClass.AUTH_REQUIRED);
  assert.equal(verdict.retryable, false);
});

test("a clean EXECUTE exit after a provider fetch failure is refunded", () => {
  const verdict = classifyEnvelope(envelope({
    exitCode: 0,
    stderrSummary: "fetch failed",
  }));
  assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER);
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.externalFailure, true);
});

test("typed EXECUTE transience alone does not become a textual refund", () => {
  const evidence = envelope({ transient: true, stderrSummary: "runner network marker" });
  const verdict = classifyEnvelope(evidence);
  assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER);
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.externalFailure, false);
  assert.equal(isTextMatchedTransientProviderFailure(evidence, verdict.failureClass), false);
});

test("the CLI auth vocabulary remains available throughout plumbing phases", () => {
  const formerCliRefusals = [
    "authentication_failed",
    "401: authentication is required",
    "Missing authentication for the provider",
    "No API key found for the provider",
    "the provider CLI is not logged in",
    "not-authenticated: the CLI's own login check did not pass (exit 2)",
  ];
  for (const phase of ["PROVISION", "COMPLETE"] as const) {
    for (const providerError of formerCliRefusals) {
      const verdict = classifyEnvelope(envelope({ phase, providerError }));
      assert.equal(verdict.failureClass, FailureClass.AUTH_REQUIRED, `${phase}: ${providerError}`);
      assert.equal(verdict.retryable, false, `${phase}: ${providerError}`);
      assert.equal(verdict.externalFailure, true, `${phase}: ${providerError}`);
    }
  }

  const executeVerdict = classifyEnvelope(envelope({
    providerError: "not-authenticated: the CLI's own login check did not pass (exit 2)",
  }));
  assert.equal(executeVerdict.failureClass, FailureClass.AUTH_REQUIRED);
  assert.equal(executeVerdict.retryable, false);
});

test("gh's GraphQL transport EOF is retryable delivery transience", () => {
  const verdict = classifyEnvelope(envelope({
    phase: "DELIVER",
    providerError: 'gh failed (1): Post "https://api.github.com/graphql": EOF',
  }));
  assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER);
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.externalFailure, true);
});

test("an unknown transport error in a plumbing phase is transient", () => {
  const verdict = classifyEnvelope(envelope({
    phase: "DELIVER",
    terminalSuccess: true,
    stderrSummary: "git failed (128): gnutls_handshake() failed: The TLS connection was non-properly terminated.",
  }));
  assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER);
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.externalFailure, true);
});

test("an authentication refusal in a plumbing phase is final", () => {
  const verdict = classifyEnvelope(envelope({
    phase: "DELIVER",
    terminalSuccess: true,
    stderrSummary: "remote: authentication failed while pushing the branch",
  }));
  assert.equal(verdict.failureClass, FailureClass.AUTH_REQUIRED);
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.externalFailure, true);
});

test("provider overload wording is retryable transience", () => {
  const verdict = classifyEnvelope(envelope({
    providerError: "Our servers are currently overloaded. Please try again later.",
  }));
  assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER);
  assert.equal(verdict.retryable, true);
});

test("provider 5xx errors remain retryable without matching stack-trace locations", () => {
  for (const providerError of [
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
    'API Error: 500 {"type":"error","error":{"type":"api_error"}}',
  ]) {
    const verdict = classifyEnvelope(envelope({ providerError }));
    assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER);
    assert.equal(failureIsRetryable(verdict.failureClass), true);
  }
});

test("a generic retry prompt on agent stderr does not earn a refund", () => {
  const verdict = classifyEnvelope(envelope({ stderrSummary: "please try again later" }));
  assert.equal(verdict.failureClass, FailureClass.TASK_FAILED);
  assert.equal(verdict.externalFailure, false);
});

test("an unrelated stack-trace line is not a provider outage", () => {
  const verdict = classifyEnvelope(envelope({ stderrSummary: "node:events:526:24" }));
  assert.equal(verdict.failureClass, FailureClass.TASK_FAILED);
  assert.equal(verdict.retryable, false);
});

test("a typed command timeout outranks the text around it", () => {
  const verdict = classifyEnvelope(envelope({
    phase: "DELIVER",
    timedOut: true,
    timeoutMs: 20_000,
    stderrSummary: "git push timed out after 20000ms; its process group was killed",
  }));
  assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER);
  assert.equal(verdict.retryable, true);
});

test("git's auth vocabulary is read in the delivery phase, the CLI's in execution", () => {
  const push = envelope({ phase: "DELIVER", stderrSummary: "remote: Permission denied to repo (403)" });
  assert.equal(classifyEnvelope(push).failureClass, FailureClass.AUTH_REQUIRED);
  // "permission denied" out of an agent CLI is a filesystem error, not a
  // credential one, and must not be reported to an operator as "go log in".
  const agent = envelope({ phase: "EXECUTE", stderrSummary: "open /etc/hosts: permission denied" });
  assert.equal(classifyEnvelope(agent).failureClass, FailureClass.TASK_FAILED);
});

test("BUDGET_EXCEEDED can never buy the ceiling it just hit", () => {
  const verdict = classifyEnvelope(envelope({
    phase: "PROVISION",
    agentExited: false,
    runnerClass: FailureClass.BUDGET_EXCEEDED,
    exitCode: null,
    terminationReason: "max-runs budget exceeded",
  }));
  assert.equal(verdict.failureClass, FailureClass.BUDGET_EXCEEDED);
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.externalFailure, false, "raising the ceiling for exceeding it is an unbounded loop");
});

test("a killed-by-budget run stays BUDGET_EXCEEDED despite the signal", () => {
  const verdict = classifyEnvelope(envelope({
    runnerClass: FailureClass.BUDGET_EXCEEDED,
    signal: "SIGKILL",
    terminationReason: "walltime: exceeded 120 minutes",
  }));
  assert.equal(verdict.failureClass, FailureClass.BUDGET_EXCEEDED);
  // Raising the ceiling for exceeding the ceiling is an unbounded loop.
  assert.equal(verdict.externalFailure, false);
});

test("a failure outside the agent's own phase does not spend the task's budget", () => {
  const delivery = classifyEnvelope(envelope({ phase: "DELIVER", exitCode: 0, terminalSuccess: true, stderrSummary: "fatal: unable to access remote" }));
  assert.equal(delivery.externalFailure, true, "the agent finished; the push is the runner's plumbing");
  const provisioning = classifyEnvelope(envelope({ phase: "PROVISION", agentExited: false, exitCode: 127 }));
  assert.equal(provisioning.failureClass, FailureClass.BINARY_NOT_FOUND);
  assert.equal(provisioning.retryable, false);
  assert.equal(provisioning.externalFailure, true);
});

test("a missing provisioning binary is deterministic even without an agent exit", () => {
  const verdict = classifyEnvelope(envelope({
    phase: "PROVISION",
    agentExited: false,
    exitCode: 127,
    terminationReason: "runner exception",
    stderrSummary: "spawn git: no such file or directory",
  }));
  assert.equal(verdict.failureClass, FailureClass.BINARY_NOT_FOUND);
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.externalFailure, true);
});

test("an unknown completion-phase runner exception is transient", () => {
  const verdict = classifyEnvelope(envelope({
    phase: "COMPLETE",
    agentExited: false,
    exitCode: 1,
    terminationReason: "runner exception",
    stderrSummary: "completion connection failed in an unknown provider adapter",
  }));
  assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER);
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.externalFailure, true);
});

test("access refusals in every plumbing phase are final", () => {
  for (const phase of ["PROVISION", "COMPLETE"] as const) {
    const verdict = classifyEnvelope(envelope({
      phase,
      agentExited: false,
      stderrSummary: "remote returned 403",
    }));
    assert.equal(verdict.failureClass, FailureClass.AUTH_REQUIRED, phase);
    assert.equal(verdict.retryable, false, phase);
  }
});

test("an exception in runner code is never charged to the agent", () => {
  // agentExited is false even though the phase says EXECUTE: control reached
  // the completion through the runner's own catch, so the agent never got to
  // report a verdict of its own.
  const verdict = classifyEnvelope(envelope({ phase: "EXECUTE", agentExited: false, terminationReason: "runner exception" }));
  assert.equal(verdict.externalFailure, true);
  // This used to answer CANCELLED_OR_TIMED_OUT, from `terminationReason` alone.
  // The runner stamps `"runner exception"` on *every* escaped error, so that
  // rule read the runner's own crash as a deliberately cancelled session and
  // made the whole class of them unretryable — which is how a lost TLS
  // connection during clone came to be refunded and then parked in REVIEW for a
  // human. A termination reason now only means what it says when there was a
  // session to terminate.
  assert.equal(verdict.failureClass, FailureClass.TASK_FAILED, "no session was cancelled; nothing here says transience either");
  assert.equal(verdict.retryable, false);
});

test("a plumbing-phase clone failure is retried unless it is a deterministic refusal", () => {
  // Both come out of `runner.ts`'s catch-all, so both carry the same
  // `"runner exception"`; the runner's typed network predicate is the only
  // thing that differs. `packages/runner/src/provision-failure.test.ts` proves
  // these two shapes are what a real `executeClaim` produces.
  const lostTls = classifyEnvelope(envelope({
    phase: "PROVISION", agentExited: false, terminationReason: "runner exception", exitCode: 1, transient: true,
    stderrSummary: "git failed (128): fatal: unable to access 'https://example.test/repo.git/': LibreSSL SSL_connect: SSL_ERROR_SYSCALL",
  }));
  assert.equal(lostTls.failureClass, FailureClass.TRANSIENT_PROVIDER);
  assert.equal(lostTls.retryable, true, "the whole point of #113: this attempt is retried, not parked");
  assert.equal(lostTls.externalFailure, true);

  const missingRepo = classifyEnvelope(envelope({
    phase: "PROVISION", agentExited: false, terminationReason: "runner exception", exitCode: 1,
    stderrSummary: "git failed (128): fatal: repository '/nonexistent/repo.git' does not exist",
  }));
  // Unknown repository/toolchain wording is deliberately not a second veto
  // list, so an environment repair can be tried without spending this attempt.
  assert.equal(missingRepo.externalFailure, true);
  assert.equal(missingRepo.failureClass, FailureClass.TRANSIENT_PROVIDER);
  assert.equal(missingRepo.retryable, true);
});

test("a budget kill still reads as a cancelled session, because there was one", () => {
  // The rule the guard above must not have broken: a walltime or stall kill
  // comes through the normal completion path with `agentExited: true`.
  const verdict = classifyEnvelope(envelope({
    phase: "EXECUTE", agentExited: true, terminationReason: "walltime: exceeded 120 minutes", signal: "SIGTERM",
  }));
  assert.equal(verdict.failureClass, FailureClass.CANCELLED_OR_TIMED_OUT);
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.externalFailure, false, "a kill the session's own budget ordered is not an external failure");
});

test("a clean exit without a terminal event is protocol drift, and retryable", () => {
  const verdict = classifyEnvelope(envelope({ exitCode: 0, terminalEventSeen: false, terminalSuccess: false }));
  assert.equal(verdict.failureClass, FailureClass.PROTOCOL_ERROR);
  assert.equal(verdict.retryable, true);
});

test("a missing NPM_CI manifest is a named non-retryable provisioning protocol error", () => {
  const verdict = classifyEnvelope(envelope({
    phase: "PROVISION",
    runnerClass: FailureClass.PROTOCOL_ERROR,
    exitCode: 1,
    terminationReason: "runner exception",
    terminalEventSeen: false,
    agentExited: false,
    stderrSummary: "dependency-provisioning-manifest-missing",
  }));
  assert.equal(verdict.failureClass, FailureClass.PROTOCOL_ERROR);
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.externalFailure, true);
});

test("a tool failure may be read off stdout because it can change no decision", () => {
  const verdict = classifyEnvelope(envelope({ stdoutSummary: '{"type":"result","isError": true}' }));
  assert.equal(verdict.failureClass, FailureClass.TOOL_FAILED);
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.externalFailure, false);
});

test("every class the API can reach agrees with the retry whitelist", () => {
  // The whitelist stopped being reachable once the route preferred the runner's
  // `retryable`; classifyEnvelope is what makes it authoritative again.
  for (const stored of [
    envelope({ stderrSummary: "HTTP 429" }),
    envelope({ providerError: "server_error" }),
    envelope({ exitCode: 0, terminalEventSeen: false }),
    envelope({ stdoutSummary: "nothing interesting" }),
    envelope({ providerError: "authentication_failed" }),
  ]) {
    const verdict = classifyEnvelope(stored);
    assert.equal(verdict.retryable, failureIsRetryable(verdict.failureClass));
  }
});

/**
 * Copied verbatim from the `"a hung push arrives at the API as a typed timeout"`
 * test in packages/runner/src/delivery.test.ts, which asserts this exact object
 * as the output of a real `deliverWorkspace` hitting a real per-command
 * timeout. If that test's literal changes, change this one — the pair is the
 * only thing that ties the two halves of the chain together across a package
 * boundary the runner deliberately does not cross.
 */
const HUNG_PUSH_ENVELOPE: FailureEnvelope = {
  version: 1,
  phase: "DELIVER",
  runnerClass: FailureClass.TOOL_FAILED,
  exitCode: 0,
  signal: null,
  terminationReason: null,
  terminalEventSeen: true,
  terminalSuccess: true,
  agentExited: true,
  providerError: null,
  stderrSummary: "git push timed out after 6000ms; its process group was killed",
  stdoutSummary: null,
  timedOut: true,
  transient: true,
  timeoutMs: 6000,
};

test("the envelope a real hung push produces is classified as retryable transience", () => {
  const verdict = classifyEnvelope(HUNG_PUSH_ENVELOPE);
  // Before delivery kept its failure structured, this arrived with the agent's
  // channels and no typed markers, and came out TASK_FAILED / non-retryable —
  // #124's CommandTimeoutError existed but never reached the decision.
  assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER);
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.externalFailure, true, "the agent finished; a hung push is not its fault");
  // The runner's own guess was TOOL_FAILED, which is neither.
  assert.notEqual(verdict.failureClass, HUNG_PUSH_ENVELOPE.runnerClass);
});

/**
 * Every phrase `packages/runner/src/network-retry.ts` treats as transient, and
 * every phrase it vetoes. This list is the contract between the two files:
 * `adapters.ts classifyError` reached that predicate through
 * `isTransientNetworkError`, so relocating the authority here without the
 * vocabulary would have quietly made these failures final.
 */
const TRANSIENT_PHRASES = [
  "fetch failed",
  "SSL_ERROR_SYSCALL: connection failed",
  "fatal: the remote end hung up unexpectedly: unexpected EOF",
  "connection reset by peer",
  "connection closed by remote host",
  "connection timed out",
  "read ECONNRESET",
  "connect ETIMEDOUT 140.82.121.4:443",
  "getaddrinfo EAI_AGAIN github.com",
  "HTTP 503 from the provider",
  "status code 502",
  "502 Bad Gateway",
  "503 Service Unavailable",
  "504 Gateway Timeout",
];

for (const phrase of TRANSIENT_PHRASES) {
  test(`stderr saying "${phrase}" stays retryable transience`, () => {
    const verdict = classifyEnvelope(envelope({ stderrSummary: phrase }));
    assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER);
    assert.equal(verdict.retryable, true);
  });
}

/**
 * The veto half. These are deterministic access failures; a message that also
 * mentions a dropped connection must not be retried into a lockout. Each is
 * paired with the class it must land on instead. Plumbing access refusals are
 * final even when their wording also contains a transport symptom.
 */
const VETOED_PHRASES: Array<{ phrase: string; phase: FailureEnvelope["phase"]; expected: FailureClass }> = [
  { phrase: "remote: Authentication failed; connection reset by peer", phase: "DELIVER", expected: FailureClass.AUTH_REQUIRED },
  { phrase: "could not read Username for 'https://github.com': connection timed out", phase: "DELIVER", expected: FailureClass.AUTH_REQUIRED },
  { phrase: "remote: Permission denied; ECONNRESET", phase: "DELIVER", expected: FailureClass.AUTH_REQUIRED },
  { phrase: "403 Forbidden after ECONNRESET", phase: "DELIVER", expected: FailureClass.AUTH_REQUIRED },
  { phrase: "Bad credentials; connection closed", phase: "EXECUTE", expected: FailureClass.TASK_FAILED },
  { phrase: "HTTP 401 then ETIMEDOUT", phase: "EXECUTE", expected: FailureClass.AUTH_REQUIRED },
];

for (const { phrase, phase, expected } of VETOED_PHRASES) {
  test(`"${phrase}" is never retried as transience`, () => {
    const verdict = classifyEnvelope(envelope({ phase, stderrSummary: phrase, agentExited: phase === "EXECUTE" }));
    assert.equal(verdict.failureClass, expected);
    assert.equal(verdict.retryable, false);
  });
}

test("the one transient semantic deliberately dropped is stdout", () => {
  // The runner fed `stderr + stdout` to the same predicate. An agent writing a
  // network retry loop has every one of these tokens in its output, and that
  // is the misclassification this ticket exists to end — so the vocabulary
  // moved and the channel did not.
  for (const phrase of TRANSIENT_PHRASES) {
    const verdict = classifyEnvelope(envelope({ stdoutSummary: phrase }));
    assert.equal(verdict.failureClass, FailureClass.TASK_FAILED, `stdout "${phrase}" must not be a verdict`);
    assert.equal(verdict.retryable, false);
  }
});

test("a dropped connection outranks a rate limit named in the same provider error", () => {
  // adapters.ts checked this pair before the rate-limit rule, and the order
  // matters: a rate-limit verdict backs off for the rate-limit interval.
  const verdict = classifyEnvelope(envelope({ providerError: "connection lost while reporting 429 rate limit" }));
  assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER);
});

test("a model capacity refusal is external transience, not a spent attempt", () => {
  // 2026-09-05: two Apply-review-fixes runs died on Codex's capacity refusal,
  // were classified TASK_FAILED, and each charged the task an attempt for a
  // condition no prompt of theirs could have avoided.
  for (const providerError of [
    "Selected model is at capacity. Please try a different model.",
    "This model is currently at capacity. Please try again.",
  ]) {
    const evidence = envelope({ providerError });
    const verdict = classifyEnvelope(evidence);
    assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER);
    assert.equal(verdict.retryable, true);
    assert.equal(verdict.externalFailure, true, "the refund must apply in EXECUTE");
    assert.equal(isTextMatchedTransientProviderFailure(evidence, verdict.failureClass), true);
  }
});

test("a capacity refusal quoted in the agent's own stdout is not a verdict", () => {
  const evidence = envelope({
    stdoutSummary: "documented the retry: \"Selected model is at capacity. Please try a different model.\"",
  });
  const verdict = classifyEnvelope(evidence);
  assert.equal(verdict.failureClass, FailureClass.TASK_FAILED);
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.externalFailure, false);
});

test("unrelated capacity verdict text is an ordinary task failure", () => {
  for (const text of ["disk is at capacity", "the connection pool is at capacity; aborting"]) {
    for (const evidence of [envelope({ providerError: text }), envelope({ stderrSummary: text })]) {
      const verdict = classifyEnvelope(evidence);
      assert.equal(verdict.failureClass, FailureClass.TASK_FAILED);
      assert.equal(verdict.retryable, false);
      assert.equal(verdict.externalFailure, false);
    }
  }
});

test("credential helper warnings do not veto plumbing transport retries", () => {
  for (const phase of ["PROVISION", "DELIVER", "COMPLETE"] as const) {
    const verdict = classifyEnvelope(envelope({
      phase,
      stderrSummary: "git failed (128): gnutls_handshake() failed; git: 'credential-osxkeychain' is not a git command.",
    }));
    assert.equal(verdict.failureClass, FailureClass.TRANSIENT_PROVIDER, phase);
    assert.equal(verdict.retryable, true, phase);
    assert.equal(verdict.externalFailure, true, phase);
  }
});
