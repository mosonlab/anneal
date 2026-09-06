#!/usr/bin/env node
/**
 * Render the root-owned systemd definitions for the merge-executor follower.
 * This module only reads the templates beside it and uses Node's standard
 * library. The follower itself is installed as a separate, trusted copy.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
export const MERGE_EXECUTOR_FOLLOWER_SERVICE_TEMPLATE = join(
  SCRIPT_DIR,
  "agentos-merge-executor-follower.service.in",
);
export const MERGE_EXECUTOR_FOLLOWER_TIMER_TEMPLATE = join(
  SCRIPT_DIR,
  "agentos-merge-executor-follower.timer.in",
);
export const MERGE_EXECUTOR_FOLLOWER_UNIT_NAME = "agentos-merge-executor-follower.service";
export const MERGE_EXECUTOR_FOLLOWER_TIMER_NAME = "agentos-merge-executor-follower.timer";

const readTemplate = (path) => readFileSync(path, "utf8");

const render = (template, replacements, errorName) => {
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (/__[A-Z_]+__/u.test(rendered)) throw new Error(errorName);
  return rendered;
};

/** Escape a path for one systemd ExecStart token. Paths are kept absolute and
 * are validated before escaping so a rendered definition cannot add argv. */
const systemdPath = (value, name) => {
  if (typeof value !== "string" || !isAbsolute(value) || /[\u0000\r\n$']/u.test(value)) {
    throw new Error(`merge-executor-follower-template-${name}-invalid`);
  }
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(" ", "\\x20")
    .replaceAll("\t", "\\t")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
};

/** Render the follower's root oneshot service. */
export const renderMergeExecutorFollowerSystemdUnit = (values) => {
  return render(
    readTemplate(MERGE_EXECUTOR_FOLLOWER_SERVICE_TEMPLATE),
    {
      __NODE_PATH__: systemdPath(values?.nodePath, "node-path"),
      __FOLLOWER_PATH__: systemdPath(values?.followerPath, "follower-path"),
      __CONFIG_PATH__: systemdPath(values?.configPath, "config-path"),
    },
    "merge-executor-follower-service-template-has-unresolved-placeholder",
  );
};

/** Render the follower's five-minute timer. */
export const renderMergeExecutorFollowerSystemdTimer = () => render(
  readTemplate(MERGE_EXECUTOR_FOLLOWER_TIMER_TEMPLATE),
  {},
  "merge-executor-follower-timer-template-has-unresolved-placeholder",
);

export const renderMergeExecutorFollowerSystemdDefinitions = (values) => Object.freeze({
  unit: renderMergeExecutorFollowerSystemdUnit(values),
  timer: renderMergeExecutorFollowerSystemdTimer(),
});

const usage = () => [
  "Usage:",
  "  node scripts/deploy/merge-executor-follower-templates.mjs \\",
  "    --node-path /usr/bin/node \\",
  "    --follower-path /opt/agentos/merge-executor/bin/merge-executor-follower.mjs \\",
  "    --config-path /etc/agentos/merge-executor-follower.json \\",
  "    --unit-output /etc/systemd/system/agentos-merge-executor-follower.service \\",
  "    --timer-output /etc/systemd/system/agentos-merge-executor-follower.timer",
].join("\n");

const parseArguments = (argv) => {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    const name = {
      "--node-path": "nodePath",
      "--follower-path": "followerPath",
      "--config-path": "configPath",
      "--unit-output": "unitOutput",
      "--timer-output": "timerOutput",
    }[argument];
    if (!name || index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`merge-executor-follower-template-argument-invalid:${argument}`);
    }
    values[name] = argv[index + 1];
    index += 1;
  }
  for (const key of ["nodePath", "followerPath", "configPath", "unitOutput", "timerOutput"]) {
    if (typeof values[key] !== "string") throw new Error(`merge-executor-follower-template-${key}-missing`);
  }
  return values;
};

const writeRenderedFile = (path, content) => {
  if (!isAbsolute(path) || /[\u0000\r\n]/u.test(path)) {
    throw new Error("merge-executor-follower-template-output-invalid");
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o644 });
  chmodSync(path, 0o644);
};

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(resolve(process.argv[1])));
if (isMain) {
  try {
    const values = parseArguments(process.argv.slice(2));
    if (values.help) {
      console.log(usage());
    } else {
      const rendered = renderMergeExecutorFollowerSystemdDefinitions(values);
      writeRenderedFile(values.unitOutput, rendered.unit);
      writeRenderedFile(values.timerOutput, rendered.timer);
    }
  } catch (error) {
    console.error(`merge-executor-follower-template failed: ${error.message}`);
    process.exitCode = 1;
  }
}
