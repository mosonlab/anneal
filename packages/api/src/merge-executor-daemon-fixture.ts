import { mergeExecutorRunnerIds } from "@anneal/db";

import type { DaemonSnapshotReader } from "./merge-readiness-worker.js";

/**
 * Every configured merge executor reported online, which is what readiness
 * requires before it authorizes. Tests that are not about executor liveness
 * pass this so they exercise the behaviour they are named for; with no
 * allowlist configured it reports nothing and readiness skips the check.
 */
export const executorsOnline: DaemonSnapshotReader = () => mergeExecutorRunnerIds().map((runnerId) => ({
  runnerId,
  online: true,
  lastSeenAt: new Date(),
  daemonVersion: null,
  diskFreeBytes: null,
  pollIntervalMs: null,
  workspaceRoot: null,
}));
