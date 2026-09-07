ALTER TABLE "MergeRecoveryAttempt" ADD COLUMN "pendingFailureRunId" TEXT, ADD COLUMN "externalReplayCount" INTEGER NOT NULL DEFAULT 0;
