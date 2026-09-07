export type DaemonTelemetry = {
  lastSeenAt: Date;
  daemonVersion: string | null;
  diskFreeBytes: number | null;
  pollIntervalMs: number | null;
  workspaceRoot: string | null;
};

export const RUNNER_FORGET_MS = 15 * 60_000;

type Observation = {
  daemonVersion?: string | null | undefined;
  diskFreeBytes?: number | null | undefined;
  pollIntervalMs?: number | null | undefined;
  workspaceRoot?: string | null | undefined;
};
export type DaemonSnapshot = { runnerId: string; online: boolean } & DaemonTelemetry;

export type RunnerRegistry = {
  note: (runnerId: string, telemetry: Observation, now: Date) => void;
  snapshot: (now: Date) => DaemonSnapshot[];
};

export const createRunnerRegistry = (): RunnerRegistry => {
  const entries = new Map<string, DaemonTelemetry>();

  return {
    note: (runnerId, telemetry, now) => {
      // Replace every observation. An omitted field belongs to this daemon
      // incarnation and must not inherit telemetry from an older process.
      entries.set(runnerId, {
        lastSeenAt: now,
        daemonVersion: telemetry.daemonVersion ?? null,
        diskFreeBytes: telemetry.diskFreeBytes ?? null,
        pollIntervalMs: telemetry.pollIntervalMs ?? null,
        workspaceRoot: telemetry.workspaceRoot ?? null,
      });
    },
    snapshot: (now) => {
      for (const [runnerId, telemetry] of entries) {
        if (now.getTime() - telemetry.lastSeenAt.getTime() > RUNNER_FORGET_MS) entries.delete(runnerId);
      }
      return [...entries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([runnerId, telemetry]) => ({
          runnerId,
          ...telemetry,
          online: now.getTime() - telemetry.lastSeenAt.getTime()
            <= Math.max(3 * (telemetry.pollIntervalMs ?? 5_000), 30_000),
        }));
    },
  };
};
