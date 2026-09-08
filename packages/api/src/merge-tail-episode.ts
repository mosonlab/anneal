import {
  MERGE_TAIL_KIND, MERGE_EXECUTOR_OFFLINE_STATE, MERGE_EXECUTOR_OFFLINE_REASON, latestExecutorOfflineMarker,
  openEpisodeStart, readLatestMarker, recordLeaseContention, writeMarker,
  type Prisma,
} from "@anneal/db";
import type { MergeLeaseHolder } from "../../../scripts/merge-lease-adapter.mjs";
import { openOperatorAlert } from "./operator-alert.js";
import { RUNNER_FORGET_MS } from "./runners.js";

type Observation = {
  taskId: string;
  now: Date;
  detail?: string;
} & (
  | { family: "lease-contention"; answer: "contended" | "unreachable" | "resolved" | "skipped";
      target: { projectId: string; chainId: string }; holder?: MergeLeaseHolder | null }
  | { family: "train-lease-contention"; answer: "contended" | "unreachable" | "resolved" | "skipped" }
  | { family: "executor-offline"; answer: "offline" | "online" | "resolved" | "skipped"; executorRunnerIds?: string[] }
);

export type EpisodeObservation = Observation;
export type EpisodeResult = {
  transition: "opened" | "continuing" | "alerted" | "closed" | "none";
  startedAt: Date | null;
};

const alertWindow = {
  "lease-contention": 30 * 60_000,
  "train-lease-contention": 30 * 60_000,
  "executor-offline": RUNNER_FORGET_MS,
};

const describeHolder = (holder: MergeLeaseHolder | null | undefined): string => {
  if (!holder) return "a holder the lease script could not name";
  return `${holder.holder} (${[
    holder.task ? `task ${holder.task}` : null,
    holder.reason ? `reason "${holder.reason}"` : null,
    `acquired at ${holder.acquiredAt}`,
  ].filter(Boolean).join(", ")})`;
};

/** Caller holds the Task mutation fence, and records a held Lease answer before
 * leaving its Lease window. Skipped ticks never read or change an episode. */
export const observeEpisode = async (
  tx: Prisma.TransactionClient, input: Observation,
): Promise<EpisodeResult> => {
  if (input.answer === "skipped") return { transition: "none", startedAt: null };
  const offline = input.family === "executor-offline";
  // The confirmation approval in @anneal/db still writes this same outage.
  // Keep its shared reader until that writer and reader migrate together.
  const outage = offline ? await latestExecutorOfflineMarker(tx, input.taskId) : null;
  const marker = offline ? null : await readLatestMarker(tx, input.taskId, "leaseContention");
  const raw = offline ? (outage?.metadata ?? {}) as Record<string, unknown> : marker?.raw ?? {};
  let startedAt: Date | null = offline ? openEpisodeStart(outage) : null;
  if (!offline && marker && marker.state !== "resolved") {
    const recorded = typeof raw.firstContendedAt === "string" ? Date.parse(raw.firstContendedAt) : Number.NaN;
    if (Number.isFinite(recorded)) startedAt = new Date(recorded);
    else {
      const row = await tx.taskActivity.findFirst({
        where: { taskId: input.taskId, actorType: "control-plane",
          metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseContention } },
        select: { createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (!row) throw new Error(`Episode marker disappeared for ${input.taskId}`);
      startedAt = row.createdAt;
    }
  }
  const bad = input.family === "executor-offline" ? input.answer === "offline"
    : input.family === "train-lease-contention" ? input.answer !== "resolved"
    : input.answer === "contended";
  const alreadyAlerted = startedAt !== null && (offline ? raw.episodeAlerted === true : marker?.state === "alerted");
  let transition: EpisodeResult["transition"];
  if (!bad) transition = startedAt ? "closed" : "none";
  else if (!startedAt) { startedAt = input.now; transition = "opened"; }
  else if (!alreadyAlerted && input.now.getTime() - startedAt.getTime() >= alertWindow[input.family]) transition = "alerted";
  else transition = "continuing";
  if (transition === "none" || transition === "continuing") return { transition, startedAt };
  if (!startedAt) throw new Error(`Episode transition ${transition} has no start`);

  const holder = input.family === "lease-contention" ? input.holder : null;
  const minutes = Math.floor((input.now.getTime() - startedAt.getTime()) / 60_000);
  const detail = input.family === "lease-contention"
    ? `Chain ${input.target.chainId} has been unable to take the merge Lease for ${minutes} minutes; it is held by ${describeHolder(holder)}`
    : `${input.family} on Task ${input.taskId}: ${input.detail ?? input.answer} (${minutes} minutes)`;
  await writeMarker(tx, input.taskId, offline ? "executorOffline" : "leaseContention", {
    actorType: "control-plane",
    body: transition === "closed" ? `${input.family} episode ended: ${input.detail ?? input.answer}` : detail,
    metadata: {
      ...(offline ? {
        state: MERGE_EXECUTOR_OFFLINE_STATE,
        reason: MERGE_EXECUTOR_OFFLINE_REASON,
        ...(input.family === "executor-offline" && input.executorRunnerIds
          ? { executorRunnerIds: input.executorRunnerIds } : {}),
        episodeStartedAt: startedAt.toISOString(),
        episodeClosed: transition === "closed",
        episodeAlerted: transition === "alerted" || alreadyAlerted,
      } : {
        state: transition === "closed" ? "resolved" : transition === "alerted" ? "alerted" : input.answer,
        firstContendedAt: startedAt.toISOString(),
      }),
      ...(input.family === "lease-contention" ? input.target : {}),
      ...(holder ? { holder: holder.holder, holderTask: holder.task, holderReason: holder.reason,
        holderAcquiredAt: holder.acquiredAt, holderLeaseSha: holder.sha } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(transition === "closed" ? { resolvedAt: input.now.toISOString() } : {}),
      ...(transition === "alerted" ? { alertedAt: input.now.toISOString() } : {}),
    },
  });
  if (transition === "alerted") {
    if (input.family === "lease-contention") {
      const acquired = holder ? Date.parse(holder.acquiredAt) : Number.NaN;
      await recordLeaseContention(tx, { target: input.target, taskId: input.taskId,
        holderAcquiredAt: Number.isFinite(acquired) ? new Date(acquired) : null, detail, at: input.now });
    }
    await openOperatorAlert(tx, {
      body: offline ? detail : `${detail}. Inspect with scripts/merge-lease.sh status; if the holder is gone, use scripts/merge-lease.sh steal --human --reason "...".`,
      dedupeKey: input.family === "lease-contention"
        ? `merge-lease-contention:${input.target.chainId}:${startedAt.toISOString()}`
        : `${input.family}:${input.taskId}:${startedAt.toISOString()}`,
    });
  }
  return { transition, startedAt };
};
