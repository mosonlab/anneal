import { readFileSync } from "node:fs";
import { DEFAULT_RUNNER_COUNT } from "./service-inventory.mjs";
import { RELEASE_POINTER_NAMES } from "./release-pointer.mjs";

const xml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

export const runnerCountEnvironment = (runnerCount) => runnerCount === undefined || runnerCount === DEFAULT_RUNNER_COUNT
  ? {}
  : { AGENTOS_RUNNER_COUNT: String(runnerCount) };

// plutil may emit literal quotes or character references for the same text.
const xmlText = (value) => value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gu, (_match, entity) => {
  if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
  if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
  return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity];
});

const environmentValues = (values) => Object.freeze({
  PATH: values.path,
  DEPLOY_NODE_BINARY: values.nodeBinary,
  AGENTOS_REPOSITORY_ROOT: values.repositoryRoot,
  AGENTOS_SHARED_ROOT: values.sharedRoot,
  AGENTOS_SHARED_ENV_FILE: values.sharedEnvironmentPath,
  AGENTOS_CURRENT_POINTER: RELEASE_POINTER_NAMES.current,
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

export const systemdDirectiveToken = (value, key) => {
  if (typeof value !== "string" || value === "" || /[\0\n\r]/u.test(value)) {
    throw new Error(`systemd-directive-value-invalid:${key}`);
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
};

// WorkingDirectory's path parser treats surrounding quotes as path bytes on
// older supported systemd releases, so escape whitespace without quoting it.
export const systemdPathDirective = (value, key) => {
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

export const renderSystemdTemplate = (template, replacements, unresolvedReason) => {
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error(unresolvedReason);
  return rendered;
};

export const hasExactDirective = (text, directive, value) => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${directive}=${escaped}$`, "mu").test(text);
};

export const directiveCount = (text, directive) => (text.match(new RegExp(`^${directive}=`, "gmu")) ?? []).length;

const renderLaunchd = (template, values, keys) => {
  const replacements = {
    __LABEL__: values.label,
    __NODE_BINARY__: values.nodeBinary,
    __WRAPPER_PATH__: values.wrapperPath,
    __REPOSITORY_ROOT__: values.repositoryRoot,
    __STDOUT_PATH__: values.stdoutPath,
    __STDERR_PATH__: values.stderrPath,
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) rendered = rendered.replaceAll(placeholder, xml(value));
  // Keep the historical launchd ordering and its empty runner slot byte-for-byte.
  const { AGENTOS_RUNNER_COUNT, RUNNER_ID, RUNNER_PATH, ...base } = keys;
  const runner = {
    ...(RUNNER_ID ? { RUNNER_ID } : {}),
    ...(RUNNER_PATH ? { RUNNER_PATH } : {}),
    ...(AGENTOS_RUNNER_COUNT ? { AGENTOS_RUNNER_COUNT } : {}),
  };
  const entries = (values) => Object.entries(values)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  rendered = rendered.replaceAll("__ENVIRONMENT__", `${entries(base)}\n${entries(runner)}`);
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error("launchd-service-template-has-unresolved-placeholder");
  return rendered;
};

const renderSystemd = (template, values, keys) => {
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
    __ENVIRONMENT__: renderSystemdEnvironment(keys),
  }, "systemd-service-template-has-unresolved-placeholder");
};

const verifySystemd = (rendered, label) => {
  if (typeof rendered !== "string") throw new Error(`systemd-service-definition-missing:${label}`);
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error(`systemd-service-definition-unresolved:${label}`);
  if (!hasExactDirective(rendered, "SyslogIdentifier", label)
      || !new RegExp(`^ExecStart=.*(?:^|\\s)${label}(?:\\s|$)`, "mu").test(rendered)) {
    throw new Error(`systemd-service-definition-label-mismatch:${label}`);
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
};

const verifyLaunchd = (rendered, label) => {
  if (typeof rendered !== "string") throw new Error(`launchd-service-definition-missing:${label}`);
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error(`launchd-service-definition-unresolved:${label}`);
  if (!new RegExp(`<key>Label</key>\\s*<string>${xml(label)}</string>`, "u").test(rendered)) {
    throw new Error(`launchd-service-definition-label-mismatch:${label}`);
  }
  if (!rendered.includes("<key>ProgramArguments</key>")) throw new Error(`launchd-service-definition-program-missing:${label}`);
  if (/<string>\s*<\/string>/u.test(rendered)) throw new Error(`launchd-service-definition-empty-string:${label}`);
};

const templates = Object.freeze({
  launchd: readFileSync(new URL("./com.agentos.service.plist.in", import.meta.url), "utf8"),
  systemd: readFileSync(new URL("./com.agentos.service.unit.in", import.meta.url), "utf8"),
});

/** One resolved environment contract, shared by rendering, migration and reporting.
 * runnerPath is null when shared/.env owns it; host CLI discovery remains in
 * the installer, which supplies the resolved path (including preserved plist values).
 */
export const serviceDefinition = (values) => {
  values = Object.freeze({ ...values });
  const keys = environmentValues(values);
  const assertPlatform = (platform) => {
    if (!Object.hasOwn(templates, platform)) throw new Error(`service-definition-platform-invalid:${platform}`);
  };
  return Object.freeze({
    keys,
    render(platform) {
      assertPlatform(platform);
      return platform === "launchd"
        ? renderLaunchd(templates.launchd, values, keys)
        : renderSystemd(templates.systemd, values, keys);
    },
    verify(platform, rendered) {
      assertPlatform(platform);
      if (platform === "launchd") verifyLaunchd(rendered, values.label);
      else verifySystemd(rendered, values.label);
      const environment = platform === "launchd"
        ? /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(rendered)?.[1] ?? ""
        : rendered;
      for (const [key, value] of Object.entries(keys)) {
        const expected = platform === "launchd"
          ? value
          : renderSystemdEnvironment({ [key]: value });
        const occurrences = platform === "launchd"
          ? [...environment.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/gu)]
              .filter((match) => xmlText(match[1]) === key)
              .map((match) => xmlText(match[2]))
          : environment.split("\n").filter((line) => line.startsWith(`Environment=${key}=`));
        if (occurrences.length !== 1 || occurrences[0] !== expected) {
          throw new Error(`${platform}-service-definition-environment-mismatch:${values.label}:${key}`);
        }
      }
      if (values.runnerId && !Object.hasOwn(keys, "RUNNER_PATH")
          && (platform === "launchd" ? /<key>RUNNER_PATH<\/key>/u : /^Environment=RUNNER_PATH=/mu).test(environment)) {
        throw new Error(`${platform}-service-definition-environment-mismatch:${values.label}:RUNNER_PATH`);
      }
      return true;
    },
  });
};
