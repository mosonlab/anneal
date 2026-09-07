import assert from "node:assert/strict";
import test from "node:test";

import { TaskStatus } from "@anneal/db";

import {
  deriveBoundImplementationTask,
  isRevalidationStep,
  validateRevalidatedBrief,
  type RevalidationTask,
} from "./revalidation.js";

const task = (input: Partial<RevalidationTask> & Pick<RevalidationTask, "id" | "chainIndex" | "chainLayer" | "dispatchAfterTaskId">): RevalidationTask => ({
  id: input.id,
  projectId: input.projectId ?? "project-1",
  chainId: input.chainId === undefined ? "chain-1" : input.chainId,
  chainIndex: input.chainIndex,
  chainLayer: input.chainLayer,
  dispatchAfterTaskId: input.dispatchAfterTaskId,
  description: input.description ?? "description",
  name: input.name ?? input.id,
  status: input.status ?? TaskStatus.TODO,
  assigneeAgentId: input.assigneeAgentId ?? "agent-revalidator",
  templateId: input.templateId ?? "template-1",
  templateStepId: input.templateStepId ?? `step-${input.id}`,
  templateStep: input.templateStep ?? {
    stepIndex: 2,
    outputKind: "other",
    priorOutputKinds: [],
    taskTemplate: { name: "direct-engineer-workflow" },
  },
});

const caller = (overrides: Partial<RevalidationTask> = {}): RevalidationTask & { agentId: string } => ({
  ...task({
    id: "revalidate",
    chainIndex: 0,
    chainLayer: 0,
    dispatchAfterTaskId: "prior",
    templateStep: {
      stepIndex: 1,
      outputKind: "revalidation",
      priorOutputKinds: [],
      taskTemplate: { name: "direct-engineer-workflow" },
    },
    ...overrides,
  }),
  agentId: "agent-revalidator",
});

test("derives exactly one downstream same-chain implementation task", () => {
  const implementation = task({
    id: "implementation",
    chainIndex: 1,
    chainLayer: 1,
    dispatchAfterTaskId: null,
    templateStep: {
      stepIndex: 2,
      outputKind: "implementation",
      priorOutputKinds: ["revalidation"],
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  });
  const result = deriveBoundImplementationTask(caller(), [caller(), implementation]);
  assert.equal("message" in result, false);
  if (!("message" in result)) {
    assert.equal(result.id, "implementation");
  }
});

test("rejects a run whose agent is not the task's assignee, an unbound task, and ambiguous implementations", () => {
  const implementation = task({
    id: "implementation",
    chainIndex: 1,
    chainLayer: 1,
    dispatchAfterTaskId: null,
    templateStep: {
      stepIndex: 2,
      outputKind: "implementation",
      priorOutputKinds: [],
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  });
  // §R11/§R5: the capability is keyed on the Step, so any Agent a staffing
  // profile bound to it may use it — what is still refused is a Run whose
  // Agent is not the one the task is assigned to.
  const anyAgent = deriveBoundImplementationTask(
    { ...caller({ assigneeAgentId: "agent-anything" }), agentId: "agent-anything" },
    [caller(), implementation],
  );
  assert.equal("message" in anyAgent, false);
  const foreignRun = deriveBoundImplementationTask({ ...caller(), agentId: "agent-someone-else" }, [caller(), implementation]);
  assert.ok("message" in foreignRun);
  if ("message" in foreignRun) assert.equal(foreignRun.reason, "forbidden");
  const unbound = deriveBoundImplementationTask(caller({ chainId: null, dispatchAfterTaskId: null }), [implementation]);
  assert.ok("message" in unbound);
  if ("message" in unbound) assert.equal(unbound.reason, "conflict");
  const ambiguous = deriveBoundImplementationTask(caller(), [caller(), implementation, {
    ...implementation,
    id: "implementation-2",
    chainIndex: 2,
    chainLayer: 2,
  }]);
  assert.ok("message" in ambiguous);
  if ("message" in ambiguous) assert.equal(ambiguous.reason, "conflict");
});

test("rejects compound, custom-template, non-revalidation, and cross-template callers", () => {
  const implementation = task({
    id: "implementation",
    chainIndex: 1,
    chainLayer: 1,
    dispatchAfterTaskId: null,
    templateStep: {
      stepIndex: 2,
      outputKind: "implementation",
      priorOutputKinds: ["revalidation"],
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  });
  const cases = [
    caller({ templateStep: { ...caller().templateStep!, taskTemplate: { name: "compound-engineer-workflow" } } }),
    caller({ templateStep: { ...caller().templateStep!, taskTemplate: { name: "custom-workflow" } } }),
    caller({ templateStep: { ...caller().templateStep!, outputKind: "implementation" } }),
  ];
  for (const candidate of cases) {
    const result = deriveBoundImplementationTask(candidate, [candidate, implementation]);
    assert.ok("message" in result);
    if ("message" in result) assert.equal(result.reason, "forbidden");
  }
  const crossTemplate = deriveBoundImplementationTask(caller(), [caller(), { ...implementation, templateId: "other-template" }]);
  assert.ok("message" in crossTemplate);
  if ("message" in crossTemplate) assert.equal(crossTemplate.reason, "conflict");
});

const brief = [
  "Ship a revalidation step without changing product intent.",
  "",
  "Background: taskPatch reads oldHandler today.",
  "",
  "Changes:",
  "1. Update oldHandler in packages/api/src/old-route.ts while preserving cancellation semantics.",
  "2. Keep the task PATCH route fail-closed.",
  "",
  "Out of scope: compound templates.",
  "",
  "Constraints: existing chains stay byte-identical.",
  "",
  "Acceptance: the named regression passes.",
  "",
  "Route: implementation=senior-dev-astra-medium - transaction boundary",
].join("\n");

test("revalidation permits background and descriptive code-reference drift", () => {
  const stored = brief.replace(
    "oldHandler in packages/api/src/old-route.ts",
    "`oldHandler` in `packages/api/src/old-route.ts`",
  );
  const proposed = stored
    .replace("taskPatch reads oldHandler today", "patchBoundImplementationDescription reads newHandler today")
    .replace("`oldHandler` in `packages/api/src/old-route.ts`", "`newHandler` in `packages/api/src/new-route.ts`");
  assert.equal(validateRevalidatedBrief(stored, proposed), null);
});

test("revalidation rejects Changes-item intent mutations hidden in backticks", () => {
  const stored = brief.replace("Update oldHandler", "`Update oldHandler`");
  const proposed = stored.replace("`Update oldHandler`", "`Delete oldHandler`");

  const refusal = validateRevalidatedBrief(stored, proposed);

  assert.deepEqual(refusal, {
    reason: "invalid-request",
    message: "Revalidation cannot change the intent of a Changes item",
  });
});

test("revalidation rejects mutations to every immutable Product Contract bar", () => {
  const attempts = [
    brief.replace("Ship a revalidation step", "Remove the revalidation step"),
    brief.replace("Update oldHandler", "Delete oldHandler"),
    brief.replace("Out of scope: compound templates.", "Out of scope: nothing."),
    brief.replace("Constraints: existing chains stay byte-identical.", "Constraints: compatibility may break."),
    brief.replace("Acceptance: the named regression passes.", "Acceptance: no tests are required."),
    brief.replace("Route: implementation=senior-dev-astra-medium", "Route: implementation=frontend-dev-opus-medium"),
  ];
  for (const proposed of attempts) {
    const refusal = validateRevalidatedBrief(brief, proposed);
    assert.ok(refusal);
    assert.equal(refusal.reason, "invalid-request");
  }
});

test("the revalidation capability is keyed on the canonical step, not on any agent", () => {
  const canonical = {
    stepIndex: 1,
    outputKind: "revalidation",
    taskTemplate: { name: "direct-engineer-workflow" },
  };
  assert.equal(isRevalidationStep(canonical), true);
  assert.equal(isRevalidationStep(null), false);
  assert.equal(isRevalidationStep(undefined), false);
  assert.equal(isRevalidationStep({ ...canonical, stepIndex: 2 }), false);
  assert.equal(isRevalidationStep({ ...canonical, outputKind: "implementation" }), false);
  assert.equal(isRevalidationStep({ ...canonical, taskTemplate: { name: "custom-workflow" } }), false);
});

test("a retired Direct Chain retains revalidation authority for its original implementation", () => {
  const name = "direct-engineer-workflow-legacy-pre-model-neutral-review-output-template-1";
  const originalCaller = caller();
  const retiredCaller = caller({ templateStep: { ...originalCaller.templateStep!, taskTemplate: { name } } });
  const implementation = task({
    id: "implementation", chainIndex: 1, chainLayer: 1, dispatchAfterTaskId: null,
    templateStep: { stepIndex: 2, outputKind: "implementation", priorOutputKinds: ["revalidation"], taskTemplate: { name } },
  });
  assert.equal(isRevalidationStep(retiredCaller.templateStep), true);
  assert.equal(deriveBoundImplementationTask(retiredCaller, [retiredCaller, implementation]), implementation);
  const foreign = deriveBoundImplementationTask(retiredCaller, [{ ...implementation, templateId: "successor-template" }]);
  assert.ok("reason" in foreign && foreign.reason === "conflict");
  assert.equal(isRevalidationStep({ ...retiredCaller.templateStep!, taskTemplate: { name: "direct-engineer-workflow-legacy-unregistered-template-1" } }), false);
});
