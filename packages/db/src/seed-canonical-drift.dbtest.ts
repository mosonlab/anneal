/**
 * The seed's exact-graph-or-refuse contract against PostgreSQL.
 *
 * Requires a scratch server. It creates and drops its own schema and never
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
import { after, before, test } from "node:test";

import { PrismaClient } from "@prisma/client";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");

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
const schema = `seed_canonical_drift_${randomBytes(4).toString("hex")}`;
const databaseUrl = (() => {
  const url = new URL(server.href);
  url.searchParams.set("schema", schema);
  return url.href;
})();
const command = (args: string[]) => {
  const result = spawnSync("npx", args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};
const seed = () => command(["tsx", "prisma/seed.ts"]);

let prisma: PrismaClient;

before(async () => {
  const migrated = command(["prisma", "migrate", "deploy"]);
  assert.equal(migrated.status, 0, migrated.output);
  const seeded = seed();
  assert.equal(seeded.status, 0, seeded.output);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
});

after(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({ datasources: { db: { url: server.href } } });
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.$disconnect();
  }
});

test("seed rolls a registered canonical generation over inside its installation transaction", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const outgoing = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
  });
  const steps = await prisma.taskTemplateStep.findMany({
    where: { taskTemplateId: outgoing.id },
    orderBy: { stepIndex: "asc" },
  });
  const revalidation = steps.find((step) => step.outputKind === "revalidation");
  assert.ok(revalidation);
  await prisma.taskTemplateStep.delete({ where: { id: revalidation.id } });
  for (const step of steps.filter((candidate) => candidate.id !== revalidation.id)) {
    await prisma.taskTemplateStep.update({
      where: { id: step.id },
      data: {
        // Historical generations retain their original review labels.
        outputKind: step.outputKind === "review-findings" ? "sol-findings" : step.outputKind,
        name: step.outputKind === "review-findings" ? "Code review (Sol)"
          : step.outputKind === "blind-findings" ? "Code review (Opus blind)" : step.name,
        stepIndex: step.stepIndex - 1,
        layer: (step.layer ?? 0) - 1,
        baseFromStepIndex: step.baseFromStepIndex === null ? null : step.baseFromStepIndex - 1,
        provisionDependencies: true,
        optional: false,
      },
    });
  }
  // The retired seven-step graph still bound its review-fix step to senior-dev-astra-medium.
  const seniorDev = await prisma.agent.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: "senior-dev-astra-medium" } } });
  await prisma.taskTemplateStep.updateMany({
    where: { taskTemplateId: outgoing.id, outputKind: "fixed-implementation" },
    data: { assigneeAgentId: seniorDev.id },
  });

  const rolled = seed();
  assert.equal(rolled.status, 0, rolled.output);

  const legacyName = `direct-engineer-workflow-legacy-pre-revalidate-step-${outgoing.id}`;
  const legacy = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: legacyName } },
  });
  const current = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
  });
  assert.equal(legacy.id, outgoing.id);
  assert.notEqual(current.id, outgoing.id);
  assert.equal(await prisma.taskTemplateStep.count({
    where: { taskTemplateId: current.id, outputKind: "regression-verification-v2" },
  }), 1);
  await prisma.taskTemplate.delete({ where: { id: legacy.id } });
});

/**
 * A half-migrated graph — the zero-gate transition applied to step 1 but not
 * to step 4 — has the current step count and contiguous indexes, yet it is no
 * registered legacy generation. Before the refusal, the step upsert rewrote it
 * into the current shape: no legacy row, no unfinished-task guard, no webhook
 * guard, and an operator's drift silently erased.
 */
test("seed refuses an unregistered same-length drift graph and leaves its rows untouched", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const template = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow" } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const drifted = template.steps.find((step) => step.stepIndex === 1)!;
  await prisma.taskTemplateStep.update({
    where: { id: drifted.id },
    data: { approvalGate: true, prompt: "operator-owned drifted spec prompt" },
  });

  const refused = seed();
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, /Template compound-engineer-workflow \([^)]+\), compound-engineer-workflow step 1 \([^)]+\) differs from the canonical source in approvalGate/u);

  const afterRefusal = await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: drifted.id } });
  assert.equal(afterRefusal.approvalGate, true);
  assert.equal(afterRefusal.prompt, "operator-owned drifted spec prompt");
  const templates = await prisma.taskTemplate.findMany({ where: { projectId: project.id }, select: { name: true } });
  assert.deepEqual(
    templates.map(({ name }) => name).sort(),
    ["compound-engineer-workflow", "direct-engineer-workflow", "pr-engineer-workflow"],
  );

  await prisma.taskTemplateStep.update({
    where: { id: drifted.id },
    data: { approvalGate: drifted.approvalGate, prompt: drifted.prompt },
  });
  const restored = seed();
  assert.equal(restored.status, 0, restored.output);
});
