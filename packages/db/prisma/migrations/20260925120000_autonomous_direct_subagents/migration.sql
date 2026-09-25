-- Direct Implementation can choose child models while retaining the native
-- concurrency limit. Existing Run snapshots keep their model pins.
ALTER TABLE "Run"
  DROP CONSTRAINT "Run_native_subagent_snapshot_check",
  ADD CONSTRAINT "Run_native_subagent_snapshot_check" CHECK (
    ("subagentModel" IS NULL AND "subagentMaxConcurrent" IS NULL)
    OR (
      "runner" = 'codex'
      AND "subagentMaxConcurrent" IS NOT NULL
      AND "subagentMaxConcurrent" = 8
    )
  );
