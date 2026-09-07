-- Explicit backfill, stated rather than implied: every count an in-flight
-- attempt already carries in "validationAttempts" was recorded when that
-- column was the only classification counter, so it is validation-class by
-- definition. The new validation budget also needs an elapsed time, and the
-- only durable lower bound history offers is when the attempt opened; a
-- pre-existing failure cannot have happened before that. Rows with no
-- recorded failure keep a null first-failure time and start clean.
UPDATE "MergeRecoveryAttempt"
SET "validationFirstAt" = "startedAt",
    "lastRetryClass" = 'validation'::"MergeRecoveryRetryClass"
WHERE "validationAttempts" > 0
  AND "validationFirstAt" IS NULL;
