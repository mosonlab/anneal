import assert from "node:assert/strict";
import test from "node:test";

import { LEGACY_TEMPLATE_GENERATIONS, type Prisma } from "@anneal/db";

import {
  isCanonicalAgentStep,
  isCanonicalBlindFindingsStep,
  isLegacyCombinedBlindReviewStep,
  isCanonicalFixStep,
  canonicalBodyRefusal,
  canonicalOutputRefusal,
  persistSessionTaskOutput,
  requiredOutputKind,
  salvageResumeEvidence,
  previousRunHandoffForClaim,
} from "./canonical-task-output.js";

const step = (template: string, stepIndex: number, outputKind: string) => ({
  taskTemplate: { name: template },
  stepIndex,
  outputKind,
});

type ReviewKind = "review-findings" | "blind-findings";

type ReviewTask = {
  id: string;
  templateStep: {
    stepIndex: number;
    outputKind: ReviewKind;
    taskTemplate: { name: string };
  };
  stepOutput: {
    runId: string | null;
    kind: string;
    body: string;
    commitSha: string | null;
    run: { taskId: string } | null;
  } | null;
};

const FIX_HEAD = "a".repeat(40);
const IMPLEMENTATION_HEAD = "d".repeat(40);
const RECORDED_BASE = "e".repeat(40);
const TYPED_BASE = "f".repeat(40);
const REVIEW_HEAD = "b".repeat(40);
const REVIEW_BASE = "c".repeat(40);

const reviewBody = (kind: ReviewKind, reviewedBase = REVIEW_BASE): string => JSON.stringify({
  schemaVersion: 1,
  headSha: REVIEW_HEAD,
  reviewedBase,
  reviewedHead: REVIEW_HEAD,
  findings: [],
  ...(kind !== "blind-findings" ? { commandsRun: ["git diff --check"] } : {}),
});

const fixedBody = (): string => JSON.stringify({
  schemaVersion: 1,
  headSha: FIX_HEAD,
  sourceHead: REVIEW_HEAD,
  dispositions: [],
  closedFindings: [],
  testsRun: ["focused"],
  residualRisks: [],
});

const reviewTask = (
  id: string,
  kind: ReviewKind,
  output: ReviewTask["stepOutput"] = {
    runId: `${id}-run`,
    kind,
    body: reviewBody(kind),
    commitSha: REVIEW_HEAD,
    run: { taskId: id },
  },
): ReviewTask => ({
  id,
  templateStep: {
    stepIndex: kind !== "blind-findings" ? 3 : 4,
    outputKind: kind,
    taskTemplate: { name: "direct-engineer-workflow" },
  },
  stepOutput: output,
});

const persistFixedOutput = async (input: {
  reviewTasks: ReviewTask[];
  successfulSiblingRuns?: Array<{ taskId: string; headSha: string }>;
  body?: string;
  /**
   * The chain's own witness of which review steps it instantiated. Defaults to
   * exactly the steps the review layer carries, which is the ordinary chain.
   */
  chainReviewSteps?: Array<{ outputKind: ReviewKind; instantiated: boolean }>;
}) => {
  const fixTask = {
    id: "fix-task",
    projectId: "project-1",
    chainId: "chain-1",
    chainIndex: 5,
    chainLayer: 3,
    status: "IN_PROGRESS",
    templateStep: {
      stepIndex: 5,
      outputKind: "fixed-implementation",
      taskTemplateId: "direct-template",
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  };
  const chainReviewSteps = input.chainReviewSteps ?? (["review-findings", "blind-findings"] as const).map(
    (outputKind) => ({
      outputKind,
      instantiated: input.reviewTasks.some((task) => task.templateStep.outputKind === outputKind),
    }),
  );
  const tx = {
    $queryRaw: async () => [{ id: "locked" }],
    run: {
      findFirst: async (args: { select?: Record<string, unknown> }) => (
        args.select && "taskId" in args.select
          ? { taskId: fixTask.id }
          : { task: fixTask }
      ),
      findMany: async () => input.successfulSiblingRuns ?? input.reviewTasks
        .flatMap((task) => task.stepOutput?.runId
          ? [{ taskId: task.id, headSha: task.stepOutput.commitSha ?? REVIEW_HEAD }]
          : []),
    },
    task: {
      findFirst: async () => ({ chainLayer: 2 }),
      findMany: async () => input.reviewTasks,
    },
    taskTemplateStep: {
      findMany: async () => chainReviewSteps.map(({ outputKind, instantiated }) => ({
        outputKind,
        tasks: instantiated ? [{ id: `${outputKind}-task` }] : [],
      })),
    },
    taskStepOutput: {
      findUnique: async () => null,
      upsert: async ({ create }: { create: Record<string, unknown> }) => ({
        id: "fixed-output",
        ...create,
        metadata: create.metadata ?? null,
      }),
    },
  } as unknown as Prisma.TransactionClient;
  return persistSessionTaskOutput(tx, {
    task: { id: fixTask.id },
    fence: {
      runId: "fix-run",
      fencingToken: "fence-token",
      at: new Date("2026-01-01T00:00:00.000Z"),
    },
    kind: "fixed-implementation",
    body: input.body ?? fixedBody(),
    commitSha: FIX_HEAD,
  });
};

test("agent-authored roles stop before readiness and integrator roles", () => {
  for (const outputKind of ["implementation", "blind-findings", "fixed-implementation", "regression-verification-v2"]) {
    assert.equal(isCanonicalAgentStep(step("any-template-generation", 99, outputKind)), true);
  }
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow", 6, "merge-authorization")), false);
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow", 7, "merge-result")), false);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow", 5, "unregistered")), false);
});

test("legacy agent roles remain authoritative without ordinal matching", () => {
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow-legacy-v1", 5, "must-fix")), true);
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow-legacy-v1", 6, "merge-authorization")), false);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow-legacy-v1", 100, "documentation")), true);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow-legacy-v1", 11, "merge-authorization")), false);
});

test("Regression v2 is canonical while the rolled v1 contract remains readable", () => {
  const headSha = "a".repeat(40);
  const baseHeadSha = "b".repeat(40);
  const current = step("direct-engineer-workflow", 5, "regression-verification-v2");
  const legacy = step(
    "direct-engineer-workflow-legacy-pre-narrow-regression-lease-template-1",
    5,
    "regression-verification",
  );
  const output = (kind: string, schemaVersion: number, bodyOverrides: Record<string, unknown> = {}) => ({
    runId: "run-1",
    kind,
    body: JSON.stringify({
      schemaVersion,
      outcome: "pass",
      headSha,
      baseHeadSha,
      gateVerdict: "PASS",
      ...(schemaVersion === 2 ? { gateProof: `MERGE GATE: PASS ${headSha}` } : {}),
      ...bodyOverrides,
    }),
    commitSha: headSha,
    metadata: null,
  });

  assert.equal(requiredOutputKind(current), "regression-verification-v2");
  assert.equal(canonicalOutputRefusal(current, output("regression-verification-v2", 2), "run-1", headSha), null);
  assert.match(
    canonicalOutputRefusal(current, output("regression-verification-v2", 1), "run-1", headSha) ?? "",
    /schemaVersion 2/u,
  );
  assert.match(
    canonicalOutputRefusal(current, output("regression-verification-v2", 2, {
      gateProof: `MERGE GATE: PASS ${baseHeadSha}`,
    }), "run-1", headSha) ?? "",
    /gate proof oid must match headSha/u,
  );
  assert.match(
    canonicalOutputRefusal(current, output("regression-verification-v2", 2, {
      gateProof: undefined,
    }), "run-1", headSha) ?? "",
    /gateProof/u,
  );
  assert.equal(isCanonicalAgentStep(legacy), true);
  assert.equal(requiredOutputKind(legacy), "regression-verification");
  assert.equal(canonicalOutputRefusal(legacy, output("regression-verification", 1), "run-1", headSha), null);
});

test("the canonical graphs carry blind findings and no adjudication node", () => {
  assert.equal(isCanonicalBlindFindingsStep(step("direct-engineer-workflow", 3, "blind-findings")), true);
  assert.equal(isCanonicalBlindFindingsStep(step("compound-engineer-workflow", 7, "blind-findings")), true);
});

test("the retired combined review role is recognized by output kind", () => {
  assert.equal(isLegacyCombinedBlindReviewStep(step("direct-engineer-workflow-legacy-v1", 3, "must-fix")), true);
  assert.equal(isLegacyCombinedBlindReviewStep(step("compound-engineer-workflow-legacy-v1", 7, "must-fix")), true);
  assert.equal(isLegacyCombinedBlindReviewStep(step("any-template-generation", 99, "must-fix")), true);
  assert.equal(isLegacyCombinedBlindReviewStep(step("direct-engineer-workflow-legacy-v1", 3, "blind-findings")), false);
});

test("blind-findings is a versioned immutable review output and cannot be authored by another step", () => {
  const headSha = "a".repeat(40);
  const blindStep = step("direct-engineer-workflow", 3, "blind-findings");
  const body = JSON.stringify({
    schemaVersion: 1,
    headSha,
    reviewedBase: "b".repeat(40),
    reviewedHead: headSha,
    findings: [],
  });
  assert.equal(canonicalOutputRefusal(blindStep, {
    runId: "run-1",
    kind: "blind-findings",
    body,
    commitSha: headSha,
    metadata: null,
  }, "run-1", headSha), null);
});

test("the retired review output kind has a named canonical refusal", () => {
  const retiredReviewKind = LEGACY_TEMPLATE_GENERATIONS["direct-engineer-workflow"]
    .find(({ marker }) => marker === "pre-model-neutral-review-output")?.shape
    .find(({ name }) => name === "Code review")?.outputKind;
  assert.ok(retiredReviewKind);
  assert.equal(
    canonicalBodyRefusal(
      step("direct-engineer-workflow", 2, retiredReviewKind),
      JSON.stringify({ schemaVersion: 1 }),
      "a".repeat(40),
      null,
    ),
    `canonical output kind ${retiredReviewKind} has no versioned JSON contract`,
  );
});

test("immutable findings from a prior Run are accepted only after canonical validation", () => {
  const headSha = "a".repeat(40);
  const baseSha = "b".repeat(40);
  const reviewBody = (kind: ReviewKind, overrides: Record<string, unknown> = {}) => JSON.stringify({
    schemaVersion: 1,
    headSha,
    reviewedBase: baseSha,
    reviewedHead: headSha,
    findings: [],
    ...(kind !== "blind-findings" ? { commandsRun: ["git diff --check"] } : {}),
    ...overrides,
  });

  for (const kind of ["review-findings", "blind-findings"] as const) {
    const reviewStep = step("direct-engineer-workflow", kind !== "blind-findings" ? 2 : 3, kind);
    const output = (overrides: Partial<{
      runId: string | null;
      kind: string;
      body: string;
      commitSha: string;
    }> = {}) => ({
      runId: "run-1",
      kind,
      body: reviewBody(kind),
      commitSha: headSha,
      metadata: null,
      ...overrides,
    });

    assert.equal(canonicalOutputRefusal(reviewStep, output(), "run-2", headSha), null);
    assert.match(
      canonicalOutputRefusal(reviewStep, output({ runId: null }), "run-2", headSha) ?? "",
      /belongs to prior Run none, not current Run run-2/u,
    );
    assert.match(
      canonicalOutputRefusal(reviewStep, output({ kind: "implementation" }), "run-2", headSha) ?? "",
      /does not match canonical kind/u,
    );
    assert.match(
      canonicalOutputRefusal(reviewStep, output({ commitSha: baseSha }), "run-2", headSha) ?? "",
      /is bound to b{40}, not completion head a{40}/u,
    );
    assert.match(
      canonicalOutputRefusal(reviewStep, output({ body: reviewBody(kind, { findings: "invalid" }) }), "run-2", headSha) ?? "",
      /body violates schemaVersion 1/u,
    );
  }
});

test("a fixed-implementation output must close exactly the findings it adopted", () => {
  const headSha = "a".repeat(40);
  const sourceHead = "b".repeat(40);
  const fixStep = step("compound-engineer-workflow", 8, "fixed-implementation");
  assert.equal(isCanonicalFixStep(fixStep), true);
  assert.equal(isCanonicalFixStep(step("compound-engineer-workflow", 99, "fixed-implementation")), true);
  assert.equal(isCanonicalFixStep(step("compound-engineer-workflow", 8, "documentation")), false);
  assert.equal(isCanonicalFixStep(step("direct-engineer-workflow", 4, "fixed-implementation")), true);
  const artifact = (overrides: Record<string, unknown>) => JSON.stringify({
    schemaVersion: 1,
    headSha,
    sourceHead,
    dispositions: [],
    closedFindings: [],
    testsRun: ["focused"],
    residualRisks: [],
    ...overrides,
  });
  const refusalFor = (body: string) => canonicalOutputRefusal(fixStep, {
    runId: "run-1",
    kind: "fixed-implementation",
    body,
    commitSha: headSha,
    metadata: null,
  }, "run-1", headSha) ?? "";

  assert.equal(refusalFor(artifact({})), "");
  assert.match(refusalFor(artifact({
    dispositions: [
      { id: "SOL-1", disposition: "ADOPTED", reason: "real" },
      { id: "SOL-1", disposition: "REJECTED", reason: "second opinion" },
    ],
    closedFindings: [{ id: "SOL-1", status: "CLOSED", codeEvidence: "patch", testEvidence: "test" }],
  })), /dispositions contain duplicate ids: SOL-1/u);
  assert.match(refusalFor(artifact({
    dispositions: [{ id: "SOL-1", disposition: "ADOPTED", reason: "real" }],
    closedFindings: [],
  })), /must exactly cover the ADOPTED dispositions/u);
  assert.match(refusalFor(artifact({
    dispositions: [{ id: "SOL-1", disposition: "REJECTED", reason: "unreachable" }],
    closedFindings: [{ id: "SOL-1", status: "CLOSED", codeEvidence: "patch", testEvidence: "test" }],
  })), /must exactly cover the ADOPTED dispositions/u);
  assert.equal(refusalFor(artifact({
    dispositions: [
      { id: "SOL-1", disposition: "ADOPTED", reason: "real" },
      { id: "BLIND-1", disposition: "REJECTED", reason: "unreachable" },
    ],
    closedFindings: [{ id: "SOL-1", status: "CLOSED", codeEvidence: "patch", testEvidence: "test" }],
  })), "");
});

const persistenceRefusal = (
  result: Awaited<ReturnType<typeof persistFixedOutput>>,
): string | null => "ok" in result ? (result.ok ? null : result.reason) : result.reason;

test("a fixed-implementation output accepts the review-findings review contract", async () => {
  const result = await persistFixedOutput({ reviewTasks: [reviewTask("review-task", "review-findings")] });
  assert.equal(persistenceRefusal(result), null);
});

test("a review Step refuses an output from another review kind", async () => {
  const task = reviewTask("review-task", "review-findings");
  task.stepOutput!.kind = "blind-findings";
  const result = await persistFixedOutput({ reviewTasks: [task] });
  assert.match(persistenceRefusal(result) ?? "", /requires exactly one immutable review-findings sibling output/u);
});

test("a present blind review sibling without output keeps its exact refusal", async () => {
  const result = await persistFixedOutput({
    reviewTasks: [
      reviewTask("review-task", "review-findings"),
      reviewTask("blind-task", "blind-findings", null),
    ],
  });

  assert.equal(
    persistenceRefusal(result),
    "fixed-implementation requires exactly one immutable blind-findings sibling output",
  );
});

test("a review step this chain instantiated is owed in the predecessor layer", async () => {
  const result = await persistFixedOutput({
    reviewTasks: [reviewTask("review-task", "review-findings")],
    chainReviewSteps: [
      { outputKind: "review-findings", instantiated: true },
      { outputKind: "blind-findings", instantiated: true },
    ],
  });

  assert.equal(
    persistenceRefusal(result),
    "fixed-implementation requires exactly one immutable blind-findings sibling output",
  );
});

test("a fixed-implementation output refuses a review layer with no review sibling", async () => {
  const result = await persistFixedOutput({ reviewTasks: [] });

  assert.equal(
    persistenceRefusal(result),
    "fixed-implementation requires at least one immutable review sibling output",
  );
});

test("present review siblings must agree on their reviewed base", async () => {
  const result = await persistFixedOutput({
    reviewTasks: [
      reviewTask("review-task", "review-findings"),
      reviewTask("blind-task", "blind-findings", {
        runId: "blind-task-run",
        kind: "blind-findings",
        body: reviewBody("blind-findings", "d".repeat(40)),
        commitSha: REVIEW_HEAD,
        run: { taskId: "blind-task" },
      }),
    ],
  });

  assert.equal(
    persistenceRefusal(result),
    "fixed-implementation sibling reviews disagree on the reviewed base",
  );
});

test("a salvaged prior attempt is handed to the next Run as its commit and parent", () => {
  const salvaged = {
    pushedBranch: "agentos/task-1/run-1",
    headSha: "s".repeat(40),
    salvageParentSha: "r".repeat(40),
  };
  assert.deepEqual(salvageResumeEvidence("task-1", 1, salvaged), {
    commitSha: "s".repeat(40),
    parentSha: "r".repeat(40),
  });
  // An ordinary publication is not a salvage, whatever else it reported.
  assert.equal(salvageResumeEvidence("task-1", 1, { ...salvaged, pushedBranch: "feature/chain" }), null);
  // A Run that predates the salvage-parent evidence claims nothing about it.
  assert.equal(salvageResumeEvidence("task-1", 1, { ...salvaged, salvageParentSha: null }), null);
  assert.equal(salvageResumeEvidence("task-1", 1, { ...salvaged, headSha: null }), null);
});

for (const matchesBase of [true, false]) {
  test(`claim salvage follows only the resolved base past cancellation (matching publication: ${matchesBase})`, async () => {
    const parentSha = "b".repeat(40);
    const commitSha = "a".repeat(40);
    const pushedBranch = "agentos/task-1/run-2";
    const tx = {
      run: {
        findUnique: async () => ({
          id: "run-3", status: "CANCELLED", failureReason: "cancelled",
          headSha: null, pushedBranch: null, salvageParentSha: null, updatedAt: new Date(), endedAt: null,
        }),
        findUniqueOrThrow: async () => ({ targetBranch: pushedBranch }),
        findFirst: async (query: { where: unknown }) => {
          assert.deepEqual(query.where, { taskId: "task-1", runNumber: { lt: 4 }, pushedBranch });
          return matchesBase ? { runNumber: 2, pushedBranch, headSha: commitSha, salvageParentSha: parentSha } : null;
        },
      },
      taskStepOutput: { findUnique: async () => null },
      taskActivity: { findFirst: async () => null },
    };
    const handoff = await previousRunHandoffForClaim(tx as unknown as Parameters<typeof previousRunHandoffForClaim>[0], {
      taskId: "task-1", runId: "run-4", runNumber: 4,
      templateStep: step("direct-engineer-workflow", 5, "fixed-implementation"),
    });
    assert.equal(handoff?.previousRunId, "run-3");
    assert.deepEqual(handoff?.salvage, matchesBase ? { commitSha, parentSha } : null);
  });
}

/**
 * The implementing Task persisting its own deliverable. `baseSha` in that body
 * is informational — the reviewed range is pinned from the Task's Runs — so
 * persistence records a disagreement instead of refusing one.
 */
const persistImplementationOutput = async (input: {
  bodyBaseSha: string;
  continuation?: boolean;
  runs: Array<{ id?: string; runNumber: number; baseSha: string | null }>;
}) => {
  const implementationTask = {
    id: "implementation-task",
    projectId: "project-1",
    chainId: "chain-1",
    chainIndex: 2,
    chainLayer: 1,
    status: "IN_PROGRESS",
    templateStep: input.continuation ? null : {
      stepIndex: 2,
      outputKind: "implementation",
      taskTemplateId: "direct-template",
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  };
  const activities: Array<{ taskId: string; body: string; metadata: Record<string, unknown> }> = [];
  const tx = {
    $queryRaw: async () => [{ id: "locked" }],
    run: {
      findFirst: async (query: Record<string, any>) => {
        if (query.select && "baseSha" in query.select) {
          // The advisory asks for one Run by id — the fenced one — so the fake
          // answers by id and never by recency.
          const rows = input.runs.filter((run) => (run.id ?? "implementation-run") === query.where?.id);
          return rows[0] ?? null;
        }
        return query.select && "taskId" in query.select
          ? { taskId: implementationTask.id }
          : { task: implementationTask };
      },
    },
    taskActivity: {
      create: async ({ data }: { data: any }) => {
        activities.push(data);
        return data;
      },
    },
    taskStepOutput: {
      findUnique: async () => null,
      upsert: async ({ create }: { create: Record<string, unknown> }) => ({
        id: "implementation-output",
        ...create,
        metadata: create.metadata ?? null,
      }),
    },
  } as unknown as Prisma.TransactionClient;
  const result = await persistSessionTaskOutput(tx, {
    task: { id: implementationTask.id },
    fence: {
      runId: "implementation-run",
      fencingToken: "fence-token",
      at: new Date("2026-01-01T00:00:00.000Z"),
    },
    kind: "implementation",
    body: JSON.stringify({
      schemaVersion: 1,
      headSha: IMPLEMENTATION_HEAD,
      baseSha: input.bodyBaseSha,
      summary: "implemented",
      testsRun: ["focused"],
    }),
    commitSha: IMPLEMENTATION_HEAD,
  });
  return { result, activities };
};

test("an implementation body base that disagrees with this Run's own base is persisted and recorded", async () => {
  const { result, activities } = await persistImplementationOutput({
    bodyBaseSha: TYPED_BASE,
    runs: [{ id: "implementation-run", runNumber: 1, baseSha: RECORDED_BASE }],
  });
  assert.equal("ok" in result && result.ok, true, "the field no longer decides anything, so it cannot refuse");
  assert.equal(activities.length, 1);
  const [activity] = activities;
  assert.equal(activity?.taskId, "implementation-task");
  assert.match(activity?.body ?? "", new RegExp(TYPED_BASE, "u"));
  assert.match(activity?.body ?? "", new RegExp(RECORDED_BASE, "u"));
  assert.deepEqual(activity?.metadata, {
    kind: "canonicalTaskOutput.implementationBaseShaMismatch",
    schemaVersion: 1,
    runId: "implementation-run",
    outputKind: "implementation",
    bodyBaseSha: TYPED_BASE,
    runBaseSha: RECORDED_BASE,
  });
});

test("a recovery Run's body is checked against its own base, not the dead Run's", async () => {
  // The 2026-09-06 shape: Run 1 died holding an unpublished base, and the pin
  // skips it — so a Run 2 body naming Run 2's base is correct and silent…
  const correct = await persistImplementationOutput({
    bodyBaseSha: RECORDED_BASE,
    runs: [
      { id: "dead-run", runNumber: 1, baseSha: TYPED_BASE },
      { id: "implementation-run", runNumber: 2, baseSha: RECORDED_BASE },
    ],
  });
  assert.deepEqual(correct.activities, []);

  // …while a body still naming the dead Run's base is the typo to report.
  const stale = await persistImplementationOutput({
    bodyBaseSha: TYPED_BASE,
    runs: [
      { id: "dead-run", runNumber: 1, baseSha: TYPED_BASE },
      { id: "implementation-run", runNumber: 2, baseSha: RECORDED_BASE },
    ],
  });
  assert.equal(stale.activities.length, 1);
  assert.equal(stale.activities[0]?.metadata.kind, "canonicalTaskOutput.implementationBaseShaMismatch");
  assert.equal(stale.activities[0]?.metadata.runBaseSha, RECORDED_BASE);
});

test("an implementation body base that matches this Run's base records nothing", async () => {
  const { result, activities } = await persistImplementationOutput({
    bodyBaseSha: RECORDED_BASE,
    runs: [{ runNumber: 1, baseSha: RECORDED_BASE }],
  });
  assert.equal("ok" in result && result.ok, true);
  assert.deepEqual(activities, []);
});

test("an implementation Run with no recorded base records the missing authority", async () => {
  const { result, activities } = await persistImplementationOutput({
    bodyBaseSha: TYPED_BASE,
    runs: [{ runNumber: 1, baseSha: null }],
  });
  assert.equal("ok" in result && result.ok, true);
  assert.equal(activities.length, 1);
  assert.equal(activities[0]?.metadata.kind, "canonicalTaskOutput.implementationBaseShaMissing");
  assert.match(activities[0]?.body ?? "", /implementation-task/u);
  assert.match(activities[0]?.body ?? "", new RegExp(TYPED_BASE, "u"));
});

test("a noncanonical implementation continuation does not diagnose its unrelated Run base", async () => {
  const { result, activities } = await persistImplementationOutput({
    continuation: true,
    bodyBaseSha: TYPED_BASE,
    runs: [{ runNumber: 1, baseSha: RECORDED_BASE }],
  });
  assert.equal("ok" in result && result.ok, true);
  assert.deepEqual(activities, []);
});

test("session persistence refuses retired Steps before any output write", async () => {
  const kind = LEGACY_TEMPLATE_GENERATIONS["direct-engineer-workflow"]
    .find(({ marker }) => marker === "pre-model-neutral-review-output")!.shape
    .find(({ name }) => name === "Code review")!.outputKind;
  const task = { id: "historical-task", templateStep: step("historical", 2, kind) };
  let writes = 0;
  const tx = {
    $queryRaw: async () => [{ id: task.id }],
    run: { findFirst: async (args: { select?: Record<string, unknown> }) =>
      args.select && "taskId" in args.select ? { taskId: task.id } : { task } },
    taskStepOutput: {
      findUnique: async () => null,
      upsert: async () => { writes++; return {}; },
    },
  } as unknown as Prisma.TransactionClient;
  const result = await persistSessionTaskOutput(tx, {
    task, fence: { runId: "run", fencingToken: "token", at: new Date() },
    kind, body: "replacement", commitSha: FIX_HEAD,
  });
  assert.deepEqual(result, { ok: false, reason: `unknown-kind: retired task output kind ${kind}` });
  assert.equal(writes, 0);
  assert.equal(canonicalOutputRefusal(task.templateStep, null, "run", FIX_HEAD),
    `unknown-kind: retired task output kind ${kind}`);
});
