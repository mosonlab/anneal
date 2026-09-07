-- Base-drift recovery stops spending one budget on three different failures.
-- Waiting for the chain's own active Run, a failed repository read, and a real
-- classification failure now have their own counters, their own backoff, and
-- their own ceilings.

ALTER TYPE "MergeRecoveryRefusalCode" ADD VALUE 'waiting-ceiling';
ALTER TYPE "MergeRecoveryRefusalCode" ADD VALUE 'transport-ceiling';
ALTER TYPE "MergeRecoveryRefusalCode" ADD VALUE 'validation-budget';

CREATE TYPE "MergeRecoveryRetryClass" AS ENUM (
  'waiting',
  'transport',
  'validation'
);

ALTER TABLE "MergeRecoveryAttempt"
  ADD COLUMN "waitingAttempts"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "transportAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "validationFirstAt" TIMESTAMP(3),
  ADD COLUMN "waitingFirstAt"    TIMESTAMP(3),
  ADD COLUMN "transportFirstAt"  TIMESTAMP(3),
  ADD COLUMN "nextEligibleAt"    TIMESTAMP(3),
  ADD COLUMN "lastRetryClass"    "MergeRecoveryRetryClass",
  ADD COLUMN "revalidations"     INTEGER NOT NULL DEFAULT 0;
