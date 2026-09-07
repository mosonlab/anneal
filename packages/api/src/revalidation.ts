import {
  canonicalTemplateIdentity,
  DIRECT_TEMPLATE_NAME,
  lockChainRows,
  lockRunRow,
  InboxStatus,
  Prisma,
  TaskStatus,
  type PrismaClient,
} from "@anneal/db";
import { layerOf } from "@anneal/db/chain-order";

import {
  fenceRefusalResponse,
  fencedRunWhere,
  type FenceRefusalResponse,
  type RunFence,
  withFencedRun,
} from "./run-fence.js";
import { type Refusal } from "./refusal.js";
import { legacyBriefMigration, readBrief, rewriteBrief } from "./task-brief.js";

/**
 * The one canonical Step the revalidation capability belongs to.
 *
 * Keyed on the template step, never on the Agent bound to it: a staffing
 * profile may bind any Agent to any step, so an Agent name is no longer an
 * identity the platform can gate a capability on. What makes this capability
 * safe is the step — its canonical template, its position and its output kind —
 * and that is exactly what a profile cannot move.
 */
export const isRevalidationStep = (templateStep: {
  stepIndex: number;
  outputKind: string;
  taskTemplate: { name: string };
} | null | undefined): boolean => templateStep?.outputKind === "revalidation"
  && templateStep.stepIndex === 1
  && canonicalTemplateIdentity(templateStep.taskTemplate.name)?.canonicalName === DIRECT_TEMPLATE_NAME;

const revalidationTaskSelect = {
  id: true,
  projectId: true,
  chainId: true,
  chainIndex: true,
  chainLayer: true,
  dispatchAfterTaskId: true,
  description: true,
  name: true,
  status: true,
  assigneeAgentId: true,
  templateId: true,
  templateStepId: true,
  templateStep: {
    select: {
      stepIndex: true,
      outputKind: true,
      priorOutputKinds: true,
      taskTemplate: { select: { name: true } },
    },
  },
} as const satisfies Prisma.TaskSelect;

export type RevalidationTask = Prisma.TaskGetPayload<{ select: typeof revalidationTaskSelect }>;

type RevalidationCaller = RevalidationTask & { agentId: string };

export type BoundImplementationTask = Pick<
  RevalidationTask,
  "id" | "name" | "description" | "status" | "chainIndex" | "chainLayer"
>;

export type RevalidationResult = { task: RevalidationTask } | Refusal | FenceRefusalResponse;

export type RevalidationCancellation = {
  cancelRequested: true;
  requestId: string;
  reason: string;
} | Refusal | FenceRefusalResponse;

const executionLayer = (task: { chainLayer: number | null; chainIndex: number | null }): number | null => layerOf({
  layer: task.chainLayer,
  index: task.chainIndex,
});

const callerRefusal = (message: string): Refusal => ({ reason: "forbidden", message });

const boundTaskRefusal = (message: string): Refusal => ({ reason: "conflict", message });

/**
 * Derive the one implementation task a bound revalidation step may address.
 *
 * The caller's chain identity comes from the locked Run/Task rows. The client
 * supplies neither a target task id nor a chain id, so a session token cannot
 * turn this capability into an arbitrary task patch or cancellation endpoint.
 */
export const deriveBoundImplementationTask = (
  caller: RevalidationCaller,
  chainRows: readonly RevalidationTask[],
): BoundImplementationTask | Refusal => {
  if (caller.assigneeAgentId !== caller.agentId) {
    return callerRefusal("Revalidation Run is not assigned to its own task's Agent");
  }
  if (!isRevalidationStep(caller.templateStep)) {
    return callerRefusal("Revalidation capability belongs only to the canonical direct-engineer-workflow revalidation step");
  }
  if (caller.chainId === null || caller.chainIndex === null || caller.dispatchAfterTaskId === null) {
    return boundTaskRefusal("Revalidation is available only for a bound direct chain");
  }
  const candidates = chainRows.filter((task) => task.templateStep?.outputKind === "implementation");
  if (candidates.length !== 1) {
    return boundTaskRefusal(`Expected exactly one same-chain implementation task; found ${candidates.length}`);
  }
  const implementation = candidates[0]!;
  if (implementation.templateId !== caller.templateId
    || canonicalTemplateIdentity(implementation.templateStep?.taskTemplate.name ?? "")?.canonicalName !== DIRECT_TEMPLATE_NAME) {
    return boundTaskRefusal("The downstream implementation task does not share the canonical direct template");
  }
  const callerLayer = executionLayer(caller);
  const implementationLayer = executionLayer(implementation);
  if (implementation.id === caller.id || callerLayer === null || implementationLayer === null
    || implementationLayer <= callerLayer) {
    return boundTaskRefusal("The same-chain implementation task is not downstream of revalidation");
  }
  return implementation;
};

const revalidationActivity = (input: {
  taskId: string;
  agentId: string;
  body: string;
  metadata?: Record<string, string | number | boolean | null>;
}): Prisma.TaskActivityUncheckedCreateInput => ({
  taskId: input.taskId,
  actorType: "agent",
  actorId: input.agentId,
  body: input.body,
  ...(input.metadata ? { metadata: input.metadata } : {}),
});

type BriefSectionName = "Background" | "Changes" | "Out of scope" | "Constraints" | "Acceptance" | "Route";

type ParsedProductBrief = {
  goal: string;
  sections: Map<BriefSectionName, string>;
  order: BriefSectionName[];
};

const productBriefSection = /^(Background|Changes|Out of scope|Constraints|Acceptance|Route):/gmu;

const parseProductBrief = (brief: string): ParsedProductBrief | null => {
  const matches = [...brief.matchAll(productBriefSection)];
  const background = matches.find((match) => match[1] === "Background");
  const changes = matches.find((match) => match[1] === "Changes");
  const outOfScope = matches.find((match) => match[1] === "Out of scope");
  const acceptance = matches.find((match) => match[1] === "Acceptance");
  if (!background || !changes || !outOfScope || !acceptance) return null;
  const sections = new Map<BriefSectionName, string>();
  for (const [index, match] of matches.entries()) {
    const name = match[1] as BriefSectionName;
    if (sections.has(name) || match.index === undefined) return null;
    const end = matches[index + 1]?.index ?? brief.length;
    sections.set(name, brief.slice(match.index, end));
  }
  return {
    goal: brief.slice(0, background.index),
    sections,
    order: matches.map((match) => match[1] as BriefSectionName),
  };
};

const descriptiveReference = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.\/-]+|\/[A-Za-z0-9_.\/-]+|\b(?:GET|POST|PUT|PATCH|DELETE)\b|\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b|\b[A-Za-z]+[A-Z][A-Za-z0-9]*\b/gu;

const changesIntentSignature = (section: string): string => section.replace(descriptiveReference, "<reference>");

/** Enforce the immutable Product Contract boundary on a proposed brief. */
export const validateRevalidatedBrief = (stored: string, proposed: string): Refusal | null => {
  const before = parseProductBrief(stored);
  const after = parseProductBrief(proposed);
  if (!before || !after) {
    return { reason: "invalid-request", message: "Revalidation brief must retain the canonical Product Contract sections" };
  }
  if (before.goal !== after.goal) {
    return { reason: "invalid-request", message: "Revalidation cannot change Goal" };
  }
  if (before.order.join("\0") !== after.order.join("\0")) {
    return { reason: "invalid-request", message: "Revalidation cannot add, remove, or reorder Product Contract sections" };
  }
  for (const name of ["Out of scope", "Constraints", "Acceptance", "Route"] as const) {
    if (before.sections.get(name) !== after.sections.get(name)) {
      return { reason: "invalid-request", message: `Revalidation cannot change ${name}` };
    }
  }
  if (changesIntentSignature(before.sections.get("Changes")!)
    !== changesIntentSignature(after.sections.get("Changes")!)) {
    return { reason: "invalid-request", message: "Revalidation cannot change the intent of a Changes item" };
  }
  return null;
};

const loadChainRows = async (
  tx: Prisma.TransactionClient,
  caller: RevalidationTask,
): Promise<RevalidationTask[]> => tx.task.findMany({
  where: { projectId: caller.projectId, chainId: caller.chainId! },
  orderBy: [{ chainLayer: "asc" }, { chainIndex: "asc" }, { id: "asc" }],
  select: revalidationTaskSelect,
});

const callerSelect = {
  id: true,
  agentId: true,
  leaseGeneration: true,
  task: { select: revalidationTaskSelect },
} as const satisfies Prisma.RunSelect;

type RevalidationRun = Prisma.RunGetPayload<{ select: typeof callerSelect }>;

const callerFromRun = (run: RevalidationRun): RevalidationCaller | Refusal => {
  if (!run.task) return { reason: "conflict", message: "Revalidation Run has no task" };
  return { ...run.task, agentId: run.agentId };
};

const sessionGenerationRefusal = (
  run: RevalidationRun,
  expectedLeaseGeneration: number | undefined,
): FenceRefusalResponse | null => (
  expectedLeaseGeneration === undefined || run.leaseGeneration === expectedLeaseGeneration
    ? null
    : fenceRefusalResponse("stale-fence")
);

const failureActivity = async (
  tx: Prisma.TransactionClient,
  caller: RevalidationCaller,
  fence: RunFence,
  result: Refusal,
): Promise<Refusal> => {
  await tx.taskActivity.create({
    data: revalidationActivity({
      taskId: caller.id,
      agentId: caller.agentId,
      body: `Revalidation failed: ${result.message}`,
      metadata: { kind: "revalidation-failure", runId: fence.runId, reason: result.reason },
    }),
  });
  return result;
};

type LockedRevalidationTarget = {
  caller: RevalidationCaller;
  rows: RevalidationTask[];
  target: BoundImplementationTask;
};

const lockedRevalidationTarget = async (
  tx: Prisma.TransactionClient,
  run: RevalidationRun,
  caller: RevalidationCaller,
  fence: RunFence,
): Promise<LockedRevalidationTarget | Refusal> => {
  if (caller.chainId === null) {
    return failureActivity(tx, caller, fence, boundTaskRefusal("Revalidation is not part of a chain"));
  }
  await lockChainRows(tx, { projectId: caller.projectId, chainId: caller.chainId });
  const currentCaller = await tx.task.findUnique({ where: { id: caller.id }, select: revalidationTaskSelect });
  if (!currentCaller) {
    return failureActivity(tx, caller, fence, { reason: "not-found", message: "Revalidation task not found" });
  }
  const lockedCaller = { ...currentCaller, agentId: run.agentId };
  const rows = await loadChainRows(tx, currentCaller);
  const target = deriveBoundImplementationTask(lockedCaller, rows);
  if ("message" in target) return failureActivity(tx, lockedCaller, fence, target);
  return { caller: lockedCaller, rows, target };
};

/**
 * Patch the derived implementation brief under the complete Run fence.
 *
 * `rewriteBrief` preserves the platform-owned prompt and output suffix, while
 * validateRevalidatedBrief enforces the Product Contract's immutable bars.
 */
export const patchBoundImplementationDescription = async (
  db: PrismaClient,
  fence: RunFence,
  description: string,
  expectedLeaseGeneration?: number,
): Promise<RevalidationResult> => {
  try {
    return await db.$transaction((tx) => withFencedRun(tx, fence, callerSelect, async (run) => {
      const generationRefusal = sessionGenerationRefusal(run, expectedLeaseGeneration);
      if (generationRefusal) return generationRefusal;
      const caller = callerFromRun(run);
      if ("message" in caller) return caller;

      // The chain lock is acquired after withFencedRun's Run -> source Task
      // order, matching completion and every other chained-task writer.
      const locked = await lockedRevalidationTarget(tx, run, caller, fence);
      if ("message" in locked) return locked;
      const targetRow = locked.rows.find((row) => row.id === locked.target.id)!;
      const storedBrief = readBrief(targetRow.description, legacyBriefMigration(targetRow.templateStep));
      if ("unparseable" in storedBrief) {
        return failureActivity(tx, locked.caller, fence, {
          reason: "invalid-request",
          message: `Cannot read implementation task brief: ${storedBrief.unparseable}`,
        });
      }
      const boundaryRefusal = validateRevalidatedBrief(storedBrief.brief, description);
      if (boundaryRefusal) return failureActivity(tx, locked.caller, fence, boundaryRefusal);
      const rewritten = rewriteBrief(targetRow.description, description, legacyBriefMigration(targetRow.templateStep));
      if (typeof rewritten !== "string") {
        return failureActivity(tx, locked.caller, fence, {
          reason: "invalid-request",
          message: `Cannot rewrite implementation task brief: ${rewritten.unparseable}`,
        });
      }
      const updated = await tx.task.update({
        where: { id: targetRow.id },
        data: { description: rewritten },
        select: revalidationTaskSelect,
      });
      await tx.taskActivity.create({
        data: revalidationActivity({
          taskId: locked.caller.id,
          agentId: run.agentId,
          body: `Revalidated implementation task ${targetRow.id} description`,
          metadata: { kind: "revalidation", targetTaskId: targetRow.id, runId: fence.runId },
        }),
      });
      return { task: updated };
    }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error: unknown) {
    // Expected refusals are recorded in the fenced transaction above. A
    // database/PATCH failure is still surfaced to the provider, and this
    // best-effort audit keeps its reason visible when the database can accept
    // a separate activity write after the failed transaction rolled back.
    await recordRevalidationFailure(db, fence.runId, error);
    throw error;
  }
};

/** Read the current derived implementation task for task_status after resume. */
export const readBoundImplementationTask = async (
  db: PrismaClient,
  run: RevalidationRun,
): Promise<BoundImplementationTask | Refusal> => {
  const caller = callerFromRun(run);
  if ("message" in caller) return caller;
  if (caller.chainId === null) return boundTaskRefusal("Revalidation is not part of a chain");
  const chainRows = await loadChainRows(db, caller);
  return deriveBoundImplementationTask(caller, chainRows);
};

export const revalidationCancelRequestId = (runId: string): string => `revalidation:${runId}:cancel`;

const premiseCollapseChoices = [
  { id: "cancel-chain", label: "cancel this chain" },
  { id: "operator-rewrite", label: "operator rewrites the brief, then continue" },
  { id: "proceed-reading", label: "proceed with the step's proposed reading" },
] as const;

const hasPremiseCollapseChoices = (value: Prisma.JsonValue): boolean => (
  Array.isArray(value)
  && value.length === premiseCollapseChoices.length
  && premiseCollapseChoices.every((expected, index) => {
    const actual = value[index];
    return typeof actual === "object" && actual !== null && !Array.isArray(actual)
      && actual.id === expected.id && actual.label === expected.label;
  })
);

/**
 * Record cancellation intent for a collapsed premise. Runner heartbeat and
 * cancellation acknowledgement perform provider cleanup and terminalization;
 * this route deliberately does not pretend to be the runner.
 */
export const cancelBoundRevalidationRun = async (
  db: PrismaClient,
  fence: RunFence,
  now = new Date(),
  expectedLeaseGeneration?: number,
): Promise<RevalidationCancellation> => {
  try {
    return await db.$transaction(async (tx) => {
      // Serialize the initial write with response-loss retries. Once the
      // deterministic outcome is committed, replay needs the same fence
      // identity but deliberately does not require the Run to remain active:
      // cancellation itself revokes the token and invalidates the active fence.
      await lockRunRow(tx, fence.runId);
      const requestId = revalidationCancelRequestId(fence.runId);
      const committed = await tx.run.findUnique({
        where: { id: fence.runId },
        select: {
          cancelRequestId: true,
          cancelReason: true,
          cancelRequestedAt: true,
          fencingToken: true,
          leaseGeneration: true,
        },
      });
      if (committed?.cancelRequestId === requestId
        && committed.cancelRequestedAt !== null
        && committed.cancelReason !== null
        && committed.fencingToken === fence.fencingToken
        && (expectedLeaseGeneration === undefined || committed.leaseGeneration === expectedLeaseGeneration)) {
        return { cancelRequested: true as const, requestId, reason: committed.cancelReason };
      }

      return withFencedRun(tx, fence, {
        ...callerSelect,
        status: true,
        cancelRequestId: true,
        session: { select: { id: true } },
      }, async (run) => {
        const generationRefusal = sessionGenerationRefusal(run, expectedLeaseGeneration);
        if (generationRefusal) return generationRefusal;
        const caller = callerFromRun(run);
        if ("message" in caller) return caller;
        const locked = await lockedRevalidationTarget(tx, run, caller, fence);
        if ("message" in locked) return locked;
        const decision = await tx.inboxDecision.findFirst({
          where: { runId: fence.runId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            decision: true,
            inboxMessage: {
              select: { status: true, selectedChoiceId: true, sessionId: true, taskId: true, choices: true },
            },
          },
        });
        if (!decision
          || decision.decision !== "cancel-chain"
          || decision.inboxMessage.status !== InboxStatus.ANSWERED
          || decision.inboxMessage.selectedChoiceId !== "cancel-chain"
          || decision.inboxMessage.sessionId !== run.session?.id
          || decision.inboxMessage.taskId !== locked.caller.id
          || !hasPremiseCollapseChoices(decision.inboxMessage.choices)) {
          return failureActivity(tx, locked.caller, fence, {
            reason: "forbidden",
            message: "Revalidation cancellation requires this Run's answered cancel-chain Inbox decision",
          });
        }
        const reason = "Revalidation premise collapsed; operator selected cancel this chain";
        const requested = await tx.run.updateMany({
          where: {
            ...fencedRunWhere(fence),
            cancelRequestId: null,
            cancelRequestedAt: null,
          },
          data: {
            cancelRequestId: requestId,
            cancelReason: reason,
            cancelRequestedAt: now,
            sessionTokenRevokedAt: now,
          },
        });
        if (requested.count !== 1) {
          return failureActivity(tx, locked.caller, fence, {
            reason: "conflict",
            message: "Run changed while revalidation cancellation was being requested",
          });
        }
        const parked = await tx.task.updateMany({
          where: {
            id: { in: locked.rows.map((row) => row.id) },
            archivedAt: null,
            status: { not: TaskStatus.DONE },
          },
          data: { status: TaskStatus.BACKLOG, failureReason: reason },
        });
        await tx.taskActivity.createMany({
          data: locked.rows.map((row) => ({
            taskId: row.id,
            actorType: "operator",
            body: `Bound chain cancelled: ${reason}`,
            metadata: { kind: "revalidation-cancel", runId: fence.runId, requestId, decisionId: decision.id },
          })),
        });
        await tx.taskActivity.create({
          data: revalidationActivity({
            taskId: locked.caller.id,
            agentId: run.agentId,
            body: "Revalidation cancelled the bound chain after premise collapse",
            metadata: {
              kind: "revalidation-cancel",
              runId: fence.runId,
              requestId,
              decisionId: decision.id,
              targetTaskId: locked.target.id,
              parkedTaskCount: parked.count,
            },
          }),
        });
        return { cancelRequested: true, requestId, reason };
      });
    });
  } catch (error: unknown) {
    await recordRevalidationFailure(db, fence.runId, error);
    throw error;
  }
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Best-effort audit for errors thrown outside the fenced callback. */
export const recordRevalidationFailure = async (
  db: PrismaClient,
  runId: string,
  error: unknown,
): Promise<void> => {
  try {
    const run = await db.run.findUnique({ where: { id: runId }, select: { taskId: true, agentId: true } });
    if (!run?.taskId) return;
    await db.taskActivity.create({
      data: revalidationActivity({
        taskId: run.taskId,
        agentId: run.agentId,
        body: `Revalidation failed: ${errorMessage(error)}`,
        metadata: { kind: "revalidation-failure", runId, reason: "tool-error" },
      }),
    });
  } catch (auditError: unknown) {
    console.error(`Unable to record revalidation failure for ${runId}`, auditError);
  }
};
