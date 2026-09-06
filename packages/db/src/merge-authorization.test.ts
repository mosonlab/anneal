import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import { applyInboxDecision } from "./inbox-decision.js";
import { MergeEvidenceError } from "./merge-authorization.js";

test("Inbox records a structured base refusal after the approval transaction rolls back", async () => {
  const refusal = {
    taskId: "readiness",
    metadata: {
      kind: "gate-attestation-base-mismatch", headSha: "head", attestedBaseSha: "old",
      authorizationBaseSha: "new", channel: "inbox", inboxMessageId: "card",
    },
  };
  const error = new MergeEvidenceError("gate-attestation-base-mismatch: approval refused", refusal);
  const events: string[] = [];
  const db = {
    $transaction: async () => { events.push("rollback"); throw error; },
    taskActivity: { create: async ({ data }: { data: unknown }) => {
      events.push("activity");
      assert.deepEqual(data, { ...refusal, actorType: "control-plane", body: error.message });
    } },
  } as unknown as PrismaClient;
  await assert.rejects(() => applyInboxDecision(db, {
    inboxMessageId: "card", externalEventId: "event", decision: "approve",
  }), (caught: unknown) => caught === error);
  assert.deepEqual(events, ["rollback", "activity"]);
});
