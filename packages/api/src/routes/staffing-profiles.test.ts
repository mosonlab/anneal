import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import { type PrismaClient } from "@anneal/db";

import { createApp } from "../test-app.js";
import { withTokens } from "./test-support.js";

test("PUT refuses a legacy control-plane assignment with 400 before any mutation", async () => {
  await withTokens(async () => {
    const database = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [{ id: "template-1", projectId: "project-1", name: "Workflow" }],
        staffingProfile: {
          findUnique: async () => ({
            id: "profile-1", projectId: "project-1", taskTemplateId: "template-1", name: "Legacy",
          }),
          update: async () => { assert.fail("refused PUT must not mutate the profile"); },
        },
        staffingProfileEntry: {
          deleteMany: async () => { assert.fail("refused PUT must not delete entries"); },
        },
        taskTemplateStep: {
          findMany: async () => [{
            stepIndex: 6, name: "Merge readiness", outputKind: "merge-authorization",
            assigneeType: "AGENT", assigneeAgentId: "agent-1", optional: false, runner: null,
          }],
        },
        agent: { findMany: async () => [] },
      }),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/staffing-profiles/profile-1", {
      method: "PUT",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Legacy",
        entries: [{ outputKind: "merge-authorization", assigneeAgentId: "agent-1" }],
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      code: "staffing_profile_step_control_plane",
      error: "Step Merge readiness (merge-authorization) is executed by the control plane and staffs no agent; remove its entry from this profile",
      outputKind: "merge-authorization",
    });
  });
});

test("PUT refuses an archived merge-tail repair Agent before profile mutation", async () => {
  await withTokens(async () => {
    const database = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [{ id: "template-1", projectId: "project-1", name: "Workflow" }],
        staffingProfile: {
          findUnique: async () => ({
            id: "profile-1",
            projectId: "project-1",
            taskTemplateId: "template-1",
            name: "Legacy",
            mergeTailRepairAgentId: null,
          }),
          update: async () => { assert.fail("refused PUT must not mutate the profile"); },
        },
        staffingProfileEntry: {
          deleteMany: async () => { assert.fail("refused PUT must not delete entries"); },
        },
        taskTemplateStep: { findMany: async () => [] },
        agent: {
          findMany: async () => [{
            id: "agent-archived",
            name: "senior-dev-luna-max",
            projectId: "project-1",
            archivedAt: new Date(),
            model: "gpt-5.6-luna:max",
            runnerPreference: "CODEX",
          }],
        },
      }),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/staffing-profiles/profile-1", {
      method: "PUT",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Legacy",
        entries: [],
        mergeTailRepairAgentId: "agent-archived",
      }),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      code: "staffing_profile_agent_archived",
      error: "Merge-tail repair Agent senior-dev-luna-max is archived",
    });
  });
});
