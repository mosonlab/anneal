/**
 * The model catalog and the runner rule, in one place both sides can import.
 *
 * Everything here is pure and this file imports nothing at all — the same bar
 * `merge-integrator.ts` holds, and for the same reason: the browser bundle must
 * not pull in Prisma, so `@anneal/db/model-routing` is published as a subpath
 * that reaches no client, no schema and no I/O.
 *
 * The runner types are written as string-literal unions rather than imported
 * from `@prisma/client`. `RunnerPreference.CLAUDE === "CLAUDE"` at runtime and
 * the generated enums are themselves literal unions, so the two are byte- and
 * type-compatible; a value import would be the one thing that breaks purity.
 *
 * Before this module the rule existed three times: `runnerFor` in `workflow.ts`,
 * a hand copy named `resolveRunner` in the web app, and `ENFORCED_BY` in the web
 * app's tool list. A test table was the only thing holding the copies together.
 */

export type RunnerKindLiteral = "CLAUDE" | "CODEX" | "PI";
export type RunnerPreferenceLiteral = RunnerKindLiteral | "AUTO" | "INHERIT";

export type CatalogModel = {
  id: string;
  label: string;
  runner: RunnerKindLiteral;
  efforts: string[];
  defaultEffort: string;
};

/**
 * CODEX was checked against the installed CLI on 2026-08-16. Its structured
 * invalid-enum response named all seven values captured in
 * spikes/cli-capabilities/samples/codex-effort-nonsense.stdout.
 */
const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PI_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** The catalog is the console's allowlist, not the CLI's: it deliberately omits Astra's `ultra` tier. */
const ASTRA_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const MODELS: CatalogModel[] = [
  { id: "claude-fable-5", label: "Claude Fable 5", runner: "CLAUDE", efforts: CLAUDE_EFFORTS, defaultEffort: "medium" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", runner: "CLAUDE", efforts: CLAUDE_EFFORTS, defaultEffort: "medium" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", runner: "CLAUDE", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", runner: "CLAUDE", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { id: "gpt-6-sol", label: "GPT-6 Sol (codex)", runner: "CODEX", efforts: CODEX_EFFORTS, defaultEffort: "high" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (codex)", runner: "CODEX", efforts: CODEX_EFFORTS, defaultEffort: "medium" },
  { id: "gpt-6-luna", label: "GPT-6 Luna (codex)", runner: "CODEX", efforts: CODEX_EFFORTS, defaultEffort: "max" },
  { id: "gpt-6-astra", label: "GPT-6 Astra (codex)", runner: "CODEX", efforts: ASTRA_EFFORTS, defaultEffort: "medium" },
  { id: "openai-codex/gpt-6-sol", label: "GPT-6 Sol (pi)", runner: "PI", efforts: PI_EFFORTS, defaultEffort: "high" },
  { id: "openai-codex/gpt-6-luna", label: "GPT-6 Luna (pi)", runner: "PI", efforts: PI_EFFORTS, defaultEffort: "max" },
];

export const TOOL_KEYS = ["BASH", "READ", "WRITE", "EDIT", "GLOB", "GREP", "WEB_FETCH", "WEB_SEARCH"] as const;
export type ToolKey = typeof TOOL_KEYS[number];

/** Must stay in lockstep with packages/runner/src/adapters.ts's CLI maps. */
export const ENFORCED_BY: Record<RunnerKindLiteral, ToolKey[]> = {
  CLAUDE: [...TOOL_KEYS],
  CODEX: [],
  PI: ["BASH", "READ", "WRITE", "EDIT"],
};

/** The runner's last-colon rule: `model:effort`, where the model may contain
 *  colons and a leading colon is part of the model, not an empty name. */
export const splitModel = (raw: string): { model: string; effort: string | null } => {
  const at = raw.lastIndexOf(":");
  return at > 0 ? { model: raw.slice(0, at), effort: raw.slice(at + 1) } : { model: raw, effort: null };
};

export const joinModel = (model: string, effort: string | null): string => effort === null ? model : `${model}:${effort}`;

export const findModel = (id: string): CatalogModel | null => MODELS.find((entry) => entry.id === id) ?? null;

/** Catalog linkage: the runner a listed model is offered under. For the runtime
 *  answer, including Custom models the catalog does not list, use `runnerFor`. */
export const runnerForModel = (id: string): RunnerKindLiteral | null => findModel(splitModel(id).model)?.runner ?? null;

/** Naming convention rather than catalog membership: it answers for a model the
 *  catalog never listed, and returns null for one whose prefix names no runner
 *  (the mechanical sentinel), which is what keeps the runner/model assertion in
 *  `agent-contract.ts` off it. */
export const catalogRunnerForModel = (raw: string): RunnerPreferenceLiteral | null => {
  const { model } = splitModel(raw);
  if (model.startsWith("claude-")) return "CLAUDE";
  if (model.startsWith("openai-codex/")) return "PI";
  if (model.startsWith("gpt-")) return "CODEX";
  return null;
};

/** The runtime answer: which CLI a run actually gets. A concrete preference
 *  wins; otherwise the model name decides. This is the authority — the API, the
 *  runner and the console all read it here. */
export const runnerFor = (preference: RunnerPreferenceLiteral, model: string): RunnerKindLiteral => {
  if (preference === "CLAUDE" || preference === "CODEX" || preference === "PI") return preference;
  const normalized = model.toLowerCase();
  if (normalized.includes("codex")) return "CODEX";
  if (normalized.includes("deepseek") || normalized.split(/[\/:_-]+/u).includes("pi")) return "PI";
  return "CLAUDE";
};

export type ModelPairIssue =
  | { kind: "mismatch"; model: string; expected: RunnerKindLiteral; actual: RunnerPreferenceLiteral }
  | { kind: "empty-model" }
  | null;

/** A listed model pinned to the wrong concrete runner is a mismatch; an unlisted
 *  model is the Custom escape hatch and is never one. */
export const validateModelPair = (model: string, preference: RunnerPreferenceLiteral): ModelPairIssue => {
  if (model.trim().length === 0) return { kind: "empty-model" };
  const id = splitModel(model).model;
  const entry = findModel(id);
  if (entry && (preference === "CLAUDE" || preference === "CODEX" || preference === "PI") && preference !== entry.runner) {
    return { kind: "mismatch", model: id, expected: entry.runner, actual: preference };
  }
  return null;
};
