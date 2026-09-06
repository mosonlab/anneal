import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkExistingEscalation, escalationScope } from "./quiet-window-escalation.mjs";
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

test("the three escalation classes are decided by reason first and target second", () => {
  const scope = (record) => escalationScope({ record, retryableReasons, hostScopedReasons });

  // The allowlist owns its class whatever commit the marker names: a new
  // commit must not shorten the retry policy or extend it past the cap.
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

test("a retryable marker at the cap latches without becoming supersedable", async (t) => {
  const state = fixture(t, {
    ...retryableEscalation,
    to: failedCommit,
    attempts: ESCALATION_RETRY_CAP,
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
