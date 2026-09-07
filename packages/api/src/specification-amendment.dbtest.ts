import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { TaskStatus } from "@anneal/db";

import {
  IMPLEMENTATION_BASE,
  IMPLEMENTATION_HEAD,
  installParallelReviewLifecycle,
  SPECIFICATION_BRIEF,
} from "./parallel-review-fixture.js";
import { specificationDigest } from "./specification-fidelity.js";

const {
  db,
  claim,
  complete,
  completeImplementation,
  instantiateDirect,
  operatorRequest,
  request,
  reviewClaims,
  runnerRequest,
  setMaterializedSpecification,
} = installParallelReviewLifecycle();

const AMENDED_BRIEF = "Parallel review specification fixture brief, amended after materialization.";

/** The Run that materialized the Specification of record for this chain. */
const implementationRun = (taskId: string) => db.run.findFirstOrThrow({
  where: { taskId },
  orderBy: { runNumber: "desc" },
  select: { id: true, specificationDigest: true },
});

const amendBrief = async (taskId: string, brief: string): Promise<void> => {
  const amended = await operatorRequest(`/tasks/${taskId}`, "PATCH", { description: brief });
  assert.equal(amended.status, 200, JSON.stringify(amended.body));
};

test("the implementation claim records the digest of the brief it was handed", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "digest-implementation");
  assert.equal(
    (await implementationRun(fixture.implementationTaskId)).specificationDigest,
    specificationDigest(SPECIFICATION_BRIEF),
  );
  // Amending the brief afterwards changes the task, never the record of what
  // the implementer was actually handed.
  await amendBrief(fixture.implementationTaskId, AMENDED_BRIEF);
  assert.equal(
    (await implementationRun(fixture.implementationTaskId)).specificationDigest,
    specificationDigest(SPECIFICATION_BRIEF),
  );
});

test("a resumed implementation claim keeps the digest of the brief it materialized", async () => {
  const fixture = await instantiateDirect();
  const implementation = await claim("resume-implementation");
  assert.equal(implementation.run.taskId, fixture.implementationTaskId);
  await db.session.update({
    where: { runId: implementation.run.id },
    data: { providerConversationId: "resume-conversation" },
  });
  const question = await request(
    `/session/runs/${implementation.run.id}/inbox/questions`,
    "POST",
    implementation.sessionToken,
    {
      fencingToken: implementation.fencingToken,
      requestId: "resume-question",
      body: "Should the brief cover the case the operator just raised?",
      choices: [{ id: "amend", label: "the operator amends the brief, then continue" }],
      chatId: "resume-chat",
    },
  );
  assert.equal(question.status, 201, JSON.stringify(question.body));
  // The operator amends the brief while answering. The runner reuses the
  // workspace on a resume, so `.chain/<branch>/spec.md` keeps the text this Run
  // was originally handed and the digest must keep it too.
  await amendBrief(fixture.implementationTaskId, AMENDED_BRIEF);
  const decision = await operatorRequest(`/inbox/messages/${(question.body as { id: string }).id}/decision`, "POST", {
    requestId: "resume-decision",
    decision: "amend",
  });
  assert.equal(decision.status, 201, JSON.stringify(decision.body));

  const resumed = await claim("resume-implementation");
  assert.equal(resumed.run.id, implementation.run.id);
  assert.ok(resumed.resume);
  assert.equal(
    (await implementationRun(fixture.implementationTaskId)).specificationDigest,
    specificationDigest(SPECIFICATION_BRIEF),
  );

  const completed = await complete(resumed, "resume-implementation", {
    outputKind: "implementation",
    output: {
      schemaVersion: 1,
      headSha: IMPLEMENTATION_HEAD,
      baseSha: IMPLEMENTATION_BASE,
      summary: "resumed implementation keeps the materialized specification",
      testsRun: ["npm test -- parallel review"],
    },
    baseSha: IMPLEMENTATION_BASE,
    branch: fixture.branchName,
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const { first, second } = await reviewClaims(fixture, "resume-sol", "resume-blind");
  for (const claimed of [first, second]) {
    assert.match(claimed.specificationAmendment ?? "", /had its brief amended at /u);
  }
});

test("a brief amended after materialization claims both reviews and tells them the brief moved", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "amended-implementation");
  await amendBrief(fixture.implementationTaskId, AMENDED_BRIEF);

  const { first, second } = await reviewClaims(fixture, "amended-sol", "amended-blind");
  for (const claimed of [first, second]) {
    assert.match(
      claimed.specificationAmendment ?? "",
      new RegExp(`^Task ${fixture.implementationTaskId} had its brief amended at \\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z, after \\.chain/${fixture.branchName}/spec\\.md was materialized:`, "u"),
    );
  }
  assert.equal(await db.task.count({
    where: { id: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: TaskStatus.BACKLOG },
  }), 0);
  assert.equal(await db.inboxMessage.count({ where: { body: { contains: "spec-transcription" } } }), 0);
});

test("an unamended brief leaves the review claim with nothing to say about the specification", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "unamended-implementation");
  const claimed = await claim("unamended-review");
  assert.equal(claimed.specificationAmendment ?? null, null);
});

test("a specification rewritten on the branch is refused and the refusal clears the brief", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "tampered-implementation");
  setMaterializedSpecification("a specification rewritten on the branch");

  const refused = await runnerRequest("/runner/tasks/claim", { runnerId: "tampered-review", leaseSeconds: 120 });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  const body = refused.body as { error: string; reason: string };
  assert.equal(body.reason, "spec-transcription-mismatch");
  assert.match(body.error, /the current task brief still matches that specification/u);
  const parked = await db.task.findFirstOrThrow({
    where: { id: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: TaskStatus.BACKLOG },
  });
  assert.match(parked.failureReason ?? "", /spec-transcription-mismatch/u);
});

test("transcribing an amendment onto the branch is still refused, and the refusal names the amendment", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "both-changed-implementation");
  await amendBrief(fixture.implementationTaskId, AMENDED_BRIEF);
  setMaterializedSpecification(AMENDED_BRIEF);

  const refused = await runnerRequest("/runner/tasks/claim", { runnerId: "both-changed-review", leaseSeconds: 120 });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  const body = refused.body as { error: string; reason: string };
  assert.equal(body.reason, "spec-transcription-mismatch");
  assert.match(body.error, /the current task brief also differs from that specification/u);
  assert.equal(await db.task.count({
    where: { id: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: TaskStatus.BACKLOG },
  }), 1);
});

test("a pinned Run with no recorded digest keeps comparing against the current brief", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "pre-digest-implementation");
  // Runs claimed before `Run.specificationDigest` existed carry none. Until no
  // review step pins such a Run, they behave exactly as they did.
  await db.run.updateMany({
    where: { taskId: fixture.implementationTaskId },
    data: { specificationDigest: null },
  });
  const faithful = await claim("pre-digest-review");
  assert.equal(faithful.specificationAmendment ?? null, null);

  await amendBrief(fixture.implementationTaskId, AMENDED_BRIEF);
  const refused = await runnerRequest("/runner/tasks/claim", { runnerId: "pre-digest-sibling", leaseSeconds: 120 });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  const body = refused.body as { error: string; reason: string };
  assert.equal(body.reason, "spec-transcription-mismatch");
  assert.match(body.error, /does not match the authoritative specification$/u);
});
