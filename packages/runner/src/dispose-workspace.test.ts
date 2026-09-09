import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RunnerConfig } from "./config.js";
import {
  claudeTranscriptDirectory, disposeWorkspace, type WorkspaceDisposalClaim, type WorkspaceDisposalIdentity,
} from "./dispose-workspace.js";
import { createControlPlaneDouble } from "./test-control-plane.js";

const config = (workspaceRoot: string, home = workspaceRoot): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-1",
  servedKinds: null,
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 1_000,
  claimMaxLoadAverage: 1.5,
  leaseSeconds: 60,
  heartbeatIntervalMs: 5_000,
  path: "/usr/bin:/bin",
  home,
  gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
  workspaceRoot,
  hostProofSlots: 3,
  failedWorkspaceRetention: 2,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
});

type TranscriptFixture = {
  home: string;
  projectsRoot: string;
  transcriptDirectory: string;
  workspacePath: string;
  workspaceRoot: string;
};

const transcriptFixture = async (label: string): Promise<TranscriptFixture> => {
  const root = await mkdtemp(join(tmpdir(), `agentos-dispose-transcript-${label}-`));
  const home = join(root, "home");
  const workspaceRoot = join(root, "workspaces");
  const workspacePath = join(workspaceRoot, "run-1");
  const projectsRoot = join(home, ".claude", "projects");
  await mkdir(home);
  await mkdir(workspaceRoot);
  await mkdir(workspacePath);
  await mkdir(projectsRoot, { recursive: true });
  const mangledWorkspacePath = workspacePath.replace(/[^A-Za-z0-9]/g, "-");
  return {
    home,
    projectsRoot,
    transcriptDirectory: join(projectsRoot, mangledWorkspacePath),
    workspacePath,
    workspaceRoot,
  };
};

const runnerClaim = (runId: string): WorkspaceDisposalClaim => ({
  fencingToken: `fence-${runId}`,
  sessionToken: `session-${runId}`,
  task: { id: "task-1" },
  run: { id: runId, runNumber: 2 },
  repo: { remoteUrl: "origin" },
});

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
}).trim();

const cases: Array<{ label: string; identity: WorkspaceDisposalIdentity }> = [
  {
    label: "runner cleanup",
    identity: {
      source: "runner",
      claim: runnerClaim("runner-run"),
    },
  },
  {
    label: "delayed reclaim",
    identity: {
      source: "reclaim",
      runId: "reclaim-run",
      taskId: null,
      runNumber: undefined,
    },
  },
];

for (const { label, identity } of cases) {
  test(`a pinned checkout refuses publication through ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agentos-dispose-pinned-"));
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    await writeFile(join(workspacePath, "review.txt"), "scratch only\n");
    const controlPlane = createControlPlaneDouble();

    const result = await disposeWorkspace(config(root), identity, {
      path: workspacePath,
      branch: "",
      baseSha: "base-sha",
      pinnedBaseSha: "pinned-sha",
    }, {
      alreadyDurable: false,
      retain: false,
    }, controlPlane.controlPlane);

    assert.deepEqual(result, {
      cleanupStatus: "SUCCEEDED",
      workspaceRetained: false,
      salvage: null,
    });
    assert.deepEqual(controlPlane.publishedBranches, []);
    assert.deepEqual(controlPlane.reclaimPublications, []);
    await assert.rejects(access(workspacePath));
  });
}

test("runner disposal salvages unfinished work through the production path before cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-dispose-salvage-"));
  const remote = join(root, "origin.git");
  const workspacePath = join(root, "workspace");
  git(root, "init", "--bare", remote);
  git(root, "init", "--initial-branch=main", workspacePath);
  git(workspacePath, "config", "user.name", "Runner Test");
  git(workspacePath, "config", "user.email", "runner@example.invalid");
  await writeFile(join(workspacePath, "tracked.txt"), "base\n");
  git(workspacePath, "add", "tracked.txt");
  git(workspacePath, "commit", "-m", "base");
  const baseSha = git(workspacePath, "rev-parse", "HEAD");
  git(workspacePath, "remote", "add", "origin", remote);
  await writeFile(join(workspacePath, "tracked.txt"), "unfinished\n");
  const controlPlane = createControlPlaneDouble();
  const claim = { ...runnerClaim("run-2"), repo: { remoteUrl: remote } };

  const result = await disposeWorkspace(config(root), { source: "runner", claim }, {
    path: workspacePath,
    branch: "feature/shared",
    baseSha,
    pinnedBaseSha: null,
  }, {
    alreadyDurable: false,
    retain: false,
  }, controlPlane.controlPlane);

  assert.equal(result.cleanupStatus, "SUCCEEDED");
  assert.equal(result.workspaceRetained, false);
  assert.equal(result.salvage?.pushedBranch, "agentos/task-1/run-2");
  assert.equal(git(remote, "rev-parse", "refs/heads/agentos/task-1/run-2"), result.salvage?.headSha);
  assert.deepEqual(controlPlane.publishedBranches, ["agentos/task-1/run-2"]);
  await assert.rejects(access(workspacePath));
});

test("successful disposal removes the Claude transcript directory but keeps projects root", async () => {
  const fixture = await transcriptFixture("succeeded");
  await mkdir(fixture.transcriptDirectory, { recursive: true });
  await writeFile(join(fixture.transcriptDirectory, "session.jsonl"), "transcript\n");

  const result = await disposeWorkspace(config(fixture.workspaceRoot, fixture.home), {
    source: "runner",
    claim: runnerClaim("transcript-succeeded"),
  }, {
    path: fixture.workspacePath,
    branch: "",
    baseSha: null,
    pinnedBaseSha: null,
  }, {
    alreadyDurable: true,
    retain: false,
  }, createControlPlaneDouble().controlPlane);

  assert.equal(result.cleanupStatus, "SUCCEEDED");
  await assert.rejects(access(fixture.transcriptDirectory));
  await assert.doesNotReject(access(fixture.projectsRoot));
});

test("retained disposal leaves the Claude transcript directory in place", async () => {
  const fixture = await transcriptFixture("retained");
  await mkdir(fixture.transcriptDirectory, { recursive: true });
  await writeFile(join(fixture.transcriptDirectory, "session.jsonl"), "transcript\n");

  const result = await disposeWorkspace(config(fixture.workspaceRoot, fixture.home), {
    source: "runner",
    claim: runnerClaim("transcript-retained"),
  }, {
    path: fixture.workspacePath,
    branch: "",
    baseSha: null,
    pinnedBaseSha: null,
  }, {
    alreadyDurable: true,
    retain: true,
  }, createControlPlaneDouble().controlPlane);

  assert.equal(result.cleanupStatus, "RETAINED");
  await assert.doesNotReject(access(fixture.transcriptDirectory));
});

test("an absent Claude transcript directory is a successful silent disposal", async () => {
  const fixture = await transcriptFixture("absent");
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
  };
  let result;
  try {
    result = await disposeWorkspace(config(fixture.workspaceRoot, fixture.home), {
      source: "runner",
      claim: runnerClaim("transcript-absent"),
    }, {
      path: fixture.workspacePath,
      branch: "",
      baseSha: null,
      pinnedBaseSha: null,
    }, {
      alreadyDurable: true,
      retain: false,
    }, createControlPlaneDouble().controlPlane);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.cleanupStatus, "SUCCEEDED");
  assert.equal(warnings.some((warning) => warning.includes('"event":"transcript-remove-failed"')), false);
});

test("Claude transcript path guard refuses the projects root", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-dispose-transcript-guard-"));
  assert.throws(
    () => claudeTranscriptDirectory(config(root), ""),
    /outside the configured projects root/u,
  );
});
