import { RunnerKind } from "@anneal/db";
import type {
  Health,
  OnboardingInstallation,
  OnboardingStatus,
  RunnersResponse,
  VersionInfo,
} from "@anneal/db/console-contract";
import { getMimeType } from "hono/utils/mime";
import { z } from "zod";

import { projectRunnerBackend } from "../runner-backend-health.js";
import { versionPayload } from "../version.js";
import { getFileStore } from "../files/config.js";
import { NotFoundError, type FileStore } from "../files/store.js";
import { createStarterInstallation, onboardingInput, onboardingStatus } from "../onboarding.js";
import { preflightOnboardingRepository, RepositoryPreflightError } from "../onboarding-preflight.js";
import { activeRunStatuses } from "../run-fence.js";
import {
  FILE_WRITE_LIMIT,
  fileErrorResponse,
  readBoundedBody,
  readJson,
  refusal,
  refusalJson,
  type RouteApp,
  type RouteDeps,
} from "./support.js";

const deleteRecursively = async (store: FileStore, path: string): Promise<void> => {
  const stat = await store.stat(path);
  if (!stat) throw new NotFoundError(`Path not found: ${path}`);
  if (stat.kind === "dir") {
    // entries(), not list(): list() hides symlinks, so they survived the walk, the final
    // rmdir failed ENOTEMPTY, and the tree was left half-destroyed and undeletable.
    for (const child of await store.entries(path)) {
      if (child.kind === "dir") await deleteRecursively(store, child.path);
      else await store.delete(child.path);
    }
  }
  await store.delete(path);
};

export const registerSystemRoutes = (app: RouteApp, deps: RouteDeps): (() => void) => {
  const { db, options, runners } = deps;

  app.get("/", (context) => context.json({ name: "Anneal control plane", phase: "execution-kernel" }));
  app.get("/health", async (context) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return context.json({ status: "ok", database: "connected", checkedAt: new Date().toISOString() } satisfies Health);
    } catch (error: unknown) {
      console.error("Health check failed", error);
      return context.json(
        { status: "error", database: "disconnected", checkedAt: new Date().toISOString() } satisfies Health,
        503,
      );
    }
  });
  // Provenance, not status: which commit this dist was built from (issue #140).
  // Unauthenticated and free of state so that whoever is checking whether a
  // restart took the new build can ask the running process directly instead of
  // hashing artefacts by hand, which is what the 2026-08-17 incident cost.
  app.get("/version", (context) => context.json(versionPayload() satisfies VersionInfo));
  app.get("/runners", async (context) => {
    const now = new Date();
    const daemons = runners.snapshot(now);
    const knownIds = daemons.map((daemon) => daemon.runnerId);
    const [storedBackends, activeGroups] = await Promise.all([
      db.runnerBackendState.findMany(),
      knownIds.length === 0 ? [] : db.run.groupBy({
        by: ["runnerId"],
        where: { status: { in: activeRunStatuses }, runnerId: { in: knownIds } },
        _count: { _all: true },
      }),
    ]);
    const activeByRunner = new Map(activeGroups.map((group) => [group.runnerId, group._count._all]));
    const backendsByRunner = new Map(storedBackends.map((backend) => [backend.runner, backend]));
    return context.json({
      checkedAt: now.toISOString(),
      online: daemons.filter((daemon) => daemon.online).length,
      total: daemons.length,
      daemons: daemons.map((daemon) => {
        const activeRuns = activeByRunner.get(daemon.runnerId) ?? 0;
        return { ...daemon, lastSeenAt: daemon.lastSeenAt.toISOString(), busy: activeRuns > 0, activeRuns };
      }),
      backends: Object.values(RunnerKind).map((runner) =>
        projectRunnerBackend(runner, backendsByRunner.get(runner) ?? null)),
    } satisfies RunnersResponse);
  });

  // registerTemplateRoutes registers the webhook route between /runners and the
  // deferred /files routes. Return a continuation so app.ts can preserve Hono's
  // route matching order exactly.
  return (): void => {
    app.get("/files", async (context) => {
      try {
        return context.json(await (await getFileStore()).list(context.req.query("dir") ?? ""));
      } catch (error: unknown) {
        const response = fileErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    });
    app.get("/files/content", async (context) => {
      const path = context.req.query("path") ?? "";
      try {
        const content = await (await getFileStore()).read(path);
        return context.body(new Uint8Array(content), 200, {
          "Content-Type": getMimeType(path) ?? "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.split("/").at(-1) ?? "file")}`,
        });
      } catch (error: unknown) {
        const response = fileErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    });
    app.put("/files/content", async (context) => {
      try {
        const content = await readBoundedBody(context.req.raw, FILE_WRITE_LIMIT);
        return context.json(await (await getFileStore()).write(context.req.query("path") ?? "", content));
      } catch (error: unknown) {
        const response = fileErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    });
    app.delete("/files", async (context) => {
      try {
        const store = await getFileStore();
        const path = context.req.query("path") ?? "";
        if (context.req.query("recursive") === "true") await deleteRecursively(store, path);
        else await store.delete(path);
        return context.json({ ok: true });
      } catch (error: unknown) {
        const response = fileErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    });

    // First-run onboarding (OSS-B0 Step 4). Two routes, both operator-only: the
    // principal middleware already denies runner and session principals every path
    // outside their own prefix, and the explicit check states the requirement at
    // the route that depends on it rather than leaving it implied by a table in
    // auth.ts. Everything these routes decide lives in onboarding.ts.
    app.get("/onboarding", async (context) => {
      if (context.get("principal").kind !== "operator") return context.json({ error: "Forbidden for principal" }, 403);
      return context.json(await onboardingStatus(db) satisfies OnboardingStatus);
    });
    app.post("/onboarding", async (context) => {
      if (context.get("principal").kind !== "operator") return context.json({ error: "Forbidden for principal" }, 403);
      const input = await readJson(context.req.raw, onboardingInput);
      try {
        await (options.onboardingRepositoryPreflight ?? preflightOnboardingRepository)(input);
      } catch (error: unknown) {
        if (error instanceof RepositoryPreflightError) {
          return context.json({ error: "Repository preflight failed", code: "repository-preflight-failed", reason: error.reason }, 422);
        }
        throw error;
      }
      const result = await createStarterInstallation(db, input);
      // 409, not 400 or a silent success: the request was well formed, the state of
      // the target is what refuses it, and the caller recovers by reading GET
      // /onboarding rather than by editing anything. A committed-but-lost response
      // lands here too, which is why the code is stable and the rows are untouched.
      if (!result.ok) {
        return refusalJson(context, refusal("conflict", "An installation already exists", { code: result.code }));
      }
      return context.json(result.installation satisfies OnboardingInstallation, 201);
    });
  };
};
