import { spawn, type ChildProcess } from "node:child_process";

import { acquireControlPlaneOwnership } from "./control-plane-ownership.js";

const ownership = await acquireControlPlaneOwnership({
  ...(process.env.RUNNER_WORKSPACE_ROOT ? { workspaceRoot: process.env.RUNNER_WORKSPACE_ROOT } : {}),
  ...(process.env.FILES_ROOT ? { filesRoot: process.env.FILES_ROOT } : {}),
  ...(process.env.CONTROL_PLANE_STATE_DIR ? { stateDir: process.env.CONTROL_PLANE_STATE_DIR } : {}),
});

let descendant: ReturnType<typeof spawn> | undefined;
const keepAlive = setInterval(() => undefined, 1_000);
/** This probe is a test fixture that the gate runs, so its own cleanup carries
 *  the same rule as the suite spawning it: bounded, so a descendant that never
 *  dies is reported (the caller escalates to SIGKILL and then fails), but sized
 *  for the loaded gate worker rather than an idle host — signal delivery and
 *  reaping queue behind whatever else the worker is carrying. The wait ends the
 *  moment the descendant exits, so a healthy run never pays this.
 *
 *  This budget nests strictly inside the parent's: control-plane-ownership.test.ts
 *  waits CHILD_TERMINATION_BUDGET_MS (60s) for this probe to exit, and this
 *  probe's worst case is ownership.release() plus SIGTERM (10s) plus SIGKILL
 *  (10s). Raising this above ~20s would let the parent kill the probe before
 *  the probe could report its own descendant — the load-induced false FAIL this
 *  whole change exists to remove. Keep inner + release well under the outer. */
const DESCENDANT_EXIT_BUDGET_MS = 10_000;

const waitForExit = (child: ChildProcess, timeoutMs = DESCENDANT_EXIT_BUDGET_MS): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for descendant ${child.pid ?? "unknown"} to exit`));
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
};

const stopDescendant = async (): Promise<void> => {
  if (!descendant || descendant.exitCode !== null || descendant.signalCode !== null) return;
  descendant.kill("SIGTERM");
  try {
    await waitForExit(descendant);
  } catch (error) {
    descendant.kill("SIGKILL");
    await waitForExit(descendant).catch((killError: unknown) => {
      throw new AggregateError([error, killError], `Failed to stop descendant ${descendant?.pid ?? "unknown"}`);
    });
  }
};

let stopping: Promise<void> | undefined;
const stop = (): Promise<void> => stopping ??= (async () => {
  clearInterval(keepAlive);
  const failures: unknown[] = [];
  await ownership.release().catch((error: unknown) => { failures.push(error); });
  await stopDescendant().catch((error: unknown) => { failures.push(error); });
  if (failures.length > 0) throw new AggregateError(failures, "Ownership probe cleanup failed");
})();

const stopForSignal = (): void => {
  void stop().then(
    () => { process.exitCode = 0; },
    (error: unknown) => {
      console.error("OWNERSHIP_PROBE_CLEANUP_FAILED", error);
      process.exitCode = 1;
    },
  );
};
process.once("SIGTERM", stopForSignal);
process.once("SIGINT", stopForSignal);

if (process.env.OWNERSHIP_PROBE_DESCENDANT === "1") {
  descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: false,
  });
  console.log(`OWNERSHIP_PROBE_DESCENDANT_PID ${descendant.pid}`);
}
if (process.env.OWNERSHIP_PROBE_SUPPRESS_READY !== "1") console.log("OWNERSHIP_PROBE_READY");
