declare module "*merge-lease-adapter.mjs" {
  export type LeaseProcessResult = {
    code: number | null;
    stdout?: string;
    stderr?: string;
    error?: unknown;
  };

  export type LeaseRunner = (
    command: string,
    argv: string[],
    options: {
      cwd?: string;
      environment: NodeJS.ProcessEnv;
      processTimeoutMs?: number;
    },
  ) => Promise<LeaseProcessResult>;

  export type MergeLeaseRelease =
    | { outcome: "released"; ref: string; sha: string; acquiredAt: string; detail?: string }
    | { outcome: "not-held"; detail?: string }
    | { outcome: "skipped"; heldFor: string; detail?: string }
    | { outcome: "refused"; heldBy: string; detail?: string }
    | { outcome: "unreachable"; detail: string };

  export type MergeLeaseHolder = {
    holder: string;
    task: string | null;
    reason: string | null;
    acquiredAt: string;
    sha: string | null;
  };

  export type MergeLeaseAcquisition =
    | { outcome: "acquired"; detail?: string }
    | { outcome: "contended"; detail?: string; holder?: MergeLeaseHolder }
    | { outcome: "unreachable"; detail: string };

  export type MergeLeaseStatus =
    | { outcome: "held"; holder: MergeLeaseHolder; detail?: string }
    | { outcome: "none"; detail?: string }
    | { outcome: "unreachable"; detail: string };

  export function resolveMergeLeaseScriptPath(options?: {
    environment?: NodeJS.ProcessEnv;
    repoRoot?: string;
  }): string;

  export function buildMergeLeaseArgv(options:
    | { operation: "release"; scriptPath: string; task: string }
    | { operation: "status"; scriptPath: string }
    | { operation: "acquire"; scriptPath: string; task: string; reason: string; timeoutMinutes: number }
  ): string[];

  export function parseMergeLeaseHolder(output: string): MergeLeaseHolder | null;

  export function mergeLeaseHoldSeconds(acquiredAt: string, releasedAt: Date | string): number | null;

  export function parseMergeLeaseRelease(output: string):
    | { outcome: "released"; ref: string; sha: string; acquiredAt: string }
    | { outcome: "not-held" }
    | { outcome: "skipped"; heldFor: string }
    | { outcome: "refused"; heldBy: string }
    | null;

  export function classifyMergeLeaseExecution(input: LeaseProcessResult & {
    operation: "acquire" | "release" | "status";
  }): MergeLeaseAcquisition | MergeLeaseRelease | MergeLeaseStatus;

  export function isMergeLeaseReleaseAnomaly(release: MergeLeaseRelease): boolean;

  type InvocationOptions = {
    repoRoot?: string;
    environment?: NodeJS.ProcessEnv;
    processTimeoutMs?: number;
    task: string;
    runner?: LeaseRunner;
  };

  export function acquireMergeLease(options: InvocationOptions & {
    reason: string;
    timeoutMinutes: number;
  }): Promise<MergeLeaseAcquisition>;

  export function releaseMergeLease(options: InvocationOptions): Promise<MergeLeaseRelease>;

  export function readMergeLeaseHolder(options?: Omit<InvocationOptions, "task">): Promise<MergeLeaseStatus>;
}
