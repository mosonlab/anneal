import { DeployFailure, failureOf } from "./quiet-window-lib.mjs";
import {
  clearEscalationRecord,
  ESCALATION_RETRY_CAP,
  escalationAttempts,
  escalationIdentity,
  readEscalationRecord,
  writeEscalationRecord,
} from "./quiet-window-escalation-record.mjs";

const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };

const OID = /^[0-9a-f]{40}$/u;

/** The commit a marker latched against. `null` means the marker names no
 * usable target, which is never treated as commit-scoped: a failure whose
 * target is unknown could have come from anything on this host. */
export const escalationTargetCommit = (record) => {
  const to = record?.to;
  return typeof to === "string" && OID.test(to) ? to : null;
};

/** Classify a marker into the three escalation classes.
 *
 * - `retryable-transient`: an external cause on the shipped allowlist. The
 *   marker self-clears after a successful attempt while under the retry cap,
 *   and latches like today once the cap is reached — the allowlist owns this
 *   class entirely, so a new commit does not change its answer.
 * - `commit-scoped`: the failure was determined by the commit the marker names
 *   (its build, its migration, its verification). A different commit is a
 *   different question and may be attempted.
 * - `host-scoped`: the failure is a property of this host, or the marker does
 *   not name the commit it failed on. Every deploy stays blocked. */
export const escalationScope = ({ record, retryableReasons, hostScopedReasons }) => {
  const reason = String(record?.reason ?? "unknown-failure");
  if (retryableReasons?.has(reason)) return "retryable-transient";
  if (hostScopedReasons?.has(reason)) return "host-scoped";
  return escalationTargetCommit(record) === null ? "host-scoped" : "commit-scoped";
};

/** Inspect and possibly clear an escalation while the caller owns the deploy
 * process lock. Comparing the marker identity prevents a changed marker from
 * being removed. A latched marker reports the class it latched in: a
 * commit-scoped one carries the commit it failed on, so the caller can decide
 * whether the commit main now points at is a new question. */
export const checkExistingEscalation = async ({
  escalationPath,
  retryEscalationNotification,
  log,
  retryableReasons,
  hostScopedReasons,
  retryCap = ESCALATION_RETRY_CAP,
}) => {
  const marker = readEscalationRecord({ path: escalationPath });
  if (marker === null) return { active: false };
  const attempts = escalationAttempts(marker.record);
  if (retryableReasons.has(marker.record.reason)
    && attempts !== null
    && attempts < retryCap) {
    // A previous escalation may have been persisted while its Inbox delivery
    // was unavailable. Retry that delivery, but do not turn a notification
    // outage into a deploy refusal; the self-clear notification below still
    // has to succeed before the marker can be removed.
    try {
      await retryEscalationNotification();
    } catch {
      log(`RETRY inbox-notification-pending reason=${String(marker.record.reason ?? "unknown-failure")}`);
    }
    const current = readEscalationRecord({ path: escalationPath });
    if (current === null) return { active: false };
    if (escalationIdentity(current.record) !== escalationIdentity(marker.record)) {
      log(`STOP escalation-active path=${escalationPath}`);
      return { active: true };
    }
    return {
      active: false,
      retryEscalation: Object.freeze({
        record: current.record,
        snapshot: current.snapshot,
        reason: String(current.record.reason ?? marker.record.reason),
        attempts: escalationAttempts(current.record) ?? attempts,
      }),
    };
  }
  await retryEscalationNotification();
  const scope = escalationScope({ record: marker.record, retryableReasons, hostScopedReasons });
  if (scope === "commit-scoped") {
    const failedCommit = escalationTargetCommit(marker.record);
    log(`STOP escalation-active scope=commit-scoped commit=${failedCommit} path=${escalationPath}`);
    return {
      active: true,
      supersedable: Object.freeze({
        failedCommit,
        reason: String(marker.record.reason ?? "unknown-failure"),
        escalatedAt: String(marker.record.escalatedAt ?? "unknown"),
      }),
    };
  }
  log(`STOP escalation-active scope=${scope} path=${escalationPath}`);
  return { active: true };
};

/** Notify before removing a retry marker. A failed success notification must
 * leave the marker in place so the next launchd tick can try again. */
export const selfClearEscalation = async ({
  escalationPath,
  retryEscalation,
  notify,
  log,
}) => {
  if (retryEscalation === null || typeof retryEscalation !== "object") return false;
  const record = retryEscalation?.record ?? {};
  const reason = String(retryEscalation?.reason ?? record.reason ?? "unknown");
  const attempts = Number.isSafeInteger(retryEscalation?.attempts)
    && retryEscalation.attempts > 0
    ? retryEscalation.attempts
    : escalationAttempts(record) ?? 1;
  try {
    let snapshot = retryEscalation?.snapshot;
    const readMarker = () => {
      try {
        return readEscalationRecord({ path: escalationPath })?.snapshot ?? null;
      } catch {
        fail("escalation-state-changed", "marker-no-longer-readable");
      }
    };
    const beforeNotify = readMarker();
    if (beforeNotify === null) return false;
    if (snapshot === undefined) snapshot = beforeNotify;
    if (beforeNotify !== snapshot) fail("escalation-state-changed", "marker-replaced-before-self-clear");
    await notify({
      outcome: "success",
      reason: "escalation-self-cleared",
      detail: `escalation reason=${reason} attempts=${attempts}`,
      from: String(record.from ?? "unknown"),
      to: String(record.to ?? "unknown"),
    });
    const current = readMarker();
    if (current === null) return false;
    if (current !== snapshot) {
      fail("escalation-state-changed", "marker-replaced-before-self-clear");
    }
    if (!clearEscalationRecord({ path: escalationPath })) return false;
    log(`SELF-CLEAR escalation reason=${reason} attempts=${attempts}`);
    return true;
  } catch (error) {
    const failure = failureOf(error);
    log(`STOP escalation-self-clear-failed reason=${reason} attempts=${attempts} failure-reason=${failure.reason}`);
    return false;
  }
};

/** Compute the next one-based attempt count from the marker being replaced. */
export const escalationAttemptCount = ({ record, previous, retryableReasons }) => {
  if (!retryableReasons.has(record?.reason)) return null;
  if (Number.isSafeInteger(previous?.attempts) && previous.attempts > 0) return previous.attempts + 1;
  if (previous && retryableReasons.has(previous.reason)) return 2;
  if (Number.isSafeInteger(record?.attempts) && record.attempts > 0) return record.attempts;
  return 1;
};

/** Persist the terminal record through the marker's atomic writer while
 * advancing retry state from the marker it replaces. */
export const writeEscalationWithAttempts = ({
  escalationPath,
  record,
  retryableReasons,
  now,
}) => {
  let previous = null;
  try {
    previous = readEscalationRecord({ path: escalationPath })?.record ?? null;
  } catch (error) {
    // An unreadable marker is replaced by a fresh valid first-attempt record.
    if (!(error instanceof DeployFailure)) throw error;
  }
  const attempts = escalationAttemptCount({ record, previous, retryableReasons });
  const persisted = attempts === null ? record : { ...record, attempts };
  writeEscalationRecord({ path: escalationPath, record: persisted, now });
  return persisted;
};
