import assert from "node:assert/strict";
import test from "node:test";

import {
  MergeRecoveryRefusalCode,
  MergeRecoveryStatus,
  InboxDeliveryStatus,
  InboxStatus,
  Prisma,
  TaskStatus,
  type MergeRecoveryAttempt,
  type RecoveryContext,
} from "@anneal/db";

import {
  awaitAuthorization,
  blockDownstream,
  ensureRecoveryValidation,
  exhaust,
  reopenAfterHeadAdoption,
  retireLegacyRefusal,
  type RecoveryValidationIdentity,
} from "./merge-tail-state.js";

process.env.FEISHU_DEFAULT_CHAT_ID ??= "api-unit-test-default-chat";

const recovery: RecoveryContext = {
  aggregateId: "aggregate-1",
  attempt: 2,
  sourceStopId: "stop-1",
  sourceRunId: "source-run-1",
  authorizationActivityId: "authorization-1",
  repository: "acme/widgets",
  prNumber: 42,
  targetBranch: "main",
  authorizedHeadSha: "a".repeat(40),
  authorizedBaseSha: "b".repeat(40),
  observedBaseSha: "c".repeat(40),
  currentBaseSha: "d".repeat(40),
  readinessTaskId: "readiness-1",
  regressionTaskId: "regression-1",
  integratorTaskId: "integrator-1",
  recoveryRunId: "recovery-run-1",
};

const stateTx = (
  status: MergeRecoveryStatus,
  failureReason = "head adoption failed",
  casCount = 1,
) => {
  const recoveryUpdates: Array<Record<string, any>> = [];
  const taskUpdates: Array<Record<string, any>> = [];
  const outputDeletes: Array<Record<string, any>> = [];
  const activities: Array<Record<string, any>> = [];
  const notices: Array<Record<string, any>> = [];
  let notice: Record<string, any> | null = null;
  const noticeReopens: Array<Record<string, any>> = [];
  const tx = {
    mergeRecoveryAttempt: {
      findUnique: async (args: Record<string, any>) => (
        args.select?.failureReason ? { failureReason } : { status }
      ),
      update: async (args: Record<string, any>) => {
        recoveryUpdates.push(args);
        return { id: recovery.aggregateId, status: args.data.status };
      },
      updateMany: async (args: Record<string, any>) => {
        recoveryUpdates.push(args);
        return { count: casCount };
      },
      findUniqueOrThrow: async () => ({ id: recovery.aggregateId, status: MergeRecoveryStatus.REPAIRING }),
    },
    task: {
      update: async (args: Record<string, any>) => {
        taskUpdates.push(args);
        return {};
      },
    },
    taskStepOutput: {
      deleteMany: async (args: Record<string, any>) => {
        outputDeletes.push(args);
        return { count: 1 };
      },
    },
    taskActivity: {
      create: async ({ data }: { data: Record<string, any> }) => {
        activities.push(data);
        return data;
      },
    },
    inboxThread: { findFirst: async () => ({ id: "default-thread", externalChatId: "api-unit-test-default-chat" }) },
    inboxMessage: {
      findUnique: async () => notice,
      updateMany: async (args: Record<string, any>) => {
        noticeReopens.push(args);
        if (!notice || notice.status !== args.where.status) return { count: 0 };
        notice = { ...notice, ...args.data };
        return { count: 1 };
      },
      upsert: async (args: Record<string, any>) => {
        notices.push(args);
        notice = notice ? { ...notice, ...args.update } : { status: InboxStatus.OPEN, deliveryStatus: InboxDeliveryStatus.PENDING, ...args.create };
        return notice;
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, recoveryUpdates, taskUpdates, outputDeletes, activities, notices, noticeReopens, get notice() { return notice; } };
};

const legacyAttempt = (overrides: Partial<MergeRecoveryAttempt>): MergeRecoveryAttempt => ({
  id: recovery.aggregateId,
  integratorTaskId: recovery.integratorTaskId,
  sourceStopId: recovery.sourceStopId,
  attempt: recovery.attempt,
  status: MergeRecoveryStatus.FAILED,
  failureReason: "historical refusal wording",
  refusalCode: null,
  boundSourceRunId: null,
  authorizationActivityId: null,
  recoveryRunId: null,
  readinessTaskId: null,
  regressionTaskId: null,
  repository: null,
  prNumber: null,
  targetBranch: null,
  authorizedHeadSha: null,
  authorizedBaseSha: null,
  observedBaseSha: null,
  currentBaseSha: null,
  ...overrides,
} as MergeRecoveryAttempt);

const recoveryValidationIdentity = (): RecoveryValidationIdentity => ({
  sourceRunId: recovery.sourceRunId,
  authorizationActivityId: recovery.authorizationActivityId,
  readinessTaskId: recovery.readinessTaskId,
  regressionTaskId: recovery.regressionTaskId,
  repository: recovery.repository,
  prNumber: recovery.prNumber,
  targetBranch: recovery.targetBranch,
  authorizedHeadSha: recovery.authorizedHeadSha,
  authorizedBaseSha: recovery.authorizedBaseSha,
  observedBaseSha: recovery.observedBaseSha,
});

const ensureLegacyRecoveryValidation = (
  observed: ReturnType<typeof stateTx>,
  legacy: MergeRecoveryAttempt,
): Promise<MergeRecoveryAttempt> => {
  const tx = observed.tx as unknown as {
    mergeRecoveryAttempt: { findFirst: (args: unknown) => Promise<MergeRecoveryAttempt | null> };
  };
  tx.mergeRecoveryAttempt.findFirst = async () => legacy;
  return ensureRecoveryValidation(observed.tx, {
    integratorTaskId: recovery.integratorTaskId,
    sourceStopId: recovery.sourceStopId,
    identity: recoveryValidationIdentity(),
  });
};

test("awaitAuthorization changes only aggregate authority before the activation seam runs", async () => {
  const observed = stateTx(MergeRecoveryStatus.REPAIRING);

  await awaitAuthorization(observed.tx, recovery);

  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.AWAITING_AUTHORIZATION);
  assert.deepEqual(observed.taskUpdates, []);
  assert.deepEqual(observed.activities, []);
});

test("blockDownstream atomically parks all three Tasks and writes its deduped marker", async () => {
  const observed = stateTx(MergeRecoveryStatus.AWAITING_AUTHORIZATION);
  const at = new Date("2026-08-29T12:00:00.000Z");

  await blockDownstream(observed.tx, {
    recovery,
    phase: "readiness",
    reason: "verified head moved",
    at,
  });

  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.BLOCKED_DOWNSTREAM);
  assert.deepEqual(
    observed.taskUpdates.map((update) => [update.where.id, update.data.status]),
    [
      [recovery.regressionTaskId, TaskStatus.REVIEW],
      [recovery.readinessTaskId, TaskStatus.REVIEW],
      [recovery.integratorTaskId, TaskStatus.REVIEW],
    ],
  );
  assert.deepEqual(observed.activities.map((activity) => activity.metadata.state), ["tail-stopped", "tail-stopped"]);
  assert.equal(
    observed.notices[0]?.where.dedupeKey,
    `merge-base-drift-recovery-tail-stop:${recovery.sourceStopId}:readiness:${recovery.recoveryRunId}`,
  );
  assert.equal(observed.notices[0]?.create.threadId, "default-thread");
  assert.match(String(observed.notices[0]?.create.body), /^推荐：需调查/u);
  assert.equal(observed.notices[0]?.update.threadId, "default-thread");
});

test("a later offline stop rearms a closed card but leaves an open delivered card alone", async () => {
  const observed = stateTx(MergeRecoveryStatus.AWAITING_AUTHORIZATION);
  const input = {
    recovery,
    phase: "readiness" as const,
    reason: `${"merge-executor-offline"}: runner unavailable`,
    at: new Date("2026-08-29T12:00:00.000Z"),
  };

  await blockDownstream(observed.tx, input);
  const firstNotice = observed.notice as Record<string, any>;
  firstNotice.status = InboxStatus.CLOSED;
  firstNotice.deliveryStatus = InboxDeliveryStatus.DELIVERED;
  firstNotice.deliveredAt = new Date("2026-08-29T12:01:00.000Z");

  await blockDownstream(observed.tx, input);
  const reopened = observed.notice as Record<string, any>;
  assert.equal(observed.noticeReopens.at(-1)?.where.status, InboxStatus.CLOSED);
  assert.equal(reopened.status, InboxStatus.OPEN);
  assert.equal(reopened.deliveryStatus, InboxDeliveryStatus.PENDING);
  assert.equal(reopened.deliveredAt, null);
  assert.ok(reopened.nextDeliveryAt instanceof Date);
  assert.equal(reopened.threadId, "default-thread");

  reopened.deliveryStatus = InboxDeliveryStatus.DELIVERED;
  const deliveredAt = new Date("2026-08-29T12:02:00.000Z");
  reopened.deliveredAt = deliveredAt;
  await blockDownstream(observed.tx, input);
  assert.equal(reopened.deliveryStatus, InboxDeliveryStatus.DELIVERED);
  assert.equal(reopened.deliveredAt, deliveredAt);
});

test("reopenAfterHeadAdoption takes the declared BLOCKED_DOWNSTREAM reopen edge", async () => {
  const observed = stateTx(MergeRecoveryStatus.BLOCKED_DOWNSTREAM);

  assert.equal(await reopenAfterHeadAdoption(observed.tx, {
    recovery,
    expectedFailureReason: "head adoption failed",
  }), true);

  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.REPAIRING);
  assert.deepEqual(
    observed.taskUpdates.map((update) => [update.where.id, update.data.status]),
    [
      [recovery.regressionTaskId, TaskStatus.DONE],
      [recovery.readinessTaskId, TaskStatus.TODO],
      [recovery.integratorTaskId, TaskStatus.REVIEW],
    ],
  );
  assert.deepEqual(observed.outputDeletes, [{ where: { taskId: recovery.readinessTaskId } }]);
  assert.deepEqual(observed.activities.map((activity) => activity.metadata.state), [
    "reopened-head-adoption",
    "reopened-head-adoption",
  ]);
});

test("reopenAfterHeadAdoption skips a stale full-snapshot CAS without touching Tasks", async () => {
  const observed = stateTx(MergeRecoveryStatus.BLOCKED_DOWNSTREAM, "head adoption failed", 0);

  assert.equal(await reopenAfterHeadAdoption(observed.tx, {
    recovery,
    expectedFailureReason: "head adoption failed",
  }), false);

  assert.equal(observed.recoveryUpdates.length, 1);
  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.REPAIRING);
  assert.equal(observed.recoveryUpdates[0]?.where.AND[1].failureReason, "head adoption failed");
  assert.deepEqual(observed.taskUpdates, []);
  assert.deepEqual(observed.outputDeletes, []);
  assert.deepEqual(observed.activities, []);
});

test("ensureRecoveryValidation owns the declared FAILED legacy reopen edge", async () => {
  const legacy = legacyAttempt({
    failureReason: "historical pre-intent wording changed",
    refusalCode: MergeRecoveryRefusalCode.PRE_INTENT,
  });
  const observed = stateTx(MergeRecoveryStatus.FAILED);

  await ensureLegacyRecoveryValidation(observed, legacy);

  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.VALIDATING);
  assert.equal(observed.recoveryUpdates[0]?.data.refusalCode, null);
  assert.equal(observed.activities[0]?.metadata.state, "legacy-validation-reopened");
});

test("ensureRecoveryValidation reopens the target-branch legacy code regardless of its prose", async () => {
  const legacy = legacyAttempt({
    failureReason: "historical target-branch wording changed",
    refusalCode: MergeRecoveryRefusalCode.TARGET_BRANCH_MISMATCH,
  });
  const observed = stateTx(MergeRecoveryStatus.FAILED);

  await ensureLegacyRecoveryValidation(observed, legacy);

  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.VALIDATING);
  assert.equal(observed.recoveryUpdates[0]?.data.refusalCode, null);
  assert.equal(observed.activities[0]?.metadata.state, "legacy-validation-reopened");
});

test("retireLegacyRefusal clears the durable code after the refusal is settled", async () => {
  const observed = stateTx(MergeRecoveryStatus.FAILED);

  await retireLegacyRefusal(observed.tx, {
    aggregateId: recovery.aggregateId,
    integratorTaskId: recovery.integratorTaskId,
    sourceStopId: recovery.sourceStopId,
    priorReason: "historical target-branch wording changed",
    reason: "target changed again",
    at: new Date("2026-08-29T12:00:00.000Z"),
  });

  assert.equal(observed.recoveryUpdates[0]?.data.refusalCode, null);
});

test("ensureRecoveryValidation does not reopen a prose-only historical refusal", async () => {
  const legacy = legacyAttempt({
    failureReason: "source executor run does not have exactly one server-bound merge intent",
    refusalCode: null,
  });
  const observed = stateTx(MergeRecoveryStatus.FAILED);

  const result = await ensureLegacyRecoveryValidation(observed, legacy);

  assert.equal(result, legacy);
  assert.deepEqual(observed.recoveryUpdates, []);
  assert.deepEqual(observed.activities, []);
});

test("ensureRecoveryValidation fails loudly instead of overwriting conflicting VALIDATING identity", async () => {
  const validating = {
    id: recovery.aggregateId,
    integratorTaskId: recovery.integratorTaskId,
    sourceStopId: recovery.sourceStopId,
    attempt: recovery.attempt,
    status: MergeRecoveryStatus.VALIDATING,
    boundSourceRunId: "different-source-run",
    authorizationActivityId: null,
    recoveryRunId: null,
    readinessTaskId: null,
    regressionTaskId: null,
    repository: null,
    prNumber: null,
    targetBranch: null,
    authorizedHeadSha: null,
    authorizedBaseSha: null,
    observedBaseSha: null,
    currentBaseSha: null,
  } as MergeRecoveryAttempt;
  const observed = stateTx(MergeRecoveryStatus.VALIDATING);
  const tx = observed.tx as unknown as {
    mergeRecoveryAttempt: { findFirst: (args: unknown) => Promise<MergeRecoveryAttempt | null> };
  };
  tx.mergeRecoveryAttempt.findFirst = async () => validating;

  await assert.rejects(ensureRecoveryValidation(observed.tx, {
    integratorTaskId: recovery.integratorTaskId,
    sourceStopId: recovery.sourceStopId,
    identity: {
      sourceRunId: recovery.sourceRunId,
      authorizationActivityId: recovery.authorizationActivityId,
      readinessTaskId: recovery.readinessTaskId,
      regressionTaskId: recovery.regressionTaskId,
      repository: recovery.repository,
      prNumber: recovery.prNumber,
      targetBranch: recovery.targetBranch,
      authorizedHeadSha: recovery.authorizedHeadSha,
      authorizedBaseSha: recovery.authorizedBaseSha,
      observedBaseSha: recovery.observedBaseSha,
    },
  }), /boundSourceRunId conflicts with the validated tail identity/u);

  assert.deepEqual(observed.recoveryUpdates, []);
});

test("exhaust atomically fails validation and parks the integrator", async () => {
  const observed = stateTx(MergeRecoveryStatus.VALIDATING);

  await exhaust(observed.tx, {
    aggregateId: recovery.aggregateId,
    integratorTaskId: recovery.integratorTaskId,
    sourceStopId: recovery.sourceStopId,
    reason: "recovery budget exhausted",
    at: new Date("2026-08-29T12:00:00.000Z"),
    attempt: recovery.attempt,
    state: "exhausted",
    recoveryData: {},
    markerMetadata: {},
  });

  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.FAILED);
  assert.deepEqual(observed.taskUpdates, [{
    where: { id: recovery.integratorTaskId },
    data: { status: TaskStatus.REVIEW, failureReason: "recovery budget exhausted" },
  }]);
  assert.equal(observed.activities[0]?.metadata.state, "exhausted");
  assert.equal(observed.notices.length, 1);
});

test("named migrations reject undeclared recovery edges before Task or marker writes", async () => {
  const observed = stateTx(MergeRecoveryStatus.FAILED);

  await assert.rejects(
    awaitAuthorization(observed.tx, recovery),
    /Illegal merge recovery transition FAILED -> AWAITING_AUTHORIZATION/u,
  );

  assert.deepEqual(observed.recoveryUpdates, []);
  assert.deepEqual(observed.taskUpdates, []);
  assert.deepEqual(observed.activities, []);
});
