import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { openRun, type OpenRunIntent } from "./run-open.js";

const readyAt = new Date("2026-09-07T00:00:00Z");
const intents: OpenRunIntent[] = [
  { kind: "retry", readyAt },
  { kind: "retry-after-lease-loss", readyAt, sourceRunId: "train-run", sourceMaxRunsPerTask: 1, sourceBudgetGrants: 0 },
  { kind: "retry-after-completion", readyAt, sourceRunId: "train-run", sourceMaxRunsPerTask: 1, sourceBudgetGrants: 0, budgetGrant: 1 },
  { kind: "claim-invalidated", readyAt, sourceRunId: "train-run" },
];
for (const intent of intents) {
  test(`a detached merge train cannot open a second Run through ${intent.kind}`, async () => {
    const tx = { task: { findUnique: async () => ({
      id: "train", name: "Merge train", chainId: null, templateStep: null,
      activity: [{ id: "train-marker" }], runs: [{ id: "train-run", runNumber: 1 }],
    }) } } as unknown as Prisma.TransactionClient;
    const result = await openRun(tx, "train", intent);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("unexpected second Run");
    assert.equal(result.refusal.code, "run-budget-exhausted");
    assert.match(result.refusal.message, /merge-train task cannot be retried/u);
  });
}
