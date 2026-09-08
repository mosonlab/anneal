import assert from "node:assert/strict";
import test from "node:test";
import { MERGE_TAIL_KIND, type Prisma } from "@anneal/db";
import { observeEpisode, type EpisodeObservation } from "./merge-tail-episode.js";

const start = new Date("2026-09-01T00:00:00Z");
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
const target = { projectId: "project", chainId: "chain" };
type Row = { id: string; taskId: string; actorType: string; createdAt: Date; metadata: Record<string, unknown> };
const store = () => {
  const rows: Row[] = [];
  const notices: Array<{ dedupeKey: string }> = [];
  const events: unknown[] = [];
  const tx = {
    taskActivity: {
      findFirst: async ({ where }: { where: { taskId: string; actorType?: string;
        metadata: { path: string[]; equals: string } } }) => [...rows].reverse().find((row) => row.taskId === where.taskId
        && (!where.actorType || row.actorType === where.actorType)
        && row.metadata[where.metadata.path[0]!] === where.metadata.equals) ?? null,
      create: async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
        rows.push({ ...data, id: String(rows.length), createdAt: start });
      },
    },
    task: { findUnique: async () => target },
    mergeLeaseEvent: { create: async ({ data }: { data: unknown }) => { events.push(data); return data; } },
    inboxMessage: { create: async ({ data }: { data: { dedupeKey: string } }) => { notices.push(data); } },
    inboxThread: { findFirst: async () => ({ id: "thread" }) },
  } as unknown as Prisma.TransactionClient;
  return { tx, rows, notices, events };
};

const families = ["lease-contention", "train-lease-contention", "executor-offline"] as const;
const observation = (family: typeof families[number], answer: "bad" | "good" | "skipped", minutes: number): EpisodeObservation => {
  const common = { taskId: "task", now: at(minutes) };
  if (family === "executor-offline") return { ...common, family,
    answer: answer === "bad" ? "offline" : answer === "good" ? "online" : "skipped" };
  return { ...common, family, target,
    answer: answer === "bad" ? "contended" : answer === "good" ? "resolved" : "skipped" };
};

for (const family of families) test(`${family}: durable transition table and one notice per episode`, async () => {
  const { tx, rows, notices, events } = store();
  const window = family === "executor-offline" ? 15 : 30;
  for (const [answer, minutes, transition] of [
    ["good", 0, "none"], ["skipped", 0, "none"], ["bad", 0, "opened"],
    ["bad", window - 1, "continuing"], ["skipped", window + 1, "none"],
    ["bad", window + 1, "alerted"], ["bad", window + 2, "continuing"],
    ["good", window + 3, "closed"], ["good", window + 4, "none"],
  ] as const) {
    const result = await observeEpisode(tx, observation(family, answer, minutes));
    assert.equal(result.transition, transition);
    if (transition !== "none") assert.equal(result.startedAt?.toISOString(), start.toISOString());
  }
  assert.equal(rows.length, 3, "only opening, alert and closing write markers");
  assert.equal(notices.length, 1);
  assert.equal(events.length, family === "lease-contention" ? 1 : 0);
  assert.equal(rows[0]!.metadata.kind, family === "executor-offline" ? MERGE_TAIL_KIND.executorOffline : MERGE_TAIL_KIND.leaseContention);
  assert.equal((await observeEpisode(tx, observation(family, "bad", 100))).transition, "opened");
  assert.equal((await observeEpisode(tx, observation(family, "bad", 100 + window))).transition, "alerted");
  assert.equal(notices.length, 2);
  assert.notEqual(notices[0]!.dedupeKey, notices[1]!.dedupeKey);
});

for (const family of ["lease-contention", "train-lease-contention"] as const) {
  test(`${family}: unreachable follows the family's closing rule`, async () => {
    const { tx } = store();
    await observeEpisode(tx, observation(family, "bad", 0));
    const result = await observeEpisode(tx, { taskId: "task", target, family, answer: "unreachable", now: at(1) });
    assert.equal(result.transition, family === "lease-contention" ? "closed" : "continuing");
    const next = await observeEpisode(tx, observation(family, "bad", 31));
    assert.equal(next.transition, family === "lease-contention" ? "opened" : "alerted");
  });
}

for (const family of families) for (const timestamp of [undefined, "invalid"]) {
  test(`${family}: ${timestamp} start uses durable row creation, not this tick`, async () => {
    const { tx, rows } = store();
    rows.push({ id: "old", taskId: "task", actorType: "control-plane", createdAt: start,
      metadata: family === "executor-offline"
        ? { kind: MERGE_TAIL_KIND.readiness, state: "requeued-executor-offline", episodeStartedAt: timestamp }
        : { kind: MERGE_TAIL_KIND.leaseContention, state: "contended", firstContendedAt: timestamp } });
    const result = await observeEpisode(tx, observation(family, "bad", 31));
    assert.equal(result.transition, "alerted");
    assert.equal(result.startedAt?.toISOString(), start.toISOString());
  });
}

test("skipped does not need a store and never answers an outage", async () => {
  for (const family of families) assert.deepEqual(
    await observeEpisode({} as Prisma.TransactionClient, observation(family, "skipped", 100)),
    { transition: "none", startedAt: null },
  );
});

test("an observed stop closes offline state for the existing confirmation reader", async () => {
  const { tx, rows } = store();
  await observeEpisode(tx, observation("executor-offline", "bad", 0));
  assert.equal((await observeEpisode(tx, { taskId: "task", family: "executor-offline", answer: "resolved", now: at(1) })).transition, "closed");
  assert.equal(rows.at(-1)!.metadata.episodeClosed, true);
  assert.equal((await observeEpisode(tx, observation("executor-offline", "bad", 100))).transition, "opened");
});

test("store failures propagate", async () => {
  const failure = new Error("database unavailable");
  const tx = { taskActivity: { findFirst: async () => { throw failure; } } } as unknown as Prisma.TransactionClient;
  await assert.rejects(observeEpisode(tx, observation("lease-contention", "bad", 0)), (error) => error === failure);
});
