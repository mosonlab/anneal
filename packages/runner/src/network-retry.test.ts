import assert from "node:assert/strict";
import test from "node:test";

import { CommandTimeoutError, KILL_OVERHEAD_MS } from "./exec.js";
import {
  CLONE_COMMAND_TIMEOUT_MS, CLONE_OPERATION_BUDGET_MS, deliveryDeadline, MIN_ATTEMPT_TIMEOUT_MS,
  NETWORK_COMMAND_TIMEOUT_MS, NETWORK_OPERATION_BUDGET_MS, runWithNetworkRetry,
} from "./network-retry.js";

test("git fetch uses the shared transient retry policy", async () => {
  let calls = 0;
  const result = await runWithNetworkRetry("git", ["fetch", "origin"], async () => {
    calls += 1;
    if (calls < 3) throw new Error("fatal: connection reset by peer (ECONNRESET)");
    return "fetched";
  }, { wait: async () => undefined });
  assert.equal(result, "fetched");
  assert.equal(calls, 3);
});

test("the retry budget survives a multi-second outage and stays bounded", async () => {
  // Runs 1 and 3 of 2026-08-17 died in 0.93s and 0.51s because the old budget
  // (3 attempts, ~750ms total) fit inside a single connectivity drop. The
  // waits recorded here must ride out a seconds-scale outage while the
  // worst-case total wait (~23s) stays inside the 60s run lease.
  const waits: number[] = [];
  let calls = 0;
  await assert.rejects(runWithNetworkRetry("git", ["clone"], async () => {
    calls += 1;
    throw new Error("LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443");
  }, { wait: async (attempt) => { waits.push(attempt); } }));
  assert.equal(calls, 6);
  assert.equal(waits.length, 5);
});

test("connection lost is classified transient", async () => {
  let calls = 0;
  const result = await runWithNetworkRetry("git", ["push"], async () => {
    calls += 1;
    if (calls < 2) throw new Error("API Error: Connection lost mid-response. The response above may be incomplete.");
    return "pushed";
  }, { wait: async () => undefined });
  assert.equal(result, "pushed");
  assert.equal(calls, 2);
});

test("git push retries an unknown transport failure until its existing budget is exhausted", async () => {
  let calls = 0;
  await assert.rejects(runWithNetworkRetry("git", ["push"], async () => {
    calls += 1;
    throw new Error("fatal: unable to access remote: gnutls_handshake() failed");
  }, { wait: async () => undefined }));
  assert.equal(calls, 6);
});

test("git push does not retry a deterministic access refusal", async () => {
  let calls = 0;
  await assert.rejects(runWithNetworkRetry("git", ["push"], async () => {
    calls += 1;
    throw new Error("fatal: unable to access remote: requested URL returned error: 403");
  }, { wait: async () => undefined }));
  assert.equal(calls, 1);
});

test("git push vetoes the common access refusal vocabulary", async () => {
  for (const message of [
    "Permission denied (publickey).",
    "authentication failed",
    "authorization failed",
    "unauthorized",
    "invalid credentials",
    "remote: HTTP 403 Forbidden",
    "remote: could not read Username for 'https://github.com': terminal prompts disabled",
    "fatal: requested URL returned error: 401",
  ]) {
    let calls = 0;
    await assert.rejects(runWithNetworkRetry("git", ["push"], async () => {
      calls += 1;
      throw new Error(message);
    }, { wait: async () => undefined }));
    assert.equal(calls, 1, message);
  }
});

test("commands outside the delivery network allowlist are never retried", async () => {
  let calls = 0;
  await assert.rejects(runWithNetworkRetry("git", ["commit"], async () => {
    calls += 1;
    throw new Error("ECONNRESET in a hook");
  }, { wait: async () => undefined }));
  assert.equal(calls, 1);
});

test("a hung network command burns its timeout, retries once, and stops inside the lease", async () => {
  // The scenario PR #109 could not cover: a clone that neither fails nor
  // returns. Without a per-command ceiling the first attempt alone runs until
  // reconciliation calls the run LOST; with one, the loop must fit the whole
  // operation — timeouts, kill escalation and backoff — inside 45s.
  let clock = 0;
  const timeouts: Array<number | undefined> = [];
  await assert.rejects(runWithNetworkRetry("git", ["clone"], async ({ timeoutMs }) => {
    timeouts.push(timeoutMs);
    clock += (timeoutMs ?? 0) + KILL_OVERHEAD_MS;
    throw new CommandTimeoutError("git", ["clone"], timeoutMs ?? 0);
  }, {
    now: () => clock,
    wait: async (attempt) => { clock += Math.min(8_000, 1_000 * 2 ** (attempt - 1)); },
  }), /timed out after/);
  assert.deepEqual(timeouts, [NETWORK_COMMAND_TIMEOUT_MS, 16_000]);
  assert.ok(clock <= NETWORK_OPERATION_BUDGET_MS, `operation overran its budget: ${clock}ms`);
});

test("every attempt of a network command carries a ceiling, and local commands carry none", async () => {
  const network: Array<number | undefined> = [];
  await runWithNetworkRetry("git", ["push"], async ({ timeoutMs }) => { network.push(timeoutMs); return ""; });
  assert.deepEqual(network, [NETWORK_COMMAND_TIMEOUT_MS]);

  // A `git commit` of a huge tree is slow, not hung; a ceiling here would turn
  // a working run into a failed one.
  const local: Array<number | undefined> = [];
  await runWithNetworkRetry("git", ["commit"], async ({ timeoutMs }) => { local.push(timeoutMs); return ""; });
  assert.deepEqual(local, [undefined]);
});

test("a nested retried call inherits its caller's deadline instead of opening a second budget", async () => {
  let clock = 0;
  const now = (): number => clock;
  const inheritedDeadline = await runWithNetworkRetry("git", ["push"], async (budget) => {
    clock += 30_000;
    return runWithNetworkRetry("gh", ["pr", "list"], async (nested) => nested.deadline, {
      now,
      ...(budget.deadline === undefined ? {} : { deadline: budget.deadline }),
    });
  }, { now });
  // A fresh budget would have been 30_000 + 45_000; the probe must not be able
  // to spend time its caller already promised to the lease.
  assert.equal(inheritedDeadline, NETWORK_OPERATION_BUDGET_MS);
});

test("a creating GitHub write is not on the retry allowlist, so this loop cannot resend one", async () => {
  // #139. Retrying on an error alone cannot tell a lost response from a failed
  // request, and for `gh pr create` that difference is a second pull request.
  // Creation goes through confirmedWrite instead, which resends only after a
  // read-back has positively found nothing — so it must not ALSO be retryable
  // here, or a future caller gets the blind loop back for free.
  let sends = 0;
  await assert.rejects(runWithNetworkRetry("gh", ["pr", "create"], async () => {
    sends += 1;
    throw new Error("Post https://api.github.com/graphql: unexpected EOF");
  }, { wait: async () => undefined }));
  assert.equal(sends, 1);
});

test("the clone profile trades a longer ceiling for a longer budget and still terminates", async () => {
  // Provisioning heartbeats keep the lease alive, so the clone ceiling only has
  // to tell "hung" from "slow"; what it must still guarantee is that a hung
  // clone ends, because nothing else bounds provisioning.
  let clock = 0;
  const timeouts: Array<number | undefined> = [];
  await assert.rejects(runWithNetworkRetry("git", ["clone"], async ({ timeoutMs }) => {
    timeouts.push(timeoutMs);
    clock += (timeoutMs ?? 0) + KILL_OVERHEAD_MS;
    throw new CommandTimeoutError("git", ["clone"], timeoutMs ?? 0);
  }, {
    now: () => clock,
    wait: async (attempt) => { clock += Math.min(8_000, 1_000 * 2 ** (attempt - 1)); },
    commandTimeoutMs: CLONE_COMMAND_TIMEOUT_MS,
    budgetMs: CLONE_OPERATION_BUDGET_MS,
  }), /timed out after/);
  assert.deepEqual(timeouts, [CLONE_COMMAND_TIMEOUT_MS, CLONE_COMMAND_TIMEOUT_MS, 45_000]);
  assert.ok(clock <= CLONE_OPERATION_BUDGET_MS, `clone overran its budget: ${clock}ms`);
});

test("an attempt is refused once the shared deadline has passed", async () => {
  // Without this guard the 5s floor compounds: every nested or subsequent
  // operation gets one more floored attempt past the deadline, and a delivery
  // that already spent its budget keeps spending it.
  let clock = 50_000;
  let calls = 0;
  await assert.rejects(runWithNetworkRetry("gh", ["pr", "list"], async () => {
    calls += 1;
    return "[]";
  }, { now: () => clock, deadline: deliveryDeadline(0, 60, 0) }), /budget exhausted/);
  assert.equal(calls, 0, "a command must not be spawned after the phase deadline");
  assert.equal(clock, 50_000);
});

test("sequential operations share one delivery deadline instead of each taking a fresh budget", async () => {
  let clock = 0;
  const options = { now: () => clock, deadline: deliveryDeadline(0, 60, 0), wait: async () => { clock += 1_000; } };
  // Each operation succeeds, but only after burning the whole ceiling it was
  // handed — the shape of a slow push followed by slow gh calls.
  const spend = async (): Promise<void> => {
    await runWithNetworkRetry("git", ["push"], async ({ timeoutMs }) => { clock += timeoutMs ?? 0; return ""; }, options);
  };
  await spend();
  await spend();
  await spend();
  // Three independent budgets would have reached 60s of commands here. One
  // shared budget can overrun only by the single documented floored attempt.
  const budget = deliveryDeadline(0, 60, 0);
  assert.ok(clock <= budget + MIN_ATTEMPT_TIMEOUT_MS + KILL_OVERHEAD_MS, `sequential operations overran the phase budget: ${clock}ms`);
  assert.ok(clock < 60_000, `sequential operations outlived the lease: ${clock}ms`);
});

test("git push retries transport failures accompanied by credential helper warnings", async () => {
  let calls = 0;
  await assert.rejects(runWithNetworkRetry("git", ["push"], async () => {
    calls += 1;
    throw new Error("gnutls_handshake() failed; git: 'credential-osxkeychain' is not a git command.");
  }, { wait: async () => undefined }));
  assert.equal(calls, 6);
});
