import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  acquireMergeLease,
  buildMergeLeaseArgv,
  classifyMergeLeaseExecution,
  isMergeLeaseReleaseAnomaly,
  mergeLeaseHoldSeconds,
  parseMergeLeaseHolder,
  parseMergeLeaseRelease,
  readMergeLeaseHolder,
  releaseMergeLease,
  resolveMergeLeaseScriptPath,
} from "./merge-lease-adapter.mjs";

const holderLine = (lease) => `MERGE LEASE HOLDER: ${JSON.stringify(lease)}`;
const heldLease = {
  holder: "runner@executor",
  task: "chain-9",
  acquiredAt: "2026-08-29T12:00:00.000Z",
  reason: "chain merge tail chain-9",
  sha: "a".repeat(40),
};

const releasedLine = "MERGE LEASE: released refs/merge-lease/holder lease-sha 2026-08-29T12:00:00.000Z";

test("recorded release output maps every machine line to one structured result", () => {
  const cases = [
    {
      name: "released",
      execution: { code: 0, stdout: `merge-lease: released refs/merge-lease/holder (lease-sha)\n${releasedLine}\n` },
      expected: {
        outcome: "released",
        ref: "refs/merge-lease/holder",
        sha: "lease-sha",
        acquiredAt: "2026-08-29T12:00:00.000Z",
      },
    },
    {
      name: "not-held",
      execution: { code: 0, stdout: "merge-lease: no lease held\nMERGE LEASE: not-held\n" },
      expected: { outcome: "not-held" },
    },
    {
      name: "skipped",
      execution: { code: 0, stdout: "merge-lease: release skipped\nMERGE LEASE: skipped chain-42\n" },
      expected: { outcome: "skipped", heldFor: "chain-42" },
    },
    {
      name: "refused",
      execution: { code: 1, stderr: "MERGE LEASE: refused holder@host\nmerge-lease: release refused\n" },
      expected: { outcome: "refused", heldBy: "holder@host" },
    },
  ];

  for (const entry of cases) {
    const result = classifyMergeLeaseExecution({ operation: "release", ...entry.execution });
    const { detail: _detail, ...structured } = result;
    assert.deepEqual(structured, entry.expected, entry.name);
  }
});

test("release parsing rejects malformed, missing, duplicate, and exit-inconsistent output", () => {
  assert.deepEqual(
    parseMergeLeaseRelease("MERGE LEASE: released refs/merge-lease/holder lease-sha malformed-timestamp"),
    {
      outcome: "released",
      ref: "refs/merge-lease/holder",
      sha: "lease-sha",
      acquiredAt: "malformed-timestamp",
    },
  );
  assert.equal(parseMergeLeaseRelease("MERGE LEASE: released refs/merge-lease/holder lease-sha"), null);
  assert.equal(parseMergeLeaseRelease("no machine output"), null);
  assert.equal(parseMergeLeaseRelease(`${releasedLine}\nMERGE LEASE: not-held\n`), null);

  const cases = [
    { code: 0, stdout: "" },
    { code: 0, stdout: "MERGE LEASE: released refs/merge-lease/holder lease-sha\n" },
    { code: 1, stdout: `${releasedLine}\n` },
    { code: 0, stderr: "MERGE LEASE: refused holder@host\n" },
    { code: 75, stderr: "MERGE LEASE: refused holder@host\n" },
    { code: 75, stderr: "merge-lease: unexpected release failure\n" },
  ];
  for (const execution of cases) {
    assert.equal(classifyMergeLeaseExecution({ operation: "release", ...execution }).outcome, "unreachable");
  }
});

test("release classification identifies ordinary results and anomalies", () => {
  assert.equal(isMergeLeaseReleaseAnomaly({ outcome: "released" }), false);
  assert.equal(isMergeLeaseReleaseAnomaly({ outcome: "not-held" }), false);
  assert.equal(isMergeLeaseReleaseAnomaly({ outcome: "skipped", heldFor: "chain-42" }), true);
  assert.equal(isMergeLeaseReleaseAnomaly({ outcome: "refused", heldBy: "holder@host" }), true);
  assert.equal(isMergeLeaseReleaseAnomaly({ outcome: "unreachable", detail: "transport failed" }), true);
});

test("acquisition exit table distinguishes acquired, contended, and unreachable", () => {
  assert.equal(classifyMergeLeaseExecution({ operation: "acquire", code: 0 }).outcome, "acquired");
  assert.equal(classifyMergeLeaseExecution({ operation: "acquire", code: 75 }).outcome, "contended");
  assert.deepEqual(
    classifyMergeLeaseExecution({ operation: "acquire", code: 1, stderr: "transport failed" }),
    { outcome: "unreachable", detail: "transport failed" },
  );
  assert.deepEqual(
    classifyMergeLeaseExecution({ operation: "acquire", code: null, error: new Error("spawn bash ENOENT") }),
    { outcome: "unreachable", detail: "spawn bash ENOENT" },
  );
});

test("path resolution and argv honor the release root and caller policy", async () => {
  const releaseRoot = path.resolve("/srv/agentos/current");
  const scriptPath = path.join(releaseRoot, "scripts/merge-lease.sh");
  assert.equal(
    resolveMergeLeaseScriptPath({
      environment: { AGENTOS_RELEASE_ROOT: releaseRoot, AGENTOS_REPOSITORY_ROOT: "/srv/agentos/source" },
      repoRoot: "/checkout",
    }),
    scriptPath,
  );
  assert.equal(
    resolveMergeLeaseScriptPath({ environment: {}, repoRoot: "/checkout" }),
    path.resolve("/checkout/scripts/merge-lease.sh"),
  );
  assert.equal(
    resolveMergeLeaseScriptPath({ environment: {} }),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "merge-lease.sh"),
  );
  assert.deepEqual(buildMergeLeaseArgv({
    operation: "acquire",
    scriptPath,
    task: "chain-42",
    reason: "chain merge tail chain-42",
    timeoutMinutes: 0,
  }), [
    scriptPath,
    "acquire",
    "--task",
    "chain-42",
    "--reason",
    "chain merge tail chain-42",
    "--timeout-minutes",
    "0",
  ]);
  assert.deepEqual(buildMergeLeaseArgv({ operation: "release", scriptPath, task: "chain-42" }), [
    scriptPath,
    "release",
    "--task",
    "chain-42",
  ]);

  const calls = [];
  const runner = async (...args) => {
    calls.push(args);
    return calls.length === 1
      ? { code: 75, stderr: "merge-lease: timed out\n" }
      : { code: 0, stdout: "MERGE LEASE: not-held\n" };
  };
  assert.equal((await acquireMergeLease({
    repoRoot: "/checkout",
    environment: { AGENTOS_RELEASE_ROOT: releaseRoot },
    runner,
    task: "chain-42",
    reason: "zero wait",
    timeoutMinutes: 0,
    processTimeoutMs: 30_000,
  })).outcome, "contended");
  assert.equal((await releaseMergeLease({
    repoRoot: "/checkout",
    environment: { AGENTOS_RELEASE_ROOT: releaseRoot },
    runner,
    task: "chain-42",
    processTimeoutMs: 90_000,
  })).outcome, "not-held");
  assert.deepEqual(calls[0], [
    "bash",
    [scriptPath, "acquire", "--task", "chain-42", "--reason", "zero wait", "--timeout-minutes", "0"],
    { cwd: "/checkout", environment: { AGENTOS_RELEASE_ROOT: releaseRoot }, processTimeoutMs: 30_000 },
  ]);
  assert.deepEqual(calls[1], [
    "bash",
    [scriptPath, "release", "--task", "chain-42"],
    { cwd: "/checkout", environment: { AGENTOS_RELEASE_ROOT: releaseRoot }, processTimeoutMs: 90_000 },
  ]);
});

test("a contended acquisition carries the holder the script named", () => {
  const contended = classifyMergeLeaseExecution({
    operation: "acquire",
    code: 75,
    stderr: `merge-lease: timed out waiting for refs/merge-lease/holder after 0 minute(s)\n${holderLine(heldLease)}\n`,
  });
  assert.equal(contended.outcome, "contended");
  assert.deepEqual(contended.holder, heldLease);
});

test("a contention the script could not name is still a contention", () => {
  const contended = classifyMergeLeaseExecution({
    operation: "acquire",
    code: 75,
    stderr: "merge-lease: timed out waiting for refs/merge-lease/holder after 0 minute(s)\n",
  });
  assert.equal(contended.outcome, "contended");
  assert.equal(contended.holder, undefined);
});

test("holder lines are read only when they say something a reader can trust", () => {
  assert.deepEqual(parseMergeLeaseHolder(holderLine(heldLease)), heldLease);
  assert.deepEqual(
    parseMergeLeaseHolder(holderLine({ holder: "solo@host", acquiredAt: heldLease.acquiredAt })),
    { holder: "solo@host", task: null, reason: null, acquiredAt: heldLease.acquiredAt, sha: null },
  );
  assert.equal(parseMergeLeaseHolder("MERGE LEASE HOLDER: none"), null);
  assert.equal(parseMergeLeaseHolder("merge-lease: no lease held"), null);
  assert.equal(parseMergeLeaseHolder("MERGE LEASE HOLDER: {not json"), null);
  assert.equal(parseMergeLeaseHolder(holderLine({ acquiredAt: heldLease.acquiredAt })), null);
  assert.equal(parseMergeLeaseHolder(holderLine({ holder: "solo@host", acquiredAt: "never" })), null);
  // Two holders in one output is an output no reader can attribute.
  assert.equal(parseMergeLeaseHolder(`${holderLine(heldLease)}\n${holderLine(heldLease)}`), null);
});

test("a status read reports the holder, no lease, or an unreachable origin", async () => {
  assert.deepEqual(
    classifyMergeLeaseExecution({ operation: "status", code: 0, stderr: holderLine(heldLease) }),
    { outcome: "held", holder: heldLease, detail: holderLine(heldLease) },
  );
  assert.equal(classifyMergeLeaseExecution({
    operation: "status",
    code: 0,
    stdout: "merge-lease: no lease held\n",
    stderr: "MERGE LEASE HOLDER: none\n",
  }).outcome, "none");
  assert.deepEqual(
    classifyMergeLeaseExecution({ operation: "status", code: 1, stderr: "could not read refs/merge-lease/holder" }),
    { outcome: "unreachable", detail: "could not read refs/merge-lease/holder" },
  );

  const calls = [];
  const status = await readMergeLeaseHolder({
    repoRoot: "/checkout",
    environment: {},
    processTimeoutMs: 30_000,
    runner: async (...args) => {
      calls.push(args);
      return { code: 0, stderr: holderLine(heldLease) };
    },
  });
  assert.equal(status.outcome, "held");
  assert.deepEqual(calls[0][1], [path.resolve("/checkout/scripts/merge-lease.sh"), "status"]);
});

test("a hold is whole seconds and never negative", () => {
  assert.equal(mergeLeaseHoldSeconds("2026-08-29T12:00:00.000Z", new Date("2026-08-29T12:02:07.400Z")), 127);
  assert.equal(mergeLeaseHoldSeconds("2026-08-29T12:00:00.000Z", "2026-08-29T11:59:00.000Z"), 0);
  assert.equal(mergeLeaseHoldSeconds("never", new Date("2026-08-29T12:00:00.000Z")), null);
  assert.equal(mergeLeaseHoldSeconds("2026-08-29T12:00:00.000Z", new Date(Number.NaN)), null);
});
