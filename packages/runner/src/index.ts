import { formatBuildLine, readBuildInfo } from "@anneal/build-info";
import {
  holdSharedServiceMaintenanceLock,
  ServiceMaintenanceLockError,
  SERVICE_LOCK_CONTENTION_EXIT_CODE,
} from "@anneal/db/service-lock";
import { config as loadEnvironment } from "dotenv";

loadEnvironment({ path: new URL("../../../.env", import.meta.url), quiet: true });

// Before the config, the token check and the adapters: whichever of those fails,
// the log still names the build that failed. The API prints the same line about
// its own dist, and the two are built separately — the 2026-08-17 incident was
// one of them being stale while the other was current (issue #140).
console.log(`Anneal runner build: ${formatBuildLine(readBuildInfo(import.meta.url))}`);

const [{ loadRunnerConfig }, { nodeBinaryPath, runtimeDescriptor }, { pollForTask, runStartupPreflight, startCliAvailabilityMonitor, startupPreflightLog }, { reclaimWorkspaces }, { prepareHostProofSlots }, { runPollingLoop }, { reportPresence }, { startDependencyCacheMaintenance }] = await Promise.all([
  import("./config.js"),
  import("./adapters.js"),
  import("./runner.js"),
  import("./reclaim.js"),
  import("./host-proof-slots.js"),
  import("./polling-loop.js"),
  import("./api.js"),
  import("./dependency-cache-maintenance.js"),
]);

const config = loadRunnerConfig();
if (!config.runnerToken) throw new Error("RUNNER_TOKEN is required; operator credentials must never be used by the runner");
if (process.env.RUNNER_NODE_BINARY) {
  // An explicit override that this process cannot execute is a deployment
  // mistake, and the CLI would only discover it as an MCP startup error inside
  // an agent session. Fail here, where the message is about the deployment.
  const { accessSync, constants } = await import("node:fs");
  accessSync(nodeBinaryPath(), constants.X_OK);
}
// Machine-readable, and printed before anything can fail: these are the paths a
// run-as account has to be able to reach, and they are not derivable from the
// operator's own shell. scripts/os-isolation/verify.sh reads this line.
console.log(runtimeDescriptor(config.runnerId, config.runAsPrefix));
await prepareHostProofSlots(config);

let stopping = false;
let stopExitCode = 0;

// OSS-D, plan Step 3 line 143. The runner reaches the database only through the
// control plane, so this lock is not protecting its own statements — it is the
// runner declaring that it is up. A release migration or an OSS-D backup asks
// for the same key exclusively and is refused while any service holds it
// shared, and "any service" has to include this one: a runner mid-task is a
// runner that will deliver results into the schema a migrator is about to
// rewrite. Taken before the preflight, because everything after it is work.
//
// This is the one place the runner opens a database connection, and it holds
// exactly one, for one statement per retention check. It never reads or writes
// a row; the control plane remains the only thing that does.
const sharedLock = await holdSharedServiceMaintenanceLock({
  service: "runner",
  databaseUrl: process.env.DATABASE_URL,
  onLost: (reason) => {
    // Not an immediate exit. Nothing this process does reaches the database
    // directly, and the control plane — which does — stops on the same signal,
    // so an in-flight task cannot write into a schema being maintained. Killing
    // it here would only lose a running agent session and leak its workspace.
    console.error(`Shared maintenance lock lost (${reason}); stopping local runner after the current task`);
    stopping = true;
    stopExitCode = SERVICE_LOCK_CONTENTION_EXIT_CODE;
  },
}).catch(async (error: unknown) => {
  if (!(error instanceof ServiceMaintenanceLockError)) throw error;
  // Written and flushed before the exit, not `console.error`d into a pipe the
  // exit would discard: the reason is the only thing an operator gets, and a
  // supervisor's log is exactly the pipe that loses it.
  await new Promise<void>((resolve) => {
    process.stderr.write(`Anneal runner startup refused: ${error.reason}\n`, () => { resolve(); });
  });
  process.exit(error.exitCode);
});

const preflight = await runStartupPreflight(config);
console.log(startupPreflightLog(preflight));
const availabilityMonitor = startCliAvailabilityMonitor(config);
const cacheMaintenance = startDependencyCacheMaintenance(config);
const stop = (signal: string): void => {
  console.log(`Received ${signal}; stopping local runner after the current task`);
  stopping = true;
  cacheMaintenance.stop();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

console.log(`Anneal local runner ${config.runnerId} polling ${config.apiUrl}`);
// Workspace disposal belongs to this process, because it is the one that owns
// the root (issue #115). The control plane only publishes intents; if nobody
// sweeps, directories accumulate and nothing is ever wrongly deleted.
const reclaim = async (): Promise<void> => {
  const sweep = await reclaimWorkspaces(config);
  if (sweep.offered > 0 || sweep.settled > 0) {
    console.log(`Workspace reclaim: ${sweep.removed} removed, ${sweep.refused} refused, ${sweep.failed} failed of ${sweep.offered} offered; ${sweep.settled} stale intent(s) settled`);
  }
};

await runPollingLoop(config, {
  reclaim,
  reportPresence: () => reportPresence(config),
  claim: () => pollForTask(config),
  shouldStop: () => stopping,
});

// The lock outlives the loop and nothing else: released here, on the ordinary
// stop path, so the key is free the moment this runner is no longer polling.
availabilityMonitor.stop();
cacheMaintenance.stop();
await sharedLock.release();
if (stopExitCode !== 0) process.exitCode = stopExitCode;
