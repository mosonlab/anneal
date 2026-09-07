import assert from "node:assert/strict";

import { parseRunOutputEvidence, type FailureEnvelope, type RunOutcome } from "@anneal/db";

import {
  controlPlaneErrorFor,
  type CancellationRequest,
  type Completion,
  type ControlPlane,
  type PreflightReport,
  type RunSession,
  type RunSessionClaim,
  type RunStartSnapshot,
  type SessionEventPayload,
  type SessionTaskOutput,
} from "./api.js";
import type { RunnerConfig, RunnerKind } from "./config.js";

/** The reason a failing outcome carries, with the success cases ruled out. */
export const failureReasonOf = (outcome: RunOutcome | undefined): string => {
  assert.ok(outcome && "reason" in outcome, `expected a failing outcome, got ${outcome?.case}`);
  return outcome.reason;
};

/** The structured evidence a provider failure carries. */
export const envelopeOf = (outcome: RunOutcome | undefined): FailureEnvelope => {
  assert.ok(outcome?.case === "provider-failure", `expected a provider failure, got ${outcome?.case}`);
  return outcome.envelope;
};

/**
 * Every operation of both seams, in the bound form production consumes. A test
 * overrides the ones its scenario is about; the rest record and answer with the
 * ordinary success of an unremarkable control plane. `openRun` is how an
 * override reaches the claim its session was opened for — the one thing a bound
 * session hides from a caller that only sees the operations.
 */
export type ControlPlaneOverrides = Partial<RunSession> & Partial<Omit<ControlPlane, "openRun">> & {
  openRun?: (claim: RunSessionClaim) => Partial<RunSession>;
};

export type ControlPlaneDouble = {
  controlPlane: ControlPlane;
  completions: Completion[];
  starts: RunStartSnapshot[];
  eventBatches: SessionEventPayload[][];
  activities: Array<{ body: string; metadata: Record<string, unknown> }>;
  taskOutputs: SessionTaskOutput[];
  publishedBranches: string[];
  reclaimPublications: string[];
  preflightReports: Array<{ runner: RunnerKind; result: PreflightReport }>;
  outputStatusReadCount: () => number;
};

/** In-memory adapter for tests that need runner domain outcomes, not HTTP routes. */
export const createControlPlaneDouble = (
  overrides: ControlPlaneOverrides = {},
): ControlPlaneDouble => {
  const completions: Completion[] = [];
  const starts: RunStartSnapshot[] = [];
  const eventBatches: SessionEventPayload[][] = [];
  const activities: Array<{ body: string; metadata: Record<string, unknown> }> = [];
  const taskOutputs: SessionTaskOutput[] = [];
  const publishedBranches: string[] = [];
  const reclaimPublications: string[] = [];
  const preflightReports: ControlPlaneDouble["preflightReports"] = [];
  let outputStatusReads = 0;

  const openRun = (claim: RunSessionClaim): RunSession => {
    const session: Partial<RunSession> = { ...overrides, ...overrides.openRun?.(claim) };
    return {
      start: async (snapshot) => {
        starts.push(snapshot);
        await session.start?.(snapshot);
      },
      heartbeat: async (progress) => await session.heartbeat?.(progress) ?? { held: true },
      note: async (body, metadata) => {
        activities.push({ body, metadata: metadata ?? {} });
        await session.note?.(body, metadata);
      },
      emit: async (events, providerConversationId) => {
        eventBatches.push(events);
        await session.emit?.(events, providerConversationId);
      },
      publishOutput: async (output) => {
        taskOutputs.push(output);
        await session.publishOutput?.(output);
      },
      outputStatus: async () => {
        outputStatusReads += 1;
        return await session.outputStatus?.() ?? null;
      },
      publishBranch: async (pushedBranch) => {
        publishedBranches.push(pushedBranch);
        await session.publishBranch?.(pushedBranch);
      },
      recordCleanup: async (cleanup) => {
        await session.recordCleanup?.(cleanup);
      },
      acknowledgeCancellation: async (cancellation, workspace, containment) => {
        await session.acknowledgeCancellation?.(cancellation, workspace, containment);
      },
      finish: async (completion) => {
        completions.push(completion);
        await session.finish?.(completion);
      },
    };
  };

  const controlPlane: ControlPlane = {
    claim: async () => await overrides.claim?.() ?? null,
    openRun,
    fetchReclaimPlan: async (inventory) => await overrides.fetchReclaimPlan?.(inventory) ?? null,
    reportReclaimOutcomes: async (report) => {
      await overrides.reportReclaimOutcomes?.(report);
    },
    recordReclaimPublication: async (publication) => {
      reclaimPublications.push(publication.pushedBranch);
      await overrides.recordReclaimPublication?.(publication);
    },
    reportPreflight: async (runner, result) => {
      preflightReports.push({ runner, result });
      await overrides.reportPreflight?.(runner, result);
    },
    reportCliAvailability: async (availability) =>
      await overrides.reportCliAvailability?.(availability) ?? { revalidatePreflight: false },
  };

  return {
    controlPlane,
    completions,
    starts,
    eventBatches,
    activities,
    taskOutputs,
    publishedBranches,
    reclaimPublications,
    preflightReports,
    outputStatusReadCount: () => outputStatusReads,
  };
};

export type ControlPlaneFetchHandler = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Migration adapter for older runner tests whose scenarios were expressed as
 * synthetic HTTP responses. The production code still receives a ControlPlane
 * double; this adapter keeps those fixtures local while newer tests use direct
 * operation overrides above.
 */
export const createRoutedControlPlaneDouble = (
  config: Pick<RunnerConfig, "apiUrl" | "runnerId">,
  handler: ControlPlaneFetchHandler,
): ControlPlaneDouble => {
  const request = async <T>(
    path: string,
    body: Record<string, unknown>,
    method: "POST" | "PUT" = "POST",
  ): Promise<T> => {
    const response = await handler(`${config.apiUrl}${path}`, {
      method,
      body: JSON.stringify(body),
    });
    const responseBody = await response.text();
    // The production seam's own parse, so a routed double raises the error a
    // runner would actually see, refusal detail included.
    if (!response.ok) throw controlPlaneErrorFor(response.status, responseBody);
    return (responseBody.trim() ? JSON.parse(responseBody) : {}) as T;
  };

  return createControlPlaneDouble({
    reportPreflight: async (runner, result) => {
      await request("/runner/preflight", { runner, ...result });
    },
    reportCliAvailability: async (availability) => {
      const body = await request<{ revalidatePreflight?: boolean }>("/runner/availability", {
        runnerId: config.runnerId, ...availability,
      });
      return { revalidatePreflight: body.revalidatePreflight === true };
    },
    openRun: (claim) => {
      const fenced = { runnerId: config.runnerId, fencingToken: claim.fencingToken };
      return {
        start: async (snapshot) => {
          await request(`/runner/runs/${claim.run.id}/start`, { ...fenced, ...snapshot });
        },
        heartbeat: async (progress) => {
          const result = await request<{ ok: boolean; cancellation: CancellationRequest | null }>(
            `/runner/runs/${claim.run.id}/heartbeat`, { ...fenced, ...progress },
          );
          return result.cancellation ? { held: false, reason: "cancelled", request: result.cancellation } : { held: true };
        },
        emit: async (events, providerConversationId) => {
          await request(`/runner/runs/${claim.run.id}/events`, {
            ...fenced, providerConversationId: providerConversationId ?? null, events,
          });
        },
        note: async (body, metadata) => {
          await request(`/runner/runs/${claim.run.id}/activity`, {
            fencingToken: claim.fencingToken, actorId: config.runnerId, body, metadata: metadata ?? {},
          });
        },
        finish: async (completion) => {
          await request(`/runner/runs/${claim.run.id}/complete`, { ...fenced, ...completion });
        },
        publishOutput: async (output) => {
          await request(`/session/runs/${claim.run.id}/output`, {
            fencingToken: claim.fencingToken,
            ...output,
          }, "PUT");
        },
        outputStatus: async () => {
          const payload = await request<{ task: { outputEvidence: unknown } | null }>(
            `/session/runs/${claim.run.id}/status`,
            {},
          );
          return payload.task ? parseRunOutputEvidence(payload.task.outputEvidence) : null;
        },
        publishBranch: async (pushedBranch) => {
          await request(`/runner/runs/${claim.run.id}/publication`, { ...fenced, pushedBranch });
        },
        recordCleanup: async (cleanup) => {
          await request(`/runner/runs/${claim.run.id}/cleanup`, { ...fenced, ...cleanup });
        },
        acknowledgeCancellation: async (cancellation, workspace, containment) => {
          await request(`/runner/runs/${claim.run.id}/cancel/acknowledge`, {
            ...fenced,
            requestId: cancellation.requestId,
            ...(workspace ? { workspacePath: workspace.path, branch: workspace.branch, baseSha: workspace.baseSha } : {}),
            ...containment,
          });
        },
      };
    },
  });
};
