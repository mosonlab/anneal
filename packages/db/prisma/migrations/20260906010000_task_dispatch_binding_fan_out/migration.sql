-- A predecessor task accepts several bound successor chains, so a wave that
-- fans out from one delivered chain no longer has to be serialised. Only the
-- uniqueness of the pointer goes away: the binding stays one-way, one hop
-- deep, and project-scoped by the composite foreign key below.

DROP INDEX "Task_dispatchAfterTaskId_key";

-- The composite pointer index survives as a plain lookup index. It is what the
-- completion path and the board's blocked-on projection read the successors of
-- a predecessor through; the foreign key targets "Task"("id", "projectId") and
-- never depended on this index being unique.
DROP INDEX "Task_dispatchAfterTaskId_projectId_key";

CREATE INDEX "Task_dispatchAfterTaskId_projectId_idx"
  ON "Task"("dispatchAfterTaskId", "projectId");
