import {
  basePublishedStamp,
  CleanupStatus,
  executionModeFor,
  landIntegratorStop,
  MERGE_INTEGRATOR_KIND,
  parseStoppedResultMetadata,
  Prisma,
  type PrismaClient,
  recomputeSessionUsage,
  RunStatus,
  SessionEventSource,
  SessionExecutionStatus,
} from "@anneal/db";
import { z } from "zod";

import type { Principal } from "./auth.js";
import { COMPLETION_REJECTION_ACTIVITY_KIND } from "./completion-rejection.js";
import { jsonValue, normalizeSessionEventValue } from "./execution.js";
import type { Refusal } from "./refusal.js";
import { runnerTelemetryFields } from "./run-claim.js";
import {
  activeRunStatuses,
  cleanupAuthorityRefusal,
  fenceRefusalResponse,
  fencedRunWhere,
  isFenceRefusalResponse,
  liveAuthorityRefusal,
  lockAuthorityRun,
  runFenceRefusal,
  salvageAuthorityRefusal,
  type RunFence,
  withFencedRun,
  withRunOnlyFencedRun,
} from "./run-fence.js";
import { repairReplacementAfterSalvage } from "./workspace-reclaim.js";

const fence = z.string().min(1);

export const activityInput = z.object({
  actorType: z.string().trim().min(1).max(40).default("operator"),
  actorId: z.string().trim().min(1).nullable().optional(),
  body: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const fencedActivityInput = activityInput.extend({ fencingToken: fence });

export const heartbeatInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  leaseSeconds: z.number().int().min(15).max(3600).default(60),
  processAlive: z.boolean(),
  lastProgressEventAt: z.coerce.date().nullable().optional(),
  inFlightTool: z.record(z.string(), z.unknown()).nullable().optional(),
  ...runnerTelemetryFields,
});

export const publicationInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  pushedBranch: z.string().trim().min(1).max(255),
});

export const leaseIndependentCleanupInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  cleanupStatus: z.nativeEnum(CleanupStatus),
  cleanupFailureReason: z.string().max(4000).optional(),
  workspaceRetained: z.boolean(),
});

export const mechanicalStartInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  adapterVersion: z.string().min(1),
  cliVersion: z.string().min(1),
  authMode: z.string().nullable().optional(),
  manifest: z.record(z.string(), z.unknown()),
  workspacePath: z.string().min(1).nullable(),
  branch: z.string().nullable().optional(),
  baseSha: z.string().nullable().optional(),
  runtimeHandle: z.string().nullable().optional(),
});

export const startInput = mechanicalStartInput.extend({
  promptHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

const eventInput = z.object({
  seq: z.number().int().nonnegative(),
  at: z.coerce.date().optional(),
  source: z.nativeEnum(SessionEventSource),
  type: z.string().min(1).max(100),
  providerEventId: z.string().nullable().optional(),
  toolCallId: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export const eventsInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  providerConversationId: z.string().nullable().optional(),
  events: z.array(eventInput).min(1).max(250),
});

export type StartRunBody = z.infer<typeof mechanicalStartInput> & { promptHash: string | null };
export type HeartbeatRunBody = z.infer<typeof heartbeatInput>;
export type PublicationBody = z.infer<typeof publicationInput>;
export type CleanupBody = z.infer<typeof leaseIndependentCleanupInput>;
export type EventsBody = z.infer<typeof eventsInput>;
export type ActivityBody = z.infer<typeof fencedActivityInput>;

const refused = (message: string): Refusal => ({ reason: "conflict", message });

export const startRun = async (
  db: PrismaClient,
  input: { runId: string; body: StartRunBody; now?: Date },
): Promise<{ ok: true } | Refusal> => {
  const now = input.now ?? new Date();
  const fence: RunFence = {
    runId: input.runId,
    runnerId: input.body.runnerId,
    fencingToken: input.body.fencingToken,
    at: now,
    statuses: [RunStatus.CLAIMED, RunStatus.PROVISIONING],
  };
  const result = await db.$transaction((tx) => withRunOnlyFencedRun(tx, fence, {
    startedAt: true,
  }, async (run) => {
    const startedAt = run.startedAt ?? now;
    const updated = await tx.run.updateMany({
      where: fencedRunWhere(fence),
      data: {
        status: RunStatus.RUNNING,
        startedAt,
        adapterVersion: input.body.adapterVersion,
        cliVersion: input.body.cliVersion,
        authMode: input.body.authMode ?? null,
        promptHash: input.body.promptHash,
        manifest: jsonValue(input.body.manifest),
        workspacePath: input.body.workspacePath,
        branch: input.body.branch ?? null,
        baseSha: input.body.baseSha ?? null,
      },
    });
    if (updated.count !== 1) throw new Error(`Run ${input.runId} changed while its start transition held the lock`);
    const session = await tx.session.updateMany({
      where: { runId: input.runId, executionStatus: SessionExecutionStatus.PROVISIONING },
      data: {
        executionStatus: SessionExecutionStatus.RUNNING,
        runtimeHandle: input.body.runtimeHandle ?? null,
        resumeInput: null,
        provisionedAt: now,
        startedAt,
      },
    });
    if (session.count !== 1) throw new Error(`Run ${input.runId} has no startable Session`);
    return { ok: true } as const;
  }));
  return isFenceRefusalResponse(result) ? runFenceRefusal(result.reason) : result;
};

type RunnerObservation = (runnerId: string, body: HeartbeatRunBody, now: Date) => void;

export const heartbeatRun = async (
  db: PrismaClient,
  input: { runId: string; body: HeartbeatRunBody; noteRunner: RunnerObservation; now?: Date },
): Promise<
  | { ok: true; cancellation: null; mechanicalCancellationPolicy: "refused" }
  | {
    ok: false;
    mechanicalCancellationPolicy: "refused";
    cancellation: { requestId: string; reason: string; requestedAt: Date };
  }
  | Refusal
> => {
  const now = input.now ?? new Date();
  input.noteRunner(input.body.runnerId, input.body, now);
  return db.$transaction(async (tx) => {
    const run = await lockAuthorityRun(tx, input.runId);
    const fence: RunFence = {
      runId: input.runId,
      runnerId: input.body.runnerId,
      fencingToken: input.body.fencingToken,
      at: now,
    };
    const authorityRefusal = liveAuthorityRefusal(run, fence);
    if (authorityRefusal === null) {
      const updated = await tx.run.updateMany({
        where: fencedRunWhere(fence),
        data: {
          heartbeatAt: now,
          ...(input.body.processAlive ? {
            lastProcessAliveAt: now,
            leaseExpiresAt: new Date(now.getTime() + input.body.leaseSeconds * 1000),
          } : {}),
          ...(input.body.lastProgressEventAt !== undefined
            ? { lastProgressEventAt: input.body.lastProgressEventAt }
            : {}),
          ...(input.body.inFlightTool !== undefined
            ? { inFlightTool: input.body.inFlightTool ? jsonValue(input.body.inFlightTool) : Prisma.JsonNull }
            : {}),
        },
      });
      if (updated.count !== 1) throw new Error(`Run ${input.runId} changed while its heartbeat transition held the lock`);
      return { ok: true, cancellation: null, mechanicalCancellationPolicy: "refused" } as const;
    }
    if (
      run
      && run.runnerId === input.body.runnerId
      && run.fencingToken === input.body.fencingToken
      && run.cancelRequestId
      && run.cancelReason
      && run.cancelRequestedAt
      && activeRunStatuses.includes(run.status)
    ) {
      return {
        ok: false,
        mechanicalCancellationPolicy: "refused",
        cancellation: {
          requestId: run.cancelRequestId,
          reason: run.cancelReason,
          requestedAt: run.cancelRequestedAt,
        },
      } as const;
    }
    return run?.status === RunStatus.WAITING_INBOX
      ? runFenceRefusal("waiting-inbox")
      : runFenceRefusal(authorityRefusal);
  });
};

export const publishRun = async (
  db: PrismaClient,
  input: { runId: string; body: PublicationBody; now?: Date },
): Promise<{ ok: true; replacementRepair: "none" | "repaired" | "requeued" } | Refusal> => {
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    const run = await lockAuthorityRun(tx, input.runId);
    const fence: RunFence = {
      runId: input.runId,
      runnerId: input.body.runnerId,
      fencingToken: input.body.fencingToken,
      at: now,
    };
    const liveRefusal = liveAuthorityRefusal(run, fence);
    const salvageRefusal = salvageAuthorityRefusal(run, input.body);
    if (liveRefusal !== null && salvageRefusal !== null) return runFenceRefusal(liveRefusal);
    if (!run) return runFenceRefusal("unknown-run");

    const updated = await tx.run.updateMany({
      where: liveRefusal === null
        ? fencedRunWhere(fence)
        : {
            id: input.runId,
            runnerId: input.body.runnerId,
            fencingToken: input.body.fencingToken,
            OR: [{ pushedBranch: null }, { pushedBranch: input.body.pushedBranch }],
          },
      // The ACK is also when this Run's provisioning base became fetchable:
      // git accepted a branch that carries it. Nothing downstream may pin a
      // range to a base without that evidence.
      data: { pushedBranch: input.body.pushedBranch, basePublishedAt: basePublishedStamp(run, now) },
    });
    if (updated.count !== 1) throw new Error(`Run ${input.runId} changed while its publication transition held the lock`);

    const repair = salvageRefusal === null && run.taskId
      ? await repairReplacementAfterSalvage(tx, {
          taskId: run.taskId,
          runNumber: run.runNumber,
          branch: run.branch,
          targetBranch: run.targetBranch,
        })
      : "none";
    return repair === "already-started"
      ? refused("Salvage is durable, but the replacement already started from its prior base")
      : { ok: true, replacementRepair: repair };
  });
};

export const recordRunCleanup = async (
  db: PrismaClient,
  input: { runId: string; body: CleanupBody; now?: Date },
): Promise<{ ok: true } | Refusal> => {
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    const run = await lockAuthorityRun(tx, input.runId);
    const authorityRefusal = cleanupAuthorityRefusal(run, {
      runnerId: input.body.runnerId,
      fencingToken: input.body.fencingToken,
      at: now,
    });
    if (authorityRefusal !== null) return runFenceRefusal(authorityRefusal);
    await tx.run.update({
      where: { id: input.runId },
      data: { workspaceRetained: input.body.workspaceRetained },
    });
    await tx.session.updateMany({
      where: { runId: input.runId },
      data: {
        cleanupStatus: input.body.cleanupStatus,
        cleanupEndedAt: now,
        cleanupFailureReason: input.body.cleanupFailureReason ?? null,
      },
    });
    return { ok: true };
  });
};

export const appendRunEvents = async (
  db: PrismaClient,
  input: { runId: string; body: EventsBody; now?: Date },
): Promise<{ accepted: number } | Refusal> => {
  const now = input.now ?? new Date();
  const fence: RunFence = {
    runId: input.runId,
    runnerId: input.body.runnerId,
    fencingToken: input.body.fencingToken,
    at: now,
  };
  const result = await db.$transaction(async (tx) => {
    const appended = await withFencedRun(tx, fence, {
      session: { select: { id: true, providerConversationId: true } },
    }, async (run) => {
      if (!run.session) return fenceRefusalResponse("stale-fence");
      await tx.sessionEvent.createMany({
        data: input.body.events.map((event) => ({
          sessionId: run.session!.id,
          runId: input.runId,
          seq: event.seq,
          at: event.at ?? new Date(),
          source: event.source,
          type: normalizeSessionEventValue(event.type) as string,
          providerEventId: event.providerEventId === undefined || event.providerEventId === null
            ? null
            : normalizeSessionEventValue(event.providerEventId) as string,
          toolCallId: event.toolCallId === undefined || event.toolCallId === null
            ? null
            : normalizeSessionEventValue(event.toolCallId) as string,
          payload: jsonValue(normalizeSessionEventValue(event.payload)),
        })),
        skipDuplicates: true,
      });
      if (input.body.events.some((event) => event.type === "NATIVE_CHILD_STARTED")) {
        await tx.session.update({ where: { id: run.session.id }, data: { nativeChildUsed: true } });
      }
      if (input.body.providerConversationId && !run.session.providerConversationId) {
        await tx.session.update({
          where: { id: run.session.id },
          data: { providerConversationId: input.body.providerConversationId },
        });
      }
      return { sessionId: run.session.id };
    });
    if (!isFenceRefusalResponse(appended)) return appended;
    const waiting = await tx.run.findFirst({
      where: { id: input.runId, status: RunStatus.WAITING_INBOX },
      select: { id: true },
    });
    return waiting ? runFenceRefusal("waiting-inbox") : runFenceRefusal(appended.reason);
  });
  if ("message" in result) return result;

  if (input.body.events.some((event) => event.type === "FINAL_OUTPUT")) {
    try {
      await recomputeSessionUsage(db, result.sessionId);
    } catch (error) {
      console.error(`Session usage recompute failed for ${result.sessionId}`, error);
    }
  }
  return { accepted: input.body.events.length };
};

export const appendRunActivity = async (
  db: PrismaClient,
  input: { runId: string; body: ActivityBody; principal: Principal; now?: Date },
) => {
  const fence: RunFence = {
    runId: input.runId,
    fencingToken: input.body.fencingToken,
    at: input.now ?? new Date(),
  };
  const result = await db.$transaction((tx) => withFencedRun(tx, fence, {
    taskId: true,
    leaseGeneration: true,
    agentId: true,
    session: { select: { id: true } },
    task: { select: { templateStep: { select: {
      stepIndex: true,
      outputKind: true,
      taskTemplate: { select: { name: true } },
    } } } },
  }, async (run) => {
    const leaseGeneration = input.principal.kind === "session" ? input.principal.leaseGeneration : null;
    if (!run.taskId || leaseGeneration !== null && run.leaseGeneration !== leaseGeneration) {
      return fenceRefusalResponse("stale-fence");
    }
    const metadata = input.body.metadata
      ? {
          ...input.body.metadata,
          ...(((input.body.metadata.kind === MERGE_INTEGRATOR_KIND.intent
            || input.body.metadata.kind === MERGE_INTEGRATOR_KIND.result
            || input.body.metadata.kind === COMPLETION_REJECTION_ACTIVITY_KIND)
            && executionModeFor(run.task?.templateStep ?? null) === "mechanical")
            ? { sourceRunId: input.runId }
            : {}),
        }
      : undefined;
    const mechanicalResultPrincipal = input.principal.kind === "session" || input.principal.kind === "merge-executor";
    const mechanical = executionModeFor(run.task?.templateStep ?? null) === "mechanical";
    const stopped = mechanicalResultPrincipal && mechanical
      ? parseStoppedResultMetadata(metadata)
      : null;
    const metadataRecord = metadata as Record<string, unknown> | undefined;
    const declaredStoppedResult = metadataRecord?.kind === MERGE_INTEGRATOR_KIND.result
      && metadataRecord.outcome === "stopped";
    if (mechanicalResultPrincipal && mechanical && declaredStoppedResult && stopped?.sourceRunId !== input.runId) {
      return refused("Stopped merge result metadata is malformed");
    }
    const activity = await tx.taskActivity.create({
      data: {
        taskId: run.taskId,
        actorType: input.principal.kind,
        actorId: input.body.actorId ?? null,
        body: input.body.body,
        ...(metadata ? { metadata: jsonValue(metadata) } : {}),
      },
    });
    // A mechanical executor writes its replaceable output and append-only
    // result through separate fenced calls. Land a valid stopped result from
    // either of its authenticated principals while this activity transaction
    // is still open, so a committed result can never become a guard-visible
    // stop without its condition-specific Inbox question. `landIntegratorStop`
    // adopts this exact activity id; its Task lock and unique dedupe key
    // serialize replays and concurrent repair.
    if (stopped) {
      await landIntegratorStop(tx, {
        integratorTaskId: run.taskId,
        resultActivityId: activity.id,
        condition: stopped.condition,
        evidence: stopped.evidence,
        sourceRunId: stopped.sourceRunId,
      });
    }
    return activity;
  }));
  return isFenceRefusalResponse(result) ? runFenceRefusal(result.reason) : result;
};
