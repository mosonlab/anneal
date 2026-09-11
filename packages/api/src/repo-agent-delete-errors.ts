import type { RefusalStatus } from "./refusal-status.js";

/** Stable refusal codes for single-row Repo and Agent deletes. */
export const repoAgentDeleteRefusalStatus = {
  repo_referenced: 409,
  agent_referenced: 409,
} as const satisfies Record<string, RefusalStatus>;

export type RepoAgentDeleteRefusalCode = keyof typeof repoAgentDeleteRefusalStatus;

export const REPO_REFERENCED = "repo_referenced" as const;
export const AGENT_REFERENCED = "agent_referenced" as const;
