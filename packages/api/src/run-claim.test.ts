import assert from "node:assert/strict";
import test from "node:test";

import { FailureClass, MERGE_TAIL_KIND, type Prisma, RunStatus, TaskStatus } from "@anneal/db";

import { type QueuedCandidateCondition, queuedCandidateSettlement, settleQueuedCandidate } from "./run-claim-settlement.js";
import type { SpecificationRefusal } from "./specification-fidelity.js";

const refusal: SpecificationRefusal = {
  reason: "spec-transcription-unreadable", classification: "non-transient", detail: "missing spec", message: "Cannot read spec",
};
const marker = {
  kind: MERGE_TAIL_KIND.repairResult, schemaVersion: 1, state: "handoff-invalid",
  runId: "run", previousRunId: "previous", reason: "Invalid handoff",
};
const cases: Array<{ condition: QueuedCandidateCondition; parkTo: string; reason: string; wire: boolean }> = [
  { condition: { kind: "repository-grant-missing" }, parkTo: "BACKLOG", reason: "repository-grant-missing: restore the agent Repo grant, then retry this run", wire: false },
  { condition: { kind: "prior-output-missing", missingKinds: ["plan", "spec"] }, parkTo: "BACKLOG", reason: "Prior output claim refused: missing declared output kinds: plan, spec", wire: true },
  { condition: { kind: "candidate-activation-failed", reason: "Unpublished base", metadata: { unpublishedBaseSha: "sha" } }, parkTo: "BACKLOG", reason: "Unpublished base", wire: false },
  { condition: { kind: "regression-repair-handoff-invalid", reason: "Invalid handoff", previousRunId: "previous", metadata: marker }, parkTo: "REVIEW", reason: "Invalid handoff", wire: false },
  { condition: { kind: "review-claim-refused", refusal }, parkTo: "BACKLOG", reason: refusal.message, wire: false },
  { condition: { kind: "spec-transcription-refused", refusal, implementationHeadSha: "head" }, parkTo: "BACKLOG", reason: refusal.message, wire: false },
  { condition: { kind: "spec-transcription-refused", refusal: { ...refusal, reason: "spec-transcription-mismatch" }, implementationHeadSha: "head" }, parkTo: "BACKLOG", reason: refusal.message, wire: true },
  { condition: { kind: "specification-read-exhausted", refusal, metadata: { budgetMs: 300_000 } }, parkTo: "BACKLOG", reason: refusal.message, wire: false },
];

for (const row of cases) {
  test(`queued settlement maps ${row.condition.kind} (${row.wire ? "wire refusal" : "park"})`, () => {
    const result = queuedCandidateSettlement(row.condition);
    assert.equal(result.parkTo, row.parkTo);
    assert.equal(result.inbox, true);
    assert.equal(result.failureReason, row.reason);
    assert.ok(result.activityBody.length > 0);
    assert.ok(result.inboxBody?.length);
    assert.equal(result.refusal !== undefined, row.wire);
    if (result.refusal) assert.equal(result.refusal.error, row.reason);
    if (row.condition.kind === "regression-repair-handoff-invalid") assert.deepEqual(result.metadata, marker);
    if (row.condition.kind === "prior-output-missing") assert.deepEqual(result.metadata.missingKinds, ["plan", "spec"]);
    if (row.condition.kind === "spec-transcription-refused") assert.equal(result.metadata.implementationHeadSha, "head");
    if (row.condition.kind === "specification-read-exhausted") assert.equal(result.metadata.budgetMs, 300_000);
  });
}

const candidate = { id: "run", leaseGeneration: 4, agentId: "agent", task: { id: "task" } };
const now = new Date("2026-09-07T00:00:00Z");
const transaction = (chainId: string | null, count = 1, absent = false, inboxError = false) => {
  const events: string[] = [];
  const writes: Record<string, unknown> = {};
  const task = { id: "task", projectId: "project", chainId };
  const tx = {
    run: { updateMany: async (input: unknown) => { events.push("run"); writes.run = input; return { count }; } },
    $queryRaw: async (strings: TemplateStringsArray) => {
      events.push(strings.join("?").includes('"chainId" =') ? "chain-lock" : "task-lock");
      return [{ id: "task" }];
    },
    task: {
      findUnique: async () => absent ? null : task,
      findUniqueOrThrow: async () => task,
      update: async (input: unknown) => { events.push("park"); writes.task = input; return task; },
    },
    taskActivity: { create: async (input: unknown) => { events.push("activity"); writes.activity = input; return { id: "activity" }; } },
    session: { findUnique: async () => ({ id: "source-session" }) },
    inboxMessage: { upsert: async (input: unknown) => {
      if (inboxError) throw new Error("Inbox unavailable");
      events.push("inbox"); writes.inbox = input;
    } },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, events, writes };
};

for (const chainId of [null, "chain"]) {
  for (const row of cases) {
    test(`settlement ${row.condition.kind} ${row.wire} ends safely with chain=${chainId}`, async () => {
      const { tx, events, writes } = transaction(chainId);
      const decision = await settleQueuedCandidate(tx, candidate, row.condition, now);
      assert.deepEqual(decision, queuedCandidateSettlement(row.condition).refusal ?? { outcome: chainId ? "halt" : "skip" });
      assert.deepEqual(events, ["run", chainId ? "chain-lock" : "task-lock", "park", "activity", "inbox"]);
      assert.deepEqual(writes.run, {
        where: { id: "run", status: RunStatus.QUEUED, leaseGeneration: 4 },
        data: { status: RunStatus.FAILED, failureClass: FailureClass.TASK_FAILED, failureReason: row.reason, retryable: false, endedAt: now },
      });
      assert.deepEqual(writes.task, { where: { id: "task" }, data: { status: row.parkTo === "REVIEW" ? TaskStatus.REVIEW : TaskStatus.BACKLOG, failureReason: row.reason } });
      const inbox = writes.inbox as { create: { sessionId?: string; dedupeKey: string } };
      if (row.condition.kind === "regression-repair-handoff-invalid") {
        assert.equal(inbox.create.sessionId, "source-session");
        assert.match(inbox.create.dedupeKey, /^merge-tail-stop:task:/);
      } else {
        assert.equal(inbox.create.dedupeKey, `${queuedCandidateSettlement(row.condition).metadata.condition}:run`);
      }
    });
  }
}

test("a lost queued-Run CAS does not park or notify", async () => {
  const { tx, events } = transaction("chain", 0);
  assert.deepEqual(await settleQueuedCandidate(tx, candidate, { kind: "repository-grant-missing" }, now), { outcome: "skip" });
  assert.deepEqual(events, ["run"]);
});

test("failed Task parking and Inbox writes fail loudly", async () => {
  await assert.rejects(settleQueuedCandidate(transaction("chain", 1, true).tx, candidate, { kind: "repository-grant-missing" }, now), /could not park/);
  await assert.rejects(settleQueuedCandidate(transaction(null, 1, false, true).tx, candidate, { kind: "repository-grant-missing" }, now), /Inbox unavailable/);
});
