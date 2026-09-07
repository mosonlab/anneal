import assert from "node:assert/strict";
import test from "node:test";
import { type Prisma } from "@anneal/db";
import { mergeTailRepairAssignee } from "./merge-tail-actions.js";

const input = { projectId: "project", chainId: "chain", templateId: "template", repairKind: "review-fix" as const };
const fixAgent = { id: "fix-agent", name: "fix" };
const repairAgent = { id: "repair-agent", name: "repair", archivedAt: null };
const fixture = (options: { recorded?: string; slot?: typeof repairAgent | null; archived?: boolean; missingProfile?: boolean } = {}) => {
  const profiles: unknown[] = [];
  const activities: Array<{ data: { body: string; taskId: string } }> = [];
  const tx = {
    task: { findFirst: async (query: { where: { templateStep?: unknown } }) => query.where.templateStep
      ? { id: "fix", assigneeAgent: fixAgent }
      : { id: "root" } },
    taskActivity: {
      findFirst: async (query: { where: { taskId: string; actorType: string } }) => {
        assert.equal(query.where.taskId, "root");
        assert.equal(query.where.actorType, "control-plane");
        return options.recorded ? { metadata: { staffingProfileId: options.recorded } } : null;
      },
      create: async (query: typeof activities[number]) => { activities.push(query); },
    },
    staffingProfile: { findFirst: async (query: unknown) => {
      profiles.push(query);
      return options.missingProfile ? null : {
        id: options.recorded ?? "default",
        mergeTailRepairAgent: options.archived ? { ...repairAgent, archivedAt: new Date() } : options.slot ?? null,
      };
    } },
  } as unknown as Prisma.TransactionClient;
  return { tx, profiles, activities };
};

for (const repairKind of ["review-fix", "gate-fix"] as const) {
  test(`${repairKind} uses the recorded profile repair slot`, async () => {
    const observed = fixture({ recorded: "chosen", slot: repairAgent });
    assert.deepEqual(await mergeTailRepairAssignee(observed.tx, { ...input, repairKind }), {
      kind: "agent", agentId: repairAgent.id, label: repairAgent.name,
    });
    assert.deepEqual((observed.profiles[0] as { where: unknown }).where, {
      id: "chosen", projectId: "project", taskTemplateId: "template",
    });
  });
  test(`${repairKind} with an empty slot retains the fix step Agent`, async () => {
    const observed = fixture({ recorded: "chosen" });
    assert.deepEqual(await mergeTailRepairAssignee(observed.tx, { ...input, repairKind }), {
      kind: "agent", agentId: fixAgent.id, label: fixAgent.name,
    });
    assert.equal(observed.profiles.length, 1);
  });
}

test("an unrecorded profile resolves the template default", async () => {
  const observed = fixture({ slot: repairAgent });
  assert.deepEqual(await mergeTailRepairAssignee(observed.tx, input), { kind: "agent", agentId: repairAgent.id, label: repairAgent.name });
  assert.deepEqual((observed.profiles[0] as { where: unknown }).where, {
    projectId: "project", taskTemplateId: "template", isDefault: true,
  });
});

test("a removed recorded profile never substitutes the current default", async () => {
  const observed = fixture({ recorded: "removed", missingProfile: true });
  assert.deepEqual(await mergeTailRepairAssignee(observed.tx, input), { kind: "agent", agentId: fixAgent.id, label: fixAgent.name });
  assert.equal(observed.profiles.length, 1);
});

test("an archived slot Agent falls back and records why on the chain root", async () => {
  const observed = fixture({ recorded: "chosen", archived: true });
  assert.deepEqual(await mergeTailRepairAssignee(observed.tx, input), { kind: "agent", agentId: fixAgent.id, label: fixAgent.name });
  assert.equal(observed.activities[0]?.data.taskId, "root");
  assert.match(observed.activities[0]?.data.body ?? "", /repair-agent.*archived.*fixed-implementation/u);
});

test("refresh-conflict remains bound to the resolver role without looking up profiles", async () => {
  const observed = fixture({ slot: repairAgent });
  assert.deepEqual(await mergeTailRepairAssignee(observed.tx, { ...input, repairKind: "refresh-conflict" }), {
    kind: "role", canonicalRole: "merge-resolver-opus-medium",
  });
  assert.equal(observed.profiles.length, 0);
});
