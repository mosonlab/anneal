-- A base-drift recovery whose readiness authorization lands while the Chain is
-- held at the integrator's layer used to drop the integrator Run birth the hold
-- refused, leaving the chain with no exit. The aggregate now records that
-- pending authorization so `chain/resume` can replay it exactly once.

ALTER TABLE "MergeRecoveryAttempt"
  ADD COLUMN "pendingAuthorizationId" TEXT;

CREATE INDEX "MergeRecoveryAttempt_pendingAuthorizationId_idx"
  ON "MergeRecoveryAttempt" ("pendingAuthorizationId");
