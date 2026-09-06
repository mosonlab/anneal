/**
 * The executor's control-plane client.
 *
 * It uses exactly the existing runner and session principals — no new token
 * class (SPEC §10). The `MERGE_EXECUTOR_TOKEN` claims and completes; the per-run session
 * token, issued by the claim, reads the chain and writes the fenced records.
 *
 * Note what is NOT here: no workspace, no prompt, no adapter, no delivery, no
 * publication call of any kind. The package's import graph is asserted in
 * `import-graph.test.ts` precisely so that stays true.
 */

import type { MergeOutcome } from "@anneal/db/merge-integrator";
import {
  MECHANICAL_CONTRACT_MISMATCH_CODE,
  RUN_COMPLETION_CONTRACT_VERSION,
  type MechanicalClaim,
  type MechanicalContractMismatchRefusal,
} from "@anneal/db/claim-contract";

import type { ExecutorConfig } from "./config.js";
import type { ChainEnvelope, IntentRecord } from "./decision-table.js";

export type MechanicalCancellation = {
  requestId: string;
  reason: string;
  requestedAt: string;
};

export type MechanicalHeartbeat = {
  cancellation: MechanicalCancellation | null;
  mechanicalCancellationPolicy: "refused" | null;
};

export class AgentOsResponseError extends Error {
  override readonly name = "AgentOsResponseError";

  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`Anneal API ${status}: ${responseBody}`);
  }
}

export class MechanicalContractMismatchError extends Error {
  override readonly name = "MechanicalContractMismatchError";

  constructor(
    readonly executorVersion: number | null,
    readonly apiVersion: number,
    message: string,
  ) {
    super(message);
  }
}

export class AgentOsTransportError extends Error {
  override readonly name = "AgentOsTransportError";

  constructor(override readonly cause: unknown) {
    super("Anneal API request failed without an HTTP response");
  }
}

export class CompletionRejectedError extends Error {
  override readonly name = "CompletionRejectedError";

  constructor(
    readonly status: number,
    readonly responseBody: string,
    readonly activityError: unknown | null,
  ) {
    super(`Anneal completion rejected with HTTP ${status}: ${responseBody}`);
  }
}

export class CompletionTransportError extends Error {
  override readonly name = "CompletionTransportError";

  constructor(override readonly cause: unknown) {
    super("Anneal completion request failed twice without an HTTP response");
  }
}

/**
 * Read a 409 body as the contract-mismatch refusal the control plane composes,
 * or null when it is any other refusal.
 *
 * Every field name checked here belongs to the declared refusal, so this
 * process recognises the mismatch by the same value the API produced rather
 * than by a shape restated on this side. A body that is not that refusal — a
 * different reason, or a malformed one — is not the named compatibility
 * result, and the caller surfaces the original response error through the
 * ordinary claim-loop path.
 */
export const decodeContractMismatchRefusal = (
  responseBody: string,
): MechanicalContractMismatchRefusal | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const refusal = parsed as Record<string, unknown>;
  if (refusal.code !== MECHANICAL_CONTRACT_MISMATCH_CODE) return null;
  if (typeof refusal.error !== "string" || typeof refusal.expectedVersion !== "number") return null;
  if (typeof refusal.receivedVersion !== "number" && refusal.receivedVersion !== null) return null;
  return {
    error: refusal.error,
    reason: MECHANICAL_CONTRACT_MISMATCH_CODE,
    code: MECHANICAL_CONTRACT_MISMATCH_CODE,
    expectedVersion: refusal.expectedVersion,
    receivedVersion: refusal.receivedVersion,
  };
};

const jsonHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const isFetchTransportError = (error: unknown): boolean => error instanceof TypeError
  || error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");

export const makeAgentOsClient = (config: ExecutorConfig, fetchImpl: typeof fetch = fetch) => {
  const request = async (
    path: string,
    init: { method: string; token: string; body?: unknown },
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(`${config.apiUrl}${path}`, {
        method: init.method,
        headers: jsonHeaders(init.token),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(config.apiTimeoutMs),
      });
    } catch (error: unknown) {
      if (isFetchTransportError(error)) throw new AgentOsTransportError(error);
      throw error;
    }
    if (!response.ok && response.status !== 204) {
      throw new AgentOsResponseError(response.status, await response.text());
    }
    return response;
  };

  const claim = async (): Promise<MechanicalClaim | null> => {
    let response: Response;
    try {
      response = await request("/runner/tasks/claim", {
        method: "POST",
        token: config.executorToken,
        body: {
          runnerId: config.runnerId,
          leaseSeconds: config.leaseSeconds,
          contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
        },
      });
    } catch (error: unknown) {
      if (error instanceof AgentOsResponseError && error.status === 409) {
        const refusal = decodeContractMismatchRefusal(error.responseBody);
        if (refusal) {
          throw new MechanicalContractMismatchError(refusal.receivedVersion, refusal.expectedVersion, refusal.error);
        }
      }
      throw error;
    }
    return response.status === 204 ? null : await response.json() as MechanicalClaim;
  };

  const start = async (claimed: MechanicalClaim): Promise<void> => {
    await request(`/runner/runs/${claimed.run.id}/start`, {
      method: "POST",
      token: config.executorToken,
      body: {
        runnerId: config.runnerId,
        fencingToken: claimed.fencingToken,
        adapterVersion: "merge-executor-v1",
        cliVersion: "merge-executor-v1",
        // No workspace exists, and none may: this process provisions nothing.
        workspacePath: null,
        manifest: { executionMode: "mechanical", childProcessCount: 0 },
      },
    });
  };

  const heartbeat = async (claimed: MechanicalClaim): Promise<MechanicalHeartbeat> => {
    const response = await request(`/runner/runs/${claimed.run.id}/heartbeat`, {
      method: "POST",
      token: config.executorToken,
      body: {
        runnerId: config.runnerId,
        fencingToken: claimed.fencingToken,
        leaseSeconds: config.leaseSeconds,
        processAlive: true,
        lastProgressEventAt: null,
        inFlightTool: null,
      },
    });
    if (response.status === 204) return { cancellation: null, mechanicalCancellationPolicy: null };
    const payload = await response.json() as {
      cancellation?: MechanicalCancellation | null;
      mechanicalCancellationPolicy?: string;
    };
    return {
      cancellation: payload.cancellation ?? null,
      mechanicalCancellationPolicy: payload.mechanicalCancellationPolicy === "refused" ? "refused" : null,
    };
  };

  const acknowledgeCancellation = async (
    claimed: MechanicalClaim,
    cancellation: MechanicalCancellation,
  ): Promise<void> => {
    await request(`/runner/runs/${claimed.run.id}/cancel/acknowledge`, {
      method: "POST",
      token: config.executorToken,
      body: {
        runnerId: config.runnerId,
        fencingToken: claimed.fencingToken,
        requestId: cancellation.requestId,
      },
    });
  };

  const readChain = async (claimed: MechanicalClaim, chainIndex: number): Promise<ChainEnvelope> => {
    const response = await request(`/session/runs/${claimed.run.id}/chain/steps/${chainIndex}/activity`, {
      method: "GET",
      token: claimed.sessionToken,
    });
    return await response.json() as ChainEnvelope;
  };

  const readOwnIntents = async (claimed: MechanicalClaim, chainIndex: number): Promise<IntentRecord[]> => {
    const response = await request(`/session/runs/${claimed.run.id}/chain/steps/${chainIndex}/activity`, {
      method: "GET",
      token: claimed.sessionToken,
    });
    const payload = await response.json() as { records?: Array<{ id: string; payload: Record<string, unknown> | null }> };
    return (payload.records ?? []).flatMap((record) => {
      const metadata = record.payload;
      if (!metadata || metadata.kind !== "mergeIntegrator.intent") return [];
      const { idempotencyKey, prNumber, headSha, authorizationActivityId } = metadata as Record<string, unknown>;
      if (typeof idempotencyKey !== "string" || typeof prNumber !== "number") return [];
      if (typeof headSha !== "string" || typeof authorizationActivityId !== "string") return [];
      return [{ activityId: record.id, idempotencyKey, prNumber, headSha, authorizationActivityId }];
    });
  };

  const writeActivity = async (
    claimed: MechanicalClaim,
    body: string,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    await request(`/session/runs/${claimed.run.id}/activity`, {
      method: "POST",
      token: claimed.sessionToken,
      body: { fencingToken: claimed.fencingToken, actorId: config.runnerId, body, metadata },
    });
  };

  const writeOutput = async (claimed: MechanicalClaim, kind: string, body: string): Promise<void> => {
    await request(`/session/runs/${claimed.run.id}/output`, {
      method: "PUT",
      token: claimed.sessionToken,
      body: { fencingToken: claimed.fencingToken, kind, body },
    });
  };

  /**
   * Every *executed* contract ends the run SUCCESS — a recorded stop is a
   * completed execution of the decision table, not a failure. FAILURE is
   * reserved for crashes, so the control plane's automatic retry stays keyed on
   * "the process died", never on "the merge was refused".
   */
  const complete = async (
    claimed: MechanicalClaim,
    completion: { succeeded: boolean; outcome: MergeOutcome | null; failureReason?: string },
    redact: (value: unknown) => string,
  ): Promise<void> => {
    const body = {
      runnerId: config.runnerId,
      fencingToken: claimed.fencingToken,
      outcome: completion.succeeded
        ? { case: "succeeded" }
        // A crashed executor persisted no merge result, which is exactly the
        // output its step requires; the control plane may attempt it again.
        : {
          case: "required-output-unsatisfied",
          reason: completion.failureReason ?? "merge executor crashed",
        },
      exitCode: completion.succeeded ? 0 : 1,
      pushStatus: "NOT_REQUESTED",
      cleanupStatus: "SUCCEEDED",
      workspaceRetained: false,
    };
    const attempt = async (): Promise<void> => {
      await request(`/runner/runs/${claimed.run.id}/complete`, {
        method: "POST",
        token: config.executorToken,
        body,
      });
    };
    const rejectCompletion = async (error: AgentOsResponseError): Promise<never> => {
      const responseBody = redact(error.responseBody);
      let activityError: unknown | null = null;
      await writeActivity(
        claimed,
        `Mechanical completion rejected with HTTP ${error.status}: ${responseBody}`,
        {
          kind: "mergeExecutor.completionRejected",
          schemaVersion: 1,
          status: error.status,
          responseBody,
        },
      ).catch((error: unknown) => { activityError = error; });
      throw new CompletionRejectedError(error.status, responseBody, activityError);
    };
    try {
      await attempt();
    } catch (firstError: unknown) {
      if (firstError instanceof AgentOsResponseError) {
        await rejectCompletion(firstError);
      }
      if (!(firstError instanceof AgentOsTransportError)) throw firstError;
      try {
        await attempt();
      } catch (secondError: unknown) {
        if (secondError instanceof AgentOsResponseError) {
          await rejectCompletion(secondError);
        }
        if (secondError instanceof AgentOsTransportError) throw new CompletionTransportError(secondError.cause);
        throw secondError;
      }
    }
  };

  return { claim, start, heartbeat, acknowledgeCancellation, readChain, readOwnIntents, writeActivity, writeOutput, complete };
};
