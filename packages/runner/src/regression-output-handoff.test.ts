import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REGRESSION_VERIFICATION_OUTPUT_KIND, REGRESSION_VERIFICATION_V3_OUTPUT_KIND } from "@anneal/db";

import type { RunnerConfig } from "./config.js";
import {
  readRegressionOutputHandoff, type RegressionHandoffClaim,
} from "./regression-output-handoff.js";
import type { Workspace } from "./workspace.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "Runner Test",
    GIT_AUTHOR_EMAIL: "runner@example.invalid",
    GIT_COMMITTER_NAME: "Runner Test",
    GIT_COMMITTER_EMAIL: "runner@example.invalid",
  },
}).trim();

const runnerConfig = (root: string): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-1",
  servedKinds: null,
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 5_000,
  claimMaxLoadAverage: 1.5,
  leaseSeconds: 60,
  heartbeatIntervalMs: 60_000,
  path: process.env.PATH ?? "/usr/bin:/bin",
  home: join(root, "home"),
  gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
  workspaceRoot: root,
  hostProofSlots: 3,
  failedWorkspaceRetention: 0,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
});

const claim = (runId = "run-1"): RegressionHandoffClaim => ({
  task: {
    templateStep: { outputKind: REGRESSION_VERIFICATION_OUTPUT_KIND },
  },
  run: { id: runId },
});

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-regression-handoff-"));
  const path = join(root, "workspace");
  await mkdir(path);
  git(path, "init", "-b", "feature");
  await writeFile(join(path, "file.txt"), "content\n");
  git(path, "add", "file.txt");
  git(path, "commit", "-m", "fixture");
  const headSha = git(path, "rev-parse", "HEAD");
  const workspace: Workspace = { path, branch: "feature", baseSha: "b".repeat(40) };
  return { root, path, headSha, workspace };
};

const verdict = (headSha: string): string => JSON.stringify({
  schemaVersion: 2,
  outcome: "review-fail",
  headSha,
  baseHeadSha: "b".repeat(40),
  summary: "RF-2 remains open",
});

const writeHandoff = async (
  path: string,
  value: Record<string, unknown>,
): Promise<void> => {
  await mkdir(join(path, ".agentos"), { recursive: true });
  await writeFile(join(path, ".agentos", "regression-output.json"), JSON.stringify(value), { mode: 0o600 });
};

test("a current-Run exact-head Regression handoff crosses the Runner seam", async () => {
  const fixture = await setup();
  try {
    const body = verdict(fixture.headSha);
    await writeHandoff(fixture.path, {
      schemaVersion: 1,
      runId: "run-1",
      kind: REGRESSION_VERIFICATION_OUTPUT_KIND,
      body,
      commitSha: fixture.headSha,
    });

    assert.deepEqual(
      await readRegressionOutputHandoff(runnerConfig(fixture.root), claim(), fixture.workspace),
      { kind: REGRESSION_VERIFICATION_OUTPUT_KIND, body, commitSha: fixture.headSha },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a stale Run or stale HEAD handoff is refused", async () => {
  const fixture = await setup();
  try {
    await writeHandoff(fixture.path, {
      schemaVersion: 1,
      runId: "run-old",
      kind: REGRESSION_VERIFICATION_OUTPUT_KIND,
      body: verdict(fixture.headSha),
      commitSha: fixture.headSha,
    });
    await assert.rejects(
      readRegressionOutputHandoff(runnerConfig(fixture.root), claim(), fixture.workspace),
      /belongs to Run run-old/u,
    );

    await writeHandoff(fixture.path, {
      schemaVersion: 1,
      runId: "run-1",
      kind: REGRESSION_VERIFICATION_OUTPUT_KIND,
      body: verdict(fixture.headSha),
      commitSha: "a".repeat(40),
    });
    await assert.rejects(
      readRegressionOutputHandoff(runnerConfig(fixture.root), claim(), fixture.workspace),
      /handoff is stale/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an invalid canonical verdict is refused and an absent handoff is inert", async () => {
  const fixture = await setup();
  try {
    assert.equal(
      await readRegressionOutputHandoff(runnerConfig(fixture.root), claim(), fixture.workspace),
      null,
    );
    await writeHandoff(fixture.path, {
      schemaVersion: 1,
      runId: "run-1",
      kind: REGRESSION_VERIFICATION_OUTPUT_KIND,
      body: JSON.stringify({ schemaVersion: 2, outcome: "review-fail" }),
      commitSha: fixture.headSha,
    });
    await assert.rejects(
      readRegressionOutputHandoff(runnerConfig(fixture.root), claim(), fixture.workspace),
      /verdict is invalid/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a symlinked handoff directory is refused", async () => {
  const fixture = await setup();
  try {
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(fixture.path, ".agentos"));
    await assert.rejects(
      readRegressionOutputHandoff(runnerConfig(fixture.root), claim(), fixture.workspace),
      /symlinked-parent-directory/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});


test("semantic-only handoff is bound to the v3 claim, current Run and exact head", async () => {
  const fixture = await setup();
  try {
    const v3Claim: RegressionHandoffClaim = {
      ...claim(), task: { templateStep: { outputKind: REGRESSION_VERIFICATION_V3_OUTPUT_KIND } },
    };
    const body = JSON.stringify({ schemaVersion: 3, outcome: "semantic-pass", headSha: fixture.headSha, baseHeadSha: "b".repeat(40) });
    const output = { schemaVersion: 1, runId: "run-1", kind: REGRESSION_VERIFICATION_V3_OUTPUT_KIND, body, commitSha: fixture.headSha };
    await writeHandoff(fixture.path, output);
    assert.deepEqual(await readRegressionOutputHandoff(runnerConfig(fixture.root), v3Claim, fixture.workspace), {
      kind: REGRESSION_VERIFICATION_V3_OUTPUT_KIND, body, commitSha: fixture.headSha,
    });
    await assert.rejects(readRegressionOutputHandoff(runnerConfig(fixture.root), claim(), fixture.workspace), /unexpected kind/u);
    await writeHandoff(fixture.path, { ...output, runId: "old-run" });
    await assert.rejects(readRegressionOutputHandoff(runnerConfig(fixture.root), v3Claim, fixture.workspace), /belongs to Run/u);
    await writeHandoff(fixture.path, { ...output, body: JSON.stringify({ ...JSON.parse(body), headSha: "a".repeat(40) }) });
    await assert.rejects(readRegressionOutputHandoff(runnerConfig(fixture.root), v3Claim, fixture.workspace), /verdict is stale/u);
    await writeHandoff(fixture.path, { ...output, kind: REGRESSION_VERIFICATION_OUTPUT_KIND });
    await assert.rejects(readRegressionOutputHandoff(runnerConfig(fixture.root), claim(), fixture.workspace), /verdict is invalid/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
