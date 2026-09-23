/**
 * The model catalog and the runner rule live in `@anneal/db/model-routing`,
 * a subpath that imports nothing at all, so the console reads the same rule the
 * control plane runs instead of a hand copy of it. This module re-exports the
 * part of that surface the model controls use and adds the one question only the
 * console asks. It is not the only door: `lib/tools.ts` carries the tool-key
 * surface, and a caller wanting one function may import the subpath directly.
 */

import { findModel, MODELS, runnerFor, splitModel } from "@anneal/db/model-routing";
import type { RunnerPreference } from "./types";

export {
  findModel,
  joinModel,
  MODELS,
  runnerFor,
  runnerForModel,
  splitModel,
  validateModelPair,
} from "@anneal/db/model-routing";

/** Whether the pair exposes the Codex service tier. A console control: the
 *  field exists on every agent, and this decides where it is worth showing. */
export const supportsCodexServiceTier = (preference: RunnerPreference, model: string): boolean => {
  const runner = runnerFor(preference, model);
  const id = splitModel(model).model;
  return (runner === "CODEX" && id.startsWith("gpt-"))
    || (runner === "PI" && id.startsWith("openai-codex/"));
};

/* ------------------------------------------------------------ slug naming */

/** Vendor and version tokens a catalog model id carries around its short name.
 *  Mirrors `MODEL_ID_NOISE` in `packages/db/src/agent-contract.ts`, which the
 *  console cannot import: that module reaches `@prisma/client`, and the browser
 *  bundle must not. The catalog itself is shared, so the two derive the same
 *  short names from the same ids. */
const MODEL_ID_NOISE = new Set(["claude", "gpt", "openai", "codex"]);

/** The short name a slug carries for a model: `gpt-6-astra` is `astra`,
 *  `claude-fable-5` is `fable`. Null when the id names no single word — the
 *  mechanical `mechanical/merge-executor-v1` is the live example. */
export const modelShortName = (rawModel: string): string | null => {
  const { model } = splitModel(rawModel);
  const words = model.slice(model.lastIndexOf("/") + 1)
    .split("-")
    .filter((word) => /^[a-z]+$/u.test(word) && !MODEL_ID_NOISE.has(word));
  return words.length === 1 ? words[0]! : null;
};

/** The two roles whose slug names no model, and whose names the console never
 *  regenerates: `default` is the starter Agent every installation gets under a
 *  stable name, and `merge-integrator` is the mechanical sentinel that runs no
 *  model at all. Mirrors `MODEL_FREE_CANONICAL_ROLES`. */
export const SLUG_EXEMPT_AGENT_NAMES: readonly string[] = ["default", "merge-integrator"];

const SHORT_NAMES = new Set(MODELS.map((entry) => modelShortName(entry.id)).filter((name): name is string => name !== null));
const EFFORTS = new Set(MODELS.flatMap((entry) => entry.efforts));

/**
 * The role half of an Agent slug: `senior-dev-astra-medium` is `senior-dev`.
 *
 * A trailing `-<short name>-<effort>` is dropped only when both halves are ones
 * the catalog knows, so an operator's own `nightly-triage` keeps its whole name
 * as the role rather than losing two words to a coincidence.
 */
export const agentRoleFromName = (name: string): string => {
  const parts = name.split("-");
  if (parts.length < 3) return name;
  const effort = parts[parts.length - 1]!;
  const short = parts[parts.length - 2]!;
  return EFFORTS.has(effort) && SHORT_NAMES.has(short) ? parts.slice(0, -2).join("-") : name;
};

/**
 * The slug a name implies once it runs `model`: `role-model-effort` (R10).
 * Null when the model names no short name or pins no effort — a Custom model
 * has no slug to offer, and the name stays whatever the operator typed.
 */
export const slugForModel = (name: string, model: string): string | null => {
  const parsed = splitModel(model);
  // A Custom model is not one the slug rule names, so there is nothing to offer.
  if (findModel(parsed.model) === null) return null;
  const short = modelShortName(model);
  const { effort } = splitModel(model);
  if (short === null || effort === null || effort === "") return null;
  const role = agentRoleFromName(name);
  return role === "" ? null : `${role}-${short}-${effort}`;
};

/** `title · model effort` — the role and the price of running it, which is the
 *  pair an operator weighs in every Agent picker: the chain's staffing select,
 *  the task header's, and the New Task panel's. The model half is resolved
 *  through the catalog so the option reads `Claude Opus 5.5 high` rather than the
 *  stored `claude-opus-5-5:high`. */
export const agentOptionLabel = (agent: { title: string; model: string }): string => {
  const parsed = splitModel(agent.model);
  const model = findModel(parsed.model)?.label ?? parsed.model;
  return parsed.effort === null ? `${agent.title} · ${model}` : `${agent.title} · ${model} ${parsed.effort}`;
};

/** The chip form of a model: the catalog's label and the effort it pins, as one
 *  string, because a chip is a single line of text and not a layout. */
export const modelChipLabel = (model: string): string => {
  const parsed = splitModel(model);
  const label = findModel(parsed.model)?.label ?? parsed.model;
  return parsed.effort === null ? label : `${label} · ${parsed.effort}`;
};
