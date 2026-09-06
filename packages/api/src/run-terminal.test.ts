import assert from "node:assert/strict";
import test from "node:test";

import { CleanupStatus, RunStatus } from "@anneal/db";

import { terminalFieldsFor, type TerminalOutcome } from "./run-terminal.js";

const at = new Date("2026-08-27T12:00:00.000Z");
const reason = "terminal reason";

const cases: Array<{
  name: string;
  outcome: TerminalOutcome;
  run: string[];
  session: string[];
}> = [
  {
    name: "cancelled",
    outcome: { kind: "cancelled", requestId: "cancel-1", cleanupConfirmed: true, activity: "acknowledged" },
    run: [
      "status", "endedAt", "leaseExpiresAt", "sessionTokenRevokedAt", "cancelAcknowledgedAt",
      "failureClass", "failureReason", "terminationReason", "retryable", "retryAt", "workspaceRetained",
    ],
    session: [
      "executionStatus", "cleanupStatus", "endedAt", "cleanupEndedAt", "failureReason", "terminationReason",
    ],
  },
  {
    name: "lost",
    outcome: { kind: "lost", where: { id: "run-1" }, reason, maxRunsPerTask: 4, budgetGrants: 1 },
    run: [
      "status", "endedAt", "leaseExpiresAt", "sessionTokenRevokedAt", "failureClass", "retryable",
      "maxRunsPerTask", "budgetGrants", "failureReason",
    ],
    session: ["executionStatus", "cleanupStatus", "endedAt", "failureReason"],
  },
  {
    name: "timed-out",
    outcome: { kind: "timed-out", sessionId: "session-1", waitingOnMessageId: "message-1", taskId: "task-1", reason },
    run: ["status", "endedAt", "retryable", "failureClass", "failureReason"],
    session: ["executionStatus", "cleanupStatus", "endedAt", "cleanupEndedAt", "failureReason"],
  },
  {
    name: "completed",
    outcome: {
      kind: "completed",
      where: { id: "run-1" },
      status: RunStatus.SUCCEEDED,
      run: { retryable: false },
      sessionId: "session-1",
      session: { cleanupStatus: CleanupStatus.SUCCEEDED },
    },
    run: ["status", "endedAt", "leaseExpiresAt", "sessionTokenRevokedAt", "retryable"],
    session: ["executionStatus", "endedAt", "cleanupEndedAt", "cleanupStatus"],
  },
];

for (const row of cases) {
  test(`${row.name} writes exactly its Run and Session terminal fields`, () => {
    const fields = terminalFieldsFor(row.outcome, at);
    assert.deepEqual(Object.keys(fields.run), row.run);
    assert.deepEqual(Object.keys(fields.session), row.session);
  });
}
