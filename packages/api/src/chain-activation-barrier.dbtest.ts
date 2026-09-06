import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  ChainControlState,
  DependencyProvisioning,
  MERGE_TAIL_KIND,
  PrismaClient,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
} from "@anneal/db";

import {
  CHAIN_OPERATOR_TOKEN,
  CHAIN_RUNNER_TOKEN,
  operatorRequest,
  runnerCompletionRequest,
  seedBasicChain,
  seedRun,
} from "./chain-hold-resume-fixture.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { recordMergeLeaseHold } from "./merge-lease-hold.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

let db: PrismaClient;
const RUNNER_TOKEN = CHAIN_RUNNER_TOKEN;
const priorRunnerToken = process.env.RUNNER_TOKEN;
const priorOperatorToken = process.env.OPERATOR_TOKEN;

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = CHAIN_OPERATOR_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
});

const createClient = () => new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });

const PAUSED_TX_MAX_WAIT_MS = 5_000;
const PAUSED_TX_TIMEOUT_MS = 30_000;
// Allow setup and teardown time beyond transaction acquisition and execution.
const PAUSE_TEST_TIMEOUT_MS = (PAUSED_TX_MAX_WAIT_MS + PAUSED_TX_TIMEOUT_MS) * 2;

/** Pause a transaction immediately after its Chain row lock resolves. */
const instrumentTransactions = (
  client: PrismaClient,
  onQuery: (pending: Promise<unknown>, sql: string) => Promise<unknown> | unknown,
): PrismaClient => new Proxy(client, {
  get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const instrumentedTx = new Proxy(tx, {
        get(txTarget, txProperty, txReceiver) {
          if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
          return (...args: unknown[]) => {
            const query = args[0] as string[] | { strings?: string[] } | undefined;
            const sql = Array.isArray(query) ? query.join(" ") : query?.strings?.join(" ") ?? "";
            return onQuery(Reflect.apply(txTarget.$queryRaw, txTarget, args), sql);
          };
        },
      });
      return operation(instrumentedTx);
    }, {
      maxWait: PAUSED_TX_MAX_WAIT_MS,
      timeout: PAUSED_TX_TIMEOUT_MS,
      ...(options as Record<string, unknown>),
    } as any);
  },
}) as PrismaClient;

const seedRunningHeldChain = async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const project = await db.project.create({ data: { name: "Activation", slug: `activation-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `activation-agent-${suffix}`,
    title: "Activation agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: `activation-repo-${suffix}`,
    remoteUrl: "https://example.test/activation.git",
    mountPath: "/repo",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  const chainId = `activation-chain-${suffix}`;
  const predecessor = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    assigneeAgentId: agent.id,
    name: "First",
    description: "first",
    chainId,
    chainIndex: 0,
    chainLayer: 1,
    status: TaskStatus.DOING,
  } });
  const successor = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    assigneeAgentId: agent.id,
    name: "Second",
    description: "second",
    chainId,
    chainIndex: 1,
    chainLayer: 2,
    status: TaskStatus.TODO,
  } });
  const run = await db.run.create({ data: {
    projectId: project.id,
    taskId: predecessor.id,
    agentId: agent.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${predecessor.id}:run:1`,
    runner: "CLAUDE",
    model: "claude",
    status: RunStatus.RUNNING,
    runnerId: "activation-runner",
    fencingToken: "activation-fence",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    promptHash: "activation-prompt",
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: project.id,
    agentId: agent.id,
    taskId: predecessor.id,
    runner: "CLAUDE",
    executionStatus: SessionExecutionStatus.RUNNING,
  } });
  const control = await db.chainControl.create({ data: {
    projectId: project.id,
    chainId,
    state: ChainControlState.HELD,
    heldLayer: 1,
    heldAt: new Date("2026-08-28T00:00:00.000Z"),
    holdRequestId: "hold-activation",
    holdGeneration: 1,
  } });
  await db.chainControlEvent.create({ data: {
    chainControlId: control.id,
    kind: ChainControlState.HELD,
    layer: 1,
    actorType: "operator",
    requestId: "hold-activation",
    holdGeneration: 1,
  } });
  return { project, predecessor, successor, run, control };
};

test("completion under a held Chain persists output and withholds successor activation", async () => {
  const chain = await seedRunningHeldChain();
  const response = await createApp(db).request(`/runner/runs/${chain.run.id}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: "activation-runner",
      fencingToken: "activation-fence",
      exitCode: 0,
      outcome: { case: "succeeded" },
      cleanupStatus: "SUCCEEDED",
      output: "completed under hold",
    }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.predecessor.id } })).status, TaskStatus.DONE);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: chain.run.id } })).status, RunStatus.SUCCEEDED);
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: chain.predecessor.id } });
  assert.equal(output.runId, chain.run.id);
  assert.equal(output.kind, "result");
  assert.equal(output.body, "completed under hold");
  assert.equal(await db.run.count({ where: { taskId: chain.successor.id } }), 0);
  const activity = await db.taskActivity.findFirst({
    where: { taskId: chain.predecessor.id, body: { contains: "activation withheld" } },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(activity, "completion records why the successor was withheld");
});

test("Hold at admitted layer two lets it finish and withholds layer three", async () => {
  const chain = await seedBasicChain(db, {
    statuses: [TaskStatus.DONE, TaskStatus.DOING, TaskStatus.TODO],
    control: null,
  });
  const running = await seedRun(db, chain, chain.second.id);
  const held = await operatorRequest(db, `/tasks/${chain.second.id}/chain/hold`, { requestId: "hold-layer-two" });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.control.heldLayer, 2);
  assert.equal((await db.chainControl.findUniqueOrThrow({ where: { projectId_chainId: {
    projectId: chain.project.id,
    chainId: chain.chainId,
  } } })).heldExecutionLayer, 2);

  const completed = await runnerCompletionRequest(db, running.run, "layer two complete");
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.second.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: chain.third.id } }), 0);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: chain.second.id,
    metadata: { path: ["kind"], equals: "chainControl.activationWithheld" },
  } }), 1);
});

test("completion under a held Chain records fail-closed activity for a successor with no execution layer", async () => {
  const chain = await seedRunningHeldChain();
  await db.$executeRawUnsafe('ALTER TABLE "Task" DROP CONSTRAINT "Task_chain_identity_all_or_none_check"');
  try {
    await db.task.update({
      where: { id: chain.successor.id },
      data: { chainLayer: null, chainIndex: null },
    });
    const response = await createApp(db).request(`/runner/runs/${chain.run.id}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "activation-runner",
        fencingToken: "activation-fence",
        exitCode: 0,
        outcome: { case: "succeeded" },
        cleanupStatus: "SUCCEEDED",
        output: "completed before malformed successor",
      }),
    });

    assert.equal(response.status, 200, await response.text());
    assert.equal(await db.run.count({ where: { taskId: chain.successor.id } }), 0);
    const activity = await db.taskActivity.findFirstOrThrow({
      where: { taskId: chain.predecessor.id, metadata: { path: ["kind"], equals: "chainControl.activationWithheld" } },
      orderBy: { createdAt: "desc" },
    });
    assert.match(activity.body, /activation withheld because Chain is held after layer 1/u);
    assert.deepEqual(activity.metadata, {
      kind: "chainControl.activationWithheld",
      schemaVersion: 1,
      heldLayer: 1,
      nextLayer: null,
    });
  } finally {
    await db.task.update({
      where: { id: chain.successor.id },
      data: { chainLayer: 2, chainIndex: 1 },
    });
    await db.$executeRawUnsafe(`ALTER TABLE "Task"
      ADD CONSTRAINT "Task_chain_identity_all_or_none_check" CHECK (
        ("chainId" IS NULL AND "chainIndex" IS NULL AND "chainLayer" IS NULL)
        OR
        ("chainId" IS NOT NULL AND "chainIndex" IS NOT NULL AND "chainLayer" IS NOT NULL)
      )`);
  }
});

test("a held fan-out layer completes every sibling while its join remains unactivated", async () => {
  const chain = await seedBasicChain(db, {
    statuses: [TaskStatus.DOING, TaskStatus.DOING, TaskStatus.TODO],
    layers: [1, 1, 2],
  });
  const firstRun = await seedRun(db, chain, chain.first.id);
  const secondRun = await seedRun(db, chain, chain.second.id);
  const held = await operatorRequest(db, `/tasks/${chain.second.id}/chain/hold`, { requestId: "hold-fanout", reason: "review siblings" });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.control.heldLayer, 1);
  assert.equal((await runnerCompletionRequest(db, firstRun.run, "fan-out first")).status, 200);
  assert.equal(await db.run.count({ where: { taskId: chain.third.id } }), 0);
  assert.equal((await runnerCompletionRequest(db, secondRun.run, "fan-out second")).status, 200);
  assert.deepEqual(
    (await db.task.findMany({ where: { id: { in: [chain.first.id, chain.second.id] } }, orderBy: { chainIndex: "asc" }, select: { status: true } }))
      .map((task) => task.status),
    [TaskStatus.DONE, TaskStatus.DONE],
  );
  assert.equal(await db.run.count({ where: { taskId: chain.third.id } }), 0);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: { in: [chain.first.id, chain.second.id] } } }), 2);
  const resumed = await operatorRequest(db, `/tasks/${chain.third.id}/chain/resume`, { requestId: "resume-fanout" });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(await db.run.count({ where: { taskId: chain.third.id, status: RunStatus.QUEUED } }), 1);
});

const raceHoldAndCompletion = async (winner: "hold" | "completion") => {
  const chain = await seedBasicChain(db, { statuses: [TaskStatus.DOING, TaskStatus.TODO], control: null });
  const running = await seedRun(db, chain, chain.first.id);
  let releaseWinner!: () => void;
  let winnerLocked!: () => void;
  let loserAttempted!: () => void;
  let winnerObserved = false;
  let loserObserved = false;
  const winnerGate = new Promise<void>((resolve) => { releaseWinner = resolve; });
  const winnerLock = new Promise<void>((resolve) => { winnerLocked = resolve; });
  const loserLockAttempt = new Promise<void>((resolve) => { loserAttempted = resolve; });
  const winnerDb = instrumentTransactions(createClient(), async (pending, sql) => {
    const result = await pending;
    if (!winnerObserved && sql.includes("chainLayer")) {
      winnerObserved = true;
      winnerLocked();
      await winnerGate;
    }
    return result;
  });
  const loserDb = instrumentTransactions(createClient(), (pending, sql) => {
    if (!loserObserved && sql.includes("chainLayer")) {
      loserObserved = true;
      loserAttempted();
    }
    return pending;
  });
  try {
    const first = winner === "hold"
      ? operatorRequest(winnerDb, `/tasks/${chain.second.id}/chain/hold`, { requestId: "hold-race-winner", reason: "stop after layer" })
      : runnerCompletionRequest(winnerDb, running.run, "completion race winner");
    await winnerLock;
    const second = winner === "hold"
      ? runnerCompletionRequest(loserDb, running.run, "hold won")
      : operatorRequest(loserDb, `/tasks/${chain.second.id}/chain/hold`, { requestId: "hold-race-loser", reason: "hold activated layer" });
    await loserLockAttempt;
    releaseWinner();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.status, 200, JSON.stringify(firstResponse.body));
    assert.equal(secondResponse.status, 200, JSON.stringify(secondResponse.body));
  } finally {
    releaseWinner();
    await Promise.all([winnerDb.$disconnect(), loserDb.$disconnect()]);
  }
  return chain;
};

test("concurrent Hold and completion with Hold winning withholds the successor", { timeout: PAUSE_TEST_TIMEOUT_MS }, async () => {
  const chain = await raceHoldAndCompletion("hold");
  assert.equal(await db.run.count({ where: { taskId: chain.second.id } }), 0);
  assert.equal(await db.taskActivity.count({ where: { taskId: chain.first.id, body: { contains: "activation withheld" } } }), 1);
});

test("concurrent Hold and completion with completion winning preserves the activated Run", { timeout: PAUSE_TEST_TIMEOUT_MS }, async () => {
  const chain = await raceHoldAndCompletion("completion");
  assert.equal(await db.run.count({ where: { taskId: chain.second.id, status: RunStatus.QUEUED } }), 1);
  assert.equal((await db.chainControl.findUniqueOrThrow({ where: { projectId_chainId: { projectId: chain.project.id, chainId: chain.chainId } } })).heldLayer, 2);
});

test("a held approval gate opens Inbox, and answering it completes without crossing the barrier", async () => {
  const chain = await seedBasicChain(db, { statuses: [TaskStatus.DOING, TaskStatus.TODO], control: null });
  await db.task.update({ where: { id: chain.first.id }, data: { approvalGate: true } });
  const running = await seedRun(db, chain, chain.first.id);
  const held = await operatorRequest(db, `/tasks/${chain.second.id}/chain/hold`, { requestId: "hold-gate", reason: "inspect gate" });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal((await runnerCompletionRequest(db, running.run, "gate evidence")).status, 200);
  const gate = await db.inboxMessage.findFirstOrThrow({ where: { gateTaskId: chain.first.id, status: "OPEN" } });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.first.id } })).status, TaskStatus.REVIEW);
  const answer = await operatorRequest(db, `/inbox/messages/${gate.id}/decision`, { decision: "approve", requestId: "answer-held-gate" });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.first.id } })).status, TaskStatus.DONE);
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: gate.id } })).status, "ANSWERED");
  assert.equal(await db.run.count({ where: { taskId: chain.second.id } }), 0);
  assert.equal((await db.chainControl.findUniqueOrThrow({ where: { projectId_chainId: { projectId: chain.project.id, chainId: chain.chainId } } })).state, ChainControlState.HELD);
});

test("a completion at or below the held layer keeps ordinary output and successor behavior", async () => {
  const chain = await seedBasicChain(db, {
    statuses: [TaskStatus.DOING, TaskStatus.TODO, TaskStatus.TODO],
    control: {
      state: ChainControlState.HELD,
      heldLayer: 2,
      holdGeneration: 1,
      holdRequestId: "hold-layer-two",
      holdReason: "stop after layer two",
      heldAt: new Date("2026-08-28T02:00:00.000Z"),
      event: true,
    },
  });
  const running = await seedRun(db, chain, chain.first.id);
  assert.equal((await runnerCompletionRequest(db, running.run, "layer one ordinary completion")).status, 200);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.first.id } })).status, TaskStatus.DONE);
  assert.equal((await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: chain.first.id } })).body, "layer one ordinary completion");
  assert.equal(await db.run.count({ where: { taskId: chain.second.id, status: RunStatus.QUEUED } }), 1);
  assert.equal(await db.run.count({ where: { taskId: chain.third.id } }), 0);
});

test("a held merge-readiness completion records evidence, leaves the integrator inactive, and does not touch lease activity", async () => {
  const chain = await seedIntegratorChain(db, { label: "held-readiness", shape: "canonical-compound-readiness" });
  assert.ok(chain.readinessTask);
  assert.ok(chain.integratorTask);
  await recordMergeLeaseHold(db, { projectId: chain.project.id, chainId: chain.chainId }, {
    outcome: "released",
    ref: "refs/merge-lease/holder",
    sha: "readiness-lease-before",
    acquiredAt: "2026-08-28T02:00:00.000Z",
  }, new Date("2026-08-28T02:01:00.000Z"));
  const leaseBefore = await db.taskActivity.findMany({
    where: { taskId: chain.integratorTask.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHold } },
    orderBy: { id: "asc" },
  });
  await db.chainControl.create({ data: {
    projectId: chain.project.id,
    chainId: chain.chainId,
    state: ChainControlState.HELD,
    heldLayer: chain.readinessTask.chainLayer,
    heldAt: new Date("2026-08-28T02:02:00.000Z"),
    holdRequestId: "hold-readiness",
    holdReason: "inspect readiness",
    holdGeneration: 1,
  } });
  await db.task.update({ where: { id: chain.readinessTask.id }, data: { status: TaskStatus.DOING } });
  const run = await db.run.create({ data: {
    projectId: chain.project.id,
    taskId: chain.readinessTask.id,
    agentId: chain.agent.id,
    repoId: chain.repo.id,
    runNumber: 1,
    dedupeKey: `task:${chain.readinessTask.id}:readiness:1`,
    runner: "CLAUDE",
    model: chain.agent.model,
    status: RunStatus.RUNNING,
    runnerId: "readiness-runner",
    fencingToken: "readiness-fence",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    promptHash: "readiness-prompt",
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: chain.project.id,
    agentId: chain.agent.id,
    taskId: chain.readinessTask.id,
    runner: "CLAUDE",
    executionStatus: SessionExecutionStatus.RUNNING,
  } });
  const completed = await createApp(db).request(`/runner/runs/${run.id}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "readiness-runner", fencingToken: "readiness-fence", exitCode: 0,
      outcome: { case: "succeeded" }, cleanupStatus: "SUCCEEDED", output: "readiness evidence" }),
  });
  assert.equal(completed.status, 200, await completed.text());
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.DONE);
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: chain.readinessTask.id } });
  assert.equal(output.body, "readiness evidence");
  assert.equal(output.runId, run.id);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask.id } }), 0);
  const leaseAfter = await db.taskActivity.findMany({
    where: { taskId: chain.integratorTask.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHold } },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(leaseAfter, leaseBefore);
});

test("bound successor dispatch remains active while the predecessor Chain is held", async () => {
  const predecessorChain = await seedBasicChain(db, { statuses: [TaskStatus.DOING, TaskStatus.TODO] });
  const boundSuccessor = await db.task.create({ data: {
    projectId: predecessorChain.project.id,
    repoId: predecessorChain.repo.id,
    assigneeAgentId: predecessorChain.agent.id,
    name: "Bound successor",
    description: "bound successor",
    chainId: `bound-successor-${predecessorChain.chainId}`,
    chainIndex: 0,
    chainLayer: 1,
    status: TaskStatus.TODO,
    dispatchAfterTaskId: predecessorChain.first.id,
  } });
  const running = await seedRun(db, predecessorChain, predecessorChain.first.id);
  assert.equal((await runnerCompletionRequest(db, running.run, "bound predecessor")).status, 200);
  assert.equal((await db.chainControl.findUniqueOrThrow({ where: { id: predecessorChain.control!.id } })).state, ChainControlState.HELD);
  const parked = await db.task.findUniqueOrThrow({ where: { id: boundSuccessor.id } });
  assert.equal(parked.status, TaskStatus.REVIEW);
  assert.equal(parked.failureReason, "bound predecessor is no longer terminal; successor was not queued");
  assert.equal(await db.run.count({ where: { taskId: boundSuccessor.id } }), 0);
  assert.equal(await db.taskActivity.count({ where: { taskId: boundSuccessor.id, body: { contains: "no longer terminal" } } }), 1);
  assert.equal(await db.run.count({ where: { taskId: predecessorChain.first.id, status: RunStatus.CANCELLED } }), 0);
});

test("a held bound Chain withholds predecessor dispatch and Resume activates its first layer", async () => {
  const predecessorChain = await seedBasicChain(db, { statuses: [TaskStatus.DOING], control: null });
  const successorChainId = `held-bound-successor-${predecessorChain.chainId}`;
  const successor = await db.task.create({ data: {
    projectId: predecessorChain.project.id,
    repoId: predecessorChain.repo.id,
    assigneeAgentId: predecessorChain.agent.id,
    name: "Held bound successor",
    description: "held bound successor",
    chainId: successorChainId,
    chainIndex: 0,
    chainLayer: 0,
    status: TaskStatus.TODO,
    dispatchAfterTaskId: predecessorChain.first.id,
  } });
  const held = await operatorRequest(db, `/tasks/${successor.id}/chain/hold`, { requestId: "hold-bound-before-first" });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.control.heldLayer, 0);

  const running = await seedRun(db, predecessorChain, predecessorChain.first.id);
  const completed = await runnerCompletionRequest(db, running.run, "bound predecessor complete");
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: successor.id } })).status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: successor.id,
    metadata: { path: ["kind"], equals: "chainControl.activationWithheld" },
  } }), 1);

  const resumed = await operatorRequest(db, `/tasks/${successor.id}/chain/resume`, { requestId: "resume-bound-first" });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.nextTaskId, successor.id);
  assert.equal(await db.run.count({ where: { taskId: successor.id, status: RunStatus.QUEUED } }), 1);
});
