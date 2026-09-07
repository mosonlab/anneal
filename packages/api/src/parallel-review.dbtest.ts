import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { RunStatus, TaskStatus } from "@anneal/db";
import { runDbScript } from "./test-db-script.js";
import { resetTestDb } from "./testdb.js";
import {
  IMPLEMENTATION_BASE,
  IMPLEMENTATION_HEAD,
  installParallelReviewLifecycle,
  SPECIFICATION_BRIEF,
  type Claim,
} from "./parallel-review-fixture.js";

const {
  db,
  claim,
  complete,
  completeImplementation,
  completeReview,
  instantiateDirect,
  instantiateFullAtReviewFrontier,
  operatorRequest,
  queuedRunsFor,
  reviewClaims,
} = installParallelReviewLifecycle();

test("Direct sync instantiates a parallel review frontier claimable by distinct runners with one pinned range", async () => {
  const fixture = await instantiateDirect();
  const implementation = await completeImplementation(fixture);
  assert.deepEqual(implementation.specificationMaterialization, {
    kind: "direct-implementation",
    path: `.chain/${fixture.branchName}/spec.md`,
    body: SPECIFICATION_BRIEF,
  });

  const queued = await queuedRunsFor([fixture.solTaskId, fixture.blindTaskId]);
  assert.equal(queued.length, 2);
  assert.ok(queued.every(({ promptHash }) => promptHash === null));
  const { first, second } = await reviewClaims(fixture);
  assert.notEqual(first.run.id, second.run.id);
  assert.deepEqual(new Set([first.task.chainLayer, second.task.chainLayer]), new Set([2]));
  assert.deepEqual(new Set([first.task.chainIndex, second.task.chainIndex]), new Set([2, 3]));
});

test("the HTTP join stays closed after the first review and creates one fix-step run after the second", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture);
  const { first, second } = await reviewClaims(fixture);
  const firstKind = first.run.taskId === fixture.solTaskId ? "review-findings" : "blind-findings";
  const secondKind = second.run.taskId === fixture.solTaskId ? "review-findings" : "blind-findings";

  await completeReview(first, first.run.taskId === fixture.solTaskId ? "sol-runner" : "blind-runner", firstKind);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 0);
  await completeReview(second, second.run.taskId === fixture.solTaskId ? "sol-runner" : "blind-runner", secondKind);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 1);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId, status: RunStatus.QUEUED } }), 1);
});

test("simultaneous review completions serialize the join to exactly one fix-step run", { timeout: 20_000 }, async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture);
  const { first, second } = await reviewClaims(fixture, "simultaneous-sol", "simultaneous-blind");
  const firstIsSol = first.run.taskId === fixture.solTaskId;
  await Promise.all([
    completeReview(first, firstIsSol ? "simultaneous-sol" : "simultaneous-blind", firstIsSol ? "review-findings" : "blind-findings"),
    completeReview(second, firstIsSol ? "simultaneous-blind" : "simultaneous-sol", firstIsSol ? "blind-findings" : "review-findings"),
  ]);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 1);
});

test("failed, parked, and archived-Agent review siblings fail-stop the join until repaired", async () => {
  for (const mode of ["failed", "parked", "archived-agent"] as const) {
    await resetTestDb(db);
    await runDbScript("seed.ts");
    const fixture = await instantiateDirect();
    const blindBeforeImplementation = fixture.blindTaskId;

    if (mode === "parked") {
      await db.task.update({ where: { id: blindBeforeImplementation }, data: { status: TaskStatus.BACKLOG } });
    } else if (mode === "archived-agent") {
      await db.task.update({ where: { id: blindBeforeImplementation }, data: { status: TaskStatus.BACKLOG } });
      const blindTask = await db.task.findUniqueOrThrow({
        where: { id: blindBeforeImplementation },
        select: { assigneeAgentId: true },
      });
      assert.ok(blindTask.assigneeAgentId);
      // Release seeded profile references before exercising the archive route.
      await db.staffingProfileEntry.updateMany({
        where: { assigneeAgentId: blindTask.assigneeAgentId },
        data: { assigneeAgentId: null },
      });
      const archived = await operatorRequest(`/agents/${blindTask.assigneeAgentId}/archive`, "POST");
      assert.equal(archived.status, 200, JSON.stringify(archived.body));
      // This models an archived assignee already stored on a runnable chain
      // node, which is reachable from pre-protocol data and concurrent control
      // plane repair. Activation must park it rather than enqueueing work.
      await db.task.update({ where: { id: blindBeforeImplementation }, data: { status: TaskStatus.TODO } });
    }

    await completeImplementation(fixture, `${mode}-implementation`);
    const solClaim = await claim(`${mode}-sol`);
    assert.equal(solClaim.run.taskId, fixture.solTaskId);
    await completeReview(solClaim, `${mode}-sol`, "review-findings");
    assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 0, mode);

    let repairedClaim: Claim;
    if (mode === "failed") {
      const blindClaim = await claim("failed-blind");
      assert.equal(blindClaim.run.taskId, fixture.blindTaskId);
      const failed = await complete(blindClaim, "failed-blind", { failed: true });
      assert.equal(failed.status, 200, JSON.stringify(failed.body));
      assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.blindTaskId } })).status, TaskStatus.REVIEW);
      const retry = await operatorRequest(`/tasks/${fixture.blindTaskId}/retry`, "POST");
      assert.equal(retry.status, 201, JSON.stringify(retry.body));
      repairedClaim = await claim("failed-blind-repair");
    } else if (mode === "parked") {
      const started = await operatorRequest(`/tasks/${fixture.blindTaskId}/start`, "POST");
      assert.equal(started.status, 201, JSON.stringify(started.body));
      repairedClaim = await claim("parked-blind-repair");
    } else {
      const blindTask = await db.task.findUniqueOrThrow({
        where: { id: fixture.blindTaskId },
        select: { assigneeAgentId: true, status: true, failureReason: true },
      });
      assert.equal(blindTask.status, TaskStatus.REVIEW);
      const refusalActivity = await db.taskActivity.findFirstOrThrow({
        where: {
          taskId: fixture.blindTaskId,
          metadata: { path: ["refusal"], equals: "assignee-archived" },
        },
        orderBy: { createdAt: "desc" },
      });
      assert.equal((refusalActivity.metadata as Record<string, unknown>).refusal, "assignee-archived");
      assert.match(
        blindTask.failureReason ?? "",
        /assignee code-reviewer-opus-high is archived; unarchive the agent to queue this step/u,
      );
      assert.ok(blindTask.assigneeAgentId);
      const unarchived = await operatorRequest(`/agents/${blindTask.assigneeAgentId}/unarchive`, "POST");
      assert.equal(unarchived.status, 200, JSON.stringify(unarchived.body));
      await db.task.update({ where: { id: fixture.blindTaskId }, data: { status: TaskStatus.BACKLOG } });
      const started = await operatorRequest(`/tasks/${fixture.blindTaskId}/start`, "POST");
      assert.equal(started.status, 201, JSON.stringify(started.body));
      repairedClaim = await claim("archived-agent-blind-repair");
    }

    assert.equal(repairedClaim.run.taskId, fixture.blindTaskId);
    await completeReview(repairedClaim, `${mode}-blind-repair`, "blind-findings");
    assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 1, mode);
    assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId, status: RunStatus.QUEUED } }), 1, mode);
  }
});

test("Full Assurance reaches its layer-6 review pair and one runner can claim both sequentially", async () => {
  const fixture = await instantiateFullAtReviewFrontier();
  await completeImplementation(fixture, "single-runner");
  const { first, second } = await reviewClaims(fixture, "single-runner", "single-runner");
  assert.equal(first.task.chainLayer, 6);
  assert.equal(second.task.chainLayer, 6);
  assert.equal(first.run.implementationBaseSha, IMPLEMENTATION_BASE);
  assert.equal(second.run.implementationHeadSha, IMPLEMENTATION_HEAD);

  const firstIsSol = first.run.taskId === fixture.solTaskId;
  await completeReview(first, "single-runner", firstIsSol ? "review-findings" : "blind-findings");
  assert.equal(await db.run.count({ where: { taskId: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: RunStatus.QUEUED } }), 0);
  await completeReview(second, "single-runner", firstIsSol ? "blind-findings" : "review-findings");
  assert.equal(await db.run.count({ where: { task: { chainId: fixture.chainId, chainIndex: 8 } } }), 1);
});
