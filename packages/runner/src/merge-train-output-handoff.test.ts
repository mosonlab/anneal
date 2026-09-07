import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MERGE_TRAIN_OUTPUT_KIND, REGRESSION_VERIFICATION_OUTPUT_KIND } from "@anneal/db";

import type { RunnerConfig } from "./config.js";
import { readMergeTrainOutputHandoff } from "./merge-train-output-handoff.js";
import type { RegressionHandoffClaim } from "./regression-output-handoff.js";
import type { Workspace } from "./workspace.js";

const PREFIX = "c".repeat(40);

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

const claim = (outputKind: string = MERGE_TRAIN_OUTPUT_KIND, runId = "run-1"): RegressionHandoffClaim => ({
  task: { templateStep: { outputKind } },
  run: { id: runId },
});

const record = (verdict: "pass" | "no-verdict" = "pass"): string => JSON.stringify({
  schemaVersion: 1,
  baseSha: "a".repeat(40),
  width: 1,
  prefixes: [{
    index: 1,
    taskId: "task-1",
    chainId: "00000000-0000-4000-8000-000000000001",
    candidateHeadSha: "b".repeat(40),
    predecessorOid: "a".repeat(40),
    prefixOid: PREFIX,
    ref: `refs/anneal/train/${PREFIX}`,
    verdict,
    gateExcerpt: verdict === "pass" ? `MERGE GATE: PASS ${PREFIX}` : "GATE NOT RUN",
  }],
  blocked: [],
  skipped: [],
  contiguousPassCount: verdict === "pass" ? 1 : 0,
});

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-merge-train-handoff-"));
  const path = join(root, "workspace");
  await mkdir(join(path, ".agentos"), { recursive: true });
  const workspace: Workspace = { path, branch: "feature", baseSha: "b".repeat(40) };
  return { root, path, workspace };
};

const writeHandoff = async (path: string, value: Record<string, unknown>): Promise<void> => {
  await writeFile(join(path, ".agentos", "merge-train-output.json"), JSON.stringify(value), { mode: 0o600 });
};

const handoff = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  runId: "run-1",
  kind: MERGE_TRAIN_OUTPUT_KIND,
  body: record(),
  commitSha: "e".repeat(40),
  ...overrides,
});

test("a current-Run merge train handoff crosses the Runner seam", async () => {
  const fixture = await setup();
  try {
    await writeHandoff(fixture.path, handoff());
    assert.deepEqual(
      await readMergeTrainOutputHandoff(runnerConfig(fixture.root), claim(), fixture.workspace),
      { kind: MERGE_TRAIN_OUTPUT_KIND, body: record(), commitSha: "e".repeat(40) },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a handoff for another Run, kind, step or schema is refused, and an absent one is inert", async () => {
  const fixture = await setup();
  const config = runnerConfig(fixture.root);
  try {
    assert.equal(await readMergeTrainOutputHandoff(config, claim(), fixture.workspace), null);
    await writeHandoff(fixture.path, handoff());
    assert.equal(
      await readMergeTrainOutputHandoff(config, claim(REGRESSION_VERIFICATION_OUTPUT_KIND), fixture.workspace),
      null,
    );

    await writeHandoff(fixture.path, handoff({ runId: "run-old" }));
    await assert.rejects(readMergeTrainOutputHandoff(config, claim(), fixture.workspace), /belongs to Run run-old/u);

    await writeHandoff(fixture.path, handoff({ schemaVersion: 2 }));
    await assert.rejects(readMergeTrainOutputHandoff(config, claim(), fixture.workspace), /unsupported schemaVersion/u);

    await writeHandoff(fixture.path, handoff({ kind: "regression-verification-v2" }));
    await assert.rejects(readMergeTrainOutputHandoff(config, claim(), fixture.workspace), /unexpected kind/u);

    await writeHandoff(fixture.path, handoff({ commitSha: "not-a-sha" }));
    await assert.rejects(readMergeTrainOutputHandoff(config, claim(), fixture.workspace), /commitSha is invalid/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a record the control plane could not authorize from never crosses the seam", async () => {
  const fixture = await setup();
  const config = runnerConfig(fixture.root);
  try {
    await writeHandoff(fixture.path, handoff({ body: "{" }));
    await assert.rejects(readMergeTrainOutputHandoff(config, claim(), fixture.workspace), /record is invalid/u);

    // A pass without the gate's own proof line is exactly what the parser
    // refuses; the Runner must not publish it either.
    const proofless = JSON.parse(record()) as { prefixes: Array<{ gateExcerpt: string }> };
    proofless.prefixes[0]!.gateExcerpt = "";
    await writeHandoff(fixture.path, handoff({ body: JSON.stringify(proofless) }));
    await assert.rejects(
      readMergeTrainOutputHandoff(config, claim(), fixture.workspace),
      /record is invalid: merge train pass prefix carries no gate PASS proof/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a detached train consumes its handoff through the control-plane claim metadata", async () => {
  const fixture = await setup();
  try {
    await writeHandoff(fixture.path, handoff());
    const detached: RegressionHandoffClaim = { run: { id: "run-1" }, task: {
      templateStep: null,
      mergeTrain: { schemaVersion: 1, baseSha: "a".repeat(40), width: 1, candidates: [{
        taskId: "task-1", chainId: "00000000-0000-4000-8000-000000000001",
        headSha: "b".repeat(40), branch: "feature",
      }] },
    } };
    assert.equal((await readMergeTrainOutputHandoff(runnerConfig(fixture.root), detached, fixture.workspace))?.body, record());
    assert.equal(await readMergeTrainOutputHandoff(runnerConfig(fixture.root), {
      ...detached, task: { templateStep: null },
    }, fixture.workspace), null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
