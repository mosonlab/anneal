-- A contention is an observation rather than a lifecycle: the chain never held
-- this lease, so there is nothing to hand off, defer or release. It is recorded
-- and settled at the same instant, which is the moment the contention was
-- alerted, and it names the holder that was in the way in "failureDetail" with
-- that holder's own acquisition time in "acquiredAt". "leaseSha" stays null so a
-- contention can never collide with the released event for the same lease blob,
-- and so a chain may record more than one contention episode.
ALTER TABLE "MergeLeaseEvent" DROP CONSTRAINT "MergeLeaseEvent_shape_check";

ALTER TABLE "MergeLeaseEvent"
ADD CONSTRAINT "MergeLeaseEvent_shape_check" CHECK (
  ("handedOffRunId" IS NULL) = ("handedOffAt" IS NULL)
  AND NOT ("handedOffAt" IS NOT NULL AND "deferredAt" IS NOT NULL)
  AND CASE "state"
    WHEN 'handoff-pending' THEN
      "handedOffAt" IS NOT NULL AND "deferredAt" IS NULL
      AND "settledAt" IS NULL AND "leaseSha" IS NULL
    WHEN 'release-deferred' THEN
      "handedOffAt" IS NULL AND "deferredAt" IS NOT NULL
      AND "settledAt" IS NULL AND "leaseSha" IS NULL
      AND "failureDetail" IS NOT NULL
    WHEN 'contended' THEN
      "handedOffAt" IS NULL AND "deferredAt" IS NULL
      AND "settledAt" IS NOT NULL AND "leaseSha" IS NULL
      AND "failureDetail" IS NOT NULL
    WHEN 'released' THEN "settledAt" IS NOT NULL
    WHEN 'invalid' THEN "settledAt" IS NOT NULL AND "failureDetail" IS NOT NULL
    ELSE false
  END
);
