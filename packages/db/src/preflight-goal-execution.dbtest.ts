/**
 * The Goal 5a0 preflight against a real PostgreSQL, on both sides of the
 * first-run boundary.
 *
 * The claim under test is not "an empty schema passes". It is that the preflight
 * distinguishes a *declared and confirmed* first run from every other reason the
 * Goal lineage tables might be missing, and that declaring one buys nothing on a
 * target that is not empty. So each case here is a pair: what the operator said,
 * and what the database actually is.
 *
 * Requires a scratch server. It creates and drops its own schemas and never
 * touches an existing one.
 *
 *   AGENTOS_ALLOW_SCRATCH_DATABASES=1 \
 *   TEST_DATABASE_URL=postgresql://...:55777/...?schema=... \
 *     npm run test:db -w @anneal/db
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  censusFromRow,
  type CensusRow,
  censusObjectCount,
  SCHEMA_CENSUS_SQL,
  schemaIsEmpty,
} from "./schema-census.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");
/**
 * The scratch server, proven scratch before anything connects. 5432 is where
 * `docker-compose.yml` puts the operator's local database, and a test that
 * creates and drops schemas has no business finding it.
 */
const scratchServer = (): URL => {
  if (process.env["AGENTOS_ALLOW_SCRATCH_DATABASES"] !== "1") throw new Error("scratch-database-opt-in-required");
  const raw = process.env["TEST_DATABASE_URL"];
  if (!raw) throw new Error("scratch-test-database-url-required");
  const url = new URL(raw);
  if (!url.protocol.startsWith("postgres")) throw new Error("scratch-database-postgresql-required");
  if ((url.port || "5432") === "5432") throw new Error("scratch-database-refuses-port-5432");
  return url;
};

const server = scratchServer();
const token = randomBytes(4).toString("hex");
const schemas: string[] = [];

/** A schema this file owns, named so a leftover is obviously ours. */
const scratchSchema = (name: string): string => {
  const schema = `preflight_${name}_${token}`;
  schemas.push(schema);
  return schema;
};

const urlFor = (schema: string): string => {
  const url = new URL(server.href);
  url.searchParams.set("schema", schema);
  return url.href;
};

interface Outcome { status: number | null; output: string }

const runPreflight = (schema: string, extra: Record<string, string> = {}): Outcome => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "prisma/preflight-goal-execution.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: urlFor(schema),
      ...extra,
    },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const migrateDeploy = (schema: string): Outcome => {
  const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: urlFor(schema) },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

let admin: PrismaClient;
const sql = async (statement: string): Promise<void> => { await admin.$executeRawUnsafe(statement); };
const quoted = (schema: string): string => `"${schema.replaceAll('"', '""')}"`;

const tableCount = async (schema: string): Promise<number> => {
  const rows = await admin.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*)::bigint AS count FROM information_schema.tables WHERE table_schema = $1`,
    schema,
  );
  return Number(rows[0]?.count ?? 0n);
};

before(async () => {
  admin = new PrismaClient({ datasources: { db: { url: server.href } } });
  await admin.$connect();
});

after(async () => {
  for (const schema of schemas) await sql(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`);
  await admin.$disconnect();
});

describe("first run: declared and confirmed empty", () => {
  const schema = scratchSchema("fresh");

  it("passes on a schema that does not exist yet, and says which mode it took", () => {
    const result = runPreflight(schema, { GOAL5A0_FRESH_TARGET: schema });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /preflight mode=first-run target=confirmed-empty/u);
    assert.match(result.output, /preflight PASS/u);
    // Vacuous, and reported as such rather than skipped silently.
    assert.match(result.output, /preflight count goals=0/u);
    assert.match(result.output, /preflight count goalLinkedRuns=0/u);
    assert.match(result.output, /preflight count tasksToBackfill=0/u);
  });

  it("lets the migration it guards actually complete", async () => {
    const deployed = migrateDeploy(schema);
    assert.equal(deployed.status, 0, deployed.output);
    assert.ok(await tableCount(schema) > 0, "migrate deploy created no tables");
  });

  it("then reads the same schema as existing, with no declaration", () => {
    const result = runPreflight(schema);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /preflight mode=existing/u);
    assert.match(result.output, /preflight PASS/u);
  });

  it("refuses the same declaration once the schema is no longer empty", () => {
    const result = runPreflight(schema, { GOAL5A0_FRESH_TARGET: schema });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /STOP preflight fresh-target-not-empty/u);
  });
});

describe("an empty schema nobody declared", () => {
  const schema = scratchSchema("undeclared");

  it("stops, naming the choice instead of the first failing query", async () => {
    await sql(`CREATE SCHEMA IF NOT EXISTS ${quoted(schema)}`);
    const result = runPreflight(schema);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /STOP preflight first-run-undeclared/u);
    assert.match(result.output, new RegExp(`GOAL5A0_FRESH_TARGET=${schema}`, "u"));
    // The regression this fix is about: the stop used to be whichever data
    // query happened to run first.
    assert.doesNotMatch(result.output, /42P01/u);
    assert.doesNotMatch(result.output, /STOP preflight query/u);
    assert.equal(await tableCount(schema), 0, "a stopping preflight created something");
  });
});

describe("a declaration on a target that is not empty", () => {
  const schema = scratchSchema("occupied");

  it("refuses a schema holding one unrelated table", async () => {
    await sql(`CREATE SCHEMA IF NOT EXISTS ${quoted(schema)}`);
    await sql(`CREATE TABLE ${quoted(schema)}.leftover (id text primary key)`);
    const result = runPreflight(schema, { GOAL5A0_FRESH_TARGET: schema });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /STOP preflight fresh-target-not-empty/u);
    assert.doesNotMatch(result.output, /preflight PASS/u);
  });

  it("refuses a declaration naming a different schema than the URL", () => {
    const result = runPreflight(schema, { GOAL5A0_FRESH_TARGET: `${schema}_other` });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /STOP preflight fresh-declaration/u);
  });
});

// ---------------------------------------------------------------------------
// The census boundary, one class at a time.
//
// "Empty" has to mean every schema-scoped class, not the three a table-shaped
// fixture would exercise. Each case below puts exactly one user object into an
// otherwise untouched schema, declares a first run, and requires a stop — and
// the accept case proves the same census still lets an extension-only schema
// through, so this is a boundary rather than a blanket refusal.
// ---------------------------------------------------------------------------

describe("the emptiness census covers every schema-scoped class", () => {
  const REFUSED: Array<[string, string]> = [
    ["table", `CREATE TABLE %S.solo (id text primary key)`],
    ["sequence", `CREATE SEQUENCE %S.solo`],
    ["domain", `CREATE DOMAIN %S.solo AS integer`],
    ["enum", `CREATE TYPE %S.solo AS ENUM ('a')`],
    ["composite-type", `CREATE TYPE %S.solo AS (a integer)`],
    ["function", `CREATE FUNCTION %S.solo() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql`],
    ["collation", `CREATE COLLATION %S.solo (locale = 'C')`],
    ["operator", `CREATE OPERATOR %S.=== (LEFTARG = integer, RIGHTARG = integer, FUNCTION = pg_catalog.int4eq)`],
    ["operator-family", `CREATE OPERATOR FAMILY %S.solo USING btree`],
    ["conversion", `CREATE CONVERSION %S.solo FOR 'UTF8' TO 'LATIN1' FROM utf8_to_iso8859_1`],
    ["text-search-dictionary", `CREATE TEXT SEARCH DICTIONARY %S.solo (TEMPLATE = pg_catalog.simple)`],
    ["text-search-configuration", `CREATE TEXT SEARCH CONFIGURATION %S.solo (COPY = pg_catalog.simple)`],
    ["default-privileges", `ALTER DEFAULT PRIVILEGES IN SCHEMA %S GRANT SELECT ON TABLES TO PUBLIC`],
  ];

  for (const [label, statement] of REFUSED) {
    it(`refuses a schema whose only content is a ${label}`, async () => {
      const schema = scratchSchema(label.replaceAll("-", "_"));
      await sql(`CREATE SCHEMA ${quoted(schema)}`);
      await sql(statement.replaceAll("%S", quoted(schema)));
      const result = runPreflight(schema, { GOAL5A0_FRESH_TARGET: schema });
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.output, /STOP preflight fresh-target-not-empty/u);
      assert.doesNotMatch(result.output, /preflight PASS/u);
      assert.doesNotMatch(result.output, /target=confirmed-empty/u);
    });
  }

  it("still accepts a schema whose only contents are extension-owned", async () => {
    const schema = scratchSchema("extension_only");
    await sql(`CREATE SCHEMA ${quoted(schema)}`);
    // pg_trgm brings operators, operator classes and families, and functions —
    // several of the classes the cases above refuse — all owned by the
    // extension. A fresh install on managed Postgres arrives in exactly this
    // state, so refusing it would refuse the case this whole path exists for.
    await sql(`CREATE EXTENSION pg_trgm WITH SCHEMA ${quoted(schema)}`);
    try {
      const result = runPreflight(schema, { GOAL5A0_FRESH_TARGET: schema });
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /preflight mode=first-run target=confirmed-empty/u);
      assert.match(result.output, /preflight PASS/u);
    } finally {
      await sql(`DROP EXTENSION pg_trgm`);
    }
  });

  it("counts the same objects the release migrator's own census counts", async () => {
    // The two commands must not be able to disagree about one schema. This is
    // the mechanical half of that; the shared module is the other half.
    const schema = scratchSchema("shared_census");
    await sql(`CREATE SCHEMA ${quoted(schema)}`);
    await sql(`CREATE COLLATION ${quoted(schema)}.solo (locale = 'C')`);
    const rows = await admin.$queryRawUnsafe<CensusRow[]>(SCHEMA_CENSUS_SQL, schema);
    const census = censusFromRow(rows[0]);
    assert.ok(census);
    assert.equal(schemaIsEmpty(census), false, "the shared census must see the collation");
    assert.equal(censusObjectCount(census), 1);
  });
});

describe("an existing database keeps every protection", () => {
  const schema = scratchSchema("existing");

  before(async () => {
    const deployed = migrateDeploy(schema);
    assert.equal(deployed.status, 0, deployed.output);
    // The lineage constraints exist to stop this data being written; the
    // conditions exist as backstops for data that arrived some other way, so
    // the disposable fixture drops them to construct exactly that.
    await sql(`ALTER TABLE ${quoted(schema)}."Run" DROP CONSTRAINT IF EXISTS "Run_goal_lineage_all_or_none_check"`);
    const s = quoted(schema);
    // One statement per call: `$executeRawUnsafe` prepares what it is given, and
    // a prepared statement cannot carry several commands.
    for (const statement of [
      `INSERT INTO ${s}."Project"(id,name,slug,"updatedAt") VALUES ('p1','P','p1',now())`,
      `INSERT INTO ${s}."Environment"(id,"projectId",name,"updatedAt") VALUES ('e1','p1','E',now())`,
      `INSERT INTO ${s}."Agent"(id,"projectId","environmentId",name,title,model,"foundationalPrompt","rolePrompt","updatedAt")
         VALUES ('a1','p1','e1','A','T','m','f','r',now())`,
      `INSERT INTO ${s}."Goal"(id,"projectId",title,spec,"updatedAt") VALUES ('g1','p1','G1','S',now()),('g2','p1','G2','S',now())`,
      `INSERT INTO ${s}."Task"(id,"projectId",name,description,"updatedAt") VALUES ('t1','p1','T1','D',now())`,
      `INSERT INTO ${s}."Run"(id,"projectId","taskId","goalId","agentId","runNumber","dedupeKey",runner,model,"promptHash",status,"updatedAt")
         VALUES ('r1','p1','t1','g1','a1',1,'d1','claude','m','h','succeeded',now()),
                ('r2','p1','t1','g2','a1',2,'d2','claude','m','h','succeeded',now())`,
    ]) await sql(statement);
  });

  it("still raises the ambiguous-goal condition", () => {
    const result = runPreflight(schema);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /STOP preflight ambiguous-goal/u);
    assert.match(result.output, /preflight mode=existing/u);
  });

  it("cannot be talked out of it by declaring a first run", () => {
    const result = runPreflight(schema, { GOAL5A0_FRESH_TARGET: schema });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /STOP preflight fresh-target-not-empty/u);
    assert.doesNotMatch(result.output, /preflight PASS/u);
  });
});
