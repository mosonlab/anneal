import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { claimRequestBody, openRunSession, runnerTelemetryBody, type RunSessionClaim } from "./api.js";
import { loadRunnerConfig } from "./config.js";

const require = createRequire(import.meta.url);
const packageVersion = (require("../package.json") as { version: string }).version;

const loadUndeclaredRunnerConfig = (): ReturnType<typeof loadRunnerConfig> => {
  const previous = process.env.RUNNER_SERVED_KINDS;
  try {
    delete process.env.RUNNER_SERVED_KINDS;
    return loadRunnerConfig();
  } finally {
    if (previous === undefined) delete process.env.RUNNER_SERVED_KINDS;
    else process.env.RUNNER_SERVED_KINDS = previous;
  }
};

test("claim and heartbeat telemetry carry the exact package version", async () => {
  const config = loadUndeclaredRunnerConfig();
  const stats = async (): Promise<{ bavail: number; bsize: number }> => ({ bavail: 12, bsize: 4_096 });
  const claim = await claimRequestBody(config, stats);
  const heartbeat = await runnerTelemetryBody(config, stats);
  assert.equal(claim.daemonVersion, packageVersion);
  assert.equal(heartbeat.daemonVersion, packageVersion);
  assert.equal(claim.daemonVersion, heartbeat.daemonVersion);
  assert.deepEqual(claim, {
    runnerId: config.runnerId,
    leaseSeconds: config.leaseSeconds,
    daemonVersion: packageVersion,
    diskFreeBytes: 49_152,
    pollIntervalMs: config.pollIntervalMs,
    workspaceRoot: config.workspaceRoot,
  });
});

test("claim declaration is sent only when the runner serves an explicit set", async () => {
  const config = loadUndeclaredRunnerConfig();
  const stats = async (): Promise<{ bavail: number; bsize: number }> => ({ bavail: 12, bsize: 4_096 });
  const declaredConfig = { ...config, servedKinds: ["CODEX", "PI"] as const };

  const undeclared = await claimRequestBody(config, stats);
  const declared = await claimRequestBody(declaredConfig, stats);

  assert.equal(Object.hasOwn(undeclared, "servedKinds"), false);
  assert.deepEqual(declared, { ...undeclared, servedKinds: ["CODEX", "PI"] });
});

test("a statfs failure omits disk telemetry without blocking a claim", async () => {
  const config = loadUndeclaredRunnerConfig();
  const claim = await claimRequestBody(config, async () => { throw new Error("unmounted"); });
  assert.equal(Object.hasOwn(claim, "diskFreeBytes"), false);
  assert.equal(claim.runnerId, config.runnerId);
  assert.equal(claim.leaseSeconds, config.leaseSeconds);
});

test("the claim telemetry stays inside the API schema bounds", async () => {
  const config = loadUndeclaredRunnerConfig();
  const body = await claimRequestBody(config, async () => ({ bavail: 1, bsize: 4_096 }));
  assert.ok(typeof body.daemonVersion === "string" && body.daemonVersion.length <= 40);
  assert.ok(Number.isSafeInteger(body.diskFreeBytes) && Number(body.diskFreeBytes) >= 0);
  assert.ok(Number.isSafeInteger(body.pollIntervalMs) && Number(body.pollIntervalMs) > 0 && Number(body.pollIntervalMs) <= 3_600_000);
  assert.ok(typeof body.workspaceRoot === "string" && body.workspaceRoot.length <= 500);
});

test("a control-plane call that connects but never answers fails instead of holding the lease", async () => {
  // The gap the per-command timeout does not cover: heartbeat and completeRun
  // are plain fetches. A hung heartbeat stops renewing the lease, and a hung
  // completion loses a finished run to reconciliation — both without ever
  // reaching any of the command-level budgets.
  const server = createServer(() => { /* accept the request, answer nothing */ });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const config = {
    ...loadUndeclaredRunnerConfig(),
    apiUrl: `http://127.0.0.1:${address.port}`,
    apiTimeoutMs: 300,
  };
  const claim = {
    run: { id: "run-1" },
    fencingToken: "fence-1",
    sessionToken: "session-token",
  } satisfies RunSessionClaim;
  try {
    const started = Date.now();
    await assert.rejects(
      openRunSession(config, claim).heartbeat({ processAlive: true, lastProgressEventAt: null, inFlightTool: null }),
      /timed out after 300ms/,
    );
    // The ceiling itself is asserted above, in the rejection message. This wall
    // clock only proves the fetch was abandoned at all rather than holding the
    // lease forever, so it stays bounded — but at the loaded worker's scale,
    // not the idle one's: a starved event loop can delay the abort callback by
    // seconds without the product having done anything wrong.
    assert.ok(Date.now() - started < 30_000, "the request was not abandoned near its ceiling");
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
});
