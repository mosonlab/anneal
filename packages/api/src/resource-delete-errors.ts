import type { RefusalStatus } from "./refusal-status.js";

/**
 * Stable refusal codes for single Repo and Agent deletion, each declared with
 * the HTTP status family it is answered with. The status table must cover the
 * code union so a delete refusal cannot exist without a status family.
 */
export const resourceDeleteRefusalCode = {
  repo_referenced: "repo_referenced",
  agent_referenced: "agent_referenced",
} as const;

export type ResourceDeleteRefusalCode = typeof resourceDeleteRefusalCode[keyof typeof resourceDeleteRefusalCode];

export const resourceDeleteRefusalStatus = {
  repo_referenced: 409,
  agent_referenced: 409,
} as const satisfies Record<ResourceDeleteRefusalCode, RefusalStatus>;

export const resourceDeleteRefusalStatusFor = (
  code: ResourceDeleteRefusalCode,
): RefusalStatus => resourceDeleteRefusalStatus[code];
