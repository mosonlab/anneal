import * as os from "node:os";

/** The configuration read by the admission loop. */
export type PollingLoopConfig = {
  pollIntervalMs: number;
  workspaceReclaimIntervalMs: number;
  claimMaxLoadAverage: number;
};

/**
 * What one admission attempt reached. `draining` is the control plane's answer
 * while an auto-deploy waits for its quiet window: no work is offered to any
 * runner, so the poll is neither idle work nor a failure.
 */
export type ClaimOutcome = "executed" | "idle" | "draining";

export type PollingLoopDependencies = {
  /** Read the host's one-minute load average. */
  readLoadAverage?: () => number;
  /** Read the clock used to schedule workspace reclaim sweeps. */
  now?: () => number;
  /** Wait before the next poll when no claim is executed. */
  wait?: (delayMs: number) => Promise<void>;
  /** Reclaim the workspaces due for this iteration's sweep. */
  reclaim: () => Promise<void>;
  /** Try one control-plane claim and execute it when present. */
  claim: () => Promise<ClaimOutcome>;
  /** Return whether the process has received a stop request. */
  shouldStop: () => boolean;
  log?: (line: string) => void;
  error?: (line: string, error: unknown) => void;
};

const readLoadAverage = (): number => os.loadavg()[0]!;

const wait = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

/**
 * Runs the runner's admission/poll loop.
 *
 * Reclaim is deliberately kept ahead of admission: it is local maintenance,
 * and remains eligible on a scheduled interval even when load prevents a new
 * claim. A successful claim continues immediately so the existing execution
 * path is awaited to completion by the injected claim function.
 */
export const runPollingLoop = async (
  config: PollingLoopConfig,
  dependencies: PollingLoopDependencies,
): Promise<void> => {
  const currentTime = dependencies.now ?? Date.now;
  const waitFor = dependencies.wait ?? wait;
  const readLoad = dependencies.readLoadAverage ?? readLoadAverage;
  const log = dependencies.log ?? console.log;
  const reportError = dependencies.error ?? ((line, error) => console.error(line, error));
  let nextReclaimAt = 0;
  let overloaded = false;
  let draining = false;

  while (!dependencies.shouldStop()) {
    const now = currentTime();
    if (now >= nextReclaimAt) {
      nextReclaimAt = now + config.workspaceReclaimIntervalMs;
      try {
        await dependencies.reclaim();
      } catch (error: unknown) {
        // A reclaim failure must not prevent this process from asking for work.
        reportError("Workspace reclaim sweep failed", error);
      }
    }

    const load = readLoad();
    if (load > config.claimMaxLoadAverage) {
      if (!overloaded) {
        overloaded = true;
        log(`Runner claim overloaded: load=${load} threshold=${config.claimMaxLoadAverage}`);
      }
      await waitFor(config.pollIntervalMs);
      continue;
    }

    if (overloaded) {
      overloaded = false;
      log(`Runner claim recovered: load=${load} threshold=${config.claimMaxLoadAverage}`);
    }

    try {
      const outcome = await dependencies.claim();
      // Paired like the overload lines above: the state is logged when it is
      // entered and when it is left, not once per poll. The runner keeps
      // polling throughout, so its heartbeat still says it is alive.
      if (outcome === "draining" && !draining) {
        draining = true;
        log("Runner claim draining: the control plane is refusing claims until a pending deploy lands");
      }
      if (outcome !== "draining" && draining) {
        draining = false;
        log("Runner claim drain cleared");
      }
      if (outcome === "executed") continue;
    } catch (error: unknown) {
      reportError("Runner poll failed", error);
    }
    await waitFor(config.pollIntervalMs);
  }
};
