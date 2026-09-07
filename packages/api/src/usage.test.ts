import assert from "node:assert/strict";
import test from "node:test";

import {
  Prisma, deriveUsageColumns, extractUsage, recomputeSessionUsage, sessionUsageLockKey, sumUsage,
  type PrismaClient, type SessionUsage,
} from "@anneal/db";

// Fixtures are the COMPLETE `result` objects pasted from
// spikes/cli-capabilities/samples/, nothing trimmed — regenerate with:
//
//   node -e 'const fs=require("node:fs");for(const f of ["claude-tool-event","claude-start-safe-mode"]){
//     const o=fs.readFileSync(`spikes/cli-capabilities/samples/${f}.stdout`,"utf8")
//       .split("\n").filter(Boolean).map(JSON.parse).find(x=>x.type==="result");
//     console.log(JSON.stringify(o,null,2));}'
//
// Completeness is the point, not tidiness. The previous fixture kept only the
// top-level `usage` block, which made these tests certify the very bug batch 4
// FIXES exists to fix: it has no `modelUsage`, so it could not show that the
// top-level object describes one model out of two. The captures are evidence —
// if an assertion disagrees with one, the code is wrong, never the capture.
const CLAUDE_RESULT = {
  "is_error": false,
  "duration_api_ms": 8945,
  "num_turns": 2,
  "stop_reason": "end_turn",
  "session_id": "12a8ac5d-9577-4c38-a5a3-c4b766398e19",
  "total_cost_usd": 0.049117,
  "usage": {
    "input_tokens": 4,
    "cache_creation_input_tokens": 4436,
    "cache_read_input_tokens": 4332,
    "output_tokens": 77,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard",
    "cache_creation": { "ephemeral_1h_input_tokens": 4436, "ephemeral_5m_input_tokens": 0 },
    "inference_geo": "not_available",
    "iterations": [
      {
        "input_tokens": 2,
        "output_tokens": 3,
        "cache_read_input_tokens": 4332,
        "cache_creation_input_tokens": 104,
        "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 104 },
        "type": "message",
      },
    ],
    "speed": "standard",
  },
  "modelUsage": {
    "claude-haiku-4-5-20251001": {
      "inputTokens": 541,
      "outputTokens": 21,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 0,
      "webSearchRequests": 0,
      "costUSD": 0.000646,
      "contextWindow": 200000,
      "maxOutputTokens": 32000,
      "canonicalModel": "claude-haiku-4-5",
      "provider": "firstParty",
    },
    "claude-opus-5": {
      "inputTokens": 4,
      "outputTokens": 77,
      "cacheReadInputTokens": 4332,
      "cacheCreationInputTokens": 4436,
      "webSearchRequests": 0,
      "costUSD": 0.048471,
      "contextWindow": 1000000,
      "maxOutputTokens": 64000,
      "canonicalModel": "claude-opus-5",
      "provider": "firstParty",
    },
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "fast_mode_disabled_reason": "sdk_opt_in_required",
  "subtype": "success",
  "api_error_status": null,
  "result": "3",
  "ttft_ms": 3900,
  "ttft_stream_ms": 3007,
  "time_to_request_ms": 45,
  "type": "result",
  "duration_ms": 6034,
  "uuid": "eb7bc883-dc0d-461e-b866-99857085d837",
};

/** The second capture, `claude-start-safe-mode.stdout`. A different session with
 *  the same two models, so the extractor is checked against more than one shape
 *  of the same phenomenon. */
const CLAUDE_RESULT_SAFE_MODE = {
  "is_error": false,
  "duration_api_ms": 6948,
  "num_turns": 1,
  "stop_reason": "end_turn",
  "session_id": "cca5c95f-42dd-4752-bc30-ac78af163ef2",
  "total_cost_usd": 0.030392999999999996,
  "usage": {
    "input_tokens": 2,
    "cache_creation_input_tokens": 2969,
    "cache_read_input_tokens": 0,
    "output_tokens": 3,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard",
    "cache_creation": { "ephemeral_1h_input_tokens": 2969, "ephemeral_5m_input_tokens": 0 },
    "inference_geo": "not_available",
    "iterations": [
      {
        "input_tokens": 2,
        "output_tokens": 3,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 2969,
        "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 2969 },
        "type": "message",
      },
    ],
    "speed": "standard",
  },
  "modelUsage": {
    "claude-haiku-4-5-20251001": {
      "inputTokens": 533,
      "outputTokens": 17,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 0,
      "webSearchRequests": 0,
      "costUSD": 0.0006180000000000001,
      "contextWindow": 200000,
      "maxOutputTokens": 32000,
      "canonicalModel": "claude-haiku-4-5",
      "provider": "firstParty",
    },
    "claude-opus-5": {
      "inputTokens": 2,
      "outputTokens": 3,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 2969,
      "webSearchRequests": 0,
      "costUSD": 0.029774999999999996,
      "contextWindow": 1000000,
      "maxOutputTokens": 64000,
      "canonicalModel": "claude-opus-5",
      "provider": "firstParty",
    },
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "fast_mode_disabled_reason": "sdk_opt_in_required",
  "subtype": "success",
  "api_error_status": null,
  "result": "2",
  "ttft_ms": 4016,
  "ttft_stream_ms": 3465,
  "time_to_request_ms": 23,
  "type": "result",
  "duration_ms": 4114,
  "uuid": "75cac3cf-3b6d-40ae-9c48-fa5fdf83fc42",
};

/** Runs `operation` with `console.warn` captured, so a test can assert that a
 *  rejected value announced itself rather than vanishing silently. */
const withCapturedWarnings = async <T>(operation: () => T | Promise<T>): Promise<{ result: T; warnings: string[] }> => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    return { result: await operation(), warnings };
  } finally {
    console.warn = original;
  }
};

const CODEX_TURN_COMPLETED = {
  type: "turn.completed",
  usage: { input_tokens: 40764, cached_input_tokens: 35072, cache_write_input_tokens: 0, output_tokens: 253, reasoning_output_tokens: 77 },
};

const PI_AGENT_SETTLED = { type: "agent_settled" };

// What the runner's PI parser attaches to that same terminal event once it has
// summed the session's per-message usage. Numbers are the real ones from the
// 2026-08-25 pi 0.84.2 capture the runner test carries: two assistant messages
// of 4620/19 and 1068/5 tokens, the second reading 3584 tokens from cache.
const PI_AGENT_SETTLED_WITH_USAGE = {
  type: "agent_settled",
  agentosPiUsage: {
    messages: 2,
    reported: 2,
    input: 5688,
    output: 24,
    cacheRead: 3584,
    cacheWrite: 0,
    // Integer nano-USD: the runner cannot reach Prisma.Decimal, so it sums the
    // per-message costs in an exact integer domain instead of in doubles.
    costNanoUsd: 1_238_080,
  },
};

type SessionColumns = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalTokens: number | null;
  costUsd: Prisma.Decimal | null;
};

const emptyColumns = (): SessionColumns =>
  ({
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    totalTokens: null,
    costUsd: null,
  });

/** A Prisma stub holding one session's columns in memory, so a second
 * recompute observes what the first one wrote. */
const stubDatabase = (payloads: unknown[], columns: SessionColumns) => {
  const updates: SessionColumns[] = [];
  const database = {
    // `recomputeSessionUsage` runs inside one interactive transaction that takes
    // an advisory lock. The stub runs the callback against itself and answers
    // the two raw statements inertly: a unit test proves the derivation, and
    // `usage.dbtest.ts` proves the lock against a real PostgreSQL.
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(database),
    $executeRawUnsafe: async () => 0,
    $queryRaw: async () => [],
    sessionEvent: { findMany: async () => payloads.map((payload) => ({ payload })) },
    session: {
      findUnique: async () => columns,
      update: async ({ data }: { data: SessionColumns }) => {
        Object.assign(columns, data);
        updates.push(data);
        return data;
      },
    },
  } as unknown as PrismaClient;
  return { database, updates };
};

test("extractUsage reads the real CLAUDE result payload across every model it used", () => {
  // 9313 = 545 uncached + 8768 cached (541 + 4 model input, plus each model's
  // cache read/creation); 98 = 21 + 77. The top-level `usage` block reports
  // only opus's 4 / 77, which is the under-count this batch fixes.
  const usage = extractUsage(CLAUDE_RESULT);
  assert.equal(usage.inputTokens, 9313);
  assert.equal(usage.outputTokens, 98);
  assert.equal(usage.cachedInputTokens, 4332);
  assert.equal(usage.cacheCreationInputTokens, 4436);
  assert.equal(usage.costUsd?.toString(), "0.049117");
});

test("extractUsage reads the second real CLAUDE capture the same way", () => {
  const usage = extractUsage(CLAUDE_RESULT_SAFE_MODE);
  assert.equal(usage.inputTokens, 3504);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.cachedInputTokens, 0);
  assert.equal(usage.cacheCreationInputTokens, 2969);
  assert.equal(usage.costUsd?.toString(), "0.030392999999999996");
});

test("the modelUsage branch is exclusive: the primary model is never counted twice", () => {
  // The top-level `usage` object equals the primary model's entry in both real
  // captures, so ADDING the two sources double-counts it. Reading only the
  // top-level one drops every secondary model. Exactly one source, and it is
  // `modelUsage` whenever `modelUsage` carries anything usable.
  assert.deepEqual(
    extractUsage({ usage: { input_tokens: 100, output_tokens: 200 }, modelUsage: { m: { inputTokens: 5, outputTokens: 7 } } }),
    { inputTokens: 5, outputTokens: 7 },
  );
});

test("CLAUDE modelUsage includes each cached input component exactly once", () => {
  const usage = extractUsage({ modelUsage: {
    primary: { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
    secondary: { inputTokens: 11, cacheReadInputTokens: 2 },
  } });
  // The secondary model reports input and a read, but omits creation. Its
  // missing component makes the model aggregate's creation split unknown;
  // the known read total still survives.
  assert.deepEqual(usage, { inputTokens: 25, outputTokens: 7, cachedInputTokens: 5 });
  assert.equal(deriveUsageColumns(usage).totalTokens, 32);
});

test("a modelUsage input-only model makes the aggregate creation split unknown", () => {
  const usage = extractUsage({ modelUsage: {
    complete: { inputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 50 },
    inputOnly: { inputTokens: 20 },
  } });
  assert.equal(usage.inputTokens, 180);
  assert.equal(usage.cachedInputTokens, 100);
  assert.equal("cacheCreationInputTokens" in usage, false);
  assert.equal(deriveUsageColumns(usage).cacheCreationInputTokens, null);
});

test("CLAUDE top-level usage preserves the read/write cache split", () => {
  const usage = extractUsage({ usage: {
    input_tokens: 10,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 50,
    output_tokens: 7,
  } });
  assert.deepEqual(usage, {
    inputTokens: 160,
    outputTokens: 7,
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
  });
});

test("an unreported cache-creation component remains unknown", () => {
  const usage = extractUsage({ usage: { input_tokens: 10, cache_read_input_tokens: 100 } });
  assert.equal(usage.cachedInputTokens, 100);
  assert.equal("cacheCreationInputTokens" in usage, false);
  assert.equal(deriveUsageColumns(usage).cacheCreationInputTokens, null);
});

test("an unusable modelUsage falls back to the top-level usage block", () => {
  assert.deepEqual(extractUsage({ usage: { input_tokens: 4 }, modelUsage: { m: {} } }), { inputTokens: 4 });
  assert.deepEqual(extractUsage({ usage: { input_tokens: 4 }, modelUsage: {} }), { inputTokens: 4 });
  assert.deepEqual(extractUsage({ usage: { input_tokens: 4 }, modelUsage: "nope" }), { inputTokens: 4 });
});

test("a cost-only modelUsage keeps its cost and falls back to top-level tokens", () => {
  const usage = extractUsage({
    usage: { input_tokens: 4 },
    modelUsage: { m: { costUSD: 0.01 } },
  });
  assert.equal(usage.inputTokens, 4);
  assert.equal(usage.costUsd?.toString(), "0.01");
});

test("one malformed modelUsage entry does not discard the others", () => {
  assert.deepEqual(extractUsage({ modelUsage: { a: 7, b: { inputTokens: 5 } } }), { inputTokens: 5 });
});

test("absence survives the modelUsage branch: a missing field is absent, not zero", () => {
  const usage = extractUsage({ modelUsage: { a: { inputTokens: 5 } } });
  assert.deepEqual(usage, { inputTokens: 5 });
  assert.equal("outputTokens" in usage, false);
  assert.equal("cachedInputTokens" in usage, false);
});

test("cached input does not invent an absent uncached input field", () => {
  assert.deepEqual(
    extractUsage({ modelUsage: { a: { cacheReadInputTokens: 4 } } }),
    { cachedInputTokens: 4 },
  );
  assert.deepEqual(
    extractUsage({ usage: { cache_read_input_tokens: 4 } }),
    { cachedInputTokens: 4 },
  );
  assert.deepEqual(
    extractUsage({ agentosPiUsage: { cacheRead: 4 } }),
    { cachedInputTokens: 4 },
  );
});

test("extractUsage reads the real CODEX turn.completed payload and finds no cost", () => {
  const usage: SessionUsage = extractUsage(CODEX_TURN_COMPLETED);
  // CODEX reports no cost, and reasoning_output_tokens is deliberately excluded
  // from outputTokens.
  assert.equal(usage.costUsd, undefined);
  assert.equal(usage.outputTokens, 253);
  assert.deepEqual(usage, {
    inputTokens: 40764,
    outputTokens: 253,
    cachedInputTokens: 35072,
    cacheCreationInputTokens: 0,
  });
  // CODEX's input_tokens already contains cached_input_tokens; adding the
  // subset again would inflate both the input and total columns.
  const columns = deriveUsageColumns(usage);
  assert.equal(columns.inputTokens, 40764);
  assert.equal(columns.totalTokens, 41017);
});

test("extractUsage finds nothing in PI's empty terminal event", () => {
  assert.deepEqual(extractUsage(PI_AGENT_SETTLED), {});
});

test("extractUsage reads the runner's PI aggregate with cached input included", () => {
  const usage: SessionUsage = extractUsage(PI_AGENT_SETTLED_WITH_USAGE);
  assert.deepEqual(usage, {
    inputTokens: 9272,
    outputTokens: 24,
    // cacheRead + cacheWrite, the same fold CLAUDE's read/creation pair gets.
    cachedInputTokens: 3584,
    cacheCreationInputTokens: 0,
    costUsd: new Prisma.Decimal("0.00123808"),
  });
  // PI's persisted input uses the same cached-inclusive caliber as CODEX.
  const derived = deriveUsageColumns(usage);
  assert.equal(derived.totalTokens, 9296);
  assert.equal(derived.cachedInputTokens, 3584);
  assert.equal(derived.cacheCreationInputTokens, 0);
  assert.equal(derived.costUsd?.toString(), "0.0012");
  const codex = deriveUsageColumns(extractUsage(CODEX_TURN_COMPLETED));
  assert.equal(codex.totalTokens, 41017);
  assert.ok(codex.totalTokens! > codex.cachedInputTokens!, "CODEX totals already contain the cached tokens");
});

test("PI cacheWrite is persisted as cache creation input", () => {
  assert.deepEqual(
    extractUsage({ agentosPiUsage: { input: 10, output: 7, cacheRead: 100, cacheWrite: 50 } }),
    { inputTokens: 160, outputTokens: 7, cachedInputTokens: 100, cacheCreationInputTokens: 50 },
  );
});

test("the PI aggregate is exclusive of the provider vocabularies it replaces", () => {
  // A payload carrying both must not be summed twice. PI's terminal event never
  // carries `usage` today; this is the guard that keeps that assumption honest
  // if the shape ever changes.
  const usage = extractUsage({ ...PI_AGENT_SETTLED_WITH_USAGE, usage: { input_tokens: 99 }, total_cost_usd: 7 });
  assert.equal(usage.inputTokens, 9272);
  assert.equal(usage.costUsd?.toString(), "0.00123808");
  assert.equal(usage.costUsd?.equals(new Prisma.Decimal("0.00123808")), true);
});

test("a PI aggregate that reports nothing usable leaves every column null", async () => {
  // The runner omits `agentosPiUsage` entirely when no message reported usage,
  // and diagnoses that separately. Whatever else arrives here, no field may be
  // invented: absent stays absent, never zero.
  for (const totals of [undefined, null, 42, {}, { messages: 3, reported: 0 }]) {
    assert.deepEqual(extractUsage({ type: "agent_settled", agentosPiUsage: totals }), {}, JSON.stringify(totals ?? null));
  }
  const { result: usage, warnings } = await withCapturedWarnings(
    () => extractUsage({ agentosPiUsage: { input: -1, output: 8, cacheRead: 1.5, costNanoUsd: 0.5 } }),
  );
  assert.deepEqual(usage, { outputTokens: 8 });
  assert.equal(warnings.length, 3);
  assert.match(warnings.join("\n"), /agentosPiUsage\.input/u);
  // A fractional nano-USD did not come from the PI parser, so its exactness —
  // the whole reason for the integer transport — cannot be assumed.
  assert.match(warnings.join("\n"), /agentosPiUsage\.costNanoUsd/u);
});

test("the PI cost transport is exact where a double sum would round the wrong way", () => {
  // 0.000001 + 0.000049 as doubles is 0.0000499999…, which the column rounds to
  // 0.0000. The runner sends 1000 + 49000 nano-USD instead, and this is where
  // that integer becomes the 0.0001 the session actually cost.
  const usage = extractUsage({ agentosPiUsage: { input: 2, output: 2, costNanoUsd: 50_000 } });
  assert.equal(usage.costUsd?.toString(), "0.00005");
  assert.equal(deriveUsageColumns(usage).costUsd?.toString(), "0.0001");
});

test("PI sessions accumulate across attempts the way every other runner does", () => {
  // A PI session that resumes after SETTLING spawns a fresh process with a fresh
  // accumulator, so each attempt contributes its own FINAL_OUTPUT row.
  //
  // Known limitation, shared with CLAUDE and CODEX rather than introduced here:
  // an attempt whose process is killed before it settles — an Inbox suspension
  // is the live case — produces no FINAL_OUTPUT, and its usage is lost. The
  // fencing rejection that triggers the kill has already cleared the delivery
  // lease, so there is no event this adapter could emit that would still be
  // accepted. Closing that needs a control-plane change, not a parser change.
  const total = sumUsage([PI_AGENT_SETTLED_WITH_USAGE, PI_AGENT_SETTLED_WITH_USAGE].map(extractUsage));
  assert.equal(total.inputTokens, 18544);
  assert.equal(total.costUsd?.toString(), "0.00247616");
});

test("extractUsage is total over unknown input", () => {
  for (const payload of [null, undefined, 42, "x", [], {}, { usage: null }, { usage: 42 }, { usage: { input_tokens: "nope" } }, { total_cost_usd: "free" }]) {
    assert.deepEqual(extractUsage(payload), {}, JSON.stringify(payload ?? null));
  }
  assert.deepEqual(extractUsage({ usage: { input_tokens: 1n } }), {});
  const cyclic: { usage?: unknown; self?: unknown } = {};
  cyclic.self = cyclic;
  cyclic.usage = { input_tokens: cyclic };
  assert.doesNotThrow(() => extractUsage(cyclic));
  assert.deepEqual(extractUsage(cyclic), {});
});

test("extractUsage keeps partial usage partial", () => {
  assert.deepEqual(extractUsage({ usage: { output_tokens: 5 } }), { outputTokens: 5 });
  assert.equal(extractUsage({ total_cost_usd: 1.5 }).costUsd?.toString(), "1.5");
});

test("sumUsage never turns an absent field into zero", () => {
  assert.deepEqual(sumUsage([{ inputTokens: 1 }, { outputTokens: 2 }]), { inputTokens: 1, outputTokens: 2 });
  assert.equal(sumUsage([{ costUsd: new Prisma.Decimal(1) }, { costUsd: new Prisma.Decimal(2) }]).costUsd?.toString(), "3");
  assert.deepEqual(sumUsage([]), {});
});

test("sumUsage keeps known reads but makes creation unknown across an incomplete event", () => {
  const total = sumUsage([
    { inputTokens: 160, cachedInputTokens: 100, cacheCreationInputTokens: 50 },
    { inputTokens: 20 },
  ]);
  assert.equal(total.inputTokens, 180);
  assert.equal(total.cachedInputTokens, 100);
  assert.equal("cacheCreationInputTokens" in total, false);
  assert.equal(deriveUsageColumns(total).cacheCreationInputTokens, null);
});

test("recomputeSessionUsage writes absolute values once and is a no-op on replay", async () => {
  const columns = emptyColumns();
  const { database, updates } = stubDatabase([CLAUDE_RESULT], columns);

  assert.equal(await recomputeSessionUsage(database, "session-1"), true);
  assert.equal(updates.length, 1);
  assert.equal(columns.inputTokens, 9313);
  assert.equal(columns.outputTokens, 98);
  assert.equal(columns.cachedInputTokens, 4332);
  assert.equal(columns.cacheCreationInputTokens, 4436);
  assert.equal(columns.totalTokens, 9411);
  assert.equal(columns.costUsd?.toString(), "0.0491");

  // Same events in, same columns out: the second call must not write.
  assert.equal(await recomputeSessionUsage(database, "session-1"), false);
  assert.equal(updates.length, 1);
});

test("recomputeSessionUsage stores a cost-only session without inventing token zeroes", async () => {
  const columns = emptyColumns();
  const { database, updates } = stubDatabase([{ type: "result", total_cost_usd: 0.25 }], columns);

  assert.equal(await recomputeSessionUsage(database, "session-1"), true);
  assert.equal(columns.costUsd?.toString(), "0.25");
  assert.equal(columns.inputTokens, null);
  assert.equal(columns.outputTokens, null);
  assert.equal(columns.cachedInputTokens, null);
  assert.equal(columns.totalTokens, null);

  // The old `totalTokens: null` selector would have re-written this forever.
  assert.equal(await recomputeSessionUsage(database, "session-1"), false);
  assert.equal(updates.length, 1);
});

const resumedClaudeResult = (sessionId: string, cost: number, input: number, output: number) => ({
  type: "result",
  session_id: sessionId,
  total_cost_usd: cost,
  usage: { input_tokens: 1, output_tokens: 1 },
  modelUsage: { "claude-opus": { inputTokens: input, outputTokens: output } },
});

test("recomputeSessionUsage selects the last cumulative Claude resume total", async () => {
  const columns = emptyColumns();
  const events = [
    resumedClaudeResult("provider-a", 0.1, 100, 10),
    resumedClaudeResult("provider-a", 0.2, 150, 15),
  ];
  const { database, updates } = stubDatabase(events, columns);
  assert.equal(await recomputeSessionUsage(database, "session-1"), true);
  assert.equal(columns.inputTokens, 150);
  assert.equal(columns.outputTokens, 15);
  assert.equal(columns.totalTokens, 165);
  assert.equal(columns.costUsd?.toString(), "0.2");
  assert.equal(await recomputeSessionUsage(database, "session-1"), false);
  assert.equal(updates.length, 1);
});

test("recomputeSessionUsage adds the latest totals from distinct Claude provider sessions", async () => {
  const columns = emptyColumns();
  const events = [
    resumedClaudeResult("provider-a", 0.1, 100, 10),
    resumedClaudeResult("provider-b", 0.3, 200, 20),
    resumedClaudeResult("provider-a", 0.2, 150, 15),
    resumedClaudeResult("provider-b", 0.4, 250, 25),
  ];
  await recomputeSessionUsage(stubDatabase(events, columns).database, "session-1");
  assert.equal(columns.inputTokens, 400);
  assert.equal(columns.outputTokens, 40);
  assert.equal(columns.totalTokens, 440);
  assert.equal(columns.costUsd?.toString(), "0.6");
});

test("recomputeSessionUsage corrects four identical Claude results to one quarter and is idempotent", async () => {
  const event = resumedClaudeResult("provider-a", 30.10718275, 100, 10);
  const events = [event, event, event, event];
  const columns = deriveUsageColumns(sumUsage(events.map(extractUsage)));
  const previousCost = columns.costUsd;
  assert.equal(previousCost?.toString(), "120.4287");
  const { database, updates } = stubDatabase(events, columns);
  assert.equal(await recomputeSessionUsage(database, "session-1"), true);
  assert.equal(columns.costUsd?.toString(), "30.1072");
  assert.equal(columns.inputTokens, 100);
  assert.equal(columns.outputTokens, 10);
  assert.equal(await recomputeSessionUsage(database, "session-1"), false);
  assert.equal(updates.length, 1);
});

test("recomputeSessionUsage repairs a session whose second attempt's write was lost", async () => {
  const attemptOne = { type: "result", usage: { input_tokens: 10, output_tokens: 3 } };
  const attemptTwo = { type: "result", usage: { input_tokens: 7, output_tokens: 11 } };
  // Columns hold attempt 1 only, as if the process died between createMany and
  // the usage write. An additive design could never reach this session again.
  const columns: SessionColumns = {
    inputTokens: 10,
    outputTokens: 3,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    totalTokens: 13,
    costUsd: null,
  };
  const { database } = stubDatabase([attemptOne, attemptTwo], columns);

  assert.equal(await recomputeSessionUsage(database, "session-1"), true);
  assert.equal(columns.inputTokens, 17);
  assert.equal(columns.outputTokens, 14);
  assert.equal(columns.totalTokens, 31);
});

test("recomputeSessionUsage does nothing when the session row is gone", async () => {
  const database: PrismaClient = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(database),
    $executeRawUnsafe: async () => 0,
    $queryRaw: async () => [],
    sessionEvent: { findMany: async () => [{ payload: CLAUDE_RESULT }] },
    session: { findUnique: async () => null, update: async () => assert.fail("must not write") },
  } as unknown as PrismaClient;
  assert.equal(await recomputeSessionUsage(database, "missing"), false);
});

/* ------------------------------------- SF-1: values PostgreSQL cannot store */

test("a token value the INTEGER column cannot hold is dropped, diagnosed, and does not take its siblings with it", async () => {
  // Each of these used to reach the column: `finite` only asked whether the
  // number was finite, so -7, 1.5 and 2^31 all arrived at an INTEGER column and
  // failed the whole write — which the ingest then swallowed, leaving the
  // session with no usage at all.
  for (const rejected of [-7, 1.5, 2_147_483_648, NaN, Infinity, "5", null, true]) {
    const { result: usage, warnings } = await withCapturedWarnings(
      () => extractUsage({ usage: { input_tokens: rejected, output_tokens: 12 } }),
    );
    const label = JSON.stringify(rejected ?? null);
    assert.equal("inputTokens" in usage, false, `inputTokens must be absent for ${label}`);
    assert.equal(usage.outputTokens, 12, `a valid sibling must survive ${label}`);
    assert.equal(warnings.length, 1, `exactly one diagnostic for ${label}`);
    assert.match(warnings[0] ?? "", /usage\.input_tokens/);
  }
});

test("a missing token field is silent while an explicitly invalid one is diagnosed", async () => {
  // Absent is normal — it means "this payload said nothing about it". Without
  // that split every PI event would log four lines per recompute.
  const absent = await withCapturedWarnings(() => extractUsage({ usage: { input_tokens: 4 } }));
  assert.deepEqual(absent.warnings, []);
  const present = await withCapturedWarnings(() => extractUsage({ usage: { input_tokens: 4, output_tokens: null } }));
  assert.equal(present.warnings.length, 1);
});

test("a sum that leaves INTEGER range stores null for that column only", async () => {
  const events = [{ usage: { input_tokens: 2_000_000_000 } }, { usage: { input_tokens: 2_000_000_000, output_tokens: 9 } }];
  const { result: derived } = await withCapturedWarnings(
    () => deriveUsageColumns(sumUsage(events.map(extractUsage))),
  );
  assert.equal(derived.inputTokens, null);
  assert.equal(derived.totalTokens, null);
  // The overflow is contained: outputTokens is in range and keeps its value.
  assert.equal(derived.outputTokens, 9);
});

test("the summed-overflow session still writes a valid sibling rather than throwing", async () => {
  const columns = emptyColumns();
  const { database, updates } = stubDatabase([
    { usage: { input_tokens: 2_000_000_000 } },
    { usage: { input_tokens: 2_000_000_000, output_tokens: 9 } },
  ], columns);
  const { result: wrote } = await withCapturedWarnings(() => recomputeSessionUsage(database, "session-1"));
  assert.equal(wrote, true);
  assert.equal(updates.length, 1);
  assert.equal(columns.inputTokens, null);
  assert.equal(columns.totalTokens, null);
  assert.equal(columns.outputTokens, 9);
});

test("a cost the Decimal(12, 4) column cannot hold is dropped", async () => {
  for (const rejected of [-1, 1e9, 99999999.99999]) {
    // 99999999.99999 is BELOW 10^8 and still fails the write: it rounds to
    // 100000000.0000. The guard has to judge the rounded value, not the raw one.
    const { result: usage } = await withCapturedWarnings(() => extractUsage({ total_cost_usd: rejected }));
    assert.equal("costUsd" in usage, false, `costUsd must be absent for ${rejected}`);
    const { result: derived } = await withCapturedWarnings(() => deriveUsageColumns(sumUsage([usage])));
    assert.equal(derived.costUsd, null);
  }
});

test("cost rejection is per event, so one absurd event cannot erase a valid one", async () => {
  // With the check only after summation, 1e9 + 0.05 leaves the range as a single
  // number and the session loses a cost it legitimately had.
  const events = [{ total_cost_usd: 1e9 }, { total_cost_usd: 0.05 }];
  const { result: derived } = await withCapturedWarnings(
    () => deriveUsageColumns(sumUsage(events.map(extractUsage))),
  );
  // Compared by value, not by rendering: Decimal#toString drops trailing zeroes,
  // so the stored 0.0500 prints as "0.05". The column's scale is 4 either way.
  assert.notEqual(derived.costUsd, null);
  assert.equal(derived.costUsd?.toNumber(), 0.05);
});

test("cost aggregation uses decimal arithmetic at the exact half-unit boundary", () => {
  const derived = deriveUsageColumns(sumUsage([
    extractUsage({ total_cost_usd: 0.000001 }),
    extractUsage({ total_cost_usd: 0.000049 }),
  ]));
  assert.equal(derived.costUsd?.toString(), "0.0001");
});

test("an aggregate cost overflow across individually storable events is still caught", async () => {
  // 6e7 is storable; 6e7 + 6e7 is not. This is the case the per-event check
  // cannot see, and it is why both guards exist.
  const events = [{ total_cost_usd: 6e7 }, { total_cost_usd: 6e7 }];
  const { result: derived } = await withCapturedWarnings(
    () => deriveUsageColumns(sumUsage(events.map(extractUsage))),
  );
  assert.equal(derived.costUsd, null);
});

/* ------------------------------------------- MF-1: the advisory lock's key */

test("sessionUsageLockKey is deterministic, spread, and inside int4", () => {
  const ids = ["cmswjrnf40t4mmpyjn9u931bk", "cmswjrn9c0t44mpyjs2n4khwn", "cmswjrnbw0t4ampyj86lr3ymb", "ses-1", ""];
  for (const id of ids) {
    const key = sessionUsageLockKey(id);
    assert.equal(key, sessionUsageLockKey(id), `${id} must hash the same way twice`);
    assert.equal(Number.isInteger(key), true);
    assert.ok(key >= -2_147_483_648 && key <= 2_147_483_647, `${id} hashed outside int4: ${key}`);
  }
  // Not a collision-resistance claim — just that the hash is not constant, which
  // would serialise every session in the system against every other.
  assert.equal(new Set(ids.map(sessionUsageLockKey)).size, ids.length);
});
