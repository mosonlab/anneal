import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RunnerPreference } from "@prisma/client";

import {
  assertCanonicalAgentSources,
  canonicalRoleSlugSuffix,
  MODEL_FREE_CANONICAL_ROLES,
} from "./agent-contract.js";
import { loadAgentSources, loadStarterAgentSource, PUBLIC_STARTER_ROLE_NAME } from "./agent-sources.js";

/**
 * The public starter is the release-owned source, not a copy of it.
 *
 * OSS-B0's onboarding creates exactly one Agent, and the only thing standing
 * between "the reviewed `default` role" and "whatever literal someone typed into
 * the API" is this file. So the assertions are deliberately about identity with
 * `agents/` on disk and with the canonical contract — not about the strings
 * themselves, which would just be the same literals a second time.
 */
const agentsRoot = fileURLToPath(new URL("../../../agents/", import.meta.url));

const documentBody = async (relativePath: string): Promise<string> => {
  const source = (await readFile(`${agentsRoot}${relativePath}`, "utf8")).replace(/\r\n/g, "\n");
  return source.slice(source.indexOf("\n---\n", 4) + 5).trim();
};

test("the public starter is the canonical CODEX default role from agents/", async () => {
  const [starter, sources] = await Promise.all([loadStarterAgentSource(), loadAgentSources()]);
  const expected = sources.roles.find((role) => role.name === PUBLIC_STARTER_ROLE_NAME);
  assert.ok(expected, "the role sources must name a default starter");
  assert.equal(starter.name, PUBLIC_STARTER_ROLE_NAME);
  assert.equal(starter.runnerPreference, RunnerPreference.CODEX);
  assert.equal(starter.runnerPreference, expected.runnerPreference);
  assert.equal(starter.model, expected.model);
});

test("the starter carries the foundational and role prompts byte for byte", async () => {
  const starter = await loadStarterAgentSource();
  assert.equal(starter.foundationalPrompt, await documentBody("foundational.md"));
  assert.equal(starter.rolePrompt, await documentBody(`roles/${PUBLIC_STARTER_ROLE_NAME}.md`));
  assert.ok(starter.foundationalPrompt.length > 0);
  assert.ok(starter.rolePrompt.length > 0);
});

test("the starter's own record agrees with the role the full loader returns", async () => {
  const [sources, starter] = await Promise.all([loadAgentSources(), loadStarterAgentSource()]);
  const role = sources.roles.find((candidate) => candidate.name === PUBLIC_STARTER_ROLE_NAME);
  assert.ok(role);
  assert.deepEqual(
    { ...starter, foundationalPrompt: undefined },
    {
      canonicalRole: role.canonicalRole,
      name: role.name,
      title: role.title,
      model: role.model,
      runnerPreference: role.runnerPreference,
      inboxAccess: role.inboxAccess,
      rolePrompt: role.rolePrompt,
      foundationalPrompt: undefined,
    },
  );
});

test("the extracted loader still reads the whole contract the internal seed consumes", async () => {
  const sources = await loadAgentSources();
  assert.ok(sources.roles.length > 0);
  assert.equal(new Set(sources.roles.map((role) => role.name)).size, sources.roles.length);
});

test("the loader exposes the two independent review roles exactly once", async () => {
  const sources = await loadAgentSources();
  const reviewRoles = sources.roles.filter(({ canonicalRole }) => (
    canonicalRole === "code-reviewer-sol-high"
    || canonicalRole === "code-reviewer-opus-medium"
  ));
  assert.deepEqual(reviewRoles.map(({ canonicalRole }) => canonicalRole).sort(), [
    "code-reviewer-opus-medium",
    "code-reviewer-sol-high",
  ]);
  // The adjudication role is archived: the fix step dispositions both reports itself.
  assert.equal(sources.roles.some(({ canonicalRole }) => canonicalRole === "review-adjudicator-opus"), false);
  const blind = reviewRoles.find(({ canonicalRole }) => canonicalRole === "code-reviewer-opus-medium");
  assert.ok(blind);
  assert.equal(blind.runnerPreference, RunnerPreference.CLAUDE);
});

/**
 * Canonical identity is the role file, so the loader has to state it: every role
 * carries its file name, and the file name is the frontmatter name. Without this,
 * `canonicalRole` on a persisted Agent could name a role no source file matches.
 */
test("every role carries its own file name as its canonical role", async () => {
  const sources = await loadAgentSources();
  const roleFiles = (await readdir(`${agentsRoot}roles`))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
  assert.deepEqual(sources.roles.map(({ canonicalRole }) => canonicalRole).sort(), roleFiles);
  for (const role of sources.roles) assert.equal(role.name, role.canonicalRole);
});

/**
 * The naming contract itself: a slug states the runtime it binds, a title states
 * the role. Both are asserted on load, so a rename that moves one and not the
 * other stops the release rather than reaching a console.
 */
test("every canonical slug names its model and effort, and every title names only the role", async () => {
  const sources = await loadAgentSources();
  for (const role of sources.roles) {
    const words = role.title.trim().split(/\s+/u);
    assert.ok(words.length <= 2, `${role.name} title ${role.title}`);
    if (MODEL_FREE_CANONICAL_ROLES.includes(role.name as typeof MODEL_FREE_CANONICAL_ROLES[number])) continue;
    const suffix = canonicalRoleSlugSuffix(role.model);
    assert.ok(suffix, `${role.name} model ${role.model}`);
    assert.ok(role.name.endsWith(suffix), `${role.name} does not end with ${suffix}`);
  }
});

test("the contract refuses a slug, a title or a file name that drifts from the role", () => {
  const role = {
    canonicalRole: "senior-dev-astra-low",
    name: "senior-dev-astra-low",
    title: "Senior Dev",
    model: "gpt-6-astra:low",
    runnerPreference: RunnerPreference.CODEX,
  };
  assert.doesNotThrow(() => assertCanonicalAgentSources([role]));
  assert.throws(() => assertCanonicalAgentSources([{ ...role, name: "senior-dev", canonicalRole: "senior-dev" }]), /must be named/u);
  assert.throws(() => assertCanonicalAgentSources([{ ...role, canonicalRole: "senior-dev" }]), /named after the role/u);
  assert.throws(() => assertCanonicalAgentSources([{ ...role, title: "Senior Developer (Astra low)" }]), /must be one or two capitalised words/u);
  assert.throws(() => assertCanonicalAgentSources([{ ...role, title: "Astra Dev" }]), /names the runtime/u);
  assert.throws(() => assertCanonicalAgentSources([{ ...role, title: "Low Dev" }]), /names the runtime/u);
});
