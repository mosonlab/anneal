import assert from "node:assert/strict";
import test from "node:test";

import {
  contentionAlertAfterMs,
  contentionAlertDedupePrefix,
  DEFAULT_CONTENTION_ALERT_MINUTES,
} from "./merge-lease-contention.js";

test("the contention alert window is configurable and defaults to thirty minutes", () => {
  assert.equal(contentionAlertAfterMs({}), DEFAULT_CONTENTION_ALERT_MINUTES * 60_000);
  assert.equal(contentionAlertAfterMs({ MERGE_LEASE_CONTENTION_ALERT_MINUTES: "5" }), 300_000);
  assert.equal(contentionAlertAfterMs({ MERGE_LEASE_CONTENTION_ALERT_MINUTES: "0.5" }), 30_000);
  // A window that is not a positive number is not a window; the default holds
  // rather than alerting on the first contention or never alerting at all.
  for (const raw of ["", "0", "-5", "soon"]) {
    assert.equal(
      contentionAlertAfterMs({ MERGE_LEASE_CONTENTION_ALERT_MINUTES: raw }),
      DEFAULT_CONTENTION_ALERT_MINUTES * 60_000,
      raw,
    );
  }
});

test("one open operator alert per chain, whichever episode opened it", () => {
  assert.equal(contentionAlertDedupePrefix("chain-42"), "merge-lease-contention:chain-42:");
  assert.notEqual(contentionAlertDedupePrefix("chain-42"), contentionAlertDedupePrefix("chain-43"));
});
