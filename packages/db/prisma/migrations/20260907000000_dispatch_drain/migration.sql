-- The platform-wide dispatch drain an over-budget auto-deploy opens so its
-- quiet window can arrive. The table is empty except while such a deploy is
-- waiting: the deploy that inserted a row deletes it on every exit path, and
-- "expiresAt" bounds the row a dead deploy process left behind.
CREATE TABLE "DispatchDrain" (
  "id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DispatchDrain_pkey" PRIMARY KEY ("id")
);
