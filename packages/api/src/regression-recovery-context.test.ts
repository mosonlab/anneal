import assert from "node:assert/strict";
import test from "node:test";

import { MERGE_TAIL_KIND, type Prisma } from "@anneal/db";

import {
  parseRegressionRecoveryContext,
  regressionRecoveryContextForClaim,
} from "./regression-recovery-context.js";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);

const output = {
  runId: "prior-run",
  kind: "regression-verification-v2",
  body: "{\"schemaVersion\":2}",
  commitSha: HEAD,
};

const marker = (overrides: Record<string, unknown> = {}): Prisma.JsonObject => ({
  kind: MERGE_TAIL_KIND.baseDriftRecovery,
  schemaVersion: 1,
  state: "queued",
  currentBaseSha: BASE,
  authorizedHeadSha: HEAD,
  recoveryRunId: "recovery-run",
  priorOutput: output,
  ...overrides,
});

test("a queued recovery marker parses into the claim contract", () => {
  assert.deepEqual(parseRegressionRecoveryContext(marker(), "recovery-run"), {
    state: "queued",
    currentBaseSha: BASE,
    authorizedHeadSha: HEAD,
    recoveryRunId: "recovery-run",
    priorOutput: output,
  });
});

test("a recovery marker is bound to the exact Run and latest state", async () => {
  const findFirst = async ({ orderBy }: { orderBy: unknown }) => {
    assert.deepEqual(orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
    return { metadata: marker() };
  };
  const tx = { taskActivity: { findFirst } } as unknown as Prisma.TransactionClient;

  assert.deepEqual(
    await regressionRecoveryContextForClaim(tx, { taskId: "regression-task", runId: "recovery-run" }),
    parseRegressionRecoveryContext(marker(), "recovery-run"),
  );
  assert.equal(
    await regressionRecoveryContextForClaim(tx, { taskId: "regression-task", runId: "different-run" }),
    null,
  );
});

test("a marker without the captured output or with a non-queued state is ignored", () => {
  assert.equal(parseRegressionRecoveryContext(marker({ priorOutput: {} }), "recovery-run"), null);
  assert.equal(parseRegressionRecoveryContext(marker({ state: "readiness-requeued" }), "recovery-run"), null);
});
