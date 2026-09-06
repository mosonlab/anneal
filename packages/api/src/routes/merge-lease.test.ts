import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import { MergeLeaseEventState, type PrismaClient } from "@anneal/db";

import { createApp } from "../test-app.js";
import type { MergeLeaseHolderReader } from "../merge-lease.js";
import type { MergeLeaseView } from "./merge-lease.js";
import { withTokens } from "./test-support.js";

const contendedEvent = {
  id: "event-1",
  projectId: "project-1",
  chainId: "chain-42",
  leaseRef: null,
  leaseSha: null,
  state: MergeLeaseEventState.CONTENDED,
  owningTaskId: "task-1",
  handedOffRunId: null,
  handedOffAt: null,
  deferredAt: null,
  settledAt: new Date("2026-09-06T12:00:00.000Z"),
  acquiredAt: new Date("2026-09-06T10:30:00.000Z"),
  failureDetail: "Chain chain-42 has been unable to take the merge Lease for 31 minutes",
  createdAt: new Date("2026-09-06T12:00:00.000Z"),
  updatedAt: new Date("2026-09-06T12:00:00.000Z"),
};

const ledger = (events: unknown[]): PrismaClient => ({
  mergeLeaseEvent: { findMany: async () => events },
}) as unknown as PrismaClient;

const readLease = async (
  reader: MergeLeaseHolderReader,
  events: unknown[] = [contendedEvent],
): Promise<{ status: number; body: MergeLeaseView }> => {
  let answered: { status: number; body: MergeLeaseView } | null = null;
  await withTokens(async () => {
    const response = await createApp(ledger(events), { readMergeLeaseHolder: reader }).request("/merge-lease", {
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    answered = { status: response.status, body: await response.json() as MergeLeaseView };
  });
  return answered!;
};

test("the lease route names the holder, its age, and the recent ledger", async () => {
  const { status, body } = await readLease(async () => ({
    outcome: "held",
    holder: {
      holder: "runner@executor",
      task: "chain-9",
      reason: "chain merge tail chain-9",
      acquiredAt: new Date(Date.now() - 90_000).toISOString(),
      sha: "a".repeat(40),
    },
  }));
  assert.equal(status, 200);
  assert.equal(body.holder?.holder, "runner@executor");
  assert.equal(body.holder?.task, "chain-9");
  assert.ok(body.holder!.ageSeconds! >= 90 && body.holder!.ageSeconds! < 120, String(body.holder?.ageSeconds));
  assert.equal(body.unavailable, null);
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0]?.state, MergeLeaseEventState.CONTENDED);
  assert.equal(body.events[0]?.acquiredAt, "2026-09-06T10:30:00.000Z");
});

test("no lease held is a holder of none rather than a failure", async () => {
  const { status, body } = await readLease(async () => ({ outcome: "none" }), []);
  assert.equal(status, 200);
  assert.equal(body.holder, null);
  assert.equal(body.unavailable, null);
  assert.deepEqual(body.events, []);
});

test("an origin the route could not read is said out loud, with the ledger still answered", async () => {
  const { status, body } = await readLease(async () => ({
    outcome: "unreachable",
    detail: "merge-lease: could not read refs/merge-lease/holder from origin",
  }));
  assert.equal(status, 200);
  assert.equal(body.holder, null);
  assert.match(body.unavailable ?? "", /could not read refs\/merge-lease\/holder/u);
  assert.equal(body.events.length, 1);
});

test("the lease route is closed to an unauthenticated caller", async () => {
  await withTokens(async () => {
    const response = await createApp(ledger([])).request("/merge-lease");
    assert.equal(response.status, 401);
  });
});
