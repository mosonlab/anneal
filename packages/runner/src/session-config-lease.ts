import { RUNNER_DEFINITIONS } from "./adapters.js";
import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import {
  cleanupAgentScratch,
  provisionSessionConfig,
  sessionConfigRootExists,
  type AgentScratch,
} from "./workspace.js";

export type SessionConfigDisposal = {
  retainedPath: string | null;
  cleanupFailureReason: string | null;
};

export type SessionConfigLease = {
  readonly isolated: boolean;
  retainedPath(): Promise<string | null>;
  settle(outcome: "succeeded" | "failed"): Promise<SessionConfigDisposal>;
};

export type SessionConfigLeaseDependencies = {
  provisionSessionConfig?: typeof provisionSessionConfig;
  cleanupAgentScratch?: typeof cleanupAgentScratch;
  sessionConfigRootExists?: typeof sessionConfigRootExists;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Owns the lifecycle of one Session's CLI config root. A failed outcome keeps
 * an isolated root for diagnosis or resume. If scratch cleanup removes or
 * partially removes that root before failing, the module restores it from the
 * same adapter before reporting the structured disposal result.
 */
export const openSessionConfig = (
  config: RunnerConfig,
  claim: Pick<ClaimedTask, "runner" | "resume">,
  scratch: AgentScratch,
  dependencies: SessionConfigLeaseDependencies = {},
  options: { isolate?: boolean } = {},
): SessionConfigLease => {
  const isolated = options.isolate ?? RUNNER_DEFINITIONS[claim.runner].isolatesSessionConfig;
  const provision = dependencies.provisionSessionConfig ?? provisionSessionConfig;
  const cleanup = dependencies.cleanupAgentScratch ?? cleanupAgentScratch;
  const rootExists = dependencies.sessionConfigRootExists ?? sessionConfigRootExists;

  const retainedPath = async (): Promise<string | null> =>
    isolated && await rootExists(scratch) ? scratch.configRoot : null;

  const restore = async (): Promise<string | null> => {
    if (!isolated || await rootExists(scratch)) return null;
    try {
      await provision(config, claim.runner, scratch);
      return null;
    } catch (error: unknown) {
      return `unable to restore session CLI config: ${errorMessage(error)}`;
    }
  };

  return {
    isolated,
    retainedPath,
    settle: async (outcome): Promise<SessionConfigDisposal> => {
      let cleanupFailureReason = outcome === "failed" ? await restore() : null;
      try {
        await cleanup(config, scratch, { retainConfigRoot: isolated && outcome === "failed" });
      } catch (error: unknown) {
        cleanupFailureReason = [errorMessage(error), await restore()].filter(Boolean).join("; ");
      }
      return { retainedPath: await retainedPath(), cleanupFailureReason };
    },
  };
};
