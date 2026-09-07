import {
  PR_TEMPLATE_NAME,
  canonicalTemplateIdentity,
  executionModeFor,
  isMergeExecutorRunnerId,
  loadIntegratorTask,
  mechanicalPrincipalRefusal,
  MERGE_INTEGRATOR_KIND,
  projectMergeOutcome,
  resolveChainTarget,
  runOwnsMergeOutcome,
  selectAuthorization,
  taskIsIntegratorStep,
  isRegressionVerificationOutputKind,
  decidePrHandoff,
  decideRunOutputSatisfaction,
  PR_HANDOFF_KINDS,
  type PrHandoff,
  type PrHandoffStage,
  type RunOutputEvidence,
  type CandidateActivity,
  type CardRow,
  type DecisionRow,
  Prisma,
} from "@anneal/db";
import type { PrismaClient } from "@anneal/db";
import type { Session as SessionContract } from "@anneal/db/board-contract";
import type { RunBaseline, RunMetrics } from "@anneal/db/board-contract";
import { parseSessionListFilters } from "@anneal/db/session-filter-contract";
import type { SerializesTo } from "@anneal/db/wire-serialization";
import { z } from "zod";

import { chainDisplayByTask } from "../board.js";
import {
  isCanonicalBlindFindingsStep,
  outputIsImmutableOncePersisted,
  persistSessionTaskOutput,
  requiredOutputKind,
} from "../canonical-task-output.js";
import { jsonValue } from "../execution.js";
import { getFileStore } from "../files/config.js";
import { grantAdmits, type FileOperation, type GrantLike } from "../files/grants.js";
import { NotFoundError } from "../files/store.js";
import { FAILURE_REASON_LIMIT, failureReasonText } from "../failure-reason.js";
import { InboxRunFenceRefusal, suspendForInbox } from "../inbox.js";
import { baselineKey, readRunBaselines } from "../run-baseline.js";
import {
  cancelBoundRevalidationRun,
  isRevalidationStep,
  patchBoundImplementationDescription,
  readBoundImplementationTask,
} from "../revalidation.js";
import { cancelRun } from "../run-cancel.js";
import {
  fenceRefusalResponse,
  isFenceRefusalResponse,
  runFenceRefusal as fenceRefusal,
  type RunFence,
  withFencedRun,
} from "../run-fence.js";
import {
  runMetrics,
  TOOL_METRIC_EVENT_TYPES,
  TTFT_METRIC_EVENT_TYPES,
  type RunMetricsToolEvent,
  type RunMetricsTtftEvent,
} from "../run-metrics.js";
import { sessionListWhere } from "../session-list-query.js";
import {
  FILE_WRITE_LIMIT,
  fileErrorResponse,
  fence,
  id,
  readBoundedBody,
  readJson,
  refusal,
  refusalJson,
  type RouteApp,
  type RouteDeps,
  taskOutputInput,
} from "./support.js";

const SESSION_READ_LIMIT = 5 * 1024 * 1024;
const SESSION_BASE64_BODY_LIMIT = 34 * 1024 * 1024;
/**
 * Which canonical PR delivery this Task is, or null when it is not one. The
 * chain predicates are part of the answer rather than a later trust decision:
 * a Step without a positive chain index has no handoff to assemble.
 */
const prDeliveryStage = (task: {
  chainId: string | null;
  chainIndex: number | null;
  templateStep: { outputKind: string; taskTemplate: { name: string } } | null;
}): PrHandoffStage | null => {
  if (typeof task.chainId !== "string" || task.chainId.trim().length === 0) return null;
  if (task.chainIndex === null || !Number.isInteger(task.chainIndex) || task.chainIndex <= 0) return null;
  if (!task.templateStep || canonicalTemplateIdentity(task.templateStep.taskTemplate.name)?.canonicalName !== PR_TEMPLATE_NAME) return null;
  if (task.templateStep.outputKind === "implementation") return "implementation";
  return task.templateStep.outputKind === "fixed-implementation" ? "final" : null;
};

/**
 * Decide the canonical PR handoff this delivery Run may publish. The
 * project/chain predicates are part of the query rather than a post-query
 * trust decision: a session can never receive a body from a same-index task in
 * another Project or Chain.
 *
 * The implementation Run sees only its own output (there are no earlier PR
 * outputs at its index); the final Run sees all four canonical outputs that
 * exist through its chain index. Rows that are absent or unusable stay in the
 * candidate list as themselves, so `decidePrHandoff` refuses with the reason
 * rather than silently shortening the handoff.
 */
const prHandoffFor = async (
  db: PrismaClient,
  runId: string,
  task: {
    id: string;
    projectId: string;
    chainId: string | null;
    chainIndex: number | null;
    templateStep: { outputKind: string; taskTemplate: { name: string } } | null;
  },
): Promise<PrHandoff> => {
  const stage = prDeliveryStage(task);
  if (stage === null) return decidePrHandoff(null, []);

  const rows = await db.task.findMany({
    where: {
      projectId: task.projectId,
      chainId: task.chainId,
      chainIndex: stage === "implementation" ? task.chainIndex! : { lte: task.chainIndex! },
      templateStep: {
        outputKind: { in: [...PR_HANDOFF_KINDS] },
        taskTemplate: { name: task.templateStep!.taskTemplate.name },
      },
      stepOutput: stage === "implementation"
        ? { is: { runId, kind: "implementation" } }
        : { isNot: null },
      ...(stage === "implementation" ? {} : {
        OR: [
          { id: { not: task.id } },
          { id: task.id, stepOutput: { is: { runId } } },
        ],
      }),
    },
    orderBy: { chainIndex: "asc" },
    select: {
      id: true,
      chainIndex: true,
      templateStep: { select: { outputKind: true } },
      stepOutput: { select: { kind: true, body: true, commitSha: true } },
    },
  });

  for (const row of rows) {
    if (row.stepOutput && row.stepOutput.kind !== row.templateStep?.outputKind) {
      return { case: "incomplete", reason: `canonical PR output kind does not match the producing Step for Task ${row.id}` };
    }
  }
  return decidePrHandoff(
    { taskId: task.id, chainIndex: task.chainIndex!, stage },
    rows.map((row) => ({
      taskId: row.id,
      chainIndex: row.chainIndex,
      kind: row.stepOutput?.kind ?? "",
      body: row.stepOutput?.body ?? "",
      commitSha: row.stepOutput?.commitSha ?? null,
    })),
  );
};
const sessionWriteInput = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});
/** Revalidation is intentionally narrower than the operator task PATCH: the
 * session names only the replacement brief and the server derives the one
 * same-chain implementation task from the fenced Run. */
const revalidationPatchInput = z.object({
  fencingToken: fence,
  description: z.string(),
}).strict();
const revalidationCancelInput = z.object({ fencingToken: fence }).strict();
const inboxQuestionInput = z.object({
  fencingToken: fence,
  requestId: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  choices: z.array(z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(200) })).max(20).default([]),
  chatId: z.string().min(1).optional(),
  resumableUntil: z.coerce.date().nullable().optional(),
});
const cancelRunInput = z.object({
  requestId: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).pipe(failureReasonText(FAILURE_REASON_LIMIT)),
  parkTask: z.boolean().default(false),
});

/** The response names both its native projection and the browser contract that
 * projection must JSON-serialize to, so every `satisfies` below proves the
 * whole wire claim rather than the native half of it. */
type SessionResponse = SerializesTo<SessionContract<Date, Prisma.Decimal>, SessionContract>;
type SessionDetailContract<DateTime = string, DecimalValue = string> = SessionContract<DateTime, DecimalValue> & {
  metrics: RunMetrics | null;
  baseline: RunBaseline | null;
};
type SessionDetailResponse = SerializesTo<SessionDetailContract<Date, Prisma.Decimal>, SessionDetailContract>;

type SessionMetricEvent = {
  type: string;
  at: Date;
  toolCallId: string | null;
  payload: unknown;
};

/** Read only the provider fields the shared diagnostics calculator needs. The
 * full event payload can contain a provider response or tool output measured in
 * megabytes, so it must never be loaded into a session-detail response. */
const readSessionMetricEvents = async (db: PrismaClient, sessionId: string): Promise<SessionMetricEvent[]> => db.$queryRaw<SessionMetricEvent[]>(Prisma.sql`
  SELECT "type", "at", "toolCallId",
    jsonb_build_object(
      'type', CASE WHEN jsonb_typeof("payload"->'type') = 'string' THEN "payload"->'type' END,
      'name', CASE WHEN jsonb_typeof("payload"->'name') = 'string' THEN "payload"->'name' END,
      'toolName', CASE WHEN jsonb_typeof("payload"->'toolName') = 'string' THEN "payload"->'toolName' END,
      'is_error', CASE WHEN jsonb_typeof("payload"->'is_error') = 'boolean' THEN "payload"->'is_error' END,
      'isError', CASE WHEN jsonb_typeof("payload"->'isError') = 'boolean' THEN "payload"->'isError' END,
      'exit_code', CASE WHEN jsonb_typeof("payload"->'exit_code') = 'number' THEN "payload"->'exit_code' END,
      'error', CASE WHEN "payload"->'error' IS NOT NULL AND "payload"->'error' <> 'null'::jsonb THEN true END,
      'anneal', CASE WHEN jsonb_typeof("payload"->'anneal') = 'object' THEN jsonb_build_object(
        'ttftMs', CASE WHEN jsonb_typeof("payload"->'anneal'->'ttftMs') = 'number'
          THEN "payload"->'anneal'->'ttftMs' END
      ) END
    ) AS "payload"
  FROM "SessionEvent"
  WHERE "sessionId" = ${sessionId}
    AND ("type"::text IN (${Prisma.join([...TOOL_METRIC_EVENT_TYPES])}) OR (
        ("type"::text = 'MODEL_DELTA' AND (
          "payload"->>'type' = 'assistant'
          OR ("payload"->>'type' = 'item.completed' AND "payload"->'item'->>'type' = 'agent_message')
        ))
        OR ("type"::text = 'MODEL_COMPLETED'
          AND "payload"->>'type' = 'message_end'
          AND "payload"->'message'->>'role' = 'assistant')
    ))
  ORDER BY "seq" ASC
`);

export function registerSessionRoutes(app: RouteApp, deps: RouteDeps): () => void {
  const { db, releaseChainLease, appendFencedActivity } = deps;

  app.post("/session/runs/:runId/activity", appendFencedActivity);

  // The agent's own view of its run: what it is working on, what budget is left,
  // and what the prior chain steps produced. Read-only, session-scoped.
  /**
   * SPEC §8.4 — the merge executor's only read path.
   *
   * Three narrowing axes, all server-side, plus §D-P2's validation. The route
   * returns *validated authorizations*, never raw activity metadata: the
   * executor cannot be handed a forged record to reason about, because the
   * reasoning happens here against rows no client can write.
   */
  app.get("/session/runs/:runId/chain/steps/:chainIndex/activity", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const requestedIndex = Number(context.req.param("chainIndex"));
    if (!Number.isInteger(requestedIndex)) return context.json({ error: "chainIndex must be an integer" }, 400);
    const run = await db.run.findUnique({ where: { id: runId }, select: { taskId: true } });
    if (!run?.taskId) return context.json({ error: "Run not found" }, 404);
    const caller = await loadIntegratorTask(db, run.taskId);
    if (!caller) return context.json({ error: "Run not found" }, 404);
    if (isCanonicalBlindFindingsStep(caller.templateStep)) {
      return context.json({ error: "Forbidden: blind review sessions cannot read predecessor or sibling review activity" }, 403);
    }
    // Eligibility: only the mechanical step may read across the chain at all.
    if (!taskIsIntegratorStep(caller)) return context.json({ error: "Forbidden for this step" }, 403);
    if (caller.chainId === null || caller.chainIndex === null) return context.json({ error: "Run is not part of a chain" }, 404);
    const ownIndex = caller.chainIndex;
    if (requestedIndex !== ownIndex && requestedIndex !== ownIndex - 1) {
      return context.json({ error: "Only this step and its predecessor are addressable" }, 403);
    }
    const subject = requestedIndex === ownIndex
      ? caller
      : await db.task.findFirst({
        where: { projectId: caller.projectId, chainId: caller.chainId, chainIndex: requestedIndex },
      });
    if (!subject) return context.json({ error: "No task at that chain index" }, 404);

    const target = await resolveChainTarget(db, caller);
    const activities = await db.taskActivity.findMany({
      where: { taskId: subject.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, createdAt: true, actorType: true, metadata: true },
    });

    if (requestedIndex === ownIndex) {
      // The caller's own history: intent and result rows only. Operator notes
      // and every non-contractual row stay on the server.
      const own = activities.filter((row) => {
        const kind = (row.metadata as Record<string, unknown> | null)?.kind;
        return kind === MERGE_INTEGRATOR_KIND.intent || kind === MERGE_INTEGRATOR_KIND.result;
      });
      return context.json({
        chainIndex: requestedIndex,
        target,
        records: own.map((row) => ({
          id: row.id, createdAt: row.createdAt, actorType: row.actorType, payload: row.metadata,
        })),
      });
    }

    // The predecessor: authorizations, and only after validation.
    const candidates: CandidateActivity[] = activities;
    const cards = await db.inboxMessage.findMany({
      where: { gateTaskId: subject.id },
      select: { id: true, gateTaskId: true, status: true, selectedChoiceId: true, body: true },
    });
    const decisions = await db.inboxDecision.findMany({
      where: { inboxMessageId: { in: cards.map((card) => card.id) } },
      select: { id: true, decision: true, createdAt: true, inboxMessageId: true },
    });
    const selection = selectAuthorization(candidates, decisions as DecisionRow[], cards as CardRow[], subject.id);
    return context.json({
      chainIndex: requestedIndex,
      target,
      authorization: selection.authorization,
      nearMatchCount: selection.nearMatchCount,
      ignoredCount: selection.ignoredCount,
      refusal: selection.refusal,
    });
  });

  app.get("/session/runs/:runId/status", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const run = await db.run.findUnique({
      where: { id: runId },
      include: {
        task: {
          include: {
            stepOutput: true,
            templateStep: {
              select: {
                name: true,
                stepIndex: true,
                outputKind: true,
                priorOutputKinds: true,
                taskTemplate: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!run) return context.json({ error: "Run not found" }, 404);
    // Keyed on the Step, not on the Agent bound to it: a staffing profile may
    // put any Agent on the revalidation step, and the capability belongs to the
    // step. `deriveBoundImplementationTask` re-checks the same predicate.
    const boundImplementationTask = run.task && isRevalidationStep(run.task.templateStep)
      ? await readBoundImplementationTask(db, run)
      : null;
    if (boundImplementationTask && "message" in boundImplementationTask) {
      return refusalJson(context, boundImplementationTask);
    }
    const outputEvidence: RunOutputEvidence = {
      satisfaction: decideRunOutputSatisfaction(
        run.id,
        {
          outputKind: run.task ? requiredOutputKind(run.task.templateStep) : null,
          immutableOncePersisted: outputIsImmutableOncePersisted(run.task?.templateStep),
          remediable: !isRegressionVerificationOutputKind(run.task?.templateStep?.outputKind),
        },
        run.task?.stepOutput ?? null,
      ),
      prHandoff: run.task ? await prHandoffFor(db, run.id, run.task) : decidePrHandoff(null, []),
    };
    return context.json({
      run: {
        id: run.id,
        runNumber: run.runNumber,
        maxRunsPerTask: run.maxRunsPerTask,
        status: run.status,
        startedAt: run.startedAt,
        maxDurationMin: run.maxDurationMin,
        stallTimeoutMin: run.stallTimeoutMin,
        branch: run.branch,
        targetBranch: run.targetBranch,
      },
      task: run.task ? {
        id: run.task.id,
        name: run.task.name,
        status: run.task.status,
        approvalGate: run.task.approvalGate,
        chainIndex: run.task.chainIndex,
        stepName: run.task.templateStep?.name ?? null,
        outputKind: run.task.templateStep?.outputKind ?? null,
        // The one decided answer completion reads too, so a retry cannot
        // mistake an earlier Run's artifact for its own and delivery cannot
        // re-judge a handoff this route already refused.
        outputEvidence,
        ...(boundImplementationTask ? { boundImplementationTask } : {}),
      } : null,
    });
  });

  /**
   * The revalidator's only task mutation. The target is derived from the
   * fenced Run, so a session can never name an arbitrary task or chain.
   */
  app.patch("/session/runs/:runId/task", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const body = await readJson(context.req.raw, revalidationPatchInput);
    const fence: RunFence = { runId, fencingToken: body.fencingToken, at: new Date() };
    const result = await patchBoundImplementationDescription(db, fence, body.description, principal.leaseGeneration);
    if (isFenceRefusalResponse(result)) return refusalJson(context, fenceRefusal(result.reason));
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.task);
  });

  /** Ask the owning runner to cancel a premise-collapsed revalidation Run. */
  app.post("/session/runs/:runId/revalidation/cancel", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const body = await readJson(context.req.raw, revalidationCancelInput);
    const fence: RunFence = { runId, fencingToken: body.fencingToken, at: new Date() };
    const result = await cancelBoundRevalidationRun(db, fence, new Date(), principal.leaseGeneration);
    if (isFenceRefusalResponse(result)) return refusalJson(context, fenceRefusal(result.reason));
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
  });

  app.put("/session/runs/:runId/output", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const body = await readJson(context.req.raw, taskOutputInput);
    if (!body.fencingToken) return context.json({ error: "fencingToken is required" }, 400);
    const fence: RunFence = { runId, fencingToken: body.fencingToken, at: new Date() };
    const result = await db.$transaction((tx) => withFencedRun(tx, fence, {
      taskId: true,
      runnerId: true,
      // §4.0. The step-12 output is the only evidence the chain has that a
      // merge happened, so writing one is bound to the executor identity as
      // well as to the session token: a session issued to anything but an
      // allowlisted merge executor cannot author a `merge-result`, and the
      // executor's session cannot author an ordinary step's output.
      task: { select: {
        id: true,
        projectId: true,
        chainId: true,
        chainIndex: true,
        templateStep: { select: {
          stepIndex: true,
          outputKind: true,
          baseFromStepIndex: true,
          taskTemplate: { select: { name: true } },
        } },
      } },
    }, async (run) => {
      if (!run.taskId || !run.task) return fenceRefusalResponse("stale-fence");
      const executionMode = executionModeFor(run.task.templateStep);
      if (executionMode !== "mechanical" && !body.commitSha) {
        return { requestError: "commitSha is required", status: 400 as const };
      }
      const outputRefusal = mechanicalPrincipalRefusal(
        executionMode,
        isMergeExecutorRunnerId(run.runnerId ?? "") ? "merge-executor" : "runner",
        run.runnerId ?? "",
      );
      if (outputRefusal) return { requestError: outputRefusal, status: 403 as const };
      return { persisted: await persistSessionTaskOutput(tx, {
        task: run.task,
        fence,
        kind: body.kind,
        body: body.body,
        commitSha: body.commitSha ?? null,
        ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}),
      }) };
    }));
    if (isFenceRefusalResponse(result)) return refusalJson(context, fenceRefusal(result.reason));
    if ("requestError" in result) return context.json({ error: result.requestError }, result.status);
    const { persisted } = result;
    if (isFenceRefusalResponse(persisted)) return refusalJson(context, fenceRefusal(persisted.reason));
    if (!persisted.ok) return refusalJson(context, refusal("conflict", persisted.reason));
    return context.json({ ...persisted.output, predecessorOutputs: persisted.predecessorOutputs });
  });

  app.post("/session/runs/:runId/inbox/questions", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const body = await readJson(context.req.raw, inboxQuestionInput);
    const chatId = body.chatId ?? process.env.FEISHU_DEFAULT_CHAT_ID;
    if (!chatId) return context.json({ error: "chatId or FEISHU_DEFAULT_CHAT_ID is required" }, 400);
    try {
      const question = await suspendForInbox(db, {
        runId,
        chatId,
        fencingToken: body.fencingToken,
        requestId: body.requestId,
        body: body.body,
        choices: body.choices,
        ...(body.resumableUntil !== undefined ? { resumableUntil: body.resumableUntil } : {}),
      });
      return context.json(question, 201);
    } catch (error: unknown) {
      if (error instanceof InboxRunFenceRefusal) return context.json(error.refusal, 409);
      if (error instanceof Error && error.message.startsWith("Run is not resumable")) return context.json({ error: error.message }, 409);
      throw error;
    }
  });

  const sessionFileAccess = async (runId: string, operation: FileOperation, path: string): Promise<Response | null> => {
    const run = await db.run.findUnique({ where: { id: runId }, select: { agentId: true } });
    if (!run) return new Response(JSON.stringify({ error: "Run not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const grants = await db.filesystemGrant.findMany({ where: { agentId: run.agentId } }) as GrantLike[];
    const store = await getFileStore();
    const admission = await grantAdmits(grants, operation, path, (value) => store.grantKey(value));
    return admission.admitted
      ? null
      : new Response(JSON.stringify({ error: `Filesystem grant missing ${admission.missing}` }), { status: 403, headers: { "Content-Type": "application/json" } });
  };

  app.get("/session/runs/:runId/files", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const path = context.req.query("dir") ?? "";
    try {
      const denied = await sessionFileAccess(runId, "list", path);
      if (denied) return denied;
      return context.json(await (await getFileStore()).list(path));
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.get("/session/runs/:runId/files/content", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const path = context.req.query("path") ?? "";
    try {
      const denied = await sessionFileAccess(runId, "read", path);
      if (denied) return denied;
      const store = await getFileStore();
      const file = await store.stat(path);
      if (!file) throw new NotFoundError(`Path not found: ${path}`);
      if (file.size > SESSION_READ_LIMIT) return context.json({ error: "File is too large for a tool result (5 MB limit)" }, 413);
      const bytes = await store.read(path);
      try {
        return context.json({ content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8", stat: file });
      } catch {
        return context.json({ content: bytes.toString("base64"), encoding: "base64", stat: file });
      }
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.put("/session/runs/:runId/files/content", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    try {
      // Bounded read, not a Content-Length pre-check: a chunked body declares no length,
      // so trusting the header let an agent materialize an unbounded body before the
      // decoded-size check below ever ran. Same treatment as the operator upload route.
      const body = sessionWriteInput.parse(JSON.parse(
        (await readBoundedBody(context.req.raw, SESSION_BASE64_BODY_LIMIT)).toString(),
      ));
      const denied = await sessionFileAccess(runId, "write", body.path);
      if (denied) return denied;
      const bytes = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8");
      if (bytes.byteLength > FILE_WRITE_LIMIT) return context.json({ error: "File exceeds 25 MB decoded write limit" }, 413);
      return context.json(await (await getFileStore()).write(body.path, bytes));
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.delete("/session/runs/:runId/files", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const path = context.req.query("path") ?? "";
    try {
      const denied = await sessionFileAccess(runId, "delete", path);
      if (denied) return denied;
      await (await getFileStore()).delete(path);
      return context.json({ ok: true });
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  // Main registered the plural /sessions* and /runs/* routes after deferred
  // runner completion; app.ts invokes the runner tail before this session tail.
  return (): void => {
    // Plural, and it must stay plural: principalMayAccess denies the operator any
    // path starting with "/session/" (auth.ts), which "/sessions" misses by one
    // character. A singular route here 403s with no useful message.
    const sessionInclude = {
      agent: { select: { id: true, title: true } },
      // §SF-1: the session's own task carries the `merge-result` output the
      // sessions pill and the lifecycle stat are projected from.
      task: {
        select: {
          id: true, name: true,
          templateStepId: true,
          // The chain the Sessions list filters on, and the template step that
          // is the only lossless proof of an instantiated chain's name.
          chainId: true,
          templateStep: { select: { name: true } },
          stepOutput: { select: { kind: true, body: true, runId: true } },
          // §SF-1: an unauthored output row can only mean the task's newest run.
          runs: { orderBy: { runNumber: "desc" }, take: 1, select: { id: true } },
        },
      },
      goal: { select: { id: true, title: true } },
      run: {
        select: {
          id: true, runNumber: true, model: true, branch: true,
          readyAt: true, status: true, endedAt: true,
          pullRequestUrl: true, workspacePath: true,
          // remoteUrl is what turns the detail page's Branch field into a link.
          repo: { select: { id: true, name: true, remoteUrl: true } },
        },
      },
    } as const;

    type MergeOutcomeSubject = {
      runId: string;
      task: {
        stepOutput?: { kind: string; body: string; runId: string | null } | null;
        runs?: Array<{ id: string }>;
      } | null;
    };
    const withMergeOutcome = <T extends MergeOutcomeSubject>(session: T) => {
      const output = session.task?.stepOutput;
      const owns = runOwnsMergeOutcome(output, session.runId, session.task?.runs?.[0]?.id ?? null);
      return { ...session, mergeOutcome: owns ? projectMergeOutcome(output) : null };
    };

    type ChainIdentitySubject = {
      projectId: string;
      task: {
        id: string;
        name: string;
        chainId: string | null;
        templateStep: { name: string } | null;
      } | null;
    };
    /**
     * Projects each session's task down to the chain identity the wire contract
     * declares. The list supplies all tasks for the chains represented on the page,
     * so filtering and paging cannot hide a direct chain's name. A
     * lone row proves one only through its template-step suffix. The include
     * fields the merge outcome needed do not survive the projection.
     */
    const chainIdentityFrom = <T extends ChainIdentitySubject>(page: readonly T[], chainTasks?: Parameters<typeof chainDisplayByTask>[0]) => {
      const display = chainDisplayByTask(chainTasks ?? page.flatMap((session) => (session.task === null ? [] : [{
        id: session.task.id,
        projectId: session.projectId,
        name: session.task.name,
        chainId: session.task.chainId,
        templateStep: session.task.templateStep,
      }])));
      return ({ task, ...session }: T) => ({
        ...session,
        task: task === null ? null : {
          id: task.id,
          name: task.name,
          chainId: task.chainId,
          chainName: display.get(task.id)?.chainName ?? null,
        },
      });
    };

    app.get("/sessions", async (context) => {
      // A present-but-unusable filter refuses by name rather than being dropped:
      // a narrowed list that silently widened would read as an answer.
      const parsed = parseSessionListFilters((parameter) => context.req.query(parameter));
      if (parsed.refusal !== undefined) {
        return refusalJson(context, refusal("invalid-request", parsed.refusal.message, { code: parsed.refusal.code }));
      }
      const projectId = context.req.query("projectId");
      const limit = Math.min(Math.max(Number.parseInt(context.req.query("limit") ?? "50", 10) || 50, 1), 200);
      const before = context.req.query("before");
      const page = (await db.session.findMany({
        where: sessionListWhere(parsed.filters, { projectId, before: before ? new Date(before) : null }),
        include: sessionInclude,
        orderBy: { requestedAt: "desc" },
        take: limit,
      })).map(withMergeOutcome);
      const chains = new Map(page.flatMap((session) => session.task?.chainId
        ? [[`${session.projectId}\u0000${session.task.chainId}`, { projectId: session.projectId, chainId: session.task.chainId }] as const]
        : []));
      const chainTasks = chains.size === 0 ? [] : await db.task.findMany({
        where: { OR: [...chains.values()] },
        select: { id: true, projectId: true, name: true, chainId: true, templateStep: { select: { name: true } } },
      });
      return context.json(page.map(chainIdentityFrom(page, chainTasks)) satisfies SessionResponse[]);
    });

    app.get("/sessions/:sessionId", async (context) => {
      const session = await db.session.findUnique({
        where: { id: id.parse(context.req.param("sessionId")) },
        include: sessionInclude,
      });
      if (session === null) return context.json({ error: "Session not found" }, 404);
      const metricEvents = await readSessionMetricEvents(db, session.id);
      const toolEvents: RunMetricsToolEvent[] = [];
      const ttftEvents: RunMetricsTtftEvent[] = [];
      for (const event of metricEvents) {
        if ((TOOL_METRIC_EVENT_TYPES as readonly string[]).includes(event.type)) {
          toolEvents.push(event);
        } else if ((TTFT_METRIC_EVENT_TYPES as readonly string[]).includes(event.type)) {
          ttftEvents.push(event);
        }
      }
      const stepKey = session.task?.templateStepId === null || session.task?.templateStepId === undefined
        ? null
        : { projectId: session.projectId, templateStepId: session.task.templateStepId };
      const baselines = await readRunBaselines(db, stepKey === null ? [] : [stepKey]);
      const baseline = stepKey === null ? null : baselines.get(baselineKey(stepKey)) ?? null;
      const metrics = session.run === null ? null : runMetrics({
        run: session.run,
        session,
        toolEvents,
        ttftEvents,
        baseline,
      });
      const row = withMergeOutcome(session);
      return context.json({
        ...chainIdentityFrom([row])(row),
        metrics,
        baseline,
      } satisfies SessionDetailResponse);
    });

    app.post("/runs/:runId/cancel", async (context) => {
      const runId = id.parse(context.req.param("runId"));
      const body = await readJson(context.req.raw, cancelRunInput);
      const result = await cancelRun(db, runId, body, releaseChainLease);
      if ("message" in result) return refusalJson(context, result);
      return context.json(result);
    });

    app.get("/runs/:runId/events", async (context) => {
      const runId = id.parse(context.req.param("runId"));
      const afterSeq = Number.parseInt(context.req.query("afterSeq") ?? "", 10);
      const limit = Math.min(Math.max(Number.parseInt(context.req.query("limit") ?? "500", 10) || 500, 1), 2_000);
      const where = { runId, ...(Number.isFinite(afterSeq) ? { seq: { gt: afterSeq } } : {}) };
      const [events, total] = await Promise.all([
      // One extra row decides hasMore without a second count on the filtered set.
        db.sessionEvent.findMany({ where, orderBy: { seq: "asc" }, take: limit + 1 }),
        db.sessionEvent.count({ where: { runId } }),
      ]);
      const hasMore = events.length > limit;
      const page = hasMore ? events.slice(0, limit) : events;
      return context.json({ events: page, nextAfterSeq: page.at(-1)?.seq ?? null, hasMore, total });
    });
  };
}
