/**
 * Goal 5a0 invariant verifier — idempotent, read-only, exits non-zero on any
 * violation.
 *
 * Spec §14 and plan Step 3.2. It is run after the migration, after a rollback
 * rehearsal, and whenever a Goal execution invariant is in doubt. It prints
 * counts and IDs only.
 *
 *   DATABASE_URL=...?schema=... npm run db:verify-goal-execution -w @anneal/db
 */
import { PrismaClient } from "@prisma/client";

interface Check { name: string; sql: string; description: string }

const CHECKS: Check[] = [
  {
    name: "task-partial-lineage",
    description: "a Task whose Goal lineage is neither all null nor all non-null",
    sql: `SELECT "id" FROM "Task"
          WHERE NOT (("goalId" IS NULL AND "goalGeneration" IS NULL AND "goalIteration" IS NULL
                      AND "goalDispatchState" IS NULL)
                  OR ("goalId" IS NOT NULL AND "goalGeneration" IS NOT NULL AND "goalIteration" IS NOT NULL
                      AND "goalDispatchState" IS NOT NULL))`,
  },
  {
    name: "run-tuple-mismatch",
    description: "a Run whose Goal tuple disagrees with its Task",
    sql: `SELECT r."id" FROM "Run" r JOIN "Task" t ON t."id" = r."taskId"
          WHERE r."goalId" IS NOT NULL
            AND (r."goalId" IS DISTINCT FROM t."goalId"
              OR r."goalGeneration" IS DISTINCT FROM t."goalGeneration"
              OR r."goalIteration" IS DISTINCT FROM t."goalIteration")`,
  },
  {
    name: "session-identity-mismatch",
    description: "a Session whose Goal, Task, or project disagrees with its Run",
    sql: `SELECT s."id" FROM "Session" s JOIN "Run" r ON r."id" = s."runId"
          WHERE s."projectId" <> r."projectId"
             OR s."goalId" IS DISTINCT FROM r."goalId"
             OR s."taskId" IS DISTINCT FROM r."taskId"`,
  },
  {
    name: "duplicate-iteration-tuple",
    description: "two Tasks sharing one (goalId, generation, iteration)",
    sql: `SELECT min("id") AS "id" FROM "Task" WHERE "goalId" IS NOT NULL
          GROUP BY "goalId", "goalGeneration", "goalIteration" HAVING count(*) > 1`,
  },
  {
    name: "duplicate-retry-parent",
    description: "two Runs naming the same retry parent",
    sql: `SELECT min("id") AS "id" FROM "Run" WHERE "retryOfRunId" IS NOT NULL
          GROUP BY "retryOfRunId" HAVING count(*) > 1`,
  },
  {
    name: "multiple-open-dispatches",
    description: "spec §14: a Goal with more than one open dispatch",
    sql: `SELECT "goalId" AS "id" FROM "Task"
          WHERE "goalDispatchState" IN ('executing', 'awaiting-decision')
          GROUP BY "goalId" HAVING count(*) > 1`,
  },
  {
    name: "open-dispatch-without-run",
    description: "an executing dispatch with no Run",
    sql: `SELECT t."id" FROM "Task" t
          WHERE t."goalDispatchState" = 'executing'
            AND NOT EXISTS (SELECT 1 FROM "Run" r WHERE r."taskId" = t."id")`,
  },
  {
    name: "predecessor-discontinuity",
    description: "a predecessor in another Goal or generation, or not at the previous iteration",
    sql: `SELECT t."id" FROM "Task" t JOIN "Task" p ON p."id" = t."goalPredecessorTaskId"
          WHERE p."goalId" IS DISTINCT FROM t."goalId"
             OR p."goalGeneration" IS DISTINCT FROM t."goalGeneration"
             OR p."goalIteration" IS DISTINCT FROM t."goalIteration" - 1`,
  },
  {
    name: "event-task-identity-mismatch",
    description: "an event whose identity disagrees with the Task it names",
    sql: `SELECT e."id" FROM "GoalExecutionEvent" e JOIN "Task" t ON t."id" = e."taskId"
          WHERE e."goalId" IS DISTINCT FROM t."goalId"
             OR e."goalGeneration" IS DISTINCT FROM t."goalGeneration"
             OR e."goalIteration" IS DISTINCT FROM t."goalIteration"`,
  },
  {
    name: "event-run-identity-mismatch",
    description: "an event whose identity disagrees with the Run it names",
    sql: `SELECT e."id" FROM "GoalExecutionEvent" e JOIN "Run" r ON r."id" = e."runId"
          WHERE e."goalId" IS DISTINCT FROM r."goalId"
             OR e."goalGeneration" IS DISTINCT FROM r."goalGeneration"
             OR e."goalIteration" IS DISTINCT FROM r."goalIteration"`,
  },
  {
    name: "event-illegal-identity-shape",
    description: "an event naming a Run without a Task, or a Task without an iteration",
    sql: `SELECT "id" FROM "GoalExecutionEvent"
          WHERE ("runId" IS NOT NULL AND "taskId" IS NULL)
             OR ("taskId" IS NOT NULL AND "goalIteration" IS NULL)`,
  },
];

const main = async (): Promise<number> => {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    console.error("STOP verify DATABASE_URL is required");
    return 1;
  }
  const schema = new URL(rawUrl).searchParams.get("schema");
  if (!schema) {
    console.error("STOP verify DATABASE_URL must name the target schema explicitly (?schema=...)");
    return 1;
  }

  const db = new PrismaClient({ datasources: { db: { url: rawUrl } } });
  let violations = 0;
  try {
    for (const check of CHECKS) {
      const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(check.sql);
      if (rows.length === 0) {
        console.log(`verify ${check.name} 0`);
        continue;
      }
      violations += 1;
      console.error(`STOP verify ${check.name} ${rows.length}: ${check.description}: ${rows.slice(0, 20).map((row) => row.id).join(",")}`);
    }
  } catch (error) {
    console.error(`STOP verify ${error instanceof Error ? error.message : String(error)}`);
    violations += 1;
  } finally {
    await db.$disconnect();
  }
  console.log(violations === 0 ? "verify PASS" : `verify STOP (${violations} invariant(s) violated)`);
  return violations === 0 ? 0 : 1;
};

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error(`STOP verify ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
