/**
 * The release-owned loader for `agents/`, the source of every seeded agent
 * prompt and initial model/runner default.
 *
 * It used to live inside `prisma/seed.ts`, reachable only by running that seed —
 * which creates the internal multi-role installation, every collaboration edge
 * and the twelve-step template. OSS-B0's first-run onboarding
 * needs exactly one of those roles, the canonical `default` starter, created
 * inside one API transaction that must never run the internal seed (plan Fixed
 * Decision 4). So the loader moved here, `seed.ts` consumes it unchanged, and
 * the API consumes `loadStarterAgentSource` — which reads the same files and is
 * validated against the same `agents/` contract, so the starter cannot drift
 * from the release-owned source by being copied into the API as literals.
 *
 * The path is resolved from this module's own URL and `packages/db/src` and
 * `packages/db/dist` sit at the same depth, so the compiled and the tsx-loaded
 * form read the identical directory.
 */
import { readdir, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { RunnerPreference } from "@prisma/client";

import { assertCanonicalAgentSources } from "./agent-contract.js";
import { parseInlineList, parsePromptDocument, requiredFrontmatter } from "./prompt-document.js";

const agentsRoot = fileURLToPath(new URL("../../../agents/", import.meta.url));

export type RoleSource = {
  /**
   * The `agents/roles/<canonicalRole>.md` file name, and the canonical identity of
   * every Agent installed from it. It equals `name` in the source — a role file's
   * frontmatter name is its slug — and only an operator edit can move a persisted
   * row's `name` away from it.
   */
  canonicalRole: string;
  name: string;
  title: string;
  model: string;
  runnerPreference: RunnerPreference;
  inboxAccess: boolean;
  collaborators: string[];
  rolePrompt: string;
};
export type AgentSources = { foundationalPrompt: string; roles: RoleSource[] };

/** Canonical role slugs aligned with the model/effort already running in production. */
export const CANONICAL_ROLE_RENAMES = [
  ["regression-verifier-luna-xhigh", "regression-verifier-luna-max"],
  ["code-reviewer-opus-high", "code-reviewer-opus-medium"],
  ["merge-resolver-opus-medium", "merge-resolver-luna-max"],
  ["plan-reviser-opus-high", "plan-reviser-opus-medium"],
  ["plan-executor-astra-medium", "plan-executor-astra-low"],
] as const;

export type PersistedRoleStructure = {
  /**
   * Present on rows read by canonical identity. `name` and `title` are now
   * adoptable rather than structural — an operator may rename an Agent — so the
   * column that says which role a row is has to be compared as well.
   */
  canonicalRole?: string | null;
  name?: string;
  title: string;
  model: string;
  runnerPreference: RunnerPreference;
  inboxAccess: boolean;
  collaborators: Array<{ allowedAgent: { name: string } }>;
};

export const roleSourceStructureDifferences = (
  actual: PersistedRoleStructure,
  expected: RoleSource,
): string[] => {
  const actualCollaborators = actual.collaborators.map(({ allowedAgent }) => allowedAgent.name).sort();
  const expectedCollaborators = [...expected.collaborators].sort();
  const fields = [
    ...(actual.canonicalRole === undefined
      ? []
      : [["canonicalRole", actual.canonicalRole, expected.canonicalRole] as const]),
    ...(actual.name === undefined ? [] : [["name", actual.name, expected.name] as const]),
    ["title", actual.title, expected.title],
    ["model", actual.model, expected.model],
    ["runnerPreference", actual.runnerPreference, expected.runnerPreference],
    ["inboxAccess", actual.inboxAccess, expected.inboxAccess],
    ["collaborators", actualCollaborators, expectedCollaborators],
  ] as const;
  return fields
    .filter(([, actualValue, expectedValue]) => !isDeepStrictEqual(actualValue, expectedValue))
    .map(([field]) => field);
};

const runnerPreference = (value: string, filePath: string): RunnerPreference => {
  const runner = value.toUpperCase();
  if (!(runner in RunnerPreference)) throw new Error(`${filePath} has unsupported runner ${value}`);
  return RunnerPreference[runner as keyof typeof RunnerPreference];
};

export const loadAgentSources = async (): Promise<AgentSources> => {
  const foundationalFile = `${agentsRoot}foundational.md`;
  const foundationalPrompt = parsePromptDocument(await readFile(foundationalFile, "utf8"), foundationalFile).body;
  const roleDirectory = `${agentsRoot}roles`;
  const roleFiles = (await readdir(roleDirectory)).filter((name) => name.endsWith(".md")).sort();
  const roles: RoleSource[] = [];
  for (const filename of roleFiles) {
    const filePath = `${roleDirectory}/${filename}`;
    const document = parsePromptDocument(await readFile(filePath, "utf8"), filePath);
    const inboxAccess = requiredFrontmatter(document, "inboxAccess", filePath);
    if (inboxAccess !== "true" && inboxAccess !== "false") throw new Error(`${filePath} inboxAccess must be true or false`);
    // The file name is the canonical identity, so it must not become a second
    // name a role could drift from: a source whose frontmatter disagrees with its
    // file name is refused rather than resolved in favour of either.
    const canonicalRole = filename.slice(0, -".md".length);
    const name = requiredFrontmatter(document, "name", filePath);
    if (name !== canonicalRole) {
      throw new Error(`${filePath} declares name ${name}; a canonical role file is named after the role`);
    }
    roles.push({
      canonicalRole,
      name,
      title: requiredFrontmatter(document, "title", filePath),
      model: requiredFrontmatter(document, "model", filePath),
      runnerPreference: runnerPreference(requiredFrontmatter(document, "runner", filePath), filePath),
      inboxAccess: inboxAccess === "true",
      collaborators: parseInlineList(document.attributes.collaborators, filePath, "collaborators"),
      rolePrompt: document.body,
    });
  }
  assertCanonicalAgentSources(roles);
  return { foundationalPrompt, roles };
};

/**
 * The one public starter. Named here rather than in the API so that the role
 * whose prompt a fresh installation receives is decided in the same package as
 * the contract that pins its runner and model.
 */
export const PUBLIC_STARTER_ROLE_NAME = "default";

export type StarterAgentSource = {
  canonicalRole: string;
  name: string;
  title: string;
  model: string;
  runnerPreference: RunnerPreference;
  inboxAccess: boolean;
  foundationalPrompt: string;
  rolePrompt: string;
};

/**
 * The starter a first-run installation creates: the canonical `default` role's
 * own prompt, plus the shared foundational prompt, exactly as `agents/` states
 * them.
 *
 * The whole role set is loaded and asserted first on purpose. `agents/` is one
 * reviewed contract, and a starter selected out of a directory that no longer
 * satisfies it is not the reviewed starter. The CODEX runner requirement is
 * checked here as well, because the v0.1 readiness gate is a Codex gate: an
 * installation that silently seeded a Claude starter would present a runner
 * the rehearsal never proved. The model itself remains owned by the role
 * frontmatter loaded above.
 */
export const loadStarterAgentSource = async (): Promise<StarterAgentSource> => {
  const sources = await loadAgentSources();
  const role = sources.roles.find((candidate) => candidate.name === PUBLIC_STARTER_ROLE_NAME);
  if (!role) throw new Error(`agents/ contract is missing the ${PUBLIC_STARTER_ROLE_NAME} starter role`);
  if (role.runnerPreference !== RunnerPreference.CODEX) {
    throw new Error(`the public starter must be a CODEX agent; the role source names ${role.runnerPreference}`);
  }
  if (sources.foundationalPrompt.length === 0) throw new Error("agents/foundational.md has an empty body");
  if (role.rolePrompt.length === 0) throw new Error(`agents/roles/${PUBLIC_STARTER_ROLE_NAME}.md has an empty body`);
  return {
    canonicalRole: role.canonicalRole,
    name: role.name,
    title: role.title,
    model: role.model,
    runnerPreference: role.runnerPreference,
    inboxAccess: role.inboxAccess,
    foundationalPrompt: sources.foundationalPrompt,
    rolePrompt: role.rolePrompt,
  };
};
