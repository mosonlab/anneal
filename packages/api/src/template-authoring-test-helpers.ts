import {
  AssigneeType,
  Prisma,
  RunnerKind,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "./test-app.js";

export const TEMPLATE_AUTHORING_OPERATOR = "template-authoring-validator-operator";

type ProjectEnvironment = {
  project: { id: string };
  environment: { id: string };
};

const unique = (label: string): string => (
  `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}`
);

export const seedAgent = async (
  db: PrismaClient,
  seed: ProjectEnvironment,
  name: string,
) => db.agent.create({
  data: {
    projectId: seed.project.id,
    environmentId: seed.environment.id,
    name,
    title: name,
    model: "gpt-5.6-sol:medium",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  },
});

export const seedAuthoringTemplate = async (
  db: PrismaClient,
  label: string,
  name = "editable-template",
) => {
  const project = await db.project.create({ data: { name: label, slug: unique(label) } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agents = await Promise.all([
    "implementation-agent",
    "review-agent",
    "regression-agent",
  ].map((agentName) => seedAgent(db, { project, environment }, agentName)));
  const template = await db.taskTemplate.create({
    data: {
      projectId: project.id,
      name,
      description: "Editable template",
      variables: ["branchName"],
    },
  });
  const steps = await Promise.all([
    db.taskTemplateStep.create({
      data: {
        taskTemplateId: template.id,
        stepIndex: 1,
        layer: 1,
        name: "Implementation",
        assigneeType: AssigneeType.AGENT,
        assigneeAgentId: agents[0]!.id,
        prompt: "Implement the change",
        approvalGate: false,
        attachmentsFromPrevious: false,
        priorOutputKinds: [],
        spawnPolicy: { maxChildren: 2 },
        runner: RunnerKind.CODEX,
        outputKind: "implementation",
        opensPullRequest: true,
        requiresCommit: true,
        baseFromStepIndex: null,
      },
    }),
    db.taskTemplateStep.create({
      data: {
        taskTemplateId: template.id,
        stepIndex: 2,
        layer: 2,
        name: "Code review",
        assigneeType: AssigneeType.AGENT,
        assigneeAgentId: agents[1]!.id,
        prompt: "Review the implementation",
        approvalGate: false,
        attachmentsFromPrevious: true,
        priorOutputKinds: ["implementation"],
        spawnPolicy: Prisma.JsonNull,
        runner: null,
        outputKind: "review-findings",
        opensPullRequest: false,
        requiresCommit: false,
        baseFromStepIndex: 1,
      },
    }),
    db.taskTemplateStep.create({
      data: {
        taskTemplateId: template.id,
        stepIndex: 3,
        layer: 3,
        name: "Regression verification",
        assigneeType: AssigneeType.AGENT,
        assigneeAgentId: agents[2]!.id,
        prompt: "Verify the implementation",
        approvalGate: false,
        attachmentsFromPrevious: true,
        priorOutputKinds: ["implementation"],
        spawnPolicy: Prisma.JsonNull,
        runner: null,
        outputKind: "regression-verification",
        opensPullRequest: false,
        requiresCommit: false,
        baseFromStepIndex: 1,
      },
    }),
  ]);
  return { project, environment, agents, template, steps };
};

export type SeededAuthoringTemplate = Awaited<ReturnType<typeof seedAuthoringTemplate>>;

export type ReplaceStepPayload = {
  name: string;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  prompt: string;
  approvalGate: boolean;
  optional: boolean;
  attachmentsFromPrevious: boolean;
  priorOutputKinds: string[];
  spawnPolicy: Record<string, unknown> | null;
  runner: RunnerKind | null;
  outputKind: string;
  opensPullRequest: boolean;
  requiresCommit: boolean;
  baseFromStepIndex: number | null;
  layer: number;
};

export const stepPayload = (
  seed: SeededAuthoringTemplate,
  index: number,
  overrides: Partial<ReplaceStepPayload> = {},
): ReplaceStepPayload => ({
  name: `Step ${index}`,
  assigneeType: AssigneeType.AGENT,
  assigneeAgentId: seed.agents[0]!.id,
  prompt: `Do step ${index}`,
  approvalGate: false,
  optional: false,
  attachmentsFromPrevious: false,
  priorOutputKinds: [],
  spawnPolicy: null,
  runner: RunnerKind.CODEX,
  outputKind: `kind-${index}`,
  opensPullRequest: false,
  requiresCommit: false,
  baseFromStepIndex: null,
  layer: index,
  ...overrides,
});

export const replaceRequest = async (
  db: PrismaClient,
  projectId: string,
  templateId: string,
  body: unknown,
): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request(
    `/projects/${projectId}/task-templates/${templateId}/steps`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TEMPLATE_AUTHORING_OPERATOR}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

export const stepSnapshot = (step: any) => ({
  stepIndex: step.stepIndex,
  layer: step.layer,
  name: step.name,
  assigneeType: step.assigneeType,
  assigneeAgentId: step.assigneeAgentId,
  prompt: step.prompt,
  approvalGate: step.approvalGate,
  optional: step.optional,
  attachmentsFromPrevious: step.attachmentsFromPrevious,
  priorOutputKinds: step.priorOutputKinds,
  spawnPolicy: step.spawnPolicy,
  runner: step.runner,
  outputKind: step.outputKind,
  opensPullRequest: step.opensPullRequest,
  requiresCommit: step.requiresCommit,
  baseFromStepIndex: step.baseFromStepIndex,
});

export const readStepSnapshots = async (db: PrismaClient, templateId: string) => (
  (await db.taskTemplateStep.findMany({
    where: { taskTemplateId: templateId },
    orderBy: { stepIndex: "asc" },
  })).map(stepSnapshot)
);
