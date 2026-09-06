#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireMergeLease,
  isMergeLeaseReleaseAnomaly,
  mergeLeaseHoldSeconds,
  releaseMergeLease,
} from "./merge-lease-adapter.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_CANDIDATES = 3;
const DEFAULT_LEASE_WAIT_MINUTES = 10;

class CommandError extends Error {
  constructor(command, result) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    super(`${command} exited ${result.code}${detail ? `\n${detail}` : ""}`);
    this.name = "CommandError";
    this.result = result;
  }
}

const runProcess = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 128,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

const checkedProcess = async (command, args, options = {}) => {
  const result = await runProcess(command, args, options);
  if (result.code !== 0) throw new CommandError([command, ...args].join(" "), result);
  return result.stdout.trim();
};

const gitResult = (repoRoot, args) => runProcess("git", ["-C", repoRoot, ...args]);
const git = (repoRoot, args) => checkedProcess("git", ["-C", repoRoot, ...args]);

const assertSha = (value, label) => {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label} must be a full lowercase commit OID`);
};

const isAncestor = async (repoRoot, ancestor, descendant) => {
  const result = await gitResult(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new CommandError(`git merge-base --is-ancestor ${ancestor} ${descendant}`, result);
};

const readMain = async (repoRoot) => {
  await git(repoRoot, ["fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main"]);
  const oid = await git(repoRoot, ["rev-parse", "refs/remotes/origin/main^{commit}"]);
  assertSha(oid, "origin/main");
  return oid;
};

const defaultReadPullRequest = async (repoRoot, pullRequest) => {
  const output = await checkedProcess(
    "gh",
    ["pr", "view", String(pullRequest), "--json", "state,headRefOid"],
    { cwd: repoRoot },
  );
  const value = JSON.parse(output);
  return {
    state: value.state,
    headSha: value.headRefOid,
  };
};

const defaultFetchCandidate = async (repoRoot, candidate) => {
  await git(repoRoot, ["fetch", "--quiet", "origin", `refs/pull/${candidate.pullRequest}/head`]);
  const fetched = await git(repoRoot, ["rev-parse", "FETCH_HEAD^{commit}"]);
  if (fetched !== candidate.headSha) {
    throw new Error(`PR #${candidate.pullRequest} fetched head ${fetched}, expected ${candidate.headSha}`);
  }
};

const defaultGate = async (_repoRoot, prefix, checkout) => {
  const script = path.join(checkout, "packages", "runner", "runtime-tools", "gate-worker", "gate-dispatch.sh");
  const result = await runProcess("bash", [script, prefix.oid, "--master", prefix.predecessor], {
    cwd: checkout,
    env: { ...process.env, AGENTOS_WORKSPACE_PATH: checkout },
  });
  const output = `${result.stdout}${result.stderr}`;
  const exactPass = new RegExp(`(?:^|\\n)MERGE GATE: PASS ${prefix.oid}(?:\\r?$|\\n)`, "u").test(
    output.replaceAll("\u001b[32m", "").replaceAll("\u001b[0m", ""),
  );
  const status = exactPass && result.code === 0 ? "pass" : result.code === 1 ? "fail" : "no-verdict";
  return { status, code: result.code, output };
};

export const acquireMergeTrainLease = (
  repoRoot, task, count,
  { environment = process.env, runner, leaseWaitMinutes = DEFAULT_LEASE_WAIT_MINUTES } = {},
) =>
  acquireMergeLease({
    repoRoot,
    environment,
    runner,
    task,
    reason: `Publish ${count}-entry merge train`,
    timeoutMinutes: leaseWaitMinutes,
  });

export const releaseMergeTrainLease = (repoRoot, task, { environment = process.env, runner } = {}) =>
  releaseMergeLease({ repoRoot, environment, runner, task });

const defaultPush = async (repoRoot, prefix) => {
  const result = await gitResult(repoRoot, ["push", "--porcelain", "origin", `${prefix.oid}:refs/heads/main`]);
  let observed;
  try {
    observed = await readMain(repoRoot);
  } catch (error) {
    throw error;
  }
  if (observed === prefix.oid) return { published: true, observed, result };
  if (observed === prefix.predecessor && result.code !== 0) return { published: false, observed, result };
  throw new Error(
    `main read-back was ${observed}; expected published ${prefix.oid} or unchanged ${prefix.predecessor}`,
  );
};

const realAdapters = {
  acquireLease: acquireMergeTrainLease,
  fetchCandidate: defaultFetchCandidate,
  gate: defaultGate,
  push: defaultPush,
  readMain,
  readPullRequest: defaultReadPullRequest,
  releaseLease: releaseMergeTrainLease,
  now: () => new Date(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const validateCandidates = (candidates) => {
  if (candidates.length < 1 || candidates.length > MAX_CANDIDATES) {
    throw new Error(`merge train needs 1-${MAX_CANDIDATES} candidates`);
  }
  const pullRequests = new Set();
  const heads = new Set();
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate.pullRequest) || candidate.pullRequest < 1) {
      throw new Error(`invalid pull request number: ${candidate.pullRequest}`);
    }
    assertSha(candidate.headSha, `PR #${candidate.pullRequest} head`);
    if (pullRequests.has(candidate.pullRequest)) throw new Error(`duplicate PR #${candidate.pullRequest}`);
    if (heads.has(candidate.headSha)) throw new Error(`duplicate candidate head ${candidate.headSha}`);
    pullRequests.add(candidate.pullRequest);
    heads.add(candidate.headSha);
  }
};

const validateOpenCandidate = async (repoRoot, candidate, adapters) => {
  const state = await adapters.readPullRequest(repoRoot, candidate.pullRequest);
  if (state.headSha !== candidate.headSha) {
    return { valid: false, reason: `head changed from ${candidate.headSha} to ${state.headSha}` };
  }
  if (state.state !== "OPEN") return { valid: false, reason: `PR state is ${state.state}` };
  return { valid: true };
};

const buildPrefixes = async (repoRoot, checkout, baseSha, candidates) => {
  await git(repoRoot, ["worktree", "add", "--detach", checkout, baseSha]);
  const prefixes = [];
  let predecessor = baseSha;
  let blocked = null;

  for (const candidate of candidates) {
    if (await isAncestor(repoRoot, candidate.headSha, predecessor)) {
      blocked = {
        pullRequest: candidate.pullRequest,
        reason: "candidate is already contained by an earlier train prefix; rerun after that prefix publishes",
      };
      break;
    }

    const merge = await gitResult(checkout, ["merge", "--no-commit", "--no-ff", candidate.headSha]);
    if (merge.code !== 0) {
      const conflicts = await git(checkout, ["diff", "--name-only", "--diff-filter=U"]);
      await gitResult(checkout, ["merge", "--abort"]);
      if (!conflicts) throw new CommandError(`git merge --no-commit --no-ff ${candidate.headSha}`, merge);
      blocked = {
        pullRequest: candidate.pullRequest,
        reason: "merge conflict",
        files: conflicts.split("\n").filter(Boolean),
      };
      break;
    }

    await git(checkout, ["rm", "-r", "-f", "--ignore-unmatch", "--quiet", ".chain"]);
    await git(checkout, ["-c", "commit.gpgsign=false", "commit", "-m", `Merge PR #${candidate.pullRequest} into main`]);
    const oid = await git(checkout, ["rev-parse", "HEAD^{commit}"]);
    assertSha(oid, `prefix for PR #${candidate.pullRequest}`);
    const parents = (await git(checkout, ["show", "-s", "--format=%P", oid])).split(" ");
    if (parents.length !== 2 || parents[0] !== predecessor || parents[1] !== candidate.headSha) {
      throw new Error(`prefix ${oid} does not have exact parents ${predecessor} and ${candidate.headSha}`);
    }
    const internalPaths = await git(checkout, ["ls-tree", "-r", "--name-only", oid, "--", ".chain"]);
    if (internalPaths) throw new Error(`prefix ${oid} still contains internal .chain paths`);
    prefixes.push({
      index: prefixes.length + 1,
      oid,
      predecessor,
      candidate,
    });
    predecessor = oid;
  }

  return { prefixes, blocked };
};

const contiguousPassingCount = (gateResults) => {
  let count = 0;
  for (const result of gateResults) {
    if (result.status !== "pass") break;
    count += 1;
  }
  return count;
};

const verifyPublishedCandidates = async (repoRoot, prefixes, adapters) => {
  const warnings = [];
  const main = await adapters.readMain(repoRoot);
  for (const prefix of prefixes) {
    if (!(await isAncestor(repoRoot, prefix.candidate.headSha, main))) {
      throw new Error(`published main ${main} does not contain PR #${prefix.candidate.pullRequest} head`);
    }
    let state = null;
    let readError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        state = await adapters.readPullRequest(repoRoot, prefix.candidate.pullRequest);
        readError = null;
      } catch (error) {
        readError = error;
      }
      if (state?.state === "MERGED" && state.headSha === prefix.candidate.headSha) break;
      if (attempt < 4) await adapters.sleep(2_000);
    }
    if (readError) {
      warnings.push(`PR #${prefix.candidate.pullRequest} state could not be read: ${readError.message}`);
    } else if (state?.state !== "MERGED" || state.headSha !== prefix.candidate.headSha) {
      warnings.push(`PR #${prefix.candidate.pullRequest} is in main but GitHub still reports ${state?.state ?? "unknown"}`);
    }
  }
  return warnings;
};

const validateLeaseWaitMinutes = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("--lease-wait-minutes must be a non-negative safe integer");
  }
};

const publishMergeTrain = async ({
  repoRoot, task, candidates, leaseWaitMinutes = DEFAULT_LEASE_WAIT_MINUTES, adapters: overrides = {}, hold,
}) => {
  validateLeaseWaitMinutes(leaseWaitMinutes);
  validateCandidates(candidates);
  if (!task) throw new Error("--task is required");
  const adapters = { ...realAdapters, ...overrides };
  const baseSha = await adapters.readMain(repoRoot);
  const alreadyDelivered = [];
  const pending = [];

  for (const candidate of candidates) {
    const state = await adapters.readPullRequest(repoRoot, candidate.pullRequest);
    if (state.headSha !== candidate.headSha) {
      throw new Error(
        `PR #${candidate.pullRequest} head changed from ${candidate.headSha} to ${state.headSha}`,
      );
    }
    await adapters.fetchCandidate(repoRoot, candidate);
    if (await isAncestor(repoRoot, candidate.headSha, baseSha)) {
      alreadyDelivered.push(candidate);
    } else {
      if (state.state !== "OPEN") {
        throw new Error(`PR #${candidate.pullRequest} is not an exact open candidate: PR state is ${state.state}`);
      }
      pending.push(candidate);
    }
  }
  if (pending.length === 0) {
    return { status: "all-already-delivered", baseSha, alreadyDelivered, prefixes: [], gateResults: [], published: [] };
  }
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "agentos-merge-train-"));
  const buildCheckout = path.join(temporaryRoot, "build");
  const gateCheckouts = [];
  let buildWorktreeAdded = false;
  let leaseHeld = false;
  let safeToRelease = false;
  // The chain tail records every confirmed release as a hold duration
  // (packages/api/src/merge-lease-hold.ts). The train held the same lease and
  // recorded nothing, so the two kinds of hold could not be compared. Both now
  // measure the release the same way, from the acquiredAt in the lease blob the
  // release confirmed.
  let leaseHeldForSeconds = null;
  let primaryError = null;
  try {
    buildWorktreeAdded = true;
    const built = await buildPrefixes(repoRoot, buildCheckout, baseSha, pending);
    for (const prefix of built.prefixes) {
      const gateCheckout = path.join(temporaryRoot, `prefix-${prefix.index}`);
      await git(repoRoot, ["worktree", "add", "--detach", gateCheckout, prefix.oid]);
      gateCheckouts.push(gateCheckout);
    }
    const gateResults = await Promise.all(
      built.prefixes.map(async (prefix, index) => ({
        prefix,
        ...(await adapters.gate(repoRoot, prefix, gateCheckouts[index])),
      })),
    );
    const passingCount = contiguousPassingCount(gateResults);
    if (passingCount === 0) {
      return {
        status: "nothing-publishable",
        baseSha,
        alreadyDelivered,
        prefixes: built.prefixes,
        blocked: built.blocked,
        gateResults,
        published: [],
      };
    }

    const leaseWaitStarted = performance.now();
    const acquisition = await adapters.acquireLease(repoRoot, task, passingCount, { leaseWaitMinutes });
    const leaseWaitedMs = Math.round(performance.now() - leaseWaitStarted);
    if (acquisition.outcome === "contended") {
      return {
        status: "lease-contended",
        leaseWaitedMs,
        baseSha,
        alreadyDelivered,
        prefixes: built.prefixes,
        blocked: built.blocked,
        gateResults,
        published: [],
      };
    }
    if (acquisition.outcome === "unreachable") {
      throw new Error(`merge Lease acquisition was unreachable: ${acquisition.detail}`);
    }
    leaseHeld = true;
    safeToRelease = true;
    let liveMain = await adapters.readMain(repoRoot);
    if (liveMain !== baseSha) {
      return {
        status: "stale-base",
        baseSha,
        liveMain,
        alreadyDelivered,
        prefixes: built.prefixes,
        blocked: built.blocked,
        gateResults,
        published: [],
      };
    }

    let candidateDrift = null;
    const published = [];
    for (const prefix of built.prefixes.slice(0, passingCount)) {
      const validation = await validateOpenCandidate(repoRoot, prefix.candidate, adapters);
      if (!validation.valid) {
        candidateDrift = {
          pullRequest: prefix.candidate.pullRequest,
          reason: validation.reason,
        };
        break;
      }
      safeToRelease = false;
      const pushed = await adapters.push(repoRoot, prefix);
      safeToRelease = true;
      if (!pushed.published) {
        throw new CommandError(`git push origin ${prefix.oid}:refs/heads/main`, pushed.result);
      }
      liveMain = pushed.observed;
      published.push(prefix);
    }

    const warnings = await verifyPublishedCandidates(repoRoot, published, adapters);
    const allPendingPublished = published.length === pending.length;
    return {
      status: allPendingPublished ? "published-all" : published.length > 0 ? "published-prefix" : "candidate-drift",
      baseSha,
      liveMain,
      alreadyDelivered,
      prefixes: built.prefixes,
      blocked: built.blocked,
      candidateDrift,
      gateResults,
      published,
      warnings,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    if (leaseHeld) {
      if (safeToRelease) {
        try {
          const release = await adapters.releaseLease(repoRoot, task);
          if (isMergeLeaseReleaseAnomaly(release)) {
            const detail = release.detail ?? release.heldFor ?? release.heldBy ?? "no detail";
            cleanupError = new Error(`merge Lease release ${release.outcome}: ${detail}`);
          } else if (release.outcome === "released") {
            leaseHeldForSeconds = mergeLeaseHoldSeconds(release.acquiredAt, adapters.now());
            // The lease is already back either way, so a hold that cannot be
            // measured is a missing measurement rather than a failed release:
            // it is said out loud and the publication result stands.
            if (leaseHeldForSeconds === null) {
              process.stderr.write(
                `merge-train: released the merge lease but could not measure the hold from acquiredAt ${String(release.acquiredAt)}\n`,
              );
            } else {
              process.stderr.write(`merge-train: held the merge lease for ${leaseHeldForSeconds}s\n`);
            }
          }
        } catch (error) {
          cleanupError = error;
        }
      }
      else process.stderr.write(`merge-train: publication read-back is unknown; lease for task ${task} was retained\n`);
    }
    for (const gateCheckout of gateCheckouts) {
      const removed = await gitResult(repoRoot, ["worktree", "remove", "--force", gateCheckout]);
      if (removed.code !== 0 && !cleanupError) {
        cleanupError = new CommandError(`git worktree remove --force ${gateCheckout}`, removed);
      }
    }
    if (buildWorktreeAdded) {
      const removed = await gitResult(repoRoot, ["worktree", "remove", "--force", buildCheckout]);
      if (removed.code !== 0 && !cleanupError) {
        cleanupError = new CommandError(`git worktree remove --force ${buildCheckout}`, removed);
      }
    }
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      if (!cleanupError) cleanupError = error;
    }
    if (cleanupError) {
      if (!primaryError) throw cleanupError;
      process.stderr.write(`merge-train: cleanup also failed: ${cleanupError.message}\n`);
    }
    hold.seconds = leaseHeldForSeconds;
  }
};

/**
 * The hold duration is only known once the release in the `finally` above has
 * confirmed it, which is after the result object each publication path returns
 * was built. Carrying it out through a box and attaching it here keeps those
 * paths untouched: a run that never held the lease has no hold to report.
 */
export const coordinateMergeTrain = async (options) => {
  const hold = { seconds: null };
  const result = await publishMergeTrain({ ...options, hold });
  return hold.seconds === null ? result : { ...result, leaseHeldForSeconds: hold.seconds };
};

const usage = () => {
  process.stdout.write(`Usage:
  scripts/merge-train.mjs --task <id> --candidate <pr>:<40-character-head> [--candidate ...] [--lease-wait-minutes <n>]

Coordinates one fixed FIFO batch of at most three open GitHub pull requests.
The command builds cumulative merge commits, gates them concurrently, then
publishes only the longest contiguous passing prefix under the merge lease.

  --lease-wait-minutes <n>  Wait up to n whole minutes for the publication lease
                            (default: 10; 0 tries immediately).
On lease-contended, JSON includes leaseWaitedMs (elapsed acquisition milliseconds).
When the lease was held and released, JSON includes leaseHeldForSeconds.
`);
};

const parseArguments = (argv) => {
  const candidates = [];
  let task = "";
  let leaseWaitMinutes = DEFAULT_LEASE_WAIT_MINUTES;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--task") {
      task = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--lease-wait-minutes") {
      const value = argv[index + 1] ?? "";
      leaseWaitMinutes = /^\d+$/u.test(value) ? Number(value) : NaN;
      validateLeaseWaitMinutes(leaseWaitMinutes);
      index += 1;
      continue;
    }
    if (argument === "--candidate") {
      const value = argv[index + 1] ?? "";
      index += 1;
      const separator = value.indexOf(":");
      const pullRequest = Number(value.slice(0, separator));
      const headSha = separator === -1 ? "" : value.slice(separator + 1);
      candidates.push({ pullRequest, headSha });
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { help: false, task, candidates, leaseWaitMinutes };
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const repoRoot = await checkedProcess("git", ["rev-parse", "--show-toplevel"]);
  const result = await coordinateMergeTrain({
    repoRoot, task: options.task, candidates: options.candidates, leaseWaitMinutes: options.leaseWaitMinutes,
  });
  for (const gateResult of result.gateResults) {
    process.stdout.write(`\nmerge-train: gate P${gateResult.prefix.index} for PR #${gateResult.prefix.candidate.pullRequest}\n`);
    process.stdout.write(gateResult.output.endsWith("\n") ? gateResult.output : `${gateResult.output}\n`);
  }
  const summary = {
    status: result.status,
    ...(result.status === "lease-contended" ? { leaseWaitedMs: result.leaseWaitedMs } : {}),
    ...(result.leaseHeldForSeconds === undefined ? {} : { leaseHeldForSeconds: result.leaseHeldForSeconds }),
    baseSha: result.baseSha,
    liveMain: result.liveMain ?? result.baseSha,
    alreadyDelivered: result.alreadyDelivered.map((candidate) => candidate.pullRequest),
    built: result.prefixes.map((prefix) => ({ pullRequest: prefix.candidate.pullRequest, oid: prefix.oid })),
    gates: result.gateResults.map((gateResult) => ({
      pullRequest: gateResult.prefix.candidate.pullRequest,
      status: gateResult.status,
      code: gateResult.code,
    })),
    published: result.published.map((prefix) => ({ pullRequest: prefix.candidate.pullRequest, oid: prefix.oid })),
    blocked: result.blocked ?? result.candidateDrift ?? null,
    warnings: result.warnings ?? [],
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!["published-all", "all-already-delivered"].includes(result.status)) process.exitCode = 1;
};

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`merge-train: ${error.message}\n`);
    process.exitCode = 1;
  });
}
