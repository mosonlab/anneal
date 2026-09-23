-- The native subagent snapshot keeps its shape here; which model it names is the
-- control plane's pin, so a model bump no longer needs a migration.
ALTER TABLE "Run"
  DROP CONSTRAINT "Run_native_subagent_snapshot_check",
  ADD CONSTRAINT "Run_native_subagent_snapshot_check" CHECK (
    ("subagentModel" IS NULL AND "subagentMaxConcurrent" IS NULL)
    OR (
      "runner" = 'codex'
      AND "subagentModel" IS NOT NULL
      AND "subagentMaxConcurrent" IS NOT NULL
      AND "subagentMaxConcurrent" = 8
    )
  );
