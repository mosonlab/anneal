import { statfs } from "node:fs/promises";

import { parseRunOutputEvidence, type CleanupStatus, type RunOutcome, type RunOutputEvidence } from "@anneal/db";
import { SESSION_EVENT_PAYLOAD_TOO_LARGE_CODE } from "@anneal/db/session-event-limits";
import type { ClaimContract } from "@anneal/db/claim-contract";

import type { RunnerConfig, RunnerKind } from "./config.js";

export type { CleanupStatus, FailureClass, PrHandoffOutput, RunOutputEvidence } from "@anneal/db";
/** The only repository dependency-provisioning policies understood by a runner. */
export const DEPENDENCY_PROVISIONING_VALUES = ["NONE", "NPM_CI"] as const;
export type DependencyProvisioning = (typeof DEPENDENCY_PROVISIONING_VALUES)[number];

export const isDependencyProvisioning = (value: unknown): value is DependencyProvisioning =>
  typeof value === "string"
  && (DEPENDENCY_PROVISIONING_VALUES as readonly string[]).includes(value);

export type CancellationRequest = { requestId: string; reason: string; requestedAt: string };
type HeartbeatResult = { ok: boolean; cancellation: CancellationRequest | null };

export class ControlPlaneError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** The parsed refusal body, when the API answered with one. */
  readonly detail: Record<string, unknown> | undefined;

  constructor(status: number, responseBody: string, code?: string, detail?: Record<string, unknown>) {
    super(`Anneal API ${status}: ${responseBody}`);
    this.name = "ControlPlaneError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** The typed error for a control-plane refusal, parsed once from its body. */
export const controlPlaneErrorFor = (status: number, responseBody: string): ControlPlaneError => {
  let detail: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (parsed !== null && typeof parsed === "object") detail = parsed as Record<string, unknown>;
  } catch { /* non-JSON error */ }
  const code = typeof detail?.["code"] === "string" ? detail["code"] : undefined;
  return new ControlPlaneError(status, responseBody, code, detail);
};

/**
 * The batch index of the one event an events append was refused for, or null
 * when this failure is about something else.
 *
 * The API names the event rather than failing the batch precisely so the runner
 * can lose that one event and keep the rest: an unnamed 413 would sit at the
 * head of an ordered queue that only advances on success.
 */
export const oversizedEventIndex = (error: unknown): number | null => {
  if (!(error instanceof ControlPlaneError)) return null;
  if (error.status !== 413 || error.code !== SESSION_EVENT_PAYLOAD_TOO_LARGE_CODE) return null;
  const index = error.detail?.["eventIndex"];
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : null;
};

/** The runner's domain verdict for whether its current Run authority remains. */
export type Authority =
  | { held: true }
  | { held: false; reason: "revoked" }
  | { held: false; reason: "waiting-inbox" }
  | { held: false; reason: "cancelled"; request: CancellationRequest };

export const authorityFor = (error: unknown): Authority => {
  if (!(error instanceof ControlPlaneError) || error.status !== 409) return { held: true };
  return error.code === "WAITING_INBOX"
    ? { held: false, reason: "waiting-inbox" }
    : { held: false, reason: "revoked" };
};

const authorityAfterHeartbeat = (result: HeartbeatResult): Authority =>
  result.cancellation
    ? { held: false, reason: "cancelled", request: result.cancellation }
    : { held: true };

/** Startup may retry transport failures and control-plane 5xx responses only. */
export const retriableStartupError = (error: unknown): boolean =>
  !(error instanceof ControlPlaneError) || error.status >= 500;

/**
 * The claim payload, declared once in `@anneal/db` and produced there by the
 * API's `claimRun`. Aliased rather than mirrored: this used to be a hand-kept
 * copy of the widest cross-process contract in the system, and only a database
 * test stood between the two copies drifting apart.
 */
export type ClaimedTask = ClaimContract;

/**
 * The claimed Run identity a session is opened for: the fence every
 * runner-principal write carries, and the session principal the two
 * session-authenticated routes replace it with.
 */
export type RunSessionClaim = Pick<ClaimedTask, "fencingToken" | "sessionToken"> & {
  run: Pick<ClaimedTask["run"], "id">;
};

export type SessionEventPayload = {
  seq: number;
  at?: string;
  source: "RUNNER" | "CLAUDE" | "CODEX" | "PI";
  type: string;
  providerEventId?: string | null;
  toolCallId?: string | null;
  payload: Record<string, unknown>;
};

const request = async (config: RunnerConfig, path: string, init: RequestInit): Promise<Response> => {
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    // Endpoint-specific credentials intentionally come last. Session routes
    // must replace the runner principal rather than sending runner auth.
    headers: { Authorization: `Bearer ${config.runnerToken}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(config.apiTimeoutMs),
  }).catch((error: unknown) => {
    // A connected-but-silent API is indistinguishable from a fast one until it
    // is too late: without this the runner can sit in `await` past its own
    // lease expiry, which is the same lost run the per-command timeout exists
    // to prevent, one layer up.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`Anneal API request timed out after ${config.apiTimeoutMs}ms: ${path}`);
    }
    throw error;
  });
  if (!response.ok && response.status !== 204) {
    throw controlPlaneErrorFor(response.status, await response.text());
  }
  return response;
};

type StatFs = (path: string) => Promise<{ bavail: number; bsize: number }>;
export type RunnerTelemetryBody = {
  daemonVersion: string;
  pollIntervalMs: number;
  workspaceRoot: string;
  diskFreeBytes?: number;
};

export const runnerTelemetryBody = async (config: RunnerConfig, readStats: StatFs = statfs): Promise<RunnerTelemetryBody> => {
  const base = {
    daemonVersion: config.daemonVersion,
    pollIntervalMs: config.pollIntervalMs,
    workspaceRoot: config.workspaceRoot,
  };
  try {
    const stats = await readStats(config.workspaceRoot);
    return { ...base, diskFreeBytes: stats.bavail * stats.bsize };
  } catch {
    // Telemetry must never stop the runner from claiming or heartbeating.
    return base;
  }
};

export const claimRequestBody = async (config: RunnerConfig, readStats: StatFs = statfs): Promise<Record<string, unknown>> => ({
  runnerId: config.runnerId,
  leaseSeconds: config.leaseSeconds,
  ...await runnerTelemetryBody(config, readStats),
  ...(config.servedKinds === null ? {} : { servedKinds: config.servedKinds }),
});

const claimTask = async (config: RunnerConfig): Promise<ClaimedTask | null> => {
  const response = await request(config, "/runner/tasks/claim", {
    method: "POST",
    body: JSON.stringify(await claimRequestBody(config)),
  });
  return response.status === 204 ? null : await response.json() as ClaimedTask;
};

const startRun = async (
  config: RunnerConfig,
  claim: RunSessionClaim,
  snapshot: RunStartSnapshot,
): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/start`, {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      fencingToken: claim.fencingToken,
      ...snapshot,
    }),
  });
};

const heartbeat = async (
  config: RunnerConfig,
  claim: RunSessionClaim,
  state: RunProgress,
): Promise<HeartbeatResult> => {
  const response = await request(config, `/runner/runs/${claim.run.id}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      fencingToken: claim.fencingToken,
      leaseSeconds: config.leaseSeconds,
      processAlive: state.processAlive,
      lastProgressEventAt: state.lastProgressEventAt?.toISOString() ?? null,
      inFlightTool: state.inFlightTool,
      eventQueueBytes: state.eventQueueBytes,
      ...await runnerTelemetryBody(config),
    }),
  });
  return response.json() as Promise<HeartbeatResult>;
};

const acknowledgeCancellation = async (
  config: RunnerConfig,
  claim: RunSessionClaim,
  cancellation: CancellationRequest,
  workspace?: { path: string; branch: string; baseSha: string } | null,
  containment: { worktreeContainmentViolations?: string[] } = {},
): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/cancel/acknowledge`, {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      fencingToken: claim.fencingToken,
      requestId: cancellation.requestId,
      ...(workspace ? { workspacePath: workspace.path, branch: workspace.branch, baseSha: workspace.baseSha } : {}),
      ...containment,
    }),
  });
};

export type SessionTaskOutput = {
  kind: string;
  body: string;
  commitSha: string;
  metadata?: Record<string, unknown>;
};

/** Persist a mechanically-authored deliverable through the Runner's existing
 * fenced control-plane transport. The script that derives the deliverable
 * never needs control-plane network access or session credentials. */
const persistSessionTaskOutput = async (
  config: RunnerConfig,
  claim: RunSessionClaim,
  output: SessionTaskOutput,
): Promise<void> => {
  await request(config, `/session/runs/${claim.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${claim.sessionToken}` },
    body: JSON.stringify({ fencingToken: claim.fencingToken, ...output }),
  });
};

/** Read the decided output evidence through the Run's session principal.
 * Completion is too late for recovery: by then the provider process and
 * workspace are gone. The runner judges nothing here -- the control plane
 * already decided satisfaction and the canonical PR handoff -- so this only
 * refuses a payload that is not the decided answer. */
const readSessionRunOutputEvidence = async (
  config: RunnerConfig,
  claim: RunSessionClaim,
): Promise<RunOutputEvidence | null> => {
  const response = await request(config, `/session/runs/${claim.run.id}/status`, {
    method: "GET",
    headers: { Authorization: `Bearer ${claim.sessionToken}` },
  });
  const payload = await response.json() as { task?: { outputEvidence?: unknown } | null };
  if (!payload.task) return null;
  try {
    return parseRunOutputEvidence(payload.task.outputEvidence);
  } catch (error: unknown) {
    throw new Error(
      `Anneal API returned an invalid task output status for Run ${claim.run.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

/** Durably acknowledge the exact ref immediately after git accepts the push.
 * Terminal completion is intentionally not the first write of this fact: PR
 * work, cleanup, or process loss may happen after publication. */
const recordPublishedBranch = async (
  config: RunnerConfig,
  claim: RunSessionClaim,
  pushedBranch: string,
): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/publication`, {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      fencingToken: claim.fencingToken,
      pushedBranch,
    }),
  });
};

/** Records cleanup after this runner has lost its live lease. The control plane
 * accepts this only from the recorded runner/fence for an expired or terminal
 * run; unlike completion, it carries no authority over run outcome. */
const recordLeaseIndependentCleanup = async (
  config: RunnerConfig,
  claim: RunSessionClaim,
  cleanup: RunCleanupReport,
): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/cleanup`, {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      fencingToken: claim.fencingToken,
      ...cleanup,
    }),
  });
};

const appendEvents = async (
  config: RunnerConfig,
  claim: RunSessionClaim,
  events: SessionEventPayload[],
  providerConversationId?: string | null,
): Promise<void> => {
  if (events.length === 0) return;
  await request(config, `/runner/runs/${claim.run.id}/events`, {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      fencingToken: claim.fencingToken,
      providerConversationId: providerConversationId ?? null,
      events,
    }),
  });
};

const appendActivity = async (
  config: RunnerConfig,
  claim: RunSessionClaim,
  body: string,
  metadata: Record<string, unknown> = {},
): Promise<void> => {
  if (!body) return;
  await request(config, `/runner/runs/${claim.run.id}/activity`, {
    method: "POST",
    body: JSON.stringify({
      fencingToken: claim.fencingToken,
      actorId: config.runnerId,
      body,
      metadata,
    }),
  });
};

export type Completion = {
  /** What this Run ended as. The control plane reads its verdict off this and
   *  derives nothing from the exit facts below. */
  outcome: RunOutcome;
  /** Exit facts, reported as the process gave them. They are persisted as
   *  evidence and are never re-read as a verdict; a Run that succeeded through
   *  `regression-mechanically-settled` still reports the exit code it had. */
  exitCode: number | null;
  signal?: string | null;
  terminationReason?: string | null;
  branch?: string | null;
  /** The ref actually handed to `git push`, which is not always `branch`: a WIP
   *  salvage pushes a per-run branch while `branch` still reports the
   *  workspace's. Declared here rather than left to ride along on a spread, so
   *  the wire contract is visible where the payload is defined. */
  pushedBranch?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  /** The salvage commit's first parent, sent only when this Run salvaged. The
   *  control plane hands it, with `headSha`, to the next Run of the task. */
  salvageParentSha?: string | null;
  output?: string | null;
  pushStatus?: "NOT_REQUESTED" | "PENDING" | "SUCCEEDED" | "FAILED";
  pushRemote?: string | null;
  pushError?: string | null;
  pullRequestUrl?: string | null;
  pullRequestNumber?: number | null;
  deliveryInstructions?: string | null;
  cleanupStatus: CleanupStatus;
  cleanupFailureReason?: string | null;
  workspaceRetained: boolean;
  /** Absolute worktree paths outside the Run workspace observed at completion.
   *  This is report-only evidence; omission or an empty list is compliant and
   *  does not affect the API's terminal outcome classification. */
  worktreeContainmentViolations?: string[];
};

const completeRun = async (
  config: RunnerConfig,
  claim: RunSessionClaim,
  completion: Completion,
): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/complete`, {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, fencingToken: claim.fencingToken, ...completion }),
  });
};

export type ReclaimOffer = {
  runId: string;
  workspacePath: string | null;
  /** Required wire evidence: null is ordinary, a SHA forbids publication. */
  pinnedBaseSha: string | null;
  taskId?: string | null;
  runNumber?: number;
  baseSha?: string | null;
  pushedBranch?: string | null;
};
export type ReclaimPlan = {
  /** Directories in the reported inventory this runner may remove. */
  reclaim: ReclaimOffer[];
  /**
   * Intents still open for directories the inventory did not list. Removal
   * happens before the report, so a crash in between leaves an intent no later
   * inventory can mention; these are how the runner settles those.
   */
  verify: ReclaimOffer[];
  keep: Array<{ directory: string; reason: string }>;
};
export type ReclaimResult = {
  runId: string;
  outcome: "REMOVED" | "REFUSED" | "FAILED";
  failureReason?: string;
};

/**
 * Asks the control plane which of this runner's own directories it has
 * published a reclaim intent for (issue #115).
 *
 * `null` means the API does not speak this protocol — an older build with no
 * such route. That is not an error worth failing a poll over: the runner keeps
 * its directories, which leaks disk and deletes nothing, and the sweep succeeds
 * again the moment the API is upgraded.
 */
const fetchReclaimPlan = async (
  config: RunnerConfig,
  inventory: { runnerId: string; workspaceRoot: string; directories: string[] },
): Promise<ReclaimPlan | null> => {
  const response = await request(config, "/runner/workspaces/reclaimable", {
    method: "POST",
    body: JSON.stringify(inventory),
  }).catch((error: unknown) => {
    if (error instanceof ControlPlaneError && error.status === 404) return null;
    throw error;
  });
  return response ? await response.json() as ReclaimPlan : null;
};

const reportReclaimOutcomes = async (
  config: RunnerConfig,
  report: { runnerId: string; workspaceRoot: string; results: ReclaimResult[] },
): Promise<void> => {
  await request(config, "/runner/workspaces/reclaimed", {
    method: "POST",
    body: JSON.stringify(report),
  }).catch((error: unknown) => {
    if (error instanceof ControlPlaneError && error.status === 404) return null;
    throw error;
  });
};

const recordReclaimPublication = async (
  config: RunnerConfig,
  body: { runnerId: string; runId: string; pushedBranch: string },
): Promise<void> => {
  await request(config, "/runner/workspaces/salvaged", {
    method: "POST",
    body: JSON.stringify(body),
  });
};

const reportPreflight = async (
  config: RunnerConfig,
  runner: RunnerKind,
  result: PreflightReport,
): Promise<void> => {
  await request(config, "/runner/preflight", {
    method: "POST",
    body: JSON.stringify({ runner, ...result }),
  });
};

const reportCliAvailability = async (
  config: RunnerConfig,
  availability: CliAvailabilityReport,
): Promise<{ revalidatePreflight: boolean }> => {
  const response = await request(config, "/runner/availability", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, ...availability }),
  });
  // The established endpoint contract did not require a response body. During
  // rollout, an older control plane (and narrow protocol fixtures) may still
  // acknowledge the report with an empty 2xx response. Only a non-empty body
  // carries the additive recovery directive; malformed JSON still fails.
  const responseBody = await response.text();
  if (!responseBody.trim()) return { revalidatePreflight: false };
  const body = JSON.parse(responseBody) as { revalidatePreflight?: boolean };
  return { revalidatePreflight: body.revalidatePreflight === true };
};

/** The launch facts a Run is started with. */
export type RunStartSnapshot = Record<string, unknown> & { promptHash: string };

/** What a renewal reports about the provider process it is renewing for. */
export type RunProgress = {
  processAlive: boolean;
  lastProgressEventAt: Date | null;
  inFlightTool: Record<string, unknown> | null;
  /** Undelivered session-event bytes this Run holds in memory, for observability. */
  eventQueueBytes: number;
};

/** Cleanup recorded after this runner has lost its live lease. */
export type RunCleanupReport = {
  cleanupStatus: CleanupStatus;
  cleanupFailureReason?: string;
  workspaceRetained: boolean;
};

/**
 * One claimed Run's conversation with the control plane.
 *
 * The configuration and the fenced claim are bound once, when the session is
 * opened, so no caller repeats them and none of them can send a write under the
 * wrong fence. Route paths, fencing envelopes, session credentials, timeout
 * translation and error decoding stay inside the adapter that implements this;
 * a caller sees the ten things a Run does and one `Authority` verdict.
 */
export interface RunSession {
  /** Publish the launch manifest that makes the Run durable. */
  start(snapshot: RunStartSnapshot): Promise<void>;
  /** Renew the lease and report whether this runner still owns the Run. */
  heartbeat(progress: RunProgress): Promise<Authority>;
  /** Append one operator-visible activity line. An empty body is a no-op. */
  note(body: string, metadata?: Record<string, unknown>): Promise<void>;
  /** Append a batch of Session events. An empty batch is a no-op. */
  emit(events: SessionEventPayload[], providerConversationId?: string | null): Promise<void>;
  /** Persist a mechanically-authored deliverable under the Run's session principal. */
  publishOutput(output: SessionTaskOutput): Promise<void>;
  /** Read the decided output evidence under the Run's session principal. */
  outputStatus(): Promise<RunOutputEvidence | null>;
  /** Durably acknowledge the exact ref immediately after git accepts the push. */
  publishBranch(pushedBranch: string): Promise<void>;
  /** Record cleanup that carries no authority over the Run's outcome. */
  recordCleanup(cleanup: RunCleanupReport): Promise<void>;
  /** Settle a cancellation request against the workspace it stopped. */
  acknowledgeCancellation(
    cancellation: CancellationRequest,
    workspace?: { path: string; branch: string; baseSha: string } | null,
    containment?: { worktreeContainmentViolations?: string[] },
  ): Promise<void>;
  /** Write the Run's terminal outcome. */
  finish(completion: Completion): Promise<void>;
}

/**
 * The runner-to-control-plane seam for everything outside one Run: claiming
 * work, sweeping workspaces, and reporting what this daemon can execute. The
 * configuration is bound once here too, and `openRun` is how a claim becomes
 * the session above.
 */
export interface ControlPlane {
  claim(): Promise<ClaimedTask | null>;
  openRun(claim: RunSessionClaim): RunSession;
  fetchReclaimPlan(
    inventory: { runnerId: string; workspaceRoot: string; directories: string[] },
  ): Promise<ReclaimPlan | null>;
  reportReclaimOutcomes(report: { runnerId: string; workspaceRoot: string; results: ReclaimResult[] }): Promise<void>;
  recordReclaimPublication(publication: { runId: string; pushedBranch: string }): Promise<void>;
  reportPreflight(runner: RunnerKind, result: PreflightReport): Promise<void>;
  reportCliAvailability(availability: CliAvailabilityReport): Promise<{ revalidatePreflight: boolean }>;
}

export type PreflightReport = {
  ok: boolean;
  cliVersion?: string | null;
  authMode?: string | null;
  capabilities: Record<string, unknown>;
  error?: string | null;
};

export type CliAvailabilityReport = {
  runner: RunnerKind;
  binary: string;
  available: boolean;
  resolvedPath: string | null;
};

/** The HTTP implementation of one claimed Run's session. */
export const openRunSession = (config: RunnerConfig, claim: RunSessionClaim): RunSession => Object.freeze({
  start: (snapshot) => startRun(config, claim, snapshot),
  heartbeat: async (progress) => authorityAfterHeartbeat(await heartbeat(config, claim, progress)),
  note: (body, metadata) => appendActivity(config, claim, body, metadata),
  emit: (events, providerConversationId) => appendEvents(config, claim, events, providerConversationId),
  publishOutput: (output) => persistSessionTaskOutput(config, claim, output),
  outputStatus: () => readSessionRunOutputEvidence(config, claim),
  publishBranch: (pushedBranch) => recordPublishedBranch(config, claim, pushedBranch),
  recordCleanup: (cleanup) => recordLeaseIndependentCleanup(config, claim, cleanup),
  acknowledgeCancellation: (cancellation, workspace, containment) =>
    acknowledgeCancellation(config, claim, cancellation, workspace, containment),
  finish: (completion) => completeRun(config, claim, completion),
} satisfies RunSession);

/** The HTTP implementation of the runner-wide seam. */
export const openControlPlane = (config: RunnerConfig): ControlPlane => Object.freeze({
  claim: () => claimTask(config),
  openRun: (claim) => openRunSession(config, claim),
  fetchReclaimPlan: (inventory) => fetchReclaimPlan(config, inventory),
  reportReclaimOutcomes: (report) => reportReclaimOutcomes(config, report),
  recordReclaimPublication: (publication) => recordReclaimPublication(config, {
    runnerId: config.runnerId,
    ...publication,
  }),
  reportPreflight: (runner, result) => reportPreflight(config, runner, result),
  reportCliAvailability: (availability) => reportCliAvailability(config, availability),
} satisfies ControlPlane);
