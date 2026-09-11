import type { RefusalStatus } from "./refusal-status.js";

/**
 * Stable refusal codes for single Repo and Agent deletion, each declared with
 * the HTTP status family it is answered with. The code union is derived from
 * this table so a delete refusal cannot exist without a status family.
 */
export const resourceDeleteRefusalStatus = {
  repo_referenced: 409,
  agent_referenced: 409,
} as const satisfies Record<string, RefusalStatus>;

export type ResourceDeleteRefusalCode = keyof typeof resourceDeleteRefusalStatus;

export const REPO_REFERENCED = "repo_referenced" as const;
export const AGENT_REFERENCED = "agent_referenced" as const;

export const resourceDeleteRefusalStatusFor = (
  code: ResourceDeleteRefusalCode,
): RefusalStatus => resourceDeleteRefusalStatus[code];
