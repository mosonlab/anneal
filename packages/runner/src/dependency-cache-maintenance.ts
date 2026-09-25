import { mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { RunnerConfig } from "./config.js";
import { openCacheEntryStore, type CacheStoreReport } from "./dependency-cache-store.js";

type MaintenanceConfig = Pick<RunnerConfig, "workspaceRoot" | "dependencyCacheRoot" | "dependencyCacheByteBudget">;

type MaintenanceOptions = {
  sweep?: (signal: AbortSignal) => Promise<unknown>;
  report?: CacheStoreReport;
  onError?: (error: unknown) => void;
  schedule?: (tick: () => Promise<void>) => () => void;
};

const scheduleMinute = (tick: () => Promise<void>): (() => void) => {
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  return () => { clearInterval(timer); };
};

/** Maintenance never sits in admission or Run provisioning. The store arbitrates
 * between daemons sharing a cache; this guard prevents overlap within one daemon.
 * A stopped process may leave trash, which the next owner resumes safely. */
export const startDependencyCacheMaintenance = (
  config: MaintenanceConfig,
  options: MaintenanceOptions = {},
): { stop: () => void } => {
  const controller = new AbortController();
  const report = options.report ?? ((event) => {
    console.log(JSON.stringify({ audit: "dependency-cache", ...event }));
  });
  const onError = options.onError ?? ((error: unknown) => {
    console.error(JSON.stringify({
      audit: "dependency-cache", event: "maintenance-failed",
      condition: error instanceof Error ? error.message : String(error),
    }));
  });
  const sweep = options.sweep ?? (async (signal: AbortSignal) => {
    await mkdir(config.workspaceRoot, { recursive: true });
    const workspaceRoot = await realpath(config.workspaceRoot);
    if (signal.aborted) return;
    const root = config.dependencyCacheRoot ?? join(dirname(resolve(config.workspaceRoot)), "dependency-cache");
    const store = await openCacheEntryStore(root, workspaceRoot);
    if (signal.aborted) return;
    await store.maintainByteBudget(report, config.dependencyCacheByteBudget, { signal });
  });
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy || controller.signal.aborted) return;
    busy = true;
    try {
      await sweep(controller.signal);
    } catch (error: unknown) {
      if (!controller.signal.aborted) onError(error);
    } finally {
      busy = false;
    }
  };
  const cancel = (options.schedule ?? scheduleMinute)(tick);
  // Backfill old size records and resume interrupted trash on daemon startup,
  // without awaiting either before the runner can poll or report presence.
  void tick();
  return { stop: () => {
    controller.abort();
    cancel();
  } };
};
