CREATE INDEX "TaskActivity_mergeability_wait_latest_idx"
ON "TaskActivity" ("taskId", "createdAt" DESC, id DESC)
WHERE "actorType" = 'control-plane' AND metadata->>'kind' = 'mergeTail.mergeabilityWait';
