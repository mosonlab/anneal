import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  InboxStatus,
  MERGE_TAIL_KIND,
  MergeLeaseEventState,
  PrismaClient,
} from "@anneal/db";

import {
  clearLeaseContention,
  contentionAlertAfterMs,
  noteLeaseContention,
} from "./merge-lease-contention.js";
import { claimReadinessStep } from "./readiness-claim.js";
import { createApp } from "./test-app.js";
import type { MergeLeaseView } from "./routes/merge-lease.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
let sequence = 0;

before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const started = new Date("2026-09-06T11:00:00.000Z");
const minutesAfter = (minutes: number): Date => new Date(started.getTime() + minutes * 60_000);

const holder = {
  holder: "runner@executor",
  task: "chain-holding",
  reason: "chain merge tail chain-holding",
  acquiredAt: "2026-09-06T10:00:00.000Z",
  sha: "b".repeat(40),
};

const seedChain = async () => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({
    data: { name: `Lease contention ${suffix}`, slug: `lease-contention-${suffix}` },
  });
  const chainId = `chain-${suffix}`;
  const task = await db.task.create({ data: {
    projectId: project.id,
    name: "merge readiness",
    description: "merge Lease contention fixture",
    chainId,
    chainIndex: 3,
    chainLayer: 1,
  } });
  // Every write below is fenced by the readiness claim, so the fixture holds a
  // real Handle rather than a stand-in: what a stale worker cannot do is part
  // of the behaviour these cases pin.
  const claim = await claimReadinessStep(db, task.id, started);
  assert.ok(claim, "the fixture task must be claimable");
  return { readinessTaskId: task.id, target: { projectId: project.id, chainId }, claim };
};

/** A worker whose claim has passed to a successor since it read the lease. */
const supersede = async (readinessTaskId: string): Promise<void> => {
  await db.task.update({
    where: { id: readinessTaskId },
    data: {
      readinessClaimToken: "merge-readiness-claim:successor",
      readinessClaimExpiresAt: new Date(started.getTime() + 600_000),
    },
  });
};

const contentionMarkers = async (taskId: string) => await db.taskActivity.findMany({
  where: { taskId, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseContention } },
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
});

const contentionEvents = async (chainId: string) => await db.mergeLeaseEvent.findMany({
  where: { chainId, state: MergeLeaseEventState.CONTENDED },
});

const alerts = async () => await db.inboxMessage.findMany({
  where: { dedupeKey: { startsWith: "merge-lease-contention:" } },
});

// Explicit in every case: the window is configurable, so a host that set
// MERGE_LEASE_CONTENTION_ALERT_MINUTES must not change what these assert.
const WINDOW_MS = contentionAlertAfterMs({ MERGE_LEASE_CONTENTION_ALERT_MINUTES: "30" });

test("the first contention writes the activity naming the holder and alerts nobody", async () => {
  const chain = await seedChain();
  const outcome = await noteLeaseContention(db, {
    target: chain.target,
    readinessTaskId: chain.readinessTaskId,
    holder,
    claim: chain.claim,
    now: started,
  }, WINDOW_MS);

  assert.equal(outcome, "opened");
  const markers = await contentionMarkers(chain.readinessTaskId);
  assert.equal(markers.length, 1);
  const metadata = markers[0]!.metadata as Record<string, unknown>;
  assert.equal(metadata.state, "contended");
  assert.equal(metadata.holder, holder.holder);
  assert.equal(metadata.holderTask, holder.task);
  assert.equal(metadata.holderReason, holder.reason);
  assert.equal(metadata.holderAcquiredAt, holder.acquiredAt);
  assert.equal(metadata.firstContendedAt, started.toISOString());
  assert.match(markers[0]!.body, /held by runner@executor \(task chain-holding/u);
  assert.deepEqual(await contentionEvents(chain.target.chainId), []);
  assert.deepEqual(await alerts(), []);
});

test("contention short of the window repeats neither the activity nor an alert", async () => {
  const chain = await seedChain();
  await noteLeaseContention(db, {
    target: chain.target,
    readinessTaskId: chain.readinessTaskId,
    holder,
    claim: chain.claim,
    now: started,
  }, WINDOW_MS);
  for (const minutes of [1, 10, 29]) {
    assert.equal(
      await noteLeaseContention(db, {
        target: chain.target,
        readinessTaskId: chain.readinessTaskId,
        holder,
        claim: chain.claim,
        now: minutesAfter(minutes),
      }, WINDOW_MS),
      "continuing",
      `${minutes} minutes in`,
    );
  }
  assert.equal((await contentionMarkers(chain.readinessTaskId)).length, 1);
  assert.deepEqual(await contentionEvents(chain.target.chainId), []);
  assert.deepEqual(await alerts(), []);
});

test("contention past the window alerts once, records one event, and steals nothing", async () => {
  const chain = await seedChain();
  await noteLeaseContention(db, {
    target: chain.target,
    readinessTaskId: chain.readinessTaskId,
    holder,
    claim: chain.claim,
    now: started,
  }, WINDOW_MS);

  assert.equal(
    await noteLeaseContention(db, {
      target: chain.target,
      readinessTaskId: chain.readinessTaskId,
      holder,
      claim: chain.claim,
      now: minutesAfter(31),
    }, WINDOW_MS),
    "alerted",
  );

  const events = await contentionEvents(chain.target.chainId);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.owningTaskId, chain.readinessTaskId);
  assert.equal(events[0]!.settledAt?.toISOString(), minutesAfter(31).toISOString());
  assert.equal(events[0]!.acquiredAt?.toISOString(), holder.acquiredAt);
  assert.equal(events[0]!.leaseSha, null);
  assert.match(events[0]!.failureDetail ?? "", /unable to take the merge Lease for 31 minutes/u);

  const opened = await alerts();
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.status, InboxStatus.OPEN);
  assert.match(opened[0]!.body, /steal --human/u);
  assert.equal(opened[0]!.dedupeKey, `merge-lease-contention:${chain.target.chainId}:${started.toISOString()}`);

  // Every later tick of the same episode is silent: one alert per episode.
  for (const minutes of [32, 90]) {
    assert.equal(
      await noteLeaseContention(db, {
        target: chain.target,
        readinessTaskId: chain.readinessTaskId,
        holder,
        claim: chain.claim,
        now: minutesAfter(minutes),
      }, WINDOW_MS),
      "continuing",
    );
  }
  assert.equal((await contentionEvents(chain.target.chainId)).length, 1);
  assert.equal((await alerts()).length, 1);
  const markers = await contentionMarkers(chain.readinessTaskId);
  assert.deepEqual(markers.map((marker) => (marker.metadata as Record<string, unknown>).state), [
    "contended",
    "alerted",
  ]);
});

test("taking the lease ends the episode, and the next contention starts a new one", async () => {
  const chain = await seedChain();
  await noteLeaseContention(db, {
    target: chain.target,
    readinessTaskId: chain.readinessTaskId,
    holder,
    claim: chain.claim,
    now: started,
  }, WINDOW_MS);

  assert.equal(
    await clearLeaseContention(db, {
      target: chain.target,
      readinessTaskId: chain.readinessTaskId,
      claim: chain.claim,
      now: minutesAfter(2),
    }),
    true,
  );
  // A tick that never saw contention has nothing to close.
  assert.equal(
    await clearLeaseContention(db, {
      target: chain.target,
      readinessTaskId: chain.readinessTaskId,
      claim: chain.claim,
      now: minutesAfter(3),
    }),
    false,
  );

  assert.equal(
    await noteLeaseContention(db, {
      target: chain.target,
      readinessTaskId: chain.readinessTaskId,
      holder,
      claim: chain.claim,
      now: minutesAfter(40),
    }, WINDOW_MS),
    "opened",
  );
  // The new episode's window is measured from its own first contention, so the
  // resolved one does not carry a chain across the threshold.
  assert.equal(
    await noteLeaseContention(db, {
      target: chain.target,
      readinessTaskId: chain.readinessTaskId,
      holder,
      claim: chain.claim,
      now: minutesAfter(50),
    }, WINDOW_MS),
    "continuing",
  );
  assert.deepEqual(await contentionEvents(chain.target.chainId), []);
});

test("an episode outlives a burst of unrelated activity on the same task", async () => {
  const chain = await seedChain();
  await noteLeaseContention(db, {
    target: chain.target,
    readinessTaskId: chain.readinessTaskId,
    holder,
    claim: chain.claim,
    now: started,
  }, WINDOW_MS);

  // More rows than the recent-marker window is deep. An episode read through
  // that window would be invisible here, restarting its own 30 minutes on every
  // tick and postponing the alert for as long as the task stays chatty.
  for (let index = 0; index < 25; index += 1) {
    await db.taskActivity.create({ data: {
      taskId: chain.readinessTaskId,
      actorType: "control-plane",
      body: `unrelated activity ${index}`,
    } });
  }

  assert.equal(
    await noteLeaseContention(db, {
      target: chain.target,
      readinessTaskId: chain.readinessTaskId,
      holder,
      claim: chain.claim,
      now: minutesAfter(31),
    }, WINDOW_MS),
    "alerted",
  );
  const opened = await alerts();
  assert.equal(opened.length, 1);
  // Measured from the original first contention, not from a restarted window.
  assert.equal(opened[0]!.dedupeKey, `merge-lease-contention:${chain.target.chainId}:${started.toISOString()}`);
  assert.equal((await contentionEvents(chain.target.chainId)).length, 1);

  // And it stays one alert: the episode is still the same one.
  assert.equal(
    await noteLeaseContention(db, {
      target: chain.target,
      readinessTaskId: chain.readinessTaskId,
      holder,
      claim: chain.claim,
      now: minutesAfter(60),
    }, WINDOW_MS),
    "continuing",
  );
  assert.equal((await alerts()).length, 1);
});

test("a worker that lost the claim records no activity, event, or alert", async () => {
  const chain = await seedChain();
  await supersede(chain.readinessTaskId);

  assert.equal(
    await noteLeaseContention(db, {
      target: chain.target,
      readinessTaskId: chain.readinessTaskId,
      holder,
      claim: chain.claim,
      now: started,
    }, WINDOW_MS),
    "not-owned",
  );
  assert.deepEqual(await contentionMarkers(chain.readinessTaskId), []);
  assert.deepEqual(await contentionEvents(chain.target.chainId), []);
  assert.deepEqual(await alerts(), []);
  // Nor can it close an episode a successor is keeping.
  assert.equal(
    await clearLeaseContention(db, {
      target: chain.target,
      readinessTaskId: chain.readinessTaskId,
      claim: chain.claim,
      now: minutesAfter(1),
    }),
    false,
  );
  assert.deepEqual(await contentionMarkers(chain.readinessTaskId), []);
});

test("a still-open alert from an earlier episode does not silence the next one", async () => {
  const chain = await seedChain();
  const contend = async (minutes: number) => await noteLeaseContention(db, {
    target: chain.target,
    readinessTaskId: chain.readinessTaskId,
    holder,
    claim: chain.claim,
    now: minutesAfter(minutes),
  }, WINDOW_MS);

  await contend(0);
  assert.equal(await contend(31), "alerted");
  // The lease comes back, so the episode ends -- but nobody has read the alert.
  assert.equal(
    await clearLeaseContention(db, {
      target: chain.target,
      readinessTaskId: chain.readinessTaskId,
      claim: chain.claim,
      now: minutesAfter(32),
    }),
    true,
  );
  assert.equal((await alerts()).every((message) => message.status === InboxStatus.OPEN), true);

  await contend(40);
  assert.equal(await contend(71), "alerted");

  const opened = await alerts();
  assert.equal(opened.length, 2, "each episode is announced once, unread or not");
  assert.deepEqual(
    opened.map((message) => message.dedupeKey).sort(),
    [
      `merge-lease-contention:${chain.target.chainId}:${started.toISOString()}`,
      `merge-lease-contention:${chain.target.chainId}:${minutesAfter(40).toISOString()}`,
    ].sort(),
  );
  assert.equal((await contentionEvents(chain.target.chainId)).length, 2);
});

test("a contention the script could not attribute is still recorded and alerted", async () => {
  const chain = await seedChain();
  await noteLeaseContention(db, {
    target: chain.target,
    readinessTaskId: chain.readinessTaskId,
    holder: null,
    claim: chain.claim,
    now: started,
  }, contentionAlertAfterMs({ MERGE_LEASE_CONTENTION_ALERT_MINUTES: "5" }));
  assert.equal(
    await noteLeaseContention(db, {
      target: chain.target,
      readinessTaskId: chain.readinessTaskId,
      holder: null,
      claim: chain.claim,
      now: minutesAfter(6),
    }, contentionAlertAfterMs({ MERGE_LEASE_CONTENTION_ALERT_MINUTES: "5" })),
    "alerted",
  );
  const events = await contentionEvents(chain.target.chainId);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.acquiredAt, null);
  assert.match(events[0]!.failureDetail ?? "", /a holder the lease script could not name/u);
});

test("the lease route answers with the live holder and the recorded contention", async () => {
  const chain = await seedChain();
  await noteLeaseContention(db, {
    target: chain.target,
    readinessTaskId: chain.readinessTaskId,
    holder,
    claim: chain.claim,
    now: started,
  }, WINDOW_MS);
  await noteLeaseContention(db, {
    target: chain.target,
    readinessTaskId: chain.readinessTaskId,
    holder,
    claim: chain.claim,
    now: minutesAfter(31),
  }, WINDOW_MS);

  const operatorToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-dbtest-token";
  try {
    const response = await createApp(db, {
      readMergeLeaseHolder: async () => ({ outcome: "held", holder }),
    }).request("/merge-lease", { headers: { Authorization: "Bearer operator-dbtest-token" } });
    assert.equal(response.status, 200);
    const body = await response.json() as MergeLeaseView;
    assert.equal(body.holder?.holder, holder.holder);
    assert.equal(body.holder?.acquiredAt, holder.acquiredAt);
    assert.ok((body.holder?.ageSeconds ?? -1) >= 0);
    assert.equal(body.unavailable, null);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0]?.state, MergeLeaseEventState.CONTENDED);
    assert.equal(body.events[0]?.chainId, chain.target.chainId);
    assert.match(body.events[0]?.failureDetail ?? "", /unable to take the merge Lease/u);
  } finally {
    if (operatorToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = operatorToken;
  }
});
