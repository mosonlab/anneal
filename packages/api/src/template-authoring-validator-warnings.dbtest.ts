import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { type PrismaClient } from "@anneal/db";

import { resetTestDb, setupTestDb } from "./testdb.js";
import {
  readStepSnapshots,
  replaceRequest,
  seedAuthoringTemplate,
  stepPayload,
  TEMPLATE_AUTHORING_OPERATOR,
} from "./template-authoring-test-helpers.js";

let db: PrismaClient;
let priorOperatorToken: string | undefined;

before(() => {
  priorOperatorToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = TEMPLATE_AUTHORING_OPERATOR;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
});

const warningCodes = (body: any): string[] => body.warnings.map((warning: any) => warning.code);

test("a graph without a review warns, and every recognized review role removes only that warning", async () => {
  const seed = await seedAuthoringTemplate(db, "warnings-review");
  const implementation = stepPayload(seed, 1, {
    layer: 1,
    outputKind: "implementation-v2",
    opensPullRequest: false,
  });
  const unknown = stepPayload(seed, 2, {
    layer: 2,
    outputKind: "operator-defined-v7",
  });
  const withoutReview = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [implementation, unknown],
  });
  assert.equal(withoutReview.status, 200, JSON.stringify(withoutReview.body));
  assert.deepEqual(warningCodes(withoutReview.body), ["no_review_step"]);

  const withReview = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [
      implementation,
      stepPayload(seed, 2, {
        layer: 2,
        outputKind: "review-findings-v7",
        assigneeAgentId: seed.agents[1]!.id,
        priorOutputKinds: ["implementation-v2"],
      }),
    ],
  });
  assert.equal(withReview.status, 200, JSON.stringify(withReview.body));
  assert.deepEqual(warningCodes(withReview.body), []);

  const withPlanReview = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [
      implementation,
      stepPayload(seed, 2, {
        layer: 2,
        outputKind: "plan-review-v3",
        assigneeAgentId: seed.agents[1]!.id,
        priorOutputKinds: ["implementation-v2"],
      }),
    ],
  });
  assert.equal(withPlanReview.status, 200, JSON.stringify(withPlanReview.body));
  assert.deepEqual(warningCodes(withPlanReview.body), []);
});

test("the same Agent implementing and reviewing warns, while different Agents remove it", async () => {
  const seed = await seedAuthoringTemplate(db, "warnings-self-review");
  const sameAgent = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [
      stepPayload(seed, 1, { layer: 1, outputKind: "implementation-v3" }),
      stepPayload(seed, 2, {
        layer: 2,
        outputKind: "blind-findings-v4",
        assigneeAgentId: seed.agents[0]!.id,
        priorOutputKinds: ["implementation-v3"],
      }),
    ],
  });
  assert.equal(sameAgent.status, 200, JSON.stringify(sameAgent.body));
  assert.deepEqual(warningCodes(sameAgent.body), ["same_agent_implements_and_reviews"]);

  const differentAgents = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [
      stepPayload(seed, 1, { layer: 1, outputKind: "implementation-v3" }),
      stepPayload(seed, 2, {
        layer: 2,
        outputKind: "blind-findings-v4",
        assigneeAgentId: seed.agents[1]!.id,
        priorOutputKinds: ["implementation-v3"],
      }),
    ],
  });
  assert.equal(differentAgents.status, 200, JSON.stringify(differentAgents.body));
  assert.deepEqual(warningCodes(differentAgents.body), []);
});

test("a pull request without regression names the lowest opening Step", async () => {
  const seed = await seedAuthoringTemplate(db, "warnings-regression");
  const withoutRegression = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [
      stepPayload(seed, 1, { layer: 1, outputKind: "implementation-v5", opensPullRequest: true }),
      stepPayload(seed, 2, {
        layer: 2,
        outputKind: "review-findings-v2",
        assigneeAgentId: seed.agents[1]!.id,
        priorOutputKinds: ["implementation-v5"],
      }),
      stepPayload(seed, 3, {
        layer: 3,
        outputKind: "operator-defined-v2",
        opensPullRequest: true,
      }),
    ],
  });
  assert.equal(withoutRegression.status, 200, JSON.stringify(withoutRegression.body));
  assert.deepEqual(warningCodes(withoutRegression.body), ["pull_request_without_regression"]);
  assert.equal(withoutRegression.body.warnings[0].stepIndex, 1);

  const withRegression = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [
      stepPayload(seed, 1, { layer: 1, outputKind: "implementation-v5", opensPullRequest: true }),
      stepPayload(seed, 2, {
        layer: 2,
        outputKind: "review-findings-v2",
        assigneeAgentId: seed.agents[1]!.id,
        priorOutputKinds: ["implementation-v5"],
      }),
      stepPayload(seed, 3, {
        layer: 3,
        outputKind: "regression-verification-v8",
        assigneeAgentId: seed.agents[2]!.id,
        priorOutputKinds: ["implementation-v5"],
      }),
    ],
  });
  assert.equal(withRegression.status, 200, JSON.stringify(withRegression.body));
  assert.deepEqual(warningCodes(withRegression.body), []);
});

test("warnings are complete on repeat, non-blocking, and ephemeral", async () => {
  const seed = await seedAuthoringTemplate(db, "warnings-ephemeral");
  const steps = [
    stepPayload(seed, 1, { layer: 1, outputKind: "implementation-v6", opensPullRequest: true }),
    stepPayload(seed, 2, { layer: 2, outputKind: "operator-defined-v8" }),
  ];
  const beforeTasks = await db.task.count();
  const first = await replaceRequest(db, seed.project.id, seed.template.id, { steps });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(warningCodes(first.body), ["no_review_step", "pull_request_without_regression"]);
  assert.equal(first.body.warnings[1].stepIndex, 1);
  const second = await replaceRequest(db, seed.project.id, seed.template.id, { steps });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(second.body.warnings, first.body.warnings);
  assert.equal(await db.task.count(), beforeTasks);
  assert.deepEqual(await readStepSnapshots(db, seed.template.id), steps.map((step, index) => ({
    ...step,
    stepIndex: index + 1,
  })));

  const read = await (await import("./test-app.js")).createApp(db).request(
    `/task-templates/${seed.template.id}`,
    { headers: { Authorization: `Bearer ${TEMPLATE_AUTHORING_OPERATOR}` } },
  );
  assert.equal(read.status, 200);
  const readBody = await read.json() as Record<string, unknown>;
  assert.equal("warnings" in readBody, false);
});
