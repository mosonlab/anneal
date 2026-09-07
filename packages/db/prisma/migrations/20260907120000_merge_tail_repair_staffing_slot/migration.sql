-- A staffing profile may name the Agent that owns residual merge-tail repairs.
-- Null remains meaningful: merge-tail repair falls back to the chain's
-- fixed-implementation Agent when a profile has no dedicated repair slot.
ALTER TABLE "StaffingProfile"
  ADD COLUMN "mergeTailRepairAgentId" TEXT;

CREATE INDEX "StaffingProfile_mergeTailRepairAgentId_idx"
  ON "StaffingProfile"("mergeTailRepairAgentId");

ALTER TABLE "StaffingProfile"
  ADD CONSTRAINT "StaffingProfile_mergeTailRepairAgentId_fkey"
  FOREIGN KEY ("mergeTailRepairAgentId") REFERENCES "Agent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing default profiles are the canonical definitions for the three active
-- workflows. The column did not exist before this migration, so a null here
-- cannot be an earlier operator choice. Adopt the dedicated Luna Max repair
-- Agent once; later operator writes, including clearing the slot, remain
-- authoritative because deploy-time sync only creates missing profiles.
UPDATE "StaffingProfile" AS profile
SET "mergeTailRepairAgentId" = agent."id"
FROM "TaskTemplate" AS template
JOIN LATERAL (
  SELECT candidate."id"
  FROM "Agent" AS candidate
  WHERE candidate."projectId" = template."projectId"
    AND (
      (
        candidate."canonicalRole" = 'senior-dev-luna-max'
        AND candidate."archivedAt" IS NULL
      )
      OR (
        candidate."canonicalRole" IS NULL
        AND candidate."name" = 'senior-dev-luna-max'
        AND candidate."archivedAt" IS NULL
        -- Match findCanonicalAgent: once a role row exists, an archived role
        -- must not be bypassed by a same-named operator row.
        AND NOT EXISTS (
          SELECT 1
          FROM "Agent" AS role_row
          WHERE role_row."projectId" = candidate."projectId"
            AND role_row."canonicalRole" = 'senior-dev-luna-max'
        )
      )
    )
  ORDER BY CASE WHEN candidate."canonicalRole" = 'senior-dev-luna-max' THEN 0 ELSE 1 END
  LIMIT 1
) AS agent ON true
WHERE profile."taskTemplateId" = template."id"
  AND template."name" IN (
    'compound-engineer-workflow',
    'direct-engineer-workflow',
    'pr-engineer-workflow'
  )
  AND profile."isDefault" = true
  AND profile."mergeTailRepairAgentId" IS NULL;
