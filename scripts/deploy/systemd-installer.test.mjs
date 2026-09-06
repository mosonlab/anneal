import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  assertStagedSource,
  autoDeployEnvironmentValues,
  controlledLaunchdPath,
  installLaunchd,
  installLaunchdServices,
  installStagedSystemdAutoDeploy,
  installStagedSystemdServices,
  planSystemdAutoDeploy,
  renderAutoDeploySystemdUnit,
  renderAutoDeploySystemdTimer,
  renderLaunchdPlist,
  renderServiceLaunchdPlist,
  renderServiceSystemdUnit,
  recognizeInstalledEntry,
  renderSystemdSudoers,
  serviceEnvironmentValues,
  servicePlistValues,
  verifySystemdAutoDeployDefinitions,
  verifySystemdServiceDefinitions,
} from "./install-launchd.mjs";
import { runServiceInstaller } from "./install-launchd-services.mjs";
import { generateServiceInventory, resolveServiceInventory } from "./service-inventory.mjs";

const DEFAULT_INVENTORY = resolveServiceInventory({});
const SERVICE_LABELS = DEFAULT_INVENTORY.labels;

const withServicePlatform = async (platform, work) => {
  const previous = process.env.AGENTOS_SERVICE_PLATFORM;
  process.env.AGENTOS_SERVICE_PLATFORM = platform;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.AGENTOS_SERVICE_PLATFORM;
    else process.env.AGENTOS_SERVICE_PLATFORM = previous;
  }
};

const withLinux = (work) => withServicePlatform("linux", work);

const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const captureStdout = (work) => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { work(); } finally { process.stdout.write = original; }
  return chunks.join("");
};

const prepareManifestValidationCase = (platform) => {
  const root = mkdtempSync(join(tmpdir(), `agentos-${platform}-manifest-invalid-`));
  if (platform === "linux") {
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const options = {
      repositoryRoot: root,
      serviceUser: "anneal-test",
      userLookup: accountLookup,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      unitDirectory,
      sudoersPath,
      systemctlPath: "/usr/bin/true",
      visudoPath: "/usr/bin/true",
      effectiveUid: 501,
      apply: true,
      execute: () => "",
    };
    installLaunchdServices(options);
    const manifestPath = join(root, ".agentos-deploy/launchd/manifest.json");
    return {
      root,
      manifestPath,
      restage: () => installLaunchdServices(options),
      invoke: () => installStagedSystemdServices({
        ...options,
        effectiveUid: 0,
      }),
    };
  }

  const home = join(root, "home");
  mkdirSync(join(root, "shared"), { recursive: true });
  writeFileSync(join(root, "shared/.env"), "DATABASE_URL=configured\n");
  mkdirSync(join(root, "releases/release-1"), { recursive: true });
  symlinkSync("releases/release-1", join(root, "current"));
  const options = {
    repositoryRoot: root,
    userHome: home,
    nodeBinary: process.execPath,
    gitBinary: process.execPath,
    effectiveUid: 501,
    apply: true,
  };
  installLaunchdServices(options);
  const manifestPath = join(root, ".agentos-deploy/launchd/manifest.json");
  return {
    root,
    manifestPath,
    invoke: () => installLaunchdServices({
      ...options,
      apply: false,
    }),
  };
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const assertManifestValidationFailure = ({ platform, field, mutate }) => {
  const prepared = prepareManifestValidationCase(platform);
  try {
    if (mutate === "unparseable") {
      writeFileSync(prepared.manifestPath, "{\n");
    } else {
      const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8"));
      if (mutate === "entries-null") manifest.entries[1] = null;
      if (mutate === "entry-path-missing") delete manifest.entries[1].path;
      if (mutate === "entry-label-missing") delete manifest.entries[1].label;
      if (mutate === "entry-pending-install-false") manifest.entries[1].pendingInstall = false;
      if (mutate === "retired-entries-null") manifest.retiredEntries = [null];
      if (mutate === "retired-entry-label-missing") {
        manifest.retiredEntries = [
          { ...manifest.entries[1] },
          { ...manifest.entries[2] },
        ];
        delete manifest.retiredEntries[1].label;
      }
      if (mutate === "staging-root-number") manifest.stagingRoot = 42;
      if (mutate === "unit-directory-number") manifest.unitDirectory = 42;
      if (mutate === "sudoers-path-number") manifest.sudoersPath = 42;
      if (mutate === "runner-count-string") {
        manifest.renderInputs = { ...manifest.renderInputs, runnerCount: "10" };
      }
      writeFileSync(prepared.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    const reason = `${platform === "linux" ? "systemd" : "launchd"}-service-manifest-invalid`;
    assert.throws(prepared.invoke, (error) => {
      assert.match(error.message, new RegExp(reason, "u"));
      assert.match(error.message, new RegExp(escapeRegExp(prepared.manifestPath), "u"));
      for (const matcher of field) assert.match(error.message, matcher);
      assert.notEqual(error.name, "TypeError");
      assert.notEqual(error.name, "SyntaxError");
      return true;
    }, `${platform} ${mutate}`);
  } finally {
    rmSync(prepared.root, { recursive: true, force: true });
  }
};

for (const { name, mutate, field, platforms = ["linux", "darwin"] } of [
  { name: "an unparseable manifest", mutate: "unparseable", field: [/unparseable/u] },
  { name: "a null manifest entry", mutate: "entries-null", field: [/entries[^\n]*1/u] },
  { name: "a manifest entry missing path", mutate: "entry-path-missing", field: [/entries[^\n]*1[^\n]*path/u] },
  { name: "a manifest entry missing label", mutate: "entry-label-missing", field: [/entries[^\n]*1[^\n]*label/u] },
  { name: "a manifest entry with pendingInstall false", mutate: "entry-pending-install-false", field: [/entries[^\n]*1[^\n]*pendingInstall/u] },
  { name: "a null retired manifest entry", mutate: "retired-entries-null", field: [/retiredEntries[^\n]*0/u] },
  { name: "a retired manifest entry missing label", mutate: "retired-entry-label-missing", field: [/retiredEntries[^\n]*1[^\n]*label/u] },
  { name: "a manifest renderInputs runnerCount string", mutate: "runner-count-string", field: [/renderInputs[^\n]*runnerCount/u] },
  { name: "a numeric stagingRoot", mutate: "staging-root-number", field: [/stagingRoot/u], platforms: ["linux"] },
  { name: "a numeric unitDirectory", mutate: "unit-directory-number", field: [/unitDirectory/u], platforms: ["linux"] },
  { name: "a numeric sudoersPath", mutate: "sudoers-path-number", field: [/sudoersPath/u], platforms: ["linux"] },
]) {
  test(`${name} is refused with a named error on each applicable service platform`, async () => {
    for (const platform of platforms) {
      await withServicePlatform(platform, () => assertManifestValidationFailure({ platform, field, mutate }));
    }
  });
}

test("Linux restaging validates manifest entries before indexing them by path", async () => {
  await withLinux(() => {
    const prepared = prepareManifestValidationCase("linux");
    try {
      const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8"));
      manifest.entries[1] = null;
      writeFileSync(prepared.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      assert.throws(prepared.restage, (error) => {
        assert.match(error.message, /systemd-service-manifest-invalid/u);
        assert.match(error.message, new RegExp(escapeRegExp(prepared.manifestPath), "u"));
        assert.match(error.message, /entries[^\n]*1/u);
        assert.notEqual(error.name, "TypeError");
        assert.notEqual(error.name, "SyntaxError");
        return true;
      });
    } finally {
      rmSync(prepared.root, { recursive: true, force: true });
    }
  });
});

const accountLookup = () => "anneal-test:x:620:620::/var/lib/anneal-test:/bin/bash";
const digest = (contents) => createHash("sha256").update(contents).digest("hex");
const launchdNotFound = () => {
  const error = new Error("not found");
  error.status = 113;
  error.stderr = "Could not find service\n";
  return error;
};
const systemdManifestFingerprint = (manifest) => digest(JSON.stringify({
  runnerCount: manifest.runnerCount ?? null,
  serviceUser: manifest.serviceUser,
  renderInputs: manifest.renderInputs,
  entries: [...manifest.entries, ...(manifest.auxiliaryEntries ?? [])].map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    stagedPath: entry.stagedPath,
    installedSha256: entry.installedSha256,
    existed: entry.existed,
    parentExisted: entry.parentExisted ?? null,
  })),
  ...((manifest.retiredEntries?.length ?? 0) === 0 ? {} : {
    retiredEntries: manifest.retiredEntries.map((entry) => ({
      kind: entry.kind,
      label: entry.label,
      unit: entry.unit,
      path: entry.path,
      installedSha256: entry.installedSha256,
    })),
  }),
}));

const spawnServiceInstallerCli = ({ root, args, context }) => {
  const harnessPath = join(root, "service-installer-cli-harness.mjs");
  const recorderPath = join(root, "service-installer-cli-records.jsonl");
  const entrypoint = new URL("./install-launchd-services.mjs", import.meta.url);
  writeFileSync(harnessPath, `
import { appendFileSync } from "node:fs";
import { runServiceInstaller } from ${JSON.stringify(entrypoint.href)};
const config = JSON.parse(process.env.AGENTOS_INSTALLER_TEST_CONTEXT);
process.env.AGENTOS_SERVICE_PLATFORM = "linux";
process.argv[1] = config.entrypoint;
const record = (value) => appendFileSync(config.recorderPath, JSON.stringify(value) + "\\n");
process.exitCode = runServiceInstaller(process.argv.slice(2), {
  ...config.context,
  userLookup: () => "anneal-test:x:620:620::/var/lib/anneal-test:/bin/bash",
  execute: (_command, commandArgs) => { record({ operation: "execute", args: commandArgs }); return ""; },
  chown: (path, uid, gid) => record({ operation: "chown", path, uid, gid }),
});
`);
  const result = spawnSync(process.execPath, [harnessPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTOS_INSTALLER_TEST_CONTEXT: JSON.stringify({
        context,
        entrypoint: entrypoint.pathname,
        recorderPath,
      }),
    },
  });
  const records = existsSync(recorderPath)
    ? readFileSync(recorderPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { ...result, records };
};

const writeSudoPolicyStub = (root) => {
  const path = join(root, "sudo-policy-stub.mjs");
  writeFileSync(path, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const [nonInteractive, ...command] = process.argv.slice(2);
if (nonInteractive !== "-n") process.exit(2);
const policy = readFileSync(process.env.SUDOERS_POLICY, "utf8").trim();
const allowed = new Set(policy.split("NOPASSWD: ")[1].split(", "));
process.exit(allowed.has(command.join(" ")) ? 0 : 1);
`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
};

const unitEnvironmentKeys = (unit) => [...unit.matchAll(/^Environment=([A-Za-z_][A-Za-z0-9_]*)=/gmu)].map((match) => match[1]);

const plistEnvironmentKeys = (plist) => {
  const block = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u)?.[1] ?? "";
  return [...block.matchAll(/<key>([A-Za-z_][A-Za-z0-9_]*)<\/key>/gu)].map((match) => match[1]);
};

test("systemd service units carry the exact plist environment contract", () => {
  const root = join(tmpdir(), "agentos-systemd-fixture");
  const values = SERVICE_LABELS.map((label) => servicePlistValues({
    label,
    inventory: DEFAULT_INVENTORY,
    nodeBinary: "/usr/bin/node",
    repositoryRoot: root,
    sharedRoot: join(root, "shared"),
    stdoutPath: "/tmp/stdout.log",
    stderrPath: "/tmp/stderr.log",
    path: "/usr/bin:/bin with space:100%",
    wrapperPath: join(root, "shared/bin/agentos-service-wrapper.mjs"),
  }));
  const definitions = Object.fromEntries(values.map((value) => [
    value.label,
    renderServiceSystemdUnit(undefined, { ...value, serviceUser: "anneal-test" }),
  ]));
  assert.equal(verifySystemdServiceDefinitions(definitions, DEFAULT_INVENTORY), true);
  for (const value of values) {
    const unit = definitions[value.label];
    const plist = renderServiceLaunchdPlist(
      readFileSync(new URL("./com.agentos.service.plist.in", import.meta.url), "utf8"),
      value,
    );
    assert.deepEqual(new Set(unitEnvironmentKeys(unit)), new Set(plistEnvironmentKeys(plist)));
    assert.deepEqual(new Set(unitEnvironmentKeys(unit)), new Set(Object.keys(serviceEnvironmentValues(value))));
    assert.doesNotMatch(unit, /^EnvironmentFile=/mu);
    assert.match(unit, new RegExp(`^ExecStart="/usr/bin/node" .* ${value.label}$`, "mu"));
    assert.match(unit, /PATH=".*%%"/u);
    assert.match(unit, /^User=(?!root$)\S+$/mu);
  }
});

test("auto-deploy units match the plist environment contract in both backup modes", () => {
  const template = readFileSync(new URL("./com.agentos.auto-deploy.plist.in", import.meta.url), "utf8");
  const root = join(tmpdir(), "agentos-auto-deploy-fixture");
  for (const backup of [
    { mode: "host", pgDumpBinary: "/usr/bin/pg_dump" },
    {
      mode: "container",
      dockerBinary: "/usr/bin/docker",
      container: "configured-container",
      pgDumpBinary: "/usr/bin/pg_dump",
    },
  ]) {
    const values = {
      nodeBinary: "/usr/bin/node",
      deployScript: join(root, "current/scripts/deploy/quiet-window-deploy.mjs"),
      repositoryRoot: root,
      stdoutPath: "/tmp/anneal.stdout",
      stderrPath: "/tmp/anneal.stderr",
      path: "/usr/bin:/bin with space:100%",
      gitBinary: "/usr/bin/git",
      npmBinary: "/usr/bin/npm",
      sourceRemote: "configured-remote",
      serviceUser: "anneal-test",
      backup,
    };
    const plist = renderLaunchdPlist(template, values);
    const service = renderAutoDeploySystemdUnit(undefined, values);
    const timer = renderAutoDeploySystemdTimer();
    assert.equal(verifySystemdAutoDeployDefinitions({ service, timer }), true);
    assert.deepEqual(new Set(unitEnvironmentKeys(service)), new Set(plistEnvironmentKeys(plist)));
    assert.deepEqual(new Set(unitEnvironmentKeys(service)), new Set(Object.keys(autoDeployEnvironmentValues(values))));
    assert.doesNotMatch(service, /^EnvironmentFile=/mu);
    assert.match(service, /PATH=".*%%"/u);
  }
});

test("non-default runner count is persisted in service and auto-deploy definitions", () => {
  const root = "/fixture";
  const serviceValues = servicePlistValues({
    label: "com.agentos.runner-16",
    inventory: generateServiceInventory({ runnerCount: 16, runnerIdPrefix: "", deployRole: "control-plane" }),
    nodeBinary: "/usr/bin/node",
    repositoryRoot: root,
    stdoutPath: "/tmp/stdout",
    stderrPath: "/tmp/stderr",
    path: "/usr/bin:/bin",
  });
  const plist = renderServiceLaunchdPlist(
    readFileSync(new URL("./com.agentos.service.plist.in", import.meta.url), "utf8"),
    serviceValues,
  );
  const unit = renderServiceSystemdUnit(undefined, { ...serviceValues, serviceUser: "anneal-test" });
  assert.match(plist, /<key>AGENTOS_RUNNER_COUNT<\/key>/u);
  assert.match(unit, /^Environment=AGENTOS_RUNNER_COUNT=/mu);
  const autoValues = {
    nodeBinary: "/usr/bin/node",
    deployScript: "/fixture/current/scripts/deploy/quiet-window-deploy.mjs",
    repositoryRoot: root,
    stdoutPath: "/tmp/stdout",
    stderrPath: "/tmp/stderr",
    path: "/usr/bin:/bin",
    gitBinary: "/usr/bin/git",
    npmBinary: "/usr/bin/npm",
    sourceRemote: "origin",
    backup: { mode: "host", pgDumpBinary: "/usr/bin/pg_dump" },
    serviceUser: "anneal-test",
    runnerCount: 16,
  };
  assert.match(renderLaunchdPlist(readFileSync(new URL("./com.agentos.auto-deploy.plist.in", import.meta.url), "utf8"), autoValues), /<key>AGENTOS_RUNNER_COUNT<\/key>\s*<string>16<\/string>/u);
  assert.match(renderAutoDeploySystemdUnit(undefined, autoValues), /^Environment=AGENTOS_RUNNER_COUNT="16"$/mu);
});

test("sudoers rendering resolves unit names from the inventory it is given, never an import-time one", () => {
  const source = String.raw`
    import { renderSystemdSudoers } from "./scripts/deploy/install-launchd.mjs";
    import { generateServiceInventory } from "./scripts/deploy/service-inventory.mjs";
    const inventory = generateServiceInventory({ runnerCount: 16, runnerIdPrefix: "", deployRole: "control-plane" });
    const sudoers = renderSystemdSudoers({ serviceUser: "anneal-test", inventory });
    console.log(JSON.stringify({ labels: inventory.labels.length, restarts: (sudoers.match(/\/bin\/systemctl restart /gu) ?? []).length, last: sudoers.includes(inventory.entries.at(-1).unitName) }));
  `;
  const env = { ...process.env, AGENTOS_SERVICE_PLATFORM: "linux" };
  delete env.AGENTOS_RUNNER_COUNT;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: process.cwd(), env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { labels: 19, restarts: 19, last: true });
});

test("systemd path directives escape whitespace and percent specifiers", () => {
  const root = "/opt/Anneal Runtime 100%";
  const values = servicePlistValues({
    label: "com.agentos.api",
    inventory: DEFAULT_INVENTORY,
    nodeBinary: "/opt/Node Runtime 100%/node",
    repositoryRoot: root,
    sharedRoot: `${root}/shared`,
    stdoutPath: "/tmp/stdout",
    stderrPath: "/tmp/stderr",
    path: "/usr/bin:/bin",
    wrapperPath: `${root}/shared/bin/agentos-service-wrapper.mjs`,
  });
  const unit = renderServiceSystemdUnit(undefined, { ...values, serviceUser: "anneal-test" });
  assert.match(unit, /^WorkingDirectory=\/opt\/Anneal\\x20Runtime\\x20100%%$/mu);
  assert.match(unit, /^ExecStart="\/opt\/Node Runtime 100%%\/node" "\/opt\/Anneal Runtime 100%%\/shared\/bin\/agentos-service-wrapper\.mjs" com\.agentos\.api$/mu);
});

test("empty-prefix Darwin definitions and plans preserve the baseline identities", () => {
  const serviceRoot = realpathSync(mkdtempSync(join(tmpdir(), "agentos-darwin-service-root-")));
  const previousPlatform = process.env.AGENTOS_SERVICE_PLATFORM;
  const previousCount = process.env.AGENTOS_RUNNER_COUNT;
  const previousPrefix = process.env.AGENTOS_RUNNER_ID_PREFIX;
  process.env.AGENTOS_SERVICE_PLATFORM = "darwin";
  delete process.env.AGENTOS_RUNNER_COUNT;
  delete process.env.AGENTOS_RUNNER_ID_PREFIX;
  try {
    const baseline = JSON.parse(readFileSync(new URL("./fixtures/darwin-9a52c6ad-baseline.json", import.meta.url), "utf8"));
    const root = process.cwd();
    const plan = installLaunchdServices({
      repositoryRoot: serviceRoot,
      userHome: join(serviceRoot, "fixture-home"),
      nodeBinary: "/usr/bin/node",
      gitBinary: "/usr/bin/git",
      path: "/usr/bin:/bin",
      effectiveUid: 501,
      apply: false,
    });
    const normalize = (value) => value.replaceAll(serviceRoot, "<ROOT>").replaceAll(root, "<ROOT>");
    const hashes = Object.fromEntries(Object.entries(plan.rendered).map(([label, contents]) => [
      label,
      digest(normalize(contents)),
    ]));
    assert.deepEqual(hashes, baseline.renderedPlistSha256);
    assert.deepEqual(plan.entries.map(normalize), baseline.serviceManifestEntries);
    const autoTemplate = readFileSync(new URL("./com.agentos.auto-deploy.plist.in", import.meta.url), "utf8");
    const autoPlist = renderLaunchdPlist(autoTemplate, {
      nodeBinary: "/usr/bin/node",
      deployScript: "/fixture/current/scripts/deploy/quiet-window-deploy.mjs",
      repositoryRoot: "/fixture",
      stdoutPath: "/fixture/stdout",
      stderrPath: "/fixture/stderr",
      path: "/usr/bin:/bin",
      gitBinary: "/usr/bin/git",
      npmBinary: "/usr/bin/npm",
      sourceRemote: "origin",
      backup: { mode: "host", pgDumpBinary: "/usr/bin/pg_dump" },
    });
    assert.equal(digest(autoPlist), baseline.autoDeployPlistSha256);
    const autoHome = mkdtempSync(join(tmpdir(), "agentos-darwin-auto-home-"));
    const resolvedCommand = (name) => realpathSync(spawnSync("/usr/bin/which", [name], { encoding: "utf8" }).stdout.trim());
    const actualGit = resolvedCommand("git");
    const autoBin = join(autoHome, "bin");
    const autoGitPath = join(autoBin, "git");
    mkdirSync(autoBin);
    writeFileSync(autoGitPath, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.length === 5 && args[0] === "-C" && args.slice(2).join(" ") === "remote get-url origin") {
  process.stdout.write("origin\\n");
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(actualGit)}, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    const autoGit = realpathSync(autoGitPath);
    const autoEntrypoint = spawnSync(process.execPath, [
      "scripts/deploy/install-launchd.mjs",
      "--pg-dump-mode", "host",
      "--pg-dump-binary", "/usr/bin/true",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTOS_SERVICE_PLATFORM: "darwin",
        HOME: autoHome,
        // Gate worktrees need not have an origin; the shim supplies the frozen
        // baseline value and delegates every other Git command.
        PATH: `${autoBin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(autoEntrypoint.status, 0, autoEntrypoint.stderr);
    const autoNode = realpathSync(process.execPath);
    const autoNpm = resolvedCommand("npm");
    const autoPath = controlledLaunchdPath({ nodeBinary: autoNode, gitBinary: autoGit });
    const normalizeAuto = (value) => value
      .replaceAll(autoPath, "<CONTROLLED_PATH>")
      .replaceAll(autoNode, "<NODE>")
      .replaceAll(autoGit, "<GIT>")
      .replaceAll(autoNpm, "<NPM>")
      .replaceAll(autoHome, "<HOME>")
      .replaceAll(root, "<ROOT>");
    const normalizedAutoStdout = normalizeAuto(autoEntrypoint.stdout);
    assert.equal(normalizedAutoStdout, baseline.autoDeployPlanStdout);
    assert.deepEqual(
      normalizedAutoStdout.match(/^PLAN destination=(.*)$/mu)?.slice(1) ?? [],
      baseline.autoDeployManifestEntries,
    );
    rmSync(autoHome, { recursive: true, force: true });
    // The service plan reads $HOME/Library/LaunchAgents; a developer machine
    // with the services installed would otherwise report a definition
    // conflict instead of the pinned plan bytes.
    const serviceHome = mkdtempSync(join(tmpdir(), "agentos-darwin-service-home-"));
    // Use the public command runner with an isolated repository as well as HOME;
    // the checkout may own a manifest for the developer's installed services.
    const entrypoint = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { runServiceInstaller } from ${JSON.stringify(new URL("./install-launchd-services.mjs", import.meta.url).href)};
      process.exitCode = runServiceInstaller([], { repositoryRoot: ${JSON.stringify(serviceRoot)} });
    `], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, AGENTOS_SERVICE_PLATFORM: "darwin", HOME: serviceHome },
    });
    rmSync(serviceHome, { recursive: true, force: true });
    assert.equal(entrypoint.status, 0, entrypoint.stderr);
    assert.equal(normalize(entrypoint.stdout), baseline.servicePlanStdout);
  } finally {
    rmSync(serviceRoot, { recursive: true, force: true });
    if (previousPlatform === undefined) delete process.env.AGENTOS_SERVICE_PLATFORM;
    else process.env.AGENTOS_SERVICE_PLATFORM = previousPlatform;
    if (previousCount === undefined) delete process.env.AGENTOS_RUNNER_COUNT;
    else process.env.AGENTOS_RUNNER_COUNT = previousCount;
    if (previousPrefix === undefined) delete process.env.AGENTOS_RUNNER_ID_PREFIX;
    else process.env.AGENTOS_RUNNER_ID_PREFIX = previousPrefix;
  }
});

test("rendered unit syntax is verified by systemd-analyze when available", (t) => {
  const available = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT") {
    t.skip("systemd-analyze unavailable on this host");
    return;
  }
  assert.equal(available.status, 0, available.stderr);
  const root = mkdtempSync(join(tmpdir(), "agentos-systemd-analyze-"));
  try {
    const wrapper = join(root, "agentos-service-wrapper.mjs");
    writeFileSync(wrapper, "#!/usr/bin/env node\n", { mode: 0o755 });
    const serviceUser = process.env.USER && process.env.USER !== "root" ? process.env.USER : "nobody";
    const values = SERVICE_LABELS.map((label) => servicePlistValues({
      label,
      inventory: DEFAULT_INVENTORY,
      nodeBinary: process.execPath,
      repositoryRoot: root,
      sharedRoot: join(root, "shared"),
      stdoutPath: join(root, "stdout"),
      stderrPath: join(root, "stderr"),
      path: "/usr/bin:/bin",
      wrapperPath: wrapper,
    }));
    const files = [];
    for (const value of values) {
      const path = join(root, `${value.label}.service`);
      writeFileSync(path, renderServiceSystemdUnit(undefined, { ...value, serviceUser }));
      files.push(path);
    }
    const autoValues = {
      nodeBinary: process.execPath,
      deployScript: wrapper,
      repositoryRoot: root,
      path: "/usr/bin:/bin",
      gitBinary: "/usr/bin/git",
      npmBinary: "/usr/bin/npm",
      sourceRemote: "configured-remote",
      serviceUser,
      backup: { mode: "host", pgDumpBinary: "/usr/bin/pg_dump" },
    };
    const autoService = join(root, "com.agentos.auto-deploy.service");
    const autoTimer = join(root, "com.agentos.auto-deploy.timer");
    writeFileSync(autoService, renderAutoDeploySystemdUnit(undefined, autoValues));
    writeFileSync(autoTimer, renderAutoDeploySystemdTimer());
    files.push(autoService, autoTimer);
    for (const path of files) {
      const verified = spawnSync("systemd-analyze", ["verify", path], {
        encoding: "utf8",
        env: { ...process.env, SYSTEMD_UNIT_PATH: `${root}:` },
      });
      const output = `${verified.stdout ?? ""}${verified.stderr ?? ""}`;
      assert.equal(verified.status, 0, output);
      // systemd-analyze loads the host's own units alongside the rendered one,
      // so its output carries diagnostics about units this repository does not
      // write (a newer key in a distribution unit, an unreadable runtime unit).
      // Only the lines naming the unit under test are evidence about our
      // rendering; every unit under test lives under the temporary root.
      const rendered = output
        .split("\n")
        .filter((line) => line.includes(root) || line.startsWith(`${basename(path)}:`))
        .join("\n");
      assert.doesNotMatch(rendered, /Unknown|Failed to parse/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the recovery rules recognise every state an interrupted install can leave", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-staged-recovery-"));
  try {
    const target = join(root, "com.agentos.api.service");
    const backup = join(root, "backup");
    const write = (path, contents) => { writeFileSync(path, contents); return digest(contents); };
    const installed = digest("installed\n");
    const previous = digest("previous\n");
    const original = digest("original\n");
    const created = {
      path: target,
      existed: false,
      backupPath: null,
      originalSha256: null,
      installedSha256: installed,
    };
    const overwritten = {
      path: target,
      existed: true,
      backupPath: backup,
      originalSha256: original,
      installedSha256: installed,
      previousInstalledSha256: previous,
    };

    // The copy completed over a file the installer created.
    write(target, "installed\n");
    assert.equal(recognizeInstalledEntry({ entry: created, reason: "systemd-service" }), installed);

    // The copy completed over an operator file: the backup is the only way
    // back, so it must be present and must still be the operator's bytes.
    assert.throws(
      () => recognizeInstalledEntry({ entry: overwritten, reason: "systemd-service" }),
      /^Error: systemd-service-backup-missing:/u,
    );
    write(backup, "someone-elses\n");
    assert.throws(
      () => recognizeInstalledEntry({ entry: overwritten, reason: "launchd-service" }),
      /^Error: launchd-service-backup-missing:/u,
    );
    write(backup, "original\n");
    assert.equal(recognizeInstalledEntry({ entry: overwritten, reason: "systemd-service" }), installed);

    // The copy never happened, or a partial transaction was already restored.
    write(target, "original\n");
    assert.equal(recognizeInstalledEntry({ entry: overwritten, reason: "systemd-service" }), original);
    rmSync(backup, { force: true });
    assert.equal(recognizeInstalledEntry({ entry: overwritten, reason: "systemd-service" }), original);

    // An interrupted upgrade left the digest this installer wrote last time.
    write(target, "previous\n");
    assert.equal(recognizeInstalledEntry({ entry: overwritten, reason: "systemd-service" }), previous);

    // Nothing at the target is the created entry's untouched state and the
    // overwritten entry's drift.
    rmSync(target, { force: true });
    assert.equal(recognizeInstalledEntry({ entry: created, reason: "systemd-service" }), null);
    assert.throws(
      () => recognizeInstalledEntry({ entry: overwritten, reason: "systemd-auto-deploy" }),
      /^Error: systemd-auto-deploy-definition-drift:/u,
    );

    // Anything else at the target is a foreign write.
    write(target, "operator-edited\n");
    assert.throws(
      () => recognizeInstalledEntry({ entry: created, reason: "systemd-service" }),
      new RegExp(`^Error: systemd-service-definition-drift:${escapeRegExp(target)}$`, "u"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a staged source is refused when it is missing or no longer what the manifest promised", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-staged-source-"));
  try {
    const stagedPath = join(root, "staged");
    const entry = { path: join(root, "target"), stagedPath, installedSha256: digest("installed\n") };
    assert.throws(() => assertStagedSource(entry), /^Error: systemd-staged-file-missing:/u);
    assert.throws(() => assertStagedSource({ ...entry, stagedPath: undefined }), /^Error: systemd-staged-file-missing:/u);
    writeFileSync(stagedPath, "tampered\n");
    assert.throws(() => assertStagedSource(entry), /^Error: systemd-staged-file-drift:/u);
    writeFileSync(stagedPath, "installed\n");
    assert.equal(assertStagedSource(entry), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the service CLI prints the phase, report and remaining step the installer returns", async () => {
  await withLinux(async () => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-cli-outcome-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const context = {
      repositoryRoot: root,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      unitDirectory,
      sudoersPath,
      visudoPath: "/usr/bin/true",
      userLookup: accountLookup,
      effectiveUid: 501,
    };
    const stageCommand = (options) => `NEXT sudo node ${shellQuote(process.argv[1])} ${options}\n`;
    try {
      const planned = captureStdout(() => assert.equal(runServiceInstaller(["--service-user", "anneal-test"], context), 0));
      const stagingRoot = planned.match(/^PLAN staging=(.*)$/mu)[1];
      assert.equal(planned, [
        "PLAN platform=linux",
        `PLAN unit-directory=${unitDirectory}`,
        `PLAN units=${SERVICE_LABELS.length}`,
        `PLAN staging=${stagingRoot}`,
        "PLAN no files or systemd state changed\n",
      ].join("\n"));
      const applied = captureStdout(() =>
        assert.equal(runServiceInstaller(["--apply", "--service-user", "anneal-test"], context), 0));
      assert.equal(applied, [
        "APPLY platform=linux",
        `APPLY unit-directory=${unitDirectory}`,
        `APPLY units=${SERVICE_LABELS.length}`,
        `APPLY staging=${applied.match(/^APPLY staging=(.*)$/mu)[1]}`,
        stageCommand("--install-units --service-user 'anneal-test'"),
      ].join("\n"));
      const plannedRevert = captureStdout(() =>
        assert.equal(runServiceInstaller(["--revert", "--service-user", "anneal-test"], context), 0));
      assert.match(plannedRevert, /^REVERT platform=linux\n/u);
      assert.match(plannedRevert, /\nPLAN no files or systemd state changed\n$/u);
      const stagedRevert = captureStdout(() =>
        assert.equal(runServiceInstaller(["--revert", "--apply", "--service-user", "anneal-test"], context), 0));
      assert.match(stagedRevert, /^REVERT platform=linux\n/u);
      assert.equal(
        stagedRevert.endsWith(stageCommand("--install-units --revert --service-user 'anneal-test'")),
        true,
        stagedRevert,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("the real service CLI enforces the Linux root boundary and sudo -n policy", async () => {
  await withLinux(async () => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-installer-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    try {
      const plan = installLaunchdServices({
        repositoryRoot: root,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        unitDirectory,
        sudoersPath,
        apply: false,
      });
      assert.equal(plan.entries.length, SERVICE_LABELS.length + 1);
      assert.equal(existsSync(plan.staging), false);
      const stagedDropIn = join(plan.staging, "units/com.agentos.api.service.d/os-isolation.conf");
      mkdirSync(join(plan.staging, "units/com.agentos.api.service.d"), { recursive: true });
      writeFileSync(stagedDropIn, "[Service]\nEnvironment=RUNNER_WORKSPACE_ROOT=\"/configured/workspaces\"\n");
      const staged = installLaunchdServices({
        repositoryRoot: root,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        unitDirectory,
        sudoersPath,
        visudoPath: "/usr/bin/true",
        apply: true,
      });
      assert.equal(staged.entries.length, SERVICE_LABELS.length + 1);
      assert.equal(staged.manifest.auxiliaryEntries.some(({ kind }) => kind === "drop-in"), true);
      assert.equal(existsSync(join(root, ".agentos-deploy/launchd/manifest.json")), true);
      const stableWrapper = join(root, "shared/bin/agentos-service-wrapper.mjs");
      const wrapperBeforeRoot = statSync(stableWrapper);
      assert.throws(
        () => installStagedSystemdServices({
          repositoryRoot: root,
          unitDirectory,
          sudoersPath,
          systemctlPath: "/usr/bin/false",
          effectiveUid: 0,
          execute: (_command, args) => {
            if (args[0] === "-c") return "";
            throw new Error("recorder refusal");
          },
          serviceUser: "anneal-test",
          userLookup: accountLookup,
          visudoPath: "/usr/bin/true",
        }),
        /systemd-control-failed:daemon-reload/u,
      );
      // The recorder test runs without root; make the root-owned production
      // mode writable again before exercising the successful retry.
      chmodSync(sudoersPath, 0o600);
      const cli = spawnServiceInstallerCli({
        root,
        args: ["--install-units", "--service-user", "anneal-test"],
        context: {
        repositoryRoot: root,
        unitDirectory,
        sudoersPath,
        systemctlPath: "/usr/bin/true",
        effectiveUid: 0,
        visudoPath: "/usr/bin/true",
        },
      });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(cli.stdout, `APPLY platform=linux\nAPPLY unit-directory=${unitDirectory}\nAPPLY units=${SERVICE_LABELS.length}\nAPPLY staging=${staged.staging}\n`);
      const calls = cli.records.filter(({ operation }) => operation === "execute").map(({ args }) => args);
      const ownership = cli.records.filter(({ operation }) => operation === "chown");
      const wrapperAfterRoot = statSync(stableWrapper);
      assert.equal(wrapperAfterRoot.ino, wrapperBeforeRoot.ino);
      assert.equal(wrapperAfterRoot.mtimeMs, wrapperBeforeRoot.mtimeMs);
      const systemctlCalls = calls.filter((args) => args[0] !== "-c");
      assert.deepEqual(systemctlCalls, [
        ["daemon-reload"],
        ...SERVICE_LABELS.map((label) => ["enable", "--now", `${label}.service`]),
      ]);
      const installedTargets = [
        ...staged.manifest.entries.filter(({ kind }) => kind !== "wrapper"),
        ...staged.manifest.auxiliaryEntries,
      ];
      for (const entry of installedTargets) {
        assert.equal(existsSync(entry.path), true, entry.path);
        assert.equal(statSync(entry.path).mode & 0o777, entry.kind === "sudoers" ? 0o440 : 0o644, entry.path);
        assert.equal(ownership.some((change) => change.path === entry.path && change.uid === 0 && change.gid === 0), true, entry.path);
      }
      const sudoers = readFileSync(sudoersPath, "utf8");
      assert.equal(sudoers, renderSystemdSudoers({ serviceUser: "anneal-test", inventory: DEFAULT_INVENTORY }));
      assert.match(sudoers, /systemctl show -p ExecStart --value com\.agentos\.api\.service/u);
      assert.doesNotMatch(sudoers, /\b(?:enable|disable|daemon-reload)\b/u);
      const sudo = writeSudoPolicyStub(root);
      const executePolicy = (args) => spawnSync(sudo, ["-n", "/bin/systemctl", ...args], {
        encoding: "utf8",
        env: { ...process.env, SUDOERS_POLICY: sudoersPath },
      });
      for (const label of SERVICE_LABELS) {
        const unit = `${label}.service`;
        assert.equal(executePolicy(["restart", unit]).status, 0, unit);
        assert.equal(executePolicy(["show", "-p", "ExecStart", "--value", unit]).status, 0, unit);
        assert.equal(executePolicy(["is-active", unit]).status, 0, unit);
        assert.equal(executePolicy(["enable", unit]).status, 1, unit);
      }
      assert.equal(executePolicy(["daemon-reload"]).status, 1);
      assert.equal(executePolicy(["restart", "com.agentos.unknown.service"]).status, 1);
      assert.equal(executePolicy(["show", "-p", "ExecStart", "--value", "com.agentos.unknown.service"]).status, 1);
      assert.equal(executePolicy(["is-active", "com.agentos.unknown.service"]).status, 1);

      const apiUnit = join(unitDirectory, "com.agentos.api.service");
      const installedApi = readFileSync(apiUnit, "utf8");
      writeFileSync(apiUnit, "operator mutation\n");
      const callsBeforeDrift = calls.length;
      const execute = (_command, args) => { calls.push(args); return ""; };
      assert.throws(
        () => installStagedSystemdServices({
          repositoryRoot: root,
          unitDirectory,
          sudoersPath,
          systemctlPath: "/usr/bin/true",
          effectiveUid: 0,
          execute,
          revert: true,
          serviceUser: "anneal-test",
          userLookup: accountLookup,
          visudoPath: "/usr/bin/true",
        }),
        /systemd-service-definition-drift/u,
      );
      assert.equal(calls.length, callsBeforeDrift);
      assert.equal(readFileSync(apiUnit, "utf8"), "operator mutation\n");
      writeFileSync(apiUnit, installedApi);
      const wrapperPath = join(root, "shared/bin/agentos-service-wrapper.mjs");
      rmSync(wrapperPath);
      const manifestPath = join(root, ".agentos-deploy/launchd/manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.wrapperReverted = true;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const reverted = installStagedSystemdServices({
        repositoryRoot: root,
        unitDirectory,
        sudoersPath,
        systemctlPath: "/usr/bin/true",
        effectiveUid: 0,
        execute,
        revert: true,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        visudoPath: "/usr/bin/true",
      });
      assert.deepEqual([reverted.phase, reverted.applied], ["REVERT", true]);
      assert.equal(reverted.platform, "linux");
      assert.equal(existsSync(join(unitDirectory, "com.agentos.api.service")), false);
      assert.equal(existsSync(join(unitDirectory, "com.agentos.api.service.d")), false);
      assert.equal(existsSync(join(unitDirectory, ".anneal-service-transaction.json")), false);
      assert.deepEqual(
        calls.filter((args) => args[0] !== "-c").slice(-(SERVICE_LABELS.length + 1)),
        [
          ...SERVICE_LABELS.map((label) => ["disable", "--now", `${label}.service`]),
          ["daemon-reload"],
        ],
      );
      assert.deepEqual(calls.at(-1), ["daemon-reload"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("systemd install privilege and service-account boundaries are explicit", async () => {
  await withLinux(() => {
    assert.throws(
      () => installStagedSystemdServices({ effectiveUid: 1000 }),
      /systemd-installer-requires-root/u,
    );
    assert.throws(
      () => installLaunchdServices({ repositoryRoot: process.cwd(), serviceUser: "root", userLookup: accountLookup }),
      /systemd-service-user-root/u,
    );
    assert.throws(
      () => installLaunchdServices({ repositoryRoot: process.cwd(), serviceUser: "missing", userLookup: () => "" }),
      /systemd-service-user-unknown:missing/u,
    );
  });
});

test("privileged service install rejects tampered paths, symlinks, units, and sudoers", async () => {
  await withLinux(() => {
    const variants = ["target", "staged", "backup", "backup-symlink", "cleanup", "symlink", "root-unit", "sudoers"];
    for (const variant of variants) {
      const root = mkdtempSync(join(tmpdir(), `agentos-systemd-tamper-${variant}-`));
      const unitDirectory = join(root, "etc/systemd/system");
      const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
      try {
        if (variant === "backup-symlink") {
          mkdirSync(unitDirectory, { recursive: true });
          writeFileSync(join(unitDirectory, "com.agentos.api.service"), "previous definition\n");
        }
        const staged = installLaunchdServices({
          repositoryRoot: root,
          serviceUser: "anneal-test",
          userLookup: accountLookup,
          nodeBinary: process.execPath,
          gitBinary: process.execPath,
          unitDirectory,
          sudoersPath,
          visudoPath: "/usr/bin/true",
          effectiveUid: 501,
          replaceExisting: variant === "backup-symlink",
          apply: true,
        });
        const manifest = JSON.parse(readFileSync(staged.manifestPath, "utf8"));
        if (variant === "target") manifest.entries[1].path = join(root, "outside-target");
        if (variant === "staged") manifest.entries[1].stagedPath = join(root, "outside-staged");
        if (variant === "backup") {
          manifest.entries[1].existed = true;
          manifest.entries[1].backupPath = join(root, "outside-backup");
        }
        if (variant === "backup-symlink") {
          const entry = manifest.entries[1];
          const contents = readFileSync(entry.backupPath);
          rmSync(entry.backupPath);
          const real = `${entry.backupPath}.real`;
          writeFileSync(real, contents);
          symlinkSync(real, entry.backupPath);
        }
        if (variant === "cleanup") manifest.stagingRoot = join(root, "outside-cleanup");
        if (variant === "symlink") {
          const target = manifest.entries[1].stagedPath;
          const contents = readFileSync(target);
          rmSync(target);
          const real = `${target}.real`;
          writeFileSync(real, contents);
          symlinkSync(real, target);
        }
        if (variant === "root-unit") {
          const entry = manifest.entries[1];
          const contents = readFileSync(entry.stagedPath, "utf8").replace("User=anneal-test", "User=root");
          writeFileSync(entry.stagedPath, contents);
          entry.installedSha256 = digest(contents);
        }
        if (variant === "sudoers") {
          const entry = manifest.auxiliaryEntries.find(({ kind }) => kind === "sudoers");
          const contents = `${readFileSync(entry.stagedPath, "utf8").trim()}, /bin/systemctl daemon-reload\n`;
          chmodSync(entry.stagedPath, 0o600);
          writeFileSync(entry.stagedPath, contents);
          entry.installedSha256 = digest(contents);
        }
        writeFileSync(staged.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        assert.throws(() => installStagedSystemdServices({
          repositoryRoot: root,
          unitDirectory,
          sudoersPath,
          systemctlPath: "/usr/bin/true",
          visudoPath: "/usr/bin/true",
          effectiveUid: 0,
          serviceUser: "anneal-test",
          userLookup: accountLookup,
          execute: () => "",
        }), /systemd-(?:service-manifest-invalid|target-outside-directory|symlink-refused|staged-unit-invalid|staged-sudoers-invalid)/u, variant);
        assert.equal(existsSync(join(root, "outside-target")), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

test("replace-existing restores unit bytes, mode, and enabled/active state", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-replace-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const apiUnit = join(unitDirectory, "com.agentos.api.service");
    mkdirSync(unitDirectory, { recursive: true });
    writeFileSync(apiUnit, "operator-owned definition\n", { mode: 0o600 });
    const stageExecute = (_command, args) => {
      if (args[0] === "is-enabled") return args[1] === "com.agentos.api.service" ? "enabled\n" : "disabled\n";
      if (args[0] === "is-active") return args[1] === "com.agentos.api.service" ? "active\n" : "inactive\n";
      return "";
    };
    try {
      const staged = installLaunchdServices({
        repositoryRoot: root,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        unitDirectory,
        sudoersPath,
        systemctlPath: "/usr/bin/true",
        visudoPath: "/usr/bin/true",
        execute: stageExecute,
        replaceExisting: true,
        effectiveUid: 501,
        apply: true,
      });
      const calls = [];
      const execute = (_command, args) => {
        calls.push(args);
        if (args[0] === "is-enabled" && args[1] === "com.agentos.api.service") return "enabled\n";
        if (args[0] === "is-active" && args[1] === "com.agentos.api.service") return "active\n";
        return "";
      };
      installLaunchdServices({
        repositoryRoot: root, serviceUser: "anneal-test", userLookup: accountLookup,
        unitDirectory, sudoersPath, systemctlPath: "/usr/bin/true", visudoPath: "/usr/bin/true",
        execute, effectiveUid: 0, installUnits: true,
      });
      assert.notEqual(readFileSync(apiUnit, "utf8"), "operator-owned definition\n");
      installLaunchdServices({
        repositoryRoot: root, serviceUser: "anneal-test", userLookup: accountLookup,
        unitDirectory, sudoersPath, execute, effectiveUid: 501, revert: true, apply: true,
      });
      installLaunchdServices({
        repositoryRoot: root, serviceUser: "anneal-test", userLookup: accountLookup,
        unitDirectory, sudoersPath, systemctlPath: "/usr/bin/true", execute,
        effectiveUid: 0, installUnits: true, revert: true,
      });
      assert.equal(readFileSync(apiUnit, "utf8"), "operator-owned definition\n");
      assert.equal(statSync(apiUnit).mode & 0o777, 0o600);
      assert.equal(calls.some((args) => args.join(" ") === "enable com.agentos.api.service"), true);
      assert.equal(calls.some((args) => args.join(" ") === "start com.agentos.api.service"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("systemd upgrade binds an installed wrapper update to the previous manifest digest", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-wrapper-upgrade-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const common = {
      repositoryRoot: root,
      serviceUser: "anneal-test",
      userLookup: accountLookup,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      unitDirectory,
      sudoersPath,
      systemctlPath: "/usr/bin/true",
      visudoPath: "/usr/bin/true",
      execute: () => "",
    };
    try {
      const initial = installLaunchdServices({ ...common, effectiveUid: 501, apply: true });
      installStagedSystemdServices({ ...common, effectiveUid: 0 });
      const manifest = JSON.parse(readFileSync(initial.manifestPath, "utf8"));
      const wrapperEntry = manifest.entries[0];
      const oldWrapper = "previous wrapper artifact\n";
      writeFileSync(wrapperEntry.path, oldWrapper);
      writeFileSync(wrapperEntry.stagedPath, oldWrapper);
      wrapperEntry.installedSha256 = digest(oldWrapper);
      writeFileSync(initial.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const transactionPath = join(unitDirectory, ".anneal-service-transaction.json");
      const transaction = JSON.parse(readFileSync(transactionPath, "utf8"));
      transaction.fingerprint = systemdManifestFingerprint(manifest);
      writeFileSync(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);

      const upgrade = installLaunchdServices({ ...common, effectiveUid: 501, apply: true });
      assert.equal(upgrade.manifest.entries[0].previousInstalledSha256, digest(oldWrapper));
      assert.notEqual(readFileSync(wrapperEntry.path, "utf8"), oldWrapper);
      chmodSync(sudoersPath, 0o600);
      installStagedSystemdServices({ ...common, effectiveUid: 0 });
      const completed = JSON.parse(readFileSync(initial.manifestPath, "utf8"));
      assert.equal(completed.entries[0].previousInstalledSha256, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a count of sixteen produces twenty-entry service manifests on both platforms", () => {
  const source = String.raw`
    import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { installLaunchdServices } from "./scripts/deploy/install-launchd.mjs";
    const roots = [mkdtempSync(join(tmpdir(), "agentos-linux-16-")), mkdtempSync(join(tmpdir(), "agentos-darwin-16-"))];
    try {
      process.env.AGENTOS_SERVICE_PLATFORM = "linux";
      const linux = installLaunchdServices({
        repositoryRoot: roots[0], serviceUser: "anneal-test", userLookup: () => "anneal-test:x:620:620::/tmp:/bin/bash",
        nodeBinary: process.execPath, gitBinary: process.execPath, visudoPath: "/usr/bin/true", effectiveUid: 501, apply: true,
        unitDirectory: join(roots[0], "etc/systemd/system"), sudoersPath: join(roots[0], "etc/sudoers.d/anneal-service-control"),
      });
      process.env.AGENTOS_SERVICE_PLATFORM = "darwin";
      mkdirSync(join(roots[1], "shared"), { recursive: true });
      writeFileSync(join(roots[1], "shared/.env"), "DATABASE_URL=configured\n");
      mkdirSync(join(roots[1], "releases/release-1"), { recursive: true });
      symlinkSync("releases/release-1", join(roots[1], "current"));
      const darwin = installLaunchdServices({
        repositoryRoot: roots[1], userHome: join(roots[1], "home"), nodeBinary: process.execPath,
        gitBinary: process.execPath, effectiveUid: 501, apply: true,
      });
      const linuxManifest = JSON.parse(readFileSync(linux.manifestPath, "utf8"));
      const darwinManifest = JSON.parse(readFileSync(join(roots[1], ".agentos-deploy/launchd/manifest.json"), "utf8"));
      const countPersisted = linuxManifest.entries.filter((entry) => entry.kind === "service")
        .every((entry) => readFileSync(entry.stagedPath, "utf8").includes('Environment=AGENTOS_RUNNER_COUNT="16"'));
      delete process.env.AGENTOS_RUNNER_COUNT;
      process.env.AGENTOS_SERVICE_PLATFORM = "linux";
      const calls = [];
      const installed = installLaunchdServices({
        repositoryRoot: roots[0], serviceUser: "anneal-test", userLookup: () => "anneal-test:x:620:620::/tmp:/bin/bash",
        installUnits: true, apply: false, effectiveUid: 0,
        unitDirectory: join(roots[0], "etc/systemd/system"), sudoersPath: join(roots[0], "etc/sudoers.d/anneal-service-control"),
        systemctlPath: "/usr/bin/true", visudoPath: "/usr/bin/true", execute: (_command, args) => { calls.push(args); return ""; },
      });
      console.log(JSON.stringify({ linux: linuxManifest.entries.length, darwin: darwinManifest.entries.length, linuxResult: linux.entries.length, darwinResult: darwin.entries.length, installedUnits: installed.units.length, countPersisted, enabled: calls.filter((args) => args[0] === "enable").length }));
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env: { ...process.env, AGENTOS_RUNNER_COUNT: "16", AGENTOS_SERVICE_PLATFORM: "linux" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { linux: 20, darwin: 20, linuxResult: 20, darwinResult: 20, installedUnits: 19, countPersisted: true, enabled: 19 });
});

test("runner prefix is rendered, recorded, and checked before privileged installation", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-prefix-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    try {
      const environment = { AGENTOS_RUNNER_ID_PREFIX: "vm-" };
      const staged = installLaunchdServices({
        repositoryRoot: root,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        unitDirectory,
        sudoersPath,
        visudoPath: "/usr/bin/true",
        effectiveUid: 501,
        environment,
        apply: true,
      });
      assert.equal(staged.manifest.renderInputs.runnerIdPrefix, "vm-");
      assert.deepEqual(
        readFileSync(staged.manifest.entries[0].stagedPath),
        readFileSync(new URL("./launchd-service-wrapper.mjs", import.meta.url)),
      );
      for (const entry of staged.manifest.entries.filter(({ label }) => label?.startsWith("com.agentos.runner"))) {
        assert.match(readFileSync(entry.stagedPath, "utf8"), /^Environment=RUNNER_ID="vm-runner-\d+"$/mu);
      }
      const calls = [];
      assert.throws(() => installStagedSystemdServices({
        repositoryRoot: root,
        unitDirectory,
        sudoersPath,
        systemctlPath: "/usr/bin/true",
        visudoPath: "/usr/bin/true",
        effectiveUid: 0,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        environment: { AGENTOS_RUNNER_ID_PREFIX: "other-" },
        execute: (_command, args) => { calls.push(args); return ""; },
      }), /systemd-runner-id-prefix-manifest-mismatch/u);
      assert.deepEqual(calls, []);
      assert.equal(existsSync(join(unitDirectory, "com.agentos.runner.service")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("runner role stages only runner units and stage two enforces the recorded role", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-runner-role-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const environment = {
      AGENTOS_DEPLOY_ROLE: "runner",
      AGENTOS_RUNNER_COUNT: "3",
      AGENTOS_RUNNER_ID_PREFIX: "mac-",
    };
    try {
      const staged = installLaunchdServices({
        repositoryRoot: root,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        unitDirectory,
        sudoersPath,
        visudoPath: "/usr/bin/true",
        environment,
        effectiveUid: 501,
        apply: true,
      });
      const labels = staged.manifest.entries.filter(({ kind }) => kind === "service").map(({ label }) => label);
      assert.deepEqual(labels, ["com.agentos.runner", "com.agentos.runner-2", "com.agentos.runner-3"]);
      assert.equal(staged.manifest.renderInputs.deployRole, "runner");
      assert.equal(labels.some((label) => ["com.agentos.api", "com.agentos.inbox", "com.agentos.web"].includes(label)), false);
      assert.match(readFileSync(staged.manifest.auxiliaryEntries.find(({ kind }) => kind === "sudoers").stagedPath, "utf8"), /com\.agentos\.runner\.service/u);

      const calls = [];
      assert.throws(() => installStagedSystemdServices({
        repositoryRoot: root,
        unitDirectory,
        sudoersPath,
        systemctlPath: "/usr/bin/true",
        visudoPath: "/usr/bin/true",
        effectiveUid: 0,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        environment: { ...environment, AGENTOS_DEPLOY_ROLE: "control-plane" },
        execute: (_command, args) => { calls.push(args); return ""; },
      }), /systemd-deploy-role-manifest-mismatch/u);
      assert.deepEqual(calls, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("invalid runner prefix fails before installer files are written", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-prefix-invalid-"));
    try {
      assert.throws(() => installLaunchdServices({
        repositoryRoot: root,
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        environment: { AGENTOS_RUNNER_ID_PREFIX: "invalid/prefix" },
        effectiveUid: 501,
        apply: true,
      }), /runner-id-prefix-invalid:invalid\/prefix/u);
      assert.equal(existsSync(join(root, ".agentos-deploy")), false);
      assert.equal(existsSync(join(root, "shared")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("Darwin records and renders the configured runner prefix", () => {
  const previousPlatform = process.env.AGENTOS_SERVICE_PLATFORM;
  process.env.AGENTOS_SERVICE_PLATFORM = "darwin";
  const root = mkdtempSync(join(tmpdir(), "agentos-launchd-prefix-"));
  try {
    mkdirSync(join(root, "shared"), { recursive: true });
    writeFileSync(join(root, "shared/.env"), "DATABASE_URL=configured\n");
    mkdirSync(join(root, "releases/release-1"), { recursive: true });
    symlinkSync("releases/release-1", join(root, "current"));
    installLaunchdServices({
      repositoryRoot: root,
      userHome: join(root, "home"),
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      effectiveUid: 501,
      environment: { AGENTOS_RUNNER_ID_PREFIX: "vm-" },
      apply: true,
    });
    const manifest = JSON.parse(readFileSync(join(root, ".agentos-deploy/launchd/manifest.json"), "utf8"));
    assert.equal(manifest.renderInputs.runnerIdPrefix, "vm-");
    assert.deepEqual(
      readFileSync(manifest.entries[0].path),
      readFileSync(new URL("./launchd-service-wrapper.mjs", import.meta.url)),
    );
    assert.match(
      readFileSync(join(root, "home/Library/LaunchAgents/com.agentos.runner.plist"), "utf8"),
      /<key>RUNNER_ID<\/key>\s*<string>vm-runner-1<\/string>/u,
    );
  } finally {
    if (previousPlatform === undefined) delete process.env.AGENTOS_SERVICE_PLATFORM;
    else process.env.AGENTOS_SERVICE_PLATFORM = previousPlatform;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin retries pending wrapper upgrades and partial grows", () => {
  const previousPlatform = process.env.AGENTOS_SERVICE_PLATFORM;
  process.env.AGENTOS_SERVICE_PLATFORM = "darwin";
  const root = mkdtempSync(join(tmpdir(), "agentos-launchd-pending-install-"));
  const home = join(root, "home");
  const manifestPath = join(root, ".agentos-deploy/launchd/manifest.json");
  try {
    mkdirSync(join(root, "shared"), { recursive: true });
    writeFileSync(join(root, "shared/.env"), "DATABASE_URL=configured\n");
    mkdirSync(join(root, "releases/release-1"), { recursive: true });
    symlinkSync("releases/release-1", join(root, "current"));
    const common = {
      repositoryRoot: root,
      userHome: home,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      effectiveUid: 501,
      apply: true,
    };
    installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "12" } });
    const wrapperSource = readFileSync(new URL("./launchd-service-wrapper.mjs", import.meta.url));
    const pendingWrapper = JSON.parse(readFileSync(manifestPath, "utf8"));
    const wrapperEntry = pendingWrapper.entries[0];
    const oldWrapper = "previous wrapper artifact\n";
    writeFileSync(wrapperEntry.path, oldWrapper);
    wrapperEntry.previousInstalledSha256 = digest(oldWrapper);
    wrapperEntry.pendingInstall = true;
    writeFileSync(manifestPath, `${JSON.stringify(pendingWrapper, null, 2)}\n`);

    installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "12" } });
    assert.deepEqual(readFileSync(wrapperEntry.path), wrapperSource);
    let completed = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(completed.entries[0].previousInstalledSha256, undefined);
    assert.equal(completed.entries[0].pendingInstall, undefined);

    installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" } });
    completed = JSON.parse(readFileSync(manifestPath, "utf8"));
    const runner13 = completed.entries.find(({ path }) => path.endsWith("/com.agentos.runner-13.plist"));
    rmSync(runner13.path);
    runner13.pendingInstall = true;
    writeFileSync(manifestPath, `${JSON.stringify(completed, null, 2)}\n`);
    installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" } });
    assert.equal(existsSync(runner13.path), true);
    completed = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(completed.entries.find(({ path }) => path === runner13.path).pendingInstall, undefined);
  } finally {
    if (previousPlatform === undefined) delete process.env.AGENTOS_SERVICE_PLATFORM;
    else process.env.AGENTOS_SERVICE_PLATFORM = previousPlatform;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner inventory shrinks and grows without touching surviving units on both platforms", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-resize-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const calls = [];
    const execute = (_command, args) => {
      calls.push(args);
      if (args[0] === "is-enabled") return "enabled\n";
      if (args[0] === "is-active") return "active\n";
      if (args[0] === "show") return "not-found\n";
      return "";
    };
    const common = {
      repositoryRoot: root,
      serviceUser: "anneal-test",
      userLookup: accountLookup,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      unitDirectory,
      sudoersPath,
      systemctlPath: "/usr/bin/true",
      visudoPath: "/usr/bin/true",
      execute,
    };
    try {
      installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, effectiveUid: 501, apply: true });
      installStagedSystemdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, effectiveUid: 0 });
      const survivor = join(unitDirectory, "com.agentos.runner-12.service");
      const survivorBefore = { contents: readFileSync(survivor), mtimeMs: statSync(survivor).mtimeMs };
      calls.length = 0;
      installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "12" }, effectiveUid: 501, apply: true });
      chmodSync(sudoersPath, 0o600);
      installStagedSystemdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "12" }, effectiveUid: 0 });
      assert.deepEqual(calls.filter(([verb]) => verb === "disable"), [13, 14, 15, 16].map((index) => ["disable", "--now", `com.agentos.runner-${index}.service`]));
      assert.equal(calls.some(([verb]) => verb === "enable"), false);
      for (const index of [13, 14, 15, 16]) assert.equal(existsSync(join(unitDirectory, `com.agentos.runner-${index}.service`)), false);
      assert.deepEqual(readFileSync(survivor), survivorBefore.contents);
      assert.equal(statSync(survivor).mtimeMs, survivorBefore.mtimeMs);
      const shrunk = JSON.parse(readFileSync(join(root, ".agentos-deploy/launchd/manifest.json"), "utf8"));
      assert.equal(shrunk.entries.some(({ label }) => label === "com.agentos.runner-13"), false);
      calls.length = 0;
      installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, effectiveUid: 501, apply: true });
      chmodSync(sudoersPath, 0o600);
      installStagedSystemdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, effectiveUid: 0 });
      assert.deepEqual(calls.filter(([verb]) => verb === "enable"), [13, 14, 15, 16].map((index) => ["enable", "--now", `com.agentos.runner-${index}.service`]));
      assert.deepEqual(readFileSync(survivor), survivorBefore.contents);
      assert.equal(statSync(survivor).mtimeMs, survivorBefore.mtimeMs);
      const grown = JSON.parse(readFileSync(join(root, ".agentos-deploy/launchd/manifest.json"), "utf8"));
      for (const index of [13, 14, 15, 16]) {
        const path = join(unitDirectory, `com.agentos.runner-${index}.service`);
        assert.equal(existsSync(path), true);
        assert.equal(grown.entries.some((entry) => entry.path === path), true);
      }
      installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, effectiveUid: 501, revert: true, apply: true });
      installStagedSystemdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, effectiveUid: 0, revert: true });
      assert.equal(existsSync(join(root, "shared/bin/agentos-service-wrapper.mjs")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const previousPlatform = process.env.AGENTOS_SERVICE_PLATFORM;
  process.env.AGENTOS_SERVICE_PLATFORM = "darwin";
  const root = mkdtempSync(join(tmpdir(), "agentos-launchd-resize-"));
  const home = join(root, "home");
  try {
    mkdirSync(join(root, "shared"), { recursive: true });
    writeFileSync(join(root, "shared/.env"), "DATABASE_URL=configured\n");
    mkdirSync(join(root, "releases/release-1"), { recursive: true });
    symlinkSync("releases/release-1", join(root, "current"));
    const common = { repositoryRoot: root, userHome: home, nodeBinary: process.execPath, gitBinary: process.execPath, effectiveUid: 501, apply: true };
    installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" } });
    const survivor = join(home, "Library/LaunchAgents/com.agentos.runner-12.plist");
    const survivorBefore = { contents: readFileSync(survivor), mtimeMs: statSync(survivor).mtimeMs };
    const calls = [];
    const unloaded = new Set();
    const execute = (_command, args) => {
      calls.push(args);
      if (args[0] === "bootout") unloaded.add(args[1]);
      if (args[0] === "print" && unloaded.has(args[1])) throw launchdNotFound();
      return "";
    };
    installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "12" }, execute });
    assert.deepEqual(calls, [13, 14, 15, 16].flatMap((index) => [
      ["print", `gui/501/com.agentos.runner-${index}`],
      ["bootout", `gui/501/com.agentos.runner-${index}`],
      ["print", `gui/501/com.agentos.runner-${index}`],
    ]));
    for (const index of [13, 14, 15, 16]) assert.equal(existsSync(join(home, `Library/LaunchAgents/com.agentos.runner-${index}.plist`)), false);
    assert.deepEqual(readFileSync(survivor), survivorBefore.contents);
    assert.equal(statSync(survivor).mtimeMs, survivorBefore.mtimeMs);
    installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" } });
    assert.deepEqual(readFileSync(survivor), survivorBefore.contents);
    assert.equal(statSync(survivor).mtimeMs, survivorBefore.mtimeMs);
    const grown = JSON.parse(readFileSync(join(root, ".agentos-deploy/launchd/manifest.json"), "utf8"));
    for (const index of [13, 14, 15, 16]) {
      const path = join(home, `Library/LaunchAgents/com.agentos.runner-${index}.plist`);
      assert.equal(existsSync(path), true);
      assert.equal(grown.entries.some((entry) => entry.path === path), true);
    }
    installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, revert: true });
    assert.equal(existsSync(join(root, "shared/bin/agentos-service-wrapper.mjs")), false);
  } finally {
    if (previousPlatform === undefined) delete process.env.AGENTOS_SERVICE_PLATFORM;
    else process.env.AGENTOS_SERVICE_PLATFORM = previousPlatform;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a partial shrink leaves each manifest aligned with the units still present", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-partial-shrink-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const common = {
      repositoryRoot: root,
      serviceUser: "anneal-test",
      userLookup: accountLookup,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      unitDirectory,
      sudoersPath,
      systemctlPath: "/usr/bin/true",
      visudoPath: "/usr/bin/true",
    };
    try {
      installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, effectiveUid: 501, apply: true });
      installStagedSystemdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, effectiveUid: 0, execute: () => "" });
      installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "12" }, effectiveUid: 501, apply: true, execute: () => "" });
      chmodSync(sudoersPath, 0o600);
      const manifestPath = join(root, ".agentos-deploy/launchd/manifest.json");
      const manifestStatus = statSync(manifestPath);
      const ownership = [];
      assert.throws(() => installStagedSystemdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "12" },
        effectiveUid: 0,
        chown: (path, uid, gid) => ownership.push({ path, uid, gid }),
        execute: (_command, args) => {
          if (args[0] === "disable" && args[2] === "com.agentos.runner-15.service") throw new Error("stop failed");
          return "";
        },
      }), /systemd-control-failed:disable:com\.agentos\.runner-15\.service/u);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.equal(ownership.some((entry) => entry.path.includes("/.agentos-deploy/launchd/manifest.json.")
        && entry.uid === manifestStatus.uid && entry.gid === manifestStatus.gid), true, JSON.stringify(ownership));
      assert.equal(statSync(manifestPath).uid, manifestStatus.uid);
      assert.equal(statSync(manifestPath).gid, manifestStatus.gid);
      assert.equal(statSync(manifestPath).mode & 0o777, manifestStatus.mode & 0o777);
      assert.deepEqual(manifest.retiredEntries.map(({ unit }) => unit), [
        "com.agentos.runner-15.service",
        "com.agentos.runner-16.service",
      ]);
      for (const index of [13, 14]) assert.equal(existsSync(join(unitDirectory, `com.agentos.runner-${index}.service`)), false);
      for (const index of [15, 16]) assert.equal(existsSync(join(unitDirectory, `com.agentos.runner-${index}.service`)), true);
      installLaunchdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "12" },
        effectiveUid: 501,
        apply: true,
        execute: () => "",
      });
      chmodSync(sudoersPath, 0o600);
      installStagedSystemdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "12" },
        effectiveUid: 0,
        execute: (_command, args) => args[0] === "show" ? "not-found\n" : "",
      });
      const completed = JSON.parse(readFileSync(join(root, ".agentos-deploy/launchd/manifest.json"), "utf8"));
      assert.equal(completed.retiredEntries, undefined);
      for (const index of [13, 14, 15, 16]) {
        assert.equal(existsSync(join(unitDirectory, `com.agentos.runner-${index}.service`)), false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const previousPlatform = process.env.AGENTOS_SERVICE_PLATFORM;
  process.env.AGENTOS_SERVICE_PLATFORM = "darwin";
  const root = mkdtempSync(join(tmpdir(), "agentos-launchd-partial-shrink-"));
  const home = join(root, "home");
  try {
    mkdirSync(join(root, "shared"), { recursive: true });
    writeFileSync(join(root, "shared/.env"), "DATABASE_URL=configured\n");
    mkdirSync(join(root, "releases/release-1"), { recursive: true });
    symlinkSync("releases/release-1", join(root, "current"));
    const common = { repositoryRoot: root, userHome: home, nodeBinary: process.execPath, gitBinary: process.execPath, effectiveUid: 501, apply: true };
    installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" } });
    const unloaded = new Set();
    let failRunner15 = true;
    const execute = (_command, args) => {
      if (args[0] === "print" && unloaded.has(args[1])) throw launchdNotFound();
      if (args[0] === "bootout" && args[1].endsWith("com.agentos.runner-15") && failRunner15) {
        failRunner15 = false;
        throw new Error("stop failed");
      }
      if (args[0] === "bootout") unloaded.add(args[1]);
      return "";
    };
    assert.throws(() => installLaunchdServices({
      ...common,
      environment: { AGENTOS_RUNNER_COUNT: "12" },
      execute,
    }), /launchd-service-removal-failed:com\.agentos\.runner-15/u);
    const manifest = JSON.parse(readFileSync(join(root, ".agentos-deploy/launchd/manifest.json"), "utf8"));
    assert.deepEqual(manifest.retiredEntries.map(({ path }) => path.slice(path.lastIndexOf("/") + 1)), [
      "com.agentos.runner-15.plist",
      "com.agentos.runner-16.plist",
    ]);
    for (const index of [13, 14]) assert.equal(existsSync(join(home, `Library/LaunchAgents/com.agentos.runner-${index}.plist`)), false);
    for (const index of [15, 16]) assert.equal(existsSync(join(home, `Library/LaunchAgents/com.agentos.runner-${index}.plist`)), true);
    installLaunchdServices({
      ...common,
      environment: { AGENTOS_RUNNER_COUNT: "12" },
      execute,
    });
    const completed = JSON.parse(readFileSync(join(root, ".agentos-deploy/launchd/manifest.json"), "utf8"));
    assert.equal(completed.retiredEntries, undefined);
    for (const index of [13, 14, 15, 16]) {
      assert.equal(existsSync(join(home, `Library/LaunchAgents/com.agentos.runner-${index}.plist`)), false);
    }
  } finally {
    if (previousPlatform === undefined) delete process.env.AGENTOS_SERVICE_PLATFORM;
    else process.env.AGENTOS_SERVICE_PLATFORM = previousPlatform;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin normalizes legacy retired entries before another partial shrink", async () => {
  await withServicePlatform("darwin", () => {
    const root = mkdtempSync(join(tmpdir(), "agentos-launchd-legacy-retired-shrink-"));
    const home = join(root, "home");
    const manifestPath = join(root, ".agentos-deploy/launchd/manifest.json");
    try {
      mkdirSync(join(root, "shared"), { recursive: true });
      writeFileSync(join(root, "shared/.env"), "DATABASE_URL=configured\n");
      mkdirSync(join(root, "releases/release-1"), { recursive: true });
      symlinkSync("releases/release-1", join(root, "current"));
      const common = {
        repositoryRoot: root,
        userHome: home,
        nodeBinary: process.execPath,
        gitBinary: process.execPath,
        effectiveUid: 501,
        apply: true,
      };
      installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "3" } });

      let failingLabel = "com.agentos.runner-3";
      const unloaded = new Set();
      const execute = (_command, args) => {
        if (args[0] === "print" && unloaded.has(args[1])) throw launchdNotFound();
        if (failingLabel && args[0] === "bootout" && args[1].endsWith(failingLabel)) throw new Error("stop failed");
        if (args[0] === "bootout") unloaded.add(args[1]);
        return "";
      };
      assert.throws(() => installLaunchdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "2" },
        execute,
      }), /launchd-service-removal-failed:com\.agentos\.runner-3/u);

      const legacyManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      for (const entry of legacyManifest.retiredEntries) delete entry.label;
      writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);

      failingLabel = "com.agentos.runner-2";
      assert.throws(() => installLaunchdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "1" },
        execute,
      }), /launchd-service-removal-failed:com\.agentos\.runner-2/u);
      const normalized = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.equal(normalized.retiredEntries.every((entry) => typeof entry.label === "string"), true);

      failingLabel = null;
      installLaunchdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "1" },
        execute,
      });
      const completed = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.equal(completed.retiredEntries, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("systemd shrink retries daemon-reload after all retired units were removed", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-reload-retry-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const common = {
      repositoryRoot: root,
      serviceUser: "anneal-test",
      userLookup: accountLookup,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      unitDirectory,
      sudoersPath,
      systemctlPath: "/usr/bin/true",
      visudoPath: "/usr/bin/true",
    };
    try {
      installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, effectiveUid: 501, apply: true });
      installStagedSystemdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, effectiveUid: 0, execute: () => "" });
      installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "12" }, effectiveUid: 501, apply: true, execute: () => "" });
      chmodSync(sudoersPath, 0o600);
      assert.throws(() => installStagedSystemdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "12" },
        effectiveUid: 0,
        execute: (_command, args) => {
          if (args[0] === "daemon-reload") throw new Error("reload failed");
          return "";
        },
      }), /systemd-control-failed:daemon-reload/u);
      const pending = JSON.parse(readFileSync(join(root, ".agentos-deploy/launchd/manifest.json"), "utf8"));
      assert.equal(pending.reloadPending, true);
      assert.deepEqual(pending.retiredEntries, []);

      installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "12" }, effectiveUid: 501, apply: true, execute: () => "" });
      chmodSync(sudoersPath, 0o600);
      const retryCalls = [];
      installStagedSystemdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "12" },
        effectiveUid: 0,
        execute: (_command, args) => {
          retryCalls.push(args);
          return args[0] === "show" ? "not-found\n" : "";
        },
      });
      assert.equal(retryCalls.some(([verb]) => verb === "daemon-reload"), true);
      const completed = JSON.parse(readFileSync(join(root, ".agentos-deploy/launchd/manifest.json"), "utf8"));
      assert.equal(completed.reloadPending, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a failed systemd restage leaves the prior manifest and staging revertible", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-restage-failure-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const common = {
      repositoryRoot: root,
      serviceUser: "anneal-test",
      userLookup: accountLookup,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      unitDirectory,
      sudoersPath,
      systemctlPath: "/usr/bin/true",
      visudoPath: "/usr/bin/true",
    };
    const environment = { AGENTOS_RUNNER_COUNT: "12" };
    try {
      const initial = installLaunchdServices({ ...common, environment, effectiveUid: 501, apply: true });
      installStagedSystemdServices({ ...common, environment, effectiveUid: 0, execute: () => "" });
      const originalManifest = readFileSync(initial.manifestPath, "utf8");
      const originalStagedUnit = readFileSync(initial.manifest.entries[1].stagedPath);
      assert.throws(() => installLaunchdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "16" },
        effectiveUid: 501,
        apply: true,
        visudoPath: "/usr/bin/false",
        execute: (_command, args) => {
          if (args[0] === "-c") throw new Error("invalid staged sudoers");
          return "";
        },
      }), /systemd-sudoers-invalid/u);
      assert.equal(readFileSync(initial.manifestPath, "utf8"), originalManifest);
      assert.deepEqual(readFileSync(initial.manifest.entries[1].stagedPath), originalStagedUnit);

      installLaunchdServices({ ...common, environment, effectiveUid: 501, revert: true, apply: true, execute: () => "" });
      installStagedSystemdServices({ ...common, environment, effectiveUid: 0, revert: true, execute: () => "" });
      assert.equal(existsSync(join(root, "shared/bin/agentos-service-wrapper.mjs")), false);
      assert.equal(existsSync(initial.manifestPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("Darwin shrink distinguishes unloaded services from query and bootout failures", () => {
  const previousPlatform = process.env.AGENTOS_SERVICE_PLATFORM;
  process.env.AGENTOS_SERVICE_PLATFORM = "darwin";
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "agentos-launchd-query-"));
    const home = join(root, "home");
    mkdirSync(join(root, "shared"), { recursive: true });
    writeFileSync(join(root, "shared/.env"), "DATABASE_URL=configured\n");
    mkdirSync(join(root, "releases/release-1"), { recursive: true });
    symlinkSync("releases/release-1", join(root, "current"));
    const common = { repositoryRoot: root, userHome: home, nodeBinary: process.execPath, gitBinary: process.execPath, effectiveUid: 501, apply: true };
    installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" } });
    return { root, home, common };
  };
  try {
    const unloaded = fixture();
    try {
      const calls = [];
      installLaunchdServices({
        ...unloaded.common,
        environment: { AGENTOS_RUNNER_COUNT: "12" },
        execute: (_command, args) => { calls.push(args); throw launchdNotFound(); },
      });
      assert.equal(calls.every(([verb]) => verb === "print"), true);
      for (const index of [13, 14, 15, 16]) {
        assert.equal(existsSync(join(unloaded.home, `Library/LaunchAgents/com.agentos.runner-${index}.plist`)), false);
      }
    } finally {
      rmSync(unloaded.root, { recursive: true, force: true });
    }

    for (const failure of ["query", "bootout", "post-query"]) {
      const current = fixture();
      try {
        let queryCount = 0;
        assert.throws(() => installLaunchdServices({
          ...current.common,
          environment: { AGENTOS_RUNNER_COUNT: "12" },
          execute: (_command, args) => {
            if (args[0] === "print") queryCount += 1;
            if ((failure === "query" && args[0] === "print")
                || (failure === "post-query" && args[0] === "print" && queryCount === 2)) {
              const error = new Error("permission denied");
              error.status = 1;
              error.stderr = "permission denied";
              throw error;
            }
            if (failure === "bootout" && args[0] === "bootout") throw new Error("bootout failed");
            return "";
          },
        }), failure === "query" || failure === "post-query"
          ? /launchd-service-query-failed:com\.agentos\.runner-13/u
          : /launchd-service-removal-failed:com\.agentos\.runner-13/u);
        assert.equal(existsSync(join(current.home, "Library/LaunchAgents/com.agentos.runner-13.plist")), true);
      } finally {
        rmSync(current.root, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousPlatform === undefined) delete process.env.AGENTOS_SERVICE_PLATFORM;
    else process.env.AGENTOS_SERVICE_PLATFORM = previousPlatform;
  }
});

test("reinstall rewrites and restarts services when canonical definition inputs change", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-definition-change-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const common = {
      repositoryRoot: root,
      serviceUser: "anneal-test",
      userLookup: accountLookup,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      unitDirectory,
      sudoersPath,
      systemctlPath: "/usr/bin/true",
      visudoPath: "/usr/bin/true",
    };
    try {
      installLaunchdServices({ ...common, path: "/usr/bin:/bin", effectiveUid: 501, apply: true });
      installStagedSystemdServices({ ...common, effectiveUid: 0, execute: () => "" });
      const apiUnit = join(unitDirectory, "com.agentos.api.service");
      const before = readFileSync(apiUnit, "utf8");
      installLaunchdServices({ ...common, path: "/custom/bin:/usr/bin:/bin", effectiveUid: 501, apply: true, execute: () => "" });
      chmodSync(sudoersPath, 0o600);
      const calls = [];
      installStagedSystemdServices({ ...common, effectiveUid: 0, execute: (_command, args) => { calls.push(args); return ""; } });
      assert.notEqual(readFileSync(apiUnit, "utf8"), before);
      assert.match(readFileSync(apiUnit, "utf8"), /Environment=PATH="\/custom\/bin:\/usr\/bin:\/bin"/u);
      assert.deepEqual(calls.filter(([verb]) => verb === "enable"), SERVICE_LABELS.map((label) => ["enable", "--now", `${label}.service`]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const previousPlatform = process.env.AGENTOS_SERVICE_PLATFORM;
  process.env.AGENTOS_SERVICE_PLATFORM = "darwin";
  const root = mkdtempSync(join(tmpdir(), "agentos-launchd-definition-change-"));
  const home = join(root, "home");
  try {
    mkdirSync(join(root, "shared"), { recursive: true });
    writeFileSync(join(root, "shared/.env"), "DATABASE_URL=configured\n");
    mkdirSync(join(root, "releases/release-1"), { recursive: true });
    symlinkSync("releases/release-1", join(root, "current"));
    const common = { repositoryRoot: root, userHome: home, nodeBinary: process.execPath, gitBinary: process.execPath, effectiveUid: 501, apply: true };
    installLaunchdServices({ ...common, path: "/usr/bin:/bin" });
    const apiPlist = join(home, "Library/LaunchAgents/com.agentos.api.plist");
    const before = readFileSync(apiPlist, "utf8");
    assert.throws(() => installLaunchdServices({
      ...common,
      path: "/custom/bin:/usr/bin:/bin",
      execute: (_command, args) => {
        if (args[0] === "kickstart") throw new Error("restart failed");
        return "";
      },
    }), /launchd-service-restart-failed:com\.agentos\.api/u);
    const pendingManifest = JSON.parse(readFileSync(join(root, ".agentos-deploy/launchd/manifest.json"), "utf8"));
    assert.equal(pendingManifest.entries.find(({ path }) => path === apiPlist).previousInstalledSha256, digest(before));
    writeFileSync(apiPlist, before);
    const calls = [];
    installLaunchdServices({ ...common, path: "/custom/bin:/usr/bin:/bin", execute: (_command, args) => { calls.push(args); return ""; } });
    assert.notEqual(readFileSync(apiPlist, "utf8"), before);
    assert.match(readFileSync(apiPlist, "utf8"), /<string>\/custom\/bin:\/usr\/bin:\/bin<\/string>/u);
    assert.deepEqual(calls.filter(([verb]) => verb === "kickstart"), SERVICE_LABELS.map((label) => ["kickstart", "-k", `gui/501/${label}`]));
  } finally {
    if (previousPlatform === undefined) delete process.env.AGENTOS_SERVICE_PLATFORM;
    else process.env.AGENTOS_SERVICE_PLATFORM = previousPlatform;
    rmSync(root, { recursive: true, force: true });
  }
});

test("privileged shrink rejects a retired unit not bound to the previous manifest", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-systemd-retired-tamper-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const common = {
      repositoryRoot: root,
      serviceUser: "anneal-test",
      userLookup: accountLookup,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      unitDirectory,
      sudoersPath,
      systemctlPath: "/usr/bin/true",
      visudoPath: "/usr/bin/true",
    };
    try {
      installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, effectiveUid: 501, apply: true });
      installStagedSystemdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "16" }, effectiveUid: 0, execute: () => "" });
      const staged = installLaunchdServices({ ...common, environment: { AGENTOS_RUNNER_COUNT: "12" }, effectiveUid: 501, apply: true, execute: () => "" });
      const cleanManifest = readFileSync(staged.manifestPath, "utf8");
      const manifest = JSON.parse(readFileSync(staged.manifestPath, "utf8"));
      const originalRetiredEntries = manifest.retiredEntries;
      const roguePath = join(unitDirectory, "com.agentos.rogue.service");
      writeFileSync(roguePath, "operator unit\n");
      manifest.retiredEntries[0] = {
        ...manifest.retiredEntries[0],
        label: "com.agentos.rogue",
        unit: "com.agentos.rogue.service",
        path: roguePath,
        installedSha256: digest("operator unit\n"),
      };
      writeFileSync(staged.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const calls = [];
      assert.throws(() => installStagedSystemdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "12" },
        effectiveUid: 0,
        execute: (_command, args) => { calls.push(args); return ""; },
      }), /systemd-service-manifest-invalid/u);
      assert.equal(readFileSync(roguePath, "utf8"), "operator unit\n");
      assert.deepEqual(calls, []);

      manifest.retiredEntries = originalRetiredEntries.slice(1);
      writeFileSync(staged.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      assert.throws(() => installStagedSystemdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "12" },
        effectiveUid: 0,
        execute: (_command, args) => { calls.push(args); return ""; },
      }), /systemd-service-manifest-invalid/u);
      assert.deepEqual(calls, []);

      const nestedRetiredTamper = JSON.parse(cleanManifest);
      const rogueEntry = {
        kind: "service",
        label: "com.agentos.rogue",
        unit: "com.agentos.rogue.service",
        path: roguePath,
        existed: false,
        installedSha256: digest("operator unit\n"),
      };
      nestedRetiredTamper.previousManifest.retiredEntries = [rogueEntry];
      nestedRetiredTamper.retiredEntries = [...originalRetiredEntries, rogueEntry];
      writeFileSync(staged.manifestPath, `${JSON.stringify(nestedRetiredTamper, null, 2)}\n`);
      assert.throws(() => installStagedSystemdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "12" },
        effectiveUid: 0,
        execute: (_command, args) => { calls.push(args); return ""; },
      }), /systemd-service-manifest-invalid/u);
      assert.equal(readFileSync(roguePath, "utf8"), "operator unit\n");
      assert.deepEqual(calls, []);

      const provenanceTamper = JSON.parse(cleanManifest);
      const survivorEntry = provenanceTamper.entries.find(({ label }) => label === "com.agentos.runner-12");
      writeFileSync(survivorEntry.path, "unprivileged replacement\n");
      survivorEntry.preserved = false;
      survivorEntry.previousInstalledSha256 = digest("unprivileged replacement\n");
      writeFileSync(staged.manifestPath, `${JSON.stringify(provenanceTamper, null, 2)}\n`);
      assert.throws(() => installStagedSystemdServices({
        ...common,
        environment: { AGENTOS_RUNNER_COUNT: "12" },
        effectiveUid: 0,
        execute: (_command, args) => { calls.push(args); return ""; },
      }), /systemd-service-manifest-invalid/u);
      assert.equal(readFileSync(survivorEntry.path, "utf8"), "unprivileged replacement\n");
      assert.deepEqual(calls, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("auto-deploy systemd stage renders a oneshot and timer, enabling only the timer", async () => {
  await withLinux(async () => {
    const root = mkdtempSync(join(tmpdir(), "agentos-auto-systemd-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const sudoersPath = join(root, "etc/sudoers.d/anneal-service-control");
    const options = {
      repositoryRoot: root,
      nodeBinary: "/usr/bin/node",
      gitBinary: "/usr/bin/git",
      npmBinary: "/usr/bin/npm",
      path: "/usr/bin:/bin",
      sourceRemote: "configured-remote",
      backup: { mode: "host", pgDumpBinary: "/usr/bin/pg_dump" },
      serviceUser: "anneal-test",
      userLookup: accountLookup,
      unitDirectory,
      sudoersPath,
      systemctlPath: "/usr/bin/true",
      visudoPath: "/usr/bin/true",
    };
    try {
      const plan = planSystemdAutoDeploy(options);
      assert.equal(plan.entries.length, 2);
      assert.match(plan.definitions.service, /^Type=oneshot$/mu);
      assert.match(renderAutoDeploySystemdTimer(), /^OnBootSec=60$/mu);
      const staged = planSystemdAutoDeploy({ ...options, apply: true });
      const calls = [];
      const ownership = [];
      const execute = (_command, args) => { calls.push(args); return ""; };
      const installCode = installLaunchd(["--install-units", "--service-user", "anneal-test"], {
        ...options,
        manifestPath: staged.manifestPath,
        effectiveUid: 0,
        execute,
        chown: (path, uid, gid) => ownership.push({ path, uid, gid }),
        environment: { AGENTOS_SERVICE_PLATFORM: "linux" },
      });
      assert.equal(installCode, 0);
      assert.deepEqual(calls, [["daemon-reload"], ["enable", "--now", "com.agentos.auto-deploy.timer"]]);
      for (const entry of staged.manifest.entries) {
        assert.equal(existsSync(entry.path), true, entry.path);
        assert.equal(statSync(entry.path).mode & 0o777, 0o644, entry.path);
        assert.equal(ownership.some((change) => change.path === entry.path && change.uid === 0 && change.gid === 0), true, entry.path);
      }
      const planRevertCode = installLaunchd(["--revert", "--service-user", "anneal-test"], {
        ...options,
        manifestPath: staged.manifestPath,
        effectiveUid: 501,
        execute,
        environment: { AGENTOS_SERVICE_PLATFORM: "linux" },
      });
      assert.equal(planRevertCode, 0);
      assert.equal(existsSync(join(unitDirectory, "com.agentos.auto-deploy.service")), true);
      const revertCode = installLaunchd(["--revert", "--apply", "--service-user", "anneal-test"], {
        ...options,
        manifestPath: staged.manifestPath,
        effectiveUid: 0,
        execute,
        environment: { AGENTOS_SERVICE_PLATFORM: "linux" },
      });
      assert.equal(revertCode, 0);
      assert.equal(existsSync(join(unitDirectory, "com.agentos.auto-deploy.service")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("runner role is recorded and rendered into both auto-deploy service formats", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-auto-runner-role-"));
    const unitDirectory = join(root, "etc/systemd/system");
    const options = {
      repositoryRoot: root,
      nodeBinary: "/usr/bin/node",
      gitBinary: "/usr/bin/git",
      npmBinary: "/usr/bin/npm",
      path: "/usr/bin:/bin",
      sourceRemote: "configured-remote",
      backup: null,
      serviceUser: "anneal-test",
      userLookup: accountLookup,
      unitDirectory,
      sudoersPath: join(root, "etc/sudoers.d/anneal-service-control"),
      deployRole: "runner",
      runnerCount: 3,
      runnerIdPrefix: "mac-",
      apply: true,
      effectiveUid: 501,
    };
    try {
      const staged = planSystemdAutoDeploy(options);
      assert.equal(staged.manifest.renderInputs.deployRole, "runner");
      assert.match(staged.manifest.entries[0].stagedPath, /com\.agentos\.auto-deploy\.service$/u);
      assert.match(readFileSync(staged.manifest.entries[0].stagedPath, "utf8"), /^Environment=AGENTOS_DEPLOY_ROLE="runner"$/mu);
      const plist = renderLaunchdPlist(
        readFileSync(new URL("./com.agentos.auto-deploy.plist.in", import.meta.url), "utf8"),
        { ...staged.manifest.renderInputs, repositoryRoot: root, deployScript: "/deploy", stdoutPath: "/out", stderrPath: "/err" },
      );
      assert.match(plist, /<key>AGENTOS_DEPLOY_ROLE<\/key>\s*<string>runner<\/string>/u);
      assert.match(plist, /<key>AGENTOS_RUNNER_COUNT<\/key>\s*<string>3<\/string>/u);
      assert.match(plist, /<key>AGENTOS_RUNNER_ID_PREFIX<\/key>\s*<string>mac-<\/string>/u);

      const calls = [];
      assert.throws(() => installStagedSystemdAutoDeploy({
        ...options,
        deployRole: undefined,
        manifestPath: staged.manifestPath,
        effectiveUid: 0,
        environment: { AGENTOS_DEPLOY_ROLE: "control-plane" },
        execute: (_command, args) => { calls.push(args); return ""; },
      }), /systemd-auto-deploy-deploy-role-manifest-mismatch/u);
      assert.deepEqual(calls, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("runner auto-deploy stage one prints a stage-two command carrying the role", async () => {
  await withLinux(() => {
    const root = mkdtempSync(join(tmpdir(), "agentos-auto-runner-next-"));
    const systemctlPath = join(root, "systemctl");
    writeFileSync(systemctlPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const unitDirectory = join(root, "etc/systemd/system");
    const environment = {
      AGENTOS_SERVICE_PLATFORM: "linux",
      AGENTOS_DEPLOY_ROLE: "runner",
      AGENTOS_RUNNER_COUNT: "3",
      AGENTOS_RUNNER_ID_PREFIX: "mac-",
    };
    const options = {
      repositoryRoot: root,
      nodeBinary: process.execPath,
      gitBinary: process.execPath,
      npmBinary: process.execPath,
      path: "/usr/bin:/bin",
      sourceRemote: "configured-remote",
      serviceUser: "anneal-test",
      userLookup: accountLookup,
      unitDirectory,
      sudoersPath: join(root, "etc/sudoers.d/anneal-service-control"),
      environment,
      effectiveUid: 501,
      systemctlPath,
      execute: () => "",
    };
    const output = [];
    const write = process.stdout.write;
    process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
    try {
      assert.equal(installLaunchd(["--apply", "--service-user", "anneal-test"], options), 0);
    } finally {
      process.stdout.write = write;
    }
    assert.match(output.join(""), /NEXT sudo AGENTOS_DEPLOY_ROLE=runner node .* --install-units/u);

    const unavailableSystemctl = join(root, "systemctl-not-executable");
    writeFileSync(unavailableSystemctl, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const snapshot = () => readdirSync(root, { recursive: true }).sort().map((path) => {
      const absolute = join(root, path);
      const stat = statSync(absolute);
      return [path, stat.mode, stat.isFile() ? readFileSync(absolute, "hex") : null];
    });
    const before = snapshot();
    const rejectedCalls = [];
    assert.throws(() => installLaunchd(["--install-units", "--service-user", "anneal-test"], {
      ...options,
      effectiveUid: 0,
      systemctlPath: unavailableSystemctl,
      execute: (...args) => { rejectedCalls.push(args); return ""; },
      chown: (...args) => { rejectedCalls.push(args); },
    }), { message: "systemd-command-unavailable:systemctl" });
    assert.deepEqual(rejectedCalls, []);
    assert.deepEqual(snapshot(), before);

    const stageTwoCalls = [];
    assert.equal(installLaunchd(["--install-units", "--service-user", "anneal-test"], {
      ...options,
      effectiveUid: 0,
      execute: (_command, args) => { stageTwoCalls.push(args); return ""; },
      chown: () => {},
    }), 0);
    assert.deepEqual(stageTwoCalls, [["daemon-reload"], ["enable", "--now", "com.agentos.auto-deploy.timer"]]);
    rmSync(root, { recursive: true, force: true });
  });
});

test("privileged auto-deploy install rejects tampered targets and root service content", async () => {
  await withLinux(() => {
    for (const variant of ["target", "root-unit"]) {
      const root = mkdtempSync(join(tmpdir(), `agentos-auto-tamper-${variant}-`));
      const unitDirectory = join(root, "etc/systemd/system");
      const options = {
        repositoryRoot: root,
        nodeBinary: "/usr/bin/node",
        gitBinary: "/usr/bin/git",
        npmBinary: "/usr/bin/npm",
        path: "/usr/bin:/bin",
        sourceRemote: "configured-remote",
        backup: { mode: "host", pgDumpBinary: "/usr/bin/pg_dump" },
        serviceUser: "anneal-test",
        userLookup: accountLookup,
        unitDirectory,
        sudoersPath: join(root, "etc/sudoers.d/anneal-service-control"),
        apply: true,
        effectiveUid: 501,
      };
      try {
        const staged = planSystemdAutoDeploy(options);
        const manifest = JSON.parse(readFileSync(staged.manifestPath, "utf8"));
        if (variant === "target") manifest.entries[0].path = join(root, "outside-auto-target");
        else {
          const entry = manifest.entries[0];
          const contents = readFileSync(entry.stagedPath, "utf8").replace("User=anneal-test", "User=root");
          writeFileSync(entry.stagedPath, contents);
          entry.installedSha256 = digest(contents);
        }
        writeFileSync(staged.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        assert.throws(() => installStagedSystemdAutoDeploy({
          repositoryRoot: root,
          manifestPath: staged.manifestPath,
          unitDirectory,
          serviceUser: "anneal-test",
          userLookup: accountLookup,
          systemctlPath: "/usr/bin/true",
          execute: () => "",
          effectiveUid: 0,
        }), /systemd-(?:auto-deploy-manifest-invalid|staged-unit-invalid)/u);
        assert.equal(existsSync(join(root, "outside-auto-target")), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

test("the exported verification and sudoers entry points refuse an inventory the generator did not produce", () => {
  const forged = {
    runnerCount: DEFAULT_INVENTORY.runnerCount,
    runnerIdPrefix: DEFAULT_INVENTORY.runnerIdPrefix,
    deployRole: DEFAULT_INVENTORY.deployRole,
    labels: ["com.agentos.api"],
    entries: [{ label: "com.agentos.api", runnerIndex: null, runnerId: null, unitName: "com.agentos.api.service", plistName: "com.agentos.api.plist" }],
  };
  assert.throws(() => renderSystemdSudoers({ serviceUser: "anneal-test", inventory: forged }), /systemd-service-inventory-invalid/u);
  assert.throws(() => verifySystemdServiceDefinitions({}, forged), /systemd-service-inventory-invalid/u);
});
