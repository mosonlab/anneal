import type { PrismaClient } from "@anneal/db";
import { observeEpisode, type EpisodeObservation, type EpisodeResult } from "./merge-tail-episode.js";
import type { ReadinessClaimHandle } from "./readiness-claim.js";

/** Adapt a tick observation to the readiness claim's transaction fence. */
export const observeLeaseEpisode = async (
  db: PrismaClient,
  claim: ReadinessClaimHandle,
  observation: Extract<EpisodeObservation, { family: "lease-contention" }>,
): Promise<EpisodeResult | null> => db.$transaction(async (tx) => {
  const result = await claim.settle(tx, {
    kind: "keep",
    apply: (client) => observeEpisode(client, observation),
  });
  return result.settled ? result.value : null;
});
