import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { serviceDefinition } from "./service-definition.mjs";

// Captured from a3683bb06581252f50bf8260f913392f1d99a9d6 before changing either renderer.
const golden = JSON.parse(readFileSync(new URL("./fixtures/service-definition-golden.json", import.meta.url), "utf8"));

for (const row of golden) {
  for (const platform of ["launchd", "systemd"]) {
    test(`golden ${platform}: ${row.name}`, () => {
      const definition = serviceDefinition(row.values);
      assert.equal(definition.render(platform), row[platform]);
      assert.equal(definition.verify(platform, row[platform]), true);
    });
  }
}

const base = golden[0].values;
for (const row of [
  { name: "non-runner ignores runner path", runnerId: undefined, runnerPath: "/providers", runnerCount: 10, extra: {} },
  { name: "runner inherits shared env", runnerId: "runner-1", runnerPath: null, runnerCount: 10, extra: { RUNNER_ID: "runner-1" } },
  { name: "runner has discovered CLI path", runnerId: "mac-runner-2", runnerPath: "/bin:/providers/bin", runnerCount: 2, extra: { AGENTOS_RUNNER_COUNT: "2", RUNNER_ID: "mac-runner-2", RUNNER_PATH: "/bin:/providers/bin" } },
]) {
  test(`keys: ${row.name}`, () => {
    const values = { ...base, ...row };
    const definition = serviceDefinition(values);
    assert.deepEqual(definition.keys, {
      PATH: base.path,
      DEPLOY_NODE_BINARY: base.nodeBinary,
      AGENTOS_REPOSITORY_ROOT: base.repositoryRoot,
      AGENTOS_SHARED_ROOT: base.sharedRoot,
      AGENTOS_SHARED_ENV_FILE: base.sharedEnvironmentPath,
      AGENTOS_CURRENT_POINTER: "current",
      AGENTOS_RELEASES_DIRECTORY: "releases",
      AGENTOS_SERVICE_LABEL: base.label,
      ...row.extra,
    });
    assert.equal(Object.isFrozen(definition.keys), true);
    values.path = "/changed-after-definition";
    assert.equal(definition.keys.PATH, base.path);
  });
}

for (const platform of ["launchd", "systemd"]) {
  const definition = serviceDefinition({ ...base, runnerId: "runner-1", runnerPath: "/providers", runnerCount: 2 });
  const rendered = definition.render(platform);
  for (const key of Object.keys(definition.keys)) {
    test(`verify ${platform} rejects missing, changed or duplicate ${key}`, () => {
      const pattern = platform === "launchd"
        ? new RegExp(`<key>${key}</key>\\s*<string>[^<]*</string>`, "u")
        : new RegExp(`^Environment=${key}=.*$`, "mu");
      const assignment = rendered.match(pattern)[0];
      for (const replacement of ["", assignment.replace(/<string>|="/u, "$&changed"), `${assignment}\n${assignment}`]) {
        assert.throws(() => definition.verify(platform, rendered.replace(pattern, () => replacement)), /environment-mismatch/u);
      }
    });
  }
  test(`verify ${platform} refuses an inline path when shared env owns it`, () => {
    const inherited = serviceDefinition({ ...base, runnerId: "runner-1", runnerPath: null, runnerCount: 2 });
    assert.throws(() => inherited.verify(platform, rendered), /environment-mismatch:.*:RUNNER_PATH/u);
  });
  test(`verify ${platform} rejects unresolved templates and missing definitions`, () => {
    assert.throws(() => definition.verify(platform, undefined), /definition-missing/u);
    assert.throws(() => definition.verify(platform, `${rendered}__UNKNOWN__`), /definition-unresolved/u);
  });
}

test("unsupported platforms fail explicitly", () => {
  const definition = serviceDefinition(base);
  assert.throws(() => definition.render("linux"), /platform-invalid/u);
  assert.throws(() => definition.verify("darwin", ""), /platform-invalid/u);
});

test("launchd verification compares plist text after entity decoding", () => {
  const definition = serviceDefinition({ ...base, path: `/opt/A&B/'quoted'/"double":/bin` });
  const rendered = definition.render("launchd")
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&#38;");
  assert.equal(definition.verify("launchd", rendered), true);
});
