import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkExistingEscalation, escalationScope, selfClearEscalation, writeEscalationWithAttempts } from "./quiet-window-escalation.mjs";
import {
  clearEscalationRecord,
  ESCALATION_RETRY_CAP,
  escalationIdentity,
  markEscalationNotified,
  readEscalationRecord,
  writeEscalationRecord,
} from "./quiet-window-escalation-record.mjs";

const revision = "b".repeat(40);
const failedCommit = "c".repeat(40);
const retryableReasons = new Set(["remote-main-unreadable"]);
const hostScopedReasons = new Set(["database-backup-failed"]);
const retryableEscalation = {
  reason: "remote-main-unreadable",
  detail: "exit-128",
  // `persistAndNotifyFailure` records this sentinel when the attempt failed
  // before it could determine a target commit.
  to: "unknown",
  attempts: 1,
  escalatedAt: "2026-08-30T15:00:00.000Z",
};

const fixture = (t, escalation = retryableEscalation) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-escalation-test-"));
  const escalationPath = join(root, "escalated.json");
  writeFileSync(escalationPath, `${JSON.stringify(escalation)}\n`, { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logs = [];
  let retryCalls = 0;
  return {
    escalationPath,
    logs,
    retryCalls: () => retryCalls,
    options: {
      escalationPath,
      log: (line) => { logs.push(line); },
      retryableReasons,
      hostScopedReasons,
      retryCap: ESCALATION_RETRY_CAP,
      retryEscalationNotification: async () => { retryCalls += 1; },
    },
  };
};

test("the shipped retry policy admits an eligible marker without clearing it early", async (t) => {
  const state = fixture(t);

  const result = await checkExistingEscalation(state.options);

  assert.equal(result.active, false);
  assert.equal(result.retryEscalation.reason, "remote-main-unreadable");
  assert.equal(result.retryEscalation.attempts, 1);
  assert.equal(existsSync(state.escalationPath), true);
  assert.equal(state.retryCalls(), 1);
  assert.deepEqual(state.logs, []);
});

test("a pending failure notification logs a retry without stopping admission", async (t) => {
  const state = fixture(t);

  const result = await checkExistingEscalation({
    ...state.options,
    retryEscalationNotification: async () => { throw new Error("inbox-unavailable"); },
  });

  assert.equal(result.active, false);
  assert.equal(result.retryEscalation.reason, "remote-main-unreadable");
  assert.deepEqual(state.logs, ["RETRY inbox-notification-pending reason=remote-main-unreadable"]);
});

test("a marker replaced while retrying notification remains latched", async (t) => {
  const state = fixture(t);
  const replacement = { reason: "remote-main-auth-failed", escalatedAt: "2026-08-30T15:01:00.000Z" };

  const result = await checkExistingEscalation({
    ...state.options,
    retryEscalationNotification: async () => {
      writeFileSync(state.escalationPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    },
  });

  assert.deepEqual(result, { active: true });
  assert.deepEqual(JSON.parse(readFileSync(state.escalationPath, "utf8")), replacement);
  assert.deepEqual(state.logs, [`STOP escalation-active path=${state.escalationPath}`]);
});

test("a marker removed while retrying notification needs no retry state", async (t) => {
  const state = fixture(t);

  const result = await checkExistingEscalation({
    ...state.options,
    retryEscalationNotification: async () => { unlinkSync(state.escalationPath); },
  });

  assert.deepEqual(result, { active: false });
  assert.equal(existsSync(state.escalationPath), false);
});

test("an escalation outside the shipped allowlist stays latched", async (t) => {
  const state = fixture(t, {
    reason: "remote-main-corrupt-response",
    escalatedAt: "2026-08-30T15:00:00.000Z",
  });

  const result = await checkExistingEscalation(state.options);

  assert.deepEqual(result, { active: true });
  assert.equal(existsSync(state.escalationPath), true);
  assert.equal(state.retryCalls(), 1);
});

test("the three escalation classes are decided by target first and reason second", () => {
  const scope = (record) => escalationScope({ record, retryableReasons, hostScopedReasons });

  // With a usable target the allowlist owns its class whatever commit the
  // marker names: a new commit must not bypass the retry backoff.
  assert.equal(scope({ reason: "remote-main-unreadable", to: failedCommit }), "retryable-transient");
  assert.equal(scope({ reason: "database-backup-failed", to: failedCommit }), "host-scoped");
  assert.equal(scope({ reason: "release-artifact-build-failed", to: failedCommit }), "commit-scoped");
  // A marker that does not name the commit it failed on proves nothing about
  // which commits are affected, so it blocks all of them.
  assert.equal(scope({ reason: "release-artifact-build-failed" }), "host-scoped");
  assert.equal(scope({ reason: "release-artifact-build-failed", to: "unknown" }), "host-scoped");
  assert.equal(scope({ reason: "release-artifact-build-failed", to: `${failedCommit}x` }), "host-scoped");
  assert.equal(scope({}), "host-scoped");
});

test("a commit-scoped escalation latches while reporting the commit it failed on", async (t) => {
  const state = fixture(t, {
    reason: "release-artifact-build-failed",
    to: failedCommit,
    escalatedAt: "2026-08-30T15:00:00.000Z",
  });

  const result = await checkExistingEscalation(state.options);

  assert.equal(result.active, true);
  assert.deepEqual(result.supersedable, {
    failedCommit,
    reason: "release-artifact-build-failed",
    escalatedAt: "2026-08-30T15:00:00.000Z",
  });
  assert.equal(existsSync(state.escalationPath), true);
  assert.deepEqual(state.logs, [
    `STOP escalation-active scope=commit-scoped commit=${failedCommit} path=${state.escalationPath}`,
  ]);
});

test("a host-scoped escalation latches without a commit to supersede", async (t) => {
  const state = fixture(t, {
    reason: "database-backup-failed",
    to: failedCommit,
    escalatedAt: "2026-08-30T15:00:00.000Z",
  });

  const result = await checkExistingEscalation(state.options);

  assert.deepEqual(result, { active: true });
  assert.deepEqual(state.logs, [
    `STOP escalation-active scope=host-scoped path=${state.escalationPath}`,
  ]);
});

test("a commit-scoped marker without a usable target latches as host-scoped", async (t) => {
  const state = fixture(t, {
    reason: "release-artifact-build-failed",
    to: "unknown",
    escalatedAt: "2026-08-30T15:00:00.000Z",
  });

  assert.deepEqual(await checkExistingEscalation(state.options), { active: true });
  assert.equal(existsSync(state.escalationPath), true);
});

test("a retryable reason cannot rescue a marker whose target is missing or malformed", async (t) => {
  const scope = (record) => escalationScope({ record, retryableReasons, hostScopedReasons });

  // Target validation runs before the allowlist: only the deploy's own
  // "no target determined" sentinel and a real oid describe a state this
  // classifier can reason about.
  assert.equal(scope({ reason: "remote-main-unreadable", to: "unknown" }), "retryable-transient");
  assert.equal(scope({ reason: "remote-main-unreadable", to: failedCommit }), "retryable-transient");
  assert.equal(scope({ reason: "remote-main-unreadable" }), "host-scoped");
  assert.equal(scope({ reason: "remote-main-unreadable", to: `${failedCommit}x` }), "host-scoped");
  assert.equal(scope({ reason: "remote-main-unreadable", to: null }), "host-scoped");

  const state = fixture(t, { ...retryableEscalation, to: `${failedCommit}x` });
  assert.deepEqual(await checkExistingEscalation(state.options), { active: true });
  assert.equal(existsSync(state.escalationPath), true);
});

test("a retryable marker at the cap waits without becoming supersedable", async (t) => {
  const state = fixture(t, {
    ...retryableEscalation,
    to: failedCommit,
    attempts: ESCALATION_RETRY_CAP,
    retryAfter: "2099-01-01T00:00:00.000Z",
  });

  assert.deepEqual(await checkExistingEscalation(state.options), { active: true });
});

const markerFixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-escalation-marker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "state", "escalated.json");
};

test("a created marker is readable, undelivered, and stamped by the injected clock", (t) => {
  const path = markerFixture(t);

  writeEscalationRecord({
    path,
    record: { outcome: "failure", reason: "remote-main-unreadable", detail: "exit-128", attempts: 1 },
    now: () => new Date("2026-09-02T04:00:00.000Z"),
  });

  const marker = readEscalationRecord({ path });
  assert.deepEqual(marker.record, {
    notificationDelivered: false,
    outcome: "failure",
    reason: "remote-main-unreadable",
    detail: "exit-128",
    attempts: 1,
    escalatedAt: "2026-09-02T04:00:00.000Z",
  });
  assert.equal(marker.snapshot, readFileSync(path, "utf8"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("an absent marker reads as no escalation while an unreadable one fails", (t) => {
  const path = markerFixture(t);

  assert.equal(readEscalationRecord({ path }), null);

  writeEscalationRecord({ path, record: { reason: "remote-main-unreadable" } });
  writeFileSync(path, "{not json", { mode: 0o600 });
  assert.throws(() => readEscalationRecord({ path }), {
    name: "DeployFailure",
    reason: "escalation-state-unreadable",
    detail: "unreadable-or-invalid-json",
  });

  writeFileSync(path, "[]", { mode: 0o600 });
  assert.throws(() => readEscalationRecord({ path }), {
    name: "DeployFailure",
    reason: "escalation-state-unreadable",
    detail: "json-root-is-not-an-object",
  });
});

test("marking the notification delivered changes no other field of the marker identity", (t) => {
  const path = markerFixture(t);
  writeEscalationRecord({
    path,
    record: { outcome: "failure", reason: "remote-main-unreadable", detail: "exit-128", attempts: 3 },
    now: () => new Date("2026-09-02T04:00:00.000Z"),
  });
  const before = readEscalationRecord({ path }).record;

  markEscalationNotified({ path });

  const after = readEscalationRecord({ path }).record;
  assert.equal(after.notificationDelivered, true);
  assert.equal(escalationIdentity(after), escalationIdentity(before));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("marking an absent marker fails rather than creating one", (t) => {
  const path = markerFixture(t);

  assert.throws(() => markEscalationNotified({ path }), {
    name: "DeployFailure",
    reason: "escalation-state-unreadable",
    detail: "marker-absent",
  });
  assert.equal(existsSync(path), false);
});

test("clearing reports whether it removed a marker", (t) => {
  const path = markerFixture(t);
  writeEscalationRecord({ path, record: { reason: "remote-main-unreadable" } });

  assert.equal(clearEscalationRecord({ path }), true);
  assert.equal(existsSync(path), false);
  assert.equal(clearEscalationRecord({ path }), false);
});

for (const change of ["host", "absent", "unreadable"]) {
  test(`latched marker revalidation refuses ${change} after notification`, async (t) => {
    const state = fixture(t, { reason: "release-artifact-build-failed", to: failedCommit });
    const result = await checkExistingEscalation({
      ...state.options,
      retryEscalationNotification: async () => {
        if (change === "absent") unlinkSync(state.escalationPath);
        else writeFileSync(state.escalationPath, change === "host"
          ? JSON.stringify({ reason: "database-backup-failed", to: failedCommit }) : "{");
      },
    });
    assert.deepEqual(result, { active: true });
  });
}

test("classification requires the host reason policy", () => {
  assert.throws(() => escalationScope({ record: { to: failedCommit }, retryableReasons }),
    /hostScopedReasons/);
});

test("unproven activation overrides even a retryable reason", async (t) => {
  const state = fixture(t, { ...retryableEscalation, to: failedCommit, activationOutcomeProven: false });
  assert.deepEqual(await checkExistingEscalation(state.options), { active: true });
});

const backoffStart = Date.parse("2026-09-07T12:00:00.000Z");

test("capped retries wait, proceed at the deadline, and clear only on success", async (t) => {
  const state = fixture(t, { ...retryableEscalation, attempts: 4 });
  writeEscalationWithAttempts({ ...state.options, record: retryableEscalation,
    now: () => new Date(backoffStart) });
  const persisted = readEscalationRecord({ path: state.escalationPath }).record;
  assert.equal(persisted.attempts, 5);
  assert.equal(persisted.retryAfter, "2026-09-07T12:05:00.000Z");
  assert.deepEqual(await checkExistingEscalation({ ...state.options,
    now: () => new Date(backoffStart + 299_001) }), { active: true });
  assert.match(state.logs.at(-1), /scope=retryable-transient retry-after=2026-09-07T12:05:00.000Z remaining-wait-seconds=1 /u);
  const admitted = await checkExistingEscalation({ ...state.options,
    now: () => new Date(backoffStart + 300_000) });
  assert.equal(admitted.active, false);
  assert.equal(existsSync(state.escalationPath), true);
  assert.equal(await selfClearEscalation({ ...state.options,
    retryEscalation: admitted.retryEscalation, notify: async () => {} }), true);
  assert.equal(existsSync(state.escalationPath), false);
});

test("failed admitted retries increment attempts and double backoff up to one hour", async (t) => {
  const state = fixture(t, { ...retryableEscalation, attempts: 4 });
  let time = backoffStart;
  for (const [index, minutes] of [5, 10, 20, 40, 60, 60].entries()) {
    writeEscalationWithAttempts({ ...state.options, record: retryableEscalation,
      now: () => new Date(time) });
    const marker = readEscalationRecord({ path: state.escalationPath }).record;
    assert.equal(marker.attempts, index + 5);
    assert.equal(Date.parse(marker.retryAfter) - time, minutes * 60_000);
    assert.deepEqual(await checkExistingEscalation({ ...state.options,
      now: () => new Date(time) }), { active: true });
    time = Date.parse(marker.retryAfter);
    const admitted = await checkExistingEscalation({ ...state.options, now: () => new Date(time) });
    assert.equal(admitted.active, false);
    assert.equal(admitted.retryEscalation.attempts, index + 5);
  }
});

test("legacy capped markers expire using their escalation timestamp", async (t) => {
  const state = fixture(t, { ...retryableEscalation, attempts: 5,
    escalatedAt: new Date(backoffStart).toISOString() });
  assert.deepEqual(await checkExistingEscalation({ ...state.options,
    now: () => new Date(backoffStart) }), { active: true });
  assert.equal((await checkExistingEscalation({ ...state.options,
    now: () => new Date(backoffStart + 300_000) })).active, false);
});

for (const record of [
  { reason: "database-backup-failed" },
  { reason: "release-artifact-build-failed", detail: "compile failed" },
  { activationOutcomeProven: false },
  { to: "invalid" },
  { retryAfter: "invalid" },
  { retryAfter: null },
]) {
  test(`an expired deadline cannot bypass a protected marker ${JSON.stringify(record)}`, async (t) => {
    const state = fixture(t, { ...retryableEscalation, to: failedCommit, attempts: 5,
      retryAfter: new Date(backoffStart).toISOString(), ...record });
    assert.equal((await checkExistingEscalation({ ...state.options,
      now: () => new Date(backoffStart + 3_600_000) })).active, true);
  });
}

const builderFailureDetail = (diagnostic, reason = "release-artifact-source-unavailable") =>
  `${diagnostic}\nfile:///deploy/scripts/deploy/release-artifact.mjs:291\n    const failure = new DeployFailure(\n                    ^\n\nDeployFailure: ${reason}: exit-128\n    at run (release-artifact.mjs:291:21)\n    at buildReleaseArtifact (release-artifact.mjs:358:27)\n{ reason: '${reason}', detail: 'exit-128' }\nNode.js v24.0.0`;

for (const diagnostic of [
  "fatal: unable to access 'https://source/repo': gnutls_handshake() failed: The TLS connection was non-properly terminated.",
  "fatal: unable to access 'https://source/repo': OpenSSL SSL_connect: SSL_ERROR_SYSCALL",
  "fatal: could not fetch abc123 from promisor remote",
  "fatal: source clone: read timeout",
  "fatal: source fetch: Read timed out",
  "fatal: unable to access source: ssl_error_syscall",
]) {
  const detail = builderFailureDetail(diagnostic);
  test(`source transport detail earns retry backoff: ${diagnostic}`, async (t) => {
    const record = { reason: "release-artifact-build-failed", detail, to: failedCommit };
    assert.equal(escalationScope({ record, retryableReasons, hostScopedReasons }), "retryable-transient");
    const state = fixture(t, { ...record, attempts: 4 });
    writeEscalationWithAttempts({ ...state.options, record, now: () => new Date(backoffStart) });
    const marker = readEscalationRecord({ path: state.escalationPath }).record;
    assert.equal(marker.attempts, 5);
    assert.equal(marker.retryAfter, "2026-09-07T12:05:00.000Z");
    assert.equal((await checkExistingEscalation({ ...state.options,
      now: () => new Date(backoffStart) })).active, true);
    assert.equal((await checkExistingEscalation({ ...state.options,
      now: () => new Date(backoffStart + 300_000) })).active, false);
    for (const override of [{ to: "malformed" }, { activationOutcomeProven: false }]) {
      assert.equal(escalationScope({ record: { ...record, ...override }, retryableReasons, hostScopedReasons }), "host-scoped");
    }
  });
}

for (const detail of [undefined, "", "unknown", "compile failed", "test failure", "Cannot find module typescript",
  builderFailureDetail("fatal: gnutls_handshake() failed\ncompile failed", "release-artifact-build-failed"),
  builderFailureDetail("fatal: gnutls_handshake() failed\nnpm error missing dependency", "release-artifact-dependencies-failed"),
  builderFailureDetail("npm error: SSL_ERROR_SYSCALL", "release-artifact-dependencies-failed"),
  "npm error: git fetch https://github.com/some/dep failed: read timeout",
  builderFailureDetail("fatal: gnutls_handshake() failed\nfatal: authentication failed"),
  "fatal: gnutls_handshake() failed",
  "read timeout", "test database read timeout", "npm install: read timeout", "git clone: authentication failed"]) {
  test(`other artifact build detail stays commit-scoped: ${detail}`, async (t) => {
    const record = { reason: "release-artifact-build-failed", detail, to: failedCommit };
    const state = fixture(t, { ...record, attempts: 4 });
    const persisted = writeEscalationWithAttempts({ ...state.options, record });
    assert.equal(Object.hasOwn(persisted, "attempts"), false);
    assert.equal(Object.hasOwn(persisted, "retryAfter"), false);
    assert.equal(escalationScope({ record, retryableReasons, hostScopedReasons }), "commit-scoped");
    assert.equal((await checkExistingEscalation(state.options)).active, true);
  });
}


test("writer rejects a missing retryable reason set before persisting", (t) => {
  const state = fixture(t);
  const before = readFileSync(state.escalationPath, "utf8");
  for (const retryableReasons of [undefined, null, []]) {
    assert.throws(() => writeEscalationWithAttempts({ ...state.options,
      record: retryableEscalation, retryableReasons }), /retryableReasons-required/u);
    assert.equal(readFileSync(state.escalationPath, "utf8"), before);
  }
});

test("reader and writer share an injected retry cap", async (t) => {
  const state = fixture(t, { ...retryableEscalation, attempts: 2 });
  for (const [index, minutes] of [5, 10, 20].entries()) {
    const marker = writeEscalationWithAttempts({ ...state.options, retryCap: 3,
      record: retryableEscalation, now: () => new Date(backoffStart) });
    assert.equal(marker.attempts, index + 3);
    assert.equal(Date.parse(marker.retryAfter) - backoffStart, minutes * 60_000);
    assert.equal((await checkExistingEscalation({ ...state.options, retryCap: 3,
      now: () => new Date(backoffStart) })).active, true);
    assert.equal((await checkExistingEscalation({ ...state.options, retryCap: 3,
      now: () => new Date(backoffStart + minutes * 60_000) })).active, false);
  }
});
