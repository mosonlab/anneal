/**
 * §D-P4 — the bidirectional binding invariant, at every surface that can bind.
 *
 *   integratorBindingValid(agentName, step)
 *     = (agentName === "merge-integrator") === isIntegratorStep(step)
 *
 * Both directions matter and they fail differently. The sentinel Agent on an
 * ordinary step claims as an *agent* run, so a model runner spawns a CLI with
 * `mechanical/merge-executor-v1` as its model and the merge authority's name on
 * the row. An ordinary agent on step 12 claims as a *mechanical* run, so the
 * step that merges is executed by an LLM in a workspace with a repo checkout.
 *
 * The invariant is therefore checked at every place a (task, agent, step)
 * triple can come into being or change — creation, reassignment, template
 * instantiation, the scheduler's two fire paths, retry, enqueue, and the claim
 * itself — and each of those is a separate test here, because a guard that
 * exists at seven of eight surfaces is a guard at none.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  enqueueTaskRun,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_STEP_INDEX,
  isIntegratorBindingError,
  PrismaClient,
  TaskStatus,
} from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";

import { fireAtTask, fireCronTask } from "./scheduler.js";
import { instantiateTemplate } from "./templates.js";
import { seedIntegratorChain, type IntegratorChain } from "./merge-integrator-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-binding";
const RUNNER = "runner-binding";
const EXECUTOR_RUNNER = "merge-executor-1";
/** The executor's own bearer. Distinct from RUNNER by construction: the API
 *  refuses to mint a merge-executor principal from an aliased token. */
const EXECUTOR_TOKEN = "merge-executor-token-binding";

const withTokens = async <T>(body: () => Promise<T>): Promise<T> => {
  const prior = {
    operator: process.env.OPERATOR_TOKEN,
    runner: process.env.RUNNER_TOKEN,
    executors: process.env.MERGE_EXECUTOR_RUNNER_IDS,
    executorToken: process.env.MERGE_EXECUTOR_TOKEN,
  };
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  process.env.MERGE_EXECUTOR_RUNNER_IDS = EXECUTOR_RUNNER;
  process.env.MERGE_EXECUTOR_TOKEN = EXECUTOR_TOKEN;
  try {
    return await body();
  } finally {
    for (const [key, value] of [
      ["OPERATOR_TOKEN", prior.operator], ["RUNNER_TOKEN", prior.runner],
      ["MERGE_EXECUTOR_RUNNER_IDS", prior.executors], ["MERGE_EXECUTOR_TOKEN", prior.executorToken],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

const call = async (
  method: string, path: string, body?: unknown, token = OPERATOR,
): Promise<{ status: number; body: any }> => withTokens(async () => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) as any };
});

const claim = async (
  runnerId: string, token = runnerId === EXECUTOR_RUNNER ? EXECUTOR_TOKEN : RUNNER,
): Promise<{ status: number; body: any }> =>
  call("POST", "/runner/tasks/claim", { runnerId, contractVersion: RUN_COMPLETION_CONTRACT_VERSION }, token);

/* --------------------------------------------------- creation and reassignment */

test("an ordinary task may not be assigned to the sentinel agent", async () => {
  const chain = await seedIntegratorChain(db, { label: "create" });
  const refused = await call("POST", `/projects/${chain.project.id}/tasks`, {
    name: "Do something", description: "anything",
    assigneeType: "AGENT", assigneeAgentId: chain.integratorAgent.id,
    repoId: chain.repo.id,
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, new RegExp(INTEGRATOR_AGENT_NAME));
  // Nothing was written: the guard runs inside the transaction, before create.
  assert.equal(await db.task.count({ where: { name: "Do something" } }), 0);

  // The control: the same route with an ordinary agent is untouched.
  const allowed = await call("POST", `/projects/${chain.project.id}/tasks`, {
    name: "Do something else", description: "anything",
    assigneeType: "AGENT", assigneeAgentId: chain.agent.id, repoId: chain.repo.id,
  });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
});

test("the integrator task may not be reassigned away from the sentinel", async () => {
  const chain = await seedIntegratorChain(db, { label: "patch" });
  const refused = await call("PATCH", `/tasks/${chain.integratorTask!.id}`, {
    assigneeAgentId: chain.agent.id,
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  const after = await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } });
  assert.equal(after.assigneeAgentId, chain.integratorAgent.id);
});

test("an ordinary chain task may not be reassigned to the sentinel", async () => {
  const chain = await seedIntegratorChain(db, { label: "patch-in" });
  const refused = await call("PATCH", `/tasks/${chain.gateTask.id}`, {
    assigneeAgentId: chain.integratorAgent.id,
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  const after = await db.task.findUniqueOrThrow({ where: { id: chain.gateTask.id } });
  assert.equal(after.assigneeAgentId, chain.agent.id);
});

/* --------------------------------------------------------- template instantiation */

test("instantiating a doctored template is refused, not silently mis-bound", async () => {
  const chain = await seedIntegratorChain(db, { label: "template" });
  // The template is the durable source of every chain's bindings, so an edit
  // here would mis-bind every future chain rather than one task.
  await db.taskTemplateStep.update({
    where: { id: chain.integratorStep!.id },
    data: { assigneeAgentId: chain.agent.id },
  });
  await assert.rejects(
    () => instantiateTemplate(db, chain.project.id, chain.template.id, { variables: {}, name: "invalid integrator", autoStart: false } as any),
    (error: unknown) => error instanceof Error && new RegExp(INTEGRATOR_AGENT_NAME).test(error.message),
  );

  // And the mirror image: the sentinel on an ordinary step.
  await db.taskTemplateStep.update({
    where: { id: chain.integratorStep!.id },
    data: { assigneeAgentId: chain.integratorAgent.id },
  });
  await db.taskTemplateStep.update({
    where: { id: chain.gateStep.id },
    data: { assigneeAgentId: chain.integratorAgent.id },
  });
  await assert.rejects(
    () => instantiateTemplate(db, chain.project.id, chain.template.id, { variables: {}, name: "invalid integrator", autoStart: false } as any),
    (error: unknown) => error instanceof Error && new RegExp(INTEGRATOR_AGENT_NAME).test(error.message),
  );
});

/* -------------------------------------------------------------- the scheduler */

/** A schedule row that the API route would have refused, written straight to the
 *  database — which is exactly the state a pre-guard row would be in after an
 *  upgrade, and the reason the fire paths check again rather than trusting it. */
const scheduledSentinelTask = async (chain: IntegratorChain, kind: "CRON" | "AT") => db.task.create({
  data: {
    projectId: chain.project.id, repoId: chain.repo.id,
    name: `scheduled-${kind}`, description: "fire me",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: chain.integratorAgent.id,
    status: TaskStatus.TODO, scheduleKind: kind,
    ...(kind === "CRON" ? { cron: "*/5 * * * *", timezone: "UTC" } : {}),
    runAt: new Date(Date.now() - 1_000),
  },
});

test("a recurring definition assigned to the sentinel is quarantined instead of fired", async () => {
  const chain = await seedIntegratorChain(db, { label: "cron" });
  const task = await scheduledSentinelTask(chain, "CRON");
  let quarantined = 0;
  const fired = await fireCronTask(db, task as any, new Date(), () => { quarantined += 1; });
  assert.equal(fired, false);
  assert.equal(quarantined, 1);
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 0);
  // Quarantine is `runAt: null` on a live CRON definition — the marker the
  // scheduler's own sweep reads, so the row is not retried every tick.
  const after = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(after.runAt, null);
});

test("a one-shot schedule assigned to the sentinel is quarantined instead of fired", async () => {
  const chain = await seedIntegratorChain(db, { label: "at" });
  const task = await scheduledSentinelTask(chain, "AT");
  assert.equal(await fireAtTask(db, task as any, new Date()), false);
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 0);
});

/* ------------------------------------------------------------ enqueue and retry */

test("enqueueTaskRun refuses a mis-bound task before a run row exists", async () => {
  const chain = await seedIntegratorChain(db, { label: "enqueue" });
  await db.task.update({
    where: { id: chain.integratorTask!.id },
    data: { assigneeAgentId: chain.agent.id },
  });
  await assert.rejects(
    () => db.$transaction((tx) => enqueueTaskRun(tx as any, chain.integratorTask!.id)),
    (error: unknown) => isIntegratorBindingError(error),
  );
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 0);
});

test("retry refuses a mis-bound integrator task", async () => {
  const chain = await seedIntegratorChain(db, { label: "retry" });
  await db.run.create({ data: {
    projectId: chain.project.id, taskId: chain.integratorTask!.id, agentId: chain.integratorAgent.id,
    repoId: chain.repo.id, runNumber: 1, dedupeKey: `task:${chain.integratorTask!.id}:run:1`,
    runner: "CLAUDE", model: "mechanical/merge-executor-v1", promptHash: "mechanical",
    status: "FAILED", failureClass: "TRANSIENT_PROVIDER", opensPullRequest: false,
  } });
  await db.task.update({
    where: { id: chain.integratorTask!.id },
    data: { assigneeAgentId: chain.agent.id, status: TaskStatus.TODO },
  });
  await db.task.update({
    where: { id: chain.gateTask.id },
    data: { status: TaskStatus.DONE },
  });
  const activitiesBefore = await db.taskActivity.count({ where: { taskId: chain.integratorTask!.id } });
  const inboxBefore = await db.inboxMessage.count({ where: { taskId: chain.integratorTask!.id } });
  const refused = await call("POST", `/tasks/${chain.integratorTask!.id}/retry`);
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /merge-integrator/);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, TaskStatus.TODO);
  assert.equal(await db.taskActivity.count({ where: { taskId: chain.integratorTask!.id } }), activitiesBefore);
  assert.equal(await db.inboxMessage.count({ where: { taskId: chain.integratorTask!.id } }), inboxBefore);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id, status: "QUEUED" } }), 0);
});

/* ------------------------------------------------------------------- the claim */

/** Queues the integrator step's run the way the chain does, then hands it to
 *  whichever runner the test names. */
const queueIntegratorRun = async (chain: IntegratorChain): Promise<string> => {
  await db.task.update({ where: { id: chain.integratorTask!.id }, data: { status: TaskStatus.TODO } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx as any, chain.integratorTask!.id));
  return (run as { id: string }).id;
};

const queuePeerIntegratorRun = async (chain: IntegratorChain, targetBranch: string): Promise<string> => {
  const task = await db.task.create({ data: {
    projectId: chain.project.id,
    repoId: chain.repo.id,
    templateId: chain.template.id,
    templateStepId: chain.integratorStep!.id,
    name: `Merge ${targetBranch}`,
    description: "merge",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: chain.integratorAgent.id,
    approvalGate: false,
    opensPullRequest: false,
    chainId: `peer-${targetBranch}-${Date.now()}-${Math.random()}`,
    chainIndex: chain.integratorStep!.stepIndex,
    chainLayer: chain.integratorStep!.layer,
    status: TaskStatus.TODO,
    targetBranch,
  } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx as any, task.id));
  return (run as { id: string }).id;
};

const concurrentExecutorClaims = async (): Promise<Response[]> => withTokens(async () => {
  const app = createApp(db);
  const request = () => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${EXECUTOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: EXECUTOR_RUNNER, contractVersion: RUN_COMPLETION_CONTRACT_VERSION }),
  });
  return Promise.all([request(), request()]);
});

test("only an allowlisted merge executor may claim the integrator step", async () => {
  const chain = await seedIntegratorChain(db, { label: "claim" });
  const runId = await queueIntegratorRun(chain);

  // An ordinary model runner is offered nothing — not the run, and not a
  // different one, because there is no other queued run.
  const ordinary = await claim("runner-1");
  assert.equal(ordinary.status, 204, JSON.stringify(ordinary.body));

  // And neither is a runner that simply *says* it is the executor. `runnerId`
  // is a self-reported label; the shared RUNNER_TOKEN authenticates a runner
  // principal, which is offered no mechanical run whatever id it claims.
  const impostor = await claim(EXECUTOR_RUNNER, RUNNER);
  assert.equal(impostor.status, 204, JSON.stringify(impostor.body));

  // Nor does the executor's own credential let it borrow another id: the
  // allowlist is a second, independent condition on mechanical work.
  const offAllowlist = await claim("runner-1", EXECUTOR_TOKEN);
  assert.equal(offAllowlist.status, 204, JSON.stringify(offAllowlist.body));

  const executor = await claim(EXECUTOR_RUNNER);
  assert.equal(executor.status, 200, JSON.stringify(executor.body));
  assert.equal(executor.body.run.id, runId);
  // The claim tells the claimant what it is holding, and the ordinary runner's
  // hard refusal keys on exactly this field.
  assert.equal(executor.body.executionMode, "mechanical");
});

test("concurrent Integrator claims serialize per repository target and leave the later run queued", async () => {
  const chain = await seedIntegratorChain(db, { label: "claim-serialized" });
  const firstRunId = await queueIntegratorRun(chain);
  const secondRunId = await queuePeerIntegratorRun(chain, "master");

  const responses = await concurrentExecutorClaims();
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 204]);
  const runs = await db.run.findMany({
    where: { id: { in: [firstRunId, secondRunId] } },
    select: { id: true, status: true },
  });
  assert.equal(runs.filter((run) => run.status === "CLAIMED").length, 1);
  assert.equal(runs.filter((run) => run.status === "QUEUED").length, 1);
});

test("concurrent Integrator claims for different target branches do not serialize each other", async () => {
  const chain = await seedIntegratorChain(db, { label: "claim-independent-targets" });
  const firstRunId = await queueIntegratorRun(chain);
  const secondRunId = await queuePeerIntegratorRun(chain, "release");

  const responses = await concurrentExecutorClaims();
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(await db.run.count({
    where: { id: { in: [firstRunId, secondRunId] }, status: "CLAIMED" },
  }), 2);
});

test("the merge executor is offered no ordinary run", async () => {
  const chain = await seedIntegratorChain(db, { label: "claim-ordinary" });
  const ordinaryTask = await db.task.create({ data: {
    projectId: chain.project.id, repoId: chain.repo.id, name: "Ordinary", description: "work",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: chain.agent.id, status: TaskStatus.TODO,
  } });
  await db.$transaction((tx) => enqueueTaskRun(tx as any, ordinaryTask.id));

  const executor = await claim(EXECUTOR_RUNNER);
  assert.equal(executor.status, 204, JSON.stringify(executor.body));

  const ordinary = await claim("runner-1");
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body));
  assert.equal(ordinary.body.task.id, ordinaryTask.id);
  assert.equal(ordinary.body.executionMode, "agent");
});

test("with no allowlist configured the integrator step is claimable by nobody", async () => {
  const chain = await seedIntegratorChain(db, { label: "claim-closed" });
  await queueIntegratorRun(chain);
  const prior = process.env.MERGE_EXECUTOR_RUNNER_IDS;
  const priorToken = process.env.MERGE_EXECUTOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  process.env.MERGE_EXECUTOR_TOKEN = EXECUTOR_TOKEN;
  delete process.env.MERGE_EXECUTOR_RUNNER_IDS;
  try {
    // The shipped default is an empty allowlist, and it must fail closed: an
    // unconfigured deployment does not merge, it stalls.
    for (const [runnerId, token] of [["runner-1", RUNNER], [EXECUTOR_RUNNER, EXECUTOR_TOKEN]] as const) {
      const response = await createApp(db).request("/runner/tasks/claim", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ runnerId, contractVersion: RUN_COMPLETION_CONTRACT_VERSION }),
      });
      assert.equal(response.status, 204, runnerId);
    }
  } finally {
    if (prior === undefined) delete process.env.MERGE_EXECUTOR_RUNNER_IDS;
    else process.env.MERGE_EXECUTOR_RUNNER_IDS = prior;
    if (priorToken === undefined) delete process.env.MERGE_EXECUTOR_TOKEN;
    else process.env.MERGE_EXECUTOR_TOKEN = priorToken;
    delete process.env.OPERATOR_TOKEN;
    delete process.env.RUNNER_TOKEN;
  }
});

test("a mis-bound queued run is skipped by every claimant rather than handed out", async () => {
  const chain = await seedIntegratorChain(db, { label: "claim-misbound" });
  const runId = await queueIntegratorRun(chain);
  // Reassign *after* the run is queued: the enqueue guard cannot see this, and
  // the claim transaction is the last surface between the row and an adapter.
  await db.task.update({
    where: { id: chain.integratorTask!.id },
    data: { assigneeAgentId: chain.agent.id },
  });
  await db.run.update({ where: { id: runId }, data: { agentId: chain.agent.id } });

  for (const runnerId of ["runner-1", EXECUTOR_RUNNER]) {
    const response = await claim(runnerId);
    assert.equal(response.status, 204, runnerId);
  }
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).status, "QUEUED");
});

/* ------------------------------------------------------- the sentinel is inert */

test("the agents list marks the sentinel unassignable", async () => {
  const chain = await seedIntegratorChain(db, { label: "agents" });
  const listed = await call("GET", `/projects/${chain.project.id}/agents`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const sentinel = listed.body.find((agent: any) => agent.name === INTEGRATOR_AGENT_NAME);
  assert.ok(sentinel, "the sentinel is listed, not hidden — an operator must be able to see it");
  assert.equal(sentinel.mechanical, true);
  assert.equal(sentinel.assignable, false);
  const ordinary = listed.body.find((agent: any) => agent.id === chain.agent.id);
  assert.equal(ordinary.mechanical, false);
  assert.equal(ordinary.assignable, true);
});

test("the integrator step is the only step the sentinel matches", async () => {
  // The fixture's own shape, asserted once: every test above rests on step 12
  // being an integrator step and step 11 not being one, and `isIntegratorStep`
  // is a conjunction over three fields that a fixture can silently get wrong.
  const chain = await seedIntegratorChain(db, { label: "shape" });
  assert.equal(chain.integratorStep!.stepIndex, INTEGRATOR_STEP_INDEX);
  assert.equal(chain.integratorStep!.outputKind, INTEGRATOR_OUTPUT_KIND);
  assert.equal(chain.integratorAgent.name, INTEGRATOR_AGENT_NAME);
  assert.notEqual(chain.gateStep.outputKind, INTEGRATOR_OUTPUT_KIND);
});
