import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  generateServiceInventory as generateDeployServiceInventory,
  resolveRunnerCount as resolveDeployRunnerCount,
  resolveServiceInventory,
  serviceWrapperPath,
} from "./service-inventory.mjs";
import { resolveServicePlatform } from "./service-platform.mjs";
import {
  generateServiceInventory,
  parseSharedEnvironment,
  resolveRunnerIdPrefix,
  resolveRunnerCount,
  runnerIdForLabel,
  SERVICE_LABELS,
  SERVICE_INVENTORY_ENTRIES,
  SERVICE_INVENTORY,
  resolveServiceInvocation,
  verifyServiceInventory,
} from "./launchd-service-wrapper.mjs";
import {
  bootstrapCurrentRelease,
  installLaunchdServices,
  renderServicePlists,
} from "./install-launchd.mjs";
import { runServiceInstaller } from "./install-launchd-services.mjs";

/** The standalone wrapper carries label, runner id and unit name; the resolved
 * inventory carries those plus the runner index and plist name. Compare the
 * wrapper against that projection: the lockstep the fixture proves is over the
 * facts the wrapper itself generates. */
const DEFAULT_INVENTORY = resolveServiceInventory();
const wrapperFacts = (entries) => entries.map(({ label, runnerId, unitName }) => ({ label, runnerId, unitName }));
const deployWrapperFacts = (runnerCount, runnerIdPrefix = "", deployRole = "control-plane") =>
  wrapperFacts(generateDeployServiceInventory({ runnerCount, runnerIdPrefix, deployRole }).entries);

// This suite is the frozen launchd compatibility fixture. Keep exercising
// that path when the merge-gate host itself is Linux; systemd behavior lives
// in the dedicated installer suite.
process.env.AGENTOS_SERVICE_PLATFORM = "darwin";
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const makeWritable = (path) => {
  if (!existsSync(path)) return;
  const status = lstatSync(path);
  if (status.isSymbolicLink()) return;
  chmodSync(path, status.isDirectory() ? 0o700 : 0o600);
  if (status.isDirectory()) for (const entry of readdirSync(path)) makeWritable(join(path, entry));
};

const makeReadOnly = (path) => {
  const status = lstatSync(path);
  if (status.isSymbolicLink()) return;
  if (status.isDirectory()) for (const entry of readdirSync(path)) makeReadOnly(join(path, entry));
  chmodSync(path, status.isDirectory() ? 0o555 : status.mode & 0o555);
};

const treeEntries = (root) => {
  const entries = [];
  const visit = (path, prefix = "") => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const status = lstatSync(child);
      entries.push([relativePath, status.isSymbolicLink() ? "link" : status.isDirectory() ? "directory" : `file:${status.size}`]);
      if (status.isDirectory()) visit(child, relativePath);
    }
  };
  visit(root);
  return entries;
};

const availablePort = async () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
});

const releaseFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-launchd-wrapper-"));
  const releaseId = `${"a".repeat(40)}-${"b".repeat(64)}`;
  const release = join(root, "releases", releaseId);
  mkdirSync(join(release, "packages/api/dist"), { recursive: true });
  mkdirSync(join(release, "packages/inbox/dist"), { recursive: true });
  mkdirSync(join(release, "packages/runner/dist"), { recursive: true });
  mkdirSync(join(release, "apps/web/dist"), { recursive: true });
  mkdirSync(join(release, "node_modules/vite/bin"), { recursive: true });
  for (const path of [
    "packages/api/dist/index.js",
    "packages/inbox/dist/index.js",
    "packages/runner/dist/index.js",
    "node_modules/vite/bin/vite.js",
  ]) writeFileSync(join(release, path), "// fixture entrypoint\n");
  writeFileSync(join(release, "packages/api/dist/build-info.json"), JSON.stringify({
    packageName: "@anneal/api",
    commit: "a".repeat(40),
    dirty: false,
  }));
  mkdirSync(join(root, "shared"), { recursive: true });
  writeFileSync(join(root, "shared/.env"), "DATABASE_URL=postgresql://fixture\nFEISHU_APP_ID=shared-app\n");
  symlinkSync(join("releases", releaseId), join(root, "current"));
  return { root, release, releaseId };
};

const legacyServiceDefinitions = ({ fixture, home }) => {
  const rendered = renderServicePlists({
    inventory: DEFAULT_INVENTORY,
    nodeBinary: "/usr/bin/node",
    repositoryRoot: fixture.root,
    sharedRoot: join(fixture.root, "shared"),
    stdoutPath: join(home, "legacy-stdout.log"),
    stderrPath: join(home, "legacy-stderr.log"),
    path: "/legacy/bin:/usr/bin:/bin",
  });
  return Object.fromEntries(SERVICE_LABELS.map((label, index) => {
    const isolation = label.startsWith("com.agentos.runner")
      ? [
          ["RUNNER_RUN_AS_PREFIX", `sudo -u _agentos_runner_${index + 1} -E --`],
          ["RUNNER_HOME", `/var/lib/agentos/runner-${index + 1}`],
          ["RUNNER_MCP_SERVER_PATH", "/usr/local/lib/agentos/mcp-server.js"],
          ["RUNNER_PI_EXTENSION_PATH", "/usr/local/lib/agentos/pi-agentos-extension.ts"],
          ["RUNNER_CLAUDE_SETTINGS_PATH", "/usr/local/lib/agentos/claude-platform-settings.json"],
          ["RUNNER_SESSION_CONFIG_BASELINE_ROOT", "/usr/local/lib/agentos/session-config-baseline"],
        ]
      : label === "com.agentos.api"
        ? [
            ["RUNNER_RUN_AS_PREFIX", "sudo -u _agentos_runner_1 -E --"],
            ["RUNNER_HOME", "/var/lib/agentos/runner-1"],
            ["RUNNER_REPO_MIRROR_ROOT", "/var/lib/agentos/runner-1/.agentos/repo-mirrors"],
          ]
        : [];
    const environmentXml = isolation
      .map(([key, value]) => `    <key>${key}</key>\n    <string>${value}</string>`)
      .join("\n");
    const definition = rendered[label]
      .replace("  </dict>\n  <key>RunAtLoad</key>", `${environmentXml ? `${environmentXml}\n` : ""}  </dict>\n  <key>RunAtLoad</key>`)
      .replace("  <key>RunAtLoad</key>", `  <key>ThrottleInterval</key>\n  <integer>${index + 10}</integer>\n  <key>RunAtLoad</key>`);
    return [label, definition];
  }));
};

test("the wrapper inventory is exactly the loaded production service inventory", () => {
  assert.deepEqual(SERVICE_LABELS, resolveServiceInventory().labels);
  assert.deepEqual(wrapperFacts(generateServiceInventory(16)), deployWrapperFacts(16));
  assert.deepEqual(Object.keys(SERVICE_INVENTORY), [...SERVICE_LABELS]);
});

test("service platform resolution accepts only darwin and linux", () => {
  assert.equal(resolveServicePlatform({ platform: "darwin", environment: {} }), "darwin");
  assert.equal(resolveServicePlatform({ platform: "darwin", environment: { AGENTOS_SERVICE_PLATFORM: "linux" } }), "linux");
  assert.equal(resolveServicePlatform({ platform: "linux", environment: { AGENTOS_SERVICE_PLATFORM: "darwin" } }), "darwin");
  for (const value of ["", "freebsd", "LINUX"]) {
    assert.throws(
      () => resolveServicePlatform({ platform: "darwin", environment: { AGENTOS_SERVICE_PLATFORM: value } }),
      new RegExp(`service-platform-unsupported:${value}$`, "u"),
    );
  }
  assert.throws(
    () => resolveServicePlatform({ platform: "freebsd", environment: {} }),
    /service-platform-unsupported:freebsd/u,
  );
});

test("runner inventory is generated in order with ids and systemd names", () => {
  const expectedLabels = [
    "com.agentos.api",
    "com.agentos.inbox",
    "com.agentos.runner",
    ...Array.from({ length: 15 }, (_unused, offset) => `com.agentos.runner-${offset + 2}`),
    "com.agentos.web",
  ];
  const generated = generateServiceInventory(16);
  assert.deepEqual(generated.map(({ label }) => label), expectedLabels);
  assert.deepEqual(generated.filter(({ runnerId }) => runnerId).map(({ runnerId }) => runnerId), [
    ...Array.from({ length: 16 }, (_unused, offset) => `runner-${offset + 1}`),
  ]);
  assert.deepEqual(generated.map(({ label, unitName }) => unitName), expectedLabels.map((label) => `${label}.service`));
  assert.deepEqual(resolveRunnerCount({ AGENTOS_RUNNER_COUNT: "16" }), 16);
  assert.deepEqual(resolveDeployRunnerCount({ AGENTOS_RUNNER_COUNT: "16" }), 16);
  assert.deepEqual(generateServiceInventory(), SERVICE_INVENTORY_ENTRIES);
});

test("runner deploy role inventory contains only the configured local runners", () => {
  const expected = [
    "com.agentos.runner",
    "com.agentos.runner-2",
    "com.agentos.runner-3",
  ];
  const generated = generateServiceInventory(3, "mac-", "runner");
  assert.deepEqual(generated.map(({ label }) => label), expected);
  assert.deepEqual(generated.map(({ runnerId }) => runnerId), ["mac-runner-1", "mac-runner-2", "mac-runner-3"]);
  assert.deepEqual(deployWrapperFacts(3, "mac-", "runner"), wrapperFacts(generated));
  assert.equal(generated.some(({ label }) => ["com.agentos.api", "com.agentos.inbox", "com.agentos.web"].includes(label)), false);
});

test("a configured count drives both runtime inventory modules", () => {
  const source = [
    'import { SERVICE_INVENTORY, SERVICE_LABELS as wrapperLabels } from "./scripts/deploy/launchd-service-wrapper.mjs";',
    'import { resolveServiceInventory } from "./scripts/deploy/service-inventory.mjs";',
    "const deployLabels = [...resolveServiceInventory().labels];",
    "console.log(JSON.stringify({ wrapperLabels, deployLabels, services: Object.values(SERVICE_INVENTORY).map(({ label, runnerId, unitName }) => ({ label, runnerId, unitName })) }));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, AGENTOS_RUNNER_COUNT: "16" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  const expectedLabels = [
    "com.agentos.api",
    "com.agentos.inbox",
    "com.agentos.runner",
    ...Array.from({ length: 15 }, (_unused, offset) => `com.agentos.runner-${offset + 2}`),
    "com.agentos.web",
  ];
  assert.deepEqual(observed.wrapperLabels, expectedLabels);
  assert.deepEqual(observed.deployLabels, expectedLabels);
  assert.equal(observed.services.length, 19);
  assert.deepEqual(
    observed.services.filter(({ runnerId }) => runnerId).map(({ runnerId }) => runnerId),
    Array.from({ length: 16 }, (_unused, offset) => `runner-${offset + 1}`),
  );
  assert.deepEqual(
    observed.services.map(({ label, unitName }) => unitName),
    expectedLabels.map((label) => `${label}.service`),
  );
});

test("runner count keeps ten as the default and rejects invalid values", () => {
  const defaultLabels = [
    "com.agentos.api",
    "com.agentos.inbox",
    "com.agentos.runner",
    "com.agentos.runner-2",
    "com.agentos.runner-3",
    "com.agentos.runner-4",
    "com.agentos.runner-5",
    "com.agentos.runner-6",
    "com.agentos.runner-7",
    "com.agentos.runner-8",
    "com.agentos.runner-9",
    "com.agentos.runner-10",
    "com.agentos.web",
  ];
  assert.deepEqual(SERVICE_LABELS, defaultLabels);
  for (const value of ["0", "65", "", "3.5", "abc"]) {
    assert.throws(
      () => resolveRunnerCount({ AGENTOS_RUNNER_COUNT: value }),
      new RegExp(`runner-count-invalid:${value}$`, "u"),
    );
    assert.throws(
      () => resolveDeployRunnerCount({ AGENTOS_RUNNER_COUNT: value }),
      new RegExp(`runner-count-invalid:${value}$`, "u"),
    );
  }
});

test("runner identity prefixes stay in lockstep across inventory and invocation", () => {
  const prefix = "vm-";
  assert.equal(resolveRunnerIdPrefix({ AGENTOS_RUNNER_ID_PREFIX: prefix }), prefix);
  assert.equal(runnerIdForLabel("com.agentos.runner-4", prefix), "vm-runner-4");
  assert.deepEqual(wrapperFacts(generateServiceInventory(4, prefix)), deployWrapperFacts(4, prefix));
  assert.throws(
    () => resolveRunnerIdPrefix({ AGENTOS_RUNNER_ID_PREFIX: "bad/prefix" }),
    /runner-id-prefix-invalid:bad\/prefix/u,
  );
});

test("empty-prefix Darwin rendering preserves runner labels and ids", () => {
  const fixture = releaseFixture();
  const home = join(fixture.root, "operator-home");
  const environment = {
    AGENTOS_SERVICE_PLATFORM: "darwin",
    AGENTOS_RUNNER_ID_PREFIX: "",
  };
  const inventory = resolveServiceInventory(environment);
  const expectedRunners = Array.from({ length: 10 }, (_unused, offset) => ({
    label: offset === 0 ? "com.agentos.runner" : `com.agentos.runner-${offset + 1}`,
    runnerId: `runner-${offset + 1}`,
  }));
  try {
    assert.deepEqual(
      inventory.entries.filter(({ runnerId }) => runnerId).map(({ label, runnerId }) => ({ label, runnerId })),
      expectedRunners,
    );
    const rendered = renderServicePlists({
      inventory,
      nodeBinary: "/usr/bin/node",
      repositoryRoot: fixture.root,
      sharedRoot: join(fixture.root, "shared"),
      stdoutPath: join(home, "stdout.log"),
      stderrPath: join(home, "stderr.log"),
      path: "/usr/bin:/bin",
    });
    for (const { label, runnerId } of expectedRunners) {
      assert.match(rendered[label], new RegExp(`<key>RUNNER_ID</key>\\s*<string>${runnerId}</string>`, "u"));
    }

    installLaunchdServices({
      repositoryRoot: fixture.root,
      userHome: home,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      environment,
      apply: true,
    });
    assert.equal(
      readFileSync(serviceWrapperPath(fixture.root), "utf8"),
      readFileSync(join(REPOSITORY_ROOT, "scripts/deploy/launchd-service-wrapper.mjs"), "utf8"),
    );
    for (const { label, runnerId } of expectedRunners) {
      const plist = readFileSync(join(home, "Library/LaunchAgents", `${label}.plist`), "utf8");
      assert.match(plist, new RegExp(`<key>RUNNER_ID</key>\\s*<string>${runnerId}</string>`, "u"));
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("service invocation resolves the configured prefix without overriding an explicit runner id", () => {
  const fixture = releaseFixture();
  try {
    const configured = resolveServiceInvocation({
      repositoryRoot: fixture.root,
      label: "com.agentos.runner-16",
      environment: { AGENTOS_RUNNER_ID_PREFIX: "vm-" },
    });
    assert.equal(configured.env.RUNNER_ID, "vm-runner-16");
    const explicit = resolveServiceInvocation({
      repositoryRoot: fixture.root,
      label: "com.agentos.runner-2",
      environment: { AGENTOS_RUNNER_ID_PREFIX: "vm-", RUNNER_ID: "operator-runner" },
    });
    assert.equal(explicit.env.RUNNER_ID, "operator-runner");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the wrapper entrypoint accepts a runner above the default inventory without runner-count environment", () => {
  const fixture = releaseFixture();
  try {
    const environment = {
      ...process.env,
      AGENTOS_REPOSITORY_ROOT: fixture.root,
      AGENTOS_RUNNER_ID_PREFIX: "vm-",
    };
    for (const key of [
      "FILES_ROOT",
      "RUNNER_WORKSPACE_ROOT",
      "RUNNER_DEPENDENCY_CACHE_ROOT",
      "RUNNER_REPO_MIRROR_ROOT",
      "CONTROL_PLANE_STATE_DIR",
    ]) delete environment[key];
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./launchd-service-wrapper.mjs", import.meta.url)),
      "com.agentos.runner-16",
    ], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SERVICE-WRAPPER service=com\.agentos\.runner-16/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("every service starts from current and receives shared config and release identity", async () => {
  const fixture = releaseFixture();
  try {
    const starts = [];
    const ready = [];
    const result = await verifyServiceInventory({
      repositoryRoot: fixture.root,
      environment: {},
      start: async (invocation) => {
        starts.push(invocation);
        return { targetReleaseId: invocation.releaseIdentity };
      },
      readiness: async ({ invocation, started }) => {
        ready.push({ invocation, started });
        return {
          ok: started.targetReleaseId === fixture.releaseId
            && invocation.env.AGENTOS_RELEASE_ID === fixture.releaseId,
          releaseIdentity: fixture.releaseId,
        };
      },
    });
    assert.deepEqual(result.map((entry) => entry.label), SERVICE_LABELS);
    assert.equal(starts.length, SERVICE_LABELS.length);
    assert.equal(ready.length, SERVICE_LABELS.length);
    for (const invocation of starts) {
      assert.equal(invocation.releaseIdentity, fixture.releaseId);
      assert.match(invocation.args[0], /\/current\//u);
      assert.equal(invocation.env.AGENTOS_RELEASE_ID, fixture.releaseId);
      assert.equal(invocation.env.DEPLOY_RELEASE_ID, fixture.releaseId);
      assert.equal(invocation.env.AGENTOS_SHARED_ROOT, join(fixture.root, "shared"));
      assert.equal(invocation.env.DOTENV_CONFIG_PATH, undefined);
      assert.equal(invocation.env.DATABASE_URL, "postgresql://fixture");
      assert.match(invocation.env.FILES_ROOT, /\/shared\/files$/u);
      assert.match(invocation.env.RUNNER_WORKSPACE_ROOT, /\/shared\/runs$/u);
    }
    assert.equal(existsSync(join(fixture.release, ".env")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a release-local env file is refused even when current points at the release", () => {
  const fixture = releaseFixture();
  try {
    writeFileSync(join(fixture.release, ".env"), "DATABASE_URL=must-not-be-here\n");
    assert.throws(
      () => resolveServiceInvocation({ repositoryRoot: fixture.root, label: SERVICE_LABELS[0] }),
      /release-contains-shared-config/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the wrapper fixture can launch an entrypoint and propagate the target identity", async () => {
  const fixture = releaseFixture();
  try {
    const entrypoint = join(fixture.release, "packages/api/dist/index.js");
    writeFileSync(entrypoint, "process.stdout.write(`${process.env.AGENTOS_SERVICE_LABEL}:${process.env.AGENTOS_RELEASE_ID}:${process.env.DOTENV_CONFIG_PATH}`);\n");
    chmodSync(entrypoint, 0o555);
    const invocation = resolveServiceInvocation({ repositoryRoot: fixture.root, label: "com.agentos.api", environment: {} });
    const observed = {
      label: invocation.env.AGENTOS_SERVICE_LABEL,
      release: invocation.env.AGENTOS_RELEASE_ID,
      shared: invocation.env.AGENTOS_SHARED_ENV_FILE,
    };
    assert.deepEqual(observed, {
      label: "com.agentos.api",
      release: fixture.releaseId,
      shared: join(fixture.root, "shared/.env"),
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("shared environment parsing preserves multiline quoted values and rejects malformed input", () => {
  assert.deepEqual(parseSharedEnvironment('A=1\nKEY="line1\nline2"\nB=2\n'), {
    A: "1",
    KEY: "line1\nline2",
    B: "2",
  });
  assert.throws(() => parseSharedEnvironment("A=1\nnot-an-assignment\n"), /shared-environment-unparseable-line-2/u);
  assert.throws(() => parseSharedEnvironment('KEY="unterminated\n'), /shared-environment-unbalanced-quote-line-1/u);
});

test("the real web invocation starts from a read-only release without writing into it", async (t) => {
  const fixture = releaseFixture();
  let child = null;
  t.after(() => {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    makeWritable(fixture.root);
    rmSync(fixture.root, { recursive: true, force: true });
  });
  rmSync(join(fixture.release, "node_modules/vite"), { recursive: true, force: true });
  symlinkSync(realpathSync(new URL("../../node_modules/vite", import.meta.url)), join(fixture.release, "node_modules/vite"), "dir");
  writeFileSync(join(fixture.release, "apps/web/dist/index.html"), `<html>${fixture.releaseId}</html>\n`);
  writeFileSync(join(fixture.release, "apps/web/vite.config.ts"), [
    'import { defineConfig } from "vite";',
    "export default defineConfig({ preview: { host: '127.0.0.1', strictPort: true } });",
    "",
  ].join("\n"));
  const before = treeEntries(fixture.release);
  makeReadOnly(fixture.release);
  const port = await availablePort();
  const invocation = resolveServiceInvocation({
    repositoryRoot: fixture.root,
    label: "com.agentos.web",
    environment: {},
  });
  let output = "";
  child = spawn(invocation.program, [...invocation.args, "--port", String(port)], {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  let response = null;
  // A real `vite preview` child: it has to install-check, boot and serve. The
  // loop already breaks the moment it answers or the child exits, so the deadline
  // only bounds a child that never comes up — sized for the loaded gate worker, not for an idle host (CONTRIBUTING.md, "Test timing on the gate worker").
  const readinessDeadline = Date.now() + 120_000;
  while (Date.now() < readinessDeadline) {
    if (child.exitCode !== null) break;
    try {
      response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(250) });
      if (response.ok) break;
    } catch { /* wait for Vite readiness */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(response?.ok, true, output);
  assert.match(await response.text(), new RegExp(fixture.releaseId, "u"));
  assert.equal(invocation.env.AGENTOS_RELEASE_ID, fixture.releaseId);
  assert.deepEqual(treeEntries(fixture.release), before);
  child.kill("SIGTERM");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
});

const captureStdout = (work) => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { work(); } finally { process.stdout.write = original; }
  return chunks.join("");
};

test("the service CLI prints the launchd outcome for every phase", () => {
  const fixture = releaseFixture();
  const home = join(fixture.root, "operator-home");
  const context = {
    repositoryRoot: fixture.root,
    userHome: home,
    nodeBinary: process.execPath,
    gitBinary: process.execPath,
  };
  const wrapper = serviceWrapperPath(realpathSync(fixture.root));
  const definitions = SERVICE_LABELS.length + 1;
  try {
    assert.equal(
      captureStdout(() => assert.equal(runServiceInstaller([], context), 0)),
      `PLAN service-wrapper=${wrapper}\nPLAN service-definitions=${definitions}\nPLAN no files or launchd state changed\n`,
    );
    assert.equal(
      captureStdout(() => assert.equal(runServiceInstaller(["--apply"], context), 0)),
      `APPLY service-wrapper=${wrapper}\nAPPLY service-definitions=${definitions}\n`
        + "NEXT reload each service plist with launchctl, then run the wrapper inventory readiness check\n",
    );
    assert.equal(
      captureStdout(() => assert.equal(runServiceInstaller(["--revert"], context), 0)),
      `REVERT service-wrapper=${wrapper}\nREVERT service-definitions=${definitions}\nPLAN no files or launchd state changed\n`,
    );
    assert.equal(
      captureStdout(() => assert.equal(runServiceInstaller(["--revert", "--apply"], context), 0)),
      `REVERT service-wrapper=${wrapper}\nREVERT service-definitions=${definitions}\n`,
    );
    assert.equal(existsSync(wrapper), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("service plist rendering and installation cover every label before activation", () => {
  const fixture = releaseFixture();
  const home = join(fixture.root, "operator-home");
  try {
    const rendered = renderServicePlists({
      inventory: DEFAULT_INVENTORY,
      nodeBinary: "/usr/bin/node",
      repositoryRoot: fixture.root,
      sharedRoot: join(fixture.root, "shared"),
      stdoutPath: join(home, "stdout.log"),
      stderrPath: join(home, "stderr.log"),
      path: "/usr/bin:/bin",
    });
    for (const label of SERVICE_LABELS) {
      assert.match(rendered[label], new RegExp(`<string>${label}</string>`, "u"));
      assert.match(rendered[label], /agentos-service-wrapper\.mjs/u);
      assert.match(rendered[label], /AGENTOS_SHARED_ROOT/u);
      assert.match(rendered[label], /AGENTOS_CURRENT_POINTER/u);
      assert.doesNotMatch(rendered[label], /__[A-Z_]+__/u);
      assert.doesNotMatch(rendered[label], /<string><\/string>/u);
    }
    for (const label of ["com.agentos.api", "com.agentos.inbox", "com.agentos.web"]) {
      assert.doesNotMatch(rendered[label], /<key>RUNNER_(?:ID|PATH)<\/key>/u);
    }
    assert.deepEqual(SERVICE_INVENTORY["com.agentos.web"].args.slice(-2), ["--configLoader", "runner"]);

    const installed = installLaunchdServices({
      repositoryRoot: fixture.root,
      userHome: home,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      apply: true,
    });
    assert.equal(installed.entries.length, SERVICE_LABELS.length + 1);
    assert.equal(existsSync(serviceWrapperPath(fixture.root)), true);
    for (const label of SERVICE_LABELS) {
      const path = join(home, "Library/LaunchAgents", `${label}.plist`);
      assert.equal(existsSync(path), true);
      assert.match(readFileSync(path, "utf8"), /current/u);
    }

    const plannedRevert = installLaunchdServices({ repositoryRoot: fixture.root, userHome: home, revert: true });
    assert.deepEqual([plannedRevert.phase, plannedRevert.applied], ["REVERT", false]);
    const reverted = installLaunchdServices({ repositoryRoot: fixture.root, userHome: home, revert: true, apply: true });
    assert.deepEqual([reverted.phase, reverted.applied], ["REVERT", true]);
    assert.equal(existsSync(serviceWrapperPath(fixture.root)), false);
    for (const label of SERVICE_LABELS) assert.equal(existsSync(join(home, "Library/LaunchAgents", `${label}.plist`)), false);
    assert.equal(existsSync(join(fixture.root, "shared/.env")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("service installation refuses an operator plist it does not own", () => {
  const fixture = releaseFixture();
  const home = join(fixture.root, "operator-home");
  const destination = join(home, "Library/LaunchAgents/com.agentos.api.plist");
  try {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, "operator-owned-definition\n");
    assert.throws(
      () => installLaunchdServices({
        repositoryRoot: fixture.root,
        userHome: home,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        apply: true,
      }),
      /launchd-service-definition-conflict/u,
    );
    assert.equal(existsSync(serviceWrapperPath(fixture.root)), false);
    assert.equal(readFileSync(destination, "utf8"), "operator-owned-definition\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an explicit wrapper migration replaces existing service definitions and revert restores them", () => {
  const fixture = releaseFixture();
  const home = join(fixture.root, "operator-home");
  const launchAgents = join(home, "Library/LaunchAgents");
  try {
    mkdirSync(launchAgents, { recursive: true });
    const originals = legacyServiceDefinitions({ fixture, home });
    for (const label of SERVICE_LABELS) {
      writeFileSync(join(launchAgents, `${label}.plist`), originals[label]);
    }
    const installed = installLaunchdServices({
      repositoryRoot: fixture.root,
      userHome: home,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      replaceExisting: true,
      apply: true,
    });
    assert.deepEqual([installed.phase, installed.applied], ["APPLY", true]);
    for (const label of SERVICE_LABELS) {
      const installedDefinition = readFileSync(join(launchAgents, `${label}.plist`), "utf8");
      assert.match(installedDefinition, /agentos-service-wrapper\.mjs/u);
      assert.match(installedDefinition, new RegExp(`<integer>${SERVICE_LABELS.indexOf(label) + 10}</integer>`, "u"));
      if (label.startsWith("com.agentos.runner")) {
        assert.match(installedDefinition, /RUNNER_RUN_AS_PREFIX/u);
        assert.match(installedDefinition, /RUNNER_SESSION_CONFIG_BASELINE_ROOT/u);
        assert.match(installedDefinition, /\/legacy\/bin:\/usr\/bin:\/bin/u);
      }
      if (label === "com.agentos.api") assert.match(installedDefinition, /RUNNER_REPO_MIRROR_ROOT/u);
    }
    // A killed installer can leave any entry either original or installed.
    // The pre-written manifest must make both states mechanically revertible.
    writeFileSync(join(launchAgents, `${SERVICE_LABELS[0]}.plist`), originals[SERVICE_LABELS[0]]);
    const reverted = installLaunchdServices({
      repositoryRoot: fixture.root,
      userHome: home,
      revert: true,
      apply: true,
    });
    assert.deepEqual([reverted.phase, reverted.applied], ["REVERT", true]);
    for (const label of SERVICE_LABELS) {
      assert.equal(readFileSync(join(launchAgents, `${label}.plist`), "utf8"), originals[label]);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("wrapper migration reuses matching orphaned backups and names conflicting leftovers", () => {
  const fixture = releaseFixture();
  const home = join(fixture.root, "operator-home");
  const launchAgents = join(home, "Library/LaunchAgents");
  const backupRoot = join(fixture.root, ".agentos-deploy/launchd/backups");
  try {
    mkdirSync(launchAgents, { recursive: true });
    mkdirSync(backupRoot, { recursive: true });
    const originals = legacyServiceDefinitions({ fixture, home });
    for (const label of SERVICE_LABELS) writeFileSync(join(launchAgents, `${label}.plist`), originals[label]);
    const apiBackup = join(backupRoot, "com.agentos.api.plist");
    writeFileSync(apiBackup, originals["com.agentos.api"]);

    const installed = installLaunchdServices({
      repositoryRoot: fixture.root,
      userHome: home,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      replaceExisting: true,
      apply: true,
    });
    assert.deepEqual([installed.phase, installed.applied], ["APPLY", true]);
    installLaunchdServices({ repositoryRoot: fixture.root, userHome: home, revert: true, apply: true });

    writeFileSync(apiBackup, "unrelated-leftover\n");
    assert.throws(
      () => installLaunchdServices({
        repositoryRoot: fixture.root,
        userHome: home,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        replaceExisting: true,
        apply: true,
      }),
      (error) => error?.reason === "launchd-service-backup-conflict" && error.detail.includes(apiBackup),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("wrapper migration can bootstrap current from the still-serving checkout before replacing plists", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-launchd-bootstrap-"));
  try {
    mkdirSync(join(root, "packages/api/dist"), { recursive: true });
    writeFileSync(join(root, "packages/api/package.json"), JSON.stringify({ name: "@anneal/api" }));
    writeFileSync(join(root, "packages/api/dist/index.js"), "// old serving API\n");
    writeFileSync(join(root, "packages/api/dist/build-info.json"), JSON.stringify({
      packageName: "@anneal/api",
      commit: "c".repeat(40),
      dirty: false,
    }));
    mkdirSync(join(root, "shared"));
    writeFileSync(join(root, "shared/.env"), "DATABASE_URL=postgresql://fixture\n");

    const bootstrapped = bootstrapCurrentRelease({
      repositoryRoot: root,
      artifactPaths: ["packages/api/dist"],
    });

    assert.equal(bootstrapped.commit, "c".repeat(40));
    assert.equal(existsSync(join(root, "current/packages/api/dist/index.js")), true);
    assert.equal(existsSync(join(root, "current/.env")), false);
    assert.match(bootstrapped.releaseName, /^c{40}-[0-9a-f]{64}$/u);
  } finally {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/** The EnvironmentVariables dictionary a rendered LaunchAgent definition
 * carries. launchd hands exactly these to the wrapper process. */
const plistEnvironment = (definition) => {
  const dictionary = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)\n {2}<\/dict>/u.exec(definition);
  assert.notEqual(dictionary, null);
  return Object.fromEntries([...dictionary[1].matchAll(
    /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/gu,
  )].map(([, key, value]) => [key, value]));
};

/** A provider CLI in the shape a global npm install leaves on the Mac host:
 * `<bin>/<name>` is a symlink to a differently named file inside the package,
 * so only `<bin>` holds the command a runner spawns by name. */
const installProviderCliShim = (root, binDirectory, name) => {
  const target = join(root, "operator-lib", `${name}-code`, "bin");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `${name}.exe`), "#!/bin/sh\nexit 0\n");
  chmodSync(join(target, `${name}.exe`), 0o755);
  mkdirSync(join(root, binDirectory), { recursive: true });
  symlinkSync(join(target, `${name}.exe`), join(root, binDirectory, name));
};

const runnerRoleFixture = ({ sharedEnvironment, cliDirectory = null }) => {
  const fixture = releaseFixture();
  writeFileSync(join(fixture.root, "shared/.env"), sharedEnvironment);
  if (cliDirectory) installProviderCliShim(fixture.root, cliDirectory, "claude");
  return fixture;
};

const RUNNER_ROLE_ENVIRONMENT = Object.freeze({
  AGENTOS_SERVICE_PLATFORM: "darwin",
  AGENTOS_DEPLOY_ROLE: "runner",
  AGENTOS_RUNNER_COUNT: "2",
});

test("a runner-role definition leaves RUNNER_PATH to shared/.env when it defines one", () => {
  const fixture = runnerRoleFixture({
    sharedEnvironment: "DATABASE_URL=postgresql://fixture\nRUNNER_PATH=/operator/npm-global/bin:/usr/bin:/bin\n",
  });
  const home = join(fixture.root, "operator-home");
  try {
    const plan = installLaunchdServices({
      repositoryRoot: fixture.root,
      userHome: home,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      environment: RUNNER_ROLE_ENVIRONMENT,
      cliLookup: () => "",
    });
    assert.deepEqual(plan.report.filter(([key]) => key === "runner-path-source"), [
      ["runner-path-source", "com.agentos.runner=.env"],
      ["runner-path-source", "com.agentos.runner-2=.env"],
    ]);
    for (const label of ["com.agentos.runner", "com.agentos.runner-2"]) {
      const environment = plistEnvironment(plan.rendered[label]);
      assert.equal(environment.RUNNER_ID, `runner-${label.endsWith("-2") ? 2 : 1}`);
      assert.equal(Object.hasOwn(environment, "RUNNER_PATH"), false);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a runner-role definition renders a RUNNER_PATH reaching the resolved provider CLI", () => {
  const fixture = runnerRoleFixture({
    sharedEnvironment: "DATABASE_URL=postgresql://fixture\n",
    cliDirectory: "operator-bin",
  });
  const home = join(fixture.root, "operator-home");
  const claudeDirectory = realpathSync(join(fixture.root, "operator-bin"));
  try {
    const plan = installLaunchdServices({
      repositoryRoot: fixture.root,
      userHome: home,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      environment: RUNNER_ROLE_ENVIRONMENT,
      cliLookup: (name) => name === "claude" ? join(claudeDirectory, "claude") : "",
    });
    assert.deepEqual(plan.report.filter(([key]) => key === "runner-path-source"), [
      ["runner-path-source", "com.agentos.runner=rendered"],
      ["runner-path-source", "com.agentos.runner-2=rendered"],
    ]);
    for (const label of ["com.agentos.runner", "com.agentos.runner-2"]) {
      const environment = plistEnvironment(plan.rendered[label]);
      const directories = environment.RUNNER_PATH.split(":");
      assert.equal(directories.includes(claudeDirectory), true);
      assert.equal(directories.includes(dirname(process.execPath)), true);
      // The runner searches RUNNER_PATH for the bare command name, so at least
      // one rendered directory must hold an executable named `claude`.
      assert.equal(
        directories.some((directory) => {
          const candidate = join(directory, "claude");
          if (!existsSync(candidate)) return false;
          try {
            accessSync(candidate, fsConstants.X_OK);
            return true;
          } catch {
            return false;
          }
        }),
        true,
      );
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a runner-role install refuses when neither provider CLI resolves", () => {
  const fixture = runnerRoleFixture({ sharedEnvironment: "DATABASE_URL=postgresql://fixture\n" });
  const home = join(fixture.root, "operator-home");
  try {
    assert.throws(
      () => installLaunchdServices({
        repositoryRoot: fixture.root,
        userHome: home,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        environment: RUNNER_ROLE_ENVIRONMENT,
        cliLookup: () => "",
      }),
      /runner-provider-cli-unresolved:claude,codex/u,
    );
    assert.equal(existsSync(join(home, "Library/LaunchAgents/com.agentos.runner.plist")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a runner-role install refuses when a configured provider binary does not resolve", () => {
  const fixture = runnerRoleFixture({
    sharedEnvironment: "DATABASE_URL=postgresql://fixture\nCODEX_BINARY=/opt/homebrew/bin/codex-relocated\n",
    cliDirectory: "operator-bin",
  });
  const home = join(fixture.root, "operator-home");
  const claudeDirectory = realpathSync(join(fixture.root, "operator-bin"));
  try {
    assert.throws(
      () => installLaunchdServices({
        repositoryRoot: fixture.root,
        userHome: home,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        environment: RUNNER_ROLE_ENVIRONMENT,
        cliLookup: (name) => name === "claude" ? join(claudeDirectory, "claude") : "",
      }),
      /runner-provider-cli-unresolved:codex/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a runner-role plan names a provider CLI absent from this host", () => {
  const fixture = runnerRoleFixture({
    sharedEnvironment: "DATABASE_URL=postgresql://fixture\n",
    cliDirectory: "operator-bin",
  });
  const home = join(fixture.root, "operator-home");
  const claudeDirectory = realpathSync(join(fixture.root, "operator-bin"));
  try {
    const plan = installLaunchdServices({
      repositoryRoot: fixture.root,
      userHome: home,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      environment: RUNNER_ROLE_ENVIRONMENT,
      cliLookup: (name) => name === "claude" ? join(claudeDirectory, "claude") : "",
    });
    assert.deepEqual(plan.report.filter(([key]) => key === "runner-provider-cli-missing"), [
      ["runner-provider-cli-missing", "codex"],
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a migrated runner definition that keeps an inline RUNNER_PATH is reported as plist-inline", () => {
  const operatorPath = "/operator/npm-global/bin:/usr/local/bin:/usr/bin:/bin";
  const fixture = runnerRoleFixture({
    sharedEnvironment: `DATABASE_URL=postgresql://fixture\nRUNNER_PATH=${operatorPath}\n`,
  });
  const home = join(fixture.root, "operator-home");
  const launchAgents = join(home, "Library/LaunchAgents");
  try {
    const inventory = generateDeployServiceInventory({
      runnerCount: 2,
      runnerIdPrefix: "",
      deployRole: "runner",
    });
    const legacy = renderServicePlists({
      inventory,
      nodeBinary: "/usr/bin/node",
      repositoryRoot: fixture.root,
      sharedRoot: join(fixture.root, "shared"),
      stdoutPath: join(home, "legacy-stdout.log"),
      stderrPath: join(home, "legacy-stderr.log"),
      path: "/legacy/bin:/usr/bin:/bin",
    });
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(launchAgents, "com.agentos.runner.plist"), legacy["com.agentos.runner"]);
    const plan = installLaunchdServices({
      repositoryRoot: fixture.root,
      userHome: home,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      environment: RUNNER_ROLE_ENVIRONMENT,
      replaceExisting: true,
      cliLookup: () => "",
    });
    assert.deepEqual(plan.report.filter(([key]) => key === "runner-path-source"), [
      ["runner-path-source", "com.agentos.runner=plist-inline"],
      ["runner-path-source", "com.agentos.runner-2=.env"],
    ]);
    assert.match(
      plan.rendered["com.agentos.runner"],
      /<key>RUNNER_PATH<\/key>\s*<string>\/legacy\/bin:\/usr\/bin:\/bin<\/string>/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the wrapper gives a runner the shared/.env RUNNER_PATH a rendered definition omits", () => {
  const operatorPath = "/operator/npm-global/bin:/usr/local/bin:/usr/bin:/bin";
  const fixture = runnerRoleFixture({
    sharedEnvironment: `DATABASE_URL=postgresql://fixture\nRUNNER_PATH=${operatorPath}\n`,
  });
  const home = join(fixture.root, "operator-home");
  try {
    const plan = installLaunchdServices({
      repositoryRoot: fixture.root,
      userHome: home,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      environment: RUNNER_ROLE_ENVIRONMENT,
      cliLookup: () => "",
    });
    const launchdEnvironment = plistEnvironment(plan.rendered["com.agentos.runner"]);
    const invocation = resolveServiceInvocation({
      repositoryRoot: fixture.root,
      label: "com.agentos.runner",
      environment: { ...launchdEnvironment, AGENTOS_RUNNER_COUNT: "2" },
      nodeBinary: process.execPath,
    });
    assert.equal(invocation.env.RUNNER_PATH, operatorPath);
    assert.equal(invocation.env.RUNNER_ID, "runner-1");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
