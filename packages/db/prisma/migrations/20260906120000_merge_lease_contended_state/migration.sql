-- PostgreSQL permits adding enum labels in a transaction, but it does not
-- permit using a newly added label until that transaction has committed.
-- Keep this migration enum-only; the shape check that names the label is the
-- next migration so Prisma's per-migration transaction cannot see an
-- uncommitted label.
ALTER TYPE "MergeLeaseEventState" ADD VALUE 'contended';
