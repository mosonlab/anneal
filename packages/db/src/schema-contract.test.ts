import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CHAIN_LAYER_CONTRACT_COLUMNS,
  CHAIN_LAYER_IDENTITY_CHECK,
  TASK_DISPATCH_BINDING_COLUMNS,
} from "./schema-census.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const retiredFollowUpToken = ["follow", "UpTaskId"].join("");

const filesUnder = (root: string, predicate: (path: string) => boolean): string[] => {
  const entries = readdirSync(root);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path, predicate));
    else if (predicate(path)) files.push(path);
  }
  return files;
};

const sourceFiles = [
  ...filesUnder(join(repositoryRoot, "packages", "db", "src"), (path) => /\.ts$/u.test(path) && !/\.test\.ts$/u.test(path) && !/\.dbtest\.ts$/u.test(path)),
  ...filesUnder(join(repositoryRoot, "packages", "api", "src"), (path) => /\.ts$/u.test(path) && !/\.test\.ts$/u.test(path) && !/\.dbtest\.ts$/u.test(path)),
  ...filesUnder(join(repositoryRoot, "apps", "web", "src"), (path) => /\.(?:ts|tsx)$/u.test(path) && !/\.test\.(?:ts|tsx)$/u.test(path)),
];

const reviewSources = [
  ...filesUnder(join(repositoryRoot, "agents", "roles"), (path) => /\.md$/u.test(path)),
  ...filesUnder(join(repositoryRoot, "agents", "templates"), (path) => /\.md$/u.test(path)),
];

test("the final chain schema contract and source census have one successor authority", () => {
  const schema = readFileSync(join(repositoryRoot, "packages", "db", "prisma", "schema.prisma"), "utf8");
  assert.match(schema, /layer\s+Int\s*$/mu);
  assert.match(schema, /chainLayer\s+Int\?/u);
  assert.doesNotMatch(schema, new RegExp(retiredFollowUpToken, "u"));
  assert.doesNotMatch(schema, /TaskFollowUp/u);
  assert.doesNotMatch(schema, /ChainContinuation/u);
  assert.deepEqual(CHAIN_LAYER_CONTRACT_COLUMNS, [
    { table: "TaskTemplateStep", column: "layer", nullable: false },
    { table: "Task", column: "chainLayer", nullable: true },
  ]);
  assert.equal(CHAIN_LAYER_IDENTITY_CHECK, "Task_chain_identity_all_or_none_check");
  // The pointer is deliberately not unique: one predecessor accepts several
  // bound successor chains, and the list side of the relation is the proof.
  assert.match(schema, /dispatchAfterTaskId\s+String\?\s*$/mu);
  assert.match(schema, /dispatchAfter\s+Task\?\s+@relation\("TaskDispatchBinding"/u);
  assert.match(schema, /dispatchedChainFirstTasks\s+Task\[\]\s+@relation\("TaskDispatchBinding"/u);
  assert.match(schema, /@@index\(\[dispatchAfterTaskId, projectId\]\)/u);
  assert.doesNotMatch(schema, /@@unique\(\[dispatchAfterTaskId, projectId\]\)/u);
  assert.deepEqual(TASK_DISPATCH_BINDING_COLUMNS, [
    { table: "Task", column: "dispatchAfterTaskId", nullable: true },
  ]);

  const forbiddenSourcePatterns = [
    new RegExp(retiredFollowUpToken, "u"),
    /TaskFollowUp/u,
    /ChainContinuation/u,
    /\b(?:dependencyIds|siblingIds|blockedByTaskIds)\b/u,
  ];
  for (const path of sourceFiles) {
    const source = readFileSync(path, "utf8");
    for (const pattern of forbiddenSourcePatterns) {
      assert.doesNotMatch(source, pattern, `${path} contains retired chain contract ${pattern}`);
    }
  }

  for (const path of reviewSources) {
    const source = readFileSync(path, "utf8");
    if (!/(?:review|adjudicat)/iu.test(basename(path))) continue;
    assert.doesNotMatch(source, /codex\s+exec/iu, `${path} contains a nested review subprocess`);
    assert.doesNotMatch(source, /code-review-and-adjudication/u, `${path} contains the retired combined review source identity`);
  }
  assert.equal(
    reviewSources.some((path) => basename(path).includes("code-review-and-adjudication")),
    false,
    "the retired combined review source must not be present",
  );
});
