import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Canonical usage extracted from one provider payload. `inputTokens` includes
 * all input, including the `cachedInputTokens` subset; `outputTokens` is output
 * only. Every field is optional and absent means "this payload said nothing
 * about it" — never zero. A session that spent money but reported no token
 * counts stores its cost and leaves the token columns null.
 */
export type SessionUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUsd?: Prisma.Decimal;
};

/** Cost is stored as Decimal(12, 4); derive at that precision so a recompute of
 * unchanged events compares equal to what the previous write stored. */
const COST_SCALE = 4;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** PostgreSQL INTEGER, the type of all four token columns. */
const MAX_INT4 = 2_147_483_647;
/** Decimal(12, 4) holds eight integer digits: 99999999.9999 is the ceiling. */
const MAX_COST = 100_000_000;

/** Diagnostics only. Numbers go through String so NaN and Infinity are legible
 * (JSON.stringify renders both as `null`, which is the one thing the reader of
 * the diagnostic must not be told). */
const render = (value: unknown): string => {
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  try {
    const rendered = JSON.stringify(value) ?? String(value);
    return rendered.length > 200 ? `${rendered.slice(0, 197)}...` : rendered;
  } catch {
    // Diagnostics are deliberately weaker than ingestion. BigInt, cycles, and
    // hostile toJSON/valueOf implementations must not turn a rejected field
    // into a failed FINAL_OUTPUT request.
    return `[unrenderable ${typeof value}]`;
  }
};

/**
 * A value only counts as tokens if PostgreSQL can store it in INTEGER. Absent is
 * silent — absent is normal and means "this payload said nothing about it".
 * Present-but-impossible is dropped with a one-line diagnostic, and never throws:
 * a payload must not be able to fail the ingest that carries it.
 */
const tokenCount = (value: unknown, field: string): number | null => {
  if (value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INT4) return value;
  console.warn(`[usage] ignoring ${field}=${render(value)}: not a storable token count`);
  return null;
};

/**
 * Cost is stored as Decimal(12, 4). A value the column cannot hold is dropped
 * HERE, per event, rather than after summation: `sumUsage` folds every surviving
 * cost into one number, so a single absurd event would otherwise poison the sum
 * and erase every valid sibling's cost. The range test is applied to the ROUNDED
 * value because that is what is actually written — 99999999.99999 is below 10^8
 * and still fails the write.
 *
 * Returns an unrounded Decimal: `sumUsage` adds exact decimal values and rounds
 * once at the column boundary. Adding binary JS numbers first is not exact —
 * 0.000001 + 0.000049 lands just below the half-unit and rounds to 0.0000.
 */
const costAmount = (value: unknown, field = "total_cost_usd"): Prisma.Decimal | null => {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    console.warn(`[usage] ignoring ${field}=${render(value)}: not a storable cost`);
    return null;
  }
  const decimal = new Prisma.Decimal(String(value));
  if (decimal.toDecimalPlaces(COST_SCALE).greaterThanOrEqualTo(MAX_COST)) {
    console.warn(`[usage] ignoring ${field}=${render(value)}: exceeds Decimal(12, 4)`);
    return null;
  }
  return decimal;
};

type ModelTotals = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  costUsd: Prisma.Decimal | null;
};

/** Fold a provider's disjoint cached subset into canonical input exactly once.
 * A missing cached figure leaves reported input unchanged; a missing input
 * stays missing rather than being invented from the cached subset alone. */
const canonicalInputTokens = (uncached: number | null, cached: number | null): number | null =>
  uncached === null || cached === null ? uncached : uncached + cached;

/**
 * CLAUDE's terminal `result` carries a per-model breakdown under `modelUsage`,
 * keyed by model id, whose entries are camelCase — while the top-level `usage`
 * object is snake_case and describes ONE model, the primary one.
 *
 * In the single-invocation captures transcribed in `usage.test.ts`, top-level
 * `usage` equals `modelUsage["claude-opus-5"]` field for field. On resume,
 * `modelUsage` is session-cumulative while top-level `usage` remains per
 * invocation; `sumSessionUsage` reconciles snapshots and later fallback usage.
 * Adding both sources from one event double-counts the primary model, while
 * reading only top-level usage drops secondary models. This branch is therefore
 * EXCLUSIVE, and the two vocabularies never share a key list.
 *
 * The returned input total is canonical: each model's provider-reported
 * uncached input has its cache-read/creation input added exactly once. Token
 * usability remains independent of cost usability so a cost-only breakdown can
 * preserve its cost while top-level `usage` supplies the token columns.
 */
const extractModelUsage = (value: unknown): ModelTotals | null => {
  const models = asRecord(value);
  if (!models) return null;
  const totals: ModelTotals = {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    costUsd: null,
  };
  let observedCacheCreation = 0;
  let hasObservedCacheCreation = false;
  let cacheCreationUnknown = false;
  for (const entry of Object.values(models)) {
    const model = asRecord(entry);
    if (!model) continue;                       // one malformed entry must not discard the others
    const input = tokenCount(model.inputTokens, "modelUsage.inputTokens");
    if (input !== null) totals.inputTokens = (totals.inputTokens ?? 0) + input;
    const output = tokenCount(model.outputTokens, "modelUsage.outputTokens");
    if (output !== null) totals.outputTokens = (totals.outputTokens ?? 0) + output;
    const cacheRead = tokenCount(model.cacheReadInputTokens, "modelUsage.cacheReadInputTokens");
    const cacheCreation = tokenCount(model.cacheCreationInputTokens, "modelUsage.cacheCreationInputTokens");
    if (cacheRead !== null) totals.cachedInputTokens = (totals.cachedInputTokens ?? 0) + cacheRead;
    if (cacheCreation !== null) {
      observedCacheCreation += cacheCreation;
      hasObservedCacheCreation = true;
    }
    // A model with input/cache data but no creation component makes the
    // aggregate split unknown. Do not silently treat that model's omitted
    // component as zero merely because another model reported a creation
    // count. An explicitly invalid value is unknown as well, while output- or
    // cost-only entries do not make the input split ambiguous.
    // `null` is the JSON spelling of an omitted provider component. It still
    // earns an ingestion diagnostic, but it must not make an output-only model
    // sibling look input-bearing for cache-split completeness.
    const modelHasInput = input !== null || cacheRead !== null || cacheCreation !== null;
    if (modelHasInput && cacheCreation === null) cacheCreationUnknown = true;
    const cost = costAmount(model.costUSD, "modelUsage.costUSD");
    if (cost !== null) totals.costUsd = (totals.costUsd ?? new Prisma.Decimal(0)).plus(cost);
  }
  const knownCached = totals.cachedInputTokens === null && !hasObservedCacheCreation
    ? null
    : (totals.cachedInputTokens ?? 0) + observedCacheCreation;
  totals.inputTokens = canonicalInputTokens(totals.inputTokens, knownCached);
  if (!cacheCreationUnknown && hasObservedCacheCreation) {
    totals.cacheCreationInputTokens = observedCacheCreation;
  }
  // The breakdown is usable iff this one pass produced tokens or cost. Token
  // usability is checked separately by the caller without traversing it again.
  return totals.inputTokens === null
    && totals.outputTokens === null
    && totals.cachedInputTokens === null
    && totals.cacheCreationInputTokens === null
    && totals.costUsd === null
    ? null
    : totals;
};

/**
 * PI's totals, aggregated by the runner's PI parser and attached to the
 * FINAL_OUTPUT payload as `agentosPiUsage`. The name is deliberate: unlike
 * `usage` and `modelUsage`, which are the providers' own vocabularies, this
 * object is Anneal-computed, and reading it as a provider payload would hide
 * that.
 *
 * Canonicalization at this boundary makes PI's columns match the other
 * runners:
 * - `input` is uncached input and `cacheRead`/`cacheWrite` are a DISJOINT
 *   cached subset. The extractor adds that subset exactly once to stored
 *   `inputTokens`; `cachedInputTokens` retains reads and
 *   `cacheCreationInputTokens` retains writes for reporting.
 * - CODEX's `input_tokens` already contains `cached_input_tokens`, so that
 *   branch does not add the cached subset a second time and records zero cache
 *   writes because Codex reports no write component.
 * - `output` already contains PI's reasoning tokens, so there is no reasoning
 *   field to fold in here.
 * - `costNanoUsd` is PI's own per-message `cost.total` summed, not derived from
 *   the pricing table — PI is the only one of the three that prices itself per
 *   message. It arrives as an INTEGER count of nano-USD because the runner
 *   cannot reach Prisma.Decimal and summing the raw doubles would hit the very
 *   half-unit error `costAmount` exists to avoid. Dividing by a power of ten in
 *   decimal is exact, so nothing is lost on the way to the column.
 *
 * `messages` and `reported` are the runner's diagnostics and are read by nobody
 * here; they exist so a stored event can answer "was the cost missing, or was
 * it genuinely nothing".
 */
const NANOS_PER_USD = 1_000_000_000;

/** The PI aggregate's integer nano-USD as an exact Decimal. Same drop-with-a-
 * diagnostic discipline as `costAmount`, against the integer domain the runner
 * actually sends: a non-integer here means the payload was not written by the
 * PI parser and its value cannot be trusted to be exact. */
const piCostAmount = (value: unknown): Prisma.Decimal | null => {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    console.warn(`[usage] ignoring agentosPiUsage.costNanoUsd=${render(value)}: not a storable cost`);
    return null;
  }
  const decimal = new Prisma.Decimal(value).dividedBy(NANOS_PER_USD);
  if (decimal.toDecimalPlaces(COST_SCALE).greaterThanOrEqualTo(MAX_COST)) {
    console.warn(`[usage] ignoring agentosPiUsage.costNanoUsd=${render(value)}: exceeds Decimal(12, 4)`);
    return null;
  }
  return decimal;
};

const extractPiUsage = (value: unknown): SessionUsage | null => {
  const totals = asRecord(value);
  if (!totals) return null;
  const result: SessionUsage = {};
  const input = tokenCount(totals.input, "agentosPiUsage.input");
  const output = tokenCount(totals.output, "agentosPiUsage.output");
  if (output !== null) result.outputTokens = output;
  const cacheRead = tokenCount(totals.cacheRead, "agentosPiUsage.cacheRead");
  const cacheWrite = tokenCount(totals.cacheWrite, "agentosPiUsage.cacheWrite");
  if (cacheRead !== null) result.cachedInputTokens = cacheRead;
  if (cacheWrite !== null) result.cacheCreationInputTokens = cacheWrite;
  const knownCached = cacheRead === null && cacheWrite === null ? null : (cacheRead ?? 0) + (cacheWrite ?? 0);
  const canonicalInput = canonicalInputTokens(input, knownCached);
  if (canonicalInput !== null) result.inputTokens = canonicalInput;
  const cost = piCostAmount(totals.costNanoUsd);
  if (cost !== null) result.costUsd = cost;
  // Nothing usable routes back to the other branches rather than claiming the
  // payload, exactly as an unusable `modelUsage` does.
  return Object.keys(result).length === 0 ? null : result;
};

export type ExtractedCacheSplit =
  | { kind: "none" }
  | { kind: "unknown" }
  | {
      kind: "known";
      cachedInputTokens: number;
      cacheCreationInputTokens: number;
    };

type DecodedUsage = {
  providerSessionId: string | null;
  usage: SessionUsage;
  cacheSplit: ExtractedCacheSplit;
  /**
   * Claude's `usage` object is per invocation. Keep it separate from the
   * session-cumulative `modelUsage` breakdown so a payload-level aggregation
   * can apply the provider's two different accounting rules without changing
   * the canonical one-payload result returned by `extractUsage`.
   */
  topLevelUsage: SessionUsage;
  cumulativeModelUsage: SessionUsage | null;
  cumulativeCostUsd: Prisma.Decimal | null;
};

/**
 * Cache-split completeness is a projection of the canonical usage that
 * ingestion actually stores. Only input-bearing fields participate: an
 * output-only or cost-only payload carries no evidence that a split is
 * incomplete, so it is `none` and can never poison a known sibling event.
 */
const cacheSplitFromUsage = (usage: SessionUsage): ExtractedCacheSplit => {
  const hasInput = usage.inputTokens !== undefined
    || usage.cachedInputTokens !== undefined
    || usage.cacheCreationInputTokens !== undefined;
  if (!hasInput) return { kind: "none" };
  if (usage.cachedInputTokens === undefined || usage.cacheCreationInputTokens === undefined) {
    return { kind: "unknown" };
  }
  return {
    kind: "known",
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
  };
};

/** Decode the per-invocation snake_case usage block without applying any
 * model-breakdown precedence. The caller uses this only when no usable
 * `modelUsage` exists, preserving the diagnostics and precedence of
 * `extractUsage` while giving session aggregation its per-invocation source. */
const extractTopLevelUsage = (usage: Record<string, unknown>): SessionUsage => {
  const result: SessionUsage = {};
  const input = tokenCount(usage.input_tokens, "usage.input_tokens");
  const output = tokenCount(usage.output_tokens, "usage.output_tokens");
  if (output !== null) result.outputTokens = output;

  // CODEX reports one cached figure that is already included in input;
  // CLAUDE reports a read/creation pair alongside uncached input. The pair
  // is folded into input only in the latter shape. `reasoning_output_tokens`
  // (CODEX) is deliberately not folded into output.
  const cached = tokenCount(usage.cached_input_tokens, "usage.cached_input_tokens");
  const cacheRead = tokenCount(usage.cache_read_input_tokens, "usage.cache_read_input_tokens");
  const cacheCreation = tokenCount(usage.cache_creation_input_tokens, "usage.cache_creation_input_tokens");
  const disjointCached = cached === null && (cacheRead !== null || cacheCreation !== null)
    ? (cacheRead ?? 0) + (cacheCreation ?? 0)
    : null;
  if (cached !== null) {
    result.cachedInputTokens = cached;
    // CODEX's input_tokens already contains cached_input_tokens and its
    // protocol has no cache-creation component. Preserve that known zero so
    // the new split is not reported as unknown for Codex sessions.
    result.cacheCreationInputTokens = 0;
  } else {
    if (cacheRead !== null) result.cachedInputTokens = cacheRead;
    if (cacheCreation !== null) result.cacheCreationInputTokens = cacheCreation;
  }
  const canonicalInput = canonicalInputTokens(input, disjointCached);
  if (canonicalInput !== null) result.inputTokens = canonicalInput;
  return result;
};

/**
 * One event payload → whatever usage it carries. Shape-driven rather than
 * runner-driven, and total over `unknown`: any payload that does not match
 * yields `{}` and nothing throws.
 *
 * Verified against `spikes/cli-capabilities/samples/`:
 * - CLAUDE `result`: `modelUsage`, a per-model breakdown in camelCase, is the
 *   primary source — it is the only one that sees every model the session used.
 *   The snake_case top-level `usage.{input_tokens,output_tokens,
 *   cache_read_input_tokens,cache_creation_input_tokens}` describes the primary
 *   model alone and is the fallback for payloads carrying no usable
 *   `modelUsage`. Cost prefers the top-level `total_cost_usd`, which already
 *   equals the per-model sum, and falls back to that sum when the total is
 *   absent.
 * - CODEX `turn.completed`: `usage.{input_tokens,cached_input_tokens,output_tokens}`,
 *   no `modelUsage`, no cost anywhere — the fallback branch. Its input is
 *   already cache-inclusive, so the cached subset is not added again.
 * - PI `agent_settled`: literally `{"type":"agent_settled"}` — no usage, no
 *   cost. PI prices itself per message instead, so the runner's PI parser sums
 *   those messages and attaches `agentosPiUsage`, which is EXCLUSIVE of the two
 *   provider vocabularies above and carries its own caliber. See
 *   `extractPiUsage`.
 */
const decodeUsage = (payload: unknown, options: { strict?: boolean } = {}): DecodedUsage => {
  const event = asRecord(payload);
  if (!event) {
    if (options.strict) throw new Error("payload is not an object");
    return {
      usage: {},
      cacheSplit: { kind: "none" },
      topLevelUsage: {},
      cumulativeModelUsage: null,
      cumulativeCostUsd: null,
      providerSessionId: null,
    };
  }
  if (options.strict) validateProviderShapes(event);

  // Exclusive and first: an `agentosPiUsage` payload is already a whole
  // session's totals, cost included, and PI's terminal event carries no other
  // usage vocabulary for the branches below to add to it.
  const pi = extractPiUsage(event.agentosPiUsage);
  if (pi) {
    return {
      usage: pi,
      cacheSplit: cacheSplitFromUsage(pi),
      topLevelUsage: {},
      cumulativeModelUsage: null,
      cumulativeCostUsd: null,
      providerSessionId: null,
    };
  }
  // Classify only after the exclusive PI branch. Read the id from each event:
  // one database Session can contain multiple conversations after a failed resume.
  const isClaude = event.type === "result"
    || Object.prototype.hasOwnProperty.call(event, "modelUsage")
    || Object.prototype.hasOwnProperty.call(event, "total_cost_usd");
  const providerSessionId = isClaude && typeof event.session_id === "string" && event.session_id.length > 0
    ? event.session_id
    : null;
  if (providerSessionId === null && (
    Object.prototype.hasOwnProperty.call(event, "modelUsage")
    || Object.prototype.hasOwnProperty.call(event, "total_cost_usd")
  )) {
    console.warn("[usage] Claude cumulative usage has no usable session_id; retaining additive accounting");
  }
  const usage = asRecord(event.usage);
  const result: SessionUsage = {};

  const models = extractModelUsage(event.modelUsage);
  const hasModelTokens = models !== null && (
    models.inputTokens !== null
    || models.outputTokens !== null
    || models.cachedInputTokens !== null
    || models.cacheCreationInputTokens !== null
  );
  const topLevelUsage = hasModelTokens || usage === null ? {} : extractTopLevelUsage(usage);
  if (hasModelTokens) {
    // Absence survives the branch: a breakdown that reports only input leaves
    // outputTokens absent, never 0. `exactOptionalPropertyTypes` is what keeps
    // that mechanical — guard and skip, never assign undefined.
    if (models.inputTokens !== null) result.inputTokens = models.inputTokens;
    if (models.outputTokens !== null) result.outputTokens = models.outputTokens;
    if (models.cachedInputTokens !== null) result.cachedInputTokens = models.cachedInputTokens;
    if (models.cacheCreationInputTokens !== null) {
      result.cacheCreationInputTokens = models.cacheCreationInputTokens;
    }
  } else if (usage) {
    Object.assign(result, topLevelUsage);
  }

  // Token and cost usability are independent: a cost-only model breakdown must
  // not suppress valid top-level tokens, but its valid cost must still survive.
  // A reported terminal total remains authoritative when both sources exist.
  const cost = costAmount(event.total_cost_usd) ?? models?.costUsd ?? null;
  const cumulativeModelUsage = hasModelTokens ? { ...result } : null;
  if (cost !== null) result.costUsd = cost;
  return {
    usage: result,
    cacheSplit: cacheSplitFromUsage(result),
    topLevelUsage,
    cumulativeModelUsage,
    cumulativeCostUsd: cost,
    providerSessionId,
  };
};

function strictToken(value: unknown, field: string): void {
  // Providers serialize an omitted component as either an absent property or
  // JSON null. Ingestion drops both from the canonical usage; strict backfill
  // must preserve that same meaning while still rejecting non-null junk.
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_INT4) {
    throw new Error(`${field} is not a storable non-negative integer`);
  }
}

function strictRecord(value: unknown, field: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record === null) throw new Error(`${field} is not an object`);
  return record;
}

/** Validate the provider fields decoded by `decodeUsage`. */
function validateProviderShapes(event: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(event, "agentosPiUsage")) {
    const value = event.agentosPiUsage;
    if (value !== undefined && value !== null) {
      const pi = strictRecord(value, "agentosPiUsage");
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        strictToken(pi[key], `agentosPiUsage.${key}`);
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(event, "modelUsage")) {
    const value = event.modelUsage;
    if (value !== undefined && value !== null) {
      const models = strictRecord(value, "modelUsage");
      for (const [modelName, rawModel] of Object.entries(models)) {
        const model = strictRecord(rawModel, `modelUsage.${modelName}`);
        for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const) {
          strictToken(model[key], `modelUsage.${modelName}.${key}`);
        }
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(event, "usage")) {
    const value = event.usage;
    if (value !== undefined && value !== null) {
      const usage = strictRecord(value, "usage");
      for (const key of [
        "input_tokens",
        "output_tokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
      ] as const) {
        strictToken(usage[key], `usage.${key}`);
      }
    }
  }
}

export const extractUsage = (payload: unknown): SessionUsage => decodeUsage(payload).usage;

/**
 * Read the cache pair through the exact provider precedence and completeness
 * rules used by live ingestion. The backfill enables strict validation so a
 * malformed retained payload stops the scan; ingestion remains diagnostic and
 * tolerant. Both policies share `decodeUsage` and differ only in that policy.
 */
export const extractCacheSplit = (
  payload: unknown,
  options: { strict?: boolean } = {},
): ExtractedCacheSplit => decodeUsage(payload, options).cacheSplit;

/**
 * Fold many payloads' usage into one absolute total. A field stays absent
 * unless at least one input carried it, so a run of cost-only payloads yields
 * `{costUsd}` with no token fields rather than three zeroes.
 */
export const sumUsage = (usages: SessionUsage[]): SessionUsage => {
  const total: SessionUsage = {};
  let observedCacheCreation = 0;
  let hasObservedCacheCreation = false;
  let cacheCreationUnknown = false;
  for (const usage of usages) {
    if (usage.inputTokens !== undefined) total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens;
    if (usage.outputTokens !== undefined) total.outputTokens = (total.outputTokens ?? 0) + usage.outputTokens;
    if (usage.cachedInputTokens !== undefined) total.cachedInputTokens = (total.cachedInputTokens ?? 0) + usage.cachedInputTokens;
    const cacheSplit = cacheSplitFromUsage(usage);
    if (cacheSplit.kind === "known") {
      observedCacheCreation += cacheSplit.cacheCreationInputTokens;
      hasObservedCacheCreation = true;
    }
    // An input-bearing event that omits the split makes the session-level
    // creation total unknown. Keep any known read total, but never fold a
    // creation value from a different event across that gap as though the
    // omitted component were zero. Codex events avoid this path by carrying an
    // explicit cacheCreationInputTokens: 0.
    if (cacheSplit.kind === "unknown") cacheCreationUnknown = true;
    if (usage.costUsd !== undefined) {
      total.costUsd = (total.costUsd ?? new Prisma.Decimal(0)).plus(usage.costUsd);
    }
  }
  if (!cacheCreationUnknown && hasObservedCacheCreation) {
    total.cacheCreationInputTokens = observedCacheCreation;
  }
  return total;
};

type ClaudeSessionUsage = {
  /** Per-invocation fallback tokens since the latest cumulative model snapshot. */
  topLevel: SessionUsage[];
  /** The latest cumulative model breakdown in event order, when present. */
  latestModelUsage: SessionUsage | null;
  /** The latest usable cumulative cost in event order, when present. */
  latestCostUsd: Prisma.Decimal | null;
};

/**
 * Fold stored FINAL_OUTPUT payloads into one SessionUsage total.
 *
 * Claude's `result.total_cost_usd` and `result.modelUsage` are cumulative for
 * the provider conversation identified by `session_id`; the latest usable
 * value for each is therefore selected once per provider conversation. The
 * top-level `usage` object remains per invocation. It is summed when a Claude
 * payload has no usable model breakdown after the latest cumulative snapshot
 * (the same fallback used by `extractUsage`); a new snapshot replaces those
 * earlier increments. Payloads without a provider session id retain the original
 * additive behavior used by Codex and PI.
 *
 * `payloads` must be in FINAL_OUTPUT sequence order. The recompute path reads
 * SessionEvent rows ordered by `seq`, and callers using this helper directly
 * should preserve that same order so "latest" has its provider meaning.
 */
export const sumSessionUsage = (payloads: readonly unknown[]): SessionUsage => {
  const ungrouped: SessionUsage[] = [];
  const claudeSessions = new Map<string, ClaudeSessionUsage>();

  for (const payload of payloads) {
    const decoded = decodeUsage(payload);
    const sessionId = decoded.providerSessionId;
    if (sessionId === null) {
      ungrouped.push(decoded.usage);
      continue;
    }

    const session = claudeSessions.get(sessionId) ?? {
      topLevel: [],
      latestModelUsage: null,
      latestCostUsd: null,
    } satisfies ClaudeSessionUsage;
    if (decoded.cumulativeModelUsage !== null) {
      session.latestModelUsage = decoded.cumulativeModelUsage;
      session.topLevel = [];
    } else {
      session.topLevel.push(decoded.topLevelUsage);
    }
    if (decoded.cumulativeCostUsd !== null) session.latestCostUsd = decoded.cumulativeCostUsd;
    claudeSessions.set(sessionId, session);
  }

  for (const session of claudeSessions.values()) {
    const usage = sumUsage([
      ...(session.latestModelUsage === null ? [] : [session.latestModelUsage]),
      ...session.topLevel,
    ]);
    if (session.latestCostUsd !== null) usage.costUsd = session.latestCostUsd;
    ungrouped.push(usage);
  }

  return sumUsage(ungrouped);
};

type DerivedUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalTokens: number | null;
  costUsd: Prisma.Decimal | null;
};

/**
 * The AGGREGATE token guard. Per-event rejection already happened in
 * `tokenCount`, so this catches only the case that one cannot see: a sum that
 * leaves INTEGER range even though every contributing event was individually
 * storable. Each column is judged on its own, so an overflowing `totalTokens`
 * becomes null while `inputTokens` and `outputTokens` keep their real values.
 */
const columnValue = (value: number | undefined, field: string): number | null => {
  if (value === undefined) return null;
  if (Number.isInteger(value) && value >= 0 && value <= MAX_INT4) return value;
  console.warn(`[usage] ${field}=${render(value)} is out of INTEGER range after summing; storing null`);
  return null;
};

/** The aggregate cost guard, for the same reason: two individually storable
 * events of 6e7 sum to 1.2e8, which Decimal(12, 4) cannot hold. Rounds first,
 * because the rounded value is what is written. */
const costColumn = (value: Prisma.Decimal | undefined): Prisma.Decimal | null => {
  if (value === undefined) return null;
  if (!value.isFinite() || value.isNegative()) {
    console.warn(`[usage] costUsd=${value.toString()} is not storable after summing; storing null`);
    return null;
  }
  const rounded = value.toDecimalPlaces(COST_SCALE);
  if (rounded.greaterThanOrEqualTo(MAX_COST)) {
    console.warn(`[usage] costUsd=${value.toString()} exceeds Decimal(12, 4) after summing; storing null`);
    return null;
  }
  return rounded;
};

/** Absolute column values implied by a session's summed usage. Exported for the
 * unit test; the write path goes through `recomputeSessionUsage`. */
export const deriveUsageColumns = (usage: SessionUsage): DerivedUsage => ({
  inputTokens: columnValue(usage.inputTokens, "inputTokens"),
  outputTokens: columnValue(usage.outputTokens, "outputTokens"),
  cachedInputTokens: columnValue(usage.cachedInputTokens, "cachedInputTokens"),
  cacheCreationInputTokens: columnValue(usage.cacheCreationInputTokens, "cacheCreationInputTokens"),
  // Never 0 and never an estimate: null unless the provider reported at least
  // one of the two halves. Input is already canonical and includes the cached
  // subset, so it must not be added here a second time.
  totalTokens: usage.inputTokens === undefined && usage.outputTokens === undefined
    ? null
    : columnValue((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), "totalTokens"),
  costUsd: costColumn(usage.costUsd),
});

const sameColumns = (
  current: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    cacheCreationInputTokens: number | null;
    totalTokens: number | null;
    costUsd: Prisma.Decimal | null;
  },
  derived: DerivedUsage,
): boolean =>
  current.inputTokens === derived.inputTokens
  && current.outputTokens === derived.outputTokens
  && current.cachedInputTokens === derived.cachedInputTokens
  && current.cacheCreationInputTokens === derived.cacheCreationInputTokens
  && current.totalTokens === derived.totalTokens
  && (current.costUsd === null
    ? derived.costUsd === null
    : derived.costUsd !== null && current.costUsd.equals(derived.costUsd));

/**
 * Advisory-lock class reserved for session usage recomputes. Registry of the
 * classes used anywhere in this repo — keep this list, pick a fresh number, do
 * not reuse:
 *   20260816 — session usage recompute (this module).
 * Batch 2.5's task exclusion uses a `SELECT … FOR UPDATE` on the Task row
 * (`workflow.ts:82`), not an advisory lock, so the two schemes cannot collide.
 */
export const SESSION_USAGE_LOCK_CLASS = 20260816;

/**
 * Deterministic 32-bit FNV-1a of a session id, in signed int4 range so it can be
 * the second argument of `pg_advisory_xact_lock(int4, int4)`. Hashed here rather
 * than by PostgreSQL's `hashtext()`, which is undocumented, is not promised
 * stable across major versions, and could not be unit-tested.
 *
 * Collisions are harmless: two unrelated sessions serialise against each other
 * for the length of one recompute. Correctness is unaffected; only concurrency
 * is, and the contended population is tiny — one runner per session.
 */
export const sessionUsageLockKey = (sessionId: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash = Math.imul(hash ^ sessionId.charCodeAt(index), 0x01000193);
  }
  return hash | 0;
};

/**
 * Recompute a session's derived usage columns from its stored `FINAL_OUTPUT`
 * events and write absolute values. Returns true when it actually wrote.
 *
 * `SessionEvent` is the source of truth and the five columns are a derived
 * cache, which is what makes this idempotent: replaying an already-ingested
 * batch converges instead of drifting, a resumed session accumulates for free
 * (each provider conversation's latest cumulative `FINAL_OUTPUT` is selected,
 * while fresh provider conversations still add), a write lost to a crash
 * between `createMany` and here is repaired by the next ingest or by the
 * backfill, and no NULL column is ever used in arithmetic.
 *
 * Concurrency: concurrent callers are serialised by a transaction-scoped
 * advisory lock keyed by session id. They do NOT converge on their own — that
 * claim, which this comment used to make, is false. Each caller writes an
 * ABSOLUTE value computed from the snapshot it read, so a caller that read at
 * T1 can commit after a caller that read at T2 > T1 and leave the older total
 * stored; `sameColumns` then sees a self-consistent row and suppresses every
 * later repair, making the stale value permanent. Serialising the read, the
 * compare and the write is a correctness requirement, not a performance note.
 */
const lockWaitTimedOut = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  const detail = `${error.message} ${"meta" in error ? render(error.meta) : ""}`;
  return (code === "P2010" && /55P03|lock timeout/i.test(detail))
    || (code === "P2028" && /timeout|expired/i.test(detail));
};

const recomputeSessionUsageOnce = async (db: PrismaClient, sessionId: string): Promise<boolean> =>
  db.$transaction(async (tx) => {
    // The timeout must be installed BEFORE the wait it is meant to bound.
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
    // The `::text AS locked` cast is LOAD-BEARING, not style. pg_advisory_xact_lock
    // returns `void`, and Prisma cannot deserialize a void column: the bare form
    // fails with P2010 "Failed to deserialize column of type 'void'" on EVERY call,
    // and the ingest path swallows that throw, so nothing would ever be cached.
    // Do not "simplify" it away — usage.dbtest.ts test 0 is what catches it.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${SESSION_USAGE_LOCK_CLASS}::int, ${sessionUsageLockKey(sessionId)}::int)::text AS locked`;

    const rows = await tx.sessionEvent.findMany({
      where: { sessionId, type: "FINAL_OUTPUT" },
      orderBy: { seq: "asc" },
      select: { payload: true },
    });
    const derived = deriveUsageColumns(sumSessionUsage(rows.map((row) => row.payload)));
    const current = await tx.session.findUnique({
      where: { id: sessionId },
      select: {
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        cacheCreationInputTokens: true,
        totalTokens: true,
        costUsd: true,
      },
    });
    if (!current || sameColumns(current, derived)) return false;
    await tx.session.update({ where: { id: sessionId }, data: derived });
    return true;
  }, {
    // Load-bearing, not decoration. Under RepeatableRead the snapshot is taken by
    // the first data-reading statement — which is the SELECT that ACQUIRES the
    // lock, i.e. before it is granted. A queued caller would then read the
    // pre-lock snapshot and write a stale absolute value with the lock held: the
    // fix defeated by its own lock.
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    timeout: 15_000,   // backstop above lock_timeout + the work, so a contended
    maxWait: 5_000,    // caller fails as 55P03 rather than as an opaque P2028
  });

/**
 * A 55P03 is not a clean outcome: the FINAL_OUTPUT event is already durable,
 * and the caller in app.ts intentionally suppresses recompute failures. If the
 * older lock holder then commits a snapshot that predates that event, no later
 * event need arrive to repair the cache. Keep this invocation alive across
 * bounded lock waits instead of acknowledging an unperformed recompute.
 *
 * The retry count is deliberately unbounded. A fixed count merely moves the
 * stale-cache window. Each attempt is still bounded by PostgreSQL and Prisma,
 * rolls back before retrying, and holds no application resource between tries.
 */
export const recomputeSessionUsage = async (db: PrismaClient, sessionId: string): Promise<boolean> => {
  for (;;) {
    try {
      return await recomputeSessionUsageOnce(db, sessionId);
    } catch (error) {
      if (!lockWaitTimedOut(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
};
