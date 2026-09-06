import assert from "node:assert/strict";
import test from "node:test";

import { NO_SESSION_FILTERS, type SessionListFilters } from "@anneal/db/session-filter-contract";

import { sessionListWhere } from "./session-list-query.js";

const filters = (named: Partial<SessionListFilters>): SessionListFilters => ({ ...NO_SESSION_FILTERS, ...named });

const before = new Date("2026-08-16T00:00:00.000Z");

test("a request naming no filter asks exactly what the unfiltered list asked", () => {
  // deepEqual, not a key-by-key read: an absent filter must leave its key out
  // rather than set it to undefined, so a later regression cannot pass here.
  assert.deepEqual(sessionListWhere(NO_SESSION_FILTERS, {}), {});
  assert.deepEqual(sessionListWhere(NO_SESSION_FILTERS, { projectId: "p", before }), {
    projectId: "p",
    requestedAt: { lt: before },
  });
  assert.deepEqual(sessionListWhere(NO_SESSION_FILTERS, { projectId: "", before: null }), {});
  // The route keeps tolerating an unparseable cursor by dropping it.
  assert.deepEqual(sessionListWhere(NO_SESSION_FILTERS, { before: new Date("not-a-date") }), {});
});

test("each filter narrows exactly one thing", () => {
  assert.deepEqual(sessionListWhere(filters({ status: "live" }), {}), {
    executionStatus: { in: ["REQUESTED", "PROVISIONING", "RUNNING", "WAITING_INBOX"] },
  });
  assert.deepEqual(sessionListWhere(filters({ status: "done" }), {}), {
    executionStatus: { in: ["SUCCEEDED"] },
  });
  assert.deepEqual(sessionListWhere(filters({ status: "failed" }), {}), {
    executionStatus: { in: ["FAILED", "TIMED_OUT", "LOST"] },
  });
  assert.deepEqual(sessionListWhere(filters({ status: "cancelled" }), {}), {
    executionStatus: { in: ["CANCELLED"] },
  });
  assert.deepEqual(sessionListWhere(filters({ agentId: "agent-1" }), {}), { agentId: "agent-1" });
  assert.deepEqual(sessionListWhere(filters({ runner: "CODEX" }), {}), { runner: "CODEX" });
  assert.deepEqual(sessionListWhere(filters({ taskId: "task-1" }), {}), { taskId: "task-1" });
  assert.deepEqual(sessionListWhere(filters({ chainId: "chain-1" }), {}), { task: { chainId: "chain-1" } });
  assert.deepEqual(sessionListWhere(filters({ since: "2026-08-01T00:00:00.000Z" }), {}), {
    requestedAt: { gte: new Date("2026-08-01T00:00:00.000Z") },
  });
  assert.deepEqual(sessionListWhere(filters({ until: "2026-08-31T00:00:00.000Z" }), {}), {
    requestedAt: { lte: new Date("2026-08-31T00:00:00.000Z") },
  });
});

test("q searches the task name, the run branch and the failure reason, case-insensitively", () => {
  assert.deepEqual(sessionListWhere(filters({ q: "Gate" }), {}), {
    OR: [
      { task: { name: { contains: "Gate", mode: "insensitive" } } },
      { run: { branch: { contains: "Gate", mode: "insensitive" } } },
      { failureReason: { contains: "Gate", mode: "insensitive" } },
    ],
  });
});

test("the cursor and the range merge into one requestedAt filter", () => {
  assert.deepEqual(
    sessionListWhere(
      filters({ since: "2026-08-01T00:00:00.000Z", until: "2026-08-31T00:00:00.000Z" }),
      { before },
    ),
    {
      requestedAt: {
        lt: before,
        gte: new Date("2026-08-01T00:00:00.000Z"),
        lte: new Date("2026-08-31T00:00:00.000Z"),
      },
    },
  );
});

test("filters combine with the scope by AND", () => {
  assert.deepEqual(
    sessionListWhere(
      filters({ status: "failed", agentId: "agent-1", runner: "CLAUDE", taskId: "task-1", chainId: "chain-1", q: "flake" }),
      { projectId: "p", before },
    ),
    {
      projectId: "p",
      requestedAt: { lt: before },
      executionStatus: { in: ["FAILED", "TIMED_OUT", "LOST"] },
      agentId: "agent-1",
      runner: "CLAUDE",
      taskId: "task-1",
      task: { chainId: "chain-1" },
      OR: [
        { task: { name: { contains: "flake", mode: "insensitive" } } },
        { run: { branch: { contains: "flake", mode: "insensitive" } } },
        { failureReason: { contains: "flake", mode: "insensitive" } },
      ],
    },
  );
});
