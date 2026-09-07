import { randomUUID } from "node:crypto";

import {
  AssigneeType,
  canonicalIntegratorBindingRefusal,
  COMPOUND_IMPLEMENTATION_ASSIGNEE_MESSAGE,
  compoundImplementationAssigneeValid,
  DIRECT_TEMPLATE_NAME,
  enqueueTaskRun,
  gateSlotOf,
  isDirectImplementationStep,
  lockAgentRepoGrant,
  lockAgentRows,
  lockChainRows,
  lockProjectGateDefaults,
  lockTemplateRow,
  Prisma,
  type PrismaClient,
  TaskSource,
  TaskStatus,
  type TriggerFireSource,
} from "@anneal/db";
import { layerOf } from "@anneal/db/chain-order";

import { isValidBranchName } from "./branch-name.js";
import { templateStepInstantiation } from "./chain-step-omission.js";
import { composeBrief } from "./task-brief.js";
import {
  TemplateInstantiationRefusal,
  type TemplateInstantiationRefusalCode,
} from "./template-errors.js";
import { serializable } from "./transaction.js";

/**
 * One per-instantiation change to a single template step. Both members are
 * optional and independent: an entry may re-assign an agent, decide whether an
 * optional step is instantiated, or do both.
 */
export type StepOverrideInput = {
  assigneeAgentId?: string | undefined;
  include?: boolean | undefined;
};

export type InstantiateTemplateInput = {
  repoId: string;
  variables: Record<string, string>;
  /** Creating a chain is inert unless its caller explicitly requests a run. */
  autoStart?: boolean;
  name: string;
  description?: string | undefined;
  /** Existing terminal task whose completion will dispatch this chain. */
  afterTaskId?: string | undefined;
  /** Per-instantiation assignee and inclusion changes, keyed by template stepIndex. */
  stepOverrides?: Record<string, StepOverrideInput> | undefined;
  /** Per-instantiation approval-gate changes for the two configurable slots. */
  gates?: { spec?: boolean | undefined; merge?: boolean | undefined } | undefined;
  /** Staffing profile of this template to resolve assignees and optional steps from. */
  staffingProfileId?: string | undefined;
};

type ProjectInstantiationDefaults = {
  specGateDefault: boolean;
  mergeGateDefault: boolean;
};

const DEFAULT_PROJECT_INSTANTIATION_DEFAULTS: ProjectInstantiationDefaults = {
  specGateDefault: false,
  mergeGateDefault: false,
};

const resolvedApprovalGate = (
  step: { outputKind: string; approvalGate: boolean },
  gates: InstantiateTemplateInput["gates"],
  defaults: ProjectInstantiationDefaults,
): boolean => {
  const slot = gateSlotOf(step);
  if (slot === "spec") return gates?.spec ?? defaults.specGateDefault ?? step.approvalGate;
  if (slot === "merge") return gates?.merge ?? defaults.mergeGateDefault ?? step.approvalGate;
  return step.approvalGate;
};

const stepOverrideKey = /^[1-9]\d*$/u;

const implementationRouteLine = /^Route: implementation=(.+)$/mu;

/** Read the machine-readable implementation route from a brief description. */
export const parseImplementationRoute = (description: string | undefined): string | null => {
  const match = description?.match(implementationRouteLine);
  const value = match?.[1];
  if (!value) return null;
  const reasonSeparator = value.indexOf(" - ");
  const name = reasonSeparator === -1 ? value : value.slice(0, reasonSeparator);
  const reason = reasonSeparator === -1 ? null : value.slice(reasonSeparator + 3);
  return name.length > 0 && name.length <= 80 && name.trim() === name && reason !== "" ? name : null;
};

/**
 * Finds the first line that claims to be a machine-readable route but does not
 * match the full grammar. A near-miss must refuse loudly: silently ignoring it
 * dispatches the implementation step on the template default agent while the
 * brief author believes their route was applied.
 */
export const findMalformedRouteLine = (description: string | undefined): string | null => {
  for (const line of (description ?? "").split("\n")) {
    if (line.startsWith("Route:") && parseImplementationRoute(line) === null) return line;
  }
  return null;
};

const staffingProfileLine = /^Staffing: (.+)$/mu;

/** The longest profile name `POST/PUT …/staffing-profiles` accepts. */
export const STAFFING_PROFILE_NAME_LIMIT = 200;

/**
 * Read the machine-readable staffing selection from a brief description.
 *
 * The length bound is the profile API's own (200 characters): a name the
 * operator was allowed to save must remain selectable, and a stricter parser
 * would report a legitimate profile as a malformed line.
 */
export const parseStaffingProfileName = (description: string | undefined): string | null => {
  const value = description?.match(staffingProfileLine)?.[1];
  if (!value) return null;
  return value.length <= STAFFING_PROFILE_NAME_LIMIT && value.trim() === value ? value : null;
};

/**
 * The `Staffing:` counterpart of {@link findMalformedRouteLine}, and for the
 * same reason: a near-miss that is silently ignored staffs the whole chain from
 * the template default while the brief author believes their profile applied.
 */
export const findMalformedStaffingLine = (description: string | undefined): string | null => {
  for (const line of (description ?? "").split("\n")) {
    if (line.startsWith("Staffing:") && parseStaffingProfileName(line) === null) return line;
  }
  return null;
};

/** One resolved staffing decision for the steps that declare `outputKind`. */
type StaffingProfileEntry = {
  outputKind: string;
  assigneeAgentId: string | null;
  include: boolean | null;
};

type StaffingProfile = {
  id: string;
  name: string;
  entries: StaffingProfileEntry[];
};

const staffingProfileSelect = {
  id: true,
  name: true,
  entries: { select: { outputKind: true, assigneeAgentId: true, include: true } },
} as const;

/**
 * Reads the staffing profile a chain is staffed from.
 *
 * The read happens inside the Serializable callback, after the template row
 * mutex is held, so the profile a chain is staffed from is the one that
 * belonged to the graph this chain snapshots. A template with no default
 * profile answers `null`, which staffs every step from its canonical binding.
 */
const readStaffingProfile = async (
  tx: Prisma.TransactionClient,
  selection: { templateId: string; profileId: string | null; profileName: string | null },
): Promise<StaffingProfile | null> => {
  const byId = selection.profileId === null ? null : await tx.staffingProfile.findFirst({
    where: { id: selection.profileId, taskTemplateId: selection.templateId },
    select: staffingProfileSelect,
  });
  if (selection.profileId !== null && !byId) {
    throw templateRefusal(
      "staffing_profile_not_found",
      `Staffing profile ${selection.profileId} was not found on this template`,
    );
  }
  const byName = selection.profileName === null ? null : await tx.staffingProfile.findFirst({
    where: { taskTemplateId: selection.templateId, name: selection.profileName },
    select: staffingProfileSelect,
  });
  if (selection.profileName !== null && !byName) {
    throw templateRefusal(
      "staffing_profile_not_found",
      `Staffing profile ${JSON.stringify(selection.profileName)} was not found on this template`,
    );
  }
  if (byId && byName && byId.id !== byName.id) {
    throw templateRefusal(
      "staffing_profile_conflicts_with_selection",
      `staffingProfileId ${byId.id} conflicts with the Staffing line naming ${JSON.stringify(byName.name)}`,
    );
  }
  const selected = byId ?? byName;
  if (selected) return selected;
  return tx.staffingProfile.findFirst({
    where: { taskTemplateId: selection.templateId, isDefault: true },
    select: staffingProfileSelect,
  });
};

type OverrideAgent = {
  id: string;
  name: string;
  projectId: string;
  archivedAt: Date | null;
};

/** Which of the three staffing sources decided a step's assignee (R4). */
type AssigneeSource = "override" | "profile" | "canonical";

type EffectiveTemplateStep = {
  step: {
    id: string;
    stepIndex: number;
    name: string;
    assigneeType: AssigneeType;
    assigneeAgentId: string | null;
    assigneeAgent: { id: string; name: string; projectId: string; archivedAt: Date | null } | null;
    prompt: string;
    attachmentsFromPrevious: boolean;
    priorOutputKinds: string[];
    approvalGate: boolean;
    opensPullRequest: boolean;
    layer: number;
    outputKind: string;
    taskTemplate?: { name: string } | null;
  };
  override: StepOverrideInput | undefined;
  assigneeSource: AssigneeSource;
  assigneeAgentId: string | null;
  assigneeAgent: OverrideAgent | EffectiveTemplateStep["step"]["assigneeAgent"];
  approvalGate: boolean;
};

type DispatchPredecessor = {
  id: string;
  projectId: string;
  chainId: string;
  chainIndex: number | null;
  chainLayer: number | null;
  status: TaskStatus;
  archivedAt: Date | null;
  name: string;
};

type DispatchChainRow = {
  id: string;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer: number | null;
  status: TaskStatus;
  archivedAt: Date | null;
  name: string;
};

const templateRefusal = (
  code: TemplateInstantiationRefusalCode,
  message: string,
): TemplateInstantiationRefusal => new TemplateInstantiationRefusal(code, message);

const templateNameLineBreak = /[\r\n\u2028\u2029]/u;

/** Validate and normalize the operator-chosen identity of an instantiated chain. */
export const validateTemplateInstantiationName = (name: string | undefined): string => {
  if (name === undefined || name.trim().length === 0) {
    throw templateRefusal("instantiate_name_required", "Instantiation name is required");
  }
  if (templateNameLineBreak.test(name)) {
    throw templateRefusal("instantiate_name_invalid", "Instantiation name must be one line");
  }
  const trimmed = name.trim();
  if (trimmed.length > 120) {
    throw templateRefusal("instantiate_name_invalid", "Instantiation name must be at most 120 characters");
  }
  return trimmed;
};

/** Generate the explicit chain name used for a trigger-created fire. */
export const triggerInstantiationName = (templateName: string, fireId: string): string => {
  const suffix = `: ${fireId}`;
  const available = Math.max(0, 120 - suffix.length);
  const oneLineTemplateName = templateName.replace(/\s+/gu, " ").trim();
  return `${oneLineTemplateName.slice(0, available).trimEnd()}${suffix}`;
};

/**
 * Read the project defaults while holding the same row mutex used by project
 * PATCH. The delegate guard keeps the small unit-test doubles that predate
 * project defaults useful; every real Prisma transaction has this delegate
 * and therefore takes the lock before any Task can be written.
 */
const readProjectInstantiationDefaults = async (
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<ProjectInstantiationDefaults> => {
  const projectDelegate = (tx as unknown as { project?: unknown }).project;
  if (projectDelegate === undefined) return DEFAULT_PROJECT_INSTANTIATION_DEFAULTS;
  const project = await lockProjectGateDefaults(tx, projectId);
  if (!project) throw templateRefusal("template_not_found", "Project not found");
  return project;
};

const executionLayer = (task: { chainLayer: number | null; chainIndex: number | null }): number | null => layerOf({
  layer: task.chainLayer,
  index: task.chainIndex,
});

const retryableTemplateUniqueConflict = (error: unknown): boolean => (
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
);

/** Substitute {{name}} placeholders, leaving an unknown name in place so it stays visible. */
export const interpolate = (source: string, variables: Record<string, string>): string => source.replace(
  /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
  (_match, name: string) => variables[name] ?? `{{${name}}}`,
);

export const composeTemplateTaskDescription = (input: {
  prompt: string;
  featureBrief?: string | undefined;
  priorOutputKinds: readonly string[];
  outputKind: string;
}): string => composeBrief({
  prompt: input.prompt,
  brief: input.featureBrief,
  attachmentsFromPrevious: input.priorOutputKinds.length > 0,
  outputKind: input.outputKind,
});

export const isUsableTemplateVariable = (value: string | undefined): value is string => (
  value !== undefined && value.trim().length > 0
);

const assertValidBaseReferences = (
  steps: Array<{ name: string; stepIndex: number; baseFromStepIndex: number | null }>,
): void => {
  const indexes = new Set(steps.map((step) => step.stepIndex));
  for (const step of steps) {
    if (step.baseFromStepIndex == null) continue;
    if (!indexes.has(step.baseFromStepIndex)) {
      throw templateRefusal(
        "template_base_reference_missing",
        `Template step ${step.name} baseFromStepIndex ${step.baseFromStepIndex} does not reference the same template`,
      );
    }
    if (step.baseFromStepIndex >= step.stepIndex) {
      throw templateRefusal(
        "template_base_reference_not_earlier",
        `Template step ${step.name} baseFromStepIndex must reference a strictly earlier stepIndex`,
      );
    }
  }
};

export const instantiateTemplate = async (
  db: PrismaClient,
  projectId: string,
  templateId: string,
  input: InstantiateTemplateInput,
  options: {
    actorType?: string;
    activityMetadata?: Record<string, unknown>;
    /** Provenance stamped on every task of the chain. */
    source?: TaskSource;
    /** When set, one ledger row is written inside the same transaction, so a
     *  fire that never produced a chain never produced a fire either. */
    fire?: { id: string; source: TriggerFireSource; dedupeKey?: string | null };
  } = {},
) => {
  const chainName = validateTemplateInstantiationName(input.name);
  if (input.afterTaskId && input.autoStart) {
    throw templateRefusal(
      "dispatch_conflicts_with_auto_start",
      `afterTaskId ${input.afterTaskId} cannot be combined with autoStart=true; a bound chain waits for its predecessor`,
    );
  }
  const requestedStepOverrides: Record<string, StepOverrideInput> = {
    ...(input.stepOverrides ?? {}),
  };
  const overrideEntries = Object.entries(requestedStepOverrides);
  if (overrideEntries.length > 64) {
    throw templateRefusal(
      "step_override_too_many",
      `stepOverrides contains ${overrideEntries.length} entries; at most 64 step overrides are allowed`,
    );
  }
  for (const [stepIndex] of overrideEntries) {
    if (!stepOverrideKey.test(stepIndex)) {
      throw templateRefusal(
        "step_override_invalid_key",
        `Step override key ${stepIndex} must be a positive decimal step index without leading zeros`,
      );
    }
  }
  // Route identity is deliberately discovered once, outside the retrying
  // Serializable callback. If a concurrent rename aborts an Agent-row lock,
  // the retry must keep locking this id so it can report the requested name
  // changed instead of re-resolving the old name as missing.
  const requestedImplementationRoute = parseImplementationRoute(input.description);
  const initiallyResolvedRouteAgent = requestedImplementationRoute === null
    ? null
    : await db.agent.findFirst({
      where: { projectId, name: requestedImplementationRoute },
      select: { id: true, name: true, projectId: true, archivedAt: true },
    });
  return await serializable(db, async (tx) => {
    // The template row is the shared mutex with structure replacement. No
    // graph row or graph-dependent decision may be trusted until this lock
    // is held; a replace that wins the race is therefore read as a whole.
    const lockedTemplate = await lockTemplateRow(tx, templateId);
    if (!lockedTemplate || lockedTemplate.projectId !== projectId) {
      throw templateRefusal("template_not_found", "Template not found in project");
    }
    const template = await tx.taskTemplate.findFirst({
      where: { id: templateId, projectId },
      include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
    });
    if (!template) throw templateRefusal("template_not_found", "Template not found in project");
    if (template.steps.length === 0) throw templateRefusal("template_has_no_steps", "Template has no steps");
    const projectInstantiationDefaults = await readProjectInstantiationDefaults(tx, projectId);
    const slots = new Set(template.steps.map((step) => gateSlotOf(step)).filter((slot) => slot !== null));
    // Check the slots in a fixed order. In particular, a request that names
    // both absent slots must report the specification slot first and must
    // finish before any materialisation write can occur.
    if (input.gates && Object.prototype.hasOwnProperty.call(input.gates, "spec") && !slots.has("spec")) {
      throw templateRefusal(
        "gates_spec_step_absent",
        `Cannot supply gates.spec: specification slot is absent from template ${template.name}`,
      );
    }
    if (input.gates && Object.prototype.hasOwnProperty.call(input.gates, "merge") && !slots.has("merge")) {
      throw templateRefusal(
        "gates_merge_step_absent",
        `Cannot supply gates.merge: merge readiness slot is absent from template ${template.name}`,
      );
    }
    const repo = await tx.repo.findFirst({ where: { id: input.repoId, projectId } });
    if (!repo) throw templateRefusal("repo_not_found", "Repo not found in project");
    const consumesImplementationRoute = template.name === DIRECT_TEMPLATE_NAME;
    if (consumesImplementationRoute) {
      const malformedRouteLine = findMalformedRouteLine(input.description);
      if (malformedRouteLine !== null) {
        throw templateRefusal(
          "implementation_route_malformed",
          `Malformed Route line ${JSON.stringify(malformedRouteLine)}; expected "Route: implementation=<agent> - <reason>"`,
        );
      }
    }
    if (!consumesImplementationRoute && requestedImplementationRoute !== null) {
      throw templateRefusal(
        "implementation_route_template_unsupported",
        `Implementation routing is not supported by template ${template.name}; remove the Route line from the description or use stepOverrides`,
      );
    }
    const implementationRoute = requestedImplementationRoute;
    const missing = template.variables.filter((variable) => !isUsableTemplateVariable(input.variables[variable]));
    const unknown = Object.keys(input.variables).filter((variable) => !template.variables.includes(variable));
    if (missing.length > 0) {
      throw templateRefusal("template_variables_missing", `Missing template variables: ${missing.join(", ")}`);
    }
    if (unknown.length > 0) {
      throw templateRefusal("template_variables_unknown", `Unknown template variables: ${unknown.join(", ")}`);
    }
    if (input.variables.branchName !== undefined && !isValidBranchName(input.variables.branchName)) {
      throw templateRefusal("template_branch_invalid", "Invalid template branch name");
    }
    assertValidBaseReferences(template.steps);

    const malformedStaffingLine = findMalformedStaffingLine(input.description);
    if (malformedStaffingLine !== null) {
      throw templateRefusal(
        "staffing_profile_line_malformed",
        `Malformed Staffing line ${JSON.stringify(malformedStaffingLine)}; expected "Staffing: <profile name>"`,
      );
    }
    const staffingProfile = await readStaffingProfile(tx, {
      templateId: template.id,
      profileId: input.staffingProfileId ?? null,
      profileName: parseStaffingProfileName(input.description),
    });
    // R2: entries key on the exact outputKind; a normalised kind is only a
    // rollover fallback and never a lookup key here.
    const staffingEntryOf = (outputKind: string): StaffingProfileEntry | undefined => (
      staffingProfile?.entries.find((entry) => entry.outputKind === outputKind)
    );

    const instantiation = templateStepInstantiation(template.steps, {
      routesImplementation: consumesImplementationRoute,
      boundToPredecessor: Boolean(input.afterTaskId),
      // R4 for inclusion: explicit override, then the selected profile, then
      // the template's own declaration that the step exists.
      includesOptionalStep: (step) => {
        const override = requestedStepOverrides[String(step.stepIndex)];
        if (override?.include !== undefined) return override.include;
        return staffingEntryOf(step.outputKind)?.include ?? true;
      },
    });
    const instantiatedTemplateSteps = instantiation.instantiated;
    if (instantiatedTemplateSteps.length === 0) {
      throw templateRefusal("template_has_no_instantiable_steps", "Template has no instantiable steps");
    }

    let effectiveStepOverrides: Record<string, StepOverrideInput> = {
      ...requestedStepOverrides,
    };
    let routedImplementationStepIndex: number | null = null;
    if (implementationRoute !== null) {
      const implementationStep = template.steps.find((step) => isDirectImplementationStep({
        outputKind: step.outputKind,
        taskTemplate: { name: template.name },
      }));
      if (implementationStep) {
        const stepKey = String(implementationStep.stepIndex);
        // R4: the Route line conflicts with an explicit assignee override for
        // that step and with nothing else. An include-only override decides a
        // different question, and the selected profile always loses to it.
        if (effectiveStepOverrides[stepKey]?.assigneeAgentId !== undefined) {
          throw templateRefusal(
            "implementation_route_conflicts_with_step_override",
            `Implementation Route conflicts with explicit stepOverrides entry ${stepKey}`,
          );
        }
        const routeAgent = initiallyResolvedRouteAgent;
        if (!routeAgent) {
          throw templateRefusal(
            "step_override_agent_not_found",
            `Implementation route agent ${implementationRoute} was not found in this project`,
          );
        }
        effectiveStepOverrides = {
          ...effectiveStepOverrides,
          [stepKey]: { ...effectiveStepOverrides[stepKey], assigneeAgentId: routeAgent.id },
        };
        routedImplementationStepIndex = implementationStep.stepIndex;
        if (Object.keys(effectiveStepOverrides).length > 64) {
          throw templateRefusal(
            "step_override_too_many",
            `stepOverrides contains ${Object.keys(effectiveStepOverrides).length} entries; at most 64 step overrides are allowed`,
          );
        }
      }
    }

    const overrideEntries = Object.entries(effectiveStepOverrides);
    const templateStepsByIndex = new Map(template.steps.map((step) => [String(step.stepIndex), step]));
    for (const [stepIndex, override] of overrideEntries) {
      const overriddenStep = templateStepsByIndex.get(stepIndex);
      if (!overriddenStep) {
        throw templateRefusal(
          "step_override_unknown_step",
          `Step override names unknown template step ${stepIndex}`,
        );
      }
      // A step the template requires is always instantiated, so an inclusion
      // decision about it would be quietly discarded.
      if (override.include !== undefined && !overriddenStep.optional) {
        throw templateRefusal(
          "step_override_include_not_optional",
          `Step override ${stepIndex} sets include on ${overriddenStep.name}, which the template does not mark optional`,
        );
      }
    }
    const overrideAgentIds = overrideEntries.flatMap(
      ([, override]) => (override.assigneeAgentId === undefined ? [] : [override.assigneeAgentId]),
    );
    const effectiveSteps = instantiatedTemplateSteps.map((step): EffectiveTemplateStep => {
      const override = effectiveStepOverrides[String(step.stepIndex)];
      // R4: explicit override, then the selected profile, then the canonical
      // binding the template step carries.
      const profileAgentId = staffingEntryOf(step.outputKind)?.assigneeAgentId ?? null;
      const assigneeSource: AssigneeSource = override?.assigneeAgentId !== undefined
        ? "override"
        : profileAgentId !== null ? "profile" : "canonical";
      return {
        step,
        override,
        assigneeSource,
        assigneeAgentId: override?.assigneeAgentId ?? profileAgentId ?? step.assigneeAgentId,
        // The relation on the graph read is intentionally not trusted for
        // assignment decisions. It is replaced with the Agent-row-locked
        // value below before any Task is written.
        assigneeAgent: null,
        approvalGate: resolvedApprovalGate(step, input.gates, projectInstantiationDefaults),
      };
    });
    const chainId = randomUUID();
    const branchName = input.variables.branchName ?? `agentos/${chainId}`;
    let predecessor: DispatchPredecessor | null = null;
    if (input.afterTaskId) {
      // The first read only discovers the chain mutex to take. No
      // predecessor state is trusted until the full chain is locked and
      // re-read below. A missing or non-chain task has no chain mutex to
      // take and is refused directly.
      const predecessorIdentity = await tx.task.findFirst({
        where: { id: input.afterTaskId, projectId },
        select: { id: true, chainId: true },
      });
      if (!predecessorIdentity) {
        throw templateRefusal(
          "after_task_not_found",
          `Predecessor task ${input.afterTaskId} was not found in this project`,
        );
      }
      if (!predecessorIdentity.chainId) {
        throw templateRefusal(
          "after_task_not_chained",
          `Predecessor task ${input.afterTaskId} is not a chained task`,
        );
      }
      await lockChainRows(tx, { projectId, chainId: predecessorIdentity.chainId });
      const chainRows: DispatchChainRow[] = await tx.task.findMany({
        where: { projectId, chainId: predecessorIdentity.chainId },
        select: {
          id: true,
          chainId: true,
          chainIndex: true,
          chainLayer: true,
          status: true,
          archivedAt: true,
          name: true,
        },
      });
      const lockedPredecessor = chainRows.find((row) => row.id === input.afterTaskId);
      if (!lockedPredecessor || !lockedPredecessor.chainId) {
        throw templateRefusal(
          "after_task_not_found",
          `Predecessor task ${input.afterTaskId} was not found in this project`,
        );
      }
      if (lockedPredecessor.archivedAt) {
        throw templateRefusal(
          "after_task_archived",
          `Predecessor task ${lockedPredecessor.name} (${lockedPredecessor.id}) is archived`,
        );
      }
      if (lockedPredecessor.status === TaskStatus.DONE) {
        throw templateRefusal(
          "after_task_already_done",
          `Predecessor task ${lockedPredecessor.name} (${lockedPredecessor.id}) is already DONE`,
        );
      }
      const layers = chainRows
        .map(executionLayer)
        .filter((layer): layer is number => layer !== null);
      const terminalLayer = layers.length > 0 ? Math.max(...layers) : null;
      const predecessorLayer = executionLayer(lockedPredecessor);
      const terminalRows = terminalLayer === null
        ? []
        : chainRows.filter((row) => executionLayer(row) === terminalLayer);
      if (predecessorLayer === null || terminalRows.length !== 1 || terminalRows[0]!.id !== lockedPredecessor.id) {
        throw templateRefusal(
          "after_task_not_terminal",
          `Predecessor task ${lockedPredecessor.name} (${lockedPredecessor.id}) is not the sole terminal task of its chain`,
        );
      }
      predecessor = {
        ...lockedPredecessor,
        projectId,
        chainId: lockedPredecessor.chainId,
      };
    }
    // Re-read every assignee under the shared Agent-row mutex before the
    // first task exists: instantiation writes a whole chain plus its first
    // run, and an archive committing between the check and the write would
    // leave every step of that chain pointed at an agent no runner will
    // ever claim for. The name is equally authoritative here: a rename can
    // change whether the assignee is a mechanical integrator or the pinned
    // compound implementation agent. One id-ordered statement, so two
    // instantiations sharing agents cannot deadlock.
    const canonicalAgentIds = effectiveSteps.flatMap((effective) => (
      effective.step.assigneeAgentId ? [effective.step.assigneeAgentId] : []
    ));
    // Profile bindings take the same mutex as canonical and overridden
    // ones: a profile agent archived between the profile read and the
    // Task inserts must be refused, not written.
    const profileAgentIds = (staffingProfile?.entries ?? []).flatMap(
      (entry) => (entry.assigneeAgentId === null ? [] : [entry.assigneeAgentId]),
    );
    const lockedAgents = await lockAgentRows(
      tx,
      [...new Set([...canonicalAgentIds, ...overrideAgentIds, ...profileAgentIds])].sort(),
    );
    for (const effective of effectiveSteps) {
      const { step, override, assigneeAgentId, assigneeSource } = effective;
      const overridesAssignee = assigneeSource === "override";
      const fromProfile = assigneeSource === "profile";
      const lockedAgent = assigneeAgentId ? lockedAgents.get(assigneeAgentId) : undefined;
      const assigneeAgent = lockedAgent && assigneeAgentId && lockedAgent.projectId === projectId
        ? { id: assigneeAgentId, ...lockedAgent }
        : null;
      effective.assigneeAgent = assigneeAgent;
      if (override?.assigneeAgentId !== undefined && step.assigneeType !== AssigneeType.AGENT) {
        throw templateRefusal(
          "step_override_step_not_agent",
          `Step override ${step.stepIndex} targets ${step.name}, whose assigneeType is ${step.assigneeType}; only AGENT steps may be overridden`,
        );
      }
      if (fromProfile && step.assigneeType !== AssigneeType.AGENT) {
        throw templateRefusal(
          "staffing_profile_step_not_agent",
          `Staffing profile ${staffingProfile?.name} binds ${step.name}, whose assigneeType is ${step.assigneeType}; only AGENT steps may be staffed`,
        );
      }
      if (overridesAssignee && !assigneeAgent) {
        throw templateRefusal(
          "step_override_agent_not_found",
          `Override agent ${override?.assigneeAgentId} for step ${step.stepIndex} was not found in this project`,
        );
      }
      if (fromProfile && !assigneeAgent) {
        // The two failures are distinguishable under the lock and mean
        // different repairs: delete the entry, or re-point it in project.
        if (lockedAgent) {
          throw templateRefusal(
            "staffing_profile_agent_foreign",
            `Staffing profile ${staffingProfile?.name} binds step ${step.stepIndex} to agent ${assigneeAgentId}, which belongs to another project`,
          );
        }
        throw templateRefusal(
          "staffing_profile_agent_not_found",
          `Staffing profile ${staffingProfile?.name} binds step ${step.stepIndex} to agent ${assigneeAgentId}, which was not found`,
        );
      }
      if (step.assigneeType === AssigneeType.AGENT && !assigneeAgent) {
        throw templateRefusal("template_step_agent_missing", `Template step ${step.name} has no agent`);
      }
      // §D-P4, before any task row exists. A doctored template — the
      // sentinel on an ordinary step, or a model agent on the integrator
      // step — fails rather than materializing a chain that would later
      // claim as the wrong execution mode.
      const bindingRefusal = canonicalIntegratorBindingRefusal(assigneeAgent?.name ?? null, {
        stepIndex: step.stepIndex,
        outputKind: step.outputKind,
        taskTemplateName: template.name,
      });
      if (bindingRefusal) {
        if (overridesAssignee) throw templateRefusal("step_override_integrator_binding", `Template step ${step.name}: ${bindingRefusal}`);
        if (fromProfile) {
          throw templateRefusal(
            "staffing_profile_integrator_binding",
            `Staffing profile ${staffingProfile?.name}, template step ${step.name}: ${bindingRefusal}`,
          );
        }
        throw templateRefusal(
          "template_integrator_binding_invalid",
          `Template step ${step.name}: ${bindingRefusal}`,
        );
      }
      if (assigneeAgent?.archivedAt) {
        if (overridesAssignee) {
          throw templateRefusal(
            "step_override_agent_archived",
            `Override agent ${assigneeAgent.name} (${assigneeAgent.id}) for step ${step.stepIndex} is archived`,
          );
        }
        if (fromProfile) {
          throw templateRefusal(
            "staffing_profile_agent_archived",
            `Staffing profile ${staffingProfile?.name} agent ${assigneeAgent.name} (${assigneeAgent.id}) for step ${step.stepIndex} is archived`,
          );
        }
        throw templateRefusal(
          "template_step_agent_archived",
          `Template step ${step.name} agent ${assigneeAgent.name} is archived`,
        );
      }
      if (implementationRoute !== null
        && step.stepIndex === routedImplementationStepIndex
        && assigneeAgent?.name !== implementationRoute) {
        throw templateRefusal(
          "implementation_route_agent_renamed",
          `Implementation route agent ${implementationRoute} changed identity before the chain was created`,
        );
      }
      if (assigneeAgent && !compoundImplementationAssigneeValid(
        projectId,
        step.assigneeType,
        assigneeAgent,
        { stepIndex: step.stepIndex, outputKind: step.outputKind, taskTemplate: { name: template.name } },
      )) {
        const message = `${COMPOUND_IMPLEMENTATION_ASSIGNEE_MESSAGE} (step ${step.stepIndex})`;
        if (overridesAssignee) throw templateRefusal("step_override_compound_implementation", message);
        if (fromProfile) {
          throw templateRefusal(
            "staffing_profile_compound_implementation",
            `Staffing profile ${staffingProfile?.name}: ${message}`,
          );
        }
        throw templateRefusal("template_compound_implementation_assignee_invalid", message);
      }
    }
    const grantedAgentIds = [...new Set(effectiveSteps.flatMap((effective) => (
      effective.assigneeAgentId ? [effective.assigneeAgentId] : []
    )))].sort();
    for (const agentId of grantedAgentIds) {
      const granted = await lockAgentRepoGrant(tx, { projectId, agentId, repoId: repo.id });
      if (!granted) {
        const effective = effectiveSteps.find((candidate) => candidate.assigneeAgentId === agentId);
        const agentName = effective?.assigneeAgent?.name ?? agentId;
        if (effective?.assigneeSource === "override") {
          throw templateRefusal(
            "step_override_missing_repo_grant",
            `Override agent ${agentName} (${agentId}) for step ${effective.step.stepIndex} has no grant for Repo ${repo.name}`,
          );
        }
        if (effective?.assigneeSource === "profile") {
          throw templateRefusal(
            "staffing_profile_missing_repo_grant",
            `Staffing profile ${staffingProfile?.name} agent ${agentName} (${agentId}) for step ${effective.step.stepIndex} has no grant for Repo ${repo.name}`,
          );
        }
        throw templateRefusal(
          "template_agent_repo_grant_missing",
          `Agent ${agentName} has no grant for Repo ${repo.name}`,
        );
      }
    }
    const firstEffectiveStep = effectiveSteps[0]!;
    if (firstEffectiveStep.step.assigneeType !== AssigneeType.AGENT) {
      throw templateRefusal("template_first_step_not_agent", "The first template step must be agent-executable");
    }
    const tasks = [];
    const promptVariables = { ...input.variables, chainId };
    for (const [index, effective] of effectiveSteps.entries()) {
      const { step } = effective;
      const conditionalOrdinalOffset = instantiation.omittedConditionalRevalidation ? 1 : 0;
      const context = composeTemplateTaskDescription({
        prompt: interpolate(step.prompt, promptVariables),
        featureBrief: input.description,
        priorOutputKinds: step.priorOutputKinds,
        outputKind: step.outputKind,
      });
      tasks.push(await tx.task.create({ data: {
        projectId,
        repoId: repo.id,
        templateId: template.id,
        templateStepId: step.id,
        name: `${chainName}: ${step.name}`,
        description: context,
        assigneeType: step.assigneeType,
        assigneeAgentId: effective.assigneeAgentId,
        approvalGate: effective.approvalGate,
        opensPullRequest: step.opensPullRequest,
        chainId,
        chainIndex: step.stepIndex - conditionalOrdinalOffset,
        chainLayer: step.layer - conditionalOrdinalOffset,
        status: TaskStatus.TODO,
        source: options.source ?? TaskSource.MANUAL,
        targetBranch: index === 0 ? repo.defaultBranch : branchName,
        ...(index === 0 && input.afterTaskId ? { dispatchAfterTaskId: input.afterTaskId } : {}),
      } }));
    }
    const first = tasks[0]!;
    if (input.autoStart ?? false) {
      await enqueueTaskRun(tx, first.id);
    }
    await tx.taskActivity.createMany({ data: tasks.map((task, index) => ({
      taskId: task.id,
      actorType: options.actorType ?? "control-plane",
      body: index === 0
        ? predecessor
          ? `Template instantiated; waiting for predecessor ${predecessor.name}`
          : (input.autoStart ?? false) ? "Template instantiated; first step queued" : "Template instantiated; ready to start"
        : "Template instantiated; waiting for predecessor",
      metadata: {
        chainId,
        templateId: template.id,
        // The chain root carries the staffing provenance: the profile is
        // read once and snapshotted into the tasks, so this is the only
        // record of which profile produced these assignees.
        ...(index === 0 && staffingProfile ? {
          staffingProfileId: staffingProfile.id,
          staffingProfileName: staffingProfile.name,
        } : {}),
        ...(predecessor ? {
          afterTaskId: predecessor.id,
          dispatchAfterTaskId: predecessor.id,
          predecessorTaskId: predecessor.id,
          predecessorChainId: predecessor.chainId,
        } : {}),
        ...options.activityMetadata,
        ...(effectiveSteps[index]?.step.outputKind === "implementation"
          && requestedStepOverrides[String(effectiveSteps[index]?.step.stepIndex)]?.assigneeAgentId !== undefined
          ? { implementationAssigneeOverride: "stepOverrides" } : {}),
      },
    })) });
    if (predecessor) {
      await tx.taskActivity.create({ data: {
        taskId: predecessor.id,
        actorType: options.actorType ?? "control-plane",
        body: `Chain ${chainId} bound to predecessor ${predecessor.name}`,
        metadata: {
          chainId,
          templateId: template.id,
          afterTaskId: predecessor.id,
          dispatchAfterTaskId: predecessor.id,
          predecessorTaskId: predecessor.id,
          predecessorChainId: predecessor.chainId,
          successorChainId: chainId,
          ...options.activityMetadata,
        },
      } });
    }
    const fire = options.fire
      ? await tx.triggerFire.create({ data: {
        id: options.fire.id,
        templateId: template.id,
        chainId,
        source: options.fire.source,
        dedupeKey: options.fire.dedupeKey ?? null,
      } })
      : null;
    return { chainId, branchName, tasks, fireId: fire?.id ?? null };
  }, {
    // Six simultaneous webhook fires can form a longer serialization queue
    // than five attempts, even with per-attempt jitter. Twelve bounded tries
    // make the accepted burst deterministic while still surfacing persistent
    // conflicts instead of looping forever.
    attempts: 12,
    alsoRetry: retryableTemplateUniqueConflict,
  });
};
