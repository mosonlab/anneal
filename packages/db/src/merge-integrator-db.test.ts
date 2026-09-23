import assert from "node:assert/strict";
import { test } from "node:test";

import { Prisma } from "@prisma/client";

import {
  confirmationCardKey,
  landIntegratorStop,
  latestRecordedStop,
  openStopQuestion,
  parseEvidenceRequest,
  recordIntegratorStop,
  stopQuestionKey,
  type IntegratorStopLandingInput,
} from "./merge-integrator-db.js";

const priorDefaultChatId = process.env["FEISHU_DEFAULT_CHAT_ID"];
process.env["FEISHU_DEFAULT_CHAT_ID"] = "oc_merge_integrator_db_test";
test.after(() => {
  if (priorDefaultChatId === undefined) delete process.env["FEISHU_DEFAULT_CHAT_ID"];
  else process.env["FEISHU_DEFAULT_CHAT_ID"] = priorDefaultChatId;
});

type Activity = {
  id: string;
  taskId: string;
  actorType: string;
  actorId: string | null;
  body: string;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
};

type Question = {
  id: string;
  taskId: string;
  dedupeKey: string;
  kind: string;
  agentId: string | null;
  sessionId: string | null;
  threadId: string | null;
  body: string;
  choices: Prisma.JsonValue;
};

const makeTransaction = (overrides: {
  templateOutputKind?: string;
  sourceRun?: { taskId: string | null; agentId: string; status?: string; session: { id: string } | null } | null;
  activities?: Activity[];
} = {}) => {
  const task = {
    id: "integrator-task",
    assigneeAgentId: "task-agent",
    status: "TODO",
    templateStep: {
      stepIndex: 12,
      outputKind: overrides.templateOutputKind ?? "merge-result",
      taskTemplate: { name: "compound-engineer-workflow" },
    },
  } as any;
  const activities = [...(overrides.activities ?? [])];
  const questions: Question[] = [];
  let activityNumber = activities.length + 1;
  let questionNumber = 1;
  const tx = {
    $queryRaw: async () => [{ id: task.id }],
    task: {
      findUnique: async () => task,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(task, data);
        return task;
      },
    },
    taskActivity: {
      findMany: async () => [...activities].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
      findUnique: async ({ where }: { where: { id: string } }) => activities.find((row) => row.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, any> }) => {
        const row: Activity = {
          id: `activity-${activityNumber++}`,
          taskId: data.taskId,
          actorType: data.actorType,
          actorId: data.actorId ?? null,
          body: data.body,
          metadata: data.metadata,
          createdAt: new Date(2026, 8, 1, 0, 0, activityNumber),
        };
        activities.push(row);
        return row;
      },
    },
    run: {
      findUnique: async () => overrides.sourceRun ?? null,
    },
    inboxMessage: {
      findFirst: async ({ where }: { where: { dedupeKey: string } }) =>
        questions.find((question) => question.dedupeKey === where.dedupeKey) ?? null,
      create: async ({ data }: { data: Record<string, any> }) => {
        const question: Question = {
          id: `question-${questionNumber++}`,
          taskId: data.taskId,
          dedupeKey: data.dedupeKey,
          kind: data.kind,
          agentId: data.agentId,
          sessionId: data.sessionId,
          threadId: data.threadId ?? null,
          body: data.body,
          choices: data.choices,
        };
        questions.push(question);
        return question;
      },
      updateMany: async ({ where, data }: { where: { id: string; threadId: null }; data: { threadId: string } }) => {
        const question = questions.find((candidate) => candidate.id === where.id && candidate.threadId === where.threadId);
        if (question) question.threadId = data.threadId;
        return { count: question ? 1 : 0 };
      },
    },
    inboxThread: {
      findFirst: async () => ({ id: "default-thread", externalChatId: "oc_merge_integrator_db_test" }),
      create: async () => ({ id: "default-thread", externalChatId: "oc_merge_integrator_db_test" }),
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, task, activities, questions };
};

const stopInput = (overrides: Partial<IntegratorStopLandingInput> = {}): IntegratorStopLandingInput => ({
  integratorTaskId: "integrator-task",
  condition: "base-drift-post-merge",
  evidence: "landed commit 8bfa2f08",
  sourceRunId: "source-run",
  ...overrides,
});

test("landing creates one result and one condition-specific question, then adopts the exact activity", async () => {
  const { tx, task, activities, questions } = makeTransaction({
    sourceRun: { taskId: "integrator-task", agentId: "run-agent", session: { id: "run-session" } },
  });

  const landed = await landIntegratorStop(tx, stopInput());
  assert.equal(landed.resultCreated, true);
  assert.equal(landed.questionDeferred, false);
  assert.equal(activities.length, 1);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.dedupeKey, `merge-stop:${landed.stopId}`);
  assert.equal(questions[0]!.kind, "MULTIPLE_CHOICE");
  assert.deepEqual((questions[0]!.choices as Array<{ id: string }>).map((choice) => choice.id), ["accept", "revert"]);
  assert.equal(questions[0]!.agentId, "run-agent");
  assert.equal(questions[0]!.sessionId, "run-session");
  assert.equal(questions[0]!.threadId, "default-thread");
  assert.match(questions[0]!.body, /^推荐：需调查/u);
  assert.equal(task.status, "REVIEW");
  assert.equal(task.failureReason, "Mechanical merge stopped: base-drift-post-merge");

  const replay = await landIntegratorStop(tx, stopInput({
    resultActivityId: landed.stopId,
    condition: "head-drift",
    evidence: "must not replace the recorded evidence",
  }));
  assert.equal(replay.stopId, landed.stopId);
  assert.equal(replay.resultCreated, false);
  assert.equal(activities.length, 1);
  assert.equal(questions.length, 1);
  assert.match(questions[0]!.body, /landed commit 8bfa2f08/u);
});

test("stop questions recommend re-authorization for UNSTABLE failures and DIRTY conflicts", async () => {
  const { tx, questions } = makeTransaction();

  await openStopQuestion(tx, {
    integratorTaskId: "integrator-task",
    stopId: "unstable-stop",
    condition: "check-failure-or-absence",
    evidence: JSON.stringify({
      mergeStateStatus: "UNSTABLE",
      failedChecks: ["ci/build", "lint"],
      reason: "required check ci/build concluded FAILURE",
    }),
    agentId: "run-agent",
    sessionId: "run-session",
  });
  await openStopQuestion(tx, {
    integratorTaskId: "integrator-task",
    stopId: "dirty-stop",
    condition: "non-clean-mergeability",
    evidence: JSON.stringify({
      mergeStateStatus: "DIRTY",
      observed: "b".repeat(40),
      authorized: "a".repeat(40),
    }),
    agentId: "run-agent",
    sessionId: "run-session",
  });

  assert.match(questions[0]!.body, /^推荐：重新授权/u);
  assert.match(questions[0]!.body, /ci\/build、lint/u);
  assert.deepEqual((questions[0]!.choices as Array<{ id: string }>).map(({ id }) => id), ["re-authorize", "abandon"]);
  assert.match((questions[0]!.choices as Array<{ label: string }>)[0]!.label, /（推荐）$/u);
  assert.match(questions[1]!.body, /^推荐：重新授权/u);
  assert.match(questions[1]!.body, /refresh-conflict/u);
  assert.match((questions[1]!.choices as Array<{ label: string }>)[0]!.label, /（推荐）$/u);
});

test("recordIntegratorStop adopts the newest same-source stopped result", async () => {
  const { tx, activities, questions } = makeTransaction({
    sourceRun: { taskId: "integrator-task", agentId: "run-agent", session: { id: "run-session" } },
  });
  const first = await landIntegratorStop(tx, stopInput());
  const replay = await recordIntegratorStop(tx, {
    integratorTaskId: "integrator-task",
    condition: "head-drift",
    evidence: "different completion envelope",
    sourceRunId: "source-run",
  });
  assert.deepEqual(replay, { stopId: first.stopId, questionId: null });
  assert.equal(activities.length, 1);
  assert.equal(questions.length, 1);
  assert.equal((activities[0]!.metadata as Record<string, unknown>).condition, "base-drift-post-merge");
  assert.equal((activities[0]!.metadata as Record<string, unknown>).evidence, "landed commit 8bfa2f08");
});

test("a newer malformed result does not erase or duplicate the newest valid stop", async () => {
  const valid: Activity = {
    id: "valid-stop",
    taskId: "integrator-task",
    actorType: "session",
    actorId: "merge-executor-1",
    body: "stopped",
    metadata: {
      kind: "mergeIntegrator.result",
      schemaVersion: 1,
      outcome: "stopped",
      condition: "base-drift-post-merge",
      evidence: "landed commit 8bfa2f08",
      sourceRunId: "source-run",
    },
    createdAt: new Date(2026, 8, 1, 0, 0, 1),
  };
  const malformed: Activity = {
    ...valid,
    id: "malformed-result",
    metadata: {
      kind: "mergeIntegrator.result",
      schemaVersion: 1,
      outcome: "stopped",
      condition: "base-drift-post-merge",
      sourceRunId: "source-run",
    },
    createdAt: new Date(2026, 8, 1, 0, 0, 2),
  };
  const { tx, activities, questions } = makeTransaction({
    activities: [valid, malformed],
    sourceRun: { taskId: "integrator-task", agentId: "run-agent", session: { id: "run-session" } },
  });

  assert.equal((await latestRecordedStop(tx, "integrator-task"))?.stopId, valid.id);
  const replay = await recordIntegratorStop(tx, {
    integratorTaskId: "integrator-task",
    condition: "base-drift-post-merge",
    evidence: "landed commit 8bfa2f08",
    sourceRunId: "source-run",
  });
  assert.equal(replay.stopId, valid.id);
  assert.equal(activities.length, 2);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.dedupeKey, `merge-stop:${valid.id}`);
});

test("a newer valid merged result intentionally terminates an older stop", async () => {
  const base = {
    taskId: "integrator-task",
    actorType: "session",
    actorId: "merge-executor-1",
    body: "result",
  };
  const { tx } = makeTransaction({ activities: [{
    ...base,
    id: "valid-stop",
    metadata: {
      kind: "mergeIntegrator.result",
      schemaVersion: 1,
      outcome: "stopped",
      condition: "head-drift",
      evidence: "head moved",
      sourceRunId: "source-run-1",
    },
    createdAt: new Date(2026, 8, 1, 0, 0, 1),
  }, {
    ...base,
    id: "valid-merged",
    metadata: {
      kind: "mergeIntegrator.result",
      schemaVersion: 1,
      outcome: "merged",
      mergeCommitSha: "a".repeat(40),
      sourceRunId: "source-run-2",
    },
    createdAt: new Date(2026, 8, 1, 0, 0, 2),
  }] });

  assert.equal(await latestRecordedStop(tx, "integrator-task"), null);
});

test("a terminally answered stop is not reopened by a replay", async () => {
  const { tx, task, activities, questions } = makeTransaction({
    sourceRun: { taskId: "integrator-task", agentId: "run-agent", session: { id: "run-session" } },
  });
  const first = await landIntegratorStop(tx, stopInput());
  task.status = "DONE";
  task.failureReason = null;
  activities.push({
    id: "answer-activity",
    taskId: task.id,
    actorType: "operator",
    actorId: null,
    body: "accept",
    metadata: {
      kind: "mergeIntegrator.stopAnswer",
      schemaVersion: 1,
      stopId: first.stopId,
      condition: "base-drift-post-merge",
      choice: "accept",
      disposition: "terminal-done",
    },
    createdAt: new Date(2026, 8, 1, 0, 1),
  });

  const replay = await landIntegratorStop(tx, stopInput({ resultActivityId: first.stopId }));
  assert.equal(replay.stopId, first.stopId);
  assert.equal(task.status, "DONE");
  assert.equal(task.failureReason, null);
  assert.equal(questions.length, 1);
});

test("question-eligible source Runs must carry a Session", async () => {
  const { tx } = makeTransaction({
    sourceRun: { taskId: "integrator-task", agentId: "run-agent", session: null },
  });
  await assert.rejects(
    landIntegratorStop(tx, stopInput()),
    /has no Session identity/u,
  );
});

test("canonical ordinary base drift lands REVIEW but defers its abandon question", async () => {
  const { tx, task, questions } = makeTransaction({
    sourceRun: { taskId: "integrator-task", agentId: "run-agent", session: { id: "run-session" } },
  });
  const landed = await landIntegratorStop(tx, stopInput({ condition: "base-drift" }));
  assert.equal(landed.questionDeferred, true);
  assert.equal(landed.questionId, null);
  assert.equal(questions.length, 0);
  assert.equal(task.status, "REVIEW");
});

test("canonical ordinary base drift does not publish REVIEW while its source Run is active", async () => {
  const { tx, task, questions } = makeTransaction({
    sourceRun: {
      taskId: "integrator-task",
      agentId: "run-agent",
      status: "RUNNING",
      session: { id: "run-session" },
    },
  });
  const landed = await landIntegratorStop(tx, stopInput({ condition: "base-drift" }));
  assert.equal(landed.questionDeferred, true);
  assert.equal(landed.questionId, null);
  assert.equal(questions.length, 0);
  assert.equal(task.status, "TODO");
  assert.equal(task.failureReason, undefined);
});

test("malformed result metadata never becomes a guard-visible recorded stop", async () => {
  const base = {
    taskId: "integrator-task",
    actorType: "session",
    actorId: "merge-executor-1",
    body: "stopped",
    createdAt: new Date(2026, 8, 1),
  };
  for (const [id, metadata] of [
    ["wrong-schema", {
      kind: "mergeIntegrator.result",
      schemaVersion: 2,
      outcome: "stopped",
      condition: "base-drift-post-merge",
      evidence: "landed commit 8bfa2f08",
      sourceRunId: "source-run",
    }],
    ["missing-evidence", {
      kind: "mergeIntegrator.result",
      schemaVersion: 1,
      outcome: "stopped",
      condition: "base-drift-post-merge",
      sourceRunId: "source-run",
    }],
    ["malformed-source-run", {
      kind: "mergeIntegrator.result",
      schemaVersion: 1,
      outcome: "stopped",
      condition: "base-drift-post-merge",
      evidence: "landed commit 8bfa2f08",
      sourceRunId: 42,
    }],
  ] as const) {
    const { tx } = makeTransaction({
      activities: [{ ...base, id, metadata } as Activity],
    });
    assert.equal(await latestRecordedStop(tx, "integrator-task"), null, id);
  }
});

/**
 * The renewal keys, side by side. A confirmation card is issued once per
 * generation for the same reason a re-validated stop asks its question once per
 * generation, so it carries the same suffix rather than a second mechanism.
 */
test("a confirmation card key keeps generation zero historical and suffixes every renewal", () => {
  assert.equal(confirmationCardKey("task-1", "stop-1"), "confirmation:task-1:stop-1");
  assert.equal(confirmationCardKey("task-1", "stop-1", 0), "confirmation:task-1:stop-1");
  assert.equal(confirmationCardKey("task-1", "stop-1", 1), "confirmation:task-1:stop-1:r1");
  assert.equal(confirmationCardKey("task-1", "stop-1", 2), "confirmation:task-1:stop-1:r2");
  assert.equal(stopQuestionKey("stop-1"), "merge-stop:stop-1");
  assert.equal(stopQuestionKey("stop-1", 1), "merge-stop:stop-1:r1");
});

test("an evidence request retains the source Run that owns the Regression base", () => {
  const parsed = parseEvidenceRequest({
    id: "activity-1",
    taskId: "readiness-task",
    metadata: {
      kind: "mergeIntegrator.evidenceRequest",
      schemaVersion: 1,
      nonce: "nonce-1",
      gateTaskId: "readiness-task",
      integratorTaskId: "integrator-task",
      sourceRunId: "regression-run",
      repository: "acme/widgets",
      prNumber: 42,
      cardId: "card-1",
      purpose: "gate",
    },
  });

  assert.equal(parsed?.sourceRunId, "regression-run");
});
