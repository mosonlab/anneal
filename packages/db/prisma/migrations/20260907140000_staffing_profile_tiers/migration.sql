-- Four independent implementation-tier slots live beside, rather than in,
-- StaffingProfileEntry. An output kind may legally have the same spelling as
-- a tier, so the two key spaces must remain separate.
CREATE TABLE "StaffingProfileTier" (
  "profileId" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,

  CONSTRAINT "StaffingProfileTier_pkey" PRIMARY KEY ("profileId", "tier"),
  CONSTRAINT "StaffingProfileTier_tier_check"
    CHECK ("tier" IN ('default', 'frontend', 'hard', 'hazard'))
);

CREATE INDEX "StaffingProfileTier_agentId_idx"
  ON "StaffingProfileTier"("agentId");

ALTER TABLE "StaffingProfileTier"
  ADD CONSTRAINT "StaffingProfileTier_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "StaffingProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StaffingProfileTier"
  ADD CONSTRAINT "StaffingProfileTier_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing profiles intentionally receive no rows. An absent row is the
-- durable representation of an unstaffed tier; the API expands it to a null
-- value, while Reset explicitly loads the canonical roster.
