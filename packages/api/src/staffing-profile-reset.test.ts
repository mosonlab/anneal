import assert from "node:assert/strict";
import test from "node:test";
import { type PrismaClient, RunnerPreference } from "@anneal/db";
import { replaceStaffingProfile, resetStaffingProfile } from "./staffing-profiles.js";

const fixture = (options: { archived?: boolean; missing?: boolean } = {}) => {
  const agent = {
    id: "repair", name: "senior-dev-luna-max", projectId: "project",
    archivedAt: options.archived ? new Date() : null,
    model: "gpt-5.6-luna:max", runnerPreference: RunnerPreference.CODEX,
  };
  const profile = {
    id: "profile", projectId: "project", taskTemplateId: "template",
    name: "Default", isDefault: true, mergeTailRepairAgentId: agent.id as string | null,
  };
  let entriesWritten = false;
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => query.join("").includes('"TaskTemplate"')
      ? [{ id: "template", projectId: "project", name: "direct-engineer-workflow" }]
      : [agent],
    staffingProfile: {
      findUnique: async () => profile,
      findUniqueOrThrow: async () => profile,
      update: async ({ data }: { data: Partial<typeof profile> }) => Object.assign(profile, data),
    },
    taskTemplateStep: { findMany: async () => [] },
    taskTemplate: { findUnique: async () => ({ webhookRepoId: null }) },
    agent: {
      findUnique: async () => options.missing ? null : agent,
      findFirst: async () => null,
      findMany: async () => options.missing ? [] : [agent],
    },
    repo: { findMany: async () => [{ id: "one", name: "One" }, { id: "two", name: "Two" }] },
    staffingProfileEntry: { deleteMany: async () => { entriesWritten = true; } },
  };
  const db = { $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx) } as unknown as PrismaClient;
  return { db, profile, entriesWritten: () => entriesWritten };
};

test("PUT omitting an archived slot preserves it and replaces entries", async () => {
  const observed = fixture({ archived: true });
  const result = await replaceStaffingProfile(observed.db, "profile", { name: "Renamed", entries: [] });
  assert.equal(result.profile.mergeTailRepairAgentId, "repair");
  assert.equal(result.profile.name, "Renamed");
  assert.equal(observed.entriesWritten(), true);
});

test("PUT explicitly naming an archived slot still refuses", async () => {
  const observed = fixture({ archived: true });
  await assert.rejects(replaceStaffingProfile(observed.db, "profile", {
    name: "Renamed", entries: [], mergeTailRepairAgentId: "repair",
  }), { code: "staffing_profile_agent_archived" });
  assert.equal(observed.entriesWritten(), false);
});

test("reset without a Repo in a multi-Repo project restores the canonical slot with a warning", async () => {
  const observed = fixture();
  const result = await resetStaffingProfile(observed.db, "profile");
  assert.equal(result.profile.mergeTailRepairAgentId, "repair");
  assert.equal(observed.entriesWritten(), true);
  assert.equal(result.warnings[0]?.code, "merge_tail_repair_repo_unresolved");
});

for (const state of ["archived", "missing"] as const) {
  test(`reset with a ${state} canonical Agent restores entries and clears the slot with a warning`, async () => {
    const observed = fixture({ [state]: true });
    const result = await resetStaffingProfile(observed.db, "profile");
    assert.equal(result.profile.mergeTailRepairAgentId, null);
    assert.equal(observed.entriesWritten(), true);
    assert.equal(result.warnings[0]?.code, "merge_tail_repair_agent_unavailable");
  });
}
