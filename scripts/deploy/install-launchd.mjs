#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  chownSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveServicePlatform } from "./service-platform.mjs";
import { SYSTEMCTL_PATH, SYSTEMD_CONTROL_VERBS, systemdControlArgv } from "./service-control.mjs";
import { DEFAULT_DEPLOY_ROLE, resolveDeployRole } from "./deploy-role.mjs";

export { DEFAULT_DEPLOY_ROLE, resolveDeployRole };

import { parseSharedEnvironment, resolveCurrentRelease } from "./launchd-service-wrapper.mjs";
import {
  DEFAULT_RUNNER_COUNT,
  MAX_RUNNER_COUNT,
  SERVICE_WRAPPER_FILE_NAME,
  generateServiceInventory,
  isGeneratedServiceInventory,
  plistNameForLabel,
  resolveRunnerCount,
  resolveRunnerIdPrefix,
  resolveServiceInventory,
  serviceInventoryEntry,
  serviceWrapperPath,
  unitNameForLabel,
} from "./service-inventory.mjs";
import {
  DEPLOY_OPTIONAL_ARTIFACT_PATHS,
  deployReleaseArtifactPaths,
  workspaceDependencyPaths,
} from "./release-artifacts.mjs";
import { assembleReleaseDirectory } from "./release-directory.mjs";
import { activateReleasePointer } from "./release-pointer.mjs";
import { DeployFailure } from "./quiet-window-lib.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "../..");
const TEMPLATE = join(SCRIPT_DIR, "com.agentos.auto-deploy.plist.in");
const LABEL = "com.agentos.auto-deploy";
// The auto-deploy scheduler is installed by this installer but is not a
// service inventory entry, so its names are spelled through the same helpers.
const AUTO_DEPLOY_UNIT = unitNameForLabel(LABEL);
const AUTO_DEPLOY_TIMER = `${LABEL}.timer`;
const SERVICE_TEMPLATE = join(SCRIPT_DIR, "com.agentos.service.plist.in");
const SYSTEMD_SERVICE_TEMPLATE = join(SCRIPT_DIR, "com.agentos.service.unit.in");
const SYSTEMD_AUTO_DEPLOY_TEMPLATE = join(SCRIPT_DIR, "com.agentos.auto-deploy.unit.in");
const SYSTEMD_AUTO_DEPLOY_TIMER_TEMPLATE = join(SCRIPT_DIR, "com.agentos.auto-deploy.timer.in");
const SERVICE_WRAPPER_SOURCE = join(SCRIPT_DIR, "launchd-service-wrapper.mjs");
const SERVICE_INSTALL_ROOT = ".agentos-deploy/launchd";
const AUTO_DEPLOY_INSTALL_ROOT = ".agentos-deploy/launchd-auto-deploy";
const SYSTEMD_UNIT_DIRECTORY = "/etc/systemd/system";
const SYSTEMD_SUDOERS_PATH = "/etc/sudoers.d/anneal-service-control";
const SHARED_RUNTIME_DIRECTORIES = Object.freeze([
  "files",
  "runs",
  "dependency-cache",
  "repo-mirrors",
  "state",
]);

const xml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;

const requiredBinary = (name) => {
  let path;
  try {
    path = execFileSync("/usr/bin/which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error(`required-binary-unavailable:${name}`);
  }
  if (!path.startsWith("/")) throw new Error(`required-binary-not-absolute:${name}`);
  const resolved = realpathSync(path);
  try { accessSync(resolved, fsConstants.X_OK); } catch { throw new Error(`required-binary-not-executable:${name}`); }
  return resolved;
};

const requiredConfiguredBinary = (path, name) => {
  if (!path?.startsWith("/")) throw new Error(`backup-configuration-invalid:${name}-must-be-an-absolute-path`);
  let resolved;
  try { resolved = realpathSync(path); } catch { throw new Error(`backup-configuration-invalid:${name}-missing`); }
  try { accessSync(resolved, fsConstants.X_OK); } catch { throw new Error(`backup-configuration-invalid:${name}-not-executable`); }
  return resolved;
};

export const controlledLaunchdPath = ({ nodeBinary, gitBinary }) =>
  [...new Set([dirname(nodeBinary), dirname(gitBinary), "/usr/local/bin", "/usr/bin", "/bin"])].join(":");

/** The provider CLIs a runner definition must be able to execute. A runner
 * that cannot reach one of these answers `--version` with exit 127 and fails
 * every session it claims for that provider. */
const PROVIDER_CLIS = Object.freeze([
  Object.freeze({ name: "claude", variable: "CLAUDE_BINARY" }),
  Object.freeze({ name: "codex", variable: "CODEX_BINARY" }),
]);

/** Look a bare command name up in the installing user's PATH. */
const providerCliLookup = (environment = process.env, execute = execFileSync) => (name) => {
  try {
    return execute("/usr/bin/which", [name], {
      encoding: "utf8",
      env: { PATH: environment.PATH ?? "" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

/** The executable a provider CLI resolves to, or null when nothing on this
 * host answers for it. A configured absolute path is trusted as written; any
 * other value is a command name searched in the installing user's PATH. */
const resolveProviderCli = ({ configured, name, lookup }) => {
  const candidate = typeof configured === "string" && configured !== "" ? configured : name;
  const found = candidate.startsWith("/") ? candidate : lookup(candidate);
  if (typeof found !== "string" || !found.startsWith("/")) return null;
  let resolved;
  try {
    resolved = realpathSync(found);
    accessSync(resolved, fsConstants.X_OK);
  } catch {
    return null;
  }
  return resolved;
};

/**
 * Decide what a runner definition's `RUNNER_PATH` must be on this host.
 *
 * The wrapper applies `shared/.env` without overriding an inherited value, so
 * a `RUNNER_PATH` written into the plist silently defeats the one an operator
 * configured. When `.env` defines it, the definition leaves it out and the
 * `.env` value reaches the runner. Otherwise the installer renders a value it
 * can prove reaches a configured provider CLI, and refuses when it cannot.
 */
export const resolveRunnerPathPlan = ({
  path,
  sharedValues = {},
  environment = {},
  lookup,
} = {}) => {
  const configured = sharedValues.RUNNER_PATH;
  if (typeof configured === "string" && configured !== "") {
    return Object.freeze({ source: ".env", runnerPath: null });
  }
  const directories = [];
  const missing = [];
  for (const { name, variable } of PROVIDER_CLIS) {
    const binary = resolveProviderCli({
      configured: sharedValues[variable] ?? environment[variable],
      name,
      lookup,
    });
    if (binary) directories.push(dirname(binary));
    else missing.push(name);
  }
  if (directories.length === 0) {
    throw new Error(`runner-provider-cli-unresolved:${missing.join(",")}`);
  }
  return Object.freeze({
    source: "rendered",
    runnerPath: [...new Set([...path.split(":").filter(Boolean), ...directories])].join(":"),
  });
};

export const verifyRenderedToolchain = (values, execute = execFileSync) => {
  const options = {
    env: { PATH: values.path },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  try {
    execute(values.nodeBinary, ["--version"], options);
    execute(values.gitBinary, ["--version"], options);
    execute(values.nodeBinary, [values.npmBinary, "--version"], options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`rendered-toolchain-unexecutable:${detail}`);
  }
};

const optionValue = (args, option) => {
  const indexes = args.flatMap((argument, index) => argument === option ? [index] : []);
  if (indexes.length !== 1 || indexes[0] === args.length - 1 || args[indexes[0] + 1].startsWith("--")) {
    throw new Error(`installer-option-required:${option}`);
  }
  return args[indexes[0] + 1];
};

export const parseInstallerArgs = (args, { deployRole = resolveDeployRole() } = {}) => {
  const applyCount = args.filter((argument) => argument === "--apply").length;
  if (applyCount > 1) throw new Error("installer-option-repeated:--apply");
  const installUnitsCount = args.filter((argument) => argument === "--install-units").length;
  if (installUnitsCount > 1) throw new Error("installer-option-repeated:--install-units");
  const revertCount = args.filter((argument) => argument === "--revert").length;
  if (revertCount > 1) throw new Error("installer-option-repeated:--revert");
  const hasMode = args.includes("--pg-dump-mode");
  const mode = hasMode ? optionValue(args, "--pg-dump-mode") : null;
  const allowed = new Set(["--apply", "--install-units", "--revert", "--pg-dump-mode", "--service-user"]);
  const backup = mode === null ? null : { mode };
  if (mode === "container") {
    allowed.add("--docker-binary");
    allowed.add("--pg-dump-container");
    allowed.add("--container-pg-dump-binary");
    backup.dockerBinary = optionValue(args, "--docker-binary");
    backup.container = optionValue(args, "--pg-dump-container");
    backup.pgDumpBinary = optionValue(args, "--container-pg-dump-binary");
  } else if (mode === "host") {
    allowed.add("--pg-dump-binary");
    backup.pgDumpBinary = optionValue(args, "--pg-dump-binary");
  } else if (mode !== null) {
    throw new Error("backup-configuration-invalid:pg-dump-mode-must-be-host-or-container");
  }
  const serviceUser = args.includes("--service-user") ? optionValue(args, "--service-user") : undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`installer-option-unexpected-value:${argument}`);
    if (!allowed.has(argument)) throw new Error(`installer-option-unknown:${argument}`);
    if (["--apply", "--install-units", "--revert"].includes(argument)) continue;
    index += 1;
  }
  if (mode === null && deployRole !== "runner" && !args.includes("--install-units") && !args.includes("--revert")) {
    throw new Error("backup-configuration-invalid:pg-dump-mode-must-be-host-or-container");
  }
  return {
    apply: applyCount === 1,
    installUnits: installUnitsCount === 1,
    revert: revertCount === 1,
    serviceUser,
    backup,
  };
};

export const verifyBackupConfiguration = (backup, execute = execFileSync) => {
  if (backup.mode === "host") {
    return Object.freeze({ mode: "host", pgDumpBinary: requiredConfiguredBinary(backup.pgDumpBinary, "pg-dump-binary") });
  }
  if (backup.mode !== "container") throw new Error("backup-configuration-invalid:unsupported-mode");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(backup.container ?? "")) {
    throw new Error("backup-configuration-invalid:pg-dump-container-invalid");
  }
  if (!backup.pgDumpBinary?.startsWith("/")) {
    throw new Error("backup-configuration-invalid:container-pg-dump-binary-must-be-an-absolute-path");
  }
  const dockerBinary = requiredConfiguredBinary(backup.dockerBinary, "docker-binary");
  let running;
  try {
    running = execute(dockerBinary, ["inspect", "--type", "container", "--format", "{{.State.Running}}", backup.container], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`backup-container-unavailable:${backup.container}`);
  }
  if (running !== "true") throw new Error(`backup-container-not-running:${backup.container}`);
  try {
    execute(dockerBinary, ["exec", backup.container, "test", "-x", backup.pgDumpBinary], { stdio: "ignore" });
  } catch {
    throw new Error(`backup-container-pg-dump-not-executable:${backup.pgDumpBinary}`);
  }
  return Object.freeze({
    mode: "container",
    dockerBinary,
    container: backup.container,
    pgDumpBinary: backup.pgDumpBinary,
  });
};

const runnerCountEnvironment = (runnerCount) => runnerCount === undefined || runnerCount === DEFAULT_RUNNER_COUNT
  ? {}
  : { AGENTOS_RUNNER_COUNT: String(runnerCount) };

const runnerIdPrefixEnvironment = (runnerIdPrefix) => runnerIdPrefix === undefined || runnerIdPrefix === ""
  ? {}
  : { AGENTOS_RUNNER_ID_PREFIX: runnerIdPrefix };

const deployRoleEnvironment = (deployRole) => deployRole === undefined || deployRole === DEFAULT_DEPLOY_ROLE
  ? {}
  : { AGENTOS_DEPLOY_ROLE: deployRole };

const autoDeployRuntimeEnvironment = (backup, runnerCount, runnerIdPrefix) => {
  const values = !backup
    ? {}
    : backup.mode === "host"
      ? {
        DEPLOY_PG_DUMP_MODE: "host",
        DEPLOY_PG_DUMP_BINARY: backup.pgDumpBinary,
      }
      : {
        DEPLOY_PG_DUMP_MODE: "container",
        DEPLOY_DOCKER_BINARY: backup.dockerBinary,
        DEPLOY_PG_DUMP_CONTAINER: backup.container,
        DEPLOY_CONTAINER_PG_DUMP_BINARY: backup.pgDumpBinary,
      };
  Object.assign(values, runnerCountEnvironment(runnerCount));
  Object.assign(values, runnerIdPrefixEnvironment(runnerIdPrefix));
  return Object.entries(values)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
};

export const renderLaunchdPlist = (template, values) => {
  const replacements = {
    __NODE_BINARY__: values.nodeBinary,
    __DEPLOY_SCRIPT__: values.deployScript,
    __REPOSITORY_ROOT__: values.repositoryRoot,
    __STDOUT_PATH__: values.stdoutPath,
    __STDERR_PATH__: values.stderrPath,
    __PATH__: values.path,
    __GIT_BINARY__: values.gitBinary,
    __NPM_BINARY__: values.npmBinary,
    __SOURCE_REMOTE__: values.sourceRemote,
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, xml(value));
  }
  rendered = rendered.replaceAll(
    "__BACKUP_ENVIRONMENT__",
    autoDeployRuntimeEnvironment(values.backup, values.runnerCount, values.runnerIdPrefix),
  );
  const roleEnvironment = Object.entries(deployRoleEnvironment(values.deployRole))
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  rendered = rendered.replaceAll(
    "__DEPLOY_ROLE_ENVIRONMENT__\n",
    roleEnvironment === "" ? "" : `${roleEnvironment}\n`,
  );
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error("launchd-template-has-unresolved-placeholder");
  return rendered;
};

/** Materialize the still-serving checkout as the initial immutable release.
 * Existing service definitions continue to run from the checkout during this
 * step; only after current identifies the same bytes can the independently
 * revertible plist migration point them at the stable wrapper. */
export const bootstrapCurrentRelease = ({
  repositoryRoot,
  artifactPaths,
  optionalArtifactPaths,
} = {}) => {
  const root = realpathSync(resolve(repositoryRoot ?? REPOSITORY_ROOT));
  const sharedEnvironment = join(root, "shared", ".env");
  if (!existsSync(sharedEnvironment)) throw new Error("shared-environment-missing");
  if (existsSync(join(root, "current"))) {
    const current = resolveCurrentRelease({ repositoryRoot: root });
    return Object.freeze({
      releaseName: current.releaseIdentity,
      commit: current.releaseCommit,
      releaseDirectory: current.releaseRoot,
      bootstrapped: false,
    });
  }
  let stamp;
  try { stamp = JSON.parse(readFileSync(join(root, "packages/api/dist/build-info.json"), "utf8")); }
  catch { throw new Error("bootstrap-build-stamp-unreadable"); }
  if (typeof stamp?.commit !== "string" || !/^[0-9a-f]{40}$/u.test(stamp.commit) || stamp.dirty !== false) {
    throw new Error("bootstrap-build-stamp-invalid");
  }
  const selected = artifactPaths ?? deployReleaseArtifactPaths(root);
  const optional = optionalArtifactPaths ?? (artifactPaths === undefined ? [
    ...DEPLOY_OPTIONAL_ARTIFACT_PATHS,
    ...workspaceDependencyPaths(root),
  ] : []);
  const release = assembleReleaseDirectory({
    stageRoot: root,
    deployRoot: root,
    revision: stamp.commit,
    artifactPaths: selected,
    optionalArtifactPaths: optional,
    allowDeployRootInsideStage: true,
    retention: false,
    probeImmutability: true,
  });
  activateReleasePointer({ root, release: release.releaseName });
  return Object.freeze({
    releaseName: release.releaseName,
    commit: release.revision,
    releaseDirectory: release.releaseDirectory,
    bootstrapped: true,
  });
};

export const servicePlistValues = ({
  label,
  inventory,
  nodeBinary,
  repositoryRoot,
  sharedRoot = join(repositoryRoot, "shared"),
  stdoutPath,
  stderrPath,
  path,
  runnerPath = path,
  wrapperPath = serviceWrapperPath(repositoryRoot),
}) => {
  const entry = serviceInventoryEntry(inventory, label);
  if (!nodeBinary || !repositoryRoot || !stdoutPath || !stderrPath || !path) {
    throw new Error("service-plist-values-incomplete");
  }
  return Object.freeze({
    label,
    nodeBinary,
    repositoryRoot: resolve(repositoryRoot),
    sharedRoot: resolve(sharedRoot),
    sharedEnvironmentPath: join(resolve(sharedRoot), ".env"),
    stdoutPath,
    stderrPath,
    path,
    runnerCount: inventory.runnerCount,
    runnerIdPrefix: inventory.runnerIdPrefix,
    deployRole: inventory.deployRole,
    // A null runnerPath is the deliberate "let shared/.env decide" shape: the
    // definition carries the runner id but no inline RUNNER_PATH.
    ...(entry.runnerId
      ? { runnerId: entry.runnerId, runnerPath: runnerPath ?? null }
      : {}),
    wrapperPath,
  });
};

export const renderServiceLaunchdPlist = (template, values) => {
  const replacements = {
    __LABEL__: values.label,
    __NODE_BINARY__: values.nodeBinary,
    __WRAPPER_PATH__: values.wrapperPath,
    __REPOSITORY_ROOT__: values.repositoryRoot,
    __SHARED_ROOT__: values.sharedRoot,
    __SHARED_ENV_FILE__: values.sharedEnvironmentPath,
    __PATH__: values.path,
    __STDOUT_PATH__: values.stdoutPath,
    __STDERR_PATH__: values.stderrPath,
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) rendered = rendered.replaceAll(placeholder, xml(value));
  const runnerEnvironmentValues = {
    ...(values.runnerId ? {
      RUNNER_ID: values.runnerId,
      ...(values.runnerPath ? { RUNNER_PATH: values.runnerPath } : {}),
    } : {}),
    ...runnerCountEnvironment(values.runnerCount),
  };
  const runnerEnvironment = Object.entries(runnerEnvironmentValues)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  rendered = rendered.replaceAll("__RUNNER_ENVIRONMENT__", runnerEnvironment);
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error("launchd-service-template-has-unresolved-placeholder");
  return rendered;
};

/**
 * The service unit deliberately receives the same environment dictionary as
 * the LaunchAgent plist.  Keep this conversion in one place so a new
 * environment key cannot silently land in only one platform's definition.
 */
export const serviceEnvironmentValues = (values) => Object.freeze({
  PATH: values.path,
  DEPLOY_NODE_BINARY: values.nodeBinary,
  AGENTOS_REPOSITORY_ROOT: values.repositoryRoot,
  AGENTOS_SHARED_ROOT: values.sharedRoot,
  AGENTOS_SHARED_ENV_FILE: values.sharedEnvironmentPath,
  AGENTOS_CURRENT_POINTER: "current",
  AGENTOS_RELEASES_DIRECTORY: "releases",
  AGENTOS_SERVICE_LABEL: values.label,
  ...runnerCountEnvironment(values.runnerCount),
  ...(values.runnerId
    ? {
        RUNNER_ID: values.runnerId,
        ...(values.runnerPath ? { RUNNER_PATH: values.runnerPath } : {}),
      }
    : {}),
});

export const autoDeployEnvironmentValues = (values) => Object.freeze({
  AGENTOS_REPOSITORY_ROOT: values.repositoryRoot,
  PATH: values.path,
  QUIET_WINDOW_POLL_SECONDS: "60",
  DEPLOY_NODE_BINARY: values.nodeBinary,
  DEPLOY_GIT_BINARY: values.gitBinary,
  DEPLOY_NPM_BINARY: values.npmBinary,
  DEPLOY_SOURCE_REMOTE: values.sourceRemote,
  ...runnerCountEnvironment(values.runnerCount),
  ...runnerIdPrefixEnvironment(values.runnerIdPrefix),
  ...deployRoleEnvironment(values.deployRole),
  ...(!values.backup ? {} : values.backup.mode === "host"
    ? {
        DEPLOY_PG_DUMP_MODE: "host",
        DEPLOY_PG_DUMP_BINARY: values.backup.pgDumpBinary,
      }
    : {
        DEPLOY_PG_DUMP_MODE: "container",
        DEPLOY_DOCKER_BINARY: values.backup.dockerBinary,
        DEPLOY_PG_DUMP_CONTAINER: values.backup.container,
        DEPLOY_CONTAINER_PG_DUMP_BINARY: values.backup.pgDumpBinary,
      }),
});

/** Escape a value for systemd's Environment= parser. Quoting every value
 * keeps whitespace data intact; percent is doubled because systemd expands
 * specifiers while loading unit definitions. */
export const systemdEnvironmentEscape = (value, key = "environment") => {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`systemd-environment-value-invalid:${key}`);
  }
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
};

const systemdDirectiveToken = (value, key) => {
  if (typeof value !== "string" || value === "" || /[\0\n\r]/u.test(value)) {
    throw new Error(`systemd-directive-value-invalid:${key}`);
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
};

// WorkingDirectory's path parser treats surrounding quotes as path bytes on
// older supported systemd releases, so escape whitespace without quoting it.
const systemdPathDirective = (value, key) => {
  if (typeof value !== "string" || value === "" || /[\0\n\r]/u.test(value)) {
    throw new Error(`systemd-directive-value-invalid:${key}`);
  }
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll(" ", "\\x20")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
};

export const renderSystemdEnvironment = (values) => Object.entries(values)
  .map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error(`systemd-environment-key-invalid:${key}`);
    return `Environment=${key}="${systemdEnvironmentEscape(value, key)}"`;
  })
  .join("\n");

const renderSystemdTemplate = (template, replacements, unresolvedReason) => {
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error(unresolvedReason);
  return rendered;
};

export const renderServiceSystemdUnit = (
  template = readFileSync(SYSTEMD_SERVICE_TEMPLATE, "utf8"),
  values,
) => {
  if (typeof values?.serviceUser !== "string" || values.serviceUser === "") {
    throw new Error("systemd-service-user-required");
  }
  if (values.serviceUser === "root") throw new Error("systemd-service-user-root");
  return renderSystemdTemplate(template, {
    __LABEL__: values.label,
    __NODE_BINARY__: systemdDirectiveToken(values.nodeBinary, "node-binary"),
    __WRAPPER_PATH__: systemdDirectiveToken(values.wrapperPath, "wrapper-path"),
    __REPOSITORY_ROOT__: systemdPathDirective(values.repositoryRoot, "repository-root"),
    __SERVICE_USER__: values.serviceUser,
    __ENVIRONMENT__: renderSystemdEnvironment(serviceEnvironmentValues(values)),
  }, "systemd-service-template-has-unresolved-placeholder");
};

const withoutLegacySystemdRunnerCount = (definition) => {
  const matches = [...definition.matchAll(/^Environment=AGENTOS_RUNNER_COUNT="([0-9]+)"\n/gmu)];
  if (matches.length !== 1) return definition;
  try { resolveRunnerCount({ AGENTOS_RUNNER_COUNT: matches[0][1] }); } catch { return definition; }
  return definition.replace(matches[0][0], "");
};

const withoutLegacyLaunchdRunnerCount = (definition) => {
  const matches = [...definition.matchAll(/^    <key>AGENTOS_RUNNER_COUNT<\/key>\n    <string>([0-9]+)<\/string>\n/gmu)];
  if (matches.length !== 1) return definition;
  try { resolveRunnerCount({ AGENTOS_RUNNER_COUNT: matches[0][1] }); } catch { return definition; }
  return definition.replace(matches[0][0], "");
};

export const renderAutoDeploySystemdUnit = (
  template = readFileSync(SYSTEMD_AUTO_DEPLOY_TEMPLATE, "utf8"),
  values,
) => {
  if (typeof values?.serviceUser !== "string" || values.serviceUser === "") {
    throw new Error("systemd-service-user-required");
  }
  if (values.serviceUser === "root") throw new Error("systemd-service-user-root");
  return renderSystemdTemplate(template, {
    __NODE_BINARY__: systemdDirectiveToken(values.nodeBinary, "node-binary"),
    __DEPLOY_SCRIPT__: systemdDirectiveToken(values.deployScript, "deploy-script"),
    __REPOSITORY_ROOT__: systemdPathDirective(values.repositoryRoot, "repository-root"),
    __SERVICE_USER__: values.serviceUser,
    __ENVIRONMENT__: renderSystemdEnvironment(autoDeployEnvironmentValues(values)),
  }, "systemd-auto-deploy-template-has-unresolved-placeholder");
};

export const renderAutoDeploySystemdTimer = (
  template = readFileSync(SYSTEMD_AUTO_DEPLOY_TIMER_TEMPLATE, "utf8"),
) => renderSystemdTemplate(template, {}, "systemd-auto-deploy-timer-has-unresolved-placeholder");

const hasExactDirective = (text, directive, value) => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${directive}=${escaped}$`, "mu").test(text);
};

const directiveCount = (text, directive) => (text.match(new RegExp(`^${directive}=`, "gmu")) ?? []).length;

/** Validate the subset of unit syntax that protects the activation boundary.
 * systemd-analyze is an optional stronger parser in the test harness; these
 * checks are always available on both operator platforms. */
export const verifySystemdServiceDefinitions = (definitions, inventory) => {
  if (!definitions || !isGeneratedServiceInventory(inventory) || inventory.labels.length === 0) {
    throw new Error("systemd-service-inventory-invalid");
  }
  for (const label of inventory.labels) {
    const rendered = definitions[label];
    if (typeof rendered !== "string") throw new Error(`systemd-service-definition-missing:${label}`);
    if (/__[A-Z_]+__/u.test(rendered)) throw new Error(`systemd-service-definition-unresolved:${label}`);
    if (!hasExactDirective(rendered, "SyslogIdentifier", label)
        || !new RegExp(`^ExecStart=.*(?:^|\\s)${label}(?:\\s|$)`, "mu").test(rendered)) {
      throw new Error(`systemd-service-definition-label-mismatch:${label}`);
    }
    if (!rendered.includes("AGENTOS_CURRENT_POINTER") || !rendered.includes("Environment=AGENTOS_CURRENT_POINTER=\"current\"")) {
      throw new Error(`systemd-service-definition-current-pointer-missing:${label}`);
    }
    if (/^Environment=[^=\s]+=""$/mu.test(rendered)) {
      throw new Error(`systemd-service-definition-empty-assignment:${label}`);
    }
    const required = [
      ["Type", "simple"],
      ["Restart", "always"],
      ["RestartSec", "10"],
      ["StandardOutput", "journal"],
      ["StandardError", "journal"],
      ["After", "network-online.target"],
      ["Wants", "network-online.target"],
      ["WantedBy", "multi-user.target"],
    ];
    for (const [directive, value] of required) {
      if (directiveCount(rendered, directive) !== 1 || !hasExactDirective(rendered, directive, value)) {
        throw new Error(`systemd-service-definition-directive-missing:${label}:${directive}`);
      }
    }
    if (directiveCount(rendered, "User") !== 1 || !/^User=(?!root$)\S+$/mu.test(rendered)) {
      throw new Error(`systemd-service-definition-user-invalid:${label}`);
    }
    for (const directive of ["WorkingDirectory", "ExecStart", "SyslogIdentifier"]) {
      if (directiveCount(rendered, directive) !== 1) {
        throw new Error(`systemd-service-definition-directive-missing:${label}:${directive}`);
      }
    }
    if (/^EnvironmentFile=/mu.test(rendered)) throw new Error(`systemd-service-environment-file-forbidden:${label}`);
  }
  return true;
};

export const verifySystemdAutoDeployDefinitions = ({ service, timer }) => {
  for (const [name, rendered] of [["service", service], ["timer", timer]]) {
    if (typeof rendered !== "string") throw new Error(`systemd-auto-deploy-definition-missing:${name}`);
    if (/__[A-Z_]+__/u.test(rendered)) throw new Error(`systemd-auto-deploy-definition-unresolved:${name}`);
  }
  const required = [
    [service, "Type", "oneshot"],
    [service, "After", "network-online.target"],
    [service, "Wants", "network-online.target"],
    [timer, "OnBootSec", "60"],
    [timer, "OnUnitActiveSec", "300"],
    [timer, "Unit", AUTO_DEPLOY_UNIT],
    [timer, "WantedBy", "timers.target"],
  ];
  for (const [rendered, directive, value] of required) {
    if (directiveCount(rendered, directive) !== 1 || !hasExactDirective(rendered, directive, value)) {
      throw new Error(`systemd-auto-deploy-definition-directive-missing:${directive}`);
    }
  }
  for (const directive of ["User", "WorkingDirectory", "ExecStart"]) {
    if (directiveCount(service, directive) !== 1) {
      throw new Error(`systemd-auto-deploy-definition-directive-missing:${directive}`);
    }
  }
  if (/^EnvironmentFile=/mu.test(service)) throw new Error("systemd-auto-deploy-environment-file-forbidden");
  return true;
};

/** Verify the complete rendered inventory before any LaunchAgent file is
 * touched. The checks intentionally inspect the launchd contract itself, not
 * only the source inputs: a plist that still contains a source checkout path
 * or an unresolved placeholder must never reach launchctl. */
export const verifyServicePlistDefinitions = (definitions, inventory) => {
  if (!definitions || !isGeneratedServiceInventory(inventory) || inventory.labels.length === 0) {
    throw new Error("launchd-service-inventory-invalid");
  }
  for (const label of inventory.labels) {
    const rendered = definitions[label];
    if (typeof rendered !== "string") throw new Error(`launchd-service-definition-missing:${label}`);
    if (/__[A-Z_]+__/u.test(rendered)) throw new Error(`launchd-service-definition-unresolved:${label}`);
    if (!new RegExp(`<key>Label</key>\\s*<string>${xml(label)}</string>`, "u").test(rendered)) {
      throw new Error(`launchd-service-definition-label-mismatch:${label}`);
    }
    if (!rendered.includes("<key>ProgramArguments</key>")) throw new Error(`launchd-service-definition-program-missing:${label}`);
    if (!rendered.includes("AGENTOS_REPOSITORY_ROOT") || !rendered.includes("AGENTOS_SHARED_ROOT")) {
      throw new Error(`launchd-service-definition-path-environment-missing:${label}`);
    }
    if (!rendered.includes("AGENTOS_CURRENT_POINTER") || !rendered.includes("<string>current</string>")) {
      throw new Error(`launchd-service-definition-current-pointer-missing:${label}`);
    }
    if (/<string>\s*<\/string>/u.test(rendered)) throw new Error(`launchd-service-definition-empty-string:${label}`);
  }
  return true;
};

const PLUTIL = "/usr/bin/plutil";
const PYTHON3 = "/usr/bin/python3";

// launchd installation is a macOS operation, but the merge gate exercises the
// migration on Linux. Python's standard plistlib keeps that test on the real
// plist mutation path without adding a production runtime dependency.
const PYTHON_PLISTLIB = String.raw`
import json
import plistlib
import sys

args = sys.argv[1:]
path = args[-1]
with open(path, "rb") as source:
    root = plistlib.load(source)

def parent_for(key_path):
    parts = key_path.split(".")
    parent = root
    for part in parts[:-1]:
        parent = parent[part]
    return parent, parts[-1]

if args[0] == "-convert" and args[1] == "json":
    print(json.dumps(root))
    sys.exit(0)

if args[0] == "-remove":
    parent, key = parent_for(args[1])
    del parent[key]
elif args[0] in ("-replace", "-insert"):
    parent, key = parent_for(args[1])
    value_type = args[2]
    if value_type == "-dictionary":
        value = {}
    elif value_type == "-json":
        value = json.loads(args[3])
    elif value_type == "-string":
        value = args[3]
    else:
        raise ValueError(f"unsupported plist value type: {value_type}")
    parent[key] = value
elif not (args[0] == "-convert" and args[1] == "xml1"):
    raise ValueError(f"unsupported plist operation: {args}")

with open(path, "wb") as destination:
    plistlib.dump(root, destination, fmt=plistlib.FMT_XML, sort_keys=False)
`;

const execPlist = (args, options) => {
  if (existsSync(PLUTIL)) return execFileSync(PLUTIL, args, options);
  if (!existsSync(PYTHON3)) throw new Error(`plist-tool-unavailable:${PLUTIL}:${PYTHON3}`);
  return execFileSync(PYTHON3, ["-c", PYTHON_PLISTLIB, ...args], options);
};

const plistObject = (path) => {
  try {
    return JSON.parse(execPlist(["-convert", "json", "-o", "-", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch (error) {
    throw new DeployFailure("launchd-service-definition-invalid", `${path}:${error instanceof Error ? error.message : String(error)}`);
  }
};

const setPlistValue = (path, existing, keyPath, type, value) => {
  const action = existing ? "-replace" : "-insert";
  const args = [action, keyPath, type];
  if (value !== undefined) args.push(value);
  args.push(path);
  execPlist(args, { stdio: ["ignore", "ignore", "pipe"] });
};

/** Patch only the stable wrapper boundary into an existing definition. plutil
 * performs the mutation so unknown launchd value types and lifecycle keys stay
 * byte-for-byte meaningful instead of being reinterpreted by this installer. */
const renderMigratedServicePlist = ({ sourcePath, values }) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agentos-launchd-plist-"));
  const temporary = join(temporaryRoot, "service.plist");
  try {
    copyFileSync(sourcePath, temporary);
    const original = plistObject(temporary);
    if (original.Label !== values.label) throw new DeployFailure("launchd-service-definition-label-mismatch", values.label);
    const environment = original.EnvironmentVariables && typeof original.EnvironmentVariables === "object"
      && !Array.isArray(original.EnvironmentVariables)
      ? original.EnvironmentVariables
      : {};
    setPlistValue(temporary, Object.hasOwn(original, "ProgramArguments"), "ProgramArguments", "-json", JSON.stringify([
      values.nodeBinary,
      values.wrapperPath,
      values.label,
    ]));
    setPlistValue(temporary, Object.hasOwn(original, "WorkingDirectory"), "WorkingDirectory", "-string", values.repositoryRoot);
    if (!Object.hasOwn(original, "EnvironmentVariables")) {
      setPlistValue(temporary, false, "EnvironmentVariables", "-dictionary");
    }
    const controlled = {
      DEPLOY_NODE_BINARY: values.nodeBinary,
      AGENTOS_REPOSITORY_ROOT: values.repositoryRoot,
      AGENTOS_SHARED_ROOT: values.sharedRoot,
      AGENTOS_SHARED_ENV_FILE: values.sharedEnvironmentPath,
      AGENTOS_CURRENT_POINTER: "current",
      AGENTOS_RELEASES_DIRECTORY: "releases",
      AGENTOS_SERVICE_LABEL: values.label,
    };
    if (!Object.hasOwn(environment, "PATH")) controlled.PATH = values.path;
    if (values.runnerId) {
      controlled.RUNNER_ID = values.runnerId;
      if (values.runnerPath && (typeof environment.RUNNER_PATH !== "string" || environment.RUNNER_PATH === "")) {
        controlled.RUNNER_PATH = values.runnerPath;
      }
    }
    for (const [key, value] of Object.entries(controlled)) {
      setPlistValue(temporary, Object.hasOwn(environment, key), `EnvironmentVariables.${key}`, "-string", value);
    }
    for (const key of values.runnerId ? [] : ["RUNNER_ID", "RUNNER_PATH"]) {
      if (environment[key] === "") execPlist(["-remove", `EnvironmentVariables.${key}`, temporary], { stdio: "ignore" });
    }
    for (const key of ["AGENTOS_RUNNER_COUNT", "AGENTOS_RUNNER_ID_PREFIX"]) {
      if (Object.hasOwn(environment, key)) execPlist(["-remove", `EnvironmentVariables.${key}`, temporary], { stdio: "ignore" });
    }
    execPlist(["-convert", "xml1", temporary], { stdio: ["ignore", "ignore", "pipe"] });
    return readFileSync(temporary, "utf8");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

export const renderServicePlists = ({
  template = readFileSync(SERVICE_TEMPLATE, "utf8"),
  inventory,
  ...values
} = {}) => {
  const rendered = Object.fromEntries(inventory.labels.map((label) => [
    label,
    renderServiceLaunchdPlist(template, servicePlistValues({ label, inventory, ...values })),
  ]));
  verifyServicePlistDefinitions(rendered, inventory);
  return Object.freeze(rendered);
};

const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

const writeAtomic = (destination, contents, mode, ownership = null, chown = chownSync) => {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, contents, { flag: "wx", mode });
  chmodSync(temporary, mode);
  if (ownership) chown(temporary, ownership.uid, ownership.gid);
  try { renameSync(temporary, destination); } finally { rmSync(temporary, { force: true }); }
};

const safeServiceFileName = (label) => label.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

const serviceManifestPath = (repositoryRoot) => join(resolve(repositoryRoot), SERVICE_INSTALL_ROOT, "manifest.json");
const autoDeployManifestPath = (repositoryRoot) => join(resolve(repositoryRoot), AUTO_DEPLOY_INSTALL_ROOT, "manifest.json");

const validAccountName = (value) => typeof value === "string"
  && /^[A-Za-z_][A-Za-z0-9_.-]*[$]?$/u.test(value);

/** Resolve the account used by system-level units. The lookup is injectable so
 * the unprivileged renderer can be exercised with a deterministic getent
 * recorder on hosts without Linux account tooling. */
export const resolveSystemdServiceUser = ({
  serviceUser,
  platform = resolveServicePlatform(),
  lookup = null,
  execute = execFileSync,
} = {}) => {
  if (platform === "darwin") {
    if (serviceUser !== undefined && serviceUser !== null) throw new Error("systemd-service-user-not-supported-on-darwin");
    return null;
  }
  if (platform !== "linux") throw new Error(`service-platform-unsupported:${platform}`);
  if (!validAccountName(serviceUser)) throw new Error("systemd-service-user-required");
  if (serviceUser === "root") throw new Error("systemd-service-user-root");
  let record;
  try {
    record = lookup
      ? lookup(serviceUser)
      : execute("getent", ["passwd", serviceUser], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error(`systemd-service-user-unknown:${serviceUser}`);
  }
  const line = String(record ?? "").trim().split("\n", 1)[0];
  const fields = line.split(":");
  if (fields[0] !== serviceUser || !/^\d+$/u.test(fields[2] ?? "") || Number(fields[2]) === 0) {
    throw new Error(`systemd-service-user-unknown:${serviceUser}`);
  }
  return serviceUser;
};

const systemdCommandPath = (name, configured, execute = execFileSync) => {
  if (configured) {
    if (!configured.startsWith("/")) throw new Error(`systemd-command-not-absolute:${name}`);
    try { accessSync(configured, fsConstants.X_OK); } catch { throw new Error(`systemd-command-unavailable:${name}`); }
    return configured;
  }
  try {
    return requiredBinary(name);
  } catch {
    throw new Error(`systemd-command-unavailable:${name}`);
  }
};

/**
 * Grant the service user exactly the commands `service-control.mjs` issues:
 * one line per unit and control verb, rendered from that module's description
 * of the verbs. Nothing else is granted, and a verb the deployment issues
 * cannot be missing from the grant.
 */
export const renderSystemdSudoers = ({ serviceUser, inventory } = {}) => {
  if (!validAccountName(serviceUser) || serviceUser === "root") throw new Error("systemd-service-user-invalid");
  if (!isGeneratedServiceInventory(inventory) || inventory.entries.length === 0) {
    throw new Error("systemd-service-inventory-invalid");
  }
  const rules = [];
  for (const { unitName } of inventory.entries) {
    for (const verb of SYSTEMD_CONTROL_VERBS) {
      rules.push([SYSTEMCTL_PATH, ...systemdControlArgv(verb, unitName)].join(" "));
    }
  }
  return `${serviceUser} ALL=(root) NOPASSWD: ${rules.join(", ")}\n`;
};

const validateSudoers = ({ path, visudoPath, execute = execFileSync }) => {
  try {
    execute(visudoPath, ["-c", "-f", path], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`systemd-sudoers-invalid:${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
};

const fileDigest = (path) => existsSync(path) ? sha256(readFileSync(path)) : null;

/** The recovery rules every staged-file installer depends on. A manifest entry
 * recognises exactly the digests an interrupted install can leave at its
 * target: what this installer installed, what it installed before that, the
 * operator's original when it overwrote one, and nothing at all when it
 * created the file. An entry still showing the installed digest over an
 * operator file needs a verified backup or there is no way back. `reason`
 * names the installer in both refusals. Returns the digest observed at the
 * target so a caller that restores need not read the file twice. */
export const recognizeInstalledEntry = ({ entry, reason }) => {
  const current = fileDigest(entry.path);
  const recognized = current === entry.installedSha256
    || current === entry.previousInstalledSha256
    || (entry.existed && current === entry.originalSha256)
    || (!entry.existed && current === null);
  if (!recognized) throw new Error(`${reason}-definition-drift:${entry.path}`);
  if (entry.existed && current === entry.installedSha256
      && (!entry.backupPath || fileDigest(entry.backupPath) !== entry.originalSha256)) {
    throw new Error(`${reason}-backup-missing:${entry.path}`);
  }
  return current;
};

/** The staged source an entry promises to install. Every copy out of a staging
 * root passes through here first, and so does every installer that checks the
 * staged files before it starts. */
export const assertStagedSource = (entry) => {
  if (!entry.stagedPath || !existsSync(entry.stagedPath)) {
    throw new Error(`systemd-staged-file-missing:${entry.stagedPath ?? entry.path}`);
  }
  if (fileDigest(entry.stagedPath) !== entry.installedSha256) {
    throw new Error(`systemd-staged-file-drift:${entry.stagedPath}`);
  }
};

const invalidManifest = (reason, manifestPath, field) => {
  const detail = [manifestPath, field].filter((value) => value !== undefined && value !== null && value !== "").join(":");
  throw new DeployFailure(reason, detail);
};

const readJsonFile = (path, reason) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { invalidManifest(reason, path, "unparseable"); }
};

const validateManifestEntries = ({ entries, arrayName, reason, manifestPath, requireLabel }) => {
  for (const [index, entry] of entries.entries()) {
    const entryField = `${arrayName}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalidManifest(reason, manifestPath, entryField);
    }
    if (typeof entry.path !== "string" || entry.path === "") {
      invalidManifest(reason, manifestPath, `${entryField}.path`);
    }
    if (requireLabel(entry, index) && (typeof entry.label !== "string" || entry.label === "")) {
      invalidManifest(reason, manifestPath, `${entryField}.label`);
    }
    if (entry.pendingInstall !== undefined && entry.pendingInstall !== true) {
      invalidManifest(reason, manifestPath, `${entryField}.pendingInstall`);
    }
  }
};

const validateManifestEntryArrays = ({ manifest, reason, manifestPath, arrays }) => {
  for (const { arrayName, required, requireLabel } of arrays) {
    const entries = manifest[arrayName];
    if (entries === undefined && !required) continue;
    if (!Array.isArray(entries)) invalidManifest(reason, manifestPath, arrayName);
    validateManifestEntries({
      entries,
      arrayName,
      reason,
      manifestPath,
      requireLabel: requireLabel(entries),
    });
  }
};

const manifestStringField = ({ manifest, reason, manifestPath, field }) => {
  if (typeof manifest?.[field] !== "string" || manifest[field] === "") {
    invalidManifest(reason, manifestPath, field);
  }
  return manifest[field];
};

const validateManifestRenderInputs = ({
  manifest,
  reason,
  manifestPath,
  fallbackRunnerCount,
  requireRenderInputs = false,
}) => {
  const renderInputs = manifest?.renderInputs;
  if (renderInputs === undefined) {
    if (requireRenderInputs) invalidManifest(reason, manifestPath, "renderInputs");
    return {
      runnerCount: fallbackRunnerCount,
      runnerIdPrefix: "",
    };
  }
  if (!renderInputs || typeof renderInputs !== "object" || Array.isArray(renderInputs)) {
    invalidManifest(reason, manifestPath, "renderInputs");
  }
  if (!Object.hasOwn(renderInputs, "runnerCount")
      || typeof renderInputs.runnerCount !== "number"
      || !Number.isSafeInteger(renderInputs.runnerCount)
      || renderInputs.runnerCount < 1
      || renderInputs.runnerCount > MAX_RUNNER_COUNT) {
    invalidManifest(reason, manifestPath, "renderInputs.runnerCount");
  }
  if (renderInputs.runnerIdPrefix !== undefined) {
    if (typeof renderInputs.runnerIdPrefix !== "string") {
      invalidManifest(reason, manifestPath, "renderInputs.runnerIdPrefix");
    }
    try {
      resolveRunnerIdPrefix({ AGENTOS_RUNNER_ID_PREFIX: renderInputs.runnerIdPrefix });
    } catch {
      invalidManifest(reason, manifestPath, "renderInputs.runnerIdPrefix");
    }
  }
  return {
    ...renderInputs,
    runnerCount: renderInputs.runnerCount,
    runnerIdPrefix: renderInputs.runnerIdPrefix ?? "",
  };
};

const makeSystemdManifestEntry = ({ path, stagedPath, backupPath = null, mode = 0o644 }) => ({
  path,
  stagedPath,
  existed: existsSync(path),
  mode: existsSync(path) ? statSync(path).mode & 0o777 : mode,
  backupPath: existsSync(path) ? backupPath : null,
  originalSha256: fileDigest(path),
  installedSha256: fileDigest(stagedPath),
});

const assertTargetPathSafe = (path, allowedRoot) => {
  const root = resolve(allowedRoot);
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error(`systemd-target-outside-directory:${path}`);
};

const stageFileEntry = ({ entry, replaceExisting = false }) => {
  if (!existsSync(entry.path)) return;
  const current = fileDigest(entry.path);
  if (current !== entry.originalSha256) throw new Error(`systemd-target-read-failed:${entry.path}`);
  if (current !== entry.installedSha256 && !replaceExisting) {
    throw new Error(`systemd-definition-conflict:${entry.path}`);
  }
};

const assertContainedPath = (path, allowedRoot) => {
  const root = resolve(allowedRoot);
  const target = resolve(path);
  const suffix = relative(root, target);
  if (suffix === ".." || suffix.startsWith("../")) {
    throw new Error(`systemd-target-outside-directory:${path}`);
  }
  let cursor = root;
  for (const part of suffix.split(/[\\/]/u).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`systemd-symlink-refused:${cursor}`);
    }
  }
};

const assertExactEntry = (entry, expected, reason = "systemd-service-manifest-invalid") => {
  if (!entry || Object.entries(expected).some(([key, value]) => entry[key] !== value)) {
    throw new Error(reason);
  }
};

const validateDropIn = (entry, inventory) => {
  const inventoryEntry = inventory.entries.find((candidate) => candidate.unitName === entry.unit);
  if (!inventoryEntry || (!inventoryEntry.runnerId && inventoryEntry.label !== "com.agentos.api")) {
    throw new Error("systemd-service-manifest-invalid");
  }
  const allowed = new Set(inventoryEntry.runnerId ? [
    "RUNNER_RUN_AS_PREFIX", "RUNNER_HOME", "RUNNER_WORKSPACE_ROOT", "RUNNER_MCP_SERVER_PATH",
    "RUNNER_PI_EXTENSION_PATH", "RUNNER_CLAUDE_SETTINGS_PATH", "RUNNER_SESSION_CONFIG_BASELINE_ROOT", "RUNNER_PATH",
  ] : ["RUNNER_WORKSPACE_ROOT", "RUNNER_RUN_AS_PREFIX", "RUNNER_HOME", "RUNNER_REPO_MIRROR_ROOT"]);
  const lines = readFileSync(entry.stagedPath, "utf8").split("\n");
  if (lines.shift() !== "[Service]") throw new Error(`systemd-drop-in-invalid:${entry.stagedPath}`);
  for (const line of lines.filter(Boolean)) {
    const match = line.match(/^Environment=([A-Za-z_][A-Za-z0-9_]*)="(?:[^"\\]|\\.)*"$/u);
    if (!match || !allowed.has(match[1])) throw new Error(`systemd-drop-in-invalid:${entry.stagedPath}`);
  }
};

const readStageEntries = ({
  manifest,
  manifestPath,
  root,
  unitDirectory,
  sudoersPath,
  serviceUser,
  runnerIdPrefix,
  deployRole,
  userLookup,
  execute,
}) => {
  const reason = "systemd-service-manifest-invalid";
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    invalidManifest(reason, manifestPath);
  }
  const renderInputs = validateManifestRenderInputs({
    manifest,
    reason,
    manifestPath,
    requireRenderInputs: true,
  });
  const runnerCount = manifest.runnerCount;
  if (typeof runnerCount !== "number"
      || !Number.isSafeInteger(runnerCount)
      || runnerCount < 1
      || runnerCount > MAX_RUNNER_COUNT) {
    invalidManifest(reason, manifestPath, "runnerCount");
  }
  if (renderInputs.runnerCount !== runnerCount) {
    invalidManifest(reason, manifestPath, "renderInputs.runnerCount");
  }
  const recordedDeployRole = renderInputs.deployRole ?? DEFAULT_DEPLOY_ROLE;
  if (recordedDeployRole !== deployRole) {
    throw new Error("systemd-deploy-role-manifest-mismatch");
  }
  const recordedRunnerIdPrefix = renderInputs.runnerIdPrefix;
  if (recordedRunnerIdPrefix !== runnerIdPrefix) {
    throw new Error("systemd-runner-id-prefix-manifest-mismatch");
  }
  let inventory;
  try {
    inventory = generateServiceInventory({
      runnerCount,
      runnerIdPrefix: recordedRunnerIdPrefix,
      deployRole,
    });
  } catch { invalidManifest(reason, manifestPath, "renderInputs"); }
  const recordedStageRoot = manifestStringField({ manifest, reason, manifestPath, field: "stagingRoot" });
  manifestStringField({ manifest, reason, manifestPath, field: "unitDirectory" });
  manifestStringField({ manifest, reason, manifestPath, field: "sudoersPath" });
  const stageRoot = resolve(recordedStageRoot);
  assertContainedPath(stageRoot, join(root, SERVICE_INSTALL_ROOT));
  validateManifestEntryArrays({
    manifest,
    reason,
    manifestPath,
    arrays: [
      { arrayName: "entries", required: true, requireLabel: () => (entry) => entry.kind === "service" },
      { arrayName: "auxiliaryEntries", required: true, requireLabel: () => () => false },
      { arrayName: "retiredEntries", required: false, requireLabel: () => (entry) => entry.kind === "service" },
    ],
  });
  if (manifest.schemaVersion !== 1 || manifest.platform !== "linux"
      || manifest.repositoryRoot !== resolve(root) || manifest.stagingRoot !== stageRoot
      || manifest.unitDirectory !== unitDirectory || manifest.sudoersPath !== sudoersPath
      || manifest.systemctlPath !== SYSTEMCTL_PATH
      || (manifest.reloadPending !== undefined && manifest.reloadPending !== true)
      || manifest.entries.length !== inventory.entries.length + 1) {
    invalidManifest(reason, manifestPath);
  }
  const account = resolveSystemdServiceUser({ serviceUser, platform: "linux", lookup: userLookup, execute });
  if (account !== manifest.serviceUser) throw new Error("systemd-service-user-manifest-mismatch");
  const wrapper = serviceWrapperPath(root);
  assertContainedPath(wrapper, root);
  const wrapperStaged = join(stageRoot, "wrapper", SERVICE_WRAPPER_FILE_NAME);
  assertExactEntry(manifest.entries[0], { kind: "wrapper", path: wrapper, stagedPath: wrapperStaged });
  const expectedServices = inventory.entries.map((item) => ({
    kind: "service",
    label: item.label,
    unit: item.unitName,
    path: join(unitDirectory, item.unitName),
    stagedPath: join(stageRoot, "units", item.unitName),
  }));
  expectedServices.forEach((expected, index) => assertExactEntry(manifest.entries[index + 1], expected));
  const seenAuxiliary = new Set();
  for (const entry of manifest.auxiliaryEntries) {
    if (entry.kind === "sudoers") {
      assertExactEntry(entry, {
        path: sudoersPath,
        stagedPath: join(stageRoot, "sudoers", "anneal-service-control"),
      });
      if (seenAuxiliary.has("sudoers")) throw new Error("systemd-service-manifest-invalid");
      seenAuxiliary.add("sudoers");
    } else if (entry.kind === "drop-in") {
      const expectedUnit = inventory.entries.find((item) => item.unitName === entry.unit)?.unitName;
      if (!expectedUnit) throw new Error("systemd-service-manifest-invalid");
      assertExactEntry(entry, {
        path: join(unitDirectory, `${expectedUnit}.d`, "os-isolation.conf"),
        stagedPath: join(stageRoot, "units", `${expectedUnit}.d`, "os-isolation.conf"),
      });
      if (seenAuxiliary.has(entry.path)) throw new Error("systemd-service-manifest-invalid");
      seenAuxiliary.add(entry.path);
    } else throw new Error("systemd-service-manifest-invalid");
  }
  if (!seenAuxiliary.has("sudoers")) throw new Error("systemd-service-manifest-invalid");

  const entries = [...manifest.entries, ...manifest.auxiliaryEntries];
  const previousEntriesByPath = new Map([
    ...(manifest.previousManifest?.entries ?? []),
    ...(manifest.previousManifest?.auxiliaryEntries ?? []),
  ].map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const pathRoot = entry.kind === "sudoers" ? dirname(sudoersPath) : entry.kind === "wrapper" ? dirname(wrapper) : unitDirectory;
    assertContainedPath(entry.path, pathRoot);
    assertContainedPath(entry.stagedPath, stageRoot);
    if (!existsSync(entry.stagedPath) || !lstatSync(entry.stagedPath).isFile()) {
      throw new Error(`systemd-staged-file-missing:${entry.stagedPath}`);
    }
    const expectedBackupName = entry.kind === "wrapper" ? SERVICE_WRAPPER_FILE_NAME
      : entry.kind === "service" ? unitNameForLabel(safeServiceFileName(entry.label))
        : entry.kind === "sudoers" ? "anneal-service-control"
          : safeServiceFileName(relative(unitDirectory, entry.path));
    if ((!entry.existed && entry.backupPath !== null)
        || (entry.existed && (typeof entry.backupPath !== "string"
          || !entry.backupPath.endsWith(`/backups/${expectedBackupName}`)))) {
      throw new Error("systemd-service-manifest-invalid");
    }
    if (entry.backupPath !== null) {
      assertContainedPath(entry.backupPath, join(root, SERVICE_INSTALL_ROOT));
      if (existsSync(entry.backupPath) && !lstatSync(entry.backupPath).isFile()) {
        throw new Error(`systemd-symlink-refused:${entry.backupPath}`);
      }
    }
    const previousEntry = previousEntriesByPath.get(entry.path);
    if (previousEntry) {
      const provenanceKeys = [
        "existed", "mode", "originalUid", "originalGid", "parentExisted", "backupPath", "originalSha256",
      ];
      const expectedPreviousSha256 = previousEntry.previousInstalledSha256 ?? previousEntry.installedSha256;
      if (provenanceKeys.some((key) => entry[key] !== previousEntry[key])) {
        throw new Error(`systemd-service-manifest-invalid:previous-entry-provenance:${entry.path}`);
      }
      if (entry.previousInstalledSha256 !== undefined
          && entry.previousInstalledSha256 !== expectedPreviousSha256) {
        throw new Error(`systemd-service-manifest-invalid:previous-entry-digest:${entry.path}`);
      }
      if (![previousEntry.installedSha256, previousEntry.previousInstalledSha256,
        ...(entry.previousInstalledSha256 === undefined ? [] : [entry.installedSha256])]
        .filter(Boolean).includes(fileDigest(entry.path))) {
        throw new Error(`systemd-service-manifest-invalid:previous-target-drift:${entry.path}`);
      }
    }
  }
  if (typeof renderInputs.nodeBinary !== "string" || renderInputs.nodeBinary === ""
      || renderInputs.nodeBinary !== resolve(renderInputs.nodeBinary)
      || typeof renderInputs.path !== "string" || renderInputs.path === "") {
    invalidManifest(reason, manifestPath, "renderInputs");
  }
  const expectedDefinitions = linuxServiceValues({
    root,
    inventory,
    nodeBinary: renderInputs.nodeBinary,
    path: renderInputs.path,
    serviceUser: account,
    wrapper,
  });
  for (const item of inventory.entries) {
    const expected = renderServiceSystemdUnit(readFileSync(SYSTEMD_SERVICE_TEMPLATE, "utf8"), expectedDefinitions[item.label]);
    const entry = manifest.entries.find((candidate) => candidate.label === item.label);
    const normalizedExpected = withoutLegacySystemdRunnerCount(expected);
    if (entry.preserved) {
      const previousEntry = manifest.previousManifest?.entries?.find((candidate) => candidate.path === entry.path);
      if ((manifest.previousManifest && (!previousEntry || previousEntry.installedSha256 !== entry.installedSha256
          || previousEntry.label !== entry.label || previousEntry.unit !== entry.unit))
          || fileDigest(entry.path) !== entry.installedSha256 || fileDigest(entry.stagedPath) !== entry.installedSha256
          || withoutLegacySystemdRunnerCount(readFileSync(entry.stagedPath, "utf8")) !== normalizedExpected) {
        throw new Error(`systemd-staged-unit-invalid:${item.unitName}`);
      }
    } else if (withoutLegacySystemdRunnerCount(readFileSync(entry.stagedPath, "utf8")) !== normalizedExpected) {
      throw new Error(`systemd-staged-unit-invalid:${item.unitName}`);
    }
  }
  const sudoersEntry = manifest.auxiliaryEntries.find((entry) => entry.kind === "sudoers");
  if (readFileSync(sudoersEntry.stagedPath, "utf8") !== renderSystemdSudoers({ serviceUser: account, inventory })) {
    throw new Error("systemd-staged-sudoers-invalid");
  }
  for (const entry of manifest.auxiliaryEntries.filter((candidate) => candidate.kind === "drop-in")) validateDropIn(entry, inventory);
  const retiredEntries = manifest.retiredEntries ?? [];
  if (!Array.isArray(retiredEntries)) throw new Error("systemd-service-manifest-invalid");
  if (retiredEntries.length > 0 && (manifest.reinstall !== true || !manifest.previousManifest)) {
    throw new Error("systemd-service-manifest-invalid");
  }
  const desiredUnits = new Set(inventory.entries.map(({ unitName }) => unitName));
  const previousRetiredCandidates = [
    ...(manifest.previousManifest?.entries ?? []),
    ...(manifest.previousManifest?.retiredEntries ?? []),
  ].filter((entry, index, candidates) => entry.kind === "service" && !desiredUnits.has(entry.unit)
    && candidates.findIndex((candidate) => candidate.path === entry.path) === index);
  const expectedRetiredPaths = previousRetiredCandidates
    .filter((entry) => existsSync(entry.path))
    .map((entry) => entry.path);
  if (JSON.stringify(retiredEntries.map((entry) => entry.path)) !== JSON.stringify(expectedRetiredPaths)
      || (previousRetiredCandidates.length !== expectedRetiredPaths.length && manifest.reloadPending !== true)) {
    throw new Error("systemd-service-manifest-invalid");
  }
  for (const entry of retiredEntries) {
    const previousEntry = previousRetiredCandidates.find((candidate) => candidate.path === entry.path);
    if (entry.kind !== "service" || desiredUnits.has(entry.unit)
        || entry.path !== join(unitDirectory, entry.unit) || entry.existed !== false
        || !previousEntry || previousEntry.kind !== "service"
        || previousEntry.unit !== entry.unit || previousEntry.label !== entry.label
        || previousEntry.installedSha256 !== entry.installedSha256) {
      throw new Error("systemd-service-manifest-invalid");
    }
    assertContainedPath(entry.path, unitDirectory);
    if (!existsSync(entry.path) || fileDigest(entry.path) !== entry.installedSha256) {
      throw new Error(`systemd-service-definition-drift:${entry.path}`);
    }
  }
  return {
    entries,
    inventory,
    stageRoot,
    retiredEntries,
    retiredUnits: previousRetiredCandidates.map(({ unit }) => unit),
  };
};

const copyStagedEntry = ({ entry, unitDirectory, sudoersPath, strictOwner = true, chown = chownSync }) => {
  assertStagedSource(entry);
  if (entry.kind === "wrapper") throw new Error("systemd-root-wrapper-write-refused");
  if (entry.kind === "sudoers") assertTargetPathSafe(entry.path, dirname(sudoersPath));
  else assertTargetPathSafe(entry.path, unitDirectory);
  const parent = dirname(entry.path);
  const parentExisted = existsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  copyFileSync(entry.stagedPath, entry.path);
  chmodSync(entry.path, entry.kind === "sudoers" ? 0o440 : 0o644);
  const ownerUid = 0;
  const ownerGid = 0;
  try {
    chown(entry.path, ownerUid, ownerGid);
    if (!parentExisted) chown(parent, ownerUid, ownerGid);
  } catch (error) {
    if (strictOwner) throw new Error(`systemd-install-owner-failed:${entry.path}:${error instanceof Error ? error.message : String(error)}`);
  }
};

const runSystemctl = ({ systemctlPath, args, unit = "", execute = execFileSync }) => {
  try {
    return execute(systemctlPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("systemd-systemctl-unavailable");
    const verb = args[0] ?? "command";
    throw new Error(`systemd-control-failed:${verb}${unit ? `:${unit}` : ""}`);
  }
};

const systemdUnitState = ({ systemctlPath, unit, execute = execFileSync }) => {
  const query = (verb) => {
    try { return String(execute(systemctlPath, [verb, unit], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) ?? "").trim(); }
    catch (error) { return String(error?.stdout ?? "").trim(); }
  };
  return { enabled: query("is-enabled") === "enabled", active: query("is-active") === "active" };
};

const assertSystemdUnitNotFound = ({ systemctlPath, unit, execute = execFileSync }) => {
  let loadState;
  try {
    loadState = String(execute(systemctlPath, ["show", "--property=LoadState", "--value", unit], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }) ?? "").trim();
  } catch (error) {
    loadState = String(error?.stdout ?? "").trim();
    if (loadState === "") throw new Error(`systemd-service-query-failed:${unit}`);
  }
  if (loadState !== "not-found") throw new Error(`systemd-service-removal-incomplete:${unit}`);
};

const systemdTransactionFingerprint = (manifest) => sha256(JSON.stringify({
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

const rootTransactionState = ({ statePath, manifest, entries, systemctlPath, execute, requireExisting = false }) => {
  const expectedPaths = entries.filter((entry) => entry.kind !== "wrapper").map((entry) => entry.path);
  const fingerprint = systemdTransactionFingerprint(manifest);
  if (existsSync(statePath)) {
    if (!lstatSync(statePath).isFile()) throw new Error(`systemd-transaction-state-invalid:${statePath}`);
    const status = statSync(statePath);
    if ((typeof process.geteuid !== "function" || process.geteuid() === 0) && (status.uid !== 0 || (status.mode & 0o777) !== 0o600)) {
      throw new Error(`systemd-transaction-state-owner-invalid:${statePath}`);
    }
    let state;
    try { state = JSON.parse(readFileSync(statePath, "utf8")); }
    catch { throw new Error(`systemd-transaction-state-invalid:${statePath}`); }
    if (state.schemaVersion !== 1 || state.fingerprint !== fingerprint
        || JSON.stringify(state.entries.map(({ path }) => path)) !== JSON.stringify(expectedPaths)) {
      throw new Error(`systemd-transaction-state-mismatch:${statePath}`);
    }
    return state;
  }
  if (requireExisting) throw new Error(`systemd-transaction-state-missing:${statePath}`);
  const state = {
    schemaVersion: 1,
    fingerprint,
    entries: entries.filter((entry) => entry.kind !== "wrapper").map((entry) => {
      const existed = existsSync(entry.path);
      const status = existed ? statSync(entry.path) : null;
      return {
        path: entry.path,
        existed,
        mode: status ? status.mode & 0o777 : null,
        uid: status?.uid ?? null,
        gid: status?.gid ?? null,
        contents: existed ? readFileSync(entry.path).toString("base64") : null,
        unitState: existed && entry.unit ? systemdUnitState({ systemctlPath, unit: entry.unit, execute }) : null,
      };
    }),
  };
  writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  if (typeof process.geteuid !== "function" || process.geteuid() === 0) chownSync(statePath, 0, 0);
  return state;
};

const restoreRootTransactionEntry = (entry, stateEntry) => {
  if (!stateEntry || stateEntry.path !== entry.path) throw new Error(`systemd-transaction-state-entry-invalid:${entry.path}`);
  if (stateEntry.existed) {
    writeFileSync(entry.path, Buffer.from(stateEntry.contents, "base64"));
    chmodSync(entry.path, stateEntry.mode);
    const status = statSync(entry.path);
    if (status.uid !== stateEntry.uid || status.gid !== stateEntry.gid) chownSync(entry.path, stateEntry.uid, stateEntry.gid);
  } else rmSync(entry.path, { force: true });
};

const systemdManifestPath = serviceManifestPath;

const stagingFile = (stagingRoot, relativePath) => join(stagingRoot, relativePath);

const stageSystemdDefinition = ({ stagingRoot, relativePath, contents, mode = 0o644 }) => {
  const path = stagingFile(stagingRoot, relativePath);
  writeAtomic(path, contents, mode);
  return path;
};

const backupSystemdTarget = ({ stagingRoot, entry }) => {
  if (!entry.existed) return;
  const backup = entry.backupPath;
  if (!backup) throw new Error(`systemd-backup-path-missing:${entry.path}`);
  mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
  if (existsSync(backup)) {
    if (fileDigest(backup) !== entry.originalSha256) throw new Error(`systemd-backup-conflict:${backup}`);
    return;
  }
  writeFileSync(backup, readFileSync(entry.path), { flag: "wx", mode: 0o600 });
};

const serviceUnitEntry = ({ label, unit, stagedPath, targetPath, stagingRoot }) => {
  const existed = existsSync(targetPath);
  const originalStatus = existed ? statSync(targetPath) : null;
  const entry = {
    kind: "service",
    label,
    unit,
    path: targetPath,
    stagedPath,
    existed,
    mode: existed ? statSync(targetPath).mode & 0o777 : 0o644,
    originalUid: originalStatus?.uid ?? null,
    originalGid: originalStatus?.gid ?? null,
    backupPath: existed ? join(stagingRoot, "backups", unitNameForLabel(safeServiceFileName(label))) : null,
    originalSha256: existed ? sha256(readFileSync(targetPath)) : null,
    installedSha256: sha256(readFileSync(stagedPath)),
  };
  return entry;
};

const wrapperEntry = ({ wrapperPath, stagedPath, stagingRoot }) => {
  const existed = existsSync(wrapperPath);
  const stagedStatus = statSync(stagedPath);
  const originalStatus = existed ? statSync(wrapperPath) : null;
  return {
    kind: "wrapper",
    path: wrapperPath,
    stagedPath,
    existed,
    mode: existed ? statSync(wrapperPath).mode & 0o777 : 0o755,
    originalUid: originalStatus?.uid ?? null,
    originalGid: originalStatus?.gid ?? null,
    stagedUid: stagedStatus.uid,
    stagedGid: stagedStatus.gid,
    backupPath: existed ? join(stagingRoot, "backups", SERVICE_WRAPPER_FILE_NAME) : null,
    originalSha256: existed ? sha256(readFileSync(wrapperPath)) : null,
    installedSha256: sha256(readFileSync(stagedPath)),
  };
};

const auxiliarySystemdEntries = ({ stagingRoot, unitDirectory, sudoersPath }) => {
  const entries = [];
  const unitsRoot = stagingFile(stagingRoot, "units");
  if (existsSync(unitsRoot)) {
    const visit = (path) => {
      for (const name of readdirSync(path)) {
        const child = join(path, name);
        const status = statSync(child);
        if (status.isDirectory()) visit(child);
        else if (name === "os-isolation.conf" && child.includes(".service.d")) {
          const relativePath = child.slice(unitsRoot.length + 1);
          const targetPath = join(unitDirectory, relativePath);
          const existed = existsSync(targetPath);
          entries.push({
            kind: "drop-in",
            unit: relativePath.slice(0, relativePath.indexOf(".service.d") + ".service".length),
            path: targetPath,
            stagedPath: child,
            existed,
            mode: existed ? statSync(targetPath).mode & 0o777 : 0o644,
            originalUid: existed ? statSync(targetPath).uid : null,
            originalGid: existed ? statSync(targetPath).gid : null,
            parentExisted: existsSync(dirname(targetPath)),
            backupPath: existed ? join(stagingRoot, "backups", safeServiceFileName(relativePath)) : null,
            originalSha256: existed ? sha256(readFileSync(targetPath)) : null,
            installedSha256: sha256(readFileSync(child)),
          });
        }
      }
    };
    visit(unitsRoot);
  }
  const stagedSudoers = stagingFile(stagingRoot, "sudoers/anneal-service-control");
  if (existsSync(stagedSudoers)) {
    const existed = existsSync(sudoersPath);
    const originalStatus = existed ? statSync(sudoersPath) : null;
    entries.push({
      kind: "sudoers",
      path: sudoersPath,
      stagedPath: stagedSudoers,
      existed,
      mode: existed ? statSync(sudoersPath).mode & 0o777 : 0o440,
      originalUid: originalStatus?.uid ?? null,
      originalGid: originalStatus?.gid ?? null,
      backupPath: existed ? join(stagingRoot, "backups", "anneal-service-control") : null,
      originalSha256: existed ? sha256(readFileSync(sudoersPath)) : null,
      installedSha256: sha256(readFileSync(stagedSudoers)),
    });
  }
  return entries;
};

const linuxServiceValues = ({ root, inventory, nodeBinary, path, serviceUser, wrapper }) => Object.freeze(Object.fromEntries(
  inventory.labels.map((label) => {
    const values = servicePlistValues({
      label,
      inventory,
      nodeBinary,
      repositoryRoot: root,
      sharedRoot: join(root, "shared"),
      stdoutPath: join(root, "shared", "logs", `${safeServiceFileName(label)}.stdout.log`),
      stderrPath: join(root, "shared", "logs", `${safeServiceFileName(label)}.stderr.log`),
      path,
      wrapperPath: wrapper,
    });
    return [label, Object.freeze({ ...values, serviceUser })];
  }),
));

const SERVICE_INSTALLER_UNCHANGED = Object.freeze({
  darwin: "PLAN no files or launchd state changed",
  linux: "PLAN no files or systemd state changed",
});
const LAUNCHD_ACTIVATION_NOTICE = "NEXT reload each service plist with launchctl, then run the wrapper inventory readiness check";

/** The phase word an installer invocation performed. A revert names itself
 * even when it only planned; an invocation that changed nothing is a plan. */
const installerPhase = ({ revert = false, applied }) => revert ? "REVERT" : applied ? "APPLY" : "PLAN";

/** The privileged systemd step that remains after an unprivileged stage,
 * spelled except for the entrypoint path only the caller knows. */
const privilegedStageCommand = ({ deployRole, runnerIdPrefix, serviceUser, revert }) => Object.freeze({
  environment: `${deployRole === DEFAULT_DEPLOY_ROLE ? "" : `AGENTOS_DEPLOY_ROLE=${deployRole} `}${runnerIdPrefix
    ? `AGENTOS_RUNNER_ID_PREFIX=${shellQuote(runnerIdPrefix)} `
    : ""}`,
  options: `--install-units${revert ? " --revert" : ""} --service-user ${shellQuote(serviceUser)}`,
});

const systemdInstallerReport = ({ unitDirectory, units, staging }) => [
  ["platform", "linux"],
  ["unit-directory", unitDirectory],
  ["units", String(units.length)],
  ["staging", staging],
];

/** The plan an operator reads before `--apply`. Every runner definition names
 * where its effective RUNNER_PATH comes from, so a value that would defeat
 * `shared/.env` is visible before it is written. */
const launchdInstallerReport = ({ wrapper, entries, runnerPathSources = [] }) => [
  ["service-wrapper", wrapper],
  ["service-definitions", String(entries.length)],
  ...runnerPathSources.map(({ label, source }) => ["runner-path-source", `${label}=${source}`]),
];

/** The one outcome both platforms return. It names the phase performed, the
 * report a caller prints under that phase word, the notice this installer can
 * spell itself, and the privileged command that remains. Callers read these
 * fields; nobody recomputes the phase from the options it was given. */
const serviceInstallerOutcome = ({ platform, revert = false, applied, report, remaining = null, ...detail }) => Object.freeze({
  phase: installerPhase({ revert, applied }),
  platform,
  applied,
  report: Object.freeze(report.map((fact) => Object.freeze(fact))),
  notice: applied
    ? (platform === "darwin" && !revert ? LAUNCHD_ACTIVATION_NOTICE : null)
    : SERVICE_INSTALLER_UNCHANGED[platform],
  remaining,
  ...detail,
});

const systemdStagePlan = ({
  repositoryRoot,
  nodeBinary = process.execPath,
  gitBinary = null,
  path = null,
  serviceUser,
  inventory,
  stagingRoot,
  unitDirectory = SYSTEMD_UNIT_DIRECTORY,
  sudoersPath = SYSTEMD_SUDOERS_PATH,
  systemctlPath = "/bin/systemctl",
  visudoPath = null,
  userLookup = null,
  execute = execFileSync,
  apply,
  replaceExisting = false,
} = {}) => {
  const root = realpathSync(resolve(repositoryRoot ?? REPOSITORY_ROOT));
  const resolvedNode = resolve(nodeBinary);
  const resolvedGit = gitBinary ? resolve(gitBinary) : resolvedNode;
  const controlledPath = path ?? controlledLaunchdPath({ nodeBinary: resolvedNode, gitBinary: resolvedGit });
  const account = resolveSystemdServiceUser({ serviceUser, platform: "linux", lookup: userLookup, execute });
  if (!Array.isArray(inventory?.entries) || inventory.entries.length === 0) {
    throw new Error("systemd-service-inventory-invalid");
  }
  const { runnerCount, runnerIdPrefix, deployRole } = inventory;
  const wrapper = serviceWrapperPath(root);
  const resolvedUnitDirectory = resolve(unitDirectory);
  const resolvedSudoersPath = resolve(sudoersPath);
  const manifestPath = systemdManifestPath(root);
  const previousManifest = existsSync(manifestPath)
    ? readJsonFile(manifestPath, "systemd-service-manifest-invalid")
    : null;
  const previousValidated = previousManifest
    ? readStageEntries({
        manifest: previousManifest,
        manifestPath,
        root,
        unitDirectory: resolvedUnitDirectory,
        sudoersPath: resolvedSudoersPath,
        serviceUser: account,
        runnerIdPrefix,
        deployRole,
        userLookup,
        execute,
      })
    : null;
  const requestedStageRoot = resolve(stagingRoot ?? join(root, SERVICE_INSTALL_ROOT, "staging"));
  const previousStageRoot = previousValidated?.stageRoot ?? null;
  const stageRoot = previousManifest && requestedStageRoot === previousStageRoot
    ? join(root, SERVICE_INSTALL_ROOT, `staging-${randomUUID()}`)
    : requestedStageRoot;
  assertContainedPath(stageRoot, join(root, SERVICE_INSTALL_ROOT));
  const previousByPath = new Map(previousManifest?.entries.map((entry) => [entry.path, entry]) ?? []);
  if (previousManifest) {
    for (const entry of [...previousManifest.entries, ...previousManifest.auxiliaryEntries]) {
      const currentSha = fileDigest(entry.path);
      if (!existsSync(entry.path)
          || (currentSha !== entry.installedSha256 && currentSha !== entry.previousInstalledSha256)) {
        throw new Error(`systemd-service-definition-drift:${entry.path}`);
      }
    }
  }
  const rendered = linuxServiceValues({
    root,
    inventory,
    nodeBinary: resolvedNode,
    path: controlledPath,
    serviceUser: account,
    wrapper,
  });
  const unitDefinitions = Object.freeze(Object.fromEntries(inventory.labels.map((label) => [
    label,
    renderServiceSystemdUnit(readFileSync(SYSTEMD_SERVICE_TEMPLATE, "utf8"), rendered[label]),
  ])));
  verifySystemdServiceDefinitions(unitDefinitions, inventory);
  const unitPaths = inventory.entries.map(({ unitName }) => join(resolvedUnitDirectory, unitName));
  if (!apply) return serviceInstallerOutcome({
    platform: "linux",
    applied: false,
    report: systemdInstallerReport({ unitDirectory: resolvedUnitDirectory, units: unitPaths, staging: stageRoot }),
    staging: stageRoot,
    unitDirectory: resolvedUnitDirectory,
    runnerIdPrefix,
    deployRole,
    serviceUser: account,
    units: unitPaths,
    wrapper,
    entries: [wrapper, ...unitPaths],
    rendered: unitDefinitions,
  });
  const unitEntries = inventory.entries.map(({ label, unitName }) => {
    const target = join(resolvedUnitDirectory, unitName);
    const owned = previousByPath.get(target);
    const currentContents = owned ? readFileSync(target, "utf8") : null;
    const matchesCanonical = owned
      && withoutLegacySystemdRunnerCount(currentContents)
        === withoutLegacySystemdRunnerCount(unitDefinitions[label]);
    const contents = matchesCanonical ? currentContents : unitDefinitions[label];
    const staged = stageSystemdDefinition({
      stagingRoot: stageRoot,
      relativePath: `units/${unitName}`,
      contents,
    });
    if (matchesCanonical) return { ...owned, stagedPath: staged, preserved: true };
    if (owned) return {
      ...owned,
      stagedPath: staged,
      installedSha256: sha256(contents),
      previousInstalledSha256: owned.previousInstalledSha256 ?? owned.installedSha256,
      preserved: false,
    };
    return serviceUnitEntry({
      label,
      unit: unitName,
      stagedPath: staged,
      targetPath: target,
      stagingRoot: stageRoot,
    });
  });
  // Stage the wrapper alongside units so a root stage can install the complete
  // manifest atomically. The target is intentionally outside /etc and remains
  // an explicit manifest entry, matching the LaunchAgent installer.
  const wrapperContents = readFileSync(SERVICE_WRAPPER_SOURCE);
  const wrapperTargetExists = existsSync(wrapper);
  const wrapperStagedPath = stageSystemdDefinition({
    stagingRoot: stageRoot,
    relativePath: `wrapper/${SERVICE_WRAPPER_FILE_NAME}`,
    contents: wrapperContents,
    mode: 0o755,
  });
  const generatedWrapperEntry = wrapperEntry({ wrapperPath: wrapper, stagedPath: wrapperStagedPath, stagingRoot: stageRoot });
  const previousWrapperEntry = previousByPath.get(wrapper);
  const wrapperManifestEntry = previousWrapperEntry
    ? {
        ...previousWrapperEntry,
        stagedPath: wrapperStagedPath,
        installedSha256: generatedWrapperEntry.installedSha256,
        ...(previousWrapperEntry.installedSha256 === generatedWrapperEntry.installedSha256
          ? {}
          : { previousInstalledSha256: previousWrapperEntry.previousInstalledSha256
            ?? previousWrapperEntry.installedSha256 }),
      }
    : generatedWrapperEntry;
  if (wrapperTargetExists && !previousWrapperEntry
      && fileDigest(wrapper) !== wrapperManifestEntry.installedSha256 && !replaceExisting) {
    throw new Error(`launchd-service-wrapper-conflict:${wrapper}`);
  }
  const sudoers = renderSystemdSudoers({ serviceUser: account, inventory });
  const sudoersStaged = stageSystemdDefinition({
    stagingRoot: stageRoot,
    relativePath: "sudoers/anneal-service-control",
    contents: sudoers,
    mode: 0o440,
  });
  const effectiveVisudo = visudoPath ?? (apply ? systemdCommandPath("visudo", null, execute) : null);
  if (apply && effectiveVisudo) validateSudoers({ path: sudoersStaged, visudoPath: effectiveVisudo, execute });
  const previousAuxiliaryByPath = new Map(previousManifest?.auxiliaryEntries.map((entry) => [entry.path, entry]) ?? []);
  const auxiliaryEntries = auxiliarySystemdEntries({
    stagingRoot: stageRoot,
    unitDirectory: resolvedUnitDirectory,
    sudoersPath: resolvedSudoersPath,
  }).map((entry) => {
    const owned = previousAuxiliaryByPath.get(entry.path);
    return owned ? {
      ...entry,
      existed: owned.existed,
      mode: owned.mode,
      originalUid: owned.originalUid,
      originalGid: owned.originalGid,
      parentExisted: owned.parentExisted,
      backupPath: owned.backupPath,
      originalSha256: owned.originalSha256,
      previousInstalledSha256: owned.previousInstalledSha256 ?? owned.installedSha256,
    } : entry;
  });
  // The generated sudoers was written above and is included by the discovery
  // pass. Do not count it in the primary entries: the service manifest's
  // stable shape is wrapper + one entry per service definition.
  const manifest = {
    schemaVersion: 1,
    platform: "linux",
    repositoryRoot: root,
    serviceUser: account,
    runnerCount,
    stagingRoot: stageRoot,
    unitDirectory: resolvedUnitDirectory,
    sudoersPath: resolvedSudoersPath,
    systemctlPath: SYSTEMCTL_PATH,
    renderInputs: {
      nodeBinary: resolvedNode,
      path: controlledPath,
      runnerCount,
      ...(deployRole === DEFAULT_DEPLOY_ROLE ? {} : { deployRole }),
      ...(runnerIdPrefix === "" ? {} : { runnerIdPrefix }),
    },
    entries: [wrapperManifestEntry, ...unitEntries],
    auxiliaryEntries,
    ...(previousManifest ? {
      reinstall: true,
      previousManifest: previousManifest.previousManifest ?? previousManifest,
      previousTransactionFingerprint: previousManifest.previousTransactionFingerprint
        ?? systemdTransactionFingerprint(previousManifest),
    } : {}),
    ...(() => {
      const desiredPaths = new Set(unitEntries.map(({ path: entryPath }) => entryPath));
      const retiredEntries = [
        ...(previousManifest?.entries ?? []),
        ...(previousManifest?.retiredEntries ?? []),
      ].filter((entry, index, candidates) => entry.kind === "service" && !desiredPaths.has(entry.path)
        && candidates.findIndex((candidate) => candidate.path === entry.path) === index);
      return retiredEntries.length === 0 ? {} : { retiredEntries };
    })(),
    ...((previousManifest?.reloadPending === true
      || (previousManifest?.entries ?? []).some((entry) => entry.kind === "service"
        && !new Set(unitEntries.map(({ path: entryPath }) => entryPath)).has(entry.path)))
      ? { reloadPending: true }
      : {}),
  };
  const previouslyOwnedPaths = new Set([
    ...(previousManifest?.entries ?? []),
    ...(previousManifest?.auxiliaryEntries ?? []),
  ].map(({ path: entryPath }) => entryPath));
  for (const entry of [...manifest.entries, ...auxiliaryEntries]) {
    if (entry.preserved) {
      if (fileDigest(entry.path) !== entry.installedSha256) {
        throw new Error(`systemd-service-definition-drift:${entry.path}`);
      }
    } else if (previouslyOwnedPaths.has(entry.path)) {
      const previousEntry = [...previousManifest.entries, ...previousManifest.auxiliaryEntries]
        .find((candidate) => candidate.path === entry.path);
      const currentSha = fileDigest(entry.path);
      if (currentSha !== previousEntry.installedSha256
          && currentSha !== previousEntry.previousInstalledSha256) {
        throw new Error(`systemd-service-definition-drift:${entry.path}`);
      }
    } else {
      stageFileEntry({ entry, replaceExisting: replaceExisting || previouslyOwnedPaths.has(entry.path) });
    }
    backupSystemdTarget({ stagingRoot: stageRoot, entry });
  }
  // The wrapper is operator-owned and is therefore installed by stage one.
  // The privileged stage verifies this digest but never mutates this path.
  if (!existsSync(wrapper) || fileDigest(wrapper) !== sha256(wrapperContents)) {
    writeAtomic(wrapper, wrapperContents, 0o755);
  }
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return serviceInstallerOutcome({
    platform: "linux",
    applied: true,
    report: systemdInstallerReport({ unitDirectory: resolvedUnitDirectory, units: unitEntries, staging: stageRoot }),
    remaining: privilegedStageCommand({ deployRole, runnerIdPrefix, serviceUser: account, revert: false }),
    staging: stageRoot,
    unitDirectory: resolvedUnitDirectory,
    serviceUser: account,
    runnerIdPrefix,
    deployRole,
    units: unitEntries.map((entry) => entry.path),
    wrapper,
    entries: manifest.entries.map((entry) => entry.path),
    manifest,
    manifestPath,
  });
};

export const installStagedSystemdServices = ({
  repositoryRoot,
  manifestPath,
  unitDirectory = SYSTEMD_UNIT_DIRECTORY,
  sudoersPath = SYSTEMD_SUDOERS_PATH,
  systemctlPath = null,
  execute = execFileSync,
  serviceUser,
  environment = process.env,
  inventory = resolveServiceInventory(environment),
  userLookup = null,
  visudoPath = null,
  chown = chownSync,
  effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : process.getuid(),
  revert = false,
  apply = true,
  } = {}) => {
  const platform = resolveServicePlatform();
  if (platform !== "linux") throw new Error("systemd-installer-unsupported:darwin");
  if (effectiveUid !== 0) throw new Error("systemd-installer-requires-root");
  const root = realpathSync(resolve(repositoryRoot ?? REPOSITORY_ROOT));
  const path = manifestPath ?? systemdManifestPath(root);
  if (!existsSync(path)) throw new Error("systemd-service-manifest-missing");
  const manifestStatus = statSync(path);
  const manifestOwnership = { uid: manifestStatus.uid, gid: manifestStatus.gid };
  const manifestMode = manifestStatus.mode & 0o777;
  const writeServiceManifest = (contents) => writeAtomic(path, contents, manifestMode, manifestOwnership, chown);
  const manifest = readJsonFile(path, "systemd-service-manifest-invalid");
  const recordedDeployRole = manifest?.renderInputs?.deployRole ?? DEFAULT_DEPLOY_ROLE;
  if (recordedDeployRole !== inventory.deployRole) throw new Error("systemd-deploy-role-manifest-mismatch");
  const reason = "systemd-service-manifest-invalid";
  const recordedUnitDirectory = manifestStringField({ manifest, reason, manifestPath: path, field: "unitDirectory" });
  const recordedSudoersPath = manifestStringField({ manifest, reason, manifestPath: path, field: "sudoersPath" });
  const resolvedUnitDirectory = resolve(unitDirectory ?? recordedUnitDirectory);
  const resolvedSudoersPath = resolve(sudoersPath ?? recordedSudoersPath);
  const validated = readStageEntries({
    manifest,
    manifestPath: path,
    root,
    unitDirectory: resolvedUnitDirectory,
    sudoersPath: resolvedSudoersPath,
    serviceUser,
    runnerIdPrefix: inventory.runnerIdPrefix,
    deployRole: inventory.deployRole,
    userLookup,
    execute,
  });
  const entries = validated.entries;
  const systemctl = systemctlPath ?? systemdCommandPath("systemctl", null, execute);
  if (!apply) return serviceInstallerOutcome({
    platform: "linux",
    applied: false,
    report: systemdInstallerReport({
      unitDirectory: resolvedUnitDirectory,
      units: validated.inventory.entries,
      staging: validated.stageRoot,
    }),
    staging: validated.stageRoot,
    unitDirectory: resolvedUnitDirectory,
    units: validated.inventory.entries.map(({ unitName }) => unitName),
    entries: entries.map((entry) => entry.path),
  });
  for (const entry of entries) {
    recognizeInstalledEntry({ entry, reason: "systemd-service" });
    if (!revert) assertStagedSource(entry);
  }
  const transactionStatePath = join(resolvedUnitDirectory, ".anneal-service-transaction.json");
  let previousTransactionStateContents = null;
  let transactionState;
  if (!revert && manifest.reinstall === true) {
    if (!manifest.previousManifest
        || manifest.previousTransactionFingerprint !== systemdTransactionFingerprint(manifest.previousManifest)) {
      throw new Error("systemd-service-manifest-invalid");
    }
    if (!existsSync(transactionStatePath)) {
      throw new Error(`systemd-transaction-state-missing:${transactionStatePath}`);
    }
    previousTransactionStateContents = readFileSync(transactionStatePath);
    const previousEntries = [
      ...manifest.previousManifest.entries,
      ...(manifest.previousManifest.auxiliaryEntries ?? []),
    ];
    const previousState = rootTransactionState({
      statePath: transactionStatePath,
      manifest: manifest.previousManifest,
      entries: previousEntries,
      systemctlPath: systemctl,
      execute,
      requireExisting: true,
    });
    transactionState = {
      schemaVersion: 1,
      fingerprint: systemdTransactionFingerprint(manifest),
      entries: entries.filter((entry) => entry.kind !== "wrapper").map((entry) => {
        const prior = previousState.entries.find((candidate) => candidate.path === entry.path);
        if (prior) return prior;
        const existed = existsSync(entry.path);
        const status = existed ? statSync(entry.path) : null;
        return {
          path: entry.path,
          existed,
          mode: status ? status.mode & 0o777 : null,
          uid: status?.uid ?? null,
          gid: status?.gid ?? null,
          contents: existed ? readFileSync(entry.path).toString("base64") : null,
          unitState: existed && entry.unit ? systemdUnitState({ systemctlPath: systemctl, unit: entry.unit, execute }) : null,
        };
      }),
    };
  } else {
    transactionState = rootTransactionState({
      statePath: transactionStatePath,
      manifest,
      entries,
      systemctlPath: systemctl,
      execute,
      requireExisting: revert,
    });
  }
  if (!revert) {
    const effectiveVisudo = visudoPath ?? systemdCommandPath("visudo", null, execute);
    validateSudoers({
      path: manifest.auxiliaryEntries.find((entry) => entry.kind === "sudoers").stagedPath,
      visudoPath: effectiveVisudo,
      execute,
    });
    const wrapperEntry = manifest.entries[0];
    if (fileDigest(wrapperEntry.path) !== wrapperEntry.installedSha256) {
      throw new Error(`systemd-wrapper-drift:${wrapperEntry.path}`);
    }
    for (const retired of [...validated.retiredEntries]) {
      runSystemctl({
        systemctlPath: systemctl,
        args: ["disable", "--now", retired.unit],
        unit: retired.unit,
        execute,
      });
      const contents = readFileSync(retired.path);
      try { rmSync(retired.path); } catch { throw new Error(`systemd-service-removal-failed:${retired.unit}`); }
      manifest.retiredEntries = manifest.retiredEntries.filter((entry) => entry.path !== retired.path);
      try {
        writeServiceManifest(`${JSON.stringify(manifest, null, 2)}\n`);
      } catch (error) {
        writeAtomic(retired.path, contents, retired.mode ?? 0o644);
        throw new Error(`systemd-service-manifest-update-failed:${retired.unit}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const changedEntries = entries.filter((candidate) => candidate.kind !== "wrapper"
      && (manifest.reinstall !== true || fileDigest(candidate.path) !== candidate.installedSha256));
    for (const entry of changedEntries) copyStagedEntry({
      entry,
      unitDirectory: resolvedUnitDirectory,
      sudoersPath: resolvedSudoersPath,
      strictOwner: typeof process.geteuid !== "function" || process.geteuid() === 0,
      chown,
    });
    const changedPaths = new Set(changedEntries.map(({ path: entryPath }) => entryPath));
    const activationPaths = new Set(manifest.entries
      .filter((entry) => entry.kind === "service" && (!entry.preserved || changedPaths.has(entry.path)))
      .map(({ path: entryPath }) => entryPath));
    if (manifest.reloadPending === true || validated.retiredEntries.length > 0
        || changedEntries.length > 0 || activationPaths.size > 0) {
      runSystemctl({ systemctlPath: systemctl, args: ["daemon-reload"], execute });
    }
    for (const unit of validated.retiredUnits) {
      assertSystemdUnitNotFound({ systemctlPath: systemctl, unit, execute });
    }
    for (const entry of manifest.entries.filter((item) => item.kind === "service" && activationPaths.has(item.path))) {
      runSystemctl({ systemctlPath: systemctl, args: ["enable", "--now", entry.unit], unit: entry.unit, execute });
    }
    if (manifest.reinstall === true) {
      const completedManifest = { ...manifest };
      completedManifest.entries = completedManifest.entries.map((entry) => {
        const completedEntry = { ...entry };
        delete completedEntry.preserved;
        delete completedEntry.previousInstalledSha256;
        return completedEntry;
      });
      completedManifest.auxiliaryEntries = completedManifest.auxiliaryEntries.map((entry) => {
        const completedEntry = { ...entry };
        delete completedEntry.previousInstalledSha256;
        return completedEntry;
      });
      delete completedManifest.reinstall;
      delete completedManifest.previousManifest;
      delete completedManifest.previousTransactionFingerprint;
      delete completedManifest.retiredEntries;
      delete completedManifest.reloadPending;
      const completedTransactionState = {
        ...transactionState,
        fingerprint: systemdTransactionFingerprint(completedManifest),
      };
      writeAtomic(transactionStatePath, `${JSON.stringify(completedTransactionState, null, 2)}\n`, 0o600);
      try {
        writeServiceManifest(`${JSON.stringify(completedManifest, null, 2)}\n`);
      } catch (error) {
        writeAtomic(transactionStatePath, previousTransactionStateContents, 0o600);
        throw new Error(`systemd-service-manifest-update-failed:complete:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return serviceInstallerOutcome({
      platform: "linux",
      applied: true,
      report: systemdInstallerReport({
        unitDirectory: resolvedUnitDirectory,
        units: validated.inventory.entries,
        staging: validated.stageRoot,
      }),
      staging: validated.stageRoot,
      unitDirectory: resolvedUnitDirectory,
      runnerIdPrefix: manifest.renderInputs?.runnerIdPrefix ?? "",
      deployRole: manifest.renderInputs?.deployRole ?? DEFAULT_DEPLOY_ROLE,
      units: validated.inventory.entries.map(({ unitName }) => unitName),
      entries: entries.map((entry) => entry.path),
    });
  }
  if (manifest.wrapperReverted !== true) throw new Error("systemd-wrapper-revert-required");
  const serviceEntries = manifest.entries.filter((entry) => entry.kind === "service");
  for (const entry of serviceEntries) {
    const stateEntry = transactionState.entries.find((candidate) => candidate.path === entry.path);
    runSystemctl({
      systemctlPath: systemctl,
      args: stateEntry?.existed ? ["stop", entry.unit] : ["disable", "--now", entry.unit],
      unit: entry.unit,
      execute,
    });
  }
  for (const [index, entry] of entries.filter((candidate) => candidate.kind !== "wrapper").entries()) {
    const stateEntry = transactionState.entries[index];
    restoreRootTransactionEntry(entry, stateEntry);
    if (!stateEntry.existed) {
      if (entry.kind === "drop-in" && entry.parentExisted === false) {
        try { rmdirSync(dirname(entry.path)); } catch (error) {
          if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
        }
      }
    }
    if (entry.backupPath) rmSync(entry.backupPath, { force: true });
  }
  runSystemctl({ systemctlPath: systemctl, args: ["daemon-reload"], execute });
  for (const entry of serviceEntries.filter((candidate) => transactionState.entries.find((state) => state.path === candidate.path)?.existed)) {
    const stateEntry = transactionState.entries.find((candidate) => candidate.path === entry.path);
    runSystemctl({
      systemctlPath: systemctl,
      args: [stateEntry?.unitState?.enabled ? "enable" : "disable", entry.unit],
      unit: entry.unit,
      execute,
    });
    runSystemctl({
      systemctlPath: systemctl,
      args: [stateEntry?.unitState?.active ? "start" : "stop", entry.unit],
      unit: entry.unit,
      execute,
    });
  }
  rmSync(path, { force: true });
  rmSync(transactionStatePath, { force: true });
  rmSync(validated.stageRoot, { recursive: true, force: true });
  return serviceInstallerOutcome({
    platform: "linux",
    revert: true,
    applied: true,
    report: systemdInstallerReport({
      unitDirectory: resolvedUnitDirectory,
      units: validated.inventory.entries,
      staging: validated.stageRoot,
    }),
    staging: validated.stageRoot,
    unitDirectory: resolvedUnitDirectory,
    units: validated.inventory.entries.map(({ unitName }) => unitName),
    entries: entries.map((entry) => entry.path),
  });
};

const installLinuxServices = (options = {}) => {
  const platform = resolveServicePlatform();
  if (platform !== "linux") throw new Error("systemd-installer-unsupported:darwin");
  const { installUnits = false, revert = false, apply = false } = options;
  if (installUnits) {
    if (options.replaceExisting) throw new Error("installer-option-invalid:--replace-existing-with-install-units");
    return installStagedSystemdServices({ ...options, apply: true });
  }
  if (revert) {
    const root = realpathSync(resolve(options.repositoryRoot ?? REPOSITORY_ROOT));
    const path = options.manifestPath ?? systemdManifestPath(root);
    if (!existsSync(path)) throw new Error("systemd-service-manifest-missing");
    const manifest = readJsonFile(path, "systemd-service-manifest-invalid");
    const reason = "systemd-service-manifest-invalid";
    const recordedUnitDirectory = manifestStringField({ manifest, reason, manifestPath: path, field: "unitDirectory" });
    const recordedSudoersPath = manifestStringField({ manifest, reason, manifestPath: path, field: "sudoersPath" });
    const resolvedUnitDirectory = resolve(options.unitDirectory ?? recordedUnitDirectory);
    const resolvedSudoersPath = resolve(options.sudoersPath ?? recordedSudoersPath);
    const validated = readStageEntries({
      manifest,
      manifestPath: path,
      root,
      unitDirectory: resolvedUnitDirectory,
      sudoersPath: resolvedSudoersPath,
      serviceUser: options.serviceUser,
      runnerIdPrefix: options.inventory.runnerIdPrefix,
      deployRole: options.inventory.deployRole,
      userLookup: options.userLookup,
      execute: options.execute ?? execFileSync,
    });
    if (apply) {
      const callerUid = options.effectiveUid
        ?? (typeof process.geteuid === "function" ? process.geteuid() : process.getuid());
      if (callerUid === 0) throw new Error("launchd-installer-refuses-root");
      const wrapper = manifest.entries[0];
      if (fileDigest(wrapper.path) !== wrapper.installedSha256) throw new Error(`systemd-wrapper-drift:${wrapper.path}`);
      if (wrapper.existed) {
        if (!wrapper.backupPath || fileDigest(wrapper.backupPath) !== wrapper.originalSha256) {
          throw new Error(`systemd-service-backup-missing:${wrapper.path}`);
        }
        writeAtomic(wrapper.path, readFileSync(wrapper.backupPath), wrapper.mode ?? 0o755);
      } else rmSync(wrapper.path, { force: true });
      manifest.wrapperReverted = true;
      writeAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    }
    return serviceInstallerOutcome({
      platform: "linux",
      revert: true,
      applied: apply,
      report: systemdInstallerReport({
        unitDirectory: resolvedUnitDirectory,
        units: validated.inventory.entries,
        staging: validated.stageRoot,
      }),
      remaining: apply
        ? privilegedStageCommand({
            deployRole: validated.inventory.deployRole,
            runnerIdPrefix: validated.inventory.runnerIdPrefix,
            serviceUser: manifest.serviceUser,
            revert: true,
          })
        : null,
      staging: validated.stageRoot,
      unitDirectory: resolvedUnitDirectory,
      runnerIdPrefix: validated.inventory.runnerIdPrefix,
      deployRole: validated.inventory.deployRole,
      units: validated.inventory.entries.map(({ unitName }) => unitName),
      entries: validated.entries.map((entry) => entry.path),
    });
  }
  const callerUid = options.effectiveUid
    ?? (typeof process.geteuid === "function" ? process.geteuid() : process.getuid());
  if (callerUid === 0) throw new Error("launchd-installer-refuses-root");
  return systemdStagePlan(options);
};

const validateServiceManifest = (manifest, repositoryRoot, manifestPath, deployRole = DEFAULT_DEPLOY_ROLE) => {
  const reason = "launchd-service-manifest-invalid";
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || manifest.schemaVersion !== 1 || manifest.repositoryRoot !== resolve(repositoryRoot)) {
    invalidManifest(reason, manifestPath);
  }
  validateManifestEntryArrays({
    manifest,
    reason,
    manifestPath,
    arrays: [
      {
        arrayName: "entries",
        required: true,
        requireLabel: (entries) => {
          const legacyServiceEntries = entries.slice(1).every((entry) =>
            entry && typeof entry === "object" && !Array.isArray(entry) && !Object.hasOwn(entry, "label"));
          return (_entry, index) => index > 0 && !legacyServiceEntries;
        },
      },
      {
        arrayName: "retiredEntries",
        required: false,
        requireLabel: (entries) => {
          const legacyRetiredEntries = entries.every((entry) =>
            entry && typeof entry === "object" && !Array.isArray(entry) && !Object.hasOwn(entry, "label"));
          return () => !legacyRetiredEntries;
        },
      },
    ],
  });
  // A manifest without renderInputs was written by the installer only while it
  // rendered the default inventory, and the entry count is checked against the
  // regenerated inventory below rather than being decoded from it.
  const renderInputs = validateManifestRenderInputs({
    manifest,
    reason,
    manifestPath,
    fallbackRunnerCount: DEFAULT_RUNNER_COUNT,
  });
  const { runnerCount, runnerIdPrefix } = renderInputs;
  const recordedDeployRole = renderInputs.deployRole ?? DEFAULT_DEPLOY_ROLE;
  if (recordedDeployRole !== deployRole) throw new Error("launchd-deploy-role-manifest-mismatch");
  let inventory;
  try {
    inventory = generateServiceInventory({ runnerCount, runnerIdPrefix, deployRole });
  } catch { invalidManifest(reason, manifestPath, "renderInputs"); }
  if (manifest.entries.length !== inventory.entries.length + 1) {
    invalidManifest(reason, manifestPath, "entries");
  }
  return { manifest, inventory };
};

const launchdServiceIsLoaded = ({ label, target, execute }) => {
  try {
    execute("/bin/launchctl", ["print", `${target}/${label}`], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    if (error?.status === 113 && String(error.stderr ?? "").includes("Could not find service")) return false;
    throw new Error(`launchd-service-query-failed:${label}`);
  }
};

/** Install all service plists and one standalone wrapper. Reinstall may unload
 * retired services or restart changed definitions; release pointer activation
 * and readiness verification remain a separate rollout step. */
export const installLaunchdServices = ({
  repositoryRoot,
  userHome,
  nodeBinary = process.execPath,
  gitBinary = null,
  path = null,
  apply = false,
  revert = false,
  replaceExisting = false,
  installUnits = false,
  serviceUser,
  stagingRoot,
  unitDirectory,
  sudoersPath,
  systemctlPath,
  visudoPath,
  chown,
  userLookup,
  effectiveUid,
  environment = process.env,
  cliLookup = null,
  execute = execFileSync,
} = {}) => {
  // The one inventory this invocation installs, reverts or plans. Every
  // definition, unit name, plist name and runner id below is read out of it.
  const inventory = resolveServiceInventory(environment);
  const { deployRole, runnerCount, runnerIdPrefix } = inventory;
  const platform = resolveServicePlatform();
  if (platform === "linux") return installLinuxServices({
    repositoryRoot,
    nodeBinary,
    gitBinary,
    path,
    apply,
    revert,
    replaceExisting,
    installUnits,
    serviceUser,
    stagingRoot,
    unitDirectory,
    sudoersPath,
    systemctlPath,
    visudoPath,
    chown,
    userLookup,
    effectiveUid,
    environment,
    inventory,
    execute,
  });
  const callerUid = effectiveUid
    ?? (typeof process.geteuid === "function" ? process.geteuid() : process.getuid());
  if (callerUid === 0) {
    throw new Error("launchd-installer-refuses-root");
  }
  if (installUnits) throw new Error("systemd-installer-unsupported:darwin");
  if (serviceUser !== undefined && serviceUser !== null) throw new Error("systemd-service-user-not-supported-on-darwin");
  const root = realpathSync(resolve(repositoryRoot ?? REPOSITORY_ROOT));
  const home = resolve(userHome ?? homedir());
  const launchAgents = join(home, "Library/LaunchAgents");
  const logs = join(home, "Library/Logs/Anneal");
  const sharedRoot = join(root, "shared");
  const wrapper = serviceWrapperPath(root);
  const manifestPath = serviceManifestPath(root);
  if (revert) {
    if (!existsSync(manifestPath)) throw new Error("launchd-service-manifest-missing");
    const { manifest } = validateServiceManifest(
      readJsonFile(manifestPath, "launchd-service-manifest-invalid"), root, manifestPath, deployRole,
    );
    const observed = new Map(manifest.entries.map((entry) => [
      entry.path,
      recognizeInstalledEntry({ entry, reason: "launchd-service" }),
    ]));
    if (!apply) return serviceInstallerOutcome({
      platform: "darwin",
      revert: true,
      applied: false,
      report: launchdInstallerReport({ wrapper, entries: manifest.entries }),
      deployRole,
      wrapper,
      entries: manifest.entries.map((entry) => entry.path),
    });
    for (const entry of manifest.entries) {
      if (entry.existed) {
        if (observed.get(entry.path) !== entry.originalSha256) {
          const backup = readFileSync(entry.backupPath);
          writeAtomic(entry.path, backup, entry.mode ?? 0o600);
        }
      } else rmSync(entry.path, { force: true });
      if (entry.backupPath) rmSync(entry.backupPath, { force: true });
    }
    rmSync(manifestPath, { force: true });
    return serviceInstallerOutcome({
      platform: "darwin",
      revert: true,
      applied: true,
      report: launchdInstallerReport({ wrapper, entries: manifest.entries }),
      deployRole,
      wrapper,
      entries: manifest.entries.map((entry) => entry.path),
    });
  }
  const resolvedNode = resolve(nodeBinary);
  const resolvedGit = gitBinary ? resolve(gitBinary) : resolvedNode;
  const controlledPath = path ?? controlledLaunchdPath({ nodeBinary: resolvedNode, gitBinary: resolvedGit });
  // The runner role is the one this host installs runner definitions for on
  // purpose; its definitions must not carry a RUNNER_PATH that cannot reach a
  // provider CLI, and must not carry one at all when shared/.env defines it.
  const runnerPathPlan = deployRole === "runner"
    ? resolveRunnerPathPlan({
        path: controlledPath,
        sharedValues: existsSync(join(sharedRoot, ".env"))
          ? parseSharedEnvironment(readFileSync(join(sharedRoot, ".env"), "utf8"))
          : {},
        environment,
        lookup: cliLookup ?? providerCliLookup(environment, execute),
      })
    : null;
  const runnerPathSources = runnerPathPlan
    ? inventory.entries.filter(({ runnerId }) => runnerId)
      .map(({ label }) => ({ label, source: runnerPathPlan.source }))
    : [];
  const logPath = (label, stream) => join(logs, `${safeServiceFileName(label)}.${stream}.log`);
  const previous = existsSync(manifestPath)
    ? validateServiceManifest(
        readJsonFile(manifestPath, "launchd-service-manifest-invalid"), root, manifestPath, deployRole,
      )
    : null;
  if (previous && previous.inventory.runnerIdPrefix !== runnerIdPrefix) {
    throw new Error("launchd-runner-id-prefix-manifest-mismatch");
  }
  const rendered = Object.freeze(Object.fromEntries(inventory.entries.map(({ label, plistName }) => {
    const values = servicePlistValues({
      label,
      inventory,
      nodeBinary: resolvedNode,
      repositoryRoot: root,
      sharedRoot,
      stdoutPath: logPath(label, "stdout"),
      stderrPath: logPath(label, "stderr"),
      path: controlledPath,
      ...(runnerPathPlan ? { runnerPath: runnerPathPlan.runnerPath } : {}),
      wrapperPath: wrapper,
    });
    const destination = join(launchAgents, plistName);
    return [label, existsSync(destination) && replaceExisting
      ? renderMigratedServicePlist({ sourcePath: destination, values })
      : renderServiceLaunchdPlist(readFileSync(SERVICE_TEMPLATE, "utf8"), values)];
  })));
  verifyServicePlistDefinitions(rendered, inventory);
  const previousByPath = new Map(previous?.manifest.entries.map((entry) => [entry.path, entry]) ?? []);
  const generatedWrapperEntry = {
    path: wrapper,
    existed: existsSync(wrapper),
    mode: existsSync(wrapper) ? statSync(wrapper).mode & 0o777 : 0o755,
    backupPath: existsSync(wrapper)
      ? join(root, SERVICE_INSTALL_ROOT, "backups", SERVICE_WRAPPER_FILE_NAME)
      : null,
    originalSha256: existsSync(wrapper) ? sha256(readFileSync(wrapper)) : null,
    installedSha256: sha256(readFileSync(SERVICE_WRAPPER_SOURCE)),
  };
  const previousWrapperEntry = previousByPath.get(wrapper);
  const entries = [previousWrapperEntry
    ? {
        ...previousWrapperEntry,
        installedSha256: generatedWrapperEntry.installedSha256,
        ...(previousWrapperEntry.installedSha256 === generatedWrapperEntry.installedSha256
          ? {}
          : { previousInstalledSha256: previousWrapperEntry.previousInstalledSha256
            ?? previousWrapperEntry.installedSha256 }),
      }
    : generatedWrapperEntry];
  const changedOwnedLabels = [];
  for (const { label, plistName } of inventory.entries) {
    const destination = join(launchAgents, plistName);
    const owned = previousByPath.get(destination);
    const destinationExists = existsSync(destination);
    const currentContents = owned && destinationExists ? readFileSync(destination, "utf8") : null;
    const currentSha256 = owned && destinationExists ? sha256(currentContents) : null;
    if (owned && !destinationExists && owned.pendingInstall !== true) {
      throw new Error(`launchd-service-definition-drift:${destination}`);
    }
    if (owned && destinationExists && currentSha256 !== owned.installedSha256
        && currentSha256 !== owned.previousInstalledSha256) {
      throw new Error(`launchd-service-definition-drift:${destination}`);
    }
    const matchesCanonical = owned && destinationExists
      && withoutLegacyLaunchdRunnerCount(currentContents)
        === withoutLegacyLaunchdRunnerCount(rendered[label]);
    const pendingApply = owned?.previousInstalledSha256 !== undefined;
    const contents = matchesCanonical ? currentContents : rendered[label];
    if (!owned && existsSync(destination) && readFileSync(destination, "utf8") !== contents && !replaceExisting) {
      throw new Error(`launchd-service-definition-conflict:${destination}`);
    }
    if (owned && destinationExists && (!matchesCanonical || pendingApply)) changedOwnedLabels.push(label);
    entries.push(owned ? {
      ...owned,
      label,
      installedSha256: sha256(contents),
      ...((!matchesCanonical || pendingApply)
        ? { previousInstalledSha256: owned.previousInstalledSha256 ?? owned.installedSha256 }
        : {}),
      contents,
    } : {
      label,
      path: destination,
      existed: existsSync(destination),
      mode: existsSync(destination) ? statSync(destination).mode & 0o777 : 0o600,
      backupPath: existsSync(destination)
        ? join(root, SERVICE_INSTALL_ROOT, "backups", `${safeServiceFileName(label)}.plist`)
        : null,
      originalSha256: existsSync(destination) ? sha256(readFileSync(destination)) : null,
      installedSha256: sha256(contents),
      contents,
    });
  }
  for (const entry of previous ? entries : []) {
    if (fileDigest(entry.path) !== entry.installedSha256) entry.pendingInstall = true;
  }
  const desiredPaths = new Set(entries.map(({ path: entryPath }) => entryPath));
  const retiredEntries = [
    ...(previous?.manifest.entries ?? []),
    ...(previous?.manifest.retiredEntries ?? []),
  ].filter((entry, index, candidates) => !desiredPaths.has(entry.path)
    && candidates.findIndex((candidate) => candidate.path === entry.path) === index)
    .map((entry) => Object.hasOwn(entry, "label") ? entry : {
      ...entry,
      label: entry.path.slice(entry.path.lastIndexOf("/") + 1, -".plist".length),
    });
  for (const entry of retiredEntries) {
    if (entry.existed) throw new Error(`launchd-service-shrink-owned-unit-refused:${entry.path}`);
    if (!existsSync(entry.path) || sha256(readFileSync(entry.path)) !== entry.installedSha256) {
      throw new Error(`launchd-service-definition-drift:${entry.path}`);
    }
  }
  if (!apply) return serviceInstallerOutcome({
    platform: "darwin",
    applied: false,
    report: launchdInstallerReport({ wrapper, entries, runnerPathSources }),
    deployRole,
    wrapper,
    entries: entries.map(({ path: entryPath }) => entryPath),
    rendered,
  });
  if (!existsSync(join(sharedRoot, ".env"))) throw new Error("shared-environment-missing");
  for (const directory of SHARED_RUNTIME_DIRECTORIES) {
    mkdirSync(join(sharedRoot, directory), { recursive: true, mode: 0o700 });
  }
  const bootstrap = bootstrapCurrentRelease({ repositoryRoot: root });
  if (!previousWrapperEntry && existsSync(wrapper)
      && readFileSync(wrapper, "utf8") !== readFileSync(SERVICE_WRAPPER_SOURCE, "utf8") && !replaceExisting) {
    throw new Error(`launchd-service-wrapper-conflict:${wrapper}`);
  }
  mkdirSync(join(root, SERVICE_INSTALL_ROOT, "backups"), { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (!entry.existed || !existsSync(entry.backupPath)) continue;
    if (sha256(readFileSync(entry.backupPath)) !== entry.originalSha256) {
      throw new DeployFailure("launchd-service-backup-conflict", `remove-or-recover:${entry.backupPath}`);
    }
  }
  const manifest = {
    schemaVersion: 1,
    repositoryRoot: root,
    entries: entries.map(({ contents: _contents, ...entry }) => entry),
    ...((runnerCount === DEFAULT_RUNNER_COUNT && runnerIdPrefix === "" && deployRole === DEFAULT_DEPLOY_ROLE) ? {} : {
      renderInputs: {
        nodeBinary: resolvedNode,
        path: controlledPath,
        runnerCount,
        ...(deployRole === DEFAULT_DEPLOY_ROLE ? {} : { deployRole }),
        ...(runnerIdPrefix === "" ? {} : { runnerIdPrefix }),
      },
    }),
    ...(retiredEntries.length === 0 ? {} : { retiredEntries }),
  };
  let installedManifest = manifest;
  if (retiredEntries.length > 0) {
    writeAtomic(manifestPath, `${JSON.stringify(installedManifest, null, 2)}\n`, 0o600);
  }
  for (const entry of retiredEntries) {
    const label = entry.path.slice(entry.path.lastIndexOf("/") + 1, -".plist".length);
    const target = `gui/${callerUid}`;
    if (launchdServiceIsLoaded({ label, target, execute })) {
      try {
        execute("/bin/launchctl", ["bootout", `${target}/${label}`], { stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        throw new Error(`launchd-service-removal-failed:${label}`);
      }
    }
    const contents = readFileSync(entry.path);
    try { rmSync(entry.path); } catch { throw new Error(`launchd-service-removal-failed:${label}`); }
    let stillLoaded;
    try {
      stillLoaded = launchdServiceIsLoaded({ label, target, execute });
    } catch (error) {
      writeAtomic(entry.path, contents, entry.mode ?? 0o600);
      throw error;
    }
    if (stillLoaded) {
      writeAtomic(entry.path, contents, entry.mode ?? 0o600);
      throw new Error(`launchd-service-removal-incomplete:${label}`);
    }
    installedManifest = {
      ...installedManifest,
      retiredEntries: installedManifest.retiredEntries.filter((candidate) => candidate.path !== entry.path),
    };
    try {
      writeAtomic(manifestPath, `${JSON.stringify(installedManifest, null, 2)}\n`, 0o600);
    } catch (error) {
      writeAtomic(entry.path, contents, entry.mode ?? 0o600);
      throw new Error(`launchd-service-manifest-update-failed:${label}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  delete manifest.retiredEntries;
  writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n", 0o600);
  for (const entry of entries) {
    if (entry.existed && !existsSync(entry.backupPath)) {
      writeFileSync(entry.backupPath, readFileSync(entry.path), { flag: "wx", mode: 0o600 });
    }
  }
  if (!existsSync(wrapper) || fileDigest(wrapper) !== fileDigest(SERVICE_WRAPPER_SOURCE)) {
    writeAtomic(wrapper, readFileSync(SERVICE_WRAPPER_SOURCE), 0o755);
  }
  for (const entry of entries.slice(1)) {
    if (!existsSync(entry.path) || sha256(readFileSync(entry.path)) !== entry.installedSha256) {
      writeAtomic(entry.path, entry.contents, 0o600);
    }
  }
  for (const label of changedOwnedLabels) {
    try {
      execute("/bin/launchctl", ["kickstart", "-k", `gui/${callerUid}/${label}`], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      throw new Error(`launchd-service-restart-failed:${label}`);
    }
  }
  if (entries.some(({ previousInstalledSha256, pendingInstall }) => previousInstalledSha256 !== undefined || pendingInstall === true)) {
    manifest.entries = manifest.entries.map((entry) => {
      const completedEntry = { ...entry };
      delete completedEntry.previousInstalledSha256;
      delete completedEntry.pendingInstall;
      return completedEntry;
    });
    writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  }
  return serviceInstallerOutcome({
    platform: "darwin",
    applied: true,
    report: launchdInstallerReport({ wrapper, entries, runnerPathSources }),
    deployRole,
    wrapper,
    bootstrap,
    entries: entries.map(({ path: entryPath }) => entryPath),
  });
};

export const installLaunchd = (args, context = {}) => {
  const deployRole = resolveDeployRole(context.environment ?? process.env);
  const {
    apply,
    installUnits,
    revert,
    serviceUser,
    backup: requestedBackup,
  } = parseInstallerArgs(args, { deployRole });
  const platform = resolveServicePlatform({
    platform: context.platform,
    environment: context.environment ?? process.env,
  });
  if (platform === "linux") {
    if (serviceUser !== undefined && serviceUser !== null) {
      resolveSystemdServiceUser({ serviceUser, platform, lookup: context.userLookup, execute: context.execute ?? execFileSync });
    }
    if (installUnits) {
      const { phase } = installStagedSystemdAutoDeploy({
        repositoryRoot: context.repositoryRoot,
        manifestPath: context.manifestPath,
        unitDirectory: context.unitDirectory,
        sudoersPath: context.sudoersPath,
        systemctlPath: context.systemctlPath,
        execute: context.execute ?? execFileSync,
        chown: context.chown,
        serviceUser,
        environment: context.environment ?? process.env,
        deployRole,
        userLookup: context.userLookup,
        effectiveUid: context.effectiveUid,
        revert,
        apply: true,
      });
      process.stdout.write(`${phase} platform=linux\n`);
      process.stdout.write(`${phase} unit-directory=${context.unitDirectory ?? SYSTEMD_UNIT_DIRECTORY}\n`);
      process.stdout.write(`${phase} units=2\n`);
      process.stdout.write(`${phase} staging=${context.stagingRoot ?? "recorded"}\n`);
      return 0;
    }
    if (revert) {
      const { phase } = installStagedSystemdAutoDeploy({
        repositoryRoot: context.repositoryRoot,
        manifestPath: context.manifestPath,
        unitDirectory: context.unitDirectory,
        sudoersPath: context.sudoersPath,
        systemctlPath: context.systemctlPath,
        execute: context.execute ?? execFileSync,
        serviceUser,
        environment: context.environment ?? process.env,
        deployRole,
        userLookup: context.userLookup,
        effectiveUid: context.effectiveUid,
        revert: true,
        apply,
      });
      process.stdout.write(`${phase} platform=linux\n`);
      process.stdout.write(`${phase} unit-directory=${context.unitDirectory ?? SYSTEMD_UNIT_DIRECTORY}\n`);
      process.stdout.write(`${phase} units=2\n`);
      process.stdout.write(`${phase} staging=${context.stagingRoot ?? "recorded"}\n`);
      if (!apply) process.stdout.write("PLAN no files or systemd state changed\n");
      return 0;
    }
    const callerUid = context.effectiveUid
      ?? (typeof process.geteuid === "function" ? process.geteuid() : process.getuid());
    if (callerUid === 0) throw new Error("launchd-installer-refuses-root");
    const root = realpathSync(resolve(context.repositoryRoot ?? REPOSITORY_ROOT));
    const nodeBinary = realpathSync(context.nodeBinary ?? process.execPath);
    const gitBinary = context.gitBinary ? realpathSync(context.gitBinary) : requiredBinary("git");
    const npmBinary = context.npmBinary ? realpathSync(context.npmBinary) : requiredBinary("npm");
    const values = {
      nodeBinary,
      deployScript: join(root, "current/scripts/deploy/quiet-window-deploy.mjs"),
      repositoryRoot: root,
      sourceRemote: context.sourceRemote ?? execFileSync(gitBinary, ["-C", root, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
      path: context.path ?? controlledLaunchdPath({ nodeBinary, gitBinary }),
      gitBinary,
      npmBinary,
      backup: requestedBackup ? verifyBackupConfiguration(requestedBackup, context.execute ?? execFileSync) : null,
      runnerCount: resolveRunnerCount(context.environment ?? process.env),
      runnerIdPrefix: resolveRunnerIdPrefix(context.environment ?? process.env),
      deployRole,
    };
    if (!values.backup && deployRole !== "runner") throw new Error("backup-configuration-invalid:pg-dump-mode-must-be-host-or-container");
    verifyRenderedToolchain(values, context.execute ?? execFileSync);
    const result = planSystemdAutoDeploy({
      ...values,
      serviceUser,
      repositoryRoot: root,
      stagingRoot: context.stagingRoot,
      unitDirectory: context.unitDirectory,
      sudoersPath: context.sudoersPath,
      apply,
      effectiveUid: context.effectiveUid,
      userLookup: context.userLookup,
      execute: context.execute ?? execFileSync,
      deployRole,
    });
    const { phase } = result;
    process.stdout.write(`${phase} platform=linux\n`);
    process.stdout.write(`${phase} unit-directory=${context.unitDirectory ?? SYSTEMD_UNIT_DIRECTORY}\n`);
    process.stdout.write(`${phase} units=2\n`);
    process.stdout.write(`${phase} staging=${result.staging}\n`);
    if (!apply) process.stdout.write("PLAN no files or systemd state changed\n");
    else {
      const role = deployRole === DEFAULT_DEPLOY_ROLE ? "" : `AGENTOS_DEPLOY_ROLE=${deployRole} `;
      process.stdout.write(`NEXT sudo ${role}node ${shellQuote(process.argv[1])} --install-units --service-user ${shellQuote(serviceUser)}\n`);
    }
    return 0;
  }
  if (installUnits) throw new Error("systemd-installer-unsupported:darwin");
  if (revert) throw new Error("launchd-auto-deploy-revert-unsupported");
  if (serviceUser !== undefined && serviceUser !== null) throw new Error("systemd-service-user-not-supported-on-darwin");
  if (typeof process.geteuid === "function" ? process.geteuid() === 0 : process.getuid() === 0) {
    throw new Error("launchd-installer-refuses-root");
  }
  const userHome = homedir();
  const launchAgents = join(userHome, "Library/LaunchAgents");
  const logs = join(userHome, "Library/Logs/Anneal");
  const destination = join(launchAgents, plistNameForLabel(LABEL));
  const nodeBinary = realpathSync(process.execPath);
  const gitBinary = requiredBinary("git");
  const npmBinary = requiredBinary("npm");
  const values = {
    nodeBinary,
    deployScript: join(realpathSync(REPOSITORY_ROOT), "current/scripts/deploy/quiet-window-deploy.mjs"),
    repositoryRoot: realpathSync(REPOSITORY_ROOT),
    sourceRemote: execFileSync(gitBinary, ["-C", REPOSITORY_ROOT, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
    stdoutPath: join(logs, "auto-deploy.log"),
    stderrPath: join(logs, "auto-deploy.error.log"),
    path: controlledLaunchdPath({ nodeBinary, gitBinary }),
    gitBinary,
    npmBinary,
    backup: requestedBackup ? verifyBackupConfiguration(requestedBackup) : null,
    runnerCount: resolveRunnerCount(),
    runnerIdPrefix: resolveRunnerIdPrefix(),
    deployRole,
  };
  verifyRenderedToolchain(values);
  const rendered = renderLaunchdPlist(readFileSync(TEMPLATE, "utf8"), values);
  const phase = installerPhase({ applied: apply });
  process.stdout.write(`${phase} label=${LABEL}\n`);
  process.stdout.write(`${phase} destination=${destination}\n`);
  process.stdout.write(`${phase} repository=${values.repositoryRoot}\n`);
  process.stdout.write(`${phase} node=${values.nodeBinary}\n`);
  process.stdout.write(`${phase} path=${values.path}\n`);
  process.stdout.write(`${phase} git=${values.gitBinary}\n`);
  process.stdout.write(`${phase} npm=${values.npmBinary}\n`);
  process.stdout.write(`${phase} rendered_toolchain=verified\n`);
  if (values.backup) process.stdout.write(`${phase} pg_dump_mode=${values.backup.mode}\n`);
  if (values.backup?.mode === "host") {
    process.stdout.write(`${phase} pg_dump=${values.backup.pgDumpBinary}\n`);
  } else if (values.backup) {
    process.stdout.write(`${phase} docker=${values.backup.dockerBinary}\n`);
    process.stdout.write(`${phase} pg_dump_container=${values.backup.container}\n`);
    process.stdout.write(`${phase} container_pg_dump=${values.backup.pgDumpBinary}\n`);
  }

  if (!apply) {
    process.stdout.write("PLAN no files or launchd state changed\n");
    return 0;
  } else {
    mkdirSync(launchAgents, { recursive: true, mode: 0o755 });
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    if (existsSync(destination)) {
      if (readFileSync(destination, "utf8") !== rendered) throw new Error(`launchd-definition-conflict:${destination}`);
      process.stdout.write("OK definition already matches\n");
    } else {
      const temporary = `${destination}.${process.pid}.tmp`;
      writeFileSync(temporary, rendered, { flag: "wx", mode: 0o600 });
      chmodSync(temporary, 0o600);
      try {
        execFileSync("/usr/bin/plutil", ["-lint", temporary], { stdio: "inherit" });
        // link(2), not rename-over-existing: a concurrent installer cannot
        // replace an operator-owned definition after this process inspected it.
        linkSync(temporary, destination);
      } finally {
        rmSync(temporary, { force: true });
      }
      process.stdout.write("OK definition installed\n");
    }
    const target = `gui/${process.getuid()}`;
    try {
      execFileSync("/bin/launchctl", ["print", `${target}/${LABEL}`], { stdio: "ignore" });
      execFileSync("/bin/launchctl", ["kickstart", "-k", `${target}/${LABEL}`], { stdio: "inherit" });
      process.stdout.write("OK loaded job restarted\n");
    } catch {
      execFileSync("/bin/launchctl", ["bootstrap", target, destination], { stdio: "inherit" });
      process.stdout.write("OK job bootstrapped\n");
    }
    return 0;
  }
};

const autoDeployStageEntry = ({ path, stagedPath, backupPath = null, mode = 0o644, kind = "auto-deploy" }) => {
  const existed = existsSync(path);
  const originalStatus = existed ? statSync(path) : null;
  return {
    kind,
    path,
    stagedPath,
    existed,
    mode: existed ? statSync(path).mode & 0o777 : mode,
    originalUid: originalStatus?.uid ?? null,
    originalGid: originalStatus?.gid ?? null,
    backupPath: existed ? backupPath : null,
    originalSha256: existed ? sha256(readFileSync(path)) : null,
    installedSha256: sha256(readFileSync(stagedPath)),
  };
};

const autoDeployDefinitionValues = ({
  root,
  nodeBinary,
  gitBinary,
  npmBinary,
  path,
  sourceRemote,
  backup,
  serviceUser,
  runnerCount,
  runnerIdPrefix,
  deployRole,
}) => Object.freeze({
  nodeBinary,
  gitBinary,
  npmBinary,
  path,
  sourceRemote,
  backup,
  serviceUser,
  repositoryRoot: root,
  deployScript: join(root, "current/scripts/deploy/quiet-window-deploy.mjs"),
  runnerCount,
  runnerIdPrefix,
  deployRole,
});

export const planSystemdAutoDeploy = ({
  repositoryRoot,
  nodeBinary,
  gitBinary,
  npmBinary,
  path,
  sourceRemote,
  backup,
  serviceUser,
  stagingRoot,
  unitDirectory = SYSTEMD_UNIT_DIRECTORY,
  sudoersPath = SYSTEMD_SUDOERS_PATH,
  apply = false,
  effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : process.getuid(),
  userLookup = null,
  execute = execFileSync,
  runnerCount = resolveRunnerCount(),
  runnerIdPrefix = resolveRunnerIdPrefix(),
  deployRole = resolveDeployRole(),
} = {}) => {
  const platform = resolveServicePlatform();
  if (platform !== "linux") throw new Error("systemd-installer-unsupported:darwin");
  if (effectiveUid === 0) throw new Error("launchd-installer-refuses-root");
  const root = realpathSync(resolve(repositoryRoot ?? REPOSITORY_ROOT));
  const account = resolveSystemdServiceUser({ serviceUser, platform: "linux", lookup: userLookup, execute });
  const values = autoDeployDefinitionValues({
    root,
    nodeBinary,
    gitBinary,
    npmBinary,
    path,
    sourceRemote,
    backup,
    serviceUser: account,
    runnerCount,
    runnerIdPrefix,
    deployRole,
  });
  const service = renderAutoDeploySystemdUnit(readFileSync(SYSTEMD_AUTO_DEPLOY_TEMPLATE, "utf8"), values);
  const timer = renderAutoDeploySystemdTimer(readFileSync(SYSTEMD_AUTO_DEPLOY_TIMER_TEMPLATE, "utf8"));
  verifySystemdAutoDeployDefinitions({ service, timer });
  const stage = resolve(stagingRoot ?? join(root, AUTO_DEPLOY_INSTALL_ROOT, "staging"));
  const targetRoot = resolve(unitDirectory);
  const servicePath = join(targetRoot, AUTO_DEPLOY_UNIT);
  const timerPath = join(targetRoot, AUTO_DEPLOY_TIMER);
  if (!apply) return Object.freeze({
    applied: false,
    phase: installerPhase({ applied: false }),
    platform: "linux",
    staging: stage,
    unitDirectory: targetRoot,
    serviceUser: account,
    deployRole,
    entries: [servicePath, timerPath],
    definitions: { service, timer },
    values,
  });
  const manifestPath = autoDeployManifestPath(root);
  if (existsSync(manifestPath)) throw new Error("systemd-auto-deploy-install-active");
  stageSystemdDefinition({ stagingRoot: stage, relativePath: AUTO_DEPLOY_UNIT, contents: service });
  stageSystemdDefinition({ stagingRoot: stage, relativePath: AUTO_DEPLOY_TIMER, contents: timer });
  const entries = [
    {
      ...autoDeployStageEntry({
        path: servicePath,
        stagedPath: stagingFile(stage, AUTO_DEPLOY_UNIT),
        backupPath: join(stage, "backups", AUTO_DEPLOY_UNIT),
      }),
      unit: AUTO_DEPLOY_UNIT,
    },
    {
      ...autoDeployStageEntry({
        path: timerPath,
        stagedPath: stagingFile(stage, AUTO_DEPLOY_TIMER),
        backupPath: join(stage, "backups", AUTO_DEPLOY_TIMER),
      }),
      unit: AUTO_DEPLOY_TIMER,
    },
  ];
  for (const entry of entries) {
    entry.installedSha256 = fileDigest(entry.stagedPath);
    stageFileEntry({ entry });
    backupSystemdTarget({ stagingRoot: stage, entry });
  }
  const manifest = {
    schemaVersion: 1,
    platform: "linux",
    repositoryRoot: root,
    serviceUser: account,
    runnerCount,
    stagingRoot: stage,
    unitDirectory: targetRoot,
    sudoersPath: resolve(sudoersPath),
    renderInputs: {
      nodeBinary,
      gitBinary,
      npmBinary,
      path,
      sourceRemote,
      backup,
      runnerCount,
      ...(deployRole === DEFAULT_DEPLOY_ROLE ? {} : { deployRole }),
      ...(runnerIdPrefix === "" ? {} : { runnerIdPrefix }),
    },
    entries,
    auxiliaryEntries: [],
  };
  writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return Object.freeze({
    applied: true,
    phase: installerPhase({ applied: true }),
    platform: "linux",
    staging: stage,
    unitDirectory: targetRoot,
    serviceUser: account,
    deployRole,
    entries: entries.map((entry) => entry.path),
    manifest,
    manifestPath,
  });
};

export const installStagedSystemdAutoDeploy = ({
  repositoryRoot,
  manifestPath,
  unitDirectory = SYSTEMD_UNIT_DIRECTORY,
  sudoersPath = SYSTEMD_SUDOERS_PATH,
  systemctlPath = null,
  execute = execFileSync,
  chown = chownSync,
  serviceUser,
  environment = process.env,
  deployRole = resolveDeployRole(environment),
  userLookup = null,
  effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : process.getuid(),
  revert = false,
  apply = true,
} = {}) => {
  const platform = resolveServicePlatform();
  if (platform !== "linux") throw new Error("systemd-installer-unsupported:darwin");
  if (apply && effectiveUid !== 0) throw new Error("systemd-installer-requires-root");
  const root = realpathSync(resolve(repositoryRoot ?? REPOSITORY_ROOT));
  const path = manifestPath ?? autoDeployManifestPath(root);
  if (!existsSync(path)) throw new Error("systemd-auto-deploy-manifest-missing");
  const manifest = readJsonFile(path, "systemd-auto-deploy-manifest-invalid");
  const recordedDeployRole = manifest?.renderInputs?.deployRole ?? DEFAULT_DEPLOY_ROLE;
  if (recordedDeployRole !== deployRole) throw new Error("systemd-auto-deploy-deploy-role-manifest-mismatch");
  const targetRoot = resolve(unitDirectory ?? manifest.unitDirectory ?? SYSTEMD_UNIT_DIRECTORY);
  const expectedStage = join(root, AUTO_DEPLOY_INSTALL_ROOT, "staging");
  assertContainedPath(expectedStage, root);
  const account = resolveSystemdServiceUser({ serviceUser, platform: "linux", lookup: userLookup, execute });
  if (manifest.schemaVersion !== 1 || manifest.platform !== "linux" || manifest.repositoryRoot !== root
      || manifest.serviceUser !== account || manifest.stagingRoot !== expectedStage
      || manifest.unitDirectory !== targetRoot || !Array.isArray(manifest.entries) || manifest.entries.length !== 2
      || !Array.isArray(manifest.auxiliaryEntries) || !manifest.renderInputs) {
    throw new Error("systemd-auto-deploy-manifest-invalid");
  }
  const entries = [...manifest.entries, ...(Array.isArray(manifest.auxiliaryEntries) ? manifest.auxiliaryEntries : [])];
  const targetSudoers = resolve(sudoersPath ?? manifest.sudoersPath ?? SYSTEMD_SUDOERS_PATH);
  if (entries.length !== 2 || manifest.auxiliaryEntries.length !== 0) throw new Error("systemd-auto-deploy-manifest-invalid");
  const expectedEntries = [
    { kind: "auto-deploy", unit: AUTO_DEPLOY_UNIT, path: join(targetRoot, AUTO_DEPLOY_UNIT), stagedPath: join(expectedStage, AUTO_DEPLOY_UNIT) },
    { kind: "auto-deploy", unit: AUTO_DEPLOY_TIMER, path: join(targetRoot, AUTO_DEPLOY_TIMER), stagedPath: join(expectedStage, AUTO_DEPLOY_TIMER) },
  ];
  expectedEntries.forEach((expected, index) => assertExactEntry(entries[index], expected, "systemd-auto-deploy-manifest-invalid"));
  for (const entry of entries) {
    assertContainedPath(entry.path, targetRoot);
    assertContainedPath(entry.stagedPath, expectedStage);
    const expectedBackup = entry.existed ? join(expectedStage, "backups", entry.unit) : null;
    if (entry.backupPath !== expectedBackup || !existsSync(entry.stagedPath) || !lstatSync(entry.stagedPath).isFile()) {
      throw new Error("systemd-auto-deploy-manifest-invalid");
    }
    if (entry.backupPath) assertContainedPath(entry.backupPath, join(expectedStage, "backups"));
  }
  const values = autoDeployDefinitionValues({ root, serviceUser: account, deployRole, ...manifest.renderInputs });
  const expectedService = renderAutoDeploySystemdUnit(readFileSync(SYSTEMD_AUTO_DEPLOY_TEMPLATE, "utf8"), values);
  const expectedTimer = renderAutoDeploySystemdTimer(readFileSync(SYSTEMD_AUTO_DEPLOY_TIMER_TEMPLATE, "utf8"));
  if (readFileSync(entries[0].stagedPath, "utf8") !== expectedService) throw new Error(`systemd-staged-unit-invalid:${AUTO_DEPLOY_UNIT}`);
  if (readFileSync(entries[1].stagedPath, "utf8") !== expectedTimer) throw new Error(`systemd-staged-unit-invalid:${AUTO_DEPLOY_TIMER}`);
  if (!apply) return Object.freeze({
    applied: false,
    phase: installerPhase({ revert, applied: false }),
    platform: "linux",
    staging: expectedStage,
    unitDirectory: targetRoot,
    units: entries.map((entry) => entry.unit),
    entries: entries.map((entry) => entry.path),
  });
  const systemctl = systemdCommandPath("systemctl", systemctlPath, execute);
  for (const entry of entries) {
    recognizeInstalledEntry({ entry, reason: "systemd-auto-deploy" });
    if (!revert) assertStagedSource(entry);
  }
  const transactionStatePath = join(targetRoot, ".anneal-auto-deploy-transaction.json");
  const transactionState = rootTransactionState({
    statePath: transactionStatePath,
    manifest,
    entries,
    systemctlPath: systemctl,
    execute,
    requireExisting: revert,
  });
  if (!revert) {
    for (const entry of entries) copyStagedEntry({
      entry,
      unitDirectory: targetRoot,
      sudoersPath: targetSudoers,
      strictOwner: typeof process.geteuid !== "function" || process.geteuid() === 0,
      chown,
    });
    runSystemctl({ systemctlPath: systemctl, args: ["daemon-reload"], execute });
    runSystemctl({ systemctlPath: systemctl, args: ["enable", "--now", AUTO_DEPLOY_TIMER], unit: AUTO_DEPLOY_TIMER, execute });
    return Object.freeze({
      applied: true, phase: installerPhase({ applied: true }), platform: "linux", staging: expectedStage,
      unitDirectory: targetRoot, deployRole, units: entries.map((entry) => entry.unit), entries: entries.map((entry) => entry.path),
    });
  }
  const timerEntry = manifest.entries[1];
  const timerState = transactionState.entries[1];
  runSystemctl({
    systemctlPath: systemctl,
    args: timerState.existed ? ["stop", timerEntry.unit] : ["disable", "--now", timerEntry.unit],
    unit: timerEntry.unit,
    execute,
  });
  for (const [index, entry] of entries.entries()) {
    restoreRootTransactionEntry(entry, transactionState.entries[index]);
    if (entry.backupPath) rmSync(entry.backupPath, { force: true });
  }
  runSystemctl({ systemctlPath: systemctl, args: ["daemon-reload"], execute });
  if (timerState.existed) {
    runSystemctl({ systemctlPath: systemctl, args: [timerState.unitState?.enabled ? "enable" : "disable", timerEntry.unit], unit: timerEntry.unit, execute });
    runSystemctl({ systemctlPath: systemctl, args: [timerState.unitState?.active ? "start" : "stop", timerEntry.unit], unit: timerEntry.unit, execute });
  }
  rmSync(path, { force: true });
  rmSync(transactionStatePath, { force: true });
  rmSync(expectedStage, { recursive: true, force: true });
  return Object.freeze({
    applied: true, phase: installerPhase({ revert: true, applied: true }), platform: "linux", deployRole, staging: expectedStage,
    unitDirectory: targetRoot, units: entries.map((entry) => entry.unit), entries: entries.map((entry) => entry.path),
  });
};

const isEntryPoint = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  try {
    process.exitCode = installLaunchd(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`STOP ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
