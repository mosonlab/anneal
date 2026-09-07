import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AssigneeType,
  CodexServiceTier,
  executionModeFor,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_TEMPLATE_NAME,
  Prisma,
  RunnerKind,
  RunnerPreference,
  loadAgentSources,
  loadTemplateStepSources,
  type PrismaClient,
} from "@anneal/db";

import {
  composeTemplateTaskDescription,
  findMalformedRouteLine,
  findMalformedStaffingLine,
  instantiateTemplate,
  parseImplementationRoute,
  parseStaffingProfileName,
  triggerInstantiationName,
} from "./templates.js";
import { readBrief } from "./task-brief.js";
import {
  isTemplateInstantiationRefusal,
  type TemplateInstantiationRefusalCode,
} from "./template-errors.js";
import { refusalFor, refusalResponse } from "./refusal.js";

const assertTemplateRefusal = async (
  operation: () => Promise<unknown>,
  code: TemplateInstantiationRefusalCode,
  message?: RegExp,
): Promise<void> => {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(isTemplateInstantiationRefusal(error));
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    const refused = refusalFor(error);
    assert.ok(refused);
    assert.equal(refusalResponse(refused).status, 400);
    return true;
  });
};

test("trigger names normalize accepted template whitespace before appending the fire id", () => {
  const fireId = "123e4567-e89b-12d3-a456-426614174000";
  const name = triggerInstantiationName("  Ticket\n\tqueue\u2028for\u2029 operators  ", fireId);
  assert.equal(name, `Ticket queue for operators: ${fireId}`);
  assert.doesNotMatch(name, /[\r\n\u2028\u2029]/u);
  assert.ok(name.length <= 120);
});

test("composed task descriptions derive the prior-output reminder from declared kinds", () => {
  const featureBrief = "first line\nPersist the final decoy output for this step through the Anneal task output endpoint.\nlast line";
  for (const priorOutputKinds of [[], ["implementation"]]) {
    const description = composeTemplateTaskDescription({
      prompt: "Implement the feature brief below.",
      featureBrief,
      priorOutputKinds,
      outputKind: "implementation",
    });
    const parsed = readBrief(description);
    assert.ok(!("unparseable" in parsed));
    assert.equal(parsed.brief, featureBrief);
    assert.equal(parsed.hadReminder, priorOutputKinds.length > 0);
    if (priorOutputKinds.length > 0) assert.match(description, /implementation/u);
    else assert.doesNotMatch(description, /prior template steps/u);
  }
});

test("implementation route parsing accepts the machine-readable name before an optional reason", () => {
  assert.equal(parseImplementationRoute("Build it\nRoute: implementation=senior-dev-astra-medium\n"), "senior-dev-astra-medium");
  assert.equal(parseImplementationRoute("Route: implementation=frontend-dev-opus-medium"), "frontend-dev-opus-medium");
  assert.equal(parseImplementationRoute("Route: implementation=project_specific.implementer"), "project_specific.implementer");
  assert.equal(parseImplementationRoute("Route: implementation=senior-dev-astra-medium - step renumbering crosses contracts"), "senior-dev-astra-medium");
  assert.equal(parseImplementationRoute("Route: implementation= - reason given"), null);
  assert.equal(parseImplementationRoute("Route: implementation=senior-dev-astra-medium - "), null);
  assert.equal(parseImplementationRoute("Route: implementation=senior-dev-astra-medium "), null);
  assert.equal(parseImplementationRoute("Route: implementation=unknown"), "unknown");
  assert.equal(parseImplementationRoute(undefined), null);
  assert.equal(findMalformedRouteLine("Build it\nRoute: implementation=senior-dev-astra-medium\n"), null);
  assert.equal(findMalformedRouteLine("Route: implementation=senior-dev-astra-medium - reason given"), null);
  assert.equal(findMalformedRouteLine("Route: implementation= - reason given"), "Route: implementation= - reason given");
  assert.equal(findMalformedRouteLine("Route: implementation=senior-dev-astra-medium - "), "Route: implementation=senior-dev-astra-medium - ");
  assert.equal(findMalformedRouteLine("Route: implementation=unknown"), null);
  assert.equal(findMalformedRouteLine("Route: senior-dev-astra-medium - missing the implementation= key"), "Route: senior-dev-astra-medium - missing the implementation= key");
  assert.equal(findMalformedRouteLine("Route: implementation=senior-dev-astra-medium "), "Route: implementation=senior-dev-astra-medium ");
  assert.equal(findMalformedRouteLine("Build it\nRoute:implementation=senior-dev-astra-medium"), "Route:implementation=senior-dev-astra-medium");
  assert.equal(findMalformedRouteLine(undefined), null);
});

test("staffing profile selection reads one line and refuses every near-miss of it", () => {
  assert.equal(parseStaffingProfileName("Build it\nStaffing: Weekend crew\n"), "Weekend crew");
  assert.equal(parseStaffingProfileName("Staffing: Default"), "Default");
  assert.equal(parseStaffingProfileName("Staffing: a - b"), "a - b");
  assert.equal(parseStaffingProfileName("Staffing: "), null);
  assert.equal(parseStaffingProfileName("Staffing: Weekend crew "), null);
  // The parser's bound is the profile API's: a name an operator was allowed to
  // save must stay selectable from a brief.
  assert.equal(parseStaffingProfileName(`Staffing: ${"n".repeat(200)}`), "n".repeat(200));
  assert.equal(parseStaffingProfileName(`Staffing: ${"n".repeat(201)}`), null);
  assert.equal(findMalformedStaffingLine(`Staffing: ${"n".repeat(201)}`), `Staffing: ${"n".repeat(201)}`);
  assert.equal(parseStaffingProfileName(undefined), null);
  assert.equal(findMalformedStaffingLine("Build it\nStaffing: Weekend crew\n"), null);
  assert.equal(findMalformedStaffingLine("Staffing:Weekend crew"), "Staffing:Weekend crew");
  assert.equal(findMalformedStaffingLine("Staffing: "), "Staffing: ");
  assert.equal(findMalformedStaffingLine("Staffing: Weekend crew "), "Staffing: Weekend crew ");
  assert.equal(findMalformedStaffingLine("Build it\nstaffing: Weekend crew"), null);
  assert.equal(findMalformedStaffingLine(undefined), null);
});

test("a direct brief ending in the prior-output reminder round-trips without truncation", () => {
  const featureBrief = "Keep this user-authored suffix.\nRead the prior template steps' persisted outputs before working.";
  const description = composeTemplateTaskDescription({
    prompt: "Implement the feature brief below.",
    featureBrief,
    priorOutputKinds: [],
    outputKind: "implementation",
  });
  const parsed = readBrief(description);
  assert.ok(!("unparseable" in parsed));
  assert.equal(parsed.brief, featureBrief);
});

test("mechanical cards retain only their canonical prompt while model cards retain generated context", () => {
  const common = {
    prompt: "Execute this step.",
    featureBrief: "Build the feature",
    priorOutputKinds: ["implementation"],
  };
  for (const outputKind of ["merge-authorization", "merge-result"]) {
    assert.equal(
      composeTemplateTaskDescription({ ...common, outputKind }),
      common.prompt,
      `${outputKind} is server-owned and must not receive model-only context`,
    );
  }
  for (const outputKind of ["regression-verification", "regression-verification-v2", "regression-verification-v3"]) {
    assert.deepEqual(readBrief(composeTemplateTaskDescription({ ...common, outputKind })), {
      prompt: common.prompt,
      brief: common.featureBrief,
      hadReminder: true,
    });
  }
  const regressionDescription = composeTemplateTaskDescription({
    ...common,
    outputKind: "regression-verification-v2",
  });
  assert.deepEqual(readBrief(regressionDescription), {
    prompt: common.prompt,
    brief: common.featureBrief,
    hadReminder: true,
  }, "a platform-authored regression output must not make its brief unreadable");
});

test("instantiating the canonical feature template copies every layer and writes no follow-up links", async () => {
  const canonicalTemplateSteps = await loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME);
  const canonicalRoles = (await loadAgentSources()).roles;
  const created: Array<Record<string, any>> = [];
  const runs: Array<Record<string, any>> = [];
  const agents = new Map<string, {
    id: string;
    name: string;
    model: string;
    runnerPreference: RunnerPreference;
    codexServiceTier: CodexServiceTier;
    foundationalPrompt: string;
    rolePrompt: string;
  }>(canonicalRoles.map((role, index) => [role.name, {
    id: `agent-${index + 1}`,
    name: role.name,
    model: role.model,
    runnerPreference: role.runnerPreference,
    codexServiceTier: CodexServiceTier.DEFAULT,
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  }]));
  const steps = canonicalTemplateSteps.map((contract) => {
    const agent = contract.agentName ? agents.get(String(contract.agentName))! : null;
    return {
      id: `step-${contract.stepIndex}`,
      stepIndex: contract.stepIndex,
      name: `Step ${contract.stepIndex}`,
      prompt: `Work on {{branchName}} in chain {{chainId}} step ${contract.stepIndex}`,
      outputKind: contract.outputKind,
      attachmentsFromPrevious: contract.attachmentsFromPrevious,
      priorOutputKinds: contract.priorOutputKinds,
      assigneeType: agent ? AssigneeType.AGENT : AssigneeType.HUMAN,
      assigneeAgentId: agent?.id ?? null,
      assigneeAgent: agent,
      approvalGate: contract.approvalGate,
      opensPullRequest: contract.opensPullRequest,
      layer: contract.layer,
      baseFromStepIndex: contract.baseFromStepIndex,
      runner: null,
      taskTemplate: { name: "compound-engineer-workflow" },
    };
  });
  const template = { id: "template-1", name: "compound-engineer-workflow", variables: ["branchName"], steps };
  const tx = {
    // The Agent-row mutex and each exact Repo-grant mutex are acquired before
    // the first task write. Returning both row shapes lets the shared lock
    // helpers exercise their normal paths.
    $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
      ? [{ id: template.id, projectId: "project-1", name: template.name }]
      : [...agents.values()].map((agent) => ({
        id: agent.id, name: agent.name, projectId: "project-1", archivedAt: null,
        // §R14 is a capability check, so the locked Agent projection carries
        // the runtime configuration the compound root is validated against.
        model: agent.model, runnerPreference: agent.runnerPreference,
        agentId: agent.id, repoId: "repo-1",
      })),
    staffingProfile: { findFirst: async () => null },
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        [...agents.values()].find((agent) => agent.id === where.id) ?? null,
    },
    task: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const task = {
          id: `task-${created.length + 1}`,
          ...data,
          assigneeAgent: data.assigneeAgentId
            ? [...agents.values()].find((agent) => agent.id === data.assigneeAgentId)
            : null,
          repo: { id: "repo-1", defaultBranch: "main" },
          templateStep: steps[created.length],
          runs: [],
        };
        created.push(task);
        return task;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const task = created.find((item) => item.id === where.id)!;
        Object.assign(task, data);
        return task;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => created.find((item) => item.id === where.id),
      findUnique: async ({ where }: { where: { id: string } }) => created.find((item) => item.id === where.id) ?? null,
      findFirst: async () => created.find((item) => item.targetBranch !== "main") ?? null,
    },
    run: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, any> }) => { const run = { id: "run-1", ...data }; runs.push(run); return run; },
      update: async ({ data }: { data: Record<string, any> }) => { Object.assign(runs[0]!, data); return runs[0]; },
    },
    taskActivity: { createMany: async () => ({ count: 12 }) },
    chainControl: { findMany: async () => [] },
    taskTemplateStep: {
      findUnique: async ({ where }: { where: { id: string } }) => steps.find((step) => step.id === where.id) ?? null,
    },
    agentRepoAccess: { count: async () => 1 },
  };
  const db = {
    staffingProfile: { findFirst: async () => null },
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { findFirst: async () => ({ agentId: "granted-agent" }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  const result = await instantiateTemplate(db, "project-1", "template-1", {
    repoId: "repo-1", variables: { branchName: "feature/twelve-steps" }, autoStart: true, name: "Build it", description: "Build it",
  });
  assert.equal(result.tasks.length, 12);
  assert.equal(new Set(created.map((task) => task.chainId)).size, 1);
  assert.deepEqual(created.map((task) => task.chainLayer), canonicalTemplateSteps.map((step) => step.layer));
  assert.ok(created.every((task) => task.description.includes(`chain ${result.chainId}`)), "chainId is a built-in template variable");
  assert.ok(created.every((task) => typeof task.chainLayer === "number"));
  assert.equal(created[10]!.assigneeType, AssigneeType.AGENT);
  assert.equal(created[10]!.approvalGate, false);
  assert.equal(created[10]!.templateStep.outputKind, "merge-authorization");
  assert.equal(created[11]!.assigneeAgent?.name, INTEGRATOR_AGENT_NAME);
  assert.equal(created[11]!.assigneeAgent?.model, INTEGRATOR_SENTINEL_MODEL);
  assert.equal(created[11]!.assigneeAgent?.runnerPreference, RunnerPreference.INHERIT);
  assert.equal(created[11]!.opensPullRequest, false);
  assert.equal(executionModeFor(created[11]!.templateStep), "mechanical");
  assert.deepEqual(created.map((task) => task.outputKind ?? task.templateStep.outputKind), canonicalTemplateSteps.map((step) => step.outputKind));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.runner, RunnerKind.CLAUDE);
  assert.equal(runs[0]!.branch, "feature/twelve-steps");
  assert.equal(runs.some((run) => run.taskId === created[11]!.id), false, "step 12 waits for server-side readiness and never queues at instantiation");
  assert.doesNotMatch(
    created[6]!.description,
    /Read the prior template steps' persisted outputs before working/u,
    "blind-review step 7 materializes without an upstream-read instruction",
  );
  assert.match(
    created[9]!.description,
    /Read the prior template steps' persisted outputs before working/u,
    "regression-verification step 10 consumes declared review and fix outputs",
  );
  assert.doesNotMatch(
    created[10]!.description,
    /Read the prior template steps' persisted outputs before working/u,
    "mechanical merge authorization has no declared prior output",
  );
  assert.doesNotMatch(
    created[11]!.description,
    /Read the prior template steps' persisted outputs before working/u,
    "mechanical merge execution has no declared prior output",
  );

  const inert = await instantiateTemplate(db, "project-1", "template-1", {
    repoId: "repo-1", variables: { branchName: "feature/inert-chain" }, name: "Build it later", description: "Build it later",
  });
  assert.equal(inert.tasks.length, 12);
  assert.equal(runs.length, 1, "omitting autoStart defaults to an inert chain with no queued run");
});

test("the lower-level materializer rejects blank variables and invalid branches from the locked graph", async () => {
  const db = {
    staffingProfile: { findFirst: async () => null },
    taskTemplate: { findFirst: async () => ({
      id: "template-1",
      name: "Template",
      variables: ["branchName"],
      steps: [{
        id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
        outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
        assigneeAgentId: "agent-1", assigneeAgent: { id: "agent-1", name: "Agent", archivedAt: null },
        approvalGate: false, opensPullRequest: true, runner: null,
      }],
    }) },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
      $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
        ? [{ id: "template-1", projectId: "project-1", name: "Template" }]
        : [],
      staffingProfile: { findFirst: async () => null },
      taskTemplate: { findFirst: async () => ({
        id: "template-1",
        name: "Template",
        variables: ["branchName"],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: "agent-1", assigneeAgent: { id: "agent-1", name: "Agent", archivedAt: null },
          approvalGate: false, opensPullRequest: true, runner: null,
        }],
      }) },
      repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    }),
  } as unknown as PrismaClient;
  for (const [branchName, code] of [
    ["", "template_variables_missing"],
    ["   ", "template_variables_missing"],
    ["bad..branch", "template_branch_invalid"],
    ["refs/heads/main", "template_branch_invalid"],
    ["feature/.hidden", "template_branch_invalid"],
    ["feature/main.lock", "template_branch_invalid"],
    ["bad\nbranch", "template_branch_invalid"],
  ] as const) {
    await assertTemplateRefusal(
      () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: { branchName }, name: "branch validation", autoStart: false }),
      code,
    );
  }
});

test("template base reference failures expose stable 400 refusal codes", async () => {
  const step = (stepIndex: number, baseFromStepIndex: number | null) => ({
    id: `step-${stepIndex}`,
    stepIndex,
    baseFromStepIndex,
    name: `Step ${stepIndex}`,
    prompt: "work",
    outputKind: "result",
    attachmentsFromPrevious: false,
    priorOutputKinds: [],
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: "agent-1",
    assigneeAgent: { id: "agent-1", name: "Agent", archivedAt: null },
    approvalGate: false,
    opensPullRequest: true,
    runner: null,
  });
  for (const [steps, code] of [
    [[step(1, 99)], "template_base_reference_missing"],
    [[step(1, 1)], "template_base_reference_not_earlier"],
  ] as const) {
    const db = {
      staffingProfile: { findFirst: async () => null },
      taskTemplate: { findFirst: async () => ({ id: "template-1", name: "Template", variables: [], steps }) },
      repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
        $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
          ? [{ id: "template-1", projectId: "project-1", name: "Template" }]
          : [],
        staffingProfile: { findFirst: async () => null },
        taskTemplate: { findFirst: async () => ({ id: "template-1", name: "Template", variables: [], steps }) },
        repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
      }),
    } as unknown as PrismaClient;
    await assertTemplateRefusal(
      () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {}, name: "base validation" }),
      code,
    );
  }
});

test("an agent archived after the step check still loses to the locked re-read", async () => {
  // The pre-transaction validation sees a live agent; the archive commits; the
  // locked re-read is what decides. Without it the whole chain — and its first
  // run — would be written for an agent no runner ever claims for.
  const agent = {
    id: "agent-1", name: "Racing Agent", archivedAt: null, model: "codex",
    runnerPreference: RunnerPreference.CODEX, foundationalPrompt: "foundation", rolePrompt: "role",
  };
  let taskCreates = 0;
  const db = {
    taskTemplate: {
      findFirst: async () => ({
        id: "template-1",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, runner: null,
        }],
      }),
    },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { findFirst: async () => ({ agentId: agent.id }) },
    $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
      $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
        ? [{ id: "template-1", projectId: "project-1", name: "Template" }]
        : [{ id: agent.id, name: agent.name, projectId: "project-1", archivedAt: new Date() }],
      staffingProfile: { findFirst: async () => null },
      taskTemplate: { findFirst: async () => ({
        id: "template-1",
        name: "Template",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, opensPullRequest: true, runner: null,
        }],
      }) },
      repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
      task: { create: async () => { taskCreates += 1; return { id: "task-1" }; } },
      run: { create: async () => { throw new Error("must not create run"); } },
      taskActivity: { createMany: async () => ({ count: 0 }) },
    }),
  } as unknown as PrismaClient;
  await assertTemplateRefusal(
    () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {}, name: "archive race", autoStart: false }),
    "template_step_agent_archived",
  );
  assert.equal(taskCreates, 0, "no chain row is written once the lock says archived");
});

test("a serializable conflict raised by the raw Agent lock is retried, not surfaced", async () => {
  // The lock is a raw statement, so Postgres reports the conflict as P2010 with
  // the SQLSTATE in meta. Treating that as fatal turned an archive race into a
  // 500 instead of the named archive rejection the caller can act on.
  const agent = {
    id: "agent-1", name: "Racing Agent", archivedAt: null, model: "codex",
    runnerPreference: RunnerPreference.CODEX, foundationalPrompt: "foundation", rolePrompt: "role",
  };
  let transactionAttempts = 0;
  let agentLockConflicts = 0;
  const db = {
    taskTemplate: {
      findFirst: async () => ({
        id: "template-1",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, runner: null,
        }],
      }),
    },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { findFirst: async () => ({ agentId: agent.id }) },
    $transaction: async (operation: (client: unknown) => Promise<unknown>) => {
      transactionAttempts += 1;
      return operation({
      $queryRaw: async (query: TemplateStringsArray) => {
        const sql = query.join(" ");
        // First attempt: the archive holds the row and commits under us.
        if (!sql.includes('"TaskTemplate"') && agentLockConflicts === 0) {
          agentLockConflicts += 1;
          throw new Prisma.PrismaClientKnownRequestError("Raw query failed", {
            code: "P2010",
            clientVersion: "test",
            meta: { code: "40001", message: "could not serialize access due to concurrent update" },
          });
        }
        return sql.includes('"TaskTemplate"')
          ? [{ id: "template-1", projectId: "project-1", name: "Template" }]
          : [{ id: agent.id, name: agent.name, projectId: "project-1", archivedAt: new Date() }];
      },
      staffingProfile: { findFirst: async () => null },
      taskTemplate: { findFirst: async () => ({
        id: "template-1",
        name: "Template",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, opensPullRequest: true, runner: null,
        }],
      }) },
      repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
      task: { create: async () => { throw new Error("must not create task"); } },
      run: { create: async () => { throw new Error("must not create run"); } },
      taskActivity: { createMany: async () => ({ count: 0 }) },
      });
    },
  } as unknown as PrismaClient;
  await assertTemplateRefusal(
    () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {}, name: "lock race", autoStart: false }),
    "template_step_agent_archived",
  );
  assert.equal(agentLockConflicts, 1, "the conflict is injected on the Agent-row lock");
  assert.equal(transactionAttempts, 2, "the Agent-lock conflict retries the whole serializable transaction once");
});

test("template instantiation rejects an archived step agent and names the step", async () => {
  const agent = {
    id: "agent-1", name: "Archived Agent", archivedAt: new Date(), model: "codex",
    runnerPreference: RunnerPreference.CODEX, foundationalPrompt: "foundation", rolePrompt: "role",
  };
  const db = {
    taskTemplate: {
      findFirst: async () => ({
        id: "template-1",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, runner: null,
        }],
      }),
    },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
      $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
        ? [{ id: "template-1", projectId: "project-1", name: "Template" }]
        : [{ id: agent.id, name: agent.name, projectId: "project-1", archivedAt: agent.archivedAt }],
      staffingProfile: { findFirst: async () => null },
      taskTemplate: { findFirst: async () => ({
        id: "template-1",
        name: "Template",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, opensPullRequest: true, runner: null,
        }],
      }) },
      repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
      task: { create: async () => { throw new Error("must not create task"); } },
      taskActivity: { createMany: async () => ({ count: 0 }) },
    }),
  } as unknown as PrismaClient;
  await assertTemplateRefusal(
    () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {}, name: "archived agent", autoStart: false }),
    "template_step_agent_archived",
  );
});

test("step overrides copy only the effective assignee and lock canonical plus override agents", async () => {
  const canonical = (id: string, name: string) => ({
    id, name, projectId: "project-1", archivedAt: null,
    model: "codex", foundationalPrompt: "foundation", rolePrompt: "role",
  });
  const agents = [canonical("agent-1", "Canonical One"), canonical("agent-2", "Canonical Two")];
  const replacement = canonical("agent-replacement", "Replacement");
  const steps = [1, 2].map((stepIndex) => ({
    id: `step-${stepIndex}`, stepIndex, name: `Step ${stepIndex}`, prompt: `work ${stepIndex}`,
    outputKind: "result", attachmentsFromPrevious: stepIndex === 2,
    priorOutputKinds: stepIndex === 2 ? ["result"] : [], assigneeType: AssigneeType.AGENT,
    assigneeAgentId: `agent-${stepIndex}`, assigneeAgent: agents[stepIndex - 1], approvalGate: stepIndex === 2,
    opensPullRequest: stepIndex === 1, layer: stepIndex, baseFromStepIndex: null, runner: null,
  }));
  const template = { id: "template-1", name: "Template", variables: [], steps };
  const created: Array<Record<string, any>> = [];
  const lockQueries: string[] = [];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => {
      lockQueries.push(query.join(" "));
      if (query.join(" ").includes('"TaskTemplate"')) {
        return [{ id: template.id, projectId: "project-1", name: template.name }];
      }
      return [
        ...[...agents, replacement].map((agent) => ({
          id: agent.id,
          name: agent.name,
          projectId: agent.projectId,
          archivedAt: agent.archivedAt,
        })),
        ...[...agents, replacement].map((agent) => ({ agentId: agent.id, repoId: "repo-1" })),
      ];
    },
    staffingProfile: { findFirst: async () => null },
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { count: async () => 1 },
    task: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const task = { id: `task-${created.length + 1}`, ...data };
        created.push(task);
        return task;
      },
    },
    taskActivity: { createMany: async () => ({ count: created.length }) },
  };
  const db = {
    staffingProfile: { findFirst: async () => null },
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agent: { findMany: async () => [replacement] },
    agentRepoAccess: { findFirst: async () => ({ agentId: replacement.id }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;

  const result = await instantiateTemplate(db, "project-1", "template-1", {
    repoId: "repo-1", variables: {}, name: "override test", stepOverrides: { "2": { assigneeAgentId: replacement.id } },
  });
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(created.map((task) => task.assigneeAgentId), ["agent-1", replacement.id]);
  assert.equal(created[1]!.assigneeType, AssigneeType.AGENT);
  assert.equal(created[1]!.approvalGate, true);
  assert.equal(created[1]!.opensPullRequest, false);
  assert.equal(lockQueries.length, 4, "one template lock, one Agent lock, plus one grant lock per distinct effective assignee");
  assert.match(lockQueries[0]!, /TaskTemplate/u);
  assert.match(lockQueries[1]!, /ORDER BY "id" FOR UPDATE/u);
});

test("step override structural refusals happen before template reads and carry stable codes", async () => {
  const db = {
    staffingProfile: { findFirst: async () => null },
    taskTemplate: { findFirst: async () => { throw new Error("database must not be read"); } },
    repo: { findFirst: async () => { throw new Error("database must not be read"); } },
  } as unknown as PrismaClient;
  for (const [stepOverrides, code] of [
    [{ "0": { assigneeAgentId: "agent" } }, "step_override_invalid_key"],
    [{ "09": { assigneeAgentId: "agent" } }, "step_override_invalid_key"],
    [{ "1.5": { assigneeAgentId: "agent" } }, "step_override_invalid_key"],
    [Object.fromEntries(Array.from({ length: 65 }, (_, index) => [String(index + 1), { assigneeAgentId: "agent" }])), "step_override_too_many"],
  ] as const) {
    await assertTemplateRefusal(
      () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {}, name: "override validation", stepOverrides }),
      code,
    );
  }
});

test("direct Route overrides implementation while non-direct templates refuse Route lines", async () => {
  let templateName = "direct-engineer-workflow";
  let lockedRouteAgentName = "senior-dev-astra-medium";
  const revalidator = {
    id: "agent-revalidator", name: "spec-revalidator-luna-xhigh", projectId: "project-1", archivedAt: null,
    model: "openai-codex/gpt-5.6-luna:xhigh", foundationalPrompt: "foundation", rolePrompt: "role",
  };
  const canonical = {
    id: "agent-luna", name: "senior-dev-luna-max", projectId: "project-1", archivedAt: null,
    model: "gpt-5.6-luna:max", foundationalPrompt: "foundation", rolePrompt: "role",
  };
  const routed = {
    id: "agent-senior", name: "senior-dev-astra-medium", projectId: "project-1", archivedAt: null,
    model: "gpt-5.6-sol:high", foundationalPrompt: "foundation", rolePrompt: "role",
  };
  const steps = [
    {
      id: "step-revalidation", stepIndex: 1, name: "Revalidate", prompt: "revalidate {{chainId}}",
      outputKind: "revalidation", attachmentsFromPrevious: false, priorOutputKinds: [],
      assigneeType: AssigneeType.AGENT, assigneeAgentId: revalidator.id, assigneeAgent: revalidator,
      approvalGate: false, opensPullRequest: false, layer: 1, baseFromStepIndex: null, runner: null,
    },
    {
      id: "step-implementation", stepIndex: 2, name: "Implementation", prompt: "implement {{chainId}}",
      outputKind: "implementation", attachmentsFromPrevious: false, priorOutputKinds: [],
      assigneeType: AssigneeType.AGENT, assigneeAgentId: canonical.id, assigneeAgent: canonical,
      approvalGate: false, opensPullRequest: true, layer: 2, baseFromStepIndex: null, runner: null,
    },
    {
      id: "step-review", stepIndex: 3, name: "Review", prompt: "review {{chainId}}",
      outputKind: "review-findings", attachmentsFromPrevious: true, priorOutputKinds: ["implementation"],
      assigneeType: AssigneeType.AGENT, assigneeAgentId: canonical.id, assigneeAgent: canonical,
      approvalGate: false, opensPullRequest: false, layer: 3, baseFromStepIndex: 2, runner: null,
    },
  ];
  const template = { id: "template-1", name: templateName, variables: [], steps };
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
      ? [{ id: template.id, projectId: "project-1", name: templateName }]
      : [
        canonical,
        revalidator,
        { ...routed, name: lockedRouteAgentName },
        { agentId: canonical.id, repoId: "repo-1" },
        { agentId: revalidator.id, repoId: "repo-1" },
        { agentId: routed.id, repoId: "repo-1" },
      ],
    staffingProfile: { findFirst: async () => null },
    taskTemplate: { findFirst: async () => ({ ...template, name: templateName }) },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agent: { findFirst: async () => routed },
    agentRepoAccess: { count: async () => 1 },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const task = { id: `task-${created.length + 1}`, ...data };
        created.push(task);
        return task;
      },
    },
    taskActivity: { createMany: async () => ({ count: created.length }) },
  };
  const db = {
    taskTemplate: {
      findFirst: async () => ({ ...template, name: templateName }),
    },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agent: {
      findFirst: async () => routed,
      findMany: async () => [routed],
    },
    agentRepoAccess: { findFirst: async () => ({ agentId: routed.id }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;

  const result = await instantiateTemplate(db, "project-1", "template-1", {
    repoId: "repo-1",
    variables: {},
    name: "routed implementation",
    description: "Build it\nRoute: implementation=senior-dev-astra-medium\n",
  });

  assert.equal(result.tasks.length, 2);
  assert.deepEqual(created.map((task) => task.assigneeAgentId), [routed.id, canonical.id]);
  assert.deepEqual(created.map((task) => task.chainIndex), [1, 2]);
  assert.deepEqual(created.map((task) => task.chainLayer), [1, 2]);
  assert.deepEqual(created.map((task) => task.targetBranch), ["main", result.branchName]);

  await assertTemplateRefusal(
    () => instantiateTemplate(db, "project-1", "template-1", {
      repoId: "repo-1",
      variables: {},
      name: "route conflict",
      description: "Build it\nRoute: implementation=senior-dev-astra-medium\n",
      stepOverrides: { "2": { assigneeAgentId: routed.id } },
    }),
    "implementation_route_conflicts_with_step_override",
  );

  lockedRouteAgentName = "renamed-senior-dev";
  await assertTemplateRefusal(
    () => instantiateTemplate(db, "project-1", "template-1", {
      repoId: "repo-1",
      variables: {},
      name: "route renamed",
      description: "Build it\nRoute: implementation=senior-dev-astra-medium\n",
    }),
    "implementation_route_agent_renamed",
  );

  lockedRouteAgentName = routed.name;
  await assertTemplateRefusal(
    () => instantiateTemplate(db, "project-1", "template-1", {
      repoId: "repo-1",
      variables: {},
      name: "route malformed",
      description: "Build it\nRoute: senior-dev-astra-medium - missing the implementation= key\n",
    }),
    "implementation_route_malformed",
  );

  for (const nonDirectName of ["custom-workflow", "compound-engineer-workflow"]) {
    templateName = nonDirectName;
    const originalOutputKind = steps[1]!.outputKind;
    if (nonDirectName === "compound-engineer-workflow") steps[1]!.outputKind = "documentation";
    for (const route of ["senior-dev-astra-medium", "unknown-agent"]) {
      await assertTemplateRefusal(
        () => instantiateTemplate(db, "project-1", "template-1", {
          repoId: "repo-1",
          variables: {},
          name: "unsupported route",
          description: `Route: implementation=${route}`,
        }),
        "implementation_route_template_unsupported",
        /remove the Route line from the description or use stepOverrides/u,
      );
    }
    const malformedTolerated = await instantiateTemplate(db, "project-1", "template-1", {
      repoId: "repo-1",
      variables: {},
      name: "malformed route prose",
      description: "Route: senior-dev-astra-medium - Route-looking prose is not parsed here",
    });
    assert.equal(malformedTolerated.tasks.length, 3, `${nonDirectName} must ignore malformed Route prose`);
    steps[1]!.outputKind = originalOutputKind;
  }
});

test("canonical unbound direct instantiation retains the seven-task prompt snapshot", async () => {
  const [source, canonicalRoles] = await Promise.all([
    loadTemplateStepSources("direct-engineer-workflow"),
    loadAgentSources().then(({ roles }) => roles),
  ]);
  const agents = new Map(canonicalRoles.map((role, index) => [role.name, {
    id: `snapshot-agent-${index}`,
    name: role.name,
    projectId: "project-1",
    archivedAt: null,
    model: role.model,
    runnerPreference: role.runnerPreference,
    codexServiceTier: CodexServiceTier.DEFAULT,
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  }]));
  const steps = source.map((contract) => {
    const agent = contract.agentName
      ? agents.get(contract.agentName)!
      : null;
    return {
      id: `snapshot-step-${contract.stepIndex}`,
      ...contract,
      prompt: contract.prompt,
      assigneeAgentId: agent?.id ?? null,
      assigneeAgent: agent,
      assigneeType: agent ? AssigneeType.AGENT : AssigneeType.HUMAN,
      runner: null,
    };
  });
  const created: Array<Record<string, unknown>> = [];
  const lockedRows = [
    ...agents.values(),
    ...[...agents.values()].map((agent) => ({ agentId: agent.id, repoId: "repo-1" })),
  ];
  const template = { id: "template-direct", name: "direct-engineer-workflow", variables: ["branchName"], steps };
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
      ? [{ id: template.id, projectId: "project-1", name: template.name }]
      : lockedRows,
    staffingProfile: { findFirst: async () => null },
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { count: async () => 1 },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `snapshot-task-${created.length + 1}`, ...data };
        created.push(row);
        return row;
      },
    },
    taskActivity: { createMany: async () => ({ count: created.length }) },
  };
  const db = {
    staffingProfile: { findFirst: async () => null },
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agent: { findMany: async () => [], findFirst: async () => null },
    agentRepoAccess: { findFirst: async () => ({ id: "grant" }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;

  const result = await instantiateTemplate(db, "project-1", "template-direct", {
    repoId: "repo-1",
    variables: { branchName: "snapshot-branch" },
    name: "snapshot chain",
    description: "Snapshot brief.",
  });
  assert.equal(result.tasks.length, 7);
  assert.deepEqual(created.map((row) => ({
    name: row.name,
    descriptionSha256: createHash("sha256").update(String(row.description)).digest("hex"),
  })), [
    { name: "snapshot chain: Implementation", descriptionSha256: "45327aeb86fc7e98a76ef4052278cee29ceb38a601aeb65225024b87708225d0" },
    { name: "snapshot chain: Code review", descriptionSha256: "9b6d28537d11423006f897eb0661e6120ff8ea96f8857cfa6b4cfe06ad3c3c27" },
    { name: "snapshot chain: Blind code review", descriptionSha256: "af02f099a6e2b6b10f3ea2b31b8bcfd06a057cd91b134c16a3df552690fc979b" },
    { name: "snapshot chain: Apply review fixes", descriptionSha256: "89607144c06f5ee42b01f9d3e3ae1513d5d5232f8b0541d736b505b312408a8e" },
    { name: "snapshot chain: Regression verification", descriptionSha256: "5ba403dde0fa9a2becfe969646691f59e3db947ef3eefed1ed2150db2db11dbd" },
    { name: "snapshot chain: Merge authorization", descriptionSha256: "6cc850c691d3334a0ba8e4b26b24acdc3c7ab70c4b8cbac1fccb65ee708a7da7" },
    { name: "snapshot chain: Merge execution", descriptionSha256: "6f3ee10eef0967fec9bfdb09a73ab8b9f5e07aa3e4548e48d1174e2a90602a53" },
  ]);
});

test("instantiation resolves only the two gate slots from overrides then project defaults", async () => {
  const agent = (id: string) => ({
    id,
    name: id,
    projectId: "project-1",
    archivedAt: null,
    model: "codex",
    runnerPreference: RunnerPreference.CODEX,
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  });
  const agents = [agent("agent-spec"), agent("agent-work"), agent("agent-merge")];
  const steps = [
    {
      id: "step-spec", stepIndex: 1, name: "Specification", prompt: "spec", outputKind: "spec",
      attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
      assigneeAgentId: "agent-spec", assigneeAgent: agents[0], approvalGate: false,
      opensPullRequest: false, layer: 1, baseFromStepIndex: null, runner: null, optional: false,
    },
    {
      id: "step-work", stepIndex: 2, name: "Work", prompt: "work", outputKind: "review",
      attachmentsFromPrevious: true, priorOutputKinds: ["spec"], assigneeType: AssigneeType.AGENT,
      assigneeAgentId: "agent-work", assigneeAgent: agents[1], approvalGate: true,
      opensPullRequest: false, layer: 2, baseFromStepIndex: null, runner: null, optional: true,
    },
    {
      id: "step-retained", stepIndex: 3, name: "Retained work", prompt: "retained", outputKind: "revised-plan",
      attachmentsFromPrevious: true, priorOutputKinds: ["spec"], assigneeType: AssigneeType.AGENT,
      assigneeAgentId: "agent-work", assigneeAgent: agents[1], approvalGate: true,
      opensPullRequest: false, layer: 3, baseFromStepIndex: null, runner: null, optional: false,
    },
    {
      id: "step-merge", stepIndex: 4, name: "Readiness", prompt: "merge", outputKind: "merge-authorization",
      attachmentsFromPrevious: true, priorOutputKinds: ["revised-plan"], assigneeType: AssigneeType.AGENT,
      assigneeAgentId: "agent-merge", assigneeAgent: agents[2], approvalGate: false,
      opensPullRequest: false, layer: 4, baseFromStepIndex: null, runner: null, optional: false,
    },
  ];
  const template = { id: "template-gates", name: "compound-fixture", variables: [], steps };
  const projectDefaults = { specGateDefault: false, mergeGateDefault: false };
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray | Prisma.Sql) => {
      const sql = "sql" in query ? query.sql : query.join(" ");
      if (sql.includes('"TaskTemplate"')) return [{ id: template.id, projectId: "project-1", name: template.name }];
      if (sql.includes('"Project"')) return [{ id: "project-1", ...projectDefaults }];
      if (sql.includes('"AgentRepoAccess"')) return agents.map(({ id }) => ({ agentId: id, repoId: "repo-1" }));
      if (sql.includes('"Agent"')) return agents;
      return [];
    },
    project: {},
    staffingProfile: { findFirst: async () => null },
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { count: async () => 1 },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const task = { id: `task-${created.length + 1}`, ...data };
        created.push(task);
        return task;
      },
    },
    taskActivity: { createMany: async () => ({ count: created.length }) },
  };
  const db = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;

  const instantiate = async (
    defaults: { specGateDefault: boolean; mergeGateDefault: boolean },
    gates?: { spec?: boolean; merge?: boolean },
    stepOverrides?: Record<string, { assigneeAgentId?: string; include?: boolean }>,
  ) => {
    projectDefaults.specGateDefault = defaults.specGateDefault;
    projectDefaults.mergeGateDefault = defaults.mergeGateDefault;
    created.length = 0;
    return instantiateTemplate(db, "project-1", template.id, {
      repoId: "repo-1", variables: {}, autoStart: false, name: "gate matrix", gates, stepOverrides,
    });
  };

  const matrix: Array<[
    { specGateDefault: boolean; mergeGateDefault: boolean },
    { spec?: boolean; merge?: boolean } | undefined,
    boolean,
    boolean,
  ]> = [
    [{ specGateDefault: false, mergeGateDefault: false }, undefined, false, false],
    [{ specGateDefault: false, mergeGateDefault: false }, { spec: true, merge: true }, true, true],
    [{ specGateDefault: false, mergeGateDefault: true }, undefined, false, true],
    [{ specGateDefault: false, mergeGateDefault: true }, { spec: true, merge: false }, true, false],
    [{ specGateDefault: true, mergeGateDefault: false }, undefined, true, false],
    [{ specGateDefault: true, mergeGateDefault: false }, { spec: false, merge: true }, false, true],
    [{ specGateDefault: true, mergeGateDefault: true }, undefined, true, true],
    [{ specGateDefault: true, mergeGateDefault: true }, { spec: false, merge: false }, false, false],
    [{ specGateDefault: true, mergeGateDefault: false }, { spec: true }, true, false],
    [{ specGateDefault: false, mergeGateDefault: false }, { spec: false, merge: false }, false, false],
  ];
  for (const [defaults, gates, specGate, mergeGate] of matrix) {
    const result = await instantiate(defaults, gates);
    assert.deepEqual(result.tasks.map((task) => task.approvalGate), [specGate, true, true, mergeGate]);
  }

  const sparse = await instantiate(
    { specGateDefault: false, mergeGateDefault: false },
    undefined,
    { "2": { include: false } },
  );
  assert.deepEqual(sparse.tasks.map((task) => task.chainIndex), [1, 3, 4]);
  assert.deepEqual(sparse.tasks.map((task) => task.chainLayer), [1, 3, 4]);
  assert.deepEqual(sparse.tasks.map((task) => task.name), [
    "gate matrix: Specification",
    "gate matrix: Retained work",
    "gate matrix: Readiness",
  ]);
});

test("instantiate refuses absent gate slots before creating any task and checks spec first", async () => {
  const created: Array<Record<string, unknown>> = [];
  const step = {
    id: "step-work", stepIndex: 1, name: "Work", prompt: "work", outputKind: "review",
    attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
    assigneeAgentId: "agent-1", assigneeAgent: {
      id: "agent-1", name: "agent-1", projectId: "project-1", archivedAt: null,
      model: "codex", runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation", rolePrompt: "role",
    }, approvalGate: false, opensPullRequest: false, layer: 1, baseFromStepIndex: null, runner: null,
  };
  const template = { id: "template-neither", name: "pull-request-workflow", variables: [], steps: [step] };
  const tx = {
    $queryRaw: async (query: TemplateStringsArray | Prisma.Sql) => {
      const sql = "sql" in query ? query.sql : query.join(" ");
      if (sql.includes('"TaskTemplate"')) return [{ id: template.id, projectId: "project-1", name: template.name }];
      if (sql.includes('"Project"')) return [{ id: "project-1", specGateDefault: false, mergeGateDefault: false }];
      if (sql.includes('"AgentRepoAccess"')) return [{ agentId: "agent-1", repoId: "repo-1" }];
      if (sql.includes('"Agent"')) return [{ id: "agent-1", name: "agent-1", projectId: "project-1", archivedAt: null }];
      return [];
    },
    project: {},
    staffingProfile: { findFirst: async () => null },
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { count: async () => 1 },
    task: { create: async ({ data }: { data: Record<string, unknown> }) => {
      const task = { id: `task-${created.length + 1}`, ...data };
      created.push(task);
      return task;
    } },
    taskActivity: { createMany: async () => ({ count: created.length }) },
  };
  const db = { $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx) } as unknown as PrismaClient;
  for (const [gates, code, slot] of [
    [{ spec: true }, "gates_spec_step_absent", "specification"] as const,
    [{ merge: true }, "gates_merge_step_absent", "merge"] as const,
    [{ spec: true, merge: true }, "gates_spec_step_absent", "specification"] as const,
  ]) {
    created.length = 0;
    await assertTemplateRefusal(
      () => instantiateTemplate(db, "project-1", template.id, { repoId: "repo-1", variables: {}, name: "absent gate", gates }),
      code,
    );
    assert.equal(created.length, 0, `${slot} refusal must not partially materialize a chain`);
  }
});

/**
 * The staffing fixture below drives `instantiateTemplate` through a stubbed
 * transaction. It is the only proof of R4's three-way precedence available in
 * this lane: `packages/db/prisma/schema.prisma` belongs to the profile-model
 * lane, so the generated client here has no `StaffingProfile` delegate and
 * `staffing-precedence.dbtest.ts` cannot run until that model lands.
 */
type FixtureProfile = {
  id: string;
  name: string;
  taskTemplateId: string;
  isDefault: boolean;
  entries: Array<{ outputKind: string; assigneeAgentId: string | null; include: boolean | null }>;
};

const staffingFixture = (options: {
  templateName?: string;
  profiles?: FixtureProfile[];
  agentOverrides?: Record<string, Partial<{ projectId: string; archivedAt: Date | null }>>;
  grantedAgentIds?: string[];
} = {}) => {
  const templateId = "template-staffing";
  const agentRow = (id: string) => ({
    id,
    name: id,
    projectId: "project-1",
    archivedAt: null as Date | null,
    model: "gpt-5-codex",
    runnerPreference: RunnerPreference.CODEX,
    codexServiceTier: CodexServiceTier.DEFAULT,
    foundationalPrompt: "foundation",
    rolePrompt: "role",
    ...options.agentOverrides?.[id],
  });
  const agents = ["agent-canonical", "agent-profile", "agent-override"].map(agentRow);
  const step = (stepIndex: number, name: string, outputKind: string, optional: boolean) => ({
    id: `step-${stepIndex}`,
    stepIndex,
    name,
    prompt: `${name} prompt`,
    outputKind,
    attachmentsFromPrevious: false,
    priorOutputKinds: [] as string[],
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: "agent-canonical",
    assigneeAgent: agents[0],
    approvalGate: false,
    opensPullRequest: false,
    layer: stepIndex,
    baseFromStepIndex: null,
    runner: null,
    optional,
  });
  const template = {
    id: templateId,
    name: options.templateName ?? "staffing-fixture",
    variables: [] as string[],
    steps: [
      step(1, "Implementation", "implementation", false),
      step(2, "Blind review", "blind-findings", true),
      step(3, "Fix", "fixed-implementation", false),
    ],
  };
  const profiles = options.profiles ?? [];
  const granted = new Set(options.grantedAgentIds ?? agents.map(({ id }) => id));
  const created: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const matches = (profile: FixtureProfile, where: Record<string, unknown>): boolean => (
    Object.entries(where).every(([key, value]) => (profile as unknown as Record<string, unknown>)[key] === value)
  );
  const tx = {
    $queryRaw: async (query: TemplateStringsArray | Prisma.Sql, ...bound: unknown[]) => {
      const sql = "sql" in query ? query.sql : query.join(" ");
      const values = "sql" in query ? query.values as unknown[] : bound;
      if (sql.includes('"TaskTemplate"')) return [{ id: template.id, projectId: "project-1", name: template.name }];
      if (sql.includes('"Project"')) return [{ id: "project-1", specGateDefault: false, mergeGateDefault: false }];
      if (sql.includes('"AgentRepoAccess"')) {
        const agentId = values[1] as string | undefined;
        return agentId !== undefined && granted.has(agentId) ? [{ agentId, repoId: "repo-1" }] : [];
      }
      if (sql.includes('"Agent"')) {
        // The Agent lock interpolates a raw projection fragment before its id
        // list, so the ids are the one array-valued binding, not the first.
        const requested = new Set(values.find(Array.isArray) as string[]);
        return agents.filter(({ id }) => requested.has(id));
      }
      return [];
    },
    project: {},
    staffingProfile: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => (
        profiles.find((profile) => matches(profile, where)) ?? null
      ),
    },
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { count: async () => 1 },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const task = { id: `task-${created.length + 1}`, ...data };
        created.push(task);
        return task;
      },
    },
    taskActivity: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        activities.push(...data);
        return { count: data.length };
      },
    },
  };
  const db = {
    agent: {
      findFirst: async ({ where }: { where: { name: string } }) => agents.find(({ name }) => name === where.name) ?? null,
    },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  const instantiate = (input: Partial<Parameters<typeof instantiateTemplate>[3]> = {}) => {
    created.length = 0;
    activities.length = 0;
    return instantiateTemplate(db, "project-1", templateId, {
      repoId: "repo-1", variables: {}, name: "staffing chain", ...input,
    });
  };
  return { templateId, instantiate, activities, created };
};

const defaultProfile = (taskTemplateId: string, entries: FixtureProfile["entries"]): FixtureProfile => ({
  id: "profile-default", name: "Default", taskTemplateId, isDefault: true, entries,
});

test("instantiation staffs each step from the override, then the profile, then the canonical binding", async () => {
  const fixture = staffingFixture({
    profiles: [defaultProfile("template-staffing", [
      { outputKind: "implementation", assigneeAgentId: "agent-profile", include: null },
      { outputKind: "blind-findings", assigneeAgentId: "agent-profile", include: true },
    ])],
  });

  const staffed = await fixture.instantiate();
  assert.deepEqual(staffed.tasks.map((task) => task.assigneeAgentId), [
    "agent-profile",
    "agent-profile",
    "agent-canonical",
  ]);

  const overridden = await fixture.instantiate({
    stepOverrides: { "1": { assigneeAgentId: "agent-override" }, "3": { assigneeAgentId: "agent-override" } },
  });
  assert.deepEqual(overridden.tasks.map((task) => task.assigneeAgentId), [
    "agent-override",
    "agent-profile",
    "agent-override",
  ]);
});

test("optional-step inclusion resolves override, then profile, then the template's own declaration", async () => {
  const excluding = staffingFixture({
    profiles: [defaultProfile("template-staffing", [
      { outputKind: "blind-findings", assigneeAgentId: null, include: false },
    ])],
  });
  const skipped = await excluding.instantiate();
  assert.deepEqual(skipped.tasks.map((task) => task.chainIndex), [1, 3]);

  const kept = await excluding.instantiate({ stepOverrides: { "2": { include: true } } });
  assert.deepEqual(kept.tasks.map((task) => task.chainIndex), [1, 2, 3]);

  const unstaffed = staffingFixture();
  const canonical = await unstaffed.instantiate();
  assert.deepEqual(canonical.tasks.map((task) => task.chainIndex), [1, 2, 3]);
  assert.deepEqual(canonical.tasks.map((task) => task.assigneeAgentId), [
    "agent-canonical",
    "agent-canonical",
    "agent-canonical",
  ]);

  const dropped = await unstaffed.instantiate({ stepOverrides: { "2": { include: false } } });
  assert.deepEqual(dropped.tasks.map((task) => task.chainIndex), [1, 3]);
});

test("a template whose profiles were all deleted instantiates from its canonical bindings", async () => {
  const withoutProfiles = staffingFixture({ profiles: [] });
  const chain = await withoutProfiles.instantiate();
  assert.deepEqual(chain.tasks.map((task) => task.assigneeAgentId), [
    "agent-canonical",
    "agent-canonical",
    "agent-canonical",
  ]);
  assert.ok(withoutProfiles.activities.every(
    (activity) => !Object.hasOwn(activity.metadata as Record<string, unknown>, "staffingProfileId"),
  ));
});

test("the chain root activity records which staffing profile produced the assignees", async () => {
  const fixture = staffingFixture({
    profiles: [defaultProfile("template-staffing", [
      { outputKind: "implementation", assigneeAgentId: "agent-profile", include: null },
    ])],
  });
  await fixture.instantiate();
  const metadata = fixture.activities.map((activity) => activity.metadata as Record<string, unknown>);
  assert.equal(metadata[0]!.staffingProfileId, "profile-default");
  assert.equal(metadata[0]!.staffingProfileName, "Default");
  // Every later step reads its staffing from its own Task row; repeating the
  // provenance there would create a second, divergeable record of it.
  for (const later of metadata.slice(1)) assert.equal(later.staffingProfileId, undefined);
});

test("a named staffing profile is selected by id or by the brief line, and a wrong name refuses", async () => {
  const profiles: FixtureProfile[] = [
    defaultProfile("template-staffing", [
      { outputKind: "implementation", assigneeAgentId: "agent-canonical", include: null },
    ]),
    {
      id: "profile-weekend",
      name: "Weekend crew",
      taskTemplateId: "template-staffing",
      isDefault: false,
      entries: [{ outputKind: "implementation", assigneeAgentId: "agent-profile", include: null }],
    },
  ];
  const fixture = staffingFixture({ profiles });

  const byId = await fixture.instantiate({ staffingProfileId: "profile-weekend" });
  assert.equal(byId.tasks[0]!.assigneeAgentId, "agent-profile");

  const byLine = await fixture.instantiate({ description: "Do it\nStaffing: Weekend crew\n" });
  assert.equal(byLine.tasks[0]!.assigneeAgentId, "agent-profile");

  // A profile of another template is not addressable from this one.
  await assertTemplateRefusal(
    () => fixture.instantiate({ staffingProfileId: "profile-of-another-template" }),
    "staffing_profile_not_found",
  );
  await assertTemplateRefusal(
    () => fixture.instantiate({ description: "Staffing: Night crew" }),
    "staffing_profile_not_found",
  );
  await assertTemplateRefusal(
    () => fixture.instantiate({ description: "Staffing:Weekend crew" }),
    "staffing_profile_line_malformed",
  );
  await assertTemplateRefusal(
    () => fixture.instantiate({ staffingProfileId: "profile-default", description: "Staffing: Weekend crew" }),
    "staffing_profile_conflicts_with_selection",
  );
});

test("a profile that names an unusable agent refuses with its own code, never the template's", async () => {
  const entries = [{ outputKind: "implementation", assigneeAgentId: "agent-profile", include: null }];
  const archived = staffingFixture({
    profiles: [defaultProfile("template-staffing", entries)],
    agentOverrides: { "agent-profile": { archivedAt: new Date("2026-09-01T00:00:00.000Z") } },
  });
  await assertTemplateRefusal(() => archived.instantiate(), "staffing_profile_agent_archived");

  const foreign = staffingFixture({
    profiles: [defaultProfile("template-staffing", entries)],
    agentOverrides: { "agent-profile": { projectId: "project-2" } },
  });
  await assertTemplateRefusal(() => foreign.instantiate(), "staffing_profile_agent_foreign");

  const missing = staffingFixture({
    profiles: [defaultProfile("template-staffing", [
      { outputKind: "implementation", assigneeAgentId: "agent-deleted", include: null },
    ])],
  });
  await assertTemplateRefusal(() => missing.instantiate(), "staffing_profile_agent_not_found");

  const ungranted = staffingFixture({
    profiles: [defaultProfile("template-staffing", entries)],
    grantedAgentIds: ["agent-canonical", "agent-override"],
  });
  await assertTemplateRefusal(() => ungranted.instantiate(), "staffing_profile_missing_repo_grant");
});

test("an inclusion decision about a required step is refused rather than discarded", async () => {
  const fixture = staffingFixture();
  await assertTemplateRefusal(
    () => fixture.instantiate({ stepOverrides: { "1": { include: false } } }),
    "step_override_include_not_optional",
  );
});

test("a Route line coexists with a profile and conflicts only with an explicit assignee override", async () => {
  const profiles = [defaultProfile("template-staffing", [
    { outputKind: "implementation", assigneeAgentId: "agent-profile", include: null },
    { outputKind: "fixed-implementation", assigneeAgentId: "agent-profile", include: null },
  ])];
  const fixture = staffingFixture({ templateName: "direct-engineer-workflow", profiles });

  // The Route line beats the profile for the implementation step and leaves
  // every other step staffed by that same profile.
  const routed = await fixture.instantiate({ description: "Do it\nRoute: implementation=agent-override" });
  assert.deepEqual(routed.tasks.map((task) => task.assigneeAgentId), [
    "agent-override",
    "agent-canonical",
    "agent-profile",
  ]);

  // An include-only override answers a different question, so it does not
  // conflict with the Route line.
  const withInclude = await fixture.instantiate({
    description: "Route: implementation=agent-override",
    stepOverrides: { "2": { include: false } },
  });
  assert.deepEqual(withInclude.tasks.map((task) => task.assigneeAgentId), [
    "agent-override",
    "agent-profile",
  ]);

  await assertTemplateRefusal(
    () => fixture.instantiate({
      description: "Route: implementation=agent-override",
      stepOverrides: { "1": { assigneeAgentId: "agent-profile" } },
    }),
    "implementation_route_conflicts_with_step_override",
  );
});
