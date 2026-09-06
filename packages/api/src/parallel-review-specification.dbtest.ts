import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INTEGRATOR_TEMPLATE_NAME,
  RunStatus,
  TaskStatus,
  templateRolloverName,
} from "@anneal/db";
import { runDbScript } from "./test-db-script.js";
import { resetTestDb } from "./testdb.js";
import {
  installParallelReviewLifecycle,
  RUNNER_TOKEN,
  SPECIFICATION_BRIEF,
  type Claim,
} from "./parallel-review-fixture.js";
import { createApp } from "./test-app.js";
import { GitHubReadError } from "./github-read.js";
import { instantiateTemplate } from "./templates.js";

const {
  db,
  claim,
  completeImplementation,
  instantiateDirect,
  instantiateFullAtReviewFrontier,
  operatorRequest,
  runnerRequest,
  setMaterializedSpecification,
  specificationReads,
} = installParallelReviewLifecycle();

test("a faithful direct brief ending in the prior-output reminder remains claimable", async () => {
  const brief = "Preserve this exact ending.\nRead the prior template steps' persisted outputs before working.";
  setMaterializedSpecification(brief);
  const fixture = await instantiateDirect(brief);
  await completeImplementation(fixture, "reminder-implementation");
  const reviewed = await claim("reminder-review");
  assert.ok([fixture.solTaskId, fixture.blindTaskId].includes(reviewed.run.taskId));
});

test("a faithful direct spec with one conventional final newline remains claimable", async () => {
  const brief = "Preserve this exact ending without a final newline.";
  setMaterializedSpecification(`${brief}\n`);
  const fixture = await instantiateDirect(brief);
  await completeImplementation(fixture, "final-newline-implementation");
  const reviewed = await claim("final-newline-review");
  assert.ok([fixture.solTaskId, fixture.blindTaskId].includes(reviewed.run.taskId));
});

test("a transient specification read failure retries and claims without parking", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "transient-read-implementation");
  let reads = 0;
  const response = await createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        reads += 1;
        if (reads === 1) throw new GitHubReadError("TLS handshake eof", "transport");
        return new TextEncoder().encode(SPECIFICATION_BRIEF);
      },
    },
  }).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "transient-read-review", leaseSeconds: 120 }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  assert.equal(reads, 2);
  assert.equal(await db.run.count({
    where: { taskId: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: RunStatus.FAILED },
  }), 0);
  assert.equal(await db.task.count({
    where: { id: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: TaskStatus.BACKLOG },
  }), 0);
  assert.equal(await db.inboxMessage.count({
    where: { body: { contains: "spec-transcription" } },
  }), 0);
});

test("persistent transient specification reads defer observably and a later poll claims without operator action", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "persistent-read-implementation");
  let reads = 0;
  let unavailable = true;
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        reads += 1;
        if (unavailable) throw new GitHubReadError(`proxy flap ${reads}`, "transport");
        return new TextEncoder().encode(SPECIFICATION_BRIEF);
      },
    },
  });
  const poll = (runnerId: string) => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId, leaseSeconds: 120 }),
  });
  const deferredResponse = await poll("persistent-read-review");
  assert.equal(deferredResponse.status, 204, await deferredResponse.text());
  assert.equal(reads, 3);

  const deferral = await db.taskActivity.findFirstOrThrow({
    where: {
      taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
      metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
    },
    select: { taskId: true, metadata: true },
  });
  const evidence = deferral.metadata as Record<string, unknown>;
  assert.equal(evidence.classification, "transient");
  assert.equal(evidence.attempt, 1);
  assert.equal(evidence.runId === undefined, false);
  assert.equal(typeof evidence.nextAttemptAt, "string");
  assert.match(String(evidence.lastUnderlyingError), /last failure: proxy flap 3/u);

  const deferredRun = await db.run.findFirstOrThrow({
    where: { taskId: deferral.taskId, status: RunStatus.QUEUED },
  });
  assert.ok(deferredRun.readyAt.getTime() > deferredRun.createdAt.getTime());
  assert.equal(deferredRun.leaseGeneration, 0);
  assert.equal(deferredRun.runnerId, null);
  assert.equal(deferredRun.fencingToken, null);
  assert.equal(await db.session.count({ where: { runId: deferredRun.id } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: deferral.taskId } })).status, TaskStatus.TODO);
  assert.equal(await db.inboxMessage.count({ where: { taskId: deferral.taskId } }), 0);

  unavailable = false;
  await db.run.update({ where: { id: deferredRun.id }, data: { readyAt: new Date(0) } });
  const claimedResponse = await poll("recovered-read-review");
  const claimedText = await claimedResponse.text();
  assert.equal(claimedResponse.status, 200, claimedText);
  assert.equal((JSON.parse(claimedText) as Claim).run.id, deferredRun.id);
  assert.equal(reads, 4);
});

test("transient specification read deferrals follow the backoff schedule and clamp to the budget deadline", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "backoff-read-implementation");
  let reads = 0;
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        reads += 1;
        throw new GitHubReadError(`proxy flap ${reads}`, "transport");
      },
    },
  });
  const poll = () => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "backoff-read-review", leaseSeconds: 120 }),
  });

  assert.equal((await poll()).status, 204);
  const first = await db.taskActivity.findFirstOrThrow({
    where: { metadata: { path: ["condition"], equals: "specification-read-claim-deferred" } },
    select: { id: true, taskId: true, metadata: true },
  });
  const runId = String((first.metadata as Record<string, unknown>).runId);
  await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
  assert.equal((await poll()).status, 204);

  let deferrals = await db.taskActivity.findMany({
    where: {
      taskId: first.taskId,
      metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
    },
    select: { id: true, metadata: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(deferrals.map(({ metadata }) => {
    const evidence = metadata as Record<string, unknown>;
    return [evidence.attempt, evidence.delayMs];
  }), [[1, 15_000], [2, 30_000]]);

  await db.taskActivity.update({
    where: { id: deferrals[0]!.id },
    data: { createdAt: new Date(Date.now() - 299_000) },
  });
  await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
  assert.equal((await poll()).status, 204);
  deferrals = await db.taskActivity.findMany({
    where: {
      taskId: first.taskId,
      metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
    },
    select: { id: true, metadata: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const third = deferrals.map(({ metadata }) => metadata as Record<string, unknown>)
    .find((evidence) => evidence.attempt === 3);
  assert.ok(third);
  assert.equal(third.delayMs, 60_000);
  assert.equal(third.nextAttemptAt, third.budgetDeadlineAt);
  assert.equal(reads, 9);
});

test("a resumed run starts a fresh transient specification read budget", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "resumed-read-implementation");
  let reads = 0;
  let unavailable = true;
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        reads += 1;
        if (unavailable) throw new GitHubReadError(`proxy flap ${reads}`, "transport");
        return new TextEncoder().encode(SPECIFICATION_BRIEF);
      },
    },
  });
  const poll = () => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "resumed-read-review", leaseSeconds: 120 }),
  });

  assert.equal((await poll()).status, 204);
  const staleDeferral = await db.taskActivity.findFirstOrThrow({
    where: { metadata: { path: ["condition"], equals: "specification-read-claim-deferred" } },
    select: { id: true, taskId: true, metadata: true },
  });
  const runId = String((staleDeferral.metadata as Record<string, unknown>).runId);
  unavailable = false;
  await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
  const firstClaim = await poll();
  const firstClaimText = await firstClaim.text();
  assert.equal(firstClaim.status, 200, firstClaimText);
  assert.equal((JSON.parse(firstClaimText) as Claim).run.id, runId);
  await db.taskActivity.update({
    where: { id: staleDeferral.id },
    data: { createdAt: new Date(Date.now() - 6 * 60_000) },
  });
  await db.run.update({
    where: { id: runId },
    data: {
      status: RunStatus.QUEUED,
      readyAt: new Date(0),
      runnerId: null,
      fencingToken: null,
      leaseExpiresAt: null,
    },
  });
  unavailable = true;

  assert.equal((await poll()).status, 204);
  const resumed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(resumed.status, RunStatus.QUEUED);
  const currentEpisode = await db.taskActivity.findMany({
    where: {
      taskId: staleDeferral.taskId,
      createdAt: { gt: resumed.claimedAt! },
      metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
    },
    select: { metadata: true },
  });
  assert.equal(currentEpisode.length, 1);
  assert.equal((currentEpisode[0]!.metadata as Record<string, unknown>).attempt, 1);
  assert.equal(reads, 7);
});

test("an expired transient specification read budget fails even if the repository read recovered", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "exhausted-read-implementation");
  let reads = 0;
  let unavailable = true;
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        reads += 1;
        if (unavailable) throw new GitHubReadError(`proxy flap ${reads}`, "transport");
        return new TextEncoder().encode(SPECIFICATION_BRIEF);
      },
    },
  });
  const poll = () => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "exhausted-read-review", leaseSeconds: 120 }),
  });
  const first = await poll();
  assert.equal(first.status, 204, await first.text());
  const deferral = await db.taskActivity.findFirstOrThrow({
    where: { metadata: { path: ["condition"], equals: "specification-read-claim-deferred" } },
    select: { id: true, taskId: true, metadata: true },
  });
  const runId = String((deferral.metadata as Record<string, unknown>).runId);
  await db.taskActivity.update({
    where: { id: deferral.id },
    data: { createdAt: new Date(Date.now() - 6 * 60_000) },
  });
  await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
  await db.run.updateMany({
    where: {
      taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
      id: { not: runId },
      status: RunStatus.QUEUED,
    },
    data: { readyAt: new Date(Date.now() + 60_000) },
  });
  unavailable = false;

  const exhausted = await poll();
  assert.equal(exhausted.status, 204, await exhausted.text());
  assert.equal(reads, 3);
  const failed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(failed.status, RunStatus.FAILED);
  assert.equal(failed.retryable, false);
  assert.match(
    failed.failureReason ?? "",
    /transient read deferral budget exhausted after \d+ms \(budget 300000ms\)/u,
  );
  assert.match(failed.failureReason ?? "", /last failure: proxy flap 3/u);
  assert.equal((failed.failureReason?.match(/Spec transcription claim refused/gu) ?? []).length, 1);
  assert.equal(failed.leaseGeneration, 0);
  assert.equal(failed.runnerId, null);
  assert.equal(failed.fencingToken, null);
  assert.equal(await db.session.count({ where: { runId } }), 0);
  const task = await db.task.findUniqueOrThrow({ where: { id: deferral.taskId } });
  assert.equal(task.status, TaskStatus.BACKLOG);
  assert.equal(task.failureReason, failed.failureReason);
  const settlement = await db.taskActivity.findFirstOrThrow({
    where: {
      taskId: deferral.taskId,
      metadata: { path: ["exhaustedCondition"], equals: "specification-read-claim-deferred" },
    },
  });
  assert.equal((settlement.metadata as Record<string, unknown>).classification, "transient");
  assert.equal((settlement.metadata as Record<string, unknown>).transientCause, "other");
  assert.equal((settlement.metadata as Record<string, unknown>).budgetMs, 5 * 60_000);
  assert.equal(await db.inboxMessage.count({
    where: { dedupeKey: `spec-transcription-unreadable:${runId}` },
  }), 1);
  // A non-timeout transient never earns the extended window or its notice.
  assert.equal(await db.inboxMessage.count({
    where: { dedupeKey: `specification-read-deadline-extended:${deferral.taskId}` },
  }), 0);
});

test("a specification read that only ever misses its deadline defers past five minutes and parks at the timeout ceiling", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "deadline-read-implementation");
  const app = createApp(db, {
    specificationReader: {
      // Exactly what the per-attempt deadline produces when the host is merely
      // slow: a transient failure of kind `timeout`, without the real wait.
      readFileAtCommit: async () => {
        throw new GitHubReadError("repository content read exceeded the 6000ms server deadline", "timeout");
      },
    },
  });
  const poll = () => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "deadline-read-review", leaseSeconds: 120 }),
  });
  assert.equal((await poll()).status, 204);
  const firstDeferral = await db.taskActivity.findFirstOrThrow({
    where: { metadata: { path: ["condition"], equals: "specification-read-claim-deferred" } },
    select: { id: true, taskId: true, metadata: true },
  });
  assert.equal((firstDeferral.metadata as Record<string, unknown>).transientCause, "timeout");
  const runId = String((firstDeferral.metadata as Record<string, unknown>).runId);
  const extendedKey = `specification-read-deadline-extended:${firstDeferral.taskId}`;
  const reopen = async (budgetAgeMs: number) => {
    await db.taskActivity.update({
      where: { id: firstDeferral.id },
      data: { createdAt: new Date(Date.now() - budgetAgeMs) },
    });
    await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
    await db.run.updateMany({
      where: {
        taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
        id: { not: runId },
        status: RunStatus.QUEUED,
      },
      data: { readyAt: new Date(Date.now() + 60_000) },
    });
  };

  // Past the ordinary five-minute budget the task keeps deferring, and the
  // extension announces itself exactly once however many deferrals follow.
  await reopen(6 * 60_000);
  assert.equal((await poll()).status, 204);
  const stillQueued = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(stillQueued.status, RunStatus.QUEUED);
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: firstDeferral.taskId } })).status !== TaskStatus.BACKLOG,
    true,
  );
  assert.equal(await db.inboxMessage.count({ where: { dedupeKey: extendedKey } }), 1);
  await reopen(10 * 60_000);
  assert.equal((await poll()).status, 204);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).status, RunStatus.QUEUED);
  assert.equal(await db.inboxMessage.count({ where: { dedupeKey: extendedKey } }), 1);

  await reopen(31 * 60_000);
  assert.equal((await poll()).status, 204);
  const parked = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(parked.status, RunStatus.FAILED);
  assert.equal(parked.retryable, false);
  assert.match(parked.failureReason ?? "", /spec-read-deadline-exceeded/u);
  assert.match(
    parked.failureReason ?? "",
    /specification read exceeded its per-attempt deadline under host load on all \d+ deferred attempts over \d+ms \(deferral ceiling 1800000ms\)/u,
  );
  assert.equal(/unreadable/u.test(parked.failureReason ?? ""), false);
  const task = await db.task.findUniqueOrThrow({ where: { id: firstDeferral.taskId } });
  assert.equal(task.status, TaskStatus.BACKLOG);
  assert.equal(task.failureReason, parked.failureReason);
  assert.equal(await db.inboxMessage.count({ where: { dedupeKey: `spec-read-deadline-exceeded:${runId}` } }), 1);
  assert.equal(await db.inboxMessage.count({ where: { dedupeKey: extendedKey } }), 1);
});

test("an extended all-timeout episode broken by another transient parks on the ordinary budget", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "mixed-transient-implementation");
  let deadlineBound = true;
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        throw deadlineBound
          ? new GitHubReadError("repository content read exceeded the 1800ms server deadline", "timeout")
          : new GitHubReadError("proxy flap after the extension", "transport");
      },
    },
  });
  const poll = () => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "mixed-transient-review", leaseSeconds: 120 }),
  });
  assert.equal((await poll()).status, 204);
  const firstDeferral = await db.taskActivity.findFirstOrThrow({
    where: { metadata: { path: ["condition"], equals: "specification-read-claim-deferred" } },
    select: { id: true, taskId: true, metadata: true },
  });
  const runId = String((firstDeferral.metadata as Record<string, unknown>).runId);
  const reopen = async (budgetAgeMs: number) => {
    await db.taskActivity.update({
      where: { id: firstDeferral.id },
      data: { createdAt: new Date(Date.now() - budgetAgeMs) },
    });
    await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
    await db.run.updateMany({
      where: {
        taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
        id: { not: runId },
        status: RunStatus.QUEUED,
      },
      data: { readyAt: new Date(Date.now() + 60_000) },
    });
  };

  // The episode is already extended well past the ordinary budget on timeouts.
  await reopen(12 * 60_000);
  assert.equal((await poll()).status, 204);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).status, RunStatus.QUEUED);

  // One non-timeout transient forfeits the extension on the very next poll.
  deadlineBound = false;
  await reopen(12 * 60_000);
  assert.equal((await poll()).status, 204);
  const parked = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(parked.status, RunStatus.FAILED);
  assert.match(parked.failureReason ?? "", /spec-transcription-unreadable/u);
  // The underlying error named is the transient that broke the extension, not
  // the deadline hits before it; it carries the read's own retry-count detail.
  assert.match(
    parked.failureReason ?? "",
    /last underlying error: after \d+ retries \(\d+ total attempts\); last failure: proxy flap after the extension/u,
  );
  assert.equal(/server deadline/u.test(parked.failureReason ?? ""), false);
  // The window named is the one the episode ran, not the budget it parked on.
  const [, elapsedMs, budgetMs] = /exhausted after (\d+)ms \(budget (\d+)ms\)/u
    .exec(parked.failureReason ?? "") ?? [];
  assert.equal(budgetMs, "300000");
  assert.ok(Number(elapsedMs) > 10 * 60_000, `expected the observed window, saw ${String(elapsedMs)}ms`);
  const settlement = await db.taskActivity.findFirstOrThrow({
    where: {
      taskId: firstDeferral.taskId,
      metadata: { path: ["exhaustedCondition"], equals: "specification-read-claim-deferred" },
    },
  });
  assert.equal((settlement.metadata as Record<string, unknown>).transientCause, "other");
  assert.equal((settlement.metadata as Record<string, unknown>).budgetMs, 5 * 60_000);
});

test("a raw abort from the reader is an ordinary transient, not an extendable deadline hit", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "raw-abort-implementation");
  const app = createApp(db, {
    specificationReader: {
      // Not this claim's per-attempt deadline: an abort raised by the reader
      // itself, which is transient but carries no evidence of a slow host.
      readFileAtCommit: async () => {
        throw new DOMException("aborted", "AbortError");
      },
    },
  });
  const poll = () => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "raw-abort-review", leaseSeconds: 120 }),
  });
  assert.equal((await poll()).status, 204);
  const deferral = await db.taskActivity.findFirstOrThrow({
    where: { metadata: { path: ["condition"], equals: "specification-read-claim-deferred" } },
    select: { id: true, taskId: true, metadata: true },
  });
  assert.equal((deferral.metadata as Record<string, unknown>).transientCause, "other");
  assert.equal((deferral.metadata as Record<string, unknown>).budgetMs, 5 * 60_000);
  const runId = String((deferral.metadata as Record<string, unknown>).runId);
  await db.taskActivity.update({
    where: { id: deferral.id },
    data: { createdAt: new Date(Date.now() - 6 * 60_000) },
  });
  await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
  await db.run.updateMany({
    where: {
      taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
      id: { not: runId },
      status: RunStatus.QUEUED,
    },
    data: { readyAt: new Date(Date.now() + 60_000) },
  });

  assert.equal((await poll()).status, 204);
  const parked = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(parked.status, RunStatus.FAILED);
  assert.match(parked.failureReason ?? "", /spec-transcription-unreadable/u);
  assert.match(parked.failureReason ?? "", /\(budget 300000ms\)/u);
  assert.equal(/spec-read-deadline-exceeded/u.test(parked.failureReason ?? ""), false);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: deferral.taskId } })).status, TaskStatus.BACKLOG);
  assert.equal(await db.inboxMessage.count({
    where: { dedupeKey: `specification-read-deadline-extended:${deferral.taskId}` },
  }), 0);
});

test("one poll settles every review sibling whose transient specification read budget expired", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "sibling-exhaustion-implementation");
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        throw new GitHubReadError("shared proxy flap", "transport");
      },
    },
  });
  const poll = () => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "sibling-exhaustion-review", leaseSeconds: 120 }),
  });

  assert.equal((await poll()).status, 204);
  assert.equal((await poll()).status, 204);
  const deferrals = await db.taskActivity.findMany({
    where: {
      taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
      metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
    },
    select: { id: true, metadata: true },
  });
  assert.equal(deferrals.length, 2);
  const runIds = deferrals.map(({ metadata }) => String((metadata as Record<string, unknown>).runId));
  await db.taskActivity.updateMany({
    where: { id: { in: deferrals.map(({ id }) => id) } },
    data: { createdAt: new Date(Date.now() - 6 * 60_000) },
  });
  await db.run.updateMany({ where: { id: { in: runIds } }, data: { readyAt: new Date(0) } });

  assert.equal((await poll()).status, 204);
  assert.equal(await db.run.count({
    where: { id: { in: runIds }, status: RunStatus.FAILED },
  }), 2);
  assert.equal(await db.task.count({
    where: { id: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: TaskStatus.BACKLOG },
  }), 2);
});

test("a review cancelled during transient specification-read deferral is never claimed", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "cancelled-read-implementation");
  let reads = 0;
  let blockNextRead = false;
  let announceReadStarted!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { announceReadStarted = resolve; });
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        reads += 1;
        if (blockNextRead) {
          blockNextRead = false;
          announceReadStarted();
          await readReleased;
        }
        throw new GitHubReadError("proxy flap before cancellation", "transport");
      },
    },
  });
  const first = await app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "cancelled-read-review", leaseSeconds: 120 }),
  });
  assert.equal(first.status, 204, await first.text());
  const deferral = await db.taskActivity.findFirstOrThrow({
    where: { metadata: { path: ["condition"], equals: "specification-read-claim-deferred" } },
    select: { taskId: true, metadata: true },
  });
  const runId = String((deferral.metadata as Record<string, unknown>).runId);
  await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
  await db.run.updateMany({
    where: {
      taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
      id: { not: runId },
      status: RunStatus.QUEUED,
    },
    data: { readyAt: new Date(Date.now() + 60_000) },
  });
  blockNextRead = true;
  const pendingClaim = app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "post-deferral-review", leaseSeconds: 120 }),
  });
  await readStarted;
  const cancelled = await operatorRequest(`/runs/${runId}/cancel`, "POST", {
    requestId: "cancel-during-spec-read-deferral",
    reason: "operator no longer needs this review",
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  releaseRead();
  const afterCancellation = await pendingClaim;
  assert.equal(afterCancellation.status, 204, await afterCancellation.text());
  assert.equal(reads, 6);
  const cancelledRun = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(cancelledRun.status, RunStatus.CANCELLED);
  assert.equal(cancelledRun.runnerId, null);
  assert.equal(cancelledRun.fencingToken, null);
  assert.equal(await db.session.count({ where: { runId } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: deferral.taskId } })).status, TaskStatus.REVIEW);
  assert.equal(await db.taskActivity.count({
    where: {
      taskId: deferral.taskId,
      metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
    },
  }), 1);
});

test("a repository change between verification and claim triggers verification against the new repository", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "repository-change-implementation");
  const repositoriesRead: string[] = [];
  const response = await createApp(db, {
    specificationReader: {
      readFileAtCommit: async (repository) => {
        repositoriesRead.push(repository);
        if (repositoriesRead.length === 1) {
          await db.repo.update({
            where: { id: fixture.repoId },
            data: { remoteUrl: "https://github.com/example/replaced-review.git" },
          });
        }
        return new TextEncoder().encode(SPECIFICATION_BRIEF);
      },
    },
  }).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "repository-change-review", leaseSeconds: 120 }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const reviewed = JSON.parse(responseText) as Claim;
  assert.ok([fixture.solTaskId, fixture.blindTaskId].includes(reviewed.run.taskId));
  assert.deepEqual(repositoriesRead, [
    "example/parallel-review",
    "example/replaced-review",
  ]);
});

test("a faithful rolled-over compound chain still resolves the approved specification", async () => {
  const fixture = await instantiateFullAtReviewFrontier();
  await db.taskTemplate.update({
    where: { id: fixture.fullTemplateId },
    data: { name: templateRolloverName(INTEGRATOR_TEMPLATE_NAME, "pre-zero-gate", fixture.fullTemplateId) },
  });
  await completeImplementation(fixture, "legacy-compound-implementation");
  const reviewed = await claim("legacy-compound-review");
  assert.ok([fixture.solTaskId, fixture.blindTaskId].includes(reviewed.run.taskId));
});

test("an unreadable review candidate is parked without blocking an unrelated claim in the same poll", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "unreadable-implementation");
  const unrelatedChain = await instantiateTemplate(db, fixture.projectId, fixture.directTemplateId, {
    repoId: fixture.repoId,
    variables: { branchName: `parallel/unrelated-${Date.now()}` },
    name: "parallel unrelated",
    description: "unrelated implementation brief",
    autoStart: true,
  });
  const unrelatedImplementationTask = unrelatedChain.tasks.find((task) => task.chainIndex === 1);
  assert.ok(unrelatedImplementationTask);

  const response = await createApp(db, { specificationReader: null }).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "unrelated-runner", leaseSeconds: 120 }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const claimed = JSON.parse(responseText) as Claim;
  assert.equal(claimed.run.taskId, unrelatedImplementationTask.id);

  const failedReviews = await db.run.findMany({
    where: {
      taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
      status: RunStatus.FAILED,
    },
    select: { id: true, taskId: true, failureReason: true, retryable: true },
  });
  assert.equal(failedReviews.length, 2);
  assert.ok(failedReviews.every((run) => run.retryable === false && run.failureReason?.includes("spec-transcription-unreadable")));
  for (const failed of failedReviews) {
    assert.ok(failed.taskId);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: failed.taskId } })).status, TaskStatus.BACKLOG);
    assert.equal(await db.inboxMessage.count({ where: { dedupeKey: `spec-transcription-unreadable:${failed.id}` } }), 1);
  }
});

test("tampered direct and compound materializations refuse claim with the named reason without starving the sibling", async () => {
  for (const shape of ["direct", "compound"] as const) {
    await resetTestDb(db);
    await runDbScript("seed.ts");
    setMaterializedSpecification(
      shape === "direct"
        ? `Feature brief:\n${SPECIFICATION_BRIEF}\nPersist the final implementation output for this step through the Anneal task output endpoint.`
        : "tampered specification",
    );
    specificationReads.length = 0;
    const fixture = shape === "direct"
      ? await instantiateDirect()
      : await instantiateFullAtReviewFrontier();
    await completeImplementation(fixture, `${shape}-implementation`);

    const refused = await runnerRequest("/runner/tasks/claim", {
      runnerId: `${shape}-review`,
      leaseSeconds: 120,
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    const refusalBody = refused.body as { error: string; reason: string };
    assert.equal(refusalBody.reason, "spec-transcription-mismatch");
    assert.match(refusalBody.error, /Spec transcription claim refused: spec-transcription-mismatch/u);
    assert.equal(specificationReads.length, 1);

    const failed = await db.run.findFirstOrThrow({
      where: { taskId: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: RunStatus.FAILED },
      select: { id: true, taskId: true, failureReason: true, retryable: true },
    });
    assert.equal(failed.retryable, false);
    assert.ok(failed.taskId);
    assert.match(failed.failureReason ?? "", /spec-transcription-mismatch/u);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: failed.taskId } })).status, TaskStatus.BACKLOG);
    assert.equal(await db.inboxMessage.count({ where: { dedupeKey: `spec-transcription-mismatch:${failed.id}` } }), 1);
    const refusalActivity = await db.taskActivity.findFirstOrThrow({
      where: {
        taskId: failed.taskId,
        metadata: { path: ["condition"], equals: "spec-transcription-mismatch" },
      },
    });
    assert.equal((refusalActivity.metadata as Record<string, unknown>).classification, "non-transient");
    assert.equal(await db.taskActivity.count({
      where: {
        taskId: failed.taskId,
        metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
      },
    }), 0);

    setMaterializedSpecification(SPECIFICATION_BRIEF);
    const sibling = await claim(`${shape}-sibling`);
    assert.ok([fixture.solTaskId, fixture.blindTaskId].includes(sibling.run.taskId));
    assert.notEqual(sibling.run.taskId, failed.taskId);
  }
});
