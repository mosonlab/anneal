-- Native implementation subagents move from GPT-5.6 Luna max to GPT-6 Luna max.
-- Finished Runs keep the GPT-5.6 snapshot they actually ran, which cost
-- accounting prices; unfinished Runs launch or resume on the new pin, which is
-- the only one the Codex adapter accepts.
ALTER TABLE "Run"
  DROP CONSTRAINT "Run_native_subagent_snapshot_check",
  ADD CONSTRAINT "Run_native_subagent_snapshot_check" CHECK (
    ("subagentModel" IS NULL AND "subagentMaxConcurrent" IS NULL)
    OR (
      "runner" = 'codex'
      AND "subagentModel" IN ('gpt-5.6-luna:max', 'gpt-6-luna:max')
      AND "subagentMaxConcurrent" IS NOT NULL
      AND "subagentMaxConcurrent" = 8
    )
  );

UPDATE "Run"
SET "subagentModel" = 'gpt-6-luna:max'
WHERE "subagentModel" = 'gpt-5.6-luna:max'
  AND "status" IN ('queued', 'claimed', 'provisioning', 'running', 'waiting-inbox');
