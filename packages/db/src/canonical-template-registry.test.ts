import assert from "node:assert/strict";
import test from "node:test";

import { PR_TEMPLATE_NAME } from "./agent-contract.js";
import {
  canonicalTemplateIdentity,
  LEGACY_TEMPLATE_GENERATIONS,
} from "./canonical-template-transition.js";
import {
  planCanonicalInstallation,
  type CanonicalInstallationRow,
  type CanonicalInstallationSources,
} from "./canonical-template-installation.js";
import type { TemplateStepSource } from "./template-sources.js";

test("the pull-request template has current identity and prompt history", () => {
  assert.equal(PR_TEMPLATE_NAME, "pr-engineer-workflow");
  assert.deepEqual(canonicalTemplateIdentity(PR_TEMPLATE_NAME), {
    canonicalName: PR_TEMPLATE_NAME,
    generation: null,
  });
  assert.deepEqual(
    LEGACY_TEMPLATE_GENERATIONS[PR_TEMPLATE_NAME].map(({ marker, promptDigest }) => ({ marker, promptDigest })),
    [{
      marker: "pre-pr-handover-quality",
      promptDigest: "93a72d354876a6c26020e8638b6c365fb15e4ca4a400a2d6ca80084994f249d6",
    }, {
      marker: "pre-pr-head-tree-check",
      promptDigest: "805b9e911be94c84e451cdbf4d1cdb93ab10031c031c6854947f56d306fb1906",
    }, {
      marker: "pre-astra-low-review-fix",
      promptDigest: undefined,
    }, {
      marker: "model-neutral-review-step-names",
      promptDigest: undefined,
    }, {
      marker: "pre-salvage-resume",
      promptDigest: "1c1169bf0586f6bb71f4ed34b3eb6b166828802a9b24c6b07844b2f526b5f8a8",
    }, {
      marker: "pre-model-neutral-review-output",
      promptDigest: undefined,
    }],
  );
});

test("a matching no-history pull-request row is current, never a rollover", () => {
  const sourceSteps: TemplateStepSource[] = [
    {
      stepIndex: 1,
      name: "Implementation",
      layer: 1,
      agentName: "senior-dev-luna-max",
      approvalGate: false,
      optional: false,
      outputKind: "implementation",
      attachmentsFromPrevious: false,
      priorOutputKinds: [],
      opensPullRequest: true,
      requiresCommit: true,
      provisionDependencies: true,
      baseFromStepIndex: null,
      spawnPolicy: null,
      prompt: "implementation",
    },
    {
      stepIndex: 2,
      name: "Code review",
      layer: 2,
      agentName: "code-reviewer-sol-high",
      approvalGate: false,
      optional: false,
      outputKind: "review-findings",
      attachmentsFromPrevious: true,
      priorOutputKinds: ["implementation"],
      opensPullRequest: false,
      requiresCommit: false,
      provisionDependencies: false,
      baseFromStepIndex: 1,
      spawnPolicy: null,
      prompt: "sol",
    },
    {
      stepIndex: 3,
      name: "Blind code review",
      layer: 2,
      agentName: "code-reviewer-opus-medium",
      approvalGate: false,
      optional: false,
      outputKind: "blind-findings",
      attachmentsFromPrevious: false,
      priorOutputKinds: [],
      opensPullRequest: false,
      requiresCommit: false,
      provisionDependencies: false,
      baseFromStepIndex: 1,
      spawnPolicy: null,
      prompt: "blind",
    },
    {
      stepIndex: 4,
      name: "Apply review fixes",
      layer: 3,
      agentName: "senior-dev-astra-low",
      approvalGate: false,
      optional: false,
      outputKind: "fixed-implementation",
      attachmentsFromPrevious: true,
      priorOutputKinds: ["review-findings", "blind-findings"],
      opensPullRequest: false,
      requiresCommit: false,
      provisionDependencies: true,
      baseFromStepIndex: null,
      spawnPolicy: null,
      prompt: "fixes",
    },
  ];
  const sourceMap = new Map([[PR_TEMPLATE_NAME as never, sourceSteps]]) as unknown as CanonicalInstallationSources;
  const row = {
    id: "template",
    projectId: "project",
    name: PR_TEMPLATE_NAME as never,
    steps: sourceSteps.map((step) => ({
      id: `step-${String(step.stepIndex)}`,
      taskTemplateId: "template",
      stepIndex: step.stepIndex,
      name: step.name,
      assigneeAgent: step.agentName === null ? null : { name: step.agentName },
      assigneeType: step.agentName === null ? "HUMAN" : "AGENT",
      layer: step.layer,
      approvalGate: step.approvalGate,
      optional: step.optional,
      outputKind: step.outputKind,
      attachmentsFromPrevious: step.attachmentsFromPrevious,
      priorOutputKinds: step.priorOutputKinds,
      opensPullRequest: step.opensPullRequest,
      requiresCommit: step.requiresCommit,
      provisionDependencies: step.provisionDependencies,
      baseFromStepIndex: step.baseFromStepIndex,
      spawnPolicy: step.spawnPolicy,
      prompt: step.prompt,
    })),
  } as unknown as CanonicalInstallationRow;

  assert.deepEqual(planCanonicalInstallation([row], sourceMap), [{
    kind: "current",
    templateName: PR_TEMPLATE_NAME,
    projectId: "project",
    rowId: "template",
  }]);
});
