import {
  Prisma,
  RunnerKind,
  type PrismaClient,
} from "@anneal/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

import {
  authenticate,
  authenticateRevalidationCancellationReplay,
  principalMayAccess,
} from "./auth.js";
import { LOOPBACK_BROWSER_ORIGINS, originMayReachHandlers } from "./local-origin.js";
import { readMergeLeaseHolderAdapter, releaseMergeLease } from "./merge-lease.js";
import { preflightRepository } from "./onboarding-preflight.js";
import { createArchivedRunNoticeScheduler } from "./reconcile.js";
import { refusalFor } from "./refusal.js";
import { revalidationCancelRequestId } from "./revalidation.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerGoalsRoutes } from "./routes/goals.js";
import { registerInboxRoutes } from "./routes/inbox.js";
import { registerMergeLeaseRoutes } from "./routes/merge-lease.js";
import { registerRunnerRoutes } from "./routes/runner.js";
import { registerSessionRoutes } from "./routes/session.js";
import { registerStaffingProfileRoutes } from "./routes/staffing-profiles.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerTasksRoutes } from "./routes/tasks.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { createRunnerRegistry } from "./runners.js";
import { defaultProjectBootstrapLoaders } from "./project-bootstrap.js";
import {
  createAppendFencedActivityHandler,
  refusal,
  refusalJson,
  type AppEnvironment,
  type LiveAppOptions,
  type RouteDeps,
} from "./routes/support.js";
import { SerializableTransactionExhaustedError } from "./transaction.js";

export type { LiveAppOptions } from "./routes/support.js";

const isPublic = (path: string, method: string): boolean =>
  path === "/" || path === "/health" || path === "/version" || method === "OPTIONS"
  || method === "POST" && /^\/hooks\/templates\/[^/]+$/.test(path);

export const createApp = (db: PrismaClient, options: LiveAppOptions): Hono<AppEnvironment> => {
  const app = new Hono<AppEnvironment>();
  const releaseChainLease = options.releaseMergeLease ?? releaseMergeLease;
  const noteArchivedQueuedRunsOnClaim = createArchivedRunNoticeScheduler(db);
  const runners = options.runnerRegistry ?? createRunnerRegistry();
  // Authentication circuits are global backend state, so only one daemon must
  // perform a recovery check. This short in-process lease prevents every idle
  // daemon from invoking the same provider login command on each heartbeat.
  // `lastPreflightAt` remains the durable retry clock, so an API restart may
  // reassign an overdue check without changing what that timestamp means.
  const preflightRecoveryLeases = new Map<RunnerKind, number>();
  const preflightRecoveryIntervalMs = 5 * 60_000;
  const appendFencedActivity = createAppendFencedActivityHandler(db);

  // The supported browser path is same-origin through the Vite proxy, so this
  // allowlist is a boundary rather than a transport: it decides which *other*
  // origin may read a control-plane response out of a browser. It was `*`, which
  // is the one value that makes that boundary vacuous. Public `/` and `/health`
  // and every authenticated route are unaffected — CORS decides what a browser
  // may read, and the principal check below still decides what is served.
  app.use("*", cors({
    origin: [...LOOPBACK_BROWSER_ORIGINS],
    allowHeaders: ["Authorization", "Content-Type", "X-Fencing-Token", "X-Anneal-Webhook-Secret", "X-Anneal-Delivery-Id"],
  }));
  // The second, independent half of that boundary (review S-2). CORS decides
  // what a browser may *read*; it lets the request run and commit its side
  // effect regardless. So a foreign `Origin` is refused here, before auth and
  // before any handler, rather than leaving the dev server's proxy guard as the
  // only barrier — which is the arrangement S-1 broke. The predicate is in
  // `local-origin.ts`, with the reason it matches by shape rather than against
  // the two-entry allowlist above.
  //
  // Preflights never reach this: `cors` answers OPTIONS above and returns.
  app.use("*", async (context, next) => {
    if (!originMayReachHandlers(context.req.header("Origin"))) return context.json({ error: "Forbidden origin" }, 403);
    await next();
  });
  app.use("*", async (context, next) => {
    if (isPublic(context.req.path, context.req.method)) {
      context.set("principal", { kind: "public" });
      await next();
      return;
    }
    const authorization = context.req.header("Authorization");
    let principal = await authenticate(db, authorization);
    const cancellationReplay = context.req.method === "POST"
      ? /^\/session\/runs\/([^/]+)\/revalidation\/cancel$/u.exec(context.req.path)
      : null;
    if (!principal && cancellationReplay?.[1]) {
      principal = await authenticateRevalidationCancellationReplay(db, authorization, {
        runId: cancellationReplay[1],
        requestId: revalidationCancelRequestId(cancellationReplay[1]),
      });
    }
    if (!principal) return context.json({ error: "Unauthorized" }, 401);
    if (!principalMayAccess(principal, context.req.path)) return context.json({ error: "Forbidden for principal" }, 403);
    context.set("principal", principal);
    await next();
  });

  const routeDeps: RouteDeps = {
    db,
    options,
    repositoryPreflight: options.repositoryPreflight ?? preflightRepository,
    projectBootstrapLoaders: {
      ...defaultProjectBootstrapLoaders,
      ...options.projectBootstrapLoaders,
    },
    releaseChainLease,
    readLeaseHolder: options.readMergeLeaseHolder ?? readMergeLeaseHolderAdapter,
    runners,
    appendFencedActivity,
  };
  const registerSystemTail = registerSystemRoutes(app, routeDeps);

  const registerTemplateTail = registerTemplateRoutes(app, routeDeps);

  registerSystemTail();
  registerAdminRoutes(app, routeDeps);
  registerAgentsRoutes(app, routeDeps);
  registerGoalsRoutes(app, routeDeps);
  registerTemplateTail();
  registerStaffingProfileRoutes(app, routeDeps);

  registerTasksRoutes(app, routeDeps);
  registerMergeLeaseRoutes(app, routeDeps);
  registerInboxRoutes(app, routeDeps);
  const registerRunnerTail = registerRunnerRoutes(app, routeDeps, {
    noteArchivedQueuedRunsOnClaim,
    preflightRecoveryLeases,
    preflightRecoveryIntervalMs,
  });
  const registerSessionTail = registerSessionRoutes(app, routeDeps);
  registerRunnerTail();
  registerSessionTail();

  app.onError((error, context) => {
    if (error instanceof SyntaxError) {
      return refusalJson(context, refusal("invalid-request", "Request body must be valid JSON", { code: "invalid-json" }));
    }
    if (error instanceof z.ZodError) return context.json({ error: "Validation failed", issues: error.issues }, 400);
    if (error instanceof SerializableTransactionExhaustedError) {
      return context.json({ error: "Transaction is busy; retry later" }, 503);
    }
    const rejected = refusalFor(error);
    if (rejected) return refusalJson(context, rejected);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") return refusalJson(context, refusal("not-found", "Resource not found"));
      if (error.code === "P2002") return refusalJson(context, refusal("conflict", "Unique constraint violated"));
    }
    console.error(error);
    return context.json({ error: "Internal server error" }, 500);
  });
  app.notFound((context) => refusalJson(context, refusal("not-found", "Not found")));
  return app;
};
