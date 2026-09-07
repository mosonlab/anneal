// Fixtures for gate-env.mjs, the fixture environment gate-worker.test.mjs and
// gate-dispatch.test.mjs both build from.
//
// The guard below used to be stated once in each of those files, because each
// built its own environment. The coverage test after it is the one that could
// not be stated in either: it asks whether the list is still the whole list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";
import {
  GATE_ENV_INHERITED,
  GATE_ENV_NAMES,
  GATE_ENV_PREFIXES,
  fixtureEnv,
  hostNeutralEnv,
  isHostGateConfig,
} from "./gate-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeGateWorker = join(here, "..", "..", "packages", "runner", "runtime-tools", "gate-worker");

const test = (name, body) => nodeTest(name, { concurrency: true }, body);

test("the fixture environment carries no host gate configuration", () => {
  // The guard for the leak itself: a host configured to reach a real gate
  // worker must not be able to rewrite what the cases run against. Nothing in
  // either fixture file states which servers exist or how long to wait unless
  // it says so, and a host that could silently rewrite the topology is how one
  // of those suites once blocked for the dispatcher's full hour instead of
  // failing.
  const leaked = Object.keys(fixtureEnv("gate-env-fixture")).filter(isHostGateConfig);
  assert.deepEqual(leaked, [], `host gate configuration reached the fixtures: ${leaked.join(", ")}`);
});

test("the fixture environment pins the Git identity it was asked for", () => {
  const env = fixtureEnv("some-fixture");
  assert.equal(env.GIT_AUTHOR_NAME, "some-fixture");
  assert.equal(env.GIT_COMMITTER_EMAIL, "some-fixture");
  // The host's own Git configuration is the other thing a fixture must not read.
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
});

test("hostNeutralEnv strips the gate's configuration and keeps the rest", () => {
  const neutral = hostNeutralEnv();
  assert.deepEqual(Object.keys(neutral).filter(isHostGateConfig), []);
  // Reading process.env is the point of the function; a fixture still needs a
  // PATH to spawn anything with.
  assert.equal(neutral.PATH, process.env.PATH);
});

// --- the list is still the whole list ----------------------------------------

// The gate scripts a fixture spawns. provision.sh is deliberately outside it:
// no fixture runs it, so what it reads out of an operator's environment is not
// a question about this environment.
const GATE_SCRIPTS = [
  join(here, "..", "merge-gate.sh"),
  join(runtimeGateWorker, "lib.sh"),
  ...["host-sizing.sh", "step-engine.sh", "verdict.sh"].map((name) => join(here, name)),
  ...["gate-dispatch.sh", "mirror-push.sh", "remote-gate.sh", "run-gate.sh"].map((name) => join(runtimeGateWorker, name)),
];

// A shell script reads an environment variable by defaulting it —
// `NAME="${NAME:-...}"`, `${NAME:+...}` — or by using a name it never assigns.
// A name whose first plain assignment in some script gives it a value of that
// script's own is that script's variable, not the environment's.
const gateEnvNamesRead = () => {
  const used = new Set();
  const ownedBySomeScript = new Set();
  for (const path of GATE_SCRIPTS) {
    const source = readFileSync(path, "utf8");
    for (const [, name] of source.matchAll(/\$\{([A-Z][A-Z0-9_]*)[-+:=}]/g)) used.add(name);
    const firstAssignment = new Map();
    for (const [, name, value] of source.matchAll(/^[ \t]*([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
      // `NAME=literal cmd ...` sets a variable for one command rather than for
      // the script, so it says nothing about whose variable the name is.
      if (/^(?:''|""|[A-Za-z0-9_.:@\/-]*)\s+\S/.test(value)) continue;
      if (!firstAssignment.has(name)) firstAssignment.set(name, value.trim());
    }
    for (const [name, value] of firstAssignment) {
      if (!new RegExp(`^"?\\$\\{${name}[-:+]`).test(value)) ownedBySomeScript.add(name);
    }
  }
  return [...used].filter((name) => !ownedBySomeScript.has(name)).sort();
};

test("every environment variable the gate reads is either stripped or has a stated reason to stay", () => {
  // The test the two fixture files could not hold between them. `4087264` added
  // a guard to one of them by hand and missed the other; a list that has to be
  // remembered is a list that gets edited once. This fails the moment the gate
  // starts reading a variable nobody stripped and nobody gave a reason for.
  const unclassified = gateEnvNamesRead().filter(
    (name) => !isHostGateConfig(name) && !Object.hasOwn(GATE_ENV_INHERITED, name),
  );
  assert.deepEqual(
    unclassified,
    [],
    `the gate reads these and gate-env.mjs neither strips them nor says why they stay: ${unclassified.join(", ")}`,
  );
});

test("the scan finds the variables it was built for", () => {
  // A scan that matched nothing would pass the test above in silence. These are
  // the four the two fixture files named, one from each shape the scan has to
  // recognise.
  const read = gateEnvNamesRead();
  for (const name of ["AGENTOS_GATE_SERVER", "GATE_DISPATCH_POLL_SECONDS", ...GATE_ENV_NAMES, "XDG_CACHE_HOME"]) {
    assert.ok(read.includes(name), `the scan no longer finds ${name}, which the gate reads`);
  }
});

test("nothing is stripped and inherited at once, and every reason is a reason", () => {
  for (const [name, reason] of Object.entries(GATE_ENV_INHERITED)) {
    assert.equal(isHostGateConfig(name), false, `${name} is both stripped and inherited`);
    assert.ok(reason.length > 20, `${name} is inherited without a stated reason`);
  }
  assert.ok(GATE_ENV_PREFIXES.every((prefix) => prefix.endsWith("_")), "a prefix that is not a namespace matches names nobody meant");
});
