/**
 * Goal 5a0 lineage export — read-only, deterministic JSONL.
 *
 * Plan Step 3.3. It exists so a Goal's lineage can be archived or compared
 * outside the database without carrying anything sensitive: prompts, outputs,
 * fencing and session tokens, credentials, and secrets are never selected, and
 * the column list below is the allowlist rather than a filter applied afterwards.
 *
 *   DATABASE_URL=...?schema=... npm run db:export-goal-lineage -w @anneal/db -- <output-path>
 *
 * Deterministic: every query is ordered by primary key, the JSON keys are
 * emitted in the order named here, and a repeated export of an unchanged
 * database is byte-identical. It never writes to the database.
 */
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

interface Section { name: string; sql: string }

const SECTIONS: Section[] = [
  {
    name: "goal",
    sql: `SELECT "id", "projectId", "title", "status"::text AS "status", "goalGeneration", "nextGoalIteration",
                 "createdAt", "updatedAt"
          FROM "Goal" ORDER BY "id"`,
  },
  {
    name: "task",
    sql: `SELECT "id", "projectId", "goalId", "goalGeneration", "goalIteration",
                 "goalDispatchKey", "goalDispatchRequestHash", "goalDispatchState"::text AS "goalDispatchState",
                 "goalDecisionKey", "goalDecisionRequestHash", "goalDecisionRunId", "goalDecisionAt",
                 "goalPredecessorTaskId", "status"::text AS "status", "createdAt", "updatedAt"
          FROM "Task" WHERE "goalId" IS NOT NULL ORDER BY "id"`,
  },
  {
    name: "run",
    sql: `SELECT "id", "projectId", "taskId", "agentId", "goalId", "goalGeneration", "goalIteration",
                 "retryOfRunId", "runNumber", "status"::text AS "status", "createdAt", "updatedAt"
          FROM "Run" WHERE "goalId" IS NOT NULL ORDER BY "id"`,
  },
  {
    name: "session",
    sql: `SELECT s."id", s."runId", s."projectId", s."taskId", s."goalId",
                 s."executionStatus"::text AS "executionStatus", s."cleanupStatus"::text AS "cleanupStatus",
                 s."requestedAt", s."startedAt", s."endedAt", s."exitCode"
          FROM "Session" s WHERE s."goalId" IS NOT NULL ORDER BY s."id"`,
  },
  {
    name: "event",
    sql: `SELECT "id", "goalId", "goalGeneration", "goalIteration", "taskId", "runId",
                 "type"::text AS "type", "dedupeKey", "createdAt"
          FROM "GoalExecutionEvent" ORDER BY "id"`,
  },
];

const serialize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  return value;
};

const main = async (): Promise<number> => {
  const rawUrl = process.env.DATABASE_URL;
  const outputPath = process.argv[2];
  if (!rawUrl) {
    console.error("STOP export DATABASE_URL is required");
    return 1;
  }
  if (!outputPath) {
    console.error("STOP export an explicit output path is required");
    return 1;
  }
  if (!new URL(rawUrl).searchParams.get("schema")) {
    console.error("STOP export DATABASE_URL must name the target schema explicitly (?schema=...)");
    return 1;
  }
  if (existsSync(outputPath)) {
    // The export refuses to overwrite, for the same reason the dependency gate's
    // evidence copy does: an archive that silently replaces an older archive is
    // how evidence disappears.
    console.error(`STOP export refusing to overwrite ${outputPath}`);
    return 1;
  }

  const db = new PrismaClient({ datasources: { db: { url: rawUrl } } });
  const lines: string[] = [];
  try {
    for (const section of SECTIONS) {
      const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(section.sql);
      for (const row of rows) {
        const record: Record<string, unknown> = {};
        for (const key of Object.keys(row)) record[key] = serialize(row[key]);
        lines.push(JSON.stringify({ section: section.name, record }));
      }
      console.log(`export ${section.name} ${rows.length}`);
    }
  } finally {
    await db.$disconnect();
  }

  const body = `${lines.join("\n")}\n`;
  writeFileSync(outputPath, body, { flag: "wx" });
  console.log(`export checksum sha256:${createHash("sha256").update(body).digest("hex")}`);
  console.log(`export rows ${lines.length}`);
  return 0;
};

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error(`STOP export ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
