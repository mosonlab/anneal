import assert from "node:assert/strict";
import test from "node:test";
import {
  AssigneeType,
  CANONICAL_STAFFING_TIER_ROLES,
  type PrismaClient,
  RunnerPreference,
  STAFFING_PROFILE_TIERS,
} from "@anneal/db";
import { replaceStaffingProfile, resetStaffingProfile } from "./staffing-profiles.js";

const fixture = (options: { archived?: boolean; missing?: boolean; implementation?: boolean; hard?: boolean } = {}) => {
  const agent = {
    id: "repair", name: "senior-dev-luna-max", projectId: "project",
    archivedAt: options.archived ? new Date() : null,
    model: "gpt-5.6-luna:max", runnerPreference: RunnerPreference.CODEX,
  };
  const tierAgents = Object.fromEntries(STAFFING_PROFILE_TIERS.map((tier) => [tier, tier === "default" ? agent : {
    id: `agent-${tier}`,
    name: CANONICAL_STAFFING_TIER_ROLES[tier],
    projectId: "project",
    archivedAt: null,
    model: tier === "frontend" ? "claude-opus-5:medium" : "gpt-6-astra:low",
    runnerPreference: tier === "frontend" ? RunnerPreference.CLAUDE : RunnerPreference.CODEX,
  }]));
  const allAgents = [agent, ...Object.values(tierAgents).filter((candidate) => candidate.id !== agent.id)];
  const profile = {
    id: "profile", projectId: "project", taskTemplateId: "template",
    name: "Default", isDefault: true, mergeTailRepairAgentId: agent.id as string | null,
    tiers: [],
    entries: [],
  };
  let entriesWritten = false;
  let savedEntries: unknown[] = [];
  const tierRows: Array<{ profileId: string; tier: string; agentId: string }> = [];
  const entriesForRead = () => savedEntries.map((entry) => {
    const { profileId: _profileId, ...rest } = entry as { profileId?: string; outputKind: string; assigneeAgentId: string | null; include: boolean | null };
    return rest;
  });
  const steps = [
    ...(options.implementation ? [{
      stepIndex: 0, name: "Implementation", outputKind: "implementation",
      optional: false, assigneeType: AssigneeType.AGENT, assigneeAgentId: agent.id, runner: null,
    }] : []),
    ...(options.hard ? [{
      stepIndex: 1, name: "Hard output", outputKind: "hard",
      optional: false, assigneeType: AssigneeType.AGENT, assigneeAgentId: null, runner: null,
    }] : []),
  ];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => query.join("").includes('"TaskTemplate"')
      ? [{ id: "template", projectId: "project", name: "direct-engineer-workflow" }]
      : [agent],
    staffingProfile: {
      findUnique: async () => ({ ...profile, entries: entriesForRead(), tiers: tierRows }),
      findUniqueOrThrow: async () => ({ ...profile, entries: entriesForRead(), tiers: tierRows }),
      update: async ({ data }: { data: Partial<typeof profile> }) => Object.assign(profile, data),
    },
    taskTemplateStep: { findMany: async () => steps },
    taskTemplate: { findUnique: async () => ({ webhookRepoId: null }) },
    agent: {
      findUnique: async (query: { where?: { projectId_canonicalRole?: { canonicalRole?: string } } }) => {
        if (options.missing) return null;
        const role = query.where?.projectId_canonicalRole?.canonicalRole;
        return Object.values(tierAgents).find((candidate) => candidate.name === role)
          ?? (role === agent.name ? agent : null);
      },
      findFirst: async () => null,
      findMany: async () => options.missing ? [] : allAgents,
    },
    repo: { findMany: async () => [{ id: "one", name: "One" }, { id: "two", name: "Two" }] },
    staffingProfileEntry: {
      deleteMany: async () => { entriesWritten = true; },
      createMany: async ({ data }: { data: unknown[] }) => { savedEntries = data; },
    },
    staffingProfileTier: {
      deleteMany: async () => { tierRows.length = 0; },
      createMany: async ({ data }: { data: Array<{ profileId: string; tier: string; agentId: string }> }) => { tierRows.push(...data); },
      findMany: async () => tierRows.map(({ profileId, tier, agentId }) => ({ profileId, tier, agentId })),
    },
  };
  const db = { $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx) } as unknown as PrismaClient;
  return { db, profile, entriesWritten: () => entriesWritten, savedEntries: () => savedEntries };
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
  const observed = fixture({ hard: true });
  const result = await resetStaffingProfile(observed.db, "profile");
  assert.equal(result.profile.mergeTailRepairAgentId, "repair");
  assert.deepEqual(result.profile.tiers, {
    default: "repair",
    frontend: "agent-frontend",
    hard: "agent-hard",
    hazard: "agent-hazard",
  });
  assert.equal(observed.entriesWritten(), true);
  assert.equal(result.warnings[0]?.code, "merge_tail_repair_repo_unresolved");
});

test("PUT persists tier slots independently of exact output-kind entries", async () => {
  const observed = fixture({ hard: true });
  const result = await replaceStaffingProfile(observed.db, "profile", {
    name: "Tiered",
    entries: [{ outputKind: "hard", assigneeAgentId: null }],
    tiers: { default: "repair", frontend: null, hard: "repair", hazard: null },
  });
  assert.deepEqual(result.profile.tiers, {
    default: "repair",
    frontend: null,
    hard: "repair",
    hazard: null,
  });
  assert.deepEqual(result.profile.entries, [{ outputKind: "hard", assigneeAgentId: null, include: null }]);
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

test("reset clears the archived canonical repair Agent's implementation override", async () => {
  const observed = fixture({ archived: true, implementation: true });
  const result = await resetStaffingProfile(observed.db, "profile");
  assert.equal(result.profile.mergeTailRepairAgentId, null);
  assert.deepEqual(observed.savedEntries(), [{
    profileId: "profile", outputKind: "implementation", assigneeAgentId: null, include: null,
  }]);
  assert.equal(result.warnings[0]?.code, "merge_tail_repair_agent_unavailable");
});

test("PUT explicitly naming an archived implementation Agent still refuses", async () => {
  const observed = fixture({ archived: true, implementation: true });
  await assert.rejects(replaceStaffingProfile(observed.db, "profile", {
    name: "Renamed", entries: [{ outputKind: "implementation", assigneeAgentId: "repair" }],
  }), { code: "staffing_profile_agent_archived" });
  assert.equal(observed.entriesWritten(), false);
});
