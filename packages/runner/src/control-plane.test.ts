import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_EVENT_CONVERSATION_ID_MAX_CHARS,
  SESSION_EVENTS_REQUEST_TOO_LARGE_CODE,
} from "@anneal/db/session-event-limits";

import {
  authorityFor,
  claimRefusedByDispatchDrain,
  ControlPlaneError,
  isEventsRequestTooLarge,
  openRunSession,
  retriableStartupError,
  type ClaimedTask,
  type ControlPlane,
  type RunSessionClaim,
} from "./api.js";
import { pollForTask } from "./runner.js";

const session = (apiUrl = "http://anneal.test") => openRunSession(
  { apiUrl, runnerToken: "runner-token", apiTimeoutMs: 1000 } as never,
  { run: { id: "run-1" }, fencingToken: "fence", sessionToken: "session-token" } satisfies RunSessionClaim,
);

test("ControlPlaneError classifies Run authority without leaking HTTP casts to callers", () => {
  assert.deepEqual(authorityFor(new ControlPlaneError(409, "stale fence")), {
    held: false,
    reason: "revoked",
  });
  assert.deepEqual(authorityFor(new ControlPlaneError(409, "suspended", "WAITING_INBOX")), {
    held: false,
    reason: "waiting-inbox",
  });
  assert.deepEqual(authorityFor(new ControlPlaneError(503, "unavailable")), { held: true });
  assert.deepEqual(authorityFor(new Error("connection reset")), { held: true });
});

test("heartbeat cancellation is an Authority verdict with its durable request", async () => {
  const request = { requestId: "cancel-1", reason: "operator stop", requestedAt: new Date(0).toISOString() };
  const originalFetch = globalThis.fetch;
  const answer = (body: unknown): void => {
    globalThis.fetch = async () => new Response(JSON.stringify(body), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  const progress = { processAlive: true, lastProgressEventAt: null, inFlightTool: null, eventQueueBytes: 0 };
  try {
    answer({ ok: false, cancellation: request });
    assert.deepEqual(await session().heartbeat(progress), { held: false, reason: "cancelled", request });
    answer({ ok: true, cancellation: null });
    assert.deepEqual(await session().heartbeat(progress), { held: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("startup retries only transport failures and control-plane server errors", () => {
  assert.equal(retriableStartupError(new Error("connection reset")), true);
  assert.equal(retriableStartupError(new ControlPlaneError(503, "unavailable")), true);
  assert.equal(retriableStartupError(new ControlPlaneError(401, "unauthorized")), false);
  assert.equal(retriableStartupError(new ControlPlaneError(409, "refused")), false);
});

const answerWith = (task: unknown): (() => void) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ task }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  return () => { globalThis.fetch = originalFetch; };
};

test("session status reads the decided output evidence without re-deciding it", async () => {
  const outputs = ["implementation", "sol-findings", "blind-findings", "fixed-implementation"]
    .map((kind, index) => ({
      taskId: `task-${kind}`,
      chainIndex: index + 1,
      kind,
      body: JSON.stringify({ schemaVersion: 1, kind }),
      commitSha: index === 3 ? "d".repeat(64) : String(index + 1).repeat(40),
    }));
  const evidence = {
    satisfaction: { case: "delivered", output: { kind: "fixed-implementation", commitSha: outputs[3]!.commitSha } },
    prHandoff: { case: "complete", outputs },
  };
  const restore = answerWith({ outputEvidence: evidence });
  try {
    assert.deepEqual(await session().outputStatus(), evidence);
  } finally {
    restore();
  }
});

test("a Run without a task has no output evidence to read", async () => {
  const restore = answerWith(null);
  try {
    assert.equal(await session().outputStatus(), null);
  } finally {
    restore();
  }
});

test("session status refuses a payload that is not the decided answer", async () => {
  for (const outputEvidence of [
    undefined,
    { satisfaction: { case: "delivered" }, prHandoff: { case: "not-a-pr-delivery" } },
    {
      satisfaction: { case: "not-required" },
      prHandoff: {
        case: "complete",
        outputs: [{ taskId: "t", chainIndex: 1, kind: "implementation", body: "{}", commitSha: "not-a-sha" }],
      },
    },
  ]) {
    const restore = answerWith({ outputEvidence });
    try {
      await assert.rejects(session().outputStatus(), /invalid task output status/u);
    } finally {
      restore();
    }
  }
});

test("a dispatch drain is a poll outcome rather than a claim failure", async () => {
  const drained = new ControlPlaneError(
    409,
    JSON.stringify({ error: "Dispatch is draining for a pending deploy (quiet-window-wait-exceeded)", reason: "dispatch-draining", code: "dispatch-draining", expiresAt: new Date(0).toISOString() }),
    "dispatch-draining",
  );
  assert.equal(claimRefusedByDispatchDrain(drained), true);
  assert.equal(claimRefusedByDispatchDrain(new ControlPlaneError(409, "stale fence")), false);
  assert.equal(claimRefusedByDispatchDrain(new ControlPlaneError(503, "unavailable", "dispatch-draining")), false);

  const pollWith = (claim: () => Promise<ClaimedTask | null>): Promise<string> =>
    pollForTask({} as never, { claim } as unknown as ControlPlane);
  assert.equal(await pollWith(async () => { throw drained; }), "draining");
  assert.equal(await pollWith(async () => null), "idle");
  // Every other refusal still reaches the loop's error path.
  await assert.rejects(pollWith(async () => { throw new ControlPlaneError(409, "stale fence"); }), /Anneal API 409/u);
});

test("an events envelope never carries a provider conversation id past its cap", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const event = { seq: 0, at: new Date(0).toISOString(), source: "CLAUDE" as const, type: "MODEL_DELTA", payload: { text: "hi" } };
  try {
    const legal = "t".repeat(SESSION_EVENT_CONVERSATION_ID_MAX_CHARS);
    await session().emit([event], legal);
    await session().emit([event], `${legal}x`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(bodies[0]?.["providerConversationId"], "t".repeat(SESSION_EVENT_CONVERSATION_ID_MAX_CHARS));
  // The body cap is the batch cap plus a fixed envelope allowance, so an
  // identifier the provider grew without limit would refuse a legal batch for
  // something no smaller batch can fix. Dropped, not truncated: a mangled
  // identifier reads as a real one.
  assert.equal(bodies[1]?.["providerConversationId"], null, "an identifier past the cap is not sent at all");
});

test("only the whole-request refusal is answered by sending less", () => {
  assert.equal(
    isEventsRequestTooLarge(new ControlPlaneError(413, "too large", SESSION_EVENTS_REQUEST_TOO_LARGE_CODE)),
    true,
  );
  assert.equal(isEventsRequestTooLarge(new ControlPlaneError(413, "too large", "EVENT_PAYLOAD_TOO_LARGE")), false);
  assert.equal(isEventsRequestTooLarge(new ControlPlaneError(503, "unavailable")), false);
  assert.equal(isEventsRequestTooLarge(new Error("connection reset")), false);
});
