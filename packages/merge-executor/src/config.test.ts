import assert from "node:assert/strict";
import { test } from "node:test";

import { loadExecutorConfig } from "./config.js";

const base = {
  MERGE_EXECUTOR_TOKEN: "executor-only-token",
  MERGE_EXECUTOR_RUNNER_ID: "merge-executor-1",
  MERGE_EXECUTOR_IDENTITY_LOGIN: "agentos-merge",
  MERGE_EXECUTOR_GITHUB_APP_ID: "12345",
  MERGE_EXECUTOR_GITHUB_APP_INSTALLATION_ID: "67890",
};

test("the executor carries its own credential, never the fleet-wide runner token", () => {
  const config = loadExecutorConfig({ ...base, RUNNER_TOKEN: "fleet-wide" });
  assert.equal(config.executorToken, "executor-only-token");
});

test("GitHub App identifiers are required public configuration", () => {
  const config = loadExecutorConfig(base);
  assert.equal(config.githubAppId, "12345");
  assert.equal(config.githubAppInstallationId, "67890");
  assert.equal(config.githubAppAuthTimeoutMs, 15_000);
  assert.throws(() => loadExecutorConfig({ ...base, MERGE_EXECUTOR_GITHUB_APP_ID: "" }), /GITHUB_APP_ID is required/u);
  assert.throws(() => loadExecutorConfig({ ...base, MERGE_EXECUTOR_GITHUB_APP_ID: "app-id" }), /positive decimal identifier/u);
  assert.throws(() => loadExecutorConfig({ ...base, MERGE_EXECUTOR_GITHUB_APP_INSTALLATION_ID: "0" }), /positive decimal identifier/u);
});

test("a missing or aliased executor token refuses the start", () => {
  // §D-P1 rule 3 is an *identity* rule. A deployment that "configures" the
  // executor by handing it the runner token has given every runner the ability
  // to claim a mechanical run and author the merge-result the chain trusts, so
  // the process refuses to start rather than run with a shared credential. The
  // API applies the same rule in `mergeExecutorTokenIsDistinct`.
  assert.throws(() => loadExecutorConfig({ ...base, MERGE_EXECUTOR_TOKEN: undefined }), /MERGE_EXECUTOR_TOKEN is required/u);
  assert.throws(
    () => loadExecutorConfig({ ...base, RUNNER_TOKEN: "same" , MERGE_EXECUTOR_TOKEN: "same" }),
    /must not equal RUNNER_TOKEN/u,
  );
  assert.throws(
    () => loadExecutorConfig({ ...base, OPERATOR_TOKEN: "same", MERGE_EXECUTOR_TOKEN: "same" }),
    /must not equal OPERATOR_TOKEN/u,
  );
});

test("the contract recheck interval defaults to a minute and refuses a non-positive value", () => {
  // A mismatched daemon parks alive and re-claims on this interval, so the
  // value bounds how often an incompatible executor talks to the API. A zero
  // or negative setting would turn the park into a busy loop.
  assert.equal(loadExecutorConfig(base).contractRecheckMs, 60_000);
  assert.equal(loadExecutorConfig({ ...base, MERGE_EXECUTOR_CONTRACT_RECHECK_MS: "50" }).contractRecheckMs, 50);
  assert.throws(
    () => loadExecutorConfig({ ...base, MERGE_EXECUTOR_CONTRACT_RECHECK_MS: "0" }),
    /MERGE_EXECUTOR_CONTRACT_RECHECK_MS must be a positive integer/u,
  );
  assert.throws(
    () => loadExecutorConfig({ ...base, MERGE_EXECUTOR_CONTRACT_RECHECK_MS: "-1" }),
    /MERGE_EXECUTOR_CONTRACT_RECHECK_MS must be a positive integer/u,
  );
});
