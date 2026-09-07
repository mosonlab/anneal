import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
} from "@anneal/db";
import {
  BOUND_SPECIFICATION_BRIEF,
  IMPLEMENTATION_BASE,
  installParallelReviewLifecycle,
} from "./parallel-review-fixture.js";

const {
  db,
  claim,
  complete,
  completeImplementation,
  instantiateBoundDirect,
  instantiateDirect,
  operatorRequest,
  request,
  reviewClaims,
  setMaterializedSpecification,
} = installParallelReviewLifecycle();

test("bound revalidation PATCH becomes implementation spec.md authority for both reviews", async () => {
  const fixture = await instantiateBoundDirect();
  const revalidation = await claim("revalidation-runner");
  assert.equal(revalidation.run.taskId, fixture.revalidationTaskId);
  for (const attempted of [
    BOUND_SPECIFICATION_BRIEF.replace("Keep direct-chain intent fixed", "Remove direct-chain revalidation"),
    BOUND_SPECIFICATION_BRIEF.replace("Revalidate oldHandler", "Delete oldHandler"),
    BOUND_SPECIFICATION_BRIEF.replace("Out of scope: compound templates.", "Out of scope: nothing."),
    BOUND_SPECIFICATION_BRIEF.replace("Constraints: existing chains remain unchanged.", "Constraints: compatibility may break."),
    BOUND_SPECIFICATION_BRIEF.replace("Acceptance: bound claims materialize the refreshed brief.", "Acceptance: no verification."),
    BOUND_SPECIFICATION_BRIEF.replace("Route: implementation=senior-dev-astra-medium", "Route: implementation=frontend-dev-opus-medium"),
  ]) {
    const refused = await request(
      `/session/runs/${revalidation.run.id}/task`,
      "PATCH",
      revalidation.sessionToken,
      { fencingToken: revalidation.fencingToken, description: attempted },
    );
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
  }
  const refreshedBrief = BOUND_SPECIFICATION_BRIEF
    .replace("oldRouteName is current behavior", "newRouteName is current behavior")
    .replace("oldHandler", "newHandler");
  const patched = await request(
    `/session/runs/${revalidation.run.id}/task`,
    "PATCH",
    revalidation.sessionToken,
    { fencingToken: revalidation.fencingToken, description: refreshedBrief },
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const implementationDescription = (await db.task.findUniqueOrThrow({
    where: { id: fixture.implementationTaskId },
    select: { description: true },
  })).description;
  assert.match(implementationDescription, new RegExp(refreshedBrief, "u"));
  assert.match(implementationDescription, /Implement this task/u);

  const completedRevalidation = await complete(revalidation, "revalidation-runner", {
    outputKind: "revalidation",
    output: {
      schemaVersion: 2,
      headSha: IMPLEMENTATION_BASE,
      outcome: "updated",
      summary: "Refreshed descriptive route names.",
      changedReferences: ["route names"],
      route: { tier: "default", reason: "the refreshed references remain covered by existing checks" },
    },
    headSha: IMPLEMENTATION_BASE,
    baseSha: IMPLEMENTATION_BASE,
    branch: fixture.branchName,
  });
  assert.equal(completedRevalidation.status, 200, JSON.stringify(completedRevalidation.body));

  const implementation = await completeImplementation(fixture, "bound-implementation-runner");
  assert.deepEqual(implementation.specificationMaterialization, {
    kind: "direct-implementation",
    path: `.chain/${fixture.branchName}/spec.md`,
    body: refreshedBrief,
  });
  setMaterializedSpecification(refreshedBrief);
  const reviews = await reviewClaims(fixture, "bound-sol-runner", "bound-blind-runner");
  assert.notEqual(reviews.first.run.id, reviews.second.run.id);
});

test("a collapsed premise waits in Inbox and an operator choice resumes revalidation", async () => {
  const fixture = await instantiateBoundDirect();
  const revalidation = await claim("premise-collapse-runner");
  assert.equal(revalidation.run.taskId, fixture.revalidationTaskId);
  await db.session.update({
    where: { runId: revalidation.run.id },
    data: { providerConversationId: "premise-collapse-conversation" },
  });
  const choices = [
    { id: "cancel-chain", label: "cancel this chain" },
    { id: "operator-rewrite", label: "operator rewrites the brief, then continue" },
    { id: "proceed-reading", label: "proceed with the step's proposed reading" },
  ];
  const question = await request(
    `/session/runs/${revalidation.run.id}/inbox/questions`,
    "POST",
    revalidation.sessionToken,
    {
      fencingToken: revalidation.fencingToken,
      requestId: "premise-collapse-question",
      body: "The implementation premise is already delivered at current HEAD.",
      choices,
      chatId: "premise-collapse-chat",
    },
  );
  assert.equal(question.status, 201, JSON.stringify(question.body));
  const messageId = (question.body as { id: string }).id;
  const waitingRun = await db.run.findUniqueOrThrow({ where: { id: revalidation.run.id } });
  const waitingSession = await db.session.findUniqueOrThrow({ where: { runId: revalidation.run.id } });
  assert.equal(waitingRun.status, RunStatus.WAITING_INBOX);
  assert.equal(waitingSession.executionStatus, SessionExecutionStatus.WAITING_INBOX);
  assert.equal(waitingSession.waitingOnMessageId, messageId);

  const decision = await operatorRequest(`/inbox/messages/${messageId}/decision`, "POST", {
    requestId: "premise-collapse-decision",
    decision: "operator-rewrite",
  });
  assert.equal(decision.status, 201, JSON.stringify(decision.body));
  const resumedRun = await db.run.findUniqueOrThrow({ where: { id: revalidation.run.id } });
  const resumedSession = await db.session.findUniqueOrThrow({ where: { runId: revalidation.run.id } });
  assert.equal(resumedRun.status, RunStatus.QUEUED);
  assert.equal(resumedSession.executionStatus, SessionExecutionStatus.REQUESTED);
  assert.equal(resumedSession.waitingOnMessageId, null);
  assert.match(resumedSession.resumeInput ?? "", /operator-rewrite/u);
});

test("revalidation cancellation requires the durable cancel-chain decision and parks the chain", async () => {
  const fixture = await instantiateBoundDirect();
  const initial = await claim("premise-cancel-runner");
  assert.equal(initial.run.taskId, fixture.revalidationTaskId);
  const noDecision = await request(
    `/session/runs/${initial.run.id}/revalidation/cancel`,
    "POST",
    initial.sessionToken,
    { fencingToken: initial.fencingToken },
  );
  assert.equal(noDecision.status, 403, JSON.stringify(noDecision.body));
  await db.session.update({
    where: { runId: initial.run.id },
    data: { providerConversationId: "premise-cancel-conversation" },
  });
  const question = await request(
    `/session/runs/${initial.run.id}/inbox/questions`,
    "POST",
    initial.sessionToken,
    {
      fencingToken: initial.fencingToken,
      requestId: "premise-cancel-question",
      body: "The implementation premise is already delivered at current HEAD.",
      choices: [
        { id: "cancel-chain", label: "cancel this chain" },
        { id: "operator-rewrite", label: "operator rewrites the brief, then continue" },
        { id: "proceed-reading", label: "proceed with the step's proposed reading" },
      ],
      chatId: "premise-cancel-chat",
    },
  );
  assert.equal(question.status, 201, JSON.stringify(question.body));
  const openQuestion = await request(
    `/session/runs/${initial.run.id}/revalidation/cancel`,
    "POST",
    initial.sessionToken,
    { fencingToken: initial.fencingToken },
  );
  assert.equal(openQuestion.status, 401, JSON.stringify(openQuestion.body));
  const messageId = (question.body as { id: string }).id;
  const decision = await operatorRequest(`/inbox/messages/${messageId}/decision`, "POST", {
    requestId: "premise-cancel-decision",
    decision: "cancel-chain",
  });
  assert.equal(decision.status, 201, JSON.stringify(decision.body));
  const resumed = await claim("premise-cancel-runner");
  assert.equal(resumed.run.id, initial.run.id);
  const cancelled = await request(
    `/session/runs/${resumed.run.id}/revalidation/cancel`,
    "POST",
    resumed.sessionToken,
    { fencingToken: resumed.fencingToken },
  );
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const run = await db.run.findUniqueOrThrow({ where: { id: resumed.run.id } });
  assert.equal(run.cancelRequestId, `revalidation:${run.id}:cancel`);
  assert.match(run.cancelReason ?? "", /operator selected cancel this chain/u);
  assert.ok(run.cancelRequestedAt);
  assert.ok(run.sessionTokenRevokedAt);
  const activityCount = await db.taskActivity.count({
    where: { metadata: { path: ["requestId"], equals: run.cancelRequestId } },
  });
  const wrongFenceReplay = await request(
    `/session/runs/${resumed.run.id}/revalidation/cancel`,
    "POST",
    resumed.sessionToken,
    { fencingToken: "wrong-replay-fence" },
  );
  assert.equal(wrongFenceReplay.status, 409, JSON.stringify(wrongFenceReplay.body));
  const replay = await request(
    `/session/runs/${resumed.run.id}/revalidation/cancel`,
    "POST",
    resumed.sessionToken,
    { fencingToken: resumed.fencingToken },
  );
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body, cancelled.body);
  assert.equal(await db.taskActivity.count({
    where: { metadata: { path: ["requestId"], equals: run.cancelRequestId } },
  }), activityCount);
  const revokedStatus = await request(
    `/session/runs/${resumed.run.id}/status`,
    "GET",
    resumed.sessionToken,
  );
  assert.equal(revokedStatus.status, 401, JSON.stringify(revokedStatus.body));
  const chainTasks = await db.task.findMany({ where: { chainId: fixture.chainId }, orderBy: { chainIndex: "asc" } });
  assert.equal(chainTasks.length, 8);
  assert.ok(chainTasks.every((task) => task.status === TaskStatus.BACKLOG));
  assert.ok(chainTasks.every((task) => task.failureReason === run.cancelReason));
});

test("revalidation cancellation refuses a non-spec-revalidator session", async () => {
  const ordinary = await instantiateDirect();
  const implementation = await claim("non-revalidator-runner");
  assert.equal(implementation.run.taskId, ordinary.implementationTaskId);
  const denied = await request(
    `/session/runs/${implementation.run.id}/revalidation/cancel`,
    "POST",
    implementation.sessionToken,
    { fencingToken: implementation.fencingToken },
  );
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
});

for (const wrongDecision of ["proceed-reading", "operator-rewrite"] as const) {
  test(`revalidation cancellation rejects an answered ${wrongDecision} decision`, async () => {
    const fixture = await instantiateBoundDirect();
    const initial = await claim(`${wrongDecision}-runner`);
    assert.equal(initial.run.taskId, fixture.revalidationTaskId);
    await db.session.update({
      where: { runId: initial.run.id },
      data: { providerConversationId: `${wrongDecision}-conversation` },
    });
    const question = await request(
      `/session/runs/${initial.run.id}/inbox/questions`,
      "POST",
      initial.sessionToken,
      {
        fencingToken: initial.fencingToken,
        requestId: `${wrongDecision}-question`,
        body: "The premise collapsed.",
        choices: [
          { id: "cancel-chain", label: "cancel this chain" },
          { id: "operator-rewrite", label: "operator rewrites the brief, then continue" },
          { id: "proceed-reading", label: "proceed with the step's proposed reading" },
        ],
        chatId: `${wrongDecision}-chat`,
      },
    );
    assert.equal(question.status, 201, JSON.stringify(question.body));
    const answered = await operatorRequest(
      `/inbox/messages/${(question.body as { id: string }).id}/decision`,
      "POST",
      { requestId: `${wrongDecision}-decision`, decision: wrongDecision },
    );
    assert.equal(answered.status, 201, JSON.stringify(answered.body));
    const resumed = await claim(`${wrongDecision}-runner`);
    const denied = await request(
      `/session/runs/${resumed.run.id}/revalidation/cancel`,
      "POST",
      resumed.sessionToken,
      { fencingToken: resumed.fencingToken },
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal((await db.run.findUniqueOrThrow({ where: { id: resumed.run.id } })).cancelRequestId, null);
  });
}
