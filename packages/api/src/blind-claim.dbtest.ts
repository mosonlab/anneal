import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DependencyProvisioning, DIRECT_TEMPLATE_NAME, enqueueTaskRun, INTEGRATOR_TEMPLATE_NAME, PrismaClient, RunStatus } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";
import { instantiateTemplate } from "./templates.js";

const execFileAsync = promisify(execFile);
const DB_DIRECTORY = fileURLToPath(new URL("../../db", import.meta.url));
const RUNNER_TOKEN = "blind-claim-runner-token";
const OPERATOR_TOKEN = "blind-claim-operator-token";
const SPECIFICATION_BRIEF = "Blind-claim specification fixture brief.";
const specificationReader = {
  readFileAtCommit: async (): Promise<Uint8Array> => new TextEncoder().encode(SPECIFICATION_BRIEF),
};
/** The head both reviews were bound to, and the head the fix starts from. */
const REVIEWED_HEAD = "e".repeat(40);
/** Where the implementation Task's first Run started: the base the platform
 *  pins every review to, whatever a later Run or an output body says. */
const IMPLEMENTATION_BASE = "b".repeat(40);
const UNIQUE_PREDECESSOR_FINDING = {
  id: "SOL-UNIQUE-1",
  severity: "P1",
  file: "src/unique.ts",
  line: 17,
  title: "Unique predecessor defect",
  evidence: "Only the predecessor review observed this defect.",
  requiredFix: "Close the unique defect.",
} as const;
const UNIQUE_BLIND_FINDING = {
  id: "BLIND-UNIQUE-1",
  severity: "P2",
  file: "src/blind.ts",
  line: 23,
  title: "Unique blind observation",
  evidence: "Only the blind reviewer observed this non-blocking issue.",
  requiredFix: "Record the observation for later cleanup.",
} as const;

let db: PrismaClient;
const priorRunnerToken = process.env.RUNNER_TOKEN;
const priorOperatorToken = process.env.OPERATOR_TOKEN;

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR_TOKEN;
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

const seedCanonicalTemplate = async (templateName: typeof DIRECT_TEMPLATE_NAME | typeof INTEGRATOR_TEMPLATE_NAME = INTEGRATOR_TEMPLATE_NAME) => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "prisma/seed.ts"],
    { cwd: DB_DIRECTORY, env: { ...process.env, DATABASE_URL: testDatabaseUrl } },
  );
  assert.equal(stderr, "", stderr);
  assert.match(stdout, /Seeded .* agents\//u);

  const template = await db.taskTemplate.findFirstOrThrow({
    where: { name: templateName },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  const repo = await db.repo.create({ data: {
    projectId: template.projectId,
    name: "blind-claim-repo",
    remoteUrl: "https://github.com/acme/blind-claim.git",
    mountPath: "/repo",
    defaultBranch: "main",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  const agentIds = [...new Set(template.steps.flatMap((step) => step.assigneeAgentId ? [step.assigneeAgentId] : []))];
  await db.agentRepoAccess.createMany({ data: agentIds.map((agentId) => ({
    projectId: template.projectId,
    agentId,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  })) });
  return { template, repo };
};

const queueCanonicalStep = async (
  template: Awaited<ReturnType<typeof seedCanonicalTemplate>>["template"],
  repoId: string,
  stepIndex: number,
) => {
  const chain = await instantiateTemplate(db, template.projectId, template.id, {
    repoId,
    variables: { branchName: `blind-claim-step-${stepIndex}` },
    name: `blind-claim-step-${stepIndex}`,
    description: SPECIFICATION_BRIEF,
    autoStart: true,
  });
  await db.run.deleteMany({ where: { taskId: { in: chain.tasks.map((task) => task.id) } } });
  const priorTasks = chain.tasks.filter((task) => task.chainIndex !== null && task.chainIndex < stepIndex);
  await db.task.updateMany({
    where: { id: { in: priorTasks.map((task) => task.id) } },
    data: { status: "DONE" },
  });
  const target = chain.tasks.find((task) => task.chainIndex === stepIndex);
  assert.ok(target, `canonical step ${stepIndex} must exist`);
  const targetTemplateStep = template.steps.find((step) => step.id === target.templateStepId);
  assert.ok(targetTemplateStep, `materialized step ${stepIndex} must retain its template identity`);
  // The pinned base belongs to the review layer, not necessarily to the target
  // step: the fix step that now follows the reviews pins nothing itself, and
  // its review siblings still need the implementation output they point at.
  // Unbound direct chains omit revalidation and densely number materialized
  // tasks, so baseFromStepIndex must resolve through template identity.
  const sourceStepIndex = targetTemplateStep.baseFromStepIndex
    ?? template.steps
      .filter((step) => step.stepIndex < targetTemplateStep.stepIndex)
      .reduce<number | null>((found, step) => step.baseFromStepIndex ?? found, null);
  const sourceTemplateStep = sourceStepIndex === null
    ? null
    : template.steps.find((step) => step.stepIndex === sourceStepIndex) ?? null;
  const sourceTask = sourceStepIndex === null
    ? null
    : priorTasks.find((task) => task.templateStepId === sourceTemplateStep?.id) ?? null;
  const sourceRun = sourceTask
    ? await db.$transaction((tx) => enqueueTaskRun(tx as never, sourceTask.id))
    : null;
  // The implementation Task's first Run records where the implementation
  // started, and that record is what every review is pinned to.
  if (sourceRun) {
    await db.run.update({
      where: { id: sourceRun.id },
      data: { status: RunStatus.SUCCEEDED, baseSha: IMPLEMENTATION_BASE },
    });
  }
  // Model the exact-head recovery publisher on top of it: a second Run whose
  // workspace starts at the already-implemented head. It authors the canonical
  // output, and it must not move the base the reviews are pinned to.
  const recoveryRun = sourceRun && sourceTask
    ? await (async () => {
      await db.task.update({ where: { id: sourceTask.id }, data: { status: "TODO" } });
      const run = await db.$transaction((tx) => enqueueTaskRun(tx as never, sourceTask.id));
      await db.run.update({
        where: { id: run.id },
        data: { status: RunStatus.SUCCEEDED, baseSha: "5".padStart(40, "0") },
      });
      await db.task.update({ where: { id: sourceTask.id }, data: { status: "DONE" } });
      return run;
    })()
    : null;
  await db.taskStepOutput.createMany({ data: priorTasks.map((task) => {
    const headSha = String(task.chainIndex).padStart(40, "0");
    const implementationSource = task.id === sourceTask?.id && recoveryRun;
    return {
      taskId: task.id,
      ...(implementationSource ? { runId: recoveryRun.id } : {}),
      kind: implementationSource ? "implementation" : `step-${task.chainIndex}`,
      body: implementationSource
        ? JSON.stringify({
          // Informational only: the platform pins from its own Run records.
          baseSha: IMPLEMENTATION_BASE,
          schemaVersion: 1,
          headSha,
          summary: "implemented before exact-head recovery",
          testsRun: ["focused"],
        })
        : `persisted output from step ${task.chainIndex}`,
      commitSha: headSha,
    };
  }) });
  if (template.name === INTEGRATOR_TEMPLATE_NAME) {
    const specificationTask = chain.tasks.find((task) => task.chainIndex === 1);
    assert.ok(specificationTask);
    await db.taskStepOutput.upsert({
      where: { taskId: specificationTask.id },
      create: {
        taskId: specificationTask.id,
        kind: "spec",
        body: JSON.stringify({ schemaVersion: 1, headSha: REVIEWED_HEAD, spec: SPECIFICATION_BRIEF }),
        commitSha: REVIEWED_HEAD,
      },
      update: {
        kind: "spec",
        body: JSON.stringify({ schemaVersion: 1, headSha: REVIEWED_HEAD, spec: SPECIFICATION_BRIEF }),
        commitSha: REVIEWED_HEAD,
      },
    });
  }
  const run = await db.$transaction((tx) => enqueueTaskRun(tx as never, target.id));
  return { run, chain };
};

const claim = async () => {
  const response = await createApp(db, { specificationReader }).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "blind-claim-runner", leaseSeconds: 60 }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    run: {
      id: string;
      targetBranch: string;
      pinnedBaseSha: string | null;
      implementationBaseSha: string | null;
      implementationHeadSha: string | null;
    };
    task: {
      templateStep: { provisionDependencies: boolean } | null;
    };
    priorOutputs: Array<{ kind: string; body: string }>;
    operatorNotes: string[];
    sessionToken: string;
    fencingToken: string;
  }>;
};

test("review claims carry the stored dependency-provisioning policy", async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const reviewStep = template.steps.find((step) => step.stepIndex === 7);
  assert.ok(reviewStep, "canonical blind review step must exist");
  await db.taskTemplateStep.update({
    where: { id: reviewStep.id },
    data: { provisionDependencies: false },
  });

  const review = await queueCanonicalStep(template, repo.id, 7);
  const claimed = await claim();
  assert.equal(claimed.run.id, review.run.id);
  assert.equal(claimed.task.templateStep?.provisionDependencies, false);
});

const reviewReport = (kind: "review-findings" | "blind-findings", headSha: string, baseSha = "b".repeat(40)) => JSON.stringify({
  schemaVersion: 1,
  headSha,
  reviewedBase: baseSha,
  reviewedHead: headSha,
  findings: kind === "review-findings" ? [UNIQUE_PREDECESSOR_FINDING] : [UNIQUE_BLIND_FINDING],
  ...(kind === "review-findings" ? { commandsRun: ["git diff --check"] } : {}),
});

const prepareReviewReport = async (
  chain: Awaited<ReturnType<typeof queueCanonicalStep>>["chain"],
  stepIndex: number,
  kind: "review-findings" | "blind-findings",
  headSha: string,
  baseSha = "b".repeat(40),
) => {
  const task = chain.tasks.find((candidate) => candidate.chainIndex === stepIndex);
  assert.ok(task, `review task ${stepIndex} must exist`);
  await db.task.update({ where: { id: task.id }, data: { status: "TODO" } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx as never, task.id));
  const now = new Date();
  await db.run.update({ where: { id: run.id }, data: {
    status: "SUCCEEDED",
    baseSha: baseSha,
    headSha: headSha,
    startedAt: now,
    endedAt: now,
  } });
  await db.taskStepOutput.deleteMany({ where: { taskId: task.id } });
  await db.taskStepOutput.create({ data: {
    taskId: task.id,
    runId: run.id,
    kind,
    body: reviewReport(kind, headSha, baseSha),
    commitSha: headSha,
  } });
  await db.task.update({ where: { id: task.id }, data: { status: "DONE" } });
  return { task, run };
};

const prepareFixedImplementation = async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const fix = await queueCanonicalStep(template, repo.id, 8);
  const sol = await prepareReviewReport(fix.chain, 6, "review-findings", REVIEWED_HEAD);
  await prepareReviewReport(fix.chain, 7, "blind-findings", REVIEWED_HEAD);
  const claimed = await claim();
  assert.equal(claimed.run.id, fix.run.id);
  const fixedHead = "a".repeat(40);
  const closed = (id: string) => ({
    id,
    status: "CLOSED",
    codeEvidence: `fixed ${id}`,
    testEvidence: `covered ${id}`,
  });
  const body = {
    schemaVersion: 1,
    headSha: fixedHead,
    sourceHead: REVIEWED_HEAD,
    dispositions: [
      { id: UNIQUE_PREDECESSOR_FINDING.id, disposition: "ADOPTED", reason: "confirmed" },
      { id: UNIQUE_BLIND_FINDING.id, disposition: "REJECTED", reason: "follow-up only" },
    ],
    closedFindings: [closed(UNIQUE_PREDECESSOR_FINDING.id)],
    testsRun: ["focused"],
    residualRisks: [],
  };
  const write = () => createApp(db).request(`/session/runs/${fix.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: claimed.fencingToken,
      kind: "fixed-implementation",
      body: JSON.stringify(body),
      commitSha: fixedHead,
    }),
  });
  return { sol, write };
};

const addSuccessfulReviewRetry = async (
  review: Awaited<ReturnType<typeof prepareReviewReport>>,
  headSha: string,
) => {
  await db.run.update({ where: { id: review.run.id }, data: { status: RunStatus.LOST } });
  await db.task.update({ where: { id: review.task.id }, data: { status: "TODO" } });
  const retry = await db.$transaction((tx) => enqueueTaskRun(tx as never, review.task.id));
  const now = new Date();
  await db.run.update({ where: { id: retry.id }, data: {
    status: RunStatus.SUCCEEDED,
    headSha,
    startedAt: now,
    endedAt: now,
  } });
  await db.task.update({ where: { id: review.task.id }, data: { status: "DONE" } });
};

test("blind session cannot read Sol evidence before or after its immutable report", async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const blind = await queueCanonicalStep(template, repo.id, 7);
  const claimed = await claim();
  assert.equal(claimed.run.id, blind.run.id);
  assert.deepEqual(claimed.priorOutputs, []);
  assert.equal(claimed.run.pinnedBaseSha, claimed.run.targetBranch);
  assert.equal(claimed.run.implementationBaseSha, IMPLEMENTATION_BASE);
  assert.equal(claimed.run.implementationHeadSha, claimed.run.targetBranch);

  const activityPath = `/session/runs/${blind.run.id}/chain/steps/6/activity`;
  const before = await createApp(db).request(activityPath, {
    headers: { Authorization: `Bearer ${claimed.sessionToken}` },
  });
  assert.equal(before.status, 403);

  const body = reviewReport("blind-findings", claimed.run.targetBranch);
  const persisted = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: claimed.fencingToken,
      kind: "blind-findings",
      body,
      commitSha: claimed.run.targetBranch,
    }),
  });
  const persistedText = await persisted.text();
  assert.equal(persisted.status, 200, persistedText);
  assert.deepEqual((JSON.parse(persistedText) as { predecessorOutputs: unknown[] }).predecessorOutputs, []);

  const rewrite = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: claimed.fencingToken,
      kind: "blind-findings",
      body: reviewReport("blind-findings", claimed.run.targetBranch, "c".repeat(40)),
      commitSha: claimed.run.targetBranch,
    }),
  });
  assert.equal(rewrite.status, 409);
  assert.match(await rewrite.text(), /immutable/u);

  const operatorRewrite = await createApp(db).request(`/tasks/${blind.chain.tasks.find((task) => task.chainIndex === 7)!.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "blind-findings",
      body: reviewReport("blind-findings", claimed.run.targetBranch, "c".repeat(40)),
      commitSha: claimed.run.targetBranch,
    }),
  });
  assert.equal(operatorRewrite.status, 409);
  assert.match(await operatorRewrite.text(), /immutable/u);

  const after = await createApp(db).request(activityPath, {
    headers: { Authorization: `Bearer ${claimed.sessionToken}` },
  });
  assert.equal(after.status, 403);
  const status = await createApp(db).request(`/session/runs/${blind.run.id}/status`, {
    headers: { Authorization: `Bearer ${claimed.sessionToken}` },
  });
  assert.equal(status.status, 200, await status.text());
});

test("Sol review receives the implementation output while its blind sibling remains isolated", async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const sol = await queueCanonicalStep(template, repo.id, 6);
  const claimed = await claim();
  assert.equal(claimed.run.id, sol.run.id);
  assert.deepEqual(claimed.priorOutputs.map(({ kind }) => kind), ["implementation"]);
  assert.match(claimed.priorOutputs[0]!.body, /implemented before exact-head recovery/u);
});

test("retried blind-findings claims do not receive operator activity as prompt notes", async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const blind = await queueCanonicalStep(template, repo.id, 7);
  const task = blind.chain.tasks.find((candidate) => candidate.chainIndex === 7);
  assert.ok(task);
  await db.run.update({ where: { id: blind.run.id }, data: { status: "SUCCEEDED", endedAt: new Date() } });
  await db.task.update({ where: { id: task.id }, data: { status: "REVIEW" } });

  const note = await createApp(db).request(`/tasks/${task.id}/activity`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ body: "This must not reach an independent blind review." }),
  });
  assert.equal(note.status, 201, await note.text());
  await db.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "operator",
    body: "Approval gate rejected; step queued again\nOperator feedback on previous attempt:\nSibling review content must remain hidden.",
    metadata: { approvalGateFeedback: true, note: "Sibling review content must remain hidden." },
  } });
  const retry = await createApp(db).request(`/tasks/${task.id}/retry`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, "Content-Type": "application/json" },
  });
  assert.equal(retry.status, 201, await retry.text());

  const claimed = await claim();
  assert.deepEqual(claimed.operatorNotes, []);
  assert.equal((claimed as { operatorFeedback?: string }).operatorFeedback, undefined);
});

test("the fix step claims both immutable reports and cannot rewrite either", async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const fix = await queueCanonicalStep(template, repo.id, 8);
  const headSha = REVIEWED_HEAD;
  await prepareReviewReport(fix.chain, 6, "review-findings", headSha);
  await prepareReviewReport(fix.chain, 7, "blind-findings", headSha);

  const response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "fix-claim-runner", leaseSeconds: 60 }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const claimBody = JSON.parse(responseText) as {
    run: { id: string; implementationBaseSha: string | null; implementationHeadSha: string | null };
    priorOutputs: Array<{ kind: string; body: string }>;
  };
  assert.equal(claimBody.run.id, fix.run.id);
  // The fix step pins nothing: a pinned run is a detached empty checkout, and
  // this step has to commit the fixes on the chain branch.
  assert.equal(claimBody.run.implementationBaseSha, null);
  assert.equal(claimBody.run.implementationHeadSha, null);
  assert.ok(claimBody.priorOutputs.some((output) => output.kind === "review-findings"));
  assert.ok(claimBody.priorOutputs.some((output) => output.kind === "blind-findings"));

  const solTask = fix.chain.tasks.find((task) => task.chainIndex === 6)!;
  const originalSol = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: solTask.id } });
  const operatorRewrite = await createApp(db).request(`/tasks/${solTask.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "review-findings", body: reviewReport("review-findings", "d".repeat(40)), commitSha: "d".repeat(40) }),
  });
  assert.equal(operatorRewrite.status, 409);
  assert.equal((await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: solTask.id } })).body, originalSol.body);
});

test("a fixed implementation accepts a review output authored by a LOST Run after a matching successful retry", async () => {
  const { sol, write } = await prepareFixedImplementation();
  await addSuccessfulReviewRetry(sol, REVIEWED_HEAD);

  const response = await write();
  assert.equal(response.status, 200, await response.text());
});

test("a fixed implementation refuses when the only matching review Run failed", async () => {
  const { sol, write } = await prepareFixedImplementation();
  await db.run.update({ where: { id: sol.run.id }, data: { status: RunStatus.FAILED, headSha: REVIEWED_HEAD } });

  const response = await write();
  assert.equal(response.status, 409);
  assert.match(await response.text(), /sibling output is not backed by a successful completed Run/u);
});

test("a fixed implementation refuses when no successful review Run matches the output commit", async () => {
  const { sol, write } = await prepareFixedImplementation();
  await db.run.update({ where: { id: sol.run.id }, data: { status: RunStatus.SUCCEEDED, headSha: "f".repeat(40) } });

  const response = await write();
  assert.equal(response.status, 409);
  assert.match(await response.text(), /sibling output is not backed by a successful completed Run/u);
});


test("Direct and Full fix-step persistence requires exact union dispositions bound to the reviewed head", async () => {
  const FIXED_HEAD = "a".repeat(40);
  for (const shape of [
    { name: DIRECT_TEMPLATE_NAME, fix: 4, sol: 2, blind: 3 },
    { name: INTEGRATOR_TEMPLATE_NAME, fix: 8, sol: 6, blind: 7 },
  ] as const) {
    await resetTestDb(db);
    const { template, repo } = await seedCanonicalTemplate(shape.name);
    const fix = await queueCanonicalStep(template, repo.id, shape.fix);
    const headSha = REVIEWED_HEAD;
    await prepareReviewReport(fix.chain, shape.sol, "review-findings", headSha);
    await prepareReviewReport(fix.chain, shape.blind, "blind-findings", headSha);
    const claimed = await claim();
    assert.equal(claimed.run.id, fix.run.id);

    const write = (artifact: Record<string, unknown>) => createApp(db).request(`/session/runs/${fix.run.id}/output`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fencingToken: claimed.fencingToken,
        kind: "fixed-implementation",
        body: JSON.stringify(artifact),
        commitSha: FIXED_HEAD,
      }),
    });
    const closed = (id: string) => ({ id, status: "CLOSED", codeEvidence: `fixed ${id}`, testEvidence: `covered ${id}` });
    const base = {
      schemaVersion: 1,
      headSha: FIXED_HEAD,
      sourceHead: headSha,
      testsRun: ["focused"],
      residualRisks: [],
    };

    let response = await write({ ...base, dispositions: [], closedFindings: [] });
    assert.equal(response.status, 409, `${shape.name}: omitted`);
    assert.match(await response.text(), /missing:/u);

    response = await write({
      ...base,
      dispositions: [
        { id: UNIQUE_PREDECESSOR_FINDING.id, disposition: "ADOPTED", reason: "confirmed" },
        { id: UNIQUE_PREDECESSOR_FINDING.id, disposition: "MERGED", reason: "duplicate" },
        { id: UNIQUE_BLIND_FINDING.id, disposition: "ADOPTED", reason: "recorded" },
      ],
      closedFindings: [closed(UNIQUE_PREDECESSOR_FINDING.id), closed(UNIQUE_BLIND_FINDING.id)],
    });
    assert.equal(response.status, 409, `${shape.name}: duplicate`);
    assert.match(await response.text(), /duplicate ids/u);

    response = await write({
      ...base,
      dispositions: [
        { id: UNIQUE_PREDECESSOR_FINDING.id, disposition: "ADOPTED", reason: "confirmed" },
        { id: UNIQUE_BLIND_FINDING.id, disposition: "ADOPTED", reason: "recorded" },
        { id: "UNKNOWN-1", disposition: "REJECTED", reason: "not sourced" },
      ],
      closedFindings: [closed(UNIQUE_PREDECESSOR_FINDING.id), closed(UNIQUE_BLIND_FINDING.id)],
    });
    assert.equal(response.status, 409, `${shape.name}: unknown`);
    assert.match(await response.text(), /unknown: UNKNOWN-1/u);

    response = await write({
      ...base,
      dispositions: [
        { id: UNIQUE_PREDECESSOR_FINDING.id, disposition: "ADOPTED", reason: "confirmed" },
        { id: UNIQUE_BLIND_FINDING.id, disposition: "REJECTED", reason: "cosmetic" },
      ],
      closedFindings: [closed(UNIQUE_PREDECESSOR_FINDING.id), closed(UNIQUE_BLIND_FINDING.id)],
    });
    assert.equal(response.status, 409, `${shape.name}: closed without adoption`);
    assert.match(await response.text(), /must exactly cover the ADOPTED dispositions/u);

    response = await write({
      ...base,
      sourceHead: "c".repeat(40),
      dispositions: [
        { id: UNIQUE_PREDECESSOR_FINDING.id, disposition: "ADOPTED", reason: "confirmed" },
        { id: UNIQUE_BLIND_FINDING.id, disposition: "ADOPTED", reason: "recorded" },
      ],
      closedFindings: [closed(UNIQUE_PREDECESSOR_FINDING.id), closed(UNIQUE_BLIND_FINDING.id)],
    });
    assert.equal(response.status, 409, `${shape.name}: stale range`);
    assert.match(await response.text(), /sourceHead does not match/u);

    response = await write({
      ...base,
      dispositions: [
        { id: UNIQUE_PREDECESSOR_FINDING.id, disposition: "ADOPTED", reason: "confirmed" },
        { id: UNIQUE_BLIND_FINDING.id, disposition: "REJECTED", reason: "P2, follow-up only" },
      ],
      closedFindings: [closed(UNIQUE_PREDECESSOR_FINDING.id)],
    });
    assert.equal(response.status, 200, `${shape.name}: exact coverage ${await response.text()}`);
  }
});
