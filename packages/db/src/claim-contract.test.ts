import assert from "node:assert/strict";
import test from "node:test";

import {
  MECHANICAL_CONTRACT_MISMATCH_CODE,
  MECHANICAL_CONTRACT_MISMATCH_DEDUPE_KEY_PREFIX,
  RUN_COMPLETION_CONTRACT_VERSION,
  mechanicalContractMismatch,
} from "./claim-contract.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");

test("exports one completion contract version for independently built processes", () => {
  assert.equal(RUN_COMPLETION_CONTRACT_VERSION, 3);
  assert.equal(Number.isInteger(RUN_COMPLETION_CONTRACT_VERSION), true);
  assert.equal(RUN_COMPLETION_CONTRACT_VERSION > 0, true);
  assert.equal(MECHANICAL_CONTRACT_MISMATCH_CODE, "mechanical_contract_mismatch");
});

test("the executor's own version is compatible", () => {
  assert.equal(
    mechanicalContractMismatch({ receivedVersion: RUN_COMPLETION_CONTRACT_VERSION, taskId: "task-1", now: NOW }),
    null,
  );
});

test("an incompatible claim gets a refusal, a record and an alert naming both versions", () => {
  const mismatch = mechanicalContractMismatch({
    receivedVersion: RUN_COMPLETION_CONTRACT_VERSION + 1,
    taskId: "task-1",
    now: NOW,
  });
  assert.ok(mismatch);
  assert.deepEqual(mismatch.refusal, {
    error: `Mechanical completion contract mismatch: executor version ${RUN_COMPLETION_CONTRACT_VERSION + 1}; API version ${RUN_COMPLETION_CONTRACT_VERSION}`,
    reason: MECHANICAL_CONTRACT_MISMATCH_CODE,
    code: MECHANICAL_CONTRACT_MISMATCH_CODE,
    expectedVersion: RUN_COMPLETION_CONTRACT_VERSION,
    receivedVersion: RUN_COMPLETION_CONTRACT_VERSION + 1,
  });
  assert.equal(mismatch.activity.body, mismatch.refusal.error);
  assert.deepEqual(mismatch.activity.metadata, {
    code: MECHANICAL_CONTRACT_MISMATCH_CODE,
    executorVersion: RUN_COMPLETION_CONTRACT_VERSION + 1,
    apiVersion: RUN_COMPLETION_CONTRACT_VERSION,
  });
  assert.equal(
    mismatch.alert.body,
    `merge executor completion contract mismatch: executor version ${RUN_COMPLETION_CONTRACT_VERSION + 1}; API version ${RUN_COMPLETION_CONTRACT_VERSION}; task task-1`,
  );
  assert.ok(mismatch.alert.dedupeKeyPrefix.startsWith(MECHANICAL_CONTRACT_MISMATCH_DEDUPE_KEY_PREFIX));
  assert.equal(mismatch.alert.dedupeKey, `${mismatch.alert.dedupeKeyPrefix}${NOW.toISOString()}`);
});

test("an omitted version is reported as missing, not as a compatible claim", () => {
  const mismatch = mechanicalContractMismatch({ receivedVersion: null, taskId: "task-1", now: NOW });
  assert.ok(mismatch);
  assert.equal(mismatch.refusal.receivedVersion, null);
  assert.match(mismatch.refusal.error, /executor version missing/u);
  assert.equal(mismatch.activity.metadata.executorVersion, null);
  assert.match(mismatch.alert.body, /executor version missing/u);
});

test("each version pair takes its own alert dedupe prefix", () => {
  const pair = (receivedVersion: number | null): string => {
    const mismatch = mechanicalContractMismatch({ receivedVersion, taskId: "task-1", now: NOW });
    assert.ok(mismatch);
    return mismatch.alert.dedupeKeyPrefix;
  };
  assert.notEqual(pair(null), pair(RUN_COMPLETION_CONTRACT_VERSION + 1));
  assert.equal(pair(RUN_COMPLETION_CONTRACT_VERSION + 1), pair(RUN_COMPLETION_CONTRACT_VERSION + 1));
});

test("the alert body and dedupe key do not share a prefix, so one is not the other", () => {
  const mismatch = mechanicalContractMismatch({ receivedVersion: null, taskId: "task-1", now: NOW });
  assert.ok(mismatch);
  assert.equal(mismatch.alert.body.startsWith(MECHANICAL_CONTRACT_MISMATCH_DEDUPE_KEY_PREFIX), false);
});
