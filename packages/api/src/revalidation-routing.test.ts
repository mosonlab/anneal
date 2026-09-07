import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, RepoPermission } from "@anneal/db";
import { applyRevalidationRoute } from "./revalidation-routing.js";
import { composeBrief } from "./task-brief.js";

const harness = (options: {
  unreadable?: boolean; tier?: string; route?: boolean; override?: boolean; running?: boolean;
  empty?: boolean; granted?: boolean; readOnly?: boolean; same?: boolean; profileMissing?: boolean;
} = {}) => {
  const events: string[] = [];
  const activities: Array<{ body: string; metadata: Record<string, unknown> }> = [];
  const task = {
    id: "implementation", projectId: "project", chainId: "chain", templateId: "template", repoId: "repo",
    assigneeAgentId: "previous", assigneeAgent: { id: "previous", name: "Previous Agent" },
    description: options.unreadable ? "unframed legacy text" : composeBrief({ prompt: "Implement.", brief: options.route ? "Build.\nRoute: implementation=previous - operator choice" : "Build.", attachmentsFromPrevious: true, outputKind: "implementation" }),
    templateStep: { priorOutputKinds: ["revalidation"] }, runs: options.running ? [{ id: "run" }] : [],
  };
  const agent = { id: options.same ? "previous" : "judged", name: "Judged Agent", archivedAt: null, projectId: "project" };
  const tx = {
    $queryRaw: async () => { events.push("lock"); return [{ id: "locked" }]; },
    task: {
      findUnique: async () => ({ id: "revalidation", projectId: "project", chainId: "chain", templateId: "template" }),
      findFirst: async (args: { where: { templateStep?: unknown } }) => args.where.templateStep ? task : { id: "revalidation" },
      update: async ({ data }: { data: { assigneeAgentId: string } }) => { events.push("restaff"); task.assigneeAgentId = data.assigneeAgentId; return task; },
    },
    taskActivity: {
      findFirst: async ({ where }: { where: { taskId: string } }) => ({ metadata: where.taskId === "implementation" ? { implementationAssigneeOverride: options.override ? "stepOverrides" : undefined } : options.profileMissing ? {} : { staffingProfileId: "profile" } }),
      create: async ({ data }: { data: typeof activities[number] }) => { events.push("activity"); activities.push(data); },
    },
    staffingProfile: { findFirst: async () => options.empty ? { tiers: [] } : { tiers: [{ tier: options.tier ?? "hard", agent }] } },
    agent: { findUnique: async () => agent },
    agentRepoAccess: {
      count: async ({ where }: { where: { permissions?: string } }) => options.granted === false || (options.readOnly && where.permissions === "GIT_WRITE") ? 0 : 1,
      findFirst: async () => options.readOnly ? null : { permissions: RepoPermission.GIT_WRITE },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, task, activities, events };
};
for (const tier of ["default", "hard", "frontend", "hazard"] as const) {
  test(`judged ${tier} restaffs the implementation and records both Agents`, async () => {
    const h = harness({ tier });
    await applyRevalidationRoute(h.tx, "revalidation", { tier, reason: "criterion applies" });
    assert.equal(h.task.assigneeAgentId, "judged");
    assert.equal(h.activities.length, 1);
    assert.match(h.activities[0]!.body, /criterion applies/);
    assert.match(h.activities[0]!.body, /Previous Agent.*Judged Agent/);
    assert.equal(h.activities[0]!.metadata.tier, tier);
    assert.ok(h.events.indexOf("lock") < h.events.indexOf("restaff"));
  });
}
for (const [label, options, decision] of [
  ["unreadable brief", { unreadable: true }, "brief-unreadable"],
  ["brief Route", { route: true }, "overridden"],
  ["explicit stepOverrides", { override: true }, "overridden"],
  ["empty tier", { empty: true }, "unstaffed"],
  ["no recorded profile", { profileMissing: true }, "unstaffed"],
  ["existing run", { running: true }, "already-running"],
  ["missing grant", { granted: false }, "refused"],
  ["read-only grant", { readOnly: true }, "refused"],
] as const) {
  test(`${label} preserves the implementation Agent and records ${decision}`, async () => {
    const h = harness(options);
    await applyRevalidationRoute(h.tx, "revalidation", { tier: "hard", reason: "criterion" });
    assert.equal(h.task.assigneeAgentId, "previous");
    assert.equal(h.activities.length, 1);
    assert.equal(h.activities[0]!.metadata.decision, decision);
  });
}
test("hazard records application even when the Agent stays the same", async () => {
  const h = harness({ tier: "hazard", same: true });
  await applyRevalidationRoute(h.tx, "revalidation", { tier: "hazard", reason: "transaction boundaries" });
  assert.equal(h.activities[0]!.metadata.decision, "applied");
  assert.equal(h.task.assigneeAgentId, "previous");
});

test("canonical output storage makes the routing decision before persisting the output", async () => {
  const { persistSessionTaskOutput } = await import("./canonical-task-output.js");
  const h = harness();
  const source = { id: "revalidation", projectId: "project", chainId: "chain", chainIndex: 1, chainLayer: 1,
    templateStep: { stepIndex: 1, outputKind: "revalidation", taskTemplateId: "template", taskTemplate: { name: "direct-engineer-workflow" } } };
  Object.assign(h.tx, {
    run: { findFirst: async ({ select }: { select: Record<string, unknown> }) => "taskId" in select ? { taskId: source.id } : { task: source } },
    taskStepOutput: {
      findUnique: async () => null,
      upsert: async ({ create }: { create: Record<string, unknown> }) => { h.events.push("output"); return { id: "output", ...create }; },
    },
  });
  const headSha = "a".repeat(40);
  const result = await persistSessionTaskOutput(h.tx, {
    task: source, fence: { runId: "revalidator-run", fencingToken: "fence", at: new Date() },
    kind: "revalidation", commitSha: headSha,
    body: JSON.stringify({ schemaVersion: 2, headSha, outcome: "unchanged", summary: "Current brief", changedReferences: [], route: { tier: "hard", reason: "criterion" } }),
  });
  assert.equal("ok" in result && result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.events.filter((event) => event !== "lock"), ["restaff", "activity", "output"]);
});
