/**
 * PostgreSQL coverage for canonical repair-slot installation and its
 * one-time semantics. This test needs a disposable scratch server:
 *
 *   AGENTOS_ALLOW_SCRATCH_DATABASES=1 \
 *   TEST_DATABASE_URL=postgresql://...:55777/...?schema=... \
 *     npm run test:db -w @anneal/db
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { AssigneeType, PrismaClient, RunnerPreference } from "@prisma/client";

import {
  installCanonicalDefaultStaffingProfiles,
  MERGE_TAIL_REPAIR_AGENT_ROLE,
  MERGE_TAIL_REPAIR_PROFILE_TEMPLATE_NAMES,
} from "./staffing-profile-canonical.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");

const scratchUrl = (): URL => {
  if (process.env["AGENTOS_ALLOW_SCRATCH_DATABASES"] !== "1") throw new Error("scratch-database-opt-in-required");
  const raw = process.env["TEST_DATABASE_URL"];
  if (!raw) throw new Error("scratch-test-database-url-required");
  const url = new URL(raw);
  if (!url.protocol.startsWith("postgres")) throw new Error("scratch-database-postgresql-required");
  if ((url.port || "5432") === "5432") throw new Error("scratch-database-refuses-port-5432");
  return url;
};

const server = scratchUrl();
const schema = `repair_slot_${process.pid}_${randomBytes(4).toString("hex")}`;
const databaseUrl = new URL(server.href);
databaseUrl.searchParams.set("schema", schema);
const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl.href } } });

before(async () => {
  await db.$executeRawUnsafe(`CREATE SCHEMA ${quotedSchema}`);
  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl.href },
    stdio: ["ignore", "pipe", "pipe"],
  });
});

after(async () => {
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
  await db.$disconnect();
});

test("fresh canonical profiles get Luna Max once and preserve a later empty slot", async () => {
  const project = await db.project.create({
    data: { name: "Repair slot fixture", slug: `repair-slot-${Date.now().toString(36)}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", networking: "OPEN", allowedHosts: [] },
  });
  const luna = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      canonicalRole: MERGE_TAIL_REPAIR_AGENT_ROLE,
      name: MERGE_TAIL_REPAIR_AGENT_ROLE,
      title: "Senior Developer",
      model: "gpt-5.6-luna:max",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  for (const name of MERGE_TAIL_REPAIR_PROFILE_TEMPLATE_NAMES) {
    await db.taskTemplate.create({
      data: {
        projectId: project.id,
        name,
        description: "fixture",
        variables: [],
        steps: {
          create: {
            stepIndex: 1,
            name: "Implementation",
            assigneeType: AssigneeType.AGENT,
            assigneeAgentId: luna.id,
            prompt: "work",
            outputKind: "implementation",
            layer: 1,
          },
        },
      },
    });
  }

  await db.$transaction((tx) => installCanonicalDefaultStaffingProfiles(tx, project.id));
  const created = await db.staffingProfile.findMany({
    where: { projectId: project.id },
    orderBy: { taskTemplateId: "asc" },
    select: { mergeTailRepairAgentId: true, isDefault: true },
  });
  assert.equal(created.length, 3);
  assert.ok(created.every((profile) => profile.isDefault && profile.mergeTailRepairAgentId === luna.id));

  const first = await db.staffingProfile.findFirstOrThrow({ where: { projectId: project.id } });
  await db.staffingProfile.update({ where: { id: first.id }, data: { mergeTailRepairAgentId: null } });
  await db.$transaction((tx) => installCanonicalDefaultStaffingProfiles(tx, project.id));
  assert.equal(
    (await db.staffingProfile.findUniqueOrThrow({ where: { id: first.id }, select: { mergeTailRepairAgentId: true } })).mergeTailRepairAgentId,
    null,
  );
  assert.equal(await db.staffingProfile.count({ where: { projectId: project.id } }), 3);
});
