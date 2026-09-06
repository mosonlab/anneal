import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Keep this list explicit: adding a source-backed export is a contract change
// that needs both a development target and a resolution proof.
const mappings = [
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: ".", source: "./src/index.ts", dist: "./dist/index.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./merge-integrator", source: "./src/merge-integrator.ts", dist: "./dist/merge-integrator.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./model-routing", source: "./src/model-routing.ts", dist: "./dist/model-routing.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./agent-message", source: "./src/agent-message.ts", dist: "./dist/agent-message.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./board-contract", source: "./src/board-contract.ts", dist: "./dist/board-contract.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./console-contract", source: "./src/console-contract.ts", dist: "./dist/console-contract.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./session-filter-contract", source: "./src/session-filter-contract.ts", dist: "./dist/session-filter-contract.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./chain-order", source: "./src/chain-order.ts", dist: "./dist/chain-order.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./chain-hold", source: "./src/chain-hold.ts", dist: "./dist/chain-hold.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./gate-toggle", source: "./src/gate-toggle.ts", dist: "./dist/gate-toggle.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./wire-contract", source: "./src/wire-contract.ts", dist: "./dist/wire-contract.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./wire-serialization", source: "./src/wire-serialization.ts", dist: "./dist/wire-serialization.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./claim-contract", source: "./src/claim-contract.ts", dist: "./dist/claim-contract.js" },
  { packageName: "@anneal/db", packageDirectory: "packages/db", subpath: "./service-lock", source: "./src/service-maintenance-lock.ts", dist: "./dist/service-maintenance-lock.js" },
  { packageName: "@anneal/runner", packageDirectory: "packages/runner", subpath: "./adapters", source: "./src/adapters.ts", dist: "./dist/adapters.js" },
  { packageName: "@anneal/runner", packageDirectory: "packages/runner", subpath: "./api", source: "./src/api.ts", dist: "./dist/api.js" },
  { packageName: "@anneal/runner", packageDirectory: "packages/runner", subpath: "./reclaim", source: "./src/reclaim.ts", dist: "./dist/reclaim.js" },
  { packageName: "@anneal/runner", packageDirectory: "packages/runner", subpath: "./config", source: "./src/config.ts", dist: "./dist/config.js" },
  { packageName: "@anneal/github-client", packageDirectory: "packages/github-client", subpath: ".", source: "./src/index.ts", dist: "./dist/index.js" },
];

assert.equal(mappings.length, 19);

const packageSpecifier = ({ packageName, subpath }) =>
  subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`;

const readManifest = (packageDirectory) =>
  JSON.parse(readFileSync(join(repositoryRoot, packageDirectory, "package.json"), "utf8"));

const packageRootCandidates = (mapping) => [
  join(repositoryRoot, mapping.packageDirectory),
  join(repositoryRoot, "node_modules", ...mapping.packageName.split("/")),
];

const assertResolvesTo = (resolvedUrl, mapping, target) => {
  const resolvedPath = fileURLToPath(resolvedUrl);
  const expectedPath = join(repositoryRoot, mapping.packageDirectory, target);
  if (existsSync(resolvedPath) && existsSync(expectedPath)) {
    assert.equal(realpathSync(resolvedPath), realpathSync(expectedPath));
    return;
  }

  // `import.meta.resolve` intentionally returns a URL even when a target is
  // absent. This branch keeps the ordinary-resolution proof valid in a fresh
  // checkout where every dist/ directory has been removed, while still
  // requiring the exact package-relative target.
  assert.ok(
    packageRootCandidates(mapping)
      .map((packageRoot) => resolve(packageRoot, target))
      .includes(resolve(resolvedPath)),
    `${packageSpecifier(mapping)} resolved to ${resolvedPath}, expected ${expectedPath}`,
  );
};

const resolveInChild = (conditions) => {
  const specifiers = mappings.map(packageSpecifier);
  const source = `
    const specifiers = ${JSON.stringify(specifiers)};
    const resolved = Object.fromEntries(specifiers.map((specifier) => [specifier, import.meta.resolve(specifier)]));
    process.stdout.write(JSON.stringify(resolved));
  `;
  const args = [
    ...conditions.map((condition) => `--conditions=${condition}`),
    "--input-type=module",
    "-e",
    source,
  ];
  return JSON.parse(execFileSync(process.execPath, args, { cwd: repositoryRoot, encoding: "utf8" }));
};

test("all nineteen source-backed exports have ordered development targets", () => {
  const entriesByPackage = new Map();
  for (const mapping of mappings) {
    const manifest = readManifest(mapping.packageDirectory);
    const entries = entriesByPackage.get(mapping.packageDirectory) ?? [];
    entries.push(mapping.subpath);
    entriesByPackage.set(mapping.packageDirectory, entries);

    const target = manifest.exports?.[mapping.subpath];
    assert.ok(target, `${mapping.packageName} ${mapping.subpath} is missing from exports`);
    assert.deepEqual(Object.keys(target), ["types", "development", "import"]);
    assert.equal(target.types, mapping.source);
    assert.equal(target.development, mapping.source);
    assert.equal(target.import, mapping.dist);
    assert.match(target.development, /^\.\/src\/[^/]+\.ts$/u);
    assert.doesNotMatch(target.development, /dist/u);
    assert.ok(existsSync(join(repositoryRoot, mapping.packageDirectory, target.development)));
  }

  for (const [packageDirectory, subpaths] of entriesByPackage) {
    assert.deepEqual(Object.keys(readManifest(packageDirectory).exports), subpaths);
  }
});

test("development resolution selects each source target and ordinary resolution selects dist", () => {
  const development = resolveInChild(["development"]);
  const ordinary = resolveInChild([]);
  for (const mapping of mappings) {
    const specifier = packageSpecifier(mapping);
    assertResolvesTo(development[specifier], mapping, mapping.source);
    assertResolvesTo(ordinary[specifier], mapping, mapping.dist);
  }
});
