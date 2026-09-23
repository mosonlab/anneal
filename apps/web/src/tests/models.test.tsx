import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENFORCED_BY, findModel, joinModel, MODELS, runnerForModel, splitModel, TOOL_KEYS, validateModelPair,
} from "@anneal/db/model-routing";
import {
  agentRoleFromName, modelChipLabel, modelShortName, slugForModel, SLUG_EXEMPT_AGENT_NAMES,
} from "../lib/models";

/** The `mechanical/` provider is not a model provider. `merge-integrator` is a
 *  sentinel role whose "model" names a program, and the picker must *not* offer
 *  it — `findModel` returning null is precisely what keeps it unassignable. The
 *  assertion below states that, so the exclusion cannot silently widen. */
const MECHANICAL_PREFIX = "mechanical/";

test("the catalog covers every canonical roster model", () => {
  const roles = fileURLToPath(new URL("../../../../agents/roles/", import.meta.url));
  const ids = readdirSync(roles).filter((name) => name.endsWith(".md")).map((name) => {
    const source = readFileSync(resolve(roles, name), "utf8");
    return splitModel(source.match(/^model:\s*(\S+)/mu)?.[1] ?? "").model;
  });
  for (const id of ids.filter((id) => !id.startsWith(MECHANICAL_PREFIX))) assert.ok(findModel(id), id);
  const mechanical = ids.filter((id) => id.startsWith(MECHANICAL_PREFIX));
  assert.deepEqual(mechanical, ["mechanical/merge-executor-v1"]);
  for (const id of mechanical) assert.equal(findModel(id), null, id);
  assert.equal(findModel("claude-fable-5")?.defaultEffort, "medium");
  assert.equal(findModel("gpt-6-luna")?.defaultEffort, "max");
  assert.equal(findModel("gpt-6-astra")?.defaultEffort, "medium");
  assert.equal(findModel("openai-codex/gpt-6-sol")?.defaultEffort, "high");
  assert.equal(findModel("openai-codex/gpt-6-luna")?.defaultEffort, "max");
});

test("catalog ids are unique and every default effort is selectable", () => {
  assert.equal(new Set(MODELS.map((entry) => entry.id)).size, MODELS.length);
  for (const entry of MODELS) {
    assert.ok(entry.efforts.length > 0, entry.id);
    assert.ok(entry.efforts.includes(entry.defaultEffort), entry.id);
  }
});

test("model effort encoding round-trips on the runner's last-colon rule", () => {
  for (const raw of ["claude-fable-5:medium", "claude-opus-5:high", "gpt-6-luna:max", "openai-codex/gpt-6-luna:xhigh", "claude-opus-5", ":high"]) {
    const parsed = splitModel(raw);
    assert.equal(joinModel(parsed.model, parsed.effort), raw);
  }
  assert.deepEqual(splitModel(":high"), { model: ":high", effort: null });
});

test("pi-hosted entries override the substring heuristic in the catalog", () => {
  assert.equal(runnerForModel("openai-codex/gpt-6-sol:high"), "PI");
  assert.equal(runnerForModel("openai-codex/gpt-6-luna:xhigh"), "PI");
});

test("tool keys and enforcement cover exactly the three concrete runners", () => {
  assert.deepEqual(TOOL_KEYS, ["BASH", "READ", "WRITE", "EDIT", "GLOB", "GREP", "WEB_FETCH", "WEB_SEARCH"]);
  assert.deepEqual(Object.keys(ENFORCED_BY).sort(), ["CLAUDE", "CODEX", "PI"]);
});

test("validateModelPair names mismatches and permits the Custom escape hatch", () => {
  assert.deepEqual(validateModelPair("gpt-6-luna", "CLAUDE"), { kind: "mismatch", model: "gpt-6-luna", expected: "CODEX", actual: "CLAUDE" });
  assert.equal(validateModelPair("gpt-6-luna", "CODEX"), null);
  assert.equal(validateModelPair("my-own-model", "INHERIT"), null);
  assert.deepEqual(validateModelPair("", "CLAUDE"), { kind: "empty-model" });
  assert.equal(validateModelPair("claude-opus-5:high", "CLAUDE"), null);
});

/* ------------------------------------------------------------ slug naming */

test("every catalog model names the short name its slugs carry", () => {
  assert.deepEqual(
    ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "claude-opus-5", "claude-fable-5"].map(modelShortName),
    ["astra", "luna", "sol", "opus", "fable"],
  );
  // The pi-hosted entries name the same model as their codex twins.
  assert.equal(modelShortName("openai-codex/gpt-6-luna:max"), "luna");
  // The mechanical sentinel names no model, which is why it has no slug.
  assert.equal(modelShortName("mechanical/merge-executor-v1"), null);
  for (const entry of MODELS) assert.ok(modelShortName(entry.id), entry.id);
});

test("the role half of a slug survives a runtime that changed under it", () => {
  assert.equal(agentRoleFromName("senior-dev-astra-medium"), "senior-dev");
  assert.equal(agentRoleFromName("code-reviewer-sol-high"), "code-reviewer");
  assert.equal(agentRoleFromName("planner-opus-xhigh"), "planner");
  // Not a short-name/effort pair, so nothing is stripped.
  assert.equal(agentRoleFromName("nightly-triage"), "nightly-triage");
  assert.equal(agentRoleFromName("senior-dev-astra-turbo"), "senior-dev-astra-turbo");
  assert.equal(agentRoleFromName("merge-integrator"), "merge-integrator");
  assert.equal(agentRoleFromName("default"), "default");
});

test("a slug is role-model-effort, and the model-free roles have none to regenerate", () => {
  assert.equal(slugForModel("senior-dev-luna-max", "gpt-6-astra:medium"), "senior-dev-astra-medium");
  assert.equal(slugForModel("senior-dev-astra-medium", "gpt-6-luna:max"), "senior-dev-luna-max");
  assert.equal(slugForModel("code-reviewer-sol-high", "claude-opus-5:high"), "code-reviewer-opus-high");
  assert.equal(slugForModel("librarian-opus-medium", "claude-fable-5:low"), "librarian-fable-low");
  // An operator's own role name is the whole role.
  assert.equal(slugForModel("nightly-triage", "gpt-6-sol:high"), "nightly-triage-sol-high");
  // A Custom model is outside the rule, and a model with no effort pins nothing.
  assert.equal(slugForModel("nightly-triage", "private/model:turbo"), null);
  assert.equal(slugForModel("senior-dev-astra-medium", "gpt-6-astra"), null);
  assert.equal(slugForModel("merge-integrator", "mechanical/merge-executor-v1"), null);
  assert.deepEqual([...SLUG_EXEMPT_AGENT_NAMES], ["default", "merge-integrator"]);
});

test("the chip label states the catalog model and the effort, and nothing else", () => {
  assert.equal(modelChipLabel("gpt-6-astra:medium"), "GPT-6 Astra (codex) · medium");
  assert.equal(modelChipLabel("openai-codex/gpt-6-luna:max"), "GPT-6 Luna (pi) · max");
  assert.equal(modelChipLabel("claude-opus-5"), "Claude Opus 5");
  assert.equal(modelChipLabel("private/model:turbo"), "private/model · turbo");
});
