import { homedir } from "node:os";
import { join } from "node:path";

import {
  holdSharedServiceMaintenanceLock,
  ServiceMaintenanceLockError,
  SERVICE_LOCK_CONTENTION_EXIT_CODE,
  type HeldServiceMaintenanceLock,
} from "@anneal/db/service-lock";
import type { ServerType } from "@hono/node-server";
import { config } from "dotenv";

import {
  acquireControlPlaneOwnership,
  ControlPlaneOwnershipStartupError,
  type ControlPlaneOwnership,
} from "./control-plane-ownership.js";
import { StartupConfigError, loadStartupConfig } from "./startup-config.js";
import { apiBuildLine } from "./version.js";

config({
  path: new URL("../../../.env", import.meta.url),
  quiet: true,
});

let ownership: ControlPlaneOwnership | undefined;
let sharedLock: HeldServiceMaintenanceLock | undefined;
let server: ServerType | undefined;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let evidenceTimer: ReturnType<typeof setInterval> | null = null;
let readinessTimer: ReturnType<typeof setInterval> | null = null;
let baseDriftRecoveryTimer: ReturnType<typeof setInterval> | null = null;
let prisma: (typeof import("@anneal/db"))["prisma"] | undefined;
let cleanupPromise: Promise<void> | undefined;
let requestedSignal: NodeJS.Signals | undefined;
// Signals must never start cleanup before an in-flight ownership acquisition has
// published its capability. Keep the whole startup sequence busy and let the
// explicit checkpoints join it to the single cleanup state machine.
let startupBusy = true;
// Set by the shared maintenance lock's retention check. Read at the same
// checkpoints a signal is: a startup that has already lost the lock must not
// carry on to bind a socket.
let lockLost = false;
let finalExitCode = 0;

class StartupCancelledBySignalError extends Error {}

const closeServer = async (): Promise<void> => {
  if (!server) return;
  const closing = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => {
    closing.close((error?: Error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error;
  });
};

const cleanup = (exitCode: number): Promise<void> => {
  finalExitCode = Math.max(finalExitCode, exitCode);
  cleanupPromise ??= (async () => {
    const failures: unknown[] = [];
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
    if (evidenceTimer) clearInterval(evidenceTimer);
    evidenceTimer = null;
    if (readinessTimer) clearInterval(readinessTimer);
    readinessTimer = null;
    if (baseDriftRecoveryTimer) clearInterval(baseDriftRecoveryTimer);
    baseDriftRecoveryTimer = null;
    await closeServer().catch((error: unknown) => failures.push(error));
    if (prisma) await prisma.$disconnect().catch((error: unknown) => failures.push(error));
    // After the listener is closed and the client is disconnected, and not
    // before: the shared lock's promise to a migrator is that no statement of
    // this process reaches the schema while it is held.
    if (sharedLock) await sharedLock.release().catch((error: unknown) => failures.push(error));
    if (ownership) await ownership.release().catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
      finalExitCode = 1;
      throw new AggregateError(failures, "Anneal API cleanup failed");
    }
  })();
  return cleanupPromise.finally(() => { process.exitCode = finalExitCode; });
};

const ensureStartupActive = async (): Promise<void> => {
  if (lockLost) {
    await cleanup(SERVICE_LOCK_CONTENTION_EXIT_CODE);
    throw new StartupCancelledBySignalError("startup-cancelled-by-maintenance-lock-loss");
  }
  if (!requestedSignal) return;
  await cleanup(0);
  throw new StartupCancelledBySignalError(`startup-cancelled-by-${requestedSignal}`);
};

const onSignal = (signal: NodeJS.Signals): void => {
  if (requestedSignal) return;
  requestedSignal = signal;
  console.log(`Received ${signal}; shutting down Anneal API`);
  if (!startupBusy) void cleanup(0).catch((error: unknown) => {
    console.error("Anneal API shutdown failed", error);
    process.exitCode = 1;
  });
};

process.once("SIGINT", () => onSignal("SIGINT"));
process.once("SIGTERM", () => onSignal("SIGTERM"));

/**
 * A control plane that cannot prove it still holds the shared maintenance lock
 * is a control plane a migrator is entitled to treat as absent. It stops rather
 * than keeps serving: exit 75 tells the supervisor a restart is the response,
 * and that restart re-enters the same acquisition — which succeeds once the
 * maintenance session that took the key releases it, and refuses while it has
 * not.
 */
const onSharedLockLost = (reason: string): void => {
  if (lockLost) return;
  lockLost = true;
  console.error(`Anneal API stopping: ${reason}`);
  finalExitCode = Math.max(finalExitCode, SERVICE_LOCK_CONTENTION_EXIT_CODE);
  if (!startupBusy) void cleanup(SERVICE_LOCK_CONTENTION_EXIT_CODE).catch((error: unknown) => {
    console.error("Anneal API shutdown failed", error);
    process.exitCode = 1;
  });
};

const main = async (): Promise<void> => {
  // First line of the log, before ownership, the database or the port can fail:
  // a startup that dies still has to say which build died (issue #140).
  console.log(apiBuildLine());
  // Before ownership, before Prisma, before a socket: a control plane that is
  // configured wrong must refuse rather than start wrong. The reasons this
  // prints are stable codes and variable names, never values.
  const startup = loadStartupConfig();
  const configuredWorkspaceRoot = process.env.RUNNER_WORKSPACE_ROOT;
  const configuredFilesRoot = process.env.FILES_ROOT ?? join(homedir(), "Documents", "agentos");
  ownership = await acquireControlPlaneOwnership({
    filesRoot: configuredFilesRoot,
    ...(configuredWorkspaceRoot ? { workspaceRoot: configuredWorkspaceRoot } : {}),
    ...(process.env.CONTROL_PLANE_STATE_DIR ? { stateDir: process.env.CONTROL_PLANE_STATE_DIR } : {}),
  });
  await ensureStartupActive();

  // OSS-D, plan Step 3 line 143. Before the first statement this process sends
  // to the schema — startup reconciliation is already one — announce to the
  // server that a service is serving this schema. A release migration or an
  // OSS-D backup asks for the same key exclusively and is refused while this is
  // held; if it cannot be taken now, something already holds it exclusively and
  // this process must not begin serving a database that is being maintained.
  sharedLock = await holdSharedServiceMaintenanceLock({
    service: "api",
    databaseUrl: process.env.DATABASE_URL,
    onLost: onSharedLockLost,
  });
  await ensureStartupActive();

  const [
    database,
    { createApp },
    { createGitHubReader },
    { createMirrorBackedSpecificationReader },
    { reconcileAtStartup },
    { startScheduler },
    { startEvidenceWorker },
    { startReadinessWorker },
    { startBaseDriftRecoveryWorker },
    files,
    { serve },
  ] = await Promise.all([
    import("@anneal/db"),
    import("./app.js"),
    import("./github-read.js"),
    import("./specification-reader.js"),
    import("./reconcile.js"),
    import("./scheduler.js"),
    import("./merge-evidence-worker.js"),
    import("./merge-readiness-worker.js"),
    import("./merge-base-drift-worker.js"),
    import("./files/config.js"),
    import("@hono/node-server"),
  ]);
  prisma = database.prisma;
  await ensureStartupActive();

  const filesRoot = files.resolveFilesRoot();
  await files.warnIfICloudPath(filesRoot);
  await files.assertFilesRootIsolated(filesRoot, ownership.canonicalWorkspaceRoot);
  await files.getFileStore();
  files.warnIfRunnerSharesPrincipal(filesRoot);

  await ownership.assertHeld();
  const reconciliation = await reconcileAtStartup(prisma);
  // `unavailable` rather than a number the process never read: see
  // `StartupReconciliation` in reconcile.ts.
  const count = (value: number | null): string => (value === null ? "unavailable" : String(value));
  console.log(`Startup reconciliation: ${reconciliation.runs} database runs reconciled, ${count(reconciliation.openReclaimIntents)} workspace reclaim intents awaiting their runner, ${count(reconciliation.archivedNotices)} archived-run notices`);
  await ensureStartupActive();

  const githubReader = createGitHubReader(startup.githubReadToken);
  const specificationReader = createMirrorBackedSpecificationReader(githubReader);
  const app = createApp(prisma, { ownership, specificationReader });
  const { host: hostname, port } = startup;
  const activeServer = serve({ fetch: app.fetch, hostname, port });
  server = activeServer;
  await new Promise<void>((resolve, reject) => {
    const listening = (): void => {
      activeServer.off("error", failed);
      resolve();
    };
    const failed = (error: Error): void => {
      activeServer.off("listening", listening);
      reject(error);
    };
    activeServer.once("listening", listening);
    activeServer.once("error", failed);
  });
  await ensureStartupActive();
  const address = activeServer.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`Anneal API listening on http://${hostname}:${listeningPort}`);
  schedulerTimer = startScheduler(prisma);
  // §D-P3 Phase B. Attaches to the process that already owns the single-instance
  // control plane and already holds the read credential, rather than inventing
  // a fourth service.
  evidenceTimer = startEvidenceWorker(prisma, githubReader);
  readinessTimer = startReadinessWorker(prisma, githubReader, startup.mergeTrainWidth);
  baseDriftRecoveryTimer = startBaseDriftRecoveryWorker(prisma, githubReader);
  startupBusy = false;
};

try {
  await main();
} catch (error: unknown) {
  startupBusy = false;
  if (error instanceof StartupConfigError) {
    // No stack: the stack says where the check lives, and the reasons say what
    // to fix. Exit 78 (EX_CONFIG) tells a supervisor a restart will not help.
    console.error(`Anneal API startup configuration refused: ${error.reasons.join(", ")}`);
    console.error("Run `npm run setup:local` to generate a complete local configuration, or fix the variables named above.");
    process.exitCode = error.exitCode;
  } else if (error instanceof ControlPlaneOwnershipStartupError) {
    process.exitCode = error.exitCode;
  } else if (error instanceof ServiceMaintenanceLockError) {
    // No stack, and no value: the reason names the kind of holder or the
    // variable at fault, which is the whole of what an operator can act on.
    console.error(`Anneal API startup refused: ${error.reason}`);
    process.exitCode = error.exitCode;
    await cleanup(error.exitCode).catch((cleanupError: unknown) => console.error("Anneal API cleanup failed", cleanupError));
  } else if (error instanceof StartupCancelledBySignalError) {
    await cleanup(0).catch((cleanupError: unknown) => console.error("Anneal API cleanup failed", cleanupError));
  } else {
    console.error("Anneal API startup failed", error);
    await cleanup(1).catch((cleanupError: unknown) => console.error("Anneal API cleanup failed", cleanupError));
  }
}
