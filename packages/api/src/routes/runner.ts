import { RunnerKind } from "@anneal/db";
import {
  SESSION_EVENTS_REQUEST_MAX_BYTES,
  SESSION_EVENTS_REQUEST_TOO_LARGE_CODE,
} from "@anneal/db/session-event-limits";
import { z } from "zod";

import {
  fence,
  id,
  PayloadTooLargeError,
  readBoundedJson,
  readJson,
  refusal,
  refusalJson,
} from "./support.js";
import type { RouteApp, RouteDeps } from "./support.js";
import { FAILURE_REASON_LIMIT, failureReasonText } from "../failure-reason.js";
import { recordRunnerBackendReport } from "../runner-backend-health.js";
import { publishReclaimIntents, recordReclaimOutcomes, acknowledgeReclaimSalvage } from "../workspace-reclaim.js";
import { createArchivedRunNoticeScheduler, reconcileDatabaseRuns, ReconciliationMaintenanceError } from "../reconcile.js";
import { claimInput, claimRun } from "../run-claim.js";
import { completeRun, completionInput, worktreeContainmentViolationsInput } from "../run-completion.js";
import { acknowledgeCancellation } from "../run-cancel.js";
import {
  appendRunEvents,
  eventsInput,
  heartbeatInput,
  heartbeatRun,
  leaseIndependentCleanupInput,
  mechanicalStartInput,
  oversizedEventRefusal,
  publicationInput,
  publishRun,
  recordRunCleanup,
  startInput,
  startRun,
} from "../run-lifecycle.js";

// The runner's inventory of its own root. `directories` are bare names, never
// paths: this API refuses to hold an opinion about a filesystem it does not
// own, and a name is all the ownership predicate needs.
const reclaimInventoryInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  workspaceRoot: z.string().trim().min(1).max(500),
  directories: z.array(z.string().trim().min(1).max(200).refine(
    (value) => !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..",
    { message: "directory must be a bare name inside the runner's workspace root" },
  )).max(5000),
});
const reclaimReportInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  workspaceRoot: z.string().trim().min(1).max(500),
  results: z.array(z.object({
    runId: id,
    outcome: z.enum(["REMOVED", "REFUSED", "FAILED"]),
    failureReason: failureReasonText(FAILURE_REASON_LIMIT).nullable().optional(),
  })).max(5000),
});
const reclaimSalvageInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  runId: id,
  pushedBranch: z.string().trim().min(1).max(255),
});
const cancelAcknowledgeInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  requestId: z.string().trim().min(1).max(160),
  workspacePath: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  baseSha: z.string().min(1).optional(),
  worktreeContainmentViolations: worktreeContainmentViolationsInput.optional(),
});
const preflightInput = z.object({
  runner: z.nativeEnum(RunnerKind),
  ok: z.boolean(),
  cliVersion: z.string().nullable().optional(),
  authMode: z.string().nullable().optional(),
  capabilities: z.record(z.string(), z.unknown()),
  // Written straight onto every blocked task as its `failureReason` (and kept
  // as the circuit reason those rows are later matched by), so it is bounded
  // here, where both writes read the same already-truncated string.
  error: failureReasonText(FAILURE_REASON_LIMIT).nullable().optional(),
});
const runnerAvailabilityInput = z.object({
  // Optional only for the API-first half of a rolling deployment. A runner
  // without an identity may still report binary health, but cannot receive a
  // coordinated full-preflight retry directive.
  runnerId: z.string().trim().min(1).max(120).optional(),
  runner: z.nativeEnum(RunnerKind),
  binary: z.string().trim().min(1).max(500),
  available: z.boolean(),
  resolvedPath: z.string().trim().min(1).max(2000).nullable(),
}).superRefine((body, context) => {
  if (body.available !== (body.resolvedPath !== null)) {
    context.addIssue({ code: "custom", message: "available and resolvedPath disagree" });
  }
});

type RunnerRouteDeps = {
  noteArchivedQueuedRunsOnClaim: ReturnType<typeof createArchivedRunNoticeScheduler>;
  preflightRecoveryLeases: Map<RunnerKind, number>;
  preflightRecoveryIntervalMs: number;
};

export const registerRunnerRoutes = (
  app: RouteApp,
  deps: RouteDeps,
  runnerDeps: RunnerRouteDeps,
): (() => void) => {
  const {
    db,
    options,
    releaseChainLease,
    runners,
    appendFencedActivity,
  } = deps;
  const {
    noteArchivedQueuedRunsOnClaim,
    preflightRecoveryLeases,
    preflightRecoveryIntervalMs,
  } = runnerDeps;

  app.post("/runner/availability", async (context) => {
    const body = await readJson(context.req.raw, runnerAvailabilityInput);
    const now = new Date();
    const state = await recordRunnerBackendReport(db, { kind: "availability", ...body }, now);
    const lastPreflightAt = state.lastPreflightAt?.getTime() ?? 0;
    const currentLease = preflightRecoveryLeases.get(body.runner) ?? 0;
    const revalidatePreflight = body.available
      && body.runnerId !== undefined
      && state.circuitOpen
      && now.getTime() - lastPreflightAt >= preflightRecoveryIntervalMs
      && currentLease <= now.getTime();
    if (revalidatePreflight) {
      preflightRecoveryLeases.set(body.runner, now.getTime() + preflightRecoveryIntervalMs);
    }
    return context.json({ ...state, revalidatePreflight });
  });

  app.post("/runner/preflight", async (context) => {
    const body = await readJson(context.req.raw, preflightInput);
    const state = await recordRunnerBackendReport(db, { kind: "preflight", ...body });
    preflightRecoveryLeases.delete(body.runner);
    return context.json(state);
  });

  /**
   * Workspace GC, runner-owned (issue #115).
   *
   * The runner reports what is in its root; the API answers with the subset it
   * has published a reclaim intent for. The control plane never reads or writes
   * that filesystem — this route only marks rows and returns names — so a
   * database pointed at the wrong root can no longer delete anything. An old
   * runner that never calls this simply leaves its directories in place, which
   * is the failure direction this design chooses on purpose.
   */
  app.post("/runner/workspaces/reclaimable", async (context) => {
    const body = await readJson(context.req.raw, reclaimInventoryInput);
    const retention = Number.parseInt(process.env.RUNNER_FAILED_WORKSPACE_RETENTION ?? "2", 10);
    const plan = await publishReclaimIntents(db, body, Number.isFinite(retention) ? retention : 2);
    return context.json(plan);
  });

  app.post("/runner/workspaces/reclaimed", async (context) => {
    const body = await readJson(context.req.raw, reclaimReportInput);
    return context.json(await recordReclaimOutcomes(db, body));
  });

  app.post("/runner/workspaces/salvaged", async (context) => {
    const body = await readJson(context.req.raw, reclaimSalvageInput);
    const repair = await acknowledgeReclaimSalvage(db, body);
    return repair === false
      ? context.json({ error: "Salvage publication is not authorized by an open reclaim intent" }, 409)
      : repair === "already-started"
        ? context.json({ error: "Salvage is durable, but the replacement already started from its prior base" }, 409)
        : context.json({ ok: true, replacementRepair: repair });
  });

  app.post("/runner/tasks/claim", async (context) => {
    const body = await readJson(context.req.raw, claimInput);
    const principal = context.get("principal");
    // §D-P1 rule 3. `runnerId` is a label the caller writes about itself; the
    // bearer it presented is the only thing that can carry mechanical authority.
    const claimantClass = principal.kind === "merge-executor" ? "merge-executor" : "runner";
    const now = new Date();
    runners.note(body.runnerId, body, now);
    await options.ownership.assertHeld();
    try {
      await reconcileDatabaseRuns(db, now, releaseChainLease);
    } catch (error: unknown) {
      if (!(error instanceof ReconciliationMaintenanceError)) throw error;
      console.error("Runner claim reconciliation maintenance failed after commit", {
        reconciledAt: error.reconciledAt.toISOString(),
        failures: error.failures.map((failure) => ({
          target: failure.target,
          phase: failure.phase,
          error: failure.error instanceof Error ? failure.error.message : String(failure.error),
        })),
      });
    }
    await noteArchivedQueuedRunsOnClaim(now).catch((error: unknown) => console.error("Archived-run notice failed", error));
    const claimed = await claimRun(db, {
      body,
      claimantClass,
      now,
      specificationReader: options.specificationReader ?? null,
      signal: context.req.raw.signal,
    });
    if (claimed && "error" in claimed) {
      // The refusal value is the response body. Whatever evidence a refusal
      // carries — a contract mismatch carries four fields — was decided where
      // the refusal was composed, so this route adds none of its own.
      const { error, ...detail } = claimed;
      return refusalJson(context, refusal("conflict", error, detail));
    }
    return claimed ? context.json(claimed) : context.body(null, 204);
  });

  app.post("/runner/runs/:runId/start", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    const body = principal.kind === "merge-executor"
      ? { ...await readJson(context.req.raw, mechanicalStartInput), promptHash: null }
      : await readJson(context.req.raw, startInput);
    const result = await startRun(db, { runId, body });
    return "message" in result ? refusalJson(context, result) : context.json(result);
  });

  app.post("/runner/runs/:runId/heartbeat", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, heartbeatInput);
    const result = await heartbeatRun(db, { runId, body, noteRunner: runners.note });
    return "message" in result ? refusalJson(context, result) : context.json(result);
  });

  app.post("/runner/runs/:runId/cancel/acknowledge", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, cancelAcknowledgeInput);
    const result = await acknowledgeCancellation(db, runId, body, releaseChainLease);
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
  });

  app.post("/runner/runs/:runId/publication", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, publicationInput);
    const result = await publishRun(db, { runId, body });
    return "message" in result ? refusalJson(context, result) : context.json(result);
  });

  app.post("/runner/runs/:runId/cleanup", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, leaseIndependentCleanupInput);
    const result = await recordRunCleanup(db, { runId, body });
    return "message" in result ? refusalJson(context, result) : context.json(result);
  });

  // The one route whose body a remote process sizes, and the largest writer in
  // the database. Both caps are refused before any database work: the whole
  // body while it streams, then the single event that exceeds the per-event cap
  // — named by index, so the runner drops that event and resends the rest
  // instead of retrying a batch that can never be accepted.
  app.post("/runner/runs/:runId/events", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    let body;
    try {
      body = await readBoundedJson(context.req.raw, eventsInput, SESSION_EVENTS_REQUEST_MAX_BYTES);
    } catch (error) {
      if (!(error instanceof PayloadTooLargeError)) throw error;
      return refusalJson(context, refusal(
        "events-request-too-large",
        `Session event request body exceeds the ${SESSION_EVENTS_REQUEST_MAX_BYTES} byte cap`,
        { code: SESSION_EVENTS_REQUEST_TOO_LARGE_CODE, limitBytes: SESSION_EVENTS_REQUEST_MAX_BYTES },
      ));
    }
    const oversized = oversizedEventRefusal(body.events);
    if (oversized) return refusalJson(context, oversized);
    const result = await appendRunEvents(db, { runId, body });
    return "message" in result ? refusalJson(context, result) : context.json(result);
  });

  app.post("/runner/runs/:runId/activity", appendFencedActivity);

  // Main registered completion after every /session/* route. Defer it so app.ts
  // can invoke the runner tail before the session tail and preserve that order.
  return (): void => {
    app.post("/runner/runs/:runId/complete", async (context) => {
      const runId = id.parse(context.req.param("runId"));
      const body = await readJson(context.req.raw, completionInput);
      const principal = context.get("principal");
      const result = await completeRun(db, {
        runId,
        body,
        claimantClass: principal.kind === "merge-executor" ? "merge-executor" : "runner",
      }, releaseChainLease);
      if ("message" in result) return refusalJson(context, result);
      await options.ownership.assertHeld();
      // Nothing is deleted here, or anywhere else in this process. The runner
      // removed its own workspace before it called /complete and reported the
      // result in `cleanupStatus`; if that failed, the directory is offered back
      // to its owner through /runner/workspaces/reclaimable. This route used to
      // delete on the API's behalf — first the whole root, then one run's
      // directory — and API-side deletion is exactly what issue #115 removes.
      return context.json(result);
    });
  };
};
