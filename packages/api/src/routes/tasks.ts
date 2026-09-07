import {
  ACTIVE_RUN_STATUSES,
  AssigneeType,
  chainControlReadProjection,
  chainRunHistoryRefusal,
  deleteChain,
  enqueueTaskRun,
  gateSlotOf,
  MERGE_INTEGRATOR_KIND,
  holdChain,
  InboxStatus,
  integratorBindingRefusalFor,
  latestTargetCorrection,
  loadIntegratorTask,
  lockAgentRow,
  lockChainRows,
  lockChainStructure,
  mergeRecoveryPhase,
  observedChainPullRequests,
  openRun,
  Prisma,
  projectMergeOutcome,
  requestConfirmationCard,
  resumeChain,
  runOwnsMergeOutcome,
  runSessionUsageCost,
  ScheduleKind,
  stopStateFor,
  sumUsageCosts,
  TaskStatus,
  taskIsIntegratorStep,
  type ChainControlAddress,
  type MergeRecoveryAttempt,
  type PrismaClient,
} from "@anneal/db";
import type {
  Chain as ChainContract,
  ChainStep as ChainStepContract,
  RecurringFire as RecurringFireContract,
  Run as RunContract,
  TaskActivity as TaskActivityContract,
  TaskDetail as TaskDetailContract,
  TaskStartability as TaskStartabilityContract,
  TaskStepOutput as TaskStepOutputContract,
} from "@anneal/db/board-contract";
import type { SerializesTo } from "@anneal/db/wire-serialization";
import { z } from "zod";

import {
  operatorMoveTargets,
  readBoard,
  readChainRepairTaskIds,
  readRepairChainByTask,
  readTaskList,
  serializeUsageCost,
  strandedSalvageBranchesFromRuns,
  type TaskReadScope,
} from "../board.js";
import { chainExecutionOwner } from "../chain-execution-owner.js";
import {
  LATEST_AGENT_MESSAGE_EVENT_LIMIT,
  latestAgentMessageEventTypes,
  projectLatestAgentMessage,
  type LatestAgentMessageEvent,
} from "../latest-agent-message.js";
import { baselineKey, readRunBaselines } from "../run-baseline.js";
import { runMetrics, TOOL_METRIC_EVENT_TYPES, type RunMetricsToolEvent } from "../run-metrics.js";
import { lockDoneTasks, partitionArchivable } from "../task-archive.js";
import { editableBrief } from "../task-brief.js";
import {
  isCanonicalBlindFindingsStep,
  isCanonicalSolFindingsStep,
} from "../canonical-task-output.js";
import {
  chainProgress,
  chainStepAgent,
  chainStepReassignable,
  positions,
  readChainDetail,
  readStepAdmission,
  stepName,
} from "../chain.js";
import { jsonValue } from "../execution.js";
import { refusalFor, type Refusal } from "../refusal.js";
import { activityInput } from "../run-lifecycle.js";
import { OPERATOR_NOTE_METADATA_FIELD } from "../run-claim.js";
import { requestMergeTailRepair } from "../merge-tail-repair-reentry.js";
import { computeNextOccurrence, validateSchedule } from "../scheduler.js";
import { patchTask, taskInput, taskPatch } from "../task-patch.js";
import { isLiveStatus, lockTask, lockTaskMutationRows, reactivationBlocked } from "../task-write.js";
import { readCommitted, serializable } from "../transaction.js";
import { withoutUndefined } from "../without-undefined.js";
import {
  id,
  readJson,
  refusal,
  refusalJson,
  type RouteApp,
  type RouteDeps,
  taskOutputInput,
  validated,
} from "./support.js";

type TaskChainResolution = {
  task: { id: string; projectId: string };
  chain: { projectId: string; chainId: string } | null;
};

/**
 * Resolves both ordinary Chain membership and the detached repair-task binding
 * used by the merge tail. The project predicate is essential: Chain IDs are
 * only unique within a project, and a malformed marker must not cross that
 * boundary.
 */
const resolveTaskChain = async (
  tx: PrismaClient | Prisma.TransactionClient,
  taskId: string,
): Promise<TaskChainResolution | null> => {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, chainId: true },
  });
  if (!task) return null;
  if (task.chainId) {
    return { task, chain: { projectId: task.projectId, chainId: task.chainId } };
  }

  const repairChainId = (await readRepairChainByTask(tx, [task])).get(task.id)?.chainId;
  return {
    task,
    chain: repairChainId
      ? { projectId: task.projectId, chainId: repairChainId }
      : null,
  };
};

const resolveDirectChainAddress = async (
  db: PrismaClient | Prisma.TransactionClient,
  taskId: string,
): Promise<ChainControlAddress | Refusal> => {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { projectId: true, chainId: true },
  });
  if (!task) return refusal("not-found", "Task not found");
  if (!task.chainId) return refusal("conflict", "Task does not belong to a Chain");
  return { projectId: task.projectId, chainId: task.chainId, taskId };
};

class TaskCreateOpenRunRefusal extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
    this.name = "TaskCreateOpenRunRefusal";
  }
}

const mergeRecoveryProjection = (row: MergeRecoveryAttempt | null) => row ? ({
  id: row.id,
  attempt: row.attempt,
  status: row.status,
  phase: mergeRecoveryPhase(row.status),
  sourceStopId: row.sourceStopId,
  boundSourceRunId: row.boundSourceRunId,
  recoveryRunId: row.recoveryRunId,
  failureReason: row.failureReason,
  updatedAt: row.updatedAt,
}) : null;

const mergeTargetInput = z.object({ prNumber: z.number().int().positive() });

const chainHoldInput = z.object({
  requestId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(4_000).nullable().optional(),
}).strict();
const chainResumeInput = z.object({
  requestId: z.string().trim().min(1).max(200),
}).strict();
const mergeTailRepairInput = z.object({
  requestId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(4_000).optional(),
}).strict();

/** Each response names both its native projection and the browser contract that
 * projection must JSON-serialize to, so every `satisfies` below proves the
 * whole wire claim rather than the native half of it. */
type ChainResponse = SerializesTo<ChainContract<Date>, ChainContract>;
type ChainStepResponse = SerializesTo<ChainStepContract<Date>, ChainStepContract>;
type RecurringFireResponse = SerializesTo<RecurringFireContract<Date>, RecurringFireContract>;
type RunResponse = SerializesTo<RunContract<Date, Prisma.Decimal>, RunContract>;
type TaskActivityResponse = SerializesTo<TaskActivityContract<Date>, TaskActivityContract>;
type TaskDetailResponse = SerializesTo<TaskDetailContract<Date, Prisma.Decimal>, TaskDetailContract>;

type TaskStartabilityResponse = SerializesTo<TaskStartabilityContract, TaskStartabilityContract>;
type TaskStepOutputResponse = SerializesTo<TaskStepOutputContract<Date>, TaskStepOutputContract>;

export const registerTasksRoutes = (app: RouteApp, deps: RouteDeps): void => {
  const { db } = deps;

  app.get("/tasks", async (context) => {
    const projectId = context.req.query("projectId");
    const archived = context.req.query("archived") ?? "false";
    if (archived !== "false" && archived !== "true" && archived !== "all") {
      return context.json({ error: "archived must be false, true, or all" }, 400);
    }
    const view = context.req.query("view") ?? "full";
    if (view !== "full" && view !== "board") {
      return context.json({ error: "view must be full or board" }, 400);
    }
    const scope: TaskReadScope = { ...(projectId ? { projectId } : {}), archived };
    const payload = view === "board"
      ? await readBoard(db, scope)
      : await readTaskList(db, scope, { enrich: (context.req.query("enrich") ?? "true") !== "false" });
    return validated(context, payload);
  });
  app.post("/projects/:projectId/tasks", async (context) => {
    const body = await readJson(context.req.raw, taskInput);
    const projectId = id.parse(context.req.param("projectId"));
    const agent = body.assigneeAgentId
      ? await db.agent.findFirst({ where: { id: body.assigneeAgentId, projectId } })
      : null;
    if (body.assigneeAgentId && !agent) return context.json({ error: "Assignee does not belong to this project" }, 400);
    if (agent?.archivedAt) return context.json({ error: `Assignee ${agent.name} is archived` }, 400);
    const repo = body.repoId ? await db.repo.findFirst({ where: { id: body.repoId, projectId } }) : null;
    if (body.repoId && !repo) return context.json({ error: "Repo does not belong to this project" }, 400);
    if (body.assigneeType === AssigneeType.AGENT && (!agent || !repo)) {
      return context.json({ error: "Agent tasks require an assignee and Repo configuration" }, 400);
    }
    if (agent && repo) {
      const access = await db.agentRepoAccess.findFirst({ where: { agentId: agent.id, repoId: repo.id, projectId } });
      if (!access) return context.json({ error: "Assignee has no grant for this Repo" }, 400);
    }
    let schedule;
    try {
      schedule = validateSchedule(body);
    } catch (error: unknown) {
      return context.json({ error: error instanceof Error ? error.message : "Invalid schedule" }, 400);
    }
    try {
      const task = await db.$transaction(async (tx) => {
        const chainExistedBeforeLock = body.chainId === undefined ? false : await tx.task.count({
          where: { projectId, chainId: body.chainId },
        }) > 0;
        if (body.chainId !== undefined) {
          await lockChainStructure(tx, { projectId, chainId: body.chainId });
          const chainExistsUnderLock = await tx.task.count({
            where: { projectId, chainId: body.chainId },
          }) > 0;
          if (chainExistedBeforeLock && !chainExistsUnderLock) {
            return refusal(
              "conflict",
              `Cannot add Task to Chain ${body.chainId}; the Chain no longer exists`,
              { code: "chain_create_missing", chainId: body.chainId },
            );
          }
        }
        // The check above answered from an unlocked read. This one holds the
        // Agent-row mutex through the task and `openRun`, so a
        // concurrent archive either loses the race or is refused for this run.
        const currentAgent = agent ? await lockAgentRow(tx, agent.id) : null;
        if (agent && !currentAgent) return refusal("invalid-request", "Assignee does not belong to this project");
        if (currentAgent?.archivedAt) return refusal("invalid-request", `Assignee ${currentAgent.name} is archived`);
        // §D-P4, inside the transaction and before `tx.task.create`. This route
        // cannot set `templateStepId` at all, so in practice it refuses the
        // sentinel Agent outright — which is the point: an ordinary task
        // assigned to the sentinel would claim as `agent` and spawn a model CLI
        // with `mechanical/merge-executor-v1` as its model.
        const bindingRefusal = await integratorBindingRefusalFor(tx, {
          assigneeAgentName: currentAgent?.name ?? null,
          templateStep: null,
        });
        if (bindingRefusal) return refusal("invalid-request", bindingRefusal);
        const created = await tx.task.create({
          data: {
            ...withoutUndefined(body),
            ...schedule,
            projectId,
            chainLayer: body.chainId === undefined ? null : body.chainIndex,
          } as Prisma.TaskUncheckedCreateInput,
        });
        await tx.taskActivity.create({ data: { taskId: created.id, actorType: "operator", body: "Task created" } });
        // API-created chains arrive one task at a time. Only index 0 may receive
        // an eager run; later indexed steps stay parked until
        // activateChainSuccessor observes their predecessor's durable success.
        // Without this guard every POST snapshots the fallback base before step
        // 0 can publish, and all runners race the same new shared head.
        const mayQueueInline = created.chainIndex == null || created.chainIndex === 0;
        if (created.status === TaskStatus.TODO && currentAgent && repo && body.assigneeType === AssigneeType.AGENT && schedule.scheduleKind === ScheduleKind.NOW && mayQueueInline) {
        // Bypassing `openRun` here once put step 1 on a per-Task branch while
        // every later Step shared the Chain branch, silently dropping step 1.
          const opened = await openRun(tx, created.id, { kind: "task-created", readyAt: new Date() });
          // A refusal must roll back the Task born earlier in this transaction;
          // returning it would commit a Task whose requested eager Run is absent.
          if (!opened.ok) throw new TaskCreateOpenRunRefusal(opened.refusal);
        }
        return { created };
      });
      if ("message" in task) return refusalJson(context, task);
      return context.json(task.created, 201);
    } catch (error: unknown) {
      if (error instanceof TaskCreateOpenRunRefusal) return refusalJson(context, error.refusal);
      throw error;
    }
  });
  app.get("/tasks/:taskId", async (context) => {
    const task = await db.task.findUnique({
      where: { id: id.parse(context.req.param("taskId")) },
      include: {
        assigneeAgent: true,
        repo: true,
        templateStep: {
          select: {
            name: true,
            stepIndex: true,
            outputKind: true,
            // Not part of the projection: `readBrief` needs it to migrate a
            // task written before the brief fence existed.
            priorOutputKinds: true,
            taskTemplate: { select: { name: true } },
          },
        },
        // Every run of the task, so the omitted `Run.output` matters most here:
        // five tails would dwarf everything else this route returns.
        runs: { orderBy: { runNumber: "desc" }, omit: { output: true }, include: { session: true } },
        stepOutput: { select: { kind: true, body: true, runId: true } },
      },
    });
    if (!task) return context.json({ error: "Task not found" }, 404);
    const latestSession = task.runs[0]?.session ?? null;
    const sessionEvents = latestSession === null
      ? []
      : await db.sessionEvent.findMany({
        where: {
          sessionId: latestSession.id,
          type: { in: latestAgentMessageEventTypes(latestSession.runner) },
        },
        select: { type: true, at: true, payload: true },
        orderBy: { seq: "desc" },
        take: LATEST_AGENT_MESSAGE_EVENT_LIMIT,
      });
    const latestSessionEvents: LatestAgentMessageEvent[] = sessionEvents.reverse();
    // One tool-event read for the whole task, never one per run: a task with
    // five runs must not cost five queries. MODEL_DELTA and PROVIDER_RAW
    // payloads are the bulk of a session's events and are never loaded here.
    const metricsSessionIds = task.runs.flatMap((run) => run.session === null ? [] : [run.session.id]);
    // Project only names and outcome markers in PostgreSQL: provider tool
    // output can be megabytes and must never enter the metrics input.
    const toolEvents = metricsSessionIds.length === 0 ? [] : await db.$queryRaw<
      Array<RunMetricsToolEvent & { id: string; sessionId: string }>
    >(Prisma.sql`
      SELECT "id", "sessionId", "type", "at", "toolCallId",
        jsonb_build_object(
          'type', CASE WHEN jsonb_typeof("payload"->'type') = 'string' THEN "payload"->'type' END,
          'name', CASE WHEN jsonb_typeof("payload"->'name') = 'string' THEN "payload"->'name' END,
          'toolName', CASE WHEN jsonb_typeof("payload"->'toolName') = 'string' THEN "payload"->'toolName' END,
          'is_error', CASE WHEN jsonb_typeof("payload"->'is_error') = 'boolean' THEN "payload"->'is_error' END,
          'isError', CASE WHEN jsonb_typeof("payload"->'isError') = 'boolean' THEN "payload"->'isError' END,
          'exit_code', CASE WHEN jsonb_typeof("payload"->'exit_code') = 'number' THEN "payload"->'exit_code' END,
          'error', CASE WHEN "payload"->'error' IS NOT NULL AND "payload"->'error' <> 'null'::jsonb THEN true END
        ) AS "payload"
      FROM "SessionEvent"
      WHERE "sessionId" IN (${Prisma.join(metricsSessionIds)})
        AND "type"::text IN (${Prisma.join([...TOOL_METRIC_EVENT_TYPES])})
      ORDER BY "sessionId" ASC, "seq" ASC
    `);
    const toolEventsBySession = new Map<string, RunMetricsToolEvent[]>();
    for (const event of toolEvents) {
      const events = toolEventsBySession.get(event.sessionId);
      if (events) events.push(event); else toolEventsBySession.set(event.sessionId, [event]);
    }
    // One statement for the task's step, or none at all for a standalone task:
    // there is no population to compare a task without a template step against.
    const stepKey = task.templateStepId === null
      ? null
      : { projectId: task.projectId, templateStepId: task.templateStepId };
    const baselines = await readRunBaselines(db, stepKey === null ? [] : [stepKey]);
    const baseline = stepKey === null ? null : baselines.get(baselineKey(stepKey)) ?? null;
    const admission = await readStepAdmission(db, task.id, { locked: false });
    if (!admission.task || !admission.verdict) {
      throw new Error(`Task ${task.id} disappeared while projecting operator move targets`);
    }
    const recoveryRow = await db.mergeRecoveryAttempt.findFirst({
      where: task.chainId
        ? { integratorTask: { projectId: task.projectId, chainId: task.chainId } }
        : { integratorTaskId: task.id },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    });
    const mergeRecovery = mergeRecoveryProjection(recoveryRow);
    // §SF-1. Parsed server-side with the shared parser, so the web client never
    // interprets a `merge-result` body and the three renderers cannot disagree.
    // The run rows carry it too, bound to the run that recorded it — the table
    // is where an operator reads a run's fate, and the header pill is not.
    const latestRunId = task.runs[0]?.id ?? null;
    const mergeOutcome = projectMergeOutcome(task.stepOutput);
    const usageCosts = task.runs.map(runSessionUsageCost);
    const runs = task.runs.map((run, index) => ({
      ...run,
      session: run.session === null ? null : {
        ...run.session,
        latestAgentMessage: run.session.id === latestSession?.id
          ? projectLatestAgentMessage(run.session.runner, latestSessionEvents)
          : null,
        usageCost: serializeUsageCost(usageCosts[index] ?? null),
      },
      // Derived at read time and never persisted: `null` inside it always means
      // unknown, which is what keeps a missing timestamp out of an operator's
      // arithmetic.
      metrics: runMetrics({
        run,
        session: run.session,
        toolEvents: run.session === null ? [] : toolEventsBySession.get(run.session.id) ?? [],
        baseline,
      }),
      mergeOutcome: runOwnsMergeOutcome(task.stepOutput, run.id, latestRunId) ? mergeOutcome : null,
      mergeRecovery: recoveryRow
      && (run.id === recoveryRow.boundSourceRunId || run.id === recoveryRow.recoveryRunId)
        ? mergeRecovery
        : null,
    })) satisfies RunResponse[];
    const templateStep = task.templateStep;
    return context.json({
      ...task,
      executionOwner: chainExecutionOwner(task),
      moveTargets: operatorMoveTargets(task, admission.verdict),
      taskCost: serializeUsageCost(sumUsageCosts(usageCosts.filter((cost) => cost !== null))),
      strandedSalvageBranches: strandedSalvageBranchesFromRuns(task.runs),
      mergeOutcome,
      mergeRecovery,
      budgetRemaining: admission.verdict.checklist.budgetRemaining,
      baseline,
      editableBrief: editableBrief(task, templateStep),
      // Re-stated rather than spread: the row carries `priorOutputKinds` for
      // the brief read above, and the projection does not publish it.
      templateStep: templateStep === null ? null : {
        name: templateStep.name,
        stepIndex: templateStep.stepIndex,
        outputKind: templateStep.outputKind,
        taskTemplate: templateStep.taskTemplate,
      },
      runs,
    } satisfies TaskDetailResponse);
  });
  app.get("/tasks/:taskId/startability", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const admission = await db.$transaction((tx) => readStepAdmission(tx, taskId, { locked: false }));
    if (!admission.task) return refusalJson(context, admission.refusal);
    const task = admission.task;
    return context.json({
      ...admission.verdict,
      task: {
        id: task.id,
        name: task.name,
        agent: task.assigneeAgent ? { id: task.assigneeAgent.id, title: task.assigneeAgent.title } : null,
        repo: task.repo ? { id: task.repo.id, name: task.repo.name } : null,
        targetBranch: task.targetBranch ?? task.repo?.defaultBranch ?? null,
      },
    } satisfies TaskStartabilityResponse);
  });
  app.get("/tasks/:taskId/chain", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const detail = await readChainDetail(db, taskId);
    if (detail.kind === "not-found") return context.json({ error: "Task not found" }, 404);
    if (detail.kind === "chainless") {
      return context.json({ chainId: null, total: 0, done: 0, control: null, steps: [] } satisfies ChainResponse);
    }
    const { admissions, chainId, control, dispatchAfter, firstTaskId, rows: chainRows } = detail;
    const mergeRecovery = mergeRecoveryProjection(detail.recoveryRow);
    const ordinals = positions(chainRows);
    const progress = chainProgress(chainRows);

    return context.json({
      chainId,
      total: progress?.total ?? chainRows.length,
      done: progress?.done ?? 0,
      control: control === null ? null : chainControlReadProjection(control),
      steps: chainRows.map((row) => ({
        taskId: row.id,
        position: ordinals.get(row.id) ?? 1,
        chainIndex: row.chainIndex,
        layer: row.chainLayer,
        name: row.name,
        stepName: stepName(row),
        status: row.status,
        approvalGate: row.approvalGate,
        gateSlot: gateSlotOf(row.templateStep),
        assigneeType: row.assigneeType,
        executionOwner: chainExecutionOwner(row),
        agent: chainStepAgent(row),
        archivedAt: row.archivedAt,
        failureReason: row.failureReason,
        latestRun: row.runs[0]
          ? { id: row.runs[0].id, status: row.runs[0].status, runNumber: row.runs[0].runNumber }
          : null,
        reassignable: chainStepReassignable(admissions.get(row.id)),
        startable: admissions.get(row.id)?.verdict.startable ?? false,
        startAction: admissions.get(row.id)?.verdict.startable
          ? row.status === TaskStatus.BACKLOG ? "recover" : "start"
          : null,
        holdRefusal: admissions.get(row.id)?.holdRefusal?.message ?? null,
        currentExecution: admissions.get(row.id)?.facts.active ?? false,
        blockedOn: row.id === firstTaskId
        && row.dispatchAfterTaskId !== null
        && dispatchAfter !== null
        && dispatchAfter.status !== TaskStatus.DONE
          ? { taskId: dispatchAfter.id, name: dispatchAfter.name, status: dispatchAfter.status }
          : null,
        mergeRecovery,
      } satisfies ChainStepResponse)),
    } satisfies ChainResponse);
  });
  app.post("/tasks/:taskId/chain/hold", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, chainHoldInput);
    const address = await resolveDirectChainAddress(db, taskId);
    if ("message" in address) return refusalJson(context, address);
    const result = await readCommitted(db, (tx) => holdChain(tx, { ...address, ...body }));
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
  });
  app.post("/tasks/:taskId/chain/resume", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, chainResumeInput);
    const address = await resolveDirectChainAddress(db, taskId);
    if ("message" in address) return refusalJson(context, address);
    const result = await readCommitted(db, (tx) => resumeChain(tx, { ...address, ...body }, new Date()));
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
  });
  app.post("/tasks/:taskId/merge-tail/repair", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, mergeTailRepairInput);
    const result = await serializable(db, (tx) => requestMergeTailRepair(tx, {
      taskId,
      requestId: body.requestId,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      now: new Date(),
    }));
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
  });
  app.patch("/tasks/:taskId", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await patchTask(db, taskId, await readJson(context.req.raw, taskPatch));
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.task);
  });
  app.delete("/tasks/:taskId/chain", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const resolved = await resolveTaskChain(db, taskId);
    if (!resolved) return refusalJson(context, refusal("not-found", "Task not found"));
    if (!resolved.chain) return refusalJson(context, refusal("conflict", "Task does not belong to a Chain"));
    const address = { ...resolved.chain, taskId };
    try {
      const result = await readCommitted(db, (tx) => deleteChain(tx, address));
      if ("message" in result) return refusalJson(context, result);
      return context.body(null, 204);
    } catch (error: unknown) {
    // Defensive mapping for another restrictive history relation introduced
    // after the explicit Run check: callers still receive a guided refusal,
    // never the generic Prisma P2003 response.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
        return refusalJson(context, chainRunHistoryRefusal(address.chainId));
      }
      throw error;
    }
  });
  app.delete("/tasks/:taskId", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await readCommitted(db, async (tx) => {
      const resolved = await resolveTaskChain(tx, taskId);
      if (!resolved) return refusal("not-found", "Task not found");
      if (resolved.chain) {
      // Direct members are in this lock already; detached repairs take the
      // same Chain-first order as whole-Chain deletion before refusing.
        await lockChainRows(tx, resolved.chain);
        const current = await resolveTaskChain(tx, taskId);
        if (!current) return refusal("not-found", "Task not found");
        if (current.chain) {
          return refusal(
            "invalid-request",
            `Task belongs to Chain ${current.chain.chainId}; delete the whole Chain instead`,
            { code: "chain_task_delete_required", chainId: current.chain.chainId },
          );
        }
      }
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return refusal("not-found", "Task not found");
      await tx.task.delete({ where: { id: taskId } });
      return { deleted: 1 };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.body(null, 204);
  });
  app.post("/tasks/:taskId/retry", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const now = new Date();
    const result = await db.$transaction(async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return refusal("not-found", "Task not found");
      const admission = await readStepAdmission(tx, taskId, { locked: true });
      if (!admission.task) return admission.refusal;
      const task = admission.task;
      // Retry has its own terminal-state rules and intentionally ignores the
      // Start-only refusal ladder. A Chain hold is the one admission control
      // refusal it must consume before opening a fresh Run.
      if (admission.holdRefusal) return admission.holdRefusal;
      if (admission.blocker) {
        return refusal("conflict", `Cannot retry ${task.name}; predecessor ${admission.blocker.name} is not done`);
      }
      if (admission.facts.total === 0) return refusal("conflict", "Task has no run to retry");
      if (admission.facts.active) {
        return refusal("conflict", "Task already has an active run");
      }
      const opened = await openRun(tx, taskId, { kind: "retry", readyAt: now });
      if (!opened.ok) return opened.refusal;
      const run = opened.run;
      await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.TODO, failureReason: null } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: `Run ${run.runNumber} queued by operator retry` } });
      return { run };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.run, 201);
  });
  app.post("/tasks/:taskId/start", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    try {
      const result = await readCommitted(db, async (tx) => {
        if (!await lockTaskMutationRows(tx, taskId)) {
          return refusal("not-found", "Task not found");
        }
        const admission = await readStepAdmission(tx, taskId, { locked: true });
        if (!admission.task) return admission.refusal;
        if (admission.refusal) return admission.refusal;
        const task = admission.task;
        const run = await enqueueTaskRun(tx, taskId);
        const recovering = task.status === TaskStatus.BACKLOG;
        if (recovering) {
          await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.TODO } });
        }
        await tx.taskActivity.create({ data: {
          taskId,
          actorType: "operator",
          body: task.chainId
            ? recovering ? "Recovered parked chain step manually" : "Started next chain step manually"
            : "Started task manually",
        } });
        return { run };
      });
      if ("message" in result) return refusalJson(context, result);
      return context.json({ runId: result.run.id, runNumber: result.run.runNumber }, 201);
    } catch (error: unknown) {
    // Unreachable under the lock, because the loser sees the winner's run and
    // returns the 409 above. Mapped anyway: a 500 on a double-click is exactly
    // the failure the guard exists to prevent.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return context.json({ error: "Task already has an active run" }, 409);
      }
      throw error;
    }
  });
  app.post("/tasks/:taskId/archive", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await readCommitted(db, async (tx) => {
      // Detached repair completion takes its own Task lock before the primary
      // Chain lock. Join that order so a completion that already owns the
      // repair row can emit its notice before archive closes notices, while an
      // archive that wins can refuse the still-active repair Run. Chain
      // identity and repair markers are immutable, but resolve repairs again
      // after the Chain lock to catch one created between these two reads.
      const identity = await tx.task.findUnique({
        where: { id: taskId },
        select: { projectId: true, chainId: true },
      });
      if (!identity) return refusal("not-found", "Task not found");
      if (identity.chainId !== null) {
        const unlockedChainTaskIds = (await tx.task.findMany({
          where: { projectId: identity.projectId, chainId: identity.chainId },
          select: { id: true },
        })).map((task) => task.id);
        const unlockedRepairTaskIds = await readChainRepairTaskIds(tx, {
          projectId: identity.projectId,
          chainTaskIds: unlockedChainTaskIds,
        });
        for (const repairTaskId of unlockedRepairTaskIds) {
          if (!await lockTask(tx, repairTaskId)) {
            throw new Error(`Chain repair task ${repairTaskId} disappeared while archive acquired its lock`);
          }
        }
      }
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return refusal("not-found", "Task not found");
      const taskIds = locked.chainId === null
        ? [taskId]
        : (await tx.task.findMany({
            where: { projectId: locked.projectId, chainId: locked.chainId },
            select: { id: true },
          })).map((task) => task.id);
      const repairTaskIds = locked.chainId === null
        ? []
        : await readChainRepairTaskIds(tx, {
            projectId: locked.projectId,
            chainTaskIds: taskIds,
          });
      const activeRuns = await tx.run.count({
        where: {
          taskId: { in: [...new Set([...taskIds, ...repairTaskIds])] },
          status: { in: ACTIVE_RUN_STATUSES },
        },
      });
      if (activeRuns > 0) {
        return refusal("conflict", "Cannot archive a task with an active run");
      }
      const tasks = await tx.task.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, status: true, archivedAt: true },
      });
      const reviewIds = tasks.filter((task) => task.status === TaskStatus.REVIEW).map((task) => task.id);
      if (reviewIds.length > 0) {
        const open = await tx.inboxMessage.count({
          where: { gateTaskId: { in: reviewIds }, status: InboxStatus.OPEN },
        });
        if (open > 0) return refusal("conflict", "Decide the approval gate in the Inbox first");
      }
      const archiveIds = tasks.filter((task) => task.archivedAt === null).map((task) => task.id);
      if (archiveIds.length > 0) {
        await tx.task.updateMany({ where: { id: { in: archiveIds } }, data: { archivedAt: new Date() } });
        await tx.taskActivity.createMany({ data: archiveIds.map((archivedTaskId) => ({
          taskId: archivedTaskId, actorType: "operator", body: "Task archived",
        })) });

        // Stop notices are owned by the task archive lifecycle. Restrict the
        // query to tasks that this request actually archived: re-running the
        // route on a historical archive must not become a backfill operation.
        const stopNotices = await tx.inboxMessage.findMany({
          where: {
            taskId: { in: archiveIds },
            status: InboxStatus.OPEN,
            dedupeKey: { startsWith: "merge-tail-stop:" },
          },
          select: { id: true, taskId: true },
          orderBy: [{ taskId: "asc" }, { id: "asc" }],
        });
        if (stopNotices.length > 0) {
          const stopNoticeIds = stopNotices.map((notice) => notice.id);
          const answeredAt = new Date();
          const closed = await tx.inboxMessage.updateMany({
            where: {
              id: { in: stopNoticeIds },
              taskId: { in: archiveIds },
              status: InboxStatus.OPEN,
              dedupeKey: { startsWith: "merge-tail-stop:" },
            },
            data: { status: InboxStatus.CLOSED, answeredAt },
          });
          if (closed.count !== stopNotices.length) {
            // Inbox close is a compare-and-set that does not take the Task
            // mutex. A concurrent operator close is already the desired final
            // state; only an initially selected notice that remains OPEN is an
            // inconsistency worth rolling the archive back for.
            const remainingOpen = await tx.inboxMessage.findMany({
              where: { id: { in: stopNoticeIds }, status: InboxStatus.OPEN },
              select: { id: true },
            });
            if (remainingOpen.length > 0) {
              throw new Error(
                `Archive found ${stopNotices.length} OPEN merge-tail stop notices but ${remainingOpen.length} remained OPEN`,
              );
            }
          }

          const closedByTask = new Map<string, string[]>();
          for (const notice of stopNotices) {
            if (notice.taskId === null) {
              throw new Error(`Merge-tail stop notice ${notice.id} has no task binding`);
            }
            const ids = closedByTask.get(notice.taskId) ?? [];
            ids.push(notice.id);
            closedByTask.set(notice.taskId, ids);
          }
          await tx.taskActivity.createMany({ data: [...closedByTask].map(([closedTaskId, messageIds]) => ({
            taskId: closedTaskId,
            actorType: "control-plane",
            body: `Closed merge-tail stop notices: ${messageIds.join(", ")}`,
            metadata: { inboxMessageIds: messageIds },
          })) });
        }
      }
      return { task: await tx.task.findUniqueOrThrow({ where: { id: taskId } }) };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.task);
  });
  app.post("/tasks/:taskId/unarchive", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    // This used to run unlocked, on the theory that unarchiving cannot race a
    // run into existence. It cannot — but archivedAt is the other half of what
    // makes a task live, so unarchiving a TODO|DOING|REVIEW row *is* a
    // reactivation and has to join the same protocol: Task row first, Agent row
    // second, decided on the state this transaction holds.
    //
    // Restoring DONE or BACKLOG history stays unconditional. Neither is claimed
    // by a runner or shown as work in progress, so an archived assignee cannot
    // strand them — and refusing them would make an agent's archival delete the
    // operator's ability to read their own history back onto the board.
    const result = await readCommitted(db, async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return refusal("not-found", "Task not found");
      const taskIds = locked.chainId === null
        ? [taskId]
        : (await tx.task.findMany({
            where: { projectId: locked.projectId, chainId: locked.chainId },
            select: { id: true },
          })).map((task) => task.id);
      const tasks = await tx.task.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, status: true, archivedAt: true, projectId: true, assigneeAgentId: true },
      });
      const reactivating = tasks
        .filter((task) => task.archivedAt !== null && isLiveStatus(task.status))
        .sort((left, right) => (
          (left.assigneeAgentId ?? "").localeCompare(right.assigneeAgentId ?? "")
          || left.id.localeCompare(right.id)
        ));
      for (const task of reactivating) {
        const blocked = await reactivationBlocked(tx, task);
        if (blocked) return refusal("conflict", blocked);
      }
      const unarchiveIds = tasks.filter((task) => task.archivedAt !== null).map((task) => task.id);
      if (unarchiveIds.length > 0) {
        await tx.task.updateMany({ where: { id: { in: unarchiveIds } }, data: { archivedAt: null } });
        await tx.taskActivity.createMany({ data: unarchiveIds.map((unarchivedTaskId) => ({
          taskId: unarchivedTaskId, actorType: "operator", body: "Task unarchived",
        })) });
      }
      return { task: await tx.task.findUniqueOrThrow({ where: { id: taskId } }) };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.task);
  });
  app.post("/projects/:projectId/tasks/archive-done", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const result = await readCommitted(db, async (tx) => {
      const candidates = await tx.task.findMany({
        where: { projectId, status: TaskStatus.DONE, archivedAt: null },
        select: { id: true, chainId: true },
      });
      // Lock before reading runs, so a retry cannot slip a run in between the
      // selection and the write. Ids that vanished, moved out of `Done` or were
      // archived in between simply do not come back from the lock and count as
      // neither archived nor skipped.
      const chainIds = [...new Set(candidates.flatMap((task) => task.chainId ? [task.chainId] : []))].sort();
      for (const chainId of chainIds) await lockChainRows(tx, { projectId, chainId });
      const standaloneIds = candidates.filter((task) => !task.chainId).map((task) => task.id);
      const lockedStandaloneIds = await lockDoneTasks(tx, projectId, standaloneIds);
      const chainedIds = candidates.filter((task) => task.chainId).map((task) => task.id);
      const stillDoneChained = chainedIds.length === 0 ? [] : await tx.task.findMany({
        where: { id: { in: chainedIds }, projectId, status: TaskStatus.DONE, archivedAt: null },
        select: { id: true },
      });
      const lockedIds = [...lockedStandaloneIds, ...stillDoneChained.map(({ id: chainedTaskId }) => chainedTaskId)];
      const busy = lockedIds.length === 0 ? [] : await tx.run.findMany({
        where: { taskId: { in: lockedIds }, status: { in: ACTIVE_RUN_STATUSES } },
        select: { taskId: true },
        distinct: ["taskId"],
      });
      const { archive, skipped } = partitionArchivable(
        lockedIds,
        busy.map((run) => run.taskId).filter((taskId): taskId is string => taskId !== null),
      );
      if (archive.length > 0) {
        await tx.task.updateMany({ where: { id: { in: archive } }, data: { archivedAt: new Date() } });
        await tx.taskActivity.createMany({ data: archive.map((taskId) => ({
          taskId, actorType: "operator", body: "Task archived",
        })) });
      }
      return { archived: archive.length, skipped };
    });
    return context.json(result);
  });
  app.post("/tasks/:taskId/schedule/pause", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await db.$transaction(async (tx) => {
      if (!await lockTaskMutationRows(tx, taskId)) return refusal("not-found", "Task not found");
      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { scheduleKind: true } });
      if (task.scheduleKind !== ScheduleKind.CRON) return refusal("invalid-request", "Only CRON tasks can be paused");
      // In-flight copies are left alone: pausing stops future occurrences, it does
      // not reach into work that already started.
      const paused = await tx.task.update({ where: { id: taskId }, data: { schedulePausedAt: new Date() } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: "Schedule paused" } });
      return { task: paused };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.task);
  });
  app.post("/tasks/:taskId/schedule/resume", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await db.$transaction(async (tx) => {
      if (!await lockTaskMutationRows(tx, taskId)) return refusal("not-found", "Task not found");
      const task = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { scheduleKind: true, cron: true, timezone: true },
      });
      if (task.scheduleKind !== ScheduleKind.CRON) return refusal("invalid-request", "Only CRON tasks can be resumed");
      let runAt: Date;
      try {
        if (!task.cron) throw new Error("CRON tasks require cron");
        // Recomputed from *now*, so a long pause produces no catch-up burst.
        runAt = computeNextOccurrence(task.cron, task.timezone, new Date());
      } catch (error: unknown) {
        return refusal("invalid-request", error instanceof Error ? error.message : "Invalid schedule");
      }
      const resumed = await tx.task.update({ where: { id: taskId }, data: { schedulePausedAt: null, runAt } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: "Schedule resumed" } });
      return { task: resumed };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.task);
  });
  app.get("/tasks/:taskId/recurring-fires", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const requested = Number(context.req.query("take") ?? 5);
    const take = Number.isSafeInteger(requested) ? Math.min(50, Math.max(1, requested)) : 5;
    const copies = await db.task.findMany({
      where: { recurringSourceTaskId: taskId },
      orderBy: { createdAt: "desc" },
      take,
      include: {
        runs: {
          orderBy: { runNumber: "desc" },
          take: 1,
          include: { session: { select: { id: true, costUsd: true } } },
        },
      },
    });
    return context.json(copies.map((copy) => ({
      taskId: copy.id,
      name: copy.name,
      createdAt: copy.createdAt,
      status: copy.status,
      latestRun: copy.runs[0] ? {
        id: copy.runs[0].id,
        status: copy.runs[0].status,
        runNumber: copy.runs[0].runNumber,
        session: copy.runs[0].session ? {
          id: copy.runs[0].session.id,
          costUsd: copy.runs[0].session.costUsd === null ? null : String(copy.runs[0].session.costUsd),
        } : null,
      } : null,
    })) satisfies RecurringFireResponse[]);
  });
  app.get("/tasks/:taskId/activity", async (context) => {
    const activities = await db.taskActivity.findMany({
      where: { taskId: id.parse(context.req.param("taskId")) },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        taskId: true,
        actorType: true,
        actorId: true,
        body: true,
        metadata: true,
        createdAt: true,
      },
    });
    return context.json(activities satisfies TaskActivityResponse[]);
  });
  app.get("/tasks/:taskId/output", async (context) => {
    const output = await db.taskStepOutput.findUnique({
      where: { taskId: id.parse(context.req.param("taskId")) },
      select: {
        id: true,
        taskId: true,
        runId: true,
        kind: true,
        body: true,
        metadata: true,
        commitSha: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return output
      ? context.json(output satisfies TaskStepOutputResponse)
      : context.json({ error: "Task output not found" }, 404);
  });
  app.put("/tasks/:taskId/output", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, taskOutputInput);
    const result = await readCommitted(db, async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return refusal("not-found", "Task not found");
      const task = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { templateStep: { select: {
          stepIndex: true,
          outputKind: true,
          taskTemplate: { select: { name: true } },
        } } },
      });
      const existing = await tx.taskStepOutput.findUnique({ where: { taskId } });
      const immutableReview = isCanonicalSolFindingsStep(task.templateStep)
      || isCanonicalBlindFindingsStep(task.templateStep);
      if (immutableReview && existing) {
        return refusal("conflict", `${task.templateStep?.outputKind ?? body.kind} task output is immutable once persisted`);
      }
      const output = await tx.taskStepOutput.upsert({
        where: { taskId },
        create: { taskId, kind: body.kind, body: body.body, commitSha: body.commitSha ?? null, ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}) },
        update: { kind: body.kind, body: body.body, ...(body.commitSha ? { commitSha: body.commitSha } : {}), ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}) },
      });
      return { output };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.output satisfies TaskStepOutputResponse);
  });
  /**
 * §D-P8 — the only mutation that can change a `target-unresolvable` outcome.
 *
 * MF-8's defect was that `re-authorize` could not change the immutable run
 * rows the target is derived from, so every renewed run returned the same
 * stop. This route writes a durable, authenticated correction — and it is
 * constrained to pull request numbers the chain's own runs actually recorded,
 * recomputed inside the transaction, so a correction can select among what
 * the chain delivered and can never introduce a foreign pull request.
 */
  app.post("/tasks/:taskId/merge-target", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, mergeTargetInput);
    const result = await readCommitted(db, async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return refusal("not-found", "Task not found");
      const task = await loadIntegratorTask(tx, taskId);
      if (!task || !taskIsIntegratorStep(task)) {
        return refusal("conflict", "Task is not a mechanical merge step");
      }
      const stopped = await stopStateFor(tx, taskId);
      if (!stopped) return refusal("conflict", "Task is not in a merge stop state");
      if (stopped.stop.condition !== "target-unresolvable") {
        return refusal("conflict", `Merge target correction applies to target-unresolvable only, not ${stopped.stop.condition}`);
      }
      if (!task.chainId) return refusal("conflict", "Task is not part of a chain");
      const observed = await observedChainPullRequests(tx, task.projectId, task.chainId);
      if (observed.length === 0) {
        return refusal(
          "conflict",
          "This chain delivered no pull request; abandon it, or deliver the pull request by re-running the delivering step, after which resolution succeeds with no correction",
        );
      }
      if (!observed.includes(body.prNumber)) {
        return refusal(
          "conflict",
          `Pull request #${body.prNumber} is not among this chain's own delivered pull requests (${observed.join(", ")})`,
        );
      }
      const priorCorrection = await latestTargetCorrection(tx, taskId);
      const activity = await tx.taskActivity.create({ data: {
        taskId,
        actorType: "operator",
        body: `Merge target corrected to PR #${body.prNumber}`,
        metadata: jsonValue({
          kind: MERGE_INTEGRATOR_KIND.targetCorrection,
          schemaVersion: 1,
          chainId: task.chainId,
          prNumber: body.prNumber,
          observedSet: observed,
          supersedesActivityId: priorCorrection?.activityId ?? null,
        }),
      } });
      // The operator's next action is the ordinary "see the evidence, approve"
      // path: the correction alone authorizes nothing.
      let cardId: string;
      try {
        cardId = await requestConfirmationCard(tx, task, stopped.stop.stopId, new Date());
      } catch (error: unknown) {
        const rejected = refusalFor(error);
        if (rejected) return rejected;
        throw error;
      }
      return { correction: { id: activity.id, prNumber: body.prNumber, observed, confirmationCardId: cardId } };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.correction, 201);
  });

  app.post("/tasks/:taskId/activity", async (context) => {
    const body = await readJson(context.req.raw, activityInput);
    const activity = await db.taskActivity.create({
      data: {
        taskId: id.parse(context.req.param("taskId")),
        actorType: "operator",
        actorId: body.actorId ?? null,
        body: body.body,
        metadata: jsonValue({
          ...body.metadata,
          [OPERATOR_NOTE_METADATA_FIELD]: true,
        }),
      },
    });
    return context.json(activity satisfies TaskActivityResponse, 201);
  });
};
