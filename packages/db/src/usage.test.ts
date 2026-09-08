import assert from "node:assert/strict";
import test from "node:test";

import { deriveUsageColumns, extractUsage, sumSessionEventUsage, sumSessionUsage, sumUsage } from "./usage.js";

type StoredSessionEvent = {
  child: string;
  type: "FINAL_OUTPUT" | "PROVIDER_RAW";
  payload: unknown;
};

const deriveFinalOutputUsage = (events: StoredSessionEvent[]) => deriveUsageColumns(
  sumUsage(
    events
      .filter((event) => event.type === "FINAL_OUTPUT")
      .map((event) => extractUsage(event.payload)),
  ),
);

const turnCompleted = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({
  type: "turn.completed",
  usage: { input_tokens: inputTokens, cached_input_tokens: cachedInputTokens, output_tokens: outputTokens },
});

const claudeResult = (
  sessionId: string,
  totalCostUsd: number,
  inputTokens: number,
  outputTokens: number,
  invocationOutputTokens = outputTokens,
) => ({
  type: "result",
  session_id: sessionId,
  total_cost_usd: totalCostUsd,
  // The top-level block is per invocation. Keeping it deliberately different
  // from the cumulative model breakdown makes accidental summing of both
  // sources visible in the assertions below.
  usage: { input_tokens: 1, output_tokens: invocationOutputTokens },
  modelUsage: {
    "claude-opus": { inputTokens, outputTokens },
  },
});

test("sums each child's FINAL_OUTPUT once", () => {
  const events: StoredSessionEvent[] = [
    { child: "provider-child-1", type: "FINAL_OUTPUT", payload: turnCompleted(100, 25, 10) },
    { child: "provider-child-2", type: "FINAL_OUTPUT", payload: turnCompleted(200, 50, 20) },
  ];

  const derived = deriveFinalOutputUsage(events);

  assert.deepEqual(
    {
      inputTokens: derived.inputTokens,
      outputTokens: derived.outputTokens,
      totalTokens: derived.totalTokens,
    },
    { inputTokens: 300, outputTokens: 30, totalTokens: 330 },
  );
});

test("an interrupted child with no FINAL_OUTPUT contributes no usage", () => {
  const resumedChildOutput = turnCompleted(200, 50, 20);
  const events: StoredSessionEvent[] = [
    // The provider payload may contain usage, but without the adapter's
    // FINAL_OUTPUT row it must not enter session usage aggregation.
    { child: "interrupted-provider-child", type: "PROVIDER_RAW", payload: turnCompleted(900, 300, 90) },
    { child: "resumed-provider-child", type: "FINAL_OUTPUT", payload: resumedChildOutput },
  ];

  const derived = deriveFinalOutputUsage(events);

  assert.deepEqual(
    {
      inputTokens: derived.inputTokens,
      outputTokens: derived.outputTokens,
      totalTokens: derived.totalTokens,
    },
    { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
  );
});

test("sumSessionUsage selects the latest cumulative Claude result for one provider session", () => {
  const events = [
    claudeResult("provider-session", 1, 100, 10, 1),
    claudeResult("provider-session", 2, 200, 20, 2),
    claudeResult("provider-session", 3, 300, 30, 3),
  ];

  const derived = deriveUsageColumns(sumSessionUsage(events));

  assert.equal(derived.inputTokens, 300);
  assert.equal(derived.outputTokens, 30);
  assert.equal(derived.totalTokens, 330);
  assert.equal(derived.costUsd?.toString(), "3");
});

test("sumSessionUsage adds latest cumulative totals from different Claude sessions", () => {
  const events = [
    claudeResult("provider-session-a", 1, 100, 10),
    claudeResult("provider-session-a", 2, 200, 20),
    claudeResult("provider-session-b", 4, 400, 40),
    claudeResult("provider-session-b", 8, 800, 80),
  ];

  const derived = deriveUsageColumns(sumSessionUsage(events));

  assert.equal(derived.inputTokens, 1_000);
  assert.equal(derived.outputTokens, 100);
  assert.equal(derived.totalTokens, 1_100);
  assert.equal(derived.costUsd?.toString(), "10");
});

test("sumSessionUsage leaves a single Claude result unchanged", () => {
  const event = claudeResult("provider-session", 1.25, 100, 10);

  assert.deepEqual(sumSessionUsage([event]), extractUsage(event));
});

test("sumSessionUsage keeps top-level Claude usage per invocation when modelUsage is unavailable", () => {
  const events = [
    {
      type: "result",
      session_id: "provider-session",
      total_cost_usd: 1,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
    {
      type: "result",
      session_id: "provider-session",
      total_cost_usd: 2,
      usage: { input_tokens: 20, output_tokens: 2 },
    },
  ];

  const derived = deriveUsageColumns(sumSessionUsage(events));

  assert.equal(derived.inputTokens, 30);
  assert.equal(derived.outputTokens, 3);
  assert.equal(derived.totalTokens, 33);
  assert.equal(derived.costUsd?.toString(), "2");
});

test("sumSessionUsage leaves PI usage additive even with an incidental session_id", () => {
  const event = {
    type: "result",
    session_id: "not-a-claude-session",
    agentosPiUsage: { input: 10, output: 2, costNanoUsd: 1_000_000_000 },
  };

  const total = sumSessionUsage([event, event]);

  assert.equal(total.inputTokens, 20);
  assert.equal(total.outputTokens, 4);
  assert.equal(total.costUsd?.toString(), "2");
});

for (const modelUsage of [undefined, {}, { "claude-opus": { costUSD: 2 } }]) {
  test(`sumSessionUsage retains later fallback tokens then replaces them with a cumulative snapshot (${JSON.stringify(modelUsage)})`, () => {
    const events = [
      {
        ...claudeResult("provider-session", 1, 100, 10),
        modelUsage: { "claude-opus": { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      },
      {
        type: "result",
        session_id: "provider-session",
        total_cost_usd: 2,
        modelUsage,
        usage: { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
      },
    ];
    const fallback = sumSessionUsage(events);
    assert.equal(fallback.inputTokens, 128);
    assert.equal(fallback.outputTokens, 12);
    assert.equal(fallback.cachedInputTokens, 5);
    assert.equal(fallback.cacheCreationInputTokens, 3);
    assert.equal(fallback.costUsd?.toString(), "2");

    const snapshot = claudeResult("provider-session", 3, 150, 15);
    assert.deepEqual(sumSessionUsage([...events, snapshot]), extractUsage(snapshot));
  });
}

test("sumSessionUsage groups Claude results when an unusable PI block does not claim them", () => {
  const events = [1, 2].map((cost) => ({
    ...claudeResult("provider-session", cost, cost * 100, cost * 10),
    agentosPiUsage: {},
  }));
  assert.deepEqual(sumSessionUsage(events), extractUsage(events[1]));
});

for (const sessionId of [undefined, "", 123]) {
  test(`sumSessionUsage diagnoses additive Claude results with unusable session_id (${JSON.stringify(sessionId)})`, (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const event = { ...claudeResult("unused", 1, 100, 10), session_id: sessionId };
    const total = sumSessionUsage([event, event]);
    assert.equal(total.inputTokens, 200);
    assert.equal(total.outputTokens, 20);
    assert.equal(total.costUsd?.toString(), "2");
    assert.equal(warn.mock.callCount(), 2);
    for (const call of warn.mock.calls) {
      assert.match(String(call.arguments[0]), /Claude.*session_id.*additive/);
    }
  });
}

for (const resumedCost of [0.556285, 12]) {
  test(`sumSessionEventUsage adds resumed process totals regardless of counter direction (${resumedCost})`, () => {
    const first = claudeResult("same-session", 7.69342375, 100, 10);
    const final = (payload: unknown) => ({ type: "FINAL_OUTPUT", payload });
    const events = [
      // Legacy events before the first recorded start still count.
      final(first),
      final({ ...first, uuid: "different-result", origin: { kind: "task-notification" } }),
      { type: "PROCESS_STARTED", payload: {} },
      final({ type: "result", session_id: "same-session", total_cost_usd: 0, modelUsage: {},
        origin: { kind: "task-notification" } }),
      final(claudeResult("same-session", resumedCost, 200, 20)),
      final(claudeResult("fresh-session", 1, 50, 5)),
      // A failed launch with no final output cannot erase completed usage.
      { type: "PROCESS_STARTED", payload: {} },
      { type: "PROVIDER_RAW", payload: claudeResult("same-session", 999, 999, 999) },
    ];
    const actual = deriveUsageColumns(sumSessionEventUsage(events));
    assert.equal(actual.inputTokens, 350);
    assert.equal(actual.outputTokens, 35);
    assert.equal(actual.costUsd?.toNumber(), Number((7.69342375 + resumedCost + 1).toFixed(4)));
    assert.deepEqual(deriveUsageColumns(sumSessionEventUsage(events)), actual);
  });
}

test("sumSessionEventUsage respects latest cost within a process without guessing resets", () => {
  const events = [
    { type: "FINAL_OUTPUT", payload: claudeResult("same", 8, 100, 10) },
    { type: "FINAL_OUTPUT", payload: { type: "result", session_id: "same", total_cost_usd: 0,
      origin: { kind: "task-notification" } } },
  ];
  assert.equal(deriveUsageColumns(sumSessionEventUsage(events)).costUsd?.toString(), "0");
});
