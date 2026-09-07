import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DeployFailure } from "./quiet-window-lib.mjs";

const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };

/** Retryable markers at this attempt count begin capped exponential backoff. */
export const ESCALATION_RETRY_CAP = 5;

/** Every write of the marker replaces the whole file through a rename, so a
 * reader never observes a partial record. */
const replaceAtomically = (path, contents) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
};

/** Atomically replace the active escalation with the latest terminal record.
 * A watchdog precursor must not hide the failure that ultimately stops the
 * deployment. */
export const writeEscalationRecord = ({ path, record, now = () => new Date() }) => {
  replaceAtomically(path, {
    notificationDelivered: false,
    ...record,
    escalatedAt: now().toISOString(),
  });
};

/** Read the marker. `null` means no escalation is recorded; anything else that
 * stops the read is a failure, never an absent marker. `snapshot` is the exact
 * file text, which is the unit the identity comparison works in. */
export const readEscalationRecord = ({ path }) => {
  let snapshot;
  try {
    snapshot = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("escalation-state-unreadable", "unreadable-or-invalid-json");
  }
  let record;
  try {
    record = JSON.parse(snapshot);
  } catch {
    fail("escalation-state-unreadable", "unreadable-or-invalid-json");
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    fail("escalation-state-unreadable", "json-root-is-not-an-object");
  }
  return { snapshot, record };
};

/** Record that the failure notification for this marker was delivered. This is
 * the only field any writer changes after the create, so every other field is
 * the marker identity below. */
export const markEscalationNotified = ({ path }) => {
  const marker = readEscalationRecord({ path });
  if (marker === null) fail("escalation-state-unreadable", "marker-absent");
  replaceAtomically(path, { ...marker.record, notificationDelivered: true });
};

/** Treat every field except the delivery flag as the marker identity, so a
 * concurrent watchdog record cannot be admitted by one read and removed by a
 * later retry. */
export const escalationIdentity = (record) => JSON.stringify(
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== "notificationDelivered")),
);

/** Escalation attempts are one-based: the first persisted failure is attempt
 * one, and a marker without the field predates the retry policy. An explicitly
 * malformed value is `null` so it cannot bypass the cap. */
export const escalationAttempts = (record) => {
  if (!Object.hasOwn(record, "attempts")) return 1;
  return Number.isSafeInteger(record.attempts) && record.attempts > 0 ? record.attempts : null;
};

/** Remove the marker. `false` means there was nothing to remove. The answer
 * comes from the removal itself and never from a preceding existence check:
 * `0580e08a` had to stop this command reporting a clear it never performed. */
export const clearEscalationRecord = ({ path }) => {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("escalation-state-changed", "marker-clear-failed");
  }
  return true;
};

/** The `--clear-escalation` operation. Its report is part of the operation so
 * `CLEARED` cannot be printed over a removal that did not happen, and the
 * absent case names the path it looked at. This command lied on 2026-09-01:
 * run from a release checkout without `AGENTOS_REPOSITORY_ROOT` it pointed at
 * an empty `current/.agentos-deploy/`, deleted nothing, and printed the
 * success line anyway while the real marker kept holding the deploy. */
export const clearEscalationOnOperatorRequest = ({ path, log }) => {
  if (clearEscalationRecord({ path })) {
    log("CLEARED escalation operator-action-required-before-this-command");
    return true;
  }
  log(`NO-ESCALATION-TO-CLEAR path=${path}`);
  return false;
};
