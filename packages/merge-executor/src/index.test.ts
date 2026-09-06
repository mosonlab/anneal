import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { RunOutcome } from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION, type MechanicalClaim } from "@anneal/db/claim-contract";

import { makeAgentOsClient } from "./agentos.js";
import type { ExecutorConfig } from "./config.js";
import { mintInstallationToken } from "./github-app-auth.js";
import { claimOnce, pollClaims, runClaim, type ClaimOnceResult } from "./index.js";
import { makeLog, makeRedactor } from "./redaction.js";

const config: ExecutorConfig = {
  apiUrl: "https://agentos.test",
  executorToken: "executor-control-plane-token",
  runnerId: "merge-executor-1",
  leaseSeconds: 120,
  pollIntervalMs: 5_000,
  contractRecheckMs: 60_000,
  apiTimeoutMs: 1_000,
  githubRestUrl: "https://api.github.test",
  githubGraphqlUrl: "https://api.github.test/graphql",
  githubTimeoutMs: 1_000,
  githubAppAuthTimeoutMs: 1_000,
  githubAppId: "12345",
  githubAppInstallationId: "67890",
  mergeIdentityLogin: "agentos-merge[bot]",
  mergeabilityPollAttempts: 1,
  mergeabilityPollMs: 1,
  mergeabilityPollBudgetMs: 10,
};

const claimed = (id: string): MechanicalClaim => ({
  executionMode: "mechanical",
  task: { chainIndex: 7 },
  run: { id },
  fencingToken: `fence-${id}`,
  sessionToken: `session-token-${id}`,
});

const log = makeLog(makeRedactor(), { log: () => {}, warn: () => {}, error: () => {} });

const compatibleAgentOsResponse = (input: string | URL | Request): Response =>
  String(input).endsWith("/heartbeat")
    ? new Response(JSON.stringify({ ok: true, cancellation: null, mechanicalCancellationPolicy: "refused" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    : new Response(null, { status: 204 });

test("an idle claim poll never enters the run-scoped mint path", async () => {
  let runCalls = 0;
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 204 });
  const result = await claimOnce(config, "/private/app.pem", log, fetchImpl, async () => { runCalls += 1; });
  assert.deepEqual(result, { kind: "idle" });
  assert.equal(runCalls, 0);
});

test("a completion-contract mismatch is reported to the caller with both versions and no retry", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const errors: string[] = [];
  const capturedLog = makeLog(makeRedactor(), {
    log: () => {},
    warn: () => {},
    error: (line: string) => errors.push(line),
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({
      error: `Mechanical completion contract mismatch: executor version ${RUN_COMPLETION_CONTRACT_VERSION - 1}; API version ${RUN_COMPLETION_CONTRACT_VERSION}`,
      code: "mechanical_contract_mismatch",
      expectedVersion: RUN_COMPLETION_CONTRACT_VERSION,
      receivedVersion: RUN_COMPLETION_CONTRACT_VERSION - 1,
    }), { status: 409, headers: { "content-type": "application/json" } });
  };
  let runCalls = 0;

  const result = await claimOnce(config, "/private/app.pem", capturedLog, fetchImpl, async () => { runCalls += 1; });

  assert.deepEqual(result, {
    kind: "contract-mismatch",
    executorVersion: RUN_COMPLETION_CONTRACT_VERSION - 1,
    apiVersion: RUN_COMPLETION_CONTRACT_VERSION,
  });
  assert.equal(runCalls, 0);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0]!.body), {
    runnerId: "merge-executor-1",
    leaseSeconds: 120,
    contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
  });
  // The poll loop owns the mismatch log, because only it knows whether this is
  // a new state or the same incompatibility observed one recheck later.
  assert.equal(errors.length, 0);
});

test("a mismatched daemon rechecks on its own interval, logs each state change once, and runs until shutdown", async () => {
  // The daemon used to exit here (node exited 13 on the unsettled await), so
  // the service manager restarted it every ten seconds forever. It now stays
  // alive, re-claims on the recheck interval, and resumes by itself when the
  // API side adopts a compatible contract.
  const controller = new AbortController();
  const slept: number[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const capturedLog = makeLog(makeRedactor(), {
    log: (line: string) => infos.push(line),
    warn: () => {},
    error: (line: string) => errors.push(line),
  });
  const results: ClaimOnceResult[] = [
    { kind: "contract-mismatch", executorVersion: 1, apiVersion: 2 },
    { kind: "contract-mismatch", executorVersion: 1, apiVersion: 2 },
    { kind: "idle" },
  ];
  let claimCalls = 0;
  let settled = false;

  const polling = pollClaims({
    signal: controller.signal,
    pollIntervalMs: 5_000,
    contractRecheckMs: 60_000,
    log: capturedLog,
    claim: async () => {
      claimCalls += 1;
      return results[claimCalls - 1] ?? { kind: "idle" };
    },
    sleep: async (ms: number) => {
      slept.push(ms);
      // Shut down inside the sleep that follows the cleared claim, so the loop
      // is observed returning from a wait rather than from a claim.
      if (claimCalls === 3) controller.abort();
    },
  }).then(() => { settled = true; });

  await polling;

  assert.equal(settled, true);
  assert.equal(claimCalls, 3);
  assert.deepEqual(slept, [60_000, 60_000, 5_000]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /mechanical completion contract mismatch/u);
  assert.match(errors[0]!, /executorVersion.*1/u);
  assert.match(errors[0]!, /apiVersion.*2/u);
  assert.equal(infos.length, 1);
  assert.match(infos[0]!, /contract mismatch cleared/u);
});

test("shutdown interrupts a real pending contract recheck", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const polling = pollClaims({
    signal: controller.signal,
    pollIntervalMs: 5_000,
    contractRecheckMs: 60_000,
    log: makeLog(makeRedactor(), { log: () => {}, warn: () => {}, error: () => {} }),
    claim: async () => {
      setImmediate(() => controller.abort());
      return { kind: "contract-mismatch", executorVersion: 1, apiVersion: 2 };
    },
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      polling,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("shutdown did not interrupt the recheck")), 900);
      }),
    ]);
    assert.ok(performance.now() - started < 1_000);
  } finally {
    clearTimeout(deadline);
  }
});

test("a mismatched daemon process stays alive and still exits 0 on SIGTERM", async () => {
  // The regression this stands in front of is a *process* fact: awaiting an
  // abort listener alone left nothing keeping the event loop alive, so node
  // exited 13 within a second. Only a real child process can show the park.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "merge-executor-park-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const script = join(scratch, "park.mjs");
    // `BOOT` is written before the daemon's module graph is imported, so a
    // readiness failure says which half was slow: no `BOOT` is node + the tsx
    // loader still starting on the host, `BOOT` without `READY` is this
    // package's own import or claim loop.
    writeFileSync(script, `
process.stdout.write("BOOT\\n");
const { pollClaims } = await import(${JSON.stringify(pathToFileURL(join(here, "index.ts")).href)});
const { makeLog, makeRedactor } = await import(${JSON.stringify(pathToFileURL(join(here, "redaction.ts")).href)});

const shutdown = new AbortController();
process.on("SIGTERM", () => { shutdown.abort(); });
await pollClaims({
  signal: shutdown.signal,
  pollIntervalMs: 1000,
  contractRecheckMs: 50,
  // The immediate runs after pollClaims has installed the real recheck timer.
  log: makeLog(makeRedactor(), { log: () => {}, warn: () => {}, error: () => { setImmediate(() => process.stdout.write("READY\\n")); } }),
  claim: async () => ({ kind: "contract-mismatch", executorVersion: 1, apiVersion: 2 }),
});
`);
    child = spawn(
      process.execPath,
      ["--conditions=development", "--import", import.meta.resolve("tsx"), script],
      // TMPDIR is this test's own scratch directory so the child's startup does
      // not depend on the host's history. `tsx` keeps its transform cache under
      // `os.tmpdir()`, indexes that whole directory with a synchronous
      // `readdirSync` before it transforms anything, and then sweeps expired
      // entries; a host that has run gates for days accumulates them there,
      // because entries live about a week and every gate worktree path is a
      // fresh key. Measured at 60k entries that scan costs about 100ms, so it
      // is a contributor rather than a proven whole cause of the readiness
      // timeout seen on a gate worker — but a private cache is empty, and the
      // child's startup is then bounded by this repository alone.
      { cwd: scratch, env: { PATH: process.env.PATH ?? "", TMPDIR: scratch }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    const running = child;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      running.on("exit", (code, signal) => resolve({ code, signal }));
    });
    // Readiness is scaffolding, not the proof: it only says the child has
    // reached the parked state, and everything asserted below happens after it.
    // Reaching it is a cold node + tsx + import-graph start on whatever host
    // runs the gate, so the budget has to bound a genuine hang rather than a
    // slow machine. Spawning this child costs ~150ms on an idle host and
    // ~230ms at 3x CPU oversubscription, but the merge gate runs the unit lanes
    // alongside the database wave and its in-RAM PostgreSQL, where the cost is
    // paid in memory pressure rather than processor time; 10s lost that race on
    // a gate worker with an empty child stderr, i.e. a child that was still
    // starting. A minute is two orders of magnitude over the measured cost and
    // still fails a child that never parks.
    const readinessBudgetMs = 60_000;
    const spawnedAt = performance.now();
    let stdout = "";
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `child readiness timed out ${stdout.includes("BOOT\n") ? "while importing the daemon" : "before node reached the script"}`
        + ` after ${Math.round(performance.now() - spawnedAt)}ms;`
        + ` stdout was ${JSON.stringify(stdout)} and stderr was ${JSON.stringify(stderr)}`,
      )), readinessBudgetMs);
      running.stdout!.setEncoding("utf8");
      running.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("READY\n")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      running.once("error", (error) => { clearTimeout(timeout); reject(error); });
      running.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(`child exited before readiness: ${stderr}`));
      });
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 300); });
    assert.equal(child.exitCode, null, `child exited early: ${stderr}`);
    assert.equal(child.signalCode, null, `child was signaled early: ${stderr}`);

    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 0, signal: null }, `child stderr was ${JSON.stringify(stderr)}`);
  } finally {
    child?.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the mechanical start request matches the promptless API contract", async () => {
  let startBody: unknown;
  const fetchImpl: typeof fetch = async (_input, init) => {
    startBody = JSON.parse(String(init?.body));
    return new Response(null, { status: 204 });
  };
  await makeAgentOsClient(config, fetchImpl).start(claimed("contract-run"));
  assert.deepEqual(startBody, {
    runnerId: "merge-executor-1",
    fencingToken: "fence-contract-run",
    adapterVersion: "merge-executor-v1",
    cliVersion: "merge-executor-v1",
    workspacePath: null,
    manifest: { executionMode: "mechanical", childProcessCount: 0 },
  });
});

test("a persisted mechanical cancellation is acknowledged before GitHub authority is minted", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/heartbeat")) {
      return new Response(JSON.stringify({
        ok: false,
        cancellation: { requestId: "legacy-cancel", reason: "operator stop", requestedAt: new Date(0).toISOString() },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return compatibleAgentOsResponse(input);
  };
  let mintCalls = 0;
  let surfaceCalls = 0;
  let executeCalls = 0;
  await runClaim(config, "/private/app.pem", claimed("legacy-cancelled-run"), log, fetchImpl, {
    mintToken: async () => {
      mintCalls += 1;
      return { ok: false, failure: "private-key-read-failed" };
    },
    makeGitHub: (() => { surfaceCalls += 1; return {}; }) as never,
    executeDecision: (async () => { executeCalls += 1; return {}; }) as never,
  });
  assert.equal(mintCalls, 0);
  assert.equal(surfaceCalls, 0);
  assert.equal(executeCalls, 0);
  assert.deepEqual(requests, [
    "https://agentos.test/runner/runs/legacy-cancelled-run/start",
    "https://agentos.test/runner/runs/legacy-cancelled-run/heartbeat",
    "https://agentos.test/runner/runs/legacy-cancelled-run/cancel/acknowledge",
  ]);
});

test("a control plane without the mechanical-cancellation policy cannot reach GitHub", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return new Response(null, { status: 204 });
  };
  let mintCalls = 0;
  let surfaceCalls = 0;
  let executeCalls = 0;
  await runClaim(config, "/private/app.pem", claimed("old-control-plane"), log, fetchImpl, {
    mintToken: async () => {
      mintCalls += 1;
      return { ok: false, failure: "private-key-read-failed" };
    },
    makeGitHub: (() => { surfaceCalls += 1; return {}; }) as never,
    executeDecision: (async () => { executeCalls += 1; return {}; }) as never,
  });
  assert.equal(mintCalls, 0);
  assert.equal(surfaceCalls, 0);
  assert.equal(executeCalls, 0);
  assert.deepEqual(requests.map((request) => request.url), [
    "https://agentos.test/runner/runs/old-control-plane/start",
    "https://agentos.test/runner/runs/old-control-plane/heartbeat",
    "https://agentos.test/runner/runs/old-control-plane/complete",
  ]);
  assert.match(requests[2]!.body, /does not enforce mechanical cancellation refusal/u);
});

test("each claimed Run mints once, immediately before constructing its GitHub surface", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return compatibleAgentOsResponse(input);
  };
  let mintCalls = 0;
  let surfaceCalls = 0;
  for (const run of [claimed("run-1"), claimed("run-2")]) {
    let mintedForThisRun = false;
    await runClaim(config, "/private/app.pem", run, log, fetchImpl, {
      mintToken: async () => {
        mintCalls += 1;
        mintedForThisRun = true;
        return { ok: true, token: `installation_${"T".repeat(32)}`, expiresAt: new Date(Date.now() + 60 * 60_000) };
      },
      makeGitHub: ((options: { token: string }) => {
        assert.equal(mintedForThisRun, true);
        assert.match(options.token, /^installation_/u);
        surfaceCalls += 1;
        return {};
      }) as never,
      executeDecision: async () => ({ outcome: "stopped", condition: "unresolved-mergeability", evidence: "fixture" }),
    });
  }
  assert.equal(mintCalls, 2);
  assert.equal(surfaceCalls, 2);
  assert.equal(requests.filter((request) => request.url.endsWith("/start")).length, 2);
  assert.equal(requests.filter((request) => request.url.endsWith("/complete")).length, 2);
});

test("any mint failure completes retryably before a GitHub surface or merge write exists", async () => {
  const secret = `untrusted-${"S".repeat(24)}`;
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return compatibleAgentOsResponse(input);
  };
  let surfaceCalls = 0;
  let executeCalls = 0;
  await runClaim(config, "/private/app.pem", claimed("failed-run"), log, fetchImpl, {
    mintToken: async () => ({ ok: false, failure: "private-key-read-failed" }),
    makeGitHub: (() => { surfaceCalls += 1; return {}; }) as never,
    executeDecision: (async () => { executeCalls += 1; throw new Error(secret); }) as never,
  });
  assert.equal(surfaceCalls, 0);
  assert.equal(executeCalls, 0);
  assert.deepEqual(requests.map((request) => request.url), [
    "https://agentos.test/runner/runs/failed-run/start",
    "https://agentos.test/runner/runs/failed-run/heartbeat",
    "https://agentos.test/runner/runs/failed-run/complete",
  ]);
  const { outcome } = JSON.parse(requests[2]!.body) as { outcome: RunOutcome };
  // A crashed executor persists no merge result, so the deliverable is absent
  // rather than unverifiable: retryable, and the next attempt can still make it.
  assert.equal(outcome.case, "required-output-unsatisfied");
  assert.match("reason" in outcome ? outcome.reason : "", /private-key-read-failed/u);
  assert.equal(requests.some((request) => request.body.includes(secret)), false);
});

test("a bounded non-settling key read cannot reach a GitHub surface, activity, or output", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return compatibleAgentOsResponse(input);
  };
  let surfaceCalls = 0;
  let executeCalls = 0;
  const startedAt = Date.now();
  await runClaim({ ...config, githubAppAuthTimeoutMs: 10 }, "/private/app.pem", claimed("stalled-key-run"), log, fetchImpl, {
    mintToken: async (options) => await mintInstallationToken({
      ...options,
      currentUid: () => 501,
      statPrivateKey: async () => ({ uid: 501, mode: 0o100600, size: 1_700, isFile: () => true } as Stats),
      readPrivateKey: async () => await new Promise<string>(() => {}),
    }),
    makeGitHub: (() => { surfaceCalls += 1; return {}; }) as never,
    executeDecision: (async () => { executeCalls += 1; return {}; }) as never,
  });
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(surfaceCalls, 0);
  assert.equal(executeCalls, 0);
  assert.deepEqual(requests.map((request) => request.url), [
    "https://agentos.test/runner/runs/stalled-key-run/start",
    "https://agentos.test/runner/runs/stalled-key-run/heartbeat",
    "https://agentos.test/runner/runs/stalled-key-run/complete",
  ]);
  assert.equal(requests.some((request) => request.url.includes("/activity") || request.url.includes("/output")), false);
  assert.match(requests[2]!.body, /private-key-read-failed/u);
});

test("escaped malformed token responses cannot enter logs, completion, activity, or output", async () => {
  for (const invalidToken of [`${"A".repeat(24)}\"escaped`, `${"A".repeat(24)}\\escaped`]) {
    const requests: Array<{ url: string; body: string }> = [];
    const lines: string[] = [];
    const capturedLog = makeLog(makeRedactor(), {
      log: (line: string) => lines.push(line),
      warn: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
      return compatibleAgentOsResponse(input);
    };
    let surfaceCalls = 0;
    await runClaim(config, "/private/app.pem", claimed(`malformed-${requests.length}`), capturedLog, fetchImpl, {
      mintToken: async (options) => await mintInstallationToken({
        ...options,
        currentUid: () => 501,
        statPrivateKey: async () => ({ uid: 501, mode: 0o100600, size: 1_700, isFile: () => true } as Stats),
        readPrivateKey: async () => "private-key-bytes",
        signer: () => "signature",
        now: () => new Date("2026-08-21T12:00:00.000Z"),
        http: async () => ({
          status: 201,
          body: JSON.stringify({ token: invalidToken, expires_at: "2026-08-21T13:00:00.000Z" }),
        }),
      }),
      makeGitHub: (() => { surfaceCalls += 1; return {}; }) as never,
    });
    assert.equal(surfaceCalls, 0);
    assert.ok(lines.every((line) => !line.includes(invalidToken)));
    assert.ok(requests.every((request) => !request.body.includes(invalidToken)));
    assert.equal(requests.some((request) => request.url.includes("/activity") || request.url.includes("/output")), false);
    assert.match(requests.at(-1)!.body, /installation-token-response-malformed/u);
  }
});

test("a minted installation token cannot escape through run evidence or completion errors", async () => {
  const installationToken = `installation_${"X".repeat(32)}`;
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    if (url.startsWith("https://api.github.test")) {
      return new Response(JSON.stringify({ errors: [{ message: installationToken }] }), { status: 200 });
    }
    return compatibleAgentOsResponse(input);
  };
  await runClaim(config, "/private/app.pem", claimed("redacted-run"), log, fetchImpl, {
    mintToken: async () => ({ ok: true, token: installationToken, expiresAt: new Date(Date.now() + 60 * 60_000) }),
    makeGitHub: ((options: { http: (request: Record<string, unknown>) => Promise<{ body: string }> }) => ({
      readPullRequest: async () => {
        const response = await options.http({
          url: "https://api.github.test/graphql", method: "POST", headers: { Authorization: `Bearer ${installationToken}` }, signal: AbortSignal.timeout(100),
        });
        throw new Error(response.body);
      },
    })) as never,
    executeDecision: (async (deps: { readPullRequest: (reference: unknown) => Promise<unknown> }) => {
      await deps.readPullRequest({});
      throw new Error(installationToken);
    }) as never,
  });
  assert.ok(requests.every((request) => !request.body.includes(installationToken)));
  const completion = requests.find((request) => request.url.endsWith("/complete"));
  assert.ok(completion);
  assert.equal(completion.body.includes(installationToken), false);
  assert.match(completion.body, /crashed during mechanical execution/u);
});

test("a rejected completion is recorded once and is not submitted again", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const errors: string[] = [];
  const responseBody = JSON.stringify({ error: "completion payload is incompatible" });
  const capturedLog = makeLog(makeRedactor(), {
    log: () => {},
    warn: () => {},
    error: (line: string) => errors.push(line),
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/complete")) {
      return new Response(responseBody, { status: 400, headers: { "content-type": "application/json" } });
    }
    return compatibleAgentOsResponse(input);
  };

  await runClaim(config, "/private/app.pem", claimed("rejected-completion"), capturedLog, fetchImpl, {
    mintToken: async () => ({ ok: true, token: `installation_${"R".repeat(32)}`, expiresAt: new Date(Date.now() + 60 * 60_000) }),
    makeGitHub: (() => ({})) as never,
    executeDecision: async () => ({ outcome: "stopped", condition: "unresolved-mergeability", evidence: "fixture" }),
  });

  assert.equal(requests.filter(({ url }) => url.endsWith("/complete")).length, 1);
  const rejectionActivities = requests.filter(({ url, body }) => url.endsWith("/activity") && body.includes("completionRejected"));
  assert.equal(rejectionActivities.length, 1);
  const activity = JSON.parse(rejectionActivities[0]!.body) as { body: string; metadata: Record<string, unknown> };
  assert.equal(activity.metadata.status, 400);
  assert.equal(activity.metadata.responseBody, responseBody);
  assert.match(activity.body, /HTTP 400/u);
  assert.match(activity.body, /completion payload is incompatible/u);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /HTTP 400/u);
  assert.match(errors[0]!, /completion payload is incompatible/u);
});

test("a completion network failure is retried exactly once", async () => {
  let completionAttempts = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/complete")) {
      completionAttempts += 1;
      if (completionAttempts === 1) throw new TypeError("network disconnected");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return compatibleAgentOsResponse(input);
  };

  await makeAgentOsClient(config, fetchImpl).complete(claimed("network-retry"), {
    succeeded: true,
    outcome: { outcome: "stopped", condition: "unresolved-mergeability", evidence: "fixture" },
  }, makeRedactor());

  assert.equal(completionAttempts, 2);
});

test("a non-network completion exception is not retried", async () => {
  let completionAttempts = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/complete")) {
      completionAttempts += 1;
      throw new Error("programming failure in fetch adapter");
    }
    return compatibleAgentOsResponse(input);
  };

  await assert.rejects(
    makeAgentOsClient(config, fetchImpl).complete(claimed("no-programming-retry"), {
      succeeded: true,
      outcome: { outcome: "stopped", condition: "unresolved-mergeability", evidence: "fixture" },
    }, makeRedactor()),
    /programming failure/u,
  );
  assert.equal(completionAttempts, 1);
});

test("completion rejection evidence redacts the run-scoped installation token", async () => {
  const installationToken = `installation_${"Z".repeat(32)}`;
  const requests: Array<{ url: string; body: string }> = [];
  const lines: string[] = [];
  const capturedLog = makeLog(makeRedactor(), {
    log: (line: string) => lines.push(line),
    warn: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/complete")) {
      return new Response(JSON.stringify({ error: `rejected ${installationToken}` }), { status: 400 });
    }
    return compatibleAgentOsResponse(input);
  };

  await runClaim(config, "/private/app.pem", claimed("redacted-rejection"), capturedLog, fetchImpl, {
    mintToken: async () => ({ ok: true, token: installationToken, expiresAt: new Date(Date.now() + 60 * 60_000) }),
    makeGitHub: (() => ({})) as never,
    executeDecision: async () => ({ outcome: "stopped", condition: "unresolved-mergeability", evidence: "fixture" }),
  });

  assert.equal(requests.some(({ body }) => body.includes(installationToken)), false);
  assert.equal(lines.some((line) => line.includes(installationToken)), false);
  assert.ok(requests.some(({ body }) => body.includes("[redacted-merge-credential]")));
  assert.ok(lines.some((line) => line.includes("[redacted-merge-credential]")));
});

test("the daemon still starts when it is reached through a symlinked release directory", () => {
  // The operator runbook installs versioned releases and starts the daemon
  // through a `current` -> releases/<oid> symlink. ESM resolves that before it
  // sets import.meta.url, so an entrypoint guard comparing raw strings skipped
  // `main` entirely: node exited 0 with no output at all and the service
  // manager respawned the silence forever. Assert the loud behaviour, because
  // silence is the failure this is standing in front of.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "merge-executor-entrypoint-"));
  try {
    const link = join(scratch, "current");
    symlinkSync(here, link, "dir");
    const started = spawnSync(
      process.execPath,
      ["--conditions=development", "--import", import.meta.resolve("tsx"), join(link, "index.ts")],
      {
        // No configuration and an empty working directory, so the startup gate
        // refuses immediately and this never reaches a control plane.
        cwd: scratch,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      },
    );
    assert.match(started.stderr, /merge-executor startup refused:/u, `stderr was ${JSON.stringify(started.stderr)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
